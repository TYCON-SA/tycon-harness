'use strict';
// lib/steps.js — la tabla única de los pasos del pipeline.
//
// Once pasos numerados seguido y el cierre en ADO aparte. Cada paso: su número (sale del orden), su nombre de máquina (el
// del marcador y el de los comandos: `complete-step reviewers`), el nombre llano con que se le muestra al dueño y su
// archivo en `steps/`. El nombre de máquina no cambia cuando se agrega o se saca un paso; el número sí.
//
// Conviven dos marcadores mientras haya ejecuciones en vuelo: el nuevo (`stepScheme: 2`, pasos por nombre) y el viejo (sin
// `stepScheme`, pasos por número: 0..9 con los sub-pasos 0b, 0c, 5b, 7b, 7c). El viejo se lee con la equivalencia de
// `old` y no se reescribe a mitad de ejecución. Un número suelto nunca se traduce en un marcador nuevo: con la
// numeración nueva, el mismo número es otro paso.
//
// Todo lo que necesita saber de un paso (si está hecho, su nombre, su archivo, su orden) lo pide acá. La copia del
// cartel (`mods/harness-mods/hooks/steps.mjs`) lleva la misma tabla, y scripts/tests/harness-mods.test.js frena si se
// separan.

const fs = require('fs');
const path = require('path');

const SCHEME = 2;

// `old`: los pasos del marcador viejo que equivalen a éste. `flag`: la bandera del marcador que lo da por hecho (los que
// no se cierran con `complete-step`). `waitsForPerson`: el paso que puede esperar a una persona.
const STEPS = [
  { number: 1, id: 'start', name: 'Arranque', file: 'step-01-start.md', old: ['0', '0b', '0c'] },
  { number: 2, id: 'validate-story', name: 'Validar la historia', file: 'step-02-validate-story.md', old: ['1'] },
  { number: 3, id: 'plan', name: 'Armar el plan', file: 'step-03-plan.md', old: ['2'] },
  { number: 4, id: 'approve-plan', name: 'Aprobar el plan', file: 'step-04-approve-plan.md', old: ['3'], waitsForPerson: true },
  { number: 5, id: 'implement', name: 'Implementar', file: 'step-05-implement.md', old: ['4'] },
  { number: 6, id: 'run-tests', name: 'Correr las pruebas', file: 'step-06-run-tests.md', old: ['4'] },
  { number: 7, id: 'reviewers', name: 'Revisores', file: 'step-07-reviewers.md', old: ['5', '7b'] },
  { number: 8, id: 'adversarial-pass', name: 'Pase adversarial', file: 'step-08-adversarial-pass.md', old: ['5b'], flag: 'deepReviewDone' },
  { number: 9, id: 'findings', name: 'Hallazgos', file: 'step-09-findings.md', old: ['6', '7'], waitsForPerson: true },
  { number: 10, id: 'live-check', name: 'Probar en vivo', file: 'step-10-live-check.md', old: ['7c'], flag: 'dodRuntimeChecked' },
  { number: 11, id: 'prepare-commit', name: 'Preparar el commit', file: 'step-11-prepare-commit.md', old: ['8'] },
];
// Corre aparte, después del merge (`/tycon-pipeline close`): no está en la numeración.
const CLOSE_STEP = { id: 'close-work-item', name: 'Cerrar la historia', file: 'close-work-item.md', old: ['9'] };
const TOTAL = STEPS.length;

// Los pasos del marcador viejo, por su número de entonces. Sólo para leer ejecuciones en vuelo y volcados guardados.
const OLD_IDS = ['0', '0b', '0c', '1', '2', '3', '4', '5', '5b', '6', '7', '7b', '7c', '8', '9'];
// Sus sub-pasos se daban por hechos con una bandera, como hoy el pase adversarial y la prueba en vivo.
const OLD_FLAG = { '0b': ['workSignalStarted', 'clockiStarted'], '0c': ['adoMarkedActive'], '5b': ['deepReviewDone'], '7c': ['dodRuntimeChecked'] };

// El orden que frena `complete-step`: no se cierra un paso con su predecesor pendiente. Sólo los pasos con un control
// real; exigir «todo lo anterior» volvería rutina el `--out-of-order`.
const ORDER_REQUIRES = {
  'approve-plan': ['validate-story', 'plan'],
  implement: ['approve-plan'],
  'run-tests': ['implement'],
  reviewers: ['run-tests'],
  'prepare-commit': ['reviewers'],
};

// Los frenos que corren al cerrar cada paso (`complete-step`). `shownIn`: el paso donde «Cómo trabaja» lo muestra;
// `checkedIn`: el paso cuyo cierre lo revisa; `key`: el control de marker.js; `oldKeys`: los números del marcador viejo
// que también lo revisan, escritos a mano (el 4 viejo cerraba implementar y correr las pruebas juntos). `gate`: el freno
// propio que vive dentro del control de su clave.
const STEP_CLOSE_CHECKS = [
  { shownIn: 'approve-plan', checkedIn: 'approve-plan', key: 'plan', oldKeys: ['3'], textKey: 'cierre.approve-plan.plan' },
  { shownIn: 'implement', checkedIn: 'implement', key: 'atdd', oldKeys: ['4'], textKey: 'cierre.implement.atdd' },
  { shownIn: 'run-tests', checkedIn: 'run-tests', key: 'tests', oldKeys: ['4'], textKey: 'cierre.run-tests.tests' },
  { shownIn: 'reviewers', checkedIn: 'reviewers', key: 'advisors', oldKeys: ['5'], textKey: 'cierre.reviewers.advisors' },
  { shownIn: 'findings', checkedIn: 'findings', key: 'waivers', oldKeys: ['7'], textKey: 'cierre.findings.waivers' },
  { shownIn: 'findings', checkedIn: 'findings', key: 'findings-close', oldKeys: ['7'], textKey: 'cierre.findings.findings-close' },
  { shownIn: 'prepare-commit', checkedIn: 'prepare-commit', key: 'waivers', oldKeys: ['8'], textKey: 'cierre.prepare-commit.waivers' },
  { shownIn: 'prepare-commit', checkedIn: 'prepare-commit', key: 'commit', oldKeys: ['8'], textKey: 'cierre.prepare-commit.commit' },
  // al final: el orden de la tabla es el de los controles de cada paso, y el del pase no agrega ninguno
  { shownIn: 'adversarial-pass', checkedIn: 'prepare-commit', key: 'commit', oldKeys: [], gate: 'adversarial-result', textKey: 'cierre.adversarial-pass.commit' },
];

/** Los controles que revisa el cierre de cada paso, por su nombre y por su número viejo, sin repetir, en orden. */
function closeControlsByStep() {
  const out = {};
  const sumar = (paso, clave) => { const l = (out[paso] = out[paso] || []); if (!l.includes(clave)) l.push(clave); };
  for (const r of STEP_CLOSE_CHECKS) for (const paso of [r.checkedIn, ...r.oldKeys]) sumar(paso, r.key);
  return out;
}

// Las partes opcionales del Arranque. Una parte que no corre (la organización no usa esa herramienta, la story no trae
// pedido) no aparece en ningún lado; una que corre y falla deja su aviso con `marker.js start-warning`.
const START_PARTS = {
  'time-tracking': { name: 'el aviso de trabajo', flags: ['workSignalStarted', 'clockiStarted'], failed: 'no se pudo abrir el registro de horas',
    // la integración tiene una entrada abierta en la sesión, pero nada de la conversación la confirma
    unconfirmed: 'registro de horas abierto, sin confirmar por el arnés' },
  ado: { name: 'el pedido en ADO', flags: ['adoMarkedActive'], failed: 'no se pudo marcar el pedido en ADO' },
};

// Hasta cuándo un marcador viejo acepta sus números. `null` mientras el esquema 2 no llegó a todas las máquinas; la fija una
// persona con un commit propio cuando `--retire-check` diga la fecha (llegó a todas + 30 días).
const OLD_NUMBERS_UNTIL = null;
// La versión del arnés que trae el esquema 2: la pone el merge. Hasta entonces `--retire-check` la pide con `--since`.
const SCHEME_TWO_SINCE = null;

const byId = (id) => STEPS.find((s) => s.id === String(id)) || (String(id) === CLOSE_STEP.id ? CLOSE_STEP : null);
const byNumber = (n) => STEPS.find((s) => s.number === Number(n)) || null;
/** El paso nuevo que equivale a un id del marcador viejo (el 4 viejo da `implement`; ver `newFromOld` para los dos). */
const fromOld = (oldId) => STEPS.find((s) => s.old.includes(String(oldId))) || (CLOSE_STEP.old.includes(String(oldId)) ? CLOSE_STEP : null);
/** Los pasos nuevos que equivalen a un id viejo: el 4 viejo era implementar y correr las pruebas. */
const newFromOld = (oldId) => [...STEPS, CLOSE_STEP].filter((s) => s.old.includes(String(oldId)));

/** 2 si el marcador es nuevo, 1 si es viejo, `null` si no es ninguno de los dos (ilegible o de un esquema desconocido). */
function schemeOf(marker) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const listas = [marker.stepsCompleted, marker.stepsPending].filter((l) => l !== undefined);
  if (listas.some((l) => !Array.isArray(l))) return null;
  const items = listas.flat().map(String);
  if (marker.stepScheme === SCHEME) return items.every((x) => byId(x)) ? 2 : null;
  if (marker.stepScheme !== undefined) return null;
  return items.every((x) => OLD_IDS.includes(x)) ? 1 : null;
}

/**
 * El nombre llano de un paso: por su nombre de máquina, o por un id del marcador viejo (con el nombre nuevo de la
 * equivalencia). `round` (desde 2) suma «, vuelta N» a los revisores. `null` si no existe.
 */
function stepName(id, round) {
  const s = byId(id) || fromOld(id);
  if (!s) return null;
  if (String(id) === '4') return 'Implementar + pruebas';   // el 4 viejo no se reparte
  return s.id === 'reviewers' && Number(round) >= 2 ? `${s.name}, vuelta ${Number(round)}` : s.name;
}

/** Una lista de pasos (los pendientes de un marcador, de cualquiera de los dos esquemas) como nombres, sin repetir. */
function stepNames(ids) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const n = stepName(id) || `«${id}»`;
    if (!out.includes(n)) out.push(n);
  }
  return out.join(', ');
}

const viejoHecho = (marker, oldId) => {
  if (OLD_FLAG[oldId] && OLD_FLAG[oldId].some((f) => marker[f] === true)) return true;
  return (marker.stepsCompleted || []).map(String).includes(oldId);
};

/** ¿Está hecho el paso `id` (nombre de máquina), en un marcador de cualquiera de los dos esquemas? */
function isDone(marker, id) {
  const s = byId(id);
  if (!marker || !s) return false;
  if (s.flag && marker[s.flag] === true) return true;
  if (schemeOf(marker) === 2) return (marker.stepsCompleted || []).map(String).includes(s.id);
  // el viejo, con la equivalencia: el Arranque con el 0; Hallazgos con el 6 y el 7; los revisores con el 5
  const old = s.id === 'start' ? ['0'] : s.id === 'reviewers' ? ['5'] : s.old;
  return old.every((o) => viejoHecho(marker, o));
}

/** ¿Está pendiente el paso `id`? Sin marcador, o con uno ilegible, nada está pendiente. */
function isPending(marker, id) {
  if (!marker || !byId(id)) return false;
  const sc = schemeOf(marker);
  // los que se cierran con su bandera no van en la lista de pendientes (ninguna bandera la vaciaría): están pendientes
  // mientras la ejecución tenga pasos abiertos y su bandera no esté puesta
  if (sc !== null && byId(id).flag) return !isDone(marker, id) && Array.isArray(marker.stepsPending) && marker.stepsPending.length > 0;
  if (sc === 2) return (marker.stepsPending || []).map(String).includes(id) && !isDone(marker, id);
  if (sc === 1) {
    const s = byId(id);
    const old = s.id === 'reviewers' ? ['5'] : s.old;
    const pend = (marker.stepsPending || []).map(String);
    return old.some((o) => pend.includes(o)) && !isDone(marker, id);
  }
  return false;
}

/** Los pasos pendientes de un marcador, como nombres de máquina, en el orden de la tabla. */
function pendingSteps(marker) {
  return [...STEPS, CLOSE_STEP].filter((s) => isPending(marker, s.id)).map((s) => s.id);
}

const hoyIso = () => new Date().toISOString().slice(0, 10);
const nombresValidos = () => [...STEPS.map((s) => s.id), CLOSE_STEP.id].join(', ');

// El número viejo de cada paso nuevo, para cerrar con un nombre un marcador viejo. Hallazgos cierra el 6 y el 7; el pase
// adversarial y la prueba en vivo no se cierran con `complete-step` (tienen su bandera).
const OLD_CLOSE = { start: ['0'], 'validate-story': ['1'], plan: ['2'], 'approve-plan': ['3'], implement: ['4'], 'run-tests': ['4'],
  reviewers: ['5'], findings: ['6', '7'], 'prepare-commit': ['8'], 'close-work-item': ['9'] };

function mensajeNumero(raw) {
  const v = String(raw);
  const viejo = newFromOld(v).map((s) => s.id);
  const actual = /^\d+$/.test(v) && byNumber(v) ? [byNumber(v).id] : [];
  const candidatos = [...new Set([...actual, ...viejo])];
  return `complete-step ${v} es ambiguo desde la story 7.23: los pasos se nombran por su nombre de máquina, no por su número`
    + (candidatos.length ? ` (¿${candidatos.map((c) => `\`${c}\``).join(' o ')}?)` : '')
    + `. Los pasos: ${nombresValidos()}.`;
}

/**
 * Lo que cierra `complete-step <raw>` (o arranca `start-step <raw>`) en este marcador.
 * → `{ ok: true, scheme, ids }` con los ids a cerrar en el esquema del marcador (nombres en el 2, números viejos en el 1),
 *   o `{ ok: false, message }`. Con el marcador nuevo, un número se niega siempre. Con el viejo, el número se acepta hasta
 *   `until` (por defecto `OLD_NUMBERS_UNTIL`; `null` = sin fecha todavía) y el nombre nuevo se traduce a su número viejo.
 */
function resolveStepArg(marker, raw, opts = {}) {
  const v = String(raw === undefined || raw === null ? '' : raw).trim();
  const until = opts.until === undefined ? OLD_NUMBERS_UNTIL : opts.until;
  const today = opts.today || hoyIso();
  const sc = schemeOf(marker);
  if (sc === null) return { ok: false, message: 'el marcador de esta ejecución no es de ningún esquema conocido (ilegible, o con pasos que la tabla no conoce): no sé qué paso cerrar.' };
  const s = byId(v);
  // los pasos que se cierran con su bandera no se cierran con complete-step, en ningún marcador: la bandera la dejan
  // sus propios comandos, con su constancia
  if (s && s.flag) return { ok: false, message: `«${s.name}» no se cierra con complete-step: lo da por hecho su bandera (${s.flag}), que dejan sus propios comandos.` };
  if (sc === 2) {
    if (s) return { ok: true, scheme: 2, ids: [s.id] };
    if (OLD_IDS.includes(v) || /^\d+$/.test(v)) return { ok: false, message: mensajeNumero(v) };
    return { ok: false, message: `«${v}» no es un paso. Los pasos: ${nombresValidos()}.` };
  }
  // marcador viejo
  if (s) return { ok: true, scheme: 1, ids: OLD_CLOSE[s.id] };
  // sus sub-pasos tampoco: se daban por hechos con su bandera, y la otra vuelta de los revisores no es un paso aparte
  if (OLD_FLAG[v]) return { ok: false, message: `«${v}» no se cierra con complete-step: lo da por hecho su bandera (${OLD_FLAG[v][0]}), que dejan sus propios comandos.` };
  if (v === '7b') return { ok: false, message: '«7b» no es un paso: es otra vuelta de los revisores, que se cierra con complete-step reviewers.' };
  if (OLD_IDS.includes(v)) {
    if (until && today > until) return { ok: false, message: mensajeNumero(v) };
    return { ok: true, scheme: 1, ids: [v] };
  }
  return { ok: false, message: `«${v}» no es un paso. Los pasos: ${nombresValidos()}.` };
}

/** Las partes del Arranque que corren y todavía no se hicieron, ni fallaron. `applies`: `{ 'time-tracking': bool, ado: bool }`. */
function startPartsPending(marker, applies) {
  const avisadas = new Set((Array.isArray(marker && marker.startWarnings) ? marker.startWarnings : []).map((w) => w && w.part));
  return Object.entries(START_PARTS)
    .filter(([part, p]) => applies && applies[part] && !avisadas.has(part) && !p.flags.some((f) => marker && marker[f] === true))
    .map(([part, p]) => ({ part, name: p.name }));
}

/** La parte del Arranque a la que pertenece una bandera, o `null`. */
const partOfFlag = (flag) => (Object.entries(START_PARTS).find(([, p]) => p.flags.includes(flag)) || [null])[0];

/**
 * La bandera de un hecho externo la pone el arnés cuando hizo el trabajo. Si la parte tenía un aviso (falló antes y el
 * reintento salió bien), el aviso sale: la parte quedó hecha. Muta el marcador; quien llama lo escribe.
 */
function setExternalFlag(marker, flag) {
  marker[flag] = true;
  const part = partOfFlag(flag);
  if (part && Array.isArray(marker.startWarnings)) marker.startWarnings = marker.startWarnings.filter((w) => !w || w.part !== part);
  return marker;
}

/** «Arranque: hecho, con aviso: …» por cada parte que falló. */
function startWarningLines(marker) {
  const ws = Array.isArray(marker && marker.startWarnings) ? marker.startWarnings : [];
  const out = ws.filter((w) => w && START_PARTS[w.part])
    .map((w) => `Arranque: hecho, con aviso: ${(w.unconfirmed && START_PARTS[w.part].unconfirmed) || START_PARTS[w.part].failed}`);
  // la acción de horas marcada sin conversación que leer (Codex): se dice hasta el cierre, como un aviso más
  if (marker && marker.workSignalVerified === false) out.push('Arranque: hecho, con aviso: el aviso de trabajo quedó sin verificar (sin conversación que leer)');
  return out;
}

/**
 * ¿Hay que volver a los revisores? Con Hallazgos cerrado, una edición de código posterior al último cierre de los
 * revisores es un arreglo: toca otra vuelta. → `{ round }` o `null`. Qué edición cuenta lo decide lib/reloop-code.js.
 */
function reviewersRound(marker) {
  if (!marker || schemeOf(marker) !== 2 || !isDone(marker, 'findings')) return null;
  const t = (marker.stepTimings || {}).reviewers || {};
  // el ÚLTIMO cierre de los revisores: `completedAt` guarda el de la primera vuelta (la que miden los tiempos)
  const cierre = Date.parse(t.lastCompletedAt || t.completedAt || '');
  if (!Number.isFinite(cierre)) return null;
  const { pideOtraVuelta } = require('./reloop-code.js');
  const arreglo = (Array.isArray(marker.fileEvents) ? marker.fileEvents : [])
    // la marca `code` en falso (la pone on-edit) gana: el cartel decide con ella y tiene que decidir igual; en verdadero
    // no alcanza, porque un marcador de antes la ponía también en lo que el arnés escribe en .advisors
    .some((e) => e && Date.parse(e.ts || '') > cierre && e.code !== false && pideOtraVuelta(e.path, { storyPath: marker.storyPath }));
  if (!arreglo) return null;
  return { round: (Number(t.rounds) || 1) + 1 };
}

/** ¿Está abierto Hallazgos? (los revisores cerrados y Hallazgos sin cerrar, en un marcador nuevo) */
function findingsOpen(marker) {
  // el pase adversarial va antes: mientras no cerró, una pregunta a la persona es suya, no de Hallazgos
  return schemeOf(marker) === 2 && isDone(marker, 'reviewers') && isDone(marker, 'adversarial-pass') && !isDone(marker, 'findings');
}

/**
 * Anota en el marcador el arranque de la espera de Hallazgos, si está abierto y no lo tenía. Una pregunta después de una
 * respuesta vuelve a esperar: borra el fin y deja el arranque, que es el que miden los tiempos. Devuelve si cambió.
 */
function noteFindingsWait(marker, ts) {
  if (!findingsOpen(marker)) return false;
  marker.stepTimings = marker.stepTimings && typeof marker.stepTimings === 'object' ? marker.stepTimings : {};
  const f = marker.stepTimings.findings && typeof marker.stepTimings.findings === 'object' ? marker.stepTimings.findings : {};
  if (f.waitStartedAt && !f.waitEndedAt) return false;
  const { waitEndedAt, ...rest } = f;
  marker.stepTimings.findings = { ...rest, waitStartedAt: f.waitStartedAt || ts || new Date().toISOString() };
  return true;
}

/** Anota el fin de la espera de Hallazgos cuando la persona contesta, si había una abierta. Devuelve si cambió. */
function noteFindingsAnswer(marker, ts) {
  if (!findingsOpen(marker)) return false;
  const f = (marker.stepTimings || {}).findings;
  if (!f || typeof f !== 'object' || !f.waitStartedAt || f.waitEndedAt) return false;
  marker.stepTimings.findings = { ...f, waitEndedAt: ts || new Date().toISOString() };
  return true;
}

// ── --retire-check: ¿llegó el esquema 2 a todas las máquinas? ───────────────────────────────────────────────────────
// Lee los hechos de lugar que cada máquina sube al buzón (`<espejo>/<máquina>/registros/place.json`: `install.version` y
// `day`) y bajó download-runs.js. Cuenta las máquinas que subieron en los 14 días anteriores. La primera vez que todas
// tienen la versión, anota ese día en un archivo de estado: la fecha en que llegó no se corre con las consultas siguientes.
const DIAS_ACTIVA = 14;
const compararVersiones = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
};
const sumarDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function retireCheck({ mirror, since, today, stateFile }) {
  const res = { since, today, machines: [], all_arrived: false, all_arrived_on: null, retire_on: null, note: null };
  if (!since) { res.note = 'falta la versión del arnés que trae el esquema 2 (--since): se conoce al mergear la tanda B'; return res; }
  // una versión mal escrita compararía como igual a todas: no se mide
  if (!/^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$/.test(String(since))) { res.note = `no medido: --since «${since}» no es una versión del arnés (AAAA.MM.DD.N)`; return res; }
  let carpetas = [];
  try { carpetas = fs.readdirSync(mirror, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) {
    res.note = `no medido: no hay espejo del buzón en ${mirror} (${e.code || e.message}); bajalo con download-runs.js`;
    return res;
  }
  const desde = sumarDias(today, -DIAS_ACTIVA);
  for (const maq of carpetas.sort()) {
    let place = null;
    let unreadable = null;
    try { place = JSON.parse(fs.readFileSync(path.join(mirror, maq, 'registros', 'place.json'), 'utf8')); } catch (e) {
      // sin place.json la máquina no tiene hechos; uno que está y no se lee no es «sin hechos»
      if (e.code !== 'ENOENT') unreadable = e instanceof SyntaxError ? 'place.json no es JSON válido' : `place.json no se pudo leer (${e.code || 'error'})`;
    }
    const v = place && place.install && place.install.version;
    const version = typeof v === 'string' && /^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$/.test(v) ? v : null;
    const day = place && typeof place.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(place.day) ? place.day : null;
    const active = !!day && day >= desde && day <= today;
    res.machines.push({ machine: maq, version, day, active, arrived: version ? compararVersiones(version, since) >= 0 : false, ...(unreadable ? { unreadable } : {}) });
  }
  const ilegibles = res.machines.filter((m) => m.unreadable);
  if (ilegibles.length) {
    // con una máquina que no se pudo leer no se sabe si llegó: nunca «llegó a todas»
    res.note = `no medido: ${ilegibles.map((m) => `${m.machine} (${m.unreadable})`).join(', ')}`;
    return res;
  }
  const activas = res.machines.filter((m) => m.active);
  if (!activas.length) { res.note = 'no medido: ninguna máquina subió hechos en los últimos 14 días'; return res; }
  res.all_arrived = activas.every((m) => m.arrived);
  let estado = {};
  try { estado = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch (_) { estado = {}; }
  if (estado.since === since && estado.all_arrived_on) res.all_arrived_on = estado.all_arrived_on;
  else if (res.all_arrived) {
    res.all_arrived_on = today;
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify({ since, all_arrived_on: today })); } catch (e) {
      res.note = `llegó a todas, pero no pude anotar la fecha (${e.code || e.message}): la próxima consulta la vuelve a poner`;
    }
  }
  if (res.all_arrived_on) res.retire_on = sumarDias(res.all_arrived_on, 30);
  if (!res.note) {
    res.note = res.all_arrived_on
      ? `la tanda B llegó a todas las máquinas el ${res.all_arrived_on}: OLD_NUMBERS_UNTIL = '${res.retire_on}' (con un commit propio)`
      : `faltan ${activas.filter((m) => !m.arrived).length} máquina(s) activa(s) con la versión ${since} o posterior`;
  }
  return res;
}

module.exports = {
  SCHEME, STEPS, CLOSE_STEP, TOTAL, OLD_IDS, ORDER_REQUIRES, START_PARTS, OLD_NUMBERS_UNTIL, SCHEME_TWO_SINCE,
  STEP_CLOSE_CHECKS, closeControlsByStep, byId, byNumber, fromOld, newFromOld, schemeOf, stepName, stepNames, isDone, isPending, pendingSteps,
  resolveStepArg, startPartsPending, startWarningLines, partOfFlag, setExternalFlag, reviewersRound, findingsOpen, noteFindingsWait, noteFindingsAnswer, retireCheck,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (!argv.includes('--retire-check')) {
    process.stderr.write('uso: node lib/steps.js --retire-check [--since <versión>] [--mirror <espejo del buzón>] [--today AAAA-MM-DD] [--json]\n');
    process.exit(2);
  }
  const stateDir = require('./state-dir.js').stateDir(require('os').homedir());
  const r = retireCheck({
    mirror: val('--mirror') || path.join(stateDir, 'corridas-buzon'),
    since: val('--since') || SCHEME_TWO_SINCE,
    today: val('--today') || hoyIso(),
    stateFile: val('--state') || path.join(stateDir, 'steps-retire.json'),
  });
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    for (const m of r.machines) process.stdout.write(`${m.machine}: ${m.version || 'sin versión'} · ${m.active ? 'activa' : 'sin subir en 14 días'} · ${m.arrived ? 'llegó' : 'no llegó'}\n`);
    process.stdout.write(`${r.note}\n`);
  }
}
