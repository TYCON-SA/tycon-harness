'use strict';

/**
 * code-files.js — qué archivo es código, cuál es una prueba y qué marca deja una prueba salteada. Una sola respuesta
 * para todos los controles del pipeline.
 *
 * Dos preguntas distintas a propósito:
 *   - `isSource`: archivo fuente de un lenguaje (lo que el portón ATDD pide probar antes de escribir).
 *   - `isCode`: además los guiones `.sh` y los proyectos `.csproj`, que no son lenguajes pero cambian lo que corre.
 * Cada control que cuenta algo más (el portón de carril suma `.sql` y `.css`; el contexto de los revisores suma `.json`)
 * lo suma encima de estas, nunca en una lista propia.
 *
 * La organización suma extensiones en `team-repos.json → stack.code_extensions` (lo lee `stack-config.js`); quien
 * pregunta las pasa como `{ extra }`. No puede sacar las del núcleo.
 */

const path = require('path');

const SOURCE_EXTS = Object.freeze([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.cs', '.py', '.go', '.rb', '.java', '.kt', '.swift',
  '.vue', '.svelte',
]);
const SOURCE_SET = new Set(SOURCE_EXTS);
const CODE_ONLY_EXTS = Object.freeze(['.sh', '.csproj']);
const CODE_SET = new Set([...SOURCE_EXTS, ...CODE_ONLY_EXTS]);

/** La forma de una extensión que la organización puede sumar: punto, minúsculas, letras o números. */
const EXT_RE = /^\.[a-z0-9]+(?:\.[a-z0-9]+)?$/;

function extOf(f) {
  return path.extname(String(f || '').replace(/\\/g, '/')).toLowerCase();
}

/** Por la terminación completa, no por `path.extname`: una extensión de dos tramos (`.blade.php`) también calza. */
function inExtra(f, extra) {
  if (!Array.isArray(extra) || !extra.length) return false;
  const s = String(f || '').toLowerCase();
  return extra.some((e) => typeof e === 'string' && s.endsWith(e));
}

/** ¿Archivo fuente de un lenguaje? `extra`: las extensiones que sumó la organización. */
function isSource(f, { extra } = {}) {
  return SOURCE_SET.has(extOf(f)) || inExtra(f, extra);
}

/** ¿Código? Fuente, guion `.sh` o proyecto `.csproj`. */
function isCode(f, { extra } = {}) {
  return CODE_SET.has(extOf(f)) || inExtra(f, extra);
}

/**
 * ¿Archivo de prueba? Por nombre: `.test.`/`.spec.` (JS/TS y suites bash), `*Tests.cs`, `test_*.py`, `*_test.py`,
 * `*_test.go`. Por carpeta, sólo para Python: todo `.py` bajo una carpeta `tests/` (pytest junta ahí sus ayudantes y
 * `conftest.py`).
 */
function isTestFile(f) {
  const s = String(f || '').replace(/\\/g, '/');
  const base = s.slice(s.lastIndexOf('/') + 1);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  if (/\.(test|spec)\.sh$/i.test(base)) return true;
  if (/Tests?\.cs$/.test(base)) return true;
  if (/^test_[^/]*\.py$/i.test(base) || /_test\.py$/i.test(base)) return true;
  if (/_test\.go$/i.test(base)) return true;
  if (/\.py$/i.test(base) && /(^|\/)tests\//.test(s)) return true;
  return false;
}

/** Marcas de prueba salteada: JS/TS, xUnit y pytest. La de Go va aparte: `t.Skip(` es también LINQ en C#. */
const SKIP_MARK_RE = /\b(?:it|test|describe)\.skip\(|\bxit\(|\[Fact\(Skip\s*=|\[Theory\(Skip\s*=|@pytest\.mark\.skip\b|\bpytest\.skip\(/;
const GO_SKIP_MARK_RE = /\bt\.Skip(?:Now|f)?\(/;

/** ¿El contenido de este archivo de prueba trae una marca de prueba salteada? La de Go, sólo en un `.go`. */
function hasSkipMark(content, file) {
  const c = String(content || '');
  if (SKIP_MARK_RE.test(c)) return true;
  return /\.go$/i.test(String(file || '')) && GO_SKIP_MARK_RE.test(c);
}

/**
 * Valida `stack.code_extensions` tal como viene del archivo. Devuelve `{ extra, problems }`: con cualquier problema la
 * ampliación entera no se usa (una lista a medias es peor que ninguna) y cada problema lleva la ruta de su clave.
 */
function parseExtensions(value, base = 'stack.code_extensions') {
  if (value === undefined) return { extra: [], problems: [] };
  if (!Array.isArray(value)) return { extra: [], problems: [{ path: base, message: 'tiene que ser una lista de terminaciones, por ejemplo [".ex"]' }] };
  const problems = [];
  const vistos = new Set();
  value.forEach((v, i) => {
    if (typeof v !== 'string' || !EXT_RE.test(v)) {
      problems.push({ path: `${base}[${i}]`, message: `cada terminación va con punto y en minúsculas, por ejemplo ".ex" (es ${JSON.stringify(v)})` });
    } else if (vistos.has(v)) {
      problems.push({ path: `${base}[${i}]`, message: `${v} está repetida` });
    }
    vistos.add(v);
  });
  return problems.length ? { extra: [], problems } : { extra: value.slice(), problems: [] };
}

module.exports = { SOURCE_EXTS, CODE_ONLY_EXTS, EXT_RE, isSource, isCode, isTestFile, SKIP_MARK_RE, GO_SKIP_MARK_RE, hasSkipMark, parseExtensions, extOf };
