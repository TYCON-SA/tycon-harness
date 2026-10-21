'use strict';
// health.js — la comprobación de salud después de aplicar una versión del arnés.
//
// Qué mira, en este orden, y qué es falla:
//   1. La salida del aplicador: su suite rápida de cada arranque (`install-tycon-hooks.sh`, bloque «Suite de tests de la
//      capa determinista») imprime «FALLÓ» y el aplicador sale 0 igual. «FALLÓ» en `applierOut` = falla. (Que el
//      aplicador haya salido 0 lo decide quien lo corrió: `harness.js runApplier`.)
//   2. Cada hook del reporte del aplicador (`[{ kind: 'hook', id: '<EVENTO>:<ruta>' }]`): `node --check` de cada `.js`
//      (`.mjs`, `.cjs`) y `bash -n` de cada `.sh`, resueltos desde el id —`@tcg:x` → `<árbol>/scripts/hooks/x`; lo demás
//      → `<agent-skills>/skills/<ruta>`—. Un hook registrado sin su archivo, o que no compila, = falla.
//      En Windows un `.sh` se revisa con el bash de Git, nunca con `bash` a secas —el primero del
//      PATH puede ser el lanzador de WSL, que sale distinto de 0 con un guion sano—; sin el bash de Git es un aviso «sin
//      comprobar», no una falla. Y un `.sh` con finales `\r\n` en disco (`bash -n` lo da por bueno y no corre) = AVISO
//      con el guion y el remedio, nunca falla: está en el disco del clon, y volver atrás la versión no lo arregla. Uno
//      que no se pudo leer = aviso «sin comprobar».
//   3. Un hook por evento —el PRIMERO registrado de cada uno de SessionStart, UserPromptSubmit, PreToolUse, PostToolUse y
//      Stop—, con el `command` que tiene en settings.json, lanzado una vez con el payload mínimo de su evento por stdin
//      (`session_id: tycon-harness-health`, `cwd` un repo git vacío temporal que se borra al final). Sale 2 = falla: un
//      `PreToolUse` que deniega todo deja una máquina sin Bash. Tope de 20 s por hook: vencido = aviso, no falla (un
//      hook lento no rompe la máquina; uno que bloquea sí). En Windows un `.sh` se lanza con el bash de Git (`-c`), como
//      lo lanza Claude Code, no con cmd.exe; sin ese bash no se lanza y se avisa.
//   4. `node <harness.js del árbol nuevo> doctor --json` con el mismo ambiente: `fail` no vacío = falla con esos textos;
//      un `harness.js` que no arranca o no devuelve JSON = falla.
//
// Por qué existe: el aplicador sale 0 aunque el árbol nuevo traiga un hook que deniega todo, un hook con un error de
// sintaxis o un `harness.js` roto; dar la versión por buena por el código de salida dejaría la máquina sin trabajar hasta
// que alguien lo notara. Quien llama (`harness.js`, en `update`, `install` y `startup --force`) decide qué hacer con el
// resultado: restaurar por piezas, anotar `failed`, y refrescar la copia fija sólo en verde.
//
// Riesgo declarado (plan §6): los hooks corren de verdad en la máquina real; por eso el `session_id` propio y el repo
// vacío temporal como `cwd` y como `CLAUDE_PROJECT_DIR`. La línea de arranque (la copia fija) nunca se lanza: no es un hook
// del reporte, y si un `command` la nombra se saltea.
//
// Núcleo autónomo: corre desde la copia fija, así que sólo `require` dentro de `scripts/setup/harness/`. Nunca tira.
// La única carga de afuera es `scripts/lib/git-bash.js` del árbol que se comprueba (`findGitBash`): por ruta absoluta,
// sólo en Windows, y si no está es «no encontré el bash de Git» (aviso), nunca un error.
// Funciones puras respecto del HOME: reciben `home`/`env` en `ctx`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const M = require('./managed');

const HEALTH_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const HOOK_TIMEOUT_MS = 20 * 1000;
const CHECK_TIMEOUT_MS = 30 * 1000;
const DOCTOR_TIMEOUT_MS = 60 * 1000;
const SESSION_ID = 'tycon-harness-health';
const BOOTSTRAP_MARK = '.tycon-pipeline/harness/bootstrap.js';   // la línea de arranque: nunca se lanza desde acá

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const slash = (s) => String(s).replace(/\\/g, '/');
const firstLines = (s, n = 2) => String(s || '').trim().split('\n').filter(Boolean).slice(0, n).join(' | ').slice(0, 300);

/**
 * El error de lanzar un hook, o null si el hook CORRIÓ. Un hook que sale sin leer su payload (no lo necesita) cierra la
 * entrada antes de que spawnSync termine de escribirla: spawnSync trae EPIPE y, además, el código de salida del hook.
 * Eso no es «no pude lanzarlo»: el hook corrió y su código de salida vale. Pasa de a ratos con un hook de `exit 0`
 * («no pude lanzarlo (spawnSync … EPIPE)»).
 */
function launchError(r) {
  if (!r.error) return null;
  return r.error.code === 'EPIPE' && typeof r.status === 'number' ? null : r.error;
}

/** El archivo de un hook desde su id: `@tcg:x` vive en scripts/hooks/ del árbol; lo demás en agent-skills/skills. */
function hookFile(relpath, { tree, skillsDir }) {
  if (relpath.startsWith('@tcg:')) return path.join(tree, 'scripts', 'hooks', relpath.slice(5));
  return path.join(skillsDir, ...relpath.replace(/^\/+/, '').split('/'));
}

/**
 * ¿El archivo tiene finales `\r\n` en disco? TRES resultados: `{ crlf: true|false, reason: null }`, o `{ crlf: null,
 * reason }` si no se pudo leer. «No lo pude leer» no es «no los tiene» (primera vuelta de revisión de la W3a): quien
 * llama lo avisa como «sin comprobar».
 */
function hasCrlf(file) {
  try { return { crlf: fs.readFileSync(file).includes('\r\n'), reason: null }; } catch (e) { return { crlf: null, reason: (e && (e.code || e.message)) || String(e) }; }
}

/**
 * El bash de Git for Windows: `{ path, reason }` (`path` null si no está, con el motivo). Lo sabe buscar
 * `scripts/lib/git-bash.js`, y acá se carga el del ÁRBOL que se está comprobando, por su ruta absoluta: este archivo
 * corre también desde la copia fija, donde `../../lib` no existe. Un árbol que no lo trae = «no lo encontré». Nunca tira.
 */
function findGitBash({ tree, platform, env }) {
  try {
    const found = require(path.join(tree, 'scripts', 'lib', 'git-bash.js')).findGitBash({ platform, env });
    if (found && found.path) return { path: found.path, reason: null };
    return { path: null, reason: `no encontré el bash de Git for Windows: ${(found && found.reason) || 'sin motivo'}` };
  } catch (e) {
    return { path: null, reason: `no pude buscar el bash de Git for Windows: sin scripts/lib/git-bash.js en ${tree || 'el árbol'} (${(e && (e.code || e.message)) || e})` };
  }
}

/** El payload mínimo de cada evento (los campos comunes de Claude Code más los propios del evento). */
function payloadFor(event, cwd, transcript) {
  const base = { session_id: SESSION_ID, transcript_path: transcript, cwd, hook_event_name: event, permission_mode: 'default' };
  switch (event) {
    case 'SessionStart': return Object.assign(base, { source: 'startup' });
    case 'UserPromptSubmit': return Object.assign(base, { prompt: 'comprobación de salud del arnés' });
    // un Bash inofensivo: la pregunta es si el hook deja correr ALGO
    case 'PreToolUse': return Object.assign(base, { tool_name: 'Bash', tool_input: { command: 'true', description: 'comprobación de salud del arnés' } });
    case 'PostToolUse': return Object.assign(base, { tool_name: 'Bash', tool_input: { command: 'true' }, tool_response: { stdout: '', stderr: '', interrupted: false } });
    case 'Stop': return Object.assign(base, { stop_hook_active: false });
    default: return base;
  }
}

/** Los `command` de settings.json con su evento (barras normales), o `[]` si no se puede leer. */
function settingsCommands(home, env) {
  const file = env.TYCON_SETTINGS_PATH || path.join(home, '.claude', 'settings.json');
  let s = null;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return { file, list: null }; }
  const out = [];
  const hooks = isObject(s) && isObject(s.hooks) ? s.hooks : {};
  for (const [event, blocks] of Object.entries(hooks)) {
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) for (const h of (isObject(b) && Array.isArray(b.hooks) ? b.hooks : [])) {
      if (isObject(h) && typeof h.command === 'string') out.push({ event, command: h.command, norm: slash(h.command) });
    }
  }
  return { file, list: out };
}

// el hook de arranque de Codex: corre la copia fija, como la línea de arranque; nunca se lanza desde acá
const STARTUP_HOOK_MARK = 'scripts/hooks/harness-startup.js';
/** Los `command` del hooks.json de Codex con su evento (barras normales), o null si no se puede leer. */
function codexCommands(file) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; }
  const out = [];
  const hooks = isObject(s) && isObject(s.hooks) ? s.hooks : {};
  for (const [event, blocks] of Object.entries(hooks)) {
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) for (const h of (isObject(b) && Array.isArray(b.hooks) ? b.hooks : [])) {
      if (isObject(h) && typeof h.command === 'string') out.push({ event, command: h.command, norm: slash(h.command) });
    }
  }
  return out;
}

/** El repo git vacío desde el que se lanzan los hooks (y el transcript vacío, afuera del repo). `null` si no se pudo. */
function makeSandbox(env, { noGit = false } = {}) {
  let dir;
  // la ruta real (en Mac /var es un enlace a /private/var): el `cwd` del payload tiene que ser el que ve el hook
  try { dir = fs.realpathSync(fs.mkdtempSync(path.join(env.TMPDIR || os.tmpdir(), 'tycon-harness-health-'))); } catch (_) { return null; }
  const repo = path.join(dir, 'repo');
  const transcript = path.join(dir, 'transcript.jsonl');
  try {
    fs.mkdirSync(repo);
    fs.writeFileSync(transcript, '');
  } catch (_) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (__) { /* nada */ } return null; }
  // la versión bajada no invoca git nunca: la caja es una carpeta vacía y los hooks la ven como
  // «no es un repo», que es lo que tienen que tolerar
  if (noGit) return { dir, repo, transcript, git: null };
  const g = spawnSync('git', ['init', '-q', repo], { windowsHide: true, encoding: 'utf8', env, timeout: CHECK_TIMEOUT_MS });
  return { dir, repo, transcript, git: g.status === 0 };
}

/**
 * La comprobación entera. `ctx` = `{ home, env, platform, tree }`; `opts` = `{ tree, skillsDir, report, applierOut,
 * harnessJs, log, hookTimeoutMs }`. Devuelve `{ ok, failures: [], warnings: [] }`. Nunca tira.
 */
function check(ctx = {}, opts = {}) {
  const failures = [];
  const warnings = [];
  const home = ctx.home || os.homedir();
  const env = ctx.env || process.env;
  const platform = ctx.platform || process.platform;
  const tree = opts.tree || ctx.tree;
  const skillsDir = opts.skillsDir || path.join(home, '.claude', 'agent-skills', 'skills');
  const harnessJs = opts.harnessJs || (tree ? path.join(tree, 'scripts', 'setup', 'harness.js') : null);
  const hookTimeout = Number(opts.hookTimeoutMs) > 0 ? Number(opts.hookTimeoutMs) : HOOK_TIMEOUT_MS;
  const log = (l) => { try { if (typeof opts.log === 'function') opts.log(`salud: ${l}`); } catch (_) { /* el registro no frena la salud */ } };
  const fail = (t) => { failures.push(t); log(`FALLA ${t}`); };
  const warn = (t) => { warnings.push(t); log(`aviso ${t}`); };

  try {
    // 1. la suite rápida del aplicador
    const failedLines = String(opts.applierOut || '').split('\n').filter((l) => l.includes('FALLÓ'));
    if (failedLines.length) fail(`la suite rápida del aplicador imprimió «FALLÓ»: ${failedLines.slice(0, 3).map((l) => l.trim()).join(' | ').slice(0, 300)}`);

    // 2. cada hook del reporte compila
    const hooks = (Array.isArray(opts.report) ? opts.report : [])
      .filter((p) => isObject(p) && p.kind === 'hook' && typeof p.id === 'string')
      .map((p) => Object.assign({}, M.hookId(p.id), { id: p.id }));
    const checked = new Set();
    let foundBash = null;   // el bash de Git: sólo se busca en Windows, y una vez
    const gitBash = () => (foundBash = foundBash || findGitBash({ tree, platform, env }));
    for (const h of hooks) {
      const file = hookFile(h.relpath, { tree, skillsDir });
      if (checked.has(file)) continue;
      checked.add(file);
      if (!fs.existsSync(file)) { fail(`hook ${h.id}: registrado y su archivo no está (${file})`); continue; }
      const ext = path.extname(file).toLowerCase();
      let bin = null; let args = null;
      if (['.js', '.mjs', '.cjs'].includes(ext)) { bin = process.execPath; args = ['--check', file]; }
      else if (ext === '.sh') { bin = 'bash'; args = ['-n', file]; }
      if (!bin) continue;
      if (ext === '.sh' && platform === 'win32') {
        // Un `.sh` con \r\n en disco: `bash -n` lo da por bueno, pero al correr sale 255 — un freno así
        // no frena. Y `bash` a secas puede ser el lanzador de WSL (sale distinto de 0 con un guion sano, y eso haría
        // volver atrás una actualización sana): se revisa con el bash de Git o no se revisa.
        // El \r\n es un AVISO, nunca una falla: está en el disco del clon, no lo trajo la versión que se comprueba. Como
        // falla haría volver atrás la actualización, volver atrás no lo arregla, y se repetiría en cada `update`. Y un guion
        // que no se pudo leer (tomado por otro programa) es «sin comprobar»: ni un verde callado ni una falla — tampoco
        // se manda a `bash -n`, que fallaría por lo mismo y no por la versión.
        const eol = hasCrlf(file);
        if (eol.crlf === null) { warn(`hook ${h.id}: sin comprobar sus finales de línea ni su sintaxis (no pude leer ${file}: ${eol.reason}); ¿lo tiene abierto otro programa? Se vuelve a mirar en la próxima comprobación`); continue; }
        if (eol.crlf) { warn(`hook ${h.id}: su guion tiene finales \\r\\n en disco (${file}): no corre, y si es un freno no frena. No lo trajo esta versión (está en el disco del clon) y volver atrás no lo arregla. Remedio, con el árbol limpio: git rm --cached -r -q .  y después  git reset --hard -q (en el clon)`); continue; }
        if (!gitBash().path) { warn(`hook ${h.id}: sin comprobar su sintaxis (${gitBash().reason})`); continue; }
        bin = gitBash().path;
      }
      const r = spawnSync(bin, args, { windowsHide: true, encoding: 'utf8', env, timeout: CHECK_TIMEOUT_MS });
      if (r.error && r.error.code === 'ENOENT') { warn(`hook ${h.id}: no pude compilarlo (sin ${bin} en el PATH)`); continue; }
      if (r.status !== 0) fail(`hook ${h.id}: ${ext === '.sh' ? 'bash -n' : 'node --check'} falló: ${firstLines(r.stderr || r.stdout) || `rc ${r.status}`}`);
    }

    // 3. un hook por evento, con su payload mínimo, desde un repo vacío
    const cmds = settingsCommands(home, env);
    const firsts = HEALTH_EVENTS.map((ev) => hooks.find((h) => h.event === ev)).filter(Boolean);
    if (firsts.length) {
      if (!cmds.list) warn(`no pude leer ${cmds.file}: no lancé ningún hook`);
      const box = cmds.list ? makeSandbox(env, { noGit: Boolean(opts.noGit) }) : null;
      if (cmds.list && !box) warn('sin carpeta temporal para el repo vacío: no lancé ningún hook');
      if (box && box.git === false) warn(`git init falló en ${box.repo}: los hooks corren desde una carpeta vacía sin git`);
      try {
        for (const h of box ? firsts : []) {
          const needle = M.hookNeedle(h.relpath);
          const c = cmds.list.find((x) => x.event === h.event && x.norm.includes(needle));
          if (!c) { warn(`hook ${h.id}: no está su command en ${cmds.file}; no lo lancé`); continue; }
          if (c.norm.includes(BOOTSTRAP_MARK)) { log(`hook ${h.id}: es la línea de arranque, no se lanza`); continue; }
          const input = JSON.stringify(payloadFor(h.event, box.repo, box.transcript));
          // en Windows un hook `.sh` se lanza como lo lanza Claude Code —`"<bash de Git>" -c
          // "<command>"`—, no con cmd.exe, que resolvería `bash` por el PATH (puede ser el lanzador de WSL)
          const viaGitBash = platform === 'win32' && path.extname(h.relpath).toLowerCase() === '.sh';
          if (viaGitBash && !gitBash().path) { warn(`hook ${h.id}: sin comprobar, no lo lancé (${gitBash().reason})`); continue; }
          const r = spawnSync(c.command, { windowsHide: true,
            shell: platform === 'win32' ? (viaGitBash ? gitBash().path : true) : '/bin/sh',
            cwd: box.repo,
            input,
            encoding: 'utf8',
            // el reparador de la línea de arranque es un SessionStart que reescribe settings.json: en la salud se lanza
            // apagado (sale 0 sin tocar nada); el candado ya lo tiene harness.js, como con el aplicador
            env: Object.assign({}, env, { CLAUDE_PROJECT_DIR: box.repo, TYCON_NO_BOOTSTRAP_HEAL: '1', TYCON_HARNESS_LOCK_HELD: '1' }),
            timeout: hookTimeout,
            killSignal: 'SIGKILL',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          if (r.error && (r.error.code === 'ETIMEDOUT' || r.signal)) { warn(`hook ${h.id}: no terminó en ${Math.round(hookTimeout / 1000)} s (tope vencido; no cuenta como falla)`); continue; }
          if (launchError(r)) { warn(`hook ${h.id}: no pude lanzarlo (${r.error.message})`); continue; }
          if (r.status === 2) { fail(`hook ${h.id}: sale 2 con el payload mínimo de ${h.event} (bloquea): ${firstLines(r.stderr || r.stdout) || 'sin mensaje'}`); continue; }
          if (r.status !== 0) warn(`hook ${h.id}: salió ${r.status} con el payload mínimo de ${h.event} (no bloquea): ${firstLines(r.stderr || r.stdout)}`);
          else log(`hook ${h.id}: ${h.event} ok`);
        }
      } finally {
        if (box) { try { fs.rmSync(box.dir, { recursive: true, force: true }); } catch (_) { warn(`no pude borrar el repo temporal ${box.dir}`); } }
      }
    }

    // 3b. los hooks de Codex: con Codex enchufado, lo mismo sobre SU hooks.json —en una máquina
    // sin Claude Code son los únicos hooks que hay, y sin esto la salud sería «doctor no se queja»—. De cada `command` que
    // nombra un archivo del árbol: el archivo está y compila; y el primero de cada evento se lanza con su payload mínimo
    // (sale 2 = falla). El hook de arranque nunca se lanza: corre el programa que está corriendo esto.
    if (opts.codexHooks && tree) {
      const cc = codexCommands(opts.codexHooks);
      if (!cc) warn(`no pude leer ${opts.codexHooks}: no comprobé los hooks de Codex`);
      else {
        // la ruta del árbol en sus dos formas —como la nombra el estado y resuelta—: el desplegador escribe en hooks.json
        // la resuelta, y con la HOME (o ~/.tycon) detrás de un enlace no coincidirían y la comprobación se saltearía ENTERA y
        // en silencio. Y los comandos con comillas (una ruta con espacio,
        // «Nombre Apellido» en Windows) se leen entre comillas, no partidos por el espacio
        const roots = [...new Set([slash(tree), slash((() => { try { return fs.realpathSync(tree); } catch (_) { return tree; } })())].map((r) => r.replace(/\/+$/, '')))];
        const root = roots[0];
        const tokensOf = (norm) => { const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m; while ((m = re.exec(norm))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]); return out; };
        const fileOf = (c) => {
          for (const t of tokensOf(c.norm)) { const r = roots.find((x) => t.startsWith(`${x}/`)); if (r) return r === root ? t : `${root}/${t.slice(r.length + 1)}`; }
          return null;
        };
        const mine = cc.map((c) => Object.assign({ file: fileOf(c) }, c)).filter((c) => c.file);
        // ningún comando del arnés reconocido con hooks que parecen suyos: se dice, nunca «todo bien» por no haber mirado
        if (!mine.length && cc.some((c) => /scripts\/hooks\/|skills\/tycon-pipeline\//.test(c.norm))) warn(`hooks de Codex: ${opts.codexHooks} registra comandos del arnés que no reconocí como del árbol ${tree} (¿otra ruta?): no los comprobé`);
        const seen = new Set();
        for (const c of mine) {
          if (seen.has(c.file)) continue;
          seen.add(c.file);
          const id = `de Codex ${c.event}:${c.file.slice(root.length + 1)}`;
          if (!fs.existsSync(c.file)) { fail(`hook ${id}: registrado y su archivo no está (${c.file})`); continue; }
          const ext = path.extname(c.file).toLowerCase();
          let bin = null; let args = null;
          if (['.js', '.mjs', '.cjs'].includes(ext)) { bin = process.execPath; args = ['--check', c.file]; }
          else if (ext === '.sh') {
            if (platform === 'win32') { if (!gitBash().path) { warn(`hook ${id}: sin comprobar su sintaxis (${gitBash().reason})`); continue; } bin = gitBash().path; } else bin = 'bash';
            args = ['-n', c.file];
          }
          if (!bin) continue;
          const r = spawnSync(bin, args, { windowsHide: true, encoding: 'utf8', env, timeout: CHECK_TIMEOUT_MS });
          if (r.error && r.error.code === 'ENOENT') { warn(`hook ${id}: no pude compilarlo (sin ${bin} en el PATH)`); continue; }
          if (r.status !== 0) fail(`hook ${id}: ${ext === '.sh' ? 'bash -n' : 'node --check'} falló: ${firstLines(r.stderr || r.stdout) || `rc ${r.status}`}`);
        }
        const firstsCodex = HEALTH_EVENTS.map((ev) => mine.find((c) => c.event === ev && !c.norm.includes(STARTUP_HOOK_MARK))).filter(Boolean);
        const box = firstsCodex.length ? makeSandbox(env, { noGit: Boolean(opts.noGit) }) : null;
        if (firstsCodex.length && !box) warn('sin carpeta temporal para el repo vacío: no lancé ningún hook de Codex');
        // Los hooks corren DE VERDAD, y varios guardan lo suyo bajo la carpeta de Claude Code (el reloj, los medidores, el
        // registro del freno). En una máquina que no enchufa a Claude Code (`isolateHome`) eso crearía esa carpeta durante
        // la instalación (medido con el árbol real en el ensayo `codex-only`: apareció el latido del reloj). Ahí se lanzan
        // con una carpeta de usuario TEMPORAL, que se borra con la caja; la casa del arnés y la de Codex van por su
        // variable, con su ruta de verdad, así el hook lee la configuración y el estado de la máquina.
        const hookEnv = Object.assign({}, env, { TYCON_NO_BOOTSTRAP_HEAL: '1', TYCON_HARNESS_LOCK_HELD: '1' });
        if (box && opts.isolateHome) {
          const fakeHome = path.join(box.dir, 'home');
          try {
            fs.mkdirSync(fakeHome, { recursive: true });
            let ownRoot = null;
            try { ownRoot = require('./tycon-home.js').ownPaths({ env }).root; } catch (_) { ownRoot = null; }
            Object.assign(hookEnv, { HOME: fakeHome, USERPROFILE: fakeHome, CODEX_HOME: path.dirname(opts.codexHooks) });
            if (ownRoot) hookEnv.TYCON_HOME = ownRoot;
          } catch (e) { warn(`no pude armar la carpeta de usuario temporal para lanzar los hooks de Codex (${e.code || e.message}): los lanzo con la de verdad`); }
        }
        try {
          for (const c of box ? firstsCodex : []) {
            const id = `de Codex ${c.event}:${c.file.slice(root.length + 1)}`;
            const viaGitBash = platform === 'win32' && path.extname(c.file).toLowerCase() === '.sh';
            if (viaGitBash && !gitBash().path) { warn(`hook ${id}: sin comprobar, no lo lancé (${gitBash().reason})`); continue; }
            const r = spawnSync(c.command, { windowsHide: true,
              shell: platform === 'win32' ? (viaGitBash ? gitBash().path : true) : '/bin/sh',
              cwd: box.repo,
              input: JSON.stringify(payloadFor(c.event, box.repo, box.transcript)),
              encoding: 'utf8',
              env: hookEnv,
              timeout: hookTimeout,
              killSignal: 'SIGKILL',
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            if (r.error && (r.error.code === 'ETIMEDOUT' || r.signal)) { warn(`hook ${id}: no terminó en ${Math.round(hookTimeout / 1000)} s (tope vencido; no cuenta como falla)`); continue; }
            if (launchError(r)) { warn(`hook ${id}: no pude lanzarlo (${r.error.message})`); continue; }
            if (r.status === 2) { fail(`hook ${id}: sale 2 con el payload mínimo de ${c.event} (bloquea): ${firstLines(r.stderr || r.stdout) || 'sin mensaje'}`); continue; }
            if (r.status !== 0) warn(`hook ${id}: salió ${r.status} con el payload mínimo de ${c.event} (no bloquea): ${firstLines(r.stderr || r.stdout)}`);
            else log(`hook ${id}: ok`);
          }
        } finally {
          if (box) { try { fs.rmSync(box.dir, { recursive: true, force: true }); } catch (_) { warn(`no pude borrar el repo temporal ${box.dir}`); } }
        }
      }
    }

    // 4. doctor --json del árbol nuevo
    if (!harnessJs) warn('sin árbol: no corrí doctor');
    else {
      // TYCON_HARNESS_HEALTH=1: doctor juzga ESTE árbol; un intento fallido registrado de antes es historia, no salud
      // (sin esto, una reinstalación o un `startup --force` fallarían por su propia marca)
      const r = spawnSync(process.execPath, [harnessJs, 'doctor', '--json'], { windowsHide: true, encoding: 'utf8', env: Object.assign({}, env, { TYCON_HARNESS_HEALTH: '1' }), timeout: DOCTOR_TIMEOUT_MS, cwd: tree || undefined });
      let d = null;
      try { d = JSON.parse(String(r.stdout || '')); } catch (_) { d = null; }
      if (r.error && (r.error.code === 'ETIMEDOUT' || r.signal)) fail(`doctor --json de ${harnessJs} no terminó en ${DOCTOR_TIMEOUT_MS / 1000} s`);
      else if (!isObject(d) || !Array.isArray(d.fail)) fail(`doctor --json de ${harnessJs} no respondió (rc ${r.status}): ${firstLines(r.stderr || r.stdout) || 'sin salida'}`);
      else if (d.fail.length) for (const t of d.fail) fail(`doctor: ${t}`);
      else log('doctor --json sin fail');
    }
  } catch (e) {
    fail(`la comprobación de salud se cortó: ${e && e.message ? e.message : e}`);
  }
  return { ok: failures.length === 0, failures, warnings };
}

module.exports = { HEALTH_EVENTS, HOOK_TIMEOUT_MS, SESSION_ID, hookFile, payloadFor, launchError, check };
