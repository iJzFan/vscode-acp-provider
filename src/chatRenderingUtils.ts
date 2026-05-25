// SPDX-License-Identifier: Apache-2.0
import {
  ToolCall,
  ToolCallUpdate,
  type ToolCallStatus,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import * as path from "path";
import { currentWorkspaceRoot } from "./types";

const INSERT_CHAT_TEXT_COMMAND = "acp.insertChatText";

/**
 * Builds a markdown link that, when clicked, pre-fills the VS Code chat input
 * with the given command text without sending it.
 *
 * @param label The display text for the link
 * @param commandText The text to pre-fill in the chat input
 * @returns A markdown link string using the `command:` URI scheme
 */
export function makeCommandLink(label: string, commandText: string): string {
  const args = encodeURIComponent(JSON.stringify([commandText]));
  return `[${label}](command:${INSERT_CHAT_TEXT_COMMAND}?${args})`;
}

/**
 * Creates a `MarkdownString` with the given content that has the
 * `acp.insertChatText` command trusted, enabling inline `command:` links
 * produced by {@link makeCommandLink} to be clickable in chat responses.
 *
 * @param content The markdown content string (may include command: links)
 * @returns A trusted `MarkdownString` for use with `ChatResponseStream.markdown()`
 */
export function trustedCommandMarkdown(content: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(content);
  md.isTrusted = { enabledCommands: [INSERT_CHAT_TEXT_COMMAND] };
  return md;
}

const DEFAULT_TERMINAL_LANGUAGE = "shell";

export type ToolInfo = {
  toolCallId: string;
  name: string;
  kind: ToolKind | "terminal";
  input?: string;
  output?: string;
  resources?: vscode.Uri[];
};

type ToolQuestionPayloadOption = {
  label?: unknown;
  description?: unknown;
};

type ToolQuestionPayload = {
  question?: unknown;
  header?: unknown;
  options?: unknown;
};

type ToolQuestionPayloadContainer = {
  questions?: unknown;
};

type StructuredToolOutputSection = {
  label: string;
  value: string;
};

type ToolOutputData = {
  text: string;
  mimeType: string;
};

type WrappedCommandResult = {
  exitCode?: number;
  output: string;
};

type AcpTaggedOutputTag = "path" | "type" | "entries" | "content";

const ACP_TAGGED_OUTPUT_REGEX =
  /<(path|type|entries|content)>([\s\S]*?)<\/\1>/gi;
const ANSI_ESCAPE_REGEX = /(?:\u001b|ESC)\[[0-9;?]*[ -/]*[@-~]/gi;
const C1_ANSI_ESCAPE_REGEX = /\u009b[0-?]*[ -/]*[@-~]/g;
const BARE_ANSI_STYLE_REGEX = /\[(?:\d{1,3}(?:;\d{1,3})*)m/g;
const JEKYLL_CODE_OPEN_REGEX = /^\s*{%\s*code(?:\s+[^%]+)?\s*%}\s*$/gim;
const JEKYLL_CODE_CLOSE_REGEX = /^\s*{%\s*endcode\s*%}\s*$/gim;
const FIGURE_TAG_REGEX =
  /<figure>\s*<img\b([^>]*)>\s*(?:<figcaption>([\s\S]*?)<\/figcaption>)?\s*<\/figure>/gi;
const HTML_ATTRIBUTE_REGEX = /([a-zA-Z:-]+)\s*=\s*"([^"]*)"/g;
const WRAPPED_COMMAND_RESULT_REGEX =
  /^(?:Here are the results from executing the command\.\n)?<return-code>\n([\s\S]*?)\n<\/return-code>\n<output>\n([\s\S]*?)\n<\/output>$/i;

function formatPowerShellCliXml(value: string): string {
  const marker = "#< CLIXML";
  const index = value.indexOf(marker);
  if (index < 0) {
    return value;
  }

  const leadingText = value.slice(0, index).trimEnd();
  const clixmlText = value.slice(index).trim();
  const trailingPayload = clixmlText.slice(marker.length).trimStart();
  const progressXmlIndex = trailingPayload.indexOf("<Objs Version=");
  if (progressXmlIndex >= 0) {
    const payloadText = trailingPayload.slice(0, progressXmlIndex).trim();
    if (payloadText) {
      return [leadingText, payloadText]
        .filter((part) => part.length > 0)
        .join("\n\n");
    }
  }

  if (index === 0) {
    return clixmlText;
  }

  return [leadingText, "PowerShell CLIXML:", clixmlText]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function parseWrappedCommandResult(
  value: string,
): WrappedCommandResult | undefined {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const match = normalized.match(WRAPPED_COMMAND_RESULT_REGEX);
  if (!match) {
    return undefined;
  }

  const parsedExitCode = Number.parseInt(match[1].trim(), 10);
  return {
    exitCode: Number.isFinite(parsedExitCode) ? parsedExitCode : undefined,
    output: match[2].trimEnd(),
  };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function stripAnsiSequences(value: string): string {
  return value
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(C1_ANSI_ESCAPE_REGEX, "")
    .replace(BARE_ANSI_STYLE_REGEX, "");
}

function normalizeTerminalOutputText(value: string): string {
  return stripAnsiSequences(value).replace(/\r\n?/g, "\n").trimEnd();
}

function parseHtmlAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  HTML_ATTRIBUTE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = HTML_ATTRIBUTE_REGEX.exec(value)) !== null) {
    attributes[match[1].toLowerCase()] = decodeXmlEntities(match[2]);
  }

  return attributes;
}

function normalizeMarkdownPreview(value: string): string {
  const normalized = decodeXmlEntities(value).replace(/\r\n?/g, "\n").trim();
  const withCodeFences = normalized
    .replace(JEKYLL_CODE_OPEN_REGEX, "```")
    .replace(JEKYLL_CODE_CLOSE_REGEX, "```");

  return withCodeFences.replace(
    FIGURE_TAG_REGEX,
    (_match, imgAttributes: string, captionRaw?: string) => {
      const attributes = parseHtmlAttributes(imgAttributes);
      const caption = stripHtmlTags(decodeXmlEntities(captionRaw ?? "")).trim();
      const alt = (attributes.alt ?? "").trim();
      const src = (attributes.src ?? "").trim();
      const summary = caption || alt || "Image";
      const lines = [`> Figure: ${summary}`];
      if (src) {
        lines.push(`> Image source: ${src}`);
      }
      return lines.join("\n");
    },
  );
}

function looksLikeMarkdownContent(value: string): boolean {
  return (
    /(?:^|\n)\s{0,3}#{1,6}\s+\S/m.test(value) ||
    /(?:^|\n)\s*[-*+]\s+\S/m.test(value) ||
    /(?:^|\n)\s*\d+\.\s+\S/m.test(value) ||
    /```/.test(value) ||
    /\[[^\]]+\]\([^)]+\)/.test(value) ||
    /<figure\b/i.test(value) ||
    /{%\s*(?:code|endcode)\b/i.test(value)
  );
}

function normalizeAcpTaggedFreeText(value: string): string | undefined {
  const normalized = decodeXmlEntities(value).replace(/\s+/g, " ").trim();
  if (!normalized || /^[,;:|—–-]+$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeAcpTaggedBody(
  tag: AcpTaggedOutputTag,
  value: string,
): string {
  const normalized = stripAnsiSequences(
    decodeXmlEntities(value).replace(/\r\n?/g, "\n").trim(),
  );
  if (
    tag === "content" &&
    normalized &&
    !normalized.includes("\n") &&
    /(?:^|\s)\d+:\s/.test(normalized)
  ) {
    return normalized.replace(/\s(?=\d+:\s)/g, "\n");
  }
  return normalized;
}

function formatAcpTaggedOutput(value: string): string | undefined {
  if (!/(?:<path>|<type>|<entries>|<content>)/i.test(value)) {
    return undefined;
  }

  ACP_TAGGED_OUTPUT_REGEX.lastIndex = 0;
  const blocks: string[] = [];
  let currentLines: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const flushCurrent = (): void => {
    if (!currentLines.length) {
      return;
    }
    blocks.push(currentLines.join("\n"));
    currentLines = [];
  };

  const pushFreeText = (text: string): void => {
    const normalized = normalizeAcpTaggedFreeText(text);
    if (normalized) {
      currentLines.push(normalized);
    }
  };

  while ((match = ACP_TAGGED_OUTPUT_REGEX.exec(value)) !== null) {
    pushFreeText(value.slice(lastIndex, match.index));

    const tag = match[1].toLowerCase() as AcpTaggedOutputTag;
    const body = normalizeAcpTaggedBody(tag, match[2]);
    if (!body) {
      lastIndex = match.index + match[0].length;
      continue;
    }

    if (tag === "path" && currentLines.length > 0) {
      flushCurrent();
    }

    switch (tag) {
      case "path":
        currentLines.push(`Path: ${body}`);
        break;
      case "type":
        currentLines.push(`Type: ${body}`);
        break;
      case "entries":
        currentLines.push(`Entries:\n${body}`);
        break;
      case "content":
        currentLines.push(`Content:\n${body}`);
        break;
    }

    lastIndex = match.index + match[0].length;
  }

  pushFreeText(value.slice(lastIndex));
  flushCurrent();

  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

function formatToolOutputValue(value: string): string {
  const unwrapped = parseWrappedCommandResult(value)?.output ?? value;
  const ansiNormalized = normalizeTerminalOutputText(unwrapped);
  const cliXmlFormatted = formatPowerShellCliXml(ansiNormalized);
  if (cliXmlFormatted !== ansiNormalized) {
    return looksLikeMarkdownContent(cliXmlFormatted)
      ? normalizeMarkdownPreview(cliXmlFormatted)
      : cliXmlFormatted;
  }

  const formatted = formatAcpTaggedOutput(cliXmlFormatted) ?? cliXmlFormatted;
  return looksLikeMarkdownContent(formatted)
    ? normalizeMarkdownPreview(formatted)
    : formatted;
}

function getStructuredToolOutputSections(
  rawOutput: Record<string, unknown>,
): StructuredToolOutputSection[] {
  const sections: StructuredToolOutputSection[] = [];
  const seenValues = new Set<string>();
  const candidates: Array<[string, unknown]> = [
    ["formatted output", rawOutput.formatted_output],
    ["aggregated output", rawOutput.aggregated_output],
    ["raw output", rawOutput.output],
  ];

  for (const [label, rawValue] of candidates) {
    if (typeof rawValue !== "string") {
      continue;
    }

    const value = formatToolOutputValue(rawValue).trim();
    if (!value || seenValues.has(value)) {
      continue;
    }

    seenValues.add(value);
    sections.push({ label, value });
  }

  return sections;
}

function formatStructuredToolOutput(
  rawOutput: Record<string, unknown>,
): string | undefined {
  const sections = getStructuredToolOutputSections(rawOutput);
  if (sections.length === 0) {
    return undefined;
  }

  if (sections.length === 1) {
    return sections[0].value;
  }

  return sections
    .map((section) => `=== ${section.label} ===\n${section.value}`)
    .join("\n\n");
}

export function getToolInfo(
  toolCallUpdate: ToolCallUpdate | ToolCall,
): ToolInfo {
  const response: ToolInfo = {
    toolCallId: toolCallUpdate.toolCallId,
    name: toolCallUpdate.title || "",
    kind: toolCallUpdate.kind || "terminal",
  };

  if (
    toolCallUpdate.status !== "completed" &&
    toolCallUpdate.status !== "failed"
  ) {
    response.input = getToolInputText(toolCallUpdate.rawInput);
    if (!response.input) {
      toolCallUpdate.content
        ?.filter((c) => c.type === "content")
        .map((c) => c.content)
        .filter((c) => c.type === "text")
        .reduce((acc, curr) => {
          response.input = acc + curr.text;
          return response.input;
        }, "");
    }
    if (response.name === "" && response.input) {
      const firstLine = response.input.split("\n")[0];
      response.name =
        firstLine.length > 30 ? firstLine.substring(0, 30) + "..." : firstLine;
    }
  } else {
    if (
      toolCallUpdate.rawOutput &&
      typeof toolCallUpdate.rawOutput === "object"
    ) {
      const rawOutput = toolCallUpdate.rawOutput as Record<string, unknown>;
      response.input =
        getToolInputText(rawOutput) ??
        getToolInputText(toolCallUpdate.rawInput);
      if (response.name === "" && response.input) {
        const firstLine = response.input.split("\n")[0];
        response.name =
          firstLine.length > 30
            ? firstLine.substring(0, 30) + "..."
            : firstLine;
      }

      const structuredOutput = formatStructuredToolOutput(rawOutput);
      if (structuredOutput) {
        response.output = structuredOutput;
      } else if (Object.keys(rawOutput).length > 0) {
        response.output = `${JSON.stringify(rawOutput, null, 2)}`;
      }
    } else {
      toolCallUpdate.content
        ?.filter((c) => c.type === "content")
        .map((c) => c.content)
        .filter((c) => c.type === "text")
        .reduce((acc, curr) => {
          response.output = acc + curr.text;
          return response.output;
        }, "");
    }
  }

  // extract locations and diff paths as edit resources
  const workspaceRoot = currentWorkspaceRoot();
  const resources = new Map<string, vscode.Uri>();

  if (toolCallUpdate.locations) {
    for (const location of toolCallUpdate.locations) {
      const resource = resolveUri(location.path, workspaceRoot);
      resources.set(resource.toString(), resource);
    }
  }

  for (const content of toolCallUpdate.content ?? []) {
    if (content.type !== "diff") {
      continue;
    }
    const resource = resolveUri(content.path, workspaceRoot);
    resources.set(resource.toString(), resource);
  }

  collectToolResourcesFromPayload(
    toolCallUpdate.rawInput,
    resources,
    workspaceRoot,
  );
  collectToolResourcesFromPayload(
    toolCallUpdate.rawOutput,
    resources,
    workspaceRoot,
  );

  if (resources.size > 0) {
    response.resources = Array.from(resources.values());
  }

  return response;
}

type ToolCommandPayload = {
  command?: unknown;
  filePath?: unknown;
  path?: unknown;
  uri?: unknown;
  metadata?: unknown;
};

type ToolMetadataFilePayload = {
  filePath?: unknown;
  relativePath?: unknown;
  path?: unknown;
  uri?: unknown;
};

function getCommandLine(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const { command } = raw as ToolCommandPayload;
  if (typeof command === "string") {
    const normalized = command.trim();
    return normalized || undefined;
  }
  if (!Array.isArray(command)) {
    return undefined;
  }
  const parts = command.filter((part) => typeof part === "string") as string[];
  if (!parts.length) {
    return undefined;
  }
  return parts.join(" ");
}

function getPathInput(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const { filePath, path, uri } = raw as ToolCommandPayload;
  const candidate =
    typeof filePath === "string"
      ? filePath
      : typeof path === "string"
        ? path
        : uri;
  if (typeof candidate !== "string") {
    return undefined;
  }

  const normalized = candidate.trim();
  return normalized || undefined;
}

function looksLikeFilePathArgument(value: string): boolean {
  return Boolean(value) && !value.startsWith("-") && /[\\/]/.test(value);
}

function addResolvedToolResource(
  resources: Map<string, vscode.Uri>,
  rawPath: unknown,
  workspaceRoot: vscode.Uri | undefined,
): void {
  if (typeof rawPath !== "string") {
    return;
  }

  const normalized = rawPath.trim();
  if (!normalized) {
    return;
  }

  try {
    const resource = resolveUri(normalized, workspaceRoot);
    resources.set(resource.toString(), resource);
  } catch {
    // Ignore malformed tool payloads so chat rendering can keep going.
  }
}

function collectToolResourcesFromPayload(
  raw: unknown,
  resources: Map<string, vscode.Uri>,
  workspaceRoot: vscode.Uri | undefined,
): void {
  if (!raw || typeof raw !== "object") {
    return;
  }

  const payload = raw as ToolCommandPayload;
  addResolvedToolResource(resources, payload.filePath, workspaceRoot);
  addResolvedToolResource(resources, payload.path, workspaceRoot);
  addResolvedToolResource(resources, payload.uri, workspaceRoot);

  if (Array.isArray(payload.command)) {
    for (const part of payload.command.slice(1)) {
      if (typeof part === "string" && looksLikeFilePathArgument(part)) {
        addResolvedToolResource(resources, part, workspaceRoot);
      }
    }
  }

  const metadata = payload.metadata;
  if (!metadata || typeof metadata !== "object") {
    return;
  }

  const files = (metadata as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return;
  }

  for (const file of files) {
    if (!file || typeof file !== "object") {
      continue;
    }

    const entry = file as ToolMetadataFilePayload;
    addResolvedToolResource(resources, entry.filePath, workspaceRoot);
    addResolvedToolResource(resources, entry.relativePath, workspaceRoot);
    addResolvedToolResource(resources, entry.path, workspaceRoot);
    addResolvedToolResource(resources, entry.uri, workspaceRoot);
  }
}

function getToolInputText(raw: unknown): string | undefined {
  return getCommandLine(raw) ?? getPathInput(raw);
}

function getToolOutputPreview(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const metadata = (raw as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const preview = (metadata as { preview?: unknown }).preview;
  if (typeof preview !== "string") {
    return undefined;
  }

  const normalized = preview.trim();
  return normalized || undefined;
}

function isMarkdownPath(value: string | undefined): boolean {
  return typeof value === "string" && /\.(?:md|markdown|mdx)$/i.test(value);
}

function getPreferredToolOutputData(
  toolCallUpdate: ToolCallUpdate | ToolCall,
  info: ToolInfo,
): ToolOutputData | undefined {
  const preview = getToolOutputPreview(toolCallUpdate.rawOutput);
  if (preview) {
    const pathInput = getPathInput(toolCallUpdate.rawInput) ?? info.input;
    if (isMarkdownPath(pathInput) || looksLikeMarkdownContent(preview)) {
      return {
        text: normalizeMarkdownPreview(preview),
        mimeType: "text/markdown",
      };
    }

    return {
      text: formatToolOutputValue(preview),
      mimeType: "text/plain",
    };
  }

  if (!info.output) {
    return undefined;
  }

  return {
    text: info.output,
    mimeType: "text/plain",
  };
}

export function getSubAgentInvocationId(
  toolCallUpdate: ToolCallUpdate | ToolCall,
): string | undefined {
  const meta = toolCallUpdate._meta;
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const { subAgentInvocationId } = meta as { subAgentInvocationId?: unknown };
  return typeof subAgentInvocationId === "string"
    ? subAgentInvocationId
    : undefined;
}

export function isTerminalToolInvocation(
  toolCallUpdate: ToolCallUpdate | ToolCall,
  info: ToolInfo,
  fallbackKind?: ToolInfo["kind"],
): boolean {
  const effectiveKind =
    info.kind === "terminal" ? (fallbackKind ?? info.kind) : info.kind;
  return (
    effectiveKind === "execute" ||
    Boolean(getCommandLine(toolCallUpdate.rawInput)) ||
    Boolean(getCommandLine(toolCallUpdate.rawOutput))
  );
}

export function buildTerminalToolInvocationData(
  toolCallUpdate: ToolCallUpdate | ToolCall,
  info: ToolInfo,
  fallbackCommandLine?: string,
): vscode.ChatTerminalToolInvocationData | undefined {
  const commandLine =
    getCommandLine(toolCallUpdate.rawInput) ||
    getCommandLine(toolCallUpdate.rawOutput) ||
    info.input ||
    fallbackCommandLine;
  if (!commandLine) {
    return undefined;
  }

  const data: vscode.ChatTerminalToolInvocationData = {
    language: DEFAULT_TERMINAL_LANGUAGE,
    commandLine: {
      original: commandLine,
    },
  };

  if (info.output) {
    const normalizedOutput = normalizeTerminalOutputText(info.output);
    if (normalizedOutput) {
      data.output = { text: normalizedOutput };
    }
  }

  if (
    toolCallUpdate.rawOutput &&
    typeof toolCallUpdate.rawOutput === "object"
  ) {
    const rawOutput = toolCallUpdate.rawOutput as {
      exitCode?: unknown;
      duration?: unknown;
      output?: unknown;
    };
    const wrappedResult =
      typeof rawOutput.output === "string"
        ? parseWrappedCommandResult(rawOutput.output)
        : undefined;
    const exitCode =
      typeof rawOutput.exitCode === "number"
        ? rawOutput.exitCode
        : wrappedResult?.exitCode;
    const duration =
      typeof rawOutput.duration === "number" ? rawOutput.duration : undefined;
    if (exitCode !== undefined || duration !== undefined) {
      data.state = { exitCode, duration };
    }
  }

  return data;
}

export function buildMcpToolInvocationData(
  toolCallUpdateOrInfo: ToolCallUpdate | ToolCall | ToolInfo,
  maybeInfo?: ToolInfo,
): vscode.ChatMcpToolInvocationData | undefined {
  const toolCallUpdate = maybeInfo
    ? (toolCallUpdateOrInfo as ToolCallUpdate | ToolCall)
    : undefined;
  const info = maybeInfo ?? (toolCallUpdateOrInfo as ToolInfo);
  const outputData = toolCallUpdate
    ? getPreferredToolOutputData(toolCallUpdate, info)
    : info.output
      ? { text: info.output, mimeType: "text/plain" }
      : undefined;

  if (!info.input && !outputData) {
    return undefined;
  }

  const output: vscode.McpToolInvocationContentData[] = [];
  if (outputData) {
    const encoder = new TextEncoder();
    output.push({
      data: encoder.encode(outputData.text),
      mimeType: outputData.mimeType,
    });
  }

  return {
    input: info.input ?? getPathInput(toolCallUpdate?.rawInput) ?? "",
    output,
  };
}

export function getToolCompletionMessage(
  toolCallUpdate: ToolCallUpdate | ToolCall,
  info: ToolInfo,
  fallbackKind?: ToolInfo["kind"],
  fallbackCommandLine?: string,
): string | undefined {
  if (isTerminalToolInvocation(toolCallUpdate, info, fallbackKind)) {
    return (
      getCommandLine(toolCallUpdate.rawInput) ??
      getCommandLine(toolCallUpdate.rawOutput) ??
      info.input ??
      fallbackCommandLine
    );
  }

  const output = info.output?.trim();
  if (!output || output.includes("\n") || output.length > 120) {
    return undefined;
  }

  return output;
}

export function formatCurrentModeUpdateSummary(currentModeId: string): string {
  return `Mode changed: ${currentModeId}`;
}

function getNamedToolSubject(info: ToolInfo): string | undefined {
  const normalized = info.name.trim();
  return normalized || undefined;
}

export function getToolDisplayName(info: ToolInfo): string {
  return getNamedToolSubject(info) ?? "Tool";
}

function getToolKindDisplayName(kind: ToolInfo["kind"]): string {
  return kind.replace(/_/g, " ");
}

export function formatToolLifecycleProgressMessage(
  phase: "started" | "completed" | "failed",
  info: ToolInfo,
): string {
  const phaseLabel =
    phase === "started"
      ? "started"
      : phase === "completed"
        ? "completed"
        : "failed";
  const kindLabel = getToolKindDisplayName(info.kind);
  const subject = getNamedToolSubject(info);
  if (!subject) {
    return `Tool ${phaseLabel}: ${kindLabel}`;
  }

  return `Tool ${phaseLabel}: ${subject} (${kindLabel})`;
}

export function formatToolLifecycleSummary(
  phase: "started" | "completed" | "failed",
  toolCallUpdate: ToolCall | ToolCallUpdate,
  info: ToolInfo,
): string {
  return [
    `Tool ${phase}: id=${toolCallUpdate.toolCallId}`,
    `name=${getToolDisplayName(info)}`,
    `kind=${info.kind}`,
  ].join("; ");
}

export function formatUsageUpdateSummary(args: {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}): string {
  const numberFormat = new Intl.NumberFormat("en-US");
  const percentFormat = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const usageSummary = `${numberFormat.format(args.used)} / ${numberFormat.format(args.size)} tokens (${percentFormat.format(args.size > 0 ? (args.used / args.size) * 100 : 0)}%)`;

  if (!args.cost) {
    return usageSummary;
  }

  return `${usageSummary} — Cost: ${args.cost.currency} ${args.cost.amount}`;
}

function getQuestionPayload(raw: unknown): ToolQuestionPayload[] | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const { questions } = raw as ToolQuestionPayloadContainer;
  if (!Array.isArray(questions)) {
    return undefined;
  }
  return questions.filter(
    (question) => question && typeof question === "object",
  ) as ToolQuestionPayload[] | undefined;
}

function formatQuestionOptionLabel(
  label: string,
  description: string | undefined,
): string {
  if (!description) {
    return label;
  }
  return `${label} — ${description}`;
}

/**
 * Parses question data from a tool call update and builds ChatQuestion objects.
 * @param toolCallUpdate The tool call update containing question data
 * @returns Array of ChatQuestion objects, or undefined if no valid questions found
 */
export function parseQuestions(
  toolCallUpdate: ToolCallUpdate | ToolCall,
): vscode.ChatQuestion[] | undefined {
  const rawQuestions =
    getQuestionPayload(toolCallUpdate.rawInput) ??
    getQuestionPayload(toolCallUpdate.rawOutput);
  if (!rawQuestions || rawQuestions.length === 0) {
    return undefined;
  }

  const questions: vscode.ChatQuestion[] = [];
  rawQuestions.forEach((questionPayload, index) => {
    const header =
      typeof questionPayload.header === "string"
        ? questionPayload.header.trim()
        : "";
    const questionText =
      typeof questionPayload.question === "string"
        ? questionPayload.question.trim()
        : "";
    const title = header || questionText || "Question";
    const message = header && questionText ? questionText : undefined;

    const rawOptions = Array.isArray(questionPayload.options)
      ? (questionPayload.options as ToolQuestionPayloadOption[])
      : [];
    const options: vscode.ChatQuestionOption[] = [];
    rawOptions.forEach((option, optionIndex) => {
      const label = typeof option.label === "string" ? option.label.trim() : "";
      if (!label) {
        return;
      }
      const description =
        typeof option.description === "string"
          ? option.description.trim()
          : undefined;
      options.push({
        id: `${toolCallUpdate.toolCallId}-q${index}-o${optionIndex}`,
        label: formatQuestionOptionLabel(label, description),
        value: label,
      });
    });

    const hasOptions = options.length > 0;
    const allowFreeformInput = hasOptions
      ? options.some((option) =>
          typeof option.value === "string"
            ? option.value.toLowerCase() === "other"
            : false,
        )
      : true;
    const questionType = hasOptions
      ? vscode.ChatQuestionType.SingleSelect
      : vscode.ChatQuestionType.Text;

    questions.push(
      new vscode.ChatQuestion(
        `${toolCallUpdate.toolCallId}-q${index}`,
        questionType,
        title,
        {
          ...(message ? { message } : {}),
          ...(hasOptions ? { options } : {}),
          allowFreeformInput,
        },
      ),
    );
  });

  return questions.length > 0 ? questions : undefined;
}

export function buildQuestionCarouselPart(
  toolCallUpdate: ToolCallUpdate | ToolCall,
): vscode.ChatResponseQuestionCarouselPart | undefined {
  const questions = parseQuestions(toolCallUpdate);
  if (!questions) {
    return undefined;
  }

  return new vscode.ChatResponseQuestionCarouselPart(questions, true);
}

export function buildDiffMarkdown(
  path: string,
  oldText: string | undefined,
  newText: string | undefined,
): vscode.MarkdownString | undefined {
  const diffBody = toInlineDiff(oldText ?? "", newText ?? "");
  if (!diffBody) {
    return undefined;
  }

  const diffMarkdown = new vscode.MarkdownString();
  diffMarkdown.appendMarkdown("**");
  diffMarkdown.appendText(path);
  diffMarkdown.appendMarkdown("**\n\n");
  diffMarkdown.appendCodeblock(diffBody, "diff");
  return diffMarkdown;
}

function normalizeDiffText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function splitDiffLines(text: string): string[] {
  if (!text.length) {
    return [];
  }

  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

export function toInlineDiff(oldText: string, newText: string): string {
  const original = normalizeDiffText(oldText);
  const updated = normalizeDiffText(newText);

  if (original === updated) {
    return "";
  }

  const oldLines = splitDiffLines(original);
  const newLines = splitDiffLines(updated);
  const m = oldLines.length;
  const n = newLines.length;

  const lcs = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  type DiffOp = { type: "common" | "add" | "remove"; line: string };
  const script: DiffOp[] = [];
  let i = 0;
  let j = 0;

  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      script.push({ type: "common", line: oldLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      script.push({ type: "remove", line: oldLines[i] });
      i++;
    } else {
      script.push({ type: "add", line: newLines[j] });
      j++;
    }
  }

  while (i < m) {
    script.push({ type: "remove", line: oldLines[i] });
    i++;
  }
  while (j < n) {
    script.push({ type: "add", line: newLines[j] });
    j++;
  }

  const hasChanges = script.some((part) => part.type !== "common");
  if (!hasChanges) {
    return "";
  }

  const diffLines: string[] = ["--- original", "+++ modified"];
  const oldStart = m > 0 ? 1 : 0;
  const newStart = n > 0 ? 1 : 0;
  diffLines.push(`@@ -${oldStart},${m} +${newStart},${n} @@`);

  for (const part of script) {
    const prefix =
      part.type === "add" ? "+" : part.type === "remove" ? "-" : " ";
    diffLines.push(`${prefix}${part.line}`);
  }

  return diffLines.join("\n");
}

const FILE_SCHEME_REGEX = /^file:\/+?/i;
const SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_DRIVE_REGEX = /^[a-zA-Z]:[\\/]/;

export function normalizeDiffPath(input: string): string {
  // Strip an explicit file: scheme if present, but preserve absolute/relative form
  return input ? input.replace(FILE_SCHEME_REGEX, "") : input;
}

function isWindowsDrivePath(value: string): boolean {
  return WINDOWS_DRIVE_REGEX.test(value);
}

function splitPathSegments(value: string): string[] {
  return path.normalize(value).split(path.sep).filter(Boolean);
}

function getWorkspaceRelativePath(
  workspaceRoot: vscode.Uri | undefined,
  absPath: string,
): string | undefined {
  if (!workspaceRoot?.fsPath) {
    return undefined;
  }
  const relative = path.relative(workspaceRoot.fsPath, absPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

function toWorkspaceUriOrFile(
  absPath: string,
  workspaceRoot: vscode.Uri | undefined,
): vscode.Uri {
  const relative = getWorkspaceRelativePath(workspaceRoot, absPath);
  if (relative && workspaceRoot) {
    return vscode.Uri.joinPath(workspaceRoot, ...splitPathSegments(relative));
  }
  return vscode.Uri.file(absPath);
}

export function resolveUri(
  inputPath: string,
  workspaceRoot: vscode.Uri | undefined,
): vscode.Uri {
  const raw = (inputPath ?? "").trim();

  // If it has an explicit scheme (file:, http:, vscode-remote:, etc.) and is not
  // a Windows drive letter, parse as a URI.
  if (SCHEME_REGEX.test(raw) && !isWindowsDrivePath(raw)) {
    try {
      const parsed = vscode.Uri.parse(raw);
      if (parsed.scheme !== "file") {
        return parsed;
      }
      if (parsed.fsPath) {
        return toWorkspaceUriOrFile(parsed.fsPath, workspaceRoot);
      }
      return parsed;
    } catch {
      // fall through to other resolution strategies
    }
  }

  // Remove any leading file: prefix left over and normalize the path string
  const cleaned = normalizeDiffPath(raw);

  // If the cleaned path is absolute on this platform, treat it as an absolute file path
  if (path.isAbsolute(cleaned) || isWindowsDrivePath(cleaned)) {
    return toWorkspaceUriOrFile(path.normalize(cleaned), workspaceRoot);
  }

  // Otherwise treat as a workspace-relative path when a workspace root is available
  if (workspaceRoot) {
    return vscode.Uri.joinPath(workspaceRoot, ...splitPathSegments(cleaned));
  }

  // Last resort: resolve relative to the current working directory
  return vscode.Uri.file(path.resolve(cleaned));
}

export function buildDiffStats(
  oldText: string | undefined,
  newText: string | undefined,
): { added: number; removed: number } {
  const original = normalizeDiffText(oldText ?? "");
  const updated = normalizeDiffText(newText ?? "");
  if (original === updated) {
    return { added: 0, removed: 0 };
  }
  const oldLines = splitDiffLines(original);
  const newLines = splitDiffLines(updated);
  const m = oldLines.length;
  const n = newLines.length;
  const lcs = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }
  let i = 0;
  let j = 0;
  let removed = 0;
  let added = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      removed++;
      i++;
    } else {
      added++;
      j++;
    }
  }
  removed += m - i;
  added += n - j;
  return { added, removed };
}
