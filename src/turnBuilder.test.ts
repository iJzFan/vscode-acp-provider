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

  test("replays execute-command tool calls with the original command line and terminal metadata", () => {
    const builder = new turnBuilderModule.TurnBuilder("acp", {
      debug: () => undefined,
    } as never);

    builder.processNotification({
      sessionId: "session-4",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-exec-1",
        title: "",
        kind: "execute",
        rawInput: {
          command: ["npm", "run", "compile"],
        },
        content: [],
      },
    } as never);
    builder.processNotification({
      sessionId: "session-4",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-exec-1",
        status: "completed",
        rawOutput: {
          output: "done",
          exitCode: 0,
          duration: 123,
        },
      },
    } as never);

    const turns = builder.getTurns();
    const response = turns[0] as unknown as MockChatResponseTurn2;
    const invocation = response.parts[1] as MockChatToolInvocationPart;

    assert.equal(invocation.invocationMessage, "npm run compile");
    assert.deepEqual(invocation.toolSpecificData, {
      language: "shell",
      commandLine: {
        original: "npm run compile",
      },
      output: {
        text: "done",
      },
      state: {
        exitCode: 0,
        duration: 123,
      },
    });
    assert.equal(invocation.presentation, undefined);
  });

  test("replays ACP tagged tool output without leaking raw tags", () => {
    const builder = new turnBuilderModule.TurnBuilder("acp", {
      debug: () => undefined,
    } as never);

    builder.processNotification({
      sessionId: "session-5",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-review-1",
        title: "Reviewed 6 files",
        kind: "other",
        status: "pending",
      },
    } as never);
    builder.processNotification({
      sessionId: "session-5",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-review-1",
        title: "Reviewed 6 files",
        kind: "other",
        status: "completed",
        rawOutput: {
          output: [
            "<path>G:\\qwen3.6-windows-server\\docs</path>",
            "<type>directory</type>",
            "<entries>AGENT_INSTALL_PROMPT.md BLACKWELL.md README.md (24 entries)</entries>",
          ].join("\n"),
        },
      },
    } as never);

    const turns = builder.getTurns();
    const response = turns[0] as unknown as MockChatResponseTurn2;
    const invocation = response.parts[1] as MockChatToolInvocationPart;
    const outputText = new TextDecoder().decode(
      (invocation.toolSpecificData as { output?: Array<{ data: Uint8Array }> })
        .output?.[0]?.data ?? new Uint8Array(),
    );

    assert.equal(invocation.name, "Reviewed 6 files");
    assert.equal(invocation.pastTenseMessage, undefined);
    assert.doesNotMatch(outputText, /<path>|<type>|<entries>/);
    assert.match(outputText, /Path: G:\\qwen3\.6-windows-server\\docs/);
    assert.match(outputText, /Entries:\nAGENT_INSTALL_PROMPT\.md/);
  });

  test("replays OpenCode execute tools with string commands and sanitized output", () => {
    const builder = new turnBuilderModule.TurnBuilder("acp", {
      debug: () => undefined,
    } as never);

    builder.processNotification({
      sessionId: "session-6",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-exec-opencode-1",
        title: "bash",
        kind: "execute",
        rawInput: {},
        status: "pending",
      },
    } as never);
    builder.processNotification({
      sessionId: "session-6",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-exec-opencode-1",
        title: "Print ANSI escape code example",
        kind: "execute",
        status: "completed",
        rawInput: {
          command: 'Write-Host "ESC[7mprocessorESC[0m Free"',
          description: "Print ANSI escape code example",
        },
        rawOutput: {
          output: "ESC[7mprocessorESC[0m Free\r\n",
        },
      },
    } as never);

    const turns = builder.getTurns();
    const response = turns[0] as unknown as MockChatResponseTurn2;
    const invocation = response.parts[1] as MockChatToolInvocationPart;

    assert.equal(
      invocation.invocationMessage,
      'Write-Host "ESC[7mprocessorESC[0m Free"',
    );
    assert.equal(
      invocation.pastTenseMessage,
      'Write-Host "ESC[7mprocessorESC[0m Free"',
    );
    assert.deepEqual(invocation.toolSpecificData, {
      language: "shell",
      commandLine: {
        original: 'Write-Host "ESC[7mprocessorESC[0m Free"',
      },
      output: {
        text: "processor Free",
      },
    });
  });

  test("replays OpenCode markdown read previews as markdown tool output", () => {
    const builder = new turnBuilderModule.TurnBuilder("acp", {
      debug: () => undefined,
    } as never);

    builder.processNotification({
      sessionId: "session-7",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-read-opencode-1",
        title: "read",
        kind: "read",
        status: "pending",
      },
    } as never);
    builder.processNotification({
      sessionId: "session-7",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-read-opencode-1",
        title: "C:\\temp\\rendering-fixture.md",
        kind: "read",
        status: "completed",
        rawInput: {
          filePath: "C:\\temp\\rendering-fixture.md",
        },
        rawOutput: {
          output: [
            "<path>C:\\temp\\rendering-fixture.md</path>",
            "<type>file</type>",
            "<content>",
            "1: {% code %}",
            "2: benchmark snippet",
            "3: {% endcode %}",
            "4:",
            "5: ## Benchmarks",
            "6:",
            '7: <figure><img src="/files/benchmark.png" alt="Benchmarks"><figcaption>MiniMax-M2.7 benchmark results</figcaption></figure>',
            "8:",
            "9: - item 1",
            "10: - item 2",
            "</content>",
          ].join("\n"),
          metadata: {
            preview: [
              "{% code %}",
              "benchmark snippet",
              "{% endcode %}",
              "",
              "## Benchmarks",
              "",
              '<figure><img src="/files/benchmark.png" alt="Benchmarks"><figcaption>MiniMax-M2.7 benchmark results</figcaption></figure>',
              "",
              "- item 1",
              "- item 2",
            ].join("\n"),
            truncated: false,
            loaded: [],
          },
        },
      },
    } as never);

    const turns = builder.getTurns();
    const response = turns[0] as unknown as MockChatResponseTurn2;
    const invocation = response.parts[1] as MockChatToolInvocationPart;
    const toolData = invocation.toolSpecificData as {
      input: string;
      output: Array<{ mimeType: string; data: Uint8Array }>;
    };
    const rendered = new TextDecoder().decode(toolData.output[0].data);

    assert.equal(invocation.pastTenseMessage, undefined);
    assert.equal(toolData.input, "C:\\temp\\rendering-fixture.md");
    assert.equal(toolData.output[0].mimeType, "text/markdown");
    assert.doesNotMatch(rendered, /{%\s*endcode\s*%}|<figure>|<figcaption>/);
    assert.match(rendered, /```/);
    assert.match(rendered, /## Benchmarks/);
    assert.match(rendered, /> Figure: MiniMax-M2\.7 benchmark results/);
  });

  test("replays Auggie wrapped execute output without wrapper tags or CLIXML noise", () => {
    const builder = new turnBuilderModule.TurnBuilder("acp", {
      debug: () => undefined,
    } as never);

    builder.processNotification({
      sessionId: "session-8",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-auggie-1",
        title: "Run `Get-Content -Raw 'C:\\temp\\rendering-fixture.md'`",
        kind: "execute",
        rawInput: {
          command: "Get-Content -Raw 'C:\\temp\\rendering-fixture.md'",
        },
        status: "pending",
      },
    } as never);
    builder.processNotification({
      sessionId: "session-8",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-auggie-1",
        title: "Run `Get-Content -Raw 'C:\\temp\\rendering-fixture.md'`",
        kind: "execute",
        status: "completed",
        rawInput: {
          command: "Get-Content -Raw 'C:\\temp\\rendering-fixture.md'",
        },
        rawOutput: {
          output: [
            "Here are the results from executing the command.",
            "<return-code>",
            "0",
            "</return-code>",
            "<output>",
            "#< CLIXML",
            "{% code %}",
            "benchmark snippet",
            "{% endcode %}",
            "",
            "## Benchmarks",
            "",
            '<figure><img src="/files/benchmark.png" alt="Benchmarks"><figcaption>MiniMax-M2.7 benchmark results</figcaption></figure>',
            "",
            "- item 1",
            "- item 2",
            '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"></Objs>',
            "</output>",
          ].join("\n"),
        },
      },
    } as never);

    const turns = builder.getTurns();
    const response = turns[0] as unknown as MockChatResponseTurn2;
    const invocation = response.parts[1] as MockChatToolInvocationPart;

    assert.equal(
      invocation.invocationMessage,
      "Get-Content -Raw 'C:\\temp\\rendering-fixture.md'",
    );
    assert.equal(
      invocation.pastTenseMessage,
      "Get-Content -Raw 'C:\\temp\\rendering-fixture.md'",
    );
    assert.deepEqual(invocation.toolSpecificData, {
      language: "shell",
      commandLine: {
        original: "Get-Content -Raw 'C:\\temp\\rendering-fixture.md'",
      },
      output: {
        text: [
          "```",
          "benchmark snippet",
          "```",
          "## Benchmarks",
          "",
          "> Figure: MiniMax-M2.7 benchmark results",
          "> Image source: /files/benchmark.png",
          "",
          "- item 1",
          "- item 2",
        ].join("\n"),
      },
      state: {
        exitCode: 0,
        duration: undefined,
      },
    });
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
