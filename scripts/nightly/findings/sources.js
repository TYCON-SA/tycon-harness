// Las fuentes de la noche que usan el ciclo de la ficha: cómo se llama la carpeta de cada una en el repo
// de operaciones y cómo se leen sus fichas con la forma común. Dependencias y el vigilante conservan su formato y sus
// palabras, y la pieza se los lee con un mapa; ejecuciones escribe la ficha común de cycle.js. Los instintos entran
// después: el ciclo los admite, esta lista todavía no.

const { formatoPorSecciones, parsear, carpetaDe: carpetaComun, razonSegura, ACCIONES, MOTIVOS_SIN_PROPUESTA, MOTIVOS_SIN_PEDIDO, PIDIENDO, IDENTIDAD } = require('./cycle.js');
const { nombreDe } = require('./cause-names.js');

// ── dependencias: su formato y sus palabras de hoy ─────────────────────────────────────────────

const CLAVES_LISTA = ['ids', 'repos', 'declarada_en', 'avisos'];

/** El orden canónico de las claves. Sólo se usa para saber DÓNDE insertar una clave que no está. */
const ORDEN_FICHA = ['id', 'detectado', 'veredicto', 'paquete', 'severidad', 'noches', 'noches_sin_aparecer', 'noche_contada',
  // La identidad del pull request y la decisión que una persona tomó sobre él. Van
  // juntas y arriba porque son lo que el pipeline lee ANTES de decidir si abre uno nuevo.
  'pr', 'pr_repo', 'rechazado', 'motivo_rechazo', 'pr_cerrado', 'alineado',
  'reaparecido', 'bloqueada_por', 'resuelto', 'resuelto_antes', 'descartado', 'descartado_antes',
  'motivo', 'motivo_antes', 'pr_antes', 'pr_repo_antes', 'rechazado_antes', 'motivo_rechazo_antes',
  'ids', 'repos', 'declarada_en', 'avisos'];

// El archivo sigue escribiendo sus palabras; la pieza las lee así. `descartado` es la deuda declarada en todos sus
// repos: el riesgo se aceptó.
const VEREDICTO_COMUN = { pendiente: 'pendiente', util: 'arreglo', descartado: 'aceptada', ignorado: 'ignorada' };

/** El estado y el veredicto comunes de una ficha de dependencias (`leerFicha`). */
function vistaDependencias(fi) {
  const e = fi.escalares;
  const estado = e.resuelto ? 'resuelta' : e.reaparecido ? 'reaparecio' : 'viva';
  return { estado, veredicto: VEREDICTO_COMUN[e.veredicto] || 'pendiente' };
}

/**
 * Dependencias conserva sus carpetas de hoy: una pendiente que se resuelve pasa a `promoted/` y una aceptada que se
 * resuelve se queda ahí; la deuda declarada y lo ignorado, en `archived/`.
 */
function carpetaDependencias({ estado, veredicto }) {
  if (['aceptada', 'ignorada', 'migrada'].includes(veredicto)) return 'archived';
  if (estado === 'resuelta' || veredicto === 'arreglo') return 'promoted';
  return 'pending';
}

// ── el vigilante: su borrador de hoy ───────────────────────────────────────────────────────────
//
// El borrador conserva su diagnóstico y su evidencia (tachada y con el usuario seudonimizado): `/tycon-vigilante` los
// necesita para decidir. La vista común no los trae, y nada de lo que se le manda al modelo sale de ahí.

const ORDEN_VIGILANTE = ['id', 'fuente', 'causa', 'fecha', 'producto', 'regla', 'severidad', 'huella', 'plugin', 'endpoint',
  'senal', 'diagnostico', 'ultimo_deploy', 'ya_alertado_por_azure', 'evidencia', 'reincidente', 'veredicto', 'motivo',
  'vista_por_ultima_vez', 'noches_seguidas', 'recordado_el', 'story_creada', 'pedido', 'asignado', 'pedido_motivo'];

/** El estado y el veredicto comunes de un borrador del vigilante: mismas palabras que dependencias. Todavía no se
 *  resuelve ni reaparece: el estado es siempre `viva`. */
const vistaVigilante = (fi) => ({ estado: 'viva', veredicto: VEREDICTO_COMUN[fi.escalares.veredicto] || 'pendiente' });

// Las claves de la propuesta del modelo en el formato por secciones (dependencias y el vigilante). La ficha común las
// lleva en `propuesta`, `propuesta_motivo`, `propuesta_fallas` y `propuesta_fallo_el`.
const CLAVES_DE_PROPUESTA = ['propuesta_accion', 'propuesta_razon', 'propuesta_modelo', 'propuesta_motivo', 'propuesta_fallas',
  'propuesta_fallo_el'];

const FUENTES = {
  dependencias: {
    carpeta: 'dependencies',
    extension: '.yaml',
    formato: formatoPorSecciones({ orden: ORDEN_FICHA, listas: CLAVES_LISTA }),
    vista: vistaDependencias,
    carpetaDe: carpetaDependencias,
  },
  vigilante: {
    carpeta: 'watcher',
    extension: '.yaml',
    formato: formatoPorSecciones({ orden: ORDEN_VIGILANTE, listas: ['evidencia'] }),
    vista: vistaVigilante,
    carpetaDe: carpetaDependencias,
  },
  ejecuciones: { carpeta: 'runs-review', extension: '.yaml', carpetaDe: carpetaComun },
};

/**
 * ¿Es una ficha por ejecución, la forma de antes de las fichas por causa? No tiene `fuente:` y trae `reglas`. Ésas las lee el lector viejo de
 * runs-review.js: el ciclo las saltea y no son ilegibles.
 */
const esVieja = (txt) => !/^fuente:/m.test(String(txt)) && /^reglas:/m.test(String(txt));

const fecha = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const entero = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
const ENLACE = /^https:\/\/[^\s"'<>\\]{1,500}$/;
const MODELO = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$/;
const SIN_FORMA = 'razón sin la forma esperada';

/** La propuesta del modelo, con su razón pasada otra vez por el filtro: la que no lo pasa no se muestra. */
function propuestaDe(accion, razon, modelo) {
  if (!ACCIONES.includes(accion)) return null;
  const p = { accion, razon: razonSegura(razon) ? razon : SIN_FORMA };
  if (typeof modelo === 'string' && MODELO.test(modelo)) p.modelo = modelo;
  return p;
}
const motivoDe = (m) => (MOTIVOS_SIN_PROPUESTA.includes(m) ? m : null);
const motivoPedidoDe = (m) => (MOTIVOS_SIN_PEDIDO.includes(m) ? m : null);
const asignadoDe = (v) => (typeof v === 'string' && IDENTIDAD.test(v) && v !== 'null' ? v : null);

/** El pedido de trabajo: un enlace si tiene forma de enlace, si no su número o clave; nada que no tenga forma. */
function pedidoDe(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = String(v).trim();
  // el vacío de YAML escrito a mano (`null`, `~`) no es un pedido: así lo lee también daily-summary.js
  if (/^(null|~)$/i.test(t)) return null;
  // la marca de la noche mientras pide no es un pedido
  if (t === PIDIENDO) return null;
  if (ENLACE.test(t)) return { id: null, enlace: t };
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(t)) return { id: t, enlace: null };
  return null;
}

/**
 * La vista común de una ficha de cualquier fuente: `{ fuente, id, causa, nombre, primera_vez, ultima_vez, apariciones,
 * veredicto, estado }`, más `resuelto` y `reaparecido` (las fechas de dependencias), la propuesta del modelo
 * (`propuesta`, `propuesta_motivo`), el pedido de trabajo (`pedido: { id, enlace }`), `asignado`, las `noches` de
 * dependencias y `pr_noche`, el número del pedido que la noche abrió por la ficha si sigue abierto. Sin texto libre. Una ficha que no se lee lanza; una vieja de ejecuciones da `null`.
 */
function comoFicha(fuente, txt) {
  if (fuente === 'ejecuciones') {
    if (esVieja(txt)) return null;
    const f = parsear(txt);
    const pr = f.propuesta;
    return { fuente, id: f.id, causa: f.causa, nombre: f.nombre, primera_vez: f.primera_vez, ultima_vez: f.ultima_vez,
      apariciones: f.apariciones, veredicto: f.veredicto, estado: f.estado, resuelto: null, reaparecido: null,
      propuesta: pr ? propuestaDe(pr.accion, pr.razon, pr.modelo) : null, propuesta_motivo: motivoDe(f.propuesta_motivo),
      pedido: pedidoDe(f.pedido), asignado: f.asignado || null, pedido_motivo: motivoPedidoDe(f.pedido_motivo), noches: null, pr_noche: null };
  }
  const reg = FUENTES[fuente];
  if (!reg || !reg.formato) throw new Error(`fuente desconocida: ${fuente}`);
  const fi = reg.formato.leerFicha(String(txt));
  const e = fi.escalares;
  const { estado, veredicto } = reg.vista(fi);
  // el pedido que abrió la noche por la ficha (`pr:`), si sigue abierto: ni rechazado ni cerrado
  const prNoche = e.rechazado || e.pr_cerrado ? null : entero(e.pr);
  const comun = { veredicto, estado, propuesta: propuestaDe(e.propuesta_accion, e.propuesta_razon, e.propuesta_modelo),
    propuesta_motivo: motivoDe(e.propuesta_motivo), asignado: null, pedido_motivo: null, pr_noche: prNoche };
  if (fuente === 'dependencias') {
    // `pedidos:` es la lista «Proyecto: id» de los pedidos del líder; el último es el vigente
    const ultimo = reg.formato.listaDe(String(txt), 'pedidos').slice(-1)[0];
    const m = ultimo ? /:\s*(\d+)$/.exec(ultimo) : null;
    return { fuente, id: e.id || null, causa: e.id || null, nombre: nombreDe('dependencias', e), primera_vez: fecha(e.detectado),
      ultima_vez: null, apariciones: entero(e.noches), resuelto: fecha(e.resuelto), reaparecido: fecha(e.reaparecido), ...comun,
      pedido: m ? { id: m[1], enlace: null } : null, noches: entero(e.noches) };
  }
  return { fuente, id: e.id || null, causa: e.causa || e.huella || null, nombre: nombreDe('vigilante', e), primera_vez: fecha(e.fecha),
    ultima_vez: fecha(e.vista_por_ultima_vez), apariciones: entero(e.noches_seguidas) || 1, resuelto: null, reaparecido: null, ...comun,
    // el pedido que creó la noche y, sin él, la story que creó una persona con /tycon-vigilante
    pedido: pedidoDe(e.pedido) || pedidoDe(e.story_creada), asignado: asignadoDe(e.asignado), pedido_motivo: motivoPedidoDe(e.pedido_motivo),
    noches: null };
}

module.exports = { FUENTES, ORDEN_FICHA, ORDEN_VIGILANTE, CLAVES_LISTA, CLAVES_DE_PROPUESTA, VEREDICTO_COMUN, esVieja, comoFicha };
