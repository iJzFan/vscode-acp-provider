function escapeCommandTagValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeCommandToken(value: string): string {
  return value.replace(/^(?:\.\/|\/)+/, "").trim();
}

export function buildStructuredCommandPrompt(params: {
  prompt?: string;
  command?: string;
  knownCommands?: Iterable<string>;
}): string | undefined {
  const trimmedPrompt = params.prompt?.trim() ?? "";
  const explicitCommand = params.command?.trim();

  let commandName: string | undefined;
  let commandArgs: string | undefined;

  if (explicitCommand) {
    commandName = normalizeCommandToken(explicitCommand);
    commandArgs = trimmedPrompt || undefined;
  } else if (trimmedPrompt) {
    const match = trimmedPrompt.match(/^(?<token>(?:\.\/|\/)[^\s]+)(?:\s+(?<args>[\s\S]*))?$/);
    const token = match?.groups?.token;
    if (!token) {
      return undefined;
    }

    const normalizedToken = normalizeCommandToken(token);
    const knownCommands = new Set(
      Array.from(params.knownCommands ?? [], (command) =>
        normalizeCommandToken(command),
      ),
    );
    if (knownCommands.size > 0 && !knownCommands.has(normalizedToken)) {
      return undefined;
    }

    commandName = normalizedToken;
    commandArgs = match?.groups?.args?.trim() || undefined;
  }

  if (!commandName) {
    return undefined;
  }

  const escapedName = escapeCommandTagValue(commandName);
  const tags = [
    `<command-message>/${escapedName}</command-message>`,
    `<command-name>${escapedName}</command-name>`,
  ];

  if (commandArgs) {
    tags.push(
      `<command-args>${escapeCommandTagValue(commandArgs)}</command-args>`,
    );
  }

  return tags.join("\n");
}
