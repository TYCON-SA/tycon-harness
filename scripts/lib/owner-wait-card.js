#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * owner-wait-card.js — la ficha de lo que espera al dueño: su riesgo, su pedido y la acción propuesta, y el reparto de las
 * esperas en tres grupos (al dueño, a main, a otra sesión). La usa la oficina.
 *
 * La ficha propone y nunca ejecuta: no escribe nada ni corre la acción. Lo que no se sabe con certeza dice
 * «sin dato (<motivo>)». El riesgo es la cuenta con que el arnés decide quién aprueba el plan (`computeDelicate`, con la
 * historia, el plan escrito y la tanda), y corre en un proceso aparte para poder cortarla a tiempo.
 *
 * CLI interna: node owner-wait-card.js --risk  (el marcador por la entrada estándar; imprime el resultado en JSON)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const { recortar, carpetaDe } = require(path.join(LIB, 'run-lines.js'));

const PLAN_FILE = 'step-02-bmad-plan.md';
const RISK_CALL_MS = 4000;
const RISK_ROUND_MS = 10000;
const KNOWN_MS = 60000;
const sinDato = (motivo) => `sin dato (${recortar(motivo)})`;
const storyOf = (m) => (path.isAbsolute(m.storyPath) || !m.repoPath ? m.storyPath : path.join(m.repoPath, m.storyPath));
const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch (_) { return null; } };

/** El tiempo de un recorrido de fichas: 10 s desde ahora, sin pasar de `until` si quien llama tiene su propio límite. */
function newBudget({ until = Infinity, now = Date.now() } = {}) {
  return { until: Math.min(now + RISK_ROUND_MS, until) };
}

/** El marcador de una sesión, null si no tiene corrida, o `{ unreadable: true }` si la tiene y no se puede leer. */
function markerOf(stateDir, sid) {
  if (sid == null) return null;
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'active', `${String(sid).replace(/[/\\]/g, '_')}.json`), 'utf8')); } catch (e) { return e.code === 'ENOENT' ? null : { unreadable: true }; }
}

/** La cuenta del riesgo, sobre la historia, el plan y la tanda de la corrida. Corre en el proceso de `--risk`. */
function computeRisk(marker) {
  const scripts = path.dirname(LIB);
  const review = require(path.join(LIB, 'plan-review.js'));
  const story = storyOf(marker);
  const plan = review.planDe(marker);
  if (plan.error) return { unknown: 'no pude leer el plan' };
  let storyText = '';
  try { storyText = fs.readFileSync(story, 'utf8'); } catch (_) { storyText = ''; }
  const part = review.parteDe(marker, storyText);
  const risk = require(path.join(scripts, 'pipeline.js')).computeDelicate({
    story, repo: marker.repoPath, planText: plan.texto || '', batch: part && part.valida ? part.nombre : undefined,
  });
  // el plan sólo puede sumar: sin él, o vacío, «delicada» vale y «de rutina» todavía no se sabe
  return risk.value === false && !String(plan.texto || '').trim() ? { unknown: 'plan no escrito' } : risk;
}

// lo ya calculado en este proceso, por un minuto: la oficina viva arma fichas seguido, y la cuenta también lee archivos del repo
const known = new Map();

/** «delicada», «de rutina» o «sin dato (<motivo>)». */
function riskOfRun(marker, budget, now = Date.now()) {
  if (marker && marker.unreadable) return sinDato('no pude leer la ejecución');
  if (!marker || !marker.storyPath) return sinDato('sin ejecución');
  const dir = carpetaDe(marker);
  const key = [storyOf(marker), marker.repoPath || '', mtimeOf(storyOf(marker)), dir ? mtimeOf(path.join(dir, PLAN_FILE)) : null, marker.batch || ''].join('|');
  const seen = known.get(key);
  if (seen && now - seen.at < KNOWN_MS) return seen.riesgo;
  const left = budget ? budget.until - Date.now() : RISK_CALL_MS;
  if (left <= 0) return sinDato('no alcanzó el tiempo');
  const r = spawnSync(process.execPath, [__filename, '--risk'], { input: JSON.stringify(marker), encoding: 'utf8', timeout: Math.min(left, RISK_CALL_MS), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.error && r.error.code === 'ETIMEDOUT') return sinDato('no alcanzó el tiempo');
  if (r.error || r.status !== 0) return sinDato('la cuenta del riesgo falló');
  let d;
  try { d = JSON.parse(r.stdout); } catch (_) { return sinDato('la cuenta del riesgo no se pudo leer'); }
  if (d.unknown) return sinDato(d.unknown);
  if (d.rule === 'no-pude-saber') return sinDato('la cuenta no pudo saberlo');
  if (typeof d.value !== 'boolean') return sinDato('la cuenta del riesgo no se pudo leer');
  const riesgo = d.value ? 'delicada' : 'de rutina';
  known.set(key, { riesgo, at: now });
  return riesgo;
}

/** La acción propuesta, según de dónde sale la espera. Una frase: la ficha no trae comandos. */
function actionFor(row) {
  const who = recortar(String((row && row.quien) || '')) || 'sin nombre';
  switch (row && row.origen) {
    case 'lista': return 'contestar la firma que trae la coordinadora';
    case 'plan': return `aprobar el plan de la sesión ${who}`;
    case 'guardar': return `dar el ok de guardar en la sesión ${who}`;
    case 'cuadro': return `contestar el cuadro en la sesión ${who}`;
    case 'pregunta': return `contestar la pregunta en la sesión ${who}`;
    case 'medio': return `decidir si se retoma la sesión ${who}: está cerrada`;
    case 'tablero': return 'preguntarle a la coordinadora: la anotó ella';
    default: return sinDato('no se sabe de dónde sale la espera');
  }
}

/** La ficha de una espera: `{ riesgo, pedido?, accion, linea }`. Sale siempre. */
function card({ row, marker, riskOf = riskOfRun, budget }) {
  let riesgo;
  try { riesgo = marker ? riskOf(marker, budget) : sinDato('sin ejecución'); } catch (_) { riesgo = sinDato('la cuenta del riesgo falló'); }
  const number = marker && marker.pr && marker.pr.number;
  const accion = actionFor(row);
  return { riesgo, ...(Number.isInteger(number) ? { pedido: `#${number}` } : {}), accion, linea: `${riesgo} · ${accion}` };
}

/** La ficha de una espera cuando armarla falló: la acción se sabe igual. */
function failedCard(row) {
  const riesgo = sinDato('la ficha falló');
  const accion = actionFor(row);
  return { riesgo, accion, linea: `${riesgo} · ${accion}` };
}

/**
 * Reparte las esperas: `{ dueno, main, sesion }`. Cada fila trae `clave` (el trabajo), `quien` y lo que sabe: `dueno`,
 * `choca` (su pedido choca con main), `waitingFor` y `waitingKind`. Un trabajo sale una sola vez, y si espera al dueño va
 * con el dueño. `waitingKind` sin `waitingFor` no es una espera.
 */
function waitGroups(rows) {
  const groups = { dueno: [], main: [], sesion: [] };
  const groupOf = (f) => (f.dueno ? 'dueno' : f.choca || (f.waitingFor && f.waitingKind === 'main') ? 'main' : f.waitingFor ? 'sesion' : null);
  const rank = { dueno: 0, main: 1, sesion: 2 };
  const seen = new Set();
  const ordered = rows.map((f) => ({ f, g: groupOf(f) })).filter((x) => x.g).sort((a, b) => rank[a.g] - rank[b.g]);
  for (const { f, g } of ordered) {
    if (seen.has(f.clave)) continue;
    seen.add(f.clave);
    groups[g].push(f);
  }
  return groups;
}

/** «espera <lo que espera>», sin repetir la palabra cuando ya la trae (`espera a main (main-1)`). */
function waitPhrase(waitingFor) {
  const s = String(waitingFor);
  return /^espera\b/i.test(s) ? s : `espera ${s}`;
}

/** El renglón de una espera. El trabajo de otro proyecto no se nombra. */
function waitText(f) {
  const who = f.quien || 'sin nombre';
  if (f.dueno) return `${who}: ${f.linea || 'espera al dueño'}`;
  if (f.choca) return `${who}: choca con main`;
  return f.otro ? `${who}: espera algo de otro proyecto` : `${who}: ${waitPhrase(f.waitingFor)}`;
}

if (require.main === module) {
  if (process.argv[2] !== '--risk') { process.stderr.write('owner-wait-card.js: uso: --risk, con el marcador por la entrada estándar\n'); process.exit(2); }
  process.stdout.write(`${JSON.stringify(computeRisk(JSON.parse(fs.readFileSync(0, 'utf8'))))}\n`);
}

module.exports = { card, failedCard, actionFor, riskOfRun, newBudget, markerOf, waitGroups, waitText, waitPhrase };
