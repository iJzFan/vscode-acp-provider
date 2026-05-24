## [0.6.0] - 2026-05-25

- Downloaded and probed `formulahendry/acp-agent-monitor` plus `formulahendry/vscode-acp`; captured local OpenCode `1.15.7` and Auggie `0.28.0-prerelease.5` ACP initialize snapshots for compatibility checks.
- Added reference-aligned ACP Session Config Options support so agent-advertised selectors such as model, mode, reasoning/thought level, and custom select options can appear in VS Code chat session options.
- Routed mode/model changes through `session/set_config_option` when agents advertise config options, while keeping legacy `session/set_mode` / `unstable_setSessionModel` fallbacks for older agents.
- Synced `config_option_update` notifications into live provider options and added regression coverage for rendering dynamic config option groups and handling user changes.

## [0.5.10] - 2026-05-22

- Fixed Auggie ACP execute-tool rendering for real wrapped PowerShell results by unwrapping `<return-code>` / `<output>` envelopes, parsing exit codes, and stripping trailing CLIXML progress blobs before they reach the chat UI.
- Cleaned markdown-like terminal output captured from real `auggie --acp` sessions so Jekyll `{% code %}` blocks and HTML `<figure>` tags become readable text instead of leaking raw wrapper markup.
- Added regression coverage for real Auggie ACP payloads in both `chatRenderingUtils` and `turnBuilder`, alongside a live Auggie ACP probe validation kept within the requested test budget.

## [0.5.9] - 2026-05-22

- Fixed OpenCode ACP tool rendering to use concise completion summaries instead of dumping full tool output into `pastTenseMessage`, which stopped raw file contents and terminal output from leaking into the tool headline UI.
- Fixed OpenCode execute-tool command extraction for string-shaped `rawInput.command` payloads, restoring proper command-line rendering and terminal metadata for real `opencode acp` sessions.
- Added markdown-aware MCP tool output rendering that prefers `metadata.preview` with `text/markdown` for markdown/file-read tools, including cleanup of Jekyll-style `{% code %}` blocks and HTML `<figure>` tags into readable markdown.
- Sanitized ANSI-style terminal output before rendering tool result text and added regression coverage using payloads captured from a real `opencode acp` probe.

## [0.5.8] - 2026-05-22

- Reduced VSIX size by whitelisting only runtime extension assets (`out/**`, production `node_modules/**`, manifest, and marketplace docs) during packaging.
- Excluded repository-only artifacts from packaging, including CodeGraph indexes, logs, diff/investigation materials, prior VSIX files, and compiled test outputs.

## [0.5.7] - 2026-05-22

- Fixed ACP tool-result rendering for XML-like file review payloads so tool calls no longer leak raw `<path>`, `<type>`, `<entries>`, and `<content>` tags into the chat UI.
- Reformatted tagged file-review content into readable path/type/content sections in the shared tool-output formatter, which fixes both live tool updates and replayed session history.
- Added regression coverage for tagged tool-output formatting in both `chatRenderingUtils` and `turnBuilder`.

## [0.5.6] - 2026-05-22

- Fixed changed-file added/removed counts and inline diff headers for empty-file creations and deletions by treating empty content as zero diff lines.
- Restored structured tool invocation rendering data and summaries so live/replayed ACP tool calls keep their command details instead of collapsing to a single flat line.
- Added regression coverage for empty-content diff stats, empty-file inline diff headers, and completed execute-command replay rendering.

## [0.5.5] - 2026-05-21

- Fixed untitled ACP session cache cleanup so starting a new chat from the session list no longer reuses the previously completed untitled session.
- Fixed first-request session-item initialization so session-list launches bind to the real ACP session URI immediately instead of leaving new chats on colliding untitled resources.
- Reused already-active named sessions in the session manager so promoted live sessions do not spawn duplicate ACP sessions when VS Code requests their content.
- Ignored stale named `sessionResource` values during `newChatSessionItemHandler`, forcing New Chat/session-list launches onto a fresh untitled ACP session instead of reopening the previously selected named session.
- Fixed execute-command / tool-call rendering so initial tool calls without an explicit status still preserve their command line, terminal kind, and completion metadata in both live chat updates and replayed session history.
- Added a regression test covering back-to-list then new-untitled-session creation.

## [0.5.1] - 2026-05-20

- Surfaced ACP tool lifecycle summaries in the chat UI and session replay so pending/completed tool calls such as sub-agent planner invocations no longer appear only in the `ACP Client` log.
- Preserved multiple structured tool output fields and retained PowerShell `CLIXML` payloads instead of truncating them from rendered tool results.
- Added replayed `current_mode_update` and `usage_update` progress entries so restored sessions keep key ACP status updates visible.

## [0.5.0] - 2026-05-20

- Fixed end-of-turn cumulative diffs to prefer full-file workspace snapshots (with metadata fallbacks) so the `Modified files` review shows whole-file before/after content instead of only reported diff hunks or code blocks.
- Added chat jump buttons for cumulative changed files while keeping the final `Modified files` review focused on the diff view itself.
- Extended history/session diff aggregation to understand tool metadata file snapshots in addition to ACP diff blocks.

## [0.4.19] - 2026-05-21

- Fixed live and replayed diff rendering so repeated ACP diff hunks for the same file coalesce into a single file entry instead of showing duplicate changed-file rows.
- Normalized cumulative diff artifact keys more aggressively so equivalent file paths merge reliably across updates.
- Fixed structured command history parsing so resumed sessions decode escaped XML command arguments and prefer the tagged command format over the older `User:` fallback text path.
- Stripped trailing PowerShell `CLIXML` progress noise from terminal/tool output before rendering, avoiding raw XML blobs in command results.

## [0.4.18] - 2026-05-21

- Fixed the chat-session item controller crash when VS Code invokes `newChatSessionItemHandler` before `request.sessionResource` is available for a new ACP session.
- Added a placeholder-item fallback for resource-less startup requests and a regression test that covers the early-session runtime shape.

## [0.4.17] - 2026-05-20

- Fixed ACP session-list lifecycle wiring so in-progress sessions no longer disappear from the sidebar when users start another session or navigate back to the session list.
- Switched the runtime registration path to the `ChatSessionItemController` implementation, which keeps live in-progress items merged with persisted sessions and promotes untitled sessions into stable session items on first request.
- Corrected the architecture notes for session-list management and session disposal behavior.

## [0.4.16] - 2026-05-20

- Tightened the `writeTextFile` tracked-edit lifecycle so ACP edit tracking now resolves against the actual file write completion instead of waiting only for later tool-call completion updates.
- Added a lightweight external edit tracker that associates `externalEdit(...)` registrations with file URIs and closes them as soon as the authoritative ACP write succeeds.
- Improved the `writeTextFile` / edit-tool path so Keep / Undo actions appear more consistently and feel closer to Copilot-style tracked edits.
- Added regression tests for URI-based external edit tracking registration, resolution, and unregister behavior.

## [0.4.15] - 2026-05-20

- Added a final live `Modified files` multi-diff at the end of ACP chat responses so the latest request shows the full accumulated diff instead of only per-tool deltas.
- Broadened edit-resource detection to include diff content paths, allowing more ACP edit flows to participate in VS Code's tracked-edit UX and surface the bottom changes area with keep/undo actions.
- Started surfacing cumulative changed-file metadata through chat session items so session-level change summaries stay aligned with the diff artifacts.
- Added a regression test covering diff-path resource extraction for edit tracking.

## [0.4.14] - 2026-05-20

- Fixed ACP file writes for open editors by routing all extension-managed writes through a shared coordinator that updates the in-memory document first and then saves it, preventing the "The content of the file is newer" save conflict.
- Stopped the diff-only chat fallback from applying second-path `textEdit` / `workspaceEdit` mutations, so file diffs stay visible in chat without auto-opening editors or racing the authoritative write pipeline.
- Changed live and replayed diff parts to stay clickable in the chat UI instead of being forced read-only.
- Fixed cumulative session diffs to preserve each file's earliest original content and latest final content, so the "Modified files" roll-up now shows a true original-to-final diff.
- Updated regression tests to cover open-editor overwrites, serialized writes, and true cumulative diff aggregation.

## [0.4.13] - 2026-05-20

- Replaced the previous mixed ACP file-write handling with a direct `workspace.fs.writeFile` pipeline and per-URI serialization; follow-up fixes in `0.4.14` restore safe open-editor synchronization while keeping ordered writes.
- Added per-URI write serialization so repeated writes to the same file execute in order and never race against each other.
- Added session-level cumulative diff aggregation so the chat UI shows a rolled-up "Modified files" view across all tool calls in a session.
- History replay now includes cumulative diff parts so resumed sessions display the latest aggregated file edits.
- Added regression tests for write pipeline correctness and cumulative diff aggregation.

## [0.4.12] - 2026-05-20

- Fixed `writeTextFile` to use `WorkspaceEdit` + `save()` for open documents instead of `fs.writeFile`, eliminating "file content is newer" errors on subsequent save and preventing content reverts.

## [0.4.11] - 2026-05-19

- Fixed live ACP file-diff rendering so completed tool updates now push the `File edits` diff part during the active chat stream instead of only showing diffs when session history is rebuilt.
- Kept diff rendering active after `externalEdit()` tool flows finish so file-edit tools that also report diff content no longer suppress the visible diff widget.

## [0.4.11] - 2026-05-19

- Fixed live ACP file-diff rendering so completed tool updates now push the `File edits` diff part during the active chat stream instead of only showing diffs when session history is rebuilt.
- Kept diff rendering active after `externalEdit()` tool flows finish so file-edit tools that also report diff content no longer suppress the visible diff widget.

## [0.4.10] - 2026-05-19

- Trimmed redundant queue design detail from `docs/plans/slash-commands-and-input-queue.md` now that the implemented input-queue behavior is already documented by the code and integration points.

## [0.4.9] - 2026-05-19

- Enabled ACP client filesystem capabilities (`readTextFile` / `writeTextFile`) and terminal support so agents can read/write files and use terminal features directly through the protocol.

## [0.4.8] - 2026-05-19

- Added the Command Palette action `ACP: Import Auggie manual commands`, which runs `auggie command help`, parses the custom-command catalog, and stores the results in `acpClient.agents.auggie.manualCommands` in user settings.
- Added parser tests for wrapped Auggie command descriptions so CLI help output can be imported more reliably.

## [0.4.7] - 2026-05-19

- Fixed slash/custom command transport so selected ACP commands are serialized into the existing `<command-message>`, `<command-name>`, and `<command-args>` tagged text format instead of being sent as plain user text.
- Added unit tests for structured command prompt serialization, including slash-prefixed prompts and XML escaping.

## [0.4.6] - 2026-05-19

- Added per-agent `manualCommands` configuration so slash commands can be surfaced even when an ACP agent does not advertise the full command catalog over `available_commands_update`.
- Merged manually configured/imported commands into slash completion and the in-chat `/?` list, while keeping ACP-advertised commands authoritative on name collisions.
- Added explicit source labels (`ACP advertised` vs `manually configured/imported`) in command logs, slash-completion details, and the `/?` transcript output.

## [0.4.5] - 2026-05-18

- Fixed ACP slash-command discovery for namespaced commands (including Auggie/OpenCode command names with `:` or `-`) by broadening slash trigger detection and using alias-aware matching in both completion providers.
- Updated the in-chat `/?` command list and ACP output logging to show short readable aliases while still inserting/logging the canonical ACP command names advertised by the agent.
- Added reusable command-matching helpers, unit tests, and a mock scenario for namespaced `available_commands_update` payloads.

## [0.4.4] - 2026-05-18

- Added first-class `Auggie [ACP]` chat-session contribution so `acpClient.agents.auggie` can appear directly in the session picker instead of being routed through another provider profile.
- Logged negotiated ACP protocol, auth methods, and capability summaries during agent startup, including explicit notes when this extension is still running with `terminal/*` and `fs/*` client capabilities disabled.
- Logged ACP tool lifecycle summaries to the ACP output channel and rendered touched-file summaries in chat when tool calls include file locations or diffs.
- Documented the official direct Auggie configuration path (`auggie --acp`) and the new ACP capability diagnostics in the README.

## [0.4.0] - 2026-05-16

- Switched to `createDynamicChatParticipant` so the agent (e.g. `@opencode`) appears in the `@` autocomplete list.

## [0.3.9] - 2026-05-16

- Added `vscode-chat-editor` scheme to `CompletionItemProvider` registration for slash completions in session chat input.

## [0.3.8] - 2026-05-16

- Slash completion: registered `CompletionItemProvider` for ACP session scheme (`acp-{agent}`, `acp`).
- Context window: added `outputBuffer` to `response.usage()` so VS Code can infer the correct total capacity from `used + reserved`.

## [0.3.7] - 2026-05-16

- Fixed slash (`/`) completion: registered `CompletionItemProvider` for the ACP session scheme and base `acp` scheme to provide completions in session chat input editors.

## [0.3.6] - 2026-05-16

- Fixed slash (`/`) completion: added fallback `CompletionItemProvider` for the chat input document schemes (`vscode-chat-editor`, agent session scheme) to bypass VS Code's `ChatCompletionItem` conversion layer.

## [0.3.5] - 2026-05-16

- Fixed slash (`/`) completion: added `ChatVariableValue` to `ChatCompletionItem.values` so the conversion layer in VS Code's extension host doesn't skip our completion items.

## [0.3.4] - 2026-05-16

- Added debug logging to `provideCommandCompletionItems` to confirm whether VS Code actually invokes the provider when `/` is typed.

## [0.3.3] - 2026-05-16

- Fixed slash (`/`) completion not appearing: made registration more robust by probing for both `participantVariableProvider` and `commandProvider` on `ChatParticipant` at runtime, with diagnostic logging of available properties.

## [0.3.2] - 2026-05-16

- Fixed slash (`/`) completion not appearing in chat input: added runtime guard for the proposed `vscode.ChatCompletionItem` API so that errors constructing completion items don't silently disable the feature.
- Promoted the `participantVariableProvider` unavailability message from `debug` to `warn` level so missing proposed API support is visible in the ACP output channel.

## [0.3.1] - 2026-05-15

- Restored `response.usage()` call in the `usage_update` handler so the VS Code chat session header shows the running token count.
- Wired `usage_update` into `onDidChangeChatSessionProviderOptions` so the session header re-reads the model's `maxInputTokens` (the denominator) from the language model provider when the ACP agent emits a fresh context-window capacity value.

## [0.3.0] - 2026-05-15

- Added per-agent `skills` configuration (array of paths) for discovering Agent Skills from `SKILL.md` files.
- Unified the `/` completion menu to show both ACP commands and discovered skills, with skills using a `$(book)` icon and ACP commands winning on name conflict.
- New internal module `src/skillDiscovery.ts` handles path expansion (`~` → homedir, relative → workspace root) and `SKILL.md` frontmatter parsing.
- Removed the agent ID `propertyNames` restriction from `package.json` so any ACP-compatible CLI can be configured as an agent.
- Wrapped the async session-update notification handler in try/catch to prevent a single rendering error from silently stopping the display of subsequent streaming ACP responses.
- Removed the `previousMilestone === -1` guard from `renderContextWindowHints` so the context-usage progress message is shown on every `usage_update` instead of only once per session.

## [0.2.2] - 2026-05-15

- Stopped showing repeated unsupported thinking-effort popups and now hide the `Thinking` session option for an ACP agent after the first unsupported live-update detection.

## [0.2.1] - 2026-05-15

- Reduced unsupported thinking-effort notices to one popup per ACP session and moved repeated reminders to the ACP output channel.

## [0.2.0] - 2026-05-15

- Restored the chat-session `Thinking` option so thinking effort can be selected again from the ACP session options UI.
- Added per-agent `defaultMode`, `defaultModel`, and `defaultThinkingEffort` configuration for newly created ACP chat sessions.
- Wired session-level thinking effort changes through the ACP `session/set_think` extension method with a startup-only fallback for agents that do not support live updates.

## [0.1.15] - 2026-05-15

- Aligned ACP agent process startup with the reference implementation by spawning agent commands with `shell: true` so PATH-resolved CLI commands can start reliably on Windows.
- Promoted process-start failures from debug-only logging to surfaced errors and emitted the stop event so failed ACP launches do not hang chat-session initialization indefinitely.

## [0.1.14] - 2026-05-15

- Aligned non-untitled session loading with the reference implementation by falling back to a fresh ACP session when the persisted session is missing or stale.
- Stopped aborting chat-session initialization just because a committed ACP session resource was not yet present in the local session database.

## [0.1.13] - 2026-05-15

- Removed probe-session creation from `getOptions()` so ACP chat session initialization no longer starts an extra ACP session before the real untitled session is created.
- Let mode/model options populate from the actual session bootstrap path instead of blocking session startup on a preliminary options-discovery round trip.

## [0.1.12] - 2026-05-15

- Removed the dynamic `thought_level` option groups from ACP chat session bootstrap so initialization only returns the reference-aligned `mode` and `model` session options.
- Stopped pushing ACP-specific config option ids into the initial chat session payload while investigating untitled session cancellation.

## [0.1.11] - 2026-05-15

- Removed the extension-specific `onDidDisposeChatSession` shutdown hook so VS Code can replace untitled ACP chat sessions without the extension force-closing the backing ACP session during initialization.
- Dropped the corresponding runtime requirement because ACP startup no longer depends on `vscode.chat.onDidDisposeChatSession`.

## [0.1.10] - 2026-05-15

- Removed the extra per-agent ACP language model provider registration so ACP agents only use the reference-aligned chat participant and chat session registration path.
- Eliminated the `acp-opencode` runtime vendor registration that produced `UNKNOWN vendor` errors in the chat stack.

## [0.1.9] - 2026-05-15

- Removed the extra mode/model session-option update subscriptions from the chat session content provider and deleted the matching startup-only mode/model propagation from the session manager.
- Kept untitled ACP session bootstrap closer to the reference implementation by reducing option-update churn during initial session creation.
- Simplified initial session bootstrap to use the agent's configured MCP servers directly and stopped running session sync side effects during `createOrGet`, `loadSession`, and probe-session option discovery.

## [0.1.8] - 2026-05-14

- Aligned the extension manifest with the reference repo by removing the extra `chatProvider` and `defaultChatParticipant` proposal declarations.
- Removed the extra `languageModelChatProviders` manifest contributions so ACP chat sessions only advertise the `chatSessions` surface used by the runtime registration path.

## [0.1.7] - 2026-05-14

- Aligned `acpChatParticipant` session lookup with the reference implementation so request handling falls back to `createOrGet()` when a session is not already active.
- Added a saved initialization comparison document at `docs/reference-init-diff.md` to track the remaining file-by-file differences against the reference repo.

## [0.1.6] - 2026-05-14

- Reverted the custom untitled-session commit synthesis and aligned the chat session item provider behavior directly with the reference implementation.
- Removed the provider-specific resource migration logic that could keep VS Code and the in-memory ACP session state out of sync during chat-session initialization.

## [0.1.5] - 2026-05-14

- Fixed untitled ACP session commits so the in-memory session resource is updated to the committed ACP session URI before the provider reports the session migration back to VS Code.
- Reduced the chance of VS Code continuing to operate on a stale `untitled-*` resource after the chat session item has been committed.

## [0.1.4] - 2026-05-14

- Replaced the chat session item controller flow with a provider-based commit flow so untitled ACP sessions can migrate to real session resources using `onDidCommitChatSessionItem`, matching the reference implementation pattern.
- Reduced the chance of VS Code trying to reload an orphaned `untitled-*` ACP session resource during chat-session initialization.

## [0.1.3] - 2026-05-14

- Aligned untitled ACP session bootstrap more closely with the reference implementation by adding probe-session discovery and reuse during initial chat session setup.
- Reduced duplicate session creation during early chat initialization so model/mode option discovery can reuse the same ACP session instead of racing a second bootstrap.

## [0.1.2] - 2026-05-14

- Fixed ACP chat session initialization by reusing a shared client per agent instead of spawning a fresh ACP client for every session bootstrap.
- Reduced initialization-time cancellation risk for untitled ACP sessions and aligned the bootstrap flow more closely with the working reference implementation.

## [0.1.1] - 2026-05-14

- Updated `AGENTS.md` to reflect the current project workflow, runtime constraints, and release process.
- Added an explicit versioning policy: minor bump for new features, patch bump for bug fixes and maintenance changes, and mandatory build after every modification.

## [0.1.0] - 2026-05-14

- ACP (Agent Client Protocol) client implementation
- Support for multiple ACP-compliant servers
- Tool call support
- Configuration settings for acp server management
- Added `/`-triggered ACP command completions backed by reported `availableCommands`, while keeping `/?` as the explicit in-chat command list
- Added shared MCP import for the active VS Code profile `mcp.json`, workspace `.vscode/mcp.json`, and compatible plugin MCP definitions
- Added plugin compatibility for official plugin manifest locations, GitHub Copilot CLI installs, and root-token expansion for Claude/OpenPlugin MCP configs
- Added plan follow-up actions, permission risk hints, and context-window usage warnings for ACP chat sessions
