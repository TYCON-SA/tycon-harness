#!/usr/bin/env node
/**
 * advisor-runner.js — capa de casos de ADVISORS del banco (los casos de cada advisor se escriben
 * cuando ese advisor entra — regla dura: un advisor no entra sin sus casos).
 *
 * A diferencia del runner de hooks (determinista), acá el sujeto es un LLM. El contrato de
 * veredicto:
 *   - cada caso es QUIRÚRGICO: un pecado → una regla → el pass es "el rule ID objetivo está
 *     presente (must-flag) / ausente (must-not-flag)" — NUNCA el conteo total de findings;
 *   - cada caso corre N veces (default 3) y se exige unanimidad: un caso con corridas mixtas
 *     se reporta INESTABLE (se rediseña, no se promedia). 🔴 EXCEPCIÓN DECLARADA:
 *     un caso puede declarar `varianza_declarada` con su ratio MEDIDO, un PISO de aciertos y un
 *     motivo escrito — por encima del piso pasa (clase `varianza-declarada`, listada al cierre),
 *     por DEBAJO es rojo de criterio. Sirve cuando el pecado es inequívoco y los fallos son
 *     disjuntos entre herramientas y repartidos entre revisores, con el prompt ya acotado al
 *     diff — variancia de muestreo del juicio, no defecto del caso. Declarar
 *     exige medición y motivo: no es un interruptor. Y un banco permanentemente en rojo se ignora;
 *   - desacuerdo persistente entre herramientas → asimetría declarada ("tools" + "asymmetry"
 *     en el caso), visible — el silencio no se acepta;
 *   - un caso puede exigir además QUE UNA TOOL MCP SE LLAMÓ (campo expect_mcp):
 *     cuando la tool falta, el advisor no se detiene ni inventa — SUSTITUYE el
 *     método por un comando de consola sin declararlo, así que el veredicto correcto
 *     por un camino no declarado tiene que caer en rojo. Si el server no está instalado en la
 *     máquina, el caso se SALTEA DEJANDO CONSTANCIA (skipped_mcp) — ni verde que miente ni rojo
 *     que no significa nada. Detección probada offline con --selftest-mcp (patrón live-fire
 *     --prove-detection: el detector se prueba contra outputs reales capturados, sin gastar LLM).
 *
 * Campo de caso:  "expect_mcp": { "server": "codebase_memory", "tool": "search_graph" }
 *   codex:  el caso pasa si stdout trae la línea `mcp: <server>/<tool> started`.
 *   claude: la corrida agrega --output-format stream-json --verbose y el caso pasa si algún
 *           tool_use se llama `mcp__<server>__<tool>` (el texto del veredicto se extrae del
 *           result final del stream).
 *
 * Casos por ARTEFACTOS (retrospective-capturer): el capturer no tiene rule IDs — su producto son
 * ESCRITURAS, y el veredicto lo da ESTE RUNNER verificándolas post-run (no el modelo):
 *   "expect_artifact": [{ "path": ".dashboard/metrics-*.json", "json_keys": [..], "content_regex": ".." }]
 *   "forbid_artifact": [{ "path": ".advisors/alerts.md" }]
 *   "expect_engram":   { "project": "advbench-retro", "min": 1 }   (o "max": 0 para el gemelo)
 *   "git_commits":     [{ "message": "..", "date": "2026-08-19T10:00:00", "files": {..} }]
 *   "sin_commits":     true → el repo del caso queda sin ningún commit (como lo deja `git init`)
 *   "expect_capturas": true → la línea `CAPTURAS: engram=<n> ...` es obligatoria; con
 *                       expect_engram además se CRUZA el n declarado contra el conteo real por
 *                       nonce — el delta declarado-vs-real ES el hallazgo (espejo CHEQUEOS-MCP).
 *   "expect_veredicto": "hallazgos" | "sin-la-regla" | "limpio" → el renglón `Veredicto:` con que
 *                       cierra el informe es obligatorio y tiene que cuadrar con el caso: nombrar su
 *                       regla, no nombrarla, o decir limpio (con ese renglón pipeline.js
 *                       decide si relanza al validador de stories en los re-loops). Lo lee
 *                       `veredictoDe`, el mismo parser de la corrida real: una copia se separaría.
 * `{{NONCE}}` en files/prompt/git_commits se reemplaza por un token único POR CORRIDA; la
 * verificación engram busca ese token — residuos de corridas previas no pueden dar falso verde.
 * GUARD duro: expect_engram.project y todo `engram_project=` del prompt DEBEN empezar con
 * "advbench-" o la suite no corre (falla en armado, antes de gastar LLM). TRIPWIRE (suite
 * "tripwire": true): el estado global REAL (dashboard del repo, gates.log, engram fuera de
 * advbench-*) se snapshotea antes y se re-chequea después de cada corrida — el banco no solo
 * no debe ensuciar: DETECTA si ensució. Limpieza post-suite: "engram_cleanup": "advbench-retro"
 * (delete project --hard, best-effort — la correctness no depende: el nonce aísla igual).
 * Detección probada offline con --selftest-retro (cero LLM, mismo patrón --prove-detection).
 *
 * Invocación del advisor (la real de cada herramienta, no un mock):
 *   claude: `claude -p` con el cuerpo del canónico agents/<name>.md como system prompt
 *           (--append-system-prompt), tools del frontmatter, model del frontmatter.
 *   codex:  `codex exec -p <name>` con el profile GENERADO por build/generate.js — o sea que
 *           este runner prueba también al generador: si el .toml no inyecta las instrucciones,
 *           el reporte no cita rule IDs y el caso cae en rojo.
 *
 * Cada corrida crea un fixture git-init efímero (codex exec exige repo git).
 *
 * Uso:
 *   node advisor-runner.js [--tool claude|codex|both] [--only <substr>] [--runs N] [--jobs N]
 *                          [--baseline write|check] [--json <path>] [--list] [--selftest-mcp]
 *                          [--selftest-retro] [--check-apps-off] [--pack <carpeta de un paquete>]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const crypto = require('crypto');
const { spawn, execSync, execFileSync } = require('child_process');
const { sinGitDelPadre } = require('../lib/clean-git-env.js');
const { siblingsFromPacks } = require('../lib/installed-packs.js');

const BENCH_DIR = __dirname;
const TCG = path.resolve(BENCH_DIR, '..', '..');
// La carpeta de los revisores: TYCON_AGENTS_DIR; si no, la `agents` del árbol del arnés (la que resuelve skills-dir.js,
// como el pipeline); si no está, la de Claude Code. Una máquina sólo con Codex no tiene la de Claude Code.
// El examen dice cuál eligió y por qué, y frena si no existe (ver main).
const { dir: AGENTS_DIR, origen: AGENTS_ORIGEN } = (() => {
  if (process.env.TYCON_AGENTS_DIR) return { dir: process.env.TYCON_AGENTS_DIR, origen: 'TYCON_AGENTS_DIR' };
  let por = '';
  try {
    const dir = path.join(require(path.join(TCG, 'scripts', 'lib', 'skills-dir.js')).resolveSkillsDirs().repo, 'agents');
    if (fs.existsSync(dir)) return { dir, origen: 'el árbol del arnés' };
    por = `el árbol no trae ${dir}`;
  } catch (e) { por = `no pude leer skills-dir.js (${(e && e.message) || e})`; }
  return { dir: path.join(os.homedir(), '.claude', 'agent-skills', 'agents'), origen: `la carpeta de Claude Code: ${por}` };
})();
const ADAPTERS_DIR = path.join(TCG, 'adapters', 'codex', 'agents');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CASES_DIR = path.join(BENCH_DIR, 'cases', 'advisors');
const EQ = JSON.parse(fs.readFileSync(path.join(TCG, 'build', 'equivalences.json'), 'utf8'));
const { veredictoDe } = require('../lib/validator-verdict.js');

/** ¿El server MCP está instalable-en-esta-máquina? Criterio barato y honesto: su command en PATH. */
function mcpServerAvailable(server) {
  const cfg = EQ.mcp_servers && EQ.mcp_servers[server];
  if (!cfg || !cfg.command) return false;
  try { execSync(`command -v ${cfg.command}`, { stdio: 'ignore', shell: '/bin/bash' }); return true; }
  catch (_) { return false; }
}

/** Detección MCP: ¿el output de la corrida prueba que la tool MCP se llamó?
 * 🔴 codex escribe las líneas `mcp: ...` por STDERR (4/4 en stderr, 0 en stdout): mirar solo stdout daría "no llamó"
 * en corridas donde el modelo SÍ llamó. Por eso recibe (stdout, stderr) por separado, y el selftest tiene el caso
 * "línea en stderr": probar solo el PARSEO con strings fabricados no prueba la PLOMERÍA de qué canal trae las líneas. */
function mcpCallDetected(tool, expect, stdout, stderr) {
  if (tool === 'codex') return ((stdout || '') + '\n' + (stderr || '')).includes(`mcp: ${expect.server}/${expect.tool} started`);
  // claude stream-json: un tool_use con el nombre exacto
  const wanted = `mcp__${expect.server}__${expect.tool}`;
  for (const line of stdout.split('\n')) {
    let d; try { d = JSON.parse(line); } catch (_) { continue; }
    if (d.type !== 'assistant' || !d.message || !Array.isArray(d.message.content)) continue;
    for (const b of d.message.content) if (b.type === 'tool_use' && b.name === wanted) return true;
  }
  return false;
}

/** claude stream-json → texto final (donde vive el veredicto de rule IDs). */
function claudeStreamText(stdout) {
  let out = '';
  for (const line of stdout.split('\n')) {
    let d; try { d = JSON.parse(line); } catch (_) { continue; }
    if (d.type === 'assistant' && d.message && Array.isArray(d.message.content))
      for (const b of d.message.content) if (b.type === 'text') out += b.text + '\n';
  }
  return out;
}
// ---------- retro: aserciones por ARTEFACTOS — el runner verifica, no el modelo ----------

function binAvailable(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore', shell: '/bin/bash' }); return true; }
  catch (_) { return false; }
}

function subNonce(s, nonce) { return nonce ? String(s).split('{{NONCE}}').join(nonce) : String(s); }

/** {{NONCE}} + fechas RELATIVAS {{DATE-3d}}/{{DATE+0d}} (ISO yyyy-mm-dd de hoy±n): un caso de
 * correlación ("hotfix hace 3 días") tiene que seguir significando "hace 3 días" cuando la
 * suite corra en noviembre — fechas absolutas en el JSON del caso se pudren solas. */
function subTokens(s, nonce) {
  return subNonce(s, nonce).replace(/\{\{DATE([+-]\d+)d\}\}/g,
    (_, d) => new Date(Date.now() + parseInt(d, 10) * 86400000).toISOString().slice(0, 10));
}

/** glob mínimo: '*' solo en el basename — alcanza para metrics-*.json (la fecha la pone el advisor). */
function globInFixture(fixture, pattern) {
  if (!path.basename(pattern).includes('*'))
    return fs.existsSync(path.join(fixture, pattern)) ? [path.join(fixture, pattern)] : [];
  const dir = path.join(fixture, path.dirname(pattern));
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp('^' + path.basename(pattern).split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f));
}

function hasKeyDeep(o, k) {
  if (!o || typeof o !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(o, k)) return true;
  return Object.values(o).some((v) => hasKeyDeep(v, k));
}

function checkArtifacts(fixture, caseDef, nonce) {
  const fails = [];
  for (const a of caseDef.expect_artifact || []) {
    const hits = globInFixture(fixture, a.path);
    if (!hits.length) { fails.push(`falta el artefacto ${a.path}`); continue; }
    const raw = fs.readFileSync(hits[0], 'utf8');
    if (a.json_keys) {
      let j = null; try { j = JSON.parse(raw); } catch (_) { fails.push(`${a.path} no parsea como JSON`); continue; }
      // búsqueda profunda a propósito: el SCHEMA del JSON no está pinneado (flat o anidado, lo
      // elige el advisor) — lo que se asserta es que las claves EXISTAN, no dónde viven.
      const missing = a.json_keys.filter((k) => !hasKeyDeep(j, k));
      if (missing.length) fails.push(`${a.path} sin las claves: ${missing.join(', ')}`);
    }
    if (a.content_regex && !new RegExp(subTokens(a.content_regex, nonce), 'm').test(raw))
      fails.push(`${a.path} no matchea /${a.content_regex}/`);
  }
  for (const f of caseDef.forbid_artifact || [])
    if (globInFixture(fixture, f.path).length) fails.push(`artefacto PROHIBIDO presente: ${f.path}`);
  return fails;
}

/** Salida real del CLI: entradas "[1] #813 (tipo) — título\n    ... | project: X | scope: ...". */
function engramEntries(raw) {
  return String(raw).split(/^(?=\[\d+\] #\d+)/m).filter((c) => /^\[\d+\] #\d+/.test(c))
    .map((c) => ({ text: c, project: (c.match(/project:\s*([^\s|]+)/) || [])[1] || null }));
}

function engramSearch(query, project) {
  const p = project ? ` --project ${JSON.stringify(project)}` : '';
  try { return String(execSync(`engram search ${JSON.stringify(query)}${p} --limit 100 < /dev/null 2>/dev/null`, { shell: '/bin/bash', timeout: 30000 })); }
  catch (e) { return String((e && e.stdout) || ''); }
}

/**
 * ¿Este caso DECLARA variancia para esta herramienta?
 *
 * ── POR QUÉ EXISTE ─────────────────────────────────────────────────────────────────────────────
 * La doctrina de este banco es unanimidad: corridas mixtas = INESTABLE = "rediseñar el caso, no
 * promediar". Correcta cuando el sujeto es determinístico. Acá el sujeto es un LLM, y un caso
 * inestable no siempre está mal escrito:
 *   · los pecados plantados son inequívocos (un `async void` en un Hub, un archivo que no existe);
 *   · los must-flag fallan 2/3 y los must-not-flag 1/3 — o sea, el revisor acierta la
 *     mayoría de las veces y falla una;
 *   · los fallos son DISJUNTOS entre herramientas;
 *   · están repartidos entre varios revisores, sin concentración;
 *   · el prompt ya está acotado al diff — no hay rediseño barato que los estabilice.
 * Es variancia de muestreo del juicio, no defecto del caso.
 *
 * Y un banco permanentemente en rojo se ignora: un reporte que nadie mira no avisa nada.
 *
 * ── LA REGLA, CON PISO ─────────────────────────────────────────────────────────────────────────
 * Un caso puede DECLARAR su variancia con el ratio MEDIDO y un PISO de aciertos. Por encima del
 * piso es `varianza-declarada` (verde, visible, contada aparte). **Por debajo es ROJO de criterio**
 * — así una degradación real (de 2/3 a 1/3) sigue gritando. La unanimidad sigue siendo el default
 * de todos los demás casos: declarar exige medición y motivo escritos, no es un interruptor.
 *
 * @returns {{piso:number, medido:string, fecha:string, motivo:string}|null}
 */
function varianzaAplicable(caseDef, tool) {
  const v = caseDef.varianza_declarada;
  if (!v || typeof v.piso !== 'number') return null;
  const scope = v.tool || 'ambas';
  if (scope !== 'ambas' && scope !== tool) return null;
  if (!v.motivo || !v.medido) return null;   // sin medición ni motivo no es una declaración
  return v;
}

// Casos que pasaron por variancia declarada — se listan al cierre: declarar no es esconder.
const declaradas = [];

/**
 * El veredicto de un caso con corridas MIXTAS. PURA — es la propiedad de seguridad del mecanismo
 * (el piso), así que se ejerce sin invocar un solo LLM (--selftest-variance).
 * @returns {{ok:true, aciertos:number}} | {{ok:false, motivo:'degradó'|'inestable', aciertos:number}}
 */
function veredictoMixto(flags, want, v, huboError) {
  const aciertos = flags.filter((f) => f === want).length;
  // 🔴 Una declaración NO aplica si alguna corrida no terminó: la muestra está contaminada y
  // declarar sobre ella sería tapar plomería con una etiqueta de variancia.
  if (huboError) return { ok: false, motivo: 'contaminado', aciertos };
  if (!v) return { ok: false, motivo: 'inestable', aciertos };
  if (aciertos >= v.piso) return { ok: true, aciertos };
  return { ok: false, motivo: 'degradó', aciertos };
}

/**
 * Un "0 obs" NUNCA viaja solo: si el corral no existía, el rojo es de INFRAESTRUCTURA y lo dice.
 * PURA para poder ejercerla sin invocar un solo LLM (--selftest-sandbox).
 */
function anotarCorralRoto(fails, project, motivo) {
  if (!motivo || !fails.length) return fails;
  return fails.map((f) => `${f} · 🔴 CAUSA PROBABLE: el corral ${project} no se pudo crear (${motivo}) — el advisor no tenía dónde guardar y cayó a su failure-mode "engram down". NO es falla de criterio del revisor.`);
}

/** Solo cuentan las entradas que CONTIENEN el nonce: la búsqueda puede traer matches difusos. */
function evalEngram(exp, entries) {
  const n = entries.length;
  const fails = [];
  if (exp.min != null && n < exp.min) fails.push(`engram(${exp.project}): ${n} obs con el nonce, esperaba ≥${exp.min}`);
  if (exp.max != null && n > exp.max) fails.push(`engram(${exp.project}): ${n} obs con el nonce, esperaba ≤${exp.max}`);
  // "contains": la obs tiene que traer el CONTENIDO plantado, no solo la etiqueta — una obs
  // basura con el nonce pegado no es una captura (el veredicto sigue siendo del runner).
  if (exp.contains && n > 0 && !entries.some((e) => new RegExp(exp.contains, 'i').test(e.text))) {
    // Se imprime lo que SÍ se guardó: el corral engram se barre post-corrida y sin esto el
    // debug de un miss de contains es a ciegas.
    const muestra = entries.slice(0, 2).map((e) => JSON.stringify(String(e.text).slice(0, 180))).join(' · ');
    fails.push(`engram(${exp.project}): ninguna obs con el nonce matchea /${exp.contains}/ — etiqueta sin contenido. Guardado: ${muestra}`);
  }
  return { fails, count: n };
}
function checkEngram(caseDef, nonce) {
  const exp = caseDef.expect_engram;
  if (!exp) return { fails: [], count: null };
  const r = evalEngram(exp, engramEntries(engramSearch(nonce, exp.project)).filter((e) => e.text.includes(nonce)));
  r.fails = anotarCorralRoto(r.fails, exp.project, corralesRotos.get(exp.project));
  return r;
}

function capturasDeclared(text) {
  const m = String(text).match(/^CAPTURAS:\s*engram=(\d+)/m);
  return m ? parseInt(m[1], 10) : null;
}

// `expect_veredicto`. Que falte el renglón o no cuadre es una falla del informe, no del
// criterio de la regla: el texto lleva «renglón Veredicto» y claseDeVeredicto lo cuenta como artefactos.
// Tres expectativas, con la misma lógica de un pecado → una regla del resto del banco:
//   "hallazgos"    → dice hallazgos y nombra la regla del caso (los que deben marcar);
//   "sin-la-regla" → limpio o hallazgos, sin nombrar la regla del caso (los gemelos limpios);
//   "limpio"       → dice limpio (sólo para un fixture limpio para TODAS las reglas).
// 🔴 Los gemelos no esperan "limpio": son limpios para SU regla, y pueden decir «hallazgos» con
// razón por otra (VAL-W3, VAL-C8).
// «limpio (VAL-C1)» sale inconsistente y no pasa por ninguna.
const VEREDICTOS_ESPERABLES = ['hallazgos', 'sin-la-regla', 'limpio'];
function checkVeredicto(caseDef, text) {
  const esperado = caseDef.expect_veredicto;
  if (!esperado) return [];
  const v = veredictoDe(text);
  if (v.estado === 'sin_veredicto') return ['falta el renglón Veredicto: obligatorio al cierre del informe'];
  const regla = String(caseDef.rule || '').toUpperCase();
  if (esperado === 'hallazgos') {
    if (v.estado !== 'hallazgos') return [`el renglón Veredicto: dice «${v.estado}» y el caso espera «hallazgos»`];
    if (regla && !v.reglas.includes(regla)) return [`el renglón Veredicto: dice hallazgos pero no nombra ${regla}, la regla del caso`];
    return [];
  }
  if (esperado === 'sin-la-regla') {
    if (v.estado !== 'limpio' && v.estado !== 'hallazgos') return [`el renglón Veredicto: dice «${v.estado}» y el caso espera limpio o hallazgos sin ${regla}`];
    if (v.reglas.includes(regla)) return [`el renglón Veredicto: nombra ${regla} y el caso no la debe marcar`];
    return [];
  }
  if (v.estado !== esperado) return [`el renglón Veredicto: dice «${v.estado}» y el caso espera «${esperado}»`];
  return [];
}

// Tripwire: el estado global REAL que un caso mal diseñado podría ensuciar.
const REAL_DASHBOARD = path.join(TCG, '.dashboard');
const REAL_GATES = path.join(stateDirOf(os.homedir()), 'gates.log');
function statSig(p) { try { const s = fs.statSync(p); return `${s.size}:${Math.floor(s.mtimeMs)}`; } catch (_) { return 'ausente'; } }
function tripwireSnapshot(P) {
  P = P || { dash: REAL_DASHBOARD, gates: REAL_GATES };
  const dash = {};
  try { for (const f of fs.readdirSync(P.dash)) dash[f] = statSig(path.join(P.dash, f)); } catch (_) {}
  let gates = null;
  try { gates = fs.statSync(P.gates).size; } catch (_) { gates = null; }
  return { P, dash, gates };
}
/** gates.log es un log GLOBAL append-only que otras sesiones escriben en paralelo (un pipeline
 * corriendo en otra sesión puede apendear durante el banco → falso CONTAMINACIÓN). El tripwire
 * es content-aware: crecer con líneas AJENAS es legítimo;
 * contamina una línea nueva que refiera al banco (markers) o un log reescrito/achicado. */
function tripwireDiff(before, nonce, markers) {
  markers = markers || ['advbench-'];
  const after = tripwireSnapshot(before.P);
  const fails = [];
  // El dashboard REAL también lo escribe el capturer VERDADERO de otra sesión (el merge de un producto del equipo
  // puede correr su step 10b durante la paridad) — misma lección que gates.log:
  // por-presencia es racy, el veredicto es POR CONTENIDO. Un archivo nuevo/cambiado contamina
  // solo si su contenido trae markers del banco; si no, es una escritura legítima ajena.
  for (const f of Object.keys(after.dash)) {
    if (before.dash[f] === after.dash[f]) continue;
    let body = '';
    try { body = fs.readFileSync(path.join(before.P.dash, f), 'utf8'); } catch (_) {}
    if (markers.some((m) => body.includes(m)) || (nonce && body.includes(nonce)))
      fails.push(`CONTAMINACIÓN: el dashboard REAL recibió ${before.dash[f] ? 'cambios en' : 'el archivo'} "${f}" con contenido del banco`);
  }
  if (before.gates !== null && after.gates === null) fails.push(`CONTAMINACIÓN: el gates.log REAL (${before.P.gates}) desapareció durante la ejecución`);
  else if (before.gates !== null && after.gates < before.gates) fails.push(`CONTAMINACIÓN: el gates.log REAL se achicó (append-only violado)`);
  else if (after.gates !== null && after.gates > (before.gates || 0)) {
    let delta = '';
    try { delta = fs.readFileSync(before.P.gates, 'utf8').slice(before.gates || 0); } catch (_) {}
    for (const line of delta.split('\n'))
      if (line && markers.some((m) => line.includes(m))) { fails.push(`CONTAMINACIÓN: el gates.log REAL recibió una línea del banco: ${line.slice(0, 160)}`); break; }
  }
  if (nonce && binAvailable('engram'))
    for (const e of engramEntries(engramSearch(nonce)).filter((x) => x.text.includes(nonce)))
      if (!String(e.project || '').startsWith('advbench-'))
        fails.push(`CONTAMINACIÓN: el nonce apareció en el project engram "${e.project}" (fuera de advbench-*)`);
  return fails;
}

/** El corral tiene que EXISTIR antes de correr: engram v1.20 rechaza mem_save a un project
 * explícito inexistente (el advisor recibe available_projects y cae a su failure-mode "engram
 * down"). El save CLI sí crea el project. */
// Corrales que NO se pudieron crear. Lo lee checkEngram para que un "0 obs" nunca quede huérfano.
const corralesRotos = new Map();

function ensureCorral(name) {
  if (!String(name).startsWith('advbench-') || !binAvailable('engram')) return;
  let err = null;
  try {
    execSync(`engram save "corral del banco" "Project descartable ${name} — lo crea y barre advisor-runner.js (tanda 3). No es un proyecto real." --type note --project ${JSON.stringify(name)} < /dev/null`,
      { shell: '/bin/bash', timeout: 30000, stdio: 'ignore' });
  } catch (e) { err = String((e && e.message) || e).split('\n')[0]; }

  // 🔴 VERIFICAR que quedó creado, no confiar en que el comando no tiró. Un catch
  // vacío convertiría un corral ausente en un "0 obs con el nonce" indistinguible de "el
  // advisor no guardó": engram v1.20 rechaza `mem_save` a un project inexistente y el capturer cae
  // —con razón— a su failure-mode "engram down → escribir local". Sería un rojo real, de
  // infraestructura, disfrazado de falla de criterio del revisor.
  let existe = false;
  try {
    existe = new RegExp(`(^|\\s)${name}(\\s|$)`, 'm')
      .test(String(execSync('engram projects list < /dev/null 2>/dev/null', { shell: '/bin/bash', timeout: 30000 })));
  } catch (e) { err = err || String((e && e.message) || e).split('\n')[0]; }

  if (!existe) {
    corralesRotos.set(name, err || 'no aparece en `engram projects list` después de crearlo');
    console.log(`⚠️ CORRAL ${name} NO se pudo crear (${corralesRotos.get(name)}) — los casos con expect_engram van a dar 0 obs por INFRAESTRUCTURA, no por criterio del revisor.`);
  }
}

/** GUARD duro anti-"caso mal diseñado escribe a un project real" — corre en armado, antes del LLM.
 * También frena un `expect_veredicto` que no existe, o "hallazgos"/"sin-la-regla" en un caso sin `rule`:
 * fallarían en cada corrida o pasarían sin mirar la regla ("hallazgos" sin
 * `rule` dejaría de exigir que el renglón la nombrara). */
function retroGuard(suites) {
  for (const s of suites) for (const c of s.cases) {
    if (c.expect_veredicto !== undefined && !VEREDICTOS_ESPERABLES.includes(c.expect_veredicto))
      throw new Error(`CASO MAL ARMADO: ${s.advisor}::${c.id} declara expect_veredicto=${JSON.stringify(c.expect_veredicto)} — vale ${VEREDICTOS_ESPERABLES.map((x) => `"${x}"`).join(', ')}; la suite no corre`);
    if ((c.expect_veredicto === 'sin-la-regla' || c.expect_veredicto === 'hallazgos') && !c.rule)
      throw new Error(`CASO MAL ARMADO: ${s.advisor}::${c.id} declara expect_veredicto=${JSON.stringify(c.expect_veredicto)} sin "rule" — el renglón no tiene contra qué regla juzgarse; la suite no corre`);
    const bad = [];
    if (c.expect_engram && !String(c.expect_engram.project || '').startsWith('advbench-'))
      bad.push(`expect_engram.project="${c.expect_engram.project}"`);
    if (s.tripwire) {
      const m = String(c.prompt || '').match(/engram_project=([^\s·,)]+)/);
      if (m && !m[1].startsWith('advbench-')) bad.push(`engram_project=${m[1]} en el prompt`);
    }
    if (bad.length)
      throw new Error(`GUARD advbench: ${s.advisor}::${c.id} escribiría fuera del corral (${bad.join(' · ')}) — la suite no corre`);
  }
}

/** sandbox de codex por PERFIL (retro es el único workspace-write) — default read-only. */
function codexSandbox(name) {
  try {
    const m = fs.readFileSync(path.join(ADAPTERS_DIR, `${name}.toml`), 'utf8').match(/^sandbox_mode\s*=\s*"([^"]+)"/m);
    return m ? m[1] : 'read-only';
  } catch (_) { return 'read-only'; }
}

const BASELINE_FILE = path.join(BENCH_DIR, 'baseline', 'claude-advisors.json');
const OUT_DIR = path.join(BENCH_DIR, '.bench');
const { nombreDeReporte } = require('./report-name.js');
const { rubrosNoMedidos } = require('./unmeasured-categories.js');
// 🔴 Ruta absoluta de claude/codex: bajo launchd el PATH no las alcanza y las invocaciones del banco
// fallarían TODAS con ENOENT, una por una. Ver tools-path.js.
const { rutaDeHerramienta } = require('./tools-path.js');
// Cada sesión arranca sin la configuración del usuario, con sólo la carpeta de la caja (ver isolation.js).
const { claudeIsolation, codexHome } = require('./isolation.js');
// un aviso del aislamiento (un settings.json ilegible, la llave de Codex que falta) se dice una vez por corrida del examen
const avisosDichos = new Set();
function avisarUnaVez(texto) { if (texto && !avisosDichos.has(texto)) { avisosDichos.add(texto); console.log(`⚠️  ${texto}`); } }

// Los nombres viejos de las opciones siguen andando: antes de la primera lectura de argv.
require('../lib/legacy-names.js').aliasArgv('scripts/controls-bench/advisor-runner.js', { exitCode: 2 });
const argv = process.argv.slice(2);
let _benchSettings = null;
function benchSettingsPath() {
  if (!_benchSettings) {
    _benchSettings = require('path').join(require('os').tmpdir(), `advbench-settings-${process.pid}.json`);
    // `--settings` es nivel CLI: la config personal del dev NO lo pisa. Acá
    // van las cosas que el banco fija por su cuenta: el effort (para no heredar el de la
    // sesión), el ENCIERRO de la corrida (ver reglasDeCorral) y el silencio de alrededor.
    //
    // 🔴 `disableAllHooks` — POR QUÉ. Sin esto, el detector de fugas dispara porque en la
    // salida aparecen rutas del disco del dev, SIEMPRE las mismas, y el examen las cuenta como
    // revisores que razonan mal. `--settings` MERGEA los hooks del usuario en vez de
    // reemplazarlos (una corrida con `--settings` sin clave `hooks` dispara igual los del dev en
    // cada invocación), así que la única forma de callar lo de alrededor es este booleano. Existe
    // en el CLI 2.1.236 y se lee del settings común, no sólo de política administrada.
    //
    // Y NO cambia el sujeto medido, que es la objeción obvia: en producción los advisors corren
    // como subagentes, y los hooks de arranque (el de horas, el `git pull` del arnés, el protocolo
    // de memoria) no los tocan jamás. Apagarlos ACERCA el banco a producción. Además, el
    // primer hook de arranque hace `git pull` sobre el repo del arnés: con los hooks puestos, el
    // examen muta en cada invocación el mismo repo que mide.
    // 🔴 `TYCON_BENCH_HOOKS=1` deja los hooks PRENDIDOS a propósito. No es un opt-out de comodidad:
    // es la única forma de REPRODUCIR la fuga para poder diagnosticarla. El arreglo la tapa, y una
    // causa tapada sin identificar vuelve por otro lado — el emisor de esas rutas
    // sigue sin nombre, y sólo se puede cazar en la máquina donde pasa (la máquina del examen), corriendo un
    // caso con los hooks puestos y `--save-output`. Nunca en una corrida que vaya a reportar.
    const conHooks = process.env.TYCON_BENCH_HOOKS === '1';
    if (conHooks) console.log('⚠️  TYCON_BENCH_HOOKS=1 — hooks PRENDIDOS: ejecución de diagnóstico, sus resultados NO son comparables');
    // la sesión no carga el settings.json del usuario (`--setting-sources`, ver claudeIsolation): de él sólo viene engram
    const iso = claudeIsolation();
    avisarUnaVez(iso.warning);
    require('fs').writeFileSync(_benchSettings, JSON.stringify(Object.assign({
      effortLevel: 'high',
      permissions: { deny: reglasDeCorral() },
    }, iso.settings, conHooks ? {} : { disableAllHooks: true })));
  }
  return _benchSettings;
}

const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

/**
 * 🔴 CHEQUEO DE VIDA (`--liveness`) — el examen que sí se paga.
 *
 * Qué mide: por cada revisor, UN par de gemelos —el caso que tiene que gritar y el que tiene que
 * callarse—, una sola corrida, una sola herramienta. Contesta una única pregunta: **¿sigue vivo?**
 * Un revisor muerto en silencio no emite su hallazgo crítico, el pipeline nunca se frena a
 * preguntarle nada al dev, y el problema pasa de largo sin que nadie note nada. Ése es el único
 * fallo que no caza ninguna otra pieza del arnés, y es el que este modo existe para cazar.
 *
 * Qué NO mide, a propósito: si el revisor se contradice entre corridas (eso necesita N corridas) y
 * si las dos herramientas coinciden (eso necesita las dos). Las dos preguntas siguen teniendo
 * respuesta en el examen profundo, que queda a pedido.
 *
 * Por qué existe: el examen completo son 97 casos × 2 herramientas × 3 corridas = 582 consultas y
 * ~3 horas. Un control caro cuyo hallazgo típico es un defecto propio se achica: esto son
 * 53 casos, 1 corrida, 1 herramienta.
 */
const VIDA = argv.includes('--liveness');
const TOOL = argVal('--tool', 'claude');
// --only acepta una LISTA separada por comas: re-medir un puñado de casos puntuales sin pagar
// la pasada completa (ej. unos pocos casos contaminados).
const ONLY = (argVal('--only', null) || '').split(',').map((x) => x.trim()).filter(Boolean);
// En `--liveness` una sola corrida por caso: la pregunta es "¿está vivo?", no "¿se contradice?".
// `--runs` explícito sigue mandando (para el que quiera un chequeo de vida más exigente).
const RUNS = parseInt(argVal('--runs', VIDA ? '1' : '3'), 10);
const JOBS = parseInt(argVal('--jobs', '3'), 10);
const BASELINE_MODE = argVal('--baseline', null);
const JSON_OUT = argVal('--json', null);
const LIST = argv.includes('--list');
const SAVE_OUTPUT = argv.includes('--save-output');

// `--pack <carpeta>`: el examen de UN paquete de organización (casos: scripts/tests/example-pack.test.js). Corre sólo los casos de `<carpeta>/exam/*.json`
// con los agentes de la carpeta del paquete. Una organización no puede sumar casos a cases/advisors/ (es del núcleo), y
// sus casos no viajan con el perfil del equipo: viven donde se arma el paquete. Sin la bandera, el examen es el de siempre.
// Pedido sin carpeta (`--pack` al final, o seguido de otra bandera): frena. Si cayera en el examen del núcleo, quien lo
// pidió creería haber examinado su paquete.
const PACK_PEDIDO = argv.includes('--pack');
const PACK_VALOR = PACK_PEDIDO ? argv[argv.indexOf('--pack') + 1] : null;
const PACK_DIR = PACK_VALOR && !PACK_VALOR.startsWith('--') ? path.resolve(PACK_VALOR) : null;
/** El paquete de `--pack` ({ name, dir, agentsDir, casesDir }), o el motivo por el que no se puede examinar. */
function packToExamine() {
  if (!PACK_DIR) return { error: '--pack necesita la carpeta del paquete: --pack <carpeta con pack.json y exam/>' };
  if (BASELINE_MODE) return { error: '--pack no admite --baseline: la línea de base es la del núcleo' };
  if (VIDA) return { error: '--pack no admite --liveness: el chequeo de vida es el del núcleo (su informe lo lee el aviso del arranque); para acotar un paquete, --only' };
  if (!(JOBS >= 1)) return { error: `--pack: --jobs tiene que ser un entero mayor que 0 (dijiste ${argVal('--jobs', '')}); con 0 carriles no corre ningún caso` };
  if (TOOL !== 'claude') return { error: `--pack corre sólo con --tool claude: los perfiles de codex se generan sólo para los agentes del núcleo (pediste ${TOOL})` };
  const manifest = path.join(PACK_DIR, 'pack.json');
  let json;
  try { json = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch (e) { return { error: `--pack: no pude leer ${manifest} (${e.code || e.message}); la carpeta tiene que ser la de un paquete, con su pack.json` }; }
  const casesDir = path.join(PACK_DIR, 'exam');
  const hayCasos = fs.existsSync(casesDir) && fs.readdirSync(casesDir).some((f) => f.endsWith('.json'));
  if (!hayCasos) return { error: `--pack: ${casesDir} no existe o no tiene casos (.json); los casos del examen de un paquete van en su carpeta exam/` };
  const agentsDir = path.resolve(PACK_DIR, typeof json.agents === 'string' && json.agents ? json.agents : 'agents');
  if (agentsDir !== PACK_DIR && !agentsDir.startsWith(PACK_DIR + path.sep)) return { error: `--pack: «agents» de ${manifest} sale de la carpeta del paquete` };
  const name = String(json.name || path.basename(PACK_DIR));
  // el prefijo del informe lleva la huella de la carpeta: dos nombres que se limpian igual («a.b», «a-b») no se pisan
  const huella = require('crypto').createHash('sha1').update(PACK_DIR).digest('hex').slice(0, 8);
  return { name, dir: PACK_DIR, agentsDir, casesDir, reportPrefix: `pack-${name}-${huella}` };
}
const PACK = PACK_PEDIDO ? packToExamine() : null;
/** Lo que tiene que cumplir cada archivo de casos de un paquete para que el examen lo corra: un `advisor` que sea un nombre
 *  (se usa para armar la ruta de su .md) y al menos un caso. null si vale; si no, el motivo. */
function suiteDePaqueteProblema(s, archivo) {
  if (!s || typeof s.advisor !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s.advisor))
    return `--pack: ${archivo} tiene que declarar "advisor" con el nombre del revisor (letras, números, «.», «_» y «-»; sin carpetas)`;
  if (!Array.isArray(s.cases) || !s.cases.length) return `--pack: ${archivo} está sin casos ("cases" vacío o ausente)`;
  // el texto del pedido va como argumento de la herramienta (`claude -p <texto>`): si empezara con «-» se leería como una
  // opción de la herramienta, no como el pedido
  const pedidoProblema = (v) => (typeof v !== 'string' ? 'tiene que ser texto' : (v.trimStart().startsWith('-') ? 'no puede empezar con «-»' : null));
  if (s.prompt_template !== undefined && pedidoProblema(s.prompt_template)) return `--pack: ${archivo}: "prompt_template" ${pedidoProblema(s.prompt_template)}`;
  // El contrato de un caso de paquete es el del ejemplo: id, type must-flag|must-not-flag, rule y files. Un caso sin regla
  // no se juzga contra nada, y uno que depende de un servidor (expect_mcp, expect_engram) se saltea si falta: los dos
  // darían un examen verde que no examinó nada.
  for (const c of s.cases) {
    const id = c && typeof c.id === 'string' && c.id ? c.id : null;
    const donde = `--pack: ${archivo}, caso ${id || '(sin id)'}`;
    if (!id) return `${donde}: falta "id"`;
    if (c.type !== 'must-flag' && c.type !== 'must-not-flag') return `${donde}: "type" tiene que ser must-flag o must-not-flag`;
    if (typeof c.rule !== 'string' || !c.rule.trim()) return `${donde}: falta "rule", la regla que el caso juzga`;
    // lista cerrada: lo que no está acá es del examen del núcleo (expect_*, tools, asymmetry…) o no existe. Una clave de
    // otra herramienta, por ejemplo, dejaría el caso salteado en silencio y el examen verde con los demás.
    const extra = Object.keys(c).find((k) => !CLAVES_DE_CASO_DE_PAQUETE.includes(k));
    if (extra) return `${donde}: "${extra}" no es una clave de un caso de paquete (valen: ${CLAVES_DE_CASO_DE_PAQUETE.join(', ')}); un caso de paquete se juzga sólo por su "rule"`;
    const noTexto = [Object.entries(c.files || {}), ...(Array.isArray(c.git_commits) ? c.git_commits : []).map((g) => Object.entries(g.files || {}))]
      .flat().find(([, v]) => typeof v !== 'string');
    if (noTexto) return `${donde}: el contenido de «${noTexto[0]}» tiene que ser texto`;
    if (c.prompt !== undefined && pedidoProblema(c.prompt)) return `${donde}: "prompt" ${pedidoProblema(c.prompt)}`;
    if (c.git_commits !== undefined && !(Array.isArray(c.git_commits) && c.git_commits.every((g) => g && typeof g === 'object'))) return `${donde}: "git_commits" tiene que ser una lista de commits`;
    const rutas = [...Object.keys(c.files || {}), ...(Array.isArray(c.git_commits) ? c.git_commits : []).flatMap((g) => Object.keys((g && g.files) || {}))];
    const fuera = rutas.find((r) => rutaDeCasoProblema(r));
    if (fuera) return `${donde}: el archivo «${fuera}» ${rutaDeCasoProblema(fuera)}`;
  }
  return null;
}
const CLAVES_DE_CASO_DE_PAQUETE = Object.freeze(['id', 'type', 'rule', 'files', 'git_commits', 'prompt', 'canario', 'nota']);
const NOMBRES_QUE_SE_CARGAN_SOLOS = Object.freeze(['.git', '.gitattributes', '.gitmodules', '.claude', '.codex', '.mcp.json',
  'claude.md', 'claude.local.md', 'agents.md', 'agents.override.md']);
/** null si `rel` es una ruta relativa que queda dentro de la carpeta temporal del caso; si no, el motivo. */
function rutaDeCasoProblema(rel) {
  const r = String(rel);
  if (!r || path.isAbsolute(r) || r.includes('\\') || r.split('/').some((t) => t === '..' || t === '')) return 'tiene que ser una ruta relativa, sin «..», sin «\\» y sin tramos vacíos';
  // ni dentro de un `.git` (en cualquier nivel y con cualquier caja: el disco de la Mac no distingue): un `.git/config`
  // plantado haría correr un comando en el `git commit` con que el examen arma la historia del caso. Tampoco lo que la
  // herramienta o git cargan solos desde la carpeta del caso: su configuración, sus servidores y sus instrucciones.
  const tramo = r.split('/').map((t) => t.toLowerCase()).find((t) => NOMBRES_QUE_SE_CARGAN_SOLOS.includes(t));
  if (tramo) return `no puede llamarse ni ir dentro de «${tramo}»: es algo que git o la herramienta cargan solos`;
  return null;
}

// ---------- canónico ----------
/** El canónico de un revisor: en la carpeta de agentes, o en la de su paquete (`packs/<p>/<agents>/`). Con
 *  `--pack`, en la carpeta de agentes de ese paquete y en ningún otro lado. */
function advisorFile(name) {
  if (PACK && !PACK.error) return path.join(PACK.agentsDir, `${name}.md`);
  const enRaiz = path.join(AGENTS_DIR, `${name}.md`);
  if (fs.existsSync(enRaiz)) return enRaiz;
  const dir = require(path.join(TCG, 'scripts', 'lib', 'pack-pieces.js')).agentDirInPacks(process.env.TYCON_PACKS_DIR || path.join(TCG, 'packs'), name);
  return dir ? path.join(dir, `${name}.md`) : enRaiz;   // no está en ningún lado: el error de lectura lo nombra
}
function advisorParts(name) {
  const raw = fs.readFileSync(advisorFile(name), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  const tools = (fm.tools || 'Read, Grep, Glob').replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean);
  return { body: m[2].trim(), model: fm.model || 'sonnet', tools };
}

/**
 * Preamble de invocación Codex — LA CAPA QUE RESUELVE LA SUSTITUCIÓN SILENCIOSA.
 * El modelo de Codex llama las tools MCP cuando se las nombra EN EL MENSAJE
 * de invocación, y las saltea cuando el mandato vive solo en developer_instructions
 * (aun con cláusula de conducta al tope). Entonces la invocación arma MECÁNICAMENTE
 * la lista de chequeos obligatorios LEYÉNDOLA del .toml generado (fuente única: el perfil), y
 * exige una línea de salida CHEQUEOS-MCP por tool — llenar un campo obligatorio es más confiable
 * que obedecer una orden general, y para llenarlo sin mentir hay que llamar (si miente, la
 * aserción expect_mcp lo ve igual: el started lo imprime codex, no el modelo).
 * El ejecutor codex del pipeline DEBE usar esta misma composición — anotado en
 * equivalences.json (codex_conduct_clause.__doc).
 */
function codexInvokePreamble(name) {
  const toml = fs.readFileSync(path.join(ADAPTERS_DIR, `${name}.toml`), 'utf8');
  const tools = [];
  let server = null;
  for (const line of toml.split('\n')) {
    const t = line.match(/^\[mcp_servers\.("?)([^\]"]+)\1\]/);
    if (t) { server = t[2]; continue; }
    const e = server && line.match(/^enabled_tools = \[(.*)\]/);
    if (e) for (const m of e[1].matchAll(/"([^"]+)"/g)) tools.push(`mcp__${server}__${m[1]}`);
  }
  if (!tools.length) return '';
  return (
    `CHEQUEOS OBLIGATORIOS DE ESTA EJECUCIÓN (no negociables): este perfil declara las tools MCP ` +
    `${tools.join(', ')}. Donde tu procedimiento pide usarlas, las USÁS de verdad — sustituirlas ` +
    `por un comando de consola o saltearlas está prohibido (un veredicto correcto por un camino ` +
    `no declarado cuenta como ejecución rota). Si una llamada falla, seguí con el resto y decilo. ` +
    `Tu reporte DEBE terminar con una línea por tool, textual:\n` +
    tools.map((t) => `CHEQUEOS-MCP: ${t}=<ok|falló: <motivo>|no-aplica: <por qué el procedimiento no la pedía en este caso>>`).join('\n') +
    `\n\n---\n\n`
  );
}

/** El profile de Codex tiene que ser el GENERADO y estar desplegado — falla ruidosa si no. */
function ensureCodexProfile(name) {
  const src = path.join(ADAPTERS_DIR, `${name}.toml`);
  if (!fs.existsSync(src))
    throw new Error(`no existe ${path.relative(TCG, src)} — correr: node build/generate.js --add ${name}`);
  const dst = path.join(CODEX_HOME, `${name}.config.toml`);
  fs.copyFileSync(src, dst); // idempotente; es lo mismo que hace generate.js --deploy
}

// ---------- una corrida ----------
function mkFixture(caseDef, nonce) {
  // prefijo 'advbench-': el plugin engram registra UNA SESIÓN por cwd en cada corrida (sin el prefijo
  // se acumulan projects basura 'tycon-advbench-*' con 0 obs) — con este prefijo la basura cae DENTRO
  // del corral advbench-* y la barre la limpieza post-suite; una escritura mal dirigida al project
  // del cwd la sigue cazando expect_engram (0 obs en advbench-retro).
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'advbench-'));
  const writeAll = (files) => {
    for (const [rel, content] of Object.entries(files || {})) {
      const p = path.resolve(sandbox, rel);
      // los casos de un paquete son de otra organización: ningún archivo de un caso se escribe fuera de su carpeta
      if (!p.startsWith(sandbox + path.sep)) throw new Error(`caso con un archivo fuera de su carpeta temporal: «${rel}»`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, subTokens(content, nonce));
    }
  };
  writeAll(caseDef.files);
  // 🔴 `sinGitDelPadre`: sin esto, el git del fixture escribe en el REPO DE VERDAD cuando a este
  // corredor lo llama un hook de pre-commit (git le exporta `GIT_DIR`/`GIT_INDEX_FILE`, y esas
  // variables ganan sobre el `cwd`): quedarían commits `fixture` en la rama del dev y el
  // árbol reemplazado por el del fixture. El motivo largo vive en `lib/clean-git-env.js`.
  const g = (cmd, env) => execSync(cmd, { cwd: sandbox, env: sinGitDelPadre(env) });
  // `"sin_commits": true`: el repo queda como lo deja `git init` —la primera historia de un repo recién
  // creado—, sin el commit del fixture. No se combina con `git_commits`.
  if (caseDef.sin_commits === true) {
    if (caseDef.git_commits) throw new Error('un caso con "sin_commits" no puede traer "git_commits"');
    g('git init -q -b main');
    return sandbox;
  }
  g(`git init -q -b main && git add -A && git -c user.email=bench@tycon -c user.name=bench commit -qm fixture`);
  // historia git plantada (caso correlación del retro: el hotfix POSTERIOR al merge es un commit
  // real con fecha real — `git log --grep` del advisor lo tiene que poder ver)
  for (const c of caseDef.git_commits || []) {
    writeAll(c.files);
    const d = c.date ? subTokens(c.date, nonce) : null;
    const dateEnv = d ? { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } : {};
    g(`git add -A && git -c user.email=bench@tycon -c user.name=bench commit -q --allow-empty -m ${JSON.stringify(subTokens(c.message || 'commit', nonce))}`, dateEnv);
  }
  return sandbox;
}

/**
 * CORRAL DE HERMANOS — el revisor de patrones hermanos recorre repos hermanos con un `find -maxdepth 6`.
 * Bajo el banco eso significa que se va a leer los repos REALES de la máquina: muchos repos y mucha
 * salida antes de que la mordaza de tiempo lo mate. El problema de fondo no es la lentitud: es que el veredicto de un
 * caso pasa a depender de qué tiene el dev en el disco — en otra máquina lee otros repos y puede
 * dar otro resultado. Un banco cuyo resultado cambia según la computadora no mide lo que dice.
 *
 * El corral son dos hermanos mínimos con el patrón canónico (BizuitUserContext por parámetro de
 * handler, nunca en DI), ANIDADOS a 4 niveles a propósito: el procedimiento del revisor exige
 * discovery full-depth justamente porque los hermanos reales viven anidados, y un corral plano
 * dejaría ese requisito sin ejercitar. Son DOS y no uno porque con <2 hermanos accesibles el
 * revisor degrada sus reglas a WARNING (regla 4 de "Proyectos hermanos") y los casos medirían
 * la degradación en vez del criterio.
 *
 * 🔴 Las firmas de los hermanos se COPIAN del contrato real (`IBackendPlugin` en
 * `Bizuit.Backend.Abstractions`: `Info`, `ConfigureServices(IServiceCollection, IConfiguration)`,
 * `ConfigureEndpoints(IPluginEndpointBuilder)`), NUNCA se inventan. Si se escribieran de memoria
 * (`ConfigureServices(IServiceCollection)`, `MapEndpoints`), el revisor —con razón— marcaría el
 * fixture LIMPIO como violación: el patrón "hermano" que el banco le mostraría sería falso.
 * Un corral inventado no mide al revisor: lo engaña.
 *
 * Vive FUERA del fixture, no adentro: el fixture es un repo git que el advisor audita, y meterle
 * dos plugins ajenos le cambiaría el diff bajo revisión.
 *
 * Cada hermano trae además un FORMULARIO al lado (`<producto>/FrontEnd/<nombre>-ordenes`):
 * el revisor también compara cómo un formulario arma la URL del backend, y sin formularios hermanos
 * ese criterio degradaría igual que el de los plugins. Calcan el patrón real del equipo: la base sale
 * de `dashboardParams.pluginApiUrl` y se le agrega `/<plugin>/<ruta>`.
 */
/** Entorno de toda corrida del banco: arnés callado + la raíz de repos apuntando al corral.
 *  TYCON_REPOS_ROOT es LA variable: la
 *  misma que usan las auditorías del arnés — ver scripts/lib/repos-root.js. */
function envDeCorrida(corral) {
  return Object.assign({}, process.env, { TYCON_EVAL_SANDBOX: '1', TYCON_REPOS_ROOT: corral });
}

// Qué hermanos fabrica lo dice el paquete que trae al revisor de hermanos (campo `siblings` de su
// pack.json, que no se publica; lo lee installed-packs.js): son plugins de clientes, y el núcleo no los nombra. Sin ese paquete el corral queda
// vacío: el pipeline tampoco corre al revisor de hermanos (viaja en el mismo paquete), pero el banco sí corre sus
// casos si están, y ahí el revisor mira un corral sin hermanos. Un paquete roto no deja el corral vacío: frena.
function mkCorralHermanos(hermanos = siblingsFromPacks()) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'advbench-hermanos-'));
  for (const { ruta: rel, nombre } of hermanos) {
    const d = path.join(raiz, rel);
    fs.mkdirSync(path.join(d, 'Features', 'Avisos'), { recursive: true });
    fs.writeFileSync(path.join(d, `${nombre}BackendPlugin.cs`), [
      'using Microsoft.Extensions.Configuration;',
      'using Microsoft.Extensions.DependencyInjection;',
      'using Bizuit.Backend.Abstractions;',
      `using ${nombre}Backend.Features.Avisos;`,
      '',
      `namespace ${nombre}Backend;`,
      '',
      `public class ${nombre}BackendPlugin : IBackendPlugin`,
      '{',
      `    public PluginInfo Info => new() { Name = "${nombre}", Version = "1.0.0" };`,
      '',
      '    public void ConfigureServices(IServiceCollection services, IConfiguration configuration)',
      '    {',
      '        // El plugin registra SOLO sus propios servicios, detrás de interfaz.',
      '        // BizuitUserContext lo provee el host: NO se registra en DI.',
      '        services.AddScoped<IAvisosService, AvisosService>();',
      '    }',
      '',
      '    public void ConfigureEndpoints(IPluginEndpointBuilder endpoints)',
      '    {',
      '        AvisosEndpoints.Map(endpoints);',
      '    }',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${nombre}Backend.csproj`), [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <ItemGroup>',
      '    <PackageReference Include="Bizuit.Backend.Abstractions" Version="1.0.0" />',
      '    <PackageReference Include="Bizuit.Backend.Core" Version="1.0.0" />',
      '  </ItemGroup>',
      '</Project>',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(d, 'Features', 'Avisos', 'AvisosEndpoints.cs'), [
      `namespace ${nombre}Backend.Features.Avisos;`,
      '',
      'public static class AvisosEndpoints',
      '{',
      '    public static void Map(IPluginEndpointBuilder endpoints)',
      '    {',
      '        // PATRÓN HERMANO: userContext es PARÁMETRO del handler y se pasa por argumento.',
      '        endpoints.MapGet("/avisos", async (BizuitUserContext userContext, IAvisosService svc) =>',
      '            Results.Ok(await svc.ListarAsync(userContext)));',
      '    }',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(d, 'Features', 'Avisos', 'IAvisosService.cs'), [
      `namespace ${nombre}Backend.Features.Avisos;`,
      '',
      'public interface IAvisosService',
      '{',
      '    Task<IReadOnlyList<string>> ListarAsync(BizuitUserContext userContext);',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(d, 'Features', 'Avisos', 'AvisosService.cs'), [
      `namespace ${nombre}Backend.Features.Avisos;`,
      '',
      'public class AvisosService : IAvisosService',
      '{',
      '    // userContext llega por ARGUMENTO, nunca por constructor.',
      '    public Task<IReadOnlyList<string>> ListarAsync(BizuitUserContext userContext) =>',
      '        Task.FromResult<IReadOnlyList<string>>(Array.Empty<string>());',
      '}',
      '',
    ].join('\n'));
    mkFormularioHermano(raiz, rel, nombre);
  }
  return raiz;
}

/** El formulario hermano del corral: punto de entrada que toma la base del host y un servicio que
 *  le agrega el nombre del plugin. Mismo calco que los plugins: el patrón real, no uno inventado. */
function mkFormularioHermano(raiz, rel, nombre) {
  const plugin = `${nombre.toLowerCase()}backend`;
  const d = path.join(raiz, rel.split('/')[0], 'FrontEnd', `${nombre.toLowerCase()}-ordenes`);
  fs.mkdirSync(path.join(d, 'src', 'services'), { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
    name: `${nombre.toLowerCase()}-ordenes`, version: '1.0.0',
    dependencies: { react: '^18.2.0', '@tyconsa/bizuit-form-sdk': '^1.0.0' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(d, 'src', 'index.tsx'), [
    "import React from 'react';",
    "import { OrdenesScreen } from './OrdenesScreen';",
    '',
    'interface DashboardParams { pluginApiUrl?: string; devPluginApiUrl?: string; authToken?: string }',
    '',
    'export default function Form({ dashboardParams }: { dashboardParams?: DashboardParams }) {',
    '  // La base de la API de plugins la da el host; en desarrollo, devPluginApiUrl.',
    "  const pluginApiUrl = dashboardParams?.pluginApiUrl || dashboardParams?.devPluginApiUrl || '';",
    "  if (!pluginApiUrl) return <div>Falta pluginApiUrl en dashboardParams.</div>;",
    "  return <OrdenesScreen pluginApiUrl={pluginApiUrl} authToken={dashboardParams?.authToken ?? ''} />;",
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(d, 'src', 'services', 'ordenes.service.ts'), [
    `const PLUGIN_NAME = '${plugin}';`,
    '',
    'export async function listarOrdenes(pluginApiUrl: string, authToken: string): Promise<unknown[]> {',
    '  // PATRÓN HERMANO: base del host + nombre del plugin + ruta.',
    '  const r = await fetch(`${pluginApiUrl}/${PLUGIN_NAME}/ordenes`, {',
    "    headers: { Authorization: `Bearer ${authToken.replace(/^Basic\\s+/i, '')}` },",
    '  });',
    '  if (!r.ok) throw new Error(`HTTP ${r.status}`);',
    '  return r.json();',
    '}',
    '',
  ].join('\n'));
}

/**
 * FUGA DEL CORRAL — ¿la corrida leyó cosas de la máquina real, fuera de su fixture?
 * La lista de permitidos se calibra contra las salidas guardadas del banco: el detector dispara en
 * los casos que leen los repos del dev y en ninguno de los otros. Los permitidos no son indulgencia: son lecturas que el procedimiento de
 * los advisors manda hacer (las guías del arnés, su propia definición) o ruido del entorno (PATH).
 */
const PERMITIDO_FUERA_DEL_CORRAL = [
  // El lugar por el que los revisores nombran al arnés: el nombre viejo y el nuevo, los dos
  // mientras dure la transición (lista de los dos nombres en scripts/tests/fixtures/harness-place-names.json) …
  path.join(os.homedir(), '.claude', 'tycon-claude-guides'),
  path.join(os.homedir(), '.claude', 'tycon-harness'),
  // 🔴 …y el clon REAL donde vive este archivo: si el enlace apunta a otro clon, o falta,
  // el encierro les negaría a los advisors las guías que su procedimiento les manda leer — sin error,
  // leen menos. Se deduce de __dirname, no del entorno.
  path.resolve(__dirname, '..', '..'),
  path.join(os.homedir(), '.claude'),
  path.join(os.homedir(), '.codex'),
  path.join(os.homedir(), '.bun'),
  path.join(os.homedir(), '.antigravity'),
  path.join(os.homedir(), '.local'),
  path.join(os.homedir(), '.nvm'),
];
/**
 * Las reglas que ENCIERRAN a Claude, derivadas de la MISMA lista de permitidos que usa el detector
 * de fugas de abajo. Un solo lugar: si mañana alguien agrega un permitido, el encierro y el
 * detector se mueven juntos — y no puede pasar que uno permita lo que el otro denuncia.
 *
 * 🔴 POR QUÉ EXISTE. A Codex se lo invoca con `--sandbox`; pararlo a Claude en el fixture NO es un
 * encierro. Sin él, casos donde las DOS herramientas dan el mismo veredicto
 * (`flags=[false,false,false]`, las dos aciertan) salen Codex en verde y Claude en rojo, porque
 * Claude se va a leer los repos reales del dev. Peor: las carpetas que lee en una máquina pueden NO
 * existir en otra, o sea que el mismo caso da distinto según la máquina — y eso ENSUCIA el tercio
 * de comparación entre herramientas, que es justamente lo que el examen existe para medir.
 *
 * Forma de las reglas (no documentada en ningún lado):
 *   · sólo valen reglas `Read(...)`; las de `Glob(...)`/`Grep(...)` el propio Claude las rechaza
 *     con un aviso — `Read` ya cubre todas las herramientas que leen archivos;
 *   · una ruta ABSOLUTA se escribe con doble barra: `Read(//Users/…/**)`. Con una sola no aplica
 *     y el encierro no hace nada, en silencio;
 *   · `deny` gana sobre `allow`, así que NO se puede "negar todo y permitir el fixture": eso
 *     bloquea también el fixture (probado). Por eso se enumera lo que se niega.
 */
function reglasDeCorral(opts = {}) {
  const raiz = opts.raiz || os.homedir();
  const permitidos = PERMITIDO_FUERA_DEL_CORRAL.map((p) => path.resolve(p));
  const deny = [];
  const bajar = (dir) => {
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entradas) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (permitidos.includes(full)) continue;                       // permitido: no se niega
      if (permitidos.some((p) => p.startsWith(`${full}${path.sep}`))) { bajar(full); continue; }
      deny.push(`Read(/${full}/**)`);                                 // `/${abs}` → `//Users/…`
    }
  };
  bajar(raiz);
  // 🔴 Fail-closed y RUIDOSO. Una lista vacía significa que el recorrido no pudo leer nada, y un
  // encierro vacío no encierra: las corridas quedarían leyendo el disco del dev y el examen
  // produciría veredictos irreproducibles — 5h30 de reloj para medir otra cosa.
  if (!deny.length) {
    throw new Error(`no se pudo armar el encierro de las ejecuciones: nada que negar bajo ${raiz} `
      + '— sin encierro los veredictos dependen de qué tiene el dev en el disco y no son reproducibles');
  }
  return deny;
}

/**
 * 🔴 EL SERVIDOR DE MEMORIA LO LEVANTA EL BANCO, UNA VEZ.
 *
 * Lo levanta un hook de arranque del plugin de engram (`engram serve &` si /health no
 * contesta), pero las corridas apagan los hooks (ver benchSettingsPath): sin ese arranque se
 * caen los 14 casos que afirman contra la memoria (`expect_engram`, `expect_mcp`): fallarían
 * por plomería, no por criterio.
 *
 * Levantarlo acá es además MÁS determinista que 582 arranques compitiendo entre sí: una sola
 * vez, verificado, y con el motivo escrito. Fail-open a propósito: si no se puede levantar, se
 * avisa fuerte y la corrida sigue — los casos que dependan de él van a fallar con su propio
 * mensaje, que dice más que un aborto acá.
 */
function asegurarMemoriaViva() {
  const puerto = process.env.ENGRAM_PORT || '7437';
  const url = `http://127.0.0.1:${puerto}/health`;
  const vivo = () => {
    try { execFileSync('curl', ['-sf', url, '--max-time', '1'], { stdio: 'ignore' }); return true; }
    catch { return false; }
  };
  if (vivo()) return true;
  try {
    spawn('engram', ['serve'], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    console.log(`⚠️  no pude levantar el servidor de memoria (${e.message}) — los casos que lo usan van a fallar y lo van a decir`);
    return false;
  }
  for (let i = 0; i < 20; i++) {                    // hasta ~4s, verificando de verdad
    execFileSync('sleep', ['0.2']);
    if (vivo()) { console.log(`memoria: servidor levantado por el banco (puerto ${puerto})`); return true; }
  }
  console.log(`⚠️  el servidor de memoria no respondió en ${url} — los casos que lo usan van a fallar y lo van a decir`);
  return false;
}

/**
 * 🔴 EL AVISO QUE EL PROPIO CLI DA SOBRE SUS PERMISOS NO ES UNA FUGA.
 *
 * Al arrancar, Claude Code LINTEA las reglas `permissions.allow` del settings del dev y por cada
 * regla mal formada escribe en stderr una línea que CITA el comando aprobado — con sus rutas
 * absolutas adentro. Eso no es la corrida leyendo el disco del dev: es el CLI hablando de su
 * propia configuración, antes de que el advisor exista.
 *
 * Medido en la máquina del examen: avisos fijos, siempre las mismas carpetas, idénticos
 * (a) con los hooks prendidos, (b) con los hooks apagados y (c) en un `claude -p "responde solo:
 * ok"` pelado, sin banco ni fixture. Contarlos como fugas haría pasar un ruido del CLI por
 * revisores que razonan mal — el recuento de criterio daría CERO.
 *
 * 🔴 Se recorta por la FORMA EXACTA del aviso, NO ignorando stderr. Una fuga de verdad puede
 * venir por stderr (un `grep` que se fue del corral escribe ahí), y perderla sería cambiar un
 * falso rojo por un falso verde — el intercambio que este banco existe para no hacer.
 */
const LINT_DE_PERMISOS = /^Permission (allow|deny|ask) rule \([^)]*\):/;
const sinLintDePermisos = (s) => String(s || '')
  .split('\n')
  .filter((l) => !LINT_DE_PERMISOS.test(l.trimStart()))
  .join('\n');

/**
 * 🔴 UN ROJO DEL CHEQUEO DE VIDA ES UNA SOSPECHA, NO UN VEREDICTO.
 *
 * `--liveness` corre UNA sola corrida por caso a propósito (ver la cabecera de VIDA): la pregunta es
 * "¿el revisor sigue vivo?", no "¿se contradice?". La contracara es que con una sola corrida el
 * modo NO PUEDE distinguir un defecto de criterio de una moneda al aire — es una limitación de
 * diseño, no un bug, y por eso hay que decirla EN EL INFORME y no en una guía que nadie abre a
 * las 2 de la mañana.
 *
 * Los rojos del chequeo de vida son variación entre corridas, no un defecto
 * real. Sin este aviso, el camino natural del que lee el informe
 * es editarle la prosa a un revisor sano.
 */
function avisoDeSospecha(vida, rojos) {
  if (!vida || !rojos.length) return null;
  return `   🔬 Un rojo acá es una SOSPECHA, no un veredicto: el chequeo de vida corre UNA sola `
    + `ejecución y con una no se distingue un defecto de una moneda al aire.\n`
    + `      Confirmalo ANTES de tocarle la prosa a ningún revisor:\n`
    + `        node scripts/controls-bench/advisor-runner.js --tool claude --runs 3 --only ${rojos.join(',')}\n`
    + `      Medido hasta hoy: 2 de 2 rojos del chequeo de vida fueron variación, ninguno defecto real.`;
}

/**
 * 🔴 MEDIA PAREJA, EN LAS DOS DIRECCIONES.
 *
 * El control mira que falte el gemelo LIMPIO ("prueba que grita, no que sabe callarse") y también
 * el que GRITA, que es la PEOR falta para el chequeo de vida: un revisor muerto, que no emite un
 * solo hallazgo, sale VERDE en su caso limpio y el modo cierra sin decir nada. Es exactamente el
 * fallo que `--liveness` existe para cazar.
 *
 * Devuelve null si la pareja está completa (o si el revisor no
 * tiene canario, que lo denuncia el control de al lado).
 */
function mitadFaltante(suite) {
  const cs = suite.cases || [];
  if (!cs.some((c) => c.canario === true)) return null;
  const grita = cs.some((c) => c.canario === true && c.type === 'must-flag');
  const calla = cs.some((c) => c.canario === true && c.type === 'must-not-flag');
  if (grita && calla) return null;
  return grita
    ? { falta: 'must-not-flag', texto: 'se prueba que grita, no que sabe callarse' }
    : { falta: 'must-flag', texto: '🔴 se prueba que se calla, NO que grita — un revisor MUERTO saldría verde acá' };
}

function fugaDelCorral(res, corral) {
  const txt = `${sinLintDePermisos(res.stdout)}\n${sinLintDePermisos(res.stderr)}`;
  const re = new RegExp(`${os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[A-Za-z0-9_./-]+`, 'g');
  const raices = new Set();
  for (const h of txt.match(re) || []) {
    if (PERMITIDO_FUERA_DEL_CORRAL.some((p) => h.startsWith(p))) continue;
    if (corral && h.startsWith(corral)) continue;
    raices.add(h.split('/').slice(0, 5).join('/'));
  }
  if (!raices.size) return [];
  return [`el corral se escapó: la ejecución leyó ${raices.size} ruta(s) reales de la máquina ` +
    `(${[...raices].slice(0, 3).join(', ')}${raices.size > 3 ? ', …' : ''}) — el veredicto pasa a ` +
    `depender de qué tiene el dev en el disco y deja de ser reproducible en otra máquina`];
}

function spawnP(bin, args, opts) {
  return new Promise((resolve) => {
    const ch = spawn(bin, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts));
    let stdout = '', stderr = '';
    const killer = setTimeout(() => ch.kill('SIGKILL'), (opts.timeout_s || 420) * 1000);
    ch.stdout.on('data', (d) => (stdout += d));
    ch.stderr.on('data', (d) => (stderr += d));
    ch.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
    ch.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, stdout, stderr: String(e) }); });
  });
}

async function runOnce(tool, advisorName, adv, caseDef, suite) {
  // nonce POR CORRIDA: cada una de las N corridas de un caso se asserta sola (una obs engram por
  // corrida, no una compartida) — se genera siempre, sustituir {{NONCE}} ausente es un no-op.
  const nonce = `ADVBENCH-${String(caseDef.id).replace(/[^a-z0-9-]/gi, '')}-${crypto.randomBytes(4).toString('hex')}`;
  // engram_seed: obs pre-plantada en el corral ANTES de la corrida — el caso dedup asserta que el
  // advisor la ENCUENTRA (expect_mcp mem_search) y NO re-guarda (expect_engram max:0 por nonce).
  // Va al project de expect_engram, que el guard ya obliga a advbench-*. Idempotencia no hace
  // falta: sembrar 3 veces en 3 corridas deja 3 copias sin nonce — invisibles para el veredicto.
  if (caseDef.engram_seed && caseDef.expect_engram && binAvailable('engram')) {
    try {
      execSync(`engram save ${JSON.stringify(caseDef.engram_seed.title)} ${JSON.stringify(caseDef.engram_seed.content)} --type ${caseDef.engram_seed.type || 'decision'} --project ${JSON.stringify(caseDef.expect_engram.project)} < /dev/null`,
        { shell: '/bin/bash', timeout: 30000, stdio: 'ignore' });
    } catch (_) { /* sin seed el caso cae en rojo con señal clara (el search no encuentra nada) */ }
  }
  const trip = suite.tripwire ? { snap: tripwireSnapshot(), markers: suite.tripwire_markers || ['advbench-'] } : null;
  const fixture = mkFixture(caseDef, nonce);
  // El corral de hermanos vive fuera del fixture y se borra con él (ver mkCorralHermanos).
  const corral = mkCorralHermanos();
  try {
    // prompt del caso, o template de la suite con {files} = lista de archivos del fixture
    const prompt = subTokens(caseDef.prompt ||
      (suite.prompt_template || '').replace('{files}', Object.keys(caseDef.files || {}).join(', ')), nonce);
    let res;
    const expectMcp = caseDef.expect_mcp || null;
    if (tool === 'claude') {
      // 🔴 --allowedTools NO confina tools MCP que los permisos del USUARIO ya permiten (el
      // capturer puede usar mem_update — fuera de su frontmatter — porque el
      // grant global de engram se hereda en claude -p). En producción el Agent tool sí confina
      // por frontmatter; el banco lo emula con DENY explícito de las hermanas mutantes no
      // declaradas — el espejo del enabled_tools de Codex, donde esas tools ni existen.
      const engramDeny = ['mem_update', 'mem_delete', 'mem_judge', 'mem_pin', 'mem_unpin', 'mem_review',
        'mem_merge_projects', 'mem_capture_passive', 'mem_session_start', 'mem_session_end']
        .map((t) => `mcp__plugin_engram_engram__${t}`)
        .filter((t) => !adv.tools.includes(t));
      // El banco fija su PROPIO effort y no hereda el de la sesión del dev: con
      // effortLevel xhigh en ~/.claude/settings.json (lo deja /model al subir la sesión),
      // los advisors `model: opus` headless mueren con API 400 (xhigh exige thinking) y el
      // resto corre en condiciones distintas a las del baseline. `high` es el default de
      // facto con el que se fija el baseline. (--settings mergea sobre las fuentes del user y
      // esta clave gana.)
      // 🔬 TYCON_BENCH_EXTRA_PROMPT — se AGREGA al system prompt del revisor, para correr el mismo
      // banco bajo una condición distinta y comparar (por ejemplo, si LEER POR RANGO en vez del
      // archivo entero cuesta hallazgos). Inerte si la variable no está: sin ella el
      // system prompt es byte a byte el de siempre y el baseline no se mueve.
      const extra = process.env.TYCON_BENCH_EXTRA_PROMPT || '';
      const args = [
        '-p', prompt,
        '--append-system-prompt', extra ? adv.body + '\n\n' + extra : adv.body,
        '--model', adv.model,
        '--settings', benchSettingsPath(),
        ...claudeIsolation({ corral }).args,
        '--allowedTools', adv.tools.join(','),
        '--disallowedTools', engramDeny.join(','),
      ];
      if (expectMcp) args.push('--output-format', 'stream-json', '--verbose');
      res = await spawnP(rutaDeHerramienta('claude'), args, { cwd: fixture, env: envDeCorrida(corral), timeout_s: caseDef.timeout_s });
    } else {
      // una CODEX_HOME propia por corrida: el perfil del revisor y la llave, sin el AGENTS.md, los servidores ni las
      // carpetas de la máquina. Sin el perfil generado, la corrida no se lanza (correría con la configuración de la máquina)
      let home;
      try { home = codexHome({ codexHome: CODEX_HOME, advisor: advisorName }); }
      catch (e) { home = null; res = { code: 1, stdout: '', stderr: `no pude aislar a codex: ${e.message}` }; }
      if (home && home.warning) avisarUnaVez(home.warning);
      if (home) {
        try {
          res = await spawnP(rutaDeHerramienta('codex'), [
            'exec', '-p', advisorName, '--sandbox', codexSandbox(advisorName), '--skip-git-repo-check',
            codexInvokePreamble(advisorName) + prompt,
          ], { cwd: fixture, env: Object.assign(envDeCorrida(corral), home.env), timeout_s: caseDef.timeout_s });
        } finally { home.cleanup(); }
      }
    }
    // FINDING = bullet que abre con el rule ID entre corchetes (formato del catálogo:
    // "- [SEC-C2] `file:line` ..."). Una MENCIÓN del ID en la sección "✅ OK" o en prosa
    // no es un finding — contarla como tal rompería el caso limpio.
    // Los corchetes son obligatorios (es lo que separa finding de mención), pero el énfasis
    // markdown alrededor NO: "- **[ACCOV-C1]**" es el mismo finding y daría falso rojo.
    const verdictText = (tool === 'claude' && expectMcp) ? claudeStreamText(res.stdout) : res.stdout;
    const flagged = caseDef.rule
      ? new RegExp(`^\\s*[-*+]\\s*[*_]{0,2}\\s*\\[${caseDef.rule}\\]`, 'm').test(verdictText)
      : null;
    const mcpCalled = expectMcp ? mcpCallDetected(tool, expectMcp, res.stdout, res.stderr) : null;
    // aserciones por artefactos — ANTES de borrar el fixture, verificadas por el runner
    const assertFails = [];
    const eg = checkEngram(caseDef, nonce);
    assertFails.push(...eg.fails);
    assertFails.push(...checkArtifacts(fixture, caseDef, nonce));
    if (caseDef.expect_capturas) {
      const decl = capturasDeclared(verdictText);
      if (decl === null) assertFails.push('falta la línea CAPTURAS: obligatoria al cierre del reporte');
      else if (eg.count != null && decl !== eg.count)
        assertFails.push(`CAPTURAS declara engram=${decl} pero el conteo real por nonce es ${eg.count} — el delta declarado-vs-real ES el hallazgo`);
    }
    assertFails.push(...checkVeredicto(caseDef, verdictText));
    if (trip) assertFails.push(...tripwireDiff(trip.snap, nonce, trip.markers));
    assertFails.push(...fugaDelCorral(res, corral));
    if (SAVE_OUTPUT) {
      fs.mkdirSync(path.join(OUT_DIR, 'advisor-outputs'), { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, 'advisor-outputs', `${caseDef.id}-${tool}-${Date.now()}.txt`), res.stdout + '\n--- stderr ---\n' + res.stderr);
    }
    return { flagged, mcpCalled, assertFails, exit: res.code, tail: res.code === 0 ? undefined : colaUtil(res) };
  } finally {
    try { fs.rmSync(fixture, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(corral, { recursive: true, force: true }); } catch (_) {}
  }
}

// pool simple de concurrencia
async function pool(items, worker, jobs) {
  const results = new Array(items.length);
  let i = 0;
  async function lane() {
    while (i < items.length) { const idx = i++; results[idx] = await worker(items[idx], idx); }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, lane));
  return results;
}

// ---------- selftest del detector MCP (offline, outputs REALES capturados — cero LLM) ----------
function selftestMcp() {
  const E = { server: 'codebase_memory', tool: 'search_graph' };
  const codexHit = 'user\n...\nmcp: codebase_memory/search_graph started\nmcp: codebase_memory/search_graph (completed)\nTOTAL=470 PRIMERO=crear_orden\n'; // salida real capturada
  const codexMiss = 'exec /bin/zsh -lc "engram search ..." exited 1\nESTADO: FALLO: la herramienta no está disponible\n'; // la SUSTITUCIÓN que el detector tiene que cazar
  const claudeHit = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__codebase_memory__search_graph' }] } }) + '\n';
  const claudeMiss = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }, { type: 'text', text: '- [XPAT-C1] hallazgo' }] } }) + '\n';
  const textStream = claudeMiss + JSON.stringify({ type: 'result', subtype: 'success', result: 'ignorado' }) + '\n';
  const checks = [
    ['codex detecta la llamada real (stdout)', mcpCallDetected('codex', E, codexHit, '') === true],
    ['codex detecta la llamada real EN STDERR (la plomería real — bug 2026-08-22)', mcpCallDetected('codex', E, '', 'mcp: codebase_memory/search_graph started\nmcp: codebase_memory/search_graph (failed)') === true],
    ['codex NO se deja engañar por la sustitución por consola', mcpCallDetected('codex', E, codexMiss, '') === false],
    ['claude detecta el tool_use exacto', mcpCallDetected('claude', E, claudeHit, '') === true],
    ['claude NO cuenta un Bash como la tool MCP', mcpCallDetected('claude', E, claudeMiss, '') === false],
    ['el veredicto se extrae de los bloques text del stream', /\[XPAT-C1\]/.test(claudeStreamText(textStream))],
    ['mcpServerAvailable: server declarado con command en PATH', mcpServerAvailable('codebase_memory') === true],
    ['mcpServerAvailable: server inexistente → false', mcpServerAvailable('no-existe-este-server') === false],
  ];
  let bad = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-mcp: ${name}`); if (!ok) bad++; }
  return bad ? 1 : 0;
}

// ---------- selftest de las aserciones por artefactos — offline, cero LLM ----------
// Mismo patrón --prove-detection: cada detector se prueba con su positivo Y su negativo. El
// negativo estrella es un canal/formato que el parser
// no vio nunca (selftest de detector necesita un caso por CANAL, no solo por formato).
function selftestRetro() {
  const checks = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-retrotest-'));
  try {
    // artefactos: glob + JSON keys (búsqueda profunda: el schema no está pinneado) + regex + forbid
    fs.mkdirSync(path.join(tmp, '.dashboard'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.dashboard', 'metrics-2026-08-22.json'),
      JSON.stringify({ metrics: { advisor_warnings_per_story: 1, retrospective_capturer_last_successful_run: 'x' } }));
    checks.push(['expect_artifact: glob + json_keys anidadas pasa',
      checkArtifacts(tmp, { expect_artifact: [{ path: '.dashboard/metrics-*.json', json_keys: ['advisor_warnings_per_story'] }] }, null).length === 0]);
    checks.push(['expect_artifact: clave ausente cae',
      checkArtifacts(tmp, { expect_artifact: [{ path: '.dashboard/metrics-*.json', json_keys: ['no_existe'] }] }, null).length === 1]);
    checks.push(['expect_artifact: archivo ausente cae',
      checkArtifacts(tmp, { expect_artifact: [{ path: '.advisors/alerts.md' }] }, null).length === 1]);
    checks.push(['expect_artifact: content_regex con nonce',
      checkArtifacts(tmp, { expect_artifact: [{ path: '.dashboard/metrics-*.json', content_regex: 'warnings_per_story' }] }, null).length === 0]);
    checks.push(['forbid_artifact: presente cae',
      checkArtifacts(tmp, { forbid_artifact: [{ path: '.dashboard/metrics-*.json' }] }, null).length === 1]);
    checks.push(['forbid_artifact: ausente pasa',
      checkArtifacts(tmp, { forbid_artifact: [{ path: '.advisors/alerts.md' }] }, null).length === 0]);
    // nonce: sustitución en files/prompt/git_commits
    checks.push(['{{NONCE}} se sustituye (multi-ocurrencia)', subNonce('a {{NONCE}} b {{NONCE}}', 'X1') === 'a X1 b X1']);
    // fechas relativas: el caso de correlación no se pudre con el calendario
    const d3 = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    checks.push(['{{DATE-3d}} → ISO de hace 3 días', subTokens('hotfix del {{DATE-3d}}', null) === `hotfix del ${d3}`]);
    checks.push(['{{DATE+0d}} → hoy', subTokens('{{DATE+0d}}', null) === new Date().toISOString().slice(0, 10)]);
    // fixture con historia git plantada (git real, offline)
    const fx = mkFixture({
      files: { 'a.txt': 'base {{NONCE}}' },
      git_commits: [{ message: 'hotfix: rollback export {{NONCE}}', date: '2026-08-19T10:00:00', files: { 'b.txt': 'fix' } }],
    }, 'N0');
    // el `git` de la verificación también va con el env limpio: si no, con un `GIT_DIR` heredado
    // lee la historia del repo que lanzó el banco y el caso mide otro repo.
    const log = String(execSync('git log --pretty=%s', { cwd: fx, env: sinGitDelPadre() }));
    checks.push(['git_commits: historia plantada, nonce en el mensaje', log.includes('hotfix: rollback export N0') && log.includes('fixture')]);
    checks.push(['git_commits: la fecha plantada es greppable por rango',
      String(execSync('git log --since=2026-08-18 --until=2026-08-20 --pretty=%s', { cwd: fx, env: sinGitDelPadre() })).includes('N0')]);
    checks.push(['nonce en files del fixture', fs.readFileSync(path.join(fx, 'a.txt'), 'utf8') === 'base N0']);
    fs.rmSync(fx, { recursive: true, force: true });
    // engram: parseo de la salida REAL del CLI — solo cuentan entradas CON el nonce
    const raw = 'Found 2 memories:\n\n[1] #813 (discovery) — Story 97.9 ADVBENCH-x-ff00 export\n    texto | project: advbench-retro | scope: project\n\n[2] #42 (config) — match difuso sin el token\n    texto | project: otro-proyecto | scope: project\n';
    const ent = engramEntries(raw).filter((e) => e.text.includes('ADVBENCH-x-ff00'));
    checks.push(['engram: cuenta SOLO entradas con el nonce (matches difusos afuera)', ent.length === 1 && ent[0].project === 'advbench-retro']);
    checks.push(['engram: "No memories found" → 0 entradas', engramEntries('No memories found for: "x"').length === 0]);
    checks.push(['engram contains: contenido plantado presente pasa', evalEngram({ project: 'advbench-retro', min: 1, contains: 'export' }, ent).fails.length === 0]);
    checks.push(['engram contains: etiqueta sin contenido cae', evalEngram({ project: 'advbench-retro', min: 1, contains: 'JSON_MODIFY' }, ent).fails.length === 1]);
    checks.push(['engram max:0 con obs presente cae (gemelo)', evalEngram({ project: 'advbench-retro', max: 0 }, ent).fails.length === 1]);
    // CAPTURAS: la línea mecánica del canónico
    checks.push(['CAPTURAS: parse del n declarado', capturasDeclared('reporte...\nCAPTURAS: engram=2 dashboard=.dashboard/m.json alertas=no') === 2]);
    checks.push(['CAPTURAS: línea ausente → null (el caso la exige y cae)', capturasDeclared('reporte sin línea') === null]);
    // VEREDICTO: el renglón con que cierra el validador de stories
    checks.push(['VEREDICTO: el runner usa el parser compartido, no una copia',
      veredictoDe === require('../lib/validator-verdict.js').veredictoDe]);
    checks.push(['VEREDICTO: «Veredicto: limpio» y el caso espera limpio → pasa',
      checkVeredicto({ expect_veredicto: 'limpio' }, '## Reporte\n✅ OK: frontmatter, ACs\n\nVeredicto: limpio').length === 0]);
    checks.push(['VEREDICTO: hallazgos con la regla del caso, en negrita y con bloquea → pasa',
      checkVeredicto({ rule: 'VAL-C1', expect_veredicto: 'hallazgos' }, '- [VAL-C1] `specs/x.md:3` no existe\n\n**Veredicto:** hallazgos (VAL-C1, VAL-W3) · bloquea: sí').length === 0]);
    const sinRenglon = checkVeredicto({ rule: 'VAL-C1', expect_veredicto: 'hallazgos' }, '- [VAL-C1] `specs/x.md:3` no existe');
    checks.push(['VEREDICTO: informe sin el renglón → cae con «falta el renglón»',
      sinRenglon.length === 1 && /falta el renglón Veredicto/.test(sinRenglon[0])]);
    checks.push(['VEREDICTO: dice limpio y el caso espera hallazgos → cae',
      checkVeredicto({ rule: 'VAL-C1', expect_veredicto: 'hallazgos' }, '- [VAL-C1] x\n\nVeredicto: limpio').length === 1]);
    checks.push(['VEREDICTO: hallazgos que no nombra la regla del caso → cae (el renglón no cuadra con el informe)',
      checkVeredicto({ rule: 'VAL-C1', expect_veredicto: 'hallazgos' }, '- [VAL-C1] x\n\nVeredicto: hallazgos (VAL-W3) · bloquea: no').length === 1]);
    checks.push(['VEREDICTO: gemelo con hallazgos de OTRA regla → pasa (la ejecución en vivo del 2026-09-17)',
      checkVeredicto({ rule: 'VAL-C1', expect_veredicto: 'sin-la-regla' }, '- [VAL-W3] tabla\n\nVeredicto: hallazgos (VAL-W3) · bloquea: no').length === 0]);
    checks.push(['VEREDICTO: gemelo limpio → pasa',
      checkVeredicto({ rule: 'VAL-W14', expect_veredicto: 'sin-la-regla' }, 'Veredicto: limpio').length === 0]);
    checks.push(['VEREDICTO: gemelo cuyo renglón nombra la regla del caso → cae',
      checkVeredicto({ rule: 'VAL-W14', expect_veredicto: 'sin-la-regla' }, 'Veredicto: hallazgos (VAL-C8, VAL-W14) · bloquea: sí').length === 1]);
    checks.push(['VEREDICTO: «limpio (VAL-C1)» es inconsistente y no pasa por limpio ni por gemelo',
      checkVeredicto({ expect_veredicto: 'limpio' }, 'Veredicto: limpio (VAL-C1)').length === 1
      && checkVeredicto({ rule: 'VAL-W3', expect_veredicto: 'sin-la-regla' }, 'Veredicto: limpio (VAL-C1)').length === 1]);
    checks.push(['VEREDICTO: un caso sin expect_veredicto no exige el renglón',
      checkVeredicto({}, 'reporte sin renglón').length === 0]);
    let threwV = false;
    try { retroGuard([{ advisor: 'x', cases: [{ id: 'c', expect_veredicto: 'limpo' }] }]); } catch (_) { threwV = true; }
    checks.push(['VEREDICTO: expect_veredicto con un estado que no existe frena en armado', threwV]);
    threwV = false;
    try { retroGuard([{ advisor: 'x', cases: [{ id: 'c', expect_veredicto: 'sin-la-regla' }] }]); } catch (_) { threwV = true; }
    checks.push(['VEREDICTO: "sin-la-regla" en un caso sin rule frena en armado', threwV]);
    // con "hallazgos" sin rule, checkVeredicto no puede exigir que el renglón la nombre
    threwV = false;
    try { retroGuard([{ advisor: 'x', cases: [{ id: 'c', expect_veredicto: 'hallazgos' }] }]); } catch (_) { threwV = true; }
    checks.push(['VEREDICTO: "hallazgos" en un caso sin rule frena en armado', threwV]);
    checks.push(['VEREDICTO: la falla del renglón es del informe (artefactos), no del criterio',
      claseDeVeredicto({ pass: false, failures: ['ejecución 1: falta el renglón Veredicto: obligatorio al cierre del informe'] }) === 'artefactos']);
    // guard advbench-: el freno anti proyecto real, probado en las dos direcciones
    let threw = false;
    try { retroGuard([{ advisor: 'x', tripwire: true, cases: [{ id: 'c', prompt: 'inputs: engram_project=ceibo · x', expect_engram: { project: 'advbench-retro' } }] }]); }
    catch (_) { threw = true; }
    checks.push(['guard: engram_project real en el prompt es RECHAZADO', threw]);
    threw = false;
    try { retroGuard([{ advisor: 'x', cases: [{ id: 'c', expect_engram: { project: 'totora' } }] }]); } catch (_) { threw = true; }
    checks.push(['guard: expect_engram.project real es RECHAZADO', threw]);
    let okGuard = true;
    try { retroGuard([{ advisor: 'x', tripwire: true, cases: [{ id: 'c', prompt: 'engram_project=advbench-retro', expect_engram: { project: 'advbench-retro' } }] }]); }
    catch (_) { okGuard = false; }
    checks.push(['guard: advbench-retro pasa', okGuard]);
    // tripwire: detecta el cambio en el estado "real" (dirs de prueba inyectados)
    const fakeDash = path.join(tmp, 'dash-real'); const fakeGates = path.join(tmp, 'gates.log');
    fs.mkdirSync(fakeDash); fs.writeFileSync(fakeGates, 'línea 1\n');
    const before = tripwireSnapshot({ dash: fakeDash, gates: fakeGates });
    checks.push(['tripwire: sin cambios → sin fallos', tripwireDiff(before, null).length === 0]);
    fs.writeFileSync(path.join(fakeDash, 'metrics-real.json'), '{"story":"CO-3","ratio":1}');
    checks.push(['tripwire: archivo nuevo AJENO en el dashboard real (capturer verdadero) → legítimo', tripwireDiff(before, null).length === 0]);
    const beforeB = tripwireSnapshot({ dash: fakeDash, gates: fakeGates });
    fs.writeFileSync(path.join(fakeDash, 'metrics-fuga.json'), '{"storyId":"97.12","src":"advbench-fixture"}');
    checks.push(['tripwire: archivo nuevo CON contenido del banco → CONTAMINACIÓN', tripwireDiff(beforeB, null, ['advbench-']).some((f) => f.includes('metrics-fuga'))]);
    const before2 = tripwireSnapshot({ dash: fakeDash, gates: fakeGates });
    fs.appendFileSync(fakeGates, '{"check":"advisors","storyId":"CO-3"}\n');
    checks.push(['tripwire: gates.log crece con línea AJENA (otra sesión) → legítimo', tripwireDiff(before2, null).length === 0]);
    const before3 = tripwireSnapshot({ dash: fakeDash, gates: fakeGates });
    fs.appendFileSync(fakeGates, '{"check":"advisors","repoRoot":"/var/T/advbench-x1","storyId":"97.9"}\n');
    checks.push(['tripwire: gates.log crece con línea DEL BANCO → CONTAMINACIÓN', tripwireDiff(before3, null).some((f) => f.includes('línea del banco'))]);
    const before4 = tripwireSnapshot({ dash: fakeDash, gates: fakeGates });
    fs.writeFileSync(fakeGates, 'log reescrito\n');
    checks.push(['tripwire: gates.log achicado/reescrito → CONTAMINACIÓN', tripwireDiff(before4, null).some((f) => f.includes('achicó'))]);
    // sandbox por perfil: default read-only si el .toml no existe / no declara
    checks.push(['codexSandbox: sin .toml → read-only', codexSandbox('no-existe-este-advisor') === 'read-only']);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  let bad = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-retro: ${name}`); if (!ok) bad++; }
  console.log(bad ? `❌ selftest-retro: ${bad}/${checks.length} rojos` : `✅ selftest-retro: ${checks.length}/${checks.length} verdes`);
  return bad ? 1 : 0;
}

// ---------- caso de banco "apps apagada" — determinista, $0 ----------
// Dos capas sin LLM (la cuota de Codex no puede dejar esto sin correr):
//   (a) ESTÁTICA: cada .toml del manifest declara `features.apps = false` ANTES de la primera
//       tabla — independiente del generador a propósito: si generate.js dejara de emitirla, el
//       --check del pre-commit NO lo vería (regeneraría sin la clave y "coincidiría"); esto sí.
//   (b) COMPORTAMIENTO: `codex debug prompt-input` CON `-c features.apps=false` no contiene el
//       MCP codex_apps y SIN el override sí — prueba que la clave sigue teniendo efecto en la
//       versión instalada de Codex. Skip con constancia si codex no está en la máquina.
// La capa LLM (el modelo mismo dice APPS=NO) viaja implícita en toda corrida codex del banco (el perfil se despliega en cada caso).
function checkAppsOff() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ADAPTERS_DIR, 'MANIFEST.json'), 'utf8'));
  let bad = 0;
  for (const name of manifest.advisors) {
    const toml = fs.readFileSync(path.join(ADAPTERS_DIR, `${name}.toml`), 'utf8');
    const firstTable = toml.search(/^\[/m);
    const keyAt = toml.indexOf('features.apps = false');
    const ok = keyAt >= 0 && (firstTable < 0 || keyAt < firstTable);
    if (!ok) { bad++; console.log(`❌ apps-off ESTÁTICA: ${name}.toml sin \`features.apps = false\` antes de la primera tabla`); }
  }
  console.log(bad ? `❌ apps-off estática: ${bad} perfiles mal` : `✅ apps-off estática: ${manifest.advisors.length}/${manifest.advisors.length} perfiles la declaran (antes de la primera tabla)`);
  let behavioral = null;
  try { execSync('command -v codex', { stdio: 'ignore', shell: '/bin/bash' }); behavioral = true; } catch (_) { behavioral = false; }
  if (!behavioral) {
    console.log('⏭️  apps-off comportamiento: SALTEADO con constancia — codex no está en esta máquina');
    return bad ? 1 : 0;
  }
  const render = (extra) => {
    try {
      return String(execSync(`codex debug prompt-input ${extra} "x" < /dev/null 2>/dev/null`, { shell: '/bin/bash', timeout: 60000 }));
    } catch (e) { return String((e && e.stdout) || ''); }
  };
  const con = render('-c features.apps=false');
  const sin = render('');
  // guardia anti-falso-verde (un --profile inexistente devuelve el TEXTO DEL ERROR,
  // que tampoco contiene codex_apps): el positivo y el negativo tienen que salir DISTINTOS.
  if (!sin.includes('codex_apps')) { console.log('❌ apps-off comportamiento: el render SIN override no muestra codex_apps — el chequeo perdió su positivo de control (¿cambió el formato de prompt-input?)'); return 1; }
  if (con.includes('codex_apps')) { console.log('❌ apps-off comportamiento: con features.apps=false el prompt SIGUE mostrando codex_apps — la clave dejó de tener efecto'); return 1; }
  console.log('✅ apps-off comportamiento: la clave sigue apagando el MCP codex_apps en la versión instalada');
  return bad ? 1 : 0;
}

// ---------- main ----------
/**
 * Clase de un veredicto a partir de sus fallas. ÚNICO lugar donde se decide qué clase de problema
 * es un rojo — lo usan el resumen de una corrida y `--reclassify`.
 *
 * 🔴 Por qué existe: contar juntos dos problemas que se arreglan de formas
 * OPUESTAS. Un rojo de CRITERIO es el revisor razonando mal, y se arregla editando su prosa. Uno
 * INESTABLE es el revisor contestando distinto entre corridas, y se arregla rediseñando el CASO
 * (o aceptando que ese juicio no es determinístico). Un número que
 * mezcla las dos cosas se lee como el peor de los dos, y por eso nadie actúa.
 */
/**
 * Cola ÚTIL de una corrida que no terminó. Un `slice(-400)` pelado no sirve bajo Codex: los
 * últimos 400 caracteres son SIEMPRE su registro de eventos ("hook: PostToolUse Completed" ×8),
 * así que el motivo real nunca se vería y quedaría un diagnóstico ciego.
 * Prioriza, en orden: la última mención de un error real, después stderr, después el final crudo.
 */
function colaUtil(res) {
  const txt = `${res.stderr || ''}\n${res.stdout || ''}`;
  const señal = /(?:^|\n)[^\n]*(?:\bERROR\b|\bError:|EPERM|EACCES|ENOENT|denied|refus|timed? ?out|SIGKILL|SIGINT|killed|panic|failed|falló)[^\n]*/gi;
  const hits = txt.match(señal) || [];
  const útil = hits.filter((h) => !/hook: (Pre|Post)ToolUse/.test(h)).slice(-3).join(' ⏎ ');
  const crudo = (res.stderr || res.stdout || '').slice(-300);
  return `exit=${res.code}${res.signal ? ` sig=${res.signal}` : ''} · ${útil || crudo}`.slice(0, 600);
}

function claseDeVeredicto(v) {
  if (!v || v.pass !== false) return 'ok';
  const f = (v.failures || []).map(String);
  // 🔴 EL ERROR DE CORRIDA GANA sobre INESTABLE.
  // Un caso con corridas mixtas DONDE ALGUNA NO TERMINÓ no es variancia de juicio: es plomería.
  // Si ganara INESTABLE, un caso con una corrida con exit≠0 quedaría etiquetado como variancia
  // — o sea, un problema de infraestructura contado como
  // "el revisor cambia de opinión". Es el MISMO error que este desglose existe para evitar, un
  // nivel más abajo: una etiqueta que mezcla dos causas se lee como la más benigna.
  if (f.some((x) => /exit!=0/.test(x))) return 'error';
  // 🔴 LA FUGA DEL CORRAL NO ES CRITERIO. Cuando el tripwire dispara, los veredictos de abajo
  // pueden ser correctos. Sin una casilla propia, una falla de aislamiento se lee como
  // el peor diagnóstico posible y manda a editar la prosa de advisors que están sanos.
  // Es EXACTAMENTE el error del comentario de arriba, un nivel más arriba.
  if (f.some((x) => /el corral se escapó/.test(x))) return 'fuga';
  if (f.some((x) => /(?:^|: )INESTABLE/.test(x))) return 'inestable';
  // Los ARTEFACTOS (engram, CAPTURAS, contaminación del corral, tool MCP que no se llamó, el renglón
  // Veredicto del validador de stories) tampoco son criterio: el revisor puede haber razonado bien y
  // fallar la plomería del reporte. Va último y exige que TODAS las fallas sean de esa familia — con
  // una sola falla de criterio, gana criterio.
  if (f.every((x) => /engram\(|CAPTURAS|CONTAMINACIÓN|NO se llamó|renglón Veredicto/.test(x))) return 'artefactos';
  return 'criterio';
}

/**
 * Relee un reporte ya escrito y lo cuenta con el desglose nuevo. Sirve para dos cosas: leer los
 * reportes VIEJOS sin volver a correr los revisores (que cuestan tiempo y plata), y ejercer la
 * clasificación sin lanzar un solo LLM.
 */
function reclasificar(archivo, opts = {}) {
  let d;
  try { d = JSON.parse(fs.readFileSync(archivo, 'utf8')); }
  catch (e) { console.error(`no pude leer ${archivo}: ${e.message}`); return 1; }
  const r = d.results || {};
  const c = { criterio: [], inestable: [], error: [], fuga: [], artefactos: [] };
  // 🔴 PLOMERÍA: un rojo que NO habla del juicio del revisor —el corral se escapó, o
  // la corrida no terminó— no puede arrastrar a los contadores de paridad y de regresión: un solo
  // hecho (muchas fugas del lado claude) inflaría TRES números (de criterio, de paridad rota y de
  // regresiones). Contar una vez lo que pasó una vez.
  const esPlomeria = (v) => ['fuga', 'error'].includes(claseDeVeredicto(v));
  const juicioOk = (v) => !v || v.pass !== false || esPlomeria(v);
  let paridadReal = 0, paridadRuido = 0, paridadPlomeria = 0;
  for (const [key, caso] of Object.entries(r)) {
    for (const [tool, v] of Object.entries(caso.tools || {})) {
      const cl = claseDeVeredicto(v);
      if (cl !== 'ok') c[cl].push({ key, tool, regla: caso.rule || null, tipo: caso.type, flags: v.flags });
    }
    const a = caso.tools && caso.tools.claude, b = caso.tools && caso.tools.codex;
    if (a && b && !a.skipped && !b.skipped && a.pass !== b.pass) {
      const rojo = a.pass ? b : a;
      if (esPlomeria(rojo)) paridadPlomeria++;
      else if (claseDeVeredicto(rojo) === 'inestable') paridadRuido++;
      else paridadReal++;
    }
  }
  // Regresiones vs la línea de base, con la misma exclusión: una fuga no es una regresión del
  // revisor. Se listan aparte para que no desaparezcan en silencio.
  let regresiones = 0, regresionesNoEvaluables = 0;
  if (fs.existsSync(BASELINE_FILE)) {
    try {
      const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).cases || {};
      for (const [key, wasPass] of Object.entries(base)) {
        const now = r[key] && r[key].tools && r[key].tools.claude;
        if (!wasPass || !now || now.skipped) continue;
        if (now.pass) continue;
        if (esPlomeria(now)) regresionesNoEvaluables++; else regresiones++;
      }
    } catch (_) { /* baseline ilegible: se informa como 0, el archivo lo dice */ }
  }

  const failed = c.criterio.length + c.inestable.length + c.error.length + c.fuga.length + c.artefactos.length;
  console.log(`${archivo}\n  ejecución ${d.ts} · ${Object.keys(r).length} casos\n`);
  console.log(`🔴 CRITERIO — el revisor razona mal (se arregla en su prosa): ${c.criterio.length}`);
  for (const x of c.criterio) console.log(`     ${x.tool.padEnd(7)} ${x.key}  [${x.regla || 'artefactos'}] ${x.tipo}`);
  console.log(`\n⚠  INESTABLES — contesta distinto entre ejecuciones (se rediseña el CASO): ${c.inestable.length}`);
  for (const x of c.inestable) console.log(`     ${x.tool.padEnd(7)} ${x.key}  flags=${JSON.stringify(x.flags)}`);
  if (c.fuga.length) {
    console.log(`\n🚧 FUGAS DEL CORRAL — la ejecución no quedó aislada; NO dice nada del criterio: ${c.fuga.length}`);
    const porTool = c.fuga.reduce((m, x) => (m[x.tool] = (m[x.tool] || 0) + 1, m), {});
    console.log(`     por herramienta: ${Object.entries(porTool).map(([t, n]) => `${t}=${n}`).join(' · ')}`);
  }
  if (c.artefactos.length) {
    console.log(`\n📄 ARTEFACTOS — el reporte/las memorias no quedaron como se pedía: ${c.artefactos.length}`);
    for (const x of c.artefactos) console.log(`     ${x.tool.padEnd(7)} ${x.key}`);
  }
  if (c.error.length) {
    console.log(`\n💥 ERRORES DE EJECUCIÓN — el advisor no terminó: ${c.error.length}`);
    for (const x of c.error) console.log(`     ${x.tool.padEnd(7)} ${x.key}`);
  }
  console.log(`\nParidad entre herramientas: ${paridadReal} desacuerdo(s) REAL(es) · ${paridadRuido} por inestabilidad`
    + `${paridadPlomeria ? ` · ${paridadPlomeria} por plomería (no dicen nada de la traducción)` : ''}`);
  console.log(`Regresiones vs línea de base: ${regresiones}`
    + `${regresionesNoEvaluables ? ` · ${regresionesNoEvaluables} no evaluables (el caso salió rojo por plomería)` : ''}`);

  if (!opts.escribir) {
    console.log(`\nℹ  esto fue sólo un recuento en pantalla. Para que el reporte —y el aviso de arranque— digan`);
    console.log(`   esto mismo, volvé a correrlo con --write.`);
    return 0;
  }

  // 🔴 --write. El recuento en pantalla no alcanza: el aviso
  // de arranque de cada dev lee los CONTADORES DE ARRIBA del reporte, no su detalle. Mientras esos
  // números no se toquen, el equipo entero sigue viendo los viejos aunque el recuento diga
  // otra cosa. Se reescriben, dejando constancia de que esto fue un RECUENTO y no una medición
  // nueva — un reporte que no dice cómo se produjo es el mismo problema, un paso más adelante.
  const antes = { failed: d.failed, criterio: d.criterio, inestables: d.inestables, paridadReal: d.paridadReal, baselineRegressions: d.baselineRegressions };
  // El recuento respeta lo que la corrida original NO pudo medir: reclasificar un
  // reporte de una corrida y una herramienta no puede resucitar un `inestables: 0` que ya era
  // "no miré". Se deriva de `tool`/`runs`, que el reporte trae desde siempre.
  const nm = rubrosNoMedidos({ tool: d.tool, runs: d.runs });
  const midioInest = nm.inestables === null, midioPar = nm.paridad === null;
  delete d.no_medido;
  Object.assign(d, {
    failed,
    criterio: c.criterio.length,
    inestables: midioInest ? c.inestable.length : null,
    erroresDeCorrida: c.error.length,
    fugas: c.fuga.length,
    artefactos: c.artefactos.length,
    parityBreaks: midioPar ? paridadReal + paridadRuido + paridadPlomeria : null,
    paridadReal: midioPar ? paridadReal : null,
    paridadPorInestabilidad: midioPar ? paridadRuido : null,
    paridadPorPlomeria: midioPar ? paridadPlomeria : null,
    ...(midioInest && midioPar ? {} : { no_medido: {
      ...(midioInest ? {} : { inestables: nm.inestables }),
      ...(midioPar ? {} : { paridad: nm.paridad }),
    } }),
    baselineRegressions: regresiones,
    regresionesNoEvaluables,
    recuento: {
      ts: new Date().toISOString(),
      motivo: 'recuento con el desglose nuevo (fuga/artefactos) — NO es una medición nueva: '
        + 'los veredictos son los de la ejecución original',
      antes,
    },
  });
  fs.writeFileSync(archivo, JSON.stringify(d, null, 2) + '\n');
  console.log(`\n✍️  reporte reescrito: ${archivo}`);
  console.log(`   antes: rojos=${antes.failed} criterio=${antes.criterio} paridad=${antes.paridadReal ?? 'no medida'} regresiones=${antes.baselineRegressions}`);
  console.log(`   ahora: rojos=${failed} criterio=${c.criterio.length} fugas=${c.fuga.length} artefactos=${c.artefactos.length}`
    + ` inestables=${midioInest ? c.inestable.length : 'no medido'} paridad=${midioPar ? paridadReal : 'no medida'} regresiones=${regresiones}`);
  return 0;
}

/** Autotest de la clasificación. No lanza un solo advisor: es lógica pura sobre veredictos. */
function selftestClases() {
  const casos = [
    ['un veredicto verde no es un rojo', claseDeVeredicto({ pass: true, failures: [] }) === 'ok'],
    ['ejecuciones mixtas → inestable', claseDeVeredicto({ pass: false, failures: ['INESTABLE: ejecuciones mixtas [true,false,true]'] }) === 'inestable'],
    ['no citó la regla en ninguna ejecución → criterio', claseDeVeredicto({ pass: false, failures: ['no citó SEC-C1 en ninguna ejecución'] }) === 'criterio'],
    ['citó y no debía → criterio', claseDeVeredicto({ pass: false, failures: ['citó SEC-C1 y no debía (3/3)'] }) === 'criterio'],
    ['el advisor no terminó → error de ejecución, no criterio', claseDeVeredicto({ pass: false, failures: ['2/3 ejecuciones con exit!=0 · boom'] }) === 'error'],
    ['inestable gana sobre criterio si están las dos', claseDeVeredicto({ pass: false, failures: ['INESTABLE: ejecuciones mixtas', 'no citó X'] }) === 'inestable'],
    ['🔴 el ERROR DE EJECUCIÓN gana sobre inestable: mixto con una ejecución que no terminó es plomería, no variancia',
      claseDeVeredicto({ pass: false, failures: ['INESTABLE: ejecuciones mixtas', '1/3 ejecuciones con exit!=0 · boom'] }) === 'error'],
    ['un veredicto sin datos no se clasifica como rojo', claseDeVeredicto(null) === 'ok'],
    // Casillas nuevas. 🔴 Los literales de acá salen de reportes REALES, con su
    // prefijo `corrida N: ` incluido — un patrón anclado con `^` no engancha nada.
    ['🔴 la fuga del corral NO es criterio (los 92 del 2026-08-31)',
      claseDeVeredicto({ pass: false, failures: ['ejecución 1: el corral se escapó: la ejecución leyó 5 ruta(s) reales de la máquina'] }) === 'fuga'],
    ['la fuga gana sobre inestable: con el corral roto el veredicto no prueba variancia',
      claseDeVeredicto({ pass: false, failures: ['INESTABLE: ejecuciones mixtas', 'ejecución 2: el corral se escapó: la ejecución leyó 1 ruta(s)'] }) === 'fuga'],
    ['el error de ejecución gana sobre la fuga',
      claseDeVeredicto({ pass: false, failures: ['ejecución 1: el corral se escapó: x', '1/3 ejecuciones con exit!=0 · boom'] }) === 'error'],
    ['una falla de artefactos no es criterio',
      claseDeVeredicto({ pass: false, failures: ['ejecución 2: falta la línea CAPTURAS: obligatoria al cierre del reporte'] }) === 'artefactos'],
    ['la tool MCP que no se llamó es artefactos (y viene SIN prefijo)',
      claseDeVeredicto({ pass: false, failures: ['la tool MCP codebase_memory/search_graph NO se llamó en 1/3 ejecuciones'] }) === 'artefactos'],
    ['🔴 artefactos NO tapa una falla de criterio que venga en el mismo veredicto',
      claseDeVeredicto({ pass: false, failures: ['ejecución 1: engram(x): 0 obs', 'no citó SEC-C1 en ninguna ejecución'] }) === 'criterio'],
    ['INESTABLE también se reconoce con prefijo',
      claseDeVeredicto({ pass: false, failures: ['ejecución 3: INESTABLE: ejecuciones mixtas'] }) === 'inestable'],
    ['el renglón Veredicto con otro estado es artefactos (story 7.3)',
      claseDeVeredicto({ pass: false, failures: ['ejecución 2: el renglón Veredicto: dice «limpio» y el caso espera «hallazgos»'] }) === 'artefactos'],
    ['🔴 el renglón Veredicto NO tapa una falla de criterio del mismo caso',
      claseDeVeredicto({ pass: false, failures: ['ejecución 1: falta el renglón Veredicto: obligatorio al cierre del informe', 'no citó VAL-C1 en ninguna ejecución'] }) === 'criterio'],
  ];
  let bad = 0;
  for (const [n, ok] of casos) { console.log(`${ok ? '✅' : '❌'} selftest-clases: ${n}`); if (!ok) bad++; }
  bad += selftestClasesContraReportesReales();
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-clases: ${casos.length}/${casos.length} verdes + reportes reales`);
  return bad ? 1 : 0;
}

/**
 * 🔴 EL AUTOTEST SE ALIMENTA DE REPORTES REALES, NO DE STRINGS INVENTADOS.
 *
 * Por qué existe esta mitad: la clasificación se hace por GREP sobre el texto de las fallas, y un
 * autotest escrito a mano prueba el grep contra los strings que escribió el mismo que escribió el
 * grep — o sea, no prueba nada. Es el error que este archivo ya documenta arriba (probar sólo el
 * PARSEO con strings fabricados no prueba la PLOMERÍA): con patrones anclados con `^` y mensajes reales
 * con prefijo `corrida N: `, el autotest de arriba —con sus literales inventados sin prefijo—
 * saldría VERDE con el clasificador muerto.
 *
 * Entonces: se barren los reportes que hay en disco y se afirma la propiedad que importa —
 * ninguna fuga del corral puede quedar contada como "el revisor razona mal". Si mañana cambia el
 * texto de un mensaje, esto se pone rojo; el de arriba no.
 */
function selftestClasesContraReportesReales() {
  const archivos = [];
  const viaje = path.join(BENCH_DIR, 'ultimo-examen.json');
  if (fs.existsSync(viaje)) archivos.push(viaje);
  try {
    for (const f of fs.readdirSync(OUT_DIR)) if (f.endsWith('.json')) archivos.push(path.join(OUT_DIR, f));
  } catch (_) { /* .bench puede no existir en un clon limpio */ }

  let vistos = 0, fugas = 0, malClasificadas = 0;
  for (const a of archivos) {
    let d; try { d = JSON.parse(fs.readFileSync(a, 'utf8')); } catch (_) { continue; }
    for (const caso of Object.values(d.results || {})) {
      for (const v of Object.values(caso.tools || {})) {
        if (!v || v.pass !== false) continue;
        vistos++;
        const f = (v.failures || []).map(String);
        if (!f.some((x) => /el corral se escapó/.test(x))) continue;
        fugas++;
        const cl = claseDeVeredicto(v);
        if (cl !== 'fuga' && cl !== 'error') {
          malClasificadas++;
          if (malClasificadas <= 3) console.log(`   ↳ ${path.basename(a)}: una fuga real quedó como "${cl}" — ${f[0].slice(0, 90)}`);
        }
      }
    }
  }
  // 🔴 Cero fugas en disco NO es un verde: significa que esta mitad del autotest no ejerció nada.
  // Un control que se declara satisfecho por falta de datos es el patrón que el banco entero
  // existe para cazar (ver vacuity-audit.js).
  if (!fugas) {
    console.log(`⚠️  selftest-clases: ${archivos.length} reporte(s), ${vistos} rojo(s), NINGUNA fuga — esta mitad no probó nada`);
    return 0;
  }
  const ok = malClasificadas === 0;
  console.log(`${ok ? '✅' : '❌'} selftest-clases (reportes reales): ${fugas} fuga(s) en ${archivos.length} reporte(s), `
    + `${malClasificadas} contada(s) como criterio`);
  return ok ? 0 : 1;
}

/** Autotest de la atribución del corral. Lógica pura: no invoca un solo advisor. */
function selftestCorral() {
  const conRojo = ['engram(advbench-x): 0 obs con el nonce, esperaba ≥1'];
  const casos = [
    ['un rojo con el corral roto se ANOTA con la causa',
      anotarCorralRoto(conRojo, 'advbench-x', 'exit 1')[0].includes('NO es falla de criterio')],
    ['el rojo original se conserva entero (no se reemplaza)',
      anotarCorralRoto(conRojo, 'advbench-x', 'exit 1')[0].startsWith(conRojo[0])],
    ['con el corral sano, el rojo queda TAL CUAL (es criterio de verdad)',
      anotarCorralRoto(conRojo, 'advbench-x', undefined)[0] === conRojo[0]],
    ['sin rojos no se inventa ninguno', anotarCorralRoto([], 'advbench-x', 'exit 1').length === 0],
  ];
  // Los hermanos del corral los trae el paquete que los usa, no el núcleo.
  const conPaquete = mkCorralHermanos([
    { ruta: 'AcmeCorp/Backend/src/AcmeCorpBackend', nombre: 'AcmeCorp' },
    { ruta: 'Zorblax/Backend/src/ZorblaxBackend', nombre: 'Zorblax' },
  ]);
  const sinPaquete = mkCorralHermanos([]);
  try {
    casos.push(
      ['con el paquete, el corral fabrica sus hermanos (anidados, con su plugin)',
        fs.existsSync(path.join(conPaquete, 'AcmeCorp/Backend/src/AcmeCorpBackend', 'AcmeCorpBackendPlugin.cs'))
        && fs.existsSync(path.join(conPaquete, 'Zorblax/Backend/src/ZorblaxBackend', 'ZorblaxBackendPlugin.cs'))],
      ['con el paquete, cada hermano trae su formulario con la base del host',
        fs.readFileSync(path.join(conPaquete, 'AcmeCorp/FrontEnd/acmecorp-ordenes/src/services/ordenes.service.ts'), 'utf8')
          .includes('${pluginApiUrl}/${PLUGIN_NAME}/ordenes')
        && fs.existsSync(path.join(conPaquete, 'Zorblax/FrontEnd/zorblax-ordenes/src/index.tsx'))],
      ['sin el paquete, el corral queda vacío (sin hermanos a la vista, no con los de una máquina)',
        fs.existsSync(sinPaquete) && fs.readdirSync(sinPaquete).length === 0],
    );
  } finally {
    fs.rmSync(conPaquete, { recursive: true, force: true });
    fs.rmSync(sinPaquete, { recursive: true, force: true });
  }
  // Las reglas del ENCIERRO. Se ejercen sin invocar un solo advisor: lo que importa
  // es la FORMA de la regla.
  const reglas = reglasDeCorral();
  const arnes = path.resolve(__dirname, '..', '..');   // el clon donde corre, esté donde esté
  const cubre = (ruta) => reglas.some((r) => {
    const pref = r.slice('Read(/'.length, -'/**)'.length);
    return ruta === pref || ruta.startsWith(`${pref}/`);
  });
  // 🔴 Un encierro que no encierra tiene que GRITAR, no quedarse callado: si el recorrido del
  // home falla, la lista sale vacía y las corridas quedan sueltas sin que nadie se entere — el
  // examen gastaría 5h30 produciendo veredictos que dependen de qué tiene el dev en el disco.
  let gritaSiVacio = false;
  try { reglasDeCorral({ raiz: path.join(os.tmpdir(), `no-existe-${process.pid}`) }); }
  catch (_) { gritaSiVacio = true; }
  casos.push(
    ['si no puede armar el encierro, FALLA en vez de callarse', gritaSiVacio],
    ['se niega ALGO (una lista vacía sería un encierro que no encierra)', reglas.length > 0],
    ['toda regla usa doble barra para la ruta absoluta (con una sola NO aplica, en silencio)',
      reglas.every((r) => r.startsWith('Read(//'))],
    ['ninguna regla es de Glob o Grep (Claude las rechaza: sólo Read cubre las lecturas)',
      reglas.every((r) => r.startsWith('Read('))],
    ['el repo del arnés NO se niega (los advisors leen sus guías por procedimiento)', !cubre(arnes)],
    // 🔴 Contra una raíz FABRICADA, no contra el disco del dev: exigir que exista un repo clonado
    // haría depender el autotest del encierro de qué tenía clonado quien lo corría, exactamente lo
    // que el encierro existe para impedir. Un autotest que cambia según
    // la máquina no mide el encierro: mide el disco.
    ['los OTROS repos del dev SÍ se niegan (raíz fabricada, no el disco de quien corre)',
      (() => {
        const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'corral-selftest-'));
        try {
          const objetivo = path.join(casa, 'Proyectos', 'Totora');
          fs.mkdirSync(objetivo, { recursive: true });
          return reglasDeCorral({ raiz: casa }).some((r) => {
            const pref = r.slice('Read(/'.length, -'/**)'.length);
            return objetivo === pref || objetivo.startsWith(`${pref}/`);
          });
        } finally { fs.rmSync(casa, { recursive: true, force: true }); }
      })()],
    ['el fixture vive fuera del home y no queda alcanzado por ninguna regla',
      !cubre(fs.realpathSync(os.tmpdir()))],
    ['los permitidos declarados quedan todos afuera del deny',
      PERMITIDO_FUERA_DEL_CORRAL.every((p) => !cubre(path.resolve(p)))],
  );
  // 🔴 El aviso del CLI sobre sus PROPIOS permisos. El texto es el REAL capturado
  // en la máquina del examen, no uno inventado: un autotest con literales fabricados sale verde
  // y rojo contra la realidad. Los dos últimos casos son los que impiden
  // que esto se convierta en "ignorar stderr".
  const avisoReal = 'Permission allow rule (' + path.join(os.homedir(), '.claude', 'settings.json')
    + '): Bash(find ' + path.join(os.homedir(), 'Proyectos', 'FRESNO') + '* -type f -name "*.csproj")'
    + ' has a wildcard before the rest of the command, so it also matches any options inserted at'
    + ' that position and approves them without a prompt.';
  const repoAjeno = path.join(os.homedir(), 'Proyectos', 'Totora');
  casos.push(
    ['el aviso del CLI sobre sus propios permisos NO es fuga',
      fugaDelCorral({ stdout: '', stderr: avisoReal }, null).length === 0],
    ['tampoco los 8 juntos, que es el caso real del 2026-08-31',
      fugaDelCorral({ stdout: '', stderr: Array(8).fill(avisoReal).join('\n') }, null).length === 0],
    ['🔴 una fuga DE VERDAD por stderr se sigue viendo (no se ignora stderr entero)',
      fugaDelCorral({ stdout: '', stderr: avisoReal + '\nleyendo ' + repoAjeno + '/src/x.cs' }, null).length === 1],
    ['🔴 una fuga por stdout se sigue viendo',
      fugaDelCorral({ stdout: 'abri ' + repoAjeno + '/a.cs', stderr: '' }, null).length === 1],
    ['una linea que sólo MENCIONA el aviso (sin ser el aviso) no queda exenta',
      fugaDelCorral({ stdout: 'el advisor dijo: Permission allow rule ... y leyo ' + repoAjeno + '/b.cs', stderr: '' }, null).length === 1],
  );
  // El aviso de sospecha del chequeo de vida. Es una línea de texto, pero decide si
  // alguien le edita la prosa a un revisor sano: los rojos que da el modo son variación.
  const susp = avisoDeSospecha(true, ['deftr-c1-deuda-fantasma']);
  casos.push(
    ['el chequeo de vida con rojos AVISA que es sospecha, no veredicto',
      !!susp && susp.includes('SOSPECHA, no un veredicto')],
    ['…y da el comando de confirmación CON el caso adentro',
      !!susp && susp.includes('--runs 3 --only deftr-c1-deuda-fantasma')],
    ['el chequeo de vida en VERDE no dice nada (un aviso que sale siempre se ignora)',
      avisoDeSospecha(true, []) === null],
    ['🔴 una ejecución NORMAL con rojos NO lo dice: ahí los rojos ya son de 3 ejecuciones',
      avisoDeSospecha(false, ['x']) === null],
  );
  // Media pareja EN LAS DOS DIRECCIONES. El caso de la mitad que grita es el que cubre al
  // revisor muerto: sin él, un revisor muerto sale verde y nadie lo denuncia.
  const cN = { canario: true, type: 'must-not-flag' };
  const cF = { canario: true, type: 'must-flag' };
  casos.push(
    ['pareja completa → no se denuncia', mitadFaltante({ cases: [cF, cN] }) === null],
    ['falta el gemelo LIMPIO → se denuncia', (mitadFaltante({ cases: [cF] }) || {}).falta === 'must-not-flag'],
    ['🔴 falta el gemelo que GRITA → se denuncia (un revisor muerto saldría verde)',
      (mitadFaltante({ cases: [cN] }) || {}).falta === 'must-flag'],
    ['un revisor SIN canario no cae acá (lo denuncia el control de al lado)',
      mitadFaltante({ cases: [{ type: 'must-flag' }] }) === null],
  );
  let bad = 0;
  for (const [n, ok] of casos) { console.log(`${ok ? '✅' : '❌'} selftest-sandbox: ${n}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-sandbox: ${casos.length}/${casos.length} verdes`);
  return bad ? 1 : 0;
}

/** Autotest de la variancia declarada. Lógica pura: no invoca un solo advisor. */
function selftestVarianza() {
  const D = (o) => ({ varianza_declarada: Object.assign({ piso: 2, medido: '2/3', fecha: '2026-08-25', motivo: 'variancia de juicio medida' }, o) });
  const casos = [
    ['sin declaración, no aplica (la unanimidad sigue siendo el default)',
      varianzaAplicable({}, 'claude') === null],
    ['una declaración sin motivo NO vale — declarar exige escribir por qué',
      varianzaAplicable(D({ motivo: '' }), 'claude') === null],
    ['una declaración sin el ratio medido NO vale',
      varianzaAplicable(D({ medido: '' }), 'claude') === null],
    ['una declaración sin piso NO vale (sería un interruptor, no un piso)',
      varianzaAplicable({ varianza_declarada: { motivo: 'x', medido: '2/3' } }, 'claude') === null],
    ['la declaración de una herramienta no cubre a la otra',
      varianzaAplicable(D({ tool: 'claude' }), 'codex') === null
      && varianzaAplicable(D({ tool: 'claude' }), 'claude') !== null],
    ['"ambas" cubre las dos', varianzaAplicable(D({ tool: 'ambas' }), 'codex') !== null],
    ['el piso viaja en la declaración', (varianzaAplicable(D({ piso: 3 }), 'claude') || {}).piso === 3],
    // 🔴 EL PISO es la propiedad de seguridad del mecanismo: sin él, declarar sería silenciar.
    ['sobre el piso pasa (2 de 3 aciertos, piso 2)',
      veredictoMixto([true, false, true], true, { piso: 2 }).ok === true],
    ['🔴 BAJO el piso es ROJO — una degradación de 2/3 a 1/3 sigue gritando',
      veredictoMixto([true, false, false], true, { piso: 2 }).motivo === 'degradó'],
    ['sin declaración, mixto sigue siendo INESTABLE (la unanimidad no se relaja sola)',
      veredictoMixto([true, false, true], true, null).motivo === 'inestable'],
    ['en must-not-flag los aciertos son las ejecuciones que NO marcaron',
      veredictoMixto([false, true, false], false, { piso: 2 }).aciertos === 2],
    ['un piso de 3 sobre 3 aciertos parciales NO pasa (el piso lo fija la declaración)',
      veredictoMixto([true, false, true], true, { piso: 3 }).ok === false],
    ['🔴 con una ejecución que NO TERMINÓ la declaración no aplica — declarar sobre muestra contaminada sería tapar plomería',
      veredictoMixto([true, false, true], true, { piso: 2 }, true).motivo === 'contaminado'],
  ];
  let bad = 0;
  for (const [n, ok] of casos) { console.log(`${ok ? '✅' : '❌'} selftest-varianza: ${n}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-varianza: ${casos.length}/${casos.length} verdes`);
  return bad ? 1 : 0;
}

// Modos baratos: se resuelven ANTES de tocar un solo advisor.
// Los autotests son del examen del núcleo: con --pack devolverían su resultado como si fuera el del paquete. Se mira acá,
// antes de que cualquiera de ellos salga, y por prefijo (`--selftest-*`): un autotest nuevo queda adentro sin tocar esto.
{
  const autotest = PACK_PEDIDO && argv.find((f) => f.startsWith('--selftest') || f === '--check-apps-off' || f === '--reclassify');
  if (autotest) { console.error(`--pack no se combina con ${autotest}: es un autotest del examen del núcleo`); process.exit(2); }
}
if (process.argv.includes('--selftest-variance')) process.exit(selftestVarianza());
if (process.argv.includes('--selftest-sandbox')) process.exit(selftestCorral());
if (process.argv.includes('--selftest-classes')) process.exit(selftestClases());
{
  const i = process.argv.indexOf('--reclassify');
  if (i >= 0 && !PACK_PEDIDO) {   // con --pack, main() lo rechaza
    const arg = process.argv[i + 1];
    const archivo = (arg && !arg.startsWith('--')) ? arg : path.join(__dirname, '.bench', 'advisors-both.json');
    process.exit(reclasificar(archivo, { escribir: process.argv.includes('--write') }));
  }
}

async function main() {
  if (argv.includes('--selftest-mcp')) return selftestMcp();
  if (argv.includes('--selftest-retro')) return selftestRetro();
  if (argv.includes('--check-apps-off')) return checkAppsOff();
  if (PACK && PACK.error) { console.error(PACK.error); return 2; }
  // de dónde salen los revisores, por stderr (la salida de --list la leen otros guiones); sin la carpeta, frena con su motivo
  if (!PACK && !argv.includes('--list')) {
    if (!fs.existsSync(AGENTS_DIR)) {
      console.error(`advisor-runner: no encuentro la carpeta de los revisores ${AGENTS_DIR} (de ${AGENTS_ORIGEN}); TYCON_AGENTS_DIR elige otra`);
      return 2;
    }
    console.error(`advisor-runner: los revisores salen de ${AGENTS_DIR} (de ${AGENTS_ORIGEN})`);
  }
  const casesDir = PACK ? PACK.casesDir : CASES_DIR;
  if (!fs.existsSync(casesDir)) { console.error(`sin casos: ${casesDir}`); return 1; }
  const archivosDeCasos = fs.readdirSync(casesDir).filter((f) => f.endsWith('.json')).sort();
  const suites = archivosDeCasos.map((f) => JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8')));
  if (PACK) {
    const mal = suites.map((s, i) => suiteDePaqueteProblema(s, path.join(casesDir, archivosDeCasos[i]))).find(Boolean);
    if (mal) { console.error(mal); return 2; }
    // el veredicto de cada caso se guarda por `advisor::id`: con dos casos de la misma clave (en un archivo o en dos), el
    // segundo pisaría al primero y un rojo quedaría tapado por un verde
    const claves = suites.flatMap((s) => s.cases.map((c) => `${s.advisor}::${c.id}`));
    const repetidas = [...new Set(claves.filter((k, i) => claves.indexOf(k) !== i))];
    if (repetidas.length) { console.error(`--pack: casos con el mismo revisor y el mismo id: ${repetidas.join(', ')}; cada caso necesita su propio id (el veredicto de uno pisaría al del otro)`); return 2; }
    const sinAgente = [...new Set(suites.map((s) => s.advisor))].filter((a) => !fs.existsSync(advisorFile(a)));
    if (sinAgente.length) { console.error(`--pack: casos de un revisor sin su .md en ${PACK.agentsDir}: ${sinAgente.join(', ')}`); return 2; }
    const informe = JSON_OUT || path.join(OUT_DIR, nombreDeReporte({ tool: TOOL, only: ONLY, vida: VIDA, prefijo: PACK.reportPrefix }).nombre);
    console.log(`paquete: ${PACK.name} · agentes: ${PACK.agentsDir} · casos: ${PACK.casesDir} · informe: ${informe}`);
  }
  retroGuard(suites); // corre SIEMPRE, también con --only: un caso fuera del corral no corre nunca

  // 🔴 UN REVISOR SIN CANARIO NO SE CHEQUEA, Y ESO SE DICE. El chequeo de vida corre
  // sólo los casos marcados: un revisor nuevo —o uno al que le borraron la marca— saldría del
  // examen SIN un solo caso y la corrida cerraría en verde, que es el modo de falla que todo este
  // banco existe para evitar. No bloquea (arrancar bloqueando a todo el equipo es la vía rápida a
  // que alguien lo apague), pero grita y se cuenta; un hueco declarado en el propio archivo de
  // casos (`canario_ausente`) sale como deuda con motivo, no como silencio.
  if (VIDA) {
    const sinCanario = suites.filter((s) => !s.cases.some((c) => c.canario === true));
    const declarados = sinCanario.filter((s) => s.canario_ausente);
    const mudos = sinCanario.filter((s) => !s.canario_ausente);
    if (declarados.length) {
      console.log(`ℹ  ${declarados.length} revisor(es) sin canario, CON motivo declarado:`);
      for (const s of declarados) console.log(`     · ${s.advisor}: ${s.canario_ausente}`);
    }
    if (mudos.length) {
      console.log(`🔴 ${mudos.length} revisor(es) SIN canario y SIN motivo — no los chequea nadie:`);
      for (const s of mudos) console.log(`     · ${s.advisor}  → marcá un par con "canario": true, o declará "canario_ausente"`);
    }
    // 🔴 MEDIA PAREJA NO ES UNA PAREJA. Un canario que sólo prueba "grita cuando tiene que gritar"
    // deja sin cubrir la otra mitad —que se calle cuando no hay nada—, y un revisor que grita
    // siempre es tan inútil como uno mudo: se lo termina ignorando, que es como muere un control.
    // Sin esta línea, un revisor con media pareja pasaría en silencio (y le tocaría justo al de
    // evidencia de runtime, el único cuyo veredicto alimenta un candado).
    const mediaPareja = suites.filter((s) => mitadFaltante(s));
    if (mediaPareja.length) {
      console.log(`⚠️  ${mediaPareja.length} revisor(es) con MEDIA pareja — falta una de las dos mitades:`);
      for (const s of mediaPareja) {
        const m = mitadFaltante(s);
        console.log(`     · ${s.advisor} [${m.texto}]${s.canario_media_pareja ? `: ${s.canario_media_pareja}` : `  → falta un caso \`${m.falta}\` marcado canario`}`);
      }
    }
    const conCanario = suites.length - sinCanario.length;
    console.log(`chequeo de vida: ${conCanario}/${suites.length} revisores con canario`
      + `${mediaPareja.length ? ` (${mediaPareja.length} con media pareja)` : ''}`);
  }
  if (LIST) {
    // 🔴 `--list` tiene que listar LO QUE ESTA CORRIDA CORRERÍA, no el catálogo entero. Con
    // `--liveness` mostraría los 99 casos y el modo sólo corre 53: un ensayo previo que miente sobre
    // el alcance es peor que no tenerlo, porque se usa justamente para decidir si vale la pena
    // gastar la corrida.
    let n = 0;
    for (const s of suites) for (const c of s.cases) {
      if (VIDA && c.canario !== true) continue;
      if (ONLY.length && !ONLY.some((o) => `${s.advisor}::${c.id}`.includes(o))) continue;
      n++;
      console.log(`${s.advisor} :: ${c.id} [${c.type} → ${c.rule || 'artefactos'}] tools=${(c.tools || ['claude', 'codex']).join(',')}`);
    }
    console.log(`— ${n} caso(s)${VIDA ? ' (chequeo de vida: sólo los canarios)' : ''}`);
    // con --pack, listar cero casos es el mismo error que correrlos: el `--only` no coincide con nada
    if (PACK && !n) { console.error(`--pack: ningún caso de ${PACK.casesDir} queda para correr con --only ${ONLY.join(',')}`); return 2; }
    return 0;
  }

  const tools = TOOL === 'both' ? ['claude', 'codex'] : [TOOL];
  const jobsList = [];
  for (const s of suites) for (const c of s.cases) {
    const key = `${s.advisor}::${c.id}`;
    if (ONLY.length && !ONLY.some((o) => key.includes(o))) continue;
    if (VIDA && c.canario !== true) continue;   // el chequeo de vida corre SÓLO el par canario
    const caseTools = c.tools || ['claude', 'codex'];
    for (const t of tools) jobsList.push({ suite: s, caseDef: c, tool: t, key, excluded: !caseTools.includes(t) });
  }
  const llmRuns = jobsList.filter((j) => !j.excluded).length * RUNS;
  // un examen de paquete que no corre ningún caso (un `--only` que no coincide) no es verde: frena
  if (PACK && !llmRuns) { console.error(`--pack: ningún caso de ${PACK.casesDir} queda para correr${ONLY.length ? ` con --only ${ONLY.join(',')}` : ''}`); return 2; }
  console.log(`advisor-bench: ${jobsList.length} casos·herramienta × ${RUNS} ejecuciones = ${llmRuns} invocaciones LLM (jobs=${JOBS})`);
  // Con los hooks apagados dentro de las corridas, el servidor de memoria lo levanta el banco.
  if (jobsList.some((j) => j.caseDef.expect_engram || j.caseDef.expect_mcp)) asegurarMemoriaViva();

  const advCache = {};
  const results = {}; // key -> tool -> verdict
  // Precargar SOLO los advisors que esta corrida va a ejecutar: con --only, exigir el profile
  // de una suite que ni se corre aborta el run entero con un error que no tiene nada que ver
  // con lo que se pidió.
  const advisorsEnJuego = new Set(jobsList.filter((j) => !j.excluded).map((j) => j.suite.advisor));
  for (const advisor of advisorsEnJuego) {
    advCache[advisor] = advisorParts(advisor);
    if (tools.includes('codex')) ensureCodexProfile(advisor);
  }
  for (const s of suites) if (s.engram_cleanup && advisorsEnJuego.has(s.advisor)) ensureCorral(s.engram_cleanup);

  await pool(jobsList, async (j) => {
    const { suite, caseDef, tool, key } = j;
    results[key] = results[key] || { type: caseDef.type, rule: caseDef.rule, asymmetry: caseDef.asymmetry || null, tools: {} };
    if (j.excluded) {
      results[key].tools[tool] = caseDef.asymmetry
        ? { skipped: true }
        : { pass: false, failures: ['excluido de esta herramienta SIN asimetría declarada'] };
      return;
    }
    if (caseDef.expect_mcp && !mcpServerAvailable(caseDef.expect_mcp.server)) {
      // salteo CON CONSTANCIA: sin el server instalado, ni verde que miente ni rojo sin señal
      results[key].tools[tool] = { skipped: true, skipped_mcp: caseDef.expect_mcp.server };
      console.log(`⏭️  [${tool}] ${key} SALTEADO con constancia: server MCP "${caseDef.expect_mcp.server}" no instalado en esta máquina (command no está en PATH)`);
      return;
    }
    if (caseDef.expect_engram && !binAvailable('engram')) {
      // mismo criterio para la verificación por CLI: sin binario engram no hay aserción honesta
      results[key].tools[tool] = { skipped: true, skipped_mcp: 'engram-cli' };
      console.log(`⏭️  [${tool}] ${key} SALTEADO con constancia: el CLI "engram" no está en PATH (la aserción expect_engram no se puede verificar)`);
      return;
    }
    let verdictExtra = null;
    const runs = [];
    for (let n = 0; n < RUNS; n++) runs.push(await runOnce(tool, suite.advisor, advCache[suite.advisor], caseDef, suite));
    const flags = runs.map((r) => r.flagged);
    const errs = runs.filter((r) => r.exit !== 0);
    const failures = [];
    if (errs.length) failures.push(`${errs.length}/${RUNS} ejecuciones con exit!=0 · ${errs[0].tail || ''}`);
    if (caseDef.expect_mcp) {
      const misses = runs.filter((r) => r.mcpCalled === false).length;
      if (misses) failures.push(`la tool MCP ${caseDef.expect_mcp.server}/${caseDef.expect_mcp.tool} NO se llamó en ${misses}/${RUNS} ejecuciones — veredicto por un camino no declarado (4b)`);
    }
    if (caseDef.rule) {
      // contrato clásico: presencia/ausencia del rule ID, con unanimidad
      const want = caseDef.type === 'must-flag';
      const unanimous = flags.every((f) => f === flags[0]);
      if (!unanimous) {
        const v = varianzaAplicable(caseDef, tool);
        const vd = veredictoMixto(flags, want, v, errs.length > 0);
        const aciertos = vd.aciertos;
        if (vd.ok) {
          // No es rojo: es variancia DECLARADA, con piso. Se ve en el reporte y en la consola.
          declaradas.push(`${key} [${tool}] ${aciertos}/${flags.length} (piso ${v.piso}, medido ${v.medido})`);
          verdictExtra = { varianza: { aciertos, de: flags.length, piso: v.piso, medido: v.medido } };
        } else if (vd.motivo === 'contaminado') {
          failures.push(`ejecuciones mixtas ${JSON.stringify(flags)} CON ejecuciones que no terminaron — la muestra está contaminada: primero se arregla por qué no termina, y recién ahí se juzga el criterio`);
        } else if (vd.motivo === 'degradó') {
          failures.push(`DEGRADÓ bajo el piso declarado: ${aciertos}/${flags.length} aciertos, el piso es ${v.piso} (medido ${v.medido} el ${v.fecha}) — esto SÍ es una regresión del criterio`);
        } else {
          failures.push(`INESTABLE: ejecuciones mixtas ${JSON.stringify(flags)} — rediseñar el caso, o DECLARAR la variancia con su piso (varianza_declarada)`);
        }
      } else if (flags[0] !== want)
        failures.push(want ? `no citó ${caseDef.rule} en ninguna ejecución` : `citó ${caseDef.rule} y no debía (${RUNS}/${RUNS})`);
    }
    // contrato por artefactos: cada corrida se asserta sola; mixto = INESTABLE igual
    runs.forEach((r, i) => { if (r.assertFails && r.assertFails.length) failures.push(`ejecución ${i + 1}: ${r.assertFails.join(' · ')}`); });
    if (!caseDef.rule) {
      const oks = runs.map((r) => !(r.assertFails || []).length);
      if (!oks.every((o) => o === oks[0])) failures.push('INESTABLE: ejecuciones mixtas en las aserciones de artefactos — rediseñar el caso, no promediar');
    }
    // 🔴 CLASIFICAR el rojo. El resumen separa dos problemas que se arreglan
    // de formas opuestas: un CRITERIO equivocado (el revisor razona mal — se arregla editando su
    // prosa) y un caso INESTABLE (el revisor cambia de opinión entre corridas — se arregla
    // rediseñando el caso, o aceptando que ese juicio no es determinístico). Un número que mezcla las
    // dos cosas se lee como el peor de los dos, y por eso no se actúa.
    // Un control cuyo veredicto no se puede usar es un control apagado.
    const verdict = { pass: failures.length === 0, failures, flags, ...(verdictExtra || {}) };
    // La clase `varianza-declarada` sólo vale si el caso PASA: un rojo con otras fallas no puede
    // llevar etiqueta de verde declarado.
    verdict.clase = (verdict.pass && verdict.varianza) ? 'varianza-declarada' : claseDeVeredicto(verdict);
    results[key].tools[tool] = verdict;
    console.log(`${verdict.pass ? '✅' : '❌'} [${tool}] ${key} ${caseDef.rule ? `flags=${JSON.stringify(flags)}` : 'artefactos'}${verdict.pass ? '' : ' — ' + failures.join(' | ')}`);
  }, JOBS);
  // Lo que cuenta es lo juzgado, no lo planeado: un examen de paquete en el que ningún caso llegó a juzgarse (por la razón
  // que sea) no es verde.
  if (PACK) {
    const juzgados = Object.values(results).filter((r) => Object.values(r.tools).some((v) => v && !v.skipped && typeof v.pass === 'boolean')).length;
    const planeados = new Set(jobsList.filter((j) => !j.excluded).map((j) => j.key)).size;
    if (juzgados < planeados) { console.error(`--pack: se juzgaron ${juzgados} de ${planeados} caso(s) de ${PACK.casesDir}; un examen de paquete juzga todos los que corre o no es verde`); return 2; }
  }

  // limpieza post-suite: BARRIDO de todo advbench-* (el corral declarado + la basura de
  // sesiones que cada corrida deja con el prefijo del fixture) — best-effort: el nonce aísla igual
  const ranAdvisors = new Set(jobsList.filter((j) => !j.excluded).map((j) => j.suite.advisor));
  const sweep = suites.some((s) => s.engram_cleanup && ranAdvisors.has(s.advisor));
  if (sweep && binAvailable('engram')) {
    try {
      const listado = String(execSync('engram projects list < /dev/null 2>/dev/null', { shell: '/bin/bash', timeout: 30000 }));
      const corral = listado.split('\n').map((l) => (l.match(/^\s*(advbench-[a-z0-9_-]+)\s/) || [])[1]).filter(Boolean);
      for (const p of corral) execSync(`engram delete project ${JSON.stringify(p)} --hard < /dev/null`, { shell: '/bin/bash', timeout: 30000, stdio: 'ignore' });
      if (corral.length) console.log(`🧹 engram: barridos ${corral.length} projects advbench-* (corral + sesiones de fixtures)`);
    } catch (e) { console.log(`⚠️ barrido engram falló (inocuo — el nonce aísla igual): ${String(e.message).slice(0, 120)}`); }
  }

  let failed = 0, parityBreaks = 0, baselineRegressions = 0, skippedMcp = 0;
  let criterio = 0, inestables = 0, erroresDeCorrida = 0, paridadPorInestabilidad = 0;
  // 🔴 Las casillas nuevas se CUENTAN en la corrida en vivo, no sólo en el recuento.
  // Sin esto, `claseDeVeredicto` clasificaría bien y el reporte no lo diría: `fugas` saldría
  // `undefined`, y `bench-notice.js` —que lo lee para denunciar corridas no medidas— no vería nada.
  // O sea: una corrida enteramente escapada del corral se mostraría como si estuviera medida.
  let fugas = 0, artefactos = 0;
  let varianzaDeclarada = 0;
  for (const r of Object.values(results)) for (const t of Object.keys(r.tools))
    if (r.tools[t].clase === 'varianza-declarada') varianzaDeclarada++;
  for (const r of Object.values(results)) for (const t of Object.keys(r.tools))
    if (r.tools[t].skipped_mcp) skippedMcp++;
  for (const r of Object.values(results)) for (const t of Object.keys(r.tools))
    if (r.tools[t].pass === false) {
      failed++;
      if (r.tools[t].clase === 'criterio') criterio++;
      else if (r.tools[t].clase === 'inestable') inestables++;
      else if (r.tools[t].clase === 'error') erroresDeCorrida++;
      else if (r.tools[t].clase === 'fuga') fugas++;
      else if (r.tools[t].clase === 'artefactos') artefactos++;
    }
  if (TOOL === 'both') {
    for (const [key, r] of Object.entries(results)) {
      const a = r.tools.claude, b = r.tools.codex;
      if (a && b && !a.skipped && !b.skipped && a.pass !== b.pass) {
        parityBreaks++;
        // Un desacuerdo entre herramientas donde el lado rojo es INESTABLE no prueba nada sobre la
        // traducción: es la misma moneda cayendo distinto. Se cuenta aparte para que la paridad
        // "real" —las dos herramientas consistentes y en desacuerdo— no quede tapada por el ruido.
        const porRuido = (a.pass ? b : a).clase === 'inestable';
        if (porRuido) paridadPorInestabilidad++;
        console.log(`⚠️ PARIDAD ${porRuido ? 'INESTABLE' : 'ROTA'} ${key}: claude=${a.pass ? 'verde' : 'rojo'} codex=${b.pass ? 'verde' : 'rojo'}`);
      }
    }
  }
  if (BASELINE_MODE === 'write') {
    const snap = {};
    for (const [key, r] of Object.entries(results)) if (r.tools.claude && !r.tools.claude.skipped) snap[key] = r.tools.claude.pass;
    fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ fixed_at: new Date().toISOString(), tool: 'claude', runs: RUNS, cases: snap }, null, 2) + '\n');
    console.log(`📌 Línea de base Claude (advisors) fijada: ${Object.keys(snap).length} casos`);
  } else if (BASELINE_MODE === 'check' && fs.existsSync(BASELINE_FILE)) {
    const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).cases;
    // 🔴 "DESAPARECIÓ" SÓLO TIENE SENTIDO EN UNA CORRIDA COMPLETA. La línea de base
    // tiene los 99 casos; el chequeo de vida corre 53 a propósito. Sin esta distinción, el
    // chequeo de vida llenaría el informe de 46 "casos desaparecidos" que no desaparecieron —
    // un rojo falso. Un caso ausente de una corrida ACOTADA no se juzga: no se midió.
    const corridaCompleta = !VIDA && ONLY.length === 0;
    let noMedidos = 0;
    for (const [key, wasPass] of Object.entries(base)) {
      const now = results[key] && results[key].tools.claude;
      if (wasPass && now && !now.skipped && !now.pass) { baselineRegressions++; console.log(`🔻 REGRESIÓN vs baseline: ${key}`); }
      if (!now) {
        if (corridaCompleta) { baselineRegressions++; console.log(`🔻 caso de la baseline DESAPARECIÓ: ${key}`); }
        else noMedidos++;
      }
    }
    // Y no se pierden en silencio: se dice cuántos quedaron fuera del alcance.
    if (noMedidos) console.log(`ℹ  ${noMedidos} caso(s) de la línea de base fuera del alcance de esta ejecución (no se midieron; no son regresiones)`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 🔴 El nombre lo decide el ALCANCE de la corrida, no sólo `--tool`. Si no, una
  // corrida acotada con `--only` escribiría en el mismo archivo que la foto completa de los 28 y la
  // PISARÍA: el aviso del arranque leería ese archivo fresco con 3 casos y lo mostraría como el estado
  // general, con los otros 25 desaparecidos y sin que nada lo dijera.
  // `--json` explícito sigue mandando: pisar la foto completa se puede, hay que pedirlo.
  // el informe de un paquete lleva su propio prefijo: el aviso del arranque lee sólo los `advisors-*` (el del núcleo)
  const { nombre, alcance } = nombreDeReporte({ tool: TOOL, only: ONLY, vida: VIDA, prefijo: PACK ? PACK.reportPrefix : undefined });
  const outPath = JSON_OUT || path.join(OUT_DIR, nombre);
  const paridadReal = parityBreaks - paridadPorInestabilidad;

  // 🔴 "NO MEDIDO" NO SE PINTA DE CERO. Con `--liveness` esta corrida hace UNA
  // pasada por caso sobre UNA herramienta, así que la inestabilidad (¿el revisor se contradice
  // entre corridas?) y la paridad (¿las dos herramientas coinciden?) no tienen con qué compararse.
  // Emitir `0` ahí es afirmar "medí y no hay" cuando lo cierto es "no miré" — y el aviso de
  // arranque lo mostraría en cada sesión al lado de los rubros que sí se midieron. El motivo va
  // ADENTRO del reporte, en castellano, para que no haya que saber esto para leerlo.
  const noMedido = rubrosNoMedidos({ tool: TOOL, runs: RUNS });
  const midioInestabilidad = noMedido.inestables === null;
  const midioParidad = noMedido.paridad === null;

  fs.writeFileSync(outPath, JSON.stringify({
    ts: new Date().toISOString(), tool: TOOL, runs: RUNS, alcance, only: ONLY,
    failed, criterio, erroresDeCorrida, fugas, artefactos, varianzaDeclarada,
    inestables: midioInestabilidad ? inestables : null,
    parityBreaks: midioParidad ? parityBreaks : null,
    paridadReal: midioParidad ? paridadReal : null,
    paridadPorInestabilidad: midioParidad ? paridadPorInestabilidad : null,
    ...(midioInestabilidad && midioParidad ? {} : { no_medido: {
      ...(midioInestabilidad ? {} : { inestables: noMedido.inestables }),
      ...(midioParidad ? {} : { paridad: noMedido.paridad }),
    } }),
    baselineRegressions, skippedMcp, results,
  }, null, 2) + '\n');
  // 🔴 El resumen distingue CRITERIO de INESTABILIDAD. Un solo "rojos=N" no permite decidir
  // nada: son problemas opuestos (el mismo caso cayendo distinto entre corridas se arregla
  // rediseñando el caso; el revisor razonando mal, editando su prosa), y un número que los suma
  // se lee como el peor de los dos.
  // La consola dice lo mismo que el reporte: un rubro que esta corrida no pudo medir se nombra
  // "no medido", nunca 0. Si no, el resumen en pantalla sigue mintiendo aunque el
  // archivo diga la verdad — y el resumen es lo que mira quien la corre a mano.
  console.log(
    `\n${failed + parityBreaks + baselineRegressions === 0 ? '✅' : '❌'} rojos=${failed}` +
    ` (criterio=${criterio} · inestables=${midioInestabilidad ? inestables : 'no medido'}${fugas ? ` · 🚧 fugas-del-corral=${fugas}` : ''}` +
    `${artefactos ? ` · artefactos=${artefactos}` : ''}${erroresDeCorrida ? ` · errores-de-corrida=${erroresDeCorrida}` : ''})` +
    ` · paridad rota=${midioParidad ? paridadReal : 'no medida'}${midioParidad && paridadPorInestabilidad ? ` (+${paridadPorInestabilidad} por inestabilidad, no por traducción)` : ''}` +
    ` · regresiones=${baselineRegressions}` +
    `${skippedMcp ? ` · ⏭️ salteados-por-MCP-ausente=${skippedMcp} (constancia, no verde)` : ''}`);
  for (const [rubro, motivo] of Object.entries(noMedido))
    if (motivo) console.log(`   🟡 ${rubro}: NO MEDIDO — ${motivo}`);
  if (varianzaDeclarada) {
    console.log(`   ℹ ${varianzaDeclarada} caso(s) pasaron por VARIANCIA DECLARADA (mayoría sobre su piso, no unanimidad):`);
    for (const d of declaradas) console.log(`      · ${d}`);
  }
  if (criterio) console.log(`   🔴 Lo que hay que MIRAR PRIMERO son los ${criterio} de criterio: el revisor razona mal, y eso se arregla en su prosa.`);
  if (inestables) console.log(`   ⚠ Los ${inestables} inestables son casos que el revisor contesta distinto entre ejecuciones — se rediseña el CASO, no se promedia.`);
  const sospecha = avisoDeSospecha(VIDA, Object.entries(results)
    .filter(([, r]) => r.tools && r.tools[TOOL] && !r.tools[TOOL].skipped && !r.tools[TOOL].pass)
    .map(([k]) => k.split('::').pop()));
  if (sospecha) console.log(sospecha);
  console.log(`reporte: ${outPath}`);
  return failed + parityBreaks + baselineRegressions > 0 ? 1 : 0;
}

module.exports = { AGENTS_DIR, AGENTS_ORIGEN };
if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error(`advisor-runner: ${e.message}`); process.exit(1); });
