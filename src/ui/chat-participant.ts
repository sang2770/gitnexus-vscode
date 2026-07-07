import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  ContextAnalysisService,
  extractContextFilesFromText,
  formatContextAnalysisMarkdown,
  isContextReportEnabled,
} from '../process/context-analysis.js';
import { getOutputChannel, getWorkspaceRoot } from '../process/cli-runner.js';
import { hasWorkingTreeDiff, isInsideGitWorkTree } from '../process/review-git.js';
import {
  buildTokenReductionMarkdown,
  createTokenReductionReport,
  estimateTokens,
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
  type CodeBrainWorkflowKind,
  type IntentTargetType,
} from '../workflows/intent-resolver.js';
import { chatOptimizationManager } from './chat-optimization-config.js';
import { buildFallbackMermaidMarkdown, extractMermaidMarkdownFromResponse, writeDiagramPreviewFile } from './diagram-generation.js';
import { chatMetricsCollector } from './chat-metrics.js';

interface ConversationState {
  lastIntent?: WorkflowIntent;
  seenFiles: Set<string>;
  seenSymbols: Set<string>;
  toolResultSummary: string[];
  lastUpdate: number;
}

type AssistantReplayPart =
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelToolCallPart
  | vscode.LanguageModelDataPart;

interface GroundedToolResult {
  kind: CodeGraphToolKind;
  toolName: string;
  text: string;
}

const PARTICIPANT_ID = 'codebrain.codegraph';
const MAX_TOOL_CALL_ROUNDS = 5;
const CONTEXT_REPORT_WORKFLOWS = new Set<WorkflowIntent['workflow']>([
  'architecture',
  'explain',
  'impact',
  'review',
  'test',
  'detect_change',
  'plan',
]);

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

function getTargetType(target: string | undefined | null, workflow: string): IntentTargetType {
  if (!target) {
    return 'unknown';
  }
  if (workflow === 'review' || workflow === 'detect_change') {
    return 'diff';
  }
  if (target.includes('.') || target.includes('::') || /^[A-Z]/.test(target)) {
    return 'symbol';
  }
  if (target.includes('/') || target.includes('\\')) {
    return 'file';
  }
  return 'task';
}

export class CodeGraphAgentParticipant {
  private conversationStates = new Map<string, ConversationState>();
  private instructionCache = new Map<string, { instructions: string, timestamp: number }>();
  private readonly contextAnalysisService = new ContextAnalysisService();
  private lastCleanup = Date.now();

  constructor(private readonly context: vscode.ExtensionContext) {
    // Regular cleanup of old session states
    setInterval(() => this.cleanupStates(), 15 * 60 * 1000);
  }

  private cleanupStates(): void {
    const now = Date.now();
    const config = chatOptimizationManager.getConfig();
    for (const [id, state] of this.conversationStates.entries()) {
      if (now - state.lastUpdate > config.stateCleanupIntervalMs) {
        this.conversationStates.delete(id);
      }
    }
  }

  private getOrCreateState(request: vscode.ChatRequest): ConversationState {
    const id = request.command || 'default';
    let state = this.conversationStates.get(id);
    if (!state) {
      state = {
        seenFiles: new Set(),
        seenSymbols: new Set(),
        toolResultSummary: [],
        lastUpdate: Date.now(),
      };
      this.conversationStates.set(id, state);
    }
    state.lastUpdate = Date.now();
    return state;
  }

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

  private async resolveIntentWithAI(
    request: vscode.ChatRequest,
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken,
  ): Promise<WorkflowIntent | undefined> {
    const workspaceRoot = getWorkspaceRoot();
    const editorContext = getEditorIntentContext(workspaceRoot);
    
    const classificationPrompt = [
      'You are an intent classifier for CodeBrain, a repository-aware AI coding assistant.',
      'Your task is to classify the user\'s request into one of the following workflows and extract the target symbol, file, or task description.',
      '',
      'Available workflows:',
      '- "architecture": Explain repository architecture, module map, or onboarding.',
      '- "explain": Explain a symbol (class, function), execution flow, or file.',
      '- "impact": Analyze the impact, blast radius, callers, or callees of a specific symbol.',
      '- "review": Review current git changes, PRs, or diffs.',
      '- "detect_change": Detect impact/risk of pending changes in the working tree.',
      '- "test": Generate a test plan or test cases for a symbol or behavior.',
      '- "diagram": Generate a Mermaid flow diagram, sequence diagram, or chart for a symbol or flow.',
      '- "plan": Generate an implementation plan, fix plan, or task for a bug, feature, or Jira ticket.',
      '',
      'Editor context details:',
      `- Active file: ${editorContext.relativeFilePath ?? 'None'}`,
      `- Selected symbol: ${editorContext.selectedSymbol ?? 'None'}`,
      `- Cursor symbol: ${editorContext.cursorSymbol ?? 'None'}`,
      `- Selected text: ${editorContext.selectedText ?? 'None'}`,
      '',
      `User request: "${request.prompt}"`,
      '',
      'Respond with a JSON object matching this schema:',
      '{',
      '  "workflow": "architecture" | "explain" | "impact" | "review" | "detect_change" | "test" | "diagram" | "plan",',
      '  "target": "string or null"',
      '}',
      'Provide only the JSON object, without any markdown block wrapper or extra text.'
    ].join('\n');

    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(classificationPrompt)],
        { justification: 'CodeBrain intent classification' },
        token,
      );

      let text = '';
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
        }
      }

      const cleaned = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const VALID_WORKFLOWS = new Set([
        'architecture',
        'explain',
        'impact',
        'review',
        'detect_change',
        'test',
        'diagram',
        'plan',
      ]);

      if (parsed && typeof parsed.workflow === 'string' && VALID_WORKFLOWS.has(parsed.workflow)) {
        const workflow = parsed.workflow as CodeBrainWorkflowKind;
        const target = typeof parsed.target === 'string' ? parsed.target : undefined;
        const targetType = getTargetType(target, workflow);
        const tokenSettings = getTokenOptimizationSettings(WORKFLOW_DEFINITIONS[workflow].contextMode);

        return {
          workflow,
          target,
          targetType,
          contextMode: tokenSettings.effectiveMode,
          confidence: 0.9,
          source: 'heuristic',
          needsClarification: false,
          rawPrompt: request.prompt,
        };
      }
    } catch (error) {
      getOutputChannel().appendLine(`[CodeBrain Chat] AI intent classification failed: ${error}`);
    }
    return undefined;
  }

  private buildInstructions(intent: WorkflowIntent, compact: boolean = false): string {
    const config = chatOptimizationManager.getConfig();
    const cacheKey = `${intent.workflow}_${intent.contextMode}_${compact ? 'compact' : 'full'}`;
    
    if (config.enableInstructionCaching) {
      const cached = this.instructionCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < config.cacheTtlMs)) {
        return cached.instructions;
      }
    }

    const tokenSettings = getTokenOptimizationSettings(intent.contextMode);
    
    if (compact) {
      // Very brief instructions for follow-up turns
      const instructions = [
        `CodeBrain follow-up (${intent.workflow})`,
        `Workspace: ${getWorkspaceRoot()}`,
        `Context: ${intent.contextMode}`,
        'Continue using CodeGraph tools. Maintain workflow output: Context -> Findings -> Plan/Task.',
        'Match the language of the user request in your response.',
      ].join('\n');

      if (config.enableInstructionCaching) {
        this.instructionCache.set(cacheKey, { instructions, timestamp: Date.now() });
      }
      return instructions;
    }

    const definition = WORKFLOW_DEFINITIONS[intent.workflow];
    const supplementalHints = definition.supplementalMcpToolHints ?? [];
    const toolScope = supplementalHints.length > 0
      ? `Use the selected CodeGraph MCP tools plus matching supplemental MCP context tools for this workflow. Supplemental hints: ${supplementalHints.join(', ')}.`
      : 'Use only the CodeGraph MCP tools selected for this workflow unless a later tool result proves a narrower follow-up is necessary.';
    
    const instructions = [
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
      '',
      'Mandatory: Respond in the same language as the user request (including session headers and section titles).',
    ].join('\n');

    if (config.enableInstructionCaching) {
      this.instructionCache.set(cacheKey, { instructions, timestamp: Date.now() });
    }

    return instructions;
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
    const config = chatOptimizationManager.getConfig();
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
    const deduped = this.dedupeTools([...codeGraphTools, ...supplementalTools]);
    return config.enableProgressiveTools ? deduped.slice(0, config.maxToolsTotal) : deduped.slice(0, 12);
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

  private resolveAttachedTools(request: vscode.ChatRequest): vscode.LanguageModelToolInformation[] {
    return request.toolReferences
      .map((ref) => vscode.lm.tools.find((tool) => tool.name === ref.name))
      .filter((tool): tool is vscode.LanguageModelToolInformation => Boolean(tool));
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
    const config = chatOptimizationManager.getConfig();
    const resolvedAttachedTools = this.resolveAttachedTools(request);
    const attachedTools = round === 0 ? resolvedAttachedTools : [];

    if (attachedTools.length > 0) {
      return {
        tools: this.dedupeTools(attachedTools).map((tool) => this.toChatTool(tool)),
        toolMode: attachedTools.length === 1 ? vscode.LanguageModelChatToolMode.Required : vscode.LanguageModelChatToolMode.Auto,
      };
    }
    
    // Phase 2: Progressive Tool Selection
    if (config.enableProgressiveTools && round === 0) {
      const requiredSteps = WORKFLOW_DEFINITIONS[intent.workflow].toolPlan.filter((step) => step.required);
      const essentialTools: vscode.LanguageModelToolInformation[] = [];
      
      // Always include the first required tool kind if available
      if (requiredSteps.length > 0) {
        const tool = this.selectCodeGraphToolByKind(allTools, requiredSteps[0].toolKind);
        if (tool) essentialTools.push(tool);
      }
      
      // Add a generic search/explore if not already there and limit is not reached
      if (essentialTools.length < config.maxToolsRound0) {
        const explore = this.selectCodeGraphToolByKind(allTools, 'explore');
        if (explore && !essentialTools.includes(explore)) essentialTools.push(explore);
      }

      // Add supplemental tools (e.g. Jira, Atlassian) in round 0 so LLM can fetch requirements early
      const hints = WORKFLOW_DEFINITIONS[intent.workflow].supplementalMcpToolHints ?? [];
      if (hints.length > 0) {
        const supps = allTools.filter(
          (t) => !this.isCodeGraphTool(t) && !this.isCodeBrainTool(t) && this.toolMatchesAnyHint(t, hints)
        );
        essentialTools.push(...supps);
      }
      
      if (essentialTools.length > 0) {
        const tools = this.dedupeTools(essentialTools).slice(0, config.maxToolsTotal);
        return {
          tools: tools.map(t => this.toChatTool(t)),
          toolMode: vscode.LanguageModelChatToolMode.Auto,
        };
      }
    }

    const requiredSteps = WORKFLOW_DEFINITIONS[intent.workflow].toolPlan.filter((step) => step.required);
    const workflowRound = Math.max(0, round - (resolvedAttachedTools.length > 0 ? 1 : 0));
    const requiredKind = requiredSteps[workflowRound]?.toolKind;
    if (requiredKind) {
      const tool = this.selectCodeGraphToolByKind(allTools, requiredKind);
      if (tool) {
        return {
          tools: [this.toChatTool(tool)],
          toolMode: vscode.LanguageModelChatToolMode.Required,
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

  private shouldUseTextToolContext(model: vscode.LanguageModelChat): boolean {
    const haystack = [
      model.vendor,
      model.family,
      model.id,
      model.name,
    ].join(' ').toLowerCase();
    return haystack.includes('gemini') || haystack.includes('google');
  }

  private buildInitialPrompt(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    intent: WorkflowIntent,
    modelId?: string,
  ): string {
    const config = chatOptimizationManager.getConfig();
    const historyWindow = chatContext.history.slice(-8);
    const isFollowUp = historyWindow.length > 0;
    
    const tokenSettings = getTokenOptimizationSettings(intent.contextMode);
    const instructions = this.buildInstructions(intent, isFollowUp);
    const optimizedPrompt = this.buildOptimizedPrompt({
      instructions,
      requestPrompt: request.prompt,
      history: historyWindow,
      tokenSettings,
      modelId,
    });
    const beforePrompt = this.composePromptSections({
      instructions,
      requestPrompt: request.prompt,
      history: this.buildHistoryBlock(historyWindow, 1600),
    });
    const report = createTokenReductionReport({
      beforeText: beforePrompt,
      afterText: optimizedPrompt.prompt,
      defaultMode: intent.contextMode,
      source: 'chat-initial-prompt',
      modelId,
    });
    const prompt = this.appendOptionalPromptSection(
      optimizedPrompt.prompt,
      buildTokenReductionMarkdown(report),
      tokenSettings.tokenBudget,
      modelId,
    );

    return prompt;
  }

  private buildOptimizedPrompt(input: {
    instructions: string;
    requestPrompt: string;
    history: Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn>;
    tokenSettings: ReturnType<typeof getTokenOptimizationSettings>;
    modelId?: string;
  }): {
    prompt: string;
    historyTurnLimitUsed: number;
    historyCharsPerTurnUsed: number;
  } {
    const config = chatOptimizationManager.getConfig();
    const enabled = input.tokenSettings.enabled && config.enableSmartHistory;
    
    // Phase 3: Smart History Management
    let recentHistory = input.history;
    if (enabled && config.historyRelevanceFiltering) {
      recentHistory = recentHistory.filter(turn => {
        if (turn instanceof vscode.ChatRequestTurn) {
          return turn.prompt.includes('@CodeBrain') || turn.command !== undefined;
        }
        return true; // Keep assistant responses for context
      });
    }

    const maxHistoryTurns = enabled
      ? Math.min(config.maxHistoryTurns, recentHistory.length)
      : recentHistory.length;
    const maxCharsPerTurn = enabled ? config.historyCharsPerTurn : 1600;
    const minCharsPerTurn = enabled
      ? Math.max(120, Math.floor(input.tokenSettings.historyCharsPerTurn / 3))
      : maxCharsPerTurn;

    let turnLimit = maxHistoryTurns;
    let charsPerTurn = maxCharsPerTurn;
    let historyText = this.buildHistoryBlock(recentHistory.slice(-turnLimit), charsPerTurn);
    let prompt = this.composePromptSections({
      instructions: input.instructions,
      history: historyText,
      requestPrompt: input.requestPrompt,
    });

    if (enabled) {
      while (turnLimit > 0 && estimateTokens(prompt, input.modelId).tokens > input.tokenSettings.tokenBudget) {
        const canShrinkChars = charsPerTurn > minCharsPerTurn;
        const canDropTurn = turnLimit > 1;

        if (canShrinkChars) {
          charsPerTurn = Math.max(minCharsPerTurn, Math.floor(charsPerTurn * 0.8));
        } else if (canDropTurn) {
          turnLimit -= 1;
          charsPerTurn = maxCharsPerTurn;
        } else {
          break;
        }

        historyText = this.buildHistoryBlock(recentHistory.slice(-turnLimit), charsPerTurn);
        prompt = this.composePromptSections({
          instructions: input.instructions,
          history: historyText,
          requestPrompt: input.requestPrompt,
        });
      }
    }

    return {
      prompt,
      historyTurnLimitUsed: turnLimit,
      historyCharsPerTurnUsed: charsPerTurn,
    };
  }

  private buildHistoryBlock(
    history: Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn>,
    maxCharsPerTurn: number,
  ): string | undefined {
    const text = history
      .map((turn) => this.formatHistoryTurn(turn, maxCharsPerTurn))
      .filter(Boolean)
      .join('\n');

    return text || undefined;
  }

  private composePromptSections(input: {
    instructions: string;
    requestPrompt: string;
    history?: string;
  }): string {
    return [
      input.instructions,
      input.history ? `Recent chat history:\n${input.history}` : undefined,
      `Current user request:\n${input.requestPrompt}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private appendOptionalPromptSection(
    prompt: string,
    optionalSection: string,
    tokenBudget: number,
    modelId?: string,
  ): string {
    const candidate = [prompt, optionalSection].join('\n\n');
    return estimateTokens(candidate, modelId).tokens <= tokenBudget ? candidate : prompt;
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

  private async invokeCodeGraphToolForContext(
    tool: vscode.LanguageModelToolInformation,
    kind: CodeGraphToolKind,
    intent: WorkflowIntent,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken,
  ): Promise<GroundedToolResult> {
    const result = await vscode.lm.invokeTool(
      tool.name,
      {
        input: this.buildCodeGraphToolInput(kind, intent, request),
        toolInvocationToken: request.toolInvocationToken,
      },
      token,
    );

    return {
      kind,
      toolName: tool.name,
      text: this.getToolResultContentText(result.content),
    };
  }

  private buildCodeGraphToolInput(
    kind: CodeGraphToolKind,
    intent: WorkflowIntent,
    request: vscode.ChatRequest,
  ): Record<string, unknown> {
    const workspaceRoot = getWorkspaceRoot();
    const target = intent.target ?? (request.prompt.trim() || 'current workspace');
    const query = [intent.target, request.prompt.trim()].filter(Boolean).join('\n') || target;

    switch (kind) {
      case 'status':
        return { projectPath: workspaceRoot };
      case 'files':
        return { format: 'tree', maxDepth: 4, projectPath: workspaceRoot };
      case 'explore':
        return { query, maxFiles: intent.contextMode === 'full' ? 12 : 8, projectPath: workspaceRoot };
      case 'search':
        return { query: target, limit: 12, projectPath: workspaceRoot };
      case 'callers':
      case 'callees':
        return { symbol: target, limit: 20, projectPath: workspaceRoot };
      case 'impact':
        return { symbol: target, depth: 2, projectPath: workspaceRoot };
      case 'node':
        return { symbol: target, includeCode: true, projectPath: workspaceRoot };
    }
  }

  private isReplayableAssistantPart(part: unknown): part is AssistantReplayPart {
    return part instanceof vscode.LanguageModelTextPart ||
      part instanceof vscode.LanguageModelToolCallPart ||
      (part instanceof vscode.LanguageModelDataPart && this.isReplayableDataPart(part));
  }

  private isReplayableDataPart(part: vscode.LanguageModelDataPart): boolean {
    return part.mimeType.toLowerCase() !== 'usage';
  }

  private getToolResultText(result: vscode.LanguageModelToolResultPart): string {
    return this.getToolResultContentText(result.content);
  }

  private getToolResultContentText(content: Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart | vscode.LanguageModelDataPart | unknown>): string {
    const decoder = new TextDecoder();
    return content
      .map((part) => {
        if (part instanceof vscode.LanguageModelTextPart) {
          return part.value;
        }
        if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('text/')) {
          return decoder.decode(part.data);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  private async appendContextAnalysisReport(input: {
    stream: vscode.ChatResponseStream;
    intent: WorkflowIntent;
    optimizedContext: string;
    toolResultTexts: string[];
  }): Promise<void> {
    if (!isContextReportEnabled() || !CONTEXT_REPORT_WORKFLOWS.has(input.intent.workflow)) {
      return;
    }

    try {
      const selectedFiles = Array.from(new Set(input.toolResultTexts.flatMap(extractContextFilesFromText))).sort();
      const report = await this.contextAnalysisService.generateReport({
        workspaceRoot: getWorkspaceRoot(),
        optimizedContext: input.optimizedContext,
        selectedFiles,
      });

      input.stream.markdown(`\n\n${formatContextAnalysisMarkdown(report)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getOutputChannel().appendLine(`[CodeBrain Chat] Context analysis report failed: ${message}`);
    }
  }

  private async sendGroundedModelRequest(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    model: vscode.LanguageModelChat,
    intent: WorkflowIntent,
    selectedTools: vscode.LanguageModelToolInformation[],
    diagramType?: string,
  ): Promise<vscode.ChatResult> {
    const startTime = Date.now();
    let initialPrompt = this.buildInitialPrompt(request, chatContext, intent, model.id);
    if (intent.workflow === 'diagram' && diagramType) {
      initialPrompt += `\n\nMandatory Requirement: Generate exactly one fenced code block using \`\`\`mermaid of type: **${diagramType}**.`;
    }
    const toolResults = await this.collectGroundingToolResults(selectedTools, intent, request, token);
    const toolResultTexts = toolResults.map((result) => result.text).filter((text) => text.trim().length > 0);
    const groundedPrompt = [
      initialPrompt,
      '',
      'CodeBrain MCP tool results:',
      toolResults.length > 0
        ? toolResults.map((result) => [
            `Tool: ${result.toolName}`,
            `Kind: ${result.kind}`,
            result.text || '(no text result)',
          ].join('\n')).join('\n\n')
        : 'No CodeGraph tools were available for this workflow.',
      '',
      'Use the MCP tool results above as the repository evidence. Answer now without requesting tool calls.',
    ].join('\n');

    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(groundedPrompt)],
      { justification: `CodeBrain grounded workflow: ${WORKFLOW_DEFINITIONS[intent.workflow].slashCommand}` },
      token,
    );

    let text = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      }
    }

    const finalText = text.trim() || 'CodeBrain gathered CodeGraph results but did not receive a final answer.';
    if (intent.workflow === 'diagram') {
      const markdown = extractMermaidMarkdownFromResponse(finalText) ?? buildFallbackMermaidMarkdown(intent.target);
      const filePath = await writeDiagramPreviewFile(markdown, intent.target);
      const fileUri = vscode.Uri.file(filePath);
      stream.markdown(`### CodeBrain Diagram\n\nGenerated diagram for \`${intent.target ?? 'target'}\` successfully.\n\n- **Preview File:** [${path.basename(filePath)}](${fileUri.toString()})\n\n*(The preview file has been opened automatically)*`);
      await vscode.commands.executeCommand('vscode.open', fileUri);
    } else {
      stream.markdown(finalText);
      await this.maybeCreateDiagramPreviewFromResponse(intent, finalText, stream);
    }
    await this.appendContextAnalysisReport({
      stream,
      intent,
      optimizedContext: toolResultTexts.join('\n\n') || finalText,
      toolResultTexts,
    });

    chatMetricsCollector.recordMetric({
      tokensSaved: 0,
      tokensUsed: estimateTokens(groundedPrompt, model.id).tokens,
      responseTimeMs: Date.now() - startTime,
      cacheHits: 0,
      cacheMisses: 1,
      toolCallsCount: toolResults.length,
      roundCount: 1,
      workflow: intent.workflow,
    });

    return {};
  }

  private async collectGroundingToolResults(
    selectedTools: vscode.LanguageModelToolInformation[],
    intent: WorkflowIntent,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken,
  ): Promise<GroundedToolResult[]> {
    const requiredKinds = WORKFLOW_DEFINITIONS[intent.workflow].toolPlan
      .filter((step) => step.required)
      .map((step) => step.toolKind);
    const toolKinds = requiredKinds.length > 0 ? requiredKinds : WORKFLOW_DEFINITIONS[intent.workflow].mcpToolsRequired.slice(0, 2);
    const results: GroundedToolResult[] = [];

    for (const kind of toolKinds) {
      const tool = this.selectCodeGraphToolByKind(selectedTools, kind);
      if (!tool) {
        continue;
      }

      try {
        results.push(await this.invokeCodeGraphToolForContext(tool, kind, intent, request, token));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        getOutputChannel().appendLine(`[CodeBrain Chat] Grounding tool ${tool.name} failed: ${message}`);
        results.push({
          kind,
          toolName: tool.name,
          text: `Tool ${tool.name} failed: ${message}`,
        });
      }
    }

    return results;
  }

  private async sendModelRequest(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    model: vscode.LanguageModelChat,
    intent: WorkflowIntent,
    selectedTools: vscode.LanguageModelToolInformation[],
    diagramType?: string,
  ): Promise<vscode.ChatResult> {
    if (this.shouldUseTextToolContext(model)) {
      return this.sendGroundedModelRequest(request, chatContext, stream, token, model, intent, selectedTools, diagramType);
    }

    const startTime = Date.now();
    let initialPrompt = this.buildInitialPrompt(request, chatContext, intent, model.id);
    if (intent.workflow === 'diagram' && diagramType) {
      initialPrompt += `\n\nMandatory Requirement: Generate exactly one fenced code block using \`\`\`mermaid of type: **${diagramType}**.`;
    }
    const messages = [vscode.LanguageModelChatMessage.User(initialPrompt)];
    const state = this.getOrCreateState(request);
    const toolResultContextParts: string[] = [];
    let totalToolCalls = 0;

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

      const responseParts: AssistantReplayPart[] = [];
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];
      for await (const part of response.stream) {
        if (this.isReplayableAssistantPart(part)) {
          responseParts.push(part);
        }
        if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
        }
      }

      if (toolCalls.length === 0) {
        const text = responseParts
          .filter((part) => part instanceof vscode.LanguageModelTextPart)
          .map((part) => part.value)
          .join('');
        if (intent.workflow === 'diagram') {
          const markdown = extractMermaidMarkdownFromResponse(text) ?? buildFallbackMermaidMarkdown(intent.target);
          const filePath = await writeDiagramPreviewFile(markdown, intent.target);
          const fileUri = vscode.Uri.file(filePath);
          stream.markdown(`### CodeBrain Diagram\n\nGenerated diagram for \`${intent.target ?? 'target'}\` successfully.\n\n- **Preview File:** [${path.basename(filePath)}](${fileUri.toString()})\n\n*(The preview file has been opened automatically)*`);
          await vscode.commands.executeCommand('vscode.open', fileUri);
        } else {
          if (text.trim()) {
            stream.markdown(text);
          }
          await this.maybeCreateDiagramPreviewFromResponse(intent, text, stream);
        }
        await this.appendContextAnalysisReport({
          stream,
          intent,
          optimizedContext: toolResultContextParts.join('\n\n') || text,
          toolResultTexts: toolResultContextParts,
        });
        
        // Record metrics
        chatMetricsCollector.recordMetric({
          tokensSaved: 0, // Should calculate based on optimization logic
          tokensUsed: estimateTokens(messages.map(m => String(m)).join(''), model.id).tokens,
          responseTimeMs: Date.now() - startTime,
          cacheHits: 0,
          cacheMisses: 1,
          toolCallsCount: totalToolCalls,
          roundCount: round,
          workflow: intent.workflow,
        });
        
        return {};
      }

      totalToolCalls += toolCalls.length;
      messages.push(vscode.LanguageModelChatMessage.Assistant(responseParts));
      const toolResults = await Promise.all(
        toolCalls.map((toolCall) => this.invokeToolForModel(toolCall, request, token)),
      );
      const toolResultTexts = toolResults.map((result) => this.getToolResultText(result)).filter((text) => text.trim().length > 0);
      toolResultContextParts.push(...toolResultTexts);
      
      // Phase 4: Stateful Tracking
      toolResultTexts.forEach(text => {
        if (text.length > 0) state.toolResultSummary.push(text.slice(0, 100)); // Keep short summaries
      });

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
    const finalText = text.trim() || 'CodeBrain gathered CodeGraph results but did not receive a final answer.';
    if (intent.workflow === 'diagram') {
      const markdown = extractMermaidMarkdownFromResponse(finalText) ?? buildFallbackMermaidMarkdown(intent.target);
      const filePath = await writeDiagramPreviewFile(markdown, intent.target);
      const fileUri = vscode.Uri.file(filePath);
      stream.markdown(`### CodeBrain Diagram\n\nGenerated diagram for \`${intent.target ?? 'target'}\` successfully.\n\n- **Preview File:** [${path.basename(filePath)}](${fileUri.toString()})\n\n*(The preview file has been opened automatically)*`);
      await vscode.commands.executeCommand('vscode.open', fileUri);
    } else {
      stream.markdown(finalText);
      await this.maybeCreateDiagramPreviewFromResponse(intent, finalText, stream);
    }
    await this.appendContextAnalysisReport({
      stream,
      intent,
      optimizedContext: toolResultContextParts.join('\n\n') || finalText,
      toolResultTexts: toolResultContextParts,
    });
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
      '`@CodeBrain /diagram AuthService.login`',
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
    stream.button({ command: 'codebrain.generateFlowDiagram', title: 'Generate Diagram' });
    return { metadata: { handledBy: 'intentClarification', intent } };
  }

  private async maybeCreateDiagramPreviewFromResponse(
    intent: WorkflowIntent,
    responseText: string,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    if (intent.workflow !== 'diagram') {
      return;
    }

    try {
      const markdown = extractMermaidMarkdownFromResponse(responseText) ?? buildFallbackMermaidMarkdown(intent.target);
      const filePath = await writeDiagramPreviewFile(markdown, intent.target);

      stream.markdown(`\n\nDiagram preview file created: ${filePath}`);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getOutputChannel().appendLine(`[CodeBrain Chat] Failed to create diagram preview file: ${message}`);
      stream.markdown(`\n\nCould not create diagram preview file automatically: ${message}`);
    }
  }

  private maybeHandleReviewSlashCommand(
    request: vscode.ChatRequest,
    intent: WorkflowIntent,
    stream: vscode.ChatResponseStream,
  ): vscode.ChatResult | undefined {
    const prompt = request.prompt.trim();
    const isReviewSlashCommand = /^\/review\b/iu.test(prompt);
    if (!isReviewSlashCommand || intent.workflow !== 'review') {
      return undefined;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!isInsideGitWorkTree(workspaceRoot)) {
      stream.markdown('CodeBrain skipped `/review` because this workspace is not a Git repository.');
      return { metadata: { handledBy: 'reviewSlashRedirectSkippedNoGit' } };
    }

    if (!hasWorkingTreeDiff(workspaceRoot)) {
      stream.markdown('CodeBrain skipped `/review` because no git diff was found in the working tree.');
      return { metadata: { handledBy: 'reviewSlashRedirectSkippedNoDiff' } };
    }

    void vscode.commands.executeCommand('codebrain.prReview');
    stream.markdown('Opening CodeBrain review flow...');
    return { metadata: { handledBy: 'reviewSlashRedirectedToPrReview' } };
  }

  getHandler(): vscode.ChatRequestHandler {
    return async (request, chatContext, stream, token): Promise<vscode.ChatResult> => {
      const empty = this.maybeHandleEmptyRequest(request, stream);
      if (empty) {
        return empty;
      }

      let intent = this.resolveIntent(request);

      const model = await this.resolveModel(request);
      if (!model) {
        const message = 'No language model available. Ensure GitHub Copilot is signed in and active.';
        stream.markdown(message);
        return { errorDetails: { message } };
      }

      if (intent.needsClarification) {
        const aiIntent = await this.resolveIntentWithAI(request, model, token);
        if (aiIntent) {
          intent = aiIntent;
        }
      }

      const clarification = this.maybeHandleClarification(intent, stream);
      if (clarification) {
        return clarification;
      }

      const reviewRedirect = this.maybeHandleReviewSlashCommand(request, intent, stream);
      if (reviewRedirect) {
        return reviewRedirect;
      }

      let diagramType: string | undefined;
      if (intent.workflow === 'diagram') {
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
          stream.markdown('Cancelled diagram generation.');
          return {};
        }
        diagramType = selectedType.value;
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
          diagramType,
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
        { prompt: '/diagram selected symbol', label: 'Generate diagram' },
        { prompt: '/plan selected symbol', label: 'Generate plan' },
      ],
    };
  }

  getOptimizationConfig() {
    return chatOptimizationManager.getConfig();
  }

  updateOptimizationConfig(updates: any) {
    chatOptimizationManager.updateConfig(updates);
  }

  getOptimizationMetrics() {
    return chatMetricsCollector.getAggregatedMetrics();
  }
}

export const createCodeGraphParticipant = (
  context: vscode.ExtensionContext,
): vscode.ChatParticipant => {
  const agent = new CodeGraphAgentParticipant(context);
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, agent.getHandler());
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.png');
  // participant.followupProvider = agent.getFollowupProvider();
  return participant;
};
