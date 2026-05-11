import * as vscode from 'vscode';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import { runCodeBrain, getOutputChannel, getWorkspaceRoot } from '../process/cli-runner.js';
import { getActiveRepoPath } from '../process/group-context.js';

export async function cleanCommand(): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    'CodeBrain: Delete the index for the current workspace?',
    { modal: true },
    'Delete',
    'Cancel',
  );
  if (confirmed !== 'Delete') {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CodeBrain: Cleaning index...', cancellable: false },
    async () => {
      const result = await runCodeBrain(['clean', '--force'], { cwd: getWorkspaceRoot() });
      if (result.exitCode === 0) {
        vscode.window.showInformationMessage('CodeBrain: Index deleted.');
      } else {
        vscode.window.showErrorMessage('CodeBrain: Clean failed. Check Output panel.');
      }
    },
  );
}

export async function cleanAllCommand(): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    'CodeBrain: Delete ALL indexed repositories? This cannot be undone.',
    { modal: true },
    'Delete All',
    'Cancel',
  );
  if (confirmed !== 'Delete All') {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CodeBrain: Cleaning all indexes...', cancellable: false },
    async () => {
      const result = await runCodeBrain(['clean', '--all', '--force'], { cwd: getWorkspaceRoot() });
      if (result.exitCode === 0) {
        vscode.window.showInformationMessage('CodeBrain: All indexes deleted.');
      } else {
        vscode.window.showErrorMessage('CodeBrain: Clean failed. Check Output panel.');
      }
    },
  );
}

export async function statusCommand(context?: vscode.ExtensionContext): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }
  const channel = getOutputChannel();
  channel.show(true);

  const cwd = context ? (await getActiveRepoPath(context.globalState)) ?? getWorkspaceRoot() : getWorkspaceRoot();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CodeBrain: Checking status...', cancellable: false },
    async () => {
      await runCodeBrain(['status'], { cwd });
    },
  );
}

export async function listReposCommand(): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }
  const channel = getOutputChannel();
  channel.show(true);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CodeBrain: Listing repositories...', cancellable: false },
    async () => {
      await runCodeBrain(['list'], { cwd: getWorkspaceRoot() });
    },
  );
}
