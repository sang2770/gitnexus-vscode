import * as path from 'path';
import * as vscode from 'vscode';

export type CodeBrainWorkflowKind =
  | 'architecture'
  | 'explain'
  | 'impact'
  | 'review'
  | 'test'
  | 'detect_change'
  | 'diagram'
  | 'plan';

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

export const LOCALIZED_HEADERS = {
  en: {
    contextUsed: 'Context Used',
    externalContextUsed: 'External Context Used',
    whySelected: 'Why Selected',
    tokenReduction: 'Token Reduction',
    selfCheck: 'Self-check',
    findings: 'Findings',
    architectureOverview: 'Architecture Overview',
    architectureFindings: 'Architecture Findings',
    flowDiagram: 'Flow Diagram',
    risks: 'Risks',
    recommendedNextActions: 'Recommended Next Actions',
    mainFlow: 'Main Flow',
    dataFlow: 'Data Flow',
    recommendation: 'Recommendation',
    recommendationAction: 'Recommendation / Action',
    impactRisk: 'Impact / Risk',
    changedScope: 'Changed Scope',
    testTargets: 'Test Targets',
    recommendedTestCases: 'Recommended Test Cases',
    validationSteps: 'Validation Steps',
    plan: 'Plan',
    copilotAgentTask: 'Copilot Agent Task',
  },
  vi: {
    contextUsed: 'Ngữ cảnh sử dụng',
    externalContextUsed: 'Ngữ cảnh bên ngoài sử dụng',
    whySelected: 'Lý do lựa chọn',
    tokenReduction: 'Tối ưu hóa Token',
    selfCheck: 'Tự kiểm tra',
    findings: 'Kết quả phân tích',
    architectureOverview: 'Tổng quan kiến trúc',
    architectureFindings: 'Cấu trúc kiến trúc',
    flowDiagram: 'Sơ đồ luồng',
    risks: 'Rủi ro',
    recommendedNextActions: 'Hành động đề xuất tiếp theo',
    mainFlow: 'Luồng xử lý chính',
    dataFlow: 'Luồng dữ liệu',
    recommendation: 'Khuyến nghị',
    recommendationAction: 'Khuyến nghị / Hành động',
    impactRisk: 'Ảnh hưởng / Rủi ro',
    changedScope: 'Phạm vi thay đổi',
    testTargets: 'Mục tiêu kiểm thử',
    recommendedTestCases: 'Kịch bản kiểm thử đề xuất',
    validationSteps: 'Các bước kiểm chứng',
    plan: 'Kế hoạch triển khai',
    copilotAgentTask: 'Nhiệm vụ cho Copilot Agent',
  },
  ko: {
    contextUsed: '사용된 컨텍스트',
    externalContextUsed: '사용된 외부 컨텍스트',
    whySelected: '선택 이유',
    tokenReduction: '토큰 감축',
    selfCheck: '자가 점검',
    findings: '분석 결과',
    architectureOverview: '아키텍처 개요',
    architectureFindings: '아키텍처 분석',
    flowDiagram: '흐름 다이어그램',
    risks: '리스크',
    recommendedNextActions: '추천 후속 조치',
    mainFlow: '주요 흐름',
    dataFlow: '데이터 흐름',
    recommendation: '추천 사항',
    recommendationAction: '추천 사항 / 작업',
    impactRisk: '영향도 / 리스크',
    changedScope: '변경 범위',
    testTargets: '테스트 대상',
    recommendedTestCases: '추천 테스트 케이스',
    validationSteps: '검증 단계',
    plan: '구현 계획',
    copilotAgentTask: 'Copilot 에이전트 작업',
  }
};

export type LocalizedHeaderKey = keyof typeof LOCALIZED_HEADERS.en;

const CONTEXT_REPORT_KEYS: ReadonlySet<LocalizedHeaderKey> = new Set([
  'contextUsed',
  'externalContextUsed',
  'whySelected',
  'tokenReduction',
  'selfCheck',
]);

export interface WorkflowDefinition {
  kind: CodeBrainWorkflowKind;
  slashCommand: string;
  label: string;
  contextMode: ContextMode;
  intentParsingStrategy: string;
  mcpToolsRequired: CodeGraphToolKind[];
  supplementalMcpToolHints?: string[];
  graphQueryPlan: string[];
  supplementalContextPlan?: string[];
  contextOptimizationStrategy: string;
  promptConstructionStrategy: string;
  outputSchema: LocalizedHeaderKey[];
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
  diagram: 'diagram',
  diagrams: 'diagram',
  flow_diagram: 'diagram',
  workflow_diagram: 'diagram',
  fix_plan: 'plan',
  plan: 'plan',
  implementation_plan: 'plan',
  refactor: 'plan',
  debug: 'plan',
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
      'architectureOverview',
      'architectureFindings',
      'flowDiagram',
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
      'mainFlow',
      'dataFlow',
      'flowDiagram',
    ],
    exampleConversation: [
      'User: @CodeBrain /explain AuthService.login',
      'CodeBrain: explores AuthService.login, checks direct callers/callees, and explains the grounded flow.',
    ],
    toolPlan: [
      { toolKind: 'explore', purpose: 'Retrieve compact source context for the target flow.', required: true },
      { toolKind: 'callers', purpose: 'Confirm direct entry points for the explained symbol.', required: false },
      { toolKind: 'callees', purpose: 'Confirm direct dependencies for the explained symbol.', required: false },
      { toolKind: 'node', purpose: 'Fetch exact symbol body only if explore trimmed necessary details.', required: false },
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
      'findings',
      'impactRisk',
      'recommendedNextActions',
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
      'findings',
      'impactRisk',
      'recommendationAction',
      'validationSteps',
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
      'testTargets',
      'recommendedTestCases',
      'validationSteps',
      'copilotAgentTask',
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
      'changedScope',
      'impactRisk',
      'recommendedNextActions',
      'validationSteps',
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
  diagram: {
    kind: 'diagram',
    slashCommand: '/diagram',
    label: 'Diagram Workflow',
    contextMode: 'balanced',
    intentParsingStrategy:
      'Slash command first, then diagram keywords; selected symbol/file scopes the diagram target.',
    mcpToolsRequired: ['search', 'callers', 'callees', 'explore'],
    supplementalMcpToolHints: [],
    graphQueryPlan: [
      'codegraph_search: resolve target symbol or query scope.',
      'codegraph_callers: collect upstream nodes for flow edges.',
      'codegraph_callees: collect downstream nodes for flow edges.',
      'codegraph_explore: enrich with behavior/context when symbol resolution is broad.',
    ],
    supplementalContextPlan: [
      'Use CodeGraph evidence to generate a Mermaid markdown preview that can be opened directly in VS Code.',
    ],
    contextOptimizationStrategy:
      'Balanced mode: keep target symbol, key callers/callees, and concise context needed for a valid diagram model.',
    promptConstructionStrategy:
      'Produce diagram-ready output grounded in CodeGraph evidence, including a Mermaid snippet suitable for markdown preview.',
    outputSchema: [],
    exampleConversation: [
      'User: @CodeBrain /diagram AuthService.login',
      'CodeBrain: resolves target, pulls callers/callees/explore context, then returns a Mermaid fenced code block.',
    ],
    toolPlan: [
      { toolKind: 'search', purpose: 'Resolve a stable target for diagram generation.', required: true },
      { toolKind: 'callers', purpose: 'Collect incoming flow edges.', required: true },
      { toolKind: 'callees', purpose: 'Collect outgoing flow edges.', required: true },
      { toolKind: 'explore', purpose: 'Add essential contextual flow details.', required: false },
    ],
    producesAgentTask: false,
  },
  plan: {
    kind: 'plan',
    slashCommand: '/plan',
    label: 'Plan',
    contextMode: 'balanced',
    intentParsingStrategy:
      'Slash command, selected symbol, Jira/collab references, implementation-plan keywords, or issue/debug/refactor wording.',
    mcpToolsRequired: ['explore', 'impact', 'node'],
    supplementalMcpToolHints: ['atlassian', 'jira', 'confluence', 'collab'],
    graphQueryPlan: [
      'codegraph_explore: retrieve relevant flow and constraints.',
      'codegraph_impact: inspect blast radius before proposing edits.',
      'codegraph_node: fetch exact symbol details only if needed for a precise plan.',
    ],
    supplementalContextPlan: [
      'mcp-atlassian (optional): pull Jira issue fields, acceptance criteria, linked tickets, and collaboration/Confluence document context when the request includes an issue key, Jira URL, collab link, or attached Atlassian tools.',
      'Merge external product requirements with CodeGraph evidence; call out any Jira/doc context that was unavailable instead of inventing it.',
    ],
    contextOptimizationStrategy:
      'Balanced mode: target behavior, external requirements, direct dependencies, risky dependents, and likely tests.',
    promptConstructionStrategy:
      'Generate a plan first, combining CodeGraph evidence with Jira/collab requirements when available, then produce a structured Copilot Agent task with edit files, constraints, risks, tests, and validation steps.',
    outputSchema: [
      'findings',
      'impactRisk',
      'plan',
      'copilotAgentTask',
      'validationSteps',
    ],
    exampleConversation: [
      'User: @CodeBrain /plan ABC-123 add auth token rotation using the linked collab design',
      'CodeBrain: explores auth flows, checks impact, pulls available Jira/collab context, then produces a task Copilot Agent can execute.',
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

export function detectLanguage(prompt: string): 'vi' | 'ko' | 'en' {
  const envLang = vscode.env.language.toLowerCase();
  if (envLang.startsWith('vi')) {
    return 'vi';
  }
  if (envLang.startsWith('ko')) {
    return 'ko';
  }

  // Check prompt text for Vietnamese accents
  const viRegex = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/u;
  if (viRegex.test(prompt)) {
    return 'vi';
  }

  // Check prompt text for Korean characters (Hangul)
  const koRegex = /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/u;
  if (koRegex.test(prompt)) {
    return 'ko';
  }

  return 'en';
}

function isContextReportEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>('codebrain.showContextReport', false);
}

function getResponseSchemaKeys(schema: LocalizedHeaderKey[]): LocalizedHeaderKey[] {
  return schema.filter(key => !CONTEXT_REPORT_KEYS.has(key));
}

function getLocalizedSchema(schema: LocalizedHeaderKey[], lang: 'vi' | 'ko' | 'en'): string[] {
  const headers = LOCALIZED_HEADERS[lang];

  return getResponseSchemaKeys(schema).map(key => headers[key]);
}

function getWorkflowSpecificOutputRequirements(
  workflow: CodeBrainWorkflowKind,
  headers: typeof LOCALIZED_HEADERS.en,
): string[] {
  switch (workflow) {
    case 'architecture':
      return [
        `- Focus on high-level system shape in "${headers.architectureOverview}".`,
        `- In "${headers.architectureFindings}", summarize major modules, responsibilities, boundaries, and important dependencies.`,
        `- In "${headers.flowDiagram}", include one Mermaid fenced code block that shows the main architecture or runtime interaction flow.`,
      ];
    case 'explain':
      return [
        `- Focus on explaining the runtime path in "${headers.mainFlow}" and the state/input-output movement in "${headers.dataFlow}".`,
        `- In "${headers.flowDiagram}", include one Mermaid fenced code block that shows the concrete execution flow for the explained target.`,
      ];
    case 'impact':
      return [
        `- Focus on what is affected, why it is affected, and what should be checked next in "${headers.recommendedNextActions}".`,
      ];
    case 'review':
      return [
        `- Lead with concrete review findings, then give corrective action in "${headers.recommendationAction}" and checks in "${headers.validationSteps}".`,
      ];
    case 'test':
      return [
        `- Focus on what to test, the exact scenarios to cover, and a concrete agent-executable task in "${headers.copilotAgentTask}".`,
      ];
    case 'detect_change':
      return [
        `- Focus on what changed, the likely blast radius, and what to validate immediately.`,
      ];
    case 'plan':
      return [
        `- Focus on implementation findings, execution plan, risks, validation, and the final agent task only.`,
      ];
    default:
      return [];
  }
}

export function buildWorkflowInstructions(intent: WorkflowIntent): string {
  const lang = detectLanguage(intent.rawPrompt);
  const definition = WORKFLOW_DEFINITIONS[intent.workflow];
  const headers = LOCALIZED_HEADERS[lang];
  const localizedSchema = getLocalizedSchema(definition.outputSchema, lang);
  const orderedWorkflowSections = localizedSchema.join(' -> ');
  const workflowSpecificRequirements = getWorkflowSpecificOutputRequirements(intent.workflow, headers);

  const languageInstructions = {
    en: 'Mandatory: Write the entire response in English. Use English for all headers and section titles.',
    vi: 'Mandatory: Bạn PHẢI viết toàn bộ phản hồi bằng tiếng Việt. Sử dụng tiếng Việt cho tất cả các tiêu đề và phần nội dung.',
    ko: 'Mandatory: 전체 응답을 한국어로 작성해야 합니다. 모든 헤더와 섹션 제목에 한국어를 사용하십시오.'
  };

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

  const promptParts = [
    'CodeBrain v2.0 workflow contract:',
    'You are CodeBrain, a repository-aware AI workflow orchestration and context optimization layer.',
    'Positioning: CodeGraph is the repository intelligence engine. GitHub Copilot is the reasoning and agent execution engine. CodeBrain orchestrates workflow resolution, graph retrieval, context optimization, and agent task generation.',
    'Do not behave like a generic chatbot. Resolve intent into the workflow below, retrieve graph evidence first, then reason.',
    'Do not directly edit files from this chat participant. For implementation work, generate a structured Copilot Agent Task.',
    '',
    languageInstructions[lang],
    '',
    `Resolved intent:\n${intentJson}`,
    '',
    `Workflow: ${definition.label} (${definition.slashCommand})`,
    `Context mode: ${intent.contextMode}`,
    '',
    'Graph query plan:',
    ...definition.graphQueryPlan.map((step) => `- ${step}`),
    '',
    `Context optimization strategy: ${definition.contextOptimizationStrategy}`,
    `Prompt construction strategy: ${definition.promptConstructionStrategy}`,
    ...(definition.supplementalContextPlan?.length
      ? [
          '',
          'Supplemental MCP context plan:',
          ...definition.supplementalContextPlan.map((step) => `- ${step}`),
        ]
      : []),
    '',
  ];

  if (intent.workflow === 'diagram') {
    promptParts.push(
      'Mandatory output requirements:',
      '- Return exactly one fenced code block using ```mermaid.',
      '- Do not include any explanations, introduction, or other markdown headers before or after the code block.'
    );
  } else {
    const mandatoryRequirements = [
      'Mandatory output requirements:',
    ];

    mandatoryRequirements.push(
      '- Use CodeGraph tool results as evidence. Do not blindly answer from prompt text.',
      '- Return only the sections relevant to this slash workflow. Do not include context-report/meta sections unless the user explicitly asks for them.',
      `- Keep the answer workflow-shaped and use this section order: ${orderedWorkflowSections}.`,
      ...workflowSpecificRequirements
    );

    promptParts.push(...mandatoryRequirements);
  }

  if (intent.workflow !== 'diagram') {
    promptParts.push(
      '',
      'Expected output schema:',
      ...localizedSchema.map((section) => `- ${section}`)
    );
  }

  return promptParts.join('\n');
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
    '- Generate Diagram: `/diagram <symbol or flow>`',
    '- Generate Plan: `/plan <task, issue, or collab doc>`',
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

  if (/\b(diagram|flow diagram|workflow diagram|architecture diagram|sequence diagram)\b/u.test(lower)) {
    const target = resolveTarget(prompt, 'diagram', editorContext);
    return baseIntent('diagram', target.value, target.type, target.value ? 0.76 : 0.5, 'heuristic', prompt);
  }

  if (/\b(impact|blast radius|callers|callees|dependents?)\b/u.test(lower)) {
    const target = symbol ?? editorContext.selectedSymbol ?? editorContext.cursorSymbol;
    return baseIntent('impact', target, target ? 'symbol' : 'unknown', target ? 0.74 : 0.45, target ? 'regex-symbol' : 'low-confidence', prompt);
  }

  if (/\b(test plan|tests?|coverage|regression)\b/u.test(lower)) {
    const target = resolveTarget(prompt, 'test', editorContext);
    return baseIntent('test', target.value, target.type, target.value ? 0.72 : 0.5, 'heuristic', prompt);
  }

  if (/\b(plan|fix plan|implementation plan|implement|debug|bug|refactor|rename|extract|jira|confluence|collab)\b/u.test(lower)) {
    const target = resolveTarget(prompt, 'plan', editorContext);
    return baseIntent('plan', target.value, target.type, target.value ? 0.7 : 0.5, 'heuristic', prompt);
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
