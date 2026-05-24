// SPDX-License-Identifier: Apache-2.0
import { AvailableCommand, RequestError } from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

export interface ImportedConfigSource {
  readonly kind: "workspace" | "userProfile" | "plugin";
  readonly label: string;
  readonly path?: string;
}

interface ImportedMcpServerMetadata {
  readonly source?: ImportedConfigSource;
  readonly warnings?: readonly string[];
}

export interface AcpStdioMcpServerConfiguration extends ImportedMcpServerMetadata {
  readonly type: "stdio";
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
}

export interface AcpHttpMcpServerConfiguration extends ImportedMcpServerMetadata {
  readonly type: "http";
  readonly name: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
}

export type AcpMcpServerConfiguration =
  | AcpStdioMcpServerConfiguration
  | AcpHttpMcpServerConfiguration;

export interface ScannedSkill {
  readonly name: string;
  readonly description: string;
  readonly directory: string;
}

export interface ManualCommandConfigurationEntry {
  readonly name: string;
  readonly description: string;
  readonly input?: {
    readonly hint: string;
  };
}

export type SurfacedCommandSource = "acp" | "manual";

export interface SurfacedCommand extends AvailableCommand {
  readonly source: SurfacedCommandSource;
}

export interface AcpAgentConfigurationEntry {
  readonly label?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly enabled?: boolean;
  readonly mcpServers?: readonly AcpMcpServerConfiguration[];
  readonly manualCommands?: readonly ManualCommandConfigurationEntry[];
  readonly skillPaths?: readonly string[];
  readonly defaultMode?: string;
  readonly defaultModel?: string;
  readonly defaultThinkingEffort?: DefaultThinkingEffort;
}

export const ThinkingEffortModes = [
  "think",
  "megathink",
  "ultrathink",
] as const;
export const DefaultThinkingEffortValues = [
  "off",
  "think",
  "megathink",
  "ultrathink",
] as const;

export type ThinkConfig = (typeof ThinkingEffortModes)[number];
export type DefaultThinkingEffort =
  (typeof DefaultThinkingEffortValues)[number];

export interface ThinkState {
  enabled: boolean;
  config?: ThinkConfig;
}

export const VscodeToolNames = {
  VscodeGetConfirmation: "vscode_get_confirmation",
  VscodeGetConfirmationWithOptions: "vscode_get_confirmation_with_options",
  TodoList: "manage_todo_list",
};

export const VscodeSessionOptions = {
  Mode: "mode",
  Model: "model",
  Agent: "agent",
  Think: "think",
};

export const currentWorkspaceRoot = () =>
  vscode.workspace.workspaceFolders?.[0]?.uri;

export class ResolvableCallback {
  private r: ((value: unknown) => void) | undefined;

  callback(): Thenable<unknown> {
    return new Promise((r) => {
      this.r = r;
    });
  }

  resolve() {
    if (this.r) {
      this.r(undefined);
    }
  }
}

export const extractReadableErrorMessage = (error: unknown): string => {
  if (typeof error === "string") {
    return error;
  } else if (typeof error === "object") {
    if (error instanceof Error) {
      return error.message;
    } else if (error instanceof RequestError) {
      return extractReadableErrorMessage(error.cause);
    }
  }
  return JSON.stringify(error);
};
