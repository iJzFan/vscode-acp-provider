import assert from "node:assert/strict";
import Module from "node:module";
import { setup, suite, teardown, test } from "mocha";

const moduleWithLoad = Module as typeof Module & {
  _load: (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => unknown;
};
const originalLoad = moduleWithLoad._load;

class MockUri {
  constructor(readonly scheme: string, readonly path: string) {}

  toString(): string {
    return `${this.scheme}:${this.path}`;
  }

  static parse(value: string): MockUri {
    const separatorIndex = value.indexOf(":");
    return new MockUri(value.slice(0, separatorIndex), value.slice(separatorIndex + 1));
  }
}

class MockDisposable {
  constructor(private readonly onDispose: () => void = () => void 0) {}
  dispose(): void {
    this.onDispose();
  }
}

let disposeListener: ((value: string) => void) | undefined;
const mockVscode = {
  Uri: MockUri,
  chat: {
    onDidDisposeChatSession: (listener: (value: string) => void) => {
      disposeListener = listener;
      return new MockDisposable(() => {
        disposeListener = undefined;
      });
    },
  },
};

function clearModules(): void {
  for (const moduleId of ["./chatSessionDisposal", "./chatIdentifiers"]) {
    try {
      delete require.cache[require.resolve(moduleId)];
    } catch {
      // ignore missing modules between test runs
    }
  }
}

setup(() => {
  disposeListener = undefined;
  moduleWithLoad._load = (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => {
    if (request === "vscode") {
      return mockVscode;
    }

    return originalLoad(request, parent, isMain);
  };
  clearModules();
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
  clearModules();
});

suite("chatSessionDisposal", () => {
  test("closes the matching ACP session when VS Code disposes its resource URI", () => {
    const { registerChatSessionDisposalCleanup } =
      require("./chatSessionDisposal") as typeof import("./chatSessionDisposal");
    const closeCalls: string[] = [];
    const manager = {
      getActive: (resource: MockUri) => ({ vscodeResource: resource }),
      closeSession: (resource: MockUri) => {
        closeCalls.push(resource.toString());
        return true;
      },
    };

    const disposable = registerChatSessionDisposalCleanup(
      new Map([["auggie", manager as any]]),
      { warn: () => void 0 } as any,
      mockVscode as any,
    );

    disposeListener?.("acp-auggie:/session-1");

    assert.deepEqual(closeCalls, ["acp-auggie:/session-1"]);
    disposable?.dispose();
  });

  test("ignores stale disposed resources that no longer match the session's current URI", () => {
    const { registerChatSessionDisposalCleanup } =
      require("./chatSessionDisposal") as typeof import("./chatSessionDisposal");
    const closeCalls: string[] = [];
    const manager = {
      getActive: (_resource: MockUri) => ({
        vscodeResource: MockUri.parse("acp-auggie:/session-1"),
      }),
      closeSession: (resource: MockUri) => {
        closeCalls.push(resource.toString());
        return true;
      },
    };

    const disposable = registerChatSessionDisposalCleanup(
      new Map([["auggie", manager as any]]),
      { warn: () => void 0 } as any,
      mockVscode as any,
    );

    disposeListener?.("acp-auggie:/untitled-1");

    assert.deepEqual(closeCalls, []);
    disposable?.dispose();
  });

  test("falls back to a unique legacy session id only when exactly one ACP session matches", () => {
    const { registerChatSessionDisposalCleanup } =
      require("./chatSessionDisposal") as typeof import("./chatSessionDisposal");
    const closeCalls: string[] = [];
    const warnings: string[] = [];
    const auggieManager = {
      getActive: (resource: MockUri) =>
        resource.toString() === "acp-auggie:/session-1"
          ? { vscodeResource: resource }
          : undefined,
      closeSession: (resource: MockUri) => {
        closeCalls.push(`auggie:${resource.toString()}`);
        return true;
      },
    };
    const codexManager = {
      getActive: () => undefined,
      closeSession: (resource: MockUri) => {
        closeCalls.push(`codex:${resource.toString()}`);
        return true;
      },
    };

    const disposable = registerChatSessionDisposalCleanup(
      new Map([
        ["auggie", auggieManager as any],
        ["codex", codexManager as any],
      ]),
      { warn: (message: string) => warnings.push(message) } as any,
      mockVscode as any,
    );

    disposeListener?.("session-1");

    assert.deepEqual(closeCalls, ["auggie:acp-auggie:/session-1"]);
    assert.deepEqual(warnings, []);
    disposable?.dispose();
  });
});