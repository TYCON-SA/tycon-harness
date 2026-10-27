#!/usr/bin/env node
'use strict';
/*
 * agents-per-run.js — CUÁNTOS AGENTES ABRE UNA EJECUCIÓN DEL PIPELINE, Y CON CUÁNTO CONTEXTO ARRANCA CADA UNO.
 *
 * Un agente cuesta antes de leer nada: arranca con su contexto inicial (instrucciones, herramientas, lo que le pasa el
 * orquestador). Este medidor lo cuenta por ejecución, para saber qué achicar sin bajar de modelo.
 *
 * Las señales, fijas:
 *   · ejecución        = un volcado de `timing-history/`: su sesión (`marker.sessionId`) y su ventana, de
 *                        `marker.startedAt` a `archivedAt`. Un agente entra si su primera línea cae en la ventana (sin
 *                        conversación, la hora de su meta); si dos ventanas de la misma sesión se pisan, va a la última
 *                        que arrancó antes que él, una sola vez.
 *   · contexto inicial = entrada + caché creada + caché leída de la PRIMERA respuesta del agente.
 *   · tokens           = la suma, por respuesta, de entrada + caché creada + caché leída + salida. Una respuesta llega
 *                        en varias líneas con el mismo `message.id`: se cuenta una vez. Un consumo en cero o sin
 *                        números no es una respuesta medida.
 *   · clase            = del `agentType` del meta: validador, revisor (el padrón de models.js), ayudante
 *                        (general-purpose, Explore, Plan) u otro.
 *   · pase adversarial = el workflow que anota el marcador archivado (`adversarial.runId`; si se relanzó, el último).
 *                        Sus agentes y sus tokens salen del archivo del workflow, y su contexto inicial de las
 *                        conversaciones de `subagents/workflows/<runId>/` si están. Los demás workflows de la sesión
 *                        que arrancan en la ventana se listan aparte y no se suman: un relanzado queda a la vista.
 *
 * 🔴 SÓLO NÚMEROS: de cada línea de conversación se quedan `timestamp`, `message.id`, `message.model` y
 * `message.usage`; del meta, `agentType`; del workflow, `agentCount`, `totalTokens` y `startTime`. Ningún texto se
 * guarda ni se imprime: la hora tiene que ser una fecha, el modelo y el tipo un nombre corto, y un error de lectura sale
 * con su código o «JSON ilegible», nunca con su mensaje (el de un JSON roto trae un pedazo del archivo). La prueba lo
 * verifica con una marca en cada campo de texto.
 *
 * Lo no medido se dice con su motivo, nunca como cero: un agente, un pase, un volcado o una carpeta que no se pudo leer
 * quedan a la vista, y cada total dice cuántos no suma. Los agentes de una sesión que no caen en ninguna ejecución van
 * en su propia línea, para que el total no los esconda. No propone topes ni frena nada.
 *
 * Uso:  node scripts/metrics/agents-per-run.js (--session <id> | --all) [--json]
 *         [--projects-dir <dir>] [--history-dir <dir>]
 *       Sale 2 sin --session ni --all, con los dos o con una opción sin valor; 1 si la sesión pedida no está en la
 *       máquina, con lo que no se pudo leer. Un --history-dir que no existe se dice; el de por defecto, no.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js, que viaja con este guion.
const { stateDir: stateDirOf } = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
const models = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'models.js'));

const VALIDATORS = new Set(['tycon-story-validator', 'tycon-story-adversarial-reviewer']);
const HELPERS = new Set(['general-purpose', 'Explore', 'Plan']);
const CLASSES = ['validator', 'reviewer', 'adversarial', 'helper', 'other'];
const SAFE_NAME = /^[A-Za-z0-9._:[\]-]{1,80}$/;

const safeName = (v) => (typeof v === 'string' && SAFE_NAME.test(v) ? v : '(ilegible)');
const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const num = (v) => (Number.isFinite(v) ? v : null);
const errReason = (e) => (e && typeof e.code === 'string' ? e.code : (e instanceof SyntaxError ? 'JSON ilegible' : 'error de lectura'));

function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  const v = lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
  return Math.round(v * 10) / 10;
}

function stats(values, unmeasured) {
  return { measured: values.length, unmeasured, median: percentile(values, 0.5), p90: percentile(values, 0.9) };
}

function classOf(type, agentsDir) {
  if (VALIDATORS.has(type)) return 'validator';
  if (HELPERS.has(type)) return 'helper';
  if (type && models.reviewerExists(type, { agentsDir })) return 'reviewer';
  return 'other';
}

/** La entrada de una respuesta; null si no trae ningún número de entrada o suma cero. */
function inputSum(u) {
  const parts = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map((k) => u[k]);
  if (!parts.some((v) => Number.isFinite(v))) return null;
  const s = parts.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
  return s > 0 ? s : null;
}

/**
 * Los números de una conversación de agente. Sólo se parsean la primera línea (por su hora) y las que traen
 * `"usage"`: el texto de la conversación nunca llega a un objeto que se devuelva. Una línea con consumo que no se
 * puede leer se cuenta en `skipped`.
 */
function readConversation(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { error: errReason(e) }; }
  let firstTs = null;
  let first = true;
  let skipped = 0;
  let noOutput = 0;
  const seen = new Map();
  const noInput = new Set();
  let anonymous = 0;
  let firstKey = null;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const hasUsage = line.includes('"usage"');
    if (!first && !hasUsage) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) {
      if (hasUsage) skipped++;
      first = false;
      continue;
    }
    const obj = j && typeof j === 'object' ? j : {};
    if (first) { firstTs = isoOrNull(obj.timestamp); first = false; }
    const m = obj.message;
    if (!hasUsage || !m || !m.usage || typeof m.usage !== 'object') continue;
    // la respuesta que llega en varias líneas trae la salida final en la última: la última pisa a las anteriores
    const key = typeof m.id === 'string' ? m.id : `line-${anonymous++}`;
    if (firstKey === null) firstKey = key;
    const start = inputSum(m.usage);
    // sin entrada en la última línea: queda la anterior (si hay) y la respuesta se cuenta como parcial
    if (start === null) { noInput.add(key); continue; }
    noInput.delete(key);
    const hasOutput = Number.isFinite(m.usage.output_tokens);
    const output = hasOutput ? m.usage.output_tokens : 0;
    seen.set(key, { model: typeof m.model === 'string' ? safeName(m.model) : null, start, total: start + output, hasOutput });
  }
  const responses = [...seen.values()];
  noOutput = responses.filter((r) => !r.hasOutput).length;
  // la que nunca trajo consumo no suma nada: se cuenta aparte de la que se quedó con su línea anterior
  const lost = [...noInput].filter((k) => !seen.has(k)).length;
  // el contexto inicial es el de la primera respuesta, no el de la primera que trajo consumo
  const firstStart = firstKey !== null && seen.has(firstKey) ? seen.get(firstKey).start : null;
  return {
    firstTs, skipped, noOutput, noInput: noInput.size - lost, lost, firstStart,
    responses: responses.map(({ hasOutput, ...r }) => r),
  };
}

function readType(metaFile) {
  let raw;
  try { raw = fs.readFileSync(metaFile, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? '(sin tipo)' : '(meta ilegible)'; }
  let meta;
  try { meta = JSON.parse(raw); } catch (_) { return '(meta ilegible)'; }
  if (!meta || typeof meta !== 'object') return '(meta ilegible)';
  return typeof meta.agentType === 'string' ? safeName(meta.agentType) : '(sin tipo)';
}

const lines = (k) => `${k} línea${k === 1 ? '' : 's'} ilegible${k === 1 ? '' : 's'}`;
const noOutputs = (k) => `${k} respuesta${k === 1 ? '' : 's'} sin salida`;
const noInputs = (k) => `${k} respuesta${k === 1 ? '' : 's'} sin consumo en su última línea`;
const lostOnes = (k) => `${k} respuesta${k === 1 ? '' : 's'} sin ningún consumo`;

/** ¿Existe la ruta? true / false, o el código del error si no se pudo mirar (un permiso negado no es «no existe»). */
function probe(p) {
  try { fs.statSync(p); return true; } catch (e) {
    return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? false : errReason(e);
  }
}

/** Los agentes de una carpeta (`subagents/` o la de un workflow). Una carpeta que falta es «sin agentes»; otra falla, `error`. */
function readAgents(dir, agentsDir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) {
    return { agents: [], error: e && e.code === 'ENOENT' ? null : errReason(e) };
  }
  const ids = new Set();
  for (const f of names) {
    const m = f.match(/^agent-(.+?)(\.meta\.json|\.jsonl)$/);
    if (m) ids.add(m[1]);
  }
  const agents = [];
  for (const id of [...ids].sort()) {
    const metaFile = path.join(dir, `agent-${id}.meta.json`);
    const convFile = path.join(dir, `agent-${id}.jsonl`);
    const type = readType(metaFile);
    const a = {
      id: safeName(id), type, class: classOf(type, agentsDir), model: null, startedAt: null,
      startingContext: null, tokens: null, responses: 0, reason: null,
    };
    const conv = probe(convFile);
    if (typeof conv === 'string') {
      a.reason = `no medido: no se pudo leer la conversación (${conv})`;
    } else if (!conv) {
      a.reason = 'no medido: sin conversación guardada (la hora es la del meta)';
      try { a.startedAt = fs.statSync(metaFile).mtime.toISOString(); } catch (e) {
        a.reason = `no medido: sin conversación guardada y sin la hora del meta (${errReason(e)})`;
      }
    } else {
      const c = readConversation(convFile);
      if (c.error) {
        a.reason = `no medido: no se pudo leer la conversación (${c.error})`;
      } else {
        a.startedAt = c.firstTs;
        if (!c.responses.length) {
          a.reason = `no medido: la conversación no trae números de consumo${c.skipped ? ` (${lines(c.skipped)})` : ''}`;
        } else {
          a.model = c.responses[0].model;
          a.startingContext = c.firstStart;
          a.tokens = c.responses.reduce((s, r) => s + r.total, 0);
          a.responses = c.responses.length;
          const partial = [
            c.firstStart === null && 'contexto inicial no medido: la primera respuesta no trae consumo',
            c.skipped && lines(c.skipped), c.noOutput && noOutputs(c.noOutput), c.noInput && noInputs(c.noInput), c.lost && lostOnes(c.lost),
          ].filter(Boolean);
          if (partial.length) a.reason = `medido parcial: ${partial.join(' · ')}`;
        }
      }
    }
    if (!a.startedAt) a.reason = a.reason ? `${a.reason} · sin hora de arranque` : 'sin hora de arranque: queda fuera de toda ejecución';
    agents.push(a);
  }
  return { agents, error: null };
}

/**
 * 'dir' o 'file' para una entrada, siguiendo el enlace si lo es; null para lo demás. Un enlace que no se puede seguir
 * va a `readErrors` como `where`.
 */
function entryKind(dir, d, readErrors, where) {
  if (d.isDirectory()) return 'dir';
  if (d.isFile()) return 'file';
  if (!d.isSymbolicLink()) return null;
  try {
    const st = fs.statSync(path.join(dir, d.name));
    return st.isDirectory() ? 'dir' : (st.isFile() ? 'file' : null);
  } catch (e) {
    readErrors.push({ where, name: safeName(d.name), reason: errReason(e) });
    return null;
  }
}

/**
 * Las sesiones de todos los proyectos, en orden: `<projects>/<proyecto>/<sesión>/` o `<proyecto>/<sesión>.jsonl`. Una
 * sesión sin carpeta de agentes sigue en la máquina, con cero agentes; una que aparece en dos proyectos se mide en el
 * primero y se dice.
 */
function sessionDirs(projectsDir, readErrors) {
  const out = new Map();
  let projects = [];
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => entryKind(projectsDir, d, readErrors, 'project') === 'dir').map((d) => d.name).sort();
  } catch (e) {
    readErrors.push({ where: 'projects', name: safeName(path.basename(projectsDir)), reason: errReason(e) });
    return out;
  }
  for (const p of projects) {
    const pDir = path.join(projectsDir, p);
    let entries = [];
    try { entries = fs.readdirSync(pDir, { withFileTypes: true }); } catch (e) {
      readErrors.push({ where: 'project', name: safeName(p), reason: errReason(e) });
      continue;
    }
    // una carpeta es sesión si tiene su conversación al lado o carpetas de agentes; la de memoria del proyecto, no
    const sids = new Set();
    const kinds = entries.map((e) => [e, entryKind(pDir, e, readErrors, 'session')]);
    const files = new Set(kinds.filter(([, k]) => k === 'file').map(([e]) => e.name));
    for (const [e, kind] of kinds) {
      if (kind === 'dir') {
        if (files.has(`${e.name}.jsonl`)) { sids.add(e.name); continue; }
        const d = path.join(pDir, e.name);
        const marks = [probe(path.join(d, 'subagents')), probe(path.join(d, 'workflows'))];
        const err = marks.find((x) => typeof x === 'string');
        if (marks.includes(true)) sids.add(e.name);
        else if (err) readErrors.push({ where: 'session', name: safeName(e.name), reason: err });
      } else if (kind === 'file' && e.name.endsWith('.jsonl')) sids.add(e.name.slice(0, -'.jsonl'.length));
    }
    for (const sid of [...sids].sort()) {
      if (out.has(sid)) readErrors.push({ where: 'session', name: safeName(sid), reason: 'repetida en otro proyecto: se mide la primera' });
      else out.set(sid, path.join(pDir, sid));
    }
  }
  return out;
}

/** Los volcados del historial. Una carpeta que falta es «sin ejecuciones», salvo que se haya pedido (`required`). */
function readDumps(historyDir, readErrors, required) {
  let files = [];
  try { files = fs.readdirSync(historyDir).filter((f) => f.endsWith('.json')).sort(); } catch (e) {
    if (required || !(e && e.code === 'ENOENT')) readErrors.push({ where: 'history', name: safeName(path.basename(historyDir)), reason: errReason(e) });
    return { dumps: [], unreadable: [] };
  }
  const dumps = [];
  const unreadable = [];
  const none = { story: null, sessionId: null, startedAt: null };
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(historyDir, f), 'utf8')); } catch (e) {
      unreadable.push({ ...none, file: safeName(f), reason: `no medida: volcado ilegible (${errReason(e)})` });
      continue;
    }
    const m = d && d.marker;
    if (!m || typeof m.sessionId !== 'string') {
      unreadable.push({ ...none, file: safeName(f), reason: 'no medida: el volcado no trae la sesión' });
      continue;
    }
    const adv = m.adversarial && typeof m.adversarial === 'object' ? m.adversarial : {};
    dumps.push({
      file: safeName(f),
      story: m.storyId == null ? null : safeName(String(m.storyId)),
      sessionId: safeName(m.sessionId),
      startedAt: isoOrNull(m.startedAt),
      archivedAt: isoOrNull(d.archivedAt),
      runId: typeof adv.runId === 'string' ? safeName(adv.runId) : null,
      // sin sesión anotada, el pase es de la ejecución; una anotada que no es texto no se adivina (null)
      passSessionId: adv.sessionId === undefined ? safeName(m.sessionId) : (typeof adv.sessionId === 'string' ? safeName(adv.sessionId) : null),
      runIdUnreadable: adv.runId != null && typeof adv.runId !== 'string',
    });
  }
  return { dumps, unreadable };
}

/** Los workflows de una sesión, sólo con sus números. Los que no se pueden leer van a `readErrors`. */
function readWorkflows(sesDir, readErrors) {
  const dir = path.join(sesDir, 'workflows');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (e) {
    if (e && e.code === 'ENOENT') return { workflows: [], error: null };
    readErrors.push({ where: 'workflows', name: safeName(path.basename(sesDir)), reason: errReason(e) });
    return { workflows: [], error: errReason(e) };
  }
  const workflows = [];
  for (const f of files) {
    const runId = safeName(f.slice(0, -'.json'.length));
    let wf;
    let error = null;
    try { wf = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { error = errReason(e); }
    if (!error && (!wf || typeof wf !== 'object')) error = 'JSON ilegible';
    if (error) {
      readErrors.push({ where: 'workflow', name: runId, reason: error });
      workflows.push({ runId, agents: null, tokens: null, startMs: null, error });
      continue;
    }
    workflows.push({ runId, agents: num(wf.agentCount), tokens: num(wf.totalTokens), startMs: num(wf.startTime), error: null });
  }
  return { workflows, error: null };
}

const isoOf = (ms) => (ms === null ? null : new Date(ms).toISOString());

/** `missing`: por qué no hay sesión del pase donde buscar (la que anota el marcador no está, o no se lee). */
function adversarialOf(pass, runId, agentsDir, readErrors) {
  const { sesDir, wfs, missing } = pass;
  const r = { runId, agents: null, tokens: null, startTime: null, startingContext: stats([], 0), reason: null };
  if (missing) { r.reason = missing; return r; }
  const wf = wfs.workflows.find((w) => w.runId === runId);
  if (!wf) {
    r.reason = wfs.error
      ? `no medido: no se pudo leer la carpeta de workflows (${wfs.error})`
      : 'no medido: el workflow del pase no está en la sesión';
    return r;
  }
  if (wf.error) { r.reason = `no medido: workflow ilegible (${wf.error})`; return r; }
  r.agents = wf.agents;
  r.tokens = wf.tokens;
  r.startTime = isoOf(wf.startMs);
  const read = readAgents(path.join(sesDir, 'subagents', 'workflows', runId), agentsDir);
  const starts = read.agents.map((a) => a.startingContext).filter((v) => v !== null);
  r.startingContext = stats(starts, read.agents.length - starts.length);
  if (read.error) readErrors.push({ where: 'subagents', name: runId, reason: read.error });
  const reasons = [];
  if (r.agents === null || r.tokens === null) reasons.push('no medido: el workflow no trae agentCount o totalTokens');
  if (read.error) reasons.push(`contexto inicial no medido: no se pudieron leer las conversaciones del pase (${read.error})`);
  else if (!read.agents.length) reasons.push('contexto inicial no medido: las conversaciones del pase no están guardadas');
  else if (!starts.length) reasons.push('contexto inicial no medido: las conversaciones del pase no traen números de consumo');
  r.reason = reasons.length ? reasons.join(' · ') : null;
  return r;
}

/** Un agente que suma sus tokens con algo sin contar: el total en el que entra es un piso, y se dice. */
const isPartial = (a) => a.tokens !== null && typeof a.reason === 'string' && a.reason.startsWith('medido parcial');

function countByClass(agents) {
  const byClass = {};
  for (const a of agents) byClass[a.class] = (byClass[a.class] || 0) + 1;
  return byClass;
}

function ordered(byClass) {
  const out = {};
  for (const c of CLASSES) if (byClass[c]) out[c] = byClass[c];
  return out;
}

/** `pass` es la sesión donde corrió el pase (la del marcador) con sus workflows; casi siempre, la de la ejecución. */
function measureRun(dump, own, wfs, pass, agentsDir, readErrors) {
  const from = Date.parse(dump.startedAt);
  const to = Date.parse(dump.archivedAt);
  const byClass = countByClass(own);
  const otherTypes = {};
  for (const a of own) if (a.class === 'other') otherTypes[a.type] = (otherTypes[a.type] || 0) + 1;
  const adversarial = dump.runIdUnreadable
    ? { runId: '(ilegible)', agents: null, tokens: null, startTime: null, startingContext: stats([], 0), reason: 'no medido: el volcado trae el pase sin un runId legible' }
    : (dump.runId ? adversarialOf(pass, dump.runId, agentsDir, readErrors) : null);
  if (adversarial && adversarial.agents) byClass.adversarial = adversarial.agents;
  const otherWorkflows = wfs.workflows
    .filter((w) => w.runId !== dump.runId && w.startMs !== null && w.startMs >= from && w.startMs <= to)
    .map((w) => ({ runId: w.runId, agents: w.agents, tokens: w.tokens, startTime: isoOf(w.startMs) }));
  const starts = own.map((a) => a.startingContext).filter((v) => v !== null);
  return {
    story: dump.story, sessionId: dump.sessionId, startedAt: dump.startedAt, archivedAt: dump.archivedAt,
    agents: own, byClass: ordered(byClass), otherTypes, adversarial, otherWorkflows,
    totalAgents: own.length + ((adversarial && adversarial.agents) || 0),
    startingContext: stats(starts, own.length - starts.length),
    tokens: own.reduce((s, a) => s + (a.tokens || 0), 0) + ((adversarial && adversarial.tokens) || 0),
    unmeasuredAgents: own.filter((a) => a.tokens === null).length,
    partialAgents: own.filter(isPartial).length,
  };
}

/** Cada agente a una sola ejecución: la última de su sesión que arrancó antes que él y lo tiene en su ventana. */
function assign(agents, dumps) {
  const byDump = new Map(dumps.map((d) => [d, []]));
  const sorted = [...dumps].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const used = new Set();
  for (const a of agents) {
    const t = Date.parse(a.startedAt || '');
    if (!Number.isFinite(t)) continue;
    let owner = null;
    for (const d of sorted) if (t >= Date.parse(d.startedAt) && t <= Date.parse(d.archivedAt)) owner = d;
    if (owner) { byDump.get(owner).push(a); used.add(a); }
  }
  return { byDump, used };
}

/**
 * Devuelve { runs, unmeasuredRuns, outsideRuns, readErrors, summary, missingSession }. Con `session`, sólo esa
 * sesión; con `all`, todas las de la máquina. `agentsDir` es la carpeta de los `.md` de revisores (por defecto, la del
 * arnés).
 */
function measure({ projectsDir, historyDir, historyRequired = false, session = null, all = false, agentsDir } = {}) {
  const readErrors = [];
  // sin la carpeta de agentes, cada revisor sale como «otro»: se dice
  const agentsRoot = agentsDir || models.agentsDirDefault();
  const seenAgents = probe(agentsRoot);
  if (seenAgents !== true) {
    readErrors.push({ where: 'agents', name: safeName(path.basename(agentsRoot)), reason: `${seenAgents === false ? 'ENOENT' : seenAgents}: los revisores salen como «otro»` });
  }
  const sessions = sessionDirs(projectsDir, readErrors);
  const { dumps: allDumps, unreadable } = readDumps(historyDir, readErrors, historyRequired);
  const dumps = allDumps
    .filter((d) => all || d.sessionId === session)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const wanted = all ? [...sessions.keys()] : (session && sessions.has(session) ? [session] : []);
  const perSession = new Map(wanted.map((s) => {
    const read = readAgents(path.join(sessions.get(s), 'subagents'), agentsDir);
    if (read.error) readErrors.push({ where: 'subagents', name: safeName(s), reason: read.error });
    return [s, { ...read, wfs: readWorkflows(sessions.get(s), readErrors) }];
  }));
  const runs = [];
  const unmeasuredRuns = [];
  const measurable = new Map();
  for (const d of dumps) {
    const base = { story: d.story, sessionId: d.sessionId, startedAt: d.startedAt, file: d.file };
    const s = perSession.get(d.sessionId);
    if (!s) unmeasuredRuns.push({ ...base, reason: 'no medida: la sesión ya no está en la máquina' });
    else if (!d.startedAt || !d.archivedAt) unmeasuredRuns.push({ ...base, reason: 'no medida: el volcado no trae la hora de arranque o de cierre' });
    else if (Date.parse(d.archivedAt) < Date.parse(d.startedAt)) unmeasuredRuns.push({ ...base, reason: 'no medida: la ventana está al revés (cierra antes de arrancar)' });
    else if (s.error) unmeasuredRuns.push({ ...base, reason: `no medida: no se pudo leer la carpeta de agentes (${s.error})` });
    else {
      if (!measurable.has(d.sessionId)) measurable.set(d.sessionId, []);
      measurable.get(d.sessionId).push(d);
    }
  }
  unmeasuredRuns.push(...unreadable);
  // el pase puede haber corrido en otra sesión: sus workflows se leen una vez, aunque esa sesión no se mida
  const passWfs = new Map();
  const passSid = (d) => d.passSessionId;
  const passOf = (d) => {
    const sid = passSid(d);
    // el pase se busca sólo en la sesión que anota el marcador: si no está, se nombra, no se cae a otra
    const nothing = { workflows: [], error: null };
    if (sid === null) return { sesDir: null, wfs: nothing, missing: 'no medido: el volcado trae la sesión del pase sin un id legible' };
    if (!sessions.has(sid)) return { sesDir: null, wfs: nothing, missing: `no medido: la sesión del pase (${sid}) no está en la máquina` };
    if (perSession.has(sid)) return { sesDir: sessions.get(sid), wfs: perSession.get(sid).wfs, missing: null };
    if (!passWfs.has(sid)) passWfs.set(sid, readWorkflows(sessions.get(sid), readErrors));
    return { sesDir: sessions.get(sid), wfs: passWfs.get(sid), missing: null };
  };
  const used = new Set();
  const runOf = new Map();
  for (const [sid, list] of measurable) {
    const s = perSession.get(sid);
    const a = assign(s.agents, list);
    for (const x of a.used) used.add(x);
    for (const d of list) runOf.set(d, measureRun(d, a.byDump.get(d), s.wfs, passOf(d), agentsDir, readErrors));
  }
  for (const d of dumps) if (runOf.has(d)) runs.push(runOf.get(d));
  // un workflow sin hora no se ubica en ninguna ventana: se dice, salvo que sea el pase de un volcado
  for (const [sid, s] of perSession) {
    const passes = new Set(allDumps.filter((d) => passSid(d) === sid && d.runId).map((d) => d.runId));
    for (const w of s.wfs.workflows) {
      if (!w.error && w.startMs === null && !passes.has(w.runId)) {
        readErrors.push({ where: 'workflow', name: w.runId, reason: 'sin startTime: no se ubica en una ejecución' });
      }
    }
  }
  const outside = [];
  for (const s of perSession.values()) for (const a of s.agents) if (!used.has(a)) outside.push(a);
  const outsideRuns = {
    agents: outside.length, byClass: ordered(countByClass(outside)),
    tokens: outside.reduce((s, a) => s + (a.tokens || 0), 0),
    unmeasuredAgents: outside.filter((a) => a.tokens === null).length,
    partialAgents: outside.filter(isPartial).length,
    list: outside,
  };
  const tokensByClass = {};
  for (const r of runs) {
    // un agente sin medir no suma un cero a su clase: lo dice «sin sumar»
    for (const a of r.agents) if (a.tokens !== null) tokensByClass[a.class] = (tokensByClass[a.class] || 0) + a.tokens;
    if (r.adversarial && r.adversarial.tokens) tokensByClass.adversarial = (tokensByClass.adversarial || 0) + r.adversarial.tokens;
  }
  // una clase sin tokens medidos no compite: sin ninguna medida, no hay clase que más pese
  const heaviest = Object.entries(tokensByClass).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
  const counted = runs.filter((r) => !(r.adversarial && r.adversarial.agents === null));
  const perRun = counted.map((r) => r.totalAgents);
  const summary = {
    runs: runs.length,
    unmeasuredRuns: unmeasuredRuns.length,
    unmeasuredAgents: runs.reduce((k, r) => k + r.unmeasuredAgents, 0),
    partialAgents: runs.reduce((k, r) => k + r.partialAgents, 0),
    unmeasuredPasses: runs.filter((r) => r.adversarial && (r.adversarial.agents === null || r.adversarial.tokens === null)).length,
    agentsPerRun: { median: percentile(perRun, 0.5), p90: percentile(perRun, 0.9), excluded: runs.length - counted.length },
    tokensByClass: ordered(tokensByClass),
    heaviestClass: heaviest ? heaviest[0] : null,
  };
  return { runs, unmeasuredRuns, outsideRuns, readErrors, summary, missingSession: !all && !sessions.has(session) };
}

const CLASS_NAMES = { validator: 'validador', reviewer: 'revisor', adversarial: 'pase adversarial', helper: 'ayudante', other: 'otro' };
const fmt = (v) => (v === null || v === undefined ? 'no medido' : Math.round(v).toLocaleString('es-AR'));
const classes = (byClass) => Object.entries(byClass).map(([c, k]) => `${CLASS_NAMES[c] || c} ${k}`).join(' · ') || 'ninguno';
const notMeasured = (k) => (k ? ` · ${k} no medidos` : '');
const partials = (k) => (k ? ` · ${k} medido${k === 1 ? '' : 's'} parcial (el total es un piso)` : '');

function render(r) {
  const out = ['agentes por ejecución del pipeline (contexto inicial = la primera respuesta de cada agente)', ''];
  for (const run of r.runs) {
    const others = Object.entries(run.otherTypes).map(([t, k]) => `${t} ${k}`).join(', ');
    const sc = run.startingContext;
    const a = run.adversarial;
    const passMissing = a && a.agents === null ? ' + el pase no medido' : '';
    const passTokensMissing = a && a.tokens === null ? ' + el pase no medido' : '';
    out.push(`${run.story} · sesión ${run.sessionId} · ${run.startedAt} → ${run.archivedAt}`);
    out.push(`  agentes: ${run.totalAgents}${passMissing} (${classes(run.byClass)})${others ? ` · otros: ${others}` : ''}`);
    out.push(`  contexto inicial: mediana ${fmt(sc.median)} · p90 ${fmt(sc.p90)} · medidos ${sc.measured}${sc.unmeasured ? ` · no medidos ${sc.unmeasured}` : ''}`);
    out.push(`  tokens de los agentes: ${fmt(run.tokens)}${notMeasured(run.unmeasuredAgents)}${partials(run.partialAgents)}${passTokensMissing}`);
    if (a) {
      out.push(`  pase adversarial ${a.runId}: ${fmt(a.agents)} agentes · ${fmt(a.tokens)} tokens · contexto inicial mediana ${fmt(a.startingContext.median)}${a.reason ? ` (${a.reason})` : ''}`);
    }
    for (const w of run.otherWorkflows) {
      out.push(`  otro workflow ${w.runId} (${w.startTime}): ${fmt(w.agents)} agentes · ${fmt(w.tokens)} tokens — no se suma`);
    }
    for (const x of run.agents) {
      out.push(`    ${x.startedAt || 'sin hora'}  ${CLASS_NAMES[x.class]}  ${x.type}  ${x.model || 'modelo no medido'}  inicial ${fmt(x.startingContext)}  total ${fmt(x.tokens)}${x.reason ? `  (${x.reason})` : ''}`);
    }
    out.push('');
  }
  for (const u of r.unmeasuredRuns) {
    out.push(u.sessionId ? `${u.story} · sesión ${u.sessionId} · ${u.startedAt}: ${u.reason}` : `${u.file}: ${u.reason}`);
  }
  if (r.unmeasuredRuns.length) out.push('');
  for (const e of r.readErrors) out.push(`no se pudo leer: ${e.where} ${e.name} (${e.reason})`);
  if (r.readErrors.length) out.push('');
  const o = r.outsideRuns;
  out.push(`fuera de una ejecución: ${o.agents} agentes (${classes(o.byClass)}) · ${fmt(o.tokens)} tokens${notMeasured(o.unmeasuredAgents)}${partials(o.partialAgents)}`);
  const s = r.summary;
  const excluded = s.agentsPerRun.excluded ? ` (sin ${s.agentsPerRun.excluded} con el pase no medido)` : '';
  out.push(`resumen: ${s.runs} ejecuciones medidas · ${s.unmeasuredRuns} no medidas · agentes por ejecución mediana ${fmt(s.agentsPerRun.median)}, p90 ${fmt(s.agentsPerRun.p90)}${excluded}`);
  const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'} no medido${k === 1 ? '' : 's'}`;
  const unsummed = [s.unmeasuredAgents && plural(s.unmeasuredAgents, 'agente'), s.unmeasuredPasses && plural(s.unmeasuredPasses, 'pase')].filter(Boolean);
  const floor = s.partialAgents ? ` · ${s.partialAgents} agente${s.partialAgents === 1 ? '' : 's'} medido${s.partialAgents === 1 ? '' : 's'} parcial` : '';
  const tail = (unsummed.length ? ` · sin sumar: ${unsummed.join(' y ')}` : '') + floor;
  if (s.heaviestClass || tail) {
    const parts = Object.entries(s.tokensByClass).map(([c, v]) => `${CLASS_NAMES[c]} ${fmt(v)}`).join(' · ');
    const heaviest = s.heaviestClass ? `${CLASS_NAMES[s.heaviestClass]} (${parts})` : 'no medido';
    out.push(`  la clase que más pesa en las ejecuciones (lo de afuera va en su línea): ${heaviest}${tail}`);
  }
  return `${out.join('\n')}\n`;
}

const USAGE = 'agents-per-run: uso: agents-per-run.js (--session <id> | --all) [--json] [--projects-dir <dir>] [--history-dir <dir>]\n';

function main(argv) {
  const opts = {};
  const valued = new Set(['--session', '--projects-dir', '--history-dir']);
  // una opción mal escrita no se ignora: con ella, el medidor leería otra carpeta sin decirlo
  for (let i = 0; i < argv.length; i++) {
    if (valued.has(argv[i])) { i++; continue; }
    if (argv[i] !== '--all' && argv[i] !== '--json') {
      process.stderr.write(`agents-per-run: opción desconocida: ${safeName(argv[i])}\n${USAGE}`);
      return 2;
    }
  }
  for (const k of ['--session', '--projects-dir', '--history-dir']) {
    const i = argv.indexOf(k);
    if (i < 0) continue;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) { process.stderr.write(`agents-per-run: ${k} sin valor\n${USAGE}`); return 2; }
    opts[k] = v;
  }
  const session = opts['--session'] || null;
  const all = argv.includes('--all');
  if (!session === !all) { process.stderr.write(USAGE); return 2; }
  const projectsDir = opts['--projects-dir'] || path.join(os.homedir(), '.claude', 'projects');
  const r = measure({
    projectsDir,
    historyDir: opts['--history-dir'] || path.join(stateDirOf(os.homedir()), 'timing-history'),
    historyRequired: Boolean(opts['--history-dir']),
    session,
    all,
  });
  if (r.missingSession) {
    for (const e of r.readErrors) process.stderr.write(`agents-per-run: no se pudo leer: ${e.where} ${e.name} (${e.reason})\n`);
    process.stderr.write(`agents-per-run: no se encontró la sesión ${safeName(session)} en ${projectsDir}\n`);
    return 1;
  }
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(r, null, 2)}\n` : render(r));
  return 0;
}

module.exports = { measure, render };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
