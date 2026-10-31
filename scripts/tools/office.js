#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * office.js — el trabajo en curso de esta máquina dibujado como una oficina en 3D (el comando /office).
 *
 *   node office.js [--open] [--json] [--out <archivo>] [--now <fecha>]
 *
 * Los datos son los de /wip (work-in-progress.js, con los pedidos ya preguntados), las firmas pendientes de la
 * coordinación y la sesión coordinadora designada. Cada sesión es una persona en su escritorio: su nombre, su estado
 * en palabras, la hora de fin con su atraso o adelanto, el avance, lo que hace y lo que hace mientras tanto. El atraso
 * se mide contra la primera hora que se vio para esa sesión y esa story, guardada en `<estado>/office/promises.json`.
 * El panel de la pared cuenta lo pendiente de la máquina: lo que está en curso, las firmas, lo que espera entrar y lo
 * que quedó a medio camino.
 *
 * La página es un solo archivo, sin nada de afuera: la librería 3D (three.js 0.160.0, MIT, en office/vendor/three/)
 * va adentro, y si el navegador no puede dibujar en 3D se ve la tabla. Se escribe en la carpeta temporal; `--open` la
 * abre y `--json` imprime los datos en lugar de escribirla. Sólo mira: no cambia nada del trabajo de las sesiones.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const { designacionVigente } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'critical-waivers.js'));
const { wipNow, sessionsBySid } = require('./work-in-progress.js');
const { readPending } = require('./coordination.js');

const VENDOR = path.join(__dirname, 'office', 'vendor', 'three');
const TEMPLATE = path.join(__dirname, 'office', 'page.html');
// Los módulos de la librería que usa la escena, con el nombre con que se importan. Los archivos están copiados sin
// cambios en una sola carpeta (`extras/`); el nombre con que se importan conserva la ruta original de la librería, que
// es contra la que se resuelven sus importaciones relativas.
const MODULES = {
  three: 'three.module.min.js',
  'three/addons/controls/OrbitControls.js': 'extras/OrbitControls.js',
  'three/addons/geometries/RoundedBoxGeometry.js': 'extras/RoundedGeometry.js',
  'three/addons/postprocessing/EffectComposer.js': 'extras/EffectComposer.js',
  'three/addons/postprocessing/RenderPass.js': 'extras/RenderPass.js',
  'three/addons/postprocessing/UnrealBloomPass.js': 'extras/UnrealBloomPass.js',
  'three/addons/postprocessing/OutputPass.js': 'extras/OutputPass.js',
  'three/addons/postprocessing/Pass.js': 'extras/Pass.js',
  'three/addons/postprocessing/ShaderPass.js': 'extras/ShaderPass.js',
  'three/addons/postprocessing/MaskPass.js': 'extras/MaskPass.js',
  'three/addons/shaders/CopyShader.js': 'extras/CopyShader.js',
  'three/addons/shaders/LuminosityHighPassShader.js': 'extras/LuminosityHighPassShader.js',
  'three/addons/shaders/OutputShader.js': 'extras/OutputShader.js',
};
// Los pasos en que la sesión corre pruebas o revisa: su persona mira la pantalla en lugar de teclear.
const TESTING_STEPS = new Set(['run-tests', 'reviewers', 'adversarial-pass', 'live-check']);
// Una sesión que espera a una persona (un permiso, una respuesta) pide la firma con la mano levantada.
const WAITING_STATUS = /wait|input|permission/i;
const PROMISE_KEEP_MS = 24 * 3600000;
const STALE_END_MS = 12 * 3600000;
const DESKS = 5;

const pad = (n) => String(n).padStart(2, '0');
// La hora local como la lee la página: 'YYYY-MM-DDTHH:MM'.
const localIso = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// Lo que lee el dueño va sin números de historia ni de pedidos: «8.85 · », «8.85-E: », «!6008», «#842» se sacan.
const plain = (t) => (typeof t === 'string' ? t : '')
  .replace(/^\s*\d+(?:\.\d+)+[A-Za-z]?(?:-[A-Za-z0-9]+)?\s*[·:]\s*/, '')
  .replace(/\s*[!#]\d+\b/g, '')
  .trim();

// Una oración llana por sesión: qué está haciendo, sin el detalle técnico de /wip.
function sentenceOf(estado, x, row) {
  if (estado === 'firma') return 'Espera tu respuesta o un permiso.';
  if (estado === 'coordina') return 'Coordina las sesiones de esta máquina.';
  if (x.kind === 'pipeline') {
    const step = (x.steps || []).find((s) => s.id === x.current);
    return step ? `Va por el paso «${step.name}».` : 'Implementa su historia.';
  }
  if (x.kind === 'entering') return 'Terminó: sus cambios están entrando a los repos.';
  if (x.kind === 'stalled') {
    return /choca con main/.test(row.state || '')
      ? 'Terminó, pero sus pedidos no están en la cola y su pedido choca con main.'
      : 'Terminó, pero sus pedidos no están en la cola.';
  }
  // el trabajo suelto y la nota dicen con sus palabras qué hacen
  if ((x.kind === 'loose' || x.kind === 'note') && plain(x.text)) return plain(x.text);
  if (x.kind === 'loose') return 'Hace un trabajo suelto, sin pasos fijos.';
  if (x.kind === 'note') return 'Trabaja en algo de fondo.';
  if (x.kind === 'activity') return 'Trabaja sin pipeline.';
  if (x.kind === 'nomarker') return 'Sigue con algo: tocó archivos hace poco.';
  return 'Trabaja.';
}

function stateOf(x, status, isCoordinator) {
  if (status && WAITING_STATUS.test(status)) return 'firma';
  if (isCoordinator) return 'coordina';
  if (x.kind === 'entering' || x.kind === 'stalled') return 'espera';
  if (x.kind === 'pipeline' && TESTING_STEPS.has(x.current)) return 'prueba';
  return 'trabajando';
}

/**
 * Los datos de la página, sin leer nada: `wip` es lo que devuelve wipNow, `signatures` las firmas pendientes,
 * `coordinatorSid` la sesión coordinadora (o null) y `promises` la primera hora vista de cada sesión y story.
 * Devuelve `{ data, promises }`, con las promesas ya al día para guardarlas.
 */
function buildOffice({ wip, signatures = [], coordinatorSid = null, coordinatorName = null, promises = {}, nowMs = Date.now() }) {
  const kept = {};
  for (const [k, p] of Object.entries(promises || {})) {
    if (p && Number.isFinite(p.at) && Number.isFinite(p.seen) && nowMs - p.seen < PROMISE_KEEP_MS) kept[k] = p;
  }
  const agents = [];
  wip.rows.forEach((row, i) => {
    const d = (wip.details && wip.details[i]) || {};
    const x = (wip.extra && wip.extra[i]) || {};
    const estado = stateOf(x, d.status, Boolean(coordinatorSid) && d.sid === coordinatorSid);
    const titulo = row.work === 'no se ve qué hace' ? null : plain(row.work) || null;
    const a = { nombre: row.session, estado, titulo, haciendo: sentenceOf(estado, x, row), carpeta: row.folder || null };
    // una hora de fin que pasó hace más de STALE_END_MS ya no dice nada: se trata como si no hubiera hora
    const endAt = Number.isFinite(x.endAt) && nowMs - x.endAt <= STALE_END_MS ? x.endAt : null;
    // sin hora, se dice que no la hay: un texto en el lugar de la hora parece una hora
    if (estado !== 'coordina' && endAt == null) a.termina = 'sin hora estimada';
    const meanwhile = plain(x.meanwhile) || plain(row.meanwhile);
    if (meanwhile) { a.mientras = meanwhile; a.mientrasEstado = 'trabajando'; }
    if (x.steps) { a.pasos = x.steps; a.avance = x.progress; }
    if (endAt != null) {
      const key = `${d.sid || row.session}|${x.storyId || ''}`;
      if (!kept[key]) kept[key] = { at: endAt, seen: nowMs };
      kept[key].seen = nowMs;
      a.estimadaIso = localIso(kept[key].at);
      a.pronosticoIso = localIso(endAt);
      if (x.late) a.atrasada = true;
      // la hora pasó y no terminó: el atraso es el de ahora contra la prometida, no el de la hora vieja
      if (endAt < nowMs) { a.atrasoMin = Math.round((nowMs - kept[key].at) / 60000); a.atrasada = true; }
    }
    a.tipo = x.kind || null;
    agents.push(a);
  });
  // la coordinadora quieta no está libre: coordina a las demás
  for (const name of wip.free || []) {
    agents.push(name === coordinatorName
      ? { nombre: name, estado: 'coordina', haciendo: 'Coordina las sesiones de esta máquina' }
      : { nombre: name, estado: 'libre', haciendo: 'Sin trabajo' });
  }
  // un orden fijo para las tarjetas y los escritorios: la coordinadora primero y después por nombre
  agents.sort((p, q) => (q.estado === 'coordina') - (p.estado === 'coordina') || String(p.nombre).localeCompare(String(q.nombre), 'es'));
  agents.forEach((a, i) => { a.orden = i; });

  // lo pendiente es el trabajo de las filas de /wip, no la coordinadora quieta
  const items = agents.filter((a) => a.tipo).map((a) => ({
    titulo: a.titulo || a.haciendo, quien: a.nombre, estimadaIso: a.estimadaIso || null, pronosticoIso: a.pronosticoIso || null,
    estado: a.tipo === 'stalled' ? 'riesgo' : a.estado === 'espera' ? 'espera' : a.estado === 'firma' ? 'firma' : 'curso',
  }));
  for (const s of signatures) {
    if (!s || !s.title) continue;
    items.push({ titulo: `Firma: ${plain(s.title)}`, quien: 'vos', estado: 'firma', estimadaIso: Number.isFinite(s.at) ? localIso(s.at) : null, pronosticoIso: null });
  }
  for (const h of wip.halfway || []) items.push({ titulo: plain(String(h).split(' · limpiar:')[0]), quien: '—', estado: 'riesgo', estimadaIso: null, pronosticoIso: null });
  // «te toca» es sólo lo que pide una firma o una decisión del dueño: lo demás lo hace cada sesión
  const teToca = signatures.filter((s) => s && s.title).map((s) => `Firmar: ${plain(s.title)}`);
  const meta = {
    actualizado: hhmm(nowMs),
    teToca,
    extra: Math.max(0, agents.length - DESKS),
  };
  // la tabla dice lo mismo que las tarjetas, en llano
  const rows = agents.filter((a) => a.tipo).map((a) => ({ work: a.titulo || '', state: a.mientras ? `${a.haciendo} Mientras tanto: ${a.mientras}.` : a.haciendo, end: a.pronosticoIso ? a.pronosticoIso.slice(11) : a.termina || '', session: a.nombre, folder: a.carpeta || '' }));
  return { data: { agents, items, meta, rows, free: wip.free || [], unreadable: wip.unreadable || [] }, promises: kept };
}

// Un módulo de la librería con sus importaciones relativas cambiadas por el nombre con que figura en MODULES: un
// módulo que viene de una dirección `data:` no tiene carpeta contra la cual resolverlas.
function moduleSource(key, rel) {
  const src = fs.readFileSync(path.join(VENDOR, rel), 'utf8');
  if (key === 'three') return src;
  const dir = path.posix.dirname(key);
  return src.replace(/(from\s*|import\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (all, kw, q, spec) => `${kw}${q}${path.posix.normalize(path.posix.join(dir, spec))}${q}`);
}

function importMap() {
  const imports = {};
  for (const [key, rel] of Object.entries(MODULES)) imports[key] = `data:text/javascript;base64,${Buffer.from(moduleSource(key, rel)).toString('base64')}`;
  return JSON.stringify({ imports });
}

/** La página entera, con los datos y la librería adentro. */
function page(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return fs.readFileSync(TEMPLATE, 'utf8')
    .replace('__OFFICE_IMPORTMAP__', () => importMap())
    .replace('__OFFICE_DATA__', () => json);
}

function readPromises(file) {
  try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; }
}

/** Lee todo lo de esta máquina y arma los datos; guarda las promesas al día. */
async function collect(opts = {}) {
  const home = opts.home || os.homedir();
  const sdir = opts.stateDir || stateDir(home);
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const wip = await wipNow(opts);
  const problems = [];
  let signatures = [];
  try { signatures = readPending(home); } catch (e) { problems.push(`las firmas pendientes no se pudieron leer: ${e.message}`); }
  const des = designacionVigente({ dir: sdir });
  if (des && des.error) problems.push(`no se sabe cuál es la coordinadora: ${des.error}`);
  const coordinatorSid = des && des.sesion ? des.sesion : null;
  let coordinatorName = null;
  if (coordinatorSid) {
    const s = sessionsBySid(opts.sessionsDir || path.join(claudeDir(home), 'sessions'), [], null).get(coordinatorSid);
    coordinatorName = s && s.name ? s.name : null;
  }
  const file = path.join(sdir, 'office', 'promises.json');
  const { data, promises } = buildOffice({ wip, signatures, coordinatorSid, coordinatorName, promises: readPromises(file), nowMs });
  data.unreadable.push(...problems);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(promises, null, 2)}\n`);
  } catch (e) { data.unreadable.push(`las horas prometidas no se pudieron guardar (${e.code || e.message}): el atraso se mide contra la hora de ahora`); }
  return data;
}

function openFile(file) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : ['xdg-open', [file]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => process.stderr.write(`office.js: no pude abrirla; abrila a mano: ${file}\n`));
  child.unref();
}

async function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--open') opts.open = true;
    else if (a === '--out' || a === '--now') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { process.stderr.write(`office.js: ${a} pide un valor\n`); return 2; }
      opts[a.slice(2)] = v;
    } else { process.stderr.write(`office.js: opción desconocida ${a}\n`); return 2; }
  }
  let data;
  try { data = await collect({ now: opts.now }); } catch (e) {
    if (e.code === 'NO_STATE' || e.code === 'BAD_ARG') { process.stderr.write(`office.js: ${e.message}\n`); return 2; }
    throw e;
  }
  if (opts.json) { process.stdout.write(`${JSON.stringify(data, null, 2)}\n`); return 0; }
  const file = opts.out ? path.resolve(opts.out) : path.join(os.tmpdir(), 'tycon-office', 'office.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, page(data));
  process.stdout.write(`La oficina está en ${file}\n`);
  if (opts.open) openFile(file);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`office.js: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildOffice, page, importMap, moduleSource, collect, MODULES };
