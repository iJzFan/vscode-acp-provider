import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { ScannedSkill } from "./types";

const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;
const NAME_RE = /^name:\s*(.+)$/m;
const DESC_RE = /^description:\s*(.+)$/m;

function expandPath(p: string): string {
  let resolved = p;
  if (resolved.startsWith("~")) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }
  if (!path.isAbsolute(resolved)) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      resolved = path.join(root, resolved);
    }
  }
  return resolved;
}

function parseFrontmatter(
  content: string,
): { name?: string; description?: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return {};
  }

  const yaml = match[1];
  const name = yaml.match(NAME_RE)?.[1]?.trim();
  const description = yaml.match(DESC_RE)?.[1]?.trim();

  return { name, description };
}

export function scanSkillDirectories(
  paths: readonly string[],
): ScannedSkill[] {
  if (!paths.length) {
    return [];
  }

  const results: ScannedSkill[] = [];
  const seen = new Set<string>();

  for (const rawPath of paths) {
    const resolved = expandPath(rawPath);
    if (!fs.existsSync(resolved)) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (!SKILL_NAME_REGEX.test(entry.name)) {
        continue;
      }

      const skillDir = path.join(resolved, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) {
        continue;
      }

      try {
        const content = fs.readFileSync(skillFile, "utf-8");
        const { name, description } = parseFrontmatter(content);

        if (name && description && name === entry.name && !seen.has(name)) {
          seen.add(name);
          results.push({ name, description, directory: skillDir });
        }
      } catch {
        // skip unreadable skill files
      }
    }
  }

  return results;
}
