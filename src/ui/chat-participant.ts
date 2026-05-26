import * as vscode from 'vscode';
import { getActiveContext } from '../process/group-context.js';
import { getOutputChannel } from '../process/cli-runner.js';

const PARTICIPANT_ID = 'codebrain.gitnexus';

type CommandMode = 'default' | 'explain' | 'impact' | 'debug' | 'refactor';

type InstructionSectionKey =
  | 'yourRole'
  | 'beforeAnyCodeChange'
  | 'commandSpecificBehavior'
  | 'beforeRenaming'
  | 'beforeExtractingOrSplittingCode'
  | 'beforeCommitting'
  | 'whenDebugging'
  | 'whenExploringCode'
  | 'absoluteProhibitions'
  | 'outputFormat'
  | 'userCommunication';

type InstructionMap = Partial<Record<InstructionSectionKey, string>>;

const SECTION_TITLE_TO_KEY: Record<string, InstructionSectionKey> = {
  'your role': 'yourRole',
  'before any code change': 'beforeAnyCodeChange',
  'command-specific behavior': 'commandSpecificBehavior',
  'before renaming': 'beforeRenaming',
  'before extracting/splitting code': 'beforeExtractingOrSplittingCode',
  'before committing': 'beforeCommitting',
  'when debugging': 'whenDebugging',
  'when exploring code': 'whenExploringCode',
  'absolute prohibitions': 'absoluteProhibitions',
  'output format': 'outputFormat',
  'user communication': 'userCommunication',
};

const READ_ONLY_TOOL_KEYWORDS = [
  'context',
  'detect',
  'diff',
  'explore',
  'fetch',
  'find',
  'get',
  'grep',
  'impact',
  'list',
  'map',
  'open',
  'query',
  'read',
  'route',
  'search',
  'shape',
  'show',
  'status',
  'symbol',
  'tree',
  'workspace',
];

const MUTATING_TOOL_KEYWORDS = [
  'add',
  'analyze',
  'apply',
  'clean',
  'commit',
  'create',
  'delete',
  'edit',
  'generate',
  'install',
  'move',
  'patch',
  'pull',
  'push',
  'remove',
  'rename',
  'replace',
  'reset',
  'run',
  'serve',
  'setup',
  'shell',
  'sync',
  'terminal',
  'update',
  'write',
];

const EDIT_INTENT_PATTERN = /\b(add|apply|change|create|delete|edit|extract|fix|implement|move|patch|refactor|remove|rename|replace|split|update|write)\b/i;
const MAX_TOOL_CALL_ROUNDS = 3;

const FALLBACK_INSTRUCTIONS: InstructionMap = {
  yourRole: [
    'You are a GitNexus code-intelligence assistant powered by the GitNexus knowledge graph.',
    'Use available GitNexus tools to explain code structure, impact, refactoring, and debugging.',
  ].join('\n'),
  beforeAnyCodeChange: [
    'Before code changes: identify the target symbol, run gitnexus_impact upstream, report direct callers (d=1), and warn on HIGH or CRITICAL risk.',
  ].join('\n'),
  commandSpecificBehavior: [
    '/explain: read-only by default.',
    '/impact: prioritize blast radius and risk.',
    '/debug: diagnose root cause first, then minimal fixes if asked.',
    '/refactor: action-oriented; implement requested changes after impact analysis.',
  ].join('\n'),
  beforeRenaming: 'Use gitnexus_rename with dry_run before any rename.',
  beforeExtractingOrSplittingCode: 'Before extraction or moves, run gitnexus_context and gitnexus_impact and handle all direct dependents.',
  beforeCommitting: 'Before commit guidance, run gitnexus_detect_changes(scope: all) and verify scope.',
  whenDebugging: 'Use gitnexus_query for symptoms, inspect execution flows, then use gitnexus_context on suspect symbols.',
  whenExploringCode: 'Use gitnexus_query for concepts and gitnexus_context for symbol relationships and execution flow.',
  absoluteProhibitions: [
    'Never rename with find-and-replace; use gitnexus_rename.',
    'Never ignore HIGH or CRITICAL impact warnings.',
    'Never suggest commits without gitnexus_detect_changes.',
  ].join('\n'),
  outputFormat: 'Respond with concise structured sections: Context, Findings, Recommendation, Self-check.',
  userCommunication: 'Be direct, actionable, transparent about tool results, and explicit about risks.',
};

export class GitNexusAgentParticipant {
  private readonly context: vscode.ExtensionContext;
  private instructionSectionsCache?: InstructionMap;

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

  private normalizeCommand(request: vscode.ChatRequest): CommandMode {
    const command = (request.command ?? '').toLowerCase();
    if (command === 'explain' || command === 'impact' || command === 'debug' || command === 'refactor') {
      return command;
    }

    return 'default';
  }

  private promptLooksLikeEditRequest(prompt: string): boolean {
    return EDIT_INTENT_PATTERN.test(prompt);
  }

  private parseInstructionSections(raw: string): InstructionMap {
    const sections: InstructionMap = {};
    const lines = raw.split(/\r?\n/);
    let currentKey: InstructionSectionKey | undefined;
    let buffer: string[] = [];

    const flush = () => {
      if (!currentKey) {
        buffer = [];
        return;
      }

      const value = buffer.join('\n').trim();
      if (value) {
        sections[currentKey] = value;
      }
      buffer = [];
    };

    for (const line of lines) {
      const sectionMatch = line.match(/^###\s+(.*)$/);
      if (sectionMatch) {
        flush();
        currentKey = SECTION_TITLE_TO_KEY[sectionMatch[1].trim().toLowerCase()];
        continue;
      }

      const majorSectionMatch = line.match(/^##\s+(.*)$/);
      if (majorSectionMatch) {
        flush();
        currentKey = SECTION_TITLE_TO_KEY[majorSectionMatch[1].trim().toLowerCase()];
        continue;
      }

      if (currentKey) {
        buffer.push(line);
      }
    }

    flush();
    return sections;
  }

  private async getInstructionSections(): Promise<InstructionMap> {
    if (this.instructionSectionsCache) {
      return this.instructionSectionsCache;
    }

    try {
      const uri = vscode.Uri.joinPath(this.context.extensionUri, 'gitnexus-chat-participant.instructions.md');
      const raw = await vscode.workspace.fs.readFile(uri);
      this.instructionSectionsCache = {
        ...FALLBACK_INSTRUCTIONS,
        ...this.parseInstructionSections(Buffer.from(raw).toString('utf8')),
      };
    } catch {
      this.instructionSectionsCache = FALLBACK_INSTRUCTIONS;
    }

    return this.instructionSectionsCache;
  }

  private buildRelevantInstructions(
    sections: InstructionMap,
    request: vscode.ChatRequest,
  ): string {
    const command = this.normalizeCommand(request);
    const selectedKeys: InstructionSectionKey[] = ['yourRole', 'absoluteProhibitions', 'userCommunication'];

    switch (command) {
      case 'explain':
        selectedKeys.push('commandSpecificBehavior', 'whenExploringCode', 'outputFormat');
        break;
      case 'impact':
        selectedKeys.push('beforeAnyCodeChange', 'commandSpecificBehavior', 'outputFormat');
        break;
      case 'debug':
        selectedKeys.push('beforeAnyCodeChange', 'commandSpecificBehavior', 'whenDebugging', 'outputFormat');
        break;
      case 'refactor':
        selectedKeys.push(
          'beforeAnyCodeChange',
          'commandSpecificBehavior',
          'beforeRenaming',
          'beforeExtractingOrSplittingCode',
          'beforeCommitting',
          'outputFormat',
        );
        break;
      default:
        selectedKeys.push('beforeAnyCodeChange', 'commandSpecificBehavior', 'whenExploringCode');
        break;
    }

    const uniqueKeys = [...new Set(selectedKeys)];
    return uniqueKeys
      .map((key) => sections[key]?.trim())
      .filter((value): value is string => Boolean(value))
      .join('\n\n');
  }

  /**
   * Resolve a concrete model from the request.
   * The chat UI may provide an "auto" placeholder model which doesn't map to a real endpoint.
   */
  private async resolveConcreteModel(request: vscode.ChatRequest): Promise<vscode.LanguageModelChat | undefined> {
    const isAuto = (m: vscode.LanguageModelChat) => {
      const id = m.id?.toLowerCase() ?? '';
      const family = m.family?.toLowerCase() ?? '';
      return id === 'auto' || family === 'auto';
    };

    if (request.model && !isAuto(request.model)) {
      return request.model;
    }

    // "auto" or missing — pick the best concrete Copilot model available
    const copilot = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    const concrete = copilot.find((m) => !isAuto(m));
    if (concrete) {
      return concrete;
    }

    const all = await vscode.lm.selectChatModels();
    return all.find((m) => !isAuto(m)) ?? all[0];
  }

  private buildCommandPrompt(request: vscode.ChatRequest): string {
    const command = this.normalizeCommand(request);
    const editIntent = this.promptLooksLikeEditRequest(request.prompt);
    switch (command) {
      case 'explain':
        return [
          'Slash command mode: /explain.',
          'Focus on understanding and explanation only.',
          'Use read/search/context tools to gather evidence.',
          'Do not create or edit files unless user explicitly asks to modify code.',
        ].join('\n');
      case 'impact':
        return [
          'Slash command mode: /impact.',
          'Run impact analysis first and report blast radius, direct dependents (d=1), and risk level.',
          'If risk is HIGH or CRITICAL, clearly warn before proposing changes.',
        ].join('\n');
      case 'debug':
        return [
          'Slash command mode: /debug.',
          'Prioritize root-cause analysis, execution flow tracing, and minimal-risk fixes.',
          editIntent
            ? 'The prompt appears to ask for a fix. Diagnose first, then apply small targeted edits with tools and explain why.'
            : 'The prompt appears diagnostic. Stay read-only unless the user explicitly asks for a fix.',
        ].join('\n');
      case 'refactor':
        return [
          'Slash command mode: /refactor.',
          'This mode is action-oriented.',
          'When the user asks to implement changes, execute them directly with available tools (edit/create files) instead of only returning suggestions.',
          'Before changing symbols, run impact analysis and show key risk findings.',
          'After edits, summarize changed files and what was updated.',
        ].join('\n');
      default:
        return [
          'No slash command selected.',
          'Infer intent from the prompt and choose tools accordingly.',
          editIntent
            ? 'The prompt appears to request implementation. Use tools to perform the change after required GitNexus safety checks.'
            : 'The prompt does not clearly request implementation. Prefer read-only exploration and ask for confirmation before edits.',
        ].join('\n');
    }
  }

  private buildWorkspacePrompt(): string | undefined {
    const lines: string[] = [];
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length > 0) {
      lines.push(`Workspace folders: ${folders.map((folder) => folder.name).join(', ')}.`);
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const relativePath = vscode.workspace.asRelativePath(activeEditor.document.uri, false);
      const selection = activeEditor.selection;
      lines.push(`Active editor: ${relativePath}.`);
      if (!selection.isEmpty) {
        lines.push(`Active selection: lines ${selection.start.line + 1}-${selection.end.line + 1}.`);
      } else {
        lines.push(`Cursor line: ${selection.active.line + 1}.`);
      }
    }

    return lines.length ? lines.join('\n') : undefined;
  }

  private buildReferencePrompt(request: vscode.ChatRequest): string | undefined {
    if (request.references.length === 0 && request.toolReferences.length === 0) {
      return undefined;
    }

    const lines: string[] = [];
    if (request.references.length > 0) {
      const refs = request.references.slice(0, 8).map((ref) => {
        const description = ref.modelDescription ?? ref.id;
        const value = this.describeReferenceValue(ref.value);
        return value ? `${description}: ${value}` : description;
      });
      lines.push(`Attached references: ${refs.join('; ')}.`);
    }

    if (request.toolReferences.length > 0) {
      lines.push(`User-attached tools: ${request.toolReferences.map((tool) => tool.name).join(', ')}.`);
    }

    return lines.join('\n');
  }

  private describeReferenceValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }

    if (value instanceof vscode.Uri) {
      return vscode.workspace.asRelativePath(value, false);
    }

    if (value instanceof vscode.Location) {
      const path = vscode.workspace.asRelativePath(value.uri, false);
      return `${path}:${value.range.start.line + 1}`;
    }

    return undefined;
  }

  private isUsableTool(tool: vscode.LanguageModelToolInformation): boolean {
    const name = tool.name.toLowerCase();

    // Skip known schema-problematic GitKraken workspace tools. They can make the
    // model request fail before CodeBrain has a chance to answer.
    if (name.includes('mcp_gitkraken') && name.includes('workspace')) {
      return false;
    }

    return typeof tool.inputSchema === 'object' || typeof tool.inputSchema === 'undefined';
  }

  private isReadOnlyTool(tool: vscode.LanguageModelToolInformation): boolean {
    const haystack = `${tool.name} ${tool.description} ${tool.tags.join(' ')}`.toLowerCase();
    const isMutating = MUTATING_TOOL_KEYWORDS.some((keyword) => haystack.includes(keyword));
    if (isMutating) {
      return false;
    }

    return READ_ONLY_TOOL_KEYWORDS.some((keyword) => haystack.includes(keyword));
  }

  private toChatTool(tool: vscode.LanguageModelToolInformation): vscode.LanguageModelChatTool {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
  }

  private selectToolsForRequest(request: vscode.ChatRequest): readonly vscode.LanguageModelToolInformation[] {
    const command = this.normalizeCommand(request);
    const validTools = vscode.lm.tools.filter((tool) => this.isUsableTool(tool));

    if (command === 'explain' || command === 'impact' || (command === 'debug' && !this.promptLooksLikeEditRequest(request.prompt))) {
      return validTools.filter((tool) => this.isReadOnlyTool(tool));
    }

    // /refactor and /debug should keep full capabilities including file edits.
    return validTools;
  }

  private buildHistoryPrompt(chatContext: vscode.ChatContext): string | undefined {
    const turns = chatContext.history.slice(-6);
    if (turns.length === 0) {
      return undefined;
    }

    const lines: string[] = [];
    for (const turn of turns) {
      if (turn instanceof vscode.ChatRequestTurn) {
        lines.push(`User: ${turn.prompt}`);
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .map((part) => {
            if (part instanceof vscode.ChatResponseMarkdownPart) {
              return part.value.value;
            }
            if (part instanceof vscode.ChatResponseAnchorPart) {
              return part.value instanceof vscode.Uri ? part.value.fsPath : part.value.uri.fsPath;
            }
            return '';
          })
          .join('')
          .trim();
        if (text) {
          lines.push(`Assistant: ${text.slice(0, 2000)}`);
        }
      }
    }

    return lines.length ? lines.join('\n\n') : undefined;
  }

  private buildInitialMessages(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    contextPrompt: string,
  ): vscode.LanguageModelChatMessage[] {
    const parts = [contextPrompt];
    const historyPrompt = this.buildHistoryPrompt(chatContext);
    if (historyPrompt) {
      parts.push(`Recent chat history:\n${historyPrompt}`);
    }
    parts.push(`Current user request:\n${request.prompt}`);

    return [vscode.LanguageModelChatMessage.User(parts.join('\n\n'))];
  }

  private selectToolsForRound(
    allTools: readonly vscode.LanguageModelToolInformation[],
    request: vscode.ChatRequest,
    round: number,
  ): { tools: vscode.LanguageModelChatTool[] | undefined; toolMode?: vscode.LanguageModelChatToolMode } {
    if (round === 0 && request.toolReferences.length > 0) {
      const attached = request.toolReferences
        .map((reference) => vscode.lm.tools.find((tool) => tool.name === reference.name))
        .filter((tool): tool is vscode.LanguageModelToolInformation => Boolean(tool))
        .filter((tool) => this.isUsableTool(tool));

      if (attached.length > 0) {
        return {
          tools: attached.map((tool) => this.toChatTool(tool)),
          toolMode: vscode.LanguageModelChatToolMode.Required,
        };
      }
    }

    return {
      tools: allTools.length > 0 ? allTools.map((tool) => this.toChatTool(tool)) : undefined,
      toolMode: undefined,
    };
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
          input: toolCall.input,
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

  private async sendFinalAnswerRequest(
    messages: vscode.LanguageModelChatMessage[],
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    model: vscode.LanguageModelChat,
  ): Promise<vscode.ChatResult> {
    messages.push(vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelTextPart([
        'Tool-call budget reached.',
        'Use the tool results already provided above to answer the current user request now.',
        'Do not request or mention additional tool calls.',
        'If evidence is incomplete, state what is missing and give the best next action.',
      ].join(' ')),
    ]));

    const response = await model.sendRequest(
      messages,
      {
        justification: `CodeBrain final answer mode: /${request.command ?? 'default'}`,
      },
      token,
    );

    let text = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      }
    }

    if (text.trim()) {
      stream.markdown(text);
      return {};
    }

    const message = 'CodeBrain gathered tool results but the model did not produce a final answer.';
    stream.markdown(message);
    return { errorDetails: { message } };
  }

  private async sendModelRequest(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    model: vscode.LanguageModelChat,
    contextPrompt: string,
    selectedTools: readonly vscode.LanguageModelToolInformation[],
  ): Promise<vscode.ChatResult> {
    const messages = this.buildInitialMessages(request, chatContext, contextPrompt);

    for (let round = 0; round < MAX_TOOL_CALL_ROUNDS; round += 1) {
      const toolSelection = this.selectToolsForRound(selectedTools, request, round);
      const response = await model.sendRequest(
        messages,
        {
          justification: `CodeBrain command mode: /${request.command ?? 'default'}`,
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
        if (text) {
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

    return this.sendFinalAnswerRequest(messages, request, stream, token, model);
  }

  private maybeHandleEmptyRequest(request: vscode.ChatRequest, stream: vscode.ChatResponseStream): vscode.ChatResult | undefined {
    if (request.prompt.trim() || request.references.length > 0 || request.toolReferences.length > 0) {
      return undefined;
    }

    const command = this.normalizeCommand(request);
    const examples: Record<CommandMode, string[]> = {
      default: [
        '`@CodeBrain /explain authentication flow`',
        '`@CodeBrain /impact UserService.authenticate`',
        '`@CodeBrain /debug Login intermittently times out`',
        '`@CodeBrain /refactor Rename parseConfig to parseWorkspaceConfig`',
      ],
      explain: [
        '`@CodeBrain /explain src/ui/chat-participant.ts`',
        '`@CodeBrain /explain how active repo context is resolved`',
      ],
      impact: [
        '`@CodeBrain /impact GitNexusAgentParticipant`',
        '`@CodeBrain /impact runCodeBrain`',
      ],
      debug: [
        '`@CodeBrain /debug MCP server fails to start`',
        '`@CodeBrain /debug chat participant returns no language model available`',
      ],
      refactor: [
        '`@CodeBrain /refactor extract instruction parsing into a helper`',
        '`@CodeBrain /refactor rename GitNexusAgentParticipant to CodeBrainChatParticipant`',
      ],
    };

    stream.markdown([
      'Tell CodeBrain what code, symbol, flow, or problem to work on.',
      '',
      'Examples:',
      ...examples[command].map((example) => `- ${example}`),
    ].join('\n'));

    stream.button({ command: 'codebrain.analyze', title: 'Analyze Active Context' });
    return { metadata: { codebrainCommand: command, handledBy: 'emptyRequest' } };
  }

  private buildErrorResult(error: unknown, stream: vscode.ChatResponseStream): vscode.ChatResult {
    const message = error instanceof Error ? error.message : String(error);
    const outputChannel = getOutputChannel();
    outputChannel.appendLine(`[CodeBrain Chat] Request failed: ${message}`);
    if (error instanceof Error && error.stack) {
      outputChannel.appendLine(error.stack);
    }

    stream.markdown([
      'CodeBrain could not complete this chat request.',
      '',
      `Reason: ${message}`,
      '',
      'Check the CodeBrain output channel for details, then retry after verifying Copilot and the GitNexus MCP tools are available.',
    ].join('\n'));

    return { errorDetails: { message } };
  }

  private sanitizeChatContext(chatContext: vscode.ChatContext): vscode.ChatContext {
    return {
      history: chatContext.history.filter((turn) => {
        if (!(turn instanceof vscode.ChatResponseTurn)) {
          return true;
        }

        return !turn.result.metadata?.toolCallsMetadata;
      }),
    };
  }

  private buildResultMetadata(
    metadata: vscode.ChatResult['metadata'],
    command: CommandMode,
    defaultRepoScope: string | undefined,
    selectedToolCount: number,
  ): vscode.ChatResult['metadata'] {
    const { toolCallsMetadata: _toolCallsMetadata, ...safeMetadata } = metadata ?? {};
    return {
      ...safeMetadata,
      codebrainCommand: command,
      activeGitNexusScope: defaultRepoScope,
      selectedToolCount,
    };
  }

  public getFollowupProvider(): vscode.ChatFollowupProvider {
    return {
      provideFollowups: (result) => {
        const command = (result.metadata?.codebrainCommand ?? 'default') as CommandMode;
        const followups: Record<CommandMode, vscode.ChatFollowup[]> = {
          default: [
            { label: 'Explain current file', prompt: 'Explain the active file and its main execution flow.', command: 'explain' },
            { label: 'Run impact analysis', prompt: 'Run impact analysis for the main symbol I am working on.', command: 'impact' },
            { label: 'Debug a failure', prompt: 'Help me debug the failure I am seeing and trace the root cause.', command: 'debug' },
          ],
          explain: [
            { label: 'Check impact', prompt: 'Run impact analysis for the main symbol from this explanation.', command: 'impact' },
            { label: 'Find callers', prompt: 'Find the direct callers and callees for the main symbol.', command: 'explain' },
          ],
          impact: [
            { label: 'Plan refactor', prompt: 'Create a safe refactoring plan for this impacted symbol.', command: 'refactor' },
            { label: 'Explain flow', prompt: 'Explain the affected execution flow in more detail.', command: 'explain' },
          ],
          debug: [
            { label: 'Apply minimal fix', prompt: 'Apply the smallest safe fix for the diagnosed issue.', command: 'refactor' },
            { label: 'Check impact', prompt: 'Run impact analysis for the suspect symbol.', command: 'impact' },
          ],
          refactor: [
            { label: 'Verify scope', prompt: 'Verify the changed scope and summarize affected execution flows.', command: 'impact' },
            { label: 'Explain changes', prompt: 'Explain what changed and why it is safe.', command: 'explain' },
          ],
        };

        return followups[command] ?? followups.default;
      },
    };
  }

  public getHandler() {
    return async (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> => {
      const emptyResult = this.maybeHandleEmptyRequest(request, stream);
      if (emptyResult) {
        return emptyResult;
      }

      const command = this.normalizeCommand(request);
      const instructionSections = await this.getInstructionSections();
      const instructions = this.buildRelevantInstructions(instructionSections, request);
      const defaultRepoScope = this.getDefaultRepoScope();

      // Resolve a concrete model; "auto" has no real endpoint and causes LM errors.
      const model = await this.resolveConcreteModel(request);
      if (!model) {
        const message = 'No language model available. Ensure GitHub Copilot is signed in and active.';
        stream.markdown(message);
        return { errorDetails: { message } };
      }

      // Build active scope context into the prompt
      let contextPrompt = instructions;
      contextPrompt += `\n\n${this.buildCommandPrompt(request)}`;
      const workspacePrompt = this.buildWorkspacePrompt();
      if (workspacePrompt) {
        contextPrompt += `\n\n${workspacePrompt}`;
      }

      const referencePrompt = this.buildReferencePrompt(request);
      if (referencePrompt) {
        contextPrompt += `\n\n${referencePrompt}`;
      }

      if (defaultRepoScope) {
        contextPrompt += `\n\nActive GitNexus scope: ${defaultRepoScope}. Use this as default tool "repo" when not explicitly specified by the user.`;
      } else {
        contextPrompt += '\n\nNo active GitNexus scope is set. Prefer discovering indexed repos/groups before using GitNexus tools that require a repo.';
      }

      const tools = this.selectToolsForRequest(request);

      try {
        const chatResult = await this.sendModelRequest(
          request,
          this.sanitizeChatContext(chatContext),
          stream,
          token,
          model,
          contextPrompt,
          tools,
        );

        return {
          ...chatResult,
          metadata: this.buildResultMetadata(chatResult.metadata, command, defaultRepoScope, tools.length),
        };
      } catch (error) {
        if (token.isCancellationRequested) {
          return { metadata: { codebrainCommand: command, cancelled: true } };
        }
        return this.buildErrorResult(error, stream);
      }
    };
  }
}

export const createGitNexusParticipant = (context: vscode.ExtensionContext): vscode.ChatParticipant => {
  const agent = new GitNexusAgentParticipant(context);
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, agent.getHandler());
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.png');
  participant.followupProvider = agent.getFollowupProvider();
  return participant;
};
