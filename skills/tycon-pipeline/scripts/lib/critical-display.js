'use strict';
/**
 * critical-display — el crítico que se quiere eximir se lo muestra el arnés a la persona, y el ok vale si responde a eso.
 *
 * Una cita de la persona, de esta corrida, no dice a qué le dijo que sí: un «apruebo, seguí» escrito por otra cosa
 * eximiría un crítico que nunca vio. Por eso el crítico lo muestra el arnés en pantalla (`systemMessage`, como el plan en
 * lib/plan-display.js), y queda la constancia `critical-shown` en `gates.log`, donde el agente no escribe.
 *
 *   · `paraMostrar({ command, sessionId, stateDir, home })`: la puerta Bash, antes de `marker.js waive-critical` sin
 *     `--terminal`. Devuelve `{ systemMessage, anotar }` o null.
 *   · `handle(event, opts)`: el despachador de ediciones (la instalación mínima no trae la puerta Bash). Un Write o Edit
 *     de `exencion-pedida.json` ({ rule, file, reason }) en la carpeta de la corrida abierta de la sesión.
 *   · `mostrado(...)`: la constancia más nueva de ese crítico con ese motivo, o null. La lee `waive-critical`.
 *   · `juez({ rule, file, archivos, arnes })`: `(texto) => null | motivo`. ¿El mensaje nombra ese crítico y no lo niega?
 *
 * Sin la conversación legible (otra herramienta) no se muestra ni se anota: no se sabe si el aviso se ve.
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

// un código de regla entero, con sufijo si lo tiene (TEST-C1b, ACCOV-C1-EXT); «TEST-C10» no es «TEST-C1»
const RE_CODIGO = /(?<![\w-])([A-Z][A-Z0-9]*-[CW]\d(?:[\w.-]*[A-Za-z0-9])?)(?![\w-])/gi;
const RE_NIEGA = /\bno\s+(?:(?:lo|la|los|las|se)\s+)?exim/i;
// una negación en cualquier parte del mensaje: «no», «ni», «nunca», «jamás», «tampoco», «sin eximir», «nada de eximir»
const RE_NIEGA_ALGO = /(?<![\p{L}\p{N}])(?:(?:no|ni|nunca|jam[aá]s|tampoco)(?![\p{L}\p{N}])|sin\s+exim|nada\s+de\s+exim)/iu;
// una excepción, una condición o un rechazo dicho con otras palabras: cualquiera descarta el ok
const RE_EXCEPCION = /(?<![\p{L}\p{N}])(?:menos|salvo|excepto|rechaz\p{L}*|evit\p{L}*|cuando|hasta\s+que|antes\s+de|a\s+menos|quiz[aá]s?|podr\p{L}*|mantengo|despu[eé]s|[uú]nicamente|s[oó]lo\s+si|siempre\s+que|mientras|con\s+la\s+condici[oó]n)(?![\p{L}\p{N}])/iu;
// una condición: «si» seguido de una palabra («si lo arreglás, …»); «si, eximo» (un «sí» sin tilde) no lo es
const RE_CONDICION = /(?<![\p{L}\p{N}])si\s+\p{L}/iu;
// las partes de un mensaje: cortan el punto (seguido de espacio o al final), ; ! ? el renglón, la coma y «pero»; cada
// parte sabe si es una pregunta (termina en «?» o abre con «¿»)
function partes(t) {
  const out = [];
  for (const m of String(t).matchAll(/[^.;!?\n]+(?:[.!?](?=\s|$)|[;\n?])?/g)) {
    const pregunta = /\?\s*$/.test(m[0]) || m[0].includes('¿');
    for (const s of m[0].split(/[,:]|(?<![\p{L}])pero(?![\p{L}])/u)) if (s.trim()) out.push({ texto: s.trim(), pregunta });
  }
  return out;
}
// las frases de un mensaje: cortan el punto (seguido de espacio o al final), ; ! ? y el renglón; no la coma
const frases = (t) => String(t).split(/(?:[.!?](?=\s|$)|[;\n])+/).map((s) => s.trim()).filter(Boolean);
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// ¿el texto nombra `x` entero? (no dentro de otro nombre: «barfoo.js» no nombra «foo.js»)
const nombraEntero = (texto, x) => new RegExp(`(?<![\\w./\\\\-])${escRe(String(x).toLowerCase())}(?![\\w-])`).test(String(texto).toLowerCase());
const norm = (s) => String(s).toLowerCase().replace(/[«»"“”'‘’]/g, ' ').replace(/\s+/g, ' ').trim();

/** `(texto) => null | motivo`: el mensaje de la persona nombra ese crítico (código o nombre en llano) y no lo niega. */
function juez({ rule, file, archivos = [], arnes }) {
  const r = String(rule || '').trim().toUpperCase();
  const llano = nombreEnLlano(r, { arnes });
  const nombre = `${r}${llano ? `, «${llano}»` : ''}`;
  const archivo = String(file || '').trim();
  const base = path.basename(archivo);
  const varios = archivos.length > 1;
  // si otro archivo abierto comparte el nombre, el nombre solo no alcanza: va la ruta
  const comoNombrar = varios && archivos.filter((a) => path.basename(a) === base).length > 1 ? archivo : base;
  const codigosDe = (s) => [...String(s).matchAll(RE_CODIGO)].map((m) => m[1].toUpperCase());
  const nombraEsta = (s) => codigosDe(s).includes(r) || (!!llano && norm(s).includes(norm(llano)));
  const RE_EXIM = /(?<![\p{L}\p{N}])exim\p{L}*|exenci[oó]n/iu;
  // un freno sin «no» («Esperá.», «Pará.», «Frená») también se echa atrás
  const RE_FRENO = /(?<![\p{L}\p{N}])(?:esper[aá]|par[aá]|fren[aá]|aguant[aá])(?![\p{L}\p{N}])/iu;
  // lo que enseñan los rechazos: el mensaje del ok trae sólo el ok; una aclaración va en otro mensaje
  const SOLO = `contestá sólo «eximo ${r}»${llano ? ` (o «eximo ${llano}»)` : ''}, con su motivo si querés; cualquier otra cosa, en otro mensaje`;
  const juzgar = (texto) => {
    const t = String(texto || '');
    const codigos = codigosDe(t);
    const otros = [...new Set(codigos)].filter((c) => c !== r);
    // el nombre en llano no alcanza si el mensaje nombra otro código y no éste
    if (!codigos.includes(r) && otros.length) return `el ok nombra ${otros.join(', ')}, no ${r}`;
    if (!nombraEsta(t)) return `el ok no nombra este crítico (${nombre}): un ok genérico no exime`;
    // El ok tiene que DECIR que lo exime, sin vueltas: leer bien todas las formas de negar en texto libre no cierra, así
    // que ante la duda no exime. Cualquier negación, freno, excepción o condición en el mensaje lo descarta, aunque esté
    // en una aclaración de otra cosa: juzgar sólo la oración que exime dejaba pasar formas de echarse atrás sin nombrar el
    // crítico, y una aclaración con su propio «no» tiene la misma forma que una retractación. Un rechazo de más se arregla
    // contestando de nuevo (el motivo dice cómo); un ok de más eximiría lo que la persona no aprobó.
    if (RE_NIEGA_ALGO.test(t)) return `el ok trae una negación («no», «nunca», «sin eximir»…): no exime. Para eximirlo, ${SOLO}`;
    if (RE_FRENO.test(t)) return `el ok pide esperar («esperá», «pará»…): no exime. Para eximirlo, ${SOLO}`;
    if (RE_EXCEPCION.test(t)) return `el ok pone una excepción o una condición («menos», «salvo», «cuando», «hasta que»…): no exime. Para eximirlo, ${SOLO}`;
    if (RE_CONDICION.test(t)) return `el ok pone una condición («si …»): no exime. Para eximirlo, ${SOLO}`;
    // una parte de la frase arranca con «exim… <regla o nombre en llano>»: así el crítico es lo que se exime, y no
    // «eximo todo menos TEST-C1» ni «eximo TEST-C2 y mantengo TEST-C1». Lo que sigue puede ser una explicación: una
    // negación, una excepción o una condición ya descartaron el ok más arriba.
    const objetos = [r, ...(llano ? [llano] : [])].map((x) => escRe(norm(x)));
    // «apruebo eximir R» es una aprobación igual de clara que «eximo R», con las mismas reglas
    const RE_FORMA = new RegExp(`^(?:ok|dale|s[ií]|listo)?\\s*(?:yo\\s+)?(?:exim[oíe]|exim[ií]lo|exim[ií]la|eximimos|exim[ií]los|apruebo\\s+(?:que\\s+se\\s+)?exim(?:ir|a)|apruebo\\s+la\\s+exenci[oó]n\\s+de)\\s+(?:el\\s+|la\\s+)?(?:cr[ií]tico\\s+)?(?:${objetos.join('|')})(?![\\p{L}\\p{N}-])(?:\\s.*)?$`, 'iu');
    const afirma = partes(t).some((p) => !p.pregunta && RE_FORMA.test(norm(p.texto.replace(/[.:!;]+\s*$/, ''))));
    if (!afirma) return `el ok nombra ${r} pero no dice que lo exime: tiene que decirlo («eximo ${r}»${llano ? ` o «eximo ${llano}»` : ''}), sin preguntar`;
    if (varios && comoNombrar && !nombraEntero(t, comoNombrar)) return `${r} está abierta en ${archivos.length} archivos: el ok tiene que nombrar ${comoNombrar}`;
    return null;
  };
  // ¿un mensaje POSTERIOR al ok se echa atrás? Sí, si trae una negación, un freno, una excepción o una condición y además
  // nombra este crítico o habla de eximir, o es corto (hasta tres palabras: «No.», «Mejor no.», «Esperá.»). Una aclaración
  // de otra cosa en su propio mensaje («Sobre la Mac: no hay otro ensayo.») no tumba el ok: es lo que enseña el rechazo.
  juzgar.retracta = (texto) => {
    const t = String(texto || '');
    if (!(RE_NIEGA_ALGO.test(t) || RE_FRENO.test(t) || RE_EXCEPCION.test(t) || RE_CONDICION.test(t))) return false;
    const corto = t.split(/[\s,.;:!?¿¡]+/).filter(Boolean).length <= 3;
    return nombraEsta(t) || RE_EXIM.test(t) || corto;
  };
  return juzgar;
}

/** El bloque que ve la persona. */
function bloque({ storyId, rule, file, reason, summary, archivos = [], arnes }) {
  const r = String(rule).trim();
  const llano = nombreEnLlano(r, { arnes });
  const base = path.basename(String(file || ''));
  const formas = [`«eximo ${r}»`, ...(llano ? [`«eximo ${llano}»`] : [])].join(' o ');
  return [
    `Te piden eximir un crítico de la historia ${storyId} (te lo muestra el arnés):`,
    `  Regla: ${r}${llano ? ` (${llano})` : ''}`,
    ...(file ? [`  Archivo: ${file}`] : []),
    ...(summary ? [`  Qué dijo el revisor: ${summary}`] : []),
    `  Por qué lo quieren eximir: ${reason}`,
    'Un crítico eximido va al commit sin arreglar.',
    `Si estás de acuerdo, contestá ${formas}${archivos.length > 1 && base ? `, nombrando el archivo (${base})` : ''}. Un «dale» o un «apruebo» suelto no lo exime.`,
    'Contestá sólo eso, con su motivo si querés; cualquier otra cosa, en otro mensaje.',
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
function preparar({ sessionId, stateDir, home = os.homedir(), rule, file, reason, arnes }) {
  if (!rule || !reason || !sessionId) return null;
  const marker = leerMarcador(stateDir, sessionId);
  if (!marker || !marker.storyId) return null;
  const legible = require('./person-ok.js').leerConversacion({ sesion: sessionId, home }).legible;
  if (!legible) return null;
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
  const aviso = cs.error || ar.error ? `\n(Aviso del arnés: ${ar.error || `no pude leer findings.json de la corrida (${cs.error})`}; así no se puede eximir hasta arreglarlo.)` : '';
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

/**
 * Los `marker.js waive-critical` del comando (también dentro de `bash -c "…"`), sin los que van por `--terminal`.
 * Uno con variables o sustituciones de la terminal en lo que se exime no entra: su valor no se sabe hasta que corre.
 */
function pedidosDelComando(command, profundidad = 0) {
  const w = palabras(command);
  const out = [];
  for (let i = 0; i < w.length; i++) {
    if (profundidad < 2 && /\bmarker\.js\b/.test(w[i]) && /\swaive-critical\b/.test(w[i])) out.push(...pedidosDelComando(w[i], profundidad + 1));
    if (!/(^|[\\/])marker\.js$/.test(w[i]) || w[i + 1] !== 'waive-critical') continue;
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

function paraMostrar({ command, sessionId, stateDir, home = os.homedir(), arnes }) {
  const listos = pedidosDelComando(command).map((p) => preparar({ sessionId, stateDir, home, arnes, ...p })).filter(Boolean);
  if (!listos.length) return null;
  return { systemMessage: listos.map((r) => r.systemMessage).join('\n\n'), anotar: () => { for (const r of listos) r.anotar(); } };
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
  const r = preparar({ sessionId, stateDir, home: opts.home, arnes: opts.arnes, rule: String(p.rule || '').trim(), file: String(p.file || '').trim(), reason: String(p.reason || '').trim() });
  return r ? { systemMessage: r.systemMessage, alMostrar: r.anotar } : null;
}

module.exports = { PEDIDO, EN_LLANO, nombreEnLlano, huella, mostrado, archivosDeLaRegla, juez, bloque, palabras, pedidosDelComando, paraMostrar, handle };
