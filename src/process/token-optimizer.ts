import * as vscode from 'vscode';
import { encoding_for_model, get_encoding, type Tiktoken, type TiktokenModel } from '@dqbd/tiktoken';
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

let defaultEncoder: Tiktoken | undefined;
let defaultEncoderFailed = false;
const modelEncoders = new Map<string, Tiktoken>();
const failedModelEncoders = new Set<string>();

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

export function estimateTokens(
  text: string,
  modelId?: string,
): { tokens: number; estimator: TokenEstimatorKind } {
  return estimateTokensForModel(text, modelId);
}

export function createTokenReductionReport(input: {
  beforeText: string;
  afterText: string;
  defaultMode: ContextMode;
  source: string;
  filesScanned?: number;
  selectedFiles?: string[];
  modelId?: string;
}): TokenReductionReport {
  const settings = getTokenOptimizationSettings(input.defaultMode);
  const before = estimateTokensForModel(input.beforeText, input.modelId);
  const after = settings.enabled
    ? estimateTokensForModel(input.afterText, input.modelId)
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
  const mode = `${report.configuredMode}${report.configuredMode === 'auto' ? ` -> ${report.effectiveMode}` : ''}`;
  const promptReduction = `${formatNumber(report.beforeTokens)} -> ${formatNumber(report.afterTokens)} tokens (${report.reductionPercent}% saved)`;
  const selectedFiles = report.selectedFiles?.length
    ? report.selectedFiles.slice(0, 6).map((file) => `- ${file}`).join('\n')
    : undefined;
  const lines = [
    'Token Reduction:',
    `- Mode: ${mode}`,
    `- Enabled: ${report.enabled ? 'yes' : 'no'}`,
    `- Budget: ${formatNumber(report.tokenBudget)} tokens`,
    `- Prompt: ${promptReduction}`,
    `- Files scanned: ${report.filesScanned === undefined ? 'Unknown' : formatNumber(report.filesScanned)}`,
    `- Files selected: ${report.filesSelected === undefined ? 'Unknown' : formatNumber(report.filesSelected)}`,
  ];

  if (selectedFiles) {
    lines.push('Selected files:', selectedFiles);
  }

  return lines.join('\n');
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

function estimateTokensForModel(
  text: string,
  modelId?: string,
): { tokens: number; estimator: TokenEstimatorKind } {
  const encoder = getTokenEncoder(modelId);
  if (!text) {
    return {
      tokens: 0,
      estimator: encoder ? 'tiktoken' : 'heuristic',
    };
  }

  if (encoder) {
    return {
      tokens: encoder.encode(text).length,
      estimator: 'tiktoken',
    };
  }

  return {
    tokens: estimateTokensHeuristic(text),
    estimator: 'heuristic',
  };
}

function getTokenEncoder(modelId?: string): Tiktoken | undefined {
  const trimmedModelId = modelId?.trim();
  if (trimmedModelId && !failedModelEncoders.has(trimmedModelId)) {
    const cachedModelEncoder = modelEncoders.get(trimmedModelId);
    if (cachedModelEncoder) {
      return cachedModelEncoder;
    }

    try {
      const modelEncoder = encoding_for_model(trimmedModelId as TiktokenModel);
      modelEncoders.set(trimmedModelId, modelEncoder);
      return modelEncoder;
    } catch {
      failedModelEncoders.add(trimmedModelId);
    }
  }

  if (!defaultEncoderFailed) {
    try {
      defaultEncoder ??= get_encoding('o200k_base');
      return defaultEncoder;
    } catch {
      defaultEncoderFailed = true;
    }
  }

  return undefined;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}
