import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from '../process/cli-runner.js';
import { listIndexedRepos, listGroups, listGroupsInWorkspace, getActiveContext, type ContextType } from '../process/group-context.js';

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

type NodeKind = 'action' | 'agent' | 'skill' | 'message' | 'repo' | 'group' | 'repo-in-group' | 'context';

class TreeNode extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly kind: NodeKind,
    public meta?: Record<string, string>,
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
      repo: new vscode.ThemeIcon('repo'),
      group: new vscode.ThemeIcon('server'),
      'repo-in-group': new vscode.ThemeIcon('repo-forked'),
      context: new vscode.ThemeIcon('target'),
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
      { label: 'Setup CodeBrain (MCP + Agents)', description: 'Install/check CLI + configure MCP and agents', command: 'codebrain.setup' },
      { label: 'Analyze Active Context', description: 'Index active repo/group (or workspace default)', command: 'codebrain.analyze' },
      { label: 'Force Re-index', description: 'Full rebuild of index', command: 'codebrain.analyzeForce' },
      { label: 'Show Index Status', description: 'Check index freshness', command: 'codebrain.status' },
      { label: 'List Indexed Repos', description: 'Show registered repos', command: 'codebrain.listRepos' },
      { label: 'Open Graph Dashboard', description: 'Open dependency graph dashboard in VS Code', command: 'codebrain.openDashboard' },
      { label: 'PR Review', description: 'Run PR impact analysis', command: 'codebrain.prReview' },
      { label: 'Add Repo to Group', description: 'Add a repository to an existing group', command: 'codebrain.addRepoToGroup' },
      { label: 'Remove Repo from Group', description: 'Remove a repository from a group', command: 'codebrain.removeRepoFromGroup' },
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

// ---------------------------------------------------------------------------
// Groups & Repos Tree
// ---------------------------------------------------------------------------

export class GroupsReposTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private storage: vscode.Memento) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      // Root: show context info, repos, and groups
      return this._getRootNodes();
    }

    // If it's a group node, show repos in that group
    if (element.kind === 'group' && element.meta?.name) {
      return this._getGroupRepoNodes(element.meta.name);
    }

    return [];
  }

  private async _getRootNodes(): Promise<TreeNode[]> {
    const nodes: TreeNode[] = [];

    // Show active context
    const activeContext = getActiveContext(this.storage);
    if (activeContext) {
      const contextNode = new TreeNode(
        `Active: ${activeContext.name} (${activeContext.type})`,
        'context',
      );
      contextNode.tooltip = `Currently active ${activeContext.type}. Click to change.`;
      contextNode.command = { command: 'codebrain.showContext', title: 'Show Active Context' };
      nodes.push(contextNode);
    }

    // Add quick actions
    nodes.push(new TreeNode('Select Repository', 'action'));
    const selectRepoNode = nodes[nodes.length - 1];
    selectRepoNode.command = { command: 'codebrain.selectRepo', title: 'Select Repository' };

    nodes.push(new TreeNode('Select Group', 'action'));
    const selectGroupNode = nodes[nodes.length - 1];
    selectGroupNode.command = { command: 'codebrain.selectGroup', title: 'Select Group' };

    nodes.push(new TreeNode('Create Group', 'action'));
    const createGroupNode = nodes[nodes.length - 1];
    createGroupNode.command = { command: 'codebrain.createGroup', title: 'Create Group' };

    // Separator
    nodes.push(new TreeNode('─ Repositories ─', 'message'));

    // Add repos
    const repos = await listIndexedRepos();
    for (const repo of repos) {
      const node = new TreeNode(repo.name, 'repo');
      node.description = repo.path;
      node.tooltip = `Repository: ${repo.name}\nPath: ${repo.path}`;
      node.meta = { name: repo.name, nodeType: 'repo' };
      node.contextValue = 'repo';
      node.command = { command: 'codebrain.selectRepo', title: 'Activate Repository', arguments: [repo.name] };
      nodes.push(node);
    }

    // Separator
    nodes.push(new TreeNode('─ Groups ─', 'message'));

    // Add groups (filtered to those with repos in this workspace)
    const groups = await listGroupsInWorkspace();
    for (const group of groups) {
      const repoCount = Object.keys(group.repos).length;
      const node = new TreeNode(`${group.name} (${repoCount})`, 'group', { name: group.name, nodeType: 'group' }, vscode.TreeItemCollapsibleState.Collapsed);
      node.tooltip = `Group: ${group.name}\nRepos: ${repoCount}`;
      node.meta = { name: group.name, nodeType: 'group' };
      node.contextValue = 'group';
      nodes.push(node);
    }

    if (groups.length === 0 && repos.length === 0) {
      nodes.push(new TreeNode('No repos or groups. Run "Analyze Repo" first.', 'message'));
    }

    return nodes;
  }

  private async _getGroupRepoNodes(groupName: string): Promise<TreeNode[]> {
    const groups = await listGroups();
    const group = groups.find((g) => g.name === groupName);

    if (!group) {
      return [];
    }

    const nodes: TreeNode[] = [];
    for (const [groupPath, registryName] of Object.entries(group.repos)) {
      const node = new TreeNode(`${groupPath} (${registryName})`, 'repo-in-group');
      node.description = registryName;
      node.tooltip = `Group path: ${groupPath}\nRegistry name: ${registryName}`;
      node.meta = {
        groupName,
        groupPath,
        registryName,
      };
      node.contextValue = 'repoInGroup';
      nodes.push(node);
    }

    return nodes;
  }
}
