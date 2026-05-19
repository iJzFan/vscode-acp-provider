import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { parseAuggieCommandHelpOutput } from "./auggieCommandParser";
import {
  AcpAgentConfigurationEntry,
  ManualCommandConfigurationEntry,
} from "./types";

export async function collectAuggieManualCommands(
  agent: AcpAgentConfigurationEntry | undefined,
  outputChannel: vscode.LogOutputChannel,
): Promise<ManualCommandConfigurationEntry[]> {
  const executable = agent?.command?.trim() || "auggie";
  const cwd = agent?.cwd?.trim() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const env = {
    ...process.env,
    ...(agent?.env ?? {}),
  };

  outputChannel.info(
    `[acp:auggie] Importing manual commands using: ${executable} command help`,
  );

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ["command", "help"], {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out while running `auggie command help`."));
    }, 30000);

    child.stdout.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      errorOutput += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            errorOutput.trim() || `\`auggie command help\` exited with code ${code}.`,
          ),
        );
        return;
      }
      resolve(output);
    });
  });

  const commands = parseAuggieCommandHelpOutput(stdout);
  if (!commands.length) {
    throw new Error(
      "No importable commands were found in `auggie command help` output.",
    );
  }

  outputChannel.info(
    `[acp:auggie] Parsed ${commands.length} manual commands from Auggie help output.`,
  );
  return commands;
}
