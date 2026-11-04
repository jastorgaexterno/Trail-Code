/**
 * The one canonical Graft instruction block, rendered into each host's
 * native format. Content changes happen HERE only; renderers just wrap it.
 *
 * `name` is the repo's name for the tool (see `hostWiringName`): a repo wired
 * by trail gets the same text in trail's spelling, so an agent on a machine
 * with only `trail` installed is never told to run `graft`.
 */
import type { Brand } from '../brand.js';
import { trailSpelling } from '../claude/skill-template.js';

function inName(text: string, name: Brand): string {
  return name === 'trail' ? trailSpelling(text) : text;
}

export function instructionBody(name: Brand = 'graft'): string {
  return inName(graftBody(), name);
}

function graftBody(): string {
  return `## Graft — repo context graph

This repo is indexed in \`graft/\`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run \`graft map\` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run \`graft ask "<your question>" --source\` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; \`--full\` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  \`covers:\` file:line spans and edit straight from \`--source\`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run \`graft grep "<literal>"\` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw \`grep -rn\` only for unindexed files.
- \`graft skeleton <file>\` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- \`graft callers <symbol>\` gives precomputed, exact edges — who calls this.
  Add \`--direction out\` for what it calls, or \`--depth N\` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: \`graft/INDEX.md\` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry \`[scope/]\` labels naming which one they're from. Narrow with
  \`graft ask "<task>" --in <scope>/\` once you know where you're working.
  For compound-path repos (e.g. \`default-core/frontend\`) use the full path —
  a partial first segment (\`--in default-core\`) is not a valid scope.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

**The map keeps itself current.** Every query checks the working tree first and
re-extracts up to 50 changed files before answering, so an edit you just made is
already in the graph. More than that (a branch switch, a merge of someone else's
work) is rebuilt in the background: the answer then starts with
\`[stale: N files changed, rebuilding in background]\`, which means "this answer
may predate the change — ask again in a moment". You do not have to run
\`graft build\` after a merge; run it after a large change when you want the
markdown cards and \`INDEX.md\` regenerate as well (deterministic, no API key, $0).

**Worktrees need no setup.** A linked git worktree (\`.git\` is a file) has no map
of its own, because the map lives in the git-ignored cache. The first query
copies the main checkout's graph in and patches the difference between the two
branches, so \`graft ask\` in a fresh worktree answers about that worktree's code
— not the branch the main checkout happens to have. Nothing to run first.

## Checklist before committing / pushing / opening a PR

Run **in this order** before the first push on any branch:

\`\`\`bash
<typecheck>                              # e.g. tsc -b (TS), go vet, cargo check, mypy
<lint>                                   # e.g. bun run lint / npm run lint
<tests>                                  # e.g. npx vitest run <module>
\`\`\`

The code map is not a gate: it refreshes itself on the query path, so there is no
\`build\`/\`check\` step to forget before a push.`;
}

export function cursorRule(name: Brand = 'graft'): string {
  return inName(`---
description: Use the Graft context graph in graft/ before exploring source
alwaysApply: true
---
${graftBody()}
`, name);
}

export function kiroSteering(name: Brand = 'graft'): string {
  return inName(`---
inclusion: always
---
${graftBody()}
`, name);
}

export function windsurfRule(name: Brand = 'graft'): string {
  return inName(`${graftBody()}
`, name);
}
