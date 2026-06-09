import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import {
  getOutputChannel,
  getSetupStateMarkerPath,
  getWorkspaceRoot,
} from '../process/cli-runner.js';
import {
  ensureCodeBrainCopilotAgent,
  type AgentFileResult,
} from '../process/copilot-agent.js';

export async function setupCommand(): Promise<boolean> {
  const channel = getOutputChannel();
  channel.show(true);

  const cliOk = await ensureCodeBrainCli();
  if (!cliOk) {
    return false;
  }

  const markerPath = getSetupStateMarkerPath();
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, Date.now().toString(), 'utf-8');

  const agentResult = await ensureWorkspaceAgent(false);
  if (agentResult) {
    logAgentResult(channel, agentResult);
  }

  channel.appendLine('[CodeBrain] CodeGraph is ready. VS Code MCP is provided by this extension.');
  vscode.window.showInformationMessage(formatSetupMessage(agentResult));
  return true;
}

export async function createCopilotAgentCommand(): Promise<void> {
  const channel = getOutputChannel();
  channel.show(true);

  const result = await ensureWorkspaceAgent(false);
  if (!result) {
    return;
  }

  if (result.action === 'skipped-existing') {
    const choice = await vscode.window.showWarningMessage(
      `CodeBrain: ${path.basename(result.filePath)} already exists and has custom content. Overwrite it?`,
      { modal: true },
      'Overwrite',
      'Keep Existing',
    );
    if (choice !== 'Overwrite') {
      logAgentResult(channel, result);
      return;
    }

    const overwritten = await ensureWorkspaceAgent(true);
    if (overwritten) {
      logAgentResult(channel, overwritten);
      vscode.window.showInformationMessage(`CodeBrain: Copilot agent updated at ${toWorkspaceRelative(overwritten.filePath)}.`);
    }
    return;
  }

  logAgentResult(channel, result);
  vscode.window.showInformationMessage(`CodeBrain: Copilot agent ${formatAgentAction(result.action)} at ${toWorkspaceRelative(result.filePath)}.`);
}

async function ensureWorkspaceAgent(overwrite: boolean): Promise<AgentFileResult | undefined> {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showWarningMessage('CodeBrain: Open a workspace folder before creating a Copilot agent.');
    return undefined;
  }

  return ensureCodeBrainCopilotAgent(getWorkspaceRoot(), { overwrite });
}

function logAgentResult(channel: vscode.OutputChannel, result: AgentFileResult): void {
  channel.appendLine(`[CodeBrain] Copilot agent ${formatAgentAction(result.action)}: ${result.filePath}`);
}

function formatSetupMessage(result: AgentFileResult | undefined): string {
  if (!result) {
    return 'CodeBrain: is ready. Open a workspace folder to create the Copilot agent.';
  }

  if (result.action === 'skipped-existing') {
    return 'CodeBrain: is ready. Existing CodeBrain agent file was preserved.';
  }

  return 'CodeBrain: is ready and Copilot agent is configured.';
}

function formatAgentAction(action: AgentFileResult['action']): string {
  return {
    created: 'created',
    updated: 'updated',
    unchanged: 'already up to date',
    'skipped-existing': 'preserved existing custom file',
  }[action];
}

function toWorkspaceRelative(filePath: string): string {
  const relative = path.relative(getWorkspaceRoot(), filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative.replace(/\\/g, '/');
}
