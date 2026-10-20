'use strict';
/**
 * review-rounds — el tope de vueltas de revisores de una historia y lo que pasa al llegar.
 *
 * Una vuelta es un número de iteración que llegó a lanzar revisores: la foto que el arnés toma al lanzar el último
 * (`marker.iterations[N]`). Al llegar al tope con algo abierto, un crítico de seguridad o de datos lo decide una persona
 * (una vuelta extra con su ok, o eximirlo); lo demás queda como deuda visible y el recorrido sigue.
 *
 *   · `tope({ repo, env, home, stateDir, sinMaquina })`: `{ value, source, problems }`. El ajuste de la máquina
 *     (`review-max-rounds.json` en la carpeta de estado del arnés, donde el agente no escribe; de 1 a 99) ›
 *     `review.max_rounds` del repo (`.tycon/advisors.yaml`, lo commiteado: bajar el tope afloja y aflojar exige commit) ›
 *     la organización (`review.max_rounds` de team-repos.json) › 2. Un valor fuera de 1 a 6 no se usa y lo dice.
 *   · `clase(regla, { prefijos })`: 'seguridad' | 'datos' | null.
 *   · `abiertos(hallazgos, opts)`: los hallazgos abiertos o diferidos, con `bloquea` en los críticos de esas clases.
 *   · `vueltas(marker)`: cuántas vueltas lanzaron revisores.
 *   · `extras({ stateDir, story })`: las vueltas extra que autorizó una persona (`extra-round` en gates.log).
 *   · `linea(...)`: «N vueltas de revisores (tope M); quedó abierto: …», la del cierre.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const FABRICA = 2;
const MINIMO = 1;
const MAXIMO = 6;
// lo que frena al tope sin la decisión de una persona (aprobado por la coordinadora, por delegación del dueño)
const PREFIJOS_FABRICA = Object.freeze({
  seguridad: Object.freeze(['SEC', 'TENANT', 'AUTH', 'NEXTSEC', 'SIGNALR-C']),
  datos: Object.freeze(['MIGRATION', 'DRIZZLE']),
});

const entero = (v) => {
  const n = typeof v === 'number' ? v : (/^\s*\d+\s*$/.test(String(v ?? '')) ? Number(String(v).trim()) : NaN);
  return Number.isInteger(n) ? n : null;
};
const enRango = (n) => n !== null && n >= MINIMO && n <= MAXIMO;

/** `review.max_rounds` de un texto de `.tycon/advisors.yaml` (el bloque `review:` de primer nivel), o undefined. */
function delYaml(txt) {
  if (!txt) return undefined;
  let enBloque = false;
  for (const linea of String(txt).split(/\r?\n/)) {
    if (/^\s*#/.test(linea) || !linea.trim()) continue;
    const sangria = linea.length - linea.trimStart().length;
    if (sangria === 0) { enBloque = /^review\s*:\s*(#.*)?$/.test(linea.trim()); continue; }
    if (!enBloque) continue;
    const m = linea.trim().match(/^max_rounds\s*:\s*([^#]*?)\s*(#.*)?$/);
    if (m) return m[1].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

/** La sección `review` de la organización (team-repos.json del árbol del arnés), o null, con sus problemas. */
function deLaOrganizacion({ env = process.env, home = os.homedir() } = {}) {
  const problems = [];
  try {
    const tree = require('./harness-path.js').rutaArnesHook({ env, home }).dir;
    const file = tree ? path.join(tree, 'team-repos.json') : null;
    const reader = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'team-repos.js');
    if (!file || !fs.existsSync(file) || !fs.existsSync(reader)) return { review: null, problems };
    const r = require(reader).parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const sec = r.sectionProblems && r.sectionProblems.review;
    if (!r.ok) problems.push(`${file}: no se pudo usar (${r.problems.map((p) => `${p.path || '(archivo)'}: ${p.message}`).join('; ').slice(0, 200)})`);
    else if (sec && sec.length) problems.push(`${sec[0].path}: ${sec[0].message}; no se usa`);
    else if (r.data && r.data.review && typeof r.data.review === 'object') return { review: r.data.review, problems };
  } catch (e) {
    problems.push(`no pude leer la configuración de la organización (${e && e.message ? e.message : e})`);
  }
  return { review: null, problems };
}

function tope({ repo, env = process.env, home = os.homedir(), stateDir, sinMaquina = false } = {}) {
  if (sinMaquina) return topeSinMaquina({ repo, env, home });
  return topeConMaquina({ repo, env, home, stateDir });
}
const ARCHIVO_MAQUINA = 'review-max-rounds.json';
function topeConMaquina({ repo, env, home, stateDir }) {
  const problems = [];
  const r = leerMaquina({ home, stateDir, problems });
  if (r) return r;
  const resto = topeSinMaquina({ repo, env, home });
  return { ...resto, problems: [...problems, ...resto.problems] };
}
function leerMaquina({ home, stateDir, problems }) {
  // El ajuste de la máquina vive en la carpeta de estado del arnés (review-max-rounds.json, { "max_rounds": N } de 1 a
  // 99), donde el agente no escribe: lo pone una persona en su terminal, o una prueba en su HOME temporal. Una variable
  // de ambiente la podría anteponer el propio agente al comando, y el tope dejaría de cortar.
  const archivo = path.join(stateDir || require('./state-dir.js').stateDir(home), ARCHIVO_MAQUINA);
  let crudo = null;
  try { crudo = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) {
    if (e && e.code !== 'ENOENT') problems.push(`${archivo}: no se lee (${e.message || e}); no se usa`);
  }
  if (crudo !== null) {
    const n = entero(crudo && crudo.max_rounds);
    if (n !== null && n >= MINIMO && n <= 99) return { value: n, source: 'maquina', problems };
    problems.push(`${archivo}: max_rounds tiene que ser un entero de ${MINIMO} a 99; no se usa`);
  }
  return null;
}
/** El tope sin el ajuste de la máquina: el repo › la organización › 2. */
function topeSinMaquina({ repo, env, home }) {
  const problems = [];
  if (repo) {
    let txt = null;
    try {
      const cs = require('./config-source.js');
      txt = cs.leerCommiteado(repo);
    } catch (e) { problems.push(`no pude leer .tycon/advisors.yaml commiteado (${e && e.message ? e.message : e}): no sé si el repo ajusta el tope`); }
    const v = delYaml(txt);
    if (v !== undefined) {
      const n = entero(v);
      if (enRango(n)) return { value: n, source: 'repo', problems };
      problems.push(`review.max_rounds de .tycon/advisors.yaml: tiene que ser un entero de ${MINIMO} a ${MAXIMO} (es ${JSON.stringify(v)}); no se usa`);
    }
  }
  const org = deLaOrganizacion({ env, home });
  problems.push(...org.problems);
  if (org.review && org.review.max_rounds !== undefined) {
    const n = entero(org.review.max_rounds);
    if (enRango(n)) return { value: n, source: 'organizacion', problems };
    problems.push(`review.max_rounds de la organización: tiene que ser un entero de ${MINIMO} a ${MAXIMO} (es ${JSON.stringify(org.review.max_rounds)}); no se usa`);
  }
  return { value: FABRICA, source: 'fabrica', problems };
}

/** Los prefijos que frenan: los de fábrica más los que suma la organización (`review.blocking_prefixes`, a seguridad). */
function prefijos(opts = {}) {
  const org = opts.review !== undefined ? { review: opts.review, problems: [] } : deLaOrganizacion(opts);
  const extra = org.review && Array.isArray(org.review.blocking_prefixes)
    ? org.review.blocking_prefixes.map((p) => String(p).trim().toUpperCase()).filter(Boolean) : [];
  // si no se pudo leer la configuración de la organización, frenan sólo los de fábrica, y se dice
  return { seguridad: [...PREFIJOS_FABRICA.seguridad, ...extra], datos: [...PREFIJOS_FABRICA.datos], problems: org.problems || [] };
}

const reglaDe = (f) => String((f && (f.rule_id || f.ruleId || f.rule)) || '').trim().toUpperCase();
const coincide = (regla, p) => (/-[CW]$/.test(p) ? regla.startsWith(p) : regla === p || regla.startsWith(`${p}-`));

function clase(regla, { prefijos: pre } = {}) {
  const r = String(regla || '').trim().toUpperCase();
  const lista = pre || prefijos();
  if (lista.seguridad.some((p) => coincide(r, p))) return 'seguridad';
  if (lista.datos.some((p) => coincide(r, p))) return 'datos';
  return null;
}

const ABIERTO = new Set(['open', 'deferred']);

/** Los hallazgos abiertos o diferidos; `bloquea` en un crítico de seguridad o de datos (venga del revisor o del pase adversarial). */
function abiertos(hallazgos, opts = {}) {
  const pre = opts.prefijos || prefijos(opts);
  return (hallazgos || [])
    .filter((f) => f && ABIERTO.has(String(f.disposition || 'open').trim().toLowerCase()))
    .map((f) => {
      const regla = reglaDe(f);
      const cl = clase(regla, { prefijos: pre });
      const critico = String(f.severity || '').trim().toUpperCase() === 'CRITICAL';
      return { regla: regla || '(sin regla)', file: f.file || '', severidad: critico ? 'CRITICAL' : 'WARNING', clase: cl, bloquea: critico && !!cl,
        deuda: f.deuda || null, resumen: String(f.reason || f.summary || '').replace(/\s+/g, ' ').slice(0, 120) };
    });
}

/** Los hallazgos de `findings.json` de la corrida: `{ lista, existe, error? }`. */
function hallazgosDe(runDir) {
  if (!runDir) return { lista: [], existe: false };
  try {
    const data = JSON.parse(fs.readFileSync(path.join(runDir, 'findings.json'), 'utf8'));
    const lista = Array.isArray(data) ? data : (data && Array.isArray(data.findings) ? data.findings : null);
    return lista ? { lista, existe: true } : { lista: [], existe: true, error: 'findings.json no es una lista de hallazgos' };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { lista: [], existe: false };
    return { lista: [], existe: true, error: `findings.json no se lee (${e.message || e})` };
  }
}

/** Cuántas vueltas lanzaron revisores: las fotos del marcador (una por iteración, la toma el arnés). */
function vueltas(marker) {
  return Object.keys((marker && marker.iterations) || {}).filter((k) => Number.isInteger(Number(k)) && Number(k) >= 1).length;
}
/** ¿La vuelta N llegó a lanzar revisores? */
function lanzada(marker, n) { return !!(marker && marker.iterations && marker.iterations[n]); }

/** Las vueltas extra que autorizó una persona para esta historia: `[{ iter, quien, cita, ts }]`. */
function extras({ stateDir, story }) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const l of txt.split('\n')) {
    if (!l.trim()) continue;
    let g; try { g = JSON.parse(l); } catch (_) { continue; }
    if (g && g.name === 'extra-round' && String(g.story) === String(story) && Number.isInteger(g.iter)) out.push(g);
  }
  return out;
}

/** El último aviso del tope que el arnés le mostró para esa vuelta de esa historia (`review-cap-shown`), o null. */
function avisoDelTope({ stateDir, story, iter }) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8'); } catch (_) { return null; }
  let ultimo = null;
  for (const l of txt.split('\n')) {
    if (!l.trim()) continue;
    let g; try { g = JSON.parse(l); } catch (_) { continue; }
    if (g && g.name === 'review-cap-shown' && String(g.story) === String(story) && g.iter === iter) ultimo = g;
  }
  return ultimo;
}

// el sí a otra vuelta: nombra la vuelta («otra vuelta», «una vuelta más», «vuelta extra») sin negarla ni preguntar
const RE_VUELTA = /(?<![\p{L}\p{N}])(?:otra\s+vuelta|una\s+vuelta\s+m[aá]s|vuelta\s+(?:extra|m[aá]s|adicional))(?![\p{L}\p{N}])/iu;
const RE_NO_VUELTA = /(?<![\p{L}\p{N}])(?:no|ni|nunca|sin)\s+(?:(?:quiero|hagas|hace\s+falta|va|vamos\s+a\s+hacer)\s+)?(?:otra|una|m[aá]s)?\s*vuelta/iu;
/** ¿El mensaje autoriza otra vuelta, sin negarla ni preguntar? `(texto) => null | motivo`. */
function juezDeLaVuelta() {
  const f = (texto) => {
    const t = String(texto || '');
    if (RE_NO_VUELTA.test(t)) return 'el mensaje dice que no a otra vuelta';
    if (/[¿?]/.test(t)) return 'el mensaje pregunta: una pregunta no es un ok';
    if (!RE_VUELTA.test(t)) return 'el mensaje no autoriza otra vuelta: tiene que decirlo, por ejemplo «dale, una vuelta más»';
    return null;
  };
  f.retracta = (texto) => RE_NO_VUELTA.test(String(texto || ''));
  return f;
}

function resumen(lista) {
  return lista.map((a) => `${a.regla}${a.file ? ` en ${a.file}` : ''}${a.resumen ? ` — ${a.resumen}` : ''}`);
}

/** La línea del cierre. Con `noMirado` (no se pudieron leer los hallazgos) no dice «nada»: dice que no se pudo mirar. */
function linea({ n, max, abiertos: ab, noMirado, de }) {
  // un tope que puso el ajuste de la máquina se dice: no es el de la organización ni el del repo
  if (de === 'maquina') max = `${max}, puesto por el ajuste de esta máquina`;
  if (noMirado) return `${n} ${n === 1 ? 'vuelta' : 'vueltas'} de revisores (tope ${max}); lo abierto no lo pude mirar: ${noMirado}.`;
  const lista = ab || [];
  const bloq = lista.filter((a) => a.bloquea);
  const deuda = lista.filter((a) => !a.bloquea);
  const partes = [];
  if (bloq.length) partes.push(`${bloq.length} de seguridad o datos sin decidir (${bloq.map((a) => a.regla).join(', ')})`);
  if (deuda.length) partes.push(`${deuda.length} como deuda (${deuda.map((a) => a.regla).join(', ')})`);
  return `${n} ${n === 1 ? 'vuelta' : 'vueltas'} de revisores (tope ${max}); quedó abierto: ${partes.length ? partes.join('; ') : 'nada'}.`;
}

module.exports = { FABRICA, MINIMO, MAXIMO, PREFIJOS_FABRICA, delYaml, tope, prefijos, clase, abiertos, hallazgosDe, vueltas, lanzada, extras, avisoDelTope, juezDeLaVuelta, resumen, linea };
