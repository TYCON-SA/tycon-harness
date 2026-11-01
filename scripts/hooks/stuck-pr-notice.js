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
// Nunca rompe el arranque: sale 0 siempre.
// Variables: TYCON_STUCK_PR_HOURS (1). Off: TYCON_STUCK_PR_NOTICE=0.
const fs = require('fs');
const os = require('os');
const path = require('path');

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

const limpio = (t, n) => String(t || '').replace(/#{2,}/g, '#').replace(/\s+/g, ' ').trim().slice(0, n);

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
  const vistos = new Set();
  const repos = [];
  for (const x of [d.public, d.profile, d.operations, d.maintainers, ...(Array.isArray(d.harness_copies) ? d.harness_copies : [])]) {
    const k = TR.identityKey(x);
    if (!k || vistos.has(k)) continue;
    vistos.add(k);
    repos.push(x);
  }
  return { repos };
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
function lanzarRefresco(tree, dir) {
  const candado = leerJson(candadoDe(dir));
  if (candado && Date.now() - Date.parse(candado.at) < refrescoMs() + 30000) return true;
  try {
    escribirJson(candadoDe(dir), { at: new Date().toISOString() });
    const { spawn } = require('child_process');
    spawn(process.execPath, [__filename, '--refresh', tree], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true }).unref();
    return true;
  } catch { return false; }
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
  } finally {
    try { fs.rmSync(candadoDe(dir), { force: true }); } catch { /* vence solo */ }
  }
}

/** «hace 5 min» o «hace 2 h». */
const haceDe = (ms) => (ms < HORA_MS ? `${Math.max(0, Math.floor(ms / 60000))} min` : `${Math.floor(ms / HORA_MS)} h`);
const CAUSAS = { ci: 'la CI combinada salió en rojo', conflict: 'choca con main' };

const estadoDe = (p) => `${p.mergeState}${p.draft ? '+borrador' : ''}`;

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
  for (const repo of declarados.repos) {
    const k = claveDe(repo);
    const vieja = anterior && anterior.lecturas[k];
    if (esTope(leidas[k]) && vieja && vieja.ok && ahora - Date.parse(anterior.at) < 24 * HORA_MS) { leidas[k] = vieja; fotoVieja = anterior.at; }
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
    for (const p of r.value.filter((x) => x.lastQueueDrop && !x.draft && !x.autoComplete && x.inQueue !== true)) {
      const d = p.lastQueueDrop;
      const at = Date.parse(d.at);
      const ms = Number.isFinite(at) ? ahora - at : 0;
      const por = CAUSAS[d.cause] || `la plataforma dice «${limpio(d.reason, 40)}»`;
      trabados.push({ ms, creado: Infinity, number: p.number,
        linea: `⚠️ pedido ${p.number} (${limpio(repo.repo, 60)}) se cayó de la cola hace ${haceDe(ms)}: ${por} · ${limpio(p.sourceBranch, 120)}` });
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
}

// Si algo falla después de saber que el repo aplica, se dice; antes, se calla. El arranque nunca se rompe.
let aplica = false;
if (process.argv[2] === '--refresh') {
  refrescar(path.resolve(process.argv[3] || ROOT)).catch(() => { /* la próxima lo intenta otra vez */ }).finally(() => process.exit(0));
} else main().catch((e) => {
  if (aplica) { try { console.log(`pedidos trabados: no medido (${limpio((e && e.message) || e, 160)})`); } catch { /* nada más que hacer */ } }
}).finally(() => process.exit(0));
