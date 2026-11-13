'use strict';
/**
 * review-policy.js — cuándo corren la revisión del plan y la del código, y quién aprueba el plan. Funciones puras: no
 * leen la máquina ni el reloj; quien llama les pasa la delicadeza, el tamaño, si hay coordinadora, si el dueño está
 * ausente y la configuración de la organización ya leída.
 *
 * Las decisiones: `run` (revisar sin preguntar), `ask` (preguntarle al dueño), `skip` (seguir sin revisión) y `wait`
 * (esperar al dueño). La configuración llega cruda (`team-repos.json`) y `normalize` la completa con los valores de
 * fábrica, clave por clave: un valor malo cae al de fábrica sólo en esa clave, y el problema se devuelve.
 */

const ENUMS = Object.freeze({
  plan_review: {
    delicate: ['always', 'ask'],
    routine: ['always', 'ask', 'never'],
    routine_owner_away: ['review', 'wait', 'skip'],
    // quién aprueba un plan de rutina cuya revisión dio aprobado: la revisión (con coordinadora o sin ella) o una persona
    routine_approval: ['review', 'person'],
  },
  deep_review: {
    delicate: ['always', 'ask'],
    small_routine_day: ['ask', 'run', 'skip'],
    small_routine_owner_away: ['run', 'skip', 'wait'],
    large_routine: ['run', 'ask'],
  },
  review: {
    blocking_severity: ['bug', 'robustness', 'all'],
  },
  review_runner: {
    verifiers: ['per_lens', 'per_finding'],
  },
});

const RANGES = Object.freeze({
  plan_review: { owner_away_minutes: [5, 240] },
  deep_review: { small_max_files: [1, 50] },
  review: { max_rounds: [1, 6] },
});

const BOOLEANS = Object.freeze({
  plan_review: ['coordinator_approves', 'rejected_reaches_owner'],
});

const DEFAULTS = Object.freeze({
  plan_review: Object.freeze({
    delicate: 'always', routine: 'ask', routine_owner_away: 'review', routine_approval: 'review', coordinator_approves: true,
    rejected_reaches_owner: false, owner_away_minutes: 20, lenses: Object.freeze(['suposicion-falsa']),
  }),
  deep_review: Object.freeze({
    delicate: 'always', small_max_files: 6, small_routine_day: 'ask', small_routine_owner_away: 'run', large_routine: 'run',
  }),
  review: Object.freeze({ max_rounds: 3, blocking_severity: 'bug' }),
  review_runner: Object.freeze({ verifiers: 'per_lens' }),
});

// Las lentes del modo plan, en el orden en que corren (el guion del pase tiene la misma lista).
const PLAN_LENSES = Object.freeze(['ac-sin-cubrir', 'suposicion-falsa', 'riesgo-sin-defensa', 'prueba-que-falta']);

// La escala de gravedad del verificador, de la que más pesa a la que menos, va adentro del bloque copiado.
// ===== NUCLEO-BLOCKS: INICIO =====
// 🔴 Copia LITERAL de `blocks` de lib/review-policy.js (la caja no tiene `require`). La prueba T57 de
// tests/plan-review.test.js compara las dos: si una cambia, se cambia la otra.
const SEVERITIES = Object.freeze(['bug', 'robustness', 'nit']);

/**
 * ¿Un hallazgo confirmado de esta gravedad frena (rechaza el plan, es CRITICAL en el código) con este corte?
 * Una gravedad desconocida frena: ante la duda, no se aprueba. `not-a-bug` nunca frena.
 */
function blocks(severity, cut) {
  if (severity === 'not-a-bug') return false;
  const corte = cut === 'all' ? 'nit' : cut === 'robustness' ? 'robustness' : 'bug';
  const i = SEVERITIES.indexOf(severity);
  if (i < 0) return true;
  return i <= SEVERITIES.indexOf(corte);
}
// ===== NUCLEO-BLOCKS: FIN =====

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** La lista de lentes del modo plan: `{ value }` o `{ value: de fábrica, problem }`. */
function lensesOf(v) {
  const fabrica = DEFAULTS.plan_review.lenses.slice();
  if (!Array.isArray(v) || !v.length) return { value: fabrica, problem: 'tiene que ser una lista no vacía de lentes' };
  if (new Set(v).size !== v.length) return { value: fabrica, problem: 'tiene lentes repetidas' };
  const mala = v.find((x) => !PLAN_LENSES.includes(x));
  if (mala !== undefined) return { value: fabrica, problem: `«${mala}» no es una lente (vale ${PLAN_LENSES.join(' · ')})` };
  return { value: v.slice() };
}

/**
 * La configuración completa (`values`) y los problemas (`problems`, `{ path, message }`) de las secciones
 * `plan_review`, `deep_review` y `review` de `team-repos.json`. Las claves que no son de las matrices (por ejemplo
 * `deep_review.default` o `review.blocking_prefixes`) pasan tal cual.
 */
function normalize(raw) {
  const values = {};
  const problems = [];
  for (const sec of Object.keys(DEFAULTS)) {
    const crudo = isObject(raw) && isObject(raw[sec]) ? raw[sec] : {};
    const out = { ...crudo };
    for (const [k, fabrica] of Object.entries(DEFAULTS[sec])) {
      const v = crudo[k];
      if (v === undefined) { out[k] = Array.isArray(fabrica) ? fabrica.slice() : fabrica; continue; }
      if (sec === 'plan_review' && k === 'lenses') {
        const l = lensesOf(v);
        out[k] = l.value;
        if (l.problem) problems.push({ path: `${sec}.${k}`, message: l.problem });
        continue;
      }
      const lista = ENUMS[sec] && ENUMS[sec][k];
      const rango = RANGES[sec] && RANGES[sec][k];
      const booleano = BOOLEANS[sec] && BOOLEANS[sec].includes(k);
      let ok = true;
      let message = '';
      if (lista) { ok = lista.includes(v); message = `tiene que ser ${lista.join(' · ')} (es ${JSON.stringify(v)})`; }
      else if (rango) { ok = Number.isInteger(v) && v >= rango[0] && v <= rango[1]; message = `tiene que ser un entero de ${rango[0]} a ${rango[1]} (es ${JSON.stringify(v)})`; }
      else if (booleano) { ok = typeof v === 'boolean'; message = `tiene que ser true o false (es ${JSON.stringify(v)})`; }
      if (ok) out[k] = v;
      else { out[k] = fabrica; problems.push({ path: `${sec}.${k}`, message: `${message}: uso el de fábrica, ${JSON.stringify(fabrica)}` }); }
    }
    // `coordinator_approves` es el nombre viejo de `routine_approval`: en false, sin la nueva escrita, vale `person`. Sin
    // problema acá: el lector de team-repos.js saca de `data` toda clave con un problema, y el nombre viejo dejaría de
    // llegar (una organización que pidió el click aprobaría sola). El aviso lo da quien lee la configuración
    if (sec === 'plan_review' && crudo.routine_approval === undefined && out.coordinator_approves === false) out.routine_approval = 'person';
    values[sec] = out;
  }
  return { values, problems };
}

/**
 * ¿Escribió la organización el nombre viejo (`coordinator_approves`) sin el nuevo? Para avisarlo donde se lee la
 * configuración, no en `normalize`.
 */
const nombreViejo = (raw) => isObject(raw) && isObject(raw.plan_review) && raw.plan_review.coordinator_approves !== undefined && raw.plan_review.routine_approval === undefined;

// quién aprueba el plan: una delicada o `person`, el dueño; una rutina con `review`, la revisión, que firma la
// coordinadora si la hay o la propia sesión si no
const aprobador = (delicate, coordinator, c) => (delicate || c.routine_approval !== 'review' ? 'owner' : coordinator ? 'coordinator' : 'session');

/** Matriz 1: la revisión del plan. `config` es la salida de `normalize(...).values`. */
function planReview({ delicate, coordinator, ownerAway, config }) {
  const c = config.plan_review;
  const approves = aprobador(delicate, coordinator, c);
  const asker = coordinator ? 'coordinator' : 'session';
  const conPregunta = (porQue) => {
    if (!ownerAway) return { decision: 'ask', approves, asker, reason: `${porQue}: se le pregunta a la persona` };
    const v = c.routine_owner_away;
    const decision = v === 'review' ? 'run' : v;
    // sin revisión, o esperándolo, el plan lo firma el dueño
    return { decision, approves: decision === 'run' ? approves : 'owner', asker, reason: `${porQue}, con la persona ausente: ${v} (plan_review.routine_owner_away)` };
  };
  if (delicate) {
    if (c.delicate === 'always') return { decision: 'run', approves, asker, reason: 'historia delicada: se revisa siempre (plan_review.delicate: always)' };
    return conPregunta('historia delicada con plan_review.delicate: ask');
  }
  if (c.routine === 'always') return { decision: 'run', approves, asker, reason: 'rutina: se revisa siempre (plan_review.routine: always)' };
  if (c.routine === 'never') return { decision: 'skip', approves: 'owner', asker, reason: 'sin revisión: el perfil no revisa (plan_review.routine: never)' };
  return conPregunta('rutina');
}

/** Matriz 2: la revisión del código (el pase adversarial). */
function codeReview({ delicate, codeFiles, normalByOtherCriterion, dense, ownerAway, config }) {
  const c = config.deep_review;
  const grande = codeFiles > c.small_max_files || Boolean(normalByOtherCriterion) || Boolean(dense);
  const size = grande ? 'large' : 'small';
  const por = grande
    ? (codeFiles > c.small_max_files ? `${codeFiles} archivos de código, más de ${c.small_max_files}` : normalByOtherCriterion ? 'el riesgo lo marca por otro criterio que el tamaño' : 'el cambio es denso')
    : `${codeFiles} archivos de código, hasta ${c.small_max_files}`;
  if (delicate) {
    if (c.delicate === 'always') return { decision: 'run', size, reason: `delicada (${por}): corre siempre (deep_review.delicate: always)` };
    return { decision: ownerAway ? 'run' : 'ask', size, reason: `delicada (${por}) con deep_review.delicate: ask${ownerAway ? ', persona ausente: corre' : ''}` };
  }
  if (grande) {
    if (c.large_routine === 'run') return { decision: 'run', size, reason: `grande (${por}): corre (deep_review.large_routine: run)` };
    return { decision: ownerAway ? 'run' : 'ask', size, reason: `grande (${por}) con deep_review.large_routine: ask${ownerAway ? ', persona ausente: corre' : ''}` };
  }
  if (ownerAway) return { decision: c.small_routine_owner_away, size, reason: `chica (${por}), persona ausente: ${c.small_routine_owner_away} (deep_review.small_routine_owner_away)` };
  return { decision: c.small_routine_day, size, reason: `chica (${por}): ${c.small_routine_day} (deep_review.small_routine_day)` };
}

/**
 * ¿El dueño está ausente? Con la marca puesta, sí. Sin ella, cuando la pregunta (`askedAt`, ms) lleva `minutes`
 * minutos sin respuesta a la hora `now` (ms). Sin pregunta no hay minutos que contar.
 */
function ownerAway({ mark, askedAt, now, minutes }) {
  if (mark) return { away: true, reason: `marca de ausente puesta${mark.setAt ? ` desde ${mark.setAt}` : ''}` };
  if (!Number.isFinite(askedAt) || !Number.isFinite(now)) return { away: false, reason: 'sin pregunta abierta' };
  const pasaron = Math.floor((now - askedAt) / 60000);
  return pasaron >= minutes
    ? { away: true, reason: `la pregunta lleva ${pasaron} minutos sin respuesta (tope ${minutes})` }
    : { away: false, reason: `la pregunta lleva ${pasaron} de ${minutes} minutos` };
}

module.exports = { DEFAULTS, ENUMS, RANGES, PLAN_LENSES, SEVERITIES, blocks, normalize, nombreViejo, planReview, codeReview, ownerAway };
