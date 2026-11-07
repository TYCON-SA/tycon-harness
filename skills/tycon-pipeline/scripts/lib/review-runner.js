'use strict';
/**
 * review-runner.js — con qué corre cada agente de la revisión del plan y de la del código. El núcleo no nombra a
 * ningún corredor: lo que es propio de cada uno (cómo se lanza, dónde deja la respuesta, de qué proveedor salen sus
 * modelos, cómo se reconoce su tope, si corre confinado) vive en `integrations/review-runner/integration.json`.
 *
 * La organización elige la lista en `team-repos.json` → `review_runner.order`; el primero es «el revisor» y los demás,
 * el orden de respaldo. En el modo código sólo se usa un corredor confinado: el verificador ejecuta pruebas.
 * `TYCON_REVIEW_RUNNER_FILE` cambia la integración: la usan sólo las pruebas.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_ORDER = Object.freeze(['claude']);
// El tope de uso de un corredor (o de su proveedor): contra eso no sirve reintentar con el mismo.
const LIMIT_RE = /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b/i;
const ANSWERS = Object.freeze(['stdout', 'stdout-json', 'file', 'file-env']);
const PROMPTS = Object.freeze(['stdin', 'arg', 'env']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** La integración de los corredores: `{ runners }` o `{ runners: {}, problem }`. */
function loadIntegration({ env = process.env } = {}) {
  const file = String(env.TYCON_REVIEW_RUNNER_FILE || '').trim() || path.join(ROOT, 'integrations', 'review-runner', 'integration.json');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { runners: {}, file, problem: `no pude leer los corredores de la revisión (${file}: ${(e && e.code) || (e && e.message) || e})` };
  }
  const runners = isObject(doc) && isObject(doc.runners) ? doc.runners : {};
  const malos = Object.entries(runners).filter(([, r]) => !isObject(r) || !ANSWERS.includes(r.answer) || !PROMPTS.includes(r.prompt)
    || (!r.from_profile && typeof r.bin !== 'string'));
  if (malos.length) return { runners: {}, file, problem: `los corredores ${malos.map(([n]) => n).join(', ')} de ${file} no se pueden usar (falta bin, prompt o answer)` };
  return { runners, file };
}

/** La lista elegida por la organización y su comando propio: `{ order, customCommand }`. Sin lista, la de fábrica. */
function runnerOrder(teamRepos) {
  const rr = isObject(teamRepos) && isObject(teamRepos.review_runner) ? teamRepos.review_runner : {};
  const order = Array.isArray(rr.order) && rr.order.length ? rr.order.slice() : DEFAULT_ORDER.slice();
  const customCommand = typeof rr.custom_command === 'string' && rr.custom_command.trim() ? rr.custom_command.trim() : null;
  return { order, customCommand };
}

/** Los corredores que se pueden usar, en orden, y los que no, con su motivo. `mode`: `plan` o `code`. */
function pickRunners({ order, mode, integration, customCommand }) {
  const usable = [];
  const skipped = [];
  for (const name of order || []) {
    const runner = integration && integration.runners ? integration.runners[name] : null;
    if (!runner) { skipped.push({ name, reason: 'no está en la integración de los corredores' }); continue; }
    if (runner.from_profile && !customCommand) { skipped.push({ name, reason: `falta el comando (${runner.from_profile})` }); continue; }
    if (mode === 'code' && runner.confined !== true) { skipped.push({ name, reason: 'no corre confinado, y el verificador del código ejecuta pruebas' }); continue; }
    usable.push({ name, runner });
  }
  return { usable, skipped };
}

/**
 * La línea de comando de un corredor: `{ bin, args, env, input, cwd, shell: false, answer, outFile }`. `input` dice
 * por dónde va el pedido: `stdin`, `arg` (ya puesto al final de `args` si se pasa `prompt`) o `env`
 * (`TYCON_WFLITE_PROMPT`, que va siempre). Nunca por un shell: el comando propio se parte en palabras.
 */
function commandFor(name, runner, { model, schema, schemaFile, outFile, cwd, customCommand, prompt } = {}) {
  let bin;
  let args;
  if (runner.from_profile) {
    const palabras = String(customCommand || '').trim().split(/\s+/).filter(Boolean);
    bin = palabras[0];
    args = palabras.slice(1);
  } else {
    bin = runner.bin;
    args = Array.isArray(runner.args) ? runner.args.slice() : [];
  }
  if (model && runner.model_flag) args.push(runner.model_flag, model);
  if (runner.settings_flag && isObject(runner.settings)) args.push(runner.settings_flag, JSON.stringify(runner.settings));
  if (runner.tools_flag && Array.isArray(runner.tools) && runner.tools.length) args.push(runner.tools_flag, runner.tools.join(','));
  if (schema && runner.schema_flag) args.push(runner.schema_flag, runner.schema_inline ? JSON.stringify(schema) : schemaFile);
  if (outFile && runner.output_flag) args.push(runner.output_flag, outFile);
  if (cwd && runner.cwd_flag) args.push(runner.cwd_flag, cwd);
  if (runner.prompt === 'arg' && prompt !== undefined) args.push(String(prompt));
  const env = { ...(isObject(runner.env) ? runner.env : {}) };
  if (runner.answer === 'file-env' && outFile) env.TYCON_REVIEW_OUT = outFile;
  return { name, label: runner.label || name, bin, args, env, input: runner.prompt, cwd, shell: false, answer: runner.answer, outFile };
}

/** ¿El texto es el del tope de uso del corredor? Su patrón, o el de siempre. */
const patronesMalos = new Set();
function isLimit(runner, text) {
  let re = LIMIT_RE;
  if (runner && typeof runner.limit_pattern === 'string') {
    try { re = new RegExp(runner.limit_pattern, 'i'); } catch (e) {
      // un patrón malo usa el de siempre, y se dice una vez por corredor: con él el tope podría no reconocerse
      re = LIMIT_RE;
      const clave = `${runner.label || runner.bin || '?'}\u0000${runner.limit_pattern}`;
      if (!patronesMalos.has(clave)) {
        patronesMalos.add(clave);
        process.stderr.write(`review-runner: el limit_pattern de ${runner.label || runner.bin || 'un corredor'} no es una expresión válida (${e.message}): uso el de siempre\n`);
      }
    }
  }
  return re.test(String(text || ''));
}

const ultimoRenglon = (t) => String(t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';

/** La suma de los tokens de un objeto de uso (`*_tokens` numéricos), o null si no trae ninguno. */
function tokensOf(usage) {
  if (!isObject(usage)) return null;
  const n = Object.entries(usage).filter(([k, v]) => /_tokens$/.test(k) && Number.isFinite(v)).reduce((s, [, v]) => s + v, 0);
  return Object.keys(usage).some((k) => /_tokens$/.test(k)) ? n : null;
}

/**
 * Lo que contestó un corredor: `{ raw, structured, tokens, failed, cause, limit }`. `raw` es el texto de la respuesta
 * (el que se parsea si no vino estructurada); `structured`, la respuesta ya con forma, si el corredor la da; `tokens`,
 * el uso o null; `failed`, si salió con error; `cause`, el último renglón del error, sin tapar (lo tapa quien la guarda).
 */
function readAnswer(runner, { stdout = '', stderr = '', code = 0, fileText = null } = {}) {
  const out = { raw: '', structured: null, tokens: null, failed: code !== 0, cause: null, limit: false };
  if (runner.answer === 'stdout-json') {
    let j = null;
    try { j = JSON.parse(String(stdout).trim()); } catch (_) { j = null; }
    if (!isObject(j)) {
      out.failed = true;
      out.cause = ultimoRenglon(stderr) || ultimoRenglon(stdout) || `salió ${code} sin escribir nada`;
    } else {
      out.tokens = runner.usage_field ? tokensOf(j[runner.usage_field]) : null;
      out.raw = runner.text_field && typeof j[runner.text_field] === 'string' ? j[runner.text_field] : '';
      out.structured = runner.answer_field && isObject(j[runner.answer_field]) ? j[runner.answer_field] : null;
      if (runner.error_field && j[runner.error_field] === true) {
        out.failed = true;
        out.cause = ultimoRenglon(out.raw) || ultimoRenglon(stderr) || String(j.subtype || 'error');
      }
    }
  } else {
    out.raw = fileText !== null && fileText !== undefined ? String(fileText) : String(stdout || '');
    if (out.failed) out.cause = ultimoRenglon(stderr) || ultimoRenglon(out.raw) || `salió ${code} sin escribir nada`;
  }
  // el tope se mira en el error, nunca en toda la respuesta: un pedido que habla de «rate limit» no es un tope
  if (out.failed) out.limit = isLimit(runner, out.cause);
  out.ok = !out.failed;
  return out;
}

module.exports = { DEFAULT_ORDER, LIMIT_RE, loadIntegration, runnerOrder, pickRunners, commandFor, readAnswer, isLimit, tokensOf };
