import * as vscode from 'vscode';
import { getOutputChannel, getWorkspaceRoot } from '../process/cli-runner.js';
import {
  buildTokenReductionMarkdown,
  createTokenReductionReport,
  getTokenOptimizationSettings,
  truncateForTokenMode,
} from '../process/token-optimizer.js';
import {
  buildClarificationMarkdown,
  buildWorkflowInstructions,
  type CodeGraphToolKind,
  getEditorIntentContext,
  resolveWorkflowIntent,
  type WorkflowIntent,
  WORKFLOW_DEFINITIONS,
} from '../workflows/intent-resolver.js';

const PARTICIPANT_ID = 'codebrain.codegraph';
const MAX_TOOL_CALL_ROUNDS = 5;

const CODEGRAPH_TOOL_HINTS = ['codegraph'];

const TOOL_ALIASES: Record<CodeGraphToolKind, string[]> = {
  explore: ['explore'],
  search: ['search', 'query'],
  callers: ['callers'],
  callees: ['callees'],
  impact: ['impact'],
  node: ['node'],
  files: ['files'],
  status: ['status'],
};

export class CodeGraphAgentParticipant {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private resolveIntent(request: vscode.ChatRequest): WorkflowIntent {
    const workspaceRoot = getWorkspaceRoot();
    const intent = resolveWorkflowIntent({
      command: request.command,
      prompt: request.prompt,
      workspaceRoot,
      editorContext: getEditorIntentContext(workspaceRoot),
    });
    const tokenSettings = getTokenOptimizationSettings(intent.contextMode);
    return {
      ...intent,
      contextMode: tokenSettings.effectiveMode,
    };
  }

  private buildInstructions(intent: WorkflowIntent): string {
    const tokenSettings = getTokenOptimizationSettings(intent.contextMode);
    const definition = WORKFLOW_DEFINITIONS[intent.workflow];
    const supplementalHints = definition.supplementalMcpToolHints ?? [];
    const toolScope = supplementalHints.length > 0
      ? `Use the selected CodeGraph MCP tools plus matching supplemental MCP context tools for this workflow. Supplemental hints: ${supplementalHints.join(', ')}.`
      : 'Use only the CodeGraph MCP tools selected for this workflow unless a later tool result proves a narrower follow-up is necessary.';
    return [
      buildWorkflowInstructions(intent),
      '',
      'Token optimization settings:',
      `- Configured mode: ${tokenSettings.configuredMode}`,
      `- Effective mode: ${tokenSettings.effectiveMode}`,
      `- Enabled: ${tokenSettings.enabled ? 'yes' : 'no'}`,
      `- Target budget: ${tokenSettings.tokenBudget} tokens`,
      '',
      `Workspace path: ${getWorkspaceRoot()}`,
      toolScope,
    ].join('\n');
  }

  private normalizeToolName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  }

  private getToolSearchText(tool: vscode.LanguageModelToolInformation): string {
    return `${tool.name} ${tool.description} ${tool.tags.join(' ')}`;
  }

  private isCodeGraphTool(tool: vscode.LanguageModelToolInformation): boolean {
    const haystack = this.getToolSearchText(tool).toLowerCase();
    return CODEGRAPH_TOOL_HINTS.some((hint) => haystack.includes(hint));
  }

  private toolMatchesAnyHint(tool: vscode.LanguageModelToolInformation, hints: string[]): boolean {
    const haystack = this.getToolSearchText(tool).toLowerCase();
    return hints.some((hint) => haystack.includes(hint));
  }

  private isCodeBrainTool(tool: vscode.LanguageModelToolInformation): boolean {
    return this.normalizeToolName(tool.name).startsWith('codebrain_');
  }

  private toolNameHasHint(normalizedName: string, hint: string): boolean {
    return (
      normalizedName === hint ||
      normalizedName.endsWith(`_${hint}`) ||
      normalizedName.includes(`_${hint}_`)
    );
  }

  private toolMatchesKind(
    tool: vscode.LanguageModelToolInformation,
    kind: CodeGraphToolKind,
  ): boolean {
    const normalizedName = this.normalizeToolName(tool.name);
    return TOOL_ALIASES[kind].some((alias) => this.toolNameHasHint(normalizedName, alias));
  }

  private selectCodeGraphToolByKind(
    tools: vscode.LanguageModelToolInformation[],
    kind: CodeGraphToolKind,
  ): vscode.LanguageModelToolInformation | undefined {
    return tools.filter((tool) => this.isCodeGraphTool(tool)).find((tool) => this.toolMatchesKind(tool, kind));
  }

  private selectToolsForIntent(intent: WorkflowIntent): vscode.LanguageModelToolInformation[] {
    const definition = WORKFLOW_DEFINITIONS[intent.workflow];
    const allowedKinds = definition.mcpToolsRequired;
    const selected = vscode.lm.tools.filter((tool) => {
      if (!this.isCodeGraphTool(tool) || this.isCodeBrainTool(tool)) {
        return false;
      }
      return allowedKinds.some((kind) => this.toolMatchesKind(tool, kind));
    });

    const fallbackCodeGraphTools = vscode.lm.tools.filter((tool) => this.isCodeGraphTool(tool));
    const supplementalTools = vscode.lm.tools.filter((tool) => {
      const hints = definition.supplementalMcpToolHints ?? [];
      return hints.length > 0 && !this.isCodeBrainTool(tool) && this.toolMatchesAnyHint(tool, hints);
    });
    const codeGraphTools = selected.length > 0 ? selected : fallbackCodeGraphTools;
    return this.dedupeTools([...codeGraphTools, ...supplementalTools]).slice(0, 12);
  }

  private dedupeTools(tools: vscode.LanguageModelToolInformation[]): vscode.LanguageModelToolInformation[] {
    const seen = new Set<string>();
    return tools.filter((tool) => {
      if (seen.has(tool.name)) {
        return false;
      }
      seen.add(tool.name);
      return true;
    });
  }

  private toChatTool(tool: vscode.LanguageModelToolInformation): vscode.LanguageModelChatTool {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
  }

  private selectToolsForRound(
    allTools: vscode.LanguageModelToolInformation[],
    intent: WorkflowIntent,
    request: vscode.ChatRequest,
    round: number,
  ): {
    tools?: vscode.LanguageModelChatTool[];
    toolMode?: vscode.LanguageModelChatToolMode;
  } {
    const requiredSteps = WORKFLOW_DEFINITIONS[intent.workflow].toolPlan.filter((step) => step.required);
    const requiredKind = requiredSteps[round]?.toolKind;
    if (requiredKind) {
      const tool = this.selectCodeGraphToolByKind(allTools, requiredKind);
      if (tool) {
        return {
          tools: [this.toChatTool(tool)],
          toolMode: vscode.LanguageModelChatToolMode.Required,
        };
      }
    }

    if (round === 0 && request.toolReferences.length > 0) {
      const attached = request.toolReferences
        .map((ref) => vscode.lm.tools.find((tool) => tool.name === ref.name))
        .filter((tool): tool is vscode.LanguageModelToolInformation => Boolean(tool && this.isCodeGraphTool(tool)));
      if (attached.length > 0) {
        return {
          tools: attached.map((tool) => this.toChatTool(tool)),
          toolMode: attached.length === 1 ? vscode.LanguageModelChatToolMode.Required : vscode.LanguageModelChatToolMode.Auto,
        };
      }
    }

    const tools = allTools.map((tool) => this.toChatTool(tool));
    return {
      tools: tools.length > 0 ? tools : undefined,
      toolMode: tools.length === 1 ? vscode.LanguageModelChatToolMode.Required : vscode.LanguageModelChatToolMode.Auto,
    };
  }

  private async resolveModel(request: vscode.ChatRequest): Promise<vscode.LanguageModelChat | undefined> {
    if (request.model && request.model.id !== 'auto') {
      return request.model;
    }

    const copilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (copilotModels.length > 0) {
      return copilotModels[0];
    }

    const models = await vscode.lm.selectChatModels();
    return models[0];
  }

  private buildInitialMessages(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    intent: WorkflowIntent,
  ): vscode.LanguageModelChatMessage[] {
    const tokenSettings = getTokenOptimizationSettings(intent.contextMode);
    const fullHistory = chatContext.history
      .slice(-8)
      .map((turn) => this.formatHistoryTurn(turn, 1600))
      .filter(Boolean)
      .join('\n');
    const optimizedHistory = chatContext.history
      .slice(tokenSettings.enabled ? -tokenSettings.historyTurnLimit : -8)
      .map((turn) => this.formatHistoryTurn(
        turn,
        tokenSettings.enabled ? tokenSettings.historyCharsPerTurn : 1600,
      ))
      .filter(Boolean)
      .join('\n');

    const basePrompt = [
      this.buildInstructions(intent),
      optimizedHistory ? `Recent chat history:\n${optimizedHistory}` : undefined,
      `Current user request:\n${request.prompt}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const beforePrompt = [
      this.buildInstructions(intent),
      fullHistory ? `Recent chat history:\n${fullHistory}` : undefined,
      `Current user request:\n${request.prompt}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const report = createTokenReductionReport({
      beforeText: beforePrompt,
      afterText: basePrompt,
      defaultMode: intent.contextMode,
      source: 'chat-initial-prompt',
    });
    const prompt = [
      basePrompt,
      buildTokenReductionMarkdown(report),
    ].join('\n\n');

    return [vscode.LanguageModelChatMessage.User(prompt)];
  }

  private formatHistoryTurn(turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn, maxChars: number): string {
    if (turn instanceof vscode.ChatRequestTurn) {
      return `User: ${truncateForTokenMode(turn.prompt, maxChars)}`;
    }
    if (turn instanceof vscode.ChatResponseTurn) {
      return `Assistant: ${truncateForTokenMode(turn.response.map((part) => String(part)).join(' '), maxChars)}`;
    }
    return '';
  }

  private async invokeToolForModel(
    toolCall: vscode.LanguageModelToolCallPart,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResultPart> {
    try {
      const result = await vscode.lm.invokeTool(
        toolCall.name,
        {
          input: toolCall.input as Record<string, unknown>,
          toolInvocationToken: request.toolInvocationToken,
        },
        token,
      );
      return new vscode.LanguageModelToolResultPart(toolCall.callId, result.content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getOutputChannel().appendLine(`[CodeBrain Chat] Tool ${toolCall.name} failed: ${message}`);
      return new vscode.LanguageModelToolResultPart(toolCall.callId, [
        new vscode.LanguageModelTextPart(`Tool ${toolCall.name} failed: ${message}`),
      ]);
    }
  }

  private async sendModelRequest(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    model: vscode.LanguageModelChat,
    intent: WorkflowIntent,
    selectedTools: vscode.LanguageModelToolInformation[],
  ): Promise<vscode.ChatResult> {
    const messages = this.buildInitialMessages(request, chatContext, intent);

    for (let round = 0; round < MAX_TOOL_CALL_ROUNDS; round += 1) {
      const toolSelection = this.selectToolsForRound(selectedTools, intent, request, round);
      const response = await model.sendRequest(
        messages,
        {
          justification: `CodeBrain v2 workflow: ${WORKFLOW_DEFINITIONS[intent.workflow].slashCommand}`,
          tools: toolSelection.tools,
          toolMode: toolSelection.toolMode,
        },
        token,
      );

      const textParts: vscode.LanguageModelTextPart[] = [];
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
        }
      }

      if (toolCalls.length === 0) {
        const text = textParts.map((part) => part.value).join('');
        if (text.trim()) {
          stream.markdown(text);
        }
        return {};
      }

      messages.push(vscode.LanguageModelChatMessage.Assistant([...textParts, ...toolCalls]));
      const toolResults = await Promise.all(
        toolCalls.map((toolCall) => this.invokeToolForModel(toolCall, request, token)),
      );
      messages.push(vscode.LanguageModelChatMessage.User(toolResults));
    }

    messages.push(
      vscode.LanguageModelChatMessage.User(
        'Tool-call budget reached. Use the MCP tool results above to answer now. Include the mandatory CodeBrain v2 context and token-reduction sections. Do not request additional tool calls.',
      ),
    );
    const finalResponse = await model.sendRequest(messages, {
      justification: 'CodeBrain final answer mode',
    }, token);

    let text = '';
    for await (const part of finalResponse.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      }
    }
    stream.markdown(text.trim() || 'CodeBrain gathered CodeGraph results but did not receive a final answer.');
    return {};
  }

  private maybeHandleEmptyRequest(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): vscode.ChatResult | undefined {
    if (request.prompt.trim() || request.references.length > 0 || request.toolReferences.length > 0) {
      return undefined;
    }

    const examples = [
      '`@CodeBrain /architecture auth module`',
      '`@CodeBrain /explain authentication flow`',
      '`@CodeBrain /impact UserService.authenticate`',
      '`@CodeBrain /review`',
      '`@CodeBrain /test AuthService.login`',
      '`@CodeBrain /plan ABC-123 implement checkout timeout fix from the linked collab doc`',
    ];

    stream.markdown(['Tell CodeBrain what code, symbol, flow, or problem to work on.', '', 'Examples:', ...examples.map((example) => `- ${example}`)].join('\n'));
    stream.button({ command: 'codebrain.analyze', title: 'Analyze Workspace' });
    return { metadata: { handledBy: 'emptyRequest' } };
  }

  private maybeHandleClarification(
    intent: WorkflowIntent,
    stream: vscode.ChatResponseStream,
  ): vscode.ChatResult | undefined {
    if (!intent.needsClarification) {
      return undefined;
    }

    stream.markdown(buildClarificationMarkdown(intent.rawPrompt));
    stream.button({ command: 'codebrain.workflow.explain', title: 'Explain Flow' });
    stream.button({ command: 'codebrain.workflow.impact', title: 'Analyze Impact' });
    stream.button({ command: 'codebrain.workflow.review', title: 'Review Changes' });
    stream.button({ command: 'codebrain.workflow.plan', title: 'Generate Plan' });
    stream.button({ command: 'codebrain.workflow.test', title: 'Generate Test Plan' });
    return { metadata: { handledBy: 'intentClarification', intent } };
  }

  getHandler(): vscode.ChatRequestHandler {
    return async (request, chatContext, stream, token): Promise<vscode.ChatResult> => {
      const empty = this.maybeHandleEmptyRequest(request, stream);
      if (empty) {
        return empty;
      }

      const intent = this.resolveIntent(request);
      const clarification = this.maybeHandleClarification(intent, stream);
      if (clarification) {
        return clarification;
      }

      const model = await this.resolveModel(request);
      if (!model) {
        const message = 'No language model available. Ensure GitHub Copilot is signed in and active.';
        stream.markdown(message);
        return { errorDetails: { message } };
      }

      try {
        return await this.sendModelRequest(
          request,
          chatContext,
          stream,
          token,
          model,
          intent,
          this.selectToolsForIntent(intent),
        );
      } catch (error) {
        if (token.isCancellationRequested) {
          return { metadata: { cancelled: true } };
        }

        const message = error instanceof Error ? error.message : String(error);
        getOutputChannel().appendLine(`[CodeBrain Chat] Request failed: ${message}`);
        stream.markdown(
          [
            'CodeBrain could not complete this chat request.',
            '',
            `Reason: ${message}`,
            '',
            'Check the CodeBrain output channel, then verify the selected MCP tools are available.',
          ].join('\n'),
        );
        return { errorDetails: { message } };
      }
    };
  }

  getFollowupProvider(): vscode.ChatFollowupProvider {
    return {
      provideFollowups: () => [
        { prompt: '/architecture current workspace', label: 'Explain architecture' },
        { prompt: '/impact selected symbol', label: 'Analyze impact' },
        { prompt: '/review', label: 'Review changes' },
        { prompt: '/plan selected symbol', label: 'Generate plan' },
      ],
    };
  }
}

export const createCodeGraphParticipant = (
  context: vscode.ExtensionContext,
): vscode.ChatParticipant => {
  const agent = new CodeGraphAgentParticipant(context);
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, agent.getHandler());
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.png');
  participant.followupProvider = agent.getFollowupProvider();
  return participant;
};
