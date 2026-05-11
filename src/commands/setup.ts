import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import {
  runCodeBrain,
  getOutputChannel,
  getWorkspaceRoot,
  getSetupStateMarkerPath,
  getInstalledCliPath,
} from '../process/cli-runner.js';

/** Full one-shot setup: install/check CLI + run gitnexus setup */
export async function setupCommand(): Promise<void> {
  const channel = getOutputChannel();
  channel.show(true);

  // Step 1 - ensure extension-local CLI (install first time, update later)
  const cliOk = await ensureCodeBrainCli();
  if (!cliOk) {
    return;
  }

  const workspaceRoot = getWorkspaceRoot();

  // Step 2 - run gitnexus setup (it configures MCP/agents by itself)
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CodeBrain: Running CLI setup', cancellable: false },
    async () => {
      await runCodeBrain(['setup', '--gitnexus-bin', getInstalledCliPath() ?? ''], { cwd: workspaceRoot });
    },
  );

  const markerPath = getSetupStateMarkerPath();
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, Date.now().toString(), 'utf-8');

  vscode.window.showInformationMessage('CodeBrain: Setup complete.');
}

/** Just install / verify CLI, no other side effects */
export async function installCliCommand(): Promise<void> {
  await ensureCodeBrainCli();
}
