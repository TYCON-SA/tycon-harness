'use strict';

/**
 * coverage-readers.js — la cobertura de pytest (Cobertura con <sources>), de Maven y Gradle (JaCoCo) y de Go (el perfil
 * de `go test -coverprofile`), leída a la forma del lcov de node-coverage.js: ruta real del archivo → Map(línea → veces).
 *
 * Cada lector devuelve `{ ok, map, unresolved, reason }`. `unresolved` nombra los archivos del reporte que no se pudieron
 * ubicar en el disco: no se cuentan como cero, se dicen. Un reporte que no se puede leer da `ok: false` con el motivo.
 */

const fs = require('fs');
const path = require('path');
const { leerXml, descendientes } = require('./test-gate-report.js');

const atributo = (el, k) => (Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : undefined);

function real(p) {
  try { return fs.realpathSync(p); } catch (_) { return null; }
}

/** ¿`abs` (ya real) queda dentro de `raiz` (ya real)? */
function adentro(abs, raiz) {
  if (!abs || !raiz) return false;
  const rel = path.relative(raiz, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * La primera ruta que existe entre `raices × rel`, ya real y DENTRO del proyecto; o null. El reporte lo escribe el repo
 * que se prueba: una ruta absoluta o con «..» que sale del proyecto no se abre (queda en `unresolved`).
 */
function ubicar(rel, raices, proyecto) {
  const norm = String(rel || '').split('\\').join('/');
  const candidatos = path.isAbsolute(norm) ? [norm] : raices.map((r) => path.join(r, norm));
  for (const c of candidatos) {
    const abs = real(c);
    if (abs && adentro(abs, proyecto) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

/** El resultado de un lector: un reporte cuyos archivos no están ninguno en el proyecto no es «cobertura cero». */
function resultado(file, map, unresolved) {
  if (!map.size && unresolved.length) {
    return { ok: false, unresolved, reason: `${path.basename(file)}: ningún archivo del reporte está en el proyecto (${unresolved.slice(0, 3).join(', ')}${unresolved.length > 3 ? ', …' : ''})` };
  }
  return { ok: true, map, unresolved };
}

function sumar(map, abs, linea, veces) {
  if (!map.has(abs)) map.set(abs, new Map());
  const m = map.get(abs);
  m.set(linea, (m.get(linea) || 0) + veces);
}

function leer(file) {
  try { return { texto: fs.readFileSync(file, 'utf8') }; } catch (e) {
    return { error: `${path.basename(file)}: no se pudo leer (${e.code || e.message})` };
  }
}

/** Cobertura (pytest-cov, coverlet): las rutas de <class filename> son relativas a algún <source>. */
function readCobertura(file, { projectDir } = {}) {
  const l = leer(file);
  if (l.error) return { ok: false, reason: l.error };
  let root;
  try { root = leerXml(l.texto); } catch (e) { return { ok: false, reason: `${path.basename(file)}: no es un XML válido (${e.message})` }; }
  const fuentes = descendientes(root, 'source').map((s) => String(s.text || '').trim()).filter(Boolean)
    .map((s) => (path.isAbsolute(s) ? s : path.join(projectDir || path.dirname(file), s)));
  const raices = [...fuentes, projectDir || path.dirname(file)];
  const proyecto = real(projectDir || path.dirname(file));
  const map = new Map(); const unresolved = [];
  for (const cls of descendientes(root, 'class')) {
    const fn = atributo(cls, 'filename');
    if (!fn) continue;
    const abs = ubicar(fn, raices, proyecto);
    if (!abs) { if (!unresolved.includes(fn)) unresolved.push(fn); continue; }
    for (const ln of descendientes(cls, 'line')) {
      const n = parseInt(atributo(ln, 'number'), 10);
      const h = parseInt(atributo(ln, 'hits'), 10);
      if (Number.isFinite(n)) sumar(map, abs, n, Number.isFinite(h) ? h : 0);
    }
  }
  return resultado(file, map, unresolved);
}

/** JaCoCo (Maven, Gradle): <package name="a/b"><sourcefile name="X.java"><line nr mi ci/>. */
function readJacoco(file, { projectDir } = {}) {
  const l = leer(file);
  if (l.error) return { ok: false, reason: l.error };
  let root;
  // la DTD de JaCoCo no se resuelve: se saca la declaración antes de leer
  try { root = leerXml(l.texto.replace(/<!DOCTYPE[^>]*>/i, '')); } catch (e) { return { ok: false, reason: `${path.basename(file)}: no es un XML válido (${e.message})` }; }
  const base = projectDir || path.dirname(file);
  const fuentesJava = ['src/main/java', 'src/main/kotlin', 'src/test/java', 'src/test/kotlin', 'src'];
  // un reporte agregado de varios módulos: también las carpetas de fuentes de cada subcarpeta de primer nivel
  let modulos = [];
  try { modulos = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch (_) { modulos = []; }
  const raices = ['', ...fuentesJava, ...modulos.flatMap((m) => fuentesJava.map((f) => `${m}/${f}`))].map((r) => path.join(base, r));
  const proyecto = real(base);
  const map = new Map(); const unresolved = [];
  for (const pkg of descendientes(root, 'package')) {
    const dir = String(atributo(pkg, 'name') || '');
    for (const sf of pkg.children.filter((c) => c.tag === 'sourcefile')) {
      const rel = dir ? `${dir}/${atributo(sf, 'name')}` : String(atributo(sf, 'name'));
      const abs = ubicar(rel, raices, proyecto);
      if (!abs) { if (!unresolved.includes(rel)) unresolved.push(rel); continue; }
      for (const ln of sf.children.filter((c) => c.tag === 'line')) {
        const n = parseInt(atributo(ln, 'nr'), 10);
        const ci = parseInt(atributo(ln, 'ci'), 10);
        if (Number.isFinite(n)) sumar(map, abs, n, Number.isFinite(ci) ? ci : 0);
      }
    }
  }
  return resultado(file, map, unresolved);
}

/**
 * El perfil de Go: `mode: set|count|atomic` y después `<módulo>/<ruta>:L1.C1,L2.C2 <sentencias> <veces>`. La ruta del
 * módulo sale del go.mod del proyecto; cada bloque marca todas sus líneas.
 */
function readGoCover(file, { projectDir } = {}) {
  const l = leer(file);
  if (l.error) return { ok: false, reason: l.error };
  const filas = l.texto.split(/\r?\n/);
  if (!/^mode:\s*(set|count|atomic)\s*$/.test(filas[0] || '')) return { ok: false, reason: `${path.basename(file)}: no es un perfil de cobertura de Go (falta «mode:» en la primera línea)` };
  const base = projectDir || path.dirname(file);
  let modulo = '';
  // sin go.mod legible las rutas quedan con el módulo adelante: no se ubican y salen en `unresolved`, visibles
  try { modulo = ((fs.readFileSync(path.join(base, 'go.mod'), 'utf8').match(/^module\s+(\S+)/m) || [])[1]) || ''; } catch (_) { modulo = ''; }
  const proyecto = real(base);
  const map = new Map(); const unresolved = [];
  for (const fila of filas.slice(1)) {
    if (!fila.trim()) continue;
    const m = fila.match(/^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/);
    if (!m) return { ok: false, reason: `${path.basename(file)}: renglón que no se puede leer («${fila.slice(0, 60)}»)` };
    const rel = modulo && m[1].startsWith(`${modulo}/`) ? m[1].slice(modulo.length + 1) : m[1];
    const abs = ubicar(rel, [base], proyecto);
    if (!abs) { if (!unresolved.includes(rel)) unresolved.push(rel); continue; }
    const veces = parseInt(m[4], 10);
    for (let n = parseInt(m[2], 10); n <= parseInt(m[3], 10); n++) sumar(map, abs, n, veces);
  }
  return resultado(file, map, unresolved);
}

module.exports = { readCobertura, readJacoco, readGoCover };
