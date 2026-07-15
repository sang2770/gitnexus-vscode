import { execFileSync } from 'child_process';

const DEFAULT_GIT_TIMEOUT_MS = 10000;
const DEFAULT_CHANGE_CONTEXT_PREVIEW_CHARS = 5000;

export interface WorkingTreeChangeContext {
  changedFiles: string[];
  diffStat: string;
  diffPreview: string;
}

export function isInsideGitWorkTree(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf-8',
      timeout: DEFAULT_GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

export function getWorkingTreeChangedFiles(cwd: string, maxFiles = 200): string[] {
  return uniqueLimited(
    [
      ...getGitDiffFiles(cwd, ['diff', '--name-only', 'HEAD'], maxFiles),
      ...getGitDiffFiles(cwd, ['ls-files', '--others', '--exclude-standard'], maxFiles),
    ],
    maxFiles,
  );
}

export function getStagedChangedFiles(cwd: string, maxFiles = 200): string[] {
  return getGitDiffFiles(cwd, ['diff', '--name-only', '--cached'], maxFiles);
}

export function getCompareChangedFiles(cwd: string, baseRef: string, maxFiles = 200): string[] {
  return getGitDiffFiles(cwd, ['diff', '--name-only', `${baseRef}...HEAD`], maxFiles);
}

export function getCommitChangedFiles(cwd: string, ref: string, maxFiles = 200): string[] {
  return getGitDiffFiles(cwd, ['show', '--format=', '--name-only', ref], maxFiles);
}

export function getRangeChangedFiles(cwd: string, range: string, maxFiles = 200): string[] {
  return getGitDiffFiles(cwd, ['diff', '--name-only', range], maxFiles);
}

export function hasWorkingTreeDiff(cwd: string): boolean {
  return getWorkingTreeChangedFiles(cwd, 1).length > 0;
}

export function getWorkingTreeChangeContext(
  cwd: string,
  options?: {
    maxFiles?: number;
    previewChars?: number;
  },
): WorkingTreeChangeContext {
  const maxFiles = options?.maxFiles ?? 40;
  const previewChars = options?.previewChars ?? DEFAULT_CHANGE_CONTEXT_PREVIEW_CHARS;
  const changedFiles = getWorkingTreeChangedFiles(cwd, maxFiles);
  const diffStat = getGitOutput(cwd, ['diff', '--stat', 'HEAD']);
  const diffPreview = truncateText(getGitOutput(cwd, ['diff', '--unified=3', 'HEAD']), previewChars);

  return {
    changedFiles,
    diffStat,
    diffPreview,
  };
}

function getGitDiffFiles(cwd: string, args: string[], maxFiles: number): string[] {
  try {
    const out = getGitOutput(cwd, args);

    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, maxFiles);
  } catch {
    return [];
  }
}

function getGitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: DEFAULT_GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function truncateText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

function uniqueLimited(values: string[], maxFiles: number): string[] {
  return Array.from(new Set(values)).slice(0, maxFiles);
}
