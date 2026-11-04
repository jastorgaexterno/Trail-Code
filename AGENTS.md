<!-- trail:start -->
## Trail — repo context graph

This repo is indexed in `.trail/cache/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `trail map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `trail ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `trail grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `trail skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `trail callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `.trail/cache/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `trail ask "<task>" --in <scope>/` once you know where you're working.
  For compound-path repos (e.g. `default-core/frontend`) use the full path —
  a partial first segment (`--in default-core`) is not a valid scope.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

**The map keeps itself current.** Every query checks the working tree first and
re-extracts up to 50 changed files before answering, so an edit you just made is
already in the graph. More than that (a branch switch, a merge of someone else's
work) is rebuilt in the background: the answer then starts with
`[stale: N files changed, rebuilding in background]`, which means "this answer
may predate the change — ask again in a moment". You do not have to run
`trail build` after a merge; run it after a large change when you want the
markdown cards and `INDEX.md` regenerate as well (deterministic, no API key, $0).

**Worktrees need no setup.** A linked git worktree (`.git` is a file) has no map
of its own, because the map lives in the git-ignored cache. The first query
copies the main checkout's graph in and patches the difference between the two
branches, so `trail ask` in a fresh worktree answers about that worktree's code
— not the branch the main checkout happens to have. Nothing to run first.

## Checklist before committing / pushing / opening a PR

Run **in this order** before the first push on any branch:

```bash
<typecheck>                              # e.g. tsc -b (TS), go vet, cargo check, mypy
<lint>                                   # e.g. bun run lint / npm run lint
<tests>                                  # e.g. npx vitest run <module>
```

The code map is not a gate: it refreshes itself on the query path, so there is no
`build`/`check` step to forget before a push.
<!-- trail:end -->
