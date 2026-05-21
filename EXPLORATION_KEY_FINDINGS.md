# Key Findings: Session End & Diff Rendering Exploration

---

## Critical Discovery: Two Parallel Diff Paths

### Path 1: External Edit Route (Live, Real-time)
- Triggered: `tool.kind === "edit"`
- Location: `handleFileEditToolCalls()` line 1150
- Behavior: Calls `stream.externalEdit(fileUri, callback)`
- Diffs: **NOT collected** for final summary
- Effect: Changes applied in-editor, tracked externally, omitted from session's cumulative diff

### Path 2: Diff-Content Route (Streaming + Summary)
- Triggered: All other tools or when external edit not applicable
- Location: `handleDiffToolContents()` line 1115
- Behavior: Parses `content.oldText / content.newText`
- Diffs: **Collected** via `recordToolDiffArtifacts()` line 1121
- Effect: Shown immediately during tool completion AND in final cumulative diff

**Root Cause of Partial Diffs**: External edits are intentionally excluded from the final cumulative diff because they're already applied in the workspace. Only content-based diffs (tool-reported changes) appear in the summary.

---

## Session End Flow Diagram

```
[Prompt completion] (line 346)
  ↓ [After all SessionNotifications processed]
renderFinalCumulativeDiff() (line 351)  ◄─── KEY: Session-end summary
  ├─ getCumulativeToolDiffArtifacts(sessionId)  [Retrieve accumulated]
  ├─ createToolDiffPart()  [Wrap in ChatResponseMultiDiffPart]
  └─ response.push(diffPart)  [Emit to chat]
  ↓
session.markAsCompleted() (line 353)
  ↓
sessionManager.syncSessionState() (line 359)
  ↓ [Chat UI shows completed session with final diff summary]
```

---

## Diff Accumulation Mechanism

**Storage**: `SessionManager.cumulativeToolDiffs: Map<sessionId, Map<fileKey, ToolDiffArtifact>>`

**Collection Points**:
1. During `tool_call_update` completion → `handleDiffToolContents()` (line 1115)
2. Recording: `recordToolDiffArtifacts()` (acpSessionManager line 849)
3. Per-file merge: If same file appears twice, `mergeToolDiffArtifacts()` runs (line 863)
   - Preserves original `oldText`
   - Updates to latest `newText`
   - **Effect**: Intermediate edits overwritten; only final state visible

**Retrieval**: `getCumulativeToolDiffArtifacts()` (acpSessionManager line 868)

**Cleanup**: `clearCumulativeToolDiffArtifacts()` (line 889) when session closed

---

## Command Link System (for reopening diffs)

**Chat Text Insertion**: `acp.insertChatText` command (chatRenderingUtils.ts line 12)
- Pre-fills chat query without sending
- Used by plan action buttons (line 972-986)
- Encoded as: `command:acp.insertChatText?${encodeURIComponent(JSON.stringify([text]))}`

**File Reveal**: Built-in to `ChatResponseMultiDiffPart`
- `goToFileUri` field → VS Code handles click-to-open
- No custom command needed

---

## Why Diffs Sometimes Appear Partial

**Scenario A**: Tool reports diffs via `content[].type === "diff"`
- Collected and shown ✓

**Scenario B**: Tool applies changes via external editor (`kind === "edit"`)
- Not collected; only shown in realtime via editor
- Omitted from final cumulative diff ✗

**Scenario C**: Same file edited twice in session
- First edit: `{ oldText: "A", newText: "B" }`
- Second edit: `{ oldText: "A", newText: "C" }`
- Merged result: `{ oldText: "A", newText: "C" }` (middle state lost) ⚠

**Scenario D**: ACP server doesn't send diff blocks
- Returns only tool output, no content array
- Early return at line 1066
- No diffs rendered ✗

---

## Registration & Startup

**Extension.ts activation** (line 54-96):
```
1. createOutputChannel()
2. registerDiffContentProvider() ◄─── Line 68 (MUST run first)
3. createSessionDb()
4. registerAgents()
5. registerCommands()
```

**If diff provider not registered**: URIs created but no content provided → blank diffs.

---

## Session Completion States

| Path | Marker | Line |
|------|--------|------|
| List commands ("/?") | `markAsCompleted()` | 267 |
| Empty prompt | `markAsCompleted()` | 338 |
| Successful prompt | `markAsCompleted()` | 353 |
| Error | `markAsFailed()` | 369 |

Final cumulative diff rendered only after **successful** `session.client.prompt()` (line 346).

---

## File URI Normalization

**Key for deduplication** (diffRendering.ts:23-33):
- Windows: lowercase normalized path
- Unix: normalized path
- Non-file schemes: preserved as-is

**Impact**: Diff artifacts keyed by normalized path; multiple references to same file merge.

---

## Open Questions & Recommendations

1. **Cross-edit visibility**: Should intermediate edits be preserved in cumulative diff?
   - Current: Only final state visible due to merge
   - Consider: Maintain edit chain vs. deduplicate

2. **External edit inclusion**: Should external edits appear in final summary?
   - Current: Intentionally excluded (already in workspace)
   - Design OK, but could be more explicit

3. **Content block validation**: No validation that `oldText` matches workspace file before merge
   - Risk: Diff artifacts may be stale if file changed externally

