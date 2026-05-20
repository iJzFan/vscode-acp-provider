import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { setup, suite, teardown, test } from "mocha";

type TurnBuilderModule = typeof import("./turnBuilder");

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

let turnBuilderModule: TurnBuilderModule;

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
    return MockUri.file(value.replace(/^file:\/\//, ""));
  }

  static joinPath(base: MockUri, ...segments: string[]): MockUri {
    return new MockUri(base.scheme, path.join(base.fsPath, ...segments));
  }
}

class MockChatRequestTurn2 {
  constructor(
    readonly prompt: string,
    readonly command?: unknown,
    readonly references: unknown[] = [],
    readonly participantId?: string,
  ) {}
}

function clearModules(): void {
  for (const moduleId of [
    "./turnBuilder",
    "./chatRenderingUtils",
    "./diffRendering",
    "./diffContentProvider",
    "./types",
    "./disposables",
  ]) {
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
      const workspaceRoot = MockUri.file(path.join("C:", "workspace"));
      return {
        Uri: MockUri,
        ChatRequestTurn2: MockChatRequestTurn2,
        workspace: {
          workspaceFolders: [{ uri: workspaceRoot }],
          asRelativePath: (uri: MockUri) =>
            path.relative(workspaceRoot.fsPath, uri.fsPath) || uri.fsPath,
        },
        l10n: { t: (value: string) => value },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  clearModules();
  turnBuilderModule = require("./turnBuilder") as TurnBuilderModule;
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
  moduleWithLoad._resolveFilename = originalResolve;
  clearModules();
});

suite("turnBuilder", () => {
  test("parses structured command XML before colon-style user chunks", () => {
    const builder = new turnBuilderModule.TurnBuilder("acp", {
      debug: () => undefined,
    } as never);

    builder.processNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "text",
          text: [
            "User: <command-message>/release</command-message>",
            "<command-name>release</command-name>",
            "<command-args>plan</command-args>",
          ].join("\n"),
        },
      },
    } as never);

    const turns = builder.getTurns();
    assert.equal(turns.length, 1);
    assert.equal((turns[0] as MockChatRequestTurn2).prompt, "/release plan");
  });

  test("decodes escaped XML entities in structured command arguments", () => {
    const builder = new turnBuilderModule.TurnBuilder("acp", {
      debug: () => undefined,
    } as never);

    builder.processNotification({
      sessionId: "session-2",
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "text",
          text: [
            "<command-message>/plan</command-message>",
            "<command-name>plan</command-name>",
            "<command-args>alpha &lt; beta &amp; gamma</command-args>",
          ].join("\n"),
        },
      },
    } as never);

    const turns = builder.getTurns();
    assert.equal(turns.length, 1);
    assert.equal(
      (turns[0] as MockChatRequestTurn2).prompt,
      "/plan alpha < beta & gamma",
    );
  });
});
