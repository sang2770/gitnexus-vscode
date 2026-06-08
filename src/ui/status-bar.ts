import * as vscode from 'vscode';

export type IndexState = 'unknown' | 'indexing' | 'fresh' | 'stale' | 'not-indexed' | 'error';

interface StatusBarConfig {
  text: string;
  tooltip: string;
  color?: vscode.ThemeColor;
  backgroundColor?: vscode.ThemeColor;
  command?: string;
}

export interface IndexTooltipDetails {
  projectPath?: string;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  lastIndexed?: string | null;
  pendingChanges?: {
    added: number;
    modified: number;
    removed: number;
  };
}

const STATE_CONFIG: Record<IndexState, StatusBarConfig> = {
  unknown: {
    text: '$(graph-line) CodeBrain',
    tooltip: 'CodeBrain: checking CodeGraph status...',
    command: 'codebrain.status',
  },
  indexing: {
    text: '$(sync~spin) CodeBrain: Indexing...',
    tooltip: 'CodeBrain: CodeGraph indexing in progress',
    command: 'codebrain.status',
  },
  fresh: {
    text: '$(graph-line) CodeBrain: Fresh',
    tooltip: 'CodeBrain: CodeGraph index is up to date. Click to view status.',
    command: 'codebrain.status',
  },
  stale: {
    text: '$(warning) CodeBrain: Stale',
    tooltip: 'CodeBrain: CodeGraph index has pending changes. Click to sync.',
    backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
    command: 'codebrain.analyze',
  },
  'not-indexed': {
    text: '$(circle-slash) CodeBrain: Not indexed',
    tooltip: 'CodeBrain: This workspace has no CodeGraph index. Click to set up and index.',
    backgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground'),
    command: 'codebrain.setupAndAnalyze',
  },
  error: {
    text: '$(error) CodeBrain: Error',
    tooltip: 'CodeBrain: Failed to read CodeGraph status. Check Output panel.',
    backgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground'),
    command: 'codebrain.status',
  },
};

export class CodeBrainStatusBar implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;

  constructor() {
    this._item = vscode.window.createStatusBarItem(
      'codebrain.status',
      vscode.StatusBarAlignment.Left,
      100,
    );
    this._item.name = 'CodeBrain';
    this.setState('unknown');
    this._item.show();
  }

  setState(state: IndexState, details?: IndexTooltipDetails): void {
    const cfg = STATE_CONFIG[state];
    this._item.text = cfg.text;
    this._item.tooltip = this._buildTooltip(state, cfg.tooltip, details);
    this._item.color = cfg.color;
    this._item.backgroundColor = cfg.backgroundColor;
    this._item.command = cfg.command;
  }

  refreshContext(): void {
    this.setState('unknown');
  }

  private _buildTooltip(state: IndexState, fallback: string, details?: IndexTooltipDetails): string {
    if (!details) {
      return fallback;
    }

    const pending = details.pendingChanges;
    const pendingTotal = pending ? pending.added + pending.modified + pending.removed : 0;
    const lines = [
      `Project: ${details.projectPath ?? '-'}`,
      `Files: ${details.fileCount ?? '-'}`,
      `Nodes: ${details.nodeCount ?? '-'}`,
      `Edges: ${details.edgeCount ?? '-'}`,
      `Last indexed: ${details.lastIndexed ?? '-'}`,
      `Pending changes: ${pendingTotal}`,
      '',
      state === 'stale' ? 'Click to sync.' : 'Click to view status.',
    ];

    return lines.join('\n');
  }

  dispose(): void {
    this._item.dispose();
  }
}
