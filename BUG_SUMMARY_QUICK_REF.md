# Session Identity Bug - Quick Reference

## The Bug
User returns to session list, sends message "hihi", but it gets **attached to the previous session** instead of creating a new one.

---

## Root Cause (TL;DR)

**File:** `src/acpSessionManager.ts`, lines 333-336  
**Function:** `createOrGet()` for untitled sessions

```typescript
if (this.activeSessions.has(decodedResource.sessionId)) {
  return { session: this.activeSessions.get(decodedResource.sessionId)! };
}
```

**Problem:** The `decodedResource.sessionId` for **all untitled URIs** is normalized to the string `"untitled"` by `decodeVscodeResource()`.

When a second untitled chat is created:
1. Its resource `acp-agent:/untitled-uuid-2` decodes to sessionId `"untitled"`
2. The Map lookup finds the **OLD session** also under key `"untitled"`
3. **Returns old session instead of creating new one** ❌

---

## Why It Happens

| Item | Value |
|------|-------|
| **First chat item** | `acp-agent:/untitled-uuid-1` → sessionId=`"untitled"` |
| **Second chat item** | `acp-agent:/untitled-uuid-2` → sessionId=`"untitled"` |
| **Map lookup key** | Both use key `"untitled"` |
| **Result** | Both map to same Session object |

The normalization is **intentional** (per AGENTS.md), but it lacks **resource tracking**.

---

## Why Normalization Exists

From `AGENTS.md`:
> "Preserve untitled chat-session resource normalization... changing that breaks live ACP session lookup during bootstrap."

**Intent:** During bootstrap (while chat item is unnamed), reuse the same in-memory ACP session.

**What went wrong:** No mechanism to stop reusing when a **new** chat item is created.

---

## Critical Code Paths

| File | Function | Lines | Issue |
|------|----------|-------|-------|
| `chatIdentifiers.ts` | `decodeVscodeResource()` | 36-40 | Normalizes all untitled to `"untitled"` |
| `acpSessionManager.ts` | `getActive()` | 517-520 | Looks up using normalized sessionId |
| `acpSessionManager.ts` | `createOrGet()` | 333-336 | **THE BUG** - Returns old session |
| `acpChatParticipant.ts` | `handleRequest()` | 263-266 | Uses found/created session |
| `acpLifecycledChatSessionItemController.ts` | `newChatSessionItemHandler` | 54-68 | Reuses active session if found |

---

## Message Flow (With Bug)

```
User clicks "New Chat", types "hihi"
    ↓
acpChatParticipant.handleRequest()
    ├─ sessionResource = acp-agent:/untitled-uuid-2
    ├─ getActive(sessionResource)
    │   ├─ decodes to sessionId = "untitled"
    │   └─ finds OLD Session(acp_id_1) in activeSessions["untitled"]
    ├─ Uses OLD Session ❌
    └─ session.client.prompt(old_acp_id, "hihi")
        └─ Message sent to WRONG ACP session ❌
```

---

## What Should Happen

```
User clicks "New Chat", types "hihi"
    ↓
Check: Is this sessionResource already active?
    ├─ NEW resource: acp-agent:/untitled-uuid-2
    ├─ Should NOT find it in activeSessions
    └─ Should create NEW Session(acp_id_2)
```

---

## Likely Fixes

**Option 1: Track resource URI**
- Change activeSessions key from normalized sessionId to full resource URI
- Break bootstrap reuse behavior (may need refactoring)

**Option 2: Session lifecycle check**
- Before returning old session, verify it's still valid/in-progress
- Check if resource URI matches

**Option 3: Resource-aware Map**
- Store both normalized key AND resource URI
- Only reuse if resource URI matches

**Option 4: Defer session reuse**
- Don't reuse untitled sessions after they complete
- Only reuse **during same bootstrap cycle**

---

## Affected Scenarios

✅ **Works:** First untitled chat → send message  
✅ **Works:** Send multiple messages in same chat  
✅ **Works:** Complete chat, list, select from history  
❌ **Broken:** Complete chat, list, start NEW untitled chat  
❌ **Broken:** Send message to new untitled chat (attached to old session)

---

## Evidence Files

- `SESSION_IDENTITY_INVESTIGATION.md` - Full investigation
- `CRITICAL_CODE_LOCATIONS.md` - Line-by-line code analysis
- `acpSessionManager.ts` - Main logic
- `chatIdentifiers.ts` - URI normalization
- `acpChatParticipant.ts` - Message entry point
