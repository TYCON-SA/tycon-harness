#!/usr/bin/env node
'use strict';
/**
 * tool-names.js — el control de los nombres de las herramientas de horas fuera de su lugar.
 *
 * El núcleo del arnés no nombra herramientas (guides/constitucion.md): lo propio de cada una vive en su integración. Este
 * control cuenta los nombres de las integraciones de horas (el `name` de cada manifiesto `integrations/<n>/integration.json`
 * con `kind: "timeTracking"`, y el nombre de cada skill que trae) en lo que va al commit (el índice de git), fuera de las
 * zonas permitidas:
 *   · `integrations/` y `guides/integrations/`;
 *   · las pruebas (una carpeta `tests/` o `test/`, un `*.test.*`) y el banco de controles (`scripts/controls-bench/`);
 *   · una ruta que apunta a una integración dentro de una línea (`integrations/<n>/…`, `@int:<n>/…`, el ancla de su guía
 *     `#guidesintegrations…`): es la dirección.
 * Lo que cuenta no puede pasar el techo de su archivo (`ceiling` de las reglas; sin entrada, 0). La compatibilidad con lo
 * que ya está escrito en las máquinas va en `exceptions`, cada una con su archivo exacto y su motivo: una sin motivo, con
 * comodines, o que ya no encuentra el nombre en su archivo, frena.
 *
 * Las reglas: scripts/ci/tool-names.json, leídas del índice. Los nombres no están escritos acá: salen de los manifiestos.
 *
 * Uso: node scripts/ci/tool-names.js --repo <dir> [--measure] [--json] [--skip-thin]
 *   sale 0 dentro del techo · 1 un nombre de más o una excepción mal declarada · 2 no pude mirar (git o las reglas)
 *   --measure imprime lo que cuenta cada archivo (para fijar el techo) y sale 0
 *   --skip-thin lo pasa sólo el pre-commit propio del repo de mantenimiento adelgazado: si el árbol lo es (su
 *     `.tycon/internal-forms.json` dice `layout: "thin"`), no cuenta y lo dice; lo que se publica lo mira el repo público
 * Casos: scripts/tests/tool-names.test.js
 */

const path = require('path');
const { spawnSync } = require('child_process');

const RULES = 'scripts/ci/tool-names.json';
// una ruta a una integración (con `/` o con `\`, también la doble de un texto JSON), su spec de hook, o el ancla de su guía
// en un índice (`#guidesintegrations<archivo>md`). Empieza en un borde de palabra: `myintegrations/…` no es una ruta.
const ROUTE = /(?<![A-Za-z0-9_.-])(?:guides[\\/]+)?integrations(?:[\\/]+[A-Za-z0-9._-]+)+|@int:[A-Za-z0-9._/-]+|#guidesintegrations[A-Za-z0-9-]+/g;
const MAX_BUFFER = 256 * 1024 * 1024;
const TERM_RE = /^[a-z0-9][a-z0-9._-]*$/;

class LookError extends Error {}

// el color de git apagado: con `color.grep=always` en la configuración de una máquina, la salida trae escapes y no se lee
function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, '-c', 'color.ui=never', '-c', 'color.grep=never', ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (r.error) throw new LookError(`git no corrió (${r.error.code || r.error.message})`);
  return r;
}
/** El contenido de un archivo en el índice, o null si no está. Uno que está y no se puede leer no es «no está»: tira. */
function indexed(repo, rel) {
  const there = git(repo, ['ls-files', '--error-unmatch', '--', rel]);
  if (there.status !== 0) return null;
  const r = git(repo, ['show', `:${rel}`]);
  if (r.status !== 0) throw new LookError(`${rel} está en el índice y no se puede leer (git show salió con ${r.status})`);
  return r.stdout;
}

/** ¿El archivo está en una zona donde nombrar la herramienta es su lugar? */
function allowed(rel) {
  return rel.startsWith('integrations/') || rel.startsWith('guides/integrations/') || rel.startsWith('scripts/controls-bench/')
    || /(^|\/)tests?\//.test(rel) || /\.test\.[A-Za-z0-9]+$/.test(rel);
}

/** Los nombres de las herramientas de horas del árbol, de sus manifiestos en el índice (el nombre y el de cada skill). */
function termsOf(repo) {
  const ls = git(repo, ['ls-files', '-z', '--', 'integrations/*/integration.json']);
  if (ls.status !== 0) throw new LookError(`git ls-files salió con ${ls.status}: ${(ls.stderr || '').trim().slice(0, 200)}`);
  const out = new Set();
  for (const rel of ls.stdout.split('\0').filter(Boolean)) {
    let m;
    try { m = JSON.parse(indexed(repo, rel) || ''); } catch (e) { throw new LookError(`${rel} no se puede leer (${e.message}): no sé qué nombres buscar`); }
    if (!m || m.kind !== 'timeTracking') continue;
    // un nombre vacío haría contar todas las líneas; uno que falta dejaría la herramienta sin buscar
    if (typeof m.name !== 'string' || !m.name.trim()) throw new LookError(`${rel} es de horas y no dice su «name»: no sé qué nombre buscar`);
    // los nombres van a una expresión y a git: sólo minúsculas, números, punto, guion y guion bajo, empezando con letra o número
    const names = [m.name, ...(Array.isArray(m.skills) ? m.skills.filter((s) => typeof s === 'string').map((s) => path.posix.basename(s)) : [])];
    for (const n of names) {
      if (!TERM_RE.test(n.toLowerCase())) throw new LookError(`${rel}: el nombre «${n}» no es un nombre de integración o de skill (letras, números, «.», «-», «_»)`);
      out.add(n.toLowerCase());
    }
  }
  return [...out].sort();
}

// lo que no es texto: una imagen, un video o un comprimido no nombra nada que se lea
const MEDIA = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp4|webm|mov|wav|mp3)$/i;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// un término en cualquier combinación de mayúsculas, como palabra: no lo antecede una letra o un número, y no lo sigue
// una minúscula o un número (con el término `acme`, `acmeing` no lo nombra; `acmeApiKey` y `TYCON_ACME` sí)
const anyCase = (t) => [...t].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escape(c))).join('');
function termsRegex(terms) {
  return new RegExp(`(?<![A-Za-z0-9])(?:${[...terms].sort((a, b) => b.length - a.length).map(anyCase).join('|')})(?![a-z0-9])`, 'g');
}
/** Cuántas veces nombra la línea alguno de los términos, sin contar las rutas a una integración (una que sale con `..`, sí). */
function countIn(line, re) {
  const m = line.replace(ROUTE, (r) => (/(^|[\\/])\.\.([\\/]|$)/.test(r) ? r : ' ')).match(re);
  return m ? m.length : 0;
}
/** ¿El repo de mantenimiento adelgazado? Ahí viven las stories y los registros, que nombran la herramienta con derecho. */
function thinLayout(repo) {
  try { return JSON.parse(indexed(repo, '.tycon/internal-forms.json') || '').layout === 'thin'; } catch (_) { return false; }
}

function readRules(repo) {
  const text = indexed(repo, RULES);
  if (text === null) return { exceptions: [], ceiling: {}, termsAtLeast: 0 };
  let r;
  try { r = JSON.parse(text); } catch (e) { throw new LookError(`${RULES} no es JSON (${e.message})`); }
  if (!r || typeof r !== 'object') throw new LookError(`${RULES} no es un objeto`);
  const exceptions = r.exceptions === undefined ? [] : r.exceptions;
  const ceiling = r.ceiling === undefined ? {} : r.ceiling;
  if (!Array.isArray(exceptions)) throw new LookError(`${RULES}: «exceptions» es una lista`);
  if (!ceiling || typeof ceiling !== 'object' || Array.isArray(ceiling) || Object.values(ceiling).some((n) => !Number.isInteger(n) || n < 0)) {
    throw new LookError(`${RULES}: «ceiling» es un objeto de archivo → entero ≥ 0`);
  }
  const termsAtLeast = r.terms_at_least === undefined ? 0 : r.terms_at_least;
  if (!Number.isInteger(termsAtLeast) || termsAtLeast < 0) throw new LookError(`${RULES}: «terms_at_least» es un entero ≥ 0`);
  return { exceptions, ceiling, termsAtLeast };
}

/**
 * El control sobre el índice de `repo`: `{ ok, problems, perFile, mentions, terms, notes }`. `perFile` es lo que cuenta
 * (fuera de zonas y excepciones); `mentions`, cada línea que cuenta. Tira LookError si no puede mirar.
 */
function check({ repo, skipThin = false }) {
  // el repo de mantenimiento adelgazado no se publica: lo que se publica lo mira este control en el repo público
  // el salteo lo pide quien llama (el pre-commit propio del repo de mantenimiento, con --skip-thin) y además el árbol tiene
  // que serlo: un archivo agregado por un commit no alcanza para apagar el control en el repo público
  if (skipThin && thinLayout(repo)) return { ok: true, skipped: true, problems: [], perFile: Object.create(null), mentions: [], terms: [], notes: ['el repo de mantenimiento adelgazado no se publica: lo mira el control del repo público'] };
  const terms = termsOf(repo);
  const { exceptions, ceiling, termsAtLeast } = readRules(repo);
  const problems = [];
  const notes = [];
  // las reglas dicen cuántos nombres hay por lo menos: un manifiesto de horas que desaparece o cambia de tipo no apaga el
  // control en silencio
  // un árbol sin ninguna integración (un repo de juguete con el pre-commit del arnés) no tiene nada que contar; con
  // integraciones, el mínimo vale
  const ls = git(repo, ['ls-files', '-z', '--', 'integrations/*/integration.json']);
  if (ls.status !== 0) throw new LookError(`git ls-files salió con ${ls.status}: ${(ls.stderr || '').trim().slice(0, 200)}`);
  if (!ls.stdout.split('\0').some(Boolean)) return { ok: true, problems, perFile: {}, mentions: [], terms, notes: ['el árbol no trae integraciones: nada que contar'] };
  if (terms.length < termsAtLeast) throw new LookError(`encontré ${terms.length} nombre(s) de herramientas de horas en los manifiestos y las reglas esperan al menos ${termsAtLeast} (terms_at_least de ${RULES}): ¿se borró o cambió de tipo una integración de horas?`);
  if (!terms.length) return { ok: true, problems, perFile: {}, mentions: [], terms, notes: ['no hay integraciones de horas: nada que contar'] };
  const re = termsRegex(terms);
  // -a: un archivo que git toma por binario (un NUL suelto, un .gitattributes) también se lee; sólo se saltean los de MEDIA
  // el patrón con -e y los caminos después de `--`: nada de lo que viene de un manifiesto se lee como una opción de git
  const g = git(repo, ['grep', '--cached', '--no-color', '-z', '-n', '-a', '-i', '-E', '-e', terms.map(escape).join('|'), '--']);
  // git grep sale 1 cuando no encuentra nada: eso es «cero», no un error
  if (g.status !== 0 && g.status !== 1) throw new LookError(`git grep salió con ${g.status}: ${(g.stderr || '').trim().slice(0, 200)}`);
  // sin prototipo: un archivo que se llama `__proto__` o `constructor` es un archivo más
  const raw = Object.create(null);   // archivo → menciones (sin las rutas), con o sin zona
  const lines = [];
  for (const rec of g.stdout.split('\n')) {
    if (!rec) continue;
    const a = rec.indexOf('\0');
    const b = rec.indexOf('\0', a + 1);
    const line = a < 0 || b < 0 ? NaN : Number(rec.slice(a + 1, b));
    // un renglón que no tiene la forma archivo\0línea\0texto (un nombre de archivo con salto de línea) no se saltea: se dice
    if (!Number.isInteger(line) || line < 1) throw new LookError(`git grep devolvió un renglón que no entiendo: ${JSON.stringify(rec.slice(0, 120))}`);
    const file = rec.slice(0, a);
    if (MEDIA.test(file)) continue;
    const n = countIn(rec.slice(b + 1), re);
    if (!n) continue;
    raw[file] = (raw[file] || 0) + n;
    lines.push({ file, line, n });
  }
  const excepted = new Set();
  for (const e of exceptions) {
    const p = e && typeof e.path === 'string' ? e.path : null;
    if (!p) { problems.push(`${RULES}: una excepción sin «path»`); continue; }
    if (/[*?[\]{}]/.test(p)) { problems.push(`${RULES}: la excepción «${p}» lleva comodines: va el archivo exacto (un comodín abre archivos que nadie miró)`); continue; }
    if (!(typeof e.reason === 'string' && e.reason.trim())) problems.push(`${RULES}: la excepción de ${p} está sin motivo: cada una dice por qué ese archivo tiene que nombrar la herramienta`);
    if (!raw[p]) problems.push(`${RULES}: la excepción de ${p} ya no hace falta (el archivo no nombra la herramienta, o no está): sacala`);
    excepted.add(p);
  }
  const perFile = Object.create(null);
  const topOf = (file) => (Object.prototype.hasOwnProperty.call(ceiling, file) ? ceiling[file] : 0);
  const mentions = [];
  for (const m of lines) {
    if (allowed(m.file) || excepted.has(m.file)) continue;
    perFile[m.file] = (perFile[m.file] || 0) + m.n;
    mentions.push(m);
  }
  for (const [file, n] of Object.entries(perFile)) {
    const top = topOf(file);
    if (n > top) {
      const where = mentions.filter((m) => m.file === file).map((m) => `${file}:${m.line}`).join(', ');
      problems.push(`${file}: nombra la herramienta de horas ${n} vez/veces y el techo es ${top} (regla: el núcleo no nombra herramientas; lo propio va en integrations/ o guides/integrations/). Dónde: ${where}`);
    }
  }
  for (const [file, top] of Object.entries(ceiling)) {
    const n = perFile[file] || 0;
    if (n < top) notes.push(`${file}: nombra la herramienta ${n} vez/veces y su techo es ${top}: bajalo en ${RULES}`);
  }
  // un objeto común (con la clave como propiedad propia, aunque se llame `__proto__`), para quien lo compare o lo imprima
  return { ok: problems.length === 0, problems, perFile: Object.fromEntries(Object.entries(perFile)), mentions, terms, notes };
}

function main(argv) {
  const repoAt = argv.indexOf('--repo');
  const repo = path.resolve(repoAt >= 0 && argv[repoAt + 1] ? argv[repoAt + 1] : '.');
  let r;
  try { r = check({ repo, skipThin: argv.includes('--skip-thin') }); } catch (e) {
    if (!(e instanceof LookError)) throw e;
    process.stderr.write(`⛔ tool-names: no pude mirar — ${e.message}\n`);
    return 2;
  }
  if (argv.includes('--measure')) { process.stdout.write(`${JSON.stringify(r.perFile, null, 2)}\n`); return 0; }
  if (argv.includes('--json')) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return r.ok ? 0 : 1; }
  if (r.skipped) { process.stdout.write(`⏭ tool-names: SALTEADO — ${r.notes.join(' · ')}\n`); return 0; }
  for (const n of r.notes) process.stdout.write(`ℹ tool-names: ${n}\n`);
  if (r.ok) {
    const total = Object.values(r.perFile).reduce((a, b) => a + b, 0);
    process.stdout.write(`✅ tool-names: ${total} mención(es) en ${Object.keys(r.perFile).length} archivo(s) del núcleo, dentro del techo\n`);
    return 0;
  }
  for (const p of r.problems) process.stderr.write(`🛑 tool-names: ${p}\n`);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { check, termsOf, allowed, countIn, main, RULES };
