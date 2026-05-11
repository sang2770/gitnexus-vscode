import * as vscode from 'vscode';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import { buildCodeBrainTerminalCommand, getSetupStateMarkerPath, runCodeBrain } from '../process/cli-runner.js';
import * as fs from 'fs';
import * as path from 'path';

let _autoStartTerminal: vscode.Terminal | undefined;

export async function runStartupHealthCheck(
  workspaceRoot: string,
): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return;
  }

  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const markerPath = getSetupStateMarkerPath();
  if (fs.existsSync(markerPath)) {
    return;
  }

  const result = await runCodeBrain(['setup'], { cwd: workspaceRoot, stream: true });
  if (result.exitCode !== 0) {
    vscode.window.showWarningMessage('CodeBrain: Auto setup failed. Run "CodeBrain: Setup" manually.');
    return;
  }

  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, Date.now().toString(), 'utf-8');
  vscode.window.showInformationMessage('CodeBrain: First-time setup completed automatically.');
}

export async function autoStartCodeBrainServer(
  workspaceRoot: string,
): Promise<void> {
  try {
    // Check if CLI is available
    const ok = await ensureCodeBrainCli();
    if (!ok) {
      return;
    }

    // Check if server is already running
    if (_autoStartTerminal && !_autoStartTerminal.exitStatus) {
      return;
    }

    // Create background terminal and start server silently
    _autoStartTerminal = vscode.window.createTerminal({
      name: 'CodeBrain Bridge (Auto)',
      cwd: workspaceRoot,
      shellPath: process.platform === 'win32' ? 'cmd.exe' : undefined,
      isTransient: true, // Hide from terminal list by default
    });

    _autoStartTerminal.sendText(buildCodeBrainTerminalCommand(['serve']));
  } catch (error) {
    // Silently fail on auto-start to avoid disrupting user workflow
    console.warn('CodeBrain: Auto-start server failed:', error);
  }
}
