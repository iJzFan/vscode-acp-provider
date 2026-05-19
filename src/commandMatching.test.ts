import assert from "node:assert/strict";
import { suite, test } from "mocha";
import {
  buildAvailableCommandLogSummary,
  buildSlashCommandFilterText,
  formatCommandSourceBadge,
  formatSlashCommandLabel,
  getShortCommandName,
  getSlashCommandMatchScore,
  normalizeSlashCommandQuery,
  toManualSurfacedCommand,
} from "./commandMatching";

suite("commandMatching", () => {
  test("extracts the short command name from namespaced commands", () => {
    assert.equal(
      getShortCommandName("oma--oh-my-auggie:oma-plan"),
      "oma-plan",
    );
    assert.equal(getShortCommandName("opencode:review-pr"), "review-pr");
    assert.equal(getShortCommandName("plain-command"), "plain-command");
  });

  test("normalizes slash-prefixed queries", () => {
    assert.equal(normalizeSlashCommandQuery("/oma-plan"), "oma-plan");
    assert.equal(normalizeSlashCommandQuery("  //opencode:fix  "), "opencode:fix");
  });

  test("prefers short-name matches for namespaced commands", () => {
    const commandName = "oma--oh-my-auggie:oma-plan";

    assert.ok(
      getSlashCommandMatchScore(commandName, "oma-plan") >
        getSlashCommandMatchScore(commandName, "auggie"),
    );
    assert.ok(getSlashCommandMatchScore(commandName, "oma") > 0);
    assert.equal(getSlashCommandMatchScore(commandName, "totally-unrelated"), 0);
  });

  test("builds readable labels and filter text", () => {
    assert.equal(
      formatSlashCommandLabel("oma--oh-my-auggie:oma-plan"),
      "/oma-plan ↦ /oma--oh-my-auggie:oma-plan",
    );
    assert.equal(formatSlashCommandLabel("plain-command"), "/plain-command");
    assert.equal(
      buildSlashCommandFilterText("oma--oh-my-auggie:oma-plan"),
      "/oma--oh-my-auggie:oma-plan /oma-plan",
    );
  });

  test("summarizes available commands for logging", () => {
    assert.equal(
      buildAvailableCommandLogSummary(
        [
          { name: "oma--oh-my-auggie:oma-plan", source: "acp" },
          { name: "opencode:review-pr", source: "manual" },
          { name: "plain-command", source: "acp" },
        ],
        2,
      ),
      "/oma-plan ↦ /oma--oh-my-auggie:oma-plan [ACP], /review-pr ↦ /opencode:review-pr [manual] (+1 more)",
    );
  });

  test("formats source badges and manual surfaced commands", () => {
    assert.equal(formatCommandSourceBadge("acp"), "[ACP]");
    assert.equal(formatCommandSourceBadge("manual"), "[manual]");
    assert.deepEqual(
      toManualSurfacedCommand({
        name: "opencode:review-pr",
        description: "Review a PR",
        input: { hint: "[scope]" },
      }),
      {
        name: "opencode:review-pr",
        description: "Review a PR",
        input: { hint: "[scope]" },
        source: "manual",
      },
    );
  });
});
