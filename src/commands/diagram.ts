import * as vscode from 'vscode';
import { getOutputChannel, getWorkspaceRoot } from '../process/cli-runner.js';
import { generateDiagramPreviewFromModel } from '../ui/diagram-generation.js';
import { getEditorIntentContext } from '../workflows/intent-resolver.js';

export async function generateFlowDiagramCommand(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const editorContext = getEditorIntentContext(workspaceRoot);
  const defaultTarget =
    editorContext.selectedSymbol ??
    editorContext.cursorSymbol ??
    editorContext.relativeFilePath ??
    'current flow';

  const target = (await vscode.window.showInputBox({
    prompt: 'CodeBrain: Generate Mermaid flow diagram for symbol or flow query',
    placeHolder: 'AuthService.login, checkout flow, payment webhook',
    value: defaultTarget,
  }))?.trim();

  if (!target) {
    return;
  }

  const selectedType = await vscode.window.showQuickPick(
    [
      { label: '$(git-branch) Flowchart (Left to Right)', value: 'Flowchart LR', description: 'flowchart LR' },
      { label: '$(git-commit) Flowchart (Top Down)', value: 'Flowchart TD', description: 'flowchart TD' },
      { label: '$(symbol-interface) Sequence Diagram', value: 'Sequence Diagram', description: 'sequenceDiagram' },
      { label: '$(symbol-class) Class Diagram', value: 'Class Diagram', description: 'classDiagram' },
      { label: '$(symbol-event) State Diagram', value: 'State Diagram', description: 'stateDiagram' },
      { label: '$(symbol-module) C4 Diagram', value: 'C4 Diagram', description: 'C4Context' },
    ],
    {
      placeHolder: 'Select the type of diagram to generate',
      ignoreFocusOut: true,
    }
  );

  if (!selectedType) {
    return;
  }

  const diagramType = selectedType.value;
  const outputChannel = getOutputChannel();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CodeBrain: Generating Markdown + Mermaid diagram...',
      cancellable: true,
    },
    async (_progress, token) => {
      try {
        const result = await generateDiagramPreviewFromModel({
          target,
          token,
          diagramType,
        });
        outputChannel.appendLine(`Diagram preview source written: ${result.filePath}`);
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(result.filePath));
        vscode.window.showInformationMessage(`CodeBrain: Flow diagram generated for ${result.intent.target ?? target}.`);
      } catch (error) {
        if (token.isCancellationRequested) {
          vscode.window.showWarningMessage('CodeBrain: Diagram generation cancelled.');
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`[CodeBrain Diagram] ${message}`);
        vscode.window.showErrorMessage(`CodeBrain: Failed to generate diagram. ${message}`);
      }
    },
  );
}