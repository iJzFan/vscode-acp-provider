import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { buildStructuredCommandPrompt } from "./chatCommandSerialization";

suite("chatCommandSerialization", () => {
  test("serializes an explicit command with prompt args", () => {
    assert.equal(
      buildStructuredCommandPrompt({
        command: "oma:setup",
        prompt: "Do repo setup",
      }),
      [
        "<command-message>/oma:setup</command-message>",
        "<command-name>oma:setup</command-name>",
        "<command-args>Do repo setup</command-args>",
      ].join("\n"),
    );
  });

  test("serializes a slash-prefixed prompt when it matches a known command", () => {
    assert.equal(
      buildStructuredCommandPrompt({
        prompt: "/oma:setup Do repo setup",
        knownCommands: ["oma:setup", "oma:plan"],
      }),
      [
        "<command-message>/oma:setup</command-message>",
        "<command-name>oma:setup</command-name>",
        "<command-args>Do repo setup</command-args>",
      ].join("\n"),
    );
  });

  test("does not serialize unknown slash prompts", () => {
    assert.equal(
      buildStructuredCommandPrompt({
        prompt: "/not-a-known-command test",
        knownCommands: ["oma:setup"],
      }),
      undefined,
    );
  });

  test("escapes XML-sensitive characters in args", () => {
    assert.equal(
      buildStructuredCommandPrompt({
        command: "oma:setup",
        prompt: "Use <repo> & verify",
      }),
      [
        "<command-message>/oma:setup</command-message>",
        "<command-name>oma:setup</command-name>",
        "<command-args>Use &lt;repo&gt; &amp; verify</command-args>",
      ].join("\n"),
    );
  });
});
