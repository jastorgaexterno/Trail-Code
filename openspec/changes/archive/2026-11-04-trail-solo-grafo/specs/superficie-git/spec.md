# superficie-git — Delta

## Purpose

Define la superficie del binario tras la amputación de las capas de learnings, knowledge y
cloud: qué comandos CLI y tools MCP existen, y la garantía de que trail solo ejecuta
operaciones git de lectura.

## ADDED Requirements

### Requirement: Trail no ejecuta operaciones git de escritura

El binario SHALL ejecutar únicamente operaciones git de lectura. Ningún camino de código SHALL
invocar git con `commit`, `push`, `pull`, `fetch`, `clone`, `checkout`, creación de `branch`,
`worktree add` ni `stash`. Razón: las escrituras git automáticas chocaban con el flujo del
equipo (ramas protegidas, política MR-only) y son la causa del change.

#### Scenario: Build y consultas no modifican el estado git

GIVEN un repositorio con working tree limpio y N refs
WHEN se ejecutan `trail build`, `trail ask`, `trail grep`, `trail callers`, `trail blast` y
consultas MCP
THEN `git status --short` sigue vacío y el conjunto de refs locales y remotas es idéntico

#### Scenario: El código no contiene invocaciones git de escritura

GIVEN el árbol `src/` compilable del fork
WHEN se buscan los argumentos `commit`, `push`, `pull`, `fetch --all`, `clone`, `checkout`,
`worktree add` en las invocaciones a git (`execFileSync`/`spawn`)
THEN no existe ninguna coincidencia que ejecute git en modo escritura

### Requirement: Superficie CLI reducida a los grupos find, ci y setup

El CLI SHALL exponer únicamente los comandos de los grupos `Find code`, `CI` y `Setup`:
`ask`, `skeleton`, `callers`, `grep`, `map` (find); `blast` (ci); `build`, `init`, `config`,
`status`, `stats`, `viz`, `mcp`, `telemetry`, `upgrade`, `uninstall`, `version` (setup). Los
comandos `note`, `skills`, `team`, `check`, `login`, `logout`, `workspace`, `_trail-sync`,
`_trail-branches`, `_trail-claim`, `_trail-pair` y el subcomando `config knowledge-repo`
SHALL no existir.

#### Scenario: La ayuda no muestra grupos eliminados

GIVEN el binario instalado
WHEN se ejecuta `trail --help`
THEN la salida no contiene los encabezados `Learnings:` ni `Workspace` y ninguno de los
comandos eliminados aparece listado

#### Scenario: Un comando eliminado responde como desconocido

GIVEN el binario instalado
WHEN se ejecuta `trail note --title "x"`
THEN el CLI responde `unknown command` con exit code distinto de 0

### Requirement: trail init escribe exactamente tres clases de salida

`trail init` SHALL escribir únicamente: (1) la sección de trail en `AGENTS.md`, (2) el
directorio `.trail/` para el cache del grafo, (3) las skills de agente — Hermes y Claude Code —
cuando el agente correspondiente está instalado. SHALL no escribir `.claude/settings.json`,
`.trail/hook.cjs`, plugins de Hermes, archivos para Gemini, ni clonar o sincronizar
repositorios. Razón: los hooks eran el vehículo de inyección de learnings; sin learnings son
infraestructura sin carga.

#### Scenario: Init en un repo limpio

GIVEN un repositorio git sin wiring previo
WHEN se ejecuta `trail init --no-build --yes`
THEN los únicos paths creados o modificados son `AGENTS.md`, `.trail/` y (si aplica) las skills
de agente, y no se ejecuta ninguna operación de red ni de clonación

### Requirement: Ayuda y skills generadas congruentes con la superficie

Los textos de `--help` de cada comando superviviente, los hints de error del CLI y las skills
de agente generadas (plantillas `hermes-skill-template.ts` y `skill-template.ts`) SHALL
describir únicamente comandos y tools que existen en el binario. Ninguno SHALL mencionar
`note`, `check`, `team`, `skills`, learnings, knowledge repos, hooks ni cloud. Razón: una skill
que documenta comandos inexistentes hace que el agente los invoque y falle con total confianza.

#### Scenario: La ayuda de los comandos supervivientes no cita comandos eliminados

GIVEN el binario instalado
WHEN se ejecuta `trail <cmd> --help` para cada comando superviviente y se captura la salida
THEN ninguna salida contiene las palabras `trail note`, `trail check`, `trail team`,
`trail skills`, `knowledge-repo` ni `learnings`

#### Scenario: La skill generada solo documenta tools existentes

GIVEN un `trail init` global con Hermes instalado
WHEN se lee la skill generada en el directorio de skills de Hermes
THEN cada comando CLI y cada tool MCP que la skill menciona existe en el binario, y la skill
documenta el comportamiento de worktrees y refresco por drift

### Requirement: Las nueve tools MCP conservan nombre y contrato

El servidor MCP SHALL exponer exactamente estas tools: `trail_set_scope`, `trail_find_code`,
`trail_file_api`, `trail_check_freshness`, `trail_build`, `trail_trace_calls`,
`trail_find_all`, `trail_repo_map`, `trail_search_semantic`. Sus nombres, parámetros y formato
de respuesta SHALL permanecer compatibles con los clientes existentes (Hermes y Claude Code ya
configurados). Razón: el change amputa capas, no renegocia el contrato con los agentes.

#### Scenario: tools/list devuelve las nueve tools

GIVEN el servidor `trail mcp` iniciado sobre un workspace
WHEN un cliente envía `tools/list`
THEN la respuesta contiene exactamente las nueve tools nombradas y ninguna otra
