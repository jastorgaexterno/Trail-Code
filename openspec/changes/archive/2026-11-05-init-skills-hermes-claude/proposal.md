# Proposal

## Why

El usuario pidió que `trail init` deje la skill instalada **completa y correcta en Hermes y en Claude**
("no se ha instalado en mi maquina todavía"). Hoy `trail init` escribe la skill de Hermes **solo como
efecto secundario del flujo de Claude** (`runTrailInit` en `src/claude/init.ts:190-204`): `--agents
hermes` escribe `AGENTS.md` pero **no** instala `~/.hermes/skills/trail/SKILL.md`, y `--agents claude`
escribe **también** la skill de Hermes. El `--help` y `--list-agents` prometen 9-11 hosts que el flujo
real (`wireTarget`, `src/cli.ts:1532`) descarta en silencio, y `--dry-run` anuncia escrituras
(`.claude/settings.json`, `.trail/hook.cjs`, `.trail/statusline.cjs`) que el fork ya no hace.

## What Changes

- **Desacoplar la skill de Hermes del flujo de Claude.** La escritura de `~/.hermes/skills/trail/SKILL.md`
  pasa a estar atada a la selección del host `hermes`, no a `runTrailInit`. Con eso:
  - `--agents hermes` instala la skill de Hermes (además de la sección de `AGENTS.md`).
  - `--agents claude` instala **solo** la skill de Claude Code (deja de filtrar la de Hermes).
  - `--all-agents` instala las dos.
  - `--no-global` no escribe ninguna skill fuera del repo.
- **Superficie de `--agents` honesta, sin amputar el registro multi-host.** El CLI anuncia y valida **solo**
  `claude` y `hermes`: `--help`, `--list-agents` y el mensaje de `unknown agent id` dejan de prometer hosts que
  `init` no cablea. El registro `HOSTS` y la rama multi-host de `runHostsInit` **se conservan a propósito**: no
  son código muerto (`upkeep` los recorre desde el stamp y `retract` deriva de ahí sus targets de instrucciones
  y MCP), así que amputarlos rompería el cleanup de repos cableados por versiones previas. Decisión revisada el
  2026-11-05 (ver `design.md` D3).
- **`--dry-run` congruente.** El plan (`claudeTargetsFor`) deja de listar `hook.cjs`, `settings.json`,
  `settings.local.json` y `statusline.cjs` que `runTrailInit` no escribe.
- **`retract`/`uninstall`/upkeep cubren las dos skills.** Se remueve/reescribe `~/.hermes/skills/trail/SKILL.md`
  igual que ya se hace con la de Claude (`trailSkillPath` en `src/hosts/retract.ts:476`).
- **Limpieza de skill vieja de Hermes.** Si existe `~/.hermes/skills/graft/SKILL.md` de una versión previa,
  `init` la elimina (el `clearOldLayout` actual solo cubre `.claude/skills/`).
- **Quitar el parámetro `brand` muerto** de `hermesSkillTemplate()`: no se usa (`inBrand` no tiene nada que
  reescribir en esa plantilla), y `hermesSkillTemplate('trail') === hermesSkillTemplate('graft')`.

## Capabilities

### Modified Capabilities

- `superficie-git`: el requirement "trail init escribe exactamente tres clases de salida" se ajusta para
  fijar el contrato de `--agents` (qué skill instala cada selección) y se agregan escenarios de
  `--no-global`, `--dry-run` y de la superficie anunciada/validada de `--agents`. Se agrega un requirement
  sobre `retract`/`uninstall`/upkeep cubriendo la skill de Hermes.

## Impact

- **Modificados**: `src/claude/init.ts` (sacar la skill de Hermes de `runTrailInit`; mover la escritura al
  path del host `hermes`), `src/hosts/init.ts` (escribir `~/.hermes/skills/trail/SKILL.md` como write global
  respetando `--no-global`, y borrar la copia `graft` vieja), `src/cli.ts` (`--help`, `--list-agents`,
  validación de ids), `src/hosts/plan.ts` (la skill de Hermes en el plan del `--dry-run`),
  `src/hosts/retract.ts` (remover la skill de Hermes y no nombrar otro producto en la salida),
  `src/claude/hermes-skill-template.ts` (firma sin `brand`).
- **Tests**: `test/claude-init.test.ts`, `test/hosts-init.test.ts`, `test/hosts-retract.test.ts`,
  `test/hosts-trail.test.ts`, `test/claude-skill-template.test.ts`, `test/upkeep.test.ts` y
  `test/init-agents-auto.test.ts` (los dos últimos porque portan el comportamiento nuevo de `uninstall` y del
  refresco de `upkeep`).
- **Sin cambios**: las 9 tools MCP, `trail build/ask/grep/callers/map/skeleton/blast/viz/mcp/status/…`, y el
  contenido de las dos plantillas de skill (ya correcto: 0 `@trailhq/trail-code`, 0 `detacoop`, 0 `npx graft`,
  comandos existentes).
