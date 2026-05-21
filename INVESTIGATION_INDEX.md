# Session Identity Investigation - Document Index

## Quick Start (Pick One)

### 🚀 **For Busy People: 2-Minute Read**
→ **BUG_SUMMARY_QUICK_REF.md**
- The bug in one sentence
- Root cause (TL;DR)
- Critical code paths table
- Affected scenarios

### 🔍 **For Code Reviewers: 10-Minute Read**
→ **CRITICAL_CODE_LOCATIONS.md**
- Exact file:function:line references
- Code snippets from each critical path
- How message routes to wrong session
- Session state after bug occurs

### 📊 **For Visual Learners: Timeline View**
→ **SESSION_STATE_DIAGRAM.md**
- Timeline: User actions → Bug occurs
- State snapshots at each time step
- Why normalization creates the problem
- Map state before/after bug

### 📋 **For Deep Dive: Full Investigation**
→ **SESSION_IDENTITY_INVESTIGATION.md**
- Complete session identity flow
- Entry points and code paths
- Data structures (activeSessions, diskSessions)
- Test case exposing bug
- Why normalization was intended

### ✅ **For Closure: Investigation Summary**
→ **INVESTIGATION_COMPLETE.md**
- Executive summary
- Critical code table
- Bug in three lines of code
- Suggested fix directions

---

## Investigation Map

```
User sends "hihi" to new chat
    ↓
acpChatParticipant.handleRequest()
    ↓ [CRITICAL_CODE_LOCATIONS.md]
sessionManager.getActive()
    ↓
decodeVscodeResource()
    ├─ Input: acp-agent:/untitled-xyz789
    ├─ Output: sessionId="untitled"
    │   [SESSION_STATE_DIAGRAM.md]
    ↓
activeSessions.get("untitled")
    ├─ Returns: OLD Session(acp_id_1)
    │   [BUG_SUMMARY_QUICK_REF.md]
    ↓ ❌ WRONG SESSION USED
```

---

## Key Files Referenced

| Repo File | Purpose | Mentioned In |
|-----------|---------|--------------|
| `src/chatIdentifiers.ts:36-40` | URI normalization | All docs |
| `src/acpSessionManager.ts:333-336` | **THE BUG** | All docs |
| `src/acpSessionManager.ts:517-520` | Session lookup | CRITICAL_LOCATIONS |
| `src/acpChatParticipant.ts:247-277` | Message entry | CRITICAL_LOCATIONS |
| `src/acpLifecycledChatSessionItemController.ts:51-96` | Item lifecycle | SESSION_IDENTITY |

---

## Reading Strategy by Role

### 🔧 **Fix Implementer**
1. Start: BUG_SUMMARY_QUICK_REF.md (understand the bug)
2. Then: CRITICAL_CODE_LOCATIONS.md (see exact code)
3. Then: SESSION_STATE_DIAGRAM.md (understand flow)
4. Then: Review acpSessionManager.ts (lines 325-507)

### 🧪 **Test Writer**
1. Start: SESSION_IDENTITY_INVESTIGATION.md (test case section)
2. Then: SESSION_STATE_DIAGRAM.md (scenarios)
3. Then: BUG_SUMMARY_QUICK_REF.md (affected scenarios)

### 📚 **Architecture Reviewer**
1. Start: INVESTIGATION_COMPLETE.md (executive summary)
2. Then: SESSION_IDENTITY_INVESTIGATION.md (full flow)
3. Then: CRITICAL_CODE_LOCATIONS.md (code details)
4. Check: AGENTS.md (normalization context)

### 🐛 **Bug Triager**
1. Start: BUG_SUMMARY_QUICK_REF.md (quick ref)
2. Then: SESSION_STATE_DIAGRAM.md (see the timeline)
3. Done ✓

---

## Investigation Status

✅ **Session resource encoding** - Understood  
✅ **Entry points** - Mapped (5 critical paths)  
✅ **Active session lookup** - Analyzed  
✅ **Create-or-get logic** - Bug located  
✅ **Chat participant flow** - Traced  
✅ **Lifecycle controller** - Reviewed  
✅ **Content provider** - Checked  
✅ **Data structures** - Documented  
✅ **Test case** - Provided  

**Conclusion:** Bug is fully understood and localized.  
**No code changes made** - Investigation only.

---

## Documents Created

| Document | Lines | Purpose |
|----------|-------|---------|
| BUG_SUMMARY_QUICK_REF.md | 160 | TL;DR overview |
| CRITICAL_CODE_LOCATIONS.md | 154 | Code line-by-line |
| SESSION_IDENTITY_INVESTIGATION.md | 180 | Deep investigation |
| SESSION_STATE_DIAGRAM.md | 160 | Timeline/state |
| INVESTIGATION_COMPLETE.md | 140 | Executive summary |
| **INVESTIGATION_INDEX.md** | **This** | Navigation guide |

**Total:** ~1000 lines of investigation documentation

---

## How to Use This Index

1. **Find your use case** in "Reading Strategy by Role" above
2. **Open the recommended document** first
3. **Follow cross-references** to other docs as needed
4. **Reference critical code locations** for verification

All documents are self-contained but cross-linked.
