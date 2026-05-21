# Instrumentation & Verification Guide

---

## Verification Checklist: Why Diffs Are Partial/Missing

Use this checklist to diagnose incomplete diff display at session end.

### 1. **Check: Diffs Collected During Session?**

Add logging to `acpChatParticipant.handleDiffToolContents()` (line 1115):

```typescript
private handleDiffToolContents(
  update: ToolCallUpdate,
  stream: vscode.ChatResponseStream,
  session: Session,
): void {
  const diffArtifacts = collectToolDiffArtifacts(update, currentWorkspaceRoot());
  console.log(`[DIFF] Tool ${update.toolCallId}: ${diffArtifacts.length} artifacts collected`);
  diffArtifacts.forEach((art, i) => {
    console.log(`  [${i}] ${art.fileUri.fsPath}: +${art.added} -${art.removed}`);
  });
  this.sessionManager.recordToolDiffArtifacts(session.acpSessionId, diffArtifacts);
  // ... rest
}
```

**Expect**: Log entry for each tool completion with diff count.

**If missing**: Check if `handleFileEditToolCalls()` returned true (line 746).

---

### 2. **Check: Artifacts Recorded in Session Manager?**

Add logging to `acpSessionManager.recordToolDiffArtifacts()` (line 849):

```typescript
recordToolDiffArtifacts(
  sessionId: string,
  artifacts: readonly ToolDiffArtifact[],
): void {
  console.log(`[SESSION_DIFF] Recording ${artifacts.length} artifacts for session ${sessionId}`);
  let sessionMap = this.cumulativeToolDiffs.get(sessionId);
  // ... rest of method
  console.log(`[SESSION_DIFF] Total unique files after recording: ${sessionMap.size}`);
}
```

**Expect**: Log shows artifacts being recorded and map size growing.

---

### 3. **Check: Final Diff Retrieved at Session End?**

Add logging to `renderFinalCumulativeDiff()` (line 1125):

```typescript
private renderFinalCumulativeDiff(
  response: vscode.ChatResponseStream,
  session: Session,
): void {
  const artifacts = this.sessionManager.getCumulativeToolDiffArtifacts(
    session.acpSessionId,
  );
  console.log(`[FINAL_DIFF] Session ${session.acpSessionId}: ${artifacts.length} artifacts to render`);
  artifacts.forEach((art) => {
    console.log(`  - ${art.fileUri.fsPath}: +${art.added} -${art.removed}`);
  });
  const diffPart = createToolDiffPart(artifacts);
  // ... rest
}
```

**Expect**: Log shows all accumulated artifacts.

**If missing**: Check if `getCumulativeToolDiffArtifacts()` returns empty array.

---

### 4. **Check: External Edit Route Taken Instead?**

Add logging to `handleFileEditToolCalls()` (line 1139):

```typescript
private handleFileEditToolCalls(
  info: ToolInfo,
  data: ToolCall | ToolCallUpdate,
  stream: vscode.ChatResponseStream,
): boolean {
  if (data.status === "pending" || data.status === "in_progress") {
    if (info.kind === "edit") {
      console.log(`[EXTERNAL_EDIT] Tool ${data.toolCallId} routed to external editor`);
      // ... rest
      return true;
    }
  }
  return false;
}
```

**Expect**: No log for non-edit tools.

**If seen**: Tool bypasses diff collection; verify this is intended.

---

### 5. **Check: Content Block Types**

Add logging to `collectToolDiffArtifacts()` (diffRendering.ts:61):

```typescript
export function collectToolDiffArtifacts(
  update: DiffToolUpdate,
  workspaceRoot: vscode.Uri | undefined,
): ToolDiffArtifact[] {
  if (!update.content?.length) {
    console.log(`[COLLECT] No content blocks in tool ${update.toolCallId}`);
    return [];
  }

  console.log(`[COLLECT] Tool ${update.toolCallId}: ${update.content.length} content blocks`);
  const artifactsByKey = new Map<string, ToolDiffArtifact>();
  let diffIndex = 0;
  for (const content of update.content) {
    console.log(`  [${diffIndex}] type="${content.type}", path="${content.path}"`);
    if (content.type !== "diff") {
      console.log(`    → Skipped (not "diff" type)`);
      continue;
    }
    // ... rest of loop
  }
  // ... rest
}
```

**Expect**: Logs show content block types; only "diff" type processed.

**If non-diff seen**: ACP server sending non-diff content; expected.

---

### 6. **Check: Artifact Merging**

Add logging to `mergeToolDiffArtifacts()` (diffRendering.ts:35):

```typescript
export function mergeToolDiffArtifacts(
  existing: ToolDiffArtifact,
  incoming: ToolDiffArtifact,
): ToolDiffArtifact {
  console.log(`[MERGE] File ${existing.fileUri.fsPath}: merging edits`);
  console.log(`  Existing: old=${existing.oldText.length}b, new=${existing.newText.length}b`);
  console.log(`  Incoming: old=${incoming.oldText.length}b, new=${incoming.newText.length}b`);
  // ... rest
  const merged = { /* ... */ };
  console.log(`  Result: old=${merged.oldText.length}b, new=${merged.newText.length}b`);
  return merged;
}
```

**Expect**: No logs unless same file edited twice.

**If seen**: Intermediate edits overwritten; verify final state is correct.

---

### 7. **Check: Workspace Root Resolution**

Add logging to `resolveUri()` (chatRenderingUtils.ts:545):

```typescript
export function resolveUri(
  inputPath: string,
  workspaceRoot: vscode.Uri | undefined,
): vscode.Uri {
  const raw = (inputPath ?? "").trim();
  console.log(`[RESOLVE] Input: "${raw}", workspaceRoot: ${workspaceRoot?.fsPath}`);
  // ... rest of method
  const result = /* resolved URI */;
  console.log(`  → Resolved to: ${result.fsPath}`);
  return result;
}
```

**Expect**: Paths resolve to correct workspace files.

**If wrong path**: Check workspace root vs. input path.

---

### 8. **Test Scenario: Simple Code Edit**

**Setup**:
1. Open untitled chat session
2. Send prompt: "Create a file hello.ts with one line"
3. Expect: ACP creates file, sends diff
4. Check: Final cumulative diff shows the file

**Verify logging**:
- `[DIFF]` shows 1 artifact
- `[SESSION_DIFF]` shows recorded
- `[FINAL_DIFF]` shows retrieved
- Chat shows "Modified files" section

---

### 9. **Test Scenario: Edit Kind Bypass**

**Setup**:
1. If ACP tool has `kind: "edit"`
2. Tool applies changes
3. Check: Diffs NOT in final summary

**Verify logging**:
- `[EXTERNAL_EDIT]` shows tool routed
- `[DIFF]` does NOT show (not called)
- `[FINAL_DIFF]` shows empty (skipped collection)

---

### 10. **Test Scenario: Multiple Edits Same File**

**Setup**:
1. Send prompts that edit same file twice
2. Each edit sent as separate tool
3. Check: Final diff shows only final state

**Verify logging**:
- First `[COLLECT]` shows diff
- Second `[COLLECT]` shows diff
- `[MERGE]` shows merge operation
- `[FINAL_DIFF]` shows merged (single) artifact
- Intermediate state lost ⚠

---

## Extension Output Channel

All logs visible in:
- **VS Code Output** → "ACP Client" channel
- **Filter** logs by `[DIFF]`, `[SESSION_DIFF]`, `[FINAL_DIFF]`, etc.

## Key Assertions

| Assertion | Success | Failure |
|-----------|---------|---------|
| Diffs collected | Artifact log entries | Empty artifact list |
| Artifacts recorded | Session map grows | Map stays empty |
| Final diff retrieved | Non-empty artifact array | Empty array returned |
| External edit bypass intentional | Expected in logs | Unexpected omission |
| Workspace resolution correct | Paths match files | Path mismatch |

---

**Next**: Use this guide to instrument and identify where diffs go missing in your specific scenario.
