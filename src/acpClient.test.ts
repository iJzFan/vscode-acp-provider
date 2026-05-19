import assert from "node:assert/strict";
import Module from "node:module";
import { suite, setup, teardown, test } from "mocha";

type FileWriteCoordinatorModule = typeof import("./fileWriteCoordinator");
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
    return new MockUri("file", fsPath);
  }

  static parse(value: string): MockUri {
    return new MockUri("file", value);
  }
}

class MockPosition {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

class MockRange {
  constructor(
    readonly start: MockPosition,
    readonly end: MockPosition,
  ) {}
}

class MockWorkspaceEdit {
  readonly replacements: Array<{
    uri: MockUri;
    range: MockRange;
    text: string;
  }> = [];

  replace(uri: MockUri, range: MockRange, text: string): void {
    this.replacements.push({ uri, range, text });
  }
}

type MockDocument = {
  uri: MockUri;
  isDirty: boolean;
  saveCount: number;
  getText: () => string;
  positionAt: (offset: number) => MockPosition;
  save: () => Promise<boolean>;
  setText: (value: string) => void;
};

const writeCalls: { uri: MockUri; bytes: Uint8Array }[] = [];
const applyEditCalls: MockWorkspaceEdit[] = [];
const mockFs = {
  writeFile: async (uri: MockUri, bytes: Uint8Array) => {
    writeCalls.push({ uri, bytes });
  },
  readFile: async () => new Uint8Array(),
};

const mockDocuments: MockDocument[] = [];

function createMockDocument(
  fsPath: string,
  text: string,
  isDirty = false,
): MockDocument {
  let currentText = text;
  const document: MockDocument = {
    uri: MockUri.file(fsPath),
    isDirty,
    saveCount: 0,
    getText: () => currentText,
    positionAt: (offset: number) => {
      const before = currentText.slice(0, offset);
      const lines = before.split("\n");
      return new MockPosition(
        Math.max(0, lines.length - 1),
        lines[lines.length - 1]?.length ?? 0,
      );
    },
    save: async () => {
      document.saveCount += 1;
      document.isDirty = false;
      writeCalls.push({
        uri: document.uri,
        bytes: new TextEncoder().encode(currentText),
      });
      return true;
    },
    setText: (value: string) => {
      currentText = value;
    },
  };
  return document;
}

function clearAcpClientModules(): void {
  for (const moduleId of [
    "./fileWriteCoordinator",
  ]) {
    try {
      delete require.cache[require.resolve(moduleId)];
    } catch {
      // ignore
    }
  }
}

setup(() => {
  writeCalls.length = 0;
  applyEditCalls.length = 0;
  mockDocuments.length = 0;

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

  clearAcpClientModules();

  const coordinator = require("./fileWriteCoordinator") as FileWriteCoordinatorModule;
  coordinator.setWriteCoordinatorVscodeForTesting({
    Uri: MockUri,
    workspace: {
      fs: mockFs,
      textDocuments: mockDocuments,
      applyEdit: async (edit: MockWorkspaceEdit) => {
        applyEditCalls.push(edit);
        for (const replacement of edit.replacements) {
          const document = mockDocuments.find(
            (entry) => entry.uri.toString() === replacement.uri.toString(),
          );
          if (!document) {
            return false;
          }
          document.setText(replacement.text);
          document.isDirty = true;
        }
        return true;
      },
    },
    Position: MockPosition,
    Range: MockRange,
    WorkspaceEdit: MockWorkspaceEdit,
  } as any);
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
  const coordinator = require("./fileWriteCoordinator") as FileWriteCoordinatorModule;
  coordinator.setWriteCoordinatorVscodeForTesting(undefined);
  clearAcpClientModules();
});

suite("fileWriteCoordinator", () => {
  test("updates open clean documents through workspace edits and save", async () => {
    const coordinator = require("./fileWriteCoordinator") as FileWriteCoordinatorModule;

    const document = createMockDocument(
      "/workspace/test.ts",
      "export const value = 1;",
    );
    mockDocuments.push(document);

    const mockLogger = {
      info: () => {},
      warn: () => {},
    };

    await coordinator.writeTextFileWithCoordinator(
      MockUri.parse("/workspace/test.ts") as any,
      "export const value = 2;",
      { logChannel: mockLogger, logPrefix: "[test]" },
    );

    assert.equal(applyEditCalls.length, 1);
    assert.equal(writeCalls.length, 1);
    assert.equal(writeCalls[0].uri.fsPath, "/workspace/test.ts");
    assert.equal(new TextDecoder().decode(writeCalls[0].bytes), "export const value = 2;");
    assert.equal(document.getText(), "export const value = 2;");
    assert.equal(document.saveCount, 1);
    assert.equal(document.isDirty, false);
  });

  test("overwrites dirty open documents through the shared coordinator", async () => {
    const coordinator = require("./fileWriteCoordinator") as FileWriteCoordinatorModule;

    const document = createMockDocument(
      "/workspace/test.ts",
      "export const local = 'draft';",
      true,
    );
    mockDocuments.push(document);

    const mockLogger = {
      info: () => {},
      warn: () => {},
    };

    await coordinator.writeTextFileWithCoordinator(
      MockUri.parse("/workspace/test.ts") as any,
      "export const agent = 'wins';",
      { logChannel: mockLogger, logPrefix: "[test]" },
    );

    assert.equal(applyEditCalls.length, 1);
    assert.equal(writeCalls.length, 1);
    assert.equal(document.getText(), "export const agent = 'wins';");
    assert.equal(document.saveCount, 1);
    assert.equal(document.isDirty, false);
  });

  test("multiple writes to the same URI execute in order", async () => {
    const coordinator = require("./fileWriteCoordinator") as FileWriteCoordinatorModule;

    const uri = "/workspace/test.ts";
    await Promise.all([
      coordinator.writeTextFileWithCoordinator(MockUri.parse(uri) as any, "first"),
      coordinator.writeTextFileWithCoordinator(MockUri.parse(uri) as any, "second"),
      coordinator.writeTextFileWithCoordinator(MockUri.parse(uri) as any, "third"),
    ]);

    assert.equal(writeCalls.length, 3);
    assert.equal(new TextDecoder().decode(writeCalls[0].bytes), "first");
    assert.equal(new TextDecoder().decode(writeCalls[1].bytes), "second");
    assert.equal(new TextDecoder().decode(writeCalls[2].bytes), "third");
  });

  test("writes to different URIs are independent", async () => {
    const coordinator = require("./fileWriteCoordinator") as FileWriteCoordinatorModule;

    await Promise.all([
      coordinator.writeTextFileWithCoordinator(MockUri.parse("/workspace/a.ts") as any, "content-a"),
      coordinator.writeTextFileWithCoordinator(MockUri.parse("/workspace/b.ts") as any, "content-b"),
    ]);

    assert.equal(writeCalls.length, 2);
    const writtenFiles = writeCalls.map((c) => c.uri.fsPath).sort();
    assert.deepEqual(writtenFiles, ["/workspace/a.ts", "/workspace/b.ts"]);
  });
});
