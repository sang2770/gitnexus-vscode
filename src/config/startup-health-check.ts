import * as vscode from 'vscode';
import { hasGitNexusMcpServer, writeMcpConfig } from './mcp-config-writer.js';
import { ensureGitnexusCli } from '../process/prerequisites.js';
import { getWorkspaceRoot, buildGitnexusTerminalCommand } from '../process/cli-runner.js';

let _autoStartTerminal: vscode.Terminal | undefined;

export async function runStartupHealthCheck(
  workspaceRoot: string,
): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return;
  }

  const mcpMissing = !hasGitNexusMcpServer(workspaceRoot);
  if (!mcpMissing) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'GitNexus: Missing MCP config in this project.',
    'Fix MCP',
    'Later',
  );

  if (!choice || choice === 'Later') {
    return;
  }

  if (choice === 'Fix MCP') {
    await writeMcpConfig(workspaceRoot);
  }

  vscode.window.showInformationMessage('GitNexus: Project configuration check completed.');
}

export async function autoStartGitnexusServer(
  workspaceRoot: string,
): Promise<void> {
  try {
    // Check if CLI is available
    const ok = await ensureGitnexusCli();
    if (!ok) {
      return;
    }

    // Check if server is already running
    if (_autoStartTerminal && !_autoStartTerminal.exitStatus) {
      return;
    }

    // Create background terminal and start server silently
    _autoStartTerminal = vscode.window.createTerminal({
      name: 'GitNexus Bridge (Auto)',
      cwd: workspaceRoot,
      shellPath: process.platform === 'win32' ? 'cmd.exe' : undefined,
      isTransient: true, // Hide from terminal list by default
    });

    _autoStartTerminal.sendText(buildGitnexusTerminalCommand(['serve']));
  } catch (error) {
    // Silently fail on auto-start to avoid disrupting user workflow
    console.warn('GitNexus: Auto-start server failed:', error);
  }
}
