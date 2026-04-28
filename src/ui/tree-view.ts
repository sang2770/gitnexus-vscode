import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from '../process/cli-runner.js';

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

type NodeKind = 'action' | 'agent' | 'skill' | 'message';

class TreeNode extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly kind: NodeKind,
    public readonly meta?: Record<string, string>,
    collapsible = vscode.TreeItemCollapsibleState.None,
  ) {
    super(label, collapsible);
    this._applyIcon();
  }

  private _applyIcon(): void {
    const icons: Record<NodeKind, vscode.ThemeIcon> = {
      action: new vscode.ThemeIcon('play'),
      agent: new vscode.ThemeIcon('robot'),
      skill: new vscode.ThemeIcon('book'),
      message: new vscode.ThemeIcon('info'),
    };
    this.iconPath = icons[this.kind];
  }
}

// ---------------------------------------------------------------------------
// Quick Actions Tree
// ---------------------------------------------------------------------------

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
      { label: 'Setup GitNexus (MCP + Agents)', description: 'Install/check CLI + configure MCP and agents', command: 'gitnexus.setup' },
      { label: 'Analyze Repo', description: 'Index repository with default options', command: 'gitnexus.analyze' },
      { label: 'Force Re-index', description: 'Full rebuild of index', command: 'gitnexus.analyzeForce' },
      { label: 'Analyze with Embeddings', description: 'Enable semantic vectors', command: 'gitnexus.analyzeEmbeddings' },
      { label: 'Show Index Status', description: 'Check index freshness', command: 'gitnexus.status' },
      { label: 'List Indexed Repos', description: 'Show registered repos', command: 'gitnexus.listRepos' },
      { label: 'Open Graph Dashboard', description: 'Open dependency graph dashboard in VS Code', command: 'gitnexus.openDashboard' },
      { label: 'PR Review', description: 'Run PR impact analysis', command: 'gitnexus.prReview' },
      { label: 'Start Bridge Server', description: 'Run gitnexus serve', command: 'gitnexus.serve' },
      { label: 'Query Knowledge Graph', description: 'Run quick graph query', command: 'gitnexus.query' },
    ];

    return actions.map((a) => {
      const node = new TreeNode(a.label, 'action');
      node.description = a.description;
      node.tooltip = a.description;
      node.command = { command: a.command, title: a.label };
      return node;
    });
  }
}

// ---------------------------------------------------------------------------
// Agents Tree
// ---------------------------------------------------------------------------

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
    const workspaceRoot = getWorkspaceRoot();
    const agentsDir = path.join(workspaceRoot, '.github', 'agents');

    if (!fs.existsSync(agentsDir)) {
      const msg = new TreeNode('No custom agent files in .github/agents', 'message');
      return [msg];
    }

    return fs
      .readdirSync(agentsDir)
      .filter((f) => f.endsWith('.agent.md'))
      .map((f) => {
        const node = new TreeNode(f.replace('.agent.md', ''), 'agent');
        node.description = '.github/agents/';
        node.tooltip = path.join(agentsDir, f);
        node.command = {
          command: 'vscode.open',
          title: 'Open agent file',
          arguments: [vscode.Uri.file(path.join(agentsDir, f))],
        };
        return node;
      });
  }

  private _getSkillNodes(): TreeNode[] {
    const workspaceRoot = getWorkspaceRoot();
    const skillsDir = path.join(workspaceRoot, '.github', 'skills');

    if (!fs.existsSync(skillsDir)) {
      return [];
    }

    return fs
      .readdirSync(skillsDir)
      .filter((f) => {
        const skillMd = path.join(skillsDir, f, 'SKILL.md');
        return fs.existsSync(skillMd);
      })
      .map((f) => {
        const node = new TreeNode(f, 'skill');
        node.description = '.github/skills/';
        node.tooltip = path.join(skillsDir, f, 'SKILL.md');
        node.command = {
          command: 'vscode.open',
          title: 'Open skill file',
          arguments: [vscode.Uri.file(path.join(skillsDir, f, 'SKILL.md'))],
        };
        return node;
      });
  }
}
