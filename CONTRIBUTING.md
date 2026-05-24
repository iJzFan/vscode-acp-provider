# Contributing

Thanks for helping improve VS Code ACP Client.

## Development Setup

1. Install Node.js `22.x`.
2. Install dependencies with `npm install`.
3. Build with `npm run compile`.
4. Run tests with `npm test`.
5. Run the formatting check with `npm run lint`.

The extension targets VS Code Insiders `1.120.0` or newer and proposed chat APIs. Runtime behavior should be verified in VS Code Insiders when a change touches chat sessions, proposed APIs, or extension activation.

## Pull Request Checklist

- Keep source comments, documentation, issue text, and release notes in English.
- Keep changes focused and avoid committing local VSIX, log, image, or generated output artifacts.
- Update tests for behavior changes.
- Update `CHANGELOG.md` and bump `package.json` for every modification.
- Run `npm run compile` before requesting review.

## Code Style

- TypeScript code is compiled with `tsc` and formatted with Prettier.
- Prefer small modules with clear interfaces over pass-through wrappers.
- Add comments for lifecycle invariants, protocol assumptions, security decisions, and compatibility workarounds.
- Avoid comments that restate obvious code.

## Reporting Issues

Use the GitHub issue templates when possible. Include the VS Code Insiders version, extension version, agent CLI, operating system, relevant settings, and sanitized logs.
