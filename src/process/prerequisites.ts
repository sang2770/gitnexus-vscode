import * as vscode from 'vscode';
import {
  resolveGitnexusBin,
  resolveLocalGitnexusCliPath,
  resolveNpmBin,
  resolveNodeVersion,
  installGitnexusCli,
} from '../process/cli-runner.js';

export interface PrerequisiteStatus {
  node: string | null;
  npm: string | null;
  gitnexus: string | null;
  ready: boolean;
}

export function checkPrerequisites(): PrerequisiteStatus {
  const node = resolveNodeVersion();
  const npm = resolveNpmBin();
  const gitnexus = resolveLocalGitnexusCliPath() ?? resolveGitnexusBin();
  return {
    node,
    npm,
    gitnexus,
    ready: !!node && !!(gitnexus || npm),
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

  if (!status.npm) {
    // Can still run via npx, warn the user
    const choice = await vscode.window.showWarningMessage(
      'GitNexus CLI not found globally, but npx is available — commands will use npx (slower cold start).',
      'Install Globally',
      'Continue with npx',
    );
    if (choice === 'Install Globally') {
      return installWithProgress();
    }
    return true; // allow npx fallback
  }

  // npm available, gitnexus not installed
  const choice = await vscode.window.showWarningMessage(
    'GitNexus CLI is not installed. Install it globally now?',
    { modal: false },
    'Install',
    'Use npx (slower)',
    'Cancel',
  );

  if (choice === 'Install') {
    return installWithProgress();
  }
  if (choice === 'Use npx (slower)') {
    return true;
  }
  return false;
}

async function installWithProgress(): Promise<boolean> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'GitNexus: Installing CLI globally…',
      cancellable: true,
    },
    async (_progress, token) => {
      const ok = await installGitnexusCli(token);
      if (ok) {
        vscode.window.showInformationMessage('GitNexus CLI installed — ready to use.');
      } else {
        vscode.window.showErrorMessage(
          'GitNexus CLI installation failed. Check the Output panel (GitNexus) for details.',
          'Show Output',
        ).then((choice) => {
          if (choice === 'Show Output') {
            const { getOutputChannel } = require('../process/cli-runner.js');
            getOutputChannel().show();
          }
        });
      }
      return ok;
    },
  );
}
