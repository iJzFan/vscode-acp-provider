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
  constructor(private readonly value: string) {}
  toString(): string {
    return this.value;
  }
  static parse(value: string): MockUri {
    return new MockUri(value);
  }
}

class MockEventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => void 0 };
  };
  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

type MockChatSessionItem = {
  resource: MockUri;
  label: string;
  status?: number;
  changes?: unknown[];
  timing?: { created: number; lastRequestStarted?: number; lastRequestEnded?: number };
};

type MockController = {
  items: {
    replace: (items: MockChatSessionItem[]) => void;
  };
  createChatSessionItem: (resource: MockUri, label: string) => MockChatSessionItem;
  newChatSessionItemHandler?: (context: {
    request: { id: string; sessionResource?: MockUri; prompt: string };
  }) => Promise<MockChatSessionItem>;
  dispose: () => void;
};

let capturedRefreshHandler: ((token: unknown) => Promise<void>) | undefined;
let lastReplacedItems: MockChatSessionItem[] = [];
let createdController: MockController | undefined;
let mockVscode: {
  Uri: typeof MockUri;
  ChatSessionStatus: {
    Completed: number;
    InProgress: number;
    NeedsInput: number;
    Failed: number;
  };
  CancellationTokenSource: new () => { token: unknown; dispose(): void };
  chat: {
    createChatSessionItemController: (
      chatSessionType: string,
      refreshHandler: (token: unknown) => Promise<void>,
    ) => MockController;
  };
};

function clearControllerModule(): void {
  for (const moduleId of [
    "./acpLifecycledChatSessionItemController",
    "./chatIdentifiers",
  ]) {
    try {
      delete require.cache[require.resolve(moduleId)];
    } catch {
      // ignore missing modules between test runs
    }
  }
}

setup(() => {
  capturedRefreshHandler = undefined;
  lastReplacedItems = [];
  createdController = undefined;
  mockVscode = {
    Uri: MockUri,
    ChatSessionStatus: {
      Completed: 1,
      InProgress: 2,
      NeedsInput: 3,
      Failed: 4,
    },
    CancellationTokenSource: class {
      readonly token = {};
      dispose(): void {}
    },
    chat: {
      createChatSessionItemController: (
        _chatSessionType: string,
        refreshHandler: (token: unknown) => Promise<void>,
      ) => {
        capturedRefreshHandler = refreshHandler;
        createdController = {
          items: {
            replace: (items: MockChatSessionItem[]) => {
              lastReplacedItems = items;
            },
          },
          createChatSessionItem: (resource: MockUri, label: string) => ({
            resource,
            label,
          }),
          dispose: () => void 0,
        };
        return createdController;
      },
    },
  };

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

  clearControllerModule();
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
  clearControllerModule();
});

suite("acpLifecycledChatSessionItemController", () => {
  test("keeps a running untitled session visible alongside persisted sessions", async () => {
    const {
      createAcpChatSessionItemController,
      setChatSessionItemControllerVscodeForTesting,
    } = require("./acpLifecycledChatSessionItemController") as typeof import("./acpLifecycledChatSessionItemController");
    setChatSessionItemControllerVscodeForTesting(mockVscode as any);

    const sessionChangeEmitter = new MockEventEmitter<{ modified: unknown }>();
    const liveSession = {
      acpSessionId: "live-1",
      title: "live-1",
      status: 2,
      vscodeResource: MockUri.parse("acp-agent:/untitled-1"),
      agent: { id: "agent" },
      cwd: "g:/workspace",
      updatedAt: Date.now(),
    };

    const sessionManager = {
      onDidChangeSession: sessionChangeEmitter.event,
      getActive: () => liveSession,
      createSessionUri: (session: { acpSessionId: string }) =>
        MockUri.parse(`acp-agent:/${session.acpSessionId}`),
      list: async () => [
        {
          resource: MockUri.parse("acp-agent:/saved-1"),
          label: "saved-1",
          status: 1,
          changes: [],
        },
      ],
      getSessionChangedFiles: () => [],
    };
    const sessionDb = {
      upsertSession: async () => void 0,
    };
    const logger = {
      debug: () => void 0,
      error: () => void 0,
    };

    const disposable = createAcpChatSessionItemController(
      "acp-agent",
      "agent",
      sessionManager as any,
      sessionDb as any,
      logger as any,
    );

    assert.ok(createdController?.newChatSessionItemHandler);
    const newItem = await createdController!.newChatSessionItemHandler!({
      request: {
        id: "req-live-1",
        sessionResource: MockUri.parse("acp-agent:/untitled-abc"),
        prompt: "Hello",
      },
    });

    assert.equal(newItem.resource.toString(), "acp-agent:/live-1");
    assert.equal(newItem.status, 2);

    await capturedRefreshHandler?.({});

    assert.deepEqual(
      lastReplacedItems.map((item) => item.resource.toString()).sort(),
      ["acp-agent:/live-1", "acp-agent:/saved-1"],
    );

    const runningItem = lastReplacedItems.find(
      (item) => item.resource.toString() === "acp-agent:/live-1",
    );
    assert.equal(runningItem?.status, 2);

    setChatSessionItemControllerVscodeForTesting(undefined);
    disposable.dispose();
  });

  test("creates a placeholder item when sessionResource is unavailable", async () => {
    const {
      createAcpChatSessionItemController,
      setChatSessionItemControllerVscodeForTesting,
    } = require("./acpLifecycledChatSessionItemController") as typeof import("./acpLifecycledChatSessionItemController");
    setChatSessionItemControllerVscodeForTesting(mockVscode as any);

    const sessionChangeEmitter = new MockEventEmitter<{ modified: unknown }>();
    const sessionManager = {
      onDidChangeSession: sessionChangeEmitter.event,
      getActive: () => undefined,
      createSessionUri: (session: { acpSessionId: string }) =>
        MockUri.parse(`acp-agent:/${session.acpSessionId}`),
      list: async () => [],
      getSessionChangedFiles: () => [],
    };
    const sessionDb = {
      upsertSession: async () => void 0,
    };
    const logger = {
      debug: () => void 0,
      error: () => void 0,
    };

    const disposable = createAcpChatSessionItemController(
      "acp-agent",
      "agent",
      sessionManager as any,
      sessionDb as any,
      logger as any,
    );

    assert.ok(createdController?.newChatSessionItemHandler);
    const newItem = await createdController!.newChatSessionItemHandler!({
      request: {
        id: "req-missing-resource",
        prompt: "Hello without resource",
      },
    });

    assert.equal(
      newItem.resource.toString(),
      "acp-agent:/untitled-pending-req-missing-resource",
    );
    assert.equal(newItem.status, 2);

    const modifiedSession = {
      acpSessionId: "live-2",
      title: "Bound live session",
      status: 2,
      vscodeResource: MockUri.parse("acp-agent:/untitled-2"),
      agent: { id: "agent" },
      cwd: "g:/workspace",
      updatedAt: Date.now(),
    };

    sessionChangeEmitter.fire({ modified: modifiedSession });

    assert.equal(newItem.label, "Bound live session");
    assert.equal(newItem.status, 2);

    setChatSessionItemControllerVscodeForTesting(undefined);
    disposable.dispose();
  });
});