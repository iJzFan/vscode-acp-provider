# Code Reference Quick Lookup

## File Organization

| File | Purpose | Key Functions/Classes |
|------|---------|----------------------|
| `src/extension.ts` | Activation & registration | `activate()`, `registerDiffContentProvider()` |
| `src/acpChatParticipant.ts` | Chat participant & rendering | `handleRequest()`, `renderSessionUpdate()`, `handleDiffToolContents()` |
| `src/diffContentProvider.ts` | Virtual URI provider | `DiffContentProvider`, `createDiffUri()`, `setDiffContent()` |
| `src/chatRenderingUtils.ts` | Parsing & utilities | `resolveUri()`, `buildDiffStats()`, `getToolInfo()`, `toInlineDiff()` |
| `src/turnBuilder.ts` | Session turn building | TurnBuilder class (alternate diff path for history) |

## Function Call Chain: Diff Rendering

```
extension.activate()
  └─ registerDiffContentProvider(context)
       └─ DiffContentProvider.register() [acp-diff:// scheme]

handleRequest(request, context, response)
  └─ session.client.prompt() [async]
       └─ onSessionUpdate(notification)
            └─ renderSessionUpdate(notification, response, session)
                 └─ case "tool_call_update":
                      ├─ renderToolFileSummary(response, update, info)
                      ├─ handleFileEditToolCalls(info, update, response)
                      └─ handleDiffToolContents(update, response)
                           ├─ resolveUri(content.path, workspaceRoot)
                           ├─ createDiffUri({side, toolCallId, fileUri, index})
                           ├─ setDiffContent(uri, text)
                           └─ stream.textEdit() / stream.workspaceEdit()
```

## Important Type Signatures

```typescript
// ToolCallUpdate structure (from @agentclientprotocol/sdk)
interface ToolCallUpdate {
  toolCallId: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  title?: string;
  kind?: ToolKind;
  content?: ContentBlock[];      // ◄─── Contains diffs
  rawInput?: unknown;
  rawOutput?: unknown;
}

// Diff ContentBlock structure
interface ContentBlock {
  type: "diff" | "content" | "text" | ...;
  path: string;                  // File path
  oldText?: string;              // Original content (undefined = new file)
  newText?: string;              // Modified content (undefined = deleted)
}

// ChatResponseDiffEntry (VS Code proposed API)
interface ChatResponseDiffEntry {
  originalUri?: vscode.Uri;      // acp-diff://...?side=original
  modifiedUri?: vscode.Uri;      // acp-diff://...?side=modified
  goToFileUri: vscode.Uri;       // Actual workspace file
  added: number;                 // Line count
  removed: number;               // Line count
}
```

## Quick Debug Checklist

### Pre-Flight Check
- [ ] `registerDiffContentProvider()` called in `extension.ts:68`
- [ ] No activation errors in Output channel
- [ ] `ACP_DIFF_SCHEME = "acp-diff"` matches URI scheme in provider

### Data Flow Check
- [ ] Tool result `update.content` is non-empty array
- [ ] At least one content block has `type: "diff"`
- [ ] `content.path` is not empty
- [ ] `content.oldText` and/or `content.newText` are non-empty strings

### Resolution Check
- [ ] `currentWorkspaceRoot()` returns valid `vscode.Uri`
- [ ] `resolveUri(content.path, root)` produces expected file path
- [ ] File URI scheme is `file://` not `acp-diff://`

### Tool Kind Check
- [ ] `info.kind` is NOT `"edit"` (would trigger external editor route)
- [ ] Tool title is NOT `"apply_patch"` (special case handling)

### VS Code API Check
- [ ] `stream.textEdit()` doesn't throw (wraps in try-catch if suspicious)
- [ ] `stream.workspaceEdit()` doesn't throw
- [ ] `ChatResponseDiffEntry` type available in VS Code API

## Logging Points to Enable

```typescript
// In handleDiffToolContents (line ~1060):
this.logger.info(
  `[DIFF] Processing ${update.content?.length ?? 0} content blocks ` +
  `for toolCall ${update.toolCallId}`
);
update.content?.forEach((c, idx) => {
  if (c.type === "diff") {
    this.logger.info(
      `[DIFF] Block ${idx}: ${c.path} ` +
      `(old=${c.oldText ? "✓" : "✗"}, new=${c.newText ? "✓" : "✗"})`
    );
  }
});

// In DiffContentProvider.setContent (diffContentProvider.ts:28):
console.log(`[DCP] Stored content for ${uri.toString()}: ${content.length} bytes`);

// In DiffContentProvider.provideTextDocumentContent (line 24):
const result = this.contents.get(uri.toString());
console.log(`[DCP] Query ${uri.toString()}: ${result ? "HIT" : "MISS"}`);
return result;
```

## Test Scenarios

### Scenario 1: File Modification
```
oldText: "line 1\nline 2\n"
newText: "line 1\nmodified\n"
Expected: Diff view with line 2 highlighted
Expected stats: added=1, removed=1
```

### Scenario 2: File Creation
```
oldText: undefined
newText: "new content\n"
Expected: "+" icons, green highlighting
Expected stats: added=1, removed=0
Expected call: stream.workspaceEdit([{newResource}])
```

### Scenario 3: File Deletion
```
oldText: "deleted content\n"
newText: undefined (or "")
Expected: "-" icons, red highlighting
Expected stats: added=0, removed=1
Expected call: stream.workspaceEdit([{oldResource}])
```

## Related Documentation

- **ACP Client Review**: `acp-diff-plugin-review.md` (extension hotfix context)
- **Architecture Doc**: `docs/codebase-knowledge.md` (if exists)
- **VS Code Chat API**: https://code.visualstudio.com/api/references/vscode-api#ChatResponseStream
- **ACP Protocol**: https://agentclientprotocol.com/protocol/schema
