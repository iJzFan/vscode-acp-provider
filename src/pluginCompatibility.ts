// SPDX-License-Identifier: Apache-2.0
import * as path from "node:path";
import * as vscode from "vscode";
import {
  AcpMcpServerConfiguration,
  ImportedConfigSource,
  extractReadableErrorMessage,
} from "./types";
import {
  RawMcpServerConfiguration,
  fileExists,
  isRecord,
  toStringArray,
  toStringRecord,
} from "./mcpConfigImporter";
import { DiscoveredPlugin, discoverPlugins } from "./pluginDiscovery";

type RawPluginMcpConfiguration = {
  readonly mcpServers?: unknown;
};

type RawPluginMcpServerConfiguration = RawMcpServerConfiguration & {
  readonly cwd?: unknown;
  readonly envFile?: unknown;
};

const DEFAULT_PLUGIN_MCP_CONFIG = ".mcp.json";

export async function loadPluginMcpServers(
  profileStorageUri: vscode.Uri | undefined,
  logger: vscode.LogOutputChannel,
): Promise<readonly AcpMcpServerConfiguration[]> {
  const plugins = await discoverPlugins(profileStorageUri, logger);
  const servers: AcpMcpServerConfiguration[] = [];
  const seenNames = new Set<string>();

  for (const plugin of plugins) {
    if (plugin.unsupportedComponents.length) {
      logger.info(
        `[plugin-mcp] Plugin ${plugin.manifest.name} also declares ${plugin.unsupportedComponents.join(", ")}; ACP currently imports MCP servers only.`,
      );
    }

    const pluginServers = await resolvePluginMcpServers(plugin, logger);
    for (const server of pluginServers) {
      if (seenNames.has(server.name)) {
        logger.info(
          `[plugin-mcp] Skipping duplicate plugin server ${server.name} from ${plugin.manifest.name}`,
        );
        continue;
      }

      seenNames.add(server.name);
      servers.push(server);
    }
  }

  return servers;
}

async function resolvePluginMcpServers(
  plugin: DiscoveredPlugin,
  logger: vscode.LogOutputChannel,
): Promise<readonly AcpMcpServerConfiguration[]> {
  try {
    const inlineSpec = plugin.manifest.mcpServers;
    if (typeof inlineSpec === "string") {
      const configUri = joinRelativePath(plugin.rootUri, inlineSpec);
      return await loadPluginMcpServersFromFile(plugin, configUri, logger);
    }

    if (isRecord(inlineSpec)) {
      return parsePluginMcpServers(plugin, inlineSpec, logger, plugin.manifestUri);
    }

    const defaultConfigUri = joinRelativePath(plugin.rootUri, DEFAULT_PLUGIN_MCP_CONFIG);
    if (await fileExists(defaultConfigUri)) {
      return await loadPluginMcpServersFromFile(plugin, defaultConfigUri, logger);
    }
  } catch (error) {
    logger.warn(
      `[plugin-mcp] Failed to import plugin MCP servers from ${plugin.manifest.name}: ${extractReadableErrorMessage(error)}`,
    );
  }

  return [];
}

async function loadPluginMcpServersFromFile(
  plugin: DiscoveredPlugin,
  configUri: vscode.Uri,
  logger: vscode.LogOutputChannel,
): Promise<readonly AcpMcpServerConfiguration[]> {
  try {
    const bytes = await vscode.workspace.fs.readFile(configUri);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const servers = parsePluginMcpServers(plugin, parsed, logger, configUri);
    if (servers.length) {
      logger.debug(
        `[plugin-mcp] Imported ${servers.length} server(s) from ${configUri.fsPath}`,
      );
    }
    return servers;
  } catch (error) {
    logger.warn(
      `[plugin-mcp] Failed to read ${configUri.fsPath}: ${extractReadableErrorMessage(error)}`,
    );
    return [];
  }
}

function parsePluginMcpServers(
  plugin: DiscoveredPlugin,
  value: unknown,
  logger: vscode.LogOutputChannel,
  sourceUri: vscode.Uri,
): readonly AcpMcpServerConfiguration[] {
  const serverEntries = getPluginServerEntries(value);
  if (!serverEntries) {
    return [];
  }

  const servers: AcpMcpServerConfiguration[] = [];
  for (const [name, rawConfig] of Object.entries(serverEntries)) {
    const server = parsePluginMcpServer(
      plugin,
      name,
      rawConfig,
      logger,
      sourceUri,
    );
    if (server) {
      servers.push(server);
    }
  }

  return servers;
}

function parsePluginMcpServer(
  plugin: DiscoveredPlugin,
  name: string,
  value: unknown,
  logger: vscode.LogOutputChannel,
  sourceUri: vscode.Uri,
): AcpMcpServerConfiguration | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const config = value as RawPluginMcpServerConfiguration;
  const type = config.type;
  const source = buildPluginSource(plugin, sourceUri);

  if (type === "http") {
    if (typeof config.url !== "string") {
      return undefined;
    }

    return {
      type: "http",
      name,
      url: expandPluginTokens(plugin, config.url),
      headers: expandStringRecord(plugin, config.headers),
      source,
    };
  }

  if (type === "sse") {
    logger.info(
      `[plugin-mcp] Skipping SSE MCP server ${name} from plugin ${plugin.manifest.name}; ACP compatibility currently imports only stdio and http servers.`,
    );
    return undefined;
  }

  if (type === undefined || type === "stdio") {
    if (typeof config.command !== "string") {
      return undefined;
    }

    const warnings: string[] = [];
    if (typeof config.cwd === "string") {
      warnings.push("cwd is ignored because ACP MCP stdio bootstrap does not support it yet");
    }
    if (typeof config.envFile === "string") {
      warnings.push("envFile is ignored because ACP MCP stdio bootstrap does not support it yet");
    }
    if (warnings.length) {
      logger.info(
        `[plugin-mcp] Plugin ${plugin.manifest.name} server ${name}: ${warnings.join("; ")}`,
      );
    }

    return {
      type: "stdio",
      name,
      command: expandPluginTokens(plugin, config.command),
      args: expandStringArray(plugin, config.args),
      env: injectPluginRootEnv(plugin, expandStringRecord(plugin, config.env)),
      source,
      warnings,
    };
  }

  return undefined;
}

function getPluginServerEntries(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const config = value as RawPluginMcpConfiguration;
  if (isRecord(config.mcpServers)) {
    return config.mcpServers;
  }

  return value;
}

function buildPluginSource(
  plugin: DiscoveredPlugin,
  sourceUri: vscode.Uri,
): ImportedConfigSource {
  return {
    kind: "plugin",
    label: `${plugin.manifest.name} (${plugin.sourceLabel})`,
    path: sourceUri.fsPath,
  };
}

function expandStringArray(
  plugin: DiscoveredPlugin,
  value: unknown,
): readonly string[] | undefined {
  const parts = toStringArray(value);
  return parts?.map((part) => expandPluginTokens(plugin, part));
}

function expandStringRecord(
  plugin: DiscoveredPlugin,
  value: unknown,
): Record<string, string> | undefined {
  const record = toStringRecord(value);
  if (!record) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, expandPluginTokens(plugin, entry)]),
  );
}

function injectPluginRootEnv(
  plugin: DiscoveredPlugin,
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const output = { ...(env ?? {}) };

  if (plugin.format === "claude") {
    output.CLAUDE_PLUGIN_ROOT ??= plugin.rootUri.fsPath;
  }
  if (plugin.format === "openplugin") {
    output.PLUGIN_ROOT ??= plugin.rootUri.fsPath;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function expandPluginTokens(plugin: DiscoveredPlugin, value: string): string {
  return value
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin.rootUri.fsPath)
    .replace(/\$\{PLUGIN_ROOT\}/g, plugin.rootUri.fsPath);
}

function joinRelativePath(rootUri: vscode.Uri, relativePath: string): vscode.Uri {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  return vscode.Uri.joinPath(rootUri, ...segments);
}