#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * instinct-nightly.js — LA NOCHE QUE PROPONE APRENDIZAJES PARA TODO EL EQUIPO
 *
 * Cada máquina graba lo que hace el agente (integrations/instincts/scripts/instinct-observe.js) y sube un día por vez
 * al buzón de la organización. Esta pieza la corre la noche de la organización (pipelines/operations/instinct-proposals.yml):
 * baja esos días, cuenta sin modelo lo que se repite en el equipo, deja afuera el ruido, le pide al modelo de la noche
 * que escriba cada propuesta, y deja un archivo por propuesta en `inbox/instincts/propuestas/<huella>.json` del repo de
 * operaciones, que se decide en la pestaña Aprendizajes del sitio. Lo que recomienda hacer con cada pendiente va aparte,
 * en `.dashboard/instincts/recomendaciones.json`: recomendar no reescribe ninguna propuesta, así no choca con un pull
 * request de decisiones abierto sobre ella.
 *
 * 🔴 «NO PUDE» NUNCA ES «NO HAY». Sin poder leer el buzón, sin ningún día bajado o con el perfil ilegible: no se llama
 *    al modelo, no se escribe ninguna propuesta, el informe del día dice `no_medido` con su motivo (de una lista
 *    cerrada: el texto de un error puede nombrar una máquina) y sale 1. Un conteo que no se midió es `null`, nunca 0.
 * 🔴 NADA QUE IDENTIFIQUE A UNA MÁQUINA O A UNA PERSONA en lo que se escribe: ni la carpeta, ni la sesión, ni un correo.
 *    Las máquinas se cuentan; lo que escribe el modelo y el patrón pasan por el saneado de la grabadora.
 * 🔴 LO DECIDIDO NO SE TOCA. Una propuesta con archivo no vuelve a pedirse; la noche sólo completa una `pendiente` que
 *    salió sin redacción. Una aprobada, una rechazada o una descartada quedan byte por byte.
 * 🔴 LO PENDIENTE NO SE DESCARTA SOLO. Lo decide una persona: la noche le recomienda rechazarlo, con su motivo.
 * 🔴 SIN EL MODELO DE LA NOCHE, NINGÚN OTRO. Si `resolveNightly` no está listo, lo nuevo espera a otra noche, sin archivo.
 *
 * Topes: el modelo escribe como mucho 20 propuestas por noche, primero las pendientes sin redacción y después las nuevas
 * (en tandas de 15, el tope de `buildPrompt`), y recomienda como mucho 30. Una propuesta nueva nace redactada o descartada
 * con su motivo; las demás esperan, sin archivo, a la noche siguiente.
 *
 * Uso: node scripts/instincts/instinct-nightly.js --profile <team-profile.json> --team-repos <team-repos.json>
 *        --mailbox <carpeta del espejo> --operations <árbol de operaciones> --today <AAAA-MM-DD> [--no-push] [--json]
 *   --no-push: escribe en el disco y no guarda (la ejecución de prueba del pipeline, `efectos=false`).
 * Salida: 0 medido o apagado · 1 no medido, o el guardado no viajó · 2 uso.
 *
 * Casos: scripts/tests/instinct-nightly.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const O = require('./instinct-observer.js');
const { sanitize } = require(path.join(ROOT, 'integrations', 'instincts', 'scripts', 'instinct-observe.js'));

const VENTANA_DIAS = 60;          // la misma que dice buildPrompt: «in last 60d»
const DIAS_SIN_REPORTAR = 7;
const TOPE_MODELO = 20;
const TOPE_RECOMENDAR = 30;
const TANDA = 15;                 // el tope de buildPrompt
const MIN_CONFIANZA = 0.85;
const PROPUESTAS = 'inbox/instincts/propuestas';
const INFORMES = '.dashboard/instincts';
const RECOMENDACIONES = `${INFORMES}/recomendaciones.json`;
const PROYECTOS_CON_REGLAS = 'inbox/instincts/proyectos-con-reglas.json';
const RUTAS = [PROPUESTAS, INFORMES];
const DIA_ARCHIVO = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/;
// los estados de la bajada (download-runs.js) con que la noche sigue, y los que la cortan
const BAJADA_ENTERA = new Set(['bajado', 'al_dia', 'medido']);
const BAJADA_A_MEDIAS = new Set(['sin_red', 'sin_permiso_a_mitad', 'parcial', 'sin_tiempo']);
// la noche sólo lee los días de instintos: sin las conversaciones ni los cambios de git, y con el tiempo del trabajo del
// pipeline (55 minutos), no los 2 de una sesión
const TOPE_BAJADA_MS = 25 * 60 * 1000;
const MOTIVOS = Object.freeze(['perfil_ilegible', 'sin_dias', 'propuestas_ilegibles', 'sync_fallo',
  'sin_az', 'sin_sesion', 'sin_permiso', 'sin_contenedor', 'servicio_fallo', 'config_rota', 'apagado', 'bajada_fallo']);
// por qué la noche recomienda rechazar, por regla: las de ruido y los motivos con que el modelo no dejó una regla útil.
// El sitio muestra su propio texto de cada clave, en el idioma de quien mira
const POR_QUE_REGLA = Object.freeze({
  conteo_sin_leccion: 'Sólo cuenta cuántas veces se usó una herramienta: no deja ninguna lección.',
  carpeta_de_trabajo: 'Viene de una carpeta de trabajo, de una temporal o del estado del arnés: no le sirve al equipo.',
  ruta_de_una_maquina: 'Depende de una ruta de una sola máquina.',
  un_solo_proyecto: 'Es una regla de un solo proyecto, y ese proyecto no pidió sus reglas.',
  sin_propuesta: 'El modelo de la noche no encontró una regla que valga la pena.',
  confianza: 'El modelo de la noche no confió lo suficiente en esta regla.',
  ya_decidida: 'Repite una regla que ya se decidió.',
  cubierta: 'Ya la cubre algo que existe en el arnés o en lo decidido.',
});
const ACCION_RECOMENDADA = Object.freeze({ approve: 'aprobar', reject: 'rechazar' });
// lo que marca un patrón como ruido sólo cuenta al principio de una palabra o de un segmento de ruta
// de una palabra: pegado a un signo del shell (una redirección, un paréntesis, un `;`, un `|` o un acento grave) también
const INICIO_DE_PALABRA = '(?:^|[\\s"\'=>(;|`])';
const INICIO_DE_SEGMENTO = '(?:^|[\\\\/\\s"\'=>(;|`])';
// la unidad de Git Bash (`/c/…`) sólo después de un blanco, una comilla o un `=`: pegada a un paréntesis o a un `|` es una
// expresión regular (`(/x/g)`, `|/a/b`)
const INICIO_DE_UNIDAD = '(?:^|[\\s"\'=])';
let carpetasDeTrabajo = null;
/** Los patrones de carpeta de trabajo. El nombre de la carpeta de Claude Code lo sabe tycon-home; se pide recién al usarlo: el sitio carga este archivo y no llama al filtro. */
function patronesDeCarpeta() {
  if (carpetasDeTrabajo) return carpetasDeTrabajo;
  const { claudeDir } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));
  const deClaude = path.basename(claudeDir()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  carpetasDeTrabajo = [
    /--wt-/i,
    new RegExp(`${INICIO_DE_SEGMENTO}${deClaude}[\\\\/]worktrees[\\\\/]`, 'i'),
    new RegExp(`${INICIO_DE_SEGMENTO}${deClaude}[\\\\/](?:jobs(?:[\\\\/]|$)|jo?b?$)`, 'i'),
    /\$\{?CLAUDE_JOB_DIR\b/,
    new RegExp(`${INICIO_DE_PALABRA}(?:(?:/private)?/tmp(?:/|[\\s"'\\x60;|)>]|$)|(?:/private)?/var/folders/|\\$\\{?TMPDIR\\b)`, 'i'),
    new RegExp(`${INICIO_DE_SEGMENTO}AppData[\\\\/]Local[\\\\/]Temp(?:[\\\\/\\s]|$)`, 'i'),
    /\$\{?env:(?:TEMP|TMP)\b|%(?:TEMP|TMP)%|\$\{?env:LOCALAPPDATA\}?[\\/]Temp(?:[\\/\s"']|$)/i,
    new RegExp(`${INICIO_DE_SEGMENTO}\\.tycon[\\\\/]state[\\\\/]`, 'i'),
    new RegExp(`${INICIO_DE_SEGMENTO}\\.advisors[\\\\/]`, 'i'),
  ];
  return carpetasDeTrabajo;
}
// distingue mayúsculas a propósito, y a `/c/` le pide un segmento de verdad: una ruta de API (`/users/42/`) o una dirección
// de awk o sed (`'/a/ {`, `'/x/d'`) no son la ruta de una máquina
const RUTA_DE_UNA_MAQUINA = new RegExp(`${INICIO_DE_PALABRA}(?:[a-zA-Z]:[\\\\/](?![\\\\/])|/(?:Users|home)/[^/\\s"']+/)|${INICIO_DE_UNIDAD}/[a-zA-Z]/(?:[^/\\s"']{2}|$)`);

const log = (m) => process.stderr.write(`[instinct-nightly] ${m}\n`);
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);

/** La huella de un patrón: los primeros 10 hexadecimales del sha1 de su clave en minúscula. */
function huella(clave) {
  return crypto.createHash('sha1').update(String(clave).toLowerCase()).digest('hex').slice(0, 10);
}

// la clave de un patrón, sin distinguir mayúsculas: es la misma de la que sale su huella, así el mismo repo o resumen
// escrito con otra capitalización en otra máquina es un patrón y no dos que se pisan en el mismo archivo
const claveDe = (l) => `${l.repo}|${l.tool}|${String(l.summary || '').slice(0, 60).trim()}`.toLowerCase();

/**
 * Por qué un patrón es ruido, o null. Mira el repo y los 60 caracteres del resumen que forman la clave, ya saneados: es lo
 * que guarda la propuesta (`repo`, `patron`), así un candidato y una propuesta se juzgan igual.
 */
function motivoDeRuido({ repo, summary }) {
  const resumen = String(summary || '').slice(0, 60).trim();
  if (!resumen) return 'conteo_sin_leccion';
  if (patronesDeCarpeta().some((re) => re.test(String(repo || '')) || re.test(resumen))) return 'carpeta_de_trabajo';
  return RUTA_DE_UNA_MAQUINA.test(String(repo || '')) || RUTA_DE_UNA_MAQUINA.test(resumen) ? 'ruta_de_una_maquina' : null;
}

/** El repo se guarda como ruta relativa: un proyecto se reconoce por su último segmento, sin el sufijo de una copia de trabajo. */
const nombreDeProyecto = (repo) => (String(repo || '').trim().split(/[\\/]/).filter(Boolean).pop() || '').toLowerCase().replace(/--wt-.*$/, '');

/**
 * Los proyectos que pidieron sus propias reglas: `{ nombres, claves }`. Sin el archivo, ninguno. Un archivo que no se
 * lee da `null` en los dos: no se sabe quién las pidió, y esa noche la regla no se aplica.
 */
function leerProyectosConReglas(ops) {
  let texto;
  try { texto = fs.readFileSync(path.join(ops, PROYECTOS_CON_REGLAS), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { nombres: [], claves: new Set() };
    log('no se pudo leer la lista de proyectos con reglas: esta noche no se aplica esa regla');
    return { nombres: null, claves: null };
  }
  let lista = null;
  try { lista = JSON.parse(texto).proyectos; } catch (_) { lista = null; }
  if (!Array.isArray(lista) || !lista.every((x) => typeof x === 'string' && x.trim())) {
    log('la lista de proyectos con reglas no tiene la forma esperada: esta noche no se aplica esa regla');
    return { nombres: null, claves: null };
  }
  return { nombres: lista, claves: new Set(lista.map(nombreDeProyecto)) };
}

const esDeOtroProyecto = (redaccion, repo, proyectos) => Boolean(proyectos.claves && redaccion)
  && String(redaccion.scope || '').trim().toLowerCase() === 'project' && !proyectos.claves.has(nombreDeProyecto(repo));

/** La regla por la que la noche recomienda rechazar una pendiente, o null. El orden es el de la historia: la primera que cae. */
function reglaDePendiente(p, proyectos) {
  return motivoDeRuido({ repo: p.repo, summary: p.patron })
    || (esDeOtroProyecto(p.redaccion, p.repo, proyectos) ? 'un_solo_proyecto' : null)
    || (p.rechazo_sugerido && Object.hasOwn(POR_QUE_REGLA, p.rechazo_sugerido.motivo) ? p.rechazo_sugerido.motivo : null);
}

/** El pedido de recomendación: una llamada aparte de la que redacta, porque pedirle a quien propone que se censure lo apaga. */
function promptDeRecomendacion(propuestas) {
  const bloques = propuestas.map((p, i) => [`### P${i + 1}`, `herramienta: ${p.herramienta}`, `patrón: ${p.patron}`, `repo: ${p.repo}`,
    `veces: ${p.veces}`, `máquinas: ${p.maquinas}`, `cuándo aplica: ${p.redaccion.trigger}`, `qué hacer: ${p.redaccion.action}`,
    `alcance: ${p.redaccion.scope}`, `por qué: ${p.redaccion.reasoning}`].join('\n')).join('\n\n');
  return `Sos quien revisa cada noche las propuestas de aprendizajes del equipo. Cada una es una regla que llegaría a todas las máquinas si una persona la aprueba.

Para cada propuesta, recomendá aprobarla si le sirve a cualquiera del equipo y dice algo concreto que no es obvio; recomendá rechazarla si es trivial, si depende de un caso particular o si no se entiende qué pide.

${bloques}

Contestá SÓLO con una lista YAML, una entrada por propuesta, sin nada antes ni después:

- p: <número de la propuesta>
  recommend: approve | reject
  why: <una sola frase en castellano, sin rutas, enlaces ni comillas>`;
}

/** La respuesta del pedido de recomendación: número de propuesta → `{ recommend, why }`, renglón por renglón. */
function leerRecomendaciones(texto) {
  const out = new Map();
  let actual = null;
  for (const linea of String(texto || '').split(/\r?\n/)) {
    const p = linea.match(/^\s*-\s+p:\s*["']?P?(\d+)/i);
    if (p) { actual = { recommend: '', why: '' }; out.set(Number(p[1]), actual); continue; }
    const m = actual && linea.match(/^\s+(recommend|why):\s*(.*)$/);
    if (m) actual[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Lo que la noche anterior recomendó, por huella. Si no se lee, se dice y se vuelve a pedir, dentro del tope. */
function leerRecomendacionesAnteriores(ops) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(ops, RECOMENDACIONES), 'utf8'));
    return d && d.por_huella && typeof d.por_huella === 'object' ? d.por_huella : {};
  } catch (e) {
    if (!e || e.code !== 'ENOENT') log('las recomendaciones de la noche anterior no se pudieron leer: se vuelven a pedir');
    return {};
  }
}

/**
 * La entrada de cada pendiente: `{ recomendacion, sin_recomendacion }`. Las reglas se recalculan siempre y no gastan
 * llamadas; una recomendación del modelo vale mientras la redacción sea la misma (`de`).
 */
async function recomendarPendientes({ pendientes, anteriores, proyectos, noche, listo, sinModelo, llamar, env, today, limpio, sumar, fallo }) {
  // el filtro de frases vive con las fichas de la noche: se carga recién acá, para que el sitio no lo necesite
  const { razonSegura } = require(path.join(ROOT, 'scripts', 'nightly', 'findings', 'cycle.js'));
  const entradas = {};
  const sin = (x, motivo) => { entradas[x.huella] = { recomendacion: null, sin_recomendacion: motivo }; };
  const cola = [];
  for (const [huella, { p }] of pendientes) {
    const regla = reglaDePendiente(p, proyectos);
    if (regla) { entradas[huella] = { recomendacion: { accion: 'rechazar', por: 'regla', regla, porque: POR_QUE_REGLA[regla] }, sin_recomendacion: null }; continue; }
    if (!p.redaccion || !p.redaccion.trigger) { sin({ huella }, 'sin_redaccion'); continue; }
    const de = O.instinctHash(String(p.redaccion.trigger), String(p.redaccion.action || ''));
    const previa = anteriores[huella] && anteriores[huella].recomendacion;
    if (previa && previa.por === 'modelo' && previa.de === de) { entradas[huella] = { recomendacion: previa, sin_recomendacion: null }; continue; }
    cola.push({ huella, p, de });
  }
  cola.sort((a, b) => ((b.p.maquinas || 0) - (a.p.maquinas || 0)) || ((b.p.veces || 0) - (a.p.veces || 0)) || (a.huella < b.huella ? -1 : 1));
  if (!listo) cola.forEach((x) => sin(x, sinModelo));
  const entran = listo ? cola.slice(0, TOPE_RECOMENDAR) : [];
  if (listo) cola.slice(TOPE_RECOMENDAR).forEach((x) => sin(x, 'tope'));
  for (let i = 0; i < entran.length; i += TANDA) {
    const tanda = entran.slice(i, i + TANDA);
    // las propuestas guardadas se escribieron con el saneado de su noche: se vuelven a sanear antes de ir al modelo
    const limpia = (p) => ({ ...p, patron: limpio(p.patron), repo: limpio(p.repo), redaccion: Object.fromEntries(Object.entries(p.redaccion || {}).map(([k, v]) => [k, typeof v === 'string' ? limpio(v) : v])) });
    const r = await llamar({ prompt: promptDeRecomendacion(tanda.map((x) => limpia(x.p))), nightly: noche, env });
    // con el modelo caído no se le sigue pidiendo esa noche
    if (!r || !r.ok) { fallo((r && r.fallo) || 'red'); entran.slice(i).forEach((x) => sin(x, 'fallo')); break; }
    sumar(r.tokens);
    const respuestas = leerRecomendaciones(r.texto);
    if (!respuestas.size) fallo('respuesta_ilegible');
    tanda.forEach((x, j) => {
      const v = respuestas.get(j + 1);
      const accion = v && Object.hasOwn(ACCION_RECOMENDADA, v.recommend) && ACCION_RECOMENDADA[v.recommend];
      if (!accion || !razonSegura(v.why)) { sin(x, 'respuesta_ilegible'); return; }
      entradas[x.huella] = { recomendacion: { accion, por: 'modelo', modelo: limpio(noche.model), porque: limpio(v.why), el: today, de: x.de }, sin_recomendacion: null };
    });
  }
  return Object.fromEntries(Object.keys(entradas).sort().map((h) => [h, entradas[h]]));
}

/**
 * Lo que se repite en el equipo. `lineas`: `{ maquina, dia, repo, tool, summary, ts, status }`, con la máquina ya
 * resuelta. Candidato: ≥3 veces en ≥2 máquinas, o ≥10 en una. Orden: más máquinas, más veces, y la clave.
 */
function findTeamCandidates(lineas) {
  const grupos = new Map();
  for (const l of lineas) {
    const clave = claveDe(l);
    if (!grupos.has(clave)) grupos.set(clave, { clave, repo: l.repo, tool: l.tool, summary: String(l.summary || '').slice(0, 60).trim(), items: [], maquinas: new Set(), desde: l.dia, hasta: l.dia });
    const g = grupos.get(clave);
    g.items.push(l);
    g.maquinas.add(l.maquina);
    if (l.dia < g.desde) g.desde = l.dia;
    if (l.dia > g.hasta) g.hasta = l.dia;
  }
  const out = [];
  for (const g of grupos.values()) {
    const veces = g.items.length;
    const maquinas = g.maquinas.size;
    if (!((veces >= 3 && maquinas >= 2) || veces >= 10)) continue;
    out.push({ clave: g.clave, huella: huella(g.clave), repo: g.repo, tool: g.tool, summary: g.summary, veces, maquinas, desde: g.desde, hasta: g.hasta, items: g.items });
  }
  out.sort((a, b) => (b.maquinas - a.maquinas) || (b.veces - a.veces) || (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0));
  return out;
}

/**
 * Las uniones de carpetas del espejo (`.carpetas-de-maquina.json`, de download-runs.js): una vieja unida cuenta como su
 * nueva; una compartida, sola. Sin el archivo, `null` (cada carpeta cuenta sola y el informe lo dice).
 */
function leerUniones(espejo) {
  let u;
  try { u = JSON.parse(fs.readFileSync(path.join(espejo, '.carpetas-de-maquina.json'), 'utf8')); } catch (_) { return null; }
  const carpetas = u && u.carpetas && typeof u.carpetas === 'object' ? u.carpetas : {};
  const a = {};
  let unidas = 0;
  let compartidas = 0;
  for (const [vieja, x] of Object.entries(carpetas)) {
    if (x && x.estado === 'unida' && typeof x.nueva === 'string') { a[vieja] = x.nueva; unidas++; } else if (x && x.estado === 'compartida') compartidas++;
  }
  return { a, resumen: { unidas, compartidas } };
}

/** Los días de instintos del espejo: las líneas de la ventana, lo que no contó y el último día de cada máquina. */
function leerEspejo(espejo, hoy) {
  const uniones = leerUniones(espejo);
  const maquinaDe = (c) => (uniones && uniones.a[c]) || c;
  const r = { lineas: [], ilegibles: 0, dias_ilegibles: 0, sin_repo: 0, dias: 0, maquinas: new Set(), ultimo: new Map(), uniones: uniones ? uniones.resumen : 'no_medidas' };
  let carpetas = [];
  try { carpetas = fs.readdirSync(espejo, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (_) { carpetas = []; }
  // una máquina que cambió de carpeta vuelve a subir sus días a la nueva: un día de una máquina se lee una sola vez, y
  // la carpeta nueva (la que es la máquina) va primero
  const propia = (c) => (maquinaDe(c) === c ? 0 : 1);
  const leidos = new Set();
  for (const c of carpetas.sort((a, b) => (propia(a) - propia(b)) || (a < b ? -1 : a > b ? 1 : 0))) {
    let archivos;
    try { archivos = fs.readdirSync(path.join(espejo, c, 'instincts')); } catch (_) { continue; }
    const m = maquinaDe(c);
    for (const f of archivos.sort()) {
      const dm = DIA_ARCHIVO.exec(f);
      if (!dm) continue;
      const dia = dm[1];
      const atras = diasEntre(dia, hoy);
      if (atras < 0) continue;
      if (!r.ultimo.has(m) || r.ultimo.get(m) < dia) r.ultimo.set(m, dia);
      if (atras >= VENTANA_DIAS || leidos.has(`${m}|${dia}`)) continue;
      leidos.add(`${m}|${dia}`);
      r.dias++;
      r.maquinas.add(m);
      let texto;
      // un día entero que no se lee no es «no hubo nada ese día»: la lectura queda a medias
      try { texto = zlib.gunzipSync(fs.readFileSync(path.join(espejo, c, 'instincts', f))).toString('utf8'); } catch (_) { r.dias_ilegibles++; continue; }
      for (const cruda of texto.split('\n')) {
        if (!cruda.trim()) continue;
        let l;
        try { l = JSON.parse(cruda); } catch (_) { r.ilegibles++; continue; }
        if (!l || typeof l !== 'object') { r.ilegibles++; continue; }
        if (!l.repo || typeof l.repo !== 'string') { r.sin_repo++; continue; }
        // el resumen pasa por el saneado antes de todo: la clave del grupo, el patrón y lo que va al modelo salen de él
        // cortado y en minúscula, y un día subido antes de un arreglo del saneado puede traer un secreto
        r.lineas.push({ maquina: m, dia, repo: l.repo, tool: String(l.tool || ''), summary: l.summary == null ? '' : sanitize(String(l.summary), null), ts: l.ts, status: l.status });
      }
    }
  }
  return r;
}

/** Las propuestas que ya están en el repo de operaciones: huella → { p, archivo }. `null` si la carpeta no se lee. */
function leerPropuestas(dir) {
  const out = new Map();
  let archivos;
  try { archivos = fs.readdirSync(dir); } catch (e) { return e && e.code === 'ENOENT' ? out : null; }
  for (const f of archivos) {
    const m = /^([0-9a-f]{10})\.json$/.exec(f);
    if (!m) continue;
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { p = { estado: 'ilegible' }; }
    out.set(m[1], { p, archivo: path.join(dir, f) });
  }
  return out;
}

/**
 * ¿El modelo contestó la lista vacía? Un «[]» solo en su renglón, suelto o dentro de un bloque cercado (yaml, yml o json,
 * con una frase antes o no): la misma lectura que `extractYamlArray`, que primero saca el bloque cercado.
 */
function respuestaVacia(texto) {
  const bloque = String(texto || '').match(/```[a-z]*\s*\n([\s\S]*?)```/i);
  return /^\s*\[\]\s*$/m.test(bloque ? bloque[1] : String(texto || ''));
}

/** El candidato en la forma que leen `buildPrompt` y la revisión del observador. */
// la clave y los resúmenes vienen de líneas ya saneadas al leerlas; se vuelven a pasar por si alguien llama con otras
const paraElModelo = (c, limpio) => ({ key: limpio(c.clave), count: c.veces, items: c.items.map((l) => ({ ts: l.ts, status: l.status, summary: limpio(l.summary) })) });

function escribirJson(archivo, datos) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(datos, null, 2)}\n`);
  fs.renameSync(tmp, archivo);
}

/**
 * El archivo de una propuesta decidida, tal como queda en `inbox/instincts/propuestas/<huella>.json`: la propuesta con
 * su `estado` (`aprobada` o `rechazada`) y su `decision` (`{ por, el, texto, pedido }` o `{ por, el, motivo }`). Lo
 * escribe el sitio (pestaña Aprendizajes) con esta misma función, así lo que decide el sitio y lo que lee la noche no se
 * separan. Un estado que no es una decisión tira.
 */
function archivoDecidido(propuesta, { estado, por, el, texto = null, motivo = null, pedido = null } = {}) {
  if (estado !== 'aprobada' && estado !== 'rechazada') throw new Error(`archivoDecidido: estado «${estado}» no es una decisión`);
  const decision = estado === 'aprobada' ? { por, el, texto, pedido } : { por, el, motivo };
  return `${JSON.stringify({ ...propuesta, estado, decision }, null, 2)}\n`;
}

function informeVacio(fecha) {
  return { fecha, estado: null, motivo: null, parcial: false, uniones: null, maquinas: null, maquinas_sin_reportar: null,
    candidatos: null, ya_propuestas: null, nuevas: null, en_espera: null, en_espera_por: null, con_redaccion: null, sin_redaccion: null, sin_completar: null,
    descartadas: null, filtradas: null, recomendadas: null, sin_recomendacion: null, pendientes_total: null, ilegibles: null, dias_ilegibles: null, sin_repo: null, propuestas_ilegibles: null,
    modelo: null, revision: null, tokens: null };
}

function guardarConPush({ ops, rutas, mensaje, today }) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'push-nightly-data.js'), 'save', '--repo', ops, '--message', mensaje,
    '--today', today, '--require-daily', `${INFORMES}/instintos-{day}.json`, '--', ...rutas], { windowsHide: true, cwd: ops, stdio: ['ignore', 'inherit', 'inherit'] });
  return { ok: r.status === 0 };
}

function sincronizarConPush({ ops, rutas }) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'push-nightly-data.js'), 'sync', '--repo', ops, '--', ...rutas], { windowsHide: true, cwd: ops, stdio: ['ignore', 'inherit', 'inherit'] });
  return { ok: r.status === 0 };
}

/**
 * La noche entera. opts: profile · teamRepos · mailbox · ops · today · noPush · home (para el saneado) · env · deps
 * (`bajar`, `resolveNightly`, `llamar`, `guardar`, `sincronizar`: las pruebas pasan las suyas). `{ codigo, informe }`.
 */
async function correrNoche(opts) {
  const { ops, today, noPush = false, env = process.env } = opts;
  const home = opts.home || os.homedir();
  const deps = opts.deps || {};
  const bajar = deps.bajar || ((o) => require(path.join(ROOT, 'scripts', 'metrics', 'download-runs.js')).bajar(o));
  const resolver = deps.resolveNightly || ((o) => require(path.join(ROOT, 'scripts', 'lib', 'nightly-model.js')).resolveNightly(o));
  const llamar = deps.llamar || ((o) => require('./instinct-model.js').llamar(o));
  const guardar = deps.guardar || ((o) => guardarConPush({ ops, today, ...o }));
  const sincronizar = deps.sincronizar || ((rutas) => sincronizarConPush({ ops, rutas }));
  const dirPropuestas = path.join(ops, PROPUESTAS);
  const lugares = [path.join(ops, 'inbox', 'instincts')];
  const informe = informeVacio(today);

  const terminar = (codigo) => {
    escribirJson(path.join(ops, INFORMES, `instintos-${today}.json`), informe);
    if (!noPush) {
      const g = guardar({ rutas: RUTAS, mensaje: `chore(aprendizajes): propuestas de ${today} [nocturno]`, requireDaily: `${INFORMES}/instintos-{day}.json` });
      if (!g || !g.ok) { log('el guardado en el repo de operaciones NO viajó'); return { codigo: 1, informe }; }
    }
    return { codigo, informe };
  };
  const noMedido = (motivo) => { informe.estado = 'no_medido'; informe.motivo = MOTIVOS.includes(motivo) ? motivo : 'bajada_fallo'; return terminar(1); };

  // lo más nuevo de main antes de mirar qué ya está propuesto
  if (!noPush) {
    const s = sincronizar(RUTAS);
    if (!s || !s.ok) return noMedido('sync_fallo');
  }

  let perfil;
  try { perfil = JSON.parse(fs.readFileSync(opts.profile, 'utf8')); } catch (_) { return noMedido('perfil_ilegible'); }
  if (!perfil || typeof perfil !== 'object') return noMedido('perfil_ilegible');
  if (!(perfil.integrations && perfil.integrations.instincts === true)) { informe.estado = 'apagado'; return terminar(0); }

  // la bajada se decide por su estado, no por el código de salida (download-runs.js sale 0 también sin az)
  let bajada;
  try { bajada = await bajar({ instintos: true, sinHilos: true, budgetMs: TOPE_BAJADA_MS, dirBuzon: opts.mailbox, log }); } catch (_) { bajada = null; }
  const res = (bajada && bajada.res) || {};
  const entera = BAJADA_ENTERA.has(res.estado);
  if (!entera && !BAJADA_A_MEDIAS.has(res.estado)) return noMedido(res.estado || 'bajada_fallo');
  informe.parcial = !entera || res.completo === false;

  const espejo = leerEspejo(opts.mailbox, today);
  if (!espejo.dias) return noMedido('sin_dias');
  const existentes = leerPropuestas(dirPropuestas);
  if (!existentes) return noMedido('propuestas_ilegibles');

  informe.uniones = espejo.uniones;
  informe.maquinas = espejo.maquinas.size;
  informe.maquinas_sin_reportar = [...espejo.ultimo.values()].filter((d) => diasEntre(d, today) > DIAS_SIN_REPORTAR).length;
  informe.ilegibles = espejo.ilegibles;
  informe.dias_ilegibles = espejo.dias_ilegibles;
  if (espejo.dias_ilegibles) informe.parcial = true;
  informe.sin_repo = espejo.sin_repo;
  // una propuesta que no se lee bloquea su huella: se cuenta, para que alguien la mire
  informe.propuestas_ilegibles = [...existentes.values()].filter((x) => x.p.estado === 'ilegible').length;

  const limpio = (t) => (t == null ? null : sanitize(String(t), home));
  const proyectos = leerProyectosConReglas(ops);
  const filtradas = { conteo_sin_leccion: 0, carpeta_de_trabajo: 0, ruta_de_una_maquina: 0, un_solo_proyecto: proyectos.claves ? 0 : null };
  const candidatos = findTeamCandidates(espejo.lineas);
  const nuevos = [];
  const aCompletar = [];
  let yaPropuestas = 0;
  for (const c of candidatos) {
    const e = existentes.get(c.huella);
    // se juzga lo que guardaría la propuesta: lo filtrado no ocupa lugar en el tope ni queda en espera
    const ruido = motivoDeRuido({ repo: limpio(c.repo), summary: limpio(c.summary) });
    if (!e) {
      if (ruido) filtradas[ruido]++; else nuevos.push(c);
      continue;
    }
    yaPropuestas++;
    if (e.p.estado === 'pendiente' && e.p.redaccion == null && !ruido && !e.p.rechazo_sugerido) aCompletar.push(c);
  }
  // primero lo que ya espera una decisión sin redacción, después lo nuevo
  const elegibles = [...aCompletar, ...nuevos];

  // el modelo de la noche, o ninguno
  let noche;
  try { noche = resolver({ orgConfig: opts.teamRepos, env }); } catch (_) { noche = { ok: false, status: 'unreadable' }; }
  const listo = !!(noche && noche.ok);
  informe.modelo = listo ? { provider: noche.provider, model: noche.model, estado: 'ok' }
    : { provider: (noche && noche.provider) || null, model: (noche && noche.model) || null, estado: (noche && noche.status) || 'unreadable' };
  const sinModelo = listo ? null : (noche && noche.status === 'no-secret' ? 'sin_llave' : 'sin_modelo');
  const aRedactar = listo ? elegibles.slice(0, TOPE_MODELO) : [];

  // lo ya decidido, por el hash de siempre: lo de antes del sitio y lo que el sitio decidió
  const decididos = O.existingHashes({ lugares });
  for (const { p } of existentes.values()) {
    if ((p.estado === 'aprobada' || p.estado === 'rechazada') && p.redaccion && p.redaccion.trigger) decididos.add(O.instinctHash(String(p.redaccion.trigger), String(p.redaccion.action || '')));
  }

  const resultado = new Map();   // huella → { tipo: 'redactada' | 'descartada' | 'sin', … }
  const tokens = { entrada: 0, salida: 0, informados: false };
  const sumar = (t) => {
    if (!t) return;
    tokens.informados = true;
    tokens.entrada += Number(t.entrada) || 0;
    tokens.salida += Number(t.salida) || 0;
  };
  const aceptadas = [];
  const fallos = {};   // código de la lista cerrada de instinct-model.js → cuántas llamadas fallaron así
  const fallo = (codigo) => { fallos[codigo] = (fallos[codigo] || 0) + 1; };
  for (let i = 0; i < aRedactar.length; i += TANDA) {
    const tanda = aRedactar.slice(i, i + TANDA);
    const r = await llamar({ prompt: O.buildPrompt(tanda.map((c) => paraElModelo(c, limpio)), espejo.lineas.length, { proyectosConReglas: proyectos.nombres || undefined }), nightly: noche, env });
    if (!r || !r.ok) { fallo((r && r.fallo) || 'red'); for (const c of tanda) resultado.set(c.huella, { tipo: 'sin', causa: 'fallo' }); continue; }
    sumar(r.tokens);
    const texto = String(r.texto || '');
    const items = O.extractYamlArray(texto);
    const porIndice = new Map();
    for (const inst of items) {
      const k = Number(inst.candidate_index);
      if (Number.isInteger(k) && k >= 1 && k <= tanda.length && inst.trigger && inst.action && !porIndice.has(k)) porIndice.set(k, inst);
    }
    // una respuesta sin ninguna propuesta que se pueda usar no es «el modelo no propuso nada» (eso es un «[]» explícito):
    // es un fallo, y la tanda se vuelve a pedir otra noche en vez de quedar descartada para siempre
    if (!porIndice.size && !(items.length === 0 && respuestaVacia(texto))) {
      fallo('respuesta_ilegible');
      for (const c of tanda) resultado.set(c.huella, { tipo: 'sin', causa: 'fallo' });
      continue;
    }
    tanda.forEach((c, j) => {
      const inst = porIndice.get(j + 1);
      if (!inst) { resultado.set(c.huella, { tipo: 'descartada', motivo: 'sin_propuesta' }); return; }
      const conf = parseFloat(inst.confidence);
      if (!(conf >= MIN_CONFIANZA)) { resultado.set(c.huella, { tipo: 'descartada', motivo: 'confianza', inst }); return; }
      const hash = O.instinctHash(String(inst.trigger), String(inst.action));
      if (decididos.has(hash)) { resultado.set(c.huella, { tipo: 'descartada', motivo: 'ya_decidida', inst, hash }); return; }
      resultado.set(c.huella, { tipo: 'redactada', inst });
      aceptadas.push({ c, inst });
    });
  }

  // una sola revisión contra lo ya decidido y el catálogo del arnés; si falla o no se entiende, lo propuesto sigue
  if (aceptadas.length) {
    const insts = aceptadas.map((a, k) => ({ ...a.inst, candidate_index: k + 1 }));
    const rev = O.promptDeRevision(insts, aceptadas.map((a) => paraElModelo(a.c, limpio)), noche.provider, { lugares, propuestas: dirPropuestas });
    informe.revision = rev.prompt ? 'fallo' : 'sin_revision';
    if (rev.prompt) {
      const r = await llamar({ prompt: rev.prompt, nightly: noche, env });
      const veredictos = r && r.ok ? O.leerRevision(r.texto, insts.length) : null;
      if (r && r.ok) sumar(r.tokens);
      // una respuesta sin ningún veredicto no revisó nada: cuenta como fallo, igual que una llamada caída
      if (veredictos && veredictos.size) {
        informe.revision = 'ok';
        aceptadas.forEach((a, k) => {
          const v = veredictos.get(k + 1);
          const d = v ? O.decidirDescarte(v, rev, k) : null;
          if (d && d.cita) resultado.set(a.c.huella, { tipo: 'descartada', motivo: 'cubierta', inst: a.inst, cita: d.cita });
        });
      } else {
        fallo(r && r.ok ? 'respuesta_ilegible' : (r && r.fallo) || 'red');
        log('la revisión contra lo que ya existe falló: lo propuesto sigue sin revisar');
      }
    }
  }

  // todo lo que escribe el modelo pasa por el saneado, también los campos cortos
  const redaccionDe = (inst) => ({
    trigger: limpio(inst.trigger), action: limpio(inst.action), domain: limpio(inst.domain), scope: limpio(inst.scope),
    confidence: parseFloat(inst.confidence), reasoning: limpio(inst.reasoning || ''), tycon_artifact_suggestion: limpio(inst.tycon_artifact_suggestion),
  });
  // una propuesta nueva nace redactada o descartada con su motivo: `sin_redaccion` queda en 0 y lo que no se pudo redactar
  // espera sin archivo, contado por causa. Las pendientes viejas que no se pudieron completar se cuentan aparte
  const sinRedaccion = { tope: 0, fallo: 0, sin_modelo: 0, sin_llave: 0 };
  const sinCompletar = { tope: 0, fallo: 0, sin_modelo: 0, sin_llave: 0 };
  const enEsperaPor = { tope: 0, fallo: 0, sin_modelo: 0, sin_llave: 0 };
  let nuevasEscritas = 0;
  let conRedaccion = 0;
  let descartadas = 0;
  for (const c of elegibles) {
    let r = resultado.get(c.huella) || { tipo: 'sin', causa: sinModelo || 'tope' };
    const previa = existentes.get(c.huella);
    if (r.tipo === 'sin') {
      (previa ? sinCompletar : enEsperaPor)[r.causa]++;
      continue;   // una pendiente sin redacción sigue como estaba, y una nueva espera a otra noche
    }
    if (!previa && r.tipo === 'redactada' && esDeOtroProyecto(r.inst, c.repo, proyectos)) {
      r = { tipo: 'descartada', motivo: 'un_solo_proyecto', inst: r.inst };
      filtradas.un_solo_proyecto++;
    }
    // sólo una propuesta nueva nace descartada: lo que ya estaba pendiente lo decide una persona
    const descartada = r.tipo === 'descartada' && !previa;
    const p = {
      huella: c.huella, estado: descartada ? 'descartada' : 'pendiente', herramienta: c.tool, repo: limpio(c.repo),
      patron: limpio(c.summary), veces: c.veces, maquinas: c.maquinas, desde: c.desde, hasta: c.hasta,
      propuesta_el: previa && previa.p.propuesta_el ? previa.p.propuesta_el : today,
      redaccion: r.inst ? redaccionDe(r.inst) : null,
      sin_redaccion: null,
      modelo: { provider: noche.provider, model: noche.model },
      decision: null,
    };
    if (descartada) {
      p.motivo_corto = r.motivo;
      if (r.cita) p.cita = r.cita;
      if (r.hash) p.hash_coincide = r.hash;
      descartadas++;
    } else if (r.tipo === 'descartada') p.rechazo_sugerido = { motivo: r.motivo, cita: r.cita || null };
    else conRedaccion++;
    if (!previa) nuevasEscritas++;
    escribirJson(path.join(dirPropuestas, `${c.huella}.json`), p);
  }

  // un proyecto que entró a la lista recupera lo que la noche le había descartado por esa regla
  for (const { p, archivo } of existentes.values()) {
    if (p.estado !== 'descartada' || p.motivo_corto !== 'un_solo_proyecto' || !proyectos.claves || !proyectos.claves.has(nombreDeProyecto(p.repo))) continue;
    const { motivo_corto: _motivo, ...resto } = p;
    escribirJson(archivo, { ...resto, estado: 'pendiente' });
  }

  const despues = leerPropuestas(dirPropuestas) || new Map();
  const pendientes = [...despues].filter(([, x]) => x.p.estado === 'pendiente');
  const porHuella = await recomendarPendientes({ pendientes, anteriores: leerRecomendacionesAnteriores(ops), proyectos, noche, listo, sinModelo, llamar, env, today, limpio, sumar, fallo });
  escribirJson(path.join(ops, RECOMENDACIONES), { fecha: today, por_huella: porHuella });
  const recomendadas = { regla: 0, modelo: 0 };
  const sinRecomendacion = { fallo: 0, sin_modelo: 0, sin_llave: 0, tope: 0, sin_redaccion: 0, respuesta_ilegible: 0 };
  for (const e of Object.values(porHuella)) {
    if (e.recomendacion) recomendadas[e.recomendacion.por]++; else sinRecomendacion[e.sin_recomendacion]++;
  }
  Object.assign(informe, {
    estado: 'medido', motivo: null, candidatos: candidatos.length, ya_propuestas: yaPropuestas, nuevas: nuevasEscritas,
    en_espera: Object.values(enEsperaPor).reduce((a, b) => a + b, 0), en_espera_por: enEsperaPor, con_redaccion: conRedaccion,
    sin_redaccion: sinRedaccion, sin_completar: sinCompletar, descartadas, filtradas, recomendadas, sin_recomendacion: sinRecomendacion,
    pendientes_total: pendientes.length,
    tokens: tokens.informados ? { entrada: tokens.entrada, salida: tokens.salida } : null,
  });
  if (listo) informe.modelo.fallos = fallos;
  return terminar(0);
}

function parseArgs(argv) {
  const a = { noPush: false, json: false };
  const claves = { '--profile': 'profile', '--team-repos': 'teamRepos', '--mailbox': 'mailbox', '--operations': 'ops', '--today': 'today' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-push') a.noPush = true;
    else if (argv[i] === '--json') a.json = true;
    else if (claves[argv[i]]) a[claves[argv[i]]] = argv[++i];
    else return { error: `opción desconocida: ${argv[i]}` };
  }
  for (const k of ['profile', 'teamRepos', 'mailbox', 'ops', 'today']) if (!a[k]) return { error: `falta --${k === 'teamRepos' ? 'team-repos' : k}` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.today)) return { error: '--today tiene que ser AAAA-MM-DD' };
  return a;
}

module.exports = { correrNoche, findTeamCandidates, huella, leerEspejo, archivoDecidido, motivoDeRuido, MOTIVOS, RUTAS, PROPUESTAS, RECOMENDACIONES };

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  if (a.error) {
    process.stderr.write(`instinct-nightly: ${a.error}\nUso: node scripts/instincts/instinct-nightly.js --profile <team-profile.json> --team-repos <team-repos.json> --mailbox <espejo> --operations <árbol> --today <AAAA-MM-DD> [--no-push] [--json]\n`);
    process.exit(2);
  }
  correrNoche({ ...a, ops: path.resolve(a.ops), mailbox: path.resolve(a.mailbox) }).then(({ codigo, informe }) => {
    if (a.json) process.stdout.write(`${JSON.stringify(informe, null, 2)}\n`);
    else process.stdout.write(`aprendizajes ${informe.fecha}: ${informe.estado}${informe.motivo ? ` (${informe.motivo})` : ''}`
      + `${informe.estado === 'medido' ? ` · ${informe.nuevas} nuevas, ${informe.con_redaccion} con redacción, ${informe.en_espera} en espera` : ''}\n`);
    process.exitCode = codigo;
  }, (e) => {
    process.stderr.write(`instinct-nightly: error inesperado: ${String((e && e.message) || e).split('\n')[0].slice(0, 200)}\n`);
    process.exitCode = 1;
  });
}
