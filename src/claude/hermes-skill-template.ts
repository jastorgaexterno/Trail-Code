/**
 * Hermes-specific trail skill template.
 *
 * Hermes (Nous Research) reads skills from its own profile directory
 * (~/.hermes/skills/ or %LOCALAPPDATA%/hermes/skills/) and requires YAML
 * frontmatter with name/description/category/triggers.
 *
 * This is separate from the Claude Code skill (skill-template.ts) because
 * the formats differ. Both describe the same reduced surface: the code map and
 * its nine MCP tools. There is no learnings/knowledge layer any more, so nothing
 * here may name a command or tool the binary does not expose — an agent that
 * reads a skill telling it to run a removed command fails with total confidence.
 */
/**
 * The Hermes skill body. One text, no brand parameter: every command it names is
 * already spelled the way the `trail` binary spells it (the template has no
 * `graft` to rewrite), so a brand argument would only be a parameter nothing
 * reads.
 */
export function hermesSkillTemplate(): string {
  return `---
name: trail
description: >
  Use for ANY task in a trail-indexed repo. Runs trail ask before exploring and
  trail callers before changing a symbol. The index refreshes itself on every
  query and works in git worktrees with no setup.
category: devops
triggers:
  - trail ask / trail grep / trail callers / trail map / trail skeleton
  - code search in trail- or graft-indexed repos
  - blast radius before changing a symbol
  - querying the map from a git worktree
  - semantic search over specs and .md docs
---

# trail — el código en un grafo, no en la cabeza del agente

Un grafo de llamadas construido con tree-sitter (sin LLM, sin API key, $0), expuesto
como CLI y como 9 tools MCP. No genera documentación que alguien tenga que mantener:
responde consultas sobre el código tal como está en el working tree.

## Cuándo usarlo

- **Antes de explorar código**, correr \`trail ask "<tarea>" --source\` — incluso para
  "¿dónde está X?" o "¿cómo funciona Y?", antes de grep o de abrir archivos.
- **Antes de cambiar un símbolo**, correr \`trail callers <sym>\` para ver el blast radius.
- **Para orientarse** en un repo desconocido, \`trail map\` primero.
- **Para specs y docs** (.md), \`trail_search_semantic\`.

## Herramientas MCP — cuál usar

Las 9 tools: \`trail_set_scope\`, \`trail_find_code\`, \`trail_file_api\`,
\`trail_check_freshness\`, \`trail_build\`, \`trail_trace_calls\`, \`trail_find_all\`,
\`trail_repo_map\`, \`trail_search_semantic\`.

| Tool | Para qué | Cuándo |
|---|---|---|
| \`trail_find_code\` | Búsqueda léxica | **Código**: funciones, símbolos, variables, clases |
| \`trail_find_all\` | Grep exhaustivo | Todas las ocurrencias de un literal, agrupadas por símbolo |
| \`trail_trace_calls\` | Grafo de llamadas | Blast radius antes de cambiar algo (\`direction\`, \`depth\`) |
| \`trail_file_api\` | Firmas del archivo | Ver la API sin leer el archivo completo |
| \`trail_repo_map\` | Mapa del repo | Orientarse en un repo o workspace desconocido |
| \`trail_search_semantic\` | Búsqueda conceptual | **Solo specs/docs** en lenguaje natural (.md) |
| \`trail_check_freshness\` | Estado del índice | ¿El mapa coincide con el working tree? |
| \`trail_build\` | Rebuild en background | Reconstruir grafo + índice semántico |
| \`trail_set_scope\` | Fijar scope de sesión | Acotar todas las consultas a un subtree del workspace |

> **Regla del semántico**: \`trail_search_semantic\` embebe lenguaje natural, así que
> rinde en \`.md\` (specs, docs, cartas de sistema) y aporta poco en código.
> Para un nombre de símbolo usar siempre \`trail_find_code\`.
>
> ✅ \`trail_search_semantic("cómo funciona la cuota mínima")\` → encuentra specs
> ❌ \`trail_search_semantic("retomarCopiaEnProceso")\` → no matchea código
> ✅ \`trail_find_code("retomarCopiaEnProceso")\` → encuentra el símbolo exacto

## CLI equivalente (cuando el servidor MCP no está activo)

\`\`\`
trail ask "<pregunta>" --source     # localizar + entender
trail grep "<literal>"              # exhaustivo — todas las ocurrencias
trail callers <sym> --depth 2       # blast radius antes de cambiar
trail skeleton <archivo>            # API del archivo en ~200 tokens
trail map                           # orientación del repo o workspace
trail build                         # reconstruir el mapa (incluye cards e INDEX.md)
trail status                        # estado del mapa, frescura y tokens ahorrados
trail blast --base origin/main      # blast radius de un diff (para CI)
trail viz                           # grafo interactivo en el browser
\`\`\`

\`trail build --deep\` usa un LLM para resumir símbolos: es opt-in y necesita API key.

## Worktrees

Un git worktree enlazado (\`.git\` es un archivo, no un directorio) no tiene índice
propio, porque el mapa vive en el cache git-ignored. **No hay nada que ejecutar
antes**: la primera consulta copia el grafo del checkout principal y lo parchea con
el diff entre las dos ramas, así que la respuesta es sobre el código de *ese*
worktree, no sobre la rama del principal. El índice semántico viaja igual.

## Refresco por drift

Toda consulta compara el fingerprint del índice contra el working tree:

- **Hasta 50 archivos cambiados**: se re-extraen antes de responder. Una edición
  recién hecha ya está en el grafo y la respuesta no lleva advertencia.
- **Más de 50** (un cambio de rama, el merge de trabajo ajeno): se dispara un
  rebuild en background y la respuesta empieza con
  \`[stale: N files changed, rebuilding in background]\`. Significa "esta respuesta
  puede ser anterior al cambio": volver a preguntar en un momento, sin reformular.
- El índice semántico se refresca siempre en background: cargar el modelo local
  cuesta segundos y no debe bloquear una consulta léxica.

Por eso no hace falta \`trail build\` después de un merge. El checkout principal
tampoco necesita quedarse en una rama concreta: cada path consultado responde sobre
su propio working tree.

## Scope en workspace grande

**Siempre acotar al repo correcto** con \`--in\` (CLI) o \`in=\` (MCP). Sin eso, las
búsquedas federan sobre todos los repos del workspace y traen hits de otros clientes.

\`\`\`
# MCP
trail_find_code(query="EvaluacionDetalle", in="default-core/frontend")
trail_search_semantic(query="cuota minima", in="default-core")

# CLI
trail ask "EvaluacionDetalle" --in default-core/frontend/
\`\`\`

En workspaces con repos compound (ej. \`default-core/frontend\`), usar el path
completo: \`in="default-core"\` no es un scope válido.

## Cómo leer el resultado

- Los hits traen \`covers:\` con el \`file:line\` exacto: citar desde ahí, no re-abrir
  el archivo para "verificar".
- Si un span viene truncado ("+N more lines"), abrir el archivo en ese rango exacto.
- \`trail ask\` devuelve top-N; para "todas las ocurrencias" usar \`trail grep\`.
- No pasar la salida por \`head\`/\`tail\`: ya viene acotada y reporta lo que omitió.

## Configuración del servidor MCP (Hermes)

\`\`\`yaml
mcp_servers:
  trail:
    command: C:/Users/<user>/AppData/Roaming/npm/trail.cmd   # o "trail" en Linux/macOS
    args:
      - mcp
      - C:/ruta/al/workspace
    env:
      PYTHONUTF8: "1"
\`\`\`

Si \`trail\` no está instalado: \`npm install -g trail-code --ignore-scripts\`
y después \`trail init\` en el repo.
`;
}
