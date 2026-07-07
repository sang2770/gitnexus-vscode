import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getOutputChannel, getWorkspaceRoot } from '../process/cli-runner.js';
import {
  buildWorkflowInstructions,
  type CodeGraphToolKind,
  getEditorIntentContext,
  resolveWorkflowIntent,
  type WorkflowIntent,
} from '../workflows/intent-resolver.js';

interface DiagramGroundedToolResult {
  kind: CodeGraphToolKind;
  toolName: string;
  text: string;
}

interface GenerateDiagramFromModelOptions {
  target: string;
  token: vscode.CancellationToken;
  toolInvocationToken?: vscode.ChatParticipantToolToken;
  diagramType?: string;
}

interface GenerateDiagramFromModelResult {
  filePath: string;
  markdown: string;
  responseText: string;
  intent: WorkflowIntent;
}

const CODEGRAPH_TOOL_HINTS = ['codegraph'];
const DIAGRAM_TOOL_KINDS: CodeGraphToolKind[] = ['search', 'callers', 'callees', 'explore'];
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

export async function generateDiagramPreviewFromModel(
  options: GenerateDiagramFromModelOptions,
): Promise<GenerateDiagramFromModelResult> {
  const workspaceRoot = getWorkspaceRoot();
  const intent = resolveWorkflowIntent({
    command: '/diagram',
    prompt: options.target,
    workspaceRoot,
    editorContext: getEditorIntentContext(workspaceRoot),
  });
  const model = await resolveDiagramModel();

  if (!model) {
    throw new Error('No chat model is available.');
  }

  const selectedTools = selectDiagramTools();
  const toolResults = await collectDiagramToolResults({
    selectedTools,
    intent,
    token: options.token,
    toolInvocationToken: options.toolInvocationToken,
    rawPrompt: options.target,
  });

  const prompt = buildDiagramGenerationPrompt(intent, options.target, toolResults, options.diagramType);
  const response = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(prompt)],
    { justification: 'CodeBrain diagram generation' },
    options.token,
  );

  let responseText = '';
  for await (const part of response.stream) {
    if (part instanceof vscode.LanguageModelTextPart) {
      responseText += part.value;
    }
  }

  const markdown = extractMermaidMarkdownFromResponse(responseText) ?? buildFallbackMermaidMarkdown(intent.target);
  const filePath = await writeDiagramPreviewFile(markdown, intent.target);

  return {
    filePath,
    markdown,
    responseText: responseText.trim(),
    intent,
  };
}

export async function writeDiagramPreviewFile(markdown: string, target?: string): Promise<string> {
  const previewDir = path.join(os.tmpdir(), 'codebrain', 'diagram-preview');
  await fs.promises.mkdir(previewDir, { recursive: true });

  const fileName = `${slugify(target ?? 'diagram-preview')}-${Date.now()}.md`;
  const filePath = path.join(previewDir, fileName);
  await fs.promises.writeFile(filePath, markdown, 'utf8');
  return filePath;
}

export function extractMermaidMarkdownFromResponse(text: string): string | undefined {
  const fenced = /```mermaid\s*([\s\S]*?)```/iu.exec(text);
  if (!fenced || !fenced[1]) {
    return undefined;
  }

  const content = fenced[1].trim();
  if (!content) {
    return undefined;
  }

  const body = content.endsWith('\n') ? content : `${content}\n`;
  return ['# CodeBrain Diagram', '', '```mermaid', body.trimEnd(), '```', ''].join('\n');
}

export function buildFallbackMermaidMarkdown(target: string | undefined): string {
  const safeTarget = escapeMermaidLabel(target?.trim() || 'diagram target');

  return [
    '# CodeBrain Diagram',
    '',
    '```mermaid',
    'flowchart LR',
    `  target["${safeTarget}"]`,
    '',
    '```',
  ].join('\n');
}

async function resolveDiagramModel(): Promise<vscode.LanguageModelChat | undefined> {
  const copilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (copilotModels.length > 0) {
    return copilotModels[0];
  }

  const models = await vscode.lm.selectChatModels();
  return models[0];
}

function getToolSearchText(tool: vscode.LanguageModelToolInformation): string {
  return `${tool.name} ${tool.description} ${tool.tags.join(' ')}`;
}

function isCodeGraphTool(tool: vscode.LanguageModelToolInformation): boolean {
  const haystack = getToolSearchText(tool).toLowerCase();
  return CODEGRAPH_TOOL_HINTS.some((hint) => haystack.includes(hint));
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function toolNameHasHint(normalizedName: string, hint: string): boolean {
  return normalizedName === hint || normalizedName.endsWith(`_${hint}`) || normalizedName.includes(`_${hint}_`);
}

function toolMatchesKind(tool: vscode.LanguageModelToolInformation, kind: CodeGraphToolKind): boolean {
  const normalizedName = normalizeToolName(tool.name);
  return TOOL_ALIASES[kind].some((alias) => toolNameHasHint(normalizedName, alias));
}

function selectDiagramTools(): vscode.LanguageModelToolInformation[] {
  return vscode.lm.tools.filter((tool) => {
    if (!isCodeGraphTool(tool)) {
      return false;
    }
    return DIAGRAM_TOOL_KINDS.some((kind) => toolMatchesKind(tool, kind));
  });
}

async function collectDiagramToolResults(input: {
  selectedTools: vscode.LanguageModelToolInformation[];
  intent: WorkflowIntent;
  token: vscode.CancellationToken;
  toolInvocationToken?: vscode.ChatParticipantToolToken;
  rawPrompt: string;
}): Promise<DiagramGroundedToolResult[]> {
  const results: DiagramGroundedToolResult[] = [];
  for (const kind of DIAGRAM_TOOL_KINDS) {
    const tool = input.selectedTools.find((candidate) => toolMatchesKind(candidate, kind));
    if (!tool) {
      continue;
    }

    try {
      const result = await vscode.lm.invokeTool(
        tool.name,
        {
          input: buildCodeGraphToolInput(kind, input.intent, input.rawPrompt),
          toolInvocationToken: input.toolInvocationToken,
        },
        input.token,
      );
      results.push({
        kind,
        toolName: tool.name,
        text: getToolResultContentText(result.content),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getOutputChannel().appendLine(`[CodeBrain Diagram] Tool ${tool.name} failed: ${message}`);
      results.push({
        kind,
        toolName: tool.name,
        text: `Tool ${tool.name} failed: ${message}`,
      });
    }
  }
  return results;
}

function buildCodeGraphToolInput(
  kind: CodeGraphToolKind,
  intent: WorkflowIntent,
  rawPrompt: string,
): Record<string, unknown> {
  const workspaceRoot = getWorkspaceRoot();
  const target = intent.target ?? (rawPrompt.trim() || 'current workspace');
  const query = [intent.target, rawPrompt.trim()].filter(Boolean).join('\n') || target;

  switch (kind) {
    case 'status':
      return { projectPath: workspaceRoot };
    case 'files':
      return { format: 'tree', maxDepth: 4, projectPath: workspaceRoot };
    case 'explore':
      return { query, maxFiles: 8, projectPath: workspaceRoot };
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

function getToolResultContentText(
  content: Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart | vscode.LanguageModelDataPart | unknown>,
): string {
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

function buildDiagramGenerationPrompt(
  intent: WorkflowIntent,
  rawPrompt: string,
  toolResults: DiagramGroundedToolResult[],
  diagramType?: string,
): string {
  const typeRequirement = diagramType 
    ? `- Return exactly one fenced code block using \`\`\`mermaid of type: **${diagramType}**.` 
    : '- Return exactly one fenced code block using ```mermaid.';

  return [
    buildWorkflowInstructions(intent),
    '',
    'Focused command-mode requirements:',
    '- Use the CodeGraph tool results below as the only repository evidence.',
    '- Generate a Mermaid diagram for the requested target.',
    typeRequirement,
    diagramType ? '' : '- Prefer a readable flowchart LR, sequenceDiagram, or C4-style Mermaid variant that fits the evidence.',
    '- Do not include explanations before or after the code block.',
    '',
    `Requested target: ${rawPrompt}`,
    '',
    'CodeGraph tool results:',
    toolResults.length > 0
      ? toolResults.map((result) => [
          `Tool: ${result.toolName}`,
          `Kind: ${result.kind}`,
          result.text || '(no text result)',
        ].join('\n')).join('\n\n')
      : 'No CodeGraph tools were available for this workflow.',
  ].filter((line) => line !== '').join('\n');
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .replace(/-+$/u, '');

  return normalized || 'diagram-preview';
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/"/g, '&quot;');
}