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
import { runStartupHealthCheck } from './config/startup-health-check.js';
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

  const runQuickActionRunner = async (): Promise<void> => {
    const items: Array<{ label: string; description: string; command: string }> = [
      { label: 'Setup GitNexus (MCP + Agents)', description: 'Install/check CLI + configure MCP and agents', command: 'gitnexus.setup' },
      { label: 'Analyze Repo', description: 'Index repository with default options', command: 'gitnexus.analyze' },
      { label: 'Force Re-index', description: 'Full rebuild of index', command: 'gitnexus.analyzeForce' },
      { label: 'Analyze with Embeddings', description: 'Enable semantic vectors', command: 'gitnexus.analyzeEmbeddings' },
      { label: 'Show Index Status', description: 'Check index freshness', command: 'gitnexus.status' },
      { label: 'List Indexed Repos', description: 'Show registered repos', command: 'gitnexus.listRepos' },
      { label: 'Open Graph Dashboard', description: 'Open dependency graph dashboard in VS Code', command: 'gitnexus.openDashboard' },
      { label: 'PR Review', description: 'Run PR impact analysis', command: 'gitnexus.prReview' },
      { label: 'Start Bridge Server', description: 'Run gitnexus serve', command: 'gitnexus.serve' },
      { label: 'Query Knowledge Graph', description: 'Run quick graph query', command: 'gitnexus.query' },
      { label: 'Generate Wiki', description: 'Generate wiki from graph', command: 'gitnexus.generateWiki' },
      { label: 'Clean Index', description: 'Delete current repo index', command: 'gitnexus.clean' },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'GitNexus Quick Action Runner',
      matchOnDescription: true,
    });
    if (!pick) {
      return;
    }
    await vscode.commands.executeCommand(pick.command);
  };

  // ----------------------------------------------------------------
  // Commands
  // ----------------------------------------------------------------
  const cmds: Array<[string, () => unknown]> = [
    ['gitnexus.setup', setupCommand],
    ['gitnexus.installCli', installCliCommand],

    ['gitnexus.quickActionRunner', runQuickActionRunner],
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
}

export function deactivate(): void {
  // Disposables registered via context.subscriptions are cleaned up automatically.
}
