/**
 * `ensureFreshGraph` — the pre-query gate that keeps retrieval honest.
 *
 * A graph is a set of `file:line` spans for one working tree, so an answer drawn
 * from it is only as honest as its freshness. That cannot be somebody else's job:
 * an edit made outside the agent (your editor, a branch switch, a stash, a merge)
 * sets no flag anywhere. So freshness lives in the query path: every retrieval
 * call probes the working tree (`fingerprint.ts`, ~3ms) and, when something moved,
 * repairs the structural graph. Properties worth keeping:
 *
 * - **$0 and offline.** Tier-1 only — never a summarizer, never `--deep`. Anything
 *   that runs without being asked must not spend money.
 * - **Never fatal.** A failed refresh degrades to answering from the graph on
 *   disk. A query that works today must not start failing because a rebuild did.
 * - **Never a stampede.** It takes the same `.cache/.sync.lock` a background build
 *   takes, so concurrent MCP calls and the rebuild they trigger can't pile up.
 * - **Bounded.** Up to `DRIFT_INLINE_MAX` changed files are re-extracted before
 *   answering; more than that is handed to a background rebuild and the answer
 *   carries `[stale: N files changed, rebuilding in background]`. A branch switch
 *   never blocks a query.
 * - **Writes only what a query reads** (`graphOnly`): the graph, the `ask` sidecar,
 *   the freshness record. Not the markdown cards, not `INDEX.md`, not `.gitignore`.
 *   Those belong to an explicit `trail build`, so retrieval stays cheap and a read
 *   stays a read. `stats.json` is left alone too.
 * - **Lexical here, semantic elsewhere.** The inline repair updates the graph only.
 *   The vector index loads an ONNX model, so it refreshes in a detached process
 *   (`build-run.ts`) and never on the path that answers.
 *
 * One case is not drift but absence: inside a git worktree there is no graph at all,
 * because `.trail/`/`graft/` is gitignored and so was never checked out. The gate
 * covers that too — it copies the parent checkout's graph in (`./seed.ts`) and then
 * treats the difference between the two checkouts as ordinary drift, which is
 * exactly what it is.
 *
 * The other absence is a repo this machine never built: `trail init` ran somewhere
 * else, or the clone is new. Its queries find no code and the agent goes back to
 * grep for the rest of the session. So the first query there starts a full build in
 * the background and waits a while for it (`buildMissingMap`).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contextDirFor } from "../context/node-file.js";
import { isTrailMapDir } from "../context/map-dir.js";
import { homeFolderRefusal } from "../init-guard.js";
import { acquireLockIn, lockHeldIn, releaseLockIn } from "../util/state.js";
import { CACHE_DIR } from "../context/node-file.js";
import { buildGraph } from "./build.js";
import { BACKGROUND_TIMEOUT_MS, embeddingsDbPath } from "./build-run.js";
import { driftCount, isClean, probeDrift, readFingerprint, type Drift } from "./fingerprint.js";
import { invalidateGraphCaches } from "./load.js";
import { seedGraph, type SeedResult } from "./seed.js";
import { wiringPath } from "./write.js";
import { cmd, tag } from "../brand.js";

/**
 * Most files a query will re-extract before answering, instead of handing the
 * rebuild to a background process.
 *
 * A constant, not a flag: a merge or an ordinary edit of a handful of files stays
 * well under it and gets answered from a current graph; a branch switch or a fresh
 * clone blows past it, and blocking that query to re-parse hundreds of files is
 * exactly the cost this gate exists to avoid. See design decision 5.
 */
export const DRIFT_INLINE_MAX = 50;

/** How long to wait for another process's in-flight rebuild before giving up and
 * answering from the current graph. Long enough to ride out a small repo's build,
 * short enough that a tool call never feels hung. */
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 50;

/** How long a query waits for a repo's first build before answering without code.
 * A big repo (8k files) builds in about 75s, and the agent's shell gives a command
 * two minutes; a reply with code in it on the first try is worth the wait, once. */
const FIRST_BUILD_WAIT_MS = 90_000;
const FIRST_BUILD_POLL_MS = 250;
/** The first build's own time limit, well past the end-of-turn rebuild's two minutes. */
const FIRST_BUILD_TIMEOUT_MS = 10 * 60_000;

export interface RefreshResult {
  /** True when the graph on disk was rebuilt by this call. */
  refreshed: boolean;
  /** What the probe found, when it ran and found something. */
  drift?: Drift;
  /**
   * How many files changed when the drift was too large to patch inline, so the
   * rebuild went to the background and this answer is about the graph as it was.
   */
  stale?: number;
  /** One-line explanation for the agent/user, when there's something worth saying. */
  note?: string;
}

export interface RefreshOptions {
  contextDir?: string;
  /** Skip everything (the `--no-refresh` flag). */
  disabled?: boolean;
  /** How long to wait for a first build of a repo on trail; 0 starts it and answers
   * at once. Default `GRAFT_FIRST_BUILD_WAIT_MS`, else FIRST_BUILD_WAIT_MS. */
  firstBuildWaitMs?: number;
}

const CLEAN: RefreshResult = { refreshed: false };

/** Env kill switch, for CI or anyone who wants queries to never write. */
function envDisabled(): boolean {
  const v = process.env.GRAFT_NO_REFRESH;
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The wait for a first build: the option, else `GRAFT_FIRST_BUILD_WAIT_MS` (the hooks
 * set 0, since their own budget is seconds), else the default. */
function firstBuildWait(opts: RefreshOptions): number {
  if (opts.firstBuildWaitMs !== undefined) return opts.firstBuildWaitMs;
  const v = process.env.GRAFT_FIRST_BUILD_WAIT_MS;
  const ms = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(ms) && ms >= 0 ? ms : FIRST_BUILD_WAIT_MS;
}

/**
 * The detached rebuild runner: the compiled sibling this module ships with, or a
 * test's stand-in. Null when neither is on disk — the caller then answers from
 * whatever graph it has, which is the behaviour that predates all of this.
 */
function runnerPath(): string | null {
  const overridden = process.env.GRAFT_TEST_BUILD_RUN;
  if (overridden) return existsSync(overridden) ? overridden : null;
  const run = fileURLToPath(new URL("./build-run.js", import.meta.url));
  return existsSync(run) ? run : null;
}

/** Start `build-run` detached. The caller owns the lock contract (see below). */
function spawnJob(dir: string, outDir: string, mode: "full" | "graph" | "embed", timeoutMs: number): boolean {
  const run = runnerPath();
  if (!run) return false;
  const child = spawn(process.execPath, [run, mode, dir, outDir, String(timeoutMs)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => { /* the lock ages out, and the next query starts it again */ });
  child.unref();
  return true;
}

/**
 * Hand a rebuild to a background process, under the same lock every other rebuild
 * takes. False when nothing was started (no runner on disk, someone else already
 * rebuilding, or a `full` job whose lock we could not take).
 *
 * `graph` and `full` take the lock and the child releases it; `embed` takes none —
 * it only reads the graph and writes the vector index, and a query that answered
 * a moment ago is not going to race it for the graph.
 *
 * `embed` also refuses to create an index that isn't there: a repo that never ran
 * a semantic build must not start downloading a 400 MB model because someone
 * edited a file. It refreshes what exists, nothing more.
 */
function startBackgroundJob(dir: string, outDir: string, mode: "full" | "graph" | "embed"): boolean {
  if (mode === "embed") {
    if (!existsSync(embeddingsDbPath(outDir))) return false;
    return spawnJob(dir, outDir, mode, BACKGROUND_TIMEOUT_MS);
  }
  const lockCache = join(outDir, CACHE_DIR);
  if (lockHeldIn(lockCache)) return true; // someone is already rebuilding
  if (!acquireLockIn(lockCache)) return false;
  if (!spawnJob(dir, outDir, mode, mode === "full" ? FIRST_BUILD_TIMEOUT_MS : BACKGROUND_TIMEOUT_MS)) {
    releaseLockIn(lockCache);
    return false;
  }
  return true;
}

/**
 * Start a full `full` build of `dir`, for a repo on trail that has no map yet. The
 * caller holds the lock; the child releases it when the build ends, however it ends.
 */
function startFirstBuild(dir: string, outDir: string): boolean {
  if (lockHeldIn(join(outDir, CACHE_DIR))) return true;
  if (!acquireLockIn(join(outDir, CACHE_DIR))) return false;
  if (!spawnJob(dir, outDir, "full", FIRST_BUILD_TIMEOUT_MS)) {
    releaseLockIn(join(outDir, CACHE_DIR));
    return false;
  }
  return true;
}


/**
 * No graph here and none to copy in. A repo on trail gets one built: its team
 * committed `.trail/` and this person installed trail, so a build is what they
 * asked for, and answering "no matching nodes" sends the agent back to grep for
 * good. Anywhere else (a graft repo, a `--dir` map, the home folder) nothing is
 * built behind the user's back, as before.
 *
 * The first query to get here starts the build and waits up to `firstBuildWait`;
 * queries arriving meanwhile wait on the same lock. Returns a note when the map
 * is now there and the query should go on, or what to answer with when it isn't.
 */
async function buildMissingMap(dir: string, outDir: string, opts: RefreshOptions, busy?: boolean): Promise<string | RefreshResult> {
  const own = !opts.contextDir && !process.env.GRAFT_DIR && isTrailMapDir(dir, outDir) && homeFolderRefusal(dir) === null;
  if (!own) {
    return busy
      ? { refreshed: false, note: "another process is still copying the graph into this worktree — retry the query in a moment" }
      : CLEAN;
  }
  const lockCache = join(outDir, CACHE_DIR);
  const started = Date.now();
  // The lock free and still no map: nobody is building it, so this query starts it.
  // Taken here, released by the child.
  if (!startFirstBuild(dir, outDir)) {
    // Nothing to start, and nothing running either: say so below rather than waiting.
  }
  const deadline = started + firstBuildWait(opts);
  while (lockHeldIn(lockCache) && Date.now() < deadline) await sleep(FIRST_BUILD_POLL_MS);
  if (existsSync(wiringPath(outDir))) {
    invalidateGraphCaches(outDir);
    return `built this repo's code map for the first time (${Math.round((Date.now() - started) / 1000)}s)`;
  }
  if (lockHeldIn(lockCache)) {
    return {
      refreshed: false,
      note: "no code map here yet: building one in the background (about a minute on a big repo). Until it's done the answer has no code in it — run the same command again in a minute instead of rewording it",
    };
  }
  return { refreshed: false, note: `couldn't build this repo's code map — run \`${cmd("graft build")}\` to see why` };
}

/**
 * Release the lock if this process is asked to die while holding it. Returns the
 * un-hook.
 *
 * Not hypothetical: the Claude Code prompt hook runs `graft ask` with a timeout, and
 * `execFileSync` enforces it with SIGTERM. Node's default disposition for SIGTERM is
 * to exit without unwinding, so the `finally` below never runs and the lock outlives
 * the process — after which the background sync is blocked and every query waits and
 * then answers stale until the lock ages out. Ctrl-C on a CLI query is the same story
 * with SIGINT.
 *
 * Adding a listener replaces that default disposition, so re-raise it explicitly
 * afterwards: remove ourselves, then `process.kill(process.pid, sig)`, so the exit
 * status still says "terminated by signal" for whoever is waiting on us.
 */
export function releaseOnSignal(cache: string): () => void {
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  const onSignal = (sig: NodeJS.Signals) => {
    releaseLockIn(cache);
    for (const s of signals) process.removeListener(s, onSignal);
    process.kill(process.pid, sig);
  };
  for (const s of signals) process.once(s, onSignal);
  return () => {
    for (const s of signals) process.removeListener(s, onSignal);
  };
}

/** Wait out someone else's rebuild, then take the lock. False when we couldn't. */
async function waitForLock(cache: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (acquireLockIn(cache)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(LOCK_POLL_MS);
  }
}

/**
 * Copy a parent checkout's graph in, holding the same lock a rebuild would.
 *
 * Two MCP tool calls in a fresh worktree arrive here at the same moment, and an 8 MB
 * copy is long enough for both to start one. The loser waits, then finds the graph
 * already there and reports nothing — which is why the caller re-checks the file
 * rather than trusting this return value.
 */
async function seedUnderLock(
  dir: string,
  outDir: string,
  contextDir?: string,
): Promise<SeedResult & { busy?: boolean }> {
  const lockCache = join(outDir, CACHE_DIR);
  // `busy` matters: with no graph on disk there is nothing to fall back to, so a
  // caller that stayed silent here would emit the bare "no matching nodes" this whole
  // mechanism exists to remove. Say what happened instead.
  if (!(await waitForLock(lockCache))) return { seeded: false, busy: true };
  const unhook = releaseOnSignal(lockCache);
  try {
    return seedGraph(dir, { contextDir });
  } finally {
    unhook();
    releaseLockIn(lockCache);
  }
}

/**
 * Rebuild `root`'s structural graph if the working tree has moved since the last
 * build. Cheap and side-effect-free when nothing changed, which is the usual case.
 *
 * `root` is the repository root (the same value the query itself is given), not
 * the context dir.
 */
export async function ensureFreshGraph(root: string, opts: RefreshOptions = {}): Promise<RefreshResult> {
  if (opts.disabled || envDisabled()) return CLEAN;
  try {
    const dir = resolve(root);
    const outDir = contextDirFor(dir, opts.contextDir);
    let seededFrom: string | undefined;
    let builtNote: string | undefined;
    if (!existsSync(wiringPath(outDir))) {
      // One case has a graph to work with even though this checkout has none: a git
      // worktree, whose parent checkout's `graft/` git could not check out. Copy it
      // in and carry on — the drift below is then exactly the diff between the two
      // checkouts, and repairing it is what makes the copied graph honest here.
      const seed = await seedUnderLock(dir, outDir, opts.contextDir);
      seededFrom = seed.from;
      // Still nothing (not a worktree, parent never built, or a concurrent seed or
      // first build we lost the race for): a repo on trail gets its map built; any
      // other repo gets the caller's own "no graph — run graft build" message.
      if (!existsSync(wiringPath(outDir))) {
        const built = await buildMissingMap(dir, outDir, opts, seed.busy);
        if (typeof built !== "string") return built;
        builtNote = built;
      }
    }
    const seedNote = seededFrom ? `copied the graph from the main checkout (${seededFrom})` : builtNote;

    // null = no fingerprint at all: a graph built before this mechanism existed,
    // or by a different extractor build. Rebuild once — that lays the fingerprint
    // down, so it costs exactly one build, not one per query.
    const drift = probeDrift(dir, outDir);
    if (drift && isClean(drift)) return seedNote ? { refreshed: false, note: seedNote } : CLEAN;

    // Too much to patch before answering: a branch switch, a fresh checkout, a
    // merge of somebody else's work. Answer from the graph that is on disk, say it
    // is stale, and let a background process repair it — blocking here is what made
    // a query after `git switch` feel like a hang. The next query, once that build
    // lands, answers fresh with no note at all.
    //
    // Only when the handoff actually happened: if no background runner is on disk
    // (a half-installed CLI) the note would promise a rebuild that nobody is doing,
    // so the slower inline repair below is the honest answer.
    if (drift && driftCount(drift) > DRIFT_INLINE_MAX && startBackgroundJob(dir, outDir, "graph")) {
      return { refreshed: false, drift, stale: driftCount(drift) };
    }

    // The lock every rebuild takes, so two queries and a background build can never
    // rebuild the same graph at the same time.
    const lockCache = join(outDir, CACHE_DIR);
    if (!(await waitForLock(lockCache))) {
      const busy = "a graph rebuild is already in flight — answering from the current graph";
      return {
        refreshed: false,
        drift: drift ?? undefined,
        note: seedNote ? `${seedNote}; ${busy}` : busy,
      };
    }
    const unhook = releaseOnSignal(lockCache);
    try {
      // We may have queued behind another process's rebuild for up to LOCK_WAIT_MS,
      // and that rebuild very likely fixed the same drift we saw. Re-probe rather
      // than rebuild on the strength of a stale observation: without this, four
      // parallel MCP tool calls on one edited file produce four full rebuilds, three
      // of them pure waste, and the last tool call pays for all of it. A null drift
      // means "no fingerprint" and still has to build.
      const now = drift ? probeDrift(dir, outDir) : null;
      if (now && isClean(now)) {
        invalidateGraphCaches(outDir);
        return seedNote ? { refreshed: false, note: seedNote } : CLEAN;
      }
      // Tier-1 only: no summarizer, so no LLM call and no network, ever. And
      // `graphOnly`: write the graph, the ask sidecar and the fingerprint, nothing
      // else. The markdown projections under `graft/` stay the `Stop` hook's job —
      // a query has no business rewriting the repo's `.gitignore` or churning every
      // card's mtime, and skipping them is most of what keeps this cheap.
      // A `--only-dir` build recorded its whitelist in the fingerprint; re-apply it
      // here so an auto-rebuild keeps the same limited file set instead of silently
      // widening to the whole tree.
      const onlyDirs = readFingerprint(outDir)?.onlyDirs;
      await buildGraph(dir, { contextDir: opts.contextDir, graphOnly: true, onlyDirs });
      invalidateGraphCaches(outDir);
      // The vector index is the one thing that stays behind: loading the ONNX model
      // costs seconds and this was a lexical query. It refreshes out of process —
      // and only if the repo has an index to refresh (`startBackgroundJob`).
      startBackgroundJob(dir, outDir, "embed");
      return { refreshed: true, drift: drift ?? undefined, note: seedNote };
    } finally {
      unhook();
      releaseLockIn(lockCache);
    }
  } catch (err) {
    // Answering from a slightly stale graph beats failing the query.
    return { refreshed: false, note: `graph refresh skipped: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Workspace variant: refresh each child repo's own graph (a workspace parent holds
 * an index, never nodes). Children are independent, but they're refreshed in
 * sequence — a fan-out of concurrent tree-sitter builds would spike CPU on the
 * very path that's supposed to feel free.
 */
export async function ensureFreshChildren(
  root: string,
  children: string[],
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  if (opts.disabled || envDisabled()) return CLEAN;
  const refreshedIn: string[] = [];
  let files = 0;
  let staleFiles = 0;
  for (const child of children) {
    // Deliberately NOT `opts`: `contextDirFor` returns an override verbatim and
    // ignores the root it's handed, so forwarding the parent's `--dir` would point
    // every child at the *parent's* context dir — which holds a workspace index and
    // no wiring.json, so every child would silently be skipped. (And if it did hold
    // one, each child would build into that single shared dir in turn, the last
    // clobbering the rest.) A child's graph always lives in its own `<child>/graft`,
    // which is exactly how `loadWorkspaceGraphs` reads them back.
    const r = await ensureFreshGraph(resolve(root, child), { disabled: opts.disabled });
    if (r.stale !== undefined) staleFiles += r.stale;
    if (!r.refreshed) continue;
    refreshedIn.push(child);
    files += r.drift ? driftCount(r.drift) : 0;
  }
  // A workspace is as stale as its stalest child: the warning has to survive the
  // ranking, or an answer that cites some other child's fresh graph looks sound
  // while the one the user cares about is a branch behind.
  if (staleFiles > 0) return { refreshed: refreshedIn.length > 0, stale: staleFiles };
  if (!refreshedIn.length) return CLEAN;
  return {
    refreshed: true,
    note: `refreshed ${refreshedIn.join(", ")} (${files || "?"} file${files === 1 ? "" : "s"} changed) before answering`,
  };
}

/** The one-line note a CLI/MCP surface prints when a refresh actually happened.
 * Null when there's nothing to say (the overwhelmingly common case). */
export function refreshNote(r: RefreshResult): string | null {
  // Stale first: it is a warning about the answer, not a report of work done.
  if (r.stale !== undefined) {
    return `[stale: ${r.stale} files changed, rebuilding in background]`;
  }
  if (!r.refreshed) return r.note ? `${tag()} ${r.note}` : null;
  const n = r.drift ? driftCount(r.drift) : 0;
  const built = `refreshed the graph (${n || "?"} file${n === 1 ? "" : "s"} changed) before answering`;
  // Both facts, when a worktree was seeded *and* the copy needed repairing: the
  // count is the interesting half (it's the branch diff), the provenance explains
  // where a graph came from in a directory the user knows they never built.
  return r.note ? `${tag()} ${built} — ${r.note}` : `${tag()} ${built}`;
}
