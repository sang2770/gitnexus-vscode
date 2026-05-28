This document explains how to install, set up, and use CodeBrain in VS Code to analyze code with the GitNexus knowledge graph and GitHub Copilot Chat.

**Introduction**

One of the biggest limitations of using AI in software development is that AI often works with only a narrow slice of the codebase: the current file, a selected code block, or a short prompt. Because of that limited visibility, AI can miss dependencies, misunderstand execution flow, overlook cross-module impact, and suggest changes that appear correct locally but are unsafe at the system level. This problem becomes much more serious in large codebases or multi-repository environments, where even a small change can affect multiple flows that the model cannot infer from local context alone.

The CodeBrain VS Code Extension is designed to solve that exact problem. It connects GitHub Copilot with the GitNexus knowledge graph so that AI works with architectural context, not just text context. Instead of relying only on surrounding code, CodeBrain gives the AI access to symbols, call chains, execution flows, impact analysis, index status, and the active repository or repository group that the user is currently working in.

**1. Prerequisites**
--------------------

* VS Code 1.100.0 or later
* GitHub Copilot installed and signed in
* Node.js 20 or later to run the CLI
* A workspace that is preferably a Git repository

Quick check:

powershellDefaultnode --version
git --version

**2. Install the Extension**
----------------------------

### Install from a VSIX File:

1. Open VS Code.
2. Open Extensions with `Ctrl+Shift+X`.
3. ![image-2026-5-26_8-55-42.png](http://collab.lge.com/main/download/attachments/3683538737/image-2026-5-26_8-55-42.png?version=1&modificationDate=1779760543000&api=v2)
4. Select `Install from VSIX...`.
5. Choose the `codebrain-vscode.vsix` file.

**3. Initial Setup**
--------------------

Open the Command Palette with `Ctrl+Shift+P`, then run:

noneDefaultCodeBrain: Setup

This command is used to:

* Verify or install the CodeBrain CLI
* Configure MCP for GitHub Copilot
* Create the required configuration files for the workspace

After setup, run:

noneDefaultCodeBrain: Analyze Active Context

The analyze command creates a GitNexus index for the currently active repository or group. The chat participant needs this index to query execution flows, symbols, and impact.

Quick action from the status bar: click the status bar item to access setup and analyze actions for the current project.

![image-2026-5-26_8-36-11.png](http://collab.lge.com/main/download/attachments/3683538737/image-2026-5-26_8-36-11.png?version=1&modificationDate=1779759372000&api=v2)

**4. VS Code Interface**
------------------------

After the extension is activated, the activity bar will show a `CodeBrain` section.

![image-2026-5-26_8-43-21.png](http://collab.lge.com/main/download/attachments/3683538737/image-2026-5-26_8-43-21.png?version=1&modificationDate=1779759801000&api=v2)

### Quick Actions

* `Setup CodeBrain (MCP + Agents)`: set up the CLI and MCP
* `Analyze Active Context`: analyze the currently active repo or group
* `Force Re-index`: rebuild the index from scratch
* `Show Index Status`: view current index status
* `Open Graph Dashboard`: open the graph dashboard
* `PR Review`: generate a PR review prompt with CodeBrain

### Repos & Groups

* Select the repository you are currently working on
* Select a group to work across multiple repositories
* Create a new group
* Analyze an individual repository or an entire group

### Status Bar

The status bar displays the current CodeBrain state:

* `Fresh`: the index is up to date
* `Stale`: the code has changed since the last index
* `Not indexed`: the repository has not been analyzed yet
* `Indexing`: an analyze operation is currently running

Click the status bar item to inspect or update the current state.

**5. Using the Chat Participant**
---------------------------------

![image-2026-5-26_8-43-33.png](http://collab.lge.com/main/download/attachments/3683538737/image-2026-5-26_8-43-33.png?version=1&modificationDate=1779759814000&api=v2)

Open GitHub Copilot Chat and type:

noneDefault@CodeBrain

CodeBrain supports the following slash commands:

| Command | Purpose |
| --- | --- |
| `/explain` | Explain code, symbols, execution flow, and dependencies |
| `/impact` | Analyze blast radius before changing code |
| `/debug` | Trace issues, identify root cause, and suggest the smallest safe fix |
| `/refactor` | Guide or perform refactoring with impact validation |
| `/plan` | Build a Jira-to-implementation plan with Atlassian + GitNexus MCP |

### Example: `/explain`

noneDefault@CodeBrain /explain src/ui/chat-participant.ts
Explain how the active GitNexus scope is injected into the prompt.

Use this when you want to understand a flow or file before making changes.

### Example: `/impact`

noneDefault@CodeBrain /impact GitNexusAgentParticipant
What parts of the system would be affected if this class changes?

CodeBrain will prioritize the following:

* Identifying the target symbol
* Running upstream impact analysis
* Reporting direct callers at depth `d=1`
* Warning when the risk level is `HIGH` or `CRITICAL`

### Example: `/debug`

noneDefault@CodeBrain /debug Chat participant reports "No language model available"

Helpful details to include:

* The full error message
* Related files or execution flow
* Reproduction steps

### Example: `/refactor`

noneDefault@CodeBrain /refactor Extract the instruction parsing logic into a separate helper.

For refactoring, CodeBrain performs impact analysis first, then proposes or applies the change when the request explicitly asks for implementation.

**6. Working with Repository Groups**
-------------------------------------

Use groups when you need to analyze multiple related repositories.

### Create a Group

Run:

noneDefaultCodeBrain: Create Repository Group

Then select the repositories you want to include in the group.

### Select an Active Group

Run:

noneDefaultCodeBrain: Select Group

When a group is active, the chat participant injects the active scope into the prompt. For GitNexus tools, the default repo value uses this format:

noneDefault@group-name

### Sync a Group

Run:

noneDefaultCodeBrain: Sync Group

Use this after adding or removing repositories, or when contracts and cross-repository relationships change.

**7. Graph Dashboard**
----------------------

Open the dashboard with:

noneDefaultCodeBrain: Open Graph Dashboard

The dashboard helps you inspect:

* Execution flows
* Dependency graphs
* Repository metadata
* Analyze results

If the dashboard does not open correctly, run:

noneDefaultCodeBrain: Start Web UI Bridge Server

**8. Recommended Workflow**
---------------------------

### When Reading Unfamiliar Code

1. Run `CodeBrain: Analyze Active Context`.
2. Ask `@CodeBrain /explain <concept/file/symbol>`.
3. Use follow-up prompts to inspect callers, callees, or detailed execution flow.

### Before Changing Important Code

1. Ask `@CodeBrain /impact <symbol>`.
2. Review direct callers at depth `d=1`.
3. If the risk is high, split the change into smaller steps.
4. Re-run analyze after the change when needed.

### When Debugging

1. Open the related file if available.
2. Ask `@CodeBrain /debug <symptom/error>`.
3. Ask CodeBrain to trace the flow and identify suspect symbols.
4. Apply only focused, minimal fixes.

### When Refactoring

1. Use `/impact` or `/refactor`.
2. If you rename a symbol, CodeBrain should preview the rename first.
3. Review lower-confidence edits if any are returned.
4. Compile and test after the refactor.

**9. Troubleshooting**
----------------------

### No language model available

* Verify that GitHub Copilot is signed in.
* Open Copilot Chat and select a specific model instead of `auto`.
* Reload the VS Code window.

### Chat Cannot Call GitNexus Tools

* Run `CodeBrain: Setup`.
* Verify the MCP configuration file in the workspace or user profile.
* Reload VS Code.

### Repository Shows No Results

* Run `CodeBrain: Analyze Active Context`.
* If the index is outdated, run `CodeBrain: Force Re-index`.
* Verify that the workspace is a Git repository.

### Group Does Not Show Repositories

* Run `CodeBrain: Sync Group`.
* Check whether each repository has been analyzed individually.
* Verify the group path and registry name.

### CLI Errors or CLI Not Found

Run:

noneDefaultCodeBrain: Install CodeBrain CLI

If the issue persists, check the Output panel:

noneDefaultView: Output -> CodeBrain

**10. Common Commands**
-----------------------

| Command | When to Use |
| --- | --- |
| `CodeBrain: Setup` | Initial setup or MCP configuration repair |
| `CodeBrain: Analyze Active Context` | Create or refresh the index for the active repo or group |
| `CodeBrain: Force Re-index` | Rebuild the index when results are stale or incorrect |
| `CodeBrain: Show Index Status` | Check whether the index is current |
| `CodeBrain: Select Repository` | Switch the active repository |
| `CodeBrain: Select Group` | Switch the active group |
| `CodeBrain: Open Graph Dashboard` | Open the graph UI |
| `CodeBrain: PR Review with CodeBrain` | Assist with reviewing PR changes |
| `CodeBrain: Jira Plan + GitNexus Query` | Build implementation plan from Jira context + GitNexus evidence |

**11. Jira Plan + GitNexus Query (New)**
-------------------------------------

This workflow helps teams convert a Jira ticket into an evidence-driven implementation plan.

Run:

noneDefaultCodeBrain: Jira Plan + GitNexus Query

Then provide:
* Jira issue key, for example PROJ-123
* Optional collaboration context (incident window, release goal, squad scope)

CodeBrain will guide this sequence:
1. Read issue context from Atlassian tools (details, links, comments, assignee, priority).
2. Build an analysis brief (objectives, hypotheses, unknowns).
3. Query GitNexus tools (list_repos, query, context, impact, detect_changes).
4. Produce a structured output: Analysis Brief, GitNexus Findings, Execution Plan, Decision, Jira Comment Draft.
