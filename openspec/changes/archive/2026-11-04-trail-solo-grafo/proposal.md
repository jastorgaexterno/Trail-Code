# Proposal

## Why

El fork acumuló cuatro productos en un binario: (A) grafo de código con búsqueda léxica y
semántica, (B) sistema de learnings/knowledge que escribe en git (commit, push, pull, clone,
ramas `chore/trail-learnings-*`), (C) automatización git oculta (pull en session-start,
auto-commit al knowledge repo, intercepción de `gh pr create`/`glab mr create`) y (D) wiring de
agentes (hooks `.cjs`, plugins de Hermes, sync de skills).

En uso real (sesión MTD-359, 2026-11-03) las capas B/C/D produjeron: una rama de learnings
pusheada al repo de código que hubo que limpiar a mano, 9 de 29 repos con índice stale, la
invariante operativa «el checkout principal debe quedarse en develop limpio» impuesta sobre el
flujo git del equipo, y 8 bugs corregidos en un solo merge (`916d838`). La capa A es la única
que se usa y la única que aporta: trail debe hacer solo de trail.

El conocimiento de equipo se migra a un MCP dedicado (proyecto separado, fuera de este change).

## What Changes

- **Se elimina la capa de learnings/memoria**: `src/notes/` completo, `src/check/`
  (verificación de diff contra learnings), `src/learn/`, `src/skills/`, y los comandos CLI del
  grupo `Learnings:` (`note`, `skills`, `team`, `check`).
- **Se elimina la capa cloud/knowledge**: `src/cloud/`, `src/knowledge/`, los comandos del
  grupo cloud (`login`, `logout`, `workspace`), los comandos ocultos `_trail-sync`,
  `_trail-branches`, `_trail-claim`, `_trail-pair`, y el subcomando
  `trail config knowledge-repo`.
- **Se elimina el wiring de hooks**: generación de `.trail/hook.cjs`, `.claude/settings.json`,
  plugin de Hermes `trail-knowledge`, y toda la maquinaria de `src/claude/` que los sostiene.
  La capability `forge-adapter` (archivada 2026-10-29) se elimina con esta capa: su único
  consumidor era el look-back de MRs/PRs para learnings.
- **`trail init` queda mínimo**: escribe la sección de AGENTS.md, crea `.trail/` y genera la
  skill de Hermes. No clona repos, no escribe hooks, no escribe plugins, no lee MRs/PRs.
- **Trail queda git-read-only**: las únicas operaciones git que ejecuta son de lectura
  (`status`, `diff`, `rev-parse`, `log`, `remote`, `worktree list`). Ningún código del binario
  ejecuta `commit`, `push`, `pull`, `clone`, `branch`, `checkout` ni `worktree add`.
- **Worktrees de primera clase**: un worktree hereda el índice del checkout principal
  (seed) y se parchea con el diff entre ramas; toda consulta detecta drift y refresca el índice
  automáticamente (parche inline si el drift es acotado, rebuild en background si no). Se
  elimina la necesidad del `trail build` manual post-merge y la invariante del checkout
  principal limpio.
- **Docs**: README.md, FORK.md y la plantilla de AGENTS.md dejan de mencionar learnings,
  knowledge repos, hooks y cloud; documentan la superficie reducida y el soporte de worktrees.
- **Congruencia de ayuda y skills generadas**: los textos de `--help` de cada comando
  superviviente, los hints de error y los epilogues del CLI no mencionan comandos eliminados;
  las plantillas de skills de agente (`src/claude/hermes-skill-template.ts` y
  `src/claude/skill-template.ts`) se reescriben para describir exactamente la superficie
  reducida (comandos por grupo + 9 tools MCP + worktrees), sin learnings ni knowledge.

## Fuera de alcance

- El MCP de conocimiento de equipo (proyecto nuevo, con su propio spec cuando se decida la
  arquitectura de consumo para 5-10 devs).
- La publicación a npm (`trail-code-detacoop`): queda manual, posterior a la validación del
  usuario sobre el PR mergeado.
- El número de versión del paquete: se decide al publicar.
- Telemetría (`src/telemetry/`, comando `telemetry`): no es git ni knowledge; se toca solo si
  la compilación lo exige por dependencias eliminadas.

## Capabilities

### New Capabilities

- `superficie-git`: define la superficie reducida del binario — qué comandos y tools MCP
  existen, y la prohibición de operaciones git de escritura con su verificación.
- `worktrees`: soporte de primera clase para git worktrees — seed del índice, parche
  incremental por drift, refresco automático al consultar, y exclusión de worktrees como
  children de workspace.

### Removed Capabilities

- `forge-adapter`: la abstracción GitHub/GitLab existía para leer MRs/PRs y detectar señales
  de "ship" — ambos consumidores pertenecen a la capa de learnings que este change elimina.

## Impact

- **Eliminados**: `src/notes/` (28 archivos), `src/knowledge/` (4), `src/cloud/` (10),
  `src/check/` (3), `src/learn/` (2), `src/skills/`, y la mayor parte de `src/claude/`
  (hooks, note-signals, pre-bash, post-bash, stop, skills-wiring, shim-template).
- **Reducidos**: `src/cli.ts` (comandos y grupos eliminados), `src/claude/init.ts` (init
  mínimo), `src/hosts/instructions.ts` (plantilla AGENTS.md sin learnings ni `trail check`).
- **Modificados**: `src/graph/seed.ts` y el camino de consulta MCP/CLI (refresco por drift).
- **Tests**: se eliminan los de módulos eliminados (`test/knowledge-repos.test.ts` entre
  otros); se agregan los de refresco por drift en worktrees.
- **Sin cambios**: las 9 tools MCP existentes conservan nombre y contrato; `trail build`,
  `ask`, `grep`, `callers`, `map`, `skeleton`, `blast`, `viz`, `mcp`, `status`, `stats`,
  `config` (sin `knowledge-repo`), `upgrade`, `uninstall` permanecen.
