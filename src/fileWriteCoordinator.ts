// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";

const writeQueues = new Map<string, Promise<void>>();
let vscodeApi: typeof vscode = vscode;

export function setWriteCoordinatorVscodeForTesting(
  value: typeof vscode | undefined,
): void {
  vscodeApi = value ?? vscode;
}

export async function writeTextFileWithCoordinator(
  uri: vscode.Uri,
  content: string,
  options?: {
    logChannel?: Pick<vscode.LogOutputChannel, "warn" | "info">;
    logPrefix?: string;
  },
): Promise<void> {
  return enqueueUriWrite(uri, async () => {
    const openDoc = findOpenDocument(uri);
    if (!openDoc) {
      const bytes = new TextEncoder().encode(content);
      await vscodeApi.workspace.fs.writeFile(uri, bytes);
      return;
    }

    if (openDoc.isDirty) {
      options?.logChannel?.warn(
        `${options.logPrefix ?? "[acp]"} Overwriting unsaved editor changes for ${uri.toString()} via ACP write coordinator.`,
      );
    }

    const edit = new vscodeApi.WorkspaceEdit();
    edit.replace(uri, getFullDocumentRange(openDoc), content);
    const applied = await vscodeApi.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error(`Failed to apply ACP workspace edit for ${uri.toString()}`);
    }

    const saved = await openDoc.save();
    if (!saved) {
      throw new Error(`Failed to save ACP-managed document ${uri.toString()}`);
    }
  });
}

function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscodeApi.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString(),
  );
}

function getFullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscodeApi.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length),
  );
}

async function enqueueUriWrite(
  uri: vscode.Uri,
  writeFn: () => Promise<void>,
): Promise<void> {
  const key = uri.toString();
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(writeFn);

  let tracked: Promise<void>;
  tracked = run.finally(() => {
    if (writeQueues.get(key) === tracked) {
      writeQueues.delete(key);
    }
  });

  writeQueues.set(key, tracked);
  return run;
}
