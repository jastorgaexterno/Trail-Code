/**
 * Semantic search over the code graph using @huggingface/transformers embeddings
 * and sqlite-vec for approximate nearest-neighbour retrieval.
 *
 * Spike 003 — Trail-Code fork integration.
 * Validated building blocks: Spike 001 (embeddings) + Spike 002 (sqlite-vec).
 */
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NodeV1 } from '../graph/types.js';

// Use createRequire so CJS native modules load cleanly from this ESM file.
const _require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SemanticHit {
  node_id: string;
  file_path: string;
  symbol: string;
  score: number;  // cosine similarity ∈ [-1, 1], higher is better
  snippet: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Normalise a Float32Array to unit length (required for cosine sim via L2). */
function normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm;
  return out;
}

/** Convert Float32Array → Buffer so better-sqlite3 accepts it as a blob. */
function vecToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

// Module-level pipeline cache — one warm-up per process.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _extractor: any = null;

async function getExtractor() {
  if (_extractor) return _extractor;
  // Dynamic import keeps @huggingface/transformers tree-shakeable and avoids
  // loading ONNX during non-semantic code paths.
  const { pipeline, env } = await import('@huggingface/transformers');
  // Point the model cache at a stable location outside node_modules so it
  // survives npm ci / reinstalls (matches Spike 001 recommendation).
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.';
  env.cacheDir = `${home}/.cache/huggingface/transformers`;
  _extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return _extractor;
}

/** Embed a batch of texts → unit-normalised 384-dim float32 vectors. */
async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const extractor = await getExtractor();
  const results: Float32Array[] = [];
  for (const text of texts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output: any = await extractor(text, { pooling: 'mean', normalize: false });
    results.push(normalize(output.data as Float32Array));
  }
  return results;
}

/** Open (or create) the SQLite db file and load the sqlite-vec extension. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openDb(dbPath: string): any {
  mkdirSync(dirname(dbPath), { recursive: true });
  const Database = _require('better-sqlite3');
  const sqliteVec = _require('sqlite-vec') as { load(db: unknown): void };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = new (Database as any)(dbPath);
  sqliteVec.load(db);
  return db;
}

/** Idempotent schema setup (IF NOT EXISTS on every statement). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function initSchema(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embed_nodes (
      rowid  INTEGER PRIMARY KEY,
      node_id   TEXT NOT NULL,
      file_path TEXT NOT NULL,
      symbol    TEXT NOT NULL,
      snippet   TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vss_nodes
    USING vec0(embedding float[384]);
  `);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed all nodes in `nodes` and store them in the sqlite-vec database at
 * `dbPath`. Idempotent: if the DB already contains rows, the function returns
 * immediately without re-embedding.
 *
 * Called from the `graft_search_semantic` MCP tool handler (and optionally
 * from the build pipeline) to pre-populate the vector store.
 */
export async function embedNodes(nodes: NodeV1[], dbPath: string): Promise<void> {
  const db = openDb(dbPath);
  initSchema(db);

  const { c } = db.prepare('SELECT COUNT(*) AS c FROM embed_nodes').get() as { c: number };
  if (c > 0) {
    process.stderr.write(`[semantic] ${c} embeddings already in DB, skipping re-embed\n`);
    db.close();
    return;
  }

  // Build one text per node: id + signature + body_text (space-joined, nulls skipped).
  const texts = nodes.map(n =>
    [n.id, n.signature ?? '', n.body_text ?? ''].filter(Boolean).join(' ')
  );

  process.stderr.write(`[semantic] Embedding ${nodes.length} nodes (all-MiniLM-L6-v2)…\n`);
  const vecs = await embedTexts(texts);

  const insertMeta = db.prepare(
    'INSERT INTO embed_nodes (rowid, node_id, file_path, symbol, snippet) VALUES (?, ?, ?, ?, ?)'
  );
  const insertVec = db.prepare(
    'INSERT INTO vss_nodes (rowid, embedding) VALUES (?, ?)'
  );

  const batch = db.transaction(() => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      const v = vecs[i]!;
      // Spike 002: rowid MUST be BigInt, Float32Array MUST be Buffer.
      const rowid = BigInt(i + 1);
      const snippet = n.summary ?? n.signature ?? n.id;
      insertMeta.run(Number(rowid), n.id, n.path, n.name, snippet ?? '');
      insertVec.run(rowid, vecToBuffer(v));
    }
  });
  batch();

  process.stderr.write(`[semantic] Done — ${nodes.length} nodes stored at ${dbPath}\n`);
  db.close();
}

/**
 * Embed `query`, find the top-`limit` nearest nodes in the vector store, and
 * return them with cosine similarity scores.
 *
 * Throws if the DB does not exist or contains no embeddings (call `embedNodes`
 * first, or use the MCP tool which calls it automatically).
 */
export async function searchSemantic(
  query: string,
  dbPath: string,
  limit = 5,
): Promise<SemanticHit[]> {
  if (!existsSync(dbPath)) {
    throw new Error(
      `Embeddings DB not found: ${dbPath} — run \`graft build\` or call the MCP tool once first`,
    );
  }

  const db = openDb(dbPath);
  initSchema(db);

  const { c } = db.prepare('SELECT COUNT(*) AS c FROM embed_nodes').get() as { c: number };
  if (c === 0) {
    db.close();
    throw new Error('No embeddings in DB — call graft_search_semantic once to build the index');
  }

  const [queryVec] = await embedTexts([query]);
  const buf = vecToBuffer(queryVec!);

  // Spike 002 KNN syntax: `WHERE embedding MATCH ? AND k = N ORDER BY distance`
  // distance is L2; cosine_sim = 1 − L2²/2  (valid for unit-norm vectors).
  interface Row {
    node_id: string;
    file_path: string;
    symbol: string;
    snippet: string;
    distance: number;
  }
  const rows = db.prepare(`
    SELECT
      m.node_id,
      m.file_path,
      m.symbol,
      m.snippet,
      v.distance
    FROM vss_nodes v
    JOIN embed_nodes m ON m.rowid = v.rowid
    WHERE v.embedding MATCH ?
      AND k = ?
    ORDER BY v.distance
  `).all(buf, limit) as Row[];

  db.close();

  return rows.map(r => ({
    node_id: r.node_id,
    file_path: r.file_path,
    symbol: r.symbol,
    score: +(1 - (r.distance * r.distance) / 2).toFixed(4),
    snippet: r.snippet ?? '',
  }));
}
