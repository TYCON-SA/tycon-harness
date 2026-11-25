#!/usr/bin/env node
'use strict';
/**
 * prod-firewall-close.js — cierra la regla de firewall que abrió la puerta de producción.
 *
 * La puerta (`/opt/tycon/bin/tycon-prod-sql --open-firewall <host>`) abre en un Azure SQL de producción UNA regla con
 * nombre fijo por máquina (`tycon-gate-<id>`) y anota qué sesión del asistente la usa. Una regla que queda viva en
 * producción es justo lo que el freno existe para evitar, así que este hook la cierra sin cuadro de aprobación:
 *
 *   · SessionEnd   → por cada regla que usaba la sesión que termina, llama a la puerta con
 *                    `--close-firewall <host> --session <id>`. La puerta saca la sesión y cierra la regla sólo si no
 *                    queda otra sesión viva que la use.
 *   · SessionStart → barre lo que quedó abierto porque el fin de sesión no corrió (ventana cerrada de golpe, sesión
 *                    caída, tope de tiempo): la UNIÓN del archivo de estado y de las aperturas del registro sin un
 *                    cierre posterior, así que borrar el estado no esconde una regla. Cierra la de cada sesión que ya
 *                    no está viva y lo dice en una línea; si no puede, lo dice en rojo con el comando de cierre.
 *
 * Se registra en la configuración administrada (root), no en la del usuario, y no tiene variable de apagado: una
 * configuración que la sesión puede editar es una que puede apagarlo.
 *
 * «Viva» = su proceso sigue corriendo, por lo que Claude Code anota de cada sesión en `~/.claude/sessions/<pid>.json`
 * (igual en macOS, Linux y Windows): una sesión que espera a la persona sigue viva. Sin esa anotación, el respaldo: su
 * transcripción (`~/.claude/projects/<carpeta>/<id>.jsonl`) tuvo actividad en los últimos 3 minutos; una regla que se
 * cierra por el respaldo lo dice. Y ninguna regla dura más de TOPE_HORAS aunque su sesión siga: el barrido la cierra y
 * dice cómo volver a abrirla (la dirección segura).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = process.env.HOME || os.homedir();
const INSTALADA = fs.existsSync('/opt/tycon');
// la puerta: instalada, la de root; sin el freno instalado (pruebas), la que diga la variable
const PUERTA = INSTALADA ? '/opt/tycon/bin/tycon-prod-sql' : process.env.TYCON_PROD_GATE;
// la carpeta del estado la sabe tycon-home.js (en /opt viaja su copia al lado); sin ella, la misma regla que la puerta:
// si existe ~/.tycon/state, la máquina vive ahí
const ESTADO_DIR = (() => {
  try { const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); if (typeof TH.stateDir === 'function') return TH.stateDir(HOME); } catch (_) { /* la regla de la puerta */ }
  return fs.existsSync(path.join(HOME, '.tycon', 'state')) ? path.join(HOME, '.tycon', 'state') : path.join(HOME, '.claude', '.tycon-pipeline');
})();
const ESTADO = path.join(ESTADO_DIR, 'production-firewall.json');
const REGISTRO = path.join(ESTADO_DIR, 'production.log');
const SESION_VALIDA = /^[A-Za-z0-9-]{8,64}$/;
const TRES_MIN = 3 * 60 * 1000;
// el tope de una regla abierta, aunque la sesión que la pidió siga viva: una jornada. Cuenta desde la última vez que se
// abrió con su cuadro
const TOPE_HORAS = 8;

function leerEvento() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_) { return {}; }
}

/** `{ reglas, ilegible }`: las reglas del estado; ilegible = «no sé qué reglas hay». */
function leerEstado() {
  if (!fs.existsSync(ESTADO)) return { reglas: [], ilegible: null };
  try {
    const e = JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
    if (!Array.isArray(e.reglas)) throw new Error('sin la lista de reglas');
    return { reglas: e.reglas, ilegible: null };
  } catch (err) { return { reglas: [], ilegible: err.message }; }
}

/**
 * Las aperturas del registro sin un cierre posterior, por host: `{ host, regla, abierta }`. Una apertura que salió con
 * error cuenta igual: si az llegó al tope después de crearla, la regla puede existir. Cerrar una que no existe es inocuo.
 */
function abiertasEnElRegistro() {
  let lineas = [];
  try { lineas = fs.readFileSync(REGISTRO, 'utf8').split('\n'); } catch (err) {
    if (err.code !== 'ENOENT') avisos.push(`🔴 prod-firewall: no pude leer el registro de producción (${err.code || err.message}): sólo miro el estado.`);
    return [];
  }
  const ultima = new Map();
  for (const l of lineas) {
    let j; try { j = JSON.parse(l); } catch (_) { continue; }
    if (!j || typeof j.host !== 'string') continue;
    if (j.accion === 'open-firewall' && j.regla) ultima.set(j.host, { host: j.host, regla: j.regla, abierta: j.ts });
    else if (j.accion === 'close-firewall' && j.exit === 0) ultima.delete(j.host);
  }
  return [...ultima.values()];
}
const avisos = [];

/** `{ viva, porProceso }`: si la sesión sigue, y si se supo por su proceso (false = por el respaldo de los 3 minutos). */
function viva(id) {
  // la misma sesión puede tener más de una anotación (una vieja de antes de reanudarla): viva si alguno de sus procesos lo está
  let anotada = false;
  try {
    const dir = path.join(HOME, '.claude', 'sessions');
    for (const f of fs.readdirSync(dir)) {
      if (!/^[0-9]+\.json$/.test(f)) continue;
      let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
      if (!j || j.sessionId !== id || !Number.isInteger(j.pid) || j.pid <= 0) continue;
      anotada = true;
      try { process.kill(j.pid, 0); return { viva: true, porProceso: true }; } catch (err) { if (err.code === 'EPERM') return { viva: true, porProceso: true }; }
    }
  } catch (_) { /* sin el registro de sesiones: el respaldo */ }
  if (anotada) return { viva: false, porProceso: true };
  const raiz = path.join(HOME, '.claude', 'projects');
  let carpetas = [];
  try { carpetas = fs.readdirSync(raiz); } catch (_) { return { viva: false, porProceso: false }; }
  return { viva: carpetas.some((d) => {
    try { return Date.now() - fs.statSync(path.join(raiz, d, `${id}.jsonl`)).mtimeMs < TRES_MIN; } catch (_) { return false; }
  }), porProceso: false };
}

// La configuración administrada le da 120 s al hook, pero al terminar la sesión el tope real es ~60 s (medido con
// `claude -p`): todo lo que hace el hook entra en 55, y lo que no alcanzó a cerrar se dice (un cierre cortado a la mitad
// no puede salir callado). La puerta, llamada con `--session`, acota cada llamada a az a 13 s.
// El barrido de arranque es el respaldo de lo que el fin de sesión no alcanzó a cerrar: conserva los 110 s del tope de
// 120 de la configuración administrada.
let PRESUPUESTO_MS = 55 * 1000;
const inicio = Date.now();
function puerta(args) {
  const quedan = PRESUPUESTO_MS - (Date.now() - inicio);
  if (quedan < 5000) return { rc: 1, salida: 'no quedó tiempo para intentarlo (tope del hook)', tope: true };
  const r = INSTALADA
    ? spawnSync(PUERTA, args, { windowsHide: true, encoding: 'utf8', timeout: quedan })
    : spawnSync('bash', [PUERTA, ...args], { windowsHide: true, encoding: 'utf8', timeout: quedan });
  const tope = !!r.signal || (r.error && r.error.code === 'ETIMEDOUT');
  const salida = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { rc: r.status === null ? 1 : r.status, salida: tope ? `se cortó por tiempo (tope del hook)${salida ? `: ${salida.split('\n').pop()}` : ''}` : salida, tope };
}

const cierreAMano = (host) => `/opt/tycon/bin/tycon-prod-sql --close-firewall ${host}`;
const ultimaLinea = (s) => (s.split('\n').pop() || 'sin salida');
// la línea de la puerta que dice que la operación quedó sin constancia (sale aunque la operación anduvo)
const sinConstancia = (s) => String(s || '').split('\n').find((l) => /no pude anotar/.test(l));

function finDeSesion(sesion) {
  const { reglas, ilegible } = leerEstado();
  if (ilegible) console.log(`🔴 prod-firewall: el estado de las reglas abiertas está ilegible (${ilegible}): no sé si esta sesión dejó alguna. El próximo arranque barre el registro.`);
  for (const r of reglas) {
    if (!Array.isArray(r.sesiones) || !r.sesiones.includes(sesion)) continue;
    const res = puerta(['--close-firewall', r.host, '--session', sesion]);
    if (res.rc !== 0) console.log(`🔴 prod-firewall: no pude cerrar la regla ${r.regla || 'tycon-gate'} de ${r.host} al terminar la sesión: ${ultimaLinea(res.salida)}. Queda anotada; cerrala con: ${cierreAMano(r.host)}`);
    else if (sinConstancia(res.salida)) console.log(`🔴 prod-firewall: cerré la regla de ${r.host}, pero ${sinConstancia(res.salida).replace(/^🔴\s*/, '')}`);
  }
}

function barrido() {
  const { reglas, ilegible } = leerEstado();
  const lineas = [];
  if (ilegible) lineas.push(`🔴 prod-firewall: el estado de las reglas abiertas (${ESTADO}) está ilegible (${ilegible}): no sé cuáles hay; cierro las que el registro muestra abiertas.`);
  const porHost = new Map(reglas.filter((r) => r && typeof r.host === 'string').map((r) => [r.host, { ...r, sesiones: Array.isArray(r.sesiones) ? r.sesiones : [] }]));
  for (const a of abiertasEnElRegistro()) if (!porHost.has(a.host)) porHost.set(a.host, { ...a, sesiones: [] });
  for (const r of porHost.values()) {
    const sesiones = r.sesiones.filter((s) => SESION_VALIDA.test(s));
    const vistas = sesiones.map((s) => ({ id: s, ...viva(s) }));
    const vivas = vistas.filter((v) => v.viva);
    const desdeMs = Date.parse(r.abierta || '');
    // sin una fecha que se pueda leer no se sabe desde cuándo está: cuenta como vencida (la dirección segura)
    const vencida = !Number.isFinite(desdeMs) || Date.now() - desdeMs > TOPE_HORAS * 3600 * 1000;
    if (vivas.length && !vencida) continue;                     // la usa una sesión viva y no llegó al tope: no se toca
    // UNA llamada por regla, sin --session: ninguna sesión que la usaba sigue viva, y cerrar es la dirección segura
    const res = puerta(['--close-firewall', r.host]);
    const desde = r.abierta ? ` (abierta desde ${r.abierta})` : '';
    if (res.rc !== 0) {
      lineas.push(`🔴 prod-firewall: no pude cerrar la regla ${r.regla || 'tycon-gate'} de ${r.host}${desde}: ${ultimaLinea(res.salida)}. Cerrala con: ${cierreAMano(r.host)}`);
    } else if (/ya no existe/.test(res.salida)) {
      // el servidor se borró y se llevó la regla: la puerta lo probó, no hay nada que cerrar a mano
      lineas.push(`🔒 prod-firewall: el servidor de ${r.host} ya no existe: doy por cerrada su regla ${r.regla || 'tycon-gate'}${desde}.`);
    } else if (/cerrada/.test(res.salida)) {
      if (vencida && vivas.length) {
        lineas.push(`🔒 prod-firewall: cerré la regla ${r.regla || 'tycon-gate'} de ${r.host}${desde}: llegó al tope de ${TOPE_HORAS} h, aunque la sesión sigue. Si hace falta, la persona la vuelve a abrir en su terminal: /opt/tycon/bin/tycon-prod-sql --open-firewall ${r.host} --session ${vivas[0].id}`);
      } else {
        // la que se dio por terminada sin ver su proceso, por el respaldo, se dice
        const porRespaldo = vistas.some((v) => !v.porProceso);
        lineas.push(`🔒 prod-firewall: cerré la regla ${r.regla || 'tycon-gate'} de ${r.host}${desde}: la sesión que la abrió ya no está${porRespaldo ? ` (no vi su proceso en ~/.claude/sessions: la di por terminada por el respaldo, ${TRES_MIN / 60000} minutos sin actividad)` : ''}.`);
      }
    }
    if (res.rc === 0 && sinConstancia(res.salida)) lineas.push(`🔴 prod-firewall: ${sinConstancia(res.salida).replace(/^🔴\s*/, '')}`);
  }
  lineas.unshift(...avisos);
  if (lineas.length) console.log(lineas.join('\n'));
}

function main() {
  if (!PUERTA || !fs.existsSync(PUERTA)) {
    // sin la puerta no se puede cerrar nada; si quedaron reglas anotadas, se dice
    const { reglas } = leerEstado();
    if (reglas.length) console.log(`🔴 prod-firewall: hay ${reglas.length} regla(s) de firewall anotadas como abiertas (${reglas.map((r) => r.host).join(', ')}) y la puerta no está para cerrarlas. Reinstalá el freno o cerralas desde el portal de Azure (reglas tycon-gate-*).`);
    return;
  }
  const ev = leerEvento();
  const evento = ev.hook_event_name || '';
  const sesion = typeof ev.session_id === 'string' && SESION_VALIDA.test(ev.session_id) ? ev.session_id : '';
  if (evento === 'SessionEnd' && sesion) finDeSesion(sesion);
  else if (evento === 'SessionStart') { PRESUPUESTO_MS = 110 * 1000; barrido(); }
}

try { main(); } catch (err) {
  console.log(`🔴 prod-firewall: el cierre de reglas falló (${err.message}). Si abriste una, cerrala con /opt/tycon/bin/tycon-prod-sql --close-firewall <host>`);
}
process.exit(0);
