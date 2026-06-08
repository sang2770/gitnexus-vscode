import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from '../process/cli-runner.js';

type NodeKind = 'action' | 'agent' | 'skill' | 'message';

class TreeNode extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly kind: NodeKind,
    collapsible = vscode.TreeItemCollapsibleState.None,
  ) {
    super(label, collapsible);
    this.iconPath = {
      action: new vscode.ThemeIcon('play'),
      agent: new vscode.ThemeIcon('robot'),
      skill: new vscode.ThemeIcon('book'),
      message: new vscode.ThemeIcon('info'),
    }[kind];
  }
}

export class QuickActionsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) {
      return [];
    }

    const actions: Array<{ label: string; description: string; command: string }> = [
      {
        label: 'Explain Current Flow',
        description: 'Compact graph context for the selected symbol or current file',
        command: 'codebrain.workflow.explain',
      },
      {
        label: 'Analyze Impact',
        description: 'Balanced blast-radius analysis for the current symbol',
        command: 'codebrain.workflow.impact',
      },
      {
        label: 'Review Changes',
        description: 'Review diffs with CodeGraph context and affected-test preflight',
        command: 'codebrain.workflow.review',
      },
      {
        label: 'Detect Change Impact',
        description: 'Map working tree changes to affected flows and risks',
        command: 'codebrain.workflow.detectChange',
      },
      {
        label: 'Generate Fix Plan',
        description: 'Create a Copilot Agent task grounded in graph evidence',
        command: 'codebrain.workflow.fixPlan',
      },
      {
        label: 'Generate Test Plan',
        description: 'Plan focused regression coverage for the current target',
        command: 'codebrain.workflow.test',
      },
      {
        label: 'Explain Architecture',
        description: 'Full-mode repository architecture and module relationship workflow',
        command: 'codebrain.workflow.architecture',
      },
      {
        label: 'Token Optimization Mode',
        description: 'Choose auto, compact, balanced, full, or off',
        command: 'codebrain.tokenOptimization.selectMode',
      },
      {
        label: 'Setup CodeBrain Runtime',
        description: 'Prepare CodeGraph runtime and local Copilot agent',
        command: 'codebrain.setup',
      },
      {
        label: 'Create CodeBrain Copilot Agent',
        description: 'Create .github/agents/codebrain.agent.md for VS Code Copilot',
        command: 'codebrain.createCopilotAgent',
      },
      {
        label: 'Analyze Workspace',
        description: 'Initialize or sync the CodeGraph index',
        command: 'codebrain.analyze',
      },
      {
        label: 'Force Re-index',
        description: 'Full rebuild of the CodeGraph index',
        command: 'codebrain.analyzeForce',
      },
      {
        label: 'Show Index Status',
        description: 'Check CodeGraph index freshness',
        command: 'codebrain.status',
      },
      {
        label: 'Query CodeGraph',
        description: 'Search symbols in the CodeGraph index',
        command: 'codebrain.query',
      },
      {
        label: 'Review Code with CodeBrain',
        description: 'Review selection, current file, staged changes, or branch diff',
        command: 'codebrain.prReview',
      },
      {
        label: 'Clean Index',
        description: 'Remove the local .codegraph index',
        command: 'codebrain.clean',
      },
    ];

    return actions.map((action) => {
      const node = new TreeNode(action.label, 'action');
      node.description = action.description;
      node.tooltip = action.description;
      node.command = { command: action.command, title: action.label };
      return node;
    });
  }
}

export class AgentsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) {
      return [];
    }
    return [...this._getAgentNodes(), ...this._getSkillNodes()];
  }

  private _getAgentNodes(): TreeNode[] {
    const agentsDir = path.join(getWorkspaceRoot(), '.github', 'agents');

    if (!fs.existsSync(agentsDir)) {
      return [new TreeNode('No custom agent files in .github/agents', 'message')];
    }

    return fs
      .readdirSync(agentsDir)
      .filter((file) => file.endsWith('.agent.md'))
      .map((file) => {
        const node = new TreeNode(file.replace('.agent.md', ''), 'agent');
        node.description = '.github/agents/';
        node.tooltip = path.join(agentsDir, file);
        node.command = {
          command: 'vscode.open',
          title: 'Open agent file',
          arguments: [vscode.Uri.file(path.join(agentsDir, file))],
        };
        return node;
      });
  }

  private _getSkillNodes(): TreeNode[] {
    const skillsDir = path.join(getWorkspaceRoot(), '.github', 'skills');

    if (!fs.existsSync(skillsDir)) {
      return [];
    }

    return fs
      .readdirSync(skillsDir)
      .filter((folder) => fs.existsSync(path.join(skillsDir, folder, 'SKILL.md')))
      .map((folder) => {
        const node = new TreeNode(folder, 'skill');
        node.description = '.github/skills/';
        node.tooltip = path.join(skillsDir, folder, 'SKILL.md');
        node.command = {
          command: 'vscode.open',
          title: 'Open skill file',
          arguments: [vscode.Uri.file(path.join(skillsDir, folder, 'SKILL.md'))],
        };
        return node;
      });
  }
}
