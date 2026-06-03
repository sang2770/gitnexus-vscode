import * as vscode from "vscode";
import path from "path";
import { getActiveContext } from "../process/group-context.js";
import { getOutputChannel } from "../process/cli-runner.js";

const PARTICIPANT_ID = "codebrain.gitnexus";

type CommandMode =
  | "default"
  | "explain"
  | "impact"
  | "debug"
  | "refactor"
  | "plan";

type GitNexusToolKind =
  | "query"
  | "context"
  | "impact"
  | "detect_changes"
  | "rename"
  | "cypher"
  | "list_repos";

type InputTokenEstimate = {
  total: number;
  messageTokens: number;
  toolTokens: number;
  messageCount: number;
  toolCount: number;
};

const READ_ONLY_TOOL_KEYWORDS = [
  "context",
  "detect",
  "diff",
  "explore",
  "fetch",
  "find",
  "get",
  "grep",
  "impact",
  "list",
  "map",
  "open",
  "query",
  "read",
  "route",
  "search",
  "shape",
  "show",
  "status",
  "symbol",
  "tree",
  "workspace",
];

const MUTATING_TOOL_KEYWORDS = [
  "add",
  "analyze",
  "apply",
  "clean",
  "commit",
  "create",
  "delete",
  "edit",
  "generate",
  "install",
  "move",
  "patch",
  "pull",
  "push",
  "remove",
  "rename",
  "replace",
  "reset",
  "run",
  "serve",
  "setup",
  "shell",
  "sync",
  "terminal",
  "update",
  "write",
];

const EDIT_INTENT_PATTERN =
  /\b(add|apply|change|create|delete|edit|extract|fix|implement|move|patch|refactor|remove|rename|replace|split|update|write)\b/i;
const MAX_TOOL_CALL_ROUNDS = 5;
const MAX_CHAT_HISTORY_TURNS = 4;
const MAX_HISTORY_RESPONSE_CHARS = 800;
const MAX_SELECTED_TOOLS = 24;
const TOKEN_ESTIMATE_FALLBACK_CHARS_PER_TOKEN = 4;
const GITNEXUS_TOOL_NAME_HINTS = ["mcp_gitnexus", "gitnexus"];
const STRICT_GITNEXUS_WORKFLOWS: Partial<
  Record<CommandMode, GitNexusToolKind[]>
> = {
  explain: ["query", "context"],
  impact: ["context", "impact"],
  debug: ["query", "context"],
  refactor: ["context", "impact"],
  plan: ["query", "impact"],
};
const GITNEXUS_TOOL_KIND_ALIASES: Record<GitNexusToolKind, string[]> = {
  query: ["query", "search"],
  context: ["context"],
  impact: ["impact"],
  detect_changes: ["detect_changes", "detectchanges"],
  rename: ["rename"],
  cypher: ["cypher"],
  list_repos: ["list_repos", "listrepos"],
};
const GITNEXUS_TOOL_KIND_DESCRIPTION_PATTERNS: Record<
  GitNexusToolKind,
  RegExp[]
> = {
  query: [/process-grouped/i, /hybrid search/i, /execution flows related/i],
  context: [/360/i, /symbol view/i, /categorized refs/i],
  impact: [/blast radius/i, /depth grouping/i, /what breaks/i],
  detect_changes: [/git-diff/i, /changed lines/i, /current changes/i],
  rename: [/coordinated rename/i, /confidence-tagged edits/i],
  cypher: [/cypher/i, /raw graph/i],
  list_repos: [/indexed repositories/i, /discover indexed repos/i],
};
const GITNEXUS_MUTATING_TOOL_NAME_HINTS = [
  "add",
  "analyze",
  "clean",
  "create",
  "delete",
  "generate",
  "group_sync",
  "index",
  "install",
  "remove",
  "rename",
  "serve",
  "setup",
  "sync",
];

const PLAN_TOOL_HINTS = ["atlassian", "jira"];

export class GitNexusAgentParticipant {
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  private getDefaultRepoScope(): string | undefined {
    const active = getActiveContext(this.context.globalState);
    if (!active) {
      return undefined;
    }

    return active.type === "group" ? `@${active.name}` : active.name;
  }

  private normalizeCommand(request: vscode.ChatRequest): CommandMode {
    const command = (request.command ?? "").toLowerCase();
    if (
      command === "explain" ||
      command === "impact" ||
      command === "debug" ||
      command === "refactor" ||
      command === "plan"
    ) {
      return command;
    }

    return "default";
  }

  private promptLooksLikeEditRequest(prompt: string): boolean {
    return EDIT_INTENT_PATTERN.test(prompt);
  }

  private buildRelevantInstructions(request: vscode.ChatRequest): string {
    const command = this.normalizeCommand(request);
    const editIntent = this.promptLooksLikeEditRequest(request.prompt);
    const base = [
      "You are CodeBrain, a GitNexus code-intelligence assistant.",
      "Use GitNexus tools for code structure, execution flow, impact, refactoring, and debugging.",
      "Before code edits: identify the target symbol, run context then upstream impact, report d=1 dependents, and warn on HIGH or CRITICAL risk.",
      "Before commit guidance or after edits, use detect_changes when available.",
      "Answer with concise headings: Context, Findings, Impact / Risk, Recommendation / Action, Self-check.",
    ];

    switch (command) {
      case "explain":
        base.push(
          "/explain: read-only by default; run query then context, then explain the main relationships and flow.",
        );
        break;
      case "impact":
        base.push(
          "/impact: run context then impact; summarize direct dependents, indirect risk, blast radius, and confidence.",
        );
        break;
      case "debug":
        base.push(
          editIntent
            ? "/debug: diagnose with query/context first, then apply the smallest targeted fix."
            : "/debug: diagnose with query/context and stay read-only unless the user asks for a fix.",
        );
        break;
      case "refactor":
        base.push(
          "/refactor: run context then impact before edits; for renames use rename dry_run before applying.",
        );
        break;
      case "plan":
        base.push(
          "/plan: use query then impact to produce a decision-ready plan with risks and tests.",
        );
        break;
      default:
        base.push(
          editIntent
            ? "No slash command: if implementation is requested, perform GitNexus safety checks before tool-based edits."
            : "No slash command: prefer read-only GitNexus exploration first.",
        );
        break;
    }

    return base.join("\n");
  }

  /**
   * Resolve a concrete model from the request.
   * The chat UI may provide an "auto" placeholder model which doesn't map to a real endpoint.
   */
  private async resolveConcreteModel(
    request: vscode.ChatRequest,
  ): Promise<vscode.LanguageModelChat | undefined> {
    const isAuto = (m: vscode.LanguageModelChat) => {
      const id = m.id?.toLowerCase() ?? "";
      const family = m.family?.toLowerCase() ?? "";
      return id === "auto" || family === "auto";
    };

    if (request.model && !isAuto(request.model)) {
      return request.model;
    }

    // "auto" or missing — pick the best concrete Copilot model available
    const copilot = await vscode.lm.selectChatModels({ vendor: "copilot" });
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
      case "explain":
        return [
          "Mode: /explain.",
          "Required tool order: query -> context.",
          "Do not edit files unless explicitly asked.",
        ].join("\n");
      case "impact":
        return [
          "Mode: /impact.",
          "Required tool order: context -> impact.",
          "Report d-levels, blast radius, confidence, and risk.",
        ].join("\n");
      case "debug":
        return [
          "Mode: /debug.",
          "Required tool order: query -> context.",
          editIntent
            ? "After diagnosis, use the smallest targeted edit."
            : "Stay read-only unless a fix is requested.",
        ].join("\n");
      case "refactor":
        return [
          "Mode: /refactor.",
          "Required tool order before edits: context -> impact.",
          "When edits are requested, execute them and summarize changed files plus verification gaps.",
        ].join("\n");
      case "plan":
        return [
          "Mode: /plan.",
          "Required tool order: query -> impact.",
          "Use Jira/Atlassian only when available or attached; otherwise state the gap.",
        ].join("\n");
      default:
        return [
          "No slash command selected.",
          editIntent
            ? "Intent: implementation; run GitNexus safety checks before deterministic file edits."
            : "Intent: exploration; prefer read-only GitNexus tools.",
        ].join("\n");
    }
  }

  private buildWorkspacePrompt(): string | undefined {
    const lines: string[] = [];
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length > 0) {
      lines.push(
        `Workspace folders: ${folders.map((folder) => folder.name).join(", ")}.`,
      );
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const relativePath = vscode.workspace.asRelativePath(
        activeEditor.document.uri,
        false,
      );
      const selection = activeEditor.selection;
      lines.push(`Active editor: ${relativePath}.`);
      if (!selection.isEmpty) {
        lines.push(
          `Active selection: lines ${selection.start.line + 1}-${selection.end.line + 1}.`,
        );
      } else {
        lines.push(`Cursor line: ${selection.active.line + 1}.`);
      }
    }

    return lines.length ? lines.join("\n") : undefined;
  }

  private buildReferencePrompt(
    request: vscode.ChatRequest,
  ): string | undefined {
    if (
      request.references.length === 0 &&
      request.toolReferences.length === 0
    ) {
      return undefined;
    }

    const lines: string[] = [];
    if (request.references.length > 0) {
      const refs = request.references.slice(0, 8).map((ref) => {
        const description = ref.modelDescription ?? ref.id;
        const value = this.describeReferenceValue(ref.value);
        return value ? `${description}: ${value}` : description;
      });
      lines.push(`Attached references: ${refs.join("; ")}.`);
    }

    if (request.toolReferences.length > 0) {
      lines.push(
        `User-attached tools: ${request.toolReferences.map((tool) => tool.name).join(", ")}.`,
      );
    }

    return lines.join("\n");
  }

  private describeReferenceValue(value: unknown): string | undefined {
    if (typeof value === "string") {
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

    if (name.includes("gitnexus")) {
      return true;
    }
    // Skip known schema-problematic GitKraken workspace tools. They can make the
    // model request fail before CodeBrain has a chance to answer.
    if (name.includes("mcp_gitkraken")) {
      return false;
    }

    return (
      typeof tool.inputSchema === "object" ||
      typeof tool.inputSchema === "undefined"
    );
  }

  private normalizeToolName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  }

  private getToolSearchText(
    tool: vscode.LanguageModelToolInformation,
  ): string {
    return `${tool.name} ${tool.description} ${tool.tags.join(" ")}`;
  }

  private toolNameHasHint(normalizedName: string, hint: string): boolean {
    return (
      normalizedName === hint ||
      normalizedName.endsWith(`_${hint}`) ||
      normalizedName.includes(`_${hint}_`)
    );
  }

  private gitNexusToolNameMatchesKind(
    tool: vscode.LanguageModelToolInformation,
    kind: GitNexusToolKind,
  ): boolean {
    const normalizedName = this.normalizeToolName(tool.name);
    return GITNEXUS_TOOL_KIND_ALIASES[kind].some((alias) =>
      this.toolNameHasHint(normalizedName, alias),
    );
  }

  private gitNexusToolDescriptionMatchesKind(
    tool: vscode.LanguageModelToolInformation,
    kind: GitNexusToolKind,
  ): boolean {
    const haystack = this.getToolSearchText(tool);
    return GITNEXUS_TOOL_KIND_DESCRIPTION_PATTERNS[kind].some((pattern) =>
      pattern.test(haystack),
    );
  }

  private selectGitNexusToolByKind(
    tools: vscode.LanguageModelToolInformation[],
    kind: GitNexusToolKind,
  ): vscode.LanguageModelToolInformation | undefined {
    const gitTools = tools.filter((tool) => this.isGitNexusTool(tool));
    return (
      gitTools.find((tool) => this.gitNexusToolNameMatchesKind(tool, kind)) ??
      gitTools.find((tool) =>
        this.gitNexusToolDescriptionMatchesKind(tool, kind),
      )
    );
  }

  private selectStrictGitNexusToolForRound(
    tools: vscode.LanguageModelToolInformation[],
    request: vscode.ChatRequest,
    round: number,
  ): vscode.LanguageModelToolInformation | undefined {
    const command = this.normalizeCommand(request);
    const workflow = STRICT_GITNEXUS_WORKFLOWS[command] ?? [];
    const requiredKind = workflow[round];
    if (!requiredKind) {
      return undefined;
    }

    return this.selectGitNexusToolByKind(tools, requiredKind);
  }

  private isReadOnlyGitNexusTool(
    tool: vscode.LanguageModelToolInformation,
  ): boolean {
    const normalizedName = this.normalizeToolName(tool.name);
    return !GITNEXUS_MUTATING_TOOL_NAME_HINTS.some((hint) =>
      this.toolNameHasHint(normalizedName, hint),
    );
  }

  private isReadOnlyTool(tool: vscode.LanguageModelToolInformation): boolean {
    if (this.isGitNexusTool(tool)) {
      return this.isReadOnlyGitNexusTool(tool);
    }

    const haystack = this.getToolSearchText(tool).toLowerCase();
    const isMutating = MUTATING_TOOL_KEYWORDS.some((keyword) =>
      haystack.includes(keyword),
    );
    if (isMutating) {
      return false;
    }

    return READ_ONLY_TOOL_KEYWORDS.some((keyword) =>
      haystack.includes(keyword),
    );
  }

  private isGitNexusTool(tool: vscode.LanguageModelToolInformation): boolean {
    const haystack = this.getToolSearchText(tool).toLowerCase();
    return GITNEXUS_TOOL_NAME_HINTS.some((hint) => haystack.includes(hint));
  }

  private isCodeBrainTool(tool: vscode.LanguageModelToolInformation): boolean {
    return this.normalizeToolName(tool.name).startsWith("codebrain_");
  }

  private isPlanContextTool(
    tool: vscode.LanguageModelToolInformation,
  ): boolean {
    const haystack = this.getToolSearchText(tool).toLowerCase();
    return PLAN_TOOL_HINTS.some((hint) => haystack.includes(hint));
  }

  private dedupeTools(
    tools: vscode.LanguageModelToolInformation[],
  ): vscode.LanguageModelToolInformation[] {
    const seen = new Set<string>();
    return tools.filter((tool) => {
      if (seen.has(tool.name)) {
        return false;
      }
      seen.add(tool.name);
      return true;
    });
  }

  private getToolPriority(
    tool: vscode.LanguageModelToolInformation,
    request: vscode.ChatRequest,
  ): number {
    let score = 0;
    const command = this.normalizeCommand(request);

    if (request.toolReferences.some((ref) => ref.name === tool.name)) {
      score += 1000;
    }

    if (this.isGitNexusTool(tool)) {
      score += 100;
      const workflow = STRICT_GITNEXUS_WORKFLOWS[command] ?? [];
      const workflowIndex = workflow.findIndex(
        (kind) =>
          this.gitNexusToolNameMatchesKind(tool, kind) ||
          this.gitNexusToolDescriptionMatchesKind(tool, kind),
      );
      if (workflowIndex >= 0) {
        score += 30 - workflowIndex;
      }
    }

    if (this.isCodeBrainTool(tool)) {
      score += 80;
    }

    if (command === "plan" && this.isPlanContextTool(tool)) {
      score += 70;
    }

    return score;
  }

  private sortToolsByPriority(
    tools: vscode.LanguageModelToolInformation[],
    request: vscode.ChatRequest,
  ): vscode.LanguageModelToolInformation[] {
    return [...tools].sort((left, right) => {
      const priorityDelta =
        this.getToolPriority(right, request) -
        this.getToolPriority(left, request);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return left.name.localeCompare(right.name);
    });
  }

  private shouldPreferGitNexusFirstRound(request: vscode.ChatRequest): boolean {
    const command = this.normalizeCommand(request);
    if (
      command === "impact" ||
      command === "explain" ||
      command === "debug" ||
      command === "plan" ||
      command === "refactor"
    ) {
      return true;
    }

    return !this.promptLooksLikeEditRequest(request.prompt);
  }

  private requestAllowsMutatingTools(request: vscode.ChatRequest): boolean {
    const command = this.normalizeCommand(request);
    const editIntent = this.promptLooksLikeEditRequest(request.prompt);
    return (
      command === "refactor" ||
      (command === "debug" && editIntent) ||
      (command === "default" && editIntent)
    );
  }

  private isPostStrictWorkflowRound(
    request: vscode.ChatRequest,
    round: number,
  ): boolean {
    const workflow = STRICT_GITNEXUS_WORKFLOWS[this.normalizeCommand(request)];
    return Boolean(workflow && workflow.length > 0 && round >= workflow.length);
  }

  private selectContinuationTools(
    allTools: vscode.LanguageModelToolInformation[],
    request: vscode.ChatRequest,
  ): vscode.LanguageModelToolInformation[] {
    if (!this.requestAllowsMutatingTools(request)) {
      return [];
    }

    const selectedTools = allTools.filter((tool) => this.isCodeBrainTool(tool));
    const detectChangesTool = this.selectGitNexusToolByKind(
      allTools,
      "detect_changes",
    );
    if (detectChangesTool) {
      selectedTools.push(detectChangesTool);
    }

    if (/\brename\b/i.test(request.prompt)) {
      const renameTool = this.selectGitNexusToolByKind(allTools, "rename");
      if (renameTool) {
        selectedTools.push(renameTool);
      }
    }

    const attachedTools = request.toolReferences
      .map((ref) => allTools.find((tool) => tool.name === ref.name))
      .filter((tool): tool is vscode.LanguageModelToolInformation =>
        Boolean(tool),
      );

    return this.sortToolsByPriority(
      this.dedupeTools([...selectedTools, ...attachedTools]),
      request,
    ).slice(0, 4);
  }

  private toChatTool(
    tool: vscode.LanguageModelToolInformation,
  ): vscode.LanguageModelChatTool {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
  }

  private async pathExists(candidatePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(candidatePath));
      return true;
    } catch {
      return false;
    }
  }

  private async resolveWorkspaceAbsolutePath(
    rawPath: string,
  ): Promise<string | undefined> {
    const trimmed = rawPath.trim();
    if (!trimmed || path.isAbsolute(trimmed) || trimmed.includes("://")) {
      return undefined;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return undefined;
    }

    const normalized = trimmed.replace(/\\/g, "/");
    const lowerNormalized = normalized.toLowerCase();
    const candidates: string[] = [];

    for (const folder of folders) {
      const workspaceRoot = folder.uri.fsPath;
      candidates.push(path.join(workspaceRoot, trimmed));

      const prefix = `${folder.name.toLowerCase()}/`;
      if (lowerNormalized.startsWith(prefix)) {
        const relativeInsideFolder = normalized.slice(prefix.length);
        candidates.push(path.join(workspaceRoot, relativeInsideFolder));
      }
    }

    const deduped = [...new Set(candidates)];
    for (const candidate of deduped) {
      if (await this.pathExists(candidate)) {
        return candidate;
      }
    }

    return deduped[0];
  }

  private async normalizeToolInputPaths(
    toolName: string,
    input: unknown,
  ): Promise<unknown> {
    const lowerName = toolName.toLowerCase();
    const isReadFileTool =
      lowerName.includes("readfile") || lowerName.includes("read_file");

    if (
      !isReadFileTool ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      return input;
    }

    const normalizedInput: Record<string, unknown> = {
      ...(input as Record<string, unknown>),
    };
    const candidateKeys = ["path", "filePath", "resourcePath"];

    for (const key of candidateKeys) {
      const value = normalizedInput[key];
      if (typeof value !== "string") {
        continue;
      }

      const absolutePath = await this.resolveWorkspaceAbsolutePath(value);
      if (absolutePath) {
        normalizedInput[key] = absolutePath;
      }
    }

    return normalizedInput;
  }

  private selectToolsForRequest(
    request: vscode.ChatRequest,
  ): vscode.LanguageModelToolInformation[] {
    const command = this.normalizeCommand(request);
    const allowMutatingTools = this.requestAllowsMutatingTools(request);
    const validTools = vscode.lm.tools.filter((tool) =>
      this.isUsableTool(tool),
    );

    const attachedTools = request.toolReferences
      .map((ref) => validTools.find((tool) => tool.name === ref.name))
      .filter((tool): tool is vscode.LanguageModelToolInformation =>
        Boolean(tool),
      );
    const gitNexusTools = validTools
      .filter((tool) => this.isGitNexusTool(tool))
      .filter(
        (tool) => allowMutatingTools || this.isReadOnlyGitNexusTool(tool),
      );
    const selectedTools = [
      ...gitNexusTools,
      ...(allowMutatingTools
        ? validTools.filter((tool) => this.isCodeBrainTool(tool))
        : []),
      ...(command === "plan"
        ? validTools.filter((tool) => this.isPlanContextTool(tool))
        : []),
      ...attachedTools,
    ];
    const dedupedSelectedTools = this.dedupeTools(selectedTools);

    if (dedupedSelectedTools.length > 0) {
      return this.sortToolsByPriority(dedupedSelectedTools, request).slice(
        0,
        MAX_SELECTED_TOOLS,
      );
    }

    const fallbackTools = validTools.filter((tool) =>
      allowMutatingTools
        ? this.isReadOnlyTool(tool) || this.isCodeBrainTool(tool)
        : this.isReadOnlyTool(tool),
    );
    return this.sortToolsByPriority(fallbackTools, request).slice(
      0,
      MAX_SELECTED_TOOLS,
    );
  }

  private buildHistoryPrompt(
    chatContext: vscode.ChatContext,
  ): string | undefined {
    const turns = chatContext.history.slice(-MAX_CHAT_HISTORY_TURNS);
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
              return part.value instanceof vscode.Uri
                ? part.value.fsPath
                : part.value.uri.fsPath;
            }
            return "";
          })
          .join("")
          .trim();
        if (text) {
          lines.push(`Assistant: ${text.slice(0, MAX_HISTORY_RESPONSE_CHARS)}`);
        }
      }
    }

    return lines.length ? lines.join("\n\n") : undefined;
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

    return [vscode.LanguageModelChatMessage.User(parts.join("\n\n"))];
  }

  private selectToolsForRound(
    allTools: vscode.LanguageModelToolInformation[],
    request: vscode.ChatRequest,
    round: number,
  ): {
    tools: vscode.LanguageModelChatTool[] | undefined;
    toolMode?: vscode.LanguageModelChatToolMode;
  } {
    const toTools = (arr: vscode.LanguageModelToolInformation[]) =>
      arr.map((t) => this.toChatTool(t));

    const pickMode = (tools?: vscode.LanguageModelChatTool[]) => {
      if (!tools || tools.length === 0) return undefined;
      return tools.length === 1
        ? vscode.LanguageModelChatToolMode.Required
        : vscode.LanguageModelChatToolMode.Auto;
    };

    // 1. Strict slash-command workflow: force the next required GitNexus tool.
    const strictGitNexusTool = this.selectStrictGitNexusToolForRound(
      allTools,
      request,
      round,
    );
    if (strictGitNexusTool) {
      return {
        tools: [this.toChatTool(strictGitNexusTool)],
        toolMode: vscode.LanguageModelChatToolMode.Required,
      };
    }

    if (this.isPostStrictWorkflowRound(request, round) || round > 0) {
      const continuationTools = toTools(
        this.selectContinuationTools(allTools, request),
      );
      return {
        tools:
          continuationTools.length > 0 ? continuationTools : undefined,
        toolMode:
          continuationTools.length > 0
            ? vscode.LanguageModelChatToolMode.Auto
            : undefined,
      };
    }

    // 2. User attached tools
    if (round === 0 && request.toolReferences.length > 0) {
      const attached = request.toolReferences
        .map((ref) => vscode.lm.tools.find((t) => t.name === ref.name))
        .filter((t): t is vscode.LanguageModelToolInformation => Boolean(t))
        .filter((t) => this.isUsableTool(t));

      if (attached.length > 0) {
        const tools = toTools(attached);
        return { tools, toolMode: pickMode(tools) };
      }
    }

    // 3. Prefer GitNexus for read-only or ambiguous non-command requests.
    if (round === 0 && this.shouldPreferGitNexusFirstRound(request)) {
      const gitTools = allTools.filter((t) => this.isGitNexusTool(t));

      if (gitTools.length > 0) {
        const tools = toTools(gitTools);
        return { tools, toolMode: pickMode(tools) };
      }
    }

    // 4. Fallback to the full selected tool set.
    const tools = allTools.length > 0 ? toTools(allTools) : undefined;

    return {
      tools,
      toolMode: pickMode(tools),
    };
  }

  private async invokeToolForModel(
    toolCall: vscode.LanguageModelToolCallPart,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResultPart> {
    try {
      const normalizedInput = await this.normalizeToolInputPaths(
        toolCall.name,
        toolCall.input,
      );
      const result = await vscode.lm.invokeTool(
        toolCall.name,
        {
          input: normalizedInput as Record<string, unknown>,
          toolInvocationToken: request.toolInvocationToken,
        },
        token,
      );
      return new vscode.LanguageModelToolResultPart(
        toolCall.callId,
        result.content,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getOutputChannel().appendLine(
        `[CodeBrain Chat] Tool ${toolCall.name} failed: ${message}`,
      );
      return new vscode.LanguageModelToolResultPart(toolCall.callId, [
        new vscode.LanguageModelTextPart(
          `Tool ${toolCall.name} failed: ${message}`,
        ),
      ]);
    }
  }

  private shouldLogTokenEstimates(): boolean {
    return vscode.workspace
      .getConfiguration("codebrain.chat")
      .get<boolean>("logTokenEstimates", true);
  }

  private serializePartForTokenEstimate(part: unknown): string {
    if (part instanceof vscode.LanguageModelTextPart) {
      return part.value;
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      return JSON.stringify({
        toolCall: {
          name: part.name,
          input: part.input,
        },
      });
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      return JSON.stringify({
        toolResult: part.content.map((contentPart) =>
          this.serializePartForTokenEstimate(contentPart),
        ),
      });
    }

    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }

  private serializeMessageForTokenEstimate(
    message: vscode.LanguageModelChatMessage,
  ): string {
    const role =
      message.role === vscode.LanguageModelChatMessageRole.Assistant
        ? "assistant"
        : "user";
    return [
      role,
      message.name ?? "",
      ...message.content.map((part) => this.serializePartForTokenEstimate(part)),
    ].join("\n");
  }

  private async countTokensForEstimate(
    model: vscode.LanguageModelChat,
    value: string | vscode.LanguageModelChatMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    if (token.isCancellationRequested) {
      return 0;
    }

    try {
      return await model.countTokens(value, token);
    } catch {
      const text =
        typeof value === "string"
          ? value
          : this.serializeMessageForTokenEstimate(value);
      return Math.ceil(text.length / TOKEN_ESTIMATE_FALLBACK_CHARS_PER_TOKEN);
    }
  }

  private serializeToolsForTokenEstimate(
    tools: vscode.LanguageModelChatTool[] | undefined,
  ): string {
    if (!tools || tools.length === 0) {
      return "";
    }

    try {
      return JSON.stringify(tools);
    } catch {
      return tools
        .map(
          (tool) =>
            `${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema ?? {})}`,
        )
        .join("\n\n");
    }
  }

  private async logInputTokenEstimate(
    label: string,
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    tools: vscode.LanguageModelChatTool[] | undefined,
    token: vscode.CancellationToken,
  ): Promise<InputTokenEstimate | undefined> {
    if (!this.shouldLogTokenEstimates()) {
      return undefined;
    }

    const toolText = this.serializeToolsForTokenEstimate(tools);
    const [messageTokens, toolTokens] = await Promise.all([
      Promise.all(
        messages.map((message) =>
          this.countTokensForEstimate(model, message, token),
        ),
      ).then((values) => values.reduce((sum, value) => sum + value, 0)),
      toolText
        ? this.countTokensForEstimate(model, toolText, token)
        : Promise.resolve(0),
    ]);
    const toolCount = tools?.length ?? 0;
    const estimate: InputTokenEstimate = {
      total: messageTokens + toolTokens,
      messageTokens,
      toolTokens,
      messageCount: messages.length,
      toolCount,
    };

    getOutputChannel().appendLine(
      [
        `[CodeBrain Chat] Input token estimate (${label}):`,
        `total=${estimate.total},`,
        `messages=${estimate.messageTokens},`,
        `tools=${estimate.toolTokens},`,
        `messageCount=${estimate.messageCount},`,
        `toolCount=${estimate.toolCount}`,
      ].join(" "),
    );

    return estimate;
  }

  private async logOutputTokenEstimate(
    label: string,
    model: vscode.LanguageModelChat,
    text: string,
    toolCalls: vscode.LanguageModelToolCallPart[],
    token: vscode.CancellationToken,
    inputEstimate?: InputTokenEstimate,
  ): Promise<void> {
    if (!this.shouldLogTokenEstimates()) {
      return;
    }

    const toolCallText = toolCalls
      .map((toolCall) => this.serializePartForTokenEstimate(toolCall))
      .join("\n");
    const [textTokens, toolCallTokens] = await Promise.all([
      text
        ? this.countTokensForEstimate(model, text, token)
        : Promise.resolve(0),
      toolCallText
        ? this.countTokensForEstimate(model, toolCallText, token)
        : Promise.resolve(0),
    ]);
    const outputTotal = textTokens + toolCallTokens;
    const inputTotal = inputEstimate?.total;

    getOutputChannel().appendLine(
      [
        `[CodeBrain Chat] Output token estimate (${label}):`,
        `total=${outputTotal},`,
        `text=${textTokens},`,
        `toolCalls=${toolCallTokens},`,
        `toolCallCount=${toolCalls.length},`,
        `inputTotal=${inputTotal ?? "unknown"},`,
        `roundTotal=${inputTotal === undefined ? "unknown" : inputTotal + outputTotal}`,
      ].join(" "),
    );
  }

  private async sendFinalAnswerRequest(
    messages: vscode.LanguageModelChatMessage[],
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    model: vscode.LanguageModelChat,
  ): Promise<vscode.ChatResult> {
    messages.push(
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelTextPart(
          [
            "Tool-call budget reached.",
            "Use the tool results already provided above to answer the current user request now.",
            "Use the standard GitNexus headings: Context, Findings, Impact / Risk, Recommendation / Action, Self-check.",
            "Do not request or mention additional tool calls.",
            "If evidence is incomplete, state what is missing and give the best next action.",
          ].join(" "),
        ),
      ]),
    );

    const inputEstimate = await this.logInputTokenEstimate(
      "final-answer",
      model,
      messages,
      undefined,
      token,
    );
    const response = await model.sendRequest(
      messages,
      {
        justification: `CodeBrain final answer mode: /${request.command ?? "default"}`,
      },
      token,
    );

    let text = "";
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      }
    }
    await this.logOutputTokenEstimate(
      "final-answer",
      model,
      text,
      [],
      token,
      inputEstimate,
    );

    if (text.trim()) {
      stream.markdown(text);
      return {};
    }

    const message =
      "CodeBrain gathered tool results but the model did not produce a final answer.";
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
    selectedTools: vscode.LanguageModelToolInformation[],
  ): Promise<vscode.ChatResult> {
    const messages = this.buildInitialMessages(
      request,
      chatContext,
      contextPrompt,
    );

    for (let round = 0; round < MAX_TOOL_CALL_ROUNDS; round += 1) {
      const toolSelection = this.selectToolsForRound(
        selectedTools,
        request,
        round,
      );
      const inputEstimate = await this.logInputTokenEstimate(
        `tool-round-${round + 1}`,
        model,
        messages,
        toolSelection.tools,
        token,
      );
      const response = await model.sendRequest(
        messages,
        {
          justification: `CodeBrain command mode: /${request.command ?? "default"}`,
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
      await this.logOutputTokenEstimate(
        `tool-round-${round + 1}`,
        model,
        textParts.map((part) => part.value).join(""),
        toolCalls,
        token,
        inputEstimate,
      );

      if (toolCalls.length === 0) {
        const text = textParts.map((part) => part.value).join("");
        if (text) {
          stream.markdown(text);
        }
        return {};
      }

      messages.push(
        vscode.LanguageModelChatMessage.Assistant([...textParts, ...toolCalls]),
      );
      const toolResults = await Promise.all(
        toolCalls.map((toolCall) =>
          this.invokeToolForModel(toolCall, request, token),
        ),
      );
      messages.push(vscode.LanguageModelChatMessage.User(toolResults));
    }

    return this.sendFinalAnswerRequest(messages, request, stream, token, model);
  }

  private maybeHandleEmptyRequest(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): vscode.ChatResult | undefined {
    if (
      request.prompt.trim() ||
      request.references.length > 0 ||
      request.toolReferences.length > 0
    ) {
      return undefined;
    }

    const command = this.normalizeCommand(request);
    const examples: Record<CommandMode, string[]> = {
      default: [
        "`@CodeBrain /explain authentication flow`",
        "`@CodeBrain /impact UserService.authenticate`",
        "`@CodeBrain /debug Login intermittently times out`",
        "`@CodeBrain /refactor Rename parseConfig to parseWorkspaceConfig`",
        "`@CodeBrain /plan PROJ-123 checkout latency incident`",
      ],
      explain: [
        "`@CodeBrain /explain src/ui/chat-participant.ts`",
        "`@CodeBrain /explain how active repo context is resolved`",
      ],
      impact: [
        "`@CodeBrain /impact GitNexusAgentParticipant`",
        "`@CodeBrain /impact runCodeBrain`",
      ],
      debug: [
        "`@CodeBrain /debug MCP server fails to start`",
        "`@CodeBrain /debug chat participant returns no language model available`",
      ],
      refactor: [
        "`@CodeBrain /refactor extract instruction parsing into a helper`",
        "`@CodeBrain /refactor rename GitNexusAgentParticipant to CodeBrainChatParticipant`",
      ],
      plan: [
        "`@CodeBrain /plan PROJ-123`",
        "`@CodeBrain /plan Build implementation plan for checkout timeout spikes`",
      ],
    };

    stream.markdown(
      [
        "Tell CodeBrain what code, symbol, flow, or problem to work on.",
        "",
        "Examples:",
        ...examples[command].map((example) => `- ${example}`),
      ].join("\n"),
    );

    stream.button({
      command: "codebrain.analyze",
      title: "Analyze Active Context",
    });
    return {
      metadata: { codebrainCommand: command, handledBy: "emptyRequest" },
    };
  }

  private buildErrorResult(
    error: unknown,
    stream: vscode.ChatResponseStream,
  ): vscode.ChatResult {
    const message = error instanceof Error ? error.message : String(error);
    const outputChannel = getOutputChannel();
    outputChannel.appendLine(`[CodeBrain Chat] Request failed: ${message}`);
    if (error instanceof Error && error.stack) {
      outputChannel.appendLine(error.stack);
    }

    stream.markdown(
      [
        "CodeBrain could not complete this chat request.",
        "",
        `Reason: ${message}`,
        "",
        "Check the CodeBrain output channel for details, then retry after verifying Copilot and the GitNexus MCP tools are available.",
      ].join("\n"),
    );

    return { errorDetails: { message } };
  }

  private sanitizeChatContext(
    chatContext: vscode.ChatContext,
  ): vscode.ChatContext {
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
    metadata: vscode.ChatResult["metadata"],
    command: CommandMode,
    defaultRepoScope: string | undefined,
    selectedToolCount: number,
  ): vscode.ChatResult["metadata"] {
    const { toolCallsMetadata: _toolCallsMetadata, ...safeMetadata } =
      metadata ?? {};
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
        const command = (result.metadata?.codebrainCommand ??
          "default") as CommandMode;
        const followups: Record<CommandMode, vscode.ChatFollowup[]> = {
          default: [
            {
              label: "Explain current file",
              prompt: "Explain the active file and its main execution flow.",
              command: "explain",
            },
            {
              label: "Run impact analysis",
              prompt:
                "Run impact analysis for the main symbol I am working on.",
              command: "impact",
            },
            {
              label: "Debug a failure",
              prompt:
                "Help me debug the failure I am seeing and trace the root cause.",
              command: "debug",
            },
          ],
          explain: [
            {
              label: "Check impact",
              prompt:
                "Run impact analysis for the main symbol from this explanation.",
              command: "impact",
            },
            {
              label: "Find callers",
              prompt:
                "Find the direct callers and callees for the main symbol.",
              command: "explain",
            },
          ],
          impact: [
            {
              label: "Plan refactor",
              prompt:
                "Create a safe refactoring plan for this impacted symbol.",
              command: "refactor",
            },
            {
              label: "Explain flow",
              prompt: "Explain the affected execution flow in more detail.",
              command: "explain",
            },
          ],
          debug: [
            {
              label: "Apply minimal fix",
              prompt: "Apply the smallest safe fix for the diagnosed issue.",
              command: "refactor",
            },
            {
              label: "Check impact",
              prompt: "Run impact analysis for the suspect symbol.",
              command: "impact",
            },
          ],
          refactor: [
            {
              label: "Verify scope",
              prompt:
                "Verify the changed scope and summarize affected execution flows.",
              command: "impact",
            },
            {
              label: "Explain changes",
              prompt: "Explain what changed and why it is safe.",
              command: "explain",
            },
          ],
          plan: [
            {
              label: "Run impact checks",
              prompt:
                "Run impact analysis for each symbol in the plan and report risk.",
              command: "impact",
            },
            {
              label: "Draft Jira update",
              prompt:
                "Turn this plan into a Jira comment with risks, owners, and test checklist.",
              command: "plan",
            },
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
      token: vscode.CancellationToken,
    ): Promise<vscode.ChatResult> => {
      const emptyResult = this.maybeHandleEmptyRequest(request, stream);
      if (emptyResult) {
        return emptyResult;
      }

      const command = this.normalizeCommand(request);
      const instructions = this.buildRelevantInstructions(request);
      const defaultRepoScope = this.getDefaultRepoScope();

      // Resolve a concrete model; "auto" has no real endpoint and causes LM errors.
      const model = await this.resolveConcreteModel(request);
      if (!model) {
        const message =
          "No language model available. Ensure GitHub Copilot is signed in and active.";
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
        contextPrompt +=
          "\n\nNo active GitNexus scope is set. Prefer discovering indexed repos/groups before using GitNexus tools that require a repo.";
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
          metadata: this.buildResultMetadata(
            chatResult.metadata,
            command,
            defaultRepoScope,
            tools.length,
          ),
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

export const createGitNexusParticipant = (
  context: vscode.ExtensionContext,
): vscode.ChatParticipant => {
  const agent = new GitNexusAgentParticipant(context);
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    agent.getHandler(),
  );
  participant.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "resources",
    "icon.png",
  );
  participant.followupProvider = agent.getFollowupProvider();
  return participant;
};
