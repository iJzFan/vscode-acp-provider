// SPDX-License-Identifier: Apache-2.0
import {
  AgentCapabilities,
  Client,
  ClientCapabilities,
  ClientSideConnection,
  ContentBlock,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptResponse,
  RequestId,
  PROTOCOL_VERSION,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModelState,
  SessionModeState,
  McpServer,
  McpServerHttp,
  McpServerStdio,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionModelRequest,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as vscode from "vscode";
import { AgentRegistryEntry } from "./agentRegistry";
import {
  extractReadableErrorMessage,
  type AcpMcpServerConfiguration,
  type ThinkConfig,
} from "./types";
import { DisposableBase } from "./disposables";
import { writeTextFileWithCoordinator } from "./fileWriteCoordinator";
import { resolveExternalEditsForUri } from "./externalEditTracker";

export interface AcpPermissionHandler {
  requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>;
}

const CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: true,
};

const CLIENT_INFO = {
  name: "github-copilot-acp-client",
  version: "1.0.0",
};

export interface AcpClient extends Client, vscode.Disposable {
  onSessionUpdate: vscode.Event<SessionNotification>;
  onDidStop: vscode.Event<void>;
  onDidStart: vscode.Event<void>;
  onDidOptionsChanged: vscode.Event<void>;

  getCapabilities(): AgentCapabilities;
  createSession(
    cwd: string,
    mcpServers: AgentRegistryEntry["mcpServers"],
    settings?: {
      thinkingModeEnabled?: boolean;
      thinkingConfig?: ThinkConfig;
    },
  ): Promise<NewSessionResponse>;
  getSupportedModelState(): SessionModelState | null;
  getSupportedModeState(): SessionModeState | null;
  loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: AgentRegistryEntry["mcpServers"],
  ): Promise<{
    modeId: string | undefined;
    modelId: string | undefined;
    notifications: SessionNotification[];
  }>;
  prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse>;
  cancel(sessionId: string, requestId?: RequestId): Promise<void>;
  changeMode(sessionId: string, modeId: string): Promise<void>;
  changeModel(sessionId: string, modelId: string): Promise<void>;
  setThink(
    sessionId: string,
    enabled: boolean,
    config?: ThinkConfig,
  ): Promise<{
    success: boolean;
    currentThinkEnabled: boolean;
    currentThinkConfig?: string;
    unsupported?: boolean;
    errorMessage?: string;
  }>;
  setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void>;
  getConfigOptions(): SessionConfigOption[];
  sendQuestionAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, unknown>,
  ): Promise<void>;
  listNativeSessions(cursor?: string): Promise<ListSessionsResponse>;
  readTextFile(params: { uri: string }): Promise<{ content: string }>;
  writeTextFile(params: { uri: string; content: string }): Promise<void>;
}

export function createAcpClient(
  agent: AgentRegistryEntry,
  permissionHandler: AcpPermissionHandler,
  logChannel: vscode.LogOutputChannel,
): AcpClient {
  return new AcpClientImpl(agent, permissionHandler, logChannel);
}

export async function sendSessionCancel(
  connection: Pick<ClientSideConnection, "cancel"> | null,
  options: {
    sessionId: string;
    requestId?: RequestId;
    agentId: string;
    logChannel: Pick<vscode.LogOutputChannel, "appendLine" | "debug">;
  },
): Promise<boolean> {
  if (!connection) {
    return false;
  }

  if (options.requestId === undefined) {
    options.logChannel.debug(
      `[acp:${options.agentId}] Skipping session/cancel for ${options.sessionId} because no ACP requestId is available for the in-flight prompt.`,
    );
    return false;
  }

  try {
    await connection.cancel({
      sessionId: options.sessionId,
      requestId: options.requestId,
    });
    return true;
  } catch (error) {
    options.logChannel.appendLine(
      `[acp:${options.agentId}] failed to cancel session ${options.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

type ClientMode = "new_session" | "load_session";

class AcpClientImpl extends DisposableBase implements AcpClient {
  private agentProcess: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private readyPromise: Promise<void> | null = null;
  private agentCapabilities?: InitializeResponse;
  private supportedModelState: SessionModelState | null = null;
  private supportedModeState: SessionModeState | null = null;
  private configOptions: SessionConfigOption[] = [];

  private readonly onSessionUpdateEmitter = this._register(
    new vscode.EventEmitter<SessionNotification>(),
  );
  public readonly onSessionUpdate: vscode.Event<SessionNotification> =
    this.onSessionUpdateEmitter.event;

  private readonly _onDidStop = this._register(new vscode.EventEmitter<void>());
  public readonly onDidStop: vscode.Event<void> = this._onDidStop.event;

  private readonly _onDidStart = this._register(
    new vscode.EventEmitter<void>(),
  );
  public readonly onDidStart: vscode.Event<void> = this._onDidStart.event;

  private readonly _onDidOptionsChanged = this._register(
    new vscode.EventEmitter<void>(),
  );
  public readonly onDidOptionsChanged: vscode.Event<void> =
    this._onDidOptionsChanged.event;

  private mode: ClientMode = "new_session";

  constructor(
    private readonly agent: AgentRegistryEntry,
    private readonly permissionHandler: AcpPermissionHandler,
    private readonly logChannel: vscode.LogOutputChannel,
  ) {
    super();
  }

  async ensureReady(expectedMode: ClientMode): Promise<void> {
    if (this.readyPromise) {
      if (this.mode === expectedMode) {
        return this.readyPromise;
      }
    }

    await this.stopProcess();
    this.readyPromise = this.createConnection(expectedMode);
    try {
      await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
  }

  getCapabilities(): AgentCapabilities {
    return this.agentCapabilities || {};
  }

  async createSession(
    cwd: string,
    mcpServers: AgentRegistryEntry["mcpServers"],
    settings?: {
      thinkingModeEnabled?: boolean;
      thinkingConfig?: ThinkConfig;
    },
  ): Promise<NewSessionResponse> {
    try {
      await this.ensureReady("new_session");

      if (!this.connection) {
        throw new Error("ACP connection is not ready");
      }
      const request: NewSessionRequest & {
        _meta?: {
          settings?: {
            thinkingModeEnabled?: boolean;
            thinkingConfig?: ThinkConfig;
          };
        };
      } = {
        cwd,
        mcpServers: serializeMcpServers(mcpServers),
        _meta: settings ? { settings } : undefined,
      };
      const response: NewSessionResponse =
        await this.connection.newSession(request);
      this.supportedModeState = response.modes || null;
      this.supportedModelState = response.models || null;
      this.configOptions = response.configOptions ?? [];

      this._onDidOptionsChanged.fire();

      return response;
    } catch (error) {
      this.stopProcess();
      throw error;
    }
  }

  getSupportedModelState(): SessionModelState | null {
    return this.supportedModelState;
  }

  getSupportedModeState(): SessionModeState | null {
    return this.supportedModeState;
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: AgentRegistryEntry["mcpServers"],
  ): Promise<{
    modeId: string | undefined;
    modelId: string | undefined;
    notifications: SessionNotification[];
  }> {
    await this.ensureReady("load_session");
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }

    const notifications: SessionNotification[] = [];

    const subscription = this.onSessionUpdate((notification) => {
      if (notification.sessionId === sessionId) {
        // Capture all session update types for history reconstruction
        notifications.push(notification);
      }
    });

    try {
      const response: LoadSessionResponse = await this.connection.loadSession({
        sessionId,
        cwd,
        mcpServers: serializeMcpServers(mcpServers),
      });

      this.supportedModelState = response.models || null;
      this.supportedModeState = response.modes || null;
      this.configOptions = response.configOptions ?? [];
      this._onDidOptionsChanged.fire();

      return {
        modelId: response.models?.currentModelId,
        modeId: response.modes?.currentModeId,
        notifications: notifications,
      };
    } catch (error) {
      this.stopProcess();
      throw error;
    } finally {
      subscription.dispose();
    }
  }

  async prompt(
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<PromptResponse> {
    await this.ensureReady(this.mode);
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }
    return this.connection.prompt({
      sessionId,
      prompt,
    });
  }

  async cancel(sessionId: string, requestId?: RequestId): Promise<void> {
    await sendSessionCancel(this.connection, {
      sessionId,
      requestId,
      agentId: this.agent.id,
      logChannel: this.logChannel,
    });
  }

  requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.permissionHandler.requestPermission(request);
  }

  async sessionUpdate(notification: SessionNotification): Promise<void> {
    const update = notification.update;
    if (
      update.sessionUpdate === "current_mode_update" &&
      this.supportedModeState
    ) {
      this.supportedModeState = {
        ...this.supportedModeState,
        currentModeId: update.currentModeId,
      };
      this._onDidOptionsChanged.fire();
    }
    this.onSessionUpdateEmitter.fire(notification);
  }

  async changeMode(sessionId: string, modeId: string): Promise<void> {
    await this.ensureReady(this.mode);
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }
    const resuest: SetSessionModeRequest = {
      modeId,
      sessionId,
    };
    await this.connection.setSessionMode(resuest);
  }

  async changeModel(sessionId: string, modelId: string): Promise<void> {
    await this.ensureReady(this.mode);
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }

    const request: SetSessionModelRequest = {
      modelId,
      sessionId,
    };
    await this.connection.unstable_setSessionModel(request);

    // Re-sync configOptions after model change by re-querying via setSessionConfigOption.
    // The thought_level option may have changed (added/removed) for the new model.
    const currentThoughtLevelOption = this.configOptions.find(
      (o) => o.category === "thought_level",
    );
    if (currentThoughtLevelOption) {
      try {
        const response = await this.connection.setSessionConfigOption({
          sessionId,
          configId: currentThoughtLevelOption.id,
          value: currentThoughtLevelOption.currentValue,
        } satisfies SetSessionConfigOptionRequest);
        this.configOptions = response.configOptions;
      } catch {
        // New model may not support thought_level; remove stale thought_level options
        this.configOptions = this.configOptions.filter(
          (o) => o.category !== "thought_level",
        );
      }
      this._onDidOptionsChanged.fire();
    }
  }

  async setThink(
    sessionId: string,
    enabled: boolean,
    config?: ThinkConfig,
  ): Promise<{
    success: boolean;
    currentThinkEnabled: boolean;
    currentThinkConfig?: string;
    unsupported?: boolean;
    errorMessage?: string;
  }> {
    await this.ensureReady(this.mode);
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }

    try {
      const response = await this.connection.extMethod("session/set_think", {
        sessionId,
        thinkEnabled: enabled,
        thinkConfig: config,
      });
      return response as {
        success: boolean;
        currentThinkEnabled: boolean;
        currentThinkConfig?: string;
        unsupported?: boolean;
        errorMessage?: string;
      };
    } catch (error) {
      const message = extractReadableErrorMessage(error);
      if (isUnsupportedSetThinkError(message)) {
        this.logChannel.warn(
          `session/set_think is unsupported by agent ${this.agent.id}; falling back to startup-only thinking only. Details: ${message}`,
        );
        return {
          success: false,
          currentThinkEnabled: enabled,
          currentThinkConfig: config,
          unsupported: true,
          errorMessage: message,
        };
      }

      this.logChannel.error(`Failed to set think mode: ${message}`);
      throw error;
    }
  }

  getConfigOptions(): SessionConfigOption[] {
    return this.configOptions;
  }

  async setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    await this.ensureReady(this.mode);
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }
    const response = await this.connection.setSessionConfigOption({
      sessionId,
      configId,
      value,
    } satisfies SetSessionConfigOptionRequest);
    this.configOptions = response.configOptions;
    this._onDidOptionsChanged.fire();
  }

  async sendQuestionAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, unknown>,
  ): Promise<void> {
    if (!this.connection) {
      this.logChannel.warn(
        "Cannot send question answers: connection not ready",
      );
      return;
    }

    try {
      await this.connection.extNotification("questionAnswers", {
        sessionId,
        toolCallId,
        answers,
      });
    } catch (error) {
      this.logChannel.error(
        `Failed to send question answers: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async listNativeSessions(cursor?: string): Promise<ListSessionsResponse> {
    if (!this.connection) {
      throw new Error("AcpClient not connected");
    }
    return this.connection.unstable_listSessions({ cursor });
  }

  async readTextFile(params: { uri: string }): Promise<{ content: string }> {
    const uri = vscode.Uri.parse(params.uri);
    const openDoc = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.fsPath === uri.fsPath,
    );
    if (openDoc) {
      return { content: openDoc.getText() };
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    return { content: new TextDecoder().decode(bytes) };
  }

  async writeTextFile(params: { uri: string; content: string }): Promise<void> {
    const uri = vscode.Uri.parse(params.uri);
    await writeTextFileWithCoordinator(uri, params.content, {
      logChannel: this.logChannel,
      logPrefix: `[acp:${this.agent.id}]`,
    });
    const resolvedCount = resolveExternalEditsForUri(uri);
    if (resolvedCount > 0) {
      this.logChannel.debug(
        `[acp:${this.agent.id}] Resolved ${resolvedCount} tracked edit callback(s) after writeTextFile completed for ${uri.toString()}`,
      );
    }
  }

  async dispose(): Promise<void> {
    await this.stopProcess();
    super.dispose();
  }

  private async ensureAgentRunning(): Promise<void> {
    if (this.agentProcess && !this.agentProcess.killed) {
      return;
    }
    const args = Array.from(this.agent.args ?? []);
    this.logChannel.info(
      `[acp:${this.agent.id}] Starting ACP agent process: ${this.agent.command}${args.length ? ` ${args.join(" ")}` : ""}`,
    );
    const agentProc = spawn(this.agent.command, args, {
      cwd: this.agent.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...this.agent.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });
    agentProc.stderr?.on("data", (data) => {
      this.logChannel.debug(`agent:${this.agent.id} ${data.toString().trim()}`);
    });
    agentProc.on("exit", async (code) => {
      this.logChannel.debug(
        `agent:${this.agent.id} exited with code ${code ?? "unknown"}`,
      );
      this._onDidStop.fire();
    });
    agentProc.on("error", (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logChannel.error(
        `agent:${this.agent.id} failed to start: ${errorMessage}`,
      );
      this._onDidStop.fire();
    });
    this.agentProcess = agentProc;
  }

  private async createConnection(mode: ClientMode): Promise<void> {
    await this.ensureAgentRunning();
    const stdinStream = this.agentProcess?.stdin
      ? Writable.toWeb(this.agentProcess.stdin)
      : undefined;
    const stdoutStream = this.agentProcess?.stdout
      ? Readable.toWeb(this.agentProcess.stdout)
      : undefined;
    if (!stdinStream || !stdoutStream) {
      throw new Error("Failed to connect ACP client streams");
    }
    const stream = ndJsonStream(stdinStream, stdoutStream);
    this.connection = new ClientSideConnection(() => this, stream);

    const initResponse = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    });
    this.agentCapabilities = initResponse.agentCapabilities;
    this.logChannel.info(
      `[acp:${this.agent.id}] ACP initialize negotiated protocol v${initResponse.protocolVersion}; clientCapabilities=${JSON.stringify(
        CLIENT_CAPABILITIES,
      )}; agentCapabilities=${JSON.stringify(initResponse.agentCapabilities)}; authMethods=${formatAuthMethodSummary(initResponse)}`,
    );
    const disabledClientCapabilities = getDisabledClientCapabilitySummary(
      CLIENT_CAPABILITIES,
    );
    if (disabledClientCapabilities.length) {
      this.logChannel.info(
        `[acp:${this.agent.id}] Client capability caveat: ${disabledClientCapabilities.join(
          ", ",
        )}. Agents that rely on these ACP client APIs may not surface full terminal/file UX in this extension yet.`,
      );
    }
    this._onDidStart.fire();
    this.mode = mode;
  }

  private async stopProcess(): Promise<void> {
    if (this.agentProcess && !this.agentProcess.killed) {
      this.agentProcess.kill();
      await this.connection?.closed;
    }

    this.agentProcess = null;
    this.connection = null;
    this.readyPromise = null;
  }
}

function serializeMcpServers(
  mcpServers: readonly AcpMcpServerConfiguration[] | undefined,
): McpServer[] {
  if (!mcpServers?.length) {
    return [];
  }
  return mcpServers
    .map(serializeMcpServer)
    .filter((value): value is McpServer => value !== null);
}

function serializeMcpServer(
  config: AcpMcpServerConfiguration,
): McpServer | null {
  switch (config.type) {
    case "http":
      return serializeHttpServer(config);
    case "stdio":
      return serializeStdioServer(config);
    default:
      return null;
  }
}

function serializeStdioServer(
  config: Extract<AcpMcpServerConfiguration, { type: "stdio" }>,
): McpServerStdio {
  return {
    name: config.name,
    command: config.command,
    args: Array.from(config.args ?? []),
    env: serializeEnv(config.env),
  } satisfies McpServerStdio;
}

function serializeHttpServer(
  config: Extract<AcpMcpServerConfiguration, { type: "http" }>,
): McpServer {
  return {
    type: "http",
    name: config.name,
    url: config.url,
    headers: serializeHeaders(config.headers),
  } satisfies McpServer;
}

function serializeEnv(
  env: Record<string, string> | undefined,
): McpServerStdio["env"] {
  if (!env) {
    return [];
  }
  return Object.entries(env).map(([name, value]) => ({ name, value }));
}

function serializeHeaders(
  headers: Record<string, string> | undefined,
): McpServerHttp["headers"] {
  if (!headers) {
    return [];
  }
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function isUnsupportedSetThinkError(message: string): boolean {
  const normalized = message.toLowerCase();
  const mentionsMethod =
    normalized.includes("session/set_think") ||
    normalized.includes("set_think");
  const indicatesUnsupported =
    normalized.includes("method not found") ||
    normalized.includes("unknown method") ||
    normalized.includes("unsupported") ||
    normalized.includes("not implemented") ||
    normalized.includes("-32601");

  return mentionsMethod && indicatesUnsupported;
}

function formatAuthMethodSummary(response: InitializeResponse): string {
  if (!response.authMethods?.length) {
    return "none";
  }

  return response.authMethods
    .map((method) => `${method.id}:${method.name}`)
    .join(", ");
}

function getDisabledClientCapabilitySummary(
  capabilities: ClientCapabilities,
): string[] {
  const disabled: string[] = [];
  const fileSystemCapabilities = capabilities.fs;

  if (!capabilities.terminal) {
    disabled.push("terminal/* disabled");
  }

  if (!fileSystemCapabilities?.readTextFile) {
    disabled.push("fs/read_text_file disabled");
  }

  if (!fileSystemCapabilities?.writeTextFile) {
    disabled.push("fs/write_text_file disabled");
  }

  return disabled;
}