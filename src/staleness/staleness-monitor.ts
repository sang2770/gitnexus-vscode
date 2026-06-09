import * as vscode from 'vscode';
import { runCodeBrain, getWorkspaceRoot } from '../process/cli-runner.js';
import { CodeBrainStatusBar, IndexState, type IndexTooltipDetails } from '../ui/status-bar.js';
import { analyzeCommand } from '../commands/analyze.js';

interface CodeGraphStatusJson {
  initialized?: boolean;
  projectPath?: string;
  lastIndexed?: string | null;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  pendingChanges?: {
    added?: number;
    modified?: number;
    removed?: number;
  };
}

export class StalenessMonitor implements vscode.Disposable {
  private _timer: NodeJS.Timeout | undefined;
  private _statusCheckTimer: NodeJS.Timeout | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _autoIndexRunning = false;

  constructor(private readonly _statusBar: CodeBrainStatusBar) {}

  start(): void {
    this.stop();

    const config = vscode.workspace.getConfiguration('codebrain');
    const intervalSec = config.get<number>('stalenessCheckIntervalSeconds', 0);

    void this._check(true);

    if (intervalSec > 0) {
      this._timer = setInterval(() => {
        void this._periodicReindexTick();
      }, intervalSec * 1000);
    }

    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codebrain.stalenessCheckIntervalSeconds')) {
          this.stop();
          this.start();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this._check(true)),
      vscode.workspace.onDidSaveTextDocument((document) => this._scheduleStatusCheck(document.uri)),
      vscode.workspace.onDidCreateFiles((event) => this._scheduleStatusCheck(event.files[0])),
      vscode.workspace.onDidDeleteFiles((event) => this._scheduleStatusCheck(event.files[0])),
      vscode.workspace.onDidRenameFiles((event) => this._scheduleStatusCheck(event.files[0]?.newUri)),
    );
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }

    if (this._statusCheckTimer) {
      clearTimeout(this._statusCheckTimer);
      this._statusCheckTimer = undefined;
    }

    this._disposables.forEach((disposable) => disposable.dispose());
    this._disposables = [];
  }

  async forceCheck(): Promise<IndexState> {
    return this._check(true);
  }

  private async _check(runAutoActions: boolean): Promise<IndexState> {
    const details = await detectIndexStatusDetails();
    this._statusBar.setState(details.state, details.tooltip);

    if (!runAutoActions) {
      return details.state;
    }

    const config = vscode.workspace.getConfiguration('codebrain');
    if (details.state === 'not-indexed' && config.get<boolean>('autoSetupOnOpen', true)) {
      void this._offerSetup();
    }

    if (details.state === 'stale' && config.get<boolean>('autoIndex.onOpen', false)) {
      void analyzeCommand();
    }

    return details.state;
  }

  private _setupOffered = false;

  private async _periodicReindexTick(): Promise<void> {
    if (this._autoIndexRunning) {
      return;
    }

    const state = await this._check(true);
    if (state === 'not-indexed' || state === 'error') {
      return;
    }

    await this._runAutoReindex();
  }

  private async _runAutoReindex(): Promise<void> {
    this._autoIndexRunning = true;
    try {
      this._statusBar.setState('indexing');
      await analyzeCommand({ path: getWorkspaceRoot() });
      await this._check(true);
    } finally {
      this._autoIndexRunning = false;
    }
  }

  private _scheduleStatusCheck(uri?: vscode.Uri): void {
    if (uri && !this._isWorkspaceFile(uri)) {
      return;
    }

    if (this._statusCheckTimer) {
      clearTimeout(this._statusCheckTimer);
    }

    this._statusCheckTimer = setTimeout(() => {
      this._statusCheckTimer = undefined;
      void this._check(false);
    }, 750);
  }

  private _isWorkspaceFile(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') {
      return false;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return true;
    }

    return folders.some((folder) => uri.fsPath.startsWith(folder.uri.fsPath));
  }

  private async _offerSetup(): Promise<void> {
    if (this._setupOffered) {
      return;
    }
    this._setupOffered = true;

    const choice = await vscode.window.showInformationMessage(
      'CodeBrain: This workspace is not indexed with CodeGraph yet. Set it up?',
      'Setup Now',
      'Not Now',
    );
    if (choice === 'Setup Now') {
      await vscode.commands.executeCommand('codebrain.setupAndAnalyze');
    }
  }

  dispose(): void {
    this.stop();
  }
}

export async function detectIndexState(): Promise<IndexState> {
  return (await detectIndexStatusDetails()).state;
}

interface DetectResult {
  state: IndexState;
  tooltip?: IndexTooltipDetails;
}

async function detectIndexStatusDetails(): Promise<DetectResult> {
  try {
    const result = await runCodeBrain(['status', getWorkspaceRoot(), '--json'], {
      cwd: getWorkspaceRoot(),
      stream: false,
    });

    if (result.exitCode !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (combined.includes('not initialized') || combined.includes('not indexed')) {
        return { state: 'not-indexed' };
      }
      return { state: 'error' };
    }

    const parsed = JSON.parse(result.stdout) as CodeGraphStatusJson;
    if (!parsed.initialized) {
      return { state: 'not-indexed' };
    }

    const pending = {
      added: parsed.pendingChanges?.added ?? 0,
      modified: parsed.pendingChanges?.modified ?? 0,
      removed: parsed.pendingChanges?.removed ?? 0,
    };
    const pendingTotal = pending.added + pending.modified + pending.removed;
    const tooltip: IndexTooltipDetails = {
      projectPath: parsed.projectPath,
      fileCount: parsed.fileCount,
      nodeCount: parsed.nodeCount,
      edgeCount: parsed.edgeCount,
      lastIndexed: parsed.lastIndexed,
      pendingChanges: pending,
    };

    return {
      state: pendingTotal > 0 ? 'stale' : 'fresh',
      tooltip,
    };
  } catch {
    return { state: 'error' };
  }
}
