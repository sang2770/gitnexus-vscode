import * as vscode from 'vscode';
import { setupCommand, installCliCommand } from './commands/setup.js';
import {
  analyzeCommand,
  analyzeForceCommand,
  analyzeWithEmbeddingsCommand,
} from './commands/analyze.js';
import {
  cleanCommand,
  cleanAllCommand,
  statusCommand,
  listReposCommand,
} from './commands/clean.js';
import {
  queryCommand,
  wikiCommand,
  serveCommand,
  prReviewCommand,
  openDashboardCommand,
} from './commands/misc.js';
import { writeMcpConfigWithFeedback } from './config/mcp-config-writer.js';
import { runStartupHealthCheck, autoStartGitnexusServer } from './config/startup-health-check.js';
import { GitNexusStatusBar } from './ui/status-bar.js';
import { StalenessMonitor } from './staleness/staleness-monitor.js';
import { QuickActionsTreeProvider, AgentsTreeProvider } from './ui/tree-view.js';
import { getWorkspaceRoot } from './process/cli-runner.js';

export function activate(context: vscode.ExtensionContext): void {

  // ----------------------------------------------------------------
  // Status bar
  // ----------------------------------------------------------------
  const statusBar = new GitNexusStatusBar();
  context.subscriptions.push(statusBar);

  // ----------------------------------------------------------------
  // Staleness monitor
  // ----------------------------------------------------------------
  const staleness = new StalenessMonitor(statusBar);
  staleness.start();
  context.subscriptions.push(staleness);

  // ----------------------------------------------------------------
  // Tree views
  // ----------------------------------------------------------------
  const quickActionsProvider = new QuickActionsTreeProvider();
  const agentsProvider = new AgentsTreeProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('gitnexus.quickActions', quickActionsProvider),
    vscode.window.registerTreeDataProvider('gitnexus.agents', agentsProvider),
  );

  // ----------------------------------------------------------------
  // Commands
  // ----------------------------------------------------------------
  const cmds: Array<[string, () => unknown]> = [
    ['gitnexus.setup', setupCommand],
    ['gitnexus.installCli', installCliCommand],

    ['gitnexus.analyze', analyzeCommand],
    ['gitnexus.analyzeForce', analyzeForceCommand],
    ['gitnexus.analyzeEmbeddings', analyzeWithEmbeddingsCommand],

    ['gitnexus.status', statusCommand],
    ['gitnexus.listRepos', listReposCommand],
    ['gitnexus.clean', cleanCommand],
    ['gitnexus.cleanAll', cleanAllCommand],

    ['gitnexus.serve', serveCommand],
    ['gitnexus.openDashboard', () => openDashboardCommand(context)],
    ['gitnexus.generateWiki', wikiCommand],
    ['gitnexus.query', queryCommand],
    ['gitnexus.prReview', prReviewCommand],

    [
      'gitnexus.addMcpConfig',
      () => writeMcpConfigWithFeedback(getWorkspaceRoot()),
    ],

    [
      'gitnexus.refreshTreeView',
      () => {
        quickActionsProvider.refresh();
        agentsProvider.refresh();
        void staleness.forceCheck();
      },
    ],
  ];

  for (const [id, handler] of cmds) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, handler),
    );
  }

  // Startup project health check: MCP presence
  void runStartupHealthCheck(getWorkspaceRoot());

  // Auto-start gitnexus bridge server
  void autoStartGitnexusServer(getWorkspaceRoot());
}

export function deactivate(): void {
  // Disposables registered via context.subscriptions are cleaned up automatically.
}
