'use strict';
/**
 * owner-approvals.js — la aprobación explícita de la persona, sin terminal: un click en el cuadro de opciones o un
 * mensaje suyo que sea un «aprobado» («aprobado», «apruebo», «sí, aprobado»). La anota un gancho
 * (scripts/hooks/owner-approval-record.js); la consume una firma (owner-window.js `decidir`) donde la ventana de permiso
 * no llega (una pestaña sin permisos, una sesión de fondo), en lugar de mandar a la terminal.
 *
 * Cada aprobación sirve para UNA firma: la que nombra. La pregunta del cuadro, o el último mensaje del agente antes del
 * «aprobado», tiene que decir «firma <id>» (y, si la firma es para otra sesión que la de la pestaña donde se aprueba,
 * «sesión <id>» de esa sesión). Vence a los 30 minutos. Vale en la sesión donde se dio o en la coordinadora designada y
 * confirmada. Gana a la delegación: lo que la coordinadora no puede firmar por su cuenta (un plan delicado, un guardado
 * que toca algo sensible) pasa con la aprobación de la persona. Lo irreversible (owner-window.js `TERMINAL_SIEMPRE`) no
 * la acepta.
 *
 * Por qué el agente no la puede fingir:
 * - El modelo no puede llenar la respuesta del cuadro: la herramienta la descarta antes de mostrarlo.
 * - El gancho anota sólo si lo lanzó la herramienta, sin otra herramienta ni la consola de un agente en el medio: un
 *   agente que lo corre a mano, o que abre otra sesión en una pseudo-terminal y le escribe «aprobado», no anota nada.
 * - Al consumir se relee la transcripción de la sesión (la ruta sale del id de la sesión, no del registro): tiene que
 *   estar el mensaje tipeado por la persona (`origin.kind: human`, `promptSource: typed`, `entrypoint: cli`) a la hora
 *   del registro, o el cuadro con esa pregunta, contestado con esa opción a esa hora y no por un gancho
 *   (`permissionDecision.source: hook`).
 * - Para el click se revisan además las capas de configuración y los plugins instalados: un gancho que no es del arnés
 *   sobre el cuadro (PreToolUse o PermissionRequest), o una capa que no se puede leer, y el click no vale.
 * Lo que no cubre: un agente que rompa un freno a propósito (escribir a mano el registro y la transcripción).
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
const VENCE_MIN = 30;
// la distancia entre la hora del registro y la del renglón de la transcripción
const MARGEN_MS = 2 * 60 * 1000;
const SESION = /^[\w-]+$/;
const CUADRO = 'AskUserQuestion';
// lo que llega como prompt sin que lo haya escrito la persona: mensajes de otra sesión, de un canal, avisos de tareas
const ENVUELTO = /<(?:cross-session-message|channel|task-notification|teammate-message|system-reminder|local-command|command-name)\b/i;
// los ganchos del arnés que pueden escuchar el cuadro: el aviso de espera y el que anota el click
const PERMITIDOS = ['wait-notice.js', 'owner-approval-record.js'];
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

// la frase suelta y sin distinguir mayúsculas: «Firma save» nombra `save`; «firma save-all» y «refirma save», no
const dice = (texto, frase) => new RegExp(`(^|[^\\p{L}\\p{N}_-])${frase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'iu').test(texto);

// lo que puede seguir a «sesión» en una frase sin nombrar ninguna; cualquier otra palabra cuenta como un id, y ante la duda
// la aprobación no vale y se pide de nuevo
const NO_ES_ID = new Set(['que', 'y', 'o', 'en', 'con', 'para', 'por', 'sin', 'a', 'al', 'su', 'sus', 'esta', 'este', 'es', 'se',
  'anterior', 'actual', 'nueva', 'nuevo', 'misma', 'mismo', 'propia', 'destino', 'coordinadora', 'principal', 'otra', 'otro']);

/** Lo que un texto nombra como sesión, en minúsculas: la palabra que sigue a «sesión» o a «sesión de», con o sin puntuación. */
function sesionesNombradas(texto) {
  return [...String(texto).matchAll(/(?:^|[^\p{L}\p{N}_-])sesi[oó]n[\s:=«"'`([]+(?:(?:de|del|la|el)\s+)*([\p{L}\p{N}_-]+)/giu)].map((m) => m[1].toLowerCase()).filter((s) => !NO_ES_ID.has(s));
}

/**
 * ¿El texto (la pregunta del cuadro, o lo último que dijo el agente) nombra la firma y, si hace falta, la sesión? Un
 * texto que nombra otra sesión que `destino` no aprueba ésta, aunque sea la de la misma pestaña.
 */
function nombraLaFirma(texto, firma, sesion, destino = sesion) {
  const t = String(texto || '');
  if (!firma || !dice(t, `firma ${firma}`)) return false;
  const nombradas = sesionesNombradas(t);
  if (destino && nombradas.some((s) => s !== String(destino).toLowerCase())) return false;
  return !sesion || nombradas.includes(String(sesion).toLowerCase());
}

// --- quién lanzó el gancho ------------------------------------------------------------------------------------------

/**
 * ¿Al gancho lo lanzó la herramienta, sin la consola de un agente ni otra herramienta en el medio? `{ ok, herramienta }`
 * o `{ ok: false, motivo }`. Un agente que corre el gancho a mano lo lanza desde su consola; uno que abre otra sesión en
 * una pseudo-terminal tiene esa consola arriba de la herramienta nueva. Sin árbol (Windows), no anota.
 */
function lanzadoPorLaHerramienta({ arbol, pid = process.pid, casa } = {}) {
  const w = ow();
  const a = arbol === undefined ? w.leerArbol() : arbol;
  if (!a) return { ok: false, motivo: 'no pude leer los procesos de la máquina' };
  const m = new Map(a.map((p) => [p.pid, p]));
  const consola = (p) => w.desenvolver(p.comando, casa) !== null;
  let p = m.get(pid);
  const vistos = new Set();
  while (p && !vistos.has(p.pid)) {
    vistos.add(p.pid);
    if (p.pid !== pid && w.esHerramienta(p)) break;
    if (p.pid !== pid && consola(p)) return { ok: false, motivo: 'al gancho lo lanzó la consola de un agente' };
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
 * nombra la firma: `{ ok }` o `{ ok: false, motivo }`.
 */
function mensajeEnLaTranscripcion(ruta, a, { firma, sesion } = {}) {
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
  if (r.promptSource !== 'typed') return { ok: false, motivo: 'el mensaje no se tipeó' };
  if (r.entrypoint !== 'cli') return { ok: false, motivo: 'el mensaje llegó por un programa, no por la persona' };
  // lo que el agente dijo después del mensaje anterior de la persona: una pregunta se contesta una sola vez
  let antes = null;
  for (let k = i - 1; k >= 0 && antes === null; k--) {
    if (rs[k] && rs[k].type === 'user' && rs[k].origin && rs[k].origin.kind === 'human' && textoDe(rs[k]) !== null) break;
    if (rs[k] && rs[k].type === 'assistant' && textoDe(rs[k])) antes = textoDe(rs[k]);
  }
  if (!nombraLaFirma(antes, firma, sesion, sesion || a.sesion)) return { ok: false, motivo: `lo último que dijo el agente antes del «aprobado» no nombra «firma ${firma}»${sesion ? ` ni «sesión ${sesion}»` : ''}, o nombra otra sesión` };
  return { ok: true };
}

/**
 * El cuadro en la transcripción: la pregunta nombra la firma, la respuesta es la del registro, a esa hora, y no la dio
 * un gancho. `{ ok }` o `{ ok: false, motivo }`.
 */
function clickEnLaTranscripcion(ruta, a, { firma, sesion } = {}) {
  let rs;
  try { rs = renglones(ruta); } catch (e) { return { ok: false, motivo: `no pude leer la transcripción (${e.code || e.message})` }; }
  if (!a.tool_use_id) return { ok: false, motivo: 'el click no dice qué cuadro contestó' };
  const llamado = rs.some((r) => r && r.type === 'assistant' && bloques(r).some((b) => b && b.type === 'tool_use' && b.id === a.tool_use_id && b.name === CUADRO));
  if (!llamado) return { ok: false, motivo: 'el cuadro no está en la transcripción de la sesión' };
  const r = rs.find((x) => bloques(x).some((b) => b && b.type === 'tool_result' && b.tool_use_id === a.tool_use_id));
  if (!r) return { ok: false, motivo: 'la respuesta del cuadro no está en la transcripción' };
  if (!cerca(r, a.ts)) return { ok: false, motivo: 'la respuesta del cuadro no es de la hora del registro' };
  const d = r.permissionDecision || (r.toolUseResult && r.toolUseResult.permissionDecision);
  if (d && (d.source === 'hook' || d.reasonType === 'hook')) return { ok: false, motivo: 'el cuadro lo contestó un gancho, no la persona' };
  if (d && d.decision && d.decision !== 'accept') return { ok: false, motivo: 'el cuadro no se aceptó' };
  const dijo = respuestaDelCuadro(r.toolUseResult);
  if (!dijo.ok) return { ok: false, motivo: `en la transcripción, ${dijo.motivo}` };
  if (dijo.pregunta !== a.pregunta || dijo.respuesta !== a.respuesta) return { ok: false, motivo: 'la respuesta del cuadro en la transcripción no es la del registro' };
  if (!nombraLaFirma(dijo.pregunta, firma, sesion, sesion || a.sesion)) return { ok: false, motivo: `la pregunta del cuadro no nombra «firma ${firma}»${sesion ? ` ni «sesión ${sesion}»` : ''}, o nombra otra sesión` };
  return { ok: true };
}

/** Las capas de configuración de Claude Code que pueden traer ganchos, para la carpeta `cwd`. */
function capas({ casa = os.homedir(), cwd, plataforma = process.platform } = {}) {
  const fuera = [path.join(casa, '.claude', 'settings.json'), path.join(casa, '.claude', 'settings.local.json')];
  if (cwd) fuera.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  if (plataforma === 'darwin') fuera.push('/Library/Application Support/ClaudeCode/managed-settings.json');
  else if (plataforma === 'win32') fuera.push('C:\\Program Files\\ClaudeCode\\managed-settings.json');
  else fuera.push('/etc/claude-code/managed-settings.json');
  return fuera;
}

/**
 * Los `hooks.json` de los plugins instalados (`~/.claude/plugins/cache`; todos, porque uno sin habilitar puede habilitarse
 * sin pasar por acá). Los catálogos de `marketplaces/` no corren: no cuentan.
 */
function hooksDePlugins(casa = os.homedir()) {
  const fuera = [];
  const raiz = path.join(casa, '.claude', 'plugins', 'cache');
  const recorrer = (d, n) => {
    if (n > 7) return;
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') fuera.push({ ilegible: d }); return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') recorrer(p, n + 1);
      else if (e.isFile() && e.name === 'hooks.json' && path.basename(d) === 'hooks') fuera.push(p);
    }
  };
  recorrer(raiz, 0);
  return fuera;
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
function esPermitido(comando) {
  const c = String(comando || '').trim();
  if (!c || /[;&|`\n]|\$\(/.test(c)) return false;
  return PERMITIDOS.some((n) => {
    const ruta = path.join(ROOT, 'scripts', 'hooks', n);
    return c.includes(ruta) || c === `@tcg:${n}` || new RegExp(`(^|[\\s"'])[^\\s"']*/\\.tycon/harness/scripts/hooks/${n.replace('.', '\\.')}(["']?)$`).test(c);
  });
}

/**
 * Los ganchos ajenos que escuchan el cuadro: `{ ajenos: [{ archivo, evento, comando }], ilegibles: [archivo] }`. Mira
 * PreToolUse y PermissionRequest en las capas de configuración y en los plugins instalados.
 */
function escuchasDelCuadro({ casa = os.homedir(), cwd, plataforma } = {}) {
  const ajenos = [];
  const ilegibles = [];
  const archivos = [...capas({ casa, cwd, plataforma }).map((a) => ({ a, plugin: false })), ...hooksDePlugins(casa).map((a) => ({ a, plugin: true }))];
  for (const { a, plugin } of archivos) {
    if (typeof a === 'object') { ilegibles.push(a.ilegible); continue; }
    let j;
    try { j = JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') ilegibles.push(a); continue; }
    const hooks = (j && (plugin && !j.hooks ? j : j.hooks)) || {};
    for (const evento of ['PreToolUse', 'PermissionRequest']) {
      for (const g of Array.isArray(hooks[evento]) ? hooks[evento] : []) {
        if (!g || !alcanzaAlCuadro(g.matcher)) continue;
        for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
          const comando = h && (h.command || h.url || h.prompt || h.type);
          if (!esPermitido(h && h.command)) ajenos.push({ archivo: a, evento, comando: una(comando, 160) });
        }
      }
    }
  }
  return { ajenos, ilegibles };
}

// --- la coordinadora ------------------------------------------------------------------------------------------------

/**
 * La sesión coordinadora designada y confirmada por el dueño (la misma que lee la delegación, delegated-signing.js), o
 * null. Sin confirmar, un «aprobado» escrito en su pestaña no vale para otras sesiones.
 */
function coordinadoraConfirmada(casa) {
  try {
    const ds = require('./delegated-signing.js');
    const p = ds.accountPaths(casa);
    const d = require(path.join(LIB, 'critical-waivers.js')).designacionVigente({ dir: p.state });
    if (!d || d.error || !SESION.test(String(d.sesion || ''))) return null;
    const want = ds.confirmationRecord(d, null);
    const raw = fs.readFileSync(path.join(p.state, 'gates.log'), 'utf8');
    for (const l of raw.split('\n')) {
      if (!l.includes(want.name)) continue;
      let g;
      try { g = JSON.parse(l); } catch (_) { continue; }
      if (g && g.name === want.name && g.status === 'ok' && g.sesion === want.sesion && g.designacion_ts === want.designacion_ts && g.cita_sha === want.cita_sha) return d.sesion;
    }
    return null;
  } catch (_) { return null; }
}

// --- buscar la aprobación para una firma ----------------------------------------------------------------------------

/**
 * La aprobación vigente para la firma `firma` pedida desde `sesion` sobre `destino` (por defecto, la misma): sin usar, de
 * los últimos 30 minutos, dada en `sesion` o en la coordinadora (`coordinadora`: su id, o null), que nombra esa firma (y
 * `destino`, si no es la sesión donde se aprobó: un «aprobado» al plan de una sesión no aprueba el de otra).
 * `herramienta` ({ pid, inicio }): la de la firma; la aprobación de la propia sesión tiene que venir de ese mismo
 * proceso. `validar(aprobacion, contexto)` la confirma contra la transcripción y los ganchos; se pasa en las pruebas.
 * `cwd` y `casa` son los de la firma, nunca los del registro. `{ ok, aprobacion, via }` o `{ ok: false, motivo }`.
 */
function buscar({ casa, sesion, destino = sesion, firma, coordinadora = null, ahora = Date.now(), cwd, herramienta = null, validar } = {}) {
  if (!SESION.test(String(sesion || ''))) return { ok: false, motivo: 'la firma no dice de qué sesión es' };
  const sesiones = [sesion, ...(coordinadora && coordinadora !== sesion && SESION.test(coordinadora) ? [coordinadora] : [])];
  let candidatas = [];
  try { for (const s of sesiones) candidatas.push(...leerSesion(casa, s).filter((r) => r.sesion === s)); } catch (e) { return { ok: false, motivo: e.message }; }
  candidatas = candidatas.filter((r) => {
    const edad = ahora - Date.parse(r.ts);
    if (!(edad >= 0 && edad <= VENCE_MIN * 60000 && (r.tipo === 'click' || r.tipo === 'mensaje') && !usada(casa, r.id))) return false;
    // la de la propia sesión la anotó el mismo proceso de la herramienta que firma: otra copia de la sesión (abierta con
    // `--resume` por un agente) no aprueba por ella
    return !herramienta || r.sesion !== sesion || (r.herramienta && r.herramienta.pid === herramienta.pid && r.herramienta.inicio === herramienta.inicio);
  }).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  if (!candidatas.length) return { ok: false, motivo: 'no hay un click en el cuadro ni un «aprobado» tuyo de los últimos 30 minutos sin usar' };
  const check = validar || ((a, ctx) => validarEnClaude(a, ctx));
  let motivo = null;
  for (const a of candidatas) {
    const v = check(a, { casa, cwd, firma, sesion: a.sesion === destino ? null : destino });
    if (v && v.ok) return { ok: true, aprobacion: a, via: a.tipo };
    motivo = motivo || (v && v.motivo);
  }
  return { ok: false, motivo: `la aprobación no vale: ${motivo || 'no se pudo confirmar'}` };
}

/**
 * La confirmación con lo que deja Claude Code: la transcripción de la sesión donde se aprobó y, para el click, los
 * ganchos que escuchan el cuadro. `sesion`: la sesión sobre la que se firma, cuando la aprobación se dio en otra (la
 * coordinadora).
 */
function validarEnClaude(a, { casa = os.homedir(), cwd, firma, sesion } = {}) {
  const ruta = transcripcionDe(casa, a.sesion);
  if (!ruta) return { ok: false, motivo: `no encontré la transcripción de la sesión ${a.sesion}` };
  if (a.tipo === 'mensaje') return mensajeEnLaTranscripcion(ruta, a, { firma, sesion });
  const e = escuchasDelCuadro({ casa, cwd });
  if (e.ilegibles.length) return { ok: false, motivo: `no pude leer ${e.ilegibles[0]}, y sin leerla no sé si un gancho contestó el cuadro` };
  if (e.ajenos.length) return { ok: false, motivo: `un gancho que no es del arnés escucha el cuadro (${e.ajenos[0].evento} en ${e.ajenos[0].archivo}): mientras esté, el click no vale; escribí «aprobado»` };
  return clickEnLaTranscripcion(ruta, a, { firma, sesion });
}

module.exports = { VENCE_MIN, ENVUELTO, PERMITIDOS, carpeta, esAprobacion, mensajeDeLaPersona, respuestaDelCuadro, nombraLaFirma, lanzadoPorLaHerramienta,
  anotar, leerSesion, consumir, devolver, transcripcionDe, mensajeEnLaTranscripcion, clickEnLaTranscripcion, capas, hooksDePlugins, alcanzaAlCuadro, esPermitido,
  escuchasDelCuadro, coordinadoraConfirmada, buscar, validarEnClaude };
