import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import { getOutputChannel, getWorkspaceRoot, runCodeBrain } from '../process/cli-runner.js';
import { getTokenOptimizationSettings } from '../process/token-optimizer.js';
import {
  showQueryReport,
  type QueryReportMetadata,
  type QueryResultItem,
  type QueryResultNode,
  type QueryWorkflowData,
} from '../ui/report-panel.js';

const MAX_CHANGED_FILES = 200;
const MAX_REVIEW_SNIPPET_CHARS = 7000;
const MAX_SELECTION_CHARS = 6000;
const MAX_REVIEW_SUMMARY_LINES = 24;
const MAX_WORKFLOW_NODES_PER_SIDE = 60;
const DEFAULT_GRAPH_QUERY_LIMIT = 20;

interface CallersJson {
  symbol?: string;
  callers?: QueryResultNode[];
}

interface CalleesJson {
  symbol?: string;
  callees?: QueryResultNode[];
}

interface ImpactJson {
  symbol?: string;
  depth?: number;
  nodeCount?: number;
  edgeCount?: number;
  affected?: QueryResultNode[];
}

interface QueryDepthItem extends vscode.QuickPickItem {
  depth: number;
}

type QueryPanelRequest =
  | {
      mode: 'search';
      raw: string;
      search: string;
      depth?: number;
      limit?: number;
      warnings: string[];
    }
  | {
      mode: 'callers' | 'callees';
      raw: string;
      symbol: string;
      limit?: number;
      warnings: string[];
    }
  | {
      mode: 'impact';
      raw: string;
      symbol: string;
      depth?: number;
      limit?: number;
      warnings: string[];
    };

export async function queryCommand(): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const selected = editor?.document.getText(editor.selection).trim() ?? '';

  const query = await vscode.window.showInputBox({
    placeHolder: 'e.g. auth token validation flow, callers handleRequest',
    prompt: 'CodeBrain: Search CodeGraph',
    value: selected,
  });
  if (!query) {
    return;
  }

  const request = parseQueryPanelInput(query);
  if (!isRunnableQueryRequest(request)) {
    vscode.window.showWarningMessage('CodeBrain: Enter a search query or a command like "callers handleRequest".');
    return;
  }

  if (request.mode === 'search') {
    const depth = request.depth ?? await pickQueryDepth();
    if (depth === undefined) {
      return;
    }
    await runSearchQuery(request, depth);
    return;
  }

  const depth = request.mode === 'impact' ? request.depth ?? await pickQueryDepth() : 1;
  if (depth === undefined) {
    return;
  }

  await runDirectGraphQuery(request, depth);
}

async function runSearchQuery(
  request: Extract<QueryPanelRequest, { mode: 'search' }>,
  depth: number,
): Promise<void> {
  const channel = getOutputChannel();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `CodeBrain: Querying CodeGraph (depth ${depth})...`,
      cancellable: true,
    },
    async (_progress, token) => {
      const workspaceRoot = getWorkspaceRoot();
      const tokenSettings = getTokenOptimizationSettings('balanced');
      const [statusResult, result] = await Promise.all([
        runCodeBrain(['status', workspaceRoot, '--json'], {
          cwd: workspaceRoot,
          stream: false,
          token,
        }),
        runCodeBrain(
          ['query', request.search, '--path', workspaceRoot, '--limit', String(request.limit ?? DEFAULT_GRAPH_QUERY_LIMIT), '--json'],
          { cwd: workspaceRoot, stream: false, token },
        ),
      ]);
      const filesScanned = parseStatusFileCount(statusResult.stdout);

      channel.appendLine(result.stdout.trim());
      if (result.stderr.trim()) {
        channel.appendLine(result.stderr.trim());
      }

      if (token.isCancellationRequested) {
        vscode.window.showWarningMessage('CodeBrain: Query cancelled.');
        return;
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
        const metadata: QueryReportMetadata = {
          allResultCount: parsed.length,
          filesScanned,
          workflow: await buildQueryWorkflowData(parsed, depth, workspaceRoot, token, request.warnings),
        };

        if (token.isCancellationRequested) {
          vscode.window.showWarningMessage('CodeBrain: Query cancelled.');
          return;
        }

        showQueryReport(request.raw, optimized, result.stdout, metadata);
        const workflowNote = metadata.workflow ? ` Workflow: ${metadata.workflow.symbol}, depth ${metadata.workflow.depth}.` : '';
        vscode.window.showInformationMessage(`CodeBrain: Showing ${optimized.length} of ${parsed.length} result${parsed.length === 1 ? '' : 's'} (${tokenSettings.configuredMode} token mode).${workflowNote}`);
      } catch {
        showQueryReport(request.raw, [], result.stdout || result.stderr);
        vscode.window.showWarningMessage('CodeBrain: Query returned non-JSON output. Showing raw output.');
      }
    },
  );
}

async function runDirectGraphQuery(
  request: Exclude<QueryPanelRequest, { mode: 'search' }>,
  depth: number,
): Promise<void> {
  const channel = getOutputChannel();
  const title = formatGraphRequestTitle(request, depth);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `CodeBrain: Running ${title}...`,
      cancellable: true,
    },
    async (_progress, token) => {
      const workspaceRoot = getWorkspaceRoot();
      const tokenSettings = getTokenOptimizationSettings('balanced');
      const [statusResult, result, targetResult] = await Promise.all([
        runCodeBrain(['status', workspaceRoot, '--json'], {
          cwd: workspaceRoot,
          stream: false,
          token,
        }),
        runCodeBrain(buildDirectGraphArgs(request, workspaceRoot, depth), {
          cwd: workspaceRoot,
          stream: false,
          token,
        }),
        runCodeBrain(['query', request.symbol, '--path', workspaceRoot, '--limit', '5', '--json'], {
          cwd: workspaceRoot,
          stream: false,
          token,
        }),
      ]);
      const filesScanned = parseStatusFileCount(statusResult.stdout);

      channel.appendLine(result.stdout.trim());
      if (result.stderr.trim()) {
        channel.appendLine(result.stderr.trim());
      }

      if (token.isCancellationRequested) {
        vscode.window.showWarningMessage('CodeBrain: Query cancelled.');
        return;
      }

      if (result.exitCode !== 0) {
        vscode.window.showErrorMessage('CodeBrain: Query failed. Check Output panel.');
        return;
      }

      const warnings = [...request.warnings];
      try {
        const metadata = buildDirectGraphMetadata(request, depth, result, targetResult, warnings);
        const resultNodes = directResultNodes(metadata.workflow);
        const optimized = tokenSettings.enabled
          ? resultNodes.slice(0, tokenSettings.queryResultLimit)
          : resultNodes;

        showQueryReport(request.raw, optimized, result.stdout, {
          allResultCount: resultNodes.length,
          filesScanned,
          workflow: metadata.workflow,
        });

        vscode.window.showInformationMessage(
          `CodeBrain: ${title} returned ${resultNodes.length} result${resultNodes.length === 1 ? '' : 's'} (${tokenSettings.configuredMode} token mode).`,
        );
      } catch {
        showQueryReport(request.raw, [], result.stdout || result.stderr);
        vscode.window.showWarningMessage('CodeBrain: Query returned non-JSON output. Showing raw output.');
      }
    },
  );
}

function buildDirectGraphArgs(
  request: Exclude<QueryPanelRequest, { mode: 'search' }>,
  workspaceRoot: string,
  depth: number,
): string[] {
  const limit = String(request.limit ?? DEFAULT_GRAPH_QUERY_LIMIT);
  switch (request.mode) {
    case 'callers':
      return ['callers', request.symbol, '--path', workspaceRoot, '--limit', limit, '--json'];
    case 'callees':
      return ['callees', request.symbol, '--path', workspaceRoot, '--limit', limit, '--json'];
    case 'impact':
      return ['impact', request.symbol, '--path', workspaceRoot, '--depth', String(depth), '--json'];
    default:
      return [];
  }
}

function buildDirectGraphMetadata(
  request: Exclude<QueryPanelRequest, { mode: 'search' }>,
  depth: number,
  result: { stdout: string; stderr: string; exitCode: number },
  targetResult: { stdout: string; stderr: string; exitCode: number },
  warnings: string[],
): { workflow: QueryWorkflowData } {
  const targetItems = parseGraphJson<QueryResultItem[]>(targetResult, 'Target lookup', warnings);
  const target = pickWorkflowTarget(targetItems ?? [])?.node ?? {
    name: request.symbol,
    qualifiedName: request.symbol,
  };

  switch (request.mode) {
    case 'callers': {
      const parsed = JSON.parse(result.stdout) as CallersJson;
      return {
        workflow: {
          symbol: request.symbol,
          depth: 1,
          target,
          callers: uniqueNodes(parsed.callers ?? []),
          callees: [],
          affected: [],
          warnings,
        },
      };
    }
    case 'callees': {
      const parsed = JSON.parse(result.stdout) as CalleesJson;
      return {
        workflow: {
          symbol: request.symbol,
          depth: 1,
          target,
          callers: [],
          callees: uniqueNodes(parsed.callees ?? []),
          affected: [],
          warnings,
        },
      };
    }
    case 'impact': {
      const parsed = JSON.parse(result.stdout) as ImpactJson;
      return {
        workflow: {
          symbol: request.symbol,
          depth,
          target,
          callers: [],
          callees: [],
          affected: uniqueNodes(parsed.affected ?? []),
          edgeCount: parsed.edgeCount,
          warnings,
        },
      };
    }
    default:
      throw new Error('Unsupported graph request.');
  }
}

function directResultNodes(workflow: QueryWorkflowData): QueryResultItem[] {
  const nodes = [
    ...workflow.callers,
    ...workflow.callees,
    ...workflow.affected,
  ];
  return uniqueNodes(nodes).map((node) => ({ node }));
}

function parseQueryPanelInput(input: string): QueryPanelRequest {
  const raw = input.trim();
  const tokens = tokenizePanelInput(raw);
  const warnings: string[] = [];
  const firstToken = tokens[0]?.toLowerCase();
  const commandIndex = firstToken === 'codegraph' ? 1 : 0;
  const command = tokens[commandIndex]?.toLowerCase();

  if (command !== 'query' && command !== 'callers' && command !== 'callees' && command !== 'impact') {
    return {
      mode: 'search',
      raw,
      search: raw,
      warnings,
    };
  }

  const parsedArgs = parsePanelCommandArgs(tokens.slice(commandIndex + 1), warnings);
  const phrase = unwrapSymbolPlaceholder(parsedArgs.positionals.join(' ').trim());
  if (command === 'query') {
    return {
      mode: 'search',
      raw,
      search: phrase,
      depth: parsedArgs.depth,
      limit: parsedArgs.limit,
      warnings,
    };
  }

  if (command === 'impact') {
    return {
      mode: 'impact',
      raw,
      symbol: phrase,
      depth: parsedArgs.depth,
      limit: parsedArgs.limit,
      warnings,
    };
  }

  return {
    mode: command,
    raw,
    symbol: phrase,
    limit: parsedArgs.limit,
    warnings,
  };
}

function tokenizePanelInput(input: string): string[] {
  return input.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|[^\s]+/gu)?.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  }) ?? [];
}

function parsePanelCommandArgs(
  tokens: string[],
  warnings: string[],
): {
  positionals: string[];
  depth?: number;
  limit?: number;
} {
  const positionals: string[] = [];
  let depth: number | undefined;
  let limit: number | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    const lower = token.toLowerCase();

    if (lower === '--json' || lower === '-j') {
      continue;
    }

    if (lower === '--path' || lower === '-p') {
      index += 1;
      continue;
    }

    if (lower === '--depth' || lower === '-d') {
      const parsed = parsePositiveInteger(tokens[index + 1]);
      if (parsed !== undefined) {
        depth = parsed;
        index += 1;
      } else {
        warnings.push('Ignored invalid --depth value.');
      }
      continue;
    }

    if (lower === '--limit' || lower === '-l') {
      const parsed = parsePositiveInteger(tokens[index + 1]);
      if (parsed !== undefined) {
        limit = parsed;
        index += 1;
      } else {
        warnings.push('Ignored invalid --limit value.');
      }
      continue;
    }

    if (lower === '--deep') {
      warnings.push('Ignored unsupported --deep flag; CodeGraph uses "callers <symbol>" for direct callers and "impact <symbol> --depth <n>" for traversal.');
      continue;
    }

    if (token.startsWith('-')) {
      warnings.push(`Ignored unsupported option ${token}.`);
      continue;
    }

    positionals.push(token);
  }

  return { positionals, depth, limit };
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function unwrapSymbolPlaceholder(value: string): string {
  if (value.startsWith('<') && value.endsWith('>') && value.length > 2) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function isRunnableQueryRequest(request: QueryPanelRequest): boolean {
  if (request.mode === 'search') {
    return request.search.length > 0;
  }

  return request.symbol.length > 0;
}

function formatGraphRequestTitle(
  request: Exclude<QueryPanelRequest, { mode: 'search' }>,
  depth: number,
): string {
  switch (request.mode) {
    case 'callers':
      return `callers for ${request.symbol}`;
    case 'callees':
      return `callees for ${request.symbol}`;
    case 'impact':
      return `impact for ${request.symbol} (depth ${depth})`;
    default:
      return 'CodeGraph query';
  }
}

async function pickQueryDepth(): Promise<number | undefined> {
  const items: QueryDepthItem[] = [
    {
      label: 'Depth 2',
      description: 'Recommended',
      detail: 'Direct callers/callees plus a broader impact neighborhood.',
      depth: 2,
      picked: true,
    },
    {
      label: 'Depth 1',
      description: 'Fast',
      detail: 'Direct callers, direct callees, and immediate impact.',
      depth: 1,
    },
    {
      label: 'Depth 3',
      description: 'Broader',
      detail: 'Useful when the function sits in a multi-step workflow.',
      depth: 3,
    },
    {
      label: 'Depth 4',
      description: 'Deep',
      detail: 'More transitive symbols; can take longer on large repositories.',
      depth: 4,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'CodeBrain Query Depth',
    placeHolder: 'Choose how far CodeGraph should traverse from the queried function',
  });

  return picked?.depth;
}

async function buildQueryWorkflowData(
  results: QueryResultItem[],
  depth: number,
  workspaceRoot: string,
  token: vscode.CancellationToken,
  inputWarnings: string[] = [],
): Promise<QueryWorkflowData | undefined> {
  const target = pickWorkflowTarget(results)?.node;
  const symbol = workflowSymbol(target);
  if (!symbol) {
    return undefined;
  }

  const limit = String(Math.min(MAX_WORKFLOW_NODES_PER_SIDE, Math.max(12, depth * 16)));
  const warnings: string[] = [...inputWarnings];
  const [callersResult, calleesResult, impactResult] = await Promise.all([
    runCodeBrain(['callers', symbol, '--path', workspaceRoot, '--limit', limit, '--json'], {
      cwd: workspaceRoot,
      stream: false,
      token,
    }),
    runCodeBrain(['callees', symbol, '--path', workspaceRoot, '--limit', limit, '--json'], {
      cwd: workspaceRoot,
      stream: false,
      token,
    }),
    runCodeBrain(['impact', symbol, '--path', workspaceRoot, '--depth', String(depth), '--json'], {
      cwd: workspaceRoot,
      stream: false,
      token,
    }),
  ]);

  const callers = parseGraphJson<CallersJson>(callersResult, 'Callers', warnings);
  const callees = parseGraphJson<CalleesJson>(calleesResult, 'Callees', warnings);
  const impact = parseGraphJson<ImpactJson>(impactResult, 'Impact', warnings);

  return {
    symbol,
    depth,
    target,
    callers: uniqueNodes(callers?.callers ?? []),
    callees: uniqueNodes(callees?.callees ?? []),
    affected: uniqueNodes(impact?.affected ?? []),
    edgeCount: impact?.edgeCount,
    warnings,
  };
}

function workflowSymbol(node: QueryResultNode | undefined): string | undefined {
  return node?.qualifiedName?.trim() || node?.name?.trim();
}

function pickWorkflowTarget(results: QueryResultItem[]): QueryResultItem | undefined {
  const withName = results.filter((result) => result.node?.name);
  return (
    withName.find((result) => result.node?.kind === 'class' || result.node?.kind === 'component' || result.node?.kind === 'route') ??
    withName.find((result) => result.node?.kind === 'function' || result.node?.kind === 'method') ??
    withName[0]
  );
}

function parseGraphJson<T>(
  result: { stdout: string; stderr: string; exitCode: number },
  label: string,
  warnings: string[],
): T | undefined {
  if (result.exitCode !== 0) {
    warnings.push(`${label}: ${summarizeCliOutput(result.stderr || result.stdout) || 'command failed'}.`);
    return undefined;
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    const summary = summarizeCliOutput(result.stdout || result.stderr);
    if (summary) {
      warnings.push(`${label}: ${summary}.`);
    }
    return undefined;
  }
}

function uniqueNodes(nodes: QueryResultNode[]): QueryResultNode[] {
  const seen = new Set<string>();
  const uniqueNodes: QueryResultNode[] = [];

  for (const node of nodes) {
    const key = `${node.name ?? ''}|${node.kind ?? ''}|${node.filePath ?? ''}|${node.startLine ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueNodes.push(node);
  }

  return uniqueNodes;
}

function summarizeCliOutput(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*m/gu, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
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
