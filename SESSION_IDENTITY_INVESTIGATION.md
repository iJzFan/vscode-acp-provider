# Chat/Session Identity Investigation Summary

## Bug Description
User returns to session list page, sends new message "hihi", but it gets attached to the **previous session** instead of creating a **new one**.

---

## Session Identity Flow

### 1. **Session Resource Encoding** (`chatIdentifiers.ts`)
- Sessions use URI scheme: `acp-{agentId}:/{sessionId}`
- **Untitled sessions** use special normalization:
  - Input: `acp-agent:/untitled-{uuid}`
  - **Decoded to:** `"untitled"` (normalized key) for in-memory ACP session reuse
  - Lines 36-40: `decodeVscodeResource()` normalizes all untitled variants to same key
- This allows VS Code to keep resolving the **same in-memory ACP session** while chat item is unnamed

### 2. **Entry Point: Message Submission** (`acpChatParticipant.ts:247-277`)
**`handleRequest()` - where user message is processed:**
1. Extracts `sessionResource` from `context.chatSessionContext?.chatSessionItem.resource`
2. Calls `sessionManager.getActive(sessionResource)` (line 263)
3. If not active, calls `sessionManager.createOrGet(sessionResource)` (line 266)
4. **Critical:** Uses the `sessionResource` URI to determine session identity

### 3. **Active Session Lookup** (`acpSessionManager.ts:517-520`)
```typescript
getActive(vscodeResource: vscode.Uri): Session | undefined {
  const decodedResource = decodeVscodeResource(vscodeResource);
  return this.activeSessions.get(decodedResource.sessionId);
}
```
- Decodes the resource URI
- Looks up in `activeSessions` Map using decoded sessionId

### 4. **Create-or-Get Logic** (`acpSessionManager.ts:325-507`)
**For untitled sessions (lines 332-402):**
- Checks `if (decodedResource.isUntitled)`
- **Normalized key:** `"untitled"` (from line 40 of chatIdentifiers.ts)
- **Suspicious Logic (Line 333):**
  ```typescript
  if (this.activeSessions.has(decodedResource.sessionId)) {
    return { session: this.activeSessions.get(decodedResource.sessionId)! };
  }
  ```
  - If ANY session is active with key `"untitled"`, **returns the existing one**
  - No check if it's the same logical chat session in VS Code
  - No check on the actual resource URI `vscodeResource`

---

## Most Suspicious Logic - THE BUG

### Location: `acpSessionManager.ts:333-336`

When user clicks back to session list and sends a message to "new" untitled session:

1. **Old Session**: Was active, has `activeSessions["untitled"] = Session(old-acp-id)`
2. **User Action**: Navigates to session list, sends message in new area
3. **New Resource**: VS Code creates new resource `acp-agent:/untitled-new-uuid`
4. **Decode**: Normalizes to `sessionId="untitled"` (same normalized key!)
5. **Lookup**: `activeSessions.has("untitled")` returns **true** (old session still there)
6. **Result**: Returns old session instead of creating new one ❌

**Root Cause**: Normalization doesn't distinguish between:
- Different untitled chat items in the UI
- Old session with leftover active state

---

## Related Code Paths

### Session List Provider (`acpChatSessionItemProvider.ts:81-85`)
- `provideChatSessionItems()` calls `sessionManager.list()`
- Lists sessions from **disk** (completed sessions)
- In-progress sessions tracked separately by lifecycle controller

### Lifecycle Controller (`acpLifecycledChatSessionItemController.ts:51-96`)
- `newChatSessionItemHandler` handles new chat session creation
- Checks `sessionManager.getActive(sessionResource)` (line 54)
- **Reuses existing if active** (line 56-68)
- **Falls back to placeholder** if not active (line 73-95)
- **Issue**: If old untitled session is still active, reuses it

### Content Provider (`acpChatSessionContentProvider.ts:57-84`)
- `provideChatSessionContent()` calls `sessionManager.createOrGet(resource)`
- This is called when VS Code restores/loads a chat session
- Uses resource URI to determine identity

---

## Data Structures

### activeSessions Map
- **Key**: Decoded session ID (e.g., `"untitled"` for all untitled, or actual sessionId)
- **Value**: In-memory `Session` object
- **Persistence**: Cleared on client stop; not persisted to disk

### diskSessions Map
- **Key**: sessionId from database
- **Value**: `DiskSession` (title, cwd, updatedAt)
- **Persistence**: SQLite database

---

## Entry Points to Verify

1. **`acpChatParticipant.handleRequest()`** - Message handler (CONFIRMED CRITICAL)
2. **`acpSessionManager.createOrGet()`** - Session creation (CONFIRMED CRITICAL)
3. **`acpSessionManager.getActive()`** - Active lookup (CONFIRMED CRITICAL)
4. **`chatIdentifiers.decodeVscodeResource()`** - URI parsing (CONFIRMED CRITICAL)
5. **`acpLifecycledChatSessionItemController.newChatSessionItemHandler`** - New item creation

---

## Likely Root Cause

**Untitled session normalization is too aggressive.** All `untitled-*` URIs normalize to the same key, causing the second new untitled session to reuse the first active one instead of creating a new ACP session.

**Fix Needed**: Track the actual VS Code resource URI alongside the normalized key, or stop reusing active sessions when user navigates back to session list.



---

## Test Case Exposing the Bug

```
SCENARIO: User sends message to new untitled session after previous completed

1. User opens first untitled session, sends "hello"
   - Session(acp_id_1) active, stored in activeSessions["untitled"]
   - VS Code resource: acp-agent:/untitled-uuid-1

2. Session completes, user navigates back to session list
   - Session marked Completed, saved to disk
   - activeSessions["untitled"] still has Session(acp_id_1) ⚠️

3. User sends new message "hihi" (expecting new session)
   - VS Code creates new chat item: acp-agent:/untitled-uuid-2
   - handleRequest extracts this NEW resource

4. THE BUG OCCURS:
   - createOrGet(acp-agent:/untitled-uuid-2) called
   - decodeVscodeResource() normalizes to sessionId="untitled"
   - activeSessions.has("untitled") → TRUE (has old Session!)
   - Returns OLD Session(acp_id_1) ❌
   - Message "hihi" corrupts old session's history

EXPECTED: Create new Session(acp_id_2)
ACTUAL: Reuse old Session(acp_id_1)
```

---

## Call Graph: How Message Routes to Wrong Session

```
acpChatParticipant.handleRequest()
    ↓ extracts sessionResource
    ├─ NEW resource: acp-agent:/untitled-uuid-2
    │
    ├─ sessionManager.getActive(NEW_resource)
    │   └─ decodeVscodeResource(NEW_resource)
    │       └─ sessionId = "untitled" (normalized)
    │   └─ activeSessions.get("untitled") → OLD Session ❌
    │
    └─ Uses OLD Session → wrong ACP sessionId!
```

---

## Why Normalization Was Intended

From AGENTS.md:
> "Preserve untitled chat-session resource normalization in `src/chatIdentifiers.ts`;
> changing that breaks live ACP session lookup during bootstrap."

**Intent**: Allow VS Code to reuse same in-memory ACP session during bootstrap while chat item is being named.

**Problem**: No tracking of which VS Code chat item (resource) owns each Session. When second chat item is created, it incorrectly claims first item's Session.
