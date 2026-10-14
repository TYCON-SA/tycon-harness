'use strict';
/**
 * lab.js — lo que comparten los guiones de medición de Windows (story 8.17, tanda W0).
 *
 * POR QUÉ EXISTE. W0 mide el arnés en un agente Windows y no arregla nada. Todos sus guiones necesitan las mismas
 * cuatro cosas, y cada una tiene una forma de mentir que acá se cierra una sola vez:
 *   · LA CARPETA DE USUARIO DE LABORATORIO. Ninguna medición corre contra la carpeta de usuario real: se fijan `HOME`,
 *     `USERPROFILE`, `HOMEDRIVE` y `HOMEPATH` a una carpeta del laboratorio, y quien mide se niega si `os.homedir()`
 *     devuelve otra. El laboratorio lleva una marca (`.tycon-windows-lab`): sin ella no es un laboratorio.
 *   · CORRER ALGO Y ANOTAR QUÉ PASÓ. El código de salida se mira antes que la salida; un programa que no arrancó, uno
 *     que se colgó y uno que salió distinto de 0 son tres cosas distintas, y las tres se anotan.
 *   · LO QUE NO PUEDE SALIR EN EL REPORTE. La dirección del repo público (vive en un solo archivo del repo interno, y
 *     la copia que se mide la trae en su portada) y cualquier credencial del ambiente se tapan antes de escribir.
 *   · EL RESULTADO DE CADA PASO. Un archivo por paso, con uno de tres estados: `measured` (con sus hallazgos),
 *     `not-measured` (con su motivo) o `error` («no pude medir: <motivo>»). Un paso cortado deja su parcial.
 *
 * Corre con Node 18 o más, sin dependencias, en Windows, Mac y Linux. Fuera de Windows es el «modo de laboratorio»:
 * mide lo mismo sobre lo que haya, para poder probar los guiones sin una máquina Windows.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCHEMA = 1;
const STATUS = Object.freeze({ measured: 'measured', notMeasured: 'not-measured', error: 'error' });
const LAB_MARK = '.tycon-windows-lab';
const OUTPUT_CAP = 4000;
const REDACTED_URL = '<public-repo-url>';
const REDACTED_SLUG = '<public-repo>';
const REDACTED_NAME = '<public-repo-name>';
const REDACTED_SECRET = '<secret>';
// Lo que acompaña a toda medición (AC 2): sin examen nocturno, sin entorno gráfico, git sin preguntas y PowerShell sin
// telemetría ni aviso de versión nueva (escribiría en la carpeta de usuario al arrancar).
const SAFE_ENV = Object.freeze({
  TYCON_NO_NIGHTLY_EXAM: '1',
  TYCON_NO_GUI_ENV: '1',
  GIT_TERMINAL_PROMPT: '0',
  POWERSHELL_TELEMETRY_OPTOUT: '1',
  POWERSHELL_UPDATECHECK: 'Off',
});
const GIT_OF_CALLER = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];
// El nombre de una variable que guarda una credencial: termina en TOKEN, SECRET, PASSWORD o CREDENTIAL, o trae PAT o
// una llave (API_KEY…) como palabra entera. `PATH` y `PWD` no entran: taparlas borraría rutas de todo el reporte.
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$|(^|_)(PAT|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)(_|$)/i;

const isWin = (platform = process.platform) => platform === 'win32';
const nowIso = () => new Date().toISOString();

// ── rutas ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Una ruta en forma comparable: barras normales, sin la del final, `/c/…` de Git Bash como `c:/…`, y en Windows sin caja. */
function comparable(p, platform = process.platform) {
  let s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (isWin(platform)) {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
    if (m) s = `${m[1]}:${m[2] || ''}`;
    s = s.toLowerCase();
  }
  return s;
}
function isInside(child, parent, platform = process.platform) {
  const c = comparable(child, platform);
  const p = comparable(parent, platform);
  return Boolean(p) && (c === p || c.startsWith(`${p}/`));
}
function samePath(a, b, platform = process.platform) { return comparable(a, platform) === comparable(b, platform); }
/** ¿Es una ruta absoluta para ESA plataforma? (las pruebas miran rutas de Windows desde Linux y Mac) */
function isAbsolute(p, platform = process.platform) { return (isWin(platform) ? path.win32 : path.posix).isAbsolute(String(p || '')); }
function realOrSelf(p) { try { return fs.realpathSync(p); } catch (_) { return p; } }

// ── el laboratorio ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ¿`home` sirve como carpeta de usuario de laboratorio? Devuelve `null` si sí, o el motivo por el que no.
 * En Windows además tiene que estar fuera de la carpeta temporal: `harness.js` rechaza un clon bajo `%TEMP%`
 * (`allowTemp` es sólo para las pruebas de estos guiones, que arman su laboratorio en la carpeta temporal).
 */
function labHomeProblem(home, { labRoot, realHome = os.homedir(), tmpdir = os.tmpdir(), platform = process.platform, allowTemp = false, exists = fs.existsSync } = {}) {
  if (!home || !isAbsolute(home, platform)) return 'la carpeta de usuario de laboratorio tiene que ser una ruta absoluta';
  if (!labRoot || !isAbsolute(labRoot, platform)) return 'falta la carpeta del laboratorio (--lab), como ruta absoluta';
  if (samePath(home, realHome, platform)) return `${home} es la carpeta de usuario real: acá no se mide`;
  if (isInside(realHome, labRoot, platform)) return `el laboratorio ${labRoot} contiene la carpeta de usuario real (${realHome})`;
  if (isInside(labRoot, path.join(realHome, '.claude'), platform)) return `el laboratorio ${labRoot} está dentro de la carpeta .claude real`;
  if (!isInside(home, labRoot, platform) || samePath(home, labRoot, platform)) return `${home} no está dentro del laboratorio ${labRoot}`;
  if (!exists(path.join(labRoot, LAB_MARK))) return `${labRoot} no tiene la marca del laboratorio (${LAB_MARK}): la deja «run.js init»`;
  if (isWin(platform) && !allowTemp && isInside(home, tmpdir, platform)) return `${home} está bajo la carpeta temporal (${tmpdir}): el laboratorio va fuera de ella`;
  return null;
}

/** La clave real de PATH en un ambiente (en Windows puede ser `Path`). */
function pathKey(env) {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
}
function setEnv(env, name, value) {
  // en Windows los nombres no distinguen caja: se pisa la clave que ya esté, no se agrega una gemela
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase()) || name;
  if (value === undefined || value === null) delete env[key]; else env[key] = String(value);
}

/** El ambiente de una medición: el de quien lanza, con la carpeta de usuario de laboratorio y lo de SAFE_ENV. */
function labEnv(home, { base = process.env, extra = {}, platform = process.platform } = {}) {
  const env = Object.assign({}, base);
  for (const k of GIT_OF_CALLER) setEnv(env, k, null);
  setEnv(env, 'HOME', home);
  setEnv(env, 'USERPROFILE', home);
  if (isWin(platform)) {
    const drive = path.win32.parse(home).root.replace(/[\\/]+$/, '');
    setEnv(env, 'HOMEDRIVE', drive);
    setEnv(env, 'HOMEPATH', String(home).slice(drive.length) || '\\');
  }
  for (const [k, v] of Object.entries(SAFE_ENV)) setEnv(env, k, v);
  for (const [k, v] of Object.entries(extra || {})) setEnv(env, k, v);
  return env;
}

/** El desvío de git: `from` (la dirección del repo público, tal como la escribe la portada) se sirve desde `to`. */
function gitRedirectEnv(from, to, env = {}) {
  const n = Number(env.GIT_CONFIG_COUNT || 0) || 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `url.${String(to).replace(/\\/g, '/')}.insteadOf`,
    [`GIT_CONFIG_VALUE_${n}`]: from,
  };
}

// ── correr y anotar ──────────────────────────────────────────────────────────────────────────────────────────────

/** El final y el principio de una salida larga: el medio se dice cuánto era. */
function clip(text, cap = OUTPUT_CAP) {
  // sin los colores, y sin los ceros de una salida en UTF-16 (el lanzador de WSL de Windows escribe así)
  const s = String(text == null ? '' : text).replace(/\u0000/g, '').replace(/\r\n/g, '\n').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  if (s.length <= cap) return s;
  const head = Math.floor(cap * 0.35);
  const tail = cap - head;
  return `${s.slice(0, head)}\n…[${s.length - cap} caracteres recortados]…\n${s.slice(-tail)}`;
}

/**
 * Corre un programa sin shell y devuelve qué pasó: `{ exit, signal, error, timed_out, stdout, stderr, ms }`.
 * `error` es el código del sistema (`ENOENT` = no está; `EINVAL` = Node no lo puede lanzar sin shell, como un `.cmd`).
 */
function run(bin, args = [], { cwd, env, input, timeoutMs = 60000, shell = false, cap = OUTPUT_CAP, spawn = spawnSync } = {}) {
  const t0 = Date.now();
  let r;
  try {
    r = spawn(bin, args, { cwd, env, input, encoding: 'utf8', timeout: timeoutMs, shell, windowsHide: true, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL' });
  } catch (e) {
    r = { status: null, signal: null, error: e, stdout: '', stderr: '' };
  }
  const code = r.error ? (r.error.code || r.error.message || 'error') : null;
  // un programa que salió sin leer su entrada no es un error: corrió y terminó (el caso de los hooks «callados»)
  const error = code === 'EPIPE' && r.status !== null ? null : code;
  return {
    exit: r.status === undefined ? null : r.status,
    signal: r.signal || null,
    error,
    timed_out: code === 'ETIMEDOUT',
    stdout: clip(r.stdout, cap),
    stderr: clip(r.stderr, cap),
    ms: Date.now() - t0,
  };
}

/** Lo mismo para una herramienta por su ubicación: un `.cmd` o `.bat` de Windows sólo arranca por `cmd.exe`. */
function runTool(location, args = [], opts = {}) {
  if (isWin(opts.platform) && /\.(cmd|bat)$/i.test(String(location))) {
    const line = [`"${location}"`, ...args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a))].join(' ');
    return run(line, [], Object.assign({}, opts, { shell: true }));
  }
  return run(location, args, opts);
}

/** Para que PowerShell escriba en UTF-8 cuando su salida no es una consola (si no, una ruta con acento llega rota). */
const PWSH_UTF8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';

const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

// ── lo que no sale en el reporte ─────────────────────────────────────────────────────────────────────────────────

/** Los valores del ambiente que son credenciales (por el nombre de su variable) y los que se le pasen por nombre. */
function secretValues(env = process.env, names = []) {
  const out = new Set();
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || v.length < 8) continue;
    if (SECRET_NAME.test(k) || names.includes(k)) out.add(v);
  }
  return [...out];
}

/**
 * Arma la función que tapa, en cualquier valor (texto, lista u objeto), la dirección del repo público y las
 * credenciales. La dirección se tapa en sus formas: completa, con `.git`, sólo `organización/repo`, y el nombre solo.
 */
function redactor({ publicUrl = null, secrets = [] } = {}) {
  const pairs = [];
  for (const s of secrets) if (s) pairs.push([s, REDACTED_SECRET]);
  if (publicUrl) {
    const url = String(publicUrl).replace(/\.git$/, '').replace(/\/+$/, '');
    pairs.push([`${url}.git`, REDACTED_URL], [url, REDACTED_URL]);
    const slug = url.replace(/^[a-z]+:\/\/[^/]+\//i, '');
    if (slug && slug !== url && slug.includes('/')) pairs.push([slug, REDACTED_SLUG]);
    // el nombre solo también: el bloque de la portada clona en una carpeta que se llama igual, y aparece en cada ruta
    const name = slug.split('/').pop();
    if (name && name.length >= 6) pairs.push([name, REDACTED_NAME]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  const text = (s) => pairs.reduce((acc, [from, to]) => acc.split(from).join(to), s);
  const walk = (v) => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x)]));
    return v;
  };
  return walk;
}

// ── la portada de la copia ───────────────────────────────────────────────────────────────────────────────────────

/** El contenido del primer bloque ```<fence> entre `<!-- marker -->` y `<!-- /marker -->`, o `null`. Sin tocarle una letra. */
function coverBlock(text, marker, fence) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const open = lines.indexOf(`<!-- ${marker} -->`);
  const close = lines.indexOf(`<!-- /${marker} -->`);
  if (open < 0 || close < open) return null;
  const body = [];
  let inFence = false;
  for (const line of lines.slice(open + 1, close)) {
    if (!inFence) { if (line === `\`\`\`${fence}`) inFence = true; continue; }
    if (line === '```') return body.join('\n');
    body.push(line);
  }
  return null;
}
const CLONE_URL = /^git clone (https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?=\s|$)/m;
/** La dirección completa y resuelta del repo público, la que sigue a `git clone` en el bloque. `null` si no está. */
function coverUrl(block) {
  const m = CLONE_URL.exec(String(block || ''));
  return m ? m[1] : null;
}
/** Lee la portada de un clon: `{ file, block, url }` o `{ problem }`. Desde la story 8.23 (tanda E) `install:core` es la
 *  portada SIN git (baja la versión por la API); el bloque que clona —el modo desarrollador, lo que esta sonda ensaya
 *  en Windows— es `install:clone` (y `install:clone-unattended`). */
function readCover(clone, { fence, marker = 'install:clone' } = {}) {
  // los bloques de instalación viven en la referencia desde que la portada se achicó (2026-10-14); un clon que no la trae
  // (una versión anterior, o un clon de juguete de las pruebas) los tiene en la portada
  const ref = path.join(clone, 'getting-started', 'reference.md');
  const file = fs.existsSync(ref) ? ref : path.join(clone, '.github', 'README.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { problem: `no pude leer la portada del clon (${file}): ${e.code || e.message}` }; }
  const block = coverBlock(text, marker, fence);
  if (block === null || !block.trim()) return { problem: `la portada no trae el bloque <!-- ${marker} --> con su valla \`\`\`${fence} y su cierre` };
  const url = coverUrl(block);
  if (!url) return { problem: `el bloque ${marker} (${fence}) no trae, después de «git clone», la dirección completa y resuelta del repo público` };
  return { file, block, url };
}
/**
 * El bloque de la portada que corre una máquina SIN terminal: `install:unattended` si la portada lo trae (story 8.16,
 * tanda B: desde ahí `harness.js install` sin terminal y sin `--yes` muestra el plan y sale 2), y si no `install:core`.
 * Devuelve lo mismo que `readCover`, más `marker` (cuál leyó). El ensayo corre sin terminal: con el bloque de siempre
 * mediría un 2 que es de diseño, no un rojo.
 */
function readUnattendedCover(clone, { fence } = {}) {
  const u = readCover(clone, { fence, marker: 'install:clone-unattended' });
  if (!u.problem) return Object.assign({ marker: 'install:clone-unattended' }, u);
  const c = readCover(clone, { fence });
  return c.problem ? c : Object.assign({ marker: 'install:clone' }, c);
}

// ── el bash de Git ───────────────────────────────────────────────────────────────────────────────────────────────

/** ¿Esta ubicación de `bash` es el lanzador de WSL que trae Windows, y no un bash que pueda leer una ruta `C:/…`? */
function isWslLauncher(location) {
  return /[\\/](system32|sysnative|windowsapps)[\\/]bash(\.exe)?$/i.test(String(location || ''));
}
/**
 * El `bash.exe` de Git for Windows: el de la variable del asistente, o el que vive junto a cada `git` del PATH.
 * Fuera de Windows, el primer `bash`. Devuelve `{ path, from }` o `{ path: null, reason }`.
 * (W1 trae `scripts/lib/git-bash.js`, la función única; ésta es la mínima que la medición necesita antes.)
 */
function findGitBash({ platform = process.platform, env = process.env, gitLocations = [], bashLocations = [], exists = fs.existsSync } = {}) {
  if (!isWin(platform)) {
    const first = bashLocations[0];
    return first ? { path: first, from: 'path' } : { path: null, reason: 'no hay bash en el PATH' };
  }
  const forced = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (forced && exists(forced)) return { path: forced, from: 'CLAUDE_CODE_GIT_BASH_PATH' };
  for (const git of gitLocations) {
    const dir = path.win32.dirname(git);
    for (const rel of [['..', 'bin', 'bash.exe'], ['..', '..', 'bin', 'bash.exe'], ['..', 'usr', 'bin', 'bash.exe']]) {
      const candidate = path.win32.normalize(path.win32.join(dir, ...rel));
      if (exists(candidate)) return { path: candidate, from: `junto a ${git}` };
    }
  }
  const other = bashLocations.find((b) => !isWslLauncher(b));
  if (other) return { path: other, from: 'path' };
  if (bashLocations.length) return { path: null, reason: 'el único bash del PATH es el lanzador de WSL' };
  return { path: null, reason: gitLocations.length ? 'git está, pero no encontré su bash.exe' : 'no hay git ni bash en el PATH' };
}

/** Las ubicaciones de un programa, en el orden del PATH, mirando el disco (sin `where` ni `which`). */
function scanPath(name, { env = process.env, platform = process.platform } = {}) {
  const delimiter = isWin(platform) ? ';' : ':';
  const dirs = String(env[pathKey(env)] || '').split(delimiter).filter(Boolean);
  const exts = isWin(platform) ? ['', ...String(env.PATHEXT || env.Pathext || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const out = [];
  for (const d of dirs) for (const ext of exts) {
    const p = path.join(d, name + ext);
    try { if (fs.statSync(p).isFile() && !out.includes(p)) out.push(p); } catch (_) { /* siguiente */ }
  }
  return out;
}

// ── el resultado de un paso ──────────────────────────────────────────────────────────────────────────────────────

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
const stepFile = (outDir, name) => path.join(outDir, 'steps', `${name}.json`);
const partialFile = (outDir, name) => path.join(outDir, 'steps', `${name}.partial.json`);

/**
 * Lo que un paso va anotando. Cada hecho queda en el parcial apenas se anota: si el paso se corta por su tope, lo que
 * alcanzó a medir no se pierde. `finish` escribe el resultado y borra el parcial.
 */
function recorder(name, outDir, { redact = (v) => v } = {}) {
  const step = { schema: SCHEMA, name, status: STATUS.measured, reason: null, started: nowIso(), seconds: null, facts: {}, findings: [], notes: [] };
  const t0 = Date.now();
  let clean = redact;
  const save = (file) => writeJsonAtomic(file, clean(Object.assign({}, step, { seconds: Math.round((Date.now() - t0) / 100) / 10 })));
  const checkpoint = () => { try { save(partialFile(outDir, name)); } catch (_) { /* el parcial nunca frena la medición */ } };
  return {
    step,
    setRedactor(fn) { clean = fn; },
    fact(key, value) { step.facts[key] = value; checkpoint(); return value; },
    note(text) { step.notes.push(String(text)); checkpoint(); },
    /**
     * Un hallazgo: algo que hoy no anda como en Mac y Linux. `id` estable (sin números que cambien entre corridas).
     * `extra` suma campos propios del paso (los ensayos del equipo anotan la gravedad: `severity`).
     */
    finding(id, kind, detail, closes, extra) {
      if (!step.findings.some((f) => f.id === id)) step.findings.push(Object.assign({ id, kind, detail: String(detail || ''), closes_hint: closes || null }, extra || {}));
      checkpoint();
    },
    finish(status = STATUS.measured, reason = null) {
      step.status = status;
      step.reason = reason;
      save(stepFile(outDir, name));
      try { fs.rmSync(partialFile(outDir, name), { force: true }); } catch (_) { /* nada */ }
      return step;
    },
  };
}

/** Las opciones `--nombre valor` y `--nombre` de una línea de comandos. Una opción desconocida es un error de uso. */
function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const kind = spec[a];
    if (!kind) return { problem: `opción desconocida: ${a} (las que hay: ${Object.keys(spec).join(', ')})` };
    if (kind === 'flag') { out[a.slice(2)] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return { problem: `${a} necesita un valor` };
    out[a.slice(2)] = v; i++;
  }
  return out;
}

module.exports = {
  SCHEMA, STATUS, LAB_MARK, SAFE_ENV, OUTPUT_CAP, REDACTED_URL, REDACTED_SLUG, REDACTED_NAME, REDACTED_SECRET,
  isWin, nowIso, comparable, isInside, samePath, isAbsolute, realOrSelf,
  labHomeProblem, labEnv, pathKey, setEnv, gitRedirectEnv,
  clip, run, runTool, firstLine, PWSH_UTF8,
  secretValues, redactor,
  coverBlock, coverUrl, readCover, readUnattendedCover,
  isWslLauncher, findGitBash, scanPath,
  writeJsonAtomic, stepFile, partialFile, recorder, parseArgs,
};
