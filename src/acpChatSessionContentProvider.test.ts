import assert from "node:assert/strict";
import Module from "node:module";
import { setup, suite, teardown, test } from "mocha";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

const moduleWithLoad = Module as typeof Module & {
  _load: (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => unknown;
};
const originalLoad = moduleWithLoad._load;

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

function clearContentProviderModules(): void {
  for (const moduleId of ["./acpChatSessionContentProvider"]) {
    try {
      delete require.cache[require.resolve(moduleId)];
    } catch {
      // ignore missing modules between test runs
    }
  }
}

function installMockVscode(): () => void {
  const previousLoad = moduleWithLoad._load;
  moduleWithLoad._load = (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => {
    if (request === "vscode") {
      return {
        EventEmitter: MockEventEmitter,
        l10n: {
          t: (value: string) => value,
        },
      };
    }

    return previousLoad(request, parent, isMain);
  };

  return () => {
    moduleWithLoad._load = previousLoad;
  };
}

const modelConfigOption: SessionConfigOption = {
  id: "model-picker",
  name: "Model",
  description: "Choose an ACP-advertised model",
  category: "model",
  type: "select",
  currentValue: "opencode/deepseek-v4-flash-free",
  options: [
    {
      value: "opencode/deepseek-v4-flash-free",
      name: "DeepSeek V4 Flash",
      description: "Default OpenCode model",
    },
    {
      value: "opencode/gpt-5",
      name: "GPT-5",
    },
  ],
};

setup(() => {
  clearContentProviderModules();
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
  clearContentProviderModules();
});

suite("acpChatSessionContentProvider", () => {
  test("surfaces ACP session config options as provider option groups", async () => {
    const restoreMockVscode = installMockVscode();
    clearContentProviderModules();
    const { AcpChatSessionContentProvider } =
      require("./acpChatSessionContentProvider") as typeof import("./acpChatSessionContentProvider");
    const provider = new AcpChatSessionContentProvider(
      {
        onDidOptionsChange: new MockEventEmitter<void>().event,
        onDidContextWindowChange: new MockEventEmitter<unknown>().event,
        getOptions: async () => ({
          modes: {
            currentModeId: "build",
            availableModes: [{ id: "build", name: "Build" }],
          },
          models: {
            currentModelId: "legacy-model",
            availableModels: [{ modelId: "legacy-model", name: "Legacy" }],
          },
          configOptions: [modelConfigOption],
        }),
      } as any,
      { requestHandler: async () => void 0 } as any,
      { debug: () => void 0 } as any,
    );

    try {
      const providerOptions = await provider.provideChatSessionProviderOptions(
        {} as any,
      );

      assert.equal(
        providerOptions.optionGroups?.some(
          (group) => group.id === "model-picker",
        ),
        true,
      );
      assert.equal(
        providerOptions.optionGroups?.some((group) => group.id === "model"),
        false,
      );
      const modelGroup = providerOptions.optionGroups?.find(
        (group) => group.id === "model-picker",
      );
      assert.equal(modelGroup?.items[0].id, "opencode/deepseek-v4-flash-free");
      assert.equal(modelGroup?.items[0].default, true);
    } finally {
      provider.dispose();
      restoreMockVscode();
    }
  });

  test("routes ACP config option changes through setSessionConfigOption", async () => {
    const restoreMockVscode = installMockVscode();
    clearContentProviderModules();
    const { AcpChatSessionContentProvider } =
      require("./acpChatSessionContentProvider") as typeof import("./acpChatSessionContentProvider");
    const setConfigCalls: Array<{ configId: string; value: string }> = [];
    const changeModelCalls: string[] = [];
    const session = {
      acpSessionId: "session-1",
      defaultChatOptions: { modeId: "build", modelId: "legacy-model" },
      thinkState: { enabled: false },
      client: {
        getConfigOptions: () => [modelConfigOption],
        setSessionConfigOption: async (
          _sessionId: string,
          configId: string,
          value: string,
        ) => {
          setConfigCalls.push({ configId, value });
        },
        changeMode: async () => void 0,
        changeModel: async (_sessionId: string, modelId: string) => {
          changeModelCalls.push(modelId);
        },
      },
    };
    const provider = new AcpChatSessionContentProvider(
      {
        onDidOptionsChange: new MockEventEmitter<void>().event,
        onDidContextWindowChange: new MockEventEmitter<unknown>().event,
        getOptions: async () => ({
          modes: null,
          models: null,
          configOptions: [],
        }),
        getActive: () => session,
      } as any,
      { requestHandler: async () => void 0 } as any,
      { warn: () => void 0, info: () => void 0 } as any,
    );

    try {
      await provider.provideHandleOptionsChange(
        {} as any,
        [{ optionId: "model-picker", value: "opencode/gpt-5" }],
        {} as any,
      );

      assert.deepEqual(setConfigCalls, [
        { configId: "model-picker", value: "opencode/gpt-5" },
      ]);
      assert.deepEqual(changeModelCalls, []);
      assert.equal(session.defaultChatOptions.modelId, "opencode/gpt-5");
    } finally {
      provider.dispose();
      restoreMockVscode();
    }
  });
});
