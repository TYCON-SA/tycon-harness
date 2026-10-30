'use strict';
/**
 * plan-review.js — la revisión automática del plan: la lanza la coordinadora sobre el plan de otra sesión, y
 * su veredicto «aprobado» es lo único con que ella puede aprobar un plan de rutina por delegación.
 *
 * Va en dos tiempos, porque el pase lo corre la herramienta Workflow (o workflow-lite.js), no este proceso:
 *   preparar → lee el plan y la story UNA vez, guarda sus huellas y si la story es delicada, y devuelve los args del
 *              pase en modo plan (adversarial-verify.workflow.js). El pedido queda en
 *              `plan-review/<sesión que lanza>/<destino>.pending.json`.
 *   anotar   → con el resultado del pase (o sin herramienta para correrlo): el veredicto, la constancia en
 *              `plan-review/<sesión que lanza>/<destino>.json` (temporal y renombre) y un renglón `plan-review` en gates.log
 *              con la huella de la constancia. Si el plan cambió mientras corría el pase, el veredicto es `sin-veredicto`.
 *
 * La constancia vive en la carpeta de la sesión que lanzó, nunca en la del destino. Al aprobar, `antesDeAprobar` la lee de
 * la carpeta de la sesión que firma, la contrasta con su renglón de gates.log y vuelve a calcular la huella del plan, la de
 * la story y si es delicada. Todas las sesiones corren con el mismo usuario del sistema: esto cierra el camino fácil, no
 * una falsificación coordinada de los dos archivos (el límite de toda la delegación, «Fuera de alcance» de la story).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CARPETA = 'plan-review';
const PLAN_FILE = 'step-02-bmad-plan.md';
const MODELO = 'opus';
const VEREDICTOS = Object.freeze(['aprobado', 'rechazado', 'sin-veredicto']);
const LA_COORDINADORA = 'la revisión automática la lanza la coordinadora';
const ESPERA = 'la revisión no dio aprobado: el plan espera a una persona';

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const SESION = /^[\w-]+$/;
const no = (motivo) => ({ codigo: 2, motivo });
const pipeline = () => require('../pipeline.js');

/**
 * El veredicto de un resultado del pase en modo plan: aprobado sólo medido y sin nada confirmado ni pendiente. Un
 * resultado que no es del modo plan, o que contradice su propio `veredicto`, queda sin veredicto.
 */
function veredictoDe(r) {
  if (!r || typeof r !== 'object' || r.medido !== true || r.modo !== 'plan') return 'sin-veredicto';
  const propio = calcular(r);
  if (r.veredicto !== undefined && r.veredicto !== propio) return 'sin-veredicto';
  return propio;
}
function calcular(r) {
  if ((r.hallazgos_sin_veredicto || 0) > 0 || (r.a_verificar_aparte || 0) > 0 || (Array.isArray(r.lentes_sin_medir) && r.lentes_sin_medir.length)) return 'sin-veredicto';
  if (!Array.isArray(r.confirmed)) return 'sin-veredicto';
  return r.confirmed.length ? 'rechazado' : 'aprobado';
}

function carpetaDe(estado, lanza) { return path.join(estado, CARPETA, lanza); }
function rutaConstancia(estado, lanza, destino) { return path.join(carpetaDe(estado, lanza), `${destino}.json`); }
function rutaPedido(estado, lanza, destino) { return path.join(carpetaDe(estado, lanza), `${destino}.pending.json`); }

function escribirDeUnaVez(archivo, texto) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, texto, { mode: 0o600 });
  fs.renameSync(tmp, archivo);
}

/** El marcador abierto de una sesión: null si no existe; lanza si existe y no se puede leer. */
function marcadorDe(estado, sid) {
  let texto;
  try { texto = fs.readFileSync(path.join(estado, 'active', `${sid}.json`), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`no pude leer el marcador de la sesión ${sid} (${e.code || e.message})`);
  }
  try { return JSON.parse(texto); } catch (e) { throw new Error(`no pude leer el marcador de la sesión ${sid} (${e.message})`); }
}

function storyDe(marker) {
  const raw = marker && marker.storyPath;
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.join(marker.repoPath || process.cwd(), raw);
}

/** El plan escrito de la corrida: `{ file, texto }`; `texto` es null si no está escrito. */
function planDe(marker) {
  const repo = (marker && marker.repoPath) || process.cwd();
  const runDir = pipeline().resolveRunDir(repo, String(marker.storyId), false, storyDe(marker) || undefined);
  if (!runDir) return { file: null, texto: null };
  const file = path.join(runDir, PLAN_FILE);
  let texto = null;
  let error = null;
  try { texto = fs.readFileSync(file, 'utf8'); } catch (e) { texto = null; if (e.code !== 'ENOENT') error = e.code || e.message; }
  return { file, texto, runDir, error };
}

const corridaDe = (m) => ({ storyId: String(m.storyId), startedAt: m.startedAt || null });

/** La sesión designada de la máquina (sin confirmar: la confirmación la mira la delegación), o null. */
function designadaDeVerdad(estado) {
  const d = require('./critical-waivers.js').designacionVigente({ dir: estado });
  return d && !d.error ? d.sesion : null;
}

/**
 * Prepara la revisión del plan de `destino`, pedida por `lanza`: `{ codigo: 0, args, pedido }` o `{ codigo: 2, motivo }`
 * sin escribir nada. `delegacion(o)` y `designada()` se inyectan en las pruebas.
 */
function preparar({ lanza, destino, estado, home, delegacion, designada } = {}) {
  if (!lanza || !SESION.test(lanza) || !destino || destino === lanza) return no(`${LA_COORDINADORA}, para otra sesión (--for-session <sesión destino>)`);
  if (!SESION.test(destino)) return no('la sesión destino no se puede leer');
  let d;
  try { d = designada ? designada() : designadaDeVerdad(estado); } catch (e) { return no(`${LA_COORDINADORA}: no pude leer la designación (${e.message})`); }
  if (d !== lanza) return no(`${LA_COORDINADORA}: esta sesión no es la designada`);
  const dele = delegacion || ((o) => require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'delegated-signing.js')).delegaSinVentana(o));
  let r;
  try { r = dele({ firma: 'plan-approval', sesion: lanza, destino, home, estado }); } catch (e) { return no(`${LA_COORDINADORA}: no pude consultar la delegación (${e.message})`); }
  if (!r || !r.ok) {
    const m = (r && r.motivo) || 'sin respuesta';
    return no(/no delega|sólo del dueño/.test(m) ? `el perfil no delega la aprobación del plan (${m})` : `${LA_COORDINADORA}: ${m}`);
  }
  let marker;
  try { marker = marcadorDe(estado, destino); } catch (e) { return no(e.message); }
  if (!marker) return no(`la sesión ${destino} no tiene una ejecución abierta`);
  let plan;
  try { plan = planDe(marker); } catch (e) { return no(`no pude encontrar el plan de la corrida (${e.message})`); }
  if (plan.error) return no(`no pude leer el plan de la corrida (${plan.file}: ${plan.error})`);
  if (!plan.texto || !plan.texto.trim()) return no(`no hay plan que revisar en la corrida de la sesión ${destino}${plan.file ? ` (${plan.file})` : ''}`);
  const storyFile = storyDe(marker);
  let storyTexto;
  try { storyTexto = fs.readFileSync(storyFile, 'utf8'); } catch (e) { return no(`no pude leer la story de la corrida (${storyFile}: ${e.code || e.message})`); }
  const delicate = pipeline().computeDelicate({ story: storyFile, repo: marker.repoPath, planText: plan.texto });
  // el número al azar que ata el resultado del pase a esta revisión: un resultado sin él, o con el de otra, no se anota
  const numero = crypto.randomBytes(16).toString('hex');
  const args = { modo: 'plan', repo: marker.repoPath || path.dirname(storyFile), storyTexto, planTexto: plan.texto, model: MODELO, runDir: plan.runDir, pedido: numero };
  const pedido = {
    numero, lanzo: lanza, destino, corrida: corridaDe(marker), storyId: String(marker.storyId), planFile: plan.file, storyFile,
    huellas: { plan: sha(plan.texto), story: sha(storyTexto) }, delicate, hora: new Date().toISOString(),
  };
  escribirDeUnaVez(rutaPedido(estado, lanza, destino), `${JSON.stringify(pedido, null, 2)}\n`);
  const argsFile = path.join(carpetaDe(estado, lanza), `${destino}.args.json`);
  escribirDeUnaVez(argsFile, `${JSON.stringify(args, null, 2)}\n`);
  return { codigo: 0, args, argsFile, pedido: rutaPedido(estado, lanza, destino), delicate };
}

/** El comando de workflow-lite.js que corre el pase en modo plan: `--args` lleva el texto JSON, no la ruta. */
function comandoLite(argsFile, out) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const sc = path.join(__dirname, '..');
  return `node ${q(path.join(sc, 'workflow-lite.js'))} ${q(path.join(sc, 'adversarial-verify.workflow.js'))} --args "$(cat ${q(argsFile)})" --out ${q(out)}`;
}

/**
 * Anota el resultado de la revisión preparada: devuelve la constancia escrita, o `{ codigo: 2, motivo }` si no hay pedido.
 * `resultado`: lo que devolvió el pase en modo plan. `sinHerramienta`: el motivo de no poder correrlo (sin veredicto).
 */
function anotar({ lanza, destino, estado, resultado, sinHerramienta, modelo = MODELO, proveedor = 'anthropic', ahora = Date.now() } = {}) {
  const fp = rutaPedido(estado, lanza, destino);
  let pedido;
  try { pedido = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {
    return no(e.code === 'ENOENT' ? `no hay una revisión preparada por esta sesión para ${destino}: primero marker.js plan-review --for-session ${destino}` : `no pude leer el pedido de la revisión (${e.message})`);
  }
  let veredicto = sinHerramienta ? 'sin-veredicto' : veredictoDe(resultado);
  let motivo = sinHerramienta ? `sin herramienta para correr el pase: ${sinHerramienta}` : (veredicto === 'sin-veredicto' ? 'el pase no midió todo' : null);
  if (!sinHerramienta && resultado && (!pedido.numero || resultado.pedido !== pedido.numero)) { veredicto = 'sin-veredicto'; motivo = 'el resultado no es el de esta revisión'; }
  let ahoraPlan = null;
  try { ahoraPlan = fs.readFileSync(pedido.planFile, 'utf8'); } catch (_) { ahoraPlan = null; }
  if (ahoraPlan === null || sha(ahoraPlan) !== pedido.huellas.plan) { veredicto = 'sin-veredicto'; motivo = 'el plan cambió mientras corría la revisión'; }
  const confirmados = (!sinHerramienta && resultado && Array.isArray(resultado.confirmed)) ? resultado.confirmed : [];
  const constancia = {
    id: sha(`${lanza}|${destino}|${ahora}`).slice(0, 12),
    veredicto, motivo,
    hallazgos: confirmados.map((h) => ({ lente: h.lens || null, severidad: h.adjusted_severity || h.severity || null, archivo: h.file || null, linea: h.line ?? null, resumen: h.summary || '' })),
    modelo, proveedor, hora: new Date(ahora).toISOString(), lanzo: lanza, destino,
    corrida: pedido.corrida, storyId: pedido.storyId, huellas: pedido.huellas, delicate: pedido.delicate,
  };
  const texto = `${JSON.stringify(constancia, null, 2)}\n`;
  escribirDeUnaVez(rutaConstancia(estado, lanza, destino), texto);
  try { fs.unlinkSync(fp); } catch (_) { /* ya no estaba */ }
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify({ ts: new Date(ahora).toISOString(), name: 'plan-review', status: 'ok', sesion: lanza, destino, story: pedido.storyId, veredicto, huella: sha(texto) })}\n`);
  return constancia;
}

const CAMPOS = ['veredicto', 'lanzo', 'destino', 'corrida', 'storyId', 'huellas', 'delicate', 'hora'];
/** La constancia de `lanza` sobre `destino`: `{ ok, constancia, texto }`, `{ ok: false, ausente }` o `{ ok: false, motivo }`. */
function leerConstancia({ estado, lanza, destino }) {
  let texto;
  try { texto = fs.readFileSync(rutaConstancia(estado, lanza, destino), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { ok: false, ausente: true } : { ok: false, motivo: e.code || e.message };
  }
  let c;
  try { c = JSON.parse(texto); } catch (e) { return { ok: false, motivo: e.message }; }
  const falta = CAMPOS.find((k) => !c || c[k] == null);
  if (falta) return { ok: false, motivo: `le falta «${falta}»` };
  if (!VEREDICTOS.includes(c.veredicto) || !c.huellas.plan || !c.huellas.story || typeof c.delicate.value !== 'boolean') return { ok: false, motivo: 'tiene campos que no se pueden leer' };
  return { ok: true, constancia: c, texto };
}

/**
 * La constancia más nueva sobre `destino`, de cualquier sesión que la haya lanzado (la que muestra `next`), o null. Si
 * alguna no se puede leer, lo dice en `aviso`: la que se muestra puede no ser la última.
 */
function ultimaDelDestino({ estado, destino }) {
  let lanzadores = [];
  try { lanzadores = fs.readdirSync(path.join(estado, CARPETA)); } catch (e) {
    return e.code === 'ENOENT' ? null : { aviso: `no pude leer las revisiones (${e.code || e.message})` };
  }
  let mejor = null;
  const ilegibles = [];
  for (const l of lanzadores) {
    const r = leerConstancia({ estado, lanza: l, destino });
    if (r.ok) { if (!mejor || Date.parse(r.constancia.hora) > Date.parse(mejor.hora)) mejor = r.constancia; } else if (!r.ausente) ilegibles.push(l);
  }
  if (!ilegibles.length) return mejor;
  return { ...(mejor || {}), aviso: `hay ${ilegibles.length} constancia ilegible (de ${ilegibles.join(', ')}): la que se muestra puede no ser la última` };
}

/** ¿La constancia tiene su renglón en gates.log, con la misma huella? */
function tieneRenglon(estado, firmante, destino, texto) {
  let lineas = [];
  try { lineas = fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n'); } catch (_) { return false; }
  const h = sha(texto);
  return lineas.some((l) => { try { const j = JSON.parse(l); return j.name === 'plan-review' && j.sesion === firmante && j.destino === destino && j.huella === h; } catch (_) { return false; } });
}

/**
 * Las condiciones de la aprobación del plan por delegación (AC 8 a 10 y 17): `{ codigo: 2, motivo }` para no firmar (el
 * pedido no se gasta), o `{ codigo: 0, via: 'revision', constancia }`. Primero si la story es delicada; después la
 * constancia. Todo se vuelve a calcular ahora: el plan, la story y si es delicada.
 */
function antesDeAprobar({ estado, firmante, destino, marker }) {
  const plan = planDe(marker);
  const storyFile = storyDe(marker);
  let storyTexto = null;
  try { storyTexto = fs.readFileSync(storyFile, 'utf8'); } catch (_) { storyTexto = null; }
  const delicate = pipeline().computeDelicate({ story: storyFile, repo: marker.repoPath, planText: plan.texto || '' });
  if (delicate.value) return no(`plan delicado (nivel 2): lo aprueba el dev, no la coordinadora (${delicate.reason})`);
  const r = leerConstancia({ estado, lanza: firmante, destino });
  if (!r.ok && r.ausente) return no(`no hay una revisión automática de este plan lanzada por esta sesión (marker.js plan-review --for-session ${destino}): ${ESPERA}`);
  if (!r.ok) return no(`la constancia de la revisión no se puede leer (${r.motivo}): ${ESPERA}`);
  const c = r.constancia;
  if (c.lanzo !== firmante || c.destino !== destino) return no(`la revisión la lanzó otra sesión (${c.lanzo}), no la que firma: ${ESPERA}`);
  if (!tieneRenglon(estado, firmante, destino, r.texto)) return no(`la constancia de la revisión no tiene su renglón en gates.log: ${ESPERA}`);
  const hoy = corridaDe(marker);
  if (c.storyId !== hoy.storyId || c.corrida.storyId !== hoy.storyId || c.corrida.startedAt !== hoy.startedAt) return no(`la revisión es de otra corrida (${c.corrida.storyId}, ${c.corrida.startedAt}): ${ESPERA}`);
  if (!plan.texto || sha(plan.texto) !== c.huellas.plan) return no(`el plan cambió después de la revisión: ${ESPERA}`);
  if (storyTexto === null || sha(storyTexto) !== c.huellas.story) return no(`la story cambió después de la revisión: ${ESPERA}`);
  if (c.delicate.value !== delicate.value) return no(`la story era delicada cuando se revisó y ya no lo es: ${ESPERA}`);
  if (c.veredicto !== 'aprobado') return no(`${ESPERA} (la revisión dijo ${c.veredicto})`);
  return { codigo: 0, via: 'revision', constancia: c };
}

/** Lo que la aprobación del plan comprueba con el pedido sin gastar: sólo por delegación; la ventana y la terminal, no. */
function antesDelPlan({ via, ...o }) {
  return via === 'delegacion' ? antesDeAprobar(o) : null;
}

module.exports = { CARPETA, VEREDICTOS, veredictoDe, comandoLite, preparar, anotar, leerConstancia, ultimaDelDestino, antesDeAprobar, antesDelPlan, planDe, rutaConstancia };
