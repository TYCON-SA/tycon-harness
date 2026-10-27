'use strict';
/**
 * manual-checks — una persona marca cada criterio de la guía del tester como probado a mano, si la organización lo pide.
 *
 * La opción es `qa.manual_check` del perfil del equipo (`required` = se pide; `off` o sin valor = no). Vale sólo desde el
 * perfil: una variable o el archivo de la máquina los puede escribir el agente, que así se apagaría el freno.
 *
 * La marca es de quien probó: la aprueba en la ventana de permiso al correr `marker.js mark-tested`, o la firma en su
 * terminal (`--terminal`). La muestra y el juez de la respuesta quedan de cuando la marca salía de la conversación:
 *   · antes de `marker.js mark-tested --acs N,M` sin `--terminal`, la puerta Bash le muestra a la persona qué criterios va
 *     a marcar (`paraMostrar`); con la instalación mínima, el despachador de ediciones lo hace al escribirse
 *     `marca-pedida.json` ({ acs }) en la carpeta de la corrida (`handle`). Queda la constancia `manual-check-shown` en
 *     `gates.log`, donde el agente no escribe.
 *   · la respuesta de la persona valía si era posterior a esa muestra, nombraba cada criterio y no lo negaba (`juez`).
 *   · `marker.js mark-tested` deja un renglón por criterio en `<corrida>/manual-checks.jsonl` y su par `manual-check`, con
 *     la huella del renglón, en `gates.log`. Un renglón del archivo sin su par no cuenta (`validas`).
 *   · `freno(...)`: lo que mira el cierre (`complete-step prepare-commit`).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PEDIDO = 'marca-pedida.json';
const FILE = 'manual-checks.jsonl';

// La raíz del arnés de este archivo (scripts/lib → scripts → tycon-pipeline → skills → raíz), por su ruta real.
function raizDelArnes() {
  let aqui = __dirname;
  try { aqui = fs.realpathSync(__dirname); } catch (_e) { /* la ruta tal cual */ }
  return path.join(aqui, '..', '..', '..', '..');
}

/**
 * ¿La organización pide la marca? `{ prendida }`, más `motivo` si la configuración no se pudo leer: un control que se pidió
 * no se apaga por un error de escritura, así que se trata como prendida.
 */
function prendida({ env = process.env, home = os.homedir(), arnes = raizDelArnes() } = {}) {
  const lector = path.join(arnes, 'scripts', 'lib', 'tycon-config.js');
  let r;
  try { r = require(lector).cargar({ env, home, arnes }); } catch (e) {
    return { prendida: true, motivo: `no pude leer la configuración del arnés (${e.message}): la marca a mano se pide igual` };
  }
  const qa = (r.errores || []).find((e) => String(e.clave || '').startsWith('qa'));
  const otro = (r.errores || [])[0];
  if (qa || otro) {
    const e = qa || otro;
    return { prendida: true, motivo: `la configuración no se pudo leer (${e.archivo || '?'}${e.clave ? ` · ${e.clave}` : ''}: ${e.motivo}): la marca a mano se pide igual` };
  }
  const v = r.valores && r.valores.qa ? r.valores.qa.manual_check : undefined;
  return { prendida: v === 'required' };
}

const limpio = (t) => String(t || '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();

/** Los criterios de la historia, con el texto que lee una persona (la descripción de los pasos del tester, si la hay). */
function criterios(storyPath) {
  const qa = require('../qa-guide.js');
  const contenido = fs.readFileSync(storyPath, 'utf8');
  const acs = qa.parseAcsWithText(contenido);
  let pasos = {};
  try {
    const id = (contenido.match(/^story:\s*["']?([^"'\s#]+)/m) || [])[1];
    const clave = require('./evidence-key.js').keyOr(storyPath, id) || id;
    const dir = require('./qa-dir.js').qaDirFor(storyPath, [clave, id].filter(Boolean));
    const f = [clave, id].filter(Boolean).map((k) => path.join(dir, `${k}-pasos.md`)).find((x) => fs.existsSync(x));
    if (f) pasos = qa.parsePasos(fs.readFileSync(f, 'utf8'));
  } catch (_e) { /* sin pasos: el texto del criterio */ }
  // Los criterios de una tanda bloqueada no se prueban en esta corrida, igual que en la matriz.
  const bloqueados = new Set(require('./story-checks.js').parsePipelinesBlock(contenido)
    .filter((p) => p.status === 'blocked').flatMap((p) => p.acsPending));
  return acs.filter((a) => !bloqueados.has(a.n))
    .map((a) => ({ n: a.n, text: limpio((pasos[a.n] && pasos[a.n].desc) || a.text) }));
}

const ordenados = (acs) => [...new Set(acs.map(Number))].sort((a, b) => a - b);
const huella = (storyId, acs) => crypto.createHash('sha256').update(JSON.stringify([String(storyId), ordenados(acs)])).digest('hex').slice(0, 16);
const huellaMarca = (l) => crypto.createHash('sha256').update(JSON.stringify([Number(l.ac), String(l.story), String(l.quien || ''), String(l.cita || ''), String(l.ts || '')])).digest('hex').slice(0, 16);

// Los renglones de `gates.log` con ese nombre: `{ lineas, error? }`. Que falte es «ninguno»; no poder leerlo, un error.
function leerGates(stateDir, nombre) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { lineas: [] } : { lineas: [], error: (e && (e.code || e.message)) || 'error' };
  }
  const lineas = [];
  for (const l of raw.split('\n')) {
    if (!l.includes(`"${nombre}"`)) continue;
    try { const g = JSON.parse(l); if (g && g.name === nombre && !Number.isNaN(Date.parse(g.ts))) lineas.push(g); } catch (_e) { /* renglón roto: no cuenta */ }
  }
  return { lineas };
}

/** La muestra más nueva de esos criterios (sesión, historia y la misma lista), null, o `{ error }`. */
function mostrado({ stateDir, sessionId, storyId, acs }) {
  const g = leerGates(stateDir, 'manual-check-shown');
  if (g.error) return { error: g.error };
  const sha = huella(storyId, acs);
  const hits = g.lineas.filter((x) => x.sessionId === sessionId && String(x.story) === String(storyId) && x.sha === sha);
  if (!hits.length) return null;
  return hits.reduce((a, b) => (Date.parse(b.ts) > Date.parse(a.ts) ? b : a));
}

// Lo que tumba la marca: que diga que NO lo probó (o que falta probarlo), o que la prueba salió mal. Una negación que no
// es de la prueba («sin problemas», «no hubo problemas», «nunca falló») no la tumba: medido en el pase adversarial,
// rechazaba las confirmaciones de verdad.
const PROBAR = '(?:prob(?:[eé]|ad[oa]s?|amos|aron|[oó]|ar|ando|aste)|revis(?:[eé]|ad[oa]s?|amos|aron|[oó]|ar|ando|aste)|marc(?:ad[oa]s?|ar|amos|aron|[oó]|ues|uen|alo|alos))(?![\\p{L}])';
const RE_NO_PROBO = new RegExp(`(?<![\\p{L}])(?:(?:no|ni|nunca|jam[aá]s|tampoco)\\s+(?:\\p{L}+\\s+){0,2}?${PROBAR}|sin\\s+${PROBAR}|faltan?\\s+(?:\\p{L}+\\s+){0,1}?${PROBAR})`, 'iu');
const RE_FALLA = /(?<![\p{L}])(fall[oóa]\p{L}*|no\s+(?:anda|funciona|funcion[oó]|pasa|pas[oó]|sirve))(?![\p{L}])/giu;
const RE_ANTES_SIN_FALLA = /(?:no|nunca|jam[aá]s|sin|ni)\s+$/iu;
function noLaProbo(texto) {
  const t = String(texto || '');
  if (RE_NO_PROBO.test(t)) return true;
  for (const m of t.matchAll(RE_FALLA)) {
    // «nunca falló», «sin fallas», «no falló»: no es una falla
    if (/^fall/i.test(m[1]) && RE_ANTES_SIN_FALLA.test(t.slice(0, m.index))) continue;
    return true;
  }
  return false;
}
const RE_PROBO = new RegExp(`(?<![\\p{L}])${PROBAR}`, 'iu');

/**
 * Los números de criterio que nombra un texto: «criterio 2», «criterios 2 y 3», «los criterios 2, 3, y 4», «el criterio 2
 * y el 3». Después de «criterio(s)» sigue la lista mientras haya números unidos por coma, «y», «e», «el» o «criterio».
 */
function numerosNombrados(texto) {
  const out = new Set();
  const t = String(texto || '');
  const re = /criterios?(?![\p{L}])/giu;
  let m;
  while ((m = re.exec(t))) {
    let resto = t.slice(m.index + m[0].length);
    for (;;) {
      const p = /^\s*(?:(?:,|y|e|el|la|tambi[eé]n|criterios?)(?![\p{L}])\s*)*(\d+)(?![\d])/iu.exec(resto);
      if (!p) break;
      out.add(Number(p[1]));
      resto = resto.slice(p[0].length);
    }
  }
  return out;
}

/** `(texto) => null | motivo`: la respuesta dice que probó a mano y nombra cada criterio pedido, sin negarlo. */
function juez(acs) {
  const pedidos = ordenados(acs);
  const forma = pedidos.length > 1 ? `«probé a mano los criterios ${pedidos.slice(0, -1).join(', ')} y ${pedidos[pedidos.length - 1]}»` : `«probé a mano el criterio ${pedidos[0]}»`;
  const juzgar = (texto) => {
    const t = String(texto || '');
    const nombrados = numerosNombrados(t);
    const falta = pedidos.find((n) => !nombrados.has(n));
    if (falta !== undefined) return `la respuesta no nombra el criterio ${falta}: una respuesta genérica no marca. Para marcarlo: ${forma}`;
    if (noLaProbo(t)) return `la respuesta dice que no lo probó o que falló («no lo probé», «falta probar», «falló»…): no marca. Para marcarlo: ${forma}`;
    if (!RE_PROBO.test(t)) return `la respuesta nombra los criterios pero no dice que los probó a mano: ${forma}`;
    return null;
  };
  // ¿un mensaje posterior se echa atrás? (nombra uno de esos criterios y dice que no lo probó o que falló)
  juzgar.retracta = (texto) => pedidos.some((n) => numerosNombrados(texto).has(n)) && noLaProbo(texto);
  return juzgar;
}

/** El bloque que ve la persona. */
function bloque({ storyId, lista }) {
  const ns = lista.map((c) => c.n);
  const forma = ns.length > 1 ? `«probé a mano los criterios ${ns.slice(0, -1).join(', ')} y ${ns[ns.length - 1]}»` : `«probé a mano el criterio ${ns[0]}»`;
  return [
    `Vas a marcar como probado a mano, en la historia ${storyId}:`,
    ...lista.map((c) => `  · Criterio ${c.n} — ${c.text}`),
    `Para confirmarlo, contestá nombrándolo: ${forma}. Un «dale» suelto no lo marca.`,
  ].join('\n');
}

function leerMarcador(stateDir, sessionId) {
  let txt;
  try { txt = fs.readFileSync(path.join(stateDir, 'active', `${String(sessionId).replace(/[\\/]/g, '_')}.json`), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(txt);
}
function storyDe(marker) {
  const repo = marker.repoPath || process.cwd();
  if (!marker.storyPath) return null;
  const p = path.isAbsolute(marker.storyPath) ? marker.storyPath : path.join(repo, marker.storyPath);
  return fs.existsSync(p) ? p : null;
}
function carpetaDeLaCorrida(marker) {
  return require('../pipeline.js').resolveRunDir(marker.repoPath || process.cwd(), String(marker.storyId), false, storyDe(marker) || undefined);
}

// Arma la muestra, si corresponde. La constancia la escribe quien muestra, después de mostrar (`anotar`).
function preparar({ sessionId, stateDir, home = os.homedir(), acs, arnes }) {
  const pedidos = ordenados((acs || []).filter((n) => Number.isInteger(Number(n)) && Number(n) > 0));
  if (!pedidos.length || !sessionId) return null;
  const marker = leerMarcador(stateDir, sessionId);
  if (!marker || !marker.storyId) return null;
  if (!prendida({ home, ...(arnes ? { arnes } : {}) }).prendida) return null;
  if (!require('./person-ok.js').leerConversacion({ sesion: sessionId, home }).legible) return null;
  const storyId = String(marker.storyId);
  const ya = mostrado({ stateDir, sessionId, storyId, acs: pedidos });
  if (ya && !ya.error) return null;
  const story = storyDe(marker);
  if (!story) return null;
  const todos = criterios(story);
  const lista = pedidos.map((n) => todos.find((c) => c.n === n) || { n, text: '(este número no está entre los criterios de la historia)' });
  const constancia = { sessionId, repoPath: marker.repoPath || null, name: 'manual-check-shown', status: 'ok', story: storyId, acs: pedidos, sha: huella(storyId, pedidos) };
  return {
    systemMessage: bloque({ storyId, lista }),
    anotar: () => {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), ...constancia })}\n`, 'utf8');
    },
  };
}

/** Los `marker.js mark-tested --acs …` del comando, sin los que van por `--terminal` ni los que llevan variables. */
function pedidosDelComando(command) {
  const w = require('./critical-display.js').palabras(command);
  const out = [];
  for (let i = 0; i < w.length; i++) {
    if (!/(^|[\\/])marker\.js$/.test(w[i]) || w[i + 1] !== 'mark-tested') continue;
    const args = [];
    for (let j = i + 2; j < w.length && w[j] !== '\u0000'; j++) args.push(w[j]);
    if (args.includes('--terminal')) continue;
    const k = args.indexOf('--acs');
    const v = k >= 0 ? String(args[k + 1] || '') : '';
    if (!v || /[$`]/.test(v)) continue;
    out.push(v.split(/[,\s]+/).filter(Boolean).map(Number));
  }
  return out;
}

function paraMostrar({ command, sessionId, stateDir, home = os.homedir(), arnes }) {
  const listos = pedidosDelComando(command).map((acs) => preparar({ sessionId, stateDir, home, acs, arnes })).filter(Boolean);
  if (!listos.length) return null;
  return { systemMessage: listos.map((r) => r.systemMessage).join('\n\n'), anotar: () => { for (const r of listos) r.anotar(); } };
}

const mismaRuta = (a, b) => path.resolve(String(a)).replace(/\\/g, '/').toLowerCase() === path.resolve(String(b)).replace(/\\/g, '/').toLowerCase();

function handle(event, opts = {}) {
  const tool = event && event.tool_name;
  if (tool !== 'Write' && tool !== 'Edit') return null;
  const archivo = event.tool_input && event.tool_input.file_path;
  if (!archivo || path.basename(String(archivo)) !== PEDIDO) return null;
  const sessionId = require('./session-id.js').resolveSessionId(event.session_id);
  const stateDir = opts.stateDir || require('./story-gate-io.js').DEFAULT_STATE_DIR;
  const marker = leerMarcador(stateDir, sessionId);
  if (!marker || !marker.storyId) return null;
  const runDir = carpetaDeLaCorrida(marker);
  if (!runDir || !mismaRuta(archivo, path.join(runDir, PEDIDO))) return null;
  let p;
  try { p = JSON.parse(fs.readFileSync(path.join(runDir, PEDIDO), 'utf8')); } catch (e) {
    return { reminder: `${PEDIDO} no se pudo leer como JSON (${e.message}): tiene que traer { "acs": [números de criterio] }.` };
  }
  if (!p || !Array.isArray(p.acs)) return { reminder: `${PEDIDO} tiene que ser un objeto con { "acs": [números de criterio] }.` };
  const r = preparar({ sessionId, stateDir, home: opts.home, arnes: opts.arnes, acs: p.acs });
  return r ? { systemMessage: r.systemMessage, alMostrar: r.anotar } : null;
}

function leer(runDir) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(runDir, FILE), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { lineas: [] }; return { lineas: [], error: e.code || e.message }; }
  const lineas = [];
  for (const l of raw.split('\n')) { if (!l.trim()) continue; try { lineas.push(JSON.parse(l)); } catch (_e) { /* renglón roto: no cuenta */ } }
  return { lineas };
}

function anotar(runDir, renglones) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.appendFileSync(path.join(runDir, FILE), renglones.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
}

/** Las marcas que valen (las que tienen su par en `gates.log`), por criterio, y las que no. */
function validas({ runDir, stateDir, storyId }) {
  const l = leer(runDir);
  const g = leerGates(stateDir, 'manual-check');
  const error = l.error || g.error || null;
  const pares = new Set(g.lineas.filter((x) => String(x.story) === String(storyId)).map((x) => x.huella));
  const marcas = {};
  const sinPar = new Set();
  for (const r of l.lineas) {
    if (String(r.story) !== String(storyId)) continue;
    if (pares.has(huellaMarca(r))) marcas[Number(r.ac)] = r; else sinPar.add(Number(r.ac));
  }
  for (const n of Object.keys(marcas)) sinPar.delete(Number(n));
  return { marcas, sinPar: [...sinPar].sort((a, b) => a - b), error };
}

/**
 * Lo que mira el cierre. `{ status: 'no-ui' | 'off' | 'ok' | 'blocked', faltan, mensaje: [renglones] }`.
 * Corre con la misma condición de pantalla que la guía del tester (`esPantalla`).
 */
function freno({ storyPath, storyId, runDir, stateDir, esPantalla, arnes, home }) {
  if (!esPantalla) return { status: 'no-ui', faltan: [], mensaje: [] };
  const p = prendida({ ...(home ? { home } : {}), ...(arnes ? { arnes } : {}) });
  if (!p.prendida) return { status: 'off', faltan: [], mensaje: [] };
  const todos = criterios(storyPath);
  // sin criterios legibles no hay qué marcar, pero tampoco se puede decir que estén marcados: frena y lo dice
  if (!todos.length) return { status: 'blocked', faltan: [], mensaje: ['Tu organización pide que una persona marque cada criterio como probado a mano, y no encontré criterios en la historia para marcar: revisá la sección «Acceptance Criteria» (numerada, 1. 2. 3.).'] };
  const v = validas({ runDir, stateDir, storyId });
  const faltan = todos.filter((c) => !v.marcas[c.n]);
  if (!faltan.length && !v.error) return { status: 'ok', faltan: [], mensaje: [] };
  const ns = faltan.map((c) => c.n);
  const mensaje = [
    `Tu organización pide que una persona marque cada criterio como probado a mano. Falta: ${faltan.map((c) => `criterio ${c.n} — ${c.text.replace(/\.$/, '')}`).join('; ')}.`,
    ...(p.motivo ? [`  (${p.motivo})`] : []),
    ...(v.error ? [`  No pude leer las marcas (${v.error}): sin poder leerlas, ninguna cuenta.`] : []),
    ...(v.sinPar.length ? [`  Criterio${v.sinPar.length > 1 ? 's' : ''} ${v.sinPar.join(', ')}: marca sin muestra previa, no cuenta (el renglón no lo dejó el arnés).`] : []),
    '  Cómo se marca: la persona prueba cada criterio con la guía y lo aprueba en la ventana de permiso al correr',
    `    marker.js mark-tested --acs ${ns.join(',')} --approved-by "<quién>"`,
    '  O lo firma en su terminal con --terminal. El agente no puede marcarlo.',
  ];
  return { status: 'blocked', faltan: ns, mensaje };
}

module.exports = { PEDIDO, FILE, prendida, criterios, huella, huellaMarca, mostrado, juez, bloque, pedidosDelComando, paraMostrar, handle, leer, anotar, validas, freno };
