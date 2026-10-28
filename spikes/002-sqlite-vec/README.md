# Spike 002 — sqlite-vec on Node.js 26 Windows

**Question:** Does `sqlite-vec` work on Node.js 26 on Windows without Visual C++ build tools?
Can it store float32 vectors and query by cosine similarity?

---

## Approach tried

Only **Approach (a)** was needed — it worked on the first try.

| # | Approach | Result |
|---|----------|--------|
| a | `better-sqlite3` + `sqlite-vec` (prebuilt binaries) | ✅ **WORKS** |
| b | `@sqlite.org/sqlite-wasm` | Not needed |
| c | `sql.js` | Not needed |

---

## Environment

- **Node.js:** v26.7.0
- **Platform:** win32 x64 (Windows 11)
- **npm:** 11.19.0
- **No Visual C++ build tools installed**

---

## Exact install steps

```bash
cd spikes/002-sqlite-vec

# package.json must have "type": "module" for ESM imports
npm install better-sqlite3 sqlite-vec
# → added 4 packages, 0 vulnerabilities
# → better-sqlite3 v13.0.3 (prebuilt binary, no compilation required)
# → sqlite-vec v0.1.9 (prebuilt .node extension)
```

That's it — no native compilation, no MSVC, no node-gyp involved.

---

## Exact output

```
=== Spike 002: sqlite-vec on Node.js 26 Windows ===

Node.js: v26.7.0
Platform: win32 x64

sqlite-vec version: v0.1.9

Created virtual table: vss_nodes (embedding float[384])
  Inserted row 1: first 5 dims = [-0.0096, -0.0600, -0.0416, -0.0690, 0.0543...]
  Inserted row 2: first 5 dims = [0.0895, 0.0756, -0.0567, -0.0469, 0.0356...]
  Inserted row 3: first 5 dims = [0.0328, -0.0407, 0.0407, -0.0028, 0.0737...]

Query vector: first 5 dims = [0.0107, -0.0065, -0.0452, -0.0817, 0.0020...]

--- KNN results (L2 on unit-norm ≈ cosine distance) ---
  rowid=1  L2_distance=1.371727  cosine_similarity≈0.059182
  rowid=2  L2_distance=1.402979  cosine_similarity≈0.015825
  rowid=3  L2_distance=1.441002  cosine_similarity≈-0.038244

Self-check (query vector inserted as rowid=99, expect distance≈0):
  rowid=99  distance=0.00000000

✅ Spike completed successfully.
```

---

## Pitfalls discovered (critical for real build)

### 1. Explicit rowid MUST be `BigInt`
When inserting with an explicit rowid via `INSERT INTO vss_nodes(rowid, embedding) VALUES (?, ?)`,
the rowid parameter **must** be a JavaScript `BigInt`, not a `Number`:

```js
// ❌ FAILS with: SqliteError: Only integers are allows for primary key values on vss_nodes
insert.run(1, buf);
insert.run(Number(1), buf);

// ✅ Works
insert.run(BigInt(1), buf);
```

This appears to be a quirk of how sqlite-vec v0.1.9 validates rowid binding types
through better-sqlite3's C++ layer.

### 2. Float32Array must be wrapped as `Buffer`
better-sqlite3 does not natively bind `Float32Array` as a blob.
Convert it first:

```js
function toBlob(float32arr) {
  return Buffer.from(float32arr.buffer, float32arr.byteOffset, float32arr.byteLength);
}
```

### 3. `vec_version()` column key includes parentheses
```js
// ❌ undefined
const { vec_version } = db.prepare('SELECT vec_version()').get();

// ✅ Correct
const row = db.prepare('SELECT vec_version()').get();
const version = row['vec_version()'];
```

### 4. Cosine similarity via L2 on unit-norm vectors
sqlite-vec's `vec0` uses **L2 (Euclidean) distance** by default. To get cosine similarity:
- Normalize all vectors to unit length before inserting
- `cosine_distance = L2_distance² / 2`
- `cosine_similarity = 1 - cosine_distance`

The self-check confirms correctness: distance to itself = 0.00000000.

---

## Verdict: VALIDATED ✅

### What worked
- `npm install better-sqlite3 sqlite-vec` — zero compilation, prebuilt binaries downloaded
- `CREATE VIRTUAL TABLE … USING vec0(embedding float[384])` — works in-memory
- Inserting 384-dim float32 vectors as blobs — works with Buffer + BigInt rowid
- KNN query `WHERE embedding MATCH ? AND k = 3` — returns correct ordered results
- Cosine similarity approximation via unit-norm L2 — mathematically correct (self-dist = 0)

### What didn't
- Nothing blocked — approach (a) worked cleanly; (b) and (c) were not needed

### Surprises
- `better-sqlite3` v13.0.3 ships a prebuilt binary for Node.js v26.x (NAPI-based, so version-agnostic)
- sqlite-vec v0.1.9 also ships prebuilt `.node` files — no MSVC at all
- The `BigInt` rowid requirement is undocumented and only surfaced at runtime

### Recommendation for the real build

**Use approach (a) as-is:**

```bash
npm install better-sqlite3 sqlite-vec
```

In production code:

```js
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const db = new Database('trail.db');
sqliteVec.load(db);

const insert = db.prepare('INSERT INTO vss_nodes(rowid, embedding) VALUES (?, ?)');
// Always use BigInt rowid + Buffer blob:
insert.run(BigInt(nodeId), Buffer.from(embedding.buffer));
```

- For cosine similarity: normalize vectors to unit length before storing
- For explicit distance column names: query `SELECT rowid, distance FROM vss_nodes WHERE embedding MATCH ? AND k = ?`
- The NAPI binary means `better-sqlite3` v13+ survives Node.js minor version bumps without reinstall
