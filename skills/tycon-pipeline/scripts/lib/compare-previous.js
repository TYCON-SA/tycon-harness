'use strict';
/**
 * El humo comparado (historia 8.167): un comando que el cambio toca se corre con `main` y con el cambio, aislados, y se
 * comparan su código de salida y su salida normalizada. Deja el resultado en `compare-previous.json` de la carpeta de la
 * corrida; «Preparar el commit» frena por una diferencia que la historia no declara.
 *
 * Cómo se aísla cada corrida:
 *   - Dos clones locales del repo del comando, sin remoto (no un worktree: compartiría el `.git` del repo real). El de
 *     `main` en el `origin/main` recién traído; el del cambio en el HEAD del repo con sus archivos sin commitear (lo
 *     ignorado no entra, los borrados se borran). Un par por repo y por corrida del pipeline: los humos siguientes lo
 *     reusan; el del cambio se rehace si cambió el sello del repo, el de `main` si cambió lo traído.
 *   - Una casa vacía nueva en cada corrida, las mismas variables y la misma carpeta de trabajo relativa a la raíz.
 *   - La red, cortada por capas: reemplazos adelante en el PATH (git corta push, fetch, pull, clone, ls-remote, remote y
 *     submodule; gh, az, curl, wget y ssh cortan todo; salen 97 y dejan marca), GIT_ALLOW_PROTOCOL vacío, los proxys a un
 *     puerto cerrado, NODE_OPTIONS con compare-shims/no-network.js, y el encierro del sistema cuando está (en macOS
 *     `sandbox-exec`, que corta la red y la escritura fuera de las corridas; en Linux `unshare -rn`, sólo la red).
 *   - Lo que se niega a comparar, sin correrlo: un comando que nombra la raíz del repo real o la casa real por ruta
 *     absoluta, o que empieza con `sudo`. `{raiz}` en el comando se reemplaza por la raíz de cada clon.
 *
 * Lo que sigue sin aislar, dicho: las corridas ejecutan código fuera de los ganchos de seguridad; sin encierro, un
 * programa que abre la red sin Node, sin el proxy y sin los reemplazos llega a la red, y uno que escribe por ruta
 * absoluta fuera de los clones y las casas escribe. Un `git push` por ruta absoluta falla por falta de remoto y de
 * protocolo, sin marca: el resultado es el de la comparación.
 *
 * Topes por variable: TYCON_COMPARE_MAX (humos comparados por corrida, 10), TYCON_COMPARE_TIMEOUT_MS (cada corrida,
 * 60 s; después SIGTERM y a los 5 s SIGKILL) y TYCON_COMPARE_TOTAL_MS (todo, por corrida del pipeline, 5 min). Pasado
 * cualquiera: «no comparado: tope». Los clones viven en `<estado>/compare-previous/<sesión>/`; se borran al cerrar la
 * corrida, y al empezar se barren los de las corridas que ya no están abiertas.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const RAIZ_ARNES = path.join(__dirname, '..', '..', '..', '..');
const SHIMS = path.join(__dirname, 'compare-shims');
const NO_NETWORK = path.join(SHIMS, 'no-network.js');
const INFORME = 'compare-previous.json';
const MAX_LINEAS = 20;
const GRACIA_MS = 5000;
// lo que se guarda de la salida de cada lado; si se corta, la salida lo dice
const TOPE_SALIDA = 1024 * 1024;
const CORTADA = '[salida cortada a 1 MB]';

const numero = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const topes = (env = process.env) => ({
  humos: numero(env.TYCON_COMPARE_MAX, 10),
  corridaMs: numero(env.TYCON_COMPARE_TIMEOUT_MS, 60000),
  totalMs: numero(env.TYCON_COMPARE_TOTAL_MS, 300000),
});

const entornoDeGit = () => require(path.join(RAIZ_ARNES, 'scripts', 'lib', 'clean-git-env.js'));
function git(args, { env = {}, timeout = 60000 } = {}) {
  const e = entornoDeGit();
  const r = spawnSync('git', args, { windowsHide: true, encoding: 'utf8', env: e.idiomaFijo(e.sinGitDelPadre(process.env), env), timeout, maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, out: String(r.stdout || '').trim(), crudo: String(r.stdout || ''), err: String((r.error && r.error.message) || r.stderr || '').trim() };
}
const unaLinea = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || 'sin detalle';
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
// un nombre que se vuelve carpeta: sin barras, y nunca «.», «..» ni con punto adelante (saldría de su carpeta)
const seguro = (s) => { const t = String(s).replace(/[^\w.-]/g, '_') || '_'; return t.startsWith('.') ? `_${t}` : t; };
/** ¿`p` queda dentro de `base`? Se mira antes de borrar o escribir en una carpeta armada con un nombre. */
const dentroDe = (base, p) => { const r = path.relative(path.resolve(base), path.resolve(p)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
const hash8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
function borrar(dir) {
  if (!fs.existsSync(dir)) return;
  try { spawnSync('chmod', ['-R', 'u+w', dir], { windowsHide: true }); } catch (_) { /* lo intenta el borrado */ }
  fs.rmSync(dir, { recursive: true, force: true });
}
const raizDe = (p) => { const r = git(['-C', fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p), 'rev-parse', '--show-toplevel']); return r.ok && r.out ? real(r.out) : null; };

// ── Dónde viven los clones ──────────────────────────────────────────────────────────────────────────────────────────
const carpetaDeComparar = (stateDir) => path.join(stateDir, 'compare-previous');
const carpetaDeLaSesion = (stateDir, sid) => path.join(carpetaDeComparar(stateDir), seguro(sid));

/** Borra los clones de las corridas que ya no están abiertas (sin marcador en `active/`). Devuelve las sesiones barridas. */
function barrer(stateDir) {
  let sesiones = [];
  try { sesiones = fs.readdirSync(carpetaDeComparar(stateDir)); } catch (_) { return []; }
  const out = [];
  for (const sid of sesiones) {
    // sólo lo que pudo crear este módulo: un nombre que ya es seguro y queda dentro de la carpeta de comparar
    if (sid !== seguro(sid) || !dentroDe(carpetaDeComparar(stateDir), path.join(carpetaDeComparar(stateDir), sid))) continue;
    if (fs.existsSync(path.join(stateDir, 'active', `${sid}.json`))) continue;
    try { borrar(path.join(carpetaDeComparar(stateDir), sid)); out.push(sid); } catch (_) { /* la próxima vez */ }
  }
  return out.sort();
}

/** Borra los clones de una corrida (al cerrarla). */
function limpiar(stateDir, sid) {
  const dir = carpetaDeLaSesion(stateDir, sid);
  if (!dentroDe(carpetaDeComparar(stateDir), dir)) throw new Error(`limpiar: ${dir} no queda dentro de ${carpetaDeComparar(stateDir)}`);
  borrar(dir);
}

// ── La normalización (decisión 5): una lista cerrada ────────────────────────────────────────────────────────────────
const escaparRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function normalizar(texto, { raices = [], casas = [], heads = [], ramas = [] } = {}) {
  let t = String(texto || '');
  // las casas pueden vivir dentro de la carpeta de los clones: primero lo más largo
  const rutas = [...raices.map((r) => [r, '<RAIZ>']), ...casas.map((c) => [c, '<CASA>'])].filter(([x]) => x).sort((a, b) => b[0].length - a[0].length);
  for (const [x, marca] of rutas) t = t.split(x).join(marca);
  for (const h of heads.filter((x) => /^[0-9a-f]{40}$/.test(x))) t = t.replace(new RegExp(`\\b${h.slice(0, 7)}[0-9a-f]{0,33}\\b`, 'g'), '<HEAD>');
  for (const r of [...new Set(ramas.filter(Boolean))].sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(`(^|[^\\w/.-])${escaparRe(r)}(?![\\w/.-])`, 'g'), '$1<RAMA>');
  t = t.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<HORA>');
  t = t.replace(/\(\d+(?:\.\d+)?ms\)/g, '(<MS>)');
  t = t.replace(/duration_ms \d+(?:\.\d+)?/g, 'duration_ms <MS>');
  // los segundos al final de un renglón de resumen del arnés (los que llevan « · » o arrancan con «ℹ»), no de cualquiera:
  // «timeout: 30s» contra «timeout: 600s» es un cambio
  t = t.split('\n').map((l) => (/ · |^ℹ /.test(l) ? l.replace(/(\s)\d+(?:\.\d+)?s$/, '$1<S>') : l)).join('\n');
  t = t.replace(/\bpid \d+\b/g, 'pid <PID>');
  return t;
}

/** `{ igual, diff }`: el código de salida y la salida normalizada; `diff`, las primeras 20 líneas que difieren. */
function comparar(a, b) {
  const la = String(a.salida).split('\n');
  const lb = String(b.salida).split('\n');
  const diff = [];
  for (let i = 0; i < Math.max(la.length, lb.length) && diff.length < MAX_LINEAS; i++) {
    if (la[i] !== lb[i]) diff.push({ linea: i + 1, main: la[i] === undefined ? null : la[i], cambio: lb[i] === undefined ? null : lb[i] });
  }
  return { igual: a.exit === b.exit && a.salida === b.salida, diff };
}

// ── Lo que se niega a comparar (decisión 13) ────────────────────────────────────────────────────────────────────────
function tocaLoReal(texto, { raicesReales = [], casaReal = os.homedir() } = {}) {
  const t = String(texto || '');
  if (/^\s*sudo\b/.test(t)) return 'empieza con sudo';
  for (const r of raicesReales.filter(Boolean)) {
    for (const v of new Set([r, real(r)])) if (t.includes(v)) return `nombra la raíz del repo real (${v})`;
  }
  for (const v of new Set([casaReal, real(casaReal)].filter(Boolean))) if (t.includes(v)) return `nombra la casa real (${v})`;
  return null;
}

// ── El encierro del sistema (decisión 4, capa e) ────────────────────────────────────────────────────────────────────
function encierro(env = process.env) {
  if (env.TYCON_COMPARE_SANDBOX === 'off') return { nombre: 'ninguno', corta: 'nada: corren con las otras capas' };
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) return { nombre: 'sandbox-exec', corta: 'red y escritura' };
  if (process.platform === 'linux') {
    const r = spawnSync('unshare', ['-rn', 'true'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    if (!r.error && r.status === 0) return { nombre: 'unshare', corta: 'sólo red · escritura sin cortar' };
  }
  return { nombre: 'ninguno', corta: 'nada: corren con las otras capas' };
}
const sbplString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
function perfilSandbox(escribibles) {
  const permitidas = [...new Set(escribibles.flatMap((p) => [p, real(p)]))].map((p) => `(subpath ${sbplString(p)})`).join(' ');
  return `(version 1)(allow default)(deny network*)(deny file-write* (require-not (require-any ${permitidas} (subpath "/dev"))))`;
}

/** El git de verdad, para los reemplazos: el primero del PATH que no es el de compare-shims. */
function gitDeVerdad() {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d || real(d) === real(SHIMS)) continue;
    const p = path.join(d, 'git');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* el siguiente */ }
  }
  return '/usr/bin/git';
}

// ── Los dos clones ──────────────────────────────────────────────────────────────────────────────────────────────────
function clonar(repo, dir) {
  borrar(dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const c = git(['clone', '-q', '--no-hardlinks', '--no-checkout', repo, dir], { timeout: 120000 });
  if (!c.ok) return `no pude clonar ${repo}: ${unaLinea(c.err)}`;
  return null;
}
function sinRemoto(dir) {
  const rs = git(['-C', dir, 'remote']);
  for (const r of rs.ok ? rs.out.split('\n').filter(Boolean) : []) git(['-C', dir, 'remote', 'remove', r]);
}

/**
 * El par de clones de un repo en esta corrida: `{ main, cambio, rama, reusados }` o `{ error }`. El de `main` se rehace
 * si cambió lo traído; el del cambio, si cambió el sello del repo (su HEAD más lo sin commitear).
 */
function clones({ repo, stateDir, sid, mainHead }) {
  const base = path.join(carpetaDeLaSesion(stateDir, sid), `${seguro(path.basename(repo))}-${hash8(real(repo))}`);
  const metaF = path.join(base, 'meta.json');
  if (!dentroDe(carpetaDeComparar(stateDir), base)) return { error: `la carpeta de los clones (${base}) no queda dentro de ${carpetaDeComparar(stateDir)}` };
  let meta = {};
  let metaIlegible = null;
  try { meta = JSON.parse(fs.readFileSync(metaF, 'utf8')); } catch (e) {
    meta = {};
    // sin la constancia de los clones se rehacen los dos; si estaba y no se lee, se dice
    if (e.code !== 'ENOENT') metaIlegible = `la constancia de los clones no se leía (${e.code || e.message}): se rehicieron`;
  }
  const sello = require('./frozen-tree.js').seal(repo);
  if (sello.error) return { error: sello.error };
  const head = git(['-C', repo, 'rev-parse', '--verify', 'HEAD']);
  if (!head.ok) return { error: `${repo} no tiene HEAD: ${unaLinea(head.err)}` };
  const ramaReal = git(['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']).out;
  const rama = ramaReal && ramaReal !== 'HEAD' && ramaReal !== 'compare-main' ? ramaReal : 'compare-cambio';
  const dirMain = path.join(base, 'main');
  const dirCambio = path.join(base, 'cambio');
  const reusados = { main: true, cambio: true };
  if (!fs.existsSync(dirMain) || meta.mainHead !== mainHead) {
    reusados.main = false;
    const e = clonar(repo, dirMain);
    if (e) return { error: e };
    let co = git(['-C', dirMain, 'checkout', '-q', '-B', 'compare-main', mainHead]);
    if (!co.ok) {
      git(['-C', dirMain, 'fetch', '-q', repo, '+refs/remotes/origin/main:refs/compare/main']);
      co = git(['-C', dirMain, 'checkout', '-q', '-B', 'compare-main', mainHead]);
    }
    if (!co.ok) return { error: `no pude poner el clon de main en ${mainHead}: ${unaLinea(co.err)}` };
    sinRemoto(dirMain);
  }
  if (!fs.existsSync(dirCambio) || meta.cambio !== sello.tree) {
    reusados.cambio = false;
    const e = clonar(repo, dirCambio);
    if (e) return { error: e };
    const co = git(['-C', dirCambio, 'checkout', '-q', '-B', rama, head.out]);
    if (!co.ok) return { error: `no pude poner el clon del cambio en ${head.out}: ${unaLinea(co.err)}` };
    // lo sin commitear del repo real: lo modificado y lo nuevo que git no ignora se copia; lo borrado se borra
    const st = git(['-C', repo, 'status', '--porcelain', '-z', '--untracked-files=all', '--no-renames']);
    if (!st.ok) return { error: `no pude leer lo sin commitear de ${repo}: ${unaLinea(st.err)}` };
    for (const e2 of st.crudo.split('\0').filter(Boolean)) {
      const xy = e2.slice(0, 2);
      const rel = e2.slice(3);
      const dest = path.join(dirCambio, rel);
      if (xy.includes('D')) { fs.rmSync(dest, { force: true }); continue; }
      const src = path.join(repo, rel);
      try {
        if (fs.lstatSync(src).isDirectory()) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        fs.chmodSync(dest, fs.statSync(src).mode & 0o777);
      } catch (err) { return { error: `no pude copiar ${rel} al clon del cambio: ${unaLinea(err.message)}` }; }
    }
    sinRemoto(dirCambio);
  }
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(metaF, JSON.stringify({ mainHead, cambio: sello.tree }));
  return { base, main: dirMain, cambio: dirCambio, rama, reusados, heads: [mainHead, head.out], sello: sello.tree, ...(metaIlegible ? { metaIlegible } : {}) };
}

// ── Una corrida ─────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Corre un lado. La salida y la de error van al MISMO archivo (`salidaF`), por el mismo descriptor: quedan mezcladas en
 * el orden en que el programa las escribe. Con dos tubos el orden dependería de cuál lee primero el padre, y el mismo
 * código daría «distinto» de una corrida a otra.
 */
function correr({ argv, cwd, env, enc, perfil, tiempoMs, salidaF }) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const t0 = Date.now();
    const lanzar = enc.nombre === 'sandbox-exec' ? ['/usr/bin/sandbox-exec', ['-p', perfil, cmd, ...args]]
      : enc.nombre === 'unshare' ? ['unshare', ['-rn', cmd, ...args]] : [cmd, args];
    let extra = '';
    let tope = false;
    let hijo;
    let fd;
    try {
      fd = fs.openSync(salidaF, 'w');
      hijo = spawn(lanzar[0], lanzar[1], { windowsHide: true, cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    } catch (e) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* ya cerrado */ }
      resolve({ exit: 127, salida: `no se pudo correr: ${e.message}`, ms: Date.now() - t0, tope: false });
      return;
    }
    const matar = (senal) => { try { process.kill(-hijo.pid, senal); } catch (_) { try { hijo.kill(senal); } catch (_e) { /* ya terminó */ } } };
    let duro = null;
    const blando = setTimeout(() => { tope = true; matar('SIGTERM'); duro = setTimeout(() => matar('SIGKILL'), GRACIA_MS); }, tiempoMs);
    hijo.on('error', (e) => { extra += `no se pudo correr: ${e.message}`; });
    hijo.on('close', (code, signal) => {
      clearTimeout(blando);
      if (duro) clearTimeout(duro);
      try { fs.closeSync(fd); } catch (_) { /* ya cerrado */ }
      let salida = '';
      let cortada = false;
      try {
        const b = fs.readFileSync(salidaF);
        cortada = b.length > TOPE_SALIDA;
        salida = b.subarray(0, TOPE_SALIDA).toString('utf8') + (cortada ? `\n${CORTADA}\n` : '');
      } catch (e) { extra += `no pude leer la salida (${e.code || e.message})`; }
      resolve({ exit: code === null ? (signal ? 128 : 1) : code, salida: salida + extra, ms: Date.now() - t0, tope, cortada });
    });
  });
}

function entornoDeCorrida({ casa, marcas, gitReal }) {
  const e = entornoDeGit().sinGitDelPadre(process.env);
  // la cobertura del proceso que compara no viaja: su carpeta queda fuera del encierro, y el aviso de Node al no poder
  // escribirla lleva el número de proceso, distinto en cada corrida (una diferencia que no es del comando). Va vacía
  // y no borrada: Node vuelve a poner la del padre en cada hijo cuyo entorno no la trae
  e.NODE_V8_COVERAGE = '';
  const previas = String(e.NODE_OPTIONS || '').trim();
  return {
    ...e,
    HOME: casa, USERPROFILE: casa,
    PATH: `${SHIMS}${path.delimiter}${e.PATH || ''}`,
    GIT_ALLOW_PROTOCOL: '',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
    http_proxy: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1', all_proxy: 'http://127.0.0.1:1',
    NODE_OPTIONS: `${previas ? `${previas} ` : ''}--require ${NO_NETWORK}`,
    TYCON_COMPARE_MARKS: marcas,
    TYCON_COMPARE_REAL_GIT: gitReal,
  };
}

// ── Qué corre el comando, y de qué repo ─────────────────────────────────────────────────────────────────────────────
const INTERPRETES = /^(node|bash|sh|zsh|python3?|ruby|perl|deno|bun|npx|tsx)$/;
// las opciones de los intérpretes que llevan su valor en la palabra siguiente
const CON_VALOR = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type',
  '--env-file', '--title', '-o', '-O', '--rcfile', '--init-file', '-W', '-X', '-m']);
/** El archivo que corre el comando (el primero que no es el intérprete), con `{raiz}` reemplazado; null si no hay. */
function archivoQueCorre(argv, { cwd, raiz }) {
  const toks = argv.map((a) => (raiz ? String(a).split('{raiz}').join(raiz) : String(a)));
  let i = 0;
  if (toks[0] && INTERPRETES.test(path.basename(toks[0]))) {
    i = 1;
    // las opciones del intérprete, con su valor cuando lo llevan aparte (`node -r ./setup.js tool.js`)
    while (toks[i] && toks[i].startsWith('-')) i += CON_VALOR.has(toks[i]) ? 2 : 1;
  }
  const t = toks[i];
  if (!t || t.includes('{raiz}')) return null;
  const abs = path.isAbsolute(t) ? t : path.resolve(cwd, t);
  return fs.existsSync(abs) ? real(abs) : null;
}

/** Los repos de la corrida de la sesión (el de la historia y el del código), o el del cwd. */
function reposDeLaSesion({ stateDir, sid, cwd }) {
  const out = [];
  try {
    const m = JSON.parse(fs.readFileSync(path.join(stateDir, 'active', `${seguro(sid)}.json`), 'utf8'));
    for (const p of [m.storyPath && (path.isAbsolute(m.storyPath) ? m.storyPath : path.join(m.repoPath || cwd, m.storyPath)), m.repoPath]) {
      const r = p ? raizDe(p) : null;
      if (r && !out.includes(r)) out.push(r);
    }
  } catch (_) { /* sin marcador */ }
  const delCwd = raizDe(cwd);
  if (delCwd && !out.includes(delCwd)) out.push(delCwd);
  return out;
}

/**
 * La raíz de `{raiz}` (decisión 13): la del repo de los `--covers`, o la del archivo que corre el comando. Con
 * `--covers` de dos repos, o de un archivo que no está en ningún repo de la corrida, es ambigua.
 * `{ raiz, repo, ambigua? }`.
 */
function raizDelHumo({ argv, covers = [], cwd, repos }) {
  if (covers.length) {
    const deCada = covers.map((c) => {
      const rel = String(c).split(':')[0];
      return repos.find((r) => fs.existsSync(path.join(r, rel))) || null;
    });
    if (deCada.some((r) => !r)) return { ambigua: 'un --covers nombra un archivo que no está en ningún repo de la corrida' };
    if (new Set(deCada).size > 1) return { ambigua: 'los --covers son de dos repos' };
    return { raiz: deCada[0], repo: deCada[0] };
  }
  const delCwd = raizDe(cwd);
  const archivo = archivoQueCorre(argv, { cwd, raiz: delCwd });
  const repo = (archivo && raizDe(archivo)) || delCwd;
  return { raiz: repo, repo };
}

// ── El informe ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** El informe de la corrida: `{ entradas, error? }`. Sin archivo, ninguna entrada; uno que no se lee lo dice `error`. */
function leerInformeDetallado(runDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(runDir, INFORME), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { entradas: [] } : { entradas: [], error: `${INFORME} no se lee (${e.code || e.message})` };
  }
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? { entradas: a } : { entradas: [], error: `${INFORME} no es una lista` };
  } catch (e) { return { entradas: [], error: `${INFORME} no es JSON (${e.message})` }; }
}
function leerInforme(runDir) { return leerInformeDetallado(runDir).entradas; }
// la huella de una entrada del informe: el renglón del registro del arnés y la entrada tienen que decir lo mismo
const huellaDe = (entrada) => crypto.createHash('sha256').update(JSON.stringify(entrada)).digest('hex').slice(0, 16);

/**
 * Anota una entrada en el informe de la corrida y su renglón en el `gates.log` del arnés (`stateDir`), donde el agente no
 * escribe: el freno cuenta sólo las entradas que tienen su renglón, así una escrita a mano en el informe no cumple.
 */
function anotarEntrada(runDir, stateDir, entrada) {
  fs.mkdirSync(runDir, { recursive: true });
  const l = leerInformeDetallado(runDir);
  // un informe que no se lee no se pisa en silencio: queda aparte, con su hora, y el nuevo arranca de cero
  if (l.error) {
    try { fs.renameSync(path.join(runDir, INFORME), path.join(runDir, `${INFORME}.ilegible-${Date.now()}`)); } catch (_) { /* no estaba */ }
    process.stderr.write(`[compare] ⚠️ ${l.error}: lo dejé aparte y empiezo uno nuevo\n`);
  }
  const a = l.entradas;
  a.push(entrada);
  fs.writeFileSync(path.join(runDir, INFORME), JSON.stringify(a, null, 2), 'utf8');
  if (stateDir) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), name: 'compare-previous', sid: entrada.sid || null, resultado: entrada.resultado, huella: huellaDe(entrada) })}\n`);
  }
  return entrada;
}

/**
 * Las entradas del informe que tienen su renglón en el registro del arnés: `{ entradas, sinRegistro, error?,
 * registroIlegible?, descartados }`. Un informe o un registro que no se leen lo dicen: no es «no hubo comparaciones».
 */
function informeVerificado(runDir, stateDir) {
  const l = runDir ? leerInformeDetallado(runDir) : { entradas: [] };
  const todas = l.entradas;
  let huellas = new Set();
  let registroIlegible = null;
  let descartados = 0;
  try {
    for (const linea of fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8').split('\n')) {
      if (!linea.includes('"compare-previous"')) continue;
      try { const g = JSON.parse(linea); if (g.name === 'compare-previous' && g.huella) huellas.add(g.huella); } catch (_) { descartados++; }
    }
  } catch (e) {
    huellas = new Set();
    if (e.code !== 'ENOENT' || todas.length) registroIlegible = `el registro del arnés no se lee (${e.code || e.message})`;
  }
  const entradas = todas.filter((e) => huellas.has(huellaDe(e)));
  return { entradas, sinRegistro: todas.length - entradas.length, descartados, ...(l.error ? { error: l.error } : {}), ...(registroIlegible ? { registroIlegible } : {}) };
}

/**
 * Compara un humo: `argv` es el comando (con `{raiz}` literal si lo dice), `cmd` su texto ya tapado (el que guarda el
 * registro), `cwd` la carpeta desde donde corre el humo. Anota la entrada en el informe de `runDir` y la devuelve:
 * `{ resultado: 'igual' | 'distinto' | 'nuevo' | 'no-comparado', motivo?, main?, cambio?, diff?, encierro, ... }`.
 */
async function compararHumo({ argv, cmd, cwd = process.cwd(), runDir, sid, stateDir, covers = [], env = process.env }) {
  const t0 = Date.now();
  const tp = topes(env);
  const enc = encierro(env);
  const repos = reposDeLaSesion({ stateDir, sid, cwd });
  const entrada = { ts: new Date().toISOString(), sid, cmd: cmd || argv.join(' '), covers, encierro: enc };
  const fin = (extra) => anotarEntrada(runDir, stateDir, { ...entrada, ...extra, ms: Date.now() - t0 });
  const noComparado = (motivo, extra = {}) => fin({ resultado: 'no-comparado', motivo, ...extra });
  barrer(stateDir);
  const previas = leerInforme(runDir).filter((e) => e.sid === sid);
  if (previas.length >= tp.humos) return noComparado(`tope: ya hubo ${previas.length} humo(s) comparado(s) en esta corrida (TYCON_COMPARE_MAX=${tp.humos})`);
  const gastado = previas.reduce((s, e) => s + (Number(e.ms) || 0), 0);
  const quedaMs = tp.totalMs - gastado;
  if (quedaMs <= 0) return noComparado(`tope: la corrida ya usó ${gastado} ms de comparación (TYCON_COMPARE_TOTAL_MS=${tp.totalMs})`);
  const niega = tocaLoReal(argv.join(' '), { raicesReales: repos });
  if (niega) return noComparado(`toca lo real: ${niega}`);
  const r = raizDelHumo({ argv, covers, cwd, repos });
  if (r.ambigua) return noComparado(`raíz ambigua: ${r.ambigua}`);
  if (!r.repo) return noComparado('sin repo: el comando no corre ningún archivo de un repo de git');
  const repo = r.repo;
  entrada.repo = repo;
  const archivo = archivoQueCorre(argv, { cwd, raiz: repo });
  entrada.archivo = archivo && archivo.startsWith(`${repo}${path.sep}`) ? path.relative(repo, archivo).split(path.sep).join('/') : null;
  // `main` al día: el arnés trae `origin/main` en el repo real, no el comando
  const traer = git(['-C', repo, 'fetch', '-q', 'origin', 'main'], { timeout: Math.min(60000, quedaMs) });
  if (!traer.ok) return noComparado(`sin main al día: el git fetch de origin main falló (${unaLinea(traer.err)})`);
  const mainHead = git(['-C', repo, 'rev-parse', '--verify', 'origin/main^{commit}']);
  if (!mainHead.ok) return noComparado(`sin main al día: no hay origin/main (${unaLinea(mainHead.err)})`);
  entrada.main_head = mainHead.out;
  if (entrada.archivo && !git(['-C', repo, 'cat-file', '-e', `${mainHead.out}:${entrada.archivo}`]).ok) {
    return fin({ resultado: 'nuevo', motivo: 'nuevo, no se compara: el archivo no está en main' });
  }
  const c = clones({ repo, stateDir, sid, mainHead: mainHead.out });
  if (c.error) return noComparado(c.error);
  entrada.clones = { main: c.reusados.main ? 'reusado' : 'nuevo', cambio: c.reusados.cambio ? 'reusado' : 'nuevo', ...(c.metaIlegible ? { aviso: c.metaIlegible } : {}) };
  // el árbol que se probó: el freno cuenta la entrada sólo mientras el código del repo siga siendo ése
  entrada.sello = c.sello;
  const rel = path.relative(repo, real(cwd));
  const cwdRel = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : '';
  const gitReal = gitDeVerdad();
  const lados = {};
  for (const lado of ['main', 'cambio']) {
    const raizClon = c[lado];
    const casa = path.join(c.base, `casa-${lado}`);
    borrar(casa);
    fs.mkdirSync(casa, { recursive: true });
    const marcas = path.join(c.base, `marcas-${lado}.txt`);
    fs.rmSync(marcas, { force: true });
    const restante = tp.totalMs - gastado - (Date.now() - t0);
    if (restante <= 0) return noComparado(`tope: la corrida pasó TYCON_COMPARE_TOTAL_MS=${tp.totalMs} antes de la corrida de ${lado}`);
    // la carpeta temporal de la corrida vive en su casa: el encierro deja escribir sólo en los clones y las casas
    const temporal = path.join(casa, 'tmp');
    fs.mkdirSync(temporal, { recursive: true });
    const perfil = perfilSandbox([c.base]);
    const dirTrabajo = path.join(raizClon, cwdRel);
    const corrida = await correr({
      argv: argv.map((a) => String(a).split('{raiz}').join(raizClon)),
      cwd: fs.existsSync(dirTrabajo) ? dirTrabajo : raizClon,
      env: { ...entornoDeCorrida({ casa, marcas, gitReal }), TMPDIR: temporal, TMP: temporal, TEMP: temporal },
      enc, perfil, tiempoMs: Math.min(tp.corridaMs, restante), salidaF: path.join(casa, 'salida.txt'),
    });
    let marcasTxt = '';
    try { marcasTxt = fs.readFileSync(marcas, 'utf8').trim(); } catch (_) { marcasTxt = ''; }
    lados[lado] = { ...corrida, casa, raiz: raizClon, marcas: marcasTxt ? marcasTxt.split('\n') : [] };
    if (corrida.tope) {
      return noComparado(`tope: la corrida de ${lado} pasó ${Math.min(tp.corridaMs, restante)} ms (TYCON_COMPARE_TIMEOUT_MS o TYCON_COMPARE_TOTAL_MS)`, {
        main: lados.main ? { exit: lados.main.exit, ms: lados.main.ms } : undefined,
      });
    }
  }
  const resumen = (l) => ({ exit: l.exit, ms: l.ms, ...(l.marcas.length ? { marcas: l.marcas } : {}) });
  if (lados.main.marcas.length || lados.cambio.marcas.length) {
    return noComparado(`usa la red: ${[...new Set([...lados.main.marcas, ...lados.cambio.marcas])].join(', ')}`, { main: resumen(lados.main), cambio: resumen(lados.cambio) });
  }
  // las rutas tal cual y por su camino real: con un enlace en la carpeta de estado, Node y git imprimen la real
  const conReal = (xs) => [...new Set(xs.flatMap((x) => [x, real(x)]))];
  const norm = { raices: conReal([c.main, c.cambio]), casas: conReal([lados.main.casa, lados.cambio.casa]), heads: c.heads, ramas: ['compare-main', c.rama] };
  const a = { exit: lados.main.exit, salida: normalizar(lados.main.salida, norm) };
  const b = { exit: lados.cambio.exit, salida: normalizar(lados.cambio.salida, norm) };
  const cmp = comparar(a, b);
  // con la salida cortada, «igual» no se sabe: la diferencia puede estar después del corte. «Distinto» sí vale
  if (cmp.igual && (lados.main.cortada || lados.cambio.cortada)) {
    return noComparado('salida de más de 1 MB: lo que pasa el tope no se compara', { main: resumen(lados.main), cambio: resumen(lados.cambio) });
  }
  return fin({ resultado: cmp.igual ? 'igual' : 'distinto', main: resumen(lados.main), cambio: resumen(lados.cambio), ...(cmp.igual ? {} : { diff: cmp.diff }) });
}

// ── Los candidatos (decisiones 1 y 11) ──────────────────────────────────────────────────────────────────────────────
const AVISOS = 'compare-avisos.md';
const esPrueba = (rel) => /(^|\/)tests\//.test(rel) || /\.test\.js$/.test(rel);
// un archivo que podría ser un comando, para decir «sin repo» de uno que no está en ningún repo de la corrida
const PARECE_GUION = /\.(c|m)?js$|\.sh$|\.py$/;
const ES_JS = /\.(c|m)?js$/;

/**
 * Las rutas de `files_to_modify` de la historia, sin comentarios, comillas ni el prefijo de repo o de tanda que escriben
 * algunas historias («(agent-skills) …», «(tanda <letra>) …»). Pueden ser relativas a la raíz de un repo, absolutas o con `~/`.
 */
function rutasAModificar(storyText) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(storyText || ''));
  if (!fm) return [];
  const out = [];
  let enLista = false;
  for (const l of fm[1].split(/\r?\n/)) {
    const clave = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l);
    if (clave) {
      enLista = clave[1] === 'files_to_modify';
      const enLinea = enLista && /^\[(.*)\]/.exec(clave[2].trim());
      if (enLinea) out.push(...enLinea[1].split(','));
      continue;
    }
    const item = enLista && /^\s*-\s+(.*)$/.exec(l);
    if (item) out.push(item[1]);
  }
  return [...new Set(out.map((c) => {
    const s = c.trim().replace(/^\([^)]*\)\s*/, '');
    const q = /^(['"])(.*?)\1/.exec(s);
    return (q ? q[2] : s.replace(/\s+#.*$/, '')).trim().replace(/^\.\//, '');
  }).filter((r) => r && !r.endsWith('/')))];
}

/**
 * Dónde cae una ruta declarada entre los repos de la corrida: `[{ repo, rel }]`. Una relativa se prueba en cada repo; una
 * absoluta, una con `~/` o una que sube (`../`, desde la raíz del repo de la historia) cae en el repo que la contiene.
 */
function ubicar(ruta, raices, raizHistoria) {
  let abs = null;
  if (ruta.startsWith('~/')) abs = path.join(os.homedir(), ruta.slice(2));
  else if (path.isAbsolute(ruta)) abs = ruta;
  else if (ruta.startsWith('../')) abs = raizHistoria ? path.resolve(raizHistoria, ruta) : null;
  else return raices.filter((repo) => dentroDe(repo, path.join(repo, ruta))).map((repo) => ({ repo, rel: ruta }));
  if (!abs) return [];
  const out = [];
  for (const repo of raices) {
    const dentro = [abs, real(abs)].find((x) => dentroDe(repo, x));
    if (dentro) out.push({ repo, rel: path.relative(repo, dentro).split(path.sep).join('/') });
  }
  return out;
}

/** La punta de `main` de un repo: `origin/main`, o `main` si no tiene remoto; null si ninguna. */
function puntaDeMain(repo) {
  for (const ref of ['origin/main', 'main']) {
    const r = git(['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (r.ok && r.out) return r.out;
  }
  return null;
}

// Un renglón sin su comentario: el de fin de renglón que no está entre comillas, o el renglón entero de un comentario
// de bloque. Las etiquetas y las funciones se buscan en lo que queda, no en lo que dice un comentario.
function sinComentario(l, sh) {
  const s = String(l || '');
  if (!sh && /^\s*(\*|\/\*)/.test(s)) return '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '\\') { i++; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (sh ? (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) : (ch === '/' && s[i + 1] === '/')) return s.slice(0, i);
  }
  return s.replace(/\/\*.*?\*\//g, '');
}
// Lo que se saca antes de contar llaves: los textos entre comillas.
const sinTextos = (l) => String(l).replace(/\\./g, '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""');
const ETIQUETAS_JS = /\bcase\s+(?:(['"`])([^'"`]+)\1|([\w$.]+))\s*:/g;
const ETIQUETA_SH = /^\s*\(?\s*((?:['"]?[\w.:*-]+['"]?\s*\|\s*)*['"]?[\w.:*-]+['"]?)\s*\)(?!\s*\{)/;
const FUNCIONES = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/,
  /^\s*(?:async\s+)?(?!(?:if|for|while|switch|catch|function|return|else)\b)([\w$]+)\s*\([^)]*\)\s*\{\s*$/,
];
const FUNCION_SH = /^\s*(?:function\s+)?([\w-]+)\s*\(\)\s*\{/;
// el que reparte con `if (cmd === 'x') {…}` (la forma de pipeline.js): la variable del subcomando y su valor
const VAR_DESPACHO = '(?:cmd|sub|subcmd|subcomando|command|comando|accion|action|modo|mode|op|[\\w$.]*argv\\[\\d+\\]|args\\[\\d+\\])';
const DESPACHO = new RegExp(`\\b${VAR_DESPACHO}\\s*===?\\s*(['"\`])([^'"\`]+)\\1|(['"\`])([^'"\`]+)\\3\\s*===?\\s*${VAR_DESPACHO}`, 'g');

const esDefault = (e) => e.includes('default') || e.includes('*');
/** Las etiquetas de un renglón ya sin comentario: los nombres de sus `case` (o de su brazo en shell), o null. */
function etiquetasDe(lc, sh) {
  if (sh) {
    if (/^\s*(if|then|else|elif|fi|do|done|esac|case|while|for|until|function|local|return)\b/.test(lc)) return null;
    const m = ETIQUETA_SH.exec(lc);
    return m ? m[1].split('|').map((x) => x.trim().replace(/^['"]|['"]$/g, '')) : null;
  }
  const nombres = [...String(lc).matchAll(ETIQUETAS_JS)].map((m) => (m[2] !== undefined ? m[2] : m[3]));
  if (nombres.length) return nombres;
  return /^\s*default\s*:/.test(lc) ? ['default'] : null;
}
function despachoDe(lc) {
  if (!/^\s*(\}\s*)?(else\s+)?if\b/.test(lc)) return null;
  const n = [...String(lc).matchAll(DESPACHO)].map((m) => (m[2] !== undefined ? m[2] : m[4]));
  return n.length ? n : null;
}
function funcionDe(lc, sh) {
  if (sh) { const m = FUNCION_SH.exec(lc); return m ? m[1] : null; }
  for (const re of FUNCIONES) { const m = re.exec(lc); if (m) return m[1]; }
  return null;
}
const soloEtiquetas = (l, sh) => {
  const lc = sinComentario(l, sh);
  return sh ? !!etiquetasDe(lc, sh) && !/\)\s*\S/.test(lc.replace(ETIQUETA_SH, ')')) : /^\s*(?:case\s+(?:(['"`])[^'"`]+\1|[\w$.]+)\s*:\s*)+$/.test(lc);
};
function conAlias(lineas, i, nombres, sh) {
  const out = [...nombres];
  for (let k = i - 1; k >= 0 && soloEtiquetas(lineas[k], sh); k--) out.unshift(...etiquetasDe(sinComentario(lineas[k], sh), sh));
  return out.filter((x) => x !== 'default' && x !== '*');
}

/**
 * La cadena de lo que encierra el renglón `n` (1 en adelante), de adentro hacia afuera: `{ tipo: 'case', nombres }`
 * (con sus alias apilados), `{ tipo: 'despacho', nombres }` (un `if (cmd === 'x') {`) y `{ tipo: 'funcion', nombre }`.
 * Sube contando llaves: un `case` cuenta en la misma profundidad, hasta el primero (los de arriba son hermanos); una
 * función o un despacho, cuando abren el bloque que encierra al renglón. En shell, lo que está después de un `esac` no
 * es de ningún brazo, y un `*)` no es un subcomando.
 */
function alcanceDe(lineas, n, sh) {
  const i0 = Math.min(Math.max(n - 1, 0), lineas.length - 1);
  const cadena = [];
  const propia = sinComentario(lineas[i0] || '', sh);
  const fPropia = funcionDe(propia, sh);
  let saltar = false;
  if (fPropia) cadena.push({ tipo: 'funcion', nombre: fPropia });
  else {
    const eP = etiquetasDe(propia, sh);
    if (eP) { saltar = true; if (!esDefault(eP)) cadena.push({ tipo: 'case', nombres: conAlias(lineas, i0, eP, sh) }); }
  }
  let bal = 0;
  let esacs = 0;
  for (let i = i0 - 1; i >= 0; i--) {
    const lc = sinComentario(lineas[i], sh);
    if (sh) {
      if (/(^|[;\s])esac\b/.test(lc)) { esacs++; continue; }
      if (/^\s*case\b.*\bin\s*$/.test(lc)) { if (esacs > 0) esacs--; else saltar = false; continue; }
      if (esacs > 0) continue;
    }
    const l = sinTextos(lc);
    let abre = false;
    for (let k = l.length - 1; k >= 0; k--) {
      if (l[k] === '}') bal++;
      else if (l[k] === '{') {
        bal--;
        if (bal < 0) {
          abre = true;
          const izq = l.slice(0, k);
          bal = Math.max(0, (izq.match(/\}/g) || []).length - (izq.match(/\{/g) || []).length);
          break;
        }
      }
    }
    if (abre) {
      const f = funcionDe(lc, sh);
      if (f) cadena.push({ tipo: 'funcion', nombre: f });
      else {
        const e = etiquetasDe(lc, sh);
        if (e && !esDefault(e) && !saltar) cadena.push({ tipo: 'case', nombres: conAlias(lineas, i, e, sh) });
        const d = sh ? null : despachoDe(lc);
        if (d) cadena.push({ tipo: 'despacho', nombres: d });
      }
      saltar = false;
      continue;
    }
    if (bal === 0 && !saltar) {
      const e = etiquetasDe(lc, sh);
      if (e) { saltar = true; if (!esDefault(e)) cadena.push({ tipo: 'case', nombres: conAlias(lineas, i, e, sh) }); }
    }
  }
  return cadena;
}

/**
 * Cómo se llega a lo que encierra un renglón, siguiendo las llamadas hacia arriba (hasta 6 niveles):
 * `{ labels: Set, comun }`. Un `case` o un despacho reparte subcomandos si las funciones que lo encierran se alcanzan
 * desde el código de arriba de todo (el `switch` interno de una función auxiliar no reparte subcomandos). Una función
 * suma lo que alcanza cada lugar que la llama; una que nadie llama no suma nada. `comun`: se llega desde el código de
 * arriba de todo, fuera de todo subcomando.
 */
function resolvedor(lineas, sh) {
  const memo = new Map();
  const llamadas = (nombre) => {
    const re = sh ? new RegExp(`(^|[\\s;|&(])${escaparRe(nombre)}(\\s|;|$)`) : new RegExp(`(^|[^\\w$.])${escaparRe(nombre)}\\s*\\(`);
    const out = [];
    lineas.forEach((l, i) => {
      const lc = sinTextos(sinComentario(l, sh));
      if (re.test(lc) && funcionDe(sinComentario(l, sh), sh) !== nombre) out.push(i + 1);
    });
    return out;
  };
  const deFuncion = (nombre, prof, enCurso) => {
    if (memo.has(nombre)) return memo.get(nombre);
    if (prof > 6 || enCurso.has(nombre)) return { labels: new Set(), comun: false };
    const siguiente = new Set([...enCurso, nombre]);
    const labels = new Set();
    let comun = false;
    for (const n of llamadas(nombre)) {
      const r = deCadena(alcanceDe(lineas, n, sh), prof + 1, siguiente);
      r.labels.forEach((x) => labels.add(x));
      comun = comun || r.comun;
    }
    const r = { labels, comun };
    if (prof === 0 || !enCurso.size) memo.set(nombre, r);
    return r;
  };
  const deCadena = (cadena, prof = 0, enCurso = new Set()) => {
    for (let k = 0; k < cadena.length; k++) {
      const s = cadena[k];
      if (s.tipo === 'funcion') return deFuncion(s.nombre, prof, enCurso);
      const afuera = cadena.slice(k + 1).find((x) => x.tipo === 'funcion');
      if (!afuera || deFuncion(afuera.nombre, prof, enCurso).comun) return { labels: new Set(s.nombres), comun: false };
    }
    return { labels: new Set(), comun: true };
  };
  return deCadena;
}

/**
 * Lo que tocan los renglones cambiados: `{ subcomandos, funciones, sinSubcomando }`. `funciones`, las que encierran el
 * cambio (para `--covers <archivo>:<función>`). Un renglón al que se llega desde el código de arriba de todo, o que
 * cae en algo que nadie llama, deja `sinSubcomando`: correr el archivo alcanza.
 */
function analizar(lineas, renglones, sh) {
  const subs = new Set();
  const funciones = new Set();
  let sinSubcomando = !lineas.length;
  const deCadena = resolvedor(lineas, sh);
  for (const n of renglones) {
    const cadena = lineas.length ? alcanceDe(lineas, n, sh) : [];
    for (const s of cadena) if (s.tipo === 'funcion') funciones.add(s.nombre);
    const r = deCadena(cadena);
    if (r.comun || !r.labels.size) sinSubcomando = true;
    r.labels.forEach((x) => subs.add(x));
  }
  return { subcomandos: sinSubcomando ? [] : [...subs], funciones: [...funciones], sinSubcomando, ...(sinSubcomando && subs.size ? { tocaTambien: [...subs] } : {}) };
}

/** Los renglones del archivo nuevo que el diff toca (los borrados, en el renglón que sigue). */
function renglonesTocados(repo, base, rel) {
  const d = git(['-C', repo, 'diff', '-U0', '--no-color', '--no-ext-diff', base, '--', rel]);
  if (!d.ok) return { error: unaLinea(d.err) };
  const out = [];
  for (const m of d.crudo.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const ini = Number(m[1]);
    const cant = m[2] === undefined ? 1 : Number(m[2]);
    if (cant === 0) out.push(ini + 1);
    for (let k = 0; k < cant; k++) out.push(ini + k);
  }
  return { renglones: out };
}

/**
 * Los candidatos de la historia (AC 10, 22): los archivos de `files_to_modify` que son un comando (cabecera `#!`, o un
 * JavaScript con `require.main === module`, en su versión de `main`), existen en `main` y la historia cambió, sin las
 * pruebas. El repo de cada uno sale de `repos` (los de la corrida); uno que podría ser un guion y no está en ninguno va a
 * `sinRepo`. Por candidato, `subcomandos` (los que el cambio toca), `funciones` (las que lo encierran) y `sinSubcomando`.
 * Uno que no se puede mirar (su versión de main, su diff o el archivo de ahora no se leen) va a `noMedidos` con su
 * motivo. `{ candidatos, sinRepo, noMedidos, avisos }`.
 */
function candidatos({ storyPath, storyText, repos = [] }) {
  const texto = storyText != null ? storyText : (() => { try { return fs.readFileSync(storyPath, 'utf8'); } catch (_) { return ''; } })();
  const avisos = [];
  const out = [];
  const sinRepo = [];
  const noMedidos = [];
  const raices = [...new Set(repos.filter(Boolean).map(real))];
  const raizHistoria = storyPath ? raizDe(storyPath) : null;
  const puntas = new Map(raices.map((r) => [r, puntaDeMain(r)]));
  for (const [r, p] of puntas) if (!p) avisos.push(`${path.basename(r)}: sin origin/main ni main, sus archivos no se miran`);
  for (const ruta of rutasAModificar(texto)) {
    if (esPrueba(ruta)) continue;
    let enAlguno = false;
    for (const { repo, rel } of ubicar(ruta, raices, raizHistoria)) {
      const punta = puntas.get(repo);
      const enArbol = fs.existsSync(path.join(repo, rel));
      const enMain = punta ? git(['-C', repo, 'cat-file', '-e', `${punta}:${rel}`]).ok : false;
      if (enArbol || enMain) enAlguno = true;
      if (!enMain || esPrueba(rel)) continue;
      // lo que no se puede mirar no es «no es candidato»: va a `noMedidos`, con su motivo
      const deMain = git(['-C', repo, 'show', `${punta}:${rel}`]);
      if (!deMain.ok) { noMedidos.push({ archivo: rel, repo, motivo: `no pude leer su versión de main (${unaLinea(deMain.err)})` }); continue; }
      const esComando = /^#!/.test(deMain.crudo) || (ES_JS.test(rel) && /require\.main\s*===\s*module/.test(deMain.crudo));
      if (!esComando) continue;
      const desde = git(['-C', repo, 'merge-base', 'HEAD', punta]);
      if (!desde.ok || !desde.out) avisos.push(`${rel}: no encontré el punto en común con main en ${path.basename(repo)}; comparo contra la punta de main`);
      const t = renglonesTocados(repo, desde.ok && desde.out ? desde.out : punta, rel);
      if (t.error) { noMedidos.push({ archivo: rel, repo, motivo: `no pude leer su diff (${t.error})` }); continue; }
      if (!t.renglones.length) continue;
      const sh = /\.sh$/.test(rel) || /^#!.*\b(ba|z)?sh\b/.test(deMain.crudo);
      let lineas;
      try { lineas = fs.readFileSync(path.join(repo, rel), 'utf8').split('\n'); } catch (e) {
        noMedidos.push({ archivo: rel, repo, motivo: `no pude leer el archivo de ahora (${e.code || e.message})` });
        continue;
      }
      out.push({ archivo: rel, repo, main: punta, ...analizar(lineas, t.renglones, sh) });
    }
    if (!enAlguno && PARECE_GUION.test(ruta)) sinRepo.push({ archivo: ruta });
  }
  return { candidatos: out, sinRepo, noMedidos, avisos };
}

// ── El juicio del freno (decisiones 2, 7, 8 y 11) ───────────────────────────────────────────────────────────────────
const CUMPLE = new Set(['igual', 'distinto']);
/** ¿El comando tapado nombra `palabra` entera? `get` no está dentro de `forget` ni de `--get`. */
const nombra = (cmd, palabra) => new RegExp(`(^|[^\\w:-])${escaparRe(palabra)}($|[^\\w:-])`).test(String(cmd));

/** Los renglones de la sección «Cambios de comportamiento» de la historia, también los que van bajo sus subtítulos. */
function cambiosDeclarados(storyText) {
  const out = [];
  let nivel = 0;
  for (const l of String(storyText || '').split('\n')) {
    const t = /^(#{1,6})\s+(.*)$/.exec(l);
    if (t) {
      if (nivel && t[1].length <= nivel) nivel = 0;
      if (!nivel && /^Cambios de comportamiento\b/i.test(t[2].trim())) nivel = t[1].length;
      continue;
    }
    if (nivel && l.trim()) out.push(l.replace(/^\s*[-*]\s+/, '').trim());
  }
  return out;
}
/** ¿Un renglón declara `cmd`? Su texto antes de un «:» es el comando, o un prefijo de él que termina en espacio. */
function declara(renglon, cmd) {
  for (let i = renglon.indexOf(':'); i >= 0; i = renglon.indexOf(':', i + 1)) {
    let d = renglon.slice(0, i);
    const enComillas = /^`([^`]*)`\s*$/.exec(d);
    if (enComillas) d = enComillas[1];
    if (d === cmd || (d.endsWith(' ') && d.trim() && cmd.startsWith(d))) return true;
  }
  return false;
}

/**
 * Una entrada por comando: la última que comparó («igual» o «distinto»), o la última si ninguna comparó. Un «no
 * comparado» posterior no borra un «distinto»: no prueba que la diferencia se fue.
 */
function ultimas(entradas) {
  const m = new Map();
  for (const e of entradas || []) {
    if (!e || !e.cmd) continue;
    const previa = m.get(e.cmd);
    if (!previa || CUMPLE.has(e.resultado) || !CUMPLE.has(previa.resultado)) m.set(e.cmd, e);
  }
  return [...m.values()];
}

/**
 * Lo que decide «Preparar el commit». `entradas`: las del informe verificadas y del código de ahora; `exenciones`: Map
 * archivo → constancia vigente. `{ faltan: [{ archivo, repo?, subcomandos, motivo }], noDeclaradas: [entrada],
 * cubiertos: [{ archivo, por, como, covers? }], avisos: [texto], notas: [texto] }`.
 */
function juicio({ candidatos: cands = [], sinRepo = [], entradas = [], exenciones = new Map(), storyText = '' }) {
  const humos = ultimas(entradas);
  const notas = [];
  const cubiertos = [];
  const faltan = [];
  const avisos = [];
  const delMismo = (a, b) => !!a && !!b && real(a) === real(b);
  const firmo = (x) => `${x.quien}${x.delegacion ? ` (por ${x.delegacion})` : ''}, ${x.via}`;
  for (const c of cands) {
    const exencion = exenciones.get(c.archivo);
    const funciones = c.funciones || [];
    let cubierto = null;
    const noComparados = [];
    for (const h of humos) {
      // por correrlo: el humo corre el archivo y nombra un subcomando que el cambio toca (o el cambio no cae en ninguno)
      if (h.archivo === c.archivo && delMismo(h.repo, c.repo)) {
        const sub = c.sinSubcomando ? null : c.subcomandos.find((s) => nombra(h.cmd, s));
        if (!c.sinSubcomando && !sub) { notas.push(`${h.cmd}: corre ${c.archivo} pero no nombra ningún subcomando que el cambio toca (${c.subcomandos.join(', ')})`); continue; }
        if (!CUMPLE.has(h.resultado)) { noComparados.push(h); continue; }
        cubierto = { archivo: c.archivo, por: h.cmd, como: sub ? `por el subcomando «${sub}»` : 'cubre el archivo, sin subcomando' };
        break;
      }
      // por declaración: `--covers <archivo>[:<subcomando o función>]` con `{raiz}` en el comando
      for (const dec of h.covers || []) {
        const [arch, sub] = String(dec).split(':');
        if (arch !== c.archivo) continue;
        if (!String(h.cmd).includes('{raiz}')) { notas.push(`${h.cmd}: declara --covers ${dec} pero su comando no usa {raiz}, así que no cubre`); continue; }
        if (h.repo && !delMismo(h.repo, c.repo)) { notas.push(`${h.cmd}: --covers ${dec} es de otro repo`); continue; }
        if (sub && !c.subcomandos.includes(sub) && !funciones.includes(sub)) { notas.push(`${h.cmd}: --covers ${dec}, pero el cambio no toca «${sub}» (toca ${c.sinSubcomando ? 'la parte común' : c.subcomandos.join(', ')})`); continue; }
        if (!sub && c.subcomandos.length) { notas.push(`${h.cmd}: --covers ${dec} sin subcomando, pero el cambio toca subcomandos (${c.subcomandos.join(', ')}): nombrá uno`); continue; }
        if (!CUMPLE.has(h.resultado)) { noComparados.push(h); continue; }
        cubierto = { archivo: c.archivo, por: h.cmd, como: 'cubierto por declaración', covers: dec };
        break;
      }
      if (cubierto) break;
    }
    if (cubierto) {
      cubiertos.push(cubierto);
      if (cubierto.covers) avisos.push(`cubierto por declaración: ${c.archivo} — humo «${cubierto.por}» con --covers ${cubierto.covers}. La cobertura queda declarada, no probada: miralo en el pedido.`);
      continue;
    }
    if (exencion) {
      avisos.push(`exención de la comparación: ${c.archivo} — motivo: ${exencion.reason} — firmó: ${firmo(exencion)}`);
      continue;
    }
    const motivo = noComparados.length
      ? `el humo dio «no comparado: ${noComparados.map((h) => String(h.motivo || '').replace(/^no comparado:\s*/, '')).join(' · ')}», que no cumple`
      : 'sin humo comparado que lo cubra';
    faltan.push({ archivo: c.archivo, repo: c.repo, subcomandos: c.subcomandos, sinSubcomando: c.sinSubcomando, motivo });
  }
  // las declaraciones de los humos que no nombran ningún candidato
  for (const h of humos) {
    for (const dec of h.covers || []) {
      const arch = String(dec).split(':')[0];
      if (!cands.some((c) => c.archivo === arch)) notas.push(`${h.cmd}: --covers ${dec} no es candidato de esta historia: no cubre nada`);
    }
    if ((h.covers || []).length && h.resultado === 'no-comparado' && /^raíz ambigua/.test(String(h.motivo || ''))) notas.push(`${h.cmd}: ${h.motivo}`);
  }
  for (const s of sinRepo) {
    const exencion = exenciones.get(s.archivo);
    if (exencion) { avisos.push(`exención de la comparación: ${s.archivo} — motivo: ${exencion.reason} — firmó: ${firmo(exencion)}`); continue; }
    faltan.push({ archivo: s.archivo, subcomandos: [], motivo: 'no comparado: sin repo — no está en ningún repo de la corrida' });
  }
  const declarados = cambiosDeclarados(storyText);
  const noDeclaradas = humos.filter((h) => h.resultado === 'distinto' && !declarados.some((r) => declara(r, h.cmd)));
  return { faltan, noDeclaradas, cubiertos, avisos, notas: [...new Set(notas)] };
}

/**
 * Las entradas que siguen valiendo para el código de ahora: las que comparan y cuyo sello es el del repo hoy, o difiere
 * sólo en papeleo (la historia de la corrida, la evidencia). `{ vigentes, viejas, sinComparar }`; una entrada que
 * compara y no trae sello es vieja. Si el repo no se puede sellar o comparar, la entrada va a `sinComparar` con su
 * motivo: tampoco cuenta, pero no es «otra versión».
 */
function delCodigoDeAhora(entradas, storyPath) {
  const ft = require('./frozen-tree.js');
  const sellos = new Map();
  const vigentes = [];
  const viejas = [];
  // las que no se pudieron comparar con el código de ahora: tampoco cuentan, pero el motivo es otro
  const sinComparar = [];
  for (const e of entradas) {
    if (!CUMPLE.has(e.resultado) || !e.repo) { vigentes.push(e); continue; }
    if (!e.sello) { viejas.push(e); continue; }
    const repo = real(e.repo);
    if (!sellos.has(repo)) { const s = ft.seal(repo); sellos.set(repo, s.error ? { error: s.error } : { tree: s.tree }); }
    const ahora = sellos.get(repo);
    if (ahora.error) { sinComparar.push({ entrada: e, motivo: unaLinea(ahora.error) }); continue; }
    if (ahora.tree === e.sello) { vigentes.push(e); continue; }
    const rel = storyPath && dentroDe(repo, real(storyPath)) ? path.relative(repo, real(storyPath)).split(path.sep).join('/') : undefined;
    const d = ft.changed(repo, e.sello, ahora.tree, { storyRel: rel });
    if (d.error) { sinComparar.push({ entrada: e, motivo: `no pude comparar ${path.basename(repo)} con el sello del humo (${unaLinea(d.error)})` }); continue; }
    (d.files.length === 0 ? vigentes : viejas).push(e);
  }
  return { vigentes, viejas, sinComparar };
}

/**
 * El freno de «Preparar el commit» (AC 11-14, 20-22): calcula los candidatos y juzga el informe y las exenciones.
 * `{ medido, candidatos, bloquea, lineas, avisos, juicio }`. Sin candidatos no hace nada (`candidatos: []`). Escribe los
 * avisos en `compare-avisos.md` de la corrida, para el texto del pedido.
 */
function freno({ storyPath, repos, runDir, stateDir, story }) {
  let storyText = '';
  try { storyText = fs.readFileSync(storyPath, 'utf8'); } catch (e) { return { medido: false, motivo: `no pude leer la historia (${e.code || e.message})`, candidatos: [] }; }
  const c = candidatos({ storyPath, storyText, repos });
  const noMedidos = (c.noMedidos || []).map((x) => `${x.archivo} (${path.basename(x.repo)}): ${x.motivo}`);
  if (!c.candidatos.length && !c.sinRepo.length) {
    if (noMedidos.length) return { medido: false, motivo: noMedidos.join(' · '), candidatos: [], avisos: c.avisos };
    return { medido: true, candidatos: [], bloquea: false, lineas: [], avisos: c.avisos };
  }
  const v = informeVerificado(runDir, stateDir);
  const { vigentes, viejas, sinComparar } = delCodigoDeAhora(v.entradas, storyPath);
  const exenciones = require('./compare-waiver.js').vigentes(runDir, { stateDir, story });
  const j = juicio({ ...c, entradas: vigentes, exenciones, storyText });
  const lineas = [];
  if (j.faltan.length) {
    lineas.push(`comparación con main: ${j.faltan.length} candidato(s) sin humo comparado que lo cubra ni exención firmada:`);
    for (const f of j.faltan) lineas.push(`   · ${f.archivo}${f.repo ? ` (${path.basename(f.repo)})` : ''}${f.subcomandos.length ? ` — subcomandos que el cambio toca: ${f.subcomandos.join(', ')}` : ''} — ${f.motivo}`);
    lineas.push('   Corré un humo comparado que lo cubra: bash smoke-run.sh <dir> <historia> --compare -- node {raiz}/<archivo> <subcomando> …');
    lineas.push(`   o pedí la exención, que firma una persona: node marker.js compare-waiver --story ${storyPath} --command <archivo> --reason "<por qué>"`);
    if (/^compare_exempt\s*:/m.test((/^---\r?\n([\s\S]*?)\r?\n---/.exec(storyText) || [])[1] || '')) {
      lineas.push('   La línea compare_exempt: del frontmatter no exime: la exención va por marker.js compare-waiver, con firma.');
    }
  }
  if (j.noDeclaradas.length) {
    lineas.push(`comparación con main: ${j.noDeclaradas.length} diferencia(s) que la historia no declara:`);
    for (const h of j.noDeclaradas) {
      lineas.push(`   · ${h.cmd}: main salió ${h.main ? h.main.exit : '?'}, el cambio salió ${h.cambio ? h.cambio.exit : '?'}`);
      for (const d of (h.diff || []).slice(0, MAX_LINEAS)) lineas.push(`       renglón ${d.linea}: main «${d.main == null ? '(nada)' : d.main}» · cambio «${d.cambio == null ? '(nada)' : d.cambio}»`);
    }
    lineas.push('   Declarala en la sección «## Cambios de comportamiento» de la historia («<comando>: qué cambia»; es papeleo y no');
    lineas.push('   dispara revisores), o arreglá el código (un arreglo después de «Hallazgos» sí vuelve a los revisores).');
  }
  for (const n of j.notas) lineas.push(`   nota: ${n}`);
  if (viejas.length) lineas.push(`   nota: ${viejas.length} humo(s) comparado(s) corrieron sobre otra versión del código: no cuentan, volvé a correrlos (${[...new Set(viejas.map((e) => e.cmd))].join(' · ')})`);
  for (const m of [...new Set(sinComparar.map((x) => x.motivo))]) {
    const cmds = [...new Set(sinComparar.filter((x) => x.motivo === m).map((x) => x.entrada.cmd))];
    lineas.push(`   nota: ${m}: ${cmds.length} humo(s) comparado(s) no se pudieron atar al código de ahora y no cuentan (${cmds.join(' · ')})`);
  }
  for (const n of noMedidos) lineas.push(`   nota: no medido: ${n}`);
  if (v.error) lineas.push(`   nota: ${v.error}: no pude leer los humos comparados de esta corrida`);
  if (v.registroIlegible) lineas.push(`   nota: ${v.registroIlegible}: ninguna entrada del informe se pudo verificar`);
  if (v.descartados) lineas.push(`   nota: ${v.descartados} renglón(es) del registro del arnés no se leen y no cuentan`);
  if (v.sinRegistro && !v.registroIlegible) lineas.push(`   nota: ${v.sinRegistro} entrada(s) del informe no tienen su renglón en el registro del arnés: no cuentan`);
  const avisos = [...c.avisos, ...j.avisos];
  if (runDir && j.avisos.length) {
    try {
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, AVISOS), ['## Comparación con main: exenciones y coberturas declaradas', '', ...j.avisos.map((a) => `- ${a}`), ''].join('\n'));
    } catch (e) { avisos.push(`no pude escribir ${AVISOS} (${e.message}): copiá estos avisos al pedido a mano`); }
  } else if (runDir) {
    try { fs.rmSync(path.join(runDir, AVISOS), { force: true }); } catch (_) { /* no estaba */ }
  }
  return { medido: true, candidatos: c.candidatos, sinRepo: c.sinRepo, bloquea: !!(j.faltan.length || j.noDeclaradas.length), lineas, avisos, juicio: j };
}

module.exports = { compararHumo, normalizar, comparar, tocaLoReal, encierro, barrer, limpiar, leerInforme, anotarEntrada, informeVerificado, raizDelHumo, reposDeLaSesion, archivoQueCorre, topes,
  candidatos, juicio, freno, rutasAModificar, alcanceDe, analizar, declara, cambiosDeclarados, ultimas, delCodigoDeAhora, leerInformeDetallado, seguro, INFORME, AVISOS };

// La línea de comando, para smoke-run.sh:
//   compare-previous.js humo --run-dir <d> --state-dir <e> --sid <s> [--covers a,b] [--cmd-json <texto tapado>] -- <comando…>
//   compare-previous.js raiz [--state-dir <e> --sid <s>] [--covers a,b] -- <comando…>   → la raíz de `{raiz}` (o vacío)
if (require.main === module) {
  const argv = process.argv.slice(2);
  const corte = argv.indexOf('--');
  const opts = corte >= 0 ? argv.slice(0, corte) : argv;
  const comando = corte >= 0 ? argv.slice(corte + 1) : [];
  const val = (k) => { const i = opts.indexOf(k); return i >= 0 ? opts[i + 1] : undefined; };
  const stateDir = val('--state-dir') || require('./state-dir.js').stateDir(os.homedir());
  const sid = val('--sid') || require('./session-id.js').sessionIdFileKey();
  const covers = String(val('--covers') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (opts[0] === 'raiz') {
    const r = raizDelHumo({ argv: comando, covers, cwd: process.cwd(), repos: reposDeLaSesion({ stateDir, sid, cwd: process.cwd() }) });
    process.stdout.write(r.raiz || '');
  } else if (opts[0] === 'humo') {
    let cmd = val('--cmd-json');
    try { cmd = cmd ? JSON.parse(cmd) : undefined; } catch (_) { /* el texto tal cual */ }
    // la carpeta de la corrida: la que se pasa, o la de la historia del marcador de la sesión (la misma que calcula el
    // freno de «Preparar el commit»); sin marcador, la de sus clones
    let runDir = val('--run-dir');
    if (!runDir) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(stateDir, 'active', `${seguro(sid)}.json`), 'utf8'));
        const repo = m.repoPath || process.cwd();
        const story = m.storyPath ? (path.isAbsolute(m.storyPath) ? m.storyPath : path.resolve(repo, m.storyPath)) : undefined;
        runDir = m.runDir || (m.storyId ? require('../pipeline.js').resolveRunDir(repo, String(m.storyId), true, story, { marker: m }) : null);
      } catch (_) { runDir = null; }
    }
    if (!runDir) {
      runDir = carpetaDeLaSesion(stateDir, sid);
      // el freno de «Preparar el commit» busca el informe en la carpeta de la corrida: acá no lo va a encontrar
      process.stderr.write(`[compare] ⚠️ no encontré la carpeta de la corrida de la sesión ${sid}: el informe queda en ${runDir} y el freno no lo va a ver. Pasá --run-dir.\n`);
    }
    compararHumo({ argv: comando, cmd, cwd: process.cwd(), runDir, sid, stateDir, covers })
      .then((e) => {
        process.stderr.write(`[compare] ${e.resultado}${e.motivo ? ` — ${e.motivo}` : ''}${e.main && e.cambio ? ` (main ${e.main.exit}, cambio ${e.cambio.exit})` : ''} · encierro: ${e.encierro.nombre}\n`);
      })
      .catch((err) => { process.stderr.write(`[compare] ⚠️ no se pudo comparar: ${err && err.message}\n`); process.exitCode = 1; });
  } else if (opts[0] === 'limpiar') {
    limpiar(stateDir, opts[1] || sid);
  } else {
    process.stderr.write('uso: compare-previous.js humo|raiz|limpiar …\n');
    process.exitCode = 2;
  }
}
