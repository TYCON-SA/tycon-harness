// Los nombres en llano de cada causa que encuentra la noche, por fuente. Es lo que leen el resumen de la mañana y el
// campo `nombre` de la ficha común: nunca el código de la regla, que queda en la ficha.
//
// Ejecuciones nombra por regla y categoría con la tabla de abajo; dependencias y el vigilante, con su propio campo
// (paquete y severidad; tipo de hallazgo). Siempre un renglón de hasta 120 caracteres sin caracteres de control: el
// nombre lo pone el arnés, nunca un texto de afuera.

// el nombre de cada causa para quien lee el resumen: por regla, `_` es el de una categoría que la tabla no conoce
const NOMBRES_CAUSA = {
  'RR-ESCAPE': {
    _: 'otro freno salteado',
    TYCON_PR_BY_HAND: 'pedido armado a mano', PR_A_MANO: 'pedido armado a mano',
    TYCON_NO_DEEP_REVIEW: 'pase adversarial salteado', ADVERSARIAL_SKIP_FORZADO: 'pase adversarial salteado',
    ADVERSARIAL_RELAUNCH: 'pase adversarial relanzado',
    TYCON_FULL_SUITE: 'suite completa forzada', FULL_SUITE_RUN: 'suite completa forzada',
    GIT_NO_VERIFY: 'commit sin controles', '--no-verify': 'commit sin controles',
    ATDD_BYPASS: 'pruebas primero salteadas', atddBypass: 'pruebas primero salteadas', ATDD_PREEDIT_BYPASS: 'pruebas primero salteadas',
    MUTATION_BYPASS: 'prueba de mutación salteada', TYCON_RUNTIME_MATRIX_NO_MUTATION_CHECK: 'prueba de mutación salteada',
    TYCON_SAFETY_OFF: 'freno de seguridad apagado', TYCON_SESSION_GUARD_OK: 'freno de sesiones salteado',
    TYCON_ENGRAM_MANIFEST_OK: 'freno de memoria salteado', STOP_AUTONOMY: 'cierre sin esperar a la persona',
    DOD_EVIDENCE_MANUAL_WRITE: 'evidencia escrita a mano', SIZE_FORCED_LIGHT_WITH_CODE: 'pipeline liviano con código',
    'story-skill-bypass': 'freno de stories salteado', STORY_SKILL_BYPASS: 'freno de stories salteado',
  },
  'RR-NODE': { _: 'guion del arnés que no arrancó', 'node-viejo': 'Node viejo', carga: 'guion del arnés que no cargó' },
  'RR-HOOK': { _: 'aviso automático con error' },
  'RR-APAGO': { _: 'pipeline pasado a manual' },
  'RR-BANDERA': { _: 'paso del arranque que falló' },
  'RR-CIERRE': {
    _: 'cierre desconocido', abortada: 'ejecución abortada', abandonada: 'ejecución abandonada',
    incoherente: 'cerrada con pendientes', derivada: 'cerrada con pendientes', 'sin-cerrar': 'ejecución sin cerrar',
  },
};
const HOOK_TIEMPO = 'aviso automático que se pasó de tiempo';
const hasOwnCausa = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/**
 * El nombre de una causa de ejecuciones (`{ regla, categoria }`); la regla tiene que estar en la tabla. Una variante
 * (`X/variante`) que la tabla no nombra lleva el nombre de `X`.
 */
const nombreCausa = (c) => {
  const t = NOMBRES_CAUSA[c.regla];
  if (c.regla === 'RR-HOOK' && typeof c.categoria === 'string' && c.categoria.endsWith('/tiempo')) return HOOK_TIEMPO;
  if (c.categoria === null || typeof c.categoria !== 'string') return t._;
  if (hasOwnCausa(t, c.categoria)) return t[c.categoria];
  const raiz = c.categoria.split('/')[0];
  return raiz !== c.categoria && hasOwnCausa(t, raiz) ? t[raiz] : t._;
};
const NOMBRES_VALIDOS = new Set([HOOK_TIEMPO, ...Object.values(NOMBRES_CAUSA).flatMap((t) => Object.values(t))]);

const TOPE = 120;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/g;
/** Un renglón de hasta 120 caracteres, sin controles; vacío pasa a «?». */
const renglon = (s) => (String(s == null ? '' : s).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim() || '?').slice(0, TOPE);

/**
 * El nombre en llano de la causa de una ficha: ejecuciones por regla y categoría (una regla que la tabla no conoce, con
 * su código); dependencias, `<paquete> (<severidad>)`; el vigilante, su tipo de hallazgo (`regla`).
 */
function nombreDe(fuente, x) {
  const o = x || {};
  if (fuente === 'ejecuciones') {
    if (!hasOwnCausa(NOMBRES_CAUSA, o.regla)) return renglon(o.regla);
    return renglon(nombreCausa({ regla: o.regla, categoria: o.categoria === undefined ? null : o.categoria }));
  }
  if (fuente === 'dependencias') return renglon(o.severidad ? `${o.paquete} (${o.severidad})` : o.paquete);
  if (fuente === 'vigilante') return renglon(o.regla);
  throw new Error(`fuente desconocida: ${fuente}`);
}

// Lo que cuenta aparte: se ve en la ficha, pero no es una falla nueva del arnés. El resumen de la mañana y el ciclo de
// las fichas no lo suman, y el sitio no lo pregunta; una categoría fuera de esta lista sigue siendo una falla. Vive acá,
// y no en la regla que la crea, porque el sitio la lee y la imagen del sitio no lleva las reglas de la revisión.
const APARTE = Object.freeze({
  'RR-ESCAPE:GIT_NO_VERIFY/laboratorio': 'un commit sin los hooks de git en una carpeta de laboratorio: pruebas y ensayos, no trabajo de un producto',
  'RR-ESCAPE:PR_A_MANO/sobra': 'el pedido armado con el escape cumplía la regla del freno: el prefijo estaba de más',
  'RR-CIERRE:derivada/arnes-anterior': 'la ejecución se archivó antes de que el arnés dejara la constancia del cierre (8.92)',
  'RR-ESCAPE:ADVERSARIAL_RELAUNCH/dato': 'relanzar el pase adversarial no esquiva nada: el pase corre igual',
  'RR-ESCAPE:SIZE_FORCED_LIGHT_WITH_CODE/con-motivo': 'la ejecución liviana con código trae su motivo: es una decisión anotada',
  'RR-ESCAPE:FULL_SUITE_RUN/laboratorio': 'la suite completa en una carpeta de laboratorio no es la de un repo',
  'RR-NODE:en-obra': 'el guion que no cargó es una prueba del arnés en obra (el clon o un worktree), no una pieza instalada',
});

module.exports = { NOMBRES_CAUSA, HOOK_TIEMPO, nombreCausa, NOMBRES_VALIDOS, hasOwnCausa, nombreDe, APARTE };
