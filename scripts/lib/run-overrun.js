'use strict';
/**
 * run-overrun.js — si una corrida del pipeline va por el doble (o el cuádruple) de lo que se estimó al arrancar.
 *
 * La estimación es la que `pipeline.js start` deja en el marcador de la sesión (`estimate_min`, la suma de lo que tarda
 * cada paso en esta máquina). Lo real es el tiempo TRABAJADO por la sesión desde que arrancó la corrida
 * (`startedAt`): los tramos que anota scripts/lib/worked-time.js en `<estado>/worked/<día>.jsonl`, más el tramo abierto
 * del turno en curso (`workingSince` del archivo de estado de la sesión). Un tramo corta cuando la sesión espera a la
 * persona, así que las esperas no cuentan.
 *
 * El gancho de estado (scripts/hooks/session-state.js) lo mira después de cada herramienta, como mucho una vez por
 * minuto. Anota `overrun` en el archivo de estado de la sesión, que leen /wip, la oficina y `coordination.js status`
 * («va por el doble»). Y le avisa a la propia sesión una vez al pasar el doble y otra al pasar el cuádruple. No frena
 * nada ni le llega al dueño: el que cambia el rumbo es la coordinadora.
 *
 * Lo anotado de cada corrida (`<estado>/overrun/<sesión>.json`: la corrida, el último repaso y los umbrales avisados)
 * cambia cuando arranca otra corrida en la misma sesión. Off: TYCON_OVERRUN=0.
 *
 * Casos: scripts/tests/run-overrun.test.js
 */
const fs = require('fs');
const path = require('path');

const THRESHOLDS = [4, 2];
const CHECK_EVERY_MS = 60 * 1000;
const MAX_DAYS = 14;

const enabled = (env = process.env) => env.TYCON_OVERRUN !== '0';
const safeSid = (sid) => String(sid || '').replace(/[^\w.-]/g, '_');
const fileOf = (sdir, sid) => path.join(sdir, 'overrun', `${safeSid(sid)}.json`);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/**
 * Los tramos de sesión que son de la corrida: `[{ sid, from, to }]`. La sesión de ahora, desde que arrancó la corrida o
 * desde que la tomó (`adoptedAt` de `marker.js adopt-session`, `restoredAt` de un restore); y la sesión de la que la
 * tomó, desde que arrancó hasta ese momento. Lo que la sesión de ahora hizo antes de tomarla no es de la corrida.
 */
function segmentsOf(marker, sid, now) {
  const since = Date.parse(marker.startedAt);
  const took = Math.max(...[marker.adoptedAt, marker.restoredAt].map((x) => Date.parse(x)).filter(Number.isFinite), -Infinity);
  const out = [{ sid, from: Math.max(since, took), to: now }];
  for (const prev of [marker.adoptedFrom, marker.restoredFrom]) {
    if (typeof prev === 'string' && prev && prev !== sid && Number.isFinite(took) && took > since && !out.some((x) => x.sid === prev)) out.push({ sid: prev, from: since, to: took });
  }
  return out;
}

/**
 * Los milisegundos trabajados en los tramos de sesión `segments` (`[{ sid, from, to }]`): sus tramos cerrados más el
 * abierto de la sesión de ahora (`openSince`, para `openSid`). Mira los últimos días de cada tramo, hasta 14.
 */
function workedMs(sdir, segments, now, { openSince = null, openSid = null } = {}) {
  const W = require('./worked-time.js');
  const spans = [];
  const seen = new Set();
  for (const seg of segments) {
    if (!(seg.to > seg.from)) continue;
    const first = W.dayOf(Math.max(seg.from, seg.to - MAX_DAYS * 24 * 3600 * 1000));
    const last = W.dayOf(seg.to);
    let day = first;
    for (let i = 0; i <= MAX_DAYS + 1; i += 1) {
      let text = '';
      try { text = fs.readFileSync(path.join(W.dirOf(sdir), `${day}.jsonl`), 'utf8'); } catch { text = ''; }
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        let r;
        try { r = JSON.parse(raw); } catch { continue; }
        if (!r || r.sid !== seg.sid) continue;
        const key = `${r.sid}\0${r.desde}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const x = Math.max(Date.parse(r.desde), seg.from);
        const y = Math.min(Date.parse(r.hasta), seg.to);
        if (Number.isFinite(x) && Number.isFinite(y) && y > x) spans.push([x, y]);
      }
      if (day === last) break;
      day = W.addDays(day, 1);
    }
  }
  const open = Date.parse(openSince);
  const mine = segments.find((x) => x.sid === openSid);
  if (mine && Number.isFinite(open) && !seen.has(`${openSid}\0${openSince}`)) {
    const x = Math.max(open, mine.from);
    if (now > x) spans.push([x, now]);
  }
  // un tramo que el gancho y la preparación del día anotaron con horas distintas no suma dos veces: la unión
  let total = 0;
  let cur = null;
  for (const [x, y] of spans.sort((p, q) => p[0] - q[0])) {
    if (!cur || x > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [x, y]; } else cur[1] = Math.max(cur[1], y);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/**
 * Cuánto va una corrida contra su estimación: `{ factor, estimate_min, worked_min, storyId }`, con `factor` 2 o 4 (o
 * null si todavía no pasó el doble); null sin corrida en curso o sin estimación.
 */
function overrunOf(marker, { sdir, sid, now = Date.now(), openSince = null }) {
  if (!inProgress(marker)) return null;
  const estimate = Number(marker.estimate_min);
  if (!Number.isFinite(estimate) || estimate <= 0 || !Number.isFinite(Date.parse(marker.startedAt))) return null;
  const worked = Math.floor(workedMs(sdir, segmentsOf(marker, sid, now), now, { openSince, openSid: sid }) / 60000);
  const factor = THRESHOLDS.find((k) => worked >= k * estimate) || null;
  return { factor, estimate_min: estimate, worked_min: worked, storyId: marker.storyId || null };
}

const inProgress = (marker) => Boolean(marker && Array.isArray(marker.stepsPending) && marker.stepsPending.length);

/**
 * Lo que dice el archivo de estado de una sesión (scripts/lib/session-state.js) sobre su corrida: «va por el doble de lo
 * estimado (…)», o null. Lo leen /wip, la oficina y coordination.js status; nunca tira.
 */
function sessionText(sdir, sid) {
  try { return overrunText(require('./session-state.js').read(sdir, sid).state?.overrun); } catch { return null; }
}

/** «va por el doble de lo estimado (130 de 60 min trabajados)», o null. */
function overrunText(o) {
  if (!o || !o.factor) return null;
  return `va por el ${o.factor === 4 ? 'cuádruple' : 'doble'} de lo estimado (${o.worked_min} de ${o.estimate_min} min trabajados)`;
}

/**
 * El repaso de una sesión: `{ overrun, notice }`. `overrun` es lo que se anota en su archivo de estado (null si no
 * pasó el doble, o `undefined` si no tocaba repasar todavía); `notice`, el aviso para la sesión la primera vez que pasa
 * cada umbral, o null.
 */
function check(sdir, sid, { now = Date.now(), openSince = null, env = process.env } = {}) {
  const none = { overrun: undefined, notice: null };
  if (!sid) return none;
  // apagado, devuelve la marca vacía: si no, el archivo de estado la seguiría mostrando
  if (!enabled(env)) return { overrun: null, notice: null };
  const marker = readJson(path.join(sdir, 'active', `${safeSid(sid)}.json`));
  // sin corrida en curso (terminó, o no hay marcador) la marca se borra enseguida, sin esperar el minuto
  if (!inProgress(marker)) return { overrun: null, notice: null };
  const run = marker && marker.startedAt ? `${marker.storyId || ''}@${marker.startedAt}` : null;
  const file = fileOf(sdir, sid);
  const prev = readJson(file);
  const same = prev && prev.run === run;
  if (same && Number.isFinite(prev.checkedAt) && now - prev.checkedAt < CHECK_EVERY_MS) return none;
  const o = overrunOf(marker, { sdir, sid, now, openSince });
  const notified = same && Array.isArray(prev.notified) ? prev.notified : [];
  let notice = null;
  if (o && o.factor && !notified.includes(o.factor)) {
    notified.push(o.factor);
    // pasado el cuádruple sin haber avisado el doble, el doble ya no se avisa
    if (o.factor === 4 && !notified.includes(2)) notified.push(2);
    notice = `Esta ejecución${o.storyId ? ` (la ${o.storyId})` : ''} ${overrunText(o)}, sin contar las esperas. No frena nada. `
      + 'Mirá si está dando vueltas (revisores que rechazan otra vez, una prueba que no pasa) y, si hace falta cambiar el rumbo, '
      + 'decíselo a la coordinadora: ella lo ve en coordination.js status.';
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ run, checkedAt: now, notified }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* sin lo anotado, el próximo repaso vuelve a mirar */ }
  return { overrun: o && o.factor ? { factor: o.factor, estimate_min: o.estimate_min, worked_min: o.worked_min } : null, notice };
}

module.exports = { THRESHOLDS, CHECK_EVERY_MS, enabled, fileOf, segmentsOf, workedMs, overrunOf, overrunText, sessionText, check };
