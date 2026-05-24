import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { parseAuggieCommandHelpOutput } from "./auggieCommandParser";

suite("manualCommandImport", () => {
  test("parses Auggie command help output into manual commands", () => {
    const commands =
      parseAuggieCommandHelpOutput(`Usage: auggie command|commands [options] [command]

Commands:
  list|ls                                   List all available custom commands
  oma--oh-my-auggie:oma-plan [args...]      Strategic planning with analyst/architect review
  diagnose [args...]                        Disciplined diagnosis loop for hard bugs
  help [command]                            display help for command

Options:
  -h, --help                                display help for command
`);

    assert.deepEqual(commands, [
      {
        name: "oma--oh-my-auggie:oma-plan",
        description: "Strategic planning with analyst/architect review",
        input: { hint: "[args]" },
      },
      {
        name: "diagnose",
        description: "Disciplined diagnosis loop for hard bugs",
        input: { hint: "[args]" },
      },
    ]);
  });

  test("merges wrapped descriptions", () => {
    const commands = parseAuggieCommandHelpOutput(`Commands:
  oma--oh-my-auggie:oma-autopilot [args...] Full autonomous execution — expand requirements,
                                            plan, implement in parallel, QA
Positionals:
  command                                   command to inspect
`);

    assert.deepEqual(commands, [
      {
        name: "oma--oh-my-auggie:oma-autopilot",
        description:
          "Full autonomous execution — expand requirements, plan, implement in parallel, QA",
        input: { hint: "[args]" },
      },
    ]);
  });
});
