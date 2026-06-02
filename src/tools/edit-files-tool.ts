import * as vscode from 'vscode';
import path from 'path';

interface EditInstruction {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

interface EditFilesToolInput {
  filePath: string;
  edits?: EditInstruction[];
  newContent?: string;
  createIfMissing?: boolean;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

export class CodeBrainEditFilesTool implements vscode.LanguageModelTool<EditFilesToolInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<EditFilesToolInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const filePath = options.input.filePath || '<missing path>';
    const mode = options.input.newContent !== undefined ? 'overwrite content' : 'apply text edits';

    return {
      invocationMessage: `Editing file ${filePath}`,
      confirmationMessages: {
        title: 'Edit file in workspace',
        message: new vscode.MarkdownString([
          `Apply edits to this file?`,
          '',
          `Path: ${filePath}`,
          `Mode: ${mode}`,
        ].join('\n')),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<EditFilesToolInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder is open.');
    }

    if (!input.filePath || !input.filePath.trim()) {
      throw new Error('Missing required input: filePath.');
    }

    const hasEdits = Array.isArray(input.edits) && input.edits.length > 0;
    const hasNewContent = typeof input.newContent === 'string';
    if (!hasEdits && !hasNewContent) {
      throw new Error('Provide either edits or newContent.');
    }

    const targetUri = this.resolveTargetUri(workspaceFolder.uri, input.filePath);
    const exists = await this.pathExists(targetUri);

    if (!exists && !input.createIfMissing) {
      throw new Error(`File does not exist: ${targetUri.fsPath}. Set createIfMissing to true to create it.`);
    }

    if (!exists && input.createIfMissing) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetUri.fsPath)));
    }

    if (hasNewContent) {
      await vscode.workspace.fs.writeFile(targetUri, textEncoder.encode(input.newContent ?? ''));
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Updated ${targetUri.fsPath} by replacing full content.`),
      ]);
    }

    const raw = exists ? await vscode.workspace.fs.readFile(targetUri) : new Uint8Array();
    let content = textDecoder.decode(raw);

    for (const edit of input.edits ?? []) {
      if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
        throw new Error('Each edit must include oldText and newText as strings.');
      }

      const oldText = edit.oldText;
      const newText = edit.newText;
      const matches = this.countOccurrences(content, oldText);

      if (matches === 0) {
        throw new Error(`oldText not found in file: ${oldText.slice(0, 120)}`);
      }

      if (edit.replaceAll) {
        content = content.split(oldText).join(newText);
        continue;
      }

      if (matches > 1) {
        throw new Error([
          `oldText is ambiguous and appears ${matches} times.`,
          'Either provide a more specific oldText or set replaceAll=true.',
        ].join(' '));
      }

      content = content.replace(oldText, newText);
    }

    await vscode.workspace.fs.writeFile(targetUri, textEncoder.encode(content));
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`Applied ${input.edits?.length ?? 0} edit(s) to ${targetUri.fsPath}.`),
    ]);
  }

  private resolveTargetUri(workspaceRoot: vscode.Uri, filePath: string): vscode.Uri {
    if (path.isAbsolute(filePath)) {
      return vscode.Uri.file(filePath);
    }

    const normalized = filePath.replace(/\\/g, '/');
    return vscode.Uri.joinPath(workspaceRoot, normalized);
  }

  private async pathExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private countOccurrences(content: string, value: string): number {
    if (!value) {
      return 0;
    }

    let count = 0;
    let index = 0;
    while (true) {
      const matchIndex = content.indexOf(value, index);
      if (matchIndex === -1) {
        break;
      }
      count += 1;
      index = matchIndex + value.length;
    }

    return count;
  }
}
