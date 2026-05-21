// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";

let vscodeApi: typeof vscode = vscode;

export function setPermittedPathsVscodeForTesting(
  value: typeof vscode | undefined,
): void {
  vscodeApi = value ?? vscode;
}

export function getWorkspaceCwd(): string {
  const folders = vscodeApi.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return vscodeApi.env.appRoot;
  }
  return folders[0].uri.fsPath;
}
