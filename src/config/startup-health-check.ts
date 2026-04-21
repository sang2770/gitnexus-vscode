import * as vscode from 'vscode';
import { hasGitNexusMcpServer, writeMcpConfig } from './mcp-config-writer.js';

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
