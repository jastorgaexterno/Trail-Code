# Tasks

## 1. Desacoplar la skill de Hermes del flujo de Claude

- [x] 1.1 Mover la escritura de `~/.hermes/skills/trail/SKILL.md` fuera de `runTrailInit`
      (`src/claude/init.ts`) hacia el path que cablea el host `hermes`, como write global respetando
      `opts.global` (mkdir -p, sin gate de `hermesInstalled`) — verificar en HOME falso que
      `trail init --agents hermes` deja `~/.hermes/skills/trail/SKILL.md` y que `--agents claude` NO deja
      `~/.hermes/skills/trail/SKILL.md`
- [x] 1.2 Quitar el parámetro `brand` de `hermesSkillTemplate()` y ajustar su único llamador — verificar
      `npm run build` (tsc) sin errores y `node --import tsx --test test/claude-skill-template.test.ts` en verde

## 2. Superficie de --agents honesta

- [x] 2.1 Acotar la superficie anunciada/validada de `--agents` a `claude` y `hermes`: `--help`, `--list-agents`
      y el mensaje `unknown agent id` — verificar `trail init --list-agents` imprime solo `claude` y `hermes`,
      `trail init --help` no nombra otros ids, y `trail init --agents cursor` sale con exit code ≠ 0
- [x] 2.2 **CERRADA como "sólo superficie" (decisión del orquestador, 2026-11-05, tras review).** La
      amputación física del registro multi-host NO se hace: `HOSTS` y la rama multi-host de `runHostsInit` no
      son código muerto — `upkeep` los recorre (los hosts del stamp salvo `claude`, `src/upkeep-run.ts:57-59`) y
      `retract` deriva de `HOSTS` sus targets de instrucciones y de MCP (`src/hosts/retract.ts:408-418`,
      `:431-433`), con `LEGACY_TARGETS` guardando sólo `relPath`+`kind` (`retract.ts:84-97`): borrarlas dejaría
      `uninstall` sin limpiar `.cursor/`, `~/.codex/config.toml` y `~/.gemini/…` en repos cableados por
      versiones previas. Lo que sí se hizo es lo de 2.1: `--help`, `--list-agents` y la validación acotados a
      `claude` + `hermes`, con `unknown agent id` (exit 1) para el resto. Verificar (ya verificado):
      `trail init --list-agents` imprime sólo `claude` y `hermes`, `trail init --agents cursor` sale ≠ 0, y la
      suite queda en ≤ 36 fail (baseline del worktree: 1103 tests / 1062 pass / 36 fail / 5 skip; el gate lo
      vuelve a medir el closer con su propia corrida).

## 3. --dry-run congruente

- [x] 3.1 Recortar `claudeTargetsFor` (o el plan que consume) a lo que `runTrailInit` realmente escribe, sin
      anunciar `.claude/settings.json`, `.trail/hook.cjs`, `.claude/settings.local.json`,
      `.trail/statusline.cjs` ni `~/.claude/helpers/graft-hooks.cjs` — verificar `trail init --dry-run` no
      lista esos paths en HOME falso

## 4. retract / uninstall / upkeep

- [x] 4.1 Agregar `~/.hermes/skills/trail/SKILL.md` (y `~/.hermes/skills/graft/SKILL.md`) al target list de
      `retract.ts` como write global — verificar `trail uninstall` en HOME falso borra la skill de Hermes y no
      deja directorios vacíos, y un segundo sweep no encuentra nada
- [x] 4.2 Hacer que `rewriteWiring` (upkeep) reescriba la skill de Hermes cuando `hermes` está en los hosts,
      sin depender de `claude` — verificar un repo cableado con `--agents hermes` y versión distinta reescribe
      `~/.hermes/skills/trail/SKILL.md`
- [x] 4.3 Remover `~/.hermes/skills/graft/SKILL.md` (y su carpeta si queda vacía) al cablear Hermes — vive en el
      path del host `hermes` (`src/hosts/init.ts:104-110`, `removeGraftCopy`), no en `clearOldLayout()`: esa
      función corre sólo en el flujo de Claude y no sabe si `hermes` está seleccionado — verificar que tras
      `init` no queda skill `graft` residual en `~/.hermes/skills/`

## 5. Tests y validación general

- [x] 5.1 Actualizar los tests que cambian de comportamiento (`claude-init`, `hosts-init`, `hosts-retract`,
      `hosts-trail`, `upkeep`, `init-agents-auto`) y agregar cobertura de: `--agents hermes` deja skill,
      `--agents claude` no filtra la de Hermes, `--all-agents` deja las dos, `--no-global` no escribe skills,
      `--dry-run` sin ghost-writes, idempotencia (doble init = mismo hash) — verificar suite completa
      (`npm test`) con **≤ 36 fallos** (baseline del worktree tras el change: 1103 tests / 1062 pass / 36 fail /
      5 skip; baseline de `main`: 1089 / 1047 / 37 / 5 — 0 rojos nuevos y 1 preexistente arreglado; el closer
      remide con su propia corrida)
      · Ojo con el criterio de comandos: vale **`trail <cmd> --help` responde**, no que el comando aparezca en
      `trail --help`: `trail viz` existe y responde, pero está oculto del help a propósito
      (`src/cli.ts:948`, `.command("viz", { hidden: TRAIL })`), y las plantillas lo nombran legítimamente.
- [x] 5.2 `npm run build` exit 0 y `openspec validate init-skills-hermes-claude --strict` sin errores ni
      warnings — verificar la salida del validador

## Workflow follow-up (orquestador, fuera de las cards)

- Instalar la skill real en `~/.hermes/skills/trail/` (zona protegida, la hace el orquestador al cerrar).
- La publicación a npm queda manual, posterior a la validación del usuario sobre el PR.
