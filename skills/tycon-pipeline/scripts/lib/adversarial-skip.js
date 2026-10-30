'use strict';
/**
 * adversarial-skip.js — la constancia firmada por el dueño para saltear el pase adversarial (@story-8.116).
 *
 * Todo pedido de saltear el pase (`--no-deep-review`, `TYCON_NO_DEEP_REVIEW=1`, `deep_review: off`, `set-size
 * liviana` con código, `mark-adversarial-skipped`) es un pedido: sin constancia el pase corre. El lugar que recibe el
 * pedido anota la MUESTRA (`adversarial-skip-shown` en el `gates.log` de la casa de la cuenta: story, carpeta de la
 * ejecución, la ejecución y el camino) e imprime los dos comandos de firma. El dueño firma
 * `marker.js sign-adversarial-skip --story S --reason R` en la ventana de permiso, o con `--terminal` en su terminal
 * (`owner-window.js` `exigir`). La firma toma la ejecución y el camino de la última muestra de S, y escribe en orden:
 * el renglón `adversarial-skip-signed` (con la huella en su `resumen`), la línea de `<carpeta>/adversarial-skips.jsonl`
 * y la de `approvals.jsonl`.
 *
 * Una constancia vale para una ejecución: la misma story, la misma carpeta y la misma ejecución (`startedAt` del
 * marcador; la carpeta se reusa entre ejecuciones), su huella entera y su renglón en el registro de la casa de la
 * cuenta (`real-home.js`, que no mira `HOME`). Lo que no se puede decidir no saltea.
 *
 * Límite: lo que corre un intérprete con el mismo usuario puede escribir los dos archivos. El freno de la terminal
 * (`on-bash-write-gate.js`, la escritura directa al estado del pipeline) para la redirección, `tee` y `cp` sobre el
 * registro, no un `open()` desde python o node. La constancia sube la vara (dos archivos con la misma huella, uno
 * fuera del repo), no la vuelve imposible.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { stateDir } = require('./state-dir.js');

const FILE = 'adversarial-skips.jsonl';
const MOSTRADA = 'adversarial-skip-shown';
const FIRMADA = 'adversarial-skip-signed';
const FIRMA = 'adversarial-skip';
const MARKER = path.join(__dirname, '..', 'marker.js');
const CAMPOS = ['story', 'carpeta', 'ejecucion', 'camino', 'motivo', 'ts', 'via', 'quien'];
const PROHIBIDAS = ['--quote', '--relayed-by', '--ok'];

const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const valor = (v) => (v == null ? null : String(v));
const sh = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

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

/** La huella de una constancia: sha256 de sus ocho campos, 16 hex. */
const huella = (l) => sha(CAMPOS.map((k) => valor(l && l[k]))).slice(0, 16);
const huellaCorta = (m) => sha([m.story, m.carpeta, m.ejecucion, m.camino].map(valor)).slice(0, 8);

/** Los dos comandos de firma: el que pide la ventana y el de la terminal del dueño. */
function comandos(story) {
  const base = `node ${MARKER} sign-adversarial-skip --story ${story} --reason "<motivo>"`;
  return [base, `${base} --terminal`];
}

function leerRegistro(casa) {
  let raw;
  try { raw = fs.readFileSync(registro(casa), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { renglones: [] };
    return { renglones: [], error: e.code || e.message };
  }
  // Un renglón roto no cuenta como firma; se cuenta para decirlo cuando ninguna firma vale.
  const renglones = [];
  let rotos = 0;
  for (const l of raw.split('\n')) {
    if (!l.includes(FIRMA)) continue;
    try { renglones.push(JSON.parse(l)); } catch (_) { rotos++; }
  }
  return { renglones, rotos };
}

/**
 * Anota la muestra del pedido y devuelve el texto para el dueño. `{ renglon, texto, comandos }`, o con `error` si no se
 * pudo anotar (el texto lo dice: sin muestra no hay firma posible).
 */
function muestra({ story, carpeta: dada, ejecucion, camino, casa, userInfo, ahora = Date.now() } = {}) {
  const cmds = comandos(story);
  // La firma escribe en la carpeta de la muestra: anotada relativa, quedaría donde esté parado quien firma.
  const carpeta = dada == null ? dada : carpetaReal(dada);
  const renglon = { ts: new Date(ahora).toISOString(), name: MOSTRADA, status: 'ok', story: valor(story), carpeta: valor(carpeta), ejecucion: valor(ejecucion), camino: valor(camino) };
  renglon.huella = huellaCorta(renglon);
  const cabeza = `🔒 ${camino} es un pedido de saltear el pase adversarial, no un salteo: sin la firma de una persona el pase corre.\n`
    + `   Muestra ${renglon.huella} · story ${story} · ejecución ${ejecucion} · ${carpeta}\n`;
  let error = null;
  try {
    const c = casaDe(casa, userInfo);
    if (!casa && casaDistinta(c)) throw new Error('HOME apunta a otra casa que la de la cuenta');
    fs.mkdirSync(stateDir(c), { recursive: true });
    fs.appendFileSync(registro(c), `${JSON.stringify(renglon)}\n`);
  } catch (e) { error = (e && e.message) || String(e); }
  const texto = error
    ? `${cabeza}   No pude anotar la muestra (${error}): sin ella no hay firma posible, y el pase corre.\n`
      + `   Con la muestra anotada, una persona firma con: ${cmds[0]}  (o en su terminal: ${cmds[1]})\n`
    : `${cabeza}   Para saltearlo, que lo firme una persona, no el agente:\n     en la ventana de permiso: ${cmds[0]}\n     en su terminal:           ${cmds[1]}\n`;
  return { renglon, texto, comandos: cmds, ...(error ? { error } : {}) };
}

/** La última muestra de la story en el registro de la casa, o null. Un registro que está y no se lee lanza. */
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

/** La carpeta absoluta y sin enlaces (la de la carpeta madre si ésta todavía no existe): la misma ejecución da la misma. */
function carpetaReal(carpeta) {
  const abs = path.resolve(String(carpeta));
  try { return fs.realpathSync(abs); } catch (_) { /* todavía no existe */ }
  try { return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch (_) { return abs; }
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
  if (l.story == null || l.carpeta == null || l.ejecucion == null || story == null || carpeta == null) return 'la constancia no nombra su story o su ejecución';
  if (String(l.story) !== String(story)) return `es de otra story (${l.story})`;
  if (!path.isAbsolute(String(l.carpeta)) || carpetaReal(l.carpeta) !== carpetaReal(carpeta)) return 'es de otra ejecución (otra carpeta)';
  if (String(l.ejecucion) !== String(ejecucion)) return `es de una ejecución ya cerrada (${l.ejecucion})`;
  if (!['ventana', 'terminal'].includes(l.via) || l.quien !== 'dueño' || !l.camino || !l.motivo || !l.ts) return 'le falta un campo (vía, quién, camino, motivo u hora)';
  if (l.huella !== huella(l)) return 'su huella no coincide con lo que dice (se cambió después de firmarla)';
  const ok = renglones.some((g) => g.name === FIRMADA && g.status === 'ok' && g.via === l.via && String(g.resumen || '').startsWith(`huella ${l.huella} `));
  if (!ok) return 'no tiene su renglón adversarial-skip-signed en el registro del arnés de esta cuenta (no la firmó una persona en esta máquina)';
  return null;
}

/**
 * ¿Hay una constancia que valga para esta ejecución? `{ ok: true, linea }` con la más nueva que vale, o `{ ok: false,
 * motivo, ninguna? }`. Una línea ilegible, o un registro que no se lee, no deja decidir: no vale.
 */
function vigente(o = {}) {
  const v = validas(o);
  return v.ok ? { ok: true, linea: v.lineas[0] } : v;
}

/** Todas las constancias que valen para esta ejecución, de la más nueva a la más vieja: `{ ok: true, lineas }` o el `{ ok: false, … }` de `vigente`. */
function validas({ story, carpeta, ejecucion, casa, userInfo } = {}) {
  if (!carpeta) return { ok: false, motivo: 'no hay una ejecución abierta de esta story', ninguna: true };
  const { lineas, ilegibles, error } = leer(carpeta);
  if (error) return { ok: false, motivo: `no pude leer ${FILE} (${error})` };
  if (ilegibles) return { ok: false, motivo: `${FILE} tiene ${ilegibles} línea(s) ilegible(s)` };
  if (!lineas.length) return { ok: false, motivo: 'no hay constancia firmada', ninguna: true };
  let c;
  try { c = casaDe(casa, userInfo); } catch (e) { return { ok: false, motivo: e.message }; }
  const reg = leerRegistro(c);
  if (reg.error) return { ok: false, motivo: `no pude leer el registro del arnés (${reg.error})` };
  let primero = null;
  const buenas = [];
  for (let i = lineas.length - 1; i >= 0; i--) {
    const m = motivoDe(lineas[i], { story, carpeta, ejecucion, renglones: reg.renglones });
    if (!m) buenas.push(lineas[i]);
    else if (!primero) primero = m;
  }
  if (buenas.length) return { ok: true, lineas: buenas };
  const rotos = reg.rotos ? ` (el registro tiene ${reg.rotos} renglón(es) de firma ilegible(s), que no cuentan)` : '';
  return { ok: false, motivo: `la constancia no vale: ${primero}${rotos}` };
}

/** Lo que anota `mark-adversarial-skipped`: el salteo con la constancia que lo firmó. */
function salteoDelPorton(gate, { archivos = 0, abandonado = false, runId = null, at } = {}) {
  const s = (gate && gate.adversarial_skip) || null;
  return {
    motivo: (gate && gate.reason) || null, archivos, abandonado, runId, at,
    ...(s ? { firmado: { via: s.via, quien: s.quien, cuando: s.cuando, huella: s.huella } } : {}),
  };
}

/** Con el pedido: la constancia vigente (`ok: true`), o la muestra anotada y su texto (`ok: false`). */
function pedirFirma({ story, carpeta, ejecucion, camino, casa, userInfo, ahora } = {}) {
  const v = vigente({ story, carpeta, ejecucion, casa, userInfo });
  if (v.ok) return { ok: true, linea: v.linea };
  const m = muestra({ story, carpeta, ejecucion, camino, casa, userInfo, ahora });
  return { ok: false, motivo: v.motivo, texto: m.texto, comandos: m.comandos };
}

/**
 * Las firmas con que la ejecución se salteó el pase: la de `mark-adversarial-skipped` y la de `set-size liviana`
 * mientras la ejecución siga liviana. `[{ camino, firmado }]`.
 */
function firmasDelSalteo(marker) {
  const out = [];
  if (marker && marker.adversarialSkip && marker.adversarialSkip.firmado) out.push({ camino: 'mark-adversarial-skipped', firmado: marker.adversarialSkip.firmado });
  if (marker && marker.size === 'liviana' && marker.sizeForced && marker.sizeForced.firmado) out.push({ camino: 'set-size liviana', firmado: marker.sizeForced.firmado });
  return out;
}

/**
 * Los cierres: si la ejecución se salteó con firma (por cualquiera de los dos caminos), la constancia que lo firmó
 * tiene que seguir valiendo. null = se sostiene (o no hubo salteo firmado); si no, el motivo.
 */
function reverificar({ marker, carpeta, casa, userInfo } = {}) {
  const firmas = firmasDelSalteo(marker);
  if (!firmas.length) return null;
  const v = validas({ story: marker.storyId, carpeta, ejecucion: marker.startedAt, casa, userInfo });
  if (!v.ok) return v.motivo;
  // Cada camino se sostiene con SU constancia: otra firma válida de la misma ejecución no la reemplaza ni la tumba.
  for (const { camino, firmado } of firmas) {
    if (!v.lineas.some((l) => l.huella === firmado.huella)) return `la constancia que firmó ${camino} (${firmado.huella}) ya no vale para esta ejecución`;
  }
  return null;
}

/**
 * `marker.js sign-adversarial-skip`. `exigir(o)` es el de `owner-window.js` (la ventana o la terminal); `aprobar(linea)`
 * anota la aprobación de siempre (por defecto, `approvals.jsonl` de la carpeta). `{ codigo, motivo?, linea? }`: 0
 * firmó; 1 no se firmó; 2 se firmó y no quedó escrito, o falta algo del pedido. Nada escrito salvo con 0 (y el
 * renglón de la firma, si fue lo que no se pudo comprobar).
 */
function firmarSalteo({ story, motivo, argv = [], sesion = null, casa, userInfo, ahora = Date.now(), maquina, exigir, aprobar } = {}) {
  const prohibida = PROHIBIDAS.find((b) => argv.some((w) => w === b || String(w).startsWith(`${b}=`)));
  if (prohibida) return { codigo: 1, motivo: `${prohibida} no firma: el salteo lo firma una persona en la ventana de permiso (este comando sin ${prohibida}) o en su terminal (--terminal)` };
  if (!story || !String(motivo || '').trim()) return { codigo: 2, motivo: 'faltan --story <S> y --reason "<motivo>"' };
  let c;
  try { c = casaDe(casa, userInfo); } catch (e) { return { codigo: 2, motivo: e.message }; }
  if (!casa && casaDistinta(c)) return { codigo: 2, motivo: 'HOME apunta a otra casa que la de la cuenta: la firma se lee de la casa de la cuenta' };
  let m;
  try { m = ultimaMuestra({ story, casa: c }); } catch (e) { return { codigo: 2, motivo: `${e.message}: no se firma sin poder ver la muestra` }; }
  if (!m) return { codigo: 1, motivo: `no hay una muestra del pedido para la story ${story}: corré primero el pedido (el portón, start, set-size o mark-adversarial-skipped)` };
  const previas = leer(m.carpeta);
  if (previas.error || previas.ilegibles) return { codigo: 1, motivo: `${FILE} de la ejecución no se lee (${previas.error || `${previas.ilegibles} línea(s) ilegible(s)`}): no se firma sobre un archivo roto` };
  const via = argv.includes('--terminal') ? 'terminal' : 'ventana';
  const linea = { ts: new Date(ahora).toISOString(), story: String(story), carpeta: m.carpeta, ejecucion: m.ejecucion, camino: m.camino, motivo: String(motivo).trim(), via, quien: 'dueño', maquina: maquina || null };
  linea.huella = huella(linea);
  let r;
  try {
    r = exigir({ firma: FIRMA, argv, resumen: `huella ${linea.huella} · story ${story} · ${linea.motivo}`, casa: c, propia: sesion || undefined });
  } catch (e) { return { codigo: 2, motivo: `no pude dejar el renglón de la firma (${(e && e.message) || e})` }; }
  if (!r || r.codigo !== 0) return { codigo: (r && r.codigo) || 1, motivo: (r && r.motivo) || 'no se firmó' };
  if (r.via && r.via !== via) return { codigo: 2, motivo: `la firma volvió por otra vía (${r.via})` };
  const reg = leerRegistro(c);
  if (reg.error || !reg.renglones.some((g) => g.name === FIRMADA && g.status === 'ok' && g.via === via && String(g.resumen || '').startsWith(`huella ${linea.huella} `))) {
    return { codigo: 2, motivo: `no quedó el renglón ${FIRMADA} en el registro del arnés${reg.error ? ` (${reg.error})` : ''}: sin él la constancia no vale, y no la escribo` };
  }
  try {
    fs.mkdirSync(m.carpeta, { recursive: true });
    fs.appendFileSync(path.join(m.carpeta, FILE), `${JSON.stringify(linea)}\n`);
  } catch (e) { return { codigo: 2, motivo: `no pude escribir ${FILE} (${e.code || e.message})` }; }
  const entrada = { que: `saltear el pase adversarial: ${linea.motivo}`, tipo: 'manual', quien: 'dueño', via: `sign-adversarial-skip (${via})` };
  try {
    if (aprobar) aprobar(linea, entrada);
    else require('./approvals.js').anotar(m.carpeta, entrada);
  } catch (e) { return { codigo: 0, linea, aviso: `la aprobación no quedó en approvals.jsonl (${e.message || e})` }; }
  return { codigo: 0, linea };
}

module.exports = {
  FILE, MOSTRADA, FIRMADA, FIRMA, CAMPOS, huella, huellaCorta, comandos, casaDistinta, sh,
  carpetaReal, muestra, ultimaMuestra, leer, vigente, validas, salteoDelPorton, pedirFirma, firmasDelSalteo, reverificar, firmarSalteo,
};
