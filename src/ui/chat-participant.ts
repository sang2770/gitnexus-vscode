import * as vscode from 'vscode';
import * as path from 'path';
import {
  ContextAnalysisService,
  extractContextFilesFromText,
  formatContextAnalysisMarkdown,
  isContextReportEnabled,
} from '../process/context-analysis.js';
import { getOutputChannel, getWorkspaceRoot } from '../process/cli-runner.js';
import { getWorkingTreeChangeContext, hasWorkingTreeDiff, isInsideGitWorkTree } from '../process/review-git.js';
import {
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
  getWorkflowResponseSections,
  resolveWorkflowIntent,
  type WorkflowIntent,
  WORKFLOW_DEFINITIONS,
  type CodeBrainWorkflowKind,
  type IntentTargetType,
  detectLanguage,
} from '../workflows/intent-resolver.js';
import { getWorkflowFollowups } from '../workflows/development-lifecycle.js';
import { chatOptimizationManager } from './chat-optimization-config.js';
import { buildFallbackMermaidMarkdown, extractMermaidMarkdownFromResponse, writeDiagramPreviewFile } from './diagram-generation.js';
import { chatMetricsCollector } from './chat-metrics.js';

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
const MAX_TOOL_CALL_ROUNDS = 3;
const GROUNDING_RESPONSE_RESERVE_TOKENS = 1200;
const GROUNDING_RESPONSE_RESERVE_RATIO = 0.18;
const SIMPLE_SYMBOL_PATTERN = /^[A-Za-z_$][\w$]*$/u;
const CONTEXT_REPORT_WORKFLOWS = new Set<WorkflowIntent['workflow']>([
  'architecture',
  'develop',
  'explain',
  'fix',
  'impact',
  'review',
  'test',
  'verify',
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

const GROUNDING_CHAR_LIMITS: Record<CodeGraphToolKind, Record<'compact' | 'balanced' | 'full', number>> = {
  status: { compact: 700, balanced: 900, full: 1200 },
  files: { compact: 900, balanced: 1400, full: 1800 },
  search: { compact: 900, balanced: 1400, full: 1800 },
  callers: { compact: 1100, balanced: 1700, full: 2200 },
  callees: { compact: 1100, balanced: 1700, full: 2200 },
  impact: { compact: 1400, balanced: 2200, full: 3000 },
  node: { compact: 1600, balanced: 2400, full: 3200 },
  explore: { compact: 1800, balanced: 2800, full: 3800 },
};

function normalizeSlashCommand(command: string | undefined): string | undefined {
  const normalized = command?.trim().replace(/^\//u, '').toLowerCase().replace(/-/gu, '_');
  return normalized || undefined;
}

function getTargetType(target: string | undefined | null, workflow: string): IntentTargetType {
  if (!target) {
    return 'unknown';
  }
  if (workflow === 'review' || workflow === 'detect_change') {
    return 'diff';
  }
  if (workflow === 'verify' && /\b(diff|changes?|working tree)\b/iu.test(target)) {
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
  private instructionCache = new Map<string, { instructions: string, timestamp: number }>();
  private readonly contextAnalysisService = new ContextAnalysisService();

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
      '- "develop": Implement a feature or ticket using a short end-to-end developer workflow.',
      '- "explain": Explain a symbol (class, function), execution flow, or file.',
      '- "fix": Diagnose and fix a bug, failure, regression, or incorrect behavior.',
      '- "impact": Analyze the impact, blast radius, callers, or callees of a specific symbol.',
      '- "review": Review current git changes, PRs, or diffs.',
      '- "detect_change": Detect impact/risk of pending changes in the working tree.',
      '- "test": Generate a test plan or test cases for a symbol or behavior.',
      '- "verify": Validate a diff or completed change with the smallest relevant test scope.',
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
      '  "workflow": "architecture" | "develop" | "explain" | "fix" | "impact" | "review" | "detect_change" | "test" | "verify" | "diagram" | "plan",',
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
        'develop',
        'explain',
        'fix',
        'impact',
        'review',
        'detect_change',
        'test',
        'verify',
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
    const lang = detectLanguage(intent.rawPrompt);
    const cacheKey = `${intent.workflow}_${intent.contextMode}_${compact ? 'compact' : 'full'}_${lang}`;

    if (config.enableInstructionCaching) {
      const cached = this.instructionCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < config.cacheTtlMs)) {
        return cached.instructions;
      }
    }

    const langNames = { vi: 'Vietnamese', ko: 'Korean', en: 'English' };
    const targetLangName = langNames[lang];
    const workflowSections = getWorkflowResponseSections(intent.workflow, lang).join(' -> ');

    if (compact) {
      const instructions = [
        `CodeBrain follow-up: ${intent.workflow}; target: ${intent.target ?? 'current context'}.`,
        'Use supplied CodeGraph evidence; mark missing evidence; do not edit files.',
        `Sections only: ${workflowSections || 'requested output'}.`,
        `Respond in ${targetLangName}.`,
      ].join('\n');

      if (config.enableInstructionCaching) {
        this.instructionCache.set(cacheKey, { instructions, timestamp: Date.now() });
      }
      return instructions;
    }

    const instructions = [
      buildWorkflowInstructions(intent),
      `Respond entirely in ${targetLangName}.`,
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
    executedKinds: Set<CodeGraphToolKind>,
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
      const requiredKinds = this.resolveRequiredToolKinds(intent).filter((kind) => !executedKinds.has(kind));
      const essentialTools: vscode.LanguageModelToolInformation[] = [];

      // Include as many required steps as round 0 can support so explain/review start with enough evidence.
      for (const kind of requiredKinds.slice(0, Math.max(1, config.maxToolsRound0))) {
        const tool = this.selectCodeGraphToolByKind(allTools, kind);
        if (tool) {
          essentialTools.push(tool);
        }
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

    const requiredKind = this.resolveRequiredToolKinds(intent).find((kind) => !executedKinds.has(kind));
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

  private buildReferenceBlock(request: vscode.ChatRequest): string | undefined {
    if (request.references.length === 0) {
      return undefined;
    }

    const workspaceRoot = getWorkspaceRoot();
    const references = request.references.slice(0, 8).map((reference) => {
      const description = reference.modelDescription?.trim();
      const value = reference.value;
      let renderedValue: string;

      if (value instanceof vscode.Uri) {
        renderedValue = this.toWorkspaceDisplayPath(value, workspaceRoot);
      } else if (value instanceof vscode.Location) {
        const location = this.toWorkspaceDisplayPath(value.uri, workspaceRoot);
        renderedValue = `${location}:${value.range.start.line + 1}`;
      } else if (typeof value === 'string') {
        renderedValue = truncateForTokenMode(value, 300);
      } else {
        renderedValue = reference.id;
      }

      return `- ${description ? `${description}: ` : ''}${renderedValue}`;
    });

    return ['Attached references (paths/descriptions only):', ...references].join('\n');
  }

  private toWorkspaceDisplayPath(uri: vscode.Uri, workspaceRoot: string): string {
    if (uri.scheme !== 'file') {
      return uri.toString();
    }
    const relative = path.relative(workspaceRoot, uri.fsPath);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.replace(/\\/g, '/')
      : uri.fsPath;
  }

  private buildInitialPrompt(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    intent: WorkflowIntent,
    modelId?: string,
  ): { prompt: string; tokensSaved: number } {
    const tokenSettings = getTokenOptimizationSettings(intent.contextMode);
    const historyWindow = chatContext.history.slice(-tokenSettings.historyTurnLimit);
    const isFollowUp = historyWindow.length > 0;
    const referenceBlock = this.buildReferenceBlock(request);
    const requestPrompt = [request.prompt, referenceBlock].filter(Boolean).join('\n\n');
    const instructions = this.buildInstructions(intent, isFollowUp);
    const optimizedPrompt = this.buildOptimizedPrompt({
      instructions,
      requestPrompt,
      history: historyWindow,
      tokenSettings,
      modelId,
    });
    const beforePrompt = this.composePromptSections({
      instructions,
      requestPrompt,
      history: this.buildHistoryBlock(historyWindow, 1600),
    });
    const report = createTokenReductionReport({
      beforeText: beforePrompt,
      afterText: optimizedPrompt.prompt,
      defaultMode: intent.contextMode,
      source: 'chat-initial-prompt',
      modelId,
    });
    let prompt = optimizedPrompt.prompt;
    const detectChangeSection = this.buildDetectChangePromptSection(intent);
    if (detectChangeSection) {
      prompt = this.appendOptionalPromptSection(prompt, detectChangeSection, tokenSettings.tokenBudget, modelId);
    }

    return { prompt, tokensSaved: report.reductionTokens };
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
    const recentHistory = input.history;

    const maxHistoryTurns = enabled
      ? Math.min(input.tokenSettings.historyTurnLimit, recentHistory.length)
      : recentHistory.length;
    const maxCharsPerTurn = enabled
      ? Math.min(config.historyCharsPerTurn, input.tokenSettings.historyCharsPerTurn)
      : 1600;
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
      const markdown = turn.response
        .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
        .map((part) => part.value.value)
        .join(' ');
      return markdown ? `Assistant: ${truncateForTokenMode(markdown, maxChars)}` : '';
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

  private resolveSymbolTarget(intent: WorkflowIntent, _requestOrPrompt?: vscode.ChatRequest | string): string | undefined {
    const target = intent.target?.trim();
    if (!target) {
      return undefined;
    }
    if (intent.targetType === 'symbol') {
      return target;
    }
    const detectedType = getTargetType(target, intent.workflow);
    return detectedType === 'symbol' || SIMPLE_SYMBOL_PATTERN.test(target) ? target : undefined;
  }

  private hasSymbolTarget(intent: WorkflowIntent): boolean {
    return Boolean(this.resolveSymbolTarget(intent, intent.rawPrompt));
  }

  private requiresSymbolTarget(kind: CodeGraphToolKind): boolean {
    return kind === 'callers' || kind === 'callees' || kind === 'impact' || kind === 'node';
  }

  private resolveRequiredToolKinds(intent: WorkflowIntent): CodeGraphToolKind[] {
    const symbolTarget = this.hasSymbolTarget(intent);
    return WORKFLOW_DEFINITIONS[intent.workflow].toolPlan
      .filter((step) => step.required)
      .map((step) => step.toolKind)
      .filter((kind) => !this.requiresSymbolTarget(kind) || symbolTarget);
  }

  private buildGroundingQuery(intent: WorkflowIntent, request: vscode.ChatRequest): string {
    const rawPrompt = request.prompt.trim();
    const target = intent.target?.trim();
    const normalizedPrompt = rawPrompt.replace(/\s+/g, ' ').trim();
    const promptWithoutCommand = normalizedPrompt.replace(/^\/[a-z_]+\b/iu, '').trim();

    if (intent.targetType === 'diff') {
      const workspaceRoot = getWorkspaceRoot();
      const changedFiles = isInsideGitWorkTree(workspaceRoot)
        ? getWorkingTreeChangeContext(workspaceRoot, {
            maxFiles: intent.contextMode === 'compact' ? 8 : intent.contextMode === 'full' ? 24 : 16,
            previewChars: 600,
          }).changedFiles
        : [];
      const focus = truncateForTokenMode(promptWithoutCommand || normalizedPrompt, 240);
      return [
        `${WORKFLOW_DEFINITIONS[intent.workflow].label}: ${target ?? 'working tree diff'}`,
        changedFiles.length > 0 ? `Changed files:\n${changedFiles.map((file) => `- ${file}`).join('\n')}` : undefined,
        focus && focus !== target ? `Focus: ${focus}` : undefined,
      ].filter(Boolean).join('\n');
    }

    if (intent.targetType === 'selection') {
      return [
        `${WORKFLOW_DEFINITIONS[intent.workflow].label}: selected code`,
        truncateForTokenMode(target ?? normalizedPrompt, 1200),
      ].join('\n');
    }

    if (intent.targetType === 'file') {
      return [
        `${WORKFLOW_DEFINITIONS[intent.workflow].label}: ${target ?? 'current file'}`,
        promptWithoutCommand ? `Focus: ${truncateForTokenMode(promptWithoutCommand, 240)}` : undefined,
      ].filter(Boolean).join('\n');
    }

    return [target, truncateForTokenMode(normalizedPrompt, 400)].filter(Boolean).join('\n') || 'current workspace';
  }

  private getExploreMaxFiles(contextMode: WorkflowIntent['contextMode']): number {
    switch (contextMode) {
      case 'compact':
        return 5;
      case 'full':
        return 10;
      case 'balanced':
      default:
        return 8;
    }
  }

  private getRelationshipLimit(contextMode: WorkflowIntent['contextMode']): number {
    switch (contextMode) {
      case 'compact':
        return 10;
      case 'full':
        return 20;
      case 'balanced':
      default:
        return 14;
    }
  }

  private getDiffPreviewCharLimit(contextMode: WorkflowIntent['contextMode']): number {
    switch (contextMode) {
      case 'compact':
        return 2200;
      case 'full':
        return 7000;
      case 'balanced':
      default:
        return 4200;
    }
  }

  private buildDetectChangePromptSection(intent: WorkflowIntent): string | undefined {
    if (intent.workflow !== 'detect_change') {
      return undefined;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!isInsideGitWorkTree(workspaceRoot) || !hasWorkingTreeDiff(workspaceRoot)) {
      return 'Working tree diff context: no tracked or untracked git changes were detected.';
    }

    const changeContext = getWorkingTreeChangeContext(workspaceRoot, {
      maxFiles: intent.contextMode === 'compact' ? 12 : intent.contextMode === 'full' ? 40 : 24,
      previewChars: this.getDiffPreviewCharLimit(intent.contextMode),
    });

    const changedFilesSection = changeContext.changedFiles.length > 0
      ? changeContext.changedFiles.map((file) => `- ${file}`).join('\n')
      : '- No changed files detected.';

    return [
      'Working tree diff context:',
      `Changed files (${changeContext.changedFiles.length}):`,
      changedFilesSection,
      '',
      'Diff stat:',
      changeContext.diffStat.trim() || '(no diff stat available)',
      '',
      'Diff preview:',
      changeContext.diffPreview.trim() || '(no diff preview available)',
      '',
      'Treat the git diff context above as primary evidence for what changed before inferring blast radius.',
    ].join('\n');
  }

  private buildCodeGraphToolInput(
    kind: CodeGraphToolKind,
    intent: WorkflowIntent,
    request: vscode.ChatRequest,
  ): Record<string, unknown> {
    const workspaceRoot = getWorkspaceRoot();
    const target = intent.target ?? (request.prompt.trim() || 'current workspace');
    const query = this.buildGroundingQuery(intent, request);
    const symbolTarget = this.resolveSymbolTarget(intent, request) ?? target;
    const relationshipLimit = this.getRelationshipLimit(intent.contextMode);

    switch (kind) {
      case 'status':
        return { projectPath: workspaceRoot };
      case 'files':
        return { format: 'tree', maxDepth: 4, projectPath: workspaceRoot };
      case 'explore':
        return { query, maxFiles: this.getExploreMaxFiles(intent.contextMode), projectPath: workspaceRoot };
      case 'search':
        return { query: symbolTarget, limit: relationshipLimit, projectPath: workspaceRoot };
      case 'callers':
      case 'callees':
        return { symbol: symbolTarget, limit: relationshipLimit, projectPath: workspaceRoot };
      case 'impact':
        return { symbol: symbolTarget, depth: intent.contextMode === 'full' ? 3 : 2, projectPath: workspaceRoot };
      case 'node':
        return { symbol: symbolTarget, includeCode: true, projectPath: workspaceRoot };
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

  private detectToolKind(toolName: string): CodeGraphToolKind | undefined {
    const normalizedName = this.normalizeToolName(toolName);
    const orderedKinds = Object.keys(TOOL_ALIASES) as CodeGraphToolKind[];
    return orderedKinds.find((kind) => TOOL_ALIASES[kind].some((alias) => this.toolNameHasHint(normalizedName, alias)));
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

  private resolveGroundingToolKinds(intent: WorkflowIntent): CodeGraphToolKind[] {
    const definition = WORKFLOW_DEFINITIONS[intent.workflow];
    const requiredKinds = this.resolveRequiredToolKinds(intent);
    const optionalKinds = definition.toolPlan
      .filter((step) => !step.required)
      .map((step) => step.toolKind);
    const symbolTarget = this.hasSymbolTarget(intent);
    const resolvedKinds = [...requiredKinds];

    for (const kind of optionalKinds) {
      if (kind === 'impact' && !symbolTarget) {
        continue;
      }
      if ((kind === 'callers' || kind === 'callees' || kind === 'node') && !symbolTarget) {
        continue;
      }
      if (intent.workflow === 'explain' && (kind === 'callers' || kind === 'callees' || kind === 'node')) {
        resolvedKinds.push(kind);
        continue;
      }
      if (intent.workflow !== 'review' && intent.workflow !== 'detect_change') {
        resolvedKinds.push(kind);
      }
    }

    return Array.from(new Set(resolvedKinds));
  }

  private summarizeToolResultForChat(
    toolName: string,
    kind: CodeGraphToolKind | undefined,
    text: string,
    intent: WorkflowIntent,
  ): string {
    const effectiveKind = kind ?? 'explore';
    const limit = GROUNDING_CHAR_LIMITS[effectiveKind][intent.contextMode];
    const summarized = this.summarizeGroundingText(effectiveKind, text, limit, intent.contextMode);
    return [`Tool: ${toolName}`, kind ? `Kind: ${kind}` : undefined, summarized || '(no text result)']
      .filter(Boolean)
      .join('\n');
  }

  private buildToolResultPartForChat(
    result: vscode.LanguageModelToolResultPart,
    toolName: string,
    intent: WorkflowIntent,
  ): { part: vscode.LanguageModelToolResultPart; contextText: string; kind?: CodeGraphToolKind } {
    const kind = this.detectToolKind(toolName);
    const text = this.getToolResultText(result);
    const summarizedText = this.summarizeToolResultForChat(toolName, kind, text, intent);
    return {
      kind,
      contextText: summarizedText,
      part: new vscode.LanguageModelToolResultPart(result.callId, [
        new vscode.LanguageModelTextPart(summarizedText),
      ]),
    };
  }

  private getGroundingEvidenceLimit(
    initialPrompt: string,
    intent: WorkflowIntent,
    modelId?: string,
  ): number {
    const tokenSettings = getTokenOptimizationSettings(intent.contextMode);
    const initialTokens = estimateTokens(initialPrompt, modelId).tokens;
    const responseReserve = Math.max(
      GROUNDING_RESPONSE_RESERVE_TOKENS,
      Math.floor(tokenSettings.tokenBudget * GROUNDING_RESPONSE_RESERVE_RATIO),
    );
    const availableTokens = Math.max(500, tokenSettings.tokenBudget - initialTokens - responseReserve);
    return Math.max(1200, availableTokens * 4);
  }

  private truncateMiddle(text: string, limit: number): string {
    if (text.length <= limit) {
      return text;
    }
    const head = Math.max(120, Math.floor(limit * 0.7));
    const tail = Math.max(80, limit - head - 20);
    return `${text.slice(0, head)}\n...[truncated]...\n${text.slice(-tail)}`;
  }

  private summarizeGroundingText(
    kind: CodeGraphToolKind,
    text: string,
    limit: number,
    contextMode: WorkflowIntent['contextMode'],
  ): string {
    const cleaned = text
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (cleaned.length <= limit) {
      return cleaned;
    }

    const baseLimit = Math.max(240, Math.min(limit, GROUNDING_CHAR_LIMITS[kind][contextMode]));
    if (kind === 'explore' || kind === 'node') {
      return this.truncateMiddle(cleaned, baseLimit);
    }

    return truncateForTokenMode(cleaned, baseLimit);
  }

  private buildGroundedEvidence(
    toolResults: GroundedToolResult[],
    intent: WorkflowIntent,
    initialPrompt: string,
    modelId?: string,
  ): { promptText: string; contextText: string } {
    let remainingChars = this.getGroundingEvidenceLimit(initialPrompt, intent, modelId);
    const renderedBlocks: string[] = [];
    const contextParts: string[] = [];

    for (const result of toolResults) {
      if (remainingChars < 240) {
        break;
      }

      const limit = Math.min(GROUNDING_CHAR_LIMITS[result.kind][intent.contextMode], remainingChars);
      const summarized = this.summarizeGroundingText(result.kind, result.text, limit, intent.contextMode);
      if (!summarized.trim()) {
        continue;
      }

      const block = [
        `Tool: ${result.toolName}`,
        `Kind: ${result.kind}`,
        summarized,
      ].join('\n');

      renderedBlocks.push(block);
      contextParts.push(summarized);
      remainingChars -= block.length + 2;
    }

    return {
      promptText: renderedBlocks.join('\n\n'),
      contextText: contextParts.join('\n\n'),
    };
  }

  private buildSuccessResult(
    intent: WorkflowIntent,
    tokensSaved: number,
    toolCalls: number,
  ): vscode.ChatResult {
    return {
      metadata: {
        handledBy: 'codebrainWorkflow',
        workflow: intent.workflow,
        target: intent.target,
        tokensSaved,
        toolCalls,
      },
    };
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
    const initialPromptBuild = this.buildInitialPrompt(request, chatContext, intent, model.id);
    let initialPrompt = initialPromptBuild.prompt;
    if (intent.workflow === 'diagram' && diagramType) {
      initialPrompt += `\n\nMandatory Requirement: Generate exactly one fenced code block using \`\`\`mermaid of type: **${diagramType}**.`;
    }
    const toolResults = await this.collectGroundingToolResults(selectedTools, intent, request, token);
    const groundingEvidence = this.buildGroundedEvidence(toolResults, intent, initialPrompt, model.id);
    const toolResultTexts = groundingEvidence.contextText
      ? groundingEvidence.contextText.split(/\n{2,}/).filter((text) => text.trim().length > 0)
      : [];
    const groundedPrompt = [
      initialPrompt,
      '',
      'CodeBrain MCP tool results:',
      groundingEvidence.promptText
        ? groundingEvidence.promptText
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
      optimizedContext: groundingEvidence.contextText || finalText,
      toolResultTexts,
    });

    chatMetricsCollector.recordMetric({
      tokensSaved: initialPromptBuild.tokensSaved,
      tokensUsed: estimateTokens(groundedPrompt, model.id).tokens,
      responseTimeMs: Date.now() - startTime,
      cacheHits: 0,
      cacheMisses: 0,
      toolCallsCount: toolResults.length,
      roundCount: 1,
      workflow: intent.workflow,
    });

    return this.buildSuccessResult(intent, initialPromptBuild.tokensSaved, toolResults.length);
  }

  private async collectGroundingToolResults(
    selectedTools: vscode.LanguageModelToolInformation[],
    intent: WorkflowIntent,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken,
  ): Promise<GroundedToolResult[]> {
    const toolKinds = this.resolveGroundingToolKinds(intent);
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
    const initialPromptBuild = this.buildInitialPrompt(request, chatContext, intent, model.id);
    let initialPrompt = initialPromptBuild.prompt;
    if (intent.workflow === 'diagram' && diagramType) {
      initialPrompt += `\n\nMandatory Requirement: Generate exactly one fenced code block using \`\`\`mermaid of type: **${diagramType}**.`;
    }
    const messages = [vscode.LanguageModelChatMessage.User(initialPrompt)];
    const toolResultContextParts: string[] = [];
    let totalToolCalls = 0;
    const executedKinds = new Set<CodeGraphToolKind>();

    for (let round = 0; round < MAX_TOOL_CALL_ROUNDS; round += 1) {
      const toolSelection = this.selectToolsForRound(selectedTools, intent, request, round, executedKinds);
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
        const missingRequiredKinds = this.resolveRequiredToolKinds(intent).filter((kind) => !executedKinds.has(kind));
        if (missingRequiredKinds.length > 0 && round < MAX_TOOL_CALL_ROUNDS - 1) {
          messages.push(
            vscode.LanguageModelChatMessage.User(
              `Before answering, call the selected CodeGraph tool for required evidence: ${missingRequiredKinds[0]}.`,
            ),
          );
          continue;
        }

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
          tokensSaved: initialPromptBuild.tokensSaved,
          tokensUsed: estimateTokens([initialPrompt, ...toolResultContextParts].join('\n'), model.id).tokens,
          responseTimeMs: Date.now() - startTime,
          cacheHits: 0,
          cacheMisses: 0,
          toolCallsCount: totalToolCalls,
          roundCount: round,
          workflow: intent.workflow,
        });

        return this.buildSuccessResult(intent, initialPromptBuild.tokensSaved, totalToolCalls);
      }

      totalToolCalls += toolCalls.length;
      messages.push(vscode.LanguageModelChatMessage.Assistant(responseParts));
      toolCalls.forEach((toolCall) => {
        const kind = this.detectToolKind(toolCall.name);
        if (kind) {
          executedKinds.add(kind);
        }
      });
      const toolResults = await Promise.all(
        toolCalls.map((toolCall) => this.invokeToolForModel(toolCall, request, token)),
      );
      const summarizedResults = toolResults.map((result, index) =>
        this.buildToolResultPartForChat(result, toolCalls[index]?.name ?? 'unknown_tool', intent),
      );
      const toolResultTexts = summarizedResults
        .map((result) => result.contextText)
        .filter((text) => text.trim().length > 0);
      toolResultContextParts.push(...toolResultTexts);

      messages.push(vscode.LanguageModelChatMessage.User(summarizedResults.map((result) => result.part)));
    }

    messages.push(
      vscode.LanguageModelChatMessage.User(
        'Tool-call budget reached. Use the evidence above and answer now. Do not request additional tools or add meta sections.',
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
    chatMetricsCollector.recordMetric({
      tokensSaved: initialPromptBuild.tokensSaved,
      tokensUsed: estimateTokens([initialPrompt, ...toolResultContextParts].join('\n'), model.id).tokens,
      responseTimeMs: Date.now() - startTime,
      cacheHits: 0,
      cacheMisses: 0,
      toolCallsCount: totalToolCalls,
      roundCount: MAX_TOOL_CALL_ROUNDS,
      workflow: intent.workflow,
    });
    return this.buildSuccessResult(intent, initialPromptBuild.tokensSaved, totalToolCalls);
  }

  private maybeHandleEmptyRequest(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): vscode.ChatResult | undefined {
    if (
      request.prompt.trim() ||
      request.references.length > 0 ||
      request.toolReferences.length > 0 ||
      normalizeSlashCommand(request.command)
    ) {
      return undefined;
    }

    const examples = [
      '`@CodeBrain /develop add session timeout`',
      '`@CodeBrain /fix login returns 500 after token expiry`',
      '`@CodeBrain /verify working tree diff`',
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

  private async maybeHandleReviewSlashCommand(
    request: vscode.ChatRequest,
    intent: WorkflowIntent,
    stream: vscode.ChatResponseStream,
  ): Promise<vscode.ChatResult | undefined> {
    const prompt = request.prompt.trim();
    const normalizedCommand = normalizeSlashCommand(request.command);
    const isReviewSlashCommand = normalizedCommand === 'review' || /^\/review\b/iu.test(prompt);
    if (!isReviewSlashCommand || intent.workflow !== 'review') {
      return undefined;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!isInsideGitWorkTree(workspaceRoot)) {
      stream.markdown('CodeBrain skipped `/review` because this workspace is not a Git repository.');
      return { metadata: { handledBy: 'reviewSlashRedirectSkippedNoGit' } };
    }

    const requestedTarget = intent.target?.trim();
    const hasExplicitReviewTarget = Boolean(
      requestedTarget &&
      !/^working tree diff$/iu.test(requestedTarget),
    );

    if (!hasExplicitReviewTarget && !hasWorkingTreeDiff(workspaceRoot)) {
      stream.markdown('CodeBrain skipped `/review` because no git diff was found in the working tree.');
      return { metadata: { handledBy: 'reviewSlashRedirectSkippedNoDiff' } };
    }

    await vscode.commands.executeCommand('codebrain.prReview', hasExplicitReviewTarget ? requestedTarget : undefined);
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

      const reviewRedirect = await this.maybeHandleReviewSlashCommand(request, intent, stream);
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
      provideFollowups: (result) => {
        const workflow = result.metadata?.workflow as CodeBrainWorkflowKind | undefined;
        const target = typeof result.metadata?.target === 'string' ? result.metadata.target : undefined;
        return getWorkflowFollowups(workflow, target);
      },
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
  participant.followupProvider = agent.getFollowupProvider();
  return participant;
};
