import * as vscode from 'vscode';
import { get_encoding, type Tiktoken } from '@dqbd/tiktoken';
import type { ContextMode } from '../workflows/intent-resolver.js';

export type TokenOptimizationMode = ContextMode | 'auto' | 'off';
export type TokenEstimatorKind = 'tiktoken' | 'heuristic';

export interface TokenOptimizationSettings {
  configuredMode: TokenOptimizationMode;
  effectiveMode: ContextMode;
  enabled: boolean;
  tokenBudget: number;
  queryResultLimit: number;
  historyTurnLimit: number;
  historyCharsPerTurn: number;
}

export interface TokenReductionReport {
  enabled: boolean;
  configuredMode: TokenOptimizationMode;
  effectiveMode: ContextMode;
  tokenBudget: number;
  beforeTokens: number;
  afterTokens: number;
  reductionTokens: number;
  reductionPercent: number;
  filesScanned?: number;
  filesSelected?: number;
  selectedFiles?: string[];
  estimator: TokenEstimatorKind;
  source: string;
}

let encoder: Tiktoken | undefined;
let encoderFailed = false;

const MODE_DEFAULTS: Record<ContextMode, {
  defaultBudget: number;
  queryResultLimit: number;
  historyTurnLimit: number;
  historyCharsPerTurn: number;
}> = {
  compact: {
    defaultBudget: 6000,
    queryResultLimit: 5,
    historyTurnLimit: 2,
    historyCharsPerTurn: 600,
  },
  balanced: {
    defaultBudget: 12000,
    queryResultLimit: 12,
    historyTurnLimit: 4,
    historyCharsPerTurn: 900,
  },
  full: {
    defaultBudget: 24000,
    queryResultLimit: 20,
    historyTurnLimit: 6,
    historyCharsPerTurn: 1400,
  },
};

export function getTokenOptimizationSettings(defaultMode: ContextMode): TokenOptimizationSettings {
  const config = vscode.workspace.getConfiguration('codebrain.tokenOptimization');
  const configuredMode = normalizeMode(config.get<string>('mode'), defaultMode);
  const effectiveMode = configuredMode === 'auto' || configuredMode === 'off'
    ? defaultMode
    : configuredMode;
  const defaults = MODE_DEFAULTS[effectiveMode];

  return {
    configuredMode,
    effectiveMode,
    enabled: configuredMode !== 'off',
    tokenBudget: getConfiguredBudget(config, effectiveMode, defaults.defaultBudget),
    queryResultLimit: defaults.queryResultLimit,
    historyTurnLimit: defaults.historyTurnLimit,
    historyCharsPerTurn: defaults.historyCharsPerTurn,
  };
}

export function estimateTokens(text: string): { tokens: number; estimator: TokenEstimatorKind } {
  if (!text) {
    return { tokens: 0, estimator: encoderFailed ? 'heuristic' : 'tiktoken' };
  }

  if (!encoderFailed) {
    try {
      encoder ??= get_encoding('o200k_base');
      return {
        tokens: encoder.encode(text).length,
        estimator: 'tiktoken',
      };
    } catch {
      encoderFailed = true;
    }
  }

  return {
    tokens: estimateTokensHeuristic(text),
    estimator: 'heuristic',
  };
}

export function createTokenReductionReport(input: {
  beforeText: string;
  afterText: string;
  defaultMode: ContextMode;
  source: string;
  filesScanned?: number;
  selectedFiles?: string[];
}): TokenReductionReport {
  const settings = getTokenOptimizationSettings(input.defaultMode);
  const before = estimateTokens(input.beforeText);
  const after = settings.enabled
    ? estimateTokens(input.afterText)
    : before;
  const beforeTokens = before.tokens;
  const afterTokens = after.tokens;
  const reductionTokens = Math.max(0, beforeTokens - afterTokens);
  const reductionPercent = beforeTokens > 0
    ? Math.round((reductionTokens / beforeTokens) * 100)
    : 0;

  return {
    enabled: settings.enabled,
    configuredMode: settings.configuredMode,
    effectiveMode: settings.effectiveMode,
    tokenBudget: settings.tokenBudget,
    beforeTokens,
    afterTokens,
    reductionTokens,
    reductionPercent,
    filesScanned: input.filesScanned,
    filesSelected: input.selectedFiles?.length,
    selectedFiles: input.selectedFiles,
    estimator: before.estimator === 'tiktoken' && after.estimator === 'tiktoken'
      ? 'tiktoken'
      : 'heuristic',
    source: input.source,
  };
}

export function buildTokenReductionMarkdown(report: TokenReductionReport): string {
  const filesSelected = report.filesSelected ?? report.selectedFiles?.length;
  const selectedFiles = report.selectedFiles?.length
    ? report.selectedFiles.slice(0, 12).map((file) => `- ${file}`).join('\n')
    : '- Unknown';

  return [
    'Token Optimization:',
    `- Mode: ${report.configuredMode}${report.configuredMode === 'auto' ? ` -> ${report.effectiveMode}` : ''}`,
    `- Enabled: ${report.enabled ? 'yes' : 'no'}`,
    `- Budget: ${formatNumber(report.tokenBudget)} tokens`,
    `- Estimated before: ${formatNumber(report.beforeTokens)} tokens`,
    `- Estimated after: ${formatNumber(report.afterTokens)} tokens`,
    `- Reduction: ${formatNumber(report.reductionTokens)} tokens (${report.reductionPercent}%)`,
    `- Files scanned: ${report.filesScanned === undefined ? 'Unknown' : formatNumber(report.filesScanned)}`,
    `- Files selected: ${filesSelected === undefined ? 'Unknown' : formatNumber(filesSelected)}`,
    `- Estimator: ${report.estimator}`,
    'Selected files:',
    selectedFiles,
  ].join('\n');
}

export function truncateForTokenMode(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n...[truncated by CodeBrain token optimization]`;
}

export function uniqueSelectedFiles(files: Array<string | undefined>): string[] {
  return Array.from(new Set(files.filter((file): file is string => Boolean(file)))).sort();
}

function normalizeMode(value: string | undefined, defaultMode: ContextMode): TokenOptimizationMode {
  if (value === 'auto' || value === 'compact' || value === 'balanced' || value === 'full' || value === 'off') {
    return value;
  }

  return defaultMode;
}

function getConfiguredBudget(
  config: vscode.WorkspaceConfiguration,
  mode: ContextMode,
  defaultBudget: number,
): number {
  const key = `${mode}MaxTokens`;
  const configured = config.get<number>(key);
  if (!configured || configured < 1000) {
    return defaultBudget;
  }

  return Math.floor(configured);
}

function estimateTokensHeuristic(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  const wordLike = normalized.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(wordLike * 0.75));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}
