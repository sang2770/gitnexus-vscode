---
name: "CodeBrain CodeGraph Workflow Skill"
description: "Repository-aware workflow orchestration using CodeGraph MCP context optimization before Copilot reasoning or Agent execution."
---

# CodeBrain v2 Workflow Rules

Use this skill when working inside CodeBrain workflows.

## Positioning

- CodeGraph is the repository intelligence engine.
- GitHub Copilot is the reasoning and Agent execution engine.
- CodeBrain is the workflow orchestration and context optimization layer.

Do not treat CodeBrain as a generic chatbot. The workflow is:

Developer intent -> workflow resolution -> CodeGraph retrieval -> context optimization -> Copilot reasoning -> Agent task generation.

## Required Workflows

- `/architecture`: explain repository architecture with full-mode graph context.
- `/explain`: explain a symbol, file, or flow with compact graph context.
- `/impact`: analyze callers, callees, blast radius, and d-level risk.
- `/review`: review selected/current/diff changes with graph-aware context.
- `/test`: generate a focused test plan from affected behavior and dependencies.
- `/detect_change`: map working-tree changes to affected flows, risks, and validation scope.
- `/fix_plan`: produce a structured Copilot Agent task, including files, constraints, risks, tests, and validation.

## Context Modes

- Compact: current symbol and direct references. Use for quick explanation.
- Balanced: symbol, callers, callees, dependencies, and related tests. Use for impact, review, test, detect_change, and fix_plan.
- Full: broader dependency graph, module relationships, and architecture clusters. Use for architecture and large refactors.

## Mandatory Response Sections

Every response must include:

- Context Used
- Why Selected
- Token Reduction
- Files Scanned
- Files Selected

If a metric is unavailable, write `Unknown` and explain what CodeGraph evidence is missing. Do not invent numbers.

## Agent Task Policy

CodeBrain should not directly edit files from chat. For implementation requests, generate a Copilot Agent Task with:

- files to edit
- constraints
- risks
- implementation plan
- tests to update
- validation steps
