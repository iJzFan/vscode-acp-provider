# Security Policy

## Supported Versions

This project is experimental. Security fixes are applied to the latest released version only.

## Reporting a Vulnerability

Please do not report vulnerabilities in public issues.

Use GitHub private vulnerability reporting if it is enabled for the repository. If it is not available, contact the maintainers privately and include:

- Affected version or commit
- Operating system and VS Code Insiders version
- A clear reproduction path
- Any relevant ACP agent configuration, with secrets removed
- Expected impact

Never include API keys, access tokens, private prompts, or confidential workspace contents in reports.

## Scope

Security-sensitive areas include agent process launch, shell command handling, file-system access, MCP server configuration, permission prompts, and chat transcript rendering.
