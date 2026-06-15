import { execFileSync } from 'child_process';

const DEFAULT_GIT_TIMEOUT_MS = 10000;

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

export function hasWorkingTreeDiff(cwd: string): boolean {
  return getWorkingTreeChangedFiles(cwd, 1).length > 0;
}

function getGitDiffFiles(cwd: string, args: string[], maxFiles: number): string[] {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: DEFAULT_GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, maxFiles);
  } catch {
    return [];
  }
}

function uniqueLimited(values: string[], maxFiles: number): string[] {
  return Array.from(new Set(values)).slice(0, maxFiles);
}
