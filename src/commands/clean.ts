import * as vscode from 'vscode';
import { ensureGitnexusCli } from '../process/prerequisites.js';
import { runGitnexus, getOutputChannel, getWorkspaceRoot } from '../process/cli-runner.js';

export async function cleanCommand(): Promise<void> {
  const ok = await ensureGitnexusCli();
  if (!ok) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    'GitNexus: Delete the index for the current workspace?',
    { modal: true },
    'Delete',
    'Cancel',
  );
  if (confirmed !== 'Delete') {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);

  const result = await runGitnexus(['clean', '--force'], { cwd: getWorkspaceRoot() });
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage('GitNexus: Index deleted.');
  } else {
    vscode.window.showErrorMessage('GitNexus: Clean failed. Check Output panel.');
  }
}

export async function cleanAllCommand(): Promise<void> {
  const ok = await ensureGitnexusCli();
  if (!ok) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    'GitNexus: Delete ALL indexed repositories? This cannot be undone.',
    { modal: true },
    'Delete All',
    'Cancel',
  );
  if (confirmed !== 'Delete All') {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);
  const result = await runGitnexus(['clean', '--all', '--force'], { cwd: getWorkspaceRoot() });
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage('GitNexus: All indexes deleted.');
  } else {
    vscode.window.showErrorMessage('GitNexus: Clean failed. Check Output panel.');
  }
}

export async function statusCommand(): Promise<void> {
  const ok = await ensureGitnexusCli();
  if (!ok) {
    return;
  }
  const channel = getOutputChannel();
  channel.show(true);
  await runGitnexus(['status'], { cwd: getWorkspaceRoot() });
}

export async function listReposCommand(): Promise<void> {
  const ok = await ensureGitnexusCli();
  if (!ok) {
    return;
  }
  const channel = getOutputChannel();
  channel.show(true);
  await runGitnexus(['list'], { cwd: getWorkspaceRoot() });
}
