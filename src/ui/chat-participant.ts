import * as vscode from 'vscode';
import { getActiveContext } from '../process/group-context.js';

const PARTICIPANT_ID = 'codebrain.gitnexus';

export class GitNexusAgentParticipant {
  private readonly context: vscode.ExtensionContext;
  private instructionsCache?: string;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  private getDefaultRepoScope(): string | undefined {
    const active = getActiveContext(this.context.globalState);
    if (!active) {
      return undefined;
    }

    return active.type === 'group' ? `@${active.name}` : active.name;
  }

  private injectDefaultRepoIfMissing(
    supportsRepoByToolName: Map<string, boolean>,
    toolName: string,
    input: unknown,
    defaultRepo: string | undefined,
  ): unknown {
    if (!defaultRepo || typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }

    if (!supportsRepoByToolName.get(toolName)) {
      return input;
    }

    const payload = input as Record<string, unknown>;
    if (typeof payload.repo === 'string' && payload.repo.trim().length > 0) {
      return input;
    }

    return {
      ...payload,
      repo: defaultRepo,
    };
  }

  private async getInstructions(): Promise<string> {
    if (this.instructionsCache) {
      return this.instructionsCache;
    }

    try {
      const uri = vscode.Uri.joinPath(this.context.extensionUri, 'gitnexus-chat-participant.instructions.md');
      const raw = await vscode.workspace.fs.readFile(uri);
      this.instructionsCache = Buffer.from(raw).toString('utf8');
    } catch {
      this.instructionsCache = [
        'You are a GitNexus code-intelligence assistant powered by the GitNexus knowledge graph.',
        'Use the available gitnexus_* tools to answer questions about the codebase.',
        'MUST run gitnexus_impact before suggesting edits to any symbol.',
        'MUST run gitnexus_detect_changes before suggesting commits.',
        'MUST warn the user if impact returns HIGH or CRITICAL risk.',
        'NEVER rename with find-and-replace — use gitnexus_rename only.',
      ].join('\n');
    }
    return this.instructionsCache!;
  }

  private isAutoModel(model: vscode.LanguageModelChat | undefined): boolean {
    if (!model) {
      return false;
    }
    const id = model.id?.toLowerCase() ?? '';
    const family = model.family?.toLowerCase() ?? '';
    const name = model.name?.toLowerCase() ?? '';
    return id === 'auto' || family === 'auto' || name === 'auto';
  }

  private isNotFoundModelError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    return lower.includes('notfound')
      || lower.includes('not found')
      || lower.includes('endpoint not found')
      || lower.includes('model does not exist');
  }

  private async resolveRequestModel(request: vscode.ChatRequest): Promise<vscode.LanguageModelChat | undefined> {
    if (request.model && !this.isAutoModel(request.model)) {
      return request.model;
    }

    const copilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    const concreteCopilotModel = copilotModels.find((m) => !this.isAutoModel(m));
    if (concreteCopilotModel) {
      return concreteCopilotModel;
    }

    const allModels = await vscode.lm.selectChatModels();
    return allModels.find((m) => !this.isAutoModel(m)) ?? allModels[0];
  }

  public getHandler() {
    return async (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> => {
      const instructions = await this.getInstructions();
      const defaultRepoScope = this.getDefaultRepoScope();

      // Prefer the concrete model selected by the user.
      // If UI selection is an "auto" placeholder, resolve a concrete model.
      let model = await this.resolveRequestModel(request);
      if (!model) {
        stream.markdown('❌ No language model available. Ensure GitHub Copilot is signed in and active.');
        return {};
      }

      // Collect GitNexus MCP tools registered in VS Code
      const gitnexusTools = vscode.lm.tools.filter((t) => t.name.startsWith('mcp_gitnexus_'));
      const supportsRepoByToolName = new Map<string, boolean>();
      for (const tool of gitnexusTools) {
        const schema = (tool as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema;
        const hasRepoField = !!schema?.properties && Object.prototype.hasOwnProperty.call(schema.properties, 'repo');
        supportsRepoByToolName.set(tool.name, hasRepoField);
      }

      // Build message history
      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(instructions),
      ];

      if (defaultRepoScope) {
        messages.push(
          vscode.LanguageModelChatMessage.User(
            `Active GitNexus scope: ${defaultRepoScope}. Use this as default tool "repo" when not explicitly specified by the user.`,
          ),
        );
      }

      for (const turn of chatContext.history.slice(-6)) {
        if (turn instanceof vscode.ChatRequestTurn) {
          messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
          const text = turn.response
            .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
            .map((p) => p.value.value)
            .join('');
          if (text) {
            messages.push(vscode.LanguageModelChatMessage.Assistant(text));
          }
        }
      }

      messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

      // Tool-calling loop — runs until model produces no more tool calls
      while (!token.isCancellationRequested) {
        let response: vscode.LanguageModelChatResponse;
        try {
          response = await model.sendRequest(
            messages,
            { tools: gitnexusTools },
            token
          );
        } catch (err) {
          if (!this.isNotFoundModelError(err)) {
            throw err;
          }

          const fallbackModel = await this.resolveRequestModel(request);
          if (!fallbackModel || fallbackModel.id === model.id) {
            throw err;
          }

          model = fallbackModel;
          stream.progress(`Switched model to ${model.name} (${model.id}) due to unavailable endpoint.`);
          response = await model.sendRequest(
            messages,
            { tools: gitnexusTools },
            token
          );
        }

        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        const assistantContent: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];

        for await (const chunk of response.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            stream.markdown(chunk.value);
            assistantContent.push(chunk);
          } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push(chunk);
            assistantContent.push(chunk);
            stream.progress(`Running ${chunk.name}…`);
          }
        }

        // No tool calls → model is done
        if (toolCalls.length === 0) {
          break;
        }

        // Record assistant turn with tool calls
        messages.push(
          new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, assistantContent)
        );

        // Execute each tool call and collect results
        const toolResults: vscode.LanguageModelToolResultPart[] = [];
        for (const call of toolCalls) {
          try {
            const toolInput = this.injectDefaultRepoIfMissing(
              supportsRepoByToolName,
              call.name,
              call.input,
              defaultRepoScope,
            );
            const result = await vscode.lm.invokeTool(
              call.name,
              { input: toolInput as any, toolInvocationToken: request.toolInvocationToken },
              token
            );
            toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
          } catch (err) {
            toolResults.push(
              new vscode.LanguageModelToolResultPart(call.callId, [
                new vscode.LanguageModelTextPart(`Error invoking ${call.name}: ${err instanceof Error ? err.message : String(err)}`),
              ])
            );
          }
        }

        // Feed tool results back as a user turn
        messages.push(
          new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, toolResults)
        );
      }

      return {};
    };
  }
}

export const createGitNexusParticipant = (context: vscode.ExtensionContext): vscode.ChatParticipant => {
  const participant = new GitNexusAgentParticipant(context);
  return vscode.chat.createChatParticipant(PARTICIPANT_ID, participant.getHandler());
};
