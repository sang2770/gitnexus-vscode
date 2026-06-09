# CodeBrain v2 Workflow Specification

CodeBrain v2 positions the extension as a repository-aware AI workflow system:

```text
Developer intent
-> Workflow resolution
-> Repository graph retrieval
-> Context optimization
-> Copilot reasoning
-> Agent task generation
```

## Product Roles

- CodeGraph: repository intelligence engine.
- GitHub Copilot: reasoning and Agent execution engine.
- CodeBrain: workflow orchestration and context optimization layer.

## Command Matrix

| Command | Intent Parsing | MCP Tools | Query Plan | Context Mode | Output |
| --- | --- | --- | --- | --- | --- |
| `/architecture` | Slash command, architecture/onboarding keywords, repository context | `codegraph_status`, `codegraph_files`, `codegraph_explore` | status -> files -> explore clusters | Full | architecture map, selected context, risks |
| `/explain` | Slash command, selected symbol, current editor, regex symbol | `codegraph_explore`, `codegraph_callers`, `codegraph_callees`, `codegraph_node` | explore -> optional callers/callees -> optional node | Compact | main flow, data flow, recommendation |
| `/impact` | Slash command or selected symbol; ask clarification if no symbol | `codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact` | search -> callers -> callees -> impact | Balanced | d-level risk, blast radius, recommendations |
| `/review` | Slash command, SCM command, diff keywords | `codegraph_status`, `codegraph_explore`, `codegraph_impact` | status -> changed-area explore -> optional impact | Balanced | findings first, risk, coverage note |
| `/test` | Slash command, test/coverage keywords, selected target | `codegraph_explore`, `codegraph_impact`, `codegraph_files` | explore behavior/tests -> optional impact -> optional files | Balanced | test targets, cases, validation |
| `/detect_change` | Slash command, SCM context, change keywords | `codegraph_status`, `codegraph_explore`, `codegraph_impact` | status -> changed-area explore -> optional impact | Balanced | changed scope, impact, validation |
| `/plan` | Slash command, Jira/collab references, task/debug/refactor keywords, selected target | `codegraph_explore`, `codegraph_impact`, `codegraph_node`, optional Atlassian/Jira/Confluence tools | explore -> impact -> optional Jira/collab context -> optional node | Balanced | implementation plan and Copilot Agent task |

## Mandatory Explainability

Every workflow response must include:

- Context Used
- Why Selected
- Token Reduction
- Files Scanned
- Files Selected

If CodeGraph output does not expose a metric, the response must use `Unknown` and name the missing evidence.

## Required Workflows

### Repository Onboarding

1. User runs `CodeBrain: Analyze Workspace`.
2. User asks `@CodeBrain /architecture`.
3. CodeBrain checks freshness, reads file layout, explores entry points, and explains module relationships.

### Feature Implementation

1. User asks `@CodeBrain /plan implement session timeout from ABC-123`.
2. CodeBrain explores relevant flows, runs impact analysis, and pulls available Jira/collab context through MCP Atlassian.
3. CodeBrain returns a Copilot Agent task with requirements, files, constraints, risks, tests, and validation steps.

### Impact Analysis

1. User selects a symbol or asks `@CodeBrain /impact AuthService.login`.
2. CodeBrain resolves the symbol, checks callers/callees, then runs impact.
3. CodeBrain summarizes d-level risk and impacted modules.

### Review Current Changes

1. User runs `CodeBrain: Workflow: Review Changes` from SCM or Command Palette.
2. CodeBrain prepares diff context and affected-test preflight.
3. Chat review leads with findings, then risk and test coverage.

### Generate Implementation Plans

1. User asks `@CodeBrain /plan <task, issue, or collab doc>`.
2. CodeBrain retrieves graph context, impact, and available Jira/collab context.
3. Output is an Agent-ready task, not direct file edits.

### Generate Test Plans

1. User asks `@CodeBrain /test <symbol or behavior>`.
2. CodeBrain explores target behavior and impacted dependents.
3. Output names focused unit/integration cases and validation commands.

## AuthService Competition Demo

### Exact User Actions

1. Open `AuthService.ts`.
2. Modify `AuthService.login`.
3. Run `CodeBrain: Workflow: Review Changes`.
4. Ask `@CodeBrain /impact AuthService.login`.
5. Ask `@CodeBrain /plan update callers for the AuthService.login change`.
6. Run the generated Copilot Agent task.

### Expected Review Output

- Context Used: changed `AuthService.ts`, direct callers, related auth tests.
- Why Selected: changed symbol and graph edges to controllers/providers.
- Token Reduction: repository files scanned, selected files, estimated before/after tokens.
- Findings: correctness issues, missing caller updates, missing tests.
- Impact / Risk: direct d1 callers and downstream auth/session flows.
- Recommendation: update callers and add regression coverage.
- Self-check: stale index and dynamic usage caveats.

### Retrieval Explanation

```text
codegraph_status
-> codegraph_explore("AuthService login changed files")
-> codegraph_search("AuthService.login")
-> codegraph_callers("AuthService.login")
-> codegraph_callees("AuthService.login")
-> codegraph_impact("AuthService.login")
```

### Judging Highlights

- Deterministic workflow resolution, not generic chat.
- Graph-aware context retrieval before Copilot reasoning.
- Visible context reduction and selected-file rationale.
- Fix plan produces a safe Copilot Agent task with risks and validation.
