// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { AcpClient, AcpPermissionHandler, createAcpClient } from "./acpClient";
import { DiskSession, SessionDb } from "./acpSessionDb";
import { AgentRegistryEntry } from "./agentRegistry";
import { createSessionUri, decodeVscodeResource } from "./chatIdentifiers";
import { DisposableBase } from "./disposables";
import { getWorkspaceCwd } from "./permittedPaths";
import { TurnBuilder } from "./turnBuilder";
import {
  extractReadableErrorMessage,
  type SurfacedCommand,
  type ScannedSkill,
  type ThinkConfig,
  type ThinkState,
} from "./types";
import {
  buildAvailableCommandLogSummary,
  toManualSurfacedCommand,
} from "./commandMatching";
import { scanSkillDirectories } from "./skillDiscovery";
import {
  type AvailableCommand,
  SessionModelState,
  SessionModeState,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { mergeToolDiffArtifacts, ToolDiffArtifact } from "./diffRendering";

let sessionManagerVscode: typeof vscode = vscode;

export function setSessionManagerVscodeForTesting(
  value: typeof vscode | undefined,
): void {
  sessionManagerVscode = value ?? vscode;
}

export class Session {
  private _status: vscode.ChatSessionStatus;
  private _title: string;
  private _updatedAt: number;
  private _thinkState: ThinkState;
  pendingRequest?: {
    cancellation: vscode.CancellationTokenSource;
    permissionContext?: vscode.Disposable;
  };

  /** Resolver functions for each queued prompt, in FIFO order. */
  private _queueResolvers: Array<() => void> = [];

  /**
   * Wait for this session's turn to send a prompt.
   * If no request is currently in flight, returns immediately.
   * Otherwise, adds the caller to a FIFO queue and blocks until
   * every earlier entry has been dequeued.
   */
  async waitForTurn(): Promise<void> {
    if (!this.pendingRequest) {
      return;
    }
    return new Promise<void>((resolve) => {
      this._queueResolvers.push(resolve);
    });
  }

  /** Dequeue and signal the next waiter (if any) to proceed. */
  signalNext(): void {
    const next = this._queueResolvers.shift();
    next?.();
  }

  get queueLength(): number {
    return this._queueResolvers.length;
  }

  /** Latest context window usage reported via `usage_update` notifications. */
  contextWindowUsed?: number;
  /** Context window capacity reported via `usage_update` notifications. */
  contextWindowSize?: number;

  constructor(
    readonly agent: AgentRegistryEntry,
    private _vscodeResource: vscode.Uri,
    readonly client: AcpClient,
    readonly acpSessionId: string,
    readonly defaultChatOptions: { modeId: string; modelId: string },
    readonly cwd: string = getWorkspaceCwd(),
  ) {
    this._status = sessionManagerVscode.ChatSessionStatus.InProgress;
    this.pendingRequest = undefined;
    this._title = `Session [${agent.id}] ${acpSessionId}`;
    this._updatedAt = Date.now();
    this._thinkState = { enabled: false };
  }

  get title(): string {
    return this._title;
  }

  get vscodeResource(): vscode.Uri {
    return this._vscodeResource;
  }

  set vscodeResource(value: vscode.Uri) {
    this._vscodeResource = value;
  }

  set title(value: string) {
    this._title = value;
  }
  get updatedAt(): number {
    return this._updatedAt;
  }

  get status(): vscode.ChatSessionStatus {
    return this._status;
  }

  get thinkState(): ThinkState {
    return this._thinkState;
  }

  setThinkState(enabled: boolean, config?: ThinkConfig): void {
    this._thinkState = { enabled, config };
    this._updatedAt = Date.now();
  }

  markAsInProgress(): void {
    this._status = sessionManagerVscode.ChatSessionStatus.InProgress;
    this._updatedAt = Date.now();
  }

  markAsCompleted(): void {
    this._status = sessionManagerVscode.ChatSessionStatus.Completed;
    this._updatedAt = Date.now();
  }

  markAsFailed(): void {
    this._status = sessionManagerVscode.ChatSessionStatus.Failed;
    this._updatedAt = Date.now();
  }

  markAsNeedsInput(): void {
    this._status = sessionManagerVscode.ChatSessionStatus.NeedsInput;
    this._updatedAt = Date.now();
  }
}

export type Options = {
  modes: SessionModeState | null;
  models: SessionModelState | null;
};

export type SetThinkResult = {
  appliedDynamically: boolean;
  downgradedToStartupOnly: boolean;
  effectiveEnabled: boolean;
  effectiveConfig?: ThinkConfig;
  reason?: string;
};

export interface AcpSessionManager extends vscode.Disposable {
  onDidChangeSession: vscode.Event<{ original: Session; modified: Session }>;
  onDidOptionsChange: vscode.Event<void>;
  onDidUsageUpdate: vscode.Event<{ modelId: string; maxWindowSize: number }>;
  onDidContextWindowChange: vscode.Event<{ resource: vscode.Uri; modelId: string }>;

  createOrGet(vscodeResource: vscode.Uri): Promise<{
    session: Session;
    history?: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2>;
  }>;
  get(vscodeResource: vscode.Uri): Promise<DiskSession | undefined>;
  getActive(vscodeResource: vscode.Uri): Session | undefined;
  list(): Promise<vscode.ChatSessionItem[]>;
  syncSessionState(
    vscodeResource: vscode.Uri,
    modified: Session,
  ): Promise<void>;
  getOptions(): Promise<Options>;
  setThink(
    vscodeResource: vscode.Uri,
    enabled: boolean,
    config?: ThinkConfig,
  ): Promise<SetThinkResult>;
  getAvailableCommands(sessionId: string): SurfacedCommand[];
  getKnownAvailableCommands(): SurfacedCommand[];
  getDiscoveredSkills(): ScannedSkill[];
  closeSession(vscodeResource: vscode.Uri): void;
  createSessionUri(session: Session): vscode.Uri;
  reportContextWindowSize(
    session: Session,
    args: { size: number; used: number },
  ): void;
  recordToolDiffArtifacts(
    sessionId: string,
    artifacts: readonly ToolDiffArtifact[],
  ): void;
  getCumulativeToolDiffArtifacts(sessionId: string): ToolDiffArtifact[];
  getSessionChangedFiles(sessionId: string): vscode.ChatSessionChangedFile2[];
  clearCumulativeToolDiffArtifacts(sessionId: string): void;
}

export function createAcpSessionManager(
  sessionDb: SessionDb,
  agent: AgentRegistryEntry,
  permissionHandler: AcpPermissionHandler,
  logger: vscode.LogOutputChannel,
  clientProvider?: () => AcpClient,
): AcpSessionManager {
  return new SessionManager(
    sessionDb,
    agent,
    permissionHandler,
    logger,
    clientProvider,
  );
}

class SessionManager extends DisposableBase implements AcpSessionManager {
  private readonly client: AcpClient;
  constructor(
    private readonly sessionDb: SessionDb,
    private readonly agent: AgentRegistryEntry,
    readonly permissionHandler: AcpPermissionHandler,
    private readonly logger: vscode.LogOutputChannel,
    clientProvider: () => AcpClient = () =>
      createAcpClient(agent, permissionHandler, logger),
  ) {
    super();
    this.client = this._register(clientProvider());

    this._register(
      this.client.onSessionUpdate((update) =>
        this.handlePreChatSessionUpdate(update),
      ),
    );

    this._register(
      this.client.onDidOptionsChanged(() => {
        this._onDidChangeOptions.fire();
      }),
    );

    this._register(
      this.client.onDidStop(() => {
        this.handleClientStop();
      }),
    );

    this._register(
      this.sessionDb.onDataChanged(async () => {
        this.logger.debug(
          `Session DB data changed event received for agent ${this.agent.id}`,
        );
        await this.loadDiskSessionsIfNeeded(true);
      }),
    );
  }

  // start event definitions --------------------------------------------------
  private readonly _onDidChangeSession: vscode.EventEmitter<{
    original: Session;
    modified: Session;
  }> = new sessionManagerVscode.EventEmitter<{
    original: Session;
    modified: Session;
  }>();
  onDidChangeSession: vscode.Event<{ original: Session; modified: Session }> =
    this._onDidChangeSession.event;

  private readonly _onDidChangeOptions: vscode.EventEmitter<void> =
    new sessionManagerVscode.EventEmitter<void>();
  onDidOptionsChange: vscode.Event<void> = this._onDidChangeOptions.event;

  private readonly _onDidUsageUpdate = new sessionManagerVscode.EventEmitter<{
    modelId: string;
    maxWindowSize: number;
  }>();
  onDidUsageUpdate: vscode.Event<{ modelId: string; maxWindowSize: number }> =
    this._onDidUsageUpdate.event;

  private readonly _onDidContextWindowChange =
    new sessionManagerVscode.EventEmitter<{
    resource: vscode.Uri;
    modelId: string;
  }>();
  onDidContextWindowChange: vscode.Event<{
    resource: vscode.Uri;
    modelId: string;
  }> = this._onDidContextWindowChange.event;
  // end event definitions --------------------------------------------------

  private diskSessions: Map<string, DiskSession> | null = null;
  private activeSessions: Map<string, Session> = new Map();
  private availableCommands: Map<string, SurfacedCommand[]> = new Map();
  private discoveredSkills: ScannedSkill[] = [];
  private cumulativeToolDiffs = new Map<string, Map<string, ToolDiffArtifact>>();
  private probeSession: {
    acpSessionId: string;
    modes: SessionModeState | null;
    models: SessionModelState | null;
  } | null = null;

  createSessionUri(session: Session): vscode.Uri {
    const uri = createSessionUri(this.agent.id, session.acpSessionId);
    // find and replace the session with new session id in active sessions
    const entry = Array.from(this.activeSessions).find(
      (s) => s[1].acpSessionId === session.acpSessionId,
    );
    if (entry) {
      this.activeSessions.delete(entry[0]);
      this.logger.debug(
        `Replaced session with new session id ${session.acpSessionId}`,
      );
    } else {
      this.logger.debug(
        `Created session URI for session id ${session.acpSessionId} without replacement`,
      );
    }
    session.vscodeResource = uri;
    this.activeSessions.set(session.acpSessionId, session);
    return uri;
  }

  async createOrGet(vscodeResource: vscode.Uri): Promise<{
    session: Session;
    history?: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2>;
  }> {
    this.refreshSkills();
    const decodedResource = decodeVscodeResource(vscodeResource);

    const activeSession = this.activeSessions.get(decodedResource.sessionId);
    if (activeSession) {
      return { session: activeSession };
    }

    if (decodedResource.isUntitled) {
      this.logger.info(
        `Creating new untitled session for resource ${vscodeResource.toString()}`,
      );

      const thinkingSettings = this.getDefaultThinkingSettings();

      let acpSessionId: string;
      let modeId: string;
      let modelId: string;

      if (this.probeSession) {
        this.logger.info(
          `Reusing probe session ${this.probeSession.acpSessionId} for untitled session`,
        );
        acpSessionId = this.probeSession.acpSessionId;
        modeId = this.probeSession.modes?.currentModeId || "";
        modelId = this.probeSession.models?.currentModelId || "";
        this.probeSession = null;
      } else {
        const acpSession = await this.client.createSession(
          getWorkspaceCwd(),
          this.agent.mcpServers,
          thinkingSettings,
        );
        acpSessionId = acpSession.sessionId;
        modeId = acpSession.modes?.currentModeId || "";
        modelId = acpSession.models?.currentModelId || "";
      }
      ({ modeId, modelId } = await this.applyConfiguredSessionDefaults(
        acpSessionId,
        modeId,
        modelId,
      ));
      const session = new Session(
        this.agent,
        vscodeResource,
        this.client,
        acpSessionId,
        {
          modeId,
          modelId,
        },
      );
      if (thinkingSettings?.thinkingModeEnabled) {
        session.setThinkState(
          true,
          thinkingSettings.thinkingConfig ?? "think",
        );
      }
      this.activeSessions.set(decodedResource.sessionId, session);

      const expectedOriginal = new Session(
        session.agent,
        vscodeResource,
        session.client,
        session.acpSessionId,
        session.defaultChatOptions,
      );

      this._onDidChangeSession.fire({
        original: expectedOriginal,
        modified: session,
      });
      return { session };
    } else {
      const existingSession = await this.get(vscodeResource);
      if (existingSession) {
        this.logger.debug(
          `Session found on disk for resource ${vscodeResource.toString()}`,
        );

        try {
          const response = await this.client.loadSession(
            existingSession.sessionId,
            existingSession.cwd,
            this.agent.mcpServers,
          );
          const session = new Session(
            this.agent,
            vscodeResource,
            this.client,
            existingSession.sessionId,
            {
              modeId: response.modeId || "",
              modelId: response.modelId || "",
            },
          );
          this.activeSessions.set(decodedResource.sessionId, session);

          const turnBuilder = new TurnBuilder(this.agent.id, this.logger);
          response.notifications.forEach((notification) =>
            turnBuilder.processNotification(notification),
          );
          const history = turnBuilder.getTurns();

          this.logger.debug(
            `Resuming session with ${history.length} history turns from disk session.`,
          );
          return { session, history };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (
            errorMessage.includes("Session not found") ||
            errorMessage.includes("not found")
          ) {
            this.logger.warn(
              `Session ${existingSession.sessionId} not found on agent side, creating new session. Error: ${errorMessage}`,
            );
            await this.sessionDb.deleteSession(
              this.agent.id,
              existingSession.sessionId,
            );
          } else {
            throw error;
          }
        }
      }

      this.logger.info(
        `Creating new session for resource ${vscodeResource.toString()}`,
      );

      const thinkingSettings = this.getDefaultThinkingSettings();

      const acpSession = await this.client.createSession(
        getWorkspaceCwd(),
        this.agent.mcpServers,
        thinkingSettings,
      );

      const configuredDefaults = await this.applyConfiguredSessionDefaults(
        acpSession.sessionId,
        acpSession.modes?.currentModeId || "",
        acpSession.models?.currentModelId || "",
      );

      const session = new Session(
        this.agent,
        vscodeResource,
        this.client,
        acpSession.sessionId,
        {
          modeId: configuredDefaults.modeId,
          modelId: configuredDefaults.modelId,
        },
      );
      if (thinkingSettings?.thinkingModeEnabled) {
        session.setThinkState(
          true,
          thinkingSettings.thinkingConfig ?? "think",
        );
      }
      this.activeSessions.set(decodedResource.sessionId, session);

      const expectedOriginal = new Session(
        session.agent,
        vscodeResource,
        session.client,
        session.acpSessionId,
        session.defaultChatOptions,
      );

      this._onDidChangeSession.fire({
        original: expectedOriginal,
        modified: session,
      });
      return { session };
    }
  }

  async get(vscodeResource: vscode.Uri): Promise<DiskSession | undefined> {
    const decoded = decodeVscodeResource(vscodeResource);
    await this.loadDiskSessionsIfNeeded();

    const session = this.diskSessions?.get(decoded.sessionId);
    return session;
  }

  getActive(vscodeResource: vscode.Uri): Session | undefined {
    const decodedResource = decodeVscodeResource(vscodeResource);
    return this.activeSessions.get(decodedResource.sessionId);
  }

  async list(): Promise<vscode.ChatSessionItem[]> {
    await this.loadDiskSessionsIfNeeded();
    if (!this.diskSessions) {
      return [];
    }

    const chatSessionItems: vscode.ChatSessionItem[] = [];
    for (const [sessionId, session] of this.diskSessions) {
      const resource = createSessionUri(this.agent.id, sessionId);

      chatSessionItems.push({
        label: session.title || session.sessionId,
        status: sessionManagerVscode.ChatSessionStatus.Completed,
        resource: resource,
        timing: {
          created: Number(session.updatedAt),
        },
        changes: this.getSessionChangedFiles(session.sessionId),
      });
    }
    return chatSessionItems;
  }

  async syncSessionState(
    vscodeResource: vscode.Uri,
    modified: Session,
  ): Promise<void> {
    const decoded = decodeVscodeResource(vscodeResource);
    const session = this.activeSessions.get(decoded.sessionId);

    if (!session) {
      this.logger.warn(
        `No active session found for resource ${vscodeResource.toString()} to sync state.`,
      );
      return;
    }

    this.activeSessions.set(decoded.sessionId, modified);
    this._onDidChangeSession.fire({
      original: session,
      modified: modified,
    });

    if (decoded.isUntitled && this.isTerminalSessionStatus(modified.status)) {
      this.activeSessions.delete(decoded.sessionId);
      this.logger.debug(
        `Released untitled session cache for session ${modified.acpSessionId} after terminal state ${modified.status}`,
      );
    }
  }

  async getOptions(): Promise<Options> {
    let modes = this.client.getSupportedModeState();
    let models = this.client.getSupportedModelState();

    const options: Options = {
      modes,
      models,
    };
    return options;
  }

  async setThink(
    vscodeResource: vscode.Uri,
    enabled: boolean,
    config?: ThinkConfig,
  ): Promise<SetThinkResult> {
    const decoded = decodeVscodeResource(vscodeResource);
    const session = this.activeSessions.get(decoded.sessionId);

    if (!session) {
      this.logger.warn(
        `No active session found for resource ${vscodeResource.toString()} to set think mode.`,
      );
      return {
        appliedDynamically: false,
        downgradedToStartupOnly: false,
        effectiveEnabled: enabled,
        effectiveConfig: config,
        reason: "No active session found",
      };
    }

    try {
      const result = await session.client.setThink(
        session.acpSessionId,
        enabled,
        config,
      );

      if (result.success) {
        const original = this.snapshotSession(session);
        session.setThinkState(
          result.currentThinkEnabled,
          result.currentThinkConfig as ThinkConfig | undefined,
        );
        this._onDidChangeSession.fire({ original, modified: session });

        return {
          appliedDynamically: true,
          downgradedToStartupOnly: false,
          effectiveEnabled: result.currentThinkEnabled,
          effectiveConfig: result.currentThinkConfig as ThinkConfig | undefined,
        };
      }

      if (result.unsupported) {
        const original = this.snapshotSession(session);
        session.setThinkState(enabled, config);
        this._onDidChangeSession.fire({ original, modified: session });

        return {
          appliedDynamically: false,
          downgradedToStartupOnly: true,
          effectiveEnabled: enabled,
          effectiveConfig: config,
          reason:
            result.errorMessage ||
            "session/set_think is unsupported by the current ACP agent",
        };
      }

      return {
        appliedDynamically: false,
        downgradedToStartupOnly: false,
        effectiveEnabled: session.thinkState.enabled,
        effectiveConfig: session.thinkState.config,
        reason: result.errorMessage || "Unknown non-success response",
      };
    } catch (error) {
      this.logger.error(
        `Failed to set think mode: ${extractReadableErrorMessage(error)}`,
      );
      throw error;
    }
  }

  getAvailableCommands(sessionId: string): SurfacedCommand[] {
    const commandsByName = new Map<string, SurfacedCommand>();

    for (const command of this.agent.manualCommands.map((command) =>
      toManualSurfacedCommand(command),
    )) {
      commandsByName.set(command.name, command);
    }

    for (const command of this.availableCommands.get(sessionId) ?? []) {
      commandsByName.set(command.name, command);
    }

    return Array.from(commandsByName.values()).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  getDiscoveredSkills(): ScannedSkill[] {
    return this.discoveredSkills;
  }

  getKnownAvailableCommands(): SurfacedCommand[] {
    const commandsByName = new Map<string, SurfacedCommand>();

    for (const command of this.agent.manualCommands.map((entry) =>
      toManualSurfacedCommand(entry),
    )) {
      commandsByName.set(command.name, command);
    }

    for (const commands of this.availableCommands.values()) {
      for (const command of commands) {
        commandsByName.set(command.name, command);
      }
    }

    return Array.from(commandsByName.values()).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  reportContextWindowSize(
    session: Session,
    args: { size: number; used: number },
  ): void {
    session.contextWindowSize = args.size;
    session.contextWindowUsed = args.used;
    this._onDidUsageUpdate.fire({
      modelId: session.defaultChatOptions.modelId,
      maxWindowSize: args.size,
    });
    this._onDidContextWindowChange.fire({
      resource: session.vscodeResource,
      modelId: session.defaultChatOptions.modelId,
    });
  }

  // this handler must handle none-chat session messages
  private refreshSkills(): void {
    this.discoveredSkills = scanSkillDirectories(this.agent.skillPaths);
    this.logger.info(
      `Discovered ${this.discoveredSkills.length} skills from configured paths`,
    );
  }

  private handlePreChatSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate === "available_commands_update") {
      this.logger.info(
        `[acp:${this.agent.id}] Received ${update.availableCommands.length} ACP commands for session ${notification.sessionId}: ${buildAvailableCommandLogSummary(update.availableCommands.map((command) => ({ ...command, source: "acp" as const })))}`,
      );
      this.setAvailableCommands(
        notification.sessionId,
        update.availableCommands,
      );
    }
  }

  private setAvailableCommands(
    sessionId: string,
    commands: AvailableCommand[],
  ): void {
    this.availableCommands.set(
      sessionId,
      commands.map((command) => ({ ...command, source: "acp" as const })),
    );
  }

  private getDefaultThinkingSettings(): {
    thinkingModeEnabled: boolean;
    thinkingConfig?: ThinkConfig;
  } | undefined {
    const configuredDefault = this.agent.defaultThinkingEffort;
    if (!configuredDefault || configuredDefault === "off") {
      return undefined;
    }

    return {
      thinkingModeEnabled: true,
      thinkingConfig: configuredDefault,
    };
  }

  private async applyConfiguredSessionDefaults(
    sessionId: string,
    modeId: string,
    modelId: string,
  ): Promise<{ modeId: string; modelId: string }> {
    let nextModeId = modeId;
    let nextModelId = modelId;

    if (this.agent.defaultMode && this.agent.defaultMode !== nextModeId) {
      try {
        await this.client.changeMode(sessionId, this.agent.defaultMode);
        nextModeId = this.agent.defaultMode;
      } catch (error) {
        this.logger.warn(
          `Failed to apply default mode '${this.agent.defaultMode}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (this.agent.defaultModel && this.agent.defaultModel !== nextModelId) {
      try {
        await this.client.changeModel(sessionId, this.agent.defaultModel);
        nextModelId = this.agent.defaultModel;
      } catch (error) {
        this.logger.warn(
          `Failed to apply default model '${this.agent.defaultModel}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      modeId: nextModeId,
      modelId: nextModelId,
    };
  }

  private snapshotSession(session: Session): Session {
    const snapshot = new Session(
      session.agent,
      session.vscodeResource,
      session.client,
      session.acpSessionId,
      session.defaultChatOptions,
      session.cwd,
    );
    snapshot.title = session.title;
    if (session.thinkState.enabled) {
      snapshot.setThinkState(session.thinkState.enabled, session.thinkState.config);
    }

    switch (session.status) {
      case sessionManagerVscode.ChatSessionStatus.Completed:
        snapshot.markAsCompleted();
        break;
      case sessionManagerVscode.ChatSessionStatus.Failed:
        snapshot.markAsFailed();
        break;
      case sessionManagerVscode.ChatSessionStatus.NeedsInput:
        snapshot.markAsNeedsInput();
        break;
      default:
        snapshot.markAsInProgress();
        break;
    }

    return snapshot;
  }

  private isTerminalSessionStatus(status: vscode.ChatSessionStatus): boolean {
    return (
      status === sessionManagerVscode.ChatSessionStatus.Completed ||
      status === sessionManagerVscode.ChatSessionStatus.Failed
    );
  }

  private async loadDiskSessionsIfNeeded(
    reload: boolean = false,
  ): Promise<void> {
    if (!this.diskSessions || reload) {
      const data = await this.sessionDb.listSessions(
        this.agent.id,
        getWorkspaceCwd(),
      );
      this.diskSessions = new Map<string, DiskSession>(
        data.map((s) => [s.sessionId, s]),
      );
    }
  }

  private handleClientStop(): void {
    if (!this.activeSessions.size) {
      this.probeSession = null;
      this.availableCommands.clear();
      return;
    }

    const invalidatedSessions = Array.from(this.activeSessions.values()).map(
      (session) => session.acpSessionId,
    );

    for (const [sessionKey, session] of this.activeSessions) {
      this.disposeSessionClient(sessionKey, session);
    }

    this.activeSessions.clear();
    this.availableCommands.clear();
    this.probeSession = null;

    this.logger.warn(
      `[acp:${this.agent.id}] ACP client stopped; invalidated ${invalidatedSessions.length} active session(s): ${invalidatedSessions.join(", ")}`,
    );
  }

  private disposeSessionClient(sessionId: string, session: Session): void {
    session.pendingRequest?.cancellation.cancel();
    session.pendingRequest?.permissionContext?.dispose();
    session.pendingRequest = undefined;
  }

  closeSession(vscodeResource: vscode.Uri): void {
    const decoded = decodeVscodeResource(vscodeResource);
    const session = this.activeSessions.get(decoded.sessionId);
    if (!session) {
      return;
    }
    session.markAsFailed();
    this._onDidChangeSession.fire({ original: session, modified: session });

    this.disposeSessionClient(decoded.sessionId, session);
    this.activeSessions.delete(decoded.sessionId);
    this.availableCommands.delete(decoded.sessionId);
    this.cumulativeToolDiffs.delete(decoded.sessionId);
    this.logger.info(`Closed session and killed process: ${decoded.sessionId}`);
  }

  recordToolDiffArtifacts(
    sessionId: string,
    artifacts: readonly ToolDiffArtifact[],
  ): void {
    let sessionMap = this.cumulativeToolDiffs.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map<string, ToolDiffArtifact>();
      this.cumulativeToolDiffs.set(sessionId, sessionMap);
    }
    for (const artifact of artifacts) {
      const key = artifact.fileUri.toString();
      const existing = sessionMap.get(key);
      sessionMap.set(
        key,
        existing ? mergeToolDiffArtifacts(existing, artifact) : artifact,
      );
    }
  }

  getCumulativeToolDiffArtifacts(sessionId: string): ToolDiffArtifact[] {
    const sessionMap = this.cumulativeToolDiffs.get(sessionId);
    if (!sessionMap) {
      return [];
    }
    return Array.from(sessionMap.values());
  }

  getSessionChangedFiles(sessionId: string): vscode.ChatSessionChangedFile2[] {
    return this.getCumulativeToolDiffArtifacts(sessionId).map(
      (artifact) =>
        new sessionManagerVscode.ChatSessionChangedFile2(
          artifact.fileUri,
          artifact.hasOriginal ? artifact.originalUri : undefined,
          artifact.hasModified ? artifact.modifiedUri : undefined,
          artifact.added,
          artifact.removed,
        ),
    );
  }

  clearCumulativeToolDiffArtifacts(sessionId: string): void {
    this.cumulativeToolDiffs.delete(sessionId);
  }

  dispose(): void {
    super.dispose();
    for (const [sessionId, session] of this.activeSessions) {
      this.disposeSessionClient(sessionId, session);
    }
    this.activeSessions.clear();
    this.probeSession = null;
    this.diskSessions?.clear();
    this.availableCommands.clear();
    this.cumulativeToolDiffs.clear();
    this._onDidChangeSession.dispose();
    this._onDidChangeOptions.dispose();
  }
}
