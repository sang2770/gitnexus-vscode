import * as vscode from 'vscode';
import { runCodeBrain, getWorkspaceRoot } from '../process/cli-runner.js';
import { ensureWorkspaceActiveContext, listIndexedRepos } from '../process/group-context.js';
import { CodeBrainStatusBar, IndexState, type IndexTooltipDetails } from '../ui/status-bar.js';
import { analyzeCommand } from '../commands/analyze.js';
import * as fs from 'fs';
import * as path from 'path';

interface GitExtension {
  getAPI(version: 1): GitApi;
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
}

interface GitRepositoryState {
  HEAD: GitHead | undefined;
  onDidChange: vscode.Event<void>;
}

interface GitHead {
  commit?: string;
}

interface MetaStats {
  embeddings?: number;
}

interface GitNexusMeta {
  stats?: MetaStats;
}

export class StalenessMonitor implements vscode.Disposable {
  private _timer: NodeJS.Timeout | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _gitRepoListeners = new Map<string, vscode.Disposable>();
  private _lastHeadByRepo = new Map<string, string>();
  private _autoIndexRunning = false;
  private _autoIndexDebounce: NodeJS.Timeout | undefined;

  constructor(
    private readonly _statusBar: CodeBrainStatusBar,
    private readonly _storage?: vscode.Memento,
  ) {}

  start(): void {
    const config = vscode.workspace.getConfiguration('codebrain');
    const intervalSec = config.get<number>('stalenessCheckIntervalSeconds', 0);

    // First check immediately (status + optional setup prompt)
    void this._check(true);

    // Periodic re-index based on configured interval.
    // 0 or negative value means disabled.
    if (intervalSec > 0) {
      this._timer = setInterval(() => {
        void this._periodicReindexTick();
      }, intervalSec * 1000);
    }

    // Re-check on config change
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('codebrain.stalenessCheckIntervalSeconds')) {
          this.stop();
          this.start();
        }
      }),
    );

    // Re-check when workspace folders change
    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this._check(true)),
    );

    this._attachGitHeadListeners();
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
    if (this._autoIndexDebounce) {
      clearTimeout(this._autoIndexDebounce);
      this._autoIndexDebounce = undefined;
    }
    for (const disposable of this._gitRepoListeners.values()) {
      disposable.dispose();
    }
    this._gitRepoListeners.clear();
    this._lastHeadByRepo.clear();
  }

  async forceCheck(): Promise<IndexState> {
    return this._check(true);
  }

  private async _check(runAutoActions: boolean): Promise<IndexState> {
    const details = await detectIndexStatusDetails(this._storage);
    const state = details.state;
    this._statusBar.setState(state, details.tooltip);

    if (!runAutoActions) {
      return state;
    }

    const config = vscode.workspace.getConfiguration('codebrain');

    if (state === 'not-indexed' && config.get<boolean>('autoSetupOnOpen', true)) {
      void this._offerSetup();
    }

    if (state === 'stale' && config.get<boolean>('autoIndex.onOpen', false)) {
      void analyzeCommand();
    }

    return state;
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

  private _attachGitHeadListeners(): void {
    const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExt) {
      return;
    }

    const exported = gitExt.isActive ? gitExt.exports : gitExt.activate();
    void Promise.resolve(exported)
      .then((ext) => {
        const api = ext.getAPI(1);
        this._wireGitApi(api);
      })
      .catch(() => {
        // Best-effort integration: extension still works without Git API.
      });
  }

  private _wireGitApi(api: GitApi): void {
    const refreshRepos = (): void => {
      const seen = new Set<string>();
      for (const repo of api.repositories) {
        const repoPath = repo.rootUri.fsPath;
        seen.add(repoPath);
        if (this._gitRepoListeners.has(repoPath)) {
          continue;
        }

        const initialHead = repo.state.HEAD?.commit ?? '';
        this._lastHeadByRepo.set(repoPath, initialHead);

        const disposable = repo.state.onDidChange(() => {
          void this._handleRepoHeadChange(repo);
        });
        this._gitRepoListeners.set(repoPath, disposable);
      }

      for (const [repoPath, disposable] of this._gitRepoListeners) {
        if (!seen.has(repoPath)) {
          disposable.dispose();
          this._gitRepoListeners.delete(repoPath);
          this._lastHeadByRepo.delete(repoPath);
        }
      }
    };

    refreshRepos();
    this._disposables.push(api.onDidOpenRepository(() => refreshRepos()));
    this._disposables.push(api.onDidCloseRepository(() => refreshRepos()));
  }

  private async _handleRepoHeadChange(repo: GitRepository): Promise<void> {
    const repoPath = repo.rootUri.fsPath;
    const currentHead = repo.state.HEAD?.commit ?? '';
    const previousHead = this._lastHeadByRepo.get(repoPath) ?? '';

    if (currentHead === previousHead) {
      return;
    }
    this._lastHeadByRepo.set(repoPath, currentHead);

    if (!this._isWorkspaceRepo(repoPath)) {
      return;
    }

    // Always refresh status quickly when HEAD changes.
    void this._check(true);

    const config = vscode.workspace.getConfiguration('codebrain');
    if (!config.get<boolean>('autoIndex.onBranchChange', false)) {
      return;
    }

    if (this._autoIndexDebounce) {
      clearTimeout(this._autoIndexDebounce);
    }
    this._autoIndexDebounce = setTimeout(() => {
      void this._autoReindexIfStale();
    }, 1500);
  }

  private _isWorkspaceRepo(repoPath: string): boolean {
    const workspaceRoot = path.resolve(getWorkspaceRoot());
    const normalizedRepo = path.resolve(repoPath);
    if (process.platform === 'win32') {
      return normalizedRepo.toLowerCase() === workspaceRoot.toLowerCase();
    }
    return normalizedRepo === workspaceRoot;
  }

  private async _autoReindexIfStale(): Promise<void> {
    if (this._autoIndexRunning) {
      return;
    }

    const state = await this._check(false);
    if (state !== 'stale') {
      return;
    }

    await this._runAutoReindex();
  }

  private async _runAutoReindex(): Promise<void> {
    this._autoIndexRunning = true;
    try {
      const useEmbeddings = this._hadEmbeddingsBefore();
      this._statusBar.setState('indexing');
      await analyzeCommand({
        embeddings: useEmbeddings ? true : undefined,
        path: getWorkspaceRoot(),
      });
      await this._check(true);
    } finally {
      this._autoIndexRunning = false;
    }
  }

  private _hadEmbeddingsBefore(): boolean {
    const metaPath = path.join(getWorkspaceRoot(), '.gitnexus', 'meta.json');
    if (!fs.existsSync(metaPath)) {
      return false;
    }

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as GitNexusMeta;
      return (meta.stats?.embeddings ?? 0) > 0;
    } catch {
      return false;
    }
  }

  private async _offerSetup(): Promise<void> {
    if (this._setupOffered) {
      return;
    }
    this._setupOffered = true;

    const choice = await vscode.window.showInformationMessage(
      'CodeBrain: This repository is not indexed yet. Set up for code intelligence?',
      'Setup Now',
      'Not Now',
    );
    if (choice === 'Setup Now') {
      await vscode.commands.executeCommand('codebrain.setup');
    }
  }

  dispose(): void {
    this.stop();
    this._disposables.forEach((d) => d.dispose());
  }
}

/** Parse `gitnexus status` output to derive IndexState */
export async function detectIndexState(): Promise<IndexState> {
  const details = await detectIndexStatusDetails();
  return details.state;
}

interface DetectResult {
  state: IndexState;
  tooltip?: IndexTooltipDetails;
}

interface StatusTarget {
  type: 'repo' | 'group';
  cwd: string;
  args: string[];
}

async function resolveStatusTarget(storage?: vscode.Memento): Promise<StatusTarget | undefined> {
  if (!storage) {
    return {
      type: 'repo',
      cwd: getWorkspaceRoot(),
      args: ['status'],
    };
  }

  const active = await ensureWorkspaceActiveContext(storage);
  if (!active) {
    return undefined;
  }

  if (active.type === 'group') {
    return {
      type: 'group',
      cwd: getWorkspaceRoot(),
      args: ['group', 'status', active.name],
    };
  }

  const repos = await listIndexedRepos();
  const targetRepo = repos.find(
    (repo) => repo.name.trim().toLowerCase() === active.name.trim().toLowerCase(),
  );
  if (!targetRepo) {
    return undefined;
  }

  return {
    type: 'repo',
    cwd: targetRepo.path,
    args: ['status'],
  };
}

function parseGroupState(stdout: string, stderr: string): IndexState {
  const out = `${stdout}\n${stderr}`.toLowerCase();

  if (
    out.includes('not found') ||
    out.includes('no groups configured') ||
    out.includes('never synced')
  ) {
    return 'not-indexed';
  }

  if (out.includes('stale') || out.includes('contracts_stale') || out.includes('missing')) {
    return 'stale';
  }

  if (out.includes(' ok')) {
    return 'fresh';
  }

  return 'error';
}

function parseGroupTooltip(stdout: string): IndexTooltipDetails | undefined {
  const lines = stdout.split(/\r?\n/).map((line) => line.trimEnd());
  if (lines.length === 0) {
    return undefined;
  }

  const groupLine = lines.find((line) => line.trimStart().startsWith('Group:'));
  const headerMatch = groupLine?.match(/^\s*Group:\s*(.+?)\s*\((?:last sync:\s*(.+)|never synced)\)\s*$/i);
  const groupName = headerMatch?.[1]?.trim();
  const lastSyncRaw = headerMatch?.[2]?.trim();
  const lastSync = lastSyncRaw && lastSyncRaw.length > 0 ? lastSyncRaw : undefined;

  const groupRepos: NonNullable<IndexTooltipDetails['groupRepos']> = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('Group:') || line.startsWith('Repo index / contracts staleness:')) {
      continue;
    }
    if (line.startsWith('Last sync missing repos:')) {
      continue;
    }

    const rowMatch = line.match(/^(.+?)\s{2,}(OK|STALE|MISSING)\b(.*)$/i);
    if (!rowMatch) {
      continue;
    }

    const pathValue = rowMatch[1]?.trim();
    const idxWord = rowMatch[2]?.toLowerCase();
    const trailing = rowMatch[3] ?? '';

    if (!pathValue) {
      continue;
    }

    let indexStatus: 'ok' | 'stale' | 'missing' = 'ok';
    if (idxWord === 'stale') {
      indexStatus = 'stale';
    } else if (idxWord === 'missing') {
      indexStatus = 'missing';
    }

    const behindMatch = trailing.match(/\((\d+)\s+commits?\s+behind\)/i);
    const commitsBehind = behindMatch?.[1] ? Number.parseInt(behindMatch[1], 10) : undefined;
    const contractsStale = /contracts_stale/i.test(trailing);

    groupRepos.push({
      path: pathValue,
      indexStatus,
      commitsBehind,
      contractsStale,
    });
  }

  if (!groupName && groupRepos.length === 0) {
    return undefined;
  }

  return {
    groupName,
    lastSync,
    groupRepos,
  };
}

function deriveStateFromGroupTooltip(details: IndexTooltipDetails | undefined): IndexState | undefined {
  if (!details) {
    return undefined;
  }

  if (details.groupRepos && details.groupRepos.length > 0) {
    const anyProblem = details.groupRepos.some(
      (repo) => repo.indexStatus !== 'ok' || Boolean(repo.contractsStale),
    );
    return anyProblem ? 'stale' : 'fresh';
  }

  if (details.lastSync === undefined) {
    return 'not-indexed';
  }

  return undefined;
}

async function detectIndexStatusDetails(storage?: vscode.Memento): Promise<DetectResult> {
  try {
    const target = await resolveStatusTarget(storage);
    if (!target) {
      return { state: 'not-indexed' };
    }

    const result = await runCodeBrain(target.args, {
      cwd: target.cwd,
      stream: false,
    });

    const parsedRepoTooltip = target.type === 'repo' ? parseStatusTooltip(result.stdout) : undefined;
    const parsedGroupTooltip = target.type === 'group' ? parseGroupTooltip(result.stdout) : undefined;

    if (result.exitCode !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`;
      if (combined.includes('not indexed') || combined.includes('No index')) {
        return { state: 'not-indexed' };
      }
      return { state: 'error' };
    }

    if (target.type === 'group') {
      const derived = deriveStateFromGroupTooltip(parsedGroupTooltip);
      const state = derived ?? parseGroupState(result.stdout, result.stderr);
      return { state, tooltip: parsedGroupTooltip };
    }

    const out = result.stdout.toLowerCase();

    if (out.includes('stale') || out.includes('behind')) {
      return { state: 'stale', tooltip: parsedRepoTooltip };
    }
    if (out.includes('up to date') || out.includes('fresh') || out.includes('current')) {
      return { state: 'fresh', tooltip: parsedRepoTooltip };
    }
    if (out.includes('not indexed') || out.includes('no index')) {
      return { state: 'not-indexed' };
    }

    // Default: likely fresh if exit code 0
    return { state: 'fresh', tooltip: parsedRepoTooltip };
  } catch {
    return { state: 'error' };
  }
}

function parseStatusTooltip(stdout: string): IndexTooltipDetails | undefined {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const read = (prefix: string): string | undefined => {
    const found = lines.find((line) => line.toLowerCase().startsWith(prefix.toLowerCase()));
    if (!found) {
      return undefined;
    }
    return found.slice(prefix.length).trim();
  };

  const repository = read('Repository:');
  const indexed = read('Indexed:');
  const indexedCommit = read('Indexed commit:');
  const currentCommit = read('Current commit:');
  const status = read('Status:');

  if (!repository && !indexed && !indexedCommit && !currentCommit && !status) {
    return undefined;
  }

  return {
    repository,
    indexed,
    indexedCommit,
    currentCommit,
    status,
  };
}
