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
  constructor(
    readonly scheme: string,
    readonly path: string,
    readonly fsPath: string = path,
  ) {}

  toString(): string {
    return `${this.scheme}:${this.path}`;
  }

  static parse(value: string): MockUri {
    const separatorIndex = value.indexOf(":");
    if (separatorIndex < 0) {
      return new MockUri("file", value, value);
    }

    const scheme = value.slice(0, separatorIndex);
    const path = value.slice(separatorIndex + 1);
    return new MockUri(scheme, path, path);
  }
}

class MockEventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];

  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

function clearSessionManagerModules(): void {
  for (const moduleId of [
    "./acpSessionManager",
    "./chatIdentifiers",
    "./permittedPaths",
    "./skillDiscovery",
  ]) {
    try {
      delete require.cache[require.resolve(moduleId)];
    } catch {
      // ignore missing modules between test runs
    }
  }
}

type MockVscode = {
  Uri: typeof MockUri;
  EventEmitter: typeof MockEventEmitter;
  ChatSessionStatus: {
    Completed: number;
    InProgress: number;
    NeedsInput: number;
    Failed: number;
  };
  workspace: {
    workspaceFolders: Array<{ uri: MockUri }>;
  };
  env: {
    appRoot: string;
  };
};

let mockVscode: MockVscode;

setup(() => {
  mockVscode = {
    Uri: MockUri,
    EventEmitter: MockEventEmitter,
    ChatSessionStatus: {
      Completed: 1,
      InProgress: 2,
      NeedsInput: 3,
      Failed: 4,
    },
    workspace: {
      workspaceFolders: [
        {
          uri: new MockUri("file", "/workspace", "/workspace"),
        },
      ],
    },
    env: {
      appRoot: "/workspace",
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

  clearSessionManagerModules();
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
  clearSessionManagerModules();
});

suite("acpSessionManager", () => {
  test("invalidates active sessions after the ACP client stops", async () => {
    const { createAcpSessionManager, setSessionManagerVscodeForTesting } =
      require("./acpSessionManager") as typeof import("./acpSessionManager");
    const { setPermittedPathsVscodeForTesting } =
      require("./permittedPaths") as typeof import("./permittedPaths");
    setSessionManagerVscodeForTesting(mockVscode as any);
    setPermittedPathsVscodeForTesting(mockVscode as any);

    const stopEmitter = new MockEventEmitter<void>();
    const sessionUpdateEmitter = new MockEventEmitter<unknown>();
    const optionsChangedEmitter = new MockEventEmitter<void>();
    const dataChangedEmitter = new MockEventEmitter<void>();
    let createSessionCalls = 0;

    const client = {
      onSessionUpdate: sessionUpdateEmitter.event,
      onDidStop: stopEmitter.event,
      onDidStart: new MockEventEmitter<void>().event,
      onDidOptionsChanged: optionsChangedEmitter.event,
      getCapabilities: () => ({}),
      createSession: async () => {
        createSessionCalls += 1;
        return {
          sessionId: `session-${createSessionCalls}`,
          modes: null,
          models: null,
          configOptions: [],
        };
      },
      getSupportedModelState: () => null,
      getSupportedModeState: () => null,
      loadSession: async () => {
        throw new Error("not implemented");
      },
      prompt: async () => ({ stopReason: "end_turn" }),
      cancel: async () => void 0,
      changeMode: async () => void 0,
      changeModel: async () => void 0,
      setThink: async () => ({
        success: true,
        currentThinkEnabled: false,
      }),
      setSessionConfigOption: async () => void 0,
      getConfigOptions: () => [],
      sendQuestionAnswers: async () => void 0,
      listNativeSessions: async () => ({ sessions: [] }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => void 0,
      dispose: () => void 0,
    };

    const sessionDb = {
      onDataChanged: dataChangedEmitter.event,
      listSessions: async () => [],
      upsertSession: async () => void 0,
      deleteSession: async () => void 0,
      deleteAllSessions: async () => void 0,
      hasSession: async () => false,
      dispose: () => void 0,
    };

    const agent = {
      id: "auggie",
      label: "Auggie",
      command: "auggie",
      args: [],
      enabled: true,
      mcpServers: [],
      manualCommands: [],
      skillPaths: [],
    };

    const logger = {
      debug: () => void 0,
      info: () => void 0,
      warn: () => void 0,
      error: () => void 0,
    };

    const manager = createAcpSessionManager(
      sessionDb as any,
      agent as any,
      {} as any,
      logger as any,
      () => client as any,
    );

    const untitledResource = MockUri.parse("acp-auggie:/untitled-1") as any;
    const firstResult = await manager.createOrGet(untitledResource);
    assert.equal(firstResult.session.acpSessionId, "session-1");
    assert.equal(
      manager.getActive(untitledResource)?.acpSessionId,
      "session-1",
    );

    stopEmitter.fire();

    assert.equal(manager.getActive(untitledResource), undefined);

    const secondResult = await manager.createOrGet(untitledResource);
    assert.equal(secondResult.session.acpSessionId, "session-2");
    assert.equal(createSessionCalls, 2);

    manager.dispose();
    setPermittedPathsVscodeForTesting(undefined);
    setSessionManagerVscodeForTesting(undefined);
  });

  test("drops completed untitled sessions so a new untitled chat gets a fresh ACP session", async () => {
    const { createAcpSessionManager, setSessionManagerVscodeForTesting } =
      require("./acpSessionManager") as typeof import("./acpSessionManager");
    const { setPermittedPathsVscodeForTesting } =
      require("./permittedPaths") as typeof import("./permittedPaths");
    setSessionManagerVscodeForTesting(mockVscode as any);
    setPermittedPathsVscodeForTesting(mockVscode as any);

    const stopEmitter = new MockEventEmitter<void>();
    const sessionUpdateEmitter = new MockEventEmitter<unknown>();
    const optionsChangedEmitter = new MockEventEmitter<void>();
    const dataChangedEmitter = new MockEventEmitter<void>();
    let createSessionCalls = 0;

    const client = {
      onSessionUpdate: sessionUpdateEmitter.event,
      onDidStop: stopEmitter.event,
      onDidStart: new MockEventEmitter<void>().event,
      onDidOptionsChanged: optionsChangedEmitter.event,
      getCapabilities: () => ({}),
      createSession: async () => {
        createSessionCalls += 1;
        return {
          sessionId: `session-${createSessionCalls}`,
          modes: null,
          models: null,
          configOptions: [],
        };
      },
      getSupportedModelState: () => null,
      getSupportedModeState: () => null,
      loadSession: async () => {
        throw new Error("not implemented");
      },
      prompt: async () => ({ stopReason: "end_turn" }),
      cancel: async () => void 0,
      changeMode: async () => void 0,
      changeModel: async () => void 0,
      setThink: async () => ({
        success: true,
        currentThinkEnabled: false,
      }),
      setSessionConfigOption: async () => void 0,
      getConfigOptions: () => [],
      sendQuestionAnswers: async () => void 0,
      listNativeSessions: async () => ({ sessions: [] }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => void 0,
      dispose: () => void 0,
    };

    const sessionDb = {
      onDataChanged: dataChangedEmitter.event,
      listSessions: async () => [],
      upsertSession: async () => void 0,
      deleteSession: async () => void 0,
      deleteAllSessions: async () => void 0,
      dispose: () => void 0,
      hasSession: async () => false,
    };

    const agent = {
      id: "auggie",
      label: "Auggie",
      command: "auggie",
      args: [],
      enabled: true,
      mcpServers: [],
      manualCommands: [],
      skillPaths: [],
    };

    const logger = {
      debug: () => void 0,
      info: () => void 0,
      warn: () => void 0,
      error: () => void 0,
    };

    const manager = createAcpSessionManager(
      sessionDb as any,
      agent as any,
      {} as any,
      logger as any,
      () => client as any,
    );

    const firstUntitledResource = MockUri.parse(
      "acp-auggie:/untitled-1",
    ) as any;
    const secondUntitledResource = MockUri.parse(
      "acp-auggie:/untitled-2",
    ) as any;

    const firstResult = await manager.createOrGet(firstUntitledResource);
    assert.equal(firstResult.session.acpSessionId, "session-1");

    firstResult.session.markAsCompleted();
    await manager.syncSessionState(firstUntitledResource, firstResult.session);

    assert.equal(manager.getActive(firstUntitledResource), undefined);

    const secondResult = await manager.createOrGet(secondUntitledResource);
    assert.equal(secondResult.session.acpSessionId, "session-2");
    assert.equal(createSessionCalls, 2);

    manager.dispose();
    setPermittedPathsVscodeForTesting(undefined);
    setSessionManagerVscodeForTesting(undefined);
  });

  test("reuses an already active named session without creating another ACP session", async () => {
    const { createAcpSessionManager, setSessionManagerVscodeForTesting } =
      require("./acpSessionManager") as typeof import("./acpSessionManager");
    const { setPermittedPathsVscodeForTesting } =
      require("./permittedPaths") as typeof import("./permittedPaths");
    setSessionManagerVscodeForTesting(mockVscode as any);
    setPermittedPathsVscodeForTesting(mockVscode as any);

    const stopEmitter = new MockEventEmitter<void>();
    const sessionUpdateEmitter = new MockEventEmitter<unknown>();
    const optionsChangedEmitter = new MockEventEmitter<void>();
    const dataChangedEmitter = new MockEventEmitter<void>();
    let createSessionCalls = 0;

    const client = {
      onSessionUpdate: sessionUpdateEmitter.event,
      onDidStop: stopEmitter.event,
      onDidStart: new MockEventEmitter<void>().event,
      onDidOptionsChanged: optionsChangedEmitter.event,
      getCapabilities: () => ({}),
      createSession: async () => {
        createSessionCalls += 1;
        return {
          sessionId: `session-${createSessionCalls}`,
          modes: null,
          models: null,
          configOptions: [],
        };
      },
      getSupportedModelState: () => null,
      getSupportedModeState: () => null,
      loadSession: async () => {
        throw new Error("should not load active named sessions");
      },
      prompt: async () => ({ stopReason: "end_turn" }),
      cancel: async () => void 0,
      changeMode: async () => void 0,
      changeModel: async () => void 0,
      setThink: async () => ({
        success: true,
        currentThinkEnabled: false,
      }),
      setSessionConfigOption: async () => void 0,
      getConfigOptions: () => [],
      sendQuestionAnswers: async () => void 0,
      listNativeSessions: async () => ({ sessions: [] }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => void 0,
      dispose: () => void 0,
    };

    const sessionDb = {
      onDataChanged: dataChangedEmitter.event,
      listSessions: async () => [],
      upsertSession: async () => void 0,
      deleteSession: async () => void 0,
      deleteAllSessions: async () => void 0,
      dispose: () => void 0,
      hasSession: async () => false,
    };

    const agent = {
      id: "auggie",
      label: "Auggie",
      command: "auggie",
      args: [],
      enabled: true,
      mcpServers: [],
      manualCommands: [],
      skillPaths: [],
    };

    const logger = {
      debug: () => void 0,
      info: () => void 0,
      warn: () => void 0,
      error: () => void 0,
    };

    const manager = createAcpSessionManager(
      sessionDb as any,
      agent as any,
      {} as any,
      logger as any,
      () => client as any,
    );

    const untitledResource = MockUri.parse("acp-auggie:/untitled-1") as any;
    const firstResult = await manager.createOrGet(untitledResource);
    manager.createSessionUri(firstResult.session);
    const namedResource = MockUri.parse(
      `acp-auggie:/${firstResult.session.acpSessionId}`,
    ) as any;

    const secondResult = await manager.createOrGet(namedResource);

    assert.equal(
      secondResult.session.acpSessionId,
      firstResult.session.acpSessionId,
    );
    assert.equal(createSessionCalls, 1);

    manager.dispose();
    setPermittedPathsVscodeForTesting(undefined);
    setSessionManagerVscodeForTesting(undefined);
  });
});
