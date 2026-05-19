// SPDX-License-Identifier: Apache-2.0
import * as path from "node:path";
import * as vscode from "vscode";
import {
  AcpMcpServerConfiguration,
  ImportedConfigSource,
  currentWorkspaceRoot,
  extractReadableErrorMessage,
} from "./types";

type RawEditorMcpConfiguration = {
  readonly servers?: unknown;
};

export type RawMcpServerConfiguration = {
  readonly type?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env?: unknown;
  readonly url?: unknown;
  readonly headers?: unknown;
};

const WORKSPACE_MCP_CONFIG_PATH = [".vscode", "mcp.json"];
const PROFILE_MCP_CONFIG_FILE = "mcp.json";

export async function loadWorkspaceMcpServers(
  logger: vscode.LogOutputChannel,
): Promise<readonly AcpMcpServerConfiguration[]> {
  const workspaceRoot = currentWorkspaceRoot();
  if (!workspaceRoot) {
    return [];
  }

  const configUri = vscode.Uri.joinPath(
    workspaceRoot,
    ...WORKSPACE_MCP_CONFIG_PATH,
  );
  return await loadEditorMcpServers(configUri, logger, {
    kind: "workspace",
    label: "workspace .vscode/mcp.json",
    path: configUri.fsPath,
  });
}

export async function loadUserProfileMcpServers(
  profileStorageUri: vscode.Uri | undefined,
  logger: vscode.LogOutputChannel,
): Promise<readonly AcpMcpServerConfiguration[]> {
  const profileUri = getCurrentProfileUri(profileStorageUri);
  if (!profileUri) {
    return [];
  }

  const configUri = vscode.Uri.joinPath(profileUri, PROFILE_MCP_CONFIG_FILE);
  return await loadEditorMcpServers(configUri, logger, {
    kind: "userProfile",
    label: "current VS Code profile mcp.json",
    path: configUri.fsPath,
  });
}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toStringArray(
  value: unknown,
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function toStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (!entries.length) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

async function loadEditorMcpServers(
  configUri: vscode.Uri,
  logger: vscode.LogOutputChannel,
  source: ImportedConfigSource,
): Promise<readonly AcpMcpServerConfiguration[]> {
  const logPrefix = source.kind === "workspace" ? "workspace-mcp" : "profile-mcp";
  if (!(await fileExists(configUri))) {
    return [];
  }

  try {
    const contents = await vscode.workspace.fs.readFile(configUri);
    const parsed = JSON.parse(new TextDecoder().decode(contents)) as unknown;
    const servers = parseEditorMcpServers(parsed, source);
    if (servers.length) {
      logger.debug(
        `[${logPrefix}] Imported ${servers.length} server(s) from ${configUri.fsPath}`,
      );
    }
    return servers;
  } catch (error) {
    logger.warn(
      `[${logPrefix}] Failed to load ${configUri.fsPath}: ${extractReadableErrorMessage(error)}`,
    );
    return [];
  }
}

function parseEditorMcpServers(
  value: unknown,
  source: ImportedConfigSource,
): readonly AcpMcpServerConfiguration[] {
  if (!isRecord(value)) {
    return [];
  }

  const config = value as RawEditorMcpConfiguration;
  if (!isRecord(config.servers)) {
    return [];
  }

  const servers: AcpMcpServerConfiguration[] = [];
  for (const [name, rawServer] of Object.entries(config.servers)) {
    const server = parseEditorMcpServer(name, rawServer, source);
    if (server) {
      servers.push(server);
    }
  }

  return servers;
}

function parseEditorMcpServer(
  name: string,
  value: unknown,
  source: ImportedConfigSource,
): AcpMcpServerConfiguration | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const config = value as RawMcpServerConfiguration;
  const type = config.type;

  if (type === "http") {
    if (typeof config.url !== "string") {
      return undefined;
    }

    return {
      type: "http",
      name,
      url: config.url,
      headers: toStringRecord(config.headers),
      source,
    };
  }

  if (type === undefined || type === "stdio") {
    if (typeof config.command !== "string") {
      return undefined;
    }

    return {
      type: "stdio",
      name,
      command: config.command,
      args: toStringArray(config.args),
      env: toStringRecord(config.env),
      source,
    };
  }

  return undefined;
}

function getCurrentProfileUri(
  profileStorageUri: vscode.Uri | undefined,
): vscode.Uri | undefined {
  if (!profileStorageUri || profileStorageUri.scheme !== "file") {
    return undefined;
  }

  const profilePath = path.dirname(path.dirname(profileStorageUri.fsPath));
  if (!profilePath) {
    return undefined;
  }

  return vscode.Uri.file(profilePath);
}