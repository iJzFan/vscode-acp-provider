# ACP Schema-Driven Roadmap

> Last updated: 2026-05-14
> Scope: post-0.1.0 roadmap derived from ACP schema capabilities that the current extension does not yet expose fully.

## Goal

- Turn already-defined ACP protocol capabilities into concrete VS Code product improvements.
- Prioritize features that improve daily UX before deeper protocol or ecosystem work.
- Keep the roadmap grounded in capabilities that are already visible in `@agentclientprotocol/sdk` schema types.

## Release Baseline

This roadmap starts from the current `0.1.0` feature baseline:

- VS Code 1.120+ runtime target with proposed chat APIs.
- ACP-backed chat sessions for multiple agent CLIs.
- Shared MCP import from profile `mcp.json`, workspace `.vscode/mcp.json`, plugin MCP configs, and agent-local config.
- Session options for mode, model, and selected ACP config options.
- Plan rendering, permission risk hints, context-window usage hints, and ACP command completions triggered by `/`.

## Priority Overview

| Priority | Theme                                                   | Why now                                                         |
| -------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| P0       | Cost, stop reasons, session info, tool follow-along     | Highest UX payoff with low protocol risk                        |
| P1       | Session fork/resume and richer command UX               | Makes long-running ACP sessions easier to manage                |
| P2       | Embedded resources, image input, auth flows             | Unlocks higher-capability agents and better onboarding          |
| P3       | Request-level cancellation, annotations-aware rendering | Valuable, but lower urgency or higher implementation complexity |

## P0: Upgrade The Existing Session UX

### 1. Surface ACP cost tracking

**Goal**

- Show cumulative ACP session spend alongside context-window usage.

**Protocol basis**

- `Cost`
- `UsageUpdate.cost`

**Why it matters**

- Users can see whether a session is getting expensive before continuing.
- Maintainers can debug cost regressions across models or agents.

**Implementation steps**

1. Extend `src/acpDraftTypes.ts` usage payload handling beyond token counts.
2. Persist the latest cost amount and currency in `Session` state.
3. Render session cost in chat usage output and optionally a status line or footer.
4. Add threshold-based warnings for unusually expensive sessions.

**Acceptance criteria**

- When an agent emits `usage_update.cost`, the user can see the cumulative value in the chat UI.
- Missing `cost` remains a no-op.

### 2. Differentiate stop reasons in the UI

**Goal**

- Make ACP completions explain whether the turn ended normally, hit a limit, was cancelled, or was refused.

**Protocol basis**

- `StopReason = end_turn | max_tokens | max_turn_requests | refusal | cancelled`

**Why it matters**

- Users currently cannot tell whether they should retry, shorten the prompt, or change strategy.

**Implementation steps**

1. Add `stopReason` mapping in `src/acpChatParticipant.ts`.
2. Render targeted follow-up hints for `max_tokens`, `max_turn_requests`, `refusal`, and `cancelled`.
3. Keep the raw stop reason in logs for debugging.

**Acceptance criteria**

- The chat UI shows a reason-specific hint when a prompt does not end with `end_turn`.

### 3. Apply `session_info_update` to titles and timestamps

**Goal**

- Let the agent rename sessions dynamically and update last-activity metadata.

**Protocol basis**

- `SessionInfoUpdate.title`
- `SessionInfoUpdate.updatedAt`

**Why it matters**

- Session lists become more useful once the agent can replace the generic first-prompt title.

**Implementation steps**

1. Handle `session_info_update` in `src/acpChatParticipant.ts` or `src/acpSessionManager.ts`.
2. Sync the updated title and timestamp into the session item controller and SQLite state.
3. Prefer protocol-provided titles over prompt-derived fallback titles.

**Acceptance criteria**

- An ACP agent can rename a live session and the session picker reflects the new title.

### 4. Add tool follow-along

**Goal**

- Follow the file and line the agent is reading or editing in real time.

**Protocol basis**

- `ToolCallLocation`

**Why it matters**

- This is one of the clearest UX upgrades for long code-editing sessions.

**Implementation steps**

1. Preserve line information when converting `toolCallUpdate.locations` in `src/chatRenderingUtils.ts`.
2. Add an opt-in follow mode that reveals the current file and line in the editor.
3. Avoid aggressive focus-stealing by limiting auto-follow to active sessions and user opt-in.

**Acceptance criteria**

- When a tool call reports a location, the user can click or opt into following the working file directly.

## P1: Improve Session Control And Command UX

### 5. Add session fork/resume

**Goal**

- Support branching an ACP conversation and resuming native sessions without loading full history when the agent supports it.

**Protocol basis**

- `SessionCapabilities.fork`
- `SessionCapabilities.resume`
- `ForkSessionRequest/Response`
- `ResumeSessionRequest/Response`

**Why it matters**

- It reduces friction for exploring alternative solutions or reopening suspended work.

**Implementation steps**

1. Extend `AcpClient` with `forkSession()` and `resumeSession()`.
2. Detect capability support from `initialize` response.
3. Add chat/session commands for “Fork Session” and “Resume Session”.
4. Persist and label forked sessions clearly in SQLite.

**Acceptance criteria**

- Users can branch from a live ACP session without losing the original state.
- Resume-capable agents can reopen sessions even if full `loadSession` is unavailable.

### 6. Improve ACP command UX beyond completion-only

**Goal**

- Make `availableCommands` easier to discover and execute with syntax help.

**Protocol basis**

- `AvailableCommandsUpdate`
- `AvailableCommandInput.hint`

**Why it matters**

- The current `/` completion support is a good start, but command argument guidance is still shallow.

**Implementation steps**

1. Use `input.hint` as inline syntax help in completion items and in the `/?` list.
2. Refresh command completions when `available_commands_update` changes during a live session.
3. Add “click to insert command template” buttons for commands with known hints.

**Acceptance criteria**

- Users can discover new ACP commands added mid-session and see their expected argument shape.

## P2: Unlock Richer Inputs And Better Onboarding

### 7. Support embedded resources and image input

**Goal**

- Send richer context to agents that explicitly advertise support for it.

**Protocol basis**

- `PromptCapabilities.embeddedContext`
- `PromptCapabilities.image`
- `EmbeddedResource`
- `ImageContent`

**Why it matters**

- File references that are currently flattened into plain text lose structure and can force extra round-trips.

**Implementation steps**

1. Read `agentCapabilities.promptCapabilities` after initialization.
2. When `embeddedContext` is supported, convert appropriate references into `ContentBlock::Resource` instead of plain text.
3. When `image` is supported, allow image attachments or clipboard images to flow through as ACP image content.
4. Keep the current text-based fallback for agents without those capabilities.

**Acceptance criteria**

- Capable agents receive structured resource or image blocks.
- Incapable agents continue to work with the current text-only fallback.

### 8. Add auth onboarding for agents that advertise authentication methods

**Goal**

- Present agent-declared authentication choices instead of failing late or relying on undocumented setup.

**Protocol basis**

- `InitializeResponse.authMethods`
- `AuthMethod`

**Why it matters**

- This is necessary for a cleaner multi-agent ecosystem, especially if external ACP agents depend on user login or API-key setup.

**Implementation steps**

1. Store `authMethods` from initialize response.
2. Add a setup command or first-run prompt when an agent exposes auth methods.
3. Use VS Code secret storage for any persisted credentials.
4. Keep the authentication UI clearly separate from prompt execution.

**Acceptance criteria**

- Agents that require authentication can guide the user through a supported setup flow.

## P3: Lower-Priority Protocol Leverage

### 9. Request-level cancellation

**Goal**

- Allow finer-grained cancellation when ACP evolves beyond session-wide cancel behavior.

**Protocol basis**

- `CancelRequestNotification`

**Why it matters**

- This could eventually support cancelling a specific request or sub-flow without tearing down the whole session.

**Risk**

- High complexity and lower immediate user value than the items above.

### 10. Annotation-aware rendering

**Goal**

- Respect `Annotations` such as `priority`, `audience`, and `lastModified` in content rendering.

**Protocol basis**

- `Annotations`

**Why it matters**

- It can improve display ordering and context labeling, but the UX payoff is weaker than the higher-priority items.

## Recommended Execution Order

1. Release `0.1.0` as the current baseline.
2. Implement P0 as the next short cycle.
3. Implement session fork/resume as the anchor feature of the following cycle.
4. Add richer prompt content and auth onboarding only after P0/P1 are stable.

## Caveats

- VS Code chat still does not support runtime registration of true manifest slash commands, so ACP command UX will remain completion-driven unless the editor API changes.
- `usage_update`, `session/fork`, and `session/resume` are currently marked unstable in the ACP schema; guard these features by advertised capability support.
- Rich prompt blocks should remain capability-gated so existing text-only agents are not broken.
