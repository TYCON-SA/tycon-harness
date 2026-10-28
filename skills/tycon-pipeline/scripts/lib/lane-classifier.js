'use strict';
/**
 * El intérprete de castellano del portón de carril.
 *
 * POR QUÉ EXISTE — Y POR QUÉ ES EL JUEZ Y NO EL DESEMPATE
 * El carril no se decide con un regex sobre el prompt del user: el castellano no se deja regexear
 * (ver story-gate.js), y cada arreglo de un regex produce la falla opuesta (un "dale, probá con
 * 2.5 segundos" fijaría carril, por ejemplo). Por eso esto es quien interpreta qué autorizó el
 * humano, en el ÚNICO punto donde hace falta interpretarlo: el juicio de `marker.js adhoc set`
 * (una vez por sesión, no en cada prompt — el costo y la latencia por prompt son la razón de no
 * hacerlo ahí).
 *
 * QUÉ NO ES
 * NO es el freno. El freno sigue siendo mecánico: sin carril declarado, el portón bloquea el primer
 * toque de código, siempre. Esto sólo decide si una DECLARACIÓN de atajo refleja lo que el user
 * pidió de verdad.
 *
 * QUÉ LEE
 * Los prompts REALES del user (`recentPrompts`, que sólo escribe on-prompt.js desde
 * UserPromptSubmit). El agente no puede inyectar texto ahí: por eso contesta "¿qué autorizó el
 * humano?" y no "¿qué le conviene al agente?".
 *
 * FALLA HACIA LO MECÁNICO
 * Sin `claude`/`codex` en PATH, con TYCON_LANE_LLM=0, por timeout, salida no reconocida o cualquier
 * excepción → devuelve null y decide la capa mecánica sola (reason citando al user), como siempre.
 * Para abrir un atajo tiene que decir "adhoc" explícitamente; para vetarlo, "pipeline".
 *
 * EN WINDOWS
 * `claude` y `codex` instalados con npm son un `.cmd`, y Node no lanza un `.cmd` sin shell: no lo encuentra (busca
 * `.exe` y `.com`) o, desde Node 18.20.2 / 20.12.2, lo rechaza con EINVAL. Lanzarlo CON shell no se hace: el prompt
 * del dev viaja por ahí. Eso no termina en un 'sin-modelo' mudo, como si no hubiera nada instalado: el
 * desempate se apaga DICIÉNDOLO (via 'cmd-sin-shell', con el motivo) y decide la capa mecánica, como siempre. Queda
 * anotado en scripts/setup/windows-support.json (`excluded`). La plataforma y el entorno se inyectan en la prueba.
 *
 * Kill-switch del dev: TYCON_LANE_LLM=0 · modelo: TYCON_LANE_LLM_MODEL · timeout: TYCON_LANE_LLM_MS
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_MODEL = process.env.TYCON_LANE_LLM_MODEL || 'claude-haiku-4-5';
const CODEX_MODEL = process.env.TYCON_LANE_LLM_CODEX_MODEL || 'gpt-5.4-mini';
const TIMEOUT_MS = Number(process.env.TYCON_LANE_LLM_MS || 20000);
const MAX_PROMPTS = 8;
const MAX_CHARS = 4000;
// Rama claude: el CLI valida la respuesta contra este esquema (--json-schema) y la entrega en
// `structured_output` — siempre una de las tres palabras, nunca parloteo. La rama codex sigue
// leyendo texto, y parseVerdict lee las dos igual.
const VERDICT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { veredicto: { type: 'string', enum: ['ADHOC', 'PIPELINE', 'NINGUNO'] } },
  required: ['veredicto'],
  additionalProperties: false,
});

function enabled() {
  return process.env.TYCON_LANE_LLM !== '0';
}

function binAvailable(bin) {
  try {
    return spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 5000 }).status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * En Windows: ¿los CLI del modelo son sólo un `.cmd` (o `.bat`) que Node no puede lanzar sin shell?
 * Devuelve null si no es Windows, si alguno es un `.exe`/`.com` lanzable, o si no hay ninguno (eso sigue siendo
 * 'sin-modelo'). Si sólo hay `.cmd`: { via: 'cmd-sin-shell', motivo }.
 * @param {{platform?: string, env?: object}} [opts]  inyección para tests
 */
function cmdSinShell(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return null;
  const env = opts.env || process.env;
  const clavePath = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const dirs = String((clavePath && env[clavePath]) || '').split(';').map((d) => d.trim()).filter(Boolean);
  const existe = (f) => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } };
  const soloCmd = [];
  for (const bin of ['claude', 'codex']) {
    let cmd = null;
    for (const d of dirs) {
      if (['.exe', '.com'].some((e) => existe(path.join(d, bin + e)))) return null; // hay uno lanzable: se consulta
      if (!cmd) cmd = ['.cmd', '.bat'].map((e) => path.join(d, bin + e)).find(existe) || null;
    }
    if (cmd) soloCmd.push(`\`${bin}\` es ${cmd}`);
  }
  if (!soloCmd.length) return null;
  return {
    via: 'cmd-sin-shell',
    motivo: `el desempate por modelo está apagado en esta máquina: ${soloCmd.join(' y ')}, un .cmd que Node no lanza `
      + 'sin shell (y con shell no se lanza: el prompt del dev viaja por ahí). Decide la capa mecánica, como sin modelo.',
  };
}

/** Prompt del clasificador. Deliberadamente cerrado: una palabra, sin explicación. */
function buildPrompt(prompts) {
  const list = prompts
    .slice(-MAX_PROMPTS)
    .map((p, i) => `[${i + 1}] ${String(p).replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n');
  return [
    'Sos un clasificador. Leé estos mensajes que una persona le escribió a un asistente de',
    'programación, en orden cronológico (el último es el más reciente):',
    '',
    list,
    '',
    'Pregunta: ¿esa persona pidió que el cambio se haga como AJUSTE CHICO Y RÁPIDO (un hotfix, un',
    'arreglo puntual, algo sin proceso formal), o pidió que se haga con el PROCESO COMPLETO (con',
    'especificación escrita, plan y revisión)?',
    '',
    'Respondé EXACTAMENTE una de estas tres palabras, sin nada más:',
    '  ADHOC     — si pidió el camino rápido / ajuste chico / hotfix',
    '  PIPELINE  — si pidió el proceso completo, o pidió implementar una especificación o historia',
    '  NINGUNO   — si no lo dijo, si no está claro, o si sólo describió el trabajo sin elegir cómo hacerlo',
    '',
    'Reglas: si la persona NEGÓ una de las dos opciones ("no lo hagas rápido", "nada de hotfix"),',
    'eso NO es pedirla. Ante cualquier duda respondé NINGUNO — equivocarse hacia NINGUNO no rompe',
    'nada, equivocarse hacia ADHOC saltea revisiones de código.',
  ].join('\n');
}

/** Invocación real. Aislada para que los tests inyecten la suya. */
function defaultCall(prompt) {
  // TYCON_EVAL_SANDBOX=1: sin esto los hooks de SessionStart le inyectan al sub-modelo las alarmas
  // del arnés ("controls-bench EN ROJO — Correr: …") y el modelo va y las ejecuta en vez de hacer
  // su tarea.
  const env = Object.assign({}, process.env, { TYCON_EVAL_SANDBOX: '1' });
  if (binAvailable('claude')) {
    const r = spawnSync('claude', ['--model', CLAUDE_MODEL, '--print',
      '--output-format', 'json', '--json-schema', VERDICT_SCHEMA,
      // Effort explícito, para no depender del que tenga la sesión interactiva del dev. Con Haiku
      // (el default) el CLI no lo manda; aplica si TYCON_LANE_LLM_MODEL apunta a un modelo con effort.
      '--effort', 'low',
      // Clasificar no usa herramientas ni el contexto del arnés: --safe-mode no carga el CLAUDE.md
      // del dev, skills, plugins, hooks ni MCP para contestar una palabra.
      '--safe-mode', '--tools', ''], {
      input: prompt, encoding: 'utf-8', timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, env,
    });
    // Una falla del CLI (salida != 0, timeout, sobre ilegible, sin structured_output) tira: queda
    // anotada como via 'error' y no se confunde con un NINGUNO del modelo, que sí es una respuesta.
    if (r.error || r.status !== 0) throw new Error(`claude salió ${r.status}${r.error ? ` (${r.error.code})` : ''}`);
    const out = JSON.parse(r.stdout).structured_output;
    if (!out || typeof out.veredicto !== 'string') throw new Error('claude sin structured_output');
    return out.veredicto;
  }
  if (binAvailable('codex')) {
    const outFile = path.join(os.tmpdir(), `lane-classifier-${process.pid}.txt`);
    const r = spawnSync('codex', ['exec', '-m', CODEX_MODEL, '--skip-git-repo-check', '-s', 'read-only', '-o', outFile], {
      input: prompt, encoding: 'utf-8', timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, env,
    });
    if (r.error || r.status !== 0) throw new Error(`codex salió ${r.status}${r.error ? ` (${r.error.code})` : ''}`);
    return require('fs').readFileSync(outFile, 'utf-8'); // ilegible → tira, y queda como 'error'
  }
  return undefined; // sin claude ni codex en el PATH: no hubo a quién consultar
}

/** Lee la respuesta del modelo. Estricta a propósito: una sola de las tres palabras, o null. */
function parseVerdict(raw) {
  if (!raw) return null;
  const t = String(raw).toUpperCase();
  const hits = ['ADHOC', 'PIPELINE', 'NINGUNO'].filter((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (hits.length !== 1) return null; // ambiguo o parloteo → como si no hubiera contestado
  if (hits[0] === 'ADHOC') return 'adhoc';
  if (hits[0] === 'PIPELINE') return 'pipeline';
  return null; // NINGUNO
}

/**
 * @param {Array<string|{texto: string, origen: string}>} prompts  el registro de la sesión (lane.recentPrompts): el
 *   modelo lee sólo lo que escribió el dueño, no lo de otra sesión, de un agente o sin marca
 * @param {{call?: function, platform?: string, env?: object, warn?: function}} [opts]  inyección para tests
 * @returns {{lane: ('adhoc'|'pipeline'|null), via: string, motivo?: string}}
 */
function classifyLane(prompts, opts = {}) {
  if (!enabled()) return { lane: null, via: 'off' };
  const list = require('./story-gate.js').soloDelDueno(prompts).filter((p) => String(p || '').trim());
  if (!list.length) return { lane: null, via: 'sin-prompts' };
  // Acá no se tiran prompts enteros si el total pasa
  // MAX_CHARS: enterrar el pedido de story 3 prompts atrás con prompts largos lo sacaría de la
  // ventana del juez, y el veto se evadiría AUN CON modelo. La cita (reasonInPrompts) y el juez
  // tienen que ver los MISMOS 8 prompts: si hay que achicar, se recorta CADA prompt (el intent
  // vive al principio de la frase), nunca se descarta uno.
  const joined = list.join(' ');
  if (joined.length > MAX_CHARS) {
    const per = Math.max(120, Math.floor(MAX_CHARS / list.length));
    for (let i = 0; i < list.length; i++) list[i] = String(list[i]).slice(0, per);
  }

  // Windows con `claude`/`codex` sólo como .cmd: se apaga y se dice. Con una invocación inyectada sólo se mira si
  // la prueba inyecta también la plataforma (si no, las pruebas de siempre cambiarían de resultado en Windows).
  if (!opts.call || opts.platform) {
    const apagado = cmdSinShell(opts);
    if (apagado) {
      (opts.warn || ((m) => process.stderr.write(`${m}\n`)))(`[lane-classifier] ${apagado.motivo}`);
      return { lane: null, via: apagado.via, motivo: apagado.motivo };
    }
  }

  const call = opts.call || defaultCall;
  let raw = null;
  try {
    raw = call(buildPrompt(list));
  } catch (_) {
    return { lane: null, via: 'error' };
  }
  if (raw === undefined) return { lane: null, via: 'sin-modelo' };
  const lane = parseVerdict(raw);
  return { lane, via: lane ? 'llm' : 'llm-sin-veredicto' };
}

module.exports = { classifyLane, buildPrompt, parseVerdict, enabled, cmdSinShell, CLAUDE_MODEL, TIMEOUT_MS };
