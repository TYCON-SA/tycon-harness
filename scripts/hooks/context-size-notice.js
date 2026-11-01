#!/usr/bin/env node
'use strict';
// context-size-notice.js — el aviso de contexto. Casos: scripts/tests/context-size-notice.test.js.
//
// UserPromptSubmit: mide cuántos tokens lleva la sesión y, al cruzar el umbral (300 mil de fábrica), le dice al agente en
// una línea que recomiende `/clear` o una sesión nueva al terminar el paso en curso, nunca en el medio. Avisa una vez al
// cruzarlo y otra cada 100 mil más. Avisa, no frena: el dueño a veces reusa sesiones a propósito.
//
// La medida es el contexto del último turno del asistente: `input_tokens + cache_creation_input_tokens +
// cache_read_input_tokens` de su `usage` en el transcript (en Codex, el `last_token_usage` de su conteo de tokens).
//
// SessionStart con `source` `clear` o `compact`: anota la hora del reinicio. Desde ahí cuentan sólo los turnos
// posteriores, y el aviso vuelve a cero.
//
// Umbral: TYCON_CONTEXT_NOTICE_TOKENS de la máquina, si no `context_notice.tokens` de team-repos.json, si no 300.000.
// Rango 100.000 a 900.000: un valor fuera de rango se salta al siguiente, y el aviso lo dice.
//
// Sin un turno del asistente que contar no dice nada. Lo que no puede medir (un transcript que no se lee, turnos sin
// `usage`, una línea rota al final) lo dice una vez, sin inventar un número. Sale 0 siempre.
// Off: TYCON_CONTEXT_NOTICE=0. Red: scripts/tests/context-size-notice.test.js.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_TOKENS = 300000;
const MIN_TOKENS = 100000;
const MAX_TOKENS = 900000;
const STEP_TOKENS = 100000;
const RANGO = '100.000 a 900.000';

// La carpeta del estado la sabe tycon-home.js; si este archivo viaja suelto (al banco, a un laboratorio), la de siempre.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const safeSid = (sid) => String(sid || '_nosession').replace(/[^A-Za-z0-9._-]/g, '_');

// ── el umbral ────────────────────────────────────────────────────────────────────────────────────────────────────
const enRango = (n) => Number.isInteger(n) && n >= MIN_TOKENS && n <= MAX_TOKENS;

/** `{ data, problem }`: la sección `context_notice` de team-repos.json de la organización, o `data: null` si no hay. */
function orgContextNotice({ env = process.env, tree, homeDir } = {}) {
  const none = { data: null, problem: null };
  try {
    let dir = tree;
    if (!dir) {
      const hp = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'harness-path.js');
      dir = fs.existsSync(hp) ? require(hp).rutaArnesHook({ env, home: homeDir || os.homedir() }).dir : null;
    }
    if (!dir) return none;
    let text;
    try { text = fs.readFileSync(path.join(dir, 'team-repos.json'), 'utf8'); } catch (e) {
      // sin archivo, la organización no declaró nada; uno que está y no se lee se dice
      return e && e.code === 'ENOENT' ? none : { data: null, problem: `team-repos.json de la organización no se pudo leer (${(e && e.code) || e})` };
    }
    const r = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js')).parse(String(text).replace(/^﻿/, ''));
    const sec = r.sectionProblems && r.sectionProblems.context_notice;
    if (sec && sec.length) return { data: null, problem: `${sec[0].path}: ${sec[0].message}` };
    if (!r.ok) {
      const p = (r.problems && r.problems[0]) || {};
      return { data: null, problem: `team-repos.json de la organización no se pudo usar (${p.path ? `${p.path}: ` : ''}${p.message || 'no es válido'})` };
    }
    return { data: (r.data && r.data.context_notice) || null, problem: null };
  } catch (e) { return { data: null, problem: `team-repos.json de la organización no se pudo leer (${(e && e.message) || e})` }; }
}

/** `{ tokens, problem }`: la variable de la máquina, si no la organización, si no 300.000. */
function thresholdTokens({ env = process.env, tree, homeDir } = {}) {
  const problemas = [];
  const v = env.TYCON_CONTEXT_NOTICE_TOKENS;
  if (v !== undefined && String(v).trim() !== '') {
    const n = /^\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN;
    if (enRango(n)) return { tokens: n, problem: null };
    problemas.push(`TYCON_CONTEXT_NOTICE_TOKENS tiene que ser un número entero de tokens, de ${RANGO} (es ${JSON.stringify(String(v)).slice(0, 40)})`);
  }
  const org = orgContextNotice({ env, tree, homeDir });
  if (org.problem) problemas.push(org.problem);
  const t = org.data && org.data.tokens;
  const tokens = !org.problem && enRango(t) ? t : DEFAULT_TOKENS;
  return { tokens, problem: problemas.length ? problemas.join('; ') : null };
}

// ── la medida ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Los tokens de contexto de un registro del transcript, o null si no es un turno del asistente con su conteo. */
function tokensDe(rec) {
  if (!rec || typeof rec !== 'object' || rec.isSidechain) return null;
  if (rec.type === 'assistant' && rec.message && typeof rec.message === 'object') {
    if (rec.message.model === '<synthetic>') return null;
    const u = rec.message.usage;
    if (!u || typeof u !== 'object') return { sinUsage: true };
    const campos = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
    if (!campos.some((k) => Number.isFinite(u[k]))) return { sinUsage: true };
    return { tokens: campos.reduce((s, k) => s + (Number.isFinite(u[k]) ? u[k] : 0), 0) };
  }
  // Codex: el conteo del último turno
  const p = rec.type === 'event_msg' && rec.payload;
  if (p && p.type === 'token_count' && p.info && p.info.last_token_usage && Number.isFinite(p.info.last_token_usage.input_tokens)) {
    return { tokens: p.info.last_token_usage.input_tokens };
  }
  return null;
}

/**
 * `{ tokens }`, `{ sinTurno: true }` (nada que contar) o `{ problem }` (no pude medir): el contexto del último turno del
 * asistente posterior a `desde` (ms; null = toda la sesión).
 */
function medir(transcriptPath, desde, { chunk = 1024 * 1024 } = {}) {
  if (!transcriptPath) return { sinTurno: true };
  const noLee = (e) => ({ problem: `no se pudo leer el transcript (${(e && e.code) || (e && e.message) || e})` });
  const sinUsage = { problem: 'los turnos del asistente no traen su conteo de tokens (usage)' };
  // Se lee desde el final, por bloques, hasta encontrar el turno que cuenta: las sesiones que este aviso busca pueden
  // pasar los ~512 MB, más de lo que Node convierte a texto de una vez.
  let fd;
  try { fd = fs.openSync(transcriptPath, 'r'); } catch (e) {
    return e && e.code === 'ENOENT' ? { sinTurno: true } : noLee(e);
  }
  try {
    let pos;
    try { pos = fs.fstatSync(fd).size; } catch (e) { return noLee(e); }
    let resto = Buffer.alloc(0);
    let primera = true;
    let vioSinUsage = false;
    while (pos > 0 || resto.length) {
      let lineas;
      if (pos > 0) {
        const n = Math.min(chunk, pos);
        pos -= n;
        const buf = Buffer.alloc(n);
        try { fs.readSync(fd, buf, 0, n, pos); } catch (e) { return noLee(e); }
        const junto = Buffer.concat([buf, resto]);
        // el comienzo del bloque puede ser la mitad de un renglón: queda para la lectura siguiente
        const corte = pos > 0 ? junto.indexOf(0x0a) : -1;
        resto = corte >= 0 ? junto.subarray(0, corte) : Buffer.alloc(0);
        lineas = (corte >= 0 ? junto.subarray(corte + 1) : junto).toString('utf8').split('\n');
        // un bloque sin ningún salto de línea es parte de un renglón más largo: se sigue juntando
        if (corte < 0 && pos > 0) { resto = junto; continue; }
      } else {
        lineas = resto.toString('utf8').split('\n');
        resto = Buffer.alloc(0);
      }
      for (let i = lineas.length - 1; i >= 0; i--) {
        if (!lineas[i].trim()) continue;
        const esLaUltima = primera;
        primera = false;
        let rec;
        try { rec = JSON.parse(lineas[i]); } catch {
          if (esLaUltima) return { problem: 'la última línea del transcript está rota' };
          continue;
        }
        // después de un reinicio cuentan sólo los registros con hora posterior; uno sin hora (un resumen) no corta
        const ts = Date.parse(rec && rec.timestamp);
        if (desde != null && !Number.isFinite(ts)) continue;
        if (desde != null && ts <= desde) return vioSinUsage ? sinUsage : { sinTurno: true };
        const t = tokensDe(rec);
        if (!t) continue;
        if (t.sinUsage) { vioSinUsage = true; continue; }
        return { tokens: t.tokens };
      }
    }
    return vioSinUsage ? sinUsage : { sinTurno: true };
  } finally {
    try { fs.closeSync(fd); } catch { /* ya estaba cerrado */ }
  }
}

// ── el estado ────────────────────────────────────────────────────────────────────────────────────────────────────
function leerEstado(f) {
  try { const s = JSON.parse(fs.readFileSync(f, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
}
function guardarEstado(f, s) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, f);
  } catch { /* sin estado el aviso puede repetirse: mejor que no decirlo */ }
}

const mil = (n) => `${Math.floor(n / 1000).toLocaleString('es-AR')} mil`;

/** Lo que el gancho dice para un evento: `{ out }` (vacío = nada). opts: env · home · tree · now. */
function run(evento, { env = process.env, home = os.homedir(), tree, now = Date.now() } = {}) {
  if (env.TYCON_CONTEXT_NOTICE === '0') return { out: '' };
  const ev = evento && typeof evento === 'object' ? evento : {};
  const f = path.join(stateDirOf(home), 'context-notice', `${safeSid(ev.session_id)}.json`);
  const nombre = ev.hook_event_name || '';

  if (nombre === 'SessionStart') {
    if (ev.source === 'clear' || ev.source === 'compact') guardarEstado(f, { resetAt: now, tramo: -1 });
    return { out: '' };
  }
  if (nombre && nombre !== 'UserPromptSubmit') return { out: '' };

  const estado = leerEstado(f);
  const desde = Number.isFinite(estado.resetAt) ? estado.resetAt : null;
  const m = medir(ev.transcript_path, desde);
  if (m.sinTurno) return { out: '' };
  if (m.problem) {
    if (estado.noMedido === m.problem) return { out: '' };
    guardarEstado(f, { ...estado, noMedido: m.problem });
    return { out: `🧠 contexto: no pude medir el tamaño de esta sesión (${m.problem}); sigo sin aviso.` };
  }
  const { tokens: umbral, problem } = thresholdTokens({ env, tree, homeDir: home });
  const previo = Number.isInteger(estado.tramo) ? estado.tramo : -1;
  const sinNoMedido = { ...estado };
  delete sinNoMedido.noMedido;
  if (m.tokens < umbral) {
    if (previo !== -1 || estado.noMedido) guardarEstado(f, { ...sinNoMedido, tramo: -1 });
    return { out: '' };
  }
  const tramo = Math.floor((m.tokens - umbral) / STEP_TOKENS);
  if (tramo <= previo) {
    if (estado.noMedido) guardarEstado(f, sinNoMedido);
    return { out: '' };
  }
  guardarEstado(f, { ...sinNoMedido, tramo });
  const nota = problem ? ` (no usé un valor mal puesto: ${problem})` : '';
  return {
    out: `🧠 contexto: esta sesión lleva ${mil(m.tokens)} tokens (umbral ${mil(umbral)}). Al terminar el paso en curso, nunca en el medio, recomendale a la persona /clear o una sesión nueva.${nota}`,
  };
}

function main() {
  let evento = {};
  try { const raw = fs.readFileSync(0, 'utf8'); if (raw.trim()) evento = JSON.parse(raw); } catch { evento = {}; }
  const { out } = run(evento);
  if (out) process.stdout.write(out + '\n');
}

module.exports = { thresholdTokens, orgContextNotice, medir, tokensDe, run, DEFAULT_TOKENS, MIN_TOKENS, MAX_TOKENS };

if (require.main === module) {
  try { main(); } catch (e) {
    process.stdout.write(`🧠 contexto: el aviso falló (${(e && e.message) || e}); el mensaje sigue\n`);
  }
  process.exit(0);
}
