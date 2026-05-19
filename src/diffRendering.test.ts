import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { setup, suite, teardown, test } from "mocha";

type DiffRenderingModule = typeof import("./diffRendering");

const moduleWithLoad = Module as typeof Module & {
  _load: (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => unknown;
};
const originalLoad = moduleWithLoad._load;

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
    if (request === "vscode") {
      return {
        Uri: MockUri,
        ChatResponseMultiDiffPart: MockChatResponseMultiDiffPart,
        l10n: { t: (value: string) => value },
        workspace: { workspaceFolders: undefined },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  clearDiffRenderingModules();
  diffRendering = require("./diffRendering") as DiffRenderingModule;
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
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
    assert.equal(part.readOnly, true);
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
});