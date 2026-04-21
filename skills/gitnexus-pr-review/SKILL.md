---
name: gitnexus-pr-review
description: Run a structured GitNexus MCP-based PR review to detect blast radius, dependency risks, and missing tests. Use when asked to review a PR, analyse change impact, validate a diff, or assess merge safety.
argument-hint: "<PR description, changed files, or diff summary> [optional: strictness level]"
user-invocable: true
disable-model-invocation: false
---

# Skill: GitNexus PR Review

## When to load this skill
- User asks for a PR review, code review, or impact analysis.
- User wants to know what can break after a set of changes.
- User asks about merge safety or test coverage gaps.

## Steps
1. Identify changed files and infer touched symbols.
2. Run `gitnexus detect_changes` (scope: staged or compare) to enumerate modified symbols.
3. Run `gitnexus impact` on each critical symbol (direction: upstream, depth ≥ 2).
4. Check call chains, route/tool/process edges, and cross-file coupling.
5. Report findings sorted by severity: critical → high → medium → low.
6. Add **Test Gaps** section with specific missing unit/integration/e2e scenarios.
7. State **Merge Confidence**: High / Medium / Low with reasoning.

## Report Template
```
## PR Review — GitNexus Analysis

### Scope
[files and symbols reviewed]

### Findings
| Severity | Symbol/File | Risk | Fix |
|----------|-------------|------|-----|
| critical | … | … | … |

### Test Gaps
- [ ] Missing test for …

### Merge Confidence: High | Medium | Low
Reason: …
```

## Tool reference
- `gitnexus_detect_changes({ scope: "staged" })` — changed symbols
- `gitnexus_impact({ target: "X", direction: "upstream" })` — blast radius
- `gitnexus_context({ name: "X" })` — full call graph for symbol
- `gitnexus_cypher({ query: "MATCH ..." })` — custom dependency queries

## Notes
- If index is stale, ask user to run `gitnexus analyze` before reviewing.
- Prefer graph evidence over assumptions. Do not suggest broad rewrites.
- If no blocking defects: state clearly, list residual risks.
