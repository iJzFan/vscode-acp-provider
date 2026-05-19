# Reference Init Diff

Last updated: 2026-05-14
Reference repo: `g:\acp\vscode_acp_provider`
Target repo: `g:\vscode-acp-provider-main`
Scope: chat session initialization only.

## Compared Files

### `src/extension.ts`
- Current repo adds runtime requirement guards, session disposal handling, session syncer wiring, and passes `globalStorageUri` / `sessionSyncer` into `createAcpSessionManager`.
- Reference repo creates a larger service graph up front, awaits `createSessionDb`, and registers `ChatSessionItemProvider` directly.
- Relevance: likely relevant.
- Current anchors: `src/extension.ts` around agent registration and session item registration.
- Reference anchors: `src/extension.ts` around `registerAgents()` and `registerChatSessionItemProvider()`.

### `src/acpSessionManager.ts`
- Current repo still differs materially from reference: extra MCP/profile/plugin bootstrap, session syncer integration, current mode/model events, usage reporting, and thought-level options.
- Both repos now share probe-session discovery/reuse, but current repo still has more initialization branches and side effects.
- Relevance: highly relevant.
- Current anchors: `createOrGet()`, `getOptions()`, `getSessionMcpServers()`.
- Reference anchors: `createOrGet()`, `getOptions()`, `readThinkingSettings()`.

### `src/acpChatSessionContentProvider.ts`
- Current repo exposes dynamic thought-level options and mode/model update events.
- Reference repo exposes simpler mode/model/thinking options and a thinner constructor.
- Relevance: maybe relevant.
- Current anchors: `provideChatSessionContent()`, `buildOptionsGroup()`, `provideHandleOptionsChange()`.
- Reference anchors: same methods in the reference repo.

### `src/chatIdentifiers.ts`
- Functional logic is aligned: untitled resources are normalized to `untitled`.
- Relevance: unlikely relevant.

### `src/acpChatSessionItemProvider.ts`
- Current repo has now been aligned back to the reference provider shape: `onDidCommitChatSessionItem` fires based on `original.vscodeResource` vs `modified.vscodeResource` only.
- Relevance: was highly relevant; now aligned.

### `src/acpChatParticipant.ts`
- Current repo still differs from reference in a critical way:
  - Current: if `getActive(sessionResource)` misses, it immediately errors.
  - Reference: if `getActive(sessionResource)` misses, it calls `createOrGet(sessionResource)` and recovers.
- Relevance: highly relevant.
- Current anchors: `handleRequest()` session lookup block.
- Reference anchors: `handleRequest()` session lookup block with `createOrGet()` fallback.

## Ranked Remaining Differences

1. `src/acpSessionManager.ts`
Current initialization path still contains more side effects than the reference implementation.

2. `src/acpChatParticipant.ts`
Current request path still does not recover when `getActive()` misses.

3. `src/extension.ts`
Current activation/register path still differs from reference around agent/session infrastructure setup.

## Suggested Order

1. Align `src/acpChatParticipant.ts` session lookup with reference.
2. Continue reducing `src/acpSessionManager.ts` initialization differences one slice at a time.
3. Only after that, revisit any remaining `extension.ts` registration differences.
