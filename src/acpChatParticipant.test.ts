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

class MockDisposable {
  constructor(private readonly callback: () => void = () => void 0) {}

  dispose(): void {
    this.callback();
  }
}

class MockEventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];

  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return new MockDisposable(() => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    });
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
}

class MockChatCompletionItem {
  icon?: unknown;
  insertText?: string;
  detail?: string;
  documentation?: string;

  constructor(
    readonly id: string,
    readonly label: string,
    readonly values?: unknown[],
  ) {}
}

class MockThemeIcon {
  constructor(readonly id: string) {}
}

class MockMarkdownString {
  isTrusted: boolean | { enabledCommands: readonly string[] } = false;
  supportThemeIcons = false;

  constructor(public value = "") {}

  appendMarkdown(value: string): MockMarkdownString {
    this.value += value;
    return this;
  }
}

class MockUri {
  constructor(
    readonly scheme: string,
    readonly fsPath: string,
  ) {}

  toString(): string {
    return `${this.scheme}:${this.fsPath}`;
  }

  static file(fsPath: string): MockUri {
    return new MockUri("file", fsPath);
  }

  static parse(value: string): MockUri {
    return new MockUri("file", value);
  }

  static joinPath(base: MockUri, ...segments: string[]): MockUri {
    return new MockUri(base.scheme, [base.fsPath, ...segments].join("/"));
  }
}

class MockLocation {
  constructor(
    readonly uri: MockUri,
    readonly range: { start: { line: number; character: number } },
  ) {}
}

const mockVscode = {
  __esModule: true,
  Disposable: MockDisposable,
  EventEmitter: MockEventEmitter,
  ChatCompletionItem: MockChatCompletionItem,
  ChatVariableLevel: { Short: 1 },
  ThemeIcon: MockThemeIcon,
  MarkdownString: MockMarkdownString,
  Uri: MockUri,
  Location: MockLocation,
  ChatSessionStatus: {
    InProgress: 1,
    Completed: 2,
    Failed: 3,
    NeedsInput: 4,
  },
  workspace: {
    workspaceFolders: [{ uri: MockUri.file("/workspace") }],
    asRelativePath: (uri: MockUri) => uri.fsPath.replace(/^\/workspace\/?/, ""),
    fs: {
      readFile: async () => new Uint8Array(),
    },
    textDocuments: [],
  },
  window: {
    showWarningMessage: async () => undefined,
  },
  l10n: {
    t: (value: string) => value,
  },
  lm: {
    tools: [] as Array<{
      name: string;
      description: string;
      inputSchema?: object;
      tags: string[];
    }>,
    invokeTool: (async () => ({ content: [] as unknown[] })) as (
      ...args: unknown[]
    ) => Promise<{ content: unknown[] }>,
  },
  LanguageModelChatMessage: {
    User: (content: string) => ({ role: "user", content }),
  },
  LanguageModelChatToolMode: {
    Required: 2,
  },
};

function clearAcpChatParticipantModules(): void {
  for (const moduleId of [
    "./acpChatParticipant",
    "./permissionPrompts",
    "./chatRenderingUtils",
    "./diffRendering",
    "./types",
    "./acpSessionManager",
  ]) {
    try {
      delete require.cache[require.resolve(moduleId)];
    } catch {
      // ignore missing modules between test runs
    }
  }
}

function installMockVscode(): void {
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
}

function createParticipant(logger: { warn: (message: string) => void }) {
  const { AcpChatParticipant } =
    require("./acpChatParticipant") as typeof import("./acpChatParticipant");
  return new AcpChatParticipant(
    {} as any,
    {
      getKnownAvailableCommands: () => [],
      getDiscoveredSkills: () => [],
    } as any,
    {
      warn: logger.warn,
      error: () => void 0,
      info: () => void 0,
      debug: () => void 0,
      trace: () => void 0,
    } as any,
    "test-agent",
  );
}

const activeToken = { isCancellationRequested: false };
const toolInvocationToken = { opaque: true };

setup(() => {
  mockVscode.lm.tools = [];
  mockVscode.lm.invokeTool = async () => ({ content: [] });
  installMockVscode();
  clearAcpChatParticipantModules();
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
  clearAcpChatParticipantModules();
});

suite("acpChatParticipant tool attachments", () => {
  test("materializes attached VS Code tools into ACP prompt blocks", async () => {
    mockVscode.lm.tools = [
      {
        name: "copilot_searchCodebase",
        description: "Search the workspace",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        tags: ["codesearch"],
      },
    ];

    const sendRequestCalls: unknown[] = [];
    const invokeToolCalls: unknown[] = [];
    mockVscode.lm.invokeTool = async (...args: unknown[]) => {
      const [name, options] = args;
      invokeToolCalls.push({ name, options });
      return {
        content: [
          { value: "Found src/acpSessionManager.ts with session state code." },
          {
            mimeType: "application/json",
            data: new TextEncoder().encode('{"matches":1}'),
          },
        ],
      };
    };

    const request = {
      prompt: "Find the session manager",
      command: undefined,
      references: [],
      toolReferences: [{ name: "copilot_searchCodebase", range: [0, 5] }],
      toolInvocationToken,
      model: {
        sendRequest: async (_messages: unknown, options: unknown) => {
          sendRequestCalls.push(options);
          return {
            stream: (async function* () {
              yield {
                name: "copilot_searchCodebase",
                input: { query: "session manager" },
              };
            })(),
          };
        },
      },
    };

    installMockVscode();
    clearAcpChatParticipantModules();
    const participant = createParticipant({ warn: () => void 0 });
    const blocks = await (participant as any).buildPromptBlocks(
      request,
      {},
      activeToken,
    );

    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, "User: Find the session manager");
    assert.match(blocks[1].text, /Resolved tool attachment \(copilot_searchCodebase\)/);
    assert.match(blocks[1].text, /"query": "session manager"/);
    assert.match(blocks[1].text, /Found src\/acpSessionManager\.ts/);
    assert.match(blocks[1].text, /"matches":1/);
    assert.equal(sendRequestCalls.length, 1);
    assert.equal((sendRequestCalls[0] as any).toolMode, 2);
    assert.equal((sendRequestCalls[0] as any).tools[0].name, "copilot_searchCodebase");
    assert.deepEqual(invokeToolCalls, [
      {
        name: "copilot_searchCodebase",
        options: {
          toolInvocationToken,
          input: { query: "session manager" },
        },
      },
    ]);

    participant.dispose();
  });

  test("falls back to textual tool references when materialization fails", async () => {
    mockVscode.lm.tools = [
      {
        name: "copilot_searchCodebase",
        description: "Search the workspace",
        inputSchema: { type: "object" },
        tags: [],
      },
    ];

    const warnings: string[] = [];
    const request = {
      prompt: "Find the session manager",
      command: undefined,
      references: [],
      toolReferences: [{ name: "copilot_searchCodebase", range: [3, 9] }],
      toolInvocationToken,
      model: {
        sendRequest: async () => {
          throw new Error("model unavailable");
        },
      },
    };

    installMockVscode();
    clearAcpChatParticipantModules();
    const participant = createParticipant({
      warn: (message) => warnings.push(message),
    });
    const blocks = await (participant as any).buildPromptBlocks(
      request,
      {},
      activeToken,
    );

    assert.equal(blocks.length, 2);
    assert.equal(blocks[1].text, "Tool reference (copilot_searchCodebase) [3, 9]");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Failed to resolve tool attachment copilot_searchCodebase/);

    participant.dispose();
  });
});
