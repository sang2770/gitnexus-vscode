import * as path from 'path';
import * as vscode from 'vscode';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import { getWorkspaceRoot, runCodeBrain } from '../process/cli-runner.js';

export type ImpactLensAnalysisKind = 'impact' | 'callers' | 'callees' | 'affected';

interface ImpactLensTarget {
  filePath: string;
  relativeFilePath: string;
  symbol?: string;
  source: 'selection' | 'cursor' | 'file';
}

interface ImpactLensLocation {
  name: string;
  filePath: string;
  kind?: string;
  startLine?: number;
}

interface ImpactLensResult {
  kind: ImpactLensAnalysisKind;
  title: string;
  summary: string;
  items: ImpactLensLocation[];
  emptyMessage: string;
}

interface CliNode {
  name?: string;
  kind?: string;
  filePath?: string;
  startLine?: number;
}

interface ImpactJson {
  symbol?: string;
  depth?: number;
  nodeCount?: number;
  edgeCount?: number;
  affected?: CliNode[];
}

interface CallersJson {
  symbol?: string;
  callers?: CliNode[];
}

interface CalleesJson {
  symbol?: string;
  callees?: CliNode[];
}

interface AffectedJson {
  changedFiles?: string[];
  affectedTests?: string[];
  totalDependentsTraversed?: number;
}

type ImpactLensNodeKind = 'target' | 'action' | 'group' | 'result' | 'message' | 'error';

class ImpactLensNode extends vscode.TreeItem {
  children: ImpactLensNode[] = [];

  constructor(
    label: string,
    public readonly kind: ImpactLensNodeKind,
    collapsible = vscode.TreeItemCollapsibleState.None,
  ) {
    super(label, collapsible);
    this.iconPath = {
      target: new vscode.ThemeIcon('target'),
      action: new vscode.ThemeIcon('play'),
      group: new vscode.ThemeIcon('graph-line'),
      result: new vscode.ThemeIcon('symbol-method'),
      message: new vscode.ThemeIcon('info'),
      error: new vscode.ThemeIcon('error'),
    }[kind];
  }
}

export class ImpactLensTreeProvider implements vscode.TreeDataProvider<ImpactLensNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ImpactLensNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _loadingKind: ImpactLensAnalysisKind | undefined;
  private _result: ImpactLensResult | undefined;
  private _error: string | undefined;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  refreshContext(): void {
    this.refresh();
  }

  getTreeItem(element: ImpactLensNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ImpactLensNode): Promise<ImpactLensNode[]> {
    if (element) {
      return element.children;
    }

    const target = this.getTarget();
    if (!target) {
      return [this.createMessageNode('Open a workspace file to use Impact Lens')];
    }

    const nodes = [
      this.createTargetNode(target),
      ...this.createActionNodes(target),
    ];

    if (this._loadingKind) {
      const loading = this.createMessageNode(`Running ${formatKindLabel(this._loadingKind)}...`);
      loading.iconPath = new vscode.ThemeIcon('sync');
      nodes.push(loading);
    }

    if (this._error) {
      const error = new ImpactLensNode(this._error, 'error');
      error.tooltip = this._error;
      nodes.push(error);
    }

    if (this._result) {
      nodes.push(this.createResultGroup(this._result));
    }

    return nodes;
  }

  getTarget(): ImpactLensTarget | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return undefined;
    }

    const filePath = editor.document.uri.fsPath;
    const relativeFilePath = toWorkspaceRelativePath(filePath);
    const selectionText = editor.document.getText(editor.selection).trim();
    const selectedSymbol = toUsableSymbol(selectionText);
    if (selectedSymbol) {
      return {
        filePath,
        relativeFilePath,
        symbol: selectedSymbol,
        source: 'selection',
      };
    }

    const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
    const cursorSymbol = wordRange
      ? toUsableSymbol(editor.document.getText(wordRange).trim())
      : undefined;

    return {
      filePath,
      relativeFilePath,
      symbol: cursorSymbol,
      source: cursorSymbol ? 'cursor' : 'file',
    };
  }

  setLoading(kind: ImpactLensAnalysisKind): void {
    this._loadingKind = kind;
    this._error = undefined;
    this.refresh();
  }

  setResult(result: ImpactLensResult): void {
    this._loadingKind = undefined;
    this._error = undefined;
    this._result = result;
    this.refresh();
  }

  setError(message: string): void {
    this._loadingKind = undefined;
    this._result = undefined;
    this._error = message;
    this.refresh();
  }

  clearLoading(): void {
    this._loadingKind = undefined;
    this.refresh();
  }

  private createTargetNode(target: ImpactLensTarget): ImpactLensNode {
    const label = target.symbol ? `Target: ${target.symbol}` : `File: ${target.relativeFilePath}`;
    const node = new ImpactLensNode(label, 'target');
    node.description = target.source;
    node.tooltip = target.symbol
      ? `${target.symbol}\n${target.relativeFilePath}`
      : target.relativeFilePath;
    return node;
  }

  private createActionNodes(target: ImpactLensTarget): ImpactLensNode[] {
    const nodes: ImpactLensNode[] = [];

    if (target.symbol) {
      nodes.push(
        createActionNode('Analyze impact', 'graph-line', 'codebrain.impactLens.impact'),
        createActionNode('Find callers', 'call-incoming', 'codebrain.impactLens.callers'),
        createActionNode('Find callees', 'call-outgoing', 'codebrain.impactLens.callees'),
      );
    } else {
      nodes.push(this.createMessageNode('Put the cursor on a symbol for impact, callers, or callees'));
    }

    nodes.push(
      createActionNode('Affected tests', 'beaker', 'codebrain.impactLens.affectedTests'),
      createActionNode('Ask @CodeBrain', 'comment-discussion', 'codebrain.impactLens.askCodeBrain'),
    );

    return nodes;
  }

  private createResultGroup(result: ImpactLensResult): ImpactLensNode {
    const group = new ImpactLensNode(
      result.title,
      'group',
      vscode.TreeItemCollapsibleState.Expanded,
    );
    group.description = result.summary;
    group.tooltip = result.summary;

    group.children = result.items.length > 0
      ? result.items.map((item) => createResultNode(item))
      : [this.createMessageNode(result.emptyMessage)];

    return group;
  }

  private createMessageNode(label: string): ImpactLensNode {
    const node = new ImpactLensNode(label, 'message');
    node.tooltip = label;
    return node;
  }
}

export async function runImpactLensAnalysis(
  provider: ImpactLensTreeProvider,
  kind: ImpactLensAnalysisKind,
): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const target = provider.getTarget();
  if (!target) {
    vscode.window.showWarningMessage('CodeBrain: Open a workspace file first.');
    return;
  }

  if (kind !== 'affected' && !target.symbol) {
    vscode.window.showWarningMessage('CodeBrain: Select a symbol or put the cursor on one first.');
    return;
  }

  provider.setLoading(kind);
  const workspaceRoot = getWorkspaceRoot();

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CodeBrain: Running ${formatKindLabel(kind)}...`,
        cancellable: true,
      },
      async (_progress, token) => {
        const result = await runCodeBrain(buildCliArgs(kind, target, workspaceRoot), {
          cwd: workspaceRoot,
          stream: false,
          token,
        });

        if (token.isCancellationRequested) {
          provider.clearLoading();
          vscode.window.showWarningMessage('CodeBrain: Impact Lens analysis cancelled.');
          return;
        }

        if (result.exitCode !== 0) {
          const message = summarizeCliFailure(result.stderr || result.stdout);
          provider.setError(`Failed: ${message}`);
          vscode.window.showErrorMessage(`CodeBrain: Impact Lens failed. ${message}`);
          return;
        }

        provider.setResult(buildResult(kind, target, result.stdout, result.stderr));
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    provider.setError(`Failed: ${message}`);
    vscode.window.showErrorMessage(`CodeBrain: Impact Lens failed. ${message}`);
  }
}

export async function openImpactLensLocation(location: ImpactLensLocation): Promise<void> {
  const filePath = path.isAbsolute(location.filePath)
    ? location.filePath
    : path.join(getWorkspaceRoot(), location.filePath);

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(document);

  if (location.startLine && location.startLine > 0) {
    const pos = new vscode.Position(location.startLine - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

export async function askCodeBrainAboutImpactTarget(provider: ImpactLensTreeProvider): Promise<void> {
  const target = provider.getTarget();
  if (!target) {
    vscode.window.showWarningMessage('CodeBrain: Open a workspace file first.');
    return;
  }

  const prompt = target.symbol
    ? `/impact ${target.symbol}`
    : `/plan assess the change impact for ${target.relativeFilePath}`;

  const chatUri = vscode.Uri.parse(
    `vscode://xpl.chat-uri/startChat?agent=codebrain.codegraph&prompt=${encodeURIComponent(prompt)}`,
  );
  await vscode.commands.executeCommand('vscode.open', chatUri);
}

function createActionNode(label: string, icon: string, command: string): ImpactLensNode {
  const node = new ImpactLensNode(label, 'action');
  node.iconPath = new vscode.ThemeIcon(icon);
  node.command = { command, title: label };
  return node;
}

function createResultNode(item: ImpactLensLocation): ImpactLensNode {
  const node = new ImpactLensNode(item.name, 'result');
  node.description = formatLocationDescription(item);
  node.tooltip = `${item.name}\n${formatLocationDescription(item)}`;
  node.command = {
    command: 'codebrain.impactLens.openLocation',
    title: 'Open location',
    arguments: [item],
  };
  return node;
}

function buildCliArgs(
  kind: ImpactLensAnalysisKind,
  target: ImpactLensTarget,
  workspaceRoot: string,
): string[] {
  switch (kind) {
    case 'impact':
      return ['impact', target.symbol ?? '', '--path', workspaceRoot, '--depth', '2', '--json'];
    case 'callers':
      return ['callers', target.symbol ?? '', '--path', workspaceRoot, '--limit', '20', '--json'];
    case 'callees':
      return ['callees', target.symbol ?? '', '--path', workspaceRoot, '--limit', '20', '--json'];
    case 'affected':
      return ['affected', target.relativeFilePath, '--path', workspaceRoot, '--json'];
    default:
      return [];
  }
}

function buildResult(
  kind: ImpactLensAnalysisKind,
  target: ImpactLensTarget,
  stdout: string,
  stderr: string,
): ImpactLensResult {
  const fallback = sanitizeCliOutput(stdout || stderr);

  try {
    switch (kind) {
      case 'impact': {
        const parsed = JSON.parse(stdout) as ImpactJson;
        const items = toLocations(parsed.affected ?? []);
        return {
          kind,
          title: `Impact: ${items.length} symbols`,
          summary: `${target.symbol ?? parsed.symbol ?? 'target'} - ${parsed.edgeCount ?? 0} edges, depth ${parsed.depth ?? 2}`,
          items,
          emptyMessage: fallback || `No affected symbols found for ${target.symbol ?? 'target'}.`,
        };
      }
      case 'callers': {
        const parsed = JSON.parse(stdout) as CallersJson;
        const items = toLocations(parsed.callers ?? []);
        return {
          kind,
          title: `Callers: ${items.length}`,
          summary: target.symbol ?? parsed.symbol ?? '',
          items,
          emptyMessage: fallback || `No callers found for ${target.symbol ?? 'target'}.`,
        };
      }
      case 'callees': {
        const parsed = JSON.parse(stdout) as CalleesJson;
        const items = toLocations(parsed.callees ?? []);
        return {
          kind,
          title: `Callees: ${items.length}`,
          summary: target.symbol ?? parsed.symbol ?? '',
          items,
          emptyMessage: fallback || `No callees found for ${target.symbol ?? 'target'}.`,
        };
      }
      case 'affected': {
        const parsed = JSON.parse(stdout) as AffectedJson;
        const tests = parsed.affectedTests ?? [];
        return {
          kind,
          title: `Affected tests: ${tests.length}`,
          summary: `${target.relativeFilePath} - ${parsed.totalDependentsTraversed ?? 0} dependents traversed`,
          items: tests.map((filePath) => ({
            name: path.basename(filePath),
            filePath,
            kind: 'test',
          })),
          emptyMessage: fallback || `No affected tests found for ${target.relativeFilePath}.`,
        };
      }
      default:
        return fallbackResult(kind, fallback);
    }
  } catch {
    return fallbackResult(kind, fallback || 'No JSON result returned.');
  }
}

function fallbackResult(kind: ImpactLensAnalysisKind, message: string): ImpactLensResult {
  return {
    kind,
    title: formatKindLabel(kind),
    summary: message,
    items: [],
    emptyMessage: message,
  };
}

function toLocations(nodes: CliNode[]): ImpactLensLocation[] {
  return nodes
    .filter((node) => node.filePath)
    .map((node) => ({
      name: node.name ?? path.basename(node.filePath ?? ''),
      kind: node.kind,
      filePath: node.filePath ?? '',
      startLine: node.startLine,
    }));
}

function toWorkspaceRelativePath(filePath: string): string {
  const root = getWorkspaceRoot();
  const relative = path.relative(root, filePath);
  const isInsideWorkspace = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  return normalizeSlashes(isInsideWorkspace ? relative : filePath);
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function toUsableSymbol(value: string): string | undefined {
  if (!value || value.length > 120 || /\r|\n/.test(value)) {
    return undefined;
  }

  return /^[A-Za-z_$][\w$]*(?:[.:]{1,2}[A-Za-z_$][\w$]*)*$/u.test(value)
    ? value
    : undefined;
}

function formatKindLabel(kind: ImpactLensAnalysisKind): string {
  return {
    impact: 'Impact analysis',
    callers: 'Callers',
    callees: 'Callees',
    affected: 'Affected tests',
  }[kind];
}

function formatLocationDescription(item: ImpactLensLocation): string {
  const loc = `${normalizeSlashes(item.filePath)}${item.startLine ? `:${item.startLine}` : ''}`;
  return item.kind ? `${item.kind} - ${loc}` : loc;
}

function sanitizeCliOutput(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*m/gu, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' ');
}

function summarizeCliFailure(text: string): string {
  return sanitizeCliOutput(text) || 'Check the CodeBrain output channel.';
}
