# Session State Diagram - Session Identity Bug

## Timeline: The Bug in Action

```
TIME 1: User opens first untitled chat
═════════════════════════════════════════════════════════════
VS Code UI:
  [Chat Item 1: "untitled"]  ← resource: acp-agent:/untitled-abc123
  
sessionManager state:
  activeSessions {
    "untitled" → Session {
      acpSessionId: "acp_id_1"
      vscodeResource: acp-agent:/untitled-abc123
    }
  }
  
User sends "hello"
  ✓ Message goes to correct ACP session (acp_id_1)
```

```
TIME 2: Session completes, user navigates to session list
═════════════════════════════════════════════════════════════
VS Code UI:
  [Chat Item 1: "untitled"]  ← marked as Completed in list
  
sessionManager state:
  activeSessions {
    "untitled" → Session {
      acpSessionId: "acp_id_1"        ⚠️ Still active in memory!
      vscodeResource: acp-agent:/untitled-abc123
      status: Completed
    }
  }
  
diskSessions {
    "acp_id_1" → saved with title, cwd
  }
```

```
TIME 3: User sends message to NEW chat
═════════════════════════════════════════════════════════════
VS Code UI:
  [Chat Item 1: "untitled"]  ← old (Completed)
  [Chat Item 2: "untitled"]  ← NEW (resource: acp-agent:/untitled-xyz789)
                                     User types "hihi" here
  
🐛 BUG OCCURS:
  
1. handleRequest() receives message "hihi"
   sessionResource = acp-agent:/untitled-xyz789
   
2. Calls sessionManager.getActive(acp-agent:/untitled-xyz789)
   
3. decodeVscodeResource(acp-agent:/untitled-xyz789)
   → sessionId = "untitled"  ⚠️ Normalized!
   
4. activeSessions.get("untitled")
   → Returns OLD Session(acp_id_1)  ❌
   
5. Uses old session
   session.client.prompt(acp_id_1, "hihi")
   → Message sent to WRONG ACP session!

sessionManager state (WRONG):
  activeSessions {
    "untitled" → Session {
      acpSessionId: "acp_id_1"        ← Still old!
      vscodeResource: acp-agent:/untitled-xyz789  ← Updated but wrong session!
      status: InProgress
    }
  }
  
⚠️ Now Chat Item 2 is linked to acp_id_1's history!
```

---

## The Normalization Problem

```
Resource URIs vs Normalized Keys:

acp-agent:/untitled-abc123
    ↓ decodeVscodeResource()
    ↓ sessionId = "untitled-abc123"
    ↓ if starts with "untitled-":
    ↓   sessionId = "untitled"  ← NORMALIZED
    ↓
Lookup key: "untitled"

acp-agent:/untitled-xyz789
    ↓ decodeVscodeResource()
    ↓ sessionId = "untitled-xyz789"
    ↓ if starts with "untitled-":
    ↓   sessionId = "untitled"  ← SAME NORMALIZED KEY!
    ↓
Lookup key: "untitled"

BOTH URIs → SAME KEY → SAME Session object
```

---

## Root Cause Chain

```
Root: Normalization removes UUID uniqueness
  ↓
Effect: Two URIs map to one key
  ↓
Problem: activeSessions Map can't distinguish chats
  ↓
Bug: Second chat reuses first session
  ↓
Symptom: User message attached to wrong session
```

---

## Why It's Hard to Fix

1. **Normalization is intentional**
   - Needed for bootstrap session reuse
   - Changing it might break that feature

2. **No resource tracking**
   - Session object doesn't know which chat item owns it
   - Can't check "is this the right chat?"

3. **No lifecycle management**
   - Completed sessions stay in activeSessions
   - No clear "this session is done, new one can reuse" marker

---

## Map State Snapshots

```
AFTER TIME 1 (first chat, message sent):
activeSessions = {
  "untitled" → Session {
    acp_id: "acp_id_1",
    vscodeResource: acp-agent:/untitled-abc123
  }
}

AFTER TIME 2 (first chat completed):
activeSessions = {
  "untitled" → Session {
    acp_id: "acp_id_1",              ← Still there!
    vscodeResource: acp-agent:/untitled-abc123
    status: Completed
  }
}

AFTER TIME 3 (second chat, new message):
activeSessions = {
  "untitled" → Session {
    acp_id: "acp_id_1",              ← WRONG! Should be acp_id_2
    vscodeResource: acp-agent:/untitled-xyz789  ← Updated, but still wrong session
    status: InProgress
  }
}
```

---

## Key Insight

The **Session object's vscodeResource property gets updated** but it's still the **wrong Session object**. The normalization prevents proper session isolation.
