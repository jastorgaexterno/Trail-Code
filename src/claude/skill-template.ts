import { cmd, type Brand } from "../brand.js";
// The graft Claude Code skill, bundled as a string so `graft init` can write it into a
// consumer repo's .claude/skills/graft/SKILL.md (no network fetch, version-locked to the
// installed graft). This is the single source of truth for the skill text; graft's own
// repo copy is regenerated from here when `init` runs in this repo. Mirrors the `.cjs`
// shim pattern in shim-template.ts.
//
// `brand` is the repo's name for the tool, not the machine's: a repo wired by
// `trail init` gets the trail text, whoever refreshes it, so teammates on graft
// and trail never flip the committed file back and forth.
//
// trail-solo-grafo: the skill describes the code map only. The learnings, skills
// and pre-review sections are gone with the layers they documented, so every
// command and tool named below exists in the binary.
export function skillTemplate(brand: Brand = "graft"): string {
  return brand === "trail" ? trailSkill(graftSkill()) : graftSkill();
}

/**
 * When Claude Code loads the trail skill. It reads only the description up
 * front and opens the body when the description fits the moment, so the
 * description names the moments a trail command belongs to, not just code
 * search. It's also the one line every teammate's Claude sees in a repo where
 * trail is wired, installed or not, so it says how to get the command. A plain
 * YAML scalar: no ": " and no " #".
 */
const TRAIL_DESCRIPTION = `Use for ANY task in this repo. Run trail ask before grepping or reading
  source: it returns ranked nodes with exact file:line spans, plus the call
  graph, a semantic search and a repo map for orientation. Works in git
  worktrees with no setup and refreshes itself on every query, so answers
  describe the code as it is right now. If the trail command isn't installed,
  offer once to install it with npm install -g trail-code
  --ignore-scripts and then trail init --no-agents. If npm says EACCES, never
  use sudo; offer to set npm's prefix to ~/.npm-global instead.`;

/** The same, in the body, before the tool docs. */
function trailSkill(graft: string): string {
  const text = trailSpelling(graft.replace(/^---\n[\s\S]*?\n---\n/, ""));
  return `---
name: trail
description: ${TRAIL_DESCRIPTION}
---
${text.trimEnd()}

## Worktrees and a working tree that moves

- **A linked git worktree needs no setup.** Its \`.git\` is a file, not a
  directory; the map lives in the git-ignored cache, so a fresh worktree has
  none. The first query copies the main checkout's graph in — lexical graph,
  \`ask\` index and the semantic index — and patches the difference between the
  two branches. The answer is about *this* worktree's code, not the branch the
  main checkout happens to be on. Do not run \`trail build\` first.
- **The map refreshes on the query path.** Up to 50 changed files are
  re-extracted before the answer, so an edit you just made is already in it.
  More than that — a branch switch, a merge of someone else's work — is rebuilt
  in a detached process and the answer begins with
  \`[stale: N files changed, rebuilding in background]\`: it may predate the
  change, so ask again in a moment rather than rewording the question.
- **The semantic index lags on purpose.** It loads a local embedding model, which
  costs seconds, so it is refreshed in the background and never blocks a lexical
  query. \`trail_check_freshness\` reports the state of both.

## The MCP surface

When the trail MCP server is connected, the same retrieval is exposed as nine
tools. Use whichever surface is available; the guidance above is identical.

| Tool | When |
|---|---|
| \`trail_find_code\` | Code: functions, symbols, variables, classes (lexical, exact names) |
| \`trail_find_all\` | Every occurrence of a literal, grouped by enclosing symbol |
| \`trail_trace_calls\` | Blast radius before changing a symbol (\`direction\`, \`depth\`) |
| \`trail_file_api\` | A file's API surface without reading it |
| \`trail_repo_map\` | Orientation in an unknown repo or workspace |
| \`trail_search_semantic\` | Concepts in prose (\`.md\` specs, docs). NOT for code symbols |
| \`trail_check_freshness\` | Is the map in sync with the working tree? |
| \`trail_build\` | Rebuild graph + semantic index in the background |
| \`trail_set_scope\` | Pin every later query to one subtree of the workspace |

> **Semantic rule**: \`trail_search_semantic\` embeds natural language, so it earns
> its keep on \`.md\` (specs, docs, system cards) and adds little for code. For a
> symbol name use \`trail_find_code\`.
> Scope it with \`in=\`: \`trail_search_semantic(query="...", in="default-core")\`.

## CLI, when the MCP server is not connected

\`\`\`bash
trail ask "<question>" --source   # locate + understand (the default)
trail grep "<literal>"            # exhaustive, grouped by enclosing symbol
trail callers <sym> --depth 2     # who calls it; --direction out for callees
trail skeleton <file>             # a file's API in ~200 tokens
trail map                         # orientation: clusters, hubs, hotspots
trail build                       # rebuild the map (cards + INDEX.md too)
trail status                      # code map, freshness and tokens saved
trail blast --base origin/main    # blast radius of a diff
trail viz                         # interactive graph in the browser
\`\`\`

If \`trail\` isn't installed on this machine but \`graft\` is, it's the same
command under its old name.
`;
}

/**
 * Agent-facing graft text in trail's spelling, for every file trail writes
 * for an agent: the commands as trail spells them (`graft stats` is
 * `trail status`, and the freshness gate is `trail build --check`, see `cmd`),
 * and the name in prose. Under trail the
 * code map is in `.trail/cache/` (context/map-dir.ts), so the folder's name
 * changes too; any other `graft` followed by `/` stays, as do `graft-…`
 * names. `graft_…` MCP tool names ARE replaced — the fork exposes them as `trail_*`.
 */
export function trailSpelling(text: string): string {
  return text
    .replace(/`graft\/`/g, "`.trail/cache/`")
    .replace(/(?<![\w./-])graft\/INDEX\.md/g, ".trail/cache/INDEX.md")
    .replace(/(?<![\w./-])graft\/(?=[\s.,)])/g, ".trail/cache/")
    .replace(/\bgraft check\b(?![\w-])/g, () => cmd("graft build --check", "trail"))
    .replace(/\bgraft stats\b(?![\w-])/g, (m) => cmd(m, "trail"))
    .replace(/\bGraft\b(?![/\w-])/g, "Trail")
    .replace(/\bgraft_(?=[a-z])/g, "trail_")
    .replace(/\bgraft\b(?![/\w-])/g, "trail");
}

function graftSkill(): string {
  return `---
name: graft
description: This repo is indexed by graft/. For ANY task here, whether
  understanding how something works, finding where code lives, tracing what
  calls a symbol or what a change breaks, or scoping an edit, get your context
  from graft before grepping or reading source files.
---

# graft

\`graft/\` holds a graph of this repo: small markdown nodes that each explain one
part in prose and name the exact \`file:line\` spans they cover, plus a wiring
graph of who-calls-what. Querying a node costs a few hundred tokens; rebuilding
that understanding by reading source costs thousands, and misses the edges.

Every command below is \`$0\`, needs no API key, and returns in under a second.
There are six of them. **Pick the one that fits the task, run it, act on the
answer; don't chain tools hoping for more. Most tasks need one call.**

## The tools

### 1 · \`graft ask "<question>" --source\`: locate + understand (the default)
Ranked retrieval over the graph, routed automatically between prose nodes and
the wiring graph, returning the top hits with exact \`file:line\`.
- \`--source\` inlines the code at each hit, the ≤8-line **crux** of each
  definition, so the result IS the code you need, no follow-up file read. Add
  \`--full\` only when the crux is too small to act on.
- \`--in <path>\` narrows to a subtree before ranking; \`-n N\` caps results (default 8).
- **Use it when** the question is conceptual or locational: "how does auth
  work", "where is rate-limiting handled", "what assembles the request pipeline".
- One ask usually answers. A genuinely multi-part question needs one ask per
  distinct sub-aspect, never the same question reworded. Few or weak hits mean
  switch tool (grep / skeleton / callers), don't re-ask.

### 2 · \`graft grep "<pattern>"\`: exhaustive find
Regex (or \`--fixed\` for a literal) over every indexed file, hits **grouped by
enclosing symbol** and ranked by coupling; it also reports files it couldn't read.
- **Use it when** you need every occurrence: all call sites, all uses of a
  constant, all providers. \`ask\` is ranked top-N and *will* miss instances;
  grep won't. One grep replaces a spray of asks.
- Search a **short symbol name or literal**, not a full guessed signature: an
  over-specific regex (\`func (s *Server) GenerateHandler\`) returns nothing even
  when the code is indexed. If a grep misses, **loosen it** (drop the receiver
  and signature, keep the bare name) and retry \`graft grep\`. Do NOT switch to
  raw \`grep -rn\`, which is slower and unranked.
- \`-i\` case-insensitive; \`--in <path>\` scopes to a subtree. Raw \`grep -rn\` is
  only for files graft genuinely doesn't index (docs, configs, brand-new files).

### 3 · \`graft skeleton <file>\`: a file's API at a glance
Signatures-only view of one file (every function / method / type with its span)
in ~200 tokens, ~10x cheaper than reading the file.
- **Use it when** you need "what's in this file / what can I call here" before
  editing or wiring into it. One skeleton is the whole answer for a file; don't
  re-skeleton the same file, and don't skeleton every file \`map\` already named.

### 4 · \`graft callers <symbol>\`: the exact edges
Precomputed call/reference edges, not a text search. Symbol can be bare
(\`Foo\`), qualified (\`Class.method\`), or package-qualified (\`pkg.Fn\`).
- default \`--direction in\`: **who calls/references** this; run before you
  rename, delete, or change its signature.
- \`--direction out\`: **what this symbol itself calls/depends on** (the old \`callees\`).
- \`--depth N\`: walk transitively N hops for the **full blast radius** (the old
  \`impact\`); \`--depth 2\` is the usual "what breaks if I touch this".
- \`--depth all\`: the **entire connected closure**: every source reachable
  through the edges. Reach for this before a **refactor, rename, or any
  multi-file change**: it surfaces the sibling and downstream files (platform
  variants, a module you must split out) that a single-file edit would miss.

### 5 · \`graft map\`: orientation for an unfamiliar repo or area
A token-budgeted tour: directory clusters, per-directory hubs, and global
hotspots, straight from the wiring graph.
- **Use it when** you land in a repo cold or are asked for "the architecture".
  \`map\` alone is the answer: read the hub cards it names; do NOT then skeleton
  or ask your way through every subsystem it lists. \`--max-dirs N\` widens it.

### 6 · Lifecycle: \`graft build\` / \`graft build --check\`
Every tool above refreshes the graph itself before answering, so what those tools
return always describes the code as it is right now, including edits you just made
and have not committed. You do **not** need to run \`build\` after editing.

That refresh is bounded: up to 50 changed files are re-extracted before the answer.
More than that (a branch switch, a merge of someone else's work) is rebuilt in a
detached process, and the answer opens with
\`[stale: N files changed, rebuilding in background]\` — ask again in a moment rather
than rewording the question. A linked git worktree needs no setup at all: the first
query seeds it from the main checkout and patches the branch difference.

One caveat, if you \`grep\` the markdown under \`graft/\` directly: those cards are a
projection, written by an explicit \`build\` rather than on each query, so after an
edit they can lag. The tools above never do: prefer them, and treat a card's spans as
stale if you have edited that file this turn.

\`build\` is for the LLM layer (\`--deep\` adds a concept map; skip unless asked);
\`build --check\` fails when \`graft/\` is stale, for CI.

## Scenarios: the shortest path through a coding task

| When you're… | Reach for | Calls |
|---|---|---|
| Onboarding / "explain this codebase" | \`graft map\`, then read the named hub cards | 1 |
| Understanding a flow ("how does X work") | \`graft ask "<flow>" --source\` | 1 |
| Finding where a change belongs | \`graft ask "where is <behavior>" --source\` | 1 |
| Editing a symbol you can already name | \`graft grep "<symbol>"\`, edit at the \`file:line\` (skip \`ask\`: you know where it is) | 1 |
| Renaming / deleting / changing a signature | \`graft callers <sym> --depth 2\` first | 1 |
| Refactor / multi-file change (before editing) | \`graft callers <sym> --depth all\`: map every connected file, don't stop at the first | 1 |
| "What does this depend on?" | \`graft callers <sym> --direction out\` | 1 |
| Finding every occurrence of a pattern | \`graft grep "<literal>"\` | 1 |
| "What's the API of this file?" | \`graft skeleton <file>\` | 1 |
| Debugging a failure in area X | \`graft ask "<symptom>" --source\`, then \`callers\` on the suspect | 1–2 |
| Judging a diff's risk before merge | \`graft callers <changed sym> --depth 2\` | 1 / symbol |
| Working inside one repo of a monorepo | add \`--in <scope>/\` to ask / grep / callers | n/a |

In a multi-repo workspace, graft ranks fairly so the biggest repo can't drown
the rest, and every hit carries a \`[scope/]\` label naming its sub-project; when
you already know where you're working, narrow with \`graft ask "<task>" --in <scope>/\`.
For compound-path repos (e.g. \`default-core/frontend\`) use the full path:
\`graft ask "<task>" --in default-core/frontend/\` — a partial first segment alone
(\`--in default-core\`) is not a valid scope.

## Spend the fewest calls
- A node's \`covers:\` list already gives exact \`file:line\` for every symbol, so
  cite straight from it. The spans are generated from source and authoritative;
  don't re-open or re-grep files to "double-check".
- When the task already names the file or symbol to change, go straight there:
  \`graft grep "<symbol>"\` for the exact \`file:line\`, then edit. Reserve
  \`graft ask\` for when you don't yet know where the code lives: an \`ask\`
  round-trip is wasted on a target you can already name.
- Trust the answer and act. Reach for a second tool only when the first genuinely
  fell short: weak hits, a truncated span, or a need to be exhaustive.
- If graft names a path that isn't on disk, its index is ahead of your checkout
  (a branch switch or unpulled move). Don't read the missing file: \`graft grep\`
  the symbol to find where it lives now, or run \`graft build\` to refresh.

## Report what graft saved, every turn
Each retrieval tool **opens** its output with a \`[graft] tokens saved ≈ N\` line:
the estimated tokens that call saved versus reading the files it covers whole.
Whenever you used any graft tool in a turn, close your reply with a one-line
tally summing those numbers across every graft call you made, e.g.
\`🌱 graft saved ~12,400 tokens this turn (3 calls)\`. A call with no such line
(tiny files, where the pointers cost as much as the source) saved nothing, so
skip it. This is the per-turn figure; the statusline carries the running
session total.

Once a turn has been billed, each line also states what that call was worth in
dollars, at the rate this session is actually paying for input tokens; include
that total alongside the tokens, e.g. \`🌱 graft saved ~12,400 tokens (~$0.04)
this turn\`. When a line carries no dollar figure, report tokens alone rather
than pricing them yourself.

**Never pipe a graft command through \`head\`, \`tail\`, or \`sed -n\`.** Every tool
is already capped and states what it dropped; clipping it costs you hits you
asked for, and it silently drops the savings line the statusline's running
total is parsed from.

## When graft isn't enough
- Span truncated ("+N more lines"): open the file at that exact range.
- A node lacks a detail: ask a more specific question; only then read source at
  the exact \`file:line\`, never a whole file to rebuild understanding graft gives.
- You may also grep / ls / cat inside \`graft/\` directly (plain markdown;
  \`graft/INDEX.md\` indexes the nodes), but the tools above are faster and
  exhaustive where it matters, so reach for them first.

When the graft MCP server is connected, these are exposed as tools too:
\`graft_find_code\`, \`graft_find_all\`, \`graft_file_api\`, \`graft_trace_calls\` (with
\`direction\` / \`depth\`), \`graft_repo_map\`, \`graft_check_freshness\`. Use whichever surface is
available; the guidance is identical.
`;
}
