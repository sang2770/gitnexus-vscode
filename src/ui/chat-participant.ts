import * as vscode from 'vscode';
import { sendChatParticipantRequest } from '@vscode/chat-extension-utils';
import { getActiveContext } from '../process/group-context.js';

const PARTICIPANT_ID = 'codebrain.gitnexus';

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
    const command = (request.command ?? '').toLowerCase();
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
        selectedKeys.push('beforeAnyCodeChange', 'whenExploringCode');
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
    const command = (request.command ?? '').toLowerCase();
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
          'If user asks for code changes, apply small targeted edits with tools and explain why.',
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
          'If user explicitly asks to implement, create, or edit files, use available tools to perform the change.',
        ].join('\n');
    }
  }

  private selectToolsForRequest(request: vscode.ChatRequest): readonly vscode.LanguageModelToolInformation[] {
    const command = (request.command ?? '').toLowerCase();
    
    // Filter out tools with known schema issues (e.g., mcp_gitkraken tools with invalid schemas)
    const validTools = vscode.lm.tools.filter((tool) => {
      const name = tool.name.toLowerCase();
      // Skip gitkraken workspace tools which have schema validation issues
      if (name.includes('mcp_gitkraken') && name.includes('workspace')) {
        return false;
      }
      return true;
    });
    
    if (command === 'explain' || command === 'impact') {
      // Favor read-only flows for exploration commands while still allowing GitNexus tooling.
      const preferred = ['read', 'search', 'grep', 'query', 'context', 'impact', 'route', 'map'];
      const filtered = validTools.filter((tool) => {
        const name = tool.name.toLowerCase();
        return preferred.some((token) => name.includes(token));
      });
      if (filtered.length > 0) {
        return filtered;
      }
    }

    // /refactor and /debug should keep full capabilities including file edits.
    return validTools;
  }

  public getHandler() {
    return async (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> => {
      const instructionSections = await this.getInstructionSections();
      const instructions = this.buildRelevantInstructions(instructionSections, request);
      const defaultRepoScope = this.getDefaultRepoScope();

      // Resolve a concrete model — "auto" has no real endpoint and causes LM errors
      const model = await this.resolveConcreteModel(request);
      if (!model) {
        stream.markdown('❌ No language model available. Ensure GitHub Copilot is signed in and active.');
        return {};
      }

      // Build active scope context into the prompt
      let contextPrompt = instructions;
      contextPrompt += `\n\n${this.buildCommandPrompt(request)}`;
      if (defaultRepoScope) {
        contextPrompt += `\n\nActive GitNexus scope: ${defaultRepoScope}. Use this as default tool "repo" when not explicitly specified by the user.`;
      }

      const tools = this.selectToolsForRequest(request);

      const result = sendChatParticipantRequest(
        request,
        chatContext,
        {
          model,
          prompt: contextPrompt,
          requestJustification: `CodeBrain command mode: /${request.command ?? 'default'}`,
          responseStreamOptions: {
            stream,
            references: true,
            responseText: true,
          },
          tools,
        },
        token
      );

      return await result.result;
    };
  }
}

export const createGitNexusParticipant = (context: vscode.ExtensionContext): vscode.ChatParticipant => {
  const participant = new GitNexusAgentParticipant(context);
  return vscode.chat.createChatParticipant(PARTICIPANT_ID, participant.getHandler());
};
