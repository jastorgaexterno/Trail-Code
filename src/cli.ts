#!/usr/bin/env node
/**
 * The `trail` CLI, also run as `graft`, its old name. Commands: build, ask,
 * check, viz, mcp, callers, skeleton, grep, map, init. Git is the sync: commit
 * graft/ and a clone has the graph. A workspace parent (≥2 git children)
 * federates query commands across children.
 *
 * Both names run this file. Under `graft` every command keeps its old name and
 * meaning; under `trail` the layout changes (see `TRAIL` below and brand.ts).
 */
import { WINHIDE } from "./util/child-process.js";
import { spawnSync } from "node:child_process";
import "dotenv/config";
import { Command } from "commander";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Graft } from "./engine.js";
import { resolveConfig, type EngineConfig } from "./ai/providers.js";
import type { ProviderKind } from "./ai/llm/factory.js";
import { formatCheckReport } from "./context/check.js";
import { formatGraphCheckReport } from "./graph/check.js";
import { buildGraphIfMissing, runInit } from "./claude/init.js";
import { statuslineWanted } from "./claude/settings-merge.js";
import { runHostsInit } from "./hosts/init.js";
import { agentList, autoSelection, autoSummary } from "./hosts/auto.js";
import { asksForTrail, brand, cmd, graftNotice, inBrand, PACKAGE_FOR, setBrand, strandedRepoNotice, tag, trailOnPath } from "./brand.js";
import { openBrowser } from "./util/browser.js";
import { contextDirFor } from "./context/node-file.js";
import { loadGraphCached } from "./graph/load.js";
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from "./graph/refresh.js";
import { isWorkspaceBuildRoot, loadWorkspaceGraphs, readWorkspace, writeWorkspace } from "./graph/workspace.js";
import { NOT_GIT_LINE, NOT_GIT_PAIR_REFUSAL, homeFolderRefusal, isGitWorkTree } from "./init-guard.js";
import { hasGraftIndex, nearestGraftRoot } from "./graph/root.js";
import { unsupportedExtensions, supportedExtensions } from "./graph/source-files.js";
import { discoverWorkspaceChildren } from "./graph/scopes.js";
import {
  runWorkspaceAsk,
  runWorkspaceBuild,
  runWorkspaceCallers,
  runWorkspaceCheck,
  runWorkspaceGrep,
  runWorkspaceMap,
} from "./graph/workspace-cli.js";
import { formatInitEpilogue } from "./cli-epilogue.js";
import { planInit, selectedWrites } from "./hosts/plan.js";
import { planRetract, runRetract, changed, type Retraction } from "./hosts/retract.js";
import { compactWrites, formatNonInteractiveHelp, formatPlan, runPicker } from "./cli-picker.js";
import { buildGraphWithProgress } from "./claude/build-progress.js";
import { installBrainsServer, installCursorBrainsServer, removeBrainsServer, removeCursorBrainsServer } from "./hosts/claude-global.js";
import { upsertCodexToml } from "./hosts/mcp-config.js";
import { homedir } from "node:os";
import { formatUpgradeReport, formatVersionReport, getNpmViewVersion, readCurrentVersion, readPackageName, runUpgrade } from "./cli-meta.js";
import { nativeFallbackNotice } from "./graph/native.js";
import { patchBuildConfig, type BuildConfig } from "./util/state.js";
import { normalizePathPrefix } from "./util/paths.js";
import { latestSession, formatSessionStats, sessionInputRate } from "./claude/session-metrics.js";
import { listSessionIds, readSession, sessionDir } from "./claude/state.js";
import type { AskResult } from "./ask/ask.js";
import { setInputRate } from "./context/savings.js";
import { formatUpdateNudge, maybeRefreshInBackground, readStamp, readUpdateCache, refreshUpdateCache, wiredHostIds, wiringOpts, writeStamp } from "./upkeep.js";
import { shouldMoveToTrail } from "./upkeep-run.js";
import {
  countBucket,
  errorCode,
  filesBucket,
  durationBucket,
  formatDebug,
  formatStatus,
  firstRunNotice,
  isTrackedCommand,
  langsValue,
  offReason,
  maybeFlushInBackground,
  patchState,
  runFlush,
  track,
  trackFirstRunIfNew,
} from "./telemetry/index.js";

const program = new Command();
const currentVersion = readCurrentVersion(import.meta.url);

// When Commander prints an error (unknown option, missing required option, etc.)
// append a hint so users know how to discover the available flags.
program.configureOutput({
  writeErr: (str) => {
    process.stderr.write(str);
  },
  outputError: (str, write) => {
    write(str);
    // Append a --help hint when Commander exits with a parse error, so users
    // know how to discover available flags instead of having to guess.
    if (str.startsWith('error:')) {
      const sub = process.argv[2];
      const hint = sub && !sub.startsWith('-')
        ? `Run 'trail ${sub} --help' to see available options.\n`
        : `Run 'trail --help' to see available commands.\n`;
      process.stderr.write(hint);
    }
  },
});

/**
 * Started as `trail` rather than `graft`. Decided once, before any command is
 * registered, because it changes which commands exist: under trail the old
 * `graft trail …` group moves to the top level, `check` hands its name to the
 * team check (the freshness check is `build --check`), and `stats` and
 * `trail status` become one `status`. Under graft nothing moves. Trail's setup
 * prompt runs as trail whichever name started it (`asksForTrail`).
 */
if (asksForTrail(process.argv.slice(2))) setBrand("trail");
const TRAIL = brand() === "trail";

/** Help-screen groups under trail; graft keeps its one flat list. */
const GROUP = {
  find: "Find code · your agent runs these:",
  setup: "Setup:",
  ci: "CI:",
} as const;

/** Put a command in a help group, under trail only. */
function grouped(c: Command, heading: string): Command {
  if (TRAIL) c.helpGroup(heading);
  return c;
}

/**
 * What the `query` telemetry event will say, filled in by the command as it runs
 * and emitted once from the `postAction` hook below.
 *
 * A module-level slot rather than a threaded parameter because the repo root is
 * resolved deep inside each action (`queryRoot`) while the event is emitted
 * centrally — and because a command that calls `process.exit` should simply
 * report nothing, which falls out of never emitting until postAction.
 */
let queryNote: { repo?: string; hit?: "yes" | "no"; command?: string; notes?: string } = {};

/** Record the repo a query ran against, and pass it straight through so call
 *  sites stay one line. */
function noteQuery(dir: string): string {
  queryNote.repo = dir;
  // Every retrieval command funnels through here, which makes it the one place
  // that can price this session's tokens before a formatter needs the number.
  setInputRate(sessionInputRate(dir));
  return dir;
}

/** Whether a query found anything. Only the commands that have a result count in
 *  hand call this; the property is simply absent for the others. */
function noteHit(found: boolean): void {
  queryNote.hit = found ? "yes" : "no";
}

program
  .name(brand())
  .description(
    TRAIL
      ? "A code map for your coding agents: exact file:line spans, a call graph,\n" +
          "and a semantic index, kept in sync with the working tree as you query it."
      : "Build a repo's context graph as linked markdown, and keep it in sync with the code.",
  )
  .version(currentVersion, "-v, --version")
  .option("--dir <path>", "context graph directory (default: <repo>/graft)")
  .option("--provider <name>", "LLM wire format: openai | anthropic | litellm | orcarouter (env GRAFT_PROVIDER)")
  .option("--model <id>", "model id for the LLM pass (env GRAFT_MODEL)")
  .option("--api-key <key>", "provider API key (env GRAFT_API_KEY)")
  .option("--base-url <url>", "OpenAI-compatible endpoint URL (env GRAFT_BASE_URL)");

interface GlobalOpts {
  dir?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** Config drawn from the global CLI flags (env + defaults fill the rest). */
function cliConfig(): EngineConfig {
  const o = program.opts<GlobalOpts>();
  return {
    contextDir: o.dir,
    provider: o.provider as ProviderKind | undefined,
    model: o.model,
    apiKey: o.apiKey,
    baseUrl: o.baseUrl,
  };
}

const engineFrom = (): Graft => new Graft(cliConfig());

/**
 * Warn (never fail) when a user's `-e` extension has no parser, so it is never a silent
 * no-op — `graft build -e ".vue"` used to accept it, index nothing, and exit 0. The
 * supported set is listed so `-e` also answers "what is actually supported".
 */
function warnUnsupportedExtensions(exts?: string[]): void {
  if (!exts?.length) return;
  const bad = unsupportedExtensions(exts);
  if (bad.length === 0) return;
  for (const e of bad) {
    const shown = e.trim().startsWith(".") ? e.trim() : `.${e.trim()}`;
    console.error(`⚠ -e "${shown}": no parser registered for this extension, so it is ignored.`);
  }
  console.error(`  supported: ${supportedExtensions().join(" ")}`);
}

/** Text for the omitted-`[dir]` case, shared by every query command's help. */
const DIR_ARG = ["[dir]", "repository root (default: nearest ancestor with a graft/ index)"] as const;

/**
 * The root a query runs against: the dir the user named, else the nearest
 * ancestor holding a graft index (`graph/root.ts`) so a shell or agent session
 * in a subdirectory still finds the graph. The walk is announced on stderr —
 * answering from an ancestor's graph must never be silent.
 */
function queryRoot(dir?: string): string {
  if (dir !== undefined) return resolve(dir);
  const { root, levels } = nearestGraftRoot(process.cwd(), program.opts<GlobalOpts>().dir);
  if (levels > 0) console.error(`${tag()} no code map here: answering from ${contextDirFor(root, program.opts<GlobalOpts>().dir)}`);
  return root;
}

/**
 * Bring the graph up to date with the working tree before a query answers from it
 * — the same gate the MCP tools run (see `graph/refresh.ts`). Cheap when nothing
 * moved; a structural, $0 rebuild when it did. The note goes to stderr so `--json`
 * stdout stays machine-readable.
 */
async function refreshBefore(dir: string, opts: { refresh?: boolean }): Promise<void> {
  const globalDir = program.opts<GlobalOpts>().dir;
  const root = resolve(dir);
  const disabled = opts.refresh === false;
  const ws = readWorkspace(root, globalDir);
  const r = ws
    ? await ensureFreshChildren(root, ws.children, { contextDir: globalDir, disabled })
    : await ensureFreshGraph(root, { contextDir: globalDir, disabled });
  const note = refreshNote(r);
  if (note) console.error(note);
}

/** Attached to every query command: `--no-refresh` answers from the graph exactly
 * as it is on disk, no rebuild. */
const NO_REFRESH_FLAG = ["--no-refresh", "skip the freshness check: answer from the graph as-is"] as const;

const VIZ_TABS = ["context", "code", "outline"] as const;
type VizTab = (typeof VIZ_TABS)[number];

/**
 * `--tabs context,code` → the tabs to write into an exported page.
 *
 * An unknown name is a caller mistake worth failing on rather than silently
 * dropping: a page exported with a typo'd tab list would be missing a tab and
 * nothing would say why. Undefined means "all of them", which is the default the
 * exporter already applies.
 */
function parseTabs(raw: string | undefined): VizTab[] | undefined {
  if (raw === undefined) return undefined;
  const want = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const bad = want.filter((t) => !VIZ_TABS.includes(t as VizTab));
  if (bad.length > 0 || want.length === 0) {
    console.error(`✗ --tabs takes a comma-separated subset of ${VIZ_TABS.join(", ")}${bad.length ? `, not "${bad.join('", "')}"` : ""}`);
    process.exit(1);
  }
  return want as VizTab[];
}

/**
 * Commands that own the upgrade story themselves (`version`, `upgrade`) or must
 * not editorialize on stderr at startup (`mcp` runs its own upkeep at boot, and
 * `_update-check` IS the fetch).
 */
const UPKEEP_SKIP = new Set(["version", "upgrade", "_update-check", "mcp"]);

/**
 * Every other command: top up the cached registry answer in the background and,
 * if a newer graft is out, say so once on stderr. This is what makes the CLI the
 * cache filler for the hooks, which are not allowed to touch the network.
 */
program.hook("preAction", (_parent, action) => {
  if (UPKEEP_SKIP.has(action.name())) return;
  // Someone typing graft by hand learns its new name, once a day. Agents,
  // hooks, CI and pipes never see it (see graftNotice).
  const renamed = graftNotice({ ran: spelling(action), tty: Boolean(process.stderr.isTTY) });
  if (renamed) console.error(renamed);
  // Someone typing trail in a repo whose graft-era hooks can't reach it learns
  // the one command that moves it (init itself is that command).
  const stranded = action.name() === "init" ? null : strandedRepoNotice({ cwd: process.cwd(), tty: Boolean(process.stderr.isTTY) });
  if (stranded) console.error(stranded);
  maybeRefreshInBackground();
  const nudge = formatUpdateNudge(currentVersion, readUpdateCache()?.latest);
  if (nudge) console.error(nudge);
  // Telemetry, in the order a user should experience it: disclose first, then
  // record, then (at most once a day, detached) send. Every step is a no-op in a
  // fork, in CI, under DO_NOT_TRACK, or after `graft telemetry disable`.
  const notice = firstRunNotice();
  if (notice) console.error(notice);
  trackFirstRunIfNew();
  maybeFlushInBackground();
});

/**
 * The `query` event, emitted after the command rather than before it, so it can
 * carry what the query actually did. A command that exits early via
 * `process.exit` never reaches here and is simply not counted — under-reporting
 * is the right failure mode for a metric.
 */
program.hook("postAction", (_parent, action) => {
  // `trail build --check` is graft's `check`, and counts as it always has.
  const name = queryNote.command ?? action.name();
  if (!isTrackedCommand(name)) return;
  track("query", { command: name, surface: "cli", hit: queryNote.hit, notes: queryNote.notes }, { repo: queryNote.repo });
});

/** `graft ask`, `graft build`: a command as graft spells it, whatever ran it. */
function spelling(action: Command): string {
  const words: string[] = [];
  for (let c: Command | null = action; c && c.parent; c = c.parent) words.unshift(c.name());
  return ["graft", ...words].join(" ");
}


program
  .command("_update-check", { hidden: true })
  .description("internal: refresh the cached latest-version answer")
  .action(() => {
    refreshUpdateCache();
  });

// Hidden for the same reason as _update-check: only ever spawned detached, by
// maybeFlushInBackground. Running it by hand is harmless — it drains the queue.
program
  .command("_telemetry-flush", { hidden: true })
  .description("internal: POST the queued anonymous usage events")
  .action(async () => {
    await runFlush();
  });

grouped(program.command("telemetry"), GROUP.setup)
  .description("Show, inspect, or turn off the anonymous usage stats (see TELEMETRY.md)")
  .argument("[action]", "status (default) | enable | disable | debug", "status")
  .action((action: string) => {
    switch (action) {
      case "status":
        console.log(formatStatus());
        return;
      case "enable":
        patchState({ enabled: true });
        console.log(`telemetry: on, anonymous and aggregate-only. \`${cmd("graft telemetry status")}\` for details.`);
        return;
      case "disable":
        // Also stamp the notice as shown: someone who has just opted out should
        // not be told about telemetry again the next time they run a command.
        patchState({ enabled: false, noticeShownAt: new Date().toISOString() });
        console.log("telemetry: off. Nothing further will be recorded or sent.");
        return;
      case "debug":
        console.log(formatDebug());
        return;
      default:
        console.error(`✗ unknown action "${action}": expected status, enable, disable, or debug`);
        process.exit(1);
    }
  });

// Hidden under trail, where -v says the same; listed under graft as it was.
program
  .command("version", { hidden: TRAIL })
  .description("Print the installed version and the latest published on npm")
  .action(() => {
    const latest = getNpmViewVersion();
    console.log(formatVersionReport(currentVersion, latest));
  });

grouped(program.command("upgrade"), GROUP.setup)
  .description(`Upgrade the globally installed ${brand()} to the latest version on npm`)
  .action(() => {
    const result = runUpgrade(import.meta.url);
    console.log(formatUpgradeReport(result));
    if (result.ran && !result.ok) process.exit(1);
  });

grouped(program.command("config", { hidden: !TRAIL }), GROUP.setup)
  .description("Read or update workspace or global trail configuration");


grouped(program.command("build"), GROUP.setup)
  .description(
    TRAIL
      ? "Rebuild the code map in .trail/cache/ ($0, no key). --check fails if it's stale; --deep adds LLM summaries."
      : "Build graft/ from your code: wiring graph + per-file cards ($0, no key). " +
          "Add --deep for the LLM concept map + per-symbol summaries/crux.",
  )
  .argument("[dir]", "repository root", ".")
  .option("--check", "build nothing: fail if graft/ is stale relative to the code (for CI)")
  .option("--json", "with --check: output the drift as JSON")
  .option("--deep", "run the LLM pass: concept nodes (graft/*.md) + per-symbol summary/crux")
  .option("-e, --extensions <exts...>", 'code extensions to include (e.g. ".ts" ".py"); an extension with no parser is ignored with a warning that lists the supported set')
  .option("-j, --concurrency <n>", "files summarized in parallel during --deep (default 5)")
  .option(
    "--synth-concurrency <n>",
    "concept synthesis batches in flight at once during --deep (default 4). Separate from -j: " +
      "each synthesis call carries a whole batch of summaries, not one file",
  )
  .option("--no-reuse", "re-parse every file instead of replaying unchanged ones from the extraction cache")
  .option("--lsp", "add compiler-grade call edges via a language server if one is installed (opt-in, slower; e.g. rust-analyzer, clangd)")
  .option("--allow-partial", "with --deep: exit 0 even when some files' summaries failed (default: a degraded meaning tier exits 1)")
  .option(
    "--follow-submodules",
    "include initialized Git submodules recursively; persisted for later builds and automatic refreshes",
  )
  .option(
    "--no-follow-submodules",
    "exclude Git submodules; persisted for later builds and automatic refreshes (default)",
  )
  .option(
    "--follow-nested-repos",
    "include nested Git clones the index does not track (a multi-repo manifest checkout, or any repo cloned into the tree) " +
      "as ONE graph, so imports across them resolve; persisted for later builds and automatic refreshes",
  )
  .option(
    "--no-follow-nested-repos",
    "exclude untracked nested Git clones; persisted for later builds and automatic refreshes (default)",
  )
  .option(
    "--include-dir <name>",
    "override SKIP_DIRS for this repo's walks, repeatable (e.g. --include-dir build --include-dir tools); " +
      "persisted, so a later build (and the automatic refresh before a query) include it without the flag; dot-dirs are never overridable",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "--only-dir <path>",
    "only index files under this repo-relative path, repeatable; the wiring walk and the --deep " +
      "concept pass both honor it. Recorded in the graph fingerprint so a later build " +
      "(and the automatic refresh before a query) walks the same set; everything outside the list is skipped",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option("--no-gitignore", "skip writing graft/ into .gitignore (same as GRAFT_NO_GITIGNORE=1)")
  .option("--no-ignore", "skip writing .ignore for ripgrep re-admit (same as GRAFT_NO_IGNORE=1)")
  .option("--no-semantic", "skip embedding nodes for semantic search after building the graph")
  .option(
    "--include-md",
    "index .md files as graph nodes (headings → symbols); persisted for later builds and refreshes",
  )
  .option(
    "--no-include-md",
    "stop indexing .md files (revert a previous --include-md); persisted",
  )
  .option(
    "--md-only-dir <path>",
    "limit .md indexing to this repo-relative dir, repeatable (e.g. --md-only-dir specs); persisted",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "--include-openspec-archive",
    "also index openspec/changes/archive/ .md files (excluded by default); persisted",
  )
  .action(async (
    dir: string,
    opts: {
      check?: boolean;
      json?: boolean;
      deep?: boolean;
      extensions?: string[];
      concurrency?: string;
      reuse?: boolean;
      lsp?: boolean;
      allowPartial?: boolean;
      synthConcurrency?: string;
      includeDir?: string[];
      onlyDir?: string[];
      followSubmodules?: boolean;
      followNestedRepos?: boolean;
      includeMd?: boolean;
      mdOnlyDir?: string[];
      includeOpenSpecArchive?: boolean;
      gitignore?: boolean;
      ignore?: boolean;
      semantic: boolean;
    },
    command: Command,
  ) => {
    if (opts.check) {
      // The freshness check, which was `graft check`. Counted as `check` so the
      // metric carries on across the rename; the dir defaults like a query's.
      queryNote.command = "check";
      await runCheckCommand(command.args[0], { extensions: opts.extensions, json: opts.json }, cmd("graft check"));
      return;
    }
    const buildStartedAt = Date.now();
    if (opts.gitignore === false) process.env.GRAFT_NO_GITIGNORE = "1";
    if (opts.ignore === false) process.env.GRAFT_NO_IGNORE = "1";
    const concurrency = opts.concurrency ? Math.max(1, Number(opts.concurrency)) : undefined;
    if (opts.concurrency && !Number.isFinite(concurrency)) {
      console.error(`✗ --concurrency must be a number, got "${opts.concurrency}"`);
      process.exit(1);
    }
    const synthConcurrency = opts.synthConcurrency ? Math.max(1, Number(opts.synthConcurrency)) : undefined;
    if (opts.synthConcurrency && !Number.isFinite(synthConcurrency)) {
      console.error(`✗ --synth-concurrency must be a number, got "${opts.synthConcurrency}"`);
      process.exit(1);
    }
    warnUnsupportedExtensions(opts.extensions);
    // Persisted BEFORE the build itself runs, so this invocation's walks (and
    // every later no-flag build / hooks refresh) see it identically — the
    // walkDir call sites read it from state, not from a threaded option.
    const buildConfigPatch: BuildConfig = {};
    if (opts.includeDir && opts.includeDir.length > 0) {
      // --include-dir takes bare SKIP_DIRS-style directory NAMES (shouldSkipDir
      // compares a single path segment), never paths, and dot-dirs are never
      // overridable at all (see the option's own help text) — reject anything
      // else up front instead of silently persisting a value that can never
      // match a real directory name.
      for (const name of opts.includeDir) {
        if (name.startsWith(".")) {
          console.error(`✗ --include-dir "${name}": dot-directories are never overridable`);
          process.exit(1);
        }
        if (name.includes("/") || name.includes("\\")) {
          console.error(`✗ --include-dir "${name}": expected a bare directory name, not a path`);
          process.exit(1);
        }
      }
      buildConfigPatch.includeDirs = opts.includeDir;
    }
    // The whitelist is NOT persisted to `.graft/config.json`: it belongs with the
    // graph (the fingerprint records it at build time), never in the source repo,
    // so a `--only-dir` build leaves no trace under the repo being indexed.
    let onlyDirs: string[] | undefined;
    if (opts.onlyDir && opts.onlyDir.length > 0) {
      // --only-dir takes a repo-relative path prefix, normalized to the same
      // posix, no-`./`, no-trailing-slash form `--in` uses, so the prefix match
      // is exact. A prefix that normalizes to "" (a bare "/" or ".") is rejected:
      // it would mean "match nothing" or "match everything", neither of which is
      // a deliberate whitelist.
      const normalized = opts.onlyDir.map((p) => normalizePathPrefix(p)).filter((p) => p !== "");
      if (normalized.length === 0) {
        console.error("✗ --only-dir: expected a non-empty repo-relative path");
        process.exit(1);
      }
      onlyDirs = normalized;
    }
    const followSubmodulesWasExplicit = command.getOptionValueSource("followSubmodules") === "cli";
    if (followSubmodulesWasExplicit && typeof opts.followSubmodules === "boolean") {
      buildConfigPatch.followSubmodules = opts.followSubmodules;
    }
    const followNestedReposWasExplicit = command.getOptionValueSource("followNestedRepos") === "cli";
    if (followNestedReposWasExplicit && typeof opts.followNestedRepos === "boolean") {
      buildConfigPatch.followNestedRepos = opts.followNestedRepos;
    }
    const includeMdWasExplicit = command.getOptionValueSource("includeMd") === "cli";
    if (includeMdWasExplicit && typeof opts.includeMd === "boolean") {
      buildConfigPatch.includeMd = opts.includeMd;
    }
    if (opts.mdOnlyDir && opts.mdOnlyDir.length > 0) {
      buildConfigPatch.mdOnlyDirs = opts.mdOnlyDir;
    }
    const includeOpenSpecArchiveWasExplicit = command.getOptionValueSource("includeOpenSpecArchive") === "cli";
    if (includeOpenSpecArchiveWasExplicit && opts.includeOpenSpecArchive !== undefined) {
      buildConfigPatch.includeOpenSpecArchive = opts.includeOpenSpecArchive;
    }
    if (Object.keys(buildConfigPatch).length > 0) {
      patchBuildConfig(resolve(dir), buildConfigPatch);
    }
    const engine = engineFrom();
    const fmt = (o: Record<string, number>) =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");

    // --deep needs a key; without one, degrade to the $0 structural build.
    let deep = opts.deep;
    const resolved = resolveConfig(cliConfig());
    if (deep && !resolved.apiKey) {
      deep = false;
      console.error(
        "⚠ no API key set, so falling back to the structural build (no LLM summaries).\n" +
          "  Set GRAFT_API_KEY (and GRAFT_PROVIDER / GRAFT_BASE_URL / GRAFT_MODEL for your\n" +
          `  provider) and re-run \`${cmd("graft build --deep")}\` to add concept nodes and summaries.`,
      );
    }
    if (deep && resolved.usedLegacyEnv) {
      console.error(
        "⚠ using OPENROUTER_API_KEY (deprecated): prefer GRAFT_API_KEY + GRAFT_BASE_URL.",
      );
    }

    // Workspace parent: build each child into its OWN graft/ + a workspace index.
    const buildRoot = resolve(dir);
    const buildGlobalDir = program.opts<GlobalOpts>().dir;
    if (isWorkspaceBuildRoot(buildRoot, buildGlobalDir)) {
      await runWorkspaceBuild(buildRoot, {
        deep: !!deep,
        extensions: opts.extensions,
        concurrency,
        synthConcurrency,
        childConfig: cliConfig(),
        override: buildGlobalDir,
        includeDirs: opts.includeDir,
        followSubmodules: followSubmodulesWasExplicit ? opts.followSubmodules : undefined,
        followNestedRepos: followNestedReposWasExplicit ? opts.followNestedRepos : undefined,
        includeMd: includeMdWasExplicit ? opts.includeMd : undefined,
        mdOnlyDirs: opts.mdOnlyDir && opts.mdOnlyDir.length > 0 ? opts.mdOnlyDir : undefined,
        includeOpenSpecArchive: includeOpenSpecArchiveWasExplicit ? opts.includeOpenSpecArchive : undefined,
        packageName: readPackageName(import.meta.url),
      });
      // --semantic: embed each child repo after workspace build.
      if (opts.semantic) {
        const { embedNodes: doEmbedWs } = await import('./ask/semantic.js');
        const { join: pathJoinWs } = await import('node:path');
        const { contextDirFor: ctxDirForWs } = await import('./context/node-file.js');
        const { loadGraphCached: loadGraphWs } = await import('./graph/load.js');
        const ws = readWorkspace(buildRoot, buildGlobalDir);
        if (ws) {
          for (const child of ws.children) {
            const childRoot = pathJoinWs(buildRoot, child);
            const childCtx = ctxDirForWs(childRoot);
            const loaded = loadGraphWs(childCtx);
            if (loaded) {
              const dbPath = pathJoinWs(childCtx, '.cache', 'embeddings.db');
              await doEmbedWs(loaded.nodes, dbPath);
            }
          }
          process.stderr.write('[semantic] Workspace embedding complete\n');
        }
      }
      return;
    }

    // --deep: concept nodes first, then the wiring graph links cards up to them.
    let conceptErrors: string[] = [];
    let conceptFatal: string | undefined;
    if (deep) {
      const c = await engine.init(dir, {
        extensions: opts.extensions,
        onlyDirs,
        synthConcurrency,
        onProgress: ({ phase, index, total, file }) =>
          process.stderr.write(
            `\r${phase === "summarize" ? "reading" : "writing"} concepts ${index + 1}/${total}: ${file.slice(0, 40).padEnd(40)}`,
          ),
      }).catch((err: unknown) => {
        // Only the stage and a code enum; the message stays on this machine.
        track("build_failed", { stage: "summarize", code: errorCode(err) }, { repo: buildRoot });
        throw err;
      });
      process.stderr.write("\n");
      const conceptLine = `concepts: ${c.nodes} nodes, ${c.links} links from ${c.files} files (${c.summarized} read, ${c.cached} cached)`;
      if (c.nodes === 0) console.error(`⚠ ${conceptLine}`);
      else console.log(`✓ ${conceptLine}`);
      for (const e of c.errors) console.error(`✗ ${e}`);
      conceptErrors = c.errors;
      conceptFatal = c.fatal;
    }

    // Wiring graph — always; LLM meaning only with --deep.
    const g = await engine.graph(dir, {
      llm: deep,
      concurrency,
      reuse: opts.reuse,
      lsp: opts.lsp,
      onlyDirs,
      onProgress: ({ phase, index, total, file }) =>
        process.stderr.write(
          `\r${phase === "enrich" ? "summarizing" : "parsing"} ${index + 1}/${total}: ${file.slice(0, 50).padEnd(50)}`,
        ),
    }).catch((err: unknown) => {
      track("build_failed", { stage: "graph", code: errorCode(err) }, { repo: buildRoot });
      throw err;
    });
    process.stderr.write("\n");
    console.log(`✓ wiring: ${g.nodes} nodes (${fmt(g.byKind)}), ${g.edges} edges, ${g.cards} cards [${g.languages.join(", ")}]`);
    console.log(`  parsed: ${g.parsed} of ${g.files} files (${g.reused} replayed from cache)`);
    // Worth one line: this build started from a graph the user never built *here*.
    if (g.seededFrom) console.log(`  seeded: copied a starting graph from ${g.seededFrom} (git worktree)`);
    if (deep) {
      const m = g.meaning;
      console.log(`  meaning: ${m.computed} computed, ${m.cached} cached, ${m.stale} stale, ${m.pending} pending`);
    }
    console.log(`  → ${g.contextDir}`);
    // The activation event. Everything here is a bucket or a fixed label: repo
    // scale rather than a file count, a language set rather than file names.
    track(
      "build_completed",
      {
        files_bucket: filesBucket(g.files),
        langs: langsValue(g.languages),
        mode: deep ? "deep" : "fast",
        duration_bucket: durationBucket(Date.now() - buildStartedAt),
        incremental: String(g.reused > 0),
      },
      { repo: buildRoot },
    );
    for (const e of g.errors) console.error(`✗ ${e}`);
    // A language whose depth grammar didn't load was parsed by its breadth stand-in:
    // say which, and the install that fixes it. Nothing when everything loaded.
    const fallbackNotice = nativeFallbackNotice(g.nativeFallback, readPackageName(import.meta.url));
    if (fallbackNotice) console.error(fallbackNotice);

    const rel = relative(process.cwd(), g.contextDir) || "graft";
    if (process.env.GRAFT_NO_GITIGNORE) {
      console.log(`  ${rel}/ is a local cache: add it to your gitignore if you want it untracked.`);
    } else {
      console.log(`  ${rel}/ is git-ignored (added automatically), a local cache; teammates run \`${cmd("graft build")}\` to get their own.`);
    }

    // --semantic: embed all nodes for semantic search after a successful build.
    if (opts.semantic) {
      const { embedNodes: doEmbed } = await import('./ask/semantic.js');
      const { join: pathJoin } = await import('node:path');
      const { contextDirFor } = await import('./context/node-file.js');
      const { loadGraphCached } = await import('./graph/load.js');
      const contextDir = contextDirFor(buildRoot, program.opts<GlobalOpts>().dir);
      const loaded = loadGraphCached(contextDir);
      if (loaded) {
        const dbPath = pathJoin(contextDir, '.cache', 'embeddings.db');
        await doEmbed(loaded.nodes, dbPath);
        process.stderr.write('[semantic] Embedding complete\n');
      }
    }

    // #127: a --deep run whose LLM calls failed used to print the same success
    // footer and exit 0, so a quota-exhausted build looked identical to a clean
    // one and `graft check` still said "in sync" (it only ever checked Tier-1).
    // The structural graph IS still written and every successful summary is
    // cached, so this is a loud warning about a degraded tier, not a rollback.
    if (deep) {
      const m = g.meaning;
      const failed =
        m.failedFiles > 0 || m.fatal !== undefined || conceptErrors.length > 0 || conceptFatal !== undefined;
      if (failed) {
        const ready = m.computed + m.cached;
        const total = ready + m.stale + m.pending;
        const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
        console.error("");
        console.error(`✗ the deep pass did not complete, so the meaning tier is incomplete.`);
        if (conceptFatal) console.error(`  concepts: ${conceptFatal}`);
        if (m.fatal) console.error(`  summaries: ${m.fatal}`);
        if (m.failedFiles > 0) {
          const skipped = m.skippedFiles > 0 ? `, ${m.skippedFiles} never attempted` : "";
          console.error(`  ${m.failedFiles} file(s) failed to summarize${skipped}.`);
        }
        if (conceptErrors.length > 0) console.error(`  ${conceptErrors.length} concept-pass error(s).`);
        console.error(`  meaning coverage: ${ready}/${total} symbols (${pct}%).`);
        console.error(
          `  Nothing computed was lost: re-run \`${cmd("graft build --deep")}\` to resume from what is cached.\n` +
            "  Pass --allow-partial to accept a degraded meaning tier and exit 0.",
        );
        if (!opts.allowPartial) process.exitCode = 1;
      }
    }
  });

/**
 * After `ask`, under trail: which shown learnings are a teammate's, and the
 * lookup recorded (the learnings shown are a use, which is what the team page
 * counts as reuse; the tokens saved ride along). Then the background upkeep
 * that keeps branches and the workspace current. Spawns no git itself. Teammates' branches come up after an edit
 * instead, once there's a function to compare (notes/edit-overlap.ts).
 */
function afterAsk(r: AskResult, repo: string): void {
  // Note: learnings tracking removed in trail-solo-grafo.
  void r; void repo;
}

grouped(program.command("ask"), GROUP.find)
  .description("Query the graft/ graph: returns ranked nodes + exact file:line, routed to prose or wiring ($0, no key)")
  .argument("<query>", "what you want to understand, in plain words (- reads it from stdin)")
  .argument(...DIR_ARG)
  .option("-n, --limit <n>", "max results", "8")
  .option("--source", "inline the source at each file:line hit (retriever mode: the pack IS the answer, no need to re-open files)")
  .option("--full", "with --source: inline whole definition spans instead of the default ≤8-line crux excerpts")
  .option("--in <path>", "narrow to nodes under this path prefix, filtered before scoring (segment-aware, like scopeOf)")
  .option("--json", "output the result as JSON")
  .option("--no-graph-rank", "rank by lexical relevance only, without the graph-connectivity re-rank (ablation/eval)")
  .option("--semantic", "use semantic (embedding) search instead of lexical — finds conceptually related code even without exact keywords; fallback when MCP trail_search_semantic is not available")
  .option(...NO_REFRESH_FLAG)
  .action(async (query: string, dirArg: string | undefined, opts: { limit: string; source?: boolean; full?: boolean; in?: string; json?: boolean; refresh?: boolean; graphRank?: boolean; semantic?: boolean }) => {
    // The prompt hook passes what the person typed on stdin, out of sight of `ps`.
    if (query === "-") query = readFileSync(0, "utf8").trim();
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const askGlobalDir = program.opts<GlobalOpts>().dir;

    // --semantic: vector search fallback (equivalent to MCP trail_search_semantic).
    if (opts.semantic) {
      const limit = Number(opts.limit);
      const { searchSemantic } = await import('./ask/semantic.js');
      const { contextDirFor } = await import('./context/node-file.js');
      const ws = readWorkspace(dir, askGlobalDir);
      const results: Array<{ score: number; file_path: string; symbol: string; snippet: string }> = [];
      const children = ws?.children ?? [];
      if (children.length > 0) {
        // Workspace: search each child's DB.
        const { join: pjoin } = await import('node:path');
        for (const child of children) {
          const childCtx = contextDirFor(join(dir, child));
          const db = pjoin(childCtx, '.cache', 'embeddings.db');
          if (!existsSync(db)) continue;
          try {
            const hits = await searchSemantic(query, db, limit);
            hits.forEach(h => results.push({ ...h, file_path: h.file_path.startsWith(child) ? h.file_path : `${child}/${h.file_path}` }));
          } catch { /* DB not ready */ }
        }
      } else {
        // Single repo.
        const ctx = contextDirFor(dir, askGlobalDir);
        const db = join(ctx, '.cache', 'embeddings.db');
        if (existsSync(db)) {
          try { (await searchSemantic(query, db, limit)).forEach(h => results.push(h)); } catch { /* DB not ready */ }
        }
      }
      if (results.length === 0) {
        console.error('no semantic matches found — run `trail build` to build the semantic index');
        process.exitCode = 1;
        return;
      }
      results.sort((a, b) => b.score - a.score);
      results.slice(0, limit).filter(h => h.score > 0.05).forEach((h, i) => {
        console.log(`${i + 1}. ${h.file_path} · ${h.symbol}  (score: ${h.score.toFixed(3)})\n   ${h.snippet}`);
      });
      return;
    }
    if (readWorkspace(dir, askGlobalDir)) {
      runWorkspaceAsk(dir, askGlobalDir, query, {
        limit: Number(opts.limit), source: opts.source, full: opts.full, in: opts.in, json: opts.json,
      });
      return;
    }
    const engine = engineFrom();
    let r;
    try {
      r = engine.ask(dir, query, { limit: Number(opts.limit), source: opts.source, full: opts.full, in: opts.in, graphRank: opts.graphRank });
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
    noteHit(r.hits.length > 0);
    // Teammates' branches on the same files, and the learnings shown, counted as a use.
    if (TRAIL) afterAsk(r, dir);
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      const { formatAsk } = await import("./ask/ask.js");
      process.stdout.write(formatAsk(r));
    }
  });

grouped(program.command("skeleton"), GROUP.find)
  .description("Signatures-only view of one file from the wiring graph: the cheapest way to see a file's API surface")
  .argument("<file>", "repo-relative path (or unique basename) of the file")
  .argument(...DIR_ARG)
  .option("--json", "output the result as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(async (file: string, dirArg: string | undefined, opts: { json?: boolean; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const { skeleton, formatSkeleton } = await import("./ask/ask.js");
    const globalOpts = program.opts<{ dir?: string }>();
    const r = skeleton(dir, file, { contextDir: globalOpts.dir });
    if (opts.json) console.log(JSON.stringify(r, null, 2));
    else process.stdout.write(formatSkeleton(r));
  });

if (!TRAIL) {
  program
    .command("check")
    .description("Fail if graft/ is stale relative to the code (for CI)")
    .argument(...DIR_ARG)
    .option("-e, --extensions <exts...>", "code extensions to include")
    .option("--json", "output the drift as JSON")
    .action(async (dirArg: string | undefined, opts: { extensions?: string[]; json?: boolean }) => {
      await runCheckCommand(dirArg, opts, "graft check");
    });
}
// Under trail, `check` is the team check (teamCheckCommand, with the cloud
// commands below); the freshness check is `trail build --check`.

/**
 * The freshness check: `graft check`, and `trail build --check`. `label` is how
 * the report names the command, so each name prints its own spelling.
 */
async function runCheckCommand(
  dirArg: string | undefined,
  opts: { extensions?: string[]; json?: boolean },
  label: string,
): Promise<void> {
    warnUnsupportedExtensions(opts.extensions);
    const dir = noteQuery(queryRoot(dirArg));
    const checkGlobalDir = program.opts<GlobalOpts>().dir;
    if (readWorkspace(dir, checkGlobalDir)) {
      await runWorkspaceCheck(dir, checkGlobalDir);
      return;
    }
    const engine = engineFrom();
    const r = engine.check(dir, { extensions: opts.extensions });
    const g = await engine.checkGraph(dir); // graph.json is only judged when it exists

    // A layer that IS present must be in sync; a never-built layer (keyless
    // build skips the markdown layer) is informational, not a failure.
    const bothMissing = r.missing && g.missing;
    const markdownFail = !r.missing && !r.ok;
    const wiringFail = !g.missing && !g.ok;

    if (opts.json) {
      console.log(JSON.stringify({ context: r, graph: g.missing ? null : g }, null, 2));
    } else if (bothMissing) {
      console.log(`${label}: NO GRAPH\n\nNo code map found. Run \`${cmd("graft build")}\` first.`);
    } else {
      if (r.missing) {
        console.log(
          `deep layer: not built (run \`${cmd("graft build --deep")}\` for concept nodes); the wiring graph is the source of truth`,
        );
      } else {
        console.log(formatCheckReport(r, label));
      }
      if (!g.missing) console.log("\n" + formatGraphCheckReport(g));
    }

    if (bothMissing || markdownFail || wiringFail) process.exit(1);
}

// Under trail this is part of `status`; the old name still runs, unlisted.
program
  .command("stats", { hidden: TRAIL })
  .description(`Show this agent session's ${brand()}-vs-source usage mix and tokens saved`)
  .argument(...DIR_ARG)
  .option("--json", "output the session stats as JSON")
  .action((dirArg: string | undefined, opts: { json?: boolean }) => {
    // Reads local session JSON only — no graph, no network. This is how a Cursor
    // user (no statusline) sees the numbers the Claude Code bar would show, and it
    // works under DO_NOT_TRACK because it never touches telemetry.
    const dir = queryRoot(dirArg);
    const s = latestSession(dir);
    if (opts.json) {
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    console.log(formatSessionStats(s));
  });

program
  .command("viz", { hidden: TRAIL })
  .description("Serve an interactive visualization of the context graph (and graph.json when present)")
  .argument(...DIR_ARG)
  .option("-p, --port <port>", "port to serve on", "4400")
  .option("--no-open", "don't open the browser")
  .option("--repos <list...>", "workspace: show only these child repos (space or comma separated, e.g. frontend backend)")
  .option("--skip <list...>", "workspace: exclude these child repos (space or comma separated)")
  .option("--include-tests", "include test files in the graph (excluded by default)")
  .option("--export <dir>", "write one self-contained index.html instead of serving (for CI, GitHub Pages, or a build artifact)")
  .option("--title <text>", "subtitle shown beside the repo name in an exported page (e.g. \"PR #151\")")
  .option("--tabs <list>", "tabs the exported page offers, comma separated: context,code,outline (default: all three)")
  .action(async (dirArg: string | undefined, opts: { port: string; open: boolean; repos?: string[]; skip?: string[]; includeTests?: boolean; export?: string; title?: string; tabs?: string }) => {
    // Flags are checked before the repository is: a typo'd `--tabs` is a mistake
    // in the command the caller just typed, and telling them to go build an index
    // first sends them off to fix the wrong thing.
    const tabs = parseTabs(opts.tabs);
    const dir = noteQuery(queryRoot(dirArg));
    const { existsSync } = await import("node:fs");
    const { resolve, basename } = await import("node:path");
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { contextDirFor } = await import("./context/node-file.js");
    const { startVizServer } = await import("./viz/serve.js");

    const root = resolve(dir);
    const globalOpts = program.opts<{ dir?: string }>();
    let contextDir = contextDirFor(root, globalOpts.dir);
    let federatedWiringPath: string | null = null;

    // Workspace: federate all children's wiring.json into a single in-memory file for viz.
    const { readWorkspace: readWs } = await import('./graph/workspace.js');
    const ws = readWs(root);
    if (ws && ws.children.length > 0) {
      const { join: pj } = await import('node:path');
      const { writeFileSync, mkdirSync, readFileSync: rfs } = await import('node:fs');
      // Apply --only / --exclude filters.
      const onlySet = opts.repos?.length ? new Set(opts.repos.flatMap((s: string) => s.split(/[,\s]+/)).map((s: string) => s.trim()).filter(Boolean)) : null;
      const excludeSet = opts.skip?.length ? new Set(opts.skip.flatMap((s: string) => s.split(/[,\s]+/)).map((s: string) => s.trim()).filter(Boolean)) : null;
      // [DEBUG removed]
      const children = ws.children.filter(c => {
        const name = c.replace(/\//g, '/'); // keep as-is for matching
        if (onlySet && !onlySet.has(c) && !onlySet.has(c.split('/').pop()!)) return false;
        if (excludeSet && (excludeSet.has(c) || excludeSet.has(c.split('/').pop()!))) return false;
        return true;
      });
      if (onlySet || excludeSet) console.error(`· workspace viz: showing ${children.length}/${ws.children.length} repos: ${children.join(', ')}`);
      const allNodes: unknown[] = [];
      const allEdges: unknown[] = [];
      const allLangs = new Set<string>();
      let childrenWithGraph = 0;
      for (const child of children) {
        const childCtx = contextDirFor(pj(root, child));
        const wiringPath = pj(childCtx, '.graph', 'wiring.json');
        if (!existsSync(wiringPath)) continue;
        try {
          const w = JSON.parse(rfs(wiringPath, 'utf8'));
          if (w?.meta?.version !== 1) continue;
          const isTestPath = (p: string) => /\.(test|spec)\.[jt]sx?$|[\\/](__tests__|tests?|specs?)[\\/]|\.Tests\.cs$/i.test(p);
          const filterNode = (n: any) => opts.includeTests || !isTestPath(n.path ?? n.id ?? '');
          const filteredNodes = (w.nodes ?? []).filter(filterNode);
          const filteredIds = new Set(filteredNodes.map((n: any) => `${child}/${n.id}`));
          // Prefix node ids and paths with child name to avoid collisions.
          for (const n of filteredNodes) allNodes.push({ ...n, id: `${child}/${n.id}`, path: n.path ? `${child}/${n.path}` : n.path });
          for (const e of (w.edges ?? [])) {
            const src = `${child}/${e.source}`, tgt = `${child}/${e.target}`;
            if (filteredIds.has(src) && filteredIds.has(tgt)) allEdges.push({ ...e, source: src, target: tgt });
          }
          for (const l of (w.meta?.languages ?? [])) allLangs.add(l);
          childrenWithGraph++;
        } catch { /* skip broken child */ }
      }
      if (childrenWithGraph > 0) {
        const federated = { meta: { version: 1, nodeCount: allNodes.length, edgeCount: allEdges.length, languages: [...allLangs] }, nodes: allNodes, edges: allEdges };
        const tmpDir = pj(contextDir, '.graph');
        mkdirSync(tmpDir, { recursive: true });
        // Write as wiring.json so startVizServer finds it at the expected path (Code tab).
        const tmpPath = pj(tmpDir, 'wiring.json');
        writeFileSync(tmpPath, JSON.stringify(federated));
        federatedWiringPath = tmpPath;
        // Federation of context cards (.md) for the Context tab.
        const { readdirSync, copyFileSync } = await import('node:fs');
        for (const child of children) {
          const childCtx = contextDirFor(pj(root, child));
          if (!existsSync(childCtx)) continue;
          try {
            for (const f of readdirSync(childCtx)) {
              if (!f.endsWith('.md')) continue;
              copyFileSync(pj(childCtx, f), pj(contextDir, `${child.replace(/\//g, '__')}__${f}`));
            }
          } catch { /* skip */ }
        }
        console.error(`· workspace viz: federating ${childrenWithGraph} repos (${allNodes.length} nodes, ${allEdges.length} edges)`);
      }
    }
    if (!existsSync(contextDir)) {
      console.error(`✗ no context graph at ${contextDir}: run \`${cmd("graft build --deep")}\` first`);
      process.exit(1);
    }
    const viewerDir = fileURLToPath(new URL("./viewer/", import.meta.url)); // prebuilt

    // Filter tests from wiring.json unless --include-tests (applies to single repo and workspace).
    const isTestPath = (p: string) => /\.(test|spec)\.[jt]sx?$|[\\/](__tests__|tests?|specs?)[\\/]|\.Tests\.cs$/i.test(p ?? '');
    let wiringOverride: string | undefined;
    if (!opts.includeTests) {
      const { readFileSync: rfs2, writeFileSync: wfs2, mkdirSync: mks2 } = await import('node:fs');
      const { join: pj2 } = await import('node:path');
      const srcWiring = pj2(contextDir, '.graph', 'wiring.json');
      if (existsSync(srcWiring)) {
        try {
          const w = JSON.parse(rfs2(srcWiring, 'utf8'));
          if (w?.meta?.version === 1) {
            const filteredNodes = (w.nodes ?? []).filter((n: any) => !isTestPath(n.path ?? n.id ?? ''));
            const filteredIds = new Set(filteredNodes.map((n: any) => n.id));
            const filteredEdges = (w.edges ?? []).filter((e: any) => filteredIds.has(e.source) && filteredIds.has(e.target));
            const filtered = { ...w, meta: { ...w.meta, nodeCount: filteredNodes.length, edgeCount: filteredEdges.length }, nodes: filteredNodes, edges: filteredEdges };
            const tmpPath = pj2(contextDir, '.graph', 'wiring-viz.json');
            mks2(pj2(contextDir, '.graph'), { recursive: true });
            wfs2(tmpPath, JSON.stringify(filtered));
            wiringOverride = tmpPath;
            const removed = (w.nodes ?? []).length - filteredNodes.length;
            if (removed > 0) console.error(`· viz: ${removed} test nodes hidden (use --include-tests to show)`);
          }
        } catch { /* skip — serve original */ }
      }
    }

    if (opts.export) {
      const { exportViz } = await import("./viz/export.js");
      const out = exportViz({
        contextDir,
        viewerDir,
        outDir: resolve(opts.export),
        repoName: basename(root),
        subtitle: opts.title,
        tabs,
      });
      const kb = Math.round(out.bytes / 1024);
      console.log(
        `${cmd("graft viz")} → ${out.file} (${kb} kB, ${out.contextNodes} concept nodes, ${out.codeNodes} code nodes)`,
      );
      return;
    }

    const srv = await startVizServer({
      contextDir,
      viewerDir,
      port: Number(opts.port),
      repoName: basename(root),
      wiringOverride,
    });
    console.log(`${cmd("graft viz")} → ${srv.url}  (ctrl-c to stop)`);
    if (opts.open) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [srv.url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
    }
  });

program
  .command("mcp", { hidden: TRAIL })
  .description("Serve the graph over MCP (stdio): exposes graft_find_code, graft_trace_calls, graft_find_all, graft_file_api, graft_repo_map, graft_check_freshness and graft_search_semantic as tools")
  .argument(...DIR_ARG)
  .option("--brains", "serve only the paired Trail workspace's tools and skills (what Claude Code gets after init --connect)")
  .action(async (dirArg: string | undefined, opts: { brains?: boolean }) => {
    const { startMcpServer } = await import("./mcp/server.js");
    if (opts.brains) {
      startMcpServer(process.cwd(), undefined, currentVersion, { brainsOnly: true });
      return;
    }
    const dir = noteQuery(queryRoot(dirArg));
    const globalOpts = program.opts<{ dir?: string }>();
    startMcpServer(dir, globalOpts.dir, currentVersion);
  });

grouped(program.command("callers"), GROUP.find)
  .description(
    "Who calls/references a symbol ($0, no LLM). --direction out gives callees (what it calls); --depth N (or all) walks transitively for full blast radius",
  )
  .argument("<symbol>", "bare name, qualified (Class.method), or package-qualified (pkg.Fn)")
  .argument(...DIR_ARG)
  .option("--direction <in|out>", 'edge direction: "in" = callers (default), "out" = callees')
  .option("-d, --depth <n>", 'walk transitively up to N hops for blast radius, or "all" for the full connected closure (default 1)')
  .option("--in <path>", "narrow matches to nodes at or under this path prefix")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(
    async (
      symbol: string,
      dirArg: string | undefined,
      opts: { direction?: string; depth?: string; in?: string; json?: boolean; refresh?: boolean },
    ) => {
      const dir = noteQuery(queryRoot(dirArg));
      await refreshBefore(dir, opts);
      const globalOpts = program.opts<{ dir?: string }>();
      if (!opts.json && readWorkspace(dir, globalOpts.dir)) {
        runWorkspaceCallers(dir, globalOpts.dir, symbol, {
          direction: opts.direction === "out" ? "out" : "in",
          depth: opts.depth
            ? (/^(all|full|max)$/i.test(opts.depth) ? Number.POSITIVE_INFINITY : Number(opts.depth))
            : undefined,
          in: opts.in,
        });
        return;
      }
      const { runCallersCommand } = await import("./graph/traverse-cli.js");
      runCallersCommand(symbol, dir, {
        direction: opts.direction,
        depth: opts.depth,
        in: opts.in,
        json: opts.json,
        globalDir: globalOpts.dir,
      });
    },
  );

grouped(program.command("blast"), GROUP.ci)
  .description(
    "Blast radius of a diff: what depends on the lines this change touched ($0, no LLM). " +
      "Built for CI: `--format markdown` is a PR comment with a Mermaid diagram.",
  )
  .argument(...DIR_ARG)
  .option("--base <ref>", "diff against this ref's merge base with HEAD (e.g. origin/main); default: the working tree vs HEAD")
  .option("-d, --depth <n>", 'hops to walk over incoming edges, or "all" for the full closure (default 2)')
  .option("--format <fmt>", "text (default) | markdown | mermaid | json")
  .option("--name", "name the affected areas with one cached LLM call (needs GRAFT_API_KEY); without it, areas are named after their hub symbol")
  .option("--export-viz <dir>", "also write the interactive page for this radius (one self-contained index.html, for CI, GitHub Pages, or an artifact)")
  .option("--title <text>", "subtitle beside the repo name on the exported page (e.g. \"PR #171\")")
  .option("--no-owners", "do not suggest who to tag (by default, git history names the people behind each affected area)")
  .option("--pr-author <who...>", "GitHub login, git name or email of the PR author, so they are left out of their own suggestions")
  .option(...NO_REFRESH_FLAG)
  .action(async (dirArg: string | undefined, opts: { base?: string; depth?: string; format?: string; name?: boolean; exportViz?: string; title?: string; owners?: boolean; prAuthor?: string[]; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const { runBlastCommand } = await import("./blast/blast-cli.js");
    await runBlastCommand(dir, {
      base: opts.base,
      depth: opts.depth,
      format: opts.format,
      name: opts.name,
      exportViz: opts.exportViz,
      title: opts.title,
      owners: opts.owners,
      prAuthor: opts.prAuthor,
      globalDir: program.opts<GlobalOpts>().dir,
    });
  });

grouped(program.command("grep"), GROUP.find)
  .description("Regex search over indexed files, hits grouped by enclosing symbol and ranked by coupling ($0, no LLM)")
  .argument("<pattern>", "regex pattern (or literal string with --fixed)")
  .argument(...DIR_ARG)
  .option("-i, --ignore-case", "case-insensitive match")
  .option("--fixed", "treat pattern as a literal string, not a regex")
  .option("--in <path>", "narrow to files at or under this path prefix")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(
    async (
      pattern: string,
      dirArg: string | undefined,
      opts: { ignoreCase?: boolean; fixed?: boolean; in?: string; json?: boolean; refresh?: boolean },
    ) => {
      const dir = noteQuery(queryRoot(dirArg));
      await refreshBefore(dir, opts);
      const globalOpts = program.opts<{ dir?: string }>();
      if (readWorkspace(dir, globalOpts.dir)) {
        runWorkspaceGrep(dir, globalOpts.dir, pattern, {
          ignoreCase: opts.ignoreCase, fixed: opts.fixed, json: opts.json,
        });
        return;
      }
      const { runGrepCommand } = await import("./search/grep-cli.js");
      runGrepCommand(pattern, dir, {
        ignoreCase: opts.ignoreCase,
        fixed: opts.fixed,
        in: opts.in,
        json: opts.json,
        globalDir: globalOpts.dir,
      });
    },
  );

grouped(program.command("map"), GROUP.find)
  .description(
    "Token-budgeted repo orientation: directory clusters, per-directory hubs, and global hotspots from the wiring graph ($0, no LLM)",
  )
  .argument(...DIR_ARG)
  .option("--max-dirs <n>", "max directory entries shown, rest counted into dropped (default 16)")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(async (dirArg: string | undefined, opts: { json?: boolean; maxDirs?: string; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    const root = resolve(dir);
    const globalOpts = program.opts<{ dir?: string }>();
    let maxDirsW: number | undefined;
    if (opts.maxDirs !== undefined) {
      const n = parseInt(opts.maxDirs, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`✗ --max-dirs must be a positive integer, got "${opts.maxDirs}"`);
        process.exit(1);
        return;
      }
      maxDirsW = n;
    }
    await refreshBefore(dir, opts); // after arg validation: a bad flag shouldn't cost a rebuild
    if (!opts.json && readWorkspace(root, globalOpts.dir)) {
      runWorkspaceMap(root, globalOpts.dir, { maxDirs: maxDirsW });
      return;
    }
    const { buildRepoMap, formatRepoMap } = await import("./graph/map.js");
    const contextDir = contextDirFor(root, globalOpts.dir);
    const graph = loadGraphCached(contextDir);
    if (!graph) {
      console.error(`✗ no graph: run ${cmd("graft build")} first`);
      process.exit(1);
      return;
    }
    const map = buildRepoMap(graph, { maxDirs: maxDirsW });
    if (opts.json) {
      console.log(JSON.stringify(map, null, 2));
      return;
    }
    process.stdout.write(formatRepoMap(map));
  });

// `trail note`: what a session worked out, saved for the next person. Listed
// under trail; under graft it still runs, unlisted, for a teammate on graft in
// a repo where someone else set up trail.

/** Lines that close a command's output, with a blank line before them. */
function printLines(lines: string[]): void {
  if (lines.length) console.log(`\n${lines.join("\n")}`);
}

/** `graft init`'s flags, as commander hands them over. */
interface InitOptions { build?: boolean; agents?: string[]; allAgents?: boolean; listAgents?: boolean; mcp?: boolean; dryRun?: boolean; yes?: boolean; global?: boolean; verbose?: boolean }

/** Repo-relative with forward slashes, for printing. */
function shown(repo: string, path: string): string {
  return relative(repo, path).split("\\").join("/");
}

/**
 * The agents `init` supports: Claude Code, and Hermes Agent. Everything else
 * (cursor, gemini, codex, opencode, antigravity, …) was amputated from the
 * binary's surface — `--agents cursor` is an unknown id, not a silent no-op. The
 * registry still describes those hosts by name so `uninstall` keeps knowing the
 * files they used to write (hosts/retract.ts), but init never wires them.
 */
const SUPPORTED_AGENTS = ["claude", "hermes"] as const;

function supported(id: string): boolean {
  return (SUPPORTED_AGENTS as readonly string[]).includes(id);
}

/** `graft init`. */
async function runInitCommand(dir: string, opts: InitOptions, progress?: { mapped?: (m: { nodes: number; edges: number; files: number }) => void }): Promise<{ ids: string[]; laptop: string[] } | null> {
    if (opts.listAgents) {
      for (const id of SUPPORTED_AGENTS) console.log(id);
      return null;
    }
    const repo = resolve(dir);
    // `--agents auto`: the website's one setup prompt, run by an agent with no one to ask.
    const asked = Array.isArray(opts.agents) ? opts.agents : undefined;
    const auto = asked?.includes("auto") === true;
    if (auto && asked!.length > 1) {
      console.error("✗ --agents auto picks the agents itself: give it on its own, or name the agents instead");
      process.exit(1);
    }
    // No aliases any more: the only ids init knows are the supported ones.
    const explicit = asked && !auto ? [...new Set(asked)] : undefined;

    // Checked before anything is written: run from the home folder, init wired
    // it, mapped every code file under it, then said to commit.
    const refusal = homeFolderRefusal(repo);
    if (refusal) {
      console.error(refusal);
      process.exitCode = 1;
      return null;
    }
    // Trail's page shares a repo with the team: removed in trail-solo-grafo.

    if (explicit) {
      const validIds = [...SUPPORTED_AGENTS];
      const unknown = explicit.filter((id) => !supported(id));
      if (unknown.length) {
        console.error(`✗ unknown agent id(s): ${unknown.join(", ")}; valid: ${validIds.join(", ")}`);
        process.exit(1);
      }
    }

    // Which agents to wire, decided before anything is written. Explicit flags
    // win; otherwise prompt on a TTY, and on a pipe write nothing rather than
    // guessing (pre-0.8 this silently wired every agent the machine had ever
    // installed — see --yes to get that back).
    const home = homedir();
    const plan = planInit(repo, { home });
    // Only the supported agents are offered: another agent may be installed on
    // this machine (the registry still knows it, so `uninstall` can clean it),
    // but init cannot wire it any more.
    const detectedIds = plan.filter((p) => p.detected).map((p) => p.id).filter(supported);
    const noAgents = (opts as { agents?: unknown }).agents === false;

    // auto: the main agents' repo files plus the laptop's; out-of-repo writes only for `laptop`, the agents installed here and the caller.
    const autoSel = auto ? autoSelection({ home, repo }) : null;
    const laptop = autoSel?.laptop.filter(supported);
    let ids: string[];
    // The consent answer from the picker. Undefined everywhere else — a scripted
    // or flag-driven init never asked, so it must not silently answer.
    let consent: boolean | undefined;
    if (autoSel) ids = [...autoSel.repo, ...SUPPORTED_AGENTS];
    else if (explicit) ids = explicit;
    else if (opts.allAgents) ids = [...SUPPORTED_AGENTS];
    else if (noAgents) ids = ["claude"];
    else if (opts.yes || opts.dryRun) ids = detectedIds;
    else if (process.stdin.isTTY && process.stderr.isTTY) {
      // Only offer the row when telemetry could actually run. `disabled` still
      // counts: someone who turned it off should be able to turn it back on here.
      const reason = offReason();
      const picked = await runPicker(plan, repo, home, {
        offerTelemetry: reason === null || reason === "disabled",
      });
      if (picked === null) {
        console.error("· cancelled, nothing written");
        return null;
      }
      ids = picked.hosts;
      consent = picked.telemetry;
    } else {
      console.error(formatNonInteractiveHelp(detectedIds));
      return null;
    }

    // One gate for every path above (picker included): nothing outside the
    // supported surface is ever wired or stamped.
    ids = [...new Set(ids.filter(supported))];

    // The picker's answer, recorded before anything is wired: a user who
    // unchecked the row must not have this run's init_completed sent.
    if (consent !== undefined) {
      patchState({ enabled: consent, noticeShownAt: new Date().toISOString() });
    }

    // Knowledge repo prompt removed in trail-solo-grafo.

    // Workspace parent: every child repo gets its OWN wiring too.
    // opens at a repo root, not at the parent, and reads `.claude/` from there —
    // wiring only the parent leaves each child with no skill, hooks, or MCP.
    // The parent's own wiring stays (queries there federate across children).

    // Knowledge repo cloning removed in trail-solo-grafo.

    const children = isWorkspaceBuildRoot(repo, program.opts<GlobalOpts>().dir)
      ? discoverWorkspaceChildren(repo)
      : [];
    // Parent FIRST: its build is the workspace build, which builds every child's
    // graph, so each child's own `buildGraphIfMissing` then finds one and no-ops.
    const targets = [repo, ...children.map((c) => join(repo, c))];

    if (opts.dryRun) {
      if (autoSel) {
        const here = autoSel.agents.filter((a) => supported(a));
        console.error(`· --agents auto: repo files for Claude Code and Hermes; laptop settings for ${here.length ? agentList(here) : "none (no agent found here)"}\n`);
      }
      console.error(formatPlan(laptopOnly(plan, laptop), ids, repo, home));
      for (const child of children)
        console.error(`\n· ${child}/ (workspace child)\n` + formatPlan(laptopOnly(planInit(join(repo, child), { home }), laptop), ids, join(repo, child), home));
      return null;
    }
    if (ids.length === 0) {
      console.error("· no agents selected, nothing written");
      return null;
    }

    const wantClaude = ids.includes("claude");
    const cliPath = fileURLToPath(import.meta.url);

    // Say it out loud: wiring a workspace parent writes into every child repo, and
    // silence here reads as "only the parent was touched".
    if (children.length > 0)
      console.error(`· workspace: wiring ${repo} and ${children.length} child repo(s): ${children.join(", ")}`);

    // Wire each target repo.
    for (const target of targets) {
      const targetPlan = target === repo ? plan : planInit(target, { home });
      const wr = wireTarget(target, ids, {
        home,
        cliPath,
        plan: targetPlan,
        wantClaude,
        opts: { build: opts.build, mcp: opts.mcp, global: opts.global },
        quiet: targets.length > 1,
        laptop,
      });
      for (const w of wr.warnings) console.error(w);
    }

    // Build graph (builds all targets in workspace mode).
    if (opts.build !== false) {
      const { buildGraphWithProgress: bgp } = await import('./claude/build-progress.js');
      await bgp(repo, { build: opts.build, cliPath, childCount: children.length });
    }

    // teamSaved/LEARNINGS_DIR removed in trail-solo-grafo.
    // Sorted so `claude,cursor` and `cursor,claude` aggregate as one value.
    track(
      "init_completed",
      { agents: [...ids].sort().join(","), consent: consent === undefined ? "unasked" : String(consent) },
      { repo },
    );
    return { ids, laptop: laptop ?? ids };
}

/** A plan with the out-of-repo writes only for `laptop`'s hosts; the plan itself when every host may write there. */
function laptopOnly(plan: ReturnType<typeof planInit>, laptop: string[] | undefined): ReturnType<typeof planInit> {
  if (!laptop) return plan;
  return plan.map((p) => (laptop.includes(p.id) ? p : { ...p, writes: p.writes.filter((w) => w.scope === "repo") }));
}

/**
 * `trail init --connect <CODE>`: the onboarding on team.trailhq.com. Claims the
 * one-time code (a wrong or spent one stops here, before anything is written),
 * saves the workspace token where `trail login` keeps it, then runs init as
 * usual while the page ticks off connected, mapped and learned. At the end,
 * one summary of the repo goes up (a lookup's tokens saved, the learnings'
 * titles, teammates' branches from git: never code, diffs or session text),
 * then `done`. Offline, init still sets the repo up and says how to connect.
 */
/** What one target's wiring did, for the compact summary to report. */
interface WireReport {
  /** Hosts whose files were removed because they were not selected. */
  retracted: string[];
  /** ⚠ lines, printed in full. */
  warnings: string[];
}

/** One repo's worth of `init` writes — the parent, then each workspace child. */
function wireTarget(
  repo: string,
  ids: string[],
  ctx: {
    home: string;
    cliPath: string;
    plan: ReturnType<typeof planInit>;
    wantClaude: boolean;
    opts: { build?: boolean; mcp?: boolean; global?: boolean };
    /** Collect warnings and removals instead of printing a line per file, and
     *  leave the graph build to the caller (see buildGraphWithProgress). */
    quiet?: boolean;
    /** When given, only these hosts write outside the repo (`--agents auto`). */
    laptop?: string[];
  },
): WireReport {
    const { home, cliPath, plan, wantClaude } = ctx;
    const quiet = ctx.quiet === true;
    const opts = quiet ? { ...ctx.opts, build: false } : ctx.opts;
    const report: WireReport = { retracted: [], warnings: [] };
    // Every per-file line goes through here; in quiet mode only ⚠ lines survive.
    const say = (line: string) => {
      if (!quiet) console.error(line);
      else if (line.startsWith("⚠")) report.warnings.push(line);
    };
    const wantStatusline = statuslineWanted();

    // Converge, don't just add. init writes the selected hosts; without this it
    // never touches the rest, so a repo wired by an older version (or by the same
    // version with different --agents) keeps that run's files forever — and
    // `reconcileWiring` then keeps them *up to date*, which is worse than stale.
    // Retract every host NOT being written now; `exclude` spares the ones about to
    // be rewritten, and the graph cache is kept (init is one step from using it).
    const retracted = changed(
      runRetract(repo, { home, apply: true, global: opts.global, cache: false, exclude: ids }),
    ).filter((r) => r.action !== "skipped-unparseable");
    for (const r of retracted) say(`- removed ${r.path} (${r.what}): agent not selected`);
    report.retracted = [...new Set(retracted.map((r) => r.hostId))];

    if (wantClaude) {
      // `global`/`home` are threaded through alongside `statusline`: the claude layer
      // writes under `~/.claude` now (hosts/claude-global.ts), so --no-global has to
      // reach it or the flag would silently mean "no out-of-repo writes, except three".
      const claudeGlobal = opts.global !== false && (!ctx.laptop || ctx.laptop.includes("claude"));
      const res = runInit(repo, { build: opts.build, cliPath, statusline: wantStatusline, global: claudeGlobal, home, brand: brand() });
      if (res.settingsPath) say(`✓ wrote ${res.settingsPath}`);
      for (const s of res.shims) say(`✓ wrote ${s}`);
      if (res.skill) say(`✓ wrote ${res.skill}`);
      if (!res.mcp) {
        // trail registers no server for Claude Code: the hooks and the `trail` command cover it.
      } else if (res.mcp.action === "skipped-unparseable")
        say(`⚠ .mcp.json: ${res.mcp.path} left unchanged (not valid JSON); add the graft server manually`);
      else if (res.mcp.action === "unchanged")
        say(`· mcp claude: ${res.mcp.path} (already registered)`);
      else
        say(`✓ mcp claude: ${res.mcp.path} (${res.mcp.action}); restart Claude Code to load the graft MCP server`);
      say(res.built ? `✓ built the graph (${cmd("graft build")})` : "· skipped graph build");
      if (!wantStatusline) say("· skipped Claude Code statusLine (GRAFT_NO_STATUSLINE)");
      for (const w of res.warnings) say(`⚠ ${w}`);
    }

    // `ids` is already resolved and limited to the supported agents, so hosts
    // init is always driven by an explicit list — never by its own detection
    // fallback. Claude Code is handled above; Hermes is the only other host the
    // fork wires (its AGENTS.md section and its skill under ~/.hermes/skills).
    const others = ids.filter((id) => id === "hermes");
    if (others.length > 0) {
      const r = runHostsInit(repo, {
        agents: others,
        home,
        mcp: opts.mcp,
        global: opts.global,
        laptop: ctx.laptop,
        brand: brand(),
      });
      for (const w of r.written) say(`✓ ${w.id}: ${w.path} (${w.action})`);
      for (const m of r.mcp) say(`✓ mcp ${m.id}: ${m.path} (${m.action})`);
      for (const h of r.hooks) say(`✓ hook ${h.id}: ${h.path} (${h.action})`);

      // Only worth saying when there was actually something out-of-repo to skip.
      if (opts.global === false && selectedWrites(plan, ids).some((w) => w.scope === "global"))
        say("· skipped out-of-repo writes (--no-global)");
    }

    // Record WHICH graft wrote this repo's agent files, and under which flags.
    // Every entry point compares this against the running binary and re-writes
    // them on a mismatch, so an `npm i -g` upgrade reaches the hooks/skill/rules
    // too — not just the binary. The flags ride along so a refresh replays the
    // user's choices (notably --no-global) instead of overriding them.
    writeStamp(repo, currentVersion, ids, {
      global: opts.global !== false,
      mcp: opts.mcp !== false,
      hooks: false,
      statusline: wantStatusline,
      ...(ctx.laptop ? { laptop: ctx.laptop } : {}),
    });

    // Every host's wiring points at graft/, so the graph is built whatever was
    // selected — not only when Claude Code is in the list (runInit does its own).
    if (!wantClaude) {
      if (!quiet)
        say(
          buildGraphIfMissing(repo, { build: opts.build, cliPath })
            ? `✓ built the graph (${cmd("graft build")})`
            : "· skipped graph build",
        );
    }
    return report;
}

/** Group a retraction report by host, so the output reads as "what leaves each agent". */
function formatRetractions(rs: Retraction[], apply: boolean): string {
  const hit = changed(rs);
  if (hit.length === 0) return inBrand("· nothing to remove: no graft wiring found here");
  const verb = apply ? "removed" : "would remove";
  const lines: string[] = [];
  const byHost = new Map<string, Retraction[]>();
  for (const r of hit) {
    const k = byHost.get(r.hostId) ?? [];
    k.push(r);
    byHost.set(r.hostId, k);
  }
  for (const [host, items] of byHost) {
    lines.push(`\n${host}:`);
    for (const r of items) {
      const mark =
        r.action === "skipped-unparseable"
          ? "⚠"
          : r.action === "deleted"
            ? "-"
            : "~";
      const note =
        r.action === "skipped-unparseable"
          ? ": not valid JSON, left untouched (remove the graft entry by hand)"
          : r.action === "deleted"
            ? ` (${r.what}, deleted)`
            : ` (${r.what})`;
      const scope = r.scope === "global" ? " [machine-wide]" : "";
      lines.push(`  ${mark} ${verb}: ${r.path}${scope}${note}`);
    }
  }
  return lines.join("\n").replace(/^\n/, "");
}

grouped(program.command("init"), GROUP.setup)
  .description(TRAIL
    ? "Wire trail into your agents: AGENTS.md, .trail/ directory and Hermes skill"
    : "Wire Graft into the AI coding agents used with this repo")
  .argument("[dir]", "target repo directory", ".")
  .option("--agents <ids...>", "agent ids to wire (claude, hermes)")
  .option("--all-agents", "wire every supported agent")
  .option("--list-agents", "print the supported agent ids and exit")
  .option("--no-build", "skip the graph build (wire only)")
  .option("--no-mcp", "skip MCP server registration")
  .option("--yes", "accept all defaults without prompting")
  .option("--dry-run", "print what would be written and exit")
  .option("--no-global", "skip out-of-repo writes (~/.claude, etc.)")
  .option("--verbose", "print the graph-build report when done")
  .action(async (dir: string, opts: InitOptions) => {
    const result = await runInitCommand(dir, opts);
    if (!result) return;
    if (opts.dryRun) return;
    console.error(`· restart your agents so a new session picks up ${brand()}`);
    if (TRAIL) console.error("· run `trail build` from this folder to update the code graph and semantic index");
  });

grouped(program.command("uninstall"), GROUP.setup)
  .description(`Remove every file and config entry ${TRAIL ? "trail or graft" : "graft"} has written to this repo (the inverse of init)`)
  .argument("[dir]", "target repo directory", ".")
  .option("-y, --yes", "actually remove (without this, prints what it would remove and exits)")
  .option("--keep-cache", "keep graft/ and the .gitignore entries: wiring only")
  .option("--no-global", "leave out-of-repo files alone (~/.codex, ~/.gemini)")
  .action((dir: string, opts: { yes?: boolean; keepCache?: boolean; global?: boolean }) => {
    const repo = resolve(dir);
    const home = homedir();
    const common = { home, global: opts.global, cache: opts.keepCache ? false : true };

    if (!opts.yes) {
      console.error(formatRetractions(planRetract(repo, common), false));
      console.error("\nDry run: nothing was touched. Re-run with -y to remove.");
      if (opts.global !== false)
        console.error("Entries marked [machine-wide] affect every project; --no-global skips them.");
      return;
    }
    const done = runRetract(repo, { ...common, apply: true });
    console.error(formatRetractions(done, true));
    const bad = changed(done).filter((r) => r.action === "skipped-unparseable");
    console.error(
      bad.length
        ? `\n⚠ ${bad.length} file(s) could not be parsed and were left as-is: see above.`
        : `\n✓ ${brand()} fully removed. \`${cmd("graft init")}\` re-wires from scratch.`,
    );
  });


/* -------------------------------------------------------------------------- */
/* trail login · logout · workspace                                           */
/* -------------------------------------------------------------------------- */

/**
 * `trail login`: sign this laptop in to a Trail workspace through the
 * browser. No code to copy: the link carries a fresh state, the person signs
 * in and allows it there, and this laptop claims its own token. In a
 * terminal it opens the browser and waits. Run by an agent, it prints the
 * link for the agent's reply and leaves a background wait to finish it, so
 * the agent never sits blocked. `--workspace` (or the repo's
 * `.trail/workspace.json`) picks the workspace on that page. A laptop
 * already signed in links another repo the same way, to the same
 * workspace or another one: each repo goes to one workspace.
 *
 * `--code` skips the browser: Trail's web app made the one-time code for the
 * person already signed in there, so the laptop trades it for its token
 * straight away.
 */
function savedThisWeek(repo: string, now = Date.now()): number {
  const since = now - 7 * 24 * 60 * 60 * 1000;
  let total = 0;
  for (const id of listSessionIds(repo)) {
    try {
      if (statSync(join(sessionDir(repo), `${id}.json`)).mtimeMs < since) continue;
    } catch {
      continue;
    }
    total += readSession(repo, id).savedTokens ?? 0;
  }
  return total;
}

/** 212345 → `212k`, 1_250_000 → `1.3M`. */
function shortCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * `trail status`: what was `graft stats`, on one
 * screen. The code map and whether it matches the code, the semantic index, the
 * workspace, and what the agents saved this week.
 */
function statusCommand(name = "status"): Command {
  return new Command(name)
    .description("Code map, freshness and tokens saved, on one screen")
    .argument(...DIR_ARG)
    .option("--json", "machine-readable output")
    .action(async (dirArg: string | undefined, opts: { json?: boolean }) => {
      const repo = queryRoot(dirArg);
      const globalDir = program.opts<GlobalOpts>().dir;
      const ws = readWorkspace(repo, globalDir);

      // ── Code-map: workspace aggregates across children, single-repo reads directly ──
      let totalNodes = 0;
      let builtRepos = 0;
      let totalRepos = 0;
      let missingRepos: string[] = [];
      let fresh: boolean | null = null;

      if (ws) {
        const wg = loadWorkspaceGraphs(repo, globalDir);
        builtRepos = wg.loaded.length;
        missingRepos = wg.missing;
        totalRepos = builtRepos + missingRepos.length;
        totalNodes = wg.loaded.reduce((s, l) => s + l.graph.meta.nodeCount, 0);
        // No per-child staleness check in status — treat built children as ok.
        fresh = builtRepos > 0 ? true : null;
      } else {
        const graph = loadGraphCached(contextDirFor(repo, globalDir));
        const g = graph ? await engineFrom().checkGraph(repo) : null;
        fresh = g && !g.missing ? g.ok : null;
        totalRepos = 1;
        if (graph) { totalNodes = graph.meta.nodeCount; builtRepos = 1; }
      }

      // Learnings and cloud sections removed in trail-solo-grafo.
      const saved = savedThisWeek(repo);

      // ── Semantic index: iterate children in workspace mode ─────────────────
      let semanticSymbols = 0;
      let semanticRepos = 0;
      {
        const { existsSync: fsExists } = await import('node:fs');
        const { join: pj } = await import('node:path');
        const { contextDirFor: ctxFor } = await import('./context/node-file.js');
        const { createRequire } = await import('node:module');
        const req = createRequire(import.meta.url);
        let Database: ((path: string, opts?: object) => { prepare: (q: string) => { get: () => unknown }; close: () => void }) | null = null;
        try { Database = req('better-sqlite3'); } catch { /* sqlite not available */ }

        if (Database) {
          const ctxDirs = ws
            ? ws.children.map((c) => ctxFor(join(repo, c)))
            : [ctxFor(repo, globalDir)];

          for (const ctxDir of ctxDirs) {
            const dbPath = pj(ctxDir, '.cache', 'embeddings.db');
            if (!fsExists(dbPath)) continue;
            try {
              const db = Database(dbPath, { readonly: true });
              const { c } = db.prepare('SELECT COUNT(*) AS c FROM embed_nodes').get() as { c: number };
              db.close();
              semanticSymbols += c;
              semanticRepos++;
            } catch { /* DB not readable — ignore */ }
          }
        }
      }

      // ── Output ─────────────────────────────────────────────────────────────
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              codeMap: builtRepos > 0 ? { nodes: totalNodes, repos: ws ? { built: builtRepos, total: totalRepos } : undefined, inSync: fresh } : null,
              week: { savedTokens: saved },
              semantic: semanticRepos > 0 ? { symbols: semanticSymbols, repos: semanticRepos, total: totalRepos } : null,
            },
            null,
            2,
          ),
        );
        return;
      }
      const fmt = (x: number) => x.toLocaleString("en-US");
      const row = (k: string, v: string) => console.log(`${k.padEnd(11)} ${v}`);

      // Code-map row
      if (builtRepos === 0) {
        row("code map", `✗ not built · run ${cmd("trail build")}`);
      } else if (ws) {
        const repoLabel = `${builtRepos} repo${builtRepos === 1 ? "" : "s"}`;
        if (missingRepos.length > 0) {
          row("code map", `⚠ ${repoLabel} of ${totalRepos} built · ${fmt(totalNodes)} nodes · ${cmd("trail build")} to cover ${missingRepos.join(", ")}`);
        } else {
          row("code map", `✓ ${repoLabel} · ${fmt(totalNodes)} nodes`);
        }
      } else if (fresh === false) {
        row("code map", `⚠ ${fmt(totalNodes)} nodes · behind the code, refreshed on the next query`);
      } else {
        row("code map", `✓ ${fmt(totalNodes)} nodes · in sync with the code`);
      }


      row("this week", saved > 0 ? `~${shortCount(saved)} tokens saved` : "nothing saved yet");

      // Semantic row
      if (semanticRepos === 0) {
        row("semantic", `✗ not built · run \`trail build\` to enable vector search`);
      } else if (ws) {
        row("semantic", `✓ ${fmt(semanticSymbols)} symbols · ${semanticRepos} of ${totalRepos} repos indexed`);
      } else {
        row("semantic", `✓ ${fmt(semanticSymbols)} symbols indexed · run \`trail build\` to refresh`);
      }


    });
}

if (TRAIL) {
  program.addCommand(statusCommand().helpGroup(GROUP.setup));

  // Help lists the groups in this order, and the commands within each.
  const order = ["ask", "grep", "skeleton", "callers", "map", "note", "check", "team", "skills", "init", "build", "status", "upgrade", "uninstall", "telemetry", "workspace", "login", "logout", "blast"];
  const rank = (c: Command) => {
    const i = order.indexOf(c.name());
    return i === -1 ? order.length : i;
  };
  (program.commands as Command[]).sort((a, b) => rank(a) - rank(b));

  // One line each in the list; `trail <command> --help` keeps the long text.
  const summaries: Record<string, string> = {
    ask: "ranked answer, with the code inlined at each file:line",
    grep: "every occurrence, grouped by enclosing symbol",
    skeleton: "a file's whole API in ~200 tokens",
    callers: "who calls it, or what it calls with --direction out",
    map: "directory clusters, hubs and hotspots",
    init: "wire trail into your agents",
    build: "rebuild the code map · --check fails if it's stale",
    status: "code map and semantic index",
    upgrade: "install the latest trail",
    uninstall: "remove everything trail or graft wrote to this repo",
    telemetry: "show or turn off the anonymous usage stats",
    blast: "what depends on the lines this diff touched",
  };
  for (const c of program.commands) if (summaries[c.name()]) c.summary(summaries[c.name()]!);
  program.addHelpText("after", "\ntrail <command> --help for flags · the same command set runs as `graft`");
}

program.parseAsync(process.argv).catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
