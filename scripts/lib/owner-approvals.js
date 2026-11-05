'use strict';
/**
 * owner-approvals.js — la aprobación explícita de la persona, sin terminal: un click en el cuadro de opciones o un
 * mensaje suyo que sea un «aprobado» («aprobado», «apruebo», «sí, aprobado»). La anota un gancho
 * (scripts/hooks/owner-approval-record.js); la consume una firma (owner-window.js `decidir`) donde la ventana de permiso
 * no llega (una pestaña sin permisos, una sesión de fondo), en lugar de mandar a la terminal.
 *
 * Cada aprobación sirve para UNA firma y UN comando. La pregunta del cuadro la arma el guion (`cuadroDe`: qué se aprueba,
 * qué pasa si sale mal y el sello «firma <id> · sesión <id> · código <huella del comando>»), el agente la muestra tal cual
 * y se compara entera; el último mensaje del agente antes de un «aprobado» tiene que traer el sello. Vence a los 30
 * minutos. Vale en la sesión donde se dio o en la coordinadora designada y confirmada, si su proceso sigue vivo. Gana a la
 * delegación: lo que la coordinadora no puede firmar por su cuenta (un plan delicado, un guardado que toca algo sensible)
 * pasa con la aprobación de la persona. Lo irreversible (owner-window.js `TERMINAL_SIEMPRE`) no la acepta.
 *
 * Por qué el agente no la puede fingir:
 * - El modelo no puede llenar la respuesta del cuadro: la herramienta la descarta antes de mostrarlo.
 * - El gancho anota sólo si lo lanzó la herramienta, sin otra herramienta ni la consola de un agente en el medio: un
 *   agente que lo corre a mano, o que abre otra sesión en una pseudo-terminal y le escribe «aprobado», no anota nada.
 * - Al consumir se relee la transcripción de la sesión (la ruta sale del id de la sesión, no del registro): tiene que
 *   estar el mensaje tipeado por la persona (`origin.kind: human`, `promptSource: typed`, `entrypoint: cli`) a la hora
 *   del registro, o el cuadro con esa pregunta, contestado con esa opción a esa hora y no por un gancho
 *   (`permissionDecision.source: hook`).
 * - Para el click se revisan además las capas de configuración (también `managed-settings.d/` y `--settings`), los plugins
 *   instalados (`hooks.json`, los ganchos de su `plugin.json`, `--plugin-dir`) y el encabezado de skills y agentes: un
 *   gancho que no es del arnés sobre el cuadro (PreToolUse o PermissionRequest), o algo que no se puede leer, y el click no
 *   vale.
 * - El registro no se escribe, mueve ni borra por Edit, Write ni la consola (story-gate.js, on-bash-write-gate.js).
 * Lo que no cubre: un agente que rompa un freno a propósito (un guion que escribe a mano el registro y la transcripción),
 * y las banderas de una sesión de fondo, porque su proceso no las muestra.
 *
 * La parte de acá no depende de la herramienta salvo las funciones de Claude Code (la transcripción, las capas, el
 * árbol de procesos). Codex queda para después: tiene el cuadro (`request_user_input`), que en el modo normal pide la
 * bandera `features.default_mode_request_user_input`, y su gancho de prompt.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib');
const stateDir = (casa) => require(path.join(LIB, 'state-dir.js')).stateDir(casa);
// la carpeta de Claude Code de la cuenta, por el ayudante: el nombre no se escribe acá
const carpetaClaude = (casa) => require(path.join(LIB, 'state-dir.js')).claudeDir(casa);
const VENCE_MIN = 30;
// la distancia entre la hora del registro y la del renglón de la transcripción
const MARGEN_MS = 2 * 60 * 1000;
const SESION = /^[\w-]+$/;
const CUADRO = 'AskUserQuestion';
const APRUEBA = 'Sí, aprobar';
const NIEGA = 'No';
// lo que llega como prompt sin que lo haya escrito la persona: mensajes de otra sesión, de un canal, avisos de tareas
const ENVUELTO = /<(?:cross-session-message|channel|task-notification|teammate-message|system-reminder|local-command|command-name)\b/i;
// los ganchos del arnés que pueden escuchar el cuadro: el aviso de espera, el que anota el click, el estado de la sesión y
// el freno que no deja preguntar a una sesión abierta por la coordinadora
const PERMITIDOS = ['wait-notice.js', 'owner-approval-record.js', 'session-state.js', 'background-question-guard.js'];
// Cómo anota la herramienta un mensaje tipeado, medido en transcripciones reales: en la consola `cli · typed`, en la extensión
// del editor `claude-vscode · sdk`. Otra sesión llega con `system`, y un programa (`claude -p`) con `sdk-cli`.
const TIPEADO = { cli: ['typed'], 'claude-vscode': ['sdk'] };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const una = (s, n = 200) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const ow = () => require('./owner-window.js');

function carpeta(casa) { return path.join(stateDir(casa), 'owner-approvals'); }

// --- qué es una aprobación ------------------------------------------------------------------------------------------

// el mensaje entero es una aprobación: «aprobado», «apruebo», «aprobalo», «sí, aprobar»…, con un «ok», «sí» o «dale»
// adelante si se quiere, y a lo sumo unas palabras después que no la condicionen
const FORMA = /^(?:(?:ok|okay|sí|si|dale|listo|bien)[\s,.!:]+)*(?:aprobad[oa]s?|apruebo|aprobalo|aprobala|aprobá|sí,?\s*aprobar)(?=[\s,.!]|$)/u;
// lo que la condiciona o la deja para después, aunque empiece bien
const CONDICIONA = /(^|[^\p{L}])(?:no|nunca|tampoco|ni|jamás|jamas|salvo|excepto|menos|pero|después|despues|luego|mañana|manana|tarde|cuando|si|antes|todavía|todavia|aún|aun|esperá|espera)(?=[^\p{L}]|$)/u;

/**
 * ¿El texto aprueba, sin duda? El mensaje entero (hasta 60 letras) es un «aprobado», sin preguntas ni nada que lo niegue,
 * lo condicione o lo deje para después. Ante la duda, no aprueba.
 */
function esAprobacion(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFC').trim().replace(/[.!\s]+$/u, '');
  if (!t || t.length > 60 || /[?¿]/.test(t)) return false;
  const m = FORMA.exec(t);
  if (!m) return false;
  return !CONDICIONA.test(t.slice(m[0].length));
}

/** El prompt, si lo escribió la persona y es un «aprobado»; null si no. */
function mensajeDeLaPersona(prompt) {
  const t = String(prompt == null ? '' : prompt).trim();
  if (!t || ENVUELTO.test(t)) return null;
  return esAprobacion(t) ? t : null;
}

/**
 * La respuesta del cuadro, tal como la devolvió la herramienta (`tool_response`, nunca `tool_input`): `{ ok, pregunta,
 * respuesta }` si la persona eligió una opción que aprueba, o `{ ok: false, motivo }`. Una sola pregunta; sin
 * resolución por ausencia (`afkTimeoutMs`) ni preguntas sin contestar (`annotations.*.unanswered`).
 */
function respuestaDelCuadro(salida) {
  const r = salida && typeof salida === 'object' ? salida : null;
  if (!r) return { ok: false, motivo: 'la herramienta no devolvió respuesta' };
  if (r.afkTimeoutMs !== undefined && r.afkTimeoutMs !== null) return { ok: false, motivo: 'el cuadro se resolvió solo, por ausencia' };
  const notas = r.annotations && typeof r.annotations === 'object' ? Object.values(r.annotations) : [];
  if (notas.some((n) => n && typeof n === 'object' && n.unanswered)) return { ok: false, motivo: 'una pregunta quedó sin contestar' };
  const respuestas = r.answers && typeof r.answers === 'object' ? Object.entries(r.answers) : [];
  if (respuestas.length !== 1) return { ok: false, motivo: respuestas.length ? 'el cuadro tenía más de una pregunta' : 'nadie contestó el cuadro' };
  const [pregunta, respuesta] = respuestas[0];
  if (typeof respuesta !== 'string' || !esAprobacion(respuesta)) return { ok: false, motivo: 'la opción elegida no aprueba' };
  return { ok: true, pregunta: String(pregunta), respuesta };
}

// lo que puede seguir a «sesión» en una frase sin nombrar ninguna; cualquier otra palabra cuenta como un id, y ante la duda
// la aprobación no vale y se pide de nuevo
const NO_ES_ID = new Set(['que', 'y', 'o', 'en', 'con', 'para', 'por', 'sin', 'a', 'al', 'su', 'sus', 'esta', 'este', 'es', 'se',
  'anterior', 'actual', 'nueva', 'nuevo', 'misma', 'mismo', 'propia', 'destino', 'coordinadora', 'principal', 'otra', 'otro']);

/** Lo que un texto nombra como sesión, en minúsculas: la palabra que sigue a «sesión» o a «sesión de», con o sin puntuación. */
function sesionesNombradas(texto) {
  return [...String(texto).matchAll(/(?:^|[^\p{L}\p{N}_-])sesi[oó]n[\s:=«"'`([]+(?:(?:de|del|la|el)\s+)*([\p{L}\p{N}_-]+)/giu)].map((m) => m[1].toLowerCase()).filter((s) => !NO_ES_ID.has(s));
}

// los topes de la pregunta: un corte siempre se ve («…», «y N más»)
const LINEAS_QUE_HACE = 3;
const LARGO_DE_LINEA = 200;
const ARCHIVOS_A_LA_VISTA = 10;
const sinPunto = (s) => String(s).replace(/[.\s]+$/, '');
const masDe = (lista, tope, sep) => (lista.length > tope ? `${lista.slice(0, tope).join(sep)}${sep === ', ' ? ' ' : sep}y ${lista.length - tope} más` : lista.join(sep));

/**
 * El cuadro de una firma: lo arma el guion, y el agente lo muestra tal cual. La pregunta dice, en este orden, lo que se
 * aprueba (`que`, con su verbo: no lleva «¿Aprobás» delante), la historia con su título (`historia`: { id, titulo }), qué
 * hace (`queHace`, hasta 3 líneas), qué archivos toca, dónde está lo completo, qué pasa si sale mal, y al final la cita de
 * la sesión, que no reemplaza nada de lo anterior. `sello`: lo que ata la aprobación a esa firma, esa sesión y lo que se
 * mostró (`huella`); `texto`: la pregunta sin el sello, la que muestra la ventana de permiso. Con `soloClick`, sólo lo
 * aprueba un click en la sesión que trabaja, y el cuadro se muestra con sus `descripciones`.
 */
function cuadroDe({ firma, destino, que, historia = null, queHace = [], archivos = [], completo = null, siSaleMal, cita = null, huella, soloClick = false, descripciones = null }) {
  const sello = `firma ${firma} · sesión ${destino} · código ${huella}`;
  const lo = una(que, 200);
  const partes = [`¿${lo.charAt(0).toUpperCase()}${lo.slice(1)}?`];
  // la sesión sobre la que se firma, siempre: la coordinadora puede pedir la firma para otra
  const ses = una(destino, 80);
  if (historia && historia.id) partes.push(historia.titulo ? `Historia ${una(historia.id, 40)}, «${una(historia.titulo, 160)}», sesión ${ses}.` : `Historia ${una(historia.id, 40)} (sin título en su archivo), sesión ${ses}.`);
  else if (destino) partes.push(`Sesión ${ses}.`);
  const lineas = (queHace || []).map((l) => sinPunto(una(l, LARGO_DE_LINEA))).filter(Boolean);
  if (lineas.length) partes.push(`Qué hace: ${masDe(lineas, LINEAS_QUE_HACE, ' · ')}.`);
  const rutas = (archivos || []).map((a) => una(a, 200)).filter(Boolean);
  if (rutas.length) partes.push(`Archivos: ${masDe(rutas, ARCHIVOS_A_LA_VISTA, ', ')}.`);
  if (completo) partes.push(`Completo en: ${una(completo, 400)}.`);
  partes.push(`Si sale mal: ${sinPunto(una(siSaleMal, 200))}.`);
  if (cita) partes.push(`Cita de la sesión: «${una(cita, 200)}».`);
  const texto = partes.join(' ');
  return { sello, texto, pregunta: `${texto} (${sello})`, opciones: [APRUEBA, NIEGA], ...(soloClick ? { soloClick: true, descripciones } : {}) };
}

/**
 * ¿El mensaje del agente trae la pregunta que armó el guion (`pregunta`; sin ella, el sello) y no nombra otra sesión que la
 * destino? Para el «aprobado» escrito. El sello solo, pegado a otra pregunta, haría aprobar una cosa y firmar otra. Lo que
 * dice la pregunta no cuenta como sesión nombrada: su detalle copia el motivo del comando.
 */
function traeElSello(texto, { sello, destino, pregunta }) {
  const t = String(texto || '');
  const resto = pregunta ? t.split(pregunta).join(' ') : t;
  return !!sello && t.includes(pregunta || sello) && sesionesNombradas(resto).every((s) => s === String(destino).toLowerCase());
}

// --- quién lanzó el gancho ------------------------------------------------------------------------------------------

/**
 * ¿Al gancho lo lanzó la herramienta, sin la consola de un agente ni otra herramienta en el medio? `{ ok, herramienta }`
 * o `{ ok: false, motivo }`. Un agente que corre el gancho a mano lo lanza desde su consola; uno que abre otra sesión en
 * una pseudo-terminal tiene esa consola arriba de la herramienta nueva. Sin árbol, no anota. En Windows, entre el gancho
 * y la herramienta sólo puede haber Git Bash o el mismo Node (medido): lo demás podría ser una consola que no se lee.
 */
function lanzadoPorLaHerramienta({ arbol, pid = process.pid, casa, plataforma = process.platform } = {}) {
  const w = ow();
  const enWindows = plataforma === 'win32';
  const a = w.arbolDeLaPlataforma(arbol, plataforma);
  if (!a) return { ok: false, motivo: 'no pude leer los procesos de la máquina' };
  const m = new Map(a.map((p) => [p.pid, p]));
  const consola = (p) => (enWindows ? w.esConsolaDeWindows(p) : w.desenvolver(p.comando, casa) !== null);
  const permitidoEnWindows = (p) => !!w.gitBashDe(p.ejecutable) || /^node\.exe$/i.test(String(p.ejecutable || '').split(/[\\/]/).pop());
  let p = m.get(pid);
  const vistos = new Set();
  while (p && !vistos.has(p.pid)) {
    vistos.add(p.pid);
    if (p.pid !== pid && w.esHerramienta(p)) break;
    if (p.pid !== pid && consola(p)) return { ok: false, motivo: 'al gancho lo lanzó la consola de un agente' };
    if (p.pid !== pid && enWindows && !permitidoEnWindows(p)) return { ok: false, motivo: 'al gancho no lo lanzó la herramienta' };
    p = m.get(p.ppid);
  }
  if (!p || !w.esHerramienta(p)) return { ok: false, motivo: 'al gancho no lo lanzó la herramienta' };
  const tool = p;
  for (let q = m.get(tool.ppid); q && !vistos.has(q.pid); q = m.get(q.ppid)) {
    vistos.add(q.pid);
    if (consola(q) || (w.esHerramienta(q) && !w.esAnfitrionDeFondoDe(tool, q))) return { ok: false, motivo: 'la herramienta la lanzó otra herramienta o la consola de un agente' };
  }
  return { ok: true, herramienta: { pid: tool.pid, inicio: tool.inicio } };
}

// --- el registro ----------------------------------------------------------------------------------------------------

/** Anota una aprobación de `registro.sesion`. Tira si no puede escribir. */
function anotar(casa, registro) {
  if (!registro || !SESION.test(String(registro.sesion || ''))) throw new Error('la aprobación no dice de qué sesión es');
  const dir = carpeta(casa);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${registro.sesion}.jsonl`), `${JSON.stringify(registro)}\n`);
}

function leerSesion(casa, sesion) {
  let texto;
  try { texto = fs.readFileSync(path.join(carpeta(casa), `${sesion}.jsonl`), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`no pude leer las aprobaciones de la sesión ${sesion} (${e.code || e.message})`);
  }
  const fuera = [];
  for (const l of texto.split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); if (r && typeof r === 'object') fuera.push({ ...r, id: sha(l) }); } catch (_) { /* renglón a medias */ }
  }
  return fuera;
}

const usada = (casa, id) => fs.existsSync(path.join(carpeta(casa), 'usadas', id));

/** Marca la aprobación como usada; `{ ok }` o `{ ok: false, motivo }` si ya la usó otra firma. */
function consumir(casa, aprobacion, { ahora = Date.now(), firma, sesion } = {}) {
  const dir = path.join(carpeta(casa), 'usadas');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, aprobacion.id), `${JSON.stringify({ ts: new Date(ahora).toISOString(), firma, sesion })}\n`, { flag: 'wx' });
    return { ok: true };
  } catch (e) {
    return { ok: false, motivo: e.code === 'EEXIST' ? 'esa aprobación ya la usó otra firma' : `no pude marcar la aprobación como usada (${e.code || e.message})` };
  }
}

/** Devuelve una aprobación recién marcada como usada, porque su pedido no se pudo escribir. Si tampoco se puede, queda usada y se pide de nuevo. */
function devolver(casa, aprobacion) {
  try { fs.unlinkSync(path.join(carpeta(casa), 'usadas', aprobacion.id)); } catch (_) { /* falla cerrado: una aprobación de menos */ }
}

// --- lo de Claude Code: la transcripción y los ganchos que escuchan el cuadro ------------------------------------------

/** La transcripción de la sesión: `~/.claude/projects/<carpeta>/<sesión>.jsonl`, de la casa de la cuenta. */
function transcripcionDe(casa, sesion) {
  if (!SESION.test(String(sesion || ''))) return null;
  const raiz = path.join(casa, '.claude', 'projects');
  let dirs;
  try { dirs = fs.readdirSync(raiz, { withFileTypes: true }); } catch (_) { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const r = path.join(raiz, d.name, `${sesion}.jsonl`);
    if (fs.existsSync(r)) return r;
  }
  return null;
}

function renglones(ruta) {
  const fuera = [];
  for (const l of fs.readFileSync(ruta, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { fuera.push(JSON.parse(l)); } catch (_) { /* renglón a medias */ }
  }
  return fuera;
}

const bloques = (r) => (r && r.message && Array.isArray(r.message.content) ? r.message.content : []);
const textoDe = (r) => {
  const c = r && r.message && r.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some((b) => b && b.type === 'tool_result')) return null;
  return c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
};
const cerca = (r, ts) => { const t = Date.parse(r && r.timestamp); const u = Date.parse(ts); return Number.isFinite(t) && Number.isFinite(u) && Math.abs(t - u) <= MARGEN_MS; };

/**
 * El mensaje en la transcripción, tipeado por la persona a la hora del registro, después de un mensaje del agente que
 * trae el sello de la firma: `{ ok }` o `{ ok: false, motivo }`.
 */
function mensajeEnLaTranscripcion(ruta, a, { sello, destino, pregunta } = {}) {
  let rs;
  try { rs = renglones(ruta); } catch (e) { return { ok: false, motivo: `no pude leer la transcripción (${e.code || e.message})` }; }
  const t = String(a.texto || '').trim();
  // el renglón más cercano a la hora del registro: dos «aprobado» seguidos no se validan contra el mismo
  let i = -1;
  let distancia = Infinity;
  rs.forEach((x, k) => {
    if (!x || x.type !== 'user' || String(textoDe(x) || '').trim() !== t || !cerca(x, a.ts)) return;
    const d = Math.abs(Date.parse(x.timestamp) - Date.parse(a.ts));
    if (d < distancia) { distancia = d; i = k; }
  });
  if (i < 0) return { ok: false, motivo: 'el mensaje no está en la transcripción de la sesión a esa hora' };
  const r = rs[i];
  if (r.isMeta === true || !r.origin || r.origin.kind !== 'human') return { ok: false, motivo: 'el mensaje no lo escribió una persona (lo mandó otra sesión o un programa)' };
  if (!(TIPEADO[r.entrypoint] || []).includes(r.promptSource)) return { ok: false, motivo: `el mensaje no lo tipeó una persona: llegó por ${una(r.entrypoint, 40)} · ${una(r.promptSource, 40)}` };
  // lo que el agente dijo después del mensaje anterior de la persona: una pregunta se contesta una sola vez
  let antes = null;
  for (let k = i - 1; k >= 0 && antes === null; k--) {
    if (rs[k] && rs[k].type === 'user' && rs[k].origin && rs[k].origin.kind === 'human' && textoDe(rs[k]) !== null) break;
    if (rs[k] && rs[k].type === 'assistant' && textoDe(rs[k])) antes = textoDe(rs[k]);
  }
  if (!traeElSello(antes, { sello, destino, pregunta })) return { ok: false, motivo: `lo último que dijo el agente antes del «aprobado» no trae «${sello}», o nombra otra sesión` };
  return { ok: true };
}

function pistaDeVersion(renglon) {
  // el click ya se negó: esto sólo agrega qué actualizar, y si no se puede cargar la negativa queda igual
  try { return require('./claude-versions.js').clickHint(renglon); } catch (_) { return ''; }
}

/**
 * El cuadro en la transcripción: la pregunta es la que armó el guion, la respuesta es la del registro, a esa hora, y no la
 * dio un gancho. `{ ok }` o `{ ok: false, motivo }`.
 */
function clickEnLaTranscripcion(ruta, a, { pregunta, opciones, descripciones } = {}) {
  let rs;
  try { rs = renglones(ruta); } catch (e) { return { ok: false, motivo: `no pude leer la transcripción (${e.code || e.message})` }; }
  if (!a.tool_use_id) return { ok: false, motivo: 'el click no dice qué cuadro contestó' };
  const llamado = rs.some((r) => r && r.type === 'assistant' && bloques(r).some((b) => b && b.type === 'tool_use' && b.id === a.tool_use_id && b.name === CUADRO));
  if (!llamado) return { ok: false, motivo: 'el cuadro no está en la transcripción de la sesión' };
  const r = rs.find((x) => bloques(x).some((b) => b && b.type === 'tool_result' && b.tool_use_id === a.tool_use_id));
  if (!r) return { ok: false, motivo: 'la respuesta del cuadro no está en la transcripción' };
  if (!cerca(r, a.ts)) return { ok: false, motivo: 'la respuesta del cuadro no es de la hora del registro' };
  const d = r.permissionDecision || (r.toolUseResult && r.toolUseResult.permissionDecision);
  // sin ese dato no se sabe si lo contestó un gancho, y uno ajeno se puede sacar antes de que se mire la configuración
  if (!d) return { ok: false, motivo: `la transcripción no dice quién contestó el cuadro${pistaDeVersion(r)}` };
  if (d.source === 'hook' || d.reasonType === 'hook') return { ok: false, motivo: 'el cuadro lo contestó un gancho, no la persona' };
  if (d.decision && d.decision !== 'accept') return { ok: false, motivo: 'el cuadro no se aceptó' };
  const dijo = respuestaDelCuadro(r.toolUseResult);
  if (!dijo.ok) return { ok: false, motivo: `en la transcripción, ${dijo.motivo}` };
  if (dijo.pregunta !== a.pregunta || dijo.respuesta !== a.respuesta) return { ok: false, motivo: 'la respuesta del cuadro en la transcripción no es la del registro' };
  if (!pregunta || dijo.pregunta !== pregunta) return { ok: false, motivo: 'la pregunta del cuadro no es la que armó el guion para esta firma: mostrala tal cual' };
  // con dos opciones que aprueban, la persona no tendría cómo decir que no
  const mostrada = ((r.toolUseResult && r.toolUseResult.questions) || []).find((q) => q && q.question === pregunta);
  const etiquetas = mostrada && Array.isArray(mostrada.options) ? mostrada.options.map((o) => o && o.label) : null;
  if (!opciones || JSON.stringify(etiquetas) !== JSON.stringify(opciones)) return { ok: false, motivo: 'las opciones del cuadro no son las que armó el guion: mostralas tal cual' };
  if (descripciones && JSON.stringify(mostrada.options.map((o) => o && o.description)) !== JSON.stringify(descripciones)) return { ok: false, motivo: 'las descripciones del cuadro no son las que armó el guion: mostralas tal cual' };
  return { ok: true };
}

/** La carpeta de la configuración administrada de Claude Code. */
function carpetaAdministrada(plataforma = process.platform) {
  if (plataforma === 'darwin') return '/Library/Application Support/ClaudeCode';
  return plataforma === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code';
}

/**
 * Las capas de configuración de Claude Code que pueden traer ganchos, para la carpeta `cwd`: las de la cuenta y del
 * proyecto, la administrada y su carpeta `managed-settings.d/` (sus `.json`; las copias con otro final no se cargan).
 */
function capas({ casa = os.homedir(), cwd, plataforma = process.platform, administrada = carpetaAdministrada(plataforma) } = {}) {
  const fuera = [path.join(casa, '.claude', 'settings.json'), path.join(casa, '.claude', 'settings.local.json')];
  if (cwd) fuera.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  fuera.push(path.join(administrada, 'managed-settings.json'));
  const d = path.join(administrada, 'managed-settings.d');
  try { for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) fuera.push(path.join(d, f)); } catch (e) { if (e.code !== 'ENOENT') fuera.push(d); }
  return fuera;
}

/** Las carpetas que hay adentro de una raíz, siguiendo los enlaces (una skill instalada suele ser un enlace). */
function subcarpetas(d, nombres = null) {
  let es;
  try { es = fs.readdirSync(d); } catch (e) { return e.code === 'ENOENT' ? [] : [{ ilegible: d }]; }
  return es.filter((n) => !nombres || nombres.includes(n)).map((n) => path.join(d, n)).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } });
}

/**
 * Los archivos de ganchos de los plugins de `raices` (por defecto, los instalados en `~/.claude/plugins/cache`; todos,
 * porque uno sin habilitar puede habilitarse sin pasar por acá): su `hooks/hooks.json` y lo que nombre su `plugin.json`,
 * sea otro archivo o los ganchos mismos (`{ objeto, archivo }`). Los catálogos de `marketplaces/` no corren: no cuentan.
 */
function hooksDePlugins(casa = os.homedir(), raices = [path.join(carpetaClaude(casa), 'plugins', 'cache')]) {
  const fuera = [];
  const delManifiesto = (p) => {
    let j;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { fuera.push({ ilegible: p }); return; }
    // el manifiesto puede vivir en la carpeta `[.]claude-plugin/` del plugin (un nombre de Claude Code, no la carpeta de la cuenta)
    const raiz = /^[.]claude-plugin$/.test(path.basename(path.dirname(p))) ? path.dirname(path.dirname(p)) : path.dirname(p);
    for (const h of [].concat(j && j.hooks !== undefined ? j.hooks : [])) {
      if (typeof h === 'string') fuera.push(path.resolve(raiz, h));
      else if (h && typeof h === 'object') fuera.push({ objeto: h, archivo: p });
      else fuera.push({ ilegible: p });
    }
  };
  const recorrer = (d, n) => {
    if (n > 7) return;
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') fuera.push({ ilegible: d }); return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') recorrer(p, n + 1);
      else if (e.isFile() && e.name === 'hooks.json' && path.basename(d) === 'hooks') fuera.push(p);
      else if (e.isFile() && e.name === 'plugin.json') delManifiesto(p);
    }
  };
  for (const r of raices) recorrer(r, 0);
  return fuera;
}

/** El encabezado YAML de un `.md`, o null. Lee sólo el principio: un encabezado no ocupa más. */
function encabezadoDe(ruta) {
  const fd = fs.openSync(ruta, 'r');
  try {
    const b = Buffer.alloc(16384);
    const t = b.toString('utf8', 0, fs.readSync(fd, b, 0, b.length, 0));
    const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(t);
    return m ? m[1] : t.startsWith('---') ? t : null;
  } finally { fs.closeSync(fd); }
}

/**
 * Los ganchos sobre el cuadro de un encabezado de skill o de agente (`hooks:`), como `{ evento, comando }`. Lee los
 * renglones sin intérprete de YAML: un evento sin `matcher`, o con uno que alcanza al cuadro, cuenta entero; ante la duda,
 * cuenta.
 */
function ganchosDelEncabezado(texto) {
  const fuera = [];
  const rs = String(texto || '').split(/\r?\n/);
  const inicio = rs.findIndex((l) => /^hooks\s*:/.test(l));
  if (inicio < 0) return fuera;
  // un comentario pegado al margen no cierra el bloque
  const fin = rs.findIndex((l, i) => i > inicio && /^[^\s#]/.test(l));
  const bloque = rs.slice(inicio, fin < 0 ? rs.length : fin);
  let evento = null;
  let tramo = [];
  const cerrar = () => {
    if (!['PreToolUse', 'PermissionRequest'].includes(evento)) return;
    const matchers = tramo.map((l) => /\bmatcher\s*:\s*["']?([^"'#]*?)["']?\s*$/.exec(l)).filter(Boolean).map((m) => m[1]);
    if (matchers.length && !matchers.some(alcanzaAlCuadro)) return;
    const comandos = tramo.map((l) => /\bcommand\s*:\s*(.+?)\s*$/.exec(l)).filter(Boolean).map((m) => m[1].replace(/^["']|["']$/g, ''));
    for (const comando of comandos.length ? comandos : ['(sin comando a la vista)']) if (!esPermitido(comando)) fuera.push({ evento, comando });
  };
  for (const l of bloque.slice(1)) {
    const m = /^\s*["']?([A-Za-z]+)["']?\s*:\s*(?:\[\s*)?$/.exec(l);
    if (m && /^[A-Z]/.test(m[1])) { cerrar(); evento = m[1]; tramo = []; continue; }
    // el evento y sus ganchos en una sola línea: no se lee el matcher, y ante la duda cuenta
    const enLinea = /^\s*["']?(PreToolUse|PermissionRequest)["']?\s*:\s*\S/.exec(l);
    if (enLinea) fuera.push({ evento: enLinea[1], comando: una(l.trim(), 160) });
    tramo.push(l);
  }
  cerrar();
  // una forma en una sola línea (`hooks: { PreToolUse: … }`), o un evento que no se pudo leer, cuenta
  if (/\b(?:PreToolUse|PermissionRequest)\b/.test(rs[inicio])) fuera.push({ evento: 'PreToolUse', comando: una(rs[inicio], 160) });
  return fuera;
}

/**
 * Los `.md` con encabezado que pueden traer ganchos: skills y agentes (también comandos) de la cuenta, del proyecto y de
 * los plugins instalados. Las carpetas `skills/` y `agents/` de un plugin se buscan en todos los niveles que recorre
 * `hooksDePlugins`.
 */
function encabezadosPosibles({ casa = os.homedir(), cwd, pluginDirs = [] } = {}) {
  const fuera = [];
  const deRaiz = (raiz) => {
    for (const d of subcarpetas(path.join(raiz, 'skills'))) { if (typeof d === 'object') fuera.push(d); else fuera.push(path.join(d, 'SKILL.md')); }
    for (const nombre of ['agents', 'commands']) {
      let es;
      try { es = fs.readdirSync(path.join(raiz, nombre)); } catch (e) { if (e.code !== 'ENOENT') fuera.push({ ilegible: path.join(raiz, nombre) }); continue; }
      for (const f of es) if (f.endsWith('.md')) fuera.push(path.join(raiz, nombre, f));
    }
  };
  // la carpeta de la cuenta y la del proyecto, que se llama igual
  deRaiz(carpetaClaude(casa));
  if (cwd) deRaiz(path.join(cwd, path.basename(carpetaClaude(casa))));
  const recorrer = (d, n) => {
    if (n > 7) return;
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') fuera.push({ ilegible: d }); return; }
    if (es.some((e) => e.isDirectory() && ['skills', 'agents', 'commands'].includes(e.name))) deRaiz(d);
    for (const e of es) if (e.isDirectory() && !['node_modules', '.git', 'skills', 'agents', 'commands'].includes(e.name)) recorrer(path.join(d, e.name), n + 1);
  };
  for (const r of [path.join(carpetaClaude(casa), 'plugins', 'cache'), ...pluginDirs]) recorrer(r, 0);
  return fuera;
}

/**
 * Lo que la línea del proceso de la herramienta suma a sus capas: `--settings <archivo>` y `--plugin-dir <carpeta>`. Con
 * la línea partida por espacios: un valor que no se puede leer (una ruta con espacios, JSON en línea) queda como archivo y
 * no se puede abrir, y entonces el click no vale.
 */
function banderasDe(linea) {
  const w = String(linea || '').trim().split(/\s+/);
  const settings = [];
  const pluginDirs = [];
  w.forEach((x, i) => {
    const m = /^--(settings|plugin-dir)(?:=(.*))?$/.exec(x);
    if (!m) return;
    const v = m[2] !== undefined ? m[2] : w[i + 1];
    (m[1] === 'settings' ? settings : pluginDirs).push(v || '');
  });
  return { settings, pluginDirs };
}

/** ¿El matcher de un gancho alcanza al cuadro? Vacío o `*` alcanza a todo; una expresión, si la acepta. */
function alcanzaAlCuadro(matcher) {
  const m = matcher == null ? '' : String(matcher).trim();
  if (m === '' || m === '*') return true;
  try { return new RegExp(`^(?:${m})$`).test(CUADRO); } catch (_) { return m.includes(CUADRO); }
}

/**
 * ¿El comando es un gancho del arnés que puede escuchar el cuadro? Por su ruta dentro de este arnés o la instalada, y
 * nada más en la línea (ni `;`, `&`, `|`, ni sustituciones).
 */
function esPermitido(comando, raiz = ROOT) {
  const c = String(comando || '').trim();
  if (!c || /[;&|`\n]|\$\(/.test(c)) return false;
  return PERMITIDOS.some((n) => {
    const ruta = path.join(raiz, 'scripts', 'hooks', n);
    // en Windows la configuración escribe la ruta con barras normales
    return c.includes(ruta) || c.includes(ruta.replace(/\\/g, '/')) || c === `@tcg:${n}` || new RegExp(`(^|[\\s"'])[^\\s"']*/\\.tycon/harness/scripts/hooks/${n.replace('.', '\\.')}(["']?)$`).test(c);
  });
}

/**
 * Los ganchos ajenos que escuchan el cuadro: `{ ajenos: [{ archivo, evento, comando }], ilegibles: [archivo] }`. Mira
 * PreToolUse y PermissionRequest en las capas de configuración, en lo que suman las banderas del proceso (`linea`, la de
 * la herramienta), en los plugins instalados y en el encabezado de skills y agentes.
 */
function escuchasDelCuadro({ casa = os.homedir(), cwd, plataforma, administrada, linea } = {}) {
  const ajenos = [];
  const ilegibles = [];
  const { settings, pluginDirs } = banderasDe(linea);
  const archivos = [...capas({ casa, cwd, plataforma, ...(administrada ? { administrada } : {}) }).map((a) => ({ a, plugin: false })),
    ...hooksDePlugins(casa, [path.join(carpetaClaude(casa), 'plugins', 'cache'), ...pluginDirs]).map((a) => ({ a, plugin: true }))];
  const delObjeto = (hooks, a) => {
    for (const evento of ['PreToolUse', 'PermissionRequest']) {
      for (const g of Array.isArray(hooks[evento]) ? hooks[evento] : []) {
        if (!g || !alcanzaAlCuadro(g.matcher)) continue;
        for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
          const comando = h && (h.command || h.url || h.prompt || h.type);
          if (!esPermitido(h && h.command)) ajenos.push({ archivo: a, evento, comando: una(comando, 160) });
        }
      }
    }
  };
  for (const { a, plugin } of archivos) {
    if (a && typeof a === 'object' && a.ilegible) { ilegibles.push(a.ilegible); continue; }
    if (a && typeof a === 'object') { delObjeto(a.objeto.hooks || a.objeto, a.archivo); continue; }
    let j;
    try { j = JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') ilegibles.push(a); continue; }
    delObjeto((j && (plugin && !j.hooks ? j : j.hooks)) || {}, a);
  }
  // pedida en la línea del proceso: si no se puede leer, no se sabe qué trae
  for (const a of settings) {
    let j;
    try { j = JSON.parse(fs.readFileSync(a, 'utf8')); } catch (_) { ilegibles.push(a || '--settings'); continue; }
    delObjeto((j && j.hooks) || {}, a);
  }
  for (const a of encabezadosPosibles({ casa, cwd, pluginDirs })) {
    if (typeof a === 'object') { ilegibles.push(a.ilegible); continue; }
    let t;
    try { t = encabezadoDe(a); } catch (e) { if (e.code !== 'ENOENT') ilegibles.push(a); continue; }
    for (const g of ganchosDelEncabezado(t)) ajenos.push({ archivo: a, evento: g.evento, comando: una(g.comando, 160) });
  }
  return { ajenos, ilegibles };
}

// --- quién anotó una aprobación dada en otra sesión -----------------------------------------------------------------

/**
 * La aprobación dada en otra sesión (la coordinadora) la anotó el proceso de esa sesión, que sigue vivo: el proceso que
 * dice el registro está en el árbol, con su misma hora de inicio, es la herramienta, y Claude Code lo tiene como esa sesión
 * (`sessions/<pid>.json` en la carpeta de Claude Code de la cuenta). `{ ok, linea, cwd }` o `{ ok: false, motivo }`.
 */
function procesoQueLaAnoto({ a, arbol, casa }) {
  const w = ow();
  const h = a.herramienta;
  if (!h || !Number.isInteger(h.pid)) return { ok: false, motivo: 'el registro no dice qué proceso la anotó' };
  if (!arbol) return { ok: false, motivo: 'no pude leer los procesos de la máquina' };
  const p = arbol.find((x) => x.pid === h.pid);
  if (!p || p.inicio !== h.inicio || !w.esHerramienta(p)) return { ok: false, motivo: `el proceso de la sesión ${a.sesion} que la anotó ya no está` };
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(carpetaClaude(casa), 'sessions', `${h.pid}.json`), 'utf8')); } catch (e) {
    return { ok: false, motivo: e.code === 'ENOENT' ? `no sé de qué sesión es el proceso ${h.pid}` : `no pude leer de qué sesión es el proceso ${h.pid} (${e.code || e.message})` };
  }
  if (!s || s.sessionId !== a.sesion) return { ok: false, motivo: `el proceso ${h.pid} no es de la sesión ${a.sesion}` };
  // otra copia viva de la sesión (abierta con `--resume` por un agente, desprendida de su consola) también se anota como ella
  const otros = arbol.filter((x) => x.pid !== h.pid && w.esHerramienta(x)).filter((x) => {
    try { return JSON.parse(fs.readFileSync(path.join(carpetaClaude(casa), 'sessions', `${x.pid}.json`), 'utf8')).sessionId === a.sesion; } catch (e) { return e.code !== 'ENOENT'; }
  });
  if (otros.length) return { ok: false, motivo: `hay más de un proceso vivo de la sesión ${a.sesion}: no sé cuál anotó la aprobación` };
  return { ok: true, linea: p.comando, cwd: s.cwd ? String(s.cwd) : null };
}

// --- la coordinadora ------------------------------------------------------------------------------------------------

/**
 * La sesión coordinadora designada y confirmada por el dueño (la misma que lee la delegación, delegated-signing.js), o
 * null. Sin confirmar, un «aprobado» escrito en su pestaña no vale para otras sesiones; sin `approvals.relay_session` en
 * el perfil del equipo, tampoco: la coordinadora ordena y no firma. `env` y `arnes`, para las pruebas.
 */
function coordinadoraConfirmada(casa, { env, arnes } = {}) {
  try {
    const ds = require('./delegated-signing.js');
    if (!ds.firmaPorElDueno({ env, home: casa, arnes }).ok) return null;
    const p = ds.accountPaths(casa);
    const d = require(path.join(LIB, 'critical-waivers.js')).designacionVigente({ dir: p.state });
    if (!d || d.error || !SESION.test(String(d.sesion || ''))) return null;
    const raw = fs.readFileSync(path.join(p.state, 'gates.log'), 'utf8');
    for (const l of raw.split('\n')) {
      if (!l.includes('relay-designation-confirmed')) continue;
      let g;
      try { g = JSON.parse(l); } catch (_) { continue; }
      if (ds.confirmaLaDesignacion(g, d)) return d.sesion;
    }
    return null;
  } catch (_) { return null; }
}

// --- buscar la aprobación para una firma ----------------------------------------------------------------------------

/**
 * La aprobación vigente para la firma `firma` pedida desde `sesion` sobre `destino` (por defecto, la misma): sin usar, de
 * los últimos 30 minutos, dada en `sesion` o en la coordinadora (`coordinadora`: su id, o null), contestando el cuadro
 * que armó el guion para ese comando (`cuadro`: `{ pregunta, sello }`, de `cuadroDe`). La de la propia sesión tiene que
 * venir del mismo proceso de la herramienta que firma (`herramienta`: { pid, inicio }); la de la coordinadora, de su
 * proceso vivo (`arbol`, se lee si falta). `validar(aprobacion, contexto)` la confirma contra la transcripción y los
 * ganchos; se pasa en las pruebas. `cwd` y `casa` son los de la firma, nunca los del registro. `{ ok, aprobacion, via }` o
 * `{ ok: false, motivo }`.
 */
function buscar({ casa, sesion, destino = sesion, cuadro, coordinadora = null, ahora = Date.now(), cwd, herramienta = null, validar, arbol } = {}) {
  if (!SESION.test(String(sesion || ''))) return { ok: false, motivo: 'la firma no dice de qué sesión es' };
  if (!cuadro || !cuadro.pregunta || !cuadro.sello) return { ok: false, motivo: 'no pude armar el cuadro de esta firma' };
  // un cuadro de sólo click vale en la pestaña que hace el trabajo: ni la coordinadora ni un mensaje escrito lo contestan
  const soloClick = !!cuadro.soloClick;
  const sesiones = [sesion, ...(!soloClick && coordinadora && coordinadora !== sesion && SESION.test(coordinadora) ? [coordinadora] : [])];
  let candidatas = [];
  try { for (const s of sesiones) candidatas.push(...leerSesion(casa, s).filter((r) => r.sesion === s)); } catch (e) { return { ok: false, motivo: e.message }; }
  candidatas = candidatas.filter((r) => {
    const edad = ahora - Date.parse(r.ts);
    if (!(edad >= 0 && edad <= VENCE_MIN * 60000 && (r.tipo === 'click' || (r.tipo === 'mensaje' && !soloClick)) && !usada(casa, r.id))) return false;
    // la de la propia sesión la anotó el mismo proceso de la herramienta que firma: otra copia de la sesión (abierta con
    // `--resume` por un agente) no aprueba por ella
    return !herramienta || r.sesion !== sesion || (r.herramienta && r.herramienta.pid === herramienta.pid && r.herramienta.inicio === herramienta.inicio);
  }).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  if (!candidatas.length) return { ok: false, motivo: soloClick ? 'no hay un click en el cuadro de esta pestaña de los últimos 30 minutos sin usar' : 'no hay un click en el cuadro ni un «aprobado» tuyo de los últimos 30 minutos sin usar' };
  // un «Sí» a esta misma firma y sesión con otro código: la fuente (el plan, el diff, el hallazgo) cambió después del cuadro
  const mismaFirma = cuadro.sello.slice(0, cuadro.sello.lastIndexOf('código '));
  const cambio = candidatas.some((a) => a.tipo === 'click' && a.respuesta === APRUEBA && typeof a.pregunta === 'string'
    && a.pregunta.includes(`(${mismaFirma}código `) && !a.pregunta.includes(`(${cuadro.sello})`));
  if (cambio && !candidatas.some((a) => a.pregunta === cuadro.pregunta)) return { ok: false, motivo: 'lo que se mostró cambió: pedí el cuadro de nuevo' };
  const check = validar || ((a, ctx) => validarEnClaude(a, ctx));
  let leido = arbol;
  let motivo = null;
  for (const a of candidatas) {
    let proceso = null;
    if (a.sesion !== sesion) {
      if (leido === undefined) leido = ow().arbolDeLaPlataforma();
      proceso = procesoQueLaAnoto({ a, arbol: leido, casa });
      if (!proceso.ok) { motivo = motivo || proceso.motivo; continue; }
    } else if (herramienta) {
      if (leido === undefined) leido = ow().arbolDeLaPlataforma();
      const p = (leido || []).find((x) => x.pid === herramienta.pid);
      // sin la línea del proceso no se miran los ganchos que suman sus banderas: la aprobación no se puede confirmar
      if (!p) { motivo = motivo || 'no encontré el proceso de la herramienta entre los procesos de la máquina'; continue; }
      proceso = { linea: p.comando };
    }
    const v = check(a, { casa, cwd, cuadro, destino, linea: proceso && proceso.linea, cwdAprobacion: proceso && proceso.cwd });
    if (v && v.ok) return { ok: true, aprobacion: a, via: a.tipo };
    motivo = motivo || (v && v.motivo);
  }
  return { ok: false, motivo: `la aprobación no vale: ${motivo || 'no se pudo confirmar'}` };
}

/**
 * La confirmación con lo que deja Claude Code: la transcripción de la sesión donde se aprobó y, para el click, los
 * ganchos que escuchan el cuadro, en la carpeta de la firma y en la de la pestaña donde se contestó (`cwdAprobacion`).
 * `linea`: la del proceso de la herramienta que lo mostró. El «aprobado» sólo tiene que traer el sello: el texto lo
 * escribió el agente, y lo que lo ata a esta firma es el sello.
 */
function validarEnClaude(a, { casa = os.homedir(), cwd, cuadro, destino, linea, cwdAprobacion } = {}) {
  const ruta = transcripcionDe(casa, a.sesion);
  if (!ruta) return { ok: false, motivo: `no encontré la transcripción de la sesión ${a.sesion}` };
  if (a.tipo === 'mensaje') return mensajeEnLaTranscripcion(ruta, a, { sello: cuadro.sello, destino, pregunta: cuadro.pregunta });
  for (const c of [...new Set([cwd, cwdAprobacion].filter(Boolean))]) {
    const e = escuchasDelCuadro({ casa, cwd: c, linea });
    if (e.ilegibles.length) return { ok: false, motivo: `no pude leer ${e.ilegibles[0]}, y sin leerla no sé si un gancho contestó el cuadro` };
    if (e.ajenos.length) return { ok: false, motivo: `un gancho que no es del arnés escucha el cuadro (${e.ajenos[0].evento} en ${e.ajenos[0].archivo}): mientras esté, el click no vale; ${cuadro && cuadro.soloClick ? 'queda la terminal' : 'escribí «aprobado»'}` };
  }
  return clickEnLaTranscripcion(ruta, a, { pregunta: cuadro.pregunta, opciones: cuadro.opciones, descripciones: cuadro.descripciones });
}

module.exports = { VENCE_MIN, ENVUELTO, PERMITIDOS, APRUEBA, NIEGA, carpeta, esAprobacion, mensajeDeLaPersona, respuestaDelCuadro, cuadroDe, traeElSello, lanzadoPorLaHerramienta,
  anotar, leerSesion, consumir, devolver, transcripcionDe, mensajeEnLaTranscripcion, clickEnLaTranscripcion, capas, hooksDePlugins, ganchosDelEncabezado, banderasDe, alcanzaAlCuadro, esPermitido,
  escuchasDelCuadro, procesoQueLaAnoto, coordinadoraConfirmada, buscar, validarEnClaude };
