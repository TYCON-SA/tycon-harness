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
// un día de verdad: la forma y una fecha que existe (un 2026-13-45 tiene la forma y no es un día)
const esDia = (d) => {
  if (!DIA.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};
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
      if (!esDia(dia)) continue;
      let o = null;
      try { o = typeof t === 'string' ? JSON.parse(t) : t; } catch { o = null; }
      maquinas[maq][dia] = validarDia(o, dia);
    }
  }
  return { maquinas };
}

/**
 * Los días del espejo del buzón: `<espejo>/<máquina>/jornadas/<día>.json`. Un archivo que no se puede leer, como «no se
 * entendió»; la carpeta de una máquina que no se puede leer va en `ilegibles` (`{ <máquina>: código }`, sin rutas) y
 * sigue en la tabla; el espejo entero que no se puede leer va en `problema`. Que no exista no es un problema: todavía no
 * llegó nada.
 */
function leerJornadas(dirBuzon) {
  const crudo = {};
  const ilegibles = {};
  let maquinas = [];
  try { maquinas = fs.readdirSync(dirBuzon, { withFileTypes: true }).filter((e) => e.isDirectory() && MAQUINA.test(e.name)).map((e) => e.name); } catch (e) {
    return e.code === 'ENOENT' ? { maquinas: {}, ilegibles } : { maquinas: {}, ilegibles, problema: e.code || 'error' };
  }
  for (const maq of maquinas) {
    let nombres = [];
    try { nombres = fs.readdirSync(path.join(dirBuzon, maq, 'jornadas')); } catch (e) { if (e.code !== 'ENOENT') ilegibles[maq] = e.code || 'error'; continue; }
    crudo[maq] = {};
    for (const n of nombres) {
      const m = ARCHIVO.exec(n);
      if (!m) continue;
      try { crudo[maq][m[1]] = fs.readFileSync(path.join(dirBuzon, maq, 'jornadas', n), 'utf8'); } catch { crudo[maq][m[1]] = null; }
    }
  }
  return { ...jornadasDe(crudo), ilegibles };
}

const diaMas = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * La tabla: los 30 días que terminan en el más nuevo entre los archivos y `ayer` (del más nuevo al más viejo), las
 * máquinas, cada celda y el total de cada día. Celda: `{ estado: 'no_medido' | 'raro' | 'medido', horas, tokens,
 * horasMotivo, tokensMotivo }`. El total suma lo medido de cada máquina, cada hora por separado, y cuenta las no medidas.
 */
function armarTabla({ maquinas, ilegibles = {}, problema = null }, { ayer }) {
  // una máquina cuya carpeta no se pudo leer sigue en la tabla, con sus celdas «no se pudo leer»
  const nombres = [...new Set([...Object.keys(maquinas), ...Object.keys(ilegibles)])].sort();
  // la tabla termina en el día más nuevo que se entendió: un archivo raro no corre la ventana
  let nuevo = ayer;
  for (const m of Object.keys(maquinas)) for (const [d, v] of Object.entries(maquinas[m])) if (v && v.ok && esDia(d) && d > nuevo) nuevo = d;
  const dias = Array.from({ length: DIAS }, (_, i) => diaMas(nuevo, -i));
  const celdas = {};
  const totales = {};
  for (const d of dias) {
    celdas[d] = {};
    const t = { arnes_segundos: 0, sesion_segundos: 0, lectura: 0, escritura: 0, cache: 0, no_medidas: 0, con_horas: 0, con_tokens: 0 };
    for (const m of nombres) {
      const v = maquinas[m] ? maquinas[m][d] : null;
      let c;
      if (ilegibles[m]) c = { estado: 'ilegible', motivo: ilegibles[m] };
      else if (!v) c = { estado: 'no_medido' };
      else if (!v.ok) c = { estado: 'raro' };
      else {
        c = { estado: 'medido', horas: v.horas.medido ? v.horas : null, horasMotivo: v.horas.medido ? null : v.horas.motivo, tokens: v.tokens.medido ? v.tokens : null, tokensMotivo: v.tokens.medido ? null : v.tokens.motivo };
        if (c.horas) { t.arnes_segundos += c.horas.arnes_segundos; t.sesion_segundos += c.horas.sesion_segundos; t.con_horas += 1; }
        if (c.tokens) { t.lectura += c.tokens.lectura; t.escritura += c.tokens.escritura; t.cache += c.tokens.cache; t.con_tokens += 1; }
      }
      // una celda medida a medias tampoco entra entera en el total: se cuenta como sin medir
      if (c.estado !== 'medido' || !c.horas || !c.tokens) t.no_medidas += 1;
      celdas[d][m] = c;
    }
    totales[d] = t;
  }
  return { dias, maquinas: nombres, celdas, totales, problema };
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
      if (c.estado === 'ilegible') return `<td class="no-medido"><span title="${esc(c.motivo)}">${esc(t('horas.ilegible'))}</span></td>`;
      return `<td>${lineas(idioma, c)}</td>`;
    }).join('');
    const tot = tabla.totales[d];
    const sinMedir = tot.no_medidas ? `<div>${esc(tot.no_medidas === 1 ? t('horas.sinMedir1') : t('horas.sinMedirN', { n: tot.no_medidas }))}</div>` : '';
    // sin ninguna máquina medida, el total no es cero: es «no medido»; y lo mismo por separado para las horas y los
    // tokens: sin ninguna máquina con horas medidas, el total de horas dice «no medidas», no 0.0 h
    const ninguna = !tot.con_horas && !tot.con_tokens;
    const total = ninguna ? `<div>${esc(t('horas.noMedido'))}</div>${sinMedir}`
      : lineas(idioma, { horas: tot.con_horas ? { arnes_segundos: tot.arnes_segundos, sesion_segundos: tot.sesion_segundos } : null, tokens: tot.con_tokens ? tot : null }) + sinMedir;
    return `<tr><th scope="row">${esc(d)}</th>${celdas}<td class="total">${total}</td></tr>`;
  }).join('');
  return `<table class="horas"><thead>${cab}</thead><tbody>${filas}</tbody></table>`;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * El resumen de la semana para quien decide: la semana son los 7 días más nuevos de la tabla y la anterior, los 7 de
 * antes. Junta las máquinas de cada persona (`people.machines`: la máquina → `person`); una máquina sin persona sale con
 * su nombre. No salen las ocultas (`people.hidden_machines`) ni las que no trajeron horas medidas en ningún día de la
 * tabla (nombres viejos, máquinas de CI): `fuera` dice cuántas. 🔴 «NO MEDIDO» NUNCA ES CERO: una persona sin días
 * medidos tiene `segundos`, `promedioDia` y `tokens` en null; un día cuenta como medido si alguna de sus máquinas trae
 * horas medidas ese día, y el promedio es por día medido.
 *   → { semana: { dias, promedioDia, tokens, sinMedir }, anterior: { dias, promedioDia, tokens }, personas: [{ persona,
 *       maquinas, segundos, diasMedidos, promedioDia, tokens }], fuera }
 */
function resumen(tabla, people) {
  const p = isObj(people) ? people : {};
  const duenos = isObj(p.machines) ? p.machines : {};
  const ocultas = isObj(p.hidden_machines) ? p.hidden_machines : {};
  const conHoras = (m) => tabla.dias.some((d) => { const c = tabla.celdas[d][m]; return c && c.estado === 'medido' && c.horas; });
  const visibles = tabla.maquinas.filter((m) => !Object.prototype.hasOwnProperty.call(ocultas, m) && conHoras(m));
  const personaDe = (m) => (isObj(duenos[m]) && texto(duenos[m].person) ? duenos[m].person : m);
  const grupos = new Map();
  for (const m of visibles) { const k = personaDe(m); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(m); }
  const medir = (maqs, dias) => {
    let segundos = 0; let dm = 0; let tokens = 0; let conTokens = false;
    for (const d of dias) {
      let medido = false;
      for (const m of maqs) {
        const c = tabla.celdas[d][m];
        if (!c || c.estado !== 'medido') continue;
        if (c.horas) { segundos += c.horas.arnes_segundos; medido = true; }
        if (c.tokens) { tokens += c.tokens.lectura + c.tokens.escritura; conTokens = true; }
      }
      if (medido) dm += 1;
    }
    return { segundos: dm ? segundos : null, diasMedidos: dm, promedioDia: dm ? segundos / dm : null, tokens: conTokens ? tokens : null };
  };
  const semana = tabla.dias.slice(0, 7);
  const anterior = tabla.dias.slice(7, 14);
  const personas = [...grupos.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([persona, maqs]) => ({ persona, maquinas: maqs.slice().sort(), ...medir(maqs, semana) }));
  const equipo = (dias) => {
    const filas = [...grupos.values()].map((maqs) => medir(maqs, dias));
    const dm = filas.reduce((a, f) => a + f.diasMedidos, 0);
    const seg = filas.reduce((a, f) => a + (f.segundos || 0), 0);
    const tok = filas.filter((f) => f.tokens !== null);
    return { dias, promedioDia: dm ? seg / dm : null, tokens: tok.length ? tok.reduce((a, f) => a + f.tokens, 0) : null };
  };
  let sinMedir = 0;
  for (const m of visibles) for (const d of semana) { const c = tabla.celdas[d][m]; if (!(c && c.estado === 'medido' && c.horas)) sinMedir += 1; }
  return { semana: { ...equipo(semana), sinMedir }, anterior: equipo(anterior), personas, fuera: tabla.maquinas.length - visibles.length };
}

/** El resumen en HTML: cuatro fichas (la del costo dice «sin dato de modelo») y la tabla por persona. */
function htmlResumen(r, idioma) {
  const t = (k, v) => TX.t(idioma, k, v);
  const nm = esc(t('horas.noMedido'));
  const h = (s) => (s === null ? nm : horasDe(s));
  const tk = (n) => (n === null ? nm : abreviar(n));
  const ant = (v) => `<div class="ficha-ant">${esc(t('horas.anterior', { valor: v }))}</div>`;
  const ficha = (titulo, valor, extra = '') => `<div class="ficha"><div class="ficha-titulo">${esc(titulo)}</div><div class="ficha-valor">${valor}</div>${extra}</div>`;
  const dias = r.semana.dias;
  const titulo = dias.length ? `<h2>${esc(t('horas.semanaTitulo', { desde: dias[dias.length - 1], hasta: dias[0] }))}</h2>` : '';
  const fichas = `<div class="fichas">${ficha(t('horas.fichaHoras'), h(r.semana.promedioDia), ant(r.anterior.promedioDia === null ? t('horas.noMedido') : horasDe(r.anterior.promedioDia)))}`
    + `${ficha(t('horas.fichaTokens'), tk(r.semana.tokens), ant(r.anterior.tokens === null ? t('horas.noMedido') : abreviar(r.anterior.tokens)))}`
    + `${ficha(t('horas.fichaSinMedir'), String(r.semana.sinMedir))}${ficha(t('horas.fichaCosto'), esc(t('horas.sinModelo')))}</div>`;
  const filas = r.personas.map((f) => `<tr><th scope="row">${esc(f.persona)}${f.maquinas.length > 1 || f.maquinas[0] !== f.persona ? `<div class="maquinas">${esc(t('horas.maquinasDe', { lista: f.maquinas.join(', ') }))}</div>` : ''}</th>`
    + `<td>${h(f.promedioDia)}</td><td>${h(f.segundos)}</td><td>${esc(t('horas.nDe7', { n: f.diasMedidos }))}</td><td>${tk(f.tokens)}</td></tr>`).join('');
  const tabla = r.personas.length ? `<h3>${esc(t('horas.porPersona'))}</h3><table class="personas"><thead><tr><th>${esc(t('horas.persona'))}</th><th>${esc(t('horas.promedioDia'))}</th><th>${esc(t('horas.totalSemana'))}</th><th>${esc(t('horas.diasMedidos'))}</th><th>${esc(t('horas.tokensSinCache'))}</th></tr></thead><tbody>${filas}</tbody></table>` : '';
  const fuera = r.fuera ? `<p class="nota">${esc(r.fuera === 1 ? t('horas.fuera1') : t('horas.fueraN', { n: r.fuera }))}</p>` : '';
  return `${titulo}${fichas}${tabla}${fuera}`;
}

function crearRutas({ fuentes, log = () => {}, ahora = Date.now } = {}) {
  const solo = ['maintainer'];
  const tabla = () => {
    let jornadas = { maquinas: {} };
    try { jornadas = typeof fuentes.jornadas === 'function' ? fuentes.jornadas() : jornadas; } catch (e) { log(`horas y tokens: no se pudieron leer los días (${e.code || e.message})`); }
    const t = armarTabla(jornadas, { ayer: diaMas(new Date(ahora()).toISOString().slice(0, 10), -1) });
    if (t.problema) log(`horas y tokens: el espejo del buzón no se pudo leer (${t.problema})`);
    for (const [m, codigo] of Object.entries(jornadas.ilegibles || {})) log(`horas y tokens: los días de ${m} no se pudieron leer (${codigo})`);
    return t;
  };
  return [
    {
      method: 'GET', path: '/horas', needs: solo, pestana: { id: 'horas', titulo: 'Horas y tokens', orden: 50 },
      handler: (ctx) => {
        const idioma = views.idiomaDe(ctx);
        const tab = tabla();
        // el espejo que no se pudo leer se dice arriba: la tabla vacía no es «no llegó nada»
        const aviso = tab.problema ? `<p>${esc(TX.t(idioma, 'horas.espejoIlegible', { motivo: tab.problema }))}</p>` : '';
        let people = null;
        try { const c = typeof fuentes.config === 'function' ? fuentes.config() : null; people = c && c.people; } catch (e) { log(`horas y tokens: no se pudo leer la configuración de personas (${e.code || e.message})`); }
        const diario = `<details class="dia-a-dia"><summary>${esc(TX.t(idioma, 'horas.diaPorDia'))}</summary>${htmlTabla(tab, idioma)}</details>`;
        const cuerpo = `<p class="lede">${esc(TX.t(idioma, 'horas.lede'))}</p>${aviso}${tab.maquinas.length ? htmlResumen(resumen(tab, people), idioma) : ''}${diario}`;
        return { status: 200, tipo: 'text/html; charset=utf-8', cuerpo: views.layout(ctx, TX.t(idioma, 'pestana.horas'), cuerpo) };
      },
    },
    { method: 'GET', path: '/api/horas', needs: solo, handler: () => ({ status: 200, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(tabla()) }) },
  ];
}

module.exports = { crearRutas, leerJornadas, jornadasDe, validarDia, armarTabla, htmlTabla, abreviar, resumen, htmlResumen };
