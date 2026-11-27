'use strict';
/**
 * plan-review.js — la revisión automática del plan. La lanza la coordinadora sobre el plan de otra sesión, o la propia
 * sesión sobre el suyo. Su veredicto «aprobado» aprueba un plan de rutina: por delegación, si la lanzó la coordinadora;
 * sin click, si la lanzó la propia sesión (`plan_review.routine_approval: review`, de fábrica). Con `person`, o con una
 * story delicada, la revisión que lanza la propia sesión es informativa: sólo informa, y el plan lo firma una persona.
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
const CAMBIO_HISTORIA = 'la historia cambió mientras corría la revisión';
// el plan o la historia cambiaron mientras corría: los dos cuentan para el reintento, que es uno solo por corrida
const esCambio = (motivo) => motivo === CAMBIO || motivo === CAMBIO_HISTORIA;
const KINDS = Object.freeze(['plan', 'code']);
const CHOICES = Object.freeze(['review', 'skip', 'wait']);

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const SESION = /^[\w-]+$/;

// lo que de la historia no define lo que se construye: el registro de después (story-format.md, «Dev Agent Record» y
// sus partes, el «Change Log» y los «Follow-ups»), y del frontmatter el estado y los enlaces a las que la siguen
// «Ajustes después de la firma» guarda los ajustes de redacción que se pasan al cuerpo después de firmar el plan: los
// revisores y el cierre la leen, y el control del encabezado frena el `done` con uno sin pasar (lint-story-frontmatter.js)
const SECCIONES_DE_REGISTRO = new Set(['dev agent record', 'change log', 'follow-ups y cambios post-firma', 'agent model used',
  'debug log references', 'completion notes list', 'file list', 'ajustes después de la firma']);
const CLAVES_DE_REGISTRO = new Set(['status', 'followed_up_by']);

/**
 * La historia como la ata la revisión del plan: todo lo que define lo que se construye, sin el registro de después
 * (`SECCIONES_DE_REGISTRO`, de nivel 2 o 3, y `CLAVES_DE_REGISTRO` del frontmatter). Ante la duda, cuenta: con una forma
 * que el corte no lee con certeza (un título con sangría o subrayado, un comentario HTML, un bloque de código sin cerrar,
 * una sección de registro de nivel 1) se usa la historia entera. Sólo se igualan el BOM y los fines de renglón.
 */
function textoDeConstruccion(texto) {
  const entero = String(texto).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lineas = entero.split('\n');
  const salida = [];
  let i = 0;
  if (lineas[0] === '---') {
    const fin = lineas.indexOf('---', 1);
    if (fin > 0) {
      salida.push('---');
      for (let k = 1; k < fin; k++) {
        const clave = /^([\w-]+)\s*:/.exec(lineas[k]);
        if (clave && CLAVES_DE_REGISTRO.has(clave[1].toLowerCase())) {
          // el valor de la clave, también el que sigue en renglones con sangría o como lista
          while (k + 1 < fin && /^(\s|-\s)/.test(lineas[k + 1])) k++;
          continue;
        }
        salida.push(lineas[k]);
      }
      salida.push('---');
      i = fin + 1;
    }
  }
  // un bloque de código abre con 3 o más ` o ~ (hasta 3 espacios de sangría) y cierra con el mismo signo, al menos igual de
  // largo y sin nada después; el de ` no lleva ` en su etiqueta
  let cerco = null;
  let salteando = 0;
  let anterior = '';
  for (; i < lineas.length; i++) {
    const l = lineas[i];
    if (cerco) {
      const cierre = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
      if (cierre && cierre[1][0] === cerco[0] && cierre[1].length >= cerco.length) cerco = null;
      if (!salteando) salida.push(l);
      anterior = l;
      continue;
    }
    const apertura = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (apertura && !(apertura[1][0] === '`' && apertura[2].includes('`'))) {
      cerco = apertura[1];
      if (!salteando) salida.push(l);
      anterior = l;
      continue;
    }
    // lo que el corte no lee con certeza: la historia entera
    if (/^ {1,3}#{1,6}(\s|$)/.test(l) || /<!--/.test(l) || (/^ {0,3}(=+|-+)\s*$/.test(l) && anterior.trim() !== '')) return entero;
    const titulo = /^(#{1,6})(?:\s+(.*?))?\s*#*\s*$/.exec(l);
    if (titulo) {
      const nivel = titulo[1].length;
      const nombre = (titulo[2] || '').replace(/[*_`]/g, '').trim().toLowerCase();
      if (salteando && nivel <= salteando) salteando = 0;
      if (SECCIONES_DE_REGISTRO.has(nombre)) {
        if (nivel === 1) return entero;
        if (!salteando) salteando = nivel;
      }
    }
    if (!salteando) salida.push(l);
    anterior = l;
  }
  if (cerco) return entero;
  return salida.join('\n');
}

const huellaDeConstruccion = (texto) => sha(textoDeConstruccion(texto));

/**
 * ¿La historia de ahora es la que se revisó? Con la huella de construcción, lo que define la construcción; una
 * revisión anotada sin ella (de antes) se compara con el archivo entero. Sin texto, no.
 */
function mismaHistoria(texto, huellas) {
  if (texto === null || texto === undefined || !huellas) return false;
  if (huellas.construccion) return huellaDeConstruccion(texto) === huellas.construccion;
  return sha(texto) === huellas.story;
}
const no = (motivo) => ({ codigo: 2, motivo });
// el resultado es el de esta revisión: trae el número del pedido
const esDeLaRevision = (resultado, pedido) => !!(resultado && pedido && pedido.numero && resultado.pedido === pedido.numero);
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
        // un archivo que no se lee no es uno vacío: se dice, y quien aprueba lo mira
        if (!raw) problems.push({ path: 'team-repos.json', message: `no se pudo leer (${((r && r.problems) || []).map((p) => p.message).join('; ') || 'sin datos'}): uso la de fábrica` });
        // el lector ya sacó cada clave mala de `data`: sus problemas se dicen acá, porque normalize ya no las ve
        const sp = (r && r.sectionProblems) || {};
        for (const sec of ['plan_review', 'review', 'review_runner', 'deep_review']) {
          for (const p of sp[sec] || []) problems.push({ path: p.path, message: `${p.message}; uso el valor de fábrica` });
        }
      } else {
        // la variable del arnés apunta a otro lado y ahí no está la configuración que sí tiene el lugar del arnés:
        // no se toma por vacía (una sesión podría esconderla así delante de su propio comando)
        const canonica = path.join(require('./harness-path.js').enlace(), 'team-repos.json');
        if ((process.env.TYCON_GUIDES_DIR || process.env.TCG) && fs.existsSync(canonica)) {
          problems.push({ path: 'team-repos.json', message: `no está en ${TCG} (la variable del arnés) y sí en ${canonica}: no la tomo por vacía` });
        }
      }
    }
  } catch (e) {
    // sin arnés instalado no hay configuración de la organización que leer: la de fábrica es la que vale. Si la variable
    // del arnés apunta a algo que no lo es y el lugar del arnés tiene la configuración, no es «sin arnés»
    const escondida = (process.env.TYCON_GUIDES_DIR || process.env.TCG) && fs.existsSync(path.join(require('./harness-path.js').enlace(), 'team-repos.json'));
    problems.push({ path: 'team-repos.json', sinArnes: !!(e && e.name === 'RutaArnesError') && !escondida,
      message: `no pude leer la configuración de la organización (${String((e && e.message) || e).split('\n')[0]}): uso la de fábrica` });
  }
  if (policy().nombreViejo(raw)) {
    problems.push({ path: 'team-repos.json', message: 'plan_review.coordinator_approves es el nombre viejo: usá plan_review.routine_approval (review · person)' });
  }
  // la variable de la máquina sólo aprieta: `person` pide el click aunque la organización diga `review`; `review` no saca
  // el click que la organización pide (la sesión podría ponerla delante de su propio comando). Un valor que no es de la
  // lista no cuenta
  const deLaMaquina = process.env.TYCON_PLAN_ROUTINE_APPROVAL;
  const conVariable = deLaMaquina === 'person'
    ? { ...(raw || {}), plan_review: { ...((raw && raw.plan_review) || {}), routine_approval: deLaMaquina } } : raw;
  if (deLaMaquina === 'review') {
    if (policy().normalize(raw || {}).values.plan_review.routine_approval !== 'review') {
      problems.push({ path: 'TYCON_PLAN_ROUTINE_APPROVAL', message: 'en review no cuenta: la variable sólo puede pedir el click, no sacar el que pide la organización' });
    }
  } else if (deLaMaquina !== undefined && deLaMaquina !== '' && conVariable === raw) {
    problems.push({ path: 'TYCON_PLAN_ROUTINE_APPROVAL', message: `tiene que ser review o person (es ${JSON.stringify(deLaMaquina)}): uso el de la organización` });
  }
  const n = policy().normalize(conVariable || {});
  return { values: n.values, problems: [...problems, ...n.problems], raw };
}

/** La configuración que se usa: la inyectada pasa por `normalize` (una sin la llave vale como de fábrica). */
const configUsada = (config) => (config ? policy().normalize(config).values : configDeLaOrganizacion().values);

/**
 * ¿El problema es de quién aprueba? Todo lo de la sección `plan_review` (un valor malo, también del nombre viejo; una
 * llave mal escrita; la sección que no es un objeto), la variable, o el archivo de la organización que no se lee. El
 * nombre viejo bien escrito es sólo un aviso, y sin arnés instalado vale la de fábrica.
 */
function esProblemaDelAprobador(x) {
  const ruta = String((x && x.path) || '');
  if (/^plan_review(\.|$)/.test(ruta) || ruta === 'TYCON_PLAN_ROUTINE_APPROVAL') return true;
  return ruta === 'team-repos.json' && !x.sinArnes && !/nombre viejo/.test(String(x.message));
}

/**
 * El problema de la configuración de quién aprueba un plan de rutina, o null. Con uno, el valor cae al de fábrica, que
 * aprueba solo: por eso el plan espera a una persona.
 */
function problemaDelAprobador(config) {
  const problems = config ? policy().normalize(config).problems : configDeLaOrganizacion().problems;
  const p = problems.find(esProblemaDelAprobador);
  return p ? `${p.path} ${p.message}` : null;
}

/** El motivo de pedir el click en rutina, con el nombre de la llave que lo pidió. */
const PIDE_EL_CLICK = (cfg) => `la organización o la máquina piden el click en rutina (plan_review.routine_approval: person${cfg.plan_review.coordinator_approves === false ? ', o su nombre viejo plan_review.coordinator_approves: false' : ''})`;

/** ¿El pase corrió con el corredor de prueba de workflow-lite.js (`TYCON_WFLITE_AGENT_CMD`)? */
const deUnCorredorDePrueba = (r) => !!(r && r.corredor && r.corredor.de_prueba);
const DE_PRUEBA = 'el pase corrió con el corredor de prueba (TYCON_WFLITE_AGENT_CMD): no es una revisión';

/**
 * El veredicto de un resultado del pase en modo plan, con el corte de gravedad: «rechazado» sólo con un confirmado en
 * el corte o por encima; los demás confirmados dan «aprobado-con-notas». Medido y sin nada pendiente; un resultado que
 * no es del modo plan, o que contradice su propio `veredicto`, queda sin veredicto. El que corrió con el corredor de
 * prueba (`corredor.de_prueba`) también: ese corredor contesta lo que le escriban, no revisa nada.
 */
function veredictoDe(r, corte = 'all') {
  if (!r || typeof r !== 'object' || r.medido !== true || r.modo !== 'plan') return 'sin-veredicto';
  if (deUnCorredorDePrueba(r)) return 'sin-veredicto';
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

const esObjeto = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/** El marcador abierto de una sesión: null si no existe; lanza si existe y no se puede leer o no es un objeto. */
function marcadorDe(estado, sid) {
  let texto;
  try { texto = fs.readFileSync(path.join(estado, 'active', `${sid}.json`), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`no pude leer el marcador de la sesión ${sid} (${e.code || e.message})`);
  }
  let m;
  try { m = JSON.parse(texto); } catch (e) { throw new Error(`no pude leer el marcador de la sesión ${sid} (${e.message})`); }
  if (!esObjeto(m)) throw new Error(`no pude leer el marcador de la sesión ${sid} (no es un marcador)`);
  return m;
}

function storyDe(marker) {
  const raw = marker && marker.storyPath;
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.join(marker.repoPath || process.cwd(), raw);
}

/** El plan escrito de la corrida: `{ file, texto }`; `texto` es null si no está escrito. */
function planDe(marker) {
  const repo = (marker && marker.repoPath) || process.cwd();
  const runDir = pipeline().resolveRunDir(repo, String(marker.storyId), false, storyDe(marker) || undefined, { marker });
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

/**
 * La sesión designada de la máquina (sin confirmar: la confirmación la mira la delegación), o null si no hay. Si el
 * registro no se puede leer, lanza con la causa: «no se pudo saber» no es «no hay designada».
 */
function designadaDeVerdad(estado) {
  const d = require('./critical-waivers.js').designacionVigente({ dir: estado });
  if (d && d.error) throw new Error(d.error);
  return d ? d.sesion : null;
}

// El pedido a la coordinadora de revisar un plan: lo anota el arnés la primera vez que le toca a ella, y desde ahí se
// cuentan los minutos que tiene para tomarlo (lanzar la revisión).
const PEDIDO = 'plan-review-request';

/** El id de la última revisión terminada que lanzó `a` sobre `destino` en esta corrida, o null. */
function ultimaTerminada({ estado, a, destino, corrida }) {
  const r = leerConstancia({ estado, lanza: a, destino });
  return r.ok && mismaCorrida(r.constancia.corrida, corrida) ? r.constancia.id : null;
}

/** ¿`a` tiene preparada, y todavía sin resultado, una revisión de ESTE plan de `destino` en esta corrida? */
function revisionEnCurso({ estado, a, destino, huellaPlan, corrida }) {
  let p = null;
  try { p = JSON.parse(fs.readFileSync(rutaPedido(estado, a, destino), 'utf8')); } catch (_) { return false; }
  return !!p && !!p.huellas && p.huellas.plan === huellaPlan && mismaCorrida(p.corrida, corrida);
}

/** Los pedidos de revisión que el arnés le anotó a la coordinadora `a`: el último por destino. */
function pedidosA({ estado, a }) {
  const ultimos = new Map();
  for (const j of renglones(estado)) if (j.name === PEDIDO && j.a === a) ultimos.set(j.destino, j);
  return [...ultimos.values()];
}

/**
 * En qué está un pedido a la coordinadora: `{ estado: 'tomado' }` (tiene la revisión de este plan en curso), `'resuelto'`
 * (terminó una revisión suya después del pedido: lo que sigue lo dice la constancia), `'esperando'` (con `quedan`
 * minutos) o `'vencido'` (con `vencio`, la hora en que se cumplió el plazo).
 */
function estadoDelPedido({ estado, pedido, minutos, ahora = Date.now() }) {
  const base = { estado, a: pedido.a, destino: pedido.destino, huellaPlan: pedido.huellaPlan, corrida: pedido.corrida };
  if (revisionEnCurso(base)) return { estado: 'tomado' };
  if (ultimaTerminada(base) !== (pedido.tras || null)) return { estado: 'resuelto' };
  const desde = Date.parse(pedido.ts);
  if (!Number.isFinite(desde)) return { estado: 'esperando', quedan: minutos };
  if (ahora - desde < minutos * 60000) return { estado: 'esperando', quedan: Math.max(1, Math.ceil(minutos - (ahora - desde) / 60000)) };
  return { estado: 'vencido', vencio: desde + minutos * 60000 };
}

/**
 * La coordinadora que atiende la revisión del plan de `sesion`: `{ coordinadora, motivo, pedido, tras }`, con
 * `coordinadora` null si la sesión sigue sola. Lo decide el arnés, nunca la sesión:
 *   · sin designada, o la designada es la propia sesión → sola;
 *   · la designada no vive (Claude Code borra su archivo de sesión al cerrarla, o su proceso ya no está) → sola;
 *   · no se sabe si vive (la carpeta de sesiones no se lee) → la espera, y la rescata el tope de minutos;
 *   · tiene en curso la revisión de este plan → la espera, aunque la haya lanzado antes del pedido;
 *   · el pedido de este plan (después de su última revisión terminada) lleva `minutos` sin que ella lo tome → sola.
 * `pedido`: si ya está anotado; `tras`: la última revisión terminada de ella, a la que se ata un pedido nuevo (así un
 * relanzamiento del mismo plan tiene su propio plazo). Lo anota `anotarPedido` cuando a ella le toca lanzar, no antes.
 */
function coordinadoraQueAtiende({ estado, home, sesion, huellaPlan, corrida, minutos, ahora = Date.now(), avisos = [] }) {
  let d = null;
  try { d = designadaDeVerdad(estado); } catch (e) { avisos.push(`no pude leer la designación de la coordinadora (${e.message}): cuenta como que no hay`); }
  if (!d || d === sesion) return { coordinadora: null, motivo: null };
  let vive = null;
  try {
    const sl = require(path.join(RAIZ, 'scripts', 'lib', 'signature-list.js'));
    vive = sl.vive(sl.sesiones(home), d);
  } catch (e) { vive = null; }
  if (vive === false) return { coordinadora: null, motivo: `la coordinadora designada (${d}) no está viva: la revisión la lanza esta sesión` };
  if (vive === null) avisos.push(`no pude saber si la coordinadora (${d}) está viva: la espera, hasta ${minutos} min (plan_review.coordinator_wait_minutes)`);
  const base = { estado, a: d, destino: sesion, huellaPlan, corrida };
  if (revisionEnCurso(base)) return { coordinadora: d, motivo: null, pedido: true };
  const tras = ultimaTerminada(base);
  const pedido = renglones(estado).filter((j) => j.name === PEDIDO && j.destino === sesion && j.a === d && j.huellaPlan === huellaPlan
    && mismaCorrida(j.corrida, corrida) && (j.tras || null) === tras).pop();
  if (!pedido) return { coordinadora: d, motivo: null, pedido: false, tras };
  const e = estadoDelPedido({ estado, pedido, minutos, ahora });
  if (e.estado !== 'vencido') return { coordinadora: d, motivo: null, pedido: true, tras };
  return { coordinadora: null, motivo: `la coordinadora (${d}) no tomó el pedido en ${minutos} min (plan_review.coordinator_wait_minutes): la revisión la lanza esta sesión`, pedido: true, tras };
}
/** Anota el pedido a la coordinadora `a` de revisar el plan de `destino`: desde acá corren sus minutos. */
function anotarPedido({ estado, a, destino, huellaPlan, corrida, tras = null, ahora = Date.now() }) {
  anotarRenglon(estado, { name: PEDIDO, status: 'ok', a, destino, huellaPlan, corrida, tras }, ahora);
}

/**
 * Los renglones de gates.log, ya leídos (los renglones rotos no cuentan). Sin el archivo, ninguno. Si existe y no se
 * puede leer, también ninguno, y el motivo va a `problemas` cuando quien llama lo pide: un registro ilegible no es uno
 * vacío.
 */
function renglones(estado, problemas) {
  let lineas = [];
  try { lineas = fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n'); } catch (e) {
    if (e.code !== 'ENOENT' && Array.isArray(problemas)) problemas.push(`no pude leer gates.log: ${e.code || e.message}`);
    return [];
  }
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
 * `{ codigo: 2, motivo }` sin escribir nada. Sin `destino` (o con el propio), la propia sesión prepara la revisión de su
 * plan: informativa sólo si no puede firmar (una story delicada, o `routine_approval: person`). Para otra sesión, sólo la
 * designada. Lanzar no pide la delegación: se mira al firmar. `designada()` y `config` se inyectan en las pruebas.
 */
function preparar({ lanza, destino, estado, designada, config, home = require('os').homedir() } = {}) {
  if (!lanza || !SESION.test(lanza)) return no('falta la sesión que lanza la revisión');
  // de la propia sesión: decide el destino y que no se pide ser la designada; si es informativa se decide después
  const propia = !destino || destino === lanza;
  const dest = propia ? lanza : destino;
  if (!SESION.test(dest)) return no('la sesión destino no se puede leer');
  if (!propia) {
    let d;
    try { d = designada ? designada() : designadaDeVerdad(estado); } catch (e) { return no(`${LA_COORDINADORA}: no pude leer la designación (${e.message})`); }
    if (d !== lanza) return no(`${LA_COORDINADORA}: esta sesión no es la designada (sin --for-session, la propia sesión prepara la revisión de su plan)`);
  }
  let marker;
  try { marker = marcadorDe(estado, dest); } catch (e) { return no(e.message); }
  if (!marker) return no(`la sesión ${dest} no tiene una ejecución abierta`);
  // la revisión es del plan cerrado: con «Armar el plan» abierto, el plan todavía cambia y la revisión se pierde
  if (!require('./steps.js').isDone(marker, 'plan')) return no(`el plan de la sesión ${dest} no está cerrado: se lanza la revisión después de cerrar «Armar el plan» (complete-step plan)`);
  // una pregunta a la persona sin contestar sobre la revisión de este plan: primero su respuesta, salvo que cuente como ausente
  {
    const sinRegistro = [];
    const pregunta = preguntasAbiertas({ estado, problemas: sinRegistro }).find((p) => p.sesion === dest && p.kind === 'plan');
    if (sinRegistro.length) return no(`no pude leer las preguntas a la persona (${sinRegistro[0]}): sin saber si hay una abierta no se lanza`);
    if (pregunta) {
      const cfgPregunta = configUsada(config);
      let marca = null;
      try { marca = require(path.join(RAIZ, 'scripts', 'lib', 'owner-away.js')).get({ estado }).mark; } catch (_) { marca = null; }
      const away = policy().ownerAway({ mark: marca, askedAt: Date.parse(pregunta.ts), now: Date.now(), minutes: cfgPregunta.plan_review.owner_away_minutes });
      if (!away.away) return no(`hay una pregunta abierta a la persona sobre la revisión de este plan (desde ${pregunta.ts}): se lanza con su respuesta (review-answer) o cuando cuente como ausente`);
    }
  }
  // la cuarta vuelta de la misma historia no se lanza sola: la decide una persona, aunque esté ausente
  {
    const v = cuartaVuelta({ estado, destino: dest, marker });
    if (v.falta) return no(v.vueltas === null ? `no pude leer el registro de vueltas (${v.motivo}): sin saber cuántas van no se lanza`
      : `ya van ${v.vueltas} vueltas de la revisión del plan de esta historia: la próxima la decide una persona. La sesión ${dest} le pregunta (marker.js review-ask --kind plan, antes del cuadro), se anota su respuesta (marker.js review-answer --kind plan --choice review${dest === lanza ? '' : ` --for-session ${dest}`}) y recién ahí se lanza`);
  }
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
  const cfg = configUsada(config);
  // la revisión de la propia sesión firma una rutina con `review`; un plan delicado nunca (lo aprueba una persona): ahí
  // informa
  const informativa = propia && (delicate.value || cfg.plan_review.routine_approval !== 'review');
  // el número al azar que ata el resultado del pase a esta revisión: un resultado sin él, o con el de otra, no se anota
  const numero = crypto.randomBytes(16).toString('hex');
  const corte = cfg.review.blocking_severity;
  // la historia cambiada sólo en lo técnico después de un plan rechazado: esta vuelta la revalida con el cambio a la vista,
  // y si aprueba escribe las constancias nuevas (story-revalidation.js). Si no se puede saber, la vuelta es la de siempre
  let revalida = null;
  try {
    const pr = require('./story-revalidation.js').porRevalidar({ home, storyPath: storyFile, estado });
    if (pr.aplica) revalida = pr;
  } catch (_) { revalida = null; }
  const args = { modo: 'plan', repo: marker.repoPath || path.dirname(storyFile), storyTexto, planTexto: plan.texto, model: MODELO, runDir: plan.runDir, pedido: numero,
    // el cambio de la historia va aparte: lo juzga su propia lente (`cambio-de-historia`), no se lee como parte de la historia
    ...(revalida ? { cambioDeHistoria: require('./story-revalidation.js').textoDelCambio(revalida.cambios) } : {}),
    lenses: cfg.plan_review.lenses.slice(), verifiers: cfg.review_runner.verifiers, blocking_severity: corte, ...(parte ? { parte } : {}) };
  const pedido = {
    numero, lanzo: lanza, destino: dest, informativa, corte, corrida: corridaDe(marker), storyId: String(marker.storyId), planFile: plan.file, storyFile,
    huellas: { plan: sha(plan.texto), story: sha(storyTexto), construccion: huellaDeConstruccion(storyTexto) }, delicate, hora: new Date().toISOString(), ...(parte ? { parte } : {}),
    ...(revalida ? { revalidacion: {
      // las constancias que esta vuelta revalida: la de validación sólo si era verde (si no, el validador vuelve a correr)
      kinds: [...(revalida.validacion.estado === 'por-revalidar' && revalida.validacion.record.resultado === 'verde' ? ['validacion'] : []),
        ...(revalida.revision.estado === 'por-revalidar' ? ['revision'] : [])],
      validadores: revalida.validacion.record ? revalida.validacion.record.validadores : null,
      riesgo: revalida.revision.record ? revalida.revision.record.riesgo : null,
      huella: require('./story-review-record.js').huella(storyTexto),
      partes: revalida.cambios.map((c) => c.parte),
      // las constancias que vio esta vuelta: si otra se escribe mientras corre el pase, no se pisa
      horas: { validacion: revalida.validacion.record ? revalida.validacion.record.hora : null, revision: revalida.revision.record ? revalida.revision.record.hora : null },
    } } : {}),
  };
  escribirDeUnaVez(rutaPedido(estado, lanza, dest), `${JSON.stringify(pedido, null, 2)}\n`);
  anotarRenglon(estado, { name: LANZADA, status: 'ok', sesion: lanza, destino: dest, story: String(marker.storyId), historia: historiaDe(marker), corrida: pedido.corrida, pedido: numero });
  const argsFile = path.join(carpetaDe(estado, lanza), `${dest}.args.json`);
  escribirDeUnaVez(argsFile, `${JSON.stringify(args, null, 2)}\n`);
  // el resultado de la revisión anterior, antes de que el corredor lo pise: si no se puede guardar, se dice y se sigue
  try { guardarResultado(estado, lanza, dest); } catch (e) { process.stderr.write(`⚠️  no pude guardar con fecha el resultado de la revisión anterior (${e.code || e.message}): el corredor lo va a pisar\n`); }
  try { guardarUso(estado, lanza, dest); } catch (e) { process.stderr.write(`⚠️  no pude guardar con fecha el consumo de la revisión anterior (${e.code || e.message}): el corredor lo va a pisar\n`); }
  return { codigo: 0, args, argsFile, pedido: rutaPedido(estado, lanza, dest), delicate, informativa, destino: dest };
}

/**
 * El comando de workflow-lite.js que corre el pase en modo plan: los args van por la ruta de su archivo (`--args-file`),
 * no pegados en la línea de comando, que en Windows tiene tope y no los aguanta. Con la lista
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
  return `node ${q(path.join(sc, 'workflow-lite.js'))} ${q(path.join(sc, 'adversarial-verify.workflow.js'))} --args-file ${q(argsFile)} --out ${q(out)}` +
    (nombres ? ` --runners ${nombres.join(',')}  # revisor: ${labels.join(', luego ')}` : '');
}

/** Los renglones `plan-review` de un destino (o de varios: las sesiones de una corrida adoptada) y una corrida, en orden. */
function revisionesDe(estado, destino, corrida, problemas) {
  const destinos = [].concat(destino);
  return renglones(estado, problemas).filter((j) => j.name === 'plan-review' && destinos.includes(j.destino) && mismaCorrida(j.corrida, corrida));
}

/**
 * Las sesiones de la corrida de `marker`: la de ahora y, si adoptó la corrida de otra (`adopt-session`), la anterior.
 * La revisión que se hizo para la anterior es de esta misma corrida: se hereda, y sigue atada a la huella del plan.
 * Un solo salto: el marcador guarda sólo la última adopción, así que después de A→B→C lo hecho para A no se ve y se
 * pide de nuevo (falla cerrado).
 */
function sesionesDeLaCorrida(destino, marker) {
  const previa = marker && typeof marker.adoptedFrom === 'string' && marker.adoptedFrom && marker.adoptedFrom !== destino ? marker.adoptedFrom : null;
  return previa ? [destino, previa] : [destino];
}

/** La constancia más nueva de esta corrida sobre alguna de `destinos` (las sesiones de la corrida), o null. */
function ultimaDeLaCorrida({ estado, destinos, corrida }) {
  return destinos.map((d) => ultimaDelDestino({ estado, destino: d })).filter((c) => c && c.corrida && mismaCorrida(c.corrida, corrida))
    .sort((a, b) => Date.parse(b.hora) - Date.parse(a.hora))[0] || null;
}

// las vueltas de la revisión del plan de una historia que se lanzan sin preguntar: la siguiente la decide una persona
const VUELTAS_SIN_PREGUNTAR = 3;
const LANZADA = 'plan-review-launch';

/**
 * ¿La próxima vuelta de la revisión del plan de la historia de `marker` necesita la respuesta de una persona? `{ vueltas,
 * falta }`: las vueltas lanzadas de esa historia (por cualquier motivo y desde cualquier sesión, también las cortadas o
 * rechazadas), y `falta` si ya van `VUELTAS_SIN_PREGUNTAR` y, después de la última en el registro, no hay un «review» de
 * la persona para `destino` ni una vuelta extra de esa historia firmada por una persona. Sin el registro legible, falta.
 */
function cuartaVuelta({ estado, destino, marker }) {
  const problemas = [];
  const todos = renglones(estado, problemas);
  if (problemas.length) return { vueltas: null, falta: true, motivo: problemas[0] };
  const storyId = String(marker.storyId);
  const historia = historiaDe(marker);
  const deEsta = (j) => j.name === LANZADA && j.story === storyId && (j.historia || null) === historia;
  let ultima = -1;
  let vueltas = 0;
  todos.forEach((j, k) => { if (deEsta(j)) { vueltas++; ultima = k; } });
  if (vueltas < VUELTAS_SIN_PREGUNTAR) return { vueltas, falta: false };
  // después de la última vuelta en el orden del registro, no por la hora
  const respondio = todos.slice(ultima + 1).some((j) => (j.name === 'review-answer' && j.kind === 'plan' && j.sesion === destino && j.choice === 'review')
    || (j.name === 'extra-round-signed' && j.status === 'ok' && String(j.story) === storyId && VIAS_DE_PERSONA.includes(j.via)));
  return { vueltas, falta: !respondio };
}

// las vías de una firma que dio una persona: la delegación, el aviso y la de trámite no son su respuesta
const VIAS_DE_PERSONA = ['ventana', 'terminal', 'click', 'mensaje'];

/** El archivo de la historia de la corrida, sin su carpeta: la misma historia en otra copia es la misma. */
const historiaDe = (marker) => { try { return path.basename(storyDe(marker)); } catch (_) { return null; } };

/**
 * Anota el resultado de la revisión preparada: devuelve la constancia escrita, o `{ codigo: 2, motivo }` si no hay pedido.
 * `resultado`: lo que devolvió el pase en modo plan. `sinHerramienta`: el motivo de no poder correrlo (sin veredicto).
 */
function anotar({ lanza, destino, estado, resultado, sinHerramienta, noVale = null, modelo = MODELO, proveedor = 'anthropic', ahora = Date.now(), home = require('os').homedir() } = {}) {
  const dest = destino || lanza;
  const fp = rutaPedido(estado, lanza, dest);
  let pedido;
  try { pedido = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {
    return no(e.code === 'ENOENT' ? `no hay una revisión preparada por esta sesión para ${dest}: primero marker.js plan-review${dest === lanza ? '' : ` --for-session ${dest}`}` : `no pude leer el pedido de la revisión (${e.message})`);
  }
  const corte = pedido.corte || 'all';
  let veredicto = sinHerramienta ? 'sin-veredicto' : veredictoDe(resultado, corte);
  let motivo = sinHerramienta ? `sin herramienta para correr el pase: ${sinHerramienta}` : (veredicto === 'sin-veredicto' ? 'el pase no midió todo' : null);
  if (!sinHerramienta && deUnCorredorDePrueba(resultado)) motivo = DE_PRUEBA;
  if (!sinHerramienta && resultado && (!pedido.numero || resultado.pedido !== pedido.numero)) { veredicto = 'sin-veredicto'; motivo = 'el resultado no es el de esta revisión'; }
  // `noVale`: el resultado no se puede usar aunque traiga el número del pedido (no vino de la ruta que nombró la preparación)
  if (noVale) { veredicto = 'sin-veredicto'; motivo = String(noVale); }
  let ahoraPlan = null;
  try { ahoraPlan = fs.readFileSync(pedido.planFile, 'utf8'); } catch (_) { ahoraPlan = null; }
  let reintentar = false;
  let ahoraHistoria = null;
  try { ahoraHistoria = pedido.storyFile ? fs.readFileSync(pedido.storyFile, 'utf8') : null; } catch (_) { ahoraHistoria = null; }
  const cambioElPlan = ahoraPlan === null || sha(ahoraPlan) !== pedido.huellas.plan;
  const cambioLaHistoria = !!(pedido.huellas && pedido.huellas.story) && !mismaHistoria(ahoraHistoria, pedido.huellas);
  if (cambioElPlan || cambioLaHistoria) {
    veredicto = 'sin-veredicto';
    motivo = cambioElPlan ? CAMBIO : CAMBIO_HISTORIA;
    // se reintenta una sola vez por corrida sobre el plan cerrado; la segunda llega al dueño con este motivo. Sin el
    // registro no se sabe si ya se reintentó: no se reintenta
    const sinRegistro = [];
    const yaReintento = revisionesDe(estado, dest, pedido.corrida, sinRegistro).some((j) => esCambio(j.motivo));
    reintentar = !yaReintento && !sinRegistro.length;
  }
  const confirmados = (!sinHerramienta && !noVale && resultado && Array.isArray(resultado.confirmed)) ? resultado.confirmed : [];
  const { blocks } = policy();
  const aHallazgo = (h) => ({ lente: h.lens || null, severidad: h.adjusted_severity || h.severity || null, archivo: h.file || null, linea: h.line ?? null, resumen: h.summary || '' });
  // el resultado de esta revisión, con fecha y sin pisar el de la anterior; y cuánto costó, por agente y por tipo
  let guardado = null;
  try { guardado = guardarResultado(estado, lanza, dest); } catch (e) { process.stderr.write(`⚠️  no pude guardar con fecha el resultado de la revisión (${e.code || e.message})\n`); }
  // el consumo del resultado vale sólo si el resultado es de esta revisión: la ruta fija puede tener todavía el de la anterior
  const esDeEsta = !!(resultado && !noVale && pedido.numero && resultado.pedido === pedido.numero);
  let uso = esDeEsta && resultado.corredor && resultado.corredor.tokens && typeof resultado.corredor.tokens === 'object' ? resultado.corredor.tokens : null;
  // una revisión cortada no deja resultado, pero el corredor dejó su consumo al momento: vale sólo el de esta revisión
  let usoGuardado = null;
  if (!uso) {
    const parcial = usoDe(estado, lanza, dest);
    if (parcial && pedido.numero && parcial.pedido === pedido.numero && parcial.tokens && typeof parcial.tokens === 'object') {
      uso = { ...parcial.tokens, cortada: !parcial.completo };
      try { usoGuardado = guardarUso(estado, lanza, dest); } catch (e) { process.stderr.write(`⚠️  no pude guardar con fecha el consumo de la revisión (${e.code || e.message})\n`); }
    }
  }
  const id = sha(`${lanza}|${dest}|${ahora}`).slice(0, 12);
  // la vuelta que revalidaba la historia (story-revalidation.js): aprobada, con la lente del cambio medida y con la historia
  // tal como la vio, escribe las constancias nuevas. Rechazada, sin veredicto, sin esa lente o con la historia cambiada
  // otra vez, no escribe nada y siguen a revalidar
  let revalidacion = null;
  const rv = pedido.revalidacion;
  // la lente medida y SIN ningún hallazgo propio, antes de verificar: su verificador no ve el cambio, y un hallazgo que
  // refuta o al que le baja la gravedad no puede volver revalidada a la historia
  const lenteDelCambio = !!(esDeLaRevision(resultado, pedido) && Array.isArray(resultado.lentes)
    && resultado.lentes.some((l) => l && l.lens === 'cambio-de-historia' && l.estado === 'medida' && l.count === 0));
  if (rv && Array.isArray(rv.kinds) && rv.kinds.length && APROBADOS.includes(veredicto) && lenteDelCambio && ahoraHistoria !== null
    && require('./story-review-record.js').huella(ahoraHistoria) === rv.huella) {
    try {
      const escritas = require('./story-revalidation.js').revalidar({ home, storyPath: pedido.storyFile,
        kinds: rv.kinds, validadores: rv.validadores, riesgo: rv.riesgo, revisionDelPlan: id, horas: rv.horas || {} });
      revalidacion = { kinds: rv.kinds, partes: rv.partes, escritas };
    } catch (e) { revalidacion = { kinds: rv.kinds, partes: rv.partes, error: e.message }; }
  }
  const constancia = {
    id,
    veredicto, motivo, informativa: !!pedido.informativa,
    hallazgos: confirmados.filter((h) => blocks(h.adjusted_severity || h.severity, corte)).map(aHallazgo),
    notas: confirmados.filter((h) => !blocks(h.adjusted_severity || h.severity, corte)).map(aHallazgo),
    corte, modelo, proveedor, hora: new Date(ahora).toISOString(), lanzo: lanza, destino: dest,
    corrida: pedido.corrida, storyId: pedido.storyId, huellas: pedido.huellas, delicate: pedido.delicate, uso, resultado_guardado: guardado,
    ...(usoGuardado ? { uso_guardado: usoGuardado } : {}),
    // la parte y su lista, congeladas: el portón lee de acá la lista que vale con el plan aprobado por delegación
    ...(pedido.parte ? { parte: pedido.parte } : {}),
    ...(revalidacion ? { revalidacion } : {}),
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

/**
 * Las revisiones que `lanza` preparó sobre el plan de otra sesión y cuyo plan cambió después: `{ viejas, problemas }`.
 * Cada vieja es `{ destino, hora, storyId }`. No cuenta un pedido de una corrida que ya no es la abierta del destino ni el
 * de un plan ya aprobado; un pedido, un marcador o un plan que no se pueden leer van a `problemas`, nunca como «igual».
 */
function revisionesViejas({ estado, lanza }) {
  const viejas = [];
  const problemas = [];
  let archivos;
  try { archivos = fs.readdirSync(carpetaDe(estado, lanza)); } catch (e) {
    if (e.code !== 'ENOENT') problemas.push(`las revisiones del plan preparadas (${e.code || e.message})`);
    return { viejas, problemas };
  }
  for (const f of archivos.filter((x) => x.endsWith('.pending.json')).sort()) {
    const dest = f.slice(0, -'.pending.json'.length);
    if (dest === lanza) continue;
    let pedido;
    try { pedido = JSON.parse(fs.readFileSync(path.join(carpetaDe(estado, lanza), f), 'utf8')); } catch (e) {
      problemas.push(`el pedido de revisión del plan ${dest} (${e.code || e.message})`);
      continue;
    }
    // un pedido con otra forma no se puede comparar: sin corrida no se sabe si es de la abierta
    if (!esObjeto(pedido)) { problemas.push(`el pedido de revisión del plan ${dest} (no es un pedido)`); continue; }
    if (!esObjeto(pedido.corrida)) { problemas.push(`el pedido de revisión del plan ${dest} (sin la corrida)`); continue; }
    let marker;
    try { marker = marcadorDe(estado, dest); } catch (e) { problemas.push(e.message); continue; }
    if (!marker || !mismaCorrida(pedido.corrida, corridaDe(marker))) continue;
    if (require('./steps.js').isDone(marker, 'approve-plan')) continue;
    if (!esObjeto(pedido.huellas) || !pedido.huellas.plan) { problemas.push(`el pedido de revisión del plan ${dest} (sin la huella del plan)`); continue; }
    let texto;
    try { texto = fs.readFileSync(pedido.planFile, 'utf8'); } catch (e) {
      problemas.push(`el plan de la revisión del plan de ${dest} (${e.code || e.message})`);
      continue;
    }
    if (sha(texto) !== pedido.huellas.plan) viejas.push({ destino: dest, hora: pedido.hora, storyId: pedido.storyId });
  }
  return { viejas, problemas };
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

/**
 * ¿La constancia tiene su renglón en gates.log, con la misma huella y sin ser informativa? Con el registro ilegible no
 * lo tiene, y el motivo va a `problemas` si quien llama lo pide.
 */
function tieneRenglon(estado, firmante, destino, texto, problemas) {
  const h = sha(texto);
  return renglones(estado, problemas).some((j) => j.name === 'plan-review' && j.sesion === firmante && j.destino === destino && j.huella === h && j.informativa !== true);
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
  const git = (base) => require('child_process').spawnSync('git', ['-C', marker.repoPath || process.cwd(), 'diff', base], { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
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

/**
 * Anota la respuesta: la elección (`review`, `skip`, `wait`) y quién contestó. `via`: la vía de la firma del dueño que
 * la dio (`skip` del código); `por: 'perfil'`: la contestó la coordinadora por la celda de «dueño ausente».
 */
function anotarRespuesta({ estado, sesion, kind, choice, quien, huella, motivo = null, via = null, por = null, ahora = Date.now() }) {
  if (!KINDS.includes(kind)) return no(`--kind es ${KINDS.join(' o ')}`);
  if (!CHOICES.includes(choice)) return no(`--choice es ${CHOICES.join(', ')}`);
  anotarRenglon(estado, { name: 'review-answer', status: 'ok', sesion, kind, choice, quien, huella: huella || null, motivo, ...(via ? { via } : {}), ...(por ? { por } : {}) }, ahora);
  return { codigo: 0 };
}

/**
 * ¿La celda de «dueño ausente» contesta «skip» por el dueño a la pregunta del código de `sesion` sobre `huella`? El dueño
 * tiene que contar como ausente (la marca, o la pregunta de ese diff con `plan_review.owner_away_minutes` minutos sin
 * respuesta) y la matriz del portón del pase (pipeline.js), con el dueño ausente, tiene que decir `skip` para ese diff.
 * `{ codigo: 0, motivo }` o `{ codigo: 2, motivo }`: lo que no se puede leer no contesta por el dueño.
 */
function skipPorElPerfil({ estado, sesion, huella, ahora = Date.now() }) {
  let marker;
  try { marker = marcadorDe(estado, sesion); } catch (e) { return no(e.message); }
  if (!marker) return no(`la sesión ${sesion} no tiene una ejecución abierta`);
  const cfg = configDeLaOrganizacion().values;
  const g = require(path.join(RAIZ, 'scripts', 'lib', 'owner-away.js')).get({ estado, ahora });
  if (g.problem) return no(`no pude leer la marca de ausente (${g.problem})`);
  const problemas = [];
  const pregunta = preguntasAbiertas({ estado, problemas }).find((p) => p.sesion === sesion && p.kind === 'code' && p.huella === huella);
  if (problemas.length) return no(`no pude leer las preguntas de revisar (${problemas[0]})`);
  const aus = require('./review-policy.js').ownerAway({ mark: g.mark, askedAt: pregunta ? Date.parse(pregunta.ts) : null, now: ahora, minutes: cfg.plan_review.owner_away_minutes });
  if (!aus.away) return no(`la persona no cuenta como ausente (${aus.reason}): «skip» lo contesta ella, con su firma`);
  // los archivos del cambio entero, como los ve el portón con --files: lo commiteado desde la base de la ejecución, lo
  // que falta commitear y los archivos nuevos sin seguir. Uno que falta achicaría el diff y daría «chica» a una grande
  const repo = marker.repoPath || process.cwd();
  const env = require(path.join(RAIZ, 'scripts', 'lib', 'clean-git-env.js')).idiomaFijo();
  const git = (args) => require('child_process').spawnSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', env });
  const archivos = new Set();
  for (const args of [['diff', '--name-only', marker.baseSha || 'HEAD'], ['ls-files', '--others', '--exclude-standard']]) {
    const d = git(args);
    if (d.status !== 0) return no(`no pude leer los archivos del cambio (${(d.stderr || '').trim().split('\n')[0] || d.status})`);
    for (const f of d.stdout.split('\n')) if (f) archivos.add(f);
  }
  let r;
  try {
    r = pipeline().computeDeepReviewGate({ story: storyDe(marker), repo, files: [...archivos], reviewConfig: cfg, ownerAway: true, codeAnswer: null });
  } catch (e) { return no(`no pude calcular la celda de ausencia (${(e && e.message) || e})`); }
  if (!r || r.decision !== 'skip') return no(`la celda de ausencia para este diff dice ${(r && r.decision) || 'otra cosa'} (${(r && r.reason) || 'sin motivo'}): no contesta «skip»`);
  return { codigo: 0, motivo: `${aus.reason}; ${r.reason}` };
}

/**
 * Las preguntas sin respuesta: `[{ sesion, kind, huella, ts }]`, la más vieja primero. `problemas` (opcional) recibe el
 * motivo si el registro no se puede leer; las consultas de abajo hacen lo mismo.
 */
function preguntasAbiertas({ estado, problemas }) {
  const abiertas = new Map();
  for (const j of renglones(estado, problemas)) {
    const clave = `${j.sesion}|${j.kind}`;
    if (j.name === 'review-ask') abiertas.set(clave, { sesion: j.sesion, kind: j.kind, huella: j.huella, ts: j.ts });
    else if (j.name === 'review-answer' && abiertas.has(clave)) abiertas.delete(clave);
  }
  return [...abiertas.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** La última respuesta (`review`, `skip` o `wait`) de la pregunta de una sesión sobre esa huella, o null. */
function respuestaDe({ estado, sesion, kind, huella, problemas }) {
  const r = renglones(estado, problemas).filter((j) => j.name === 'review-answer' && j.kind === kind && j.sesion === sesion && j.huella === huella);
  return r.length ? r[r.length - 1].choice : null;
}

/**
 * ¿Para este plan (su huella) se eligió seguir sin revisión? La última respuesta sobre esa huella manda; `destino` puede
 * ser varias sesiones (las de una corrida adoptada), y entonces manda la última de todas.
 */
function eligioSeguir({ estado, destino, huellaPlan, problemas }) {
  const destinos = [].concat(destino);
  const r = renglones(estado, problemas).filter((j) => j.name === 'review-answer' && j.kind === 'plan' && destinos.includes(j.sesion) && j.huella === huellaPlan);
  return r.length ? r[r.length - 1].choice === 'skip' : false;
}

/**
 * Los rechazos seguidos de la corrida, contados en los renglones `plan-review`: uno por huella de plan; un «aprobado»
 * (o con notas) pone la cuenta en cero; un «sin veredicto» no suma ni la pone en cero. Las de la propia sesión cuentan:
 * sin coordinadora son la única revisión, y el tope tiene que poder llegar al dueño igual.
 */
function rechazosSeguidos({ estado, destino, corrida, problemas }) {
  let huellas = new Set();
  for (const j of revisionesDe(estado, destino, corrida, problemas)) {
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
      if (v !== undefined) process.stderr.write(`⚠️  review.max_rounds de ${repo} vale «${String(v).slice(0, 40)}», que no es un número entre ${RR.MINIMO} y ${RR.MAXIMO}: vale el de la organización (${cfg.review.max_rounds}).\n`);
    } catch (e) {
      // sin el ajuste del repo vale el de la organización, el mismo que usan las vueltas del código; se dice, porque el
      // número del repo puede ser otro
      process.stderr.write(`⚠️  no pude leer review.max_rounds de ${repo} (${String((e && e.message) || e).split('\n')[0]}): vale el de la organización (${cfg.review.max_rounds}).\n`);
    }
  }
  return cfg.review.max_rounds;
}

/** Cuántos hallazgos sumaron los rechazos de la corrida (la N de «N hallazgos corregidos»). */
function hallazgosCorregidos({ estado, destino, corrida, problemas }) {
  return revisionesDe(estado, destino, corrida, problemas).filter((j) => j.veredicto === 'rechazado').reduce((s, j) => s + (Number(j.hallazgos) || 0), 0);
}

/**
 * La línea del cuadro de la firma con el resultado de la revisión de este plan, y las notas o hallazgos que la siguen.
 * `{ linea, detalle: [] }`.
 */
function lineaDelCuadro(o) {
  const r = lineaDelCuadroSola(o);
  // la historia cambió después de validarla y ninguna vuelta del plan la revalidó: quien firma lo ve, con el cambio
  try {
    const sr = require('./story-revalidation.js');
    const pr = sr.porRevalidar({ home: o.home || require('os').homedir(), storyPath: storyDe(o.marker), estado: o.estado });
    if (pr.aplica) {
      // en palabras, no con «-» y «+»: el cuadro le saca el guion a cada renglón y uno que se va se leería como afirmado
      const detalle = pr.cambios.flatMap((c) => [`cambió ${c.parte}:`, ...c.quitadas.map((l) => `se va: ${l}`), ...c.sumadas.map((l) => `llega: ${l}`)]);
      return { linea: `${r.linea}; la historia cambió después de validarla y ninguna vuelta del plan la revalidó (${pr.cambios.map((c) => c.parte).join('; ')})`,
        detalle: [...r.detalle, ...detalle] };
    }
  } catch (_) { /* sin poder saberlo, el cuadro dice lo de siempre */ }
  return r;
}

function lineaDelCuadroSola({ estado, destino, marker, config }) {
  const cfg = configUsada(config);
  const plan = planDe(marker);
  const huellaPlan = plan.texto ? sha(plan.texto) : null;
  const corrida = corridaDe(marker);
  // sin el registro no se sabe si se eligió seguir ni cuántas veces se rechazó: se dice, no se muestra «sin revisión»
  const sinRegistro = [];
  renglones(estado, sinRegistro);
  if (sinRegistro.length) return { linea: `${sinRegistro[0]}: no sé cómo quedó la revisión`, detalle: [] };
  const destinos = sesionesDeLaCorrida(destino, marker);
  if (huellaPlan && eligioSeguir({ estado, destino: destinos, huellaPlan })) return { linea: 'sin revisión (se eligió seguir)', detalle: [] };
  const deEsta = destinos.map((d) => ultimaDelDestino({ estado, destino: d })).filter((c) => c && c.veredicto && mismaCorrida(c.corrida, corrida))
    .sort((a, b) => Date.parse(b.hora) - Date.parse(a.hora))[0] || null;
  if (!deEsta) {
    const delicate = pipeline().computeDelicate({ story: storyDe(marker), repo: marker.repoPath, planText: plan.texto || '' });
    if (!delicate.value && cfg.plan_review.routine === 'never') return { linea: 'sin revisión (el perfil no revisa)', detalle: [] };
    return { linea: 'sin revisión (todavía no corrió sobre este plan)', detalle: [] };
  }
  if (!huellaPlan || deEsta.huellas.plan !== huellaPlan) return { linea: 'la revisión es de otra versión del plan', detalle: [] };
  const lista = (hs) => (hs || []).map((h) => `- [${h.lente || '?'}] ${h.resumen}`);
  if (deEsta.veredicto === 'sin-veredicto') return { linea: `no se pudo revisar: ${deEsta.motivo || 'el pase no midió todo'}`, detalle: [] };
  if (deEsta.veredicto === 'rechazado') {
    const n = rechazosSeguidos({ estado, destino: destinos, corrida });
    return { linea: `revisado, rechazado ${n} ${n === 1 ? 'vez' : 'veces seguidas'}`, detalle: lista(deEsta.hallazgos) };
  }
  const corregidos = hallazgosCorregidos({ estado, destino: destinos, corrida });
  const base = corregidos ? `revisado, ${corregidos} hallazgos corregidos` : 'revisado, sin hallazgos';
  if (deEsta.veredicto === 'aprobado-con-notas') {
    const k = (deEsta.notas || []).length;
    return { linea: `${base}; con ${k} ${k === 1 ? 'nota' : 'notas'} para implementar`, detalle: lista(deEsta.notas) };
  }
  return { linea: base, detalle: [] };
}

/**
 * Lo que la aprobación del plan de una corrida mide ahora: su plan, su historia, su parte y si es delicada (risk-class,
 * `computeDelicate`). Con la historia ilegible, delicada. Lo usan `antesDeAprobar` y `planParaDelegar`: el desvío a la
 * coordinadora y owner-next miden igual que la firma.
 */
function medirElPlan(marker) {
  const plan = planDe(marker);
  const storyFile = storyDe(marker);
  let storyTexto = null;
  try { storyTexto = fs.readFileSync(storyFile, 'utf8'); } catch (_) { storyTexto = null; }
  const parte = parteDe(marker, storyTexto);
  const delicate = pipeline().computeDelicate({ story: storyFile, repo: marker.repoPath, planText: plan.texto || '', batch: batchDe(parte) });
  return { plan, storyFile, storyTexto, parte, delicate };
}

const PLAN_DE_UNA_PERSONA = 'el plan de una historia delicada lo aprueba una persona';

/**
 * ¿El plan de la sesión `destino` (o su maqueta, que se firma como el plan) puede ir a la coordinadora por delegación?
 * null si su historia es de rutina; `{ codigo: 2, motivo }` si es delicada o si no se puede saber (sin marcador, con el
 * marcador o el plan ilegibles, con la historia ilegible): entonces lo aprueba una persona, como en `antesDeAprobar`.
 * Lo preguntan el desvío y owner-next antes de ofrecerle la firma (scripts/lib/delegation-routing.js `deUnaPersona`).
 */
function planParaDelegar({ estado, destino } = {}) {
  const sinSaber = (por) => no(`${PLAN_DE_UNA_PERSONA}, y no sé si ésta lo es: ${por}`);
  if (!estado || !SESION.test(String(destino || ''))) return sinSaber('no sé de qué sesión es el plan');
  let marker;
  try { marker = marcadorDe(estado, String(destino)); } catch (e) { return sinSaber(e.message); }
  if (!marker || marker.storyId == null) return sinSaber(`la sesión ${destino} no tiene una ejecución abierta`);
  let m;
  try { m = medirElPlan(marker); } catch (e) { return sinSaber(`no pude medir su historia (${e.message})`); }
  if (m.plan.error) return sinSaber(`no pude leer su plan (${m.plan.error})`);
  return m.delicate.value ? no(`${PLAN_DE_UNA_PERSONA} (${m.delicate.reason})`) : null;
}

/**
 * Las condiciones de la aprobación del plan sin persona (la delegación, la firma de trámite, «hecho y avisado», la
 * revisión de la propia sesión): `{ codigo: 2, motivo }` para no firmar (el pedido no se gasta), o
 * `{ codigo: 0, via: 'revision', constancia }`. Primero si la story es delicada: entonces no, nunca, diga lo que diga el
 * perfil; después si el perfil deja que la coordinadora apruebe, y la constancia. Todo se vuelve a calcular ahora: el
 * plan, la story y si es delicada. `delegacion(o)` (opcional) mira la delegación del perfil; sin ella, la miró antes el
 * freno de la firma.
 */
function antesDeAprobar({ estado, firmante, destino, marker, config, delegacion, home }) {
  const { plan, storyTexto, parte, delicate } = medirElPlan(marker);
  // un plan delicado lo aprueba una persona, con su click o su «aprobado» (o en su terminal): ni la revisión de la propia
  // sesión, ni la coordinadora por delegación, ni el arnés como trámite. El perfil no lo cambia: `plan-approval:delicada`
  // en approvals.delegated_signing no lo vuelve trámite ni lo delega
  if (delicate.value) return no(`plan delicado (nivel 2): lo aprueba el dev con su click o su «aprobado», no la revisión ni la delegación (${delicate.reason})`);
  const cfg = configUsada(config);
  if (cfg.plan_review.routine_approval !== 'review') return no(`${PIDE_EL_CLICK(cfg)}: ${ESPERA}`);
  const malEscrita = problemaDelAprobador(config);
  if (malEscrita) return no(`la configuración de quién aprueba tiene un problema (${malEscrita}): ${ESPERA}`);
  if (delegacion) {
    let d;
    try { d = delegacion({ firma: 'plan-approval', sesion: firmante, destino, home, estado }); } catch (e) { d = { ok: false, motivo: e.message }; }
    if (!d || !d.ok) return no(`el perfil no delega la aprobación del plan (${(d && d.motivo) || 'sin respuesta'}): ${ESPERA}`);
  }
  // la constancia de esta corrida: la de la sesión de ahora o, en una corrida adoptada, la de la anterior. Si ninguna es
  // de esta corrida, la primera que se lee dice por qué no
  const destinos = sesionesDeLaCorrida(destino, marker);
  const hoyCorrida = corridaDe(marker);
  const leidas = destinos.map((d) => ({ d, r: leerConstancia({ estado, lanza: firmante, destino: d }) }));
  const deEsta = leidas.find((x) => x.r.ok && x.r.constancia.corrida && mismaCorrida(x.r.constancia.corrida, hoyCorrida));
  const elegida = deEsta || leidas.find((x) => x.r.ok || !x.r.ausente) || leidas[0];
  const r = elegida.r;
  const deQuien = elegida.d;
  if (!r.ok && r.ausente) return no(`no hay una revisión automática de este plan lanzada por esta sesión (marker.js plan-review${firmante === destino ? '' : ` --for-session ${destino}`}): ${ESPERA}`);
  if (!r.ok) return no(`la constancia de la revisión no se puede leer (${r.motivo}): ${ESPERA}`);
  const c = r.constancia;
  if (c.informativa === true) return no(`la revisión es informativa (la lanzó la propia sesión cuando no podía firmar): sólo informa: ${ESPERA}`);
  if (c.lanzo !== firmante || c.destino !== deQuien) return no(`la revisión la lanzó otra sesión (${c.lanzo}), no la que firma: ${ESPERA}`);
  const sinRegistro = [];
  if (!tieneRenglon(estado, firmante, deQuien, r.texto, sinRegistro)) return no(`${sinRegistro[0] || 'la constancia de la revisión no tiene su renglón en gates.log'}: ${ESPERA}`);
  const hoy = corridaDe(marker);
  if (c.storyId !== hoy.storyId || c.corrida.storyId !== hoy.storyId || c.corrida.startedAt !== hoy.startedAt) return no(`la revisión es de otra corrida (${c.corrida.storyId}, ${c.corrida.startedAt}): ${ESPERA}`);
  if (!plan.texto || sha(plan.texto) !== c.huellas.plan) return no(`el plan cambió después de la revisión: ${ESPERA}`);
  if (!mismaHistoria(storyTexto, c.huellas)) return no(`la story cambió después de la revisión en lo que define la construcción: ${ESPERA}`);
  if (c.delicate.value !== delicate.value) return no(`la story era delicada cuando se revisó y ya no lo es: ${ESPERA}`);
  // la coordinadora aprueba lo que se revisó: la misma parte, igual de válida y con la misma lista
  if (!mismaParte(c.parte, parte)) return no(`la parte o su lista cambiaron desde la revisión (${c.parte ? c.parte.nombre : 'sin parte'} → ${parte ? parte.nombre : 'sin parte'}): ${ESPERA}`);
  if (eligioSeguir({ estado, destino: destinos, huellaPlan: c.huellas.plan })) return no(`para este plan se eligió seguir sin revisión: lo firma una persona`);
  if (!APROBADOS.includes(c.veredicto)) return no(`${ESPERA} (la revisión dijo ${c.veredicto})`);
  return { codigo: 0, via: 'revision', constancia: c };
}

// En la aprobación por la revisión (la delegación, la firma de trámite), `--approved` sólo dice que es la revisión: el
// texto de la aprobación lo arma el arnés con quién lanzó la revisión y su veredicto. Un texto propio podría atribuir
// una firma que nadie dio («firma del dueño con el cuadro»), y la constancia lo guardaría como cierto.
const PALABRA_DE_LA_REVISION = /^(?:la\s+)?revisi[oó]n$/i;

/** null si el `--approved` de una aprobación por la revisión es la palabra «revisión» (o falta); si no, el motivo. */
function textoPropioPorLaRevision(dado) {
  if (dado == null || PALABRA_DE_LA_REVISION.test(String(dado).trim())) return null;
  return 'en la aprobación por la revisión el texto lo arma el arnés (quién lanzó la revisión y su veredicto): '
    + `cerrá con --approved revisión, sin «${String(dado).replace(/\s+/g, ' ').slice(0, 80)}»`;
}

/** El texto de una aprobación por la revisión, armado por el arnés con su constancia. */
function textoDeLaAprobacion(c) {
  return `revisión ${c.id} ${c.veredicto} (${c.modelo}), lanzada por la sesión ${c.lanzo}`;
}

/**
 * ¿La última revisión CON VEREDICTO de esta corrida, de cualquier sesión, está en rechazo, y la historia es delicada?
 * `{ codigo: 2, motivo }` para no aprobar, por ninguna vía: un plan delicado no se aprueba con su revisión en contra.
 * null si no. Se lee de gates.log, que no se pisa: ni cambiar el plan después del rechazo ni anotar encima una revisión
 * sin veredicto lo destapan; lo destapa una revisión aprobada posterior.
 */
function revisionEnContra({ estado, destino, marker }) {
  const plan = planDe(marker);
  const problemas = [];
  // en una corrida adoptada, el rechazo de la sesión anterior cuenta como su aprobación
  const conVeredicto = revisionesDe(estado, sesionesDeLaCorrida(destino, marker), corridaDe(marker), problemas)
    .filter((j) => j.veredicto === 'rechazado' || APROBADOS.includes(j.veredicto));
  const u = conVeredicto[conVeredicto.length - 1];
  // con el registro ilegible no se sabe si hay una revisión en contra: cuenta como si la hubiera
  if (!problemas.length && (!u || u.veredicto !== 'rechazado')) return null;
  const storyFile = storyDe(marker);
  let storyTexto = null;
  try { storyTexto = fs.readFileSync(storyFile, 'utf8'); } catch (_) { storyTexto = null; }
  // sin poder saber si es delicada, cuenta como delicada
  let delicada;
  try {
    delicada = pipeline().computeDelicate({ story: storyFile, repo: marker.repoPath, planText: plan.texto || '', batch: batchDe(parteDe(marker, storyTexto)) }).value !== false;
  } catch (_) { delicada = true; }
  if (!delicada) return null;
  if (problemas.length) return no(`plan delicado y no pude leer sus revisiones (${problemas[0]}): no sé si alguna está en contra`);
  return { ...no(`plan delicado con su última revisión (${u.ts || 'sin fecha'}) en rechazo: un plan delicado no se aprueba con la revisión en contra. `
    + 'Corregí el plan con lo que encontró la revisión y lanzala de nuevo: la aprueba una revisión aprobada posterior'),
  revision: { ts: u.ts || null, veredicto: u.veredicto, sesion: u.sesion || null } };
}

/**
 * El control previo mínimo de una firma de rutina que el perfil puede delegar y no tiene uno propio (eximir de la
 * comparación con main, preparar la prueba con navegador, cerrar una ejecución que la partición dejó sin objeto): la
 * historia del destino no es delicada. null para firmar, o `{ codigo: 2, motivo }`. La historia y su repo salen del
 * marcador, o de `story` y `repo` (sin marcador); con el marcador, también su plan y su tanda, como `antesDeAprobar`.
 * Si no se puede saber, cuenta como delicada.
 */
function rutinaParaDelegar({ marker = null, story = null, repo = null } = {}) {
  const storyFile = story || (marker ? storyDe(marker) : null);
  if (!storyFile) return no('historia delicada o sin saber: la firma no dice de qué historia es, y sin persona no sale');
  let planTexto = '';
  let batch;
  if (marker && marker.storyId != null) {
    let plan;
    try { plan = planDe(marker); } catch (e) { plan = { error: e.message }; }
    if (plan.error) return no(`historia delicada o sin saber: no pude leer su plan (${plan.error}), y sin persona no sale`);
    planTexto = plan.texto || '';
    let storyTexto;
    try { storyTexto = fs.readFileSync(storyFile, 'utf8'); } catch (e) {
      return no(`historia delicada o sin saber: no pude leer la historia (${e.code || e.message}), y sin persona no sale`);
    }
    batch = batchDe(parteDe(marker, storyTexto));
  }
  const delicate = pipeline().computeDelicate({ story: storyFile, repo: repo || (marker && marker.repoPath) || undefined, planText: planTexto, batch });
  return delicate.value ? no(`historia delicada (nivel 2): por delegación no se firma; la firma una persona (${delicate.reason})`) : null;
}

/**
 * Lo que la aprobación del plan comprueba con el pedido sin gastar: sólo por delegación; la ventana y la terminal, no.
 * La aprobación sin click de la propia sesión no pasa por acá: `complete-step approve-plan` llama a `antesDeAprobar`
 * directo, con la propia sesión como firmante y destino.
 */
function antesDelPlan({ via, ...o }) {
  return via === 'delegacion' ? antesDeAprobar(o) : null;
}

/**
 * Qué toca con la revisión del plan de una sesión, al cerrar el plan (`next` en «Aprobar el plan»): `{ decision,
 * approves, reason, comando?, estado }`. `decision` sale de la matriz; si toca revisar y este plan no tiene revisión, el
 * comando para lanzarla (la coordinadora, si la hay; si no, la propia sesión), y también si la revisión de esta corrida
 * es de otra versión del plan. `ahora` y `config` se inyectan en las pruebas.
 */
function accionDelPlan({ estado, sesion, marker, config, home, ahora = Date.now() }) {
  const cfg = configUsada(config);
  const P = policy();
  const plan = planDe(marker);
  if (!plan.texto || !plan.texto.trim()) return { decision: null, reason: 'todavía no hay plan escrito' };
  const huellaPlan = sha(plan.texto);
  let storyTexto = '';
  try { storyTexto = fs.readFileSync(storyDe(marker), 'utf8'); } catch (_) { storyTexto = ''; }
  const delicate = pipeline().computeDelicate({ story: storyDe(marker), repo: marker.repoPath, planText: plan.texto, batch: batchDe(parteDe(marker, storyTexto)) });
  // lo que no se pudo leer se decide del lado conservador (sin coordinadora, dueño presente) y se dice en el motivo
  const avisos = [];
  // la coordinadora cuenta sólo si atiende: viva y tomando el pedido a tiempo (si no, la sesión no queda esperándola)
  const atiende = coordinadoraQueAtiende({ estado, home, sesion, huellaPlan, corrida: corridaDe(marker), minutos: cfg.plan_review.coordinator_wait_minutes, ahora, avisos });
  const hayCoordinadora = !!atiende.coordinadora;
  let marca = null;
  try {
    const leida = require(path.join(RAIZ, 'scripts', 'lib', 'owner-away.js')).get({ estado, home, ahora });
    marca = leida.mark;
    if (leida.problem) avisos.push(`${leida.problem}: la persona cuenta como presente`);
  } catch (e) { avisos.push(`no pude leer la marca de ausente (${e.message}): la persona cuenta como presente`); }
  const sinRegistro = [];
  const pregunta = preguntasAbiertas({ estado, problemas: sinRegistro }).find((p) => p.sesion === sesion && p.kind === 'plan' && p.huella === huellaPlan);
  const away = P.ownerAway({ mark: marca, askedAt: pregunta ? Date.parse(pregunta.ts) : null, now: ahora, minutes: cfg.plan_review.owner_away_minutes });
  const r = P.planReview({ delicate: delicate.value, coordinator: hayCoordinadora, ownerAway: away.away, config: cfg });
  const out = { ...r, delicate: delicate.value, ownerAway: away, huellaPlan };
  if (atiende.motivo) { out.reason = `${out.reason}; ${atiende.motivo}`; out.sinCoordinadora = atiende.motivo; }
  if (sinRegistro.length) avisos.push(sinRegistro[0]);
  if (avisos.length) { out.reason = `${out.reason} (${avisos.join('; ')})`; out.problems = avisos; }
  // sin el registro no se sabe si se eligió seguir ni se cuentan los rechazos o los cambios del plan, que son los topes
  // que llevan el caso al dueño: llega al dueño ahora, sin relanzar
  if (sinRegistro.length) return { ...out, alDueno: { llega: true, motivo: `${sinRegistro[0]}: lo decide una persona` } };
  // en una corrida adoptada cuentan también la revisión, los rechazos y la elección de seguir de la sesión anterior
  const destinos = sesionesDeLaCorrida(sesion, marker);
  // las dos sesiones juntas: manda la última respuesta, no cualquier «seguir» de una de ellas
  if (eligioSeguir({ estado, destino: destinos, huellaPlan })) return { ...out, decision: 'skip', reason: 'se eligió seguir sin revisión para este plan' };
  const c = ultimaDeLaCorrida({ estado, destinos, corrida: corridaDe(marker) }) || ultimaDelDestino({ estado, destino: sesion });
  // con coordinadora, una informativa no tapa la revisión que ella tiene que lanzar; la de la propia sesión que puede
  // firmar (rutina con `review`) sí cuenta: aprueba en los dos casos
  const informativa = !!c && c.informativa === true;
  const revisado = c && c.huellas && c.huellas.plan === huellaPlan && mismaCorrida(c.corrida, corridaDe(marker))
    && !(hayCoordinadora && informativa && r.approves === 'coordinator');
  if (revisado && c.veredicto === 'rechazado') {
    // rechazado: la sesión corrige y vuelve a cerrar el plan; llega al dueño con O5 en sí o al tope de rechazos seguidos
    const n = rechazosSeguidos({ estado, destino: destinos, corrida: corridaDe(marker) });
    // el mismo tope que las vueltas de revisores del código: el repo manda sobre la organización
    const tope = topeDeRechazos(cfg, marker.repoPath);
    const llega = cfg.plan_review.rejected_reaches_owner || n >= tope;
    const motivo = cfg.plan_review.rejected_reaches_owner ? 'el perfil manda los rechazos a una persona (plan_review.rejected_reaches_owner: true)'
      : n >= tope ? `rechazado ${n} ${n === 1 ? 'vez' : 'veces seguidas'}, el tope es ${tope} (review.max_rounds): decide una persona, partir la historia o firmar una vuelta extra`
        : `rechazado ${n} de ${tope} (review.max_rounds): corregí el plan y volvé a cerrarlo`;
    return { ...out, revisado: c.veredicto, rechazos: n, alDueno: { llega, motivo } };
  }
  if (revisado && c.veredicto !== 'sin-veredicto') return { ...out, revisado: c.veredicto };
  // sin veredicto sobre este mismo plan porque cambió la historia mientras corría: se relanza como un plan cambiado
  const deUnCambio = revisado && esCambio(c.motivo);
  // sin veredicto sobre este mismo plan: llega al dueño con el motivo
  if (revisado && !deUnCambio) return { ...out, revisado: c.veredicto, alDueno: { llega: true, motivo: `no se pudo revisar: ${c.motivo || 'el pase no midió todo'}` } };
  // ya se revisó otra versión del plan en esta corrida: se vuelve a lanzar sobre el plan cerrado, sin volver a preguntar
  const deOtraVersion = !!(c && c.huellas && c.huellas.plan !== huellaPlan && mismaCorrida(c.corrida, corridaDe(marker)) && c.veredicto);
  if (r.decision === 'run' || ((deOtraVersion || deUnCambio) && r.decision === 'ask')) {
    // el plan cambió mientras corría: se reintenta una sola vez sobre el plan cerrado; la segunda llega al dueño
    const deCambio = revisionesDe(estado, destinos, corridaDe(marker)).filter((j) => esCambio(j.motivo));
    const cambios = deCambio.length;
    if (cambios >= 2) return { ...out, alDueno: { llega: true, motivo: `no se pudo revisar: ${deCambio[deCambio.length - 1].motivo}, dos veces` } };
    out.comando = hayCoordinadora ? `marker.js plan-review --for-session ${sesion}` : 'marker.js plan-review';
    out.lanza = hayCoordinadora ? 'coordinator' : 'session';
    // le toca lanzar a la coordinadora: desde ahora corren sus minutos para tomarlo
    if (hayCoordinadora && !atiende.pedido) {
      try { anotarPedido({ estado, a: atiende.coordinadora, destino: sesion, huellaPlan, corrida: corridaDe(marker), tras: atiende.tras || null, ahora }); } catch (e) {
        out.problems = [...(out.problems || []), `no pude anotar el pedido a la coordinadora (${e.code || e.message}): si no lo toma, la sesión sigue esperándola`];
      }
    }
    if (cambios === 1) out.reintento = true;
    const v = cuartaVuelta({ estado, destino: sesion, marker });
    if (v.falta) {
      out.cuartaVuelta = { vueltas: v.vueltas };
      out.comando = 'marker.js review-ask --kind plan';
      out.alDueno = { llega: true, motivo: v.vueltas === null ? `no pude leer el registro de vueltas (${v.motivo}): lo decide una persona` : `ya van ${v.vueltas} vueltas de la revisión del plan de esta historia: la próxima la decide una persona` };
    }
  } else if (r.decision === 'ask' && !pregunta) {
    out.comando = 'marker.js review-ask --kind plan';
  }
  return out;
}

/** La ruta donde el corredor deja el resultado de la revisión que preparó `lanza` sobre `destino` (el `--out` del comando). */
const rutaResultado = (estado, lanza, destino) => path.join(carpetaDe(estado, lanza), `${destino}.resultado.json`);

// Cada revisión deja su resultado con fecha, en `resultados/`: el corredor escribe siempre en la ruta fija, y la siguiente
// revisión de la misma sesión lo pisaba. La fecha es la del archivo y la huella de su texto evita guardar dos veces el mismo.
const carpetaResultados = (estado, lanza) => path.join(carpetaDe(estado, lanza), 'resultados');

/** Los resultados guardados de las revisiones de `lanza` sobre `destino`, del más viejo al más nuevo. */
function resultadosGuardados(estado, lanza, destino) {
  let archivos;
  try { archivos = fs.readdirSync(carpetaResultados(estado, lanza)); } catch (_) { return []; }
  return archivos.filter((f) => f.startsWith(`${destino}.`) && f.endsWith('.resultado.json')).sort().map((f) => path.join(carpetaResultados(estado, lanza), f));
}

/**
 * Guarda con fecha el resultado de la ruta fija, si hay uno y no está guardado; devuelve su ruta guardada o null. Lo
 * llaman la preparación (antes de que el corredor lo pise) y la anotación.
 */
function guardarResultado(estado, lanza, destino) {
  const fijo = rutaResultado(estado, lanza, destino);
  let texto;
  let cuando;
  try { texto = fs.readFileSync(fijo, 'utf8'); cuando = fs.statSync(fijo).mtime; } catch (_) { return null; }
  const huella = sha(texto).slice(0, 8);
  const ya = resultadosGuardados(estado, lanza, destino).find((f) => f.endsWith(`.${huella}.resultado.json`));
  if (ya) return ya;
  const fecha = cuando.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  const destinoArchivo = path.join(carpetaResultados(estado, lanza), `${destino}.${fecha}.${huella}.resultado.json`);
  fs.mkdirSync(carpetaResultados(estado, lanza), { recursive: true });
  escribirDeUnaVez(destinoArchivo, texto);
  return destinoArchivo;
}

/**
 * La ruta donde el corredor deja, al momento, lo que lleva gastado la revisión de `lanza` sobre `destino`: queda aunque la
 * revisión se corte (workflow-lite.js, `usoDe`).
 */
const rutaUso = (estado, lanza, destino) => path.join(carpetaDe(estado, lanza), `${destino}.resultado.uso.json`);

/** El consumo al momento de la última revisión, o null si no hay uno legible. */
function usoDe(estado, lanza, destino) {
  try { return JSON.parse(fs.readFileSync(rutaUso(estado, lanza, destino), 'utf8')); } catch (_) { return null; }
}

/**
 * Guarda con fecha el consumo al momento, si hay uno y no está guardado; devuelve su ruta guardada o null. Va junto a los
 * resultados, terminado en `.uso.json`: la revisión siguiente lo pisa, y una cortada no tiene otro lugar donde quede.
 */
function guardarUso(estado, lanza, destino) {
  const fijo = rutaUso(estado, lanza, destino);
  let texto;
  let cuando;
  try { texto = fs.readFileSync(fijo, 'utf8'); cuando = fs.statSync(fijo).mtime; } catch (_) { return null; }
  const huella = sha(texto).slice(0, 8);
  let archivos = [];
  try { archivos = fs.readdirSync(carpetaResultados(estado, lanza)); } catch (_) { archivos = []; }
  const ya = archivos.find((f) => f.startsWith(`${destino}.`) && f.endsWith(`.${huella}.uso.json`));
  if (ya) return path.join(carpetaResultados(estado, lanza), ya);
  const fecha = cuando.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  const destinoArchivo = path.join(carpetaResultados(estado, lanza), `${destino}.${fecha}.${huella}.uso.json`);
  fs.mkdirSync(carpetaResultados(estado, lanza), { recursive: true });
  escribirDeUnaVez(destinoArchivo, texto);
  return destinoArchivo;
}

module.exports = {
  rutaResultado, resultadosGuardados, guardarResultado, rutaUso, guardarUso, configUsada, CARPETA, VEREDICTOS, APROBADOS, KINDS, CHOICES, configDeLaOrganizacion, veredictoDe, comandoLite, preparar, anotar, leerConstancia,
  ultimaDelDestino, antesDeAprobar, planParaDelegar, rutinaParaDelegar, antesDelPlan, planDe, rutaConstancia, anotarPregunta, anotarRespuesta, skipPorElPerfil, preguntasAbiertas,
  eligioSeguir, respuestaDe, rechazosSeguidos, hallazgosCorregidos, lineaDelCuadro, accionDelPlan, coordinadoraQueAtiende, anotarPedido, pedidosA, estadoDelPedido, PEDIDO, huellaDe, designadaDeVerdad, sha,
  tieneRenglon, sesionesDeLaCorrida, ultimaDeLaCorrida, mismaCorrida, corridaDe, parteDe, problemaDelAprobador, textoPropioPorLaRevision, textoDeLaAprobacion, revisionEnContra, esProblemaDelAprobador, revisionesViejas, textoDeConstruccion, huellaDeConstruccion, cuartaVuelta, VUELTAS_SIN_PREGUNTAR,
};

// el tope de rechazos, para sus pruebas (start-silences.test.js)
module.exports.topeDeRechazos = topeDeRechazos;
