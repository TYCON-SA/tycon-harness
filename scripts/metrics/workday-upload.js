'use strict';
/**
 * workday-upload.js — LOS DÍAS DE HORAS Y TOKENS, ARMADOS PARA EL BUZÓN
 *
 * Arma un archivo por día local cerrado de la máquina con las horas que trabajaron sus sesiones de agente (los tramos
 * de scripts/lib/worked-time.js) y los tokens de sus conversaciones (Claude con sus agentes, y Codex), para que
 * scripts/metrics/upload-runs.js lo suba como `<maquina>/jornadas/v<versión>/<AAAA-MM-DD>.json`. Lo llama la subida en
 * cada pasada; no sube nada por su cuenta.
 *
 *   { v: 1, dia, tz, horas: { arnes_segundos, sesion_segundos, sesiones, medido: true },
 *                    tokens: { lectura, escritura, cache, medido: true } }
 *
 * `arnes_segundos` es el tiempo con al menos una sesión trabajando (la unión de los tramos); `sesion_segundos`, la suma.
 * Una parte que no se pudo leer va `{ medido: false, motivo }`, con el motivo sin rutas; `horas.ilegibles`,
 * `tokens.sin_hora` y `tokens.ilegibles` aparecen sólo si son más de cero. 🔴 NADA MÁS: ni ids de sesión, ni rutas, ni repos ni historias.
 *
 * 🔴 SÓLO DÍAS LOCALES CERRADOS. «Hoy» es el día local de `now` (en la subida, TYCON_NOW o el reloj), y se arman los 30
 *    días anteriores: nunca el día en curso, nunca el día UTC de la preparación de los registros.
 * 🔴 «NO MEDIDO» NUNCA ES CERO. Las horas son cero medido sólo con la apertura del gancho de ese día y sin tramos; sin
 *    apertura ni tramos, `medido: false`. Un día sin apertura, ni tramos, ni mensajes de ninguna conversación no se arma.
 *
 * Cada conversación se lee una sola vez por pasada, para todos los días que le faltan, y sólo si se tocó desde el
 * comienzo del primero. Un día ya armado guarda sus tokens en `<estado>/worked/armados.json`: se rearma sólo si sus tramos
 * o su apertura cambiaron después (un renglón tardío), con los mismos tokens, sin releer nada. Los tokens de Codex
 * restan el último total guardado del día anterior más nuevo (`<estado>/worked/codex-totals.json`, por día); una
 * conversación sin total guardado cuenta desde su primer conteo del día. Lo de más de 60 días se borra.
 *
 * Casos: scripts/tests/workday-upload.test.js
 */
const fs = require('fs');
const path = require('path');

const WT = require('../lib/worked-time.js');
const TT = require('../lib/transcript-tokens.js');

const WINDOW_DAYS = 30;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const ARMADOS = 'armados.json';
const CODEX_TOTALS = 'codex-totals.json';

/** Un JSON propio: `{ value }`, `{ value: null }` si no está, o `{ value: null, problema }` si está y no se pudo leer. */
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { value: null } : { value: null, problema: e.code || 'error' }; }
  try { return { value: JSON.parse(text) }; } catch { return { value: null, problema: 'JSON roto' }; }
}
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

/**
 * Las conversaciones de la máquina tocadas desde `since` (ms): `{ convs: [{ file, kind, key, mtime, agents }], problema }`.
 * Claude: `<claude>/projects/<proyecto>/<sesión>.jsonl` y sus agentes en `<sesión>/subagents/`. Codex:
 * `<CODEX_HOME>/sessions/<año>/<mes>/<día>/rollout-*.jsonl`. `problema` es el código de una carpeta que no se pudo leer.
 */
function listConversations(home, env, since) {
  const { claudeDir } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const convs = [];
  let problema = null;
  const list = (dir) => {
    try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') problema = problema || e.code || 'error'; return []; }
  };
  const projects = path.join(claudeDir(home), 'projects');
  for (const p of list(projects)) {
    if (!p.isDirectory()) continue;
    const dir = path.join(projects, p.name);
    for (const f of list(dir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, f.name);
      // los agentes de la sesión: los sueltos en subagents/ y los de cada workflow en subagents/workflows/<corrida>/
      const agentsDir = path.join(dir, path.basename(f.name, '.jsonl'), 'subagents');
      const wfDir = path.join(agentsDir, 'workflows');
      const agentFiles = list(agentsDir).filter((a) => a.isFile() && a.name.endsWith('.jsonl')).map((a) => path.join(agentsDir, a.name));
      for (const w of list(wfDir)) if (w.isDirectory()) for (const a of list(path.join(wfDir, w.name))) if (a.isFile() && a.name.endsWith('.jsonl')) agentFiles.push(path.join(wfDir, w.name, a.name));
      const agents = agentFiles.map((a) => ({ file: a, mtime: mtimeOf(a) })).filter((a) => a.mtime >= since);
      const mtime = mtimeOf(file);
      if (mtime >= since || agents.length) convs.push({ file, kind: 'claude', key: f.name, mtime, agents });
    }
  }
  const codexSessions = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
  const walk = (dir, depth) => {
    for (const e of list(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && depth === 3 && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const mtime = mtimeOf(p);
        if (mtime >= since) convs.push({ file: p, kind: 'codex', key: e.name, mtime, agents: [] });
      }
    }
  };
  walk(codexSessions, 0);
  return { convs, problema };
}

/** La resta de dos totales acumulados de Codex, en las tres partes de la tarjeta de la oficina. */
function codexDiff(base, last) {
  const n = (t, k) => Number((t && t[k]) || 0);
  const input = Math.max(0, n(last, 'input_tokens') - n(base, 'input_tokens'));
  const cached = Math.max(0, n(last, 'cached_input_tokens') - n(base, 'cached_input_tokens'));
  return { lectura: Math.max(0, input - cached), escritura: Math.max(0, n(last, 'output_tokens') - n(base, 'output_tokens')), cache: cached };
}

/** El total guardado más nuevo de una conversación de Codex, de un día anterior a `day`, o null. */
function savedBefore(totals, key, day) {
  const days = Object.keys(totals).filter((d) => d < day && totals[d] && totals[d][key]).sort();
  return days.length ? totals[days[days.length - 1]][key] : null;
}

/**
 * Arma los días en `outDir` y devuelve `{ files, dias }`: los nombres que quedaron (los días armados de la ventana) y,
 * por día, si se armó ahora, se reusó o no tenía rastro. Lo ya subido igual no lo vuelve a mandar la subida (su
 * registro compara el contenido). Con TYCON_WORKDAYS=0 no arma nada y vacía `outDir`.
 */
function prepareDays({ sdir, home, outDir, now = Date.now(), env = process.env, isAlive = null } = {}) {
  const clearOut = (keep = new Set()) => {
    let names = [];
    try { names = fs.readdirSync(outDir); } catch { return; }
    for (const n of names) if (DAY_FILE.test(n) && !keep.has(n)) fs.rmSync(path.join(outDir, n), { force: true });
  };
  if (!WT.enabled(env)) { clearOut(); return { files: [], dias: {}, apagado: true }; }
  // sin la carpeta de estado no hay nada que armar, y no se crea: su existencia le dice a la subida que esta máquina
  // participa (prepararRegistros)
  if (!fs.existsSync(sdir)) { clearOut(); return { files: [], dias: {} }; }
  const wdir = WT.dirOf(sdir);
  fs.mkdirSync(wdir, { recursive: true, mode: 0o700 });
  // los tramos de las sesiones que murieron van a su día antes de armar
  WT.closeDead(sdir, { now, env, isAlive });
  const keepFrom = WT.prune(sdir, now);
  const today = WT.dayOf(now);
  const first = WT.addDays(today, -WINDOW_DAYS);
  const days = [];
  for (let d = first; d < today; d = WT.addDays(d, 1)) days.push(d);
  const keepRecent = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([d]) => d >= keepFrom));
  const armados = keepRecent(readJson(path.join(wdir, ARMADOS)).value);
  // los totales de Codex que no se pueden leer (no «no están»): los tokens de Codex de los días que se arman ahora no
  // tienen de dónde restar y van sin medir, no contados de menos
  const leidos = readJson(path.join(wdir, CODEX_TOTALS));
  const totals = keepRecent(leidos.value);

  // la hora del armado es la de antes de mirar los tramos: un renglón que el gancho escribe mientras se leen las
  // conversaciones queda más nuevo que el armado, y la pasada siguiente rearma el día
  const armadoAt = Date.now() - 1;
  // qué días necesitan tokens leídos ahora: los de la ventana que nunca se armaron
  const marks = {};
  for (const d of days) {
    const r = WT.readDay(sdir, d);
    const changedAt = Math.max(mtimeOf(path.join(wdir, `${d}.jsonl`)), mtimeOf(path.join(wdir, `${d}.abierto`)));
    marks[d] = { ...r, changedAt };
  }
  const fresh = days.filter((d) => !armados[d] || (armados[d].vacio && marks[d].changedAt > armados[d].armadoAt));
  const since = fresh.length ? WT.midnightOf(fresh[0]) : Infinity;
  const listed = Number.isFinite(since) ? listConversations(home, env, since) : { convs: [], problema: null };
  const ranges = fresh.map((d) => ({ day: d, desde: WT.midnightOf(d), hasta: WT.midnightOf(WT.addDays(d, 1)) }));
  // una lectura por conversación, para todos los días que le faltan
  const perConv = [];
  for (const c of listed.convs) {
    const wanted = ranges.filter((r) => c.mtime >= r.desde || c.agents.some((a) => a.mtime >= r.desde));
    if (!wanted.length) continue;
    const got = { conv: c, byDay: null, agents: [], problema: null, wanted: new Set(wanted.map((r) => r.day)) };
    try {
      got.byDay = TT.dayTokens(c.file, { days: wanted });
      for (const a of c.agents) got.agents.push(TT.dayTokens(a.file, { days: ranges.filter((r) => a.mtime >= r.desde), isAgent: true }));
    } catch (e) { got.problema = e.code || 'error'; }
    perConv.push(got);
  }

  const files = new Set();
  const dias = {};
  fs.mkdirSync(outDir, { recursive: true });
  for (const d of days) {
    const m = marks[d];
    const prev = armados[d];
    const rastroGancho = Boolean(m.abierto) || m.hayTramos;
    let tokens;
    if (prev && !prev.vacio && !(m.changedAt > prev.armadoAt)) {
      dias[d] = 'reusado';
      tokens = null;
    } else if (prev && !prev.vacio) {
      // un renglón tardío: el día se rearma con los mismos tokens, sin releer nada
      tokens = prev.tokens;
      dias[d] = 'rearmado';
    } else if (prev && prev.vacio && !(m.changedAt > prev.armadoAt)) {
      dias[d] = 'sin_rastro';
      continue;
    } else {
      const t = { lectura: 0, escritura: 0, cache: 0, sinHora: 0, ilegibles: 0 };
      let hubo = false;
      let hayCodex = false;
      // el día en que se tocó por última vez una conversación que no se pudo leer se arma siempre (sin medir); los otros
      // días que esa conversación cubría quedan sin medir sólo si se arman por otro rastro: sin eso, una conversación rota
      // llenaría la ventana entera de días
      let rotaEseDia = null;
      let rotaCubria = null;
      const desde = WT.midnightOf(d);
      const hasta = WT.midnightOf(WT.addDays(d, 1));
      for (const g of perConv) {
        if (g.problema) {
          if (g.conv.mtime >= desde && g.conv.mtime < hasta) rotaEseDia = rotaEseDia || g.problema;
          else if (g.wanted.has(d)) rotaCubria = rotaCubria || g.problema;
          continue;
        }
        const b = g.byDay[d];
        if (b) {
          hubo = hubo || b.hubo;
          t.sinHora += b.sinHora;
          t.ilegibles += b.ilegibles;
          if (g.conv.kind === 'codex') {
            if (b.codex) {
              hayCodex = true;
              const base = savedBefore(totals, g.conv.key, d) || b.codex.primero;
              const diff = codexDiff(base, b.codex.ultimo);
              for (const k of ['lectura', 'escritura', 'cache']) t[k] += diff[k];
              totals[d] = { ...(totals[d] || {}), [g.conv.key]: b.codex.ultimo };
            }
          } else for (const k of ['lectura', 'escritura', 'cache']) t[k] += b[k];
        }
        for (const a of g.agents) {
          const ab = a[d];
          if (!ab) continue;
          hubo = hubo || ab.hubo;
          t.sinHora += ab.sinHora;
          t.ilegibles += ab.ilegibles;
          for (const k of ['lectura', 'escritura', 'cache']) t[k] += ab[k];
        }
      }
      if (!rastroGancho && !hubo && !rotaEseDia) { armados[d] = { vacio: true, armadoAt }; dias[d] = 'sin_rastro'; continue; }
      // una carpeta de conversaciones que no se pudo leer deja sin medir los tokens de los días que se arman
      let motivo = null;
      const rota = rotaEseDia || rotaCubria || listed.problema;
      if (rota) motivo = `una conversación no se pudo leer (${rota})`;
      else if (hayCodex && leidos.problema) motivo = `los totales guardados de Codex no se pudieron leer (${leidos.problema})`;
      tokens = motivo
        ? { medido: false, motivo }
        : { lectura: t.lectura, escritura: t.escritura, cache: t.cache, medido: true, ...(t.sinHora ? { sin_hora: t.sinHora } : {}), ...(t.ilegibles ? { ilegibles: t.ilegibles } : {}) };
      dias[d] = 'armado';
    }
    let contenido;
    if (tokens === null) contenido = prev.contenido;
    else {
      let horas;
      if (m.problema) horas = { medido: false, motivo: `los tramos de ese día no se pudieron leer (${m.problema})` };
      else if (!rastroGancho) horas = { medido: false, motivo: 'el gancho de estado no anotó ese día (apagado o sin instalar)' };
      else horas = { arnes_segundos: m.arnes_segundos, sesion_segundos: m.sesion_segundos, sesiones: m.sesiones, medido: true, ...(m.ilegibles ? { ilegibles: m.ilegibles } : {}) };
      const tz = (m.abierto && typeof m.abierto.tz === 'string' && m.abierto.tz) || WT.tzOf(WT.midnightOf(d));
      contenido = `${JSON.stringify({ v: 1, dia: d, tz, horas, tokens })}\n`;
      armados[d] = { armadoAt, tokens, contenido };
    }
    const name = `${d}.json`;
    const file = path.join(outDir, name);
    let actual = null;
    try { actual = fs.readFileSync(file, 'utf8'); } catch { /* no estaba */ }
    // el mismo contenido no se reescribe: la subida no lo vuelve a mirar
    if (actual !== contenido) writeAtomic(file, contenido);
    files.add(name);
  }
  clearOut(files);
  writeAtomic(path.join(wdir, ARMADOS), `${JSON.stringify(armados)}\n`);
  writeAtomic(path.join(wdir, CODEX_TOTALS), `${JSON.stringify(totals)}\n`);
  return { files: [...files].sort(), dias };
}

module.exports = { prepareDays, listConversations, codexDiff, DAY_FILE, WINDOW_DAYS };
