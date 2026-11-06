## MODIFIED Requirements

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

## ADDED Requirements

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
