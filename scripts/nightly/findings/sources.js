// Las fuentes de la noche que usan el ciclo de la ficha: cómo se llama la carpeta de cada una en el repo
// de operaciones y cómo se leen sus fichas con la forma común. Dependencias y el vigilante conservan su formato y sus
// palabras, y la pieza se los lee con un mapa; ejecuciones escribe la ficha común de cycle.js. Los instintos entran
// después: el ciclo los admite, esta lista todavía no.

const { formatoPorSecciones, parsear, carpetaDe: carpetaComun } = require('./cycle.js');
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
  'vista_por_ultima_vez', 'noches_seguidas', 'recordado_el', 'story_creada'];

/** El estado y el veredicto comunes de un borrador del vigilante: mismas palabras que dependencias. Todavía no se
 *  resuelve ni reaparece: el estado es siempre `viva`. */
const vistaVigilante = (fi) => ({ estado: 'viva', veredicto: VEREDICTO_COMUN[fi.escalares.veredicto] || 'pendiente' });

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

/**
 * La vista común de una ficha de cualquier fuente: `{ fuente, id, causa, nombre, primera_vez, ultima_vez, apariciones,
 * veredicto, estado }`, más `resuelto` y `reaparecido` (las fechas de dependencias). Sin texto libre. Una ficha que no se
 * lee lanza; una vieja de ejecuciones da `null`.
 */
function comoFicha(fuente, txt) {
  if (fuente === 'ejecuciones') {
    if (esVieja(txt)) return null;
    const f = parsear(txt);
    return { fuente, id: f.id, causa: f.causa, nombre: f.nombre, primera_vez: f.primera_vez, ultima_vez: f.ultima_vez,
      apariciones: f.apariciones, veredicto: f.veredicto, estado: f.estado, resuelto: null, reaparecido: null };
  }
  const reg = FUENTES[fuente];
  if (!reg || !reg.formato) throw new Error(`fuente desconocida: ${fuente}`);
  const fi = reg.formato.leerFicha(String(txt));
  const e = fi.escalares;
  const { estado, veredicto } = reg.vista(fi);
  if (fuente === 'dependencias') {
    return { fuente, id: e.id || null, causa: e.id || null, nombre: nombreDe('dependencias', e), primera_vez: fecha(e.detectado),
      ultima_vez: null, apariciones: entero(e.noches), veredicto, estado, resuelto: fecha(e.resuelto), reaparecido: fecha(e.reaparecido) };
  }
  return { fuente, id: e.id || null, causa: e.causa || e.huella || null, nombre: nombreDe('vigilante', e), primera_vez: fecha(e.fecha),
    ultima_vez: fecha(e.vista_por_ultima_vez), apariciones: entero(e.noches_seguidas) || 1, veredicto, estado, resuelto: null, reaparecido: null };
}

module.exports = { FUENTES, ORDEN_FICHA, ORDEN_VIGILANTE, CLAVES_LISTA, VEREDICTO_COMUN, esVieja, comoFicha };
