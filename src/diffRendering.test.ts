import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { setup, suite, teardown, test } from "mocha";
import { ToolDiffArtifact } from "./diffRendering";

type DiffRenderingModule = typeof import("./diffRendering");

const moduleWithLoad = Module as typeof Module & {
  _load: (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => unknown;
  _resolveFilename: (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
    options: unknown,
  ) => string;
};
const originalLoad = moduleWithLoad._load;
const originalResolve = moduleWithLoad._resolveFilename;
const MOCK_VSCODE_MODULE_ID = "__mock_vscode__";

let diffRendering: DiffRenderingModule;

class MockUri {
  constructor(
    readonly scheme: string,
    readonly fsPath: string,
    readonly query = "",
  ) {}

  get path(): string {
    return this.fsPath.replace(/\\/g, "/");
  }

  with(changes: { scheme?: string; query?: string }): MockUri {
    return new MockUri(
      changes.scheme ?? this.scheme,
      this.fsPath,
      changes.query ?? this.query,
    );
  }

  toString(): string {
    return `${this.scheme}:${this.fsPath}${this.query ? `?${this.query}` : ""}`;
  }

  static file(fsPath: string): MockUri {
    return new MockUri("file", path.resolve(fsPath));
  }

  static parse(value: string): MockUri {
    const match = value.match(/^([a-z0-9+.-]+):(.*)$/i);
    if (!match) {
      return MockUri.file(value);
    }
    const [, scheme, rest] = match;
    return new MockUri(scheme, rest.replace(/^\/\//, ""));
  }

  static joinPath(base: MockUri, ...segments: string[]): MockUri {
    return new MockUri(base.scheme, path.join(base.fsPath, ...segments));
  }
}

class MockChatResponseMultiDiffPart {
  constructor(
    readonly value: unknown[],
    readonly title: string,
    readonly readOnly?: boolean,
  ) {}
}

function clearDiffRenderingModules(): void {
  for (const moduleId of [
    "./diffRendering",
    "./chatRenderingUtils",
    "./diffContentProvider",
    "./types",
    "./disposables",
  ]) {
    delete require.cache[require.resolve(moduleId)];
  }
}

setup(() => {
  moduleWithLoad._load = (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => {
    if (request === "vscode" || request === MOCK_VSCODE_MODULE_ID) {
      const workspaceRoot = MockUri.file(path.join("C:", "workspace"));
      return {
        Uri: MockUri,
        ChatResponseMultiDiffPart: MockChatResponseMultiDiffPart,
        l10n: { t: (value: string) => value },
        workspace: {
          workspaceFolders: [{ uri: workspaceRoot }],
          asRelativePath: (uri: MockUri) =>
            path.relative(workspaceRoot.fsPath, uri.fsPath) || uri.fsPath,
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  moduleWithLoad._resolveFilename = (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
    options: unknown,
  ) => {
    if (request === "vscode") {
      return MOCK_VSCODE_MODULE_ID;
    }
    return originalResolve(request, parent, isMain, options);
  };

  clearDiffRenderingModules();
  diffRendering = require("./diffRendering") as DiffRenderingModule;
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
  moduleWithLoad._resolveFilename = originalResolve;
  clearDiffRenderingModules();
});

suite("diffRendering", () => {
  test("collects diff artifacts and pushes a File edits part", () => {
    const workspaceRoot = MockUri.file(path.join("C:", "workspace"));
    const artifacts = diffRendering.collectToolDiffArtifacts(
      {
        toolCallId: "tool-1",
        content: [
          {
            type: "diff",
            path: "src/example.ts",
            oldText: "const value = 1;\n",
            newText: "const value = 2;\n",
          },
        ],
      } as never,
      workspaceRoot as never,
    );

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].fileUri.fsPath, path.join(workspaceRoot.fsPath, "src", "example.ts"));
    assert.equal(artifacts[0].hasOriginal, true);
    assert.equal(artifacts[0].hasModified, true);

    const pushed: unknown[] = [];
    diffRendering.pushToolDiffPart(
      { push: (part: unknown) => pushed.push(part) },
      artifacts,
    );

    assert.equal(pushed.length, 1);
    const part = pushed[0] as MockChatResponseMultiDiffPart;
    assert.equal(part.title, "File edits");
    assert.equal(part.readOnly, false);
    assert.equal(part.value.length, 1);
  });

  test("ignores non-diff content and does not push when no diffs exist", () => {
    const artifacts = diffRendering.collectToolDiffArtifacts(
      {
        toolCallId: "tool-2",
        content: [
          {
            type: "content",
            content: { type: "text", text: "done" },
          },
        ],
      } as never,
      undefined,
    );

    assert.deepEqual(artifacts, []);

    const pushed: unknown[] = [];
    diffRendering.pushToolDiffPart(
      { push: (part: unknown) => pushed.push(part) },
      artifacts,
    );

    assert.equal(pushed.length, 0);
  });

  test("createToolDiffPart returns undefined for empty artifacts", () => {
    const part = diffRendering.createToolDiffPart([]);
    assert.equal(part, undefined);
  });

  test("createToolDiffPart can keep cumulative rows focused on diffs instead of file jumps", () => {
    const workspaceRoot = MockUri.file(path.join("C:", "workspace"));
    const artifacts = diffRendering.collectToolDiffArtifacts(
      {
        toolCallId: "tool-cumulative",
        content: [
          {
            type: "diff",
            path: "src/example.ts",
            oldText: "const before = 1;\n",
            newText: "const after = 2;\n",
          },
        ],
      } as never,
      workspaceRoot as never,
    );

    const part = diffRendering.createToolDiffPart(artifacts, {
      includeGoToFileUri: false,
    }) as MockChatResponseMultiDiffPart;

    assert.equal(part.value.length, 1);
    assert.equal((part.value[0] as { goToFileUri?: unknown }).goToFileUri, undefined);
  });

  test("mergeToolDiffArtifacts preserves the earliest original and latest final text", () => {
    const workspaceRoot = MockUri.file(path.join("C:", "workspace"));

    const firstArtifacts = diffRendering.collectToolDiffArtifacts(
      {
        toolCallId: "tool-1",
        content: [
          {
            type: "diff",
            path: "src/example.ts",
            oldText: "const value = 1;\n",
            newText: "const value = 2;\n",
          },
        ],
      } as never,
      workspaceRoot as never,
    );

    const secondArtifacts = diffRendering.collectToolDiffArtifacts(
      {
        toolCallId: "tool-2",
        content: [
          {
            type: "diff",
            path: "src/example.ts",
            oldText: "const value = 2;\n",
            newText: "const value = 3;\n",
          },
        ],
      } as never,
      workspaceRoot as never,
    );

    const merged = diffRendering.mergeToolDiffArtifacts(
      firstArtifacts[0],
      secondArtifacts[0],
    );

    assert.equal(merged.oldText, "const value = 1;\n");
    assert.equal(merged.newText, "const value = 3;\n");
    assert.equal(merged.hasOriginal, true);
    assert.equal(merged.hasModified, true);
    assert.equal(merged.originalUri?.toString(), firstArtifacts[0].originalUri?.toString());
    assert.equal(merged.modifiedUri?.toString(), secondArtifacts[0].modifiedUri?.toString());
  });

  test("multi-file sessions retain separate cumulative entries", () => {
    const workspaceRoot = MockUri.file(path.join("C:", "workspace"));
    const cumulativeMap = new Map<string, ToolDiffArtifact>();

    const artifactsA = diffRendering.collectToolDiffArtifacts(
      {
        toolCallId: "tool-1",
        content: [
          {
            type: "diff",
            path: "src/a.ts",
            oldText: "a1",
            newText: "a2",
          },
        ],
      } as never,
      workspaceRoot as never,
    );

    const artifactsB = diffRendering.collectToolDiffArtifacts(
      {
        toolCallId: "tool-2",
        content: [
          {
            type: "diff",
            path: "src/b.ts",
            oldText: "b1",
            newText: "b2",
          },
        ],
      } as never,
      workspaceRoot as never,
    );

    for (const artifact of artifactsA) {
      cumulativeMap.set(artifact.fileUri.toString(), artifact);
    }
    for (const artifact of artifactsB) {
      cumulativeMap.set(artifact.fileUri.toString(), artifact);
    }

    assert.equal(cumulativeMap.size, 2);
    const paths = Array.from(cumulativeMap.keys()).sort();
    assert.ok(paths[0].includes("a.ts"));
    assert.ok(paths[1].includes("b.ts"));
  });

  test("mergeToolDiffArtifacts keeps created files as creations across later edits", () => {
    const workspaceRoot = MockUri.file(path.join("C:", "workspace"));

    const createdArtifacts = diffRendering.collectToolDiffArtifacts(
      {
        toolCallId: "tool-1",
        content: [
          {
            type: "diff",
            path: "src/new.ts",
            newText: "export const created = true;\n",
          },
        ],
      } as never,
      workspaceRoot as never,
    );

    const updatedArtifacts = diffRendering.collectToolDiffArtifacts(
      {
        toolCallId: "tool-2",
        content: [
          {
            type: "diff",
            path: "src/new.ts",
            oldText: "export const created = true;\n",
            newText: "export const created = 'still new';\n",
          },
        ],
      } as never,
      workspaceRoot as never,
    );

    const merged = diffRendering.mergeToolDiffArtifacts(
      createdArtifacts[0],
      updatedArtifacts[0],
    );

    assert.equal(merged.hasOriginal, false);
    assert.equal(merged.oldText, "");
    assert.equal(merged.newText, "export const created = 'still new';\n");
  });

  test("collectToolDiffArtifacts coalesces repeated diffs for the same file in one update", () => {
    const workspaceRoot = MockUri.file(path.join("C:", "workspace"));

    const artifacts = diffRendering.collectToolDiffArtifacts(
      {
        toolCallId: "tool-3",
        content: [
          {
            type: "diff",
            path: "src/example.ts",
            oldText: "const value = 1;\n",
            newText: "const value = 2;\n",
          },
          {
            type: "diff",
            path: ".\\src\\example.ts",
            oldText: "const value = 2;\n",
            newText: "const value = 3;\n",
          },
        ],
      } as never,
      workspaceRoot as never,
    );

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].oldText, "const value = 1;\n");
    assert.equal(artifacts[0].newText, "const value = 3;\n");
    assert.equal(artifacts[0].hasOriginal, true);
    assert.equal(artifacts[0].hasModified, true);
  });

  test("collectToolMetadataDiffArtifacts builds artifacts from tool metadata file snapshots", () => {
    const workspaceRoot = MockUri.file(path.join("C:", "workspace"));

    const artifacts = diffRendering.collectToolMetadataDiffArtifacts(
      {
        toolCallId: "tool-meta",
        rawOutput: {
          metadata: {
            files: [
              {
                filePath: path.join(workspaceRoot.fsPath, "src", "meta.ts"),
                before: "export const before = true;\n",
                after: "export const after = true;\n",
              },
            ],
          },
        },
      } as never,
      workspaceRoot as never,
    );

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].oldText, "export const before = true;\n");
    assert.equal(artifacts[0].newText, "export const after = true;\n");
  });

  test("buildToolDiffJumpCommands creates open-file buttons for non-deleted files", () => {
    const workspaceRoot = MockUri.file(path.join("C:", "workspace"));
    const artifacts = diffRendering.collectToolDiffArtifacts(
      {
        toolCallId: "tool-buttons",
        content: [
          {
            type: "diff",
            path: "src/a.ts",
            oldText: "a1\n",
            newText: "a2\n",
          },
          {
            type: "diff",
            path: "src/deleted.ts",
            oldText: "gone\n",
          },
        ],
      } as never,
      workspaceRoot as never,
    );

    const commands = diffRendering.buildToolDiffJumpCommands(artifacts);

    assert.equal(commands.length, 1);
    assert.equal(commands[0].command, "vscode.open");
    assert.equal(commands[0].title, "Jump to src/a.ts");
  });
});