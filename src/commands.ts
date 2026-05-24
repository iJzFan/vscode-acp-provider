import * as vscode from "vscode";
import { SessionDb } from "./acpSessionDb";
import { collectAuggieManualCommands } from "./manualCommandImport";
import { getWorkspaceCwd } from "./permittedPaths";
import {
  AcpAgentConfigurationEntry,
  ManualCommandConfigurationEntry,
} from "./types";

export function registerCommands(
  context: vscode.ExtensionContext,
  dependencies: {
    sessionDb: SessionDb;
  },
  outputChannel: vscode.LogOutputChannel,
) {
  const openChatWithPartialQuery = async (text: string) => {
    await vscode.commands.executeCommand("workbench.action.chat.open", {
      query: text,
      isPartialQuery: true,
    });
  };

  const importAuggieManualCommands = async () => {
    const config = vscode.workspace.getConfiguration("acpClient");
    const agents =
      config.get<Record<string, AcpAgentConfigurationEntry>>("agents") ?? {};
    const currentAuggie = agents.auggie;

    const importedCommands = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Importing Auggie manual commands",
      },
      async () => collectAuggieManualCommands(currentAuggie, outputChannel),
    );

    const mergedManualCommands = new Map<
      string,
      ManualCommandConfigurationEntry
    >(
      (currentAuggie?.manualCommands ?? []).map((command) => [
        command.name,
        command,
      ]),
    );
    for (const command of importedCommands) {
      mergedManualCommands.set(command.name, command);
    }

    const updatedAgents: Record<string, AcpAgentConfigurationEntry> = {
      ...agents,
      auggie: {
        ...(currentAuggie ?? {
          label: "Auggie",
          command: "auggie",
          args: ["--acp"],
          enabled: true,
        }),
        manualCommands: Array.from(mergedManualCommands.values()).sort(
          (left, right) => left.name.localeCompare(right.name),
        ),
      },
    };

    await config.update(
      "agents",
      updatedAgents,
      vscode.ConfigurationTarget.Global,
    );
    outputChannel.info(
      `[acp:auggie] Imported ${importedCommands.length} manual commands into user settings.`,
    );
    void vscode.window.showInformationMessage(
      `Imported ${importedCommands.length} Auggie commands into acpClient.agents.auggie.manualCommands.`,
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("acp.clearSessions", async () => {
      try {
        await dependencies.sessionDb.deleteAllSessions(getWorkspaceCwd());
        vscode.window.showInformationMessage(
          "All ACP sessions have been cleared.",
        );
      } catch (error) {
        outputChannel.error(`Error clearing sessions: ${error}`);
        vscode.window.showErrorMessage(
          "Failed to clear ACP sessions. Check output for details.",
        );
      }
    }),

    vscode.commands.registerCommand(
      "acp.insertChatText",
      async (text: string) => {
        await openChatWithPartialQuery(text);
      },
    ),

    vscode.commands.registerCommand(
      "acp.requestPlanChanges",
      async (planSummary?: string) => {
        const input = await vscode.window.showInputBox({
          title: "Request ACP Plan Changes",
          prompt:
            "Describe how the ACP agent should revise the current plan before continuing.",
          ignoreFocusOut: true,
        });
        if (!input?.trim()) {
          return;
        }

        const summaryPrefix = planSummary?.trim()
          ? `Current plan summary: ${planSummary.trim()}\n\n`
          : "";
        await openChatWithPartialQuery(
          `${summaryPrefix}Please revise the current plan with these changes:\n${input.trim()}`,
        );
      },
    ),

    vscode.commands.registerCommand(
      "acp.importAuggieManualCommands",
      async () => {
        try {
          await importAuggieManualCommands();
        } catch (error) {
          outputChannel.error(`Failed to import Auggie commands: ${error}`);
          void vscode.window.showErrorMessage(
            `Failed to import Auggie commands. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),
  );
}
