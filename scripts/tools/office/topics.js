#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * topics.js — el tema de cada trabajo de la oficina, para agrupar las tablas «Hoy» y «Pendientes».
 *
 *   node topics.js --classify     clasifica los trabajos nuevos de <estado>/office/topics-pending.json (lo lanza office/server.js)
 *   node topics.js --report       lo que gastó el modelo, por día
 *   node topics.js --unmatched    las filas de las tablas escritas que no tienen tarjeta, sin tocar nada
 *
 * Un trabajo se clasifica una sola vez y su tema queda en `topics.json`: no cambia si el trabajo cambia de hora, de columna o
 * de sesión. Al modelo va sólo el título y los temas ya usados: el título de otro proyecto no se manda, y el que nombra a
 * una persona de la lista privada tampoco. El modelo es el de la noche de la organización (`resolveNightly`), o el mismo
 * por el servicio local si la máquina no tiene la llave: no cae en otro proveedor ni en otro modelo. Sin modelo, el tema sale
 * de los títulos de los pedidos recientes y no se guarda.
 *
 * Lo que queda en <estado>/office/: `topics.json` (los temas), `topics-usage.json` (el gasto por día), `topics-state.json`
 * (cuándo puede volver a llamar, y por qué no), `topics-pending.json` (lo que dejó la foto) y `row-prs.json` (el pedido que
 * se recuerda para cada fila del tablero, lo usa office.js). Todo se escribe primero aparte y después se renombra; un archivo
 * roto se dice, y antes de reescribirlo queda una copia.
 *
 * Casos: scripts/tests/office-topics.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const VERSION = 1;
const OTHERS = 'Otros';
const OTHER_PROJECT = 'Otro proyecto';
const NOTE_NO_MODEL = 'Sin modelo: los temas salen de los títulos de los pedidos';
const NOTE_CAP = 'Llegó al tope de hoy: lo nuevo va a «Otros» hasta mañana';
const NOTE_LIST = 'La lista privada no se pudo leer: lo nuevo va a «Otros» y nada se manda al modelo';
const MOTIVE_LIST = 'lista_privada';
const BATCH = 30;
const MAX_TOPIC_WORDS = 3;
const MAX_TOPIC_CHARS = 40;
const DEFAULT_TIMEOUT_MS = 30000;
const TAGS_TIMEOUT_MS = 3000;
const CALL_MARGIN_MS = 1000;
const MAY_HAVE_SPENT = new Set(['tiempo', 'respuesta_ilegible']);
const BACKOFF_MS = 5 * 60000;
const LOCK_STALE_MS = 2 * 60000;
const DEFAULT_TOKENS_CAP = 20000;
const DEFAULT_TITLES_CAP = 600;
const LOCAL_SERVICE = 'http://localhost:11434';
const PRIVATE_LIST = path.join('scripts', 'publishing', 'denylist.json');
const USED_TOPICS_MAX = 50;
const RESERVED_TOPICS = new Set(['otros', 'otro proyecto']);
// cuántos temas se le piden al modelo: más que esto, la tabla deja de resumir
const TOPICS_WANTED = 8;

const fileOf = (sdir, name) => path.join(sdir, 'office', name);

// ¿Dos títulos hablan del mismo trabajo? El de una ejecución y el que le puso la coordinadora en el tablero pueden no ser iguales
// («La revisión de la semana se configura desde el sitio: el tope…» y «La revisión semanal se configura desde el sitio»). Se
// comparan las palabras con contenido de lo que va antes de los dos puntos. La fila que nombra su `historia` no necesita esto.
const FILLER = new Set('a al algo cada como con cuando de del desde el en entre es la las lo los no o para por que se si sin su sus un una uno y'.split(' '));
const plainWords = (t) => String(t || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const wordsOf = (t) => new Set(plainWords(String(t || '').split(':')[0]).filter((w) => !FILLER.has(w)));
const topicKey = (t) => plainWords(t).join(' ');
const SAME_WORK_SHARE = 0.6;
function sameWorkScore(a, b) {
  const x = wordsOf(a);
  const y = wordsOf(b);
  const least = Math.min(x.size, y.size);
  if (least < 2) return 0;
  const score = [...x].filter((w) => y.has(w)).length / least;
  return score >= SAME_WORK_SHARE ? score : 0;
}

/** La clave de un trabajo: su historia, si tiene; si no, su pedido; si no, su título normalizado. */
function workKey({ historia, pedido, titulo } = {}) {
  if (historia) return `historia:${String(historia).toLowerCase()}`;
  if (pedido && pedido.repo && pedido.numero != null) return `pedido:${String(pedido.repo).toLowerCase()}#${pedido.numero}`;
  // un título sin letras ni números no se parece a ningún otro: se queda con lo que dice
  return `titulo:${plainWords(titulo).join(' ') || String(titulo || '').trim()}`;
}

// ── Los archivos ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `{ data, problem }`: `data` es null sin archivo, roto o de otra versión; `problem` lo dice. Nunca tira. */
function readStore(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { data: null, problem: null } : { data: null, problem: `${path.basename(file)} no se pudo leer (${e.code || e.message})` };
  }
  let data;
  try { data = JSON.parse(raw); } catch (e) { return { data: null, problem: `${path.basename(file)} está roto (${e.message})` }; }
  if (!data || typeof data !== 'object' || data.version !== VERSION) return { data: null, problem: `${path.basename(file)} es de otra versión` };
  return { data, problem: null };
}

/** Escribe entero y renombra; si lo que había no se podía leer, antes deja una copia. */
function writeStore(file, content, nowMs = Date.now()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && readStore(file).problem) fs.copyFileSync(file, `${file}.roto-${nowMs}`);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: VERSION, ...content }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const asMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function readTopics(sdir) {
  const r = readStore(fileOf(sdir, 'topics.json'));
  return { temas: asMap(r.data && r.data.temas), problem: r.problem };
}
function saveTopics(sdir, nuevos, nowMs) {
  writeStore(fileOf(sdir, 'topics.json'), { temas: { ...readTopics(sdir).temas, ...nuevos } }, nowMs);
}
function readState(sdir) {
  const { version, ...state } = readStore(fileOf(sdir, 'topics-state.json')).data || {};
  return { state };
}
const saveState = (sdir, state, nowMs) => writeStore(fileOf(sdir, 'topics-state.json'), state, nowMs);
function readUsage(sdir) {
  const r = readStore(fileOf(sdir, 'topics-usage.json'));
  return { dias: asMap(r.data && r.data.dias), problem: r.problem };
}
function readPending(sdir) {
  const r = readStore(fileOf(sdir, 'topics-pending.json'));
  return r.data && Array.isArray(r.data.trabajos) ? r.data.trabajos : [];
}
/** Deja lo que hay por clasificar; si no cambió, no toca el archivo. */
function writePending(sdir, trabajos) {
  const same = JSON.stringify(readPending(sdir)) === JSON.stringify(trabajos);
  if (!same) writeStore(fileOf(sdir, 'topics-pending.json'), { trabajos });
}
function readRowPrs(sdir) {
  const r = readStore(fileOf(sdir, 'row-prs.json'));
  return { filas: asMap(r.data && r.data.filas), sesiones: asMap(r.data && r.data.sesiones), problem: r.problem };
}
const saveRowPrs = (sdir, filas, nowMs, sesiones = {}) => writeStore(fileOf(sdir, 'row-prs.json'), { filas, sesiones }, nowMs);

// ── El tema de una tarjeta ───────────────────────────────────────────────────────────────────────────────────────────

/** Los alcances de los títulos de pedidos: `feat(office): la lámpara…` da el tema «Office». Un número no es un tema. */
function prScopes(titles) {
  const out = [];
  for (const t of titles || []) {
    const m = /^[a-z]+\(([^)]+)\)!?:\s*(.*)$/i.exec(String(t).trim());
    if (!m || /^\d/.test(m[1])) continue;
    const scope = m[1].trim();
    out.push({ tema: scope.charAt(0).toUpperCase() + scope.slice(1), palabra: plainWords(scope).join(' '), titulo: m[2] });
  }
  // en un orden fijo, y el alcance más largo antes: los mismos pedidos leídos en otro orden dan el mismo tema
  return out.sort((a, b) => b.palabra.length - a.palabra.length || a.tema.localeCompare(b.tema) || a.titulo.localeCompare(b.titulo));
}

/** Los títulos de los pedidos que la máquina ya leyó: armar la foto no sale a la red por esto. */
function readPrTitles(sdir) {
  const titles = [];
  for (const name of ['stuck-prs-photo.json', 'own-prs.json', 'recent-work.json']) {
    let photo;
    try { photo = JSON.parse(fs.readFileSync(path.join(sdir, name), 'utf8')); } catch { continue; }
    for (const r of Object.values(asMap(photo && photo.lecturas))) {
      if (r && r.ok && Array.isArray(r.value)) for (const p of r.value) if (p && typeof p.title === 'string') titles.push(p.title);
    }
  }
  return titles;
}

function themeFromPrs(titulo, prs) {
  let best = null;
  let top = 0;
  for (const p of prs) {
    const score = sameWorkScore(titulo, p.titulo);
    if (score > top) { top = score; best = p; }
  }
  if (best) return best.tema;
  const said = ` ${plainWords(titulo).join(' ')} `;
  const named = prs.find((p) => p.palabra && said.includes(` ${p.palabra} `));
  return named ? named.tema : OTHERS;
}

/**
 * El tema de una tarjeta: «Otro proyecto» si es de otro proyecto, aunque su fila del tablero diga otro: esa marca es la que tapa
 * su título en el sitio; el de su fila; el guardado; sin modelo, el de los títulos de los pedidos (de lo que quedó a medio
 * camino, el del trabajo que era); si no, «Otros». `ctx`: `{ temas, sinModelo, prs }`.
 */
function topicOf(card, { temas = {}, sinModelo = false, prs = [] } = {}) {
  if (card.otro) return OTHER_PROJECT;
  if (card.tema) return card.tema;
  if (card.clave && temas[card.clave]) return temas[card.clave];
  return sinModelo ? themeFromPrs(card.trabajo || card.tituloTrabajo || card.titulo, prs) : OTHERS;
}

/**
 * Lo que falta clasificar de estas tarjetas: sólo su clave y su título, una vez cada uno. La tarjeta sin título anotado no entra:
 * lo que muestra sale de su conversación, y eso no se manda. Tampoco la que no se sabe de qué proyecto es (`sinSaber`): no saberlo
 * no prueba que sea de los nuestros.
 */
function pendingWorks(cards, temas) {
  const seen = new Map();
  for (const c of cards) {
    if (c.otro || c.sinSaber || c.tema || c.sinTitulo || !c.clave || !c.titulo || temas[c.clave] || seen.has(c.clave)) continue;
    seen.set(c.clave, { clave: c.clave, titulo: c.tituloTrabajo || c.titulo });
  }
  return [...seen.values()];
}

/** Lo que la tabla tiene que decir del estado de la clasificación, una sola vez; null si no hay nada que decir. */
function tableNote(state, nowMs) {
  if (state && state.sinModelo) return NOTE_NO_MODEL;
  if (state && state.motivo === 'tope' && Number.isFinite(state.nextAt) && nowMs < state.nextAt) return NOTE_CAP;
  if (state && state.motivo === MOTIVE_LIST) return NOTE_LIST;
  return null;
}

// ── El modelo ────────────────────────────────────────────────────────────────────────────────────────────────────────

const isCloud = (model) => /(?:-|:)cloud$/.test(model);
const cloudName = (model) => (isCloud(model) ? model : `${model}-cloud`);

/** Corta lo que tarde más de `ms`, también si los encabezados ya llegaron y lo que se cuelga es el cuerpo. */
async function withTimeout(ms, run) {
  const ctl = new AbortController();
  let clock;
  const late = new Promise((_, reject) => {
    clock = setTimeout(() => {
      ctl.abort();
      reject(Object.assign(new Error('tiempo'), { name: 'AbortError' }));
    }, ms);
  });
  try { return await Promise.race([run(ctl.signal), late]); } finally { clearTimeout(clock); }
}

/** El nombre con que el servicio local tiene registrado este modelo de la nube, con o sin etiqueta; null si no lo tiene. */
async function localModelName(model, fetchImpl) {
  const wanted = isCloud(model) ? [model] : [`${model}-cloud`, `${model}:cloud`];
  try {
    const body = await withTimeout(TAGS_TIMEOUT_MS, async (signal) => {
      const res = await fetchImpl(`${LOCAL_SERVICE}/api/tags`, { signal });
      return res && res.ok ? res.json() : null;
    });
    const names = body && Array.isArray(body.models) ? body.models.map((m) => m && m.name) : [];
    return [...wanted, ...wanted.map((w) => `${w}:latest`)].find((w) => names.includes(w)) || null;
  } catch { return null; }
}

async function callLocal({ model, prompt, fetchImpl, timeoutMs }) {
  let res;
  let raw;
  try {
    [res, raw] = await withTimeout(timeoutMs, async (signal) => {
      const r = await fetchImpl(`${LOCAL_SERVICE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, options: { temperature: 0.2 }, messages: [{ role: 'user', content: prompt }] }),
        signal,
      });
      return [r, r && r.ok ? await r.text() : null];
    });
  } catch (e) { return { ok: false, fallo: e && e.name === 'AbortError' ? 'tiempo' : 'red' }; }
  if (!res || !res.ok) return { ok: false, fallo: 'http' };
  let body;
  try { body = JSON.parse(raw); } catch { return { ok: false, fallo: 'respuesta_ilegible' }; }
  const texto = body && body.message && typeof body.message.content === 'string' ? body.message.content.trim() : null;
  if (texto === null) return { ok: false, fallo: 'respuesta_ilegible' };
  const n = (x) => (Number.isFinite(x) ? x : null);
  const tokens = n(body.prompt_eval_count) !== null || n(body.eval_count) !== null ? { entrada: n(body.prompt_eval_count), salida: n(body.eval_count) } : null;
  return { ok: true, texto, tokens };
}

/** Cómo llamar al modelo de la organización: `{ call }`, o `{ none: motivo }` si no hay. No prueba otro. */
async function resolveModel({ orgConfig, env, fetchImpl, timeoutMs }) {
  const { resolveNightly } = require(path.join(ROOT, 'scripts', 'lib', 'nightly-model.js'));
  const r = resolveNightly({ orgConfig, env });
  if (r.ok) {
    const { llamar } = require(path.join(ROOT, 'scripts', 'instincts', 'instinct-model.js'));
    return { call: (prompt) => llamar({ nightly: r, prompt, env, fetchImpl, timeoutMs }) };
  }
  if (r.status === 'no-secret' && r.provider === 'ollama') {
    const model = await localModelName(r.model, fetchImpl);
    if (model) return { call: (prompt) => callLocal({ model, prompt, fetchImpl, timeoutMs }) };
    return { none: `sin la llave de la noche, y el servicio local no tiene ${cloudName(r.model)}` };
  }
  return { none: r.message || r.status };
}

const promptOf = (titles, used) => [
  'Clasificá cada título de trabajo en un tema de una a tres palabras, en castellano, que entienda alguien que no programa.',
  `Los temas sirven para resumir: agrupá todo lo que puedas, sin pasar de ${TOPICS_WANTED} temas en total contando los de la lista, y usá temas amplios.`,
  'Reutilizá un tema de la lista siempre que encaje. Contestá sólo un JSON: una lista con un tema por título, en el mismo orden.',
  `Temas usados: ${JSON.stringify(used)}`,
  `Títulos:\n${JSON.stringify(titles)}`,
].join('\n');

/** La lista de temas de la respuesta, en orden; null si no se entiende. El modelo suele envolverla en un bloque de código. */
function parseAnswer(text) {
  const unfenced = String(text).trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
  let list;
  try { list = JSON.parse(unfenced); } catch { return null; }
  return Array.isArray(list) ? list : null;
}
function validTopic(t) {
  if (typeof t !== 'string') return null;
  const clean = t.trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (!(words.length >= 1 && words.length <= MAX_TOPIC_WORDS && clean.length <= MAX_TOPIC_CHARS)) return null;
  // los dos nombres reservados no los decide el modelo: «Otro proyecto» taparía en el sitio el título de un trabajo propio
  return RESERVED_TOPICS.has(plainWords(clean).join(' ')) ? OTHERS : clean;
}

// ── La lista privada ─────────────────────────────────────────────────────────────────────────────────────────────────

function privateListFile(tree) {
  const own = path.join(tree, PRIVATE_LIST);
  if (fs.existsSync(own)) return own;
  // quien mantiene el arnés corre la versión bajada: la lista vive en su clon de mantenimiento
  try {
    const clone = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js')).maintainersClone();
    const file = clone && clone.path ? path.join(clone.path, PRIVATE_LIST) : null;
    return file && fs.existsSync(file) ? file : null;
  } catch { return null; }
}

/** Cómo reconocer a una persona de la lista: `{ names }`. Sin lista, nada que comprobar; una que no se puede leer se dice. */
function loadNames(file) {
  if (!file || !fs.existsSync(file)) return { names: () => false };
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    const isPerson = (x) => x && x.categoria === 'persona';
    // como el detector de publicación: un término sin `palabra` vale pegado a otra, y los patrones se compilan con sus banderas
    const terms = (list.terminos || []).filter(isPerson).map((x) => ({ term: plainWords(x.patron).join(' '), word: Boolean(x.palabra) })).filter((x) => x.term);
    const patterns = (list.patrones || []).filter(isPerson).map((x) => new RegExp(x.regex, x.mayusculas ? '' : 'i'));
    return { names: (titulo) => {
      const said = plainWords(titulo).join(' ');
      return terms.some(({ term, word }) => (word ? ` ${said} `.includes(` ${term} `) : said.includes(term))) || patterns.some((p) => p.test(titulo));
    } };
  } catch (e) { return { problem: `la lista privada no se pudo leer (${e.message})` }; }
}

// ── Clasificar ───────────────────────────────────────────────────────────────────────────────────────────────────────

const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nextDay = (ms) => { const d = new Date(ms); d.setHours(24, 0, 0, 0); return d.getTime(); };
const capOf = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; };

function addUsage(sdir, nowMs, { tokens, titulos, fallida = false }) {
  const { dias } = readUsage(sdir);
  const key = dayOf(nowMs);
  const d = { entrada: 0, salida: 0, llamadas: 0, titulos: 0, titulosSinMedir: 0, ...asMap(dias[key]) };
  d.llamadas += 1;
  if (fallida) d.fallidas = (d.fallidas || 0) + 1;
  d.titulos += titulos;
  if (tokens) { d.entrada += tokens.entrada || 0; d.salida += tokens.salida || 0; } else d.titulosSinMedir += titulos;
  writeStore(fileOf(sdir, 'topics-usage.json'), { dias: { ...dias, [key]: d } }, nowMs);
}

function takeLock(file, nowMs) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { return false; }
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      const at = new Date(nowMs);
      fs.utimesSync(file, at, at);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      let age;
      try { age = nowMs - fs.statSync(file).mtimeMs; } catch { continue; }
      if (age < LOCK_STALE_MS) return false;
      try { fs.unlinkSync(file); } catch { /* lo sacó el otro */ }
    }
  }
  return false;
}

/**
 * Una pasada: toma el candado, mira lo pendiente, y si corresponde llama una vez, con hasta 30 títulos.
 * opts: `sdir`, `orgConfig`, `env`, `fetchImpl`, `nowMs`, `namesFile` (null: sin lista), `tree`, `timeoutMs`.
 * Devuelve `{ ran, fallo?, llamo? }`. Nunca tira por el modelo.
 */
async function classify(opts = {}) {
  const { sdir, env = process.env, fetchImpl = globalThis.fetch, nowMs = Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const tree = path.resolve(opts.tree || env.TYCON_TREE || ROOT);
  const orgConfig = opts.orgConfig || path.join(tree, 'team-repos.json');
  const lock = fileOf(sdir, 'topics.lock');
  if (!takeLock(lock, nowMs)) return { ran: false };
  try {
    const { temas } = readTopics(sdir);
    const pending = readPending(sdir).filter((w) => w && w.clave && typeof w.titulo === 'string' && !temas[w.clave]);
    const { state } = readState(sdir);
    if (!pending.length && !state.sinModelo) return { ran: true, llamo: false };
    if (Number.isFinite(state.nextAt) && nowMs < state.nextAt) return { ran: true, llamo: false };
    if (!pending.length) {
      // sin nada que clasificar nadie más limpiaría el aviso de «Sin modelo»: se mira si el modelo volvió
      const back = await resolveModel({ orgConfig, env, fetchImpl, timeoutMs });
      saveState(sdir, back.none ? { sinModelo: true, motivo: back.none, nextAt: nowMs + BACKOFF_MS } : {}, nowMs);
      return { ran: true, llamo: false };
    }
    const day = asMap(readUsage(sdir).dias[dayOf(nowMs)]);
    const overTokens = (day.entrada || 0) + (day.salida || 0) >= capOf(env.TYCON_OFFICE_TOPICS_TOKENS, DEFAULT_TOKENS_CAP);
    const overTitles = (day.titulosSinMedir || 0) >= capOf(env.TYCON_OFFICE_TOPICS_TITLES, DEFAULT_TITLES_CAP);
    if (overTokens || overTitles) {
      saveState(sdir, { motivo: 'tope', nextAt: nextDay(nowMs) }, nowMs);
      return { ran: true, llamo: false };
    }
    const model = await resolveModel({ orgConfig, env, fetchImpl, timeoutMs });
    if (model.none) {
      saveState(sdir, { sinModelo: true, motivo: model.none, nextAt: nowMs + BACKOFF_MS }, nowMs);
      return { ran: true, llamo: false };
    }
    const list = loadNames(opts.namesFile !== undefined ? opts.namesFile : privateListFile(tree));
    if (list.problem) {
      saveState(sdir, { motivo: MOTIVE_LIST, nextAt: nowMs + BACKOFF_MS }, nowMs);
      return { ran: true, llamo: false, fallo: list.problem };
    }
    const named = pending.filter((w) => list.names(w.titulo));
    const nuevos = Object.fromEntries(named.map((w) => [w.clave, OTHERS]));
    const toSend = pending.filter((w) => !list.names(w.titulo)).slice(0, BATCH);
    if (!toSend.length) {
      saveTopics(sdir, nuevos, nowMs);
      return { ran: true, llamo: false };
    }
    const used = [...new Set(Object.values(temas))].filter((t) => !RESERVED_TOPICS.has(plainWords(t).join(' '))).slice(0, USED_TOPICS_MAX);
    // este tope también cubre al proveedor de la organización, que lee su respuesta por su cuenta
    const reply = await withTimeout(timeoutMs + CALL_MARGIN_MS, () => model.call(promptOf(toSend.map((w) => w.titulo), used))).catch(() => ({ ok: false, fallo: 'tiempo' }));
    if (!reply.ok) {
      if (named.length) saveTopics(sdir, nuevos, nowMs);
      // una llamada fallida también se cuenta; sus títulos, si pudo haber gastado: lo que no llegó al modelo no gastó
      addUsage(sdir, nowMs, { tokens: null, titulos: MAY_HAVE_SPENT.has(reply.fallo) ? toSend.length : 0, fallida: true });
      saveState(sdir, { motivo: reply.fallo, nextAt: nowMs + BACKOFF_MS }, nowMs);
      return { ran: true, llamo: true, fallo: reply.fallo };
    }
    addUsage(sdir, nowMs, { tokens: reply.tokens, titulos: toSend.length });
    const answer = parseAnswer(reply.texto);
    const valid = answer ? toSend.map((w, i) => [w.clave, validTopic(answer[i])]).filter(([, t]) => t) : [];
    for (const [k, t] of valid) nuevos[k] = t;
    if (Object.keys(nuevos).length) saveTopics(sdir, nuevos, nowMs);
    if (!answer || !valid.length) {
      saveState(sdir, { motivo: 'respuesta_ilegible', nextAt: nowMs + BACKOFF_MS }, nowMs);
      return { ran: true, llamo: true, fallo: 'respuesta_ilegible' };
    }
    // lo que el modelo dejó afuera no se vuelve a preguntar enseguida
    saveState(sdir, valid.length < toSend.length ? { motivo: 'respuesta_parcial', nextAt: nowMs + BACKOFF_MS } : {}, nowMs);
    return { ran: true, llamo: true };
  } finally {
    try { fs.unlinkSync(lock); } catch { /* ya no está */ }
  }
}

// ── Las otras dos entradas ───────────────────────────────────────────────────────────────────────────────────────────

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Lo que gastó el modelo, por día, lo último primero. */
function report(sdir) {
  const { dias, problem } = readUsage(sdir);
  const lines = Object.keys(dias).sort().reverse().slice(0, 14).map((day) => {
    const d = asMap(dias[day]);
    const entrada = d.entrada || 0;
    const salida = d.salida || 0;
    const titulos = d.titulos || 0;
    const sinMedir = d.titulosSinMedir || 0;
    const calls = `${plural(d.llamadas || 0, 'llamada', 'llamadas')}${d.fallidas ? ` (${plural(d.fallidas, 'fallida', 'fallidas')})` : ''}`;
    const said = plural(titulos, 'título', 'títulos');
    if (sinMedir >= titulos && !(entrada + salida)) return `${day}: tokens no medidos, ${calls}, ${said}`;
    const missing = sinMedir ? `; tokens no medidos de ${plural(sinMedir, 'título', 'títulos')}` : '';
    return `${day}: ${entrada + salida} tokens (${entrada} de entrada, ${salida} de salida), ${calls}, ${said}${missing}`;
  });
  if (!lines.length) lines.push('Sin llamadas al modelo.');
  if (problem) lines.push(`No se pudo leer: ${problem}`);
  return lines.join('\n');
}

/** Las filas de `tablas` que no tienen tarjeta en el kanban. Sólo las devuelve. */
function unmatchedRows(tablas, kanban) {
  const cards = [...(kanban.columnas || []).flatMap((c) => c.tarjetas || []), ...(kanban.anteriores || []), ...(kanban.medioCamino || [])];
  // el mismo título es la misma tarjeta, aunque sea de una sola palabra: la coordinadora pasaría esa fila dos veces
  const same = (a, b) => plainWords(a).join(' ') === plainWords(b).join(' ') || sameWorkScore(a, b) > 0;
  const out = [];
  for (const key of ['hoy', 'pendientes']) {
    for (const r of (tablas && Array.isArray(tablas[key]) ? tablas[key] : [])) {
      if (!r || typeof r.que !== 'string' || !r.que.trim()) continue;
      if (!cards.some((c) => same(r.que, c.titulo))) out.push({ tabla: key, grupo: r.grupo || '', que: r.que });
    }
  }
  return out;
}

async function main(argv) {
  const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const sdir = stateDir(os.homedir());
  const [what] = argv;
  if (what === '--classify' && argv.length === 1) {
    const r = await classify({ sdir });
    if (r.fallo) process.stderr.write(`topics.js: ${r.fallo}\n`);
    // una respuesta colgada deja su conexión abierta: el proceso no espera a que se cierre
    process.exit(0);
  }
  if (what === '--report' && argv.length === 1) { process.stdout.write(`${report(sdir)}\n`); return 0; }
  if (what === '--unmatched' && argv.length === 1) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(sdir, 'coordination', 'tablero.json'), 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') { process.stdout.write('No hay tablero.\n'); return 0; }
      process.stderr.write(`topics.js: el tablero no se pudo leer (${e.message})\n`);
      return 2;
    }
    if (!raw || typeof raw !== 'object') {
      process.stderr.write('topics.js: el tablero no se pudo leer (no es un objeto)\n');
      return 2;
    }
    const { collect } = require(path.join(__dirname, '..', 'office.js'));
    // sin tocar nada: ni los archivos de la oficina ni la red
    const data = await collect({ noTranscripts: true, readOnly: true, queryPrs: async (list) => list.map(() => ({})) });
    const rows = unmatchedRows(raw.tablas, data.kanban);
    process.stdout.write(rows.length ? `${rows.map((r) => `${r.tabla} · ${r.grupo} · ${r.que}`).join('\n')}\n` : 'Ninguna fila escrita quedó sin tarjeta.\n');
    return 0;
  }
  process.stderr.write('Uso: topics.js --classify | --report | --unmatched\n');
  return 2;
}

// Antes de correr: `--unmatched` carga office.js, que lee estas mismas funciones.
module.exports = {
  OTHERS, OTHER_PROJECT, NOTE_NO_MODEL, NOTE_CAP, NOTE_LIST, DEFAULT_TIMEOUT_MS, BACKOFF_MS, topicKey,
  sameWorkScore, workKey, readTopics, saveTopics, readState, readUsage, readPending, writePending, readRowPrs, saveRowPrs,
  prScopes, readPrTitles, topicOf, pendingWorks, tableNote, classify, report, unmatchedRows,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`topics.js: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 1;
  });
}
