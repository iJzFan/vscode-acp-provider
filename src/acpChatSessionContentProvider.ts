// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { Uri } from "vscode";
import { AcpChatParticipant } from "./acpChatParticipant";
import {
  AcpSessionManager,
  Options,
} from "./acpSessionManager";
import { DisposableBase } from "./disposables";
import {
  ThinkingEffortModes,
  type ThinkConfig,
  VscodeSessionOptions,
} from "./types";

export class AcpChatSessionContentProvider
  extends DisposableBase
  implements vscode.ChatSessionContentProvider
{
  private supportsLiveThinkingEffort: boolean | undefined;

  constructor(
    private readonly sessionManager: AcpSessionManager,
    private readonly participant: AcpChatParticipant,
    private readonly logChannel: vscode.LogOutputChannel,
  ) {
    super();

    this._register(
      sessionManager.onDidOptionsChange(() => {
        this._onDidChangeChatSessionProviderOptions.fire();
      }),
    );

    this._register(
      sessionManager.onDidContextWindowChange(({ resource, modelId }) => {
        this._onDidChangeChatSessionOptions.fire({
          resource,
          updates: [{ optionId: "model", value: modelId }],
        });
      }),
    );
  }

  // start event definitions --------------------------------------------------
  private readonly _onDidChangeChatSessionOptions: vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent> =
    new vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>();
  onDidChangeChatSessionOptions?: vscode.Event<vscode.ChatSessionOptionChangeEvent> =
    this._onDidChangeChatSessionOptions.event;

  private readonly _onDidChangeChatSessionProviderOptions: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  onDidChangeChatSessionProviderOptions?: vscode.Event<void> | undefined =
    this._onDidChangeChatSessionProviderOptions.event;
  // end event definitions -----------------------------------------------------

  async provideChatSessionContent(
    resource: vscode.Uri,
    _token: vscode.CancellationToken,
  ): Promise<vscode.ChatSession> {
    const response = await this.sessionManager.createOrGet(resource);
    const { session: acpSession, history } = response;

    this.logChannel.debug(
      `Providing chat session content for resource: ${resource.toString()}, acpSessionId: ${acpSession.acpSessionId}, history length: ${history?.length || 0}`,
    );

    const session: vscode.ChatSession = {
      history: history || [],
      requestHandler: this.participant.requestHandler,
      options: {
        [VscodeSessionOptions.Mode]: acpSession.defaultChatOptions.modeId,
        [VscodeSessionOptions.Model]: acpSession.defaultChatOptions.modelId,
        ...(this.supportsLiveThinkingEffort === false
          ? {}
          : {
              [VscodeSessionOptions.Think]: acpSession.thinkState.enabled
                ? (acpSession.thinkState.config || "think")
                : "",
            }),
      },
    };
    return session;
  }

  provideChatSessionProviderOptions(
    token: vscode.CancellationToken,
  ): Thenable<vscode.ChatSessionProviderOptions> {
    return this.sessionManager.getOptions().then((options) => {
      return this.buildOptionsGroup(options);
    });
  }

  private buildOptionsGroup(
    options: Options,
  ): vscode.ChatSessionProviderOptions {
    const responseOptions: vscode.ChatSessionProviderOptions = {
      optionGroups: [],
    };

    const modeState = options.modes;
    if (modeState) {
      const modeOptions: vscode.ChatSessionProviderOptionItem[] =
        modeState.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description || undefined,
        }));
      responseOptions.optionGroups?.push({
        id: VscodeSessionOptions.Mode,
        name: vscode.l10n.t("Mode"),
        description: vscode.l10n.t("Select the mode for the chat session"),
        items: modeOptions,
      });
    }

    const modelState = options.models;
    if (modelState) {
      const modelOptions: vscode.ChatSessionProviderOptionItem[] =
        modelState.availableModels.map((model) => ({
          id: model.modelId,
          name: model.name,
          description: model.description || undefined,
        }));
      responseOptions.optionGroups?.push({
        id: VscodeSessionOptions.Model,
        name: vscode.l10n.t("Model"),
        description: vscode.l10n.t("Select the model for the chat session"),
        items: modelOptions,
      });
    }

    if (this.supportsLiveThinkingEffort !== false) {
      responseOptions.optionGroups?.push({
        id: VscodeSessionOptions.Think,
        name: vscode.l10n.t("Thinking"),
        description: vscode.l10n.t("Configure the thinking / reasoning effort"),
        items: [
          {
            id: "",
            name: vscode.l10n.t("Off"),
            description: vscode.l10n.t("Disable thinking effort"),
          },
          {
            id: "think",
            name: vscode.l10n.t("Think"),
            description: vscode.l10n.t("Enable basic thinking effort"),
          },
          {
            id: "megathink",
            name: vscode.l10n.t("Mega Think"),
            description: vscode.l10n.t("Enable enhanced thinking effort"),
          },
          {
            id: "ultrathink",
            name: vscode.l10n.t("Ultra Think"),
            description: vscode.l10n.t("Enable maximum thinking effort"),
          },
        ],
      });
    }

    return responseOptions;
  }

  async provideHandleOptionsChange(
    resource: Uri,
    updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const session = this.sessionManager.getActive(resource);
    if (!session) {
      this.logChannel.warn(
        `No session found to handle provideHandleOptionsChange for ${resource.toString()}`,
      );
      return;
    }

    for (const update of updates) {
      if (update.optionId === VscodeSessionOptions.Mode && update.value) {
        await session.client.changeMode(session.acpSessionId, update.value);
      }

      if (update.optionId === VscodeSessionOptions.Model && update.value) {
        await session.client.changeModel(session.acpSessionId, update.value);
      }

      if (update.optionId === VscodeSessionOptions.Think) {
        const enabled = update.value !== "";
        const config =
          update.value &&
          ThinkingEffortModes.includes(update.value as ThinkConfig)
            ? (update.value as ThinkConfig)
            : undefined;
        const thinkResult = await this.sessionManager.setThink(
          resource,
          enabled,
          config,
        );

        if (thinkResult.downgradedToStartupOnly) {
          const modeLabel = enabled ? (config || "think") : "off";
          this.supportsLiveThinkingEffort = false;
          this.logChannel.info(
            `ACP agent does not support live thinking-effort updates for agent session ${session.acpSessionId}; hiding the Thinking session option and keeping '${modeLabel}' as the startup preference.`,
          );
          this._onDidChangeChatSessionProviderOptions.fire();
        }
      }
    }
  }

  override dispose(): void {
    this._onDidChangeChatSessionOptions.dispose();
    this._onDidChangeChatSessionProviderOptions.dispose();
    super.dispose();
  }
}
