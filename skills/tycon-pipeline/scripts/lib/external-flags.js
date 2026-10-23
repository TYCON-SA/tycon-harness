'use strict';
/**
 * external-flags — las banderas del marcador que dicen que algo de afuera se hizo, y los comandos del arnés que las
 * ponen.
 *
 * Una bandera de hecho externo (el aviso de trabajo a la herramienta de horas, el pedido de Azure DevOps en activo) la
 * pone el arnés cuando hizo el trabajo, nunca el modelo con `marker.js set-flag`: una bandera puesta a mano dice
 * «hecho» sobre algo que nadie verificó. Las demás banderas son estado de la ejecución, y cada una dice por qué el
 * modelo la puede poner. Cada bandera está en exactamente una de las dos listas.
 *
 * `adoMarkActive` le pide a la capa de plataforma que pase el pedido de la historia a su estado activo, y recién con su
 * respuesta marca. `actionDone` busca, en
 * la conversación de la sesión, la llamada a la herramienta de horas que hizo el agente después del aviso de trabajo:
 * marca sólo si el resultado de esa llamada trae el id que se le pasa. Sin conversación que leer (Codex), marca, lo
 * avisa y deja la constancia sin verificar.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EXTERNAL_FLAGS = ['workSignalStarted', 'adoMarkedActive'];
const RUN_FLAGS = {
  atddBypass: 'el escape consciente del freno de pruebas primero: lo pide el agente y queda en bypass.log',
  waitingForHuman: 'la ejecución espera una respuesta de la persona: lo sabe el agente que hizo la pregunta',
  heavyValidationRequested: 'la persona pidió la validación pesada: el agente anota lo que se le pidió',
};
const VALID_FLAGS = [...EXTERNAL_FLAGS, ...Object.keys(RUN_FLAGS)];
const HARNESS_COMMAND = {
  workSignalStarted: 'pipeline.js work-signal start (y, si devuelve una acción, work-signal start --action-done "<id>")',
  adoMarkedActive: 'pipeline.js ado-mark-active',
};
const PART_OF = { workSignalStarted: 'time-tracking', adoMarkedActive: 'ado' };

const isNil = (v) => v === undefined || v === null;

// ── el pedido de trabajo ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Pide a la capa de plataforma (`platform.js work-item update`, la plataforma la elige el perfil) que pase el pedido a
 * activo, y dice si se puede marcar. El núcleo no habla con ninguna plataforma: lee la respuesta de la capa.
 * → `{ code, marked, line }`: 0 marcado (pasó a activo o ya lo estaba), 3 cerrado (`pideReabrir`: lo decide una
 * persona), 1 la capa dijo que no o no contestó.
 */
function adoMarkActive({ workItem, repoDir, reopen = false, assignTo = null, platformJs, env = process.env }) {
  const salida = 'si no se puede, marker.js start-warning ado "<motivo>"';
  if (!workItem) return { code: 1, marked: false, line: `ado-mark-active: la historia no tiene pedido de trabajo (work_item:); ${salida}` };
  if (!platformJs || !fs.existsSync(platformJs)) return { code: 1, marked: false, line: `ado-mark-active: el arnés que corre no trae la capa de plataforma (${platformJs}); ${salida}` };
  const args = { repoDir, id: Number(workItem), ...(reopen ? { reopen: true } : {}), ...(assignTo ? { assignTo } : {}) };
  const p = spawnSync(process.execPath, [platformJs, 'work-item', 'update', '--args', JSON.stringify(args)], { encoding: 'utf8', env, windowsHide: true, timeout: 120000 });
  let r = null;
  try { r = JSON.parse(String(p.stdout || '').trim().split('\n').pop()); } catch (_) { r = null; }
  if (!r || typeof r !== 'object') {
    const detalle = String(p.stderr || '').trim().split('\n')[0] || (p.error ? p.error.code : `salió ${p.status}`);
    return { code: 1, marked: false, line: `ado-mark-active: la capa de plataforma no contestó (${detalle}); ${salida}` };
  }
  const resumen = typeof r.summary === 'string' && r.summary ? r.summary : null;
  if (r.ok !== true) return { code: 1, marked: false, line: `ado-mark-active: ${resumen || `${r.reason}: ${r.detail}`}; ${salida}` };
  const v = r.value || {};
  // un «sí» sin estado, o de un proceso que salió mal, no prueba que el pedido quedó activo
  if (p.status !== 0 || typeof v.estado !== 'string' || !v.estado) {
    return { code: 1, marked: false, line: `ado-mark-active: la capa contestó sin el estado del pedido (salió ${p.status}); ${salida}` };
  }
  if (v.pideReabrir === true) {
    return { code: 3, marked: false, line: `ado-mark-active: el pedido #${workItem} está en ${v.estado}: pide confirmación de la persona antes de reabrirlo; con su ok, ado-mark-active --reopen` };
  }
  return { code: 0, marked: true, line: resumen || `pedido de trabajo #${workItem}: ${v.previo} → ${v.estado}` };
}

// ── la acción de la herramienta de horas ─────────────────────────────────────────────────────────────────────────────
const contenido = (r) => (r && r.message && Array.isArray(r.message.content) ? r.message.content : []);
const texto = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : '');
// El aviso de trabajo es el comando entero, no un texto que lo nombra (`echo`): a lo sumo un `cd …&&` adelante, el
// operador de llamada de PowerShell (`&`), rutas entre comillas (una carpeta con espacio o acento) y redirecciones al final.
const PALABRA = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
const EMISION = new RegExp(String.raw`^\s*(?:cd\s+[^;&|]+&&\s*)?(?:&\s*)?(?:"[^"]*node[^"]*"|'[^']*node[^']*'|\S*node(?:\.exe)?)\s+` +
  String.raw`(?:"[^"]*pipeline\.js"|'[^']*pipeline\.js'|\S*pipeline\.js)\s+work-signal\s+start` +
  String.raw`(?:\s+(?:\d?>&\d|\d?>>?\s*${PALABRA}|\*>\s*${PALABRA}))*\s*$`);
// Las herramientas que corren comandos de la terminal: Claude Code usa PowerShell en Windows.
const TERMINAL = ['Bash', 'PowerShell'];
// Un id más corto que esto coincide con casi cualquier resultado.
const ID_MIN = 6;

const esCodex = (env) => !!env.CODEX_SESSION_ID && !env.CLAUDE_CODE_SESSION_ID;
const escapar = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * En estos registros: ¿hay, después del último `work-signal start` que salió bien con una acción, una llamada a una
 * herramienta del mismo servidor MCP que esa acción nombra, cuyo resultado sin error trae `id` como palabra entera? O
 * bien: ¿la acción misma nombra ese id (la integración avisó una entrada ya abierta)? La acción la escribe el arnés, no
 * el agente. → `{ ok, herramienta?, motivo? }`.
 */
function enRegistros(registros, id) {
  const resultados = new Map();
  for (const r of registros) for (const b of contenido(r)) if (b && b.type === 'tool_result') resultados.set(b.tool_use_id, { error: !!b.is_error, texto: texto(b.content) });
  const usos = [];
  for (const r of registros) for (const b of contenido(r)) if (b && b.type === 'tool_use') usos.push(b);
  let desde = -1;
  let accion = '';
  usos.forEach((b, i) => {
    const cmd = String((b.input || {}).command || '');
    const res = resultados.get(b.id);
    if (!TERMINAL.includes(b.name) || !EMISION.test(cmd) || !res || res.error) return;
    desde = i;
    accion = res.texto;
  });
  if (desde < 0) return { ok: false, motivo: 'no encuentro en esta sesión un `pipeline.js work-signal start` que haya salido bien' };
  // los servidores MCP que nombra la acción: cerrar una entrada vieja y abrir otra usan dos herramientas del mismo
  const servidores = [...new Set((accion.match(/mcp__[\w-]+?__[\w-]+/g) || []).map((t) => t.replace(/^(mcp__[\w-]+?__).*$/, '$1')))];
  if (!servidores.length) return { ok: false, motivo: 'la acción del aviso de trabajo no nombra la herramienta MCP que había que usar: no hay contra qué comparar' };
  const palabra = new RegExp(`(^|[^\\w-])${escapar(id)}($|[^\\w-])`);
  // una entrada ya abierta: la acción misma trae su id
  if (palabra.test(accion)) return { ok: true, herramienta: 'la entrada ya abierta que avisó la integración' };
  for (const b of usos.slice(desde + 1)) {
    if (!servidores.some((s) => String(b.name || '').startsWith(s))) continue;
    const res = resultados.get(b.id);
    if (res && !res.error && palabra.test(res.texto)) return { ok: true, herramienta: b.name };
  }
  return { ok: false, motivo: `ninguna llamada a ${servidores.map((s) => `${s}*`).join(' o ')} después del aviso de trabajo devolvió «${id}»: hacé la acción y pasá el id que devolvió` };
}

/** La evidencia de la acción para la sesión. → `{ ok, verificado, herramienta?, motivo? }`. */
function actionDone({ id, env = process.env, home = os.homedir() }) {
  const limpio = String(isNil(id) ? '' : id).trim();
  if (!limpio) return { ok: false, verificado: false, motivo: 'falta el id que devolvió la herramienta: --action-done "<id>"' };
  if (limpio.length < ID_MIN) return { ok: false, verificado: false, motivo: `el id «${limpio}» es demasiado corto para buscarlo (mínimo ${ID_MIN} caracteres): pasá el id entero que devolvió la herramienta` };
  if (esCodex(env)) return { ok: true, verificado: false, motivo: 'Codex no guarda una conversación que el arnés pueda leer: la acción queda sin verificar' };
  const pok = require('./person-ok.js');
  const conv = pok.leerConversacion({ env, home, sesion: env.CLAUDE_CODE_SESSION_ID });
  if (!conv.legible) return { ok: false, verificado: false, motivo: `no puedo leer la conversación de esta sesión (${conv.motivo})` };
  const cadena = require('./validator-record.js').conRespuestas(conv.registros);
  const r = enRegistros(cadena, limpio);
  return Object.assign({ verificado: r.ok }, r);
}

module.exports = {
  EXTERNAL_FLAGS, RUN_FLAGS, VALID_FLAGS, HARNESS_COMMAND, PART_OF,
  adoMarkActive, actionDone, enRegistros, esCodex,
};
