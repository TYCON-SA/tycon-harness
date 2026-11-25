/**
 * pipeline-models.js — una parte de pipeline.js (la cargan otras partes).
 *
 * Responsabilidad: los modelos de los revisores y la revisión de la organización.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { estadoPipeline, MODELOS, fs, os, parseFrontmatterPipeline, path, readSessionMarker, readText, sessionIdFileKey, stateDirOf } = require('./pipeline-shared.js');
const { computeRiskClass, parseFrontmatterList } = require('./pipeline-risk.js');
const SIN_ORG = { declared: false, data: null, problem: null };

/**
 * La configuración `models` de la organización, del arnés que ve esta corrida (el camino de `harnessIntegrations`):
 * `{ declared, data, problem }`. Nunca tira. opts: env · home · tree (el árbol, para las pruebas).
 */
function orgModels(opts = {}) {
  const env = opts.env || process.env;
  try {
    const dir = opts.tree || require('./harness-path.js').rutaArnesHook({ env, home: opts.home }).dir;
    if (!dir) return SIN_ORG;
    const lector = path.join(dir, 'scripts', 'lib', 'team-repos.js');
    if (!fs.existsSync(lector)) {
      // un árbol sin lector con un team-repos.json: no se puede validar, y se dice (no es «sin configuración»)
      return fs.existsSync(path.join(dir, 'team-repos.json'))
        ? { ...SIN_ORG, problem: `no pude leer la configuración de la organización (${path.join(dir, 'team-repos.json')}: el arnés no trae su lector, ${lector}): uso los valores de hoy` }
        : SIN_ORG;
    }
    return MODELOS.readOrgModels({ dir, teamRepos: require(lector) });
  } catch (e) {
    return { ...SIN_ORG, problem: `no pude leer la configuración de la organización (${String((e && e.message) || e).split('\n')[0]}): uso los valores de hoy` };
  }
}

/** El pedido del dev para esta corrida (`marker.js set-models`), o null. */
function pedidosDeModelos(marker) {
  const v = marker && marker.modelRequests && marker.modelRequests.values;
  return v && typeof v === 'object' && Object.keys(v).length ? v : null;
}

/**
 * Lo que la línea de comandos dice de los modelos: `models_problem` (la configuración no se pudo leer) y
 * `models_warnings` (lo que se bajó al techo, un pedido que no aplica…), cada aviso una sola vez por corrida: con
 * marcador, lo ya avisado queda en `modelsWarned` (la misma lógica que `marker.js mark-models-warned`); sin marcador,
 * en cada salida. Nunca cambia el código de salida.
 */
function decirModelos(out, org, warnings) {
  if (org && org.problem) out.models_problem = org.problem;
  if (!warnings || !warnings.length) return;
  const marker = readSessionMarker();
  const ya = new Set((marker && Array.isArray(marker.modelsWarned)) ? marker.modelsWarned : []);
  const vistos = new Set();
  const nuevos = warnings.filter((w) => !ya.has(w.key) && !vistos.has(w.key) && vistos.add(w.key));
  if (!nuevos.length) return;
  out.models_warnings = nuevos.map((w) => w.message);
  if (marker) anotarModelosAvisados(nuevos.map((w) => w.key));
}

/** Anota en el marcador de esta sesión las claves ya avisadas (`modelsWarned`). Nunca tira. */
function anotarModelosAvisados(keys) {
  try {
    const markerPath = path.join(stateDirOf(os.homedir()), 'active', `${sessionIdFileKey()}.json`);
    const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    m.modelsWarned = [...new Set([...(Array.isArray(m.modelsWarned) ? m.modelsWarned : []), ...keys])];
    const tmp = `${markerPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, markerPath);
  } catch (_) { /* sin marcador o ilegible: se vuelve a avisar, que es lo de menos */ }
}

/**
 * La política del pase adversarial de la organización (`team-repos.json → deep_review.default`, `always` o `auto`):
 * `{ value, problem }`, con `value: null` sin política. La lee sólo la línea de comandos, como `orgModels`. Nunca tira.
 */
function orgDeepReview(opts = {}) {
  const env = opts.env || process.env;
  const nada = { value: null, problem: null };
  try {
    const dir = opts.tree || require('./harness-path.js').rutaArnesHook({ env, home: opts.home }).dir;
    if (!dir) return nada;
    const lector = path.join(dir, 'scripts', 'lib', 'team-repos.js');
    const archivo = path.join(dir, 'team-repos.json');
    let texto;
    // sin archivo, la organización no declaró nada; uno que está y no se puede usar se dice: la política no se pierde callada
    try { texto = fs.readFileSync(archivo, 'utf8'); } catch (e) {
      return e && e.code === 'ENOENT' ? nada : { value: null, problem: `no pude leer la política del pase de la organización (${archivo}: ${(e && e.code) || e}): decide el riesgo` };
    }
    if (!fs.existsSync(lector)) return { value: null, problem: `no pude leer la política del pase de la organización (${archivo}: el arnés no trae su lector, ${lector}): decide el riesgo` };
    const r = require(lector).parse(String(texto).replace(/^﻿/, ''));
    const sec = r.sectionProblems && r.sectionProblems.deep_review;
    if (sec && sec.length) {
      // una clave mala de la sección cae sola: la política (`default`) sigue si está bien escrita
      let crudo = null;
      try { crudo = JSON.parse(String(texto).replace(/^﻿/, '')); } catch (_) { crudo = null; }
      const d = crudo && crudo.deep_review && crudo.deep_review.default;
      const vale = d === 'always' || d === 'auto';
      const malDefault = sec.some((p) => /deep_review(\.default)?$/.test(p.path));
      return { value: vale && !malDefault ? d : null, problem: `la política del pase de la organización tiene un valor que no vale (${sec[0].path}: ${sec[0].message})${vale && !malDefault ? `: la política sigue (${d}) y esa clave cae a la de fábrica` : ': decide el riesgo'}` };
    }
    if (!r.ok) {
      const p = (r.problems && r.problems[0]) || {};
      return { value: null, problem: `no pude usar team-repos.json de la organización (${p.path ? `${p.path}: ` : ''}${p.message || 'no es válido'}): decide el riesgo` };
    }
    const v = r.data && r.data.deep_review && r.data.deep_review.default;
    return { value: v === 'always' || v === 'auto' ? v : null, problem: null };
  } catch (e) {
    return { value: null, problem: `no pude leer la política del pase de la organización (${String((e && e.message) || e).split('\n')[0]}): decide el riesgo` };
  }
}

/** Lo que la línea de comandos le pasa a las funciones que deciden: la configuración y el pedido de la corrida. */
function conModelosDeLaCorrida(args) {
  const politica = orgDeepReview();
  return { ...args, orgModels: orgModels(), modelRequests: pedidosDeModelos(readSessionMarker()), orgDeepReview: politica.value, orgDeepReviewProblem: politica.problem,
    ...revisionDeLaOrganizacion() };
}

/**
 * La configuración de las revisiones de la organización (lib/review-policy.js, clave por clave) y si el dueño está
 * ausente para la pregunta del código de esta sesión: la marca puesta, o la pregunta sin respuesta pasados los minutos.
 * La lee sólo la línea de comandos. Nunca tira: sin leerla, los valores de fábrica y el dueño presente.
 */
function revisionDeLaOrganizacion() {
  const out = { reviewConfig: null, ownerAway: false, reviewConfigProblems: [] };
  const causa = (e) => String((e && e.message) || e).split('\n')[0];
  let PR;
  try {
    PR = require('./plan-review.js');
    const c = PR.configDeLaOrganizacion();
    out.reviewConfig = c.values;
    out.reviewConfigProblems = [...c.problems];
  } catch (e) {
    out.reviewConfigProblems.push({ path: 'review', message: `no pude leer la configuración de las revisiones (${causa(e)}): uso la de fábrica` });
    return out;
  }
  // la configuración ya está leída: un fallo de acá en adelante sólo deja al dueño presente, y así se dice
  try {
    const estado = stateDirOf(os.homedir());
    const leida = require(path.join(estadoPipeline.SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-away.js')).get({ estado });
    if (leida.problem) out.reviewConfigProblems.push({ path: 'owner-away', message: `${leida.problem}: la persona cuenta como presente` });
    const sid = sessionIdFileKey();
    // la pregunta cuenta sólo si es sobre este mismo diff (como la del plan): una de una ejecución cerrada no vale
    const h = PR.huellaDe({ estado, sesion: sid, kind: 'code' });
    const sinRegistro = [];
    const pregunta = h.codigo ? null : PR.preguntasAbiertas({ estado, problemas: sinRegistro }).find((p) => p.sesion === sid && p.kind === 'code' && p.huella === h.huella);
    // con el registro ilegible no se sabe si se preguntó ni qué se respondió: la persona presente y sin respuesta
    if (sinRegistro.length) {
      out.reviewConfigProblems.push({ path: 'owner-away', message: `${sinRegistro[0]}: la persona cuenta como presente y la pregunta del código, sin respuesta` });
      out.codeAnswer = null;
      return out;
    }
    // la respuesta a la pregunta de este diff decide la celda que preguntaba o esperaba
    if (!h.codigo) out.codeAnswer = PR.respuestaDe({ estado, sesion: sid, kind: 'code', huella: h.huella });
    out.ownerAway = require('./review-policy.js').ownerAway({ mark: leida.mark, askedAt: pregunta ? Date.parse(pregunta.ts) : null,
      now: Date.now(), minutes: out.reviewConfig.plan_review.owner_away_minutes }).away;
  } catch (e) {
    out.reviewConfigProblems.push({ path: 'owner-away', message: `no pude saber si la persona está ausente (${causa(e)}): cuenta como presente` });
  }
  return out;
}

// ── pipeline.js model-hint — sugerencia de modelo de sesión por complejidad ──
// Los pasos de armar el plan, aprobarlo e implementar corren
// INLINE en el main loop (no en subagentes) → su modelo es el DE LA
// SESIÓN y solo el user puede cambiarlo con /model. Este comando computa la
// recomendación MECÁNICA para que el Arranque (preflight) la compare con el modelo
// real de la sesión (el orquestador lo sabe por su system prompt) y sugiera el
// switch ANTES de gastar contexto — con sesión fresca por pipeline el
// preflight es el momento exacto para elegir modelo; /model conserva sesión y
// marker, no se pierde nada.
//
// Tiers (razón: el plan es el punto de mayor apalancamiento — un plan malo
// cascadea a re-loops del paso de revisores — y la implementación es el mayor consumidor
// de tokens; opus ~1.7x sonnet):
//   LOW           → sonnet alcanza (opus también ok — no molestar si ya está ahí)
//   NORMAL común  → opus
//   NORMAL pesada → opus, con más esfuerzo (≥2 señales pesadas). Fable sólo si la organización lo declara
//                   (models.session.heavy): el arnés no lo sugiere solo.
// SIEMPRE advisory: el orquestador sugiere en 1 línea, el user decide, NUNCA bloquea.
function computeModelHint(args) {
  const rc = computeRiskClass(args);
  const content = args.story && fs.existsSync(args.story) ? readText(args.story) : '';
  const fm = parseFrontmatterPipeline(content);
  const created = parseFrontmatterList(content, 'files_to_create');
  const scopeFiles = args.files && args.files.length
    ? args.files
    : [...created, ...parseFrontmatterList(content, 'files_to_modify')];
  let acCount = 0;
  try { acCount = (require('./story-checks.js').parseAcsFromSpec(content) || []).length; }
  catch { /* sin story-checks → señal muchos-acs queda en 0 (conservador) */ }

  const signals = [];
  const add = (name, hit, detail) => signals.push({ name, hit, detail });
  // en la liviana, cuántos archivos o ACs no piden un modelo mayor; en la completa, como siempre.
  const liviana = rc.run_size === 'liviana';
  add('superficie-grande', !liviana && scopeFiles.length > 12, `${scopeFiles.length} archivos en scope (umbral >12)${liviana ? ' — corrida liviana: no cuenta' : ''}`);
  add('muchos-acs', !liviana && acCount >= 10, `${acCount} ACs (umbral ≥10)${liviana ? ' — corrida liviana: no cuenta' : ''}`);
  add('codigo-nuevo-amplio', /CREATE/i.test(fm.approach || '') && created.length >= 5,
    `approach=${fm.approach || '(ausente)'} + ${created.length} files_to_create (umbral: CREATE y ≥5)`);
  add('multi-tanda', /^pipelines:/m.test(content), 'bloque pipelines: — entregas en tandas con interdependencias');
  add('migraciones-mas-codigo',
    scopeFiles.some((f) => /\.sql$|(^|\/)drizzle\//i.test(f)) && scopeFiles.some((f) => !/\.sql$/i.test(f)),
    'migración SQL + código en el mismo scope');
  add('scope-firmado', !!(fm.signed_for_sprint || fm.signed_ac_ref), 'scope firmado con cliente — costo de error alto');

  const heavyCount = signals.filter((s) => s.hit).length;
  const heavy = rc.risk === 'NORMAL' && heavyCount >= 2;
  // los valores salen de lib/models.js; con `models.session` de la organización, ésos (y also_ok
  // vacío); con techo obligatorio, recortados. La configuración llega por argumento: esta función no lee la máquina.
  const band = rc.risk === 'LOW' ? 'low' : (heavy ? 'heavy' : 'normal');
  const S = MODELOS.DEFAULTS.session;
  const hoy = { recommended: S[band], also_ok: band === 'normal' || S.normal === S[band] ? [] : [S.normal] };
  const org = args.orgModels && args.orgModels.declared ? args.orgModels.data : null;
  const avisos = [];
  const ses = org ? MODELOS.resolveSession({ org, band, today: hoy, warnings: avisos }) : { ...hoy, origin: 'default' };
  const recommended = ses.recommended;
  const alsoOk = ses.also_ok;
  const extra = {};
  if (org || args.sessionModel !== undefined) {
    const fam = MODELOS.normalizeSessionModel(args.sessionModel, equivalenciasDeModelos());
    const ceiling = MODELOS.ceilingOf(org);
    extra.session_check = fam
      ? { model: fam, ceiling, above: !!ceiling && MODELOS.rank(fam) > MODELOS.rank(ceiling) }
      : { model: null, reason: 'no se sabe el modelo de la sesión' };
    if (extra.session_check.above) {
      extra.session_warning = `la sesión corre en ${fam}, por encima del techo de la organización (${ceiling}): cambiá con /model o seguí; el arnés no la cambia`;
    }
  }
  const deLaOrg = ses.origin === 'organization' || recommended !== hoy.recommended;
  const out = {
    recommended_session_model: recommended,
    also_ok: alsoOk,
    risk: rc.risk,
    heavy,
    heavy_signal_count: heavyCount,
    signals,
    reason: rc.risk === 'LOW'
      ? 'risk LOW (superficie chica, sin firmas/SQL/paths sensibles) → sonnet alcanza; un modelo más caro acá es plata de más'
      : heavy
        ? `NORMAL + ${heavyCount} señales pesadas (${signals.filter((s) => s.hit).map((s) => s.name).join(', ')}) → ${recommended} con más esfuerzo`
        : 'NORMAL común → opus (sonnet se queda corto en el plan)',
    note: (deLaOrg ? `la sugerencia sale de la configuración de la organización (session.${band}${MODELOS.ceilingOf(org) ? `, techo ${MODELOS.ceilingOf(org)}` : ''}): ${recommended}. ` : '') +
      'ADVISORY para el MODELO DE SESIÓN (armar el plan, aprobarlo e implementar corren inline). Orquestador: compará con tu modelo real (system prompt); si NO está en recommended+also_ok → sugerí `/model <recomendado>` en 1 línea (el switch conserva sesión y marker) y seguí con lo que el user decida. NUNCA bloquea.',
    ...extra,
  };
  if (avisos.length) Object.defineProperty(out, '_avisos', { value: avisos, enumerable: false });
  return out;
}

/** Las equivalencias Claude ↔ Codex del árbol de este skill (para reconocer el modelo de la sesión), o `{}`. */
function equivalenciasDeModelos() {
  try { return JSON.parse(fs.readFileSync(path.resolve(estadoPipeline.SCRIPTS_DIR, '..', '..', '..', 'build', 'equivalences.json'), 'utf8')).models || {}; }
  catch (_) { return {}; }
}

module.exports = { orgModels, orgDeepReview, revisionDeLaOrganizacion, computeModelHint, pedidosDeModelos, conModelosDeLaCorrida, decirModelos };
