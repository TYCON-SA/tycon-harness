#!/usr/bin/env node
'use strict';
/**
 * models-env.js — las variables de entorno que Claude Code necesita para que cada nivel use el modelo de la tabla del
 * proveedor de la máquina.
 *
 * POR QUÉ EXISTE: los revisores del arnés piden los alias `haiku`, `sonnet` y `opus`. Con Claude Code sobre otro
 * proveedor (Ollama), cada alias recibe un modelo que existe sólo si `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` está puesta, y
 * el arnés no puede ponerla: el entorno de una sesión vive antes de que arranque. Este comando la saca de la tabla de la
 * organización (`team-repos.json → models.providers`, con el traductor único de models.js) y la imprime, para que la
 * función `claude-ollama` de la guía la evalúe. No imprime la dirección base ni el token: ésos los pone la función.
 *
 * Uso: node scripts/lib/models-env.js [--provider <p>] [--org-config <team-repos.json>] [--format shell|json|vscode]
 *   --provider: sin él, el de la máquina (`models.provider` / TYCON_MODEL_PROVIDER).
 *   --org-config: sin él, el `team-repos.json` de este árbol.
 *   shell (por defecto): una línea `export …` por variable; un nivel en «inherit» toma el modelo de la sesión
 *   (`"${ANTHROPIC_MODEL}"`). json y vscode: la variable en «inherit» se omite y va en `notes`. Las notas, en shell,
 *   salen por la salida de error.
 * Sale 0 (también sin variables que imprimir, con el motivo), 2 con un argumento o una configuración que no se lee.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MODELS_JS = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'models.js');

// el nivel de cada variable de Claude Code: la guía de Ollama lista sólo éstas (el nivel máximo no tiene una conocida)
const VARIABLES = [
  ['economy', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
  ['balanced', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
  ['strong', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
];
const NOTA_MAX = 'el nivel máximo (fable) no tiene variable conocida en Claude Code: un trabajo en ese nivel usa el alias fable, que Claude Code resuelve solo';
const FORMATS = ['shell', 'json', 'vscode'];

class UsoError extends Error {}

/**
 * Las variables de un proveedor: `{ provider, variables: [{ name, level, model }], notes }`. `model` = el nombre del
 * modelo o `inherit` (el de la sesión). Sin variables para Anthropic (usa sus alias) ni para Cursor (no se aplica).
 * opts: provider · org (`models` leído por `readOrgModels`) · equivalences.
 */
function envFor({ provider, org, equivalences } = {}) {
  const M = require(MODELS_JS);
  const out = { provider, variables: [], notes: [] };
  if (provider === 'anthropic') { out.notes.push('con Anthropic no hace falta ninguna variable: cada nivel es su alias (haiku, sonnet, opus, fable)'); return out; }
  if (provider === 'cursor') { out.notes.push(M.CURSOR_NOT_APPLIED); return out; }
  const warnings = [];
  out.sinTabla = !(org && org.providers && org.providers[provider]);
  for (const [level, name] of VARIABLES) {
    const r = M.resolveProviderModel({ org, provider, level, equivalences, warnings });
    out.variables.push({ name, level, model: r.model || M.INHERIT });
  }
  for (const w of warnings) out.notes.push(w.message);
  out.notes.push(NOTA_MAX);
  return out;
}

/** El texto de salida en un formato: `{ stdout, stderr }`. */
function render(env, format) {
  const INHERIT = require(MODELS_JS).INHERIT;
  const fijas = env.variables.filter((v) => v.model !== INHERIT);
  const heredadas = env.variables.filter((v) => v.model === INHERIT);
  const notasDeHerencia = heredadas.map((v) => `${v.name}: ${env.sinTabla ? `la organización no carga la tabla de ${env.provider}` : `el nivel ${v.level} es «inherit» (o no está cargado) en la tabla de ${env.provider}`}: queda el modelo de la sesión (ANTHROPIC_MODEL)`);
  if (format === 'shell') {
    const lineas = env.variables.map((v) => `export ${v.name}="${v.model === INHERIT ? '${ANTHROPIC_MODEL}' : v.model}"`);
    return { stdout: lineas.length ? `${lineas.join('\n')}\n` : '', stderr: env.notes.map((n) => `models-env: ${n}\n`).join('') };
  }
  const notes = [...notasDeHerencia, ...env.notes];
  const doc = format === 'json'
    ? { provider: env.provider, variables: Object.fromEntries(fijas.map((v) => [v.name, v.model])), notes }
    : { 'claudeCode.environmentVariables': fijas.map((v) => ({ name: v.name, value: v.model })), notes };
  return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: '' };
}

/** La configuración de modelos de la organización desde la ruta de su `team-repos.json`. Tira UsoError si no se lee. */
function orgDe(orgConfig) {
  const M = require(MODELS_JS);
  if (path.basename(orgConfig) !== 'team-repos.json') throw new UsoError(`--org-config tiene que ser un team-repos.json (es ${orgConfig})`);
  if (!fs.existsSync(orgConfig)) throw new UsoError(`no existe ${orgConfig}`);
  const dir = path.dirname(orgConfig);
  const r = M.readOrgModels({ dir, teamRepos: lectorDe(dir) });
  if (r.problem) throw new UsoError(r.problem);
  return r.declared ? r.data : null;
}

/**
 * El lector de `team-repos.json` del árbol de la organización; si ese árbol no lo trae, el de este árbol. Un lector que
 * está y no carga no se reemplaza callado: tira (también en scripts/lib/nightly-model.js).
 */
function lectorDe(dir) {
  const propio = path.join(dir, 'scripts', 'lib', 'team-repos.js');
  try { return require(propio); } catch (e) {
    // (la primera línea nombra el archivo que falta; las siguientes, la cadena de quién lo pidió)
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).split('\n')[0].includes(propio)) return require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
    throw new UsoError(`no pude cargar ${propio} (${String((e && e.message) || e).split('\n')[0]})`);
  }
}

/** Las equivalencias de OpenAI (`build/equivalences.json → models`): `{ models, nota }`; uno ilegible se dice en `nota`. */
function equivalencias(dir) {
  const notas = [];
  for (const d of [dir, ROOT]) {
    const f = path.join(d, 'build', 'equivalences.json');
    try { return { models: JSON.parse(fs.readFileSync(f, 'utf8')).models || {}, nota: notas[0] || null }; } catch (e) {
      if (!e || e.code !== 'ENOENT') notas.push(`no pude leer ${f} (${(e && e.code) || String((e && e.message) || e).split('\n')[0]}): la tabla de OpenAI queda sin sus valores de hoy`);
    }
  }
  return { models: {}, nota: notas[0] || null };
}

function main(argv, env = process.env) {
  const args = { provider: null, orgConfig: null, format: 'shell' };
  const CLAVES = { '--provider': 'provider', '--org-config': 'orgConfig', '--format': 'format' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!CLAVES[a]) throw new UsoError(`argumento desconocido: ${a}`);
    const v = argv[i + 1];
    // sin valor (o con otra opción en su lugar) no se cae al de la máquina: es un error
    if (v === undefined || v === '' || String(v).startsWith('--')) throw new UsoError(`${a} sin valor`);
    args[CLAVES[a]] = v;
    i += 1;
  }
  const M = require(MODELS_JS);
  if (!FORMATS.includes(args.format)) throw new UsoError(`--format tiene que ser ${FORMATS.join(', ')}`);
  let provider = args.provider;
  if (!provider) {
    const p = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js')).modelProvider({ env });
    if (p.problem) throw new UsoError(`el proveedor de modelos de la máquina no se pudo leer: ${p.problem}`);
    provider = p.provider;
  }
  if (!M.isProvider(provider)) throw new UsoError(`--provider tiene que ser ${M.PROVIDERS.join(', ')} (es ${JSON.stringify(provider)})`);
  const orgConfig = path.resolve(args.orgConfig || path.join(ROOT, 'team-repos.json'));
  const org = args.orgConfig || fs.existsSync(orgConfig) ? orgDe(orgConfig) : null;
  const eq = equivalencias(path.dirname(orgConfig));
  const env0 = envFor({ provider, org, equivalences: eq.models });
  if (eq.nota && provider === 'openai') env0.notes.unshift(eq.nota);
  return render(env0, args.format);
}

if (require.main === module) {
  try {
    const r = main(process.argv.slice(2));
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
  } catch (e) {
    process.stderr.write(`models-env: ${e instanceof UsoError ? e.message : (e && e.stack) || e}\n`);
    process.exit(2);
  }
}

module.exports = { envFor, render, main, VARIABLES };
