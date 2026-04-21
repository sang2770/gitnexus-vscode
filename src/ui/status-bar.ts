import * as vscode from 'vscode';

export type IndexState = 'unknown' | 'indexing' | 'fresh' | 'stale' | 'not-indexed' | 'error';

interface StatusBarConfig {
  text: string;
  tooltip: string;
  color?: vscode.ThemeColor;
  backgroundColor?: vscode.ThemeColor;
  command?: string;
}

const STATE_CONFIG: Record<IndexState, StatusBarConfig> = {
  unknown: {
    text: '$(graph-line) GitNexus',
    tooltip: 'GitNexus: checking status…',
    command: 'gitnexus.status',
  },
  indexing: {
    text: '$(sync~spin) GitNexus: Indexing…',
    tooltip: 'GitNexus: Indexing in progress',
    command: 'gitnexus.status',
  },
  fresh: {
    text: '$(graph-line) GitNexus: Fresh',
    tooltip: 'GitNexus: Index is up to date. Click to view status.',
    command: 'gitnexus.status',
  },
  stale: {
    text: '$(warning) GitNexus: Stale',
    tooltip: 'GitNexus: Index is behind HEAD. Click to re-index.',
    backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
    command: 'gitnexus.analyze',
  },
  'not-indexed': {
    text: '$(circle-slash) GitNexus: Not indexed',
    tooltip: 'GitNexus: This repo has not been indexed yet. Click to set up.',
    backgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground'),
    command: 'gitnexus.setup',
  },
  error: {
    text: '$(error) GitNexus: Error',
    tooltip: 'GitNexus: Failed to read index status. Check Output panel.',
    backgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground'),
    command: 'gitnexus.status',
  },
};

export class GitNexusStatusBar implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;

  constructor() {
    this._item = vscode.window.createStatusBarItem(
      'gitnexus.status',
      vscode.StatusBarAlignment.Left,
      100,
    );
    this._item.name = 'GitNexus';
    this.setState('unknown');
    this._item.show();
  }

  setState(state: IndexState): void {
    const cfg = STATE_CONFIG[state];
    this._item.text = cfg.text;
    this._item.tooltip = cfg.tooltip;
    this._item.color = cfg.color;
    this._item.backgroundColor = cfg.backgroundColor;
    this._item.command = cfg.command;
  }

  dispose(): void {
    this._item.dispose();
  }
}
