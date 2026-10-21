/**
 * dashboard-metrics.js — EL FORMATO de las métricas del dashboard, y su validador.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 *
 * `.dashboard/` guarda un archivo de métricas por merge, escrito por `tycon-retrospective-capturer`. Es el insumo
 * de una métrica de resultado con denominador y serie, pero sólo si todos los archivos tienen la misma forma.
 *
 * Sin un formato, los archivos no se pueden sumar: `schema_version` ausente, el campo principal `value` como int,
 * float, string o null según la corrida, y sub-campos propios de cada una (`value`, `value_este_run`, `detail`,
 * `note`/`notes`, `threshold`/`threshold_alert`…). Sumar el ratio de accionado daría 162%.
 *
 * La definición del capturer describe CÓMO calcular cada métrica, pero no QUÉ FORMA tiene el número, y sin un
 * consumidor nadie se entera. Es el principio 1 del arnés aplicado a su propia medición:
 * **una métrica que nadie agrega es una métrica que no existe.** No da error: da silencio.
 *
 * Los campos de IDENTIDAD (`repo` absoluto + `merge_commit`) son obligatorios por el mismo motivo: sin ellos las
 * retrospectivas corridas no se cuentan contra las pendientes. Esto cierra la capa numérica.
 *
 * ── LA REGLA QUE MÁS IMPORTA ─────────────────────────────────────────────────────────────────
 *
 * 🔴 **`null` no es `0`.** Una métrica no calculada NO se reporta como cero: se reporta como no
 * medida, con motivo. Confundir las dos es cómo una métrica miente — un dashboard lleno de ceros
 * se lee como "no pasó nada" cuando en realidad significa "no miramos".
 *
 * Uso: `require('./lib/dashboard-metrics.js')` desde `scripts/`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '2.0';

/**
 * El contrato numérico. Chico a propósito: seis números.
 * `kind`:  'count'  → entero ≥ 0
 *          'ratio'  → número entre 0 y 1
 *          'count1' → entero ≥ 1
 * `parts`: sub-campos que también tienen que ser enteros ≥ 0 si están presentes.
 */
const METRICS = {
  advisor_warnings_per_story: {
    kind: 'count',
    parts: ['critical', 'warning'],
    label: 'hallazgos nuevos introducidos por el diff',
  },
  advisor_warnings_actioned_ratio: {
    kind: 'ratio',
    parts: ['actioned', 'waived', 'refuted', 'denominator'],
    label: 'proporción de hallazgos nuevos que se accionaron',
  },
  advisor_pipeline_runtime_failures: {
    kind: 'count',
    parts: [],
    label: 'revisores que crashearon o se colgaron',
  },
  advisor_rerun_loop_iterations: {
    kind: 'count1',
    parts: [],
    label: 'iteraciones del paso de revisores',
  },
  step_8_commit_skipped_rerun: {
    kind: 'count',
    parts: [],
    label: 'commits con arreglos post-auditoría sin re-correr revisores',
  },
  // 🔴 La fila que existe para denunciar el punto ciego sería ella misma el punto ciego.
  // Su definición presupone una story con paso 5b: sus dos señales son una story hija que declara
  // `followup_of:` y un commit que re-toca un archivo del File List. Un cambio que entra SIN story no
  // encaja en ninguna, así que la fila imprimiría `0` aunque ese cambio produzca un incidente.
  // Un cero que significa «esta pregunta no se pudo hacer» es el falso
  // verde que la fila fue creada para evitar. Entra al contrato para que no se pueda
  // publicar: ver la regla de `status: 'n/a'` en validate().
  deep_review_skipped_then_hotfixed: {
    kind: 'count',
    parts: ['commits_fuera_del_pipeline', 'commits_sin_carril'],
    label: 'cambios que saltearon la revisión profunda y después hubo que arreglar',
  },
  advisor_findings_on_verification_artifacts: {
    kind: 'count',
    parts: ['produccion', 'tests', 'story_spec'],
    label: 'hallazgos sobre el instrumento que verifica (tests y spec)',
    // 🔴 El contrato dice QUÉ CUENTA `value`, no sólo qué forma tiene. Fijar el TIPO no alcanza: queda abierto el
    // SIGNIFICADO. Con las tres partes presentes, `value` podría ser `tests + story_spec` (lo que dice el
    // label), el TOTAL con `produccion` o sólo `tests` — tres unidades en la misma serie y el
    // validador en verde. La invariante vive ACÁ, en el contrato, y no en un `if` suelto del validador: si el
    // contrato está en prosa y el chequeo en código, se separan. Sólo se juzga cuando están las partes que la
    // definen; sin ellas no se puede afirmar nada, y «no pude mirar» no es «está bien».
    invariant: (e) => {
      if (e.tests === null || e.story_spec === null) return null;
      const esperado = e.tests + e.story_spec;
      return e.value === esperado ? null
        : `\`value\` = ${e.value} pero \`tests + story_spec\` = ${esperado} — el label cuenta tests + story_spec, no otra cosa`;
    },
  },
};

// La proporción de hallazgos accionados NO lleva invariante todavía, a propósito: `denominator` es `actioned + waived`
// en unos archivos, `actioned + waived + refuted` en otros y ninguna de las dos en otros — no hay una lectura única
// que declarar, y gatear con una inventada es peor que no gatear. Cuando el recolector publique la serie, el contrato
// se escribe con lo medido.

const IDENTITY = ['repo', 'merge_commit', 'project', 'captured_at'];

// ── lectores tolerantes ──────────────────────────────────────────────────────────────────────

/**
 * Devuelve el número de un campo, o null si NO se puede afirmar con certeza.
 * NUNCA adivina: un string como "3 de 5" o "multiple (pre-existing)" devuelve null, no 3.
 * Un string que es exactamente un número ("3", "0.83") sí se acepta — eso no es adivinar.
 */
function toNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return null;
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function shapeOk(kind, n) {
  if (kind === 'ratio') return n >= 0 && n <= 1;
  if (kind === 'count1') return Number.isInteger(n) && n >= 1;
  return Number.isInteger(n) && n >= 0;
}

// ── validación ───────────────────────────────────────────────────────────────────────────────

/**
 * Valida un documento de métricas contra el formato 2.0.
 * Devuelve { ok, version, errors[], notMeasured[] }.
 *
 * Un documento en formato viejo (sin `schema_version` 2.x) NO es un error: es `legacy`.
 * Se cuenta aparte y no se suma nunca — la serie declara su propia cobertura.
 */
function validate(doc, { strict = true } = {}) {
  const errors = [];
  const notMeasured = [];
  const version = String(doc && doc.schema_version || '');
  const isV2 = version.startsWith('2.');

  if (!isV2) {
    return { ok: true, version: version || '(sin versión)', legacy: true, errors: [], notMeasured: [] };
  }

  for (const k of IDENTITY) {
    if (!doc[k] || typeof doc[k] !== 'string' || !doc[k].trim()) {
      errors.push(`falta el campo de identidad \`${k}\``);
    }
  }
  if (doc.repo && !path.isAbsolute(String(doc.repo))) {
    errors.push('`repo` tiene que ser un path ABSOLUTO (contrato con retro-pending)');
  }
  if (doc.merge_commit && String(doc.merge_commit).trim().length < 7) {
    errors.push('`merge_commit` tiene que ser un sha de al menos 7 caracteres');
  }

  const m = (doc && doc.metrics) || {};
  if (typeof m !== 'object' || Array.isArray(m)) {
    errors.push('`metrics` tiene que ser un objeto');
    return { ok: false, version, legacy: false, errors, notMeasured };
  }

  for (const [name, spec] of Object.entries(METRICS)) {
    const entry = m[name];
    if (entry === undefined) {
      if (strict) errors.push(`falta la métrica \`${name}\``);
      continue;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`\`${name}\` tiene que ser un objeto con \`value\``);
      continue;
    }

    // 🔴 «No pude preguntar» no se publica como un número. Una entrada que se declara a
    // sí misma no-aplicable (`status: 'n/a'`) o que trae `unavailable_reason` está diciendo que la
    // pregunta no se pudo hacer: ahí `value` va en null. Un 0 en ese caso se suma a la serie y se lee
    // como «miré y no hay», que es el falso verde más caro del tablero.
    const seDeclaraNoMedida = entry.status === 'n/a'
      || (entry.unavailable_reason !== undefined && String(entry.unavailable_reason).trim() !== '');
    if (seDeclaraNoMedida && entry.value !== null) {
      errors.push(`\`${name}\` se declara no medida (${entry.status === 'n/a' ? "status: 'n/a'" : 'unavailable_reason'}) pero publica \`value: ${JSON.stringify(entry.value)}\` — no medido no es 0`);
      continue;
    }

    // null explícito = no medida. Legal, pero exige motivo.
    if (entry.value === null) {
      if (!entry.unavailable_reason || !String(entry.unavailable_reason).trim()) {
        errors.push(`\`${name}\` es null sin \`unavailable_reason\` — una métrica no medida se declara, no se calla`);
      } else {
        notMeasured.push({ metric: name, reason: String(entry.unavailable_reason) });
      }
      continue;
    }

    const n = toNumber(entry.value);
    if (n === null) {
      errors.push(`\`${name}.value\` no es un número: ${JSON.stringify(entry.value)}`);
      continue;
    }
    if (!shapeOk(spec.kind, n)) {
      const esperado = spec.kind === 'ratio' ? 'un número entre 0 y 1'
        : spec.kind === 'count1' ? 'un entero ≥ 1' : 'un entero ≥ 0';
      errors.push(`\`${name}.value\` = ${n} — se esperaba ${esperado}`);
      continue;
    }
    const partes = {};
    for (const p of spec.parts) {
      if (entry[p] === undefined || entry[p] === null) { partes[p] = null; continue; }
      const pn = toNumber(entry[p]);
      if (pn === null || !Number.isInteger(pn) || pn < 0) {
        errors.push(`\`${name}.${p}\` = ${JSON.stringify(entry[p])} — se esperaba un entero ≥ 0`);
        partes[p] = null;
      } else partes[p] = pn;
    }
    // la invariante del contrato (qué CUENTA `value`), sólo con partes válidas: un error de forma ya se cobró arriba
    if (typeof spec.invariant === 'function') {
      const falla = spec.invariant({ value: n, ...partes });
      if (falla) errors.push(`\`${name}\`: ${falla}`);
    }
  }

  return { ok: errors.length === 0, version, legacy: false, errors, notMeasured };
}

// ── carga ────────────────────────────────────────────────────────────────────────────────────

/**
 * Lee todos los `metrics-*.json` de un directorio y los clasifica SIN adivinar.
 * { records: [...], counts: { total, v2ok, v2bad, legacy, unreadable } }
 */
/**
 * La fecha de un registro sale de una CADENA DECLARADA, y se publica de qué eslabón salió.
 *
 * 🔴 Por qué: según el archivo, la fecha está en `captured_at`, en `generated_at`, en `date` o sólo en el nombre.
 * Leer un solo campo deja `date: null` en muchos registros, y cualquier `--since`/`--until` los descarta EN SILENCIO.
 * Peor: la tendencia ordena por `String(null)`, que cae después de cualquier fecha, así que
 * "primera mitad vs segunda mitad" mezclaría meses distintos y la flecha no significaría nada.
 *
 * Una fecha inferida del nombre del archivo NO vale lo mismo que una declarada adentro: por eso
 * viaja `date_source`, y si la declarada y la del nombre no coinciden (pasa en 21 de 106), viaja
 * `date_conflict` con las dos — quien lea tiene que poder decirlo, no descubrirlo.
 */
function resolveDate(doc, file) {
  const iso = (v) => {
    const s = String(v == null ? '' : v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };
  const fromName = (() => { const m = String(file || '').match(/(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; })();
  const chain = [['captured_at', iso(doc && doc.captured_at)],
                 ['generated_at', iso(doc && doc.generated_at)],
                 ['date', iso(doc && doc.date)],
                 ['filename', fromName]];
  const hit = chain.find(([, d]) => d !== null);
  if (!hit) return { date: null, date_source: null, date_conflict: null };
  const [date_source, date] = hit;
  const date_conflict = date_source !== 'filename' && fromName && fromName !== date
    ? { declared: date, filename: fromName }
    : null;
  return { date, date_source, date_conflict };
}

function loadAll(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^metrics-.*\.json$/.test(f)).sort();
  } catch {
    return { records: [], counts: { total: 0, v2ok: 0, v2bad: 0, legacy: 0, unreadable: 0 }, dir };
  }

  const records = [];
  const counts = { total: files.length, v2ok: 0, v2bad: 0, legacy: 0, unreadable: 0 };

  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      counts.unreadable++;
      records.push({ file: f, status: 'unreadable', values: {} });
      continue;
    }

    const v = validate(doc, { strict: false });
    const values = {};
    const m = (doc && doc.metrics) || {};
    for (const [name, spec] of Object.entries(METRICS)) {
      const entry = m[name];
      if (!entry || typeof entry !== 'object') { values[name] = null; continue; }
      const n = toNumber(entry.value);
      values[name] = n !== null && shapeOk(spec.kind, n) ? n : null;
    }

    let status;
    if (v.legacy) { counts.legacy++; status = 'legacy'; }
    else if (v.ok) { counts.v2ok++; status = 'ok'; }
    else { counts.v2bad++; status = 'invalid'; }

    records.push({
      file: f,
      status,
      errors: v.errors,
      ...resolveDate(doc, f),
      project: doc.project || null,
      story_id: doc.story_id != null ? String(doc.story_id) : null,
      merge_commit: doc.merge_commit || null,
      values,
    });
  }

  return { records, counts, dir };
}

module.exports = { SCHEMA_VERSION, METRICS, IDENTITY, validate, loadAll, toNumber, shapeOk, resolveDate };
