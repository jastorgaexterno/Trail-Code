# Tasks

## 1. Amputación — capa de learnings y cloud

- [x] 1.1 Eliminar `src/notes/`, `src/check/`, `src/learn/`, `src/skills/`, `src/cloud/`,
      `src/knowledge/` completos, y sus tests (`test/knowledge-repos.test.ts` y todo test que
      importe de esos directorios) — verificar con `npm run build` (tsc) sin errores
- [x] 1.2 Eliminar de `src/cli.ts` los comandos de los grupos `memory` y `cloud`: `note`,
      `skills`, `team`, `check` (teamCheckCommand), `login`, `logout`, `workspace`, los ocultos
      `_trail-sync`, `_trail-branches`, `_trail-claim`, `_trail-pair`, y el subcomando
      `config knowledge-repo` — verificar que `trail --help` no muestre los grupos
      `Learnings:` ni `Workspace`, y que `trail note` responda `unknown command`
- [x] 1.3 Eliminar las constantes `GROUP.memory` y `GROUP.cloud` y todo código que las
      referencie — verificar con `grep -rn "GROUP.memory\|GROUP.cloud" src/` sin resultados
- [x] 1.4 `trail status`: eliminar la fila de learnings; conservar code map y semántico —
      verificar ejecutando `trail status <repo>` sobre un repo indexado

## 2. Amputación — wiring de hooks e init mínimo

- [x] 2.1 `trail init` escribe SOLO: sección de AGENTS.md, directorio `.trail/`, skill de
      Hermes. Eliminar la escritura de `.claude/settings.json`, `.trail/hook.cjs`, plugin
      `trail-knowledge`, archivos Gemini, clone/scaffold/sync de knowledge repos y look-back de
      MRs/PRs — verificar corriendo `trail init --no-build --yes` en un repo temporal y
      listando lo creado
- [x] 2.2 Eliminar de `src/claude/` los módulos de hooks y señales: `hooks.ts`,
      `note-signals.ts`, `pre-bash.ts`, `pre-bash-check.ts`, `pre-bash-skills.ts`,
      `post-bash.ts`, `stop.ts`, `stop-skills.ts`, `start-skills.ts`, `prompt-skills.ts`,
      `skills-wiring.ts`, `skills-hook-util.ts`, `skill-use.ts`, `shim-template.ts`,
      `sync-run.ts`, `walls-hook.ts` y los que queden huérfanos — conservar `init.ts` (reducido),
      `hermes-skill-template.ts`, `build-progress.ts` y lo que el init mínimo necesite;
      verificar con `npm run build`
- [x] 2.3 Confirmar la propiedad git-read-only: `grep -rn "'commit'\|'push'\|'pull'\|'clone'\|'checkout'" src/ --include='*.ts'`
      — cada resultado restante debe ser lectura o texto de ayuda, ninguno un argumento de
      `execFileSync`/`spawn` hacia git; dejar la evidencia del grep en el handoff
      Evidencia corregida (ronda 2): grep comillas simples → 0 resultados; comillas dobles →
      solo blast/render.ts:250,445 (strings de display). src/app/ eliminado (GitHub-App con
      git remote add/fetch/checkout --detach — dep. estructural de capa cloud eliminada)
- [x] 2.4 Tests existentes de los módulos conservados en verde, por archivo:
      `node --import tsx --test test/semantic-search.test.ts test/search-grep.test.ts`

## 3. Worktrees de primera clase

- [x] 3.1 Seed al consultar desde un worktree sin índice: copia grafo léxico + `embeddings.db`
      del checkout principal y parchea el diff entre ramas — ya existe en `src/graph/seed.ts`;
      cubrirlo con un test que cree un worktree real con `git worktree add` en un repo fixture
      Evidencia: `test/graph-seed.test.ts` (14 tests, 0 fail) — los dos escenarios del spec sobre
      `git worktree add` real: "a git worktree starts with no graph, and one query gives it a
      correct one" (respuesta sobre la rama del worktree) y "the parent's vector index is seeded
      too, so semantic search works on the first query" (`embeddings.db` viaja, `searchSemantic`
      responde, sin `Embeddings DB not found`). Limpieza con `git worktree remove --force` en
      `finally`. E2E sobre el binario: worktree nuevo al lado del repo, sin caché propia; la
      primera consulta imprime `[trail] refreshed the graph (2 files changed) before answering —
      copied the graph from the main checkout (…)` y devuelve sólo el símbolo de la rama del
      worktree; el checkout principal no ve ese símbolo.
- [x] 3.2 Refresco por drift en el camino de consulta (MCP y CLI `ask`/`grep`/`callers`):
      comparar fingerprint contra working tree; drift ≤ 50 archivos → re-extraer inline esos
      archivos antes de responder; drift > 50 → rebuild en background y anteponer
      `[stale: N files changed, rebuilding in background]` al resultado — test con fixture que
      modifica 1 archivo (inline) y 51 archivos (background + advertencia)
      Evidencia: `DRIFT_INLINE_MAX = 50` en `src/graph/refresh.ts`; `src/graph/build-run.ts` es el
      runner detached (modos `full`/`graph`/`embed`, libera el lock heredado). Tests en
      `test/graph-refresh.test.ts`: "exactly DRIFT_INLINE_MAX changed files are still patched
      before answering" (50 → inline, sin advertencia), "drift above the threshold answers at once
      with a stale warning, then repairs in background" (51 → `[stale: 51 files changed, rebuilding
      in background]`, y la consulta posterior responde fresca sin advertencia), "a second query
      during a large rebuild neither blocks nor starts a second one".
- [x] 3.3 Embeddings: el refresco inline NO carga el modelo ONNX; el refresco semántico va
      siempre en background — verificar que una consulta léxica con drift de 1 archivo no
      tarde más de 5s adicionales en el fixture
      Evidencia: el parche inline llama solo a `buildGraph` (grafo léxico) y después
      `startBackgroundJob(..., "embed")`, que no crea el índice si no existe. Test "an inline
      patch refreshes the vector index out of process, and only when one exists": sin
      `embeddings.db` no arranca ninguna tarea, con índice arranca `embed` (registrado por el
      stub), y la consulta léxica no crea la DB.
      E2E sobre el binario compilado (`dist/bin/trail.js`, repo temporal con `git init`):
      drift de 1 archivo → `[trail] refreshed the graph (1 file changed) before answering`;
      drift de 51 → `[stale: 51 files changed, rebuilding in background]` y a continuación la
      consulta responde fresca sin nota (el rebuild detached de `dist/graph/build-run.js`
      aterrizó en la práctica).
- [x] 3.4 Worktrees excluidos como children de workspace (`isLinkedWorktree` en
      `src/graph/scopes.ts`, ya existe) — conservar el test existente o agregarlo si no hay
      Evidencia: no había test; agregado "a live worktree is not a workspace child, so the repo is
      counted once" en `test/graph-seed.test.ts` (worktree real hermano del repo → un solo child).

## 4. Documentación

- [x] 4.1 README.md y FORK.md: eliminar toda mención a learnings, knowledge repos, hooks,
      `trail note`, `trail check`, `trail team`, cloud; documentar la superficie reducida
      (comandos por grupo, 9 tools MCP) y el comportamiento de worktrees/refresco —
      verificar con `grep -rn "learning\|knowledge\|note --team\|hook.cjs" README.md FORK.md`
      sin resultados en contexto de feature vigente
      Evidencia: README reescrito (instalación, init de tres salidas, 9 tools, comandos por grupo,
      tabla de drift, worktrees, semántico, workspaces, viz/blast, config MCP, on-disk, env).
      FORK.md reescrito (semántico, worktrees, refresco acotado, grep O(n), Windows, publish).
      `grep -nEi "learning|knowledge|note --team|hook\.cjs" README.md FORK.md` → 0 resultados.
- [x] 4.2 Plantilla de AGENTS.md (`src/hosts/instructions.ts`): eliminar el checklist de
      `trail check --base` y las menciones a learnings; el gate pre-push queda en
      typecheck/lint/tests del repo — verificar generando el AGENTS.md en un repo temporal
      Evidencia: `trail init --no-build --yes <repo temporal>` con el binario compilado escribe
      solo `AGENTS.md` + `.trail/.gitignore` (+ skills en el HOME falso); `grep -Ei "trail check|
      learning|knowledge|hook\.cjs|cloud" AGENTS.md` → 0 resultados; el checklist termina en
      typecheck/lint/tests. El repo temporal construye en `.trail/cache` (ver `repoWiredForTrail`).
- [x] 4.3 Congruencia de ayuda: revisar el `--help` de CADA comando superviviente, los hints de
      error (`configureOutput` en `src/cli.ts`), los epilogues (`src/cli-epilogue.ts`) y los
      mensajes de los tools MCP — verificar con un script que capture `trail <cmd> --help` de
      todos los comandos y haga grep de la lista del requirement:
      `hooks|cloud|learnings|knowledge|trail note|trail check|trail team|trail skills|statusline`
      sin resultados
      Evidencia: `review-congruence-v2.mjs` (re-ejecutado en la ronda 2 de revisión) sobre
      `dist/bin/trail.js` recién compilado, con la lista ampliada del requirement
      (`/trail note/`, `/trail check\b/`, `/trail team/`, `/trail skills/`, `/knowledge-repo/`,
      `/knowledge repo/`, `/learnings?/`, `/\bhooks?\b/`, `/\bcloud\b/`) más `/statusline/`:
      13 comandos supervivientes con `--help` limpio y `trail --help` limpio, 7 comandos
      eliminados (note, skills, team, check, login, logout, workspace) ausentes y respondiendo
      `unknown command`, 45 menciones de tools en las skills renderizadas (Claude 13.539 chars,
      Hermes 6.157 chars) todas dentro de las 9 → `CONGRUENT - no problems`.
      `--no-hooks`/`--no-statusline` ya no existen en `trail init --help`; «the hooks/refresh
      path» ya no aparece en `build --help` (solo queda en comentarios internos de
      `src/graph/source-files.ts` y `src/util/state.ts`, no en la superficie de usuario).
      `src/mcp/instructions.ts`: las 9 tools en `TOOL_ORDER` y en la prosa, cadena renderizada
      de 988 chars (< 1000, la aserción de `test/mcp-server`), `select:…` con los 9 nombres.
      Corregidos además: descripción del programa, `status`, aviso `graft`→`trail`, cierre del
      epilogue de `init` (`git add AGENTS.md .trail`), y los textos del gate de refresco.
- [x] 4.4 Reescribir las plantillas de skills de agente (`src/claude/hermes-skill-template.ts`
      y `src/claude/skill-template.ts`): describir solo la superficie reducida (comandos por
      grupo, 9 tools MCP, worktrees y refresco por drift) — verificar que cada comando/tool
      mencionado en la skill generada exista en el binario
      Evidencia: ambas plantillas reescritas; `test/claude-skill-template.test.ts` (4 tests, 0 fail)
      afirma: sin palabras prohibidas, todo `trail_*` es una de las 9 tools, `build --check` como
      gate de frescura, y worktrees + umbral 50 + `[stale:` presentes en las tres variantes. El
      script de congruencia re-verifica las skills renderizadas contra el binario (45 menciones).


## 5. Validación general — solo al cierre

- [x] 5.1 `npm run build` exit 0; tests por archivo (todos los `test/*.test.ts` que
      sobreviven, con `node --import tsx --test`, archivo por archivo, salida a archivo y tail)
      Evidencia: build exit 0 (tsc + viewer + grammars). 110 archivos ejecutados. Fallos
      preexistentes confirmados contra d6b8444: mcp-tools 2, mcp-server 3 (roster + versión),
      cli-meta 2, hosts-trail 1 (trail spelling), graph-workspace-include-dir 1, hosts-antigravity 1,
      hosts-registry 1, package-peers 1, session-metrics 3, workspace 3, hooks-fifo 0/0 (skipped),
      init-pair-reviews 0/0 (skipped). Ambiental confirmado en base: trail-name y
      claude-init-workspace cuelgan por descarga ONNX en HOME falso (timeout 120s = preexistente).
- [x] 5.2 Instalación real: `npm install -g . --ignore-scripts` tras el build; `trail --version`
      devuelve `0.28.0-semantic.3`; `trail mcp` responde `tools/list` con las 9 tools exactas:
      trail_set_scope, trail_find_code, trail_file_api, trail_check_freshness, trail_build,
      trail_trace_calls, trail_find_all, trail_repo_map, trail_search_semantic.
- [x] 5.3 Flujo worktree end-to-end sobre un repo real: `git worktree add` → primer `trail ask`
      en el worktree imprime `[trail] refreshed the graph (1 file changed) before answering —
      copied the graph from the main checkout` → `betaFn` visible en worktree, invisible en main.
- [x] 5.4 Reconciliar este tasks.md antes de archivar el change — hecho (este commit).

## Workflow follow-up (orquestador, fuera de las cards)

- Reconciliar la skill `trail-code` del perfil Hermes (devops/trail-code) con la superficie
  reducida: eliminar las secciones de learnings, knowledge repos, hooks, cloud y los pitfalls
  de módulos eliminados; documentar worktrees y refresco por drift.
- Reinstalar el binario global, matar el proceso MCP stale de trail y verificar `tools/list`.
- La publicación a npm queda manual, posterior a la validación del usuario sobre el PR.
