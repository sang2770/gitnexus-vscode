import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import os from 'os';

const GITNEXUS_DIR = path.join(os.homedir(), '.gitnexus');

export type ContextType = 'repo' | 'group';

export interface RepoInfo {
  name: string;
  path: string;
}

interface ListIndexedReposOptions {
  includeOutsideWorkspace?: boolean;
}

export interface GroupInfo {
  name: string;
  repos: Record<string, string>; // groupPath -> registryName
}

export interface ActiveContext {
  type: ContextType;
  name: string; // repo name or group name
  timestamp: number;
}

interface EnsureWorkspaceActiveContextOptions {
  autoSelectSingle?: boolean;
}

const STORAGE_KEY = 'codebrain.activeContext';

function normalizeFsPath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrUnderPath(basePath: string, targetPath: string): boolean {
  const normalizedBase = normalizeFsPath(basePath);
  const normalizedTarget = normalizeFsPath(targetPath);
  const prefix = `${normalizedBase}${path.sep}`;
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(prefix);
}

function belongsToWorkspace(repoPath: string, workspaceRoots: string[]): boolean {
  if (!repoPath || workspaceRoots.length === 0) {
    return true;
  }

  return workspaceRoots.some((workspaceRoot) => {
    // Include repo when it is inside the workspace folder,
    // or when workspace is opened at a repo subfolder.
    return isSameOrUnderPath(workspaceRoot, repoPath) || isSameOrUnderPath(repoPath, workspaceRoot);
  });
}

/**
 * Get all indexed repositories from registry
 */
export async function listIndexedRepos(options: ListIndexedReposOptions = {}): Promise<RepoInfo[]> {
  try {
    const registryPath = path.join(GITNEXUS_DIR, 'registry.json');
    if (!fs.existsSync(registryPath)) {
      return [];
    }

    const content = fs.readFileSync(registryPath, 'utf-8');
    const registry = JSON.parse(content) as unknown;

    // Support both legacy object-map registry and current array-based registry.
    const rows: Array<{ name: string; path: string }> = [];

    if (Array.isArray(registry)) {
      for (const item of registry) {
        if (typeof item !== 'object' || item === null) {
          continue;
        }
        const entry = item as Record<string, unknown>;
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        const repoPath = typeof entry.path === 'string' ? entry.path : '';
        if (name) {
          rows.push({ name, path: repoPath });
        }
      }
      if (options.includeOutsideWorkspace) {
        return rows;
      }

      const workspaceRoots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
      return rows.filter((repo) => belongsToWorkspace(repo.path, workspaceRoots));
    }

    if (typeof registry === 'object' && registry !== null) {
      for (const [name, entry] of Object.entries(registry)) {
        if (typeof entry !== 'object' || entry === null) {
          continue;
        }
        const entryObj = entry as Record<string, unknown>;
        const repoPath = typeof entryObj.path === 'string' ? entryObj.path : '';
        rows.push({
          name,
          path: repoPath,
        });
      }
    }

    if (options.includeOutsideWorkspace) {
      return rows;
    }

    const workspaceRoots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    return rows.filter((repo) => belongsToWorkspace(repo.path, workspaceRoots));
  } catch (error) {
    console.error('Error loading repos:', error);
    return [];
  }
}

function isGroupInWorkspace(group: GroupInfo, workspaceRepos: RepoInfo[]): boolean {
  for (const registryName of Object.values(group.repos)) {
    const normalized = registryName.trim().toLowerCase();
    if (workspaceRepos.some((r) => r.name.trim().toLowerCase() === normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * List groups that have at least one repo belonging to the current workspace.
 */
export async function listGroupsInWorkspace(): Promise<GroupInfo[]> {
  const [allGroups, workspaceRepos] = await Promise.all([listGroups(), listIndexedRepos()]);
  return allGroups.filter((g) => isGroupInWorkspace(g, workspaceRepos));
}

/**
 * List all groups
 */
export async function listGroups(): Promise<GroupInfo[]> {
  try {
    const groupsDir = path.join(GITNEXUS_DIR, 'groups');
    if (!fs.existsSync(groupsDir)) {
      return [];
    }

    const groups: GroupInfo[] = [];
    const entries = fs.readdirSync(groupsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const groupYamlPath = path.join(groupsDir, entry.name, 'group.yaml');
        if (fs.existsSync(groupYamlPath)) {
          const details = await getGroupDetails(entry.name);
          if (details) {
            groups.push(details);
          }
        }
      }
    }

    return groups;
  } catch (error) {
    console.error('Error loading groups:', error);
    return [];
  }
}

/**
 * Get active context from extension storage
 */
export function getActiveContext(storage: vscode.Memento): ActiveContext | undefined {
  const stored = storage.get<ActiveContext>(STORAGE_KEY);
  if (stored && Date.now() - stored.timestamp < 24 * 60 * 60 * 1000) {
    // Valid if less than 24 hours old
    return stored;
  }
  return undefined;
}

function hasMatchingName(
  activeName: string,
  items: Array<{ name: string }>,
): boolean {
  const normalizedActive = activeName.trim().toLowerCase();
  return items.some((item) => item.name.trim().toLowerCase() === normalizedActive);
}

/**
 * Set active context in extension storage
 */
export async function setActiveContext(
  storage: vscode.Memento,
  type: ContextType,
  name: string,
): Promise<void> {
  const context: ActiveContext = {
    type,
    name,
    timestamp: Date.now(),
  };
  await storage.update(STORAGE_KEY, context);
}

/**
 * Clear active context
 */
export async function clearActiveContext(storage: vscode.Memento): Promise<void> {
  await storage.update(STORAGE_KEY, undefined);
}

/**
 * Return active context only when it still belongs to current workspace.
 * If active context is stale (repo/group missing from workspace), clear it.
 */
export async function ensureWorkspaceActiveContext(
  storage: vscode.Memento,
  options: EnsureWorkspaceActiveContextOptions = {},
): Promise<ActiveContext | undefined> {
  const active = getActiveContext(storage);
  if (!active) {
    if (!options.autoSelectSingle) {
      return undefined;
    }

    const [repos, groups] = await Promise.all([listIndexedRepos(), listGroupsInWorkspace()]);

    // Auto-select only when the workspace has a single unambiguous candidate.
    if (repos.length === 1 && groups.length === 0) {
      await setActiveContext(storage, 'repo', repos[0].name);
      return getActiveContext(storage);
    }

    if (groups.length === 1 && repos.length === 0) {
      await setActiveContext(storage, 'group', groups[0].name);
      return getActiveContext(storage);
    }

    return undefined;
  }

  if (active.type === 'repo') {
    const repos = await listIndexedRepos();
    if (hasMatchingName(active.name, repos)) {
      return active;
    }
    await clearActiveContext(storage);
    return undefined;
  }

  const groups = await listGroupsInWorkspace();
  if (hasMatchingName(active.name, groups)) {
    return active;
  }

  await clearActiveContext(storage);

  if (!options.autoSelectSingle) {
    return undefined;
  }

  const repos = await listIndexedRepos();
  if (repos.length === 1 && groups.length === 0) {
    await setActiveContext(storage, 'repo', repos[0].name);
    return getActiveContext(storage);
  }

  if (groups.length === 1 && repos.length === 0) {
    await setActiveContext(storage, 'group', groups[0].name);
    return getActiveContext(storage);
  }

  return undefined;
}

/**
 * Resolve filesystem path for currently active repo context.
 * Returns undefined when active context is not a repo or cannot be mapped.
 */
export async function getActiveRepoPath(storage: vscode.Memento): Promise<string | undefined> {
  const active = getActiveContext(storage);
  if (!active || active.type !== 'repo') {
    return undefined;
  }

  const repos = await listIndexedRepos();
  const matched = repos.find((repo) => repo.name === active.name);
  return matched?.path;
}

/**
 * Get group details by name (with repos)
 */
export async function getGroupDetails(groupName: string): Promise<GroupInfo | null> {
  try {
    const groupsDir = path.join(GITNEXUS_DIR, 'groups', groupName);
    const groupYamlPath = path.join(groupsDir, 'group.yaml');

    if (!fs.existsSync(groupYamlPath)) {
      return null;
    }

    // Try to parse group.yaml using js-yaml equivalent logic
    const content = fs.readFileSync(groupYamlPath, 'utf-8');
    
    // Simple YAML parser for group.yaml
    const repos: Record<string, string> = {};
    const lines = content.split('\n');
    let inReposSection = false;

    for (const line of lines) {
      if (line.trim().startsWith('repos:')) {
        inReposSection = true;
        continue;
      }

      if (inReposSection && line.startsWith('  ') && line.includes(':')) {
        const [path, name] = line.trim().split(':').map(s => s.trim());
        if (path && name) {
          repos[path] = name;
        }
      } else if (inReposSection && !line.startsWith('  ') && line.trim()) {
        inReposSection = false;
      }
    }

    return {
      name: groupName,
      repos,
    };
  } catch (error) {
    console.error(`Error loading group details for ${groupName}:`, error);
    return null;
  }
}
