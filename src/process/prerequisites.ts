import * as vscode from 'vscode';
import {
  ensureCodeBrainCliInstalled,
  getCodeGraphRuntimeDescriptor,
} from '../process/cli-runner.js';

export interface PrerequisiteStatus {
  runtime: string | null;
  ready: boolean;
}

export function checkPrerequisites(): PrerequisiteStatus {
  const runtime = getCodeGraphRuntimeDescriptor();
  return {
    runtime: runtime?.command ?? null,
    ready: !!runtime,
  };
}

export async function ensureCodeBrainCli(token?: vscode.CancellationToken): Promise<boolean> {
  const ok = await ensureCodeBrainCliInstalled(token);
  if (!ok) {
    vscode.window.showErrorMessage(
      'CodeBrain: CodeGraph runtime is not available. Please upgrade or reinstall the extension.',
    );
  }
  return ok;
}
