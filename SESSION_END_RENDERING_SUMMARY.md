# Session End & Diff Rendering: Complete Visual Summary

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ CHAT REQUEST (acpChatParticipant.handleRequest)                 │
├─────────────────────────────────────────────────────────────────┤
│ session.client.prompt(sessionId, promptBlocks)                  │
│   ↓ (async)                                                      │
│   [Many SessionNotifications emitted]                            │
│   ├─ tool_call: renderSessionUpdate() → toolInvocation starts   │
│   └─ tool_call_update (completed):                             │
│       ├─ handleFileEditToolCalls() → external edit OR           │
│       └─ handleDiffToolContents() → record + emit diff          │
│   ↓ (after prompt returns)                                      │
│ renderFinalCumulativeDiff()  ◄─── KEY SESSION-END HANDLER       │
│   ↓                                                              │
│ session.markAsCompleted()                                       │
│   ↓                                                              │
│ [Chat shows all tool results + FINAL DIFF SUMMARY]             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Diff Handling Decision Tree

```
Tool completes (tool_call_update, status=completed)
│
└─ Is kind === "edit"?
   │
   ├─ YES → handleFileEditToolCalls()
   │        ├─ Call stream.externalEdit(fileUri, callback)
   │        └─ Return true (skip diff collection)
   │           → Diffs NOT recorded for cumulative summary
   │
   └─ NO → handleFileEditToolCalls() returns false
           └─ handleDiffToolContents()
              ├─ collectToolDiffArtifacts(update)
              ├─ recordToolDiffArtifacts()
              │  └─ Merge into sessionManager.cumulativeToolDiffs
              ├─ pushToolDiffPart()
              │  └─ Emit ChatResponseMultiDiffPart immediately
              └─ Diffs RECORDED for cumulative summary
```

**Result**: External edits visible in editor but absent from session summary.

---

## Cumulative Diff Artifact Map

```
SessionManager.cumulativeToolDiffs
│
├─ sessionId_1
│  └─ Map {
│     "file:c:\\project\\main.ts" → ToolDiffArtifact {
│        fileUri, originalUri, modifiedUri,
│        added: 5, removed: 2,
│        hasOriginal: true, hasModified: true,
│        oldText: "...", newText: "..."
│     },
│     "file:c:\\project\\utils.py" → ToolDiffArtifact { ... }
│  }
│
└─ sessionId_2
   └─ Map { ... }
```

**Key normalization**: Windows lowercase, Unix as-is (diffRendering.ts:26-28)

---

## Session Completion Sequence

```
1. session.client.prompt() returns
   → ToolCallUpdates all processed by renderSessionUpdate()
   → onSessionUpdate subscription resolves

2. renderFinalCumulativeDiff(response, session) [LINE 351]
   a. this.sessionManager.getCumulativeToolDiffArtifacts(sessionId)
      ↓
      Returns Array<ToolDiffArtifact> from cumulativeToolDiffs map
      ↓
   b. createToolDiffPart(artifacts)
      ↓
      Wraps in vscode.ChatResponseMultiDiffPart
      ↓
   c. response.push(diffPart)
      ↓
      Emits to chat stream
      ↓
   [VS Code renders as "Modified files" section at end of response]

3. session.markAsCompleted() [LINE 353]
   ↓ Updates ChatSessionStatus to Completed

4. sessionManager.syncSessionState() [LINE 359]
   ↓ Fire _onDidChangeSession event
   ↓ LifecycledChatSessionItemController syncs to SQLite
   ↓ Chat session visible in sidebar as "Completed"
```

---

## File Reveal Mechanisms

### Mechanism 1: Diff Part Click
- **What**: User clicks file in diff summary
- **Handler**: VS Code built-in to ChatResponseMultiDiffPart
- **Target**: `goToFileUri: artifact.fileUri`
- **Action**: Opens file in editor

### Mechanism 2: Command Links (Unused for Diffs)
- **Command**: `acp.insertChatText`
- **Use**: Plan action buttons (line 972-986)
- **Format**: `[label](command:acp.insertChatText?${encoded})`
- **Action**: Pre-fills chat, doesn't send

### Mechanism 3: External Edit Callbacks
- **Triggered**: During tool execution if `kind === "edit"`
- **Mechanism**: `stream.externalEdit(fileUri, callback)`
- **Behavior**: VS Code opens file in editor for user to apply
- **Completion**: Callback fires when user confirms

---

## Why Diffs Appear Partial or Full

### Full Display Conditions ✓
- All tool results include `content[].type === "diff"` blocks
- All tools NOT using external edit route
- Same file NOT edited multiple times (or merge acceptable)
- ACP server sends complete oldText/newText

### Partial Display Conditions ⚠
- Some tools use external edit (`kind === "edit"`) → omitted from final summary
- Some content blocks have `type !== "diff"` → skipped
- Same file edited twice → only final state visible (merged)
- Workspace root undefined → path resolution fails

### No Display Conditions ✗
- ACP server sends no content blocks → early return line 1066
- Diff provider not registered → URIs exist but no content
- Session error/cancel → no final diff rendered

---

## Data Structures Used

| Structure | Location | Purpose |
|-----------|----------|---------|
| `ToolDiffArtifact` | diffRendering.ts:10 | Single file diff |
| `cumulativeToolDiffs` | acpSessionManager.ts:286 | Per-session map |
| `ChatResponseMultiDiffPart` | vscode API | Final UI element |
| `DiffContentProvider` | diffContentProvider.ts:14 | acp-diff:// URIs |
| `acp-diff` URI scheme | diffContentProvider.ts:5 | Virtual filesystem |

---

## Critical Lines of Code

| Feature | File | Line(s) | Details |
|---------|------|---------|---------|
| Session end | acpChatParticipant | 346-359 | Prompt completion + final diff |
| Final diff render | acpChatParticipant | 1125-1137 | renderFinalCumulativeDiff() |
| Immediate diff | acpChatParticipant | 1115-1123 | handleDiffToolContents() |
| Routing decision | acpChatParticipant | 747 | External edit vs diff |
| Recording | acpSessionManager | 849-866 | recordToolDiffArtifacts() |
| Retrieval | acpSessionManager | 868-874 | getCumulativeToolDiffArtifacts() |
| Provider register | extension | 68 | registerDiffContentProvider() |
| Merging | diffRendering | 35-59 | mergeToolDiffArtifacts() |

---

**Conclusion**: Session end triggers `renderFinalCumulativeDiff()` which retrieves all accumulated non-external-edit diffs from the session's cumulative map and emits them as a final "Modified files" part. Inconsistency arises from the external-edit vs. diff-content routing decision and per-file artifact merging.
