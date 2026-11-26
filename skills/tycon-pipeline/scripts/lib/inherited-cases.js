#!/usr/bin/env node
'use strict';
/**
 * inherited-cases.js — las pruebas que ya fallaban antes del cambio, medidas caso por caso en los repos de producto
 * (.NET, jest, vitest y las herramientas de test-runners.js con reporte trx, junit o json de jest).
 *
 * Las suites del arnés las juzga `inherited-reds.js`. Acá se juzga una corrida de producto que salió roja: cada prueba
 * que falló se vuelve a correr sobre la base, que es la bifurcación con la rama principal del repo (la que apunta
 * `origin/HEAD`, o `origin/main`, o `origin/master`). Una falla de ahora es heredada sólo si en la base corrió y falló
 * con la misma clave. Si en la base pasó, o no está, es del cambio. Si la base no la pudo correr, queda «no medida» con
 * su motivo y sigue frenando. Nadie la declara heredada a mano.
 *
 * La base corre en una copia aparte (`git worktree add --detach`), con las carpetas `node_modules` del repo enlazadas
 * (en Windows, con un enlace de carpeta que no pide permisos de administrador), y se borra al terminar. Corre con una
 * casa de prueba y sin las variables del marcador: no anota checks. .NET restaura con la caché de NuGet de la máquina.
 *
 * Las claves (una por herramienta):
 *   - trx: el ensamblado de pruebas (el proyecto) más el `testName`. Un `outcome` distinto de `Passed` en la base es falla.
 *   - jest y vitest: el archivo, relativo y por ruta real, más el nombre completo. Un archivo que falló sin pruebas
 *     fallidas lleva su marca (`did_not_run` o `file_failed`) en lugar del nombre.
 *   - junit: `classname` más `name`.
 *
 * Uso: node inherited-cases.js apply <carpeta que se probó> <carpeta de resultados> --runner <herramienta> [--projects N]
 * Escribe `inherited-cases.json` en la carpeta de resultados. Sale 0 si todo lo rojo es heredado · 1 si queda algo del
 * cambio o sin medir · 2 si no se pudo decidir (sin reportes legibles) · 10 si está apagado (TYCON_INHERITED_BASE_MAX=0).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('./test-gate-report.js');

const TOPE_FILTRO_DOTNET = 60;   // más casos que esto en un proyecto: corre el proyecto entero
const TOPE_FALLAS = 500;         // más fallas que esto no es un par de pruebas viejas: es una base rota, no se mide
// lo que en un trx es una prueba que falló (lo mismo que lee el informe): una salteada o inconclusa en la base no es una
// falla de la base, y una prueba que el cambio activó y rompió frena
const FALLO_TRX = new Set(['Failed', 'Error', 'Timeout', 'Aborted']);
// los archivos que fijan las dependencias de node: si el cambio los toca, las de ahora no sirven para medir la base
const DEPENDENCIAS_JS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']);
// lo que la corrida rompió fuera de una prueba (errores no capturados, el proceso de pruebas caído): no se perdona
const FUERA_DE_LAS_PRUEBAS = /Unhandled (Errors?|Rejection)|Test host process crashed|The active test run was aborted/i;
const TIEMPO_BASE_S = () => {
  const n = Number(process.env.TYCON_INHERITED_BASE_TIMEOUT_S);
  return Number.isFinite(n) && n > 0 ? n : 900;
};

const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
const fuera = (r) => String((r && r.stdout) || '').trim();

/**
 * La base: `{ ref, sha, fecha }`, la bifurcación de HEAD con la rama principal, o `{ motivo }`. No trae nada de la red:
 * usa lo que el clon ya tiene, y dice de cuándo es la rama (`fecha`, la de su último commit).
 */
function ramaPrincipal(repo) {
  let ref = null;
  const cabeza = git(repo, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD');
  if (cabeza.status === 0 && fuera(cabeza)) ref = fuera(cabeza).replace(/^refs\/remotes\//, '');
  for (const r of [ref, 'origin/main', 'origin/master']) {
    if (!r) continue;
    if (git(repo, 'rev-parse', '--verify', '-q', `${r}^{commit}`).status === 0) { ref = r; break; }
    ref = null;
  }
  if (!ref) return { motivo: 'el repo no tiene origin/HEAD, origin/main ni origin/master: no hay base contra la que medir' };
  const base = git(repo, 'merge-base', 'HEAD', ref);
  if (base.status !== 0 || !fuera(base)) return { motivo: `no encontré dónde se separa HEAD de ${ref}` };
  const sha = fuera(base);
  const head = fuera(git(repo, 'rev-parse', 'HEAD'));
  if (head === sha && !fuera(git(repo, 'status', '--porcelain', '--untracked-files=normal'))) {
    return { motivo: `el árbol es la base (${ref}) y no tiene cambios: no hay cambio que juzgar` };
  }
  return { ref, sha, fecha: fuera(git(repo, 'log', '-1', '--format=%cI', ref)) };
}

// ── leer las fallas de un reporte, sin tope ─────────────────────────────────────────────────────────────────────────

const local = (tag) => String(tag || '').replace(/^\{[^}]*\}/, '');
const hijos = (e, nombre) => (e && Array.isArray(e.children) ? e.children.filter((h) => local(h.tag) === nombre) : []);
// todos los descendientes con ese nombre, con el espacio de nombres que traiga el reporte
const todos = (e, nombre) => {
  const out = [];
  const visitar = (x) => { if (local(x.tag) === nombre) out.push(x); for (const h of x.children || []) visitar(h); };
  visitar(e);
  return out;
};
const attr = (e, n) => (e && e.attrs && e.attrs[n] !== undefined ? String(e.attrs[n]) : '');

/** Los casos de un trx: `[{ key, project, name, fqn, failed }]`. El proyecto es el ensamblado de la prueba. */
function casosDeTrx(archivo) {
  const t = R.leerXml(fs.readFileSync(archivo, 'utf8'));
  const ensamblado = new Map();
  for (const u of todos(t, 'UnitTest')) {
    const m = hijos(u, 'TestMethod')[0];
    const codeBase = attr(m, 'codeBase');
    const proyecto = codeBase ? path.basename(codeBase.replace(/\\/g, '/')).replace(/\.(dll|exe)$/i, '') : '';
    ensamblado.set(attr(u, 'id'), { proyecto, clase: attr(m, 'className'), fqn: m ? [attr(m, 'className'), attr(m, 'name')].filter(Boolean).join('.') : '' });
  }
  const out = [];
  for (const r of todos(t, 'UnitTestResult')) {
    const e = ensamblado.get(attr(r, 'testId')) || { proyecto: '', clase: '', fqn: '' };
    const name = attr(r, 'testName') || '?';
    // la clase va en la clave: en MSTest el testName es sólo el método, y dos clases pueden tener uno con el mismo nombre
    out.push({ key: `trx:${e.proyecto}::${e.clase}::${name}`, project: e.proyecto, name, fqn: e.fqn, failed: FALLO_TRX.has(attr(r, 'outcome')) });
  }
  return out;
}

/** Los casos del json de jest o vitest: `[{ key, file, name, failed }]`, con la marca del archivo que falló sin pruebas. */
function casosDeJest(json, repoRun) {
  const raiz = repoRun ? R.rutaReal(repoRun) : '';
  const archivoDe = (n) => {
    const s = String(n || '?');
    if (!raiz || !path.isAbsolute(s)) return s.split(path.sep).join('/');
    const rel = path.relative(raiz, R.rutaReal(s));
    return (rel.startsWith('..') || path.isAbsolute(rel) ? s : rel).split(path.sep).join('/');
  };
  const out = [];
  for (const f of (json && Array.isArray(json.testResults) ? json.testResults : [])) {
    if (!f || typeof f !== 'object') continue;
    const file = archivoDe(f.name);
    const casos = Array.isArray(f.assertionResults) ? f.assertionResults : [];
    for (const a of casos) {
      if (!a) continue;
      const name = a.fullName || [...(Array.isArray(a.ancestorTitles) ? a.ancestorTitles : []), a.title].filter(Boolean).join(' ') || '?';
      out.push({ key: `js:${file}::${name}`, file, name, failed: a.status === 'failed' });
    }
    if (f.status === 'failed' && !casos.some((a) => a && a.status === 'failed')) {
      const marca = casos.length ? 'file_failed' : 'did_not_run';
      out.push({ key: `js:${file}::#${marca}`, file, name: null, [marca]: true, failed: true });
    }
  }
  return out;
}

/** Los casos de un junit: `[{ key, classname, name, failed }]`. */
function casosDeJunit(archivo) {
  const t = R.leerXml(fs.readFileSync(archivo, 'utf8'));
  const casos = local(t.tag) === 'testcase' ? [t] : todos(t, 'testcase');
  return casos.map((c) => {
    const classname = attr(c, 'classname');
    const name = attr(c, 'name') || '?';
    const failed = hijos(c, 'failure').length > 0 || hijos(c, 'error').length > 0;
    return { key: `junit:${classname}::${name}`, classname, name, failed };
  });
}

/**
 * Los casos de una corrida, por herramienta: `{ casos, formato }` o `{ error }`. `generico` es la definición de una
 * herramienta de test-runners.js (`runner.json`); `desde` limita a los reportes escritos después de esa marca.
 */
function casosDeLaCorrida({ runner, resultsDir, repoRun, generico = null }) {
  try {
    if (runner === 'dotnet') {
      const trx = R.buscarArchivos(resultsDir, (n) => n.endsWith('.trx'));
      if (!trx.length) return { error: 'la corrida no dejó ningún reporte trx' };
      return { formato: 'trx', casos: trx.flatMap(casosDeTrx), reportes: trx.length };
    }
    if (runner === 'jest' || runner === 'vitest') {
      const j = [path.join(resultsDir, 'vitest.json'), path.join(resultsDir, 'jest.json')].find((f) => fs.existsSync(f));
      if (!j) return { error: `la corrida no dejó el reporte json de ${runner}` };
      return { formato: 'jest-json', casos: casosDeJest(JSON.parse(fs.readFileSync(j, 'utf8')), repoRun) };
    }
    const res = generico && generico.results;
    if (!res || !['junit', 'trx', 'jest-json'].includes(res.format)) return { error: `la herramienta ${runner} no deja un reporte con el nombre de cada prueba` };
    const reportes = reportesGenericos(res, resultsDir, repoRun);
    if (!reportes.length) return { error: `la herramienta ${runner} no dejó su reporte (${res.format})` };
    const casos = res.format === 'junit' ? reportes.flatMap(casosDeJunit)
      : res.format === 'trx' ? reportes.flatMap(casosDeTrx)
        : reportes.flatMap((f) => casosDeJest(JSON.parse(fs.readFileSync(f, 'utf8')), repoRun));
    return { formato: res.format, casos };
  } catch (e) {
    return { error: `no pude leer el reporte (${(e && e.message) || e})` };
  }
}

/** Los reportes de una herramienta genérica: la ruta de su definición, con `{results}` ya en la carpeta de resultados. */
function reportesGenericos(res, resultsDir, repoRun) {
  const patrones = [res.path, res.alt].filter(Boolean).map((p) => String(p).replace(/\{results\}/g, resultsDir));
  const out = [];
  for (const p of patrones) {
    const abs = path.isAbsolute(p) ? p : path.join(repoRun, p);
    if (!/[*?]/.test(abs)) { if (fs.existsSync(abs)) out.push(abs); continue; }
    // un patrón con comodines: se buscan los archivos que calzan con su nombre, desde la parte fija de la ruta
    const fija = abs.split(/[*?]/)[0];
    const desde = fija.endsWith(path.sep) ? fija : path.dirname(fija);
    const nombre = new RegExp(`^${path.basename(abs).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    out.push(...R.buscarArchivos(desde, (n) => nombre.test(n)));
  }
  return [...new Set(out)];
}

// ── el juicio ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `{ inherited, blocking }`: cada falla de ahora es heredada si en la base corrió y falló con la misma clave. Si no, va
 * a `blocking` con su motivo. `base` es `{ casos }` (lo que corrió en la base) o `{ motivo }` (no se pudo medir).
 */
function juzgar(fallas, base) {
  const inherited = [];
  const blocking = [];
  const enBase = new Map();
  for (const c of (base && base.casos) || []) {
    const v = enBase.get(c.key) || { n: 0, fallas: 0 };
    enBase.set(c.key, { n: v.n + 1, fallas: v.fallas + (c.failed ? 1 : 0) });
  }
  const repetidasAhora = new Map();
  for (const f of fallas) repetidasAhora.set(f.key, (repetidasAhora.get(f.key) || 0) + 1);
  for (const f of fallas) {
    const sin = { ...f }; delete sin.failed; delete sin.motivo;
    if (base && base.motivo) { blocking.push({ ...sin, reason: 'no medida', detail: base.motivo }); continue; }
    if (f.motivo) { blocking.push({ ...sin, reason: 'no medida', detail: f.motivo }); continue; }
    const b = enBase.get(f.key);
    // dos pruebas con la misma clave no se pueden distinguir: no se perdona ninguna
    if (repetidasAhora.get(f.key) > 1 || (b && b.n > 1 && b.fallas !== b.n)) { blocking.push({ ...sin, reason: 'no medida', detail: 'hay más de una prueba con este nombre: no se puede saber cuál falla en la base' }); continue; }
    if (!b) blocking.push({ ...sin, reason: 'no está en la base: la agregó o la renombró el cambio' });
    else if (!b.fallas) blocking.push({ ...sin, reason: 'en la base pasa: la rompió el cambio' });
    else inherited.push(sin);
  }
  return { inherited, blocking };
}

// ── la copia de la base ─────────────────────────────────────────────────────────────────────────────────────────────

/** Las carpetas `node_modules` del repo (la raíz y las de sus paquetes, hasta tres niveles), relativas. */
function carpetasDeModulos(repo) {
  const out = [];
  const visitar = (rel, nivel) => {
    let entradas;
    try { entradas = fs.readdirSync(path.join(repo, rel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of entradas) {
      if (!e.isDirectory() || e.name === '.git') continue;
      const sub = rel ? path.join(rel, e.name) : e.name;
      if (e.name === 'node_modules') { out.push(sub); continue; }
      if (nivel < 3 && !e.name.startsWith('.')) visitar(sub, nivel + 1);
    }
  };
  visitar('', 0);
  return out;
}

/**
 * Arma la copia de la base y devuelve `{ dir, borrar }`, o `{ motivo }`. `borrar` saca la copia del registro de git y
 * del disco; también se llama si el proceso se corta.
 */
function copiaDeLaBase(repo, sha) {
  const raiz = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-base-')), 'arbol');
  // la carpeta que se probó puede ser una subcarpeta del repo: la base corre en la misma subcarpeta de la copia
  const top = fuera(git(repo, 'rev-parse', '--show-toplevel'));
  const rel = top ? path.relative(R.rutaReal(top), R.rutaReal(repo)) : '';
  const dir = rel && !rel.startsWith('..') ? path.join(raiz, rel) : raiz;
  const r = git(repo, 'worktree', 'add', '--detach', '-q', raiz, sha);
  if (r.status !== 0) return { motivo: `no pude armar la copia de la base (${String(r.stderr || '').trim().split('\n')[0]})` };
  let borrada = false;
  const borrar = () => {
    if (borrada) return;
    borrada = true;
    git(repo, 'worktree', 'remove', '--force', raiz);
    try { fs.rmSync(path.dirname(raiz), { recursive: true, force: true }); } catch (_) { /* lo que quede lo limpia el sistema */ }
    git(repo, 'worktree', 'prune');
  };
  process.once('exit', borrar);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(s, () => { borrar(); process.exit(1); });
  for (const rel of carpetasDeModulos(repo)) {
    const destino = path.join(dir, rel);
    if (fs.existsSync(destino)) continue;
    try {
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.symlinkSync(path.join(repo, rel), destino, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      borrar();
      return { motivo: `no pude enlazar ${rel} en la copia de la base (${e.code || e.message})` };
    }
  }
  return { dir, borrar };
}

/** El entorno de la corrida en la base: una casa de prueba, sin las variables del marcador ni del portón. */
function entornoDeLaBase(casa) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^TYCON_|^CLAUDE_CODE_SESSION_ID$|^NODE_TEST_CONTEXT$/.test(k)) env[k] = v;
  if (!env.NUGET_PACKAGES) env.NUGET_PACKAGES = path.join(os.homedir(), '.nuget', 'packages');
  env.HOME = casa;
  env.USERPROFILE = casa;
  return env;
}

// ── correr en la base ───────────────────────────────────────────────────────────────────────────────────────────────

// El filtro de vstest: una barra invertida delante de lo que el filtro lee como sintaxis
const escaparFiltro = (s) => String(s).replace(/[\\()&|=!~,]/g, (c) => `\\${c}`);

/** Una corrida con tope de tiempo: `{ status, salida }`. */
function correr(cmd, args, { cwd, env }) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: TIEMPO_BASE_S() * 1000, maxBuffer: 64 * 1024 * 1024 });
  const salida = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.error && r.error.code === 'ETIMEDOUT') return { status: null, salida: `se cortó a los ${TIEMPO_BASE_S()} s (TYCON_INHERITED_BASE_TIMEOUT_S)` };
  if (r.error) return { status: null, salida: String(r.error.message || r.error) };
  return { status: r.status, salida };
}

const ultimas = (s, n = 3) => String(s || '').trim().split('\n').slice(-n).join(' · ').slice(0, 400);

/**
 * Corre en la copia de la base lo que falló y devuelve `{ casos }` (lo que corrió, con su resultado) o `{ motivo }`.
 * A una falla que la base no pudo correr se le pone el motivo (`f.motivo`) y queda no medida.
 */
function correrEnLaBase({ dir, runner, fallas, generico, env }) {
  const res = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-base-res-'));
  try {
    if (runner === 'jest' || runner === 'vitest') {
      const archivos = [...new Set(fallas.map((f) => f.file).filter(Boolean))];
      const salidaJson = path.join(res, `${runner}.json`);
      const args = runner === 'jest'
        ? ['jest', '--ci', '--json', '--outputFile', salidaJson, '--runTestsByPath', ...archivos]
        : ['vitest', 'run', '--coverage.enabled=false', '--reporter=json', '--outputFile', salidaJson, ...archivos];
      // en Windows npx es un .cmd, que sólo arranca por la consola: se corre su guion de npm con este mismo node, sin
      // consola, para que el nombre de un archivo nunca se lea como un comando
      const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
      let r;
      if (process.platform !== 'win32') r = correr('npx', args, { cwd: dir, env });
      else if (fs.existsSync(npxCli)) r = correr(process.execPath, [npxCli, ...args], { cwd: dir, env });
      else r = { status: null, salida: `no encontré npx junto a node (${npxCli})` };
      if (!fs.existsSync(salidaJson)) {
        return { motivo: `${runner} no dejó su reporte en la base (${r.status === null ? r.salida : `salió ${r.status}`}): las dependencias de ahora no sirven para la base, o falta algo que git no guarda · ${ultimas(r.salida)}` };
      }
      return { casos: casosDeJest(JSON.parse(fs.readFileSync(salidaJson, 'utf8')), dir) };
    }
    if (runner === 'dotnet') {
      const casos = [];
      const porProyecto = new Map();
      for (const f of fallas) { if (!porProyecto.has(f.project)) porProyecto.set(f.project, []); porProyecto.get(f.project).push(f); }
      // cada proyecto aparte, sin cadena: uno que falla no deja sin correr a los demás
      for (const [proyecto, delProyecto] of porProyecto) {
        const csproj = proyecto ? R.buscarArchivos(dir, (n) => n === `${proyecto}.csproj`)[0] : null;
        if (!csproj) { for (const f of delProyecto) f.motivo = `no encontré el proyecto ${proyecto || '(sin nombre)'} en la base`; continue; }
        const salidaDir = path.join(res, proyecto);
        const filtro = delProyecto.length <= TOPE_FILTRO_DOTNET && delProyecto.every((f) => f.fqn)
          ? ['--filter', [...new Set(delProyecto.map((f) => `FullyQualifiedName=${escaparFiltro(f.fqn)}`))].join('|')] : [];
        const r = correr('dotnet', ['test', csproj, ...filtro, '--logger', 'trx', '--results-directory', salidaDir, '--nologo'], { cwd: dir, env });
        const trx = R.buscarArchivos(salidaDir, (n) => n.endsWith('.trx'));
        if (!trx.length) {
          const restore = /restore|NU1\d{3}|unable to find package/i.test(r.salida) ? 'dotnet no pudo restaurar la base' : 'el proyecto no dejó su trx en la base';
          for (const f of delProyecto) f.motivo = `${restore} · ${ultimas(r.salida)}`;
          continue;
        }
        casos.push(...trx.flatMap(casosDeTrx));
      }
      return { casos };
    }
    // una herramienta de test-runners.js: su `scoped` con los archivos si lo tiene; si no, el comando sin cobertura
    if (!generico) return { motivo: `no sé cómo correr ${runner} en la base` };
    const archivos = [...new Set(fallas.map((f) => f.file).filter(Boolean))];
    let cmd = generico.scoped && archivos.length ? String(generico.scoped).replace(/\{files\}/g, archivos.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')) : null;
    if (cmd && /\{classes\}|\{project\}/.test(cmd)) cmd = null;
    if (!cmd) cmd = generico.commandWithoutCoverage || generico.command;
    if (!cmd) return { motivo: `${runner} no tiene comando para correr en la base` };
    cmd = cmd.replace(/\{results\}/g, res).replace(/\{tool\}/g, generico.tool || '');
    const r = correr('bash', ['-c', cmd], { cwd: dir, env });
    const defin = { ...generico, results: generico.results ? { ...generico.results, path: String(generico.results.path || '').replace(/\{results\}/g, res) } : null };
    const leidos = casosDeLaCorrida({ runner, resultsDir: res, repoRun: dir, generico: defin });
    if (leidos.error) return { motivo: `${leidos.error} en la base (${r.status === null ? r.salida : `salió ${r.status}`}) · ${ultimas(r.salida)}` };
    return { casos: leidos.casos };
  } finally {
    try { fs.rmSync(res, { recursive: true, force: true }); } catch (_) { /* temporal */ }
  }
}

// ── la corrida entera ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Por qué las dependencias de ahora no sirven para la base, o null: el cambio (lo commiteado desde la base y lo que no
 * se commiteó) toca un archivo que fija las dependencias de node, o un paquete del repo que un `node_modules` enlaza.
 */
function dependenciasTocadas(repo, sha) {
  const modulos = carpetasDeModulos(repo);
  if (!modulos.length) return null;
  const top = fuera(git(repo, 'rev-parse', '--show-toplevel'));
  const cambiados = [...fuera(git(repo, 'diff', '--name-only', sha)).split('\n'),
    ...fuera(git(repo, 'ls-files', '--others', '--exclude-standard', '--full-name')).split('\n')].filter(Boolean);
  const deps = cambiados.find((f) => DEPENDENCIAS_JS.has(path.posix.basename(f)));
  if (deps) return `el cambio toca las dependencias (${deps}): las de ahora no sirven para medir la base`;
  // los paquetes del repo enlazados en node_modules (un monorepo): apuntan al código de ahora, no al de la base
  const enlazados = [];
  for (const m of modulos) {
    const dir = path.join(repo, m);
    let entradas = [];
    try { entradas = fs.readdirSync(dir); } catch (_) { continue; }
    for (const e of entradas) {
      const hijos = e.startsWith('@') ? (() => { try { return fs.readdirSync(path.join(dir, e)).map((h) => path.join(e, h)); } catch (_) { return []; } })() : [e];
      for (const h of hijos) {
        const p = path.join(dir, h);
        try {
          if (!fs.lstatSync(p).isSymbolicLink()) continue;
          const real = fs.realpathSync(p);
          const rel = top ? path.relative(R.rutaReal(top), real) : '';
          if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('node_modules')) enlazados.push(rel.split(path.sep).join('/'));
        } catch (_) { /* un enlace roto no lleva a ningún paquete */ }
      }
    }
  }
  const tocado = cambiados.find((f) => enlazados.some((p) => f === p || f.startsWith(`${p}/`)));
  return tocado ? `el cambio toca un paquete del repo que node_modules enlaza (${tocado}): la base correría con el código de ahora` : null;
}

/**
 * Juzga una corrida roja: `{ exit, resultado }`. `resultado` es lo que se escribe en `inherited-cases.json`.
 */
function apply(repoRun, resultsDir, { runner, projects = 0, generico = null, medir = correrEnLaBase } = {}) {
  const max = process.env.TYCON_INHERITED_BASE_MAX;
  if (max !== undefined && max !== '' && Number(max) === 0) {
    return { exit: 10, resultado: { off: true, reason: 'TYCON_INHERITED_BASE_MAX=0: no se mide la base' } };
  }
  const leidos = casosDeLaCorrida({ runner, resultsDir, repoRun, generico });
  if (leidos.error) return { exit: 2, resultado: { reason: leidos.error } };
  const fallas = leidos.casos.filter((c) => c.failed);
  if (!fallas.length) return { exit: 2, resultado: { reason: 'la corrida salió roja pero su reporte no nombra ninguna prueba que falló' } };
  // un proyecto de .NET sin su trx no se midió: la corrida no se perdona. Se cuentan los proyectos distintos de los
  // reportes (uno con dos frameworks deja dos trx y no tapa a otro que no compiló)
  const conReporte = new Set(leidos.casos.map((c) => c.project).filter(Boolean)).size;
  if (runner === 'dotnet' && projects > 0 && conReporte < projects) {
    const res = juzgar(fallas, { motivo: `${projects - conReporte} de ${projects} proyecto(s) de pruebas no dejaron su trx (no compiló o se cortó): lo de ese proyecto no se midió` });
    return { exit: 1, resultado: { partial_run: true, ...res } };
  }
  // la corrida rompió algo fuera de las pruebas (un error no capturado, el proceso de pruebas caído): eso no lo nombra
  // ninguna prueba, así que no se puede comparar con la base
  const log = (() => { try { return fs.readFileSync(path.join(resultsDir, 'run.log'), 'utf8'); } catch (_) { return ''; } })();
  const afuera = FUERA_DE_LAS_PRUEBAS.exec(log);
  if (afuera) return { exit: 1, resultado: juzgar(fallas, { motivo: `la corrida falló también fuera de las pruebas («${afuera[0]}»): eso no se compara con la base` }) };
  if (fallas.length > TOPE_FALLAS) {
    return { exit: 1, resultado: juzgar(fallas, { motivo: `${fallas.length} fallas (más de ${TOPE_FALLAS}): es una base rota, no un par de pruebas viejas` }) };
  }
  const base = ramaPrincipal(repoRun);
  if (base.motivo) return { exit: 1, resultado: juzgar(fallas, { motivo: base.motivo }) };
  // la base corre con las dependencias de ahora: si el cambio las tocó, o tocó un paquete del repo que node_modules
  // enlaza, la base correría con lo del cambio y una falla que trajo el cambio parecería de antes
  const sinDeps = dependenciasTocadas(repoRun, base.sha);
  if (sinDeps) return { exit: 1, resultado: { base, ...juzgar(fallas, { motivo: sinDeps }) } };
  const copia = copiaDeLaBase(repoRun, base.sha);
  if (copia.motivo) return { exit: 1, resultado: { base, ...juzgar(fallas, { motivo: copia.motivo }) } };
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-base-casa-'));
  let medido;
  try {
    medido = medir({ dir: copia.dir, runner, fallas, generico, env: entornoDeLaBase(casa) });
  } finally {
    copia.borrar();
    try { fs.rmSync(casa, { recursive: true, force: true }); } catch (_) { /* temporal */ }
  }
  // la base falla pruebas que ahora pasan: su entorno no es el de ahora (un archivo que git no guarda, una variable), o
  // el cambio las arregló. En los dos casos una falla de allá no prueba nada: no se perdona ninguna
  const pasanAhora = new Set(leidos.casos.filter((c) => !c.failed).map((c) => c.key));
  const rotasSoloAlla = ((medido && medido.casos) || []).filter((c) => c.failed && pasanAhora.has(c.key));
  if (rotasSoloAlla.length) {
    const ej = rotasSoloAlla[0].name || rotasSoloAlla[0].key;
    return { exit: 1, resultado: { base, ...juzgar(fallas, { motivo: `la base falla ${rotasSoloAlla.length} prueba(s) que ahora pasan (por ejemplo «${ej}»): su entorno no es el de ahora, o el cambio las arregló` }) } };
  }
  const res = juzgar(fallas, medido);
  return { exit: res.blocking.length ? 1 : 0, resultado: { base, ...res } };
}

function main(argv) {
  const [cmd, repoRun, resultsDir, ...resto] = argv;
  const valor = (n) => { const i = resto.indexOf(n); return i >= 0 ? resto[i + 1] : undefined; };
  if (cmd !== 'apply' || !repoRun || !resultsDir || !valor('--runner')) {
    process.stderr.write('uso: inherited-cases.js apply <carpeta que se probó> <carpeta de resultados> --runner <herramienta> [--projects N]\n');
    return 2;
  }
  let generico = null;
  try { generico = JSON.parse(fs.readFileSync(path.join(resultsDir, 'runner.json'), 'utf8')); } catch (_) { generico = null; }
  const { exit, resultado } = apply(repoRun, resultsDir, { runner: valor('--runner'), projects: Number(valor('--projects')) || 0, generico });
  try { fs.writeFileSync(path.join(resultsDir, 'inherited-cases.json'), `${JSON.stringify({ exit, ...resultado }, null, 2)}\n`); } catch (e) {
    process.stderr.write(`[heredadas] 🔴 no pude escribir inherited-cases.json (${e.message}): el portón queda rojo\n`);
    return 1;
  }
  const nombre = (c) => (c.name ? `${c.file || c.project || c.classname || ''}${c.file || c.project || c.classname ? ' · ' : ''}${c.name}` : `${c.file} (${c.did_not_run ? 'no corrió' : 'falló el archivo'})`);
  if (exit === 10) process.stderr.write(`[heredadas] apagado: ${resultado.reason}\n`);
  else if (exit === 2) process.stderr.write(`[heredadas] no pude decidir: ${resultado.reason}\n`);
  else {
    if (resultado.base && resultado.base.ref) process.stderr.write(`[heredadas] base: ${resultado.base.ref} @ ${String(resultado.base.sha).slice(0, 9)} (la rama, del ${resultado.base.fecha})\n`);
    for (const c of resultado.inherited || []) process.stderr.write(`[heredadas] 🟡 ya fallaba en la base: ${nombre(c)}\n`);
    for (const c of resultado.blocking || []) process.stderr.write(`[heredadas] 🔴 ${nombre(c)}: ${c.reason}${c.detail ? ` (${c.detail})` : ''}\n`);
  }
  return exit;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { ramaPrincipal, casosDeLaCorrida, casosDeTrx, casosDeJest, casosDeJunit, juzgar, copiaDeLaBase, correrEnLaBase, apply, escaparFiltro, TOPE_FALLAS, TOPE_FILTRO_DOTNET };
