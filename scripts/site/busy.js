'use strict';
/**
 * busy.js — el ayudante común de los botones del sitio que le piden algo al servidor, y la regla que lo exige.
 *
 * `TRABAJANDO` es el código del ayudante, en ES5, como texto: lo interpolan las pantallas que llaman al servidor
 * (Configuración, «Cómo trabaja» y Hallazgos), porque cada pestaña es su propio guion y no comparten nada en el
 * navegador. Define:
 *   · `trabajando(boton, texto, accion, opciones)` — desde el toque, el botón queda apagado, con `aria-busy="true"` y el
 *     texto de lo que hace; a los 10 s suma «sigue trabajando». Al terminar vuelve como estaba. Si la acción falló (una
 *     respuesta con `ok: false` o una promesa rechazada) dice el motivo al lado del botón, salvo que la acción ya diga su
 *     error en su lugar (`opciones.muestraSuError`). Un segundo toque mientras trabaja no hace nada. `boton` es el
 *     elemento, o una clave de texto en las pantallas que se vuelven a dibujar enteras: ahí el botón nuevo toma su
 *     estado con `pintarTrabajo(boton, clave)` y `TRABAJO.alCambiar` vuelve a dibujar.
 *   · `fallaDeTrabajo(clave)` — el motivo de la última falla de esa clave, para dibujarlo al lado del botón nuevo.
 *
 * Del lado de Node: `crear(ambiente)` arma el ayudante para las pruebas, y `revisarLlamadas(archivos, excepciones)` es
 * la regla para lo nuevo: cada `fetch(` y cada `api(` del código del sitio y de la oficina está dentro de un
 * `trabajando(` (o de un `botonQueTrabaja(`, su atajo en Configuración), en una función que se llama desde uno (hasta
 * dos niveles), o en `EXCEPCIONES` con su motivo.
 */

/** La primera línea del ayudante: la prueba la busca en cada pantalla que lo interpola. */
const FIRMA = '/* trabajando · scripts/site/busy.js */';
/** Los textos que dicen los botones mientras trabajan (scripts/site/texts.js): las pantallas que no son Configuración los suman a los suyos. */
const TEXTOS = Object.freeze(['pantalla.revisando', 'pantalla.guardando', 'pantalla.proponiendoBoton', 'pantalla.abriendo', 'pantalla.sigueTrabajando']);

const TRABAJANDO = `${FIRMA}
var TRABAJO = { ocupados: [], fallos: {}, sigueMs: 10000, sigue: 'sigue trabajando', sinMotivo: '', alCambiar: null };
function registroDeTrabajo(boton) {
  for (var i = 0; i < TRABAJO.ocupados.length; i++) if (TRABAJO.ocupados[i].boton === boton) return TRABAJO.ocupados[i];
  return null;
}
function textoDeTrabajo(r) { return r.sigue ? r.texto + ' · ' + TRABAJO.sigue : r.texto; }
/** Aplica el estado de la clave a un botón recién dibujado (pantallas que se vuelven a dibujar enteras). */
function pintarTrabajo(boton, clave) {
  var r = registroDeTrabajo(clave);
  if (!r) return boton;
  boton.setAttribute('disabled', 'disabled');
  boton.setAttribute('aria-busy', 'true');
  boton.textContent = textoDeTrabajo(r);
  return boton;
}
function fallaDeTrabajo(clave) { return Object.prototype.hasOwnProperty.call(TRABAJO.fallos, clave) ? TRABAJO.fallos[clave] : null; }
function motivoDeTrabajo(boton) {
  var s = boton && boton.nextSibling;
  return s && s.getAttribute && s.getAttribute('data-motivo') === 'trabajando' ? s : null;
}
function trabajando(boton, texto, accion, opciones) {
  opciones = opciones || {};
  if (registroDeTrabajo(boton)) return Promise.resolve(null);
  var esElemento = typeof boton !== 'string';
  var r = { boton: boton, texto: texto, sigue: false, antes: null, apagado: null, reloj: null };
  TRABAJO.ocupados.push(r);
  delete TRABAJO.fallos[boton];
  if (esElemento) {
    var viejo = motivoDeTrabajo(boton);
    if (viejo && viejo.parentNode) viejo.parentNode.removeChild(viejo);
    r.antes = boton.textContent; r.apagado = boton.getAttribute('disabled');
    pintarTrabajo(boton, boton);
  }
  var cambio = function () { if (esElemento) { if (registroDeTrabajo(boton)) boton.textContent = textoDeTrabajo(r); } else if (TRABAJO.alCambiar) TRABAJO.alCambiar(); };
  r.reloj = setTimeout(function () { if (registroDeTrabajo(boton) === r) { r.sigue = true; cambio(); } }, TRABAJO.sigueMs);
  if (r.reloj && r.reloj.unref) r.reloj.unref();
  cambio();
  var terminar = function (resp, error) {
    clearTimeout(r.reloj);
    TRABAJO.ocupados.splice(TRABAJO.ocupados.indexOf(r), 1);
    var motivo = null;
    if (error) motivo = String((error && error.message) || error || TRABAJO.sinMotivo);
    else if (resp && resp.ok === false && !opciones.muestraSuError) motivo = String(resp.message || TRABAJO.sinMotivo);
    if (esElemento) {
      boton.textContent = r.antes;
      if (r.apagado === null) boton.removeAttribute('disabled'); else boton.setAttribute('disabled', r.apagado);
      boton.removeAttribute('aria-busy');
      if (motivo && boton.parentNode) {
        var nota = document.createElement('span');
        nota.setAttribute('class', 'trabajando-motivo');
        nota.setAttribute('role', 'status');
        nota.setAttribute('data-motivo', 'trabajando');
        nota.textContent = motivo;
        boton.parentNode.insertBefore(nota, boton.nextSibling);
      }
    } else {
      if (motivo) TRABAJO.fallos[boton] = motivo;
      if (TRABAJO.alCambiar) TRABAJO.alCambiar();
    }
    return error ? { ok: false, message: motivo } : resp;
  };
  var p;
  try { p = Promise.resolve(accion()); } catch (e) { p = Promise.reject(e); }
  return p.then(function (resp) { return terminar(resp, null); }, function (e) { return terminar(null, e); });
}
`;

/**
 * El ayudante como funciones de Node, para las pruebas: `{ trabajando, pintarTrabajo, fallaDeTrabajo, TRABAJO }`.
 * `ambiente`: `document` (para el motivo al lado del botón), `setTimeout`/`clearTimeout` y `textos.sigue`.
 */
function crear(ambiente = {}) {
  const fabrica = new Function('document', 'setTimeout', 'clearTimeout', `${TRABAJANDO}\nreturn { trabajando: trabajando, pintarTrabajo: pintarTrabajo, fallaDeTrabajo: fallaDeTrabajo, TRABAJO: TRABAJO };`);
  const h = fabrica(ambiente.document, ambiente.setTimeout || setTimeout, ambiente.clearTimeout || clearTimeout);
  if (ambiente.textos && ambiente.textos.sigue) h.TRABAJO.sigue = ambiente.textos.sigue;
  return h;
}

// ── la regla para lo nuevo ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Las llamadas al servidor que no van por el ayudante, cada una con su motivo. `funcion` es el nombre de la función que
 * la contiene (la más cercana con nombre, o una de las que la envuelven).
 */
const EXCEPCIONES = Object.freeze([
  { archivo: 'scripts/lib/org-config.js', funcion: 'cargar', motivo: 'la carga de la pestaña y la relectura después de un pedido: no hay botón; si falla, la pantalla lo dice' },
  { archivo: 'scripts/lib/org-config.js', funcion: 'seguir', motivo: 'el seguimiento de fondo de un pedido ya propuesto: no hay botón; la sección dice en qué está el pedido' },
  { archivo: 'scripts/lib/org-config.js', funcion: 'tiposDePedidoLeidos', motivo: 'una lectura al dibujar la sección de pedidos de trabajo: dice «cargando» en su lugar' },
  { archivo: 'scripts/lib/org-config.js', funcion: 'camposDeTipoLeidos', motivo: 'una lectura al dibujar la sección de pedidos de trabajo: dice «cargando» en su lugar' },
  { archivo: 'scripts/lib/org-config.js', funcion: 'pipelinesDe', motivo: 'una lectura al dibujar Despliegues: dice «cargando» en su lugar' },
  { archivo: 'scripts/lib/org-config.js', funcion: 'pasosDe', motivo: 'los nombres de los pasos, leídos al dibujar Despliegues: sin ellos se ven los identificadores' },
  { archivo: 'scripts/lib/org-config.js', funcion: 'abrirRepo', motivo: 'abre el panel de un repo de producto, que ya dice «Leyendo…» mientras carga' },
  { archivo: 'scripts/site/tabs/findings.js', funcion: 'porLaLista', motivo: 'el último paso del envío de Hallazgos cuando el envío no contestó: corre mientras el botón ya dice que trabaja' },
  { archivo: 'scripts/tools/office/page.js', funcion: 'abrirCharla', motivo: 'leer la conversación de una sesión: la ventana ya dice «Leyendo…» y avisa si falla (AC 6)' },
  { archivo: 'scripts/tools/office/page.js', funcion: 'mandar', motivo: 'mandarle un mensaje a una sesión desde la oficina local: el botón queda apagado mientras se manda y la línea de estado dice «Mandado.» o por qué no se pudo' },
  { archivo: 'scripts/tools/office/page.js', funcion: 'quitarCerrada', motivo: 'quitar una sesión cerrada desde la oficina local: el botón queda apagado mientras se quita, dice «Quitada» o, debajo del nombre, por qué no se pudo' },
  { archivo: 'scripts/tools/office/page.js', funcion: 'esperarRespuesta', motivo: 'la espera de fondo de la respuesta a un mensaje ya mandado: no hay botón; la lista «Con vos» se pone al día sola' },
  { archivo: 'scripts/tools/office/page.js', funcion: 'arrancarOficinas', motivo: 'la carga de la pestaña de la demo: no hay botón; si falla, la página lo dice' },
]);

/**
 * La parte de cada archivo que corre en el navegador, cuando el archivo también tiene código del servidor: desde el
 * renglón que la abre (desde su primera comilla invertida) hasta el primer «`;» que la cierra. Un archivo sin entrada
 * se mira entero.
 */
const REGIONES = Object.freeze({
  'scripts/lib/org-config.js': /^function pantalla\(/,
  'scripts/site/tabs/how-it-works.js': /^function guion\(/,
  'scripts/site/tabs/findings.js': /^const CLIENTE = `/,
});

/**
 * El texto con lo que no es código tapado por espacios (comentarios, cadenas entre comillas y expresiones regulares),
 * del mismo largo, para contar llaves y paréntesis sin que un «{» de una cadena los corra. Las comillas invertidas se
 * tratan como cadenas: el código de cliente de las pantallas no las usa, y en la oficina sólo aparecen en comentarios y
 * en expresiones regulares.
 */
const ABRE_EXPRESION = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|instanceof|do|else|yield|await)\s*$/;
function tapar(texto) {
  const c = texto.split('');
  const n = c.length;
  let i = 0;
  let previo = '';
  const espacio = (j) => { if (c[j] !== '\n') c[j] = ' '; };
  while (i < n) {
    const ch = texto[i];
    const sig = texto[i + 1];
    if (ch === '/' && sig === '/') { while (i < n && texto[i] !== '\n') { espacio(i); i += 1; } continue; }
    if (ch === '/' && sig === '*') { espacio(i); espacio(i + 1); i += 2; while (i < n && !(texto[i] === '*' && texto[i + 1] === '/')) { espacio(i); i += 1; } if (i < n) { espacio(i); espacio(i + 1); i += 2; } continue; }
    if (ch === '\'' || ch === '"' || ch === '`') {
      i += 1;
      while (i < n && texto[i] !== ch) { if (texto[i] === '\\') { espacio(i); i += 1; } if (i < n) { espacio(i); i += 1; } if (ch !== '`' && texto[i] === '\n') break; }
      i += 1; previo = 'x'; continue;
    }
    // una barra después de algo que no termina una expresión abre una expresión regular; después de una palabra clave
    // (return, typeof…) también, aunque la palabra termine en letra
    if (ch === '/' && (!/[\w$)\]]/.test(previo) || ABRE_EXPRESION.test(texto.slice(Math.max(0, i - 12), i)))) {
      i += 1;
      let clase = false;
      while (i < n && texto[i] !== '\n') {
        if (texto[i] === '\\') { espacio(i); i += 1; espacio(i); i += 1; continue; }
        if (texto[i] === '[') clase = true; else if (texto[i] === ']') clase = false; else if (texto[i] === '/' && !clase) break;
        espacio(i); i += 1;
      }
      i += 1; previo = 'x'; continue;
    }
    if (!/\s/.test(ch)) previo = ch;
    i += 1;
  }
  return c.join('');
}

/** El índice de lo que cierra lo abierto en `desde` (un «(» o un «{»), en el texto tapado; -1 si no cierra. */
function cierre(tapado, desde) {
  const abre = tapado[desde];
  const cierra = abre === '(' ? ')' : '}';
  let hondo = 0;
  for (let i = desde; i < tapado.length; i += 1) {
    if (tapado[i] === abre) hondo += 1;
    else if (tapado[i] === cierra) { hondo -= 1; if (hondo === 0) return i; }
  }
  return -1;
}

/** Las funciones con nombre del texto tapado, con su cuerpo: `[{ nombre, desde, hasta }]`. */
function funcionesDe(tapado, desde, hasta) {
  const out = [];
  const formas = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function\b[^(]*\(|\([^)]*\)\s*=>\s*\{|[A-Za-z_$][\w$]*\s*=>\s*\{)/g,
    /([A-Za-z_$][\w$]*)\s*:\s*function\s*\(/g,
  ];
  for (const rx of formas) {
    rx.lastIndex = desde;
    let m;
    while ((m = rx.exec(tapado)) && m.index < hasta) {
      const llave = tapado.indexOf('{', m.index + m[0].length - 1);
      if (llave < 0 || llave >= hasta) continue;
      // con «function nombre(…)», la llave va después de cerrar los parámetros
      let inicio = llave;
      const par = tapado.lastIndexOf('(', m.index + m[0].length - 1);
      if (/function/.test(m[0]) && par >= m.index) { const fin = cierre(tapado, par); if (fin < 0) continue; inicio = tapado.indexOf('{', fin); if (inicio < 0) continue; }
      const fin = cierre(tapado, inicio);
      if (fin < 0) continue;
      out.push({ nombre: m[1], desde: inicio, hasta: fin });
    }
  }
  return out;
}

/**
 * Los cuerpos de los manejadores de eventos (`onclick: function…`, `b.onclick = () => …`, `addEventListener('click', …)`)
 * entre `desde` y `hasta`: `[inicio, fin]` en el texto tapado. Un botón definido adentro de una función de la lista de
 * excepciones no hereda su excepción.
 */
function manejadoresDe(tapado, desde, hasta) {
  const out = [];
  const formas = [
    /\bon[a-z]+\s*[:=]\s*(?=function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g,
    /\baddEventListener\s*\(\s*(['"`])\s*\1\s*,\s*(?=function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g,
  ];
  for (const rx of formas) {
    rx.lastIndex = desde;
    let m;
    while ((m = rx.exec(tapado)) && m.index < hasta) {
      const ini = m.index + m[0].length;
      let cuerpo = -1;
      if (/^function\b/.test(tapado.slice(ini))) {
        const par = tapado.indexOf('(', ini);
        const fin = par < 0 ? -1 : cierre(tapado, par);
        cuerpo = fin < 0 ? -1 : tapado.indexOf('{', fin);
        const cf = cuerpo < 0 ? -1 : cierre(tapado, cuerpo);
        if (cf > 0) out.push([cuerpo, cf]);
        continue;
      }
      const flecha = tapado.indexOf('=>', ini);
      if (flecha < 0) continue;
      let j = flecha + 2;
      while (j < tapado.length && /\s/.test(tapado[j])) j += 1;
      if (tapado[j] === '{') { const cf = cierre(tapado, j); if (cf > 0) out.push([j, cf]); continue; }
      // una flecha sin llaves: hasta la coma o el cierre del nivel en que está
      let hondo = 0; let k = j;
      for (; k < tapado.length; k += 1) {
        const c = tapado[k];
        if (c === '(' || c === '[' || c === '{') hondo += 1;
        else if (c === ')' || c === ']' || c === '}') { if (hondo === 0) break; hondo -= 1; } else if ((c === ',' || c === ';') && hondo === 0) break;
      }
      out.push([j, k]);
    }
  }
  return out;
}

const LLAMADA = /(^|[^\w$.])(fetch|api)\s*\(/g;
// `botonQueTrabaja(` es el atajo de la pantalla de Configuración: arma el botón y le pasa la acción a trabajando()
const TRABAJA = /(^|[^\w$.])(?:trabajando|botonQueTrabaja)\s*\(/g;

/**
 * La regla: `[{ archivo, renglon, motivo }]` por cada llamada al servidor que no va por el ayudante ni está en la lista,
 * y por cada excepción sin motivo. `archivos`: `[{ archivo, texto }]` con la ruta desde la raíz del repo.
 */
function revisarLlamadas(archivos, excepciones = EXCEPCIONES) {
  const rojos = [];
  for (const x of excepciones) if (!x || !String(x.motivo || '').trim()) rojos.push({ archivo: x && x.archivo, renglon: 0, motivo: `la excepción de «${x && x.funcion}» no tiene motivo` });
  for (const { archivo, texto } of archivos) {
    let desde = 0;
    let hasta = texto.length;
    const region = REGIONES[archivo];
    if (region) {
      const lineas = texto.split('\n');
      let pos = 0; let ini = -1; let fin = -1;
      for (const l of lineas) {
        if (ini < 0 && region.test(l)) ini = pos;
        else if (ini >= 0 && l === '`;') { fin = pos; break; }
        pos += l.length + 1;
      }
      // el código de cliente empieza después de la comilla invertida que lo abre
      const abre = ini < 0 ? -1 : texto.indexOf('`', ini);
      if (ini < 0 || fin < 0 || abre < 0 || abre > fin) { rojos.push({ archivo, renglon: 0, motivo: 'no encuentro el código de cliente del archivo: la regla no lo puede mirar' }); continue; }
      desde = abre + 1; hasta = fin;
    }
    const tapado = texto.slice(0, desde).replace(/[^\n]/g, ' ') + tapar(texto.slice(desde, hasta)) + texto.slice(hasta).replace(/[^\n]/g, ' ');
    const funciones = funcionesDe(tapado, desde, hasta);
    const nombres = new Set(funciones.map((f) => f.nombre));
    const tramos = [];
    TRABAJA.lastIndex = 0;
    let m;
    while ((m = TRABAJA.exec(tapado))) {
      if (/function\s*$/.test(tapado.slice(Math.max(0, m.index - 12), m.index + m[1].length))) continue;
      const par = tapado.indexOf('(', m.index + m[1].length);
      const fin = cierre(tapado, par);
      if (fin > 0) tramos.push([par, fin]);
    }
    // una función se alcanza llamada o nombrada (la acción se puede pasar por su nombre: `trabajando(b, t, guardar)`)
    const nombradasEn = (a, b) => { const s = new Set(); const rx = /(^|[^\w$.])([A-Za-z_$][\w$]*)/g; rx.lastIndex = a; let k; while ((k = rx.exec(tapado)) && k.index < b) if (nombres.has(k[2])) s.add(k[2]); return s; };
    const alcanzables = new Set();
    for (const [a, b] of tramos) for (const nombre of nombradasEn(a, b)) alcanzables.add(nombre);
    // hasta que no aparezca ninguna nueva: lo alcanzado desde lo alcanzado, a cualquier profundidad
    const pendientes = [...alcanzables];
    while (pendientes.length) {
      const nombre = pendientes.pop();
      for (const f of funciones.filter((x) => x.nombre === nombre)) for (const otra of nombradasEn(f.desde, f.hasta)) if (!alcanzables.has(otra)) { alcanzables.add(otra); pendientes.push(otra); }
    }
    const manejadores = manejadoresDe(tapado, desde, hasta);
    const propias = excepciones.filter((x) => x && x.archivo === archivo && String(x.motivo || '').trim()).map((x) => x.funcion);
    LLAMADA.lastIndex = 0;
    while ((m = LLAMADA.exec(tapado))) {
      const pos = m.index + m[1].length;
      if (/function\s*$/.test(tapado.slice(Math.max(0, pos - 12), pos))) continue;
      if (tramos.some(([a, b]) => pos > a && pos < b)) continue;
      const envuelven = funciones.filter((f) => pos > f.desde && pos < f.hasta).sort((p, q) => (q.desde - p.desde));
      if (envuelven.length && alcanzables.has(envuelven[0].nombre)) continue;
      // la excepción cubre la función nombrada y sus vueltas, no una función con nombre ni un botón definidos adentro
      if (envuelven.length && propias.includes(envuelven[0].nombre) && !manejadores.some(([a, b]) => pos >= a && pos < b && a > envuelven[0].desde)) continue;
      const renglon = texto.slice(0, pos).split('\n').length;
      const donde = envuelven.length ? `en «${envuelven[0].nombre}»` : 'fuera de una función con nombre';
      rojos.push({ archivo, renglon, motivo: `${m[2]}( ${donde} no va por trabajando() ni está en la lista de excepciones con su motivo` });
    }
  }
  return rojos;
}

module.exports = { FIRMA, TEXTOS, TRABAJANDO, crear, EXCEPCIONES, REGIONES, revisarLlamadas, tapar };
