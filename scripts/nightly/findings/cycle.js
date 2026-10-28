// El ciclo de la ficha, común a todo lo que encuentra la noche: dependencias, el vigilante y la revisión
// de las ejecuciones. Una ficha es una CAUSA, no un caso: la noche que la vuelve a ver le suma una aparición, la que no
// la ve (y la midió) le suma una noche sin aparecer, y a las N noches medidas seguidas sin aparecer se resuelve.
//
// Acá no hay red: la forma de la ficha, sus carpetas, leerla y escribirla, y contar noches. La plataforma la llama sólo
// `pedirTrabajo`, por la capa de plataforma (scripts/lib/platform/platform.js), y las pruebas se la inyectan. Cada
// fuente dice en sources.js cómo se llama su carpeta y cómo se leen sus fichas; dependencias conserva su formato de hoy
// (secciones de YAML por expresión regular) y la pieza se lo lee con un mapa.
//
// La ficha de las fuentes nuevas se escribe como `clave: <JSON>` por renglón: se lee sin biblioteca de YAML y ningún
// valor puede romper el renglón. Lleva sólo campos con forma (constantes, fechas, números, enlaces, claves estables):
// texto libre de afuera —lo que dijo una sesión, un comentario de un pedido— no entra, y la ficha que lo traiga no se
// escribe.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FUENTES = ['dependencias', 'vigilante', 'ejecuciones'];
const VEREDICTOS = ['pendiente', 'aceptada', 'arreglo', 'ignorada', 'migrada'];
const ESTADOS = ['viva', 'resuelta', 'reaparecio'];
const CARPETAS = ['pending', 'promoted', 'archived', 'decisions'];
const CARPETAS_DE_FICHAS = ['pending', 'promoted', 'archived'];
const ACCIONES = ['aceptar', 'arreglar'];
const TOPE_CASOS = 50;
// Las huellas de los casos ya vistos: así un caso que salió de la ventana de 50 y vuelve no se cuenta dos veces.
const TOPE_HUELLAS = 1000;
const NOCHES_POR_DEFECTO = 3;

// El orden en que se escribe la ficha común. `noches_sin_aparecer` y `noche_contada` (la fecha de la última noche
// contada) sólo están mientras cuenta; `resuelta_el` mientras está resuelta; `reaparecio_el` desde la noche que volvió,
// `aviso_volvio_el`, el día que se le avisó a su pedido que volvió, y `aviso_cerrado_el`, el día que se le avisó a su
// pedido cerrado que la falla sigue (o que se vio que el pedido ya no existe).
const CLAVES = ['id', 'fuente', 'causa', 'nombre', 'primera_vez', 'ultima_vez', 'apariciones', 'noches_sin_aparecer',
  'noche_contada', 'resuelta_el', 'reaparecio_el', 'aviso_volvio_el', 'aviso_cerrado_el', 'veredicto', 'veredicto_anterior', 'decidido_en_sitio', 'propuesta', 'propuesta_motivo', 'propuesta_fallas', 'propuesta_fallo_el',
  'hechos', 'analisis', 'analisis_motivo', 'pedido', 'asignado', 'pedido_motivo', 'estado', 'casos', 'casos_total', 'casos_vistos'];
// Por qué un arreglo quedó sin pedido o sin asignado: una lista cerrada, nunca el texto de un error.
const MOTIVOS_SIN_PEDIDO = ['sin-responsable', 'plataforma-sin-asignado', 'plataforma-caida', 'sin-confirmar', 'sin-configurar'];
// La marca que la noche deja en la ficha antes de pedirle el pedido a la plataforma: una ficha que la tiene sin id no
// vuelve a pedir (la noche anterior pudo crearlo y cortarse antes de anotarlo).
const PIDIENDO = 'pidiendo';
// Por qué una ficha quedó sin propuesta del modelo: una lista cerrada, nunca el texto de un error. `tope` y `sin-escribir`
// (la ficha no se pudo escribir) no se escriben en la ficha: los cuenta la constancia de la noche.
const MOTIVOS_SIN_PROPUESTA = ['sin-modelo', 'sin-llave', 'no-permitido', 'modelo-caido', 'respuesta-invalida', 'tope', 'sin-escribir'];
// Por qué una ficha quedó sin análisis: los de la propuesta, más `no-aporta` (el del modelo no citaba ningún dato o
// repetía el problema, y se descartó) y `sin-hechos` (la ficha es de antes de que la noche guardara sus datos).
const MOTIVOS_SIN_ANALISIS = [...MOTIVOS_SIN_PROPUESTA, 'no-aporta', 'sin-hechos'];
// El análisis de una ficha: qué se recomienda, por qué pasa, por qué se recomienda, qué se arreglaría y qué hacer si
// vuelve, con quién lo escribió. Cada texto con su tope; `arreglo` sólo y siempre con «arreglar».
const TOPES_DE_ANALISIS = { por_que_pasa: 220, por_que_recomienda: 160, arreglo: 220, si_vuelve: 160 };
const AUTORES = ['modelo', 'persona'];
// La clase de un error, de una lista cerrada: la ficha nunca lleva el texto del error. `salida` va con su código.
const CLASES_DE_ERROR = ['sin-procesos', 'tiempo', 'archivo-no-encontrado', 'json-ilegible', 'node-viejo', 'permiso', 'red', 'salida', 'otro'];
// Las noches seguidas que una ficha puede fallar antes de dejar de pedirle propuesta.
const FALLAS_MAX = 3;

/**
 * ¿La razón del modelo se puede guardar y mostrar? Una frase corta: letras, números, espacio y la puntuación común.
 * Nada que parezca una ruta, un enlace, un dominio, un correo, código o un número (un pedido, un teléfono): a lo sumo
 * cinco cifras en toda la frase. Nombrar el protocolo («el cliente HTTP») vale: un enlace necesita la barra, que no
 * está entre los signos permitidos, y un dominio lo frena su forma.
 */
function razonSegura(t) {
  return typeof t === 'string' && t.trim() === t && t.length >= 1 && t.length <= 200
    && /^[\p{L}\p{N} .,;:()¿?¡!«»'-]+$/u.test(t) && !/www\./i.test(t)
    && !/[\p{L}\p{N}-]\.[a-z]{2,}\b/iu.test(t) && (t.match(/\p{N}/gu) || []).length <= 5;
}

/**
 * ¿Un texto del análisis se puede guardar y mostrar? Más ancho que `razonSegura` (lleva fechas, cantidades y nombres
 * de piezas), pero un renglón y sin nada que lleve a otro lado o se ejecute: ni enlaces, ni dominios, ni correos, ni
 * etiquetas, ni código.
 */
function textoDeAnalisis(t, tope) {
  return typeof t === 'string' && t.trim() === t && t.length >= 1 && t.length <= tope && !CONTROL.test(t)
    && !/:\/\/|www\.|@|[<>`]/i.test(t) && !/[\p{L}\p{N}-]\.[a-z]{2,}\b/iu.test(t);
}

/** Los problemas de forma de un análisis; vacío si se puede escribir. */
function problemasDeAnalisis(a) {
  if (!esObjeto(a)) return ['analisis: sin forma'];
  const p = [];
  const permitidas = ['recomendacion', ...Object.keys(TOPES_DE_ANALISIS), 'autor', 'modelo', 'el'];
  for (const k of Object.keys(a)) if (!permitidas.includes(k)) p.push(`analisis.${k}: no es un campo del análisis`);
  if (!ACCIONES.includes(a.recomendacion)) p.push('analisis.recomendacion: aceptar o arreglar');
  for (const k of ['por_que_pasa', 'por_que_recomienda']) if (!textoDeAnalisis(a[k], TOPES_DE_ANALISIS[k])) p.push(`analisis.${k}: sin forma`);
  if (a.recomendacion === 'arreglar' ? !textoDeAnalisis(a.arreglo, TOPES_DE_ANALISIS.arreglo) : 'arreglo' in a) p.push('analisis.arreglo: sólo y siempre con arreglar');
  if ('si_vuelve' in a && !textoDeAnalisis(a.si_vuelve, TOPES_DE_ANALISIS.si_vuelve)) p.push('analisis.si_vuelve: sin forma');
  if (!AUTORES.includes(a.autor)) p.push('analisis.autor: modelo o persona');
  if ('modelo' in a && !(typeof a.modelo === 'string' && CLAVE.test(a.modelo))) p.push('analisis.modelo: sin forma');
  if (!(typeof a.el === 'string' && FECHA.test(a.el))) p.push('analisis.el: no es una fecha');
  return p;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const CLAVE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const HUELLA = /^[0-9a-f]{8}$/;
const ENLACE = /^https:\/\/[^\s"'<>\\]{1,500}$/;
// una identidad (usuario o correo): sin espacios ni comillas dobles ni «<>», que la vista del vigilante no muestra
const IDENTIDAD = /^[^\s@"<>]+(@[^\s@"<>]+)?$/;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const CLAVE_DE_CASO = /^[a-z][a-z0-9_]{0,39}$/;

const esObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const entero = (v, min) => Number.isInteger(v) && v >= min;

/** Un valor de un caso con forma: número, sí/no, fecha, enlace o clave estable. */
function valorConForma(v) {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && (FECHA.test(v) || ENLACE.test(v) || CLAVE.test(v));
}

/** ¿Los hechos de una ficha tienen forma? La cuenta por clase y la más común, con números; nada de texto. */
function hechosConForma(h) {
  if (!esObjeto(h) || Object.keys(h).some((k) => !['errores', 'error_clase', 'error_clase_veces', 'error_veces', 'error_codigo'].includes(k))) return false;
  if (!esObjeto(h.errores) || Object.entries(h.errores).some(([k, v]) => !CLASES_DE_ERROR.includes(k) || !entero(v, 1))) return false;
  if (!CLASES_DE_ERROR.includes(h.error_clase) || !entero(h.error_clase_veces, 1) || !entero(h.error_veces, h.error_clase_veces)) return false;
  return !('error_codigo' in h) || entero(h.error_codigo, 0);
}

/**
 * Suma a los hechos de una ficha los errores de un caso nuevo (`{ errores: { clase: n }, codigo }`) y recalcula la clase
 * más común; en un empate, la que ya era la más común.
 */
function sumarErrores(hechos, de) {
  if (!de || !esObjeto(de.errores)) return hechos;
  const errores = { ...((hechos && hechos.errores) || {}) };
  let suma = 0;
  for (const [k, v] of Object.entries(de.errores)) if (CLASES_DE_ERROR.includes(k) && entero(v, 1)) { errores[k] = (errores[k] || 0) + v; suma += v; }
  if (!suma) return hechos;
  const max = Math.max(...Object.values(errores));
  const antes = hechos && hechos.error_clase;
  const clase = errores[antes] === max ? antes : CLASES_DE_ERROR.find((k) => errores[k] === max);
  const h = { errores, error_clase: clase, error_clase_veces: errores[clase], error_veces: Object.values(errores).reduce((a, b) => a + b, 0) };
  const codigo = entero(de.codigo, 0) ? de.codigo : hechos && hechos.error_codigo;
  if (errores.salida && entero(codigo, 0)) h.error_codigo = codigo;
  return h;
}

/** Los problemas de forma de una ficha común; vacío si se puede escribir. */
function problemasDeForma(f) {
  if (!esObjeto(f)) return ['la ficha no es un objeto'];
  const p = [];
  for (const k of Object.keys(f)) if (!CLAVES.includes(k)) p.push(`${k}: no es un campo de la ficha`);
  if (!(typeof f.id === 'string' && CLAVE.test(f.id))) p.push('id: sin forma');
  if (!FUENTES.includes(f.fuente)) p.push('fuente: desconocida');
  if (!(typeof f.causa === 'string' && CLAVE.test(f.causa))) p.push('causa: no es una clave estable');
  // el nombre en llano lo pone el arnés (los nombres de cada causa), nunca un texto de afuera
  if (!(typeof f.nombre === 'string' && f.nombre.trim() && f.nombre.length <= 120 && !CONTROL.test(f.nombre))) {
    p.push('nombre: tiene que ser un renglón de hasta 120 caracteres');
  }
  for (const k of ['primera_vez', 'ultima_vez']) if (!(typeof f[k] === 'string' && FECHA.test(f[k]))) p.push(`${k}: no es una fecha`);
  if (!entero(f.apariciones, 1)) p.push('apariciones: tiene que ser un entero mayor que 0');
  if ('noches_sin_aparecer' in f && !entero(f.noches_sin_aparecer, 0)) p.push('noches_sin_aparecer: tiene que ser un entero');
  for (const k of ['noche_contada', 'resuelta_el', 'reaparecio_el', 'aviso_volvio_el', 'aviso_cerrado_el']) {
    if (k in f && !(typeof f[k] === 'string' && FECHA.test(f[k]))) p.push(`${k}: no es una fecha`);
  }
  if (!VEREDICTOS.includes(f.veredicto)) p.push('veredicto: fuera del vocabulario');
  if (f.veredicto_anterior !== null && !VEREDICTOS.includes(f.veredicto_anterior)) p.push('veredicto_anterior: fuera del vocabulario');
  if (f.propuesta !== null) {
    const pr = f.propuesta;
    if (!esObjeto(pr) || !ACCIONES.includes(pr.accion)
      || !(typeof pr.razon === 'string' && pr.razon.length <= 200 && !CONTROL.test(pr.razon))
      || Object.keys(pr).some((k) => !['accion', 'razon', 'modelo'].includes(k))
      || (pr.modelo !== undefined && !(typeof pr.modelo === 'string' && CLAVE.test(pr.modelo)))) {
      p.push('propuesta: sin forma');
    }
  }
  if ('propuesta_motivo' in f && f.propuesta_motivo !== null && !MOTIVOS_SIN_PROPUESTA.includes(f.propuesta_motivo)) p.push('propuesta_motivo: fuera del vocabulario');
  if ('propuesta_fallas' in f && !(entero(f.propuesta_fallas, 0) && f.propuesta_fallas <= FALLAS_MAX)) p.push(`propuesta_fallas: un entero de 0 a ${FALLAS_MAX}`);
  if ('propuesta_fallo_el' in f && !(typeof f.propuesta_fallo_el === 'string' && FECHA.test(f.propuesta_fallo_el))) p.push('propuesta_fallo_el: una fecha');
  if ('decidido_en_sitio' in f && !(typeof f.decidido_en_sitio === 'string' && FECHA.test(f.decidido_en_sitio))) p.push('decidido_en_sitio: no es una fecha');
  if ('hechos' in f && f.hechos !== null && !hechosConForma(f.hechos)) p.push('hechos: sin forma');
  if ('analisis' in f && f.analisis !== null) p.push(...problemasDeAnalisis(f.analisis));
  if ('analisis_motivo' in f && f.analisis_motivo !== null && !MOTIVOS_SIN_ANALISIS.includes(f.analisis_motivo)) p.push('analisis_motivo: fuera del vocabulario');
  if (f.pedido !== null && !(entero(f.pedido, 1) || (typeof f.pedido === 'string' && CLAVE.test(f.pedido)))) p.push('pedido: sin forma');
  if (f.asignado !== null && !(typeof f.asignado === 'string' && IDENTIDAD.test(f.asignado))) p.push('asignado: sin forma');
  if ('pedido_motivo' in f && f.pedido_motivo !== null && !MOTIVOS_SIN_PEDIDO.includes(f.pedido_motivo)) p.push('pedido_motivo: fuera del vocabulario');
  if (!ESTADOS.includes(f.estado)) p.push('estado: fuera del vocabulario');
  if (!Array.isArray(f.casos)) p.push('casos: tiene que ser una lista');
  else {
    if (f.casos.length > TOPE_CASOS) p.push(`casos: más de ${TOPE_CASOS}`);
    f.casos.forEach((c, i) => {
      if (!esObjeto(c) || Object.entries(c).some(([k, v]) => !CLAVE_DE_CASO.test(k) || !valorConForma(v))) {
        p.push(`casos.${i}: un caso lleva sólo campos con forma`);
      }
    });
  }
  if (!(entero(f.casos_total, 0) && Array.isArray(f.casos) && f.casos_total >= f.casos.length)) p.push('casos_total: no cuadra con los casos');
  if ('casos_vistos' in f && !(Array.isArray(f.casos_vistos) && f.casos_vistos.length <= TOPE_HUELLAS
    && f.casos_vistos.every((h) => typeof h === 'string' && HUELLA.test(h)))) p.push('casos_vistos: sin forma');
  return p;
}

/** La misma ficha con sus claves en el orden de escritura. */
function ordenar(f) {
  const out = {};
  for (const k of CLAVES) if (k in f) out[k] = f[k];
  for (const k of Object.keys(f)) if (!(k in out)) out[k] = f[k];
  return out;
}

const huellaDe = (c) => crypto.createHash('sha1').update(JSON.stringify(c)).digest('hex').slice(0, 8);

/**
 * Suma casos nuevos (sin repetir) y guarda los 50 más nuevos; `casos_total` cuenta todos los distintos que hubo. Un
 * caso ya visto no se vuelve a contar aunque haya salido de la ventana: lo dicen las huellas de `casos_vistos` (las
 * últimas 1000).
 */
function conCasos(f, nuevos, errores = []) {
  const casos = [...(f.casos || [])];
  const huellas = [...(f.casos_vistos || casos.map(huellaDe))];
  const vistas = new Set(huellas);
  let total = f.casos_total || casos.length;
  let hechos = f.hechos || null;
  (nuevos || []).forEach((c, i) => {
    const h = huellaDe(c);
    if (vistas.has(h)) return;
    vistas.add(h);
    huellas.push(h);
    casos.push(c);
    total += 1;
    // los errores de un caso se suman una sola vez: con el caso nuevo, no cada noche que se lo vuelve a ver
    hechos = sumarErrores(hechos, errores[i]);
  });
  // los casos llegan en el orden en que se leyeron (carpeta de máquina, nombre de archivo): se ordenan por día antes de
  // cortar, así la ventana guarda los más nuevos. El orden es estable: los del mismo día quedan como llegaron.
  const diaDe = (c) => String((c && (c.dia || c.fecha)) || '');
  casos.sort((a, b) => (diaDe(a) < diaDe(b) ? -1 : diaDe(a) > diaDe(b) ? 1 : 0));
  const g = { ...f, casos: casos.slice(-TOPE_CASOS), casos_total: total, casos_vistos: huellas.slice(-TOPE_HUELLAS) };
  if (hechos) g.hechos = hechos;
  return g;
}

/** El id de una causa: estable por (fuente, causa), así la noche que la vuelve a ver encuentra la misma ficha. */
const idDe = (fuente, causa) => crypto.createHash('sha1').update(`${fuente}|${causa}`).digest('hex').slice(0, 12);

function nuevaFicha({ fuente, causa, nombre, hoy, casos = [], errores = [] }) {
  if (!FUENTES.includes(fuente)) throw new Error(`fuente desconocida: ${fuente}`);
  const f = ordenar(conCasos({
    id: idDe(fuente, causa), fuente, causa, nombre, primera_vez: hoy, ultima_vez: hoy, apariciones: 1,
    veredicto: 'pendiente', veredicto_anterior: null, propuesta: null, pedido: null, asignado: null, estado: 'viva',
    casos: [], casos_total: 0,
  }, casos, errores));
  const p = problemasDeForma(f);
  if (p.length) throw new Error(`la ficha no tiene forma: ${p.join('; ')}`);
  return f;
}

/** ¿La causa que vuelve reabre la ficha? Una resuelta o una ignorada sí; una migrada (la forma de antes) no. */
const seReabre = (f) => f.veredicto !== 'migrada' && (f.estado === 'resuelta' || f.veredicto === 'ignorada');

/**
 * La noche que vuelve a ver la causa: misma ficha, una aparición más (una por noche) y el contador borrado. Una
 * resuelta o una ignorada que vuelve se reabre: `reaparecio`, otra vez pendiente con el veredicto de antes en
 * `veredicto_anterior`, el día en `reaparecio_el`, y sin la propuesta del modelo ni sus fallas (se le vuelve a pedir).
 */
function registrarAparicion(f, hoy, casos, errores = []) {
  const g = conCasos({ ...f }, casos, errores);
  if (g.ultima_vez !== hoy) { g.apariciones = (g.apariciones || 0) + 1; g.ultima_vez = hoy; }
  delete g.noches_sin_aparecer;
  delete g.noche_contada;
  if (seReabre(f)) {
    Object.assign(g, { estado: 'reaparecio', veredicto: 'pendiente', veredicto_anterior: f.veredicto, reaparecio_el: hoy, propuesta: null });
    for (const k of ['resuelta_el', 'aviso_volvio_el', 'aviso_cerrado_el', 'decidido_en_sitio', 'propuesta_motivo', 'propuesta_fallas', 'propuesta_fallo_el']) delete g[k];
  }
  return ordenar(g);
}

/** La ficha viva de una causa entre las leídas (`[{ ficha }]`), o null. */
function fichaDeCausa(fichas, fuente, causa) {
  return fichas.find((x) => x.ficha && x.ficha.fuente === fuente && x.ficha.causa === causa) || null;
}

/**
 * Una noche más para el contador de una ficha. Si la causa se vio esa noche, aunque sea en una parte de lo medido, el
 * contador vuelve a cero. Una noche NO medida no cuenta (no medido nunca es «no apareció»), y una noche ya contada
 * (`noche_contada` es hoy: un reintento o una corrida a mano) tampoco: cuenta noches, no corridas. Con
 * `contador >= n`, la ficha está resuelta. N se lee cada noche: si bajó, lo ya contado alcanza.
 */
function contarNoche({ contador, presente, medida, n, hoy, nocheContada }) {
  const c = Number.isInteger(contador) && contador > 0 ? contador : 0;
  if (presente) return { contador: 0, resuelta: false };
  if (!medida) return { contador: c, resuelta: false };
  if (hoy && nocheContada === hoy) return { contador: c, resuelta: c >= n };
  return { contador: c + 1, resuelta: c + 1 >= n };
}

/**
 * La noche de una ficha común: `contarNoche` sobre sus campos. Devuelve la ficha con su contador y la fecha de la
 * noche contada; si llegó a N, `estado: resuelta` con `resuelta_el` y sin el contador. Una vista hoy (`presente`) sólo
 * pierde el contador.
 */
function noche({ ficha, presente, medida, n, hoy }) {
  const r = contarNoche({ contador: ficha.noches_sin_aparecer, presente, medida, n, hoy, nocheContada: ficha.noche_contada });
  const g = { ...ficha };
  if (presente) { delete g.noches_sin_aparecer; delete g.noche_contada; return ordenar(g); }
  if (medida && g.noche_contada !== hoy) { g.noches_sin_aparecer = r.contador; g.noche_contada = hoy; }
  if (r.resuelta) {
    delete g.noches_sin_aparecer;
    delete g.noche_contada;
    g.estado = 'resuelta';
    g.resuelta_el = hoy;
  }
  return ordenar(g);
}

/** La carpeta de una ficha común según su estado y su veredicto (la mueve sólo la noche). */
function carpetaDe({ estado, veredicto }) {
  if (!VEREDICTOS.includes(veredicto)) throw new Error(`veredicto desconocido: ${veredicto}`);
  if (estado === 'resuelta' || veredicto === 'ignorada' || veredicto === 'migrada') return 'archived';
  return veredicto === 'pendiente' ? 'pending' : 'promoted';
}

/** Las cuatro carpetas de una fuente, bajo `<base>/inbox/<carpeta de la fuente>/`. */
function carpetasDe(base, fuente) {
  const { FUENTES: registro } = require('./sources.js');
  if (!Object.hasOwn(registro, fuente)) throw new Error(`fuente desconocida: ${fuente}`);
  const raiz = path.join(base, 'inbox', registro[fuente].carpeta);
  return Object.fromEntries(CARPETAS.map((c) => [c, path.join(raiz, c)]));
}

function asegurarCarpetas(carpetas) {
  for (const p of Object.values(carpetas)) fs.mkdirSync(p, { recursive: true });
}

/**
 * Las fichas de una fuente, de sus tres carpetas. Una que no se puede leer —o que `leer` rechaza— va a `ilegibles`
 * (`{ ficha: 'carpeta/archivo', motivo }`) y no frena a las demás.
 */
function leerCarpetas(dirFuente, { leer, extension = '.yaml' }) {
  const fichas = [];
  const ilegibles = [];
  for (const carpeta of CARPETAS_DE_FICHAS) {
    const dir = path.join(dirFuente, carpeta);
    if (!fs.existsSync(dir)) continue;
    for (const nombre of fs.readdirSync(dir).filter((x) => x.endsWith(extension)).sort()) {
      const ruta = path.join(dir, nombre);
      try {
        const txt = fs.readFileSync(ruta, 'utf8');
        fichas.push({ carpeta, nombre, ruta, txt, ficha: leer(txt) });
      } catch (e) {
        ilegibles.push({ ficha: `${carpeta}/${nombre}`, motivo: (e && e.code) || 'sin forma' });
      }
    }
  }
  return { fichas, ilegibles };
}

const CABECERA = '# Ficha de lo que encontró la noche (story 4.11). La mueve sólo la noche; sin texto libre de afuera, a propósito.\n';

function serializar(f) {
  const p = problemasDeForma(f);
  if (p.length) throw new Error(`la ficha no tiene forma: ${p.join('; ')}`);
  return CABECERA + Object.entries(ordenar(f)).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n';
}

/** Lee una ficha común; si no tiene forma, lanza (quien recorre las carpetas la cuenta como ilegible). */
function parsear(txt) {
  const f = {};
  // \r\n también: una ficha que pasó por un checkout de Windows sigue siendo la misma ficha
  for (const linea of String(txt).split(/\r?\n/)) {
    if (!linea.trim() || linea.startsWith('#')) continue;
    const m = linea.match(/^([a-z_]+): (.*)$/);
    if (!m) throw new Error('renglón sin forma');
    // sólo los campos de la ficha: un `__proto__:` cambiaría el prototipo en vez de ser una clave que se rechaza
    if (!CLAVES.includes(m[1])) throw new Error(`${m[1]}: no es un campo de la ficha`);
    f[m[1]] = JSON.parse(m[2]);
  }
  const p = problemasDeForma(f);
  if (p.length) throw new Error(`la ficha no tiene forma: ${p.join('; ')}`);
  return f;
}

/**
 * N: cuántas noches medidas seguidas sin aparecer resuelven una ficha (`findings.resolve_after_nights` de
 * operations.json). Sin el archivo o sin la clave, 3. Un operations.json que está y no valida no es «el de por
 * defecto»: `ok: false`, y esa noche no se resuelve nada.
 */
function nochesParaResolver(rutaOperations) {
  // Sólo «no existe» es «sin archivo»: uno que está y no se puede leer (permisos, E/S) no es el de por defecto.
  try { fs.statSync(rutaOperations); } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, n: NOCHES_POR_DEFECTO, origen: 'por defecto (sin operations.json)' };
    return { ok: false, n: null, motivo: `operations.json no se pudo leer (${(e && e.code) || 'error'})` };
  }
  const OPS = require('../../lib/operations-config.js');
  const r = OPS.load(rutaOperations);
  // 🔴 El motivo NO copia el problema del lector: trae valores del archivo (correos, identidades), y esto va a la
  // salida de la noche y a su foto. El detalle lo da el lector a mano.
  if (r.couldNotRead) return { ok: false, n: null, motivo: 'operations.json no se pudo leer' };
  if (!r.ok) {
    return { ok: false, n: null, motivo: 'operations.json no valida (el detalle: node scripts/lib/operations-config.js operations.json)' };
  }
  const v = r.data.findings && r.data.findings.resolve_after_nights;
  if (v === undefined) return { ok: true, n: NOCHES_POR_DEFECTO, origen: 'por defecto' };
  return { ok: true, n: v, origen: 'operations.json' };
}

// ── el formato por secciones (el de dependencias) ──────────────────────────────────────────────
//
// 🔴 No hay biblioteca de YAML acá, y es a propósito: CUATRO lectores por expresión regular
// dependen del formato línea a línea (`nightly-dependencies.js`, `dependencies-notice.js`, `pr-text` y un `sed`
// del pipeline). Las listas se leen POR CLAVE, como hace `prTexto`:
// tomar como repo CUALQUIER línea `  - x` del archivo que no sea una URL
// haría que, con la lista `ids:`, un IDENTIFICADOR se exigiera "medido" — y como
// un id nunca está entre los repos medidos, la ficha no se resolvería nunca.

/**
 * Leer y escribir una ficha por sección sin tocar las otras ni los comentarios. `orden` es el orden canónico de las
 * claves (sólo se usa para saber DÓNDE insertar una que no está); `listas`, las claves que son listas.
 */
function formatoPorSecciones({ orden, listas }) {
  const reLista = (k) => new RegExp(`^${k}:[ \\t]*\\n((?:[ \\t]+-[ \\t].*\\n)*)`, 'm');
  const reEscalar = (k) => new RegExp(`^${k}:[ \\t]*(.*)$`, 'm');

  function listaDe(txt, k) {
    const m = txt.match(reLista(k));
    if (!m) return [];
    return m[1].split('\n').filter((l) => l.trim()).map((l) => l.replace(/^[ \t]*-[ \t]*/, '').trim());
  }

  /** `{ escalares, listas }`. Una clave de lista NUNCA aparece en `escalares` y viceversa. */
  function leerFicha(txt) {
    const ls = {};
    for (const k of listas) ls[k] = listaDe(txt, k);
    const escalares = {};
    for (const m of txt.matchAll(/^([a-z_]+):[ \t]*(.+)$/gm)) {
      if (listas.includes(m[1])) continue;          // `repos:` con algo detrás no es un escalar
      let v = m[2].trim();
      // 🔴 Un comentario al final de la línea es un comentario, no parte del valor. El caso 21 de la
      // suite escribe `veredicto: pendiente # decision-en-curso` justamente para probar que una nota
      // de una persona sobrevive; leyendo la línea entera, esa ficha dejaría de ser "pendiente" y la
      // vigilancia se la saltearía ENTERA, en silencio. Dentro de comillas el `#` no es comentario.
      if (!v.startsWith('"')) v = v.replace(/\s+#.*$/, '').trim();
      escalares[m[1]] = v.replace(/^"([\s\S]*)"$/, '$1');
    }
    return { escalares, listas: ls };
  }

  /** Dónde insertar una clave que todavía no está: antes de la primera POSTERIOR que sí esté. */
  function insertarClave(txt, clave, texto) {
    const i = orden.indexOf(clave);
    if (i >= 0) {
      for (const k of orden.slice(i + 1)) {
        const m = txt.match(new RegExp(`^${k}:`, 'm'));
        if (m) return txt.slice(0, m.index) + texto + txt.slice(m.index);
      }
    }
    // Ninguna posterior: antes de los comentarios del pie, o al final. El pie es el primer comentario DESPUÉS de una
    // clave: el encabezado de un borrador del vigilante (comentarios antes de la primera clave) no es el pie.
    const primera = txt.search(/^[A-Za-z_][\w-]*:/m);
    const c = primera >= 0 ? txt.slice(primera).match(/^#/m) : null;
    if (c) return txt.slice(0, primera + c.index) + texto + txt.slice(primera + c.index);
    return txt.endsWith('\n') || txt === '' ? txt + texto : `${txt}\n${texto}`;
  }

  function ponerEscalar(txt, clave, valor) {
    const linea = `${clave}: ${valor}\n`;
    // 🔴 La cadena de reemplazo va por una FUNCIÓN. Con la forma `txt.replace(re, cadena)`,
    // `String.replace` interpreta los patrones `$&`, `$'`, `` $` `` y `$$` que traiga el valor — y
    // `motivo_rechazo:` es el comentario de un pull request, o sea texto escrito por cualquiera que
    // pueda comentarlo. En el vigilante ese mismo patrón SÍ muerde: `$'` copia el resto entero de
    // la ficha adentro del valor y la deja con claves duplicadas.
    //
    // Acá hoy no se dispara —`note --rejected` no reescribe un `rechazado:` que ya está, y los
    // renombres pasan por `insertarClave`, que concatena— pero la clase se cierra entera, no hasta
    // donde llega hoy: el chequeo que lo tapa está a un refactor de distancia de desaparecer.
    return reEscalar(clave).test(txt) ? txt.replace(reEscalar(clave), () => linea.trimEnd()) : insertarClave(txt, clave, linea);
  }

  function quitarClave(txt, clave) {
    if (listas.includes(clave)) return txt.replace(reLista(clave), '');
    return txt.replace(new RegExp(`^${clave}:[ \\t]*.*\\n`, 'm'), '');
  }

  /** Reemplaza (o agrega, o borra si viene vacía) UNA sección, sin tocar las otras ni los comentarios. */
  function ponerLista(txt, clave, items) {
    // 🔴 Vaciar borra la sección ENTERA (cabecera + ítems), esté o no la clave en las listas: por
    // construcción, lo que pasa por acá es una lista. Con `quitarClave` a secas, una clave fuera de esa lista
    // (`visto_cerrado:`, `avisado_cerrado_vivo:`) pierde sólo la cabecera y sus ítems quedan pegados a la
    // lista anterior, creciendo con cada reapertura.
    if (!items.length) return reLista(clave).test(txt) ? txt.replace(reLista(clave), '') : quitarClave(txt, clave);
    const bloque = `${clave}:\n${items.map((x) => `  - ${x}`).join('\n')}\n`;
    return reLista(clave).test(txt) ? txt.replace(reLista(clave), () => bloque) : insertarClave(txt, clave, bloque);
  }

  /** Renombra una clave conservando su valor (los campos de cierre al reactivar: `resuelto_antes:`). */
  function renombrarClave(txt, de, a) {
    const m = txt.match(reEscalar(de));
    if (!m) return txt;
    return ponerEscalar(quitarClave(txt, de), a, m[1].trim());
  }

  return { reLista, reEscalar, listaDe, leerFicha, insertarClave, ponerEscalar, quitarClave, ponerLista, renombrarClave };
}

// ── la decisión del sitio ──────────────────────────────────────────────────────────────────────
//
// Quien mantiene confirma una ficha en el sitio; el sitio abre un pedido con `inbox/<carpeta>/decisions/<id>.json` y,
// cuando otra persona lo aprueba, la noche siguiente lo aplica acá: pone el veredicto con las palabras de la fuente,
// mueve la ficha a su carpeta y borra la decisión. Ninguna noche escribe la decisión: sólo la lee.

const CLAVES_DE_DECISION = ['fuente', 'id', 'accion', 'quien', 'el'];

// La palabra que escribe cada fuente por cada acción. En dependencias se decide el pull request de la ficha: aceptar
// lo mergea (la ficha pasa a `util`) y rechazar lo cierra con el motivo (la ficha sigue viva, con su rechazo anotado).
const VEREDICTO_DE_DECISION = {
  dependencias: { aceptar: 'util', reject: null },
  vigilante: { aceptar: 'descartado', arreglar: 'util' },
  ejecuciones: { aceptar: 'aceptada', arreglar: 'arreglo' },
};

// Dependencias lleva además el pull request que la persona vio (`pr`, y `pr_repo` en GitHub; null si la ficha no tenía)
// y, al rechazar, el motivo: lo escribe una persona y termina en un comentario del pedido y en la ficha.
const CLAVES_DE_PEDIDO = ['pr', 'pr_repo'];
const MOTIVO_MAX = 180;
const NUMERO_DE_PR = /^[0-9]{1,9}$/;
const REPO_DE_PR = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Un motivo escrito por una persona como escalar de la ficha, entre comillas dobles y en una línea: la comilla doble
 * pasa a simple y la barra invertida a barra, porque dentro de las comillas escaparía la de cierre.
 */
function entreComillas(texto) {
  return `"${String(texto).replace(/"/g, "'").replace(/\\/g, '/').replace(/\s+/g, ' ').trim().slice(0, MOTIVO_MAX)}"`;
}

/** El motivo de un rechazo: una línea escrita por una persona, sin caracteres de control y con tope de largo. */
function motivoConForma(m) {
  return typeof m === 'string' && m.trim().length > 0 && m.length <= MOTIVO_MAX && !CONTROL.test(m);
}

/** Las claves que la decisión tiene que traer, ni una más: las comunes, y en dependencias el pedido y el motivo. */
function clavesDeDecision(fuente, accion) {
  if (fuente !== 'dependencias') return CLAVES_DE_DECISION;
  return [...CLAVES_DE_DECISION, ...CLAVES_DE_PEDIDO, ...(accion === 'reject' ? ['motivo'] : [])];
}

/** ¿La decisión tiene la forma cerrada de la fuente? `id` tiene que ser el del nombre del archivo. */
function decisionConForma(d, fuente, id) {
  if (!esObjeto(d) || !Object.hasOwn(VEREDICTO_DE_DECISION, fuente)) return false;
  const claves = clavesDeDecision(fuente, d.accion);
  return Object.keys(d).length === claves.length && claves.every((k) => Object.hasOwn(d, k))
    && d.fuente === fuente && d.id === id && typeof d.id === 'string' && CLAVE.test(d.id)
    && Object.hasOwn(VEREDICTO_DE_DECISION[fuente], d.accion)
    && typeof d.quien === 'string' && d.quien.length <= 200 && IDENTIDAD.test(d.quien) && !CONTROL.test(d.quien)
    && typeof d.el === 'string' && FECHA.test(d.el)
    && (fuente !== 'dependencias' || (
      (d.pr === null || (typeof d.pr === 'string' && NUMERO_DE_PR.test(d.pr)))
      && (d.pr_repo === null || (typeof d.pr_repo === 'string' && d.pr !== null && REPO_DE_PR.test(d.pr_repo)))
      && (d.accion !== 'reject' || motivoConForma(d.motivo))));
}

/** ¿El pedido de la decisión sigue siendo el de la ficha? Mismo número y mismo repo (vacío = sin `pr_repo:`). */
function mismoPedido(d, escalares) {
  const pr = escalares.pr ? String(escalares.pr) : null;
  const repo = escalares.pr_repo ? String(escalares.pr_repo) : null;
  return pr === d.pr && repo === d.pr_repo;
}

/**
 * Aplica las decisiones del sitio de una fuente. Una sin forma queda donde está y se cuenta (su contenido nunca va a la
 * salida); una cuya ficha ya no está pendiente se borra con un renglón. Sin carpeta de decisiones, nada. `dir`: la
 * carpeta de la fuente cuando no está en `<base>/inbox/<carpeta>` (el `--pending` de cada noche).
 *
 * En dependencias, la decisión sobre una ficha con pull request la aplica el paso de los pull requests
 * (`open-pr-per-finding.sh`, que lo mergea o lo cierra): acá queda donde está y se cuenta en `delPedido`. La de una
 * ficha sin pull request se aplica acá: aceptar la pasa a `util`, rechazar le anota `rechazado:` y su motivo. Si el
 * pedido de la ficha ya no es el que vio la persona, no se aplica: la ficha anota `decision_fallida:` con el porqué,
 * que el resumen cuenta y el sitio muestra para volver a decidir.
 */
function aplicarDecisiones({ base, fuente, dir = null, hoy = new Date().toISOString().slice(0, 10) }) {
  const { FUENTES: registro } = require('./sources.js');
  const reg = registro[fuente];
  if (!reg) throw new Error(`fuente desconocida: ${fuente}`);
  const carpetas = dir ? Object.fromEntries(CARPETAS.map((c) => [c, path.join(dir, c)])) : carpetasDe(base, fuente);
  const r = { aplicadas: [], borradas: [], delPedido: [], fallidas: [], sinForma: 0, ilegibles: 0, lineas: [] };
  let nombres;
  try { nombres = fs.readdirSync(carpetas.decisions).filter((x) => x.endsWith('.json')).sort(); } catch (e) {
    if (e && e.code === 'ENOENT') return r;
    r.ilegibles += 1;
    r.lineas.push(`la carpeta de decisiones no se pudo leer (${(e && e.code) || 'error'}): esta noche no se aplica ninguna`);
    return r;
  }
  for (const nombre of nombres) {
    try { aplicarUna(nombre); } catch (e) {
      // una ficha rara no tumba la noche: la decisión queda y se mira a mano
      r.ilegibles += 1;
      r.lineas.push(`decisión del sitio sobre ${CLAVE.test(nombre.slice(0, -5)) ? nombre.slice(0, -5) : '(un archivo con un nombre sin forma)'}: no se pudo aplicar (${(e && e.code) || 'error'}); la decisión queda`);
    }
  }
  return r;

  function aplicarUna(nombre) {
    const ruta = path.join(carpetas.decisions, nombre);
    const id = nombre.slice(0, -'.json'.length);
    const visible = CLAVE.test(id) ? id : '(un archivo con un nombre sin forma)';
    let d = null;
    try { d = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { d = null; }
    if (!decisionConForma(d, fuente, id)) {
      r.sinForma += 1;
      r.lineas.push(`decisión del sitio sin la forma esperada: ${visible} (queda en decisions/; se mira a mano)`);
      return;
    }
    if (fuente === 'dependencias' && d.pr !== null) {
      r.delPedido.push({ id, accion: d.accion });
      r.lineas.push(`decisión del sitio sobre ${id}: la aplica el paso de los pull requests (${d.accion} el pedido ${d.pr})`);
      return;
    }
    const palabra = VEREDICTO_DE_DECISION[fuente][d.accion];
    const origen = path.join(carpetas.pending, `${id}${reg.extension}`);
    // 🔴 Sólo «el archivo no está» cuenta como «ya no está pendiente». Una ficha que no se puede leer o no se entiende
    // deja la decisión donde está: borrarla haría decidir de nuevo a la persona por un problema del disco.
    const ilegible = (motivo) => {
      r.ilegibles += 1;
      r.lineas.push(`decisión del sitio sobre ${id}: la ficha no se pudo leer (${motivo}); la decisión queda`);
    };
    let txt = null;
    try { txt = fs.readFileSync(origen, 'utf8'); } catch (e) {
      if (!e || e.code !== 'ENOENT') { ilegible((e && e.code) || 'error'); return; }
    }
    let destino = null;
    let nuevo = null;
    if (txt !== null) {
      if (fuente === 'dependencias') {
        const fi = reg.formato.leerFicha(txt);
        const vista = reg.vista(fi);
        if (vista.veredicto === 'pendiente' && vista.estado !== 'resuelta' && !fi.escalares.rechazado) {
          if (!mismoPedido(d, fi.escalares)) {
            const porQue = 'la ficha ya tiene un pull request que no es el que se vio en el sitio: no se aplicó nada';
            nuevo = marcarFallida(reg.formato, txt, porQue, hoy);
            destino = 'pending';
            r.fallidas.push({ id, motivo: porQue });
          } else if (d.accion === 'reject') {
            nuevo = sinFallida(reg.formato, txt);
            nuevo = reg.formato.ponerEscalar(nuevo, 'rechazado', d.el);
            nuevo = reg.formato.ponerEscalar(nuevo, 'motivo_rechazo', entreComillas(d.motivo));
            destino = 'pending';
          } else {
            nuevo = sinFallida(reg.formato, txt);
            nuevo = reg.formato.ponerEscalar(reg.formato.ponerEscalar(nuevo, 'veredicto', palabra), 'decidido_en_sitio', d.el);
            destino = reg.carpetaDe(reg.vista(reg.formato.leerFicha(nuevo)));
          }
        }
      } else if (reg.formato) {
        const vista = reg.vista(reg.formato.leerFicha(txt));
        if (vista.veredicto === 'pendiente' && vista.estado !== 'resuelta') {
          nuevo = reg.formato.ponerEscalar(reg.formato.ponerEscalar(txt, 'veredicto', palabra), 'decidido_en_sitio', d.el);
          destino = reg.carpetaDe(reg.vista(reg.formato.leerFicha(nuevo)));
        }
      } else {
        let f = null;
        try { f = parsear(txt); } catch { f = null; }
        if (!f) { ilegible('no tiene la forma de una ficha'); return; }
        if (f.veredicto === 'pendiente' && f.estado !== 'resuelta') {
          f.veredicto = palabra;
          // el día de la decisión: la noche cierra con él el pedido viejo que la ficha tuviera, sin contarlo como rechazo
          f.decidido_en_sitio = d.el;
          nuevo = serializar(f);
          destino = reg.carpetaDe(f);
        }
      }
    }
    if (nuevo === null) {
      fs.rmSync(ruta, { force: true });
      r.borradas.push({ id, motivo: 'no está pendiente' });
      r.lineas.push(`decisión del sitio sobre ${id}: la ficha ya no está pendiente; se borra la decisión`);
      return;
    }
    fs.mkdirSync(carpetas[destino], { recursive: true });
    const final = path.join(carpetas[destino], `${id}${reg.extension}`);
    fs.writeFileSync(final, nuevo);
    if (final !== origen) fs.rmSync(origen, { force: true });
    fs.rmSync(ruta, { force: true });
    if (r.fallidas.some((x) => x.id === id)) {
      r.lineas.push(`decisión del sitio sobre ${id}: no se aplicó (${r.fallidas.find((x) => x.id === id).motivo}); vuelve a «Te toca decidir»`);
      return;
    }
    r.aplicadas.push({ id, accion: d.accion, veredicto: palabra || 'rechazado', carpeta: destino });
    r.lineas.push(`decisión del sitio aplicada: ${id} → ${palabra || 'rechazado'}`);
  }
}

/** Anota en una ficha de dependencias que la decisión del sitio no se pudo aplicar, el día y por qué (una línea). */
function marcarFallida(formato, txt, porQue, hoy) {
  const t = formato.ponerEscalar(txt, 'decision_fallida', hoy);
  return formato.ponerEscalar(t, 'motivo_decision_fallida', entreComillas(porQue));
}

/** La ficha sin la marca de una decisión que falló: se decidió de nuevo y esta vez se aplicó. */
function sinFallida(formato, txt) {
  return formato.quitarClave(formato.quitarClave(txt, 'decision_fallida'), 'motivo_decision_fallida');
}

/**
 * ¿Las fichas se deciden en el sitio? Sí cuando operations.json tiene `site.url` (decisión 15): entonces la noche no
 * abre un pedido por ficha. `codigo` 0 sí, 1 no, 2 no se pudo leer (quien pregunta lo trata como «no» y lo dice).
 */
function sitioDecide(rutaOperations) {
  let txt;
  try { txt = fs.readFileSync(rutaOperations, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { codigo: 1, motivo: 'no hay operations.json: la noche abre un pedido por ficha' };
    return { codigo: 2, motivo: `operations.json no se pudo leer (${(e && e.code) || 'error'})` };
  }
  let doc;
  // 🔴 El motivo no copia el archivo ni el error del lector: puede traer correos e identidades.
  try { doc = JSON.parse(txt); } catch { return { codigo: 2, motivo: 'operations.json no se pudo leer (no es JSON)' }; }
  const url = esObjeto(doc) && esObjeto(doc.site) ? doc.site.url : undefined;
  if (typeof url === 'string' && url.trim()) return { codigo: 0, motivo: 'operations.json tiene site.url: las fichas se deciden en el sitio' };
  return { codigo: 1, motivo: 'operations.json no tiene site.url: la noche abre un pedido por ficha' };
}

// ── el pedido de trabajo de cada arreglo ──────────────────────────────────────────────────────
//
// Una ficha de ejecuciones o del vigilante decidida «arreglar» pide, la noche siguiente, su pedido de trabajo por la
// capa de plataforma, asignado al responsable de `owners` (decisión 18). Dependencias crea su Bug por su camino
// (scripts/nightly/dependencies/work-items.js; decisión 17).

/** Leer y escribir el pedido en la ficha de cada fuente: la común (ejecuciones) o el borrador del vigilante. */
function accesoAlPedido(fuente) {
  const { FUENTES: registro } = require('./sources.js');
  if (fuente === 'ejecuciones') {
    return { crudo: (txt) => parsear(txt), poner: (txt, campos) => serializar({ ...parsear(txt), ...campos }) };
  }
  const fmt = registro.vigilante.formato;
  const escalar = (v) => (v === null ? 'null' : typeof v === 'number' ? String(v) : JSON.stringify(v));
  return {
    crudo: (txt) => {
      const e = fmt.leerFicha(String(txt)).escalares;
      return { pedido: e.pedido === undefined ? null : e.pedido, pedido_motivo: e.pedido_motivo === undefined || e.pedido_motivo === 'null' ? null : e.pedido_motivo,
        producto: e.producto, regla: e.regla, severidad: e.severidad, story_creada: e.story_creada };
    },
    poner: (txt, campos) => Object.entries(campos).reduce((t, [k, v]) => fmt.ponerEscalar(t, k, escalar(v)), String(txt)),
  };
}

/**
 * Lo que la noche necesita de operations.json para pedir: el responsable (`owners.default`: las fichas de ejecuciones y
 * del vigilante no tienen proyecto) y dónde va el pedido (`work_items.org`, `.project` y `.type`). Un archivo que no
 * valida no da ninguno de los dos.
 */
function pedidoDeLaNoche(rutaOperations) {
  const OPS = require('../../lib/operations-config.js');
  let r;
  try { r = OPS.load(rutaOperations); } catch { r = null; }
  if (!r || !r.ok || !r.data) return { responsable: null, destino: null };
  const quien = OPS.ownerFor(r.data, null);
  const w = r.data.work_items || {};
  const destino = w.org && w.project ? { org: w.org, project: w.project, ...(w.type ? { type: w.type } : {}) } : null;
  return { responsable: typeof quien === 'string' && IDENTIDAD.test(quien) ? quien : null, destino };
}

// Lo que dice la plataforma cuando le falta configuración: no se reintenta solo, lo arregla una persona
const SIN_CONFIGURAR = ['sin_credencial', 'sin_plataforma'];
const FALTA_CONFIGURAR = 'falta configurar dónde va (work_items.org y work_items.project de operations.json, en la Configuración del sitio)';
// ¿El campo del vigilante tiene algo? El vacío de YAML escrito a mano no cuenta
const conValor = (v) => v !== undefined && v !== null && !/^(|null|~|"")$/i.test(String(v).trim());

// la causa entra al pedido sólo con la forma de una clave o de una huella: la del vigilante sale de su borrador
const causaConForma = (c) => (typeof c === 'string' && (CLAVE.test(c) || HUELLA.test(c)) ? c : 'sin forma');

/** La descripción del pedido: sólo campos con forma de la ficha; nunca el diagnóstico, la evidencia ni la propuesta. */
function descripcionDelPedido(fuente, v, crudo) {
  const partes = [`Lo encontró la noche (${fuente}) y se decidió arreglarlo.`, `Causa: ${causaConForma(v.causa)}.`,
    `Apariciones: ${v.apariciones}.`, `Primera vez: ${v.primera_vez}.`];
  if (v.ultima_vez) partes.push(`Última vez: ${v.ultima_vez}.`);
  if (fuente === 'vigilante') {
    for (const [k, nombre] of [['producto', 'Producto'], ['regla', 'Regla'], ['severidad', 'Severidad']]) {
      if (typeof crudo[k] === 'string' && CLAVE.test(crudo[k])) partes.push(`${nombre}: ${crudo[k]}.`);
    }
  }
  return partes.join(' ');
}

/**
 * Qué hace la noche con una ficha (la vista de sources.js `comoFicha`) al pedir trabajo, con el destino de
 * `pedidoDeLaNoche`: `{ pide: true }` si la pide esta noche; `{ pide: false, por }` si la saltea (`no-es-arreglo`,
 * `pedido`: ya tiene su tarea, `historia`: ya tiene su story); `{ pide: false, motivo }` si no la pide y lo anota en la
 * ficha (`sin-confirmar`: quedó «pidiendo» de una noche anterior; `sin-configurar`: no hay dónde crearla). Es la única
 * condición: la usan `pedirTrabajo` y el sitio, que dice «se crea esta noche» sólo con `pide: true`.
 */
function queHaraLaNoche(v, destino) {
  if (!v || v.veredicto !== 'arreglo' || v.estado === 'resuelta') return { pide: false, por: 'no-es-arreglo' };
  if (v.pedido) return { pide: false, por: 'pedido' };
  if (v.historia) return { pide: false, por: 'historia' };
  if (v.pidiendo) return { pide: false, motivo: 'sin-confirmar' };
  if (!destino) return { pide: false, motivo: 'sin-configurar' };
  return { pide: true };
}

/**
 * Crea el pedido de cada arreglo de la fuente sin pedido. Antes de llamar deja `pedido: pidiendo`; sin poder escribirla,
 * no llama. Con el id lo anota, con el asignado que la plataforma confirmó y `pedido_motivo`. Con la plataforma que dice
 * que no, la ficha queda sin pedido con `plataforma-caida` y se reintenta la noche siguiente; si lo que falta es
 * configuración (o operations.json no dice dónde va), con `sin-configurar` y sin llamar. Una respuesta que no dice que no
 * pero tampoco trae el número (o que lanza) deja la marca: pudo crearlo. Una ficha que ya estaba `pidiendo` no pide otro
 * y queda `sin-confirmar`. Qué ficha se pide lo decide `queHaraLaNoche`. Devuelve `{ creados, sinAsignado, sinCrear, lineas }`; los
 * renglones no copian el texto de un error.
 */
async function pedirTrabajo({ base, fuente, operations, run = null, dir = null, repoDir = null }) {
  if (fuente !== 'ejecuciones' && fuente !== 'vigilante') {
    throw new Error(`${fuente}: el pedido de dependencias lo crea scripts/nightly/dependencies/work-items.js`);
  }
  const { comoFicha } = require('./sources.js');
  const plataforma = run || ((op, args) => require('../../lib/platform/platform.js').run(op, args));
  const carpetas = dir ? Object.fromEntries(CARPETAS.map((c) => [c, path.join(dir, c)])) : carpetasDe(base, fuente);
  const acceso = accesoAlPedido(fuente);
  const r = { creados: [], sinAsignado: [], sinCrear: [], lineas: [] };
  let nombres;
  try { nombres = fs.readdirSync(carpetas.promoted).filter((x) => x.endsWith('.yaml')).sort(); } catch (e) {
    if (e && e.code === 'ENOENT') return r;
    r.lineas.push(`pedidos de ${fuente}: la carpeta de los decididos no se pudo leer (${(e && e.code) || 'error'}); esta noche no se pide ninguno`);
    return r;
  }
  const { responsable, destino } = pedidoDeLaNoche(operations);
  for (const nombre of nombres) {
    const ruta = path.join(carpetas.promoted, nombre);
    let txt;
    let v;
    let crudo;
    try {
      txt = fs.readFileSync(ruta, 'utf8');
      v = comoFicha(fuente, txt);
      crudo = v ? acceso.crudo(txt) : null;
    } catch (e) {
      r.lineas.push(`pedido de ${nombre.slice(0, -5)}: la ficha no se pudo leer (${(e && e.code) || 'sin forma'})`);
      continue;
    }
    const noche = queHaraLaNoche(v, destino);
    if (noche.por) continue;
    const escribir = (campos) => { txt = acceso.poner(txt, campos); fs.writeFileSync(ruta, txt); };
    if (noche.motivo === 'sin-confirmar') {
      try { if (crudo.pedido_motivo !== 'sin-confirmar') escribir({ pedido_motivo: 'sin-confirmar' }); } catch { /* se vuelve a decir mañana */ }
      r.sinCrear.push({ id: v.id, motivo: 'sin-confirmar' });
      r.lineas.push(`pedido de ${v.id}: quedó «pidiendo» de una noche anterior sin el número; no se pide otro (lo mira una persona)`);
      continue;
    }
    if (noche.motivo === 'sin-configurar') {
      try { if (crudo.pedido_motivo !== 'sin-configurar') escribir({ pedido_motivo: 'sin-configurar' }); } catch { /* se vuelve a decir mañana */ }
      r.sinCrear.push({ id: v.id, motivo: 'sin-configurar' });
      r.lineas.push(`pedido de ${v.id}: ${FALTA_CONFIGURAR}; no se pide`);
      continue;
    }
    try { escribir({ pedido: PIDIENDO, pedido_motivo: null }); } catch (e) {
      r.lineas.push(`pedido de ${v.id}: la ficha no se pudo escribir (${(e && e.code) || 'error'}); no se pide`);
      continue;
    }
    const args = { repoDir: repoDir || base || path.dirname(path.dirname(carpetas.promoted)), title: `${v.nombre} (${fuente})`,
      description: descripcionDelPedido(fuente, v, crudo), tags: [`arnes-${fuente}`, `arnes:${v.id}`], forNight: true, typeOrBacklog: true, ...destino };
    if (responsable) args.assignTo = responsable;
    let res = null;
    let lanzo = null;
    try { res = await plataforma('work-item.create', args); } catch (e) {
      const clase = e && e.constructor && e.constructor.name;
      lanzo = typeof clase === 'string' && /^[A-Za-z_]{1,30}$/.test(clase) ? clase : 'error';
    }
    const id = res && res.ok === true && res.value ? res.value.id : null;
    const idValido = (Number.isInteger(id) && id > 0) || (typeof id === 'string' && CLAVE.test(id));
    // «no_medido» no es un no: el conector lo dice también cuando la plataforma creó algo sin devolver el número
    if (!idValido && res && res.ok === false && res.reason !== 'no_medido') {
      const porque = typeof res.reason === 'string' && /^[a-z_]{1,30}$/.test(res.reason) ? res.reason : 'sin motivo';
      const motivo = SIN_CONFIGURAR.includes(porque) ? 'sin-configurar' : 'plataforma-caida';
      try { escribir({ pedido: null, asignado: null, pedido_motivo: motivo }); } catch (e) {
        r.lineas.push(`pedido de ${v.id}: la plataforma no lo creó y la ficha no se pudo escribir (${(e && e.code) || 'error'}); queda «pidiendo»`);
        continue;
      }
      r.sinCrear.push({ id: v.id, motivo });
      r.lineas.push(`pedido de ${v.id}: la plataforma no lo creó (${porque}); ${motivo === 'sin-configurar' ? FALTA_CONFIGURAR : 'se reintenta la noche siguiente'}`);
      continue;
    }
    if (!idValido) {
      // no dijo que no: pudo crearlo. La marca queda y la noche siguiente no pide otro
      try { escribir({ pedido_motivo: 'sin-confirmar' }); } catch { /* la marca ya está */ }
      r.sinCrear.push({ id: v.id, motivo: 'sin-confirmar' });
      const como = lanzo ? `lanzó ${lanzo}` : res && res.ok === false ? 'no pudo confirmar (no_medido)' : 'contestó sin un número válido';
      r.lineas.push(`pedido de ${v.id}: la plataforma ${como}; no se sabe si lo creó, queda «pidiendo» (lo mira una persona)`);
      continue;
    }
    const asignado = responsable && res.value.assigned === responsable ? responsable : null;
    const motivo = !responsable ? 'sin-responsable' : asignado ? null : 'plataforma-sin-asignado';
    try { escribir({ pedido: id, asignado, pedido_motivo: motivo }); } catch (e) {
      r.lineas.push(`pedido de ${v.id}: se creó el ${id} pero la ficha no se pudo escribir (${(e && e.code) || 'error'}); queda «pidiendo»`);
      continue;
    }
    r.creados.push({ id: v.id, pedido: id, asignado });
    if (motivo) r.sinAsignado.push({ id: v.id, motivo });
    r.lineas.push(`pedido de ${v.id}: creado el ${id}${asignado ? '' : ` sin asignado (${motivo})`}`);
    // del tipo con que cayó al backlog sólo entra el nombre, con forma de nombre de tipo
    const tipo = res.value.typeFallback === true && typeof res.value.type === 'string' && /^[\p{L}\p{N} _-]{1,64}$/u.test(res.value.type) ? res.value.type : null;
    if (tipo) r.lineas.push(`pedido de ${v.id}: ${res.value.typeAsked ? 'el tipo configurado no existe en el proyecto' : 'no hay tipo configurado'}; va como ${tipo}`);
  }
  return r;
}

/** El comentario de que volvió: sólo campos con forma de la ficha, como la descripción del pedido. */
function comentarioDeQueVolvio(fuente, v) {
  const partes = [`La falla volvió: la noche (${fuente}) la vio otra vez el ${v.reaparecido}.`, `Causa: ${causaConForma(v.causa)}.`];
  if (Number.isInteger(v.apariciones)) partes.push(`Apariciones: ${v.apariciones}.`);
  partes.push('El estado del pedido no se cambió: lo decide una persona.');
  return partes.join(' ');
}

/**
 * Le avisa a su pedido que la falla volvió: a cada ficha reaparecida con el pedido que creó la noche (no la story que
 * anotó una persona) y sin `aviso_volvio_el`, un
 * `work-item.update` con sólo el comentario (sin estado: el pedido cerrado no se reabre). Con la plataforma que dice
 * que sí, anota el día en `aviso_volvio_el`; si no (caída, sin configurar, o lanza), un renglón y la noche siguiente
 * se intenta de nuevo. Devuelve `{ avisados, sinAvisar, lineas }`; los renglones no copian el texto de un error.
 */
async function avisarQueVolvio({ base, fuente, operations, hoy, run = null, dir = null, repoDir = null }) {
  if (fuente !== 'ejecuciones' && fuente !== 'vigilante') throw new Error(`${fuente}: el aviso de dependencias lo da su pedido del líder`);
  const { comoFicha } = require('./sources.js');
  const plataforma = run || ((op, args) => require('../../lib/platform/platform.js').run(op, args));
  const carpetas = dir ? Object.fromEntries(CARPETAS.map((c) => [c, path.join(dir, c)])) : carpetasDe(base, fuente);
  const acceso = accesoAlPedido(fuente);
  const r = { avisados: [], sinAvisar: [], lineas: [] };
  let destino;
  for (const carpeta of ['pending', 'promoted']) {
    let nombres;
    try { nombres = fs.readdirSync(carpetas[carpeta]).filter((x) => x.endsWith('.yaml')).sort(); } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      r.lineas.push(`avisos de ${fuente}: la carpeta ${carpeta} no se pudo leer (${(e && e.code) || 'error'}); se avisa mañana`);
      continue;
    }
    for (const nombre of nombres) {
      const ruta = path.join(carpetas[carpeta], nombre);
      let txt;
      let v;
      try { txt = fs.readFileSync(ruta, 'utf8'); v = comoFicha(fuente, txt); } catch (e) {
        r.lineas.push(`aviso de ${nombre.slice(0, -5)}: la ficha no se pudo leer (${(e && e.code) || 'sin forma'})`);
        continue;
      }
      if (!v || v.estado !== 'reaparecio' || !v.reaparecido || v.aviso_volvio || !v.pedido_de_la_noche) continue;
      if (destino === undefined) destino = pedidoDeLaNoche(operations).destino;
      if (!destino) {
        r.sinAvisar.push({ id: v.id, motivo: 'sin-configurar' });
        r.lineas.push(`aviso de ${v.id}: ${FALTA_CONFIGURAR}; se avisa mañana`);
        continue;
      }
      const id = Number(v.pedido_de_la_noche);
      const args = { repoDir: repoDir || base || path.dirname(path.dirname(carpetas.pending)), id,
        comment: comentarioDeQueVolvio(fuente, v), forNight: true, ...destino };
      let res = null;
      try { res = await plataforma('work-item.update', args); } catch { res = null; }
      if (!(res && res.ok === true)) {
        const porque = res && typeof res.reason === 'string' && /^[a-z_]{1,30}$/.test(res.reason) ? res.reason : 'sin respuesta';
        r.sinAvisar.push({ id: v.id, motivo: porque });
        r.lineas.push(`aviso de ${v.id}: la plataforma no comentó el pedido ${id} (${porque}); se avisa mañana`);
        continue;
      }
      try { fs.writeFileSync(ruta, acceso.poner(txt, { aviso_volvio_el: hoy })); } catch (e) {
        r.lineas.push(`aviso de ${v.id}: se comentó el pedido ${id} pero la ficha no se pudo escribir (${(e && e.code) || 'error'}); mañana se vuelve a avisar`);
        continue;
      }
      r.avisados.push({ id: v.id, pedido: id });
      r.lineas.push(`aviso de ${v.id}: se le avisó al pedido ${id} que volvió`);
    }
  }
  return r;
}

// Lo que el cruce de la noche no pudo terminar, para el resumen de esa misma mañana: cuántos pedidos no se pudieron
// leer, cuáles ya no existen, cuántos comentarios fallaron, cuántas fichas o carpetas no se pudieron leer, si falta
// configurar el destino y si el cruce se cortó. Vive junto a las carpetas de la fuente; uno de otro día no cuenta.
const AVISO_CERRADO = 'aviso-cerrado.json';
const CONTADORES_CERRADO = ['sin_leer', 'sin_comentar', 'sin_mirar'];
const BANDERAS_CERRADO = ['falta_configurar', 'cortado'];

/** El comentario al pedido cerrado: sólo campos con forma de la ficha, como el de que volvió. */
function comentarioDeCerrado(fuente, v) {
  const partes = [`El pedido está cerrado y la falla sigue: la noche (${fuente}) la vio otra vez el ${v.ultima_vez}.`, `Causa: ${causaConForma(v.causa)}.`];
  if (Number.isInteger(v.apariciones)) partes.push(`Apariciones: ${v.apariciones}.`);
  partes.push('El estado del pedido no se cambió: lo decide una persona.');
  return partes.join(' ');
}

/**
 * Lo que el cruce dejó dicho para el resumen de `hoy` en la carpeta de la fuente: `{ avisados, sin_leer, no_existen,
 * sin_comentar, sin_mirar, falta_configurar, cortado }` (`avisados`: los pedidos que recibieron el comentario); null si no hay archivo o es de otro día; `{ roto: true }` si está pero no se
 * puede leer o no tiene la forma (no es lo mismo que no tener nada que decir).
 */
function leerAvisoCerrado(dirFuente, hoy) {
  let txt;
  try { txt = fs.readFileSync(path.join(dirFuente, AVISO_CERRADO), 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? null : { roto: true };
  }
  let d;
  try { d = JSON.parse(txt); } catch { return { roto: true }; }
  if (esObjeto(d) && FECHA.test(String(d.fecha)) && d.fecha !== hoy) return null;
  const contadores = CONTADORES_CERRADO.every((k) => d && (d[k] === undefined || entero(d[k], 0)));
  const banderas = BANDERAS_CERRADO.every((k) => d && (d[k] === undefined || typeof d[k] === 'boolean'));
  const listas = ['no_existen', 'avisados'].every((k) => d && (k === 'avisados' && d[k] === undefined
    || (Array.isArray(d[k]) && d[k].every((x) => entero(x, 1)))));
  if (!esObjeto(d) || d.fecha !== hoy || !contadores || !banderas || !listas) return { roto: true };
  return { avisados: d.avisados || [], sin_leer: d.sin_leer || 0, no_existen: d.no_existen, sin_comentar: d.sin_comentar || 0, sin_mirar: d.sin_mirar || 0,
    falta_configurar: d.falta_configurar === true, cortado: d.cortado === true };
}

/** Guarda lo que el cruce de `hoy` tiene para decir en la mañana; devuelve el código del error si no pudo. */
function guardarAvisoCerrado(dirFuente, hoy, datos) {
  try {
    fs.writeFileSync(path.join(dirFuente, AVISO_CERRADO), `${JSON.stringify({ fecha: hoy, ...datos }, null, 2)}\n`);
    return null;
  } catch (e) { return (e && e.code) || 'error'; }
}

/**
 * Le avisa a su pedido cerrado que la falla sigue: a cada ficha viva cuya causa está en `vistas` (lo que esa noche vio
 * de verdad, que arma cada fuente: en ejecuciones, las causas con una ejecución nueva; en el vigilante, las huellas con
 * errores aunque no pasen el umbral), con el pedido que creó la noche y sin `aviso_cerrado_el`, lee el estado del pedido (`work-item.read`); si está cerrado, un `work-item.update` con sólo el
 * comentario (sin estado: no se reabre) y el día en `aviso_cerrado_el`. Un pedido que la plataforma ya no tiene se dice
 * una vez y queda anotado igual: no se reintenta. Uno que no se pudo leer, o cuyo comentario falló, se intenta la
 * noche siguiente. Una ficha que volvió recibe sólo el aviso de que volvió. Lo que no se pudo hacer (lecturas,
 * comentarios, fichas o carpetas, el destino sin configurar, un cruce cortado) y lo que ya no existe queda en
 * `aviso-cerrado.json` para el resumen de esa misma mañana. Devuelve `{ avisados, sinLeer, noExisten, sinComentar,
 * sinMirar, faltaConfigurar, lineas }`; los renglones no copian el texto de un error.
 */
async function avisarCerradoConFallaViva(opciones) {
  if (opciones.fuente !== 'ejecuciones' && opciones.fuente !== 'vigilante') {
    throw new Error(`${opciones.fuente}: el cruce de dependencias lo hace su pedido del líder`);
  }
  const carpetas = opciones.dir ? Object.fromEntries(CARPETAS.map((c) => [c, path.join(opciones.dir, c)])) : carpetasDe(opciones.base, opciones.fuente);
  const dirFuente = path.dirname(carpetas.pending);
  try { return await cruzarCerrados({ ...opciones, carpetas, dirFuente }); } catch (e) {
    // un cruce cortado lo dice la mañana: sin esto, el resumen callaría igual que en una noche sin nada
    const antes = leerAvisoCerrado(dirFuente, opciones.hoy);
    guardarAvisoCerrado(dirFuente, opciones.hoy, { ...(antes && !antes.roto ? antes : { avisados: [], sin_leer: 0, no_existen: [] }), cortado: true });
    throw e;
  }
}

async function cruzarCerrados({ base, fuente, operations, hoy, run, repoDir, carpetas, dirFuente, vistas }) {
  // la fecha de la ficha no dice si la falla apareció esa noche: en ejecuciones la mueve una ejecución vieja que sigue en
  // la ventana, y en el vigilante no la mueve un error que no pasa el umbral
  if (!(vistas instanceof Set)) throw new Error(`${fuente}: el cruce necesita lo que la noche vio (vistas)`);
  const { comoFicha } = require('./sources.js');
  const plataforma = run || ((op, args) => require('../../lib/platform/platform.js').run(op, args));
  const acceso = accesoAlPedido(fuente);
  const r = { avisados: [], sinLeer: 0, noExisten: [], sinComentar: 0, sinMirar: 0, faltaConfigurar: false, lineas: [] };
  const porque = (res) => (res && typeof res.reason === 'string' && /^[a-z_]{1,30}$/.test(res.reason) ? res.reason : 'sin respuesta');
  let destino;
  for (const carpeta of ['pending', 'promoted']) {
    let nombres;
    try { nombres = fs.readdirSync(carpetas[carpeta]).filter((x) => x.endsWith('.yaml')).sort(); } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      r.sinMirar += 1;
      r.lineas.push(`pedidos cerrados de ${fuente}: la carpeta ${carpeta} no se pudo leer (${(e && e.code) || 'error'}); se mira mañana`);
      continue;
    }
    for (const nombre of nombres) {
      const ruta = path.join(carpetas[carpeta], nombre);
      let txt;
      let v;
      try { txt = fs.readFileSync(ruta, 'utf8'); v = comoFicha(fuente, txt); } catch (e) {
        r.sinMirar += 1;
        r.lineas.push(`pedido cerrado de ${nombre.slice(0, -5)}: la ficha no se pudo leer (${(e && e.code) || 'sin forma'})`);
        continue;
      }
      if (!v || v.estado !== 'viva' || !vistas.has(v.causa) || !v.pedido_de_la_noche || v.aviso_cerrado) continue;
      if (destino === undefined) {
        destino = pedidoDeLaNoche(operations).destino;
        if (!destino) {
          r.faltaConfigurar = true;
          r.lineas.push(`pedidos cerrados de ${fuente}: ${FALTA_CONFIGURAR}; no se leen`);
        }
      }
      if (!destino) continue;
      const id = Number(v.pedido_de_la_noche);
      const lugar = { repoDir: repoDir || base || path.dirname(dirFuente), id, forNight: true, ...destino };
      let leido = null;
      try { leido = await plataforma('work-item.read', lugar); } catch { leido = null; }
      const anotar = () => {
        try { fs.writeFileSync(ruta, acceso.poner(txt, { aviso_cerrado_el: hoy })); return true; } catch (e) {
          r.sinMirar += 1;
          r.lineas.push(`pedido cerrado de ${v.id}: la ficha no se pudo escribir (${(e && e.code) || 'error'}); mañana se vuelve a mirar`);
          return false;
        }
      };
      if (leido && leido.ok === false && leido.reason === 'no_encontrado') {
        r.noExisten.push(id);
        r.lineas.push(`pedido cerrado de ${v.id}: el pedido ${id} ya no existe en la plataforma`);
        anotar();
        continue;
      }
      if (!(leido && leido.ok === true && leido.value && typeof leido.value.cerrado === 'boolean')) {
        r.sinLeer += 1;
        r.lineas.push(`pedido cerrado de ${v.id}: no se pudo leer el estado del pedido ${id} (${porque(leido)}); se intenta mañana`);
        continue;
      }
      if (!leido.value.cerrado) continue;
      let res = null;
      try { res = await plataforma('work-item.update', { ...lugar, comment: comentarioDeCerrado(fuente, v) }); } catch { res = null; }
      if (!(res && res.ok === true)) {
        r.sinComentar += 1;
        r.lineas.push(`pedido cerrado de ${v.id}: la plataforma no comentó el pedido ${id} (${porque(res)}); se avisa mañana`);
        continue;
      }
      if (!anotar()) continue;
      r.avisados.push({ id: v.id, pedido: id });
      r.lineas.push(`pedido cerrado de ${v.id}: se le avisó al pedido ${id} que la falla sigue`);
    }
  }
  // la misma mañana dice lo que quedó sin hacer; una segunda pasada del mismo día suma los que ya no existen
  const antes = leerAvisoCerrado(dirFuente, hoy);
  const previo = antes && !antes.roto ? antes : null;
  const noExisten = [...new Set([...(previo ? previo.no_existen : []), ...r.noExisten])].sort((a, b) => a - b);
  // el resumen dice «avisado» sólo de los que están acá: la marca de la ficha también la lleva el pedido que ya no existe
  const avisados = [...new Set([...(previo ? previo.avisados : []), ...r.avisados.map((x) => x.pedido)])].sort((a, b) => a - b);
  const datos = { avisados, sin_leer: r.sinLeer, no_existen: noExisten, sin_comentar: r.sinComentar, sin_mirar: r.sinMirar,
    falta_configurar: r.faltaConfigurar, cortado: false };
  const algo = avisados.length || r.sinLeer || noExisten.length || r.sinComentar || r.sinMirar || r.faltaConfigurar;
  // sin nada que decir no se escribe: el de otro día ya no cuenta; uno de hoy (o uno roto) se pisa con lo de ahora
  if (!antes && !algo) return r;
  const error = guardarAvisoCerrado(dirFuente, hoy, datos);
  if (error) r.lineas.push(`pedidos cerrados de ${fuente}: lo que quedó sin hacer no se pudo guardar para el resumen (${error})`);
  return r;
}

module.exports = {
  MOTIVOS_SIN_PEDIDO, PIDIENDO, IDENTIDAD, conValor, queHaraLaNoche, pedidoDeLaNoche, pedirTrabajo, avisarQueVolvio, avisarCerradoConFallaViva, leerAvisoCerrado, AVISO_CERRADO, noche,
  FUENTES, VEREDICTOS, ESTADOS, CARPETAS, CLAVES, TOPE_CASOS, TOPE_HUELLAS, NOCHES_POR_DEFECTO,
  ACCIONES, MOTIVOS_SIN_PROPUESTA, MOTIVOS_SIN_ANALISIS, FALLAS_MAX, razonSegura, textoDeAnalisis, problemasDeAnalisis, problemasDeForma, nuevaFicha, conCasos, registrarAparicion, fichaDeCausa, contarNoche, carpetaDe, carpetasDe,
  asegurarCarpetas, leerCarpetas, serializar, parsear, nochesParaResolver, formatoPorSecciones,
  CLAVES_DE_DECISION, VEREDICTO_DE_DECISION, MOTIVO_MAX, motivoConForma, clavesDeDecision, decisionConForma, mismoPedido, aplicarDecisiones, sitioDecide, CLASES_DE_ERROR, hechosConForma,
};

/**
 * Las decisiones de dependencias que aplica el paso de los pull requests (las que traen `pr`), una por línea y separadas
 * por tabulador: id, acción, pr, pr_repo (`-` sin él), quién, el día y el motivo (`-` al aceptar). Sólo las que tienen
 * forma: los campos no traen tabuladores ni saltos de línea. Las demás quedan para la noche, que las cuenta.
 */
function decisionesDelPedido(dir) {
  let nombres;
  try { nombres = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort(); } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const nombre of nombres) {
    const id = nombre.slice(0, -'.json'.length);
    let d = null;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, nombre), 'utf8')); } catch { d = null; }
    if (!decisionConForma(d, 'dependencias', id) || d.pr === null) continue;
    // el motivo va detrás de «:» (vacío: «:»): así un motivo «-» no se confunde con el campo vacío de los otros
    out.push([id, d.accion, d.pr, d.pr_repo || '-', d.quien, d.el, `:${d.accion === 'reject' ? d.motivo : ''}`].join('\t'));
  }
  return out;
}
module.exports.decisionesDelPedido = decisionesDelPedido;

// A mano: node scripts/nightly/findings/cycle.js site-decides --operations <operations.json>
//         node scripts/nightly/findings/cycle.js site-decisions --dir <inbox/dependencies/decisions>
if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === 'site-decisions') {
    const j = a.indexOf('--dir');
    if (j < 0 || !a[j + 1]) { process.stderr.write('uso: cycle.js site-decisions --dir <carpeta de decisiones>\n'); process.exit(2); }
    let lineas;
    try { lineas = decisionesDelPedido(a[j + 1]); } catch (e) {
      process.stderr.write(`la carpeta de decisiones no se pudo leer (${(e && e.code) || 'error'})\n`);
      process.exit(1);
    }
    if (lineas.length) process.stdout.write(`${lineas.join('\n')}\n`);
    process.exit(0);
  }
  const i = a.indexOf('--operations');
  if (a[0] !== 'site-decides' || i < 0 || !a[i + 1]) {
    process.stderr.write('uso: cycle.js site-decides --operations <operations.json>\n');
    process.exit(2);
  }
  // una excepción saldría con 1, que el guion lee como «no hay site.url»: cualquier falla es 2, «no se pudo preguntar»
  let r;
  try { r = sitioDecide(a[i + 1]); } catch { r = { codigo: 2, motivo: 'no se pudo preguntar si el sitio decide' }; }
  process.stdout.write(`${r.motivo}\n`);
  process.exit(r.codigo);
}
