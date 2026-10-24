// El ciclo de la ficha, común a todo lo que encuentra la noche: dependencias, el vigilante y la revisión
// de las ejecuciones. Una ficha es una CAUSA, no un caso: la noche que la vuelve a ver le suma una aparición, la que no
// la ve (y la midió) le suma una noche sin aparecer, y a las N noches medidas seguidas sin aparecer se resuelve.
//
// Acá no hay red ni plataforma: sólo la forma de la ficha, sus carpetas, leerla y escribirla, y contar noches. Cada
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
// contada) sólo están mientras cuenta.
const CLAVES = ['id', 'fuente', 'causa', 'nombre', 'primera_vez', 'ultima_vez', 'apariciones', 'noches_sin_aparecer',
  'noche_contada', 'veredicto', 'veredicto_anterior', 'propuesta', 'propuesta_motivo', 'propuesta_fallas', 'propuesta_fallo_el',
  'pedido', 'asignado', 'estado', 'casos', 'casos_total', 'casos_vistos'];
// Por qué una ficha quedó sin propuesta del modelo: una lista cerrada, nunca el texto de un error. `tope` y `sin-escribir`
// (la ficha no se pudo escribir) no se escriben en la ficha: los cuenta la constancia de la noche.
const MOTIVOS_SIN_PROPUESTA = ['sin-modelo', 'sin-llave', 'no-permitido', 'modelo-caido', 'respuesta-invalida', 'tope', 'sin-escribir'];
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

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const CLAVE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const HUELLA = /^[0-9a-f]{8}$/;
const ENLACE = /^https:\/\/[^\s"'<>\\]{1,500}$/;
const IDENTIDAD = /^[^\s@]+(@[^\s@]+)?$/;
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
  if ('noche_contada' in f && !(typeof f.noche_contada === 'string' && FECHA.test(f.noche_contada))) p.push('noche_contada: no es una fecha');
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
  if (f.pedido !== null && !(entero(f.pedido, 1) || (typeof f.pedido === 'string' && CLAVE.test(f.pedido)))) p.push('pedido: sin forma');
  if (f.asignado !== null && !(typeof f.asignado === 'string' && IDENTIDAD.test(f.asignado))) p.push('asignado: sin forma');
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
function conCasos(f, nuevos) {
  const casos = [...(f.casos || [])];
  const huellas = [...(f.casos_vistos || casos.map(huellaDe))];
  const vistas = new Set(huellas);
  let total = f.casos_total || casos.length;
  for (const c of nuevos || []) {
    const h = huellaDe(c);
    if (vistas.has(h)) continue;
    vistas.add(h);
    huellas.push(h);
    casos.push(c);
    total += 1;
  }
  return { ...f, casos: casos.slice(-TOPE_CASOS), casos_total: total, casos_vistos: huellas.slice(-TOPE_HUELLAS) };
}

/** El id de una causa: estable por (fuente, causa), así la noche que la vuelve a ver encuentra la misma ficha. */
const idDe = (fuente, causa) => crypto.createHash('sha1').update(`${fuente}|${causa}`).digest('hex').slice(0, 12);

function nuevaFicha({ fuente, causa, nombre, hoy, casos = [] }) {
  if (!FUENTES.includes(fuente)) throw new Error(`fuente desconocida: ${fuente}`);
  const f = ordenar(conCasos({
    id: idDe(fuente, causa), fuente, causa, nombre, primera_vez: hoy, ultima_vez: hoy, apariciones: 1,
    veredicto: 'pendiente', veredicto_anterior: null, propuesta: null, pedido: null, asignado: null, estado: 'viva',
    casos: [], casos_total: 0,
  }, casos));
  const p = problemasDeForma(f);
  if (p.length) throw new Error(`la ficha no tiene forma: ${p.join('; ')}`);
  return f;
}

/**
 * La noche que vuelve a ver la causa: misma ficha, una aparición más (una por noche) y el contador borrado. Una que
 * estaba resuelta y vuelve pierde la propuesta del modelo y sus fallas: se le vuelve a pedir.
 */
function registrarAparicion(f, hoy, casos) {
  const g = conCasos({ ...f }, casos);
  if (g.ultima_vez !== hoy) { g.apariciones = (g.apariciones || 0) + 1; g.ultima_vez = hoy; }
  delete g.noches_sin_aparecer;
  delete g.noche_contada;
  if (f.estado === 'resuelta') { g.propuesta = null; delete g.propuesta_motivo; delete g.propuesta_fallas; delete g.propuesta_fallo_el; }
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

module.exports = {
  FUENTES, VEREDICTOS, ESTADOS, CARPETAS, CLAVES, TOPE_CASOS, TOPE_HUELLAS, NOCHES_POR_DEFECTO,
  ACCIONES, MOTIVOS_SIN_PROPUESTA, FALLAS_MAX, razonSegura, problemasDeForma, nuevaFicha, conCasos, registrarAparicion, fichaDeCausa, contarNoche, carpetaDe, carpetasDe,
  asegurarCarpetas, leerCarpetas, serializar, parsear, nochesParaResolver, formatoPorSecciones,
};
