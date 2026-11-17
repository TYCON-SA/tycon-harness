'use strict';
/**
 * delegation-routing.js — la firma delegable que pide la sesión que trabaja, para sí, va a la coordinadora.
 *
 * El freno (owner-window.js `decidir`) le pregunta a `delegable()` si esa firma, para esa sesión, la puede firmar la
 * coordinadora: las mismas llaves de `delegaSinVentana`, preguntadas como si la corriera ella desde su carpeta. Si sí, la
 * niega sin ventana ni cuadro y anota el renglón de la lista de firmas con el comando exacto que va a correr ella
 * (`delegable.comando`: las rutas absolutas y `--for-session <sesión>` al final). `owner-next` se lo da sólo a la
 * coordinadora, y sólo si el pedido está en la conversación de la sesión que lo pidió. Si ella no está o no lo firma en
 * el plazo (`approvals.delegation_wait_minutes`), el renglón se lee como del dueño.
 *
 * Nada de acá firma: la firma sale sólo del proceso de la coordinadora, por el freno, con la delegación de siempre.
 */
const path = require('path');

const SKILL_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const { stateDir } = require(path.join(SKILL_LIB, 'state-dir.js'));
const cat = require('./signatures.js');

const sl = () => require('./signature-list.js');
const ow = () => require('./owner-window.js');

const PLAZO_MIN = 10;

/**
 * Las firmas que se desvían y las rutas que su guion resuelve contra la carpeta: la coordinadora corre el comando desde
 * otra, así que van absolutas. `conPunto`: las que valen `.` si faltan, y se agregan. `contra`: la que el guion resuelve
 * contra otra opción y no contra la carpeta (`--story` de la vuelta extra, contra su `--repo`). Las demás opciones de
 * cada guion se resuelven contra estas (`--out` y `--file` de los controles, contra `--root`) o contra el marcador de la
 * sesión destino (`--story` de `compare-waiver`, contra su repo: por eso no está). Una firma que no está acá no se
 * desvía: el camino corto (`adhoc-lane`) quedaría a nombre de la coordinadora y en su carpeta, y no tendría el mismo
 * efecto.
 */
const RUTAS = Object.freeze({
  'pending-approval': Object.freeze({ rutas: ['--repo'], conPunto: [] }),
  'refresh-after-main': Object.freeze({ rutas: ['--root'], conPunto: ['--root'] }),
  'extra-round': Object.freeze({ rutas: ['--repo', '--story'], conPunto: ['--repo'], contra: Object.freeze({ '--story': '--repo' }) }),
  'compare-waiver': Object.freeze({ rutas: [], conPunto: [] }),
  save: Object.freeze({ rutas: [], conPunto: [] }),
  'plan-approval': Object.freeze({ rutas: [], conPunto: [] }),
  'lost-run:particion': Object.freeze({ rutas: [], conPunto: [] }),
});

const no = (motivo, callar = false) => ({ ok: false, motivo, callar });
// lo que no se pudo leer queda dicho en el registro de errores de los ganchos: el camino sigue, pero no en silencio
function anotarError(casa, texto) {
  try { require('fs').appendFileSync(path.join(stateDir(casa), 'hook-errors.log'), `[${new Date().toISOString()}] delegation-routing: ${texto}\n`); } catch (_) { /* sin registro tampoco */ }
}
const comillas = (w) => (/^[\w@%+=:,./-]+$/.test(String(w)) ? String(w) : `'${String(w).split("'").join("'\\''")}'`);

/**
 * Las palabras que corre la coordinadora: las de la sesión con la ruta del guion y las rutas de la tabla absolutas, cada
 * vez que aparecen (contra `cwd`, la carpeta del pedido, o contra la opción de `contra`, como las resuelve el guion), y
 * `--for-session <destino>` al final. Una opción seguida de otra bandera, o al final, no tiene ruta y queda como vino.
 * null si la firma no está en la tabla, si una ruta viene con `=` o si hace falta la carpeta y no se sabe.
 */
function palabrasRuteadas(firma, palabras, destino, cwd) {
  const t = RUTAS[firma];
  if (!t || !Array.isArray(palabras) || !palabras.length) return null;
  const w = palabras.map(String);
  if (w.includes('--for-session') || w.some((x) => x.startsWith('--for-session='))) return null;
  if (t.rutas.some((o) => w.some((x) => x.startsWith(`${o}=`)))) return null;
  const necesita = !path.isAbsolute(w[0]) || t.rutas.some((o) => w.includes(o)) || t.conPunto.length > 0;
  if (necesita && !(typeof cwd === 'string' && path.isAbsolute(cwd))) return null;
  if (!path.isAbsolute(w[0])) w[0] = path.resolve(cwd, w[0]);
  const contra = t.contra || {};
  const conValor = (i) => i + 1 < w.length && !w[i + 1].startsWith('--');
  // la base de una opción de `contra`: el último valor de la otra (ya absoluto), o la carpeta
  const baseDe = (o) => {
    const i = w.lastIndexOf(contra[o]);
    return i >= 0 && conValor(i) ? w[i + 1] : cwd;
  };
  // primero las que se resuelven contra la carpeta, después las que dependen de otra
  for (const o of [...t.rutas].sort((a, b) => Number(Boolean(contra[a])) - Number(Boolean(contra[b])))) {
    for (let i = 0; i < w.length; i++) if (w[i] === o && conValor(i)) w[i + 1] = path.resolve(contra[o] ? baseDe(o) : cwd, w[i + 1]);
  }
  for (const o of t.conPunto) if (!w.includes(o)) w.push(o, path.resolve(cwd));
  return [...w, '--for-session', String(destino)];
}

/** El comando de las palabras canónicas (la ruta del guion primero), con comillas sólo donde hacen falta. */
function comandoDe(palabras) {
  const lanzador = path.basename(palabras[0]).endsWith('.sh') ? 'bash' : 'node';
  return `${lanzador} ${palabras.map(comillas).join(' ')}`;
}

/** Los minutos que espera a la coordinadora un renglón desviado, en ms: `approvals.delegation_wait_minutes`, o 10. */
function plazoMs({ casa, arnes, env } = {}) {
  try {
    const v = require('./tycon-config.js').cargar({ home: casa, env: env || process.env, ...(arnes ? { arnes } : {}) }).valores.approvals.delegation_wait_minutes;
    return (Number.isInteger(v) && v >= 1 && v <= 60 ? v : PLAZO_MIN) * 60000;
  } catch (e) {
    anotarError(casa, `no pude leer approvals.delegation_wait_minutes (${e.message}): uso ${PLAZO_MIN} minutos`);
    return PLAZO_MIN * 60000;
  }
}

/**
 * ¿La coordinadora puede firmar `firma` para `destino`? `{ ok, coordinadora, cwdCoord, palabras, comando }`, o
 * `{ ok: false, motivo, callar }`: con `callar`, el motivo es lo normal (la firma no se delega, o no hay a quién) y no se
 * dice. `palabras`: las canónicas de la sesión, sin `--for-session`; `cwd`: la carpeta del pedido. `delegacion`: la de
 * verdad (`delegaSinVentana`) o la inyectada en las pruebas. Lo del perfil se pregunta antes de mirar si la coordinadora
 * vive: una firma que no se delega no dice «no hay coordinadora».
 */
function delegable({ firma, destino, casa, palabras, cwd, delegacion, plataforma = process.platform, arnes, env } = {}) {
  if (!sl().encendida({ casa, arnes, env })) return no('la lista de firmas está apagada', true);
  if (plataforma === 'win32') return no('en Windows no se delega');
  const s = cat.SIGNATURES.find((x) => x.id === firma);
  if (!s || s.kind !== 'guion' || s.otherSession !== 'yes') return no(`«${firma}» no se corre desde otra pestaña`, true);
  let d;
  try { d = require(path.join(SKILL_LIB, 'critical-waivers.js')).designacionVigente({ dir: stateDir(casa) }); } catch (e) { return no(`no pude leer la designación de la coordinadora (${e.message})`); }
  if (!d) return no('no hay coordinadora designada', true);
  if (d.error) return no(d.error);
  const coord = d.sesion;
  if (coord === destino) return no('la que pide es la coordinadora: lo suyo lo firma el dueño');
  const ses = sl().sesiones(casa);
  const x = ses.mapa.get(coord);
  const cwdCoord = (x && x.cwd) || null;
  const w = palabrasRuteadas(firma, palabras, destino, cwd);
  const conRutas = w || [...(palabras || []), '--for-session', String(destino)];
  const i = conRutas.indexOf('--repo');
  let r;
  try {
    r = (delegacion || ((o) => require('./delegated-signing.js').delegaSinVentana(o)))({ firma, sesion: coord, destino, home: casa, estado: stateDir(casa), cwd: cwdCoord, repo: i >= 0 ? conRutas[i + 1] : null });
  } catch (e) { r = { ok: false, motivo: `no pude consultar la delegación del perfil (${e.message})` }; }
  const motivo = (r && r.motivo) || 'la delegación no contestó';
  if (r && !r.ok && /no delega|sólo del dueño/.test(motivo)) return no(motivo, true);
  if (!RUTAS[firma]) return no(`«${firma}» no va a la coordinadora: su efecto depende de quién la corre`, true);
  if (sl().coordinadoraViva(casa, ses) !== coord) return no('no hay coordinadora confirmada y viva');
  if (!r || !r.ok) return no(motivo);
  if (!cwdCoord) return no('no sé desde qué carpeta trabaja la coordinadora');
  if (!w) return no('no sé desde qué carpeta se pidió la firma');
  return { ok: true, coordinadora: coord, cwdCoord, palabras: w, comando: comandoDe(w) };
}

/**
 * ¿El pedido que anotó el renglón está en la conversación de `sesion`? `{ ok }` o `{ ok: false, motivo }`. Busca el
 * `tool_use` de Bash con ese id en la cadena de su pedido (`enLaCadena`), con el comando byte por byte, y algún registro
 * que lo tenga de padre (el `tool_result` que Claude Code escribe después de negarlo): uno agregado al final por fuera no
 * tiene hijos. Límite: dos registros escritos a mano pasan, como en el resto de `person-ok.js`.
 */
function pedidoEnLaConversacion({ casa, sesion, toolUseId, comando } = {}) {
  const nop = (motivo) => ({ ok: false, motivo });
  if (!toolUseId) return nop('el renglón no dice qué pedido lo anotó');
  const P = require(path.join(SKILL_LIB, 'person-ok.js'));
  const conv = P.leerConversacion({ home: casa, sesion, env: {} });
  if (!conv.legible) return nop(`no pude leer la conversación de ${sesion} (${conv.motivo})`);
  const contenido = (r) => (r && r.message && Array.isArray(r.message.content) ? r.message.content : []);
  const esElPedido = (b) => b && b.type === 'tool_use' && b.id === toolUseId;
  const reg = P.enLaCadena(conv.registros, { pedido: toolUseId }).find((r) => r.type === 'assistant' && contenido(r).some(esElPedido));
  if (!reg) return nop(`el pedido ${toolUseId} no está en la conversación de ${sesion}`);
  const uso = contenido(reg).find(esElPedido);
  if (uso.name !== 'Bash' || !uso.input || uso.input.command !== comando) return nop(`el pedido ${toolUseId} de la conversación de ${sesion} no es ese comando`);
  const conHijo = conv.registros.some((r) => r && r !== reg && !r.isSidechain && (r.parentUuid === reg.uuid || r.logicalParentUuid === reg.uuid));
  if (!conHijo) return nop(`el pedido ${toolUseId} no tiene nada escrito después en la conversación de ${sesion}`);
  return { ok: true };
}

/** ¿El renglón desviado sigue siendo de la coordinadora `coord` (confirmada y viva) a la hora `ahora`? */
function vigente(f, { coord, ahora, plazo }) {
  return Boolean(f && f.delegable && coord && f.delegable.coordinadora === coord && Number.isFinite(f.at) && ahora - f.at <= plazo);
}

/**
 * Lo que `owner-next` comprueba antes de darle el comando a la coordinadora: la forma del comando desviado, las llaves
 * (repetidas con lo que pidió la sesión, y tienen que dar el mismo comando) y el pedido en la conversación. `{ saltado }`
 * si el renglón no se da (no tiene la forma o no pasa las llaves); `{ ok: false, motivo }` si el pedido no se encuentra
 * (el renglón pasa al dueño); `{ ok: true, cwd }` si se da.
 */
function comprobarRenglon({ f, casa, delegacion, arnes, env }) {
  const d = f.delegable;
  const forma = `su comando no tiene la forma de su firma «${f.firma}»`;
  const can = ow().canonicaDe(d.comando);
  const deSuFirma = (c) => c && (c.id === f.firma || (f.firma === 'refresh-after-main' && c.id === 'control-change'));
  if (!deSuFirma(can)) return { saltado: forma };
  const i = can.palabras.indexOf('--for-session');
  if (i < 0 || i !== can.palabras.length - 2 || can.palabras[i + 1] !== f.destino) return { saltado: forma };
  const pedido = ow().canonicaDe(f.comando);
  if (!deSuFirma(pedido)) return { saltado: forma };
  const r = delegable({ firma: f.firma, destino: f.destino, casa, palabras: pedido.palabras, cwd: f.cwd, delegacion, arnes, env });
  if (!r.ok) return { saltado: r.motivo };
  if (r.comando !== d.comando) return { saltado: 'su comando no es el que arma el desvío para ese pedido' };
  const c = pedidoEnLaConversacion({ casa, sesion: f.destino, toolUseId: d.tool_use_id, comando: f.comando });
  return c.ok ? { ok: true, cwd: r.cwdCoord } : { ok: false, motivo: c.motivo };
}

/** El renglón abierto con esa clave que se desvió a la coordinadora, o null: su firma lleva `routed`. */
function renglonDesviado({ casa, key, ahora = Date.now(), arnes, env } = {}) {
  if (!key) return null;
  try { return sl().abiertos(casa, { arnes, env, ahora }).filas.find((f) => f.key === key && f.delegable) || null; } catch (e) {
    anotarError(casa, `no pude leer la lista de firmas para saber si la firma cerró un renglón desviado (${e.message}): queda sin routed`);
    return null;
  }
}

/** Los ids de `filas` que firma la coordinadora (desviados, dentro del plazo y con ella viva): no esperan al dueño. */
function deLaCoordinadora({ casa, filas, ahora = Date.now(), arnes, env } = {}) {
  const ids = new Set();
  if (!(filas || []).some((f) => f && f.delegable)) return ids;
  const coord = sl().coordinadoraViva(casa);
  const plazo = plazoMs({ casa, arnes, env });
  for (const f of filas) if (sl().tipoDe(f) === 'firma' && vigente(f, { coord, ahora, plazo })) ids.add(f.id);
  return ids;
}

module.exports = { RUTAS, PLAZO_MIN, palabrasRuteadas, comandoDe, plazoMs, delegable, pedidoEnLaConversacion, vigente, comprobarRenglon, renglonDesviado, deLaCoordinadora };
