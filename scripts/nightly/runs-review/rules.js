'use strict';
/*
 * rules.js — LAS REGLAS DE LA REVISIÓN NOCTURNA DE LAS EJECUCIONES, SIN MODELO Y SIN LEER NI ESCRIBIR ARCHIVOS.
 *
 * `revisar({ volcado, lineasHilo, registros })` mira una ejecución del buzón y dice qué fallas del arnés tuvo, con un
 * código fijo por regla, una categoría de lista cerrada y un conteo. Nada del texto de la conversación sale de acá:
 * quien llama escribe sólo lo que devuelve.
 *
 * 🔴 SÓLO CUENTA LO QUE EL MODELO CORRIÓ. Una regla mira los `tool_use` de las líneas `assistant` y su `tool_result`, y
 *    dentro de cada comando sólo el programa de cada segmento (`segmentos`): un `grep`, un `echo`, un heredoc o un
 *    `git commit -m` que mencionan el texto no corren nada. Las líneas `api-request*` repiten cada comando y el texto del
 *    asistente cuenta lo que pensó: no se leen.
 */
const path = require('path');
const { CATEGORIAS_HOOK } = require('../../metrics/tokens-digest.js');
const STEPS = require('../../../skills/tycon-pipeline/scripts/lib/steps.js');
const INTEGRATIONS = require('../../lib/integrations.js');

const CODIGOS = ['RR-HOOK', 'RR-NODE', 'RR-APAGO', 'RR-BANDERA', 'RR-CIERRE', 'RR-ESCAPE'];
// Dónde vive un guion del arnés, en Mac, Linux y Windows: los dos nombres del lugar salen de su constante.
const { PLACE_NAME, LEGACY_PLACE_NAME } = require('../../setup/harness/place.js');
const RUTAS_DEL_ARNES = ['tycon-pipeline/scripts/', 'tycon-pipeline\\scripts\\', `${PLACE_NAME}/`, `${PLACE_NAME}\\`,
  `${LEGACY_PLACE_NAME}/`, `${LEGACY_PLACE_NAME}\\`, '.tycon/harness/', '.tycon\\harness\\'];
// Las variables de escape de los frenos. Dónde las lee el arnés: la tabla «Interruptor» de INSTALL.md
// (TYCON_PR_BY_HAND, TYCON_SAFETY_OFF, TYCON_FULL_SUITE), scripts/setup/hooks-list.json (TYCON_SESSION_GUARD_OK),
// scripts/hooks/engram-pre-commit.sh (TYCON_ENGRAM_MANIFEST_OK), steps/step-08-adversarial-pass.md
// (TYCON_NO_DEEP_REVIEW), scripts/controls-bench/live-fire-stop.js (STOP_AUTONOMY) y
// skills/tycon-pipeline/scripts/runtime-matrix.js (TYCON_RUNTIME_MATRIX_NO_MUTATION_CHECK).
const ESCAPES = ['TYCON_SAFETY_OFF', 'TYCON_PR_BY_HAND', 'TYCON_FULL_SUITE', 'TYCON_SESSION_GUARD_OK', 'TYCON_ENGRAM_MANIFEST_OK',
  'TYCON_RUNTIME_MATRIX_NO_MUTATION_CHECK', 'TYCON_NO_DEEP_REVIEW', 'STOP_AUTONOMY'];
// Una línea de bypass.log y el comando que la dejó son el mismo escape: cuenta la del registro, que trae el motivo.
const EQUIVALENTES = { GIT_NO_VERIFY: '--no-verify', ATDD_BYPASS: 'atddBypass', PR_A_MANO: 'TYCON_PR_BY_HAND', FULL_SUITE_RUN: 'TYCON_FULL_SUITE' };
// Los valores con que marker.js prende una bandera (cmdSetFlag) y deja prendido el modo automático (cmdSetAutonomous):
// cualquier otro valor de set-autonomous lo apaga.
const PRENDE_BANDERA = ['true', '1'];
const PRENDE_AUTONOMO = ['true', '1', 'on'];
// Palabras que van antes del programa sin ser el programa: las del shell, `env`, y el operador de llamada de PowerShell.
const ANTES_DEL_PROGRAMA = ['if', 'then', 'do', 'else', 'elif', 'while', 'until', 'time', 'exec', 'command', '!', '&', 'env', '{', '('];

// La acción que antecede a la bandera de cada parte del Arranque (steps/step-01-start.md). Poner la bandera es lo
// normal; ponerla sin que su acción saliera bien es la falla. ADO: el `update` que la pasa a Active, o el `show` del
// camino «ya estaba en Active» (paso 5 del Arranque).
const ACCIONES_DE_PARTE = {
  'time-tracking': (c) => argsDe(c.command, 'pipeline.js').some((r) => r[0] === 'work-signal' && r[1] === 'start')
    || (servidoresDeHoras().some((s) => c.name.startsWith(`mcp__${s}__`)) && /create|start/i.test(c.name)),
  ado: (c) => segmentos(c.command).some((s) => {
    if (s.programa !== 'az') return false;
    const k = s.args.indexOf('boards');
    if (k < 0 || s.args[k + 1] !== 'work-item') return false;
    const sub = s.args[k + 2];
    return sub === 'show' || (sub === 'update' && s.args.some((a) => a === '--state' || a.startsWith('--state=')));
  }),
};

/** Los servidores MCP de las integraciones de horas (`kind: timeTracking` con `mcp.server`): el núcleo no los nombra. */
let servidores = null;
function servidoresDeHoras() {
  if (servidores === null) {
    try { servidores = INTEGRATIONS.listManifests().manifests.filter((m) => m.kind === 'timeTracking' && m.mcp && m.mcp.server).map((m) => m.mcp.server); }
    catch { servidores = []; }
  }
  return servidores;
}

/** Las banderas de las partes del Arranque, con la parte y el nombre de hoy de cada una (la primera de su lista). */
function partesPorBandera() {
  const out = new Map();
  for (const [parte, def] of Object.entries(STEPS.START_PARTS)) for (const f of def.flags || []) out.set(f, { parte, nombre: def.flags[0] });
  return out;
}
const banderasDePartes = () => [...partesPorBandera().keys()];

/**
 * Parte un comando en segmentos de palabras, como lo haría el shell en lo que importa acá: las comillas y la barra
 * invertida agrupan; `&&`, `||`, `;`, `|`, `&`, el salto de línea, los paréntesis, las llaves y `$(` separan; el cuerpo
 * de un heredoc (`<<TAG` fuera de comillas, no `<<<`) se saltea hasta su cierre.
 */
function trozos(command) {
  const segs = [];
  let palabras = [];
  let actual = '';
  let comilla = null;
  let tiene = false;
  let heredoc = null;
  const cerrarPalabra = () => { if (tiene) palabras.push(actual); actual = ''; tiene = false; };
  const cerrarSegmento = () => { cerrarPalabra(); if (palabras.length) segs.push(palabras); palabras = []; };
  const s = String(command || '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (comilla === "'") { if (ch === "'") comilla = null; else actual += ch; continue; }
    if (comilla === '"') {
      if (ch === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) { actual += s[i + 1]; i += 1; continue; }
      if (ch === '"') comilla = null; else actual += ch;
      continue;
    }
    // fuera de comillas, la barra invertida escapa sólo lo que el shell trataría distinto; delante de una letra queda
    // (una ruta de Windows sin comillas, `D:\acme\…`, no se desarma)
    if (ch === '\\' && i + 1 < s.length && ' \t\n"\'\\$`;&|()<>{}'.includes(s[i + 1])) { if (s[i + 1] !== '\n') { actual += s[i + 1]; tiene = true; } i += 1; continue; }
    if (ch === '"' || ch === "'") { comilla = ch; tiene = true; continue; }
    if (ch === '<' && s[i + 1] === '<' && s[i + 2] !== '<' && s[i - 1] !== '<') {
      const m = /^<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(s.slice(i));
      if (m) { heredoc = m[1]; i += m[0].length - 1; continue; }
    }
    if (ch === '\n') {
      cerrarSegmento();
      if (heredoc) {
        let j = i + 1;
        for (;;) {
          const fin = s.indexOf('\n', j);
          const linea = s.slice(j, fin < 0 ? s.length : fin);
          if (linea.trim() === heredoc || fin < 0) { i = fin < 0 ? s.length : fin; break; }
          j = fin + 1;
        }
        heredoc = null;
      }
      continue;
    }
    if (ch === ';' || ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '`') { cerrarSegmento(); continue; }
    if (ch === '$' && s[i + 1] === '(') { cerrarSegmento(); i += 1; continue; }
    if (ch === '&') { cerrarSegmento(); if (s[i + 1] === '&') i += 1; continue; }
    if (ch === '|') { cerrarSegmento(); if (s[i + 1] === '|') i += 1; continue; }
    if (ch === ' ' || ch === '\t') { cerrarPalabra(); continue; }
    actual += ch; tiene = true;
  }
  cerrarSegmento();
  return segs;
}

/**
 * Cada segmento: sus asignaciones iniciales (`VAR=v`, `export VAR=v`, `$env:VAR=v`, y en PowerShell también
 * `$VAR = v`), su programa y sus argumentos. Un programa o un argumento que nombran una variable asignada antes en el
 * mismo comando (`N=…/node.exe; "$N" …`, la forma de Windows) se leen por su valor.
 */
function segmentos(command) {
  const valores = new Map();
  const expandir = (w) => String(w).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, n) => (valores.has(n) ? valores.get(n) : m));
  return trozos(command).map((p) => {
    const asignaciones = [];
    let i = 0;
    for (;;) {
      if (ANTES_DEL_PROGRAMA.includes(p[i])) { i += 1; continue; }
      if (p[i] === 'export' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(p[i + 1] || '')) { i += 1; continue; }
      const ps = /^\$(?:env:)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(p[i] || '');
      if (ps && p[i + 1] === '=' && p[i + 2] !== undefined) { asignaciones.push(ps[1]); valores.set(ps[1], p[i + 2]); i += 3; continue; }
      const m = /^(?:\$env:|\$)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(p[i] || '');
      if (!m) break;
      asignaciones.push(m[1]);
      valores.set(m[1], m[2]);
      i += 1;
    }
    const crudo = p[i] === undefined ? null : expandir(p[i]);
    const programa = crudo === null ? null : path.basename(crudo.replace(/\\/g, '/')).replace(/\.(exe|cmd)$/i, '');
    return { asignaciones, programa, args: p.slice(i + 1).map(expandir), crudo };
  });
}

/** Lo que sigue a `<guion>` en cada segmento que lo corre (por `node` o el guion mismo): una lista por segmento. */
function argsDe(command, guion) {
  const esGuion = (w) => typeof w === 'string' && w.replace(/\\/g, '/').split('/').pop() === guion;
  const out = [];
  for (const s of segmentos(command)) {
    if (s.programa === 'node') { const k = s.args.findIndex(esGuion); if (k >= 0) out.push(s.args.slice(k + 1)); }
    else if (esGuion(s.crudo)) out.push(s.args);
  }
  return out;
}
/** ¿Algún segmento corre `<guion>` seguido exactamente de `sub`? */
const corre = (command, guion, sub) => argsDe(command, guion).some((r) => sub.every((w, j) => r[j] === w));

/** Los comandos de la conversación con su resultado, en orden: `{ id, name, command, resultado: { texto, is_error } }`. */
function comandos(lineas) {
  const lista = [];
  const porId = new Map();
  for (const o of lineas || []) {
    if (!o || !o.message || !Array.isArray(o.message.content)) continue;
    for (const b of o.message.content) {
      if (o.type === 'assistant' && b && b.type === 'tool_use') {
        const c = { id: b.id, name: String(b.name || ''), command: b.input && typeof b.input.command === 'string' ? b.input.command : '', resultado: null };
        lista.push(c); if (b.id) porId.set(b.id, c);
      } else if (o.type === 'user' && b && b.type === 'tool_result' && porId.has(b.tool_use_id)) {
        const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n') : '';
        porId.get(b.tool_use_id).resultado = { texto: t, is_error: b.is_error === true };
      }
    }
  }
  return lista;
}
const esShell = (c) => c.name === 'Bash' || c.name === 'PowerShell';
const tieneRutaDelArnes = (t) => RUTAS_DEL_ARNES.some((r) => String(t || '').includes(r));

/** Suma `cuenta` por la clave de un objeto de regla. */
function sumar(mapa, regla) {
  const k = JSON.stringify([regla.regla, regla.categoria, regla.con_frase, regla.con_motivo]);
  const prev = mapa.get(k);
  if (prev) prev.cuenta += regla.cuenta; else mapa.set(k, { ...regla });
}

// Las categorías que vienen de afuera se cierran acá, al nacer: la ficha y el resumen de la mañana no llevan texto de
// una conversación ni de bypass.log, aunque tenga forma de nombre.
const EVENTOS_DE_HOOK = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'];
// las de tokens-digest.js: las de su lista, `tiempo` (el hook que se pasó de tiempo) y `otro`
const NOMBRES_HOOK = new Set([...CATEGORIAS_HOOK.map(([n]) => n), 'tiempo', 'otro']);
function categoriaDeHook(a) {
  const evento = EVENTOS_DE_HOOK.includes(a.hookEvent) ? a.hookEvent : 'otro';
  return `${evento}/${NOMBRES_HOOK.has(a.categoria) ? a.categoria : 'otro'}`;
}
/** El `type` de una línea de bypass.log, sólo con forma de constante; si no, `otro`. */
const tipoDeEscape = (t) => (typeof t === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(t) ? t : 'otro');

function reglasDelHilo(lineas, volcado, out) {
  // un hook que se pasó de tiempo (`hook_cancelled`, categoría `tiempo`) también es un aviso que no anduvo
  const hooks = (lineas || []).filter((o) => o && o.type === 'attachment' && o.attachment && (o.attachment.type === 'hook_non_blocking_error' || o.attachment.type === 'hook_cancelled'));
  for (const h of hooks) sumar(out, { regla: 'RR-HOOK', categoria: categoriaDeHook(h.attachment), cuenta: 1 });
  const cs = comandos(lineas);
  const cierre = volcado && volcado.marker && volcado.marker.cierre && typeof volcado.marker.cierre === 'object' ? volcado.marker.cierre : null;
  const partes = partesPorBandera();
  const ultima = {};
  const errorCat = (t) => { const c = CATEGORIAS_HOOK.slice(0, 2).find(([, re]) => re.test(t)); return c ? c[0] : null; };
  for (const c of cs) {
    for (const [parte, es] of Object.entries(ACCIONES_DE_PARTE)) if (es(c)) ultima[parte] = { ok: !(c.resultado && c.resultado.is_error) };
    if (!esShell(c)) continue;
    // un guion del arnés que no arrancó: el comando corre uno (su primer argumento que no es una opción) y el error de
    // su salida nombra una ruta del arnés (lo que el arnés retransmite de un comando del proyecto no la nombra)
    const correGuion = segmentos(c.command).some((s) => s.programa === 'node' && !s.args.includes('-e') && tieneRutaDelArnes(s.args.find((a) => !a.startsWith('-'))));
    if (correGuion && c.resultado && tieneRutaDelArnes(c.resultado.texto)) {
      const cat = errorCat(c.resultado.texto);
      if (cat) sumar(out, { regla: 'RR-NODE', categoria: cat, cuenta: 1 });
    }
    const marker = argsDe(c.command, 'marker.js');
    const apagos = marker.filter((r) => r[0] === 'set-autonomous' && !PRENDE_AUTONOMO.includes(String(r[1]).toLowerCase())).length;
    if (apagos) sumar(out, { regla: 'RR-APAGO', categoria: null, cuenta: apagos, con_frase: cierre ? cierre.via === 'persona' : null });
    for (const [bandera, { parte, nombre }] of partes) {
      if (!marker.some((r) => r[0] === 'set-flag' && r[1] === bandera && PRENDE_BANDERA.includes(r[2]))) continue;
      if (!ultima[parte] || !ultima[parte].ok) sumar(out, { regla: 'RR-BANDERA', categoria: nombre, cuenta: 1 });
    }
  }
  return { hilo_sin_hooks: hooks.length === 0, comandos: cs };
}

function escapesDeComandos(cs) {
  const cats = [];
  for (const c of cs) {
    if (!esShell(c)) continue;
    for (const s of segmentos(c.command)) {
      for (const a of s.asignaciones) if (ESCAPES.includes(a)) cats.push(a);
      if (s.programa === 'git') {
        const commit = s.args.includes('commit');
        if (s.args.includes('--no-verify') || (commit && s.args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a)))) cats.push('--no-verify');
      }
    }
    const marker = argsDe(c.command, 'marker.js');
    if (marker.some((r) => r[0] === 'set-flag' && r[1] === 'atddBypass' && PRENDE_BANDERA.includes(r[2]))) cats.push('atddBypass');
    if (marker.some((r) => r[0] === 'story-skill-bypass')) cats.push('story-skill-bypass');
  }
  return cats;
}

function reglaDeCierre(volcado, out) {
  const m = (volcado && volcado.marker) || {};
  const pendientes = Array.isArray(m.stepsPending) ? m.stepsPending.length : 0;
  const rojos = Object.values(m.checks || {}).filter((v) => /^red/.test(String(v))).length;
  const c = m.cierre && typeof m.cierre === 'object' ? m.cierre : null;
  if (c) {
    if (c.estado === 'abortada' || c.estado === 'abandonada') sumar(out, { regla: 'RR-CIERRE', categoria: c.estado, cuenta: 1 });
    else if (c.estado === 'completa') { if (pendientes || rojos) sumar(out, { regla: 'RR-CIERRE', categoria: 'incoherente', cuenta: 1, pendientes, rojos }); }
    else if (c.estado !== 'deuda') sumar(out, { regla: 'RR-CIERRE', categoria: 'desconocido', cuenta: 1 });
    return;
  }
  if (volcado && volcado.sinCerrar === true) { sumar(out, { regla: 'RR-CIERRE', categoria: 'sin-cerrar', cuenta: 1 }); return; }
  if (volcado && volcado.archivedAt && (pendientes || rojos)) sumar(out, { regla: 'RR-CIERRE', categoria: 'derivada', cuenta: 1, pendientes, rojos });
}

/**
 * Las líneas de bypass.log que son de esta ejecución: por `sessionId`, o, en las que no lo traen (los frenos de PR a
 * mano y de la suite completa), por la hora, entre el arranque y el archivo de la ejecución.
 */
function delRegistro(lineas, volcado) {
  const m = (volcado && volcado.marker) || {};
  const desde = Date.parse(m.startedAt || '');
  // sin `archivedAt` (sin cerrar) no hay fin de ventana: sólo cuentan las líneas de su sesión, y el resultado no depende
  // de la hora a la que corre la pasada
  const hasta = Date.parse((volcado && volcado.archivedAt) || '');
  return lineas.filter((l) => {
    if (!l || typeof l !== 'object') return false;
    if (l.sessionId) return l.sessionId === m.sessionId;
    if (!Number.isFinite(hasta)) return false;
    const t = Date.parse(l.ts || '');
    return Number.isFinite(desde) && Number.isFinite(t) && t >= desde && t <= hasta;
  });
}

/**
 * Las fallas de una ejecución. `lineasHilo: null` = no hay conversación: sólo corren las reglas del volcado y los
 * registros, y `sin_hilo: true` (nunca «sin fallas»). `registros: { bypass: [líneas] | null, cobertura }`.
 */
function revisar({ volcado, lineasHilo, registros }) {
  const out = new Map();
  const sinHilo = lineasHilo === null || lineasHilo === undefined;
  let hiloSinHooks = null;
  let cs = [];
  if (!sinHilo) { const r = reglasDelHilo(lineasHilo, volcado, out); hiloSinHooks = r.hilo_sin_hooks; cs = r.comandos; }
  reglaDeCierre(volcado, out);
  const fuente = registros && registros.cobertura && registros.cobertura.fuentes && registros.cobertura.fuentes.bypass;
  const medido = Boolean(fuente && fuente.estado === 'medido' && Array.isArray(registros.bypass));
  const propias = medido ? delRegistro(registros.bypass, volcado) : [];
  const cubiertas = new Set(propias.map((l) => EQUIVALENTES[l.type || l.kind]).filter(Boolean));
  for (const l of propias) sumar(out, { regla: 'RR-ESCAPE', categoria: tipoDeEscape(l.type || l.kind), cuenta: 1, con_motivo: typeof l.reason === 'string' && l.reason.trim() !== '' });
  for (const cat of escapesDeComandos(cs)) if (!cubiertas.has(cat)) sumar(out, { regla: 'RR-ESCAPE', categoria: cat, cuenta: 1 });
  const reglas = [...out.values()].map((r) => { const x = { ...r }; for (const k of Object.keys(x)) if (x[k] === undefined) delete x[k]; return x; });
  return { reglas, sin_hilo: sinHilo, escapes_registro: medido ? 'medido' : 'no_medido', hilo_sin_hooks: hiloSinHooks };
}

module.exports = { CODIGOS, ESCAPES, EQUIVALENTES, ACCIONES_DE_PARTE, RUTAS_DEL_ARNES, banderasDePartes, segmentos, argsDe, corre, comandos, revisar };
