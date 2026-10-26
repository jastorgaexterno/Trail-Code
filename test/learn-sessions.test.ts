/**
 * Setup's session read: both sides of a past conversation become a digest
 * (what the person said, Claude's replies, answers, plans, commits), tool
 * output never; what Claude finds in it is kept only when its quotes are
 * really there, and saved as the team's learnings with a plain title.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginSessionRead, finishSessionRead, sessionLines, sessionsDigest, type SessionRead, type SessionResult } from "../src/learn/sessions.js";
import { ensureRepoHome } from "../src/notes/home.js";
import { tmpRepo } from "./helpers.js";
import type { PastSession } from "../src/init/sessions.js";

const row = (o: object) => JSON.stringify(o);
const user = (content: unknown, extra: object = {}) => row({ type: "user", timestamp: "2026-10-20T10:00:00Z", message: { role: "user", content }, ...extra });
const said = (content: unknown[]) => row({ type: "assistant", timestamp: "2026-10-20T10:01:00Z", message: { role: "assistant", content } });

function fixture(dir: string): string {
  const path = join(dir, "s.jsonl");
  const lines = [
    user("<system-reminder>ignore me</system-reminder>"),
    user("make the deck page load faster"),
    said([{ type: "text", text: "I looked at the page: the sample deck render takes most of the time, about four seconds on every load." }]),
    said([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run build" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "BUILD OUTPUT ".repeat(800) }]),
    said([{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which one?" }] } }]),
    user([{ type: "tool_result", tool_use_id: "q1", content: "Second" }]),
    user("no, drop the sample deck entirely, show what Trail learned about the site instead"),
    said([{ type: "tool_use", id: "t2", name: "Bash", input: { command: 'git commit -m "Drop the sample deck step"' } }]),
    said([{ type: "text", text: "Done: the sample deck step is gone and the brand profile shows as the read lands." }]),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

test("sessionLines reads both sides of the conversation and never tool output", () => {
  const lines = sessionLines(fixture(mkdtempSync(join(tmpdir(), "sl-"))));
  assert.deepEqual(lines, [
    "[person] make the deck page load faster",
    "[claude] I looked at the page: the sample deck render takes most of the time, about four seconds on every load.",
    "[answered] Which one? -> Second",
    "[person] no, drop the sample deck entirely, show what Trail learned about the site instead",
    '[ran] git commit -m "Drop the sample deck step"',
    "[claude] Done: the sample deck step is gone and the brand profile shows as the read lands.",
  ]);
  assert.ok(!lines.join("\n").includes("BUILD OUTPUT"));
});

test("sessionLines reads only the session's stretch", () => {
  const path = fixture(mkdtempSync(join(tmpdir(), "sl-")));
  const text = readFileSync(path, "utf8");
  const from = text.indexOf(user("no, drop the sample deck entirely, show what Trail learned about the site instead"));
  const lines = sessionLines(path, { from, to: text.length });
  assert.equal(lines[0], "[person] no, drop the sample deck entirely, show what Trail learned about the site instead");
  assert.ok(!lines.some((l) => l.includes("load faster")));
});

test("a routine reply is clipped; the one before the person's correction and the last one stay whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-"));
  const path = join(dir, "s.jsonl");
  const long = (w: string) => `${w} `.repeat(120).trim();
  writeFileSync(
    path,
    [user("start"), said([{ type: "text", text: long("routine") }]), said([{ type: "text", text: long("context") }]), user("no, do it the other way"), said([{ type: "text", text: long("final") }])].join("\n") + "\n",
  );
  const lines = sessionLines(path);
  const routine = lines.find((l) => l.startsWith("[claude] routine"))!;
  const context = lines.find((l) => l.startsWith("[claude] context"))!;
  const final = lines.find((l) => l.startsWith("[claude] final"))!;
  assert.ok(routine.length < 300, "a routine reply is clipped");
  assert.ok(context.length > 600, "the reply the person answered stays");
  assert.ok(final.length > 600, "the session's last reply stays");
  assert.ok(sessionLines(path, undefined, { full: true }).find((l) => l.startsWith("[claude] routine"))!.length > 600, "full mode keeps every reply");
});

test("sessionsDigest scrubs secrets, heads each session and stops at maxChars", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-"));
  const path = join(dir, "s.jsonl");
  writeFileSync(path, [user(`use this token ghp_${"a".repeat(36)} for the deploy and keep the deploy job on main`), said([{ type: "text", text: "Keeping the deploy job on main, as the release flow needs it." }])].join("\n") + "\n");
  const s: PastSession = { id: "abcdef12-3456", at: "2026-10-20T10:00:00Z", prompts: [], path, branch: "main" };
  const d = sessionsDigest([s], 10_000);
  assert.match(d.text, /^=== session abcdef12 \(2026-10-20, branch main\)\n/);
  assert.ok(!d.text.includes("ghp_aaaa"));
  assert.deepEqual(d.read, ["abcdef12"]);
  assert.equal(d.sources[0]!.id, "abcdef12");
  assert.ok(sessionsDigest([s, { ...s, id: "99999999-0000" }], 60).text.length <= 60 || sessionsDigest([s, { ...s, id: "99999999-0000" }], 60).read.length === 1);
});

test("a big transcript is read in pieces, not loaded whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "big-"));
  const path = join(dir, "big.jsonl");
  const fd = openSync(path, "w");
  const filler = user([{ type: "tool_result", tool_use_id: "x", content: "y".repeat(100_000) }]) + "\n";
  for (let i = 0; i < 300; i++) writeSync(fd, filler);
  writeSync(fd, user("keep the release branch protected") + "\n");
  closeSync(fd);
  const before = process.memoryUsage().rss;
  const lines = sessionLines(path);
  assert.deepEqual(lines, ["[person] keep the release branch protected"]);
  assert.ok(process.memoryUsage().rss - before < 100 * 1024 * 1024, "memory stays well under the file's 30 MB times a few");
});

function readWith(findings: SessionResult["findings"]): SessionRead {
  const result: SessionResult = { sessions: 3, read: 3, findings, durationMs: 10, model: "claude-sonnet-5-5", newest: "2026-10-20T10:00:00Z" };
  return { started: Date.now(), done: true, result: Promise.resolve(result) };
}

test("finishSessionRead saves each learning with its plain title, and the repo isn't read again", async () => {
  const env = { TRAIL_HOME: process.env.TRAIL_HOME, DO_NOT_TRACK: process.env.DO_NOT_TRACK };
  process.env.TRAIL_HOME = join(mkdtempSync(join(tmpdir(), "sess-home-")), ".trail");
  process.env.DO_NOT_TRACK = "1";
  try {
    const repo = tmpRepo("sess-save");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const { saved } = await finishSessionRead(
      repo,
      readWith([{ headline: "Sign-up comes first, before any onboarding screen", why: "The owner reversed a read-first build.", forAgent: "Every /start page sends signed-out people to sign up.", kind: "decided", sources: ["abcdef12"], quotes: ["signup should be done as the first thing"], last: "2026-10-20" }]),
    );
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.title, "Sign-up comes first, before any onboarding screen");
    assert.equal(saved[0]!.scope, "repo");
    assert.match(saved[0]!.body, /^## Decided\n- The owner reversed a read-first build\.\n- In the code: Every \/start page sends signed-out people to sign up\.\n\n_From past Claude sessions here, /);
    assert.equal(saved[0]!.src, "init-sessions");
    assert.ok(existsSync(join(ensureRepoHome(repo).place.dir, "session-learnings.json")));
    assert.equal(beginSessionRead(repo, { ...process.env }), null, "read once per repo");
  } finally {
    process.env.TRAIL_HOME = env.TRAIL_HOME;
    process.env.DO_NOT_TRACK = env.DO_NOT_TRACK;
  }
});

test("TRAIL_NO_FETCH turns the session read off", () => {
  const repo = tmpRepo("sess-off");
  mkdirSync(join(repo, ".git"), { recursive: true });
  assert.equal(beginSessionRead(repo, { ...process.env, TRAIL_NO_FETCH: "1" }), null);
});
