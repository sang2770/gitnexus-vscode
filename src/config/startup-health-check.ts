import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import { getSetupStateMarkerPath } from '../process/cli-runner.js';

export async function runStartupHealthCheck(): Promise<void> {
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

  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, Date.now().toString(), 'utf-8');
  vscode.window.showInformationMessage('CodeBrain: bundled CodeGraph is ready.');
}
