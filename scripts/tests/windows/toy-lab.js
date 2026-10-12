'use strict';
/**
 * toy-lab.js — las piezas del laboratorio de juguete que comparten los ensayos que siguen la página pública de Windows
 * (`guided-install.js` y `guided-update.js`).
 *
 * POR QUÉ EXISTE. Esos ensayos instalan el arnés como lo hace una persona —bajando una versión publicada— pero sin
 * red de verdad y sin ninguna credencial de verdad. Para eso hace falta, cada vez: un «GitHub» y un «Azure DevOps» de
 * juguete sirviendo repos del laboratorio, una versión numerada que se pueda publicar, un repo del equipo de juguete,
 * una carpeta de usuario que represente una máquina con Claude Code, y un ambiente que no traiga nada de quien lanza.
 * Cada pieza tiene una forma de mentir que acá se cierra una sola vez:
 *   · EL AMBIENTE SE ARMA DESDE LIMPIO. `lab.labEnv` copia el ambiente de quien lanza: en la máquina de quien mantiene
 *     el arnés eso enchufaría otra herramienta o escribiría fuera del laboratorio. Antes se borran todas las variables
 *     del arnés y de sus herramientas, y lo que se pone es una lista cerrada, que va entera al reporte.
 *   · EL GIT DEL LABORATORIO USA SU PROPIA CARPETA DE USUARIO. Después del paso de los hooks de git de la página, la
 *     carpeta de la variante tiene una carpeta global de hooks: con ella, publicar una versión de juguete correría los
 *     hooks del arnés sobre los clones del laboratorio.
 *   · LA SESIÓN ESPERA AL TRABAJO QUE SE DESPRENDIÓ, Y SÓLO A ÉL. El arranque del arnés lanza la actualización aparte y
 *     el hook vuelve a los pocos segundos: medir ahí es medir antes de que pase nada. Mientras ese trabajo sigue hay
 *     una marca en la carpeta del estado, con el número de su proceso adentro. Se espera sólo por las marcas NUEVAS de
 *     cada sesión (una vieja puede quedar una hora), se la da por terminada cuando desaparece, cuando a su lado quedó
 *     el resultado o cuando su proceso ya no existe, y siempre con tope.
 *   · LOS PERMISOS DE JUGUETE SE BUSCAN EN LA SALIDA CRUDA. El tapador los saca antes de escribir: buscarlos después
 *     daría siempre «no está».
 *
 * Nunca la carpeta de usuario real: toda carpeta de usuario pasa por `lab.labHomeProblem` en quien llama. Sin dependencias.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const L = require('./lab.js');
const T = require('./team-lab.js');
const C = require('./count-hooks.js');
const F = require('./fire-registered.js');

const HERE = __dirname;
const GITHUB_SERVER = path.join(HERE, '..', 'fixtures', 'toy-release-server.js');
const AZURE_SERVER = path.join(HERE, '..', 'fixtures', 'toy-azure-server.js');
const SETUP = path.join(HERE, '..', '..', 'setup', 'harness');
// la dirección del repo del equipo de juguete (la forma de una de Azure DevOps; la organización es inventada)
const TEAM = Object.freeze({ org: 'acme', project: 'proyecto', name: 'equipo-lab' });
const TEAM_URL = `https://dev.azure.com/${TEAM.org}/${TEAM.project}/_git/${TEAM.name}`;
const CMD_TIMEOUT_MS = 10 * 60 * 1000;
// el tope de UN comando de la página: menor que el del paso entero (20 minutos el del alta), para que un comando
// colgado se corte acá, quede dicho con su nombre, y el paso siga
const PAGE_TIMEOUT_MS = 10 * 60 * 1000;
// con qué se lanza cada comando de la página (va a `lab_changes`: una persona no lo lanza así)
const LAUNCHED_WITH = '-NoProfile -NonInteractive -ExecutionPolicy Bypass, con la salida en UTF-8, desde un archivo .ps1 por comando';
const STARTUP_TIMEOUT_MS = 10 * 60 * 1000;
const HOOK_TIMEOUT_MS = 60 * 1000;
// cuánto de la salida de un hook se guarda en el reporte (los permisos se buscan antes, en la salida entera)
const HOOK_OUTPUT_CAP = 2000;
const PORTS_WAIT_MS = 10 * 1000;
// los dos topes de la espera al trabajo desprendido: por sesión y por variante. Son parámetros de quien llama.
const WAIT_CAP_MS = 180 * 1000;
const VARIANT_WAIT_BUDGET_MS = 600 * 1000;
const MARK_RX = /^startup-result\.(\d+)\.json\.gone$/;
// Lo que el laboratorio le pone al ambiente de una variante, además de la carpeta de usuario y de `lab.SAFE_ENV`.
// Lista cerrada: va entera al reporte.
const ENV_SET = Object.freeze(['TYCON_RELEASE_API', 'TYCON_UPDATE_NETWORK_BUDGET_S', 'TYCON_BENCH_DAILY', 'TYCON_STAGE_METRICS', 'TYCON_NO_UPLOAD_RUNS', 'TYCON_NO_DOWNLOAD_RUNS', 'TYCON_NO_COLLECT_FINDINGS', 'TYCON_PRODUCTION_AUTOINSTALL', 'TYCON_TOOLS_DETECT_PATH', ...Object.keys(T.REHEARSAL_ENV)]);
// Lo que NO se pone nunca: son cosas que una persona no tiene, y con ellas se mediría otra máquina.
const ENV_NEVER = Object.freeze(['TYCON_UPDATE_APPLY', 'TYCON_STARTUP_DETACH', 'TYCON_GIT_HOOKS_DIR', 'TYCON_CLAUDE', 'TYCON_PROFILE']);
// Lo que se borra del ambiente de quien lanza antes de armar el de la variante: lo del arnés y sus herramientas, y las
// variables con que git ubica su configuración (con ellas, el paso de los hooks de git de la página —`git config
// --global`— escribiría en la configuración REAL de quien lanza, y el git del laboratorio leería sus hooks). Y las del
// proxy: el cliente del arnés no exceptúa 127.0.0.1, así que con un proxy configurado en quien lanza los pedidos al
// GitHub de juguete (con su permiso de juguete y el nombre del repo) saldrían hacia el proxy real, y el ensayo le
// echaría la culpa al producto. El laboratorio no le habla a la red de verdad: no necesita ninguno.
const INHERITED = Object.freeze([/^TYCON_/i, /^CODEX_HOME$/i, /^CLAUDE_MD_PATH$/i, /^CLAUDE_CONFIG_DIR$/i,
  /^GIT_CONFIG_(GLOBAL|SYSTEM|NOSYSTEM|COUNT|PARAMETERS)$/i, /^GIT_CONFIG_(KEY|VALUE)_\d+$/i, /^XDG_CONFIG_HOME$/i,
  /^(HTTPS?|ALL|NO)_PROXY$/i]);
const LOCK = require('../../setup/harness/lock.js');

const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms)); } catch (_) { /* nada */ } };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const lastLines = (s, n = 3) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');
const sha = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (_) { return null; } };
const kill = (child) => { if (child) { try { child.kill(); } catch (_) { /* ya no está */ } } };

/** Un permiso de juguete, armado acá cada vez (nunca escrito en un archivo ni leído del ambiente de quien lanza). */
const toyToken = (kind) => `toy-${kind}-${crypto.randomBytes(8).toString('hex')}`;

// ── el ambiente ──────────────────────────────────────────────────────────────────────────────────────────────────

/** El ambiente de quien lanza sin ninguna variable del arnés ni de sus herramientas: `{ env, removed }`. */
function cleanBase(base = process.env) {
  const env = {};
  const removed = [];
  for (const [k, v] of Object.entries(base)) {
    if (INHERITED.some((rx) => rx.test(k))) removed.push(k); else env[k] = v;
  }
  return { env, removed: removed.sort() };
}

/**
 * El ambiente de la carpeta de usuario de una variante, armado desde limpio: `{ env, lab_changes }`. `api` es la
 * dirección del GitHub de juguete; `detectPath`, una carpeta sin herramientas (que no se enchufe la de quien prueba).
 * El permiso de GitHub NO va acá: entra sólo en los pasos que lo usan (`withToken`). El Azure de juguete, tampoco:
 * entra cuando se suma la capa del equipo (`teamEnv`).
 */
function variantEnv(home, { base = process.env, platform = process.platform, api, detectPath } = {}) {
  const cleaned = cleanBase(base);
  const set = Object.assign({
    TYCON_RELEASE_API: String(api),
    TYCON_UPDATE_NETWORK_BUDGET_S: '60',
    TYCON_BENCH_DAILY: '0',
    TYCON_STAGE_METRICS: '0',
    TYCON_NO_UPLOAD_RUNS: '1',
    TYCON_NO_DOWNLOAD_RUNS: '1',
    TYCON_NO_COLLECT_FINDINGS: '1',
    // en una Mac, el aviso del freno de producción ABRE su instalador en una ventana de la máquina real (pide la
    // contraseña): una sesión del laboratorio no abre nada fuera del laboratorio
    TYCON_PRODUCTION_AUTOINSTALL: '0',
    TYCON_TOOLS_DETECT_PATH: String(detectPath || ''),
  }, T.REHEARSAL_ENV);
  const env = L.labEnv(home, { base: cleaned.env, extra: set, platform });
  // «lo borrado» es lo que de verdad dejó de estar: lo que se vuelve a poner acá mismo (con su valor del laboratorio) no cuenta
  const removed = cleaned.removed.filter((k) => !(k in set) && !(k in L.SAFE_ENV));
  return { env, lab_changes: { env_set: set, env_removed: removed, never_set: ENV_NEVER.slice(), always: Object.assign({}, L.SAFE_ENV), launched_with: LAUNCHED_WITH, user_folder: home } };
}
/** El mismo ambiente con el permiso de juguete de GitHub (los pasos que bajan e instalan). */
const withToken = (env, token) => Object.assign({}, env, { TYCON_GITHUB_TOKEN: token });
/** El mismo ambiente con el Azure DevOps de juguete, y el gestor de credenciales de git apagado (decide el permiso guardado). */
const teamEnv = (env, azureApi) => Object.assign({}, env, { TYCON_AZURE_API: String(azureApi), TYCON_AZURE_GIT_CREDENTIAL: '0' });

// ── git, con la carpeta de usuario propia del laboratorio ────────────────────────────────────────────────────────

/** El ambiente con que el laboratorio corre git: su propia carpeta de usuario, nunca la de una variante. */
function gitEnv(lab, { base = process.env, platform = process.platform } = {}) {
  const home = path.join(lab, 'toy', 'git-home');
  fs.mkdirSync(home, { recursive: true });
  return L.labEnv(home, { base: cleanBase(base).env, platform });
}
/** git con identidad propia (el agente no tiene `user.name`) y sin firma. Devuelve lo de `lab.run`. */
function git(dir, args, env) {
  return L.run('git', ['-C', dir, '-c', 'user.name=Lab', '-c', 'user.email=lab@example.com', '-c', 'commit.gpgsign=false', ...args], { env, timeoutMs: 5 * 60 * 1000 });
}

/** El número de la versión de juguete número `k`: siempre mayor que el de lo que se ensaya, sea real o de una copia sellada. */
function nextVersion(current, k) {
  const m = /^(\d{4})\.\d{2}\.\d{2}\.\d+$/.exec(String(current || ''));
  const year = Math.max(2030, m ? Number(m[1]) + 1 : 2030);
  return `${year}.01.01.${k}`;
}

/**
 * Una versión numerada publicada sobre `main` del remoto, desde la copia «autor»: `{ ok, commit }` o `{ ok: false,
 * reason }`. De `version.json` sólo se lee el número: lo demás que traiga se conserva.
 */
function publish({ author, number, env, extra = null }) {
  const file = path.join(author, 'version.json');
  let version = {};
  try { const was = readJson(file); if (was && typeof was === 'object' && !Array.isArray(was)) version = was; } catch (_) { version = {}; }
  version.version = number;
  fs.writeFileSync(file, `${JSON.stringify(version, null, 2)}\n`);
  if (extra) { fs.mkdirSync(path.dirname(path.join(author, extra.rel)), { recursive: true }); fs.writeFileSync(path.join(author, extra.rel), extra.text); }
  else fs.appendFileSync(path.join(author, 'CHANGES'), `${number}\n`);
  for (const args of [['add', '-A'], ['commit', '-q', '-m', `version ${number}`], ['push', '-q', 'origin', 'HEAD:main']]) {
    const r = git(author, args, env);
    if (r.error || r.exit !== 0) return { ok: false, reason: `git ${args[0]} salió ${r.error || r.exit}: ${L.firstLine(r.stderr) || L.firstLine(r.stdout)}` };
  }
  const head = git(author, ['rev-parse', 'HEAD'], env);
  return { ok: true, commit: L.firstLine(head.stdout) };
}

/**
 * Corre un guion con `main` del remoto del laboratorio en el commit que se ensaya, y lo deja ahí al terminar (otro
 * guion comparte ese remoto y espera encontrarlo así). Si no se puede apuntar, no se ensaya.
 */
function onRehearsedCommit(state, env, fn) {
  const before = T.pointRemotes(state, 'target', env);
  if (before) return { status: L.STATUS.error, reason: `no pude ensayar: ${before}` };
  let result;
  let after = null;
  try { result = fn(); } finally { after = T.pointRemotes(state, 'target', env); }
  if (after && result && result.status !== L.STATUS.error) return { status: L.STATUS.error, reason: `no pude ensayar: al terminar no pude dejar el remoto del laboratorio en el commit que se ensaya (${after})` };
  return result;
}

// ── los servidores de juguete ────────────────────────────────────────────────────────────────────────────────────

function startServer({ script, args, portFile, key, env, waitMs = PORTS_WAIT_MS, what }) {
  let child;
  // lo que el servidor diga al caerse queda en un archivo: sin eso, uno que murió al arrancar y uno lento dan lo mismo
  const errFile = `${portFile}.stderr.log`;
  let errFd = null;
  try {
    fs.rmSync(portFile, { force: true });
    errFd = fs.openSync(errFile, 'w');
    child = spawn(process.execPath, [script, ...args, '--port-file', portFile], { env, stdio: ['ignore', 'ignore', errFd], windowsHide: true });
  } catch (e) { return { problem: `${what} no levantó: ${e.code || e.message}` }; } finally { if (errFd !== null) { try { fs.closeSync(errFd); } catch (_) { /* nada */ } } }
  const until = Date.now() + waitMs;
  let url = null;
  while (Date.now() < until) {
    try { const m = new RegExp(`^${key}=(.+)$`, 'm').exec(fs.readFileSync(portFile, 'utf8')); if (m) { url = m[1].trim(); break; } } catch (_) { /* todavía no */ }
    sleep(100);
  }
  if (!url) {
    kill(child);
    // de lo que dijo: el renglón del error (en un volcado de node va arriba, lejos del final) y sus últimas líneas
    let said = '';
    try {
      const text = fs.readFileSync(errFile, 'utf8');
      const cause = text.split('\n').map((l) => l.trim()).find((l) => /^[A-Za-z]*Error\b/.test(l)) || null;
      said = [cause, lastLines(text, 2)].filter(Boolean).join(' | ');
    } catch (_) { said = ''; }
    return { problem: `${what} no dejó su archivo de puertos en ${Math.round(waitMs / 1000)} s (${portFile})${said ? ` — lo que dijo: ${L.clip(said, 400)}` : ' y no dijo nada'}` };
  }
  return { url, stop: () => kill(child) };
}

/** El GitHub de juguete sirviendo un repo desnudo como `org/name`; con `token`, como repo privado. `{ url, stop }` o `{ problem }`. */
function startGitHub({ dir, bare, org, name, gitBin = 'git', env, token = null, waitMs }) {
  fs.mkdirSync(dir, { recursive: true });
  const control = path.join(dir, 'github-control.json');
  fs.writeFileSync(control, `${JSON.stringify({ auth: token ? `token:${token}` : 'none' })}\n`);
  // sin conversión de finales de línea al armar el comprimido, traiga lo que traiga la configuración de git del agente
  const serverEnv = Object.assign({}, env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
  const s = startServer({ script: GITHUB_SERVER, args: ['--repo', bare, '--org', org, '--name', name, '--git', gitBin, '--control', control, '--log', path.join(dir, 'github-requests.log')], portFile: path.join(dir, 'github-ports.env'), key: 'API', env: serverEnv, waitMs, what: 'el GitHub de juguete' });
  return s.problem ? s : Object.assign(s, { log: path.join(dir, 'github-requests.log') });
}

/** El Azure DevOps de juguete sirviendo el repo del equipo, con su permiso. `{ url, stop }` o `{ problem }`. */
function startAzure({ dir, bare, gitBin = 'git', env, pat, waitMs }) {
  fs.mkdirSync(dir, { recursive: true });
  const control = path.join(dir, 'azure-control.json');
  fs.writeFileSync(control, `${JSON.stringify({ pat })}\n`);
  return startServer({ script: AZURE_SERVER, args: ['--repo', bare, '--org', TEAM.org, '--project', TEAM.project, '--name', TEAM.name, '--git', gitBin, '--control', control, '--log', path.join(dir, 'azure-requests.log')], portFile: path.join(dir, 'azure-ports.env'), key: 'AZURE', env, waitMs, what: 'el Azure DevOps de juguete' });
}

/** El repo del equipo de juguete (la capa con su perfil, que manda aplicar sola): `{ bare, commit }` o `{ problem }`. */
function makeTeamRepo({ dir, env }) {
  const work = path.join(dir, 'team-work');
  const bare = path.join(dir, 'team.git');
  try {
    fs.mkdirSync(work, { recursive: true });
    T.writeTeamLayerA2(work);
  } catch (e) { return { problem: `no pude armar la capa del equipo de juguete: ${e.code || e.message}` }; }
  for (const args of [['init', '--quiet', '-b', 'main'], ['add', '-A'], ['commit', '--quiet', '-m', 'team layer (rehearsal)']]) {
    const g = git(work, args, env);
    // (git commit sin nada que commitear sale 1 y lo dice por la salida, no por el canal de errores)
    if (g.error || g.exit !== 0) return { problem: `no pude armar el repo del equipo de juguete (git ${args[0]} salió ${g.error || g.exit}: ${L.firstLine(g.stderr) || L.firstLine(g.stdout) || 'sin decir nada'})` };
  }
  const cloned = git(dir, ['clone', '--quiet', '--bare', work, bare], env);
  if (cloned.error || cloned.exit !== 0) return { problem: `no pude armar el repo del equipo de juguete (git clone --bare salió ${cloned.error || cloned.exit}: ${L.firstLine(cloned.stderr) || L.firstLine(cloned.stdout) || 'sin decir nada'})` };
  return { bare, commit: L.firstLine(git(work, ['rev-parse', 'HEAD'], env).stdout) };
}

// ── la carpeta de usuario ────────────────────────────────────────────────────────────────────────────────────────

/** Una carpeta de usuario que representa una máquina CON Claude Code instalado: sus tres archivos, vacíos. */
function makeHome(home) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '');
  return home;
}

// ── correr ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Un comando de la página, tal cual, desde un archivo y en su propio proceso de PowerShell, con la política de
 * ejecución en Bypass (como `team-lab.runPs`, pero devolviendo la salida entera: ahí se buscan los permisos).
 *
 * Devuelve lo de `lab.run` más `not_found`: los programas que PowerShell NO ENCONTRÓ al correr el comando. Hace falta
 * porque el código de salida no lo dice: un comando que no existe no toca `$LASTEXITCODE` (queda vacío, o con el del
 * programa anterior del mismo renglón), así que el proceso sale 0. El envoltorio los lee de `$Error` y los deja en un
 * archivo al lado; al comando no se le toca una letra.
 */
function runPage({ ps, text, cwd, env, scratch, id, timeoutMs = PAGE_TIMEOUT_MS }) {
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(scratch, `${id}.ps1`);
  const side = path.join(scratch, `${id}.not-found.txt`);
  fs.rmSync(side, { force: true });
  const old = /^powershell(\.exe)?$/i.test(path.basename(String(ps)));
  fs.writeFileSync(file, `${old ? '﻿' : ''}${text}\n`);
  // las rutas van entre comillas simples. PowerShell cierra una cadena también con las comillas tipográficas: una ruta
  // que traiga una rompería el envoltorio, así que no se corre
  if (/[‘-‛]/.test(`${file}${side}`)) throw new Error(`la carpeta de trabajo del laboratorio trae una comilla tipográfica en su ruta (${scratch}): PowerShell la toma por el cierre de una cadena — armá el laboratorio en otra ruta`);
  const quote = (p) => `'${String(p).replace(/'/g, "''")}'`;
  const wrapper = `${L.PWSH_UTF8}$Error.Clear(); . ${quote(file)}; $labExit = $LASTEXITCODE; `
    + `$labMissing = @($Error | Where-Object { $_.FullyQualifiedErrorId -like 'CommandNotFoundException*' } | ForEach-Object { [string]$_.TargetObject }); `
    + `if ($labMissing.Count -gt 0) { [System.IO.File]::WriteAllLines(${quote(side)}, [string[]]$labMissing) }; exit $labExit`;
  const r = L.run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapper], { cwd, env, timeoutMs, cap: 400000 });
  // sin el archivo, no faltó ningún programa; si está y no se deja leer, no se sabe: se dice (no es «no faltó ninguno»)
  let missing = [];
  try { missing = fs.readFileSync(side, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean); } catch (e) {
    if (!e || e.code !== 'ENOENT') throw new Error(`no pude leer qué programas no encontró PowerShell al correr un comando de la página (${side}): ${(e && (e.code || e.message)) || e}`);
  }
  return Object.assign(r, { not_found: [...new Set(missing)] });
}

/** `harness.js` de un árbol, con sus argumentos. Devuelve lo de `lab.run` (la salida entera). */
function harness(tree, args, { env, input, cwd, timeoutMs = CMD_TIMEOUT_MS } = {}) {
  return L.run(process.execPath, [path.join(tree, 'scripts', 'setup', 'harness.js'), ...args], { env, input, cwd, timeoutMs, cap: 400000 });
}

// ── los permisos: se buscan en la salida cruda ───────────────────────────────────────────────────────────────────

/**
 * Mira la salida CRUDA de un comando: `{ leaked, clean }`. `leaked` son los nombres de los permisos que aparecen;
 * `clean`, la misma salida ya tapada (lo único que se puede guardar). `secrets` = `{ nombre: valor }`.
 */
function guard(raw, secrets) {
  const text = `${raw.stdout || ''}\n${raw.stderr || ''}`;
  const leaked = Object.entries(secrets).filter(([, value]) => value && text.includes(value)).map(([name]) => name);
  const wipe = (s) => Object.values(secrets).filter(Boolean).reduce((acc, value) => acc.split(value).join(L.REDACTED_SECRET), String(s || ''));
  return { leaked, clean: Object.assign({}, raw, { stdout: wipe(raw.stdout), stderr: wipe(raw.stderr) }) };
}
function secretFindings(leaked, where) {
  if (!leaked || !leaked.length) return [];
  return [{ id: 'guided:secret-printed', severity: T.SEVERITY.breaks, kind: 'secret', detail: `${where}: la salida del comando trae el permiso de juguete (${leaked.join(' y ')}): un comando de la instalación imprime una credencial` }];
}
/**
 * Lo que se hace con la salida de TODO comando que el ensayo corre: se buscan los permisos en la salida cruda y se
 * devuelve la salida tapada con el hallazgo que corresponda. `{ clean, findings }`. Quien corre un comando usa esto
 * y nunca `guard` suelto: buscar y no anotar es lo mismo que no buscar.
 */
function checked(raw, secrets, where) {
  const g = guard(raw, secrets);
  return { clean: g.clean, findings: secretFindings(g.leaked, where) };
}
/**
 * La red de abajo: el tapador del reporte, mirando lo que tapa. Donde el ensayo tiene la salida cruda de un comando la
 * revisa con `checked`; pero hay salidas que le llegan ya resumidas (la foto, el humo de los hooks, el diagnóstico), y
 * todo lo que va al reporte pasa por el tapador. `{ redact, seen }`: `seen()` dice qué permisos de juguete aparecieron
 * en algo que se iba a guardar. Con los comandos revisados en crudo, acá no tiene que aparecer ninguno.
 */
function watching(redact, secrets) {
  const seen = new Set();
  return {
    redact: (value) => {
      let text = '';
      try { text = JSON.stringify(value) || ''; } catch (_) { text = ''; }
      for (const [name, secret] of Object.entries(secrets || {})) if (secret && text.includes(secret)) seen.add(name);
      return redact(value);
    },
    seen: () => [...seen].sort(),
  };
}
/** Los hallazgos de la red de abajo, para anotar al final del paso. */
const savedLeaks = (watch) => secretFindings(watch.seen(), 'en lo que el ensayo iba a guardar de la salida de un comando (la foto, el humo de los hooks o el diagnóstico)').map((f) => Object.assign({}, f, { id: `${f.id}:saved` }));
/** El tapador del reporte: los permisos que se le pasan a mano (el de Azure entra por la entrada estándar) y los del ambiente. */
function redactor({ secrets = [], env = {}, publicUrl = null } = {}) {
  return L.redactor({ publicUrl, secrets: [...new Set([...secrets.filter(Boolean), ...L.secretValues(env)])] });
}

// ── el estado del arnés, por la carpeta que resuelve el propio arnés ─────────────────────────────────────────────

/**
 * Las rutas del estado de una carpeta de usuario, preguntadas al arnés (al del árbol instalado si lo hay; si no, al del
 * árbol de estos guiones): `{ file, harnessDir, lockDir, log, bootstrapDir }` o `{ problem }`. Nunca una ruta fija: el
 * estado vive en la carpeta de Claude Code o en la casa propia del arnés, según la máquina.
 */
function statePaths({ home, env, tree = null }) {
  const own = tree && fs.existsSync(path.join(tree, 'scripts', 'setup', 'harness', 'state.js')) ? path.join(tree, 'scripts', 'setup', 'harness', 'state.js') : path.join(SETUP, 'state.js');
  const r = L.run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).paths(process.argv[2])))', own, home], { env, timeoutMs: 30000, cap: 4000 });
  if (r.error || r.exit !== 0) return { problem: `no pude preguntarle al arnés dónde vive su estado (${own} salió ${r.error || r.exit}: ${L.firstLine(r.stderr)})` };
  try { const p = JSON.parse(r.stdout); return { file: p.file, harnessDir: p.harnessDir, lockDir: p.lockDir, log: p.log, bootstrapDir: p.bootstrapDir || p.harnessDir }; } catch (e) { return { problem: `el arnés no contestó sus rutas como JSON: ${L.clip(r.stdout, 200)}` }; }
}
/**
 * El estado del arnés de una carpeta de usuario: el objeto, o `null` si el archivo NO ESTÁ. Si está y no se puede leer,
 * TIRA: «no pude leer» no es «no hay estado» (quien llama corre dentro de una variante: queda como «no pude ensayar»).
 */
function stateOf(paths) {
  let text;
  try { text = fs.readFileSync(paths.file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error(`no pude leer el estado del arnés (${paths.file}): ${e.code || e.message}`);
  }
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error(`el estado del arnés (${paths.file}) no es JSON: ${e.message}`); }
}
/**
 * El número de versión de un árbol instalado, por su `version.json`: `{ number, problem }`. Sin archivo, los dos nulos
 * (no hay versión instalada); con un archivo que no se deja leer o no trae el número, `problem` lo dice.
 */
function versionFacts(tree) {
  const file = path.join(tree, 'version.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { number: null, problem: null } : { number: null, problem: `no pude leer ${file}: ${e.code || e.message}` };
  }
  try {
    const v = JSON.parse(text.replace(/^﻿/, '')).version;
    return typeof v === 'string' && v ? { number: v, problem: null } : { number: null, problem: `${file} no trae un número de versión` };
  } catch (e) { return { number: null, problem: `${file} no es JSON: ${e.message}` }; }
}
/** El número de la versión instalada: el de `version.json` del árbol instalado. Nunca por git. `null` si no se lee. */
const installedVersion = (tree) => versionFacts(tree).number;
/** Saca al arranque de su ventana de red (la última mirada, nunca): el arranque siguiente mira. `{ done, why }`. */
function outOfWindow(paths) {
  try {
    const st = readJson(paths.file);
    st.last_fetch = null;
    st.last_fetch_failed = null;
    L.writeJsonAtomic(paths.file, st);
    return { done: true, why: null };
  } catch (e) { return { done: false, why: `no pude reescribir el estado (${paths.file}: ${e.code || e.message}): un «no se actualizó» que siga puede ser por esto` }; }
}

// ── una sesión que arranca, con la espera al trabajo desprendido ─────────────────────────────────────────────────

/**
 * Las marcas «el hook se fue y el trabajo sigue» que hay en la carpeta del estado. Sin carpeta, ninguna. Una carpeta
 * que está y no se deja listar TIRA: leerla como «no hay marcas» sería medir antes de que el trabajo termine.
 */
function detachedMarks(harnessDir) {
  try { return fs.readdirSync(harnessDir).filter((n) => MARK_RX.test(n)).sort(); } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw new Error(`no pude mirar si el arranque dejó trabajo desprendido (${harnessDir}): ${e.code || e.message}`);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e) && e.code !== 'ESRCH'; } };
/** En qué está una marca: se limpió, quedó su resultado al lado, su proceso ya no existe, o sigue vivo. */
function markState(harnessDir, name) {
  const file = path.join(harnessDir, name);
  let text;
  // «se limpió» es que la marca YA NO ESTÁ. Si está y no se deja leer no se sabe si su trabajo terminó: se la sigue
  // esperando (hasta el tope), que es lo que no corta la espera con el trabajo vivo
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? { state: 'cleaned' } : { state: 'alive', unreadable: (e && (e.code || e.message)) || String(e) }; }
  if (fs.existsSync(file.replace(/\.gone$/, ''))) return { state: 'result-left' };
  const pid = parseInt(String(text).trim(), 10);
  if (!Number.isFinite(pid) || !alive(pid)) return { state: 'process-gone' };
  return { state: 'alive', pid };
}
/** El dueño VIVO del candado del arnés (una carpeta con el número de su dueño adentro), o `null` si está libre. */
function lockHolder(lockDir) {
  const owner = LOCK.readOwner(lockDir);
  if (!owner || LOCK.ownerIsDead(owner)) return null;
  return owner.pid;
}

/**
 * Espera al trabajo que una sesión dejó desprendido. `before` son las marcas que ya había ANTES de la sesión: no se
 * esperan. `{ detached, waited_ms, ended_by }`: `ended_by` es `cleaned` (terminó y limpió), `result-left` (terminó y
 * quedó su resultado), `process-gone` (su proceso ya no existe) o `not-finished` (seguía vivo al tope, con `pid` o
 * `lock_held_by`). `budget` (`{ left_ms }`) es el tope de todas las esperas de una variante: se va gastando.
 */
function waitDetached({ harnessDir, lockDir, before = [], marks = null, capMs = WAIT_CAP_MS, pollMs = 250, budget = null }) {
  // `marks`: las marcas nuevas que quien llama ya vio (apenas volvió el hook); si no, las que haya ahora y no estaban
  const fresh = Array.isArray(marks) ? marks : detachedMarks(harnessDir).filter((n) => !before.includes(n));
  if (!fresh.length) return { detached: false, waited_ms: 0, ended_by: null };
  const limit = budget ? Math.min(capMs, Math.max(0, budget.left_ms)) : capMs;
  const t0 = Date.now();
  const out = { detached: true, waited_ms: 0, ended_by: null };
  for (;;) {
    const states = fresh.map((n) => markState(harnessDir, n));
    const working = states.find((s) => s.state === 'alive') || null;
    const holder = lockHolder(lockDir);
    if (!working && !holder) {
      out.ended_by = ['process-gone', 'result-left'].find((k) => states.some((s) => s.state === k)) || 'cleaned';
      break;
    }
    if (Date.now() - t0 >= limit) {
      out.ended_by = 'not-finished';
      if (working && working.pid) out.pid = working.pid;
      if (working && working.unreadable) out.mark_unreadable = working.unreadable;
      if (holder) out.lock_held_by = holder;
      if (limit < capMs) out.budget_exhausted = true;
      break;
    }
    sleep(Math.min(pollMs, Math.max(1, limit - (Date.now() - t0))));
  }
  out.waited_ms = Date.now() - t0;
  if (budget) budget.left_ms = Math.max(0, budget.left_ms - out.waited_ms);
  return out;
}

/**
 * El juicio de UNA sesión, el mismo para toda sesión que el ensayo abre (con los identificadores y las gravedades que
 * ya tienen en la comparación de fotos): `settings.json` ilegible rompe; la línea de arranque que no arranca o sale
 * distinto de 0 pierde un control; lo que escribe en el canal de errores y otro hook de arranque que falla son ruido;
 * un trabajo desprendido que seguía VIVO al tope pierde un control; y un permiso de juguete en la salida de un hook
 * rompe. `startup: false` deja afuera el juicio de la línea de arranque (la variante sin `pwsh`: ahí que falle es lo
 * que se mide, con su propio hallazgo).
 */
function sessionFindings(session, { startup = true } = {}) {
  if (!session) return [];
  const out = [];
  const add = (id, severity, detail) => { if (!out.some((f) => f.id === id)) out.push({ id, severity, kind: 'session', detail }); };
  if (session.problem) { add(`session:${session.form}:unreadable-settings`, T.SEVERITY.breaks, `sesión ${session.label} (${session.form}): ${session.problem}`); return out; }
  for (const h of session.hooks || []) {
    const said = L.clip(T.tellingLine(h.err) || L.firstLine(h.out), 300);
    const how = h.error ? `no arrancó (${h.error})` : `salió ${h.exit}`;
    if (h.startup && startup && (h.error || h.exit !== 0)) add(`session:${session.form}:startup-line-failed`, T.SEVERITY.loses, `la línea de arranque, lanzada por ${session.form}, ${how}${said ? ` — ${said}` : ''}`);
    else if (h.startup && startup && L.firstLine(h.err)) add(`session:${session.form}:startup-line-stderr`, T.SEVERITY.noise, `la línea de arranque, lanzada por ${session.form}, salió 0 y escribió en el canal de errores: ${L.firstLine(h.err)}`);
    else if (!h.startup && (h.error || h.exit !== 0)) add(`session:${session.form}:hook-failed:${h.hook}`, T.SEVERITY.noise, `${h.hook} (SessionStart), lanzado por ${session.form}, ${how}${said ? ` — ${said}` : ''}`);
  }
  const w = session.wait;
  if (w && w.ended_by === 'not-finished') {
    const who = [w.pid ? `el proceso ${w.pid}` : null, w.lock_held_by ? `el candado tomado por el proceso ${w.lock_held_by}` : null, w.mark_unreadable ? `una marca del trabajo que no se pudo leer (${w.mark_unreadable})` : null].filter(Boolean).join(' y ');
    const tail = Array.isArray(w.log_tail) && w.log_tail.length ? ` Lo último del registro de arranque: ${w.log_tail.join(' | ')}` : '';
    add(`session:${session.form}:detached-run-not-finished`, T.SEVERITY.loses, `sesión ${session.label} (${session.form}): el trabajo que se desprendió del arranque seguía vivo después de ${Math.round(w.waited_ms / 1000)} s de espera${w.budget_exhausted ? ' (se acabó el tope de esperas de la variante)' : ''} — quedó ${who || 'trabajando'}.${tail}`);
  }
  out.push(...secretFindings(session.leaked, `sesión ${session.label} (${session.form})`));
  return out;
}

let shotCounter = 0;
/**
 * Lo que corre solo al abrir una sesión: TODOS los hooks `SessionStart` de `settings.json`, en su orden, cada uno con
 * su comando tal como quedó registrado, SIN apagar el desprendimiento del arranque; y después, la espera al trabajo que
 * quedó desprendido. `{ label, form, shell, hooks, log_lines, wait, leaked, settings_sha256 }` o `{ label, form,
 * problem }`. `secrets` (`{ nombre: valor }`): los permisos de juguete, que se buscan en la salida CRUDA de cada hook y
 * en lo nuevo del registro de arranque (`leaked` dice cuáles aparecieron); lo que se devuelve ya va tapado.
 */
function fireSession({ form, home, env, label, paths, secrets = {}, capMs = WAIT_CAP_MS, pollMs = 250, budget = null }) {
  const file = path.join(home, '.claude', 'settings.json');
  let settings;
  try { settings = T.readJsonLoose(file).value; } catch (e) { return { label, form: form.id, problem: `settings.json no se pudo leer: ${e.message}` }; }
  const log = () => { try { return fs.readFileSync(paths.log, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };
  const logBefore = log().length;
  const marksBefore = detachedMarks(paths.harnessDir);
  const input = F.payload('SessionStart', { source: 'startup' }, { cwd: home, home });
  const rows = [];
  const fresh = [];
  const leaked = new Set();
  for (const h of C.registeredHooks(settings).filter((x) => x.event === 'SessionStart')) {
    const startup = T.isHarnessStartup(h.command);
    const [bin, args, opts] = form.launch(h.command, `g${++shotCounter}`);
    const raw = L.run(bin, args, Object.assign({ cwd: home, env, input: JSON.stringify(input), timeoutMs: startup ? STARTUP_TIMEOUT_MS : HOOK_TIMEOUT_MS, cap: 400000 }, opts));
    // los permisos se buscan en la salida ENTERA y recién después se recorta lo que se guarda: recortando antes, uno
    // impreso en el medio no se vería, y uno partido por el corte dejaría un pedazo sin tapar
    const g = guard(raw, secrets);
    for (const name of g.leaked) leaked.add(name);
    const r = Object.assign({}, g.clean, { stdout: L.clip(g.clean.stdout, HOOK_OUTPUT_CAP), stderr: L.clip(g.clean.stderr, HOOK_OUTPUT_CAP) });
    rows.push({ hook: startup ? 'startup-line' : (h.file ? F.hookName(h.file) : L.clip(h.command, 120)), startup: startup ? (T.isNewStartup(h.command) ? 'new' : 'old') : null, is_async: h.is_async === true, form: form.id, exit: r.exit, error: r.error, timed_out: r.timed_out, blocked: r.exit === 2 || F.BLOCK_RX.test(r.stdout), ms: r.ms, out: r.stdout, err: r.stderr });
    // si se desprendió se mira APENAS vuelve la línea de arranque (el hook deja su marca antes de volver): para cuando
    // terminan los demás hooks de la sesión el trabajo pudo haber terminado y limpiado, y parecería que no se desprendió
    if (startup) for (const n of detachedMarks(paths.harnessDir)) if (!marksBefore.includes(n) && !fresh.includes(n)) fresh.push(n);
  }
  const wait = waitDetached({ harnessDir: paths.harnessDir, lockDir: paths.lockDir, marks: fresh, capMs, pollMs, budget });
  const logged = guard({ stdout: log().slice(logBefore).join('\n'), stderr: '' }, secrets);
  for (const name of logged.leaked) leaked.add(name);
  const lines = logged.clean.stdout.split('\n').filter(Boolean);
  if (wait.ended_by === 'not-finished') wait.log_tail = lines.slice(-6).map((l) => L.clip(l, 300));
  return { label, form: form.id, shell: form.shell, hooks: rows, log_lines: lines.map((l) => L.clip(l, 500)), wait, leaked: [...leaked], settings_sha256: sha(file) };
}

// ── las variantes de un paso ─────────────────────────────────────────────────────────────────────────────────────

/** Las variantes pedidas por nombre (`only`), o todas: `{ chosen }` o `{ problem }`. */
function chooseVariants(variants, only) {
  const chosen = variants.filter((v) => !only || only.includes(v.id));
  if (!chosen.length) return { problem: `ninguna variante se llama ${(only || []).join(', ')} (las que hay: ${variants.map((v) => v.id).join(', ')})` };
  return { chosen };
}
/**
 * Corre cada variante por separado: una que tira queda anotada con su error y las demás corren igual. `run(v, facts,
 * save)` devuelve `false` si la variante no pudo ni empezar (deja el motivo en `facts.not_run`); `save()` deja en el
 * parcial lo anotado hasta ahí (si el paso se corta por su tope, no se pierde). `{ variants, ran, broke }`.
 */
function runVariants({ variants, run, rec, say = () => {} }) {
  const all = {};
  const broke = [];
  let ran = 0;
  const save = () => rec.fact('variants', all);
  for (const v of variants) {
    const facts = { what: v.what };
    all[v.id] = facts;
    try {
      const did = run(v, facts, save);
      if (did === false) say(`${v.id} — no corrió: ${facts.not_run}`); else ran++;
    } catch (e) {
      ran++;
      facts.threw = e.message;
      // dónde tiró: en una corrida de veinte minutos, el mensaje solo no alcanza para encontrarlo
      facts.threw_at = L.clip(String((e && e.stack) || '').split('\n').slice(1, 6).map((l) => l.trim()).join(' | '), 700);
      broke.push(`la variante ${v.id} tiró: ${e.message}`);
    }
    rec.fact('variants', all);
  }
  return { variants: all, ran, broke };
}
/**
 * El estado del paso según cómo les fue a sus variantes: «error» sólo si no se pudo ensayar. `specs` son las variantes
 * pedidas: la que es `required` (la principal del paso) y no pudo ni empezar deja el paso en «error» —sin ella no se
 * ensayó—; una que no es la principal y no corrió no cambia el estado, pero queda dicha en el motivo del paso.
 */
function variantsStatus({ variants, ran, broke }, specs = []) {
  const skipped = Object.entries(variants).filter(([, x]) => x.not_run).map(([k, x]) => `${k}: ${x.not_run}`);
  if (!ran) return { status: L.STATUS.error, reason: `no pude ensayar: ninguna variante pudo correr (${Object.entries(variants).map(([k, x]) => `${k}: ${x.not_run || x.threw}`).join(' · ')})` };
  const stuck = specs.filter((v) => v.required && variants[v.id] && variants[v.id].not_run).map((v) => `la variante ${v.id}, que es la principal del paso, no corrió: ${variants[v.id].not_run}`);
  if (broke.length || stuck.length) return { status: L.STATUS.error, reason: `no pude ensayar: ${[...broke, ...stuck].join(' · ')}` };
  return { status: L.STATUS.measured, reason: skipped.length ? `medido, pero no corrió: ${skipped.join(' · ')}` : null };
}

module.exports = {
  TEAM, TEAM_URL, ENV_SET, ENV_NEVER, WAIT_CAP_MS, VARIANT_WAIT_BUDGET_MS, PORTS_WAIT_MS, CMD_TIMEOUT_MS, PAGE_TIMEOUT_MS, LAUNCHED_WITH,
  sleep, readJson, lastLines, sha, toyToken,
  cleanBase, variantEnv, withToken, teamEnv,
  gitEnv, git, nextVersion, publish, onRehearsedCommit,
  startGitHub, startAzure, makeTeamRepo, makeHome,
  runPage, harness, guard, secretFindings, checked, watching, savedLeaks, redactor,
  statePaths, stateOf, versionFacts, installedVersion, outOfWindow,
  detachedMarks, waitDetached, sessionFindings, fireSession,
  chooseVariants, runVariants, variantsStatus,
};
