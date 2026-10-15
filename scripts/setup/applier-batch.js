#!/usr/bin/env node
'use strict';
/**
 * applier-batch.js — varios pasos de Node del aplicador en UN solo proceso, cada uno con la misma respuesta que su
 * llamada suelta (story 8.36).
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────────────────────
 * El aplicador de Windows (`install-tycon-hooks.ps1`) corre en cada arranque de sesión. Lanzaba unos 16 procesos de
 * Node por corrida, y PowerShell gasta ~50-100 ms en lanzar cada uno (medido el 2026-10-14 sobre la suite
 * installer-ps1: 1,6 s por corrida en una Mac; más en un Windows de verdad). Esta tanda corre varios de esos pasos
 * juntos. No cambia lo que hace cada paso: llama a la misma función que corre su arranque como programa (`cli`).
 *
 * ── QUÉ HACE ────────────────────────────────────────────────────────────────────────────────────────────────────
 * Lee un plan, revisa que cada paso sea de la lista cerrada (`STEPS`) y recién entonces los corre en orden. A cada uno:
 *   · le pone las variables que pide el plan (`null` la saca) y las vuelve a como estaban al terminar;
 *   · le atrapa lo que escribe por la salida y por la de error, cada trozo con su canal y en el orden en que lo
 *     escribió, y su `process.exit`;
 *   · si tira, o llama a `process.exit`, cuenta como ese Node caído (el mensaje por la salida de error y salida 1; o
 *     el código de `process.exit`), y los pasos siguientes corren igual.
 * `apply-hooks` lee la configuración del arnés con la misma `cli` de `tycon-config.js`, en este proceso: suelto
 * lanzaba un Node por pregunta (dos).
 * Lo que un guion avisa «una vez por proceso» sale una vez por tanda, no una vez por paso.
 *
 * Quien la llama (el `.ps1`) reimprime la salida de cada paso donde antes estaba su llamada suelta. Si esta tanda no
 * está o no deja su resultado, hace las llamadas sueltas de antes: la tanda no saca ningún respaldo.
 *
 * Uso:  node scripts/setup/applier-batch.js --plan <plan.json> --out <resultado.json>
 *   plan:      { "steps": [ { "id": "skills", "script": "skills-dir", "args": ["--skills", "--installed"],
 *                             "env": { "TYCON_SKILLS_DIR": "" } }, … ] }
 *   resultado: { "complete": true, "steps": { "<id>": { "rc": 0, "stdout": "…", "stderr": "…", "chunks": ["o…", "e…"] } } }
 *              (en UTF-8, a un archivo y no por la salida: así no se mezcla con lo que escriben los pasos; cada trozo
 *              lleva su canal en la primera letra: `o` la salida, `e` la de error). Se escribe antes del primer paso y
 *              después de cada uno, con `complete: false` hasta el final: si algo se corta, lo que ya se hizo queda
 *              anotado, y quien lo lee sabe que los pasos que faltan no se anotaron.
 * Sale 0 si corrió el plan (aunque un paso haya salido distinto de 0); 2 si el plan está mal —un paso fuera de la
 * lista, un id repetido, un archivo que no es JSON—, sin correr ninguno ni escribir el resultado; 1 si no pudo escribir
 * el resultado (antes del primer paso: no corrió ninguno; después: se cortó ahí).
 */

const fs = require('fs');
const path = require('path');

/** La lista cerrada: cada paso, la función que corre su arranque como programa. */
const STEPS = {
  'skills-dir': () => require('../lib/skills-dir.js').cli,
  'tycon-config': () => require('../lib/tycon-config.js').cli,
  'legacy-names': () => require('../lib/legacy-names.js').cli,
  'canonical-path': () => require('../lib/canonical-path.js').cli,
  'install-third-party': () => require('../publishing/install-third-party.js').cli,
  'apply-hooks': () => {
    const applyHooks = require('./apply-hooks.js');
    return (argv) => applyHooks.cli(argv, { runConfig: configInProcess });
  },
};

class ExitSignal {
  constructor(code) { this.code = code; }
}
class PlanError extends Error {}

const joined = (chunks, kind) => chunks.filter((c) => c[0] === kind).map((c) => c[1]).join('');

/**
 * Corre `fn` con la salida, la salida de error y `process.exit` atrapados. Se puede anidar: cada nivel guarda lo que
 * había y lo devuelve al salir. `{ rc, stdout, stderr, chunks }`.
 */
function captured(fn) {
  const chunks = [];
  const saved = { out: process.stdout.write, err: process.stderr.write, exit: process.exit, exitCode: process.exitCode };
  const grab = (kind) => function write(chunk, encoding, callback) {
    chunks.push([kind, typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')]);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  process.stdout.write = grab('out');
  process.stderr.write = grab('err');
  process.exit = (code) => { throw new ExitSignal(code); };
  process.exitCode = undefined;
  let rc;
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // la tanda corre pasos sincrónicos: lo que una promesa haga después ya no tiene a quién escribirle
      chunks.push(['err', 'applier-batch: el paso devolvió una promesa y la tanda sólo corre pasos sincrónicos\n']);
      rc = 1;
    } else rc = typeof r === 'number' ? r : (process.exitCode || 0);
  } catch (e) {
    if (e instanceof ExitSignal) rc = e.code === undefined || e.code === null ? (process.exitCode || 0) : Number(e.code);
    else {
      // como un Node que se cae con un error sin atrapar: el error por la salida de error y salida 1
      chunks.push(['err', `${(e && e.stack) || e}\n`]);
      rc = 1;
    }
  } finally {
    process.stdout.write = saved.out;
    process.stderr.write = saved.err;
    process.exit = saved.exit;
    process.exitCode = saved.exitCode;
  }
  // un código que no es un entero (`process.exit('x')`) no puede leerse como éxito: cuenta como falla
  if (!Number.isInteger(rc)) rc = 1;
  return { rc, stdout: joined(chunks, 'out'), stderr: joined(chunks, 'err'), chunks };
}

/** `tycon-config.js <args>` en este proceso, con la forma de `spawnSync` que espera `readConfig` de apply-hooks.js. */
function configInProcess(args) {
  const r = captured(() => require('../lib/tycon-config.js').cli(args));
  return { status: r.rc, stdout: r.stdout, stderr: r.stderr };
}

/** El plan, revisado entero antes de correr nada. */
function checkPlan(plan, registry) {
  if (!plan || !Array.isArray(plan.steps)) throw new PlanError('el plan no trae una lista «steps»');
  const ids = new Set();
  for (const s of plan.steps) {
    if (!s || typeof s.id !== 'string' || !s.id) throw new PlanError('un paso sin «id»');
    if (ids.has(s.id)) throw new PlanError(`el id «${s.id}» está dos veces`);
    ids.add(s.id);
    if (!Object.prototype.hasOwnProperty.call(registry, s.script)) throw new PlanError(`el paso «${s.id}» pide «${s.script}», que no está en la lista (${Object.keys(registry).join(', ')})`);
    if (!Array.isArray(s.args) || s.args.some((a) => typeof a !== 'string')) throw new PlanError(`los argumentos del paso «${s.id}» no son una lista de textos`);
    const env = s.env === undefined ? {} : s.env;
    if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some((v) => v !== null && typeof v !== 'string')) {
      throw new PlanError(`las variables del paso «${s.id}» no son un objeto de textos (o null)`);
    }
  }
}

/**
 * Corre el plan (lo revisa entero antes) y devuelve `{ steps: { <id>: { rc, stdout, stderr, chunks } } }`.
 * `onStep(steps)` (opcional) se llama antes del primer paso y después de cada uno, con lo que va corrido: así queda
 * escrito lo que ya se hizo aunque algo falle después. Si tira, la tanda se corta ahí.
 */
function runPlan(plan, registry = STEPS, onStep = null) {
  checkPlan(plan, registry);
  const steps = {};
  if (onStep) onStep(steps);
  for (const s of plan.steps) {
    const before = {};
    for (const [k, v] of Object.entries(s.env || {})) {
      before[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
      if (v === null) delete process.env[k]; else process.env[k] = v;
    }
    try {
      steps[s.id] = captured(() => registry[s.script]()(s.args.slice()));
    } finally {
      for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    if (onStep) onStep(steps);
  }
  return { steps };
}

/**
 * El resultado, escrito entero y atómico. `complete: false` mientras la tanda corre: quien lo lee sabe que los pasos
 * que no están todavía no corrieron (o no se pudieron anotar), y que los que están, sí.
 */
function writeResult(outFile, steps, complete) {
  const out = {};
  // cada trozo como un texto con su canal en la primera letra (`o` salida, `e` error): PowerShell convierte en fecha un
  // texto JSON con forma de fecha, y con la letra delante ningún trozo la tiene
  for (const [id, r] of Object.entries(steps)) out[id] = Object.assign({}, r, { chunks: r.chunks.map(([k, t]) => (k === 'out' ? 'o' : 'e') + t) });
  const tmp = `${outFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ complete, steps: out })}\n`, 'utf8');
  fs.renameSync(tmp, path.resolve(outFile));
}

function main(argv) {
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
  const planFile = at('--plan');
  const outFile = at('--out');
  if (!planFile || !outFile) {
    process.stderr.write('uso: node applier-batch.js --plan <plan.json> --out <resultado.json>\n');
    return 2;
  }
  let plan;
  try {
    const raw = fs.readFileSync(planFile, 'utf8');
    plan = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);   // sin la marca de codificación, si la trae
    checkPlan(plan, STEPS);
  } catch (e) {
    process.stderr.write(`applier-batch: ${e instanceof PlanError || e instanceof SyntaxError ? e.message : (e.code || e.message)} — no corrí ningún paso\n`);
    return 2;
  }
  // el resultado se escribe antes del primer paso y después de cada uno (ver writeResult): si no se puede escribir antes
  // del primero, no corre nada; si deja de poder más adelante, la tanda se corta ahí y lo ya anotado sigue en el archivo
  let recorded = -1;   // pasos anotados; -1 = ni el arranque se pudo anotar
  let last = false;    // la escritura que falló, ¿fue la final (con todos los pasos ya anotados)?
  try {
    const { steps } = runPlan(plan, STEPS, (sofar) => { writeResult(outFile, sofar, false); recorded = Object.keys(sofar).length; });
    last = true;
    writeResult(outFile, steps, true);
  } catch (e) {
    const ran = last ? recorded : recorded + 1;
    process.stderr.write(`applier-batch: no pude escribir el resultado en ${outFile} (${e.code || e.message})${recorded < 0 ? ' — no corrí ningún paso' : ` — corrí ${ran} paso(s) y quedan anotados ${recorded}`}\n`);
    return 1;
  }
  return 0;
}

module.exports = { STEPS, runPlan, captured, configInProcess, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
