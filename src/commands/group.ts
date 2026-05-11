import * as vscode from 'vscode';
import { ensureCodeBrainCli } from '../process/prerequisites.js';
import { runCodeBrain, getOutputChannel } from '../process/cli-runner.js';
import {
  listIndexedRepos,
  listGroups,
  setActiveContext,
  getActiveContext,
  clearActiveContext,
  getGroupDetails,
} from '../process/group-context.js';

interface TreeCommandNode {
  meta?: Record<string, string>;
}

function resolveNameFromArg(arg?: string | TreeCommandNode): string | undefined {
  if (!arg) {
    return undefined;
  }
  if (typeof arg === 'string') {
    const value = arg.trim();
    return value.length > 0 ? value : undefined;
  }
  const value = arg.meta?.name?.trim();
  return value && value.length > 0 ? value : undefined;
}

export async function selectRepoCommand(
  context: vscode.ExtensionContext,
  arg?: string | TreeCommandNode,
): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const directRepoName = resolveNameFromArg(arg);
  if (directRepoName) {
    await setActiveContext(context.globalState, 'repo', directRepoName);
    vscode.window.showInformationMessage(`Activated repository: ${directRepoName}`);
    await vscode.commands.executeCommand('codebrain.refreshTreeView');
    return;
  }

  const repos = await listIndexedRepos();
  if (repos.length === 0) {
    vscode.window.showWarningMessage('No indexed repositories found. Run "Analyze Repo" first.');
    return;
  }

  const items = repos.map((r) => ({
    label: r.name,
    description: r.path,
    repo: r,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Select Repository',
    placeHolder: 'Choose a repository to activate',
  });

  if (selected) {
    await setActiveContext(context.globalState, 'repo', selected.repo.name);
    vscode.window.showInformationMessage(`Activated repository: ${selected.repo.name}`);
    await vscode.commands.executeCommand('codebrain.refreshTreeView');
  }
}

export async function selectGroupCommand(
  context: vscode.ExtensionContext,
  arg?: string | TreeCommandNode,
): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const directGroupName = resolveNameFromArg(arg);
  if (directGroupName) {
    await setActiveContext(context.globalState, 'group', directGroupName);
    vscode.window.showInformationMessage(`Activated group: ${directGroupName}`);
    await vscode.commands.executeCommand('codebrain.refreshTreeView');
    return;
  }

  const groups = await listGroups();
  if (groups.length === 0) {
    vscode.window.showWarningMessage('No groups configured. Create one with: gitnexus group create <name>');
    return;
  }

  const items = groups.map((g) => ({
    label: g.name,
    description: `${Object.keys(g.repos).length} repos`,
    group: g,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Select Group',
    placeHolder: 'Choose a group to activate',
  });

  if (selected) {
    await setActiveContext(context.globalState, 'group', selected.group.name);
    vscode.window.showInformationMessage(`Activated group: ${selected.group.name}`);
    await vscode.commands.executeCommand('codebrain.refreshTreeView');
  }
}

export async function clearActivationCommand(context: vscode.ExtensionContext): Promise<void> {
  await clearActiveContext(context.globalState);
  vscode.window.showInformationMessage('Cleared active context. Will use workspace default.');
  await vscode.commands.executeCommand('codebrain.refreshTreeView');
}

export async function createGroupCommand(): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const groupName = await vscode.window.showInputBox({
    title: 'Create New Group',
    placeHolder: 'Enter group name',
    validateInput: (value) => {
      if (!value.trim()) {
        return 'Group name cannot be empty';
      }
      if (!/^[a-z0-9_-]+$/.test(value)) {
        return 'Group name must contain only lowercase letters, numbers, hyphens, and underscores';
      }
      return undefined;
    },
  });

  if (!groupName) {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Creating group: ${groupName}...`, cancellable: false },
    async () => {
      const result = await runCodeBrain(['group', 'create', groupName]);
      if (result.exitCode === 0) {
        vscode.window.showInformationMessage(`Group created: ${groupName}`);
        await vscode.commands.executeCommand('codebrain.refreshTreeView');
      } else {
        vscode.window.showErrorMessage(`Failed to create group. Check Output panel.`);
      }
    },
  );
}

export async function syncGroupCommand(): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const groups = await listGroups();
  if (groups.length === 0) {
    vscode.window.showWarningMessage('No groups configured. Create one first.');
    return;
  }

  const items = groups.map((g) => ({
    label: g.name,
    description: `${Object.keys(g.repos).length} repos`,
    group: g,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Sync Group',
    placeHolder: 'Choose a group to synchronize',
  });

  if (!selected) {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Syncing group: ${selected.group.name}...`, cancellable: false },
    async () => {
      const result = await runCodeBrain(['group', 'sync', selected.group.name]);
      if (result.exitCode === 0) {
        vscode.window.showInformationMessage(`Group synced: ${selected.group.name}`);
      } else {
        vscode.window.showErrorMessage(`Failed to sync group. Check Output panel.`);
      }
    },
  );
}

export async function showActiveContextCommand(context: vscode.ExtensionContext): Promise<void> {
  const active = getActiveContext(context.globalState);

  if (!active) {
    vscode.window.showInformationMessage('No active context. Using workspace default.');
    return;
  }

  const typeLabel = active.type === 'repo' ? 'Repository' : 'Group';
  vscode.window.showInformationMessage(`Active ${typeLabel}: ${active.name}`);
}

export async function repoMenuCommand(
  context: vscode.ExtensionContext,
  arg?: string | TreeCommandNode,
): Promise<void> {
  const repoName = resolveNameFromArg(arg);
  if (!repoName) {
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(check) Activate', description: repoName, action: 'activate' },
      { label: '$(add) Add to Group', description: repoName, action: 'addToGroup' },
    ],
    { title: `Repository: ${repoName}`, placeHolder: 'Choose an action' },
  );

  if (!picked) {
    return;
  }

  if (picked.action === 'activate') {
    await setActiveContext(context.globalState, 'repo', repoName);
    vscode.window.showInformationMessage(`Activated repository: ${repoName}`);
    await vscode.commands.executeCommand('codebrain.refreshTreeView');
  } else {
    await addRepoToGroupCommand({ meta: { name: repoName } });
  }
}

export async function addRepoToGroupCommand(node?: TreeCommandNode): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  let repoName = node?.meta?.name;
  if (!repoName) {
    const repos = await listIndexedRepos();
    if (repos.length === 0) {
      vscode.window.showWarningMessage('No indexed repositories found. Run "Analyze Repo" first.');
      return;
    }

    const repoItems = repos.map((r) => ({
      label: r.name,
      description: r.path,
      repo: r,
    }));

    const selectedRepo = await vscode.window.showQuickPick(repoItems, {
      title: 'Select Repository to Add',
      placeHolder: 'Choose a repository',
    });

    if (!selectedRepo) {
      return;
    }

    repoName = selectedRepo.repo.name;
  }

  const groups = await listGroups();
  if (groups.length === 0) {
    vscode.window.showWarningMessage('No groups found. Create one first with "Create Group".');
    return;
  }

  const groupItems = groups.map((g) => ({
    label: g.name,
    description: `${Object.keys(g.repos).length} repos`,
    group: g,
  }));

  const selectedGroup = await vscode.window.showQuickPick(groupItems, {
    title: 'Select Group',
    placeHolder: 'Choose a group to add repo to',
  });

  if (!selectedGroup) {
    return;
  }

  const groupPath = await vscode.window.showInputBox({
    title: 'Group Path',
    value: repoName,
    placeHolder: 'e.g., backend, frontend/api, services/auth',
    prompt: 'Enter hierarchy path for this repo in the group',
    validateInput: (value) => {
      if (!value.trim()) {
        return 'Path cannot be empty';
      }
      if (!/^[a-z0-9_/-]+$/.test(value)) {
        return 'Path must contain only lowercase letters, numbers, hyphens, slashes, and underscores';
      }
      return undefined;
    },
  });

  if (!groupPath) {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Adding ${repoName} to ${selectedGroup.group.name}...`,
      cancellable: false,
    },
    async () => {
      const result = await runCodeBrain(['group', 'add', selectedGroup.group.name, groupPath, repoName]);
      if (result.exitCode === 0) {
        vscode.window.showInformationMessage(`Added ${repoName} to group ${selectedGroup.group.name}`);
        await vscode.commands.executeCommand('codebrain.refreshTreeView');
      } else {
        vscode.window.showErrorMessage(`Failed to add repo to group. Check Output panel.`);
      }
    },
  );
}

export async function removeRepoFromGroupCommand(node?: TreeCommandNode): Promise<void> {
  const ok = await ensureCodeBrainCli();
  if (!ok) {
    return;
  }

  const quickGroupName = node?.meta?.groupName;
  const quickGroupPath = node?.meta?.groupPath;
  if (quickGroupName && quickGroupPath) {
    const confirmed = await vscode.window.showWarningMessage(
      `Remove "${quickGroupPath}" from group "${quickGroupName}"?`,
      { modal: true },
      'Remove',
      'Cancel',
    );

    if (confirmed !== 'Remove') {
      return;
    }

    const channel = getOutputChannel();
    channel.show(true);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Removing ${quickGroupPath} from ${quickGroupName}...`,
        cancellable: false,
      },
      async () => {
        const result = await runCodeBrain(['group', 'remove', quickGroupName, quickGroupPath]);
        if (result.exitCode === 0) {
          vscode.window.showInformationMessage(`Removed ${quickGroupPath} from group`);
          await vscode.commands.executeCommand('codebrain.refreshTreeView');
        } else {
          vscode.window.showErrorMessage(`Failed to remove repo from group. Check Output panel.`);
        }
      },
    );

    return;
  }

  const groups = await listGroups();
  if (groups.length === 0) {
    vscode.window.showWarningMessage('No groups found.');
    return;
  }

  const groupItems = groups.map((g) => ({
    label: g.name,
    description: `${Object.keys(g.repos).length} repos`,
    group: g,
  }));

  const selectedGroup = await vscode.window.showQuickPick(groupItems, {
    title: 'Select Group',
    placeHolder: 'Choose a group',
  });

  if (!selectedGroup) {
    return;
  }

  const group = await getGroupDetails(selectedGroup.group.name);
  if (!group || Object.keys(group.repos).length === 0) {
    vscode.window.showWarningMessage('Group has no repositories.');
    return;
  }

  const repoItems = Object.entries(group.repos).map(([path, name]) => ({
    label: path,
    description: name,
    repoPath: path,
  }));

  const selectedRepo = await vscode.window.showQuickPick(repoItems, {
    title: 'Select Repo to Remove',
    placeHolder: 'Choose a repository to remove',
  });

  if (!selectedRepo) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Remove "${selectedRepo.repoPath}" from group "${selectedGroup.group.name}"?`,
    { modal: true },
    'Remove',
    'Cancel',
  );

  if (confirmed !== 'Remove') {
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Removing ${selectedRepo.repoPath} from ${selectedGroup.group.name}...`,
      cancellable: false,
    },
    async () => {
      const result = await runCodeBrain(['group', 'remove', selectedGroup.group.name, selectedRepo.repoPath]);
      if (result.exitCode === 0) {
        vscode.window.showInformationMessage(`Removed ${selectedRepo.repoPath} from group`);
        await vscode.commands.executeCommand('codebrain.refreshTreeView');
      } else {
        vscode.window.showErrorMessage(`Failed to remove repo from group. Check Output panel.`);
      }
    },
  );
}
