# Design

## Context

El change `trail-solo-grafo` (archivado 2026-11-04) dejó la superficie en tres clases de salida, pero la
implementación de la skill de Hermes quedó acoplada al flujo de Claude: `runTrailInit`
(`src/claude/init.ts:177-215`) escribe `~/.claude/skills/trail/SKILL.md` **y** `~/.hermes/skills/trail/SKILL.md`
(si `hermesInstalled()`), mientras que `wireTarget` (`src/cli.ts:1532`) solo deja pasar el host `hermes` por
el flujo multi-host (`others = ids.filter((id) => id === "hermes")`). Resultado verificado en HOME falso:

| Invocación | skill Claude | skill Hermes | AGENTS.md |
|---|---|---|---|
| `init --yes --no-build` (default) | sí | sí (si `~/.hermes/skills` existe) | sí |
| `--agents hermes` | no | **no** | sí |
| `--agents claude` | sí | **sí (fuga)** | no |
| `--all-agents` | sí | sí | sí |

## Goals / Non-Goals

- **Goals**: que `--agents hermes` instale la skill de Hermes, que `--agents claude` no la filtre, que
  `--all-agents` instale las dos, que `--no-global` no escriba skills fuera del repo, que `--dry-run` no
  anuncie ghost-writes, que `retract`/`uninstall`/upkeep cubran la skill de Hermes, y que la superficie
  anunciada (`--help`/`--list-agents`/validación) sea honesta.
- **Non-Goals**: no se toca el contenido de las dos plantillas de skill (ya correcto); no se renegocian las
  9 tools MCP; no se rehabilita el soporte de los otros hosts (cursor, gemini, codex, …) que `trail-solo-grafo`
  ya amputó; no se publica npm ni se migra.

## Decisions

**D1 — La skill de Hermes se escribe desde el host `hermes`, no desde el flujo de Claude.**
`runTrailInit` deja de escribir `~/.hermes/skills/trail/SKILL.md`. La escritura pasa al path que cablea el
host `hermes` (junto a la sección de `AGENTS.md` que ya escribe `runHostsInit`), como write **global**
(`~/.hermes/skills/trail/SKILL.md`) que respeta `--no-global`. Alternativa descartada: mantenerlo en
`runTrailInit` y gatear por `ids.includes("hermes")` — deja la skill de Hermes viviendo en el módulo de Claude
y vuelve a acoplarse en el primer refactor.

**D2 — La skill de Hermes se escribe con `mkdir -p`, sin exigir `~/.hermes/skills` preexistente.**
El `hermesInstalled()` actual (`existsSync(~/.hermes/skills)`) hace que un HOME limpio nunca reciba la skill.
Como el write es explícito por selección, se crea el directorio igual que ya hace `runTrailInit` con la de
Claude (`mkdirSync(dirname, { recursive: true })`). "Instalado" se decide por selección/detección, no por la
preexistencia del directorio. Alternativa descartada: conservar `hermesInstalled()` — contradice el criterio
de aceptación "en un HOME limpio, `--agents hermes` deja la skill".

**D3 — Superficie de `--agents` acotada a `claude` y `hermes`; el registro multi-host se conserva a
propósito.**
El CLI anuncia y valida **solo** `claude` + `hermes`: `--help`, `--list-agents` y la validación de ids
(`SUPPORTED_AGENTS`, `src/cli.ts:1296-1300`) dejan de prometer hosts que `init` no cablea, y un id no
soportado responde `unknown agent id` (exit 1). Lo que **no** se hizo es amputar el registro, y es deliberado:
`HOSTS` (`src/hosts/registry.ts:33-95`) y la rama multi-host de `runHostsInit` **no son código muerto**.
Siguen vivos por dos puertas:
  1. `upkeep` los usa: `rewriteWiring` pasa a `runHostsInit` todos los hosts del stamp salvo `claude`
     (`src/upkeep-run.ts:57-59`), así que un repo cableado por una versión previa con `cursor`/`gemini` sigue
     reescribiendo esos archivos en cada apertura de sesión.
  2. `retract` deriva de ahí su lista de targets: las instrucciones de cada host (`src/hosts/retract.ts:408-418`)
     y los registros MCP (`mcpTargets(repo, HOSTS.map(…))`, `retract.ts:431-433`). Amputar `HOSTS` dejaría
     `uninstall` sin poder limpiar `.cursor/`, `~/.codex/config.toml` o `~/.gemini/…` en esos repos, porque
     `LEGACY_TARGETS` sólo guarda `relPath`+`kind` (`retract.ts:84-97`) y no sabe renderizar formatos MCP ni
     `hooks.json`. Borrar esas entradas no sería limpieza: sería perder la capacidad de `retract` y romper el
     cleanup de lo ya cableado.
La decisión inicial del gate («amputar», tomada por analogía con la Decisión 1 de `trail-solo-grafo`) queda
**revisada el 2026-11-05**: esa decisión aplica a features que el fork **quitó** (learnings, cloud, hooks), no
a un registro que sigue en uso. Alternativa descartada: amputar y reconstruir un `LEGACY_TARGETS` con
`relPath`+`kind`+`format` — obliga a tocar `src/hosts/{antigravity,mcp-config,auto,instructions}.ts` y cuatro
archivos de test más, para un objetivo que la card no pidió («que la skill quede bien en Hermes y Claude»).
La superficie que el usuario ve queda acotada; el registro queda como fuente de datos de `upkeep` y de
`retract`. Ningún otro comportamiento del fork se toca.

**D4 — Dos fuentes de texto de skill, una por cliente.** `skill-template.ts` (Claude, frontmatter mínimo) y
`hermes-skill-template.ts` (Hermes, con `category`/`triggers`) ya existen y difieren a propósito. Se mantienen
dos plantillas; se quita el parámetro `brand` de `hermesSkillTemplate()` porque no se usa (`inBrand` no tiene
`graft` que reescribir en esa plantilla). Alternativa descartada: unificar en una plantilla — obliga a dos
frontmatters condicionales en un solo string y rompe la legibilidad sin ganar nada.

**D5 — `retract`/`uninstall`/upkeep cubren la skill de Hermes.** Se agrega `~/.hermes/skills/trail/SKILL.md`
al target list de `retract.ts` (global, junto a `trailSkillPath`) y al refresco de `rewriteWiring`, de modo
que `uninstall` la borre y upkeep la reescriba aunque `claude` no esté en los hosts. Alternativa descartada:
dejarlo solo en `init` — un upgrade no refrescaría la skill de Hermes en repos cableados solo con `hermes`.

**D6 — `--dry-run` se corrige alineando `claudeTargetsFor` con `runTrailInit`.** `claudeTargetsFor`
(`src/claude/init.ts:72-82`) lista `.claude/settings.json`, `.trail/hook.cjs`, `.claude/settings.local.json`
y `.trail/statusline.cjs` para el plan, pero `runTrailInit` no los escribe. Se recorta el target list a lo que
ese flujo realmente escribe: `.trail/.gitignore` y la skill de Claude. La skill de Hermes **no** sale de ahí:
entra al plan por el host `hermes` (`src/hosts/plan.ts:96-102`), que es quien la escribe. El comentario
"kept for retract/plan compatibility" del archivo era falso para el plan.

**D7 — Limpieza de skill vieja `graft` en Hermes.** `clearOldLayout()` (`src/claude/init.ts:210`) limpia
`.claude/skills/{graft,trail}` y `.claude/helpers`, pero corre sólo en el flujo de Claude y no sabe si `hermes`
está seleccionado, así que **no** es donde se borra `~/.hermes/skills/graft/`. El borrado vive en el path del
host `hermes` (`runHostsInit`, `src/hosts/init.ts:104-110`, con `removeGraftCopy`): tras escribir la skill de
trail, elimina `~/.hermes/skills/graft/SKILL.md` y su carpeta si queda vacía — bajo el mismo `outside('hermes')`
que el write, o sea también detrás de `--no-global`. Así Hermes nunca carga dos skills para una herramienta.

## Risks / Trade-offs

- [Tests de multi-host] → `test/hosts-trail.test.ts`, `test/hosts-init.test.ts` y `test/init-agents-auto.test.ts`
  siguen ejercitando el registro completo (no se amputa, ver D3); el coder sólo ajusta lo que cambia de
  comportamiento en la superficie de `--agents`. Gate: `npm test` ≤ **36 fail** sobre el baseline del worktree
  medido tras el change (1103 tests / 1062 pass / 36 fail / 5 skip; baseline de `main`: 1089 / 1047 / 37 / 5,
  0 rojos nuevos y 1 rojo preexistente arreglado). El gate lo mide el closer con **su propia corrida** en el
  worktree: los conteos de acá son la referencia del coder, no un resultado a heredar.
- [Idempotencia de la skill de Hermes] → la escritura con `writeFileSync` sobre un contenido determinista ya es
  idempotente; se cubre con un test de doble `init` (mismo hash).
- [Write global fuera de alcance de `--no-global`] → el write de la skill de Hermes queda detrás del mismo
  `opts.global` que la de Claude, y se cubre con el escenario `--no-global` del delta.

## Migration Plan

No hay migración de datos ni deploy: es un cambio de comportamiento del binario. El cierre (`closer`) corre la
suite completa y el cambio se valida con un HOME falso (sin tocar el `~/.hermes/skills` real). La instalación
real en la máquina del usuario la dispara el orquestador al cerrar, nunca este change.

## Open Questions

Ninguna.
