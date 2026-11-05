# Contributing to Trail-Code

This repository is a fork of [trailhq/Trail-Code](https://github.com/trailhq/Trail-Code). It keeps
upstream's code map and removes everything around it that wrote to git on its own — see
[FORK.md](FORK.md) for the full list of differences, with `file:line`. Read that before proposing a
feature: hooks, learnings, notes, the team page and the cloud workspace are gone on purpose, not by
oversight.

## Requirements

- **Node 22.3 or newer** (20.16 works too) — `engines` in `package.json`, enforced by `src/bin/trail.ts`
  before anything else loads, so an old Node fails with one clear line instead of a stack trace.
- **npm 10+**, which is what Node 22 ships.

## Clone, build, test

```bash
git clone https://github.com/jastorgalj/Trail-Code && cd Trail-Code
npm install            # CUDA 13 machine? prefix it: ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
npm run build          # tsc (src + viewer) + the viewer bundle + the grammar queries
npm test
```

`npm run build` is not optional before testing the installed CLI: the tests exercise `src/` through
`tsx`, but `dist/` is what ships and what `node dist/bin/trail.js` runs.

Run one test file while iterating (the whole suite takes ~90s):

```bash
node --import tsx --test test/graph-refresh.test.ts
```

### CUDA 13 and the `onnxruntime` postinstall

`@huggingface/transformers` pulls in `onnxruntime-node`, whose install script downloads CUDA
binaries built against CUDA 11/12. On a machine with a CUDA 13 driver and toolkit that download
fails, and npm aborts the whole install. The binaries are the GPU execution provider only — the
semantic index runs fine on CPU — so skip the download:

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install          # from a clone
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm i -g trail-code  # installing the published package
```

**Fallback: `--ignore-scripts`.** Used when npm cannot run the postinstall at all (a locked-down
machine, a broken toolchain). It is safe here, and this is why:

- `better-sqlite3@13.0.3` ships `prebuilds/linux-x64.node` (and the other platforms) in the tarball,
  and declares no install script — nothing gets compiled.
- `sqlite-vec@0.1.9` declares `scripts: {}` — no scripts at all.
- The tree-sitter grammars this package uses are WASM (`tree-sitter-wasm`, `web-tree-sitter`).
- The only `postinstall` in the dependency tree is `onnxruntime-node`'s — exactly the one that
  fails on CUDA 13.

```bash
npm install --ignore-scripts
npm run build                                          # --ignore-scripts also skips `prepare`
```

The published tarball ships `dist/` (see `files` in `package.json`), so
`npm i -g trail-code --ignore-scripts` needs no build on the user's machine. This repo's own
`scripts/postinstall.mjs` only prints a one-line nudge and records an anonymous install event; it
never fails an install.

## Tests

`npm test` runs the whole suite through `scripts/run-tests.mjs`.

**The baseline on this fork is 1047 pass / 37 fail / 5 skip** (1089 tests). Those 37 failures are
pre-existing: they describe parts upstream ships and this fork removed or never carried over —
learnings and notes, the hooks and the statusline, the `--pair` look-back, the six-tool MCP roster,
and a handful of workspace/build-config details. They fail identically on the base branch.

Before blaming a change for a red test, compare against the base:

```bash
git stash && npm test > /tmp/base.log; git stash pop && npm test > /tmp/mine.log
diff <(grep '^not ok' /tmp/base.log) <(grep '^not ok' /tmp/mine.log)
```

Do not "fix" those tests by relaxing the assertion or by re-adding the removed feature.

## Gates before a pull request

In this order: typecheck (`npx tsc -p tsconfig.json --noEmit`) and tests. This repo has no lint
script. The code map itself is
not a gate: it refreshes on the query path, so there is no `trail build` step to remember before
pushing.

Keep a PR to one concern. A change that touches `src/` and also rewrites an unrelated doc is two
PRs.

## Relationship with upstream

```bash
git remote add upstream https://github.com/trailhq/Trail-Code.git
git fetch upstream
git log --oneline HEAD..upstream/main    # what upstream has and this fork doesn't yet
```

- The fork's additions (semantic search, the O(n) `grep` fix, workspace viz, `embeddings.db` in the
  worktree seed) are documented in [FORK.md](FORK.md); when you add one, add its row there with the
  commit and the `file:line` it lives in.
- Upstream PRs that touch code this fork modified will conflict. Prefer re-applying the upstream
  change on top of the fork's version over rewriting the fork's version.
- The `CHANGELOG.md` is upstream's. Its entries about the removed features are history, not
  instructions: don't edit them, and don't restore a feature because a changelog entry mentions it.
- Changes that would put a write back into git — hooks, commits, branches, pushes — are out of
  scope for this fork. So is anything that phones home with code or learnings.

## Versioning and publishing

Versioning is plain semver in `package.json`; the current line is a prerelease
(`0.28.0-semantic.x`), so every publish needs an explicit `--tag latest`, or npm publishes it under
`next` and nobody's `npm i -g trail-code` sees it.

**Publishing is a manual step by the maintainer, never run from CI or by an agent** (it needs the
npm login and is not reversible past 72 hours):

```bash
npm run build                              # dist/ must be current: prepublishOnly builds too,
                                           # but a stale viewer bundle has shipped before
npm pack --dry-run                         # check what goes in: dist, scripts, README.md, LICENSE
npm version <patch|minor|prerelease>       # writes package.json + package-lock.json, makes the tag
npm publish --access public --tag latest
```

Do not publish with `--ignore-scripts` on a fresh clone: it skips `prepare`, and `prepare` is what
builds `dist/`. Build explicitly first.

After publishing, check it landed from the outside rather than trusting the command's output:

```bash
npm view trail-code version dist-tags
npx -y trail-code --version
npx -y trail-code init --dry-run          # in a scratch repo: the MCP entry it writes
```

## The package name, and the names it answers to

The npm package is `trail-code` and it installs one binary, `trail`. The same code also ships as
`graft` (the old `@nanonets/graft` name) for repos wired before the rename; `trail` is what
everything documents. If you add a user-visible string that names the package — an install hint, an
upgrade notice, an MCP entry — it has to say `trail-code`:

- `src/brand.ts` (`PACKAGE_FOR`)
- `src/hosts/mcp-config.ts` (`TRAIL_NPX_LAUNCH`)
- `src/bin/trail.ts` (the Node-too-old message)
- `src/claude/skill-template.ts` and `src/claude/hermes-skill-template.ts` (the install line each
  skill offers)
- `scripts/postinstall.mjs` (`isTrail`, which picks the nudge)

## License

MIT, the same as upstream. Contributions are accepted under it.
