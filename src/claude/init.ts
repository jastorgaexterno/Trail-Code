import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, rmdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { disableGraftServerIn, installClaudeGlobal, type GlobalWrite } from '../hosts/claude-global.js';
import { mergeGraftSettings, mergeTrailShared, mergeTrailLocal } from './settings-merge.js';
import { skillTemplate } from './skill-template.js';
import { hermesSkillTemplate } from './hermes-skill-template.js';
import { mergeJsonKey, serverEntry, type McpWrite } from '../hosts/mcp-config.js';
import { readJsonObject } from '../hosts/config-write.js';
import { hasGraftIndex } from '../graph/root.js';
import type { PlannedWrite } from '../hosts/plan.js';
import { repoWiredForTrail, type Brand } from '../brand.js';

/** trail's committed hook path (kept for retract/upkeep references). */
export const TRAIL_HOOK = join('.trail', 'hook.cjs');
/** The status line's shim path (kept for retract/upkeep references). */
export const TRAIL_STATUSLINE = join('.trail', 'statusline.cjs');
/** Where trail's skill goes: the user's own `~/.claude`, never the repo. */
export function trailSkillPath(home: string = homedir()): string {
  return join(home, '.claude', 'skills', 'trail', 'SKILL.md');
}

/**
 * Where trail's Hermes skill goes: the user's Hermes profile skills directory.
 * On Windows: %LOCALAPPDATA%/hermes/skills/trail/SKILL.md
 * On Linux/macOS: ~/.hermes/skills/trail/SKILL.md
 */
export function hermesSkillPath(home: string = homedir()): string {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return join(local, 'hermes', 'skills', 'trail', 'SKILL.md');
  }
  return join(home, '.hermes', 'skills', 'trail', 'SKILL.md');
}

/** Whether the Hermes skills directory exists on this machine. */
export function hermesInstalled(home: string = homedir()): boolean {
  const dir = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'hermes', 'skills')
    : join(home, '.hermes', 'skills');
  return existsSync(dir);
}

/** Write `entry` into `.trail/.gitignore` to keep the cache out of git. */
function ignoreInTrailDir(root: string, entry: string): void {
  const trailDir = join(root, '.trail');
  mkdirSync(trailDir, { recursive: true });
  const giPath = join(trailDir, '.gitignore');
  let current = '';
  try { current = readFileSync(giPath, 'utf8'); } catch { /* new file */ }
  if (!current.split('\n').some(l => l.trim() === entry.trim())) {
    writeFileSync(giPath, current ? `${current.trimEnd()}\n${entry}\n` : `${entry}\n`);
  }
}

/**
 * The files `runInit` writes — pure, no writes, so `--dry-run` and the picker
 * can report them up front.
 */
export function claudeTargets(dir: string, initBrand?: Brand, home?: string): PlannedWrite[] {
  return claudeTargetsFor(dir, wiringName(dir, initBrand), home);
}

/**
 * The name the Claude Code wiring goes by in `dir`.
 */
export function wiringName(dir: string, initBrand?: Brand): Brand {
  return initBrand === 'trail' || repoWiredForTrail(dir) ? 'trail' : 'graft';
}

/**
 * `claudeTargets` under one name.
 * trail-solo-grafo: hook.cjs and settings.json writing removed; kept for retract/plan compatibility.
 */
export function claudeTargetsFor(dir: string, name: Brand, home: string = homedir()): PlannedWrite[] {
  if (name !== 'trail') return legacyClaudeTargets(dir, name);
  const t = (path: string, what: string): PlannedWrite => ({ hostId: 'claude', id: 'claude', path, scope: 'repo', kind: 'claude', what });
  return [
    t(join(dir, '.claude', 'settings.json'), 'trail SessionStart hook, shared'),
    t(join(dir, TRAIL_HOOK), 'hooks shim, shared'),
    t(join(dir, '.claude', 'settings.local.json'), 'trail statusline + allowlist, yours'),
    t(join(dir, TRAIL_STATUSLINE), 'statusline shim, git-ignored'),
    { hostId: 'claude', id: 'claude', path: trailSkillPath(home), scope: 'global', kind: 'claude', what: 'trail skill' },
  ];
}

/**
 * The layout every graft repo has: shims in `.claude/helpers/`, the skill in `.claude/skills/`.
 */
export function legacyClaudeTargets(dir: string, name: Brand): PlannedWrite[] {
  const t = (path: string, what: string, kind: PlannedWrite['kind'] = 'claude'): PlannedWrite =>
    ({ hostId: 'claude', id: 'claude', path, scope: 'repo', kind, what });
  return [
    t(join(dir, '.claude', 'settings.json'), `${name} statusline + hook blocks`),
    t(join(dir, '.claude', 'helpers', `${name}-statusline.cjs`), 'statusline shim'),
    t(join(dir, '.claude', 'helpers', `${name}-hooks.cjs`), 'hooks shim'),
    t(join(dir, '.claude', 'skills', name, 'SKILL.md'), `${name} skill`),
    t(join(dir, '.mcp.json'), `mcpServers.${name}`, 'mcp'),
  ];
}

/**
 * Build the graph if it isn't there yet.
 */
export function buildGraphIfMissing(dir: string, opts: { build?: boolean; cliPath?: string }): boolean {
  if (opts.build === false || !opts.cliPath || hasGraftIndex(dir)) return false;
  try {
    execFileSync(process.execPath, [...process.execArgv, opts.cliPath, 'build', '.'], { cwd: dir, stdio: 'inherit', timeout: 300000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** The repo's settings as an object to merge into. */
function readSettings(path: string): Record<string, any> | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return {}; }
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

export interface InitResult {
  settingsPath: string;
  shims: string[];
  skill: string;
  mcp: McpWrite | null;
  global: GlobalWrite[];
  warnings: string[];
  built: boolean;
}

export function runInit(
  dir: string,
  opts: { build?: boolean; cliPath?: string; statusline?: boolean; global?: boolean; home?: string; brand?: Brand } = {},
): InitResult {
  if (wiringName(dir, opts.brand) === 'trail') return runTrailInit(dir, opts);
  // graft brand: write settings (no hooks), skill, MCP. Shims removed (trail-solo-grafo).
  const [settings, _statusline, _hooks, skill, mcpTarget] = legacyClaudeTargets(dir, 'graft').map((t) => t.path);

  mkdirSync(dirname(skill), { recursive: true });

  const settingsPath = settings;
  const existing = readSettings(settingsPath);
  const { merged, warnings } = mergeGraftSettings(existing ?? {}, { statusline: opts.statusline, name: 'graft' });
  if (existing) writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  else warnings.push(notPlainJson('.claude/settings.json', "graft's settings"));

  const skillPath = skill;
  writeFileSync(skillPath, skillTemplate('graft'));

  const mcp = mergeJsonKey('claude', mcpTarget, 'mcpServers', serverEntry({ brand: 'graft' }), 'graft');

  const global = opts.global === false ? [] : installClaudeGlobal(opts.home ?? homedir(), 'graft');

  const built = buildGraphIfMissing(dir, opts);
  return { settingsPath, shims: [], skill: skillPath, mcp, global, warnings, built };
}

/** The warning for a settings file init left alone because it isn't plain JSON. */
function notPlainJson(file: string, what: string): string {
  return `Left ${file} as it was: it isn't plain JSON (a comment or a trailing comma?), and rewriting it would lose what's in it. Make it plain JSON and run init again to add ${what} there.`;
}

/**
 * `runInit` for a repo on trail.
 * trail-solo-grafo: writes only .trail/ dir, Hermes skill, and MCP config.
 * Hook shim (.trail/hook.cjs), statusline shim, .claude/settings.json, and
 * knowledge hook plugin are NOT written.
 */
function runTrailInit(
  dir: string,
  opts: { build?: boolean; cliPath?: string; statusline?: boolean; global?: boolean; home?: string },
): InitResult {
  const home = opts.home ?? homedir();
  const global = opts.global !== false;

  // Create the .trail/ directory and git-ignore the cache inside it.
  mkdirSync(join(dir, '.trail'), { recursive: true });
  ignoreInTrailDir(dir, 'cache/');

  const warnings: string[] = [];

  let skillPath = '';
  if (global) {
    // Write the trail Claude skill.
    const skill = trailSkillPath(home);
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, skillTemplate('trail'));
    skillPath = skill;

    // Write the Hermes skill when Hermes is installed on this machine.
    if (hermesInstalled(home)) {
      const hPath = hermesSkillPath(home);
      mkdirSync(dirname(hPath), { recursive: true });
      writeFileSync(hPath, hermesSkillTemplate('trail'));
    }
  }

  // Clean up any old hook/shim/skill files a previous init may have written.
  clearOldLayout(dir);

  const globalWrites = global ? installClaudeGlobal(home, 'trail') : [];
  if (global) globalWrites.push(disableGraftServerIn(home, resolve(dir)));

  const built = buildGraphIfMissing(dir, opts);
  // settings path: nothing written now; return empty string.
  return { settingsPath: '', shims: [], skill: skillPath, mcp: null, global: globalWrites, warnings, built };
}

/**
 * Remove old hook/shim/skill files a previous init may have written.
 */
function clearOldLayout(dir: string, opts: { keepShims?: boolean } = {}): void {
  for (const n of ['graft', 'trail'] as const) {
    const [, oldSl, oldHk, oldSkill] = legacyClaudeTargets(dir, n).map((t) => t.path);
    if (!opts.keepShims) {
      rmSync(oldSl, { force: true });
      rmSync(oldHk, { force: true });
    }
    rmSync(dirname(oldSkill), { recursive: true, force: true });
  }
  for (const d of [join(dir, '.claude', 'helpers'), join(dir, '.claude', 'skills')]) {
    try { rmdirSync(d); } catch { /* holds the user's files, or was never there */ }
  }
  // Remove old .trail/hook.cjs and .trail/statusline.cjs if they exist.
  rmSync(join(dir, TRAIL_HOOK), { force: true });
  rmSync(join(dir, TRAIL_STATUSLINE), { force: true });
  dropServer(join(dir, '.mcp.json'), ['trail', 'graft']);
}

/** Take trail's (or graft's) server out of an `.mcp.json`. */
function dropServer(path: string, names: string[]): void {
  try {
    const loaded = readJsonObject(path);
    if (loaded === 'unparseable' || !loaded.existed) return;
    const root = loaded.root;
    const servers = root.mcpServers;
    if (!servers || typeof servers !== 'object' || !names.some((n) => n in servers)) return;
    for (const n of names) delete servers[n];
    if (Object.keys(servers).length === 0) delete root.mcpServers;
    if (Object.keys(root).length === 0) rmSync(path, { force: true });
    else writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  } catch { /* leave it as the user has it */ }
}

/**
 * Keep a personal file out of git without touching the repo's `.gitignore`.
 */
export function keepOutOfGit(dir: string, rel: string): void {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: dir, stdio: 'ignore', windowsHide: true });
    return;
  } catch (e) {
    if ((e as { status?: number }).status !== 1) return;
  }
  try {
    let exclude = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    if (!isAbsolute(exclude)) exclude = join(dir, exclude);
    const line = `/${rel.split('\\').join('/')}`;
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (text.split('\n').some((l) => l.trim() === line)) return;
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
  } catch { /* best-effort */ }
}
