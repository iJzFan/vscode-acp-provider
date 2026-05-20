// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";

type RegisteredExternalEdit = {
  toolCallId: string;
  resolve: () => void;
};

const externalEditsByUri = new Map<string, Set<RegisteredExternalEdit>>();

export function registerExternalEdit(
  toolCallId: string,
  uri: vscode.Uri,
  resolve: () => void,
): () => void {
  const key = uri.toString();
  const entry: RegisteredExternalEdit = { toolCallId, resolve };
  let registrations = externalEditsByUri.get(key);
  if (!registrations) {
    registrations = new Set<RegisteredExternalEdit>();
    externalEditsByUri.set(key, registrations);
  }
  registrations.add(entry);

  return () => {
    const current = externalEditsByUri.get(key);
    if (!current) {
      return;
    }
    current.delete(entry);
    if (current.size === 0) {
      externalEditsByUri.delete(key);
    }
  };
}

export function resolveExternalEditsForUri(uri: vscode.Uri): number {
  const key = uri.toString();
  const registrations = externalEditsByUri.get(key);
  if (!registrations?.size) {
    return 0;
  }

  externalEditsByUri.delete(key);
  for (const registration of registrations) {
    registration.resolve();
  }
  return registrations.size;
}

export function clearExternalEditsForTesting(): void {
  externalEditsByUri.clear();
}
