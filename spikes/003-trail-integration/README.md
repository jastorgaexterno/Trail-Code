# Spike 003 — Semantic Search Integration into Trail-Code Fork

**Question:** Can we cleanly hook semantic embeddings + sqlite-vec KNN search into the Trail-Code fork build pipeline and expose it as an MCP tool, end-to-end, using the building blocks validated in Spikes 001 and 002?

---

## Verdict: ✅ VALIDATED

Semantic search is integrated and produces real, meaningfully-ranked results.

---

## What changed

### `package.json`
Added to **dependencies**:
```json
"@huggingface/transformers": "^3.0.0",
"better-sqlite3": "^13.0.3",
"sqlite-vec": "^0.1.9"
```
Added to **devDependencies**:
```json
"@types/better-sqlite3": "^7.6.13"
```
Added to **allowScripts**:
```json
"onnxruntime-node": true,
"protobufjs": true,
"better-sqlite3": true
```

### `src/ask/semantic.ts` (new file)
Two exported functions:
- **`embedNodes(nodes: NodeV1[], dbPath: string): Promise<void>`**
  Embeds all nodes using `Xenova/all-MiniLM-L6-v2`, stores them in a sqlite-vec
  `vec0` virtual table at `dbPath`. Idempotent — checks `COUNT(*)` before doing
  any work; re-calling on an existing DB returns in ~26ms.
- **`searchSemantic(query: string, dbPath: string, limit: number): Promise<SemanticHit[]>`**
  Embeds the query and runs a KNN search. Returns hits with `node_id`, `file_path`,
  `symbol`, cosine `score`, and `snippet`.

Key implementation details applied from prior spikes:
- `createRequire(import.meta.url)` to load CJS native modules from ESM TypeScript
- `BigInt` rowids (Spike 002 pitfall)
- `Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)` for Float32Array blobs
- `normalize()` before insert; cosine_sim = 1 − L2²/2 for unit-norm vectors
- Model cache at `$USERPROFILE/.cache/huggingface/transformers` (persists across npm ci)

### `src/mcp/tools.ts` (modified)
- Added import: `embedNodes`, `searchSemantic` from `../ask/semantic.js`
- Added import: `join` from `node:path`
- Added tool definition `graft_search_semantic` to `TOOLS` array
- Added `case 'graft_search_semantic'` to `callSingleTool`:
  - Loads graph with `loadGraphCached(contextDirFor(root, dirOverride))`
  - DB path: `join(contextDir, '.cache', 'embeddings.db')` (→ `graft/.cache/embeddings.db`)
  - Calls `embedNodes` (idempotent), then `searchSemantic`
  - Returns ranked hits with file, symbol, score, and snippet

---

## Build output

```
$ npx tsc -p tsconfig.json
(no output — zero errors)
```

TypeScript compiled cleanly.

**Install note:** `npm install` (without package args) fails on `tree-sitter-kotlin@0.3.8`
which requires Visual C++ to build from source. Workaround used:

```bash
npm install --ignore-scripts    # installs packages, skips all build scripts
# better-sqlite3 ships win32-x64.node in prebuilds/ — loads fine without compilation
# sqlite-vec ships index.cjs with prebuilt .node — loads fine
```

This is a known pre-existing constraint (no MSVC on this machine). It does NOT affect
the three new packages — all three use prebuilt WASM/NAPI binaries and work without compilation.

---

## Smoke test output

Target repo: `spikes/001-huggingface-transformers` (2 nodes: `spike.mjs` + `spike.mjs#cosineSimilarity`)

```
Loaded graph: 2 nodes, 3 edges
Node ids: spike.mjs, spike.mjs#cosineSimilarity

--- embedNodes ---
[semantic] Embedding 2 nodes (all-MiniLM-L6-v2)…
dtype not specified for "model". Using the default dtype (fp32) for this device (cpu)
[semantic] Done — 2 nodes stored at …/graft/.cache/embeddings.db
embedNodes done in 93.1s   ← includes model download (~87MB) + embed

--- search: "feature extraction pipeline" ---
  [0.1188] spike.mjs · spike.mjs
  [0.0737] spike.mjs · cosineSimilarity

--- search: "cosine similarity calculation" ---
  [0.4577] spike.mjs · cosineSimilarity   ← correct top hit ✓
  [-0.0258] spike.mjs · spike.mjs

--- search: "normalize embeddings" ---
  [0.1697] spike.mjs · spike.mjs
  [0.1620] spike.mjs · cosineSimilarity

✅ Smoke test complete.
```

**Second call (warm, model already cached):**
```
embedNodes (2nd call): 26ms   ← idempotent skip
searchSemantic:        302ms  ← includes model warm-up in new process
```

**Ranking analysis:** "cosine similarity calculation" → `cosineSimilarity` scores 0.4577
vs 0.11–0.17 for the other queries. The only two-node graph limits signal, but the
semantic ranking is clearly correct — it surfaces the right symbol for the right query.

---

## Surprises / blockers

### 1. Graph lives at `graft/.graph/wiring.json`, not `graft/graph.json`
Trail's `wiringPath()` puts the graph at `<contextDir>/.graph/wiring.json`.
The smoke test initially looked for `graph.json` and failed. Fixed by reading the
correct path (documented above for the real build).

### 2. `npm install` blocked by `tree-sitter-kotlin` native build
Any `npm install` invocation triggers `node-gyp rebuild` for `tree-sitter-kotlin`,
which fails without MSVC. Used `--ignore-scripts` as a workaround.
The three new packages (HuggingFace, better-sqlite3, sqlite-vec) all ship prebuilt
binaries and are unaffected. **Action needed before merging:** either add Visual C++
to the CI environment, or exclude `tree-sitter-kotlin` from devDependencies if it
is not strictly needed for builds on Windows.

### 3. Windows ESM dynamic import requires `pathToFileURL`
`import(windowsAbsolutePath)` throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
Must wrap with `pathToFileURL(path).href`. Not an issue in compiled TypeScript
(which uses `import()` with module-relative specifiers), only relevant for test
scripts that construct dynamic import paths from strings.

### 4. First-run latency: ~93s
Model download (≈87MB) + embedding 2 nodes takes ~93s on first call. Model is cached
at `$USERPROFILE/.cache/huggingface/transformers` and subsequent calls take ~300ms.
For a real build: consider a progress indicator and/or an opt-in flag (`--semantic`
on `graft build`) so normal builds stay fast.

---

## What remains for the real build

| Item | Priority | Notes |
|------|----------|-------|
| Hook `embedNodes` into `graft build` pipeline (build.ts) | Medium | Current MCP tool builds lazily on first query — acceptable for spike, not ideal for prod |
| Add `--semantic` flag to `graft build` | Medium | Makes first-run cost explicit and opt-in |
| Handle graph rebuilds (stale embeddings) | Medium | DB is skipped if `COUNT > 0`; needs invalidation on `graft build` re-run |
| Progress indicator during embedding | Low | 93s silent wait is confusing |
| Fix `tree-sitter-kotlin` build on Windows | Blocker | Affects `npm install` for all devs without MSVC |
| Larger test graph (>2 nodes) | Low | 2-node graph verifies correctness but not relevance quality at scale |
| `graft_search_semantic` in workspace federated path | Low | `callWorkspaceTool` doesn't handle `graft_search_semantic` yet |
