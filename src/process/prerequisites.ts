import * as vscode from 'vscode';
import {
  resolveBundledGitnexusCliPath,
  resolveLocalGitnexusCliPath,
  resolveNodeVersion,
} from '../process/cli-runner.js';

export interface PrerequisiteStatus {
  node: string | null;
  npm: string | null;
  gitnexus: string | null;
  ready: boolean;
}

export function checkPrerequisites(): PrerequisiteStatus {
  const node = resolveNodeVersion();
  const gitnexus = resolveBundledGitnexusCliPath() ?? resolveLocalGitnexusCliPath();
  return {
    node,
    npm: null,
    gitnexus,
    ready: !!node && !!gitnexus,
  };
}

/**
 * Ensure gitnexus CLI is available, offering to install if missing.
 * Returns true if CLI is available (pre-existing or just installed).
 */
export async function ensureGitnexusCli(): Promise<boolean> {
  const status = checkPrerequisites();

  if (status.gitnexus) {
    return true;
  }

  // Node not installed at all — nothing we can do
  if (!status.node) {
    vscode.window.showErrorMessage(
      'GitNexus: Node.js is not installed. Please install Node.js ≥20 and try again.',
      'Get Node.js',
    ).then((choice) => {
      if (choice === 'Get Node.js') {
        vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org'));
      }
    });
    return false;
  }

  // CLI not found, but will be installed lazily on first use
  vscode.window.showInformationMessage(
    'GitNexus will install dependencies on first use. This may take a moment.',
  );
  return true;
}
