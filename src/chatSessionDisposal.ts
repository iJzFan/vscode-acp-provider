import * as vscode from "vscode";
import type { AcpSessionManager } from "./acpSessionManager";
import {
  ACP_CHAT_SCHEME,
  getAgentIdFromResource,
} from "./chatIdentifiers";

type Logger = Pick<vscode.LogOutputChannel, "warn">;

export function registerChatSessionDisposalCleanup(
  managers: ReadonlyMap<string, AcpSessionManager>,
  logger: Logger,
  vscodeApi: Pick<typeof vscode, "Uri" | "chat"> = vscode,
): vscode.Disposable | undefined {
  const onDidDisposeChatSession = vscodeApi.chat?.onDidDisposeChatSession;
  if (typeof onDidDisposeChatSession !== "function") {
    return undefined;
  }

  return onDidDisposeChatSession((disposedSession) => {
    const qualifiedResource = tryParseQualifiedResource(
      disposedSession,
      managers,
      vscodeApi,
    );
    if (qualifiedResource) {
      const agentId = getAgentIdFromResource(qualifiedResource);
      if (!agentId) {
        return;
      }
      const manager = managers.get(agentId);
      if (manager && hasExactActiveResource(manager, qualifiedResource)) {
        manager.closeSession(qualifiedResource);
      }
      return;
    }

    const matches = Array.from(managers.entries()).filter(([agentId, manager]) =>
      hasExactActiveResource(
        manager,
        createLegacySessionResource(agentId, disposedSession, vscodeApi),
      ),
    );
    if (matches.length !== 1) {
      if (matches.length > 1) {
        logger.warn(
          `Skipping ambiguous chat session disposal for legacy id ${disposedSession}; matched ${matches.length} ACP sessions.`,
        );
      }
      return;
    }

    const [agentId, manager] = matches[0];
    manager.closeSession(
      createLegacySessionResource(agentId, disposedSession, vscodeApi),
    );
  });
}

function tryParseQualifiedResource(
  disposedSession: string,
  managers: ReadonlyMap<string, AcpSessionManager>,
  vscodeApi: Pick<typeof vscode, "Uri">,
): vscode.Uri | undefined {
  if (!disposedSession.includes(":")) {
    return undefined;
  }

  const resource = vscodeApi.Uri.parse(disposedSession);
  const agentId = getAgentIdFromResource(resource);
  if (!agentId || !managers.has(agentId)) {
    return undefined;
  }

  return resource;
}

function createLegacySessionResource(
  agentId: string,
  disposedSession: string,
  vscodeApi: Pick<typeof vscode, "Uri">,
): vscode.Uri {
  return vscodeApi.Uri.parse(`${ACP_CHAT_SCHEME}-${agentId}:/${disposedSession}`);
}

function hasExactActiveResource(
  manager: AcpSessionManager,
  resource: vscode.Uri,
): boolean {
  const active = manager.getActive(resource);
  return active?.vscodeResource.toString() === resource.toString();
}