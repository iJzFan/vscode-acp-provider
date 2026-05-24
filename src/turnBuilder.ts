// SPDX-License-Identifier: Apache-2.0
import {
  ContentBlock,
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import {
  buildMcpToolInvocationData,
  buildQuestionCarouselPart,
  buildTerminalToolInvocationData,
  formatCurrentModeUpdateSummary,
  formatToolLifecycleSummary,
  formatUsageUpdateSummary,
  getSubAgentInvocationId,
  getToolCompletionMessage,
  getToolInfo,
  isTerminalToolInvocation,
  resolveUri,
  type ToolInfo,
} from "./chatRenderingUtils";
import {
  buildToolDiffJumpCommands,
  collectToolDiffArtifacts,
  collectToolMetadataDiffArtifacts,
  createToolDiffPart,
  getToolDiffArtifactKey,
  mergeToolDiffArtifacts,
} from "./diffRendering";
import { currentWorkspaceRoot } from "./types";

type ParsedUserMessage = {
  userMessages: string;
  references: vscode.ChatPromptReference[];
};

export class TurnBuilder {
  private currentUserMessage = "";
  private currentUserReferences: vscode.ChatPromptReference[] = [];
  private currentAgentParts: vscode.ExtendedChatResponsePart[] = [];
  private currentAgentMetadata: Record<string, unknown> = {};
  private agentMessageChunks: string[] = [];
  private turns: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> = [];
  private readonly toolCallParts = new Map<
    string,
    {
      part: vscode.ChatToolInvocationPart;
      kind?: ToolInfo["kind"];
      invocationMessage?: string;
    }
  >();
  private readonly questionToolCalls = new Set<string>();
  private readonly cumulativeDiffArtifacts = new Map<
    string,
    import("./diffRendering").ToolDiffArtifact
  >();
  private lastModeId: string | undefined;

  constructor(
    private readonly participantId: string,
    private readonly logger: vscode.LogOutputChannel,
  ) {}

  processNotification(notification: SessionNotification): void {
    const update = notification.update;

    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        this.flushPendingAgentMessage();
        this.captureUserMessageChunk(update.content);
        break;
      }
      case "agent_message_chunk": {
        this.flushPendingUserMessage();
        this.captureAgentMessageChunk(update.content);
        break;
      }
      case "agent_thought_chunk": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        const thought = this.getContentText(update.content);
        if (thought?.trim()) {
          this.currentAgentParts.push(
            new vscode.ChatResponseProgressPart(thought.trim()),
          );
        }
        break;
      }
      case "tool_call": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        this.appendToolCall(update as ToolCall);
        break;
      }
      case "tool_call_update": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        this.appendToolUpdate(update as ToolCallUpdate);
        break;
      }
      case "plan": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        this.appendPlanEntries(update.entries);
        break;
      }
      case "current_mode_update": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        if (
          typeof update.currentModeId === "string" &&
          update.currentModeId !== this.lastModeId
        ) {
          this.currentAgentParts.push(
            new vscode.ChatResponseProgressPart(
              formatCurrentModeUpdateSummary(update.currentModeId),
            ),
          );
          this.lastModeId = update.currentModeId;
        }
        break;
      }
      case "usage_update": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        if (
          typeof update.used === "number" &&
          typeof update.size === "number"
        ) {
          this.currentAgentParts.push(
            new vscode.ChatResponseProgressPart(
              formatUsageUpdateSummary({
                used: update.used,
                size: update.size,
                cost: update.cost ?? undefined,
              }),
            ),
          );
        }
        break;
      }
      case "available_commands_update":
      case "config_option_update":
      case "session_info_update":
        break;
    }
  }

  getTurns(): Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> {
    this.flushPendingUserMessage();
    this.flushPendingAgentMessage();
    if (this.cumulativeDiffArtifacts.size > 0) {
      const cumulativeArtifacts = Array.from(
        this.cumulativeDiffArtifacts.values(),
      );
      const cumulativePart = createToolDiffPart(cumulativeArtifacts, {
        includeGoToFileUri: false,
      });
      if (cumulativePart) {
        cumulativePart.title = "Modified files";
        this.currentAgentParts.push(cumulativePart);
        for (const command of buildToolDiffJumpCommands(cumulativeArtifacts)) {
          this.currentAgentParts.push(
            new vscode.ChatResponseCommandButtonPart(command),
          );
        }
        this.flushPendingAgentMessage();
      }
    }
    return [...this.turns];
  }

  reset(): void {
    this.currentUserMessage = "";
    this.currentUserReferences = [];
    this.currentAgentParts = [];
    this.currentAgentMetadata = {};
    this.agentMessageChunks = [];
    this.turns = [];
    this.toolCallParts.clear();
    this.questionToolCalls.clear();
    this.cumulativeDiffArtifacts.clear();
  }

  private captureUserMessageChunk(content: ContentBlock): void {
    const text = this.getContentText(content);
    if (!text) {
      return;
    }
    const parsed = this.parseUserChunk(text);
    if (parsed.userMessages) {
      this.currentUserMessage += parsed.userMessages;
    }
    if (parsed.references.length) {
      this.currentUserReferences.push(...parsed.references);
    }
  }

  private captureAgentMessageChunk(content: ContentBlock): void {
    const text = this.getContentText(content);
    if (text) {
      this.agentMessageChunks.push(text);
    }
  }

  private appendToolCall(update: ToolCall): void {
    const info = getToolInfo(update);
    this.currentAgentParts.push(
      new vscode.ChatResponseProgressPart(
        formatToolLifecycleSummary("started", update, info),
      ),
    );
    const invocation = new vscode.ChatToolInvocationPart(
      info.name || "Tool",
      update.toolCallId,
    );
    invocation.originMessage = info.name || "Tool";
    if (info.input) {
      invocation.invocationMessage = info.input;
    }
    const subAgentInvocationId = getSubAgentInvocationId(update);
    if (subAgentInvocationId) {
      invocation.subAgentInvocationId = subAgentInvocationId;
    }
    this.toolCallParts.set(update.toolCallId, {
      part: invocation,
      kind: info.kind,
      invocationMessage: info.input,
    });
    this.currentAgentParts.push(invocation);
  }
  private appendToolUpdate(update: ToolCallUpdate): void {
    const tracked = this.toolCallParts.get(update.toolCallId);
    if (!tracked) {
      return;
    }
    const part = tracked.part;
    const info = getToolInfo(update);

    if (update.status !== "completed" && update.status !== "failed") {
      if (!this.questionToolCalls.has(update.toolCallId)) {
        const questionPart = buildQuestionCarouselPart(update);
        if (questionPart) {
          this.currentAgentParts.push(questionPart);
          this.questionToolCalls.add(update.toolCallId);
        }
      }
      if (info.input) {
        part.invocationMessage = info.input;
        tracked.invocationMessage = info.input;
      }
      return;
    }

    this.questionToolCalls.delete(update.toolCallId);
    part.isConfirmed = update.status === "completed";
    part.isError = update.status === "failed" ? true : false;
    part.isComplete = true;
    const invocationMessage = info.input ?? tracked.invocationMessage;
    if (invocationMessage) {
      part.invocationMessage = invocationMessage;
    }
    const completionMessage = getToolCompletionMessage(
      update,
      info,
      tracked.kind,
      tracked.invocationMessage,
    );
    if (completionMessage) {
      part.pastTenseMessage = completionMessage;
    }
    const subAgentInvocationId = getSubAgentInvocationId(update);
    if (subAgentInvocationId) {
      part.subAgentInvocationId = subAgentInvocationId;
    }
    const terminalData = isTerminalToolInvocation(update, info, tracked.kind)
      ? buildTerminalToolInvocationData(update, info, tracked.invocationMessage)
      : undefined;
    part.toolSpecificData =
      terminalData ?? buildMcpToolInvocationData(update, info);
    this.currentAgentParts.push(
      new vscode.ChatResponseProgressPart(
        formatToolLifecycleSummary(
          update.status === "failed" ? "failed" : "completed",
          update,
          info,
        ),
      ),
    );
    this.toolCallParts.delete(update.toolCallId);

    const artifactsByKey = new Map<
      string,
      import("./diffRendering").ToolDiffArtifact
    >();
    for (const artifact of [
      ...collectToolDiffArtifacts(update, currentWorkspaceRoot()),
      ...collectToolMetadataDiffArtifacts(update, currentWorkspaceRoot()),
    ]) {
      const key = getToolDiffArtifactKey(artifact.fileUri);
      const existing = artifactsByKey.get(key);
      artifactsByKey.set(
        key,
        existing ? mergeToolDiffArtifacts(existing, artifact) : artifact,
      );
    }

    const artifacts = Array.from(artifactsByKey.values());
    if (!artifacts.length) {
      return;
    }

    for (const artifact of artifacts) {
      const key = getToolDiffArtifactKey(artifact.fileUri);
      const existing = this.cumulativeDiffArtifacts.get(key);
      this.cumulativeDiffArtifacts.set(
        key,
        existing ? mergeToolDiffArtifacts(existing, artifact) : artifact,
      );
    }

    const diffPart = createToolDiffPart(artifacts);
    if (diffPart) {
      this.currentAgentParts.push(diffPart);
    }
  }

  private appendPlanEntries(
    entries: Array<{ content: string; status?: string }>,
  ): void {
    if (!entries.length) {
      return;
    }
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown("## Plan\n");
    for (const entry of entries) {
      const checkbox = entry.status === "completed" ? "x" : " ";
      markdown.appendMarkdown("-  [" + checkbox + "] " + entry.content + "\n");
    }
    this.currentAgentParts.push(new vscode.ChatResponseMarkdownPart(markdown));
  }

  private flushPendingUserMessage(): void {
    if (!this.currentUserMessage.trim()) {
      return;
    }
    this.turns.push(
      new vscode.ChatRequestTurn2(
        this.currentUserMessage,
        undefined,
        this.currentUserReferences,
        this.participantId,
        [],
        undefined,
      ),
    );
    this.currentUserMessage = "";
    this.currentUserReferences = [];
  }

  private flushAgentMessageChunksToMarkdown(): void {
    if (!this.agentMessageChunks.length) {
      return;
    }
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(this.agentMessageChunks.join(""));
    this.agentMessageChunks = [];
    this.currentAgentParts.push(new vscode.ChatResponseMarkdownPart(markdown));
  }

  private flushPendingAgentMessage(): void {
    this.flushAgentMessageChunksToMarkdown();
    if (!this.currentAgentParts.length) {
      return;
    }
    const result =
      Object.keys(this.currentAgentMetadata).length > 0
        ? { metadata: this.currentAgentMetadata }
        : {};
    const responseTurn = new vscode.ChatResponseTurn2(
      this.currentAgentParts,
      result,
      this.participantId,
    );
    this.turns.push(responseTurn);
    this.currentAgentParts = [];
    this.currentAgentMetadata = {};
  }

  private getContentText(
    content: ContentBlock | undefined,
  ): string | undefined {
    if (!content) {
      return undefined;
    }
    if (content.type === "text") {
      return content.text;
    }
    return undefined;
  }

  private decodeXmlEntities(value: string): string {
    return value
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  private parseUserChunk(raw: string): ParsedUserMessage {
    const xmlOutput = this.parseXmlLineUserChunk(raw);
    if (xmlOutput.userMessages || xmlOutput.references.length) {
      this.logger.debug("User message chunk parsed using XML format");
      return xmlOutput;
    }
    const colonOutput = this.parseColonSeparatedUserChunk(raw);
    if (colonOutput.userMessages || colonOutput.references.length) {
      this.logger.debug("User message chunk parsed using Colon format");
      return colonOutput;
    }
    this.logger.debug(
      "User message chunk could not be parsed, returning raw value",
    );
    return { userMessages: raw, references: [] };
  }

  private parseXmlLineUserChunk(raw: string): ParsedUserMessage {
    const workspaceRoot = currentWorkspaceRoot();
    const references: vscode.ChatPromptReference[] = [];
    let userMessages = raw;

    const extractTagValue = (tagName: string): string | undefined => {
      const pattern = new RegExp(
        "<" + tagName + ">([\\s\\S]*?)<\\/" + tagName + ">",
        "i",
      );
      const match = raw.match(pattern);
      return match?.[1]?.trim();
    };

    const commandMessage = extractTagValue("command-message");
    const commandName = extractTagValue("command-name");
    const commandArgs = extractTagValue("command-args");
    const normalizeCommandName = (value: string): string =>
      value.replace(/^(?:\.\/|\/)+/, "").trim();

    let slashCommand = "";
    if (commandMessage) {
      slashCommand =
        "/" +
        normalizeCommandName(this.decodeXmlEntities(commandMessage.trim()));
    } else if (commandName) {
      slashCommand =
        "/" + normalizeCommandName(this.decodeXmlEntities(commandName));
    }
    if (slashCommand && commandArgs) {
      slashCommand = slashCommand + " " + this.decodeXmlEntities(commandArgs);
    } else if (!slashCommand && commandArgs) {
      slashCommand = " " + this.decodeXmlEntities(commandArgs);
    }

    userMessages = userMessages
      .replace(/<command-message>[\s\S]*?<\/command-message>/gi, "")
      .replace(/<command-name>[\s\S]*?<\/command-name>/gi, "")
      .replace(/<command-args>[\s\S]*?<\/command-args>/gi, "");

    const contextTagPattern = /<context\s+ref="([^"]+)"[\s\S]*?<\/context>/g;
    userMessages = userMessages.replace(contextTagPattern, (_match, ref) => {
      const uri = resolveUri(ref, workspaceRoot);
      const name = vscode.workspace.asRelativePath(uri, false);
      references.push({ id: name, name, value: uri });
      return "";
    });

    const markdownRefPattern = /\[@([^\]]+)\]\(([^)]+)\)/g;
    userMessages = userMessages.replace(
      markdownRefPattern,
      (_match, name, ref) => {
        const uri = resolveUri(ref, workspaceRoot);
        references.push({ id: name, name, value: uri });
        return "";
      },
    );

    const cleanedMessage = this.decodeXmlEntities(
      userMessages.replace(/^User:\s*/i, "").trim(),
    );
    const finalMessage = slashCommand
      ? cleanedMessage
        ? slashCommand + "\n" + cleanedMessage
        : slashCommand
      : cleanedMessage;
    return { userMessages: finalMessage, references };
  }

  private parseColonSeparatedUserChunk(raw: string): ParsedUserMessage {
    const referencePrefix = "Reference ";
    if (raw.startsWith("User:")) {
      const refStart = Math.max(raw.indexOf(referencePrefix), 0);
      return {
        userMessages: raw
          .substring(0, refStart > 0 ? refStart : raw.length)
          .replace(/^User:\s*/, "")
          .trim(),
        references: [],
      };
    }
    if (raw.startsWith(referencePrefix)) {
      const match = raw.match(/Reference\s\((.*)\):\s(.*)/);
      if (match) {
        const fileUri = resolveUri(match[1], currentWorkspaceRoot());
        const fileRelative = match[2];
        return {
          userMessages: "",
          references: [
            { id: fileRelative, name: fileRelative, value: fileUri },
          ],
        };
      }
    }
    return { userMessages: "", references: [] };
  }
}
