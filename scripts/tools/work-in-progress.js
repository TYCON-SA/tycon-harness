#!/usr/bin/env node
'use strict';
/*
 * work-in-progress.js — el trabajo en curso de esta máquina, en una tabla (el comando /wip).
 *
 * Una fila por trabajo en curso: cada marcador del pipeline y cada declaración ad-hoc. Cuatro columnas: el trabajo
 * (story y título corto), el estado (el nombre llano del paso, el mismo que muestra el pipeline), la hora estimada de
 * fin y la sesión (su nombre visible o, sin nombre, el id corto). Al pie, las sesiones vivas sin trabajo y lo que no
 * se pudo leer, con su motivo.
 *
 * La hora de fin es la suma de las medianas de los pasos que faltan, tomadas de las corridas archivadas de esta
 * máquina (`timing-history/`), contando sólo los pasos con arranque y fin medidos (`step-times.js`). Al paso en curso
 * se le descuenta lo que ya lleva, nunca por debajo de cero. Si algún paso que falta no tiene mediana, no hay hora:
 * se dice cuál.
 *
 * En la tabla va sólo el trabajo con sesión viva. Lo que quedó de una sesión cerrada (proceso muerto) o sin rastro
 * (sin archivo de sesión: Claude lo borra al cerrar, y Codex no lo escribe) va abajo, en «Quedaron a medio camino»,
 * con la forma de limpiarlo (`clear-session` para un marcador, `adhoc clear-orphan` para un ad-hoc de más de 24 h).
 * El programa no limpia nada.
 *
 * Un marcador sin pasos pendientes está terminado y no se muestra. Uno sin tocar hace más de 24 h no cuenta, igual que
 * para `marker.js list-all`, que lo descarta; acá sólo se dice cuántos hay, sin borrarlos.
 *
 * Sólo lee. No toca marcadores ni lee la configuración de la organización.
 *
 * Uso:  node scripts/tools/work-in-progress.js [--json] [--state-dir <dir>] [--sessions-dir <dir>] [--now <iso>]
 * Sale: 0 con la tabla (aunque haya ilegibles: se dicen) · 2 si no existe la carpeta de estado.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const { stepName } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js'));
const { tiempos } = require(path.join(ROOT, 'scripts', 'metrics', 'step-times.js'));

const TITLE_MAX = 50;
const STALE_MS = 24 * 3600 * 1000;
const MARKER_JS = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const shortId = (sid) => String(sid || '').slice(0, 8) || '?';
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => {
  const chars = Array.from(oneLine(s));
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : chars.join('');
};
const stateOf = (step) => stepName(step) || `paso ${step}`;

// Un objeto JSON, o un error con el motivo: un `null`, un número o una lista no son un marcador ni una sesión.
function readObject(file) {
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('no es un objeto');
  return v;
}

// Los .json de una carpeta. Que no exista es normal (nada de ese tipo); cualquier otro error se dice.
function jsonFiles(dir, unreadable) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => path.join(dir, n)); }
  catch (e) {
    if (e.code !== 'ENOENT') unreadable.push(`${dir}: ${e.message}`);
    return [];
  }
}

function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function storyTitle(storyPath) {
  const text = fs.readFileSync(storyPath, 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const line = fm && /^title:[ \t]*(.+?)\r?$/m.exec(fm[1]);
  if (!line) throw new Error('sin title: en el frontmatter');
  return line[1].trim().replace(/^["']|["']$/g, '');
}

// Medianas en ms por id de paso, de los pasos medidos y sin fusionar de las corridas archivadas.
function stepMedians(dir, unreadable) {
  const samples = {};
  let broken = 0;
  for (const file of jsonFiles(dir, unreadable)) {
    let dump;
    try { dump = readObject(file); } catch { broken += 1; continue; }
    const m = dump && dump.marker;
    if (!m || !m.stepTimings) continue;
    let t;
    try { t = tiempos(m.stepTimings, { inicio: m.startedAt }); } catch { broken += 1; continue; }
    for (const p of t.pasos || []) {
      if (!p.medida || p.subpaso || (p.pasos && p.pasos.length !== 1)) continue;
      (samples[p.paso] = samples[p.paso] || []).push(p.ms);
    }
  }
  if (broken) unreadable.push(`${broken} corrida(s) archivada(s) en ${dir}: no se pudieron leer`);
  const out = {};
  for (const [k, v] of Object.entries(samples)) out[k] = median(v);
  return out;
}

function sessionsBySid(dir, unreadable) {
  const out = new Map();
  for (const file of jsonFiles(dir, unreadable)) {
    let s;
    try { s = readObject(file); } catch (e) { unreadable.push(`${file}: ${e.message}`); continue; }
    if (!s.sessionId) { unreadable.push(`${file}: sin sessionId`); continue; }
    const pid = Number(s.pid);
    if (!Number.isInteger(pid) || pid <= 0) { unreadable.push(`${file}: pid ilegible`); continue; }
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    // Dos archivos con la misma sesión: manda el vivo.
    const prev = out.get(s.sessionId);
    if (!prev || (!prev.alive && alive)) out.set(s.sessionId, { name: s.name || null, alive });
  }
  return out;
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function estimateEnd(marker, medians, nowMs) {
  const pending = (marker.stepsPending || []).map(String);
  if (!pending.length) return 'sin datos (no quedan pasos)';
  const missing = pending.find((s) => medians[s] == null);
  if (missing !== undefined) return `sin datos (${stateOf(missing)})`;
  const current = pending[0];
  const timings = marker.stepTimings || {};
  let since = timings[current] && Date.parse(timings[current].startedAt);
  // Sin arranque anotado del paso en curso, se cuenta desde el fin del último paso: la hora es aproximada y se dice.
  let approx = false;
  if (!Number.isFinite(since)) {
    approx = true;
    const ends = Object.values(timings).map((x) => Date.parse(x && x.completedAt)).filter(Number.isFinite);
    since = ends.length ? Math.max(...ends) : nowMs;
  }
  let left = Math.max(0, medians[current] - Math.max(0, nowMs - since));
  for (const s of pending.slice(1)) left += medians[s];
  return approx ? `${hhmm(nowMs + left)} (aprox.)` : hhmm(nowMs + left);
}

function buildWip(opts = {}) {
  const home = opts.home || os.homedir();
  const sdir = opts.stateDir || stateDir(home);
  const sessionsDir = opts.sessionsDir || path.join(claudeDir(home), 'sessions');
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  if (!Number.isFinite(nowMs)) {
    const err = new Error(`--now no es una fecha: ${opts.now}`);
    err.code = 'BAD_ARG';
    throw err;
  }
  if (!fs.existsSync(sdir)) {
    const err = new Error(`no existe la carpeta de estado del pipeline: ${sdir}`);
    err.code = 'NO_STATE';
    throw err;
  }
  const unreadable = [];
  const sessions = sessionsBySid(sessionsDir, unreadable);
  const medians = stepMedians(path.join(sdir, 'timing-history'), unreadable);
  const rows = [];
  const busy = new Set();

  const halfway = [];
  const liveName = (sid) => {
    const s = sessions.get(sid);
    return s && s.alive ? (s.name || shortId(sid)) : null;
  };

  let stale = 0;
  for (const file of jsonFiles(path.join(sdir, 'active'), unreadable)) {
    let m;
    try { m = readObject(file); } catch (e) { unreadable.push(`${file}: ${e.message}`); continue; }
    if (!Array.isArray(m.stepsPending)) { unreadable.push(`${file}: sin lista de pasos pendientes`); continue; }
    if (!m.stepsPending.length) continue;
    // Sin lastTouch legible, la fecha del archivo; si tampoco se lee, se dice y no se lo da por reciente.
    let touched = Date.parse(m.lastTouch);
    if (!Number.isFinite(touched)) {
      try { touched = fs.statSync(file).mtimeMs; } catch (e) { unreadable.push(`${file}: sin fecha legible (${e.message})`); continue; }
    }
    if (nowMs - touched > STALE_MS) { stale += 1; continue; }
    const sid = m.sessionId || path.basename(file, '.json');
    busy.add(sid);
    let title;
    try { title = storyTitle(m.storyPath); } catch (e) {
      title = '(título ilegible)';
      unreadable.push(`${m.storyPath || '(sin ruta de story)'}: ${e.code === 'ENOENT' ? 'no existe' : e.message}`);
    }
    const step = stateOf(m.stepsPending[0]);
    const work = `${m.storyId || '?'} · ${cut(title, TITLE_MAX)}`;
    const label = liveName(sid);
    if (label) rows.push({ work, state: step, end: estimateEnd(m, medians, nowMs), session: label });
    else halfway.push(`${work} · ${shortId(sid)} · quedó en: ${step} · limpiar: node ${MARKER_JS} clear-session ${sid}`);
  }

  if (stale) unreadable.push(`${stale} marcador(es) sin tocar hace más de 24 h: no cuentan (marker.js list-all los descarta)`);

  for (const file of jsonFiles(path.join(sdir, 'adhoc'), unreadable)) {
    const sid = path.basename(file, '.json');
    let a;
    try { a = readObject(file); } catch (e) { unreadable.push(`${file}: ${e.message}`); continue; }
    busy.add(sid);
    const work = cut(String(a.reason || '(sin motivo)'), TITLE_MAX);
    const label = liveName(sid);
    if (label) rows.push({ work, state: 'Trabajo suelto', end: 'sin estimación (no tiene pasos)', session: label });
    else {
      // Se limpia con `adhoc clear-orphan`, que sólo borra pasadas las 24 h sin tocarse: antes, se dice desde cuándo.
      let touched = [a.lastTouch, a.declaredAt].map((v) => Date.parse(v)).find(Number.isFinite);
      if (touched === undefined) {
        try { touched = fs.statSync(file).mtimeMs; } catch (e) {
          unreadable.push(`${file}: sin fecha legible (${e.message})`);
          halfway.push(`ad-hoc «${work}» · ${shortId(sid)} · fecha ilegible: no se sabe desde cuándo se puede limpiar`);
          continue;
        }
      }
      const how = nowMs - touched > STALE_MS
        ? `limpiar: node ${MARKER_JS} adhoc clear-orphan ${sid}`
        : `se podrá limpiar después de las ${hhmm(touched + STALE_MS)}`;
      halfway.push(`ad-hoc «${work}» · ${shortId(sid)} · ${how}`);
    }
  }

  const free = [...sessions.entries()].filter(([sid, s]) => s.alive && !busy.has(sid)).map(([sid, s]) => s.name || shortId(sid));
  return { rows, free, halfway, unreadable, text: render(rows, free, halfway, unreadable) };
}

function render(rows, free, halfway, unreadable) {
  const esc = (s) => oneLine(s).replace(/\|/g, '\\|');
  const lines = ['| Trabajo | Estado | Fin estimado | Sesión |', '|---|---|---|---|'];
  if (!rows.length) lines.push('| (nada en curso) | | | |');
  for (const r of rows) lines.push(`| ${esc(r.work)} | ${esc(r.state)} | ${esc(r.end)} | ${esc(r.session)} |`);
  lines.push('', `Libres: ${free.length ? free.join(', ') : 'ninguna'}`);
  if (halfway.length) lines.push('', `Quedaron a medio camino (sesión cerrada o sin rastro): ${halfway.length}`, ...halfway.map((h) => `- ${h}`));
  if (unreadable.length) lines.push('', 'No se pudo leer:', ...unreadable.map((u) => `- ${u}`));
  return lines.join('\n');
}

function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (['--state-dir', '--sessions-dir', '--now'].includes(a)) {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { process.stderr.write(`work-in-progress.js: ${a} pide un valor\n`); return 2; }
      opts[{ '--state-dir': 'stateDir', '--sessions-dir': 'sessionsDir', '--now': 'now' }[a]] = v;
    } else { process.stderr.write(`work-in-progress.js: opción desconocida ${a}\n`); return 2; }
  }
  let r;
  try { r = buildWip(opts); } catch (e) {
    if (e.code === 'NO_STATE' || e.code === 'BAD_ARG') { process.stderr.write(`work-in-progress.js: ${e.message}\n`); return 2; }
    throw e;
  }
  process.stdout.write(opts.json ? `${JSON.stringify({ rows: r.rows, free: r.free, halfway: r.halfway, unreadable: r.unreadable }, null, 2)}\n` : `${r.text}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { buildWip, median };
