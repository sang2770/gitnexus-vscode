import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { encoding_for_model, type Tiktoken } from 'tiktoken';

export interface ContextAnalysisReport {
  repositoryFiles: number;
  scannedFiles: number;
  selectedFiles: number;

  rawCharacters: number;
  optimizedCharacters: number;

  rawTokens: number;
  optimizedTokens: number;

  reductionPercent: number;
}

export interface ContextAnalysisInput {
  workspaceRoot: string;
  optimizedContext: string;
  selectedFiles?: string[];
  scannedFiles?: number;
  repositoryFiles?: number;
  rawContext?: string;
  rawFileLimit?: number;
}

interface RawContextResult {
  context: string;
  filesRead: number;
}

const DEFAULT_RAW_FILE_LIMIT = 250;
const MAX_REPOSITORY_FILES = 20000;
const MAX_FILE_BYTES = 512 * 1024;
const CONTEXT_REPORT_SEPARATOR = '\u2501'.repeat(19);

const REPOSITORY_EXCLUDE_GLOB = [
  '**/.git/**',
  '**/.codegraph/**',
  '**/node_modules/**',
  '**/out/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.vscode-test/**',
  '**/*.vsix',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.webp',
  '**/*.ico',
  '**/*.pdf',
  '**/*.zip',
  '**/*.gz',
  '**/*.7z',
  '**/*.dll',
  '**/*.exe',
].join(',');

const TEXT_EXTENSIONS = new Set([
  '',
  '.bat',
  '.c',
  '.cc',
  '.cmd',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.cts',
  '.env',
  '.go',
  '.h',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.less',
  '.mjs',
  '.mts',
  '.php',
  '.ps1',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
]);

let encoder: Tiktoken | undefined;

export function estimateTokens(text: string): number {
  if (!text.trim()) {
    return 0;
  }

  encoder ??= encoding_for_model('gpt-4');
  return encoder.encode(text).length;
}

export function isContextReportEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>('codebrain.showContextReport', false);
}

export function extractContextFilesFromText(text: string): string[] {
  const files = new Set<string>();
  const headingPattern = /^#{2,6}\s+(.+?)\s+(?:[-\u2013\u2014]|$)/gmu;
  const filePathPattern = /["']filePath["']\s*:\s*["']([^"']+)["']/giu;
  const fileLikePattern = /(?:^|[\s"'`(])((?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])?(?:[\w@.+ -]+[\\/])*[\w@.+ -]+\.(?:bat|c|cc|cmd|cpp|cs|css|csv|go|h|html|ini|java|js|json|jsx|less|md|mjs|mts|php|ps1|py|rb|rs|scss|sh|sql|svelte|toml|ts|tsx|txt|vue|xml|ya?ml))(?:[:#]\d+)?/giu;

  for (const match of text.matchAll(headingPattern)) {
    addCandidate(files, match[1]);
  }

  for (const match of text.matchAll(filePathPattern)) {
    addCandidate(files, match[1]);
  }

  for (const match of text.matchAll(fileLikePattern)) {
    addCandidate(files, match[1]);
  }

  return Array.from(files).sort();
}

export function formatContextAnalysisMarkdown(report: ContextAnalysisReport): string {
  return [
    CONTEXT_REPORT_SEPARATOR,
    '',
    'Context Optimization Report',
    '',
    `Repository Files: ${formatNumber(report.repositoryFiles)}`,
    `Files Scanned: ${formatNumber(report.scannedFiles)}`,
    `Files Selected: ${formatNumber(report.selectedFiles)}`,
    '',
    'Raw Context:',
    `${formatNumber(report.rawTokens)} tokens`,
    '',
    'Optimized Context:',
    `${formatNumber(report.optimizedTokens)} tokens`,
    '',
    'Reduction:',
    `${formatPercent(report.reductionPercent)}`,
    '',
    `Estimated Cost Saving: Up to ${formatPercent(Math.max(0, report.reductionPercent))}`,
    '',
    CONTEXT_REPORT_SEPARATOR,
  ].join('\n');
}

export class ContextAnalysisService {
  async generateReport(input: ContextAnalysisInput): Promise<ContextAnalysisReport> {
    const workspaceRoot = path.resolve(input.workspaceRoot);
    const repositoryFiles = await this.collectRepositoryFiles(workspaceRoot);
    const normalizedSelectedFiles = normalizeSelectedFiles(input.selectedFiles ?? [], workspaceRoot);
    const raw = input.rawContext !== undefined
      ? { context: input.rawContext, filesRead: input.scannedFiles ?? normalizedSelectedFiles.length }
      : await this.buildRawContext({
          workspaceRoot,
          repositoryFiles,
          selectedFiles: normalizedSelectedFiles,
          rawFileLimit: input.rawFileLimit,
        });
    const optimizedContext = input.optimizedContext.trim();
    const rawTokens = estimateTokens(raw.context);
    const optimizedTokens = estimateTokens(optimizedContext);

    return {
      repositoryFiles: input.repositoryFiles ?? repositoryFiles.length,
      scannedFiles: input.scannedFiles ?? raw.filesRead,
      selectedFiles: normalizedSelectedFiles.length,
      rawCharacters: raw.context.length,
      optimizedCharacters: optimizedContext.length,
      rawTokens,
      optimizedTokens,
      reductionPercent: calculateReductionPercent(rawTokens, optimizedTokens),
    };
  }

  private async collectRepositoryFiles(workspaceRoot: string): Promise<string[]> {
    const uris = await vscode.workspace.findFiles(
      '**/*',
      `{${REPOSITORY_EXCLUDE_GLOB}}`,
      MAX_REPOSITORY_FILES,
    );

    return uris
      .map((uri) => uri.fsPath)
      .filter((filePath) => isInsidePath(workspaceRoot, filePath))
      .filter(isTextContextFile)
      .sort((a, b) => toWorkspaceRelativePath(workspaceRoot, a).localeCompare(toWorkspaceRelativePath(workspaceRoot, b)));
  }

  private async buildRawContext(input: {
    workspaceRoot: string;
    repositoryFiles: string[];
    selectedFiles: string[];
    rawFileLimit?: number;
  }): Promise<RawContextResult> {
    const limit = Math.max(1, Math.floor(input.rawFileLimit ?? DEFAULT_RAW_FILE_LIMIT));
    const candidates = rankRawCandidates(input.repositoryFiles, input.selectedFiles, input.workspaceRoot).slice(0, limit);
    const parts: string[] = [];

    for (const filePath of candidates) {
      const content = await readTextFile(filePath);
      if (content === undefined) {
        continue;
      }

      const relativePath = toWorkspaceRelativePath(input.workspaceRoot, filePath);
      parts.push([`// File: ${relativePath}`, content].join('\n'));
    }

    return {
      context: parts.join('\n\n'),
      filesRead: parts.length,
    };
  }
}

function addCandidate(files: Set<string>, value: string | undefined): void {
  const candidate = cleanupCandidate(value);
  if (candidate) {
    files.add(candidate);
  }
}

function cleanupCandidate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed
    .replace(/^["'`(]+/u, '')
    .replace(/[)"'`,.;]+$/u, '')
    .replace(/:(\d+)(?::\d+)?$/u, '')
    .replace(/\\/gu, '/');
}

function normalizeSelectedFiles(files: string[], workspaceRoot: string): string[] {
  const normalized = new Set<string>();

  for (const file of files) {
    const cleaned = cleanupCandidate(file);
    if (!cleaned) {
      continue;
    }

    const absolutePath = path.isAbsolute(cleaned)
      ? path.resolve(cleaned)
      : path.resolve(workspaceRoot, cleaned);

    if (!isInsidePath(workspaceRoot, absolutePath) || !isTextContextFile(absolutePath)) {
      continue;
    }

    normalized.add(toWorkspaceRelativePath(workspaceRoot, absolutePath));
  }

  return Array.from(normalized).sort();
}

function rankRawCandidates(repositoryFiles: string[], selectedFiles: string[], workspaceRoot: string): string[] {
  const selectedSet = new Set(selectedFiles);
  const selectedDirs = new Set(selectedFiles.map((file) => path.posix.dirname(file)));

  return repositoryFiles
    .map((filePath) => {
      const relativePath = toWorkspaceRelativePath(workspaceRoot, filePath);
      return {
        filePath,
        relativePath,
        rank: rankFile(relativePath, selectedSet, selectedDirs),
      };
    })
    .sort((left, right) => left.rank - right.rank || left.relativePath.localeCompare(right.relativePath))
    .map((entry) => entry.filePath);
}

function rankFile(relativePath: string, selectedSet: Set<string>, selectedDirs: Set<string>): number {
  if (selectedSet.has(relativePath)) {
    return 0;
  }

  const dir = path.posix.dirname(relativePath);
  if (selectedDirs.has(dir)) {
    return 1;
  }

  for (const selectedDir of selectedDirs) {
    if (selectedDir !== '.' && relativePath.startsWith(`${selectedDir}/`)) {
      return 2;
    }
  }

  return 3;
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return undefined;
    }

    const buffer = await fs.readFile(filePath);
    if (buffer.includes(0)) {
      return undefined;
    }

    return buffer.toString('utf8');
  } catch {
    return undefined;
  }
}

function isTextContextFile(filePath: string): boolean {
  if (LOCKFILE_NAMES.has(path.basename(filePath).toLowerCase())) {
    return false;
  }

  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isInsidePath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function toWorkspaceRelativePath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/gu, '/');
}

function calculateReductionPercent(rawTokens: number, optimizedTokens: number): number {
  if (rawTokens <= 0) {
    return 0;
  }

  return Math.round(((rawTokens - optimizedTokens) / rawTokens) * 1000) / 10;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}
