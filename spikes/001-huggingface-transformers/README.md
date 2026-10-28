# Spike 001 — `@huggingface/transformers` on Node.js 26 Windows

## Question

> Does `@huggingface/transformers` produce float32 embeddings in **Node.js 26 on Windows** without any native compilation (no Visual C++, no node-gyp)?

---

## Approach

| Step | Detail |
|------|--------|
| Runtime | Node.js v26.7.0, Windows 11 (x64) |
| Package | `@huggingface/transformers@^3.0.0` (53 packages installed) |
| Model | `Xenova/all-MiniLM-L6-v2` — 384-dim sentence embeddings |
| Task | `feature-extraction` pipeline, `dtype: 'fp32'`, `pooling: 'mean'`, `normalize: true` |
| Inputs | 3 TypeScript-style code snippets covering distinct domains |
| Backend | `onnxruntime-node@1.21.0` — pre-built `.node` binary (`onnxruntime_binding.node`), **zero C++ compilation** |

**Install notes:**
- `npm install` warns about 3 packages with install scripts (`onnxruntime-node`, `sharp`, `protobufjs`) blocked by npm's `allowScripts` policy (new in npm 10+).
- Fix: `npm install-scripts approve onnxruntime-node` (downloads pre-built ONNX Runtime binaries for win32/x64 — NOT a native build).
- No `node-gyp`, no MSVC, no Visual Studio required.

---

## Exact Output

```
=== Spike 001: @huggingface/transformers on Node.js 26 Windows ===

Loading pipeline (first run downloads model ~23MB)...
Pipeline loaded.

--- Snippet 1: "credit/finance" ---
  Vector length : 384
  dtype         : float32 (JS Float32Array via .data)
  First 5 values: [-0.078021, 0.048961, -0.035299, -0.008769, -0.098399]

--- Snippet 2: "network error-handling" ---
  Vector length : 384
  dtype         : float32 (JS Float32Array via .data)
  First 5 values: [-0.073723, 0.071931, -0.036818, 0.032565, -0.073822]

--- Snippet 3: "user auth/session" ---
  Vector length : 384
  dtype         : float32 (JS Float32Array via .data)
  First 5 values: [-0.076454, 0.123192, -0.064667, 0.028315, -0.042338]

=== Cosine Similarities ===
  sim(snippet1, snippet2)  credit  vs network-error : 0.111945
  sim(snippet1, snippet3)  credit  vs auth/session   : 0.085935
  sim(snippet2, snippet3)  network vs auth/session   : 0.364743

  Most similar pair: snippet2 & snippet3 (network vs auth — both async programming patterns)

=== DONE ===
```

---

## Analysis

### Embedding correctness

The model produced semantically meaningful vectors:

| Pair | Similarity | Expected |
|------|-----------|---------|
| credit/finance ↔ network error-handling | 0.1119 | low — unrelated domains |
| credit/finance ↔ user auth/session | 0.0859 | low — unrelated domains |
| **network error-handling ↔ auth/session** | **0.3647** | **high — both async JS patterns** |

Both "network error-handling" and "auth/session" snippets are async JavaScript class/function patterns with try/catch and error throwing; the model correctly identified their structural similarity. The credit/finance snippet (pure math, no async) stands apart — exactly the right semantic grouping.

### Install size

| Component | Size |
|-----------|------|
| `node_modules/` | 466 MB |
| Model cache (`.cache/` inside package) | 87 MB |
| Model download (first run only) | ~87 MB (ONNX fp32 weights + tokenizer) |

The 466 MB `node_modules` is dominated by `onnxruntime-node` pre-built DLLs for all platforms (win32, linux, darwin × arm64/x64) — a production install would prune unused platform bundles.

### npm allowScripts gotcha

npm 10+ blocks postinstall scripts by default. `onnxruntime-node`'s postinstall downloads platform binaries (safe, no compilation). Must explicitly approve:

```bash
npm install-scripts approve onnxruntime-node
npm install-scripts approve sharp          # only if image processing needed
npm install-scripts approve protobufjs
npm install
```

Or add to `package.json`:
```json
{
  "allowScripts": {
    "onnxruntime-node": true,
    "protobufjs": true
  }
}
```

---

## Verdict: ✅ VALIDATED

### What worked
- `@huggingface/transformers` v3 runs on Node.js 26.7.0 Windows 11 with zero native compilation
- Pre-built `onnxruntime-node` binaries cover win32/x64 out of the box
- Float32 vectors (384-dim) produced correctly via `output.data` (JS `Float32Array`)
- Cosine similarities are semantically meaningful — model discriminates code domains correctly
- First-run model download (~87 MB) happens transparently; subsequent runs use cache

### What didn't
- `npm install` requires an extra `npm install-scripts approve onnxruntime-node` step on npm 10+ (scripts blocked by default) — not a hard blocker, just a one-time setup step

### Surprises
- Model cache lands inside `node_modules/@huggingface/transformers/.cache/` (not `~/.cache/huggingface/hub`) — this means the model re-downloads if `node_modules` is deleted
- `node_modules/` weighs 466 MB due to multi-platform ONNX DLLs bundled for all OS/arch combinations; production installs should trim with `npm prune` or Docker multi-stage builds

### Recommendation for the real build
1. **Use `@huggingface/transformers` directly** — no wrapper needed, API is straightforward
2. **Pin `onnxruntime-node` version** in `package.json` to avoid breaking postinstall changes
3. **Set `env.cacheDir`** to a persistent shared location (e.g. `~/.cache/trail-code-models`) so models survive `node_modules` wipes:
   ```js
   import { env } from '@huggingface/transformers';
   env.cacheDir = path.join(os.homedir(), '.cache', 'trail-code-models');
   ```
4. **Model choice**: `Xenova/all-MiniLM-L6-v2` (384-dim, ~90 MB) is a solid baseline. For better code-specific embeddings, consider `Xenova/codebert-base` or `Xenova/all-mpnet-base-v2` (768-dim) in future spikes.
5. **`allowScripts` in repo `package.json`** to avoid CI surprises: approve `onnxruntime-node` and `protobufjs`.
