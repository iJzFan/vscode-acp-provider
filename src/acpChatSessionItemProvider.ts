// SPDX-License-Identifier: Apache-2.0
import vscode from "vscode";
import { ChatSessionStatus } from "vscode";
import { AcpSessionManager } from "./acpSessionManager";
import { SessionDb } from "./acpSessionDb";
import { DisposableBase } from "./disposables";

export function createAcpChatSessionItemProvider(
  sessionManager: AcpSessionManager,
  sessionDb: SessionDb,
  logger: vscode.LogOutputChannel,
): vscode.ChatSessionItemProvider & vscode.Disposable {
  return new AcpChatSessionItemProvider(sessionManager, sessionDb, logger);
}

class AcpChatSessionItemProvider
  extends DisposableBase
  implements vscode.ChatSessionItemProvider
{
  constructor(
    private readonly sessionManager: AcpSessionManager,
    private readonly sessionDb: SessionDb,
    private readonly logger: vscode.LogOutputChannel,
  ) {
    super();
    this._register(
      this.sessionManager.onDidChangeSession(({ original, modified }) => {
        const originalItem: vscode.ChatSessionItem = {
          resource: original.vscodeResource,
          label: original.acpSessionId,
        };

        const modifiedItem: vscode.ChatSessionItem = {
          resource: modified.vscodeResource,
          label: modified.acpSessionId,
          changes: this.sessionManager.getSessionChangedFiles(
            modified.acpSessionId,
          ),
        };

        if (
          originalItem.resource.toString() !== modifiedItem.resource.toString()
        ) {
          this._onDidCommitChatSessionItem.fire({
            original: originalItem,
            modified: modifiedItem,
          });
        }

        if (modified.status === ChatSessionStatus.InProgress) {
          return;
        }

        this.sessionDb
          .upsertSession(original.agent.id, {
            sessionId: modified.acpSessionId,
            cwd: modified.cwd,
            title: modified.title,
            updatedAt: modified.updatedAt,
          })
          .then(() => this._onDidChangeChatSessionItems.fire());

        this.logger.debug(
          `fired commit for session item change: ${original.acpSessionId} -> ${modified.acpSessionId}`,
        );
      }),
    );
  }

  private readonly _onDidChangeChatSessionItems =
    new vscode.EventEmitter<void>();
  readonly onDidChangeChatSessionItems =
    this._onDidChangeChatSessionItems.event;

  private readonly _onDidCommitChatSessionItem = new vscode.EventEmitter<{
    original: vscode.ChatSessionItem;
    modified: vscode.ChatSessionItem;
  }>();
  readonly onDidCommitChatSessionItem = this._onDidCommitChatSessionItem.event;

  provideChatSessionItems(
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.ChatSessionItem[]> {
    return this.sessionManager.list();
  }

  override dispose(): void {
    this._onDidChangeChatSessionItems.dispose();
    this._onDidCommitChatSessionItem.dispose();
    super.dispose();
  }
}
