'use strict';
/**
 * atdd-skip.js — la constancia firmada por el dueño para saltear «pruebas primero» en una ejecución.
 *
 * Saltear el freno de pruebas primero (`complete-step implement --no-atdd`, `set-flag atddBypass`, o la marca
 * `atddBypass` que lee el portón previo a cada edición) es un pedido: sin constancia, el freno frena. El pedido anota la
 * MUESTRA (`atdd-skip-shown` en el `gates.log` de la casa de la cuenta: historia, carpeta de la ejecución, la ejecución
 * y el camino) e imprime los dos comandos de firma. El dueño firma `marker.js sign-atdd-skip --story S --reason R` en la
 * ventana de permiso, o con `--terminal` en su terminal (`owner-window.js` `exigir`). La firma toma la ejecución de la
 * última muestra de S, no del marcador: en la terminal del dueño no hay sesión. Escribe en orden el renglón
 * `atdd-skip-signed` (con la huella en su `resumen`), la línea de `<carpeta>/atdd-skips.jsonl` y la de `approvals.jsonl`.
 *
 * Una constancia vale para una ejecución entera (la misma historia, la misma carpeta y la misma ejecución, el
 * `startedAt` del marcador): cubre el cierre de «Implementar» y cada edición del portón previo, y no se gasta. Una
 * ejecución nueva pide otra. Lo que no se puede decidir no saltea.
 *
 * Tiene la forma de `adversarial-skip.js` (la firma de saltear el pase), con sus propios renglones y textos: aquella
 * constancia depende de la muestra del portón del pase, que acá no existe.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { stateDir } = require('./state-dir.js');

const FILE = 'atdd-skips.jsonl';
const MOSTRADA = 'atdd-skip-shown';
const FIRMADA = 'atdd-skip-signed';
const FIRMA = 'atdd-skip';
const MARKER = path.join(__dirname, '..', 'marker.js');
const CAMPOS = ['story', 'carpeta', 'ejecucion', 'camino', 'motivo', 'ts', 'via', 'quien'];
const PROHIBIDAS = ['--quote', '--relayed-by', '--ok'];
// las vías en que la firma la dio una persona; el click o el «aprobado» entran a la huella como `ventana`
const VIAS = ['ventana', 'terminal', 'click', 'mensaje'];

const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const valor = (v) => (v == null ? null : String(v));
const viaDeLaHuella = (via) => (via === 'click' || via === 'mensaje' ? 'ventana' : via);
const huella = (l) => sha(CAMPOS.map((k) => valor(l && (k === 'via' ? viaDeLaHuella(l[k]) : l[k])))).slice(0, 16);
const huellaCorta = (m) => sha([m.story, m.carpeta, m.ejecucion, m.camino].map(valor)).slice(0, 8);

/** La casa de la cuenta (la base de usuarios del sistema), o la que se pase. */
function casaDe(casa, userInfo) {
  if (casa) return casa;
  return require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'real-home.js')).casaDeLaCuenta(userInfo ? { userInfo } : undefined);
}
const registro = (casa) => path.join(stateDir(casa), 'gates.log');

/** ¿`HOME` apunta a otra casa que la de la cuenta? Con eso no se anota ni se firma nada: no sería la misma casa. */
function casaDistinta(casa) {
  const a = path.resolve(os.homedir());
  const b = path.resolve(casa);
  return process.platform === 'win32' ? a.toLowerCase() !== b.toLowerCase() : a !== b;
}

/** La carpeta absoluta y sin enlaces (la de la carpeta madre si ésta todavía no existe): la misma ejecución da la misma. */
function carpetaReal(carpeta) {
  const abs = path.resolve(String(carpeta));
  try { return fs.realpathSync(abs); } catch (_) { /* todavía no existe */ }
  try { return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch (_) { return abs; }
}

/** La carpeta de la ejecución del marcador: la que anotó (`runDir`) o la que calcula el pipeline. null si no hay. */
function carpetaDe(marker) {
  if (!marker) return null;
  if (marker.runDir) return carpetaReal(path.isAbsolute(String(marker.runDir)) ? marker.runDir : path.resolve(marker.repoPath || process.cwd(), String(marker.runDir)));
  try {
    const rd = require('../pipeline.js').resolveRunDir(path.resolve(marker.repoPath || process.cwd()), String(marker.storyId), false, marker.storyPath || undefined, { marker });
    return rd ? carpetaReal(rd) : null;
  } catch (_) { return null; }
}

/** Los dos comandos de firma: el que pide la ventana y el de la terminal del dueño. */
function comandos(story) {
  const base = `node ${MARKER} sign-atdd-skip --story ${story} --reason "<motivo>"`;
  return [base, `${base} --terminal`];
}

function leerRegistro(casa) {
  let raw;
  try { raw = fs.readFileSync(registro(casa), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { renglones: [] };
    return { renglones: [], error: e.code || e.message };
  }
  // un renglón roto no cuenta como firma
  const renglones = [];
  for (const l of raw.split('\n')) {
    if (!l.includes(FIRMA)) continue;
    try { renglones.push(JSON.parse(l)); } catch (_) { /* no cuenta */ }
  }
  return { renglones };
}

/**
 * Anota la muestra del pedido y devuelve el texto para el agente y el dueño: `{ renglon, texto, comandos, error? }`. Sin
 * muestra no hay firma posible, y el texto lo dice.
 */
function muestra({ story, carpeta: dada, ejecucion, camino, casa, userInfo, ahora = Date.now() } = {}) {
  const cmds = comandos(story);
  const carpeta = dada == null ? dada : carpetaReal(dada);
  const renglon = { ts: new Date(ahora).toISOString(), name: MOSTRADA, status: 'ok', story: valor(story), carpeta: valor(carpeta), ejecucion: valor(ejecucion), camino: valor(camino) };
  renglon.huella = huellaCorta(renglon);
  const cabeza = `🔒 ${camino} es un pedido de saltear «pruebas primero», no un salteo: sin la firma de una persona el freno sigue.\n`
    + `   Muestra ${renglon.huella} · historia ${story} · ejecución ${ejecucion} · ${carpeta}\n`;
  let error = null;
  try {
    if (!carpeta || !ejecucion) throw new Error('la ejecución no tiene carpeta o no dice cuándo arrancó');
    const c = casaDe(casa, userInfo);
    if (!casa && casaDistinta(c)) throw new Error('HOME apunta a otra casa que la de la cuenta');
    fs.mkdirSync(stateDir(c), { recursive: true });
    fs.appendFileSync(registro(c), `${JSON.stringify(renglon)}\n`);
  } catch (e) { error = (e && e.message) || String(e); }
  const texto = error
    ? `${cabeza}   No pude anotar la muestra (${error}): sin ella no hay firma posible.\n`
      + `   Con la muestra anotada, una persona firma con: ${cmds[0]}  (o en su terminal: ${cmds[1]})\n`
    : `${cabeza}   Lo firma una persona: ni el agente ni la coordinadora.\n     en la ventana de permiso o, sin ventana, con su click en el cuadro de opciones o su «aprobado»: ${cmds[0]}\n     en su terminal:           ${cmds[1]}\n`;
  return { renglon, texto, comandos: cmds, ...(error ? { error } : {}) };
}

/** La última muestra de la historia en el registro de la casa, o null. Un registro que está y no se lee lanza. */
function ultimaMuestra({ story, casa, userInfo } = {}) {
  let raw;
  try { raw = fs.readFileSync(registro(casaDe(casa, userInfo)), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error(`no pude leer el registro del arnés (${(e && (e.code || e.message)) || e})`);
  }
  let ultima = null;
  for (const l of raw.split('\n')) {
    if (!l.includes(MOSTRADA)) continue;
    let g; try { g = JSON.parse(l); } catch (_) { continue; }
    if (g.name === MOSTRADA && g.status === 'ok' && g.story === String(story) && g.carpeta && g.ejecucion) ultima = g;
  }
  return ultima;
}

/** Las constancias de una carpeta: `{ lineas, ilegibles, error? }`. */
function leer(carpeta) {
  let raw;
  try { raw = fs.readFileSync(path.join(carpeta, FILE), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { lineas: [], ilegibles: 0 };
    return { lineas: [], ilegibles: 0, error: e.code || e.message };
  }
  const lineas = [];
  let ilegibles = 0;
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { lineas.push(JSON.parse(l)); } catch (_) { ilegibles++; }
  }
  return { lineas, ilegibles };
}

/** Por qué una línea no vale para esta ejecución, o null. */
function motivoDe(l, { story, carpeta, ejecucion, renglones }) {
  if (!l || typeof l !== 'object') return 'una línea que no es una constancia';
  if (l.story == null || l.carpeta == null || l.ejecucion == null || story == null || carpeta == null) return 'la constancia no nombra su historia o su ejecución';
  if (String(l.story) !== String(story)) return `es de otra historia (${l.story})`;
  if (!path.isAbsolute(String(l.carpeta)) || carpetaReal(l.carpeta) !== carpetaReal(carpeta)) return 'es de otra ejecución (otra carpeta)';
  if (String(l.ejecucion) !== String(ejecucion)) return `es de otra ejecución (${l.ejecucion})`;
  if (!VIAS.includes(l.via) || l.quien !== 'dueño' || !l.camino || !l.motivo || !l.ts) return 'le falta un campo (vía, quién, camino, motivo u hora)';
  if (l.huella !== huella(l)) return 'su huella no coincide con lo que dice (se cambió después de firmarla)';
  const ok = renglones.some((g) => g.name === FIRMADA && g.status === 'ok' && g.via === l.via && String(g.resumen || '').startsWith(`huella ${l.huella} `));
  if (!ok) return `no tiene su renglón ${FIRMADA} en el registro del arnés de esta cuenta (no la firmó una persona en esta máquina)`;
  return null;
}

/** ¿Hay una constancia que valga para esta ejecución? `{ ok: true, linea }` con la más nueva, o `{ ok: false, motivo }`. */
function vigente({ story, carpeta, ejecucion, casa, userInfo } = {}) {
  if (!carpeta || !ejecucion) return { ok: false, motivo: 'la ejecución no tiene carpeta o no dice cuándo arrancó' };
  const { lineas, ilegibles, error } = leer(carpeta);
  if (error) return { ok: false, motivo: `no pude leer ${FILE} (${error})` };
  if (ilegibles) return { ok: false, motivo: `${FILE} tiene ${ilegibles} línea(s) ilegible(s)` };
  if (!lineas.length) return { ok: false, motivo: 'no hay constancia firmada' };
  let c;
  try { c = casaDe(casa, userInfo); } catch (e) { return { ok: false, motivo: e.message }; }
  const reg = leerRegistro(c);
  if (reg.error) return { ok: false, motivo: `no pude leer el registro del arnés (${reg.error})` };
  let primero = null;
  for (let i = lineas.length - 1; i >= 0; i--) {
    const m = motivoDe(lineas[i], { story, carpeta, ejecucion, renglones: reg.renglones });
    if (!m) return { ok: true, linea: lineas[i] };
    if (!primero) primero = m;
  }
  return { ok: false, motivo: `la constancia no vale: ${primero}` };
}

/**
 * La decisión de los lectores (el cierre de «Implementar» y el portón previo): `{ saltea: true, linea }` con la constancia
 * vigente de la ejecución del marcador; si no, `{ saltea: false, texto }` con la muestra anotada y los comandos de firma.
 * `pide`: si el pedido de saltear está (la bandera o la marca); sin pedido no saltea y no anota nada.
 */
function decidir({ marker, pide, camino, casa, userInfo, ahora } = {}) {
  if (!pide || !marker) return { saltea: false, texto: '' };
  const carpeta = carpetaDe(marker);
  const v = vigente({ story: marker.storyId, carpeta, ejecucion: marker.startedAt, casa, userInfo });
  if (v.ok) return { saltea: true, linea: v.linea };
  const m = muestra({ story: marker.storyId, carpeta, ejecucion: marker.startedAt, camino, casa, userInfo, ahora });
  return { saltea: false, texto: m.texto, motivo: v.motivo };
}

/**
 * `marker.js sign-atdd-skip`. `exigir(o)` es el de `owner-window.js` (la ventana o la terminal); `aprobar(linea, entrada)`
 * anota la aprobación (por defecto, `approvals.jsonl` de la carpeta). `{ codigo, motivo?, linea? }`: 0 firmó; 1 no se
 * firmó; 2 falta algo del pedido o se firmó y no quedó escrito. Nada escrito salvo con 0.
 */
function firmar({ story, motivo, argv = [], sesion = null, casa, userInfo, ahora = Date.now(), exigir, aprobar } = {}) {
  const prohibida = PROHIBIDAS.find((b) => argv.some((w) => w === b || String(w).startsWith(`${b}=`)));
  if (prohibida) return { codigo: 1, motivo: `${prohibida} no firma: saltear «pruebas primero» lo firma una persona en la ventana de permiso o, sin ventana, con su click en el cuadro de opciones o su «aprobado» (este comando sin ${prohibida}), o en su terminal (--terminal)` };
  if (!story || !String(motivo || '').trim()) return { codigo: 2, motivo: 'faltan --story <S> y --reason "<motivo>"' };
  let c;
  try { c = casaDe(casa, userInfo); } catch (e) { return { codigo: 2, motivo: e.message }; }
  if (!casa && casaDistinta(c)) return { codigo: 2, motivo: 'HOME apunta a otra casa que la de la cuenta: la firma se lee de la casa de la cuenta' };
  let m;
  try { m = ultimaMuestra({ story, casa: c }); } catch (e) { return { codigo: 2, motivo: `${e.message}: no se firma sin poder ver la muestra` }; }
  if (!m) return { codigo: 1, motivo: `no hay una muestra del pedido para la historia ${story}: primero se corre el pedido (complete-step implement --no-atdd o set-flag atddBypass)` };
  const previas = leer(m.carpeta);
  if (previas.error || previas.ilegibles) return { codigo: 1, motivo: `${FILE} de la ejecución no se lee (${previas.error || `${previas.ilegibles} línea(s) ilegible(s)`}): no se firma sobre un archivo roto` };
  let via = argv.includes('--terminal') ? 'terminal' : 'ventana';
  const linea = { ts: new Date(ahora).toISOString(), story: String(story), carpeta: m.carpeta, ejecucion: m.ejecucion, camino: m.camino, motivo: String(motivo).trim(), via, quien: 'dueño' };
  linea.huella = huella(linea);
  let r;
  try {
    r = exigir({ firma: FIRMA, argv, resumen: `huella ${linea.huella} · historia ${story} · ${linea.motivo}`, casa: c, propia: sesion || undefined });
  } catch (e) { return { codigo: 2, motivo: `no pude dejar el renglón de la firma (${(e && e.message) || e})` }; }
  if (!r || r.codigo !== 0) return { codigo: (r && r.codigo) || 1, motivo: (r && r.motivo) || 'no se firmó' };
  if (r.via && r.via !== via && !(via === 'ventana' && viaDeLaHuella(r.via) === 'ventana')) return { codigo: 2, motivo: `la firma volvió por otra vía (${r.via})` };
  if (r.via) { via = r.via; linea.via = via; }
  const reg = leerRegistro(c);
  if (reg.error || !reg.renglones.some((g) => g.name === FIRMADA && g.status === 'ok' && g.via === via && String(g.resumen || '').startsWith(`huella ${linea.huella} `))) {
    return { codigo: 2, motivo: `no quedó el renglón ${FIRMADA} en el registro del arnés${reg.error ? ` (${reg.error})` : ''}: sin él la constancia no vale, y no la escribo` };
  }
  try {
    fs.mkdirSync(m.carpeta, { recursive: true });
    fs.appendFileSync(path.join(m.carpeta, FILE), `${JSON.stringify(linea)}\n`);
  } catch (e) { return { codigo: 2, motivo: `no pude escribir ${FILE} (${e.code || e.message})` }; }
  const entrada = { que: `saltear «pruebas primero»: ${linea.motivo}`, tipo: 'manual', quien: 'dueño', via: `sign-atdd-skip (${via})`,
    aprobacion: require('./approvals.js').aprobacionDe(r, FIRMA) };
  try {
    if (aprobar) aprobar(linea, entrada);
    else require('./approvals.js').anotar(m.carpeta, entrada);
  } catch (e) { return { codigo: 0, linea, aviso: `la aprobación no quedó en approvals.jsonl (${e.message || e})` }; }
  return { codigo: 0, linea };
}

module.exports = {
  FILE, MOSTRADA, FIRMADA, FIRMA, huella, comandos, carpetaReal, carpetaDe, muestra, ultimaMuestra, leer, vigente, decidir, firmar,
};
