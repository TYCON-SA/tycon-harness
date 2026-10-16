#!/usr/bin/env node
'use strict';
/**
 * install-probe.js — instalar el arnés como lo haría alguien de afuera, y anotar cómo quedó (story 8.17, W0 · AC 6).
 *
 * POR QUÉ EXISTE. El instalador de Windows se escribió sin una máquina Windows y nunca corrió en una. Este paso lo
 * corre: toma el bloque `install:clone` de la PORTADA DEL CLON (el que clona: el modo desarrollador; hasta la tanda E de
 * la 8.23 era `install:core`, que ahora es la portada sin git) —la valla `powershell` en Windows—, sin cambiarle una
 * letra, y lo ejecuta en una carpeta de usuario de laboratorio. La dirección del repo público que el bloque nombra se
 * sirve desde el clon del bundle (un desvío de git por variables de ambiente: no se escribe ningún archivo de
 * configuración), así que el `git clone` del bloque es un clon de verdad y aplica la conversión de finales de línea.
 *
 * VARIANTES (cada una en su carpeta de usuario, todas dentro del laboratorio):
 *   plain            una carpeta de usuario común.
 *   accent           una carpeta de usuario con espacio y acento, con el clon adentro.
 *   plain-python3 y accent-python3
 *                    sólo si `plain` no instaló porque falta `python3` y la máquina es descartable: las dos de arriba
 *                    otra vez, con `python3` puesto al lado de `python` (después de medirlas tal como está la máquina).
 *                    No arregla nada del arnés: deja medir lo que viene después de ese requisito (el aplicador, los
 *                    hooks), que si no quedaría sin medir.
 *   applier-direct   sólo en Windows y sólo si ninguna de las anteriores dejó hooks: el aplicador (`.ps1`) corrido suelto.
 * De cada una: código de salida y salida del bloque, `harness.js version`, `harness.js doctor --json`, el estado, los
 * enlaces creados y de qué tipo, `settings.json`, cuántos `.sh` del clon llegaron con `\r`, y qué carpeta de usuario
 * vieron `os.homedir()`, PowerShell y el bash de Git. En la última que instaló y no se usa para contar hooks, además,
 * `harness.js uninstall --yes`.
 *
 * NUNCA LA CARPETA DE USUARIO REAL. Antes de correr el bloque, un `node` lanzado con el ambiente de la variante dice
 * qué devuelve `os.homedir()`: si no es la de laboratorio, la variante no corre. Si PowerShell ve otra carpeta, sólo
 * sigue en una máquina descartable (`--disposable`, el agente), y lo anota como hallazgo.
 *
 * CÓMO FALLA. Que la instalación salga mal es un HECHO del reporte. El paso sale «error» sólo si no pudo medir: la
 * portada no se pudo leer, el laboratorio no sirve, o el bloque no pudo ni arrancar.
 *
 * Uso: node scripts/tests/windows/install-probe.js --lab <laboratorio> --out <carpeta del reporte>
 *      [--fence powershell|bash] [--disposable] [--allow-temp]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const L = require('./lab.js');
const PLACE = require('../../setup/harness/place.js');

const NAME = 'install';
const BLOCK_TIMEOUT_MS = 20 * 60 * 1000;
// el lugar y el nombre viejo (story 8.19): se mira el que esté; falta el arnés sólo si no está ninguno (y se nombra el lugar)
const LINKS = [[PLACE.PLACE_NAME, ''], [PLACE.LEGACY_PLACE_NAME, ''], ['agent-skills', ''], ['agents', 'agents'], ['skills', 'skills']];
// la línea de import en cualquiera de sus formas (los dos nombres del lugar, story 8.19; README.md o INDEX.md): se cuentan
// todas, y tiene que haber una
const IMPORT_LINES = require('../../setup/harness/import-line.js').ALL_FORMS;
const VARIANTS = [
  { id: 'plain', home: ['users', 'lab-user'], work: ['work', 'plain'] },
  { id: 'accent', home: ['users', 'usuario de práctica'], workInHome: ['proyectos'] },
  // El equipo usa el perfil completo y la portada instala el mínimo (desde la 8.16 D): con el bloque de la portada tal
  // cual y después `harness.js install --profile full --yes`, como lo hace un dev. Es la que se cuenta y se dispara: sin
  // ella, 26 controles del equipo quedaban sin medir en Windows (corrida 12019).
  { id: 'team', home: ['users', 'lab-team'], work: ['work', 'team'], profile: 'full' },
];

const sha = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (_) { return null; } };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const lastLines = (s, n = 3) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');

/** La foto de la carpeta `.claude` REAL: sólo nombres y dos sumas, para saber si la medición escribió ahí. */
function realHomePhoto(realHome) {
  const dir = path.join(realHome, '.claude');
  let names = null;
  try { names = fs.readdirSync(dir).sort(); } catch (_) { names = null; }
  return { names, settings: sha(path.join(dir, 'settings.json')), claude_md: sha(path.join(dir, 'CLAUDE.md')) };
}
function photoDiff(before, after) {
  const out = [];
  if (JSON.stringify(before.names) !== JSON.stringify(after.names)) {
    const b = new Set(before.names || []);
    out.push(`entradas nuevas en la carpeta .claude real: ${(after.names || []).filter((n) => !b.has(n)).join(', ') || '(cambió la lista)'}`);
  }
  if (before.settings !== after.settings) out.push('cambió el settings.json real');
  if (before.claude_md !== after.claude_md) out.push('cambió el CLAUDE.md real');
  return out;
}

/** Qué carpeta de usuario ve cada intérprete con el ambiente de la variante. */
function seenHomes({ home, env, platform, gitBash, pwsh }) {
  const out = {};
  const n = L.run(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], { env, timeoutMs: 30000, cap: 600 });
  out.node = n.error || n.exit !== 0 ? null : n.stdout.trim();
  out.node_is_lab = Boolean(out.node) && L.samePath(L.realOrSelf(out.node), L.realOrSelf(home), platform);
  if (pwsh) {
    const p = L.run(pwsh, ['-NoProfile', '-NonInteractive', '-Command', `${L.PWSH_UTF8}"$HOME|$env:USERPROFILE"`], { env, timeoutMs: 60000, cap: 600 });
    if (p.error || p.exit !== 0) out.pwsh_problem = p.error || `salió ${p.exit}: ${L.firstLine(p.stderr)}`;
    else {
      const [h, u] = L.firstLine(p.stdout).split('|');
      out.pwsh_home = h || null; out.pwsh_userprofile = u || null;
      out.pwsh_is_lab = Boolean(h) && L.samePath(L.realOrSelf(h), L.realOrSelf(home), platform);
    }
  }
  if (gitBash) {
    const g = L.run(gitBash, ['-c', 'cygpath -w "$HOME" 2>/dev/null || printf "%s" "$HOME"'], { env, timeoutMs: 60000, cap: 600 });
    if (g.error || g.exit !== 0) out.git_bash_problem = g.error || `salió ${g.exit}: ${L.firstLine(g.stderr)}`;
    else { out.git_bash_home = L.firstLine(g.stdout) || null; out.git_bash_is_lab = Boolean(out.git_bash_home) && L.samePath(L.realOrSelf(out.git_bash_home), L.realOrSelf(home), platform); }
  }
  return out;
}

/**
 * Los `.sh` del clon que llegaron con `\r`: cuántos, y los primeros por nombre.
 * 🔴 Un nombre por línea, sin comillas. Hasta la corrida 11677 se pedían separados por ceros (`-z`), y `lab.run` borra
 * los ceros de toda salida: quedaba UN solo «archivo» —todos los nombres pegados—, que no existía y no se contaba. El
 * reporte dijo «0 de 1 .sh con \r» sobre una copia con decenas de `.sh`: no había medido nada.
 */
function shellFilesWithCr(clone, env) {
  const r = L.run('git', ['-c', 'core.quotePath=false', '-C', clone, 'ls-files', '--', '*.sh'], { env, timeoutMs: 60000, cap: 4 * 1024 * 1024 });
  if (r.error || r.exit !== 0) return { problem: `git ls-files ${r.error || `salió ${r.exit}`}: ${L.firstLine(r.stderr)}` };
  const files = r.stdout.split('\n').filter(Boolean);
  const withCr = [];
  for (const f of files) {
    try { if (fs.readFileSync(path.join(clone, f)).includes('\r\n')) withCr.push(f); } catch (_) { /* un archivo que no se pudo leer no cuenta */ }
  }
  const cfg = L.run('git', ['-C', clone, 'config', '--show-origin', '--get', 'core.autocrlf'], { env, timeoutMs: 30000, cap: 600 });
  return { total: files.length, with_cr: withCr.length, first: withCr.slice(0, 8), autocrlf_in_clone: cfg.exit === 0 ? L.firstLine(cfg.stdout) : (cfg.exit === 1 ? 'sin fijar' : `no pude leerlo (${cfg.error || cfg.exit})`) };
}

/** Los cuatro enlaces de `~/.claude`: si están, de qué tipo son y a dónde resuelven. */
function measureLinks({ home, clone, platform, pwsh, env }) {
  const dir = path.join(home, '.claude');
  const types = {};
  if (L.isWin(platform) && pwsh) {
    // PowerShell distingue un junction de un enlace simbólico; Node los ve iguales
    const script = `${L.PWSH_UTF8}Get-ChildItem -Force -LiteralPath '${dir.replace(/'/g, "''")}' | ForEach-Object { "$($_.Name)|$($_.LinkType)|$($_.Target)" }`;
    const r = L.run(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], { env, timeoutMs: 60000 });
    if (!r.error && r.exit === 0) for (const line of r.stdout.split('\n')) { const [n, t, target] = line.trim().split('|'); if (n) types[n] = { link_type: t || null, target: target || null }; }
  }
  const realClone = L.realOrSelf(clone);
  const has = (n) => { try { fs.lstatSync(path.join(dir, n)); return true; } catch (_) { return false; } };
  const OPTIONAL_LINKS = new Set([has(PLACE.LEGACY_PLACE_NAME) && !has(PLACE.PLACE_NAME) ? PLACE.PLACE_NAME : PLACE.LEGACY_PLACE_NAME]);
  return LINKS.map(([name, sub]) => {
    const p = path.join(dir, name);
    const want = sub ? path.join(realClone, sub) : realClone;
    let st;
    try { st = fs.lstatSync(p); } catch (_) { return OPTIONAL_LINKS.has(name) ? null : { name, present: false }; }
    const out = { name, present: true, kind: st.isSymbolicLink() ? 'link' : (st.isDirectory() ? 'folder' : 'file') };
    if (types[name]) Object.assign(out, types[name]);
    try { out.readlink = fs.readlinkSync(p); } catch (_) { /* no es un enlace */ }
    try { out.resolves_to = fs.realpathSync(p); out.to_clone = L.samePath(out.resolves_to, want, platform); } catch (e) { out.resolves_to = null; out.to_clone = false; out.problem = e.code || e.message; }
    // story 8.35: `skills` y `agents` son carpetas REALES del dev con un enlace por entrada del arnés, no un enlace a la
    // carpeta entera. Lo que se pide: carpeta real y al menos una entrada que resuelva adentro del clon.
    if (sub && out.kind === 'folder') {
      out.harness_entries = harnessEntries(p, want, platform);
      out.to_clone = out.harness_entries > 0;
      if (!out.to_clone) out.problem = 'carpeta real sin ninguna entrada que lleve al arnés';
    }
    return out;
  }).filter(Boolean);
}

/** Cuántas entradas de una carpeta real resuelven adentro de `want` (los enlaces por entrada de la story 8.35). */
function harnessEntries(dir, want, platform) {
  const base = L.comparable(want, platform);
  let n = 0;
  for (const e of (() => { try { return fs.readdirSync(dir); } catch (_) { return []; } })()) {
    try { const r = L.comparable(fs.realpathSync(path.join(dir, e)), platform); if (r === base || r.startsWith(`${base}/`)) n++; } catch (_) { /* colgado */ }
  }
  return n;
}

/** `harness.js doctor --json`: los `fail` y los `warn`, o por qué no se pudo leer. */
function measureDoctor(harness, env, cwd) {
  const r = L.run(process.execPath, [harness, 'doctor', '--json'], { env, cwd, timeoutMs: 120000, cap: 200000 });
  const out = { exit: r.exit, error: r.error };
  try {
    const d = JSON.parse(r.stdout);
    out.mode = d.mode || null;
    for (const level of ['fail', 'warn', 'ok']) out[level] = Array.isArray(d[level]) ? d[level].map((x) => L.clip(typeof x === 'string' ? x : JSON.stringify(x), 400)) : null;
    out.readable = Array.isArray(d.fail);
  } catch (e) {
    out.readable = false;
    out.problem = `no devolvió JSON: ${L.clip(r.stdout || r.stderr, 400)}`;
  }
  return out;
}

/** Deja `python3` al lado de `python` (enlace duro, o copia). Sólo en una máquina descartable. `{ dir }` o `{ problem }`. */
function providePython3({ env, platform }) {
  const found = L.scanPath('python', { env, platform });
  if (!found.length) return { problem: 'no hay python en el PATH del que partir' };
  const r = L.run(found[0], ['-c', 'import sys; print(sys.executable)'], { env, timeoutMs: 30000, cap: 600 });
  if (r.error || r.exit !== 0) return { problem: `python no dijo dónde está (${r.error || r.exit})` };
  const real = L.firstLine(r.stdout);
  const target = path.join(path.dirname(real), `python3${path.extname(real)}`);
  if (!fs.existsSync(target)) {
    try { fs.linkSync(real, target); } catch (_) {
      try { fs.copyFileSync(real, target); } catch (e) { return { problem: `no pude dejar ${target}: ${e.code || e.message}` }; }
    }
  }
  const v = L.run(target, ['--version'], { env, timeoutMs: 30000, cap: 600 });
  if (v.error || v.exit !== 0) return { problem: `${target} no responde a --version (${v.error || v.exit})` };
  return { dir: path.dirname(target), file: target, version: L.firstLine(v.stdout) || L.firstLine(v.stderr) };
}

/** Corre el bloque de la portada, tal cual, desde `work`. El texto va a un archivo: no pasa por otra capa de comillas. */
function runBlock({ block, fence, work, scratch, env, id, pwsh, bash }) {
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  if (fence === 'powershell') {
    const file = path.join(scratch, `install-${id}.ps1`);
    fs.writeFileSync(file, `${block}\n`);
    // el archivo lleva el bloque sin tocar; el envoltorio sólo pide la salida en UTF-8 y devuelve el código del último
    // programa que corrió (`pwsh -Command` a secas convierte cualquier código distinto de 0 en 1)
    return L.run(pwsh || 'pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${L.PWSH_UTF8}. '${file.replace(/'/g, "''")}'; exit $LASTEXITCODE`], { cwd: work, env, timeoutMs: BLOCK_TIMEOUT_MS });
  }
  const file = path.join(scratch, `install-${id}.sh`);
  fs.writeFileSync(file, `${block}\n`);
  return L.run(bash || 'bash', [file], { cwd: work, env, timeoutMs: BLOCK_TIMEOUT_MS });
}

/** La carpeta que el bloque clonó: la que nombra después de la dirección, o la única de `work` con el programa. */
function findClone(work, block) {
  const m = /^git clone \S+ ([^\s;&|]+)/m.exec(block);
  const named = m ? path.join(work, m[1]) : null;
  if (named && fs.existsSync(path.join(named, 'scripts', 'setup', 'harness.js'))) return named;
  try {
    for (const d of fs.readdirSync(work)) if (fs.existsSync(path.join(work, d, 'scripts', 'setup', 'harness.js'))) return path.join(work, d);
  } catch (_) { /* no hay carpeta de trabajo */ }
  return null;
}

/** Lo que dejó la instalación en la carpeta de usuario y en el clon. Devuelve hechos; los hallazgos van por `finding`. */
function measureResult({ v, home, clone, env, platform, pwsh, out, finding, redact }) {
  const facts = {};
  // el registro del mecanismo en la carpeta de usuario: cuando `install` no arma el plan, la salida ENTERA del aplicador
  // queda ahí (182 #12408: la instalación en una carpeta con acento sólo mostraba el tail; el motivo real quedaba tapado)
  try {
    const log = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'harness', 'startup.log'), 'utf8').trim().split('\n');
    facts.startup_log_tail = redact(log.slice(-60).join('\n')).slice(-6000);
  } catch (_) { facts.startup_log_tail = null; }
  // y si la instalación no quedó (sin estado), el paso del plan tal como lo lanza harness.js —el aplicador con -Check y
  // -PlanJson—, con su salida y su error POR SEPARADO: lo que el instalador dice al morir no viaja de otra forma
  try {
    if (!fs.existsSync(path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json'))) {
      const applier = path.join(clone, 'scripts', 'install-tycon-hooks.ps1');
      const planFile = path.join(os.tmpdir(), `tycon-probe-plan-${process.pid}.json`);
      const r = L.run(pwsh || 'pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', applier, '-Check', '-PlanJson', planFile], { env, timeoutMs: 300000, cap: 20000 });
      facts.plan_step_direct = { exit: r.exit, error: r.error, stdout: redact(r.stdout || ''), stderr: redact(r.stderr || ''), plan_written: fs.existsSync(planFile) };
      try { fs.rmSync(planFile, { force: true }); } catch (_) { /* nada */ }
    }
  } catch (e) { facts.plan_step_direct = { error: e.message }; }
  const harness = path.join(clone, 'scripts', 'setup', 'harness.js');
  const head = L.run('git', ['-C', clone, 'rev-parse', 'HEAD'], { env, timeoutMs: 30000, cap: 600 });
  facts.clone_commit = head.exit === 0 ? L.firstLine(head.stdout) : null;
  facts.eol = shellFilesWithCr(clone, env);
  if (facts.eol.with_cr > 0) finding('eol:sh-with-cr', 'line-endings', `${facts.eol.with_cr} de ${facts.eol.total} archivos .sh del clon llegaron con \\r (bash no los acepta); core.autocrlf en el clon: ${facts.eol.autocrlf_in_clone}`, 'W1');

  const ver = L.run(process.execPath, [harness, 'version'], { env, cwd: clone, timeoutMs: 60000, cap: 1200 });
  facts.version = { exit: ver.exit, error: ver.error, text: L.clip(ver.stdout || ver.stderr, 600) };
  if (ver.error || ver.exit !== 0) finding(`install:${v.id}:version-failed`, 'install', `harness.js version salió ${ver.error || ver.exit}: ${lastLines(ver.stderr || ver.stdout)}`, 'W4');
  facts.doctor = measureDoctor(harness, env, clone);
  if (!facts.doctor.readable) finding(`install:${v.id}:doctor-unreadable`, 'install', `harness.js doctor --json (salió ${facts.doctor.exit}) ${facts.doctor.problem || ''}`, 'W4');
  else if (facts.doctor.fail.length) finding(`install:${v.id}:doctor-fails`, 'install', `harness.js doctor --json trae ${facts.doctor.fail.length} falla(s): ${facts.doctor.fail.slice(0, 3).join(' · ')}`, 'W4');

  const settingsFile = path.join(home, '.claude', 'settings.json');
  facts.settings = { exists: fs.existsSync(settingsFile) };
  if (facts.settings.exists) {
    try {
      const s = readJson(settingsFile);
      const hooks = s && s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
      facts.settings.hooks_by_event = Object.fromEntries(Object.entries(hooks).map(([e, groups]) => [e, (Array.isArray(groups) ? groups : []).reduce((a, g) => a + ((g && g.hooks) || []).length, 0)]));
      facts.settings.hooks_total = Object.values(facts.settings.hooks_by_event).reduce((a, b) => a + b, 0);
      facts.settings.env_keys = s.env && typeof s.env === 'object' ? Object.keys(s.env) : [];
      facts.settings.copy = `settings-${v.id}.json`;
      L.writeJsonAtomic(path.join(out, facts.settings.copy), redact(s));
    } catch (e) {
      facts.settings.problem = e.message;
      finding(`install:${v.id}:settings-unreadable`, 'install', `settings.json quedó ilegible: ${e.message}`, 'W4');
    }
  } else finding(`install:${v.id}:no-settings`, 'install', 'la instalación no dejó settings.json en la carpeta de usuario', 'W4');

  const stateFile = path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json');
  try {
    const st = readJson(stateFile);
    facts.state = { mode: st.mode || null, channel: st.channel || null, sources: Array.isArray(st.sources) ? st.sources.length : null, version: st.version && st.version.number ? st.version.number : null, managed: Array.isArray(st.managed) ? st.managed.length : null };
  } catch (e) { facts.state = { problem: e.code || e.message }; }
  const fixed = path.join(home, '.claude', '.tycon-pipeline', 'harness');
  facts.fixed_copy = ['bootstrap.js', 'bootstrap-fallback.sh', 'bootstrap-fallback.ps1'].filter((f) => fs.existsSync(path.join(fixed, f)));
  try {
    const md = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
    facts.claude_md = { exists: true, import_lines: md.split(/\r?\n/).filter((l) => IMPORT_LINES.includes(l)).length, blocks: (md.match(/TYCON_BLOCK:[^\s]+ START/g) || []).length, has_cr: md.includes('\r\n') };
  } catch (_) { facts.claude_md = { exists: false }; }

  facts.links = measureLinks({ home, clone, platform, pwsh, env });
  for (const l of facts.links) {
    if (!l.present) finding(`links:${v.id}:${l.name}`, 'link', `no quedó ~/.claude/${l.name}`, 'W4');
    else if (!l.to_clone) finding(`links:${v.id}:${l.name}`, 'link', `~/.claude/${l.name} quedó como ${l.kind}${l.link_type ? ` (${l.link_type})` : ''} y no resuelve al clon: ${(l.kind === 'folder' && l.problem) || l.resolves_to || l.problem}`, 'W4');
  }
  const gh = L.run('git', ['config', '--global', '--get', 'core.hooksPath'], { env, timeoutMs: 30000, cap: 600 });
  facts.git_global_hooks_path = gh.exit === 0 ? L.firstLine(gh.stdout) : null;
  try { facts.home_entries = fs.readdirSync(home).sort(); facts.claude_entries = fs.readdirSync(path.join(home, '.claude')).sort(); } catch (_) { /* sin carpeta */ }
  return facts;
}

/**
 * Cuánto tarda el arranque en la variante que se cuenta (story 8.36, T9). Sólo hechos, sin hallazgos:
 *   · una corrida del aplicador como la lanza `harness.js` (`pwsh -File … --report-json`, el candado ya tomado) con cada
 *     Node anotado por `NODE_OPTIONS=--require <contador>` (sin intermediarios que cambien cómo se pasan los argumentos);
 *   · cinco corridas más igual, sin contador, y su mediana en segundos;
 *   · tres `harness.js startup` en el lugar y sin red (`TYCON_STARTUP_DETACH=0`, `TYCON_UPDATE=0`), y su mediana.
 * La primera corrida (la contada) hace además de calentamiento: las cinco miden el estado estable.
 */
const median = (xs) => { const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
function measureStartupTiming({ home, clone, env, pwsh, scratch, runs = 5, startups = 3 }) {
  const facts = { applier_runs_s: [], applier_median_s: null, node_processes: null, node_by_script: null, startup_runs_s: [], startup_median_s: null, problems: [] };
  const applier = path.join(clone, 'scripts', 'install-tycon-hooks.ps1');
  if (!pwsh || !fs.existsSync(applier)) { facts.problems.push(!pwsh ? 'sin pwsh en el PATH' : `sin ${applier}`); return facts; }
  fs.mkdirSync(scratch, { recursive: true });
  const report = path.join(scratch, 'timing-report.json');
  const applierEnv = Object.assign({}, env, { TYCON_HARNESS_LOCK_HELD: '1', TYCON_HARNESS_GIT_BASH_HEALTH: '1' });
  const runApplier = (extraEnv = {}) => L.run(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', applier, '--report-json', report], { cwd: home, env: Object.assign({}, applierEnv, extraEnv), timeoutMs: BLOCK_TIMEOUT_MS });
  // el contador: cada Node que arranca anota su guion (o `-e`) en una línea. Barras hacia adelante: NODE_OPTIONS lee la
  // barra invertida como escape dentro de las comillas.
  const counter = path.join(scratch, 'node-counter.js');
  const calls = path.join(scratch, 'node-calls.txt');
  try { fs.rmSync(calls, { force: true }); } catch (_) { /* nada */ }
  fs.writeFileSync(counter, `require('fs').appendFileSync(${JSON.stringify(calls)}, (process.argv[1] ? require('path').basename(process.argv[1]) : '-e') + '\\n');\n`);
  const counted = runApplier({ NODE_OPTIONS: `--require "${counter.replace(/\\/g, '/')}"` });
  if (counted.error || counted.exit !== 0) facts.problems.push(`la corrida contada salió ${counted.error || counted.exit}: ${lastLines(counted.stderr) || lastLines(counted.stdout)}`);
  try {
    const names = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean);
    facts.node_processes = names.length;
    facts.node_by_script = names.reduce((a, n) => Object.assign(a, { [n]: (a[n] || 0) + 1 }), {});
  } catch (e) { facts.problems.push(`no pude leer el conteo de procesos: ${e.code || e.message}`); }
  for (let i = 0; i < runs; i++) {
    const r = runApplier();
    if (r.error || r.exit !== 0) { facts.problems.push(`la corrida ${i + 1} del aplicador salió ${r.error || r.exit}`); continue; }
    facts.applier_runs_s.push(Math.round(r.ms / 10) / 100);
  }
  facts.applier_median_s = median(facts.applier_runs_s);
  const placed = path.join(home, '.claude', PLACE.PLACE_NAME, 'scripts', 'setup', 'harness.js');
  const harness = fs.existsSync(placed) ? placed : path.join(clone, 'scripts', 'setup', 'harness.js');
  const startupEnv = Object.assign({}, env, { TYCON_STARTUP_DETACH: '0', TYCON_UPDATE: '0' });
  for (let i = 0; i < startups; i++) {
    const r = L.run(process.execPath, [harness, 'startup'], { cwd: home, env: startupEnv, timeoutMs: BLOCK_TIMEOUT_MS });
    if (r.error || r.exit !== 0) { facts.problems.push(`el startup ${i + 1} salió ${r.error || r.exit}: ${lastLines(r.stderr) || lastLines(r.stdout)}`); continue; }
    facts.startup_runs_s.push(Math.round(r.ms / 10) / 100);
  }
  facts.startup_median_s = median(facts.startup_runs_s);
  return facts;
}

/**
 * La subida de corridas al buzón, como la lanza el arranque de Windows (2026-10-15: hasta ese día el aplicador no la
 * lanzaba, y las corridas de una máquina Windows nunca llegaban al buzón). El aplicador corre con el buzón prendido
 * contra un buzón de MENTIRA en esta máquina (un proceso aparte que contesta 201 y anota cada pedido), con una llave de
 * mentira y una corrida de muestra (un volcado y su hilo comprimido). Mide lo que en Windows nunca se había corrido: que
 * el arranque la lanza de fondo, las rutas de Windows, el comprimido y el HTTP. Nunca toca el buzón real.
 * Sin TF_BUILD a propósito: dentro de un agente de CI la subida no se lanza (story 2.12), y acá se mide una máquina.
 * stable-data: el reloj sólo mide la espera (cuánto tardó en llegar la subida, hasta un tope); ningún dato que se compara
 * sale de la hora, y los nombres de la corrida de muestra son fijos.
 */
function measureMailboxUpload({ home, clone, env, pwsh, scratch, waitMs = 90000 }) {
  const facts = { launched: false, arrived: false, log_lines: 0, puts: 0, blobs: [], gz_intact: null, waited_s: null, problems: [] };
  const applier = path.join(clone, 'scripts', 'install-tycon-hooks.ps1');
  if (!pwsh || !fs.existsSync(applier)) { facts.problems.push(!pwsh ? 'sin pwsh en el PATH' : `sin ${applier}`); return facts; }
  fs.mkdirSync(scratch, { recursive: true });
  const zlib = require('zlib');
  const cp = require('child_process');
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  // el buzón de mentira
  const server = path.join(scratch, 'buzon-de-mentira.js');
  const portFile = path.join(scratch, 'puerto.txt');
  const reqFile = path.join(scratch, 'pedidos.jsonl');
  const bodies = path.join(scratch, 'cuerpos');
  const log = path.join(home, '.claude', '.tycon-pipeline', 'upload-runs.log');
  // de cero: un registro, un puerto o pedidos de una medición anterior en la misma carpeta darían un verde sin medir
  for (const f of [portFile, reqFile, bodies, log]) fs.rmSync(f, { recursive: true, force: true });
  fs.mkdirSync(bodies, { recursive: true });
  fs.writeFileSync(server, [
    "const http = require('http'), fs = require('fs'), path = require('path');",
    'const [portFile, reqFile, bodies] = process.argv.slice(2); let n = 0;',
    "http.createServer((req, res) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => {",
    "  const body = Buffer.concat(parts); const file = path.join(bodies, String(++n)); fs.writeFileSync(file, body);",
    "  fs.appendFileSync(reqFile, JSON.stringify({ method: req.method, url: req.url.split('?')[0], bytes: body.length, file }) + '\\n');",
    "  res.writeHead(201); res.end(); }); }).listen(0, '127.0.0.1', function () { fs.writeFileSync(portFile, String(this.address().port)); });",
    'setTimeout(() => process.exit(0), 300000);',
  ].join('\n'));
  const srv = cp.spawn(process.execPath, [server, portFile, reqFile, bodies], { stdio: 'ignore', windowsHide: true });
  let spawnError = null;
  srv.on('error', (e) => { spawnError = e; });
  try {
    let port = null;
    for (let i = 0; i < 50 && !port; i++) { try { port = fs.readFileSync(portFile, 'utf8').trim() || null; } catch (_) { sleep(100); } }
    if (!port) { facts.problems.push(`el buzón de mentira no arrancó${spawnError ? `: ${spawnError.message}` : ''}`); return facts; }
    // la corrida de muestra y la llave de mentira (sólo crear, como la de verdad; la firma armada por partes)
    const hist = path.join(scratch, 'timing-history');
    fs.mkdirSync(hist, { recursive: true });
    const hilo = Buffer.from('{"tipo":"muestra","texto":"una corrida de ensayo con acentos: corrida, buzón"}\n');
    fs.writeFileSync(path.join(hist, '9.9-20261015T000000Z.json'), JSON.stringify({ story: '9.9', muestra: true }));
    fs.writeFileSync(path.join(hist, '9.9-20261015T000000Z.hilo.jsonl.gz'), zlib.gzipSync(hilo));
    const cfg = path.join(scratch, 'llave-de-mentira.json');
    const sig = ['FIRMA', '%2B', 'deprueba', '%3D'].join('');
    fs.writeFileSync(cfg, JSON.stringify({ cuenta: 'cuentadeprueba', contenedor: 'corridas', tenant: '00000000-0000-0000-0000-000000000000', politica: 'subida-prueba', vence: '2099-01-01', sas: `sv=2022-11-02&si=subida-prueba&sr=c&spr=https&sig=${sig}` }));
    const applierEnv = Object.assign({}, env, {
      TYCON_HARNESS_LOCK_HELD: '1', TYCON_HARNESS_GIT_BASH_HEALTH: '1', TYCON_MAILBOX: '1', TYCON_MAILBOX_JSON: cfg,
      TYCON_MAILBOX_URL_BASE: `http://127.0.0.1:${port}`, TYCON_TIMING_HISTORY: hist, TYCON_MACHINE: 'ensayo-windows',
      TYCON_UPLOADS_LOG: path.join(scratch, 'estado', 'mailbox-uploads.json'),
    });
    for (const k of Object.keys(applierEnv)) if (/^(TF_BUILD|TYCON_NO_UPLOAD_RUNS)$/i.test(k)) delete applierEnv[k];
    const r = L.run(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', applier], { cwd: home, env: applierEnv, timeoutMs: BLOCK_TIMEOUT_MS });
    if (r.error || r.exit !== 0) facts.problems.push(`el aplicador salió ${r.error || r.exit}: ${lastLines(r.stderr) || lastLines(r.stdout)}`);
    // la subida corre de fondo: se espera a que lleguen los dos archivos de la corrida, o al tope
    const t0 = Date.now();
    const pedidos = () => { try { return fs.readFileSync(reqFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
    const llegaron = (all) => ['.json', '.hilo.jsonl.gz'].every((ext) => all.some((p) => p.method === 'PUT' && p.url.endsWith(`9.9-20261015T000000Z${ext}`)));
    while (Date.now() - t0 < waitMs && !llegaron(pedidos())) sleep(500);
    facts.waited_s = Math.round((Date.now() - t0) / 100) / 10;
    let texto = '';
    try { texto = fs.readFileSync(log, 'utf8'); } catch (_) { /* sin registro */ }
    // la constancia que deja el .ps1 al lanzarla (el registro se borró antes de medir: es de esta corrida)
    facts.launched = /el arranque lanza la subida de corridas/.test(texto);
    facts.log_lines = texto.split('\n').filter(Boolean).length;
    const all = pedidos();
    facts.puts = all.filter((p) => p.method === 'PUT').length;
    facts.blobs = all.map((p) => `${p.method} ${p.url}`).slice(0, 20);
    facts.arrived = llegaron(all);
    const gz = all.find((p) => p.url.endsWith('9.9-20261015T000000Z.hilo.jsonl.gz'));
    if (gz) { try { facts.gz_intact = zlib.gunzipSync(fs.readFileSync(gz.file)).equals(hilo); } catch (e) { facts.gz_intact = false; facts.problems.push(`el hilo que llegó no se descomprime: ${e.message}`); } }
    if (!facts.launched) facts.problems.push(`el arranque no lanzó la subida: ${texto ? `el registro no trae la constancia (${lastLines(texto)})` : 'no quedó upload-runs.log'}`);
    else if (!facts.arrived) facts.problems.push(`la subida corrió pero no llegó la corrida de muestra entera (${facts.puts} PUT): ${lastLines(texto)}`);
    return facts;
  } finally {
    try { srv.kill(); } catch (_) { /* ya terminó */ }
  }
}

/** `harness.js uninstall --yes`, y qué quedó. */
function measureUninstall({ v, home, clone, env, finding }) {
  const harness = path.join(clone, 'scripts', 'setup', 'harness.js');
  const r = L.run(process.execPath, [harness, 'uninstall', '--yes'], { env, cwd: clone, timeoutMs: 300000 });
  // story 8.35: la carpeta real de `skills` o `agents` es del dev y se queda; lo que no puede quedar es un enlace al arnés
  // (la carpeta entera enlazada, o una entrada suya que todavía lleve al clon)
  const realClone = L.realOrSelf(clone);
  const left = LINKS.map(([n, sub]) => [n, sub]).filter(([n, sub]) => {
    const p = path.join(home, '.claude', n);
    let st; try { st = fs.lstatSync(p); } catch (_) { return false; }
    if (sub && st.isDirectory() && !st.isSymbolicLink()) return harnessEntries(p, path.join(realClone, sub)) > 0;
    return true;
  }).map(([n]) => n);
  const out = { exit: r.exit, error: r.error, output: L.clip(`${r.stdout}\n${r.stderr}`.trim(), 1500), links_left: left, state_left: fs.existsSync(path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json')), clone_still_there: fs.existsSync(path.join(clone, '.git')) };
  if (r.error || r.exit !== 0) finding(`uninstall:${v.id}:failed`, 'uninstall', `harness.js uninstall --yes salió ${r.error || r.exit}: ${lastLines(r.stderr || r.stdout)}`, 'W4');
  else if (left.length || out.state_left) finding(`uninstall:${v.id}:left-pieces`, 'uninstall', `tras uninstall quedan: ${[...left, out.state_left ? 'el estado' : ''].filter(Boolean).join(', ')}`, 'W4');
  return out;
}

function measure({ lab, out, fence, platform = process.platform, disposable = false, allowTemp = false, baseEnv = process.env, rec }) {
  const source = path.join(lab, 'source');
  const scratch = path.join(lab, 'scratch');
  const finding = (id, kind, detail, closes) => rec.finding(id, kind, detail, closes);
  const cover = L.readUnattendedCover(source, { fence });
  if (cover.problem) return { status: L.STATUS.error, reason: `no pude medir: ${cover.problem}` };
  const redact = L.redactor({ publicUrl: cover.url, secrets: L.secretValues(baseEnv) });
  rec.setRedactor(redact);
  rec.fact('cover', { file: path.relative(source, cover.file).split(path.sep).join('/'), marker: cover.marker, fence, block: cover.block });
  const redirect = L.gitRedirectEnv(cover.url, source, baseEnv);
  const pwsh = L.scanPath('pwsh', { env: baseEnv, platform })[0] || null;
  const gitBash = L.findGitBash({ platform, env: baseEnv, gitLocations: L.scanPath('git', { env: baseEnv, platform }), bashLocations: L.scanPath('bash', { env: baseEnv, platform }) }).path;
  if (fence === 'powershell' && !pwsh) return { status: L.STATUS.error, reason: 'no pude medir: no hay pwsh en el PATH para correr el bloque powershell de la portada' };
  const realHome = os.homedir();
  const variants = {};
  const usable = [];   // las que dejaron un settings.json con hooks: de ahí sale la que se cuenta y se dispara
  let ran = 0;

  // Una variante que se cae no se lleva a las otras: queda anotada, y el paso sale «error» diciendo cuál.
  const broke = [];
  const runVariant = (v, opts = {}) => {
    try { return runVariantUnsafe(v, opts); } catch (e) {
      broke.push(`la variante ${v.id} tiró: ${e.message}`);
      variants[v.id] = Object.assign(variants[v.id] || {}, { not_run: `la medición tiró: ${e.message}` });
      rec.fact('variants', variants);
      return variants[v.id];
    }
  };
  const runVariantUnsafe = (v, { extraEnv = {}, pathFirst = null, applier = false } = {}) => {
    const home = path.join(lab, ...v.home);
    const work = v.workInHome ? path.join(home, ...v.workInHome) : path.join(lab, ...v.work);
    const facts = { home, work };
    variants[v.id] = facts;
    const problem = (() => { try { fs.mkdirSync(home, { recursive: true }); } catch (e) { return `no pude crear ${home}: ${e.code || e.message}`; } return L.labHomeProblem(home, { labRoot: lab, platform, allowTemp }); })();
    if (problem) { facts.not_run = problem; rec.fact('variants', variants); return facts; }
    const extra = Object.assign({}, redirect, { TYCON_THIRD_PARTY_NETWORK_BUDGET_S: '120' }, extraEnv);
    const env = L.labEnv(home, { base: baseEnv, extra, platform });
    if (pathFirst) { const k = L.pathKey(env); env[k] = `${pathFirst}${path.delimiter}${env[k] || ''}`; }
    facts.seen_homes = seenHomes({ home, env, platform, gitBash, pwsh });
    if (!facts.seen_homes.node_is_lab) { facts.not_run = `os.homedir() devuelve «${facts.seen_homes.node}», no la carpeta de laboratorio: no corro el bloque`; rec.fact('variants', variants); return facts; }
    if (facts.seen_homes.pwsh_home && !facts.seen_homes.pwsh_is_lab) {
      finding('homes:pwsh-sees-other-home', 'homes', `con USERPROFILE y HOME en la carpeta de laboratorio, PowerShell ve $HOME = ${facts.seen_homes.pwsh_home}`, 'W4');
      if (fence === 'powershell' && !disposable) { facts.not_run = 'PowerShell ve otra carpeta de usuario que la de laboratorio y esta máquina no es descartable: no corro el bloque'; rec.fact('variants', variants); return facts; }
    }
    if (facts.seen_homes.git_bash_home && !facts.seen_homes.git_bash_is_lab) finding('homes:git-bash-sees-other-home', 'homes', `con HOME en la carpeta de laboratorio, el bash de Git ve HOME = ${facts.seen_homes.git_bash_home}`, 'W4');

    const before = realHomePhoto(realHome);
    process.stdout.write(`install: ${v.id} — corro ${applier ? 'el aplicador suelto' : `el bloque ${fence} de la portada`} en ${home}\n`);
    let clone;
    let r;
    if (applier) {
      clone = applier;
      r = L.run(pwsh, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(clone, 'scripts', 'install-tycon-hooks.ps1')], { cwd: home, env, timeoutMs: BLOCK_TIMEOUT_MS });
    } else {
      r = runBlock({ block: cover.block, fence, work, scratch, env, id: v.id, pwsh, bash: gitBash });
      clone = findClone(work, cover.block);
    }
    ran++;
    facts.run = { exit: r.exit, error: r.error, timed_out: r.timed_out, seconds: Math.round(r.ms / 100) / 10, stdout: r.stdout, stderr: r.stderr };
    facts.clone = clone;
    rec.fact('variants', variants);
    process.stdout.write(`install: ${v.id} — salió ${r.error || r.exit} en ${facts.run.seconds} s${clone ? '' : ' (sin clon)'}\n`);
    if (r.error || r.exit !== 0) finding(`install:${v.id}:failed`, 'install', `${applier ? 'el aplicador suelto' : 'el bloque de la portada'} salió ${r.error || r.exit}: ${lastLines(r.stderr) || lastLines(r.stdout)}`, 'W4');
    if (!clone) { finding(`install:${v.id}:no-clone`, 'install', 'el bloque no dejó un clon con scripts/setup/harness.js', 'W4'); return facts; }
    if (v.profile && !r.error && r.exit === 0) {
      // el paso que da un dev del equipo después de la portada: el perfil que usa el equipo, sin preguntas
      const s = L.run(process.execPath, [path.join(clone, 'scripts', 'setup', 'harness.js'), 'install', '--profile', v.profile, '--yes'], { cwd: clone, env, timeoutMs: BLOCK_TIMEOUT_MS });
      facts.profile_switch = { profile: v.profile, exit: s.exit, error: s.error, timed_out: s.timed_out, output: L.clip(`${s.stdout}\n${s.stderr}`.trim(), 1500) };
      // salir 0 no prueba que el perfil quedó: se relee del estado. Sin esto, un cambio que no se aplicó se mediría como
      // si fuera el perfil del equipo (revisión del hotfix, 2026-10-05)
      try {
        const st = readJson(path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json'));
        facts.profile_switch.installed = st.profile && typeof st.profile.value === 'string' ? st.profile.value : null;
      } catch (e) { facts.profile_switch.installed = null; facts.profile_switch.state_problem = e.code || e.message; }
      facts.profile_switch.applied = !s.error && s.exit === 0 && facts.profile_switch.installed === v.profile;
      rec.fact('variants', variants);
      process.stdout.write(`install: ${v.id} — perfil ${v.profile}: salió ${s.error || s.exit}, instalado ${facts.profile_switch.installed || 'sin constancia'}\n`);
      if (s.error || s.exit !== 0) finding(`install:${v.id}:profile-${v.profile}-failed`, 'install', `harness.js install --profile ${v.profile} --yes salió ${s.error || s.exit}: ${lastLines(s.stderr) || lastLines(s.stdout)}`, 'W4');
      else if (!facts.profile_switch.applied) finding(`install:${v.id}:profile-${v.profile}-not-applied`, 'install', `harness.js install --profile ${v.profile} --yes salió 0 pero el estado dice perfil ${facts.profile_switch.installed || `sin constancia (${facts.profile_switch.state_problem || 'no lo registra'})`}`, 'W4');
    }
    Object.assign(facts, measureResult({ v, home, clone, env, platform, pwsh, out, finding, redact }));
    const leaked = photoDiff(before, realHomePhoto(realHome));
    if (leaked.length) { facts.wrote_to_real_home = leaked; finding('homes:wrote-to-real-home', 'homes', `la instalación escribió en la carpeta de usuario real: ${leaked.join(' · ')}`, 'W4'); }
    if (facts.settings && facts.settings.hooks_total > 0) usable.push({ id: v.id, home, clone, settings: path.join(home, '.claude', 'settings.json'), env: extra, path_first: pathFirst });
    rec.fact('variants', variants);
    return facts;
  };

  // primero las dos, con la máquina como está
  const plain = runVariant(VARIANTS[0]);
  const accents = [runVariant(VARIANTS[1])];
  runVariant(VARIANTS[2]);
  // el requisito que falta se midió tal cual; en una máquina descartable se repiten las dos con el requisito puesto,
  // para medir lo que viene después (el aplicador, los hooks), que si no quedaría sin medir
  const said = plain.run ? `${plain.run.stdout}\n${plain.run.stderr}` : '';
  if (plain.run && plain.run.exit !== 0 && /falta python3 en el PATH/.test(said)) {
    if (!disposable) rec.note('plain no instaló porque falta python3; las variantes con python3 puesto sólo corren en una máquina descartable (--disposable)');
    else {
      const py = providePython3({ env: baseEnv, platform });
      rec.fact('python3_provided', py);
      if (py.problem) rec.note(`las variantes con python3 puesto no corrieron: ${py.problem}`);
      else {
        rec.note(`python3 puesto al lado de python (${py.file}) DESPUÉS de medir plain y accent tal como está la máquina: las variantes *-python3 miden lo que hay detrás de ese requisito`);
        runVariant({ id: 'plain-python3', home: ['users', 'lab-user-python3'], work: ['work', 'plain-python3'] }, { pathFirst: py.dir });
        accents.push(runVariant({ id: 'accent-python3', home: ['users', 'usuario de práctica python3'], workInHome: ['proyectos'] }, { pathFirst: py.dir }));
      }
    }
  }
  if (L.isWin(platform) && !usable.length) {
    const clone = Object.values(variants).map((x) => x.clone).find(Boolean);
    if (clone && fs.existsSync(path.join(clone, 'scripts', 'install-tycon-hooks.ps1'))) runVariant({ id: 'applier-direct', home: ['users', 'lab-user-applier'], work: ['work', 'applier-direct'] }, { applier: clone });
  }

  // la que se cuenta y se dispara: la primera que dejó hooks. La última de la carpeta con acento que instaló, si no es
  // ésa, se desinstala: así queda medido también `uninstall`.
  // la del equipo (perfil completo) si dejó hooks y pasó de perfil; si no, la primera que los dejó
  const teamOk = usable.find((u) => u.id === 'team' && variants.team && variants.team.profile_switch && variants.team.profile_switch.applied === true);
  const chosen = teamOk || usable[0] || null;
  const last = accents.filter((x) => x.clone && x.settings && x.settings.exists).pop();
  const lastId = last ? Object.keys(variants).find((k) => variants[k] === last) : null;
  if (last && (!chosen || chosen.id !== lastId)) {
    try {
      const env = L.labEnv(last.home, { base: baseEnv, extra: redirect, platform });
      last.uninstall = measureUninstall({ v: { id: lastId }, home: last.home, clone: last.clone, env, finding });
    } catch (e) { broke.push(`uninstall en ${lastId} tiró: ${e.message}`); }
    rec.fact('variants', variants);
  }
  rec.fact('measured_variant', chosen ? chosen.id : null);
  // cuánto tarda el arranque en la variante que se cuenta (story 8.36): sólo en Windows, que es lo que se mide
  if (chosen && L.isWin(platform)) {
    try {
      const env = L.labEnv(chosen.home, { base: baseEnv, extra: chosen.env, platform });
      if (chosen.path_first) { const k = L.pathKey(env); env[k] = `${chosen.path_first}${path.delimiter}${env[k] || ''}`; }
      process.stdout.write(`install: ${chosen.id} — mido el arranque (aplicador y startup)\n`);
      rec.fact('startup_timing', Object.assign({ variant: chosen.id }, measureStartupTiming({ home: chosen.home, clone: chosen.clone, env, pwsh, scratch: path.join(scratch, 'startup-timing') })));
    } catch (e) { rec.fact('startup_timing', { variant: chosen.id, problems: [`la medición tiró: ${e.message}`] }); }
    // la subida de corridas al buzón que lanza el arranque (2026-10-15), contra un buzón de mentira
    try {
      const env = L.labEnv(chosen.home, { base: baseEnv, extra: chosen.env, platform });
      if (chosen.path_first) { const k = L.pathKey(env); env[k] = `${chosen.path_first}${path.delimiter}${env[k] || ''}`; }
      process.stdout.write(`install: ${chosen.id} — mido la subida de corridas al buzón (contra un buzón de mentira)\n`);
      const up = rec.fact('mailbox_upload', Object.assign({ variant: chosen.id }, measureMailboxUpload({ home: chosen.home, clone: chosen.clone, env, pwsh, scratch: path.join(scratch, 'mailbox-upload') })));
      if (!up.launched || !up.arrived || up.gz_intact !== true) finding(`install:${chosen.id}:mailbox-upload`, 'install', up.problems.join(' · ') || 'la corrida de muestra no llegó entera al buzón de mentira', 'W4');
    } catch (e) { rec.fact('mailbox_upload', { variant: chosen.id, problems: [`la medición tiró: ${e.message}`] }); }
  }
  L.writeJsonAtomic(path.join(lab, 'lab-state.json'), { schema: L.SCHEMA, source, allow_temp: allowTemp, measured_variant: chosen });
  if (!ran) return { status: L.STATUS.error, reason: `no pude medir: ninguna variante pudo correr (${Object.entries(variants).map(([k, x]) => `${k}: ${x.not_run}`).join(' · ')})` };
  if (broke.length) return { status: L.STATUS.error, reason: `no pude medir: ${broke.join(' · ')}` };
  return { status: L.STATUS.measured, reason: null };
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--fence': 'value', '--disposable': 'flag', '--allow-temp': 'flag' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`install-probe.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const lab = path.resolve(args.lab);
  const out = path.resolve(args.out);
  const fence = args.fence || (L.isWin() ? 'powershell' : 'bash');
  if (!['powershell', 'bash'].includes(fence)) { process.stderr.write(`install-probe.js: --fence es powershell o bash, no «${fence}»\n`); return 2; }
  // sin la marca no es un laboratorio: no se escribe nada, ni el resultado del paso
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`install-probe.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const rec = L.recorder(NAME, out);
  let result;
  try { result = measure({ lab, out, fence, disposable: Boolean(args.disposable), allowTemp: Boolean(args['allow-temp']), rec }); } catch (e) {
    result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
  }
  rec.finish(result.status, result.reason);
  process.stdout.write(`install: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, VARIANTS, LINKS, measure, measureStartupTiming, measureMailboxUpload, findClone, runBlock, seenHomes, shellFilesWithCr, measureLinks, photoDiff };
