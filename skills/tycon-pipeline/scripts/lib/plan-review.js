'use strict';
/**
 * plan-review.js — la revisión automática del plan. La lanza la coordinadora sobre el plan de otra sesión, y su veredicto
 * «aprobado» es lo único con que ella puede aprobar un plan de rutina por delegación. La propia sesión también la puede
 * lanzar sobre su plan, pero esa revisión es informativa: sólo informa, nunca firma.
 *
 * Va en dos tiempos, porque el pase lo corre la herramienta Workflow (o workflow-lite.js), no este proceso:
 *   preparar → lee el plan y la story UNA vez, guarda sus huellas y si la story es delicada, y devuelve los args del
 *              pase en modo plan (adversarial-verify.workflow.js), con las lentes, los verificadores y el corte de
 *              gravedad de la organización. El pedido queda en `plan-review/<sesión que lanza>/<destino>.pending.json`.
 *   anotar   → con el resultado del pase (o sin herramienta para correrlo): el veredicto, la constancia en
 *              `plan-review/<sesión que lanza>/<destino>.json` (temporal y renombre) y un renglón `plan-review` en gates.log
 *              con la huella de la constancia, la del plan, los hallazgos, la corrida y si es informativa. Si el plan
 *              cambió mientras corría el pase, el veredicto es `sin-veredicto` y se pide un reintento, una sola vez.
 *
 * La constancia vive en la carpeta de la sesión que lanzó, nunca en la del destino. Al aprobar, `antesDeAprobar` la lee de
 * la carpeta de la sesión que firma, la contrasta con su renglón de gates.log y vuelve a calcular la huella del plan, la de
 * la story y si es delicada. Todas las sesiones corren con el mismo usuario del sistema: esto cierra el camino fácil, no
 * una falsificación coordinada de los dos archivos (el límite de toda la delegación).
 *
 * La pregunta de si revisar y su respuesta quedan en gates.log (`review-ask`, `review-answer`): los minutos sin respuesta
 * se cuentan desde la pregunta, y «seguir sin revisión» sobre un plan hace que la delegación no lo firme.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CARPETA = 'plan-review';
const PLAN_FILE = 'step-02-bmad-plan.md';
const MODELO = 'opus';
const VEREDICTOS = Object.freeze(['aprobado', 'aprobado-con-notas', 'rechazado', 'sin-veredicto']);
const APROBADOS = Object.freeze(['aprobado', 'aprobado-con-notas']);
const LA_COORDINADORA = 'la revisión automática para otra sesión la lanza la coordinadora';
const ESPERA = 'la revisión no dio aprobado: el plan espera a una persona';
const CAMBIO = 'el plan cambió mientras corría la revisión';
const KINDS = Object.freeze(['plan', 'code']);
const CHOICES = Object.freeze(['review', 'skip', 'wait']);

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const SESION = /^[\w-]+$/;
const no = (motivo) => ({ codigo: 2, motivo });
const pipeline = () => require('../pipeline.js');
const policy = () => require('./review-policy.js');
const RAIZ = path.join(__dirname, '..', '..', '..', '..');

/**
 * La configuración de la organización para las revisiones: `{ values, problems, raw }`. `values` sale de
 * `review-policy.normalize` (con los valores de fábrica clave por clave). Sin arnés o sin archivo, la de fábrica.
 */
function configDeLaOrganizacion({ leer } = {}) {
  let raw = null;
  const problems = [];
  try {
    if (leer) raw = leer();
    else {
      const TCG = require('./harness-path.js').rutaArnes();
      const file = path.join(TCG, 'team-repos.json');
      if (fs.existsSync(file)) {
        const r = require(path.join(RAIZ, 'scripts', 'lib', 'team-repos.js')).parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
        raw = r && r.data ? r.data : null;
        // el lector ya sacó cada clave mala de `data`: sus problemas se dicen acá, porque normalize ya no las ve
        const sp = (r && r.sectionProblems) || {};
        for (const sec of ['plan_review', 'review', 'review_runner', 'deep_review']) {
          for (const p of sp[sec] || []) problems.push({ path: p.path, message: `${p.message}; uso el valor de fábrica` });
        }
      }
    }
  } catch (e) {
    problems.push({ path: 'team-repos.json', message: `no pude leer la configuración de la organización (${String((e && e.message) || e).split('\n')[0]}): uso la de fábrica` });
  }
  const n = policy().normalize(raw || {});
  return { values: n.values, problems: [...problems, ...n.problems], raw };
}

/**
 * El veredicto de un resultado del pase en modo plan, con el corte de gravedad: «rechazado» sólo con un confirmado en
 * el corte o por encima; los demás confirmados dan «aprobado-con-notas». Medido y sin nada pendiente; un resultado que
 * no es del modo plan, o que contradice su propio `veredicto`, queda sin veredicto.
 */
function veredictoDe(r, corte = 'all') {
  if (!r || typeof r !== 'object' || r.medido !== true || r.modo !== 'plan') return 'sin-veredicto';
  const propio = calcular(r, corte);
  if (r.veredicto !== undefined && r.veredicto !== propio) return 'sin-veredicto';
  return propio;
}
function calcular(r, corte) {
  if ((r.hallazgos_sin_veredicto || 0) > 0 || (r.a_verificar_aparte || 0) > 0 || (Array.isArray(r.lentes_sin_medir) && r.lentes_sin_medir.length)) return 'sin-veredicto';
  if (!Array.isArray(r.confirmed)) return 'sin-veredicto';
  const { blocks } = policy();
  if (r.confirmed.some((c) => blocks(c && (c.adjusted_severity || c.severity), corte))) return 'rechazado';
  return r.confirmed.length ? 'aprobado-con-notas' : 'aprobado';
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

/**
 * La parte de la corrida (la tanda que anotó `set-batch`), como la ve la revisión del plan: `{ nombre, valida, files,
 * huella }`, o null sin parte. Se vuelve a calcular con la historia de ahora: la del marcador no se usa para medir.
 */
function parteDe(marker, storyTexto) {
  if (!marker || !marker.batch) return null;
  const scope = require('./batch-scope.js');
  const p = scope.validarParte(storyTexto || '', marker.batch);
  const files = p.files || [];
  return { nombre: String(marker.batch), valida: !!(p.valid && !p.done), files, huella: scope.huellaDeLaLista(files) };
}
/** El argumento de la parte para medir la delicada: sólo si vale. */
const batchDe = (parte) => (parte && parte.valida ? parte.nombre : undefined);
const mismaParte = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

const corridaDe = (m) => ({ storyId: String(m.storyId), startedAt: m.startedAt || null });
const mismaCorrida = (a, b) => !!(a && b && a.storyId === b.storyId && a.startedAt === b.startedAt);

/** La sesión designada de la máquina (sin confirmar: la confirmación la mira la delegación), o null. */
function designadaDeVerdad(estado) {
  const d = require('./critical-waivers.js').designacionVigente({ dir: estado });
  return d && !d.error ? d.sesion : null;
}

/** Los renglones de gates.log, ya leídos (los que no se pueden leer no cuentan). */
function renglones(estado) {
  let lineas = [];
  try { lineas = fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n'); } catch (_) { return []; }
  const out = [];
  for (const l of lineas) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (_) { /* un renglón roto no cuenta */ } }
  return out;
}

const anotarRenglon = (estado, r, ahora = Date.now()) => {
  fs.mkdirSync(estado, { recursive: true });
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify({ ts: new Date(ahora).toISOString(), ...r })}\n`);
};

/**
 * Prepara la revisión del plan de `destino`, pedida por `lanza`: `{ codigo: 0, args, pedido, informativa }` o
 * `{ codigo: 2, motivo }` sin escribir nada. Sin `destino` (o con el propio), la propia sesión prepara una revisión
 * informativa de su plan. Para otra sesión, sólo la designada. Lanzar no pide la delegación: se mira al firmar.
 * `designada()` y `config` se inyectan en las pruebas.
 */
function preparar({ lanza, destino, estado, designada, config } = {}) {
  if (!lanza || !SESION.test(lanza)) return no('falta la sesión que lanza la revisión');
  const informativa = !destino || destino === lanza;
  const dest = informativa ? lanza : destino;
  if (!SESION.test(dest)) return no('la sesión destino no se puede leer');
  if (!informativa) {
    let d;
    try { d = designada ? designada() : designadaDeVerdad(estado); } catch (e) { return no(`${LA_COORDINADORA}: no pude leer la designación (${e.message})`); }
    if (d !== lanza) return no(`${LA_COORDINADORA}: esta sesión no es la designada (sin --for-session, la propia sesión prepara una revisión informativa de su plan)`);
  }
  let marker;
  try { marker = marcadorDe(estado, dest); } catch (e) { return no(e.message); }
  if (!marker) return no(`la sesión ${dest} no tiene una ejecución abierta`);
  let plan;
  try { plan = planDe(marker); } catch (e) { return no(`no pude encontrar el plan de la corrida (${e.message})`); }
  if (plan.error) return no(`no pude leer el plan de la corrida (${plan.file}: ${plan.error})`);
  if (!plan.texto || !plan.texto.trim()) return no(`no hay plan que revisar en la corrida de la sesión ${dest}${plan.file ? ` (${plan.file})` : ''}`);
  const storyFile = storyDe(marker);
  let storyTexto;
  try { storyTexto = fs.readFileSync(storyFile, 'utf8'); } catch (e) { return no(`no pude leer la story de la corrida (${storyFile}: ${e.code || e.message})`); }
  // la parte: el revisor la ve con su lista, y la delicada se mide con ella si vale
  const parte = parteDe(marker, storyTexto);
  const delicate = pipeline().computeDelicate({ story: storyFile, repo: marker.repoPath, planText: plan.texto, batch: batchDe(parte) });
  const cfg = config || configDeLaOrganizacion().values;
  // el número al azar que ata el resultado del pase a esta revisión: un resultado sin él, o con el de otra, no se anota
  const numero = crypto.randomBytes(16).toString('hex');
  const corte = cfg.review.blocking_severity;
  const args = { modo: 'plan', repo: marker.repoPath || path.dirname(storyFile), storyTexto, planTexto: plan.texto, model: MODELO, runDir: plan.runDir, pedido: numero,
    lenses: cfg.plan_review.lenses.slice(), verifiers: cfg.review_runner.verifiers, blocking_severity: corte, ...(parte ? { parte } : {}) };
  const pedido = {
    numero, lanzo: lanza, destino: dest, informativa, corte, corrida: corridaDe(marker), storyId: String(marker.storyId), planFile: plan.file, storyFile,
    huellas: { plan: sha(plan.texto), story: sha(storyTexto) }, delicate, hora: new Date().toISOString(), ...(parte ? { parte } : {}),
  };
  escribirDeUnaVez(rutaPedido(estado, lanza, dest), `${JSON.stringify(pedido, null, 2)}\n`);
  const argsFile = path.join(carpetaDe(estado, lanza), `${dest}.args.json`);
  escribirDeUnaVez(argsFile, `${JSON.stringify(args, null, 2)}\n`);
  return { codigo: 0, args, argsFile, pedido: rutaPedido(estado, lanza, dest), delicate, informativa, destino: dest };
}

/**
 * El comando de workflow-lite.js que corre el pase en modo plan: `--args` lleva el texto JSON, no la ruta. Con la lista
 * de corredores de la organización (`order`), la nombra; el comentario dice con qué revisor corre.
 */
function comandoLite(argsFile, out, { order, integration } = {}) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const sc = path.join(__dirname, '..');
  let lista = order;
  let integ = integration;
  if (!lista || !integ) {
    try {
      const RR = require('./review-runner.js');
      if (!integ) integ = RR.loadIntegration();
      if (!lista) lista = RR.runnerOrder(configDeLaOrganizacion().raw).order;
    } catch (_) { /* sin la lista, el comando corre con la de la organización que lea workflow-lite */ }
  }
  const nombres = Array.isArray(lista) && lista.length ? lista : null;
  const labels = nombres ? nombres.map((n) => (integ && integ.runners && integ.runners[n] && integ.runners[n].label) || n) : [];
  return `node ${q(path.join(sc, 'workflow-lite.js'))} ${q(path.join(sc, 'adversarial-verify.workflow.js'))} --args "$(cat ${q(argsFile)})" --out ${q(out)}` +
    (nombres ? ` --runners ${nombres.join(',')}  # revisor: ${labels.join(', luego ')}` : '');
}

/** Los renglones `plan-review` de un destino y una corrida, en orden. */
function revisionesDe(estado, destino, corrida) {
  return renglones(estado).filter((j) => j.name === 'plan-review' && j.destino === destino && mismaCorrida(j.corrida, corrida));
}

/**
 * Anota el resultado de la revisión preparada: devuelve la constancia escrita, o `{ codigo: 2, motivo }` si no hay pedido.
 * `resultado`: lo que devolvió el pase en modo plan. `sinHerramienta`: el motivo de no poder correrlo (sin veredicto).
 */
function anotar({ lanza, destino, estado, resultado, sinHerramienta, modelo = MODELO, proveedor = 'anthropic', ahora = Date.now() } = {}) {
  const dest = destino || lanza;
  const fp = rutaPedido(estado, lanza, dest);
  let pedido;
  try { pedido = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {
    return no(e.code === 'ENOENT' ? `no hay una revisión preparada por esta sesión para ${dest}: primero marker.js plan-review${dest === lanza ? '' : ` --for-session ${dest}`}` : `no pude leer el pedido de la revisión (${e.message})`);
  }
  const corte = pedido.corte || 'all';
  let veredicto = sinHerramienta ? 'sin-veredicto' : veredictoDe(resultado, corte);
  let motivo = sinHerramienta ? `sin herramienta para correr el pase: ${sinHerramienta}` : (veredicto === 'sin-veredicto' ? 'el pase no midió todo' : null);
  if (!sinHerramienta && resultado && (!pedido.numero || resultado.pedido !== pedido.numero)) { veredicto = 'sin-veredicto'; motivo = 'el resultado no es el de esta revisión'; }
  let ahoraPlan = null;
  try { ahoraPlan = fs.readFileSync(pedido.planFile, 'utf8'); } catch (_) { ahoraPlan = null; }
  let reintentar = false;
  if (ahoraPlan === null || sha(ahoraPlan) !== pedido.huellas.plan) {
    veredicto = 'sin-veredicto';
    motivo = CAMBIO;
    // se reintenta una sola vez por corrida sobre el plan cerrado; la segunda llega al dueño con este motivo
    reintentar = !revisionesDe(estado, dest, pedido.corrida).some((j) => j.motivo === CAMBIO);
  }
  const confirmados = (!sinHerramienta && resultado && Array.isArray(resultado.confirmed)) ? resultado.confirmed : [];
  const { blocks } = policy();
  const aHallazgo = (h) => ({ lente: h.lens || null, severidad: h.adjusted_severity || h.severity || null, archivo: h.file || null, linea: h.line ?? null, resumen: h.summary || '' });
  const constancia = {
    id: sha(`${lanza}|${dest}|${ahora}`).slice(0, 12),
    veredicto, motivo, informativa: !!pedido.informativa,
    hallazgos: confirmados.filter((h) => blocks(h.adjusted_severity || h.severity, corte)).map(aHallazgo),
    notas: confirmados.filter((h) => !blocks(h.adjusted_severity || h.severity, corte)).map(aHallazgo),
    corte, modelo, proveedor, hora: new Date(ahora).toISOString(), lanzo: lanza, destino: dest,
    corrida: pedido.corrida, storyId: pedido.storyId, huellas: pedido.huellas, delicate: pedido.delicate,
    // la parte y su lista, congeladas: el portón lee de acá la lista que vale con el plan aprobado por delegación
    ...(pedido.parte ? { parte: pedido.parte } : {}),
  };
  const texto = `${JSON.stringify(constancia, null, 2)}\n`;
  escribirDeUnaVez(rutaConstancia(estado, lanza, dest), texto);
  try { fs.unlinkSync(fp); } catch (_) { /* ya no estaba */ }
  anotarRenglon(estado, {
    name: 'plan-review', status: 'ok', sesion: lanza, destino: dest, story: pedido.storyId, veredicto, motivo, huella: sha(texto),
    huellaPlan: pedido.huellas.plan, hallazgos: constancia.hallazgos.length, notas: constancia.notas.length, corrida: pedido.corrida, informativa: !!pedido.informativa,
  }, ahora);
  return reintentar ? { ...constancia, reintentar: true } : constancia;
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
 * La constancia más nueva sobre `destino`, de cualquier sesión que la haya lanzado (la que muestra `next` y el cuadro),
 * o null. Si alguna no se puede leer, lo dice en `aviso`: la que se muestra puede no ser la última.
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

/** ¿La constancia tiene su renglón en gates.log, con la misma huella y sin ser informativa? */
function tieneRenglon(estado, firmante, destino, texto) {
  const h = sha(texto);
  return renglones(estado).some((j) => j.name === 'plan-review' && j.sesion === firmante && j.destino === destino && j.huella === h && j.informativa !== true);
}

// ── la pregunta de si revisar, y su respuesta ─────────────────────────────────────────────────────────────────────

/**
 * La huella de lo que se pregunta revisar en la corrida de `sesion`: el plan escrito (`plan`) o el diff contra HEAD del
 * repo de la corrida (`code`). `{ huella }` o `{ codigo: 2, motivo }`.
 */
function huellaDe({ estado, sesion, kind }) {
  if (!KINDS.includes(kind)) return no(`--kind es ${KINDS.join(' o ')}`);
  let marker;
  try { marker = marcadorDe(estado, sesion); } catch (e) { return no(e.message); }
  if (!marker) return no(`la sesión ${sesion} no tiene una ejecución abierta`);
  if (kind === 'plan') {
    let plan;
    try { plan = planDe(marker); } catch (e) { return no(`no pude encontrar el plan de la corrida (${e.message})`); }
    if (!plan.texto || !plan.texto.trim()) return no(`no hay plan escrito en la corrida de la sesión ${sesion}`);
    return { codigo: 0, huella: sha(plan.texto) };
  }
  // el error se reconoce por el texto: git va con el idioma fijo
  const env = require(path.join(RAIZ, 'scripts', 'lib', 'clean-git-env.js')).idiomaFijo();
  const git = (base) => require('child_process').spawnSync('git', ['-C', marker.repoPath || process.cwd(), 'diff', base], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  let r = git('HEAD');
  // un repo sin commits no tiene HEAD: el diff se mide contra el árbol vacío, para que la pregunta se pueda contestar
  if (r.status !== 0 && /unknown revision|ambiguous argument 'HEAD'/.test(r.stderr || '')) r = git('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  if (r.status !== 0) return no(`no pude leer el diff del repo de la corrida (${(r.stderr || '').trim().split('\n')[0] || r.status})`);
  return { codigo: 0, huella: sha(r.stdout) };
}

/** Anota la pregunta de si revisar (`kind`: plan o code) sobre la huella del plan o del diff. */
function anotarPregunta({ estado, sesion, kind, huella, ahora = Date.now() }) {
  if (!KINDS.includes(kind)) return no(`--kind es ${KINDS.join(' o ')}`);
  if (!huella) return no('falta la huella del plan o del diff');
  anotarRenglon(estado, { name: 'review-ask', status: 'ok', sesion, kind, huella }, ahora);
  return { codigo: 0 };
}

/** Anota la respuesta: la elección (`review`, `skip`, `wait`) y quién contestó. */
function anotarRespuesta({ estado, sesion, kind, choice, quien, huella, motivo = null, ahora = Date.now() }) {
  if (!KINDS.includes(kind)) return no(`--kind es ${KINDS.join(' o ')}`);
  if (!CHOICES.includes(choice)) return no(`--choice es ${CHOICES.join(', ')}`);
  anotarRenglon(estado, { name: 'review-answer', status: 'ok', sesion, kind, choice, quien, huella: huella || null, motivo }, ahora);
  return { codigo: 0 };
}

/** Las preguntas sin respuesta: `[{ sesion, kind, huella, ts }]`, la más vieja primero. */
function preguntasAbiertas({ estado }) {
  const abiertas = new Map();
  for (const j of renglones(estado)) {
    const clave = `${j.sesion}|${j.kind}`;
    if (j.name === 'review-ask') abiertas.set(clave, { sesion: j.sesion, kind: j.kind, huella: j.huella, ts: j.ts });
    else if (j.name === 'review-answer' && abiertas.has(clave)) abiertas.delete(clave);
  }
  return [...abiertas.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** La última respuesta (`review`, `skip` o `wait`) de la pregunta de una sesión sobre esa huella, o null. */
function respuestaDe({ estado, sesion, kind, huella }) {
  const r = renglones(estado).filter((j) => j.name === 'review-answer' && j.kind === kind && j.sesion === sesion && j.huella === huella);
  return r.length ? r[r.length - 1].choice : null;
}

/** ¿Para este plan (su huella) se eligió seguir sin revisión? La última respuesta sobre esa huella manda. */
function eligioSeguir({ estado, destino, huellaPlan }) {
  const r = renglones(estado).filter((j) => j.name === 'review-answer' && j.kind === 'plan' && j.sesion === destino && j.huella === huellaPlan);
  return r.length ? r[r.length - 1].choice === 'skip' : false;
}

/**
 * Los rechazos seguidos de la corrida, contados en los renglones `plan-review`: uno por huella de plan; un «aprobado»
 * (o con notas) pone la cuenta en cero; un «sin veredicto» no suma ni la pone en cero. Las informativas cuentan: sin
 * coordinadora son la única revisión, y el tope tiene que poder llegar al dueño igual.
 */
function rechazosSeguidos({ estado, destino, corrida }) {
  let huellas = new Set();
  for (const j of revisionesDe(estado, destino, corrida)) {
    if (APROBADOS.includes(j.veredicto)) huellas = new Set();
    else if (j.veredicto === 'rechazado' && j.huellaPlan) huellas.add(j.huellaPlan);
  }
  return huellas.size;
}

/**
 * El tope de rechazos seguidos: el mismo número que las vueltas de revisores del código. El `review.max_rounds` del
 * `.tycon/advisors.yaml` commiteado del repo manda; si no lo trae o no se puede leer, el de la organización.
 */
function topeDeRechazos(cfg, repo) {
  if (repo) {
    try {
      const RR = require('./review-rounds.js');
      const v = RR.delYaml(require('./config-source.js').leerCommiteado(repo));
      const n = Number(v);
      if (v !== undefined && Number.isInteger(n) && n >= RR.MINIMO && n <= RR.MAXIMO) return n;
    } catch (_) { /* sin el ajuste del repo vale el de la organización, el mismo que usan las vueltas del código */ }
  }
  return cfg.review.max_rounds;
}

/** Cuántos hallazgos sumaron los rechazos de la corrida (la N de «N hallazgos corregidos»). */
function hallazgosCorregidos({ estado, destino, corrida }) {
  return revisionesDe(estado, destino, corrida).filter((j) => j.veredicto === 'rechazado').reduce((s, j) => s + (Number(j.hallazgos) || 0), 0);
}

/**
 * La línea del cuadro de la firma con el resultado de la revisión de este plan, y las notas o hallazgos que la siguen.
 * `{ linea, detalle: [] }`.
 */
function lineaDelCuadro({ estado, destino, marker, config }) {
  const cfg = config || configDeLaOrganizacion().values;
  const plan = planDe(marker);
  const huellaPlan = plan.texto ? sha(plan.texto) : null;
  const corrida = corridaDe(marker);
  if (huellaPlan && eligioSeguir({ estado, destino, huellaPlan })) return { linea: 'sin revisión (se eligió seguir)', detalle: [] };
  const c = ultimaDelDestino({ estado, destino });
  const deEsta = c && c.veredicto && mismaCorrida(c.corrida, corrida) ? c : null;
  if (!deEsta) {
    const delicate = pipeline().computeDelicate({ story: storyDe(marker), repo: marker.repoPath, planText: plan.texto || '' });
    if (!delicate.value && cfg.plan_review.routine === 'never') return { linea: 'sin revisión (el perfil no revisa)', detalle: [] };
    return { linea: 'sin revisión (todavía no corrió sobre este plan)', detalle: [] };
  }
  if (!huellaPlan || deEsta.huellas.plan !== huellaPlan) return { linea: 'la revisión es de otra versión del plan', detalle: [] };
  const lista = (hs) => (hs || []).map((h) => `- [${h.lente || '?'}] ${h.resumen}`);
  if (deEsta.veredicto === 'sin-veredicto') return { linea: `no se pudo revisar: ${deEsta.motivo || 'el pase no midió todo'}`, detalle: [] };
  if (deEsta.veredicto === 'rechazado') {
    const n = rechazosSeguidos({ estado, destino, corrida });
    return { linea: `revisado, rechazado ${n} ${n === 1 ? 'vez' : 'veces seguidas'}`, detalle: lista(deEsta.hallazgos) };
  }
  const corregidos = hallazgosCorregidos({ estado, destino, corrida });
  const base = corregidos ? `revisado, ${corregidos} hallazgos corregidos` : 'revisado, sin hallazgos';
  if (deEsta.veredicto === 'aprobado-con-notas') {
    const k = (deEsta.notas || []).length;
    return { linea: `${base}; con ${k} ${k === 1 ? 'nota' : 'notas'} para implementar`, detalle: lista(deEsta.notas) };
  }
  return { linea: base, detalle: [] };
}

/**
 * Las condiciones de la aprobación del plan por delegación: `{ codigo: 2, motivo }` para no firmar (el pedido no se
 * gasta), o `{ codigo: 0, via: 'revision', constancia }`. Primero si la story es delicada y si el perfil deja que la
 * coordinadora apruebe; después la constancia. Todo se vuelve a calcular ahora: el plan, la story y si es delicada.
 * `delegacion(o)` (opcional) mira la delegación del perfil; sin ella, la miró antes el freno de la firma.
 */
function antesDeAprobar({ estado, firmante, destino, marker, config, delegacion, home }) {
  const plan = planDe(marker);
  const storyFile = storyDe(marker);
  let storyTexto = null;
  try { storyTexto = fs.readFileSync(storyFile, 'utf8'); } catch (_) { storyTexto = null; }
  const parte = parteDe(marker, storyTexto);
  const delicate = pipeline().computeDelicate({ story: storyFile, repo: marker.repoPath, planText: plan.texto || '', batch: batchDe(parte) });
  if (delicate.value) return no(`plan delicado (nivel 2): lo aprueba el dev, no la coordinadora (${delicate.reason})`);
  const cfg = config || configDeLaOrganizacion().values;
  if (!cfg.plan_review.coordinator_approves) return no(`el perfil no deja que la coordinadora apruebe el plan (plan_review.coordinator_approves: false): ${ESPERA}`);
  if (delegacion) {
    let d;
    try { d = delegacion({ firma: 'plan-approval', sesion: firmante, destino, home, estado }); } catch (e) { d = { ok: false, motivo: e.message }; }
    if (!d || !d.ok) return no(`el perfil no delega la aprobación del plan (${(d && d.motivo) || 'sin respuesta'}): ${ESPERA}`);
  }
  const r = leerConstancia({ estado, lanza: firmante, destino });
  if (!r.ok && r.ausente) return no(`no hay una revisión automática de este plan lanzada por esta sesión (marker.js plan-review --for-session ${destino}): ${ESPERA}`);
  if (!r.ok) return no(`la constancia de la revisión no se puede leer (${r.motivo}): ${ESPERA}`);
  const c = r.constancia;
  if (c.informativa === true || c.lanzo === c.destino) return no(`la revisión es informativa (la lanzó la propia sesión): sólo informa, nunca firma: ${ESPERA}`);
  if (c.lanzo !== firmante || c.destino !== destino) return no(`la revisión la lanzó otra sesión (${c.lanzo}), no la que firma: ${ESPERA}`);
  if (!tieneRenglon(estado, firmante, destino, r.texto)) return no(`la constancia de la revisión no tiene su renglón en gates.log: ${ESPERA}`);
  const hoy = corridaDe(marker);
  if (c.storyId !== hoy.storyId || c.corrida.storyId !== hoy.storyId || c.corrida.startedAt !== hoy.startedAt) return no(`la revisión es de otra corrida (${c.corrida.storyId}, ${c.corrida.startedAt}): ${ESPERA}`);
  if (!plan.texto || sha(plan.texto) !== c.huellas.plan) return no(`el plan cambió después de la revisión: ${ESPERA}`);
  if (storyTexto === null || sha(storyTexto) !== c.huellas.story) return no(`la story cambió después de la revisión: ${ESPERA}`);
  if (c.delicate.value !== delicate.value) return no(`la story era delicada cuando se revisó y ya no lo es: ${ESPERA}`);
  // la coordinadora aprueba lo que se revisó: la misma parte, igual de válida y con la misma lista
  if (!mismaParte(c.parte, parte)) return no(`la parte o su lista cambiaron desde la revisión (${c.parte ? c.parte.nombre : 'sin parte'} → ${parte ? parte.nombre : 'sin parte'}): ${ESPERA}`);
  if (eligioSeguir({ estado, destino, huellaPlan: c.huellas.plan })) return no(`para este plan se eligió seguir sin revisión: lo firma una persona`);
  if (!APROBADOS.includes(c.veredicto)) return no(`${ESPERA} (la revisión dijo ${c.veredicto})`);
  return { codigo: 0, via: 'revision', constancia: c };
}

/** Lo que la aprobación del plan comprueba con el pedido sin gastar: sólo por delegación; la ventana y la terminal, no. */
function antesDelPlan({ via, ...o }) {
  return via === 'delegacion' ? antesDeAprobar(o) : null;
}

/**
 * Qué toca con la revisión del plan de una sesión, al cerrar el plan (`next` en «Aprobar el plan»): `{ decision,
 * approves, reason, comando?, estado }`. `decision` sale de la matriz; si toca revisar y este plan no tiene revisión, el
 * comando para lanzarla (la coordinadora, si la hay; si no, la propia sesión, informativa). `ahora` y `config` se
 * inyectan en las pruebas.
 */
function accionDelPlan({ estado, sesion, marker, config, home, ahora = Date.now() }) {
  const cfg = config || configDeLaOrganizacion().values;
  const P = policy();
  const plan = planDe(marker);
  if (!plan.texto || !plan.texto.trim()) return { decision: null, reason: 'todavía no hay plan escrito' };
  const huellaPlan = sha(plan.texto);
  let storyTexto = '';
  try { storyTexto = fs.readFileSync(storyDe(marker), 'utf8'); } catch (_) { storyTexto = ''; }
  const delicate = pipeline().computeDelicate({ story: storyDe(marker), repo: marker.repoPath, planText: plan.texto, batch: batchDe(parteDe(marker, storyTexto)) });
  // lo que no se pudo leer se decide del lado conservador (sin coordinadora, dueño presente) y se dice en el motivo
  const avisos = [];
  let coordinadora = null;
  try { coordinadora = designadaDeVerdad(estado); } catch (e) { avisos.push(`no pude leer la designación de la coordinadora (${e.message}): cuenta como que no hay`); }
  const hayCoordinadora = !!coordinadora && coordinadora !== sesion;
  let marca = null;
  try {
    const leida = require(path.join(RAIZ, 'scripts', 'lib', 'owner-away.js')).get({ estado, home, ahora });
    marca = leida.mark;
    if (leida.problem) avisos.push(`${leida.problem}: la persona cuenta como presente`);
  } catch (e) { avisos.push(`no pude leer la marca de ausente (${e.message}): la persona cuenta como presente`); }
  const pregunta = preguntasAbiertas({ estado }).find((p) => p.sesion === sesion && p.kind === 'plan' && p.huella === huellaPlan);
  const away = P.ownerAway({ mark: marca, askedAt: pregunta ? Date.parse(pregunta.ts) : null, now: ahora, minutes: cfg.plan_review.owner_away_minutes });
  const r = P.planReview({ delicate: delicate.value, coordinator: hayCoordinadora, ownerAway: away.away, config: cfg });
  const out = { ...r, delicate: delicate.value, ownerAway: away, huellaPlan };
  if (avisos.length) { out.reason = `${out.reason} (${avisos.join('; ')})`; out.problems = avisos; }
  if (eligioSeguir({ estado, destino: sesion, huellaPlan })) return { ...out, decision: 'skip', reason: 'se eligió seguir sin revisión para este plan' };
  const c = ultimaDelDestino({ estado, destino: sesion });
  // con coordinadora, una informativa (la lanzó la propia sesión) no tapa la revisión que ella tiene que lanzar
  const informativa = !!c && (c.informativa === true || c.lanzo === c.destino);
  const revisado = c && c.huellas && c.huellas.plan === huellaPlan && mismaCorrida(c.corrida, corridaDe(marker))
    && !(hayCoordinadora && informativa && r.approves === 'coordinator');
  if (revisado && c.veredicto === 'rechazado') {
    // rechazado: la sesión corrige y vuelve a cerrar el plan; llega al dueño con O5 en sí o al tope de rechazos seguidos
    const n = rechazosSeguidos({ estado, destino: sesion, corrida: corridaDe(marker) });
    // el mismo tope que las vueltas de revisores del código: el repo manda sobre la organización
    const tope = topeDeRechazos(cfg, marker.repoPath);
    const llega = cfg.plan_review.rejected_reaches_owner || n >= tope;
    const motivo = cfg.plan_review.rejected_reaches_owner ? 'el perfil manda los rechazos a una persona (plan_review.rejected_reaches_owner: true)'
      : n >= tope ? `rechazado ${n} ${n === 1 ? 'vez' : 'veces seguidas'}, el tope es ${tope} (review.max_rounds): decide una persona, partir la historia o firmar una vuelta extra`
        : `rechazado ${n} de ${tope} (review.max_rounds): corregí el plan y volvé a cerrarlo`;
    return { ...out, revisado: c.veredicto, rechazos: n, alDueno: { llega, motivo } };
  }
  if (revisado && c.veredicto !== 'sin-veredicto') return { ...out, revisado: c.veredicto };
  // sin veredicto sobre este mismo plan: llega al dueño con el motivo
  if (revisado) return { ...out, revisado: c.veredicto, alDueno: { llega: true, motivo: `no se pudo revisar: ${c.motivo || 'el pase no midió todo'}` } };
  if (r.decision === 'run') {
    // el plan cambió mientras corría: se reintenta una sola vez sobre el plan cerrado; la segunda llega al dueño
    const cambios = revisionesDe(estado, sesion, corridaDe(marker)).filter((j) => j.motivo === CAMBIO).length;
    if (cambios >= 2) return { ...out, alDueno: { llega: true, motivo: `no se pudo revisar: ${CAMBIO}, dos veces` } };
    out.comando = hayCoordinadora ? `marker.js plan-review --for-session ${sesion}` : 'marker.js plan-review';
    out.lanza = hayCoordinadora ? 'coordinator' : 'session';
    if (cambios === 1) out.reintento = true;
  } else if (r.decision === 'ask' && !pregunta) {
    out.comando = 'marker.js review-ask --kind plan';
  }
  return out;
}

module.exports = {
  CARPETA, VEREDICTOS, APROBADOS, KINDS, CHOICES, configDeLaOrganizacion, veredictoDe, comandoLite, preparar, anotar, leerConstancia,
  ultimaDelDestino, antesDeAprobar, antesDelPlan, planDe, rutaConstancia, anotarPregunta, anotarRespuesta, preguntasAbiertas,
  eligioSeguir, respuestaDe, rechazosSeguidos, hallazgosCorregidos, lineaDelCuadro, accionDelPlan, huellaDe, designadaDeVerdad, sha,
  tieneRenglon, parteDe,
};
