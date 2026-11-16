'use strict';
/*
 * tabs/workdays.js — LA PESTAÑA «HORAS Y TOKENS» DEL SITIO DE LA ORGANIZACIÓN, SÓLO PARA QUIEN MANTIENE.
 *
 * Una tabla de los últimos 30 días por máquina con las horas que trabajaron sus sesiones de agente y los tokens que
 * consumieron. Los días los arma cada máquina (scripts/metrics/workday-upload.js), los sube a
 * `<maquina>/jornadas/v<versión>/<día>.json` y el sitio los baja a su espejo (`jornadas: true`, sources.js). El día es el
 * de cada máquina: la tabla muestra la fecha que trae el archivo, sin pasarla a ninguna zona.
 *
 * Dos horas por celda: «con el arnés trabajando» (el tiempo con al menos una sesión trabajando) y «de sesión» (la suma de
 * todas). La fila de total las suma por separado entre máquinas. 🔴 «NO MEDIDO» NUNCA ES CERO: una máquina sin archivo de
 * un día dice «no medido»; un archivo con otra forma, «no medido (no se entendió el archivo)»; una parte sin medir,
 * «horas/tokens no medidos» con el motivo al pasar el mouse.
 *
 * Rutas (`maintainer`): GET /horas · GET /api/horas. Casos: scripts/tests/site-workdays.test.js.
 */
const fs = require('fs');
const path = require('path');
const TX = require('../texts.js');
const views = require('../views.js');

const DIAS = 30;
const MAQUINA = /^[a-z0-9][a-z0-9._-]*$/;
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const ARCHIVO = /^(\d{4}-\d{2}-\d{2})\.json$/;
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const entero = (n) => Number.isInteger(n) && n >= 0;
const texto = (s) => typeof s === 'string' && s.trim().length > 0;

/** Una parte del día (`horas` o `tokens`) con la forma esperada, o null. */
function parte(o, campos) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.medido === false) return texto(o.motivo) ? { medido: false, motivo: o.motivo } : null;
  if (o.medido !== true || !campos.every((k) => entero(o[k]))) return null;
  return Object.fromEntries([...campos.map((k) => [k, o[k]]), ['medido', true]]);
}

/** El día leído, validado: `{ ok: true, horas, tokens }` o `{ ok: false }` (otra versión, un campo que falta, un negativo). */
function validarDia(o, dia) {
  if (!o || typeof o !== 'object' || o.v !== 1 || o.dia !== dia || !texto(o.tz)) return { ok: false };
  const horas = parte(o.horas, ['arnes_segundos', 'sesion_segundos', 'sesiones']);
  const tokens = parte(o.tokens, ['lectura', 'escritura', 'cache']);
  if (!horas || !tokens) return { ok: false };
  if (horas.medido && horas.arnes_segundos > horas.sesion_segundos) return { ok: false };
  return { ok: true, horas, tokens };
}

/** Los días de horas y tokens a partir de su texto: `{ <máquina>: { <día>: texto } }` → `{ maquinas: { <máquina>: { <día>: validado } } }`. */
function jornadasDe(crudo) {
  const maquinas = {};
  for (const [maq, dias] of Object.entries(crudo || {})) {
    if (!MAQUINA.test(maq)) continue;
    maquinas[maq] = {};
    for (const [dia, t] of Object.entries(dias || {})) {
      if (!DIA.test(dia)) continue;
      let o = null;
      try { o = typeof t === 'string' ? JSON.parse(t) : t; } catch { o = null; }
      maquinas[maq][dia] = validarDia(o, dia);
    }
  }
  return { maquinas };
}

/** Los días del espejo del buzón: `<espejo>/<máquina>/jornadas/<día>.json`. Lo que no se puede leer, como «no se entendió». */
function leerJornadas(dirBuzon) {
  const crudo = {};
  let maquinas = [];
  try { maquinas = fs.readdirSync(dirBuzon, { withFileTypes: true }).filter((e) => e.isDirectory() && MAQUINA.test(e.name)).map((e) => e.name); } catch { return { maquinas: {} }; }
  for (const maq of maquinas) {
    let nombres = [];
    try { nombres = fs.readdirSync(path.join(dirBuzon, maq, 'jornadas')); } catch { continue; }
    crudo[maq] = {};
    for (const n of nombres) {
      const m = ARCHIVO.exec(n);
      if (!m) continue;
      try { crudo[maq][m[1]] = fs.readFileSync(path.join(dirBuzon, maq, 'jornadas', n), 'utf8'); } catch { crudo[maq][m[1]] = null; }
    }
  }
  return jornadasDe(crudo);
}

const diaMas = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * La tabla: los 30 días que terminan en el más nuevo entre los archivos y `ayer` (del más nuevo al más viejo), las
 * máquinas, cada celda y el total de cada día. Celda: `{ estado: 'no_medido' | 'raro' | 'medido', horas, tokens,
 * horasMotivo, tokensMotivo }`. El total suma lo medido de cada máquina, cada hora por separado, y cuenta las no medidas.
 */
function armarTabla({ maquinas }, { ayer }) {
  const nombres = Object.keys(maquinas).sort();
  let nuevo = ayer;
  for (const m of nombres) for (const d of Object.keys(maquinas[m])) if (d > nuevo) nuevo = d;
  const dias = Array.from({ length: DIAS }, (_, i) => diaMas(nuevo, -i));
  const celdas = {};
  const totales = {};
  for (const d of dias) {
    celdas[d] = {};
    const t = { arnes_segundos: 0, sesion_segundos: 0, lectura: 0, escritura: 0, cache: 0, no_medidas: 0 };
    for (const m of nombres) {
      const v = maquinas[m][d];
      let c;
      if (!v) c = { estado: 'no_medido' };
      else if (!v.ok) c = { estado: 'raro' };
      else {
        c = { estado: 'medido', horas: v.horas.medido ? v.horas : null, horasMotivo: v.horas.medido ? null : v.horas.motivo, tokens: v.tokens.medido ? v.tokens : null, tokensMotivo: v.tokens.medido ? null : v.tokens.motivo };
        if (c.horas) { t.arnes_segundos += c.horas.arnes_segundos; t.sesion_segundos += c.horas.sesion_segundos; }
        if (c.tokens) { t.lectura += c.tokens.lectura; t.escritura += c.tokens.escritura; t.cache += c.tokens.cache; }
      }
      // una celda medida a medias tampoco entra entera en el total: se cuenta como sin medir
      if (c.estado !== 'medido' || !c.horas || !c.tokens) t.no_medidas += 1;
      celdas[d][m] = c;
    }
    totales[d] = t;
  }
  return { dias, maquinas: nombres, celdas, totales };
}

const horasDe = (s) => `${(s / 3600).toFixed(1)} h`;
function abreviar(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return n < 1e4 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
  return n < 1e7 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e6)}M`;
}

/** Las líneas de una celda (o del total): las dos horas con su nombre y los tokens. */
function lineas(idioma, { horas, tokens, horasMotivo, tokensMotivo }) {
  const t = (k, v) => TX.t(idioma, k, v);
  const out = [];
  if (horas) out.push(`<div>${esc(t('horas.arnes'))}: ${horasDe(horas.arnes_segundos)}</div>`, `<div>${esc(t('horas.sesion'))}: ${horasDe(horas.sesion_segundos)}</div>`);
  else out.push(`<div><span title="${esc(horasMotivo || '')}">${esc(t('horas.horasNoMedidas'))}</span></div>`);
  if (tokens) out.push(`<div>${esc(t('horas.tokens'))}: ${abreviar(tokens.lectura)} · ${abreviar(tokens.escritura)} · ${abreviar(tokens.cache)}</div>`);
  else out.push(`<div><span title="${esc(tokensMotivo || '')}">${esc(t('horas.tokensNoMedidos'))}</span></div>`);
  return out.join('');
}

/** La tabla en HTML, en el idioma del pedido. */
function htmlTabla(tabla, idioma) {
  const t = (k, v) => TX.t(idioma, k, v);
  if (!tabla.maquinas.length) return `<p>${esc(t('horas.sinMaquinas'))}</p>`;
  const cab = `<tr><th>${esc(t('horas.dia'))}</th>${tabla.maquinas.map((m) => `<th>${esc(m)}</th>`).join('')}<th>${esc(t('horas.total'))}</th></tr>`;
  const filas = tabla.dias.map((d) => {
    const celdas = tabla.maquinas.map((m) => {
      const c = tabla.celdas[d][m];
      if (c.estado === 'no_medido') return `<td class="no-medido">${esc(t('horas.noMedido'))}</td>`;
      if (c.estado === 'raro') return `<td class="no-medido">${esc(t('horas.raro'))}</td>`;
      return `<td>${lineas(idioma, c)}</td>`;
    }).join('');
    const tot = tabla.totales[d];
    const sinMedir = tot.no_medidas ? `<div>${esc(tot.no_medidas === 1 ? t('horas.sinMedir1') : t('horas.sinMedirN', { n: tot.no_medidas }))}</div>` : '';
    // sin ninguna máquina medida, el total no es cero: es «no medido»
    const ninguna = tabla.maquinas.every((m) => tabla.celdas[d][m].estado !== 'medido');
    const total = ninguna ? `<div>${esc(t('horas.noMedido'))}</div>${sinMedir}`
      : lineas(idioma, { horas: { arnes_segundos: tot.arnes_segundos, sesion_segundos: tot.sesion_segundos }, tokens: tot }) + sinMedir;
    return `<tr><th scope="row">${esc(d)}</th>${celdas}<td class="total">${total}</td></tr>`;
  }).join('');
  return `<table class="horas"><thead>${cab}</thead><tbody>${filas}</tbody></table>`;
}

function crearRutas({ fuentes, log = () => {}, ahora = Date.now } = {}) {
  const solo = ['maintainer'];
  const tabla = () => {
    let jornadas = { maquinas: {} };
    try { jornadas = typeof fuentes.jornadas === 'function' ? fuentes.jornadas() : jornadas; } catch (e) { log(`horas y tokens: no se pudieron leer los días (${e.code || e.message})`); }
    return armarTabla(jornadas, { ayer: diaMas(new Date(ahora()).toISOString().slice(0, 10), -1) });
  };
  return [
    {
      method: 'GET', path: '/horas', needs: solo, pestana: { id: 'horas', titulo: 'Horas y tokens', orden: 50 },
      handler: (ctx) => {
        const idioma = views.idiomaDe(ctx);
        const cuerpo = `<p class="lede">${esc(TX.t(idioma, 'horas.lede'))}</p>${htmlTabla(tabla(), idioma)}`;
        return { status: 200, tipo: 'text/html; charset=utf-8', cuerpo: views.layout(ctx, TX.t(idioma, 'pestana.horas'), cuerpo) };
      },
    },
    { method: 'GET', path: '/api/horas', needs: solo, handler: () => ({ status: 200, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(tabla()) }) },
  ];
}

module.exports = { crearRutas, leerJornadas, jornadasDe, validarDia, armarTabla, htmlTabla, abreviar };
