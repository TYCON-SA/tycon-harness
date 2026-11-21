#!/usr/bin/env node
/**
 * guard-update-notice.js — al abrir la sesión: compara si esta máquina tiene el permiso de actualizar el freno de
 * producción sin contraseña con lo que eligió la organización (`guard.update` del perfil del equipo), y muestra la última
 * actualización que hizo sola. Casos: scripts/tests/guard-update-notice.test.sh.
 *
 * POR QUÉ EXISTE: el permiso de sudo de una máquina lo pone y lo saca su persona, con su contraseña; lo que elige la
 * organización desde el sitio no lo cambia solo. Sin este aviso, una organización que vuelve a «con la contraseña» sigue
 * con máquinas que se actualizan solas, y una que elige «solo» no se entera de qué máquinas no instalaron el permiso.
 *
 * QUÉ MIRA: la marca de root `/opt/tycon/production/auto-update.json` (la deja `install-guard.sh --allow-auto-update`)
 * contra `guard.update`, en las dos direcciones, con el comando exacto para corregirlo. Coincidiendo con el permiso puesto,
 * muestra el último renglón de `production/update-log.jsonl`. Un valor roto se toma como «con la contraseña» y se dice;
 * un perfil que no se lee, también se dice.
 *
 * Nunca cambia nada ni bloquea: imprime y sale 0. Sólo habla en una máquina con el freno instalado (/opt/tycon).
 * Off: TYCON_GUARD_UPDATE_NOTICE=0. En pruebas, TYCON_PROD_ROOT es la raíz de sistema falsa y TYCON_GUIDES_DIR el arnés
 * cuyo perfil se lee (sin ellas, /opt de verdad y el arnés de este archivo).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ARBOL = path.resolve(__dirname, '..', '..');
const INSTALADOR = path.join(ARBOL, 'scripts', 'production', 'install-guard.sh');

function leerEleccion(arnes) {
  // el lector de ESTE árbol; la clave vale sólo desde el perfil del equipo
  try {
    const c = require(path.join(ARBOL, 'scripts', 'lib', 'tycon-config.js')).cargar({ env: {}, arnes });
    const rota = (c.errores || []).find((e) => e.clave === 'guard.update');
    if (rota) return { valor: 'password', aviso: `guard.update está roto en el perfil del equipo (${rota.motivo}): lo tomo como «con la contraseña»` };
    const ilegible = (c.errores || []).find((e) => !e.clave);
    if (ilegible) return { valor: null, aviso: `no pude leer lo que eligió la organización para actualizar el freno (${ilegible.archivo}: ${ilegible.motivo})` };
    return { valor: c.valores.guard && c.valores.guard.update === 'auto' ? 'auto' : 'password' };
  } catch (e) {
    return { valor: null, aviso: `no pude leer lo que eligió la organización para actualizar el freno (${e.message})` };
  }
}

const cuando = (at) => (at ? ` (${String(at).slice(0, 16).replace('T', ' ')} UTC)` : '');
const comandoConContrasena = (arnes) => `sudo bash ${path.join(arnes || ARBOL, 'scripts', 'production', 'install-guard.sh')}`;

/** Los renglones legibles del registro de actualizaciones: `{ renglones }` o `{ problema }`. Sin archivo, vacío. */
function leerRegistro(registro) {
  let lineas;
  try { lineas = fs.readFileSync(registro, 'utf8').split('\n').filter((l) => l.trim()); } catch (e) {
    return e && e.code === 'ENOENT' ? { renglones: [], total: 0 } : { problema: `no pude leer el registro de actualizaciones (${(e && e.code) || e})` };
  }
  const renglones = [];
  for (const l of lineas) { try { const r = JSON.parse(l); if (r && typeof r === 'object') renglones.push(r); } catch { /* un renglón ilegible no cuenta */ } }
  return { renglones, total: lineas.length };
}

// La versión instalada según su constancia (la deja install-guard.sh, con o sin contraseña), o null.
function versionInstalada(prod) {
  try { const v = JSON.parse(fs.readFileSync(path.join(prod, 'installed-release.json'), 'utf8')).version; if (typeof v === 'string' && v) return v; } catch { /* sin constancia */ }
  return null;
}

// Compara dos versiones por sus números (2026.11.09.3): <0, 0 o >0; null si alguna no tiene números.
function compararVersiones(a, b) {
  const na = String(a || '').match(/\d+/g);
  const nb = String(b || '').match(/\d+/g);
  if (!na || !nb) return null;
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = Number(na[i] || 0) - Number(nb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// La versión que sigue andando: la última que se actualizó sola, o la instalada con contraseña si es igual o más nueva
// (una instalación con contraseña no deja renglón en el registro).
function laQueAnda(renglones, prod) {
  const inst = versionInstalada(prod);
  for (let i = renglones.length - 1; i >= 0; i--) {
    if (!renglones[i].to_version) continue;
    const c = compararVersiones(inst, renglones[i].to_version);
    return c !== null && c >= 0 ? inst : renglones[i].to_version;
  }
  return inst || 'la instalada';
}

// Una falla que una instalación posterior ya resolvió: la versión instalada es la que falló, o una más nueva.
function fallaResuelta(falla, prod) {
  const c = compararVersiones(versionInstalada(prod), falla.attempted_version);
  return c !== null && c >= 0;
}

/**
 * Lo último del registro: `{ tipo: 'ok' | 'fallo' | 'nada' | 'problema', texto }`. Un renglón de falla (`status:
 * failed`, sin `to_version`) nunca se lee como una actualización: dice qué versión sigue andando, cuál falló y por qué,
 * con el comando con contraseña, que es la salida si el ensayo frenó de más.
 */
function ultimoDelRegistro(prod, arnes) {
  const r = leerRegistro(path.join(prod, 'update-log.jsonl'));
  if (r.problema) return { tipo: 'problema', texto: r.problema };
  const ultimo = r.renglones[r.renglones.length - 1];
  if (ultimo && ultimo.status === 'failed' && fallaResuelta(ultimo, prod)) {
    return { tipo: 'ok', texto: `el freno está en ${versionInstalada(prod)}: la falla de la actualización sola${cuando(ultimo.at)} ya se resolvió con una instalación posterior` };
  }
  if (ultimo && ultimo.status === 'failed') {
    const anda = laQueAnda(r.renglones, prod);
    return { tipo: 'fallo', texto: `sigue andando ${anda}; la actualización sola a ${ultimo.attempted_version || 'la versión nueva'} falló${cuando(ultimo.at)}: ${ultimo.reason || 'sin motivo anotado'}. Ponelo al día con tu contraseña, en tu terminal (fuera del asistente, cuya terminal frena el freno): \`${comandoConContrasena(arnes)}\`` };
  }
  for (let i = r.renglones.length - 1; i >= 0; i--) {
    if (r.renglones[i].to_version) return { tipo: 'ok', texto: `el freno se actualizó solo a ${r.renglones[i].to_version}${cuando(r.renglones[i].at)}` };
  }
  return { tipo: 'nada', texto: r.total ? 'no pude leer la última actualización del registro' : 'todavía no se actualizó sola' };
}
function ultimaActualizacion(registro) { return ultimoDelRegistro(path.dirname(registro)).texto; }

const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const DIA_MS = 24 * 3600000;

/**
 * El freno quedó viejo en una máquina con el permiso de actualizarse sola: ¿por qué? Devuelve
 * `{ caso, pideContrasena, texto }`:
 *   · `otro-instalador`: la versión que corre trae otro install-guard.sh que el de root: pide la contraseña siempre;
 *   · `actualizando`: el candado de una actualización viva, o la versión se bajó hace menos de 24 h;
 *   · `fallo`: el último renglón del registro es una falla (lo del AC 22);
 *   · `trabado`: más de 24 h sin un renglón: la actualización sola no está corriendo.
 * Las 24 h se cuentan desde que esta máquina bajó la versión (`downloaded_at` del manifiesto): es desde cuando el gancho
 * puede instalarla. Sin ese dato cuenta como más de 24 h, del lado de pedir la contraseña.
 */
// El último registro del gancho que lanza la actualización (guard-auto-update.js): `{ salida, primera }` si terminó con
// un `exit=N` distinto de 0, o null (sin registro, en curso o bien).
function ultimoArranqueFallido(logDir) {
  let dir = logDir;
  if (!dir) { try { dir = require('./guard-auto-update.js').logDirDe(require('os').homedir()); } catch { return null; } }
  let nombres;
  try { nombres = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort(); } catch { return null; }
  if (!nombres.length) return null;
  let lineas;
  try { lineas = fs.readFileSync(path.join(dir, nombres[nombres.length - 1]), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch { return null; }
  const m = /^exit=(\d+)$/.exec(lineas[lineas.length - 1] || '');
  if (!m || m[1] === '0') return null;
  return { salida: Number(m[1]), primera: lineas.find((l) => !/^exit=/.test(l)) || 'sin mensaje' };
}

function atraso({ prod, arnes, now = Date.now(), logDir }) {
  const comando = comandoConContrasena(arnes);
  const nuevo = path.join(arnes, 'scripts', 'production', 'install-guard.sh');
  const deRoot = path.join(prod, '..', 'setup', 'install-guard.sh');
  try {
    if (fs.existsSync(nuevo) && fs.existsSync(deRoot) && !fs.readFileSync(nuevo).equals(fs.readFileSync(deRoot))) {
      return { caso: 'otro-instalador', pideContrasena: true, texto: `la versión nueva trae otro instalador y no se instala sola: ponelo al día con tu contraseña, en tu terminal (fuera del asistente): \`${comando}\`` };
    }
  } catch { /* sin poder comparar, sigue: el ensayo del instalador lo vuelve a mirar */ }
  let pid = null;
  try { pid = Number(String(fs.readFileSync(path.join(prod, 'update.lock', 'pid'), 'utf8')).trim()); } catch { /* sin candado */ }
  if (Number.isInteger(pid) && pid > 0 && vivo(pid)) return { caso: 'actualizando', pideContrasena: false, texto: 'se está actualizando solo ahora mismo: no hace falta hacer nada' };
  const u = ultimoDelRegistro(prod, arnes);
  if (u.tipo === 'fallo') return { caso: 'fallo', pideContrasena: true, texto: u.texto };
  // la actualización sola ni arrancó: sudo pidió la contraseña o no tiene la regla; el instalador no llegó a anotar nada
  const sinArrancar = ultimoArranqueFallido(logDir);
  if (sinArrancar) return { caso: 'no-arranco', pideContrasena: true, texto: `la actualización sola no arrancó (sudo salió ${sinArrancar.salida}: ${sinArrancar.primera}): ponelo al día con tu contraseña, en tu terminal (fuera del asistente): \`${comando}\`` };
  let bajada = NaN;
  try { bajada = Date.parse(JSON.parse(fs.readFileSync(path.join(arnes, '.tycon-release.json'), 'utf8')).downloaded_at); } catch { /* sin fecha */ }
  if (Number.isFinite(bajada) && now - bajada < DIA_MS) return { caso: 'actualizando', pideContrasena: false, texto: 'se actualiza solo al abrir una sesión: la versión nueva llegó hace menos de 24 h' };
  return { caso: 'trabado', pideContrasena: true, texto: `la actualización sola está trabada (pasaron más de 24 h sin que se instalara): ponelo al día con tu contraseña, en tu terminal (fuera del asistente): \`${comando}\`` };
}

function avisos({ raiz, arnes }) {
  const opt = path.join(raiz, 'opt', 'tycon');
  if (!fs.existsSync(opt)) return [];
  const prod = path.join(opt, 'production');
  const conPermiso = fs.existsSync(path.join(prod, 'auto-update.json'));
  const e = leerEleccion(arnes);
  const out = [];
  if (e.aviso) out.push(`🟠 freno de producción: ${e.aviso}.`);
  if (e.valor === null) return out;
  if (conPermiso && e.valor === 'password') {
    out.push(`🟠 freno de producción: la organización eligió «con la contraseña» y esta máquina tiene el permiso de actualizarse sola: sacalo con \`sudo bash ${INSTALADOR} --remove-auto-update\`.`);
  } else if (!conPermiso && e.valor === 'auto') {
    out.push(`🟠 freno de producción: la organización eligió «solo» y esta máquina no tiene el permiso: instalalo con \`sudo bash ${INSTALADOR} --allow-auto-update\` (pide tu contraseña).`);
  } else if (conPermiso) {
    const u = ultimoDelRegistro(prod);
    out.push(u.tipo === 'fallo' || u.tipo === 'problema'
      ? `🟠 freno de producción: actualización sin contraseña encendida · ${u.texto}.`
      : `ℹ️ freno de producción: actualización sin contraseña encendida · ${u.texto}.`);
  }
  return out;
}

if (require.main === module) {
  try {
    if (process.env.TYCON_GUARD_UPDATE_NOTICE !== '0') {
      const raiz = process.env.TYCON_PROD_ROOT || '/';
      const arnes = process.env.TYCON_GUIDES_DIR || ARBOL;
      for (const l of avisos({ raiz, arnes })) console.log(l);
    }
  } catch (e) {
    console.log(`🟠 freno de producción: el aviso de la actualización sin contraseña falló (${e.message}).`);
  }
  process.exit(0);
}

module.exports = { avisos, atraso, leerEleccion, ultimoDelRegistro, ultimaActualizacion };
