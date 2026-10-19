#!/usr/bin/env node
/**
 * workflow-lite.js — runner propio del DSL de la tool Workflow, para correr el pase adversarial
 * (adversarial-verify.workflow.js) bajo CODEX (Etapa G-3 de la migración, decisión del dev
 * 2026-08-22 — guides/decisions/codex-etapa-g-diseno.md Parte 3; doctrina ③b del plan: "sacarlo afuera").
 *
 * Ejecuta EL MISMO archivo .workflow.js que corre la tool Workflow en Claude — el script no se
 * toca (fuente única). Implementa SOLO la superficie que ese script usa:
 *   args (objeto o string JSON — el gotcha ya lo maneja el script) · log(msg) → stderr ·
 *   agent(prompt, {label, phase, schema, agentType, model}) → spawn `codex exec` (null si falla,
 *   como la tool) · parallel(thunks) → pool con errores→null · pipeline(items, s1, s2) → cadena
 *   por item SIN barrera (s2 recibe (resultado, itemOriginal)).
 *
 * Lo que NO imita (declarado en el diseño): resume por runId · journal · budget · workflow()
 * anidado. El `export const meta` del script se neutraliza (el cuerpo corre como función async,
 * donde `export` es ilegal y `return` es legal — mismo contrato que el runtime real).
 *
 * Schema JSON: se exige EN el prompt (salida = solo el JSON) y se parsea con 1 reintento con el
 * error como feedback — la validación es de forma (claves requeridas), no JSON-Schema completa:
 * los consumidores del script filtran Boolean igual que con la tool.
 *
 * 🔴 Un agente muerto no es una respuesta. Cada agente que no contesta queda en `corredor.muertos` con la
 * causa (el último renglón de su error, recortado) y la hora. Si la causa es el tope de uso de Codex no se reintenta y
 * los agentes que faltan no se lanzan: quedan muertos con esa misma causa. El resultado sale con `corredor` y, si el
 * pase quedó no medido (`medido: false`), el comando sale 3 —el archivo de `--out` se escribe igual—.
 *
 * `--agents-dir <carpeta>` (la salida aprobada sin Codex ni Workflow): no lanza nada. Cada agente busca su
 * respuesta en `<carpeta>/<etiqueta>-<huella del pedido>.json`; si no está, deja `.prompt.txt` y `.schema.json`, la
 * anota en `<carpeta>/PEDIDOS.json` y cuenta como muerta («sin respuesta»). La sesión lanza un agente de Claude por
 * pedido, cada uno escribe su respuesta, y se vuelve a correr hasta que no quedan pedidos. El guion es el mismo.
 *
 * Uso:  node workflow-lite.js <script.workflow.js> --args '<json>' [--out <file>] [--agents-dir <carpeta>]
 *       node workflow-lite.js --selftest
 * Env:  TYCON_WFLITE_JOBS (cap de agentes concurrentes, default 4)
 *       TYCON_WFLITE_MODEL_MAP (json label→slug; default desde equivalences.json si existe)
 *       TYCON_WFLITE_AGENT_CMD (SOLO selftest: comando stub que reemplaza a codex)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const JOBS = Math.max(1, parseInt(process.env.TYCON_WFLITE_JOBS || '4', 10));

function modelMap() {
  if (process.env.TYCON_WFLITE_MODEL_MAP) { try { return JSON.parse(process.env.TYCON_WFLITE_MODEL_MAP); } catch (_) {} }
  // equivalences.json del arnés (por lib/harness-path.js: TYCON_GUIDES_DIR o el enlace — story 8.3)
  try {
    const TCG = require('./lib/harness-path.js').rutaArnes();
    const eq = JSON.parse(fs.readFileSync(path.join(TCG, 'build', 'equivalences.json'), 'utf8'));
    // Sin reservas (story 7.29, decisión 23): un modelo que no está en equivalences.json no tiene equivalente y lo
    // dice `slugFor`; antes `fable` caía al de `opus` y escondía la falta.
    return Object.assign({}, eq.models);
  } catch (e) {
    // Un comando sin el arnés lo DICE (story 8.3, AC 5): el mapeo de modelos queda vacío y se sigue, pero no en silencio.
    if (e && e.name === 'RutaArnesError') process.stderr.write(`${e.message} — sin equivalences.json: el mapeo de modelos queda vacío\n`);
    return {};
  }
}

/** pool simple: corre thunks con cap de concurrencia; un throw resuelve null (semántica de la tool) */
async function pool(thunks, jobs) {
  const out = new Array(thunks.length);
  let i = 0;
  async function lane() {
    while (i < thunks.length) {
      const idx = i++;
      try { out[idx] = await thunks[idx](); } catch (_) { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, thunks.length) }, lane));
  return out;
}

function lastJsonObject(text) {
  // el modelo puede rodear el JSON con ruido: se toma el ÚLTIMO objeto {...} parseable
  const s = String(text);
  for (let start = s.lastIndexOf('{'); start >= 0; start = s.lastIndexOf('{', start - 1)) {
    // expandir hacia adelante buscando el cierre balanceado desde este '{'
    let depth = 0;
    for (let j = start; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, j + 1)); } catch (_) { break; } } }
    }
  }
  return null;
}

/** El modo estricto del backend exige `required` = TODAS las claves de properties (error 400
 * textual medido G-3: "required is required ... including every key. Missing 'line'"). Esta
 * transformación hace estricto CUALQUIER schema estilo-tool sin tocar el .workflow.js: las
 * propiedades originalmente opcionales pasan a required PERO nullable (type [T,'null']; si hay
 * enum, null se suma al enum) — la semántica del consumidor no cambia (line ausente ≈ null). */
function toStrictSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = (k === 'properties') ? v : toStrictSchema(v);
  if (out.type === 'object' && out.properties) {
    const origReq = new Set(Array.isArray(schema.required) ? schema.required : []);
    const props = {};
    for (const [k, v] of Object.entries(out.properties)) {
      let pv = toStrictSchema(v);
      if (!origReq.has(k)) {
        pv = Object.assign({}, pv);
        if (typeof pv.type === 'string') pv.type = [pv.type, 'null'];
        else if (Array.isArray(pv.type) && !pv.type.includes('null')) pv.type = pv.type.concat('null');
        if (Array.isArray(pv.enum) && !pv.enum.includes(null)) pv.enum = pv.enum.concat(null);
      }
      props[k] = pv;
    }
    out.properties = props;
    out.required = Object.keys(props);
  }
  return out;
}

function checkShape(obj, schema) {
  if (!obj || typeof obj !== 'object' || !schema || !Array.isArray(schema.required)) return !!obj;
  return schema.required.every((k) => k in obj);
}

function spawnAgent(cmdline, prompt, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const [bin, ...pre] = cmdline;
    // El prompt viaja también por env: codex ya lo trae en su línea de comando y lo ignora; el stub
    // de los tests lo lee de acá para poder verificar QUÉ se le pidió a cada agente (2026-09-17).
    const ch = spawn(bin, pre, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TYCON_WFLITE_PROMPT: prompt } });
    let out = '', err = '';
    const killer = setTimeout(() => ch.kill('SIGKILL'), timeoutMs);
    ch.stdout.on('data', (d) => (out += d));
    ch.stderr.on('data', (d) => (err += d));
    ch.on('close', (code) => { clearTimeout(killer); resolve({ code, out, err }); });
    // Sin el motivo (p. ej. `codex` no instalado: ENOENT) la causa decía «salió -1 sin escribir nada».
    ch.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, out, err: `${err}${err ? '\n' : ''}${(e && e.message) || 'no se pudo lanzar'}` }); });
  });
}

/**
 * El slug de Codex de un modelo (story 7.29, AC 17): un modelo de Claude se traduce con equivalences.json; uno ya
 * traducido (un valor del mapa) pasa tal cual; sin modelo, el del pase de hoy (`DEFAULTS.adversarial.model` de
 * lib/models.js) traducido. Sin equivalente → null: `codex exec` corre sin `-m` (el modelo por defecto de Codex) y se
 * dice por `decir` (la salida de error).
 */
function slugFor(model, models, decir = (t) => process.stderr.write(`${t}\n`)) {
  const map = models || {};
  const pedido = model || require('./lib/models.js').DEFAULTS.adversarial.model;
  if (map[pedido]) return map[pedido];
  if (Object.values(map).includes(pedido)) return pedido;
  decir(`el modelo ${pedido} no tiene equivalente en Codex: uso el modelo por defecto de Codex`);
  return null;
}

// El tope de uso de Codex (o de su proveedor): contra eso no sirve reintentar.
const TOPE_RE = /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b/i;

// Lo que parece una credencial se tapa antes de guardar la causa: el error de un
// proveedor puede repetir la clave o la cabecera con que se lo llamó, y la causa va al resultado de la corrida.
const SECRETO_RE = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]+|AKIA[0-9A-Z]{16})|((?:Authorization:\s*)?(?:Bearer|Basic|Token)\s+|Authorization:\s+|\b(?:x-api-key|api[_-]?key)\s*[=:]\s*)\S+/gi;
const taparSecretos = (t) => String(t).replace(SECRETO_RE, (_m, tok, pre) => (pre ? `${pre}<REDACTED>` : '<REDACTED>'));

const ultimoRenglon = (t) => String(t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';

/**
 * La causa de una muerte: el último renglón no vacío del error (o de la salida, si el error vino vacío), recortado y
 * con las credenciales tapadas.
 */
function causaDe(res) {
  const ultimo = ultimoRenglon(res && res.err) || ultimoRenglon(res && res.out);
  const base = taparSecretos(ultimo) || `salió ${res && res.code !== undefined ? res.code : '?'} sin escribir nada`;
  return base.length > 300 ? `${base.slice(0, 300)}…` : base;
}

/**
 * ¿Murió por el tope de uso? 🔴 Se mira el último renglón del error tal cual (antes de tapar: «Token rate limit» no
 * puede quedar «Token <REDACTED>»), y el de la salida sólo si el error vino vacío. Nunca toda la salida: `codex exec`
 * repite el pedido, y un pedido que habla de «rate limit» hacía pasar por tope cualquier falla (pase adversarial 8.56).
 */
function esTope(res) {
  const err = ultimoRenglon(res && res.err);
  return TOPE_RE.test(err || ultimoRenglon(res && res.out));
}

const horaCorta = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Agentes de Claude por carpeta (`--agents-dir`): la respuesta se lee; si falta, se deja el pedido. */
function makeDirAgent(opts, corredor) {
  const dir = path.resolve(opts.agentsDir);
  fs.mkdirSync(dir, { recursive: true });
  const pendientes = [];
  corredor.pendientes = pendientes;
  const agent = async function agent(prompt, aopts) {
    aopts = aopts || {};
    const label = aopts.label || 'agente';
    const huella = require('crypto').createHash('sha1').update(String(prompt)).digest('hex').slice(0, 12);
    const clave = `${label.replace(/[^A-Za-z0-9_.-]+/g, '_')}-${huella}`;
    const respuesta = path.join(dir, `${clave}.json`);
    const muerto = (causa) => { corredor.muertos.push({ label, causa, hora: horaCorta() }); return null; };
    if (fs.existsSync(respuesta)) {
      let obj = null;
      const raw = fs.readFileSync(respuesta, 'utf8');
      if (!aopts.schema) { const t = raw.trim(); return t || muerto(`respuesta vacía en ${respuesta}`); }
      try { obj = JSON.parse(raw); } catch (e) { return muerto(`respuesta ilegible en ${respuesta}: ${e.message}`); }
      if (obj && checkShape(obj, aopts.schema)) return obj;
      return muerto(`respuesta sin las claves pedidas (${(aopts.schema.required || []).join(', ')}) en ${respuesta}`);
    }
    const promptFile = path.join(dir, `${clave}.prompt.txt`);
    fs.writeFileSync(promptFile, String(prompt));
    const schemaFile = aopts.schema ? path.join(dir, `${clave}.schema.json`) : null;
    if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(aopts.schema, null, 1));
    pendientes.push({ clave, label, phase: aopts.phase || null, model: aopts.model || null, prompt_file: promptFile, schema_file: schemaFile, answer_file: respuesta });
    return muerto(`sin respuesta todavía: pedido en ${promptFile}`);
  };
  agent.cerrar = () => {
    fs.writeFileSync(path.join(dir, 'PEDIDOS.json'), JSON.stringify({ pendientes }, null, 1) + '\n');
  };
  return agent;
}

function makeAgent(opts, corredor) {
  const models = modelMap();
  const seq = { n: 0 };
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wflite-io-'));
  return async function agent(prompt, aopts) {
    aopts = aopts || {};
    const id = ++seq.n;
    const label = aopts.label || `agent-${id}`;
    const stub = process.env.TYCON_WFLITE_AGENT_CMD;
    const muerto = (causa, hora = horaCorta()) => { corredor.muertos.push({ label, causa, hora }); return null; };
    // Con el tope ya visto, no se lanza nada más: se anota con la causa y la hora del tope.
    if (corredor.tope) return muerto(`no se lanzó: ${corredor.tope.causa}`, corredor.tope.hora);
    const slug = slugFor(aopts.model, models);
    // 🔴 Salida estructurada NATIVA de codex (medido G-3, 2026-08-22): la v1 exigía el JSON por
    // prompt y lo pescaba de stdout con un escáner de llaves balanceadas — que se rompe cuando el
    // JSON trae llaves DESBALANCEADAS dentro de strings (los `repro` con snippets de código). Los
    // 12 hunters de la primera corrida real fallaron el parseo JUSTO PORQUE encontraron el bug
    // (sus repros traían código). codex exec tiene los primitivos exactos: --output-schema <file>
    // (el harness fuerza la forma) y -o <file> (el mensaje final SOLO, sin scraping de stdout).
    const outFile = path.join(tmpBase, `out-${id}.txt`);
    const schemaFile = aopts.schema ? path.join(tmpBase, `schema-${id}.json`) : null;
    if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(toStrictSchema(aopts.schema)));
    let causa = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (corredor.tope) break;
      process.stderr.write(`wflite ▸ ${label} (intento ${attempt})\n`);
      let raw;
      let res;
      if (stub) {
        res = await spawnAgent(stub.split(' '), prompt, opts.cwd, opts.timeoutMs);
        raw = res.out;
      } else {
        const cmd = ['codex', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', ...(slug ? ['-m', slug] : []), '-o', outFile];
        if (schemaFile) cmd.push('--output-schema', schemaFile);
        cmd.push(prompt);
        try { fs.rmSync(outFile, { force: true }); } catch (_) {}
        res = await spawnAgent(cmd, prompt, opts.cwd, opts.timeoutMs);
        try { raw = fs.readFileSync(outFile, 'utf8'); } catch (_) { raw = res.out; } // fallback: stdout
      }
      // Un agente que salió con error y no dejó una respuesta usable muere por la causa de SU error (y ahí se mira el
      // tope), aunque haya escrito algo en la salida: `codex exec` puede repetir ahí el pedido.
      const fallo = res.code !== 0;
      const murioPorError = () => {
        causa = causaDe(res);
        if (esTope(res)) {
          corredor.tope = { causa, hora: horaCorta(), label };
          process.stderr.write(`wflite ✖ ${label}: Codex en su tope de uso (${causa}) — no reintento ni lanzo los agentes que faltan\n`);
        }
      };
      if (fallo && !String(raw || '').trim()) { murioPorError(); continue; }
      if (!aopts.schema) { const t = String(raw || '').trim(); if (t && !fallo) return t; if (fallo) murioPorError(); else causa = 'contestó vacío'; continue; }
      let obj = null;
      try { obj = JSON.parse(String(raw).trim()); } catch (_) { obj = lastJsonObject(raw); }
      if (obj && checkShape(obj, aopts.schema)) return obj;
      if (fallo) murioPorError();
      else causa = `contestó sin las claves pedidas (${(aopts.schema.required || []).join(', ')})`;
    }
    // semántica de la tool: agente muerto → null; el guion lo cuenta como lente sin medir o hallazgo sin veredicto
    return muerto(corredor.tope && !causa ? corredor.tope.causa : (causa || 'sin respuesta'));
  };
}

async function runWorkflow(scriptPath, argsValue, opts) {
  let source = fs.readFileSync(scriptPath, 'utf8');
  // neutralizar el export (ilegal dentro de una función): mismo objeto, sin exportar
  source = source.replace(/^export const meta =/m, 'const meta =');
  const corredor = { nombre: opts.agentsDir ? 'agentes-claude' : 'workflow-lite', muertos: [], tope: null };
  const agent = opts.agentsDir ? makeDirAgent(opts, corredor) : makeAgent(opts, corredor);
  const log = (m) => process.stderr.write(`wflite: ${m}\n`);
  const parallel = (thunks) => pool(thunks, JOBS);
  const pipelineFn = async (items, s1, s2) => {
    const thunks = items.map((item, idx) => async () => {
      const r1 = await s1(item, idx);
      return s2 ? s2(r1, item, idx) : r1;
    });
    return pool(thunks, JOBS);
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('args', 'log', 'agent', 'parallel', 'pipeline', source);
  const result = await fn(argsValue, log, agent, parallel, pipelineFn);
  if (typeof agent.cerrar === 'function') agent.cerrar();
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    result.corredor = { nombre: corredor.nombre, muertos: corredor.muertos, tope: corredor.tope,
      ...(corredor.pendientes ? { pedidos_pendientes: corredor.pendientes.length, pedidos: path.join(path.resolve(opts.agentsDir), 'PEDIDOS.json') } : {}) };
  }
  return result;
}

// ---------- selftest (offline: agente stub, cero LLM) ----------
async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-wflite-'));
  // stub de agente: contesta un JSON fijo válido para CUALQUIER schema de este test
  const stubPath = path.join(tmp, 'stub.js');
  fs.writeFileSync(stubPath, `console.log(JSON.stringify({ eco: 'ok', items: ['a'] }));`);
  process.env.TYCON_WFLITE_AGENT_CMD = `${process.execPath} ${stubPath}`;

  const wf = path.join(tmp, 'toy.workflow.js');
  fs.writeFileSync(wf, `
export const meta = { name: 'toy', description: 'selftest', phases: [] }
const A = (typeof args === 'string') ? JSON.parse(args) : (args || {})
log('arranca con n=' + A.n)
const uno = await agent('primero', { schema: { required: ['eco'] } })
const dos = await parallel([
  () => agent('p1', { schema: { required: ['eco'] } }),
  () => { throw new Error('me muero') },
])
const tres = await pipeline([10, 20], (x) => x + 1, (r, orig) => ({ r, orig }))
return { unoEco: uno && uno.eco, dosNulls: dos.filter((x) => x === null).length, tres, n: A.n }
`);
  const r1 = await runWorkflow(wf, { n: 7 }, { cwd: tmp, timeoutMs: 15000 });
  const r2 = await runWorkflow(wf, JSON.stringify({ n: 9 }), { cwd: tmp, timeoutMs: 15000 });
  const checks = [
    ['export const meta se neutraliza y el script corre', !!r1],
    ['agent con schema devuelve el objeto parseado', r1.unoEco === 'ok'],
    ['parallel: un throw resuelve null (semántica de la tool)', r1.dosNulls === 1],
    ['pipeline: s2 recibe (resultado, itemOriginal)', JSON.stringify(r1.tres) === JSON.stringify([{ r: 11, orig: 10 }, { r: 21, orig: 20 }])],
    ['args como OBJETO llega', r1.n === 7],
    ['args como STRING JSON llega (el gotcha de la tool)', r2.n === 9],
  ];
  // el schema-shape rechaza basura: stub que emite JSON sin las claves requeridas → null tras reintentos
  fs.writeFileSync(stubPath, `console.log(JSON.stringify({ otra: 1 }));`);
  const wf2 = path.join(tmp, 'toy2.workflow.js');
  fs.writeFileSync(wf2, `return { r: await agent('x', { schema: { required: ['eco'] } }) }`);
  const r3 = await runWorkflow(wf2, {}, { cwd: tmp, timeoutMs: 15000 });
  checks.push(['schema no cumplido tras reintento → null (no basura)', r3.r === null]);
  // toStrictSchema: la regla del 400 medido (required = TODAS las claves; opcionales → nullable)
  const strict = toStrictSchema({ type: 'object', additionalProperties: false,
    properties: { a: { type: 'string' }, op: { type: 'integer' }, en: { type: 'string', enum: ['x', 'y'] } },
    required: ['a'] });
  checks.push(['toStrictSchema: required incluye TODAS las claves', JSON.stringify(strict.required.slice().sort()) === JSON.stringify(['a', 'en', 'op'])]);
  checks.push(['toStrictSchema: opcional simple → nullable', JSON.stringify(strict.properties.op.type) === JSON.stringify(['integer', 'null'])]);
  checks.push(['toStrictSchema: opcional con enum → null sumado al enum', strict.properties.en.enum.includes(null)]);
  checks.push(['toStrictSchema: el requerido original queda intacto', strict.properties.a.type === 'string']);
  fs.rmSync(tmp, { recursive: true, force: true });
  let bad = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-wflite: ${name}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-wflite: ${checks.length}/${checks.length} verdes`);
  return bad ? 1 : 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();
  const scriptPath = argv[0];
  if (!scriptPath || !fs.existsSync(scriptPath)) { console.error('uso: workflow-lite.js <script.workflow.js> --args <json> [--out <file>]'); return 1; }
  const ai = argv.indexOf('--args');
  const rawArgs = ai >= 0 ? argv[ai + 1] : '{}';
  let argsValue; try { argsValue = JSON.parse(rawArgs); } catch (_) { argsValue = rawArgs; }
  const oi = argv.indexOf('--out');
  const di = argv.indexOf('--agents-dir');
  const agentsDir = di >= 0 ? argv[di + 1] : null;
  if (di >= 0 && !agentsDir) { console.error('workflow-lite: --agents-dir sin carpeta'); return 1; }
  const cwd = (argsValue && argsValue.repo) || process.cwd();
  const result = await runWorkflow(scriptPath, argsValue, { cwd, timeoutMs: 20 * 60 * 1000, agentsDir });
  const json = JSON.stringify(result, null, 1);
  if (oi >= 0) { fs.writeFileSync(argv[oi + 1], json + '\n'); console.log(`wflite: resultado → ${argv[oi + 1]}`); }
  else console.log(json);
  // Un pase no medido no sale 0: el archivo se escribió, pero nadie lo lee verde por el código de salida.
  if (result && result.medido === false) {
    const c = result.corredor || {};
    if (c.tope) process.stderr.write(`wflite: Codex en su tope de uso desde las ${c.tope.hora} (${c.tope.causa}).\n`);
    if (c.pedidos_pendientes) process.stderr.write(`wflite: quedan ${c.pedidos_pendientes} pedido(s) para agentes de Claude en ${c.pedidos}\n`);
    process.stderr.write(`${result.aviso || 'wflite: pase NO MEDIDO'}\n`);
    return 3;
  }
  return 0;
}

module.exports = { slugFor };

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`workflow-lite: ${e.message}`); process.exit(1); });
}
