import type { ManualCommandConfigurationEntry } from "./types";

function buildManualCommand(
  name: string,
  description: string,
  acceptsArgs: boolean,
): ManualCommandConfigurationEntry {
  return {
    name,
    description,
    ...(acceptsArgs ? { input: { hint: "[args]" } } : {}),
  };
}

export function parseAuggieCommandHelpOutput(
  rawOutput: string,
): ManualCommandConfigurationEntry[] {
  const lines = rawOutput.replace(/\r\n?/g, "\n").split("\n");
  const commands: ManualCommandConfigurationEntry[] = [];
  let inCommandsSection = false;
  let current:
    | {
        name: string;
        description: string;
        acceptsArgs: boolean;
      }
    | undefined;

  const flushCurrent = () => {
    if (!current) {
      return;
    }
    if (current.name === "list|ls" || current.name === "help") {
      current = undefined;
      return;
    }
    commands.push(
      buildManualCommand(
        current.name,
        current.description.trim(),
        current.acceptsArgs,
      ),
    );
    current = undefined;
  };

  for (const line of lines) {
    if (!inCommandsSection) {
      if (/^Commands:\s*$/i.test(line.trim())) {
        inCommandsSection = true;
      }
      continue;
    }

    if (/^(Positionals|Options):\s*$/i.test(line.trim())) {
      break;
    }

    const match = line.match(
      /^\s{2,6}(\S+)(?:\s+(\[[^\]]+\]))?\s+(\S[\s\S]*)$/,
    );
    if (match) {
      flushCurrent();
      const [, rawName, rawArgIndicator, rawDescription] = match;
      current = {
        name: rawName.trim(),
        description: rawDescription.trim(),
        acceptsArgs: rawArgIndicator === "[args...]",
      };
      continue;
    }

    if (current && line.trim()) {
      current.description = `${current.description} ${line.trim()}`;
    }
  }

  flushCurrent();
  return commands;
}
