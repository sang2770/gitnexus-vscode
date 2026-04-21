import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensureGitnexusCli } from '../process/prerequisites.js';
import { runGitnexus, getOutputChannel, getWorkspaceRoot, buildGitnexusTerminalCommand } from '../process/cli-runner.js';

export async function queryCommand(): Promise<void> {
  const ok = await ensureGitnexusCli();
  if (!ok) {
    return;
  }

  // Pre-fill with selected text if available
  const editor = vscode.window.activeTextEditor;
  const selected = editor?.document.getText(editor.selection).trim() ?? '';

  const query = await vscode.window.showInputBox({
    placeHolder: 'e.g. auth token validation flow',
    prompt: 'GitNexus: Search the knowledge graph',
    value: selected,
  });
  if (!query) {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'GitNexus: Querying graph…', cancellable: false },
    async () => {
      await runGitnexus(['query', query, '--limit', '5'], { cwd: getWorkspaceRoot() });
    },
  );
}

export async function wikiCommand(): Promise<void> {
  const ok = await ensureGitnexusCli();
  if (!ok) {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);

  const model = await vscode.window.showInputBox({
    placeHolder: 'gpt-4o-mini',
    prompt: 'GitNexus Wiki: LLM model to use (leave blank for default)',
    value: '',
  });

  const args = ['wiki'];
  if (model) {
    args.push('--model', model);
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'GitNexus: Generating wiki…', cancellable: true },
    async (_progress, token) => {
      const result = await runGitnexus(args, { cwd: getWorkspaceRoot(), token });
      if (result.exitCode === 0) {
        vscode.window.showInformationMessage('GitNexus: Wiki generated successfully.');
      } else if (!token.isCancellationRequested) {
        vscode.window.showErrorMessage('GitNexus: Wiki generation failed. Check Output panel.');
      }
    },
  );
}

let _serveTerminal: vscode.Terminal | undefined;

export async function serveCommand(): Promise<void> {
  const ok = await ensureGitnexusCli();
  if (!ok) {
    return;
  }

  if (_serveTerminal && !_serveTerminal.exitStatus) {
    const choice = await vscode.window.showWarningMessage(
      'GitNexus: Bridge server is already running.',
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
    name: 'GitNexus Bridge',
    cwd: getWorkspaceRoot(),
    shellPath: process.platform === 'win32' ? 'cmd.exe' : undefined,
  });
  _serveTerminal.show();
  _serveTerminal.sendText(buildGitnexusTerminalCommand(['serve']));

  vscode.window.showInformationMessage(
    'GitNexus: Bridge server starting on http://127.0.0.1:4747',
    'Open Web UI',
  ).then((c) => {
    if (c === 'Open Web UI') {
      vscode.env.openExternal(vscode.Uri.parse('http://127.0.0.1:4747'));
    }
  });
}

export async function prReviewCommand(): Promise<void> {
  const ok = await ensureGitnexusCli();
  if (!ok) {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);
  const workspaceRoot = getWorkspaceRoot();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'GitNexus: Preparing PR review context…', cancellable: true },
    async (_progress, token) => {
      if (token.isCancellationRequested) {
        return;
      }

      // Health hint: show current index status in output panel (best-effort only).
      await runGitnexus(['status'], { cwd: workspaceRoot, stream: true });

      const stagedFiles = getStagedFiles(workspaceRoot);
      const stagedSection =
        stagedFiles.length > 0
          ? stagedFiles.map((f) => `- ${f}`).join('\n')
          : '- No staged files detected. Ask user whether to review working tree or compare branch.';

      // Open Copilot chat with the reviewer agent and prefilled context
      const prompt =
        'Run a PR review using GitNexus MCP tools.\n' +
        'Workflow: 1) run detect_changes(scope: staged or compare), 2) run impact on modified symbols, 3) report findings by severity, 4) add missing tests.\n\n' +
        'Staged files:\n' +
        `${stagedSection}`;

      const encodedPrompt = encodeURIComponent(prompt);
      // VS Code Copilot chat URI — opens chat with prefilled prompt
      const chatUri = vscode.Uri.parse(`vscode://GitHub.copilot-chat/openChat?agent=gitnexus-pr-review&prompt=${encodedPrompt}`);
      await vscode.commands.executeCommand('vscode.open', chatUri);
    },
  );
}

let _dashboardPanel: vscode.WebviewPanel | undefined;
type DashboardMessage =
  | { type: 'openExternal'; payload: { url: string } }
  | { type: 'startBridgeServer' };

export async function openDashboardCommand(context: vscode.ExtensionContext): Promise<void> {
  const ok = await ensureGitnexusCli();
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
    'GitNexus Graph Dashboard',
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
      void vscode.commands.executeCommand('gitnexus.serve');
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
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data: blob:`,
    `font-src ${webview.cspSource} https:`,
    `style-src ${webview.cspSource} 'unsafe-inline' https:`,
    `script-src ${webview.cspSource} 'unsafe-inline'`,
    `connect-src ${webview.cspSource} https: http://localhost:4747 http://127.0.0.1:4747 ws://localhost:4747 ws://127.0.0.1:4747`,
    `worker-src ${webview.cspSource} blob:`,
  ].join('; ');

  let html = fs.readFileSync(indexPath, 'utf8');
  // Rewrite absolute asset paths to webview URIs
  html = html.replace(/(src|href)=["']\/(.*?)["']/g, (_m, attr: string, assetPath: string) => {
    return `${attr}="${distUri}/${assetPath}"`;
  });
  // Remove crossorigin attributes — webview resource URIs don't serve CORS headers,
  // so crossorigin causes module scripts and stylesheets to fail to load.
  html = html.replace(/\s+crossorigin(?:=["'][^"']*["'])?/gi, '');

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
  if (html.includes('http-equiv="Content-Security-Policy"')) {
    html = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i, cspMeta);
  } else {
    html = html.replace('<head>', `<head>\n    ${cspMeta}`);
  }

  return html;
}

function getFallbackDashboardHtml(webview: vscode.Webview, nonce: string): string {
  const dashboardUrl = 'http://127.0.0.1:4747';
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} https: data:`,
    `connect-src ${dashboardUrl}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GitNexus Graph Dashboard</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        <title>GitNexus Dashboard Setup</title>
        font-family: var(--vscode-font-family);
      .header {
        display: flex;
            font-family: var(--vscode-font-family);
        align-items: center;
        padding: 8px 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
          .container {
            max-width: 760px;
            margin: 20px auto;
            border: 1px solid var(--vscode-panel-border);
            padding: 16px;
        border: 1px solid var(--vscode-button-border, transparent);
          h2 {
            margin-top: 0;
        cursor: pointer;
      }
      button.secondary {
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-editorWidget-foreground);
            padding: 6px 12px;
      #dashboard {
            margin-right: 8px;
        width: 100%;
        height: calc(100vh - 44px);
        border: 0;
      }
      .hint {
          .hint {
            color: var(--vscode-descriptionForeground);
            line-height: 1.5;
            margin-bottom: 14px;
          }
          .cmd {
            margin: 8px 0 14px 0;
            padding: 8px;
            border: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editorWidget-background);
            font-family: var(--vscode-editor-font-family);
      <span class="title">GitNexus Graph Dashboard</span>
      <button id="refresh" type="button">Refresh</button>
      <button id="openExternal" class="secondary" type="button">Open in Browser</button>
    </div>
        <div class="container">
          <h2>GitNexus Dashboard needs gitnexus-web build output</h2>
          <div class="hint">
            This workspace does not currently expose a built gitnexus-web dist folder for embedding in VS Code webview.
          </div>
          <div class="hint">Build gitnexus-web once, then reopen Open Graph Dashboard:</div>
          <div class="cmd">cd repo/GitNexus/gitnexus-web && npm run build</div>
          <button id="startBridge" type="button">Start Bridge Server</button>
      const vscode = acquireVsCodeApi();
      const dashboardUrl = ${JSON.stringify(dashboardUrl)};
      const openExternalButton = document.getElementById('openExternal');

      refreshButton.addEventListener('click', () => {
          const startBridgeButton = document.getElementById('startBridge');

      openExternalButton.addEventListener('click', () => {
          startBridgeButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'startBridgeServer' });
    </script>
  </body>
</html>`;
}

function resolveGitnexusWebDist(extensionRoot: string): string | undefined {
  const candidates = [
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
  _serveTerminal.sendText(buildGitnexusTerminalCommand(['serve']));
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
