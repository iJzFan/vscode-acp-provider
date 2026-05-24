// SPDX-License-Identifier: Apache-2.0
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { currentWorkspaceRoot, extractReadableErrorMessage } from "./types";
import { fileExists, isRecord } from "./mcpConfigImporter";

type PluginSourceKind = "chatSetting" | "copilotCli" | "vscodeInstalled";
type PluginFormat = "copilot" | "claude" | "openplugin";

type PluginManifest = {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly skills?: unknown;
  readonly agents?: unknown;
  readonly hooks?: unknown;
  readonly mcpServers?: unknown;
};

type PluginManifestLocation = {
  readonly relativePath: string;
  readonly format: PluginFormat;
};

type PluginSearchRoot = {
  readonly uri: vscode.Uri;
  readonly sourceKind: PluginSourceKind;
  readonly sourceLabel: string;
  readonly maxDepth: number;
};

type WorkspacePluginHints = {
  readonly enabledPluginIds: readonly string[];
  readonly marketplaces: readonly string[];
  readonly sources: readonly string[];
};

export interface DiscoveredPlugin {
  readonly manifest: PluginManifest;
  readonly manifestUri: vscode.Uri;
  readonly rootUri: vscode.Uri;
  readonly format: PluginFormat;
  readonly sourceKind: PluginSourceKind;
  readonly sourceLabel: string;
  readonly unsupportedComponents: readonly string[];
}

const PLUGIN_MANIFEST_LOCATIONS: readonly PluginManifestLocation[] = [
  { relativePath: ".plugin/plugin.json", format: "openplugin" },
  { relativePath: "plugin.json", format: "copilot" },
  { relativePath: ".github/plugin/plugin.json", format: "copilot" },
  { relativePath: ".claude-plugin/plugin.json", format: "claude" },
];

const COPILOT_CLI_PLUGIN_PATH = [".copilot", "installed-plugins"];
const VSCODE_AGENT_PLUGIN_FOLDER = "agentPlugins";

export async function discoverPlugins(
  profileStorageUri: vscode.Uri | undefined,
  logger: vscode.LogOutputChannel,
): Promise<readonly DiscoveredPlugin[]> {
  const plugins: DiscoveredPlugin[] = [];
  const seenRoots = new Set<string>();

  for (const root of getPluginSearchRoots(profileStorageUri, logger)) {
    const discovered = await discoverPluginsUnderRoot(root, logger);
    for (const plugin of discovered) {
      const key = plugin.rootUri.fsPath.toLowerCase();
      if (seenRoots.has(key)) {
        continue;
      }

      seenRoots.add(key);
      plugins.push(plugin);
    }
  }

  const hints = await loadWorkspacePluginHints(logger);
  if (hints.enabledPluginIds.length) {
    const discoveredNames = new Set(
      plugins.map((plugin) => plugin.manifest.name),
    );
    const missing = hints.enabledPluginIds.filter(
      (pluginId) =>
        !discoveredNames.has(normalizeRecommendedPluginName(pluginId)),
    );
    if (missing.length) {
      logger.info(
        `[plugin-hints] Workspace recommends plugins that are not installed in discovered locations: ${missing.join(", ")}`,
      );
    }
  }

  return plugins;
}

function getPluginSearchRoots(
  profileStorageUri: vscode.Uri | undefined,
  logger: vscode.LogOutputChannel,
): readonly PluginSearchRoot[] {
  const roots: PluginSearchRoot[] = [];
  const pluginLocations = vscode.workspace
    .getConfiguration("chat")
    .get<Record<string, boolean>>("pluginLocations", {});

  for (const [location, enabled] of Object.entries(pluginLocations)) {
    if (!enabled) {
      logger.debug(
        `[plugin-discovery] Skipping disabled plugin location ${location}`,
      );
      continue;
    }

    const uri = toPluginLocationUri(location);
    if (!uri) {
      continue;
    }

    roots.push({
      uri,
      sourceKind: "chatSetting",
      sourceLabel: `chat.pluginLocations (${location})`,
      maxDepth: 0,
    });
  }

  roots.push({
    uri: vscode.Uri.file(path.join(os.homedir(), ...COPILOT_CLI_PLUGIN_PATH)),
    sourceKind: "copilotCli",
    sourceLabel: "GitHub Copilot CLI installed plugins",
    maxDepth: 3,
  });

  const userDataRoot = getUserDataRoot(profileStorageUri);
  if (userDataRoot) {
    roots.push({
      uri: vscode.Uri.file(path.join(userDataRoot, VSCODE_AGENT_PLUGIN_FOLDER)),
      sourceKind: "vscodeInstalled",
      sourceLabel: "VS Code installed agent plugins",
      maxDepth: 4,
    });
  }

  return roots;
}

async function discoverPluginsUnderRoot(
  root: PluginSearchRoot,
  logger: vscode.LogOutputChannel,
): Promise<readonly DiscoveredPlugin[]> {
  if (!(await directoryExists(root.uri))) {
    return [];
  }

  const plugins: DiscoveredPlugin[] = [];
  const queue: Array<{ uri: vscode.Uri; depth: number }> = [
    { uri: root.uri, depth: 0 },
  ];
  const visited = new Set<string>();

  while (queue.length) {
    const next = queue.shift();
    if (!next) {
      break;
    }

    const key = next.uri.fsPath.toLowerCase();
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);

    const manifestLocation = await findPluginManifest(next.uri);
    if (manifestLocation) {
      const plugin = await loadPluginAtLocation(
        next.uri,
        manifestLocation,
        root,
        logger,
      );
      if (plugin) {
        plugins.push(plugin);
      }
      continue;
    }

    if (next.depth >= root.maxDepth) {
      continue;
    }

    const childDirectories = await readChildDirectories(next.uri);
    queue.push(
      ...childDirectories.map((uri) => ({
        uri,
        depth: next.depth + 1,
      })),
    );
  }

  if (plugins.length) {
    logger.debug(
      `[plugin-discovery] Found ${plugins.length} plugin(s) in ${root.sourceLabel}`,
    );
  }

  return plugins;
}

async function loadPluginAtLocation(
  rootUri: vscode.Uri,
  manifestLocation: PluginManifestLocation,
  source: PluginSearchRoot,
  logger: vscode.LogOutputChannel,
): Promise<DiscoveredPlugin | undefined> {
  const manifestUri = joinRelativePath(rootUri, manifestLocation.relativePath);

  try {
    const bytes = await vscode.workspace.fs.readFile(manifestUri);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!isRecord(parsed) || typeof parsed.name !== "string") {
      return undefined;
    }

    const manifest: PluginManifest = {
      name: parsed.name,
      description:
        typeof parsed.description === "string" ? parsed.description : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      skills: parsed.skills,
      agents: parsed.agents,
      hooks: parsed.hooks,
      mcpServers: parsed.mcpServers,
    };

    const unsupportedComponents = [
      manifest.skills !== undefined ? "skills" : undefined,
      manifest.agents !== undefined ? "custom agents" : undefined,
      manifest.hooks !== undefined ? "hooks" : undefined,
    ].filter((value): value is string => value !== undefined);

    return {
      manifest,
      manifestUri,
      rootUri,
      format: manifestLocation.format,
      sourceKind: source.sourceKind,
      sourceLabel: source.sourceLabel,
      unsupportedComponents,
    };
  } catch (error) {
    logger.warn(
      `[plugin-discovery] Failed to read ${manifestUri.fsPath}: ${extractReadableErrorMessage(error)}`,
    );
    return undefined;
  }
}

async function findPluginManifest(
  rootUri: vscode.Uri,
): Promise<PluginManifestLocation | undefined> {
  for (const location of PLUGIN_MANIFEST_LOCATIONS) {
    const candidate = joinRelativePath(rootUri, location.relativePath);
    if (await fileExists(candidate)) {
      return location;
    }
  }

  return undefined;
}

async function readChildDirectories(
  rootUri: vscode.Uri,
): Promise<readonly vscode.Uri[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(rootUri);
    return entries
      .filter((entry) => entry[1] === vscode.FileType.Directory)
      .map((entry) => vscode.Uri.joinPath(rootUri, entry[0]));
  } catch {
    return [];
  }
}

async function directoryExists(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

function toPluginLocationUri(location: string): vscode.Uri | undefined {
  if (!location.trim()) {
    return undefined;
  }

  if (location.startsWith("file://")) {
    return vscode.Uri.parse(location);
  }

  if (path.isAbsolute(location)) {
    return vscode.Uri.file(location);
  }

  const workspaceRoot = currentWorkspaceRoot();
  if (!workspaceRoot) {
    return undefined;
  }

  return joinRelativePath(workspaceRoot, location);
}

function getUserDataRoot(
  profileStorageUri: vscode.Uri | undefined,
): string | undefined {
  if (!profileStorageUri || profileStorageUri.scheme !== "file") {
    return undefined;
  }

  let current = path.dirname(path.dirname(profileStorageUri.fsPath));
  while (current) {
    if (path.basename(current).toLowerCase() === "user") {
      return path.dirname(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return undefined;
}

function joinRelativePath(
  rootUri: vscode.Uri,
  relativePath: string,
): vscode.Uri {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  return vscode.Uri.joinPath(rootUri, ...segments);
}

async function loadWorkspacePluginHints(
  logger: vscode.LogOutputChannel,
): Promise<WorkspacePluginHints> {
  const workspaceRoot = currentWorkspaceRoot();
  if (!workspaceRoot) {
    return { enabledPluginIds: [], marketplaces: [], sources: [] };
  }

  const hintFiles = [
    joinRelativePath(workspaceRoot, ".github/copilot/settings.json"),
    joinRelativePath(workspaceRoot, ".claude/settings.json"),
  ];

  const enabledPluginIds = new Set<string>();
  const marketplaces = new Set<string>();
  const sources: string[] = [];

  for (const hintFile of hintFiles) {
    if (!(await fileExists(hintFile))) {
      continue;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(hintFile);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }

      sources.push(hintFile.fsPath);

      if (isRecord(parsed.enabledPlugins)) {
        for (const [pluginId, enabled] of Object.entries(
          parsed.enabledPlugins,
        )) {
          if (enabled) {
            enabledPluginIds.add(pluginId);
          }
        }
      }

      if (isRecord(parsed.extraKnownMarketplaces)) {
        for (const marketplace of Object.keys(parsed.extraKnownMarketplaces)) {
          marketplaces.add(marketplace);
        }
      }
    } catch (error) {
      logger.warn(
        `[plugin-hints] Failed to read ${hintFile.fsPath}: ${extractReadableErrorMessage(error)}`,
      );
    }
  }

  if (enabledPluginIds.size || marketplaces.size) {
    logger.info(
      `[plugin-hints] Read workspace plugin hints from ${sources.join(", ") || "workspace settings"}`,
    );
    if (marketplaces.size) {
      logger.info(
        `[plugin-hints] Additional plugin marketplaces are configured but not auto-cloned by ACP: ${Array.from(
          marketplaces,
        ).join(", ")}`,
      );
    }
  }

  return {
    enabledPluginIds: Array.from(enabledPluginIds),
    marketplaces: Array.from(marketplaces),
    sources,
  };
}

function normalizeRecommendedPluginName(pluginId: string): string {
  return pluginId.split("@")[0]?.trim() ?? pluginId;
}
