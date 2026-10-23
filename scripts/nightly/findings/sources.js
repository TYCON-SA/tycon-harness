// Las fuentes de la noche que usan el ciclo de la ficha: cómo se llama la carpeta de cada una en el repo
// de operaciones y, para dependencias, cómo se leen sus fichas de hoy con la forma común. Los instintos entran después:
// el ciclo los admite, esta lista todavía no.

const { formatoPorSecciones } = require('./cycle.js');

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

const FUENTES = {
  dependencias: {
    carpeta: 'dependencies',
    extension: '.yaml',
    formato: formatoPorSecciones({ orden: ORDEN_FICHA, listas: CLAVES_LISTA }),
    vista: vistaDependencias,
    carpetaDe: carpetaDependencias,
  },
  vigilante: { carpeta: 'watcher', extension: '.yaml' },
  ejecuciones: { carpeta: 'runs-review', extension: '.yaml' },
};

module.exports = { FUENTES, ORDEN_FICHA, CLAVES_LISTA, VEREDICTO_COMUN };
