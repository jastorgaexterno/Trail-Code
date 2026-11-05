# Trail-Code fork

A fork of [trailhq/Trail-Code](https://github.com/trailhq/Trail-Code) (base v0.28.0),
published as `trail-code-detacoop`. Upstream builds the code map; this fork keeps that
and drops everything around it that wrote to git on its own.

## What the fork adds

### `trail_search_semantic` — vector search over the repo

Find code by meaning, not just by keyword, when `trail ask` comes back weak because
the code uses different words than the question. Each node is embedded with
`Xenova/all-mpnet-base-v2` (local ONNX, no API key, no network) into
`<cache>/.cache/embeddings.db`, and the MCP tool embeds the query and returns the
closest nodes by cosine similarity.

- **Incremental**: `body_hash` per node, so an edit re-embeds the nodes it changed and
  nothing else. Deleted nodes are pruned.
- **Workspace-aware**: federated over the children's own databases, results labelled
  `[repo/]`.
- **Best on prose.** The model is trained on natural language: it is strong on `.md`
  (specs, docs) and weak on TypeScript/C# symbols — use `trail_find_code` for those.

### Worktrees: the semantic index travels too

Seeding a fresh worktree from the main checkout on the first query is **upstream's**
work (PR #704, already in the v0.28.0 base): graph, `ask` index and sidecars, then the
difference between the two branches treated as ordinary drift. Nothing to run first,
and the main checkout never has to sit on a particular branch.

What this fork adds is what that seed could not know about:

- `embeddings.db` joins the seedable allowlist (`src/graph/seed.ts`), so
  `trail_search_semantic` answers from a fresh worktree instead of failing with
  `Embeddings DB not found`.
- A linked worktree is skipped by workspace child discovery (`src/graph/scopes.ts`),
  so `trail status` and federated search count each repo once while worktrees are
  alive, and repos one level deeper (`cliente/app`) are found too.
- The refresh that patches the seeded copy is bounded (50 files inline, then a
  background rebuild) and never loads the ONNX model in the answering process.

### The map refreshes itself, with a bound

Every query probes the working tree. Up to 50 changed files are re-extracted before
the answer; more than that (a branch switch, a merge) goes to a detached rebuild and
the answer opens with `[stale: N files changed, rebuilding in background]`. The
semantic index is only ever refreshed in that background process, because loading the
ONNX model costs seconds. Net effect: no `trail build` after a merge.

### Performance: `trail grep` is O(n), not O(files × nodes)

Fixes [#702](https://github.com/trailhq/Trail-Code/issues/702) — `grepGraph` rescanned
every node per file. Nodes are now pre-indexed by path in a `WeakMap`: O(nodes) once,
O(1) per lookup. 43s → 1.6s on a 3,700-file repo. PR
[#713](https://github.com/trailhq/Trail-Code/pull/713) is open upstream.

### Windows

`--ignore-scripts` installs (WASM grammars where a native binding would need a C++
toolchain), `windowsHide` on every `child_process` call so a build opens no console
windows, and path handling that survives drive letters and CRLF checkouts.

### Config and indexing

- Build flags persist per repo in `.trail/config.json`; a legacy `.graft/config.json`
  is migrated once and removed.
- `--include-md` / `--md-only-dir` index markdown as nodes, so `trail ask` finds a
  spec's text without opening the file.
- OpenSpec `openspec/specs/` and `openspec/changes/` are indexed without a flag.

## Differences from upstream

| | Upstream | This fork |
|---|---|---|
| Package name | `@trailhq/trail-code` | `trail-code-detacoop` |
| Semantic search | — | `trail_search_semantic` (ONNX, local) |
| `trail grep` | O(files × nodes) | O(nodes) |
| Worktree seeding | seeded + patched on the first query (upstream #704) | same, plus `embeddings.db` in the seed and worktrees excluded from workspace children |
| Freshness | manual `trail build` | automatic, bounded (50 files inline, then background) |
| Extra deps | — | `@huggingface/transformers`, `better-sqlite3`, `sqlite-vec` |
| Git writes | hooks, branches, pushes | none: trail only reads git |

The fork is a code map and nothing else: no session memory, no shared team repo, no
hooks, no hosted service. That is deliberate — automatic git writes collided with the
team's branch protection and MR-only policy, and were the source of most of the
maintenance.

## Install

```bash
# from npm
npm install -g trail-code-detacoop --ignore-scripts

# from source
git clone https://github.com/jastorgaexterno/Trail-Code
cd Trail-Code
npm install --ignore-scripts
npm run build                  # required: --ignore-scripts skips the prepare hook
npm install -g . --ignore-scripts
```

If upstream was installed first, uninstall it to avoid two `trail` binaries:

```bash
npm uninstall -g @trailhq/trail-code
```

Then, in a repo:

```bash
trail init                     # AGENTS.md section, .trail/, agent skills
trail build                    # graph + semantic index (first run downloads the model)
```

## Publishing

```bash
npm publish --access public --tag latest
```

`--tag latest` is mandatory for a prerelease version (`0.28.0-semantic.x`). Never
publish without building first: `--ignore-scripts` skips `prepare`, so a stale `dist/`
would ship.

## Upstream

- Grep O(n) fix: [#713](https://github.com/trailhq/Trail-Code/pull/713)
- Semantic search proposal: [#712](https://github.com/trailhq/Trail-Code/issues/712)

MIT, the same as upstream.
