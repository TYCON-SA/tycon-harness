'use strict';
/**
 * harness-sign.js — `harness sign <firma>` y la salida de emergencia (esquema de frenos, etapa D).
 *
 * `sign` firma un id del catálogo (signatures.js: una firma de hoy o un id de la tabla de niveles) en la terminal de la
 * persona y lo anota en el registro común (signature-log.js, appendSignature) por la vía `command`. El nivel que rige es
 * el mayor entre el del catálogo y el que sube el perfil del equipo (`approvals.levels`): una excepción (nivel 2) o más
 * pide motivo. Sin el registro escrito la firma no vale: el comando lo dice y sale con error.
 *
 * Por ahora sólo la emergencia tiene efecto: los frenos todavía leen sus propias constancias, no el registro.
 *
 * La emergencia (`emergency`, nivel 3) es la única salida de un freno, para un solo comando: la firma la persona en su
 * terminal, nunca la ventana ni la delegación, con motivo. Nadie retipea el comando, porque sus comillas y sus barras no
 * llegan iguales desde PowerShell, cmd o bash:
 *   · cuando el freno de seguridad frena, guarda el texto exacto que leyó como un pedido con número (`pedir`) y el cartel
 *     da `--request <número>`; la terminal muestra ese comando antes de preguntar «¿Firmás? (s/n)» (en Windows, las tres
 *     palabras al azar de la ventana nueva);
 *   · `--commit` es para el control de los servidores de producción, que corre adentro del commit: vale para el próximo
 *     commit en el repo de la carpeta donde se firma (`consumirCommit`).
 * El pedido y el permiso viven en `emergency/` dentro de la carpeta de estado de la casa de la cuenta. Los dos vencen a
 * los 30 minutos y se usan una sola vez: un número usado o vencido no sirve.
 *
 * `acknowledge` es la constancia de una persona pedida desde Codex (`harness.js sign acknowledge --session <sesión>
 * --seal <sello> --text <texto>`): la conversación de Codex no distingue lo que tipeó la persona de lo que mete un
 * programa (guides/firmas-del-arnes.md §«En Codex»), así que se da en su terminal, con la misma pregunta que `sign`. No
 * es una firma del catálogo: no va al registro común. Deja una marca en `terminal-acknowledgments/` de la carpeta de
 * estado, atada al renglón exacto que anota en el registro de aprobaciones (owner-approvals.js `anotar`), y
 * `buscar` exige las dos. No firma si entre los procesos que la lanzaron está la herramienta del agente o Codex.
 *
 * La terminal, el registro, los niveles del perfil, la casa y la hora se pasan como parámetros en las pruebas.
 *
 * Por consola, para los frenos:
 *   node harness-sign.js consume              (el comando por stdin) sale 0 con el permiso consumido (el motivo por
 *                                             stdout); si no, deja o reusa el pedido y sale 1 con `pedido=<número>`, o 3
 *                                             si el permiso venció (con `motivo=`).
 *   node harness-sign.js consume-commit --repo <carpeta>   0 consumido, 1 sin permiso, 3 vencido.
 *   node harness-sign.js has-commit --repo <carpeta>       0 hay un permiso de commit vigente, 1 no; no gasta nada.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const cat = require('./signatures.js');
const { casaDeLaCuenta } = require('./real-home.js');

const LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const stateDir = (casa) => require(path.join(LIB, 'state-dir.js')).stateDir(casa);

const EMERGENCIA = 'emergency';
const VENCE_MIN = 30;
const COMMIT = 'git commit';
const NUMERO = /^[0-9a-f]{8}$/;
// La respuesta que firma: s, si o sí, en mayúscula o minúscula. Lo demás es «no», también «y» y «yes»: un programa que
// contesta que sí a todo (`yes |`) no firma. Lo que frena a un agente no es la respuesta, es mirar quién lanzó el comando
// (`origenDeVerdad`), que va antes de preguntar
const SI = /^s[ií]?$/i;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const una = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const esCommit = (comando) => /^git\s+commit(\s|$)/.test(String(comando));
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
const vigente = (ts, ahora) => { const edad = ahora - Date.parse(ts); return edad >= 0 && edad <= VENCE_MIN * 60000; };

function carpeta(casa) { return path.join(stateDir(casa === undefined ? casaDeLaCuenta() : casa), 'emergency'); }
const carpetaPedidos = (casa) => path.join(carpeta(casa), 'pedidos');
// las marcas de la constancia de Codex: las escribe sólo `acknowledge`, y los frenos de escritura las cuidan como al
// registro de aprobaciones (story-gate.js, on-bash-write-gate.js)
function carpetaConstancias(casa) { return path.join(stateDir(casa === undefined ? casaDeLaCuenta() : casa), 'terminal-acknowledgments'); }
const archivoDeMarca = (casa, sesion, ts) => path.join(carpetaConstancias(casa), `${sha256(`${sesion}\n${ts}`)}.json`);
const SESION = /^[\w-]+$/;

/** La entrada del catálogo de un id: `{ level, approves }`, o null si no está. */
function entrada(id) {
  const s = cat.SIGNATURES.find((x) => x.id === id);
  if (s) return { level: s.level, approves: s.approves };
  const l = cat.LEVELS.find((x) => x.id === id);
  return l ? { level: l.level, approves: l.approves } : null;
}

/**
 * El nivel que rige: el mayor entre el del catálogo y el que sube el perfil. Un valor menor no lo baja. null si el id no
 * está. Para un id de la tabla de niveles es el mismo cálculo que el sitio (signatures.js, effectiveLevel); una firma de
 * hoy, con su nivel.
 */
function nivelEfectivo(id, levels) {
  if (typeof cat.effectiveLevel === 'function' && cat.LEVELS.some((l) => l.id === id)) return cat.effectiveLevel(id, levels);
  const e = entrada(id);
  if (!e) return null;
  const subido = levels && Number.isInteger(levels[id]) ? levels[id] : 0;
  return Math.max(e.level, subido);
}

/** La carpeta del repo de un commit: la raíz de git de `cwd`, o `cwd` si no es un repo. */
function repoDe(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return real(r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd);
}

// En Windows la terminal no se lee: el comando se corre otra vez en una ventana de consola nueva y ahí se firma, con
// tres palabras al azar (runtime-waiver.js, igual que las demás firmas por terminal de owner-window.js)
function ttyDeVerdad() {
  const rw = require(path.join(LIB, 'runtime-waiver.js'));
  return {
    windows: rw.esWindows(), hay: rw.hasTty, preguntar: rw.promptTty, confirmarFrase: rw.confirmarFrase,
    enVentana: () => process.env[rw.MARCA_VENTANA] === '1', abrir: (o) => rw.abrirVentana(o), dentro: () => rw.dentroDeLaVentana(),
  };
}

/**
 * ¿Lo lanzó la herramienta del agente, con cualquier envoltura (una terminal propia, `script`, un pty, una copia del
 * guion con otro nombre)? Mira los padres del proceso en el árbol de la máquina (owner-window.js). Sin árbol no se sabe:
 * no firma. En Windows el árbol no se lee; ahí cuida la ventana nueva, que una consola del agente no pasa.
 * `sinCodex`: tampoco firma si en la cadena está Codex (lo pide la constancia de Codex).
 */
function origenDeVerdad({ pid = process.pid, arbol, sinCodex = false } = {}) {
  const ow = require('./owner-window.js');
  const a = arbol === undefined ? ow.leerArbol() : arbol;
  if (!a) return { ok: false, motivo: 'no pude ver qué procesos lanzaron este comando, y sin eso no firmo: probá de nuevo en tu terminal' };
  const m = new Map(a.map((p) => [p.pid, p]));
  const cortada = { ok: false, motivo: 'no pude seguir la cadena de procesos que lanzó este comando, y sin eso no firmo: probá de nuevo en tu terminal' };
  // la cadena tiene que llegar al sistema (el proceso sin padre); si se corta antes, no se sabe quién la lanzó
  const vistos = new Set();
  let p = m.get(pid);
  if (!p) return cortada;
  while (true) {
    if (ow.esHerramienta(p)) return { ok: false, motivo: 'lo lanzó la herramienta del agente: se firma en una terminal tuya, fuera de la herramienta' };
    if (sinCodex && esCodex(p)) return { ok: false, motivo: 'lo lanzó Codex: la constancia se da en una terminal tuya, fuera de Codex' };
    vistos.add(p.pid);
    if (p.ppid === 0 || p.ppid === p.pid) return { ok: true };
    const padre = m.get(p.ppid);
    if (!padre || vistos.has(padre.pid)) return cortada;
    p = padre;
  }
}

/**
 * ¿El proceso es Codex? Su ejecutable o su primera palabra se llama `codex` (o `codex.exe`), o es un intérprete (`node`,
 * `bun`) cuyo guion (el primer argumento que no es una opción) es `codex` o `codex.js`, o está dentro del paquete
 * `@openai/codex`. La línea se corta después del ejecutable, como en `esHerramienta` (su ruta puede tener espacios), y
 * una primera palabra entre comillas va entera. Una ruta del guion con espacios se mira hasta el `codex` que la cierra:
 * un `codex` suelto en los argumentos (el texto de una constancia) no es el guion.
 */
function esCodex(p) {
  const linea = String((p && p.comando) || '').trim();
  const exe = p && p.ejecutable ? String(p.ejecutable) : '';
  const crudo = (x) => String(x || '').split(/[\\/]/).pop();
  let programa;
  let resto;
  if (exe && linea.startsWith(exe)) { programa = exe; resto = linea.slice(exe.length); } else if (exe && linea.startsWith(`"${exe}"`)) {
    programa = exe; resto = linea.slice(exe.length + 2);
  } else {
    const m = linea.match(/^"([^"]*)"|^'([^']*)'|^(\S*)/);
    programa = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    resto = linea.slice(m[0].length);
    if (exe) programa = exe;
  }
  if (/^codex(\.exe)?$/i.test(crudo(programa))) return true;
  if (!/^(node|bun)(\.exe)?$/i.test(crudo(programa))) return false;
  const guion = resto.replace(/^(\s+-\S*)+/, '').trim().replace(/^["']/, '');
  // la marca de Codex tiene que estar en la ruta del guion: antes de ella no puede empezar otra opción (« -»)
  const enElGuion = (re) => { const m = guion.match(re); return Boolean(m) && !/\s-/.test(guion.slice(0, m.index)); };
  return enElGuion(/[\\/]@openai[\\/]codex[\\/]/i) || enElGuion(/(?:^|[\\/])codex(?:\.js)?(?=["']?(?:\s|$))/i);
}

/**
 * El comando como se lee en la terminal: los caracteres que no se ven (saltos de línea, retornos, códigos de pantalla,
 * los que dan vuelta el texto) quedan escritos como `\u{…}`. Así lo que la persona lee es el texto entero que firma.
 */
// armada con códigos y no con los caracteres: dos de ellos cortan la línea del fuente
const INVISIBLES = new RegExp(`[${['0000-001f', '007f-009f', '00ad', '061c', '200b-200f', '2028-202e', '2060-2064', '2066-2069', 'feff']
  .map((r) => r.split('-').map((h) => `\\u${h}`).join('-')).join('')}]`, 'g');

function aLaVista(texto) {
  let raro = false;
  const visto = String(texto).replace(INVISIBLES, (c) => {
    raro = true;
    return `\\u{${c.codePointAt(0).toString(16)}}`;
  });
  return { visto, raro };
}

function appendDeVerdad(renglon) {
  let log;
  try { log = require('./signature-log.js'); } catch (e) { return { ok: false, error: `no está el registro común de firmas (signature-log.js: ${e.code || e.message})` }; }
  return log.appendSignature(renglon);
}

function leer(archivo) { try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (_) { return null; } }

/** Escribe un JSON de una vez (archivo temporal y renombre), sólo para la cuenta. */
function escribir(archivo, datos) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true, mode: 0o700 });
  const tmp = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(datos)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, archivo);
}

/** Mueve un archivo a usado, consumido o vencido; false si otro ya lo movió. */
function mover(archivo, como, ahora) {
  try { fs.renameSync(archivo, `${archivo}.${como}-${ahora}`); return true; } catch (_) { return false; }
}

/** Borra lo de más de un día en las tres carpetas: pedidos, permisos y marcas de constancias, ya vencidos. Nunca falla. */
function barrer(casa, ahora) {
  for (const dir of [carpeta(casa), carpetaPedidos(casa), carpetaConstancias(casa)]) {
    let archivos = [];
    try { archivos = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of archivos) {
      const p = path.join(dir, f);
      try { const st = fs.lstatSync(p); if (st.isFile() && ahora - st.mtimeMs > 24 * 3600000) fs.rmSync(p); } catch (_) { /* otro ya lo borró */ }
    }
  }
}

/**
 * El pedido de una emergencia para el texto exacto que leyó el freno: reusa el vigente de ese mismo texto, o deja uno
 * nuevo. `{ ok, numero }` o `{ ok: false, error }`.
 */
function pedir({ casa, comando, ahora = Date.now() } = {}) {
  try {
    if (comando == null || comando === '') return { ok: false, error: 'sin comando' };
    barrer(casa, Date.now());
    const dir = carpetaPedidos(casa);
    const huella = sha256(comando);
    let archivos = [];
    try { archivos = fs.readdirSync(dir).filter((f) => NUMERO.test(f.replace(/\.json$/, '')) && f.endsWith('.json')); } catch (_) { archivos = []; }
    for (const f of archivos) {
      const p = leer(path.join(dir, f));
      if (p && p.sha256 === huella && p.comando === comando && vigente(p.ts, ahora)) return { ok: true, numero: p.numero };
    }
    const numero = crypto.randomBytes(4).toString('hex');
    escribir(path.join(dir, `${numero}.json`), { numero, comando, sha256: huella, ts: new Date(ahora).toISOString() });
    return { ok: true, numero };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
}

/** El pedido vigente con ese número, sin gastarlo: `{ ok, pedido, archivo }` o `{ ok: false, error }`. */
function pedidoVigente({ casa, numero, ahora }) {
  if (!NUMERO.test(String(numero || ''))) return { ok: false, error: `«${numero}» no es un número de pedido (ocho letras o números, del cartel del freno)` };
  const archivo = path.join(carpetaPedidos(casa), `${numero}.json`);
  const pedido = leer(archivo);
  if (!pedido || pedido.numero !== numero) return { ok: false, error: `no hay un pedido ${numero} sin usar: ya se usó, o el freno no lo dio` };
  if (!vigente(pedido.ts, ahora)) {
    mover(archivo, 'vencido', ahora);
    return { ok: false, error: `el pedido ${numero} venció (vale ${VENCE_MIN} minutos): que el agente repita el comando y el freno da otro número` };
  }
  return { ok: true, pedido, archivo };
}

/**
 * Firma `id` en la terminal y lo anota. Devuelve `{ code, lines }`: 0 firmó, 1 no firmó (la persona no contestó «s», o el
 * registro no escribió), 2 uso mal hecho o sin terminal (nada escrito).
 * La emergencia lleva `request` (el número del cartel del freno) o `commit`.
 * `levels`: lo que sube el perfil (`approvals.levels`); null si el perfil no se pudo leer (se pide motivo igual).
 * `via`: por dónde llega el pedido; en esta etapa, sólo `terminal` firma.
 * `argv`: el comando entero (el guion y sus argumentos), para correrlo otra vez en la ventana nueva de Windows.
 * `origen` (o `arbol`, el de los procesos): quién lanzó el comando; las pruebas lo pasan.
 */
function sign({ id, reason = '', request = null, commit = false, target = null, orderedBy = null, signer, via = 'terminal', tty, append, levels = {}, casa, cwd = process.cwd(), ahora = Date.now(), argv = process.argv.slice(1), origen, arbol } = {}) {
  const no = (code, ...lines) => ({ code, lines });
  const e = entrada(id);
  if (!e) return no(2, `harness sign: «${id}» no es un id del catálogo de firmas (guides/firmas-del-arnes.md)`);
  if (via !== 'terminal') {
    return no(2, `harness sign: ${id === EMERGENCIA ? 'la emergencia' : 'esta firma'} se da en tu terminal, nunca por la ventana ni por la delegación`);
  }
  const motivo = String(reason == null ? '' : reason).trim();
  const nivel = levels === null ? Math.max(e.level, 2) : nivelEfectivo(id, levels);
  if (nivel >= 2 && !motivo) {
    const porque = levels === null ? 'no pude leer el perfil del equipo para saber qué nivel le sube la organización' : `es de nivel ${nivel}`;
    return no(2, `harness sign: «${id}» pide un motivo (--reason "<por qué>"): ${porque}`);
  }
  if (id !== EMERGENCIA && (request || commit)) return no(2, 'harness sign: --request y --commit son de la emergencia');
  let comando = '';
  let pedido = null;
  if (id === EMERGENCIA) {
    if (Boolean(request) === Boolean(commit)) {
      return no(2, 'harness sign: la emergencia vale para un solo comando: el número que dio el cartel del freno (--request <número>), o el próximo commit de este repo (--commit)',
        '   harness sign emergency --reason "<por qué>" --request <número>');
    }
    if (request) {
      pedido = pedidoVigente({ casa, numero: request, ahora });
      if (!pedido.ok) return no(2, `harness sign: ${pedido.error}`);
      comando = pedido.pedido.comando;
    } else comando = COMMIT;
  }
  const t = tty || ttyDeVerdad();
  if (t.windows && t.enVentana && !t.enVentana()) {
    // el proceso de afuera no firma nada: sale con el código de la ventana, donde el comando corre otra vez entero
    const v = t.abrir({ programa: process.execPath, script: argv[0], args: argv.slice(1), titulo: 'Firma de la emergencia' });
    if (v.estado === 'vencida') return no(1, `harness sign: la ventana venció a los ${v.tope} s sin firmar`);
    if (v.estado !== 'cerrada') return no(1, `harness sign: no pude abrir la ventana para firmar (${v.motivo})`);
    return { code: v.codigo === 0 ? 0 : (v.codigo || 1), lines: [v.codigo === 0 ? '✅ firmado en la ventana nueva' : 'harness sign: no se firmó en la ventana nueva'] };
  }
  if (t.windows && t.dentro) t.dentro();
  if (!t.hay()) return no(2, 'harness sign: esta firma se da en tu terminal, y aquí no hay una: corré el comando vos, en tu terminal');
  if (!t.windows) {
    const o = (origen || (() => origenDeVerdad({ arbol })))();
    if (!o.ok) return no(2, `harness sign: ${o.motivo}`);
  }
  const vista = aLaVista(comando);
  const sobre = !comando ? '' : commit ? `.\nPara: el próximo commit en ${repoDe(cwd)}` : `.\nComando: ${vista.visto}`;
  const aviso = vista.raro ? '\n⚠️ El comando trae caracteres que no se ven (saltos de línea, retornos o códigos de pantalla): están escritos como \\u{…}. Firmá sólo si sabés por qué están.' : '';
  const que = `Firma: ${e.approves} (nivel ${nivel})${motivo ? `. Motivo: ${una(motivo, 300)}` : ''}${sobre}.${aviso}`;
  let ok;
  try {
    // en Windows la ventana dice qué se firma antes de pedir las tres palabras
    if (t.windows) { process.stderr.write(`\n${que}\n`); ok = t.confirmarFrase({}); }
    else ok = SI.test(String(t.preguntar(`\n${que}\n¿Firmás? (s/n) `) || '').trim());
  } catch (err) { return no(2, `harness sign: no pude leer tu terminal (${err.message})`); }
  if (!ok) return no(1, 'harness sign: no se firmó');

  const firmante = signer || (() => { try { return os.userInfo().username; } catch (_) { return null; } })();
  const r = (append || appendDeVerdad)({
    signature: id, via: 'command', signer: firmante, orderedBy: orderedBy || firmante, target: target || comando || null,
    reason: motivo, source: 'harness sign', home: casa,
  });
  if (!r || r.ok !== true) return no(1, `harness sign: el registro de firmas no escribió (${(r && r.error) || 'sin respuesta'}): la firma no vale`);
  if (id !== EMERGENCIA) return { code: 0, lines: [`✅ firmado: ${id} (nivel ${nivel}), anotado en ${r.path}`] };

  // el número se gasta antes de dejar el permiso: si otro ya lo usó, no hay dos permisos para un pedido
  if (pedido && !mover(pedido.archivo, 'usado', ahora)) return no(1, `harness sign: el pedido ${request} ya se usó: la firma quedó anotada, pero no deja otro permiso`);
  try {
    const huella = sha256(comando);
    escribir(path.join(carpeta(casa), `${huella}.json`), { comando, sha256: huella, motivo, firmante, repo: commit ? repoDe(cwd) : null, ts: new Date(ahora).toISOString() });
  } catch (err) {
    return no(1, `harness sign: la firma quedó anotada, pero no pude dejar el permiso de la emergencia (${err.code || err.message}): el freno lo va a seguir parando`);
  }
  return {
    code: 0,
    lines: commit
      ? [`✅ emergencia firmada para el próximo commit en este repo, por ${VENCE_MIN} minutos.`]
      : [`✅ emergencia firmada para un solo comando, por ${VENCE_MIN} minutos:`, `   ${comando}`, '   El agente lo repite tal cual y el freno lo deja pasar una vez.'],
  };
}

/**
 * La marca de la constancia de `sesion` dada a la hora `ts`, o null si no está. Tira si está pero no se puede leer o
 * está dañada: quien la pide dice por qué, en vez de «falta».
 */
function marcaDeConstancia({ casa, sesion, ts } = {}) {
  let texto;
  try { texto = fs.readFileSync(archivoDeMarca(casa, sesion, ts), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let m;
  try { m = JSON.parse(texto); } catch (_) { m = null; }
  if (!m || typeof m !== 'object') throw new Error('la marca está dañada');
  return m;
}

/**
 * `sign acknowledge`: la constancia de la persona pedida desde Codex, dada en su terminal. Muestra enteros la sesión, el
 * sello y el texto que contesta; si firma, deja la marca y después el renglón en el registro de aprobaciones, los dos
 * en la misma casa. Devuelve `{ code, lines }`: 0 anotada, 1 no firmó o no se pudo anotar, 2 uso mal hecho, sin
 * terminal o lanzada por la herramienta del agente o por Codex (nada escrito).
 * `tty`, `origen` (o `arbol` y `pid`), `casa`, `ahora` y `signer` se pasan en las pruebas; `argv`, como en `sign`.
 */
function acknowledge({ session, seal, text, tty, origen, arbol, pid = process.pid, casa, ahora = Date.now(), signer, argv = process.argv.slice(1) } = {}) {
  const no = (code, ...lines) => ({ code, lines });
  const sesion = String(session == null ? '' : session);
  const sello = String(seal == null ? '' : seal);
  const texto = String(text == null ? '' : text);
  if (!SESION.test(sesion)) return no(2, 'harness sign acknowledge: --session lleva el id de la sesión de Codex que pide la constancia (letras, números, «-» y «_»)');
  if (!sello.trim() || !texto.trim()) return no(2, 'harness sign acknowledge: --seal y --text llevan el sello y el texto que muestra la sesión; sin ellos no se sabe qué se contesta');
  const t = tty || ttyDeVerdad();
  if (t.windows && t.enVentana && !t.enVentana()) {
    const v = t.abrir({ programa: process.execPath, script: argv[0], args: argv.slice(1), titulo: 'Constancia en la terminal' });
    if (v.estado === 'vencida') return no(1, `harness sign acknowledge: la ventana venció a los ${v.tope} s sin firmar`);
    if (v.estado !== 'cerrada') return no(1, `harness sign acknowledge: no pude abrir la ventana para firmar (${v.motivo})`);
    return { code: v.codigo === 0 ? 0 : (v.codigo || 1), lines: [v.codigo === 0 ? '✅ constancia anotada en la ventana nueva' : 'harness sign acknowledge: no se firmó en la ventana nueva'] };
  }
  if (t.windows && t.dentro) t.dentro();
  if (!t.hay()) return no(2, 'harness sign acknowledge: la constancia se da en tu terminal, y aquí no hay una: corré el comando vos, en tu terminal');
  if (!t.windows) {
    const o = (origen || (() => origenDeVerdad({ arbol, pid, sinCodex: true })))();
    if (!o.ok) return no(2, `harness sign acknowledge: ${o.motivo}`);
  }
  const vistos = [sello, texto].map(aLaVista);
  const aviso = vistos.some((v) => v.raro) ? '\n⚠️ El sello o el texto traen caracteres que no se ven: están escritos como \\u{…}. Firmá sólo si sabés por qué están.' : '';
  const que = `Constancia para Codex, de la sesión ${sesion}: contestás lo que esa sesión te mostró.\nSello: ${vistos[0].visto}\nTexto: ${vistos[1].visto}${aviso}`;
  let ok;
  try {
    if (t.windows) { process.stderr.write(`\n${que}\n`); ok = t.confirmarFrase({}); } else ok = SI.test(String(t.preguntar(`\n${que}\n¿Firmás? (s/n) `) || '').trim());
  } catch (err) { return no(2, `harness sign acknowledge: no pude leer tu terminal (${err.message})`); }
  if (!ok) return no(1, 'harness sign acknowledge: no se firmó');

  // la misma casa para la marca y el renglón: si cayeran en cuentas distintas, la constancia no se encontraría
  const home = casa === undefined ? casaDeLaCuenta() : casa;
  const ts = new Date(ahora).toISOString();
  const firmante = signer || (() => { try { return os.userInfo().username; } catch (_) { return null; } })();
  const registro = { tipo: 'terminal', plataforma: 'codex', via: 'terminal', sesion, sello, texto, ts, firmante };
  barrer(home, Date.now());
  // la marca guarda la huella del renglón exacto que se anota (la misma con que el registro lo identifica)
  const marca = archivoDeMarca(home, sesion, ts);
  try {
    escribir(marca, { sesion, sello, texto, ts, renglon: sha256(JSON.stringify(registro)) });
  } catch (err) {
    return no(1, `harness sign acknowledge: no pude dejar la marca de la terminal (${err.code || err.message}): la constancia no vale`);
  }
  try { require('./owner-approvals.js').anotar(home, registro); } catch (err) {
    // sin renglón la marca no sirve: se saca, y si no se puede, la barre `barrer` al día siguiente
    try { fs.rmSync(marca, { force: true }); } catch (_) { /* queda para el barrido */ }
    return no(1, `harness sign acknowledge: no pude anotar en el registro de aprobaciones (${err.code || err.message}): la constancia no vale`);
  }
  return { code: 0, lines: [`✅ constancia anotada para la sesión ${sesion}: vale ${require('./owner-approvals.js').VENCE_MIN} minutos y una sola vez.`] };
}

function gastar(archivo, permiso, ahora) {
  if (!vigente(permiso.ts, ahora)) {
    mover(archivo, 'vencido', ahora);
    const edad = ahora - Date.parse(permiso.ts);
    return { ok: false, motivo: `la emergencia venció: se firmó hace ${Math.floor(edad / 60000)} minutos y vale ${VENCE_MIN}. Firmala de nuevo` };
  }
  if (!mover(archivo, 'consumido', ahora)) return null;
  return { ok: true, permiso };
}

/** Consume el permiso firmado para ESTE texto exacto. `{ ok: true, permiso }`, `{ ok: false, motivo }` si venció, o null. */
function consumir({ casa, comando, ahora = Date.now() } = {}) {
  if (comando == null || comando === '') return null;
  const archivo = path.join(carpeta(casa), `${sha256(comando)}.json`);
  const permiso = leer(archivo);
  if (!permiso || permiso.comando !== comando || permiso.repo) return null;
  return gastar(archivo, permiso, ahora);
}

/** El permiso de commit más nuevo firmado en ese repo, sin gastarlo: `{ archivo, permiso }` o null. */
function permisoDeCommit({ casa, repo }) {
  const dir = carpeta(casa);
  const donde = real(repo);
  let archivos = [];
  try { archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return null; }
  const candidatos = archivos.map((f) => ({ archivo: path.join(dir, f), permiso: leer(path.join(dir, f)) }))
    .filter((c) => c.permiso && c.permiso.comando === COMMIT && c.permiso.repo === donde)
    .sort((a, b) => Date.parse(b.permiso.ts) - Date.parse(a.permiso.ts));
  return candidatos[0] || null;
}

/** Consume el permiso de commit firmado en ese repo: el más nuevo. Igual que `consumir`. */
function consumirCommit({ casa, repo, ahora = Date.now() } = {}) {
  const c = permisoDeCommit({ casa, repo });
  return c ? gastar(c.archivo, c.permiso, ahora) : null;
}

/**
 * ¿Hay un permiso de commit vigente en ese repo? Lo mira sin gastarlo ni moverlo: es para el chequeo de sólo lectura,
 * que corre antes del commit y no puede dejarlo sin la emergencia.
 */
function hayPermisoDeCommit({ casa, repo, ahora = Date.now() } = {}) {
  const c = permisoDeCommit({ casa, repo });
  return Boolean(c && vigente(c.permiso.ts, ahora));
}

/** Los permisos sin gastar (para las pruebas y el diagnóstico). */
function permisos(casa) {
  try { return fs.readdirSync(carpeta(casa)).filter((f) => f.endsWith('.json')).map((f) => leer(path.join(carpeta(casa), f))).filter(Boolean); } catch (_) { return []; }
}

module.exports = { EMERGENCIA, VENCE_MIN, carpeta, entrada, nivelEfectivo, sign, pedir, consumir, consumirCommit, hayPermisoDeCommit, permisos, esCommit, origenDeVerdad, aLaVista,
  acknowledge, carpetaConstancias, marcaDeConstancia, esCodex };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'consume') {
    let comando = '';
    try { comando = fs.readFileSync(0, 'utf8'); } catch (_) { comando = ''; }
    const r = consumir({ comando });
    if (r && r.ok) { process.stdout.write(`${r.permiso.motivo}\n`); process.exitCode = 0; } else {
      const p = pedir({ comando });
      if (r) process.stdout.write(`motivo=${r.motivo}\n`);
      if (p.ok) process.stdout.write(`pedido=${p.numero}\n`);
      process.exitCode = r ? 3 : 1;
    }
  } else if (argv[0] === 'consume-commit' && argv[1] === '--repo' && argv[2]) {
    const r = consumirCommit({ repo: argv[2] });
    if (r) process.stdout.write(`${r.ok ? r.permiso.motivo : r.motivo}\n`);
    process.exitCode = !r ? 1 : (r.ok ? 0 : 3);
  } else if (argv[0] === 'has-commit' && argv[1] === '--repo' && argv[2]) {
    process.exitCode = hayPermisoDeCommit({ repo: argv[2] }) ? 0 : 1;
  } else {
    process.stderr.write('uso: harness-sign.js consume (el comando por stdin) | consume-commit --repo <carpeta> | has-commit --repo <carpeta>\n');
    process.exitCode = 2;
  }
}
