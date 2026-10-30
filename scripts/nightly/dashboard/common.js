#!/usr/bin/env node
'use strict';
/*
 * common.js — la presentación COMPARTIDA de las dos páginas del tablero.
 *
 * Trae las utilidades honestas (medida / noMedida / ratio / mediana / edad), la ficha con su
 * denominador, el chip con glifo y palabra, el juicio por umbral y el CSS del tema y de las fichas.
 *
 * Por qué existe: la vista de corridas necesita exactamente estas piezas, y copiarlas sería tener
 * dos fichas que se separan solas el día que alguien arregle una. Lo que es de UNA sola página
 * (barrasCausa, filaFuente, grafico, la línea de tiempo de una corrida) se queda en su página.
 */

/** Una métrica NUNCA es un número pelado: quien quiera el valor se choca con el denominador. */
function medida(valor, medidos, total, extra = {}) {
  return { estado: 'medido', valor, medidos, total, motivo: null, ...extra };
}
function noMedida(motivo, extra = {}) {
  if (!motivo) throw new Error('INV-3: un valor nulo exige motivo');
  return { estado: 'no_medido', valor: null, medidos: 0, total: null, motivo, ...extra };
}
/** INV-6: numerador y denominador del mismo universo; den 0 → gris, jamás 0 %. */
function ratio(num, den, motivoSiVacio = 'denominador vacío') {
  if (!Number.isFinite(num) || !Number.isFinite(den)) return noMedida('numerador o denominador ausente');
  if (den === 0) return noMedida(motivoSiVacio);
  if (num > den) return noMedida(`ratio inválido: ${num} sobre ${den} — numerador y denominador de universos distintos`);
  return medida(num / den, num, den, { unidad: 'ratio' });
}
const mediana = (v) => { const s = [...v].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const pct = (x) => `${(x * 100).toFixed(0)}%`;
const num1 = (x) => (Math.round(x * 10) / 10).toString().replace('.', ',');

function edadDias(iso, hoy) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((hoy - t) / 86400000);
}
function edadTexto(d) {
  if (d === null) return 'sin fecha';
  if (d <= 0) return 'hoy';
  if (d === 1) return 'ayer';
  return `hace ${d} días`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const GLIFO = { ok: '●', warn: '◆', bad: '▲', blind: '▨', decl: '◇' };

/** El juicio sale de `sources.json → thresholds`. Sin fila, la ficha queda neutra. */
/**
 * 🔴 Un umbral PRESENTE pero mal formado (sin `direction`, o con un número que falta) no es un
 * umbral: comparado contra `undefined` daría SIEMPRE «atención», indistinguible de un juicio real.
 * Se declara: la ficha sale neutra y con el motivo.
 */
function umbralValido(u) {
  if (!u || typeof u !== 'object') return false;
  if (u.direction === 'mayor_es_mejor') return Number.isFinite(u.ok_min) && Number.isFinite(u.bad_max);
  if (u.direction === 'menor_es_mejor') return Number.isFinite(u.ok_max) && Number.isFinite(u.bad_min);
  return false;
}
function motivoUmbral(cfg, clave) {
  const u = cfg && cfg.thresholds && cfg.thresholds[clave];
  if (u === undefined) return null;
  return umbralValido(u) ? null : `umbral «${clave}» mal formado en sources.json: sin juicio de color`;
}
function juzgar(cfg, clave, m) {
  if (!m || m.estado !== 'medido') return 'blind';
  if (m.prov === 'declarada') return 'decl';
  const u = cfg.thresholds && cfg.thresholds[clave];
  if (!u || !umbralValido(u)) return '';
  const v = m.valor;
  if (u.direction === 'mayor_es_mejor') return v >= u.ok_min ? 'ok' : v <= u.bad_max ? 'bad' : 'warn';
  return v <= u.ok_max ? 'ok' : v >= u.bad_min ? 'bad' : 'warn';
}

function chip(estado, palabra) {
  const cls = estado || 'neutro';
  return `<span class="chip ${cls}"><span class="g">${GLIFO[estado] || '○'}</span>${esc(palabra)}</span>`;
}

/**
 * 🔴 La ficha. Si la métrica no está medida, el valor NO SE DIBUJA: queda la trama, la palabra y el
 * motivo. Si está medida, el denominador va AL LADO del número, no en un globito.
 */
function ficha(cfg, clave, titulo, m, fmt, palabras = {}, pie = null) {
  const est = juzgar(cfg, clave, m);
  if (est === 'blind') {
    return `<div class="tile blind">${chip('blind', 'no medido')}<div class="t-label">${esc(titulo)}</div><div class="t-val">falta</div><div class="t-den">${esc((m && m.motivo) || 'sin motivo declarado — es un error del colector')}</div>${pie ? `<div class="t-foot">${pie}</div>` : ''}</div>`;
  }
  const et = m.den_etiqueta ? ` ${esc(m.den_etiqueta)}` : '';
  const den = m.unidad === 'ratio'
    ? `${m.medidos} de ${m.total}${et}`
    : `n=${m.medidos}${m.total && m.total !== m.medidos ? ` de ${m.total}` : ''}${et}`;
  const palabra = palabras[est] || { ok: 'bien', warn: 'atención', bad: 'rojo', decl: 'declarado', '': 'medido' }[est];
  const provNota = est === 'decl' ? `<div class="t-den">declarado en ${esc(m.fuente)} el ${esc(m.fecha)} — no lo produjo un registro</div>` : '';
  const umbralNota = motivoUmbral(cfg, clave);
  if (umbralNota) pie = `${pie ? pie + ' ' : ''}<b>${esc(umbralNota)}</b>`;
  return `<div class="tile ${est}">${chip(est, palabra)}<div class="t-label">${esc(titulo)}</div><div class="t-val">${fmt(m.valor)}</div><div class="t-den">${den}</div>${provNota}${m.detalle ? `<div class="t-foot">${esc(m.detalle)}</div>` : ''}${pie ? `<div class="t-foot">${pie}</div>` : ''}</div>`;
}

/** El tema, la grilla y las fichas: lo que las dos páginas comparten del <style>. */
const CSS_BASE = `:root{--bg:#F1F4F5;--surface:#FFFFFF;--surface-2:#F7F9FA;--line:#D5DCDF;--line-strong:#A9B5BA;--ink:#15191C;--ink-2:#4C555B;--ink-3:#77848A;--accent:#14595E;--accent-soft:#E2EEEE;--good:#1B6E47;--warn:#8A5A05;--crit:#A62119;--good-soft:#E3F0E9;--warn-soft:#F5EBDA;--crit-soft:#F7E4E2;--hatch:#9AA6AC;--shadow:0 1px 2px rgba(15,25,30,.06)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0F1418;--surface:#171D22;--surface-2:#1D242A;--line:#2B343B;--line-strong:#44515A;--ink:#E9EFF2;--ink-2:#AAB7BF;--ink-3:#7C8A93;--accent:#5CB6BA;--accent-soft:#12312F;--good:#57B383;--warn:#D2A046;--crit:#E4736A;--good-soft:#15291F;--warn-soft:#2A2114;--crit-soft:#2C1917;--hatch:#59666E;--shadow:0 1px 2px rgba(0,0,0,.4)}}
:root[data-theme="dark"]{--bg:#0F1418;--surface:#171D22;--surface-2:#1D242A;--line:#2B343B;--line-strong:#44515A;--ink:#E9EFF2;--ink-2:#AAB7BF;--ink-3:#7C8A93;--accent:#5CB6BA;--accent-soft:#12312F;--good:#57B383;--warn:#D2A046;--crit:#E4736A;--good-soft:#15291F;--warn-soft:#2A2114;--crit-soft:#2C1917;--hatch:#59666E;--shadow:0 1px 2px rgba(0,0,0,.4)}
*{box-sizing:border-box}body{background:var(--bg);color:var(--ink);font-family:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;font-size:15px;line-height:1.5;margin:0;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:34px 26px 80px}h1,h2,h3{text-wrap:balance;margin:0}.mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace}
.head{border-bottom:2px solid var(--ink);padding-bottom:20px;margin-bottom:8px}.eyebrow{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:600}
h1{font-size:clamp(28px,4.4vw,44px);line-height:1.06;letter-spacing:-.02em;margin:10px 0 12px}.lede{font-size:16.5px;color:var(--ink-2)}.lede strong{color:var(--ink)}
.stamp{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:16px;font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink-3)}.stamp b{color:var(--ink-2);font-weight:500}
.banda{margin-top:18px;background:var(--crit-soft);border:1px solid var(--crit);color:var(--ink);padding:12px 14px;font-weight:600;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.q{margin-top:44px}.q-head{display:flex;align-items:baseline;gap:14px;border-bottom:1px solid var(--line-strong);padding-bottom:9px;flex-wrap:wrap}
.q-n{font-family:"IBM Plex Mono",monospace;font-size:12px;font-weight:600;color:var(--surface);background:var(--ink);padding:3px 8px;letter-spacing:.06em}.q h2{font-size:clamp(19px,2.4vw,25px);letter-spacing:-.015em;flex:1}
.q-note{font-size:14.5px;color:var(--ink-2);margin:12px 0 18px}.q-note strong{color:var(--ink)}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(232px,1fr))}.grid.g2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.tile{background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);padding:15px 16px 14px;display:flex;flex-direction:column;gap:2px;border-left:3px solid var(--line-strong)}
.tile.ok{border-left-color:var(--good)}.tile.warn{border-left-color:var(--warn)}.tile.bad{border-left-color:var(--crit)}.tile.decl{border-style:dashed}
.t-label{font-size:12.5px;color:var(--ink-2);line-height:1.35;min-height:2.7em}
.t-val{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;font-size:31px;font-weight:600;letter-spacing:-.02em;line-height:1.1;margin-top:6px}
.tile.bad .t-val{color:var(--crit)}.tile.ok .t-val{color:var(--good)}
.t-den{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums;margin-top:3px}
.t-foot{font-size:12px;color:var(--ink-2);margin-top:9px;padding-top:9px;border-top:1px solid var(--line);line-height:1.4}.t-foot b{color:var(--ink)}`;
/** Trama de «no medido» y chips: va después de lo propio de cada página, como en el original. */
const CSS_CHIPS = `.tile.blind{border:1px dashed var(--line-strong);border-left:3px dashed var(--hatch);background-image:repeating-linear-gradient(135deg,transparent 0 7px,color-mix(in srgb,var(--hatch) 22%,transparent) 7px 8px);background-color:var(--surface-2);box-shadow:none}
.tile.blind .t-val{color:var(--ink-3);font-size:22px;font-weight:500;letter-spacing:0}
.chip{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;font-weight:600;padding:2px 7px;border:1px solid}
.chip.ok{color:var(--good);border-color:var(--good);background:var(--good-soft)}.chip.warn{color:var(--warn);border-color:var(--warn);background:var(--warn-soft)}.chip.bad{color:var(--crit);border-color:var(--crit);background:var(--crit-soft)}
.chip.blind{color:var(--ink-3);border-color:var(--line-strong);border-style:dashed;background:transparent}.chip.decl{color:var(--ink-2);border-color:var(--ink-2);border-style:dashed;background:transparent}.chip.neutro{color:var(--ink-2);border-color:var(--line-strong)}.chip .g{font-size:11px;line-height:1}`;

/**
 * Los denominadores fijos que escribe el tablero, por código: el sitio manda el código y lo traduce (`den.<código>`).
 * Uno que no está acá (los que llevan un número adentro) no viaja al sitio.
 */
const DENOMINADORES = Object.freeze({
  casos: 'casos', suites: 'suites', repos: 'repos', productosVigilados: 'productos vigilados', storiesCerradas: 'stories cerradas',
  stories: 'stories', registros: 'registros', ejecucionesDeLaSuite: 'ejecuciones de la suite', reglasDistintas: 'reglas distintas',
  respuestas: 'respuestas', turnos: 'turnos', evaluacionesRegistradas: 'evaluaciones registradas', escapes: 'escapes',
  vecesQueFreno: 'veces que un freno frenó', decisionesSobreEvidencia: 'decisiones sobre una evidencia',
  commitsDesdeSesion: 'commits hechos desde una sesión', ejecucionesDeTestGate: 'ejecuciones de test-gate',
  chequeosConPuntaje: 'chequeos con puntaje', cierresConGuia: 'cierres que necesitaban guía (registro completo)',
  maquinasQueDeclararon: 'máquinas que lo declararon', ejecuciones: 'ejecuciones', reglasDelCatalogo: 'reglas del catálogo',
  reglasConRevisor: 'reglas con revisor', productosMedidos: 'productos medidos', storiesEmpezadas: 'stories empezadas con dato',
  entradasDeCodigo: 'entradas de código', reposConCierres: 'repos con cierres', productosDeclarados: 'productos declarados',
});

module.exports = { medida, noMedida, ratio, mediana, pct, num1, edadDias, edadTexto, esc, GLIFO, juzgar, umbralValido, motivoUmbral, chip, ficha, CSS_BASE, CSS_CHIPS, DENOMINADORES };
