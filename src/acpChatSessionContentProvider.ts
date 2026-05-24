// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { Uri } from "vscode";
import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import { AcpChatParticipant } from "./acpChatParticipant";
import { AcpSessionManager, Options } from "./acpSessionManager";
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
        ...getConfigOptionCurrentValues(acpSession.client.getConfigOptions()),
        ...(this.supportsLiveThinkingEffort === false
          ? {}
          : {
              [VscodeSessionOptions.Think]: acpSession.thinkState.enabled
                ? acpSession.thinkState.config || "think"
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
    const configOptionKeys = getConfigOptionKeys(options.configOptions);
    if (
      modeState &&
      !hasConfigOption(configOptionKeys, VscodeSessionOptions.Mode)
    ) {
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
    if (
      modelState &&
      !hasConfigOption(configOptionKeys, VscodeSessionOptions.Model)
    ) {
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

    for (const configOption of options.configOptions) {
      const group = toChatSessionProviderOptionGroup(configOption);
      if (group) {
        responseOptions.optionGroups?.push(group);
      }
    }

    if (
      this.supportsLiveThinkingEffort !== false &&
      !hasConfigOption(configOptionKeys, "thought_level") &&
      !hasConfigOption(configOptionKeys, VscodeSessionOptions.Think)
    ) {
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
      const configOption = session.client
        .getConfigOptions()
        .find((option) => option.id === update.optionId);
      if (configOption && update.value !== undefined) {
        await session.client.setSessionConfigOption(
          session.acpSessionId,
          configOption.id,
          update.value,
        );
        if (isConfigOptionCategory(configOption, VscodeSessionOptions.Mode)) {
          session.defaultChatOptions.modeId = update.value;
        } else if (
          isConfigOptionCategory(configOption, VscodeSessionOptions.Model)
        ) {
          session.defaultChatOptions.modelId = update.value;
        }
        continue;
      }

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
          const modeLabel = enabled ? config || "think" : "off";
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

type ConfigOptionKeys = {
  ids: Set<string>;
  categories: Set<string>;
};

function getConfigOptionKeys(
  configOptions: readonly SessionConfigOption[],
): ConfigOptionKeys {
  const ids = new Set<string>();
  const categories = new Set<string>();
  for (const option of configOptions) {
    ids.add(option.id);
    if (option.category) {
      categories.add(option.category);
    }
  }
  return { ids, categories };
}

function hasConfigOption(
  keys: ConfigOptionKeys,
  idOrCategory: string,
): boolean {
  return keys.ids.has(idOrCategory) || keys.categories.has(idOrCategory);
}

function isConfigOptionCategory(
  configOption: SessionConfigOption,
  category: string,
): boolean {
  return configOption.category === category || configOption.id === category;
}

function getConfigOptionCurrentValues(
  configOptions: readonly SessionConfigOption[],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const option of configOptions) {
    values[option.id] = option.currentValue;
  }
  return values;
}

function toChatSessionProviderOptionGroup(
  configOption: SessionConfigOption,
): vscode.ChatSessionProviderOptionGroup | undefined {
  const items = flattenConfigOptionItems(configOption);
  if (!items.length) {
    return undefined;
  }

  return {
    id: configOption.id,
    name: configOption.name || getConfigOptionFallbackName(configOption),
    description:
      configOption.description ??
      getConfigOptionFallbackDescription(configOption),
    items,
  };
}

function flattenConfigOptionItems(
  configOption: SessionConfigOption,
): vscode.ChatSessionProviderOptionItem[] {
  const items: vscode.ChatSessionProviderOptionItem[] = [];
  for (const optionOrGroup of configOption.options) {
    if (isSessionConfigSelectGroup(optionOrGroup)) {
      for (const option of optionOrGroup.options) {
        items.push(
          toProviderOptionItem(
            option,
            configOption.currentValue,
            optionOrGroup,
          ),
        );
      }
    } else {
      items.push(
        toProviderOptionItem(optionOrGroup, configOption.currentValue),
      );
    }
  }
  return items;
}

function isSessionConfigSelectGroup(
  value: SessionConfigSelectOption | SessionConfigSelectGroup,
): value is SessionConfigSelectGroup {
  return "group" in value && Array.isArray(value.options);
}

function toProviderOptionItem(
  option: SessionConfigSelectOption,
  currentValue: string,
  group?: SessionConfigSelectGroup,
): vscode.ChatSessionProviderOptionItem {
  return {
    id: option.value,
    name: group ? `${group.name}: ${option.name}` : option.name,
    description: option.description ?? undefined,
    default: option.value === currentValue,
  };
}

function getConfigOptionFallbackName(
  configOption: SessionConfigOption,
): string {
  switch (configOption.category) {
    case VscodeSessionOptions.Mode:
      return vscode.l10n.t("Mode");
    case VscodeSessionOptions.Model:
      return vscode.l10n.t("Model");
    case "thought_level":
      return vscode.l10n.t("Thinking");
    default:
      return configOption.id;
  }
}

function getConfigOptionFallbackDescription(
  configOption: SessionConfigOption,
): string | undefined {
  switch (configOption.category) {
    case VscodeSessionOptions.Mode:
      return vscode.l10n.t("Select the mode for the chat session");
    case VscodeSessionOptions.Model:
      return vscode.l10n.t("Select the model for the chat session");
    case "thought_level":
      return vscode.l10n.t("Configure the thinking / reasoning effort");
    default:
      return undefined;
  }
}
