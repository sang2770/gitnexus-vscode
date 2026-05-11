import * as vscode from 'vscode';
import {
  ensureCodeBrainCliInstalled,
  resolveNodeVersion,
} from '../process/cli-runner.js';

export interface PrerequisiteStatus {
  node: string | null;
  npm: string | null;
  codebrain: string | null;
  ready: boolean;
}

export function checkPrerequisites(): PrerequisiteStatus {
  const node = resolveNodeVersion();
  return {
    node,
    npm: null,
    codebrain: null,
    ready: !!node,
  };
}

/**
 * Ensure gitnexus CLI is available, offering to install if missing.
 * Returns true if CLI is available (pre-existing or just installed).
 */
export async function ensureCodeBrainCli(token?: vscode.CancellationToken): Promise<boolean> {
  const status = checkPrerequisites();

  // Node not installed at all — nothing we can do
  if (!status.node) {
    vscode.window.showErrorMessage(
      'CodeBrain: Node.js is not installed. Please install Node.js ≥20 and try again.',
      'Get Node.js',
    ).then((choice) => {
      if (choice === 'Get Node.js') {
        vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org'));
      }
    });
    return false;
  }

  return ensureCodeBrainCliInstalled(token);
}
