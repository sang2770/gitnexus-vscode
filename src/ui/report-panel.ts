import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoot } from '../process/cli-runner.js';
import {
  createTokenReductionReport,
  type TokenReductionReport,
  uniqueSelectedFiles,
} from '../process/token-optimizer.js';

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
}

let activePanel: vscode.WebviewPanel | undefined;

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
  });
}

function showReportPanel(input: { title: string; html: string }): void {
  if (!activePanel) {
    activePanel = vscode.window.createWebviewPanel(
      'codebrain.report',
      'CodeBrain Report',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    activePanel.onDidDispose(() => {
      activePanel = undefined;
    });

    activePanel.webview.onDidReceiveMessage((message: unknown) => {
      void handleWebviewMessage(message);
    });
  }

  activePanel.title = `CodeBrain: ${input.title}`;
  activePanel.webview.html = buildHtmlDocument(input.title, input.html);
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
  const rows = results
    .map((result) => {
      const node = result.node ?? {};
      const filePath = node.filePath ?? '';
      const line = node.startLine ?? 1;
      const score = result.score !== undefined ? `${Math.round(result.score)}%` : 'n/a';
      const location = filePath ? `${filePath}:${line}` : 'Unknown location';
      const openButton = filePath
        ? `<button class="link-button" data-open-file="${escapeAttribute(filePath)}" data-line="${line}">${escapeHtml(location)}</button>`
        : `<span class="muted">${escapeHtml(location)}</span>`;

      return [
        '<article class="result">',
        '<div class="result-header">',
        `<div><span class="kind">${escapeHtml(node.kind ?? 'symbol')}</span><h2>${escapeHtml(node.name ?? 'Unnamed result')}</h2></div>`,
        `<span class="score">${escapeHtml(score)}</span>`,
        '</div>',
        `<div class="location">${openButton}</div>`,
        node.signature ? `<pre class="signature">${escapeHtml(node.signature)}</pre>` : '',
        '</article>',
      ].join('');
    })
    .join('');

  const empty = results.length === 0
    ? '<div class="empty">No indexed symbols matched this query.</div>'
    : rows;

  return [
    `<div class="hero"><div><div class="eyebrow">CodeGraph Query</div><h1>${escapeHtml(query)}</h1></div><span class="pill">${results.length}${metadata.allResultCount !== undefined && metadata.allResultCount !== results.length ? ` of ${metadata.allResultCount}` : ''} result${results.length === 1 ? '' : 's'}</span></div>`,
    buildTokenOptimizationSection(report),
    section('Results', `<div class="results">${empty}</div>`),
    section('Raw Output', `<pre>${escapeHtml(rawOutput.trim())}</pre>`),
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

function buildTokenOptimizationSection(report: TokenReductionReport): string {
  const selected = report.selectedFiles?.length
    ? report.selectedFiles.map((file) => `<button class="link-button file-chip" data-open-file="${escapeAttribute(file)}" data-line="1">${escapeHtml(file)}</button>`).join('')
    : '<span class="muted">No files selected in this report.</span>';
  const cards = [
    metricCard('Mode', `${report.configuredMode}${report.configuredMode === 'auto' ? ` -> ${report.effectiveMode}` : ''}`),
    metricCard('Budget', `${formatNumber(report.tokenBudget)} tokens`),
    metricCard('Before', `${formatNumber(report.beforeTokens)} tokens`),
    metricCard('After', `${formatNumber(report.afterTokens)} tokens`),
    metricCard('Reduction', `${formatNumber(report.reductionTokens)} (${report.reductionPercent}%)`, report.reductionPercent > 0 ? 'success' : undefined),
    metricCard('Estimator', report.estimator),
  ].join('');
  const details = [
    detailRow('Enabled', report.enabled ? 'Yes' : 'No'),
    detailRow('Files scanned', report.filesScanned === undefined ? 'Unknown' : formatNumber(report.filesScanned)),
    detailRow('Files selected', report.filesSelected === undefined ? 'Unknown' : formatNumber(report.filesSelected)),
    detailRow('Source', report.source),
  ].join('');

  return section(
    'Token Optimization',
    [
      `<div class="cards">${cards}</div>`,
      `<div class="details token-details">${details}</div>`,
      `<div class="selected-files">${selected}</div>`,
    ].join(''),
  );
}

function buildHtmlDocument(title: string, body: string): string {
  const nonce = getNonce();
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`,
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    getStyles(),
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    body,
    '</main>',
    `<script nonce="${nonce}">`,
    getScript(),
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
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
document.querySelectorAll('[data-open-file]').forEach((element) => {
  element.addEventListener('click', () => {
    vscode.postMessage({
      command: 'openFile',
      filePath: element.getAttribute('data-open-file'),
      line: Number(element.getAttribute('data-line') || '1'),
    });
  });
});
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
  max-width: 980px;
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
.kind,
.score {
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

.token-details {
  margin-top: 12px;
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
`;
}
