import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoot } from '../process/cli-runner.js';
import {
  createTokenReductionReport,
  type TokenReductionReport,
  uniqueSelectedFiles,
} from '../process/token-optimizer.js';

const GraphologyRuntime = require('graphology') as any;
const forceAtlas2 = require('graphology-layout-forceatlas2') as any;

export interface StatusReportData {
  initialized?: boolean;
  version?: string;
  projectPath?: string;
  indexPath?: string;
  lastIndexed?: string | null;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  dbSizeBytes?: number;
  backend?: string;
  journalMode?: string;
  languages?: string[];
  nodesByKind?: Record<string, number>;
  pendingChanges?: {
    added?: number;
    modified?: number;
    removed?: number;
  };
  worktreeMismatch?: {
    worktreeRoot?: string;
    indexRoot?: string;
  } | null;
}

export interface QueryResultNode {
  name?: string;
  qualifiedName?: string;
  kind?: string;
  filePath?: string;
  startLine?: number;
  signature?: string;
}

export interface QueryResultItem {
  node?: QueryResultNode;
  score?: number;
}

export interface QueryReportMetadata {
  allResultCount?: number;
  filesScanned?: number;
  workflow?: QueryWorkflowData;
}

export interface QueryWorkflowData {
  symbol: string;
  depth: number;
  target?: QueryResultNode;
  callers: QueryResultNode[];
  callees: QueryResultNode[];
  affected: QueryResultNode[];
  edgeCount?: number;
  warnings?: string[];
}

interface QueryGraphNode {
  id: string;
  label: string;
  role: 'query' | 'target' | 'caller' | 'callee' | 'impact' | 'result';
  kind?: string;
  filePath?: string;
  startLine?: number;
  signature?: string;
  x: number;
  y: number;
  size: number;
  color: string;
}

interface QueryGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
  label: string;
  description: string;
  relation: 'query' | 'calls' | 'impact' | 'match';
  color: string;
  size: number;
}

interface QueryGraphData {
  nodes: QueryGraphNode[];
  edges: QueryGraphEdge[];
  focusNodeId?: string;
  warnings: string[];
  stats: {
    resultCount: number;
    allResultCount?: number;
    depth?: number;
    callerCount: number;
    calleeCount: number;
    impactCount: number;
  };
}

interface GraphAssetUris {
  graphology: string;
  sigma: string;
}

let activePanel: vscode.WebviewPanel | undefined;
let reportPanelIconPath: vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } | undefined;
let reportPanelExtensionUri: vscode.Uri | undefined;

export function configureReportPanel(extensionUri: vscode.Uri): void {
  reportPanelExtensionUri = extensionUri;
  const iconUri = vscode.Uri.joinPath(extensionUri, 'resources', 'icon-activity.svg');
  reportPanelIconPath = { light: iconUri, dark: iconUri };
  if (activePanel) {
    activePanel.iconPath = reportPanelIconPath;
  }
}

export function showStatusReport(status: StatusReportData, rawOutput: string): void {
  const report = createTokenReductionReport({
    beforeText: rawOutput,
    afterText: buildStatusOptimizedText(status),
    defaultMode: 'compact',
    source: 'status-report',
    filesScanned: status.fileCount,
    selectedFiles: [],
  });
  showReportPanel({
    title: 'Index Status',
    html: buildStatusHtml(status, rawOutput, report),
  });
}

export function showQueryReport(
  query: string,
  results: QueryResultItem[],
  rawOutput: string,
  metadata: QueryReportMetadata = {},
): void {
  const selectedFiles = uniqueSelectedFiles(results.map((result) => result.node?.filePath));
  const report = createTokenReductionReport({
    beforeText: rawOutput,
    afterText: JSON.stringify(results, null, 2),
    defaultMode: 'balanced',
    source: 'query-report',
    filesScanned: metadata.filesScanned,
    selectedFiles,
  });
  showReportPanel({
    title: 'Query Results',
    html: buildQueryHtml(query, results, rawOutput, report, metadata),
    enableGraphAssets: true,
  });
}

function showReportPanel(input: { title: string; html: string; enableGraphAssets?: boolean }): void {
  if (!activePanel) {
    const webviewOptions: vscode.WebviewPanelOptions & vscode.WebviewOptions = {
      enableScripts: true,
      retainContextWhenHidden: true,
      ...(reportPanelExtensionUri
        ? {
            localResourceRoots: [
              vscode.Uri.joinPath(reportPanelExtensionUri, 'resources'),
              vscode.Uri.joinPath(reportPanelExtensionUri, 'node_modules'),
            ],
          }
        : {}),
    };

    activePanel = vscode.window.createWebviewPanel(
      'codebrain.report',
      'CodeBrain Report',
      vscode.ViewColumn.Beside,
      webviewOptions,
    );
    if (reportPanelIconPath) {
      activePanel.iconPath = reportPanelIconPath;
    }

    activePanel.onDidDispose(() => {
      activePanel = undefined;
    });

    activePanel.webview.onDidReceiveMessage((message: unknown) => {
      void handleWebviewMessage(message);
    });
  }

  activePanel.title = `CodeBrain: ${input.title}`;
  activePanel.webview.html = buildHtmlDocument(
    activePanel.webview,
    input.title,
    input.html,
    input.enableGraphAssets === true,
  );
  activePanel.reveal(vscode.ViewColumn.Beside);
}

async function handleWebviewMessage(message: unknown): Promise<void> {
  if (!isOpenFileMessage(message)) {
    return;
  }

  const filePath = resolveReportPath(message.filePath);
  if (!filePath) {
    vscode.window.showWarningMessage(`CodeBrain: Could not resolve ${message.filePath}`);
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  const line = Math.max(0, (message.line ?? 1) - 1);
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

function isOpenFileMessage(message: unknown): message is { command: 'openFile'; filePath: string; line?: number } {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const record = message as Record<string, unknown>;
  return record.command === 'openFile' && typeof record.filePath === 'string';
}

function resolveReportPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, path.sep);
  const candidates = path.isAbsolute(normalized)
    ? [normalized]
    : [path.join(getWorkspaceRoot(), normalized)];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function buildStatusHtml(status: StatusReportData, rawOutput: string, report: TokenReductionReport): string {
  const pending = status.pendingChanges;
  const pendingTotal = (pending?.added ?? 0) + (pending?.modified ?? 0) + (pending?.removed ?? 0);
  const state = !status.initialized ? 'Not Indexed' : pendingTotal > 0 ? 'Stale' : 'Fresh';
  const stateClass = !status.initialized ? 'danger' : pendingTotal > 0 ? 'warning' : 'success';

  const cards = [
    metricCard('State', state, stateClass),
    metricCard('Files', formatNumber(status.fileCount)),
    metricCard('Nodes', formatNumber(status.nodeCount)),
    metricCard('Edges', formatNumber(status.edgeCount)),
    metricCard('Pending', formatNumber(pendingTotal), pendingTotal > 0 ? 'warning' : undefined),
    metricCard('DB Size', formatBytes(status.dbSizeBytes)),
  ].join('');

  const projectRows = [
    detailRow('Project', status.projectPath),
    detailRow('Index path', status.indexPath),
    detailRow('Version', status.version),
    detailRow('Last indexed', status.lastIndexed ?? undefined),
    detailRow('Backend', status.backend),
    detailRow('Journal', status.journalMode),
  ].join('');

  const pendingRows = [
    detailRow('Added', formatNumber(pending?.added)),
    detailRow('Modified', formatNumber(pending?.modified)),
    detailRow('Removed', formatNumber(pending?.removed)),
  ].join('');

  const languages = (status.languages ?? []).map((language) => tag(language)).join('');
  const nodeKinds = Object.entries(status.nodesByKind ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([kind, count]) => detailRow(kind, formatNumber(count)))
    .join('');

  const mismatch = status.worktreeMismatch
    ? section('Worktree Warning', [
        detailRow('Worktree root', status.worktreeMismatch.worktreeRoot),
        detailRow('Index root', status.worktreeMismatch.indexRoot),
      ].join(''), 'warning-section')
    : '';

  return [
    `<div class="hero"><div><div class="eyebrow">CodeGraph</div><h1>Index Status</h1></div><span class="pill ${stateClass}">${escapeHtml(state)}</span></div>`,
    `<div class="cards">${cards}</div>`,
    section('Project', `<div class="details">${projectRows}</div>`),
    section('Pending Changes', `<div class="details">${pendingRows}</div>`),
    languages ? section('Languages', `<div class="tags">${languages}</div>`) : '',
    nodeKinds ? section('Symbols by Kind', `<div class="details compact">${nodeKinds}</div>`) : '',
    mismatch,
    buildTokenOptimizationSection(report),
    section('Raw JSON', `<pre>${escapeHtml(rawOutput.trim() || JSON.stringify(status, null, 2))}</pre>`),
  ].join('');
}

function buildQueryHtml(
  query: string,
  results: QueryResultItem[],
  rawOutput: string,
  report: TokenReductionReport,
  metadata: QueryReportMetadata,
): string {
  const graph = buildQueryGraphData(query, results, metadata);

  return [
    `<div class="hero"><div><div class="eyebrow">CodeGraph Query</div><h1>${escapeHtml(query)}</h1></div><span class="pill">${results.length}${metadata.allResultCount !== undefined && metadata.allResultCount !== results.length ? ` of ${metadata.allResultCount}` : ''} result${results.length === 1 ? '' : 's'}${metadata.workflow ? ` | depth ${metadata.workflow.depth}` : ''}</span></div>`,
    buildQueryGraphSection(graph),
    buildTokenOptimizationSection(report),
    section('Raw Output', `<details><summary>CLI JSON</summary><pre>${escapeHtml(rawOutput.trim())}</pre></details>`),
  ].join('');
}

function buildStatusOptimizedText(status: StatusReportData): string {
  const pending = status.pendingChanges;
  return [
    `initialized=${status.initialized ? 'true' : 'false'}`,
    `project=${status.projectPath ?? '-'}`,
    `lastIndexed=${status.lastIndexed ?? '-'}`,
    `files=${status.fileCount ?? '-'}`,
    `nodes=${status.nodeCount ?? '-'}`,
    `edges=${status.edgeCount ?? '-'}`,
    `pending=${(pending?.added ?? 0) + (pending?.modified ?? 0) + (pending?.removed ?? 0)}`,
  ].join('\n');
}

function buildQueryGraphSection(graph: QueryGraphData): string {
  const warning = graph.warnings.length > 0
    ? `<div class="workflow-warning">${escapeHtml(graph.warnings.join(' '))}</div>`
    : '';
  const detailsNode = graph.nodes.find((node) => node.id === graph.focusNodeId) ?? graph.nodes[0];

  return section(
    'Node Graph',
    [
      '<div class="graph-summary">',
      graphStat('Results', graph.stats.resultCount, graph.stats.allResultCount),
      graphStat('Callers', graph.stats.callerCount),
      graphStat('Callees', graph.stats.calleeCount),
      graph.stats.depth !== undefined ? graphStat(`Impact D${graph.stats.depth}`, graph.stats.impactCount) : '',
      '</div>',
      '<div class="graph-legend">',
      '<span class="legend-label">Nodes</span>',
      legendItem('target', 'Target'),
      legendItem('caller', 'Caller'),
      legendItem('callee', 'Callee'),
      legendItem('impact', 'Impact'),
      legendItem('result', 'Result'),
      '</div>',
      '<div class="edge-legend">',
      '<span class="legend-label">Edges</span>',
      edgeLegendItem('match', 'Query returns symbol'),
      edgeLegendItem('calls', 'Caller invokes target'),
      edgeLegendItem('calls', 'Target invokes callee'),
      edgeLegendItem('impact', 'Changing target affects symbol'),
      '</div>',
      '<div class="graph-shell" data-codebrain-query-graph>',
      '<div id="query-graph" class="query-graph"></div>',
      `<aside class="graph-details" id="graph-node-details">${buildGraphNodeDetails(detailsNode)}</aside>`,
      '</div>',
      graph.nodes.length <= 1 ? '<div class="empty">No indexed symbols matched this query.</div>' : '',
      warning,
      `<script type="application/json" id="query-graph-data">${serializeJsonForScript(graph)}</script>`,
    ].join(''),
    'graph-section',
  );
}

function buildQueryGraphData(
  query: string,
  results: QueryResultItem[],
  metadata: QueryReportMetadata,
): QueryGraphData {
  const workflow = metadata.workflow;
  const nodes = new Map<string, QueryGraphNode>();
  const edges = new Map<string, QueryGraphEdge>();
  const queryNode = addGraphNode(nodes, {
    id: 'query:root',
    label: query.trim() || 'Query',
    role: 'query',
  });

  const targetNode = workflow?.target
    ? addGraphNode(nodes, { source: workflow.target, role: 'target' })
    : undefined;
  const focusNodeId = targetNode?.id ?? queryNode.id;

  for (const result of results.slice(0, 24)) {
    if (!result.node) {
      continue;
    }
    const resultNode = addGraphNode(nodes, { source: result.node, role: targetNode && isSameNode(result.node, workflow?.target ?? {}) ? 'target' : 'result' });
    addGraphEdge(nodes, edges, queryNode.id, resultNode.id, 'match', {
      label: 'query returns',
      description: 'This symbol was returned by the CodeGraph query.',
    });
  }

  if (workflow && targetNode) {
    for (const caller of workflow.callers.slice(0, 24)) {
      const callerNode = addGraphNode(nodes, { source: caller, role: 'caller' });
      addGraphEdge(nodes, edges, callerNode.id, targetNode.id, 'calls', {
        label: 'calls target',
        description: 'The caller invokes the target symbol.',
      });
    }

    for (const callee of workflow.callees.slice(0, 24)) {
      const calleeNode = addGraphNode(nodes, { source: callee, role: 'callee' });
      addGraphEdge(nodes, edges, targetNode.id, calleeNode.id, 'calls', {
        label: 'target calls',
        description: 'The target invokes this downstream callee.',
      });
    }

    for (const impact of workflow.affected.slice(0, 36)) {
      if (isSameNode(impact, workflow.target ?? {})) {
        continue;
      }
      const impactNode = addGraphNode(nodes, { source: impact, role: 'impact' });
      addGraphEdge(nodes, edges, targetNode.id, impactNode.id, 'impact', {
        label: `change affects d${workflow.depth}`,
        description: `Changing the target can affect this symbol within impact depth ${workflow.depth}.`,
      });
    }
  }

  const graph: QueryGraphData = {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    focusNodeId,
    warnings: workflow?.warnings ?? [],
    stats: {
      resultCount: results.length,
      allResultCount: metadata.allResultCount,
      depth: workflow?.depth,
      callerCount: workflow?.callers.length ?? 0,
      calleeCount: workflow?.callees.length ?? 0,
      impactCount: workflow?.affected.length ?? 0,
    },
  };

  applyForceAtlasLayout(graph);
  return graph;
}

function addGraphNode(
  nodes: Map<string, QueryGraphNode>,
  input: {
    id?: string;
    label?: string;
    role: QueryGraphNode['role'];
    source?: QueryResultNode;
  },
): QueryGraphNode {
  const id = input.id ?? queryNodeId(input.source);
  const style = graphRoleStyle(input.role);
  const existing = nodes.get(id);
  if (existing) {
    if (graphRolePriority(input.role) > graphRolePriority(existing.role)) {
      existing.role = input.role;
      existing.color = style.color;
      existing.size = style.size;
    }
    existing.label = existing.label || input.label || input.source?.name || 'Unnamed symbol';
    return existing;
  }

  const node: QueryGraphNode = {
    id,
    label: input.label ?? input.source?.name ?? 'Unnamed symbol',
    role: input.role,
    kind: input.source?.kind,
    filePath: input.source?.filePath,
    startLine: input.source?.startLine,
    signature: input.source?.signature,
    x: 0,
    y: 0,
    size: style.size,
    color: style.color,
  };
  nodes.set(id, node);
  return node;
}

function addGraphEdge(
  nodes: Map<string, QueryGraphNode>,
  edges: Map<string, QueryGraphEdge>,
  source: string,
  target: string,
  relation: QueryGraphEdge['relation'],
  input: {
    label: string;
    description: string;
  },
): void {
  if (source === target) {
    return;
  }

  const style = graphEdgeStyle(relation);
  const id = `edge:${relation}:${source}->${target}:${input.label}`;
  if (edges.has(id)) {
    return;
  }

  edges.set(id, {
    id,
    source,
    target,
    sourceLabel: nodes.get(source)?.label ?? source,
    targetLabel: nodes.get(target)?.label ?? target,
    label: input.label,
    description: input.description,
    relation,
    color: style.color,
    size: style.size,
  });
}

function applyForceAtlasLayout(graph: QueryGraphData): void {
  if (graph.nodes.length === 0) {
    return;
  }

  const roleCounts = graph.nodes.reduce((counts, node) => {
    counts.set(node.role, (counts.get(node.role) ?? 0) + 1);
    return counts;
  }, new Map<QueryGraphNode['role'], number>());
  const roleSeen = new Map<QueryGraphNode['role'], number>();

  for (const node of graph.nodes) {
    const index = roleSeen.get(node.role) ?? 0;
    roleSeen.set(node.role, index + 1);
    const position = initialGraphPosition(node.role, index, roleCounts.get(node.role) ?? 1);
    node.x = position.x;
    node.y = position.y;
  }

  if (graph.nodes.length < 3) {
    return;
  }

  try {
    const GraphConstructor =
      GraphologyRuntime.MultiDirectedGraph ??
      GraphologyRuntime.DirectedGraph ??
      GraphologyRuntime;
    const layoutGraph = new GraphConstructor();
    for (const node of graph.nodes) {
      layoutGraph.addNode(node.id, {
        x: node.x,
        y: node.y,
        size: node.size,
      });
    }
    for (const edge of graph.edges) {
      if (layoutGraph.hasNode(edge.source) && layoutGraph.hasNode(edge.target)) {
        layoutGraph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, { weight: edge.size });
      }
    }

    const inferred = forceAtlas2.inferSettings(layoutGraph);
    forceAtlas2.assign(layoutGraph, {
      iterations: Math.min(120, Math.max(35, graph.nodes.length * 4)),
      settings: {
        ...inferred,
        gravity: 0.35,
        scalingRatio: 8,
        slowDown: 2,
        strongGravityMode: true,
      },
    });

    layoutGraph.forEachNode((id: string, attrs: { x?: number; y?: number }) => {
      const node = graph.nodes.find((candidate) => candidate.id === id);
      if (!node) {
        return;
      }
      node.x = Number.isFinite(attrs.x) ? Number(attrs.x) : node.x;
      node.y = Number.isFinite(attrs.y) ? Number(attrs.y) : node.y;
    });
  } catch (err) {
    graph.warnings.push(`Layout: ${err instanceof Error ? err.message : String(err)}.`);
  }
}

function initialGraphPosition(
  role: QueryGraphNode['role'],
  index: number,
  total: number,
): { x: number; y: number } {
  const offset = index - (total - 1) / 2;
  const spread = Math.max(0.32, Math.min(0.58, 3 / Math.max(1, total)));
  switch (role) {
    case 'query':
      return { x: 0, y: -1.45 };
    case 'target':
      return { x: 0, y: 0 };
    case 'caller':
      return { x: -1.55, y: offset * spread };
    case 'callee':
      return { x: 1.55, y: offset * spread };
    case 'impact':
      return { x: offset * spread, y: 1.35 };
    case 'result':
    default: {
      const angle = (index / Math.max(1, total)) * Math.PI * 2;
      return {
        x: Math.cos(angle) * 1.05,
        y: -0.15 + Math.sin(angle) * 0.9,
      };
    }
  }
}

function queryNodeId(node: QueryResultNode | undefined): string {
  if (!node) {
    return 'node:unknown';
  }
  return [
    'node',
    node.filePath ?? 'unknown-file',
    node.startLine ?? 0,
    node.kind ?? 'symbol',
    node.name ?? 'unnamed',
  ].join(':');
}

function graphRoleStyle(role: QueryGraphNode['role']): { color: string; size: number } {
  return {
    query: { color: '#8d99a6', size: 8 },
    target: { color: '#f2cc60', size: 14 },
    caller: { color: '#4fa3ff', size: 10 },
    callee: { color: '#45c48a', size: 10 },
    impact: { color: '#d99e5f', size: 8 },
    result: { color: '#b58cff', size: 7 },
  }[role];
}

function graphRolePriority(role: QueryGraphNode['role']): number {
  return {
    query: 0,
    result: 1,
    impact: 2,
    caller: 3,
    callee: 3,
    target: 4,
  }[role];
}

function graphEdgeStyle(relation: QueryGraphEdge['relation']): { color: string; size: number } {
  return {
    query: { color: '#8d99a6', size: 1 },
    calls: { color: '#6fbf99', size: 2 },
    impact: { color: '#d99e5f', size: 1.4 },
    match: { color: '#9b8ad9', size: 1 },
  }[relation];
}

function graphStat(label: string, value: number, total?: number): string {
  const suffix = total !== undefined && total !== value ? ` / ${formatNumber(total)}` : '';
  return `<span class="graph-stat"><strong>${escapeHtml(formatNumber(value))}${escapeHtml(suffix)}</strong>${escapeHtml(label)}</span>`;
}

function legendItem(role: QueryGraphNode['role'], label: string): string {
  return `<span class="legend-item"><span class="legend-dot ${role}"></span>${escapeHtml(label)}</span>`;
}

function edgeLegendItem(relation: QueryGraphEdge['relation'], label: string): string {
  return `<span class="legend-item"><span class="legend-line ${relation}"></span>${escapeHtml(label)}</span>`;
}

function buildGraphNodeDetails(node: QueryGraphNode | undefined): string {
  if (!node) {
    return '<div class="muted">No symbol selected.</div>';
  }

  const location = node.filePath
    ? `${node.filePath}${node.startLine ? `:${node.startLine}` : ''}`
    : '';
  const openButton = node.filePath
    ? `<button class="link-button graph-open" data-open-file="${escapeAttribute(node.filePath)}" data-line="${node.startLine ?? 1}">Open file</button>`
    : '';

  return [
    `<span class="kind">${escapeHtml(roleLabel(node.role))}</span>`,
    `<h3 class="graph-detail-title">${escapeHtml(node.label)}</h3>`,
    node.kind ? detailRow('Kind', node.kind) : '',
    location ? detailRow('Location', location) : '',
    node.signature ? `<pre class="signature">${escapeHtml(node.signature)}</pre>` : '',
    openButton,
  ].join('');
}

function roleLabel(role: QueryGraphNode['role']): string {
  return {
    query: 'query',
    target: 'target',
    caller: 'caller',
    callee: 'callee',
    impact: 'impact',
    result: 'result',
  }[role];
}

function serializeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildTokenOptimizationSection(report: TokenReductionReport): string {
  const selected = report.selectedFiles?.length
    ? report.selectedFiles.map((file) => `<button class="link-button file-chip" data-open-file="${escapeAttribute(file)}" data-line="1">${escapeHtml(file)}</button>`).join('')
    : '<span class="muted">No files selected in this report.</span>';
  const mode = `${report.configuredMode}${report.configuredMode === 'auto' ? ` -> ${report.effectiveMode}` : ''}`;
  const scanned = report.filesScanned === undefined ? 'Unknown scanned' : `${formatNumber(report.filesScanned)} scanned`;
  const selectedCount = report.filesSelected === undefined ? 'Unknown selected' : `${formatNumber(report.filesSelected)} selected`;

  return section(
    'Token Optimization',
    [
      '<div class="token-summary">',
      `<span class="token-chip">${escapeHtml(report.enabled ? mode : 'off')}</span>`,
      `<span>${escapeHtml(formatNumber(report.tokenBudget))} token budget</span>`,
      `<span>${escapeHtml(scanned)}</span>`,
      `<span>${escapeHtml(selectedCount)}</span>`,
      '</div>',
      `<details class="selected-files-details"><summary>Selected files</summary><div class="selected-files">${selected}</div></details>`,
    ].join(''),
    'token-section',
  );
}

function isSameNode(a: QueryResultNode, b: QueryResultNode): boolean {
  return Boolean(
    a.name &&
    b.name &&
    a.name === b.name &&
    a.filePath === b.filePath &&
    (a.startLine ?? 1) === (b.startLine ?? 1),
  );
}

function buildHtmlDocument(webview: vscode.Webview, title: string, body: string, enableGraphAssets: boolean): string {
  const nonce = getNonce();
  const graphAssets = enableGraphAssets ? getGraphAssetUris(webview) : undefined;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">`,
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    getStyles(),
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    body,
    '</main>',
    graphAssets ? `<script nonce="${nonce}" src="${graphAssets.graphology}"></script>` : '',
    graphAssets ? `<script nonce="${nonce}" src="${graphAssets.sigma}"></script>` : '',
    `<script nonce="${nonce}">`,
    getScript(),
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}

function getGraphAssetUris(webview: vscode.Webview): GraphAssetUris | undefined {
  if (!reportPanelExtensionUri) {
    return undefined;
  }

  const asUri = (...segments: string[]): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(reportPanelExtensionUri!, ...segments)).toString();

  return {
    graphology: asUri('node_modules', 'graphology', 'dist', 'graphology.umd.min.js'),
    sigma: asUri('node_modules', 'sigma', 'dist', 'sigma.min.js'),
  };
}

function metricCard(label: string, value: string, tone?: string): string {
  return `<div class="card ${tone ?? ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function section(title: string, content: string, className = ''): string {
  return `<section class="${className}"><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

function detailRow(label: string, value: string | number | undefined): string {
  return `<div class="detail"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value === undefined ? '-' : String(value))}</strong></div>`;
}

function tag(value: string): string {
  return `<span class="tag">${escapeHtml(value)}</span>`;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? '-' : new Intl.NumberFormat('en-US').format(value);
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) {
    return '-';
  }

  if (value < 1024) {
    return `${value} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = units[0] ?? 'KB';
  for (let i = 1; i < units.length && size >= 1024; i += 1) {
    size /= 1024;
    unit = units[i] ?? unit;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function getScript(): string {
  return `
const vscode = acquireVsCodeApi();

function postOpenFile(filePath, line) {
  if (!filePath) {
    return;
  }
  vscode.postMessage({
    command: 'openFile',
    filePath,
    line: Number(line || '1'),
  });
}

function bindOpenFileButtons(root) {
  (root || document).querySelectorAll('[data-open-file]').forEach((element) => {
    if (element.getAttribute('data-bound-open-file') === 'true') {
      return;
    }
    element.setAttribute('data-bound-open-file', 'true');
    element.addEventListener('click', () => {
      postOpenFile(
        element.getAttribute('data-open-file'),
        element.getAttribute('data-line') || '1',
      );
    });
  });
}

function escapeText(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function renderNodeDetails(attrs) {
  const location = attrs.filePath
    ? attrs.filePath + (attrs.startLine ? ':' + attrs.startLine : '')
    : '';
  const openButton = attrs.filePath
    ? '<button class="link-button graph-open" data-open-file="' + escapeText(attrs.filePath) + '" data-line="' + escapeText(attrs.startLine || 1) + '">Open file</button>'
    : '';
  return [
    '<span class="kind">' + escapeText(attrs.role || 'symbol') + '</span>',
    '<h3 class="graph-detail-title">' + escapeText(attrs.label || attrs.id || 'Symbol') + '</h3>',
    attrs.kind ? '<div class="detail"><span>Kind</span><strong>' + escapeText(attrs.kind) + '</strong></div>' : '',
    location ? '<div class="detail"><span>Location</span><strong>' + escapeText(location) + '</strong></div>' : '',
    attrs.signature ? '<pre class="signature">' + escapeText(attrs.signature) + '</pre>' : '',
    openButton,
  ].join('');
}

function renderEdgeDetails(attrs) {
  return [
    '<span class="kind">' + escapeText(attrs.relation || 'relation') + '</span>',
    '<h3 class="graph-detail-title">' + escapeText(attrs.label || 'Relationship') + '</h3>',
    '<div class="detail"><span>From</span><strong>' + escapeText(attrs.sourceLabel || '') + '</strong></div>',
    '<div class="detail"><span>Relation</span><strong>' + escapeText(attrs.description || attrs.label || '') + '</strong></div>',
    '<div class="detail"><span>To</span><strong>' + escapeText(attrs.targetLabel || '') + '</strong></div>',
  ].join('');
}

bindOpenFileButtons(document);

(function initQueryGraph() {
  const graphRoot = document.querySelector('[data-codebrain-query-graph]');
  if (!graphRoot) {
    return;
  }

  const container = document.getElementById('query-graph');
  const details = document.getElementById('graph-node-details');
  const dataElement = document.getElementById('query-graph-data');
  if (!container || !details || !dataElement) {
    return;
  }

  let data;
  try {
    data = JSON.parse(dataElement.textContent || '{}');
  } catch (err) {
    details.textContent = 'Could not parse graph data.';
    return;
  }

  if (!window.graphology || !window.Sigma) {
    details.textContent = 'Graph renderer assets are unavailable.';
    return;
  }

  const graphologyGlobal = window.graphology;
  const GraphConstructor =
    graphologyGlobal.MultiDirectedGraph ||
    graphologyGlobal.DirectedGraph ||
    graphologyGlobal;
  const SigmaConstructor = window.Sigma.Sigma || window.Sigma;
  const edgeCurveProgram = window.Sigma.rendering && window.Sigma.rendering.EdgeCurveProgram;
  const graph = new GraphConstructor();

  (data.nodes || []).forEach((node) => {
    graph.addNode(node.id, {
      id: node.id,
      label: node.label,
      role: node.role,
      kind: node.kind || '',
      filePath: node.filePath || '',
      startLine: node.startLine || 1,
      signature: node.signature || '',
      x: Number(node.x) || 0,
      y: Number(node.y) || 0,
      size: Number(node.size) || 6,
      color: node.color || '#8d99a6',
      zIndex: node.role === 'target' ? 3 : node.role === 'query' ? 0 : 1,
    });
  });

  (data.edges || []).forEach((edge) => {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
      return;
    }
    graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
      label: edge.label,
      relation: edge.relation,
      description: edge.description,
      sourceLabel: edge.sourceLabel,
      targetLabel: edge.targetLabel,
      size: Number(edge.size) || 1,
      color: edge.color || '#8d99a6',
      type: edgeCurveProgram ? 'curve' : undefined,
      zIndex: 0,
    });
  });

  const styles = getComputedStyle(document.documentElement);
  const foreground = styles.getPropertyValue('--vscode-foreground').trim() || '#cccccc';
  const edgeLabel = styles.getPropertyValue('--vscode-descriptionForeground').trim() || foreground;
  const settings = {
    allowInvalidContainer: true,
    defaultNodeColor: '#8d99a6',
    defaultEdgeColor: '#8d99a6',
    renderEdgeLabels: true,
    enableEdgeEvents: true,
    labelDensity: 0.16,
    labelRenderedSizeThreshold: 7,
    edgeLabelSize: 12,
    labelColor: { color: foreground },
    edgeLabelColor: { color: edgeLabel },
    minEdgeThickness: 0.6,
    zIndex: true,
  };
  if (edgeCurveProgram) {
    settings.defaultEdgeType = 'curve';
    settings.edgeProgramClasses = { curve: edgeCurveProgram };
  }

  let renderer;
  try {
    renderer = new SigmaConstructor(graph, container, settings);
  } catch (err) {
    details.textContent = err && err.message ? err.message : 'Could not render graph.';
    return;
  }

  function showNodeDetails(nodeId) {
    if (!graph.hasNode(nodeId)) {
      return;
    }
    const attrs = graph.getNodeAttributes(nodeId);
    details.innerHTML = renderNodeDetails(attrs);
    bindOpenFileButtons(details);
  }

  function showEdgeDetails(edgeId) {
    if (!graph.hasEdge(edgeId)) {
      return;
    }
    const attrs = graph.getEdgeAttributes(edgeId);
    details.innerHTML = renderEdgeDetails(attrs);
  }

  renderer.on('enterNode', (event) => {
    graph.setNodeAttribute(event.node, 'highlighted', true);
    showNodeDetails(event.node);
    renderer.refresh();
  });

  renderer.on('leaveNode', (event) => {
    if (graph.hasNode(event.node)) {
      graph.setNodeAttribute(event.node, 'highlighted', false);
      renderer.refresh();
    }
  });

  renderer.on('enterEdge', (event) => {
    graph.setEdgeAttribute(event.edge, 'highlighted', true);
    showEdgeDetails(event.edge);
    renderer.refresh();
  });

  renderer.on('leaveEdge', (event) => {
    if (graph.hasEdge(event.edge)) {
      graph.setEdgeAttribute(event.edge, 'highlighted', false);
      renderer.refresh();
    }
  });

  renderer.on('clickNode', (event) => {
    const attrs = graph.getNodeAttributes(event.node);
    showNodeDetails(event.node);
    if (attrs.filePath) {
      postOpenFile(attrs.filePath, attrs.startLine || 1);
    }
  });

  renderer.on('clickEdge', (event) => {
    showEdgeDetails(event.edge);
  });

  renderer.on('clickStage', () => {
    if (data.focusNodeId) {
      showNodeDetails(data.focusNodeId);
    }
  });

  if (data.focusNodeId) {
    showNodeDetails(data.focusNodeId);
  }

  requestAnimationFrame(() => {
    try {
      renderer.refresh();
      const camera = renderer.getCamera && renderer.getCamera();
      if (camera && typeof camera.animatedReset === 'function') {
        camera.animatedReset({ duration: 250 });
      }
    } catch {}
  });
})();
`;
}

function getStyles(): string {
  return `
:root {
  color-scheme: light dark;
}

body {
  margin: 0;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
}

main {
  max-width: 1120px;
  padding: 24px;
}

.hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.eyebrow {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0;
}

h1 {
  margin: 4px 0 0;
  font-size: 24px;
  font-weight: 650;
  line-height: 1.25;
}

h2 {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 650;
}

h3 {
  margin: 0 0 10px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0;
}

section {
  margin-top: 20px;
  border-top: 1px solid var(--vscode-panel-border);
  padding-top: 16px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
}

.card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 12px;
  background: var(--vscode-editorWidget-background);
}

.card span,
.detail span {
  display: block;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.card strong {
  display: block;
  margin-top: 6px;
  font-size: 18px;
}

.pill,
.tag,
.kind {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 999px;
  padding: 3px 8px;
  color: white;
  background: var(--vscode-badge-background);
  font-size: 12px;
  white-space: nowrap;
}

.success {
  background: var(--vscode-testing-iconPassed);
  color: aliceblue;
}

.warning {
  background: var(--vscode-testing-iconQueued);
}

.danger {
  background: var(--vscode-testing-iconFailed);
}

.warning-section {
  border-color: var(--vscode-testing-iconQueued);
}

.details {
  display: grid;
  gap: 8px;
}

.details.compact {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.detail {
  display: grid;
  grid-template-columns: minmax(120px, 170px) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.detail strong {
  font-weight: 500;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.token-section {
  padding-top: 12px;
}

.token-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.token-chip {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 999px;
  padding: 3px 8px;
  color: var(--vscode-badge-foreground);
  background: var(--vscode-badge-background);
}

.selected-files-details {
  margin-top: 8px;
}

summary {
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
}

.graph-section {
  padding-top: 14px;
}

.graph-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.graph-stat {
  display: inline-grid;
  min-width: 92px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

.graph-stat strong {
  color: var(--vscode-foreground);
  font-size: 16px;
  line-height: 1.2;
}

.graph-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.edge-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: -2px 0 10px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.legend-label {
  color: var(--vscode-descriptionForeground);
  font-weight: 650;
}

.legend-item {
  display: inline-flex;
  gap: 5px;
  align-items: center;
}

.legend-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #8d99a6;
}

.legend-dot.target {
  background: #f2cc60;
}

.legend-dot.caller {
  background: #4fa3ff;
}

.legend-dot.callee {
  background: #45c48a;
}

.legend-dot.impact {
  background: #d99e5f;
}

.legend-dot.result {
  background: #b58cff;
}

.legend-line {
  width: 18px;
  height: 2px;
  border-radius: 999px;
  background: #8d99a6;
}

.legend-line.match {
  background: #9b8ad9;
}

.legend-line.calls {
  background: #6fbf99;
}

.legend-line.impact {
  background: #d99e5f;
}

.graph-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(230px, 300px);
  min-height: 540px;
  overflow: hidden;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-editorWidget-background);
}

.query-graph {
  position: relative;
  min-height: 540px;
  background: var(--vscode-editor-background);
}

.graph-details {
  min-width: 0;
  border-left: 1px solid var(--vscode-panel-border);
  padding: 14px;
  overflow: auto;
}

.graph-detail-title {
  margin-top: 12px;
  color: var(--vscode-foreground);
  font-size: 16px;
  text-transform: none;
}

.graph-open {
  margin-top: 12px;
}

.workflow-warning {
  margin-top: 12px;
  border-left: 3px solid var(--vscode-testing-iconQueued);
  padding: 8px 10px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editorWidget-background);
}

.results {
  display: grid;
  gap: 12px;
}

.result {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 14px;
  background: var(--vscode-editorWidget-background);
}

.result-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: baseline;
}

.result h2 {
  margin-top: 8px;
  font-size: 16px;
}

.location {
  margin-top: 10px;
}

.link-button {
  color: var(--vscode-textLink-foreground);
  background: transparent;
  border: 0;
  padding: 0;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.link-button:hover {
  text-decoration: underline;
}

.selected-files {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.file-chip {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 999px;
  padding: 4px 8px;
}

pre {
  overflow: auto;
  border-radius: 6px;
  border: 1px solid var(--vscode-panel-border);
  padding: 12px;
  background: var(--vscode-textCodeBlock-background);
  white-space: pre-wrap;
}

.signature {
  margin: 12px 0 0;
}

.muted,
.empty {
  color: var(--vscode-descriptionForeground);
}

@media (max-width: 760px) {
  main {
    padding: 18px;
  }

  .hero {
    display: grid;
  }

  .graph-shell {
    grid-template-columns: 1fr;
  }

  .graph-details {
    border-top: 1px solid var(--vscode-panel-border);
    border-left: 0;
  }

}
`;
}
