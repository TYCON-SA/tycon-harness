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
 * terminal, nunca la ventana ni la delegación, con motivo y el texto exacto del comando. Deja un permiso de un solo uso
 * que vence a los 30 minutos, en `emergency/` dentro de la carpeta de estado de la casa de la cuenta:
 *   · el freno de seguridad lo consume cuando el agente corre ESE texto, tal cual (`consumir`);
 *   · si el comando es un `git commit`, lo consume el próximo commit en ese repo (`consumirCommit`): el control de los
 *     servidores de producción corre adentro del commit y no ve el texto que lo lanzó.
 *
 * La terminal, el registro, los niveles del perfil, la casa y la hora se pasan como parámetros en las pruebas.
 *
 * Por consola, para los frenos (sale 0 con el permiso consumido, 1 sin permiso, 3 vencido; el motivo va por stdout):
 *   node harness-sign.js consume              (el comando por stdin)
 *   node harness-sign.js consume-commit --repo <carpeta>
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
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const una = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const esCommit = (comando) => /^git\s+commit(\s|$)/.test(String(comando));
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };

function carpeta(casa) { return path.join(stateDir(casa === undefined ? casaDeLaCuenta() : casa), 'emergency'); }

/** La entrada del catálogo de un id: `{ level, approves }`, o null si no está. */
function entrada(id) {
  const s = cat.SIGNATURES.find((x) => x.id === id);
  if (s) return { level: s.level, approves: s.approves };
  const l = cat.LEVELS.find((x) => x.id === id);
  return l ? { level: l.level, approves: l.approves } : null;
}

/** El nivel que rige: el mayor entre el del catálogo y el que sube el perfil. Un valor menor no lo baja. null si el id no está. */
function nivelEfectivo(id, levels) {
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

function ttyDeVerdad() {
  const rw = require(path.join(LIB, 'runtime-waiver.js'));
  return { hay: rw.hasTty, preguntar: rw.promptTty };
}

function appendDeVerdad(renglon) {
  let log;
  try { log = require('./signature-log.js'); } catch (e) { return { ok: false, error: `no está el registro común de firmas (signature-log.js: ${e.code || e.message})` }; }
  return log.appendSignature(renglon);
}

/** Escribe el permiso de la emergencia. `{ ok, archivo }` o `{ ok: false, error }`. */
function conceder({ casa, comando, motivo, firmante, cwd, ahora }) {
  try {
    const dir = carpeta(casa);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const huella = sha256(comando);
    const permiso = { comando, sha256: huella, motivo, firmante, repo: esCommit(comando) ? repoDe(cwd) : null, ts: new Date(ahora).toISOString() };
    const archivo = path.join(dir, `${huella}.json`);
    const tmp = `${archivo}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(permiso)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, archivo);
    return { ok: true, archivo };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
}

/**
 * Firma `id` en la terminal y lo anota. Devuelve `{ code, lines }`: 0 firmó, 1 no firmó (la persona no escribió
 * «firmo», o el registro no escribió), 2 uso mal hecho o sin terminal (nada escrito).
 * `levels`: lo que sube el perfil (`approvals.levels`); null si el perfil no se pudo leer (se pide motivo igual).
 * `via`: por dónde llega el pedido; en esta etapa, sólo `terminal` firma.
 */
function sign({ id, reason = '', command = null, target = null, orderedBy = null, signer, via = 'terminal', tty, append, levels = {}, casa, cwd = process.cwd(), ahora = Date.now() } = {}) {
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
  const comando = command == null ? '' : String(command);
  if (id === EMERGENCIA && !comando.trim()) {
    return no(2, 'harness sign: la emergencia vale para un solo comando: va después de --, entre comillas, tal cual lo va a correr el agente',
      '   harness sign emergency --reason "<por qué>" -- \'<comando>\'');
  }
  const t = tty || ttyDeVerdad();
  if (!t.hay()) return no(2, `harness sign: esta firma se da en tu terminal, y aquí no hay una: corré el comando vos, en tu terminal`);
  const que = `Firma: ${e.approves} (nivel ${nivel})${motivo ? `. Motivo: ${una(motivo, 300)}` : ''}${comando ? `.\nComando: ${comando}` : ''}.`;
  let dicho;
  try { dicho = t.preguntar(`\n${que}\nPara firmar, escribí «firmo»: `); } catch (err) { return no(2, `harness sign: no pude leer tu terminal (${err.message})`); }
  if (String(dicho || '').trim().toLowerCase() !== 'firmo') return no(1, 'harness sign: no se firmó');

  const firmante = signer || (() => { try { return os.userInfo().username; } catch (_) { return null; } })();
  const r = (append || appendDeVerdad)({
    signature: id, via: 'command', signer: firmante, orderedBy: orderedBy || firmante, target: target || comando || null,
    reason: motivo, source: 'harness sign', home: casa,
  });
  if (!r || r.ok !== true) return no(1, `harness sign: el registro de firmas no escribió (${(r && r.error) || 'sin respuesta'}): la firma no vale`);
  if (id !== EMERGENCIA) return { code: 0, lines: [`✅ firmado: ${id} (nivel ${nivel}), anotado en ${r.path}`] };

  const p = conceder({ casa, comando, motivo, firmante, cwd, ahora });
  if (!p.ok) return no(1, `harness sign: la firma quedó anotada, pero no pude dejar el permiso de la emergencia (${p.error}): el freno lo va a seguir parando`);
  return {
    code: 0,
    lines: [
      `✅ emergencia firmada para un solo comando, por ${VENCE_MIN} minutos:`,
      `   ${comando}`,
      esCommit(comando) ? '   La consume el próximo commit en este repo.' : '   La consume ese comando, tal cual. Otro texto no.',
    ],
  };
}

function leer(archivo) { try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (_) { return null; } }

/** Mueve el permiso a consumido o vencido; false si otro ya lo movió. */
function mover(archivo, como, ahora) {
  try { fs.renameSync(archivo, `${archivo}.${como}-${ahora}`); return true; } catch (_) { return false; }
}

function gastar(archivo, permiso, ahora) {
  const edad = ahora - Date.parse(permiso.ts);
  if (!(edad >= 0 && edad <= VENCE_MIN * 60000)) {
    mover(archivo, 'vencido', ahora);
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
  if (!permiso || permiso.comando !== comando) return null;
  return gastar(archivo, permiso, ahora);
}

/** Consume el permiso de un `git commit` firmado en ese repo: el más nuevo. Igual que `consumir`. */
function consumirCommit({ casa, repo, ahora = Date.now() } = {}) {
  const dir = carpeta(casa);
  const donde = real(repo);
  let archivos = [];
  try { archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return null; }
  const candidatos = archivos.map((f) => ({ archivo: path.join(dir, f), permiso: leer(path.join(dir, f)) }))
    .filter((c) => c.permiso && esCommit(c.permiso.comando) && c.permiso.repo === donde)
    .sort((a, b) => Date.parse(b.permiso.ts) - Date.parse(a.permiso.ts));
  if (!candidatos.length) return null;
  return gastar(candidatos[0].archivo, candidatos[0].permiso, ahora);
}

/** Los permisos vigentes o vencidos sin gastar (para las pruebas y el diagnóstico). */
function permisos(casa) {
  try { return fs.readdirSync(carpeta(casa)).filter((f) => f.endsWith('.json')).map((f) => leer(path.join(carpeta(casa), f))).filter(Boolean); } catch (_) { return []; }
}

module.exports = { EMERGENCIA, VENCE_MIN, carpeta, entrada, nivelEfectivo, sign, consumir, consumirCommit, permisos, esCommit };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const salir = (r) => {
    if (!r) { process.exitCode = 1; return; }
    process.stdout.write(`${r.ok ? r.permiso.motivo : r.motivo}\n`);
    process.exitCode = r.ok ? 0 : 3;
  };
  if (argv[0] === 'consume') {
    let comando = '';
    try { comando = fs.readFileSync(0, 'utf8'); } catch (_) { comando = ''; }
    salir(consumir({ comando }));
  } else if (argv[0] === 'consume-commit' && argv[1] === '--repo' && argv[2]) {
    salir(consumirCommit({ repo: argv[2] }));
  } else {
    process.stderr.write('uso: harness-sign.js consume (el comando por stdin) | consume-commit --repo <carpeta>\n');
    process.exitCode = 2;
  }
}
