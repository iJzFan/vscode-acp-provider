import * as vscode from "vscode";
import {
  createPermissionResolveCommandId,
  PermissionPromptManager,
} from "./permissionPrompts";
import { createAcpChatSessionItemController } from "./acpLifecycledChatSessionItemController";
import { createSessionDb, SessionDb } from "./acpSessionDb";
import { createTestAcpClientWithScenarios } from "./testScenarios";
import { AcpClient } from "./acpClient";
import { registerCommands } from "./commands";
import { registerDiffContentProvider } from "./diffContentProvider";
import {
  DefaultLanguageModelProvider,
  DEFAULT_MODEL_PROVIDER_ID,
  isCopilotAvailable,
  DefaultParticipant,
} from "./chatDefaults";
import { AgentRegistry } from "./agentRegistry";
import { ACP_CHAT_SCHEME } from "./chatIdentifiers";
import { AcpSessionManager, createAcpSessionManager } from "./acpSessionManager";
import { AcpChatParticipant } from "./acpChatParticipant";
import { AcpChatSessionContentProvider } from "./acpChatSessionContentProvider";
import {
  buildSlashCommandFilterText,
  formatCommandSourceBadge,
  formatSlashCommandLabel,
  getShortCommandName,
  getSlashCommandMatchScore,
  normalizeSlashCommandQuery,
} from "./commandMatching";

function getMissingRuntimeRequirements(): string[] {
  const missing: string[] = [];

  if (typeof vscode.chat.createChatParticipant !== "function") {
    missing.push("vscode.chat.createChatParticipant");
  }

  if (typeof vscode.chat.registerChatSessionContentProvider !== "function") {
    missing.push("vscode.chat.registerChatSessionContentProvider");
  }

  if (typeof vscode.chat.createChatSessionItemController !== "function") {
    missing.push("vscode.chat.createChatSessionItemController");
  }

  if (typeof vscode.lm.registerLanguageModelChatProvider !== "function") {
    missing.push("vscode.lm.registerLanguageModelChatProvider");
  }

  return missing;
}

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("ACP Client", {
    log: true,
  });
  context.subscriptions.push(outputChannel);

  const missingRequirements = getMissingRuntimeRequirements();
  if (missingRequirements.length > 0) {
    const message = `ACP Client requires VS Code Insiders 1.120+ with proposed chat APIs enabled. Missing APIs: ${missingRequirements.join(", ")}`;
    outputChannel.error(message);
    void vscode.window.showErrorMessage(message);
    return;
  }

  registerDiffContentProvider(context);

  const sessionDb = createSessionDb(context, outputChannel);
  context.subscriptions.push(sessionDb);

  const agentRegistry = new AgentRegistry();
  registerAgents({
    registry: agentRegistry,
    sessionDb,
    outputChannel,
    context,
  });
  // register a default model provider when ai features are disabled
  if (!isCopilotAvailable()) {
    const defaultLmProvider = new DefaultLanguageModelProvider();
    context.subscriptions.push(defaultLmProvider);
    context.subscriptions.push(
      vscode.lm.registerLanguageModelChatProvider(
        DEFAULT_MODEL_PROVIDER_ID,
        defaultLmProvider,
      ),
    );
    context.subscriptions.push(
      vscode.chat.createChatParticipant("acp-default", DefaultParticipant),
    );
  }

  registerCommands(context, { sessionDb }, outputChannel);
}

function registerAgents(params: {
  registry: AgentRegistry;
  sessionDb: SessionDb;
  outputChannel: vscode.LogOutputChannel;
  context: vscode.ExtensionContext;
}): Map<string, AcpSessionManager> {
  const { registry, outputChannel, context } = params;
  const managers = new Map<string, AcpSessionManager>();
  registry.list().forEach((agent) => {
    const permisionPromptsManager = new PermissionPromptManager(outputChannel);
    context.subscriptions.push(permisionPromptsManager);

    context.subscriptions.push(
      vscode.commands.registerCommand(
        createPermissionResolveCommandId(agent.id),
        (payload) => {
          permisionPromptsManager.resolveFromCommand(payload);
        },
      ),
    );
    type P = () => AcpClient;
    let clientProvider: P | undefined = undefined;
    if (process.env.MOCK_CLIENT === "true") {
      clientProvider = () => {
        return createTestAcpClientWithScenarios(permisionPromptsManager);
      };
    }

    const sessionManager = createAcpSessionManager(
      params.sessionDb,
      agent,
      permisionPromptsManager,
      outputChannel,
      clientProvider,
    );
    context.subscriptions.push(sessionManager);

    const participant = new AcpChatParticipant(
      permisionPromptsManager,
      sessionManager,
      outputChannel,
      `${ACP_CHAT_SCHEME}-${agent.id}`,
    );
    context.subscriptions.push(participant);

    const sessionContentProvider = new AcpChatSessionContentProvider(
      sessionManager,
      participant,
      outputChannel,
    );
    context.subscriptions.push(sessionContentProvider);

    const agentParticipantId = `${ACP_CHAT_SCHEME}-${agent.id}`;
    const participantInstance =
      typeof (vscode.chat as any).createDynamicChatParticipant === "function"
        ? (vscode.chat as any).createDynamicChatParticipant(
            agentParticipantId,
            {
              name: agent.id,
              publisherName: agent.id,
              description: agent.label,
              fullName: agent.label,
            } satisfies vscode.DynamicChatParticipantProps,
            participant.requestHandler,
          )
        : vscode.chat.createChatParticipant(
            agentParticipantId,
            participant.requestHandler,
          );

    // Try participantVariableProvider (chatParticipantAdditions proposed API)
    const participantAny = participantInstance as any;
    if (typeof participantAny.participantVariableProvider !== "undefined" || "participantVariableProvider" in participantAny) {
      participantAny.participantVariableProvider = {
        provider: participant.commandCompletionProvider,
        triggerCharacters: ["/"],
      };
      outputChannel.info(
        `[acp:${agent.id}] participantVariableProvider registered with trigger "/"`,
      );
    } else if (typeof participantAny.commandProvider !== "undefined" || "commandProvider" in participantAny) {
      participantAny.commandProvider = {
        provider: participant.commandCompletionProvider,
        triggerCharacters: ["/"],
      };
      outputChannel.info(
        `[acp:${agent.id}] commandProvider registered with trigger "/"`,
      );
    } else {
      outputChannel.info(
        `[acp:${agent.id}] ChatParticipant available properties: ${Object.getOwnPropertyNames(participantAny).filter(k => typeof (participantAny as any)[k] !== "function").join(", ")}`,
      );
      outputChannel.warn(
        `[acp:${agent.id}] No known completion provider property found on ChatParticipant; slash completions are disabled. Requires VS Code Insiders 1.120+ with chatParticipantAdditions proposed API.`,
      );
    }

    // Fallback CompletionItemProvider for chat input schemes.
    // The participantVariableProvider (above) only fires AFTER the user
    // has typed @agent – this covers the window before that point.
    // Known chat-editor schemes: acp-{id}, acp, vscode-chat-editor.
    for (const scheme of new Set([
      `${ACP_CHAT_SCHEME}-${agent.id}`,
      ACP_CHAT_SCHEME,
      "vscode-chat-editor",
    ])) {
      context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
          { scheme, pattern: "**" },
          {
            provideCompletionItems(_document, position, cancelToken, _context) {
              if (cancelToken.isCancellationRequested) return [];
              const textBefore = _document.getText(
                new vscode.Range(position.with(undefined, 0), position),
              );
              const slashMatch = textBefore.match(/(?:^|\s)\/([^\s]*)$/);
              if (!slashMatch) return [];
              const query = normalizeSlashCommandQuery(slashMatch[1] ?? "");

              // Determine which ACP agent the chat is associated with.
              // When no participant has been selected yet the session resource
              // is undefined — fall back to this provider's own agent so the
              // user still sees commands.
              const activeSessionUri = (
                vscode.chat as any
              ).activeChatPanelSessionResource as vscode.Uri | undefined;
              const useThisAgent =
                !activeSessionUri ||
                activeSessionUri.scheme.startsWith(ACP_CHAT_SCHEME);

              if (!useThisAgent) return [];

              // If the user hasn't typed @agent yet, prepend the agent
              // mention so the slash command routes to the ACP participant.
              const hasAgentMention = /@\w/.test(textBefore);
              const agentPrefix = hasAgentMention ? "" : `@${agent.id} `;

              const items: vscode.CompletionItem[] = [];
              const cmds = sessionManager.getKnownAvailableCommands();
              const names = new Set(cmds.map((c) => c.name));

              const scoredSkills = sessionManager
                .getDiscoveredSkills()
                .map((skill) => ({
                  skill,
                  score: getSlashCommandMatchScore(skill.name, query),
                }))
                .filter(({ skill, score }) => !names.has(skill.name) && score > 0)
                .sort((left, right) => {
                  const scoreDiff = right.score - left.score;
                  return scoreDiff !== 0
                    ? scoreDiff
                    : left.skill.name.localeCompare(right.skill.name);
                });

              for (const { skill, score } of scoredSkills) {
                const item = new vscode.CompletionItem(
                  formatSlashCommandLabel(skill.name),
                  vscode.CompletionItemKind.Text,
                );
                item.insertText = `${agentPrefix}/${skill.name} `;
                item.filterText = buildSlashCommandFilterText(skill.name);
                item.sortText = `${String(1000 - score).padStart(4, "0")}-${skill.name}`;
                item.detail = skill.description;
                items.push(item);
              }

              const scoredCommands = cmds
                .map((command) => ({
                  command,
                  score: getSlashCommandMatchScore(command.name, query),
                }))
                .filter(({ score }) => score > 0)
                .sort((left, right) => {
                  const scoreDiff = right.score - left.score;
                  return scoreDiff !== 0
                    ? scoreDiff
                    : left.command.name.localeCompare(right.command.name);
                });

              for (const { command, score } of scoredCommands) {
                const canonicalName = normalizeSlashCommandQuery(command.name);
                const shortName = getShortCommandName(canonicalName);
                const item = new vscode.CompletionItem(
                  formatSlashCommandLabel(command.name),
                  vscode.CompletionItemKind.Text,
                );
                item.insertText = `${agentPrefix}/${canonicalName} `;
                item.filterText = buildSlashCommandFilterText(command.name);
                item.sortText = `${String(1000 - score).padStart(4, "0")}-${canonicalName}`;
                item.detail = [
                  formatCommandSourceBadge(command.source),
                  shortName !== canonicalName
                    ? `Alias: /${shortName}`
                    : undefined,
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
                items.push(item);
              }
              return items;
            },
          },
          "/",
        ),
      );
      outputChannel.info(
        `[acp:${agent.id}] CompletionItemProvider registered for scheme "${scheme}"`,
      );
    }

    context.subscriptions.push(participantInstance);
    context.subscriptions.push(
      vscode.chat.registerChatSessionContentProvider(
        `${ACP_CHAT_SCHEME}-${agent.id}`,
        sessionContentProvider,
        participantInstance,
      ),
    );

    const sessionItemController = createAcpChatSessionItemController(
      `${ACP_CHAT_SCHEME}-${agent.id}`,
      agent.id,
      sessionManager,
      params.sessionDb,
      outputChannel,
    );
    context.subscriptions.push(sessionItemController);

    managers.set(agent.id, sessionManager);
  });

  return managers;
}

export function deactivate(): void {}
