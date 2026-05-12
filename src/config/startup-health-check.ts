import * as vscode from 'vscode';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import { buildCodeBrainTerminalCommand, getInstalledCliPath, getSetupStateMarkerPath, runCodeBrain } from '../process/cli-runner.js';
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

  const result = await runCodeBrain(['setup', '--gitnexus-bin', getInstalledCliPath() ?? ''], { cwd: workspaceRoot, stream: true });
  if (result.exitCode !== 0) {
    vscode.window.showWarningMessage('CodeBrain: Auto setup failed. Run "CodeBrain: Setup" manually.');
    return;
  }

  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, Date.now().toString(), 'utf-8');
  vscode.window.showInformationMessage('CodeBrain: First-time setup completed automatically.');
}