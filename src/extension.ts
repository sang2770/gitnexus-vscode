import * as vscode from "vscode";
import {
  type AnalyzeOptions,
  analyzeCommand,
  analyzeTreeItemCommand
} from "./commands/analyze.js";
import {
  cleanAllCommand,
  cleanCommand,
  listReposCommand,
  statusCommand,
} from "./commands/clean.js";
import { CodeBrainEditFilesTool } from "./tools/edit-files-tool.js";
import {
  addRepoToGroupCommand,
  clearActivationCommand,
  createGroupCommand,
  removeRepoFromGroupCommand,
  repoMenuCommand,
  selectGroupCommand,
  selectRepoCommand,
  showActiveContextCommand,
  syncGroupCommand,
} from "./commands/group.js";
import {
  jiraPlanAndQueryCommand,
  openDashboardCommand,
  prReviewCommand,
  queryCommand,
  serveCommand,
  wikiCommand,
} from "./commands/misc.js";
import { installCliCommand, setupCommand } from "./commands/setup.js";
import { runStartupHealthCheck } from "./config/startup-health-check.js";
import { syncActiveContextSkill } from "./process/active-context-skill.js";
import {
  getOutputChannel,
  getWorkspaceRoot,
  initializeCodeBrainRuntime,
} from "./process/cli-runner.js";
import { ensureWorkspaceActiveContext } from "./process/group-context.js";
import { StalenessMonitor } from "./staleness/staleness-monitor.js";
import { createGitNexusParticipant } from "./ui/chat-participant.js";
import { CodeBrainStatusBar } from "./ui/status-bar.js";
import {
  AgentsTreeProvider,
  GroupsReposTreeProvider,
  QuickActionsTreeProvider,
} from "./ui/tree-view.js";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = getOutputChannel();
  initializeCodeBrainRuntime(context.globalStorageUri.fsPath);
  void syncActiveContextSkill(context.globalState);
  context.subscriptions.push(
    vscode.lm.registerTool("codebrain_editFiles", new CodeBrainEditFilesTool()),
  );

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
    staleness = new StalenessMonitor(statusBar, context.globalState);
    staleness.start();
    context.subscriptions.push(staleness);
  }, 1000);

  // ----------------------------------------------------------------
  // Tree views
  // ----------------------------------------------------------------
  const quickActionsProvider = new QuickActionsTreeProvider();
  const agentsProvider = new AgentsTreeProvider();
  const groupsReposProvider = new GroupsReposTreeProvider(context.globalState);

  void (async () => {
    const resolved = await ensureWorkspaceActiveContext(context.globalState, {
      autoSelectSingle: true,
    });
    if (resolved) {
      await syncActiveContextSkill(context.globalState);
      statusBar.refreshContext();
      groupsReposProvider.refresh();
    }
  })();

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

  const runAnalyzeWithStatus = async (
    opts: AnalyzeOptions = {},
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
    [
      "codebrain.setupAndAnalyze",
      async () => {
        const setupCompleted = await setupCommand();
        if (!setupCompleted) {
          return false;
        }
        return runAnalyzeWithStatus();
      },
    ],
    ["codebrain.installCli", installCliCommand],

    ["codebrain.analyze", () => runAnalyzeWithStatus()],
    ["codebrain.analyzeForce", () => runAnalyzeWithStatus({ force: true })],
    [
      "codebrain.analyzeTreeItem",
      async (...args) => {
        statusBar.setState("indexing");
        try {
          return await analyzeTreeItemCommand(args[0], context);
        } finally {
          if (staleness) {
            await staleness.forceCheck();
          }
        }
      },
    ],
    // ['codebrain.analyzeEmbeddings', analyzeWithEmbeddingsCommand],

    ["codebrain.status", () => statusCommand(context)],
    ["codebrain.listRepos", listReposCommand],
    ["codebrain.clean", cleanCommand],
    ["codebrain.cleanAll", cleanAllCommand],

    ["codebrain.serve", serveCommand],
    ["codebrain.openDashboard", () => openDashboardCommand(context)],
    ["codebrain.generateWiki", wikiCommand],
    ["codebrain.query", () => queryCommand(context)],
    ["codebrain.jiraPlanAndQuery", () => jiraPlanAndQueryCommand(context)],
    ["codebrain.prReview", () => prReviewCommand(context)],

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
  // Chat Participant
  // ----------------------------------------------------------------
  outputChannel.appendLine("Initializing Git Nexus participant...");
  try {
    const gitNexusParticipant = createGitNexusParticipant(context);
    context.subscriptions.push(gitNexusParticipant);
  } catch (err) {
    outputChannel.appendLine(
      `Failed to initialize Git Nexus participant: ${err}`,
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
