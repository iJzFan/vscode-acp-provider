# ACP Diff Rendering Flow Diagram

## Complete Request-to-Render Pipeline

```
┌─────────────────────────────────────────────────────────────────────────┐
│ EXTENSION ACTIVATION (extension.ts:54-96)                              │
├─────────────────────────────────────────────────────────────────────────┤
│ 1. activate()                                                           │
│    ├─ createOutputChannel("ACP Client")                                │
│    ├─ registerDiffContentProvider(context)  ◄─── CRITICAL: Line 68    │
│    ├─ createSessionDb(context)                                         │
│    ├─ registerAgents() with chat participants                          │
│    └─ registerCommands(context)                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ USER SENDS PROMPT (acpChatParticipant.ts:219-380)                      │
├─────────────────────────────────────────────────────────────────────────┤
│ handleRequest() → buildPromptBlocks() → session.client.prompt()        │
│ ✓ Creates onSessionUpdate subscription (line 285)                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ ACP SERVER SENDS UPDATES (async subscription)                          │
├─────────────────────────────────────────────────────────────────────────┤
│ SessionNotification.update.sessionUpdate cases:                        │
│   • "agent_message_chunk"                                              │
│   • "agent_thought_chunk"                                              │
│   • "tool_call"              ◄─── Tool starts                          │
│   • "tool_call_update"       ◄─── Tool completes/fails [KEY POINT]    │
│   • "plan"                                                              │
│   • "usage_update"                                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ RENDER SESSION UPDATE (acpChatParticipant.ts:520-725)                  │
├─────────────────────────────────────────────────────────────────────────┤
│ renderSessionUpdate(notification, response, session)                   │
│ switch(update.sessionUpdate):                                          │
│   case "tool_call_update": ◄─── TARGET CASE                           │
│     ├─ Line 682: renderToolFileSummary() → display file list         │
│     ├─ Line 685: handleFileEditToolCalls(info, update, response)      │
│     │             Returns true if tool.kind === "edit" → SKIP DIFFS   │
│     │             [FAILURE POINT #6]                                  │
│     │                                                                  │
│     └─ Line 688: IF NOT handled by externalEdit:                      │
│                  handleDiffToolContents(update, response) ◄─── MAIN   │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PARSE & RENDER DIFFS (acpChatParticipant.ts:1054-1130)                 │
├─────────────────────────────────────────────────────────────────────────┤
│ handleDiffToolContents(update, stream):                                │
│                                                                        │
│ 1. Guard: if (!update.content?.length) return  [FAILURE #1]          │
│                                                                        │
│ 2. For each content block:                                            │
│    if (content.type !== "diff") continue  [FAILURE #2]               │
│                                                                        │
│ 3. Extract metadata:                                                   │
│    • oldText = content.oldText ?? ""                                  │
│    • newText = content.newText ?? ""                                  │
│    • hasOriginal = content.oldText !== undefined                      │
│    • hasModified = content.newText !== undefined                      │
│    • isDeletion = hasOriginal && (!newText || newText === "")        │
│                                                                        │
│ 4. Resolve file path:                                                  │
│    fileUri = resolveUri(content.path, workspaceRoot)                 │
│    [FAILURE #3, #9]                                                   │
│                                                                        │
│ 5. Create diff URIs (acp-diff:// scheme):                             │
│    originalUri = createDiffUri({                                      │
│      side: "original",                                                 │
│      toolCallId: update.toolCallId,                                   │
│      fileUri,                                                          │
│      index: diffIndex                                                 │
│    })                                                                  │
│    modifiedUri = createDiffUri({side: "modified", ...})               │
│                                                                        │
│ 6. Store content in provider:                                         │
│    setDiffContent(originalUri, oldText)   [FAILURE #8]               │
│    setDiffContent(modifiedUri, newText)                               │
│                                                                        │
│ 7. Build diff stats:                                                   │
│    buildDiffStats(oldText, newText)  → {added, removed}              │
│                                                                        │
│ 8. Emit VS Code chat stream updates:                                  │
│    if (hasOriginal && hasModified && !isDeletion):                   │
│      stream.textEdit(fileUri, TextEdit.replace(...))                 │
│      stream.textEdit(fileUri, true)  ◄─── Confirm edit               │
│    else if (!hasOriginal && hasModified):                            │
│      stream.workspaceEdit([{newResource: fileUri}])                  │
│      stream.textEdit(fileUri, TextEdit.insert(...))                  │
│    else if (isDeletion):                                             │
│      stream.workspaceEdit([{oldResource: fileUri}])                  │
│    [FAILURE #5]                                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ DIFF CONTENT PROVIDER (diffContentProvider.ts)                        │
├─────────────────────────────────────────────────────────────────────────┤
│ DiffContentProvider extends TextDocumentContentProvider               │
│   • contents: Map<uri.toString(), content>                             │
│                                                                        │
│ provideTextDocumentContent(uri):                                      │
│   return this.contents.get(uri.toString())   [FAILURE #4, #8]        │
│                                                                        │
│ setContent(uri, content):                                             │
│   this.contents.set(uri.toString(), content)                          │
│   this._onDidChange.fire(uri)  ◄─── Notifies VS Code                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ VS CODE RENDERS DIFF IN CHAT                                           │
├─────────────────────────────────────────────────────────────────────────┤
│ chat.ChatResponseDiffEntry {                                           │
│   originalUri: acp-diff://...?side=original&...                       │
│   modifiedUri: acp-diff://...?side=modified&...                       │
│   goToFileUri: file://path/to/actual/file                             │
│   added: number                                                         │
│   removed: number                                                       │
│ }                                                                       │
│                                                                        │
│ + TextEdit and WorkspaceEdit commands staged for user acceptance      │
└─────────────────────────────────────────────────────────────────────────┘
```

## Critical Decision Points

| Condition | Outcome | Failure Point |
|-----------|---------|---------------|
| `update.content` empty/null | Return early (no diff shown) | #1 |
| No content with `type: "diff"` | Skip to next iteration | #2 |
| `resolveUri()` fails or returns wrong path | File diff references wrong location | #3 |
| `registerDiffContentProvider()` not called | URIs registered but no content provided | #4 |
| `stream.textEdit()` / `workspaceEdit()` fails | Silent failure, no chat UI indication | #5 |
| `handleFileEditToolCalls()` returns true | Skip diff handling entirely | #6 |
| Provider not available when content queried | Diff URIs exist but no content | #8 |
| Multi-workspace resolution ambiguous | Diff shows for wrong workspace file | #9 |

## Key Entry Points for Debugging

1. **acpChatParticipant.ts:1054** — `handleDiffToolContents()` start
2. **acpChatParticipant.ts:1065** — Content type check
3. **diffContentProvider.ts:24** — Content retrieval
4. **chatRenderingUtils.ts:517** — URI resolution
5. **extension.ts:68** — Provider registration
