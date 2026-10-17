#!/usr/bin/env node
/**
 * author-concentration.js — en qué productos una sola persona hizo el 75 % o más de los commits del último año
 * (story 2.26). Se publica la concentración, nunca el nombre.
 *
 * Antes la medía sólo la máquina que generaba el tablero, contando por NOMBRE (dos alias de una persona la partían en
 * dos y escondían la concentración) y con los commits de los pipelines adentro (los «bump version» del CI bajaban la
 * parte de la persona: medido el 2026-10-15, la identidad del pipeline era el 17-21 % del año en tres backends). El
 * nocturno de métricas ya baja todos los repos de la organización: se mide ahí, con la misma regla en la corrida local.
 *
 * La regla (la de siempre, `dashboard.js#localExtra`): por repo con 20 commits o más en los 12 meses hasta hoy, la
 * parte del autor principal; el producto toma el máximo de sus repos medidos; en riesgo con 0,75 o más.
 *   - Una persona: las identidades que comparten nombre o correo (el correo en minúsculas) se unen, y se aplica el
 *     `.mailmap` del repo leído del OBJETO (`git -c mailmap.blob=HEAD:.mailmap log …`): el clon del nocturno es
 *     `--no-checkout` y git no lee un `.mailmap` que no está en el disco.
 *   - Las identidades de máquina (`sources.json → params.identidades_de_maquina`: nombres y correos exactos, `contiene`
 *     como parte del nombre) no cuentan; se suman en `commits_de_maquina`. Sin la clave, «no medido».
 *   - Un clon superficial, un repo sin `ado` o sin su clon, o con menos de 20 commits: «no medido» con su motivo.
 *
 * 🔴 Ningún nombre ni correo toca el disco ni sale del guion: `git log` se lee por tubería, en memoria; el archivo trae
 *    sólo proporciones y conteos POR PRODUCTO (cada repo, sólo `estado` y `motivo`: en un repo de dos personas, su
 *    número identificaría a alguien). Un error de git se dice con el repo y su código de salida, nunca con la salida del
 *    comando (su stdout trae autores).
 *
 * CLI (el nocturno): node author-concentration.js --scan <raíz de clones Proyecto__Repo> --products <repos.json>
 *   --out <archivo> [--sources <sources.json>]   ·   exit 0 escribió · 1 argumentos · 2 no pudo leer o escribir.
 * Módulo: concentracion({ repos: [{ producto, repo, dir, motivo }], today, maquinas }) — la usan el nocturno (repos
 *   resueltos por `ado` bajo --scan, `resolverNocturno`) y la corrida local del tablero (por `ruta`, `resolverLocal`).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { readEnv } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));
const { spawnSync } = require('child_process');

const UMBRAL = 0.75;
const MIN_COMMITS = 20;

const isoDia = (d) => d.toISOString().slice(0, 10);
function hoy(today) { return today || readEnv('TYCON_TODAY', { where: 'scripts/metrics/author-concentration.js' }) || isoDia(new Date()); }
function ventana(today) {
  const hasta = hoy(today);
  const d = new Date(`${hasta}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return { desde: isoDia(d), hasta };
}
function proyectoYRepo(ado) {
  const [p, r] = String(ado || '').split('/');
  if (!p || !r) return null;
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  return { proyecto: dec(p), repo: dec(r) };
}
function listaDeRepos(products) {
  if (Array.isArray(products)) return products;
  return products && Array.isArray(products.repos) ? products.repos : null;
}

/** Las identidades de máquina de `params`, o null (sin la clave: «no medido», nunca una lista escrita acá). */
function maquinasDe(cfg) {
  const m = cfg && cfg.params && cfg.params.identidades_de_maquina;
  if (!m || typeof m !== 'object') return null;
  const lista = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string' && s) : []);
  return { nombres: new Set(lista(m.nombres)), correos: new Set(lista(m.correos).map((s) => s.toLowerCase())), contiene: lista(m.contiene) };
}
function esMaquina(nombre, correo, maq) {
  return maq.nombres.has(nombre) || maq.correos.has(correo.toLowerCase()) || maq.contiene.some((c) => nombre.includes(c));
}

/** La parte del autor principal sobre `lineas` ([nombre, correo]), en memoria. Una persona = nombres y correos unidos. */
function partePrincipal(lineas, maq) {
  const padre = new Map();
  const raiz = (x) => { let r = x; while (padre.get(r) !== r) r = padre.get(r); padre.set(x, r); return r; };
  const nodo = (x) => { if (!padre.has(x)) padre.set(x, x); return x; };
  const unir = (a, b) => { const ra = raiz(nodo(a)); const rb = raiz(nodo(b)); if (ra !== rb) padre.set(ra, rb); };
  let maquina = 0; const humanos = [];
  for (const [nombre, correo] of lineas) {
    if (esMaquina(nombre, correo, maq)) { maquina++; continue; }
    const n = `n:${nombre}`; const e = `e:${correo.toLowerCase()}`;
    if (correo) unir(n, e); else nodo(n);
    humanos.push(n);
  }
  const cuenta = new Map();
  for (const n of humanos) { const r = raiz(n); cuenta.set(r, (cuenta.get(r) || 0) + 1); }
  const top = humanos.length ? Math.max(...cuenta.values()) / humanos.length : 0;
  return { commits: humanos.length, maquina, top };
}

/** Mide un repo: { estado, motivo, commits, maquina, top }. Nunca devuelve ni imprime autores. */
function medirRepo(dir, v, maq) {
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const sh = git(['rev-parse', '--is-shallow-repository']);
  if (sh.error || sh.status !== 0) return { estado: 'no_medido', motivo: `no es un repo git legible (git rev-parse salió ${sh.status === null ? 'sin código' : sh.status})`, error: true };
  if (String(sh.stdout).trim() === 'true') return { estado: 'no_medido', motivo: 'clon superficial, no tiene el año de historia' };
  const log = git(['-c', 'mailmap.blob=HEAD:.mailmap', 'log', 'HEAD', `--since=${v.desde}T00:00:00Z`, `--until=${v.hasta}T23:59:59Z`, '--format=%aN%x09%aE']);
  // 🔴 el error se dice con su código, nunca con log.stdout/log.stderr: la salida trae autores
  if (log.error || log.status !== 0) return { estado: 'no_medido', motivo: `git log falló (salió ${log.status === null ? 'sin código' : log.status})`, error: true };
  const lineas = String(log.stdout).split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)]; });
  const p = partePrincipal(lineas, maq);
  if (p.commits < MIN_COMMITS) return { estado: 'no_medido', motivo: `menos de ${MIN_COMMITS} commits en el año (${p.commits})`, commits: p.commits, maquina: p.maquina };
  return { estado: 'medido', motivo: null, commits: p.commits, maquina: p.maquina, top: p.top };
}

// Truncado, no redondeado: 0,745 redondeado se publicaba 0,75 con `en_riesgo: false` (pase adversarial). Truncado, el
// número publicado y el riesgo dicen lo mismo.
const truncado = (x) => Math.floor(x * 100 + 1e-9) / 100;

/**
 * La función común. `repos`: [{ producto, repo, dir, motivo }] — `dir` null con su `motivo` si no se encontró. Un mismo
 * `repo` en dos productos se mide una vez. `maquinas`: el resultado de `maquinasDe`, o null. Devuelve
 * { productos, cobertura, ventana, avisos } (avisos: [{ repo, motivo }] de los repos que fallaron, sin autores).
 */
function concentracion({ repos, today, maquinas, motivoSinMaquinas }) {
  const v = ventana(today);
  const medidas = new Map(); const avisos = [];
  for (const r of repos) {
    if (medidas.has(r.repo)) continue;
    let m;
    if (!maquinas) m = { estado: 'no_medido', motivo: motivoSinMaquinas || 'sin la lista de identidades de máquina (sources.json → params.identidades_de_maquina)' };
    else if (!r.dir) m = { estado: 'no_medido', motivo: r.motivo || 'sin carpeta' };
    else m = medirRepo(r.dir, v, maquinas);
    if (m.error) avisos.push({ repo: r.repo, motivo: m.motivo });
    medidas.set(r.repo, m);
  }
  const porProducto = new Map();
  for (const r of repos) {
    if (!porProducto.has(r.producto)) porProducto.set(r.producto, []);
    const lista = porProducto.get(r.producto);
    if (!lista.includes(r.repo)) lista.push(r.repo);
  }
  const productos = [...porProducto.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([producto, rs]) => {
    const ms = rs.map((repo) => ({ repo, m: medidas.get(repo) }));
    const medidos = ms.filter((x) => x.m.estado === 'medido');
    const reposOut = ms.map(({ repo, m }) => ({ repo, estado: m.estado, motivo: m.motivo }));
    const commits = medidos.reduce((a, x) => a + x.m.commits, 0);
    const commits_de_maquina = medidos.reduce((a, x) => a + x.m.maquina, 0);
    if (!medidos.length) {
      const motivos = [...new Set(ms.map((x) => x.m.motivo).filter(Boolean))];
      return { producto, estado: 'no_medido', motivo: !maquinas ? motivos[0] : `ningún repo medido: ${motivos.join('; ')}`, concentracion: null, en_riesgo: null, commits: null, commits_de_maquina: null, repos: reposOut };
    }
    const conc = truncado(Math.max(...medidos.map((x) => x.m.top)));
    return { producto, estado: 'medido', motivo: null, concentracion: conc, en_riesgo: conc >= UMBRAL, commits, commits_de_maquina, repos: reposOut };
  });
  const cobertura = {
    productos_declarados: productos.length,
    productos_medidos: productos.filter((p) => p.estado === 'medido').length,
    repos_declarados: medidas.size,
    repos_medidos: [...medidas.values()].filter((m) => m.estado === 'medido').length,
  };
  return { productos, cobertura, ventana: v, avisos };
}

// Un nombre decodificado que trae un separador o `..` saldría de la raíz de las copias (revisor de seguridad).
const nombreSeguro = (s) => !!s && !/[/\\]/.test(s) && !s.split(/[/\\]/).includes('..') && s !== '.' && !s.includes('..');
const adentro = (raiz, dir) => { const r = path.resolve(raiz); const d = path.resolve(dir); return d === r || d.startsWith(r + path.sep); };

/**
 * El nocturno: cada entrada de `repos.json` por su `ado` decodificado, bajo `<scan>/<Proyecto>__<Repo>`. La carpeta se
 * busca sin distinguir mayúsculas: el nocturno la nombra como la devuelve Azure DevOps, y `repos.json` puede escribirla
 * distinto (en un disco que distingue, salía «no está» — pase adversarial).
 */
function resolverNocturno(entries, scan) {
  let carpetas = []; let noLei = null;
  // «no pude listar las copias» no es «no está entre las copias» (revisor de fallas silenciosas, vuelta 2)
  try { carpetas = fs.readdirSync(scan); } catch (e) { noLei = `no pude leer la carpeta de las copias del nocturno (${e.code || e.name})`; }
  const porMinusculas = new Map(carpetas.map((c) => [c.toLowerCase(), c]));
  return entries.filter((e) => e && e.producto).map((e) => {
    const pr = proyectoYRepo(e.ado);
    if (!pr) return { producto: e.producto, repo: e.ruta || '(sin ado)', dir: null, motivo: 'no declara dónde vive en Azure DevOps' };
    if (noLei) return { producto: e.producto, repo: `${pr.proyecto}/${pr.repo}`, dir: null, motivo: noLei };
    const repo = `${pr.proyecto}/${pr.repo}`;
    if (!nombreSeguro(pr.proyecto) || !nombreSeguro(pr.repo)) return { producto: e.producto, repo: '(ado inválido)', dir: null, motivo: 'el ado de repos.json sale de la carpeta de las copias: no se mide' };
    const nombre = porMinusculas.get(`${pr.proyecto}__${pr.repo}`.toLowerCase());
    const dir = nombre ? path.join(scan, nombre) : null;
    return dir && adentro(scan, dir) ? { producto: e.producto, repo, dir } : { producto: e.producto, repo, dir: null, motivo: 'no está entre los clones del nocturno' };
  });
}
/** La corrida local: cada entrada por su `ruta` bajo la carpeta de los repos de la máquina (sin salir de ella). */
function resolverLocal(entries, srcRoot) {
  return entries.filter((e) => e && e.producto).map((e) => {
    const pr = proyectoYRepo(e.ado);
    const repo = pr ? `${pr.proyecto}/${pr.repo}` : (e.ruta || '(sin ruta)');
    const dir = e.ruta ? path.join(srcRoot, e.ruta) : null;
    if (dir && !adentro(srcRoot, dir)) return { producto: e.producto, repo, dir: null, motivo: 'la ruta de repos.json sale de la carpeta de los repos: no se mide' };
    return dir && fs.existsSync(path.join(dir, '.git')) ? { producto: e.producto, repo, dir } : { producto: e.producto, repo, dir: null, motivo: 'no está en este disco' };
  });
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const scan = opt('--scan'); const prods = opt('--products'); const out = opt('--out');
  if (!scan || !prods || !out) {
    console.error('uso: author-concentration.js --scan <raíz de clones> --products <repos.json> --out <archivo> [--sources <sources.json>]');
    process.exit(1);
  }
  let entries;
  try { entries = listaDeRepos(JSON.parse(fs.readFileSync(prods, 'utf8'))); } catch (e) {
    console.error(`author-concentration: no pude leer la lista de productos (${e instanceof SyntaxError ? 'no es JSON válido' : e.code || e.name})`);
    process.exit(2);
  }
  if (!entries) { console.error('author-concentration: la lista de productos no trae `repos`'); process.exit(2); }
  try { if (!fs.statSync(scan).isDirectory()) throw new Error('no es carpeta'); } catch (e) {
    console.error(`author-concentration: no encontré la carpeta de clones (${e.code || e.message})`);
    process.exit(2);
  }
  let cfg = null; let motivoSinMaquinas = null;
  const sourcesPath = opt('--sources') || path.join(__dirname, '..', 'nightly', 'dashboard', 'sources.json');
  try { cfg = JSON.parse(fs.readFileSync(sourcesPath, 'utf8')); } catch (e) {
    // la causa real va al archivo (y al aviso del nocturno), no «sin la lista de máquinas» (revisor de fallas silenciosas)
    motivoSinMaquinas = `no pude leer sources.json (${e instanceof SyntaxError ? 'no es JSON válido' : e.code || e.name}): sin la lista de identidades de máquina`;
    console.error(`author-concentration: ${motivoSinMaquinas}; todo sale «no medido»`);
  }
  const today = hoy(null);
  const r = concentracion({ repos: resolverNocturno(entries, scan), today, maquinas: maquinasDe(cfg), motivoSinMaquinas });
  for (const a of r.avisos) console.error(`author-concentration: ${a.repo}: no medido — ${a.motivo}`);
  const doc = { v: 1, generated_at: new Date().toISOString(), ventana: r.ventana, umbral: UMBRAL, min_commits: MIN_COMMITS, productos: r.productos, cobertura: r.cobertura };
  const tmp = `${out}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmp, out);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* no quedó */ }
    console.error(`author-concentration: no pude escribir el archivo (${e.code || e.name})`);
    process.exit(2);
  }
  const riesgo = r.productos.filter((p) => p.en_riesgo).length;
  console.log(`author-concentration: ${r.cobertura.productos_medidos} de ${r.cobertura.productos_declarados} productos medidos, ${riesgo} en riesgo (${r.cobertura.repos_medidos} de ${r.cobertura.repos_declarados} repos) → ${path.basename(out)}`);
}

module.exports = { concentracion, resolverNocturno, resolverLocal, maquinasDe, UMBRAL, MIN_COMMITS };
if (require.main === module) main();
