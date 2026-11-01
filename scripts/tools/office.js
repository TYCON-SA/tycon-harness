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
 * de una corrida se mide contra su promesa (su arranque más su estimado, del marcador); sin estimado, contra la primera
 * hora que se vio para esa sesión y ese trabajo, guardada en `<estado>/office/promises.json`.
 * El panel de la pared cuenta lo pendiente de la máquina: lo que está en curso, las firmas, lo que espera entrar y lo
 * que quedó a medio camino. Si la coordinadora escribe su tablero en `<estado>/coordination/tablero.json`, la página lo
 * muestra en un panel aparte: los pendientes por grupo, con su hora esperable y quién los tiene, y lo ya hecho.
 *
 * `--open` abre la oficina viva: arranca el proceso local de office/server.js (o reusa el que ya está) y abre su
 * dirección; la página recibe cada cambio por WebSocket. `--out` escribe la foto fija en un archivo, y `--json` imprime
 * los datos. La foto fija es un solo archivo, sin nada de afuera: la librería 3D (three.js 0.160.0, MIT, en
 * office/vendor/three/) va adentro, y si el navegador no puede dibujar en 3D se ve la tabla. Sólo mira: no cambia nada
 * del trabajo de las sesiones.
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
// Hasta 10 escritorios, según cuántas sesiones haya; las demás quedan en las tarjetas de abajo. El tope de sesiones por
// coordinadora no cuenta acá: la oficina muestra todas las de la máquina.
const MAX_DESKS = 10;
// Hasta cinco, los cinco lugares de siempre; más, dos filas de cinco a los costados del sofá: [x, z, giro].
const FIVE = [[5.6, 1.45, 0], [1.95, 3.1, Math.PI / 2], [8.75, 6.9, Math.PI / 2], [1.95, 7.0, Math.PI / 2], [5.3, 8.55, 0]];
const GRID = [1.6, 3.4, 5.2, 7.0, 8.8].flatMap((z) => [[2.6, z, 0], [8.4, z, 0]]);
/** Los lugares de `n` escritorios (como mucho MAX_DESKS). */
const deskSlots = (n) => (n <= FIVE.length ? FIVE : GRID).slice(0, Math.min(n, MAX_DESKS));

const pad = (n) => String(n).padStart(2, '0');
// La hora local como la lee la página: 'YYYY-MM-DDTHH:MM'.
const localIso = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
// La hora como la dice la página: «sáb 19:36».
const dayHhmm = (ms) => `${DAYS[new Date(ms).getDay()]} ${hhmm(ms)}`;
const difTxt = (m) => { const a = Math.abs(m); return a < 60 ? `${a} min` : `${Math.floor(a / 60)} h ${pad(a % 60)}`; };

// Lo que lee el dueño va sin números de historia ni de pedidos: «8.85 · », «8.85-E: », «!6008», «#842» se sacan. El
// título de una historia o de una tanda lo escribió una persona: queda así, entero.
// Una hora al comienzo («10.30: reunión») no es un número de historia, y «#1» no es un pedido: los pedidos tienen
// tres cifras o más.
const HOUR_AT_START = /^\s*(?:[01]?\d|2[0-3])\.[0-5]\d\s*:/;
const unnumbered = (t) => {
  const s = typeof t === 'string' ? t : '';
  return (HOUR_AT_START.test(s) ? s : s.replace(/^\s*\d+(?:\.\d+)+[A-Za-z]?(?:-[A-Za-z0-9]+)?\s*[·:]\s*/, ''))
    .replace(/\s*[!#]\d{3,}\b/g, '')
    .trim();
};
// El texto que escribe una sesión, además, va sin nombres de archivos, rutas, ramas ni identificadores; la preposición
// que los presentaba se va con ellos. El castellano queda: «10-12», «teórico-práctico», «y/o», «ad-hoc», «Node.js».
const CUT = '\u0000';
const FILE_EXT = /\.(?:c?js|mjs|tsx?|jsx|json|md|ya?ml|sh|ps1|cs|csproj|sql|html?|css|txt|log|py|lock|xml|toml|ini|env)$/i;
// Palabras que parecen técnicas y son comunes: las librerías por su nombre («three.js») y las compuestas con un
// conector en el medio («paso-a-paso», «end-to-end»). Un archivo oculto empieza en minúscula; «.NET» no lo es.
const LIBRARY = /^(?:three|node|vue|next|nuxt|d3|chart|express|react|angular|ember|backbone)\.js$/i;
const JOINED = /^\p{L}+(?:-(?:a|al|de|del|en|y|o|to|by|and|or)-\p{L}+)+$/iu;
const technical = (w) =>
  (w.includes('/') && (/\/.*\//.test(w) || /^[.~/]/.test(w) || /[._-]/.test(w)))
  || /^\.[a-z][\w.-]*$/.test(w)
  || (FILE_EXT.test(w) && /^[\w.-]+$/.test(w) && !/^[A-Z][a-z]+\.js$/.test(w) && !LIBRARY.test(w))
  || (/^[a-z0-9_]+(?:-[a-z0-9_]+)+$/.test(w) && !/^\d+(?:-\d+)+$/.test(w) && !JOINED.test(w) && (/\d|_/.test(w) || /-.*-/.test(w)));
const plain = (t) => unnumbered(t)
  .split(/(\s+)/)
  .map((tok) => {
    const core = tok.replace(/^[«"'(]+|[»"'),;:]+$|\.$/g, '');
    return core && technical(core) ? CUT : tok;
  })
  .join('')
  .replace(new RegExp(`\\s+(?:en|de|del|a|al|con|desde|para)\\s+${CUT}`, 'g'), CUT)
  .replace(new RegExp(`\\s*(?:${CUT}\\s*[·,:]?\\s*)+`, 'g'), ' ')
  .replace(/\s+/g, ' ')
  .replace(/^[\s·,:]+|[\s·,:]+$/g, '');

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
    // el título es el de la tanda que corre, entero; sin tanda, el de la historia. Sin carril ni nota no hay título.
    const blind = row.work === 'no se ve qué hace' || x.kind === 'activity' || x.kind === 'nomarker';
    const titulo = blind ? null : unnumbered(x.batch) || unnumbered(x.title) || plain(row.work) || null;
    const a = { nombre: row.session, estado, titulo, haciendo: sentenceOf(estado, x, row), carpeta: row.folder || null };
    if (titulo && unnumbered(x.batch) && unnumbered(x.title)) a.historia = unnumbered(x.title);
    // la promesa que la corrida anotó al arrancar; sin estimado, es también la hora de fin de la que sigue trabajando.
    // La que terminó y espera entrar no la toma: su hora es la de la cola, y sin ella no hay hora (como en /wip)
    const promisedAt = Number.isFinite(x.promisedAt) ? x.promisedAt : null;
    const done = x.kind === 'entering' || x.kind === 'stalled';
    const rawEnd = Number.isFinite(x.endAt) ? x.endAt : done ? null : promisedAt;
    // una hora de fin que pasó hace más de STALE_END_MS ya no dice nada: se trata como si no hubiera hora
    const endAt = Number.isFinite(rawEnd) && nowMs - rawEnd <= STALE_END_MS ? rawEnd : null;
    // lo que terminó y espera la cola no está atrasado: su hora pasada no se muestra. Los pedidos sin encolar no esperan
    // la cola: siguen con su atraso.
    // se mira la hora sin el corte de STALE_END_MS: esperar la cola más de 12 h sigue siendo esperar
    const waiting = Number.isFinite(x.endAt) && x.endAt < nowMs && x.kind === 'entering';
    // sin hora, se dice que no la hay: un texto en el lugar de la hora parece una hora
    if (waiting) a.termina = 'esperando entrar';
    else if (estado !== 'coordina' && endAt == null) a.termina = 'sin hora estimada';
    const meanwhile = plain(x.meanwhile);
    if (meanwhile) { a.mientras = meanwhile; a.mientrasEstado = 'trabajando'; }
    if (x.steps) { a.pasos = x.steps; a.avance = x.progress; }
    a.fin = a.termina ? { hora: a.termina, dif: '', cls: '' } : null;
    if (endAt != null && !waiting) {
      // sin historia, la promesa es del trabajo que se declaró: otro arreglo u otra nota de la misma sesión no la hereda
      const key = `${d.sid || row.session}|${x.storyId || `${x.kind || ''}:${x.text || ''}`}`;
      // la promesa propia de la corrida gana a la primera hora vista: dos corridas vistas a la vez no comparten atraso
      if (promisedAt != null && !done) kept[key] = { at: promisedAt, seen: nowMs };
      else if (!kept[key]) kept[key] = { at: endAt, seen: nowMs };
      kept[key].seen = nowMs;
      a.estimadaIso = localIso(kept[key].at);
      a.pronosticoIso = localIso(endAt);
      if (x.late) a.atrasada = true;
      // la hora pasó y no terminó: el atraso es el de ahora contra la prometida, no el de la hora vieja
      // (o contra la hora vieja, si la prometida todavía no llegó: una hora pasada nunca está en hora)
      if (endAt < nowMs) { a.atrasoMin = Math.max(1, Math.round((nowMs - Math.min(kept[key].at, endAt)) / 60000)); a.atrasada = true; }
      // la hora y su diferencia contra la prometida se calculan acá, una vez: todas las partes de la página dicen esto
      const dd = a.atrasoMin > 0 ? a.atrasoMin : Math.round((endAt - kept[key].at) / 60000);
      a.fin = a.atrasoMin > 0 || dd > 15 ? { hora: dayHhmm(endAt), dif: `+${difTxt(dd)} tarde`, cls: 'late' }
        : dd < -15 ? { hora: dayHhmm(endAt), dif: `${difTxt(dd)} antes`, cls: 'early' }
          : { hora: dayHhmm(endAt), dif: 'en hora', cls: 'ontime' };
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
    titulo: a.titulo || a.haciendo, quien: a.nombre, estimadaIso: a.estimadaIso || null, pronosticoIso: a.pronosticoIso || null, fin: a.fin,
    estado: a.tipo === 'stalled' ? 'riesgo' : a.estado === 'espera' ? 'espera' : a.estado === 'firma' ? 'firma' : 'curso',
  }));
  for (const s of signatures) {
    if (!s || !s.title) continue;
    const at = Number.isFinite(s.at) ? s.at : null;
    items.push({ titulo: `Firma: ${plain(s.title)}`, quien: 'vos', estado: 'firma', estimadaIso: at == null ? null : localIso(at), pronosticoIso: null, fin: at == null ? null : { hora: dayHhmm(at), dif: '', cls: '' } });
  }
  // lo que quedó a medio camino: qué era, en llano, y qué hacer con eso
  for (const h of wip.halfwayItems || []) {
    const accion = h.cleanAfter === 'unknown' ? 'No se sabe desde cuándo se puede limpiar: preguntale a la coordinadora'
      : Number.isFinite(h.cleanAfter) ? `Se puede limpiar después de las ${hhmm(h.cleanAfter)}` : 'Ya se puede limpiar: pedíselo a la coordinadora';
    // el de una corrida es el título de su historia: lo escribió una persona y queda entero
    items.push({ titulo: (h.kind === 'run' ? unnumbered(h.text) : plain(h.text)) || 'Un trabajo sin nombre', quien: '—', estado: 'riesgo', estimadaIso: null, pronosticoIso: null, fin: null, accion });
  }
  // «te toca» es sólo lo que pide una firma o una decisión del dueño: lo demás lo hace cada sesión
  const teToca = signatures.filter((s) => s && s.title).map((s) => `Firmar: ${plain(s.title)}`);
  const meta = {
    actualizado: hhmm(nowMs),
    teToca,
    extra: Math.max(0, agents.length - MAX_DESKS),
    puestos: deskSlots(agents.length),
  };
  // la tabla dice lo mismo que las tarjetas, en llano
  const rows = agents.filter((a) => a.tipo).map((a) => ({ work: a.titulo || '', state: a.mientras ? `${a.haciendo} Mientras tanto: ${a.mientras}.` : a.haciendo, end: a.fin ? a.fin.hora + (a.fin.dif ? ` · ${a.fin.dif}` : '') : '', session: a.nombre, folder: a.carpeta || '' }));
  return { data: { agents, items, meta, rows, free: wip.free || [], unreadable: wip.unreadable || [] }, promises: kept };
}

// El tablero que escribe la coordinadora en `<estado>/coordination/tablero.json`, con lo mismo que su página de
// pendientes: `pendientes` (titulo, estado, grupo, orden, quien, nota, estimadaIso, pronosticoIso, realIso, termina) y
// `meta` (actualizado, resumen, teToca). Sus `agentes` no se usan: los escritorios salen de /wip.
const BOARD_GROUPS = ['Hoy', 'Esta semana', 'La semana que viene', 'Más adelante'];
const BOARD_TEXT_MAX = 300;
const text = (v) => (typeof v === 'string' ? v.trim().slice(0, BOARD_TEXT_MAX) : '');
// la hora local de la página del tablero, 'YYYY-MM-DDTHH:MM', como la dice la oficina: «mar 18:00»
const boardHour = (v) => {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(typeof v === 'string' ? v : '');
  if (!m) return '';
  const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return Number.isFinite(ms) ? dayHhmm(ms) : '';
};

/** Lo que dibuja el panel del tablero, sin leer nada; `raw` es el archivo ya leído. Tira si no tiene la forma. */
function buildBoard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('no es un objeto');
  if (raw.pendientes != null && !Array.isArray(raw.pendientes)) throw new Error('«pendientes» no es una lista');
  const meta = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {};
  const rows = (raw.pendientes || []).filter((p) => p && typeof p === 'object' && text(p.titulo));
  const ord = (p) => (Number.isFinite(p.orden) ? p.orden : Infinity);
  rows.sort((a, b) => ord(a) - ord(b));
  const groups = new Map();
  const done = [];
  for (const p of rows) {
    if (p.estado === 'hecho') { done.push({ titulo: text(p.titulo), quien: text(p.quien), real: boardHour(p.realIso) || 'sin hora' }); continue; }
    const name = text(p.grupo) || 'Sin grupo';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({
      titulo: text(p.titulo), quien: text(p.quien), nota: text(p.nota),
      fin: text(p.termina) || boardHour(p.pronosticoIso) || boardHour(p.estimadaIso) || 'sin hora estimada',
      estado: text(p.estado),
    });
  }
  // los grupos de la semana van en su orden; los demás, después, en el orden en que aparecen
  const names = [...groups.keys()].sort((a, b) => {
    const ia = BOARD_GROUPS.indexOf(a); const ib = BOARD_GROUPS.indexOf(b);
    return (ia < 0 ? BOARD_GROUPS.length : ia) - (ib < 0 ? BOARD_GROUPS.length : ib);
  });
  return {
    actualizado: boardHour(meta.actualizado) || text(meta.actualizado),
    resumen: text(meta.resumen),
    teToca: (Array.isArray(meta.teToca) ? meta.teToca : []).map(text).filter(Boolean),
    grupos: names.map((nombre) => ({ nombre, items: groups.get(nombre) })),
    hechos: done,
  };
}

// El tablero de la coordinadora. Sin archivo, no hay tablero; uno roto o ilegible se dice en `problem`.
function readBoard(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { board: null } : { board: null, problem: `el tablero de la coordinadora no se pudo leer (${e.code || e.message})` };
  }
  try { return { board: buildBoard(JSON.parse(raw)) }; } catch (e) {
    return { board: null, problem: `el tablero de la coordinadora no se pudo leer (${e.message})` };
  }
}

// Un módulo de la librería con sus importaciones relativas cambiadas por el nombre con que figura en MODULES: un
// módulo que viene de una dirección `data:` no tiene carpeta contra la cual resolverlas.
function moduleSource(key, rel) {
  const src = fs.readFileSync(path.join(VENDOR, rel), 'utf8');
  if (key === 'three') return src;
  const dir = path.posix.dirname(key);
  return src.replace(/(from\s*|import\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (all, kw, q, spec) => `${kw}${q}${path.posix.normalize(path.posix.join(dir, spec))}${q}`);
}

// La foto fija lleva la librería adentro; la página del proceso local la pide a su dirección, con el token.
function importMap(live = null) {
  const imports = {};
  for (const [key, rel] of Object.entries(MODULES)) {
    imports[key] = live ? `/modules/${encodeURIComponent(key)}?t=${live.token}` : `data:text/javascript;base64,${Buffer.from(moduleSource(key, rel)).toString('base64')}`;
  }
  return JSON.stringify({ imports });
}

/** La página entera, con los datos; con `live`, además el token para recibir las fotos nuevas del proceso local. */
function page(data, { live = null } = {}) {
  const safe = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  return fs.readFileSync(TEMPLATE, 'utf8')
    // los datos van últimos: un texto de una sesión que diga el nombre de otro marcador no lo reemplaza
    .replace('__OFFICE_IMPORTMAP__', () => importMap(live).replace(/</g, '\\u003c'))
    .replace('__OFFICE_LIVE__', () => safe(live ? { token: live.token } : null))
    .replace('__OFFICE_DATA__', () => safe(data));
}

// La dirección del sitio de la organización, con el mismo lector que el comando /org-site: sale 0 con la dirección,
// 3 si el perfil no la trae y 2 si la configuración no se pudo leer.
function readSiteUrl() {
  const r = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'), 'get', 'site.url'], { input: '', encoding: 'utf8', timeout: 5000 });
  return { code: r.status == null ? 2 : r.status, out: r.status === 0 ? r.stdout : (r.stderr || r.stdout || (r.error && r.error.message) || '') };
}

// Las horas prometidas guardadas. Sin archivo, ninguna; un archivo roto o ilegible se dice en `problem`: tomarlo por
// vacío haría medir los atrasos contra la hora de ahora sin avisar.
function readPromises(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { promises: {} } : { promises: {}, problem: `las horas prometidas no se pudieron leer (${e.code || e.message})` };
  }
  try {
    const p = JSON.parse(text);
    if (p && typeof p === 'object' && !Array.isArray(p)) return { promises: p };
  } catch { /* abajo: lo mismo que un archivo que no es un objeto */ }
  return { promises: {}, problem: 'las horas prometidas no se pudieron leer (el archivo está roto): el atraso se mide desde ahora' };
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
  const saved = readPromises(file);
  if (saved.problem) problems.push(saved.problem);
  const { data, promises } = buildOffice({ wip, signatures, coordinatorSid, coordinatorName, promises: saved.promises, nowMs });
  const board = readBoard(path.join(sdir, 'coordination', 'tablero.json'));
  if (board.problem) problems.push(board.problem);
  data.tablero = board.board;
  data.unreadable.push(...problems);
  // el enlace al sitio, sólo con una dirección web: cualquier otra cosa no se muestra
  let site;
  try { site = await (opts.siteUrl || readSiteUrl)(); } catch (e) { site = { code: 2, out: e.message }; }
  const url = site.code === 0 ? String(site.out || '').trim() : '';
  if (/^https?:\/\/\S+$/i.test(url)) data.meta.sitio = url;
  else if (site.code === 2) data.unreadable.push(`la dirección del sitio no se pudo leer: ${String(site.out || '').trim().split('\n')[0] || 'sin motivo'}`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // entero y después renombrado: otro lector (la foto fija y el proceso vivo leen el mismo) nunca lo ve a medias
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(promises, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) { data.unreadable.push(`las horas prometidas no se pudieron guardar (${e.code || e.message}): el atraso se mide contra la hora de ahora`); }
  return data;
}

// Abre un archivo o una dirección en el navegador, sin shell: en Windows, `rundll32` recibe la ruta como un solo
// argumento, así un `&`, un `|` o un `^` de la ruta no corren otra orden.
function openFile(target, { platform = process.platform, spawn: run = spawn } = {}) {
  const [cmd, args] = platform === 'darwin' ? ['open', [target]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', target]] : ['xdg-open', [target]];
  const child = run(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => process.stderr.write(`office.js: no pude abrirla; abrila a mano: ${target}\n`));
  child.unref();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// El proceso del candado contesta en 1 s, con su pid.
function answers(lock) {
  return new Promise((resolve) => {
    if (!lock || !Number.isInteger(lock.pid) || !Number.isInteger(lock.port) || !isAlive(lock.pid)) { resolve(false); return; }
    const req = require('http').get({ host: '127.0.0.1', port: lock.port, path: `/health?t=${lock.token}`, headers: { host: `127.0.0.1:${lock.port}` }, timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(res.statusCode === 200 && JSON.parse(body).pid === lock.pid); } catch { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * La oficina viva: reusa el proceso local si contesta o arranca uno aparte, y devuelve su dirección. Dos aperturas a la
 * vez no arrancan dos: la que llega segunda espera a la primera y usa su proceso.
 */
async function openLive(home = os.homedir()) {
  const dir = path.join(stateDir(home), 'office');
  const lockFile = path.join(dir, 'server.json');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) { throw new Error(`no puedo escribir el candado en ${dir} (${e.code || e.message})`); }
  const readLock = () => { try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; } };
  const urlOf = (l) => `http://127.0.0.1:${l.port}/?t=${l.token}`;
  const mutex = path.join(dir, 'server.starting');
  for (let i = 0; ; i += 1) {
    try { fs.closeSync(fs.openSync(mutex, 'wx', 0o600)); break; } catch (e) {
      if (e.code !== 'EEXIST') throw new Error(`no puedo escribir el candado en ${dir} (${e.code})`);
      try { if (Date.now() - fs.statSync(mutex).mtimeMs > 15000) fs.unlinkSync(mutex); } catch { /* lo sacó el otro */ }
      if (i > 150) throw new Error('otra apertura de la oficina no terminó en 15 s');
      await sleep(100);
    }
  }
  try {
    const current = readLock();
    if (await answers(current)) return { url: urlOf(current), reused: true };
    const log = path.join(dir, 'server.log');
    const out = fs.openSync(log, 'a', 0o600);
    const child = spawn(process.execPath, [path.join(__dirname, 'office', 'server.js')], { detached: true, stdio: ['ignore', 'ignore', out] });
    fs.closeSync(out);
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    child.unref();
    for (let i = 0; i < 200; i += 1) {
      const lock = readLock();
      if (lock && lock.pid === child.pid && await answers(lock)) return { url: urlOf(lock), reused: false };
      if (exited != null) break;
      await sleep(50);
    }
    let why = 'no contestó en 10 s';
    try { why = fs.readFileSync(log, 'utf8').trim().split('\n').pop() || why; } catch { /* sin registro */ }
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* ya salió */ }
    throw new Error(`la oficina viva ${why}`);
  } finally {
    try { fs.unlinkSync(mutex); } catch { /* ya no está */ }
  }
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
  // --open sin foto fija: la oficina viva, del proceso local
  if (opts.open && !opts.json && !opts.out && !opts.now) {
    let r;
    try { r = await openLive(); } catch (e) { process.stderr.write(`office.js: ${String(e.message).split('\n')[0]}\n`); return 1; }
    process.stdout.write(r.reused ? `La oficina ya estaba abierta: ${r.url}\n` : `La oficina está abierta en ${r.url}\n`);
    if (process.env.TYCON_OFFICE_NO_BROWSER !== '1') openFile(r.url);
    return 0;
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

module.exports = { buildOffice, buildBoard, page, importMap, moduleSource, collect, openFile, openLive, deskSlots, readSiteUrl, MODULES };
