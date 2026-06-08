import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import {
  getOutputChannel,
  getWorkspaceRoot,
  runCodeBrain,
} from '../process/cli-runner.js';

export interface AnalyzeOptions {
  force?: boolean;
  path?: string;
}

interface TreeCommandNode {
  meta?: Record<string, string>;
}

function isCodeGraphInitialized(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, '.codegraph', 'codegraph.db'));
}

function buildAnalyzeArgs(targetPath: string, opts: AnalyzeOptions): string[] {
  if (opts.force) {
    return ['index', targetPath, '--force'];
  }

  if (!isCodeGraphInitialized(targetPath)) {
    return ['init', targetPath];
  }

  return ['sync', targetPath];
}

async function resolveTargetPath(opts: AnalyzeOptions = {}): Promise<string | undefined> {
  if (opts.path) {
    return opts.path;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 1) {
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
      })),
      { placeHolder: 'Select workspace folder to index with CodeGraph' },
    );
    return picked?.description;
  }

  return getWorkspaceRoot();
}

export async function analyzeCommand(
  opts: AnalyzeOptions = {},
): Promise<boolean> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return false;
  }

  const targetPath = await resolveTargetPath(opts);
  if (!targetPath) {
    return false;
  }

  const channel = getOutputChannel();
  channel.show(true);

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: isCodeGraphInitialized(targetPath)
        ? opts.force
          ? 'CodeBrain: Re-indexing with CodeGraph...'
          : 'CodeBrain: Syncing CodeGraph index...'
        : 'CodeBrain: Initializing CodeGraph index...',
      cancellable: true,
    },
    async (_progress, token) => {
      const result = await runCodeBrain(buildAnalyzeArgs(targetPath, opts), {
        cwd: targetPath,
        stream: true,
        token,
      });

      if (token.isCancellationRequested) {
        vscode.window.showWarningMessage('CodeBrain: CodeGraph indexing cancelled.');
        return false;
      }

      if (result.exitCode !== 0) {
        vscode.window
          .showErrorMessage(
            `CodeBrain: CodeGraph indexing failed for ${targetPath}. Check the Output panel for details.`,
            'Show Output',
          )
          .then((choice) => choice === 'Show Output' && channel.show());
        return false;
      }

      vscode.window.showInformationMessage('CodeBrain: CodeGraph index is ready.');
      return true;
    },
  );
}

export async function analyzeTreeItemCommand(
  node: string | TreeCommandNode | undefined,
): Promise<boolean> {
  if (typeof node === 'object' && node?.meta?.path) {
    return analyzeCommand({ path: node.meta.path });
  }

  return analyzeCommand();
}
