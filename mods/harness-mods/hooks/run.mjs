// Del marker del pipeline al renglón del cartel y a la tabla de /pipeline. Puro: no usa el motor, el reloj
// ni la sesión, para poder probarlo con node (scripts/tests/harness-mods.test.js).
//
// Nunca muestra dinero, a propósito.

import { STEPS, TOTAL, OLD_IDS, OLD_FLAG, START_PART_FAILED } from './steps.mjs';

export const NO_RUN_TEXT = 'No hay una ejecución del pipeline en esta sesión.';
export const BROKEN_RUN_TEXT = 'el contenido no es una ejecución del pipeline (el archivo está dañado)';
export const OLD_RUN_TEXT = 'Esta ejecución empezó con la versión anterior del arnés: sus pasos se muestran con los nombres nuevos.';

const ms = (iso) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
const minutes = (from, to) => (from === null || to === null ? null : Math.max(0, Math.round((to - from) / 60000)));
const show = (v) => (v === null || v === undefined ? '—' : String(v));
const two = (n) => String(n).padStart(2, '0');

/**
 * El tiempo total de la corrida, para leerlo de un vistazo: «35 min», «3 h 12 min» o, desde un día entero, desde
 * cuándo corre («desde ayer 15:20», o «desde el 23/10 15:20» si es de antes). La hora es la de la máquina.
 */
export function totalText(minutesTotal, startedMs, now) {
  if (minutesTotal === null || minutesTotal === undefined) return '— min';
  if (minutesTotal < 60) return `${minutesTotal} min`;
  if (minutesTotal < 24 * 60 || startedMs === null || startedMs === undefined) {
    const h = Math.floor(minutesTotal / 60);
    const m = minutesTotal % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const start = new Date(startedMs);
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const hour = `${two(start.getHours())}:${two(start.getMinutes())}`;
  return day(start) === day(yesterday) ? `desde ayer ${hour}` : `desde el ${two(start.getDate())}/${two(start.getMonth() + 1)} ${hour}`;
}

/**
 * Qué dice el cartel cuando la corrida no tiene paso abierto: lo que espera. `entering` es la respuesta de
 * `work-in-progress.js --marker` (`{ prs, failed }`); sin ella todavía no se preguntó.
 */
export function idleStep(entering) {
  if (!isObj(entering) || !Array.isArray(entering.prs)) return 'sin paso abierto';
  if (entering.prs.length) return `esperando que entren los pedidos (${entering.prs.map((p) => p.ref).join(', ')})`;
  return entering.failed ? 'sin paso abierto (no pude consultar los pedidos)' : 'lista para cerrar';
}
const stepText = (run) => (run.current ? run.current.name : idleStep(run.entering));
/**
 * El avance, en el cartel y en /pipeline: el paso EN CURSO con su número de la tabla («paso 10 de 11»); sin paso abierto,
 * los hechos («9 de 11 hechos»). «9/11» se leía como «estoy en el 9» con el 10 en curso.
 */
export const progressText = (run) => (run.current && run.current.number ? `paso ${run.current.number} de ${run.total}` : `${run.done} de ${run.total} hechos`);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/** 2 (pasos por nombre), 1 (el marker viejo, por número) o `null` (ninguno de los dos). */
function schemeOf(m) {
  const listas = [m.stepsCompleted, m.stepsPending].filter((l) => l !== undefined);
  if (listas.some((l) => !Array.isArray(l))) return null;
  const items = listas.flat().map(String);
  if (m.stepScheme === 2) return items.every((x) => STEPS.some((s) => s.id === x) || x === 'close-work-item') ? 2 : null;
  if (m.stepScheme !== undefined) return null;
  return items.every((x) => OLD_IDS.includes(x)) ? 1 : null;
}

/**
 * El marker como lo ve el cartel: los pasos hechos y sus horas por nombre de máquina, sea cual sea su esquema. El viejo
 * se lee con la equivalencia: el Arranque con el 0; Implementar y Correr las pruebas con el 4 (no se reparte: Correr
 * las pruebas lleva sólo el fin); Hallazgos con el 6 y el 7.
 */
function normalize(m, scheme) {
  const raw = isObj(m.stepTimings) ? m.stepTimings : {};
  if (scheme === 2) return { completed: new Set((m.stepsCompleted || []).map(String)), timings: raw };
  const done = new Set((m.stepsCompleted || []).map(String));
  const oldDone = (o) => done.has(o) || (OLD_FLAG[o] || []).some((f) => m[f] === true);
  const t = (o) => (isObj(raw[o]) ? raw[o] : {});
  const completed = new Set();
  const timings = {};
  for (const s of STEPS) {
    const old = s.id === 'start' ? ['0'] : s.id === 'reviewers' ? ['5'] : s.old;
    if (old.every(oldDone)) completed.add(s.id);
  }
  const put = (id, startedAt, completedAt) => {
    const v = {};
    if (startedAt) v.startedAt = startedAt;
    if (completedAt) v.completedAt = completedAt;
    if (Object.keys(v).length) timings[id] = v;
  };
  put('start', t('0').startedAt, t('0').completedAt);
  put('validate-story', t('1').startedAt, t('1').completedAt);
  put('plan', t('2').startedAt, t('2').completedAt);
  put('approve-plan', t('3').startedAt, t('3').completedAt);
  put('implement', t('4').startedAt, t('4').completedAt);
  put('run-tests', null, t('4').completedAt);
  put('reviewers', t('5').startedAt || t('7b').startedAt, t('5').completedAt);
  put('adversarial-pass', t('5b').startedAt, t('5b').completedAt);
  put('findings', t('6').startedAt || t('7').startedAt, completed.has('findings') ? (t('7').completedAt || t('6').completedAt) : null);
  put('live-check', t('7c').startedAt, t('7c').completedAt);
  put('prepare-commit', t('8').startedAt, t('8').completedAt);
  return { completed, timings };
}

/**
 * El motivo por el que el texto del marker NO es una ejecución legible: `null` si no hay ejecución (vacío, o un objeto
 * sin story, que es un marker cerrado) o si se lee bien. Un JSON roto, algo que no es un objeto, o listas de pasos que no
 * son de ninguno de los dos esquemas son un error, nunca «sin ejecución».
 */
export function readRunError(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let m;
  try { m = JSON.parse(text); } catch (_) { return BROKEN_RUN_TEXT; }
  if (!isObj(m)) return BROKEN_RUN_TEXT;
  if (typeof m.storyId !== 'string' || m.storyId === '') return null;
  return schemeOf(m) === null ? BROKEN_RUN_TEXT : null;
}

/**
 * Lee el texto del marker. Devuelve `null` si no hay corrida (vacío, sin story) o si no se puede leer (eso lo dice
 * `readRunError`). `now` en milisegundos.
 */
export function readRun(text, now) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let m;
  try { m = JSON.parse(text); } catch (_) { return null; }
  if (!isObj(m) || typeof m.storyId !== 'string' || m.storyId === '') return null;
  const scheme = schemeOf(m);
  if (scheme === null) return null;

  const { completed, timings } = normalize(m, scheme);
  const flagOf = (id) => (STEPS.find((s) => s.id === id) || {}).flag;
  const startOf = (id) => ms(timings[id] && timings[id].startedAt);
  const endOf = (id) => ms(timings[id] && timings[id].completedAt);
  const index = (id) => STEPS.findIndex((s) => s.id === id);
  const later = (id) => STEPS.slice(index(id) + 1);
  // `complete-step` anota sólo `completedAt` y `stepsCompleted`, sin `startedAt`: un paso posterior «tocado» es
  // cualquiera de las tres cosas
  const laterTouched = (id) => later(id).some((s) => startOf(s.id) !== null || endOf(s.id) !== null || completed.has(s.id));
  // un principal abierto queda viejo si un paso posterior se movió DESPUÉS de su arranque (el 0 que nunca se cerró);
  // si arrancó después de todo lo posterior, es una vuelta atrás de verdad (los revisores otra vez)
  const stale = (id) => {
    const st = startOf(id);
    if (st === null) return false;
    return later(id).some((s) => {
      const t = endOf(s.id) !== null ? endOf(s.id) : startOf(s.id);
      return t !== null ? t > st : completed.has(s.id);
    });
  };

  // otra vuelta de revisores: con Hallazgos cerrado, una edición de código o prueba posterior al ÚLTIMO cierre de los
  // revisores, como `pipeline.js next`. Decide la marca `code` que on-edit pone en cada edición; un evento sin la marca
  // (de una versión anterior) cuenta si no es un .md
  const tRev = timings.reviewers || {};
  const revEnd = ms(tRev.lastCompletedAt) !== null ? ms(tRev.lastCompletedAt) : endOf('reviewers');
  const esCodigo = (e) => (typeof e.code === 'boolean' ? e.code : !/\.md$/i.test(String(e.path || '')));
  const reloop = scheme === 2 && completed.has('findings') && revEnd !== null
    && (Array.isArray(m.fileEvents) ? m.fileEvents : []).some((e) => e && ms(e.ts) !== null && ms(e.ts) > revEnd && esCodigo(e));
  const round = reloop ? (Number((timings.reviewers || {}).rounds) || 1) + 1 : null;

  const finished = (id) => {
    if (id === 'reviewers' && reloop) return false;
    if (endOf(id) !== null || completed.has(id)) return true;
    const flag = flagOf(id);
    if (flag && m[flag] === true) return true;
    // un paso que se cierra con bandera y no anota su fin está hecho si ya se tocó uno posterior; los demás, si
    // quedaron viejos
    return flag ? laterTouched(id) : stale(id);
  };

  const open = STEPS.filter((s) => startOf(s.id) !== null && !finished(s.id));
  open.sort((a, b) => startOf(b.id) - startOf(a.id));
  const current = reloop ? STEPS.find((s) => s.id === 'reviewers') : (open[0] || STEPS.find((s) => !finished(s.id)) || null);
  const nameOf = (s) => (s.id === 'reviewers' && round ? `${s.name}, vuelta ${round}` : s.name);

  // fin de un paso sin `completedAt`: el arranque del siguiente que arrancó después
  const starts = STEPS.map((s) => startOf(s.id)).filter((t) => t !== null).sort((a, b) => a - b);
  const stopOf = (id) => {
    const end = endOf(id);
    if (end !== null) return end;
    const st = startOf(id);
    if (st === null) return null;
    if (current && current.id === id) return now;
    const next = starts.find((t) => t > st);
    return next === undefined ? null : next;
  };

  // un paso abierto sin `startedAt` (la sesión trabajó sin llamar `pipeline.js next`) cuenta desde el último cierre de
  // los pasos anteriores; sin cierre, no hay desde cuándo
  const previousClose = (id) => {
    const ends = STEPS.slice(0, index(id)).map((s) => endOf(s.id)).filter((t) => t !== null);
    return ends.length ? Math.max(...ends) : null;
  };

  const warnings = (Array.isArray(m.startWarnings) ? m.startWarnings : [])
    .filter((w) => w && START_PART_FAILED[w.part]).map((w) => `Arranque: hecho, con aviso: ${START_PART_FAILED[w.part]}`);
  const rows = STEPS.map((s) => {
    const done = finished(s.id);
    const state = done ? (s.id === 'start' && warnings.length ? 'hecho, con aviso' : 'hecho') : current && current.id === s.id ? 'corriendo' : startOf(s.id) !== null ? 'empezado, sin terminar' : 'pendiente';
    return { id: s.id, number: s.number, name: s.id === 'reviewers' && round ? `${s.name} (vuelta ${round})` : s.name, state, minutes: minutes(startOf(s.id), stopOf(s.id)) };
  });

  // espera a la persona: la bandera, «Aprobar el plan» sin modo autónomo, o «Hallazgos» cuando de verdad preguntó y
  // todavía no le contestaron (en el marker viejo, la decisión de los hallazgos —el 7— sin modo autónomo, como antes)
  const tFind = timings.findings || {};
  const answered = Boolean(current && current.id === 'findings' && ms(tFind.waitStartedAt) !== null && ms(tFind.waitEndedAt) !== null);
  const asks = current && ((current.id === 'approve-plan' && m.autonomous !== true)
    || (current.id === 'findings' && !answered && (ms(tFind.waitStartedAt) !== null || (scheme === 1 && m.autonomous !== true))));
  return {
    storyId: m.storyId,
    title: typeof m.storyTitle === 'string' && m.storyTitle.trim() !== '' ? m.storyTitle.trim() : null,
    current: current ? { id: current.id, name: nameOf(current), number: current.number } : null,
    done: STEPS.filter((s) => finished(s.id)).length,
    total: TOTAL,
    minutesStep: current ? minutes(startOf(current.id) !== null ? startOf(current.id) : previousClose(current.id), now) : null,
    minutesTotal: minutes(ms(m.startedAt), now),
    totalText: totalText(minutes(ms(m.startedAt), now), ms(m.startedAt), now),
    waiting: m.waitingForHuman === true || Boolean(asks),
    answered,
    oldScheme: scheme === 1,
    warnings,
    rows,
  };
}

/**
 * La ruta de la story del marker: `storyPath` tal cual si es absoluta, si no contra `repoPath`. `null` si falta.
 */
export function storyPathOf(text) {
  let m;
  try { m = JSON.parse(text); } catch (_) { return null; }
  if (!m || typeof m.storyPath !== 'string' || m.storyPath === '') return null;
  const p = m.storyPath;
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return p;
  return typeof m.repoPath === 'string' && m.repoPath !== '' ? `${m.repoPath.replace(/[\\/]+$/, '')}/${p}` : null;
}

/** El `title:` del frontmatter de la story, sin comillas. `null` si no hay frontmatter o no trae título. */
export function specTitle(text) {
  if (typeof text !== 'string') return null;
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return null;
  const line = /^title:[ \t]*(.+)$/m.exec(fm[1]);
  if (!line) return null;
  let t = line[1].trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) t = t.slice(1, -1).replace(/\\"/g, '"');
  return t.trim() === '' ? null : t.trim();
}

/**
 * El título corto del cartel: hasta el primer «:» o « — » si deja algo legible, y nunca más de `max` caracteres
 * (se corta en una palabra). Lleva «…» cuando se sacó algo.
 */
export function shortTitle(title, max = 40) {
  if (typeof title !== 'string' || title.trim() === '') return null;
  const full = title.trim();
  let t = full;
  const cut = t.search(/:\s| — /);
  if (cut >= 8) t = t.slice(0, cut);
  if (t.length > max) {
    const space = t.lastIndexOf(' ', max);
    t = t.slice(0, space >= 8 ? space : max);
  }
  t = t.replace(/[\s,;.:—-]+$/, '');
  return t.length < full.length ? `${t}…` : t;
}

/** Los pedazos del renglón del cartel: la story, su título corto (o `null`), el paso y el resto. */
export function boardParts(run, contextPercent) {
  const pct = typeof contextPercent === 'number' && Number.isFinite(contextPercent) ? Math.round(contextPercent) : null;
  const rest = [
    progressText(run),
    `${show(run.minutesStep)} min en este paso`,
    `${run.totalText || `${show(run.minutesTotal)} min`} en total`,
    `contexto usado ${show(pct)} %`,
  ];
  if (run.waiting) rest.push('te espera');
  for (const w of run.warnings || []) rest.push(w);
  return {
    story: `Story ${run.storyId}`,
    title: shortTitle(run.title),
    step: stepText(run),
    rest,
  };
}

/**
 * El renglón del cartel. `contextPercent` puede faltar. El paso va por su nombre, sin el id; con el
 * título de la story, va corto después del número.
 */
export function boardLine(run, contextPercent) {
  const p = boardParts(run, contextPercent);
  return [p.story, ...(p.title ? [p.title] : []), p.step, ...p.rest].join(' · ');
}

/**
 * «te espera» que no se pierde: el Stop-hook del pipeline borra `waitingForHuman` al cerrar el turno, justo cuando
 * empieza la espera. Se recuerda la clave `story:paso` mientras la corrida siga en ese paso y nadie haya contestado
 * (`answered`: el marcador anotó el fin de la espera).
 * Devuelve `{ run, remember }`: la corrida (con `waiting` ajustado) y la clave a guardar para el próximo refresco.
 */
export function stickyWaiting(run, remembered) {
  if (!run || !run.current) return { run, remember: null };
  const key = `${run.storyId}:${run.current.id}`;
  if (run.waiting) return { run, remember: key };
  if (run.answered) return { run, remember: null };
  if (remembered === key) return { run: { ...run, waiting: true }, remember: key };
  return { run, remember: null };
}

/** Anota la clave del aviso de una vez (sin «mirar y después escribir»): `{ list, added }`. */
export function addWarned(list, key) {
  const l = Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  return l.includes(key) ? { list: l, added: false } : { list: [...l, key], added: true };
}

/**
 * Las carpetas donde buscar el estado del pipeline, como tycon-home.js: `TYCON_HOME/state` y, bajo cada raíz del
 * usuario (HOME y USERPROFILE: en Windows `os.homedir()` usa USERPROFILE), `.tycon/state` y `.claude/.tycon-pipeline`.
 */
export function stateDirs(vars) {
  const v = vars || {};
  const out = [];
  const add = (d) => { if (d && !out.includes(d)) out.push(d); };
  if (v.TYCON_HOME) add(`${v.TYCON_HOME}/state`);
  for (const root of [v.HOME, v.USERPROFILE]) {
    if (!root) continue;
    add(`${root}/.tycon/state`);
    add(`${root}/.claude/.tycon-pipeline`);
  }
  return out;
}

/** El texto del aviso «te espera»: el paso por su nombre, sin el id. */
export function waitingToast(run) {
  const step = run && run.current ? run.current.name : 'El pipeline';
  const title = run ? shortTitle(run.title) : null;
  return `Story ${run ? run.storyId : '?'}${title ? ` (${title})` : ''}: ${step} te espera — contestá en el chat`;
}

/** La clave del aviso «te espera» si corresponde darlo ahora; `null` si no espera o ya se avisó. */
export function warnKey(run, warned) {
  if (!run || !run.waiting || !run.current) return null;
  const key = `${run.storyId}:${run.current.id}`;
  return (warned || []).includes(key) ? null : key;
}

/** La respuesta de /pipeline: un resumen y la tabla de pasos (en Markdown). */
export function pipelineTable(run) {
  const title = typeof run.title === 'string' && run.title !== '' ? ` «${run.title}»` : '';
  const head = `Story ${run.storyId}${title} — ${stepText(run)}` +
    ` · ${progressText(run)} · ${run.totalText || `${show(run.minutesTotal)} min`} en total${run.waiting ? ' · te espera' : ''}`;
  const lines = [head, ...(run.warnings || []), ...(run.oldScheme ? [OLD_RUN_TEXT] : []), '', '| Paso | Estado | Tiempo |', '|---|---|---|'];
  for (const r of run.rows) lines.push(`| ${r.number ? `${r.number}. ` : ''}${r.name} | ${r.state} | ${r.minutes === null ? '—' : `${r.minutes} min`} |`);
  return lines.join('\n');
}
