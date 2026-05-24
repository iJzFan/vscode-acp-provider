import { SurfacedCommand, SurfacedCommandSource } from "./types";

const NON_ALPHANUMERIC_REGEX = /[^a-z0-9]+/gi;

export function normalizeSlashCommandQuery(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

export function getShortCommandName(commandName: string): string {
  const canonicalName = normalizeSlashCommandQuery(commandName);
  const segments = canonicalName
    .split(":")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return segments.at(-1) ?? canonicalName;
}

export function normalizeSlashCommandToken(value: string): string {
  return normalizeSlashCommandQuery(value)
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_REGEX, "");
}

export function getSlashCommandMatchScore(
  commandName: string,
  query: string,
): number {
  const normalizedQuery = normalizeSlashCommandToken(query);
  if (!normalizedQuery) {
    return 1;
  }

  const canonicalName = normalizeSlashCommandQuery(commandName);
  const shortName = getShortCommandName(canonicalName);
  const canonicalToken = normalizeSlashCommandToken(canonicalName);
  const shortToken = normalizeSlashCommandToken(shortName);

  if (!canonicalToken) {
    return 0;
  }

  if (shortToken === normalizedQuery) {
    return 500;
  }
  if (canonicalToken === normalizedQuery) {
    return 450;
  }
  if (shortToken.startsWith(normalizedQuery)) {
    return 400;
  }
  if (canonicalToken.startsWith(normalizedQuery)) {
    return 350;
  }
  if (shortToken.includes(normalizedQuery)) {
    return 250;
  }
  if (canonicalToken.includes(normalizedQuery)) {
    return 200;
  }

  return 0;
}

export function formatSlashCommandLabel(commandName: string): string {
  const canonicalName = normalizeSlashCommandQuery(commandName);
  const shortName = getShortCommandName(canonicalName);

  return shortName === canonicalName
    ? `/${canonicalName}`
    : `/${shortName} ↦ /${canonicalName}`;
}

export function buildSlashCommandFilterText(commandName: string): string {
  const canonicalName = normalizeSlashCommandQuery(commandName);
  const shortName = getShortCommandName(canonicalName);

  return shortName === canonicalName
    ? `/${canonicalName}`
    : `/${canonicalName} /${shortName}`;
}

export function buildAvailableCommandLogSummary(
  commands: readonly Pick<SurfacedCommand, "name" | "source">[],
  maxVisible: number = 5,
): string {
  if (!commands.length) {
    return "none";
  }

  const visibleCommands = commands
    .slice(0, maxVisible)
    .map(
      (command) =>
        `${formatSlashCommandLabel(command.name)} ${formatCommandSourceBadge(command.source)}`,
    );
  const remainingCount = commands.length - visibleCommands.length;

  return remainingCount > 0
    ? `${visibleCommands.join(", ")} (+${remainingCount} more)`
    : visibleCommands.join(", ");
}

export function formatCommandSourceBadge(
  source: SurfacedCommandSource,
): string {
  return source === "manual" ? "[manual]" : "[ACP]";
}

export function toManualSurfacedCommand(
  command: Pick<SurfacedCommand, "name" | "description" | "input">,
): SurfacedCommand {
  return {
    name: command.name,
    description: command.description,
    input: command.input,
    source: "manual",
  };
}
