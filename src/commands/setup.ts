import * as vscode from 'vscode';
import { ensureGitnexusCli } from '../process/prerequisites.js';
import { runGitnexus, getOutputChannel, getWorkspaceRoot } from '../process/cli-runner.js';
import { writeMcpConfigWithFeedback } from '../config/mcp-config-writer.js';

/** Full one-shot setup: install/check CLI + configure MCP + agents */
export async function setupCommand(): Promise<void> {
  const channel = getOutputChannel();
  channel.show(true);

  // Step 1 — ensure CLI
  const cliOk = await ensureGitnexusCli();
  if (!cliOk) {
    return;
  }

  const workspaceRoot = getWorkspaceRoot();

  // Step 2 — run gitnexus setup (configures Cursor/Claude Code/Codex etc.)
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'GitNexus: Configuring editors…', cancellable: false },
    async () => {
      await runGitnexus(['setup'], { cwd: workspaceRoot });
    },
  );

  // Step 3 — write VS Code MCP config
  await writeMcpConfigWithFeedback(workspaceRoot);

  vscode.window.showInformationMessage('GitNexus: Setup complete (MCP + Agents)!');
}

/** Just install / verify CLI, no other side effects */
export async function installCliCommand(): Promise<void> {
  await ensureGitnexusCli();
}
