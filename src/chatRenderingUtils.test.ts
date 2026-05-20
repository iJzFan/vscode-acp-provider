import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { setup, suite, teardown, test } from "mocha";

type ChatRenderingUtilsModule = typeof import("./chatRenderingUtils");

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

let chatRenderingUtils: ChatRenderingUtilsModule;

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
    return MockUri.file(value);
  }

  static joinPath(base: MockUri, ...segments: string[]): MockUri {
    return new MockUri(base.scheme, path.join(base.fsPath, ...segments));
  }
}

function clearModules(): void {
  for (const moduleId of ["./chatRenderingUtils", "./types"]) {
    delete require.cache[require.resolve(moduleId)];
  }
}

setup(() => {
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

  moduleWithLoad._load = (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => {
    if (request === "vscode" || request === MOCK_VSCODE_MODULE_ID) {
      return {
        Uri: MockUri,
        workspace: {
          workspaceFolders: [
            {
              uri: MockUri.file(path.join("C:", "workspace")),
            },
          ],
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  clearModules();
  chatRenderingUtils = require("./chatRenderingUtils") as ChatRenderingUtilsModule;
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
  moduleWithLoad._resolveFilename = originalResolve;
  clearModules();
});

suite("chatRenderingUtils", () => {
  test("getToolInfo includes diff paths as editable resources", () => {
    const info = chatRenderingUtils.getToolInfo({
      toolCallId: "tool-1",
      title: "writeTextFile",
      kind: "edit",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "src/example.ts",
          oldText: "before",
          newText: "after",
        },
      ],
    } as never);

    assert.equal(info.resources?.length, 1);
    assert.equal(
      info.resources?.[0].fsPath,
      path.join(path.resolve(path.join("C:", "workspace")), "src", "example.ts"),
    );
  });

  test("getToolInfo strips trailing PowerShell CLIXML noise from output", () => {
    const info = chatRenderingUtils.getToolInfo({
      toolCallId: "tool-2",
      title: "npm test",
      kind: "execute",
      status: "failed",
      rawOutput: {
        command: ["npm", "test"],
        formatted_output:
          "TypeError: boom\n#< CLIXML\n<Objs Version=\"1.1.0.1\"></Objs>",
      },
    } as never);

    assert.equal(info.output, "TypeError: boom");
  });

  test("getToolInfo drops pure PowerShell CLIXML output", () => {
    const info = chatRenderingUtils.getToolInfo({
      toolCallId: "tool-3",
      title: "npm test",
      kind: "execute",
      status: "completed",
      rawOutput: {
        command: ["npm", "test"],
        formatted_output: "#< CLIXML\n<Objs Version=\"1.1.0.1\"></Objs>",
      },
    } as never);

    assert.equal(info.output, undefined);
  });
});
