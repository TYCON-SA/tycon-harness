'use strict';

/**
 * no-hardcoded-paths.test.js — el enlace estable al arnés y el barrido de rutas fijas (T4 y T8).
 *
 * QUÉ EVITA. Si el código del núcleo tuviera escrito a mano dónde está clonado el arnés
 * (`~/SourceCode/tycon-claude-guides`), la organización de Azure
 * DevOps, un chat de Telegram y rutas de máquinas de personas, valdría en una máquina y en ninguna
 * otra, y no se podría publicar. Los prompts nombran al arnés por un enlace estable
 * (el lugar `~/.claude/tycon-harness`) que el instalador crea y cuida, y el código lo encuentra
 * por su ubicación o por ese enlace.
 *
 *   T4 · Rutas_EnlaceDelArnes_CreaReparaYNoMueve: el instalador bash, en una HOME temporal con
 *        agent-skills enlazado (sin `--check`, con `TYCON_CODEX=0` y los `TYCON_NO_*`): sin enlace lo
 *        crea; colgado lo repara; si apunta a OTRO clon válido avisa y no lo mueve, y `--link <ruta>`
 *        lo re-apunta; con una carpeta real en ese lugar no toca nada y lo dice.
 *   T8 · Nucleo_SinRutasNiServiciosFijos: el código ejecutable del núcleo (alcance de Dev Notes, en los
 *        dos repos) no contiene `SourceCode`, la organización de Azure DevOps, ningún chat_id ni rutas
 *        `/Users/<persona>` — salvo la lista de excepciones, cada una con su motivo.
 *   T25 · RutasSinFijas_RepoUnico_Enlaces: en el repo único —el clon trae `skills/` y
 *        `agents/` en su raíz— el instalador apunta a ese mismo clon todo lo que busca a agent-skills, con tres enlaces
 *        más (`~/.claude/agent-skills`, `agents` y `skills`); en el clon del equipo no toca ninguno; uno que apunta a otro
 *        clon válido no se mueve y se dice; con carpetas reales —o enlazadas a una carpeta propia— va un enlace por
 *        entrada y lo propio queda intacto; y con `--check` no escribe nada. Con él van los casos del instalador de la
 *        T31 que no necesitan contenedor (sin `python3`, sin `node`). El clon es de laboratorio: una COPIA de `scripts/`
 *        con un agent-skills de juguete al lado (un `scripts/` enlazado no sirve: `canonical-path.js` resuelve la ruta
 *        real y volvería al repo de verdad), sin terceros y con un `launchctl` de mentira.
 *
 * 🔴 Nada acá toca el HOME real ni el clon de
 *    agent-skills instalado: HOME temporal siempre; agent-skills se lee, no se escribe.
 * 🔴 «No pude mirar» no es «coincide»: si el árbol de agent-skills no está, su mitad sale NO MEDIDA.
 */

const test = require('./lib/suite-parts.js').test;   // se corre por partes: lib/suite-parts.js
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');                 // el clon del arnés
const INSTALADOR = path.join(RAIZ, 'scripts', 'install-tycon-hooks.sh');
const { resolveSkillsDirs } = require(path.join(RAIZ, 'scripts', 'lib', 'skills-dir.js'));
const { globARegex } = require(path.join(RAIZ, 'scripts', 'publishing', 'detector.js'));

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function real(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }

// ── T4 ────────────────────────────────────────────────────────────────────────────────────────────

/** Una HOME temporal como la del instalador: `.claude/agent-skills` enlazado al real (sin él aborta). */
function casaDeInstalador() {
  const home = tmp('rutas-home-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const skills = resolveSkillsDirs().repo;
  assert.ok(fs.existsSync(path.join(skills, 'skills', 'tycon-pipeline')), `agent-skills no está en ${skills}: el instalador aborta sin él`);
  fs.symlinkSync(skills, path.join(home, '.claude', 'agent-skills'));
  return home;
}
const SIN_EFECTOS = {
  TYCON_CODEX: '0', TYCON_NO_UPLOAD_RUNS: '1', TYCON_NO_DOWNLOAD_RUNS: '1', TYCON_NO_THREAD_RESCUE: '1',
  TYCON_NO_COLLECT_FINDINGS: '1', TYCON_NO_AZ_PROJECTS_REFRESH: '1', TYCON_NO_NIGHTLY_EXAM: '1',
  TYCON_NO_CLAUDEMD_SYNC: '1', TYCON_NO_COMMANDS_SYNC: '1', TYCON_NO_ENGRAM_VERSION_CHECK: '1', TYCON_NO_SQLITE_CHECK: '1',
  TYCON_NO_ENGRAM_PROJECT_CHECK: '1', TYCON_NO_GIT_HOOKS: '1', TYCON_NO_GUI_ENV: '1', TYCON_NO_AGENTSMD_POINTER: '1',
  TYCON_NO_CANONICAL_PATH: '0', TYCON_PROFILE: '0', TYCON_STAGE_METRICS: '0',
  // sin terceros: el instalador las bajaría al skills/ del clon que enlaza la HOME, el árbol compartido con las demás suites
  TYCON_THIRD_PARTY: '0',
  // el chequeo de paridad que el instalador lanza de fondo deja su reporte en scripts/controls-bench/.bench/ del clon
  TYCON_PARITY_BENCH_DIR: path.join(os.tmpdir(), `no-hardcoded-paths-parity-${process.pid}`),
};
function instalar(home, args = []) {
  const r = spawnSync('bash', [INSTALADOR, ...args], {
    encoding: 'utf8', timeout: 120000,
    env: Object.assign({ PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir() }, SIN_EFECTOS),
  });
  assert.equal(r.status, 0, `el instalador tiene que salir 0 (aviso, nunca freno): ${r.stderr}\n${r.stdout}`);
  return r.stdout + '\n' + r.stderr;
}
// el lugar del arnés: el único nombre que recibe una máquina nueva
const enlaceDe = (home) => require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'place.js')).placePath(home);
/** Otro clon «válido» del arnés: existe y tiene scripts/install-tycon-hooks.sh. */
function otroClonValido() {
  const d = tmp('rutas-otro-clon-');
  fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/usr/bin/env bash\nexit 0\n');
  return d;
}

test('T4 Rutas_EnlaceDelArnes_CreaReparaYNoMueve — sin enlace: el instalador lo crea apuntando a este clon', () => {
  const home = casaDeInstalador();
  const salida = instalar(home);
  assert.ok(fs.lstatSync(enlaceDe(home)).isSymbolicLink(), 'es un enlace');
  assert.equal(real(enlaceDe(home)), real(RAIZ));
  assert.match(salida, /enlace/i);
});

test('T4 — enlace colgado: lo repara', () => {
  const home = casaDeInstalador();
  fs.symlinkSync(path.join(home, 'no-existe-mas'), enlaceDe(home));
  const salida = instalar(home);
  assert.equal(real(enlaceDe(home)), real(RAIZ));
  assert.match(salida, /colgado|repar/i);
});

test('T4 — enlace a OTRO clon válido: avisa, no lo mueve, y nombra --link; con --link <ruta> lo re-apunta', () => {
  const home = casaDeInstalador();
  const otro = otroClonValido();
  fs.symlinkSync(otro, enlaceDe(home));
  const salida = instalar(home);
  assert.equal(real(enlaceDe(home)), real(otro), 'no lo movió');
  assert.match(salida, /--link/);
  assert.match(salida, /otro clon/i);
  const salida2 = instalar(home, ['--link', RAIZ]);
  assert.equal(real(enlaceDe(home)), real(RAIZ), 'con --link <ruta> lo re-apuntó');
  assert.match(salida2, /re-?apunt/i);
});

test('T4 — una carpeta real en ese lugar: no la pisa y lo dice', () => {
  const home = casaDeInstalador();
  fs.mkdirSync(enlaceDe(home));
  fs.writeFileSync(path.join(enlaceDe(home), 'mio.txt'), 'del dev');
  const salida = instalar(home);
  const st = fs.lstatSync(enlaceDe(home));
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), 'sigue siendo una carpeta');
  assert.ok(fs.existsSync(path.join(enlaceDe(home), 'mio.txt')), 'con lo que tenía adentro');
  assert.match(salida, /carpeta/i);
});

test('T4 — --link a algo que no es un clon del arnés: frena con el motivo (exit 2) y no escribe', () => {
  const home = casaDeInstalador();
  const r = spawnSync('bash', [INSTALADOR, '--link', tmp('rutas-no-clon-')], {
    encoding: 'utf8', timeout: 120000, env: Object.assign({ PATH: process.env.PATH, HOME: home }, SIN_EFECTOS),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(enlaceDe(home)) && !isLink(enlaceDe(home)), 'no creó nada');
});
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } }

test('T4 — la configuración ROTA no aborta el instalador ni se lee como «sin raíz» (rama Codex; pase adversarial, vuelta 1)', () => {
  // Con TYCON_CODEX=1 el instalador deposita punteros AGENTS.md en los repos del equipo, y para eso lee la raíz de
  // repos y la organización con el lector nuevo. Bajo `set -e`, una asignación `X="$(cmd)"` con cmd ≠ 0 abortaba el
  // instalador ENTERO, mudo, con rc 2 (config rota) o rc 3 (sin organización) — en cada arranque de sesión de toda
  // máquina con Codex. Acá: `--check`, HOME temporal, el sello del disparo real de Codex ya puesto hoy (para que no
  // lance nada), y el puntero de AGENTS.md prendido a propósito (es el bloque que se mide).
  const home = casaDeInstalador();
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.tycon-pipeline', 'live-fire-codex-last-try'), new Date().toISOString().slice(0, 10));
  const env = Object.assign({ PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir() }, SIN_EFECTOS, { TYCON_CODEX: '1', TYCON_NO_AGENTSMD_POINTER: '0' });
  // (a) tycon.json roto → se dice tal cual (archivo y motivo), exit 0, y el instalador SIGUE
  fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), '{ roto');
  let r = spawnSync('bash', [INSTALADOR, '--check'], { encoding: 'utf8', timeout: 180000, env });
  let salida = r.stdout + '\n' + r.stderr;
  assert.equal(r.status, 0, salida);
  // el bloque de integraciones del instalador lo dice (una vez, «ROTA», y las integraciones —Codex
  // incluida— quedan como están): el bloque de AGENTS.md no llega a correr con la configuración rota
  assert.match(salida, /configuración del arnés está (rota|ROTA)/);
  assert.match(salida, /tycon\.json/);
  assert.doesNotMatch(salida, /sin raíz de repos conocida/, 'un archivo roto no se lee como «sin raíz»');
  assert.doesNotMatch(salida, /apagadas:/, 'con la configuración rota no se resume «apagadas»: no se lee como todo apagado');
  // (b) sin organización (perfil anulado, nada en la máquina): «sin organización», exit 0, y sigue
  fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), JSON.stringify({ rutas: { repos: home } }));
  r = spawnSync('bash', [INSTALADOR, '--check'], { encoding: 'utf8', timeout: 180000, env });
  salida = r.stdout + '\n' + r.stderr;
  assert.equal(r.status, 0, salida);
  assert.match(salida, /sin organización de Azure DevOps configurada/);
});

// ── T25 · RutasSinFijas_RepoUnico_Enlaces ──────────────────────────────────────────────────────────
// 🔴 Nunca la HOME real: HOME temporal siempre, `TYCON_NO_NIGHTLY_EXAM=1`, `TYCON_NO_GUI_ENV=1` y `LAUNCHCTL_BIN` de
//    mentira (las tareas programadas de macOS son por usuario, no por HOME). Sin terceros (`TYCON_THIRD_PARTY=0`): ni
//    red ni historia de git. El instalador recibe un ambiente armado a mano: nada de quien corre la suite le llega.

const PIECES_FIXTURE = path.join(RAIZ, 'scripts', 'tests', 'fixtures', 'harness-managed-pieces.json');

// las carpetas del laboratorio se borran al terminar (cada clon son ~7,5 MB)
const LAB_TMP_DIRS = [];
function labTmp(p) { const d = tmp(p); LAB_TMP_DIRS.push(d); return d; }
test.after(() => { for (const d of LAB_TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* un proceso de fondo todavía la usa */ } } });
function isRealDir(p) { try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch (_) { return false; } }
function exists(p) { try { fs.lstatSync(p); return true; } catch (_) { return false; } }
function write(f, text, mode) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, mode ? { mode } : undefined); return f; }

/** Los scripts de hooks que el set canónico busca en agent-skills (los que no son `@tcg:`), de la lista declarada. */
function hookScriptsOfAgentSkills() {
  const fix = JSON.parse(fs.readFileSync(PIECES_FIXTURE, 'utf8'));
  return fix.pieces
    .filter((p) => p.kind === 'hook' && p.id && p.when !== 'platform:windows')
    .map((p) => p.id.slice(p.id.indexOf(':') + 1))
    .filter((rel) => !rel.startsWith('@tcg:'));
}
/** Un agent-skills de juguete en `dir`: `skills/` con un archivo vacío por hook, una skill más, y `agents/` con un revisor. */
function toyAgentSkills(dir) {
  for (const rel of hookScriptsOfAgentSkills()) write(path.join(dir, 'skills', rel), '');
  write(path.join(dir, 'skills', 'tycon-pipeline', 'SKILL.md'), '# skill de juguete\n');
  write(path.join(dir, 'skills', 'lab-skill', 'SKILL.md'), '# otra skill de juguete\n');
  write(path.join(dir, 'agents', 'lab-reviewer.md'), '# revisor de juguete\n');
  return dir;
}
/**
 * Un clon de laboratorio: copia de `scripts/` (sin sus pruebas), `commands/` y `claude-md-blocks/`. Con `single: true`
 * es el repo único (trae `skills/` y `agents/` en la raíz); sin él, el clon del equipo (el arnés solo).
 */
function labClone({ single }) {
  const dir = labTmp(single ? 'lab-single-repo-' : 'lab-team-clone-');
  const skip = [path.join(RAIZ, 'scripts', 'tests'), path.join(RAIZ, 'scripts', 'controls-bench', '.bench')];
  fs.cpSync(path.join(RAIZ, 'scripts'), path.join(dir, 'scripts'), {
    recursive: true, filter: (src) => !skip.includes(src) && path.basename(src) !== 'node_modules',
  });
  for (const d of ['commands', 'claude-md-blocks']) {
    if (fs.existsSync(path.join(RAIZ, d))) fs.cpSync(path.join(RAIZ, d), path.join(dir, d), { recursive: true });
  }
  if (single) toyAgentSkills(dir);
  return real(dir);
}
// el repo único que comparten los casos que no le cambian nada; se arma la primera vez que un caso lo pide
let sharedSingle = null;
function singleRepo() { if (!sharedSingle) sharedSingle = labClone({ single: true }); return sharedSingle; }

function cleanHome() { return labTmp('lab-home-'); }   // ni siquiera trae `.claude`
const claude = (home, ...p) => path.join(home, '.claude', ...p);

/** Lo que nunca puede correr contra la máquina real, más lo que una corrida que SÍ escribe no tiene que lanzar de fondo. */
let safeEnv = null;
function safe() {
  if (safeEnv) return safeEnv;
  const fakeLaunchctl = write(path.join(labTmp('lab-bin-'), 'launchctl'), '#!/bin/sh\n# launchctl de mentira: no carga nada en la máquina real\nexit 0\n', 0o755);
  safeEnv = {
    TYCON_PROFILE: '0', TYCON_CODEX: '0', TYCON_THIRD_PARTY: '0', TYCON_NO_NIGHTLY_EXAM: '1', TYCON_NO_GUI_ENV: '1',
    LAUNCHCTL_BIN: fakeLaunchctl, TYCON_NO_AZ_PROJECTS_REFRESH: '1', TYCON_NO_AGENTSMD_POINTER: '1',
    TYCON_NO_ENGRAM_VERSION_CHECK: '1', TYCON_NO_SQLITE_CHECK: '1', TYCON_NO_ENGRAM_PROJECT_CHECK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    // si el barrido de métricas llegara a lanzarse (es lo que `--check` NO tiene que hacer), que barra una carpeta vacía
    // y no la carpeta temporal entera de la máquina (la raíz por defecto del barrido es el padre del clon)
    TYCON_METRICS_SCAN_ROOT: labTmp('lab-empty-scan-root-'),
  };
  return safeEnv;
}
const NO_BACKGROUND = {
  TYCON_NO_UPLOAD_RUNS: '1', TYCON_NO_DOWNLOAD_RUNS: '1', TYCON_NO_THREAD_RESCUE: '1', TYCON_NO_COLLECT_FINDINGS: '1',
  TYCON_STAGE_METRICS: '0', TYCON_BENCH_DAILY: '0', TYCON_NO_GIT_HOOKS: '1', TYCON_NO_CLAUDEMD_SYNC: '1',
};

function which(bin) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch (_) { /* no está ahí */ }
  }
  return null;
}
const BASH = which('bash');   // por su ruta: algunos casos corren con un PATH armado a mano
/** Una carpeta con enlaces a las herramientas de siempre, menos `missing`: el PATH de una máquina a la que le falta ésa. */
function pathWithout(missing) {
  const dir = labTmp('lab-path-');
  const tools = ['bash', 'sh', 'env', 'dirname', 'basename', 'cat', 'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'chmod', 'ls', 'find',
    'grep', 'sed', 'awk', 'tr', 'cut', 'head', 'tail', 'wc', 'sort', 'cmp', 'date', 'mktemp', 'uname', 'id', 'git', 'nohup',
    'touch', 'tee', 'node', 'python3'];
  for (const t of tools) {
    if (t === missing) continue;
    const p = which(t);
    if (p) fs.symlinkSync(p, path.join(dir, t));
  }
  return dir;
}

/**
 * Corre el instalador del clon. `background: true` deja prendido lo que una corrida real lanzaría de fondo (el sello de
 * métricas, el banco diario, los hooks de git, el sync de bloques): es lo que `--check` tiene que NO escribir.
 */
function install(clone, home, args = [], { env = {}, background = false, PATH = process.env.PATH } = {}) {
  const r = spawnSync(BASH, [path.join(clone, 'scripts', 'install-tycon-hooks.sh'), ...args], {
    encoding: 'utf8', timeout: 180000, cwd: home,
    env: Object.assign({ PATH, HOME: home, TMPDIR: os.tmpdir() }, safe(), background ? {} : NO_BACKGROUND, env),
  });
  return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}`, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** El listado COMPLETO de una carpeta: cada ruta con su tipo; los enlaces con su destino; los archivos con su hash. */
function listing(dir) {
  const out = [];
  const walk = (d, rel) => {
    let names = [];
    try { names = fs.readdirSync(d).sort(); } catch (_) { return; }
    for (const n of names) {
      const p = path.join(d, n); const r = rel ? `${rel}/${n}` : n;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.push(`${r} -> ${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) { out.push(`${r}/`); walk(p, r); }
      else out.push(`${r} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir, '');
  return out.join('\n');
}
/** Las piezas `link` de un reporte del instalador (`--report-json`). */
function linkPieces(report) { return JSON.parse(fs.readFileSync(report, 'utf8')).filter((p) => p.kind === 'link'); }

test('T25 RutasSinFijas_RepoUnico_Enlaces — repo único, HOME limpia: los cuatro enlaces, y el instalador registra los hooks por ellos', () => {
  const single = singleRepo();
  const home = cleanHome();
  const report = path.join(labTmp('lab-report-'), 'report.json');
  const r = install(single, home, ['--report-json', report]);
  assert.equal(r.status, 0, r.out);
  // el lugar del arnés nace; una máquina nueva no recibe el nombre viejo
  const PLACE = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'place.js'));
  assert.equal(real(claude(home, PLACE.PLACE_NAME)), single, 'el lugar del arnés → el clon');
  assert.ok(!exists(claude(home, PLACE.LEGACY_PLACE_NAME)), 'una máquina nueva recibió el nombre viejo');
  assert.equal(real(claude(home, 'agent-skills')), single, 'agent-skills → el clon');
  for (const n of [PLACE.PLACE_NAME, 'agent-skills']) assert.ok(isLink(claude(home, n)), `${n} es un enlace`);
  // skills y agents son carpetas reales del dev, con un enlace por CADA entrada del clon
  const entries = [];
  for (const side of ['skills', 'agents']) {
    assert.ok(fs.statSync(claude(home, side)).isDirectory() && !isLink(claude(home, side)), `${side} es una carpeta real`);
    for (const e of fs.readdirSync(path.join(single, side))) {
      entries.push(`${side}/${e}`);
      assert.ok(isLink(claude(home, side, e)), `${side}/${e} es un enlace`);
      assert.equal(real(claude(home, side, e)), path.join(single, side, e), `${side}/${e} → <clon>/${side}/${e}`);
    }
  }
  assert.ok(entries.length > 0, 'el clon trae entradas en skills/ y agents/');
  assert.doesNotMatch(r.out, /agent-skills no encontrado/);
  const settings = fs.readFileSync(claude(home, 'settings.json'), 'utf8');
  assert.match(settings, /\.claude\/agent-skills\/skills\/tycon-pipeline\/scripts\/on-prompt\.js/, 'los hooks de agent-skills quedan registrados por el enlace');
  // el reporte de piezas trae los enlaces (los dos nombres del lugar y los tres del repo único), y cada uno
  // casa con la lista declarada
  const pieces = linkPieces(report);
  assert.deepEqual(pieces.map((p) => p.id).sort(), ['agent-skills', PLACE.PLACE_NAME, ...entries].sort());
  const declared = JSON.parse(fs.readFileSync(PIECES_FIXTURE, 'utf8')).pieces.filter((d) => d.kind === 'link');
  for (const p of pieces) {
    const ok = declared.some((d) => (d.id ? d.id === p.id : new RegExp(d.id_pattern).test(p.id)) && new RegExp(d.where_pattern).test(p.where));
    assert.ok(ok, `el enlace ${p.id} (${p.where}) no está en la lista declarada de piezas`);
  }
  // segunda corrida: nada que decir de los enlaces
  const again = install(single, home);
  assert.equal(again.status, 0, again.out);
  assert.doesNotMatch(again.out, /repo único|enlace\(s\) por entrada/, 'la segunda corrida no vuelve a hablar de los enlaces');
});

test('T25 — el clon del equipo (sin skills/ en la raíz): ningún enlace nuevo, y ni una línea sobre ellos', () => {
  const team = labClone({ single: false });
  const home = cleanHome();
  const otherSkills = toyAgentSkills(labTmp('lab-team-agent-skills-'));
  fs.mkdirSync(claude(home), { recursive: true });
  fs.symlinkSync(otherSkills, claude(home, 'agent-skills'));
  const r = install(team, home);
  assert.equal(r.status, 0, r.out);
  assert.equal(real(enlaceDe(home)), team);
  assert.equal(real(claude(home, 'agent-skills')), real(otherSkills), 'el agent-skills del equipo sigue donde estaba');
  assert.ok(!exists(claude(home, 'agents')) && !exists(claude(home, 'skills')), 'ni ~/.claude/agents ni ~/.claude/skills');
  assert.doesNotMatch(r.out, /repo único|no lo muevo|enlace\(s\) por entrada/);
});

test('T25 — ~/.claude/agent-skills apunta a OTRO clon válido: no se mueve y se dice', () => {
  const home = cleanHome();
  const other = toyAgentSkills(labTmp('lab-other-agent-skills-'));
  fs.mkdirSync(claude(home), { recursive: true });
  fs.symlinkSync(other, claude(home, 'agent-skills'));
  const r = install(singleRepo(), home);
  assert.equal(r.status, 0, r.out);
  assert.equal(real(claude(home, 'agent-skills')), real(other), 'no lo movió');
  assert.match(r.out, /agent-skills apunta a otro lado que sirve[^\n]*no lo muevo/);
});

test('T25 — skills/ y agents/ como carpetas reales con una entrada propia y una que choca: un enlace por entrada, lo propio intacto, el choque nombrado; la segunda corrida agrega y saca lo suyo', () => {
  const clone = labClone({ single: true });   // propio: este caso le agrega y le borra entradas
  const home = cleanHome();
  write(claude(home, 'skills', 'mine', 'SKILL.md'), '# mi skill\n');
  write(claude(home, 'skills', 'lab-skill', 'SKILL.md'), '# la mía se llama igual que una del clon\n');
  write(claude(home, 'agents', 'mine.md'), '# mi agente\n');
  const r = install(clone, home);
  assert.equal(r.status, 0, r.out);
  assert.ok(isRealDir(claude(home, 'skills')) && isRealDir(claude(home, 'agents')), 'las carpetas reales no se pisan');
  assert.equal(real(claude(home, 'skills', 'tycon-pipeline')), path.join(clone, 'skills', 'tycon-pipeline'));
  assert.equal(real(claude(home, 'agents', 'lab-reviewer.md')), path.join(clone, 'agents', 'lab-reviewer.md'));
  assert.equal(fs.readFileSync(claude(home, 'skills', 'mine', 'SKILL.md'), 'utf8'), '# mi skill\n', 'la skill propia, intacta');
  assert.equal(fs.readFileSync(claude(home, 'agents', 'mine.md'), 'utf8'), '# mi agente\n', 'el agente propio, intacto');
  assert.ok(isRealDir(claude(home, 'skills', 'lab-skill')), 'la que choca no se pisa');
  assert.equal(fs.readFileSync(claude(home, 'skills', 'lab-skill', 'SKILL.md'), 'utf8'), '# la mía se llama igual que una del clon\n');
  const clashLines = r.out.split('\n').filter((l) => /no las piso/.test(l));
  assert.equal(clashLines.length, 1, `el choque se nombra en UNA línea: ${r.out}`);
  assert.match(clashLines[0], /skills\/lab-skill/);
  // segunda corrida: una skill nueva en el clon y un revisor borrado
  write(path.join(clone, 'skills', 'new-skill', 'SKILL.md'), '# nueva\n');
  write(path.join(clone, 'agents', 'new-reviewer.md'), '# nuevo\n');
  fs.rmSync(path.join(clone, 'agents', 'lab-reviewer.md'));
  const again = install(clone, home);
  assert.equal(again.status, 0, again.out);
  assert.equal(real(claude(home, 'skills', 'new-skill')), path.join(clone, 'skills', 'new-skill'), 'agrega la skill nueva');
  assert.equal(real(claude(home, 'agents', 'new-reviewer.md')), path.join(clone, 'agents', 'new-reviewer.md'), 'agrega el revisor nuevo');
  assert.ok(!exists(claude(home, 'agents', 'lab-reviewer.md')), 'saca el enlace suyo que quedó colgado');
  assert.ok(exists(claude(home, 'agents', 'mine.md')) && exists(claude(home, 'skills', 'mine', 'SKILL.md')), 'lo propio sigue');
  assert.match(again.out, /skills es una carpeta real[^\n]*1 enlace\(s\) por entrada agregado/);
  assert.match(again.out, /agents es una carpeta real[^\n]*1 enlace\(s\) por entrada agregado\(s\) y 1 sacado/);
});

test('T25 — skills/ y agents/ ENLAZADAS a una carpeta propia (los archivos de configuración de la persona): el enlace no se mueve, adentro va un enlace por entrada, lo propio intacto y la línea dice «carpeta propia»; la segunda corrida, muda', () => {
  // Mover el enlace dejaría sus skills fuera de la vista de Claude. Las carpetas propias
  // se llaman `skills` y `agents` a propósito: el nombre solo no las vuelve «otro clon del arnés».
  const single = singleRepo();
  const home = cleanHome();
  const own = real(labTmp('lab-own-folders-'));
  write(path.join(own, 'skills', 'mine', 'SKILL.md'), '# mi skill\n');
  write(path.join(own, 'agents', 'mine.md'), '# mi agente\n');
  fs.mkdirSync(claude(home), { recursive: true });
  fs.symlinkSync(path.join(own, 'skills'), claude(home, 'skills'));
  fs.symlinkSync(path.join(own, 'agents'), claude(home, 'agents'));
  const report = path.join(labTmp('lab-report-'), 'report.json');
  const r = install(single, home, ['--report-json', report]);
  assert.equal(r.status, 0, r.out);
  for (const n of ['skills', 'agents']) {
    assert.ok(isLink(claude(home, n)), `~/.claude/${n} sigue siendo un enlace`);
    assert.equal(real(claude(home, n)), path.join(own, n), `…y sigue apuntando a la carpeta propia: no se movió`);
    const lines = r.out.split('\n').filter((l) => new RegExp(`\\.claude/${n} es un enlace a una carpeta propia`).test(l));
    assert.equal(lines.length, 1, `una línea dice «carpeta propia» para ${n}: ${r.out}`);
    assert.match(lines[0], /no lo muevo[^\n]*enlace\(s\) por entrada agregado/);
  }
  assert.equal(real(claude(home, 'agent-skills')), single, 'agent-skills, que no existía, sí se crea → el clon');
  // adentro de la carpeta propia, un enlace por entrada del clon
  assert.ok(isLink(path.join(own, 'skills', 'tycon-pipeline')) && isLink(path.join(own, 'skills', 'lab-skill')) && isLink(path.join(own, 'agents', 'lab-reviewer.md')));
  assert.equal(real(path.join(own, 'skills', 'tycon-pipeline')), path.join(single, 'skills', 'tycon-pipeline'));
  assert.equal(real(path.join(own, 'agents', 'lab-reviewer.md')), path.join(single, 'agents', 'lab-reviewer.md'));
  // lo propio, intacto
  assert.equal(fs.readFileSync(path.join(own, 'skills', 'mine', 'SKILL.md'), 'utf8'), '# mi skill\n', 'la skill propia, intacta');
  assert.equal(fs.readFileSync(path.join(own, 'agents', 'mine.md'), 'utf8'), '# mi agente\n', 'el agente propio, intacto');
  assert.ok(isRealDir(path.join(own, 'skills', 'mine')), 'la skill propia sigue siendo una carpeta real');
  // las piezas son los enlaces por entrada, no los dos enlaces de la persona (`uninstall` no puede llevárselos)
  const ids = linkPieces(report).map((p) => p.id);
  for (const id of ['agent-skills', 'skills/tycon-pipeline', 'skills/lab-skill', 'agents/lab-reviewer.md']) assert.ok(ids.includes(id), `falta la pieza ${id}: ${ids.join(', ')}`);
  assert.ok(!ids.includes('skills') && !ids.includes('agents'), `los enlaces de la persona no son piezas del arnés: ${ids.join(', ')}`);
  // segunda corrida: la carpeta propia ya tiene `tycon-pipeline` adentro (como enlace) y no pasa a ser «otro clon»
  const again = install(single, home);
  assert.equal(again.status, 0, again.out);
  assert.doesNotMatch(again.out, /carpeta propia|no lo muevo|enlace\(s\) por entrada|repo único/, 'la segunda corrida no dice nada de los enlaces');
  assert.equal(real(claude(home, 'skills')), path.join(own, 'skills'), 'y el enlace sigue donde estaba');
  assert.equal(real(claude(home, 'agents')), path.join(own, 'agents'));
});

test('T25/T31 — --check en una HOME limpia: no sale 1, dice qué haría y NO escribe nada (el listado completo de la HOME, idéntico)', () => {
  const home = cleanHome();
  const before = listing(home);
  const r = install(singleRepo(), home, ['--check'], { background: true });
  assert.equal(r.status, 0, `--check en el repo único sin enlaces no sale 1: ${r.out}`);
  assert.equal(listing(home), before, 'con --check, nada escrito en la HOME');
  assert.equal(before, '', 'la HOME de la prueba estaba vacía');
  assert.match(r.out, /\(--check\)[^\n]*agent-skills/, 'dice qué haría con el enlace');
  assert.match(r.out, /hooks faltan/, 'y que faltan los hooks (los miró en <clon>/skills)');
  assert.doesNotMatch(r.out, /agent-skills no encontrado/);
});

test('T25/T31 — --check sobre una HOME ya instalada: tampoco escribe nada (ni el sello de las métricas ni ~/.claude/commands)', () => {
  const clone = labClone({ single: true });   // propio: el caso mira que en el clon no aparezca `.dashboard/`
  const home = cleanHome();
  const first = install(clone, home);
  assert.equal(first.status, 0, first.out);
  const before = listing(home);
  const r = install(clone, home, ['--check'], { background: true });
  assert.equal(r.status, 0, r.out);
  assert.equal(listing(home), before, `con --check, nada escrito en la HOME ya instalada:\n${r.out}`);
  // el respaldo de las métricas, si se lanzara, deja su punto del día en <clon>/.dashboard/ (corre de fondo: esta mirada
  // puede llegar antes; el sello en la HOME, que se escribe en línea, es la prueba firme)
  assert.ok(!fs.existsSync(path.join(clone, '.dashboard')), 'con --check tampoco se lanza el barrido de métricas (no hay .dashboard/ en el clon)');
});

test('T31 — --check con el tycon-pipeline REAL en el clon (el instalador corre sus seis suites rápidas también con --check): nada escrito', (t) => {
  const src = resolveSkillsDirs().repo;   // un clon de agent-skills que sólo se lee
  if (!fs.existsSync(path.join(src, 'skills', 'tycon-pipeline'))) {
    console.log(`  ℹ NO MEDIDO — agent-skills no está en ${src} (TYCON_SKILLS_DIR o ~/.claude/agent-skills). No se juzga acá.`);
    t.skip('agent-skills ausente: no medido');
    return;
  }
  const clone = labClone({ single: false });
  fs.cpSync(path.join(src, 'skills', 'tycon-pipeline'), path.join(clone, 'skills', 'tycon-pipeline'), { recursive: true, filter: (p) => path.basename(p) !== 'node_modules' });
  write(path.join(clone, 'agents', 'lab-reviewer.md'), '# revisor de juguete\n');
  const home = cleanHome();
  const r = install(clone, home, ['--check'], { background: true });
  assert.equal(r.status, 0, r.out);
  assert.equal(listing(home), '', `con --check y las suites rápidas corriendo, nada escrito en la HOME:\n${r.out}`);
});

test('T31 — el clon del equipo sin agent-skills sigue saliendo 1 (el espejo: --check no tapa una máquina a medio instalar)', () => {
  const team = labClone({ single: false });
  const home = cleanHome();
  const r = install(team, home, ['--check']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /agent-skills no encontrado/);
  assert.equal(listing(home), '', 'y no escribió nada');
});

for (const tool of ['python3', 'node']) {
  test(`T31 — sin ${tool} en el PATH: UNA línea que lo nombra y remite a los requisitos de la portada, salida 1, nada escrito`, () => {
    const home = cleanHome();
    const r = install(singleRepo(), home, [], { PATH: pathWithout(tool) });
    assert.equal(r.status, 1, r.out);
    const lines = r.out.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 1, `una sola línea: ${r.out}`);
    assert.match(lines[0], /falta (python3|node) en el PATH/);
    assert.match(lines[0], new RegExp(`falta ${tool} en el PATH`));
    assert.match(lines[0], /requisitos de la portada/);
    assert.equal(listing(home), '', 'nada escrito: ni el candado, ni settings.json, ni el enlace');
  });
}

test('T31 — un python3 que está en el PATH y no arranca cuenta como faltante: UNA línea, salida 1, nada escrito', () => {
  const home = cleanHome();
  const dir = pathWithout('python3');
  // el alias de la tienda de Windows visto desde Git Bash, o un stub: está, imprime algo y sale distinto de 0
  write(path.join(dir, 'python3'), '#!/bin/sh\necho "Python was not found" >&2\nexit 49\n', 0o755);
  const r = install(singleRepo(), home, [], { PATH: dir });
  assert.equal(r.status, 1, r.out);
  const lines = r.out.split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 1, `una sola línea: ${r.out}`);
  assert.match(lines[0], /python3 está en el PATH .* pero no arranca/);
  assert.match(lines[0], /requisitos de la portada/);
  assert.equal(listing(home), '', 'nada escrito: ni el esqueleto de settings.json ni los enlaces');
});

test('T31 — el espejo: con python3 y node en ese mismo PATH armado a mano, el instalador corre y sale 0', () => {
  const home = cleanHome();
  const r = install(singleRepo(), home, [], { PATH: pathWithout(null) });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /falta (python3|node) en el PATH/);
  assert.ok(fs.existsSync(claude(home, 'settings.json')));
});

// ── T8 ────────────────────────────────────────────────────────────────────────────────────────────

// Lo que no puede estar en el código ejecutable del núcleo. La organización de Azure DevOps y el chat de una
// persona NO se escriben acá, ni enteros ni por partes (ni dentro de un regex ni partidos
// en dos literales): este archivo sale en la copia pública. Salen de la lista privada
// de nombres, que no viaja. Sin la lista —la copia pública— no hay organización ni chat del equipo que buscar y esos
// dos patrones no se arman; con una lista que no los trae o no se deja leer, la prueba falla: no pudo mirar.
const PRIVATE_LIST = path.join(RAIZ, 'scripts', 'publishing', 'denylist.json');
/** `{ state: 'ok' | 'absent' | 'incomplete', patterns }` — los dos patrones que dependen del equipo, desde su lista privada. */
function privatePatterns(listPath = PRIVATE_LIST) {
  if (!fs.existsSync(listPath)) return { state: 'absent', patterns: [] };
  let terms;
  try { terms = JSON.parse(fs.readFileSync(listPath, 'utf8')).terminos; } catch (_) { return { state: 'incomplete', patterns: [] }; }
  const literal = (t) => String(t.patron).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const of = (category, shape) => (Array.isArray(terms) ? terms : []).filter((t) => t && t.categoria === category && shape.test(String(t.patron))).map(literal);
  const org = of('host-interno', /^dev\.azure\.com\/[^/]+$|^[^/.]+\.visualstudio\.com$/);
  const chats = of('persona', /^\d{8,}$/);
  if (!org.length || !chats.length) return { state: 'incomplete', patterns: [] };
  return { state: 'ok', patterns: [
    { nombre: 'organización de Azure DevOps', re: new RegExp(org.join('|'), 'i') },
    { nombre: 'chat_id de una persona', re: new RegExp(chats.join('|')) },
  ] };
}
const PRIVATE = privatePatterns();
const PATRONES = [
  { nombre: 'SourceCode como carpeta', re: /SourceCode/ },
  ...PRIVATE.patterns,
  { nombre: 'ruta de la máquina de una persona', re: /\/Users\/[a-z]{3,}\b/ },
];
const EXTENSIONES = /\.(js|mjs|cjs|sh|py|ps1|md|json|ya?ml|txt|command)$/;

/**
 * Excepciones, cada una con su motivo. `patron` acota la excepción a las líneas que lo cumplen: el
 * resto del archivo se juzga igual.
 */
const EXCEPCIONES = [
  { archivo: 'scripts/nightly/dashboard/runs.js', patron: /SourceCode[-|]/, motivo: 'regex que reconoce «SourceCode-» en nombres de carpeta codificados de OTRAS máquinas (dato de entrada, no un default)' },
  { archivo: 'scripts/publishing/public-repos.json', patron: /"(?:team|maintainers)":/, motivo: 'las URLs de los repos PRIVADOS del equipo: `team`, el de la capa (story 8.25, AC 23), y `maintainers`, el de mantenimiento, que harness-repo.js lee para reconocer ese clon como del arnés (story 8.26, AC 21). Viven en la organización del equipo a propósito y este archivo es la lista interna de repos, que el exportador no publica (export-real T16 lo mide). Una excepción por archivo: el lector toma la primera', noViaja: true },
  { archivo: 'scripts/publishing/public-files/getting-started/mac.md', patron: /SourceCode/, motivo: 'instrucciones de instalación para una persona: le RECOMIENDAN dónde clonar el arnés (una carpeta dentro de ~/SourceCode); es un consejo que el lector sigue o cambia, no una ruta que el arnés supone' },
  { archivo: 'scripts/publishing/public-files/getting-started/linux.md', patron: /SourceCode/, motivo: 'instrucciones de instalación para una persona: le RECOMIENDAN dónde clonar el arnés (una carpeta dentro de ~/SourceCode); es un consejo que el lector sigue o cambia, no una ruta que el arnés supone' },
  { archivo: 'scripts/publishing/public-files/getting-started/windows.md', patron: /SourceCode/, motivo: 'instrucciones de instalación para una persona: le RECOMIENDAN dónde clonar el arnés (una carpeta dentro de ~/SourceCode); es un consejo que el lector sigue o cambia, no una ruta que el arnés supone' },
];

/** Alcance del arnés: el código ejecutable del núcleo, en los dos repos. */
function archivosDelArnes() {
  // el nocturno de dependencias vive entero en scripts/nightly/dependencies/: en su carpeta anterior
  // quedan sólo reemplazos, que no nombran nada del equipo y se miran como cualquier otro archivo
  const salen = [
    /^scripts\/tests\//, /^scripts\/controls-bench\/(cases|evidence|\.bench)\//, /^scripts\/nightly\/dependencies\//, /^scripts\/vigilante\//,
    /^scripts\/metrics\/corridas-buzon\.json$/, /^scripts\/metrics\/censo-[^/]*\.json$/, /^scripts\/publishing\/denylist\.json$/,
    /^scripts\/publishing\/replacements\.json$/,   // la tabla privada del exportador: nombra a los reales a propósito y nunca sale
    /^scripts\/ci\/product-parity\.json$/,
  ];
  const out = [];
  // `.githooks` entra: en la copia pública de un solo repo el pre-commit del arnés viaja junto al de
  // agent-skills y lo mide T8; con esto los dos layouts miran lo mismo
  for (const raiz of ['scripts', 'build', 'commands', 'claude-md-blocks', '.githooks']) {
    for (const f of caminar(path.join(RAIZ, raiz))) {
      const rel = path.relative(RAIZ, f);
      if (salen.some((re) => re.test(rel))) continue;
      out.push({ rel, abs: f });
    }
  }
  return out;
}
/** Alcance de agent-skills: todo `agents/*.md` salvo los que declara el paquete de clientes; skills del núcleo; .githooks; packs. */
function archivosDeAgentSkills(repo) {
  const out = [];
  const declaradosClientes = new Set();
  // la carpeta se llama `clients`; un agent-skills anterior todavía tiene la vieja
  const carpeta = ['clients', 'clientes'].map((n) => path.join(repo, 'packs', n, 'pack.json')).find((f) => fs.existsSync(f));
  try {
    // un agent-skills anterior trae las claves viejas del manifiesto: se leen por el mapa
    const { readKeysDeep } = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
    const pack = readKeysDeep(JSON.parse(fs.readFileSync(carpeta, 'utf8')), 'packs/pack.json');
    for (const r of pack.reviewers || []) declaradosClientes.add(r.agent);
  } catch (_) { /* sin paquete de clientes: entran todos */ }
  for (const f of caminar(path.join(repo, 'agents'), { profundidad: 1 })) {
    const nombre = path.basename(f, '.md');
    if (f.endsWith('.md') && !declaradosClientes.has(nombre)) out.push({ rel: path.relative(repo, f), abs: f });
  }
  const skills = fs.readdirSync(path.join(repo, 'skills')).filter((s) => /^tycon-/.test(s) || ['check-story-drift', 'clocki', 'tycon-create-story'].includes(s));
  for (const s of skills) for (const f of caminar(path.join(repo, 'skills', s))) out.push({ rel: path.relative(repo, f), abs: f });
  for (const d of ['.githooks', 'packs']) for (const f of caminar(path.join(repo, d))) out.push({ rel: path.relative(repo, f), abs: f });
  const salen = [/(^|\/)tests\//, /(^|\/)fixtures\//, /(^|\/)__tests__\//];
  // Lo que la lista blanca deja AFUERA de la copia del núcleo no es núcleo (la skill del alta de productos:
  // su infraestructura es la del equipo). Se lee de la lista, no se copia acá: una segunda lista se separa.
  const lista = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'allowlist.json'), 'utf8'));
  const afuera = ((lista.packages.core['agent-skills'] || {}).out || []).map((x) => globARegex(x.glob.endsWith('/') ? `${x.glob}**` : x.glob));
  const quedan = out.filter((e) => !salen.some((re) => re.test(e.rel)) && !afuera.some((re) => re.test(e.rel)));
  // Lo que git excluye (un `.advisors/` que dejó una corrida, un resto local) nunca se publica: el exportador copia desde
  // git. Lo versionado nunca sale por acá (check-ignore no nombra lo que está en el índice). Si git no contesta, se
  // revisa todo: sin respuesta, la prueba queda más estricta, no más floja.
  const r = spawnSync('git', ['-C', repo, 'check-ignore', '--stdin'], { input: quedan.map((e) => e.rel).join('\n'), encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) return quedan;
  const excluidos = new Set(r.stdout.split('\n').filter(Boolean));
  return quedan.filter((e) => !excluidos.has(e.rel));
}
function caminar(dir, { profundidad = Infinity } = {}, nivel = 0) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (nivel < profundidad - 1 || profundidad === Infinity) out.push(...caminar(p, { profundidad }, nivel + 1)); continue; }
    if (e.isFile() && (EXTENSIONES.test(e.name) || !path.extname(e.name))) out.push(p);
  }
  return out;
}
function barrer(archivos, base) {
  const hallazgos = [];
  for (const { rel, abs } of archivos) {
    let texto;
    try { texto = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
    if (texto.includes('\u0000')) continue;                    // binario
    const excepcion = EXCEPCIONES.find((x) => x.archivo === rel);
    const lineas = texto.split('\n');
    for (let i = 0; i < lineas.length; i++) {
      for (const p of PATRONES) {
        if (!p.re.test(lineas[i])) continue;
        if (excepcion && (!excepcion.patron || excepcion.patron.test(lineas[i]))) continue;
        hallazgos.push(`${base}:${rel}:${i + 1} [${p.nombre}] ${lineas[i].trim().slice(0, 110)}`);
      }
    }
  }
  return hallazgos;
}

test('T8 Nucleo_SinRutasNiServiciosFijos — el arnés: cero fuera de la lista de excepciones', () => {
  assert.notEqual(PRIVATE.state, 'incomplete', 'la lista privada está y no trae la organización o el chat (o no se deja leer): no pude mirar');
  if (PRIVATE.state === 'absent') console.log('  ℹ NO MEDIDO — sin la lista privada (la copia pública) no hay organización ni chat del equipo que buscar; las rutas se miran igual.');
  const archivos = archivosDelArnes();
  assert.ok(archivos.length > 100, `el alcance tiene que ser el código ejecutable entero, no una muestra (${archivos.length} archivos)`);
  const h = barrer(archivos, 'arnes');
  assert.deepEqual(h, [], `rutas o servicios fijos en el núcleo (${h.length}):\n  ${h.join('\n  ')}`);
});

test('T8 — agent-skills: cero fuera de la lista de excepciones (NO MEDIDO si el árbol no está)', (t) => {
  const repo = resolveSkillsDirs().repo;
  if (!fs.existsSync(path.join(repo, 'skills', 'tycon-pipeline'))) {
    console.log(`  ℹ NO MEDIDO — agent-skills no está en ${repo} (TYCON_SKILLS_DIR o ~/.claude/agent-skills). No se juzga acá.`);
    t.skip('agent-skills ausente: no medido');
    return;
  }
  const archivos = archivosDeAgentSkills(repo);
  assert.ok(archivos.length > 50, `el alcance de agent-skills tiene que cubrir skills, agentes, packs y .githooks (${archivos.length} archivos)`);
  const h = barrer(archivos, 'agent-skills');
  assert.deepEqual(h, [], `rutas o servicios fijos en agent-skills (${h.length}):\n  ${h.join('\n  ')}`);
});

// La organización y el chat no se escriben en este archivo (sale en la copia pública): salen de la lista privada.
test('T8 PrivatePatterns_FromThePrivateList — de una lista de laboratorio salen los dos patrones; sin lista, ninguno; con una lista que no los trae, falla', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhp-private-'));
  const lista = path.join(dir, 'denylist.json');
  fs.writeFileSync(lista, JSON.stringify({ terminos: [
    { patron: 'dev.azure.com/acme-org', categoria: 'host-interno' },
    { patron: 'acme-org.visualstudio.com', categoria: 'host-interno' },
    { patron: 'srv.acme.test', categoria: 'host-interno' },
    { patron: '5550001111', categoria: 'persona' },
    { patron: 'Fulano', categoria: 'persona', palabra: true },
  ] }));
  const con = privatePatterns(lista);
  assert.equal(con.state, 'ok');
  assert.deepEqual(con.patterns.map((x) => x.nombre), ['organización de Azure DevOps', 'chat_id de una persona']);
  assert.ok(con.patterns[0].re.test('git clone https://DEV.azure.com/acme-org/x'), 'la organización, sin distinguir caja');
  assert.ok(con.patterns[0].re.test('https://acme-org.visualstudio.com/x'));
  assert.ok(!con.patterns[0].re.test('https://dev.azure.com/otra/x') && !con.patterns[0].re.test('srv.acme.test'), 'sólo la organización: otro host no es de este patrón');
  assert.ok(con.patterns[1].re.test('chat_id=5550001111') && !con.patterns[1].re.test('Fulano'), 'sólo el número');
  // el punto del término es un punto, no «cualquier carácter»
  assert.ok(!con.patterns[0].re.test('acme-orgXvisualstudioXcom'));
  const sin = privatePatterns(path.join(dir, 'no-existe.json'));
  assert.deepEqual(sin, { state: 'absent', patterns: [] }, 'sin la lista (la copia pública) no hay nada del equipo que buscar');
  fs.writeFileSync(lista, JSON.stringify({ terminos: [{ patron: 'Fulano', categoria: 'persona' }] }));
  assert.equal(privatePatterns(lista).state, 'incomplete', 'una lista que no trae la organización o el chat no es «nada que buscar»');
  fs.writeFileSync(lista, '{ roto');
  assert.equal(privatePatterns(lista).state, 'incomplete', 'una lista ilegible tampoco');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T8 — este archivo no trae la organización ni el chat del equipo, ni enteros ni partidos', (t) => {
  const priv = privatePatterns();
  if (priv.state === 'absent') { t.skip('sin la lista privada (la copia pública): no hay organización ni chat del equipo que buscar'); return; }
  assert.equal(priv.state, 'ok', 'la lista privada está y no trae la organización o el chat: no se puede dar por mirado');
  // sin comillas, signos de suma, comas, barras invertidas ni espacios: un valor partido en literales vuelve a quedar entero
  const propio = fs.readFileSync(__filename, 'utf8').replace(/['"`+,\\\s\[\]]/g, '');
  const sinEscapes = (re) => new RegExp(re.source.replace(/\\/g, ''), re.flags);
  for (const x of priv.patterns) assert.ok(!sinEscapes(x.re).test(propio), `este archivo trae escrito lo que busca «${x.nombre}»`);
});

// ── profile-equivalence.js: piezas que podrían medir mal ─────────────────────────────────────────
const EQUIV = require(path.join(RAIZ, 'scripts', 'publishing', 'profile-equivalence.js'));

test('T11 Equivalencia_HooksPorNombre — la clave canónica de settings no cuenta como hook, y dos listas vacías no son «iguales»', () => {
  const p = EQUIV.parsearHooks([
    "  + settings (matcher='*') → settings:cleanupPeriodDays  [clave canónica del arnés]",
    '  + PreToolUse|Bash|@tcg:x.js  [x]',
    '  + Stop|@tcg:y.js  [y]',
    '  otra línea del reporte',
  ].join('\n'));
  assert.deepEqual(p.hooks, ['PreToolUse|Bash|@tcg:x.js', 'Stop|@tcg:y.js']);
  assert.deepEqual(p.settings, ["settings (matcher='*') → settings:cleanupPeriodDays"]);
  const c = EQUIV.compararHooks({ nombres: [] }, { nombres: [] });
  assert.equal(c.fallos.length, 2, '«no pude mirar» no es «coincide»: las dos listas vacías son dos mediciones fallidas');
  const d = EQUIV.compararHooks({ nombres: ['a', 'b'] }, { nombres: ['b', 'c'] });
  assert.deepEqual([d.faltan, d.sobran, d.fallos], [['a'], ['c'], []]);
});

test('T11 Equivalencia_Integraciones — el estado de clockify/engram/nightly sale de los hooks del reporte --check (sonda mecánica), no de una tabla: mismos hooks = igual; sin clocki en el nuevo = apagada', () => {
  const base = [
    'UserPromptSubmit|clocki/scripts/on-prompt.js', 'PostToolUse|clocki/scripts/touch-activity.js',
    'SessionStart|@tcg:dashboard-notice.js', 'SessionStart|@tcg:dependencies-notice.js', 'SessionStart|@tcg:retro-staleness-notice.js',
    'PreToolUse|Bash|@tcg:engram-pre-commit.sh', 'SessionStart|@tcg:engram-drift-notice.js', 'Stop|@tcg:response-style-meter.js',
  ];
  assert.equal(EQUIV.estadoPorHooks(base, 'clockify'), 'prendida');
  assert.equal(EQUIV.estadoPorHooks(base, 'engram'), 'prendida');
  assert.equal(EQUIV.estadoPorHooks(base, 'nightly'), 'prendida');
  const sinClocki = base.filter((h) => !h.includes('clocki'));
  assert.equal(EQUIV.estadoPorHooks(sinClocki, 'clockify'), 'apagada');
  assert.equal(EQUIV.estadoPorHooks(base.filter((h) => !h.includes('dashboard')), 'nightly'), 'parcial (2/3)', 'un hook de tres no es «prendida» ni «apagada»: se dice');
  assert.throws(() => EQUIV.estadoPorHooks(base, 'jira'), /jira/);
  // el juicio de los ocho: con hooks iguales y un `explicar` con el perfil, todo da igual; un hook que falta en el nuevo es ❌
  const conf = { integraciones: { ado: 'prendida (por ado.org, perfil)', clockify: 'prendida (perfil)', engram: 'prendida (perfil)', codegraph: 'apagada (apagado)', mailbox: 'prendida (perfil; llave presente)', codex: 'detect (perfil)', nightly: 'prendida (perfil)', telegram: 'prendida (chat por plugin)' } };
  const igual = EQUIV.compararIntegraciones({ hooksBase: base, hooksNuevo: base, conf, orgBase: ['https://dev.azure.com/x'], chatBase: '123', llaveBase: true, codexBase: 'detect', codegraphBase: 'apagada', codegraphNuevo: 'apagada' });
  assert.equal(igual.length, 8);
  assert.ok(igual.every((i) => i.igual === true), `los ocho iguales: ${JSON.stringify(igual.filter((i) => !i.igual))}`);
  const distinto = EQUIV.compararIntegraciones({ hooksBase: base, hooksNuevo: sinClocki, conf, orgBase: ['https://dev.azure.com/x'], chatBase: '123', llaveBase: true, codexBase: 'detect', codegraphBase: 'apagada', codegraphNuevo: 'apagada' });
  const clock = distinto.find((i) => i.llave === 'clockify');
  assert.equal(clock.igual, false);
  assert.deepEqual([clock.viejo, clock.nuevo], ['prendida', 'apagada']);
});

test('T11 Equivalencia_ChatEnmascarado — el informe no escribe el chat, pero un chat DISTINTO entre base y nuevo sale rojo (la igualdad se decide sobre el valor real)', () => {
  const { chatEnmascarado } = EQUIV;
  assert.deepEqual(chatEnmascarado('111', '111'), ['chat presente (enmascarado)', 'chat presente (enmascarado)'], 'mismo chat: iguales');
  const [v, n] = chatEnmascarado('111', '222');
  assert.notEqual(v, n, 'chat distinto: los dos textos difieren (antes eran el mismo texto y el informe daba verde)');
  assert.ok(!/111|222/.test(v + n), 'ningún dígito del chat en el texto');
  assert.deepEqual(chatEnmascarado(null, '222'), [null, 'chat presente (enmascarado)'], 'sin chat en la base: distinto');
  assert.deepEqual(chatEnmascarado('111', null), ['chat presente (enmascarado)', null], 'sin chat en el nuevo: distinto');
  assert.deepEqual(chatEnmascarado(null, null), [null, null], 'sin chat en los dos: iguales');
});

test('T11 Equivalencia_Procedencia — con el árbol sin commitear el informe lo dice (nuevo ≠ base aunque HEAD sea el mismo sha); los HOMEs de la medición no lanzan el barrido de métricas', () => {
  const repo = tmp('rutas-procedencia-');
  spawnSync('git', ['-C', repo, 'init', '-q']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  spawnSync('git', ['-C', repo, 'add', 'a.txt']);
  spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  const limpio = EQUIV.procedenciaDe(repo);
  assert.match(limpio.shaNuevo, /^[0-9a-f]{40}$/, 'árbol limpio: el sha a secas');
  assert.equal(limpio.rutasSucias, 0);
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b');   // sin `git add`: lo no versionado también cuenta
  const sucio = EQUIV.procedenciaDe(repo);
  assert.equal(sucio.shaHead, limpio.shaHead);
  assert.match(sucio.shaNuevo, /sin commitear \(1 rutas\)/);
  assert.equal(EQUIV.SIN_EFECTOS.TYCON_STAGE_METRICS, '0', 'el barrido de métricas de etapa de fondo no mira --check: queda apagado');
});

// La copia pública es el árbol sin el perfil del equipo (no viaja). Una excepción declarada `noViaja` es de un archivo que
// el exportador no publica: en la copia no está, y ahí no es una excepción huérfana (si lo fuera, la validación
// de un pedido del público la leería como un rojo nuevo en cada corrida). En el repo del equipo tiene que estar, como todos.
/** Las excepciones de `list` cuyo archivo no está en el árbol `root` (las de `skills/`, en `skillsRoot`): las huérfanas. */
function orphanExceptions(list, root, skillsRoot) {
  const publicCopy = !fs.existsSync(path.join(root, 'perfil-equipo.json'));
  const out = [];
  for (const x of list) {
    const abs = x.archivo.startsWith('skills/') ? path.join(skillsRoot, x.archivo) : path.join(root, x.archivo);
    if (x.archivo.startsWith('skills/') && !fs.existsSync(path.join(skillsRoot, 'skills', 'tycon-pipeline'))) continue;
    // los papeles de scripts/publishing/public-files/ viajan a la RAÍZ de la copia pública (ahí la plantilla no está):
    // la excepción vale si el archivo está en cualquiera de los dos lugares (export-real T23)
    const enDestino = x.archivo.startsWith('scripts/publishing/public-files/') && fs.existsSync(path.join(root, x.archivo.slice('scripts/publishing/public-files/'.length)));
    if (fs.existsSync(abs) || enDestino) continue;
    if (x.noViaja && publicCopy) continue;
    out.push(x.archivo);
  }
  return out;
}

test('T8 — las excepciones existen y cada una dice por qué (una excepción huérfana es un agujero)', () => {
  for (const x of EXCEPCIONES) assert.ok(x.motivo && x.motivo.length > 20, `${x.archivo}: sin motivo`);
  assert.deepStrictEqual(orphanExceptions(EXCEPCIONES, RAIZ, resolveSkillsDirs().repo), [], 'la excepción apunta a un archivo que no existe');
});

test('T8b — sólo la copia pública perdona el archivo que falta, y sólo a la excepción declarada `noViaja`', () => {
  // «es la copia» lo dice el perfil del equipo, que no viaja;
  // no un archivo que falta. Si se reconociera por la lista privada ausente, un repo del equipo que la perdiera daría verde.
  // Dos árboles de juguete sin el archivo de la excepción: con el perfil es huérfana; sin él, sólo si no se declaró.
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'excepciones-'));
  try {
    const team = path.join(lab, 'equipo');
    const copy = path.join(lab, 'copia');
    for (const d of [team, copy]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(team, 'perfil-equipo.json'), '{}');
    const list = [{ archivo: 'datos/privado.json', noViaja: true }, { archivo: 'datos/comun.json' }];
    assert.deepStrictEqual(orphanExceptions(list, team, team), ['datos/privado.json', 'datos/comun.json'], 'en el repo del equipo el archivo tiene que estar, declarado o no');
    assert.deepStrictEqual(orphanExceptions(list, copy, copy), ['datos/comun.json'], 'en la copia sólo se perdona la declarada `noViaja`');
    fs.mkdirSync(path.join(team, 'datos'));
    for (const f of ['privado.json', 'comun.json']) fs.writeFileSync(path.join(team, 'datos', f), '{}');
    assert.deepStrictEqual(orphanExceptions(list, team, team), [], 'con los archivos, ninguna huérfana');
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
  const declared = EXCEPCIONES.filter((x) => x.noViaja).map((x) => x.archivo);
  assert.deepStrictEqual(declared, ['scripts/publishing/public-repos.json'], 'cada `noViaja` nueva se suma acá a conciencia');
});
