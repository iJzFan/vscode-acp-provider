# Investigation Complete: Session Identity Bug

## Executive Summary

**Bug:** User returns to session list, sends a message "hihi", but it gets attached to the **previous session** instead of creating a new one.

**Root Cause:** In `src/acpSessionManager.ts` (lines 333-336), the `createOrGet()` function reuses the existing active session when creating new untitled sessions. This occurs because all untitled URIs (`acp-agent:/untitled-*`) are normalized to the same sessionId key (`"untitled"`), causing the second untitled session to incorrectly find and reuse the first session's `Session` object.

**Severity:** HIGH - User messages can be routed to wrong sessions, corrupting chat history.

**Required Fix:** Track session identity using full resource URIs, not just normalized sessionIds. Stop reusing active sessions that belong to different chat items.

---

## Investigation Documents Created

### 1. **SESSION_IDENTITY_INVESTIGATION.md** (120 lines)
   - Overview of session identity flow
   - Entry points and message submission
   - Active session lookup mechanism
   - Data structures (activeSessions, diskSessions)
   - Test case that exposes the bug
   - Why normalization was intended

### 2. **CRITICAL_CODE_LOCATIONS.md** (154 lines)
   - Line-by-line code locations
   - Exact file:function:lines for each critical path
   - Code snippets showing the bug
   - Impact analysis
   - Session state diagram after bug

### 3. **BUG_SUMMARY_QUICK_REF.md** (160 lines)
   - Quick TL;DR summary
   - Root cause at a glance
   - Critical code paths table
   - Message flow with bug
   - Affected scenarios (✅ works, ❌ broken)

### 4. **SESSION_STATE_DIAGRAM.md** (160 lines)
   - Timeline visualization of the bug
   - Detailed state at each time step
   - Normalization problem diagram
   - Root cause chain
   - Map state snapshots

---

## Critical Code Locations

| Component | File | Function | Lines | Issue |
|-----------|------|----------|-------|-------|
| **Normalization** | `chatIdentifiers.ts` | `decodeVscodeResource()` | 36-40 | All untitled→`"untitled"` |
| **Lookup** | `acpSessionManager.ts` | `getActive()` | 517-520 | Uses normalized key |
| **THE BUG** | `acpSessionManager.ts` | `createOrGet()` | 333-336 | Returns old session |
| **Message handler** | `acpChatParticipant.ts` | `handleRequest()` | 263-266 | Routes to found session |
| **New item handler** | `acpLifecycledChatSessionItemController.ts` | `newChatSessionItemHandler` | 54-68 | Reuses if active |

---

## The Bug in Three Lines

```typescript
// chatIdentifiers.ts:36-40 — Normalizes all untitled URIs to same key
if (isUntitled) { sessionId = "untitled"; }

// acpSessionManager.ts:333-336 — Returns old session if key exists
if (this.activeSessions.has(decodedResource.sessionId)) {
  return { session: this.activeSessions.get(decodedResource.sessionId)! };
}
```

When user creates second untitled chat and sends message:
1. New URI `acp-agent:/untitled-xyz` decodes to sessionId `"untitled"`
2. Map has `"untitled" → OLD Session(acp_id_1)`
3. Returns old session instead of creating new one ❌

---

## Why Normalization Exists

From `AGENTS.md`:
> "Preserve untitled chat-session resource normalization in `src/chatIdentifiers.ts`; 
> changing that breaks live ACP session lookup during bootstrap."

**Purpose:** During bootstrap (while chat item is being named), the same in-memory ACP session should be reused to maintain context.

**Problem:** No mechanism to distinguish:
- Reusing SAME chat item (bootstrap) → OK ✓
- Reusing DIFFERENT chat items (new chat) → BUG ✗

---

## Suggested Fix Direction

**Option 1:** Track resource URI in Session
- Store `ownerResourceUri` in Session object
- Check if current resource matches before reusing
- Enables selective reuse (same chat only)

**Option 2:** Resource-aware activeSessions Map
- Use resource URI as primary key, not normalized sessionId
- Break normalization (but may require bootstrap refactoring)

**Option 3:** Hybrid approach
- Keep normalized key for bootstrap
- Add resource tracking for validation
- Reuse only if resource matches

**Preserve:** Bootstrap session reuse during initial naming phase

---

## Entry Points to Verify

1. ✓ **`acpChatParticipant.handleRequest()`** — Message handler
2. ✓ **`acpSessionManager.createOrGet()`** — Session creation
3. ✓ **`acpSessionManager.getActive()`** — Active lookup
4. ✓ **`chatIdentifiers.decodeVscodeResource()`** — URI parsing
5. ✓ **`acpLifecycledChatSessionItemController.newChatSessionItemHandler`** — New item

All critical paths have been traced and documented.

---

## Files Not Modified

✓ Investigation only — no code changes made  
✓ All analysis based on source code inspection  
✓ Ready for fix implementation
