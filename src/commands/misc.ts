import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import { runCodeBrain, getOutputChannel, getWorkspaceRoot, buildCodeBrainTerminalCommand } from '../process/cli-runner.js';
import { getActiveRepoPath } from '../process/group-context.js';

export async function queryCommand(context?: vscode.ExtensionContext): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  // Pre-fill with selected text if available
  const editor = vscode.window.activeTextEditor;
  const selected = editor?.document.getText(editor.selection).trim() ?? '';

  const query = await vscode.window.showInputBox({
    placeHolder: 'e.g. auth token validation flow',
    prompt: 'CodeBrain: Search the knowledge graph',
    value: selected,
  });
  if (!query) {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);

  const cwd = context ? (await getActiveRepoPath(context.globalState)) ?? getWorkspaceRoot() : getWorkspaceRoot();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CodeBrain: Querying...', cancellable: false },
    async () => {
      await runCodeBrain(['query', query, '--limit', '5'], { cwd });
    },
  );
}

export async function jiraPlanAndQueryCommand(context?: vscode.ExtensionContext): Promise<void> {
  const issueKey = await vscode.window.showInputBox({
    title: 'CodeBrain Jira Plan',
    prompt: 'Enter Jira issue key to build a plan from Atlassian MCP + GitNexus MCP',
    placeHolder: 'PROJ-123',
    validateInput: (value) => {
      const normalized = value.trim().toUpperCase();
      return /^[A-Z][A-Z0-9_]+-\d+$/.test(normalized)
        ? undefined
        : 'Issue key must look like PROJ-123.';
    },
  });
  if (!issueKey) {
    return;
  }

  const collaborationGoal = await vscode.window.showInputBox({
    title: 'CodeBrain Jira Plan',
    prompt: 'Optional: add collaboration context (incident, release scope, squad goal)',
    placeHolder: 'Checkout timeout spikes during deploy window',
    value: '',
  });

  const workspaceRoot = context
    ? (await getActiveRepoPath(context.globalState)) ?? getWorkspaceRoot()
    : getWorkspaceRoot();

  const planPrompt = [
    'Slash command mode: /plan.',
    `Jira issue key: ${issueKey.trim().toUpperCase()}.`,
    collaborationGoal?.trim()
      ? `Collaboration context: ${collaborationGoal.trim()}.`
      : 'Collaboration context: none provided.',
    `Workspace scope: ${workspaceRoot}.`,
    '',
    'Workflow to execute with MCP tools:',
    '1) Atlassian MCP: read Jira issue details, comments, links, assignee, priority, sprint context.',
    '2) Build Analysis Brief: objective, hypotheses, unknowns, and query keywords.',
    '3) GitNexus MCP: list_repos, query, context, impact, detect_changes (if local changes exist).',
    '4) Output Execution Plan: scope, tasks, test plan, risk matrix, and Go/No-Go decision.',
    '',
    'Respond with sections: Analysis Brief, GitNexus Findings, Execution Plan, Decision, Jira Comment Draft.',
  ].join('\n');

  const encodedPrompt = encodeURIComponent(planPrompt);
  const chatUri = vscode.Uri.parse(`vscode://xpl.chat-uri/startChat?agent=codebrain.gitnexus&prompt=${encodedPrompt}`);
  await vscode.commands.executeCommand('vscode.open', chatUri);
}

export async function wikiCommand(): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);

  const model = await vscode.window.showInputBox({
    placeHolder: 'gpt-4o-mini',
    prompt: 'CodeBrain Wiki: LLM model to use (leave blank for default)',
    value: '',
  });

  const args = ['wiki'];
  if (model) {
    args.push('--model', model);
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CodeBrain: Generating wiki...', cancellable: true },
    async (_progress, token) => {
      const result = await runCodeBrain(args, { cwd: getWorkspaceRoot(), token });
      if (result.exitCode === 0) {
        vscode.window.showInformationMessage('CodeBrain: Wiki generated successfully.');
      } else if (!token.isCancellationRequested) {
        vscode.window.showErrorMessage('CodeBrain: Wiki generation failed. Check Output panel.');
      }
    },
  );
}

let _serveTerminal: vscode.Terminal | undefined;

export async function serveCommand(): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  if (_serveTerminal && !_serveTerminal.exitStatus) {
    const choice = await vscode.window.showWarningMessage(
      'CodeBrain: Bridge server is already running.',
      'Show Terminal',
      'Restart',
    );
    if (choice === 'Show Terminal') {
      _serveTerminal.show();
      return;
    }
    _serveTerminal.dispose();
  }

  _serveTerminal = vscode.window.createTerminal({
    name: 'CodeBrain Bridge',
    cwd: getWorkspaceRoot(),
    shellPath: process.platform === 'win32' ? 'cmd.exe' : undefined,
  });
  _serveTerminal.show();
  _serveTerminal.sendText(buildCodeBrainTerminalCommand(['serve']));

  vscode.window.showInformationMessage(
    'CodeBrain: Bridge server starting on http://127.0.0.1:4747',
    'Open Web UI',
  ).then((c) => {
    if (c === 'Open Web UI') {
      vscode.env.openExternal(vscode.Uri.parse('http://127.0.0.1:4747'));
    }
  });
}

export async function prReviewCommand(context?: vscode.ExtensionContext): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);
  const workspaceRoot = context
    ? (await getActiveRepoPath(context.globalState)) ?? getWorkspaceRoot()
    : getWorkspaceRoot();

  const reviewMode = await pickPrReviewMode(workspaceRoot);
  if (!reviewMode) {
    return;
  }

  const changedFiles = getChangedFilesForReview(workspaceRoot, reviewMode);
  if (changedFiles.length === 0) {
    vscode.window.showWarningMessage('CodeBrain: No changed files found for the selected review scope.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CodeBrain: Preparing PR review context...', cancellable: true },
    async (_progress, token) => {
      if (token.isCancellationRequested) {
        return;
      }

      // Health hint: show current index status in output panel (best-effort only).
      await runCodeBrain(['status'], { cwd: workspaceRoot, stream: true });

      const detectArgs = ['detect-changes', '--scope', reviewMode.scope, '--repo', workspaceRoot];
      if (reviewMode.baseRef) {
        detectArgs.push('--base-ref', reviewMode.baseRef);
      }

      const detectResult = await runCodeBrain(detectArgs, {
        cwd: workspaceRoot,
        stream: true,
        token,
      });

      const changedSection = changedFiles.map((f) => `- ${f}`).join('\n');
      const detectSummary = buildDetectChangesSummary(detectResult.stdout, detectResult.stderr);
      const scopeSummary =
        reviewMode.scope === 'compare'
          ? `compare against ${reviewMode.baseRef ?? 'main'}`
          : reviewMode.scope;

      // Open Copilot chat with the reviewer agent and prefilled context
      const prompt =
        'Run a PR review using CodeBrain MCP tools.\n' +
        'Workflow: 1) inspect changed files, 2) run detect_changes for the selected scope, 3) run impact on modified symbols, 4) run context on key symbols, 5) report findings by severity, 6) add missing tests.\n\n' +
        `Review scope: ${scopeSummary}\n` +
        `Changed files (${changedFiles.length}):\n${changedSection}\n\n` +
        `Detect-changes preflight:\n${detectSummary}\n\n` +
        'Review focus: highlight callers outside the diff, missing tests, and risky process / route impacts.';

      const encodedPrompt = encodeURIComponent(prompt);
      // VS Code Copilot chat URI â€” opens chat with prefilled prompt
      const chatUri = vscode.Uri.parse(`vscode://xpl.chat-uri/startChat?agent=gitnexus-pr-review&prompt=${encodedPrompt}`);
      await vscode.commands.executeCommand('vscode.open', chatUri);
    },
  );
}

let _dashboardPanel: vscode.WebviewPanel | undefined;
type DashboardMessage =
  | { type: 'openExternal'; payload: { url: string } }
  | { type: 'startBridgeServer' };

export async function openDashboardCommand(context: vscode.ExtensionContext): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  ensureBridgeServerRunning();

  if (_dashboardPanel) {
    _dashboardPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  const distDir = resolveGitnexusWebDist(context.extensionUri.fsPath);
  const localResourceRoots = [context.extensionUri];
  if (distDir) {
    localResourceRoots.push(vscode.Uri.file(distDir));
  }

  const panel = vscode.window.createWebviewPanel(
    'gitnexus.dashboard',
    'CodeBrain Graph Dashboard',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots,
    },
  );

  _dashboardPanel = panel;
  panel.onDidDispose(() => {
    _dashboardPanel = undefined;
  });

  panel.webview.onDidReceiveMessage((msg: DashboardMessage) => {
    if (!msg || typeof msg !== 'object') {
      return;
    }

    if (msg.type === 'openExternal' && msg.payload?.url) {
      void vscode.env.openExternal(vscode.Uri.parse(msg.payload.url));
      return;
    }

    if (msg.type === 'startBridgeServer') {
      void vscode.commands.executeCommand('codebrain.serve');
    }
  });

  panel.webview.html = distDir
    ? getGitnexusWebHtml(panel.webview, distDir)
    : getFallbackDashboardHtml(panel.webview, crypto.randomBytes(16).toString('hex'));
}

function getGitnexusWebHtml(webview: vscode.Webview, distDir: string): string {
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return getFallbackDashboardHtml(webview, crypto.randomBytes(16).toString('hex'));
  }

  const distUri = webview.asWebviewUri(vscode.Uri.file(distDir)).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data: blob:`,
    `font-src ${webview.cspSource} https:`,
    `style-src ${webview.cspSource} 'unsafe-inline' https:`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `connect-src ${webview.cspSource} https: http://localhost:4747 http://127.0.0.1:4747 ws://localhost:4747 ws://127.0.0.1:4747`,
    `worker-src ${webview.cspSource} blob:`,
  ].join('; ');

  let html = fs.readFileSync(indexPath, 'utf8');
  // Rewrite absolute asset paths to webview URIs
  html = html.replace(/(src|href)=["']\/(.*?)["']/g, (_m, attr: string, assetPath: string) => {
    return `${attr}="${distUri}/${assetPath}"`;
  });
  // Remove crossorigin attributes â€” webview resource URIs don't serve CORS headers,
  // so crossorigin causes module scripts and stylesheets to fail to load.
  html = html.replace(/\s+crossorigin(?:=["'][^"']*["'])?/gi, '');
  // Attach nonce to all script tags so module bootstrap can run under CSP.
  html = html.replace(/<script(\s|>)/gi, `<script nonce="${nonce}"$1`);

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
  if (html.includes('http-equiv="Content-Security-Policy"')) {
    html = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i, cspMeta);
  } else {
    html = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    ${cspMeta}`);
  }

  return html;
}

function getFallbackDashboardHtml(webview: vscode.Webview, nonce: string): string {
  const dashboardUrl = 'http://127.0.0.1:4747';
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} https: data:`,
    `frame-src ${dashboardUrl}`,
    `connect-src ${dashboardUrl} ws://127.0.0.1:4747 ws://localhost:4747`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CodeBrain Dashboard Setup</title>
    <style nonce="${nonce}">
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }
      .header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .title { font-weight: 600; }
      .container {
        max-width: 780px;
        margin: 16px auto;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        padding: 16px;
      }
      .hint {
        color: var(--vscode-descriptionForeground);
        line-height: 1.5;
        margin-bottom: 12px;
      }
      .cmd {
        margin: 8px 0 14px 0;
        padding: 8px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        background: var(--vscode-editorWidget-background);
        font-family: var(--vscode-editor-font-family);
        white-space: pre-wrap;
      }
      button {
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
      }
      button.secondary {
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-editorWidget-foreground);
      }
      #dashboard {
        width: 100%;
        height: calc(100vh - 48px);
        border: 0;
      }
      .hidden { display: none; }
    </style>
  </head>
  <body>
    <div class="header">
      <span class="title">CodeBrain Graph Dashboard</span>
      <button id="refresh" type="button">Refresh</button>
      <button id="openExternal" class="secondary" type="button">Open in Browser</button>
    </div>

    <div id="fallback" class="container">
      <h2>CodeBrain Dashboard assets are unavailable</h2>
      <div class="hint">
        The embedded dashboard build was not found in this extension package.
      </div>
      <div class="hint">Rebuild and package extension, then reopen dashboard:</div>
      <div class="cmd">npm run build:web && npm run package</div>
      <button id="startBridge" type="button">Start Bridge Server</button>
    </div>

    <iframe id="dashboard" src="${dashboardUrl}" title="CodeBrain Graph Dashboard" class="hidden"></iframe>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const dashboardUrl = ${JSON.stringify(dashboardUrl)};
      const dashboard = document.getElementById('dashboard');
      const fallback = document.getElementById('fallback');
      const refreshButton = document.getElementById('refresh');
      const openExternalButton = document.getElementById('openExternal');
      const startBridgeButton = document.getElementById('startBridge');

      function loadDashboard() {
        dashboard.src = dashboardUrl;
        dashboard.classList.remove('hidden');
      }

      refreshButton.addEventListener('click', () => {
        loadDashboard();
      });

      openExternalButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'openExternal', payload: { url: dashboardUrl } });
      });

      startBridgeButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'startBridgeServer' });
      });

      // Attempt to render dashboard immediately; keep fallback available for manual recovery.
      loadDashboard();
    </script>
  </body>
</html>`;
}

function resolveGitnexusWebDist(extensionRoot: string): string | undefined {
  const candidates = [
    path.join(extensionRoot, 'runtime', 'web', 'dist'),
    path.join(extensionRoot, 'GitNexus', 'gitnexus-web', 'dist'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }

  return undefined;
}

function ensureBridgeServerRunning(): void {
  if (_serveTerminal && !_serveTerminal.exitStatus) {
    return;
  }

  _serveTerminal = vscode.window.createTerminal({
    name: 'GitNexus Bridge',
    cwd: getWorkspaceRoot(),
    shellPath: process.platform === 'win32' ? 'cmd.exe' : undefined,
  });
  _serveTerminal.sendText(buildCodeBrainTerminalCommand(['serve']));
}

function getStagedFiles(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--cached'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, 200);
  } catch {
    return [];
  }
}

type PrReviewScope = 'staged' | 'all' | 'compare';

interface PrReviewMode {
  scope: PrReviewScope;
  baseRef?: string;
}

async function pickPrReviewMode(cwd: string): Promise<PrReviewMode | undefined> {
  const defaultBaseRef = getDefaultBaseRef(cwd);
  const items: Array<vscode.QuickPickItem & { mode: PrReviewMode }> = [
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
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'CodeBrain PR Review',
    placeHolder: 'Choose which changes to review',
  });
  if (!picked) {
    return undefined;
  }

  if (picked.mode.scope !== 'compare') {
    return picked.mode;
  }

  const baseRef = await vscode.window.showInputBox({
    title: 'CodeBrain PR Review',
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
    case 'staged':
      return getGitDiffFiles(cwd, ['diff', '--name-only', '--cached']);
    case 'all':
      return getGitDiffFiles(cwd, ['diff', '--name-only', 'HEAD']);
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
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 200);
  } catch {
    return [];
  }
}

function getDefaultBaseRef(cwd: string): string {
  const candidates = ['main', 'master'];
  for (const candidate of candidates) {
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

function buildDetectChangesSummary(stdout: string, stderr: string): string {
  const text = `${stdout}\n${stderr}`.trim();
  if (text.length === 0) {
    return '- No detect-changes output captured. Run the tool again in chat if needed.';
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 20);

  return lines.map((line) => `- ${line}`).join('\n');
}
