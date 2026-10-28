'use strict';
/**
 * critical-display — el crítico que se quiere eximir se lo muestra el arnés a la persona antes de la ventana de permiso.
 *
 * La ventana muestra el comando, no el crítico: sin el aviso, la persona aprobaría un crítico que nunca vio. Por eso el
 * crítico lo muestra el arnés en pantalla (`systemMessage`, como el plan en
 * lib/plan-display.js), y queda la constancia `critical-shown` en `gates.log`, donde el agente no escribe.
 *
 *   · `paraMostrar({ command, sessionId, stateDir, home })`: la puerta Bash, antes de `marker.js waive-critical` sin
 *     `--terminal`. Devuelve `{ systemMessage, anotar }` o null.
 *   · `handle(event, opts)`: el despachador de ediciones (la instalación mínima no trae la puerta Bash). Un Write o Edit
 *     de `exencion-pedida.json` ({ rule, file, reason }) en la carpeta de la corrida abierta de la sesión.
 *   · `mostrado(...)`: la constancia más nueva de ese crítico con ese motivo, o null. La lee `waive-critical`.
 *   · `primeraMuestra(...)`: la primera constancia de ese crítico en la corrida, con cualquier motivo.
 *
 * Se muestra siempre, con la conversación legible o sin ella: la firma no sale de la conversación sino de la ventana de
 * permiso o de la terminal.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PEDIDO = 'exencion-pedida.json';

// Los críticos que el propio arnés levanta en cada corrida, con el nombre que entiende una persona sin los códigos.
const EN_LLANO = {
  'TEST-C1': 'la suite completa',
  'TEST-C2': 'la cobertura',
  'TEST-C3': 'las pruebas de los criterios',
};
const LARGO_MAXIMO = 60;

// La raíz del arnés de este archivo (scripts/lib → scripts → tycon-pipeline → skills → raíz), por su ruta real.
function raizDelArnes() {
  let aqui = __dirname;
  try { aqui = fs.realpathSync(__dirname); } catch (_e) { /* la ruta tal cual */ }
  return path.join(aqui, '..', '..', '..', '..');
}

/** El nombre en llano de una regla: la tabla del arnés, o el título corto del catálogo. null si no hay. */
function nombreEnLlano(rule, { arnes = raizDelArnes() } = {}) {
  const r = String(rule || '').trim().toUpperCase();
  if (EN_LLANO[r]) return EN_LLANO[r];
  let cat;
  try { cat = fs.readFileSync(path.join(arnes, 'guides', 'advisor-rules-catalog.md'), 'utf8'); } catch (_e) { return null; }
  const esc = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^\\|\\s*\\*\\*${esc}\\*\\*\\s*\\|([^|]+)\\|`, 'm').exec(cat);
  if (!m) return null;
  const titulo = m[1].trim();
  if (!titulo || titulo.length > LARGO_MAXIMO || /[`*]/.test(titulo)) return null;
  // la primera letra en minúscula para la frase («eximo webhooks sin firma»), salvo una sigla («HTTP sin TLS»)
  return /^\p{Lu}\p{Ll}/u.test(titulo) ? titulo.charAt(0).toLowerCase() + titulo.slice(1) : titulo;
}

const huella = (rule, file, reason) => crypto.createHash('sha256').update(JSON.stringify([String(rule || '').trim(), String(file || '').trim(), String(reason || '').trim()])).digest('hex').slice(0, 16);

// Las constancias de muestra: `{ lineas, error? }`. Que falte el registro es «ninguna»; no poder leerlo es un error.
function leerGates(stateDir) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { lineas: [] } : { lineas: [], error: (e && (e.code || e.message)) || 'error' };
  }
  const lineas = [];
  for (const l of raw.split('\n')) {
    if (!l.includes('"critical-shown"')) continue;
    try { const g = JSON.parse(l); if (g && g.name === 'critical-shown' && !Number.isNaN(Date.parse(g.ts))) lineas.push(g); } catch (_e) { /* renglón roto: no cuenta */ }
  }
  return { lineas };
}
const delCaso = (g, { sessionId, storyId, rule }) => g.sessionId === sessionId && String(g.story) === String(storyId) && g.rule === String(rule || '').trim();

/** La constancia más nueva de ese crítico (sesión, historia, regla, archivo y motivo), null, o `{ error }`. */
function mostrado({ stateDir, sessionId, storyId, rule, file, reason }) {
  const sha = huella(rule, file, reason);
  const g = leerGates(stateDir);
  if (g.error) return { error: g.error };
  const hits = g.lineas.filter((g) => delCaso(g, { sessionId, storyId, rule }) && (g.file || '') === String(file || '').trim() && g.sha === sha);
  if (!hits.length) return null;
  return hits.reduce((a, b) => (Date.parse(b.ts) > Date.parse(a.ts) ? b : a));
}

/**
 * La primera muestra de ese crítico (sesión, historia, regla y archivo) desde `desde`, con cualquier motivo, null, o
 * `{ error }`. Un motivo reescrito vuelve a mostrar el crítico.
 */
function primeraMuestra({ stateDir, sessionId, storyId, rule, file, desde }) {
  const t0 = Date.parse(desde || '');
  const g = leerGates(stateDir);
  if (g.error) return { error: g.error };
  const hits = g.lineas.filter((g) => delCaso(g, { sessionId, storyId, rule }) && (g.file || '') === String(file || '').trim() && !(Date.parse(g.ts) < t0));
  if (!hits.length) return null;
  return hits.reduce((a, b) => (Date.parse(b.ts) < Date.parse(a.ts) ? b : a));
}

/** Los archivos en que esa regla está abierta: lo que se le mostró a la persona y los CRITICAL de findings.json. */
// `{ archivos, error? }`: sin poder leer el registro o findings.json, no se sabe si hay que pedir el archivo.
function archivosDeLaRegla({ stateDir, sessionId, storyId, rule, runDir }) {
  const g = leerGates(stateDir);
  if (g.error) return { archivos: [], error: `no pude leer el registro del arnés (${g.error})` };
  const c = criticosDe(runDir);
  if (c.error) return { archivos: [], error: `no pude leer findings.json de la corrida (${c.error})` };
  const s = new Set(g.lineas.filter((x) => delCaso(x, { sessionId, storyId, rule })).map((x) => x.file || ''));
  for (const f of c.lista) if (reglaDe(f) === String(rule || '').trim()) s.add(String(f.file || '').trim());
  s.delete('');
  return { archivos: [...s] };
}

const reglaDe = (f) => String((f && (f.rule_id || f.ruleId || f.rule)) || '').trim();
// Los CRITICAL de findings.json: `{ lista, error? }`. Que todavía no exista es «ninguno».
function criticosDe(runDir) {
  if (!runDir) return { lista: [] };
  let arr;
  try { arr = JSON.parse(fs.readFileSync(path.join(runDir, 'findings.json'), 'utf8')); } catch (e) {
    return e && e.code === 'ENOENT' ? { lista: [] } : { lista: [], error: (e && (e.code || e.message)) || 'error' };
  }
  if (!Array.isArray(arr)) {
    if (!Array.isArray(arr && arr.findings)) return { lista: [], error: 'findings.json no es una lista de hallazgos' };
    arr = arr.findings;
  }
  return { lista: arr.filter((f) => f && String(f.severity || '').trim().toUpperCase() === 'CRITICAL') };
}

/** El bloque que ve la persona. */
function bloque({ storyId, rule, file, reason, summary, arnes }) {
  const r = String(rule).trim();
  const llano = nombreEnLlano(r, { arnes });
  // tres renglones: Claude Code antepone su rótulo a cada renglón del aviso
  return [
    `Te piden eximir un crítico de la historia ${storyId} (te lo muestra el arnés): regla ${r}${llano ? ` (${llano})` : ''}${file ? `, archivo ${file}` : ''}.`,
    `${summary ? `Qué dijo el revisor: ${summary}. ` : ''}Por qué lo quieren eximir: ${reason}. Un crítico eximido va al commit sin arreglar.`,
    'Si estás de acuerdo, aprobalo en la ventana de permiso que sale a continuación; si no, elegí «No». Una respuesta en el chat no lo exime.',
  ].join('\n');
}

function leerMarcador(stateDir, sessionId) {
  let txt;
  // el nombre del archivo como lo arma marker.js (una barra en el identificador no sale de la carpeta)
  try { txt = fs.readFileSync(path.join(stateDir, 'active', `${String(sessionId).replace(/[\\/]/g, '_')}.json`), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(txt);
}
function carpetaDeLaCorrida(marker) {
  const repo = marker.repoPath || process.cwd();
  let story;
  if (marker.storyPath) {
    const p = path.isAbsolute(marker.storyPath) ? marker.storyPath : path.join(repo, marker.storyPath);
    if (fs.existsSync(p)) story = p;
  }
  return require('../pipeline.js').resolveRunDir(repo, String(marker.storyId), false, story);
}

// Arma la muestra de un crítico, si corresponde. La constancia la escribe quien muestra, después de mostrar (`anotar`).
function preparar({ sessionId, stateDir, rule, file, reason, arnes }) {
  if (!rule || !reason || !sessionId) return null;
  const marker = leerMarcador(stateDir, sessionId);
  if (!marker || !marker.storyId) return null;
  const storyId = String(marker.storyId);
  const ya = mostrado({ stateDir, sessionId, storyId, rule, file, reason });
  if (ya && !ya.error) return null;
  const runDir = carpetaDeLaCorrida(marker);
  const cs = criticosDe(runDir);
  const hallazgo = cs.lista.find((f) => reglaDe(f) === String(rule).trim() && String(f.file || '').trim() === String(file || '').trim());
  const summary = hallazgo ? String(hallazgo.summary || hallazgo.title || hallazgo.reason || '').trim().replace(/\s+/g, ' ') : '';
  const ar = archivosDeLaRegla({ stateDir, sessionId, storyId, rule, runDir });
  const archivos = ar.archivos;
  if (file && !archivos.includes(String(file).trim())) archivos.push(String(file).trim());
  const constancia = { ts: new Date().toISOString(), sessionId, repoPath: marker.repoPath || null, name: 'critical-shown', status: 'ok', story: storyId, rule: String(rule).trim(), file: String(file || '').trim(), sha: huella(rule, file, reason) };
  // si no se pudo leer lo de la corrida, la persona lo sabe ya (al eximir, el ok se rechaza por eso)
  const aviso = cs.error || ar.error ? ` (Aviso del arnés: ${ar.error || `no pude leer findings.json de la corrida (${cs.error})`}; así no se puede eximir hasta arreglarlo.)` : '';
  return {
    systemMessage: bloque({ storyId, rule, file, reason, summary, archivos, arnes }) + aviso,
    runDir,
    anotar: () => {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify({ ...constancia, ts: new Date().toISOString() })}\n`, 'utf8');
    },
  };
}

// Las palabras de un comando de la terminal, con comillas simples, dobles y barra invertida. Corta en ; | & y renglón.
function palabras(cmd) {
  const out = [];
  let cur = null;
  let q = null;
  const s = String(cmd || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; if (cur === null) cur = ''; continue; }
    // barra invertida y renglón: la terminal une los dos renglones
    if (c === '\\' && s[i + 1] === '\n') { i++; continue; }
    if (c === '\\' && i + 1 < s.length) { cur = (cur || '') + s[++i]; continue; }
    if (/\s/.test(c) || ';|&'.includes(c)) {
      if (cur !== null) { out.push(cur); cur = null; }
      if (c === '\n' || ';|&'.includes(c)) out.push('\u0000');
      continue;
    }
    cur = (cur || '') + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

// una palabra que es sólo una variable de la terminal (`$M`, `${M}`; las comillas ya las sacó `palabras`)
const ES_VARIABLE = /^\$(?:\{\w+\}|\w+)$/;

/**
 * Los `marker.js waive-critical` del comando (también dentro de `bash -c "…"`), sin los que van por `--terminal`.
 * Uno con variables o sustituciones de la terminal en lo que se exime no entra: su valor no se sabe hasta que corre.
 */
function pedidosDelComando(command, profundidad = 0) {
  const w = palabras(command);
  const out = [];
  for (let i = 0; i < w.length; i++) {
    if (profundidad < 2 && /\bmarker\.js\b/.test(w[i]) && /\swaive-critical\b/.test(w[i])) out.push(...pedidosDelComando(w[i], profundidad + 1));
    // el ejecutable puede venir en una variable de la terminal (`node "$M" waive-critical …`): lo que se exime, no
    if (!(/(^|[\\/])marker\.js$/.test(w[i]) || ES_VARIABLE.test(w[i])) || w[i + 1] !== 'waive-critical') continue;
    const args = [];
    for (let j = i + 2; j < w.length && w[j] !== '\u0000'; j++) args.push(w[j]);
    if (args.includes('--terminal')) continue;
    const val = (n) => { const k = args.indexOf(n); return k >= 0 && args[k + 1] !== undefined && !/^--/.test(args[k + 1]) ? args[k + 1].trim() : ''; };
    const p = { rule: val('--rule'), file: val('--file'), reason: val('--reason') };
    if (Object.values(p).some((v) => /[$`]/.test(v))) continue;
    out.push(p);
  }
  return out;
}

/**
 * Los otros CRITICAL abiertos de la corrida, para mostrarlos junto con los pedidos: sin exención en
 * critical-waivers.jsonl ni muestra en esta corrida, con el motivo de su hallazgo. `{ lista, aviso }`: sin poder leer
 * findings.json o las exenciones, ninguno, y el aviso lo dice (la persona no cree que no hay otros).
 */
function otrosAbiertos({ sessionId, stateDir, pedidos }) {
  const marker = leerMarcador(stateDir, sessionId);
  if (!marker || !marker.storyId) return { lista: [], aviso: null };
  const runDir = carpetaDeLaCorrida(marker);
  const cs = criticosDe(runDir);
  if (cs.error) return { lista: [], aviso: `no pude leer findings.json de la corrida (${cs.error}): puede haber otros críticos abiertos que no se muestran acá` };
  const ex = require('./critical-waivers.js').leer(runDir);
  if (ex.error) return { lista: [], aviso: `no pude leer las exenciones de la corrida (${ex.error}): puede haber otros críticos abiertos que no se muestran acá` };
  const clave = (rule, file) => `${String(rule || '').trim()}|${String(file || '').trim()}`;
  const vistas = new Set([...pedidos.map((p) => clave(p.rule, p.file)), ...ex.lineas.map((e) => clave(reglaDe(e), e.file))]);
  const out = [];
  for (const f of cs.lista) {
    const rule = reglaDe(f);
    const file = String(f.file || '').trim();
    if (!rule || vistas.has(clave(rule, file))) continue;
    vistas.add(clave(rule, file));
    const ya = primeraMuestra({ stateDir, sessionId, storyId: String(marker.storyId), rule, file, desde: marker.startedAt });
    if (ya) continue;
    out.push({ rule, file, reason: String(f.reason || f.summary || f.title || 'el crítico abierto de la corrida').trim().replace(/\s+/g, ' ') });
  }
  return { lista: out, aviso: null };
}

/**
 * La muestra de los pedidos y de los demás críticos abiertos de la corrida, juntos. Con uno solo, su bloque; con varios,
 * cada bloque y cómo contestar todos en un mensaje. `{ systemMessage, anotar }` o null.
 */
function mostrarJuntos({ pedidos, sessionId, stateDir, home = os.homedir(), arnes }) {
  const otros = otrosAbiertos({ sessionId, stateDir, pedidos });
  const listos = [...pedidos, ...otros.lista]
    .map((p) => ({ p, r: preparar({ sessionId, stateDir, home, arnes, ...p }) })).filter((x) => x.r);
  if (!listos.length) return null;
  const partes = listos.map((x) => x.r.systemMessage);
  if (otros.aviso) partes[partes.length - 1] += ` (Aviso del arnés: ${otros.aviso}.)`;
  if (listos.length > 1) partes.push(`Son ${listos.length} críticos: se aprueban en la ventana de permiso, no en el chat.`);
  return { systemMessage: partes.join('\n'), anotar: () => { for (const x of listos) x.r.anotar(); } };
}

function paraMostrar({ command, sessionId, stateDir, home = os.homedir(), arnes }) {
  const pedidos = pedidosDelComando(command);
  if (!pedidos.length) return null;
  return mostrarJuntos({ pedidos, sessionId, stateDir, home, arnes });
}

const mismaRuta = (a, b) => path.resolve(String(a)).replace(/\\/g, '/').toLowerCase() === path.resolve(String(b)).replace(/\\/g, '/').toLowerCase();

function handle(event, opts = {}) {
  const tool = event && event.tool_name;
  if (tool !== 'Write' && tool !== 'Edit') return null;
  const archivo = event.tool_input && event.tool_input.file_path;
  if (!archivo || path.basename(String(archivo)) !== PEDIDO) return null;
  const { resolveSessionId } = require('./session-id.js');
  const sessionId = resolveSessionId(event.session_id);
  const stateDir = opts.stateDir || require('./story-gate-io.js').DEFAULT_STATE_DIR;
  const marker = leerMarcador(stateDir, sessionId);
  if (!marker || !marker.storyId) return null;
  const runDir = carpetaDeLaCorrida(marker);
  if (!runDir || !mismaRuta(archivo, path.join(runDir, PEDIDO))) return null;
  let p;
  try { p = JSON.parse(fs.readFileSync(path.join(runDir, PEDIDO), 'utf8')); } catch (e) {
    return { reminder: `${PEDIDO} no se pudo leer como JSON (${e.message}): tiene que traer { "rule", "file", "reason" }.` };
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { reminder: `${PEDIDO} tiene que ser un objeto con { "rule", "file", "reason" }.` };
  const pedido = { rule: String(p.rule || '').trim(), file: String(p.file || '').trim(), reason: String(p.reason || '').trim() };
  const r = mostrarJuntos({ pedidos: [pedido], sessionId, stateDir, home: opts.home, arnes: opts.arnes });
  return r ? { systemMessage: r.systemMessage, alMostrar: r.anotar } : null;
}

module.exports = { PEDIDO, EN_LLANO, nombreEnLlano, huella, mostrado, primeraMuestra, archivosDeLaRegla, bloque, palabras, pedidosDelComando, otrosAbiertos, paraMostrar, handle };
