# .trail

What the map keeps next to the code it describes. Everything here is either
git-ignored and regenerable, or a small committed setting.

- cache/   the code map itself — graph, `ask` index, semantic index
           (`embeddings.db`) and the freshness record. Git-ignored (`cache/`
           in `.trail/.gitignore`): built on demand, never committed
- config.json   build flags persisted per repo (`--include-md`,
                `--md-only-dir`, ...), so a rebuild does not need them retyped.
                Local to each machine, not committed
- knowledge-repos.json   workspace only: git URLs of shared docs repos (team
                         rules, glossaries) every child repo may query.
                         Committed

There are no learnings, no hook and no statusline here: those belonged to
upstream's notes/hooks layer, which this fork removed. Durable context lives in
`openspec/specs/` and `openspec/changes/` — reviewed by a human, indexed by the
map as markdown nodes, and validated with `openspec validate`.
