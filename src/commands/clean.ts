import * as vscode from 'vscode';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import { getOutputChannel, getWorkspaceRoot, runCodeBrain } from '../process/cli-runner.js';
import { showStatusReport } from '../ui/report-panel.js';

interface CodeGraphStatusJson {
  initialized?: boolean;
  projectPath?: string;
  lastIndexed?: string | null;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  pendingChanges?: {
    added?: number;
    modified?: number;
    removed?: number;
  };
}

export async function cleanCommand(): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    'CodeBrain: Delete the CodeGraph index for the current workspace?',
    { modal: true },
    'Delete',
    'Cancel',
  );
  if (confirmed !== 'Delete') {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CodeBrain: Removing CodeGraph index...',
      cancellable: false,
    },
    async () => {
      const result = await runCodeBrain(['uninit', getWorkspaceRoot(), '--force'], {
        cwd: getWorkspaceRoot(),
      });
      if (result.exitCode === 0) {
        vscode.window.showInformationMessage('CodeBrain: CodeGraph index deleted.');
      } else {
        vscode.window.showErrorMessage('CodeBrain: Clean failed. Check Output panel.');
      }
    },
  );
}

export async function statusCommand(): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const channel = getOutputChannel();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CodeBrain: Checking CodeGraph status...',
      cancellable: false,
    },
    async () => {
      const workspaceRoot = getWorkspaceRoot();
      const result = await runCodeBrain(['status', workspaceRoot, '--json'], {
        cwd: workspaceRoot,
        stream: false,
      });

      if (result.exitCode !== 0) {
        vscode.window.showErrorMessage('CodeBrain: Failed to read CodeGraph status. Check Output panel.');
        return;
      }

      try {
        const parsed = JSON.parse(result.stdout) as CodeGraphStatusJson;
        const status = deriveStatus(parsed);
        channel.appendLine(result.stdout.trim());
        showStatusReport(parsed, result.stdout);
        vscode.window.showInformationMessage(formatStatusMessage(status, parsed));
      } catch {
        channel.appendLine(result.stdout.trim());
        vscode.window.showWarningMessage('CodeBrain: CodeGraph status returned non-JSON output. Check Output panel.');
      }
    },
  );
}

type DerivedStatus = 'fresh' | 'stale' | 'not-indexed';

function deriveStatus(status: CodeGraphStatusJson): DerivedStatus {
  if (!status.initialized) {
    return 'not-indexed';
  }

  const pending = status.pendingChanges;
  const pendingTotal =
    (pending?.added ?? 0) +
    (pending?.modified ?? 0) +
    (pending?.removed ?? 0);

  return pendingTotal > 0 ? 'stale' : 'fresh';
}

function formatStatusMessage(status: DerivedStatus, parsed: CodeGraphStatusJson): string {
  if (status === 'not-indexed') {
    return 'CodeBrain: CodeGraph status is not-indexed.';
  }

  const pending = parsed.pendingChanges;
  const pendingTotal =
    (pending?.added ?? 0) +
    (pending?.modified ?? 0) +
    (pending?.removed ?? 0);
  const stats = [
    parsed.fileCount !== undefined ? `${parsed.fileCount} files` : undefined,
    parsed.nodeCount !== undefined ? `${parsed.nodeCount} nodes` : undefined,
    parsed.edgeCount !== undefined ? `${parsed.edgeCount} edges` : undefined,
  ].filter(Boolean).join(', ');
  const suffix = stats ? ` (${stats})` : '';

  return status === 'stale'
    ? `CodeBrain: CodeGraph status is stale (${pendingTotal} pending changes).`
    : `CodeBrain: CodeGraph status is fresh${suffix}.`;
}
