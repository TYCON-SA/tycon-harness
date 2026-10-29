#!/usr/bin/env node
/**
 * lane-llm-notice.js — el aviso de arranque de los arreglos rápidos.
 *
 * POR QUÉ EXISTE
 * El arreglo rápido (`marker.js adhoc set`) abre el portón de carril sin story: es la firma `adhoc-lane` del dueño, que
 * se da en la ventana de permiso, en su terminal o por la coordinadora (la sesión designada, con la delegación del
 * perfil). Cada declaración deja un `ADHOC_SET` o `ADHOC_UPDATE` en `adhoc.log` con su `via`. Un permiso que se abre y
 * deja su rastro en un archivo que nadie lee es, en la práctica, un permiso sin mirar: este aviso lo pone a la vista,
 * sobre todo lo que firmó la coordinadora sin preguntar.
 *
 * QUÉ HACE
 *  · Hook SessionStart: si hubo arreglos rápidos nuevos desde el último aviso (el sello), dice cuántos hubo en los
 *    últimos 7 días y cómo se firmaron. Sin novedades, silencio: un aviso que sale siempre se ignora.
 *  · `--report`: la misma cuenta a pedido, en los últimos `TYCON_LANE_LLM_NOTICE_DAYS` días (30) o en todo el log
 *    (`--all`), con los últimos de la coordinadora para revisar.
 *
 * Los renglones viejos sin `via` cuentan aparte, como «sin dato». Los eventos de los jueces que había antes (la cita y
 * el modelo) no cuentan.
 *
 * Fail-open total: sin log, ilegible o vacío → exit 0 mudo. Nunca rompe el arranque de sesión.
 * Opt-out: TYCON_LANE_LLM_NOTICE=0
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const REPORT = process.argv.includes('--report');
const ALL = process.argv.includes('--all');

if (!REPORT && (process.env.TYCON_LANE_LLM_NOTICE === '0' || process.env.TYCON_EVAL_SANDBOX === '1')) process.exit(0);

// Mismo directorio de estado que marker.js (io.DEFAULT_STATE_DIR). El override existe PARA EL
// BANCO: sin él, los casos de este aviso leerían el adhoc.log real del dev.
const STATE_DIR = process.env.TYCON_PIPELINE_STATE_DIR
  || path.join(stateDirOf(os.homedir()));
const LOG = path.join(STATE_DIR, 'adhoc.log');
const STAMP = path.join(STATE_DIR, 'lane-llm-notice-seen.json');

const DIAS_AVISO = 7;
const VENTANA_DIAS = Number(process.env.TYCON_LANE_LLM_NOTICE_DAYS || 30);
const DIA_MS = 24 * 60 * 60 * 1000;
const DECLARACIONES = new Set(['ADHOC_SET', 'ADHOC_UPDATE']);

/** Las declaraciones del arreglo rápido de `adhoc.log` (los demás renglones no cuentan). */
function leerDeclaraciones() {
  let raw;
  try { raw = fs.readFileSync(LOG, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && DECLARACIONES.has(o.kind)) out.push(o);
    } catch { /* una línea corrupta no invalida el resto */ }
  }
  return out;
}

// Un ts ilegible cuenta como reciente y como nuevo: preferimos avisar de más que perder una declaración.
const tsDe = (e) => Date.parse(e.ts || '');
const desdeHace = (evs, dias) => { const corte = Date.now() - dias * DIA_MS; return evs.filter((e) => isNaN(tsDe(e)) || tsDe(e) >= corte); };
function desde(evs, iso) {
  const t = Date.parse(iso || '');
  if (isNaN(t)) return evs;
  return evs.filter((e) => isNaN(tsDe(e)) || tsDe(e) > t);
}

function cuenta(evs) {
  const c = { total: evs.length, ventana: 0, terminal: 0, delegacion: 0, sinDato: 0 };
  for (const e of evs) {
    if (e.via === 'ventana') c.ventana++;
    else if (e.via === 'terminal') c.terminal++;
    else if (e.via === 'delegacion') c.delegacion++;
    else c.sinDato++;
  }
  return c;
}

const renglon = (c, dias) => `arreglos rápidos en ${dias} días: ${c.total} (en la ventana: ${c.ventana}, en la terminal: ${c.terminal}, por la coordinadora: ${c.delegacion})`
  + (c.sinDato ? `; sin dato de cómo se firmó: ${c.sinDato}` : '');

function corto(s, n) { return String(s || '').replace(/\s+/g, ' ').slice(0, n); }

// ── modo --report ────────────────────────────────────────────────────────────────────────────
if (REPORT) {
  const todos = leerDeclaraciones();
  const evs = ALL ? todos : desdeHace(todos, VENTANA_DIAS);
  const c = cuenta(evs);
  process.stdout.write(
    `arreglos rápidos — ${ALL ? 'todo el log' : `últimos ${VENTANA_DIAS} días`}\n` +
    `  declarados o cambiados: ${c.total}\n` +
    `  · en la ventana:        ${c.ventana}\n` +
    `  · en la terminal:       ${c.terminal}\n` +
    `  · por la coordinadora:  ${c.delegacion}\n` +
    `  · sin dato:             ${c.sinDato}\n`,
  );
  const delegados = evs.filter((e) => e.via === 'delegacion');
  if (delegados.length) {
    process.stdout.write('\n  Los de la coordinadora (revisar que correspondían):\n');
    for (const o of delegados.slice(-20)) {
      process.stdout.write(`   · ${o.ts} · sesión ${corto(o.destino || o.sessionId, 40)} · por ${corto(o.by, 40)}\n     motivo: ${corto(o.reason, 100)}\n`);
    }
  }
  process.exit(0);
}

// ── modo hook (SessionStart) ─────────────────────────────────────────────────────────────────
let stamp = null;
try { stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch { stamp = null; }
const todos = leerDeclaraciones();
const nuevos = desde(todos, stamp && stamp.lastTs);
const recientes = desdeHace(todos, DIAS_AVISO);

if (!nuevos.length || !recientes.length) process.exit(0);

process.stdout.write(
  `<system-reminder>\n` +
  `🟡 ${renglon(cuenta(recientes), DIAS_AVISO)}.\n` +
  `  Detalle: node ${path.relative(process.cwd(), __filename) || __filename} --report · apagar este aviso: TYCON_LANE_LLM_NOTICE=0\n` +
  `</system-reminder>\n`,
);

// El sello se escribe DESPUÉS de emitir: si el write falla, el próximo arranque vuelve a avisar.
// Perder un aviso es peor que repetirlo.
try {
  fs.mkdirSync(path.dirname(STAMP), { recursive: true });
  const ultimo = nuevos.map((e) => e.ts).filter(Boolean).sort().pop();
  fs.writeFileSync(STAMP, JSON.stringify({ lastTs: ultimo || new Date().toISOString() }, null, 2));
} catch { /* fail-open */ }
process.exit(0);
