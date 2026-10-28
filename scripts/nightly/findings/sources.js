// Las fuentes de la noche que usan el ciclo de la ficha: cómo se llama la carpeta de cada una en el repo
// de operaciones y cómo se leen sus fichas con la forma común. Dependencias y el vigilante conservan su formato y sus
// palabras, y la pieza se los lee con un mapa; ejecuciones escribe la ficha común de cycle.js. Los instintos entran
// después: el ciclo los admite, esta lista todavía no.

const { formatoPorSecciones, parsear, carpetaDe: carpetaComun, razonSegura, ACCIONES, ACCIONES_DE_DEPENDENCIAS, MOTIVOS_SIN_PROPUESTA, MOTIVOS_SIN_ANALISIS, MOTIVOS_SIN_PEDIDO, PIDIENDO, IDENTIDAD, conValor,
  problemasDeAnalisis, hechosConForma, FALLAS_MAX } = require('./cycle.js');
const { nombreDe } = require('./cause-names.js');

// ── dependencias: su formato y sus palabras de hoy ─────────────────────────────────────────────

const CLAVES_LISTA = ['ids', 'repos', 'declarada_en', 'avisos'];

/** El orden canónico de las claves. Sólo se usa para saber DÓNDE insertar una clave que no está. */
const ORDEN_FICHA = ['id', 'detectado', 'veredicto', 'paquete', 'severidad', 'noches', 'noches_sin_aparecer', 'noche_contada',
  // La identidad del pull request y la decisión que una persona tomó sobre él. Van
  // juntas y arriba porque son lo que el pipeline lee ANTES de decidir si abre uno nuevo.
  'pr', 'pr_repo', 'rechazado', 'motivo_rechazo', 'pr_cerrado', 'alineado', 'decidido_en_sitio',
  // La decisión del sitio que la noche no pudo aplicar (el pedido cambió, no se pudo mergear o cerrar): el día y por qué.
  'decision_fallida', 'motivo_decision_fallida',
  'reaparecido', 'bloqueada_por', 'resuelto', 'resuelto_antes', 'descartado', 'descartado_antes',
  'motivo', 'motivo_antes', 'pr_antes', 'pr_repo_antes', 'rechazado_antes', 'motivo_rechazo_antes',
  'ids', 'repos', 'declarada_en', 'avisos', 'pedido_motivo', 'pedidos', 'asignados'];

// Por qué una vulnerabilidad sigue sin la tarea de algún proyecto (`pedido_motivo:`, lo escribe work-items.js): la
// noche llegó a su tope, un repo no tiene proyecto conocido, o un paso falló al pedirla.
const MOTIVOS_SIN_TAREA = ['tope', 'sin-proyecto', 'falla'];

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
  'senal', 'diagnostico', 'ultimo_deploy', 'ya_alertado_por_azure', 'evidencia', 'reincidente', 'veredicto', 'decidido_en_sitio', 'motivo',
  'vista_por_ultima_vez', 'noches_seguidas', 'recordado_el', 'noches_sin_aparecer', 'noche_contada', 'veredicto_anterior',
  'resuelta_el', 'reaparecio_el', 'aviso_volvio_el', 'aviso_cerrado_el', 'story_creada', 'pedido', 'asignado', 'pedido_motivo'];

/** El estado y el veredicto comunes de un borrador del vigilante: mismas palabras que dependencias. El estado sale de
 *  sus fechas: `resuelta_el` lo resuelve; si no, `reaparecio_el` dice que volvió. */
function vistaVigilante(fi) {
  const e = fi.escalares;
  const estado = fecha(e.resuelta_el) ? 'resuelta' : fecha(e.reaparecio_el) ? 'reaparecio' : 'viva';
  return { estado, veredicto: VEREDICTO_COMUN[e.veredicto] || 'pendiente' };
}

/**
 * Un bloque con sangría (`senal:`, `reincidente:`, `analisis:`) como `{ clave: valor }`: el formato por secciones lee
 * sólo las claves de arriba. Los valores van sin comillas; `null` y `~` son null; un número entero, número.
 */
function bloqueDe(txt, clave) {
  const m = new RegExp(`^${clave}:[ \\t]*\\n((?:[ \\t]+[a-z_]+:.*\\n?)*)`, 'm').exec(String(txt));
  if (!m) return null;
  const b = {};
  for (const l of m[1].split('\n')) {
    const x = /^[ \t]+([a-z_]+):[ \t]*(.*)$/.exec(l);
    if (!x) continue;
    const v = x[2].trim();
    b[x[1]] = /^(null|~|)$/i.test(v) ? null : /^-?\d{1,12}$/.test(v) ? Number(v) : v.replace(/^"([\s\S]*)"$/, '$1');
  }
  return b;
}

const REGLAS_DEL_VIGILANTE = ['deriva', 'goteo', 'desagregacion', 'latido'];
const SEVERIDADES_DEL_VIGILANTE = ['critica', 'alta', 'media', 'baja'];
const RUTA = /^\/[A-Za-z0-9/_.{}-]{0,200}$/;
const NOMBRE_DE_PIEZA = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const numero = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** La mediana de la duración de la evidencia, en milisegundos: sólo el número, nada del texto. */
function duracionMediana(evidencia) {
  const ds = [];
  for (const l of evidencia) {
    let x;
    try { x = JSON.parse(l); } catch { continue; }
    if (x && Number.isFinite(x.duracion_ms) && x.duracion_ms >= 0) ds.push(Math.round(x.duracion_ms));
  }
  if (!ds.length) return null;
  ds.sort((a, b) => a - b);
  const mitad = Math.floor(ds.length / 2);
  return ds.length % 2 ? ds[mitad] : Math.round((ds[mitad - 1] + ds[mitad]) / 2);
}

/** Los datos del borrador del vigilante con forma: números, la ruta, el nombre del plugin y de la regla. */
function hechosDelVigilante(e, txt, listaDe) {
  // el borrador escribe `plugin: null`: es la falta del dato, no un plugin llamado «null»
  const dato = (v) => (/^(null|~)?$/i.test(String(v === undefined || v === null ? '' : v).trim()) ? '' : String(v));
  const senal = bloqueDe(txt, 'senal') || {};
  const reincidente = bloqueDe(txt, 'reincidente') || {};
  return {
    errores: numero(senal.errores), total_pedidos: numero(senal.total_pedidos), estado_http: numero(senal.estado_http),
    endpoint: RUTA.test(dato(e.endpoint)) ? e.endpoint : null,
    plugin: NOMBRE_DE_PIEZA.test(dato(e.plugin)) ? e.plugin : null,
    regla: REGLAS_DEL_VIGILANTE.includes(e.regla) ? e.regla : null,
    reincidente_desde: fecha(reincidente.desde), duracion_ms: duracionMediana(listaDe(String(txt), 'evidencia')),
    producto: NOMBRE_DE_PIEZA.test(dato(e.producto)) ? e.producto : null,
  };
}

/** El análisis, si tiene la forma cerrada de cycle.js; si no, ninguno: nunca uno a medias. */
function analisisDe(a) {
  if (!a || typeof a !== 'object') return null;
  const limpio = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== undefined));
  return problemasDeAnalisis(limpio).length ? null : limpio;
}
const motivoDeAnalisis = (m) => (MOTIVOS_SIN_ANALISIS.includes(m) ? m : null);

// El nombre de quien tiene la tarea, como lo guarda la noche: nunca un correo
const NOMBRE_DE_PERSONA = /^[^\s@"<>`\u0000-\u001f][^@"<>`\u0000-\u001f]{0,79}$/u;
// Lo que anota la noche en `asignados:` cuando leyó la tarea y no la tiene nadie. No tiene forma de nombre: un lector
// que no la conoce no la muestra como persona.
const SIN_ASIGNAR = '<nadie>';

/** Las tareas de una vulnerabilidad: `[{ proyecto, id, asignado }]`, de `pedidos:` («Proyecto: id») y `asignados:` («id: Nombre»). */
function tareasDe(txt, listaDe) {
  const sinComillas = (l) => l.replace(/^"([\s\S]*)"$/, '$1');
  const nombres = new Map();
  const nadie = new Set();
  for (const l of listaDe(txt, 'asignados').map(sinComillas)) {
    const m = /^(\d{1,12}):\s*(.+)$/.exec(l);
    if (m && m[2].trim() === SIN_ASIGNAR) nadie.add(m[1]);
    else if (m && NOMBRE_DE_PERSONA.test(m[2].trim())) nombres.set(m[1], m[2].trim());
  }
  return listaDe(txt, 'pedidos').map(sinComillas).map((l) => /^(.{1,120}?):\s*(\d{1,12})$/.exec(l)).filter(Boolean)
    .map((m) => ({ proyecto: m[1].trim(), id: m[2], asignado: nombres.get(m[2]) || null, sin_asignar: nadie.has(m[2]) }));
}

// Las claves de la propuesta del modelo en el formato por secciones (dependencias y el vigilante). La ficha común las
// lleva en `propuesta`, `propuesta_motivo`, `propuesta_fallas` y `propuesta_fallo_el`.
const CLAVES_DE_PROPUESTA = ['propuesta_accion', 'propuesta_razon', 'propuesta_modelo', 'propuesta_motivo', 'propuesta_fallas',
  'propuesta_fallo_el'];
// Lo que la noche deja en una ficha de dependencias del aviso de GitHub: el resumen, la versión que corrige, o el motivo.
const CLAVES_DEL_AVISO = ['aviso_resumen', 'aviso_parche', 'aviso_motivo'];

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
function propuestaDe(accion, razon, modelo, acciones = ACCIONES) {
  if (!acciones.includes(accion)) return null;
  const p = { accion, razon: razonSegura(razon) ? razon : SIN_FORMA };
  if (typeof modelo === 'string' && MODELO.test(modelo)) p.modelo = modelo;
  return p;
}
const motivoDe = (m) => (MOTIVOS_SIN_PROPUESTA.includes(m) ? m : null);
// El texto del aviso de GitHub que la noche dejó en la ficha (propose.js lo limpia al bajarlo; acá se mira otra vez):
// una línea sin comillas, barras invertidas ni enlaces, con tope (un «<» de un rango de versiones queda: el sitio
// escapa todo lo que muestra). El tope cubre los dos resúmenes que la noche junta, cada uno con el suyo y su CVE. La
// versión que corrige, con forma de versión.
const RESUMEN_DE_AVISO = /^[^"\\\u0000-\u001f\u007f]{1,480}$/;
const PARCHE_DE_AVISO = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}(, [0-9A-Za-z][0-9A-Za-z.+-]{0,39}){0,2}$/;
/** Qué es la vulnerabilidad: `{ resumen, parche }`, `{ motivo: 'no-se-pudo-leer' }` si la noche no pudo leerlo, o null. */
function avisoDe(e) {
  const r = typeof e.aviso_resumen === 'string' ? e.aviso_resumen.trim() : '';
  if (r && RESUMEN_DE_AVISO.test(r) && !/:\/\//.test(r)) return { resumen: r, parche: PARCHE_DE_AVISO.test(String(e.aviso_parche || '')) ? e.aviso_parche : null };
  return e.aviso_motivo === 'no-se-pudo-leer' ? { motivo: 'no-se-pudo-leer' } : null;
}
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
 * El número del pedido que creó la noche (`pedido:` de la ficha), al que se le avisa que la falla volvió. La story que
 * anotó una persona (`story_creada`) se muestra como pedido pero no es un número de la plataforma: no recibe avisos.
 */
function pedidoDeLaNocheDe(v) {
  const p = pedidoDe(v);
  return p && p.id && /^\d{1,12}$/.test(p.id) ? p.id : null;
}

/**
 * La story que ya tiene la ficha (`story_creada`, la anotó una persona con /tycon-vigilante): `{ nombre, pedido }`, con el
 * nombre del archivo sin la ruta ni `.md` (null si no tiene forma) y el número del pedido de la ficha (`pr:`). Sin story,
 * null. La noche no le pide tarea a una ficha con historia.
 */
function historiaDe(story, pr) {
  if (!conValor(story)) return null;
  const base = String(story).trim().split(/[\\/]/).pop().replace(/\.md$/i, '');
  return { nombre: /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(base) ? base : null, pedido: entero(pr) };
}
const pidiendo = (v) => v !== undefined && v !== null && String(v).trim() === PIDIENDO;

/** Lo que se muestra de los hechos de una ficha de ejecuciones: la clase más común y sus cuentas, sin la cuenta por clase. */
function hechosDeEjecuciones(h) {
  if (!h || !hechosConForma(h)) return null;
  const out = { error_clase: h.error_clase, error_clase_veces: h.error_clase_veces, error_veces: h.error_veces };
  if (h.error_clase === 'salida' && Number.isInteger(h.error_codigo)) out.error_codigo = h.error_codigo;
  return out;
}

/**
 * La vista común de una ficha de cualquier fuente: `{ fuente, id, causa, nombre, primera_vez, ultima_vez, apariciones,
 * veredicto, estado }`, más `resuelto` y `reaparecido` (las fechas de dependencias), en dependencias `aviso` (qué es la
 * vulnerabilidad, del aviso de GitHub: `avisoDe`), la propuesta del modelo
 * (`propuesta`, `propuesta_motivo`), el pedido de trabajo (`pedido: { id, enlace }`), el número del que creó la noche
 * (`pedido_de_la_noche`, el único que recibe el aviso de que volvió y el de que sigue con el pedido cerrado, con su
 * fecha en `aviso_cerrado`), `asignado`, las `noches` de
 * dependencias, `pr_noche`, el número del pedido que la noche abrió por la ficha si sigue abierto, `historia` (la story que
 * ya tiene, `historiaDe`) y `pidiendo` (quedó la marca de una noche que pidió sin anotar el número). Sin texto libre. Una ficha que no se lee lanza; una vieja de ejecuciones da `null`.
 */
function comoFicha(fuente, txt) {
  if (fuente === 'ejecuciones') {
    if (esVieja(txt)) return null;
    const f = parsear(txt);
    const pr = f.propuesta;
    return { fuente, id: f.id, causa: f.causa, nombre: f.nombre, primera_vez: f.primera_vez, ultima_vez: f.ultima_vez,
      apariciones: f.apariciones, veredicto: f.veredicto, estado: f.estado, resuelto: f.resuelta_el || null,
      reaparecido: f.reaparecio_el || null, aviso_volvio: f.aviso_volvio_el || null, aviso_cerrado: f.aviso_cerrado_el || null,
      propuesta: pr ? propuestaDe(pr.accion, pr.razon, pr.modelo) : null, propuesta_motivo: motivoDe(f.propuesta_motivo),
      analisis: analisisDe(f.analisis), analisis_motivo: motivoDeAnalisis(f.analisis_motivo), hechos: hechosDeEjecuciones(f.hechos),
      pedido: pedidoDe(f.pedido), pedido_de_la_noche: pedidoDeLaNocheDe(f.pedido), asignado: f.asignado || null, pedido_motivo: motivoPedidoDe(f.pedido_motivo), noches: null, pr_noche: null,
      historia: historiaDe(f.story_creada, null), pidiendo: pidiendo(f.pedido) };
  }
  const reg = FUENTES[fuente];
  if (!reg || !reg.formato) throw new Error(`fuente desconocida: ${fuente}`);
  const fi = reg.formato.leerFicha(String(txt));
  const e = fi.escalares;
  const { estado, veredicto } = reg.vista(fi);
  // el pedido que abrió la noche por la ficha (`pr:`), si sigue abierto: ni rechazado ni cerrado
  const prNoche = e.rechazado || e.pr_cerrado ? null : entero(e.pr);
  const aviso = fuente === 'dependencias' ? avisoDe(e) : null;
  // una dependencia sin su aviso no lleva sugerencia: el modelo no sabía qué era la vulnerabilidad
  const propuesta = fuente !== 'dependencias' ? propuestaDe(e.propuesta_accion, e.propuesta_razon, e.propuesta_modelo)
    : aviso && aviso.resumen ? propuestaDe(e.propuesta_accion, e.propuesta_razon, e.propuesta_modelo, ACCIONES_DE_DEPENDENCIAS) : null;
  const comun = { veredicto, estado, propuesta,
    propuesta_motivo: motivoDe(e.propuesta_motivo), asignado: null, pedido_motivo: null, pr_noche: prNoche };
  if (fuente === 'dependencias') {
    // `pedidos:` es la lista «Proyecto: id» de las tareas de los líderes, una por proyecto; la última es la vigente
    const pedidos = tareasDe(String(txt), reg.formato.listaDe);
    const ultimo = pedidos[pedidos.length - 1];
    return { fuente, id: e.id || null, causa: e.id || null, nombre: nombreDe('dependencias', e), primera_vez: fecha(e.detectado),
      ultima_vez: null, apariciones: entero(e.noches), resuelto: fecha(e.resuelto), reaparecido: fecha(e.reaparecido), aviso_volvio: null, aviso_cerrado: null, ...comun,
      pedido: ultimo ? { id: ultimo.id, enlace: null } : null, pedido_de_la_noche: null, noches: entero(e.noches),
      pedidos, pedido_motivo: MOTIVOS_SIN_TAREA.includes(e.pedido_motivo) ? e.pedido_motivo : null,
      repos: fi.listas.repos.length, severidad: /^[a-z]{1,20}$/.test(String(e.severidad || '')) ? e.severidad : null,
      aviso, analisis: null, analisis_motivo: null, hechos: null };
  }
  return { fuente, id: e.id || null, causa: e.causa || e.huella || null, nombre: nombreDe('vigilante', e), primera_vez: fecha(e.fecha),
    ultima_vez: fecha(e.vista_por_ultima_vez), apariciones: entero(e.noches_seguidas) || 1, resuelto: fecha(e.resuelta_el),
    reaparecido: fecha(e.reaparecio_el), aviso_volvio: fecha(e.aviso_volvio_el), aviso_cerrado: fecha(e.aviso_cerrado_el), ...comun,
    // el pedido que creó la noche y, sin él, la story que creó una persona con /tycon-vigilante
    pedido: pedidoDe(e.pedido) || pedidoDe(e.story_creada), pedido_de_la_noche: pedidoDeLaNocheDe(e.pedido), asignado: asignadoDe(e.asignado), pedido_motivo: motivoPedidoDe(e.pedido_motivo),
    historia: historiaDe(e.story_creada, e.pr), pidiendo: pidiendo(e.pedido),
    noches: null, analisis: analisisDe(bloqueDe(txt, 'analisis')), analisis_motivo: motivoDeAnalisis(e.analisis_motivo),
    // la noche dejó de pedirle el análisis: falló tres noches seguidas
    analisis_agotado: (entero(e.analisis_fallas) || 0) >= FALLAS_MAX,
    severidad: SEVERIDADES_DEL_VIGILANTE.includes(e.severidad) ? e.severidad : null,
    hechos: hechosDelVigilante(e, txt, reg.formato.listaDe) };
}

module.exports = { SIN_FORMA, CLAVES_DEL_AVISO, bloqueDe, FUENTES, ORDEN_FICHA, ORDEN_VIGILANTE, CLAVES_LISTA, CLAVES_DE_PROPUESTA, VEREDICTO_COMUN, MOTIVOS_SIN_TAREA, NOMBRE_DE_PERSONA, SIN_ASIGNAR, esVieja, comoFicha, pedidoDeLaNocheDe };
