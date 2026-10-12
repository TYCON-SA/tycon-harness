#!/usr/bin/env node
/**
 * reviewer-rules.js — al commitear un `CLAUDE.md`, AVISA si una línea nueva parece una regla de
 * revisión y quedó FUERA de la sección `## Reglas para revisores`. Nunca frena (story 7.5, 2026-09-19).
 *
 * Por qué: desde la 7.5 los revisores del pipeline ya no cargan el `CLAUDE.md` (`omitClaudeMd`); las
 * reglas propias del repo les llegan SÓLO por esa sección, que `pipeline.js` pega al principio de su
 * contexto. Una regla escrita en otra parte del archivo el revisor no la ve. Nadie tiene que acordarse
 * de mantener un archivo aparte —la sección vive en el mismo `CLAUDE.md`—, pero sí de escribir la regla
 * en el lugar correcto: este aviso es el que se acuerda.
 * Convención y cómo se escribe una regla verificable: guides/reglas-para-revisores.md
 *
 * Qué mira: sólo las líneas AGREGADAS (`git diff --cached -U0`) de `CLAUDE.md` o `.claude/CLAUDE.md`
 * en la raíz del repo, fuera de la sección, que no sean vacías ni un título.
 *
 *   · Con `TYPESAFE_API_KEY`: UN pedido por commit a TypeSafe (`POST /v1/systemone`, tope 5 s) con una pregunta
 *     por línea —«¿es una regla que un revisor de código debería verificar?»—, y avisa las que dan
 *     ≥ 0,5. Cada línea sale TACHADA: `sanear()` de metrics/tokens-digest.js (credenciales, rutas,
 *     correos) + la lista de nombres de productos y clientes de la guía.
 *   · Sin llave, o si TypeSafe no contesta / da error: avisa por TODA línea candidata y dice por qué.
 *
 * Lo que imprime también va tachado: nunca una credencial ni un nombre de la lista en la terminal.
 * Se mide: una línea por archivo en ~/.claude/.tycon-pipeline/reviewer-rules.jsonl (conteos, sin texto).
 *
 * Uso:     node reviewer-rules.js --staged [--repo <dir>]
 * Apagado: TYCON_REVIEWER_RULES=0 · modelo: TYCON_TYPESAFE_MODEL (default jev-latest)
 * Sale SIEMPRE 0: es un aviso. Red: scripts/tests/reviewer-rules.test.sh
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { spawnSync } = require('child_process');
const { readEnv, prepareStateWrite, LegacyNamesError } = require('../lib/legacy-names.js');

const ARCHIVOS = ['CLAUDE.md', '.claude/CLAUDE.md'];
const DENIED = path.join(__dirname, '..', 'publishing', 'denylist.json');
const URL_TYPESAFE = 'https://api.typesafe.ai/v1/systemone';
const TOPE_MS = 5000;
const UMBRAL = 0.5;
const PREGUNTA = 'La línea en `state.{id}` viene del CLAUDE.md de un repo (está en castellano). '
  + '¿Es una regla que un revisor de código debería verificar al revisar un cambio?';

// Mismo criterio que `lib/reviewer-rules.js` de tycon-pipeline (agent-skills): encabezado exacto de
// nivel 2, termina en el próximo # o ##, las cercas de código no cortan. Duplicado a propósito: este
// script corre en el pre-commit de CUALQUIER repo y no puede depender de dónde está agent-skills.
// Los dos están cubiertos por su test con el mismo caso (T1 y T10).
const ENCABEZADO_RE = /^##\s+Reglas para revisores\s*$/;
const CORTE_RE = /^#{1,2}\s/;
const CERCA_RE = /^\s*(```|~~~)/;

/**
 * Índice (0-based) del encabezado, o -1. Un encabezado dentro de una cerca cerrada (un ejemplo) no
 * cuenta; con una cerca SIN CERRAR en el archivo el estado de cerca no es confiable y se busca sin
 * mirar cercas — si no, una cerca abierta en una sección anterior escondía la sección real (pase
 * adversarial de la 7.5).
 */
function lineaDelEncabezado(lineas) {
  let enCerca = false;
  for (let i = 0; i < lineas.length; i++) {
    if (CERCA_RE.test(lineas[i])) { enCerca = !enCerca; continue; }
    if (!enCerca && ENCABEZADO_RE.test(lineas[i])) return i;
  }
  if (!enCerca) return -1;
  return lineas.findIndex((l) => ENCABEZADO_RE.test(l));
}

/** Rango de la sección en líneas 1-based [desde, hasta], o null si no está. */
function rangoSeccion(md) {
  const lineas = md.split(/\r?\n/);
  const i0 = lineaDelEncabezado(lineas);
  if (i0 < 0) return null;
  let enCerca = false; // dentro de la sección el estado de cerca arranca de cero
  for (let i = i0 + 1; i < lineas.length; i++) {
    if (CERCA_RE.test(lineas[i])) { enCerca = !enCerca; continue; }
    if (!enCerca && CORTE_RE.test(lineas[i])) return [i0 + 1, i];
  }
  return [i0 + 1, lineas.length];
}

/** Líneas agregadas de un `git diff -U0`, con su número en el archivo nuevo. */
function lineasAgregadas(diff) {
  const out = [];
  let n = null;
  for (const l of String(diff || '').split('\n')) {
    // `--- a/…` / `+++ b/…` sólo existen ANTES del primer hunk de cada archivo: adentro de un hunk,
    // una línea agregada que empieza con «++» es contenido (pase adversarial de la 7.5).
    if (l.startsWith('diff --git ')) { n = null; continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { n = Number(h[1]); continue; }
    if (n === null) continue;
    if (l.startsWith('+')) { out.push({ n, texto: l.slice(1) }); n++; }
    else if (!l.startsWith('-') && !l.startsWith('\\')) n++;
  }
  return out;
}

/** Candidatas: agregadas, fuera de la sección, no vacías, no títulos, no marcas de cerca. */
function candidatas(md, diff) {
  const rango = rangoSeccion(md);
  return {
    tieneSeccion: rango !== null,
    lineas: lineasAgregadas(diff).filter(({ n, texto }) => {
      if (rango && n >= rango[0] && n <= rango[1]) return false;
      const t = texto.trim();
      return t && !/^#{1,6}\s/.test(t) && !CERCA_RE.test(t);
    }),
  };
}

/**
 * Los nombres de productos y clientes que se tachan: las reglas `cliente` de la lista de denegación
 * (story 8.10, AC 24 — antes era un bloque de la guía, una segunda lista que se desfasaba de la primera),
 * compiladas por el MISMO detector que usan el freno y el exportador: la grafía de cada término con sus
 * reglas `palabra` y `mayusculas`, y las variantes que el detector cuenta como el mismo nombre (story 8.4,
 * AC 30: otra caja en un identificador, todo en mayúsculas, el compuesto separado en partes). Re-derivar
 * el emparejamiento acá dejaba pasar esas formas a TypeSafe (pase adversarial de la tanda B).
 * Devuelve `{ reglas }` o `{ motivo }`. Sin lista NO se manda nada a TypeSafe (el llamador cae al
 * modo sin llave y lo dice): mandar sin tachar los nombres es justo lo que la story prohíbe, y una
 * lista vacía se veía igual que «no hay nombres» (hallazgo SILENT-C2 del paso 5 de la 7.5). La copia
 * pública no trae la lista (es privada): ahí no se manda nada, como antes sin el bloque.
 * El motivo nunca cita el contenido de la lista (es privada): sólo el código del error.
 */
function nombresATachar(deniedList = DENIED) {
  let cfg;
  let genericos;
  try {
    const detector = require('../publishing/detector.js');
    cfg = detector.cargarConfig(deniedList);
    genericos = new Set(detector.PATRONES_GENERICOS);
  } catch (e) {
    const codigo = e && e.message && /ENOENT|EACCES|EISDIR/.exec(e.message);
    return { motivo: `no pude leer la lista de nombres a tachar (${codigo ? codigo[0] : 'la lista no sirve'})` };
  }
  // Sólo los términos de la LISTA: un patrón genérico de categoría cliente (el sufijo de organización en un nombre
  // de proceso, story 8.6) no es un nombre, y contarlo haría que una lista sin nombres pareciera tener.
  const reglas = cfg.reglas.filter((r) => r.categoria === 'cliente' && !genericos.has(r));
  if (!reglas.length) return { motivo: 'la lista de denegación no trae términos «cliente» (los nombres a tachar)' };
  return { reglas };
}

/**
 * sanear() + las reglas a tachar. Junta todo lo que ve cada regla (su grafía y sus variantes), une los
 * tramos que se pisan —un nombre que contiene a otro más corto se tacha entero— y tapa cada tramo.
 * Si sanear no carga, no sale texto: nunca se muestra sin tachar.
 */
function tachador(reglas, sanearImpl) {
  let sanear = sanearImpl;
  if (!sanear) {
    try { sanear = require('../metrics/tokens-digest.js').sanear; } catch { sanear = null; }
  }
  return (txt) => {
    if (!sanear) return '<no se pudo tachar: se omite el texto>';
    const t = sanear(txt);
    const tramos = [];
    for (const r of reglas) {
      for (const v of [{ re: r.regex, vale: () => true }, ...(r.variantes || [])]) {
        v.re.lastIndex = 0;
        let m;
        while ((m = v.re.exec(t)) !== null) {
          if (!m[0].length) { v.re.lastIndex++; continue; }
          if (v.vale(m[0])) tramos.push([m.index, m.index + m[0].length]);
        }
      }
    }
    if (!tramos.length) return t;
    tramos.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const unidos = [];
    for (const [a, b] of tramos) {
      const ultimo = unidos[unidos.length - 1];
      if (ultimo && a <= ultimo[1]) ultimo[1] = Math.max(ultimo[1], b);
      else unidos.push([a, b]);
    }
    let salida = ''; let desde = 0;
    for (const [a, b] of unidos) { salida += `${t.slice(desde, a)}<nombre>`; desde = b; }
    return salida + t.slice(desde);
  };
}

/** Un pedido a TypeSafe para todas las líneas. Devuelve {probs: number[]} o tira con el motivo. */
async function preguntarTypeSafe(lineas, { llave, fetchImpl, modelo, topeMs = TOPE_MS }) {
  const state = {};
  const questions = {};
  lineas.forEach((texto, i) => {
    state[`l${i}`] = texto;
    questions[`l${i}`] = { type: 'noul', instructions: PREGUNTA.replace('{id}', `l${i}`) };
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), topeMs);
  try {
    const res = await fetchImpl(URL_TYPESAFE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${llave}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ state, questions, model: modelo }),
      signal: ctl.signal,
    });
    if (!res || !res.ok) throw new Error(`TypeSafe respondió ${res ? res.status : 'nada'}`);
    const cuerpo = await res.json();
    const probs = lineas.map((_, i) => {
      const a = cuerpo && cuerpo.answers && cuerpo.answers[`l${i}`];
      const p = a && typeof a.noul === 'number' ? a.noul : NaN;
      if (!Number.isFinite(p)) throw new Error(`TypeSafe no trajo respuesta para la línea ${i + 1}`);
      return p;
    });
    return { probs };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`TypeSafe no contestó en ${Math.round(topeMs / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function registrar(fila) {
  try {
    const dir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    // El nombre viejo (story 8.9, tanda D2) pasa al nuevo con su historia antes de la primera línea; si la copia falla,
    // no se anota (un registro nuevo sin la historia del viejo la perdería para siempre).
    const registro = prepareStateWrite(path.join(dir, 'reviewer-rules.jsonl'), { where: 'scripts/ci/reviewer-rules.js' });
    fs.appendFileSync(registro, JSON.stringify({ ts: new Date().toISOString(), ...fila }) + '\n');
  } catch (e) {
    // medir nunca rompe el commit, pero una medición que no se anota se dice (si no, la serie se corta callada)
    process.stderr.write(`⚠️  reglas-revisores: no se anotó la medición — ${e instanceof LegacyNamesError ? e.message : (e && e.code) || (e && e.message) || e}\n`);
  }
}

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/**
 * @param {object} o
 * @param {string} o.repo
 * @param {object} [o.env]           default process.env
 * @param {Function} [o.fetchImpl]   default fetch global (inyectable en los tests)
 * @param {Function} [o.escribir]    default stderr
 * @param {string} [o.deniedList]    ruta a la lista de denegación (sus términos `cliente` se tachan)
 * @param {number} [o.topeMs]
 */
async function correr({ repo, env = process.env, fetchImpl = globalThis.fetch, escribir = (s) => process.stderr.write(s), deniedList, topeMs } = {}) {
  if (readEnv('TYCON_REVIEWER_RULES', { env, where: 'scripts/ci/reviewer-rules.js' }) === '0') return 0;
  // Con renombres (`R`): mover CLAUDE.md ↔ .claude/CLAUDE.md en el mismo commit que agrega una regla
  // dejaba el aviso mudo con `--diff-filter=ACM` (pase adversarial de la 7.5; sql-compile usa AMR).
  const staged = git(repo, ['diff', '--cached', '--name-status', '-M', '--diff-filter=ACMR']);
  if (staged === null) return 0;
  const tocados = [];
  for (const fila of staged.split('\n')) {
    const campos = fila.split('\t');
    if (campos.length < 2) continue;
    const rel = campos[campos.length - 1];
    if (ARCHIVOS.includes(rel)) tocados.push({ rel, previo: campos[0].startsWith('R') ? campos[1] : null });
  }
  if (!tocados.length) return 0;

  const lista = nombresATachar(deniedList);
  const tachar = tachador(lista.reglas || []);
  const porArchivo = [];
  for (const { rel, previo } of tocados) {
    const md = git(repo, ['show', `:${rel}`]);
    const diff = git(repo, ['diff', '--cached', '-U0', '-M', '--', ...(previo ? [previo] : []), rel]);
    if (md === null || diff === null) {
      escribir(`⚠️  reglas-revisores: no pude leer lo stageado de ${rel} — no se revisó.\n`);
      continue;
    }
    const { tieneSeccion, lineas } = candidatas(md, diff);
    if (!tieneSeccion) {
      escribir(`ℹ️  reglas-revisores: ${rel} no tiene «## Reglas para revisores»: los revisores del pipeline no ven`
        + ' ninguna regla propia de este repo (guides/reglas-para-revisores.md).\n');
    }
    porArchivo.push({ rel, tieneSeccion, lineas });
  }
  const todas = porArchivo.flatMap((a) => a.lineas.map((l) => ({ ...l, rel: a.rel })));

  // UN pedido por commit (AC 8), con las líneas de todos los archivos tocados.
  let avisar = new Set(todas);
  let modo = 'sin-llave';
  let porQue = 'sin TypeSafe: aviso por toda línea nueva fuera de la sección (no hay TYPESAFE_API_KEY en esta máquina)';
  const llave = env.TYPESAFE_API_KEY;
  if (todas.length && llave && typeof fetchImpl === 'function') {
    if (lista.motivo) {
      modo = 'typesafe-sin-lista';
      porQue = `sin TypeSafe: aviso por toda línea nueva fuera de la sección (${lista.motivo}: no se manda nada sin tachar)`;
    } else {
      try {
        const { probs } = await preguntarTypeSafe(todas.map((l) => tachar(l.texto)), { llave, fetchImpl, modelo: env.TYCON_TYPESAFE_MODEL || 'jev-latest', topeMs });
        avisar = new Set(todas.filter((_, i) => probs[i] >= UMBRAL));
        modo = 'typesafe';
        porQue = null;
      } catch (e) {
        modo = 'typesafe-fallo';
        porQue = `sin TypeSafe: aviso por toda línea nueva fuera de la sección (${tachar(e && e.message ? e.message : String(e))})`;
      }
    }
  }
  if (porQue && avisar.size) escribir(`ℹ️  reglas-revisores: ${porQue}.\n`);
  for (const l of todas) {
    if (!avisar.has(l)) continue;
    escribir(`⚠️  reglas-revisores: ${l.rel}:${l.n} — esta regla no la va a ver el revisor — movela a «Reglas para revisores»: ${tachar(l.texto.trim())}\n`);
  }
  for (const a of porArchivo) {
    const avisos = a.lineas.filter((l) => todas.some((t) => t.rel === a.rel && t.n === l.n && avisar.has(t))).length;
    registrar({ repo: path.basename(repo), archivo: a.rel, seccion: a.tieneSeccion, candidatas: a.lineas.length, avisos, modo: a.lineas.length ? modo : 'nada' });
  }
  return 0;
}

function arg(nombre) {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (require.main === module) {
  const repo = arg('--repo') || (git(process.cwd(), ['rev-parse', '--show-toplevel']) || process.cwd()).trim();
  correr({ repo })
    .catch((e) => process.stderr.write(`⚠️  reglas-revisores: falló el aviso (${e && e.message ? e.message : e}) — el commit sigue.\n`))
    .finally(() => process.exit(0));
}

module.exports = { correr, rangoSeccion, lineasAgregadas, candidatas, nombresATachar, tachador, preguntarTypeSafe, UMBRAL, TOPE_MS };
