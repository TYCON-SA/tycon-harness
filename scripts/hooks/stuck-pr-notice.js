#!/usr/bin/env node
'use strict';
// stuck-pr-notice.js — SessionStart: en un repo del arnés, dice en una línea por pedido qué pedidos con auto-completar
// llevan más de una hora trabados. Un pedido con auto-completar que choca con su destino, o que está limpio y no entra,
// no avisa a nadie: se queda abierto días mientras todos creen que ya entró.
//
// A QUÉ REPOS MIRA: todos los del arnés que declara `team-repos.json` del árbol (`public`, `profile`, `operations`,
// `maintainers` y `harness_copies`, sin repetir). Los de `merge_suites` no: son de producto. Sumar un repo ahí lo suma
// al aviso. Los lee por la capa de plataforma (`change-request.list`, scripts/lib/platform/platform.js); un repo cuya
// plataforma no tiene esa operación (`no_soportado`) se calla.
//
// QUÉ ES TRABADO, con auto-completar puesto y visto en el mismo estado y con la misma punta de rama más de una hora:
//   · en choque con su destino, borrador o no;
//   · sin choque y no borrador: limpio, esperando o en un estado que la plataforma no aclara. Un borrador limpio no entra
//     a propósito.
// La plataforma no dice desde cuándo un pedido está así: el reloj es el de este aviso. Guarda por pedido su estado, su
// punta y desde cuándo lo ve así (`stuck-prs.json`); si cambia el estado o la punta, el reloj vuelve a cero. Los pedidos
// que ya no están se borran sólo con una lectura entera del repo.
//
// LA RED: un tope de 5 s para todos los repos juntos, y una foto de la lectura por 10 minutos (`stuck-prs-photo.json`):
// con la foto vigente no sale a la red. Lee sin los controles de cada pedido (`checks: false`) y con la cola donde la
// plataforma la tiene (`queue: true`). Lo que el tope cortó lo termina una lectura de fondo (`--refresh`, con un
// candado para no lanzar dos; TYCON_STUCK_PR_REFRESH_MS, 90 s) que deja la foto entera para el próximo arranque;
// mientras tanto vale la foto anterior de menos de 24 h, con su edad dicha. Sin foto, «no medido» y no toca el estado:
// nunca calla como si no hubiera nada.
//
// LA COLA: un pedido que la plataforma sacó de la cola (sin auto-completar y fuera de ella) sale enseguida y sin reloj,
// con la causa: la CI combinada en rojo, el choque con main, o lo que la plataforma diga. Uno con auto-completar que no
// tiene lugar en la cola lo dice. «Todavía no calculado» no es un estado: conserva el anterior y su reloj.
//
// Muestra 5 pedidos como máximo, los más viejos primero, y el resto como «(+N más)». El texto que viene de la plataforma
// (la rama) se sanea: sin `##` (lo leería un pipeline como una orden) y en una sola línea.
//
// FUERA DE LA COLA DESPUÉS DE UN EMPUJE, en GitHub: uno que ya había pedido entrar (caído de la cola o con auto-merge) y
// recibió una punta nueva lo re-encola la lectura de fondo, una vez por punta, si está aprobado, limpio y en verde
// (`requeued-prs.json`); si no, sale por qué no. Uno caído por choque o porque la cola venció, también con la misma punta.
// Uno caído por pruebas en rojo, o por un motivo que no se conoce, con la misma punta no: volvería a caer; y si no se sabe
// con qué punta cayó, tampoco: no se adivina por fechas. Las dos cosas se dicen. Lo mismo, y las caídas de la cola, le
// llegan a la coordinadora en cada turno.
//
// LISTO Y SIN ENTRAR, en GitHub: un pedido limpio, no borrador, sin auto-merge, fuera de la cola y sin caída registrada,
// igual más de 10 minutos, sale con el comando para encolarlo: nadie lo va a mergear. Lo mismo le llega a la coordinadora en
// cada turno (`coordinatorLines`, desde scripts/tools/coordination.js), de la foto y sin salir a la red. Con una foto de
// más de 10 minutos (en la coordinadora, o en el arranque cuando la lectura en vivo llega a su tope) no se afirma que
// sigue fuera de la cola: pudo entrar después, y con cola GitHub no trae el auto-merge. Se dice de cuándo es la lectura.
//
// SIN CHOQUE Y SIN AUTO-COMPLETAR, en Azure: un pedido no borrador, sin choque y sin auto-completar, igual más de 10
// minutos, sale con el comando para ponerle auto-completar, también en el turno de la coordinadora. La lista de Azure no
// trae sus controles: no se dice «listo», sólo que nadie lo va a completar.
//
// LOS PEDIDOS DE LA PERSONA, para /office: la lectura de fondo deja en `own-prs.json` los pedidos abiertos cuyo autor es la
// persona, de todos sus repos, con una consulta por lugar: una búsqueda en GitHub y una por cada organización de Azure de los
// repos declarados. Quién es sale de las herramientas de la máquina; lo que no se puede saber o leer se dice en `fallos`.
//
// LO DE AFUERA, si el repo `public` es de GitHub: un renglón por cada pedido o issue abierto de gente de afuera del equipo
// («pedido de afuera esperando: #N de <cuenta>, hace X h; su CI espera aprobación»), de scripts/lib/outside-contributions.js
// con la regla del freno de pedidos de afuera. Lo lee la lectura de fondo y lo deja en `outside-contributions.json`; el
// arranque muestra esa foto (con su edad, si pasó de 10 minutos) y, si está vieja, lanza otra. Sin foto de menos de
// 24 h, o con una lectura que no se pudo hacer, «no medido».
//
// Nunca rompe el arranque: sale 0 siempre.
// Variables: TYCON_STUCK_PR_HOURS (1), TYCON_GREEN_IDLE_MIN (10). Off: TYCON_STUCK_PR_NOTICE=0.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const TOPE_MS = 5000;
const FOTO_MS = 10 * 60000;
const MAX_LINEAS = 5;
const HORA_MS = 3600000;
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const readVar = (() => {
  try {
    const { readEnv } = require(path.join(ROOT, 'scripts', 'lib', 'legacy-names.js'));
    return (n) => readEnv(n, { where: 'scripts/hooks/stuck-pr-notice.js' });
  } catch { return (n) => process.env[n]; }
})();

// Lo que llega de la plataforma va al contexto de un agente: en una línea, sin invisibles ni `<>` que armen o cierren un bloque.
const limpio = (t, n) => String(t || '').replace(/#{2,}/g, '#').replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}<>]/gu, '').trim().slice(0, n);

function cwdDelEvento() {
  try {
    const e = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    if (e && typeof e.cwd === 'string' && e.cwd) return e.cwd;
  } catch { /* sin entrada: la carpeta del proceso */ }
  return process.cwd();
}

/** Los repos del arnés de team-repos.json: `{ repos }`, o `{ problema }` si el archivo está pero no se lee. */
function reposDelArnes(tree) {
  const archivo = path.join(tree, 'team-repos.json');
  if (!fs.existsSync(archivo)) return { repos: [] };
  const TR = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
  const r = TR.load(archivo);
  if (!r.ok) { const p = r.problems[0] || {}; return { problema: `team-repos.json: ${p.path ? `${p.path}: ` : ''}${p.message || 'no se lee'}` }; }
  const d = r.data;
  const publico = d.public && d.public.platform === 'github' ? `${d.public.org}/${d.public.repo}` : null;
  const vistos = new Set();
  const repos = [];
  for (const x of [d.public, d.profile, d.operations, d.maintainers, ...(Array.isArray(d.harness_copies) ? d.harness_copies : [])]) {
    const k = TR.identityKey(x);
    if (!k || vistos.has(k)) continue;
    vistos.add(k);
    repos.push(x);
  }
  return { repos, publico };
}

const claveDe = (repo) => [repo.org, repo.project, repo.repo].filter((v) => v != null && v !== '').join('/');

function leerJson(archivo) { try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return null; } }
function escribirJson(archivo, valor) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(valor));
  fs.renameSync(tmp, archivo);
}

// Una lectura que no llegó a hacerse porque se acabó el tope: la sigue la lectura de fondo
const esTope = (r) => Boolean(r && r.ok === false && r.reason === 'no_medido' && /^tope/.test(String(r.detail || '')));
const fotoDe = (dir) => path.join(dir, 'stuck-prs-photo.json');
const candadoDe = (dir) => path.join(dir, 'stuck-prs-refresh.lock');
const refrescoMs = () => { const v = Number(readVar('TYCON_STUCK_PR_REFRESH_MS')); return Number.isFinite(v) && v > 0 ? v : 90000; };

/** Lee los repos con un tope (sin los controles de cada pedido, y con la cola donde la plataforma la tiene). */
async function leer(repos, tree, tope) {
  const platform = require(path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js'));
  const deadlineMs = Date.now() + tope;
  const leidas = {};
  for (const repo of repos) {
    leidas[claveDe(repo)] = await platform.run('change-request.list', { deadlineMs, checks: false, queue: true }, { env: process.env, repo, tree });
  }
  return leidas;
}

/**
 * Las lecturas de cada repo (`{clave: respuesta de la capa}`): de la foto si está vigente y es de estos repos. Si no,
 * lee con el tope; una lectura incompleta no se guarda como foto (la guarda la lectura de fondo) y devuelve la foto
 * anterior, si la hay, para lo que no llegó: `{ leidas, incompleta, anterior }`.
 */
async function lecturas(repos, tree, dir, ahora) {
  const claves = repos.map(claveDe);
  const foto = leerJson(fotoDe(dir));
  const deEstos = Boolean(foto && foto.lecturas && JSON.stringify(foto.repos) === JSON.stringify(claves));
  if (deEstos) {
    const edad = ahora - Date.parse(foto.at);
    if (edad >= 0 && edad < FOTO_MS) return { leidas: foto.lecturas, incompleta: false, anterior: null };
  }
  const leidas = await leer(repos, tree, TOPE_MS);
  const incompleta = Object.values(leidas).some(esTope);
  if (!incompleta) {
    try { escribirJson(fotoDe(dir), { at: new Date(ahora).toISOString(), repos: claves, lecturas: leidas }); } catch { /* sin foto, la próxima lee otra vez */ }
  }
  return { leidas, incompleta, anterior: deEstos ? foto : null };
}

/** Lanza la lectura de fondo, salvo que ya haya una corriendo. Devuelve si quedó una corriendo. */
function lanzarRefresco(tree, dir, home) {
  const candado = leerJson(candadoDe(dir));
  if (candado && Date.now() - Date.parse(candado.at) < refrescoMs() + 30000) return true;
  try {
    escribirJson(candadoDe(dir), { at: new Date().toISOString() });
    const { spawn } = require('child_process');
    // con la casa de quien lo pide: la lectura de fondo deja la foto en su carpeta del estado
    const env = home ? { ...process.env, HOME: home, USERPROFILE: home } : process.env;
    spawn(process.execPath, [__filename, '--refresh', tree], { detached: true, stdio: 'ignore', env, windowsHide: true }).unref();
    return true;
  } catch { return false; }
}

const propiosDe = (dir) => path.join(dir, 'own-prs.json');
const afueraDe = (dir) => path.join(dir, 'outside-contributions.json');

/** La foto de lo de afuera del repo público: `{ at, repo, medicion }`. */
function leerAfuera(publico, tree, ahora) {
  const OC = require(path.join(ROOT, 'scripts', 'lib', 'outside-contributions.js'));
  let medicion;
  try { medicion = OC.measure({ repo: publico, arnes: tree, cwd: tree, now: ahora }); } catch (e) { medicion = { ok: false, reason: `se cayó (${(e && e.message) || e})` }; }
  return { at: new Date(ahora).toISOString(), repo: publico, medicion };
}

/** Los renglones del arranque, de la foto; `vieja` si hace falta otra lectura. */
function lineasDeAfuera(publico, dir, ahora) {
  const OC = require(path.join(ROOT, 'scripts', 'lib', 'outside-contributions.js'));
  const foto = leerJson(afueraDe(dir));
  const edad = foto && foto.repo === publico ? ahora - Date.parse(foto.at) : NaN;
  if (!(edad >= 0 && edad < 24 * HORA_MS) || !foto.medicion) {
    return { vieja: true, lineas: ['pedidos e issues de afuera: no medido (todavía no hay una lectura de hoy; sale en el próximo arranque)'] };
  }
  const lineas = OC.lines(foto.medicion).map((l) => limpio(l, 300));
  if (lineas.length && edad >= FOTO_MS && foto.medicion.ok) lineas.push(`   (lectura de hace ${haceDe(edad)})`);
  return { vieja: edad >= FOTO_MS, lineas };
}
const PROPIOS_TOPE = 1000;
const QUERY_PROPIOS = 'query { viewer { login } search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 100) { nodes { ... on PullRequest { number title isDraft headRefName isInMergeQueue mergeable autoMergeRequest { enabledAt } author { login } repository { nameWithOwner } } } } }';

// En Windows `gh` es gh.exe y se lanza directo: por la consola, gh abre su propia ventana aunque la consola vaya oculta.
// `az` es az.cmd, que sólo corre por la consola: cada argumento entre comillas, y sólo con caracteres que la consola no
// interpreta adentro de ellas (una barra invertida al final escaparía la comilla de cierre). Lo mismo un doble que es un
// `.cmd` o un `.bat`; un doble `.js` corre con Node.
const seguroEnConsola = (args) => args.every((a) => /^[\p{L}\p{N}_ .:/=$@~\\-]+$/u.test(a) && !a.endsWith('\\'));
function llamadaDe(cmd, args, plataforma = process.platform) {
  if (/\.[cm]?js$/i.test(cmd)) return { file: process.execPath, args: [cmd, ...args], shell: false };
  if (plataforma !== 'win32' || !(cmd === 'az' || /\.(cmd|bat)$/i.test(cmd))) return { file: cmd, args, shell: false };
  if (!seguroEnConsola(args)) return { problem: `${path.basename(cmd)}: argumentos con caracteres no seguros para la consola` };
  return { file: cmd.includes(' ') ? `"${cmd}"` : cmd, args: args.map((a) => `"${a}"`), shell: true };
}

function salidaDe(cmd, args, { plataforma = process.platform, run = spawnSync } = {}) {
  const llamada = llamadaDe(cmd, args, plataforma);
  if (llamada.problem) return '';
  const r = run(llamada.file, llamada.args, { encoding: 'utf8', timeout: 30000, windowsHide: true, shell: llamada.shell, maxBuffer: 1 << 26 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}
const jsonDe = (texto) => { try { return JSON.parse(texto); } catch { return null; } };

/** Los pedidos de la persona, de todos sus repos: `{ at, lecturas: { <repo>: { ok, value } }, fallos }`. */
function leerPropios({ repos = [], ahora = Date.now(), env = process.env, plataforma = process.platform, run = spawnSync } = {}) {
  const lecturas = {};
  const fallos = [];
  const anotar = (repo, p) => { (lecturas[repo] = lecturas[repo] || { ok: true, value: [] }).value.push(p); };
  if (repos.some((r) => r.platform === 'github')) {
    const d = jsonDe(salidaDe(env.TYCON_GH_CMD || 'gh', ['api', 'graphql', '-f', `query=${QUERY_PROPIOS}`], { plataforma, run }));
    if (!d || !d.data || !d.data.viewer) fallos.push('GitHub');
    else {
      for (const p of d.data.search.nodes) {
        if (p && p.repository) anotar(p.repository.nameWithOwner, { number: p.number, title: p.title, draft: p.isDraft === true, autoComplete: Boolean(p.autoMergeRequest), inQueue: p.isInMergeQueue === true, mergeState: p.mergeable === 'CONFLICTING' ? 'conflict' : '', sourceBranch: p.headRefName, author: p.author ? p.author.login : '' });
      }
    }
  }
  const organizaciones = [...new Set(repos.filter((r) => r.platform === 'azure').map((r) => r.org))];
  const az = env.TYCON_ADO_CMD || 'az';
  const yo = organizaciones.length ? salidaDe(az, ['account', 'show', '--query', 'user.name', '-o', 'tsv'], { plataforma, run }).toLowerCase() : '';
  for (const org of organizaciones) {
    const d = yo ? jsonDe(salidaDe(az, ['devops', 'invoke', '--org', `https://dev.azure.com/${org}`, '--area', 'git', '--resource', 'pullRequests', '--query-parameters', 'searchCriteria.status=active', `$top=${PROPIOS_TOPE}`, '--api-version', '7.1', '-o', 'json'], { plataforma, run })) : null;
    if (!d || !Array.isArray(d.value)) { fallos.push(org); continue; }
    if (d.value.length >= PROPIOS_TOPE) fallos.push(`${org} (puede faltar alguno: hay más de ${PROPIOS_TOPE} abiertos)`);
    for (const p of d.value) {
      const autor = p.createdBy && String(p.createdBy.uniqueName || '').toLowerCase();
      const r = p.repository;
      if (autor === yo && r && r.project) anotar(`${org}/${r.project.name}/${r.name}`, { number: p.pullRequestId, title: p.title, draft: p.isDraft === true, autoComplete: Boolean(p.autoCompleteSetBy), mergeState: p.mergeStatus === 'conflicts' ? 'conflict' : '', sourceBranch: String(p.sourceRefName || '').replace(/^refs\/heads\//, ''), author: autor });
    }
  }
  return { at: new Date(ahora).toISOString(), lecturas, fallos };
}

/** La lectura de fondo: sin el apuro del arranque, deja la foto entera para el próximo. */
async function refrescar(tree) {
  const dir = stateDirOf(os.homedir());
  try {
    const declarados = reposDelArnes(tree);
    if (declarados.problema || !declarados.repos.length) return;
    const ahora = Date.now();
    const leidas = await leer(declarados.repos, tree, refrescoMs());
    escribirJson(fotoDe(dir), { at: new Date(ahora).toISOString(), repos: declarados.repos.map(claveDe), lecturas: leidas });
    escribirJson(propiosDe(dir), leerPropios({ repos: declarados.repos, ahora }));
    if (declarados.publico) escribirJson(afueraDe(dir), leerAfuera(declarados.publico, tree, ahora));
    reencolarLosListos(dir, declarados.repos, leidas, ahora);
  } finally {
    try { fs.rmSync(candadoDe(dir), { force: true }); } catch { /* vence solo */ }
  }
}

/** «hace 5 min» o «hace 2 h». */
const haceDe = (ms) => (ms < HORA_MS ? `${Math.max(0, Math.floor(ms / 60000))} min` : `${Math.floor(ms / HORA_MS)} h`);
const CAUSAS = { ci: 'la CI combinada salió en rojo', conflict: 'choca con main', timeout: 'la cola venció esperando sus controles' };

const estadoDe = (p) => `${p.mergeState}${p.draft ? '+borrador' : ''}`;

// LISTO Y SIN ENTRAR, en GitHub: abierto, no borrador, limpio (sin choque ni controles obligatorios pendientes), sin
// auto-merge, fuera de la cola y sin caída registrada. Nadie lo va a mergear: queda abierto mientras todos creen que ya
// entró. Se avisa con el comando para encolarlo pasados TYCON_GREEN_IDLE_MIN minutos (10) con la misma punta. En Azure no:
// sin leer sus controles, «limpio» sólo dice que no choca. Los de un bot tampoco: los decide una persona.
const VERDE = 'verde-sin-auto';
const esBot = (a) => /\[bot\]$|^app\/|^(dependabot|renovate)\b/i.test(String(a || ''));
const verdeMin = () => { const v = Number(readVar('TYCON_GREEN_IDLE_MIN')); return Number.isFinite(v) && v > 0 ? v : 10; };
// En un repo con cola de merge, `gh pr merge --merge` no encola (contesta que la cola decide la estrategia): con el
// identificador del pedido, va también la mutación que sí lo encola.
const comandoDeLaCola = (id) => `gh api graphql -f query='${MUTACION_ENCOLAR}' -f id=${id}`;
const comandoParaEncolar = (repo, n, id) => `gh pr merge ${Number(n)} -R ${repo.org}/${repo.repo} --merge`
  + (ID_PEDIDO.test(String(id || '')) ? ` (con cola de merge: ${comandoDeLaCola(id)})` : '');

/**
 * Por qué el análisis de seguridad de un pedido no deja darlo por listo, o null. Lo trae el conector de la plataforma
 * (`codeScanning`: `{ estado, motivo }`); una plataforma que no lo trae, o un repo sin análisis (`no-aplica`), no cambia
 * nada. Cualquier otro estado que no sea `verde` —en rojo, corriendo, sin correr o sin poder leerse— no es listo.
 */
function analisisNoVerde(p) {
  const a = p && p.codeScanning;
  if (!a || a.estado === 'verde' || a.estado === 'no-aplica') return null;
  return limpio(a.motivo || `el análisis de seguridad está ${a.estado}`, 120);
}

/**
 * Los repos cuyo análisis de seguridad la regla de la rama no exige: la cola deja entrar un pedido con él en rojo o sin
 * correr. Una línea por repo, sólo si la plataforma lo dijo (`codeScanningRequired: false`) y hay un pedido con el
 * análisis que no está en verde: sin uno afectado, la línea saldría en cada turno sin decir nada nuevo.
 */
function reglaSinAnalisis(repos, leidas) {
  const lineas = [];
  for (const repo of repos) {
    if (repo.platform !== 'github') continue;
    const r = leidas[claveDe(repo)];
    if (!r || !r.ok || !Array.isArray(r.value)) continue;
    const afectados = r.value.filter((p) => p && p.codeScanningRequired === false && !p.draft && analisisNoVerde(p) && p.codeScanning.estado !== 'sin-mirar');
    const ramas = [...new Set(afectados.map((p) => limpio(p.baseBranch || 'la principal', 60)))];
    const numeros = afectados.map((p) => Number(p.number)).filter(Number.isFinite).sort((a, b) => a - b).join(', ');
    if (ramas.length) lineas.push(`⚠️ ${limpio(repo.repo, 60)}: la regla de ${ramas.join(', ')} no exige el análisis de seguridad, así que la cola deja entrar un pedido con él en rojo o sin correr (hoy: ${numeros}). Exigirlo cambia las reglas del repo: lo decide el dueño.`);
  }
  return lineas;
}

/**
 * Los pedidos listos que nadie encoló, de las lecturas de cada repo: `{ trabados, estado }`. `estado` trae el reloj de
 * cada uno (`<repo>#<n>`), leído de `previo`: con otra punta o recién visto, vuelve a cero. Una lectura fallida conserva
 * los relojes de ese repo, y «todavía no calculado» el de ese pedido: no son un cambio de estado.
 * `lecturaDeHace` (`{ <repo>: ms }`): los repos leídos de una foto de más de FOTO_MS. De ésos no se afirma que el pedido
 * sigue fuera de la cola: pudo entrar después de la foto, y en un repo con cola GitHub no trae el auto-merge.
 */
function verdesSinEntrar(repos, leidas, previo, ahora, minutos = verdeMin(), { lecturaDeHace = {} } = {}) {
  const trabados = [];
  const estado = {};
  for (const repo of repos) {
    if (repo.platform !== 'github' && repo.platform !== 'azure') continue;
    const azure = repo.platform === 'azure';
    const base = claveDe(repo);
    const r = leidas[base];
    if (!r || !r.ok || !Array.isArray(r.value)) {
      for (const k of Object.keys(previo)) if (k.startsWith(`${base}#`) && previo[k] && previo[k].estado === VERDE) estado[k] = previo[k];
      continue;
    }
    for (const p of r.value) {
      if (p.draft || p.autoComplete || p.inQueue === true || p.lastQueueDrop || esBot(p.author)) continue;
      const k = `${base}#${p.number}`;
      const antes = previo[k];
      const mismo = antes && antes.estado === VERDE && antes.punta === p.sourceCommit && Number.isFinite(Date.parse(antes.vistoDesde));
      if (p.mergeStateComputing === true || p.mergeState === 'unknown') { if (mismo) estado[k] = antes; continue; }
      if (p.mergeState !== 'clean') continue;
      const desde = mismo ? antes.vistoDesde : new Date(ahora).toISOString();
      estado[k] = { estado: VERDE, punta: p.sourceCommit, vistoDesde: desde };
      const ms = ahora - Date.parse(desde);
      if (ms < minutos * 60000) continue;
      const creado = Date.parse(p.createdAt);
      const vieja = lecturaDeHace[base];
      // en Azure la lista no trae sus controles: «limpio» sólo dice que no choca, así que no se afirma que está listo.
      // Sin auto-completar nadie lo completa; con él puesto, entra solo cuando sus controles pasen
      // el comando para ponérselo lo da el conector (`autoCompleteCommand`)
      if (azure) {
        trabados.push({ ms, creado: Number.isFinite(creado) ? creado : Infinity, number: p.number,
          linea: `⚠️ pedido ${p.number} (${limpio(repo.repo, 60)}) sin choque y sin auto-completar hace ${haceDe(ms)}${Number.isFinite(vieja) && vieja >= FOTO_MS ? ` según la lectura de hace ${haceDe(vieja)}` : ''}: nadie lo va a completar — ponele auto-completar${p.autoCompleteCommand ? ` con ${limpio(p.autoCompleteCommand, 200)}` : ''} · ${limpio(p.sourceBranch, 120)}` });
        continue;
      }
      // con sus controles requeridos en verde pero el análisis de seguridad no: no está listo, y no se pide encolarlo
      const sinAnalisis = analisisNoVerde(p);
      if (sinAnalisis) {
        trabados.push({ ms, creado: Number.isFinite(creado) ? creado : Infinity, number: p.number,
          linea: `⚠️ pedido ${p.number} (${limpio(repo.repo, 60)}) con los controles requeridos en verde hace ${haceDe(ms)}, pero no está listo: ${sinAnalisis}. No lo encoles hasta que su análisis de seguridad esté en verde y sin alertas · ${limpio(p.sourceBranch, 120)}` });
        continue;
      }
      trabados.push({ ms, creado: Number.isFinite(creado) ? creado : Infinity, number: p.number,
        linea: Number.isFinite(vieja) && vieja >= FOTO_MS
          ? `⚠️ pedido ${p.number} (${limpio(repo.repo, 60)}) listo hace ${haceDe(ms)} según la lectura de hace ${haceDe(vieja)}: no sé si ya entró a la cola; la lectura nueva corre de fondo. Si sigue afuera, se encola con ${comandoParaEncolar(repo, p.number, p.nodeId)} · ${limpio(p.sourceBranch, 120)}`
          : `⚠️ pedido ${p.number} (${limpio(repo.repo, 60)}) listo y sin auto-merge hace ${haceDe(ms)}, fuera de la cola: nadie lo va a mergear — encolalo con ${comandoParaEncolar(repo, p.number, p.nodeId)} · ${limpio(p.sourceBranch, 120)}` });
    }
  }
  return { trabados, estado };
}

// FUERA DE LA COLA DESPUÉS DE UN EMPUJE, en GitHub: un pedido que ya había pedido entrar (se cayó de la cola, o tenía el
// auto-merge puesto) y al que después se le empujó una punta nueva no vuelve solo a la cola. La lectura de fondo lo
// re-encola UNA vez por punta, y sólo si está aprobado (o no exige revisión), limpio (CLEAN) y con todas sus comprobaciones
// en verde; si no, sólo avisa por qué no. Cada intento queda en `requeued-prs.json` (`<repo>#<n>`: punta, cuándo, si salió
// y lo que dijo GitHub). Los de un bot, los borradores y los que ya están en la cola no cuentan.
// el identificador opaco de GitHub (base64: también `+` y `/`); nunca empieza con `-`, así que no se lee como opción
const ID_PEDIDO = /^[A-Za-z0-9_=+/][A-Za-z0-9_=+/-]*$/;
const reencoladosDe = (dir) => path.join(dir, 'requeued-prs.json');
const MUTACION_ENCOLAR = 'mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){mergeQueueEntry{state}}}';

// Las caídas que pueden volver a la cola con la misma punta: el choque (la destino pudo cambiar) y la cola vencida (sus
// controles no llegaron a terminar). Por pruebas en rojo, o por un motivo que no se conoce, la misma punta vuelve a caer.
const CAIDAS_QUE_VUELVEN = new Set(['conflict', 'timeout']);

/**
 * Qué hacer con un pedido que se cayó de la cola, o null si no se cayó: `{ vuelve: true, como }` si se puede re-encolar
 * (`como` dice por qué quedó afuera), `{ vuelve: false, porQueNo }` si no. Decide la punta con que cayó
 * (`lastQueueDrop.commit`): otra punta vuelve, caiga por lo que caiga; la misma, o una que no se sabe, sólo si cayó por
 * choque o porque la cola venció. Sin la punta de la caída no se adivina por las fechas del commit o del empuje.
 */
function decisionDeCaida(p) {
  const d = p.lastQueueDrop;
  if (!d) return null;
  if (d.commit && p.sourceCommit && p.sourceCommit !== d.commit) return { vuelve: true, como: 'después del empuje' };
  if (CAIDAS_QUE_VUELVEN.has(d.cause)) return { vuelve: true, como: `porque ${CAUSAS[d.cause]}` };
  if (d.commit) return { vuelve: false, porQueNo: 'tiene la misma punta con la que cayó; con una punta nueva, sí' };
  return { vuelve: false, porQueNo: 'GitHub no dice con qué punta cayó, y no lo adivino por fechas; si ya tiene el arreglo, encolalo a mano', aMano: true };
}

/**
 * Cuándo había pedido entrar antes de la punta de ahora, o null. Con una caída de la cola decide `decisionDeCaida`; sin
 * ella, el auto-merge puesto antes de la punta, que cuenta desde lo último entre la fecha del commit y la del último
 * empuje forzado (un commit viejo empujado después).
 */
function pidioEntrarAntes(p) {
  const caida = decisionDeCaida(p);
  if (caida) return caida.vuelve ? (p.lastQueueDrop.at || 'la caída') : null;
  if (!p.autoComplete) return null;
  const fechas = [Date.parse(p.headCommittedAt), Date.parse(p.headPushedAt)].filter(Number.isFinite);
  const t = Date.parse(p.autoMergeSince);
  return fechas.length && Number.isFinite(t) && t < Math.max(...fechas) ? p.autoMergeSince : null;
}

/**
 * Cómo quedó fuera de la cola uno que se puede re-encolar: por qué cayó, o el empuje (también el del auto-merge), con
 * hace cuánto llegó esa punta. Sin la hora, «después del empuje» se lee como algo de recién aunque haya sido hace días.
 */
const comoQuedoAfuera = (p, ahora) => {
  const c = decisionDeCaida(p);
  if (c && c.vuelve && c.como !== 'después del empuje') return c.como;
  const t = Math.max(...[Date.parse(p.headCommittedAt), Date.parse(p.headPushedAt)].filter(Number.isFinite));
  return Number.isFinite(t) && Number.isFinite(ahora) ? `después del empuje de hace ${haceDe(Math.max(0, ahora - t))}` : 'después del empuje';
};

/** La línea de una caída de la cola que no vuelve sola: cuándo, por qué cayó y por qué no se re-encola. */
function lineaDeCaida(repo, p, ahora) {
  const d = p.lastQueueDrop;
  const at = Date.parse(d.at);
  const ms = Number.isFinite(at) ? ahora - at : 0;
  const por = CAUSAS[d.cause] || `la plataforma dice «${limpio(d.reason, 40)}»`;
  const caida = decisionDeCaida(p);
  const porQueNo = caida && !caida.vuelve && repo.platform === 'github'
    ? `. No lo re-encolo: ${caida.porQueNo}${caida.aMano ? ` con ${comandoParaEncolar(repo, p.number, p.nodeId)}` : ''}` : '';
  return { ms, linea: `⚠️ pedido ${p.number} (${limpio(repo.repo, 60)}) se cayó de la cola hace ${haceDe(ms)}: ${por}${porQueNo} · ${limpio(p.sourceBranch, 120)}` };
}

/** Los pedidos de una lectura por número: el orden de la respuesta de la plataforma no decide el del aviso. */
const porNumero = (lista) => [...lista].sort((a, b) => Number(a.number) - Number(b.number));

/** Por qué no se re-encola uno que quedó fuera de la cola después del empuje, o null si se puede. */
function motivoParaNo(p) {
  // sólo aprobado, o sin revisión exigida (null); cualquier otra decisión, conocida o no, no se re-encola
  if (p.reviewDecision === 'CHANGES_REQUESTED') return 'le pidieron cambios';
  if (p.reviewDecision === 'REVIEW_REQUIRED') return 'le falta la aprobación';
  if (p.reviewDecision != null && p.reviewDecision !== 'APPROVED') return `la revisión dice ${limpio(p.reviewDecision, 30)}`;
  if (p.mergeStatus !== 'CLEAN') return `no está limpio (${limpio(p.mergeStatus || 'sin estado', 20)})`;
  if (p.ciState !== 'SUCCESS') return `sus comprobaciones no están en verde (${limpio(p.ciState || 'sin leer', 20)})`;
  const sinAnalisis = analisisNoVerde(p);
  if (sinAnalisis) return `su análisis de seguridad no está en verde (${sinAnalisis})`;
  if (!ID_PEDIDO.test(String(p.nodeId || ''))) return 'GitHub no dio su identificador: sin identificador no se puede encolar';
  return null;
}

/**
 * Los pedidos para re-encolar y los que quedaron afuera con su motivo: `{ encolar: [{ clave, repo, number, nodeId,
 * punta }], esperan: [{ clave, linea }] }`. Un pedido ya intentado con la misma punta no se vuelve a intentar.
 */
function paraReencolar(repos, leidas, intentos = {}, ahora = Date.now()) {
  const encolar = [];
  const esperan = [];
  for (const repo of repos) {
    if (repo.platform !== 'github') continue;
    const r = leidas[claveDe(repo)];
    if (!r || !r.ok || !Array.isArray(r.value)) continue;
    for (const p of porNumero(r.value)) {
      if (p.draft || p.inQueue !== false || esBot(p.author) || !pidioEntrarAntes(p)) continue;
      const clave = `${claveDe(repo)}#${p.number}`;
      const motivo = motivoParaNo(p);
      if (motivo) {
        esperan.push({ clave, linea: `⚠️ pedido ${p.number} (${limpio(repo.repo, 60)}) quedó fuera de la cola ${comoQuedoAfuera(p, ahora)}: no lo re-encolo porque ${motivo} · ${limpio(p.sourceBranch, 120)}` });
        continue;
      }
      const antes = intentos[clave];
      if (antes && antes.punta === p.sourceCommit) continue;
      encolar.push({ clave, repo, number: p.number, nodeId: p.nodeId, punta: p.sourceCommit });
    }
  }
  return { encolar, esperan };
}

/** Encola cada uno con la mutación de GitHub y devuelve el intento de cada uno (`{ <clave>: { punta, at, ok, detalle } }`). */
function reencolar(lista, { env = process.env, plataforma = process.platform, run = spawnSync, ahora = Date.now() } = {}) {
  const intentos = {};
  for (const item of lista) {
    const llamada = llamadaDe(env.TYCON_GH_CMD || 'gh', ['api', 'graphql', '-f', `query=${MUTACION_ENCOLAR}`, '-f', `id=${item.nodeId}`], plataforma);
    let ok = false;
    let detalle;
    if (llamada.problem) detalle = llamada.problem;
    else {
      const r = run(llamada.file, llamada.args, { encoding: 'utf8', timeout: 30000, windowsHide: true, shell: llamada.shell });
      const d = r && r.status === 0 ? jsonDe(String(r.stdout || '')) : null;
      const entrada = d && d.data && d.data.enqueuePullRequest && d.data.enqueuePullRequest.mergeQueueEntry;
      ok = Boolean(entrada);
      detalle = ok ? String(entrada.state || '') : limpio((r && (r.stderr || r.stdout)) || (r && r.error && r.error.message) || 'sin respuesta', 160);
    }
    intentos[item.clave] = { punta: item.punta, nodeId: item.nodeId, at: new Date(ahora).toISOString(), ok, detalle };
  }
  return intentos;
}

/**
 * Los intentos anotados: `{ intentos }`, o `{ intentos: {}, problema }` si el archivo está pero no se lee. Ilegible no es
 * «nunca se intentó»: con eso se re-encolaría otra vez la misma punta.
 */
function leerIntentos(dir) {
  const archivo = reencoladosDe(dir);
  if (!fs.existsSync(archivo)) return { intentos: {} };
  const v = leerJson(archivo);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { intentos: {}, problema: `no pude leer los pedidos re-encolados (${archivo})` };
  return { intentos: v };
}

/**
 * Re-encola los listos de la lectura, fallando cerrado: con los intentos ilegibles no hace nada, y cada intento se anota
 * ANTES de llamar a GitHub (si no se puede anotar, no se encola): un intento sin anotar se repetiría en cada lectura.
 */
function reencolarLosListos(dir, repos, leidas, ahora, opciones = {}) {
  const { intentos, problema } = leerIntentos(dir);
  if (problema) return;
  const { encolar } = paraReencolar(repos, leidas, intentos, ahora);
  if (!encolar.length) return;
  const pendientes = Object.fromEntries(encolar.map((e) => [e.clave, { punta: e.punta, nodeId: e.nodeId, at: new Date(ahora).toISOString(), ok: false, detalle: 'sin respuesta todavía' }]));
  try { escribirJson(reencoladosDe(dir), { ...intentos, ...pendientes }); } catch { return; }
  try { escribirJson(reencoladosDe(dir), { ...intentos, ...reencolar(encolar, { ahora, ...opciones }) }); } catch { /* queda el pendiente anotado: no se repite */ }
}

/** Lo que dice cada intento de re-encolar con la punta de ahora, para el aviso. */
function lineasDeReencolado(repos, leidas, intentos, ahora) {
  const lineas = [];
  for (const repo of repos) {
    if (repo.platform !== 'github') continue;
    const r = leidas[claveDe(repo)];
    if (!r || !r.ok || !Array.isArray(r.value)) continue;
    for (const p of porNumero(r.value)) {
      const i = intentos[`${claveDe(repo)}#${p.number}`];
      if (!i || i.punta !== p.sourceCommit || p.inQueue === true || p.draft) continue;
      // se cayó otra vez después del intento: con la misma punta no se intenta de nuevo. Si esa caída no vuelve, ya la
      // dice su propia línea
      const despues = p.lastQueueDrop && Date.parse(p.lastQueueDrop.at) > Date.parse(i.at);
      if (despues && !pidioEntrarAntes(p)) continue;
      const volvio = despues && i.ok;
      const que = volvio ? `lo re-encolé hace ${haceDe(ahora - Date.parse(i.at))} y volvió a caerse; con esta punta no lo intento otra vez`
        : i.ok ? `lo re-encolé hace ${haceDe(ahora - Date.parse(i.at))}`
          : `no pude re-encolarlo (${limpio(i.detalle, 120)}); encolalo a mano${ID_PEDIDO.test(String(i.nodeId || '')) ? ` con ${comandoDeLaCola(i.nodeId)}` : ''}`;
      lineas.push(`⚠️ pedido ${p.number} (${limpio(repo.repo, 60)}) quedó fuera de la cola ${comoQuedoAfuera(p, ahora)}: ${que} · ${limpio(p.sourceBranch, 120)}`);
    }
  }
  return lineas;
}

/** Los que se cayeron de la cola y no tienen una punta nueva después, con su causa: `[linea]`. */
function caidasDeLaCola(repos, leidas, ahora) {
  const lineas = [];
  for (const repo of repos) {
    const r = leidas[claveDe(repo)];
    if (!r || !r.ok || !Array.isArray(r.value)) continue;
    for (const p of porNumero(r.value).filter((x) => x.lastQueueDrop && !x.draft && !x.autoComplete && x.inQueue !== true && !pidioEntrarAntes(x))) {
      lineas.push(lineaDeCaida(repo, p, ahora).linea);
    }
  }
  return lineas;
}

/** El motivo de una lectura fallida, en una línea: lo que contestó la plataforma sin su HTML. */
function motivoBreve(x) {
  const crudo = x ? String(x.detail || x.reason || '') : '';
  return limpio(crudo.replace(/<[^>]*>/g, ' '), 120) || 'sin motivo';
}

/**
 * El aviso de los repos que la última lectura no pudo leer: el motivo de cada uno, cuándo se vuelve a leer y la orden
 * para leerlo ahora. La misma falla sale una vez por hora, no en cada turno (`unread-prs-notice.json` guarda cuál salió y
 * cuándo); una falla distinta, o la misma después de una hora, sale de nuevo. null mientras no le toca.
 */
function avisoSinLeer(dir, sinLeer, tree, now) {
  const archivo = path.join(dir, 'unread-prs-notice.json');
  const firma = sinLeer.join(' · ');
  const previo = leerJson(archivo);
  if (previo && previo.firma === firma && now - Number(previo.at) < HORA_MS) return null;
  try { escribirJson(archivo, { firma, at: now }); } catch { /* sin poder guardarlo, sale en cada turno: mejor que callar */ }
  return `los pedidos listos sin encolar: la última lectura no pudo leer ${firma}. Se vuelve a leer sola cada `
    + `${Math.round(FOTO_MS / 60000)} min; para leer ahora: node "${__filename}" --refresh "${tree}" (no se repite hasta dentro de una hora si sigue igual)`;
}

/**
 * Para el aviso de cada turno de la coordinadora (scripts/tools/coordination.js): los verdes sin entrar, de la foto que
 * dejó la última lectura. No sale a la red: con la foto vencida o sin foto, lanza la lectura de fondo y usa la que hay
 * (o ninguna), y sin una lectura de la última hora lo dice en `problem`. Su reloj vive aparte (`green-prs.json`), para no mover el del arranque. `{ lines, problem }`.
 */
function coordinatorLines({ home = os.homedir(), tree = path.resolve(process.env.TYCON_TREE || ROOT), now = Date.now() } = {}) {
  if (readVar('TYCON_STUCK_PR_NOTICE') === '0') return { lines: [], problem: null };
  const declarados = reposDelArnes(tree);
  if (declarados.problema) return { lines: [], problem: declarados.problema };
  if (!declarados.repos.length) return { lines: [], problem: null };
  const dir = stateDirOf(home);
  const foto = leerJson(fotoDe(dir));
  const deEstos = Boolean(foto && foto.lecturas && JSON.stringify(foto.repos) === JSON.stringify(declarados.repos.map(claveDe)));
  const edad = deEstos ? now - Date.parse(foto.at) : Infinity;
  const lanzada = edad >= 0 && edad < FOTO_MS ? true : lanzarRefresco(tree, dir, home);
  // Una foto de más de una hora no dice si el pedido sigue ahí: no avisa de ninguno, y lo dice, porque callar se leería como
  // «no hay pedidos listos sin encolar».
  if (!deEstos || !(edad < HORA_MS)) {
    return { lines: [], problem: `los pedidos listos sin encolar: sin lectura de la última hora${lanzada ? ', sigue midiendo de fondo' : ' y no pude lanzar la lectura de fondo'}` };
  }
  // lo mismo con un repo que la última lectura no pudo leer
  // (una plataforma sin la operación no es una lectura fallida: se calla, como en el arranque)
  const leida = (r) => { const x = foto.lecturas[claveDe(r)]; return Boolean(x && (x.ok || x.reason === 'no_soportado')); };
  const sinLeer = declarados.repos.filter((r) => (r.platform === 'github' || r.platform === 'azure') && !leida(r))
    .map((r) => `${limpio(r.repo, 60)} (${motivoBreve(foto.lecturas[claveDe(r)])})`);
  const relojArchivo = path.join(dir, 'green-prs.json');
  const previo = leerJson(relojArchivo) || {};
  // con la foto de más de FOTO_MS, ninguno se da por fuera de la cola (la lectura nueva ya se lanzó)
  const lecturaDeHace = edad >= FOTO_MS ? Object.fromEntries(declarados.repos.map((r) => [claveDe(r), edad])) : {};
  const { trabados, estado } = verdesSinEntrar(declarados.repos, foto.lecturas, previo, now, verdeMin(), { lecturaDeHace });
  let problem = sinLeer.length ? avisoSinLeer(dir, sinLeer, tree, now) : null;
  try { escribirJson(relojArchivo, estado); } catch (e) { problem = `no pude guardar desde cuándo está verde cada pedido (${e.code || e.message})`; }
  trabados.sort((a, b) => b.ms - a.ms || a.creado - b.creado || a.number - b.number);
  // las caídas de la cola y lo que pasó con los que quedaron afuera después de un empuje, también en cada turno
  const { intentos, problema: sinIntentos } = leerIntentos(dir);
  if (sinIntentos) problem = problem ? `${problem} · ${sinIntentos}` : sinIntentos;
  const todas = [...reglaSinAnalisis(declarados.repos, foto.lecturas),
    ...caidasDeLaCola(declarados.repos, foto.lecturas, now),
    ...lineasDeReencolado(declarados.repos, foto.lecturas, intentos, now),
    ...paraReencolar(declarados.repos, foto.lecturas, intentos, now).esperan.map((e) => e.linea),
    ...trabados.map((t) => t.linea)];
  const lines = todas.slice(0, MAX_LINEAS);
  if (todas.length > MAX_LINEAS) lines.push(`   (+${todas.length - MAX_LINEAS} más)`);
  return { lines, problem };
}

async function main() {
  if (readVar('TYCON_STUCK_PR_NOTICE') === '0') return;
  const cwd = cwdDelEvento();
  const { esRepoDelArnes } = require(path.join(ROOT, 'scripts', 'lib', 'harness-repo.js'));
  if (!esRepoDelArnes(cwd)) return;
  aplica = true;
  const tree = path.resolve(process.env.TYCON_TREE || ROOT);
  const declarados = reposDelArnes(tree);
  if (declarados.problema) { console.log(`pedidos trabados: no medido (${limpio(declarados.problema, 200)})`); return; }
  if (!declarados.repos.length) return;

  const ahora = Date.now();
  const dir = stateDirOf(os.homedir());
  const { leidas, incompleta, anterior } = await lecturas(declarados.repos, tree, dir, ahora);
  // lo que no llegó a leerse sigue de fondo; mientras tanto vale la foto anterior, con su edad, si tiene esa lectura
  const deFondo = incompleta && lanzarRefresco(tree, dir);
  let fotoVieja = null;
  const lecturaDeHace = {};
  for (const repo of declarados.repos) {
    const k = claveDe(repo);
    const vieja = anterior && anterior.lecturas[k];
    if (esTope(leidas[k]) && vieja && vieja.ok && ahora - Date.parse(anterior.at) < 24 * HORA_MS) {
      leidas[k] = vieja;
      fotoVieja = anterior.at;
      lecturaDeHace[k] = ahora - Date.parse(anterior.at);
    }
  }
  const horas = (() => { const v = Number(readVar('TYCON_STUCK_PR_HOURS')); return Number.isFinite(v) && v > 0 ? v : 1; })();

  const estadoArchivo = path.join(dir, 'stuck-prs.json');
  const guardado = leerJson(estadoArchivo);
  const previo = guardado && typeof guardado === 'object' && !Array.isArray(guardado) ? guardado : {};
  // el estado nuevo es una copia: el reloj de cada pedido se lee del previo
  const estado = { ...previo };
  const sinMedir = [];
  const trabados = [];
  for (const repo of declarados.repos) {
    const base = claveDe(repo);
    const r = leidas[base];
    if (r && r.reason === 'no_soportado') continue;
    if (!r) { sinMedir.push(`${limpio(repo.repo, 60)}: sin lectura`); continue; }
    if (!r.ok) {
      const sigue = esTope(r) && deFondo ? '; sigue midiendo de fondo: sale en el próximo arranque' : '';
      sinMedir.push(`${limpio(repo.repo, 60)}: ${limpio(r.detail || r.reason, 160)}${sigue}`);
      continue;
    }
    // una lectura entera: lo de este repo que ya no está se borra
    for (const k of Object.keys(estado)) if (k.startsWith(`${base}#`)) delete estado[k];
    // se cayó de la cola: un hecho, sale enseguida y sin reloj. Ni borrador, ni de vuelta con auto-completar o en la cola
    for (const p of r.value.filter((x) => x.lastQueueDrop && !x.draft && !x.autoComplete && x.inQueue !== true && !pidioEntrarAntes(x))) {
      const { ms, linea } = lineaDeCaida(repo, p, ahora);
      trabados.push({ ms, creado: Infinity, number: p.number, linea });
    }
    for (const p of r.value.filter((x) => x.autoComplete)) {
      const k = `${base}#${p.number}`;
      const antes = previo[k];
      // «todavía no calculado» no es un estado: conserva el de antes, y su reloj, si la punta es la misma
      const e = p.mergeStateComputing === true && antes && antes.punta === p.sourceCommit ? antes.estado : estadoDe(p);
      const desde = antes && antes.estado === e && antes.punta === p.sourceCommit && Number.isFinite(Date.parse(antes.vistoDesde))
        ? antes.vistoDesde : new Date(ahora).toISOString();
      estado[k] = { estado: e, punta: p.sourceCommit, vistoDesde: desde };
      const ms = ahora - Date.parse(desde);
      const mergeState = e.split('+')[0];
      const enChoque = mergeState === 'conflict';
      if (ms < horas * HORA_MS || (!enChoque && p.draft)) continue;
      // con el umbral bajado a menos de 1 h, la antigüedad va en minutos: «1 h» sería mentira
      const hace = ms < HORA_MS ? `${Math.floor(ms / 60000)} min` : `${Math.floor(ms / HORA_MS)} h`;
      const rama = limpio(p.sourceBranch, 120);
      const creado = Date.parse(p.createdAt);
      trabados.push({ ms, creado: Number.isFinite(creado) ? creado : Infinity, number: p.number, linea: enChoque
        ? `⚠️ pedido ${p.number} (${limpio(repo.repo, 60)}) en choque hace ${hace} · ${rama}`
        : `⚠️ pedido ${p.number} (${limpio(repo.repo, 60)}) con auto-completar no entró hace ${hace} (${limpio(mergeState, 20)}${p.inQueue === false ? ', sin lugar en la cola' : ''}) · ${rama}` });
    }
  }
  // los listos que nadie encoló, con su propio reloj en el mismo estado
  const verdes = verdesSinEntrar(declarados.repos, leidas, previo, ahora, verdeMin(), { lecturaDeHace });
  Object.assign(estado, verdes.estado);
  trabados.push(...verdes.trabados);
  // los que quedaron fuera de la cola después de un empuje: lo que hizo la lectura de fondo, o por qué no los re-encola
  const { intentos, problema: sinIntentos } = leerIntentos(dir);
  if (sinIntentos) console.log(`pedidos re-encolados: ${limpio(sinIntentos, 200)}`);
  for (const linea of [...reglaSinAnalisis(declarados.repos, leidas), ...lineasDeReencolado(declarados.repos, leidas, intentos, ahora), ...paraReencolar(declarados.repos, leidas, intentos, ahora).esperan.map((e) => e.linea)]) {
    trabados.push({ ms: Number.MAX_SAFE_INTEGER, creado: Infinity, number: 0, linea });
  }
  let sinGuardar = false;
  try { escribirJson(estadoArchivo, estado); } catch { sinGuardar = true; }

  if (sinMedir.length) console.log(`pedidos trabados: no medido (${sinMedir.join(' · ')})`);
  if (fotoVieja) console.log(`pedidos trabados: con la foto de hace ${haceDe(ahora - Date.parse(fotoVieja))} (la lectura de ahora no llegó a tiempo y sigue de fondo)`);
  // sin el estado guardado, el reloj vuelve a cero en cada arranque y nunca avisaría: se dice
  if (sinGuardar) console.log('pedidos trabados: no pude guardar desde cuándo está cada pedido (el reloj vuelve a cero)');
  // los más viejos primero; con el mismo reloj (la primera vez que se ven juntos) decide la creación, no el orden de
  // la respuesta de la plataforma
  trabados.sort((a, b) => b.ms - a.ms || a.creado - b.creado || a.number - b.number);
  for (const t of trabados.slice(0, MAX_LINEAS)) console.log(t.linea);
  if (trabados.length > MAX_LINEAS) console.log(`   (+${trabados.length - MAX_LINEAS} más)`);
  if (declarados.publico) {
    const afuera = lineasDeAfuera(declarados.publico, dir, ahora);
    if (afuera.vieja) lanzarRefresco(tree, dir);
    for (const l of afuera.lineas) console.log(l);
  }
}

// Si algo falla después de saber que el repo aplica, se dice; antes, se calla. El arranque nunca se rompe.
let aplica = false;
module.exports = { verdesSinEntrar, analisisNoVerde, reglaSinAnalisis, coordinatorLines, comandoParaEncolar, leerPropios, llamadaDe, salidaDe, paraReencolar, reencolar, reencolarLosListos };
if (require.main !== module) { /* lo usa la coordinadora: no corre el arranque */ } else if (process.argv[2] === '--refresh') {
  refrescar(path.resolve(process.argv[3] || ROOT)).catch(() => { /* la próxima lo intenta otra vez */ }).finally(() => process.exit(0));
} else main().catch((e) => {
  if (aplica) { try { console.log(`pedidos trabados: no medido (${limpio((e && e.message) || e, 160)})`); } catch { /* nada más que hacer */ } }
}).finally(() => process.exit(0));
