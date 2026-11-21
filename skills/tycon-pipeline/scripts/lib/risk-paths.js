'use strict';
/**
 * risk-paths.js — la regla de riesgo alto por ruta. La usan la historia (`computeDelicate` de pipeline.js) y el camino
 * rápido (el portón de carril, el registro de ediciones y el freno de guardar), para que las dos no se separen.
 *
 *   riesgoDeArchivos(files, { repo, raices, superficie, antesDeLosControles })
 *       → { value: true, rule, file, reason } · { value: false, rule: null, file: null, reason: 'ninguna' }
 *         · { value: true, rule: 'no-pude-saber', file: null, reason } (una lectura que falla: en duda, riesgo alto)
 *   riesgoDeRuta(abs, { repo, superficie }) → lo mismo, para el conjunto de una ruta
 *
 * La precedencia es por regla sobre el conjunto, en este orden: rutas sensibles, superficie compartida, producción, un
 * pipeline con paso a producción, el portón/instalador/migración, lo sensible del arnés y los archivos de control. La
 * primera regla que se cumple en algún archivo decide. `antesDeLosControles` es un paso que pone el llamador entre el
 * portón y lo sensible del arnés (la historia pone ahí su `sensible:`).
 *
 * También: lo que la historia declara en `riesgo_alto_por:` (`leerRiesgoAltoPor`) y los archivos de dependencias
 * (`esManifiesto`), que son reglas de la historia y no de una ruta.
 */

const fs = require('fs');
const path = require('path');

const RE_RUTA_SENSIBLE = /auth|security|payment|crypto|secret|credential/i;
// el portón de CI (también por su nombre suelto), el instalador y los ganchos de git (también la carpeta), una migración
const RE_PORTON = /(^|\/)(tycon-ci-gate\.js|guides\/ci-gate(\.en)?\.md|install-tycon-hooks\.[^/]+)$|(^|\/)(scripts\/setup|\.githooks)(\/|$)|\.sql$|(^|\/)drizzle(\/|$)/i;
const RE_PRODUCCION = /(^|\/)\.tycon\/production\.json$|(^|\/)scripts\/production(\/|$)/i;
const RE_PIPELINE_YML = /(^|\/)(azure-pipelines[^/]*|pipelines\/.+)\.ya?ml$/i;
// un paso a producción: `stage|environment|deployment: …prod…` en el mismo renglón, o el entorno en su forma de objeto
// (`environment:` y abajo `name: production`)
const RE_STAGE_PROD = /^\s*-?\s*(stage|environment|deployment)\s*:\s*['"]?[\w.-]*prod|^\s*environment\s*:\s*\r?\n\s+(name\s*:\s*)?['"]?[\w.-]*prod/im;

// Los valores de `riesgo_alto_por:` en el frontmatter de una historia: lo que la máquina no lee en los archivos.
const VALORES_RIESGO_ALTO_POR = ['alcance', 'seguridad', 'dependencia-nueva', 'plata', 'clientes', 'personas'];

// Los manifiestos de dependencias: tocarlos puede traer una dependencia nueva.
const RE_MANIFIESTO = /^(package\.json|.+\.csproj|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Gemfile|pom\.xml|build\.gradle[^/]*)$/i;

/** ¿La ruta es un manifiesto de dependencias? */
function esManifiesto(rel) {
  return RE_MANIFIESTO.test(path.posix.basename(String(rel || '').replace(/\\/g, '/')));
}

/**
 * Lo que declara `riesgo_alto_por:` en el texto del frontmatter: `{ valores, invalidos }`, o null sin el campo. Acepta
 * la lista entre corchetes, la lista en bloque y el escalar. `[]` es una lista vacía.
 */
function leerRiesgoAltoPor(fmTexto) {
  const txt = String(fmTexto || '');
  const m = txt.match(/^riesgo_alto_por[ \t]*:[ \t]*(.*)$/m);
  if (!m) return null;
  // sin el comentario del renglón: también el que empieza el valor (`riesgo_alto_por: # nota`)
  const limpiar = (v) => String(v).replace(/(^|\s+)#.*$/, '').trim().replace(/^['"]|['"]$/g, '').trim();
  const cab = limpiar(m[1]);
  let valores;
  const flow = cab.match(/^\[(.*)\]$/);
  if (flow) valores = flow[1].split(',').map(limpiar).filter(Boolean);
  else if (cab) valores = [cab];
  else {
    valores = [];
    for (const linea of txt.slice(m.index + m[0].length).split(/\r?\n/).slice(1)) {
      // la lista en bloque, con sangría o con el guion en la columna 0 (las dos son YAML válido)
      const it = linea.match(/^[ \t]*-[ \t]+(.+)$/);
      if (it) { const v = limpiar(it[1]); if (v) valores.push(v); continue; }
      if (linea.trim() === '') continue;
      break;
    }
  }
  return { valores, invalidos: valores.filter((v) => !VALORES_RIESGO_ALTO_POR.includes(v)) };
}

/**
 * Los archivos de la constancia de controles de un repo (scripts/ci/controls-from-base.json), o null si no la tiene: lo
 * que la lista nombra, los guiones que nombra el pre-commit y el código que cargan los guiones de control (sus `require`
 * relativos y sus `path.join(__dirname, …)`, sin las pruebas), como el cierre de `run-base-controls.sh`.
 */
function archivosDeControles(raiz) {
  const f = path.join(raiz, 'scripts', 'ci', 'controls-from-base.json');
  if (!fs.existsSync(f)) return null;
  const inv = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!inv || !Array.isArray(inv.controls)) throw new Error(`${path.relative(raiz, f)} no tiene «controls»`);
  const ruta = (r) => (typeof r === 'string' ? r : r && r.path) || null;
  const todo = new Set(['scripts/ci/controls-from-base.json', inv.hook, ...inv.controls.flatMap((c) => [c.script, ...(c.rules || []).map(ruta)]),
    ...(inv.workflows || []).map(ruta)].filter(Boolean));
  const leer = (rel) => { try { return fs.readFileSync(path.join(raiz, rel), 'utf8'); } catch (_) { return null; } };
  const existe = (rel) => { try { return fs.statSync(path.join(raiz, rel)).isFile(); } catch (_) { return false; } };
  const cola = inv.controls.map((c) => c.script).filter(Boolean);
  const hook = inv.hook ? leer(inv.hook) : null;
  if (hook) for (const m of hook.matchAll(/\$\{?(?:REPO_ROOT|TCG)\}?\/([\w.@/-]+?\.(?:c?js|mjs|sh))(?![\w.])/g)) { todo.add(m[1]); cola.push(m[1]); }
  const vistos = new Set();
  while (cola.length && vistos.size < 2000) {
    const g = cola.shift();
    if (vistos.has(g)) continue;
    vistos.add(g);
    const texto = leer(g);
    if (texto === null) continue;
    const dir = path.posix.dirname(g);
    const nombrados = [...texto.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const m of texto.matchAll(/path\.(?:join|resolve)\(\s*__dirname\s*,([^()]*)\)/g)) {
      const lits = [...m[1].matchAll(/(['"`])([^'"`\n$]*)\1/g)].map((x) => x[2]).filter(Boolean);
      if (lits.length) nombrados.push(lits.join('/'));
    }
    for (const n of nombrados) {
      let c = path.posix.normalize(path.posix.join(dir, n));
      if (c.startsWith('..') || /(^|\/)tests?\//.test(c)) continue;
      if (!/\.\w+$/.test(c) && existe(`${c}.js`)) c = `${c}.js`;
      if (!/\.(c?js|mjs|sh)$/.test(c) || !existe(c)) continue;
      todo.add(c);
      cola.push(c);
    }
  }
  return todo;
}

/** Las expresiones de lo sensible del arnés (`SENSITIVE` de scripts/lib/signatures.js), como en save-ok.js. */
function sensiblesDelArnes() {
  const lista = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'signatures.js')).SENSITIVE;
  return lista.map((p) => new RegExp(`^${String(p).toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*')}$`));
}

/** La superficie compartida de pipeline.js, pedida recién cuando hace falta (es un archivo grande). */
function superficiePorDefecto(repo, files) {
  return require('../pipeline.js').tocaSuperficieCompartida(repo, files);
}

/** Una ruta en la forma en que se compara: `{ rel, abs, base }`, con `/` y relativa al repo cuando está adentro. */
function comparable(f, repo) {
  if (f && typeof f === 'object' && 'rel' in f) return f;
  const s = String(f).replace(/\\/g, '/');
  const absoluta = path.isAbsolute(s) || /^[A-Za-z]:\//.test(s);
  let rel = s.replace(/^\.\//, '');
  let fuera = false;
  if (absoluta && repo) {
    const x = path.relative(repo, s).replace(/\\/g, '/');
    if (x && !x.startsWith('..') && !path.isAbsolute(x)) rel = x;
    else fuera = true;
  }
  return { rel, abs: absoluta ? s : null, base: path.posix.basename(rel.replace(/\/$/, '')), fuera };
}

function riesgoDeArchivos(entrada, { repo = null, raices = null, superficie = superficiePorDefecto, antesDeLosControles = null } = {}) {
  const si = (rule, file, detalle) => ({ value: true, rule, file, reason: `${rule}: ${detalle || file}` });
  const noPude = (motivo) => ({ value: true, rule: 'no-pude-saber', file: null, reason: `no pude saber: ${motivo}` });
  // una ruta absoluta fuera del repo no es de este repo: sus carpetas de arriba (el home, la de la sesión) no dicen
  // nada del riesgo del cambio
  const files = (entrada || []).map((f) => comparable(f, repo)).filter((x) => x.rel && !x.fuera);
  const roots = raices || (repo ? [repo] : []);
  const sensible = files.find((f) => RE_RUTA_SENSIBLE.test(f.rel));
  if (sensible) return si('rutas-sensibles', sensible.rel);
  if (repo) {
    const cfg = path.join(repo, '.tycon', 'advisors.yaml');
    try { if (fs.existsSync(cfg)) fs.readFileSync(cfg, 'utf8'); } catch (e) { return noPude(`no pude leer ${cfg} (${e.code || e.message})`); }
    let sup;
    try { sup = superficie(repo, files.map((f) => f.abs || f.rel)); } catch (e) { return noPude(`no pude leer la superficie compartida (${e.message})`); }
    if (sup) return si('superficie-compartida', sup.file, `${sup.file} (${sup.pattern})`);
  }
  const prod = files.find((f) => RE_PRODUCCION.test(f.rel));
  if (prod) return si('produccion', prod.rel);
  for (const f of files.filter((x) => RE_PIPELINE_YML.test(x.rel))) {
    let txt = null;
    try { txt = repo ? fs.readFileSync(f.abs || path.join(repo, f.rel), 'utf8') : null; } catch (_) { txt = null; }
    if (txt === null) return si('produccion', f.rel, `${f.rel}: un pipeline que no pude leer`);
    if (RE_STAGE_PROD.test(txt)) return si('produccion', f.rel, `${f.rel}: tiene un paso a producción`);
  }
  const porton = files.find((f) => RE_PORTON.test(f.rel));
  if (porton) return si('porton-instalador-migracion', porton.rel);
  if (antesDeLosControles) {
    const r = antesDeLosControles();
    if (r) return r;
  }
  // lo sensible del ok de guardar (SENSITIVE de signatures.js): las firmas, los frenos y el perfil
  let sensibles;
  try { sensibles = sensiblesDelArnes(); } catch (e) { return noPude(`no pude leer la lista de lo sensible (${e.message})`); }
  const firmaOFreno = files.find((f) => sensibles.some((re) => re.test(f.rel.toLowerCase())));
  if (firmaOFreno) return si('controles', firmaOFreno.rel, `${firmaOFreno.rel} (firmas, frenos o perfil)`);
  for (const raiz of roots) {
    let ctl;
    try { ctl = archivosDeControles(raiz); } catch (e) { return noPude(`no pude leer la constancia de controles de ${path.basename(raiz)} (${e.message})`); }
    if (!ctl) continue;
    const bases = new Set([...ctl].map((c) => path.posix.basename(c)));
    // un nombre suelto (sin carpeta) cuenta si coincide con el de un archivo de control: en duda, riesgo alto
    const toca = files.find((f) => ctl.has(f.rel) || (!f.rel.includes('/') && bases.has(f.base)));
    if (toca) return si('controles', toca.rel);
  }
  return { value: false, rule: null, file: null, reason: 'ninguna' };
}

/** La regla de una ruta absoluta en su repo (el conjunto de una). */
function riesgoDeRuta(abs, { repo, superficie } = {}) {
  return riesgoDeArchivos([abs], { repo, superficie: superficie || superficiePorDefecto });
}

module.exports = {
  riesgoDeArchivos, riesgoDeRuta, archivosDeControles, leerRiesgoAltoPor, esManifiesto,
  VALORES_RIESGO_ALTO_POR, RE_RUTA_SENSIBLE, RE_PORTON, RE_PRODUCCION, RE_PIPELINE_YML, RE_STAGE_PROD,
};
