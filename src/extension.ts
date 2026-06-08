import * as vscode from 'vscode';
import {
  type AnalyzeOptions,
  analyzeCommand,
  analyzeTreeItemCommand,
} from './commands/analyze.js';
import { cleanCommand, statusCommand } from './commands/clean.js';
import { prReviewCommand, queryCommand } from './commands/misc.js';
import { createCopilotAgentCommand, installCliCommand, setupCommand } from './commands/setup.js';
import { selectTokenOptimizationModeCommand } from './commands/token-optimization.js';
import { openWorkflowChatCommand } from './commands/workflow.js';
import { runStartupHealthCheck } from './config/startup-health-check.js';
import {
  getOutputChannel,
  initializeCodeBrainRuntime,
} from './process/cli-runner.js';
import { registerCodeGraphMcpProvider } from './process/mcp-provider.js';
import { StalenessMonitor } from './staleness/staleness-monitor.js';
import { createCodeGraphParticipant } from './ui/chat-participant.js';
import {
  askCodeBrainAboutImpactTarget,
  ImpactLensTreeProvider,
  openImpactLensLocation,
  runImpactLensAnalysis,
} from './ui/impact-lens.js';
import { CodeBrainStatusBar } from './ui/status-bar.js';
import { AgentsTreeProvider, QuickActionsTreeProvider } from './ui/tree-view.js';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = getOutputChannel();
  initializeCodeBrainRuntime(context.globalStorageUri.fsPath);

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
  const impactLensProvider = new ImpactLensTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('codebrain.quickActions', quickActionsProvider),
    vscode.window.registerTreeDataProvider('codebrain.agents', agentsProvider),
    vscode.window.registerTreeDataProvider('codebrain.impactLens', impactLensProvider),
    vscode.window.onDidChangeActiveTextEditor(() => impactLensProvider.refreshContext()),
    vscode.window.onDidChangeTextEditorSelection(() => impactLensProvider.refreshContext()),
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
    ['codebrain.installCli', installCliCommand],
    ['codebrain.createCopilotAgent', createCopilotAgentCommand],
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
    ['codebrain.status', statusCommand],
    ['codebrain.clean', cleanCommand],
    ['codebrain.query', queryCommand],
    ['codebrain.prReview', prReviewCommand],
    ['codebrain.workflow.architecture', () => openWorkflowChatCommand('architecture')],
    ['codebrain.workflow.explain', () => openWorkflowChatCommand('explain')],
    ['codebrain.workflow.impact', () => openWorkflowChatCommand('impact')],
    ['codebrain.workflow.review', prReviewCommand],
    ['codebrain.workflow.test', () => openWorkflowChatCommand('test')],
    ['codebrain.workflow.detectChange', () => openWorkflowChatCommand('detect_change')],
    ['codebrain.workflow.fixPlan', () => openWorkflowChatCommand('fix_plan')],
    [
      'codebrain.refreshTreeView',
      () => {
        quickActionsProvider.refresh();
        agentsProvider.refresh();
        impactLensProvider.refreshContext();
        statusBar.refreshContext();
        if (staleness) {
          void staleness.forceCheck();
        }
      },
    ],
    ['codebrain.impactLens.impact', () => runImpactLensAnalysis(impactLensProvider, 'impact')],
    ['codebrain.impactLens.callers', () => runImpactLensAnalysis(impactLensProvider, 'callers')],
    ['codebrain.impactLens.callees', () => runImpactLensAnalysis(impactLensProvider, 'callees')],
    ['codebrain.impactLens.affectedTests', () => runImpactLensAnalysis(impactLensProvider, 'affected')],
    ['codebrain.impactLens.openLocation', (location) => openImpactLensLocation(location)],
    ['codebrain.impactLens.askCodeBrain', () => askCodeBrainAboutImpactTarget(impactLensProvider)],
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
}

export function deactivate(): void {}
