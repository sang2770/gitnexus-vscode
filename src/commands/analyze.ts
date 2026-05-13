import * as vscode from 'vscode';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import { runCodeBrain, getOutputChannel, getWorkspaceRoot } from '../process/cli-runner.js';
import {
  getActiveContext,
  getActiveRepoPath,
  getGroupDetails,
  listIndexedRepos,
} from '../process/group-context.js';

export interface AnalyzeOptions {
  force?: boolean;
  embeddings?: boolean;
  skipAgentsMd?: boolean;
  verbose?: boolean;
  path?: string;
  groupName?: string;
}

interface TreeCommandNode {
  meta?: Record<string, string>;
}

interface AnalyzeTarget {
  path: string;
  label: string;
}

function buildAnalyzeArgs(
  targetPath: string,
  opts: AnalyzeOptions,
  config: vscode.WorkspaceConfiguration,
): string[] {
  const args: string[] = ['analyze', targetPath, '--ide', 'vscode'];
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
  return args;
}

async function resolveAnalyzeTargets(
  opts: AnalyzeOptions,
  context?: vscode.ExtensionContext,
): Promise<AnalyzeTarget[]> {
  if (opts.path) {
    return [{ path: opts.path, label: opts.path }];
  }

  if (opts.groupName) {
    const group = await getGroupDetails(opts.groupName);
    if (!group) {
      vscode.window.showErrorMessage(`GitNexus: Group "${opts.groupName}" not found.`);
      return [];
    }

    const repos = await listIndexedRepos();
    const targets = Object.values(group.repos)
      .map((registryName) => {
        const repo = repos.find((r) => r.name === registryName);
        return repo ? { path: repo.path, label: repo.name } : undefined;
      })
      .filter((target): target is AnalyzeTarget => !!target);

    if (targets.length === 0) {
      vscode.window.showWarningMessage(
        `GitNexus: Group "${opts.groupName}" has no indexed repositories in this workspace.`,
      );
    }

    return targets;
  }

  const workspaceRoot = getWorkspaceRoot();
  const activeRepoPath = context ? await getActiveRepoPath(context.globalState) : undefined;
  const activeContext = context ? getActiveContext(context.globalState) : undefined;

  if (!activeRepoPath && activeContext?.type === 'group') {
    return resolveAnalyzeTargets({ ...opts, groupName: activeContext.name }, context);
  }

  let targetPath = activeRepoPath ?? workspaceRoot;
  if (!activeRepoPath) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 1) {
      const items = folders.map((f) => ({ label: f.name, description: f.uri.fsPath }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select workspace folder to analyze',
      });
      if (!picked) {
        return [];
      }
      targetPath = picked.description!;
    }
  }

  return [{ path: targetPath, label: targetPath }];
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

  const targets = await resolveAnalyzeTargets(opts, context);
  if (targets.length === 0) {
    return false;
  }

  const totalTargets = targets.length;

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: totalTargets > 1 ? `CodeBrain: Analyzing ${totalTargets} repositories...` : 'CodeBrain: Analyzing...',
      cancellable: true,
    },
    async (progress, token) => {
      for (let i = 0; i < totalTargets; i += 1) {
        const target = targets[i];
        progress.report({
          message: `(${i + 1}/${totalTargets}) ${target.label}`,
          increment: i === 0 ? 0 : 100 / totalTargets,
        });

        const result = await runCodeBrain(buildAnalyzeArgs(target.path, opts, config), {
          cwd: target.path,
          stream: true,
          token,
        });
        if (token.isCancellationRequested) {
          vscode.window.showWarningMessage('GitNexus: Analyze cancelled.');
          return false;
        }
        if (result.exitCode !== 0) {
          vscode.window
            .showErrorMessage(
              `GitNexus: Analyze failed for ${target.label}. Check the Output panel for details.`,
              'Show Output',
            )
            .then((c) => c === 'Show Output' && channel.show());
          return false;
        }
      }

      if (totalTargets > 1) {
        vscode.window.showInformationMessage(`GitNexus: Indexed ${totalTargets} repositories successfully.`);
      } else {
        vscode.window.showInformationMessage('GitNexus: Repository indexed successfully.');
      }
      return true;
    },
  );
}

export async function analyzeTreeItemCommand(
  node: string | TreeCommandNode | undefined,
  context?: vscode.ExtensionContext,
): Promise<boolean> {
  if (!node) {
    return analyzeCommand({}, context);
  }

  if (typeof node === 'string') {
    return analyzeCommand({ groupName: node }, context);
  }

  const meta = node.meta ?? {};
  if (meta.groupName && meta.registryName) {
    const repos = await listIndexedRepos();
    const repo = repos.find((r) => r.name === meta.registryName);
    if (!repo) {
      vscode.window.showWarningMessage(
        `GitNexus: Repository "${meta.registryName}" is not indexed in this workspace.`,
      );
      return false;
    }
    return analyzeCommand({ path: repo.path }, context);
  }

  if (meta.name) {
    const repos = await listIndexedRepos();
    const repo = repos.find((r) => r.name === meta.name);
    if (repo) {
      return analyzeCommand({ path: repo.path }, context);
    }

    const group = await getGroupDetails(meta.name);
    if (group) {
      return analyzeCommand({ groupName: group.name }, context);
    }
  }

  return analyzeCommand({}, context);
}

export async function analyzeForceCommand(): Promise<boolean> {
  return analyzeCommand({ force: true });
}

export async function analyzeWithEmbeddingsCommand(): Promise<boolean> {
  return analyzeCommand({ embeddings: true });
}
