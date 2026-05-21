# Appendix: Code Structures & Data Flows

---

## A. ToolDiffArtifact Structure (diffRendering.ts:10-21)

```typescript
export type ToolDiffArtifact = {
  fileUri: vscode.Uri;              // Target file (file:// scheme)
  originalUri?: vscode.Uri;         // acp-diff://...?side=original (if hasOriginal)
  modifiedUri?: vscode.Uri;         // acp-diff://...?side=modified (if hasModified)
  added: number;                    // Line count added
  removed: number;                  // Line count removed
  hasOriginal: boolean;             // content.oldText !== undefined
  hasModified: boolean;             // content.newText !== undefined
  isDeletion: boolean;              // hasOriginal && !hasModified
  oldText: string;                  // Full original file text
  newText: string;                  // Full modified file text
};
```

**Merging Logic** (lines 35-59):
- When same file updated again, `mergeToolDiffArtifacts()` called
- Preserves original `oldText` but updates `newText` to latest
- Result: Only final state visible in cumulative diff

---

## B. SessionManager Diff Storage (acpSessionManager.ts:286)

```typescript
private cumulativeToolDiffs = new Map<string, Map<string, ToolDiffArtifact>>();
```

**Structure**:
```
sessionId → {
  "file:c:\\path\\to\\file.ts" → ToolDiffArtifact { fileUri, added, removed, ... },
  "file:c:\\path\\to\\other.py" → ToolDiffArtifact { ... },
  ...
}
```

**Key Normalization** (diffRendering.ts:23-33):
```typescript
function getToolDiffArtifactKey(fileUri: vscode.Uri): string {
  if (fileUri.scheme === "file") {
    const normalizedPath = path.normalize(fileUri.fsPath || fileUri.path);
    const canonicalPath = process.platform === "win32"
      ? normalizedPath.toLowerCase()
      : normalizedPath;
    return `file:${canonicalPath}`;
  }
  return `${fileUri.scheme}:${fileUri.path}`;
}
```

---

## C. DiffURI Format (diffContentProvider.ts:56-66)

**URI template**: `acp-diff://{fileUri}?side={side}&toolCallId={toolCallId}&index={index}`

**Example**:
```
acp-diff://c:/Users/dev/project/src/main.ts?side=original&toolCallId=tool_123&index=0
acp-diff://c:/Users/dev/project/src/main.ts?side=modified&toolCallId=tool_123&index=0
```

**Content Provider** (lines 24-31):
```typescript
provideTextDocumentContent(uri: vscode.Uri): string | undefined {
  return this.contents.get(uri.toString());
}

setContent(uri: vscode.Uri, content: string): void {
  this.contents.set(uri.toString(), content);
  this._onDidChange.fire(uri);  // Notify VS Code
}
```

---

## D. ChatResponseMultiDiffPart Creation (diffRendering.ts:132-151)

```typescript
export function createToolDiffPart(
  artifacts: readonly ToolDiffArtifact[],
  readOnly = false,
): vscode.ChatResponseMultiDiffPart | undefined {
  if (!artifacts.length) return undefined;

  return new vscode.ChatResponseMultiDiffPart(
    artifacts.map((artifact) => ({
      originalUri: artifact.originalUri,
      modifiedUri: artifact.modifiedUri,
      goToFileUri: artifact.fileUri,        // Click opens actual file
      added: artifact.added,
      removed: artifact.removed,
    })),
    vscode.l10n.t("File edits"),
    readOnly,
  );
}
```

---

## E. Recording Flow (acpSessionManager.ts:849-866)

```typescript
recordToolDiffArtifacts(
  sessionId: string,
  artifacts: readonly ToolDiffArtifact[],
): void {
  let sessionMap = this.cumulativeToolDiffs.get(sessionId);
  if (!sessionMap) {
    sessionMap = new Map();
    this.cumulativeToolDiffs.set(sessionId, sessionMap);
  }
  for (const artifact of artifacts) {
    const key = getToolDiffArtifactKey(artifact.fileUri);
    const existing = sessionMap.get(key);
    sessionMap.set(
      key,
      existing ? mergeToolDiffArtifacts(existing, artifact) : artifact,
    );
  }
}
```

**Key Point**: If same file processed twice, `mergeToolDiffArtifacts()` runs.

---

## F. External Edit Route (acpChatParticipant.ts:1139-1196)

Tool completion triggers:
1. **Check external edit** (line 746): `handleFileEditToolCalls(info, update, response)`
   - If `kind === "edit"` → returns true
   - Calls `stream.externalEdit(r, callback)` for each resource
2. **If NOT handled** (line 747): `if (!handled) { handleDiffToolContents(...) }`
   - Diffs only collected if external edit was skipped

**Why diffs partial**: External edits (live file changes) bypass diff collection. Final summary omits them.

---

## G. Diff Content Collection (acpChatParticipant.ts:1115-1122)

```typescript
private handleDiffToolContents(
  update: ToolCallUpdate,
  stream: vscode.ChatResponseStream,
  session: Session,
): void {
  const diffArtifacts = collectToolDiffArtifacts(update, currentWorkspaceRoot());
  this.sessionManager.recordToolDiffArtifacts(session.acpSessionId, diffArtifacts);
  pushToolDiffPart(stream, diffArtifacts);  // Emit immediately during session
}
```

---

## H. Final Cumulative Diff Push (acpChatParticipant.ts:1125-1137)

Called **after** `session.client.prompt()` returns (line 351):

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

**Timing**: At session completion, **not** during streaming.

---

## I. Chat Response Stream Integration

Two diff rendering paths:

1. **During tool completion** (immediate):
   - `pushToolDiffPart(stream, diffArtifacts)` via `handleDiffToolContents()`
   - Per-tool diff shown as tool finishes

2. **At session end** (deferred):
   - `response.push(diffPart)` via `renderFinalCumulativeDiff()`
   - Cumulative summary of all diffs in session

---

## J. Workspace Root Resolution (chatRenderingUtils.ts:545-583)

Path resolution order:
1. Check explicit URI scheme → parse
2. Normalize and check Windows drive
3. Resolve as workspace-relative path
4. Fall back to CWD-relative path

**Critical**: If `currentWorkspaceRoot()` undefined, relative paths fail.

