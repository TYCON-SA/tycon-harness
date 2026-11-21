'use strict';
// El laboratorio de la matriz de fallas de los frenos (historia 8.159): una casa y una carpeta de estado temporales, el
// freno corrido con su intérprete, una copia del freno sola (sin sus bibliotecas) y un PATH al que le faltan programas.
// Nada lee ni escribe la casa real: `env()` saca TYCON_HOME y apunta HOME y USERPROFILE a la casa temporal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const POLICY_PATH = path.join(ROOT, 'scripts', 'setup', 'hook-failure-policy.json');
const LIST_PATH = path.join(ROOT, 'scripts', 'setup', 'hooks-list.json');

/** La ruta en el repo del guion de un registro de hooks-list.json (`@tcg:x` o `tycon-pipeline/scripts/x`). */
function rutaDelSpec(spec) {
  if (spec.startsWith('@tcg:')) return path.join(ROOT, 'scripts', 'hooks', spec.slice(5));
  return path.join(ROOT, 'skills', spec);
}

/** Los programas que un PATH «sin X» conserva: lo que usan los frenos de shell y git, sin los que se sacan. */
const BASICOS = ['bash', 'sh', 'cat', 'grep', 'sed', 'awk', 'tr', 'head', 'tail', 'cut', 'date', 'dirname', 'basename', 'mkdir',
  'readlink', 'perl', 'printf', 'env', 'sleep', 'kill', 'rm', 'ls', 'stat', 'shasum', 'wc', 'sort', 'uniq', 'mktemp', 'touch',
  'git', 'node', 'jq', 'ps', 'pgrep', 'python3', 'id', 'uname', 'tee', 'xargs', 'find', 'cp', 'mv', 'ln', 'chmod'];

function lab(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'frenos-fallas-')));
  t.after(() => {
    // las carpetas sin permiso que arma un caso se vuelven a abrir para poder borrarlas
    spawnSync('chmod', ['-R', 'u+rwx', dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const casa = path.join(dir, 'casa');
  const estado = path.join(casa, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const env = (extra = {}) => {
    // la cuenta de cierres seguidos de los frenos del cierre (lib/stop-cap.js) también vive en el laboratorio
    const e = { ...process.env, HOME: casa, USERPROFILE: casa, TYCON_GUIDES_HEAL: '0', TYCON_STOP_CAP_DIR: path.join(dir, 'stop-cap'), ...extra };
    for (const k of ['TYCON_HOME', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID']) if (!(k in extra)) delete e[k];
    return e;
  };
  // un PATH con los básicos menos los que faltan: una carpeta de enlaces
  const pathSin = (faltan) => {
    const bin = path.join(dir, `bin-sin-${[].concat(faltan).join('-')}`);
    if (fs.existsSync(bin)) return bin;
    fs.mkdirSync(bin, { recursive: true });
    for (const p of BASICOS) {
      if ([].concat(faltan).includes(p)) continue;
      const w = spawnSync('/bin/sh', ['-c', `command -v ${p}`], { encoding: 'utf8' }).stdout.trim();
      if (w && w.startsWith('/') && !fs.existsSync(path.join(bin, p))) fs.symlinkSync(w, path.join(bin, p));
    }
    return bin;
  };
  // el guion copiado solo, en la misma posición relativa, sin sus vecinos
  const solo = (guion) => {
    const rel = path.relative(ROOT, guion);
    const f = path.join(dir, 'solo', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.copyFileSync(guion, f);
    return f;
  };
  // un repo de git vacío con un commit, para los frenos que lo miran
  const repo = (nombre = 'repo') => {
    const r = path.join(dir, nombre);
    fs.mkdirSync(r, { recursive: true });
    // la identidad de prueba, la fecha fija y sin el mantenimiento automático: cada corrida arma el mismo repo
    const g = (...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', r, ...a], { encoding: 'utf8',
      env: env({ GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.invalid', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.invalid',
        GIT_AUTHOR_DATE: '2026-11-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T12:00:00Z' }) });
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(r, 'README.md'), 'lab\n');
    g('add', '.');
    g('commit', '-q', '-m', 'inicio');
    return { dir: r, git: g };
  };
  /**
   * Corre el freno: `{ code, out, err, retiene }`. `retiene`: si devolvió `decision: block` (el cierre del turno).
   * `guion` reemplaza al del renglón (la copia sola); `argv` reemplaza el arranque entero; `path` fija el PATH.
   */
  const correr = (guionDelRenglon, input, { guion = guionDelRenglon, argv = null, extra = {}, cwd = dir, timeout = 60000, PATH = null } = {}) => {
    const e = env(extra);
    if (PATH) e.PATH = PATH;
    const arranque = argv || (guion.endsWith('.sh') ? ['/bin/bash', guion] : [process.execPath, guion]);
    const r = spawnSync(arranque[0], arranque.slice(1), { input, encoding: 'utf8', env: e, cwd, timeout });
    const out = r.stdout || '';
    let retiene = false;
    let niega = false;
    for (const l of out.split('\n')) {
      try {
        const j = JSON.parse(l);
        if (j && j.decision === 'block') retiene = true;
        if (j && j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision === 'deny') niega = true;
      } catch (_) { /* no es JSON */ }
    }
    return { code: r.status === null ? (r.signal ? `señal ${r.signal}` : null) : r.status, out, err: r.stderr || '', retiene, niega };
  };
  // una biblioteca que no carga: un módulo que se carga antes y hace fallar el `require` de las rutas que cuadran
  const sinModulo = (patron) => {
    const pre = path.join(dir, 'sin-modulo.js');
    if (!fs.existsSync(pre)) {
      fs.writeFileSync(pre, [
        "const Module = require('module'); const orig = Module._load; const re = new RegExp(process.env.HOOK_MATRIX_MISSING_MODULE);",
        'Module._load = function (req) {',
        "  if (re.test(String(req))) { const e = new Error(`Cannot find module '${req}' (la matriz de fallas lo saca)`); e.code = 'MODULE_NOT_FOUND'; throw e; }",
        '  return orig.apply(this, arguments);',
        '};',
      ].join('\n'));
    }
    return { NODE_OPTIONS: `--require ${pre}`, HOOK_MATRIX_MISSING_MODULE: patron };
  };
  return { dir, casa, estado, env, pathSin, solo, repo, correr, sinModulo };
}

/** Lo que hizo el freno, en una palabra: «frena» (2, deny o retiene), «pasa» (0) o el código. */
function resultado(r) {
  if (r.code === 2 || r.niega || r.retiene) return 'frena';
  if (r.code === 0) return 'pasa';
  return String(r.code);
}

const leerPolicy = () => JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
const leerLista = () => JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));

module.exports = { ROOT, POLICY_PATH, LIST_PATH, rutaDelSpec, lab, resultado, leerPolicy, leerLista };
