#!/usr/bin/env node
'use strict';
/**
 * product-lab.js — un producto de prueba de tres repos, sobre el que corren la matriz y los cierres reales.
 *
 * Por qué existe: las pruebas de cada regla arman el repo justo que esa regla mira, y lo que depende de la forma de un
 * producto no se ve ahí: historias en un repo, código en otro, ramas `dev` y `main`, fusiones de pedido, copias locales
 * atrasadas. Por eso un defecto así lo encuentra un dev en su producto, después de publicado.
 *
 * Qué hace: arma tres repos con nombres inventados, con su remoto y con fechas fijas, y una copia de esa base por caso, para
 * que un caso no le cambie la clave de evidencia a otro. Cada caso lanza un comando del arnés como proceso y dice si dio lo
 * esperado. Mira el motivo, no sólo el color: un rojo por otra causa no cuenta como el rojo esperado.
 *
 * Tres resultados: `ok` (dio lo esperado), `falla` (el comando corrió y dio otra cosa) y `no-medido` (falta el guion, no
 * terminó, devolvió algo que no se sabe leer o llamó afuera). No medido nunca se lee como verde ni como un rojo esperado.
 *
 * Aislamiento: cada comando corre con un entorno armado desde cero, sin credenciales de quien lo lanza; con un `PATH` que
 * tiene marcas en lugar de los clientes de red; con git limitado a remotos locales; y con una guarda de node que anota y
 * rechaza toda conexión, datagrama o consulta de nombres. Si la guarda no puede dejar su marca, corta el proceso: el caso da
 * «no medido». Límite: no es una jaula. Un binario llamado por su ruta absoluta, o que no está en la lista, puede salir a la
 * red, sin credenciales. Cerrarlo pide un contenedor sin red.
 *
 * Uso: node scripts/tests/lib/product-lab.js [--harness <carpeta>] [--json]
 * Sale 0 si midió todos los casos, aunque alguno falle, y 2 si alguno no se midió. Sirve para comparar dos versiones del
 * arnés: no escribe fuera de su carpeta temporal.
 *
 * stable-data: no lee el reloj. Los commits llevan GIT_AUTHOR_DATE y GIT_COMMITTER_DATE fijas, con maintenance.auto=false.
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const ledgerLine = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'tests', 'lib', 'smoke-ledger-line.js'));

const TOPE_MS = 60000;
const T0 = 1790000000;
const PROHIBIDOS = ['az', 'gh', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'rsync', 'nc', 'ncat', 'socat', 'telnet', 'openssl', 'dig', 'nslookup',
  'ping', 'python', 'python2', 'python3', 'perl', 'ruby'];
const VARIABLES_QUE_PASAN = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];

class NoMedido extends Error {}

/** Los cuatro guiones que corre el laboratorio, en una versión del arnés. */
function rutasDeComandos(harness) {
  return {
    matriz: path.join(harness, 'skills', 'tycon-pipeline', 'scripts', 'runtime-matrix.js'),
    freno: path.join(harness, 'skills', 'tycon-pipeline', 'scripts', 'on-pre-commit.js'),
    guia: path.join(harness, 'skills', 'tycon-pipeline', 'scripts', 'qa-guide.js'),
    retro: path.join(harness, 'scripts', 'hooks', 'retro-pending.js'),
  };
}

// ---------------------------------------------------------------- el aislamiento

const SIN_MARCA = 86;
const GUARDA_DE_RED = `'use strict';
const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns');
function rechazar(destino) {
  try { fs.appendFileSync(process.env.LAB_CALLS, 'red ' + destino + '\\n'); } catch (_) {
    process.stderr.write('el laboratorio no pudo anotar una conexión de red: ' + destino + '\\n');
    process.exit(${SIN_MARCA});
  }
  throw new Error('el laboratorio no deja abrir una conexión de red: ' + destino);
}
const conectar = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const primero = Array.isArray(args[0]) ? args[0][0] : args[0];
  // un texto que no es un número es la ruta de un socket local: connect(ruta, cb) no sale de la máquina
  if (typeof primero === 'string' && !/^\\d+$/.test(primero)) return conectar.apply(this, args);
  const opciones = primero && typeof primero === 'object' ? primero : { port: primero, host: args[1] };
  if (opciones.path) return conectar.apply(this, args);
  return rechazar(String(opciones.host || 'localhost') + ':' + String(opciones.port));
};
dgram.Socket.prototype.send = function () { return rechazar('udp'); };
// toda consulta de nombres de la interfaz con devolución de llamada: lookup, lookupService, reverse y cada resolve
for (const f of Object.keys(dns)) {
  if (typeof dns[f] === 'function' && /^(lookup|resolve|reverse)/.test(f)) dns[f] = function (nombre) { return rechazar('dns ' + nombre); };
}
`;

function aEnlazar(dirs) {
  const vistos = new Map();
  for (const d of dirs) {
    let nombres = [];
    try { nombres = fs.readdirSync(d); } catch (_) { continue; }
    for (const n of nombres) if (!vistos.has(n)) vistos.set(n, path.join(d, n));
  }
  return vistos;
}

/** La carpeta de herramientas de una corrida: enlaces a lo del `PATH`, marcas en lugar de lo prohibido y la guarda de red. */
function armarHerramientas(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
  const todos = aEnlazar(dirs);
  const git = todos.get('git');
  if (!git) throw new NoMedido('no hay git en el PATH');
  for (const [nombre, destino] of todos) {
    if (PROHIBIDOS.includes(nombre) || nombre === 'git' || nombre === 'node') continue;
    try { fs.symlinkSync(destino, path.join(bin, nombre)); } catch (_) { /* un nombre raro: queda sin enlazar */ }
  }
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const nombre of PROHIBIDOS) {
    fs.writeFileSync(path.join(bin, nombre), `#!/bin/sh\nprintf '%s\\n' "${nombre} $*" >> "$LAB_CALLS" || exit ${SIN_MARCA}\necho "${nombre}: el laboratorio no deja llamarlo" >&2\nexit 127\n`, { mode: 0o755 });
  }
  // Sólo mira los subcomandos que salen a un remoto: `git log -S` lleva líneas del espejo, y esas nombran URLs de la app.
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
sub=""; saltar=""
for a in "$@"; do
  if [ -n "$saltar" ]; then saltar=""; continue; fi
  case "$a" in
    -c|-C|--git-dir|--work-tree|--namespace) saltar=1 ;;
    -*) ;;
    *) sub="$a"; break ;;
  esac
done
case "$sub" in
  clone|fetch|pull|push|ls-remote|remote|submodule)
    case " $* " in
      *http://*|*https://*|*ssh://*|*git://*|*git@*)
        printf 'git %s\\n' "$*" >> "$LAB_CALLS" || exit ${SIN_MARCA}
        echo "git: el laboratorio sólo deja remotos locales" >&2
        exit 128 ;;
    esac ;;
esac
exec '${git.split("'").join("'\\''")}' "$@"
`, { mode: 0o755 });
  const guarda = path.join(dir, 'guarda-de-red.js');
  fs.writeFileSync(guarda, GUARDA_DE_RED);
  return { bin, guarda };
}

/** El entorno de un comando: desde cero, con lo que pasa de la lista cerrada y lo del laboratorio. */
function entornoDe(c, extra = {}) {
  const env = {};
  for (const k of VARIABLES_QUE_PASAN) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env,
    PATH: c.herramientas.bin,
    HOME: c.home,
    USERPROFILE: c.home,
    TMPDIR: c.tmp,
    TEMP: c.tmp,
    TMP: c.tmp,
    LAB_CALLS: c.llamadas,
    NODE_OPTIONS: `--require ${JSON.stringify(c.herramientas.guarda)}`,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

// ---------------------------------------------------------------- git y los repos

function correrGit(c, repo, args, fecha = T0) {
  const r = spawnSync('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false',
    '-c', 'gc.auto=0', '-c', `core.hooksPath=${os.devNull}`, ...args], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    env: entornoDe(c, { GIT_AUTHOR_DATE: `${fecha} +0000`, GIT_COMMITTER_DATE: `${fecha} +0000` }),
  });
  if (r.error || r.status !== 0) throw new NoMedido(`git ${args[0]} falló: ${String((r.error && r.error.message) || r.stderr).trim().split('\n')[0]}`);
  return r.stdout.trim();
}

function escribir(repo, rel, texto) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, texto);
  return abs;
}

function commit(c, repo, mensaje, fecha) {
  correrGit(c, repo, ['add', '-A'], fecha);
  correrGit(c, repo, ['commit', '-q', '-m', mensaje], fecha);
}

function repoNuevo(c, nombre) {
  const remoto = path.join(c.dir, 'remotos', `${nombre}.git`);
  fs.mkdirSync(remoto, { recursive: true });
  correrGit(c, remoto, ['init', '-q', '--bare', '-b', 'main']);
  const repo = path.join(c.dir, 'repos', nombre);
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  correrGit(c, path.dirname(repo), ['clone', '-q', remoto, repo]);
  correrGit(c, repo, ['checkout', '-q', '-b', 'main']);
  return repo;
}

/** Una fusión como la de un pedido: en una copia aparte, como la hace el servidor, y se empuja. `resolver` escribe un choque a mano. */
function fusionar(c, repo, rama, destino, fecha, { asunto, resolver, squash } = {}) {
  c.pedido += 1;
  // el número del pedido lo pone el laboratorio: uno escrito a mano se lee como un pedido de verdad
  const titulo = asunto ? asunto.replace('{n}', String(c.pedido)) : `Merge pull request ${c.pedido} from ${rama} into ${destino}`;
  const copia = path.join(c.dir, 'servidor', `${path.basename(repo)}-${c.pedido}`);
  fs.mkdirSync(path.dirname(copia), { recursive: true });
  correrGit(c, path.dirname(copia), ['clone', '-q', correrGit(c, repo, ['remote', 'get-url', 'origin']), copia]);
  correrGit(c, copia, ['checkout', '-q', destino]);
  if (squash) {
    correrGit(c, copia, ['merge', '-q', '--squash', `origin/${rama}`], fecha);
    correrGit(c, copia, ['commit', '-q', '-m', titulo], fecha);
  } else if (resolver) {
    // el choque es lo esperado: la fusión sale distinta de cero y deja MERGE_HEAD
    spawnSync('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', 'merge', '-q', '--no-ff', '--no-commit', `origin/${rama}`], { cwd: copia, env: entornoDe(c), stdio: 'ignore' });
    if (!fs.existsSync(path.join(copia, '.git', 'MERGE_HEAD'))) throw new NoMedido(`la fusión de ${rama} no quedó a medio hacer: no hay choque que resolver`);
    resolver(copia);
    commit(c, copia, titulo, fecha);
  } else {
    correrGit(c, copia, ['merge', '-q', '--no-ff', '-m', titulo, `origin/${rama}`], fecha);
  }
  correrGit(c, copia, ['push', '-q', 'origin', destino], fecha);
  fs.rmSync(copia, { recursive: true, force: true });
  return correrGit(c, repo, ['ls-remote', 'origin', `refs/heads/${destino}`]).split(/\s/)[0];
}

function bajar(c, repo, rama = 'main') {
  correrGit(c, repo, ['checkout', '-q', rama]);
  correrGit(c, repo, ['pull', '-q', '--ff-only', 'origin', rama]);
}

/** Una rama desde `main`, con un cambio commiteado y empujado. */
function cambiarEnRama(c, repo, rama, archivo, fecha, texto) {
  correrGit(c, repo, ['checkout', '-q', 'main']);
  correrGit(c, repo, ['checkout', '-q', '-b', rama]);
  fs.mkdirSync(path.dirname(path.join(repo, archivo)), { recursive: true });
  fs.appendFileSync(path.join(repo, archivo), texto || `// ${rama}\n`);
  commit(c, repo, `feat: ${rama}`, fecha);
  correrGit(c, repo, ['push', '-q', 'origin', rama], fecha);
  correrGit(c, repo, ['checkout', '-q', 'main']);
}

const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

/** `lista`: las líneas de `files_to_modify` tal cual, para los casos que miden cómo se lee la lista. */
function historiaTexto({ id, titulo, status = 'review', archivos, marca, lista }) {
  return [
    '---', `story: "${id}"`, 'epic: 1', `title: "${titulo}"`, `status: ${status}`, ...(lista || ['files_to_modify:', ...archivos.map((a) => `  - ${a}`)]), '---', '',
    `# Story ${id}: ${titulo}`, '', '## Acceptance Criteria', '',
    '1. **Given** un pedido, **When** se consulta, **Then** responde 200.',
    '2. **Given** un pedido sin datos, **When** se consulta, **Then** responde 422.', '',
    '### Tests', '', '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|',
    '| T1 | `Pedido_Responde` | 1,2 | integration | x | y |', '',
    ...(marca ? [marca, ''] : []),
  ].join('\n');
}

function gatesLog(home) {
  const { stateDir } = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js'));
  const d = stateDir(home);
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, 'gates.log');
}

function humo(c, clave, tsSeg) {
  const dodDir = path.join(c.repos['Lab-Historias'], '.advisors', 'dod-runtime');
  fs.mkdirSync(dodDir, { recursive: true });
  // La salida va escrita acá con un nombre fijo: la del ayudante lleva un sufijo al azar y cambiaría el hash del commit.
  const salida = path.join(`${clave}-smoke-outputs`, `${tsSeg}.txt`).split(path.sep).join('/');
  const texto = 'HTTP 200';
  fs.mkdirSync(path.dirname(path.join(dodDir, salida)), { recursive: true });
  fs.writeFileSync(path.join(dodDir, salida), texto);
  const outputSha = crypto.createHash('sha256').update(texto).digest('hex');
  ledgerLine.append({ dodDir, gatesLog: gatesLog(c.home), story: clave, acs: [1, 2], ts: iso(tsSeg), cmd: 'curl -s http://app/pedido', v2: { pasaSi: 'responde 200', output: salida, outputSha } });
}

/** Una historia en el repo de historias, con su evidencia commiteada: el humo a la hora `t` y el commit a `t + 5`. */
function historiaConEvidencia(c, { id, nombre, tema = 'cobranza', archivos, t, clave, status, marca, lista }) {
  const repo = c.repos['Lab-Historias'];
  const rel = `specs/${tema}/stories/${id.replace('.', '-')}-${nombre}.md`;
  const abs = escribir(repo, rel, historiaTexto({ id, titulo: nombre, archivos, status, marca, lista }));
  humo(c, clave || id, t);
  commit(c, repo, `docs(${id}): evidencia`, t + 5);
  return abs;
}

/** Una historia sin evidencia: sólo para que su número esté en el catálogo del repo de historias. */
function historiaDelCatalogo(c, id, nombre, t) {
  const repo = c.repos['Lab-Historias'];
  escribir(repo, `specs/cobranza/stories/${id.replace('.', '-')}-${nombre}.md`, historiaTexto({ id, titulo: nombre, archivos: ['Lab-Backend/src/Clientes/ClienteEndpoint.cs'], status: 'in-progress' }));
  commit(c, repo, `docs(${id}): historia`, t);
}

function armarBase(c) {
  const historias = repoNuevo(c, 'Lab-Historias');
  const backend = repoNuevo(c, 'Lab-Backend');
  const formularios = repoNuevo(c, 'Lab-Formularios');
  c.repos = { 'Lab-Historias': historias, 'Lab-Backend': backend, 'Lab-Formularios': formularios };
  for (const [rel, texto] of [['src/Pedidos/PedidoEndpoint.cs', '// v1\n'], ['src/Pedidos/Base.cs', '// v1\n'], ['src/Pedidos/Choque.cs', '// v1\n'], ['src/Clientes/ClienteEndpoint.cs', '// v1\n'], ['tests/PedidoTests.cs', '// v1\n']]) escribir(backend, rel, texto);
  commit(c, backend, 'base', T0);
  escribir(formularios, 'forms/pedido/index.tsx', '// v1\n');
  escribir(formularios, 'forms/pedido/helper.cs', '// v1\n');
  commit(c, formularios, 'base', T0);
  escribir(historias, '.tycon/advisors.yaml', 'evidence:\n  companion_repos:\n    - ../Lab-Backend\n    - ../Lab-Formularios\n');
  commit(c, historias, 'base', T0);
  for (const r of [historias, backend, formularios]) {
    correrGit(c, r, ['push', '-q', '-u', 'origin', 'main']);
    correrGit(c, r, ['push', '-q', 'origin', 'main:dev']);
    correrGit(c, r, ['fetch', '-q', 'origin']);
    correrGit(c, r, ['branch', '-q', '--track', 'dev', 'origin/dev']);
  }
  // una historia vieja, ya fusionada por `dev` y `main`, con su evidencia; y otra abierta
  cambiarEnRama(c, backend, 'story/0.1-alta', 'src/Pedidos/Base.cs', T0 + 10);
  fusionar(c, backend, 'story/0.1-alta', 'dev', T0 + 20);
  fusionar(c, backend, 'dev', 'main', T0 + 30, { asunto: 'Merged PR {n}: alta de pedidos' });
  bajar(c, backend, 'dev');
  bajar(c, backend, 'main');
  historiaConEvidencia(c, { id: '0.1', nombre: 'alta', archivos: ['Lab-Backend/src/Pedidos/Base.cs'], t: T0 + 40, status: 'done' });
  historiaDelCatalogo(c, '0.2', 'baja', T0 + 60);
  correrGit(c, historias, ['push', '-q', 'origin', 'main'], T0 + 60);
}

/** Lo que cada corrida y cada caso necesitan, en una carpeta propia. */
function contexto(dir, herramientas, topeMs, harness) {
  const c = { dir, herramientas, topeMs, harness, home: path.join(dir, 'home'), tmp: path.join(dir, 'tmp'), llamadas: path.join(dir, 'llamadas'), pedido: 100, repos: {} };
  fs.mkdirSync(c.home, { recursive: true });
  fs.mkdirSync(c.tmp, { recursive: true });
  fs.writeFileSync(c.llamadas, '');
  return c;
}

function copiaDeLaBase(base, dir, topeMs, harness) {
  fs.cpSync(base.dir, dir, { recursive: true, verbatimSymlinks: true });
  const c = contexto(dir, base.herramientas, topeMs, harness);
  for (const nombre of Object.keys(base.repos)) {
    c.repos[nombre] = path.join(dir, 'repos', nombre);
    correrGit(c, c.repos[nombre], ['remote', 'set-url', 'origin', path.join(dir, 'remotos', `${nombre}.git`)]);
  }
  return c;
}

// ---------------------------------------------------------------- los comandos

/** Saca de un texto las carpetas de la corrida y la del arnés: la salida se puede pegar sin nombrar la máquina. */
function sanear(texto, carpetas) {
  let t = String(texto);
  for (const [ruta, rotulo] of carpetas) if (ruta) t = t.split(ruta).join(rotulo);
  return t;
}
/** Las carpetas que un texto de la corrida en `raiz` no puede nombrar. */
const carpetasDe = (raiz, harness) => [[raiz, '<lab>'], [path.dirname(raiz), '<tmp>'], [harness, '<arnés>'], [RAIZ, '<arnés>']];
const sinCarpeta = (c, texto) => sanear(texto, [[c.dir, '<lab>'], ...carpetasDe(path.dirname(c.dir), c.harness)]);

function lanzar(c, nombre, args, { cwd, input, extra } = {}) {
  const guion = rutasDeComandos(c.harness)[nombre];
  if (!fs.existsSync(guion)) throw new NoMedido(`falta ${path.basename(guion)} en la versión del arnés`);
  const r = spawnSync(process.execPath, [guion, ...args], {
    cwd: cwd || c.repos['Lab-Historias'],
    input,
    encoding: 'utf8',
    timeout: c.topeMs,
    killSignal: 'SIGKILL',
    maxBuffer: 1 << 26,
    env: entornoDe(c, extra),
  });
  if (r.error && r.error.code === 'ETIMEDOUT') throw new NoMedido(`${path.basename(guion)} no terminó en ${c.topeMs} ms`);
  if (r.error) throw new NoMedido(`${path.basename(guion)} no se pudo lanzar: ${r.error.message}`);
  return r;
}

function matriz(c, historia) {
  const r = lanzar(c, 'matriz', ['--story', historia, '--no-write', '--json']);
  if (![0, 1].includes(r.status)) throw new NoMedido(`la matriz salió ${r.status}: ${sinCarpeta(c, r.stderr).split('\n')[0]}`);
  let j;
  try { j = JSON.parse(r.stdout); } catch (_) { throw new NoMedido('la matriz no devolvió un JSON que se pueda leer'); }
  if (typeof j.green !== 'boolean' || !Array.isArray(j.acs) || !j.perAc) throw new NoMedido('la matriz devolvió un JSON sin `green`, `acs` o `perAc`');
  if (j.green !== (r.status === 0)) throw new NoMedido(`la matriz salió ${r.status} y dijo green=${j.green}`);
  const acs = j.acs.map((n) => j.perAc[n] && j.perAc[n].verdict);
  if (!acs.length || acs.some((v) => typeof v !== 'string')) throw new NoMedido('la matriz no dio un veredicto por criterio');
  return { verde: j.green, acs, avisos: (j.warnings || []).map((w) => sinCarpeta(c, w)) };
}

function freno(c) {
  const historias = c.repos['Lab-Historias'];
  const r = lanzar(c, 'freno', [], {
    cwd: historias,
    input: JSON.stringify({ session_id: 'lab', cwd: historias, tool_name: 'Bash', tool_input: { command: 'git commit -m "historia a done"' } }),
    extra: { TYCON_CLOSURE_RECORD: 'off', TYCON_ADVISORS_GATE: 'off' },
  });
  if (![0, 2].includes(r.status)) throw new NoMedido(`el freno salió ${r.status}`);
  const salida = sinCarpeta(c, `${r.stdout}${r.stderr}`);
  if (!salida.trim()) throw new NoMedido('el freno no dijo nada');
  // `tycon-story-evidence` es la parte del freno que miró la historia: sin ella, el freno no la evaluó
  return { codigo: r.status, salida, evaluo: /tycon-story-evidence/.test(salida), porLaMatriz: /DODRT-C6|Criterios sin evidencia|sin verificar/.test(salida) };
}

function guia(c, historia) {
  const r = lanzar(c, 'guia', ['--story', historia, '--check']);
  if (![0, 2].includes(r.status)) throw new NoMedido(`la guía salió ${r.status}`);
  const salida = sinCarpeta(c, `${r.stdout}${r.stderr}`);
  if (!/qa-guide --check/.test(salida)) throw new NoMedido('la guía no dijo su resultado');
  return { codigo: r.status, salida };
}

const ENTORNO_RETRO = { TYCON_RETRO_LAB_DIRS: '', TYCON_RETRO_PENDING_MIN_AGE_MIN: '0' };

function retroAnotar(c, carpeta, sesion) {
  const r = lanzar(c, 'retro', [], {
    cwd: carpeta,
    input: JSON.stringify({ session_id: sesion, hook_event_name: 'PostToolUse', cwd: carpeta, tool_name: 'Bash', tool_input: { command: 'az repos pr create --org https://ejemplo.invalid --project P --repository Lab-Backend --source-branch dev --target-branch main --auto-complete true' } }),
    extra: ENTORNO_RETRO,
  });
  if (![0, 2].includes(r.status)) throw new NoMedido(`retro-pending salió ${r.status}`);
  return sinCarpeta(c, `${r.stdout}${r.stderr}`);
}

function retroAviso(c, carpeta) {
  const r = lanzar(c, 'retro', ['--mode', 'notice'], {
    cwd: carpeta,
    input: JSON.stringify({ session_id: 'lab-aviso', hook_event_name: 'SessionStart', cwd: carpeta }),
    extra: ENTORNO_RETRO,
  });
  if (r.status !== 0) throw new NoMedido(`el aviso de retro-pending salió ${r.status}`);
  return sinCarpeta(c, `${r.stdout}${r.stderr}`);
}

/** Lo que anotó retro-pending. Que no exista es «no anotó nada»; cualquier otro error es «no lo pude leer». */
function registroDeRetro(c) {
  const f = path.join(path.dirname(gatesLog(c.home)), 'retro-pending.jsonl');
  try { return sinCarpeta(c, fs.readFileSync(f, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw new NoMedido(`no pude leer lo que anotó retro-pending: ${e.code}`);
  }
}

// ---------------------------------------------------------------- lo que se espera

const OK = { ok: true, motivo: '' };
const falla = (motivo) => ({ ok: false, motivo });

function esperaVerde(m, avisoRe) {
  if (!m.verde) return falla(`esperaba verde, dio rojo: ${(m.avisos[0] || m.acs.join(',')).slice(0, 200)}`);
  if (m.acs.some((v) => v !== 'RUNTIME')) return falla(`esperaba RUNTIME, dio ${m.acs.join(',')}`);
  if (avisoRe && !m.avisos.some((a) => avisoRe.test(a))) return falla(`esperaba un aviso con ${avisoRe}, y no está`);
  return OK;
}

/** `nombra`: textos que el aviso tiene que traer; `unoDe`: listas de las que el aviso trae al menos uno (un commit o su fusión). */
function esperaRojo(m, { nombra = [], unoDe = [], aviso } = {}) {
  if (m.verde) return falla('esperaba rojo, dio verde');
  const texto = m.avisos.join('\n');
  for (const n of nombra) if (!texto.includes(n)) return falla(`dio rojo por otra causa: el aviso no nombra ${n}`);
  for (const lista of unoDe) if (!lista.some((n) => texto.includes(n))) return falla(`dio rojo por otra causa: el aviso no nombra ${lista.join(' ni ')}`);
  if (aviso && !aviso.test(texto)) return falla(`dio rojo, y el aviso no cumple ${aviso}`);
  return OK;
}

// ---------------------------------------------------------------- los arreglos que comparten varios casos

const ENDPOINT = 'src/Pedidos/PedidoEndpoint.cs';
const CLIENTE = 'src/Clientes/ClienteEndpoint.cs';
const PRUEBA = 'tests/PedidoTests.cs';
const CHOQUE = 'src/Pedidos/Choque.cs';
const delBackend = (rel) => `Lab-Backend/${rel}`;

/** Código, evidencia y después la fusión: primero a `dev`, y `dev` a `main`. */
function fusionPropia(c, { asunto, marca, status } = {}) {
  const backend = c.repos['Lab-Backend'];
  cambiarEnRama(c, backend, 'story/1.1-consulta', ENDPOINT, T0 + 1000);
  const historia = historiaConEvidencia(c, { id: '1.1', nombre: 'consulta', archivos: [delBackend(ENDPOINT)], t: T0 + 1005, marca, status });
  if (asunto) fusionar(c, backend, 'story/1.1-consulta', 'main', T0 + 1100, { asunto });
  else {
    fusionar(c, backend, 'story/1.1-consulta', 'dev', T0 + 1100);
    fusionar(c, backend, 'dev', 'main', T0 + 1200);
  }
  bajar(c, backend);
  const fusiones = correrGit(c, backend, ['log', '--merges', '--format=%h', '--abbrev=7', `${correrGit(c, backend, ['rev-parse', 'HEAD~1'])}..HEAD`]).split('\n').filter(Boolean);
  return { historia, fusion: correrGit(c, backend, ['rev-parse', '--short=7', 'HEAD']), fusiones };
}

/** Evidencia ya guardada, con la fusión propia antes, y después otra historia cambia ese archivo y entra. */
function cambioPosterior(c, { archivo = CLIENTE, ramaOtra = 'story/2.5-otra', marca, status, ruta, lista } = {}) {
  const backend = c.repos['Lab-Backend'];
  cambiarEnRama(c, backend, 'story/1.2-propia', archivo, T0 + 2000);
  fusionar(c, backend, 'story/1.2-propia', 'main', T0 + 2010);
  bajar(c, backend);
  const historia = historiaConEvidencia(c, { id: '1.2', nombre: 'propia', archivos: [ruta || delBackend(archivo)], t: T0 + 2020, marca, status, lista });
  if (ramaOtra === 'story/2.5-otra') historiaDelCatalogo(c, '2.5', 'otra', T0 + 2030);
  cambiarEnRama(c, backend, ramaOtra, archivo, T0 + 2100);
  const commitOtra = correrGit(c, backend, ['rev-parse', '--short=7', ramaOtra]);
  const fusionOtra = fusionar(c, backend, ramaOtra, 'main', T0 + 2110).slice(0, 7);
  bajar(c, backend);
  return { historia, otra: [commitOtra, fusionOtra] };
}

/** La historia, ya commiteada en `in-progress`, pasa a `done` en el índice: es lo que mira el freno del commit. */
function aDone(c, historia) {
  const repo = c.repos['Lab-Historias'];
  fs.writeFileSync(historia, fs.readFileSync(historia, 'utf8').replace(/^status:\s*\S+/m, 'status: done'));
  correrGit(c, repo, ['add', '--', path.relative(repo, historia)]);
}

/** Un archivo que entró a `origin/main` del hermano, y que la copia local no bajó. */
function hermanoAtrasado(c, archivo) {
  const formularios = c.repos['Lab-Formularios'];
  cambiarEnRama(c, formularios, 'story/1.9-nuevo', archivo, T0 + 4500);
  fusionar(c, formularios, 'story/1.9-nuevo', 'main', T0 + 4600);
  correrGit(c, formularios, ['branch', '-q', '-D', 'story/1.9-nuevo']);
  return historiaConEvidencia(c, { id: '1.9', nombre: 'nuevo', archivos: [`Lab-Formularios/${archivo}`], t: T0 + 4505 });
}

const MARCA_DEL_FRENO = 'Pruebas: smoke runtime.';

// ---------------------------------------------------------------- los casos

const CASOS = [
  {
    id: 'fusion-propia', ac: 5,
    prepara: (c) => fusionPropia(c),
    corre: (c, x) => ({ ...matriz(c, x.historia), fusiones: x.fusiones }),
    juzga: (m) => {
      const v = esperaVerde(m, /supone/i);
      if (!v.ok) return v;
      return m.avisos.some((a) => /supone/i.test(a) && m.fusiones.some((f) => a.includes(f))) ? OK : falla('el aviso no nombra la fusión');
    },
  },
  {
    id: 'freno-fusion', ac: 6,
    prepara: (c) => { const x = fusionPropia(c, { marca: MARCA_DEL_FRENO, status: 'in-progress' }); aDone(c, x.historia); return x; },
    corre: (c) => freno(c),
    juzga: (f) => {
      if (!f.evaluo) return falla('el freno no evaluó la historia');
      return f.porLaMatriz ? falla('esperaba que el freno no frene por la matriz, y frenó') : OK;
    },
  },
  {
    id: 'cambio-real', ac: 7,
    prepara: (c) => cambioPosterior(c),
    corre: (c, x) => ({ ...matriz(c, x.historia), otra: x.otra }),
    juzga: (m) => esperaRojo(m, { nombra: [delBackend(CLIENTE)], unoDe: [m.otra] }),
  },
  {
    id: 'choque-en-la-fusion', ac: 8,
    prepara: (c) => {
      const backend = c.repos['Lab-Backend'];
      cambiarEnRama(c, backend, 'story/1.10-choque', CHOQUE, T0 + 5400, '// de la historia\n');
      const historia = historiaConEvidencia(c, { id: '1.10', nombre: 'choque', archivos: [delBackend(CHOQUE)], t: T0 + 5405 });
      cambiarEnRama(c, backend, 'story/2.5-otra', CHOQUE, T0 + 5350, '// de otra historia\n');
      fusionar(c, backend, 'story/2.5-otra', 'main', T0 + 5360);
      fusionar(c, backend, 'story/1.10-choque', 'main', T0 + 5500, { resolver: (copia) => escribir(copia, CHOQUE, '// resuelto a mano, distinto de lo probado\n') });
      bajar(c, backend);
      return { historia };
    },
    corre: (c, x) => matriz(c, x.historia),
    juzga: (m) => esperaRojo(m, { nombra: [delBackend(CHOQUE)] }),
  },
  {
    id: 'freno-cambio-real', ac: 9,
    prepara: (c) => { const x = cambioPosterior(c, { marca: MARCA_DEL_FRENO, status: 'in-progress' }); aDone(c, x.historia); return x; },
    corre: (c) => freno(c),
    juzga: (f) => (f.evaluo && f.codigo === 2 && f.porLaMatriz ? OK : falla(`esperaba que el freno evalúe la historia, salga 2 y nombre la matriz, y salió ${f.codigo}`)),
  },
  {
    id: 'comillas', ac: 10,
    prepara: (c) => cambioPosterior(c, { ruta: `"${delBackend(CLIENTE)}"` }),
    corre: (c, x) => matriz(c, x.historia),
    juzga: (m) => {
      const r = esperaRojo(m, { nombra: [delBackend(CLIENTE)] });
      if (!r.ok) return r;
      return m.avisos.join('\n').includes(`"${delBackend(CLIENTE)}`) ? falla('el aviso nombra el archivo con sus comillas') : OK;
    },
  },
  {
    id: 'numero-repetido', ac: 11,
    prepara: (c) => {
      const ventas = historiaConEvidencia(c, { id: '1.7', nombre: 'ventas', tema: 'ventas', clave: 'ventas__1.7', archivos: [delBackend('src/Pedidos/Base.cs')], t: T0 + 300 });
      const repo = c.repos['Lab-Historias'];
      const compras = escribir(repo, 'specs/compras/stories/1-7-compras.md', historiaTexto({ id: '1.7', titulo: 'compras', archivos: [delBackend('src/Pedidos/Base.cs')] }));
      commit(c, repo, 'docs: el mismo número en otro tema', T0 + 310);
      return { ventas, compras };
    },
    corre: (c, x) => ({ ventas: matriz(c, x.ventas), compras: matriz(c, x.compras), acs: [] }),
    juzga: (r) => {
      const v = esperaVerde(r.ventas);
      if (!v.ok) return v;
      return r.compras.acs.includes('RUNTIME') ? falla('la historia sin evidencia tomó la de otro tema') : OK;
    },
  },
  {
    id: 'vieja-tras-cambio-de-rama', ac: 12,
    prepara: (c) => {
      const backend = c.repos['Lab-Backend'];
      correrGit(c, backend, ['checkout', '-q', '-b', 'otra-rama']);
      fs.appendFileSync(path.join(backend, 'src/Pedidos/Base.cs'), '// otra rama\n');
      commit(c, backend, 'otra rama', T0 + 4820);
      correrGit(c, backend, ['checkout', '-q', 'main']);
      // la vuelta a main reescribe el archivo: igual al de main, con la fecha de disco posterior a la evidencia
      const abs = path.join(backend, 'src/Pedidos/Base.cs');
      if (fs.readFileSync(abs, 'utf8') !== correrGit(c, backend, ['show', 'HEAD:src/Pedidos/Base.cs']) + '\n') throw new NoMedido('el archivo no quedó como en main');
      if (fs.statSync(abs).mtimeMs / 1000 <= T0 + 40) throw new NoMedido('el archivo no quedó reescrito en disco');
      return { historia: path.join(c.repos['Lab-Historias'], 'specs/cobranza/stories/0-1-alta.md') };
    },
    corre: (c, x) => matriz(c, x.historia),
    juzga: (m) => esperaVerde(m),
  },
  {
    id: 'mismo-repo', ac: 13,
    prepara: (c) => {
      const repo = c.repos['Lab-Historias'];
      correrGit(c, repo, ['checkout', '-q', '-b', 'story/2.1-guion']);
      escribir(repo, 'tools/guion.cs', '// v1\n');
      commit(c, repo, 'feat: guion', T0 + 5100);
      const historia = historiaConEvidencia(c, { id: '2.1', nombre: 'guion', archivos: ['tools/guion.cs'], t: T0 + 5105 });
      correrGit(c, repo, ['push', '-q', 'origin', 'story/2.1-guion'], T0 + 5110);
      correrGit(c, repo, ['checkout', '-q', 'main']);
      fusionar(c, repo, 'story/2.1-guion', 'main', T0 + 5200);
      bajar(c, repo);
      return { historia };
    },
    corre: (c, x) => matriz(c, x.historia),
    juzga: (m) => esperaVerde(m),
  },
  {
    id: 'hermano-atrasado-matriz', ac: 14,
    prepara: (c) => ({ historia: hermanoAtrasado(c, 'forms/nuevo/helper.cs') }),
    corre: (c, x) => matriz(c, x.historia),
    juzga: (m) => esperaRojo(m, { nombra: ['forms/nuevo/helper.cs'], aviso: /no se pud/i }),
  },
  {
    id: 'hermano-atrasado-guia', ac: 15,
    prepara: (c) => ({ historia: hermanoAtrasado(c, 'forms/nuevo/index.tsx') }),
    corre: (c, x) => guia(c, x.historia),
    juzga: (g) => (/atrasad/i.test(g.salida) && /hermano|copia/i.test(g.salida) ? OK : falla('la guía no dice que la copia del hermano puede estar atrasada')),
  },
  {
    id: 'dev-local-vieja', ac: 16,
    prepara: (c) => {
      const backend = c.repos['Lab-Backend'];
      cambiarEnRama(c, backend, 'story/1.20-punta', ENDPOINT, T0 + 5000);
      fusionar(c, backend, 'story/1.20-punta', 'dev', T0 + 5010);
      const punta = correrGit(c, backend, ['ls-remote', 'origin', 'refs/heads/dev']).split(/\s/)[0];
      const carpeta = path.join(c.dir, 'repos', 'Lab-Backend--wt-f-6');
      correrGit(c, backend, ['worktree', 'add', '-q', carpeta, 'dev']);
      fs.mkdirSync(path.join(carpeta, '.tycon'), { recursive: true });
      return { punta, carpeta };
    },
    corre: (c, x) => ({ salida: retroAnotar(c, x.carpeta, 'lab-s1'), registro: registroDeRetro(c), punta: x.punta }),
    juzga: (r) => {
      const anotada = (r.registro.match(/"sha":"([0-9a-f]+)"/) || [])[1];
      if (!anotada) return falla('retro-pending no anotó el pedido');
      if (r.punta.startsWith(anotada) || /no (la )?pud[oe] confirmar/i.test(r.salida)) return OK;
      return falla('reclama un commit que no es la punta real de origin/dev, sin decirlo');
    },
  },
  {
    id: 'carpeta-borrada', ac: 17,
    prepara: (c) => {
      const backend = c.repos['Lab-Backend'];
      const a = path.join(c.dir, 'repos', 'Lab-Backend--wt-f-6');
      const b = path.join(c.dir, 'repos', 'Lab-Backend--slot-1');
      correrGit(c, backend, ['worktree', 'add', '-q', a, 'dev']);
      correrGit(c, backend, ['worktree', 'add', '-q', '--detach', b, 'dev']);
      for (const d of [a, b]) fs.mkdirSync(path.join(d, '.tycon'), { recursive: true });
      return { a, b, backend };
    },
    corre: (c, x) => {
      retroAnotar(c, x.a, 'lab-s1');
      retroAnotar(c, x.b, 'lab-s2');
      const sha = (registroDeRetro(c).match(/"sha":"([0-9a-f]+)"/) || [])[1];
      if (!sha) throw new NoMedido('retro-pending no anotó el pedido');
      correrGit(c, x.backend, ['worktree', 'remove', '--force', x.a]);
      return { salida: retroAviso(c, x.backend), sha };
    },
    juzga: (r) => {
      if (/--wt-f-6/.test(r.salida)) return falla('el aviso nombra una carpeta que ya no existe');
      if (/OTROS proyectos/.test(r.salida)) return falla('reclama el mismo commit dos veces: una como de otro proyecto');
      const todos = [...r.salida.matchAll(/^\s+- .* @ ([0-9a-f]+)/gm)];
      if (!todos.length) throw new NoMedido('el aviso no trae ningún reclamo con la forma «- <carpeta> @ <commit>»');
      const reclamos = todos.filter((x) => x[1] === r.sha).length;
      return reclamos === 1 ? OK : falla(`reclama ese commit ${reclamos} veces`);
    },
  },
  {
    id: 'prueba-de-otra-historia', ac: 34,
    prepara: (c) => cambioPosterior(c, { archivo: PRUEBA }),
    corre: (c, x) => ({ ...matriz(c, x.historia), otra: x.otra }),
    juzga: (m) => {
      const v = esperaVerde(m);
      if (!v.ok) return v;
      const conTodo = m.avisos.some((a) => a.includes(PRUEBA) && /2[.-]5/.test(a) && m.otra.some((s) => a.includes(s)));
      return conTodo ? OK : falla('esperaba un aviso con el archivo, el commit y la historia');
    },
  },
  {
    id: 'prueba-de-la-misma-historia', ac: 35,
    prepara: (c) => cambioPosterior(c, { archivo: PRUEBA, ramaOtra: 'story/1.2-arreglo' }),
    corre: (c, x) => ({ ...matriz(c, x.historia), otra: x.otra }),
    juzga: (m) => esperaRojo(m, { nombra: [PRUEBA], unoDe: [m.otra] }),
  },
  {
    id: 'commit-ajeno-viejo', ac: 36,
    prepara: (c) => {
      const backend = c.repos['Lab-Backend'];
      historiaDelCatalogo(c, '2.6', 'ajena', T0 + 890);
      cambiarEnRama(c, backend, 'story/2.6-ajena', ENDPOINT, T0 + 900);
      const historia = historiaConEvidencia(c, { id: '1.12', nombre: 'evidencia', archivos: [delBackend(ENDPOINT)], t: T0 + 1005 });
      const fusion = fusionar(c, backend, 'story/2.6-ajena', 'main', T0 + 1100);
      bajar(c, backend);
      return { historia, fusion: fusion.slice(0, 7) };
    },
    corre: (c, x) => ({ ...matriz(c, x.historia), fusion: x.fusion }),
    juzga: (m) => esperaRojo(m, { nombra: [delBackend(ENDPOINT), m.fusion] }),
  },
  {
    id: 'fusion-sin-rama', ac: 37,
    prepara: (c) => fusionPropia(c, { asunto: 'Merged PR {n}: consulta de pedidos' }),
    corre: (c, x) => ({ ...matriz(c, x.historia), fusion: x.fusion }),
    juzga: (m) => esperaRojo(m, { nombra: [delBackend(ENDPOINT), m.fusion] }),
  },
  {
    id: 'squash-propio', ac: 38,
    prepara: (c) => {
      const backend = c.repos['Lab-Backend'];
      cambiarEnRama(c, backend, 'story/1.6-squash', ENDPOINT, T0 + 3500);
      const historia = historiaConEvidencia(c, { id: '1.6', nombre: 'squash', archivos: [delBackend(ENDPOINT)], t: T0 + 3505 });
      fusionar(c, backend, 'story/1.6-squash', 'main', T0 + 3600, { squash: true, asunto: 'Merged PR {n}: squash' });
      bajar(c, backend);
      return { historia };
    },
    corre: (c, x) => matriz(c, x.historia),
    juzga: (m) => esperaRojo(m, { nombra: [delBackend(ENDPOINT)], aviso: /squash/i }),
  },
  {
    id: 'numero-repetido-fusion', ac: 39,
    prepara: (c) => {
      const backend = c.repos['Lab-Backend'];
      cambiarEnRama(c, backend, 'story/1.7-ventas', ENDPOINT, T0 + 700);
      cambiarEnRama(c, backend, 'story/1.7', CLIENTE, T0 + 700);
      const ventas = historiaConEvidencia(c, { id: '1.7', nombre: 'ventas', tema: 'ventas', clave: 'ventas__1.7', archivos: [delBackend(ENDPOINT)], t: T0 + 705 });
      const compras = historiaConEvidencia(c, { id: '1.7', nombre: 'compras', tema: 'compras', clave: 'compras__1.7', archivos: [delBackend(CLIENTE)], t: T0 + 715 });
      fusionar(c, backend, 'story/1.7-ventas', 'main', T0 + 800);
      const commitSolo = correrGit(c, backend, ['rev-parse', '--short=7', 'story/1.7']);
      const fusionSolo = fusionar(c, backend, 'story/1.7', 'main', T0 + 810).slice(0, 7);
      bajar(c, backend);
      return { ventas, compras, solo: [fusionSolo, commitSolo] };
    },
    corre: (c, x) => ({ ventas: matriz(c, x.ventas), compras: matriz(c, x.compras), solo: x.solo, acs: [] }),
    juzga: (r) => {
      const v = esperaVerde(r.ventas);
      if (!v.ok) return v;
      return esperaRojo(r.compras, { nombra: [delBackend(CLIENTE)], unoDe: [r.solo] });
    },
  },
  {
    id: 'comentario-sin-sangria', ac: 41,
    prepara: (c) => cambioPosterior(c, { lista: ['files_to_modify:', `  - ${delBackend('src/Pedidos/Base.cs')}`, '# nota', `  - ${delBackend(CLIENTE)}`] }),
    corre: (c, x) => matriz(c, x.historia),
    juzga: (m) => esperaRojo(m, { nombra: [delBackend(CLIENTE)] }),
  },
  {
    id: 'lista-partida', ac: 42,
    prepara: (c) => cambioPosterior(c, { lista: ['files_to_modify: [', `  ${delBackend(CLIENTE)},`, `  "${delBackend('src/Pedidos/Base.cs')}"`, ']'] }),
    corre: (c, x) => matriz(c, x.historia),
    juzga: (m) => esperaRojo(m, { nombra: [delBackend(CLIENTE)] }),
  },
  {
    id: 'ruta-relativa-al-hermano', ac: 40,
    prepara: (c) => {
      const formularios = c.repos['Lab-Formularios'];
      const historia = historiaConEvidencia(c, { id: '1.13', nombre: 'relativa', archivos: ['forms/pedido/helper.cs'], t: T0 + 6000 });
      cambiarEnRama(c, formularios, 'story/2.5-otra', 'forms/pedido/helper.cs', T0 + 6100);
      fusionar(c, formularios, 'story/2.5-otra', 'main', T0 + 6110);
      bajar(c, formularios);
      return { historia };
    },
    corre: (c, x) => matriz(c, x.historia),
    juzga: (m) => esperaRojo(m, { nombra: ['forms/pedido/helper.cs'], aviso: /no se pud/i }),
  },
];

// ---------------------------------------------------------------- correr

function conCarpeta(tmp, prefijo, fn) {
  const padre = tmp || os.tmpdir();
  fs.mkdirSync(padre, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(padre, prefijo)));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function correrCaso(caso, c) {
  const res = { id: caso.id, ac: caso.ac, estado: 'no-medido', motivo: '', llamadas: [], detalle: {} };
  try {
    const x = caso.prepara(c);
    const salida = caso.corre(c, x);
    res.detalle = salida;
    const j = caso.juzga(salida);
    res.estado = j.ok ? 'ok' : 'falla';
    res.motivo = j.motivo || '';
  } catch (e) {
    res.estado = 'no-medido';
    res.motivo = sinCarpeta(c, e.message);
  }
  let llamadas;
  try { llamadas = fs.readFileSync(c.llamadas, 'utf8'); } catch (e) {
    return { ...res, estado: 'no-medido', motivo: `no pude leer las marcas de llamadas: ${e.code}` };
  }
  res.llamadas = llamadas.split('\n').filter(Boolean).map((l) => sinCarpeta(c, l));
  if (res.llamadas.length) {
    res.estado = 'no-medido';
    res.motivo = `llamó afuera: ${res.llamadas[0]}`;
  }
  return res;
}

/** Corre los casos contra una versión del arnés. `solo`: los ids; `casos`: otra lista; `topeMs`: el tope de cada comando. */
function correrCasos({ harness = RAIZ, solo, casos = CASOS, tmp, topeMs = TOPE_MS } = {}) {
  const lista = solo ? casos.filter((k) => solo.includes(k.id)) : casos;
  return conCarpeta(tmp, 'lab-producto-', (raiz) => {
    let base;
    try {
      const dirHerramientas = path.join(raiz, 'herramientas');
      base = contexto(path.join(raiz, 'base'), armarHerramientas(dirHerramientas), topeMs, harness);
      armarBase(base);
    } catch (e) {
      const motivo = `no pude armar el laboratorio: ${sanear(e.message, carpetasDe(raiz, harness))}`;
      return { resultados: lista.map((k) => ({ id: k.id, ac: k.ac, estado: 'no-medido', motivo, llamadas: [], detalle: {} })) };
    }
    const resultados = lista.map((caso, i) => {
      const dir = path.join(raiz, `caso-${i}`);
      try {
        return correrCaso(caso, copiaDeLaBase(base, dir, topeMs, harness));
      } catch (e) {
        return { id: caso.id, ac: caso.ac, estado: 'no-medido', motivo: sanear(e.message, carpetasDe(raiz, harness)), llamadas: [], detalle: {} };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    return { resultados };
  });
}

/** Arma la base en una carpeta temporal, se la pasa a `fn` y la borra. */
function conBase({ tmp } = {}, fn) {
  return conCarpeta(tmp, 'lab-producto-', (raiz) => {
    const c = contexto(path.join(raiz, 'base'), armarHerramientas(path.join(raiz, 'herramientas')), TOPE_MS, RAIZ);
    armarBase(c);
    return fn({ repos: c.repos, git: (repo, args) => correrGit(c, repo, args), entorno: () => entornoDe(c), espejo: gatesLog(c.home) });
  });
}

// ---------------------------------------------------------------- los huecos conocidos

/** La lista de lo que hoy falla y tiene dueño. Lanza si un hueco no dice su motivo o quién lo cierra. */
function leerHuecos(archivo) {
  const { gaps } = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  if (!Array.isArray(gaps)) throw new Error(`${path.basename(archivo)}: falta la lista gaps`);
  for (const h of gaps) {
    if (!h.id) throw new Error('un hueco sin id');
    if (!h.pending) throw new Error(`${h.id}: falta pending, quién lo cierra`);
    if (!h.match) throw new Error(`${h.id}: falta match, el motivo con que falla`);
    try { new RegExp(h.match); } catch (e) { throw new Error(`${h.id}: match no es una expresión: ${e.message}`); }
  }
  return gaps;
}

/**
 * pasa: anda y no está en la lista · conocido: falla por el motivo declarado · rojo: falla por otro motivo o sin estar en la
 * lista · sobra: está en la lista y ya anda, o no tiene caso · no-medido: nunca es conocido.
 */
function juzgarHuecos(resultados, huecos) {
  const porId = new Map(huecos.map((h) => [h.id, h]));
  const salida = resultados.map((r) => {
    const h = porId.get(r.id);
    if (r.estado === 'no-medido') return { id: r.id, veredicto: 'no-medido', mensaje: r.motivo };
    if (r.estado === 'ok') {
      return h
        ? { id: r.id, veredicto: 'sobra', mensaje: `${r.id} ya anda: sacalo de product-lab-known-gaps.json en este mismo pedido (lo cerraba: ${h.pending})` }
        : { id: r.id, veredicto: 'pasa', mensaje: '' };
    }
    if (!h) return { id: r.id, veredicto: 'rojo', mensaje: r.motivo };
    if (new RegExp(h.match).test(r.motivo)) return { id: r.id, veredicto: 'conocido', mensaje: `${r.motivo} (lo cierra: ${h.pending})` };
    return { id: r.id, veredicto: 'rojo', mensaje: `falla por otro motivo que el declarado: ${r.motivo}` };
  });
  const corridos = new Set(resultados.map((r) => r.id));
  for (const h of huecos) if (!corridos.has(h.id)) salida.push({ id: h.id, veredicto: 'sobra', mensaje: `${h.id} no tiene caso: sacalo de product-lab-known-gaps.json` });
  return salida;
}

module.exports = { CASOS, TOPE_MS, rutasDeComandos, correrCasos, conBase, leerHuecos, juzgarHuecos };

// ---------------------------------------------------------------- línea de comandos

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--harness');
  if (i >= 0 && (!argv[i + 1] || argv[i + 1].startsWith('--'))) {
    process.stderr.write('product-lab: --harness necesita la carpeta de una versión del arnés\n');
    process.exit(2);
  }
  const harness = path.resolve(i >= 0 ? argv[i + 1] : RAIZ);
  const { resultados } = correrCasos({ harness });
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({ casos: resultados }, null, 1)}\n`);
  else for (const r of resultados) process.stdout.write(`${r.estado.padEnd(9)} ${r.id}${r.motivo ? ` — ${r.motivo}` : ''}\n`);
  process.exitCode = !resultados.length || resultados.some((r) => r.estado === 'no-medido') ? 2 : 0;
}
