import * as vscode from "vscode";
import { setupCommand, installCliCommand } from "./commands/setup.js";
import {
  analyzeCommand,
  analyzeForceCommand,
  analyzeWithEmbeddingsCommand,
} from "./commands/analyze.js";
import {
  cleanCommand,
  cleanAllCommand,
  statusCommand,
  listReposCommand,
} from "./commands/clean.js";
import {
  selectRepoCommand,
  selectGroupCommand,
  repoMenuCommand,
  createGroupCommand,
  syncGroupCommand,
  clearActivationCommand,
  showActiveContextCommand,
  addRepoToGroupCommand,
  removeRepoFromGroupCommand,
} from "./commands/group.js";
import {
  queryCommand,
  wikiCommand,
  serveCommand,
  prReviewCommand,
  openDashboardCommand,
} from "./commands/misc.js";
import { runStartupHealthCheck } from "./config/startup-health-check.js";
import { CodeBrainStatusBar } from "./ui/status-bar.js";
import { StalenessMonitor } from "./staleness/staleness-monitor.js";
import {
  QuickActionsTreeProvider,
  AgentsTreeProvider,
  GroupsReposTreeProvider,
} from "./ui/tree-view.js";
import { createGitNexusParticipant } from "./ui/chat-participant.js";
import {
  getWorkspaceRoot,
  initializeCodeBrainRuntime,
} from "./process/cli-runner.js";

export function activate(context: vscode.ExtensionContext): void {
  initializeCodeBrainRuntime(context.globalStorageUri.fsPath);

  // ----------------------------------------------------------------
  // Status bar
  // ----------------------------------------------------------------
  const statusBar = new CodeBrainStatusBar(context.globalState);
  context.subscriptions.push(statusBar);

  // ----------------------------------------------------------------
  // Staleness monitor (deferred: starts after a brief delay to let startup settle)
  // ----------------------------------------------------------------
  let staleness: StalenessMonitor | undefined;
  setTimeout(() => {
    staleness = new StalenessMonitor(statusBar);
    staleness.start();
    context.subscriptions.push(staleness);
  }, 1000);

  // ----------------------------------------------------------------
  // Tree views
  // ----------------------------------------------------------------
  const quickActionsProvider = new QuickActionsTreeProvider();
  const agentsProvider = new AgentsTreeProvider();
  const groupsReposProvider = new GroupsReposTreeProvider(context.globalState);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "codebrain.quickActions",
      quickActionsProvider,
    ),
    vscode.window.registerTreeDataProvider("codebrain.agents", agentsProvider),
    vscode.window.registerTreeDataProvider(
      "codebrain.groupsRepos",
      groupsReposProvider,
    ),
  );

  // ----------------------------------------------------------------
  // Chat Participant
  // ----------------------------------------------------------------
  const gitNexusParticipant = createGitNexusParticipant(context);
  context.subscriptions.push(gitNexusParticipant);

  const runAnalyzeWithStatus = async (
    opts: { force?: boolean } = {},
  ): Promise<boolean> => {
    statusBar.setState("indexing");
    try {
      const ok = await analyzeCommand(opts, context);
      return ok;
    } finally {
      if (staleness) {
        await staleness.forceCheck();
      }
    }
  };

  // ----------------------------------------------------------------
  // Commands
  // ----------------------------------------------------------------
  const cmds: Array<[string, (...args: any[]) => unknown]> = [
    ["codebrain.setup", setupCommand],
    ["codebrain.installCli", installCliCommand],

    ["codebrain.analyze", () => runAnalyzeWithStatus()],
    ["codebrain.analyzeForce", () => runAnalyzeWithStatus({ force: true })],
    // ['codebrain.analyzeEmbeddings', analyzeWithEmbeddingsCommand],

    ["codebrain.status", () => statusCommand(context)],
    ["codebrain.listRepos", listReposCommand],
    ["codebrain.clean", cleanCommand],
    ["codebrain.cleanAll", cleanAllCommand],

    ["codebrain.serve", serveCommand],
    ["codebrain.openDashboard", () => openDashboardCommand(context)],
    ["codebrain.generateWiki", wikiCommand],
    ["codebrain.query", () => queryCommand(context)],
    ["codebrain.prReview", prReviewCommand],

    // Group & Context commands
    [
      "codebrain.repoMenu",
      (...args) =>
        repoMenuCommand(
          context,
          args[0] as string | { meta?: Record<string, string> } | undefined,
        ),
    ],
    [
      "codebrain.selectRepo",
      (...args) =>
        selectRepoCommand(
          context,
          args[0] as string | { meta?: Record<string, string> } | undefined,
        ),
    ],
    [
      "codebrain.selectGroup",
      (...args) =>
        selectGroupCommand(
          context,
          args[0] as string | { meta?: Record<string, string> } | undefined,
        ),
    ],
    ["codebrain.createGroup", createGroupCommand],
    ["codebrain.syncGroup", syncGroupCommand],
    ["codebrain.addRepoToGroup", addRepoToGroupCommand],
    ["codebrain.removeRepoFromGroup", removeRepoFromGroupCommand],
    ["codebrain.clearContext", () => clearActivationCommand(context)],
    ["codebrain.showContext", () => showActiveContextCommand(context)],

    [
      "codebrain.refreshTreeView",
      () => {
        quickActionsProvider.refresh();
        agentsProvider.refresh();
        groupsReposProvider.refresh();
        statusBar.refreshContext();
        if (staleness) {
          void staleness.forceCheck();
        }
      },
    ],
  ];

  for (const [id, handler] of cmds) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...args: any[]) => handler(...args)),
    );
  }

  // ----------------------------------------------------------------
  // Startup initialization (fire-and-forget)
  // ----------------------------------------------------------------
  // Startup project health check: MCP presence + auto-setup + auto-start server
  void runStartupHealthCheck(getWorkspaceRoot());
}

export function deactivate(): void {
  // Disposables registered via context.subscriptions are cleaned up automatically.
}
