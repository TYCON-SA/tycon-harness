#!/usr/bin/env node
'use strict';
/*
 * board.js — la única forma de escribir el tablero de la oficina (`<estado>/coordination/tablero.json`).
 *
 * Cada guardado valida todas las filas y no escribe nada si alguna rompe una regla. A cada fila sin `id` le da su número,
 * `T-<n>`, que no cambia nunca ni se reusa: el contador vive aparte (`tablero-numeros.json`), con el título de cada número
 * dado, así una fila que perdió su `id` lo recupera por su título. Escribe en un archivo aparte y lo renombra, con un
 * candado: otra escritura al mismo tiempo espera o falla con su motivo. Si el tablero cambió entre la lectura y el
 * renombre (también una edición a mano), no escribe. Anota la huella de lo que escribió (`tablero-huella.json`): la
 * oficina avisa si el archivo cambió sin el comando.
 *
 * `sync` mueve las filas con los hechos de la foto de la oficina (una sesión que arranca su historia, que espera al
 * dueño, un pedido que entra a main, uno abandonado, una ejecución cortada). Aplica cada hecho una vez: su clave queda en
 * la fila (`ultimoHecho`), y una corrección a mano no se pisa hasta que llega otro. Nunca borra una fila, nunca cambia su
 * título ni su hora prometida, y una fila hecha no vuelve atrás. Con una lectura incompleta no aplica lo que sale de no
 * ver algo. Sobre un tablero sin números o con una regla rota no escribe y avisa.
 *
 * Uso:
 *   board.js save --from <archivo>                 el tablero entero, desde el archivo aparte de la coordinadora
 *   board.js add titulo=… [campo=valor…]           una fila nueva
 *   board.js set <T-n> campo=valor…                cambia una fila
 *   board.js close <T-n> [--real AAAA-MM-DDTHH:MM] la cierra: hecho, con la hora de ahora o la dada
 *   board.js check                                 valida sin escribir
 *   board.js sync --facts <archivo> [--complete]   aplica hechos (lo llama la oficina)
 *   [--state-dir <carpeta>]                        otra carpeta de estado (pruebas)
 * Sale 0 si escribió (o si `check` no encontró nada), 2 si no escribió por una regla, un candado o un cambio.
 *
 * Casos: scripts/tests/office-task-numbers.test.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir, claudeDir } = require(path.join(__dirname, '..', '..', 'setup', 'harness', 'tycon-home.js'));

const ESTADOS = ['hecho', 'curso', 'firma', 'riesgo', 'entrando', 'sin-empezar', 'espera'];
const GROUPS = ['Hoy', 'Esta semana', 'La semana que viene', 'Más adelante'];
const ID = /^T-([1-9]\d*)$/;
const LOCAL_HOUR = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
// la forma y además una hora que existe: «2026-02-30T25:99» tiene la forma, pero la oficina la correría a otro día
function validLocalHour(s) {
  if (!LOCAL_HOUR.test(s)) return false;
  const [y, mo, d, h, mi] = s.split(/[-T:]/).map(Number);
  const t = new Date(y, mo - 1, d, h, mi);
  return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d && t.getHours() === h && t.getMinutes() === mi;
}
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30 * 1000;
const FACTS_KEPT = 500;
// los campos que `set` y `add` aceptan; `ultimoHecho` lo escribe sólo `sync`
const FIELDS = ['titulo', 'estado', 'grupo', 'orden', 'quien', 'nota', 'pronosticoIso', 'termina', 'realIso', 'historia', 'tema', 'pedido'];

const pad = (n) => String(n).padStart(2, '0');
const localIso = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const numOf = (id) => { const m = ID.exec(String(id || '')); return m ? Number(m[1]) : null; };

function paths(sdir) {
  const dir = path.join(sdir, 'coordination');
  return { dir, board: path.join(dir, 'tablero.json'), numbers: path.join(dir, 'tablero-numeros.json'), print: path.join(dir, 'tablero-huella.json'), facts: path.join(dir, 'tablero-hechos.json'), lock: path.join(dir, 'tablero.lock') };
}

/** Normaliza lo que se escribe para nombrar una fila: `41`, `T-41` o `t-41` es `T-41`; otra cosa, null. */
function taskId(v) {
  const m = /^(?:t-)?([1-9]\d*)$/i.exec(String(v || '').trim());
  return m ? `T-${m[1]}` : null;
}

/** Las filas en el orden en que la oficina las muestra: los grupos de la semana, los demás después; adentro, por `orden`. */
function orderRows(rows) {
  const others = [];
  for (const p of rows) { const g = str(p.grupo); if (!GROUPS.includes(g) && !others.includes(g)) others.push(g); }
  const place = (p) => { const g = str(p.grupo); const i = GROUPS.indexOf(g); return i < 0 ? GROUPS.length + others.indexOf(g) : i; };
  const ord = (p) => (Number.isFinite(p.orden) ? p.orden : Infinity);
  return rows.map((p, i) => ({ p, i })).sort((a, b) => place(a.p) - place(b.p) || ord(a.p) - ord(b.p) || a.i - b.i).map((x) => x.p);
}

function readJson(file, empty) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { value: empty, text: null }; throw new Error(`${path.basename(file)} no se pudo leer (${e.code || e.message})`); }
  try { return { value: JSON.parse(raw), text: raw }; } catch (e) { throw new Error(`${path.basename(file)} está roto (${e.message})`); }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ya no está */ } throw e; }
}

/** El contador: `{ ultimo, dados: { "T-7": "<título>" } }`. Sin archivo, en cero. */
function readNumbers(sdir) {
  const { value } = readJson(paths(sdir).numbers, null);
  if (!value || typeof value !== 'object') return { ultimo: 0, dados: {} };
  return { ultimo: Number.isInteger(value.ultimo) && value.ultimo >= 0 ? value.ultimo : 0, dados: value.dados && typeof value.dados === 'object' ? value.dados : {} };
}

/** El tablero crudo y su texto; sin archivo, uno vacío. Tira si no se puede leer o no tiene la forma. */
function readBoardRaw(sdir) {
  const { value, text } = readJson(paths(sdir).board, null);
  if (value === null) return { raw: { pendientes: [] }, text: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('el tablero no es un objeto');
  if (value.pendientes != null && !Array.isArray(value.pendientes)) throw new Error('«pendientes» no es una lista');
  return { raw: { ...value, pendientes: value.pendientes || [] }, text };
}

// Corre `fn` con el candado del tablero, con `mkdir`: una escritura a la vez en la máquina. Uno viejo se saca.
function withLock(sdir, fn) {
  const lock = paths(sdir).lock;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let old = false;
      try { old = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { continue; }
      if (old) { try { fs.rmdirSync(lock); } catch { /* otro lo sacó */ } continue; }
      if (Date.now() >= until) return { code: 2, lines: ['⛔ el tablero lo está escribiendo otro proceso desde hace más de 5 s: volvé a correrlo'] };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* ya no está */ } }
}

const nameOf = (r) => (r.id ? `${r.id} «${str(r.titulo)}»` : `«${str(r.titulo) || 'sin título'}»`);

/** Lo que rompe cada fila: `[{ fila, regla }]`. `ultimo`: el número más alto dado. */
function rowProblems(rows, { ultimo }) {
  const out = [];
  const seen = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { out.push({ fila: '(una fila)', regla: 'no es un objeto' }); continue; }
    const fila = nameOf(r);
    // la oficina no dibuja una fila sin título: quedaría con su número y sin verse
    if (!str(r.titulo)) out.push({ fila, regla: 'una fila lleva título' });
    if (r.id != null) {
      const n = numOf(r.id);
      if (n == null) out.push({ fila, regla: `su número «${r.id}» no tiene la forma T-<número>` });
      else if (n > ultimo) out.push({ fila, regla: `su número ${r.id} es más alto que el último dado (T-${ultimo})` });
      else seen.set(r.id, [...(seen.get(r.id) || []), fila]);
    }
    if (r.pedido != null && !(r.pedido && typeof r.pedido === 'object' && str(r.pedido.repo) && Number.isInteger(r.pedido.numero) && r.pedido.numero > 0)) out.push({ fila, regla: 'el pedido va como { repo: texto, numero: entero }' });
    if (!ESTADOS.includes(r.estado)) out.push({ fila, regla: `el estado «${r.estado == null ? '' : r.estado}» no es uno de ${ESTADOS.join(', ')}` });
    if (r.estado === 'hecho' && !validLocalHour(str(r.realIso))) out.push({ fila, regla: 'una fila hecha lleva realIso (AAAA-MM-DDTHH:MM, una hora que exista)' });
    if (r.estimadaIso != null) out.push({ fila, regla: 'estimadaIso no va: la hora es pronosticoIso o termina' });
  }
  for (const [id, filas] of seen) if (filas.length > 1) out.push({ fila: filas.join(' y '), regla: `el número ${id} está repetido` });
  return out;
}
const problemLines = (ps) => ps.map((p) => `   · ${p.fila}: ${p.regla}`);

/**
 * Numera las filas sin `id`, en el orden de la oficina. Una sin `id` cuyo título es el de un número dado que no está en
 * estas filas lo recupera. Devuelve las filas, el contador nuevo y lo que hizo.
 */
function numberRows(rows, numbers) {
  const present = new Set(rows.map((r) => r.id).filter(Boolean));
  const free = new Map();
  for (const [id, titulo] of Object.entries(numbers.dados)) {
    if (present.has(id) || numOf(id) == null) continue;
    const k = str(titulo);
    // con dos números del mismo título, el último que se dio
    if (!free.has(k) || numOf(id) > numOf(free.get(k))) free.set(k, id);
  }
  let ultimo = numbers.ultimo;
  const dados = { ...numbers.dados };
  const numeradas = [];
  const recuperadas = [];
  for (const r of orderRows(rows)) {
    if (r.id) { dados[r.id] = str(r.titulo); continue; }
    const back = free.get(str(r.titulo));
    if (back) { r.id = back; free.delete(str(r.titulo)); recuperadas.push(r.id); } else { ultimo += 1; r.id = `T-${ultimo}`; numeradas.push(r.id); }
    dados[r.id] = str(r.titulo);
  }
  return { numbers: { ultimo, dados }, numeradas, recuperadas };
}

/** Las sesiones vivas de la máquina con lo que dice cada una que hace: `[{ nombre, texto }]`. Sin dato, lista vacía. */
function liveSessions(home, sdir) {
  try {
    const map = require(path.join(__dirname, '..', 'work-in-progress.js')).sessionsBySid(path.join(claudeDir(home), 'sessions'), [], null);
    const out = [];
    for (const [sid, s] of map) {
      if (!s || !s.alive || !s.name) continue;
      let texto = '';
      try { texto = String(JSON.parse(fs.readFileSync(path.join(sdir, 'doing', `${sid}.json`), 'utf8')).text || ''); } catch { /* sin nota */ }
      out.push({ nombre: s.name, texto });
    }
    return out;
  } catch { return []; }
}

// Una fila en curso, firma o entrando cuyo `quien` es una sesión viva que no dice su número en lo que hace.
function quienWarnings(rows, live) {
  const out = [];
  for (const r of rows) {
    if (!['curso', 'firma', 'entrando'].includes(r.estado) || !str(r.quien) || !r.id) continue;
    const s = live.find((x) => x.nombre.toLowerCase() === str(r.quien).toLowerCase());
    if (s && !new RegExp(`(^|[^\\w-])${r.id}(?![\\w])`, 'i').test(s.texto)) out.push(`⚠️  ${s.nombre} no dice ${r.id} en lo que hace: encargáselo con el número, o la fila se ve en Sin sesión`);
  }
  return out;
}

/**
 * Escribe el tablero que devuelve `change(raw)` con el candado. `change` recibe el tablero crudo leído adentro del candado
 * y devuelve `{ raw, lines }` o `{ code, lines }` para no escribir. Valida, numera, escribe aparte y renombra.
 */
function write(sdir, change, { now = Date.now(), live = null, home = os.homedir(), beforeRename = null, afterRename = null } = {}) {
  return withLock(sdir, () => {
    let current;
    let numbers;
    let numbersText;
    try { current = readBoardRaw(sdir); numbers = readNumbers(sdir); numbersText = readJson(paths(sdir).numbers, null).text; } catch (e) { return { code: 2, lines: [`⛔ ${e.message}: no escribí nada`] }; }
    const res = change(current.raw, numbers);
    if (res.code != null) return res;
    const raw = res.raw;
    const rows = raw.pendientes;
    const problems = rowProblems(rows, numbers);
    if (problems.length) return { code: 2, lines: ['⛔ no escribí nada: estas filas rompen una regla', ...problemLines(problems)] };
    const n = numberRows(rows, numbers);
    const text = `${JSON.stringify({ ...raw, pendientes: rows }, null, 2)}\n`;
    const p = paths(sdir);
    // el contador va antes que el tablero: un tablero con números que el contador no tiene los daría otra vez. Si el
    // tablero no se escribe, el contador vuelve a como estaba y esos números no se gastan
    const undoNumbers = () => { try { if (numbersText == null) fs.unlinkSync(p.numbers); else writeAtomic(p.numbers, numbersText); } catch { /* el próximo guardado lo recupera por título */ } };
    writeAtomic(p.numbers, `${JSON.stringify(n.numbers, null, 2)}\n`);
    const tmp = `${p.board}.${process.pid}.tmp`;
    let again = null;
    try {
      fs.writeFileSync(tmp, text);
      if (beforeRename) beforeRename();
      try { again = fs.readFileSync(p.board, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (again !== current.text) { try { fs.unlinkSync(tmp); } catch { /* ya no está */ } undoNumbers(); return { code: 2, lines: ['⛔ el tablero cambió mientras guardaba: volvé a correrlo'] }; }
      fs.renameSync(tmp, p.board);
    } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ya no está */ } undoNumbers(); throw e; }
    writeAtomic(p.print, `${JSON.stringify({ sha: sha(text), at: new Date(now).toISOString() })}\n`);
    const lines = [...(res.lines || [])];
    if (afterRename) lines.push(...afterRename(rows));
    if (n.numeradas.length) lines.push(`numeré ${n.numeradas.length}: ${n.numeradas.join(', ')}`);
    if (n.recuperadas.length) lines.push(`recuperé por su título: ${n.recuperadas.join(', ')}`);
    lines.push(...quienWarnings(rows, live || liveSessions(home, sdir)));
    return { code: 0, lines: [`✅ tablero guardado (${rows.length} filas)`, ...lines] };
  });
}

/** El tablero entero, desde lo que armó la coordinadora. */
function save(sdir, raw, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.pendientes != null && !Array.isArray(raw.pendientes))) return { code: 2, lines: ['⛔ el archivo no es un tablero: un objeto con «pendientes», una lista'] };
  return write(sdir, () => ({ raw: { ...raw, pendientes: (raw.pendientes || []).map((r) => (r && typeof r === 'object' ? { ...r } : r)) } }), opts);
}

// `campo=valor` a una fila. `pedido=repo#12` es `{ repo, numero }`; `orden` es un número; `campo=` lo saca.
function applyFields(r, pairs) {
  for (const kv of pairs) {
    const i = kv.indexOf('=');
    const k = i < 0 ? kv : kv.slice(0, i);
    const v = i < 0 ? '' : kv.slice(i + 1);
    if (!FIELDS.includes(k)) return `no conozco el campo «${k}»: van ${FIELDS.join(', ')}`;
    if (v === '') { delete r[k]; continue; }
    if (k === 'pedido') {
      const m = /^(.+)#(\d+)$/.exec(v);
      if (!m) return 'el pedido va como repo#número';
      r.pedido = { repo: m[1].trim(), numero: Number(m[2]) };
    } else if (k === 'orden') {
      if (!Number.isFinite(Number(v))) return 'el orden es un número';
      r.orden = Number(v);
    } else r[k] = v;
  }
  return null;
}

function add(sdir, pairs, opts = {}) {
  return write(sdir, (raw) => {
    const r = {};
    const bad = applyFields(r, pairs);
    if (bad) return { code: 2, lines: [`⛔ ${bad}`] };
    if (!str(r.titulo)) return { code: 2, lines: ['⛔ una fila nueva lleva titulo=…'] };
    // una sola fila abierta por historia: si ya hay, se cambia esa
    const same = r.historia ? raw.pendientes.find((x) => x && x.historia === r.historia && x.estado !== 'hecho') : null;
    if (same) return { code: 2, lines: [`⛔ ya hay una fila abierta de la historia ${r.historia}: ${nameOf(same)}. Cambiala con set ${same.id || ''}`.trim()] };
    return { raw: { ...raw, pendientes: [...raw.pendientes, r] } };
  }, opts);
}

function findRow(raw, id) {
  const want = taskId(id);
  return want ? raw.pendientes.find((r) => r && r.id === want) : null;
}

function set(sdir, id, pairs, opts = {}) {
  return write(sdir, (raw) => {
    const r = findRow(raw, id);
    if (!r) return { code: 2, lines: [`⛔ no hay una fila ${taskId(id) || id} en el tablero`] };
    const bad = applyFields(r, pairs);
    return bad ? { code: 2, lines: [`⛔ ${bad}`] } : { raw };
  }, opts);
}

function close(sdir, id, { real = null, ...opts } = {}) {
  if (real != null && !validLocalHour(real)) return { code: 2, lines: ['⛔ --real va como AAAA-MM-DDTHH:MM, con una hora que exista'] };
  return write(sdir, (raw) => {
    const r = findRow(raw, id);
    if (!r) return { code: 2, lines: [`⛔ no hay una fila ${taskId(id) || id} en el tablero`] };
    r.estado = 'hecho';
    r.realIso = real || localIso(opts.now || Date.now());
    return { raw };
  }, opts);
}

/** Valida el tablero que hay, sin escribir. */
function check(sdir) {
  let current;
  let numbers;
  try { current = readBoardRaw(sdir); numbers = readNumbers(sdir); } catch (e) { return { code: 2, lines: [`⛔ ${e.message}`] }; }
  const ps = rowProblems(current.raw.pendientes, numbers);
  const sin = current.raw.pendientes.filter((r) => r && !r.id);
  if (sin.length) ps.push({ fila: sin.map(nameOf).join(', '), regla: 'sin número: guardalo una vez con board.js save --from <tu archivo aparte>' });
  return ps.length ? { code: 2, lines: ['⛔ el tablero tiene filas que rompen una regla', ...problemLines(ps)] } : { code: 0, lines: [`✅ el tablero está sano (${current.raw.pendientes.length} filas)`] };
}

// ── Los hechos ───────────────────────────────────────────────────────────────────────────────────────────────────────

const samePr = (a, b) => a && b && str(a.repo).toLowerCase() === str(b.repo).toLowerCase() && Number(a.numero) === Number(b.numero);
const openRow = (r) => r && r.estado !== 'hecho';
// lo que sale de no ver algo: con una lectura incompleta no se aplica
const fromAbsence = (f, r) => f.tipo === 'abandonado' || f.tipo === 'cortada' || (f.tipo === 'curso' && r && r.estado === 'firma');

/**
 * Los hechos de merge de cada trabajo: `[{ historia?, tarea?, pedidos: [{ repo, numero, state, mergedAt }] }]`. Sale un
 * hecho sólo cuando entraron todos sus pedidos y no queda ninguno abierto, con la hora del último.
 */
function mergeFacts(works) {
  const out = [];
  for (const w of works) {
    const ps = (w.pedidos || []).filter((p) => p && p.state);
    if (!ps.length || ps.some((p) => p.state !== 'merged')) continue;
    const last = ps.reduce((a, b) => (b.mergedAt > a.mergedAt ? b : a));
    out.push({ tipo: 'merge', clave: `merge:${ps.map((p) => `${str(p.repo).toLowerCase()}#${p.numero}`).sort().join(',')}`, ...(w.historia ? { historia: w.historia } : {}), ...(w.tarea ? { tarea: w.tarea } : {}), pedido: { repo: last.repo, numero: last.numero }, at: last.mergedAt });
  }
  return out;
}

// La fila de un hecho: por su número, por su pedido, o la abierta más vieja de su historia. `nueva`: no hay ninguna fila
// de esa historia y el hecho dice que arrancó.
function rowOfFact(rows, f) {
  if (f.tarea) return { row: rows.find((r) => r.id === f.tarea) || null };
  if (f.pedido) { const r = rows.find((x) => samePr(x.pedido, f.pedido)); if (r) return { row: r }; }
  if (!f.historia) return { row: null };
  const ofStory = rows.filter((r) => r.historia === f.historia);
  const open = ofStory.filter(openRow).sort((a, b) => (numOf(a.id) || Infinity) - (numOf(b.id) || Infinity));
  if (open.length) return { row: open[0] };
  return { row: null, nueva: !ofStory.length && f.tipo === 'curso' };
}

// el peso de cada hecho cuando varios caen en la misma fila: lo que la cierra, después lo que la frena, después la espera
// del dueño y por último el trabajo
const FACT_WEIGHT = { merge: 5, abandonado: 4, cortada: 3, firma: 2, curso: 1 };

function applyFact(r, f) {
  if (f.tipo === 'curso') { r.estado = 'curso'; if (f.quien) r.quien = f.quien; } else if (f.tipo === 'firma') { r.estado = 'firma'; if (f.quien) r.quien = f.quien; } else if (f.tipo === 'merge') { r.estado = 'hecho'; r.realIso = localIso(f.at); } else if (f.tipo === 'abandonado') { r.estado = 'riesgo'; r.nota = `pedido abandonado a las ${hhmm(f.at)}`; } else if (f.tipo === 'cortada') { r.estado = 'riesgo'; r.nota = `la ejecución se cortó a las ${hhmm(f.at)}`; } else return false;
  r.ultimoHecho = { clave: f.clave, at: localIso(f.at) };
  return true;
}

function readFacts(sdir) {
  try { const v = JSON.parse(fs.readFileSync(paths(sdir).facts, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * Suma entradas al registro de hechos, con el candado tomado. Uno roto no se pisa: se aparta en `.bak` y se empieza otro.
 * Devuelve `{ lines, aviso }`: lo que pasó con el registro, si no fue lo normal.
 */
function appendFacts(sdir, entries) {
  const file = paths(sdir).facts;
  const lines = [];
  let log = [];
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return { lines, aviso: `el registro de hechos no se pudo leer (${e.code || e.message})` }; }
  if (raw != null) {
    let v;
    try { v = JSON.parse(raw); } catch { v = null; }
    if (Array.isArray(v)) log = v;
    else {
      try { fs.renameSync(file, `${file}.bak`); } catch (e) { return { lines, aviso: `el registro de hechos estaba roto y no se pudo apartar (${e.code || e.message})` }; }
      lines.push(`el registro de hechos estaba roto: lo dejé en ${path.basename(file)}.bak y empecé otro`);
    }
  }
  try { writeAtomic(file, `${JSON.stringify([...log, ...entries].slice(-FACTS_KEPT), null, 2)}\n`); } catch (e) { return { lines, aviso: `el registro de hechos no se pudo escribir (${e.code || e.message})` }; }
  return { lines, aviso: null };
}

/** El último hecho que movió una fila, en una línea; null si no hay. */
function lastFactLine(sdir, id) {
  const e = [...readFacts(sdir)].reverse().find((x) => x.id === id);
  // la hora local se anota entera (AAAA-MM-DDTHH:MM): a la persona le basta la hora
  const hora = /^\d{4}-\d\d-\d\dT(\d\d:\d\d)/.exec(String(e && e.hora));
  return e ? `último hecho: ${e.clave} (${e.tipo}) a las ${hora ? hora[1] : e.hora}` : null;
}

/**
 * Aplica los hechos de la foto. `{ code, written, lines, aviso }`: `aviso` es lo que la oficina dice una vez cuando no
 * pudo escribir (un tablero sin números o roto, el candado).
 */
function sync(sdir, facts, { complete = false, now = Date.now(), ...opts } = {}) {
  const checked = check(sdir);
  if (checked.code !== 0) return { code: 2, written: false, lines: checked.lines, aviso: 'el tablero no se movió solo: tiene filas sin número o que rompen una regla; corré board.js check' };
  const usable = (facts || []).filter((f) => f && f.clave && Number.isFinite(f.at));
  // sin hechos no se toma el candado: la oficina vigila la carpeta y cada foto pediría otra
  if (!usable.length) return { code: 0, written: false, lines: ['sin hechos nuevos'] };
  const applied = [];
  let logAviso = null;
  const res = write(sdir, (raw) => {
    const rows = raw.pendientes;
    // un solo hecho por fila en cada foto, el de más peso, en cualquier orden: dos sesiones sobre la misma fila no la
    // hacen ir y venir entre fotos
    const best = new Map();
    for (const f of usable) {
      const { row, nueva } = rowOfFact(rows, f);
      const target = row || (nueva ? `nueva:${f.historia}` : null);
      if (!target) continue;
      const prev = best.get(target);
      if (!prev || FACT_WEIGHT[f.tipo] > FACT_WEIGHT[prev.tipo] || (FACT_WEIGHT[f.tipo] === FACT_WEIGHT[prev.tipo] && f.clave < prev.clave)) best.set(target, f);
    }
    for (const [target, f] of best) {
      if (typeof target === 'string') {
        const r = { titulo: str(f.titulo) || `Historia ${f.historia}`, historia: f.historia, estado: 'curso', grupo: 'Hoy', ...(f.quien ? { quien: f.quien } : {}), ultimoHecho: { clave: f.clave, at: localIso(f.at) } };
        rows.push(r);
        applied.push({ r, f });
        continue;
      }
      const row = target;
      if (row.estado === 'hecho' || (row.ultimoHecho && row.ultimoHecho.clave === f.clave)) continue;
      // ya está como ese hecho la deja: no se reescribe
      if ((f.tipo === 'curso' || f.tipo === 'firma') && row.estado === f.tipo && (!f.quien || row.quien === f.quien)) continue;
      if (!complete && fromAbsence(f, row)) continue;
      if (applyFact(row, f)) applied.push({ r: row, f });
    }
    if (!applied.length) return { code: 0, lines: ['sin hechos nuevos'] };
    return { raw, lines: [`moví ${applied.length} fila(s) con los hechos`] };
  }, {
    now,
    ...opts,
    live: opts.live || [],
    // el registro, con el mismo candado: dos que mueven el tablero a la vez no se pisan las entradas
    afterRename: () => {
      const r = appendFacts(sdir, applied.map(({ r: fila, f }) => ({ id: fila.id, tipo: f.tipo, clave: f.clave, hora: localIso(f.at), anotado: new Date(now).toISOString() })));
      logAviso = r.aviso;
      return r.lines;
    },
  });
  const written = res.code === 0 && applied.length > 0 && !/sin hechos nuevos/.test(res.lines[0]);
  if (res.code !== 0) return { ...res, written, aviso: `el tablero no se movió solo: ${res.lines.join(' ').replace(/^⛔\s*/, '')}` };
  return { ...res, written, ...(logAviso ? { aviso: logAviso } : {}) };
}

/**
 * La huella anotada y la del archivo: `{ cambiado, at }`. Sin huella anotada (nunca se escribió con el comando), null.
 * Una huella o un tablero que no se pueden leer no son «sin huella»: `{ ilegible: true, motivo }`.
 */
function printCheck(sdir) {
  const p = paths(sdir);
  let print;
  try { print = JSON.parse(fs.readFileSync(p.print, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { ilegible: true, motivo: `la huella (${e.code || 'rota'})` };
  }
  if (!print || typeof print.sha !== 'string') return { ilegible: true, motivo: 'la huella (sin sha)' };
  let text;
  let mtime;
  try { text = fs.readFileSync(p.board, 'utf8'); mtime = fs.statSync(p.board).mtimeMs; } catch (e) { return { ilegible: true, motivo: `el tablero (${e.code || e.message})` }; }
  return sha(text) === print.sha ? { cambiado: false } : { cambiado: true, at: mtime };
}

// ── La línea de comandos ────────────────────────────────────────────────────────────────────────────────────────────

function main(argv, { home = os.homedir(), out = (t) => process.stdout.write(`${t}\n`), err = (t) => process.stderr.write(`${t}\n`) } = {}) {
  const args = [...argv];
  const take = (flag, withValue = true) => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const v = withValue ? args[i + 1] : true;
    args.splice(i, withValue ? 2 : 1);
    return v;
  };
  const sdir = take('--state-dir') || stateDir(home);
  const from = take('--from');
  const real = take('--real');
  const factsFile = take('--facts');
  const complete = take('--complete', false) === true;
  const [cmd, ...rest] = args;
  let res;
  if (cmd === 'save') {
    if (!from) res = { code: 2, lines: ['⛔ save va con --from <tu archivo aparte>'] };
    else {
      let raw;
      try { raw = JSON.parse(fs.readFileSync(from, 'utf8')); } catch (e) { res = { code: 2, lines: [`⛔ ${from} no se pudo leer (${e.code || e.message})`] }; }
      if (!res) res = save(sdir, raw, { home });
    }
  } else if (cmd === 'add') res = add(sdir, rest, { home });
  else if (cmd === 'set') res = rest.length < 2 ? { code: 2, lines: ['⛔ uso: set <T-n> campo=valor…'] } : set(sdir, rest[0], rest.slice(1), { home });
  else if (cmd === 'close') res = rest.length !== 1 ? { code: 2, lines: ['⛔ uso: close <T-n> [--real AAAA-MM-DDTHH:MM]'] } : close(sdir, rest[0], { real, home });
  else if (cmd === 'check') res = check(sdir);
  else if (cmd === 'sync') {
    let facts = [];
    try { facts = factsFile ? JSON.parse(fs.readFileSync(factsFile, 'utf8')) : []; } catch (e) { res = { code: 2, lines: [`⛔ ${factsFile} no se pudo leer (${e.message})`] }; }
    if (!res) res = sync(sdir, facts, { complete, home });
  } else res = { code: 2, lines: ['uso: board.js save --from <archivo> | add titulo=… [campo=valor…] | set <T-n> campo=valor… | close <T-n> [--real AAAA-MM-DDTHH:MM] | check | sync --facts <archivo> [--complete]'] };
  for (const l of res.lines) (res.code === 0 ? out : err)(l);
  return res.code;
}

module.exports = { paths, taskId, orderRows, readNumbers, readBoardRaw, rowProblems, numberRows, quienWarnings, save, add, set, close, check, sync, mergeFacts, readFacts, lastFactLine, printCheck, ESTADOS, ID, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
