# CodeBrain VS Code Extension

CodeBrain is a powerful VS Code extension that brings AI-powered code intelligence to your development workflow. It integrates with GitHub Copilot and the GitNexus knowledge graph to provide advanced code analysis, impact assessment, debugging guidance, and refactoring assistance.

Hướng dẫn sử dụng tiếng Việt: [docs/HDSD.md](./docs/HDSD.md)

## Features

### 🔍 Code Intelligence
- **Explain**: Understand code structure, execution flows, and dependencies
- **Impact Analysis**: Assess the blast radius of code changes before making them
- **Debug**: Get guided debugging workflows and root-cause analysis
- **Refactor**: Implement refactoring changes with guidance and validation

### 📊 Context-Aware Analyze
- Automatically respects your active repository or repository group context
- Run multi-repo analysis across entire groups with progress tracking
- Right-click analyze on individual repositories

### 🗂️ Repository Management
- Create and manage repository groups for multi-repo workflows
- Switch between active repositories and groups
- Quick actions for common tasks

### 🤖 AI Chat Participant
- Interact with the `@CodeBrain` chat participant in GitHub Copilot Chat
- Get code explanations, impact analysis, debugging help, and refactoring guidance
- Automatic context injection based on your active repository/group
- Auto-generated `.github/skills/gitnexus-active-scope/SKILL.md` keeps Copilot and GitNexus MCP tools aligned to the active repo/group scope

### 🧭 Jira Plan + GitNexus Query (New)
- **What:** Build a reproducible implementation plan by combining Jira issue context (Atlassian) with GitNexus code intelligence.
- **How it works:** The extension fetches the Jira issue details (via Atlassian APIs or MCP), builds an analysis brief (objectives, hypotheses, unknowns), then runs GitNexus MCP tools (`list_repos`, `query`, `context`, `impact`, `detect_changes`) to map the code scope and risk. Finally it returns a structured Execution Plan and a draft Jira comment.
- **Usage:** Run the command **CodeBrain: Jira Plan + GitNexus Query** from the Command Palette, enter the Jira issue key (e.g. `PROJ-123`), and optionally add collaboration context. The chat participant will open with an evidence-driven plan in sections: Analysis Brief, GitNexus Findings, Execution Plan, Decision, Jira Comment Draft.
- **Why useful:** Streamlines the incident-to-fix flow by linking issue context directly to the code blast radius and producing an auditable plan for reviewers.

## Installation

### Option 1: From VS Code Marketplace
1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "CodeBrain"
4. Click "Install"

### Option 2: Install from .vsix File
1. Download the `codebrain-vscode.vsix` file
2. In VS Code, go to Extensions
3. Click the "..." menu → "Install from VSIX"
4. Select the downloaded file

### Prerequisites
- VS Code version 1.99.0 or later
- GitHub Copilot extension (for chat features)
- Node.js 18+ (for CLI operations)

## Quick Start

### 1. Initialize Your First Repository

1. Open a folder containing a Git repository in VS Code
2. Run the command: **CodeBrain: Setup**
   - This will automatically initialize the repository index
   - Creates the necessary configuration files

Or manually:
- Run **CodeBrain: Analyze Workspace** from the Command Palette

### 2. Access the Tree View

The CodeBrain sidebar shows:
- **Quick Actions**: Common tasks like analyzing your active context
- **Agents**: Available AI assistants
- **Groups & Repositories**: Your indexed repositories and groups

### 3. Use the Chat Participant

Type `@CodeBrain` in the GitHub Copilot Chat to start interacting:

```
@CodeBrain /explain src/utils/helpers.ts

Explain the execution flow of the parseConfig function and its dependencies.
```

Available slash commands:
- `/explain` - Understand code and explore execution flows
- `/impact` - Run impact analysis on a symbol
- `/debug` - Get debugging guidance and root-cause analysis
- `/refactor` - Implement refactoring changes
- `/plan` - Build a Jira-to-implementation plan with Atlassian + GitNexus MCP

## Core Workflows

### Understanding Code Structure

1. **Ask CodeBrain to explain code:**
   ```
   @CodeBrain /explain user authentication logic
   ```

2. **Explore execution flows:**
   - CodeBrain will identify relevant symbols
   - Show how functions call each other
   - Highlight external dependencies

### Analyzing Code Changes

1. **Before modifying critical code:**
   ```
   @CodeBrain /impact UserService.authenticate()
   ```

2. **Review the blast radius:**
   - Direct callers (d=1)
   - Risk level assessment
   - Affected execution flows

3. **Refactor safely:**
   - Follow the impact guidance
   - Let CodeBrain identify dependent code
   - Implement changes with confidence

### Debugging Issues

1. **Describe the problem:**
   ```
   @CodeBrain /debug Login flow fails sporadically with timeout errors
   ```

2. **CodeBrain will:**
   - Trace execution flows
   - Identify suspect symbols
   - Suggest minimal-risk fixes

### Refactoring Code

1. **Request refactoring:**
   ```
   @CodeBrain /refactor Extract UserValidator class from userService.ts
   ```

2. **CodeBrain will:**
   - Run impact analysis first
   - Show risk assessment
   - Implement changes directly
   - Summarize what was changed

## Repository Groups

### Create a Group

1. Run: **CodeBrain: Create Repository Group**
2. Enter a unique group name
3. Select repositories to include

### Analyze an Entire Group

1. Set the group as active: **CodeBrain: Select Group**
2. Click **Analyze Active Context** or run **CodeBrain: Analyze Workspace**
3. CodeBrain will analyze all repositories in the group sequentially
4. View progress in the output panel

### Add/Remove Repositories from Groups

- Right-click a repository in the tree
- Select "Add to Group" or "Remove from Group"
- Choose the target group

## Command Reference

### Analysis Commands
- **CodeBrain: Analyze Workspace** - Analyze active context (repo or group)
- **CodeBrain: Query Knowledge Graph** - Query code relationships
- **CodeBrain: Jira Plan + GitNexus Query** - Build plan from Jira context + GitNexus impact/query evidence
- **CodeBrain: PR Review** - Review pull requests with CodeBrain guidance

### Repository Management
- **CodeBrain: List Indexed Repos** - Show all indexed repositories
- **CodeBrain: Clean Index** - Clean current repository index
- **CodeBrain: Clean All Indexes** - Clean all repository indexes
- **CodeBrain: Select Repository** - Switch active repository
- **CodeBrain: Select Group** - Switch active group
- **CodeBrain: Show Active Context** - Display current active context
- **CodeBrain: Clear Active Context** - Clear context selection

### Group Management
- **CodeBrain: Create Repository Group** - Create a new repository group
- **CodeBrain: Sync Group** - Synchronize group with latest data
- **CodeBrain: Add Repository to Group** - Add repo to a group
- **CodeBrain: Remove Repository from Group** - Remove repo from a group

### Utilities
- **CodeBrain: Setup** - First-time setup and initialization
- **CodeBrain: Start Web UI Bridge Server** - Launch the web dashboard
- **CodeBrain: Generate Wiki** - Create documentation from analysis

## Configuration

### Settings (.vscode/settings.json)

```json
{
  "codebrain.defaultLanguageModel": "claude-haiku-4.5",
  "codebrain.enableAutoSetup": true,
  "codebrain.indexingMaxConcurrent": 4
}
```

### MCP Configuration (.vscode/mcp.json)

The extension automatically configures the Model Context Protocol server. No manual setup needed.

## Tree View Actions

### Right-Click Menu Options

**On Repository Items:**
- Analyze this repository
- Add to Group
- Remove from Group
- View repository details

**On Group Items:**
- Analyze entire group
- Sync group
- Edit group name
- Delete group

**On Group + Repository Items:**
- Analyze this repository within the group
- Remove from group

## Status Bar

The VS Code status bar shows:
- **Active Context** - Current repository or group context
- **Index Status** - Whether repositories are indexed and up-to-date
- **Last Analysis** - Timestamp of the last analysis

Click on the status to:
- View current context details
- Clear active context
- Quickly switch repositories

## Web UI Dashboard

Launch the web dashboard for visual analysis:

1. Run: **CodeBrain: Start Web UI Bridge Server**
2. Open the provided URL in your browser
3. Explore:
   - Code execution flows as diagrams
   - Dependency graphs
   - Analysis results
   - Repository metadata

## Troubleshooting

### Issue: "MCP server could not be started"

**Solution:**
- Ensure GitHub Copilot is signed in
- Check Node.js is installed (v18+)
- Restart VS Code
- Run **CodeBrain: Setup** again

### Issue: Index is out of date

**Solution:**
- Run **CodeBrain: Analyze Workspace** to re-index
- Or run **CodeBrain: Clean Index** then re-analyze

### Issue: Chat participant not responding

**Solution:**
- Verify GitHub Copilot is active
- Check that a language model is available
- Try a simpler query first
- Check the VS Code output panel for errors

### Issue: Group analysis shows no results

**Solution:**
- Run **CodeBrain: Sync Group** to refresh
- Verify repositories are indexed (run analyze on each)
- Check that Git repositories are properly configured

## Best Practices

### Before Making Code Changes
1. Use `/impact` to assess change scope
2. Review direct dependents and risk level
3. Use `/explain` to understand related code first

### For Large Refactorings
1. Start with smaller components
2. Use groups to analyze impact across repos
3. Get impact analysis on each change
4. Commit incrementally

### Debugging Strategy
1. Use `/explain` to understand normal flow
2. Use `/debug` to identify anomalies
3. Run impact analysis on suspect functions
4. Make minimal targeted fixes

### Code Review
1. Use `/impact` on pull request changes
2. Ask CodeBrain about new dependencies
3. Get refactoring suggestions for complex code
4. Verify no HIGH or CRITICAL risks

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Open Command Palette | Ctrl+Shift+P (Windows/Linux)<br/>Cmd+Shift+P (macOS) |
| Toggle Sidebar | Ctrl+B (Windows/Linux)<br/>Cmd+B (macOS) |
| Focus Chat | Ctrl+Alt+I (Windows/Linux)<br/>Cmd+Alt+I (macOS) |
| Quick Open | Ctrl+P (Windows/Linux)<br/>Cmd+P (macOS) |

## Data & Privacy

- **Local Indexing**: Repository indexes are stored locally on your machine
- **Chat Data**: Conversations with GitHub Copilot follow Copilot's privacy policy
- **No Telemetry**: CodeBrain does not collect data about your code
- **Open Source**: For full transparency, see the GitNexus project

## Getting Help

### Documentation
- [GitNexus Knowledge Graph Guide](./GitNexus/README.md)
- [Architecture Overview](./GitNexus/ARCHITECTURE.md)

### Support
- GitHub Issues: Report bugs and request features
- Discussions: Ask questions and share feedback

## Contributing

Want to improve CodeBrain? Contributions are welcome!

See [CONTRIBUTING.md](./GitNexus/CONTRIBUTING.md) for guidelines.

## License

CodeBrain VS Code Extension is licensed under the MIT License.
See [LICENSE](./LICENSE) for details.

---

**Happy coding with CodeBrain! 🚀**

Need help? Use `@CodeBrain` in GitHub Copilot Chat!
