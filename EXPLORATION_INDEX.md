# Exploration Index: Session End & Diff Rendering

**Generated**: 2026-05-20  
**Project**: g:\vscode-acp-provider (VS Code ACP Provider Extension)  
**Scope**: Complete investigation of chat session completion, diff rendering, and file reveal mechanisms

---

## Documents in This Exploration

### 1. **DIFF_RENDERING_AND_SESSION_END_EXPLORATION.md** (Primary)
The main exploration document covering:
- Session end / chat completion flow
- Final cumulative diff rendering mechanism
- Diff rendering during tool completion
- File reveal & diff commands
- Likely causes of inconsistent full diff display
- Key symbols & locations
- End-to-end request-response flow

**Start here for**: Understanding how session completion triggers final diff display and why diffs may be partial.

---

### 2. **EXPLORATION_KEY_FINDINGS.md** (Executive Summary)
High-level findings including:
- **Critical Discovery**: Two parallel diff paths (external edit vs. content-based)
- Root cause: External edits intentionally excluded from cumulative summary
- Session end flow diagram
- Diff accumulation mechanism with merging logic
- Command link system
- Session completion states
- File URI normalization

**Start here for**: Quick answer to "why are diffs partial?"

---

### 3. **SESSION_END_RENDERING_SUMMARY.md** (Visual Reference)
Comprehensive visual diagrams and sequences:
- High-level architecture flowchart
- Diff handling decision tree
- Cumulative diff artifact map structure
- Session completion sequence (4 steps)
- File reveal mechanisms (3 types)
- Conditions for full/partial/no diff display
- Data structures used
- Critical lines of code table

**Start here for**: Visual understanding of the system and flow.

---

### 4. **DIFF_EXPLORATION_APPENDIX.md** (Technical Details)
Deep-dive code structures:
- ToolDiffArtifact TypeScript type definition
- SessionManager diff storage structure
- DiffURI format & examples
- ChatResponseMultiDiffPart creation code
- Recording flow implementation
- External edit route code
- Diff content collection code
- Final cumulative diff push code
- Chat response stream integration
- Workspace root resolution

**Start here for**: Understanding internal data structures and implementation details.

---

### 5. **INSTRUMENTATION_VERIFICATION_GUIDE.md** (Debugging)
Step-by-step instrumentation guide with 10 verification checks:
1. Check: Diffs collected during session?
2. Check: Artifacts recorded in session manager?
3. Check: Final diff retrieved at session end?
4. Check: External edit route taken instead?
5. Check: Content block types?
6. Check: Artifact merging?
7. Check: Workspace root resolution?
8-10. Test scenarios with specific setup & verification

Plus: Extension output channel location, key assertions table.

**Start here for**: Diagnosing why diffs are missing in specific scenarios.

---

## Quick Navigation by Question

### "How does session completion work?"
→ SESSION_END_RENDERING_SUMMARY.md (Session Completion Sequence)  
→ DIFF_RENDERING_AND_SESSION_END_EXPLORATION.md (Section 1)

### "Why are diffs sometimes partial?"
→ EXPLORATION_KEY_FINDINGS.md (Why Diffs Sometimes Appear Partial)  
→ SESSION_END_RENDERING_SUMMARY.md (Why Diffs Appear Partial/Full)

### "What are the diff rendering paths?"
→ EXPLORATION_KEY_FINDINGS.md (Critical Discovery)  
→ SESSION_END_RENDERING_SUMMARY.md (Diff Handling Decision Tree)

### "Where do I add logging to debug diffs?"
→ INSTRUMENTATION_VERIFICATION_GUIDE.md (all sections)

### "What are the key code locations?"
→ EXPLORATION_KEY_FINDINGS.md (Open Questions section)  
→ SESSION_END_RENDERING_SUMMARY.md (Critical Lines of Code table)  
→ DIFF_RENDERING_AND_SESSION_END_EXPLORATION.md (Section 6)

### "How does external edit vs. diff work?"
→ EXPLORATION_KEY_FINDINGS.md (Critical Discovery)  
→ DIFF_EXPLORATION_APPENDIX.md (Section F)

### "What data structures are used?"
→ DIFF_EXPLORATION_APPENDIX.md (Sections A-E)  
→ SESSION_END_RENDERING_SUMMARY.md (Data Structures Used table)

### "What is the complete end-to-end flow?"
→ DIFF_RENDERING_AND_SESSION_END_EXPLORATION.md (Section 7)  
→ SESSION_END_RENDERING_SUMMARY.md (High-Level Architecture)

---

## Key Findings Summary

### The Two Diff Paths

1. **External Edit Route** (`kind === "edit"`)
   - Handled by `handleFileEditToolCalls()` → returns true
   - Calls `stream.externalEdit()` for in-editor application
   - **NOT collected** for final cumulative diff
   - Changes visible in workspace but absent from session summary

2. **Content-Based Diff Route** (all other tools)
   - Handled by `handleDiffToolContents()`
   - Parses `content.oldText / content.newText`
   - **Collected** via `recordToolDiffArtifacts()`
   - Shown immediately AND in final cumulative diff

### Session End Sequence

```
session.client.prompt() completes
  ↓
renderFinalCumulativeDiff() [line 351]
  ├─ Get accumulated artifacts from sessionManager
  ├─ Create ChatResponseMultiDiffPart
  └─ Push to response stream
  ↓
session.markAsCompleted() [line 353]
  ↓
sessionManager.syncSessionState() [line 359]
  ↓
Chat shows final diff summary as "Modified files"
```

### Artifact Merging Behavior

When same file edited multiple times in session:
- Key: Normalized file path (Windows: lowercase)
- Merge: Preserves original `oldText`, updates to latest `newText`
- **Effect**: Intermediate states overwritten; only final visible

---

## Files Analyzed

| File | Purpose |
|------|---------|
| acpChatParticipant.ts | Main orchestrator; handles diff rendering & session end |
| acpSessionManager.ts | Accumulates & retrieves diffs per session |
| diffRendering.ts | Parses diffs, merges artifacts, creates UI parts |
| diffContentProvider.ts | Virtual filesystem provider for acp-diff:// URIs |
| chatRenderingUtils.ts | Path resolution, diff stats, markdown generation |
| extension.ts | Registers diff content provider at startup |
| commands.ts | Chat text insertion command (plan actions) |

---

## Critical Sections

| Topic | File | Lines |
|-------|------|-------|
| Session end trigger | acpChatParticipant | 346-359 |
| Final diff render | acpChatParticipant | 1125-1137 |
| Immediate diff | acpChatParticipant | 1115-1123 |
| Routing decision | acpChatParticipant | 746-749 |
| Recording | acpSessionManager | 849-866 |
| Retrieval | acpSessionManager | 868-874 |
| Artifact merging | diffRendering | 35-59 |
| Provider register | extension | 68 |

---

## Next Steps

1. **For understanding the system**: Start with SESSION_END_RENDERING_SUMMARY.md
2. **For diagnosing issues**: Use INSTRUMENTATION_VERIFICATION_GUIDE.md
3. **For code changes**: Reference DIFF_EXPLORATION_APPENDIX.md for structures
4. **For context**: Read EXPLORATION_KEY_FINDINGS.md

---

**Created by**: Augment Agent exploration  
**Date**: 2026-05-20  
**Status**: Complete and documented
