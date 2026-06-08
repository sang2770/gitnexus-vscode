# CodeBrain v2 Design Prompt (Updated)

You are a Principal VS Code Extension Architect, GitHub Copilot Extension Expert, MCP Specialist, and AI Workflow System Designer.

I am building a VS Code extension called CodeBrain.

---

# Existing Architecture

CodeBrain is a VS Code extension.

Current stack:

* VS Code Extension API
* GitHub Copilot Chat Participant
* GitHub Copilot Agent Mode
* CodeGraph MCP Server
* CodeGraph Indexing Engine

Current capabilities:

* Workspace indexing
* Index status UI
* Auto MCP setup
* Chat Participant
* Commands:

  * explain
  * impact
  * detect_change

Current problem:

The extension currently feels like a thin wrapper around the CodeGraph CLI.

I want to transform CodeBrain into a repository-aware AI workflow orchestration layer.

---

# Product Positioning

Do NOT position CodeBrain as a replacement for CodeGraph.

Do NOT position CodeBrain as a replacement for GitHub Copilot.

Position it as:

CodeGraph
= Repository Intelligence Engine

GitHub Copilot
= Reasoning + Agent Execution Engine

CodeBrain
= Workflow Orchestration + Context Optimization Layer

---

# Main Goal

The extension should help developers:

1. Understand repositories faster
2. Analyze impact before changes
3. Review changes safely
4. Reduce token usage
5. Generate high-quality tasks for Copilot Agent
6. Use repository intelligence instead of naive file retrieval

---

# Primary UX Surface

Focus primarily on:

* Chat Participant
* Slash Commands
* Context Menus
* Quick Actions
* Selected Symbol Actions

Avoid building large dashboards unless directly tied to workflows.

---

# IMPORTANT ARCHITECTURE PRINCIPLE

CodeBrain should NOT behave like a generic chatbot.

CodeBrain should behave like a repository-aware workflow engine.

The correct architecture is:

Developer Intent
→ Workflow Resolution
→ Repository Graph Retrieval
→ Context Optimization
→ Copilot Reasoning
→ Agent Task Generation

NOT:

User Prompt
→ AI Answer

---

# INTENT RESOLUTION DESIGN

IMPORTANT:

Do NOT over-engineer natural language parsing.

Use a deterministic workflow-first approach.

Priority order:

1. Slash commands
2. VS Code editor context
3. Selected symbol
4. Git diff context
5. Regex-based symbol extraction
6. Lightweight LLM fallback only when confidence is low

Examples:

/impact AuthService.login
→ deterministic impact workflow

Selected symbol + "Analyze Impact"
→ deterministic impact workflow

/review
→ git diff workflow

Natural language should be treated as optional enhancement, not primary architecture.

---

# Intent Resolver Requirements

Design an Intent Resolver layer.

Example architecture:

* CommandParser
* SymbolExtractor
* EditorContextResolver
* GitContextResolver
* HeuristicIntentResolver
* OptionalLLMFallback

The Intent Resolver should output structured intent objects.

Example:

```json
{
  "workflow": "impact",
  "target": "AuthService.login",
  "targetType": "symbol",
  "contextMode": "balanced",
  "confidence": 0.98
}
```

IMPORTANT:

If confidence is low, the extension should ask follow-up clarification questions instead of hallucinating intent.

Example:

"Auth seems weird"

→ Ask:

What would you like to do?

* Explain Flow
* Analyze Impact
* Review Changes
* Generate Fix Plan
* Debug Issue

---

# CORE PRODUCT DIFFERENTIATOR

The core innovation is NOT prompt engineering.

The core innovation is:

Intent
→ Repository Graph Query Planning
→ Context Optimization

The extension should:

* Convert developer intent into graph retrieval plans
* Use CodeGraph to retrieve structurally relevant code
* Reduce unnecessary context before invoking Copilot

The extension must NOT blindly send prompts to Copilot.

---

# CONTEXT OPTIMIZATION

This is the most important feature.

CodeBrain must reduce repository context before sending requests to Copilot.

Use CodeGraph graph retrieval to select relevant files and symbols.

Support:

## Compact Mode

* current symbol
* direct references

Use for:

* explain
* quick understanding

## Balanced Mode

* symbol
* callers
* callees
* direct dependencies
* related tests

Use for:

* impact
* review
* fix_plan

## Full Mode

* broader dependency graph
* dependency clusters
* architecture-level traversal

Use for:

* architecture
* large refactors
* feature implementation

For every workflow show:

* files scanned
* files selected
* estimated tokens
* reduction percentage
* why files were selected

Example:

Context Used:

✓ AuthController.ts
✓ AuthService.ts
✓ JwtProvider.ts

Files Scanned: 312
Files Selected: 3

Estimated Tokens:
Before: 28,000
After: 4,200

Reduction: 85%

Why Selected:

AuthController.ts
→ calls AuthService.login()

JwtProvider.ts
→ dependency of AuthService

---

# QUERY PLANNING

The extension must NOT let AI freely explore the repository.

Instead:

CodeBrain should generate deterministic graph retrieval plans.

Examples:

## Explain workflow

Queries:

* search_symbols
* find_callers
* find_callees
* find_references

## Impact workflow

Queries:

* find_callers
* find_callees
* find_references
* find_tests

## Review workflow

Queries:

* git_diff
* changed_symbols
* affected_dependencies
* related_tests

## Architecture workflow

Queries:

* entry_points
* dependency_clusters
* module_relationships

---

# COPILOT AGENT INTEGRATION

CodeBrain should NOT directly edit files.

Instead:

CodeBrain should generate structured Agent Tasks.

Workflow:

Developer Intent
→ CodeGraph Retrieval
→ Context Optimization
→ Copilot Reasoning
→ Fix Plan
→ Run with Copilot Agent

Generated Agent Tasks should include:

* files to edit
* constraints
* risks
* implementation plan
* tests to update
* validation steps

---

# REQUIRED COMMANDS

Design the following commands:

* /architecture
* /explain
* /impact
* /review
* /test
* /detect_change
* /fix_plan

For each command specify:

* Intent parsing strategy
* MCP tools required
* Graph query plan
* Context optimization strategy
* Prompt construction strategy
* Output schema
* Example conversation

---

# REQUIRED WORKFLOWS

Design complete workflows for:

1. Repository onboarding
2. Feature implementation
3. Impact analysis
4. Review current changes
5. Generate implementation plans
6. Generate test plans

---

# EXPLAINABILITY

Every response must include:

* Context Used
* Why Selected
* Token Reduction
* Files Scanned
* Files Selected

This is mandatory.

---

# COMPETITION DEMO

Design a complete demo using:

AuthService.ts

Flow:

1. Developer modifies AuthService
2. CodeBrain reviews changes
3. CodeBrain analyzes impact
4. CodeBrain generates fix plan
5. Copilot Agent executes plan

Provide:

* exact user actions
* exact commands
* expected outputs
* retrieval explanation
* token reduction explanation
* judging highlights

---

# IMPLEMENTATION REQUIREMENTS

Focus on practical implementation.

Avoid:

* generic chatbot features
* autonomous agent chaos
* unrestricted MCP tool calling
* dashboard-heavy UX

Prefer:

* deterministic workflows
* predictable retrieval
* repository-aware orchestration
* context efficiency
* explainable AI behavior

---

# FINAL PRODUCT MESSAGE

The product should feel like:

"A repository-aware AI workflow system"

NOT:

"A chat UI around MCP"

The extension should demonstrate:

* repository intelligence
* graph-aware retrieval
* context optimization
* deterministic workflows
* AI-assisted development orchestration
