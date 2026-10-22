'use strict';
/**
 * refutation — la constancia de un «falso» (un hallazgo descartado) y su validación.
 *
 * Un hallazgo sólo queda como falso (`disposition: refuted`) si lo confirma un verificador
 * independiente que CORRIÓ el código: otro agente, sin el contexto de la implementación, que intenta
 * reproducir el hallazgo con una prueba real. Quien implementó propone «falso» con su motivo; no lo
 * decide. Esta lib arma y valida lo que el verificador deja:
 *
 *   · el hallazgo (revisor, regla, archivo, línea) y el motivo del autor;
 *   · quién verificó (id del lanzamiento y modelo): tiene que ser otro agente que el que implementó;
 *   · el veredicto: `refutado` (no se da) o `reproducido` (el hallazgo es real);
 *   · el comando que corrió, su salida recortada a 8 KB y la huella sha256 de lo que se guardó.
 *
 * El criterio es el del pase adversarial: ante la duda, `reproducido`. Un verificador que no trae el
 * comando y la salida con que probó que el hallazgo no se da no refuta nada.
 *
 * La constancia completa vive en `<corrida>/refutations/<id>.json`. En `findings.json` (lo único que
 * viaja por git) queda un resumen por hallazgo —veredicto, verificador, comando y huella—, de donde
 * salen la tasa por revisor y las dudas repetidas del resumen de la mañana.
 *
 * El id del verificador es el del lanzamiento en el registro de spawns del hook `on-advisor-run.js`:
 * `<agente>@<ts>` de la línea que escribió al lanzarlo.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const OUTPUT_MAX_BYTES = 8192;
const VERDICTS = ['refutado', 'reproducido'];
const RUNS_WINDOW = 20;
const RATE_THRESHOLD = 0.3;
// Con menos hallazgos que esto una tasa no dice nada: 1 falso de 2 no es un revisor ruidoso.
const RATE_MIN_SAMPLE = 5;
// Nombres con que el orquestador se llama a sí mismo: nunca son un verificador.
const IMPLEMENTER_NAMES = /^(orquestador|orchestrator|sesion-principal|sesión principal|main|principal)(\s|\(|@|$)/i;

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const text = (x) => (typeof x === 'string' ? x.trim() : '');

/** Recorta a OUTPUT_MAX_BYTES sin partir un carácter de varios bytes. */
function trimOutput(raw) {
  const s = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= OUTPUT_MAX_BYTES) return { output: s, truncated: false };
  let end = OUTPUT_MAX_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { output: buf.subarray(0, end).toString('utf8'), truncated: true };
}

/** El nombre del archivo de la constancia de un hallazgo: legible y sin colisiones. */
// Un hallazgo es la tupla (revisor, regla, archivo, línea). Sin línea entera no hay identidad completa: el id lleva
// `sinlinea` y ninguna constancia puede coincidir con él (`sameFinding` exige la línea), así que no hay «falso» posible.
// LA identidad de un hallazgo se normaliza en UN solo lugar: el revisor sin la anotación que el orquestador le pega
// («x (sonnet)», «x (iter 2)»), el resto sin espacios. Escribir (record-refutation, verify-finding, idOf, build) y leer
// (sameFinding, blocksDismissal, write-findings) pasan por acá; si no, la constancia se guarda con un nombre y se busca con otro.
// Mayúsculas y forma de la ruta tampoco cambian el hallazgo: `SEC-C1` y `sec-c1`, `./src/a.js`, `src//a.js` y
// `src\a.js` son el mismo. Se comparan en minúsculas y con la ruta normalizada (barras hacia adelante, sin `./`).
function normPath(p) {
  const s = text(p).replace(/\\/g, '/');
  if (!s) return '';
  return path.posix.normalize(s).replace(/^(\.\/)+/, '').toLowerCase();
}
function identity(f) {
  const x = f || {};
  const rev = text(x.reviewer !== undefined ? x.reviewer : x.advisor);
  return { reviewer: text(require('./review-roster.js').separarAnotacion(rev).advisor).toLowerCase(),
    rule: text(x.rule !== undefined ? x.rule : x.rule_id).toLowerCase(), file: normPath(x.file), line: x.line };
}
const lineOf = (f) => (f && Number.isInteger(f.line) && f.line >= 0 ? f.line : null);

/** ¿Es la constancia de ESTE hallazgo? Revisor, regla, archivo y línea iguales; sin línea nunca coincide. */
function sameFinding(a, b) {
  const x = identity(a); const y = identity(b);
  const lx = lineOf(x); const ly = lineOf(y);
  return text(x.reviewer) === text(y.reviewer) && text(x.rule) === text(y.rule) && text(x.file) === text(y.file)
    && lx !== null && lx === ly;
}

function idOf(finding) {
  const f = identity(finding);
  const l = lineOf(f);
  const crudo = `${text(f.reviewer)}__${text(f.rule)}__${text(f.file)}__${l === null ? 'sinlinea' : `L${l}`}`;
  const slug = crudo.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100);
  return `${slug || 'finding'}-${sha256(crudo).slice(0, 8)}`;
}

/**
 * Arma la constancia.
 * @param {object} o
 * @param {{reviewer:string, rule:string, file:string, line:number}} o.finding
 * @param {string} o.authorReason  el motivo con que el autor propone descartarlo
 * @param {{agent:string, model:string}} o.verifier
 * @param {'refutado'|'reproducido'} o.verdict
 * @param {string} o.command       lo que corrió el verificador
 * @param {string} o.output        lo que vio (se recorta a 8 KB)
 * @param {string} [o.ts]
 */
function build(o) {
  const f = identity(o && o.finding);
  const v = (o && o.verifier) || {};
  const { output, truncated } = trimOutput(o && o.output);
  return {
    version: VERSION,
    id: idOf(f),
    finding: { reviewer: f.reviewer, rule: f.rule, file: f.file, line: f.line },
    author_reason: text(o && o.authorReason),
    verifier: { agent: text(v.agent), model: text(v.model) },
    verdict: o && o.verdict,
    command: text(o && o.command),
    output,
    output_truncated: truncated,
    output_sha256: sha256(output),
    ts: (o && o.ts) || new Date().toISOString(),
  };
}

/**
 * ¿La constancia vale? `faltan` lista los campos que no están; `errores` dice por qué no vale cuando
 * no es un campo que falta (el verificador es quien implementó, la huella no corresponde).
 * @param {object} c
 * @param {{implementer?: string|{session_id?:string}|null, finding?: object}} [opts]  quién implementó; el hallazgo que se juzga
 */
function validate(c, opts) {
  const faltan = [];
  const errores = [];
  const x = c && typeof c === 'object' ? c : {};
  const fin = x.finding && typeof x.finding === 'object' ? x.finding : {};
  const ver = x.verifier && typeof x.verifier === 'object' ? x.verifier : {};
  if (!text(fin.reviewer)) faltan.push('finding.reviewer');
  if (!text(fin.rule)) faltan.push('finding.rule');
  if (!text(fin.file)) faltan.push('finding.file');
  if (!Number.isInteger(fin.line) || fin.line < 0) faltan.push('finding.line');
  if (!text(x.author_reason)) faltan.push('author_reason');
  if (!text(ver.agent)) faltan.push('verifier.agent');
  if (!text(ver.model)) faltan.push('verifier.model');
  if (!VERDICTS.includes(x.verdict)) faltan.push('verdict');
  if (!text(x.command)) faltan.push('command');
  if (!text(x.output)) faltan.push('output');
  if (typeof x.output === 'string' && text(x.output)) {
    if (Buffer.byteLength(x.output, 'utf8') > OUTPUT_MAX_BYTES) errores.push(`la salida guardada pasa de ${OUTPUT_MAX_BYTES} bytes`);
    if (x.output_sha256 !== sha256(x.output)) errores.push('la huella (output_sha256) no corresponde a la salida guardada');
  } else if (!text(x.output_sha256)) faltan.push('output_sha256');

  // La constancia vale para UN hallazgo: si se juzga otro (distinta línea, regla, archivo o revisor), no vale.
  if (opts && opts.finding && !sameFinding(fin, opts.finding)) {
    errores.push('la constancia es de otro hallazgo (revisor, regla, archivo y línea tienen que coincidir con el que se juzga)');
  }
  const impl = opts && opts.implementer;
  const implementerId = text(typeof impl === 'string' ? impl : impl && impl.session_id);
  const agente = text(ver.agent);
  if (agente && ((implementerId && agente === implementerId) || IMPLEMENTER_NAMES.test(agente))) {
    errores.push('el verificador tiene que ser otro: la constancia la firma el mismo agente que implementó');
  }
  return { ok: faltan.length === 0 && errores.length === 0, faltan, errores };
}

/**
 * El veredicto a partir de lo que devolvió el verificador. Sólo es `refutado` si dice que refutó Y trae el
 * comando y la salida con que lo demostró; todo lo demás es `reproducido`.
 * @param {{refuted?:boolean, command?:string, output?:string}|null} result
 */
function decide(result) {
  const r = result && typeof result === 'object' ? result : {};
  return r.refuted === true && text(r.command) && text(r.output) ? 'refutado' : 'reproducido';
}

const COMMAND_SUMMARY_MAX = 200;
// Lo que huele a credencial en un comando: no viaja a `findings.json` (que va a git).
const SECRETOS = [
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, '[oculto]'],
  [/\bAKIA[0-9A-Z]{12,}\b/g, '[oculto]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[oculto]'],
  [/\b(Bearer|Basic)\s+[^\s"']+/gi, '$1 [oculto]'],
  [/\b((?:pass(?:word)?|pwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s"'&;]+/gi, '$1[oculto]'],
];

/** El comando para `findings.json`: una línea, sin credenciales a la vista y acotado a 200 caracteres. */
function commandForSummary(command) {
  let s = text(command).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ');
  for (const [re, por] of SECRETOS) s = s.replace(re, por);
  return s.length > COMMAND_SUMMARY_MAX ? `${s.slice(0, COMMAND_SUMMARY_MAX - 1)}…` : s;
}

/** Lo que `findings.json` guarda de la constancia: lo suficiente para medir, nada de la salida y el comando acotado. */
function summary(c) {
  return {
    verdict: c.verdict,
    verifier: c.verifier.agent,
    model: c.verifier.model,
    command: commandForSummary(c.command),
    output_sha256: c.output_sha256,
  };
}

function constanciaPath(runDir, finding) { return path.join(runDir, 'refutations', `${idOf(finding)}.json`); }

/**
 * Lee la constancia de un hallazgo y dice en qué estado está: `no-existe` (nadie la escribió), `rota` (está y no se
 * puede leer: no se puede descartar que diga «reproducido») u `ok`.
 * @returns {{estado:'no-existe'|'rota'|'ok', constancia:object|null, motivo:string|null}}
 */
function readConstancia(runDir, finding) {
  let raw;
  try { raw = fs.readFileSync(constanciaPath(runDir, finding), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { estado: 'no-existe', constancia: null, motivo: null };
    return { estado: 'rota', constancia: null, motivo: `no se pudo leer (${e && e.code ? e.code : 'error'})` };
  }
  try {
    const c = JSON.parse(raw);
    if (!c || typeof c !== 'object' || Array.isArray(c)) return { estado: 'rota', constancia: null, motivo: 'no es un objeto JSON' };
    return { estado: 'ok', constancia: c, motivo: null };
  } catch (e) { return { estado: 'rota', constancia: null, motivo: `JSON inválido (${String(e.message).slice(0, 80)})` }; }
}

/**
 * LA regla, en un solo lugar: un hallazgo con una constancia «reproducido» —o una que no se puede leer, o está mal
 * formada (veredicto que no es refutado/reproducido, hallazgo sin revisor, regla o archivo), o si no se puede leer la
 * carpeta— no se puede dejar como `refuted` ni `waived`, esté la constancia en la línea que esté, con el nombre que tenga
 * y se haya escrito en el orden que se haya escrito. Mira TODAS las constancias del mismo revisor, regla y archivo.
 * Una ilegible o rota cuenta si su nombre es el de ese revisor, regla y archivo (el contenido roto no dice de quién es).
 * @returns {{blocks: boolean, motivos: string[]}}
 */
function blocksDismissal(runDir, finding) {
  const motivos = [];
  const dir = path.join(runDir, 'refutations');
  let names;
  try { names = fs.readdirSync(dir); } catch (e) {
    if (e && e.code === 'ENOENT') return { blocks: false, motivos };
    return { blocks: true, motivos: [`no se pudo leer la carpeta de constancias (${e && e.code ? e.code : 'error'}): no se puede descartar que haya una «reproducido»`] };
  }
  const f = identity(finding);
  const base = `${f.reviewer}__${f.rule}__${f.file}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const delNombre = (n) => base.length >= 90 ? n.startsWith(base.slice(0, 90))
    : new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}__(l\\d+|sinlinea)-[0-9a-f]{8}\\.json$`).test(n);
  for (const n of names.filter((x) => x.endsWith('.json')).sort()) {
    const suyo = delNombre(n);
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { c = undefined; }
    if (c === undefined || !c || typeof c !== 'object' || Array.isArray(c)) {
      if (suyo) motivos.push(`constancia ilegible (${n}): no se puede descartar que diga «reproducido»`);
      continue;
    }
    const x = identity(c.finding && typeof c.finding === 'object' ? c.finding : {});
    const mal = !VERDICTS.includes(c.verdict) || !x.reviewer || !x.rule || !x.file;
    const mismo = x.reviewer === f.reviewer && x.rule === f.rule && x.file === f.file;
    if (mal && (suyo || mismo)) motivos.push(`constancia mal escrita (${n}): ${!VERDICTS.includes(c.verdict) ? 'su veredicto no es refutado ni reproducido' : 'su hallazgo no trae revisor, regla y archivo'}; se trata como «reproducido»`);
    else if (c.verdict === 'reproducido' && (mismo || n === `${idOf(f)}.json`)) {
      motivos.push(`hay una constancia «reproducido» (${n}, línea ${x.line}, verificador ${c.verifier && c.verifier.agent})`);
    }
  }
  return { blocks: motivos.length > 0, motivos };
}

/** La constancia de un hallazgo; `null` si no hay O si está rota (quien necesite distinguir usa `readConstancia`). */
function load(runDir, finding) { return readConstancia(runDir, finding).constancia; }

/** El sello de una carpeta de corrida (`<clave>-<YYYYMMDDHHMMSS>`) como fecha, o `null`. */
function stampOf(name) {
  const m = String(name).match(/-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(t) ? t : null;
}

/**
 * Las carpetas de corrida con su `findings.json` leído, de la más nueva a la más vieja, y cuántas NO se pudieron leer.
 * Una corrida sin `findings.json` todavía no es una corrida rota (el archivo se escribe al cerrar el paso de hallazgos); un
 * `findings.json` que está y no se lee, o que no es un array, sí: cuenta en `noLeidas`, nunca como corrida vacía.
 * `null` si no se puede leer la carpeta de corridas.
 */
function readRuns(runsDir) {
  let names;
  try { names = fs.readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return null; }
  const runs = [];
  let noLeidas = 0;
  for (const name of names) {
    const dir = path.join(runsDir, name);
    let findings;
    try { findings = JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8')); } catch (e) {
      if (!(e && e.code === 'ENOENT')) noLeidas++;
      continue;
    }
    if (!Array.isArray(findings)) { noLeidas++; continue; }
    let t = stampOf(name);
    if (t === null) { try { t = fs.statSync(dir).mtimeMs; } catch { t = 0; } }
    runs.push({ name, dir, t, findings: findings.filter((f) => f && typeof f === 'object') });
  }
  runs.sort((a, b) => b.t - a.t || (a.name < b.name ? 1 : -1));
  return { runs, noLeidas };
}

const SIN_LEGIBLES = (n) => `no se pudo leer ninguna de las ${n} corrida(s) con findings.json: están rotas o no son un array`;

const confirmedFalse = (f) => f.disposition === 'refuted' && !!f.refutation && f.refutation.verdict === 'refutado';

/**
 * La tasa de falsas alarmas por revisor sobre las últimas 20 corridas: «falsos» confirmados por un verificador
 * sobre los hallazgos del revisor. Un `refuted` sin constancia no suma. `flagged` = más del 30 % (con al menos
 * 5 hallazgos): el revisor queda marcado para revisión; no se apaga solo.
 * Las corridas con `findings.json` roto o ilegible no se cuentan como vacías: `no_leidas` dice cuántas fueron, y si
 * ninguna se pudo leer el resultado es `valor: null` con su motivo (nunca una tasa 0).
 * @returns {{valor: Array<{reviewer:string,total:number,refuted:number,rate:number,flagged:boolean}>|null, motivo: string|null, no_leidas: number}}
 */
function reviewerRates(runsDir, opts) {
  const o = opts || {};
  const leido = readRuns(runsDir);
  if (!leido) return { valor: null, motivo: 'no se pudo leer la carpeta de corridas del repo', no_leidas: 0 };
  if (!leido.runs.length && leido.noLeidas) return { valor: null, motivo: SIN_LEGIBLES(leido.noLeidas), no_leidas: leido.noLeidas };
  const por = new Map();
  for (const run of leido.runs.slice(0, o.limit || RUNS_WINDOW)) {
    for (const f of run.findings) {
      const reviewer = text(f.advisor);
      if (!reviewer) continue;
      const r = por.get(reviewer) || { reviewer, total: 0, refuted: 0 };
      r.total++;
      if (confirmedFalse(f)) r.refuted++;
      por.set(reviewer, r);
    }
  }
  const umbral = o.threshold === undefined ? RATE_THRESHOLD : o.threshold;
  const minimo = o.minSample === undefined ? RATE_MIN_SAMPLE : o.minSample;
  const valor = [...por.values()].map((r) => ({ ...r, rate: r.total ? r.refuted / r.total : 0 }))
    .map((r) => ({ ...r, flagged: r.total >= minimo && r.rate > umbral }))
    .sort((a, b) => b.rate - a.rate || (a.reviewer < b.reviewer ? -1 : 1));
  return { valor, motivo: null, no_leidas: leido.noLeidas };
}

/**
 * Las dudas repetidas de los últimos `days` días hasta `today` (YYYY-MM-DD): la misma (revisor, regla) con dos o
 * más «falsos» confirmados, o con dos o más desacuerdos (el verificador reprodujo lo que el autor quería
 * descartar). `null` con motivo si no se puede leer la carpeta de corridas o si ninguna corrida se pudo leer; `no_leidas`
 * dice cuántas tenían un `findings.json` roto (no son corridas sin dudas).
 * @returns {{valor: Array|null, motivo: string|null, no_leidas: number}}
 */
function repeatedDoubts(runsDir, today, days) {
  const leido = readRuns(runsDir);
  if (!leido) return { valor: null, motivo: 'no se pudo leer la carpeta de corridas del repo', no_leidas: 0 };
  const { runs, noLeidas } = leido;
  if (!runs.length && noLeidas) return { valor: null, motivo: SIN_LEGIBLES(noLeidas), no_leidas: noLeidas };
  const hasta = Date.parse(`${today}T23:59:59Z`);
  if (!Number.isFinite(hasta)) return { valor: null, motivo: 'la fecha de hoy no es una fecha', no_leidas: noLeidas };
  const desde = hasta - (days || 7) * 86400000;
  const por = new Map();
  for (const run of runs) {
    if (run.t < desde || run.t > hasta) continue;
    for (const f of run.findings) {
      const v = f.refutation && f.refutation.verdict;
      if (v !== 'refutado' && v !== 'reproducido') continue;
      if (v === 'refutado' && f.disposition !== 'refuted') continue;
      const k = `${text(f.advisor)}\u0000${text(f.rule_id)}`;
      const r = por.get(k) || { revisor: text(f.advisor), regla: text(f.rule_id), falsos: 0, desacuerdos: 0 };
      if (v === 'refutado') r.falsos++; else r.desacuerdos++;
      por.set(k, r);
    }
  }
  const valor = [...por.values()].filter((r) => r.falsos >= 2 || r.desacuerdos >= 2)
    .sort((a, b) => (a.revisor < b.revisor ? -1 : a.revisor > b.revisor ? 1 : a.regla < b.regla ? -1 : a.regla > b.regla ? 1 : 0));
  return { valor, motivo: null, no_leidas: noLeidas };
}

module.exports = {
  VERSION, OUTPUT_MAX_BYTES, VERDICTS, RUNS_WINDOW, RATE_THRESHOLD, RATE_MIN_SAMPLE,
  build, validate, sameFinding, decide, summary, commandForSummary, COMMAND_SUMMARY_MAX, idOf, constanciaPath, load, readConstancia, blocksDismissal, identity, trimOutput, reviewerRates, repeatedDoubts, confirmedFalse,
};
