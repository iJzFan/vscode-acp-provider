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

function clearAcpClientModule(): void {
  try {
    delete require.cache[require.resolve("./acpClient")];
  } catch {
    // ignore missing module between test runs
  }
}

setup(() => {
  moduleWithLoad._load = (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => {
    if (request === "vscode") {
      return {};
    }

    return originalLoad(request, parent, isMain);
  };

  clearAcpClientModule();
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
  clearAcpClientModule();
});

suite("acpClient cancel", () => {
  test("tracks outgoing session prompt request ids for later cancellation", async () => {
    const { trackOutgoingPromptRequest } =
      require("./acpClient") as typeof import("./acpClient");
    const trackedIds = new Map<string, string | number | null>();

    trackOutgoingPromptRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "session/prompt",
        params: { sessionId: "session-7", prompt: [] },
      },
      trackedIds as any,
    );

    trackOutgoingPromptRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "session/load",
        params: { sessionId: "session-8" },
      },
      trackedIds as any,
    );

    assert.equal(trackedIds.get("session-7"), 7);
    assert.equal(trackedIds.has("session-8"), false);
  });

  test("skips protocol cancel when no ACP request id is available", async () => {
    const { sendSessionCancel } =
      require("./acpClient") as typeof import("./acpClient");
    const cancelCalls: Array<{
      sessionId: string;
      requestId: string | number | null;
    }> = [];
    const debugMessages: string[] = [];

    const didCancel = await sendSessionCancel(
      {
        cancel: async (params: {
          sessionId: string;
          requestId: string | number | null;
        }) => {
          cancelCalls.push(params);
        },
      } as any,
      {
        sessionId: "session-1",
        agentId: "auggie",
        logChannel: {
          appendLine: () => void 0,
          debug: (message: string) => {
            debugMessages.push(message);
          },
        },
      },
    );

    assert.equal(didCancel, false);
    assert.deepEqual(cancelCalls, []);
    assert.equal(debugMessages.length, 1);
    assert.match(debugMessages[0], /Skipping session\/cancel/i);
  });

  test("sends protocol cancel when a request id is provided", async () => {
    const { sendSessionCancel } =
      require("./acpClient") as typeof import("./acpClient");
    const cancelCalls: Array<{
      sessionId: string;
      requestId: string | number | null;
    }> = [];

    const didCancel = await sendSessionCancel(
      {
        cancel: async (params: {
          sessionId: string;
          requestId: string | number | null;
        }) => {
          cancelCalls.push(params);
        },
      } as any,
      {
        sessionId: "session-2",
        requestId: 42,
        agentId: "auggie",
        logChannel: {
          appendLine: () => void 0,
          debug: () => void 0,
        },
      },
    );

    assert.equal(didCancel, true);
    assert.deepEqual(cancelCalls, [{ sessionId: "session-2", requestId: 42 }]);
  });
});
