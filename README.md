# CodeBrain

Repository-aware AI workflows for VS Code, powered by CodeGraph and GitHub Copilot Chat.

CodeBrain helps developers use AI with real repository structure instead of isolated prompt context. It indexes a workspace into a local code graph, selects the most relevant files and relationships for each task, then routes that context into Copilot Chat workflows such as architecture explanation, impact analysis, code review, and test planning.

## AI Campaign Summary

Modern AI coding assistants are strong at generating code, but they often reason from temporary context. In large repositories, that is not enough: a small change can affect callers, tests, API consumers, build flows, and hidden dependencies across multiple modules.

CodeBrain turns the repository into persistent software intelligence:

- CodeGraph builds a local index of files, symbols, dependencies, callers, callees, and impact paths.
- CodeBrain chooses the right workflow and trims context before sending it to Copilot Chat.
- Copilot reasons over graph-backed evidence instead of guessing from nearby files.
- Developers get explainable outputs: context used, why it was selected, token reduction, files scanned, and files selected.

The result is a safer AI workflow for onboarding, refactoring, reviewing, and validating code changes.

## What CodeBrain Does

| Workflow | Use it for | Output |
| --- | --- | --- |
| `@CodeBrain /architecture` | Understand a new repository or module area. | Architecture map, components, relationships, and risks. |
| `@CodeBrain /explain` | Understand a file, symbol, or execution flow. | Step-by-step behavior, data flow, callers/callees, and recommendations. |
| `@CodeBrain /impact` | Check blast radius before changing APIs or shared code. | Direct and indirect dependents, affected modules, risk level, and validation scope. |
| `@CodeBrain /review` | Review staged or working-tree changes. | Findings first, regression risks, missing coverage, and suggested fixes. |
| `@CodeBrain /test` | Build a focused regression checklist. | Unit, integration, and affected-path test recommendations. |
| `@CodeBrain /detect_change` | Map local diffs to impacted code paths. | Changed scope, graph impact, and follow-up validation. |
| `@CodeBrain /plan` | Prepare an Agent-ready implementation plan. | Jira/collab context when available, tasks, target files, constraints, risks, and verification steps. |

## Campaign Demo Guide

Use this flow when submitting or presenting CodeBrain for an AI campaign.

### 1. Install the extension

Open VS Code, then install the packaged extension:

1. Open Extensions with `Ctrl+Shift+X`.
2. Open the `...` menu.
3. Choose `Install from VSIX...`.
4. Select `codebrain-vscode.vsix`.

### 2. Open a real repository

Open any TypeScript, JavaScript, or multi-file application repository. For the clearest demo, choose a project with services, controllers, UI components, tests, or shared utilities.

### 3. Set up CodeBrain

Run this command from the Command Palette:

```text
CodeBrain: Setup CodeBrain Runtime
```

This verifies the bundled CodeGraph runtime and creates the Copilot Agent scaffold at:

```text
.github/agents/codebrain.agent.md
```

### 4. Analyze the workspace

Run:

```text
CodeBrain: Analyze Workspace
```

CodeBrain initializes or syncs the local CodeGraph index for the current workspace.

### 5. Show repository understanding

Open Copilot Chat and ask:

```text
@CodeBrain /architecture
Explain the main modules and how requests flow through this repository.
```

Expected result:

- Key modules and responsibilities.
- Important relationships between files and components.
- Context report showing files scanned and files selected.

### 6. Show impact analysis

Open a service, controller, API handler, or shared utility. Select a function name or type:

```text
@CodeBrain /impact
What will be affected if I change this symbol?
```

Expected result:

- Direct callers and downstream dependents.
- Affected modules or tests.
- Risk summary and validation checklist.

### 7. Show review workflow

Make a small local change, then run:

```text
CodeBrain: Workflow: Review Changes
```

Expected result:

- Findings ordered by severity.
- Graph-backed risk analysis.
- Missing tests or validation steps.
- Clear explanation of selected context.

### 8. Generate a plan

Ask:

```text
@CodeBrain /plan ABC-123
Update the affected callers from the Jira issue and linked collab doc, then propose the safest verification path.
```

Expected result:

- Agent-ready implementation tasks.
- Files likely to edit.
- Risks and rollback notes.
- Test plan for the affected flow.

## Collaboration Guide

Use this section when multiple people are evaluating the extension during an AI campaign demo.

| Role | What to do | Best command |
| --- | --- | --- |
| Presenter | Show how CodeBrain turns a repository into graph-backed AI context. | `@CodeBrain /architecture` |
| Reviewer or judge | Ask what changed and whether the change is risky. | `CodeBrain: Workflow: Review Changes` |
| Developer collaborator | Select a symbol and inspect affected callers, callees, and tests. | `CodeBrain: Impact Lens: Analyze Impact` |
| AI agent operator | Convert analysis into a structured implementation task. | `@CodeBrain /plan` |

Suggested collaboration flow:

1. Presenter runs `CodeBrain: Analyze Workspace`.
2. Reviewer asks for `/architecture` to confirm repository understanding.
3. Developer collaborator makes or selects a small code change.
4. Reviewer runs `/impact` or `Workflow: Review Changes`.
5. AI agent operator uses `/plan` to produce a safe execution plan.
6. Team validates with `/test` before treating the result as merge-ready.

## Why It Is Different

Traditional AI coding assistant:

```text
Reads nearby files -> guesses related context -> generates an answer
```

CodeBrain:

```text
Indexes the repository -> retrieves graph relationships -> optimizes context -> guides Copilot workflows
```

Key differences:

- Persistent repository intelligence instead of one-off prompt retrieval.
- Local-first indexing, suitable for private and enterprise codebases.
- Deterministic graph evidence for callers, callees, dependencies, and impact.
- Workflow-specific context selection for explain, review, impact, test, and implementation planning.
- Transparent context report so reviewers can see what the AI used.

## Core Features

- VS Code chat participant: `@CodeBrain`.
- Built-in MCP server definition provider: `codebrain.codegraph`.
- Bundled CodeGraph runtime under `runtime/codegraph`.
- Impact Lens view for symbol-level impact, callers, callees, tests, and chat handoff.
- Token optimization modes: `auto`, `compact`, `balanced`, `full`, `off`.
- Copilot Agent scaffold at `.github/agents/codebrain.agent.md`.
- Command Palette shortcuts for setup, indexing, workflow prompts, review, and graph queries.

## Requirements

- VS Code `^1.106.0`
- GitHub Copilot Chat extension
- Active GitHub Copilot sign-in
- Node.js for extension development and packaging

## Installation

### Install from VSIX

```text
Extensions -> ... -> Install from VSIX... -> codebrain-vscode.vsix
```

### Install for Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

### Build a VSIX Package

```bash
npm run package
```

The package is written to:

```text
codebrain-vscode.vsix
```

## Quick Start

1. Open a repository in VS Code.
2. Run `CodeBrain: Setup CodeBrain Runtime`.
3. Run `CodeBrain: Analyze Workspace`.
4. Open Copilot Chat.
5. Ask `@CodeBrain /architecture` or `@CodeBrain /explain`.
6. Before changing shared code, ask `@CodeBrain /impact`.
7. Before commit or pull request, run `CodeBrain: Workflow: Review Changes`.

## Recommended Developer Workflow

Use CodeBrain as a safety layer around normal AI-assisted development:

1. Understand the current flow with `/explain`.
2. Check blast radius with `/impact`.
3. Implement the change manually or with Copilot Agent.
4. Review the diff with `/review`.
5. Generate focused validation with `/test`.
6. Re-run `Analyze Workspace` after major branch switches, merges, or large refactors.

## Command Palette Reference

### Setup and Indexing

| Command | What it does |
| --- | --- |
| `CodeBrain: Setup CodeBrain Runtime` | Verifies bundled runtime and bootstraps workspace assets. |
| `CodeBrain: Prepare CodeGraph Runtime` | Rebuilds or refreshes the local CodeGraph runtime from project sources. |
| `CodeBrain: Analyze Workspace` | Initializes or syncs the CodeGraph index for the current workspace. |
| `CodeBrain: Analyze This Item` | Analyzes the selected tree/context item. |
| `CodeBrain: Force Re-index` | Rebuilds the index from scratch. |
| `CodeBrain: Show Index Status` | Displays index health and freshness. |
| `CodeBrain: Query CodeGraph` | Runs direct graph queries for ad-hoc exploration. |
| `CodeBrain: Clean CodeGraph Index` | Removes the workspace CodeGraph index. |

### Workflows

| Command | What it opens |
| --- | --- |
| `CodeBrain: Workflow: Explain Architecture` | `@CodeBrain /architecture` |
| `CodeBrain: Workflow: Explain Current Flow` | `@CodeBrain /explain` |
| `CodeBrain: Workflow: Analyze Impact` | `@CodeBrain /impact` |
| `CodeBrain: Workflow: Review Changes` | `@CodeBrain /review` |
| `CodeBrain: Workflow: Generate Test Plan` | `@CodeBrain /test` |
| `CodeBrain: Workflow: Detect Change Impact` | `@CodeBrain /detect_change` |
| `CodeBrain: Workflow: Generate Plan` | `@CodeBrain /plan` |

### Impact Lens

| Command | What it does |
| --- | --- |
| `CodeBrain: Impact Lens: Analyze Impact` | Runs impact analysis for the selected symbol or cursor target. |
| `CodeBrain: Impact Lens: Find Callers` | Lists upstream call sites. |
| `CodeBrain: Impact Lens: Find Callees` | Lists downstream calls. |
| `CodeBrain: Impact Lens: Find Affected Tests` | Finds likely regression tests. |
| `CodeBrain: Impact Lens: Ask CodeBrain About Target` | Sends active target context into Copilot Chat. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `codebrain.autoSetupOnOpen` | `true` | Automatically run first-time CodeGraph setup on workspace open. |
| `codebrain.autoIndex.onOpen` | `false` | Automatically sync stale workspaces on open. |
| `codebrain.autoIndex.onBranchChange` | `false` | Reserved for future branch-change auto-sync behavior. |
| `codebrain.stalenessCheckIntervalSeconds` | `0` | Periodic sync interval in seconds. `0` disables periodic sync. |
| `codebrain.tokenOptimization.mode` | `auto` | Chooses context optimization mode. |
| `codebrain.tokenOptimization.compactMaxTokens` | `6000` | Target token budget for compact mode. |
| `codebrain.tokenOptimization.balancedMaxTokens` | `12000` | Target token budget for balanced mode. |
| `codebrain.tokenOptimization.fullMaxTokens` | `24000` | Target token budget for full mode. |

## Workflow Output Contract

CodeBrain workflow responses should make context selection auditable:

- Context Used
- Why Selected
- Token Reduction
- Files Scanned
- Files Selected

If a metric is unavailable from CodeGraph output, it should be reported as `Unknown`.

See `docs/codebrain-v2-workflows.md` for the full workflow matrix and behavior contract.

## Troubleshooting

### `No language model available`

- Confirm GitHub Copilot is installed and signed in.
- Open Copilot Chat and choose a concrete model.
- Reload the VS Code window.

### Chat cannot use CodeGraph tools

- Run `CodeBrain: Setup CodeBrain Runtime`.
- Reload VS Code.
- Run `CodeBrain: Analyze Workspace`.

### Index is stale or missing

- Run `CodeBrain: Show Index Status`.
- Run `CodeBrain: Analyze Workspace`.
- Use `CodeBrain: Force Re-index` if results still look outdated.

### Review output has weak context

- Make sure the workspace is a Git repository.
- Re-run `CodeBrain: Analyze Workspace`.
- Ask a more specific question that includes a symbol, file path, or feature name.

## Submission Checklist

Before submitting CodeBrain to an AI campaign:

- Build the VSIX with `npm run package`.
- Install and test `codebrain-vscode.vsix` in a clean VS Code window.
- Run `CodeBrain: Setup CodeBrain Runtime`.
- Run `CodeBrain: Analyze Workspace` on a demo repository.
- Capture screenshots or video of `/architecture`, `/impact`, `/review`, and `/plan`.
- Include the repository link and the packaged VSIX in the submission.
- Highlight that CodeBrain is local-first and uses graph-backed context selection.

## Release Notes

### 2.0.0 - 2026-06-08

CodeBrain v2 introduces a repository-aware AI workflow system powered by CodeGraph and GitHub Copilot Chat.

Added:

- `@CodeBrain` chat participant with `/architecture`, `/explain`, `/impact`, `/review`, `/test`, `/detect_change`, and `/plan`.
- Workflow output contract for context, selection rationale, token reduction, scanned files, and selected files.
- Bundled CodeGraph runtime and indexing lifecycle commands.
- Impact Lens UI for callers, callees, affected tests, impact analysis, and chat handoff.
- Copilot Agent scaffold generation.
- Token optimization modes and configurable token budgets.

Breaking changes:

- Legacy workflow prompts were replaced by structured `@CodeBrain` commands.
- Requirements were updated to VS Code `^1.106.0` and GitHub Copilot Chat.

## License

MIT
