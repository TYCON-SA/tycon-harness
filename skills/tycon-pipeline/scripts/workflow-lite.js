#!/usr/bin/env node
/**
 * workflow-lite.js — runner propio del DSL de la tool Workflow, para correr el pase adversarial
 * (adversarial-verify.workflow.js) bajo CODEX, donde la tool Workflow no existe: el guion
 * corre afuera de la tool, con este runner.
 *
 * Ejecuta EL MISMO archivo .workflow.js que corre la tool Workflow en Claude — el script no se
 * toca (fuente única). Implementa SOLO la superficie que ese script usa:
 *   args (objeto o string JSON — el gotcha ya lo maneja el script) · log(msg) → stderr ·
 *   agent(prompt, {label, phase, schema, agentType, model}) → spawn `codex exec` (null si falla,
 *   como la tool) · parallel(thunks) → pool con errores→null · pipeline(items, s1, s2) → cadena
 *   por item SIN barrera (s2 recibe (resultado, itemOriginal)).
 *
 * Lo que NO imita: resume por runId · journal · budget · workflow()
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
 *       TYCON_WFLITE_AGENT_CMD (SOLO pruebas: comando stub que reemplaza a codex). El pase que corre con él sale con
 *       `corredor.de_prueba: true`, y ni la revisión del plan ni la del código lo cuentan: no es una revisión
 */
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const JOBS = Math.max(1, parseInt(process.env.TYCON_WFLITE_JOBS || '4', 10));
// intentos fallidos seguidos, sin tope de uso, con los que un corredor queda caído para el resto de la corrida
const FALLOS_PARA_CAIDO = 3;

function modelMap() {
  if (process.env.TYCON_WFLITE_MODEL_MAP) { try { return JSON.parse(process.env.TYCON_WFLITE_MODEL_MAP); } catch (_) {} }
  // equivalences.json del arnés (por lib/harness-path.js: TYCON_GUIDES_DIR o el enlace)
  try {
    const TCG = require('./lib/harness-path.js').rutaArnes();
    const eq = JSON.parse(fs.readFileSync(path.join(TCG, 'build', 'equivalences.json'), 'utf8'));
    // Sin reservas: un modelo que no está en equivalences.json no tiene equivalente y lo
    // dice `slugFor`; `fable` no cae al de `opus`, porque eso esconde la falta.
    return Object.assign({}, eq.models);
  } catch (e) {
    // Un comando sin el arnés lo DICE: el mapeo de modelos queda vacío y se sigue, pero no en silencio.
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
 * textual: "required is required ... including every key. Missing 'line'"). Esta
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

function spawnAgent(cmdline, prompt, cwd, timeoutMs, { stdin = false, env = {} } = {}) {
  return new Promise((resolve) => {
    const [bin, ...pre] = cmdline;
    // El prompt viaja siempre por env (el comando propio y el falso de las pruebas lo leen de ahí); además, por la
    // entrada estándar o en la línea de comando, según lo que declara el corredor.
    // Las corridas de un corredor no ven los ganchos del arnés: TYCON_EVAL_SANDBOX los calla.
    const ch = spawn(bin, pre, { windowsHide: true, cwd, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, TYCON_EVAL_SANDBOX: '1', ...env, TYCON_WFLITE_PROMPT: prompt } });
    let out = '', err = '';
    const killer = setTimeout(() => ch.kill('SIGKILL'), timeoutMs);
    ch.stdout.on('data', (d) => (out += d));
    ch.stderr.on('data', (d) => (err += d));
    if (stdin) { ch.stdin.on('error', () => {}); ch.stdin.end(String(prompt)); }
    // sin pid el proceso nunca arrancó: lo resuelve 'error', con su motivo (puede llegar después de 'close')
    ch.on('close', (code) => { if (ch.pid === undefined) return; clearTimeout(killer); resolve({ code, out, err }); });
    // Sin el motivo (p. ej. el corredor no instalado: ENOENT) la causa diría «salió -1 sin escribir nada».
    ch.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, out, err: `${err}${err ? '\n' : ''}${(e && e.message) || 'no se pudo lanzar'}` }); });
  });
}

/** El nombre del corredor de modelos de OpenAI de la integración (para los avisos de `slugFor`), o «el corredor». */
function openaiLabel() {
  try {
    const integ = require('./lib/review-runner.js').loadIntegration();
    const r = Object.values(integ.runners).find((x) => x && x.models === 'openai');
    return (r && r.label) || 'el corredor';
  } catch (_) { return 'el corredor'; }
}

/**
 * El modelo de OpenAI de un modelo de Claude: se traduce con equivalences.json; uno ya
 * traducido (un valor del mapa) pasa tal cual; sin modelo, el del pase (`DEFAULTS.adversarial.model` de
 * lib/models.js) traducido. Sin equivalente → null: el corredor corre sin modelo (el suyo por defecto) y se
 * dice por `decir` (la salida de error), con el nombre del corredor que da la integración (`label`).
 */
function slugFor(model, models, decir = (t) => process.stderr.write(`${t}\n`), { org = null, provider = null, label = null } = {}) {
  const quien = label || openaiLabel();
  const map = models || {};
  const M = require('./lib/models.js');
  const pedido = model || M.DEFAULTS.adversarial.model;
  // la tabla del proveedor local de la máquina (uno que no es OpenAI ni Anthropic y que se aplica), si lo declara; si
  // no, OpenAI. Sin tabla de OpenAI, lo de siempre (abajo)
  const local = provider && provider !== 'openai' && provider !== 'anthropic' && M.isProvider(provider)
    && M.resolveProviderModel({ provider }).applied ? provider : null;
  const prov = local || 'openai';
  // con tabla o con lista de permitidos de OpenAI, el traductor único (la lista también vale sin tabla)
  const conTabla = Boolean(local) || Boolean(org && ((org.providers && org.providers.openai) || (org.allowed && org.allowed.openai)));
  if (conTabla && M.levelOf(pedido)) {
    const r = M.resolveProviderModel({ org, provider: prov, model: pedido, equivalences: map });
    if (r.model && r.model !== M.INHERIT) return r.model;
    decir(r.outside ? `${r.outside} no está entre los permitidos de ${prov}: lanzo ${quien} sin -m (el modelo de la configuración de la máquina)`
      : prov !== 'openai' ? `la tabla de ${prov} no trae modelo para ${r.level}: lanzo ${quien} sin -m (el modelo de la configuración de la máquina)`
        : `el modelo ${pedido} no tiene equivalente en ${quien}: uso el modelo por defecto de ${quien}`);
    return null;
  }
  if (map[pedido]) return map[pedido];
  if (Object.values(map).includes(pedido)) return pedido;
  decir(`el modelo ${pedido} no tiene equivalente en ${quien}: uso el modelo por defecto de ${quien}`);
  return null;
}

/**
 * El modelo que se le pasa a un corredor, según de qué proveedor salen sus modelos (`runner.models`): `openai` traduce
 * como `slugFor`; `anthropic` y `ollama`, con el traductor único de lib/models.js; `none`, ninguno. null = sin modelo.
 */
function modelFor(runner, model, models, ctx, decir = (t) => process.stderr.write(`${t}\n`)) {
  const fam = runner && runner.models;
  if (fam === 'openai') return slugFor(model, models, decir, { ...ctx, label: runner.label });
  const M = require('./lib/models.js');
  if (!M.isProvider(fam)) return null;
  const pedido = model || M.DEFAULTS.adversarial.model;
  if (!M.levelOf(pedido)) return pedido;
  const r = M.resolveProviderModel({ org: ctx && ctx.org, provider: fam, model: pedido, equivalences: models });
  if (r.model && r.model !== M.INHERIT) return r.model;
  decir(`${runner.label}: sin modelo para ${pedido}, uso el de la configuración de la máquina`);
  return null;
}

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
 * repite el pedido, y un pedido que habla de «rate limit» haría pasar por tope cualquier falla.
 */
function esTope(res) {
  const err = ultimoRenglon(res && res.err);
  return require('./lib/review-runner.js').LIMIT_RE.test(err || ultimoRenglon(res && res.out));
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

/**
 * El proveedor de Codex de la máquina y los modelos de la organización, una vez por corrida: `{ org, provider }`.
 * Sin arnés o con la configuración ilegible, `{ org: null, provider: null }` (lo de siempre) y se dice.
 */
function providerContext() {
  try {
    const TCG = require('./lib/harness-path.js').rutaArnes();
    const M = require('./lib/models.js');
    const org = M.readOrgModels({ dir: TCG, teamRepos: require(path.join(TCG, 'scripts', 'lib', 'team-repos.js')) });
    if (org.problem) process.stderr.write(`${org.problem}\n`);
    const prov = require(path.join(TCG, 'scripts', 'lib', 'tycon-config.js')).modelProvider({ env: process.env });
    if (prov.problem) process.stderr.write(`el proveedor de modelos de la máquina no se pudo leer (${prov.problem}): uso la tabla de OpenAI\n`);
    return { org: org.declared ? org.data : null, provider: prov.provider };
  } catch (e) {
    process.stderr.write(`no pude leer el proveedor de modelos (${String((e && e.message) || e).split('\n')[0]}): uso la tabla de OpenAI\n`);
    return { org: null, provider: null };
  }
}

/** La lista de corredores de la corrida: `--runners`, o la de la organización (team-repos.json → review_runner). */
function runnersDeLaCorrida(opts) {
  const RR = require('./lib/review-runner.js');
  let order = null;
  let customCommand = null;
  try {
    const TCG = require('./lib/harness-path.js').rutaArnes();
    const reader = require(path.join(TCG, 'scripts', 'lib', 'team-repos.js'));
    const file = path.join(TCG, 'team-repos.json');
    if (fs.existsSync(file)) {
      const r = reader.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      const o = RR.runnerOrder(r && r.data);
      order = o.order;
      customCommand = o.customCommand;
    }
  } catch (e) {
    process.stderr.write(`no pude leer la lista de corredores de la organización (${String((e && e.message) || e).split('\n')[0]}): uso la de fábrica\n`);
  }
  if (Array.isArray(opts.runners) && opts.runners.length) order = opts.runners;
  if (!order) order = RR.DEFAULT_ORDER.slice();
  const integration = RR.loadIntegration();
  if (integration.problem) process.stderr.write(`${integration.problem}\n`);
  const elegidos = RR.pickRunners({ order, mode: opts.mode, integration, customCommand });
  for (const s of elegidos.skipped) process.stderr.write(`wflite: no uso ${s.name}: ${s.reason}\n`);
  return { ...elegidos, customCommand };
}

function makeAgent(opts, corredor) {
  const RR = require('./lib/review-runner.js');
  const models = modelMap();
  const proveedor = providerContext();
  const seq = { n: 0 };
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wflite-io-'));
  const stub = process.env.TYCON_WFLITE_AGENT_CMD;
  // con el gancho de las pruebas puesto, gana sobre la lista: un solo corredor, el falso
  const lista = stub ? { usable: [{ name: 'stub', runner: { label: 'el corredor de prueba', answer: 'stdout', prompt: 'env' } }], skipped: [], customCommand: null }
    : runnersDeLaCorrida(opts);
  corredor.lista = lista.usable.map((u) => u.name);
  if (stub) corredor.dePrueba = true;
  return async function agent(prompt, aopts) {
    aopts = aopts || {};
    const id = ++seq.n;
    const label = aopts.label || `agent-${id}`;
    const phase = aopts.phase || 'sin-fase';
    const muerto = (causa, nombre, hora = horaCorta()) => { corredor.muertos.push({ label, corredor: nombre, causa, hora }); };
    corredor.agentes[phase] = (corredor.agentes[phase] || 0) + 1;
    const outFile = path.join(tmpBase, `out-${id}.txt`);
    const schemaFile = aopts.schema ? path.join(tmpBase, `schema-${id}.json`) : null;
    const strict = aopts.schema ? toStrictSchema(aopts.schema) : null;
    if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(strict));
    if (!lista.usable.length) { muerto('no hay ningún corredor para usar (mirá review_runner.order y la integración de los corredores)', null); return null; }
    for (const { name, runner } of lista.usable) {
      // un corredor en su tope no se vuelve a probar en esta corrida
      if (corredor.topes[name]) { muerto(`no se lanzó: ${corredor.topes[name].causa}`, name, corredor.topes[name].hora); continue; }
      // un corredor caído (no se pudo lanzar, o falló seguido sin tope) tampoco: cada agente gastaría sus intentos en él
      if (corredor.caidos[name]) { muerto(`no se lanzó: ${corredor.caidos[name].causa}`, name, corredor.caidos[name].hora); continue; }
      const modelo = stub ? null : modelFor(runner, aopts.model, models, proveedor);
      let causa = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (corredor.topes[name] || corredor.caidos[name]) break;
        process.stderr.write(`wflite ▸ ${label} con ${runner.label} (intento ${attempt})\n`);
        let res;
        let leido;
        try { fs.rmSync(outFile, { force: true }); } catch (_) {}
        if (stub) {
          res = await spawnAgent(stub.split(' '), prompt, opts.cwd, opts.timeoutMs);
          leido = { raw: res.out, structured: null, tokens: null, failed: res.code !== 0, cause: null, limit: false };
          if (leido.failed) leido.limit = esTope(res);
        } else {
          const c = RR.commandFor(name, runner, { model: modelo, schema: strict, schemaFile, outFile, cwd: opts.cwd, customCommand: lista.customCommand, prompt });
          res = await spawnAgent([c.bin, ...c.args], prompt, opts.cwd, opts.timeoutMs, { stdin: c.input === 'stdin', env: c.env });
          let fileText = null;
          if (c.answer === 'file' || c.answer === 'file-env') { try { fileText = fs.readFileSync(outFile, 'utf8'); } catch (_) { fileText = null; } }
          leido = RR.readAnswer(runner, { stdout: res.out, stderr: res.err, code: res.code, fileText });
          if (leido.failed && !leido.limit) leido.limit = esTope(res);
        }
        if (leido.tokens !== null) {
          corredor.tokensPorFase[phase] = (corredor.tokensPorFase[phase] || 0) + leido.tokens;
          corredor.conTokens = true;
        }
        const raw = String(leido.raw || '');
        const murioPorError = () => {
          causa = leido.cause ? taparSecretos(leido.cause).slice(0, 300) : causaDe(res);
          if (leido.limit) {
            corredor.topes[name] = { causa, hora: horaCorta(), label };
            if (!corredor.tope) corredor.tope = corredor.topes[name];
            process.stderr.write(`wflite ✖ ${label}: ${runner.label} en su tope de uso (${causa}) — no lo vuelvo a probar en esta corrida\n`);
            return;
          }
          corredor.fallosSeguidos[name] = (corredor.fallosSeguidos[name] || 0) + 1;
          const noLanzo = res.code === -1;
          if (noLanzo || corredor.fallosSeguidos[name] >= FALLOS_PARA_CAIDO) {
            const por = noLanzo ? `no se pudo lanzar (${causa})` : `falló ${corredor.fallosSeguidos[name]} veces seguidas (${causa})`;
            corredor.caidos[name] = { causa: por, hora: horaCorta(), label };
            process.stderr.write(`wflite ✖ ${label}: ${runner.label} ${por} — no lo vuelvo a probar en esta corrida\n`);
          }
        };
        const respondio = () => { corredor.fallosSeguidos[name] = 0; };
        // Un agente que salió con error y no dejó una respuesta usable muere por la causa de SU error (y ahí se mira el
        // tope), aunque haya escrito algo en la salida: un corredor puede repetir ahí el pedido.
        if (leido.failed && !leido.structured && !raw.trim()) { murioPorError(); continue; }
        if (!aopts.schema) {
          const t = raw.trim();
          if (t && !leido.failed) { respondio(); corredor.usado[label] = name; return t; }
          if (leido.failed) murioPorError(); else causa = 'contestó vacío';
          continue;
        }
        let obj = leido.structured;
        if (!obj) { try { obj = JSON.parse(raw.trim()); } catch (_) { obj = lastJsonObject(raw); } }
        if (obj && checkShape(obj, aopts.schema)) { respondio(); corredor.usado[label] = name; return obj; }
        if (leido.failed) murioPorError();
        else causa = `contestó sin las claves pedidas (${(aopts.schema.required || []).join(', ')})`;
      }
      muerto(causa || (corredor.topes[name] && corredor.topes[name].causa) || (corredor.caidos[name] && corredor.caidos[name].causa) || 'sin respuesta', name);
    }
    // semántica de la tool: agente muerto → null; el guion lo cuenta como lente sin medir o hallazgo sin veredicto
    return null;
  };
}

async function runWorkflow(scriptPath, argsValue, opts) {
  let source = fs.readFileSync(scriptPath, 'utf8');
  // neutralizar el export (ilegal dentro de una función): mismo objeto, sin exportar
  source = source.replace(/^export const meta =/m, 'const meta =');
  const corredor = { nombre: opts.agentsDir ? 'agentes-claude' : 'workflow-lite', muertos: [], tope: null, topes: {}, caidos: {}, fallosSeguidos: {}, usado: {}, agentes: {}, tokensPorFase: {}, conTokens: false };
  // el modo del pase: el del plan revisa texto; el del código ejecuta pruebas y pide un corredor confinado
  const modo = argsValue && typeof argsValue === 'object' && argsValue.modo === 'plan' ? 'plan' : 'code';
  const agent = opts.agentsDir ? makeDirAgent(opts, corredor) : makeAgent({ ...opts, mode: opts.mode || modo }, corredor);
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
    const total = Object.values(corredor.tokensPorFase).reduce((a, b) => a + b, 0);
    result.corredor = { nombre: corredor.nombre, lista: corredor.lista || [], usado: corredor.usado, muertos: corredor.muertos, tope: corredor.tope,
      topes: corredor.topes, caidos: corredor.caidos, agentes: corredor.agentes, tokens: corredor.conTokens ? { total, por_fase: corredor.tokensPorFase } : null,
      ...(corredor.dePrueba ? { de_prueba: true } : {}),
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
  if (!scriptPath || !fs.existsSync(scriptPath)) { console.error('uso: workflow-lite.js <script.workflow.js> --args <json> [--out <file>] [--runners <a,b>] [--agents-dir <carpeta>]'); return 1; }
  const ai = argv.indexOf('--args');
  const rawArgs = ai >= 0 ? argv[ai + 1] : '{}';
  let argsValue; try { argsValue = JSON.parse(rawArgs); } catch (_) { argsValue = rawArgs; }
  const oi = argv.indexOf('--out');
  const di = argv.indexOf('--agents-dir');
  const agentsDir = di >= 0 ? argv[di + 1] : null;
  if (di >= 0 && !agentsDir) { console.error('workflow-lite: --agents-dir sin carpeta'); return 1; }
  // `--runners a,b`: la lista de corredores de esta corrida, en lugar de la de la organización
  const ri = argv.indexOf('--runners');
  const runners = ri >= 0 ? String(argv[ri + 1] || '').split(',').map((x) => x.trim()).filter(Boolean) : null;
  if (ri >= 0 && !(runners && runners.length)) { console.error('workflow-lite: --runners sin lista'); return 1; }
  const cwd = (argsValue && argsValue.repo) || process.cwd();
  const result = await runWorkflow(scriptPath, argsValue, { cwd, timeoutMs: 20 * 60 * 1000, agentsDir, runners });
  const json = JSON.stringify(result, null, 1);
  if (oi >= 0) { fs.writeFileSync(argv[oi + 1], json + '\n'); console.log(`wflite: resultado → ${argv[oi + 1]}`); }
  else console.log(json);
  // Un pase no medido no sale 0: el archivo se escribió, pero nadie lo lee verde por el código de salida. En el modo
  // plan (`args.modo: 'plan'`) es el veredicto `sin-veredicto`: la revisión no dio aprobado.
  if (result && (result.medido === false || result.veredicto === 'sin-veredicto')) {
    const c = result.corredor || {};
    for (const [nombre, t] of Object.entries(c.topes || {})) process.stderr.write(`wflite: ${nombre} en su tope de uso desde las ${t.hora} (${t.causa}).\n`);
    if (c.pedidos_pendientes) process.stderr.write(`wflite: quedan ${c.pedidos_pendientes} pedido(s) para agentes de Claude en ${c.pedidos}\n`);
    process.stderr.write(`${result.aviso || 'wflite: pase NO MEDIDO'}\n`);
    return 3;
  }
  return 0;
}

module.exports = { slugFor, modelFor };

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`workflow-lite: ${e.message}`); process.exit(1); });
}
