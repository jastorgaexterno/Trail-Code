/**
 * The detached rebuild the query path starts when it must not block.
 *
 * Two calls in `graph/refresh.ts` need work done *after* the query has already
 * answered, so they hand it to a child that outlives them:
 *
 * - **`full`** — a repo on trail that this machine never built. The first query
 *   starts the map and waits a bounded while for it.
 * - **`graph`** — drift above `DRIFT_INLINE_MAX`. Patching that inline would make
 *   one query pay for a branch switch; it answers from the map it has, says
 *   `[stale: …]`, and this child repairs it.
 * - **`embed`** — the semantic index after an inline patch. Loading the ONNX model
 *   costs seconds, and a lexical query has no use for it, so it always runs here,
 *   never in the process that answers.
 *
 * Nothing here is LLM work: structural build + local embeddings, $0 and offline.
 *
 * The parent acquires `.cache/.sync.lock` before spawning a `full`/`graph` job and
 * this child releases it, however it ends — the same contract the pre-amputation
 * `claude/sync-run.ts` had, now with no hooks or stats attached: the graph and the
 * embeddings are the only things it writes.
 *
 * Standalone entry point (`node dist/graph/build-run.js <mode> <dir> <outDir> <timeoutMs>`),
 * also importable so a test can drive the real job instead of standing in for it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { embedNodes } from "../ask/semantic.js";
import { CACHE_DIR } from "../context/node-file.js";
import { acquireLockIn, releaseLockIn } from "../util/state.js";
import { buildGraph } from "./build.js";
import { loadGraphCached } from "./load.js";

/** Filename of the semantic index, inside the context dir's `.cache/`. */
export const EMBEDDINGS_DB = "embeddings.db";

/** A full rebuild of a big repo is minutes; well past that, it is stuck. */
export const BACKGROUND_TIMEOUT_MS = 10 * 60_000;

export type BackgroundMode = "full" | "graph" | "embed";

export interface BackgroundJob {
  mode: BackgroundMode;
  dir: string;
  outDir: string;
}

export function embeddingsDbPath(outDir: string): string {
  return join(outDir, CACHE_DIR, EMBEDDINGS_DB);
}

/** Refresh the vector index from whatever graph is on disk. Never creates one:
 * a repo that never asked for semantic search does not get a model download
 * behind its back. */
async function refreshEmbeddings(outDir: string): Promise<void> {
  const dbPath = embeddingsDbPath(outDir);
  if (!existsSync(dbPath)) return;
  const graph = loadGraphCached(outDir);
  if (!graph) return;
  // File nodes carry a path and nothing to say about it — embedding them is noise.
  const nodes = graph.nodes.filter((n) => n.kind !== "file");
  if (nodes.length === 0) return;
  await embedNodes(nodes, dbPath);
}

/**
 * Run one job to completion. Throws on a build failure — the caller is a
 * short-lived process, and its exit code is the report.
 */
export async function runBackgroundJob(job: BackgroundJob): Promise<void> {
  if (job.mode === "embed") {
    await refreshEmbeddings(job.outDir);
    return;
  }
  await buildGraph(job.dir, {
    contextDir: job.outDir,
    // A query-triggered rebuild writes what a query reads (see `refresh.ts`);
    // the first build of a repo is the whole surface, cards included.
    graphOnly: job.mode === "graph",
  });
  await refreshEmbeddings(job.outDir);
}

/**
 * `node dist/graph/build-run.js <mode> <dir> <outDir> [timeoutMs]`.
 *
 * The lock is taken defensively rather than assumed: when the parent already
 * holds it this is a no-op, and when it does not (the embed path) the child
 * leaves without touching a lock it never owned.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [mode, dir, outDir, timeoutArg] = argv;
  if (!dir || !outDir || (mode !== "full" && mode !== "graph" && mode !== "embed")) {
    process.stderr.write("usage: build-run <full|graph|embed> <dir> <outDir> [timeoutMs]\n");
    return 2;
  }
  const cache = join(outDir, CACHE_DIR);
  const timeout = Number(timeoutArg) > 0 ? Number(timeoutArg) : BACKGROUND_TIMEOUT_MS;
  // `graph`/`full` are always spawned by a caller that has already taken the lock —
  // that handover is the point, because the child owns releasing it. Trying to take
  // it here would fail against the parent's own file, so acquire only when free and
  // release unconditionally: leaving the parent's lock behind would block every
  // later query until it ages out.
  const holdsLock = mode !== "embed";
  if (holdsLock) acquireLockIn(cache);
  // The lock must not outlive this process, even when the build hangs: past the
  // timeout the next query has to be free to try again.
  const timer = setTimeout(() => {
    if (holdsLock) releaseLockIn(cache);
    process.exit(1);
  }, timeout);
  try {
    await runBackgroundJob({ mode, dir, outDir });
    return 0;
  } catch {
    return 1;
  } finally {
    clearTimeout(timer);
    if (holdsLock) releaseLockIn(cache);
  }
}

// Run only when executed directly, not on import (tests import `main`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
