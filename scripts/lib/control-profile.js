'use strict';
/**
 * control-profile.js — el perfil por modelo: si un control frena para la sesión que pregunta, o si el dueño lo relajó
 * para el perfil de su modelo.
 *
 * Qué hace. Un freno que es una preferencia pregunta `decide({ control, sessionId })` antes de frenar. Contesta
 * `{ on: false }` sólo si se cumple todo:
 *   1. el perfil del equipo (`team-repos.json → control_profiles.relaxed`, del árbol del arnés) relaja ese control para
 *      un perfil, con `review_before` vigente;
 *   2. la clasificación (`scripts/metrics/controls-classification.json`, del mismo árbol) dice que el control es una
 *      preferencia y que está **firmada**: una exigencia no se relaja nunca, aunque el perfil la nombre, y lo avisa una
 *      vez por día;
 *   3. el modelo de la sesión se pudo leer (lib/session-model.js) y es de ese perfil.
 * Cualquier otra cosa —sin la sección, una sección con problemas, sin clasificación, sin modelo, un modelo fuera de los
 * perfiles, una relajación vencida— es `{ on: true }`: el freno decide como siempre. Nunca tira.
 *
 * Los perfiles: «fuertes» son los modelos `opus` y `fable`; «resto», cualquier otro modelo
 * que se pudo leer. Un modelo que no se pudo leer no es de ningún perfil.
 *
 * Por qué del perfil del equipo y no de una variable o de la carpeta de estado: el agente podría escribirlas y apagarse
 * un freno a sí mismo. El perfil cambia sólo por un pedido que aprueba una persona.
 *
 *   decide({ control, sessionId, tree, home, now }) → { on, motivo, perfil?, modelo?, aviso? }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FUERTES = ['opus', 'fable'];

/** El perfil de un modelo leído: «fuertes», «resto», o null si no hay modelo. */
function perfilDe(modelo) {
  if (!modelo || typeof modelo !== 'string') return null;
  const m = modelo.toLowerCase();
  return FUERTES.some((f) => m.includes(f)) ? 'fuertes' : 'resto';
}

const hoyDe = (now) => new Date(now).toISOString().slice(0, 10);
const treeDe = (tree, env) => tree || env.TYCON_TREE || ROOT;

function leerJson(ruta) {
  try { return { data: JSON.parse(fs.readFileSync(ruta, 'utf8').replace(/^﻿/, '')) }; } catch (e) {
    return { problem: e && e.code === 'ENOENT' ? 'no está' : `no se puede leer (${(e && e.code) || (e && e.message) || e})` };
  }
}

/** Las relajaciones vigentes de un control, del perfil del equipo; `[]` si no hay ninguna o la sección no vale. */
function relajacionesDe(control, tree) {
  let TR;
  try { TR = require(path.join(tree, 'scripts', 'lib', 'team-repos.js')); } catch (_) { TR = require('./team-repos.js'); }
  let texto;
  try { texto = fs.readFileSync(path.join(tree, 'team-repos.json'), 'utf8'); } catch (_) { return []; }
  const r = TR.parse(texto.replace(/^﻿/, ''));
  const sec = r && r.data && r.data.control_profiles;
  if (!sec || !Array.isArray(sec.relaxed)) return [];
  return sec.relaxed.filter((e) => e && e.control === control);
}

/** Avisa una sola vez por día y por control que el perfil nombra una exigencia. */
function avisoDiario(control, home, now) {
  let dir;
  try { dir = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(home); } catch (_) { dir = path.join(home, '.claude', '.tycon-pipeline'); }
  const marca = path.join(dir, `control-profile-exigencia-${hoyDe(now)}-${String(control).replace(/[^\w.-]/g, '_')}`);
  if (fs.existsSync(marca)) return null;
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(marca, ''); } catch (_) { /* sin marca, se vuelve a avisar */ }
  return `el perfil del equipo relaja ${control}, que es una exigencia: no se relaja para ningún modelo, sigue frenando`;
}

function decide({ control, sessionId, tree = null, home = os.homedir(), now = Date.now(), env = process.env, modelOf = null } = {}) {
  try {
    const raiz = treeDe(tree, env);
    const relajaciones = relajacionesDe(control, raiz);
    if (!relajaciones.length) return { on: true, motivo: 'el perfil del equipo no relaja este control' };
    const cls = leerJson(path.join(raiz, 'scripts', 'metrics', 'controls-classification.json'));
    const entrada = cls.data && cls.data[control];
    if (!entrada) return { on: true, motivo: `el control no tiene clasificación${cls.problem ? ` (la clasificación ${cls.problem})` : ''}` };
    if (entrada.tipo === 'exigencia') return { on: true, motivo: 'es una exigencia', aviso: avisoDiario(control, home, now) };
    if (entrada.tipo !== 'preferencia' || entrada.estado !== 'firmada') return { on: true, motivo: 'la clasificación de este control no está firmada como preferencia' };
    const hoy = hoyDe(now);
    const vigentes = relajaciones.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(String(e.review_before)) && e.review_before >= hoy);
    if (!vigentes.length) return { on: true, motivo: 'la relajación venció: vuelve a frenar hasta que el dueño la renueve' };
    const leer = modelOf || ((sid) => require('./session-model.js').modelOf(sid, { home }));
    const m = sessionId ? leer(sessionId) : { model: null, noMedido: 'sin sesión' };
    const modelo = m && m.model;
    if (!modelo) return { on: true, motivo: `no sé el modelo de la sesión (${(m && m.noMedido) || 'no medido'})` };
    const perfil = perfilDe(modelo);
    const vale = vigentes.find((e) => e.profile === perfil);
    if (!vale) return { on: true, motivo: `el modelo ${modelo} es del perfil ${perfil}, que no tiene este control relajado`, perfil, modelo };
    return { on: false, motivo: `relajado para el perfil ${perfil} hasta ${vale.review_before} (aprobó ${vale.approved_by})`, perfil, modelo };
  } catch (e) {
    return { on: true, motivo: `no pude leer el perfil por modelo (${String((e && e.message) || e).split('\n')[0]})` };
  }
}

module.exports = { decide, perfilDe, FUERTES };
