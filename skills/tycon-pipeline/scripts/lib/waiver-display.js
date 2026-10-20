'use strict';
/**
 * waiver-display — el criterio que no se puede probar en vivo se lo muestra el arnés a la persona antes de que lo firme,
 * y el ok vale si responde a eso.
 *
 * Una cita de la persona, de esta corrida, no dice qué firmó: un «dale» escrito por otra cosa firmaría un criterio que
 * nunca vio. Por eso el arnés muestra cada criterio en pantalla (`systemMessage`, como el crítico en
 * lib/critical-display.js) con su texto, por qué no se puede probar en vivo y qué prueba lo cubre, y deja la constancia
 * `ac-shown` en `gates.log`, donde el agente no escribe.
 *
 *   · `paraMostrar({ command, sessionId, stateDir, home })`: la puerta Bash, antes de `marker.js runtime-waiver <spec>
 *     --acs n`. Devuelve `{ systemMessage, anotar }` o null.
 *   · `handle(event, opts)`: el despachador de ediciones (la instalación mínima no trae la puerta Bash). Un Write o Edit
 *     de `firma-pedida.json` ({ "acs": [n] }) en la carpeta de la corrida abierta de la sesión.
 *   · `mostrado(...)`: la constancia más nueva de ese criterio con esa declaración, o null. La lee `runtime-waiver`.
 *   · `juez(acs)`: `(texto) => null | motivo`. ¿El mensaje nombra cada criterio y no dice que no lo firma?
 *
 * Sin la conversación legible (otra herramienta) no se muestra ni se anota: no se sabe si el aviso se ve.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PEDIDO = 'firma-pedida.json';

function leerGates(stateDir) {
  let txt;
  try { txt = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; return { error: e.message }; }
  const out = [];
  for (const l of txt.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (_) { /* un renglón roto no tapa los demás */ } }
  return out;
}

/** La constancia más nueva de ese criterio, de esa sesión e historia, con esa declaración (huella), o null. */
function mostrado({ stateDir, sessionId, storyId, ac, sha }) {
  const g = leerGates(stateDir);
  if (!Array.isArray(g)) return g;
  const del = g.filter((x) => x.name === 'ac-shown' && x.sessionId === sessionId && String(x.story) === String(storyId) && Number(x.ac) === Number(ac) && x.sha === sha);
  return del.length ? del[del.length - 1] : null;
}

// lo que no es un sí: una negación antes de «firmar» (con «quiero», «voy a», «puedo» en el medio) o una pregunta
const RE_NIEGA = /(?<![\p{L}\p{N}])(?:no|ni|nunca|jam[aá]s|todav[ií]a\s+no)\s+(?:(?:quiero|voy\s+a|puedo|pienso|vamos\s+a)\s+)?(?:(?:lo|la|los|las|te|se)\s+)?firm/iu;
// el sí: «firmo», «firmamos», «firmalo», «lo firmo»… en primera persona o como orden
const RE_FIRMA = /(?<![\p{L}\p{N}])(?:firmo|firmamos|f[ií]rmalo|f[ií]rmalos|firmá|firmalo|lo\s+firmo|los\s+firmo)(?![\p{L}\p{N}])/iu;

/**
 * La huella de lo que se le mostró a la persona: el texto del criterio, por qué no se puede probar en vivo y qué lo
 * cubre. Si cambia cualquiera de los tres, la muestra ya no vale para la firma.
 */
function huella(text, reason, coveredBy) {
  return require('crypto').createHash('sha256').update(JSON.stringify([String(text ?? '').trim(), String(reason ?? '').trim(), String(coveredBy ?? '').trim()])).digest('hex').slice(0, 16);
}

/** ¿El mensaje dice que firma («firmo …») nombrando cada criterio («AC 3», «criterio 3», «#3»), sin negarlo ni preguntar? */
function juez(acs) {
  const lista = [...new Set((acs || []).map(Number))];
  const nombra = (t, n) => new RegExp(`(?<![\\p{L}\\p{N}])(?:ac|criterio)\\s*(?:n[°º.]?\\s*)?#?\\s*${n}(?![\\p{N}])`, 'iu').test(t) || new RegExp(`#${n}(?![\\p{N}])`).test(t);
  const f = (texto) => {
    const t = String(texto || '');
    if (RE_NIEGA.test(t)) return 'el mensaje dice que no lo firma';
    if (/[¿?]/.test(t)) return 'el mensaje pregunta: una pregunta no es un ok';
    if (!RE_FIRMA.test(t)) return `el mensaje no dice que lo firma: tiene que decir, por ejemplo, «firmo el AC ${lista[0]}»`;
    const faltan = lista.filter((n) => !nombra(t, n));
    if (faltan.length) return `el ok no nombra ${faltan.map((n) => `el AC ${n}`).join(' ni ')}: tiene que decir, por ejemplo, «firmo el AC ${faltan[0]}»`;
    return null;
  };
  f.retracta = (texto) => RE_NIEGA.test(String(texto || ''));
  return f;
}

function bloque({ storyId, criterios }) {
  const formas = criterios.map((c) => `«firmo el AC ${c.ac}»`).join(' y ');
  return [
    `Te piden firmar ${criterios.length === 1 ? 'un criterio' : `${criterios.length} criterios`} de la historia ${storyId} que no se ${criterios.length === 1 ? 'puede' : 'pueden'} probar en vivo (te lo muestra el arnés):`,
    ...criterios.flatMap((c) => [
      `  AC ${c.ac}: ${c.text || '(sin texto en la historia)'}`,
      `    Por qué no se puede probar en vivo: ${c.reason || '(sin razón declarada)'}`,
      `    Qué lo cubre: ${c.coveredBy || '(ninguna prueba declarada)'}`,
    ]),
    'Un criterio firmado cuenta como probado sin haberlo corrido contra la aplicación.',
    `Si estás de acuerdo, contestá ${formas}. Un «dale» o un «apruebo» suelto no lo firma.`,
  ].join('\n');
}

function leerMarcador(stateDir, sessionId) {
  let txt;
  try { txt = fs.readFileSync(path.join(stateDir, 'active', `${String(sessionId).replace(/[\\/]/g, '_')}.json`), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(txt);
}

/** Los datos de cada criterio pedido que está pendiente de firma (declarado imposible), con la huella de su declaración. */
function criteriosDe(storyPath, acs) {
  const rm = require('../runtime-matrix.js');
  const waiver = require('./runtime-waiver.js');
  const matrix = rm.compute({ storyPath });
  if (matrix.structuralError) return { error: matrix.structuralError };
  const pend = new Set(matrix.notVerifiable || []);
  const lista = [];
  for (const n of acs) {
    const a = matrix.perAc && matrix.perAc[n];
    if (!a || !pend.has(n)) continue;
    lista.push({ ac: n, text: a.text, reason: a.declReason, coveredBy: a.coveredBy, sha: huella(a.text, a.declReason, a.coveredBy) });
  }
  return { matrix, lista };
}

/**
 * ¿Es ésta la historia de la corrida abierta? Sólo se muestra (y sólo se firma) la del marcador: una copia en otra ruta,
 * con el mismo número y otro texto, mostraría a la persona algo distinto de lo que después se firma.
 */
function esLaDelMarcador(storyPath, marker) {
  if (!marker || !marker.storyPath) return false;
  const repo = marker.repoPath || process.cwd();
  const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
  const delMarcador = path.isAbsolute(marker.storyPath) ? marker.storyPath : path.join(repo, marker.storyPath);
  return real(storyPath) === real(delMarcador);
}

// Arma la muestra de los criterios pedidos, si corresponde. La constancia la escribe quien muestra, después de mostrar.
function preparar({ sessionId, stateDir, home = os.homedir(), storyPath, acs }) {
  if (!sessionId || !storyPath || !acs || !acs.length) return null;
  const marker = leerMarcador(stateDir, sessionId);
  if (!marker || !marker.storyId) return null;
  if (!require('./person-ok.js').leerConversacion({ sesion: sessionId, home }).legible) return null;
  const abs = path.isAbsolute(storyPath) ? storyPath : path.join(marker.repoPath || process.cwd(), storyPath);
  if (!fs.existsSync(abs) || !esLaDelMarcador(abs, marker)) return null;
  const c = criteriosDe(abs, acs);
  if (c.error) return { reminder: `no pude armar los criterios para mostrarlos (la matriz no computa: ${c.error}): así no se pueden firmar hasta arreglarlo.` };
  const storyId = String(c.matrix.sid || marker.storyId);
  const faltan = c.lista.filter((x) => { const v = mostrado({ stateDir, sessionId, storyId, ac: x.ac, sha: x.sha }); return !v || v.error; });
  if (!faltan.length) return null;
  return {
    systemMessage: bloque({ storyId, criterios: faltan }),
    anotar: () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const ts = new Date().toISOString();
      const renglones = faltan.map((x) => JSON.stringify({ ts, sessionId, repoPath: marker.repoPath || null, name: 'ac-shown', status: 'ok', story: storyId, ac: x.ac, sha: x.sha }));
      fs.appendFileSync(path.join(stateDir, 'gates.log'), `${renglones.join('\n')}\n`, 'utf8');
    },
  };
}

/**
 * Los `marker.js runtime-waiver <spec> --acs n,m` del comando que piden el ok en el chat (los de la terminal no llevan
 * `--acs`). Uno con variables o sustituciones de la terminal no entra: su valor no se sabe hasta que corre.
 */
function pedidosDelComando(command) {
  const w = require('./critical-display.js').palabras(command);
  const out = [];
  for (let i = 0; i < w.length; i++) {
    if (!/(^|[\\/])marker\.js$/.test(w[i]) || w[i + 1] !== 'runtime-waiver') continue;
    const args = [];
    for (let j = i + 2; j < w.length && w[j] !== '\u0000'; j++) args.push(w[j]);
    const k = args.indexOf('--acs');
    const storyPath = args[0] && !/^--/.test(args[0]) ? args[0] : '';
    const acsTxt = k >= 0 ? String(args[k + 1] || '') : '';
    if (!storyPath || !acsTxt || /[$`]/.test(storyPath + acsTxt)) continue;
    const acs = [...new Set(acsTxt.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0))];
    if (acs.length) out.push({ storyPath, acs });
  }
  return out;
}

function paraMostrar({ command, sessionId, stateDir, home = os.homedir() }) {
  const listos = pedidosDelComando(command).map((p) => preparar({ sessionId, stateDir, home, ...p })).filter((r) => r && r.systemMessage);
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
  let marker;
  try { marker = leerMarcador(stateDir, sessionId); } catch (e) { return { reminder: `no pude leer el marcador de la corrida (${e.message}): no puedo mostrar los criterios para firmar.` }; }
  if (!marker || !marker.storyId) return null;
  if (!marker.storyPath) return { reminder: `el marcador de la corrida no trae la ruta de la historia: no puedo mostrar los criterios de ${PEDIDO}.` };
  const repo = marker.repoPath || process.cwd();
  const story = path.isAbsolute(marker.storyPath) ? marker.storyPath : path.join(repo, marker.storyPath);
  const runDir = require('../pipeline.js').resolveRunDir(repo, String(marker.storyId), false, fs.existsSync(story) ? story : undefined);
  if (!runDir || !mismaRuta(archivo, path.join(runDir, PEDIDO))) return null;
  let p;
  try { p = JSON.parse(fs.readFileSync(path.join(runDir, PEDIDO), 'utf8')); } catch (e) {
    return { reminder: `${PEDIDO} no se pudo leer como JSON (${e.message}): tiene que traer { "acs": [n] }.` };
  }
  const acs = p && Array.isArray(p.acs) ? [...new Set(p.acs.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
  if (!acs.length) return { reminder: `${PEDIDO} tiene que ser un objeto con { "acs": [n] }: los números de los criterios a firmar.` };
  const r = preparar({ sessionId, stateDir, home: opts.home, storyPath: story, acs });
  if (r && r.reminder) return { reminder: r.reminder };
  return r ? { systemMessage: r.systemMessage, alMostrar: r.anotar } : null;
}

module.exports = { PEDIDO, mostrado, juez, huella, bloque, criteriosDe, esLaDelMarcador, pedidosDelComando, paraMostrar, handle };
