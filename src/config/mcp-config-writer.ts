import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveMcpEntry } from '../process/cli-runner.js';

interface McpServerEntry {
  command: string;
  args: string[];
}

interface McpConfig {
  servers?: Record<string, McpServerEntry>;
  // Backward compatibility for older generated config
  mcpServers?: Record<string, McpServerEntry>;
}

/** Build the MCP entry in the requested cross-platform npx format. */
function buildMcpEntry(workspaceRoot: string): McpServerEntry {
  const entry = resolveMcpEntry(workspaceRoot);
  return { command: entry.command, args: entry.args };
}

export function isMcpConfigured(workspaceRoot: string): boolean {
  const mcpPath = path.join(workspaceRoot, '.vscode', 'mcp.json');
  if (!fs.existsSync(mcpPath)) {
    return false;
  }

  try {
    const cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as McpConfig;
    const server = cfg.servers?.gitnexus ?? cfg.mcpServers?.gitnexus;
    if (!server) {
      return false;
    }
    const expected = buildMcpEntry(workspaceRoot);
    return (
      server.command === expected.command &&
      JSON.stringify(server.args) === JSON.stringify(expected.args)
    );
  } catch {
    return false;
  }
}

export function hasGitNexusMcpServer(workspaceRoot: string): boolean {
  const mcpPath = path.join(workspaceRoot, '.vscode', 'mcp.json');
  if (!fs.existsSync(mcpPath)) {
    return false;
  }

  try {
    const cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as McpConfig;
    return Boolean(cfg.servers?.gitnexus ?? cfg.mcpServers?.gitnexus);
  } catch {
    return false;
  }
}

/**
 * Write (or merge) gitnexus MCP server config into .vscode/mcp.json.
 * Preserves existing server entries.
 */
export async function writeMcpConfig(workspaceRoot: string): Promise<void> {
  const vscodeDir = path.join(workspaceRoot, '.vscode');
  const mcpPath = path.join(vscodeDir, 'mcp.json');

  // Read existing or start fresh
  let config: McpConfig = {};
  if (fs.existsSync(mcpPath)) {
    try {
      config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as McpConfig;
    } catch {
      // Corrupt JSON — back up and start fresh
      fs.copyFileSync(mcpPath, mcpPath + '.bak');
      config = {};
    }
  }

  if (!config.servers) {
    config.servers = {};
  }

  const existing = config.servers['gitnexus'];
  const entry = buildMcpEntry(workspaceRoot);

  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
    return; // Already up to date
  }

  config.servers['gitnexus'] = entry;

  // Normalize old key if present
  if (config.mcpServers) {
    delete config.mcpServers;
  }

  if (!fs.existsSync(vscodeDir)) {
    fs.mkdirSync(vscodeDir, { recursive: true });
  }

  fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Show user what was written and offer to open the file */
export async function writeMcpConfigWithFeedback(workspaceRoot: string): Promise<void> {
  await writeMcpConfig(workspaceRoot);
  const mcpPath = path.join(workspaceRoot, '.vscode', 'mcp.json');
  const choice = await vscode.window.showInformationMessage(
    'GitNexus MCP server configured in .vscode/mcp.json. Restart MCP to apply.',
    'Open File',
    'Dismiss',
  );
  if (choice === 'Open File') {
    vscode.window.showTextDocument(vscode.Uri.file(mcpPath));
  }
}
