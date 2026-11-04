/**
 * The agent skills trail generates (Claude Code's and Hermes's).
 *
 * A skill that documents a command the binary no longer has is worse than no skill:
 * the agent runs it and fails with total confidence. These tests pin the opposite
 * property — every section describes the code map, and nothing names a layer or
 * command the amputation removed — plus the two behaviours an agent has to know to
 * use the map well: worktrees need no setup, and a large drift answers stale.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { skillTemplate } from "../src/claude/skill-template.js";
import { hermesSkillTemplate } from "../src/claude/hermes-skill-template.js";

/** Commands and layers the CLI no longer has (openspec change trail-solo-grafo). */
const BANNED = /trail note|trail check|trail team|trail skills|knowledge-repo|learnings?|hook\.cjs|\bcloud\b/i;

test("skill template is a well-formed SKILL.md", () => {
  const src = skillTemplate();
  assert.ok(src.startsWith("---\n"), "starts with YAML frontmatter");
  assert.match(src, /^name: graft$/m, "declares name: graft");
  assert.match(src, /^description:/m, "has a description");
  const body = src.split(/\n---\n/)[1] ?? "";
  assert.ok(body.trim().length > 0, "has a non-empty body");
  assert.match(body, /graft ask/, "body tells the agent to use `graft ask`");
  assert.match(body, /every occurrence/i, "body teaches the exhaustive-task grep rule");
  assert.match(body, /graft callers/, "body teaches the callers command");
  assert.match(body, /--direction out/, "body teaches callees via --direction out");
  assert.match(body, /--depth/, "body teaches blast radius via --depth");
  assert.match(body, /truncated/i, "body tells the agent to follow up on truncated spans");
  assert.match(body, /graft grep/, "body routes sweeps to graft grep");
  assert.match(body, /graft map/, "body tells the agent to orient with graft map before exploring");
  assert.match(body, /\[scope\/\]/, "body teaches the [scope/] label on multi-scope hits");
  assert.match(body, /--in <scope>\//, "body teaches narrowing with ask --in <scope>/");
  assert.match(body, /tokens saved/i, "body references the tokens-saved footer");
  assert.match(body, /every turn/i, "body tells the agent to report savings each turn");
});

test("the trail skill names no command or tool that does not exist", () => {
  const src = skillTemplate("trail");
  assert.match(src, /^name: trail$/m);
  assert.doesNotMatch(src, BANNED, "no removed command, layer or file is named");

  // Every trail_* tool it mentions must be one of the nine the server exposes.
  const tools = [...src.matchAll(/\btrail_[a-z_]+/g)].map((m) => m[0]);
  assert.ok(tools.length >= 9, "the skill documents the MCP surface");
  for (const t of tools) {
    assert.match(
      t,
      /^trail_(set_scope|find_code|file_api|check_freshness|build|trace_calls|find_all|repo_map|search_semantic)$/,
      `${t} must be a real tool`,
    );
  }
  // The freshness gate is `build --check`: the standalone `check` command is gone.
  assert.match(src, /build --check/, "the CI freshness gate is spelled correctly");
});

test("both skills tell the agent how worktrees and the drift refresh behave", () => {
  for (const [label, src] of [
    ["claude trail", skillTemplate("trail")],
    ["claude graft", skillTemplate("graft")],
    ["hermes trail", hermesSkillTemplate("trail")],
  ] as const) {
    assert.match(src, /worktree/i, `${label}: worktrees are explained`);
    assert.match(src, /50\b/, `${label}: the inline bound is stated`);
    assert.match(src, /\[stale:/, `${label}: the stale warning is quoted, so the agent recognises it`);
  }
});

test("the hermes skill has the frontmatter Hermes needs", () => {
  const src = hermesSkillTemplate("trail");
  assert.ok(src.startsWith("---\n"));
  for (const key of ["name: trail", "description:", "category: devops", "triggers:"]) {
    assert.ok(src.includes(key), key);
  }
  assert.doesNotMatch(src, BANNED);
});
