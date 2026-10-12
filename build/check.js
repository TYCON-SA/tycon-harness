#!/usr/bin/env node
/**
 * build/check.js — "¿está al día?" para el pre-commit (plan codex-migration.md §3).
 * Delgado a propósito: delega en piezas enfocadas para que cada definición de "al día"
 * viva en UN solo lugar. Exit 1 si alguna falla:
 *   1. generate.js --check — los .toml de adapters/codex/agents/ reflejan su canónico.
 *   2. check-hooks-registration.js — todo hook del banco está registrado en el lado Codex
 *      (o su divergencia declarada), y nada registrado carece de casos (Etapa E1; adelanta
 *      el check #2 de la Etapa H).
 *   3. check-bank-coverage.js — una pieza nueva entra CON sus casos o no entra (regla B2). Los
 *      dos anteriores cubren la migración; éste cubre el después: el advisor #29 que alguien
 *      cree cuando la migración ya sea historia y nadie recuerde la regla.
 *   4. check-hook-coverage.js — la misma regla, pero **censando el disco** (FIX-7, 2026-08-25).
 *      Los tres controles de arriba comparan contra listas escritas a mano: sólo detectan las
 *      piezas que alguien ya se acordó de anotar, justo lo contrario del caso que la regla existe
 *      para atrapar. Éste enumera `scripts/hooks/` y los `on-*`/`hook-*` del pipeline, y exige
 *      casos o deuda declarada (scripts/controls-bench/hook-debt.json).
 *
 * Snippet pre-commit (mismo patrón referencia-por-path que lint-story-frontmatter.js):
 *   node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/build/check.js" || exit 1
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
let bad = 0;
for (const script of ['generate.js', 'check-hooks-registration.js', 'check-bank-coverage.js', 'check-hook-coverage.js']) {
  const args = script === 'generate.js' ? ['--check'] : [];
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) bad = 1;
}
process.exit(bad);
