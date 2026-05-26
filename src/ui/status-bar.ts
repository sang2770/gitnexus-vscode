import * as vscode from 'vscode';
import { getActiveContext, type ContextType } from '../process/group-context.js';

export type IndexState = 'unknown' | 'indexing' | 'fresh' | 'stale' | 'not-indexed' | 'error';

interface StatusBarConfig {
  text: string;
  tooltip: string;
  color?: vscode.ThemeColor;
  backgroundColor?: vscode.ThemeColor;
  command?: string;
}

export interface IndexTooltipDetails {
  repository?: string;
  indexed?: string;
  indexedCommit?: string;
  currentCommit?: string;
  status?: string;
  groupName?: string;
  lastSync?: string;
  groupRepos?: GroupRepoStatus[];
}

export interface GroupRepoStatus {
  path: string;
  indexStatus: 'ok' | 'stale' | 'missing';
  commitsBehind?: number;
  contractsStale?: boolean;
}

const STATE_CONFIG: Record<IndexState, StatusBarConfig> = {
  unknown: {
    text: '$(graph-line) CodeBrain',
    tooltip: 'CodeBrain: checking status…',
    command: 'codebrain.status',
  },
  indexing: {
    text: '$(sync~spin) CodeBrain: Indexing…',
    tooltip: 'CodeBrain: Indexing in progress',
    command: 'codebrain.status',
  },
  fresh: {
    text: '$(graph-line) CodeBrain: Fresh',
    tooltip: 'CodeBrain: Index is up to date. Click to view status.',
    command: 'codebrain.status',
  },
  stale: {
    text: '$(warning) CodeBrain: Stale',
    tooltip: 'CodeBrain: Index is behind HEAD. Click to re-index.',
    backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
    command: 'codebrain.analyze',
  },
  'not-indexed': {
    text: '$(circle-slash) CodeBrain: Not indexed',
    tooltip: 'CodeBrain: This repo has not been indexed yet. Click to set up and analyze.',
    backgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground'),
    command: 'codebrain.setupAndAnalyze',
  },
  error: {
    text: '$(error) CodeBrain: Error',
    tooltip: 'CodeBrain: Failed to read index status. Check Output panel.',
    backgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground'),
    command: 'codebrain.status',
  },
};

export class CodeBrainStatusBar implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private readonly _contextItem: vscode.StatusBarItem;
  private _storage?: vscode.Memento;

  constructor(storage?: vscode.Memento) {
    this._storage = storage;
    this._item = vscode.window.createStatusBarItem(
      'codebrain.status',
      vscode.StatusBarAlignment.Left,
      100,
    );
    this._item.name = 'CodeBrain';
    this.setState('unknown');
    this._item.show();

    this._contextItem = vscode.window.createStatusBarItem(
      'codebrain.context',
      vscode.StatusBarAlignment.Left,
      99,
    );
    this._contextItem.name = 'CodeBrain Context';
    this._updateContextDisplay();
    this._contextItem.show();
  }

  private _updateContextDisplay(): void {
    if (!this._storage) {
      this._contextItem.hide();
      return;
    }

    const activeContext = getActiveContext(this._storage);
    if (!activeContext) {
      this._contextItem.hide();
      return;
    }

    const typeIcon = activeContext.type === 'repo' ? '$(repo)' : '$(server)';
    this._contextItem.text = `${typeIcon} ${activeContext.type === 'repo' ? 'Repo' : 'Group'}: ${activeContext.name}`;
    this._contextItem.tooltip = `Active ${activeContext.type === 'repo' ? 'Repository' : 'Group'}: ${activeContext.name}\nClick to change`;
    this._contextItem.command = 'codebrain.showContext';
    this._contextItem.show();
  }

  setState(state: IndexState, details?: IndexTooltipDetails): void {
    const cfg = STATE_CONFIG[state];
    this._item.text = cfg.text;
    this._item.tooltip = this._buildTooltip(state, cfg.tooltip, details);
    this._item.color = cfg.color;
    this._item.backgroundColor = cfg.backgroundColor;
    this._item.command = cfg.command;
  }

  private _buildTooltip(state: IndexState, fallback: string, details?: IndexTooltipDetails): string {
    if (!details) {
      return fallback;
    }

    if (details.groupRepos && details.groupRepos.length > 0) {
      return this._buildGroupTooltip(state, fallback, details);
    }

    if (state !== 'fresh' && state !== 'stale') {
      return fallback;
    }

    const lines = [
      `Repository: ${details.repository ?? '-'}`,
      `Indexed: ${details.indexed ?? '-'}`,
      `Indexed commit: ${details.indexedCommit ?? '-'}`,
      `Current commit: ${details.currentCommit ?? '-'}`,
      `Status: ${details.status ?? (state === 'fresh' ? 'up-to-date' : 'stale')}`,
      '',
      state === 'fresh' ? 'Click to view status.' : 'Click to re-index.',
    ];

    return lines.join('\n');
  }

  private _buildGroupTooltip(state: IndexState, fallback: string, details: IndexTooltipDetails): string {
    const repos = details.groupRepos ?? [];
    if (repos.length === 0) {
      return fallback;
    }

    const lines = [
      `Group: ${details.groupName ?? '-'}`,
      `Last sync: ${details.lastSync ?? 'never synced'}`,
      '',
      'Repo index / contracts status:',
    ];

    let anyContractsStale = false;
    for (const repo of repos) {
      let statusText = repo.indexStatus.toUpperCase();
      if (repo.indexStatus === 'stale' && typeof repo.commitsBehind === 'number') {
        statusText += ` (${repo.commitsBehind} behind)`;
      }
      const contractsFlag = repo.contractsStale ? ' (contracts stale)' : '';
      if (repo.contractsStale) anyContractsStale = true;
      lines.push(`- ${repo.path}: ${statusText}${contractsFlag}`);
    }

    if (anyContractsStale) {
      lines.push('');
      lines.push('Note: "contracts stale" means the group Contract Registry snapshot is out-of-date for that repo.');
      lines.push('Fix: re-run `gitnexus analyze` in the affected repo(s), then `gitnexus group sync <group>` to update contracts.json.');
    }

    lines.push('');
    lines.push(state === 'stale' || state === 'not-indexed' ? 'Click to re-index.' : 'Click to view status.');
    return lines.join('\n');
  }

  refreshContext(): void {
    this._updateContextDisplay();
  }

  dispose(): void {
    this._item.dispose();
    this._contextItem.dispose();
  }
}
