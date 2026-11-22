#!/usr/bin/env node
'use strict';
/**
 * permission-relay.js — el permiso que pide una sesión de fondo le llega a la persona como cuadro, en la pestaña de la
 * coordinadora, con el pedido entero. La persona lo aprueba con un click o lo niega; la coordinadora nunca decide.
 *
 *   Claude: PermissionRequest de Bash|PowerShell|Edit|Write|NotebookEdit|WebFetch. El matcher nunca alcanza al cuadro
 *           (AskUserQuestion): así este gancho no cuenta como ajeno y no anula los clicks de firma de la máquina.
 *
 * Lleva el pedido sólo si la sesión es de fondo (`kind` bg o background en su archivo de Claude Code), está en modo
 * normal (`permission_mode: default`), la lista está encendida (`approvals.signature_list`), hay una coordinadora
 * confirmada y viva que no es ella, y su `owner-wait` corre. En Windows, sólo por Bash: por PowerShell el click no se
 * puede comprobar. Entonces anota el renglón `permiso` (signature-list.js) con el pedido entero y espera, mirando cada 2 s:
 *   - el click «Sí, aprobar» de la persona en ese mismo cuadro, anotado por la herramienta en la pestaña de la
 *     coordinadora (owner-approvals.js `buscarPermiso`): lo gasta y devuelve `allow` para esa sola vez, sin agregar
 *     ninguna regla permanente;
 *   - el «No» (`coordination.js owner-reject`, que marca el renglón): devuelve `deny`, con un motivo que lo dice;
 *   - la coordinadora: si murió o dejó de ser la designada, sale sin decidir.
 * Pasado `coordination.permission_wait_minutes` (10 sin valor), sale sin decidir y un click tardío ya no aprueba nada.
 *
 * Salir sin decidir es lo de siempre: Claude Code muestra la ventana de permiso, como sin este gancho, y la sesión queda
 * trabada. Nada se afloja: lo que hoy se pide sigue pidiéndose, y un click vale sólo para ese pedido. Al irse saca su
 * renglón; si Claude Code lo mata, el renglón se cierra solo, porque su proceso ya no vive (signature-list.js).
 *
 * Un pedido que no se puede mostrar entero (más de 1500 caracteres; caracteres de control, marcas bidireccionales o de
 * ancho cero, salvo el salto de línea; datos que el cuadro no sabe mostrar) no se lleva. Ni ése ni el vencido le hablan
 * a la persona: el motivo queda en `<estado>/coordination/permission-relay/<sesión>.json` y la coordinadora lo ve en
 * «Trabadas». Lo que pasó con cada pedido queda en gates.log (`permission-relay`: el estado, el id, la huella del pedido
 * y cuántos segundos esperó; sin el texto del pedido).
 *
 * Cualquier error sale sin decidir. Codex no tiene este evento (adapters/codex/hooks.json, la asimetría declarada).
 * Off: TYCON_PERMISSION_RELAY=0.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const NOMBRE = 'permission-relay';
const HERRAMIENTAS = new Set(['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'WebFetch']);
const PEDIDO_MAX = 1500;
const POLL_MS = 2000;
const ESPERA_MIN = 10;
const SESION = /^[\w-]+$/;
// lo que no se ve en el cuadro: los de control (salvo el salto de línea), los de formato (marcas bidireccionales, de
// ancho cero, el guion suave) y los separadores de línea y de párrafo
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const stateDirOf = (casa) => require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).stateDir(casa);
const sl = () => require(path.join(ROOT, 'scripts', 'lib', 'signature-list.js'));
const oa = () => require(path.join(ROOT, 'scripts', 'lib', 'owner-approvals.js'));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function logError(casa, message) {
  try { fs.appendFileSync(path.join(stateDirOf(casa), 'hook-errors.log'), `[${new Date().toISOString()}] ${NOMBRE}: ${message}\n\n`, 'utf8'); } catch { /* sin registro tampoco */ }
}

// las claves que cada herramienta puede traer y el cuadro muestra o no cambian lo que corre; otra clave no se lleva
const SIN_EFECTO = ['description', 'timeout', 'run_in_background'];
const CLAVES = {
  Bash: ['command', ...SIN_EFECTO],
  PowerShell: ['command', ...SIN_EFECTO],
  Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  Write: ['file_path', 'content'],
  NotebookEdit: ['notebook_path', 'cell_id', 'new_source', 'cell_type', 'edit_mode'],
  WebFetch: ['url', 'prompt'],
};

/**
 * El pedido entero, como lo va a ver la persona: `{ pedido }`, o `{ motivo }` si no se puede mostrar entero. Lo que la
 * herramienta va a hacer está todo en el texto: el comando, o el archivo y lo que cambia, o la dirección y la pregunta.
 */
function pedidoDe(herramienta, entrada) {
  const i = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : null;
  if (!i) return { motivo: 'el pedido no trae qué hacer' };
  const otras = Object.keys(i).filter((k) => !CLAVES[herramienta].includes(k));
  if (otras.length) return { motivo: `el pedido trae datos que el cuadro no muestra (${otras.slice(0, 3).join(', ')})` };
  const texto = (k, { opcional = false } = {}) => {
    if (i[k] === undefined && opcional) return '';
    if (typeof i[k] !== 'string') throw new Error(`el pedido no trae ${k} como texto`);
    return i[k];
  };
  let pedido;
  try {
    if (herramienta === 'Bash' || herramienta === 'PowerShell') pedido = texto('command');
    else if (herramienta === 'Edit') {
      if (i.replace_all !== undefined && typeof i.replace_all !== 'boolean') throw new Error('el pedido no trae replace_all como sí o no');
      pedido = `Archivo: ${texto('file_path')}\n${i.replace_all ? 'Reemplaza, todas las veces que aparece' : 'Reemplaza'}:\n${texto('old_string')}\nPor:\n${texto('new_string')}`;
    } else if (herramienta === 'Write') pedido = `Archivo: ${texto('file_path')}\nContenido nuevo, entero:\n${texto('content')}`;
    else if (herramienta === 'NotebookEdit') {
      pedido = `Cuaderno: ${texto('notebook_path')}\nCelda: ${texto('cell_id', { opcional: true }) || '(nueva)'} · ${texto('edit_mode', { opcional: true }) || 'replace'}${i.cell_type !== undefined ? ` · ${texto('cell_type')}` : ''}\nContenido:\n${texto('new_source')}`;
    } else pedido = `Dirección: ${texto('url')}\nQué pregunta de la página:\n${texto('prompt')}`;
  } catch (e) { return { motivo: e.message }; }
  if (!pedido.trim()) return { motivo: 'el pedido viene vacío' };
  if (pedido.length > PEDIDO_MAX) return { motivo: `el pedido tiene ${pedido.length} caracteres y el cuadro lleva hasta ${PEDIDO_MAX}` };
  if (INVISIBLE.test(pedido.replace(/\n/g, ''))) return { motivo: 'el pedido trae caracteres que no se ven (de control, bidireccionales o de ancho cero)' };
  return { pedido };
}

/** La carpeta del pedido, si se puede mostrar tal cual en un renglón: el cuadro la pasa por `una()`. */
function carpetaDe(cwd) {
  const c = typeof cwd === 'string' ? cwd : '';
  if (!c || !path.isAbsolute(c)) return { motivo: 'el pedido no dice desde qué carpeta' };
  if (INVISIBLE.test(c) || c !== c.replace(/\s+/g, ' ').trim()) return { motivo: 'la carpeta del pedido trae caracteres que no se ven o espacios que el cuadro no muestra' };
  return { carpeta: c };
}

/** Los minutos de espera: `coordination.permission_wait_minutes`, o 10. Sin poder leerlos, 10, y queda anotado. */
function esperaMs(casa, env) {
  try {
    const TC = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
    const m = TC.coordinacion(TC.cargar({ home: casa, env })).permission_wait_minutes.value;
    if (Number.isInteger(m) && m > 0) return m * 60000;
  } catch (e) { logError(casa, `no pude leer coordination.permission_wait_minutes (${e.message}): espero ${ESPERA_MIN} minutos`); }
  return ESPERA_MIN * 60000;
}

/** Lo que la coordinadora ve en «Trabadas» de esa sesión: por qué el permiso no le llegó como cuadro, o dejó de esperar. */
function anotarMotivo(casa, sesion, { herramienta, motivo, ahora }) {
  try {
    const dir = path.join(stateDirOf(casa), 'coordination', 'permission-relay');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sesion}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ at: new Date(ahora).toISOString(), herramienta, motivo })}\n`);
    fs.renameSync(tmp, file);
  } catch (e) { logError(casa, `no pude anotar el motivo de ${sesion} (${e.code || e.message})`); }
}

/** Lo que pasó con el pedido, en gates.log: sin el texto del pedido, sólo su huella. */
function anotarDecision(casa, { sesion, estado, id = null, herramienta, pedido, coordinadora = null, motivo = null, esperaS = null }) {
  try {
    fs.appendFileSync(path.join(stateDirOf(casa), 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), sessionId: sesion, name: NOMBRE, status: estado, id, herramienta, codigo: pedido ? sha(pedido).slice(0, 8) : null, coordinadora, espera_s: esperaS, ...(motivo ? { motivo } : {}) })}\n`);
  } catch (e) { logError(casa, `no pude anotar en gates.log que el pedido de ${sesion} quedó ${estado} (${e.code || e.message})`); }
}

const dormirDeVerdad = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * ¿Le toca a este gancho? `{ lleva: true, sesion, herramienta, s, coordinadora }` o `{ lleva: false, motivo }`. Lo que
 * no depende de la máquina se mira primero: sin el evento de Claude, fuera del matcher o en otro modo no se lee nada.
 */
function alcance(e, { casa, env, plataforma, arnes, ownerWaitVivo }) {
  if (!e || typeof e !== 'object') return { lleva: false, motivo: 'sin evento' };
  if (typeof e.turn_id === 'string') return { lleva: false, motivo: 'Codex' };
  if (e.hook_event_name !== 'PermissionRequest') return { lleva: false, motivo: 'otro evento' };
  const herramienta = String(e.tool_name || '');
  if (!HERRAMIENTAS.has(herramienta)) return { lleva: false, motivo: `${herramienta || 'sin herramienta'} no se lleva` };
  if (e.permission_mode !== 'default') return { lleva: false, motivo: `modo ${String(e.permission_mode || 'sin modo')}` };
  if (plataforma === 'win32' && herramienta === 'PowerShell') return { lleva: false, motivo: 'en Windows, por PowerShell el click no se puede comprobar' };
  const sesion = String(e.session_id || '');
  if (!SESION.test(sesion)) return { lleva: false, motivo: 'sin sesión legible' };
  const L = sl();
  if (!L.encendida({ casa, arnes, env })) return { lleva: false, motivo: 'la lista está apagada' };
  const s = L.sesiones(casa);
  const x = s.mapa.get(sesion);
  if (!x || !/^(bg|background)$/.test(String(x.kind || ''))) return { lleva: false, motivo: 'no es una sesión de fondo' };
  const coordinadora = L.coordinadoraViva(casa, s);
  if (!coordinadora) return { lleva: false, motivo: 'sin coordinadora confirmada y viva' };
  if (coordinadora === sesion) return { lleva: false, motivo: 'es la coordinadora' };
  if (!ownerWaitVivo(casa)) return { lleva: false, motivo: 'la coordinadora no tiene owner-wait corriendo' };
  return { lleva: true, sesion, herramienta, coordinadora };
}

/**
 * La decisión para el evento: `{ decision: 'allow' | 'deny' | null, motivo, id? }`. null es salir sin decidir. `opts`:
 * `casa`, `env`, `plataforma`, `arnes` (el árbol del perfil, en las pruebas), `ahora()`, `dormir(ms)`, `pollMs`,
 * `ownerWaitVivo(casa)`, y `arbol`/`validar` para `buscarPermiso`.
 */
function decidir(evento, opts = {}) {
  const env = opts.env || process.env;
  const casa = opts.casa;
  const ahora = opts.ahora || Date.now;
  const dormir = opts.dormir || dormirDeVerdad;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : POLL_MS;
  const plataforma = opts.plataforma || process.platform;
  const ownerWaitVivo = opts.ownerWaitVivo || ((c) => Boolean(require(path.join(ROOT, 'scripts', 'tools', 'coordination.js')).ownerWaitAlive(c)));
  if (env.TYCON_PERMISSION_RELAY === '0') return { decision: null, motivo: 'apagado' };
  const a = alcance(evento, { casa, env, plataforma, arnes: opts.arnes, ownerWaitVivo });
  if (!a.lleva) return { decision: null, motivo: a.motivo };
  const { sesion, herramienta, coordinadora } = a;
  const p = pedidoDe(herramienta, evento.tool_input);
  const c = p.pedido ? carpetaDe(evento.cwd) : {};
  const noSeLleva = p.motivo || c.motivo;
  if (noSeLleva) {
    anotarMotivo(casa, sesion, { herramienta, motivo: `no se lleva al cuadro: ${noSeLleva}`, ahora: ahora() });
    anotarDecision(casa, { sesion, estado: 'no-se-lleva', herramienta, pedido: p.pedido, coordinadora, motivo: noSeLleva });
    return { decision: null, motivo: noSeLleva };
  }
  const { pedido } = p;
  const { carpeta } = c;
  const L = sl();
  const plazo = esperaMs(casa, env);
  const r = L.anotarPermiso({ casa, herramienta, pedido, carpeta, sesion, pid: process.pid, ahora: ahora(), relay: true });
  if (!r.ok) {
    logError(casa, `${r.motivo}: el pedido de ${sesion} va a la ventana normal`);
    return { decision: null, motivo: r.motivo };
  }
  const id = r.id;
  const desde = ahora();
  const cerrar = (estado, motivo, decision) => {
    try { L.renglonDelGancho(casa, id, { quitar: true }); } catch (e) { logError(casa, `no pude sacar ${id} de la lista (${e.message}): se cierra solo cuando este gancho termine`); }
    if (decision === null && estado !== 'sin-renglon') anotarMotivo(casa, sesion, { herramienta, motivo, ahora: ahora() });
    anotarDecision(casa, { sesion, estado, id, herramienta, pedido, coordinadora, motivo: decision === null ? motivo : null, esperaS: Math.round((ahora() - desde) / 1000) });
    return { decision, motivo, id };
  };
  for (;;) {
    let fila;
    try { fila = L.renglonDelGancho(casa, id).fila; } catch (e) { return cerrar('error', `no pude leer la lista de firmas (${e.message})`, null); }
    if (!fila) return cerrar('sin-renglon', 'el renglón ya no está en la lista', null);
    // un «No» sólo niega
    if (fila.rechazado) return cerrar('rechazado', 'la persona dijo que no', 'deny');
    if (L.coordinadoraViva(casa) !== coordinadora) return cerrar('sin-coordinadora', 'la coordinadora ya no está o dejó de ser la designada', null);
    const b = oa().buscarPermiso({ casa, cuadro: L.cuadroDePermiso(fila), coordinadora, carpeta, desde: fila.at, ahora: ahora(), arbol: opts.arbol, validar: opts.validar });
    if (b.ok) {
      const gasto = oa().consumir(casa, b.aprobacion, { ahora: ahora(), firma: `permiso:${id}`, sesion });
      if (gasto.ok) return cerrar('aprobado', 'la persona lo aprobó con su click', 'allow');
      logError(casa, `el click para ${id} no se pudo gastar (${gasto.motivo}): sigo esperando`);
    } else if (b.noLeida) logError(casa, `no pude confirmar el click para ${id} (${b.motivo}): sigo esperando`);
    if (ahora() - fila.at >= plazo) return cerrar('vencido', `nadie contestó el cuadro en ${Math.round(plazo / 60000)} minutos`, null);
    dormir(pollMs);
  }
}

/** Lo que el gancho escribe para Claude Code: nada sin decidir; si no, la decisión para esa sola vez, sin reglas. */
function salida(r) {
  if (!r || (r.decision !== 'allow' && r.decision !== 'deny')) return '';
  const decision = r.decision === 'allow' ? { behavior: 'allow' }
    : { behavior: 'deny', message: 'La persona dijo que no a este pedido, desde la pestaña de la coordinadora: no corre. Seguí sin él, o avisale a la coordinadora qué necesitás y por qué.' };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

module.exports = { HERRAMIENTAS, PEDIDO_MAX, pedidoDe, carpetaDe, alcance, decidir, salida, esperaMs };

if (require.main === module) {
  let casa = null;
  try {
    if (process.env.TYCON_PERMISSION_RELAY === '0') process.exit(0);
    const evento = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}');
    // lo que no es de este gancho sale antes de leer nada de la máquina
    if (!evento || evento.hook_event_name !== 'PermissionRequest' || !HERRAMIENTAS.has(String(evento.tool_name || '')) || evento.permission_mode !== 'default') process.exit(0);
    // la casa donde anota el click el gancho del cuadro (owner-approval-record.js), que no mira HOME
    casa = require(path.join(ROOT, 'scripts', 'lib', 'real-home.js')).casaDeLaCuenta();
    const out = salida(decidir(evento, { casa }));
    if (out) process.stdout.write(out);
  } catch (e) {
    if (casa) logError(casa, `${(e && e.message) || e}: salí sin decidir`);
  }
  process.exit(0);
}
