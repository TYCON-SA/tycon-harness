'use strict';
/**
 * npx-probe.js — el instalador del paquete de npm en un Windows (story 8.40, tanda A · AC 5 y 34 · T34; escenario `npx`
 * del pipeline 182).
 *
 * El paquete (`scripts/setup/npm/`) se arma con `npm pack` (con LICENSE copiado, como el workflow que publica) y se corre
 * con `npx --yes --package <tgz> tycon-harness --profile minimal --integrations none --packs none --yes` contra el
 * «GitHub» de juguete (scripts/tests/fixtures/toy-release-server.js, sobre el remoto del ensayo) en una carpeta de usuario
 * de juguete. Mide:
 *   1. que instala: estado `release`, `~/.tycon/harness` con la versión publicada, `doctor --json` sin rojos;
 *   2. que con un PATH sin pwsh sale 1 sin bajar nada, nombrando PowerShell 7 y `winget install Microsoft.PowerShell`.
 * npm y npx corren con ESTE Node por su programa (`npm-cli.js` / `npx-cli.js` al lado del ejecutable), sin pasar por un
 * `.cmd`; la caché de npm vive en el laboratorio (`npm_config_cache`: en Windows la de fábrica está en %LocalAppData%,
 * fuera de la carpeta de usuario de juguete, y un .tgz rearmado con la misma ruta podría salir de una caché vieja).
 * Fuera de Windows corre igual (modo laboratorio) y lo dice: lo que importa medir de Windows es el punto 2 y el `.cmd`.
 *
 * Con `--from registry` (escenario `npx-published`, story 8.40 · AC 40 · T47) mide el paquete PUBLICADO: `npx --yes
 * @tyconsa/harness@latest` del registro de npm real contra el GitHub real, en otra carpeta de usuario de juguete y sin
 * ninguna variable del GitHub de juguete. Mide que instala (lo mismo que el punto 1) y que la misma línea, corrida otra
 * vez sobre esa carpeta, dice «está al día. No bajé nada» sin tocar el árbol instalado (AC 35). Lo que no depende del
 * paquete no se disfraza: sin red, el registro caído o el límite de GitHub salen «no medido» con su motivo, y una punta de
 * `main` que se movió entre las dos corridas también (el «al día» no se pudo comparar). Nunca verde sin medir.
 *
 * Uso: node scripts/tests/windows/npx-probe.js --lab <laboratorio> --out <carpeta del reporte> [--from pack|registry]
 *      [--allow-temp]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lab.js');
const T = require('./team-lab.js');

const NAME = 'npx';
// el escenario del paquete publicado (AC 40): la misma sonda, con `--from registry`
const NAME_PUBLISHED = 'npx-published';
const PACKAGE = '@tyconsa/harness';
const FROM = Object.freeze(['pack', 'registry']);
// midiendo lo publicado no llega ninguna variable del GitHub de juguete (todas las TYCON_RELEASE_*), ni las que mandan el
// arnés a otra casa o eligen el perfil por su cuenta: con una de ésas, la medición no sería la de una máquina nueva
const TOY_GITHUB_PREFIX = 'TYCON_RELEASE_';
const NOT_OURS = Object.freeze(['TYCON_HOME', 'TYCON_GUIDES_DIR', 'TYCON_SKILLS_DIR', 'TYCON_INSTALL_PROFILE', 'TYCON_PROFILE']);
// lo que no depende del paquete: sin red, el registro caído, un proxy o un certificado de la máquina, el límite o una
// caída de GitHub, un tope vencido. Son los textos de los DOS programas que corre la línea —el instalador del paquete
// (scripts/setup/npm/index.js) y el `harness.js install` del árbol bajado (release.js, con http-get.js)—, que salen por
// la misma salida, y los códigos de npm. Una falla así es «no medido», no «rompe»
const NOT_THE_PACKAGE = Object.freeze([
  /sin red\b/,                                     // «sin red: no pude llegar/hablar…», «… no contestó dentro del tope», «sin red o sin respuesta»
  /sin respuesta: \S+ no contestó en \d+ s/,       // el tope de una consulta del instalador
  /proxy sin respuesta|el proxy \S+ no contestó|no pude hablar con el proxy|contestó \d+ al túnel/,
  /no pude verificar el certificado/,              // la CA de la organización (un proxy con su propio certificado)
  /se acabó el tiempo/,                            // el tope entero de la bajada
  /limita las consultas/,                          // el límite de GitHub
  /contestó (?:429|5\d\d)\b/,                      // GitHub, codeload, la ref o el commit con 429 o 5xx
  /npm (?:ERR!|error) code (?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|ERR_SOCKET_TIMEOUT|E429|E5\d\d)\b/,
  /npm (?:ERR!|error) network /,
]);
// la línea que explica una falla: la última de los dos programas, más las de error de npm (una nota de antes no cuenta)
const OWN_LINE = /^(?:tycon-harness|harness\.js [a-z-]+): /;
const NPM_LINE = /^npm (?:ERR!|error) /;
const VIEW_TIMEOUT_MS = 2 * 60 * 1000;
const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..', '..');
const SERVER = path.join(HERE, '..', 'fixtures', 'toy-release-server.js');
const CMD_TIMEOUT_MS = 10 * 60 * 1000;
const say = (s) => process.stdout.write(`${s}\n`);
const lastLines = (s, n = 3) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');
const wait = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* nada */ } };
const LAB_NO_HOOKS = path.join(os.tmpdir(), 'tycon-lab-no-git-hooks');
// commits con fecha fija y sin el mantenimiento automático de git: la versión de juguete no depende del reloj
function git(dir, args, env) {
  const e = Object.assign({}, env, { GIT_AUTHOR_DATE: '2030-03-01T00:00:00Z', GIT_COMMITTER_DATE: '2030-03-01T00:00:00Z' });
  return L.run('git', ['-C', dir, '-c', 'user.name=Lab', '-c', 'user.email=lab@example.com', '-c', `core.hooksPath=${LAB_NO_HOOKS}`, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { env: e, timeoutMs: 5 * 60 * 1000 });
}

/**
 * El programa de npm o de npx que trae ESTE Node: al lado del ejecutable (Windows), en lib/node_modules (el comprimido
 * de nodejs.org y nvm) o en libexec/lib/node_modules (Homebrew). Nunca el de otro Node del PATH.
 */
function npmProgram(which, { execPath = process.execPath } = {}) {
  const dir = path.dirname(execPath);
  for (const base of [path.join(dir, 'node_modules', 'npm', 'bin'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin'), path.join(dir, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin')]) {
    const f = path.join(base, `${which}-cli.js`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** ¿Algún texto de la red, el registro o GitHub en estas líneas? */
const notThePackage = (text) => NOT_THE_PACKAGE.some((re) => re.test(String(text || '')));

/**
 * Una corrida que falló: `not-measured` si la causa no es el paquete (la red, el registro, GitHub, un tope), mirando la
 * línea que explica la falla; si no, `breaks`. `timedOut`: la cortó el tope de la sonda (no se sabe de quién es).
 */
function installFailureKind(out, { timedOut = false } = {}) {
  if (timedOut) return 'not-measured';
  const lines = String(out || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const own = lines.filter((l) => OWN_LINE.test(l));
  const explains = [...lines.filter((l) => NPM_LINE.test(l)), ...own.slice(-2)];
  return notThePackage(explains.join('\n')) ? 'not-measured' : 'breaks';
}

/**
 * La segunda corrida sobre la misma carpeta (AC 35): `{ ok }` si dijo «al día» y el árbol no cambió; `{ notMeasured }` si
 * no se pudo comparar por algo que no es el paquete (la red o el registro, la punta que se movió entre las dos); `{ finding }`
 * con lo que dijo, si no.
 */
/** El commit que el estado dice instalado (40 hex), o '' si no lo trae: sin él no se puede comparar la punta (AC 35). */
function installedCommitOf(st) {
  const c = st && Array.isArray(st.sources) && st.sources[0] ? st.sources[0].commit : '';
  return typeof c === 'string' && /^[0-9a-f]{40}$/.test(c) ? c : '';
}

/** El motivo si el programa ni arrancó (npm o npx que no está, una ruta mala) sin que lo cortara el tope; si no, null. */
function didNotStart(r) {
  return r && r.exit === null && r.error && !r.timed_out ? String(r.error) : null;
}

function againVerdict({ exit, out, treeSame, timedOut = false, installedCommit = '' }) {
  const said = String(out || '');
  // «no pude mirar si hay una versión nueva (<causa>)»: «no medido» sólo si la causa es la red; un 404, la rama que no
  // está o una respuesta que no es la de git son del paquete o de su estado. Va antes que «hay una versión nueva»
  const look = /no pude mirar si hay una versión nueva \((.*)\): para actualizarlo/.exec(said);
  if (look) return notThePackage(look[1]) || /sin red o sin respuesta|GitHub contestó (?:429|5\d\d)\b/.test(look[1])
    ? { notMeasured: `la segunda corrida no pudo mirar la punta de main: ${look[1]}` }
    : { finding: `la segunda corrida no pudo mirar la punta por algo que no es la red: ${look[1]}` };
  if (exit !== 0 || timedOut) {
    if (installFailureKind(said, { timedOut }) === 'not-measured') return { notMeasured: `la segunda corrida no llegó al registro o a GitHub: ${lastLines(said, 2) || 'sin salida, cortada por el tope'}` };
    return { finding: `la segunda corrida salió ${exit} y no dijo «al día»: ${lastLines(said, 3)}` };
  }
  const fresh = /hay una versión nueva \(([0-9a-f]{7,40})\)/.exec(said);
  // la «nueva» es el commit que quedó instalado: no se movió nada, la comparación del paquete está mal (AC 35)
  if (fresh && installedCommit && installedCommit.startsWith(fresh[1])) return { finding: `la segunda corrida dice que hay una versión nueva (${fresh[1]}), pero es el mismo commit que quedó instalado` };
  if (/hay una versión nueva/.test(said)) return { notMeasured: 'la punta de main del arnés se movió entre las dos corridas: el «al día» no se pudo comparar (volvé a encolar)' };
  if (/está al día\. No bajé nada/.test(said)) return treeSame ? { ok: true } : { finding: 'dijo «al día», pero el árbol instalado cambió entre las dos corridas' };
  return { finding: `la segunda corrida salió ${exit} y no dijo «al día»: ${lastLines(said, 3)}` };
}

/** El entorno de la medición de lo publicado: la carpeta de juguete, la caché de npm en el laboratorio, sin el GitHub de juguete. */
function registryEnv(home, { lab, base = process.env, platform = process.platform } = {}) {
  const env = T.rehearsalEnv(home, { base, platform, extra: {
    TYCON_UPDATE_APPLY: 'auto', TYCON_CLAUDE: '1', TYCON_CODEX: '0', TYCON_BENCH_DAILY: '0', TYCON_STAGE_METRICS: '0', TYCON_THIRD_PARTY: '0',
    TYCON_SETTINGS_PATH: path.join(home, '.claude', 'settings.json'), CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'),
    CODEX_HOME: path.join(home, '.codex'), TYCON_GIT_HOOKS_DIR: path.join(home, '.git-hooks'),
    npm_config_cache: path.join(lab, NAME_PUBLISHED, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
  } });
  // en Windows los nombres de las variables no distinguen mayúsculas: se borra cualquier forma
  for (const k of Object.keys(env)) { const K = k.toUpperCase(); if (K.startsWith(TOY_GITHUB_PREFIX) || NOT_OURS.includes(K)) delete env[k]; }
  return env;
}

const readHarnessState = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json'), 'utf8')); } catch (_) { return null; } };

/** `doctor --json` del árbol instalado, leído entero (como no-clone-probe.js: con un tope chico su JSON llega cortado). */
function doctorCheck(harnessJs, env, rec, id) {
  const doc = L.run(process.execPath, [harnessJs, 'doctor', '--json'], { env, timeoutMs: CMD_TIMEOUT_MS, cap: 400000 });
  let parsed = null; try { parsed = JSON.parse(doc.stdout); } catch (_) { /* ilegible */ }
  const fails = parsed ? parsed.fail : null;
  rec.fact('doctor', { exit: doc.exit, fails });
  if (doc.exit !== 0 || !Array.isArray(fails) || fails.length) rec.finding(id, 'doctor', `doctor --json salió ${doc.exit}: ${JSON.stringify(fails).slice(0, 400)}`, 'W8', { severity: 'loses-control' });
  return parsed;
}

/** null si el doctor dice el perfil pedido y elegido; si no, qué quedó (story 8.40, pedido 2: `--profile` se perdía). */
function profileProblem(doctor, wanted) {
  const p = doctor && doctor.profile;
  if (!p || typeof p.value !== 'string') return 'el doctor no dice el perfil de la instalación';
  if (p.value !== wanted || !p.chosen) return `se pidió ${wanted} y quedó ${p.value} (${p.origin || '¿?'}, ${p.chosen ? 'elegido' : 'sin elegir'})`;
  // lo pedido con --profile se escribe en el archivo de la máquina: elegido por otro lado no prueba que se guardó
  if (p.origin !== 'maquina') return `quedó ${wanted}, pero no lo eligió la máquina (${p.origin || '¿?'}): --profile no consta escrito`;
  return null;
}

/** Lo que tiene que quedar igual si la segunda corrida no bajó nada: el estado y el `version.json` del árbol, con su fecha. */
function treePrint(home) {
  const read = (f) => { try { return `${fs.statSync(f).mtimeMs}:${fs.readFileSync(f, 'utf8')}`; } catch (_) { return null; } };
  return JSON.stringify([read(path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json')), read(path.join(home, '.tycon', 'harness', 'version.json'))]);
}

function measure(opts) {
  return opts.from === 'registry' ? measureRegistry(opts) : measurePack(opts);
}

/** El paquete publicado (AC 40 · T47): del registro y el GitHub reales, instala y la segunda corrida dice «al día». */
function measureRegistry({ lab, platform = process.platform, baseEnv = process.env, allowTemp = false, rec }) {
  const npm = npmProgram('npm'); const npx = npmProgram('npx');
  if (!npm || !npx) return { status: L.STATUS.notMeasured, reason: `este Node (${process.execPath}) no trae npm/npx a su lado` };
  const base = path.join(lab, NAME_PUBLISHED);
  const home = path.join(base, 'users', 'lab-npx-published');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
  if (problem) return { status: L.STATUS.error, reason: problem };
  const env = registryEnv(home, { lab, base: baseEnv, platform });
  rec.fact('home', home);
  rec.fact('lab_mode', !L.isWin(platform));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '');

  // 0 · qué está publicado: sin respuesta del registro no hay nada que medir
  const view = L.run(process.execPath, [npm, 'view', `${PACKAGE}@latest`, 'version'], { env, cwd: base, timeoutMs: VIEW_TIMEOUT_MS });
  const published = String(view.stdout || '').trim().split('\n').pop().trim();
  rec.fact('published', { exit: view.exit, version: published || null, out: lastLines(view.stderr, 2) });
  // npm que ni arrancó no dice nada del paquete: es la sonda la que no pudo medir
  if (didNotStart(view)) return { status: L.STATUS.error, reason: `no pude correr npm view (${didNotStart(view)}): ${npm}` };
  if (view.exit !== 0 || !/^\d+\.\d+\.\d+/.test(published)) {
    const said = `${view.stdout}\n${view.stderr}`;
    // el registro que no contesta es «no medido»; el que contesta que el paquete no está (E404) es un hallazgo
    if (installFailureKind(said, { timedOut: view.timed_out }) === 'not-measured' || (view.exit === 0 && !published)) return { status: L.STATUS.notMeasured, reason: `no medido: el registro de npm no contestó qué versión de ${PACKAGE} está publicada (npm view salió ${view.exit}): ${lastLines(said, 2) || 'sin salida'}` };
    rec.finding('npx-published:not-published', 'registry', `npm view ${PACKAGE}@latest salió ${view.exit}: ${lastLines(said, 2) || 'sin salida'}`, 'W8', { severity: 'breaks' });
    return { status: L.STATUS.measured, reason: null };
  }
  const line = [npx, '--yes', `${PACKAGE}@latest`, '--audience', 'me', '--profile', 'minimal', '--integrations', 'none', '--packs', 'none', '--yes'];
  const npxRun = (label) => {
    const r = L.run(process.execPath, line, { env, cwd: base, timeoutMs: CMD_TIMEOUT_MS });
    rec.fact(label, { exit: r.exit, error: r.error, out: lastLines(`${r.stdout}\n${r.stderr}`, 4), ms: r.ms });
    return r;
  };

  // 1 · instala
  const inst = npxRun('install');
  if (didNotStart(inst)) return { status: L.STATUS.error, reason: `no pude correr npx (${didNotStart(inst)}): ${npx}` };
  const st = readHarnessState(home);
  const kind = st && st.sources && st.sources[0] ? st.sources[0].kind : null;
  const installedCommit = installedCommitOf(st);
  const harnessJs = path.join(home, '.tycon', 'harness', 'scripts', 'setup', 'harness.js');
  rec.fact('after_install', { kind, version: st && st.version ? st.version.number : null, commit: installedCommit || null, harness: fs.existsSync(harnessJs) });
  if (inst.exit !== 0 || kind !== 'release' || !fs.existsSync(harnessJs)) {
    const said = `${inst.stdout}\n${inst.stderr}`;
    if (inst.exit !== 0 && installFailureKind(said, { timedOut: inst.timed_out }) === 'not-measured') return { status: L.STATUS.notMeasured, reason: `no medido: la instalación no llegó al registro o a GitHub${inst.timed_out ? ', o la cortó el tope de la sonda' : ''}: ${lastLines(said, 2) || 'sin salida'}` };
    rec.finding('npx-published:install-fails', 'install', `npx ${PACKAGE}@latest (${published}) salió ${inst.exit} (estado ${kind || 'ninguno'}): ${lastLines(said, 3)}`, 'W8', { severity: 'breaks' });
    return { status: L.STATUS.measured, reason: null };
  }
  // sin el commit en el estado, la segunda corrida no tiene contra qué comparar la punta (AC 35): se dice, no se saltea
  if (!installedCommit) rec.finding('npx-published:state-without-commit', 'install', 'el estado de la versión bajada no trae su commit: la máquina no puede saber si está al día', 'W8', { severity: 'breaks' });
  const doctor = doctorCheck(harnessJs, env, rec, 'npx-published:doctor-red');
  // la línea pide --profile minimal: tiene que quedar elegido (sin el arreglo del pedido 2 quedaba full «sin elegir»)
  if (doctor) {
    rec.fact('profile', doctor.profile || null);
    const pp = profileProblem(doctor, 'minimal');
    if (pp) rec.finding('npx-published:profile-not-kept', 'profile', pp, 'W8', { severity: 'breaks' });
  }

  // 2 · la misma línea otra vez, sobre la misma carpeta: «al día», sin bajar ni tocar el árbol
  const before = treePrint(home);
  const again = npxRun('again');
  if (didNotStart(again)) return { status: L.STATUS.error, reason: `no pude correr npx la segunda vez (${didNotStart(again)}): ${npx}` };
  const v = againVerdict({ exit: again.exit, out: `${again.stdout}\n${again.stderr}`, treeSame: treePrint(home) === before, timedOut: again.timed_out, installedCommit });
  if (v.notMeasured) return { status: L.STATUS.notMeasured, reason: `no medido: ${v.notMeasured}` };
  if (v.finding) rec.finding('npx-published:not-up-to-date', 'again', v.finding, 'W8', { severity: 'breaks' });
  return { status: L.STATUS.measured, reason: null };
}

function measurePack({ lab, platform = process.platform, baseEnv = process.env, allowTemp = false, rec }) {
  const state = T.readState(lab);
  if (!state || !state.remotes || !state.remotes.harness) return { status: L.STATUS.error, reason: `${lab} no trae el estado del ensayo (rehearsal-state.json): corré «rehearse.js init»` };
  const npm = npmProgram('npm'); const npx = npmProgram('npx');
  if (!npm || !npx) return { status: L.STATUS.notMeasured, reason: `este Node (${process.execPath}) no trae npm/npx a su lado` };
  const base = path.join(lab, 'npx');
  const home = path.join(base, 'users', 'lab-npx');
  const author = path.join(base, 'author');
  const serverDir = path.join(base, 'server');
  const pkg = path.join(base, 'pkg');
  for (const d of [home, serverDir, pkg, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
  if (problem) return { status: L.STATUS.error, reason: problem };
  const env0 = T.rehearsalEnv(home, { base: baseEnv, platform });
  rec.fact('home', home);
  rec.fact('lab_mode', !L.isWin(platform));

  // el remoto en el commit de hoy, una versión numerada publicada encima, y el servidor de juguete
  const point = T.pointRemotes(state, 'target', env0);
  if (point) return { status: L.STATUS.error, reason: point };
  const bare = state.remotes.harness.dir;
  const c = git(base, ['clone', '--quiet', bare, author], env0);
  if (c.exit !== 0) return { status: L.STATUS.error, reason: `no pude clonar el remoto del arnés: ${L.firstLine(c.stderr)}` };
  const org = 'example-org', name = 'example-harness';
  fs.mkdirSync(path.join(author, 'scripts', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(author, 'scripts', 'setup', 'public-remotes.json'), `{ "remotes": ["https://github.com/${org}/${name}"] }\n`);
  fs.writeFileSync(path.join(author, 'version.json'), `{ "version": "2030.03.01.1", "source": { "harness": "${'1'.repeat(40)}", "agent_skills": "${'2'.repeat(40)}" } }\n`);
  for (const args of [['add', '-A'], ['commit', '-q', '-m', 'versión 2030.03.01.1'], ['push', '-q', 'origin', 'HEAD:main']]) {
    const r = git(author, args, env0);
    if (r.exit !== 0) return { status: L.STATUS.error, reason: `no pude publicar la versión de juguete (git ${args[0]} salió ${r.exit}): ${L.firstLine(r.stderr)}` };
  }
  const control = path.join(serverDir, 'control.json'); const log = path.join(serverDir, 'requests.log'); const ports = path.join(serverDir, 'ports.env');
  fs.writeFileSync(control, '{ "auth": "none" }\n');
  const server = spawn(process.execPath, [SERVER, '--repo', bare, '--org', org, '--name', name, '--git', L.scanPath('git', { env: env0 })[0] || 'git', '--control', control, '--log', log, '--port-file', ports], { env: env0, stdio: 'ignore', windowsHide: true });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ports); i++) wait(100);
    if (!fs.existsSync(ports)) return { status: L.STATUS.error, reason: 'el servidor de versiones de juguete no arrancó' };
    const p = fs.readFileSync(ports, 'utf8'); const port = (k) => (new RegExp(`^${k}=(.+)$`, 'm').exec(p) || [])[1];
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n');
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '');
    const env = T.rehearsalEnv(home, { base: baseEnv, platform, extra: {
      TYCON_RELEASE_API: port('API'), TYCON_RELEASE_GIT: port('GIT'), TYCON_RELEASE_ARCHIVE: port('CODELOAD'), TYCON_UPDATE_APPLY: 'auto',
      TYCON_CLAUDE: '1', TYCON_CODEX: '0', TYCON_BENCH_DAILY: '0', TYCON_STAGE_METRICS: '0', TYCON_THIRD_PARTY: '0',
      TYCON_SETTINGS_PATH: path.join(home, '.claude', 'settings.json'), CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'),
      CODEX_HOME: path.join(home, '.codex'), TYCON_GIT_HOOKS_DIR: path.join(home, '.git-hooks'),
      npm_config_cache: path.join(base, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
    } });

    // el paquete, armado como lo arma el workflow
    for (const f of ['package.json', 'index.js', 'home-paths.json', 'README.md']) fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', 'npm', f), path.join(pkg, f));
    fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(pkg, 'LICENSE'));
    const packed = L.run(process.execPath, [npm, 'pack', '--silent', '--pack-destination', base], { cwd: pkg, env, timeoutMs: CMD_TIMEOUT_MS });
    const tgz = path.join(base, lastLines(packed.stdout, 1));
    rec.fact('pack', { exit: packed.exit, tgz: path.basename(tgz), out: lastLines(`${packed.stdout}\n${packed.stderr}`, 2) });
    if (packed.exit !== 0 || !fs.existsSync(tgz)) return { status: L.STATUS.error, reason: `npm pack salió ${packed.exit}: ${lastLines(packed.stderr, 2)}` };
    const npxRun = (e, label) => {
      const r = L.run(process.execPath, [npx, '--yes', '--package', tgz, 'tycon-harness', '--repo', `${org}/${name}`, '--profile', 'minimal', '--integrations', 'none', '--packs', 'none', '--yes'], { env: e, cwd: base, timeoutMs: CMD_TIMEOUT_MS });
      rec.fact(label, { exit: r.exit, error: r.error, out: lastLines(`${r.stdout}\n${r.stderr}`, 4), ms: r.ms });
      return r;
    };

    // 1 · instala
    const inst = npxRun(env, 'install');
    const st = readHarnessState(home);
    const kind = st && st.sources && st.sources[0] ? st.sources[0].kind : null;
    const harnessJs = path.join(home, '.tycon', 'harness', 'scripts', 'setup', 'harness.js');
    rec.fact('after_install', { kind, version: st && st.version ? st.version.number : null, harness: fs.existsSync(harnessJs) });
    if (inst.exit !== 0 || kind !== 'release' || !fs.existsSync(harnessJs)) {
      rec.finding('npx:install-fails', 'install', `npx --package <tgz> tycon-harness salió ${inst.exit} (estado ${kind || 'ninguno'}): ${lastLines(`${inst.stdout}\n${inst.stderr}`, 3)}`, 'W8', { severity: 'breaks' });
    } else {
      // la línea pide --profile minimal: con el árbol de la rama tiene que quedar elegido por la máquina (AC 48)
      const doctor = doctorCheck(harnessJs, env, rec, 'npx:doctor-red');
      const pp = doctor ? profileProblem(doctor, 'minimal') : null;
      if (doctor) rec.fact('profile', doctor.profile || null);
      if (pp) rec.finding('npx:profile-not-kept', 'profile', pp, 'W8', { severity: 'breaks' });
    }

    // 2 · sin pwsh: lo nombra con el comando sugerido y no baja nada (sólo en Windows: fuera, pwsh no es requisito)
    if (L.isWin(platform)) {
      const w = T.withoutPwsh(env, platform);
      if (w.problem) rec.note(`sin pwsh: no medido (${w.problem})`);
      else {
        fs.rmSync(path.join(home, '.tycon'), { recursive: true, force: true });
        fs.rmSync(path.join(home, '.claude', '.tycon-pipeline'), { recursive: true, force: true });
        const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').length : 0;
        const r = npxRun(w.env, 'without_pwsh');
        const said = `${r.stdout}\n${r.stderr}`;
        const after = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').length : 0;
        if (r.exit !== 1 || !/pwsh/.test(said) || !/winget install Microsoft\.PowerShell/.test(said)) rec.finding('npx:pwsh-missing-not-named', 'requisites', `sin pwsh salió ${r.exit} sin nombrar PowerShell 7 y su comando: ${lastLines(said, 3)}`, 'W8', { severity: 'loses-control' });
        if (after !== before) rec.finding('npx:pwsh-missing-downloaded', 'requisites', `sin pwsh igual le pidió ${after - before} cosa(s) al GitHub de juguete: tenía que salir antes de bajar`, 'W8', { severity: 'noise' });
      }
    } else rec.note('fuera de Windows el paso sin pwsh no se mide (pwsh no es requisito acá)');
    return { status: L.STATUS.measured, reason: null };
  } finally { try { server.kill(); } catch (_) { /* ya */ } }
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--from': 'value', '--allow-temp': 'flag' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`npx-probe.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const from = args.from || 'pack';
  if (!FROM.includes(from)) { process.stderr.write(`npx-probe.js: --from es pack o registry: «${from}»\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`npx-probe.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const name = from === 'registry' ? NAME_PUBLISHED : NAME;
  const rec = L.recorder(name, path.resolve(args.out));
  let result;
  try { result = measure({ lab, from, allowTemp: Boolean(args['allow-temp']), rec }); } catch (e) {
    result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
  }
  rec.finish(result.status, result.reason);
  say(`${name}: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, NAME_PUBLISHED, measure, npmProgram, installFailureKind, againVerdict, didNotStart, installedCommitOf, registryEnv, profileProblem };
