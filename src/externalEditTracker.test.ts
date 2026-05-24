import assert from "node:assert/strict";
import Module from "node:module";
import { setup, suite, teardown, test } from "mocha";

type ExternalEditTrackerModule = typeof import("./externalEditTracker");

const moduleWithLoad = Module as typeof Module & {
  _load: (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => unknown;
};
const originalLoad = moduleWithLoad._load;

let externalEditTracker: ExternalEditTrackerModule;

class MockUri {
  constructor(
    readonly scheme: string,
    readonly fsPath: string,
    readonly query = "",
  ) {}

  toString(): string {
    return `${this.scheme}:${this.fsPath}${this.query ? `?${this.query}` : ""}`;
  }

  static parse(value: string): MockUri {
    return new MockUri("file", value);
  }
}

function clearModules(): void {
  delete require.cache[require.resolve("./externalEditTracker")];
}

setup(() => {
  moduleWithLoad._load = (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => {
    if (request === "vscode") {
      return { Uri: MockUri };
    }
    return originalLoad(request, parent, isMain);
  };

  clearModules();
  externalEditTracker =
    require("./externalEditTracker") as ExternalEditTrackerModule;
  externalEditTracker.clearExternalEditsForTesting();
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
  externalEditTracker.clearExternalEditsForTesting();
  clearModules();
});

suite("externalEditTracker", () => {
  test("resolves all registered callbacks for a written URI once", () => {
    let resolvedA = 0;
    let resolvedB = 0;
    const uri = MockUri.parse("/workspace/test.ts") as never;

    externalEditTracker.registerExternalEdit("tool-1", uri, () => {
      resolvedA += 1;
    });
    externalEditTracker.registerExternalEdit("tool-2", uri, () => {
      resolvedB += 1;
    });

    const resolvedCount = externalEditTracker.resolveExternalEditsForUri(uri);
    const resolvedAgain = externalEditTracker.resolveExternalEditsForUri(uri);

    assert.equal(resolvedCount, 2);
    assert.equal(resolvedAgain, 0);
    assert.equal(resolvedA, 1);
    assert.equal(resolvedB, 1);
  });

  test("unregister prevents later resolution", () => {
    let resolved = 0;
    const uri = MockUri.parse("/workspace/test.ts") as never;

    const unregister = externalEditTracker.registerExternalEdit(
      "tool-1",
      uri,
      () => {
        resolved += 1;
      },
    );
    unregister();

    const resolvedCount = externalEditTracker.resolveExternalEditsForUri(uri);
    assert.equal(resolvedCount, 0);
    assert.equal(resolved, 0);
  });
});
