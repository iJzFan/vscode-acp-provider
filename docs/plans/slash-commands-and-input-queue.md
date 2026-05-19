# Slash Commands Without `@agent` and Input Queue

## Status

Implemented in `src/extension.ts`, `src/acpSessionManager.ts`, `src/acpChatParticipant.ts`.

## 1. Slash Commands Without `@agent`

### Problem

Currently the user must type `@opencode /command` to see slash command
completions.  VS Code's `ChatParticipant.participantVariableProvider` only
fires **after** the participant is selected (i.e. after `@agent` is typed).
There is no standard API for global slash completions that work before
participant selection.

### Approach

Two parallel mechanisms, both already present:

| Mechanism | Scope | Trigger | When it works |
|---|---|---|---|
| `participantVariableProvider` | Per participant | After `@agent` typed | Always (VS Code API) |
| `CompletionItemProvider` (fallback) | Document scheme | `/` typed | Only if chat input has a supported scheme |

#### Fallback `CompletionItemProvider` Changes (`src/extension.ts`)

Registered for known chat-editor document schemes:
- `acp-{agentId}` — ACP session URI
- `acp` — generic ACP scheme
- `vscode-chat-editor` — VS Code chat editor view

**Note:** whether VS Code's chat input widget exposes a `TextDocument` with
one of these schemes is **not guaranteed**.  If it does not, the
`CompletionItemProvider` fallback will not fire and the user will still need
`@agent`.  This is a VS Code API limitation — there is no supported API for
global chat input completions.

#### Agent Prefix Auto-Insertion (`src/extension.ts:230-233`)

When the `CompletionItemProvider` *does* fire and the cursor text has no
`@mention` yet, the completion's `insertText` is prepended with
`@{agentId}`:

```typescript
const hasAgentMention = /@\w/.test(textBefore);
const agentPrefix = hasAgentMention ? "" : `@${agent.id} `;
// item.insertText = `${agentPrefix}/${canonicalName} `;
```

This way the selected completion produces `@opencode /fix ` in the chat
input, routing it to the correct ACP participant.

**Uncertainty:** VS Code may handle `@` insertion in the chat input
specially (participant picker).  This needs runtime testing.

### Alternative If Fallback Does Not Work

If the `CompletionItemProvider` cannot reach the chat input document, the
only reliable approach is to improve discoverability of the `@agent`
requirement:

1. Add a welcome message showing `@opencode /?` to list commands
2. Show a hint in the session command bar (`chatSessions.commands` in
   `package.json`)
3. Add a `/?` handler that renders all available commands inline

## 2. Input Queue

### Problem

When the user submits a new prompt while a previous one is still in flight,
the current implementation **cancels** the in-flight request and starts the
new one.  The user loses the in-progress work.

### Solution

Queueing is implemented per session on top of the existing cancellation
flow. When a new prompt arrives while one is already in flight, the new
request waits its turn instead of cancelling the current request.

#### Current Behavior

In `src/acpChatParticipant.ts` and `src/acpSessionManager.ts`:

1. `handleRequest` waits before sending a prompt if the session is busy.
2. Queued requests immediately show `⏳ Queued (position: #N)` feedback.
3. When the active request finishes, the next queued request is allowed to
   proceed.
4. Queueing is isolated per agent/session.

The detailed queue-internals notes that were useful during design are
intentionally omitted here now that the behavior is implemented in code.
