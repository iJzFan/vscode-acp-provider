// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { AcpSessionManager } from "./acpSessionManager";
import { DisposableBase } from "./disposables";
import { SessionDb } from "./acpSessionDb";

let vscodeApi: typeof vscode = vscode;

export function setChatSessionItemControllerVscodeForTesting(
  value: typeof vscode | undefined,
): void {
  vscodeApi = value ?? vscode;
}

export function createAcpChatSessionItemController(
  chatSessionType: string,
  agentId: string,
  sessionManager: AcpSessionManager,
  sessionDb: SessionDb,
  logger: vscode.LogOutputChannel,
): vscode.Disposable {
  return new LifecycledChatSessionItemController(
    chatSessionType,
    agentId,
    sessionManager,
    sessionDb,
    logger,
  );
}

class LifecycledChatSessionItemController extends DisposableBase {
  private readonly controller: vscode.ChatSessionItemController;
  private readonly inProgressItems = new Map<string, vscode.ChatSessionItem>();
  private readonly pendingItemsWithoutResource: vscode.ChatSessionItem[] = [];

  constructor(
    chatSessionType: string,
    private readonly agentId: string,
    private readonly sessionManager: AcpSessionManager,
    private readonly sessionDb: SessionDb,
    private readonly logger: vscode.LogOutputChannel,
  ) {
    super();

    this.controller = this._register(
      vscodeApi.chat.createChatSessionItemController(chatSessionType, (token) =>
        this.refresh(token),
      ),
    );

    this.controller.newChatSessionItemHandler = async (context, _token) => {
      const sessionResource = context.request.sessionResource;
      if (sessionResource) {
        try {
          const { session } = await this.sessionManager.createOrGet(sessionResource);
          const uri = this.sessionManager.createSessionUri(session);
          const item = this.controller.createChatSessionItem(
            uri,
            session.acpSessionId,
          );
          item.status = vscodeApi.ChatSessionStatus.InProgress;
          item.timing = { created: Date.now(), lastRequestStarted: Date.now() };
          this.inProgressItems.set(session.acpSessionId, item);
          this.logger.debug(
            `newChatSessionItemHandler: created item for session ${session.acpSessionId}`,
          );
          return item;
        } catch (error) {
          this.logger.error(
            `newChatSessionItemHandler: failed to initialize session for resource ${sessionResource.toString()}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Fallback: return a placeholder using the untitled resource.
      // Track it by resource URI so onDidChangeSession can update it once the
      // agent assigns a real session ID.
      const fallbackResource =
        sessionResource ??
        vscodeApi.Uri.parse(
          `acp-${this.agentId}:/untitled-pending-${encodeURIComponent(context.request.id)}`,
        );
      const item = this.controller.createChatSessionItem(
        fallbackResource,
        context.request.prompt,
      );
      item.status = vscodeApi.ChatSessionStatus.InProgress;
      item.timing = { created: Date.now(), lastRequestStarted: Date.now() };
      if (sessionResource) {
        this.inProgressItems.set(sessionResource.toString(), item);
        this.logger.debug(
          `newChatSessionItemHandler: created fallback item for resource ${sessionResource}`,
        );
      } else {
        this.pendingItemsWithoutResource.push(item);
        this.logger.debug(
          `newChatSessionItemHandler: created fallback item without session resource for request ${context.request.id}`,
        );
      }
      return item;
    };

    this._register(
      this.sessionManager.onDidChangeSession(({ modified }) => {
        let key = modified.acpSessionId;
        let inProgressItem = this.inProgressItems.get(key);
        if (!inProgressItem) {
          const resourceKey = modified.vscodeResource.toString();
          const fallbackItem = this.inProgressItems.get(resourceKey);
          if (fallbackItem) {
            this.inProgressItems.delete(resourceKey);
            this.inProgressItems.set(modified.acpSessionId, fallbackItem);
            key = modified.acpSessionId;
            inProgressItem = fallbackItem;
          }
        }
        if (!inProgressItem && this.pendingItemsWithoutResource.length > 0) {
          inProgressItem = this.pendingItemsWithoutResource.shift();
          if (inProgressItem) {
            this.inProgressItems.set(modified.acpSessionId, inProgressItem);
            key = modified.acpSessionId;
            this.logger.debug(
              `Bound pending resource-less item to session ${modified.acpSessionId}`,
            );
          }
        }
        if (inProgressItem) {
          // Mutate in-place — VS Code fires onDidChangeChatSessionItemState automatically
          inProgressItem.label = modified.title;
          inProgressItem.status = modified.status;
          inProgressItem.changes = this.sessionManager.getSessionChangedFiles(
            modified.acpSessionId,
          );
          const existing = inProgressItem.timing;
          if (modified.status === vscodeApi.ChatSessionStatus.InProgress) {
            inProgressItem.timing = {
              ...(existing ?? { created: Date.now() }),
              lastRequestStarted: Date.now(),
              lastRequestEnded: undefined,
            };
          } else {
            inProgressItem.timing = {
              ...(existing ?? { created: Date.now() }),
              lastRequestEnded: Date.now(),
            };
          }

          if (
            modified.status !== vscodeApi.ChatSessionStatus.InProgress &&
            modified.status !== vscodeApi.ChatSessionStatus.NeedsInput
          ) {
            this.inProgressItems.delete(key);
            this.sessionDb
              .upsertSession(modified.agent.id, {
                sessionId: modified.acpSessionId,
                cwd: modified.cwd,
                title: modified.title,
                updatedAt: modified.updatedAt,
              })
              .then(() => {
                const cts = new vscodeApi.CancellationTokenSource();
                return this.refresh(cts.token).finally(() => cts.dispose());
              })
              .catch((err) =>
                this.logger.error(
                  `Failed to persist session ${modified.acpSessionId}: ${err}`,
                ),
              );
            this.logger.debug(
              `session ${modified.acpSessionId} completed with status ${modified.status}`,
            );
          }
        }
      }),
    );
  }

  private async refresh(token: vscode.CancellationToken): Promise<void> {
    const diskItems = await this.sessionManager.list();
    const items = diskItems.map((i) => {
      const item = this.controller.createChatSessionItem(i.resource, i.label);
      item.status = i.status;
      item.changes = i.changes;
      if (i.timing) {
        item.timing = i.timing;
      }
      return item;
    });
    const merged = [...items, ...this.inProgressItems.values()];
    this.controller.items.replace(merged);
  }
}
