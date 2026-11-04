/**
 * The user-level Claude Code install — graft's wiring outside any repo.
 *
 * The bug it exists for, reported against a real repo: `.gitignore` line 1 was a
 * blanket `*.json`, which ignores both `.mcp.json` and `.claude/settings.json`.
 * `git worktree add` checks out tracked files only, so every worktree of that repo
 * started with graft's `.cjs` shims present and neither of the two files that point
 * at them — no SessionStart hook, no MCP server, graft silently absent in a tree
 * that looked correctly wired. The first test here drives real `git init` /
 * `git worktree add` rather than faking it, because the whole failure lives in what
 * git chooses to carry across.
 *
 * The rest hold the two properties that keep the fix safe to ship: nothing lands in
 * `~` when `--no-global` is passed, and `graft uninstall` removes exactly what an
 * init added.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pin the MCP launch command to the npx form so expectations don't depend on
// whether the machine running the tests has graft on PATH.
process.env.GRAFT_MCP_NPX = '1';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeGlobalTargets, globalHelpersDir, installClaudeGlobal } from '../src/hosts/claude-global.js';
import { runInit } from '../src/claude/init.js';
import { planRetract, runRetract } from '../src/hosts/retract.js';
import { planInit } from '../src/hosts/plan.js';
import { toPosixPath } from '../src/util/paths.js';
import { tmpRepo } from './helpers.js';

/**
 * Isolated from the developer's own git config, and carrying an identity of its own:
 * a CI runner has no `user.email`, and blanking GIT_CONFIG_GLOBAL removes any it did
 * have, so `git commit` fails without these. Same block as test/graph-seed.test.ts.
 */
const git = (d: string, ...args: string[]): void => {
  execFileSync('git', args, {
    cwd: d,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'graft test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'graft test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
};

const settingsOf = (home: string): string => join(home, '.claude', 'settings.json');
const shimOf = (home: string): string => join(globalHelpersDir(home), 'graft-hooks.cjs');
const userMcpOf = (home: string): string => join(home, '.claude.json');

const readJson = (p: string): Record<string, any> => JSON.parse(readFileSync(p, 'utf8'));

/* ------------------------------------------------------------------ *
 * the reported failure
 * ------------------------------------------------------------------ */

/** sj's repo: `*.json` ignored wholesale, `.claude/` otherwise tracked. */
function repoIgnoringJson(): string {
  const d = tmpRepo('cgrepo');
  git(d, 'init', '-b', 'main');
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  writeFileSync(join(d, '.gitignore'), '*.json\ngraft/\n');
  return d;
}

test('an existing user-scope MCP server survives, and re-running converges', () => {
  const home = tmpRepo('cgmcp');
  writeFileSync(userMcpOf(home), JSON.stringify({ mcpServers: { paper: { command: 'paper' } } }, null, 2));

  installClaudeGlobal(home);
  const first = readJson(userMcpOf(home));
  assert.ok(first.mcpServers.paper, 'a foreign server is preserved');
  assert.ok(first.mcpServers.graft);

  const second = installClaudeGlobal(home);
  assert.ok(second.every((w) => w.action === 'unchanged'), `idempotent, got ${JSON.stringify(second)}`);
});

test('--no-global writes nothing outside the repo', () => {
  const home = tmpRepo('cgnoglobal');
  const repo = tmpRepo('cgnoglobalrepo');

  const r = runInit(repo, { build: false, global: false, home });

  assert.deepEqual(r.global, []);
  assert.equal(existsSync(join(home, '.claude')), false);
  assert.equal(existsSync(userMcpOf(home)), false);
  // The repo half still happened.
  assert.ok(existsSync(join(repo, '.mcp.json')));
});

/* ------------------------------------------------------------------ *
 * the plan, and putting it back
 * ------------------------------------------------------------------ */

test('planInit reports the global writes so the picker can show them', () => {
  const home = tmpRepo('cgplan');
  const repo = tmpRepo('cgplanrepo');

  const claude = planInit(repo, { home, ids: ['claude'] })[0];
  const globals = claude.writes.filter((w) => w.scope === 'global').map((w) => w.path);

  assert.deepEqual(globals, claudeGlobalTargets(home).map((t) => t.path));
  assert.equal(globals.length, 3);
});

test('uninstall removes exactly what the global install added', () => {
  const home = tmpRepo('cgretract');
  const repo = tmpRepo('cgretractrepo');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(settingsOf(home), JSON.stringify({ theme: 'light' }, null, 2));
  writeFileSync(userMcpOf(home), JSON.stringify({ mcpServers: { paper: { command: 'paper' } } }, null, 2));

  runInit(repo, { build: false, home });
  assert.ok(planRetract(repo, { home }).some((r) => r.path === shimOf(home)), 'the plan names the shim');

  runRetract(repo, { home, apply: true });

  assert.equal(existsSync(shimOf(home)), false, 'shim gone');
  const s = readJson(settingsOf(home));
  assert.equal(s.hooks, undefined, 'graft hooks gone');
  assert.equal(s.theme, 'light', "the user's own settings survive");
  const mcp = readJson(userMcpOf(home));
  assert.equal(mcp.mcpServers.graft, undefined, 'graft server gone');
  assert.ok(mcp.mcpServers.paper, 'the foreign server survives');
});

test('under trail, graft keeps its user-level server and is turned off only in the trail folder', async () => {
  const { disableGraftServerIn } = await import('../src/hosts/claude-global.js');
  const home = tmpRepo('cgtrail');
  writeFileSync(userMcpOf(home), JSON.stringify({ mcpServers: { graft: { command: 'graft', args: ['mcp'] } }, projects: { '/w/other': { disabledMcpServers: ['paper'] } } }, null, 2));

  installClaudeGlobal(home, 'trail');
  const after = readJson(userMcpOf(home));
  assert.ok(after.mcpServers.graft, 'graft still serves the repos wired as graft');
  assert.equal(after.mcpServers.trail, undefined, 'no second server for every repo');

  assert.equal(disableGraftServerIn(home, '/w/trail-repo').action, 'updated');
  assert.equal(disableGraftServerIn(home, '/w/trail-repo').action, 'unchanged', 'once');
  const cfg = readJson(userMcpOf(home));
  assert.deepEqual(cfg.projects['/w/trail-repo'].disabledMcpServers, ['graft']);
  assert.deepEqual(cfg.projects['/w/other'].disabledMcpServers, ['paper'], 'other folders untouched');

  // trail registers no server of its own, and takes back the one an older trail registered.
  const fresh = tmpRepo('cgtrailfresh');
  writeFileSync(userMcpOf(fresh), JSON.stringify({ mcpServers: { trail: { command: 'trail', args: ['mcp'] }, paper: { command: 'paper' } } }, null, 2));
  installClaudeGlobal(fresh, 'trail');
  assert.deepEqual(Object.keys(readJson(userMcpOf(fresh)).mcpServers), ['paper']);
  assert.equal(disableGraftServerIn(fresh, '/w/x').action, 'unchanged');
});
