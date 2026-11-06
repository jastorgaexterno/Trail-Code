import { test } from 'node:test';
import assert from 'node:assert/strict';

// The MCP launch command is resolved from PATH at init time; pin it to the npx
// form so these expectations are the same on every machine.
process.env.GRAFT_MCP_NPX = '1';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runHostsInit } from '../src/hosts/init.js';
import { toPosixPath } from '../src/util/paths.js';
import { runCli, tmpRepo } from './helpers.js';

function fresh(): string { return tmpRepo('hostsinit'); }

test('writes only detected hosts by default', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.cursor'));
  const r = runHostsInit(repo, { home });
  assert.deepEqual(r.written.map((w) => w.id), ['cursor']);
  const mdc = readFileSync(join(repo, '.cursor', 'rules', 'graft.mdc'), 'utf8');
  assert.match(mdc, /alwaysApply: true/);
  assert.ok(!existsSync(join(repo, 'AGENTS.md')));
});

test('explicit agents list overrides detection and flags unknown ids', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['gemini', 'nope'] });
  assert.deepEqual(r.written.map((w) => w.id), ['gemini']);
  assert.deepEqual(r.unknown, ['nope']);
  assert.ok(readFileSync(join(repo, 'GEMINI.md'), 'utf8').includes('graft ask'));
});

test('all writes every host and re-run converges (idempotent)', () => {
  const home = fresh(); const repo = fresh();
  const first = runHostsInit(repo, { home, all: true });
  // Ten registry hosts' instruction files, plus the one skill a host owns
  // outside the repo (Hermes reads its skills from the profile directory).
  assert.equal(first.written.length, 11);
  assert.deepEqual(
    first.written.filter((w) => w.path.startsWith(home)).map((w) => w.id),
    ['hermes'],
    'the Hermes skill is the only write outside the repo',
  );
  const second = runHostsInit(repo, { home, all: true });
  assert.ok(second.written.every((w) => w.action === 'unchanged'));
  // `agents` and `antigravity` share AGENTS.md, but the fenced section is written once
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.equal(agents.match(/graft:start/g)!.length, 1);
});

// --- the Hermes skill belongs to the hermes host -------------------------

test('the hermes host installs its skill in the profile dir, from a clean HOME', () => {
  const home = fresh(); const repo = fresh();
  // No ~/.hermes at all: the write is what creates it (mkdir -p).
  const r = runHostsInit(repo, { home, agents: ['hermes'] });
  const skill = join(home, '.hermes', 'skills', 'trail', 'SKILL.md');
  assert.deepEqual(r.written.map((w) => w.path).sort(), [join(repo, 'AGENTS.md'), skill].sort());
  const text = readFileSync(skill, 'utf8');
  assert.match(text, /^name: trail$/m);
  assert.match(text, /^category: devops$/m);
  assert.match(text, /^triggers:$/m);
  // Twice is a no-op, byte for byte.
  assert.equal(runHostsInit(repo, { home, agents: ['hermes'] }).written.at(-1)!.action, 'unchanged');
});

test('selecting any other host writes no skill at all', () => {
  const home = fresh(); const repo = fresh();
  runHostsInit(repo, { home, agents: ['kiro'] });
  assert.ok(existsSync(join(repo, '.kiro', 'steering', 'graft.md')));
  assert.ok(!existsSync(join(home, '.hermes')), 'no Hermes selection, no Hermes skill');
});

test('global: false keeps the hermes skill out of the home dir', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['hermes'], global: false });
  assert.ok(existsSync(join(repo, 'AGENTS.md')), 'the repo file is not a global write');
  assert.ok(!existsSync(join(home, '.hermes')), '--no-global reaches the skill too');
  assert.deepEqual(r.written.map((w) => w.path), [join(repo, 'AGENTS.md')]);
});

test('installing the trail skill removes graft-era skill a Hermes box still has', () => {
  const home = fresh(); const repo = fresh();
  const graftSkill = join(home, '.hermes', 'skills', 'graft', 'SKILL.md');
  mkdirSync(dirname(graftSkill), { recursive: true });
  writeFileSync(graftSkill, 'old\n');
  runHostsInit(repo, { home, agents: ['hermes'], brand: 'trail' });
  assert.ok(existsSync(join(home, '.hermes', 'skills', 'trail', 'SKILL.md')));
  assert.ok(!existsSync(graftSkill), 'graft\'s copy goes');
  assert.ok(!existsSync(dirname(graftSkill)), 'and its empty folder with it');
});

test('preserves user content around the fenced section', () => {
  const home = fresh(); const repo = fresh();
  const target = join(repo, '.github', 'copilot-instructions.md');
  mkdirSync(join(repo, '.github'), { recursive: true });
  writeFileSync(target, '# House rules\n');
  const r = runHostsInit(repo, { home });
  assert.deepEqual(r.written.map((w) => w.id), ['copilot']);
  const text = readFileSync(target, 'utf8');
  assert.ok(text.startsWith('# House rules'));
  assert.ok(text.includes('graft ask'));
});

test('CLI: unknown agent id exits non-zero', () => {
  const repo = fresh();
  assert.throws(() =>
    execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'init', repo, '--no-build', '--agents', 'nope'], {
      encoding: 'utf8', stdio: 'pipe',
    }),
  );
});

test('explicit empty agents list writes nothing, even when home has agent dirs (no fallback to detection)', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.cursor'));
  const r = runHostsInit(repo, { home, agents: [] });
  assert.deepEqual(r.written, []);
  assert.ok(!existsSync(join(repo, '.cursor')));
});

test('CLI: --agents claude with --no-build writes .claude/ but no other-agent files', () => {
  const repo = fresh();
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'init', repo, '--no-build', '--agents', 'claude'], {
    encoding: 'utf8',
  });
  assert.ok(existsSync(join(repo, '.claude')));
  assert.ok(!existsSync(join(repo, 'AGENTS.md')));
  assert.ok(!existsSync(join(repo, 'GEMINI.md')));
  assert.ok(!existsSync(join(repo, '.cursor')));
});

test('CLI: --agents claude gemini nope exits non-zero and leaves repo untouched (validation before writes)', () => {
  const repo = fresh();
  assert.throws(() =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'init', repo, '--no-build', '--agents', 'claude', 'gemini', 'nope'],
      { encoding: 'utf8', stdio: 'pipe' },
    ),
  );
  assert.ok(!existsSync(join(repo, '.claude')));
  assert.ok(!existsSync(join(repo, 'GEMINI.md')));
  assert.ok(!existsSync(join(repo, 'AGENTS.md')));
});

test('runHostsInit registers MCP configs for selected hosts', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['cursor'] });
  assert.equal(r.mcp.length, 1);
  // An absolute filesystem path, so it carries the platform separator — assert the
  // shape, not the platform.
  assert.match(toPosixPath(r.mcp[0].path), /\.cursor\/mcp\.json$/);
  const cfg = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(cfg.mcpServers.graft.command, 'npx');
});

test('mcp: false skips MCP registration', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['cursor'], mcp: false });
  assert.deepEqual(r.mcp, []);
  assert.ok(!existsSync(join(repo, '.cursor', 'mcp.json')));
});

test('hooks: false skips hook installation', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const r = runHostsInit(repo, { home, agents: ['agents'], hooks: false });
  assert.deepEqual(r.hooks, []);
  assert.ok(!existsSync(join(home, '.codex', 'hooks.json')));
});

test('global: false keeps the instruction file but skips every ~ write', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const r = runHostsInit(repo, { home, agents: ['agents'], global: false });

  assert.deepEqual(r.written.map((w) => w.id), ['agents']);
  assert.ok(existsSync(join(repo, 'AGENTS.md')));
  assert.deepEqual(r.hooks, []);
  assert.ok(!existsSync(join(home, '.codex', 'hooks.json')));
  assert.ok(!existsSync(join(home, '.codex', 'config.toml')));
  // The repo-local opencode MCP config is not a global write, so it survives.
  assert.deepEqual(r.mcp.map((m) => m.id), ['opencode']);
  assert.ok(existsSync(join(repo, 'opencode.json')));
});

// --- CLI: choosing what gets written ------------------------------------

/**
 * Run `graft init` with a scratch home so tests never touch the real ~/.codex,
 * and return stderr. The child gets a pipe rather than a TTY, which is exactly
 * the non-interactive path we want to exercise.
 *
 * `runCli`'s `home` sets `USERPROFILE` as well as `HOME` — this used to set only
 * `HOME`, so on Windows the child read the *runner's* profile and reported
 * whichever agents it happened to have installed instead of the fixture's.
 */
function cliStderr(repo: string, home: string, extra: string[] = []): string {
  const res = runCli(['init', repo, '--no-build', ...extra], { home });
  assert.equal(res.status, 0, res.describe());
  return res.stderr ?? '';
}

test('CLI: no flags and no TTY writes nothing and names only the supported agents', () => {
  const home = fresh(); const repo = fresh();
  // Cursor is installed here, but init cannot wire it any more: the help line
  // must not suggest an id the binary rejects.
  mkdirSync(join(home, '.cursor'));
  const out = cliStderr(repo, home);
  assert.match(out, /nothing written/);
  assert.match(out, /detected: claude/);
  assert.doesNotMatch(out, /detected: [^\n]*cursor/);
  assert.doesNotMatch(out, /--agents claude cursor/);
  assert.match(out, /init --yes/);
  assert.deepEqual(readdirSync(repo), []);
});

test('CLI: the graph build is attempted even when claude is not selected', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.cursor'));
  // Regression: the build used to sit inside `if (wantClaude)`, so picking only
  // another agent wired its files and never built the graph they point at.
  const out = cliStderr(repo, home, ['--agents', 'hermes']);
  assert.match(out, /(built the graph|graph built|skipped graph build|skipped the graph build)/);
});

test('CLI: --dry-run respects an explicit --agents list', () => {
  const home = fresh(); const repo = fresh();
  const out = cliStderr(repo, home, ['--agents', 'hermes', '--dry-run']);
  // Hermes' two files, and nothing of Claude Code's (not selected).
  assert.ok(out.includes('AGENTS.md'), out);
  assert.ok(out.includes(join('.hermes', 'skills', 'trail', 'SKILL.md')), out);
  assert.ok(!out.includes(join('.claude', 'skills')), out);
  assert.match(out, /affects ALL repos/);
});
