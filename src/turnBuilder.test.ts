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

class MockMarkdownString {
  value = "";

  appendMarkdown(value: string): void {
    this.value += value;
  }
}

class MockChatResponseMarkdownPart {
  constructor(readonly value: MockMarkdownString) {}
}

class MockChatResponseProgressPart {
  constructor(readonly value: string) {}
}

class MockChatToolInvocationPart {
  isConfirmed?: boolean;
  isError?: boolean;
  isComplete?: boolean;
  invocationMessage?: string;
  originMessage?: string;
  pastTenseMessage?: string;
  presentation?: string;
  subAgentInvocationId?: string;
  toolSpecificData?: unknown;

  constructor(
    readonly name: string,
    readonly toolCallId: string,
  ) {}
}

class MockChatResponseTurn2 {
  constructor(
    readonly parts: unknown[],
    readonly result: unknown,
    readonly participantId?: string,
  ) {}
}

class MockChatResponseCommandButtonPart {
  constructor(readonly command: unknown) {}
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
        MarkdownString: MockMarkdownString,
        ChatResponseMarkdownPart: MockChatResponseMarkdownPart,
        ChatResponseProgressPart: MockChatResponseProgressPart,
        ChatToolInvocationPart: MockChatToolInvocationPart,
        ChatResponseTurn2: MockChatResponseTurn2,
        ChatResponseCommandButtonPart: MockChatResponseCommandButtonPart,
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

  test("replays tool lifecycle summaries around tool invocations", () => {
    const builder = new turnBuilderModule.TurnBuilder("acp", {
      debug: () => undefined,
    } as never);

    builder.processNotification({
      sessionId: "session-3",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "planner",
        kind: "other",
        status: "pending",
      },
    } as never);
    builder.processNotification({
      sessionId: "session-3",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        title: "planner",
        kind: "other",
        status: "completed",
      },
    } as never);

    const turns = builder.getTurns();
    const response = turns[0] as unknown as MockChatResponseTurn2;
    const start = response.parts[0] as MockChatResponseProgressPart;
    const invocation = response.parts[1] as MockChatToolInvocationPart;
    const end = response.parts[2] as MockChatResponseProgressPart;

    assert.match(start.value, /^Tool started: id=call-1;/);
    assert.equal(invocation.toolCallId, "call-1");
    assert.match(end.value, /^Tool completed: id=call-1;/);
  });

  test("replays mode and usage updates as progress parts", () => {
    const builder = new turnBuilderModule.TurnBuilder("acp", {
      debug: () => undefined,
    } as never);

    builder.processNotification({
      sessionId: "session-4",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: "build",
      },
    } as never);
    builder.processNotification({
      sessionId: "session-4",
      update: {
        sessionUpdate: "usage_update",
        used: 53000,
        size: 200000,
        cost: {
          amount: 0.045,
          currency: "USD",
        },
      },
    } as never);

    const turns = builder.getTurns();
    const response = turns[0] as unknown as MockChatResponseTurn2;
    const mode = response.parts[0] as MockChatResponseProgressPart;
    const usage = response.parts[1] as MockChatResponseProgressPart;

    assert.equal(mode.value, "Mode changed: build");
    assert.match(usage.value, /53,000 \/ 200,000 tokens \(26.5%\)/);
    assert.match(usage.value, /Cost: USD 0.045/);
  });
});
