'use strict';
/**
 * waiver-display — el criterio que no se puede probar en vivo se lo muestra el arnés a la persona antes de que lo firme
 * en la ventana de permiso.
 *
 * La ventana muestra el comando, no el criterio: sin el aviso, la persona firmaría un criterio que nunca vio. Por eso el
 * arnés muestra cada criterio en pantalla (`systemMessage`, como el crítico en
 * lib/critical-display.js) con su texto, por qué no se puede probar en vivo y qué prueba lo cubre, y deja la constancia
 * `ac-shown` en `gates.log`, donde el agente no escribe.
 *
 *   · `paraMostrar({ command, sessionId, stateDir, home })`: la puerta Bash, antes de `marker.js runtime-waiver <spec>
 *     --acs n`. Devuelve `{ systemMessage, anotar }` o null.
 *   · `handle(event, opts)`: el despachador de ediciones (la instalación mínima no trae la puerta Bash). Un Write o Edit
 *     de `firma-pedida.json` ({ "acs": [n] }) en la carpeta de la corrida abierta de la sesión.
 *   · `mostrado(...)`: la constancia más nueva de ese criterio con esa declaración, o null. La lee `runtime-waiver`.
 *
 * Se muestra siempre, con la conversación legible o sin ella: la firma no sale de la conversación sino de la ventana de
 * permiso o de la terminal.
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

/**
 * La huella de lo que se le mostró a la persona: el texto del criterio, por qué no se puede probar en vivo y qué lo
 * cubre. Si cambia cualquiera de los tres, la muestra ya no vale para la firma.
 */
// Con un criterio con cota, lo medido entra como cuarto dato: si cambia la medición, el aviso se vuelve a mostrar. Sin
// cota no entra, y la huella de un criterio sin marca es la de siempre.
function huella(text, reason, coveredBy, medida) {
  const datos = [String(text ?? '').trim(), String(reason ?? '').trim(), String(coveredBy ?? '').trim()];
  if (medida) datos.push(String(medida).trim());
  return require('crypto').createHash('sha256').update(JSON.stringify(datos)).digest('hex').slice(0, 16);
}

/**
 * La pregunta por criterio de `marker.js runtime-waiver` en la terminal: el texto del criterio primero (es lo que se
 * aprueba saltear), la razón, la prueba que lo cubre y, en uno con cota, lo medido y la cota.
 */
function preguntaDeTerminal({ ac, texto, reason, cov, medida }) {
  return `\n──────── AC #${ac} ────────\n` +
    `QUÉ DICE EL AC:\n  ${texto ? texto : '(no se pudo citar del spec — abrí la story antes de aprobar)'}\n\n` +
    `Por qué NO se puede verificar corriendo la app:\n  ${reason}\n` +
    `Cubierto por (test que ya corrió): ${cov}\n` +
    (medida ? `Lo medido: ${medida}\n` : '') + '\n' +
    `¿Aprobás saltar la verificación POR-LA-APP de AC#${ac}? (si / no) > `;
}

function bloque({ storyId, criterios }) {
  // un renglón por criterio, más el encabezado y dónde se aprueba: Claude Code antepone su rótulo a cada renglón del aviso
  return [
    `Te piden firmar ${criterios.length === 1 ? 'un criterio' : `${criterios.length} criterios`} de la historia ${storyId} que no se ${criterios.length === 1 ? 'puede' : 'pueden'} probar en vivo (te lo muestra el arnés). Un criterio firmado cuenta como probado sin haberlo corrido contra la aplicación.`,
    ...criterios.map((c) => `AC ${c.ac}: ${c.text || '(sin texto en la historia)'} · Por qué no se puede probar en vivo: ${c.reason || '(sin razón declarada)'} · Qué lo cubre: ${c.coveredBy || '(ninguna prueba declarada)'}${c.medida ? ` · Lo medido: ${c.medida}` : ''}`),
    'Si estás de acuerdo, aprobalo en la ventana de permiso que sale a continuación o, donde no sale, en el cuadro de opciones; si no, elegí «No». Lo firma esa aprobación, no otra respuesta en el chat.',
  ].join('\n');
}

function leerMarcador(stateDir, sessionId) {
  let txt;
  try { txt = fs.readFileSync(path.join(stateDir, 'active', `${String(sessionId).replace(/[\\/]/g, '_')}.json`), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(txt);
}

/**
 * La matriz de una firma: la de «Preparar el pull request» (la tanda, la lista de cambios y el repo del código del marcador),
 * para que los criterios sin correr de las otras tandas no nieguen la firma de uno de la tanda. La tanda vale sólo si el
 * marcador es de esa misma historia; con el de otra, o sin marcador, mide todas.
 *
 * Sin marcador, `batch` (el `--batch` de una firma sin corrida abierta) mide esa tanda como la mide una corrida con
 * tanda, con lo que cambió la rama en lugar de lo que cambió la corrida (`cambiosDeLaRama`). El guion y el cuadro la
 * calculan acá: así lo que se muestra es lo que se firma.
 *
 * `acs`: los criterios que se van a mostrar. Con ellos, la matriz mide sólo esos (`parcial`): el freno la arma antes de
 * la ventana y tiene que alcanzar a decidir dentro de su reloj. Vale junto con la tanda: la tanda decide qué criterios
 * entran y `acs` qué humos se miden, y el veredicto de un criterio pedido sale igual que en la matriz de la tanda.
 */
function matrixForSignature(storyPath, marker, { batch = null, acs = null, gatesLogPath = null } = {}) {
  const rm = require('../runtime-matrix.js');
  // `gatesLogPath`: el gates.log de la casa de quien arma la firma, donde están los espejos de sus humos; sin él, el de
  // la casa del proceso
  const solo = { ...(Array.isArray(acs) && acs.length ? { soloAcs: acs } : {}), ...(gatesLogPath ? { gatesLogPath } : {}) };
  if (!marker && batch != null) return rm.compute({ storyPath, batch: String(batch), changed: cambiosDeLaRama(storyPath), ...solo });
  const delMarcador = marker && marker.storyPath
    ? { ...marker, storyPath: path.isAbsolute(marker.storyPath) ? marker.storyPath : path.join(marker.repoPath || process.cwd(), marker.storyPath) }
    : null;
  const op = rm.opcionesDeTandaDelMarcador(delMarcador, storyPath);
  return rm.compute({ storyPath, ...(op.batch ? op : {}), ...solo });
}

/**
 * Lo que cambió la rama de la historia: desde su punto en común con main, o lo sin commitear si no hay main. Hace de la
 * lista de cambios de la corrida cuando no hay corrida: un archivo que la rama tocó y la historia ata sólo a otra tanda
 * devuelve sus criterios. null sin repo git o si git no contesta: la matriz mide todas las tandas y lo dice.
 */
function cambiosDeLaRama(storyPath) {
  const repo = require('../runtime-matrix.js').discoverRepoRoot(storyPath);
  if (!repo) return null;
  const punto = require('./frozen-tree.js').puntoComunConMain(repo);
  return require('./ui-signal.js').changedFiles(repo, punto.sha || undefined);
}

/**
 * La pista para firmar por terminal la historia de una corrida con tanda: `--for-session` con la sesión de cada marcador
 * abierto de esa historia que tiene tanda, o el lugar de la sesión si no hay ninguno. null si la historia no tiene tandas.
 */
function pistaDeSesion({ stateDir, storyPath }) {
  let tandas = [];
  try { tandas = require('./story-checks.js').parsePipelinesBlock(fs.readFileSync(storyPath, 'utf8')); } catch (_) { tandas = []; }
  if (!tandas.length) return null;
  const sesiones = [];
  let nombres = [];
  try { nombres = fs.readdirSync(path.join(stateDir, 'active')).filter((f) => f.endsWith('.json')); } catch (_) { nombres = []; }
  for (const f of nombres) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(stateDir, 'active', f), 'utf8'));
      if (m && m.batch && esLaDelMarcador(storyPath, m)) sesiones.push(String(m.sessionId || f.replace(/\.json$/, '')));
    } catch (_) { /* un marcador ilegible no da pista */ }
  }
  const quien = sesiones.length ? sesiones.join(' o ') : '<la sesión de la corrida>';
  return `Si la corrida es de una tanda, la firma por terminal mide esa tanda con --for-session ${quien}.`;
}

/**
 * Los datos de cada criterio pedido que está pendiente de firma (declarado imposible), con la huella de su declaración.
 * Sin matriz calculada, la de los criterios pedidos: la ventana de safety-guard la arma dentro del reloj de su freno.
 * Sin criterios pedidos, la entera.
 */
function criteriosDe(storyPath, acs, calculada = null, { gatesLogPath = null } = {}) {
  const matrix = calculada || require('../runtime-matrix.js').compute({ storyPath, ...(acs.length ? { soloAcs: acs } : {}), ...(gatesLogPath ? { gatesLogPath } : {}) });
  if (matrix.structuralError) return { error: matrix.structuralError };
  const pend = new Set(matrix.notVerifiable || []);
  const lista = [];
  for (const n of acs) {
    const a = matrix.perAc && matrix.perAc[n];
    if (!a || !pend.has(n)) continue;
    // en un criterio con cota, lo medido y la cota: la persona sabe qué está perdonando (null sin marca)
    const medida = require('../runtime-matrix.js').textoDeMedida(a);
    lista.push({ ac: n, text: a.text, reason: a.declReason, coveredBy: a.coveredBy, ...(medida ? { medida } : {}),
      sha: huella(a.text, a.declReason, a.coveredBy, medida) });
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
function preparar({ sessionId, stateDir, storyPath, acs }) {
  if (!sessionId || !storyPath || !acs || !acs.length) return null;
  const marker = leerMarcador(stateDir, sessionId);
  if (!marker || !marker.storyId) return null;
  const abs = path.isAbsolute(storyPath) ? storyPath : path.join(marker.repoPath || process.cwd(), storyPath);
  if (!fs.existsSync(abs) || !esLaDelMarcador(abs, marker)) return null;
  const c = criteriosDe(abs, acs, matrixForSignature(abs, marker, { acs }));
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
 * Los `marker.js runtime-waiver <spec> --acs n,m` del comando que piden la firma en la ventana (los de la terminal no llevan
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
    // pedida para otra sesión, la muestra es la de esa sesión: su marcador y su constancia
    const f = args.indexOf('--for-session');
    const paraSesion = f >= 0 ? String(args[f + 1] || '') : null;
    if (paraSesion !== null && !/^[\w-]+$/.test(paraSesion)) continue;
    if (acs.length) out.push({ storyPath, acs, ...(paraSesion ? { paraSesion } : {}) });
  }
  return out;
}

function paraMostrar({ command, sessionId, stateDir, home = os.homedir() }) {
  const listos = pedidosDelComando(command).map(({ paraSesion, ...p }) => preparar({ sessionId: paraSesion || sessionId, stateDir, home, ...p })).filter((r) => r && r.systemMessage);
  if (!listos.length) return null;
  return { systemMessage: listos.map((r) => r.systemMessage).join('\n'), anotar: () => { for (const r of listos) r.anotar(); } };
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
  const runDir = require('../pipeline.js').resolveRunDir(repo, String(marker.storyId), false, fs.existsSync(story) ? story : undefined, { marker });
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

module.exports = { PEDIDO, mostrado, huella, bloque, preguntaDeTerminal, criteriosDe, matrixForSignature, pistaDeSesion, preparar, esLaDelMarcador, pedidosDelComando, paraMostrar, handle };
