# CodeBrain VS Code Extension

CodeBrain v2.0.0 is a repository-aware AI workflow orchestration layer for VS Code.

- CodeGraph is the repository intelligence engine.
- GitHub Copilot is the reasoning and Agent execution engine.
- CodeBrain orchestrates workflow resolution, graph retrieval, context optimization, and Copilot Agent task generation.

The extension is designed to feel like a repository-aware AI workflow system, not a chat UI around MCP.

## Features

- CodeGraph MCP provider for VS Code: `codebrain.codegraph`.
- Bundled CodeGraph self-contained runtime launched from `runtime/codegraph` for both MCP and CLI commands.
- Agent Skill contribution at `skills/codegraph/SKILL.md`.
- Workspace Copilot agent generation at `.github/agents/codebrain.agent.md`.
- `@CodeBrain` chat participant with `/architecture`, `/explain`, `/impact`, `/review`, `/test`, `/detect_change`, and `/fix_plan`.
- Deterministic intent resolver that prioritizes slash commands, editor context, selected symbols, git diff context, and lightweight heuristics.
- Workflow query planning that constrains CodeGraph MCP tool usage per workflow instead of allowing open-ended repository exploration.
- Context optimization modes: compact, balanced, and full.
- Mandatory explainability in workflow answers: Context Used, Why Selected, Token Reduction, Files Scanned, and Files Selected.
- Copilot Agent task generation for fix and test workflows instead of direct chat-driven file edits.
- Workspace commands for setup, analyze/sync, force re-index, status, query, code review, and clean index.
- Structured Webview reports for index status and CodeGraph query results, with clickable file/line navigation.
- Token optimization engine with selectable `auto`, `compact`, `balanced`, `full`, and `off` modes.
- Impact Lens sidebar view for the current editor target: impact, callers, callees, affected tests, and chat handoff.
- Active context is the selected workspace/project path. Multi-root workspaces prompt for the target folder.

The extension no longer ships the legacy dashboard, repository groups, registry context, bridge server, wiki generation, or retired-provider command/tool wrappers.

## Requirements

- VS Code `^1.106.0`.
- GitHub Copilot Chat for chat participant and Agent Skills usage.
- Node.js/npm are only needed when developing the extension and rebuilding the local CodeGraph runtime.

## Commands

- `CodeBrain: Workflow: Explain Architecture` opens `@CodeBrain /architecture` with full-mode graph context.
- `CodeBrain: Workflow: Explain Current Flow` opens `@CodeBrain /explain` for the selected symbol, cursor symbol, or current file.
- `CodeBrain: Workflow: Analyze Impact` opens `@CodeBrain /impact` with balanced callers/callees/blast-radius planning.
- `CodeBrain: Workflow: Review Changes` reviews selection, current file, staged changes, working tree, or a base-branch diff.
- `CodeBrain: Workflow: Generate Test Plan` opens `@CodeBrain /test` for focused regression planning.
- `CodeBrain: Workflow: Detect Change Impact` opens `@CodeBrain /detect_change` for working-tree impact detection.
- `CodeBrain: Workflow: Generate Fix Plan` opens `@CodeBrain /fix_plan` and asks Copilot to produce an Agent-ready task.
- `CodeBrain: Set Token Optimization Mode` changes the workspace token optimization mode.
- `CodeBrain: Setup CodeBrain Runtime` verifies the bundled CodeGraph runtime and creates `.github/agents/codebrain.agent.md` when missing. VS Code MCP is contributed by the extension, so no `.vscode/mcp.json` or user `mcp.json` setup is required.
- `CodeBrain: Create CodeBrain Copilot Agent` creates or refreshes `.github/agents/codebrain.agent.md`.
- `CodeBrain: Prepare CodeGraph Runtime` builds the local `codegraph/` runtime when needed.
- `CodeBrain: Analyze Workspace` runs `codegraph init <path>` when no `.codegraph/codegraph.db` exists, otherwise `codegraph sync <path>`.
- `CodeBrain: Force Re-index` runs `codegraph index <path> --force`.
- `CodeBrain: Show Index Status` runs `codegraph status <path> --json` and reports `fresh`, `stale`, or `not-indexed`.
- `CodeBrain: Query CodeGraph` runs `codegraph query <query> --limit 5`.
- `CodeBrain: Review Code with CodeBrain` reviews selected code, the current file, staged changes, working tree changes, or a base-branch diff with CodeGraph context.
- `CodeBrain: Impact Lens: Analyze Impact` runs `codegraph impact <symbol> --json` for the selected symbol or cursor word.
- `CodeBrain: Impact Lens: Find Callers` and `Find Callees` run the matching CodeGraph traversal command and show clickable results.
- `CodeBrain: Impact Lens: Find Affected Tests` runs `codegraph affected <current-file> --json`.
- `CodeBrain: Clean CodeGraph Index` runs `codegraph uninit <path> --force`.

## Workflow Contract

Every `@CodeBrain` workflow follows the same architecture:

```text
Developer intent
-> Workflow resolution
-> Repository graph retrieval
-> Context optimization
-> Copilot reasoning
-> Agent task generation
```

Workflow responses must show the selected context and token-reduction estimate. If CodeGraph output does not expose a metric, CodeBrain should mark it as `Unknown` rather than inventing a number.

See [docs/codebrain-v2-workflows.md](./docs/codebrain-v2-workflows.md) for the command matrix, required workflows, and AuthService competition demo.

Token optimization can be configured with `CodeBrain: Set Token Optimization Mode` or the `codebrain.tokenOptimization.mode` setting:

- `auto`: use each workflow default.
- `compact`: fewer query results and shorter chat history.
- `balanced`: default practical mode for impact/review/fix workflows.
- `full`: broader context for architecture and large changes.
- `off`: keep estimates visible but stop reducing context by mode.


## Build

```bash
npm install
npm run build
npm run package
```

`npm run build` builds CodeGraph from the local `codegraph/` directory, then stages `runtime/codegraph` as a self-contained bundle with the vendored Node runtime, `lib/dist`, production dependencies, and a platform launcher. It does not install or update a remote CodeGraph package.

## Test Plan

```bash
npm --prefix codegraph test -- __tests__/installer-targets.test.ts __tests__/installer.test.ts __tests__/mcp-tool-allowlist.test.ts __tests__/status-json.test.ts
npm run compile
npm run build
npm run package
```

Manual Extension Development Host checks:

- MCP: List Servers shows CodeGraph and tools `codegraph_explore`, `codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_node`, `codegraph_files`, and `codegraph_status`.
- Command Palette does not show dashboard, group, registry, wiki, bridge, Jira, or retired-provider commands.
- Setup, Analyze, Force Re-index, Status, Query, and Review Code run through CodeGraph.
- Chat participant exposes `/architecture`, `/explain`, `/impact`, `/review`, `/test`, `/detect_change`, and `/fix_plan`.
- Ambiguous chat prompts ask for workflow clarification instead of guessing.
- Workflow answers include Context Used, Why Selected, Token Reduction, Files Scanned, and Files Selected.
- Fix and test workflows generate Copilot Agent tasks instead of directly editing files from chat.
- Impact Lens tracks the active editor target and opens result items at their file/line.
- `codegraph files --path GitNexus` does not return source from `GitNexus/`.
