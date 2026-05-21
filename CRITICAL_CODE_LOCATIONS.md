# Critical Code Locations for Session Identity Bug

## File: `src/chatIdentifiers.ts`

### Function: `decodeVscodeResource()` [Lines 23-46]
**Suspicious behavior:** Normalizes all untitled URIs to same sessionId

```typescript
export function decodeVscodeResource(resource: vscode.Uri): {
  isUntitled: boolean;
  sessionId: string;
} {
  // ...
  let sessionId: string = resource.path.substring(1);
  const isUntitled = sessionId.startsWith("untitled-");
  if (isUntitled) {
    // ⚠️ ALL "untitled-*" URIs normalize to "untitled"
    sessionId = "untitled";  // <-- THE PROBLEM
  }
  return { isUntitled, sessionId };
}
```

**Impact**: Two different VS Code chat items both decode to `sessionId="untitled"`

---

## File: `src/acpSessionManager.ts`

### Function: `getActive()` [Lines 517-520]
**Uses normalized sessionId to lookup:**

```typescript
getActive(vscodeResource: vscode.Uri): Session | undefined {
  const decodedResource = decodeVscodeResource(vscodeResource);
  // ⚠️ Both old and new untitled items have sessionId="untitled"
  return this.activeSessions.get(decodedResource.sessionId);
}
```

### Function: `createOrGet()` [Lines 325-507]
**For untitled sessions [Lines 332-402]:**

```typescript
if (decodedResource.isUntitled) {
  // ⚠️ THIS IS THE BUG [Lines 333-336]
  if (this.activeSessions.has(decodedResource.sessionId)) {
    return {
      session: this.activeSessions.get(decodedResource.sessionId)!
    };
  }
  // ... create new session
  this.activeSessions.set(decodedResource.sessionId, session);
}
```

**Problem:**
- Line 333: Checks if `activeSessions["untitled"]` exists
- If yes, returns it **without checking if it's the same VS Code chat item**
- No verification that resource URI matches
- No check that session is still valid/in-progress

---

## File: `src/acpChatParticipant.ts`

### Function: `handleRequest()` [Lines 247-277]
**Entry point for user message:**

```typescript
private async handleRequest(...): Promise<void> {
  // Line 253-254: Extract sessionResource from VS Code context
  const sessionResource = 
    context.chatSessionContext?.chatSessionItem.resource;
  
  // Line 263: Look up in activeSessions
  let session = this.sessionManager.getActive(sessionResource);
  
  if (!session) {
    // Line 266: If not found, create new one
    const result = await this.sessionManager.createOrGet(sessionResource);
    session = result.session;
  }
  
  // ⚠️ Uses this session (could be OLD if bug present)
  await session.client.prompt(sessionId, promptBlocks);
}
```

**Message routing:**
1. Extracts resource from chat context
2. Looks up in activeSessions (uses normalized key)
3. If found, uses it (BUG: might be wrong session)
4. Sends message to wrong ACP sessionId

---

## File: `src/acpLifecycledChatSessionItemController.ts`

### Function: `newChatSessionItemHandler` [Lines 51-96]
**Creates new chat session items:**

```typescript
this.controller.newChatSessionItemHandler = async (context, _token) => {
  const sessionResource = context.request.sessionResource;
  // Line 54: Checks if session is already active
  const session = sessionResource
    ? this.sessionManager.getActive(sessionResource)
    : undefined;
  if (session) {
    // Line 56-68: REUSES existing active session
    const uri = this.sessionManager.createSessionUri(session);
    return this.controller.createChatSessionItem(uri, ...);
  }
  // ... fallback to create placeholder
};
```

**Problem:** Uses normalized key to look up, so second untitled item incorrectly finds first item's session.

---

## File: `src/acpChatSessionContentProvider.ts`

### Function: `provideChatSessionContent()` [Lines 57-84]
**Called when VS Code loads/restores chat session:**

```typescript
async provideChatSessionContent(
  resource: vscode.Uri,
  _token: vscode.CancellationToken,
): Promise<vscode.ChatSession> {
  // ⚠️ Calls createOrGet which uses normalized sessionId
  const response = await this.sessionManager.createOrGet(resource);
  const { session: acpSession, history } = response;
  
  // Uses this session object for history and handler
  return { history: history || [], requestHandler: ... };
}
```

---

## Data Flow Summary

```
User sends "hihi" on new chat item
    ↓
handleRequest(request, context)
    ↓ extracts sessionResource
    ├─ NEW: acp-agent:/untitled-uuid-2
    ↓
sessionManager.getActive(sessionResource)
    ↓ decodes resource
    ├─ Normalized sessionId: "untitled"
    ↓ looks up activeSessions
    ├─ Finds: OLD Session(acp_id_1)
    ↓ returns wrong session
    ├─ Session(acp_id_1) ❌
    ↓
session.client.prompt(acp_id_1, "hihi")
    ↓ message goes to OLD ACP session ❌
```

---

## Session State After Bug

```
activeSessions Map:
  "untitled" → Session {
    acp_id: "acp_id_1",        // ← OLD session
    vscodeResource: acp-agent:/untitled-uuid-2,  // ← NEW resource
    acpSessionId: "acp_id_1",  // ← Wrong ACP id
  }
```

Session object's vscodeResource was updated (if line 320 of `createSessionUri()` fired), but:
- It's still the OLD Session object
- It's still has OLD acp_id
- It's now mapped to WRONG vscodeResource
- Messages to new chat item go to old ACP session
