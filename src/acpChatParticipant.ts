import {
  ContentBlock,
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import {
  buildMcpToolInvocationData,
  buildTerminalToolInvocationData,
  getSubAgentInvocationId,
  getToolInfo,
  isTerminalToolInvocation,
  makeCommandLink,
  parseQuestions,
  resolveUri,
  trustedCommandMarkdown,
  type ToolInfo,
} from "./chatRenderingUtils";
import {
  formatCommandSourceBadge,
  formatSlashCommandLabel,
  getShortCommandName,
  getSlashCommandMatchScore,
  normalizeSlashCommandQuery,
} from "./commandMatching";
import { AcpSessionManager, Session } from "./acpSessionManager";
import { buildStructuredCommandPrompt } from "./chatCommandSerialization";
import { DisposableBase } from "./disposables";
import {
  collectToolDiffArtifacts,
  createToolDiffPart,
  pushToolDiffPart,
} from "./diffRendering";
import { registerExternalEdit } from "./externalEditTracker";
import { PermissionPromptManager } from "./permissionPrompts";
import { Tracer } from "./tracer";
import {
  currentWorkspaceRoot,
  extractReadableErrorMessage,
  ResolvableCallback,
  VscodeToolNames,
} from "./types";
import { isUsageUpdate } from "./acpDraftTypes";

const LIST_COMMANDS_PROMPT = "/?";

function isQuestionToolCall(title: string | undefined): boolean {
  if (!title) {
    return false;
  }
  const normalized = title.toLowerCase().replace(/[-_]/g, "");
  return normalized === "question" || normalized === "askuserquestion";
}

export class AcpChatParticipant extends DisposableBase {
  requestHandler: vscode.ChatRequestHandler = this.handleRequest.bind(this);
  onDidReceiveFeedback: vscode.Event<vscode.ChatResultFeedback> =
    new vscode.EventEmitter<vscode.ChatResultFeedback>().event;
  readonly commandCompletionProvider: vscode.ChatParticipantCompletionItemProvider = {
    provideCompletionItems: (query, token) =>
      this.provideCommandCompletionItems(query, token),
  };

  private static readonly _chatCompletionItemAvailable: boolean =
    (() => {
      try {
        return typeof vscode.ChatCompletionItem === "function";
      } catch {
        return false;
      }
    })();

  constructor(
    private readonly permissionManager: PermissionPromptManager,
    private readonly sessionManager: AcpSessionManager,
    private readonly logger: vscode.LogOutputChannel,
    readonly agentId: string,
  ) {
    super();
    this.tracer = new Tracer(logger);
    if (!AcpChatParticipant._chatCompletionItemAvailable) {
      this.logger.warn(
        `[acp:${this.agentId}] vscode.ChatCompletionItem is not available at runtime; slash completions are disabled. This proposed API may not be implemented in this VS Code build.`,
      );
    }
  }

  private readonly tracer: Tracer;
  private readonly toolInvocations = new Map<
    string,
    {
      name: string;
      invocationMessage?: string;
      subAgentInvocationId?: string;
    }
  >();
  private readonly questionToolCalls = new Set<string>();
  private readonly sessionUsageMilestones = new Map<string, number>();
  private currentToolInvocationToken:
    | vscode.ChatParticipantToolToken
    | undefined;

  private externalEditorCallbacks = new Map<
    string,
    {
      callbacks: ResolvableCallback[];
      unregisters: Array<() => void>;
    }
  >();

  private provideCommandCompletionItems(
    query: string,
    token: vscode.CancellationToken,
  ): vscode.ChatCompletionItem[] {
    if (token.isCancellationRequested) {
      return [];
    }

    if (!AcpChatParticipant._chatCompletionItemAvailable) {
      return [];
    }

    const normalizedQuery = normalizeSlashCommandQuery(query);
    if (normalizedQuery.includes(" ")) {
      return [];
    }

    const prefix = normalizedQuery;

    const acpCommands = this.sessionManager.getKnownAvailableCommands();
    const acpNames = new Set(acpCommands.map((c) => c.name));

    try {
      const skillItems = this.sessionManager
        .getDiscoveredSkills()
        .map((skill) => ({
          skill,
          score: getSlashCommandMatchScore(skill.name, prefix),
        }))
        .filter(({ skill, score }) => !acpNames.has(skill.name) && score > 0)
        .sort((left, right) => {
          const scoreDiff = right.score - left.score;
          return scoreDiff !== 0
            ? scoreDiff
            : left.skill.name.localeCompare(right.skill.name);
        })
        .map(({ skill }) => {
          const item = new vscode.ChatCompletionItem(
            `skill-${skill.name}`,
            formatSlashCommandLabel(skill.name),
            [{ level: vscode.ChatVariableLevel.Short, value: skill.description }],
          );
          item.icon = new vscode.ThemeIcon("book");
          item.insertText = `/${skill.name} `;
          item.detail = skill.description;
          return item;
        });

      const acpItems = acpCommands
        .map((command) => ({
          command,
          score: getSlashCommandMatchScore(command.name, prefix),
        }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => {
          const scoreDiff = right.score - left.score;
          return scoreDiff !== 0
            ? scoreDiff
            : left.command.name.localeCompare(right.command.name);
        })
        .map(({ command }) => {
          const canonicalName = normalizeSlashCommandQuery(command.name);
          const shortName = getShortCommandName(canonicalName);
          const item = new vscode.ChatCompletionItem(
            `acp-command-${command.name}`,
            formatSlashCommandLabel(command.name),
            [{
              level: vscode.ChatVariableLevel.Short,
              value:
                shortName !== canonicalName
                  ? `${shortName} (${canonicalName})`
                  : canonicalName,
            }],
          );

          item.icon = new vscode.ThemeIcon("terminal-cmd");
          item.insertText = `/${canonicalName} `;
          item.detail = [
            formatCommandSourceBadge(command.source),
            shortName !== canonicalName ? `Alias: /${shortName}` : undefined,
            command.input?.hint?.trim() ||
              (command.source === "manual"
                ? "Manually configured/imported ACP command"
                : "ACP slash command"),
          ]
            .filter((value): value is string => Boolean(value))
            .join(" — ");
          if (
            shortName !== canonicalName ||
            command.description?.trim() ||
            command.input?.hint?.trim()
          ) {
            item.documentation = [
              `Source: ${command.source === "manual" ? "manually configured/imported" : "ACP advertised"}`,
              shortName !== canonicalName
                ? `Canonical command: \`/${canonicalName}\``
                : undefined,
              command.description?.trim(),
              command.input?.hint?.trim(),
            ]
              .filter((value): value is string => Boolean(value))
              .join("\n\n");
          }

          return item;
        });

      return [...skillItems, ...acpItems];
    } catch (error) {
      this.logger.error(
        `[acp:${this.agentId}] Failed to provide command completion items: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  private async handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const sessionResource =
      context.chatSessionContext?.chatSessionItem.resource;
    if (!sessionResource) {
      // Info-style message in chat UI
      response.markdown(
        "> ℹ️ **Info:** ACP requests must be made from within an ACP chat session.",
      );
      return;
    }

    let session = this.sessionManager.getActive(sessionResource);
    if (!session) {
      try {
        const result = await this.sessionManager.createOrGet(sessionResource);
        session = result.session;
      } catch (error) {
        this.logger.error(
          `Failed to create/load session for resource ${sessionResource.toString()}: ${error instanceof Error ? error.message : String(error)}`,
        );
        response.markdown(
          `> **Error:** Failed to initialize ACP session. ${extractReadableErrorMessage(error)}`,
        );
        return;
      }
    }

    if (token.isCancellationRequested) {
      return;
    }
    session.markAsInProgress();

    if (request.prompt.trim() === LIST_COMMANDS_PROMPT) {
      this.renderAvailableCommands(session, response);
      session.markAsCompleted();
      this.sessionManager.syncSessionState(sessionResource, session);
      this.currentToolInvocationToken = undefined;
      return;
    }

    // Wait for our turn if another request is in flight (input queue).
    const beforeQueueLen = session.queueLength;
    if (beforeQueueLen > 0) {
      response.markdown(
        `> ⏳ **Queued (position: #${beforeQueueLen + 1})** — waiting for the current request to finish.`,
      );
    }
    await session.waitForTurn();
    if (token.isCancellationRequested) {
      return;
    }

    // Cancel any previous in-flight request for this session (should be
    // none at this point since waitForTurn only returns when we are next).
    this.cancelPendingRequest(session);

    this.currentToolInvocationToken = request.toolInvocationToken;

    const cancellation = new vscode.CancellationTokenSource();
    session.pendingRequest = { cancellation };

    const subscription = session.client.onSessionUpdate(
      async (notification) => {
        try {
          if (
            !session.acpSessionId ||
            notification.sessionId !== session.acpSessionId
          ) {
            return;
          }
          if (token.isCancellationRequested) {
            return;
          }
          await this.renderSessionUpdate(notification, response, session);
        } catch (error) {
          this.logger.error(
            `Failed to render session update: ${extractReadableErrorMessage(error)}`,
          );
        }
      },
    );

    const cancellationRegistration = token.onCancellationRequested(() => {
      cancellation.cancel();
      if (session.acpSessionId) {
        session.client.cancel(session.acpSessionId).catch(() => {
          /* noop */
        });
      }
      const pending = session.pendingRequest;
      if (pending?.cancellation === cancellation) {
        pending.permissionContext?.dispose();
      }
    });

    try {
      const sessionId = session.acpSessionId;
      this.refreshPermissionContext(session, response, token);

      const promptBlocks = this.buildPromptBlocks(request, context);
      if (promptBlocks.length === 0) {
        // Informational guidance in chat
        response.markdown(
          "> ℹ️ **Info:** Prompt cannot be empty. Please provide a question or instruction for the ACP agent.",
        );
        session.markAsCompleted();
        this.sessionManager.syncSessionState(sessionResource, session);
        return;
      }
      if (token.isCancellationRequested) {
        return;
      }

      const result = await session.client.prompt(sessionId, promptBlocks);
      if (token.isCancellationRequested) {
        return;
      }

      this.renderFinalCumulativeDiff(response, session);

      session.markAsCompleted();
      if (context.chatSessionContext.isUntitled) {
        session.title =
          request.prompt.substring(0, Math.min(request.prompt.length, 50)) ||
          session.title;
      }
      this.sessionManager.syncSessionState(sessionResource, session);

      // Log detailed stop reason to the ACP Output channel for troubleshooting.
      this.logger.info(
        `ACP agent finished with stop reason: ${result.stopReason}`,
      );
    } catch (error) {
      if (token.isCancellationRequested) {
        return;
      }
      session.markAsFailed();
      this.sessionManager.syncSessionState(sessionResource, session);
      // Render a Copilot-style error message in chat
      response.markdown(
        `> **Error:** ACP request failed. ${extractReadableErrorMessage(error)}`,
      );
    } finally {
      session.pendingRequest?.permissionContext?.dispose();
      session.pendingRequest = undefined;
      this.currentToolInvocationToken = undefined;
      cancellationRegistration.dispose();
      subscription.dispose();
      this.toolInvocations.clear();
      this.questionToolCalls.clear();
      for (const trackedExternalEdit of this.externalEditorCallbacks.values()) {
        trackedExternalEdit.callbacks.forEach((callback) => callback.resolve());
        trackedExternalEdit.unregisters.forEach((unregister) => unregister());
      }
      this.externalEditorCallbacks.clear();

      // Signal the next queued prompt (if any) to proceed.
      session.signalNext();
    }
  }

  private buildPromptBlocks(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
  ): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    this.appendUserTurnBlocks(
      blocks,
      request.prompt,
      request.references,
      request.toolReferences,
      request.command,
    );

    this.appendEditedFileEventBlocks(blocks, request);

    return blocks;
  }

  private appendUserTurnBlocks(
    blocks: ContentBlock[],
    prompt: string | undefined,
    references: readonly vscode.ChatPromptReference[] | undefined,
    toolReferences:
      | readonly vscode.ChatLanguageModelToolReference[]
      | undefined,
    command?: string,
  ): void {
    const trimmedPrompt = prompt?.trim();
    const structuredCommandPrompt = buildStructuredCommandPrompt({
      prompt: trimmedPrompt,
      command,
      knownCommands: [
        ...this.sessionManager.getKnownAvailableCommands().map((item) => item.name),
        ...this.sessionManager.getDiscoveredSkills().map((item) => item.name),
      ],
    });

    if (structuredCommandPrompt) {
      blocks.push(this.createTextBlock(structuredCommandPrompt));
    } else if (trimmedPrompt) {
      blocks.push(this.createTextBlock(`User: ${trimmedPrompt}`));
    }

    this.appendReferenceBlocks(blocks, references);
    this.appendToolReferenceBlocks(blocks, toolReferences);
  }

  private appendReferenceBlocks(
    blocks: ContentBlock[],
    references: readonly vscode.ChatPromptReference[] | undefined,
  ): void {
    if (!references?.length) {
      return;
    }

    for (const reference of references) {
      const description = reference.modelDescription?.trim();
      const valueText = this.formatReferenceValue(reference.value);
      const range = reference.range
        ? ` [${reference.range[0]}, ${reference.range[1]}]`
        : "";
      const parts = [`Reference (${reference.id})${range}`];
      if (description) {
        parts.push(description);
      }
      if (valueText) {
        parts.push(valueText);
      }
      blocks.push(this.createTextBlock(parts.join(": ")));
    }
  }

  private appendToolReferenceBlocks(
    blocks: ContentBlock[],
    toolReferences:
      | readonly vscode.ChatLanguageModelToolReference[]
      | undefined,
  ): void {
    if (!toolReferences?.length) {
      return;
    }

    for (const tool of toolReferences) {
      const range = tool.range ? ` [${tool.range[0]}, ${tool.range[1]}]` : "";
      blocks.push(
        this.createTextBlock(`Tool reference (${tool.name})${range}`),
      );
    }
  }

  private appendEditedFileEventBlocks(
    blocks: ContentBlock[],
    request: vscode.ChatRequest,
  ): void {
    const editedFileEvents = (
      request as vscode.ChatRequest & {
        editedFileEvents?: readonly {
          uri: vscode.Uri;
          eventKind: number;
        }[];
      }
    ).editedFileEvents;

    if (!editedFileEvents?.length) {
      return;
    }

    for (const event of editedFileEvents) {
      blocks.push(
        this.createTextBlock(
          `Edited file event (${this.describeEditedFileEvent(event.eventKind)}): ${this.formatUri(event.uri)}`,
        ),
      );
    }
  }

  private formatReferenceValue(value: unknown): string | undefined {
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof vscode.Uri) {
      return this.formatUri(value);
    }
    if (value instanceof vscode.Location) {
      return this.formatLocation(value);
    }
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  private formatLocation(location: vscode.Location): string {
    const line = location.range.start.line + 1;
    const column = location.range.start.character + 1;
    return `${this.formatUri(location.uri)}:${line}:${column}`;
  }

  private formatUri(uri: vscode.Uri): string {
    if (uri.scheme === "file") {
      const relative = vscode.workspace.asRelativePath(uri, false);
      if (relative && relative !== uri.fsPath) {
        return relative;
      }
      return uri.fsPath;
    }
    return uri.toString();
  }

  private createTextBlock(text: string): ContentBlock {
    return { type: "text", text };
  }

  private describeEditedFileEvent(eventKind: number): string {
    const eventKinds = vscode as typeof vscode & {
      ChatRequestEditedFileEventKind?: {
        Keep?: number;
        Undo?: number;
        UserModification?: number;
      };
    };

    switch (eventKind) {
      case eventKinds.ChatRequestEditedFileEventKind?.Keep:
        return "keep";
      case eventKinds.ChatRequestEditedFileEventKind?.Undo:
        return "undo";
      case eventKinds.ChatRequestEditedFileEventKind?.UserModification:
        return "user_modified";
      default:
        return `event_${eventKind}`;
    }
  }

  private isChatRequestTurn(
    turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn,
  ): turn is vscode.ChatRequestTurn {
    return "prompt" in turn;
  }

  private async renderSessionUpdate(
    notification: SessionNotification,
    response: vscode.ChatResponseStream,
    session: Session,
  ): Promise<void> {
    this.tracer.trace(notification);
    const update = notification.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = this.getContentText(update.content);
        if (text) {
          response.markdown(text);
        } else {
          this.logger.trace("The last update did not had a valid text content");
        }
        break;
      }
      case "agent_thought_chunk": {
        const thinkingText = this.getContentText(update.content);
        if (thinkingText) {
          response.thinkingProgress({
            id: "agent_thought",
            text: thinkingText,
          });
        }
        break;
      }
      case "tool_call": {
        const info = getToolInfo(update);
        const subAgentInvocationId = getSubAgentInvocationId(update);
        const invocationMessage = info.input ?? "";
        this.toolInvocations.set(update.toolCallId, {
          name: info.name,
          invocationMessage,
          subAgentInvocationId,
        });
        const partialInput =
          info.kind === "switch_mode"
            ? undefined
            : (update.rawInput ?? info.input);
        const streamData:
          | (vscode.ChatToolInvocationStreamData & {
              subagentInvocationId?: string;
            })
          | undefined =
          partialInput !== undefined || subAgentInvocationId
            ? {
                ...(partialInput !== undefined ? { partialInput } : {}),
                ...(subAgentInvocationId
                  ? { subagentInvocationId: subAgentInvocationId }
                  : {}),
              }
            : undefined;
        response.beginToolInvocation(
          update.toolCallId,
          info.name || "Tool",
          streamData,
        );
        this.logToolCallLifecycle("started", update, info);

        // Track question tool calls
        if (info.kind === "other" && isQuestionToolCall(update.title)) {
          this.questionToolCalls.add(update.toolCallId);
        }

        // Track if a file change
        this.handleFileEditToolCalls(info, update, response);
        break;
      }
      case "tool_call_update": {
        const tracked = this.toolInvocations.get(update.toolCallId);
        const info = getToolInfo(update);
        if (update.status !== "completed" && update.status !== "failed") {
          // Handle question tool calls using questionCarousel
          if (this.questionToolCalls.has(update.toolCallId)) {
            const questions = parseQuestions(update);
            if (questions) {
              try {
                // Capture session before any await — this.currentSession is a shared
                // mutable field that could be overwritten if a concurrent request starts.
                session.markAsNeedsInput();
                await this.sessionManager.syncSessionState(
                  session.vscodeResource,
                  session,
                );
                const answers = await response.questionCarousel(
                  questions,
                  false,
                );

                // Send answers back to the agent
                if (session.acpSessionId && answers) {
                  await session.client.sendQuestionAnswers(
                    session.acpSessionId,
                    update.toolCallId,
                    answers,
                  );
                  session.markAsInProgress();
                  await this.sessionManager.syncSessionState(
                    session.vscodeResource,
                    session,
                  );
                }
              } catch (error) {
                this.logger.error(
                  `Failed to handle question carousel: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          }

          if (info.input) {
            if (tracked) {
              tracked.invocationMessage = info.input;
            }
            response.updateToolInvocation(update.toolCallId, {
              partialInput: update.rawInput ?? info.input,
            });
          }
          this.handleFileEditToolCalls(info, update, response);
          break;
        }

        this.questionToolCalls.delete(update.toolCallId);

        const toolName = info.name || tracked?.name || "Tool";
        const part = new vscode.ChatToolInvocationPart(
          toolName,
          update.toolCallId,
        );
        part.isError = update.status === "failed";
        part.originMessage = toolName;
        const invocationMessage = info.input ?? tracked?.invocationMessage;
        if (invocationMessage) {
          part.invocationMessage = invocationMessage;
        }
        if (info.output) {
          part.pastTenseMessage = info.output;
        }
        part.isConfirmed = update.status === "completed";
        part.isError = update.status === "failed" ? true : false;
        part.isComplete = true;
        if (update.status === "completed") {
          part.presentation = "hiddenAfterComplete";
        }
        const subAgentInvocationId =
          tracked?.subAgentInvocationId ?? getSubAgentInvocationId(update);
        if (subAgentInvocationId) {
          part.subAgentInvocationId = subAgentInvocationId;
        }
        const terminalData = isTerminalToolInvocation(update, info)
          ? buildTerminalToolInvocationData(update, info)
          : undefined;
        part.toolSpecificData =
          terminalData ?? buildMcpToolInvocationData(info);
        response.push(part);
        this.logToolCallLifecycle(
          update.status === "failed" ? "failed" : "completed",
          update,
          info,
        );
        this.renderToolFileSummary(response, update, info);

        // Track as external edit, if file change
        const handled = this.handleFileEditToolCalls(info, update, response);
        if (!handled) {
          // fallback to file diffs
          this.handleDiffToolContents(update, response, session);
        }

        this.toolInvocations.delete(update.toolCallId);
        break;
      }
      case "plan": {
        await this.renderPlanUpdate(update.entries, response);
        break;
      }
      case "current_mode_update": {
        break;
      }
      case "session_info_update": {
        break;
      }

      // draft apis
      case "usage_update": {
        if (isUsageUpdate(update)) {
          const incr = Math.max(0, update.used - (session.contextWindowUsed || 0));
          this.sessionManager.reportContextWindowSize(session, {
            size: update.size,
            used: update.used,
          });
          response.usage({
            promptTokens: incr,
            completionTokens: 0,
            outputBuffer: Math.max(0, update.size - update.used),
          });
          this.renderContextWindowHints(response, session, update.used, update.size);
        }
        break;
      }
      default:
        break;
    }
  }

  private cancelPendingRequest(session: Session): void {
    const pending = session.pendingRequest;
    if (!pending) {
      return;
    }
    pending.cancellation.cancel();
    pending.permissionContext?.dispose();
    session.pendingRequest = undefined;
  }

  private refreshPermissionContext(
    sessionState: Session,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): void {
    const pending = sessionState.pendingRequest;
    if (!pending) {
      return;
    }
    pending.permissionContext?.dispose();
    if (!sessionState.acpSessionId) {
      pending.permissionContext = undefined;
      return;
    }
    pending.permissionContext = this.bindPermissionContext(
      sessionState,
      response,
      token,
    );
  }

  private bindPermissionContext(
    sessionState: Session,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): vscode.Disposable {
    return this.permissionManager.bindSessionResponse({
      session: sessionState,
      response,
      token,
      toolInvocationToken: this.currentToolInvocationToken,
    });
  }

  private getContentText(content?: ContentBlock): string | undefined {
    if (!content) {
      return undefined;
    }
    if (content.type === "text") {
      return content.text;
    }
    return undefined;
  }

  private async renderPlanUpdate(
    entries: Array<{
      content: string;
      status?: string;
      priority?: string;
    }>,
    response: vscode.ChatResponseStream,
  ): Promise<void> {
    if (!entries.length) {
      return;
    }

    const toolName = VscodeToolNames.TodoList;
    const toolAvailable = vscode.lm.tools.some(
      (tool) => tool.name === toolName,
    );
    let renderedWithTodoTool = false;
    if (toolAvailable && this.currentToolInvocationToken) {
      const todoList = entries.map((entry, index) => ({
        id: index + 1,
        title: entry.content,
        status: this.mapPlanStatus(entry.status),
      }));
      try {
        await vscode.lm.invokeTool(toolName, {
          toolInvocationToken: this.currentToolInvocationToken,
          input: { todoList },
        });
        renderedWithTodoTool = true;
      } catch (error) {
        this.logger.warn(
          `Failed to render TodoList tool for plan update: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (!renderedWithTodoTool) {
      response.markdown("## Plan\n");
      for (const entry of entries) {
        const checkbox = entry.status === "completed" ? "x" : " ";
        response.markdown(`-  [${checkbox}] ${entry.content}\n`);
      }
    }

    response.markdown(
      trustedCommandMarkdown(
        "\nUse the plan actions below to continue, request changes, or ask for more detail before the next ACP step.\n\n",
      ),
    );
    this.renderPlanActionButtons(entries, response);
  }

  private renderAvailableCommands(
    session: Session,
    response: vscode.ChatResponseStream,
  ): void {
    const commands = this.sessionManager.getAvailableCommands(
      session.acpSessionId,
    );
    if (!commands.length) {
      response.markdown(
        "No ACP commands have been reported for this session yet.",
      );
      return;
    }

    response.markdown("## Available ACP commands\n");
    response.markdown(
      "Type `/` in the chat input to browse ACP command completions for this agent. Namespaced commands can be matched by either the full canonical name or the short segment after `:`; completions still insert the canonical ACP command for the agent. Each command below is labeled as either ACP-advertised or manually configured/imported.\n\n",
    );
    for (const command of commands) {
      const hint = command.input?.hint ? ` — ${command.input.hint}` : "";
      const canonicalName = normalizeSlashCommandQuery(command.name);
      const shortName = getShortCommandName(canonicalName);
      const linkLabel = shortName === canonicalName
        ? `/${canonicalName}`
        : `/${shortName}`;
      const canonicalNote = shortName === canonicalName
        ? undefined
        : `_Canonical:_ \`/${canonicalName}\``;
      const sourceNote = `_Source:_ ${command.source === "manual" ? "manually configured/imported" : "ACP advertised"}`;
      const link = makeCommandLink(linkLabel, `/${canonicalName}`);
      if (command.description?.trim() || canonicalNote) {
        response.markdown(
          trustedCommandMarkdown(
            [
              `- ${link} ${hint} ${formatCommandSourceBadge(command.source)}`,
              command.description?.trim()
                ? `\n\n  _${command.description.trim()}_`
                : "",
              `\n\n  ${sourceNote}`,
              canonicalNote ? `\n\n  ${canonicalNote}` : "",
              "\n\n",
            ].join(""),
          ),
        );
      } else {
        response.markdown(
          trustedCommandMarkdown(
            `- ${link} ${hint} ${formatCommandSourceBadge(command.source)}\n\n  ${sourceNote}\n\n`,
          ),
        );
      }
    }
  }

  private mapPlanStatus(
    status?: string,
  ): "not-started" | "in-progress" | "completed" {
    switch (status) {
      case "completed":
        return "completed";
      case "in_progress":
        return "in-progress";
      case "pending":
      default:
        return "not-started";
    }
  }

  private renderPlanActionButtons(
    entries: Array<{
      content: string;
      status?: string;
      priority?: string;
    }>,
    response: vscode.ChatResponseStream,
  ): void {
    const planSummary = this.summarizePlanEntries(entries);
    response.button({
      command: "acp.insertChatText",
      title: "Continue Plan",
      arguments: ["Continue with the current plan and call out any changes before you make them."],
    });
    response.button({
      command: "acp.requestPlanChanges",
      title: "Request Plan Changes",
      arguments: [planSummary],
    });
    response.button({
      command: "acp.insertChatText",
      title: "Explain Plan",
      arguments: ["Explain the current plan in more detail before continuing."],
    });
  }

  private summarizePlanEntries(
    entries: Array<{
      content: string;
      status?: string;
      priority?: string;
    }>,
  ): string {
    return entries
      .slice(0, 3)
      .map((entry) => entry.content.trim())
      .filter((entry) => entry.length > 0)
      .join(" | ");
  }

  private renderContextWindowHints(
    response: vscode.ChatResponseStream,
    session: Session,
    used: number,
    size: number,
  ): void {
    if (!session.acpSessionId || size <= 0) {
      return;
    }

    const ratio = used / size;
    const percentUsed = Math.round(ratio * 100);
    const nextMilestone = ratio >= 0.9 ? 90 : ratio >= 0.75 ? 75 : 0;
    const previousMilestone =
      this.sessionUsageMilestones.get(session.acpSessionId) ?? -1;

    response.progress(
      `Context window usage: ${percentUsed}% (${this.formatTokenCount(used)} / ${this.formatTokenCount(size)} tokens)`,
    );

    if (nextMilestone > previousMilestone) {
      this.sessionUsageMilestones.set(session.acpSessionId, nextMilestone);
      if (nextMilestone >= 90) {
        response.warning(
          `Context window is ${percentUsed}% full. The agent may need to summarize or compact before the next long step.`,
        );
      } else if (nextMilestone >= 75) {
        response.progress(
          `Context window is ${percentUsed}% full. Longer replies or more tool output may need compaction soon.`,
        );
      }
      return;
    }

    if (previousMilestone === -1) {
      this.sessionUsageMilestones.set(session.acpSessionId, nextMilestone);
    }
  }

  private formatTokenCount(value: number): string {
    return new Intl.NumberFormat("en-US").format(value);
  }

  private logToolCallLifecycle(
    phase: "started" | "completed" | "failed",
    update: ToolCall | ToolCallUpdate,
    info: ToolInfo,
  ): void {
    const touchedFiles = this.getToolRelatedPaths(update);
    const contentTypes = update.content?.map((content) => content.type) ?? [];
    const summaryParts = [
      `id=${update.toolCallId}`,
      `name=${info.name || update.title || "Tool"}`,
      `kind=${info.kind}`,
      `status=${update.status ?? "pending"}`,
      `content=${contentTypes.length ? contentTypes.join(",") : "none"}`,
      `rawInput=${update.rawInput ? "yes" : "no"}`,
      `rawOutput=${update.rawOutput ? "yes" : "no"}`,
      `files=${touchedFiles.length ? touchedFiles.join(", ") : "none"}`,
    ];
    this.logger.info(
      `[acp:${this.agentId}] Tool ${phase}: ${summaryParts.join("; ")}`,
    );
  }

  private renderToolFileSummary(
    response: vscode.ChatResponseStream,
    update: ToolCall | ToolCallUpdate,
    info: ToolInfo,
  ): void {
    const touchedFiles = this.getToolRelatedPaths(update);
    if (!touchedFiles.length) {
      return;
    }

    const visibleFiles = touchedFiles.slice(0, 5);
    const remainingCount = touchedFiles.length - visibleFiles.length;
    const fileList = visibleFiles.map((file) => `\`${file}\``).join(", ");
    const title = this.hasDiffContent(update) || info.kind === "edit"
      ? "Touched files"
      : "Files involved";
    const suffix = remainingCount > 0 ? ` and ${remainingCount} more` : "";
    response.markdown(`**${title}:** ${fileList}${suffix}\n\n`);
  }

  private getToolRelatedPaths(update: ToolCall | ToolCallUpdate): string[] {
    const paths = new Set<string>();

    for (const location of update.locations ?? []) {
      paths.add(this.toDisplayPath(location.path));
    }

    for (const content of update.content ?? []) {
      if (content.type === "diff") {
        paths.add(this.toDisplayPath(content.path));
      }
    }

    return Array.from(paths.values());
  }

  private hasDiffContent(update: ToolCall | ToolCallUpdate): boolean {
    return Boolean(update.content?.some((content) => content.type === "diff"));
  }

  private toDisplayPath(rawPath: string): string {
    try {
      return this.formatUri(resolveUri(rawPath, currentWorkspaceRoot()));
    } catch {
      return rawPath;
    }
  }

  private handleDiffToolContents(
    update: ToolCallUpdate,
    stream: vscode.ChatResponseStream,
    session: Session,
  ): void {
    const diffArtifacts = collectToolDiffArtifacts(update, currentWorkspaceRoot());
    this.sessionManager.recordToolDiffArtifacts(session.acpSessionId, diffArtifacts);
    pushToolDiffPart(stream, diffArtifacts);
  }

  private renderFinalCumulativeDiff(
    response: vscode.ChatResponseStream,
    session: Session,
  ): void {
    const diffPart = createToolDiffPart(
      this.sessionManager.getCumulativeToolDiffArtifacts(session.acpSessionId),
    );
    if (!diffPart) {
      return;
    }
    diffPart.title = "Modified files";
    response.push(diffPart);
  }

  private handleFileEditToolCalls(
    info: ToolInfo,
    data: ToolCall | ToolCallUpdate,
    stream: vscode.ChatResponseStream,
  ): boolean {
    if (data.status === "pending" || data.status === "in_progress") {
      if (this.externalEditorCallbacks.has(info.toolCallId)) {
        return true; // consider it as already handled.
      }

      switch (info.kind) {
        case "edit": {
          if (info.resources) {
            const callbacks: ResolvableCallback[] = [];
            const unregisters: Array<() => void> = [];
            info.resources?.forEach((r) => {
              const callback = new ResolvableCallback();
              callbacks.push(callback);
              unregisters.push(
                registerExternalEdit(info.toolCallId, r, () => callback.resolve()),
              );
              stream.externalEdit(r, callback.callback);
            });
            this.externalEditorCallbacks.set(info.toolCallId, {
              callbacks,
              unregisters,
            });
            return true;
          }
          return false;
        }
        case "other": {
          if (
            data.title === "apply_patch" &&
            data.rawInput &&
            typeof data.rawInput === "object" &&
            "patchText" in data.rawInput
          ) {
            return true;
          }
        }
      }
      return false;
    } else {
      if (this.externalEditorCallbacks.has(info.toolCallId)) {
        // resolve call callbacks
        const trackedExternalEdit = this.externalEditorCallbacks.get(
          info.toolCallId,
        );
        trackedExternalEdit?.callbacks.forEach((callback) => callback.resolve());
        trackedExternalEdit?.unregisters.forEach((unregister) => unregister());
        this.externalEditorCallbacks.delete(info.toolCallId);

        return !this.hasDiffContent(data);
      }
    }
    return false;
  }
}
