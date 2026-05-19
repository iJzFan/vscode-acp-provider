# vscode-acp-provider Domain Glossary

> Last updated: 2026-05-15

## Terms

### ACP Command
Agent-defined slash command reported via ACP protocol `available_commands_update`. Has `name`, optional `description`, and optional `input.hint`. Stored per session in `SessionManager.availableCommands`.

### Skill
Reusable instruction set defined by a `SKILL.md` file following the [Agent Skills spec](https://agentskills.io/specification). Has YAML frontmatter (`name`, `description` required) plus markdown body. Stored on disk as `<dir>/SKILL.md`.

### Skill Discovery Path
Per-agent configuration array (`acpClient.agents.<id>.skills`) listing directories to scan for skill directories. `~` expands to `os.homedir()`. Relative paths resolve against workspace root.

### Unified Slash Completion
The `/` completion menu in VS Code chat showing both ACP commands and discovered skills, deduplicated with ACP commands taking priority over skills with the same name.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Skill config location | Per-agent `skills` array, alongside `mcpServers` | Matches existing agent configuration pattern |
| Path variable expansion | `~` → home dir, relative → workspace root | Minimal, predictable expansion |
| Name conflict resolution | ACP command wins over skill | ACP is the authoritative runtime source |
| Scan timing | On each chat session create/open | Keeps skills current without polling |
| Behavior on select | Pure completion (`insertText`), no action | User enters the text, ACP handles execution |
