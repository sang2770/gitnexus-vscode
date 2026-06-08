import * as vscode from 'vscode';
import { getWorkspaceRoot } from '../process/cli-runner.js';
import {
  type CodeBrainWorkflowKind,
  getEditorIntentContext,
  WORKFLOW_DEFINITIONS,
} from '../workflows/intent-resolver.js';

const CHAT_PARTICIPANT_ID = 'codebrain.codegraph';

export async function openWorkflowChatCommand(workflow: CodeBrainWorkflowKind): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const editorContext = getEditorIntentContext(workspaceRoot);
  const prompt = buildWorkflowPrompt(workflow, editorContext);
  await openCodeBrainChat(prompt);
}

export async function openCodeBrainChat(prompt: string): Promise<void> {
  const chatUri = vscode.Uri.parse(
    `vscode://xpl.chat-uri/startChat?agent=${CHAT_PARTICIPANT_ID}&prompt=${encodeURIComponent(prompt)}`,
  );
  await vscode.commands.executeCommand('vscode.open', chatUri);
}

function buildWorkflowPrompt(
  workflow: CodeBrainWorkflowKind,
  editorContext: ReturnType<typeof getEditorIntentContext>,
): string {
  const definition = WORKFLOW_DEFINITIONS[workflow];
  const target = resolveWorkflowTarget(workflow, editorContext);
  return target ? `${definition.slashCommand} ${target}` : definition.slashCommand;
}

function resolveWorkflowTarget(
  workflow: CodeBrainWorkflowKind,
  editorContext: ReturnType<typeof getEditorIntentContext>,
): string | undefined {
  if (workflow === 'review' || workflow === 'detect_change') {
    return 'working tree diff';
  }

  if (workflow === 'architecture') {
    return editorContext.relativeFilePath ?? 'repository';
  }

  if (editorContext.selectedSymbol) {
    return editorContext.selectedSymbol;
  }

  if (editorContext.cursorSymbol) {
    return editorContext.cursorSymbol;
  }

  if (editorContext.relativeFilePath) {
    return editorContext.relativeFilePath;
  }

  return undefined;
}
