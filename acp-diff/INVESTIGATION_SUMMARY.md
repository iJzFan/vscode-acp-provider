# ACP Diff/File-Change Rendering Investigation Summary

## Overview
The VS Code ACP Client extension has a complete implementation for parsing ACP tool call results and rendering file diffs/changes in chat. Below is the architectural flow and likely failure points.

## Core Implementation Files

### 1. **src/acpChatParticipant.ts** (Main Orchestrator)
- **Line 1054-1130**: `handleDiffToolContents()` — Core diff rendering function
  - Parses `update.content[]` array looking for entries with `type === "diff"`
  - For each diff: creates original/modified URIs via `createDiffUri()`
  - Stores diff content via `setDiffContent()`
  - Calls `stream.textEdit()` and `stream.workspaceEdit()` to render changes
  
- **Line 682-689**: Integration point in `renderSessionUpdate()`
  - Only calls `handleDiffToolContents()` if `handleFileEditToolCalls()` returns false
  - Triggered on `"tool_call_update"` with status `"completed"` or `"failed"`

### 2. **src/diffContentProvider.ts** (Virtual Filesystem Provider)
- Registers custom `acp-diff://` URI scheme (line 5)
- `DiffContentProvider` class: stores diff content in `Map<string, string>` (line 18)
- `createDiffUri()`: builds URIs with query params `side`, `toolCallId`, `index`
- `setDiffContent()`: stores content in the provider; fires `onDidChange` event

### 3. **src/chatRenderingUtils.ts** (Parsing & Utilities)
- **`buildDiffStats()`** (line 557-602): Calculates added/removed line counts via LCS algorithm
- **`resolveUri()`** (line 517-555): Resolves file paths to workspace URIs
- **`getToolInfo()`** (line 67-161): Extracts tool metadata from `ToolCall`/`ToolCallUpdate`
- **`toInlineDiff()`** (line 400-473): Generates unified diff format for markdown preview

### 4. **src/extension.ts** (Registration)
- **Line 68**: `registerDiffContentProvider(context)` called at activation
- Ensures diff provider is available before any tool results arrive

## Data Flow: Tool Result → Rendered Diff

```
1. ACP Server → ToolCallUpdate with content[].type === "diff"
2. acpChatParticipant.renderSessionUpdate() detects "tool_call_update"
3. handleFileEditToolCalls() checks if tool is "edit" type
   ├─ If true → externalEdit() route (editor-managed changes)
   └─ If false → fallthrough to handleDiffToolContents()
4. handleDiffToolContents() processes content array:
   ├─ Extracts: content.path, content.oldText, content.newText
   ├─ Calls resolveUri(content.path) → fileUri (workspace URI)
   ├─ Creates: originalUri, modifiedUri (acp-diff:// scheme URIs)
   ├─ Stores: setDiffContent() on both URIs
   ├─ Emits: stream.textEdit() and stream.workspaceEdit()
   └─ Index incremented per diff entry
```

## Likely Failure Points for "Implemented but Cannot See Diff"

### **Critical Path Failures**

1. **Missing or Empty `content` Array**
   - If `update.content` is null/undefined/empty → early return at line 1058
   - **Check**: Verify ACP server is actually returning diff content blocks

2. **Wrong Content Type**
   - If all content blocks have `type !== "diff"` → skips all entries (line 1066)
   - **Check**: Log `update.content[].type` values; should be `"diff"`

3. **Path Resolution Fails**
   - `resolveUri(content.path)` may throw → catch missing but unhandled
   - Paths may be absolute (e.g., `C:\Users\...`) but workspace root is undefined
   - **Check**: Ensure `currentWorkspaceRoot()` returns valid URI

4. **Diff Provider Not Registered**
   - If `registerDiffContentProvider()` not called or called after tool results
   - **Check**: Verify extension.ts line 68 executes before session starts

5. **Text Edit / Workspace Edit Failures**
   - `stream.textEdit()` or `stream.workspaceEdit()` may fail silently
   - No error handling for these calls (lines 1110-1126)
   - **Check**: Enable verbose logging in VS Code output channel

6. **External Editor Route Taken Instead**
   - `handleFileEditToolCalls()` returns `true` before diffs are processed
   - Happens if tool kind is `"edit"` or title is `"apply_patch"`
   - **Check**: Verify tool kind in logs; if `"edit"`, diffs are skipped

### **Secondary Failure Points**

7. **URI Scheme Not Recognized**
   - `acp-diff://` scheme may not be properly registered with VS Code
   - **Check**: View output channel for `registerTextDocumentContentProvider` warnings

8. **Async Content Storage Race**
   - `setDiffContent()` called but `provideTextDocumentContent()` queried before content stored
   - **Check**: Add instrumentation to `DiffContentProvider.setContent()` and `provideTextDocumentContent()`

9. **File URI Resolution Incorrect**
   - `resolveUri()` may resolve to wrong workspace path if multiple workspaces open
   - **Check**: Log resolved URI vs. expected file path

## Instrumentation Points to Add

```typescript
// In handleDiffToolContents():
console.log(`[DIFF] Processing ${update.content.length} content blocks`);
update.content.forEach((c, i) => {
  console.log(`[DIFF] Block ${i}: type="${c.type}", path="${c.path}", hasOld=${c.oldText !== undefined}, hasNew=${c.newText !== undefined}`);
});

// In DiffContentProvider.provideTextDocumentContent():
console.log(`[DIFF_PROVIDER] Query for ${uri.toString()}, found=${this.contents.has(uri.toString())}`);
```

## Related Files (Context Only)

- `src/turnBuilder.ts`: Alternate diff handling for chat session turn history
- `src/acpChatSessionContentProvider.ts`: Renders saved turns (may cache diff state)
