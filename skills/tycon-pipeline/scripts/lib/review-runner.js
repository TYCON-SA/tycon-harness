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
const os = require('os');
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

const esArchivo = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Los archivos que cumplen `patron` (con `~` y `*` dentro de un tramo), del más nuevo al más viejo. */
function expandir(patron, home) {
  const tramos = String(patron).replace(/^~(?=$|[\\/])/, home).split(/[\\/]+/);
  // el primer tramo vacío es la raíz; en Windows, la unidad («C:»)
  let actuales = [tramos[0] === '' ? path.sep : `${tramos[0]}${path.sep}`];
  for (const t of tramos.slice(1).filter(Boolean)) {
    const siguientes = [];
    for (const base of actuales) {
      if (!t.includes('*')) { siguientes.push(path.join(base, t)); continue; }
      const re = new RegExp(`^${t.split('*').map(escRe).join('.*')}$`);
      let nombres = [];
      try { nombres = fs.readdirSync(base); } catch (_) { nombres = []; }
      for (const n of nombres) if (re.test(n)) siguientes.push(path.join(base, n));
    }
    actuales = siguientes;
  }
  const cuando = (f) => { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } };
  return actuales.filter(esArchivo).sort((a, b) => cuando(b) - cuando(a));
}

/**
 * El programa de un corredor: `bin` tal cual si trae carpeta o está en el PATH (en Windows, con las extensiones de
 * PATHEXT); si no, el más nuevo de los lugares que declara su integración para este sistema (`bin_paths`, con `~` y
 * `*`). Una sesión de una extensión del editor no siempre tiene al corredor en el PATH. → `{ bin, desde }`, o
 * `{ bin: null, buscado }` con dónde se buscó.
 */
function resolveBin(runner, bin, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const nombre = String(bin || '');
  if (!nombre) return { bin: null, buscado: [] };
  if (/[\\/]/.test(nombre)) return { bin: nombre, desde: 'ruta' };
  const windows = platform === 'win32';
  const extensiones = windows ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  for (const dir of String(env.PATH || env.Path || '').split(windows ? ';' : ':').filter(Boolean)) {
    if (extensiones.some((e) => esArchivo(path.join(dir, `${nombre}${e}`)))) return { bin: nombre, desde: 'PATH' };
  }
  const buscado = ['el PATH'];
  const lugares = runner && isObject(runner.bin_paths) && Array.isArray(runner.bin_paths[platform]) ? runner.bin_paths[platform] : [];
  for (const patron of lugares) {
    buscado.push(String(patron));
    const hallado = expandir(patron, home)[0];
    if (hallado) return { bin: hallado, desde: String(patron) };
  }
  return { bin: null, buscado };
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

/** El consumo por tipo (los `*_tokens` numéricos, con su nombre), o null si no trae ninguno. */
function usageOf(usage) {
  if (!isObject(usage)) return null;
  const porTipo = Object.fromEntries(Object.entries(usage).filter(([k, v]) => /_tokens$/.test(k) && Number.isFinite(v)));
  return Object.keys(porTipo).length ? porTipo : null;
}

/**
 * Lo que contestó un corredor: `{ raw, structured, tokens, usage, failed, cause, limit }`; `usage`, el consumo por tipo. `raw` es el texto de la respuesta
 * (el que se parsea si no vino estructurada); `structured`, la respuesta ya con forma, si el corredor la da; `tokens`,
 * el uso o null; `failed`, si salió con error; `cause`, el último renglón del error, sin tapar (lo tapa quien la guarda).
 */
function readAnswer(runner, { stdout = '', stderr = '', code = 0, fileText = null } = {}) {
  const out = { raw: '', structured: null, tokens: null, usage: null, failed: code !== 0, cause: null, limit: false };
  if (runner.answer === 'stdout-json') {
    let j = null;
    try { j = JSON.parse(String(stdout).trim()); } catch (_) { j = null; }
    if (!isObject(j)) {
      out.failed = true;
      out.cause = ultimoRenglon(stderr) || ultimoRenglon(stdout) || `salió ${code} sin escribir nada`;
    } else {
      out.tokens = runner.usage_field ? tokensOf(j[runner.usage_field]) : null;
      out.usage = runner.usage_field ? usageOf(j[runner.usage_field]) : null;
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

/**
 * Cómo se lanza sin shell el programa que dio `resolveBin` → `{ bin, pre }`, o `{ bin: null, motivo }`. Fuera de Windows,
 * tal cual. En Windows, Node no corre un `.cmd` sin shell (ENOENT por el nombre; EINVAL con la extensión, desde el
 * arreglo del CVE-2024-27980), y con shell los argumentos —el JSON de settings y del esquema— pasarían por cmd. Como con
 * `npm.cmd` (`scripts/ci/audit-dependencies.js`): un `.exe`/`.com` va con su ruta; un `.cmd`/`.bat` se lee, y si es el
 * atajo de npm (cmd-shim) se lanza su `.js` con este mismo Node, o el `.exe` al que apunta. Un atajo que no se entiende
 * no se lanza a ciegas: la causa lo dice.
 */
function launchable(bin, { platform = process.platform, env = process.env, separator = ';' } = {}) {
  const nombre = String(bin || '');
  if (platform !== 'win32' || !nombre) return { bin: nombre || null, pre: [] };
  if (/[\\/]/.test(nombre)) return programaDelAtajo(nombre);
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()).filter((e) => ['.com', '.exe', '.bat', '.cmd'].includes(e));
  // en cada carpeta, primero lo que Node lanza solo (.com, .exe) y después los atajos; un nombre que ya trae la
  // extensión se busca tal cual
  const orden = /\.(com|exe|bat|cmd)$/i.test(nombre) ? [''] : [...exts.filter((e) => e === '.com' || e === '.exe'), ...exts.filter((e) => e === '.bat' || e === '.cmd')];
  let primerMotivo = null;
  for (const dir of String(env.PATH || env.Path || '').split(separator).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    for (const f of orden.map((e) => path.join(dir, `${nombre}${e}`)).filter(esArchivo)) {
      // un atajo que no se entiende no corta la búsqueda: más adelante en el PATH puede estar el programa
      const l = programaDelAtajo(f);
      if (l.bin) return l;
      if (!primerMotivo) primerMotivo = l.motivo;
    }
  }
  return primerMotivo ? { bin: null, motivo: primerMotivo } : { bin: nombre, pre: [] };
}

/** En Windows, el archivo `f` listo para lanzar sin shell: un `.cmd`/`.bat` por su programa (cmd-shim), lo demás tal cual. */
function programaDelAtajo(f) {
  if (!/\.(cmd|bat)$/i.test(f)) return { bin: f, pre: [] };
  let texto = '';
  try { texto = fs.readFileSync(f, 'utf8'); } catch (e) { return { bin: null, motivo: `no pude leer ${f} (${e.code || e.message})` }; }
  // cmd-shim: `"%dp0%\<programa>" %*` (o `%~dp0`), relativo a la carpeta del atajo
  const m = /"%~?dp0%?\\?([^"%]+)"\s+%\*/i.exec(texto);
  const destino = m ? path.join(path.dirname(f), ...m[1].split(/[\\/]+/).filter(Boolean)) : null;
  if (destino && esArchivo(destino)) {
    if (/\.(c|m)?js$/i.test(destino)) return { bin: process.execPath, pre: [destino] };
    if (/\.(exe|com)$/i.test(destino)) return { bin: destino, pre: [] };
  }
  return { bin: null, motivo: `${f} es un atajo de Windows que no sé lanzar sin shell (no es el atajo de npm, o su programa no está)` };
}

module.exports = { DEFAULT_ORDER, LIMIT_RE, loadIntegration, runnerOrder, pickRunners, commandFor, resolveBin, launchable, readAnswer, isLimit, tokensOf, usageOf };
