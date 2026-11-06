# superficie-git Specification

## Purpose
Define la superficie del binario tras la amputación de las capas de learnings, knowledge y
cloud: qué comandos CLI y tools MCP existen, y la garantía de que trail solo ejecuta
operaciones git de lectura.

## Requirements

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
según el conjunto de `--agents` seleccionado. SHALL no escribir `.claude/settings.json`,
`.trail/hook.cjs`, plugins de Hermes, archivos para Gemini, ni clonar o sincronizar
repositorios. Razón: los hooks eran el vehículo de inyección de learnings; sin learnings son
infraestructura sin carga.

#### Scenario: Init en un repo limpio

GIVEN un repositorio git sin wiring previo
WHEN se ejecuta `trail init --no-build --yes`
THEN los únicos paths creados o modificados son `AGENTS.md`, `.trail/` y (si aplica) las skills
de agente, y no se ejecuta ninguna operación de red ni de clonación

#### Scenario: Init con --agents hermes instala la skill de Hermes

GIVEN un HOME limpio sin `~/.hermes` previo
WHEN se ejecuta `trail init --no-build --yes --agents hermes`
THEN existe `~/.hermes/skills/trail/SKILL.md`, existe la sección fenced de trail en `AGENTS.md`,
y no existe `~/.claude/skills/trail/SKILL.md`

#### Scenario: Init con --agents claude instala solo la skill de Claude Code

GIVEN un HOME limpio sin `~/.claude` previo
WHEN se ejecuta `trail init --no-build --yes --agents claude`
THEN existe `~/.claude/skills/trail/SKILL.md` y no existe `~/.hermes/skills/trail/SKILL.md`

#### Scenario: Init con --all-agents instala las dos skills

GIVEN un HOME limpio
WHEN se ejecuta `trail init --no-build --yes --all-agents`
THEN existen `~/.claude/skills/trail/SKILL.md` y `~/.hermes/skills/trail/SKILL.md`

#### Scenario: Init con --no-global no escribe skills fuera del repo

GIVEN un HOME limpio
WHEN se ejecuta `trail init --no-build --yes --no-global` con cualquier conjunto de `--agents`
THEN no se crea ni modifica ningún archivo fuera del repo salvo el cache de telemetría/update-check,
y dentro del repo solo se escriben `AGENTS.md` y `.trail/`

#### Scenario: Init --dry-run anuncia exactamente lo que escribe

GIVEN un repo limpio
WHEN se ejecuta `trail init --no-build --yes --dry-run`
THEN la salida no anuncia `.claude/settings.json`, `.trail/hook.cjs`, `.claude/settings.local.json`,
`.trail/statusline.cjs` ni `~/.claude/helpers/graft-hooks.cjs`

#### Scenario: init anuncia y valida solo los agentes que soporta

GIVEN el binario instalado
WHEN se ejecuta `trail init --list-agents` y se lee `trail init --help`
THEN los únicos agentes anunciados son `claude` y `hermes`, y `trail init --agents cursor` responde
`unknown agent id` con exit code distinto de 0

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

### Requirement: retract, uninstall y upkeep cubren las dos skills de agente

`trail retract` (vía `uninstall`) SHALL eliminar tanto la skill de Claude Code
(`~/.claude/skills/trail/SKILL.md`) como la de Hermes (`~/.hermes/skills/trail/SKILL.md`), y el
refresco de wiring (upkeep) SHALL reescribir la skill de cada agente instalado cuando cambia la
versión del binario, sin depender de que Claude Code esté entre los agentes seleccionados.

#### Scenario: Uninstall elimina la skill de Hermes

GIVEN un HOME con `~/.hermes/skills/trail/SKILL.md` y `~/.claude/skills/trail/SKILL.md` instaladas
WHEN se ejecuta `trail uninstall` sobre el repo
THEN ninguna de las dos skills existe y ningún directorio vacío queda colgando

#### Scenario: Upkeep refresca la skill de Hermes sin Claude seleccionado

GIVEN un repo cableado con `--agents hermes` (skill de Hermes escrita por una versión previa)
WHEN un entry point ejecuta el refresco de wiring con una versión del binario distinta
THEN `~/.hermes/skills/trail/SKILL.md` se reescribe con el contenido de la versión actual
