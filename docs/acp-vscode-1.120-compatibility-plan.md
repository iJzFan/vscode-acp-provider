# ACP VS Code 1.120 Compatibility Plan

## Goal

- Move the extension to a VS Code 1.120-centered integration model.
- Reuse official VS Code, GitHub Copilot CLI, and Claude Code customization formats where that is technically possible.
- Reduce duplicated configuration by letting ACP consume shared MCP and plugin metadata instead of inventing a fully separate customization surface.
- Keep ACP-specific settings limited to launch, protocol bootstrap, and ACP-only session options.

## Current Status

- Phase 1 is implemented: ACP-local MCP config supports `stdio` and `http`, and session bootstrap now merges the active profile `mcp.json`, workspace `.vscode/mcp.json`, compatible plugin MCP definitions, and explicit ACP agent config with documented precedence.
- Phase 2 is implemented as an MCP-focused compatibility layer: the extension discovers official plugin manifest locations, imports plugin `.mcp.json` definitions, expands Claude/OpenPlugin root tokens, and scans GitHub Copilot CLI installs plus VS Code/local plugin locations.
- Phase 3 is implemented as an ACP-compatible UX projection: plan updates now render follow-up actions in chat, permission prompts include local risk heuristics, context-window usage emits threshold hints, and rich multi-diff rendering already covers the diff-review part of the plan.
- ACP protocol constraint: ACP still does not define a dedicated plan-feedback request, so plan approval or revision requests are projected back into chat as follow-up prompts instead of a protocol-level `plan_feedback` message.

## Official Findings

The plan below is based on the current official VS Code and Copilot documentation.

1. The Agent Customizations editor currently supports `local agents`, `Copilot CLI`, and `Claude agent` as built-in agent types. ACP is not listed as a built-in agent type today.
2. VS Code documents the agent plugin format as shared across VS Code, GitHub Copilot CLI, and Claude Code.
3. VS Code automatically discovers plugins installed by GitHub Copilot CLI.
4. Agent plugins can package slash commands, skills, custom agents, hooks, and MCP servers.
5. VS Code MCP configuration is an official surface with workspace and user scopes, and it supports `stdio` and `http` transports.
6. VS Code 1.120 adds improved plan editing for Claude and Copilot CLI, command risk assessment, terminal output compression, Agents window support, and additional MCP/document diff capabilities.

## Official Source URLs

- https://code.visualstudio.com/docs/copilot/customization/overview
- https://code.visualstudio.com/docs/copilot/customization/agent-plugins
- https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- https://code.visualstudio.com/docs/copilot/customization/language-models
- https://code.visualstudio.com/updates/v1_120

## Current Repo State

The current extension is already close to a shared-provider design, but it is still isolated from the official customization surfaces.

1. `acpClient.agents` is generic. The runtime treats each configured agent as an ACP-backed provider instead of hardcoding behavior by vendor.
2. `src/agentRegistry.ts` dynamically loads agent definitions from settings and normalizes them into `AgentRegistryEntry` values.
3. `src/acpLanguageModelProvider.ts` exposes models dynamically from ACP session options, so model information is runtime-driven instead of config-driven.
4. `src/types.ts` only models `stdio` MCP servers today.
5. `src/acpClient.ts` currently serializes only `McpServerStdio`, even though the ACP SDK already includes `McpServerHttp` and `McpServerSse` types.
6. README still frames MCP support as ACP-agent-local config, not as part of the broader VS Code/Copilot customization ecosystem.

## Answer: Can Copilot CLI / Claude Configuration Also Support ACP?

## Short Answer

Yes, partially.

The reusable part is not the built-in `agent type` integration itself. The reusable part is the shared configuration layer around plugins and MCP servers.

## What Can Be Reused Directly

- Plugin discovery from official plugin manifest locations.
- Plugins installed by GitHub Copilot CLI.
- Plugin MCP definitions from `.mcp.json`.
- Workspace MCP configuration from `.vscode/mcp.json`.
- User MCP configuration from the profile-level `mcp.json`.
- Plugin enable/disable state and plugin source metadata.

## What Cannot Be Reused Natively Today

- ACP cannot appear as a built-in agent type in the Agent Customizations editor without new VS Code support.
- Copilot/Claude custom agents, hooks, skills, and slash commands are not automatically executable by this ACP extension.
- Copilot/Claude provider-specific authentication, model picker state, or reasoning-effort state cannot simply be copied into ACP because ACP models and options come from the ACP agent protocol at runtime.
- VS Code's built-in plan-mode UX for Copilot CLI and Claude is not automatically inherited by ACP. This extension has to implement an equivalent projection for ACP plan updates.

## Recommendation

Do not try to make ACP a fake `Claude` or `Copilot CLI` agent type.

Instead, add an `ACP compatibility layer` that imports the official shared configuration surfaces and projects them into ACP runtime configuration.

That keeps the extension aligned with official tooling without depending on unsupported VS Code internals.

## Proposed Compatibility Model

## Goal

Create one internal resolved configuration model that can merge:

- ACP-native settings from `acpClient.agents`
- official workspace MCP config
- official user MCP config
- official Copilot/Claude-compatible plugin manifests
- plugin MCP definitions

## Internal Types To Add

- `ResolvedAcpAgentConfig`
- `ResolvedMcpServerConfig`
- `ResolvedPluginSource`
- `ImportedConfigSource`

## Suggested Source Priority

1. Explicit ACP agent config in `acpClient.agents`
2. Imported plugin MCP config explicitly attached to an ACP agent
3. Workspace MCP config
4. User MCP config

This priority keeps repo-local intent above machine-global defaults.

## Configuration Mapping

| Official surface | Reuse in ACP | Implementation rule | Initial phase |
| --- | --- | --- | --- |
| `.vscode/mcp.json` | Yes | Import `stdio` and `http` servers into a shared ACP MCP registry | Phase 1 |
| user `mcp.json` | Yes | Import as global fallback MCP sources | Phase 1 |
| `plugin.json` / `.claude-plugin/plugin.json` | Yes | Discover plugin metadata and attach compatible MCP metadata to ACP | Phase 2 |
| plugin `.mcp.json` | Yes | Import plugin MCP servers into ACP shared MCP registry | Phase 2 |
| `.github/copilot/settings.json` / `.claude/settings.json` | Partial | Reuse plugin marketplace and enablement hints, not runtime agent semantics | Phase 2 |
| plugin hooks | Partial | Future ACP policy runner only; do not execute in v1 | Phase 3 |
| plugin custom agents | Partial | Future metadata projection only; do not claim native compatibility in v1 | Phase 3 |
| model picker / thinking effort | No direct import | Keep ACP model and mode options protocol-driven | Out of scope for config compatibility v1 |

## Phased Plan

## Phase 1: Shared MCP Configuration

## Goal

Let ACP sessions consume the same official MCP definitions that VS Code chat can already consume.

## Steps

1. Extend `src/types.ts` to support both `stdio` and `http` MCP server definitions.
2. Add a new importer service, for example `src/mcpConfigImporter.ts`, that can parse workspace and user MCP configuration.
3. Merge imported MCP servers into a shared internal registry before `AgentRegistry` finalizes each `AgentRegistryEntry`.
4. Extend `src/acpClient.ts` so `serializeMcpServers()` can emit `McpServerHttp` as well as `McpServerStdio`.
5. Log the origin of each imported MCP server so maintainers can see whether a server came from ACP settings, workspace MCP config, user MCP config, or a plugin.
6. Update README to explain the new precedence model and the difference between ACP-native config and imported official config.

## Files

- `src/types.ts`
- `src/acpClient.ts`
- `src/agentRegistry.ts`
- `src/extension.ts`
- `README.md`
- new file: `src/mcpConfigImporter.ts`

## Acceptance Criteria

- A server defined in `.vscode/mcp.json` can be attached to an ACP-backed session without duplicating the same server under `acpClient.agents`.
- Both `stdio` and `http` MCP definitions are supported.
- `npm run compile` succeeds.
- Logs clearly show which MCP servers were imported and from where.

## Phase 2: Copilot CLI / Claude Plugin Compatibility

## Goal

Allow ACP to reuse the official plugin ecosystem that VS Code, GitHub Copilot CLI, and Claude Code already share.

## Steps

1. Add a new plugin discovery service, for example `src/pluginDiscovery.ts`.
2. Recognize the official manifest locations documented by VS Code:
   - `.plugin/plugin.json`
   - `plugin.json`
   - `.github/plugin/plugin.json`
   - `.claude-plugin/plugin.json`
3. Import plugin MCP definitions from plugin `.mcp.json` files and merge them into the same shared MCP registry from Phase 1.
4. Add support for the GitHub Copilot CLI installed plugin directory as a discovery source, because VS Code officially reuses that installation surface.
5. Expand Claude-format root tokens such as `${CLAUDE_PLUGIN_ROOT}` when importing plugin MCP definitions.
6. Keep hooks, skills, slash commands, and custom agents as metadata-only in this phase. Do not claim runtime compatibility until ACP-specific projections exist.

## Files

- `src/extension.ts`
- `src/agentRegistry.ts`
- `src/types.ts`
- new file: `src/pluginDiscovery.ts`
- new file: `src/pluginCompatibility.ts`
- `README.md`

## Acceptance Criteria

- A plugin installed by GitHub Copilot CLI can be discovered by the ACP extension.
- MCP servers defined by that plugin can be imported into ACP sessions.
- Claude-format plugin roots are resolved correctly.
- Unsupported plugin components are surfaced as informational metadata instead of silently ignored behavior.

## Phase 3: ACP Projection For Shared UX Features

## Goal

Adopt the VS Code 1.120 UX direction so ACP sessions feel closer to the built-in Claude/Copilot CLI agent experience.

## Steps

1. Upgrade ACP plan rendering so plan updates can support an editable approval or feedback flow.
2. Add risk assessment metadata to ACP tool confirmations, following the VS Code 1.120 terminal risk-assessment pattern.
3. Add context-window and token-usage surfacing for ACP models, following VS Code 1.120 BYOK usage improvements.
4. Improve ACP diff review by evaluating `documentDiff` / custom diff integration for richer review flows.

## Files

- `src/acpChatParticipant.ts`
- `src/permissionPrompts.ts`
- `src/acpLanguageModelProvider.ts`
- `src/chatRenderingUtils.ts`
- optionally new files for plan/risk/context services

## Acceptance Criteria

- ACP users can review plan state with a clearer edit or feedback loop.
- Tool calls surface clearer safety information before execution.
- Token and context usage are visible enough to help with long-running ACP sessions.

## Non-Goals For v1

- Making ACP appear as a native agent type in the built-in Agent Customizations editor.
- Executing Claude/Copilot hooks without an ACP-specific security and lifecycle model.
- Copying Copilot/Claude model configuration directly into ACP runtime state.
- Claiming full runtime compatibility for agent skills, slash commands, or custom agents before ACP-specific projections exist.

## Recommended First Implementation Slice

## Goal

Deliver the smallest useful compatibility feature with the highest leverage.

## Steps

1. Implement Phase 1 only.
2. Add `http` MCP support to ACP config types and serialization.
3. Import `.vscode/mcp.json` into ACP session bootstrap.
4. Document the precedence rules in README.
5. Validate with one workspace-local MCP server and one ACP agent.

This slice has the best leverage because it immediately removes duplicated tool configuration while staying inside documented, official config surfaces.