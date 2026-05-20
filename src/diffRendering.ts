// SPDX-License-Identifier: Apache-2.0
import { ToolCallUpdate } from "@agentclientprotocol/sdk";
import * as path from "path";
import * as vscode from "vscode";
import { buildDiffStats, resolveUri } from "./chatRenderingUtils";
import { createDiffUri, setDiffContent } from "./diffContentProvider";

type DiffToolUpdate = Pick<ToolCallUpdate, "toolCallId" | "content">;

export type ToolDiffArtifact = {
  fileUri: vscode.Uri;
  originalUri?: vscode.Uri;
  modifiedUri?: vscode.Uri;
  added: number;
  removed: number;
  hasOriginal: boolean;
  hasModified: boolean;
  isDeletion: boolean;
  oldText: string;
  newText: string;
};

export function getToolDiffArtifactKey(fileUri: vscode.Uri): string {
  if (fileUri.scheme === "file") {
    const normalizedPath = path.normalize(fileUri.fsPath || fileUri.path);
    const canonicalPath = process.platform === "win32"
      ? normalizedPath.toLowerCase()
      : normalizedPath;
    return `file:${canonicalPath}`;
  }

  return `${fileUri.scheme}:${fileUri.path}`;
}

export function mergeToolDiffArtifacts(
  existing: ToolDiffArtifact,
  incoming: ToolDiffArtifact,
): ToolDiffArtifact {
  const preservedOriginalUri = existing.hasOriginal
    ? existing.originalUri
    : undefined;
  const preservedOldText = existing.oldText;
  const preservedHasOriginal = existing.hasOriginal;

  return {
    fileUri: incoming.fileUri,
    originalUri: preservedOriginalUri,
    modifiedUri: incoming.hasModified ? incoming.modifiedUri : undefined,
    ...buildDiffStats(
      preservedHasOriginal ? preservedOldText : undefined,
      incoming.hasModified ? incoming.newText : undefined,
    ),
    hasOriginal: preservedHasOriginal,
    hasModified: incoming.hasModified,
    isDeletion: preservedHasOriginal && !incoming.hasModified,
    oldText: preservedOldText,
    newText: incoming.newText,
  };
}

export function collectToolDiffArtifacts(
  update: DiffToolUpdate,
  workspaceRoot: vscode.Uri | undefined,
): ToolDiffArtifact[] {
  if (!update.content?.length) {
    return [];
  }

  const artifactsByKey = new Map<string, ToolDiffArtifact>();
  let diffIndex = 0;
  for (const content of update.content) {
    if (content.type !== "diff") {
      continue;
    }

    const oldText = content.oldText ?? "";
    const newText = content.newText ?? "";
    const hasOriginal = content.oldText !== undefined;
    const hasModified = content.newText !== undefined;
    const isDeletion =
      hasOriginal &&
      (content.newText === "" || content.newText === undefined);
    const fileUri = resolveUri(content.path, workspaceRoot);
    const originalUri = hasOriginal
      ? createDiffUri({
          side: "original",
          toolCallId: update.toolCallId,
          fileUri,
          index: diffIndex,
        })
      : undefined;
    const modifiedUri = hasModified
      ? createDiffUri({
          side: "modified",
          toolCallId: update.toolCallId,
          fileUri,
          index: diffIndex,
        })
      : undefined;

    if (originalUri) {
      setDiffContent(originalUri, oldText);
    }
    if (modifiedUri) {
      setDiffContent(modifiedUri, newText);
    }

    const artifact: ToolDiffArtifact = {
      fileUri,
      originalUri,
      modifiedUri,
      ...buildDiffStats(content.oldText ?? undefined, content.newText ?? undefined),
      hasOriginal,
      hasModified,
      isDeletion,
      oldText,
      newText,
    };

    const key = getToolDiffArtifactKey(fileUri);
    const existing = artifactsByKey.get(key);
    artifactsByKey.set(
      key,
      existing ? mergeToolDiffArtifacts(existing, artifact) : artifact,
    );
    diffIndex++;
  }

  return Array.from(artifactsByKey.values());
}

export function createToolDiffPart(
  artifacts: readonly ToolDiffArtifact[],
  readOnly = false,
): vscode.ChatResponseMultiDiffPart | undefined {
  if (!artifacts.length) {
    return undefined;
  }

  return new vscode.ChatResponseMultiDiffPart(
    artifacts.map((artifact) => ({
      originalUri: artifact.originalUri,
      modifiedUri: artifact.modifiedUri,
      goToFileUri: artifact.fileUri,
      added: artifact.added,
      removed: artifact.removed,
    })),
    vscode.l10n.t("File edits"),
    readOnly,
  );
}

export function pushToolDiffPart(
  stream: Pick<vscode.ChatResponseStream, "push">,
  artifacts: readonly ToolDiffArtifact[],
  readOnly = false,
): void {
  const diffPart = createToolDiffPart(artifacts, readOnly);
  if (diffPart) {
    stream.push(diffPart);
  }
}