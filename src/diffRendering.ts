// SPDX-License-Identifier: Apache-2.0
import { ToolCallUpdate } from "@agentclientprotocol/sdk";
import * as path from "path";
import * as vscode from "vscode";
import { buildDiffStats, resolveUri } from "./chatRenderingUtils";
import { createDiffUri, setDiffContent } from "./diffContentProvider";

type DiffToolUpdate = Pick<ToolCallUpdate, "toolCallId" | "content">;
type DiffMetadataToolUpdate = Pick<ToolCallUpdate, "toolCallId" | "rawOutput">;

type ToolMetadataFileEntry = {
  filePath?: unknown;
  relativePath?: unknown;
  before?: unknown;
  after?: unknown;
};

export type ToolDiffSnapshot = {
  fileUri: vscode.Uri;
  hasOriginal: boolean;
  oldText: string;
  hasModified: boolean;
  newText: string;
};

export type CreateToolDiffPartOptions = {
  readOnly?: boolean;
  includeGoToFileUri?: boolean;
};

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

export function createToolDiffArtifactsFromSnapshots(
  toolCallId: string,
  snapshots: readonly ToolDiffSnapshot[],
): ToolDiffArtifact[] {
  const artifactsByKey = new Map<string, ToolDiffArtifact>();
  let diffIndex = 0;

  for (const snapshot of snapshots) {
    if (!snapshot.hasOriginal && !snapshot.hasModified) {
      continue;
    }

    const originalUri = snapshot.hasOriginal
      ? createDiffUri({
          side: "original",
          toolCallId,
          fileUri: snapshot.fileUri,
          index: diffIndex,
        })
      : undefined;
    const modifiedUri = snapshot.hasModified
      ? createDiffUri({
          side: "modified",
          toolCallId,
          fileUri: snapshot.fileUri,
          index: diffIndex,
        })
      : undefined;

    if (originalUri) {
      setDiffContent(originalUri, snapshot.oldText);
    }
    if (modifiedUri) {
      setDiffContent(modifiedUri, snapshot.newText);
    }

    const artifact: ToolDiffArtifact = {
      fileUri: snapshot.fileUri,
      originalUri,
      modifiedUri,
      ...buildDiffStats(
        snapshot.hasOriginal ? snapshot.oldText : undefined,
        snapshot.hasModified ? snapshot.newText : undefined,
      ),
      hasOriginal: snapshot.hasOriginal,
      hasModified: snapshot.hasModified,
      isDeletion: snapshot.hasOriginal && !snapshot.hasModified,
      oldText: snapshot.oldText,
      newText: snapshot.newText,
    };

    const key = getToolDiffArtifactKey(snapshot.fileUri);
    const existing = artifactsByKey.get(key);
    artifactsByKey.set(
      key,
      existing ? mergeToolDiffArtifacts(existing, artifact) : artifact,
    );
    diffIndex++;
  }

  return Array.from(artifactsByKey.values());
}

export function collectToolMetadataDiffArtifacts(
  update: DiffMetadataToolUpdate,
  workspaceRoot: vscode.Uri | undefined,
): ToolDiffArtifact[] {
  if (!update.rawOutput || typeof update.rawOutput !== "object") {
    return [];
  }

  const metadata = "metadata" in update.rawOutput &&
      update.rawOutput.metadata &&
      typeof update.rawOutput.metadata === "object"
    ? update.rawOutput.metadata
    : undefined;
  const files = metadata &&
      "files" in metadata &&
      Array.isArray(metadata.files)
    ? metadata.files
    : undefined;
  if (!files?.length) {
    return [];
  }

  const snapshots: ToolDiffSnapshot[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") {
      continue;
    }

    const entry = file as ToolMetadataFileEntry;
    const rawPath = typeof entry.filePath === "string"
      ? entry.filePath
      : typeof entry.relativePath === "string"
        ? entry.relativePath
        : undefined;
    if (!rawPath) {
      continue;
    }

    const before = typeof entry.before === "string" ? entry.before : undefined;
    const after = typeof entry.after === "string" ? entry.after : undefined;
    snapshots.push({
      fileUri: resolveUri(rawPath, workspaceRoot),
      hasOriginal: before !== undefined,
      oldText: before ?? "",
      hasModified: after !== undefined,
      newText: after ?? "",
    });
  }

  return createToolDiffArtifactsFromSnapshots(update.toolCallId, snapshots);
}

export function createToolDiffPart(
  artifacts: readonly ToolDiffArtifact[],
  options: CreateToolDiffPartOptions = {},
): vscode.ChatResponseMultiDiffPart | undefined {
  if (!artifacts.length) {
    return undefined;
  }

  const { readOnly = false, includeGoToFileUri = true } = options;

  return new vscode.ChatResponseMultiDiffPart(
    artifacts.map((artifact) => ({
      originalUri: artifact.originalUri,
      modifiedUri: artifact.modifiedUri,
      goToFileUri: includeGoToFileUri ? artifact.fileUri : undefined,
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
  options: CreateToolDiffPartOptions = {},
): void {
  const diffPart = createToolDiffPart(artifacts, options);
  if (diffPart) {
    stream.push(diffPart);
  }
}

export function buildToolDiffJumpCommands(
  artifacts: readonly ToolDiffArtifact[],
): vscode.Command[] {
  return artifacts
    .filter((artifact) => artifact.hasModified && !artifact.isDeletion)
    .map((artifact) => ({
      title: `Jump to ${toDisplayPath(artifact.fileUri)}`,
      command: "vscode.open",
      arguments: [artifact.fileUri],
    }));
}

function toDisplayPath(fileUri: vscode.Uri): string {
  if (fileUri.scheme === "file") {
    return vscode.workspace.asRelativePath(fileUri, false).replace(/\\/g, "/");
  }

  return fileUri.path || fileUri.toString();
}