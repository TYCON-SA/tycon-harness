#!/usr/bin/env node
'use strict';
/*
 * seal.js — EL SELLO DE LA PÁGINA DEL TABLERO
 *
 * La página `artifacts/tablero-del-arnes.html` la genera el nocturno de Azure (`pipelines/azure-pipelines-tablero.yml`) y viaja
 * por git a todo el equipo. Para saber DE CUÁNDO ES y SI SALIÓ COMPLETA, trae adentro un sello legible por máquina:
 *
 *   <script type="application/json" id="tablero-sello">{"esquema":1,"generado":"…","snapshot":"…",…}</script>
 *
 * Un solo lugar para las tres cosas que se hacen con él: lo ESCRIBE el generador (`dashboard.js`), lo VERIFICA el
 * pipeline antes y después de publicar, y lo LEE el aviso de arranque (`scripts/hooks/dashboard-notice.js`). Tres
 * lectores con su propia expresión regular terminan contestando tres cosas distintas.
 *
 * 🔴 La fecha sale del CONTENIDO, nunca del mtime: un `git pull` le pone al archivo la hora del pull, así que una
 *    página de hace una semana se vería de hoy.
 * 🔴 El sello no lleva rutas, nombres de máquina ni texto de afuera: viaja por git a todos. El motivo de un buzón no
 *    leído lo pone el generador desde una lista cerrada.
 *
 * Uso:   node scripts/nightly/dashboard/seal.js --verify <html> [--today AAAA-MM-DD] [--run <id>] --dashboard <dir>
 *         --run: la página tiene que ser de ESA corrida (el pipeline pasa su Build.BuildId). Sin eso, una segunda
 *         corrida del día que no llegó a escribir su página aprobaría la de la corrida anterior.
 * Salida: 0 la página pasa · 1 la página NO pasa (con el motivo) · 2 no se pudo verificar (sin archivo, argumentos
 *         inválidos, dashboard ilegible). «No pude mirar» nunca sale 0.
 */

const fs = require('fs');
const path = require('path');

const ID = 'tablero-sello';
const ESQUEMA = 1;
// El modo de la página del nocturno tiene dos nombres: se acepta «nightly», el nuevo, y se sigue GRABANDO «nocturno», el
// que leen los arneses viejos que todavía estén en alguna máquina (un valor grabado se acepta con el nombre nuevo y se
// graba con el viejo). Lo que se graba cambia cuando ya no quede quien lea sólo el viejo.
const NIGHTLY_RECORDED = 'nocturno';
const NIGHTLY_MODES = new Set(['nightly', NIGHTLY_RECORDED]);
const isNightly = (modo) => NIGHTLY_MODES.has(modo);
const MODOS = new Set([...NIGHTLY_MODES, 'local']);
const ESTADOS_BUZON = new Set(['leido', 'no_leido', 'no_aplica']);
const MAX_MOTIVO = 300;
const ABRE = `<script type="application/json" id="${ID}">`;
const CIERRA = '</script>';

function fechaValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function instanteValido(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(s)
    && fechaValida(s.slice(0, 10)) && !Number.isNaN(Date.parse(s));
}
const entero = (n) => Number.isInteger(n) && n >= 0;
const objeto = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/** null si el sello tiene la forma del esquema 1; si no, el motivo. */
function validar(s) {
  if (!objeto(s)) return 'el sello no es un objeto';
  const claves = Object.keys(s).sort().join(',');
  if (claves !== 'buzon,corrida,esquema,fuentes,generado,modo,snapshot') return `el sello no trae exactamente sus siete claves (${claves})`;
  if (s.esquema !== ESQUEMA) return `esquema desconocido (${JSON.stringify(s.esquema)})`;
  if (!instanteValido(s.generado)) return 'la fecha de generación no es un instante UTC válido';
  if (s.snapshot !== null && !fechaValida(s.snapshot)) return 'la fecha del snapshot no es un día AAAA-MM-DD válido';
  if (!MODOS.has(s.modo)) return `modo desconocido (${JSON.stringify(s.modo)})`;
  if (s.corrida !== null && !(typeof s.corrida === 'string' && /^\d{1,20}$/.test(s.corrida))) return 'la ejecución no es un número de compilación';
  if (s.modo === 'local' && s.corrida !== null) return 'una página local no puede traer ejecución';
  if (!objeto(s.fuentes) || !entero(s.fuentes.esperadas) || !entero(s.fuentes.al_dia) || Object.keys(s.fuentes).length !== 2) return 'las fuentes no traen esperadas y al_dia enteros';
  if (s.fuentes.al_dia > s.fuentes.esperadas) return 'hay más fuentes al día que esperadas';
  const b = s.buzon;
  if (!objeto(b) || !ESTADOS_BUZON.has(b.estado)) return 'el estado del buzón no es uno conocido';
  if (b.estado === 'leido' && !(entero(b.maquinas) && Object.keys(b).length === 2)) return 'un buzón leído trae su cantidad de máquinas y nada más';
  if (b.estado === 'no_leido' && !(typeof b.motivo === 'string' && b.motivo.length > 0 && b.motivo.length <= MAX_MOTIVO && Object.keys(b).length === 2)) return 'un buzón no leído trae su motivo y nada más';
  if (b.estado === 'no_aplica' && Object.keys(b).length !== 1) return 'un buzón que no aplica no trae nada más';
  if (s.modo === 'local' && b.estado !== 'no_aplica') return 'una página local no lee el buzón';
  if (isNightly(s.modo) && b.estado === 'no_aplica') return 'una página del nocturno dice si leyó el buzón';
  return null;
}

/** El bloque HTML del sello. Un sello inválido es un error del generador: se tira, no se escribe. */
function escribir(sello) {
  const motivo = validar(sello);
  if (motivo) throw new Error(`sello inválido: ${motivo}`);
  // `<` escapado: ningún texto del sello puede cerrar el <script> que lo contiene.
  return `${ABRE}${JSON.stringify(sello).replace(/</g, '\\u003c')}${CIERRA}`;
}

/** { sello } o { motivo }. Exige UN solo sello con la forma exacta. */
function leer(html) {
  if (typeof html !== 'string') return { motivo: 'la página no se pudo leer' };
  const i = html.indexOf(ABRE);
  if (i < 0) return { motivo: 'la página no trae sello' };
  if (html.indexOf(ABRE, i + ABRE.length) >= 0) return { motivo: 'la página trae más de un sello' };
  const f = html.indexOf(CIERRA, i + ABRE.length);
  if (f < 0) return { motivo: 'el sello no está cerrado' };
  let s;
  try { s = JSON.parse(html.slice(i + ABRE.length, f)); } catch (_) { return { motivo: 'el sello no es JSON' }; }
  const motivo = validar(s);
  return motivo ? { motivo } : { sello: s };
}

/** La fecha del `sdlc-stage-*.json` más nuevo, por NOMBRE. { fecha } o { motivo }. */
function snapshotMasNuevo(dir) {
  let nombres;
  try { nombres = fs.readdirSync(dir); } catch (e) { return { motivo: `no pude leer ${dir} (${e.code || 'error'})` }; }
  const fechas = nombres.map((n) => (/^sdlc-stage-(\d{4}-\d{2}-\d{2})\.json$/.exec(n) || [])[1]).filter(fechaValida).sort();
  return fechas.length ? { fecha: fechas[fechas.length - 1] } : { motivo: 'no hay ningún sdlc-stage-*.json' };
}

/**
 * { ok: true } · { ok: false, motivo } (la página no pasa) · { ok: false, motivo, noMedido: true } (no se pudo mirar).
 */
function verificar({ html, hoy, dashboard, corrida }) {
  const l = leer(html);
  if (!l.sello) return { ok: false, motivo: `sello ilegible: ${l.motivo}` };
  const s = l.sello;
  if (!isNightly(s.modo)) return { ok: false, motivo: `la página no la generó el nocturno (modo ${s.modo})` };
  if (corrida !== undefined && corrida !== null && s.corrida !== String(corrida)) {
    return { ok: false, motivo: `la página es de la ejecución ${s.corrida === null ? '(ninguna)' : s.corrida}, no de ésta (${corrida})` };
  }
  if (s.generado.slice(0, 10) !== hoy) return { ok: false, motivo: `la página se generó el ${s.generado.slice(0, 10)}, no hoy (${hoy})` };
  const snap = snapshotMasNuevo(dashboard);
  if (!snap.fecha) return { ok: false, motivo: `no pude saber cuál es el snapshot más nuevo: ${snap.motivo}`, noMedido: true };
  if (s.snapshot !== snap.fecha) return { ok: false, motivo: `la página usó el snapshot del ${s.snapshot || '(ninguno)'} y el más nuevo es el del ${snap.fecha}` };
  return { ok: true };
}

/**
 * Si la página salió completa: la generó el nocturno (con su número de corrida), con todas sus fuentes al día y con el
 * buzón leído. Es la regla del aviso de la mañana (scripts/hooks/dashboard-notice.js), que también nombra lo que falta.
 */
function completo(s) {
  return isNightly(s.modo) && s.corrida !== null && s.fuentes.al_dia >= s.fuentes.esperadas && s.buzon.estado === 'leido';
}

module.exports = { ID, ESQUEMA, NIGHTLY_RECORDED, isNightly, completo, escribir, leer, validar, verificar, snapshotMasNuevo, fechaValida, instanteValido };

if (require.main === module) {
  require('../../lib/legacy-names.js').aliasArgv('scripts/nightly/dashboard/seal.js', { exitCode: 2 });
  const args = process.argv.slice(2);
  const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const uso = () => { console.error('uso: node scripts/nightly/dashboard/seal.js --verify <html> [--today AAAA-MM-DD] [--run <id>] --dashboard <dir>'); process.exitCode = 2; };
  const pagina = valor('--verify');
  const dashboard = valor('--dashboard');
  const hoy = valor('--today') === undefined ? new Date().toISOString().slice(0, 10) : valor('--today');
  const corrida = valor('--run');
  if (!pagina || !dashboard || !fechaValida(hoy)) { uso(); return; }
  if (args.includes('--run') &&!(typeof corrida === 'string' && /^\d{1,20}$/.test(corrida))) { uso(); return; }
  let html;
  try { html = fs.readFileSync(path.resolve(pagina), 'utf8'); } catch (e) {
    console.error(`no se pudo verificar: la página ${pagina} no se pudo leer (${e.code || 'error'})`);
    process.exitCode = 2; return;
  }
  const r = verificar({ html, hoy, dashboard: path.resolve(dashboard), corrida });
  if (r.ok) {
    const s = leer(html).sello;
    console.log(`sello ok: generado ${s.generado} · snapshot ${s.snapshot} · buzón ${s.buzon.estado} · fuentes al día ${s.fuentes.al_dia} de ${s.fuentes.esperadas}`);
    process.exitCode = 0;
  } else {
    console.error(`${r.noMedido ? 'no se pudo verificar' : 'la página no pasa'}: ${r.motivo}`);
    process.exitCode = r.noMedido ? 2 : 1;
  }
}
