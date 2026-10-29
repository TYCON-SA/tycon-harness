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
 * avisa y deja la constancia sin verificar. `horasDeLaAccion` hace lo mismo al cerrar: lee las horas del resultado de la
 * llamada que cerró la entrada.
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
// operador de llamada de PowerShell (`&`), rutas entre comillas (una carpeta con espacio o acento), redirecciones al final y
// otro comando atrás (`; echo rc=$?`, `&& …`). Un tubo (`| …`) no: lo que sale ya no es lo que dijo el aviso.
const PALABRA = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
// El `stop` lleva sus opciones (`--story`, `--repo`) antes de las redirecciones.
const emision = (evento) => new RegExp(String.raw`^\s*(?:cd\s+[^;&|]+&&\s*)?(?:&\s*)?(?:"[^"]*node[^"]*"|'[^']*node[^']*'|\S*node(?:\.exe)?)\s+` +
  String.raw`(?:"[^"]*pipeline\.js"|'[^']*pipeline\.js'|\S*pipeline\.js)\s+work-signal\s+${evento}` +
  (evento === 'stop' ? String.raw`(?:\s+--(?:story|repo)\s+${PALABRA})*` : '') +
  String.raw`(?:\s+(?:\d?>&\d|\d?>>?\s*${PALABRA}|\*>\s*${PALABRA}))*(?:\s*(?:;|&&|\|\|).*)?\s*$`);
const EMISION = emision('start');
const EMISION_STOP = emision('stop');
// Las herramientas que corren comandos de la terminal: Claude Code usa PowerShell en Windows.
const TERMINAL = ['Bash', 'PowerShell'];
// Un id más corto que esto coincide con casi cualquier resultado.
const ID_MIN = 6;

const esCodex = (env) => !!env.CODEX_SESSION_ID && !env.CLAUDE_CODE_SESSION_ID;
const escapar = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Salió bien: la herramienta no dio error, la salida trae la del aviso (`"ran":true`) y, si un comando de atrás muestra
// el código de salida (`rc=…`), es 0. Con otro comando atrás la herramienta queda en verde aunque el aviso haya fallado.
const salioBien = (res) => !!res && !res.error && /"ran"\s*:\s*true/.test(res.texto) && !/(^|\n)\s*rc=["']?[1-9]\d*["']?\s*($|\n)/.test(res.texto);
const esAviso = (b, res, re = EMISION) => TERMINAL.includes(b.name) && re.test(String((b.input || {}).command || '')) && salioBien(res);
const palabraEntera = (id) => new RegExp(`(^|[^\\w-])${escapar(id)}($|[^\\w-])`);

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
    const res = resultados.get(b.id);
    if (!esAviso(b, res)) return;
    desde = i;
    accion = res.texto;
  });
  if (desde < 0) return { ok: false, motivo: 'no encuentro en esta sesión un `pipeline.js work-signal start` que haya salido bien' };
  // los servidores MCP que nombra la acción: cerrar una entrada vieja y abrir otra usan dos herramientas del mismo
  const servidores = [...new Set((accion.match(/mcp__[\w-]+?__[\w-]+/g) || []).map((t) => t.replace(/^(mcp__[\w-]+?__).*$/, '$1')))];
  if (!servidores.length) return { ok: false, motivo: 'la acción del aviso de trabajo no nombra la herramienta MCP que había que usar: no hay contra qué comparar' };
  const palabra = palabraEntera(id);
  // una entrada ya abierta: la acción misma trae su id
  if (palabra.test(accion)) return { ok: true, herramienta: 'la entrada ya abierta que avisó la integración' };
  for (const b of usos.slice(desde + 1)) {
    if (!servidores.some((s) => String(b.name || '').startsWith(s))) continue;
    const res = resultados.get(b.id);
    if (res && !res.error && palabra.test(res.texto)) return { ok: true, herramienta: b.name };
  }
  return { ok: false, motivo: `ninguna llamada a ${servidores.map((s) => `${s}*`).join(' o ')} después del aviso de trabajo devolvió «${id}»: hacé la acción y pasá el id que devolvió` };
}

/**
 * La entrada abierta de la sesión que confirma algo de la conversación: un resultado sin error de una herramienta del
 * servidor MCP de la integración, o la salida de un aviso de trabajo que salió bien, con `id` como palabra entera. La
 * entrada sola, en el archivo de la integración, no alcanza: la escribe el agente. → nombre de lo que la confirma, o null.
 */
function confirmaEntrada(registros, id, servidor) {
  const resultados = new Map();
  for (const r of registros) for (const b of contenido(r)) if (b && b.type === 'tool_result') resultados.set(b.tool_use_id, { error: !!b.is_error, texto: texto(b.content) });
  const palabra = palabraEntera(id);
  for (const r of registros) for (const b of contenido(r)) {
    if (!b || b.type !== 'tool_use') continue;
    const res = resultados.get(b.id);
    if (!res || res.error || !palabra.test(res.texto)) continue;
    if (servidor && String(b.name || '').startsWith(`mcp__${servidor}__`)) return b.name;
    if (esAviso(b, res)) return 'la salida del aviso de trabajo';
  }
  return null;
}

/**
 * La entrada que la integración de horas tiene abierta para esta sesión (el evento `entry` de `scripts/lib/work-signal.js`),
 * con el servidor MCP de su manifiesto: `{ entryId, servidor }`, o null si no hay, no se sabe o el arnés no trae el evento.
 */
function entradaAbierta({ repo, sessionId, env = process.env, home } = {}) {
  try {
    const dir = require('./harness-path.js').rutaArnesHook({ env, home }).dir;
    if (!dir || !sessionId) return null;
    const ws = require(path.join(dir, 'scripts', 'lib', 'work-signal.js'));
    if (!Array.isArray(ws.EVENTS) || !ws.EVENTS.includes('entry')) return null;
    const c = ws.chosen({ env, home });
    const r = ws.emit('entry', { repo: repo || null, sessionId }, { env, home });
    const entryId = r && r.result && typeof r.result.entryId === 'string' ? r.result.entryId.trim() : '';
    return entryId ? { entryId, servidor: c && c.manifest && c.manifest.mcp ? c.manifest.mcp.server : null } : null;
  } catch (_) { return null; }
}

/**
 * La evidencia de la acción para la sesión. `abierta` es la entrada que la integración tiene abierta (`entradaAbierta`):
 * sin un aviso de trabajo reconocible, un id que es esa entrada marca si algo de la conversación lo confirma; si nada lo
 * confirma, no marca y vuelve `sinConfirmar`. → `{ ok, verificado, herramienta?, motivo?, sinConfirmar? }`.
 */
function actionDone({ id, env = process.env, home = os.homedir(), abierta = null }) {
  const limpio = String(isNil(id) ? '' : id).trim();
  if (!limpio) return { ok: false, verificado: false, motivo: 'falta el id que devolvió la herramienta: --action-done "<id>"' };
  if (limpio.length < ID_MIN) return { ok: false, verificado: false, motivo: `el id «${limpio}» es demasiado corto para buscarlo (mínimo ${ID_MIN} caracteres): pasá el id entero que devolvió la herramienta` };
  if (esCodex(env)) return { ok: true, verificado: false, motivo: 'Codex no guarda una conversación que el arnés pueda leer: la acción queda sin verificar' };
  const pok = require('./person-ok.js');
  const conv = pok.leerConversacion({ env, home, sesion: env.CLAUDE_CODE_SESSION_ID });
  if (!conv.legible) return { ok: false, verificado: false, motivo: `no puedo leer la conversación de esta sesión (${conv.motivo})` };
  const cadena = require('./validator-record.js').conRespuestas(conv.registros);
  const r = enRegistros(cadena, limpio);
  if (!r.ok && abierta && abierta.entryId === limpio) {
    const conf = confirmaEntrada(cadena, limpio, abierta.servidor);
    if (conf) return { ok: true, verificado: true, herramienta: `la entrada abierta de la sesión, confirmada por ${conf}` };
    return { ok: false, verificado: false, sinConfirmar: true,
      motivo: `registro de horas abierto, sin confirmar por el arnés: «${limpio}» es la entrada abierta de la sesión, pero ningún resultado de la herramienta ni salida del aviso de trabajo lo trae` };
  }
  return Object.assign({ verificado: r.ok }, r);
}

/** El intervalo que trae el resultado de la herramienta (`start`/`end`, sueltos o en `timeInterval`) → segundos, o null. */
function segundosDelResultado(t) {
  const candidatos = [];
  try { candidatos.push(JSON.parse(t)); } catch (_) {
    const m = /\{[\s\S]*\}/.exec(t);
    if (m) try { candidatos.push(JSON.parse(m[0])); } catch (_) { /* sin un objeto que leer */ }
  }
  for (const o of candidatos) {
    const iv = o && typeof o === 'object' ? (o.timeInterval && typeof o.timeInterval === 'object' ? o.timeInterval : o) : null;
    if (!iv || typeof iv.start !== 'string' || typeof iv.end !== 'string') continue;
    const desde = Date.parse(iv.start);
    const hasta = Date.parse(iv.end);
    if (Number.isFinite(desde) && Number.isFinite(hasta) && hasta >= desde) return Math.round((hasta - desde) / 1000);
  }
  return null;
}

/**
 * Las horas de una herramienta que informa por una acción, con constancia: después del último `work-signal stop` que
 * salió bien, cuya acción nombra la entrada `id`, una llamada a una herramienta del servidor MCP que esa acción nombra,
 * con un resultado sin error que trae `id` como palabra entera y el intervalo de la entrada. El id que se pasa tiene que
 * ser el que nombró el arnés: una entrada vieja y más larga no cuenta. Sin conversación que leer (Codex) no hay
 * constancia. → `{ ok, segundos?, herramienta?, motivo? }`.
 */
function horasDeLaAccion({ id, env = process.env, home = os.homedir() }) {
  const limpio = String(isNil(id) ? '' : id).trim();
  if (!limpio) return { ok: false, motivo: 'falta el id de la entrada que cerró la herramienta: --action-done "<id>"' };
  if (limpio.length < ID_MIN) return { ok: false, motivo: `el id «${limpio}» es demasiado corto para buscarlo (mínimo ${ID_MIN} caracteres)` };
  if (esCodex(env)) return { ok: false, motivo: 'Codex no guarda una conversación que el arnés pueda leer: sin constancia, esas horas no se anotan como real' };
  const conv = require('./person-ok.js').leerConversacion({ env, home, sesion: env.CLAUDE_CODE_SESSION_ID });
  if (!conv.legible) return { ok: false, motivo: `no puedo leer la conversación de esta sesión (${conv.motivo})` };
  const registros = require('./validator-record.js').conRespuestas(conv.registros);
  const resultados = new Map();
  for (const r of registros) for (const b of contenido(r)) if (b && b.type === 'tool_result') resultados.set(b.tool_use_id, { error: !!b.is_error, texto: texto(b.content) });
  const usos = [];
  for (const r of registros) for (const b of contenido(r)) if (b && b.type === 'tool_use') usos.push(b);
  let desde = -1;
  let accion = '';
  usos.forEach((b, i) => {
    const res = resultados.get(b.id);
    if (!esAviso(b, res, EMISION_STOP)) return;
    desde = i;
    accion = res.texto;
  });
  if (desde < 0) return { ok: false, motivo: 'no encuentro en esta sesión un `pipeline.js work-signal stop` que haya salido bien' };
  const palabra = palabraEntera(limpio);
  if (!palabra.test(accion)) return { ok: false, motivo: `la acción del último work-signal stop no nombra la entrada «${limpio}»: pasá el id de la entrada que te pidió cerrar` };
  const servidores = [...new Set((accion.match(/mcp__[\w-]+?__[\w-]+/g) || []).map((t) => t.replace(/^(mcp__[\w-]+?__).*$/, '$1')))];
  if (!servidores.length) return { ok: false, motivo: 'la acción del work-signal stop no nombra la herramienta MCP que había que usar: no hay contra qué comparar' };
  let sinIntervalo = null;
  for (const b of usos.slice(desde + 1).reverse()) {
    if (!servidores.some((s) => String(b.name || '').startsWith(s))) continue;
    const res = resultados.get(b.id);
    if (!res || res.error || !palabra.test(res.texto)) continue;
    const segundos = segundosDelResultado(res.texto);
    if (segundos !== null) return { ok: true, segundos, herramienta: b.name };
    sinIntervalo = b.name;
  }
  if (sinIntervalo) return { ok: false, motivo: `el resultado de ${sinIntervalo} trae «${limpio}» pero no el inicio y el fin de la entrada: no hay de dónde sacar las horas` };
  return { ok: false, motivo: `ninguna llamada a ${servidores.map((s) => `${s}*`).join(' o ')} después del work-signal stop devolvió «${limpio}»: cerrá la entrada y pasá su id` };
}

module.exports = {
  EXTERNAL_FLAGS, RUN_FLAGS, VALID_FLAGS, HARNESS_COMMAND, PART_OF,
  adoMarkActive, actionDone, enRegistros, entradaAbierta, esCodex, horasDeLaAccion, segundosDelResultado,
};
