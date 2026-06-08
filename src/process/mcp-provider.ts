import * as vscode from 'vscode';
import {
  ensureCodeBrainCliInstalled,
  getCodeGraphRuntimeDescriptor,
  getInstalledCliVersion,
  getWorkspaceRoot,
} from './cli-runner.js';

export const CODEGRAPH_MCP_PROVIDER_ID = 'codebrain.codegraph';

function buildServerDefinition(workspaceRoot: string): vscode.McpStdioServerDefinition | undefined {
  const descriptor = getCodeGraphRuntimeDescriptor(['serve', '--mcp', '--path', workspaceRoot]);
  if (!descriptor) {
    return undefined;
  }

  const server = new vscode.McpStdioServerDefinition(
    'CodeGraph',
    descriptor.command,
    descriptor.args,
    {},
    getInstalledCliVersion(),
  );
  server.cwd = vscode.Uri.file(workspaceRoot);
  return server;
}

export function registerCodeGraphMcpProvider(context: vscode.ExtensionContext): vscode.Disposable {
  const didChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(didChange);

  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    onDidChangeMcpServerDefinitions: didChange.event,
    provideMcpServerDefinitions: () => {
      const definition = buildServerDefinition(getWorkspaceRoot());
      return definition ? [definition] : [];
    },
    resolveMcpServerDefinition: async (server, token) => {
      const ok = await ensureCodeBrainCliInstalled(token);
      if (!ok) {
        vscode.window.showWarningMessage(
          'CodeBrain: bundled CodeGraph runtime is not available. Run CodeBrain: Prepare CodeGraph Runtime or rebuild the extension.',
        );
        return undefined;
      }

      const resolved = buildServerDefinition(server.cwd?.fsPath ?? getWorkspaceRoot());
      if (resolved) {
        didChange.fire();
      }
      return resolved;
    },
  };

  return vscode.lm.registerMcpServerDefinitionProvider(CODEGRAPH_MCP_PROVIDER_ID, provider);
}
