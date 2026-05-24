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
          asRelativePath: (uri: MockUri) =>
            path.relative(
              path.resolve(path.join("C:", "workspace")),
              uri.fsPath,
            ) || uri.fsPath,
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  clearModules();
  chatRenderingUtils =
    require("./chatRenderingUtils") as ChatRenderingUtilsModule;
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
      path.join(
        path.resolve(path.join("C:", "workspace")),
        "src",
        "example.ts",
      ),
    );
  });

  test("getToolInfo preserves PowerShell CLIXML details instead of truncating them", () => {
    const info = chatRenderingUtils.getToolInfo({
      toolCallId: "tool-2",
      title: "npm test",
      kind: "execute",
      status: "failed",
      rawOutput: {
        command: ["npm", "test"],
        formatted_output:
          'TypeError: boom\n#< CLIXML\n<Objs Version="1.1.0.1"></Objs>',
      },
    } as never);

    assert.match(info.output ?? "", /TypeError: boom/);
    assert.match(info.output ?? "", /PowerShell CLIXML:/);
    assert.match(info.output ?? "", /#< CLIXML/);
  });

  test("getToolInfo keeps pure PowerShell CLIXML output when that is all the tool returned", () => {
    const info = chatRenderingUtils.getToolInfo({
      toolCallId: "tool-3",
      title: "npm test",
      kind: "execute",
      status: "completed",
      rawOutput: {
        command: ["npm", "test"],
        formatted_output: '#< CLIXML\n<Objs Version="1.1.0.1"></Objs>',
      },
    } as never);

    assert.match(info.output ?? "", /#< CLIXML/);
  });

  test("getToolInfo keeps distinct structured output fields instead of dropping later ones", () => {
    const info = chatRenderingUtils.getToolInfo({
      toolCallId: "tool-4",
      title: "npm test",
      kind: "execute",
      status: "completed",
      rawOutput: {
        command: ["npm", "test"],
        formatted_output: "stdout line",
        aggregated_output: "stdout line",
        output: "stderr line",
      },
    } as never);

    assert.match(info.output ?? "", /=== formatted output ===/);
    assert.match(info.output ?? "", /=== raw output ===/);
    assert.match(info.output ?? "", /stdout line/);
    assert.match(info.output ?? "", /stderr line/);
  });

  test("getToolInfo extracts execute-command input from initial tool_call notifications without status", () => {
    const info = chatRenderingUtils.getToolInfo({
      toolCallId: "tool-5",
      title: "",
      kind: "execute",
      rawInput: {
        command: ["npm", "run", "compile"],
      },
      content: [],
    } as never);

    assert.equal(info.kind, "execute");
    assert.equal(info.input, "npm run compile");
    assert.equal(info.name, "npm run compile");
  });

  test("getToolInfo formats ACP tagged file review payloads into readable text", () => {
    const info = chatRenderingUtils.getToolInfo({
      toolCallId: "tool-6",
      title: "Reviewed 6 files",
      kind: "other",
      status: "completed",
      rawOutput: {
        output: [
          "<path>G:\\qwen3.6-windows-server\\docs</path>",
          "<type>directory</type>",
          "<entries>AGENT_INSTALL_PROMPT.md BLACKWELL.md README.md (24 entries)</entries>",
          "<path>G:\\qwen3.6-windows-server\\README.md</path>",
          "<type>file</type>",
          "<content>1: # qwen3.6-windows-server 2: 3: > One-click inference 4: Works offline</content>",
        ].join("\n"),
      },
    } as never);

    assert.ok(info.output);
    assert.doesNotMatch(info.output ?? "", /<path>|<type>|<entries>|<content>/);
    assert.match(info.output ?? "", /Path: G:\\qwen3\.6-windows-server\\docs/);
    assert.match(info.output ?? "", /Type: directory/);
    assert.match(
      info.output ?? "",
      /Entries:\nAGENT_INSTALL_PROMPT\.md BLACKWELL\.md README\.md \(24 entries\)/,
    );
    assert.match(
      info.output ?? "",
      /Path: G:\\qwen3\.6-windows-server\\README\.md/,
    );
    assert.match(info.output ?? "", /Type: file/);
    assert.match(
      info.output ?? "",
      /Content:\n1: # qwen3\.6-windows-server\n2:\n3: > One-click inference\n4: Works offline/,
    );
  });

  test("getToolInfo extracts OpenCode execute command strings from rawInput", () => {
    const info = chatRenderingUtils.getToolInfo({
      toolCallId: "tool-7",
      title: "bash",
      kind: "execute",
      status: "in_progress",
      rawInput: {
        command: 'Write-Host "ESC[7mprocessorESC[0m Free"',
        description: "Print ANSI escape code example",
      },
    } as never);

    assert.equal(info.input, 'Write-Host "ESC[7mprocessorESC[0m Free"');
  });

  test("buildTerminalToolInvocationData sanitizes OpenCode ANSI-style output", () => {
    const update = {
      toolCallId: "tool-8",
      title: "Print ANSI escape code example",
      kind: "execute",
      status: "completed",
      rawInput: {
        command: 'Write-Host "ESC[7mprocessorESC[0m Free"',
      },
      rawOutput: {
        output: "ESC[7mprocessorESC[0m Free\r\n",
      },
    };

    const info = chatRenderingUtils.getToolInfo(update as never);
    const data = chatRenderingUtils.buildTerminalToolInvocationData(
      update as never,
      info,
    );

    assert.ok(data);
    assert.equal(
      data?.commandLine.original,
      'Write-Host "ESC[7mprocessorESC[0m Free"',
    );
    assert.equal(data?.output?.text, "processor Free");
  });

  test("buildMcpToolInvocationData prefers markdown previews for markdown read tools", () => {
    const update = {
      toolCallId: "tool-9",
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
    };

    const info = chatRenderingUtils.getToolInfo(update as never);
    const data = chatRenderingUtils.buildMcpToolInvocationData(
      update as never,
      info,
    );
    const rendered = new TextDecoder().decode(
      data?.output?.[0].data ?? new Uint8Array(),
    );

    assert.ok(data);
    assert.equal(data?.input, "C:\\temp\\rendering-fixture.md");
    assert.equal(data?.output?.[0].mimeType, "text/markdown");
    assert.doesNotMatch(rendered, /{%\s*endcode\s*%}|<figure>|<figcaption>/);
    assert.match(rendered, /```/);
    assert.match(rendered, /## Benchmarks/);
    assert.match(rendered, /> Figure: MiniMax-M2\.7 benchmark results/);
    assert.match(rendered, /> Image source: \/files\/benchmark\.png/);
  });

  test("buildTerminalToolInvocationData unwraps Auggie command envelopes and parses return codes", () => {
    const update = {
      toolCallId: "tool-10",
      title: "Run `Write-Output 'ESC[7mprocessorESC[0m Free'`",
      kind: "execute",
      status: "completed",
      rawInput: {
        command: "Write-Output 'ESC[7mprocessorESC[0m Free'",
        wait: true,
      },
      rawOutput: {
        output: [
          "Here are the results from executing the command.",
          "<return-code>",
          "0",
          "</return-code>",
          "<output>",
          "#< CLIXML",
          "ESC[7mprocessorESC[0m Free",
          '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"></Objs>',
          "</output>",
        ].join("\n"),
      },
    };

    const info = chatRenderingUtils.getToolInfo(update as never);
    const data = chatRenderingUtils.buildTerminalToolInvocationData(
      update as never,
      info,
    );

    assert.ok(data);
    assert.equal(
      data?.commandLine.original,
      "Write-Output 'ESC[7mprocessorESC[0m Free'",
    );
    assert.equal(data?.output?.text, "processor Free");
    assert.deepEqual(data?.state, { exitCode: 0, duration: undefined });
  });

  test("buildTerminalToolInvocationData cleans Auggie markdown-like file output", () => {
    const update = {
      toolCallId: "tool-11",
      title: "Run `Get-Content -Raw 'C:\\temp\\rendering-fixture.md'`",
      kind: "execute",
      status: "completed",
      rawInput: {
        command: "Get-Content -Raw 'C:\\temp\\rendering-fixture.md'",
        wait: true,
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
    };

    const info = chatRenderingUtils.getToolInfo(update as never);
    const data = chatRenderingUtils.buildTerminalToolInvocationData(
      update as never,
      info,
    );

    assert.ok(data?.output?.text);
    assert.doesNotMatch(
      data?.output?.text ?? "",
      /{%\s*endcode\s*%}|<figure>|<figcaption>|<return-code>|<output>/,
    );
    assert.doesNotMatch(data?.output?.text ?? "", /#< CLIXML|<Objs Version=/);
    assert.match(data?.output?.text ?? "", /```/);
    assert.match(data?.output?.text ?? "", /## Benchmarks/);
    assert.match(
      data?.output?.text ?? "",
      /> Figure: MiniMax-M2\.7 benchmark results/,
    );
  });

  test("buildDiffStats treats empty content as zero diff lines", () => {
    assert.deepEqual(
      chatRenderingUtils.buildDiffStats(undefined, "const value = 1;"),
      { added: 1, removed: 0 },
    );
    assert.deepEqual(
      chatRenderingUtils.buildDiffStats("const value = 1;", undefined),
      { added: 0, removed: 1 },
    );
  });

  test("toInlineDiff uses zero-line headers for empty originals and finals", () => {
    const created = chatRenderingUtils.toInlineDiff("", "const value = 1;");
    assert.match(created, /@@ -0,0 \+1,1 @@/);
    assert.match(created, /\n\+const value = 1;$/);

    const deleted = chatRenderingUtils.toInlineDiff("const value = 1;", "");
    assert.match(deleted, /@@ -1,1 \+0,0 @@/);
    assert.match(deleted, /\n-const value = 1;$/);
  });
});
