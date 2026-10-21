#!/usr/bin/env node
/**
 * lane-llm-notice.js — el medidor del desempate por modelo del portón de carril.
 *
 * POR QUÉ EXISTE
 * El portón de carril tiene un desempate por modelo barato
 * (`tycon-pipeline/scripts/lib/lane-classifier.js`):
 * cuando el camino mecánico ya decidió denegar, se le pregunta a Haiku si el USER autorizó el
 * atajo, leyendo sus prompts reales. Si dice que sí, se abre un permiso que el freno había
 * cerrado, y queda un `ADHOC_LLM_OVERRIDE_LANE` en `adhoc.log`.
 *
 * Este medidor cierra un agujero: todo el resto del arnés funciona
 * porque cada control tiene otro que lo mira (los meters de estilo y de bloqueo, el bench-notice,
 * el retro-pending). Una pieza que decide sola y deja su rastro en un archivo que nadie lee es,
 * en la práctica, una pieza sin verificar — que es exactamente lo que el arnés no se permite.
 *
 * QUÉ HACE
 *  · Hook SessionStart: grita SÓLO si hubo overrides NUEVOS desde el último aviso (stamp).
 *    Un override es el único evento que merece revisión humana: el modelo abrió lo que el freno
 *    había cerrado. Si no hubo ninguno, silencio total — un aviso que sale siempre se ignora.
 *  · `--report`: los números a pedido (consultas, overrides, denegados igual). Es la pregunta que
 *    se contesta después de una semana de uso: ¿se llega al desempate?, ¿cuántas veces abre?
 *    Si casi nunca se usa, el modelo sobra y se saca.
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
// BANCO: sin él, los casos de este notice leerían el adhoc.log real del dev.
const STATE_DIR = process.env.TYCON_PIPELINE_STATE_DIR
  || path.join(stateDirOf(os.homedir()));
const LOG = path.join(STATE_DIR, 'adhoc.log');
const STAMP = path.join(STATE_DIR, 'lane-llm-notice-seen.json');

const VENTANA_DIAS = Number(process.env.TYCON_LANE_LLM_NOTICE_DAYS || 30);

function leerEventos() {
  let raw;
  try { raw = fs.readFileSync(LOG, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && o.kind) out.push(o);
    } catch { /* una línea corrupta no invalida el resto */ }
  }
  return out;
}

function desde(evs, iso) {
  if (!iso) return evs;
  const t = Date.parse(iso);
  if (isNaN(t)) return evs;
  // Un ts ilegible cuenta como NUEVO (fail-loud): preferimos avisar de más que perdernos un
  // override, que es el evento que justifica todo este archivo.
  return evs.filter((e) => { const x = Date.parse(e.ts || ''); return isNaN(x) || x > t; });
}

function dentroDeVentana(evs) {
  const corte = Date.now() - VENTANA_DIAS * 24 * 60 * 60 * 1000;
  return evs.filter((e) => { const x = Date.parse(e.ts || ''); return isNaN(x) || x >= corte; });
}

// `via` lo escribe marker.js en los denies y en el override: 'llm' (el modelo contestó),
// 'llm-sin-veredicto' (contestó algo que no era un veredicto claro), 'off' (kill-switch),
// 'sin-prompts', 'error' (el CLI falló: salida != 0, timeout o sin salida estructurada), 'sin-modelo'
// (no hay claude ni codex en el PATH), 'sin-consulta'. Es lo que separa "el modelo no sirve" de
// "nunca se lo consultó".
const CONSULTADO = new Set(['llm', 'llm-sin-veredicto', 'error', 'sin-prompts']);

function stats(evs) {
  const s = { overrides: 0, consultas: 0, abrio: 0, negoIgual: 0, apagado: 0, errores: 0, adhocTotal: 0 };
  for (const e of evs) {
    if (e.kind === 'ADHOC_SET' || e.kind === 'ADHOC_UPDATE') s.adhocTotal++;
    if (e.kind === 'ADHOC_LLM_OVERRIDE_LANE') { s.overrides++; s.abrio++; s.consultas++; continue; }
    // ADHOC_DENIED_LANE: registros de un juez anterior (regex) · ADHOC_LLM_DENIED_LANE: el juez actual vetó.
    if (e.kind === 'ADHOC_SET_UNJUDGED') { s.sinJuez = (s.sinJuez || 0) + 1; if (e.via === 'error') s.errores++; continue; }
    if (e.kind === 'ADHOC_DENIED_LANE' || e.kind === 'ADHOC_LLM_DENIED_LANE' || e.kind === 'ADHOC_DENIED_STORY_QUOTE' || e.kind === 'ADHOC_DENIED_REASON') {
      if (CONSULTADO.has(e.via)) { s.consultas++; s.negoIgual++; }
      if (e.via === 'off') s.apagado++;
      if (e.via === 'error') s.errores++;
    }
  }
  return s;
}

function corto(s, n) { return String(s || '').replace(/\s+/g, ' ').slice(0, n); }

// ── modo --report ────────────────────────────────────────────────────────────────────────────
if (REPORT) {
  const todos = leerEventos();
  const evs = ALL ? todos : dentroDeVentana(todos);
  const s = stats(evs);
  const rango = ALL ? 'todo el log' : `últimos ${VENTANA_DIAS} días`;
  process.stdout.write(
    `desempate por modelo del portón de carril — ${rango}\n` +
    `  consultas al modelo:            ${s.consultas}\n` +
    `  · abrió lo que el freno cerró:  ${s.abrio}\n` +
    `  · denegó igual:                 ${s.negoIgual}\n` +
    `  errores/timeout del modelo:     ${s.errores}\n` +
    `  atajos aceptados sin juez:      ${s.sinJuez || 0}\n` +
    `  denies con el desempate apagado:${s.apagado}\n` +
    `  ad-hoc declarados en total:     ${s.adhocTotal}\n`,
  );
  if (s.consultas === 0) {
    process.stdout.write('\n  Nunca se llegó al desempate: el camino mecánico alcanzó siempre.\n' +
      '  Si esto se sostiene, el modelo sobra y se puede sacar (TYCON_LANE_LLM=0 y después el código).\n');
  } else if (s.abrio === 0) {
    process.stdout.write('\n  Se consultó pero nunca abrió: o el heurístico ya acierta, o el modelo no sirve\n' +
      '  para esto. Mirar los casos concretos antes de decidir cuál de las dos.\n');
  }
  const ovs = evs.filter((e) => e.kind === 'ADHOC_LLM_OVERRIDE_LANE');
  if (ovs.length) {
    process.stdout.write('\n  Overrides (revisar que la decisión haya sido correcta):\n');
    for (const o of ovs.slice(-20)) {
      process.stdout.write(`   · ${o.ts} · ${corto(o.cwd, 60)}\n     motivo: ${corto(o.reason, 100)}\n     carril que pisó: ${corto(o.lanePrompt, 100)}\n`);
    }
  }
  process.exit(0);
}

// ── modo hook (SessionStart) ─────────────────────────────────────────────────────────────────
let stamp = null;
try { stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch { stamp = null; }
const nuevos = desde(leerEventos(), stamp && stamp.lastTs).filter((e) => e.kind === 'ADHOC_LLM_OVERRIDE_LANE');

if (!nuevos.length) process.exit(0);

const lineas = nuevos.slice(-5).map(
  (o) => `   · ${corto(o.reason, 90)}\n     (el freno lo había cerrado por: "${corto(o.lanePrompt, 80)}")`,
).join('\n');

process.stdout.write(
  `<system-reminder>\n` +
  `🟡 desempate por modelo — abrió ${nuevos.length} permiso(s) que el freno de carril había cerrado.\n\n` +
  `El modelo barato leyó los mensajes del user y concluyó que había pedido un ajuste chico, así que\n` +
  `dejó pasar un \`adhoc set\` que el camino mecánico denegaba. Es el único evento del desempate que\n` +
  `merece revisión humana: si alguna de estas decisiones estuvo MAL, ahí hay código que se saltó los\n` +
  `revisores.\n\n${lineas}\n\n` +
  `  Números completos: node ${path.relative(process.cwd(), __filename) || __filename} --report\n` +
  `  Apagar el desempate: TYCON_LANE_LLM=0 · apagar este aviso: TYCON_LANE_LLM_NOTICE=0\n` +
  `</system-reminder>\n`,
);

// El stamp se escribe DESPUÉS de emitir: si el write falla, el próximo arranque vuelve a avisar.
// Perder un aviso es peor que repetirlo.
try {
  fs.mkdirSync(path.dirname(STAMP), { recursive: true });
  const ultimo = nuevos.map((e) => e.ts).filter(Boolean).sort().pop();
  fs.writeFileSync(STAMP, JSON.stringify({ lastTs: ultimo || new Date().toISOString() }, null, 2));
} catch { /* fail-open */ }
process.exit(0);
