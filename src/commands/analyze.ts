import * as vscode from 'vscode';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import { runCodeBrain, getOutputChannel, getWorkspaceRoot } from '../process/cli-runner.js';
import { getActiveRepoPath } from '../process/group-context.js';

export interface AnalyzeOptions {
  force?: boolean;
  embeddings?: boolean;
  skipAgentsMd?: boolean;
  verbose?: boolean;
  path?: string;
}

export async function analyzeCommand(
  opts: AnalyzeOptions = {},
  context?: vscode.ExtensionContext,
): Promise<boolean> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return false;
  }

  const config = vscode.workspace.getConfiguration('codebrain');
  const channel = getOutputChannel();
  channel.show(true);

  const workspaceRoot = getWorkspaceRoot();
  const activeRepoPath = context ? await getActiveRepoPath(context.globalState) : undefined;

  // Choose target path: allow user to pick if not specified
  let targetPath = opts.path ?? activeRepoPath ?? workspaceRoot;
  if (!opts.path && !activeRepoPath) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 1) {
      const items = folders.map((f) => ({ label: f.name, description: f.uri.fsPath }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select workspace folder to analyze',
      });
      if (!picked) {
        return false;
      }
      targetPath = picked.description!;
    }
  }

  // Build args
  const args: string[] = ['analyze', targetPath];
  args.push('--ide', 'vscode');
  if (opts.force) {
    args.push('--force');
  }
  const useEmbeddings = opts.embeddings ?? config.get<boolean>('analyze.embeddings', false);
  if (useEmbeddings) {
    args.push('--embeddings');
  }
  if (opts.skipAgentsMd) {
    args.push('--skip-agents-md');
  }
  if (opts.verbose) {
    args.push('--verbose');
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CodeBrain: Analyzing...',
      cancellable: true,
    },
    async (_progress, token) => {
      const result = await runCodeBrain(args, { cwd: targetPath, stream: true, token });
      if (token.isCancellationRequested) {
        vscode.window.showWarningMessage('GitNexus: Analyze cancelled.');
        return false;
      }
      if (result.exitCode !== 0) {
        vscode.window.showErrorMessage(
          'GitNexus: Analyze failed. Check the Output panel for details.',
          'Show Output',
        ).then((c) => c === 'Show Output' && channel.show());
        return false;
      }
      vscode.window.showInformationMessage('GitNexus: Repository indexed successfully.');
      return true;
    },
  );
}

export async function analyzeForceCommand(): Promise<boolean> {
  return analyzeCommand({ force: true });
}

export async function analyzeWithEmbeddingsCommand(): Promise<boolean> {
  return analyzeCommand({ embeddings: true });
}
