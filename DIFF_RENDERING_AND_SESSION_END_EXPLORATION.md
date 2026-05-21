# Exploration: Session End, Diff Rendering, and File Reveal Commands

**Generated:** 2026-05-20  
**Scope:** Full end-to-end flow for chat session completion, diff rendering, and file reveal mechanisms

---

## 1. Session End / Chat Completion Flow

### Entry Point: `acpChatParticipant.handleRequest()` (line 228)

After `session.client.prompt(sessionId, promptBlocks)` completes (line 346):

```
346: const result = await session.client.prompt(sessionId, promptBlocks);
347-349: [cancellation check]
351: this.renderFinalCumulativeDiff(response, session);  ◄─── KEY LINE
353: session.markAsCompleted();
359: this.sessionManager.syncSessionState(sessionResource, session);
```

### Session Completion States

- **Line 267**: `session.markAsCompleted()` after list-commands ("/?")
- **Line 338**: `session.markAsCompleted()` for empty prompts
- **Line 353**: `session.markAsCompleted()` after successful prompt execution
- **Line 369**: `session.markAsFailed()` on error

---

## 2. Final Cumulative Diff Rendering

### Core Method: `renderFinalCumulativeDiff()` (lines 1125-1137)

```typescript
private renderFinalCumulativeDiff(
  response: vscode.ChatResponseStream,
  session: Session,
): void {
  const diffPart = createToolDiffPart(
    this.sessionManager.getCumulativeToolDiffArtifacts(session.acpSessionId),
  );
  if (!diffPart) return;
  diffPart.title = "Modified files";
  response.push(diffPart);
}
```

### Data Flow

1. **Collection**: Diffs accumulated during session via `recordToolDiffArtifacts()`
2. **Storage**: `SessionManager.cumulativeToolDiffs: Map<sessionId, Map<key, ToolDiffArtifact>>`
3. **Retrieval**: `getCumulativeToolDiffArtifacts(sessionId)` returns array of artifacts
4. **Rendering**: `createToolDiffPart()` wraps artifacts in `ChatResponseMultiDiffPart`

### Why Diffs Are Sometimes Partial

**Recording occurs in `handleDiffToolContents()` (line 1115-1122)**:
- Called ONLY if `handleFileEditToolCalls()` returns false (line 747)
- `handleFileEditToolCalls()` returns true for `kind === "edit"` tools (line 1150)
- **Root cause**: When tool is "edit" type, diffs are NOT collected; external edit route taken instead

**Result**: Final cumulative diff at session end shows only non-external-edit diffs.

---

## 3. Diff Rendering During Tool Completion

### During Session Update Processing (line 609-753)

When tool completes (`"tool_call_update"` with status completed/failed):

```
705-743: Create ChatToolInvocationPart + push to response
743: renderToolFileSummary() → shows touched files
746: handleFileEditToolCalls() → if true, skip diffs
749: ELSE → handleDiffToolContents()
```

### `handleDiffToolContents()` Details (lines 1115-1123)

1. `collectToolDiffArtifacts(update, workspaceRoot)` → parse diff blocks
2. `sessionManager.recordToolDiffArtifacts()` → accumulate per session
3. `pushToolDiffPart()` → emit ChatResponseMultiDiffPart to stream immediately

---

## 4. File Reveal & Diff Commands

### Commands Registered (src/commands.ts)

| Command | Effect |
|---------|--------|
| `acp.insertChatText` | Opens chat, pre-fills query (line 17-22) |
| `acp.clearSessions` | Deletes all sessions from DB |
| `acp.requestPlanChanges` | Prompts user, opens chat with revision request |

### Diff URI Scheme (src/diffContentProvider.ts)

- **Scheme**: `acp-diff://`
- **Query params**: `side=original|modified&toolCallId=...&index=...`
- **Content provider**: Stores diffs in `Map<uri.toString(), content>`
- **Registration**: Line 44-50 in `extension.ts`

### File Reveal in Chat

- **goToFileUri**: Set in `createToolDiffPart()` via `artifact.fileUri`
- **VS Code integration**: Diff part has click handler to open actual file

---

## 5. Likely Causes of Inconsistent Full Diff Display

### A. External Edit Route Swallows Diffs
- If tool `kind === "edit"`, external editor callback tracks change
- Diff collection skipped: line 747 `if (!handled) { handleDiffToolContents() }`
- **Effect**: Final cumulative diff omits these files

### B. Content Block Type Mismatch
- If ACP server sends non-diff content types, iteration continues (line 1066)
- **Check**: Verify `content.type === "diff"` in each block

### C. Path Resolution Failures
- `resolveUri(content.path, workspaceRoot)` may fail silently or resolve incorrectly
- Workspace root undefined → relative paths fail
- **Impact**: Diffs exist but reference wrong files

### D. Provider Content Race
- `setDiffContent()` async with `provideTextDocumentContent()` query
- Content may not be stored when URI is queried
- **Mitigated by**: `_onDidChange.fire(uri)` event

### E. Multiple Diffs Overwrite Same File
- `mergeToolDiffArtifacts()` (diffRendering.ts:35-59) merges by file key
- Only final merged artifact appears in cumulative diff
- **Effect**: Intermediate edits lost in summary

---

## 6. Key Symbols & Locations

| Symbol | File | Lines | Purpose |
|--------|------|-------|---------|
| `renderSessionUpdate` | acpChatParticipant | 581 | Main update dispatcher |
| `renderFinalCumulativeDiff` | acpChatParticipant | 1125 | Session-end diff summary |
| `handleDiffToolContents` | acpChatParticipant | 1115 | Immediate diff rendering |
| `collectToolDiffArtifacts` | diffRendering | 61 | Parse ACP diff blocks |
| `recordToolDiffArtifacts` | acpSessionManager | 849 | Accumulate per session |
| `getCumulativeToolDiffArtifacts` | acpSessionManager | 868 | Retrieve final diffs |
| `createToolDiffPart` | diffRendering | 132 | Build ChatResponseMultiDiffPart |
| `DiffContentProvider` | diffContentProvider | 14 | Virtual filesystem for diffs |
| `createDiffUri` | diffContentProvider | 56 | Build acp-diff:// URIs |

---

## 7. End-to-End Request-Response Flow

```
User prompt (request)
  ↓
handleRequest() → buildPromptBlocks()
  ↓
session.client.prompt(sessionId, promptBlocks)
  ↓
[Async] onSessionUpdate(notification)
  ├─ tool_call → renderSessionUpdate() case
  │  └─ handleDiffToolContents() → collect & emit diffs
  └─ tool_call_update (completed) → collect & emit diffs
  ↓
[After prompt returns]
renderFinalCumulativeDiff() → emit cumulative diff part
  ↓
session.markAsCompleted()
  ↓
sessionManager.syncSessionState()
  ↓
[Chat UI reflects all rendered parts + final diff summary]
```

---

**Conclusion**: Inconsistent full diffs stem from the **edit vs. diff routing decision** (line 747) and **artifact merging by file key** (diffRendering.ts:122-125). External edits bypass collection; multiple edits to same file merge instead of accumulate.
