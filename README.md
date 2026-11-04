# Trail-Code

A code map for coding agents. Tree-sitter builds a call graph of a repository —
symbols, spans, who-calls-what — and `trail` serves it to an agent over the CLI or
MCP. No LLM, no API key, no network: a build is deterministic and costs nothing.

The map is a local cache, and every query checks it against the working tree before
answering. Two operational rules that used to exist are gone with that: you do not
run `trail build` after a merge, and the main checkout does not have to stay on a
particular branch — each path answers about its own working tree.

This repo is a fork of [trailhq/Trail-Code](https://github.com/trailhq/Trail-Code);
what the fork adds is in [FORK.md](FORK.md).

## Install

```bash
npm install -g trail-code-detacoop --ignore-scripts
trail --version
```

`--ignore-scripts` is required on Windows without a C++ toolchain: one grammar ships
native bindings. Trail falls back to WASM grammars for it.

From source:

```bash
git clone https://github.com/jastorgaexterno/Trail-Code
cd Trail-Code
npm install --ignore-scripts
npm run build                    # required before installing
npm install -g . --ignore-scripts
```

## Wire it into a repo

```bash
trail init            # AGENTS.md section + .trail/ + the agent skills
trail build           # the code map (first run also fetches the embedding model)
```

`trail init` writes exactly three things: the trail section of `AGENTS.md`, the
`.trail/` directory that holds the cache (`git`-ignored from inside), and the skill
for each agent it finds installed — Claude Code's `~/.claude/skills/trail/SKILL.md`
and Hermes's `~/.hermes/skills/trail/SKILL.md`. Commit `AGENTS.md` and `.trail/`;
teammates run `trail build` for their own cache.

## The nine MCP tools

`trail mcp <dir>` serves the map over stdio. The tool names and contracts are stable
— Hermes and Claude Code already configured against them keep working.

| Tool | What it answers |
|---|---|
| `trail_find_code` | Ranked lexical search: symbols, functions, classes, variables |
| `trail_find_all` | Every occurrence of a literal, grouped by enclosing symbol |
| `trail_trace_calls` | Call graph: who calls this (`direction`), and how far (`depth`) |
| `trail_file_api` | One file's signatures and spans, ~200 tokens |
| `trail_repo_map` | Directory clusters, hubs and hotspots — orientation |
| `trail_search_semantic` | Concepts in prose: specs and docs (`.md`), not code symbols |
| `trail_check_freshness` | Whether the map matches the working tree |
| `trail_build` | Rebuild graph + semantic index in the background |
| `trail_set_scope` | Pin later queries to one subtree of the workspace |

## The CLI

```
Find code
  trail ask "<question>" [dir]      ranked answer with the code inlined at each hit
  trail grep "<pattern>" [dir]      every occurrence, grouped by enclosing symbol
  trail skeleton <file> [dir]       a file's whole API in ~200 tokens
  trail callers <symbol> [dir]      who calls it; --direction out for what it calls
  trail map [dir]                   directory clusters, hubs, hotspots

CI
  trail blast [dir]                 what depends on the lines this diff touched

Setup
  trail init [dir]                  wire trail into your agents
  trail build [dir]                 rebuild the code map; --check fails if it is stale
  trail status [dir]                code map, freshness and tokens saved
  trail viz [dir]                   interactive graph in the browser
  trail mcp [dir]                   serve the map over MCP (stdio)
  trail stats [dir]                 this session's usage mix and tokens saved
  trail config                      local trail configuration
  trail telemetry [action]          show or turn off the anonymous usage stats
  trail upgrade                     install the latest trail
  trail uninstall [dir]             remove what trail wrote to this repo
  trail version                     installed and latest published version
```

Global options: `--dir <path>` moves the cache, `--provider/--model/--api-key/--base-url`
configure the optional LLM pass. `trail <command> --help` has the flags.

### Reading a result

- Hits carry `covers:` with exact `file:line` spans. Cite from there; there is nothing
  to double-check by opening the file.
- `trail ask` returns the top N. For "every occurrence", use `trail grep` — it is
  exhaustive over the indexed files.
- A span marked `+N more lines` is truncated: open the file at that range.

## Freshness: the map follows the working tree

Every query probes the working tree first (~3ms; a stat per source file, hashes only
for the ones that moved) and repairs the graph when something changed.

| Drift | What happens |
|---|---|
| 0 files | Nothing. The common case. |
| 1 – 50 files | Those files are re-extracted before the answer. An edit you just made is already in it, and there is no note. |
| More than 50 | A branch switch, a merge of someone else's work. The rebuild goes to a detached process and the answer opens with `[stale: N files changed, rebuilding in background]` — ask again in a moment. |

The threshold is a constant (50), not a flag. The vector index is refreshed only in
that background process: loading the embedding model costs seconds and must not block
a lexical query. The inline repair writes what a query reads — the graph, the `ask`
index, the freshness record — never the markdown cards; `trail build` regenerates
those.

## Git worktrees

A linked worktree (`.git` is a file) has no cache of its own, because the cache is
git-ignored. **There is nothing to run first.** The first query copies the main
checkout's graph — lexical graph, `ask` index and the vector index — and then patches
the difference between the two branches. The answer is about that worktree's code,
not about whatever branch the main checkout happens to be on.

Two properties that follow: a worktree is not a separate repo for `trail status` or
for workspace federated search (the repo is counted once), and seeding never writes
to the main checkout.

## Semantic search

`trail build` builds the vector index by default (skip it with `--no-semantic`); the
first run downloads `Xenova/all-mpnet-base-v2` (~420 MB) once. Embeddings are
incremental — a node whose `body_hash` did not change is not re-embedded.

The model is trained on natural language, so `trail_search_semantic` earns its keep
on `.md` (specs, docs, system cards) and adds little for code symbols — use
`trail_find_code` for those. Scope it in a workspace with `in=`:

```python
trail_search_semantic(query="cómo se calcula la cuota mínima", in="default-core", limit=5)
```

Filter hits below ~0.25 as noise; 0.44+ is a solid hit, 0.50+ high confidence.

### Indexing markdown

```bash
trail build --include-md                     # index .md as nodes (persisted per repo)
trail build --include-md --md-only-dir specs # limit it to one directory
trail build --no-include-md                  # revert
```

OpenSpec `.md` under `openspec/specs/` and `openspec/changes/` is indexed without any
flag (archive excluded; `--include-openspec-archive` includes it).

## Workspaces

Point `trail` at a folder of git repos and it builds each child into its own cache and
federates queries across them; hits carry a `[scope/]` label. Narrow with
`--in <scope>/` (CLI) or `in=` (MCP) — for a compound path use the whole path
(`default-core/frontend`), not its first segment.

```bash
cd ~/Desarrollo && trail build          # every child, one command
cd ~/Desarrollo && trail status         # 29 repos · 30,058 nodes
```

## `trail viz` and `trail blast`

```bash
trail viz                            # http://127.0.0.1:4400, three tabs
trail viz --repos frontend backend   # workspace: only these
trail viz --skip detafull openspec   # workspace: all but these
trail viz --export out/              # self-contained HTML for CI

trail blast                          # blast radius of the working tree
trail blast --base origin/main       # ...of a branch
trail blast --format markdown --export-viz out/
```

`blast` is intra-repo: it follows the call graph, not HTTP. `viz` hides test files by
default (`--include-tests` shows them).

## MCP configuration

The server is stdio, so no proxy is involved.

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  trail:
    command: trail            # or C:/Users/<user>/AppData/Roaming/npm/trail.cmd
    args:
      - mcp
      - C:/Users/<user>/Desarrollo
    env:
      PYTHONUTF8: "1"
    timeout: 60
    enabled: true
```

Call `trail_set_scope` once at the start of a session to pin the workspace subtree the
rest of the queries should use.

## What is on disk

Everything lives under the repo's cache directory — `.trail/cache/` in a repo wired by
`trail init`, `graft/` elsewhere:

| File | What it is |
|---|---|
| `.cache/wiring.json` | The graph: nodes (id, kind, path, span, signature) + edges |
| `.cache/ask-index.json` | BM25 sidecar for `trail ask` / `trail_find_code` |
| `.cache/extract.<hash>.json` | Per-file parse memo, so a rebuild replays unchanged files |
| `.cache/fingerprint.<hash>.json` | The freshness probe's record (size, mtime, hash per file) |
| `.cache/embeddings.db` | SQLite + sqlite-vec: one vector per node |
| `INDEX.md`, cards | Markdown projections, written by an explicit `trail build` |

None of it is committed. Delete the cache directory to force a cold build.

## Environment

| Variable | Effect |
|---|---|
| `GRAFT_NO_REFRESH` | Never refresh the graph on the query path |
| `GRAFT_NO_SEED` | Never seed a worktree from the main checkout |
| `GRAFT_REFRESH=hash` | Confirm every file by bytes instead of trusting size+mtime |
| `GRAFT_DIR` | Cache directory override, for every entry point |
| `GRAFT_FIRST_BUILD_WAIT_MS` | How long the first query waits for a repo's first build |
| `GRAFT_API_KEY` / `GRAFT_PROVIDER` / `GRAFT_MODEL` / `GRAFT_BASE_URL` | The optional `--deep` LLM pass |
| `GRAFT_NO_RENAME_NOTICE` | Do not print the once-a-week `graft` → `trail` line |

## Development

```bash
npm run build                     # tsc + viewer bundle + grammar queries
node --import tsx --test test/graph-refresh.test.ts    # one file (npm test hits
                                                       # ENAMETOOLONG on Windows)
```

The pre-push gate is typecheck, lint and tests. The code map is not part of it: it
refreshes itself on the query path.

## License

MIT, as upstream. The fork keeps the original copyright notice.
