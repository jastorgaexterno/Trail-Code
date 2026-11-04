# Design

## Decisión 1 — Eliminar, no desactivar con flags

Un flag `--no-learnings` dejaría el código muerto adentro: seguiría compilando, seguiría
apareciendo en upgrades del upstream como conflictos de merge, y cualquier regresión lo puede
reactivar. La eliminación física hace el corte verificable con `grep` y reduce la superficie de
mantenimiento, que es el objetivo del change. El costo es divergencia mayor con upstream — se
acepta: el upstream evoluciona hacia Trail Cloud, dirección que este fork no sigue.

## Decisión 2 — La línea de corte es el grupo de ayuda del CLI

`src/cli.ts` ya clasifica cada comando en grupos (`GROUP.find`, `GROUP.ci`, `GROUP.setup`,
`GROUP.memory`, `GROUP.cloud`). La línea de corte: **`memory` y `cloud` se eliminan; `find`,
`ci` y `setup` quedan**. Esto da un criterio literal verificable (`trail --help` no muestra
los grupos eliminados) en vez de una lista ad-hoc de comandos.

## Decisión 3 — `trail blast` y `viz` se quedan

Ambos usan git de **solo lectura** (diff contra una base). El problema nunca fue leer git —
fue escribirlo. `trail check` en cambio se va: verifica el diff contra learnings, y sin
learnings no tiene objeto.

## Decisión 4 — Worktrees: seed + parche incremental, no índice independiente

Elegido por el usuario (gate 2026-11-03). Un índice completo por worktree costaría un build
entero (~minutos + ~100-400 MB de embeddings por worktree) para ramas que difieren del
principal en decenas de archivos. El seed copia el índice del checkout principal
(`src/graph/seed.ts`, ya existe) y el parche re-extrae solo los archivos que difieren entre
las dos ramas.

## Decisión 5 — Refresco automático al consultar, con umbral fijo

Toda consulta (MCP o CLI) compara el fingerprint del índice contra el working tree:

- **Drift ≤ 50 archivos**: se re-extraen esos archivos inline (el pipeline incremental por
  `mtime + hash` ya existe) y la consulta responde sobre el índice fresco.
- **Drift > 50 archivos**: se dispara rebuild en background y la respuesta incluye la
  advertencia `[stale: N files changed, rebuilding in background]` para que el agente sepa
  que puede estar leyendo código viejo.

El umbral 50 es constante, sin configuración (KISS): un merge típico queda bajo el umbral; un
cambio de rama grande o un repo recién clonado lo supera y no bloquea la consulta.

Los **embeddings semánticos** se refrescan siempre en background, nunca inline: cargar el
modelo ONNX cuesta segundos y bloquear una consulta léxica por eso invierte la prioridad. El
pipeline incremental por `body_hash` ya existe.

Consecuencia que elimina dos reglas operativas de la fábrica: ya no hace falta el
`trail build` manual post-merge, y el checkout principal ya no necesita quedarse en `develop`
para que el índice sea confiable — cada path consultado responde sobre su propio working tree.

## Decisión 6 — `trail init` conserva tres clases de salida, elimina el resto

Se queda: sección de AGENTS.md (plantilla sin learnings), `.trail/` (cache), y las skills de
agente (`hermes-skill-template.ts` para Hermes, `skill-template.ts` para Claude Code) — son
documentación de uso, no git, y son el canal por el que un agente aprende a usar las tools.
Ambas plantillas se reescriben en este change para describir solo la superficie reducida. Se
va: `.claude/settings.json`, `.trail/hook.cjs`, plugin `trail-knowledge`, clone/scaffold/sync
de knowledge repos, look-back de MRs/PRs, archivos para Gemini. Razón: los hooks eran el
vehículo de inyección de learnings; sin learnings son infraestructura sin carga, y su
mantenimiento (shim PKGS, doble cache de Hermes, regeneración manual) era una fuente constante
de fricción.

La skill `trail-code` del perfil Hermes del orquestador (documentación del fork para el
agente) no es parte del repo: la reconcilia el orquestador al cierre del change.

## Riesgo principal y mitigación

La eliminación toca `src/cli.ts` (3400+ líneas) y `src/claude/` tiene acoplamiento interno
denso. Mitigación: la eliminación procede por módulo con `npm run build` (tsc) como gate tras
cada grupo — un import colgante es error de compilación, no bug silencioso. Los tests se corren
por archivo (`node --import tsx --test test/<file>.ts`) por el límite ENAMETOOLONG de Windows.
