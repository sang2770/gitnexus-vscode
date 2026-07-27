import * as vscode from 'vscode';
import {
  type AnalyzeOptions,
  analyzeCommand,
  analyzeTreeItemCommand,
} from './commands/analyze.js';
import { cleanCommand, statusCommand } from './commands/clean.js';
import { generateFlowDiagramCommand } from './commands/diagram.js';
import { prReviewCommand, queryCommand } from './commands/misc.js';
import { createCopilotAgentCommand, setupCommand } from './commands/setup.js';
import { selectTokenOptimizationModeCommand } from './commands/token-optimization.js';
import { openWorkflowChatCommand } from './commands/workflow.js';
import { runStartupHealthCheck } from './config/startup-health-check.js';
import {
  getOutputChannel,
  initializeCodeBrainRuntime,
} from './process/cli-runner.js';
import { registerCodeGraphMcpProvider } from './process/mcp-provider.js';
import { checkForExtensionUpdatesCommand } from './process/update-checker.js';
import { StalenessMonitor } from './staleness/staleness-monitor.js';
import { createCodeGraphParticipant } from './ui/chat-participant.js';
import { configureReportPanel } from './ui/report-panel.js';

import { CodeBrainStatusBar } from './ui/status-bar.js';
import { AgentsTreeProvider, QuickActionsTreeProvider } from './ui/tree-view.js';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = getOutputChannel();
  initializeCodeBrainRuntime(context.globalStorageUri.fsPath);
  configureReportPanel(context.extensionUri);

  context.subscriptions.push(registerCodeGraphMcpProvider(context));
  const statusBar = new CodeBrainStatusBar();
  context.subscriptions.push(statusBar);

  let staleness: StalenessMonitor | undefined;
  setTimeout(() => {
    staleness = new StalenessMonitor(statusBar);
    staleness.start();
    context.subscriptions.push(staleness);
  }, 1000);

  const quickActionsProvider = new QuickActionsTreeProvider();
  const agentsProvider = new AgentsTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('codebrain.quickActions', quickActionsProvider),
    vscode.window.registerTreeDataProvider('codebrain.agents', agentsProvider),
  );

  const runAnalyzeWithStatus = async (opts: AnalyzeOptions = {}): Promise<boolean> => {
    statusBar.setState('indexing');
    try {
      return await analyzeCommand(opts);
    } finally {
      if (staleness) {
        await staleness.forceCheck();
      }
    }
  };

  const commands: Array<[string, (...args: any[]) => unknown]> = [
    ['codebrain.setup', setupCommand],
    [
      'codebrain.setupAndAnalyze',
      async () => {
        const setupCompleted = await setupCommand();
        if (!setupCompleted) {
          return false;
        }
        return runAnalyzeWithStatus();
      },
    ],
    ['codebrain.createCopilotAgent', createCopilotAgentCommand],
    ['codebrain.checkForUpdates', () => checkForExtensionUpdatesCommand(context)],
    ['codebrain.tokenOptimization.selectMode', selectTokenOptimizationModeCommand],
    ['codebrain.analyze', () => runAnalyzeWithStatus()],
    ['codebrain.analyzeForce', () => runAnalyzeWithStatus({ force: true })],
    [
      'codebrain.analyzeTreeItem',
      async (...args) => {
        statusBar.setState('indexing');
        try {
          return await analyzeTreeItemCommand(args[0]);
        } finally {
          if (staleness) {
            await staleness.forceCheck();
          }
        }
      },
    ],
    [
      'codebrain.status',
      async () => {
        await statusCommand();
        if (staleness) {
          await staleness.forceCheck();
        }
      },
    ],
    ['codebrain.clean', cleanCommand],
    ['codebrain.query', queryCommand],
    ['codebrain.generateFlowDiagram', generateFlowDiagramCommand],
    ['codebrain.prReview', prReviewCommand],
    ['codebrain.workflow.architecture', () => openWorkflowChatCommand('architecture')],
    ['codebrain.workflow.develop', () => openWorkflowChatCommand('develop')],
    ['codebrain.workflow.fix', () => openWorkflowChatCommand('fix')],
    ['codebrain.workflow.verify', () => openWorkflowChatCommand('verify')],
    ['codebrain.workflow.explain', () => openWorkflowChatCommand('explain')],
    ['codebrain.workflow.impact', () => openWorkflowChatCommand('impact')],
    ['codebrain.workflow.review', prReviewCommand],
    ['codebrain.workflow.test', () => openWorkflowChatCommand('test')],
    ['codebrain.workflow.detectChange', () => openWorkflowChatCommand('detect_change')],
    ['codebrain.workflow.plan', () => openWorkflowChatCommand('plan')],
    ['codebrain.workflow.fixPlan', () => openWorkflowChatCommand('plan')],
    [
      'codebrain.refreshTreeView',
      () => {
        quickActionsProvider.refresh();
        agentsProvider.refresh();
        statusBar.refreshContext();
        if (staleness) {
          void staleness.forceCheck();
        }
      },
    ],
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, (...args: any[]) => handler(...args)));
  }

  outputChannel.appendLine('Initializing CodeGraph participant...');
  try {
    context.subscriptions.push(createCodeGraphParticipant(context));
  } catch (err) {
    outputChannel.appendLine(`Failed to initialize CodeGraph participant: ${err}`);
  }

  void runStartupHealthCheck();
  // void checkForExtensionUpdates(context);
}

export function deactivate(): void {}
