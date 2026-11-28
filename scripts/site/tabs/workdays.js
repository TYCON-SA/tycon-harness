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
 * El costo es una estimación: los tokens de cada modelo (`tokens.por_modelo`, desde la versión 2 del día) por los precios
 * de `site.prices` de operations.json, en dólares por millón. Un día de la versión 1 dice «sin dato de modelo» y un modelo
 * sin precio, «sin precio para <modelo>»: ninguno de los dos suma cero.
 *
 * Rutas (`maintainer`): GET /horas · GET /api/horas. Casos: scripts/tests/site-workdays.test.js.
 */
const fs = require('fs');
const path = require('path');
const TX = require('../texts.js');
const views = require('../views.js');

const DIAS = 30;
// la evolución: 6 semanas, así que la pestaña lee 42 días; la tabla de cada día sigue mostrando 30
const SEMANAS = 6;
const DIAS_EVOLUCION = SEMANAS * 7;
// los colores de las personas en el gráfico, en orden fijo (la paleta de referencia, validada en claro y oscuro); de la
// novena persona en adelante van juntas en «otras», en gris
const SERIES = 8;
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
const PARTES = ['lectura', 'escritura', 'cache'];
// la escritura de caché por plazo: parte de la lectura, con su propio precio (`site.prices.<modelo>.cache_escrita_*`)
const EXTRAS = ['cache_escrita_5m', 'cache_escrita_1h'];
// el nombre de un modelo como lo escriben las conversaciones; `sin_modelo` junta los tokens que llegaron sin él
const MODELO = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SIN_MODELO = 'sin_modelo';
const texto = (s) => typeof s === 'string' && s.trim().length > 0;

/** Una parte del día (`horas` o `tokens`) con la forma esperada, o null. */
function parte(o, campos) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.medido === false) return texto(o.motivo) ? { medido: false, motivo: o.motivo } : null;
  if (o.medido !== true || !campos.every((k) => entero(o[k]))) return null;
  return Object.fromEntries([...campos.map((k) => [k, o[k]]), ['medido', true]]);
}

/** El reparto por modelo de la versión 2: `{ <modelo>: { lectura, escritura, cache } }`, o undefined si está mal formado. */
function reparto(pm) {
  if (!pm || typeof pm !== 'object' || Array.isArray(pm)) return undefined;
  const out = {};
  for (const [m, v] of Object.entries(pm)) {
    if (!MODELO.test(m) || !v || typeof v !== 'object' || !PARTES.every((k) => entero(v[k]))) return undefined;
    if (!EXTRAS.every((k) => v[k] === undefined || entero(v[k]))) return undefined;
    out[m] = { lectura: v.lectura, escritura: v.escritura, cache: v.cache };
    for (const k of EXTRAS) if (v[k]) out[m][k] = v[k];
  }
  return out;
}

/**
 * El día leído, validado: `{ ok: true, horas, tokens }` o `{ ok: false }` (otra versión, un campo que falta, un negativo).
 * Los tokens medidos traen `porModelo`: el reparto de la versión 2, o null si el día no lo tiene (la versión 1, o uno
 * rearmado con los tokens de antes).
 */
function validarDia(o, dia) {
  if (!o || typeof o !== 'object' || (o.v !== 1 && o.v !== 2) || o.dia !== dia || !texto(o.tz)) return { ok: false };
  const horas = parte(o.horas, ['arnes_segundos', 'sesion_segundos', 'sesiones']);
  const tokens = parte(o.tokens, PARTES);
  if (!horas || !tokens) return { ok: false };
  if (tokens.medido) {
    tokens.porModelo = null;
    if (o.v === 2 && o.tokens.por_modelo !== undefined) {
      tokens.porModelo = reparto(o.tokens.por_modelo);
      if (!tokens.porModelo) return { ok: false };
      // un reparto que no suma los totales no vale como costo: el día se lee igual, «sin dato de modelo»
      // y la escritura de caché de un modelo no puede pasar de su lectura
      const escritaDeMas = Object.values(tokens.porModelo).some((m) => EXTRAS.reduce((a, k) => a + (m[k] || 0), 0) > m.lectura);
      if (escritaDeMas || PARTES.some((k) => Object.values(tokens.porModelo).reduce((a, m) => a + m[k], 0) !== tokens[k])) tokens.porModelo = null;
    }
  }
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
  // las que suben ejecuciones (tienen carpeta en el buzón) y ningún día de horas: una máquina con un arnés viejo
  const sinJornadas = [];
  let maquinas = [];
  try { maquinas = fs.readdirSync(dirBuzon, { withFileTypes: true }).filter((e) => e.isDirectory() && MAQUINA.test(e.name)).map((e) => e.name); } catch (e) {
    return e.code === 'ENOENT' ? { maquinas: {}, ilegibles } : { maquinas: {}, ilegibles, problema: e.code || 'error' };
  }
  for (const maq of maquinas) {
    let nombres = [];
    try { nombres = fs.readdirSync(path.join(dirBuzon, maq, 'jornadas')); } catch (e) { if (e.code !== 'ENOENT') ilegibles[maq] = e.code || 'error'; else sinJornadas.push(maq); continue; }
    crudo[maq] = {};
    for (const n of nombres) {
      const m = ARCHIVO.exec(n);
      if (!m) continue;
      try { crudo[maq][m[1]] = fs.readFileSync(path.join(dirBuzon, maq, 'jornadas', n), 'utf8'); } catch { crudo[maq][m[1]] = null; }
    }
  }
  return { ...jornadasDe(crudo), ilegibles, sinJornadas };
}

const diaMas = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * La tabla: los 30 días que terminan en el más nuevo entre los archivos y `ayer` (del más nuevo al más viejo), las
 * máquinas, cada celda y el total de cada día. Celda: `{ estado: 'no_medido' | 'raro' | 'medido', horas, tokens,
 * horasMotivo, tokensMotivo }`. El total suma lo medido de cada máquina, cada hora por separado, y cuenta las no medidas.
 */
function armarTabla({ maquinas, ilegibles = {}, problema = null, sinJornadas = [] }, { ayer, dias: cuantos = DIAS }) {
  // una máquina cuya carpeta no se pudo leer sigue en la tabla, con sus celdas «no se pudo leer»
  const nombres = [...new Set([...Object.keys(maquinas), ...Object.keys(ilegibles)])].sort();
  // la tabla termina en el día más nuevo que se entendió: un archivo raro no corre la ventana
  let nuevo = ayer;
  for (const m of Object.keys(maquinas)) for (const [d, v] of Object.entries(maquinas[m])) if (v && v.ok && esDia(d) && d > nuevo) nuevo = d;
  const dias = Array.from({ length: cuantos }, (_, i) => diaMas(nuevo, -i));
  const celdas = {};
  const totales = {};
  for (const d of dias) {
    celdas[d] = {};
    const t = { arnes_segundos: 0, sesion_segundos: 0, lectura: 0, escritura: 0, cache: 0, no_medidas: 0, sin_tokens: 0, sin_horas: 0, con_horas: 0, con_tokens: 0 };
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
      // una máquina con horas y sin tokens (o al revés) no es «sin medir»: se cuenta aparte, por lo que le falta
      if (c.estado !== 'medido' || (!c.horas && !c.tokens)) t.no_medidas += 1;
      else if (!c.tokens) t.sin_tokens += 1;
      else if (!c.horas) t.sin_horas += 1;
      celdas[d][m] = c;
    }
    totales[d] = t;
  }
  return { dias, maquinas: nombres, celdas, totales, problema, sinJornadas: sinJornadas.slice().sort() };
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
  // el motivo va a la vista, no sólo al pasar el mouse
  else out.push(`<div>${esc(horasMotivo ? t('horas.noMedidasPorque', { que: t('horas.horasNoMedidas'), motivo: horasMotivo }) : t('horas.horasNoMedidas'))}</div>`);
  if (tokens) out.push(`<div>${esc(t('horas.tokens'))}: ${abreviar(tokens.lectura)} · ${abreviar(tokens.escritura)} · ${abreviar(tokens.cache)}</div>`);
  else out.push(`<div>${esc(tokensMotivo ? t('horas.noMedidasPorque', { que: t('horas.tokensNoMedidos'), motivo: tokensMotivo }) : t('horas.tokensNoMedidos'))}</div>`);
  return out.join('');
}

/** La tabla en HTML, en el idioma del pedido. */
function htmlTabla(tabla, idioma) {
  const t = (k, v) => TX.t(idioma, k, v);
  if (!tabla.maquinas.length) return `<p>${esc(t('horas.sinMaquinas'))}</p>`;
  const cab = `<tr><th>${esc(t('horas.dia'))}</th>${tabla.maquinas.map((m) => `<th>${esc(m)}</th>`).join('')}<th>${esc(t('horas.total'))}</th></tr>`;
  const filas = tabla.dias.slice(0, DIAS).map((d) => {
    const celdas = tabla.maquinas.map((m) => {
      const c = tabla.celdas[d][m];
      if (c.estado === 'no_medido') return `<td class="no-medido">${esc(t('horas.noMedido'))}</td>`;
      if (c.estado === 'raro') return `<td class="no-medido">${esc(t('horas.raro'))}</td>`;
      if (c.estado === 'ilegible') return `<td class="no-medido"><span title="${esc(c.motivo)}">${esc(t('horas.ilegible'))}</span></td>`;
      return `<td>${lineas(idioma, c)}</td>`;
    }).join('');
    const tot = tabla.totales[d];
    const sinMedir = (tot.no_medidas ? `<div>${esc(tot.no_medidas === 1 ? t('horas.sinMedir1') : t('horas.sinMedirN', { n: tot.no_medidas }))}</div>` : '')
      + (tot.sin_tokens ? `<div>${esc(tot.sin_tokens === 1 ? t('horas.sinTokens1') : t('horas.sinTokensN', { n: tot.sin_tokens }))}</div>` : '')
      + (tot.sin_horas ? `<div>${esc(tot.sin_horas === 1 ? t('horas.sinHoras1') : t('horas.sinHorasN', { n: tot.sin_horas }))}</div>` : '');
    // sin ninguna máquina medida, el total no es cero: es «no medido»; y lo mismo por separado para las horas y los
    // tokens: sin ninguna máquina con horas medidas, el total de horas dice «no medidas», no 0.0 h
    const ninguna = !tot.con_horas && !tot.con_tokens;
    const total = ninguna ? `<div>${esc(t('horas.noMedido'))}</div>${sinMedir}`
      : lineas(idioma, { horas: tot.con_horas ? { arnes_segundos: tot.arnes_segundos, sesion_segundos: tot.sesion_segundos } : null, tokens: tot.con_tokens ? tot : null }) + sinMedir;
    return `<tr><th scope="row">${esc(d)}</th>${celdas}<td class="total">${total}</td></tr>`;
  }).join('');
  return `<div class="desliza" tabindex="0"><table class="horas"><thead>${cab}</thead><tbody>${filas}</tbody></table></div>`;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// El costo estimado de un grupo de celdas: `usd` (null si ninguna tuvo costo), cuántos días de una persona con tokens no
// traen el reparto o traen tokens sin modelo (`sinModelo`; el de un equipo suma los de sus personas), y los modelos sin
// precio (`sinPrecio`). Un precio vale si trae sus tres
// números de cero en adelante; lo valida también el lector de operations.json.
const costoVacio = () => ({ usd: 0, conCosto: false, sinModelo: 0, sinPrecio: new Set(), sinPrecioCache: new Set() });
const numeroValido = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const precioValido = (p) => isObj(p) && PARTES.every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0);
function costeador(precios) {
  const tabla = isObj(precios) ? precios : {};
  return (tokens) => {
    const c = costoVacio();
    if (!tokens.porModelo) { c.sinModelo = 1; return c; }
    let sinModelo = false;
    // un día medido sin tokens cuesta cero de verdad: lo medido en cero no es «sin medir»
    if (!Object.keys(tokens.porModelo).length) c.conCosto = true;
    for (const [m, v] of Object.entries(tokens.porModelo)) {
      if (m === SIN_MODELO) { sinModelo = true; continue; }
      const p = Object.prototype.hasOwnProperty.call(tabla, m) ? tabla[m] : null;
      if (!precioValido(p)) { c.sinPrecio.add(m); continue; }
      // la escritura de caché sale de la lectura y se cobra con el precio de su plazo; sin ese precio no se cuenta (no
      // se cobra como entrada) y se dice
      const escrita = EXTRAS.reduce((a, k) => a + (v[k] || 0), 0);
      let usd = (v.lectura - escrita) * p.lectura + v.escritura * p.escritura + v.cache * p.cache;
      for (const k of EXTRAS) {
        if (!v[k]) continue;
        if (numeroValido(p[k])) usd += v[k] * p[k]; else c.sinPrecioCache.add(m);
      }
      c.usd += usd / 1e6;
      c.conCosto = true;
    }
    if (sinModelo) c.sinModelo = 1;
    return c;
  };
}
function sumarCosto(a, b) {
  if (b.conCosto) { a.usd += b.usd || 0; a.conCosto = true; }
  a.sinModelo += b.sinModelo;
  for (const m of b.sinPrecio) a.sinPrecio.add(m);
  for (const m of b.sinPrecioCache) a.sinPrecioCache.add(m);
}
const cerrarCosto = (c) => ({ usd: c.conCosto ? c.usd : null, conCosto: c.conCosto, sinModelo: c.sinModelo, sinPrecio: [...c.sinPrecio].sort(), sinPrecioCache: [...c.sinPrecioCache].sort() });

/** El costo en texto: «US$ 12.00 estimado» y lo que no se contó, o por qué no hay costo; nunca cero sin medir. */
function textoCosto(c, t) {
  const sinPrecio = c.sinPrecio.length ? t('horas.sinPrecio', { lista: c.sinPrecio.join(', ') }) : null;
  const sinModelo = c.sinModelo ? (c.sinModelo === 1 ? t('horas.sinModelo1') : t('horas.sinModeloN', { n: c.sinModelo })) : null;
  const sinPrecioCache = c.sinPrecioCache && c.sinPrecioCache.length ? t('horas.sinPrecioCache', { lista: c.sinPrecioCache.join(', ') }) : null;
  if (c.usd === null) {
    if (!sinPrecio && !sinModelo) return esc(t('horas.noMedido'));
    return esc([sinPrecio, sinModelo ? t('horas.sinModelo') : null].filter(Boolean).join(' · '));
  }
  const faltan = [sinModelo, sinPrecio, sinPrecioCache].filter(Boolean);
  return `${esc(t('horas.costoEstimado', { valor: c.usd.toFixed(2) }))}${faltan.length ? `<div class="nota">${esc(t('horas.costoParcial', { partes: faltan.join(' · ') }))}</div>` : ''}`;
}

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
function resumen(tabla, people, precios = null) {
  const p = isObj(people) ? people : {};
  const costoDe = costeador(precios);
  const duenos = isObj(p.machines) ? p.machines : {};
  const ocultas = isObj(p.hidden_machines) ? p.hidden_machines : {};
  const conHoras = (m) => tabla.dias.some((d) => { const c = tabla.celdas[d][m]; return c && c.estado === 'medido' && c.horas; });
  const visibles = tabla.maquinas.filter((m) => !Object.prototype.hasOwnProperty.call(ocultas, m) && conHoras(m));
  const personaDe = (m) => (isObj(duenos[m]) && texto(duenos[m].person) ? duenos[m].person : m);
  const grupos = new Map();
  for (const m of visibles) { const k = personaDe(m); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(m); }
  const medir = (maqs, dias) => {
    let segundos = 0; let dm = 0; let tokens = 0; let conTokens = false;
    const costo = costoVacio();
    for (const d of dias) {
      let medido = false;
      // el costo del día de la persona: «sin dato de modelo» cuenta días, aunque falte en dos de sus máquinas
      const delDia = costoVacio();
      for (const m of maqs) {
        const c = tabla.celdas[d][m];
        if (!c || c.estado !== 'medido') continue;
        if (c.horas) { segundos += c.horas.arnes_segundos; medido = true; }
        if (c.tokens) { tokens += c.tokens.lectura + c.tokens.escritura; conTokens = true; sumarCosto(delDia, costoDe(c.tokens)); }
      }
      delDia.sinModelo = Math.min(1, delDia.sinModelo);
      sumarCosto(costo, delDia);
      if (medido) dm += 1;
    }
    return { segundos: dm ? segundos : null, diasMedidos: dm, promedioDia: dm ? segundos / dm : null, tokens: conTokens ? tokens : null, costo: cerrarCosto(costo) };
  };
  const semana = tabla.dias.slice(0, 7);
  const anterior = tabla.dias.slice(7, 14);
  // una máquina sin persona asignada va con su nombre, y lo dice: no es una persona (una persona con dos máquinas sin
  // asignar saldría como dos)
  const sinDueno = (k) => !visibles.some((m) => personaDe(m) === k && m !== k);
  const personas = [...grupos.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([persona, maqs]) => ({ persona, sinPersona: sinDueno(persona) && !(isObj(duenos[persona]) && texto(duenos[persona].person)), maquinas: maqs.slice().sort(), ...medir(maqs, semana) }));
  const equipo = (dias) => {
    const filas = [...grupos.values()].map((maqs) => medir(maqs, dias));
    const dm = filas.reduce((a, f) => a + f.diasMedidos, 0);
    const seg = filas.reduce((a, f) => a + (f.segundos || 0), 0);
    const tok = filas.filter((f) => f.tokens !== null);
    const costo = costoVacio();
    for (const f of filas) sumarCosto(costo, f.costo);
    return { dias, promedioDia: dm ? seg / dm : null, tokens: tok.length ? tok.reduce((a, f) => a + f.tokens, 0) : null, costo: cerrarCosto(costo) };
  };
  let sinMedir = 0;
  // los días con horas y sin tokens: los tokens de la semana los dejan afuera, y la ficha lo dice
  let tokensSinMedir = 0;
  for (const m of visibles) for (const d of semana) {
    const c = tabla.celdas[d][m];
    if (!(c && c.estado === 'medido' && c.horas)) sinMedir += 1;
    else if (!c.tokens) tokensSinMedir += 1;
  }
  // hasta 6 semanas enteras, de la más nueva a la más vieja; una persona sin días medidos en una semana va en null
  const semanas = [];
  for (let i = 0; i < SEMANAS && (i + 1) * 7 <= tabla.dias.length; i++) {
    const ds = tabla.dias.slice(i * 7, i * 7 + 7);
    const porPersona = {};
    let tokens = 0; let conTokens = false; let medida = false;
    for (const [persona, maqs] of grupos) {
      const f = medir(maqs, ds);
      porPersona[persona] = f.segundos;
      if (f.segundos !== null) medida = true;
      if (f.tokens !== null) { tokens += f.tokens; conTokens = true; }
    }
    semanas.push({ desde: ds[6], hasta: ds[0], porPersona, tokens: conTokens ? tokens : null, medida });
  }
  const sinHoras = (tabla.sinJornadas || []).filter((m) => !Object.prototype.hasOwnProperty.call(ocultas, m));
  return { semana: { ...equipo(semana), sinMedir, tokensSinMedir }, anterior: equipo(anterior), personas, fuera: tabla.maquinas.length - visibles.length, semanas, sinHoras };
}

/** El resumen en HTML: cuatro fichas (la del costo, estimado) y la tabla por persona, con su costo estimado. */
/** El nombre de una fila de «Por persona»: una máquina sin persona asignada lo dice. */
const nombreDeFila = (p, t) => (p.sinPersona ? t('horas.maquinaSinPersona', { maquina: p.persona }) : p.persona);

function htmlResumen(r, idioma) {
  const t = (k, v) => TX.t(idioma, k, v);
  const nm = esc(t('horas.noMedido'));
  const h = (s) => (s === null ? nm : horasDe(s));
  const tk = (n) => (n === null ? nm : abreviar(n));
  const ant = (v, ahora, antes) => {
    // la flecha sólo cuando las dos semanas se midieron: contra una sin medir no hay comparación
    const flecha = ahora === null || antes === null || antes === undefined ? '' : ahora > antes ? ' ↑' : ahora < antes ? ' ↓' : ' =';
    return `<div class="ficha-ant">${esc(t('horas.anterior', { valor: v }))}${flecha}</div>`;
  };
  const ficha = (titulo, valor, extra = '') => `<div class="ficha"><div class="ficha-titulo">${esc(titulo)}</div><div class="ficha-valor">${valor}</div>${extra}</div>`;
  const dias = r.semana.dias;
  const titulo = dias.length ? `<h2>${esc(t('horas.semanaTitulo', { desde: dias[dias.length - 1], hasta: dias[0] }))}</h2>` : '';
  const fichas = `<div class="fichas">${ficha(t('horas.fichaHoras'), h(r.semana.promedioDia), ant(r.anterior.promedioDia === null ? t('horas.noMedido') : horasDe(r.anterior.promedioDia), r.semana.promedioDia, r.anterior.promedioDia))}`
    + `${ficha(t('horas.fichaTokens'), tk(r.semana.tokens), ant(r.anterior.tokens === null ? t('horas.noMedido') : abreviar(r.anterior.tokens), r.semana.tokens, r.anterior.tokens)
      + (r.semana.tokensSinMedir ? `<div class="ficha-ant">${esc(r.semana.tokensSinMedir === 1 ? t('horas.tokensFaltan1') : t('horas.tokensFaltanN', { n: r.semana.tokensSinMedir }))}</div>` : ''))}`
    + `${ficha(t('horas.fichaSinMedir'), String(r.semana.sinMedir))}${ficha(t('horas.fichaCosto'), textoCosto(r.semana.costo, t))}</div>`;
  const filas = r.personas.map((f) => `<tr><th scope="row">${esc(nombreDeFila(f, t))}${f.maquinas.length > 1 || f.maquinas[0] !== f.persona ? `<div class="maquinas">${esc(t('horas.maquinasDe', { lista: f.maquinas.join(', ') }))}</div>` : ''}</th>`
    + `<td>${h(f.promedioDia)}</td><td>${h(f.segundos)}</td><td>${esc(t('horas.nDe7', { n: f.diasMedidos }))}</td><td>${tk(f.tokens)}</td><td>${textoCosto(f.costo, t)}</td></tr>`).join('');
  const tabla = r.personas.length ? `<h3>${esc(t('horas.porPersona'))}</h3><div class="desliza" tabindex="0"><table class="horas-personas"><thead><tr><th>${esc(t('horas.persona'))}</th><th>${esc(t('horas.promedioDia'))}</th><th>${esc(t('horas.totalSemana'))}</th><th>${esc(t('horas.diasMedidos'))}</th><th>${esc(t('horas.tokensSinCache'))}</th><th>${esc(t('horas.costoColumna'))}</th></tr></thead><tbody>${filas}</tbody></table></div>` : '';
  const fuera = r.fuera ? `<p class="nota">${esc(r.fuera === 1 ? t('horas.fuera1') : t('horas.fueraN', { n: r.fuera }))}</p>` : '';
  const avisos = (r.sinHoras || []).map((m) => `<p class="aviso">${esc(t('horas.sinHoras', { maquina: m }))}</p>`).join('');
  return `${titulo}${avisos}${fichas}${tabla}${fuera}`;
}

/**
 * La evolución en dos gráficos chicos, uno por medida (nunca dos escalas en el mismo): horas por persona apiladas por
 * semana, y tokens sin caché por semana. Una semana sin medir queda vacía y rotulada, nunca en cero. Cada barra dice su
 * valor al pasar el mouse; la leyenda nombra a cada persona, y la tabla por persona y la diaria son la vista en tabla.
 */
function htmlSemanas(r, idioma) {
  const t = (k, v) => TX.t(idioma, k, v);
  const semanas = (r.semanas || []).slice().reverse();
  if (!semanas.length) return '';
  const nombres = r.personas.map((p) => p.persona);
  const etiquetas = r.personas.map((p) => nombreDeFila(p, t));
  const color = (i) => (i < SERIES ? `var(--serie-${i + 1})` : 'var(--nm)');
  const W = 640; const H = 200; const IZQ = 48; const ABAJO = 24; const ARRIBA = 10;
  const ancho = (W - IZQ - 10) / semanas.length;
  const barra = Math.min(48, ancho * 0.6);
  const ejeX = (i) => IZQ + i * ancho + (ancho - barra) / 2;
  const fecha = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const grafico = (titulo, valores, formato, pila) => {
    const max = Math.max(1, ...valores.map((v) => (pila ? v.reduce((a, x) => a + (x.valor || 0), 0) : v || 0)));
    const y = (v) => ARRIBA + (H - ABAJO - ARRIBA) * (1 - v / max);
    const grilla = [0, max / 2, max].map((v) => `<line class="grilla" x1="${IZQ}" x2="${W - 10}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="eje" x="${IZQ - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(formato(v))}</text>`).join('');
    const barras = semanas.map((s, i) => {
      const x = ejeX(i);
      const etiqueta = `<text class="eje" x="${(x + barra / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(fecha(s.desde))}</text>`;
      if (!s.medida) return `${etiqueta}<text class="sin-medir" x="${(x + barra / 2).toFixed(1)}" y="${(H - ABAJO - 6).toFixed(1)}" text-anchor="middle">${esc(t('horas.sinMedirCorto'))}</text>`;
      if (!pila) {
        const v = valores[i];
        if (v === null) return `${etiqueta}<text class="sin-medir" x="${(x + barra / 2).toFixed(1)}" y="${(H - ABAJO - 6).toFixed(1)}" text-anchor="middle">${esc(t('horas.sinMedirCorto'))}</text>`;
        return `${etiqueta}<rect class="barra-tokens" x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${barra.toFixed(1)}" height="${(y(0) - y(v)).toFixed(1)}" rx="2"><title>${esc(`${s.desde} a ${s.hasta}: ${formato(v)}`)}</title></rect>`;
      }
      let base = 0;
      const partes = valores[i].filter((p) => p.valor).map((p) => {
        const y0 = y(base); base += p.valor; const y1 = y(base);
        // 2 px de superficie entre partes: cada persona se distingue también sin el color
        return `<rect class="barra-persona" x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${barra.toFixed(1)}" height="${Math.max(0, y0 - y1 - 2).toFixed(1)}" rx="2" style="fill:${color(p.i)}"><title>${esc(`${p.persona} · ${s.desde} a ${s.hasta}: ${formato(p.valor)}`)}</title></rect>`;
      }).join('');
      return `${etiqueta}${partes}`;
    }).join('');
    // en una pantalla angosta el gráfico se desliza en vez de achicarse hasta que los rótulos no se leen
    return `<div class="desliza" tabindex="0"><figure class="grafico"><figcaption>${esc(titulo)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(titulo)}">${grilla}${barras}</svg></figure></div>`;
  };
  const horas = semanas.map((s) => nombres.map((persona, i) => ({ persona, i, valor: s.porPersona[persona] })).filter((p) => p.valor !== null));
  const leyenda = `<ul class="leyenda">${nombres.map((n, i) => `<li><span class="muestra" style="background:${color(i)}"></span>${esc(i < SERIES ? etiquetas[i] : `${etiquetas[i]} (${t('horas.otras')})`)}</li>`).join('')}</ul>`;
  return `<h3>${esc(t('horas.evolucion'))}</h3>${grafico(t('horas.graficoHoras'), horas, horasDe, true)}${leyenda}${grafico(t('horas.graficoTokens'), semanas.map((s) => s.tokens), abreviar, false)}`;
}

/** La tabla de cada día por persona: las horas con el arnés trabajando de sus máquinas sumadas, o «no medido». */
function htmlDiaPorPersona(tabla, r, idioma) {
  const t = (k, v) => TX.t(idioma, k, v);
  const dias = tabla.dias.slice(0, DIAS);
  // el día como en los gráficos (día/mes): la página no mezcla «11-27» con «27/11»
  const cab = `<tr><th>${esc(t('horas.persona'))}</th>${dias.map((d) => `<th>${esc(`${d.slice(8, 10)}/${d.slice(5, 7)}`)}</th>`).join('')}</tr>`;
  const filas = r.personas.map((p) => {
    const celdas = dias.map((d) => {
      let s = 0; let medido = false;
      for (const m of p.maquinas) { const c = tabla.celdas[d][m]; if (c && c.estado === 'medido' && c.horas) { s += c.horas.arnes_segundos; medido = true; } }
      return medido ? `<td>${horasDe(s)}</td>` : `<td class="no-medido">${esc(t('horas.noMedido'))}</td>`;
    }).join('');
    return `<tr><th scope="row">${esc(nombreDeFila(p, t))}</th>${celdas}</tr>`;
  }).join('');
  // 30 columnas no entran en la pantalla: se dice que hay más y hacia dónde
  return `<p class="desliza-aviso">${esc(t('horas.deslizaAviso', { n: dias.length }))}</p><div class="desliza" tabindex="0"><table class="por-persona"><thead>${cab}</thead><tbody>${filas}</tbody></table></div>`;
}

function crearRutas({ fuentes, log = () => {}, ahora = Date.now } = {}) {
  const solo = ['maintainer'];
  // la página lee 42 días (la evolución de 6 semanas); /api/horas sigue dando los 30 de siempre
  const tabla = (dias = DIAS) => {
    let jornadas = { maquinas: {} };
    try { jornadas = typeof fuentes.jornadas === 'function' ? fuentes.jornadas() : jornadas; } catch (e) { log(`horas y tokens: no se pudieron leer los días (${e.code || e.message})`); }
    const t = armarTabla(jornadas, { ayer: diaMas(new Date(ahora()).toISOString().slice(0, 10), -1), dias });
    if (t.problema) log(`horas y tokens: el espejo del buzón no se pudo leer (${t.problema})`);
    for (const [m, codigo] of Object.entries(jornadas.ilegibles || {})) log(`horas y tokens: los días de ${m} no se pudieron leer (${codigo})`);
    return t;
  };
  return [
    {
      method: 'GET', path: '/horas', needs: solo, pestana: { id: 'horas', titulo: 'Horas y tokens', orden: 50 },
      handler: (ctx) => {
        const idioma = views.idiomaDe(ctx);
        const tab = tabla(DIAS_EVOLUCION);
        // el espejo que no se pudo leer se dice arriba: la tabla vacía no es «no llegó nada»
        const aviso = tab.problema ? `<p>${esc(TX.t(idioma, 'horas.espejoIlegible', { motivo: tab.problema }))}</p>` : '';
        let people = null;
        let precios = null;
        try {
          const c = typeof fuentes.config === 'function' ? fuentes.config() : null;
          people = c && c.people;
          precios = c && c.site && c.site.prices;
        } catch (e) { log(`horas y tokens: no se pudo leer la configuración de personas y precios (${e.code || e.message})`); }
        const r = tab.maquinas.length ? resumen(tab, people, precios) : null;
        const porMaquina = `<details class="dia-a-dia"><summary>${esc(TX.t(idioma, 'horas.diaPorMaquina'))}</summary>${htmlTabla(tab, idioma)}</details>`;
        const diario = `<details class="dia-a-dia"><summary>${esc(TX.t(idioma, 'horas.diaPorDia'))}</summary>${r ? htmlDiaPorPersona(tab, r, idioma) : ''}${porMaquina}</details>`;
        const cuerpo = `<p class="lede">${esc(TX.t(idioma, 'horas.lede'))}</p>${aviso}${r ? htmlResumen(r, idioma) + htmlSemanas(r, idioma) : ''}${diario}`;
        return { status: 200, tipo: 'text/html; charset=utf-8', cuerpo: views.layout(ctx, TX.t(idioma, 'pestana.horas'), cuerpo) };
      },
    },
    { method: 'GET', path: '/api/horas', needs: solo, handler: () => ({ status: 200, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(tabla()) }) },
  ];
}

module.exports = { crearRutas, leerJornadas, jornadasDe, validarDia, armarTabla, htmlTabla, abreviar, resumen, htmlResumen, htmlSemanas, htmlDiaPorPersona };
