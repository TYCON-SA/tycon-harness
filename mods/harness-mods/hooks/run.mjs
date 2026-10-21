// Del marker del pipeline al renglón del cartel y a la tabla de /pipeline. Puro: no usa el motor, el reloj
// ni la sesión, para poder probarlo con node (scripts/tests/harness-mods.test.js).
//
// Nunca muestra dinero, a propósito.

import { STEPS, SUBSTEP_FLAG, ASKS_DEV, MAIN_TOTAL } from './steps.mjs';

export const NO_RUN_TEXT = 'No hay una corrida del pipeline en esta sesión.';

const isMain = (id) => /^\d$/.test(id);
const ms = (iso) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
const minutes = (from, to) => (from === null || to === null ? null : Math.max(0, Math.round((to - from) / 60000)));
const show = (v) => (v === null || v === undefined ? '—' : String(v));

/**
 * Lee el texto del marker. Devuelve `null` si no hay corrida (vacío, ilegible, o sin story).
 * `now` en milisegundos.
 */
export function readRun(text, now) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let m;
  try { m = JSON.parse(text); } catch (_) { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.storyId !== 'string' || m.storyId === '') return null;

  const completed = new Set((Array.isArray(m.stepsCompleted) ? m.stepsCompleted : []).map(String));
  const timings = m.stepTimings && typeof m.stepTimings === 'object' ? m.stepTimings : {};
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

  const finished = (id) => {
    if (endOf(id) !== null || completed.has(id)) return true;
    const flag = SUBSTEP_FLAG[id];
    if (flag && m[flag] === true) return true;
    // un sub-paso que no anota su fin está hecho si ya se tocó uno posterior; un principal, si quedó viejo
    return isMain(id) ? stale(id) : laterTouched(id);
  };

  const open = STEPS.filter((s) => startOf(s.id) !== null && !finished(s.id));
  open.sort((a, b) => startOf(b.id) - startOf(a.id));
  const current = open[0] || STEPS.find((s) => !finished(s.id)) || null;

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

  const rows = STEPS.map((s) => {
    const state = finished(s.id) ? 'hecho' : current && current.id === s.id ? 'corriendo' : startOf(s.id) !== null ? 'empezado, sin terminar' : 'pendiente';
    return { id: s.id, name: s.name, state, minutes: minutes(startOf(s.id), stopOf(s.id)) };
  });

  const waiting = m.waitingForHuman === true || Boolean(current && ASKS_DEV.includes(current.id) && m.autonomous !== true);
  return {
    storyId: m.storyId,
    title: typeof m.storyTitle === 'string' && m.storyTitle.trim() !== '' ? m.storyTitle.trim() : null,
    current: current ? { id: current.id, name: current.name } : null,
    done: STEPS.filter((s) => isMain(s.id) && finished(s.id)).length,
    total: MAIN_TOTAL,
    minutesStep: current ? minutes(startOf(current.id), now) : null,
    minutesTotal: minutes(ms(m.startedAt), now),
    waiting,
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
    `${run.done} de ${run.total} hechos`,
    `${show(run.minutesStep)} min en este paso`,
    `${show(run.minutesTotal)} min en total`,
    `contexto usado ${show(pct)} %`,
  ];
  if (run.waiting) rest.push('te espera');
  return {
    story: `Story ${run.storyId}`,
    title: shortTitle(run.title),
    step: run.current ? run.current.name : 'sin paso abierto',
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
 * empieza la espera. Se recuerda la clave `story:paso` mientras la corrida siga en ese paso.
 * Devuelve `{ run, remember }`: la corrida (con `waiting` ajustado) y la clave a guardar para el próximo refresco.
 */
export function stickyWaiting(run, remembered) {
  if (!run || !run.current) return { run, remember: null };
  const key = `${run.storyId}:${run.current.id}`;
  if (run.waiting) return { run, remember: key };
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
  const head = `Story ${run.storyId}${title} — ${run.current ? run.current.name : 'sin paso abierto'}` +
    ` · ${run.done} de ${run.total} pasos hechos · ${show(run.minutesTotal)} min en total${run.waiting ? ' · te espera' : ''}`;
  const lines = [head, '', '| Paso | Estado | Tiempo |', '|---|---|---|'];
  for (const r of run.rows) lines.push(`| ${r.name} | ${r.state} | ${r.minutes === null ? '—' : `${r.minutes} min`} |`);
  return lines.join('\n');
}
