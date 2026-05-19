# Test Target Recommendation for Live Chat Diff Rendering Fix

## Problem Summary
The `handleDiffToolContents()` method in `acpChatParticipant.ts` (lines 1054–1130) builds a `diffEntries` array and populates it with diff data, but **never emits it to the chat stream**. The method should call `stream.push(new vscode.ChatResponseMultiDiffPart(diffEntries, title))` after the loop completes.

**Location:** `src/acpChatParticipant.ts:1054–1130`
**Caller:** Line 688, called during tool call completion handling

## Smallest Realistic Test Target

### Recommended Target: `handleDiffToolContents()` Unit Test

**File:** Create `src/acpChatParticipant.test.ts` (new test file)

**Why this is the best target:**
1. **Focused scope** — Tests a single private method with clear input/output contracts
2. **No runtime dependencies** — Can mock VS Code APIs (ChatResponseStream, Uri, etc.)
3. **Existing patterns in codebase** — Tests follow Mocha + Node assert strict style
4. **Realistic test data** — ToolCallUpdate objects from ACP SDK are well-documented
5. **Enables true TDD** — Write failing test → see diff parts not emitted → add the missing line

## Existing Test Patterns in Codebase

### Pattern 1: Simple Pure Function Tests
**File:** `src/chatCommandSerialization.test.ts`
- Uses `mocha` suite/test decorators
- Uses `node:assert/strict`
- Tests pure functions directly
- Example: buildStructuredCommandPrompt()

### Pattern 2: Utility Function Tests
**File:** `src/commandMatching.test.ts`
- Tests multiple related functions
- No mocking needed
- Example: getShortCommandName(), normalizeSlashCommandQuery()

### Pattern 3: Complex Object Tests with Mocking
**File:** `src/tracer.test.ts`
- Uses Module._load interception for vscode mocking
- Creates realistic test data (SessionNotification)
- Uses setup/teardown for module state management
- Example: Tests notification processing with sensitive field redaction

## Test File Structure for acpChatParticipant.test.ts

```typescript
// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { suite, test } from "mocha";

// Import the class or extract handleDiffToolContents for testing
// May require exporting a testable function or using private method access

suite("acpChatParticipant", () => {
  test("handleDiffToolContents emits ChatResponseMultiDiffPart", () => {
    // Create mock ToolCallUpdate with diff content
    // Create mock ChatResponseStream that captures pushed parts
    // Call handleDiffToolContents()
    // Assert stream.push() was called with ChatResponseMultiDiffPart
    // Assert diffEntries matches input diffs
  });

  test("handleDiffToolContents handles empty content gracefully", () => {
    // Test with no content array
    // Test with empty content array
  });
});
```

## Recommended Test Scenarios

1. **Happy path**: Single file diff with both old and new text
2. **Multiple diffs**: Several files modified in one update
3. **Deletion case**: File removed (no newText)
4. **Creation case**: New file (no oldText)
5. **Mixed operations**: Combination of add/modify/delete in one call
6. **Empty content**: No diffs in the update (should return early)

## Build and Test Commands

```bash
# Build
npm run compile

# Run tests
npm test

# Watch mode during development
npm run watch
```

## Key Export Adjustments Needed

- **Current:** `handleDiffToolContents` is private
- **Options:**
  1. Extract a pure internal function `buildDiffPart()` and test that
  2. Export a test helper that creates ChatResponseMultiDiffPart
  3. Use TypeScript `as any` to access private method in test (acceptable for unit testing)

## VS Code API References

- **ChatResponseMultiDiffPart:** `vscode.proposed.chatParticipantAdditions.d.ts` line 375
- **ChatResponseStream.push():** line 612 (accepts ExtendedChatResponsePart)
- **ChatResponseDiffEntry:** lines 345–367 (interface with originalUri, modifiedUri, stats)
