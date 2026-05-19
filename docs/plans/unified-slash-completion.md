# Unified Slash Completion: Skills + ACP Commands

> Status: **Draft**  
> Last updated: 2026-05-15  
> Author: grill-with-docs session

---

## 1. Goal

Provide a unified `/` completion menu in VS Code chat that shows both ACP commands (from `available_commands_update`) and discovered skills (from `SKILL.md` files).

No behavioral change when a completion item is selected — the text is inserted into the chat input, same as today.

---

## 2. Skill Data Source

### Configuration

Per-agent array alongside `mcpServers`:

```jsonc
// VS Code settings.json
"acpClient.agents.opencode": {
  "command": "/usr/local/bin/opencode",
  "mcpServers": [...],
  "skills": [
    "~/.agents/skills",          // → %USERPROFILE%\.agents\skills
    ".opencode/skills"            // → ${workspaceFolder}\.opencode\skills
  ]
}
```

### Path Expansion

| Pattern | Expansion |
|---------|-----------|
| `~` prefix | `os.homedir()` (Windows: `%USERPROFILE%`) |
| Relative path | Resolve against workspace root (`vscode.workspace.workspaceFolders[0].uri.fsPath`) |
| Absolute path | Used as-is |

### Discovery Rules

For each path in `skills[]`, scan for subdirectories matching skill naming rules, then read `<dir>/SKILL.md`.

Standard Agent Skills discovery locations (also searched if configured):
- `<path>/<name>/SKILL.md`

Only directories matching `^[a-z0-9]+(-[a-z0-9]+)*$` are considered.

### Parsed Fields

From `SKILL.md` frontmatter (YAML):
- `name` (required) — skill identifier, matches directory name
- `description` (required) — what the skill does
- All other fields ignored for completion purposes

---

## 3. Completion Rules

### Merge Strategy

```typescript
// Pseudocode
function getCompletionItems(query: string): ChatCompletionItem[] {
  const acpCommands = getAclCommands();
  const skillNames = new Set<string>();

  // Skills deduplicated: ACP command wins on name conflict
  const skills = getDiscoveredSkills()
    .filter(skill => !acpCommands.some(cmd => cmd.name === skill.name));

  return [...skills, ...acpCommands]
    .filter(item => matchesQuery(item.name, query))
    .map(toCompletionItem);
}
```

### Completion Item Mapping

| Source | `name` | `insertText` | `icon` |
|--------|--------|--------------|--------|
| ACP command | ACP name | `/<name> ` | `$(terminal-cmd)` |
| Skill | Skill name | `/<name> ` | `$(book)` |

`detail` = description from source. `documentation` = description + hint (for ACP commands).

---

## 4. Timing & Caching

- **Scan timing**: On each chat session create/open (in `AcpSessionManager.createOrGet()`)
- **Cache**: Skills stored in a `Map<string, ScannedSkill>` on `SessionManager`
- **Refresh**: New session triggers a re-scan of all configured paths

---

## 5. Files to Modify

| File | Change |
|------|--------|
| `src/types.ts` | Add `skillPaths?: string[]` to agent config type |
| `src/acpSessionManager.ts` | Add skill discovery + storage; merge into `getKnownAvailableCommands()` |
| `src/acpChatParticipant.ts` | Update `provideCommandCompletionItems` icon/style for skill items |
| `src/agentRegistry.ts` | Read `skills` from agent config |

### New File

| File | Responsibility |
|------|----------------|
| `src/skillDiscovery.ts` | `scanSkillDirectories(paths: string[]): ScannedSkill[]` — expands paths, walks filesystem, parses SKILL.md frontmatter |

### Types (`src/types.ts`)

```typescript
export interface ScannedSkill {
  name: string;
  description: string;
  directory: string; // resolved absolute path to skill dir
}
```

---

## 6. Open Questions (Resolved)

| Question | Answer |
|----------|--------|
| Skill vs ACP command behavior on select? | Same as today — pure `insertText` |
| Name conflict resolution? | ACP command wins, skill hidden |
| Scan timing? | Each session create/open |
| Path expansion? | `~` → homedir, relative → workspace root |
| Config location? | Per-agent `skills[]` alongside `mcpServers` |
