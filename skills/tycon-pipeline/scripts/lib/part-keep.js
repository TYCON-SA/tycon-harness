#!/usr/bin/env node
'use strict';
/**
 * part-keep.js — ¿una parte de la story puede conservar su verde en vez de volver a correr?
 *
 * Una story que toca dos proyectos del repo (el backend y el sitio) corre cada uno por separado (`correr_partes` en
 * test-gate.sh). Después de un verde, un arreglo en una sola parte volvía a correr las dos. Acá se decide, parte por
 * parte, si su verde sigue valiendo: sólo si nada de lo que la prueba cambió desde entonces. «Nada cambió» lo dice una
 * huella, no la lista de archivos de la story:
 *   - la carpeta de la parte tal como está en el disco (lo commiteado y lo que no, sin lo ignorado), como árbol de git;
 *   - lo común: todo lo del repo que no cae en ninguna parte (la configuración de la raíz, una carpeta compartida), salvo
 *     la story que corre y los artefactos y la memoria del arnés (.advisors, .engram);
 *   - lo ignorado por git de la parte y de lo común (un .env, algo generado o instalado), por tamaño y fecha;
 *   - el portón mismo (test-gate.sh y todas sus bibliotecas), las herramientas de la parte (la versión de node, y la de
 *     dotnet, python o go si la parte las usa) y las variables del entorno que cambian una prueba.
 * Nunca conserva: una parte de navegador (Playwright, Karma, Cypress: prueba el producto entero), una corrida sin story,
 * otra story u otra rama, un verde sin huella, una parte cuyos archivos nombran una ruta en otra parte o fuera del repo, ni
 * un repo cuyas partes comparten paquetes (workspaces). Ante la duda, corre.
 *
 * Uso:  node part-keep.js fingerprint --repo <dir> --scope <parte> --scopes <a,b>   → imprime la huella (JSON); sale 1
 *       si no la pudo calcular (entonces la parte corre).
 *       node part-keep.js decide --previous <artefacto de la parte> --current <huella JSON> --story <id> --branch <rama>
 *       → sale 0 y dice por qué si conserva; 1 y dice por qué si corre.
 *       node part-keep.js stamp --artifact <artefacto de la parte> --current <huella JSON> --story <id> --branch <rama>
 *       → anota la huella en el artefacto de un verde (el que deja la parte al correr).
 * Casos: skills/tycon-pipeline/scripts/tests/test-gate-part-keep.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const NAVEGADOR = /^(playwright|karma|cypress)$/i;
// lo que escribe el arnés en el repo (los artefactos y la memoria): no es lo que prueba una parte
const DEL_ARNES = ['.advisors', '.engram'];
const WORKSPACES = ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json'];
// las variables que cambian el resultado de una prueba sin cambiar un archivo
const DEL_ENTORNO = /^(NODE_ENV|NODE_OPTIONS|TZ|LANG|LC_ALL|CI|DATABASE_URL)$|^(ASPNETCORE_|DOTNET_|NUGET_|PYTHON|PIP_|VITE_|NEXT_PUBLIC_|ConnectionStrings__|TYCON_COVERAGE_)/;
// lo que escribe una herramienta al instalar o compilar: se mira su fecha, no su contenido (pesa demasiado)
const CARPETA_IGNORADA = /\/$/;

function git(repo, args, env) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...(env || {}) }, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]}: ${((r.stderr || '') + (r.error ? r.error.message : '')).trim().split('\n')[0]}`);
  return r.stdout;
}

/** El árbol de git de lo que hay en el disco bajo `paths` (sin lo ignorado), con `excluir` afuera. */
function arbolDelDisco(repo, paths, excluir = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'part-keep-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    git(repo, ['add', '-A', '--', ...paths, ...excluir.map((e) => `:(exclude)${e}`)], env);
    return git(repo, ['write-tree'], env).trim();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** Los archivos de la parte (los que git ve: commiteados y nuevos sin ignorar). */
function archivosDe(repo, scope) {
  return git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', scope]).split('\0').filter(Boolean);
}

/**
 * Lo ignorado bajo `paths` (un `.env`, un cliente generado, node_modules): el árbol de git no lo ve y una prueba puede
 * leerlo. Un archivo cuenta por su tamaño y su fecha; una carpeta entera ignorada, por su fecha (instalar o compilar la
 * toca). Más corridas, nunca menos.
 */
function huellaDeLoIgnorado(repo, paths, excluir = []) {
  const lista = git(repo, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--', ...paths, ...excluir.map((e) => `:(exclude)${e}`)])
    .split('\0').filter(Boolean).sort();
  const h = crypto.createHash('sha256');
  for (const rel of lista) {
    let s; try { s = fs.statSync(path.join(repo, rel)); } catch (_) { h.update(`${rel}:no está\n`); continue; }
    h.update(`${rel}:${CARPETA_IGNORADA.test(rel) ? '' : s.size}:${s.mtimeMs}\n`);
  }
  return h.digest('hex');
}

/**
 * Las rutas relativas que nombran los archivos de la parte y caen en otra parte o fuera del repo: la parte depende de
 * algo que su huella no mira. Lo de afuera de las partes pero adentro del repo ya está en la huella de lo común.
 */
function dependenciasDeAfuera(repo, scope, scopes) {
  const raiz = path.resolve(repo);
  const propia = path.resolve(raiz, scope);
  const otras = scopes.filter((s) => s !== scope).map((s) => path.resolve(raiz, s));
  const dentro = (p, d) => p === d || p.startsWith(d + path.sep);
  const out = new Set();
  const cae = (destino) => !dentro(destino, propia) && (!dentro(destino, raiz) || otras.some((o) => dentro(destino, o)));
  for (const rel of archivosDe(repo, scope)) {
    const abs = path.resolve(raiz, rel);
    // un enlace que apunta afuera: git guarda sólo el texto del enlace, no lo que hay del otro lado
    try {
      if (fs.lstatSync(abs).isSymbolicLink() && cae(path.resolve(path.dirname(abs), fs.readlinkSync(abs)))) { out.add(`${rel} → (enlace) ${fs.readlinkSync(abs)}`); continue; }
    } catch (_) { continue; }
    let texto;
    try { if (fs.statSync(abs).size > 512 * 1024) continue; texto = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
    if (texto.includes('\0')) continue;
    // una ruta que sube de carpeta, empiece donde empiece la palabra: `"../x"`, `file:../x`, `=> ../x`, `-e ../x`,
    // `>..\x` (un .csproj), con barras de un lado o del otro
    for (const m of texto.matchAll(/(?:^|[^\w.])(\.\.[\\/][^"'`)\s;,<>|]*)/gm)) {
      const destino = path.resolve(path.dirname(abs), m[1].replace(/\\/g, '/'));
      if (cae(destino)) out.add(`${rel} → ${m[1]}`);
    }
    // una ruta armada por partes (`join(dir, "..", "backend")`) no se puede seguir: ante la duda, depende de afuera
    if (/["'`]\.\.["'`]/.test(texto)) out.add(`${rel} → ".." (una ruta armada que sube de carpeta)`);
  }
  return [...out].sort();
}

/** ¿Las partes del repo comparten paquetes? (workspaces en el package.json de la raíz, o un archivo de monorepo) */
function compartenPaquetes(repo) {
  if (WORKSPACES.some((f) => fs.existsSync(path.join(repo, f)))) return true;
  try { const p = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')); return !!(p && p.workspaces); } catch (_) { return false; }
}

/** La versión de una herramienta, o «no está». */
function version(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return r.error || r.status !== 0 ? 'no está' : `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0];
}

/** El portón entero: test-gate.sh y todas sus bibliotecas. Cualquier cambio del arnés vuelve a correr todas las partes. */
function huellaDelPorton() {
  const h = crypto.createHash('sha256');
  const archivos = ['../test-gate.sh', ...fs.readdirSync(__dirname).filter((f) => /\.(js|sh|json)$/.test(f)).sort()];
  for (const rel of archivos) {
    try { h.update(rel).update(fs.readFileSync(path.join(__dirname, rel))); } catch (_) { h.update(`${rel}:no está`); }
  }
  return h.digest('hex');
}

/** Las variables de `DEL_ENTORNO` con su valor, y la plataforma. */
function huellaDelEntorno(env) {
  const h = crypto.createHash('sha256').update(`${process.platform}/${process.arch}\n`);
  for (const k of Object.keys(env).filter((n) => DEL_ENTORNO.test(n)).sort()) h.update(`${k}=${env[k]}\n`);
  return h.digest('hex');
}

/** `storyFile`: la story que corre, relativa al repo; queda fuera de lo común (cambia en cada paso del pipeline). */
function fingerprint({ repo, scope, scopes, storyFile, env = process.env }) {
  const lista = [...new Set([scope, ...scopes])].filter(Boolean);
  const herramientas = { node: process.version };
  const archivos = archivosDe(repo, scope);
  if (archivos.some((f) => /\.(csproj|sln|fsproj)$/.test(f))) herramientas.dotnet = version('dotnet', ['--version']);
  if (archivos.some((f) => /(^|\/)(pytest\.ini|pyproject\.toml|setup\.cfg|conftest\.py)$/.test(f))) herramientas.python = version('python3', ['--version']);
  if (archivos.some((f) => /(^|\/)go\.mod$/.test(f))) herramientas.go = version('go', ['version']);
  const fueraDeLoComun = [...lista, ...DEL_ARNES, ...(storyFile ? [storyFile] : [])];
  return {
    scope,
    part: arbolDelDisco(repo, [scope]),
    part_ignored: huellaDeLoIgnorado(repo, [scope]),
    common: arbolDelDisco(repo, ['.'], fueraDeLoComun),
    common_ignored: huellaDeLoIgnorado(repo, ['.'], fueraDeLoComun),
    gate: huellaDelPorton(),
    tools: herramientas,
    env: huellaDelEntorno(env),
    outside: dependenciasDeAfuera(repo, scope, lista),
    shared_packages: compartenPaquetes(repo),
  };
}

const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** La decisión, pura: `{ keep, why }`. */
function decide({ prev, current, story, branch }) {
  if (!current) return { keep: false, why: 'no pude calcular la huella de la parte' };
  if (!story || story === 'unknown') return { keep: false, why: 'la corrida no es de una story' };
  if (current.shared_packages) return { keep: false, why: 'las partes del repo comparten paquetes (workspaces)' };
  if (current.outside && current.outside.length) return { keep: false, why: `la parte nombra rutas de otra parte o de fuera del repo (${current.outside.slice(0, 3).join(', ')})` };
  if (!prev) return { keep: false, why: 'no hay un verde anterior de la parte' };
  if (prev.suite_green !== true) return { keep: false, why: 'la corrida anterior de la parte no fue verde' };
  if (prev.runner && NAVEGADOR.test(String(prev.runner))) return { keep: false, why: `una parte de navegador (${prev.runner}) prueba el producto entero: corre siempre` };
  const k = prev.kept_fingerprint;
  if (!k || !k.fingerprint) return { keep: false, why: 'el verde anterior no dejó su huella' };
  if (k.story !== story) return { keep: false, why: `el verde anterior es de otra story (${k.story})` };
  // sin rama (una cabeza suelta) todas las corridas «coincidirían»: no se conserva
  if (!branch || branch === 'HEAD') return { keep: false, why: 'la carpeta no está en una rama' };
  if (k.branch !== branch) return { keep: false, why: `el verde anterior es de otra rama (${k.branch})` };
  const f = k.fingerprint;
  if (f.scope !== current.scope) return { keep: false, why: 'el verde anterior es de otra parte' };
  const distinto = DIFERENCIAS.find(([campo]) => !igual(f[campo], current[campo]));
  if (distinto) return { keep: false, why: distinto[1] };
  return { keep: true, why: `verde del ${prev.ts || k.ts || '?'}, sin cambios en la parte, en lo común, en el entorno ni en el portón desde entonces; para correrla igual, TYCON_TEST_GATE_ALL_PARTS=1` };
}
// lo que tiene que ser igual para conservar, en el orden en que se dice
const DIFERENCIAS = [
  ['gate', 'cambió el portón'], ['tools', 'cambió una herramienta de la parte'], ['env', 'cambió una variable del entorno que cambia las pruebas'],
  ['common', 'cambió algo común a las partes'], ['common_ignored', 'cambió algo común ignorado por git (un .env, algo generado o instalado)'],
  ['part', 'cambió la parte'], ['part_ignored', 'cambió algo ignorado por git en la parte (un .env, algo generado o instalado)'],
];
// lo versionado: si cambió mientras corría la parte, lo que se probó no es lo que quedó
const LO_VERSIONADO = ['part', 'common', 'gate', 'tools', 'env'];

/**
 * La huella que se anota con un verde: la de DESPUÉS de correr (con lo que la herramienta escribió en lo ignorado, como
 * bin/ u obj/), pero sólo si lo versionado no cambió mientras corría. null si cambió (entonces no se anota).
 */
function paraAnotar(antes, despues) {
  if (!antes || !despues) return null;
  return LO_VERSIONADO.every((c) => igual(antes[c], despues[c])) ? despues : null;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const leer = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
  const actual = () => { try { return JSON.parse(opt('--current') || ''); } catch (_) { return null; } };
  if (cmd === 'fingerprint') {
    try {
      const repo = opt('--repo'); const story = opt('--story-file');
      const storyFile = story ? path.relative(path.resolve(repo), path.resolve(story)) : null;
      process.stdout.write(`${JSON.stringify(fingerprint({ repo, scope: opt('--scope'), scopes: String(opt('--scopes') || '').split(',').filter(Boolean),
        storyFile: storyFile && !storyFile.startsWith('..') ? storyFile.split(path.sep).join('/') : null }))}\n`);
      return 0;
    } catch (e) { process.stderr.write(`part-keep: no pude calcular la huella: ${e.message}\n`); return 1; }
  }
  if (cmd === 'decide') {
    const d = decide({ prev: leer(opt('--previous')), current: actual(), story: opt('--story'), branch: opt('--branch') });
    process.stdout.write(`${d.why}\n`);
    return d.keep ? 0 : 1;
  }
  if (cmd === 'stamp') {
    const f = opt('--artifact'); const a = leer(f);
    let antes = null; try { antes = JSON.parse(opt('--before') || ''); } catch (_) { antes = null; }
    const c = paraAnotar(antes, actual());
    if (!a || a.suite_green !== true) return 1;
    if (!c) { process.stderr.write('part-keep: lo versionado cambió mientras corría la parte: su verde no se anota para conservar\n'); return 1; }
    a.kept_fingerprint = { story: opt('--story'), branch: opt('--branch'), ts: a.ts || null, fingerprint: c };
    fs.writeFileSync(f, `${JSON.stringify(a, null, 2)}\n`);
    return 0;
  }
  process.stderr.write('uso: part-keep.js fingerprint|decide|stamp …\n');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { fingerprint, decide, paraAnotar, dependenciasDeAfuera, compartenPaquetes, NAVEGADOR };
