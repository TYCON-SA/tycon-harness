'use strict';
/**
 * lib/models.js — el modelo de cada trabajo del pipeline.
 *
 * POR QUÉ EXISTE: el modelo de cada trabajo estaría escrito a mano en seis lugares (el `model:` de cada revisor, las
 * tablas de pipeline.js, el portón del pase adversarial, la regla de los ayudantes, la sugerencia de sesión y las
 * equivalencias de Codex) y ninguna organización lo podría elegir. Por eso:
 *   - los valores de hoy viven acá (`DEFAULTS`, `TIERS`); el `model:` de cada `agents/*.md`, el `MODEL` de
 *     adversarial-verify.workflow.js y el valor por defecto de build/generate.js son copias que verifica una prueba;
 *   - una organización los cambia en `team-repos.json → models` (lector scripts/lib/team-repos.js) y este módulo es el
 *     ÚNICO que la lee (`readOrgModels`): el pipeline, el control de lanzamientos, el despliegue de Codex y la paridad;
 *   - con `mandatory_ceiling: true` el `ceiling` es un techo: nada lo pasa, se baja y se avisa (nunca frena).
 *
 * LA PRECEDENCIA, para un revisor r (y un trabajo t):
 *   base(r)  = pedido(r) ?? pedido(reviewers) ?? org.reviewer[r] ?? org.reviewers ?? defaultFor(r)
 *   base(t)  = pedido(t) ?? org[t] ?? DEFAULTS[t]
 *   vuelta>1 = first_round por encima de reviewers_reloop → reviewers_reloop; si no, first_round
 *   final(x) = con techo y x por encima → el techo (y un aviso, una vez por corrida)
 * `pedido` = lo que el dev pidió para la corrida (`marker.js set-models`) y las banderas de hoy (--cost-tier, …).
 *
 * Nada de esto lee la máquina salvo `readOrgModels` y `defaultFor` (el `.md` instalado de un revisor): las funciones
 * que deciden reciben la configuración por argumento, así las pruebas nunca ven la de la máquina.
 */

const fs = require('fs');
const path = require('path');

/** El vocabulario, en orden: haiku < sonnet < opus < fable. `team-repos.js` tiene su copia (T21 las compara). */
const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const HAIKU = MODELS[0];
const SONNET = MODELS[1];
const OPUS = MODELS[2];
const FABLE = MODELS[3];

/** Los valores de hoy: sin configuración, cada trabajo usa éstos. */
const DEFAULTS = {
  reviewers: SONNET,
  reviewer: { 'tycon-spec-first-checker': OPUS },
  reviewers_reloop: SONNET,
  adversarial: { model: SONNET, heavy: OPUS, fable_question: 'ask' },
  helpers: HAIKU,
  // una story pesada sugiere opus: el arnés no sugiere fable solo; una organización lo elige con models.session.heavy
  session: { low: SONNET, normal: OPUS, heavy: OPUS },
};

/** El modelo de cada tier de costo de un revisor (lo que en pipeline.js era TIER_TO_MODEL). */
const TIERS = { lean: HAIKU, standard: SONNET, deep: OPUS };

const REVIEWER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JOBS = ['reviewers', 'reviewers_reloop', 'adversarial', 'helpers'];

const rank = (m) => MODELS.indexOf(m);
const isModel = (m) => MODELS.includes(m);
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** `m` recortado al techo: si `ceiling` existe y `m` lo pasa, el techo. */
function capAt(m, ceiling) {
  if (!ceiling || !isModel(m)) return m;
  return rank(m) > rank(ceiling) ? ceiling : m;
}

/** El techo de una configuración ya validada: sólo con `mandatory_ceiling: true`. */
function ceilingOf(org) {
  return isObject(org) && org.mandatory_ceiling === true && isModel(org.ceiling) ? org.ceiling : null;
}

/** La carpeta `agents/` de donde se leen los `.md` instalados: la misma que traduce generate.js. */
function agentsDirDefault() {
  // la misma precedencia que los paquetes (packs.js, dirAgentes): TYCON_AGENTS_DIR primero
  if (process.env.TYCON_AGENTS_DIR) return process.env.TYCON_AGENTS_DIR;
  try {
    const { resolveSkillsDirs } = require(path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'skills-dir.js'));
    return path.join(resolveSkillsDirs().repo, 'agents');
  } catch (_) {
    return path.resolve(__dirname, '..', '..', '..', '..', 'agents');
  }
}

/**
 * El `.md` de un revisor: en la carpeta de agentes de la raíz o, si no está ahí, en la de un paquete del mismo árbol
 * (`packs/<p>/agents/`: un paquete puede traer sus agentes). null si no está en ninguna.
 */
const LOOKUP_PROBLEMS = new Set();
function agentFile(name, agentsDir) {
  if (!REVIEWER_NAME.test(String(name || ''))) return null;
  const root = agentsDir || agentsDirDefault();
  const own = path.join(root, `${name}.md`);
  if (fs.existsSync(own)) return own;
  // los paquetes donde los busca el cargador (`TYCON_PACKS_DIR`, o `packs/` del mismo árbol), cada uno con su carpeta de
  // agentes declarada en su manifiesto (`agents`, por defecto `agents`)
  const packsDir = process.env.TYCON_PACKS_DIR || path.join(path.dirname(root), 'packs');
  let packs = [];
  // lo que no se pudo leer queda anotado (`lookupProblems`): «no pude mirar» no es «no existe», y la resolución lo avisa
  try { packs = fs.readdirSync(packsDir).sort(); } catch (e) { packs = []; if (!e || e.code !== 'ENOENT' || process.env.TYCON_PACKS_DIR) LOOKUP_PROBLEMS.add(`no se pudo leer la carpeta de paquetes ${packsDir} (${(e && e.code) || e}): los revisores de un paquete no se encuentran`); }
  for (const p of packs) {
    let sub = 'agents';
    // (una carpeta que sale del paquete —absoluta, con «..» o tramos vacíos— no se sigue: el cargador la da por rota)
    const mf = path.join(packsDir, p, 'pack.json');
    if (fs.existsSync(mf)) {
      try { const j = JSON.parse(fs.readFileSync(mf, 'utf8')); if (j && typeof j.agents === 'string' && j.agents && !path.isAbsolute(j.agents) && !j.agents.includes('\\') && !j.agents.split('/').some((t) => t === '..' || t === '')) sub = j.agents; }
      catch (e) { LOOKUP_PROBLEMS.add(`no se pudo leer ${mf} (${(e && e.message) || e}): sus revisores se buscan en su carpeta agents/`); }
    }
    const f = path.join(packsDir, p, sub, `${name}.md`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** El `model:` del frontmatter del `.md` de un revisor, o null. */
function frontmatterModel(name, { agentsDir } = {}) {
  if (!REVIEWER_NAME.test(String(name || ''))) return null;
  try {
    const file = agentFile(name, agentsDir);
    if (!file) return null;
    const src = fs.readFileSync(file, 'utf8');
    const fm = (src.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
    const m = (fm.match(/^model:\s*["']?([\w.-]+)/m) || [])[1];
    return isModel(m) ? m : null;
  } catch (_) { return null; }
}

/** El valor de hoy de un revisor: `DEFAULTS.reviewer`, si no el `model:` de su `.md`, si no `DEFAULTS.reviewers`. */
function defaultFor(name, opts = {}) {
  return DEFAULTS.reviewer[name] || frontmatterModel(name, opts) || DEFAULTS.reviewers;
}

/** Si el revisor existe en este arnés (tiene su `.md` o está en las tablas de hoy). */
function reviewerExists(name, opts = {}) {
  if (DEFAULTS.reviewer[name]) return true;
  try { return agentFile(name, opts.agentsDir) !== null; } catch (_) { return false; }
}

/**
 * Recorta al techo y anota el aviso. `que` describe el valor («tycon-spec-first-checker», «el pase en una story
 * pesada»); un pedido del dev dice «pediste <x>».
 */
function aplicarTecho(model, ceiling, { key, que, pedido }, warnings) {
  const final = capAt(model, ceiling);
  if (final !== model) {
    warnings.push({
      key,
      message: pedido
        ? `pediste ${model}; el techo de la organización es ${ceiling}: uso ${ceiling}${que ? ` (${que})` : ''}`
        : `${que} en ${model} pasa el techo de la organización (${ceiling}): uso ${ceiling}`,
    });
  }
  return final;
}

/**
 * Los modelos de los revisores de un set: `{ <revisor>: { model, origin, first_round? } }`.
 * opts: org (models validado o null) · requests (`marker.modelRequests.values`) · costTier (`lean`|`deep`|…) ·
 * tierOf(revisor) (el tier de costo de hoy) · iter · agentsDir · warnings (se le suman los avisos).
 */
function resolveReviewers({ org, requests, costTier, tierOf, set, fullSet, iter, agentsDir, warnings = [] }) {
  const corrida = fullSet || set || [];
  const o = isObject(org) ? org : {};
  const req = isObject(requests) ? requests : {};
  const ceiling = ceilingOf(o);
  const orgRev = isObject(o.reviewer) ? o.reviewer : {};
  const out = {};
  for (const r of set || []) {
    let model;
    let origin;
    let pedido = false;
    if (costTier === 'deep') { model = TIERS.deep; origin = 'run'; pedido = true; }
    else if (isModel(req[r])) { model = req[r]; origin = 'run'; pedido = true; }
    else if (isModel(req.reviewers)) { model = req.reviewers; origin = 'run'; pedido = true; }
    else if (costTier === 'lean' && tierOf && tierOf(r) === 'lean') { model = TIERS.lean; origin = 'run'; pedido = true; }
    else if (isModel(orgRev[r])) { model = orgRev[r]; origin = 'organization-reviewer'; }
    else if (isModel(o.reviewers)) { model = o.reviewers; origin = 'organization'; }
    else { model = defaultFor(r, { agentsDir }); origin = 'default'; }
    // un solo valor (el pedido o `models.reviewers`) es un solo aviso, no uno por revisor (avisa una vez)
    const general = !pedido && origin === 'organization';
    const first = aplicarTecho(model, ceiling, {
      key: pedido ? 'request:reviewers' : (general ? 'organization:reviewers' : `reviewer:${r}`),
      que: general ? 'models.reviewers' : r, pedido,
    }, warnings);
    const entry = { model: first, origin };
    if (iter && iter > 1) {
      // las vueltas siguientes: un tope; con --cost-tier deep no bajan
      const reloop = isModel(req.reviewers_reloop) ? req.reviewers_reloop : (isModel(o.reviewers_reloop) ? o.reviewers_reloop : DEFAULTS.reviewers_reloop);
      const tope = capAt(reloop, ceiling);
      entry.model = costTier === 'deep' || rank(first) <= rank(tope) ? first : tope;
      entry.first_round = first;
    }
    out[r] = entry;
  }
  // un pedido o una entrada de la organización para un revisor que no está en la corrida / no existe
  for (const r of Object.keys(req)) {
    if (!JOBS.includes(r) && REVIEWER_NAME.test(r) && !corrida.includes(r)) {
      warnings.push({ key: `request-unused:${r}`, message: `pediste un modelo para \`${r}\`, que no está en el set de esta corrida: no se aplica` });
    }
  }
  for (const r of Object.keys(orgRev)) {
    if (!r.startsWith('__') && !reviewerExists(r, { agentsDir })) {
      warnings.push({ key: `unknown-reviewer:${r}`, message: `\`${r}\` no es un revisor de este arnés: no se usa` });
    }
  }
  return out;
}

/**
 * El modelo del pase adversarial y la pregunta de Fable. opts: org · requests · flags { fable, opus, ultracode } ·
 * heavy · modelQuestion (la clave de la pregunta de modelo: `{ value, origin }`) · warnings.
 * → `{ model, origin, reason, question: { value, origin }, upsell, otherQuestion? }`
 */
function resolveAdversarial({ org, requests, flags = {}, heavy, modelQuestion, warnings = [] }) {
  const o = isObject(org) ? org : {};
  const req = isObject(requests) ? requests : {};
  const adv = isObject(o.adversarial) ? o.adversarial : {};
  const ceiling = ceilingOf(o);
  let model;
  let origin;
  let reason;
  let pedido = false;
  if (flags.fable) { model = FABLE; origin = 'run'; reason = '--deep-review-fable (autorización explícita del user)'; pedido = true; }
  else if (flags.opus) { model = OPUS; origin = 'run'; reason = '--deep-review-opus'; pedido = true; }
  else if (flags.ultracode) { model = OPUS; origin = 'run'; reason = 'ultracode ON → hunters en Opus'; pedido = true; }
  else if (isModel(req.adversarial)) { model = req.adversarial; origin = 'run'; reason = `pedido de esta corrida (marker.js set-models) → ${req.adversarial}`; pedido = true; }
  else if (heavy && isModel(adv.heavy)) { model = adv.heavy; origin = 'organization'; reason = `story pesada → ${adv.heavy} (configuración de la organización)`; }
  else if (!heavy && isModel(adv.model)) { model = adv.model; origin = 'organization'; reason = `${adv.model} (configuración de la organización)`; }
  else if (heavy) { model = DEFAULTS.adversarial.heavy; origin = 'default'; reason = `story pesada → ${DEFAULTS.adversarial.heavy} (valor de hoy)`; }
  else { model = DEFAULTS.adversarial.model; origin = 'default'; reason = `${DEFAULTS.adversarial.model} (valor de hoy)`; }
  const final = aplicarTecho(model, ceiling, { key: pedido ? 'request:adversarial' : (heavy ? 'adversarial.heavy' : 'adversarial.model'), que: heavy ? 'el pase en una story pesada' : 'el pase adversarial', pedido }, warnings);
  if (final !== model) reason = pedido ? `pediste ${model}; el techo de la organización es ${ceiling} → ${final}` : `${reason}; el techo de la organización es ${ceiling} → ${final}`;
  // la pregunta: la de la organización gana; si no, la de la sugerencia de sesión; con un techo debajo de fable, nunca
  let question;
  let otherQuestion = null;
  if (adv.fable_question === 'ask' || adv.fable_question === 'never') {
    question = { value: adv.fable_question, origin: 'organization' };
    if (modelQuestion && modelQuestion.origin && modelQuestion.origin !== 'default') otherQuestion = modelQuestion;
  } else question = modelQuestion && modelQuestion.value ? { value: modelQuestion.value, origin: modelQuestion.origin } : { value: DEFAULTS.adversarial.fable_question, origin: 'default' };
  if (ceiling && rank(ceiling) < rank(FABLE)) question = { value: 'never', origin: 'ceiling' };
  const upsell = !!heavy && final !== FABLE && question.value !== 'never';
  return { model: final, origin, reason, question, upsell, otherQuestion, capped: final !== model, fromFlag: !!(flags.fable || flags.opus || flags.ultracode) };
}

/** El modelo de los ayudantes sueltos (búsqueda/exploración): `{ model, origin }`. */
function resolveHelpers({ org, requests, warnings = [] }) {
  const o = isObject(org) ? org : {};
  const req = isObject(requests) ? requests : {};
  let model;
  let origin;
  let pedido = false;
  if (isModel(req.helpers)) { model = req.helpers; origin = 'run'; pedido = true; }
  else if (isModel(o.helpers)) { model = o.helpers; origin = 'organization'; }
  else { model = DEFAULTS.helpers; origin = 'default'; }
  return { model: aplicarTecho(model, ceilingOf(o), { key: pedido ? 'request:helpers' : 'helpers', que: 'los ayudantes', pedido }, warnings), origin };
}

/**
 * La sugerencia de modelo de la sesión. `band` = `low` | `normal` | `heavy`; `today` = `{ recommended, also_ok }` de
 * hoy. Con `session` declarado, la de la organización y `also_ok: []`; con techo, recortada.
 */
function resolveSession({ org, band, today, warnings = [] }) {
  const o = isObject(org) ? org : {};
  const ses = isObject(o.session) ? o.session : {};
  const ceiling = ceilingOf(o);
  let recommended;
  let alsoOk;
  let origin;
  if (isModel(ses[band])) { recommended = ses[band]; alsoOk = []; origin = 'organization'; }
  else { recommended = today.recommended; alsoOk = today.also_ok.slice(); origin = 'default'; }
  recommended = aplicarTecho(recommended, ceiling, { key: `session.${band}`, que: `la sesión sugerida para una story ${band === 'low' ? 'liviana' : band === 'heavy' ? 'pesada' : 'común'}` }, warnings);
  if (ceiling) alsoOk = alsoOk.filter((m) => rank(m) <= rank(ceiling) && m !== recommended);
  return { recommended, also_ok: alsoOk, origin };
}

/** Todo junto (lo que usan las pruebas y quien quiera una sola llamada). */
function resolveModels({ org, requests, costTier, tierOf, set, iter, agentsDir, flags, heavy, modelQuestion, band, today } = {}) {
  const warnings = [];
  const out = {
    reviewers: (() => {
      LOOKUP_PROBLEMS.clear();
      const r = resolveReviewers({ org, requests, costTier, tierOf, set, iter, agentsDir, warnings });
      for (const m of LOOKUP_PROBLEMS) warnings.push({ key: 'agents-lookup', message: m });
      return r;
    })(),
    adversarial: resolveAdversarial({ org, requests, flags, heavy, modelQuestion, warnings }),
    helpers: resolveHelpers({ org, requests, warnings }),
    ceiling: ceilingOf(org),
    warnings,
  };
  if (band && today) out.session = resolveSession({ org, band, today, warnings });
  return out;
}

/**
 * El nombre del modelo de la sesión, en familia: el de Claude (familia o id completo, con o sin `[1m]`) o el de Codex
 * (las equivalencias al revés). Sin reconocerlo, null.
 */
function normalizeSessionModel(name, equivalences = {}) {
  if (!name || typeof name !== 'string') return null;
  const n = name.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  if (isModel(n)) return n;
  for (const [fam, slug] of Object.entries(equivalences || {})) if (String(slug).toLowerCase() === n && isModel(fam)) return fam;
  const m = n.match(/^claude-(haiku|sonnet|opus|fable)\b/);
  return m ? m[1] : null;
}

/** El pedido del dev para un trabajo: `<trabajo>` válido (un trabajo o un nombre de revisor). */
function isJobName(job) {
  return JOBS.includes(job) || REVIEWER_NAME.test(String(job || ''));
}

/**
 * La configuración `models` de la organización, leída de `<dir>/team-repos.json` con el `team-repos.js` que se le pasa
 * (el del árbol que se está leyendo). → `{ declared, data, problem }`; nunca tira. `problem` = la línea «no pude leer…»:
 * un archivo que no es JSON, `sectionProblems.models`, o un lector que rechaza el archivo con `models` adentro. Sin
 * archivo o sin la clave: `declared: false` y sin problema (decisión 19: «no pude leer» nunca es «sin techo» callado).
 */
function readOrgModels({ dir, teamRepos } = {}) {
  const nada = { declared: false, data: null, problem: null };
  if (!dir) return nada;
  const file = path.join(dir, 'team-repos.json');
  let text = '';
  const decir = (primero) => {
    const techo = /mandatory_ceiling/.test(text) ? ': no sé si hay techo' : '';
    return { declared: false, data: null, problem: `no pude leer la configuración de la organización (${file}: ${primero}): uso los valores de hoy${techo}` };
  };
  // sin archivo no hay configuración; cualquier otro error al leerlo (permisos, una carpeta) se dice
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? nada : decir((e && e.code) || String((e && e.message) || e));
  }
  try {
    const TR = teamRepos || require(path.join(dir, 'scripts', 'lib', 'team-repos.js'));
    const r = TR.parse(String(text).replace(/^﻿/, ''));
    const sec = r.sectionProblems && r.sectionProblems.models;
    if (sec && sec.length) return decir(`${sec[0].path}: ${sec[0].message}`);
    if (!r.ok) {
      const conModels = r.problems.find((p) => p.path === 'models' || String(p.path).startsWith('models.'));
      if (r.problems[0] && r.problems[0].path === '' ) return decir(r.problems[0].message);
      if (conModels) return decir(`${conModels.path}: ${conModels.message}`);
      // el archivo entero no vale por un problema ajeno a models: si trae `models`, eso que declaró (un techo, quizás)
      // no se aplica, y se dice (un techo no se pierde en silencio)
      let crudo = null;
      try { crudo = JSON.parse(String(text).replace(/^﻿/, '')); } catch (_) { crudo = null; }
      if (crudo && typeof crudo === 'object' && !Array.isArray(crudo) && crudo.models !== undefined) {
        const p = r.problems[0];
        return decir(`${p.path || '(el archivo)'}: ${p.message}`);
      }
      return nada;   // sin models: un problema ajeno lo reclaman el instalador y los avisos de arranque
    }
    if (!r.data || r.data.models === undefined) return nada;
    return { declared: true, data: r.data.models, problem: null };
  } catch (e) {
    return decir(String((e && e.message) || e).split('\n')[0]);
  }
}

module.exports = {
  MODELS, DEFAULTS, TIERS, JOBS, rank, isModel, capAt, ceilingOf, frontmatterModel, defaultFor, reviewerExists,
  resolveReviewers, resolveAdversarial, resolveHelpers, resolveSession, resolveModels, normalizeSessionModel, isJobName,
  readOrgModels, agentsDirDefault,
};
