import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import { getOutputChannel, getWorkspaceRoot, runCodeBrain } from '../process/cli-runner.js';
import { getTokenOptimizationSettings } from '../process/token-optimizer.js';
import { showQueryReport, type QueryResultItem } from '../ui/report-panel.js';

const MAX_CHANGED_FILES = 200;
const MAX_REVIEW_SNIPPET_CHARS = 7000;
const MAX_SELECTION_CHARS = 6000;
const MAX_REVIEW_SUMMARY_LINES = 24;

export async function queryCommand(): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const selected = editor?.document.getText(editor.selection).trim() ?? '';

  const query = await vscode.window.showInputBox({
    placeHolder: 'e.g. auth token validation flow',
    prompt: 'CodeBrain: Search CodeGraph',
    value: selected,
  });
  if (!query) {
    return;
  }

  const channel = getOutputChannel();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CodeBrain: Querying CodeGraph...',
      cancellable: false,
    },
    async () => {
      const workspaceRoot = getWorkspaceRoot();
      const tokenSettings = getTokenOptimizationSettings('balanced');
      const statusResult = await runCodeBrain(['status', workspaceRoot, '--json'], {
        cwd: workspaceRoot,
        stream: false,
      });
      const result = await runCodeBrain(
        ['query', query, '--path', workspaceRoot, '--limit', '20', '--json'],
        { cwd: workspaceRoot, stream: false },
      );
      const filesScanned = parseStatusFileCount(statusResult.stdout);

      channel.appendLine(result.stdout.trim());
      if (result.stderr.trim()) {
        channel.appendLine(result.stderr.trim());
      }

      if (result.exitCode !== 0) {
        vscode.window.showErrorMessage('CodeBrain: Query failed. Check Output panel.');
        return;
      }

      try {
        const parsed = JSON.parse(result.stdout) as QueryResultItem[];
        const optimized = tokenSettings.enabled
          ? parsed.slice(0, tokenSettings.queryResultLimit)
          : parsed;
        showQueryReport(query, optimized, result.stdout, {
          allResultCount: parsed.length,
          filesScanned,
        });
        vscode.window.showInformationMessage(`CodeBrain: Showing ${optimized.length} of ${parsed.length} result${parsed.length === 1 ? '' : 's'} (${tokenSettings.configuredMode} token mode).`);
      } catch {
        showQueryReport(query, [], result.stdout || result.stderr);
        vscode.window.showWarningMessage('CodeBrain: Query returned non-JSON output. Showing raw output.');
      }
    },
  );
}

function parseStatusFileCount(stdout: string): number | undefined {
  try {
    const parsed = JSON.parse(stdout) as { fileCount?: number };
    return parsed.fileCount;
  } catch {
    return undefined;
  }
}

export async function prReviewCommand(): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const workspaceRoot = getWorkspaceRoot();
  const reviewMode = await pickPrReviewMode(workspaceRoot);
  if (!reviewMode) {
    return;
  }

  const changedFiles = getChangedFilesForReview(workspaceRoot, reviewMode);
  if (changedFiles.length === 0) {
    vscode.window.showWarningMessage('CodeBrain: No changed files found for the selected review scope.');
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CodeBrain: Preparing code review context...',
      cancellable: true,
    },
    async (_progress, token) => {
      const statusResult = await runCodeBrain(['status', workspaceRoot, '--json'], {
        cwd: workspaceRoot,
        stream: false,
        token,
      });

      const affectedResult = await runCodeBrain(
        ['affected', ...changedFiles, '--path', workspaceRoot, '--json'],
        { cwd: workspaceRoot, stream: false, token },
      );

      if (token.isCancellationRequested) {
        vscode.window.showWarningMessage('CodeBrain: Code review preparation cancelled.');
        return;
      }

      const prompt = buildReviewPrompt({
        mode: reviewMode,
        changedFiles,
        statusSummary: formatStatusSummary(statusResult.stdout, statusResult.stderr),
        affectedSummary: formatAffectedSummary(affectedResult.stdout, affectedResult.stderr),
        diffPreview: buildReviewSnippet(workspaceRoot, reviewMode),
      });

      const encodedPrompt = encodeURIComponent(prompt);
      const chatUri = vscode.Uri.parse(
        `vscode://xpl.chat-uri/startChat?agent=codebrain.codegraph&prompt=${encodedPrompt}`,
      );
      await vscode.commands.executeCommand('vscode.open', chatUri);
    },
  );
}

type PrReviewScope = 'selection' | 'current-file' | 'staged' | 'all' | 'compare';

interface PrReviewMode {
  scope: PrReviewScope;
  baseRef?: string;
  filePath?: string;
  selectionText?: string;
}

async function pickPrReviewMode(cwd: string): Promise<PrReviewMode | undefined> {
  const defaultBaseRef = getDefaultBaseRef(cwd);
  const activeEditor = getActiveEditorReviewContext(cwd);
  const items: Array<vscode.QuickPickItem & { mode: PrReviewMode }> = [];

  if (activeEditor?.selectionText) {
    items.push({
      label: 'Review selected code',
      description: activeEditor.relativeFilePath,
      detail: 'Review the selected code and ask CodeGraph to inspect callers, callees, and nearby impact.',
      mode: {
        scope: 'selection',
        filePath: activeEditor.relativeFilePath,
        selectionText: activeEditor.selectionText,
      },
    });
  }

  if (activeEditor) {
    items.push({
      label: 'Review current file',
      description: activeEditor.relativeFilePath,
      detail: 'Review this file, using CodeGraph for structural context and affected-test preflight.',
      mode: { scope: 'current-file', filePath: activeEditor.relativeFilePath },
    });
  }

  items.push(
    {
      label: 'Review staged changes',
      description: 'Use git diff --cached',
      mode: { scope: 'staged' },
    },
    {
      label: 'Review working tree',
      description: 'Use staged + unstaged changes',
      mode: { scope: 'all' },
    },
    {
      label: 'Review against base branch',
      description: `Compare current branch against ${defaultBaseRef}`,
      mode: { scope: 'compare', baseRef: defaultBaseRef },
    },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Review Code with CodeBrain',
    placeHolder: 'Choose what CodeBrain should review',
  });
  if (!picked) {
    return undefined;
  }

  if (picked.mode.scope !== 'compare') {
    return picked.mode;
  }

  const baseRef = await vscode.window.showInputBox({
    title: 'Review Code with CodeBrain',
    prompt: 'Base branch or ref for compare review',
    placeHolder: 'main',
    value: picked.mode.baseRef ?? defaultBaseRef,
    validateInput: (value) => (value.trim().length === 0 ? 'Base ref is required.' : undefined),
  });

  if (!baseRef) {
    return undefined;
  }

  return { scope: 'compare', baseRef: baseRef.trim() };
}

function getChangedFilesForReview(cwd: string, mode: PrReviewMode): string[] {
  switch (mode.scope) {
    case 'selection':
    case 'current-file':
      return mode.filePath ? [mode.filePath] : [];
    case 'staged':
      return getGitDiffFiles(cwd, ['diff', '--name-only', '--cached']);
    case 'all':
      return unique([
        ...getGitDiffFiles(cwd, ['diff', '--name-only', 'HEAD']),
        ...getGitDiffFiles(cwd, ['ls-files', '--others', '--exclude-standard']),
      ]);
    case 'compare':
      return getGitDiffFiles(cwd, ['diff', '--name-only', `${mode.baseRef ?? 'main'}...HEAD`]);
    default:
      return [];
  }
}

function getGitDiffFiles(cwd: string, args: string[]): string[] {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, MAX_CHANGED_FILES);
  } catch {
    return [];
  }
}

interface ActiveEditorReviewContext {
  relativeFilePath: string;
  selectionText?: string;
}

interface ReviewPromptContext {
  mode: PrReviewMode;
  changedFiles: string[];
  statusSummary: string;
  affectedSummary: string;
  diffPreview: string;
}

interface StatusJson {
  initialized?: boolean;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  pendingChanges?: {
    added?: number;
    modified?: number;
    removed?: number;
  };
}

interface AffectedJson {
  affectedTests?: string[];
  totalDependentsTraversed?: number;
}

function getActiveEditorReviewContext(cwd: string): ActiveEditorReviewContext | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return undefined;
  }

  const relativeFilePath = toWorkspaceRelativePath(cwd, editor.document.uri.fsPath);
  if (!relativeFilePath) {
    return undefined;
  }

  const selectionText = editor.document.getText(editor.selection).trim();
  return {
    relativeFilePath,
    selectionText: selectionText ? truncateText(selectionText, MAX_SELECTION_CHARS) : undefined,
  };
}

function toWorkspaceRelativePath(cwd: string, filePath: string): string | undefined {
  const relative = path.relative(cwd, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.replace(/\\/g, '/');
}

function buildReviewPrompt(ctx: ReviewPromptContext): string {
  const scopeSummary = formatScopeSummary(ctx.mode);
  const changedSection = ctx.changedFiles.map((file) => `- ${file}`).join('\n');

  return [
    'Run a code review using CodeBrain and CodeGraph MCP tools.',
    '',
    'Review rules:',
    '- Lead with findings ordered by severity. If there are no issues, say so clearly.',
    '- Focus on correctness, behavioral regressions, missing caller updates, missing tests, and stale-index risk.',
    '- Use codegraph_explore/search to understand touched areas and codegraph_impact for non-trivial changed symbols.',
    '- Treat direct callers/dependents outside the reviewed file list as high-signal review targets.',
    '- Keep summaries brief; do not produce a marketing-style overview.',
    '',
    `Review scope: ${scopeSummary}`,
    `Changed/reviewed files (${ctx.changedFiles.length}):`,
    changedSection || '- None',
    '',
    `CodeGraph status preflight:\n${ctx.statusSummary}`,
    '',
    `Affected tests preflight:\n${ctx.affectedSummary}`,
    '',
    ctx.diffPreview,
    '',
    'Expected output:',
    '1. Findings first, each with severity and file/line evidence.',
    '2. Open questions or assumptions.',
    '3. Short test coverage note.',
  ].join('\n');
}

function formatScopeSummary(mode: PrReviewMode): string {
  switch (mode.scope) {
    case 'selection':
      return `selected code in ${mode.filePath ?? 'active editor'}`;
    case 'current-file':
      return `current file ${mode.filePath ?? 'active editor'}`;
    case 'staged':
      return 'staged changes';
    case 'all':
      return 'working tree changes, including untracked files';
    case 'compare':
      return `compare against ${mode.baseRef ?? 'main'}`;
    default:
      return mode.scope;
  }
}

function buildReviewSnippet(cwd: string, mode: PrReviewMode): string {
  if (mode.scope === 'selection') {
    return [
      `Selected code from ${mode.filePath ?? 'active editor'}:`,
      '```',
      escapeCodeFence(mode.selectionText ?? ''),
      '```',
    ].join('\n');
  }

  if (mode.scope === 'current-file') {
    const editor = vscode.window.activeTextEditor;
    const currentText = editor?.document.getText() ?? '';
    const diff = mode.filePath
      ? getGitOutput(cwd, ['diff', '--unified=3', 'HEAD', '--', mode.filePath])
      : '';

    if (diff.trim()) {
      return formatSnippet('Current file diff preview', diff);
    }

    return formatSnippet(
      `Current file snapshot: ${mode.filePath ?? 'active editor'}`,
      currentText || 'No current editor content captured.',
    );
  }

  const stat = getGitDiffStat(cwd, mode);
  const patch = getGitDiffPatch(cwd, mode);
  const parts = [
    stat ? formatSnippet('Diff stat', stat, 2000) : undefined,
    patch ? formatSnippet('Diff preview', patch) : 'Diff preview: no tracked-file patch captured.',
  ].filter(Boolean);

  return parts.join('\n\n');
}

function getGitDiffStat(cwd: string, mode: PrReviewMode): string {
  return getGitOutput(cwd, buildGitDiffArgs(mode, '--stat'));
}

function getGitDiffPatch(cwd: string, mode: PrReviewMode): string {
  return getGitOutput(cwd, buildGitDiffArgs(mode, '--unified=3'));
}

function buildGitDiffArgs(mode: PrReviewMode, formatArg: string): string[] {
  switch (mode.scope) {
    case 'staged':
      return ['diff', '--cached', formatArg];
    case 'compare':
      return ['diff', formatArg, `${mode.baseRef ?? 'main'}...HEAD`];
    case 'all':
    default:
      return ['diff', formatArg, 'HEAD'];
  }
}

function getGitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function formatStatusSummary(stdout: string, stderr: string): string {
  try {
    const parsed = JSON.parse(stdout) as StatusJson;
    if (!parsed.initialized) {
      return '- CodeGraph index is not initialized.';
    }

    const pending =
      (parsed.pendingChanges?.added ?? 0) +
      (parsed.pendingChanges?.modified ?? 0) +
      (parsed.pendingChanges?.removed ?? 0);
    const freshness = pending > 0 ? `stale (${pending} pending changes)` : 'fresh';
    const stats = [
      parsed.fileCount !== undefined ? `${parsed.fileCount} files` : undefined,
      parsed.nodeCount !== undefined ? `${parsed.nodeCount} nodes` : undefined,
      parsed.edgeCount !== undefined ? `${parsed.edgeCount} edges` : undefined,
    ].filter(Boolean).join(', ');

    return `- Index: ${freshness}${stats ? ` (${stats})` : ''}.`;
  } catch {
    return buildToolSummary(stdout, stderr, '- Status preflight returned no readable output.');
  }
}

function formatAffectedSummary(stdout: string, stderr: string): string {
  try {
    const parsed = JSON.parse(stdout) as AffectedJson;
    const tests = parsed.affectedTests ?? [];
    const dependents = parsed.totalDependentsTraversed ?? 0;
    if (tests.length === 0) {
      return `- No affected tests detected. ${dependents} dependents traversed.`;
    }

    const listed = tests
      .slice(0, MAX_REVIEW_SUMMARY_LINES)
      .map((file) => `- ${file}`)
      .join('\n');
    const extra = tests.length > MAX_REVIEW_SUMMARY_LINES
      ? `\n- ...and ${tests.length - MAX_REVIEW_SUMMARY_LINES} more.`
      : '';

    return `${listed}${extra}\n- ${dependents} dependents traversed.`;
  } catch {
    return buildToolSummary(stdout, stderr, '- Affected-test preflight returned no readable output.');
  }
}

function formatSnippet(title: string, text: string, limit = MAX_REVIEW_SNIPPET_CHARS): string {
  return [
    `${title}${text.length > limit ? ` (truncated to ${limit} chars)` : ''}:`,
    '```',
    escapeCodeFence(truncateText(text, limit)),
    '```',
  ].join('\n');
}

function truncateText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

function escapeCodeFence(text: string): string {
  return text.replace(/```/g, '`` `');
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).slice(0, MAX_CHANGED_FILES);
}

function getDefaultBaseRef(cwd: string): string {
  for (const candidate of ['main', 'master']) {
    if (gitRefExists(cwd, candidate)) {
      return candidate;
    }
  }
  return 'main';
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function buildToolSummary(stdout: string, stderr: string, emptyMessage: string): string {
  const text = `${stdout}\n${stderr}`.trim();
  if (text.length === 0) {
    return emptyMessage;
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 20)
    .map((line) => `- ${line}`)
    .join('\n');
}
