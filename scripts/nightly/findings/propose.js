#!/usr/bin/env node
'use strict';
/**
 * propose.js — el modelo de la noche propone «aceptar» o «arreglar» para las fichas pendientes de las tres fuentes
 * (dependencias, el vigilante y la revisión de las ejecuciones), con una razón corta. Propone y nada más: no mueve la
 * ficha, no cambia su veredicto, no crea pedidos ni decisiones. Decide una persona en el sitio.
 *
 * A qué fichas: las vivas o reaparecidas, pendientes y sin propuesta, de la más vieja a la más nueva, hasta 30 por noche
 * entre todas las fuentes. Una ficha que falló tres noches seguidas no se pide más, y una que ya falló hoy no se vuelve a
 * pedir si el paso corre otra vez el mismo día. Al modelo le llegan sólo los campos con forma de la ficha
 * (CAMPOS_AL_MODELO; el nombre y la causa sólo si tienen forma de nombre): ni sus casos, ni el diagnóstico del vigilante,
 * ni texto de una conversación. La razón pasa por el filtro de frases (`razonSegura` de cycle.js) antes de guardarse.
 *
 * El modelo es el que configuró la organización (`models.nightly`, lo resuelve nightly-model.js). La llamada al proveedor
 * es de acá: Anthropic o la nube de Ollama, con la llave de la variable secreta del paso, y un corte de 60 segundos. Sin
 * modelo, sin llave, con el modelo caído (red, 429, tiempo agotado) o con una respuesta que no es la esperada, la ficha
 * queda con `propuesta: null` y su motivo (lista cerrada), y la noche sigue. Con el modelo caído no se le sigue pidiendo
 * esa noche: las fichas que faltan quedan con el mismo motivo, sin sumar una falla. El valor de la llave no se imprime nunca.
 *
 * Deja `inbox/model-proposals.json` con lo que hizo esa noche: de ahí sale la línea del resumen. Lo escribe al empezar
 * (`ran: false`) y al terminar, así un paso que muere a mitad deja dicho que no terminó. El paso del nocturno falla
 * abierto: este guion sale 0 siempre que lo llamen bien.
 *
 * Uso: node scripts/nightly/findings/propose.js --operations <clon de operaciones> --team-repos <team-repos.json> [--today AAAA-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const CYCLE = require('./cycle.js');
const SOURCES = require('./sources.js');
const NM = require('../../lib/nightly-model.js');

const TOPE = 30;
const CORTE_MS = 60000;
const RAZON_SIN_FORMA = 'razón sin la forma esperada';
const ESTADO_NOCHE = path.join('inbox', 'model-proposals.json');
// Lo único de la ficha que viaja al modelo.
const CAMPOS_AL_MODELO = ['fuente', 'causa', 'nombre', 'apariciones', 'casos_total', 'primera_vez', 'ultima_vez', 'estado', 'veredicto_anterior'];
// Lo que dice resolveNightly, en el motivo de la ficha.
const MOTIVO_DE_ESTADO = { 'not-configured': 'sin-modelo', 'no-model': 'sin-modelo', unreadable: 'sin-modelo', 'not-allowed': 'no-permitido', 'no-secret': 'sin-llave' };

const entero = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

// ── las candidatas ───────────────────────────────────────────────────────────────────────────

/**
 * Las fichas pendientes de las tres fuentes a las que se les puede pedir propuesta, de la más vieja a la más nueva:
 * `[{ fuente, ruta, comun, datos, fallas, falloHoy }]`. `comun` es la ficha común (ejecuciones) o null (formato por
 * secciones). `falloHoy` es el motivo de una ficha que ya falló hoy, o que ya falló tres noches: no se le pide, sólo se
 * cuenta (sigue sin propuesta, y el resumen lo dice).
 */
function candidatas(base, hoy = null) {
  const out = [];
  for (const [fuente, reg] of Object.entries(SOURCES.FUENTES)) {
    const dir = path.join(base, 'inbox', reg.carpeta, 'pending');
    let nombres = [];
    try {
      nombres = fs.readdirSync(dir).filter((n) => n.endsWith(reg.extension)).sort();
    } catch (e) {
      // sin la carpeta, la organización no tiene esa fuente; otra cosa se dice
      if (!e || e.code !== 'ENOENT') process.stderr.write(`propose.js: no pude leer las fichas pendientes de ${fuente} (${(e && e.code) || 'error'})\n`);
      continue;
    }
    for (const nombre of nombres) {
      const ruta = path.join(dir, nombre);
      let txt;
      try { txt = fs.readFileSync(ruta, 'utf8'); } catch { continue; }
      try {
        if (fuente === 'ejecuciones') {
          if (SOURCES.esVieja(txt)) continue;
          const f = CYCLE.parsear(txt);
          const fallas = f.propuesta_fallas || 0;
          if (!['viva', 'reaparecio'].includes(f.estado) || f.veredicto !== 'pendiente' || f.propuesta !== null) continue;
          // la que ya falló tres noches no se pide más, pero sigue sin propuesta: se cuenta con su motivo
          const agotada = fallas >= CYCLE.FALLAS_MAX;
          const falloHoy = agotada || (hoy && f.propuesta_fallo_el === hoy) ? f.propuesta_motivo || 'modelo-caido' : null;
          out.push({ fuente, ruta, comun: f, fallas, falloHoy, datos: soloConForma({ ...f, veredicto_anterior: f.veredicto_anterior }) });
        } else {
          const e = reg.formato.leerFicha(txt).escalares;
          const v = SOURCES.comoFicha(fuente, txt);
          const fallas = entero(e.propuesta_fallas) || 0;
          if (!['viva', 'reaparecio'].includes(v.estado) || v.veredicto !== 'pendiente' || e.propuesta_accion) continue;
          const casos = fuente === 'dependencias' ? reg.formato.listaDe(txt, 'ids').length : null;
          const motivo = CYCLE.MOTIVOS_SIN_PROPUESTA.includes(e.propuesta_motivo) ? e.propuesta_motivo : 'modelo-caido';
          const falloHoy = fallas >= CYCLE.FALLAS_MAX || (hoy && e.propuesta_fallo_el === hoy) ? motivo : null;
          out.push({ fuente, ruta, comun: null, fallas, falloHoy, datos: soloConForma({ ...v, casos_total: casos, veredicto_anterior: null }) });
        }
      } catch { /* una ficha ilegible la cuenta su fuente; acá no se le pide nada */ }
    }
  }
  const clave = (c) => `${c.datos.primera_vez || '9999-99-99'}|${c.fuente}|${c.ruta}`;
  return out.sort((a, b) => (clave(a) < clave(b) ? -1 : clave(a) > clave(b) ? 1 : 0));
}

// El nombre y la causa viajan sólo con forma de nombre: un paquete, una regla o el nombre en llano de una causa. Un texto
// largo o con signos de una frase (un nombre armado como instrucción) no viaja.
const FORMA_DE_NOMBRE = /^[\p{L}\p{N}@][\p{L}\p{N} ._:/@+()-]{0,79}$/u;

/** Sólo los campos con forma que viajan al modelo: constantes, fechas, números y el nombre en llano de la causa. */
function soloConForma(v) {
  const out = {};
  for (const k of CAMPOS_AL_MODELO) {
    const x = v[k] === undefined ? null : v[k];
    // ni un correo ni una dirección, aunque tengan los signos de un nombre de paquete
    const conForma = typeof x === 'string' && FORMA_DE_NOMBRE.test(x) && !/[^\s@]@[^\s@]+\.|:\/\//.test(x);
    out[k] = (k === 'nombre' || k === 'causa') && x !== null && !conForma ? null : x;
  }
  return out;
}

// ── el modelo ────────────────────────────────────────────────────────────────────────────────

function textoDelPedido(datos) {
  return [
    'Sos el revisor de lo que encontró la noche en un arnés de desarrollo. Te paso una ficha (sólo sus datos).',
    'Decí si conviene «aceptar» (es esperable, no hace falta tocar nada) o «arreglar» (hay que corregir algo).',
    'Contestá SÓLO con un JSON: {"accion":"aceptar"|"arreglar","razon":"<una frase en castellano, hasta 200 caracteres, sin rutas ni enlaces>"}.',
    `Ficha: ${JSON.stringify(datos)}`,
  ].join('\n');
}

// El modelo de Anthropic llega por su apodo (el de los niveles); la API pide su identificador, de la tabla de models.js.
// Un identificador ya escrito pasa tal cual.
const idDeAnthropic = (model) => require(path.join(__dirname, '..', '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'models.js')).anthropicApiId(model);

/**
 * El cliente del proveedor: `{ ok: true, texto }`, o `{ ok: false, caido: true }` ante un error de red, un 429, otro
 * error del servicio o el corte de tiempo. Un 200 que no es JSON vuelve como texto vacío: es una respuesta que no es la
 * esperada, no un modelo caído. La llave se lee del ambiente por su nombre y no sale de acá. `fetch` es inyectable para
 * las pruebas.
 */
async function llamarAlProveedor({ provider, model, secretEnv, texto, env = process.env, fetch = globalThis.fetch }) {
  const llave = env[secretEnv];
  const senal = AbortSignal.timeout(CORTE_MS);
  try {
    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: senal,
        headers: { 'content-type': 'application/json', 'x-api-key': llave, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: idDeAnthropic(model), max_tokens: 300, messages: [{ role: 'user', content: texto }] }),
      });
      if (!r.ok) return { ok: false, caido: true };
      let j;
      try { j = await r.json(); } catch { return { ok: true, texto: '' }; }
      return { ok: true, texto: j && Array.isArray(j.content) ? j.content.map((c) => (c && c.text) || '').join('') : '' };
    }
    if (provider === 'ollama') {
      const r = await fetch('https://ollama.com/api/chat', {
        method: 'POST', signal: senal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${llave}` },
        body: JSON.stringify({ model, stream: false, format: 'json', messages: [{ role: 'user', content: texto }] }),
      });
      if (!r.ok) return { ok: false, caido: true };
      let j;
      try { j = await r.json(); } catch { return { ok: true, texto: '' }; }
      return { ok: true, texto: (j && j.message && j.message.content) || '' };
    }
    return { ok: false, caido: true };
  } catch {
    return { ok: false, caido: true };
  }
}

/** La propuesta de la respuesta del modelo, o null si no es la esperada. La razón que no pasa el filtro se reemplaza. */
function interpretar(texto) {
  const m = String(texto || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!j || !CYCLE.ACCIONES.includes(j.accion) || typeof j.razon !== 'string') return null;
  const razon = j.razon.trim();
  return { accion: j.accion, razon: CYCLE.razonSegura(razon) ? razon : RAZON_SIN_FORMA };
}

// ── escribir ─────────────────────────────────────────────────────────────────────────────────

/**
 * Escribe en la ficha la propuesta o el motivo, y nada más. `fallo`: la fecha de la noche fallada, si la falla cuenta
 * (una por noche: la que ya falló esa fecha no suma otra).
 */
function escribir(c, { propuesta = null, motivo = null, fallo = null }) {
  if (c.comun) {
    const antesEl = c.comun.propuesta_fallo_el || null;
    const fallas = propuesta ? 0 : c.fallas + (fallo && antesEl !== fallo ? 1 : 0);
    const falloEl = propuesta ? null : (fallo || antesEl);
    const f = { ...c.comun, propuesta, propuesta_motivo: propuesta ? null : motivo };
    if (fallas) f.propuesta_fallas = fallas; else delete f.propuesta_fallas;
    if (falloEl) f.propuesta_fallo_el = falloEl; else delete f.propuesta_fallo_el;
    if (!propuesta && c.comun.propuesta_motivo === motivo && (c.comun.propuesta_fallas || 0) === fallas && antesEl === falloEl) return;
    escribirEntero(c.ruta, CYCLE.serializar(f));
    return;
  }
  const fmt = SOURCES.FUENTES[c.fuente].formato;
  let txt = fs.readFileSync(c.ruta, 'utf8');
  const antes = txt;
  const antesEl = fmt.leerFicha(txt).escalares.propuesta_fallo_el || null;
  const fallas = propuesta ? 0 : c.fallas + (fallo && antesEl !== fallo ? 1 : 0);
  const falloEl = propuesta ? null : (fallo || antesEl);
  txt = SOURCES.CLAVES_DE_PROPUESTA.reduce((t, k) => fmt.quitarClave(t, k), txt);
  if (propuesta) {
    txt = fmt.ponerEscalar(txt, 'propuesta_accion', propuesta.accion);
    txt = fmt.ponerEscalar(txt, 'propuesta_razon', JSON.stringify(propuesta.razon));
    if (propuesta.modelo) txt = fmt.ponerEscalar(txt, 'propuesta_modelo', propuesta.modelo);
  } else {
    txt = fmt.ponerEscalar(txt, 'propuesta_motivo', motivo);
    if (fallas) txt = fmt.ponerEscalar(txt, 'propuesta_fallas', String(fallas));
    if (falloEl) txt = fmt.ponerEscalar(txt, 'propuesta_fallo_el', falloEl);
  }
  if (txt !== antes) escribirEntero(c.ruta, txt);
}

function escribirEntero(ruta, txt) {
  const tmp = `${ruta}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, txt);
  fs.renameSync(tmp, ruta);
}

// ── la noche ─────────────────────────────────────────────────────────────────────────────────

/**
 * La pasada de la noche: `{ propuestas, sin_propuesta: { <motivo>: n } }`, y la constancia en `inbox/model-proposals.json`.
 * `llamar` (inyectable para las pruebas) recibe `{ provider, model, secretEnv, texto, datos }`.
 */
async function run({ base, teamRepos, env = process.env, hoy, llamar = null }) {
  const sin = {};
  const sumar = (m, n = 1) => { sin[m] = (sin[m] || 0) + n; };
  let constanciaOk = true;
  const constancia = (estado) => {
    try {
      escribirEntero(path.join(base, ESTADO_NOCHE), `${JSON.stringify(estado, null, 2)}\n`);
    } catch (e) {
      constanciaOk = false;
      process.stderr.write(`propose.js: no pude escribir ${ESTADO_NOCHE} (${(e && e.code) || 'error'}): el resumen no va a saber qué pasó\n`);
    }
  };
  // al empezar: si el paso muere a mitad, el resumen dice que no terminó
  constancia({ date: hoy, ran: false });
  // una ficha que no se pudo escribir no frena a las demás: queda contada como «sin-escribir»
  const escribirO = (c, q) => {
    try { escribir(c, q); return true; } catch (e) {
      process.stderr.write(`propose.js: no pude escribir una ficha de ${c.fuente} (${(e && e.code) || 'error'})\n`);
      return false;
    }
  };
  const todas = candidatas(base, hoy);
  // las que ya fallaron hoy no se vuelven a pedir: se cuentan con su motivo
  for (const c of todas) if (c.falloHoy) sumar(c.falloHoy);
  const pedibles = todas.filter((c) => !c.falloHoy);
  const elegidas = pedibles.slice(0, TOPE);
  if (pedibles.length > TOPE) sumar('tope', pedibles.length - TOPE);
  let propuestas = 0;
  const nm = NM.resolveNightly({ orgConfig: teamRepos, env });
  if (!nm.ok) {
    // la configuración no es una falla de la ficha: no suma a sus fallas, y no se escribe de nuevo si ya lo dice
    const motivo = MOTIVO_DE_ESTADO[nm.status] || 'sin-modelo';
    for (const c of elegidas) sumar(escribirO(c, { motivo }) ? motivo : 'sin-escribir');
  } else {
    const cliente = llamar || ((p) => llamarAlProveedor({ ...p, env }));
    let caido = false;
    for (const c of elegidas) {
      if (caido) {
        // con el modelo caído no se le sigue pidiendo esta noche; la que no se pidió no suma una falla
        sumar(escribirO(c, { motivo: 'modelo-caido' }) ? 'modelo-caido' : 'sin-escribir');
        continue;
      }
      let r;
      try { r = await cliente({ provider: nm.provider, model: nm.model, secretEnv: nm.secret.env, texto: textoDelPedido(c.datos), datos: c.datos }); } catch { r = { ok: false, caido: true }; }
      const p = r && r.ok ? interpretar(r.texto) : null;
      if (p) {
        if (escribirO(c, { propuesta: { ...p, ...(nm.model && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/.test(nm.model) ? { modelo: nm.model } : {}) } })) propuestas += 1;
        else sumar('sin-escribir');
      } else {
        const motivo = r && r.ok ? 'respuesta-invalida' : 'modelo-caido';
        if (motivo === 'modelo-caido') caido = true;
        sumar(escribirO(c, { motivo, fallo: hoy }) ? motivo : 'sin-escribir');
      }
    }
  }
  constancia({ date: hoy, ran: true, proposed: propuestas, without: sin });
  return { propuestas, sin_propuesta: sin, constancia: constanciaOk };
}

/** Lo que dice la línea de comandos al terminar: la línea del resumen, o que todas tienen la suya, o «?» sin constancia. */
function lineaDeLaCorrida(base, hoy, r) {
  if (!r || r.constancia === false) return 'sin propuesta del modelo: ? (el paso de la propuesta no corrió hoy)';
  return lineaDelResumen(base, hoy) || 'propuestas del modelo: todas las fichas pendientes tienen la suya';
}

/**
 * La línea del resumen: «sin propuesta del modelo: N (motivo n · …)», sin línea si todas tuvieron propuesta, y «?» si el
 * paso no corrió hoy o no terminó. Si esa noche hubo propuestas, va adelante cuántas: «propuestas del modelo: P · sin
 * propuesta: N (…)»; sin eso, «sin propuesta: 37 (tope 37)» se lee como que el modelo no propuso nada (la constancia es de otra noche, dice `ran: false` o no se puede leer). Sin constancia,
 * ninguna: la organización todavía no tiene el paso. Los motivos salen de la lista cerrada; nada del archivo se copia tal cual.
 */
function lineaDelResumen(base, hoy) {
  const archivo = path.join(base, ESTADO_NOCHE);
  if (!fs.existsSync(archivo)) return null;
  let e = null;
  try { e = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { /* ilegible: no se sabe si corrió */ }
  if (!e || e.date !== hoy || e.ran !== true || !e.without || typeof e.without !== 'object') {
    return 'sin propuesta del modelo: ? (el paso de la propuesta no corrió hoy)';
  }
  const partes = CYCLE.MOTIVOS_SIN_PROPUESTA.filter((m) => Number.isInteger(e.without[m]) && e.without[m] > 0).map((m) => [m, e.without[m]]);
  const total = partes.reduce((s, [, n]) => s + n, 0);
  if (!total) return null;
  const motivos = partes.map(([m, n]) => `${m} ${n}`).join(' · ');
  const hechas = Number.isInteger(e.proposed) && e.proposed > 0 ? e.proposed : 0;
  return hechas ? `propuestas del modelo: ${hechas} · sin propuesta: ${total} (${motivos})` : `sin propuesta del modelo: ${total} (${motivos})`;
}
// La forma de esa línea, para la constancia de las 08:00.
const MOTIVOS_RE = `\\((${CYCLE.MOTIVOS_SIN_PROPUESTA.join('|')}) \\d+( · (${CYCLE.MOTIVOS_SIN_PROPUESTA.join('|')}) \\d+)*\\)`;
const RENGLON = new RegExp(`^(sin propuesta del modelo: (\\? \\(el paso de la propuesta no corrió hoy\\)|\\d+ ${MOTIVOS_RE})|propuestas del modelo: \\d+ · sin propuesta: \\d+ ${MOTIVOS_RE})$`);

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const base = opt('--operations');
  const hoy = opt('--today') || new Date().toISOString().slice(0, 10);
  if (!base) { process.stderr.write('uso: propose.js --operations <clon de operaciones> --team-repos <team-repos.json> [--today AAAA-MM-DD]\n'); process.exit(2); }
  run({ base, teamRepos: opt('--team-repos'), hoy }).then((r) => {
    process.stdout.write(`${lineaDeLaCorrida(base, hoy, r)}\n`);
  }).catch((e) => {
    // falla abierto: la noche de dependencias sigue; el resumen dirá que el paso no corrió
    process.stderr.write(`propose.js: no pude terminar (${String((e && e.message) || e).split('\n')[0].slice(0, 200)})\n`);
  });
}

module.exports = { run, candidatas, interpretar, lineaDelResumen, lineaDeLaCorrida, llamarAlProveedor, soloConForma, idDeAnthropic, CAMPOS_AL_MODELO, RAZON_SIN_FORMA, RENGLON, TOPE };
