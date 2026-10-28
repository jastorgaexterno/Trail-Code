# Trail-Code Fork — Semantic Search

This is a fork of [trailhq/Trail-Code](https://github.com/trailhq/Trail-Code) (base: v0.28.0).

## What this fork adds

### `graft_search_semantic` — vector search over your code

Find code by **meaning**, not just keywords. When `graft ask` returns weak results because the code uses different terms than your query, semantic search bridges the gap.

```bash
# Build the vector index (one-time, ~87 MB model on first run)
trail build --semantic

# Query via MCP tool
# graft_search_semantic: { query: "session expiry handling", limit: 5 }
```

**How it works:** after `trail build --semantic`, each parsed symbol is embedded with `all-MiniLM-L6-v2` (local ONNX, no API key, no network) and stored in `graft/.cache/embeddings.db`. The MCP tool embeds your query and returns the closest symbols by cosine similarity.

**Workspace-aware:** works across multi-repo workspaces — results are labeled `[repo/]`.

**Incremental:** the index is hash-checked on each call; only re-embeds when the graph changes.

### Performance fix: `graft grep` O(n) instead of O(files×nodes)

Fixes [#702](https://github.com/trailhq/Trail-Code/issues/702) — `grepGraph` was O(files × nodes) due to `symbolsOf` rescanning all graph nodes per file. Pre-indexes nodes by path in a `WeakMap`, reducing to O(nodes) one-time build + O(1) per lookup. 43s → 1.6s on a 3,700-file repo.

## Differences from upstream

| | Upstream | This fork |
|---|---|---|
| Package name | `@nanonets/graft` | `@detacoop/trail-code` |
| Semantic search | ❌ | ✅ `graft_search_semantic` MCP tool |
| grep performance | O(files×nodes) | O(nodes) |
| Extra deps | — | `@huggingface/transformers`, `better-sqlite3`, `sqlite-vec` |

## Installing

```bash
git clone https://github.com/jastorgaexterno/Trail-Code
cd Trail-Code
npm install --ignore-scripts  # skips tree-sitter-kotlin native build
npm install -g .
```

## Upstream PR

- Grep fix: [trailhq/Trail-Code#713](https://github.com/trailhq/Trail-Code/pull/713)
- Semantic search feature request: [trailhq/Trail-Code#712](https://github.com/trailhq/Trail-Code/issues/712)
