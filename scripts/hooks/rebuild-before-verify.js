#!/usr/bin/env node
/**
 * rebuild-before-verify.js — tras editar componentes de frontend, asegura que el build de dev
 * del PROYECTO corra antes de pedirle al usuario verificación visual en browser.
 *
 * Origen: instinct fcc5ee1f3c (Ceibo, 1228 ev, 2026-06) generalizado por pedido del dev
 * ("que no sea específico del proyecto") + re-detectado como cb7e2d944b (707 ev, 2026-08-13).
 * El problema medido: edits a .tsx seguidos de "fijate en el browser" que fallan por build
 * roto/no corrido — el type-check solo no atrapa bundling/imports.
 *
 * PROJECT-AGNOSTIC por convención (misma lección que el gate E2E): el comando de build lo
 * declara CADA repo en `.tycon/advisors.yaml`:
 *
 *   frontend:
 *     dev_build_cmd: "npm run build:dev"   # obligatorio para que el hook actúe
 *     dir: "ceibo-deposito"               # opcional: subdir del frontend (components + cwd del build)
 *
 * Sin esa key → no-op TOTAL (cero ruido en repos que no optaron).
 *
 * UN script, TRES registraciones (branch por hook_event_name del payload):
 *   PostToolUse  Edit|Write → si el file es componente (.tsx/.jsx/.vue/.razor) del repo optado,
 *                             marca "frontend sucio" en <repo>/.advisors/frontend-dirty.json
 *   PostToolUse  Bash|PowerShell → si el comando contiene el dev_build_cmd del repo, limpia el marker
 *   UserPromptSubmit        → si hay marker, system-reminder (throttle 10 min): "corré el build
 *                             antes de pedir verificación visual". No bloquea nada.
 *
 * Fail-open total: cualquier error → exit 0 silencioso.
 * Opt-outs: TYCON_REBUILD_VERIFY=0 · TYCON_EVAL_SANDBOX=1 (sandbox de evals se calla).
 */

'use strict';

const fs = require('fs');
const path = require('path');

if (process.env.TYCON_REBUILD_VERIFY === '0') process.exit(0);
if (process.env.TYCON_EVAL_SANDBOX === '1') process.exit(0);

const COMPONENT_RE = /\.(tsx|jsx|vue|razor)$/i;
const NOTICE_THROTTLE_MS = 10 * 60 * 1000;

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12 && dir && dir !== path.dirname(dir); i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

// Parse naive del bloque `frontend:` de .tycon/advisors.yaml (sin deps, fail-open).
function readFrontendConfig(repoRoot) {
  try {
    const yml = fs.readFileSync(path.join(repoRoot, '.tycon', 'advisors.yaml'), 'utf8');
    const lines = yml.split('\n');
    const start = lines.findIndex((l) => /^frontend:\s*(#.*)?$/.test(l));
    if (start === -1) return null;
    const cfg = {};
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\S/.test(l)) break; // dedent → fin del bloque
      let m = l.match(/^\s+dev_build_cmd:\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
      if (m) cfg.devBuildCmd = m[1].trim();
      m = l.match(/^\s+dir:\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
      if (m) cfg.dir = m[1].trim();
    }
    return cfg.devBuildCmd ? cfg : null;
  } catch {
    return null;
  }
}

const markerPath = (repoRoot) => path.join(repoRoot, '.advisors', 'frontend-dirty.json');

function readMarker(repoRoot) {
  try { return JSON.parse(fs.readFileSync(markerPath(repoRoot), 'utf8')); } catch { return null; }
}

function main() {
  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : {};
  } catch { return; }

  const eventName = event.hook_event_name || '';
  const cwd = event.cwd || process.cwd();

  // ── PostToolUse Edit|Write|apply_patch: marcar sucio ──────────────────────
  // apply_patch (Codex, Etapa E2 2026-08-22): la lib compartida lo normaliza a N eventos
  // Edit/Write (uno por archivo del patch); un Edit de Claude pasa como identidad. Fallback:
  // sin la lib, conducta idéntica a la actual (solo Edit/Write nativos).
  if (eventName === 'PostToolUse' && (event.tool_name === 'Edit' || event.tool_name === 'Write' || event.tool_name === 'apply_patch')) {
    let editEvents = [event];
    try { editEvents = require(path.join(__dirname, '..', 'lib', 'hook-io.js')).editEventsFrom(event); } catch { /* fallback */ }
    for (const ev of editEvents) {
      if (ev.tool_name !== 'Edit' && ev.tool_name !== 'Write') continue;
      const filePath = (ev.tool_input && ev.tool_input.file_path) || '';
      if (!COMPONENT_RE.test(filePath)) continue;
      const repoRoot = findRepoRoot(path.dirname(filePath));
      if (!repoRoot) continue;
      const cfg = readFrontendConfig(repoRoot);
      if (!cfg) continue;
      if (cfg.dir && !path.relative(repoRoot, filePath).startsWith(cfg.dir + path.sep)) continue;
      const prev = readMarker(repoRoot) || { files: [], since: new Date().toISOString() };
      const rel = path.relative(repoRoot, filePath);
      if (!prev.files.includes(rel)) prev.files.push(rel);
      prev.dev_build_cmd = cfg.devBuildCmd;
      prev.dir = cfg.dir || null;
      fs.mkdirSync(path.dirname(markerPath(repoRoot)), { recursive: true });
      fs.writeFileSync(markerPath(repoRoot), JSON.stringify(prev, null, 2));
    }
    return;
  }

  // ── PostToolUse Bash|PowerShell: el build corrió → limpiar ────────────────
  // (la herramienta PowerShell es por donde Claude Code corre los comandos en Windows; 2026-10-04)
  if (eventName === 'PostToolUse' && (event.tool_name === 'Bash' || event.tool_name === 'PowerShell')) {
    const cmd = (event.tool_input && event.tool_input.command) || '';
    if (!cmd) return;
    const repoRoot = findRepoRoot(cwd);
    if (!repoRoot) return;
    const marker = readMarker(repoRoot);
    if (!marker) return;
    // 🔴 C10 (2026-08-25) — se acepta el comando CONGELADO en el marker Y el que la config
    // declara HOY. Antes se comparaba sólo contra el del marker, así que si el repo cambiaba
    // `dev_build_cmd` después de marcarse sucio, correr el comando nuevo y correcto NO limpiaba
    // la marca: el recordatorio quedaba pidiendo un comando que ya no existe, y la única forma
    // de salir era editar otro componente (se auto-cura, pero pidiendo lo equivocado mientras
    // tanto). No deja pasar nada malo — es ruido — pero un aviso que pide algo imposible es
    // exactamente lo que entrena a ignorar los avisos.
    // Auditoría: ~/.claude/tycon-harness/guides/decisions/controles-apagables-por-config-2026-08-25.md §C10.
    const cfgAhora = readFrontendConfig(repoRoot);
    const aceptados = [marker.dev_build_cmd, cfgAhora && cfgAhora.devBuildCmd].filter(Boolean);
    if (!aceptados.length) return;
    if (aceptados.some((c) => cmd.includes(c))) {
      try { fs.unlinkSync(markerPath(repoRoot)); } catch { /* fail-open */ }
    }
    return;
  }

  // ── UserPromptSubmit: recordar si sigue sucio (throttle 10 min) ───────────
  if (eventName === 'UserPromptSubmit') {
    const repoRoot = findRepoRoot(cwd);
    if (!repoRoot) return;
    const marker = readMarker(repoRoot);
    if (!marker) return;
    const last = marker.last_notified ? Date.parse(marker.last_notified) : 0;
    if (Date.now() - last < NOTICE_THROTTLE_MS) return;
    marker.last_notified = new Date().toISOString();
    // C10: el aviso nombra el comando que la config declara HOY, no el congelado al marcarse.
    // Se refresca también en el marker para que la rama de Bash converja sin depender de esto.
    const cfgHoy = readFrontendConfig(repoRoot);
    if (cfgHoy && cfgHoy.devBuildCmd) {
      marker.dev_build_cmd = cfgHoy.devBuildCmd;
      marker.dir = cfgHoy.dir || null;
    }
    try { fs.writeFileSync(markerPath(repoRoot), JSON.stringify(marker, null, 2)); } catch { /* fail-open */ }
    const n = marker.files.length;
    const where = marker.dir ? ` (en ${marker.dir}/)` : '';
    process.stdout.write(
      `<system-reminder>\nrebuild-before-verify: hay ${n} componente(s) de frontend editado(s) sin build de dev desde ${marker.since}. ` +
      `ANTES de pedirle al usuario verificación visual en browser, corré \`${marker.dev_build_cmd}\`${where} y verificá que compile ` +
      `(el type-check solo no atrapa bundling/imports). El marker se limpia solo cuando el build corre.\n</system-reminder>\n`
    );
  }
}

try { main(); } catch { /* fail-open */ }
process.exit(0);
