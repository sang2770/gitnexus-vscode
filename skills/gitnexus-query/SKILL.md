---
name: gitnexus-query
description: Search the GitNexus knowledge graph for execution flows, symbols, and architectural patterns. Use when asked to find code by concept, understand how a feature works, trace a request path, or locate callers and callees of a symbol.
argument-hint: "<concept or keyword to search>"
user-invocable: true
disable-model-invocation: false
---

# Skill: GitNexus Query

## When to load this skill
- User asks "how does X work?" or "where is X implemented?"
- User wants to trace a request or execution flow.
- User wants to find all code related to a concept or pattern.
- User asks about callers, callees, or process membership of a symbol.

## Steps
1. Use GitNexus `query` with a natural-language description of the concept.
2. Review returned processes (execution flows) ranked by relevance.
3. If a specific symbol is mentioned, use `context` for its 360-degree view.
4. Use `cypher` for custom graph queries when needed.
5. Summarise findings: file locations, flow descriptions, key entry points.

## Tool reference
- `gitnexus_query({ query: "..." })` — find execution flows by concept
- `gitnexus_context({ name: "symbolName" })` — callers, callees, process membership
- `gitnexus_impact({ target: "symbolName", direction: "upstream" })` — blast radius
- `gitnexus_cypher({ query: "MATCH ..." })` — custom graph queries

## Tips
- Prefer `query` over grep/search for conceptual exploration.
- Use `context` to answer "what calls X?" or "what does X depend on?".
- Index must be fresh — if stale, ask user to run `gitnexus analyze` first.
