# Project Guidelines

## Exploration

- ALWAYS USE subagents for code explorations when they are AVAILABLE.

### When to prefer codegraph over native search

Do use `mcp_codegraph_*` for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

## Build And Release

- Install deps with `npm install`.
- Must Build with `npm run compile` after every modification.
- Must Package release artifacts with `npm run package` when a VSIX is needed.
- Runtime target is VS Code Insiders `1.120+` with proposed chat APIs enabled.
- Keep the Windows-safe clean script intact; do not reintroduce Unix-only `rm -rf` into release scripts.

## Versioning Policy

- Every modification must update the version in `package.json` and the corresponding entry in `CHANGELOG.md`, then run a build.
- New feature work bumps the minor version: `x.y.z` -> `x.(y+1).0`.
- Bug fixes, maintenance changes, and documentation-only fixes bump the patch version: `x.y.z` -> `x.y.(z+1)`.
- If a change is packaged for distribution, ensure the generated VSIX version matches `package.json`.

## Project Conventions

- When user requests new test scenarios, update `src/testScenarios.ts` with the requested scenarios.
- Keep solutions feasible against the VS Code extension API and the enabled proposed APIs.
- For proposed chat/session features, verify behavior against the local `vscode*.d.ts` files and current VS Code API docs before implementing.
- Preserve untitled chat-session resource normalization in `src/chatIdentifiers.ts`; changing that breaks live ACP session lookup during bootstrap.
- Guard newer proposed runtime surfaces before using them directly in activation code.

## Project References

- Architecture and current behavior: `docs/codebase-knowledge.md`
- Compatibility plan: `docs/acp-vscode-1.120-compatibility-plan.md`
- Forward roadmap: `docs/acp-schema-driven-roadmap.md`
- ACP schema: https://agentclientprotocol.com/protocol/schema
- VS Code Extension API: https://code.visualstudio.com/api/references/vscode-api

## External References

- https://github.com/microsoft/vscode-copilot-chat.git
- https://github.com/zed-industries/claude-agent-acp
- https://github.com/anomalyco/opencode
