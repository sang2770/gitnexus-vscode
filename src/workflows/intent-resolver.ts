import * as path from 'path';
import * as vscode from 'vscode';

export type CodeBrainWorkflowKind =
  | 'architecture'
  | 'explain'
  | 'impact'
  | 'review'
  | 'test'
  | 'detect_change'
  | 'fix_plan';

export type ContextMode = 'compact' | 'balanced' | 'full';

export type CodeGraphToolKind =
  | 'explore'
  | 'search'
  | 'callers'
  | 'callees'
  | 'impact'
  | 'node'
  | 'files'
  | 'status';

export type IntentTargetType =
  | 'diff'
  | 'file'
  | 'repository'
  | 'selection'
  | 'symbol'
  | 'task'
  | 'unknown';

export type IntentSource =
  | 'slash-command'
  | 'editor-context'
  | 'selected-symbol'
  | 'git-diff'
  | 'regex-symbol'
  | 'heuristic'
  | 'low-confidence';

export interface EditorIntentContext {
  filePath?: string;
  relativeFilePath?: string;
  selectedText?: string;
  selectedSymbol?: string;
  cursorSymbol?: string;
}

export interface WorkflowIntent {
  workflow: CodeBrainWorkflowKind;
  target?: string;
  targetType: IntentTargetType;
  contextMode: ContextMode;
  confidence: number;
  source: IntentSource;
  needsClarification: boolean;
  rawPrompt: string;
}

export interface WorkflowToolStep {
  toolKind: CodeGraphToolKind;
  purpose: string;
  required: boolean;
}

export interface WorkflowDefinition {
  kind: CodeBrainWorkflowKind;
  slashCommand: string;
  label: string;
  contextMode: ContextMode;
  intentParsingStrategy: string;
  mcpToolsRequired: CodeGraphToolKind[];
  graphQueryPlan: string[];
  contextOptimizationStrategy: string;
  promptConstructionStrategy: string;
  outputSchema: string[];
  exampleConversation: string[];
  toolPlan: WorkflowToolStep[];
  producesAgentTask: boolean;
}

const WORKFLOW_ALIASES: Record<string, CodeBrainWorkflowKind> = {
  architecture: 'architecture',
  arch: 'architecture',
  onboard: 'architecture',
  onboarding: 'architecture',
  explain: 'explain',
  flow: 'explain',
  impact: 'impact',
  blast: 'impact',
  review: 'review',
  pr_review: 'review',
  test: 'test',
  tests: 'test',
  test_plan: 'test',
  detect_change: 'detect_change',
  detect_changes: 'detect_change',
  changes: 'detect_change',
  fix_plan: 'fix_plan',
  plan: 'fix_plan',
  implementation_plan: 'fix_plan',
  refactor: 'fix_plan',
  debug: 'fix_plan',
};

export const WORKFLOW_DEFINITIONS: Record<CodeBrainWorkflowKind, WorkflowDefinition> = {
  architecture: {
    kind: 'architecture',
    slashCommand: '/architecture',
    label: 'Architecture',
    contextMode: 'full',
    intentParsingStrategy:
      'Slash command first, then architecture/onboarding keywords, then repository context.',
    mcpToolsRequired: ['status', 'files', 'explore'],
    graphQueryPlan: [
      'codegraph_status: verify index freshness and repository size.',
      'codegraph_files: inspect module layout with metadata.',
      'codegraph_explore: retrieve architecture-relevant entry points and dependency clusters.',
    ],
    contextOptimizationStrategy:
      'Full mode: include representative entry points, module relationships, and broader dependency clusters without dumping whole files.',
    promptConstructionStrategy:
      'Ask Copilot to explain system shape from graph evidence and name selected files before reasoning.',
    outputSchema: [
      'Context Used',
      'Why Selected',
      'Token Reduction',
      'Architecture Findings',
      'Risks',
      'Recommended Next Actions',
      'Self-check',
    ],
    exampleConversation: [
      'User: @CodeBrain /architecture auth module',
      'CodeBrain: resolves architecture workflow, checks index, scans module files, explores auth entry points, then summarizes architecture.',
    ],
    toolPlan: [
      { toolKind: 'status', purpose: 'Check index freshness before architecture analysis.', required: true },
      { toolKind: 'files', purpose: 'Map repository/module layout before selecting context.', required: true },
      { toolKind: 'explore', purpose: 'Retrieve graph-selected architecture context.', required: true },
    ],
    producesAgentTask: false,
  },
  explain: {
    kind: 'explain',
    slashCommand: '/explain',
    label: 'Explain Flow',
    contextMode: 'compact',
    intentParsingStrategy:
      'Slash command or selected symbol first; otherwise use current editor context and symbol extraction.',
    mcpToolsRequired: ['explore', 'callers', 'callees', 'node'],
    graphQueryPlan: [
      'codegraph_explore: retrieve the core flow in one capped graph-aware call.',
      'codegraph_callers: inspect direct entry points when a symbol target is available.',
      'codegraph_callees: inspect direct downstream calls when a symbol target is available.',
      'codegraph_node: fetch exact symbol body only if explore trimmed necessary details.',
    ],
    contextOptimizationStrategy:
      'Compact mode: current symbol, direct references, and minimal flow windows.',
    promptConstructionStrategy:
      'Explain only after graph retrieval; prefer execution/data flow over generic chatbot prose.',
    outputSchema: [
      'Context Used',
      'Why Selected',
      'Token Reduction',
      'Main Flow',
      'Data Flow',
      'Recommendation',
      'Self-check',
    ],
    exampleConversation: [
      'User: @CodeBrain /explain AuthService.login',
      'CodeBrain: explores AuthService.login, checks direct callers/callees, and explains the grounded flow.',
    ],
    toolPlan: [
      { toolKind: 'explore', purpose: 'Retrieve compact source context for the target flow.', required: true },
      { toolKind: 'callers', purpose: 'Confirm direct entry points for the explained symbol.', required: false },
      { toolKind: 'callees', purpose: 'Confirm direct dependencies for the explained symbol.', required: false },
    ],
    producesAgentTask: false,
  },
  impact: {
    kind: 'impact',
    slashCommand: '/impact',
    label: 'Impact Analysis',
    contextMode: 'balanced',
    intentParsingStrategy:
      'Slash command or selected symbol required; fall back to regex symbol extraction only with clear confidence.',
    mcpToolsRequired: ['search', 'callers', 'callees', 'impact'],
    graphQueryPlan: [
      'codegraph_search: resolve the target symbol deterministically.',
      'codegraph_callers: identify direct dependents.',
      'codegraph_callees: identify downstream dependencies.',
      'codegraph_impact: traverse blast radius and d-level risk.',
    ],
    contextOptimizationStrategy:
      'Balanced mode: target symbol, callers, callees, direct dependencies, and related tests when visible.',
    promptConstructionStrategy:
      'Summarize blast radius and risk from CodeGraph output; never infer hidden callers without saying confidence is limited.',
    outputSchema: [
      'Context Used',
      'Why Selected',
      'Token Reduction',
      'Findings',
      'Impact / Risk',
      'Recommendation',
      'Self-check',
    ],
    exampleConversation: [
      'User: @CodeBrain /impact AuthService.login',
      'CodeBrain: resolves AuthService.login, runs callers/callees/impact, and reports d-level risk.',
    ],
    toolPlan: [
      { toolKind: 'search', purpose: 'Resolve the target symbol before impact traversal.', required: true },
      { toolKind: 'callers', purpose: 'Find direct upstream dependents.', required: true },
      { toolKind: 'callees', purpose: 'Find direct downstream dependencies.', required: true },
      { toolKind: 'impact', purpose: 'Compute graph blast radius.', required: true },
    ],
    producesAgentTask: false,
  },
  review: {
    kind: 'review',
    slashCommand: '/review',
    label: 'Review Changes',
    contextMode: 'balanced',
    intentParsingStrategy:
      'Slash command, SCM command, or git-diff keywords; changed files are treated as diff context.',
    mcpToolsRequired: ['status', 'explore', 'impact'],
    graphQueryPlan: [
      'codegraph_status: verify index freshness against the diff.',
      'codegraph_explore: retrieve changed-area context and related flows.',
      'codegraph_impact: inspect non-trivial changed symbols for downstream risk.',
    ],
    contextOptimizationStrategy:
      'Balanced mode: changed files, changed symbols, affected dependencies, and related tests.',
    promptConstructionStrategy:
      'Lead with review findings; use graph evidence to flag hidden dependents and missing tests.',
    outputSchema: [
      'Context Used',
      'Why Selected',
      'Token Reduction',
      'Findings',
      'Impact / Risk',
      'Recommendation / Action',
      'Self-check',
    ],
    exampleConversation: [
      'User: @CodeBrain /review',
      'CodeBrain: checks index freshness, reviews diff context, explores changed flows, and reports findings first.',
    ],
    toolPlan: [
      { toolKind: 'status', purpose: 'Check stale-index risk before review.', required: true },
      { toolKind: 'explore', purpose: 'Retrieve graph context for changed files and symbols.', required: true },
      { toolKind: 'impact', purpose: 'Inspect changed symbols with likely downstream effects.', required: false },
    ],
    producesAgentTask: false,
  },
  test: {
    kind: 'test',
    slashCommand: '/test',
    label: 'Test Plan',
    contextMode: 'balanced',
    intentParsingStrategy:
      'Slash command or test/coverage keywords; selected symbol/file scopes the test target.',
    mcpToolsRequired: ['explore', 'impact', 'files'],
    graphQueryPlan: [
      'codegraph_explore: retrieve target behavior and existing test seams.',
      'codegraph_impact: identify callers/dependents that need regression coverage.',
      'codegraph_files: locate likely test files when needed.',
    ],
    contextOptimizationStrategy:
      'Balanced mode: target behavior, existing tests, impacted dependents, and validation boundaries.',
    promptConstructionStrategy:
      'Generate a focused test plan with files to update and validation commands, not broad advice.',
    outputSchema: [
      'Context Used',
      'Why Selected',
      'Token Reduction',
      'Test Targets',
      'Recommended Test Cases',
      'Validation Steps',
      'Self-check',
    ],
    exampleConversation: [
      'User: @CodeBrain /test AuthService.login',
      'CodeBrain: explores auth behavior, checks impact, and proposes focused unit/integration coverage.',
    ],
    toolPlan: [
      { toolKind: 'explore', purpose: 'Retrieve target behavior and nearby tests.', required: true },
      { toolKind: 'impact', purpose: 'Find dependents that need regression tests.', required: false },
      { toolKind: 'files', purpose: 'Locate existing test files when the target is broad.', required: false },
    ],
    producesAgentTask: true,
  },
  detect_change: {
    kind: 'detect_change',
    slashCommand: '/detect_change',
    label: 'Detect Change Impact',
    contextMode: 'balanced',
    intentParsingStrategy:
      'Slash command, SCM context, or diff/change keywords; target defaults to working tree diff.',
    mcpToolsRequired: ['status', 'explore', 'impact'],
    graphQueryPlan: [
      'codegraph_status: determine freshness and pending changes.',
      'codegraph_explore: map changed files to graph flows.',
      'codegraph_impact: run symbol impact when changed symbols are clear.',
    ],
    contextOptimizationStrategy:
      'Balanced mode: changed files, changed symbols, directly affected dependencies, and tests.',
    promptConstructionStrategy:
      'Report what changed, what it may affect, and what should be validated before merge.',
    outputSchema: [
      'Context Used',
      'Why Selected',
      'Token Reduction',
      'Changed Scope',
      'Impact / Risk',
      'Recommendation',
      'Self-check',
    ],
    exampleConversation: [
      'User: @CodeBrain /detect_change',
      'CodeBrain: checks pending changes, explores changed flows, and summarizes downstream risk.',
    ],
    toolPlan: [
      { toolKind: 'status', purpose: 'Read pending change and freshness metadata.', required: true },
      { toolKind: 'explore', purpose: 'Retrieve graph context for changed areas.', required: true },
      { toolKind: 'impact', purpose: 'Compute blast radius when changed symbols are identifiable.', required: false },
    ],
    producesAgentTask: false,
  },
  fix_plan: {
    kind: 'fix_plan',
    slashCommand: '/fix_plan',
    label: 'Fix Plan',
    contextMode: 'balanced',
    intentParsingStrategy:
      'Slash command, selected symbol, implementation-plan keywords, or issue/debug/refactor wording.',
    mcpToolsRequired: ['explore', 'impact', 'node'],
    graphQueryPlan: [
      'codegraph_explore: retrieve relevant flow and constraints.',
      'codegraph_impact: inspect blast radius before proposing edits.',
      'codegraph_node: fetch exact symbol details only if needed for a precise plan.',
    ],
    contextOptimizationStrategy:
      'Balanced mode: target behavior, direct dependencies, risky dependents, and likely tests.',
    promptConstructionStrategy:
      'Generate a structured Copilot Agent task with edit files, constraints, risks, tests, and validation steps.',
    outputSchema: [
      'Context Used',
      'Why Selected',
      'Token Reduction',
      'Findings',
      'Fix Plan',
      'Copilot Agent Task',
      'Validation Steps',
      'Self-check',
    ],
    exampleConversation: [
      'User: @CodeBrain /fix_plan add auth token rotation',
      'CodeBrain: explores auth flows, checks impact, then produces a task Copilot Agent can execute.',
    ],
    toolPlan: [
      { toolKind: 'explore', purpose: 'Retrieve implementation context and constraints.', required: true },
      { toolKind: 'impact', purpose: 'Check blast radius before planning edits.', required: true },
      { toolKind: 'node', purpose: 'Fetch exact symbol details if a specific function/class needs changes.', required: false },
    ],
    producesAgentTask: true,
  },
};

const LOW_CONFIDENCE_THRESHOLD = 0.55;
const SYMBOL_PATTERN = /\b[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)+\b/u;

export function getEditorIntentContext(workspaceRoot: string): EditorIntentContext {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return {};
  }

  const filePath = editor.document.uri.fsPath;
  const relativeFilePath = toWorkspaceRelativePath(workspaceRoot, filePath);
  const selectedText = editor.document.getText(editor.selection).trim();
  const selectedSymbol = toUsableSymbol(selectedText);
  const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
  const cursorSymbol = wordRange
    ? toUsableSymbol(editor.document.getText(wordRange).trim())
    : undefined;

  return {
    filePath,
    relativeFilePath,
    selectedText: selectedText || undefined,
    selectedSymbol,
    cursorSymbol,
  };
}

export function resolveWorkflowIntent(input: {
  command?: string;
  prompt: string;
  workspaceRoot: string;
  editorContext?: EditorIntentContext;
}): WorkflowIntent {
  const prompt = input.prompt.trim();
  const editorContext = input.editorContext ?? {};
  const commandMatch = parseWorkflowCommand(input.command, prompt);

  if (commandMatch) {
    const target = resolveTarget(commandMatch.remainingPrompt, commandMatch.workflow, editorContext);
    return withClarificationCheck({
      workflow: commandMatch.workflow,
      target: target.value,
      targetType: target.type,
      contextMode: WORKFLOW_DEFINITIONS[commandMatch.workflow].contextMode,
      confidence: commandMatch.source === 'slash-command' ? 0.98 : 0.92,
      source: 'slash-command',
      needsClarification: false,
      rawPrompt: prompt,
    });
  }

  const heuristic = resolveHeuristicWorkflow(prompt, editorContext);
  return withClarificationCheck(heuristic);
}

export function buildWorkflowInstructions(intent: WorkflowIntent): string {
  const definition = WORKFLOW_DEFINITIONS[intent.workflow];
  const intentJson = JSON.stringify(
    {
      workflow: intent.workflow,
      target: intent.target ?? null,
      targetType: intent.targetType,
      contextMode: intent.contextMode,
      confidence: intent.confidence,
      source: intent.source,
    },
    null,
    2,
  );

  return [
    'CodeBrain v2.0 workflow contract:',
    'You are CodeBrain, a repository-aware AI workflow orchestration and context optimization layer.',
    'Positioning: CodeGraph is the repository intelligence engine. GitHub Copilot is the reasoning and agent execution engine. CodeBrain orchestrates workflow resolution, graph retrieval, context optimization, and agent task generation.',
    'Do not behave like a generic chatbot. Resolve intent into the workflow below, retrieve graph evidence first, then reason.',
    'Do not directly edit files from this chat participant. For implementation work, generate a structured Copilot Agent Task.',
    '',
    `Resolved intent:\n${intentJson}`,
    '',
    `Workflow: ${definition.label} (${definition.slashCommand})`,
    `Intent parsing strategy: ${definition.intentParsingStrategy}`,
    `Context mode: ${intent.contextMode}`,
    '',
    'Graph query plan:',
    ...definition.graphQueryPlan.map((step) => `- ${step}`),
    '',
    `Context optimization strategy: ${definition.contextOptimizationStrategy}`,
    `Prompt construction strategy: ${definition.promptConstructionStrategy}`,
    '',
    'Mandatory output requirements:',
    '- Always include a "Context Used" section.',
    '- Always include a "Why Selected" section.',
    '- Always include a "Token Reduction" section with Files Scanned, Files Selected, estimated before/after tokens, and reduction percentage.',
    '- If a metric is not available from CodeGraph output, write "Unknown" and state what evidence is missing. Do not invent numbers.',
    '- Use CodeGraph tool results as evidence. Do not blindly answer from prompt text.',
    '- Keep the answer workflow-shaped: Context -> Findings -> Impact/Risk when relevant -> Action/Agent Task -> Self-check.',
    '',
    'Expected output schema:',
    ...definition.outputSchema.map((section) => `- ${section}`),
    '',
    'Example conversation:',
    ...definition.exampleConversation.map((line) => `- ${line}`),
  ].join('\n');
}

export function buildClarificationMarkdown(prompt: string): string {
  const issue = prompt.trim() ? `I could not resolve "${prompt.trim()}" into a confident workflow.` : 'I need a workflow target.';
  return [
    issue,
    '',
    'What would you like CodeBrain to do?',
    '',
    '- Explain Flow: `/explain <symbol or area>`',
    '- Analyze Impact: `/impact <symbol>`',
    '- Review Changes: `/review`',
    '- Generate Fix Plan: `/fix_plan <task or issue>`',
    '- Generate Test Plan: `/test <symbol or behavior>`',
  ].join('\n');
}

function parseWorkflowCommand(
  requestCommand: string | undefined,
  prompt: string,
): { workflow: CodeBrainWorkflowKind; remainingPrompt: string; source: IntentSource } | undefined {
  const normalizedRequestCommand = normalizeCommandName(requestCommand);
  if (normalizedRequestCommand && WORKFLOW_ALIASES[normalizedRequestCommand]) {
    return {
      workflow: WORKFLOW_ALIASES[normalizedRequestCommand],
      remainingPrompt: prompt,
      source: 'slash-command',
    };
  }

  const promptCommand = /^\/([a-z_]+)\b\s*(.*)$/iu.exec(prompt);
  if (!promptCommand) {
    return undefined;
  }

  const commandName = normalizeCommandName(promptCommand[1]);
  if (!commandName || !WORKFLOW_ALIASES[commandName]) {
    return undefined;
  }

  return {
    workflow: WORKFLOW_ALIASES[commandName],
    remainingPrompt: promptCommand[2]?.trim() ?? '',
    source: 'slash-command',
  };
}

function resolveHeuristicWorkflow(prompt: string, editorContext: EditorIntentContext): WorkflowIntent {
  const lower = prompt.toLowerCase();
  const symbol = extractSymbol(prompt);

  if (/\b(architecture|module map|system overview|onboard|onboarding)\b/u.test(lower)) {
    const target = resolveTarget(prompt, 'architecture', editorContext);
    return baseIntent('architecture', target.value, target.type, 0.78, 'heuristic', prompt);
  }

  if (/\b(review|pr|diff|changed files|working tree)\b/u.test(lower)) {
    return baseIntent('review', 'working tree diff', 'diff', 0.78, 'git-diff', prompt);
  }

  if (/\b(detect change|detect changes|change impact|pending changes)\b/u.test(lower)) {
    return baseIntent('detect_change', 'working tree diff', 'diff', 0.78, 'git-diff', prompt);
  }

  if (/\b(impact|blast radius|callers|callees|dependents?)\b/u.test(lower)) {
    const target = symbol ?? editorContext.selectedSymbol ?? editorContext.cursorSymbol;
    return baseIntent('impact', target, target ? 'symbol' : 'unknown', target ? 0.74 : 0.45, target ? 'regex-symbol' : 'low-confidence', prompt);
  }

  if (/\b(test plan|tests?|coverage|regression)\b/u.test(lower)) {
    const target = resolveTarget(prompt, 'test', editorContext);
    return baseIntent('test', target.value, target.type, target.value ? 0.72 : 0.5, 'heuristic', prompt);
  }

  if (/\b(fix plan|implementation plan|implement|debug|bug|refactor|rename|extract)\b/u.test(lower)) {
    const target = resolveTarget(prompt, 'fix_plan', editorContext);
    return baseIntent('fix_plan', target.value, target.type, target.value ? 0.7 : 0.5, 'heuristic', prompt);
  }

  if (/\b(explain|understand|how does|flow|what does)\b/u.test(lower)) {
    const target = resolveTarget(prompt, 'explain', editorContext);
    return baseIntent('explain', target.value, target.type, target.value ? 0.74 : 0.5, 'heuristic', prompt);
  }

  if (editorContext.selectedSymbol || editorContext.cursorSymbol) {
    const target = editorContext.selectedSymbol ?? editorContext.cursorSymbol;
    return baseIntent('explain', target, 'symbol', 0.58, 'selected-symbol', prompt);
  }

  return baseIntent('explain', undefined, 'unknown', 0.35, 'low-confidence', prompt);
}

function baseIntent(
  workflow: CodeBrainWorkflowKind,
  target: string | undefined,
  targetType: IntentTargetType,
  confidence: number,
  source: IntentSource,
  rawPrompt: string,
): WorkflowIntent {
  return {
    workflow,
    target,
    targetType,
    contextMode: WORKFLOW_DEFINITIONS[workflow].contextMode,
    confidence,
    source,
    needsClarification: confidence < LOW_CONFIDENCE_THRESHOLD,
    rawPrompt,
  };
}

function resolveTarget(
  prompt: string,
  workflow: CodeBrainWorkflowKind,
  editorContext: EditorIntentContext,
): { value?: string; type: IntentTargetType } {
  const trimmed = prompt.trim();

  if (workflow === 'architecture') {
    return { value: trimmed || editorContext.relativeFilePath || 'repository', type: trimmed ? 'task' : 'repository' };
  }

  if (workflow === 'review' || workflow === 'detect_change') {
    return { value: trimmed || 'working tree diff', type: 'diff' };
  }

  if (trimmed && !looksLikeSelectedSymbolAlias(trimmed)) {
    const symbol = extractSymbol(trimmed);
    if (symbol && (workflow === 'impact' || workflow === 'explain')) {
      return { value: symbol, type: 'symbol' };
    }
    return { value: trimmed, type: workflow === 'impact' ? 'symbol' : 'task' };
  }

  if (editorContext.selectedSymbol) {
    return { value: editorContext.selectedSymbol, type: 'symbol' };
  }

  if (editorContext.cursorSymbol) {
    return { value: editorContext.cursorSymbol, type: 'symbol' };
  }

  if (editorContext.selectedText) {
    return { value: truncate(editorContext.selectedText, 4000), type: 'selection' };
  }

  if (editorContext.relativeFilePath) {
    return { value: editorContext.relativeFilePath, type: 'file' };
  }

  return { type: 'unknown' };
}

function withClarificationCheck(intent: WorkflowIntent): WorkflowIntent {
  const needsTarget =
    intent.workflow === 'impact' &&
    (!intent.target || intent.targetType === 'unknown');

  const needsClarification =
    intent.needsClarification ||
    needsTarget ||
    intent.confidence < LOW_CONFIDENCE_THRESHOLD;

  return {
    ...intent,
    needsClarification,
    confidence: needsTarget ? Math.min(intent.confidence, 0.45) : intent.confidence,
  };
}

function normalizeCommandName(command: string | undefined): string | undefined {
  const normalized = command?.trim().replace(/^\//u, '').toLowerCase().replace(/-/gu, '_');
  return normalized || undefined;
}

function extractSymbol(text: string): string | undefined {
  const match = SYMBOL_PATTERN.exec(text);
  return match?.[0];
}

function looksLikeSelectedSymbolAlias(text: string): boolean {
  return /^(selected symbol|selection|current symbol|cursor|current)$/iu.test(text.trim());
}

function toWorkspaceRelativePath(workspaceRoot: string, filePath: string): string | undefined {
  const relative = path.relative(workspaceRoot, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.replace(/\\/g, '/');
}

function toUsableSymbol(value: string): string | undefined {
  if (!value || value.length > 160 || /\r|\n/u.test(value)) {
    return undefined;
  }

  return /^[A-Za-z_$][\w$]*(?:[.:]{1,2}[A-Za-z_$][\w$]*)*$/u.test(value)
    ? value
    : undefined;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...[truncated]`;
}
