#!/usr/bin/env node
'use strict';
/*
 * runs.js — LA VISTA DE CORRIDAS DEL TABLERO, sesión por sesión
 *
 * Una fila por corrida del pipeline —cuánto duró, dónde se fue el tiempo y los tokens, qué control
 * encontró un error o frenó, cuántas vueltas dio, cuántos agentes lanzó— y una capa ejecutiva
 * arriba que resume el conjunto. Segunda página de la misma pieza: la genera
 * `node scripts/nightly/dashboard/dashboard.js --view runs` y escribe `~/.claude/.tycon-pipeline/runs-dashboard.html`.
 *
 * 🔴 NO SE COMMITEA: una copia en `artifacts/` mostraría las corridas de UNA máquina —la que la
 * regenerara—, y el total cambiaría según quién la hubiera armado por última vez. La vista completa
 * sale de la carpeta bajada del buzón, que cualquier máquina con la
 * sesión de Azure de quien tiene el permiso llena sola al arrancar.
 *
 * VARIAS MÁQUINAS: si en esta máquina está la carpeta bajada del buzón de corridas
 * (`~/.claude/.tycon-pipeline/corridas-buzon/`, la llena `scripts/metrics/download-runs.js` en las
 * máquinas de quienes pueden leer el buzón), la vista la lee también —`<carpeta>/<maquina>/`—, suma la
 * columna y el filtro por máquina, el sello dice qué máquinas cubre, y la página se escribe en
 * `<carpeta>/runs-dashboard.html`. Con o sin buzón, NUNCA en el repo del equipo (se niega con exit 2).
 * `--mailbox <dir>` la fuerza; `--local-only` la apaga (sólo las corridas de esta máquina).
 *
 * DE DÓNDE LEE: del registro global del archivador, `~/.claude/.tycon-pipeline/timing-history/`
 * (un volcado JSON por corrida). Es superset de lo que hay en cada repo y es local: una máquina
 * sin pipeline corrido NO rompe el tablero — la fuente se declara NO obligatoria en sources.json
 * y la página sale gris con motivo, exit 0.
 *
 * LO QUE LEE DEL HILO: sólo las ediciones y escrituras de archivos con su cambio, y los
 * commits (`changes.js`). Como los cambios traen
 * código de cliente, la página NO se commitea (vive en ~/.claude, o en la carpeta
 * bajada del buzón, que sólo leen quienes tienen permiso), así que el detalle de cada corrida los
 * muestra, saneados (credenciales tapadas) y con tope de largo. Los prompts y las respuestas del hilo
 * siguen sin publicarse. El cambio va comprimido adentro de la página y se abre a pedido.
 *
 * LO QUE LEE DE GIT: el `<volcado>.cambio.json.gz` que deja el archivador — los commits de la
 * corrida y lo que quedó sin commitear, en cada repo donde escribió. Es el «qué» completo y exacto (la
 * conversación no ve la consola ni los subagentes) y va ARRIBA; la lista del hilo queda abajo para el
 * «cuándo», con lo de consola marcado «aproximado» y sin los nombres que git no confirma. Los parches
 * vuelven a pasar por `sanear` y van comprimidos fuera del modelo (`cg-N`).
 *
 * 🔴 LISTA BLANCA, NO NEGRA: el modelo que llega a la página se construye campo por campo
 * (`modeloDeCorrida`). Nunca se hace spread ni JSON.stringify del volcado — una lista negra falla
 * con el primer campo que nadie previó (`planApproval.text` ES el prompt del dev; `gates[].cmd`
 * trae rutas del scratchpad). El único texto crudo que se publica, el mensaje rescatado, pasa OTRA
 * VEZ por `sanear` de tokens-digest.js antes de dibujarse (defensa en profundidad para un volcado
 * escrito por una versión vieja del rescate). El caso T4 de la suite carga cada campo prohibido con
 * un marcador y exige que ninguno llegue al HTML.
 *
 * LAS TRES REGLAS DE LA CASA, acá:
 *   1. «No medido» nunca es verde ni cero: sin `costo` no es «0 agentes», sin `gates` no es verde,
 *      sin `consumo` medido no es «0 tokens». Cada ausencia sale con su motivo.
 *   2. Denominador al lado: toda mediana lleva `n=k de N corridas`.
 *   3. El registro ES el padrón: la ausencia se detecta en dos niveles — la fuente entera (gris con
 *      motivo) y campo por campo dentro de cada corrida (se cuenta cuántas lo traen).
 *
 * LA CAPA EJECUTIVA SE DIBUJA EN EL CLIENTE, no acá: el filtro (fechas, producto, sólo las que
 * llegaron al final) la RECALCULA. Si viviera en los dos lados, el día que cambie una regla el
 * filtro mostraría otra cosa que el encabezado. La suite la ejercita corriendo el cliente real
 * sobre un DOM mínimo en Node (sin navegador). Sin red: ni tipografías ni bibliotecas externas.
 *
 * EN EL SITIO DE LA ORGANIZACIÓN: la pestaña Corridas (scripts/site/tabs/runs.js) usa ESTE modelo y ESTE
 * cliente, no una copia. Cada corrida lleva un id estable (`idEstable`: máquina + sesión, y el arranque cuando la sesión
 * tiene varias corridas; sin publicar la sesión), y el
 * modelo se parte en lo que viaja por separado: `paraLista` (lista blanca: la cabecera, las fichas, los gráficos y el
 * filtro), `paraDetalle` (al abrir una corrida) y `textosDe` (al abrir un cambio). La página se arma con `cabecera`,
 * `ejecutiva`, `tabla` y `pie`, que `render` compone; el sitio las usa con `opts.sitio` y lo ya filtrado
 * para quien pide. El cliente lee sus datos de una FUENTE: embebida en la página local o por la red
 * en el sitio (`#fuente-corridas`). `modelo()` acepta `soloBuzon`, `sinUnificar`, `sinHilos`, `umbralesArchivo` y
 * `skillsDir` para el sitio; sin ellas, la vista local es la de siempre.
 *
 * Contrato de salida (`main` devuelve el código; dashboard.js hace el exit):
 *   0 → midió (aunque haya rojos; registro ausente también es 0: la fuente no es obligatoria)
 *   2 → se negó a escribir una página con corridas del buzón dentro del repo del equipo, o se pidió
 *       `--clone` (retirado: se usa `--mailbox`)
 *   3 → no pudo escribir la página
 */

const fs = require('fs');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { num1, esc, CSS_BASE, CSS_CHIPS } = require('./common');
const { readEnv, prepareStateWrite } = require('../../lib/legacy-names.js');

const RAIZ = path.resolve(__dirname, '..', '..', '..');

// Los textos de la vista viven en la tabla del sitio (`corridas.*`, `{ es, en }`): la página de la noche los pide en
// castellano y el sitio, en el idioma de la página. El modelo guarda sus frases en castellano, como siempre; al pintar en
// otro idioma, cada frase de la casa se reconoce por su molde y sale traducida. Lo que vino de afuera (un volcado, un
// lector, un repo) no calza con ningún molde y pasa tal cual.
// Los textos son de runs-texts.js, al lado: la vista viaja sin el sitio. Con la tabla del sitio presente (en el sitio, en el
// repo entero) los idiomas y la traducción de las frases salen de ella; sin ella, todo en castellano.
const PROPIOS = require('./runs-texts.js').TEXTOS;
const TX = (() => {
  const tabla = path.join(__dirname, '..', '..', 'site', 'texts.js');
  if (!fs.existsSync(tabla)) return null;
  // una tabla presente que no carga no tumba la página de la noche: queda en castellano y lo dice
  try { return require(tabla); } catch (e) {
    process.stderr.write(`runs.js: la tabla de textos del sitio no cargó (${e && (e.code || e.message)}): la vista queda en castellano\n`);
    return null;
  }
})();
const ES = 'es';
const PREFIJO = 'corridas.';
const llenar = (s, v) => String(s).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (m, n) => (v && Object.prototype.hasOwnProperty.call(v, n) ? String(v[n]) : m));
/** Un texto fijo de la vista, por su clave (sin el prefijo), en `idioma` (sin idioma: castellano). */
const L = (idioma, clave, valores) => {
  if (TX) return TX.t(idioma || TX.POR_DEFECTO, PREFIJO + clave, valores);
  const e = PROPIOS[PREFIJO + clave];
  if (!e) throw new Error(`runs-texts.js: no hay texto para la clave «${PREFIJO + clave}»`);
  return llenar(e.es, valores);
};
/** Una frase que armó el modelo (en castellano), en `idioma`: traducida si es de la casa; si no, tal cual. */
// Sólo los moldes de las frases del modelo (`corridas.m.*`) y los nombres de los pasos (`paso.*`): nunca los textos de la
// página, que podrían coincidir con un valor que el cliente compara (`estado: 'medido'`) y romperlo en otro idioma.
const MOLDES_DEL_MODELO = [`${PREFIJO}m.`, 'paso.'];
const enIdioma = (idioma, frase, moldes = MOLDES_DEL_MODELO) => {
  if (!TX || typeof frase !== 'string' || !idioma || idioma === TX.POR_DEFECTO) return frase;
  const dicha = TX.traducirMensaje(idioma, frase, moldes);
  // los pasos fundidos («Revisores + Hallazgos: el informe») se traducen de a uno
  return dicha === frase && frase.includes(' + ') ? frase.split(' + ').map((p) => TX.traducirMensaje(idioma, p, moldes)).join(' + ') : dicha;
};
// Las claves del modelo que llevan una frase de la casa. Todo lo demás es de afuera (la story, el producto, la máquina,
// el título, el asunto de un commit) y pasa tal cual aunque coincida con un molde, como CLAVES_CON_MENSAJE de texts.js.
const CLAVES_DE_LA_CASA = new Set(['motivo', 'fuente', 'nombre', 'vueltas_fuente', 'maquina_motivo', 'maquina_nota', 'motivo_tramos', 'nota',
  'commits_motivo', 'otras_motivo', 'sin_rescate', 'sin_tiempos', 'sin_hilos', '_comentario', '_nota']);
// las que llevan una lista o un mapa de nombres de la casa (los pasos, los controles)
const LISTAS_DE_LA_CASA = new Set(['nombres', 'controles_nombres']);
// un archivo tocado es un dato; sólo sus dos frases de la casa se traducen, nunca un nombre que coincida con un molde
const MOLDES_DE_ARCHIVO = [`${PREFIJO}m.fueraDelRepo`, `${PREFIJO}m.sinResumir`];
// las claves que son un dato salvo por una frase de la casa, con los únicos moldes que se les prueban: el archivo
// tocado, el nombre del repo («repo sin nombre») y el motivo de la lista vacía que arma el acceso del sitio (access.js)
// (un Map y no un objeto: una clave de afuera que se llama `constructor` no encuentra nada)
const MOLDES_POR_CLAVE = new Map([['f', MOLDES_DE_ARCHIVO], ['n', [`${PREFIJO}m.repoSinNombre`]], ['vacio_motivo', [`${PREFIJO}vacio`]]]);
// las ramas de afuera dentro de una clave de la casa: `nombre` es de la casa en un paso, y en la lista de máquinas
// (`maquinas.lista[].nombre`) es el nombre de una máquina
const RAMAS_DE_AFUERA = new Map([['maquinas', new Set(['lista'])]]);
/** Una respuesta entera del modelo (la lista, un detalle) con cada frase de la casa en `idioma`; lo de afuera no se toca. */
function todoEnIdioma(idioma, valor) {
  if (!TX || !idioma || idioma === TX.POR_DEFECTO) return valor;
  const recorrer = (v, clave) => {
    if (typeof v === 'string') return MOLDES_POR_CLAVE.has(clave) ? enIdioma(idioma, v, MOLDES_POR_CLAVE.get(clave)) : CLAVES_DE_LA_CASA.has(clave) ? enIdioma(idioma, v) : v;
    if (Array.isArray(v)) return v.map((x) => recorrer(x, LISTAS_DE_LA_CASA.has(clave) ? 'nombre' : clave));
    if (v && typeof v === 'object') {
      const deAfuera = RAMAS_DE_AFUERA.get(clave);
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deAfuera && deAfuera.has(k) ? x
        : LISTAS_DE_LA_CASA.has(clave) && typeof x === 'string' ? enIdioma(idioma, x) : recorrer(x, k)]));
    }
    return v;
  };
  return recorrer(valor, null);
}
/**
 * Los textos del código de pantalla (`corridas.c.*`) en `idioma`, en un atributo de un elemento oculto de la página (el
 * sitio no permite scripts en línea): el cliente es un solo archivo para los dos idiomas y los lee de ahí. Sin el
 * elemento (la página de la noche, una página vieja en caché), el cliente usa el castellano que trae adentro.
 */
function textosDelCliente(idioma) {
  if (TX) return TX.textosCon(idioma || TX.POR_DEFECTO, `${PREFIJO}c.`);
  const p = `${PREFIJO}c.`;
  return Object.fromEntries(Object.entries(PROPIOS).filter(([k]) => k.startsWith(p)).map(([k, v]) => [k.slice(p.length), v.es]));
}
function bloqueDeTextos(idioma) {
  return `<div id="corridas-textos" data-textos="${esc(JSON.stringify(textosDelCliente(idioma)))}" hidden></div>`;
}

// El rescate exporta el saneado del mensaje y el corte de pasos. Se importa, no se
// copia: dos saneados se separan solos. Si el módulo no está (arnés partido), se DICE y el
// mensaje no se publica — un mensaje sin sanear es peor que ninguno.
let rescate = null;
let motivoSinRescate = null;
try { rescate = require('../../metrics/tokens-digest.js'); }
catch (e) { motivoSinRescate = `scripts/metrics/tokens-digest.js no se pudo cargar (${e.code || e.message}): los mensajes de error no se publican y los pasos no se cortan`; }

// Los archivos que tocó cada corrida y su cambio, leídos del hilo. Sin el módulo, el detalle lo dice.
let cambios = null;
let motivoSinCambios = null;
try { cambios = require('./changes.js'); }
catch (e) { motivoSinCambios = `scripts/nightly/dashboard/changes.js no se pudo cargar (${e.code || e.message}): el detalle no muestra los archivos que tocó cada ejecución`; }

// La cuenta de trabajo, espera y hueco vive en UN archivo, el mismo para la corrida nueva
// (con arranque por paso) y la vieja (sin arranque: estimada). Sin él, los tramos se cortan sin esa cuenta.
let cuentaTiempos = null;
let motivoSinTiempos = null;
// La cuenta de VUELTAS es la del latido (`vueltaDeVolcado`), no `costo.iteraciones` —
// ése cuenta las veces que se calculó el set de revisores y no coincide con lo medido; se
// publica aparte, con su nombre. Sin el script la columna sale «—» y la página lo dice.
let cuentaVueltas = null; let motivoSinVueltas = null;
try { ({ vueltaDeVolcado: cuentaVueltas } = require('../../metrics/retro-heartbeat.js')); }
catch (e) { motivoSinVueltas = `scripts/metrics/retro-heartbeat.js no se pudo cargar (${e.code || e.message}): las vueltas de revisión no se publican`; }
try { cuentaTiempos = require('../../metrics/step-times.js'); }
catch (e) { motivoSinTiempos = `scripts/metrics/step-times.js no se pudo cargar (${e.code || e.message}): los pasos se cortan del fin del anterior al fin de éste, sin separar trabajo, espera ni tiempo entre pasos`; }

// El nombre de esta máquina sale de la subida: la carpeta que la subida crea en el buzón
// y la máquina que esta vista le atribuye a las corridas locales tienen que ser la MISMA
// palabra. Sin el módulo, las corridas locales salen «sin declarar» con el motivo — nunca inventadas.
let subida = null;
let motivoSinSubida = null;
try { subida = require('../../metrics/upload-runs.js'); }
catch (e) { motivoSinSubida = `scripts/metrics/upload-runs.js no se pudo cargar (${e.code || e.message}): no se sabe el nombre de esta máquina`; }

// Una carpeta de la bajada es de una máquina si tiene la forma que la subida le da a ese nombre: la MISMA
// definición que usa la subida (si el módulo no está, la copia de respaldo es idéntica).
const FORMA_MAQUINA = (subida && subida.FORMA_MAQUINA) || /^[a-z0-9][a-z0-9._-]*$/;

// Las uniones de carpetas: cada máquina sube a `<nombre>-<código>`, y el bajador declara qué carpeta vieja
// es la historia de cuál nueva en `.carpetas-de-maquina.json`. Lo lee UNA función, la del reductor (la misma que usan
// el reductor y la poda). Si no carga (este archivo viaja suelto), no se une nada y se dice, como sin el archivo.
function leerUniones(buzon) {
  let leer;
  try { leer = require('./reducer.js').leerUnionesDeCarpetas; }
  catch (e) { return { estado: 'no_medidas', motivo: `el lector de uniones no se pudo cargar (${e.code || 'error'})` }; }
  return leer(buzon);
}
/** La marca visible de una carpeta vieja: la que se une a su nueva y las que no se unen. */
function notaDeCarpeta(vieja, u) {
  if (u.estado === 'unida') return `antes, ${vieja}`;
  if (u.estado === 'compartida') return `compartida por ${u.declarantes} máquinas: no se une`;
  return 'siguió recibiendo después de la mudanza';
}

// El nombre técnico de cada control no le dice nada a quien no lo escribió. Vive UNA vez, acá, y
// viaja en el modelo: si estuviera en el generador y en el cliente se separarían solos. Un control
// que no está en la lista sale con su nombre técnico — nunca se descarta.
const CONTROLES = {
  build: 'compila', tests: 'pruebas', acmatrix: 'matriz de criterios', advisors: 'revisores',
  'advisors-iter': 'revisores (otra vuelta)', atdd: 'prueba escrita antes',
  'atdd-preedit': 'prueba escrita antes (al editar)', 'atdd-commit': 'prueba escrita antes (al commit)',
  dod: 'terminado de verdad', mutation: 'mutación', 'plan-approval': 'aprobación del plan',
  'shared-surface': 'toca algo compartido', 'tests-scope': 'alcance de las pruebas',
  'story-skill-gate': 'la story entró por el pipeline', 'dep-gate': 'dependencias nuevas',
  'deep-review': 'pase adversarial',
  'adversarial-pass': 'pase adversarial (resultado)',
  // El 5b sin pase lo anota el portón, y el paso 8 no cierra sin el pase atendido.
  'adversarial-skip': 'pase adversarial (salteado por el portón)',
  'adversarial-result-gate': 'pase adversarial con su resultado (paso «Pase adversarial»)',
  'deep-review-gate': 'si corre el pase adversarial', 'story-gate': 'la story antes de programar',
  'story-evidence': 'la evidencia de la story', 'qa-guide': 'la guía para probar a mano',
  'advisors-complete': 'todos los revisores corrieron', 'step-order': 'el orden de los pasos',
  'smart-reloop': 'la vuelta de revisores recortada', 'plan-auto-approve': 'el plan aprobado solo',
  'review-a-done': 'de revisión a terminada', 'sin-nombre': 'un control sin nombre', 'smoke-run': 'la prueba de humo',
  RUNTIME_WAIVER: 'un criterio firmado sin correr', 'ac-shown': 'el criterio mostrado a la persona', approval: 'la aprobación',
};

// La línea `adversarial-pass` (marker.js mark-adversarial-result) no trae `status`: trae
// `veredicto` (`listo` = 0 confirmados · `no-listo` = hubo) y cuántos de los
// confirmados quedaron con su prueba en la suite y cuántos se difirieron. Sin esto sale «sin estado»
// —un pase con 13 confirmados dibujado igual que uno que no dejó constancia— y los números no se ven.
// La nota se arma SÓLO con enteros: el `motivo` del diferido es prosa del dev y no se publica.
function resultadoAdversarial(g) {
  if (String(g.check || g.name || g.gate || '') !== 'adversarial-pass' || g.status !== undefined) return null;
  // `no-medido`: el pase no revisó todo —alguna lente sin su cazador o algún hallazgo sin verificador—.
  // No es verde ni «sin estado»: es un pase que falta.
  const cls = g.veredicto === 'listo' ? 'paso' : (g.veredicto === 'no-listo' || g.veredicto === 'no-medido') ? 'error' : 'sin_estado';
  const n = (k) => (Number.isInteger(g[k]) && g[k] >= 0 ? g[k] : null);
  const c = n('confirmados');
  let nota = null;
  if (g.veredicto === 'no-medido') {
    const sm = Array.isArray(g.lentes_sin_medir) ? g.lentes_sin_medir.length : 0, sv = n('hallazgos_sin_veredicto') ?? 0;
    return { cls, nota: `no medido · ${sm} lente${sm === 1 ? '' : 's'} sin medir · ${sv} hallazgo${sv === 1 ? '' : 's'} sin veredicto` };
  }
  if (c !== null) {
    nota = `${c} confirmado${c === 1 ? '' : 's'}`;
    if (c > 0) {
      const p = n('pruebas'), d = n('diferidos'), pr = n('propias');
      // La línea trae `propias` (la prueba escrita a mano, verificada por el comando): con
      // ese campo son cuatro números. Una línea sin ese campo conserva su texto.
      nota += p === null && d === null
        ? ' · sin constancia de sus pruebas de regresión (pase anterior al 2026-09-17)'
        : pr !== null
          ? ` · ${p ?? 0} con prueba promovida · ${pr} con prueba propia · ${d ?? 0} diferido${d === 1 ? '' : 's'}`
          : ` · ${p ?? 0} con prueba en la suite · ${d ?? 0} diferido${d === 1 ? '' : 's'}`;
    }
  }
  return { cls, nota };
}

/** La clase con que se pinta una línea `adversarial-pass` (`paso` · `error` · `sin_estado`), o null si no es una. */
function estadoDelPaseAdversarial(g) {
  const r = resultadoAdversarial(g || {});
  return r ? r.cls : null;
}

// La nota del salteo del 5b: sale de los BOOLEANOS de la línea, nunca de su `motivo` — el `reason`
// del portón es prosa y puede traer rutas. Un salteo forzado o un abandono lo dice; uno normal no necesita nota.
function notaDelSalteo(g) {
  if (String(g.check || g.name || g.gate || '') !== 'adversarial-skip') return null;
  if (g.abandonado === true) return 'abandonado con el pase lanzado (forzado)';
  if (g.forzado === true) return 'forzado con el interruptor';
  return null;
}

// 🔴 «Rojo» mezclaba cuatro cosas, y una entraba como VERDE: 340 evaluaciones sin estado se
// contaban como «pasó» porque el código preguntaba `status && status !== 'green'`. Un ausente
// pintado de verde es la mentira que este tablero existe para no contar.
const ERROR = ['red', 'fail', 'failed', 'error', 'rojo'];
const FRENO = ['blocked', 'undeclared', 'missing', 'stale', 'rejected', 'denied'];
function clasificar(status) {
  if (status === undefined || status === null || status === '') return 'sin_estado';
  const s = String(status).toLowerCase();
  if (s === 'green' || s === 'ok' || s === 'pass' || s === 'passed') return 'paso';
  // La guía de QA anota también cuando está al día (`presente`) y cuando no hacía falta
  // (`no-aplica`). Las dos son «miró y dejó pasar»: sin esto caen en «estado no reconocido».
  if (s === 'presente' || s === 'no-aplica') return 'paso';
  if (ERROR.some((x) => s.startsWith(x))) return 'error';
  if (FRENO.some((x) => s.startsWith(x))) return 'freno';
  return 'otro';
}

/**
 * Las filas de la vista: los pasos que tienen marca en `stepTimings`, en el orden del pipeline. Conviven dos esquemas:
 * las ejecuciones nuevas anotan sus pasos por nombre de máquina y las de antes por número (0 a 8). Cada paso
 * de cualquiera de los dos cae en una fila; el 4 viejo era implementar y correr las pruebas juntos y tiene su fila
 * propia, «Implementar + pruebas», sin repartir. El pase adversarial y la prueba en vivo (y los sub-pasos viejos) no
 * tienen fila: van en la del paso al que acompañan.
 */
const FILAS = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', '4', 'reviewers', 'findings', 'prepare-commit'];
const FILA_DE_PASO = {
  start: 0, 'validate-story': 1, plan: 2, 'approve-plan': 3, implement: 4, 'run-tests': 5, reviewers: 7,
  'adversarial-pass': 7, findings: 8, 'live-check': 8, 'prepare-commit': 9,
  0: 0, '0b': 0, '0c': 0, 1: 1, 2: 2, 3: 3, 4: 6, 5: 7, '5b': 7, '7b': 7, 6: 8, 7: 8, '7c': 8, 8: 9,
};
const FILA_FINAL = 9;
// los pasos que se cierran con una bandera (y los sub-pasos viejos) acompañan a otra fila: no cuentan como fila propia
const SIN_FILA = new Set(['adversarial-pass', 'live-check', '0b', '0c', '5b', '7b', '7c']);
/** El paso de una edición o un commit (`5`, `reviewers`, `5+6`, `después`) como fila de la vista, en texto. */
const filaDeTexto = (p) => (p === null || p === undefined || p === 'después' ? p : clavePublica(filasDelTramo(p).pasos));
/** Las filas de un tramo (`5+6`, `reviewers+findings`), sin repetir, y su nombre. */
function filasDelTramo(paso, nombres) {
  const pasos = [];
  for (const id of String(paso).split('+')) { const f = filaDePaso(id); if (f !== null && !pasos.includes(f)) pasos.push(f); }
  // la clave cruda del volcado no se publica: lo que no cae en una fila conocida sale «paso desconocido»
  return { pasos, nombre: pasos.map((f) => (nombres && nombres[f]) || String(f)).join(' + ') || PASO_DESCONOCIDO };
}
const PASO_DESCONOCIDO = 'paso desconocido';
/** La clave publicable de un tramo: sus filas, nunca el texto crudo del volcado. */
const clavePublica = (pasos) => (pasos.length ? pasos.join('+') : PASO_DESCONOCIDO);
/** La fila de un paso (nombre de máquina o número viejo); `null` si no es un paso. */
const filaDePaso = (id) => (Object.prototype.hasOwnProperty.call(FILA_DE_PASO, String(id)) ? FILA_DE_PASO[String(id)] : null);
/**
 * La fila del paso que arrancó y no terminó (el más avanzado, si hay varios); `null` si ninguno quedó a medias. Es
 * donde se quedó una ejecución archivada a mitad de camino: el último paso TERMINADO es el anterior.
 */
function filaEnCurso(timings, completados) {
  const hechos = new Set((completados || []).map(String));
  const ms = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);
  const entradas = Object.entries(timings || {}).filter(([, t]) => t && typeof t === 'object');
  // un arranque cuenta sólo si es posterior a todo cierre: uno viejo sin cierre no gana sobre lo que se terminó después,
  // y un paso que se volvió a arrancar después de cerrarse (otra vuelta de revisores) sí está en curso
  const ultimoCierre = Math.max(-Infinity, ...entradas.map(([, t]) => ms(t.completedAt)).filter(Number.isFinite));
  let mejor = null;
  for (const [k, t] of entradas) {
    const ini = ms(t.startedAt);
    if (!Number.isFinite(ini) || SIN_FILA.has(k) || ini <= ultimoCierre) continue;
    const fin = ms(t.completedAt);
    if (Number.isFinite(fin) ? ini <= fin : hechos.has(k)) continue;
    const fila = filaDePaso(k);
    if (fila !== null && (!mejor || ini > mejor.ini)) mejor = { fila, ini };
  }
  return mejor ? mejor.fila : null;
}
/** 2 si la ejecución anota sus pasos por nombre de máquina, 1 si por número (el marcador viejo). */
const esquemaDe = (m) => (m && (m.stepScheme === 2 || Object.keys(m.stepTimings || {}).some((k) => !/^\d+[a-z]?$/.test(k))) ? 2 : 1);

/**
 * Los nombres de las filas salen de la tabla única del pipeline (`skills/tycon-pipeline/scripts/lib/steps.js`),
 * no se tipean ni se leen del título de cada archivo de paso. Si la tabla no se puede cargar, van los números de fila y
 * la página lo declara con el motivo.
 */
const TABLA_DE_PASOS = path.join(__dirname, '..', '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js');
function nombresDePasos(tabla = TABLA_DE_PASOS) {
  const nombres = FILAS.map((_, i) => String(i));
  const faltan = [];
  try {
    const T = require(tabla);
    // una tabla que carga pero está mal armada (exporta null, `stepName` que lanza) degrada igual que una que no
    // carga: el tablero no se cae entero por los nombres
    for (let i = 0; i < nombres.length; i++) {
      const n = T && typeof T.stepName === 'function' ? T.stepName(FILAS[i]) : null;
      if (typeof n === 'string' && n) nombres[i] = n; else faltan.push(i);
    }
  } catch (e) {
    // «No está» y «está rota» no son lo mismo: el motivo lleva el tipo de error,
    // nunca su mensaje (puede traer rutas de la máquina, y la página se publica); algo lanzado que no es un Error, igual.
    const codigo = (e && e.code) || (e instanceof SyntaxError ? 'SyntaxError' : (e && e.name) || 'error');
    const donde = String(tabla).split(/[\\/]/).slice(-5).join('/');
    return { nombres: nombres.map((_, i) => String(i)), fuente: 'numeros', motivo: `la tabla de pasos del pipeline no se pudo cargar (${codigo}, ${donde}): los pasos van por número, sin nombre` };
  }
  if (faltan.length === nombres.length) {
    return { nombres, fuente: 'numeros', motivo: 'la tabla de pasos del pipeline no trae los nombres de los pasos: van por número, sin nombre' };
  }
  return { nombres, fuente: 'tabla', motivo: faltan.length ? `la tabla de pasos no nombra el/los paso(s) ${faltan.join(', ')}: van por número` : null };
}

/**
 * 🔴 Todo texto que llega de AFUERA de la lista blanca pasa por el saneado: el mensaje rescatado y
 * también los MOTIVOS: el motivo de «conversación borrada»
 * que escribe el rescate dice «se buscó <sessionId>.jsonl en las 1970 carpetas», y por ahí llegarían los identificadores
 * de sesión a la página por un campo que parece prosa inocente. Sin saneador, el texto no
 * se publica: sale la palabra «no medido» y el motivo genérico.
 */
function limpio(txt, alternativa) {
  if (!txt) return alternativa || null;
  if (!rescate) return alternativa || 'motivo no publicado: el saneado (tokens-digest.js) no está en esta máquina';
  return rescate.sanear(String(txt), os.homedir()).trim();
}

/**
 * El REPO de la corrida, como nombre corto: nunca la ruta, nunca la carpeta donde estaba clonado.
 *
 * 🔴 Agrupar por carpeta parte el mismo repo según la máquina y el
 * clon (el mismo backend bajo dos carpetas distintas, un worktree
 * `…--wt-<rama>`, clones descartables del arnés) y se colarían `.` y
 * `tmp`. En orden:
 *  - sin ruta, `.` o una carpeta temporal pelada → null (sin registrar);
 *  - un clon del scratchpad de una sesión (`…/claude-NNN/-Users-u-SourceCode-<repo>/…`) → el repo de esa
 *    sesión, que es el que se clonó;
 *  - el sufijo de worktree o de clon (`--wt-x`, `--merge`, `--7.2`, `-wt-127`, `-wt-mant`) no es parte del nombre, y la
 *    carpeta de implementación de un commit (`c825a2c-impl`) se salta como una genérica;
 *  - una carpeta de worktree (`…/worktrees/<nombre>`) no nombra su repo: null (el repo real del volcado, si lo trae, manda);
 *  - una carpeta genérica (`Codigo`, `src`…) no es el repo ni lo distingue: se salta;
 *  - lo que cuelga de una carpeta temporal no tiene producto adelante (`/tmp/atk-vector4/CeiboBackend` →
 *    `CeiboBackend`);
 *  - si no, `<producto>/<repo>` con el primer ancestro no genérico que no sea la carpeta de proyectos del
 *    usuario (`Totora/Backend`, `Tucan/Backend`: dos repos distintos llamados igual).
 * Después `unificarProductos` junta mayúsculas distintas y el nombre suelto con su único par con producto.
 */
const GENERICAS = new Set(['codigo', 'código', 'code', 'src', 'source', 'sourcecode', 'proyectos', 'projects', 'repos', 'git', 'dev', 'scratchpad']);
function producto(repoPath) {
  let ruta = String(repoPath || '').trim();
  if (!ruta || ruta === '.' || /^(\/private)?\/tmp\/?$/.test(ruta)) return null;
  // Clon descartable de una sesión: la carpeta de la sesión codifica el repo desde el que se lanzó.
  const ses = ruta.match(/\/claude-\d+\/-(?:Users|home)-[^-/]+-([^/]+)/);
  if (ses) {
    const cod = ses[1].replace(/^(?:SourceCode|Proyectos|Projects|src)-/i, '');
    return cod || null;
  }
  const segs = ruta.split(/[\\/]/).filter(Boolean);
  // una carpeta de worktree (`…/worktrees/<nombre>`) no dice de qué repo es: sin el repo real del volcado, no hay producto
  if (segs.slice(0, -1).some((x) => /^\.?worktrees?$/i.test(x))) return null;
  const temporal = /^(private|tmp|var)$/.test(segs[0] || '') && (segs.includes('tmp') || (segs.includes('var') && segs.includes('folders')));
  const iHome = segs.findIndex((x, i) => i <= 1 && (x === 'Users' || x === 'home'));
  // `--wt-x`, `--merge`, `--7.2` y los worktrees numerados o con nombre (`<repo>-wt-127`, `<repo>-wt-mant`)
  const limpio = (x) => String(x || '').replace(/--.*$/, '').replace(/(.)-wt-.*$/, '$1');
  // la carpeta de implementación de un commit (`c825a2c-impl`) no es un repo: cuenta la que la contiene
  const esGen = (x) => GENERICAS.has(limpio(x).toLowerCase()) || /^[0-9a-f]{7,40}-impl$/i.test(String(x || ''));
  let i = segs.length - 1;
  while (i > 0 && esGen(segs[i])) i -= 1;
  const repo = limpio(segs[i]);
  if (!repo || (iHome >= 0 && i <= iHome + 1) || (temporal && i === segs.indexOf('tmp'))) return null;
  if (temporal) return repo;
  let j = i - 1;
  while (j >= 0 && esGen(segs[j])) j -= 1;
  // El ancestro no cuenta si es el usuario, `Users`/`home`, o la carpeta de proyectos directa bajo el usuario.
  const tope = iHome >= 0 ? iHome + 2 : 0;
  return (j >= tope && j >= 0 && !(iHome >= 0 && j <= iHome + 2)) ? `${limpio(segs[j])}/${repo}` : repo;
}

/** Cómo se lee un producto en la pantalla: «producto · repo», el mismo rótulo que Proyectos y Configuración. */
function rotuloProducto(p) {
  return String(p).replace('/', ' · ');
}

/** Junta el mismo repo escrito distinto: mayúsculas (`MIRepo`/`MiRepo`) y el nombre
 *  suelto con su ÚNICO par con producto (`CeiboBackend` → `Ceibo/CeiboBackend`). Gana la forma más usada. Las del
 *  laboratorio, entre ellas. */
function unificarProductos(corridas) {
  // el laboratorio se unifica aparte: el nombre de un ensayo no se le pega a un repo de verdad, ni al revés
  const lab = corridas.filter((c) => c.lab), resto = corridas.filter((c) => !c.lab);
  if (lab.length && resto.length) { unificarProductos(lab); unificarProductos(resto); return; }
  const cuenta = {};
  for (const c of corridas) if (c.producto) cuenta[c.producto] = (cuenta[c.producto] || 0) + 1;
  const clave = (p) => p.toLowerCase();
  const formas = {};
  for (const p of Object.keys(cuenta)) (formas[clave(p)] = formas[clave(p)] || []).push(p);
  const canon = {};
  for (const k of Object.keys(formas)) {
    const mejor = formas[k].sort((a, b) => cuenta[b] - cuenta[a] || a.localeCompare(b))[0];
    for (const p of formas[k]) canon[p] = mejor;
  }
  const conPrefijo = Object.keys(formas).filter((k) => k.includes('/'));
  for (const k of Object.keys(formas)) {
    if (k.includes('/')) continue;
    const pares = conPrefijo.filter((x) => x.split('/').pop() === k);
    if (pares.length === 1) for (const p of formas[k]) canon[p] = canon[formas[pares[0]][0]];
  }
  for (const c of corridas) if (c.producto) c.producto = canon[c.producto] || c.producto;
}

/**
 * Las carpetas de LABORATORIO: pruebas y ensayos, no trabajo de un producto. Van juntas en su grupo del filtro, aparte de
 * los productos, porque mezcladas inflan los repos reales con ejecuciones de juguete. Manda la RUTA de la ejecución, no
 * su `.git`: el clon descartable de una sesión trae el remoto de un repo de verdad y sigue siendo un ensayo.
 *  - una carpeta temporal (`/tmp`, `/var/folders` y `/var/tmp`, con `/private` adelante o sin él, `%TEMP%`): los clones y laboratorios de prueba;
 *  - el scratchpad de una sesión (`…/claude-NNN/…`): el clon descartable de esa sesión;
 *  - una carpeta `acme` o `acme-*`: el nombre inventado de los ejemplos y las pruebas;
 *  - una carpeta `laboratorio`, `lab` o `lab-*`: los laboratorios de máquina.
 */
const LABORATORIO = [
  /^(?:\/private)?\/tmp(?:\/|$)/,
  /^(?:\/private)?\/var\/(?:folders|tmp)\//,
  /[\\/]AppData[\\/]Local[\\/]Temp(?:[\\/]|$)/i,
  /[\\/]claude-\d+[\\/]/,
  /(?:^|[\\/])acme(?:-[^\\/]*)?(?:[\\/]|$)/i,
  /(?:^|[\\/])(?:laboratorio|lab|lab-[^\\/]*)(?:[\\/]|$)/i,
];
const esLaboratorio = (repoPath) => { const r = String(repoPath || '').trim(); return Boolean(r) && LABORATORIO.some((re) => re.test(r)); };

const decodificar = (s) => { try { return decodeURIComponent(String(s)); } catch (_) { return String(s); } };
const claveRepo = (s) => decodificar(s).trim().toLowerCase();

/**
 * El grupo del filtro de cada ejecución (`c.grupo`): «laboratorio» si su carpeta es de prueba; si no, el producto de
 * `repos.json` (`repos`: `{ producto, ruta, ado }`). El cruce, en orden: el remoto contra `ado`, el nombre contra
 * `ruta`, y un nombre suelto contra el último tramo de una ÚNICA `ruta` (`FrontEnd` suelto es de varios: no cruza; `Otro/Backend`
 * no cruza con `ClienteA/Backend`). Un repo
 * que no está queda con `grupo: null`, sin producto inventado. Se puede volver a correr: lee `lab`, `remoto` y
 * `producto`, y sólo escribe `grupo`.
 */
function agruparRepos(corridas, repos) {
  const lista = (Array.isArray(repos) ? repos : []).filter((r) => r && typeof r === 'object' && r.activo !== false && typeof r.producto === 'string' && r.producto.trim());
  const porAdo = {}, porRuta = {}, porTramo = {};
  for (const r of lista) {
    if (r.ado) porAdo[claveRepo(r.ado)] = r.producto;
    if (r.ruta) {
      const k = claveRepo(r.ruta);
      // dos entradas con la misma ruta y distinto producto: no se sabe cuál es, no cruza
      porRuta[k] = porRuta[k] === undefined || porRuta[k] === r.producto ? r.producto : null;
      const t = claveRepo(String(r.ruta).split('/').pop());
      porTramo[t] = porTramo[t] === undefined ? r.producto : null;
    }
  }
  for (const c of corridas) {
    if (c.lab) { c.grupo = 'laboratorio'; continue; }
    const nombre = c.producto ? claveRepo(c.producto) : '';
    c.grupo = (c.remoto && porAdo[claveRepo(c.remoto)])
      || (nombre && porRuta[nombre])
      || (nombre && !nombre.includes('/') && porTramo[nombre])
      || null;
  }
}

/**
 * Una ejecución sin el conteo de agentes no siempre es anterior al conteo: si otra que arrancó antes ya lo trae, el
 * conteo existía y es su registro el que no lo tiene (`c.sin_conteo`). Las de antes de la primera con conteo, no se marcan.
 */
function marcarSinConteo(corridas) {
  const conConteo = corridas.filter((c) => c.costo && c.inicio).map((c) => Date.parse(c.inicio)).filter(Number.isFinite);
  const primera = conConteo.length ? Math.min(...conConteo) : Infinity;
  for (const c of corridas) if (!c.costo && Date.parse(c.inicio || '') > primera) c.sin_conteo = true;
}

function semanaIso(iso) {
  const d0 = new Date(iso);
  if (!Number.isFinite(d0.getTime())) return null;
  const t = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()));
  const dn = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dn);
  const a0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-S${String(Math.ceil(((t - a0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
/** La semana como se ve, con la letra del idioma («2026-W44»); la clave guardada («2026-S44») no cambia. */
const semanaVisible = (s, idioma) => (typeof s === 'string' && /^\d{4}-S\d{2}$/.test(s) ? `${s.slice(0, 5)}${L(idioma, 'v.letraSemana')}${s.slice(6)}` : '');

/**
 * Los rebotes IDÉNTICOS y CONSECUTIVOS se agrupan (`×5`, con el rango de minutos): el registro
 * anota un evento por rebote y `atdd-preedit` frenó cinco veces en 32 s porque el agente reintentó
 * cinco veces la misma edición. Dos frenos iguales separados por otro evento NO se agrupan: son
 * dos momentos distintos, y fundirlos borraría esa vuelta de la corrida.
 */
function agruparEventos(eventos) {
  const grupos = [];
  for (const e of eventos) {
    const u = grupos[grupos.length - 1];
    if (u && u.control === e.control && u.cls === e.cls && u.exit === e.exit && u.mensaje === e.mensaje) {
      u.n += 1; u.hasta = e.t;
    } else {
      grupos.push({ t: e.t, hasta: e.t, control: e.control, cls: e.cls, exit: e.exit, ms: e.ms, mensaje: e.mensaje, mensaje_estado: e.mensaje_estado, nota: e.nota || null, n: 1 });
    }
  }
  return grupos;
}

/**
 * LA LISTA BLANCA. Cada campo que sale se nombra acá; lo que no está nombrado no se dibuja.
 * Nunca `...d`, nunca `...m`: el volcado entero trae rutas, prompts e identificadores.
 */
/**
 * Cómo terminó una ejecución: la marca `cierre` del marcador; sin ella (un volcado de antes de la marca), lo que dicen
 * sus pasos. Terminada es sólo `completa`: una en deuda, abortada o abandonada no terminó lo que la historia pedía.
 * → `{ estado: completa|deuda|abortada|abandonada|incompleta, inferido }`.
 */
function cierreDeCorrida(d) {
  const m = d.marker || {};
  const e = m.cierre && typeof m.cierre === 'object' ? String(m.cierre.estado || '') : '';
  if (['completa', 'deuda', 'abortada', 'abandonada'].includes(e)) return { estado: e, inferido: false };
  if (d.sinCerrar === true) return { estado: 'abandonada', inferido: true };
  // el cierre de la historia (después del merge) no cuenta como pendiente
  const pendientes = (Array.isArray(m.stepsPending) ? m.stepsPending : []).map(String).filter((p) => p !== 'close-work-item' && p !== '9');
  return { estado: d.archivedAt && pendientes.length ? 'incompleta' : 'completa', inferido: true };
}

// Los resultados de la revisión previa que cuentan como «la historia se revisó antes de programar».
const REVISION_HECHA = new Set(['limpio', 'corregido', 'preguntado']);
const NOTA_SIN_REVISION = 'sin revisión previa';

/**
 * La revisión de la historia antes de programar, de la constancia que el cierre copia al volcado. Sólo un estado de
 * vocabulario cerrado y números: ni el modelo, ni las reglas, ni el texto de los hallazgos. Un volcado sin el campo es
 * anterior a la revisión previa (`sin_campo`) y se cuenta aparte, nunca como «sin revisión». Lo no medido es null.
 */
function revisionPreviaDe(d) {
  if (!d || !Object.prototype.hasOwnProperty.call(d, 'revision_previa')) return { estado: 'sin_campo' };
  const r = d.revision_previa;
  const vacia = { corregida: null, hallazgos: null, tokens: null, duracion_ms: null };
  // null con otra nota es una constancia que no se pudo leer: no se sabe si hubo revisión
  if (r === null) return { estado: d.revision_previa_nota === undefined || d.revision_previa_nota === NOTA_SIN_REVISION ? 'sin_revision' : 'no_medido', ...vacia };
  if (!r || typeof r !== 'object') return { estado: 'no_medido', ...vacia };
  const resultado = String(r.resultado || '');
  if (resultado === 'saltado') return { estado: 'saltada', ...vacia };
  if (!REVISION_HECHA.has(resultado)) return { estado: 'no_medido', ...vacia };
  const cuenta = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const h = r.hallazgos && typeof r.hallazgos === 'object' ? r.hallazgos : {};
  const destinos = h.por_destino && typeof h.por_destino === 'object' ? h.por_destino : {};
  return {
    estado: 'revisada',
    corregida: resultado === 'corregido' || (cuenta(destinos.corregido) || 0) > 0,
    hallazgos: cuenta(h.total),
    tokens: cuenta(r.tokens),
    duracion_ms: cuenta(r.duracion_ms),
  };
}

function modeloDeCorrida(d, nombresPasos) {
  const m = d.marker || {};
  const ini = Date.parse(m.startedAt || '');
  const fin = Date.parse(m.lastTouch || '');
  const off = (ts) => {
    const t = Date.parse(ts || '');
    return (Number.isFinite(t) && Number.isFinite(ini)) ? Math.round((t - ini) / 60000) : null;
  };

  // Tramos: del fin del anterior al fin de éste. Pasos con marcas invertidas o empatadas salen
  // FUSIONADOS (`5+6`) con la misma regla que `consumo.por_paso` (cortesDePaso): se
  // declara en vez de fingir un reparto que las marcas no sostienen.
  let tramos = [];
  let motivoTramos = null;
  let tiempos = null;
  if (!rescate) motivoTramos = 'los pasos no se cortan: el saneado y el corte de pasos (tokens-digest.js) no están en esta máquina';
  else if (!Number.isFinite(ini)) motivoTramos = 'la ejecución no anotó su hora de inicio: sin eje de tiempo';
  else if (cuentaTiempos) {
    // Con arranque, el paso dura fin − arranque y el hueco previo es un tramo PROPIO
    // (`tipo: 'entre'`), nunca parte del paso. Sin arranque, la cuenta lo estima como siempre y lo dice.
    const t = cuentaTiempos.tiempos(m.stepTimings || {}, { inicio: m.startedAt });
    for (const p of t.pasos) {
      if (p.hueco_previo_ms > 0) tramos.push({ tipo: 'entre', paso: 'entre', pasos: [], ms: p.hueco_previo_ms, nombre: 'entre pasos' });
      if (p.subpaso) {
        const pasos = [filaDePaso(p.paso)].filter((x) => x !== null);
        tramos.push({ tipo: 'paso', paso: clavePublica(pasos), pasos, ms: p.ms, medida: true, subpaso: true, nombre: SIN_FILA.has(String(p.paso)) && p.nombre ? p.nombre : PASO_DESCONOCIDO });
      } else {
        const f = filasDelTramo(p.paso, nombresPasos);
        tramos.push({ tipo: 'paso', paso: clavePublica(f.pasos), ...f, ms: p.ms, medida: p.medida });
      }
    }
    tiempos = {
      estado: t.estado,
      motivo: t.motivo,
      trabajo_ms: t.trabajo_ms,
      trabajo_medido: t.trabajo_medido,
      espera_humana_ms: t.espera_humana_ms,
      entre_pasos_ms: t.entre_pasos_ms,
      sin_repartir_ms: t.sin_repartir_ms,
      // los pasos estimados, como filas (sin los sub-pasos, que no tienen fila propia)
      estimados: [...new Set(t.estimados.filter((x) => !SIN_FILA.has(String(x))).map(filaDePaso).filter((x) => x !== null))],
    };
  } else {
    let ant = ini;
    for (const c of rescate.cortesDePaso(m.stepTimings || {})) {
      const f = filasDelTramo(c.paso, nombresPasos);
      tramos.push({ paso: clavePublica(f.pasos), ...f, ms: Math.max(0, c.hasta - ant) });
      ant = c.hasta;
    }
  }
  const esquema = esquemaDe(m);
  const marcados = new Set(tramos.filter((t) => !t.subpaso).flatMap((t) => t.pasos));
  // las filas que la ejecución tiene que marcar: la de «Implementar + pruebas» en las viejas; las dos partidas en las nuevas
  const sinMarca = FILAS.map((_, i) => i).filter((i) => (esquema === 2 ? i !== 6 : i !== 4 && i !== 5)).filter((i) => !marcados.has(i));

  // Evaluaciones de los controles: veredicto, duración, código de salida y —si el volcado lo trae—
  // el mensaje rescatado, SANEADO de nuevo. Jamás el comando.
  let controles = null;
  let eventos = [];
  let eventosPrevios = 0;
  if (Array.isArray(d.gates)) {
    controles = { total: 0, paso: 0, error: 0, freno: 0, sin_estado: 0, otro: 0, por_control: {} };
    for (const g of d.gates) {
      if (!g || typeof g !== 'object') continue;
      const k = String(g.check || g.name || g.gate || 'sin nombre');
      const adv = resultadoAdversarial(g);
      const cls = adv ? adv.cls : clasificar(g.status);
      const t = off(g.ts);
      // Una evaluación ANTERIOR al inicio es de otro pipeline de la misma sesión: se cuenta aparte y
      // no entra en NINGUNA de las dos vistas (tabla y lista cuentan sobre el MISMO universo).
      // Sin hora de inicio no hay «antes»: el evento se queda,
      // sin minuto (t: null), y el detalle lo dice; sin esto desaparecerían todos.
      if (t !== null && t < 0) { eventosPrevios += 1; continue; }
      controles.total += 1;
      controles[cls] += 1;
      const pc = controles.por_control[k] || (controles.por_control[k] = { n: 0, paso: 0, error: 0, freno: 0, sin_estado: 0, otro: 0, ms: 0 });
      pc.n += 1; pc[cls] += 1;
      if (Number.isFinite(g.durationMs)) pc.ms += g.durationMs;
      let mensaje = null, mensajeEstado = 'ausente';
      if (typeof g.mensaje === 'string' && g.mensaje.trim()) {
        if (rescate) { mensaje = rescate.sanear(g.mensaje, os.homedir()).trim().slice(-700); mensajeEstado = 'saneado'; }
        else mensajeEstado = 'retenido'; // el registro lo trae, pero sin saneador no se publica
      }
      eventos.push({ t, control: k, cls, ms: Number.isFinite(g.durationMs) ? g.durationMs : null, exit: Number.isFinite(g.exit) ? g.exit : null, mensaje, mensaje_estado: mensajeEstado, nota: adv ? adv.nota : notaDelSalteo(g) });
    }
    eventos.sort((a, b) => (a.t === null) - (b.t === null) || (a.t || 0) - (b.t || 0));
    // cero evaluaciones dentro de la ejecución no es «ningún control encontró nada»: es que no hay registro, y así se dice
    if (!controles.total) controles = null;
  }
  const vueltas = Object.values(m.iterations || {}).map((it) => off(it && it.ts)).filter((t) => t !== null && t >= 0);

  const co = d.costo && typeof d.costo === 'object' ? d.costo : null;
  const vueltaMedida = cuentaVueltas ? cuentaVueltas(d) : null;
  const costo = co && Number.isFinite(co.spawns)
    ? { agentes: co.spawns, vueltas: vueltaMedida ? vueltaMedida.value : null,
        vueltas_fuente: vueltaMedida ? vueltaMedida.fuente : (motivoSinVueltas || 'el registro no anota vueltas: sin revisores por vuelta ni lecturas de iteración'),
        calculos_del_set: Number.isFinite(co.iteraciones) ? co.iteraciones : null,
        por_tipo: Object.fromEntries(Object.entries(co.por_tipo || {}).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [String(k), v])) }
    : null;

  const c = d.consumo && typeof d.consumo === 'object' ? d.consumo : null;
  let consumo;
  if (!c) consumo = { estado: 'no_medido', motivo: 'esta ejecución es anterior al rescate del consumo: no se registró' };
  // los volcados viejos nombran el ajuste de Claude Code que borra las conversaciones: la página dice lo que pasó, sin el nombre
  else if (c.estado !== 'medido' || !c.tokens) consumo = { estado: String(c.estado || 'no_medido'), motivo: limpio(c.motivo, 'el registro no trae el consumo medido').replace(/ \(Claude Code las borra según cleanupPeriodDays\)/, ' (Claude Code borra las conversaciones viejas)') };
  else {
    const tk = c.tokens;
    consumo = {
      estado: 'medido',
      respuestas: Number.isFinite(c.respuestas) ? c.respuestas : null,
      tokens: { in: tk.in || 0, out: tk.out || 0, cache_new: tk.cache_new || 0, cache_read: tk.cache_read || 0 },
      por_modelo: Object.fromEntries(Object.entries(c.por_modelo || {}).map(([k, v]) => [String(k), { respuestas: (v && v.respuestas) || 0, out: (v && v.out) || 0, cache_new: (v && v.cache_new) || 0 }])),
      // por fila (con los dos esquemas en las mismas filas): dos pasos que caen en la misma fila se suman
      por_paso: Object.entries(c.por_paso || {}).filter(([, v]) => Number.isFinite(v)).reduce((acc, [k, v]) => {
        const fila = clavePublica(filasDelTramo(k).pasos);
        acc[fila] = (acc[fila] || 0) + v;
        return acc;
      }, {}),
      fuera_de_ventana: Number.isFinite(c.fuera_de_ventana) ? c.fuera_de_ventana : 0,
    };
  }

  // Los REVISORES: lo medido con su número, lo estimado con la palabra. Lista blanca,
  // como todo lo demás: del bloque del volcado entran conteos, medianas y el estimado con su fecha;
  // NO entra `detalle` (por revisor) ni la `fuente` del supuesto (trae una ruta). Sin bloque no es
  // «0 tokens»: es «sin medir», con el comando que lo mide.
  const rv = d.revisores && typeof d.revisores === 'object' ? d.revisores : null;
  const num = (x) => (Number.isFinite(x) ? x : null);
  const res = (x, alt) => (x && Number.isFinite(x.mediana)
    ? { mediana: x.mediana, n: num(x.n) }
    : { estado: 'no_medido', motivo: limpio(x && x.motivo, alt) });
  let revisores;
  if (!rv) {
    revisores = { estado: 'sin_medir', motivo: 'esta ejecución no tiene medidos los revisores: los mide el barrido del arranque, o a mano `scripts/metrics/reviewers-cost.js --run <volcado>`' };
  } else {
    const est = rv.estimado && typeof rv.estimado === 'object' ? rv.estimado : null;
    revisores = {
      estado: String(rv.estado || 'no_medido'),
      motivo: rv.motivo ? limpio(rv.motivo) : null,
      fuente: rv.fuente ? String(rv.fuente) : null,
      lanzamientos: num(rv.lanzamientos),
      con_resultado: num(rv.con_resultado),
      sin_resultado: num(rv.sin_resultado),
      no_ubicados: num(rv.no_ubicados),
      fuera_del_registro: num(rv.fuera_del_registro),
      con_tokens: num(rv.con_tokens),
      duracion_ms: res(rv.duracion_ms, 'la duración de los revisores no se midió'),
      devuelto_bytes: res(rv.devuelto_bytes, 'el tamaño de los informes no se midió'),
      tokens_medidos: rv.tokens_medidos && Number.isFinite(rv.tokens_medidos.total)
        ? { total: rv.tokens_medidos.total, n: num(rv.tokens_medidos.n) }
        : { estado: 'no_medido', motivo: limpio(rv.tokens_medidos && rv.tokens_medidos.motivo, 'los tokens de los revisores no se midieron') },
      estimado: !est
        ? { estado: 'no_medido', motivo: 'el registro no trae el campo estimado' }
        : est.estado === 'estimado'
          ? { estado: 'estimado', lanzamientos_cubiertos: num(est.lanzamientos_cubiertos), tokens_min: num(est.tokens_min), tokens_max: num(est.tokens_max),
              medido_el: est.supuesto && est.supuesto.medido_el ? String(est.supuesto.medido_el) : null,
              revisar_antes_de: est.supuesto && est.supuesto.revisar_antes_de ? String(est.supuesto.revisar_antes_de) : null }
          : { estado: String(est.estado || 'no_medido'), motivo: limpio(est.motivo, 'sin estimación'), lanzamientos_sin_medir: num(est.lanzamientos_sin_medir) },
    };
  }

  // El VALIDADOR DE STORIES por fase: sólo los conteos de las fases conocidas —lista blanca: ni
  // el `detalle`, ni campos que el volcado traiga de más— y las decisiones de las vueltas de revisores, contadas de las
  // líneas `validador-reloop` del registro de controles. Sin veredicto medido no es «0 hallazgos»: se dice.
  const FASES_VAL = ['antes-de-implementar', 'vuelta-1', 're-loop', 'sin-vuelta', 'otra-story'];
  const ESTADOS_VAL = ['limpio', 'hallazgos', 'inconsistente', 'sin_veredicto', 'no_medido'];
  const vr = rv && rv.validador && typeof rv.validador === 'object' ? rv.validador : null;
  const decisiones = Array.isArray(d.gates) ? d.gates.filter((g) => g && typeof g === 'object' && g.name === 'validador-reloop') : [];
  let validador;
  if (vr && vr.estado === 'medido' && vr.por_fase && typeof vr.por_fase === 'object') {
    const porFase = {};
    for (const f of FASES_VAL) {
      const x = vr.por_fase[f] && typeof vr.por_fase[f] === 'object' ? vr.por_fase[f] : {};
      porFase[f] = { lanzamientos: num(x.lanzamientos) || 0 };
      for (const e of ESTADOS_VAL) porFase[f][e] = num(x[e]) || 0;
    }
    validador = { estado: 'medido', lanzamientos: num(vr.lanzamientos) || 0, por_fase: porFase };
  } else {
    validador = {
      estado: 'no_medido',
      motivo: !rv
        ? 'sin medir los revisores de esta ejecución; el veredicto del validador sólo lo tienen las más nuevas'
        : !vr ? 'la ejecución es de antes de que el validador dejara su veredicto'
          : limpio(vr.motivo, 'el registro no trae el veredicto del validador medido'),
    };
  }
  validador.re_loops_sin_relanzar = decisiones.filter((g) => g.invoca === false).length;
  validador.re_loops_decididos = decisiones.length;

  const completados = Array.isArray(m.stepsCompleted) ? m.stepsCompleted : [];
  const rr = d.repo && typeof d.repo === 'object' ? d.repo : null;
  const cierre = cierreDeCorrida(d);
  return {
    story: m.storyId ? String(m.storyId) : null,
    // con el repo real del volcado (las ejecuciones desde la story del filtro de repos) manda ése; si no, la carpeta
    producto: producto(rr && typeof rr.path === 'string' && !esLaboratorio(m.repoPath) ? rr.path : m.repoPath),
    lab: esLaboratorio(m.repoPath),
    remoto: rr && typeof rr.remote === 'string' && /^[^\s@:]{1,200}$/.test(rr.remote) ? rr.remote : null,
    inicio: Number.isFinite(ini) ? new Date(ini).toISOString() : null,
    semana: Number.isFinite(ini) ? semanaIso(new Date(ini).toISOString()) : null,
    dur_ms: (Number.isFinite(ini) && Number.isFinite(fin) && fin > ini) ? fin - ini : null,
    // con qué pasos corrió: 1 = por número (el marcador viejo), 2 = por nombre de máquina
    esquema,
    tramos, sin_marca: sinMarca, motivo_tramos: motivoTramos,
    tiempos,
    pasos_completos: completados.length,
    // La fila del ÚLTIMO paso completado, no `length - 1`: stepsCompleted tiene huecos
    // ([0,1,4,5,6,7] diría «quedó en el 5» y quedó en el 7).
    ultimo_paso: (() => { const fs_ = completados.map(filaDePaso).filter((x) => x !== null); return fs_.length ? Math.max(...fs_) : null; })(),
    paso_en_curso: filaEnCurso(m.stepTimings, completados),
    // llegó al final = terminó completa: una en deuda, abortada o abandonada no cuenta aunque haya pasado el último paso
    llego_al_final: completados.some((p) => filaDePaso(p) === FILA_FINAL) && cierre.estado === 'completa',
    dod: m.dodRuntime && m.dodRuntime.verdict ? String(m.dodRuntime.verdict) : null,
    controles,
    eventos,
    eventos_previos: eventosPrevios,
    // 🔴 Se agrupa sobre la secuencia COMPLETA y recién después se filtra: si se filtrara antes,
    //    un «pasó» en el medio desaparecería y dos frenos separados por él saldrían fundidos en ×2
    //    (T11b — es la vuelta que el agrupado no puede borrar).
    eventos_agrupados: agruparEventos(eventos).filter((g) => g.cls === 'error' || g.cls === 'freno'),
    vueltas_ts: vueltas,
    costo,
    consumo,
    revisores,
    validador,
    revision_previa: revisionPreviaDe(d),
  };
}

/**
 * La espera por una persona que la cuenta por pasos no ve (una pregunta a mitad del paso 5, un turno que
 * terminó esperando al dev): sale del hilo y pasa de «trabajo» a «espera». Ver step-times.js#conEsperas.
 */
function aplicarEsperasDelHilo(c, marker) {
  const x = c.cambios;
  if (!x || x.estado !== 'leido' || !cuentaTiempos || !cuentaTiempos.conEsperas || !c.tiempos) { if (x) delete x._esperas; return; }
  const esperas = x._esperas; delete x._esperas;
  if (!esperas.length) return;
  const t = cuentaTiempos.conEsperas(cuentaTiempos.tiempos((marker || {}).stepTimings || {}, { inicio: (marker || {}).startedAt }), esperas);
  c.tiempos.trabajo_ms = t.trabajo_ms;
  c.tiempos.espera_humana_ms = t.espera_humana_ms;
  c.tiempos.entre_pasos_ms = t.entre_pasos_ms;
  c.tiempos.espera_del_hilo_ms = t.espera_del_hilo_ms || 0;
}

/**
 * De qué fue la corrida, en una frase. En orden: el título de la story (del frontmatter, cuando la corrida
 * lo tuvo a la vista), el asunto de su primer commit, y si no hay hilo,
 * el nombre del archivo de la story sin su número. Nunca el prompt del dev: suele ser «listo» o «seguí».
 */
function descripcionDe(marker, cz) {
  if (cz && cz.estado === 'leido') {
    if (cz.titulo) return { texto: cz.titulo, fuente: 'el título de la story' };
    if (cz.commits && cz.commits.length) return { texto: cz.commits[0].s, fuente: 'su primer commit' };
  }
  const base = String((marker || {}).storyPath || '').split(/[\\/]/).pop().replace(/\.md$/i, '');
  const slug = base.replace(/^story[-_]?/i, '').replace(/^[0-9a-z]{1,4}([.-][0-9a-z]{1,3}){0,3}[-_]/i, '').replace(/[-_]+/g, ' ').trim();
  return slug && /[a-záéíóúñ]{3}/i.test(slug) ? { texto: slug, fuente: 'el nombre del archivo de la story' } : null;
}

/**
 * Los archivos que tocó la corrida, leídos del hilo de la copia más nueva que lo tenga (la misma sesión
 * puede estar local y en el buzón). El resumen va al modelo; el texto de cada cambio, comprimido, a
 * `_texto` (render lo saca del modelo y lo emite aparte, para abrirlo a pedido).
 */
/**
 * El cambio de la corrida según git, compacto para el modelo: repos, commits (con su minuto de
 * la corrida) y archivos con sus PARTES (una por commit, y la de «sin commitear»), sin sumar partes: una
 * suma de dos diffs no es un diff. Los parches van aparte, comprimidos, saneados OTRA VEZ (el archivo pudo
 * escribirlo el guion de otra máquina). Lo que no se pudo leer dice por qué.
 */
function modeloGit(rutas, marker, cambioDelVolcado) {
  const conCambio = rutas.find((r) => fs.existsSync(cambios.rutaDeCambio(r)));
  // 🔴 Sin el archivo, no da igual «esta corrida es de un arnés sin ese archivo» que «el archivador lo intentó y no
  // pudo»: el volcado guarda el motivo (arnés atrasado, guion roto, tope de tiempo) y la vista lo dice.
  if (!conCambio) {
    const c = cambioDelVolcado;
    if (c && typeof c === 'object' && c.estado && c.estado !== 'medido') {
      const S0 = rescate && rescate.sanear;
      // Sin el saneado NO se publica ningún texto de afuera, tampoco este motivo — es la única rama que lo
      // dejaría pasar crudo. El resto del archivo ya se comporta así.
      if (!S0) return { modelo: { estado: 'no_publicado', motivo: 'sin el saneado (scripts/metrics/tokens-digest.js) el cambio de git no se publica' }, texto: null };
      return { modelo: { estado: String(c.estado), motivo: S0(String(c.motivo || 'sin motivo declarado')), del_volcado: 1 }, texto: null };
    }
    return { modelo: { estado: 'sin_cambio' }, texto: null };
  }
  const x = cambios.leerCambioDeGit(conCambio);
  const S = rescate && rescate.sanear;
  if (!S) return { modelo: { estado: 'no_publicado', motivo: 'sin el saneado (scripts/metrics/tokens-digest.js) el cambio de git no se publica' }, texto: null };
  if (x.estado !== 'medido') return { modelo: { estado: String(x.estado), motivo: S(String(x.motivo || 'sin motivo declarado')) }, texto: null };
  const ini = Date.parse((marker || {}).startedAt || '');
  const repos = [];
  const commits = [];
  const archivos = [];
  const textos = [];
  const idx = new Map();
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  for (const r of Array.isArray(x.repos) ? x.repos : []) {
    if (!r || typeof r !== 'object') continue;
    const ri = repos.length;
    const nombre = S(String(r.nombre || 'repo sin nombre'));
    repos.push({ n: nombre, p: r.principal ? 1 : 0, estado: String(r.estado || 'no_medido'), motivo: r.motivo ? S(String(r.motivo)) : null,
      otras: num(r.otras_sesiones), otras_motivo: r.otras_sesiones_motivo ? S(String(r.otras_sesiones_motivo)) : null,
      previo: num(r.sin_commitear_previo) || 0, commits_motivo: r.commits === null && r.commits_motivo ? S(String(r.commits_motivo)) : null,
      // Copia compartida: los commits que el hilo atribuye a otra sesión, y el motivo si no se pudo atribuir.
      de_otras: (Array.isArray(r.commits_de_otras_sesiones) ? r.commits_de_otras_sesiones : []).filter((k) => k && typeof k === 'object')
        .map((k) => ({ h: S(String(k.h || '')).slice(0, 12), s: S(String(k.asunto || '')).slice(0, 300) })),
      atrib_motivo: r.atribucion_motivo ? S(String(r.atribucion_motivo)) : null });
    if (r.estado !== 'medido') continue;
    const agregar = (p, ci) => {
      if (!p || typeof p !== 'object') return;
      const ruta = S(String(p.ruta || ''));
      const f = r.principal ? ruta : `${nombre}/${ruta}`;
      if (!idx.has(f)) { idx.set(f, archivos.length); archivos.push({ f, r: ri, partes: [] }); textos.push([]); }
      const ai = idx.get(f);
      archivos[ai].partes.push({ c: ci, e: String(p.estado || 'M'), mas: num(p.mas), menos: num(p.menos), b: p.binario ? 1 : 0,
        x: typeof p.parche === 'string' ? 1 : 0, cor: num(p.cortado) || 0, tope: p.sin_parche_por_tope ? 1 : 0,
        ...(p.ruta_anterior ? { ant: S(String(p.ruta_anterior)) } : {}), ...(p.omitido ? { om: S(String(p.omitido)) } : {}) });
      textos[ai].push(typeof p.parche === 'string' ? S(p.parche) : null);
    };
    for (const k of Array.isArray(r.commits) ? r.commits : []) {
      if (!k || typeof k !== 'object') continue;
      const ci = commits.length;
      const t = Date.parse(k.fecha || '');
      const at = k.atribucion === 'coincide_la_hora' || k.atribucion === 'sin_constancia' ? k.atribucion : null;
      commits.push({ r: ri, h: S(String(k.h || '')).slice(0, 12), t: Number.isFinite(t) && Number.isFinite(ini) ? Math.round((t - ini) / 60000) : null, s: S(String(k.asunto || '')).slice(0, 300), ...(at ? { at } : {}) });
      for (const p of Array.isArray(k.archivos) ? k.archivos : []) agregar(p, ci);
    }
    for (const p of Array.isArray(r.sin_commitear) ? r.sin_commitear : []) agregar(p, -1);
  }
  const tot = x.totales || {};
  return {
    modelo: { estado: 'medido', repos, commits, archivos, total_archivos: archivos.length, cortados: num(tot.cortados) || 0, sin_parche_por_tope: num(tot.sin_parche_por_tope) || 0 },
    texto: archivos.length ? require('zlib').gzipSync(JSON.stringify(textos)).toString('base64') : null,
  };
}

/**
 * EL RESUMEN DE UNA CORRIDA (el sitio de la organización con las conversaciones prendidas): lo que la tabla y el
 * detalle sacan de la conversación y del cambio de git —la descripción, el reparto del tiempo, la lista de cambios—,
 * guardado al lado del volcado (`<volcado>.resumen.json.gz`) con la huella de los dos archivos de los que salió. Una
 * conversación pesa megas y crece sin parar; su resumen, unos kilos. Los textos (los parches) no van: se bajan a
 * demanda cuando alguien abre los cambios de la corrida.
 */
const RESUMEN = Object.freeze({
  sufijo: '.resumen.json.gz',
  // el nombre, uno solo para la vista y para la bajada (changes.js): el que no se carga no deja resumir nada
  nombre: (volcado) => (cambios ? cambios.rutaDeResumen(volcado) : String(volcado).replace(/\.json$/, '') + '.resumen.json.gz'),
});

/** El resumen guardado de una corrida, o null (no está, o no se puede leer: entonces la corrida se lee sin resumen). */
function leerResumen(volcado) {
  try {
    const r = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(RESUMEN.nombre(volcado))).toString('utf8'));
    return r && r.v === 1 && r.cambios && typeof r.cambios === 'object' ? r : null;
  } catch (e) {
    if (e.code !== 'ENOENT') process.stderr.write(`ejecuciones: el resumen de ${path.basename(volcado)} no se pudo leer (${e.code || e.message})\n`);
    return null;
  }
}

/** Los cambios de una corrida: de su conversación si está en el disco; si no, de su resumen; si no, sin cambios. */
// El cambio de git solo, sin la conversación, no alcanza para leer la corrida: la bajada trae el cambio antes que la
// conversación, y una pasada que corta entre los dos dejaría la corrida sin título ni esperas hasta la siguiente (la
// misma ejecución cambiaba de una recarga a otra). Con resumen, vale el resumen hasta que llegue la conversación.
function cambiosDeLaCorrida(rutas, marker, nombresPasos, cambioDelVolcado) {
  const hayHilo = cambios && rutas.some((r) => fs.existsSync(cambios.rutaDeHilo(r)));
  if (!hayHilo) {
    for (const r of rutas) {
      const s = leerResumen(r);
      // las esperas viajan en el resumen con su nombre de siempre: aplicarEsperasDelHilo las consume igual
      if (s) return { ...s.cambios, ...(Array.isArray(s.cambios._esperas) ? { _esperas: s.cambios._esperas } : {}) };
    }
  }
  return leerCambios(rutas, marker, nombresPasos, cambioDelVolcado);
}

/**
 * Resume las corridas del espejo que tienen su conversación o su cambio en el disco, y los borra: { resumidas,
 * fallidas, motivos }. Una corrida que no se pudo resumir (un volcado ilegible, un disco que no deja escribir) deja sus
 * archivos como estaban y se cuenta. Corre después de cada pasada de la bajada, así el disco nunca guarda más que una
 * tanda de conversaciones.
 */
function resumirEspejo(espejo, { skillsDir = null } = {}) {
  const out = { resumidas: 0, fallidas: 0, motivos: [] };
  if (!cambios) return out;
  const pasos = skillsDir ? pasosDeLaImagen(skillsDir) : nombresDePasos();
  const huella = (f) => (fs.existsSync(f) ? crypto.createHash('md5').update(fs.readFileSync(f)).digest('base64') : null);
  let carpetas = [];
  try { carpetas = fs.readdirSync(espejo, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(espejo, e.name)); }
  catch (e) { out.motivos.push(`no se pudo leer el espejo (${e.code || e.message})`); out.fallidas += 1; return out; }
  for (const dir of carpetas) {
    let archivos = [];
    try { archivos = fs.readdirSync(dir); } catch (e) { out.motivos.push(`${path.basename(dir)} (${e.code || e.message})`); out.fallidas += 1; continue; }
    for (const f of archivos.filter((x) => /\.json$/.test(x))) {
      const volcado = path.join(dir, f);
      const hilo = cambios.rutaDeHilo(volcado);
      const cambio = cambios.rutaDeCambio(volcado);
      if (!fs.existsSync(hilo) && !fs.existsSync(cambio)) continue;
      try {
        const d = JSON.parse(fs.readFileSync(volcado, 'utf8'));
        const x = leerCambios([volcado], d.marker, pasos.nombres, d.cambio);
        const pasajero = (e) => e === 'ilegible' || e === 'no_publicado';
        if ((x.estado !== 'leido' && x.estado !== 'sin_hilo') || pasajero(x.git && x.git.estado)) {
          out.fallidas += 1;
          if (out.motivos.length < 5) out.motivos.push(`${path.basename(dir)}/${f} (sin resumir: ${x.motivo || (x.git && x.git.motivo) || x.estado})`);
          continue;
        }
        const { _texto, _textoGit, ...resto } = x;
        const doc = { v: 1, hilo_md5: huella(hilo), cambio_md5: huella(cambio), cambios: resto };
        const destino = RESUMEN.nombre(volcado);
        const tmp = `${destino}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, require('zlib').gzipSync(JSON.stringify(doc)));
        fs.renameSync(tmp, destino);
        fs.rmSync(hilo, { force: true });
        fs.rmSync(cambio, { force: true });
        out.resumidas += 1;
      } catch (e) {
        out.fallidas += 1;
        if (out.motivos.length < 5) out.motivos.push(`${path.basename(dir)}/${f} (${e.code || e.message})`);
      }
    }
  }
  return out;
}

/**
 * Los textos de UNA corrida (los cambios y los parches), para el detalle a demanda: `volcado` es la ruta de su volcado,
 * con su conversación y su cambio de git bajados al lado. `{ texto, textoGit }`, con la forma de textosDe().
 */
function textosDeUnaCorrida(volcado, { skillsDir = null } = {}) {
  const pasos = skillsDir ? pasosDeLaImagen(skillsDir) : nombresDePasos();
  const d = JSON.parse(fs.readFileSync(volcado, 'utf8'));
  const x = leerCambios([volcado], d.marker, pasos.nombres, d.cambio);
  return { texto: x._texto || null, textoGit: x._textoGit || null };
}

function leerCambios(rutas, marker, nombresPasos, cambioDelVolcado) {
  if (!cambios) return { estado: 'no_publicado', motivo: motivoSinCambios };
  const git = modeloGit(rutas, marker, cambioDelVolcado);
  const conHilo = rutas.find((r) => fs.existsSync(cambios.rutaDeHilo(r))) || rutas[0];
  const x = cambios.cambiosDeCorrida(conHilo, marker, { sanear: rescate && rescate.sanear, cortesDePaso: rescate && rescate.cortesDePaso });
  if (x.estado !== 'leido') return { estado: x.estado, motivo: x.motivo, git: git.modelo, _textoGit: git.texto };
  // Con git: un nombre que salió de la CONSOLA se muestra con la ruta de git si coincide con uno solo, y se
  // oculta (contado) si git no lo confirma — `p.Id` saldría como archivo porque `p => p.Id` parece `> archivo`.
  // Las ediciones con herramientas no se tocan: su nombre es exacto aunque git no lo tenga (un archivo revertido).
  // 🔴 `ids` sólo sirve para DESMENTIR un nombre de la consola, y para eso git tiene que haber medido algo:
  // con la lista vacía (0 archivos, o repos que no se pudieron mirar) se ocultaría TODO lo hecho por consola
  // rotulándolo «texto del comando que parecía un archivo».
  const gitMidioAlgo = git.modelo.estado === 'medido' && git.modelo.archivos.length > 0
    && !(git.modelo.repos || []).some((r) => r.estado !== 'medido');
  const ids = gitMidioAlgo ? git.modelo.archivos.map((a) => a.f) : null;
  let noConfirmados = 0;
  // Compacto a propósito: 4.679 ediciones reales repetían la ruta en cada una. `a` es el índice del archivo.
  const archivos = [];
  const idx = new Map();
  const lista = x.ediciones.map((e) => {
    let f = e.f;
    let g;
    let o;
    if (ids && !/^script por consola/.test(f)) {
      const i = cambios.emparejar(f, ids);
      if (i >= 0) { g = i; if (e.k) f = ids[i]; } else if (i === -1 && e.k) { o = 1; noConfirmados += 1; }
    }
    if (!idx.has(f)) { idx.set(f, archivos.length); archivos.push({ f, veces: 0, mas: 0, menos: 0, escrito: 0, consola: 0 }); }
    const a = archivos[idx.get(f)]; a.veces += 1; a.mas += e.mas; a.menos += e.menos; if (e.w) a.escrito = 1; if (e.k) a.consola += 1;
    return { t: e.t, p: filaDeTexto(e.paso), a: idx.get(f), w: e.w, k: e.k ? 1 : 0, r: e.ref, mas: e.mas, menos: e.menos,
      x: e.nuevo !== undefined ? 1 : 0, c: (e.nuevo_cortado || 0) + (e.viejo_cortado || 0), ...(g !== undefined ? { g } : {}), ...(o ? { o } : {}) };
  });
  const texto = x.ediciones.map((e) => (e.nuevo === undefined ? null : [e.viejo, e.nuevo]));
  // Minuto a minuto: [minuto, tokens nuevos, salida, caché nueva, {herramienta: veces}, {agente: veces}].
  const minutos = [...new Set([...Object.keys(x.consumo.serie), ...Object.keys(x.consumo.que)])].map(Number).sort((a, b) => a - b)
    .map((mi) => { const q = x.consumo.que[mi] || { h: {}, ag: {}, out: 0, cache: 0 }; return [mi, x.consumo.serie[mi] || 0, q.out, q.cache, q.h, q.ag]; });
  const ini = Date.parse((marker || {}).startedAt || '');
  return { estado: 'leido', motivo: null, lista, archivos, commits: x.commits.map((k) => ({ ...k, paso: filaDeTexto(k.paso) })), titulo: x.titulo, minutos, git: git.modelo, _textoGit: git.texto, no_confirmados: noConfirmados,
    _esperas: x.esperas || [],
    esperas_min: Number.isFinite(ini) ? (x.esperas || []).map(([a, b]) => [Math.round((a - ini) / 600) / 100, Math.round((b - ini) / 600) / 100]) : [], por_consola: x.por_consola,
    en_commits: x.commits.reduce((a, k) => a + (k.archivos || 0), 0),
    anteriores_al_inicio: x.anteriores_al_inicio, posteriores_al_cierre: x.posteriores_al_cierre, sin_cambio_por_tope: x.sin_cambio_por_tope, topes: x.topes,
    _texto: lista.length ? require('zlib').gzipSync(JSON.stringify(texto)).toString('base64') : null };
}

/**
 * El registro: cada corrida una vez (la sesión y su arranque; entre copias de la misma, el archivo con `archivedAt` mayor);
 * lo ilegible se cuenta. Una sesión puede tener varias corridas, y cada una trae sólo el consumo de su tramo: juntarlas
 * en una perdería el consumo de las demás.
 *
 * Con `opts.buzon` lee además la carpeta bajada del buzón: `<buzon>/<maquina>/*.json`. La
 * máquina de cada corrida sale de la CARPETA que la contiene —nunca del volcado, que no la trae: los
 * volcados archivados no se reescriben— y la de las locales, del nombre de esta máquina. Lo que no se
 * puede atribuir (un volcado suelto en la raíz, una carpeta sin forma de nombre de máquina) sale con
 * `maquina: null` y su motivo. 🔴 Cuando la misma sesión está en varias copias, gana la de
 * `archivedAt` mayor, pero la máquina es la de la primera copia que SÍ la declara: una copia suelta
 * más nueva no puede dejar «sin declarar» a una corrida atribuible.
 * La corrida de una carpeta vieja que `.carpetas-de-maquina.json` declara `unida` es de su carpeta nueva
 * (`maquina_nota: «antes, <vieja>»`), y entre las dos copias de una sesión gana la de la nueva; una `compartida` o
 * `siguio_recibiendo` queda en su carpeta, con su marca. Sin el archivo, nada se une y `buzon.uniones` lo dice.
 */
function leerRegistro(dir, nombresPasos, opts = {}) {
  const out = { registro: { estado: 'medido', motivo: null, dir: null }, corridas: [], archivos: 0, duplicados: 0, ilegibles: 0, buzon: null };
  const multi = Boolean(opts.buzon);
  const maquinaLocal = multi ? (opts.maquina || null) : null;
  const motivoLocal = multi && !maquinaLocal ? (motivoSinSubida || 'no se pudo saber el nombre de esta máquina') : null;
  const copias = [];   // { ruta, maquina, motivo }
  // El sitio lee SÓLO el espejo del buzón; no tener registro propio no es un faltante
  if (opts.soloBuzon) out.registro = { estado: 'no_aplica', motivo: null, dir: null };
  else try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) copias.push({ ruta: path.join(dir, f), origen: maquinaLocal, maquina: maquinaLocal, motivo: motivoLocal });
  } catch (e) {
    out.registro = { estado: 'no_medido', motivo: `esta página se generó donde no está el registro de ejecuciones (${e.code || 'ilegible'}): vive en ~/.claude/.tycon-pipeline/timing-history, en el disco de cada máquina, fuera de todo repo`, dir: null };
    if (!multi) return out;
  }
  if (multi) {
    out.buzon = { estado: 'leido', motivo: null, carpetas_ilegibles: 0 };
    let entradas = [];
    // 🔴 Ordenado: «la primera copia que declara la máquina» no puede depender del orden del disco.
    try { entradas = fs.readdirSync(opts.buzon, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); }
    catch (e) { out.buzon = { estado: 'no_medido', motivo: `la carpeta bajada del depósito de ejecuciones no se pudo leer (${e.code || 'ilegible'})`, carpetas_ilegibles: 0 }; }
    // La corrida de una carpeta vieja `unida` es de su nueva («antes, <vieja>»); una `compartida` o
    // `siguio_recibiendo` queda en su carpeta, marcada. Sin el archivo del bajador no se une nada, y se dice.
    const uniones = out.buzon.estado === 'leido' ? leerUniones(opts.buzon) : null;
    if (uniones) out.buzon.uniones = uniones.estado === 'medidas' ? { estado: 'medidas', motivo: null } : { estado: 'no_medidas', motivo: uniones.motivo };
    const unionDe = (nombre) => (uniones && uniones.estado === 'medidas' ? uniones.carpetas.get(nombre) || null : null);
    for (const en of entradas) {
      if (en.name.startsWith('.')) continue;
      const ruta = path.join(opts.buzon, en.name);
      // 🔴 Un symlink no es ni archivo ni carpeta para el Dirent: se decide por statSync (sigue el enlace), y lo
      //    que no se puede mirar (un enlace roto) se CUENTA — nunca desaparece en silencio.
      let esArchivo = en.isFile(), esCarpeta = en.isDirectory();
      if (en.isSymbolicLink()) {
        try { const st = fs.statSync(ruta); esArchivo = st.isFile(); esCarpeta = st.isDirectory(); }
        catch (e) { out.buzon.carpetas_ilegibles += 1; continue; }
      }
      if (esArchivo && en.name.endsWith('.json')) {
        copias.push({ ruta, maquina: null, motivo: 'registro suelto en la raíz de la carpeta bajada del depósito: no está bajo la carpeta de ninguna máquina' });
      } else if (esCarpeta) {
        const declarada = FORMA_MAQUINA.test(en.name);
        let archivos;
        try { archivos = fs.readdirSync(ruta).filter((x) => x.endsWith('.json')).sort(); }
        catch (e) { out.buzon.carpetas_ilegibles += 1; continue; }
        const u = declarada ? unionDe(en.name) : null;
        for (const f of archivos) {
          // `origen`: la carpeta real del volcado. El sitio se la da a people.js, que vuelve a juzgar la unión (la vieja
          // que informa otro correo, o está confirmada para otra persona, no se une): `maquina` ya viene resuelta
          copias.push({ ruta: path.join(ruta, f), origen: declarada ? en.name : null, maquina: !declarada ? null : u && u.estado === 'unida' ? u.nueva : en.name,
            motivo: declarada ? null : `la carpeta «${en.name}» del depósito no tiene la forma de un nombre de máquina (minúsculas, sin espacios ni .local)`,
            deVieja: Boolean(u), nota: u ? notaDeCarpeta(en.name, u) : null });
        }
      }
    }
  }
  out.archivos = copias.length;
  // La misma corrida en varias copias se junta; dos corridas de la misma sesión, no. Un volcado sin arranque se junta por
  // la sesión sola.
  const porSesion = new Map();   // sesión + arranque → { d, maquina, motivo }
  for (const cp of copias) {
    let d;
    try { d = JSON.parse(fs.readFileSync(cp.ruta, 'utf8')); } catch (e) { out.ilegibles += 1; continue; }
    const sid = d && d.marker && d.marker.sessionId;
    if (!sid || typeof sid !== 'string') { out.ilegibles += 1; continue; }
    const clave = runKey(sid, d.marker);
    const prev = porSesion.get(clave);
    if (!prev) { porSesion.set(clave, { sid, d, maquina: cp.maquina, origen: cp.origen || null, motivo: cp.motivo, rutas: [cp.ruta], deVieja: Boolean(cp.deVieja), nota: cp.nota || null }); continue; }
    out.duplicados += 1;
    // Entre la copia de una carpeta vieja —unida, compartida o que siguió recibiendo— y la de
    // una carpeta nueva (o la local), gana la nueva, sea cual sea su fecha de archivo: la máquina volvió a subir ahí lo de
    // su disco. Con una vieja compartida la sesión es de la carpeta nueva que la re-subió, no de la vieja.
    const misma = cp.maquina && cp.maquina === prev.maquina;
    if (prev.deVieja && !cp.deVieja) {
      // la sesión está también en la carpeta nueva: el origen es la nueva
      prev.d = d; prev.rutas.unshift(cp.ruta); prev.deVieja = false; prev.origen = cp.origen || null;
      if (!misma) { prev.maquina = cp.maquina; prev.motivo = cp.motivo; prev.nota = cp.nota || null; }
    } else if (!prev.deVieja && cp.deVieja) prev.rutas.push(cp.ruta);
    else if (String(d.archivedAt || '') > String(prev.d.archivedAt || '')) { prev.d = d; prev.rutas.unshift(cp.ruta); } else prev.rutas.push(cp.ruta);
    if (!prev.maquina && cp.maquina) { prev.maquina = cp.maquina; prev.origen = cp.origen || null; prev.motivo = null; prev.nota = cp.nota || null; }
    else if (misma && cp.deVieja && !prev.nota) prev.nota = cp.nota;   // la sesión también estaba en la vieja: «antes, …»
  }
  const corridasPorSesion = new Map();
  for (const { sid } of porSesion.values()) corridasPorSesion.set(sid, (corridasPorSesion.get(sid) || 0) + 1);
  // Una corrida medida antes del recorte trae el consumo de la sesión entera: en una sesión con varias, lo publica una
  // sola y las demás salen «no medido» (`wholeSessionDuplicates`). Sin el rescate, ninguna de esas lo publica.
  const deLaSesion = new Map();
  for (const x of porSesion.values()) { if (!deLaSesion.has(x.sid)) deLaSesion.set(x.sid, []); deLaSesion.get(x.sid).push(x); }
  for (const xs of deLaSesion.values()) {
    if (xs.length < 2) continue;
    const quitar = rescate
      ? rescate.wholeSessionDuplicates(xs.map((x) => x.d))
      : new Map(xs.map((x, i) => [i, x.d.consumo && x.d.consumo.estado === 'medido' && !x.d.consumo.tramo ? motivoSinRescate : null]).filter(([, m]) => m));
    for (const [i, m] of quitar) xs[i].d = { ...xs[i].d, consumo: { estado: 'no_medido', motivo: m } };
  }
  for (const [clave, { sid, d, maquina, origen, motivo, rutas, nota }] of porSesion) {
    const c = modeloDeCorrida(d, nombresPasos);
    // cómo terminó: del lado del servidor (lo que se sirve sigue siendo la lista cerrada de campos)
    const cierre = cierreDeCorrida(d);
    Object.defineProperty(c, 'cierre', { value: cierre.estado, enumerable: false });
    Object.defineProperty(c, 'terminada', { value: cierre.estado === 'completa', enumerable: false });
    // Una sesión con una sola corrida conserva el id de siempre (los enlaces ya compartidos siguen andando).
    c.id = idEstable(multi ? maquina : null, corridasPorSesion.get(sid) > 1 ? clave : sid);
    if (multi) { c.maquina = maquina; c.maquina_origen = maquina ? (origen || maquina) : null; c.maquina_motivo = maquina ? null : motivo; c.maquina_nota = maquina ? nota : null; }
    c.cambios = opts.sinHilos ? { estado: 'no_medido', motivo: SIN_HILOS } : cambiosDeLaCorrida(rutas, d.marker, nombresPasos, d.cambio);
    c.sin_pasos_anotados = sinPasosAnotados(c, d.marker);
    // una corrida cuyo marcador desapareció sin su cierre (unclosed-runs.js): se ve, y se distingue
    c.sin_cerrar = d.sinCerrar === true;
    // de qué volcado salió (para bajar su detalle a demanda): sólo del lado del servidor, nunca en lo que se sirve
    Object.defineProperty(c, '_volcado', { value: rutas[0], enumerable: false });
    if (opts.sinHilos && c.tiempos) c.tiempos.espera_del_hilo_ms = null;
    aplicarEsperasDelHilo(c, d.marker);
    c.descripcion = descripcionDe(d.marker, c.cambios);
    // `alTexto`: los textos salen corrida por corrida y no se juntan los de todas en memoria (son casi todo el modelo)
    if (opts.alTexto) {
      const t = textosDe(c);
      if (c.cambios) { delete c.cambios._texto; delete c.cambios._textoGit; }
      opts.alTexto(c, t);
    }
    out.corridas.push(c);
  }
  out.corridas.sort((a, b) => String(b.inicio || '').localeCompare(String(a.inicio || '')));
  return out;
}

/**
 * ¿La corrida arrancó el pipeline, trabajó, y el marcador anotó sólo el arranque (el paso 0)? Eso no es una corrida
 * abandonada: es una que no anotó sus pasos. Hace falta que `stepsCompleted` sea exactamente [0] (vacío no vale) y que
 * haya trabajo: archivos cambiados, o consumo fuera del paso 0 (en un paso posterior o después del último anotado).
 */
function sinPasosAnotados(c, marker) {
  // sólo el Arranque: el 0 en el marcador viejo, `start` en el nuevo
  const hechos = Array.isArray(marker && marker.stepsCompleted) ? marker.stepsCompleted.map(String) : [];
  if (hechos.length !== 1 || (hechos[0] !== '0' && hechos[0] !== 'start')) return false;
  const x = c.cambios;
  const enGit = x && x.git && x.git.estado === 'medido' ? Number(x.git.total_archivos) || 0 : 0;
  const enHilo = x && x.estado === 'leido' && Array.isArray(x.archivos) ? x.archivos.filter((a) => !/^script por consola/.test(a.f)).length : 0;
  const enMarcador = (Array.isArray(marker.filesTouched) ? marker.filesTouched.length : 0) + (Array.isArray(marker.fileEvents) ? marker.fileEvents.length : 0);
  const k = c.consumo && c.consumo.estado === 'medido' ? c.consumo : null;
  const porPaso = k && k.por_paso && typeof k.por_paso === 'object' ? Object.keys(k.por_paso).filter((p) => p !== '0').reduce((a, p) => a + (Number(k.por_paso[p]) || 0), 0) : 0;
  const fuera = k ? Number(k.fuera_de_ventana) || 0 : 0;
  return enGit + enHilo + enMarcador > 0 || porPaso + fuera > 0;
}

function umbrales(archivo = path.join(__dirname, 'sources.json')) {
  // El JUICIO vive en sources.json → thresholds (misma regla que la página de seis preguntas): sin fila,
  // la ficha sale neutra.
  // 🔴 Un sources.json roto NO es «no hay umbral»: sin motivo, las fichas pierden el color en silencio
  //    y eso se ve igual que «no hace falta umbral acá».
  // El modelo (y su `--json`) conserva el nombre `sentido`: la
  // configuración se lee en inglés y la salida no cambia.
  try {
    const cfg = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    if (!cfg || typeof cfg.thresholds !== 'object' || cfg.thresholds === null) return { valores: {}, motivo: 'sources.json no declara `thresholds`: las fichas salen sin juicio de color' };
    const valores = {};
    for (const [k, u] of Object.entries(cfg.thresholds)) {
      valores[k === '_comment' ? '_comentario' : k] = u && typeof u === 'object' && !Array.isArray(u)
        ? Object.fromEntries(Object.entries(u).map(([c, v]) => [c === 'direction' ? 'sentido' : c === '_note' ? '_nota' : c, v]))
        : u;
    }
    return { valores, motivo: null };
  } catch (e) { return { valores: {}, motivo: `sources.json no se pudo leer (${e.code || 'JSON inválido'}): las fichas salen sin juicio de color` }; }
}

/**
 * La línea base de los pasos por corrida: sale del MEDIDOR, que es su única copia. Tipeada acá
 * envejecería callada. 🔴 Si no se puede traer, NO vuelve un nulo mudo: vuelve el motivo, y la página lo dice —
 * «no la pude cargar» y «no hay línea base» no se pueden ver iguales. El motivo lleva el CÓDIGO del error,
 * nunca su mensaje (trae rutas del disco). `ruta` existe para que la suite pueda ejercitar los dos caminos malos.
 */
function lineaBasePasos(ruta = '../../metrics/steps-per-run.js') {
  let lb;
  try { lb = require(ruta).LINEA_BASE; }
  catch (e) { return { estado: 'sin_linea_base', motivo: `el medidor de pasos por ejecución no se pudo cargar (${e.code || e.name || 'error'})` }; }
  if (!lb || !Number.isFinite(lb.mediana) || !/^\d{4}-\d{2}-\d{2}$/.test(String(lb.fecha))) {
    return { estado: 'sin_linea_base', motivo: 'el medidor de pasos por ejecución no declara una línea base con su mediana y su fecha' };
  }
  return { estado: 'medida', mediana: lb.mediana, fecha: String(lb.fecha), corridas: Number.isFinite(lb.corridas) ? lb.corridas : null };
}

function modelo(runsDir, opts = {}) {
  const pasos = opts.skillsDir ? pasosDeLaImagen(opts.skillsDir) : nombresDePasos();
  const reg = leerRegistro(runsDir, pasos.nombres, opts);
  // El sitio unifica los productos sobre lo que cada persona ve, nunca sobre todo
  if (!opts.sinUnificar) unificarProductos(reg.corridas);
  agruparRepos(reg.corridas, opts.repos);
  marcarSinConteo(reg.corridas);
  // Qué máquinas cubre lo que se leyó, y cuántas corridas de cada una: el sello sale de ACÁ, no de una
  // bandera. Una sola máquina y es ésta → «esta máquina», como siempre.
  let maquinas = null;
  if (opts.buzon) {
    const cuenta = {};
    let sinDeclarar = 0;
    for (const c of reg.corridas) { if (c.maquina) cuenta[c.maquina] = (cuenta[c.maquina] || 0) + 1; else sinDeclarar += 1; }
    const lista = Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a] || a.localeCompare(b)).map((n) => ({ nombre: n, corridas: cuenta[n] }));
    maquinas = { local: opts.maquina || null, lista, sin_declarar: sinDeclarar,
      solo_esta: sinDeclarar === 0 && !(reg.buzon && (reg.buzon.estado !== 'leido' || reg.buzon.carpetas_ilegibles)) && lista.length <= 1 && (!lista.length || lista[0].nombre === opts.maquina) };
  }
  const u = umbrales(opts.umbralesArchivo || undefined);
  return {
    multi: Boolean(opts.buzon),
    varias_maquinas: Boolean(opts.buzon),
    maquinas,
    buzon: reg.buzon,
    generado: new Date().toISOString(),
    umbrales: u.valores,
    umbrales_motivo: u.motivo,
    sin_hilos: opts.sinHilos ? SIN_HILOS : null,
    linea_base_pasos: lineaBasePasos(),
    registro: reg.registro,
    archivos: reg.archivos, duplicados: reg.duplicados, ilegibles: reg.ilegibles,
    pasos,
    // desde qué día los pasos están partidos (la primera ejecución con los nombres de máquina); antes, «Implementar +
    // pruebas» va en una sola fila
    pasos_partidos_desde: reg.corridas.filter((c) => c.esquema === 2 && c.inicio).map((c) => c.inicio.slice(0, 10)).sort()[0] || null,
    controles_nombres: CONTROLES,
    sin_rescate: motivoSinRescate,
    sin_tiempos: motivoSinTiempos,
    corridas: reg.corridas,
  };
}


// ───────────────────────────── lo que viaja al sitio ─────────────────────────────

// Lo que sale del hilo en un sitio que no baja las conversaciones (sin disco o con `site.mailbox.threads` apagado).
const SIN_HILOS = 'no medido: este sitio no baja las conversaciones';

/**
 * El id estable de una corrida: 16 hexadecimales del sha256 de «máquina \n sesión». Ni el índice de la lista
 * (cambia con el filtro de cada persona) ni el id de sesión crudo (no se publica). Sin máquina, la máquina es ''.
 */
/** La corrida dentro de su sesión: la sesión y su arranque, o la sesión sola si el volcado no anotó el arranque. */
function runKey(sid, marker) {
  const inicio = marker && typeof marker.startedAt === 'string' && marker.startedAt ? marker.startedAt : null;
  return inicio ? `${sid}\n${inicio}` : sid;
}

function idEstable(maquina, sid) {
  return crypto.createHash('sha256').update(`${maquina == null ? '' : maquina}\n${sid}`).digest('hex').slice(0, 16);
}

/** Los nombres de los pasos desde la carpeta de skills de la imagen (`TYCON_SKILLS_DIR`): `fuente: 'skill'` si cargan. */
function pasosDeLaImagen(skillsDir) {
  const p = nombresDePasos(path.join(skillsDir, 'tycon-pipeline', 'scripts', 'lib', 'steps.js'));
  return p.fuente === 'tabla' ? { ...p, fuente: 'skill' } : p;
}

const copiar = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
// las claves de la lista blanca, siempre todas (lo que falta va null: la forma no depende de qué midió la corrida)
const elegir = (o, claves) => (o && typeof o === 'object' ? Object.fromEntries(claves.map((k) => [k, k in o ? copiar(o[k]) : null])) : o === undefined ? null : o);

/**
 * La corrida para la LISTA: lista BLANCA, campo por campo — lo que usan la cabecera, las fichas, los gráficos y
 * el filtro. La tabla, que usa más, se arma en el servidor. Nada del detalle ni de los textos.
 */
function paraLista(c) {
  return {
    id: c.id, story: c.story, producto: c.producto, grupo: c.grupo || null, maquina: c.maquina === undefined ? null : c.maquina, maquina_motivo: c.maquina_motivo === undefined ? null : c.maquina_motivo,
    inicio: c.inicio, semana: c.semana, dur_ms: c.dur_ms, esquema: c.esquema === 2 ? 2 : 1, llego_al_final: c.llego_al_final, ultimo_paso: c.ultimo_paso, paso_en_curso: Number.isInteger(c.paso_en_curso) ? c.paso_en_curso : null, sin_pasos_anotados: c.sin_pasos_anotados === true, sin_cerrar: c.sin_cerrar === true,
    tramos: copiar(c.tramos), sin_marca: copiar(c.sin_marca),
    tiempos: elegir(c.tiempos, ['trabajo_ms', 'trabajo_medido', 'espera_humana_ms', 'espera_del_hilo_ms']),
    controles: elegir(c.controles, ['total', 'error', 'freno', 'por_control']),
    costo: elegir(c.costo, ['agentes', 'vueltas']),
    validador: elegir(c.validador, ['estado', 'por_fase', 're_loops_decididos', 're_loops_sin_relanzar']),
    consumo: elegir(c.consumo, ['estado', 'respuestas', 'tokens', 'por_paso', 'fuera_de_ventana']),
    // la revisión previa: su estado y números, nunca texto de los hallazgos
    revision_previa: elegir(c.revision_previa, ['estado', 'corregida', 'hallazgos', 'tokens', 'duracion_ms']),
  };
}

/** La corrida para su DETALLE: el modelo de la corrida tal cual (ya es lista blanca), sin los textos. */
function paraDetalle(c) {
  return JSON.parse(JSON.stringify(c, (k, v) => (k === '_texto' || k === '_textoGit' ? undefined : v)));
}

/** Los TEXTOS de una corrida (los cambios y los parches), con su forma: gzip en base64, ya saneados. */
function textosDe(c) {
  const x = c && c.cambios;
  return { texto: (x && x._texto) || null, textoGit: (x && x._textoGit) || null };
}

// ───────────────────────────── la página ─────────────────────────────

// un color por fila de pasos (las diez de FILAS), en cuatro familias por etapa: preparar (0-3, azul), construir (4-6,
// verde azulado), revisar (7-8, ámbar) y cerrar (9, violeta). Dos vecinos quedan a 15 o más de distancia de color (ΔE
// de CIELAB): con una sola tonalidad, dos pasos seguidos no se distinguían. La copia del navegador es la misma.
const RAMPA = ['#C9D6EA', '#9DB3D6', '#6E8DBF', '#3F64A0', '#9CD0CE', '#3D9799', '#14555C', '#F2C46D', '#B07A12', '#6B4C9A'];
// la coma decimal es del castellano: en inglés va el punto
// (sólo en un idioma que la tabla tiene: uno desconocido sale entero en castellano, y con coma)
const decimal = (x, idioma) => (TX && TX.IDIOMAS.includes(idioma) && idioma !== ES ? String(Math.round(x * 10) / 10) : num1(x));
const miles = (n, idioma) => n == null ? '—' : n >= 1e6 ? `${decimal(n / 1e6, idioma)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n);
const dur = (ms, idioma) => ms == null ? '—' : ms < 90 * 60000 ? `${Math.round(ms / 60000)} min` : `${decimal(ms / 3600000, idioma)} h`;

/**
 * El texto de la trama de los pasos sin marca. En una ejecución que no llegó al final, esos pasos no se llegaron a
 * correr, salvo el que quedó a medias, que se nombra aparte; en una que llegó, son pasos que corrieron sin su marca.
 */
function textoSinMarca(c, nombres, idioma, prefijo) {
  const curso = Number.isInteger(c.paso_en_curso) ? c.paso_en_curso : null;
  if (c.llego_al_final) return L(idioma, prefijo + 'pasosSinMarca', { n: c.sin_marca.length });
  // después de donde quedó, no se llegaron a correr; antes, corrieron sin su marca
  const donde = filaDondeQuedo(c);
  const despues = c.sin_marca.filter((f) => f !== curso && donde !== null && f > donde).length;
  const antes = c.sin_marca.filter((f) => f !== curso).length - despues;
  const partes = [];
  if (curso !== null) partes.push(L(idioma, prefijo + 'pasoSinTerminar', { p: enIdioma(idioma, nombres[curso] || String(curso)) }));
  if (despues) partes.push(L(idioma, prefijo + 'pasosSinCorrer', { n: despues }));
  if (antes) partes.push(L(idioma, prefijo + 'pasosSinMarca', { n: antes }));
  return partes.join('; ');
}
/** El paso donde quedó una ejecución que no llegó al final: el que quedó a medias o, si ninguno, el último terminado. */
const filaDondeQuedo = (c) => (Number.isInteger(c.paso_en_curso) ? c.paso_en_curso : c.ultimo_paso);

function barraTramos(c, escala, idioma, nombres) {
  const total = c.tramos.reduce((a, t) => a + t.ms, 0);
  if (!total) return `<span class="nobar">${esc(enIdioma(idioma, c.motivo_tramos || 'sin tiempos por paso'))}</span>`;
  const ancho = Math.max(2, Math.min(100, (total / escala) * 100));
  const segs = c.tramos.map((t) => (t.tipo === 'entre'
    ? `<i class="entre" style="width:${((t.ms / total) * 100).toFixed(2)}%" title="${esc(L(idioma, 'v.entrePasos', { dur: dur(t.ms, idioma) }))}"></i>`
    : `<i style="width:${((t.ms / total) * 100).toFixed(2)}%;background:${RAMPA[t.pasos[0]] || RAMPA[RAMPA.length - 1]}" title="${esc(enIdioma(idioma, t.nombre))} — ${dur(t.ms, idioma)}${t.pasos.length > 1 ? ` (${esc(L(idioma, 'v.fusionados'))})` : ''}${t.medida === false ? ` (${esc(L(idioma, 'v.estimadaPorDiferencia'))})` : ''}"></i>`)).join('');
  const faltan = c.sin_marca.length;
  return `<span class="bar" style="width:${ancho.toFixed(1)}%">${segs}${faltan ? `<i class="falta" style="width:6px" title="${esc(textoSinMarca(c, nombres || [], idioma, 'v.'))}"></i>` : ''}</span>`;
}

// Las dos columnas. Lo estimado lleva «~» y lo dice en el título; lo que no se midió es
// «sin medir», nunca 0.
function colTrabajo(c, idioma) {
  const t = c.tiempos;
  if (!t || t.trabajo_ms === null) return `<span class="nd" title="${esc(enIdioma(idioma, (t && t.motivo) || c.motivo_tramos || 'sin tiempos por paso'))}">—</span>`;
  return t.trabajo_medido ? dur(t.trabajo_ms, idioma) : `<span title="${esc(L(idioma, 'v.trabajoEstimado'))}">~${dur(t.trabajo_ms, idioma)}</span>`;
}
function colEspera(c, idioma) {
  const t = c.tiempos;
  const hilo = t && t.espera_del_hilo_ms ? t.espera_del_hilo_ms : 0;
  if (!t || t.espera_humana_ms === null) {
    // Sin la espera de «Aprobar el plan» y «Hallazgos» medida, lo que el hilo muestra es un piso: se dice «al menos».
    if (hilo) return `<span title="${esc(L(idioma, 'v.esperaAlMenos'))}">≥ ${dur(hilo, idioma)}</span>`;
    return `<span class="nd" title="${esc(enIdioma(idioma, (t && t.motivo) || 'sin tiempos por paso'))}">${esc(L(idioma, 'v.sinMedir'))}</span>`;
  }
  return hilo ? `<span title="${esc(L(idioma, 'v.esperaIncluye', { dur: dur(hilo, idioma) }))}">${dur(t.espera_humana_ms, idioma)}</span>` : dur(t.espera_humana_ms, idioma);
}

function colArchivos(c, idioma) {
  const x = c.cambios;
  const noEsCero = L(idioma, 'v.noEsCero');
  if (x && x.git && x.git.estado === 'medido') {
    const nR = x.git.repos.length;
    const sinMedir = x.git.repos.filter((r) => r.estado !== 'medido');
    // Un 0 con repos sin mirar es «no pude mirar» escrito como «no cambió nada».
    if (!x.git.total_archivos && sinMedir.length) {
      const cuales = sinMedir.map((r) => `${r.n} (${enIdioma(idioma, r.motivo || 'sin motivo')})`).join(' · ');
      return `<span class="nd" title="${esc(L(idioma, 'v.reposSinMirar', { n: sinMedir.length, t: nR, cuales }))} — ${esc(noEsCero)}">—</span>`;
    }
    const a = x.git.total_archivos;
    const titulo = `${L(idioma, 'v.segunGit')} ${a} ${L(idioma, a === 1 ? 'v.archivo1' : 'v.archivoN')} ${L(idioma, 'v.en')} ${nR} ${L(idioma, nR === 1 ? 'v.repo1' : 'v.repoN')}${sinMedir.length ? `, ${sinMedir.length} ${L(idioma, 'v.sinPoderMirar')}` : ''} (${L(idioma, 'v.segunGitResto')})`;
    return `<span title="${esc(titulo)}">${a}</span>`;
  }
  if (!x || x.estado !== 'leido') return `<span class="nd" title="${esc(enIdioma(idioma, (x && x.motivo) || 'no se sabe qué archivos tocó'))} — ${esc(noEsCero)}">—</span>`;
  const n = x.archivos.filter((a) => !/^script por consola/.test(a.f)).length;
  if (n) {
    const c = x.lista.length;
    const titulo = `${c} ${L(idioma, c === 1 ? 'v.cambio1' : 'v.cambioN')} ${L(idioma, 'v.en')} ${n} ${L(idioma, n === 1 ? 'v.archivo1' : 'v.archivoN')}${x.por_consola ? L(idioma, 'v.masConsola', { n: x.por_consola }) : ''}`;
    return `<span title="${esc(titulo)}">${n}</span>`;
  }
  if (x.en_commits) return `<span title="${esc(L(idioma, 'v.porConsolaCommits', { n: x.en_commits }))}">${x.en_commits}</span><small class="nd">${esc(L(idioma, 'v.porConsola'))}</small>`;
  if (x.por_consola) return `<span class="nd" title="${esc(L(idioma, 'v.porConsolaSinSaber', { n: x.por_consola }))}">${esc(L(idioma, 'v.porConsola'))}</span>`;
  return `<span title="${esc(L(idioma, 'v.noEdito'))}">0</span>`;
}

function filaControles(c, idioma) {
  if (!c.controles) return `<span class="nd" title="${esc(L(idioma, 'v.sinControlesTitulo'))}">${esc(L(idioma, 'v.sinControles'))}</span>`;
  const peso = (v) => v.error * 1000 + v.freno * 10 + v.n / 1000;
  return Object.entries(c.controles.por_control).sort((a, b) => peso(b[1]) - peso(a[1])).slice(0, 3).map(([k, v]) => {
    const cls = v.error ? 'f-error' : v.freno ? 'f-freno' : (v.paso === 0 && v.sin_estado) ? 'f-sin' : '';
    const marca = v.error ? ` <b>${esc(L(idioma, 'v.conError', { n: v.error }))}</b>` : v.freno ? ` <b>${esc(L(idioma, 'v.freno', { n: v.freno }))}</b>` : (v.paso === 0 && v.sin_estado) ? ` <b>${esc(L(idioma, 'v.sinEstado'))}</b>` : '';
    const t = `${k} — ${L(idioma, v.n === 1 ? 'v.controlUnaVez' : 'v.controlVeces', { n: v.n, p: v.paso, e: v.error, f: v.freno })}${v.sin_estado ? L(idioma, 'v.controlSinEstado', { n: v.sin_estado }) : ''}`;
    return `<span class="f ${cls}" title="${esc(t)}">${esc(enIdioma(idioma, CONTROLES[k] || k))}${marca}</span>`;
  }).join(' · ');
}

/**
 * La cabecera de la vista: el título, el sello y las bandas. `opts.sitio` = { rol, version }
 * pone los textos fijos del modo sitio: la versión del sitio en lugar del commit y el eyebrow que enlaza el
 * tablero sólo para quien mantiene. Sin conteos globales en el modelo (el de un dev), el sello no los nombra.
 * `opts.idioma`: el de la página (sin él, castellano).
 */
function cabecera(M, opts = {}) {
  const sitio = opts.sitio || null;
  const I = opts.idioma;
  const x = (k, v) => esc(L(I, k, v));
  const C = M.corridas;
  const N = C.length;
  const conConsumo = C.filter((c) => c.consumo.estado === 'medido').length;
  const conControles = C.filter((c) => c.controles).length;
  const alFinal = C.filter((c) => c.llego_al_final).length;
  const origen = sitio ? x('v.versionDelSitio') : `commit ${esc((() => { try { return execSync('git rev-parse --short HEAD', { cwd: RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return L(I, 'v.desconocido'); } })())}`;
  const selloCorridas = Number.isFinite(M.archivos) ? x(M.duplicados === 1 ? 'v.selloArchivos1' : 'v.selloArchivos', { n: N, a: M.archivos, d: M.duplicados, i: M.ilegibles }) : String(N);
  const eyebrow = !sitio ? `${x('v.eyebrowNoche')} <span class="mono">artifacts/tablero-del-arnes.html</span>${x('v.eyebrowNocheRepo')}`
    : sitio.rol === 'maintainer' ? `${x('v.eyebrowSitio')} <a href="/arnes">${x('v.eyebrowSitioEnlace')}</a>`
      : x('v.eyebrowDev');
  const alcance = !M.multi || (M.maquinas && M.maquinas.solo_esta)
    ? L(I, 'v.estaMaquina')
    : [...M.maquinas.lista.map((y) => `${y.nombre} ${y.corridas}`), ...(M.maquinas.sin_declarar ? [`${L(I, 'v.sinDeclarar')} ${M.maquinas.sin_declarar}`] : [])].join(' · ') || (sitio ? L(I, 'v.ningunaMaquina') : '');
  const banda = (titulo, resto) => `<div class="banda gris"><b>${titulo}</b>${resto ? ` ${resto}` : ''}</div>`;
  const bandaBuzon = !M.multi || !M.buzon ? ''
    // al dev del sitio le llega sólo si se leyó entero, sin el número de carpetas
    : M.buzon.parcial !== undefined && !M.buzon.incompleto ? (M.buzon.estado !== 'leido' || M.buzon.parcial ? banda(x('v.ojo'), x('v.puedeFaltar')) : '')
    // quien mantiene, en el sitio, cuando la última bajada no terminó entera: se sirve el último armado entero
    : M.buzon.incompleto && M.buzon.estado === 'leido' && !M.buzon.carpetas_ilegibles ? banda(x('v.bajadaIncompleta'), x('v.bajadaIncompletaResto'))
    : M.buzon.estado !== 'leido' ? banda(x('v.buzonSinLeer'), `${esc(enIdioma(I, M.buzon.motivo))} — ${x('v.buzonSinLeerResto')}`)
    : M.buzon.carpetas_ilegibles ? banda(x(M.buzon.carpetas_ilegibles === 1 ? 'v.carpetasIlegibles1' : 'v.carpetasIlegibles', { n: M.buzon.carpetas_ilegibles }), x('v.carpetasIlegiblesResto'))
    : '';
  // el sitio armó con una pasada que bajó todos los volcados y dejó conversaciones para la siguiente: las corridas están,
  // y las que esperan su conversación todavía no tienen descripción ni cambios
  const bandaPendientes = M.multi && M.buzon && M.buzon.pendientes > 0
    ? banda(x(M.buzon.pendientes === 1 ? 'v.pendientes1' : 'v.pendientes', { n: M.buzon.pendientes }), x('v.pendientesResto'))
    : '';
  // Sin el archivo de uniones del bajador, la carpeta vieja de una máquina que se mudó sale como otra máquina
  const bandaUniones = M.multi && M.buzon && M.buzon.uniones && M.buzon.uniones.estado === 'no_medidas'
    ? banda(x('v.carpetasDeMaquina'), x('v.unionesNoMedidas', { motivo: enIdioma(I, M.buzon.uniones.motivo) }))
    : '';
  // Con corridas del buzón, que esta máquina no tenga registro propio no deja las fichas sin medir: salen sólo
  // con lo bajado. Decir «salen con trama» ahí sería una alarma falsa al lado de números.
  const bandaRegistro = M.registro.estado === 'medido' || M.registro.estado === 'no_aplica' ? ''
    : M.multi && M.corridas.length
      ? banda(x('v.sinRegistroPropio'), `${esc(enIdioma(I, M.registro.motivo))} ${x('v.sinRegistroPropioResto')}`)
      : banda(x('v.sinRegistro'), `${esc(enIdioma(I, M.registro.motivo))} ${x('v.sinRegistroResto')}`);
  // 'skill': la tabla de pasos que trae la imagen del sitio — con nombre, como 'tabla'
  const gris = (t) => `<div class="banda gris">${esc(enIdioma(I, t))}</div>`;
  const bandaPasos = (M.pasos.fuente !== 'tabla' && M.pasos.fuente !== 'skill') || M.pasos.motivo ? gris(M.pasos.motivo) : '';
  const bandaPartidos = M.pasos_partidos_desde ? `<div class="banda gris">${x('v.pasosPartidos', { desde: M.pasos_partidos_desde })}</div>` : '';
  const bandaRescate = M.sin_rescate ? gris(M.sin_rescate) : '';
  const bandaTiempos = M.sin_tiempos ? gris(M.sin_tiempos) : '';
  const bandaUmbrales = M.umbrales_motivo ? gris(M.umbrales_motivo) : '';
  return `<header class="head">
  <div class="eyebrow">${eyebrow}</div>
  <h1>${x('v.titulo')}</h1>
  <p class="lede">${x('v.lede1')} <b>${x('v.lede2')}</b>${x('v.lede3')} <b>${x('v.lede4')}</b>${x('v.lede5')}</p>
  <div class="stamp"><span><b>${x('v.selloEjecuciones')}</b> ${selloCorridas}</span><span><b>${x('v.selloConsumo')}</b> ${x('v.deN', { n: conConsumo, t: N })}</span><span><b>${x('v.selloControles')}</b> ${x('v.deN', { n: conControles, t: N })}</span><span><b>${x('v.selloAlFinal')}</b> ${x('v.deN', { n: alFinal, t: N })}</span><span><b>${x('v.selloGenerado')}</b> ${esc(M.generado.slice(0, 16).replace('T', ' '))} UTC · ${origen}</span><span><b>${x('v.selloAlcance')}</b> ${esc(alcance)}</span></div>
  ${bandaBuzon}${bandaPendientes}${bandaUniones}${bandaRegistro}${bandaPasos}${bandaPartidos}${bandaRescate}${bandaTiempos}${bandaUmbrales}
</header>
`;
}

/** La capa ejecutiva: el glosario, el filtro y los contenedores que dibuja el cliente (las fichas y los gráficos). */
function ejecutiva(M, opts = {}) {
  const I = opts.idioma;
  const x = (k, v) => esc(L(I, k, v));
  const f = (k) => esc(L(I, `filtro.${k}`));
  return `<section id="ejecutiva">
  <div class="q-head"><span class="q-n">01</span><h2>${x('v.primero')}</h2></div>
  <div class="claves">
    <div><b>${x('v.claveError')}</b><span>${x('v.claveErrorTexto')} <b>${x('v.claveErrorRemate')}</b></span></div>
    <div><b>${x('v.claveFreno')}</b><span>${x('v.claveFrenoTexto')}</span></div>
    <div><b>${x('v.claveTrama')}</b><span>${x('v.claveTramaTexto')} <b>${x('v.claveTramaRemate')}</b></span></div>
    <div><b>n=</b><span>${x('v.claveN')}</span></div>
  </div>
  <div class="filtrera"><span class="fl">${f('filtro')}</span>
    <label>${f('desde')} <input type="date" id="f-desde"></label><label>${f('hasta')} <input type="date" id="f-hasta"></label>
    <button type="button" id="f-hoy">${f('hoy')}</button><button type="button" id="f-semana">${f('semana')}</button><button type="button" id="f-mes">${f('mes')}</button>
    <label>${f('producto')} <select id="f-repo"></select></label>${M.varias_maquinas ? `
    <label>${f('maquina')} <select id="f-maquina"></select></label>` : ''}
    <label><input type="checkbox" id="fc"> ${f('sinConsumo')}</label>
    <label><input type="checkbox" id="ff"> ${f('llegaron')}</label>
    <button id="f-limpiar">${f('limpiar')}</button><span class="fcount" id="cuenta" data-molde="${f('cuenta')}"></span></div>
  <div class="grid" id="fichas"></div>
  <div class="dos">
    <div class="card"><h3>${x('v.gSemana')}</h3><div id="gsem"></div><p>${x('v.gSemanaNota')}</p></div>
    <div class="card"><h3>${x('v.gPasos')}</h3><div id="gpasos"></div><p>${x('v.gPasosNota1')} <b>${x('v.gPasosNota2')}</b>${x('v.gPasosNota3')} <span class="mono">n</span>${x('v.gPasosNota4')}</p></div>
    <div class="card"><h3>${x('v.gTiempo')}</h3><div id="ppt"></div><p>${x('v.gTiempoNota')}</p></div>
    <div class="card"><h3>${x('v.gTokens')}</h3><div id="ppk"></div><p id="nota-tokens"></p></div>
  </div>
</section>
`;
}

/** La tabla, armada en el servidor: usa campos que la lista no lleva (los archivos tocados). `opts.idioma`: el de la página. */
function tabla(M, opts = {}) {
  const I = opts.idioma;
  const x = (k, v) => esc(L(I, k, v));
  const C = M.corridas;
  const escala = Math.max(1, ...C.map((c) => c.tramos.reduce((a, t) => a + t.ms, 0))) * 0.55;
  const filas = C.map((c, idx) => {
    const tk = c.consumo.estado === 'medido'
      ? miles(c.consumo.tokens.out + c.consumo.tokens.in + c.consumo.tokens.cache_new, I)
      // el motivo se ve en la celda, sin pasar el mouse; el completo queda en el título
      : `<span class="nd" title="${esc(enIdioma(I, c.consumo.motivo))}">${x(c.consumo.estado === 'borrada' ? 'v.borrada' : 'v.noMedido')}</span><small>${c.consumo.estado === 'borrada' ? x('v.borradaMotivo') : esc(enIdioma(I, c.consumo.motivo))}</small>`;
    return `<tr data-i="${idx}" data-id="${esc(c.id || '')}" id="c-${idx}">
      <td class="fecha">${esc((c.inicio || '').slice(0, 10) || L(I, 'v.sinFecha'))}<small>${esc(semanaVisible(c.semana, I))}</small></td>
      <td class="story"><b>${esc(c.story || '—')}</b>${c.descripcion ? `<span class="desc" title="${esc(c.descripcion.texto)}">${esc(c.descripcion.texto)}</span>` : ''}<small>${esc(c.producto ? rotuloProducto(c.producto) : L(I, 'v.productoSinRegistrar'))}</small></td>${M.varias_maquinas ? `
      <td class="maq-td">${c.maquina ? `<span class="maq">${esc(c.maquina)}</span>${c.maquina_nota ? `<small>${esc(enIdioma(I, c.maquina_nota))}</small>` : ''}` : `<span class="nd" title="${esc(enIdioma(I, c.maquina_motivo || ''))}">${x('v.sinDeclarar')}</span>`}</td>` : ''}
      <td class="barra">${barraTramos(c, escala, I, M.pasos.nombres)}</td>
      <td class="dur">${dur(c.dur_ms, I)}</td>
      <td class="dur tr">${colTrabajo(c, I)}</td>
      <td class="dur es">${colEspera(c, I)}</td>
      <td class="pasos-n">${c.sin_cerrar ? `<span class="parcial" title="${x('v.tituloSinCerrar')}">${x('v.sinCerrar')}</span>` : c.llego_al_final ? `<span class="ok9">${x('v.llegoAlFinal')}</span>` : c.sin_pasos_anotados ? `<span class="parcial" title="${x('v.tituloSinPasos')}">${x('v.sinPasosAnotados')}</span>` : `<span class="parcial">${x('v.quedoEn', { p: filaDondeQuedo(c) === null ? '—' : enIdioma(I, M.pasos.nombres[filaDondeQuedo(c)] || String(filaDondeQuedo(c))) })}</span>`}</td>
      <td class="ag">${c.costo ? c.costo.agentes : `<span class="nd" title="${x('v.sinAgentes')}">—</span>`}</td>
      <td class="vu">${c.costo && c.costo.vueltas !== null ? c.costo.vueltas : '<span class="nd">—</span>'}</td>
      <td class="tk">${tk}</td>
      <td class="ar">${colArchivos(c, I)}</td>
      <td class="frenos">${filaControles(c, I)}</td>
    </tr>`;
  }).join('\n');

  const leyenda = M.pasos.nombres.map((p, i) => `<span class="lg"><i style="background:${RAMPA[i]}"></i>${esc(enIdioma(I, p))}</span>`).join('');
  const th = (k, chico) => `<th>${x(k)}${chico ? `<small>${x(chico)}</small>` : ''}</th>`;
  return `<section>
  <div class="q-head"><span class="q-n">02</span><h2>${x('v.porEjecucion')}</h2></div>
  <p class="note">${x('v.porEjecucionNota1')} <b>${x('v.porEjecucionNota2')}</b> ${x('v.porEjecucionNota3')}</p>
  <div class="leyenda">${leyenda}<span class="lg"><i class="falta"></i>${x('v.sinMarca')}</span></div>
  <div class="tabla-caja"><div class="tabla"><table>
    <thead><tr>${th('v.thFecha', 'v.thFechaChico')}${th('v.thStory', 'v.thStoryChico')}${M.varias_maquinas ? th('v.thMaquina', 'v.thMaquinaChico') : ''}${th('v.thTiempo')}${th('v.thDuro')}${th('v.thTrabajo', 'v.thTrabajoChico')}${th('v.thEspera', 'v.thEsperaChico')}${th('v.thPasos')}${th('v.thAgentes')}${th('v.thVueltas')}${th('v.thTokens')}${th('v.thArchivos', 'v.thArchivosChico')}${th('v.thControles', 'v.thControlesChico')}</tr></thead>
    <tbody id="cuerpo">${filas}</tbody></table></div></div>
</section>
`;
}

/** El pie: las notas de la vista. En el sitio, «De dónde sale» dice el espejo del buzón. `opts.idioma`: el de la página. */
function pie(M, opts = {}) {
  const I = opts.idioma;
  const x = (k, v) => esc(L(I, k, v));
  const deDondeSale = opts.sitio
    ? x('v.pieDeDondeSitio')
    : `${x('v.pieDeDondeNoche1')} (<span class="mono">~/.claude/.tycon-pipeline/timing-history</span>)${x('v.pieDeDondeNoche2')}${M.multi ? ` <b>${x('v.pieDeDondeBuzon1')}</b>${x('v.pieDeDondeBuzon2')}` : ''}`;
  const nota = (t, cuerpo) => `<div><b>${x(t)}</b><span>${cuerpo}</span></div>`;
  return `<footer><div class="pie">
  ${nota('v.pieDeDonde', deDondeSale)}
  ${nota('v.pieGit', x('v.pieGitTexto'))}
  ${nota('v.pieHilo', x('v.pieHiloTexto'))}
  ${nota('v.pieTokens', x('v.pieTokensTexto'))}
  ${nota('v.pieRevisor', x('v.pieRevisorTexto'))}
  ${nota('v.pieTrabajo', `${x('v.pieTrabajo1')} <b>${x('v.pieTrabajo2')}</b>${x('v.pieTrabajo3')} ${x('c.esperaDefinicion')}; <b>${x('v.pieTrabajo4')}</b>${x('v.pieTrabajo5')} <b>${x('v.pieTrabajo6')}</b>${x('v.pieTrabajo7')}`)}
</div></footer>`;
}

function render(M) {
  // El texto de los cambios va FUERA del modelo, comprimido, un bloque por corrida: se descomprime al abrirlo.
  const textos = M.corridas.map((c, i) => (c.cambios && c.cambios._texto ? `<script type="text/plain" id="cz-${i}">${c.cambios._texto}</script>` : '')
    + (c.cambios && c.cambios._textoGit ? `<script type="text/plain" id="cg-${i}">${c.cambios._textoGit}</script>` : '')).join('');
  const modeloJson = JSON.stringify(M, (k, v) => (k === '_texto' || k === '_textoGit' ? undefined : v)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Las ejecuciones del pipeline</title>
<style>
${CSS_BASE}
${CSS_PROPIO}
${CSS_CHIPS}
</style></head><body><div class="wrap">
${cabecera(M)}
${ejecutiva(M)}
${tabla(M)}
${pie(M)}
</div>
<script id="modelo" type="application/json">${modeloJson}</script>
${textos}
<script>
${CLIENTE}
</script>
</body></html>`;
}

const CSS_PROPIO = `
.eyebrow a{color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent)}
body.solo #ejecutiva{display:none}
.banda.gris{background:var(--surface-2);border:1px dashed var(--line-strong);color:var(--ink-2);font-weight:400}.banda.gris b{color:var(--ink)}
section{margin-top:40px}h2{font-size:clamp(18px,2.3vw,24px);letter-spacing:-.018em;line-height:1.15;flex:1;min-width:12ch}
.note{font-size:14.5px;line-height:1.55;color:var(--ink-2);margin:13px 0 10px;text-wrap:pretty}.note b{color:var(--ink);font-weight:600}
.claves{display:grid;gap:14px 30px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));margin:16px 0 8px}
.claves div{display:flex;flex-direction:column;gap:3px}
.claves b{font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
.claves span{font-size:13px;line-height:1.5;color:var(--ink-2);text-wrap:pretty}.claves span b{font-family:inherit;font-size:inherit;letter-spacing:0;text-transform:none;color:var(--ink)}
.card{background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);padding:17px 19px 13px;margin-top:13px}
.card h3{margin:0 0 4px;font-size:14.5px;font-weight:600}.card p{margin:8px 0 0;font-size:12.5px;line-height:1.5;color:var(--ink-3);text-wrap:pretty}
.dos{display:grid;gap:13px;grid-template-columns:repeat(auto-fit,minmax(390px,1fr))}
.pasos{display:flex;flex-direction:column;gap:4px;margin-top:10px}
.pfila{display:grid;grid-template-columns:210px 1fr 74px 96px;gap:9px;align-items:center;font-size:12px}
.pfila .pn{color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pfila .pn b{font-family:"IBM Plex Mono",monospace;color:var(--ink-3);margin-right:5px}
.pfila .pb{height:11px;background:var(--line);border-radius:2px;overflow:hidden}.pfila .pb i{display:block;height:100%}
.pfila .pb .hatch{background:repeating-linear-gradient(135deg,var(--hatch) 0 3px,transparent 3px 6px);opacity:.6}
.pfila .pv{font-family:"IBM Plex Mono",monospace;text-align:right;font-weight:500}.pfila .pnn{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--ink-3);text-align:right}
.pfila.sinDato .pv{color:var(--ink-3);font-weight:400}
.leyenda{display:flex;flex-wrap:wrap;gap:5px 14px;margin:12px 0 2px;font-size:11.5px;color:var(--ink-2);font-family:"IBM Plex Mono",monospace}
.lg{display:inline-flex;align-items:center;gap:5px}.lg i{width:11px;height:11px;display:inline-block;border-radius:2px}
.lg i.falta{background:repeating-linear-gradient(135deg,var(--hatch) 0 2px,transparent 2px 4px)}
.tabla{margin-top:12px;overflow-x:auto;border:1px solid var(--line);background:var(--surface)}
/* entre 641 y 1439 px la tabla se desplaza de costado: la sombra del borde derecho avisa que sigue */
.tabla-caja{position:relative}.tabla-caja::after{content:"";position:absolute;top:0;right:0;bottom:0;width:28px;pointer-events:none;background:linear-gradient(to right,transparent,color-mix(in srgb,var(--ink) 18%,transparent));opacity:0}.tabla-caja.sigue::after{opacity:1}
table{border-collapse:collapse;width:100%;font-size:13px;min-width:940px}
th{position:sticky;top:0;background:var(--surface-2);text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3);padding:8px 10px;border-bottom:1px solid var(--line-strong);z-index:2;font-family:"IBM Plex Mono",monospace}
.tabla th{padding:8px 7px;letter-spacing:.03em}.tabla td{padding:7px 7px}
th small{display:block;font-size:9px;letter-spacing:.02em;text-transform:none;color:var(--ink-3);font-weight:400;margin-top:1px}
td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:middle}tr:hover td{background:var(--surface-2)}
td.fecha{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--ink-2);white-space:nowrap}td.fecha small{display:block;color:var(--ink-3);font-size:10.5px}
td.story{min-width:150px}td.story .desc{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11.5px;line-height:1.3;color:var(--ink-2);margin:1px 0}td.story b{font-weight:600}td.story small{display:block;color:var(--ink-3);font-size:11px;overflow-wrap:anywhere;min-width:12ch}
td.barra{width:9%;min-width:80px}
.bar{display:flex;height:13px;border-radius:2px;overflow:hidden;min-width:8px}.bar i{display:block;height:100%}.bar .entre{background:repeating-linear-gradient(90deg,var(--line-strong) 0 1px,transparent 1px 3px)}.bar .falta{background:repeating-linear-gradient(135deg,var(--hatch) 0 2px,transparent 2px 4px)}
.nobar{font-size:11px;color:var(--ink-3);font-style:italic}
td.ar small{display:block;font-size:9.5px;font-style:italic}td.dur,td.ag,td.vu,td.tk,td.ar{font-family:"IBM Plex Mono",monospace;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
td.pasos-n{font-family:"IBM Plex Mono",monospace;font-size:11.5px;white-space:nowrap}.ok9{color:var(--good)}.parcial{color:var(--warn)}
td.frenos{white-space:normal;min-width:150px}.f{display:inline-block;margin-bottom:2px;font-family:"IBM Plex Mono",monospace;font-size:10.5px;border:1px solid var(--line-strong);color:var(--ink-3);padding:1px 5px;margin-right:3px;border-radius:2px}
.f.f-error{color:var(--crit);border-color:var(--crit);background:var(--crit-soft)}
.f.f-freno{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
.f.f-sin{color:var(--ink-3);border-style:dashed}.f b{font-weight:600;white-space:nowrap}
.nd{color:var(--ink-3);font-style:italic;font-size:11.5px}
tr.abierta td{background:var(--surface-2);box-shadow:inset 3px 0 0 var(--accent)}tbody tr[data-i]{cursor:pointer}
.fila-det td{padding:0;background:var(--surface-2);position:relative}
.det{position:sticky;left:0;width:min(1124px,calc(100vw - 60px));box-sizing:border-box;padding:16px 18px 18px;border-top:2px solid var(--accent);border-bottom:1px solid var(--line-strong)}
.det>*{max-width:100%}
/* a 640 px o menos cada ejecución es una tarjeta: cada dato con su nombre de columna y Controles a la vista */
@media (max-width:640px){.tabla{overflow-x:visible}.tabla table{display:block;min-width:0}.tabla thead{display:none}.tabla tbody{display:block}
.tabla tbody tr[data-i]{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;padding:10px 12px;border-bottom:1px solid var(--line-strong)}
.tabla tbody tr[data-i] td{display:block;border:0;padding:0;min-width:0;width:auto;text-align:left;white-space:normal}
.tabla tbody tr[data-i] td[data-col]::before{content:attr(data-col);display:block;font-family:"IBM Plex Mono",monospace;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3)}
.tabla tbody tr[data-i] td.story,.tabla tbody tr[data-i] td.barra,.tabla tbody tr[data-i] td.frenos{grid-column:1/-1}
.tabla .fila-det{display:block}.tabla .fila-det td{display:block}.tabla tbody tr[hidden]{display:none}.det{position:static;width:auto}.tabla-caja.sigue::after{opacity:0}}
.det-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:12px}
.det-head b{font-size:16px}.det-head .mono{font-size:12.5px;color:var(--ink-2)}.det-head .sub{color:var(--ink-3);font-size:11.5px;margin-top:3px}
.det-chips{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.cerrar{font-family:"IBM Plex Mono",monospace;font-size:11px;background:none;border:1px solid var(--line-strong);color:var(--ink-2);padding:3px 8px;cursor:pointer}
.tl{background:var(--surface);border:1px solid var(--line);padding:10px 8px 4px;overflow-x:auto}
.tlleg{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:9px;font-size:11.5px;color:var(--ink-2)}
.lgi{display:inline-flex;align-items:center;gap:6px}.lgi svg{flex:none}.lgi b{color:var(--ink)}
.tlnota{font-size:12px;line-height:1.5;color:var(--ink-3);margin:9px 0 0;text-wrap:pretty}
.fuera{font-size:11.5px;line-height:1.45;color:var(--ink-3);margin:7px 0 0;text-wrap:pretty}.fuera b{color:var(--ink-2)}
.minis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));margin-top:13px}
.mini.ancha{grid-column:span 2}@media (max-width:900px){.mini.ancha{grid-column:auto}}
.mini{background:var(--surface);border:1px solid var(--line);padding:12px 14px}
.mini.blind{border-style:dashed;background-image:repeating-linear-gradient(135deg,transparent 0 7px,color-mix(in srgb,var(--hatch) 20%,transparent) 7px 8px)}
.mini h4{margin:0 0 8px;font-size:12.5px;font-weight:600}.mini p{margin:0;font-size:12px;color:var(--ink-3)}.mini .kv{margin-bottom:7px;font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--ink-2)}
.nopaso{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-direction:column;gap:5px;max-height:300px;overflow:auto}
.nopaso li{display:grid;grid-template-columns:70px 1fr;gap:3px 8px;font-size:11.5px;border-left:2px solid var(--line-strong);padding:2px 0 3px 8px}
.nopaso li.error{border-left-color:var(--crit)}.nopaso li.freno{border-left-color:var(--accent)}
.np-t{font-family:"IBM Plex Mono",monospace;color:var(--ink-3)}
.np-n{color:var(--ink-2)}.np-n b{color:var(--ink)}.np-n i{font-style:normal;font-family:"IBM Plex Mono",monospace;color:var(--ink-3);font-size:10.5px}
.np-m{grid-column:2;color:var(--ink-2);line-height:1.35}.np-m.falta{color:var(--ink-3);font-style:italic}
.np-r{grid-column:2;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.np-s{grid-column:2;margin:2px 0 0;padding:6px 8px;background:var(--surface-2);border-left:2px solid var(--crit);font-family:"IBM Plex Mono",monospace;font-size:10px;line-height:1.45;color:var(--ink-2);max-height:150px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.np-x{text-decoration:none;font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--ink);background:var(--surface-2);border:1px solid var(--line-strong);border-radius:3px;padding:0 4px}
table.mt{width:100%;border-collapse:collapse;font-size:11.5px;min-width:0;font-family:"IBM Plex Mono",monospace}
table.mt th{position:static;background:none;border:none;padding:2px 6px 4px;font-size:10px}
table.mt td{padding:2px 6px;border-bottom:1px solid var(--line)}table.mt td.rojo{color:var(--crit);font-weight:600}
table.mt.ctls{table-layout:fixed;font-family:inherit}
table.mt.ctls td.num{text-align:right;font-family:"IBM Plex Mono",monospace;white-space:nowrap}
table.mt.ctls th{text-align:right;vertical-align:bottom;line-height:1.2;white-space:normal}table.mt.ctls th:first-child{text-align:left}
table.mt.ctls col.c-veces{width:7ch}table.mt.ctls col.c-error{width:9ch}table.mt.ctls col.c-freno{width:7ch}table.mt.ctls col.c-sin{width:9ch}table.mt.ctls col.c-tiempo{width:9.5ch}
table.mt.ctls td{vertical-align:top;padding:4px 6px}td.ctl{line-height:1.3;white-space:normal}
.ctl-es{display:block;color:var(--ink-2);text-wrap:pretty}
.ctl-tec{display:block;font-family:"IBM Plex Mono",monospace;font-size:10px;color:var(--ink-3);overflow-wrap:anywhere}
.rev .rev-med{color:var(--ink-1)}.rev .rev-est{color:var(--ink-3);font-style:italic;border-bottom:1px dashed var(--ink-3)}.rev-nd{color:var(--ink-3)}
.bars{display:flex;flex-direction:column;gap:3px}
.bars .b{display:grid;grid-template-columns:1fr 100px 42px;gap:7px;align-items:center;font-size:11px;color:var(--ink-2)}
.bars .b span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bars .b i{display:block;height:8px;background:var(--accent);border-radius:2px;min-width:2px}
.bars .b b{font-family:"IBM Plex Mono",monospace;text-align:right;color:var(--ink);font-weight:500}
.filtrera{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;background:var(--surface);border:1px solid var(--line-strong);padding:10px 14px;margin-top:16px;font-size:13px;box-shadow:var(--shadow)}
.filtrera .fl{font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);font-weight:600}
.filtrera label{display:inline-flex;gap:6px;align-items:center;color:var(--ink-2)}
.filtrera input[type=date],.filtrera select{font-family:"IBM Plex Mono",monospace;font-size:12px;padding:3px 6px;background:var(--surface-2);color:var(--ink);border:1px solid var(--line-strong)}
.filtrera button{font-family:"IBM Plex Mono",monospace;font-size:11.5px;padding:4px 9px;background:none;border:1px solid var(--line-strong);color:var(--ink-2);cursor:pointer}
.fcount{margin-left:auto;font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--ink-3)}
#fichas{margin-top:14px}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line-strong)}
.pie{display:grid;gap:18px 34px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.pie div{display:flex;flex-direction:column;gap:4px}
.pie b{font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
.det-desc{font-size:13px;color:var(--ink);margin:3px 0 2px}
.qtok{background:var(--surface);border:1px solid var(--accent);padding:10px 14px;margin-top:10px}.qtok h4{margin:0 0 6px;font-size:12.5px}.qtok p{margin:0 0 6px;font-size:12px;color:var(--ink-2)}
.cambios{background:var(--surface);border:1px solid var(--line);padding:12px 14px;margin-top:12px}
.cambios h4{margin:10px 0 6px;font-size:12.5px;font-weight:600}.cambios h4:first-child{margin-top:0}.cambios p{margin:0 0 8px;font-size:12px;color:var(--ink-3)}
.cambios .ruta{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink);overflow-wrap:anywhere}
.cambios .mas{color:var(--good);font-family:"IBM Plex Mono",monospace;font-size:11px}.cambios .menos{color:var(--crit);font-family:"IBM Plex Mono",monospace;font-size:11px}
table.mt.arch{margin-bottom:10px}table.mt.arch td.num{text-align:right;white-space:nowrap}
ol.cz{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px}
ol.cz summary{cursor:pointer;font-size:11.5px}.cz-t{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--ink-3)}.cz-p{font-size:10.5px;color:var(--ink-3)}
.cz-sin{font-size:11.5px;padding-left:14px}.cz-lbl{font-family:"IBM Plex Mono",monospace;font-size:10px;color:var(--ink-3);margin:6px 0 2px}
.cz-txt pre{margin:0;padding:6px 8px;font-family:"IBM Plex Mono",monospace;font-size:10.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;max-height:520px;overflow:auto;background:var(--surface-2)}
.cz-txt pre.viejo{border-left:2px solid var(--crit)}.cz-txt pre.nuevo{border-left:2px solid var(--good)}
ol.cg{margin:0 0 10px;padding-left:0;list-style:none}ol.cg li{margin:2px 0;display:flex;flex-wrap:wrap;align-items:baseline;gap:0 6px}ol.cg li details{flex:1 1 0;min-width:0}ol.cg summary{cursor:pointer;font-size:11.5px}
.cg-txt pre.diff{margin:0 0 6px;padding:6px 8px;font-family:"IBM Plex Mono",monospace;font-size:10.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;max-height:520px;overflow:auto;background:var(--surface-2)}
.cg-txt .da{color:var(--good)}.cg-txt .dd{color:var(--crit)}.cg-txt .dh{color:var(--ink-3)}
.cg-f{flex:0 0 auto;font-family:"IBM Plex Mono",monospace;font-size:10.5px;background:none;border:1px solid var(--line-strong);color:var(--ink-3);cursor:pointer}
.cz-filtro{font-size:12px;color:var(--ink-2)}.cz-filtro button{font-family:"IBM Plex Mono",monospace;font-size:11px;margin-left:6px;background:none;border:1px solid var(--line-strong);color:var(--ink-2);cursor:pointer}
ul.commits{margin:0;padding-left:16px;font-size:12px;color:var(--ink-2)}
.maq{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--ink)}.maq-td{min-width:9ch}
.pie span{font-size:12.5px;line-height:1.5;color:var(--ink-2);text-wrap:pretty}.pie span b{font-family:inherit;font-size:inherit;letter-spacing:0;text-transform:none;color:var(--ink)}
`;

// ───────────────────────────── el cliente ─────────────────────────────
// Corre en el navegador (y en la suite, sobre un DOM mínimo en Node). Dibuja la capa ejecutiva
// —para que el filtro la recalcule— y el detalle de cada corrida. Ningún número está tipeado:
// todos salen del modelo embebido. Sin comillas invertidas ni `$` seguido de llave adentro: va
// interpolado en un template del generador.
const CLIENTE_FUENTE = String.raw`(function () {
  // los textos, en el idioma de la página: el bloque #corridas-textos que pone el sitio; sin él (la página de la noche,
  // una página vieja), el castellano que trae el propio cliente
  var ES_TXT = /*TEXTOS_ES*/{};
  var TXT = (function () {
    try { var el = typeof document !== 'undefined' && document.getElementById('corridas-textos'); var d = el && el.dataset && el.dataset.textos; var j = d ? JSON.parse(d) : null; return j && typeof j === 'object' ? j : null; }
    catch (e) { if (typeof console !== 'undefined') console.warn('ejecuciones: los textos de la página no se pudieron leer; quedan en castellano', e); return null; }
  })() || ES_TXT;
  // una clave que falta en el bloque de la página (una página de otra versión) sale en castellano, nunca como la clave
  function T(k, v) {
    var s = Object.prototype.hasOwnProperty.call(TXT, k) ? TXT[k] : Object.prototype.hasOwnProperty.call(ES_TXT, k) ? ES_TXT[k] : k;
    return v ? s.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(v, n) ? String(v[n]) : m; }) : s;
  }
  // story 2.27: la FUENTE de los datos. Embebida en la página local (el modelo en #modelo y los textos en cz-N/cg-N,
  // sin red); por la red en la pestaña del sitio (#fuente-corridas: la lista, el detalle al abrir una corrida y los
  // textos al abrir un cambio, ya filtrados por el servidor). El resto del cliente es el mismo.
  var FE = typeof document !== 'undefined' && document.getElementById('fuente-corridas');
  var API = FE && FE.dataset && FE.dataset.api;
  if (API) {
    fetch(API, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error(T('sitioContesto', { s: r.status })); return r.json(); }).then(function (M) {
      // la tabla vino con la página: si el sitio rearmó entre la página y la lista, se recarga (nunca una mezcla)
      if (FE.dataset.generado && M.generado !== FE.dataset.generado) { location.reload(); return; }
      vista(M, fuenteRed(M));
    }).catch(function (err) { var f = document.getElementById('fichas'); if (f) f.textContent = T('sinLista', { e: err.message }); });
  } else {
    var M0 = JSON.parse(document.getElementById('modelo').textContent);
    vista(M0, fuenteEmbebida(M0));
  }
  function fuenteEmbebida(M) {
    return { forma: 'embebida',
      detalle: function (i, fn) { fn(M.corridas[i]); },
      texto: function (tipo, i) { var el = document.getElementById(tipo + '-' + i); return Promise.resolve(el ? el.textContent : null); } };
  }
  function fuenteRed(M) {
    var det = {}, tx = {};
    var pedir = function (ruta) { return fetch(ruta, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error(T('sitioContesto', { s: r.status })); return r.json(); }); };
    return { forma: 'red',
      detalle: function (i, fn, falla) {
        if (det[i]) { fn(det[i]); return; }
        // la falla de la RED va a «falla»; una falla al dibujar el detalle no se disfraza de «no se pudo traer»
        pedir(API + '/' + encodeURIComponent(M.corridas[i].id)).then(function (d) { det[i] = d; fn(d); }, function (err) { if (falla) falla(err); })
          // una falla al DIBUJAR el detalle tampoco queda muda: la fila lo dice, y la consola lleva el error
          .catch(function (err) { if (typeof console !== 'undefined') console.error(err); if (falla) { var e = new Error(T('sinDibujo', { e: err && err.message ? err.message : String(err) })); e.alDibujar = true; falla(e); } });
      },
      texto: function (tipo, i) {
        tx[i] = tx[i] || pedir(API + '/' + encodeURIComponent(M.corridas[i].id) + '/textos');
        tx[i].catch(function () { delete tx[i]; });
        return tx[i].then(function (t) { return tipo === 'cz' ? t.texto : t.textoGit; });
      },
      cargado: function (i) { return det[i]; } };
  }

  function vista(M, FUENTE) {
  if (typeof window !== 'undefined') window.__fuente = { forma: FUENTE.forma };
  var C = M.corridas, PASOS = M.pasos.nombres, CTL = M.controles_nombres || {};
  // la corrida entera de la fila i: la embebida, o el detalle que ya trajo la fuente
  var DET = function (i) { return FUENTE.cargado ? FUENTE.cargado(i) : C[i]; };
  // la corrida de una fila de la tabla, por su id (pase adversarial): en el sitio la tabla vino con la página y la lista
  // en otro pedido, y entre los dos el filtro de la persona pudo cambiar. Por posición, la fila abriría OTRA corrida; por
  // id, una fila que la lista ya no trae queda escondida y sin abrir. Sin id (una página vieja), la posición de siempre.
  var POR_ID = {};
  C.forEach(function (c, k) { if (c.id) POR_ID[c.id] = k; });
  var enC = function (tr) { var id = tr.dataset && tr.dataset.id; if (id) return Object.prototype.hasOwnProperty.call(POR_ID, id) ? POR_ID[id] : null; return +tr.dataset.i; };
  // el paso donde quedó y el texto de los pasos sin marca: como textoSinMarca y filaDondeQuedo del servidor
  var dondeQuedo = function (c) { return typeof c.paso_en_curso === 'number' ? c.paso_en_curso : c.ultimo_paso; };
  var sinMarcaTxt = function (c) {
    var curso = typeof c.paso_en_curso === 'number' ? c.paso_en_curso : null;
    if (c.llego_al_final) return T('pasosSinMarca', { n: c.sin_marca.length });
    var donde = dondeQuedo(c);
    var despues = c.sin_marca.filter(function (f) { return f !== curso && donde !== null && f > donde; }).length;
    var antes = c.sin_marca.filter(function (f) { return f !== curso; }).length - despues;
    var partes = [];
    if (curso !== null) partes.push(T('pasoSinTerminar', { p: PASOS[curso] || curso }));
    if (despues) partes.push(T('pasosSinCorrer', { n: despues }));
    if (antes) partes.push(T('pasosSinMarca', { n: antes }));
    return partes.join('; ');
  };
  var RAMPA = ['#C9D6EA','#9DB3D6','#6E8DBF','#3F64A0','#9CD0CE','#3D9799','#14555C','#F2C46D','#B07A12','#6B4C9A'];
  // el rótulo de cada barra, oscuro o blanco según su color: se lee sobre los diez
  var TINTA = ['#0b0b0b','#0b0b0b','#0b0b0b','#fff','#0b0b0b','#0b0b0b','#fff','#0b0b0b','#0b0b0b','#fff'];
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); };
  var rotulo = function (p) { return String(p).replace('/', ' · '); };
  var n1 = function (x) { return (Math.round(x * 10) / 10).toString().replace('.', T('sepDecimal')); };
  var miles = function (n) { return n == null ? '—' : n >= 1e6 ? n1(n / 1e6) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n); };
  var dt = function (min) { return min < 90 ? Math.round(min) + ' min' : n1(min / 60) + ' h'; };
  var nombreCtl = function (k) { return CTL[k] ? CTL[k] + ' (' + k + ')' : k; };
  // La etiqueta de un carril va anclada a la derecha en una columna de ~290 px: un nombre más largo se cortaba por la
  // izquierda. Se recorta con «…» y el nombre entero queda en su <title>.
  var ETIQUETA_MAX = 46;
  var recortada = function (s, max) { s = String(s); return s.length <= max ? esc(s) : '<title>' + esc(s) + '</title>' + esc(s.slice(0, max - 1)) + '…'; };
  var ctlEs = function (k) { return CTL[k] || k; };
  var ctlTec = function (k) { return CTL[k] ? k : ''; };
  var mediana = function (v) { if (!v.length) return null; var x = v.slice().sort(function (a, b) { return a - b; }); return x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2; };
  var tokensDe = function (c) { return c.consumo.tokens.out + c.consumo.tokens.in + c.consumo.tokens.cache_new; };

  function ejeTicks(durMin) {
    var paso = durMin <= 30 ? 5 : durMin <= 120 ? 15 : durMin <= 360 ? 60 : durMin <= 1440 ? 180 : 720;
    var ts = []; for (var t = 0; t <= durMin; t += paso) ts.push(t); return ts;
  }

  // ─── la línea de tiempo de una corrida ───
  // Lo que queda FUERA del eje se dice, pero no encima del dibujo: escrito dentro del SVG se
  // superponía con las líneas de vuelta y con el eje. Va abajo, como nota de la figura.
  function timeline(c) {
    var notas = []; c._notas = notas;
    if (c.consumo.estado === 'medido' && c.consumo.fuera_de_ventana) notas.push('+' + miles(c.consumo.fuera_de_ventana) + ' ' + T('fueraVentana1') + ' <b>' + T('fueraVentana2') + '</b> ' + T('fueraVentana3'));
    if (c.eventos_previos) notas.push(c.eventos_previos + ' ' + T('previos1') + ' <b>' + T('previos2') + '</b> ' + T('previos3'));
    var durMin = c.dur_ms ? c.dur_ms / 60000 : null;
    var finTramos = c.tramos.reduce(function (a, t) { return a + t.ms / 60000; }, 0);
    var conT = c.eventos.filter(function (e) { return e.t !== null; });
    var sinT = c.eventos.length - conT.length;
    if (sinT) notas.push(sinT + ' ' + T('sinMinuto1') + ' <b>' + T('sinMinuto2') + '</b>' + T('sinMinuto3'));
    var eds = (c.cambios && c.cambios.estado === 'leido') ? c.cambios.lista.filter(function (e) { return e.t !== null && e.t >= 0; }) : [];
    var maxT = Math.max(durMin || 0, finTramos,
      conT.reduce(function (a, e) { return Math.max(a, e.t); }, 0),
      eds.reduce(function (a, e) { return Math.max(a, e.t); }, 0),
      c.vueltas_ts.reduce(function (a, t) { return Math.max(a, t); }, 0));
    if (!Number.isFinite(maxT) || maxT <= 0) return '<p class="tlnota">' + T('sinEscala') + '</p>';
    var W = 1080, x0 = 300, x1 = W - 14;
    var X = function (t) { return x0 + (t / maxT) * (x1 - x0); };
    var tipos = [], conteo = {};
    conT.forEach(function (e) { conteo[e.control] = (conteo[e.control] || 0) + 1; if (tipos.indexOf(e.control) < 0) tipos.push(e.control); });
    tipos.sort(function (a, b) { return conteo[b] - conteo[a] || a.localeCompare(b); });
    var lanes = [{ k: 'pasos', t: T('lanePasos'), h: 26 }];
    if (c.cambios) lanes.push({ k: 'act', t: T('laneArchivos'), h: 22 });
    if (c.cambios) lanes.push({ k: 'tok', t: T('laneConsumo'), h: 34 });
    tipos.forEach(function (t) { lanes.push({ k: 'c:' + t, t: t, h: 15, ctl: t }); });
    if (!tipos.length) lanes.push({ k: 'c:', t: T('laneControles'), h: 22 });
    var y = 16, ys = {};
    lanes.forEach(function (l, i3) { if (l.ctl && (i3 === 0 || !lanes[i3 - 1].ctl)) y += 12; ys[l.k] = y; y += l.h + (l.ctl ? 3 : 12); });
    var H = y + 40;
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="min-width:760px;display:block" role="img" aria-label="' + T('ariaLinea') + '">';
    ejeTicks(maxT).forEach(function (t) {
      s += '<line x1="' + X(t).toFixed(1) + '" y1="10" x2="' + X(t).toFixed(1) + '" y2="' + (H - 34) + '" stroke="var(--line)"></line>';
      s += '<text x="' + X(t).toFixed(1) + '" y="' + (H - 18) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="10" fill="var(--ink-3)">' + (t >= 60 ? n1(t / 60) + ' h' : t + '′') + '</text>';
    });
    var lf = lanes.filter(function (l) { return l.ctl; });
    if (lf.length) {
      var y1g = ys[lf[0].k], y2g = ys[lf[lf.length - 1].k] + lf[lf.length - 1].h;
      s += '<line x1="' + (x0 - 6) + '" y1="' + y1g + '" x2="' + (x0 - 6) + '" y2="' + y2g + '" stroke="var(--accent)" stroke-width="2"></line>';
      s += '<text x="' + (x0 - 14) + '" y="' + (y1g - 6) + '" text-anchor="end" font-family="IBM Plex Mono,monospace" font-size="10" letter-spacing="1.2" fill="var(--accent)">' + T('controlesDelPipeline') + '</text>';
    }
    lanes.forEach(function (l) {
      var f = l.ctl;
      s += '<text x="' + (x0 - 8) + '" y="' + (ys[l.k] + l.h / 2 + (f ? 3.5 : 4)) + '" text-anchor="end" font-family="' + (f ? 'IBM Plex Mono,monospace' : 'IBM Plex Sans,sans-serif') + '" font-size="' + (f ? 10 : 11) + '" fill="var(--ink-' + (f ? '3' : '2') + ')">' + recortada(f ? nombreCtl(l.t) : l.t, ETIQUETA_MAX) + '</text>';
      if (f) s += '<line x1="' + x0 + '" y1="' + (ys[l.k] + l.h / 2) + '" x2="' + x1 + '" y2="' + (ys[l.k] + l.h / 2) + '" stroke="var(--line)" stroke-dasharray="2 4"></line>';
    });
    // pasos (tramos)
    var acc = 0;
    c.tramos.forEach(function (p) {
      var a = X(acc), b = X(acc + p.ms / 60000); acc += p.ms / 60000;
      var w = Math.max(1.2, b - a), i = p.pasos[0];
      if (p.tipo === 'entre') {
        if (p.ms >= 60000) s += '<rect x="' + a.toFixed(1) + '" y="' + (ys.pasos + 9) + '" width="' + w.toFixed(1) + '" height="8" fill="url(#hatch)"><title>' + T('entrePasos', { d: dt(p.ms / 60000) }) + '</title></rect>';
        return;
      }
      if (p.ms < 60000) {
        s += '<line x1="' + a.toFixed(1) + '" y1="' + (ys.pasos - 3) + '" x2="' + a.toFixed(1) + '" y2="' + (ys.pasos + 29) + '" stroke="var(--ink-3)" stroke-width="1.2"><title>' + esc(p.nombre) + ' — ' + T('marcadoJunto') + '</title></line>';
        return;
      }
      s += '<rect x="' + a.toFixed(1) + '" y="' + ys.pasos + '" width="' + w.toFixed(1) + '" height="26" fill="' + (RAMPA[i] || RAMPA[RAMPA.length - 1]) + '" rx="1.5"><title>' + esc(p.nombre) + ' — ' + dt(p.ms / 60000) + (p.pasos.length > 1 ? ' (' + T('fusionados') + ')' : '') + (p.medida === false ? ' (' + T('estimada') + ')' : '') + '</title></rect>';
      if (w > 26) s += '<text x="' + (a + w / 2).toFixed(1) + '" y="' + (ys.pasos + 17) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="10.5" font-weight="600" fill="' + (TINTA[i] || '#fff') + '">' + esc(p.paso) + '</text>';
    });
    // La espera por una persona que salió del hilo: una banda rayada sobre los pasos, con su duración.
    ((c.cambios && c.cambios.esperas_min) || []).forEach(function (w) {
      var ea = X(Math.max(0, w[0])), eb = X(Math.min(maxT, w[1]));
      if (eb - ea < 1) return;
      s += '<rect x="' + ea.toFixed(1) + '" y="' + (ys.pasos - 4) + '" width="' + (eb - ea).toFixed(1) + '" height="34" fill="url(#espera)" stroke="var(--warn)" stroke-width=".8"><title>' + T('esperaTitulo', { d: dt(w[1] - w[0]), a: Math.round(w[0]), b: Math.round(w[1]) }) + '</title></rect>';
      if (eb - ea > 60) s += '<text x="' + ((ea + eb) / 2).toFixed(1) + '" y="' + (ys.pasos + 17) + '" text-anchor="middle" font-family="IBM Plex Sans,sans-serif" font-size="10" font-weight="600" fill="var(--warn)">' + T('esperando', { d: dt(w[1] - w[0]) }) + '</text>';
    });
    if (c.sin_marca.length) s += '<rect x="' + X(acc).toFixed(1) + '" y="' + ys.pasos + '" width="' + Math.max(4, x1 - X(acc)).toFixed(1) + '" height="26" fill="url(#hatch)"><title>' + esc(sinMarcaTxt(c)) + '</title></rect>';
    // archivos tocados: cuántos cambios por momento; clic filtra la lista de abajo (2026-09-17, como el prototipo)
    if (c.cambios && eds.length) {
      var B = 60, bal = {};
      eds.forEach(function (e) { var k = Math.min(B - 1, Math.floor((e.t / maxT) * B)); bal[k] = (bal[k] || 0) + 1; });
      var mxb = Math.max.apply(null, Object.keys(bal).map(function (k) { return bal[k]; }));
      Object.keys(bal).forEach(function (k) {
        var desde = Math.floor((k / B) * maxT), hasta = Math.ceil(((+k + 1) / B) * maxT);
        var bx = x0 + (k / B) * (x1 - x0), bw = Math.max(3, (x1 - x0) / B - 1), bh = Math.max(3, (bal[k] / mxb) * 22);
        s += '<g class="balde" data-desde="' + desde + '" data-hasta="' + hasta + '" style="cursor:pointer"><rect x="' + bx.toFixed(1) + '" y="' + ys.act + '" width="' + bw.toFixed(1) + '" height="22" fill="transparent"></rect>'
          + '<rect x="' + bx.toFixed(1) + '" y="' + (ys.act + 22 - bh).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="var(--ink-2)" opacity=".75"></rect>'
          + '<title>' + T(bal[k] === 1 ? 'baldeCambio1' : 'baldeCambioN', { n: bal[k], a: desde, b: hasta }) + '</title></g>';
      });
    } else if (c.cambios) {
      s += '<rect x="' + x0 + '" y="' + ys.act + '" width="' + (x1 - x0) + '" height="22" fill="url(#hatch)"></rect>';
      s += '<text x="' + (x0 + 8) + '" y="' + (ys.act + 15) + '" font-family="IBM Plex Sans,sans-serif" font-size="11" fill="var(--ink-3)">' + (c.cambios.estado === 'leido' ? (c.cambios.por_consola ? T('actConsola') : T('actNoEdito')) : c.cambios.estado === 'sin_hilo' ? T('actSinHilo') : T('actNoSePublican') + ' ' + esc(c.cambios.motivo || '')) + '</text>';
    }
    // consumo minuto a minuto (tokens nuevos); clic dice en qué se fue (2026-09-17, como el prototipo)
    var mins = (c.cambios && c.cambios.estado === 'leido') ? c.cambios.minutos : [];
    if (c.cambios && mins.length) {
      var B2 = 90, b2 = {}, post = 0;
      mins.forEach(function (mm) { if (mm[0] > maxT) { post += mm[1]; return; } var k2 = Math.min(B2 - 1, Math.floor((mm[0] / maxT) * B2)); b2[k2] = (b2[k2] || 0) + mm[1]; });
      var mx2 = Math.max.apply(null, Object.keys(b2).map(function (k2) { return b2[k2]; }).concat([1]));
      Object.keys(b2).forEach(function (k2) {
        if (!b2[k2]) return;
        var d2 = Math.floor((k2 / B2) * maxT), h2 = Math.ceil(((+k2 + 1) / B2) * maxT);
        var tx = x0 + (k2 / B2) * (x1 - x0), tw = Math.max(2, (x1 - x0) / B2 - 1), th = Math.max(1.5, (b2[k2] / mx2) * 34);
        s += '<g class="tokbar" data-desde="' + d2 + '" data-hasta="' + h2 + '" style="cursor:pointer"><rect x="' + tx.toFixed(1) + '" y="' + ys.tok + '" width="' + tw.toFixed(1) + '" height="34" fill="transparent"></rect>'
          + '<rect x="' + tx.toFixed(1) + '" y="' + (ys.tok + 34 - th).toFixed(1) + '" width="' + tw.toFixed(1) + '" height="' + th.toFixed(1) + '" fill="var(--accent)"></rect>'
          + '<title>' + T('tokBarra', { n: miles(b2[k2]), a: d2, b: h2 }) + '</title></g>';
      });
      if (post) notas.push(miles(post) + ' ' + T('post1') + ' <b>' + T('post2') + '</b> ' + T('post3'));
    } else if (c.cambios) {
      s += '<rect x="' + x0 + '" y="' + ys.tok + '" width="' + (x1 - x0) + '" height="34" fill="url(#hatch)"></rect>';
      s += '<text x="' + (x0 + 8) + '" y="' + (ys.tok + 21) + '" font-family="IBM Plex Sans,sans-serif" font-size="11" fill="var(--ink-3)">' + (c.cambios.estado === 'sin_hilo' ? T('tokSinHilo') : T('tokSinMinutos')) + '</text>';
    }
    // controles, cada uno en su carril
    if (conT.length) {
      conT.forEach(function (e) {
        var x = X(e.t), yy = ys['c:' + e.control] + 7.5;
        var PAL = { paso: T('palPaso'), error: T('palError'), freno: T('palFreno'), sin_estado: T('palSinEstado'), otro: T('palOtro') };
        var tit = '<title>' + esc(nombreCtl(e.control)) + ' — ' + PAL[e.cls] + (e.nota ? ' · ' + esc(e.nota) : '') + (e.ms ? ' · ' + n1(e.ms / 1000) + ' s' : '') + ' · ' + T('minuto', { t: e.t }) + '</title>';
        if (e.cls === 'error') s += '<path d="M' + x.toFixed(1) + ',' + (yy - 5) + ' L' + (x + 4.6).toFixed(1) + ',' + (yy + 3.6) + ' L' + (x - 4.6).toFixed(1) + ',' + (yy + 3.6) + ' Z" fill="var(--crit)">' + tit + '</path>';
        else if (e.cls === 'freno') s += '<rect x="' + (x - 3.8).toFixed(1) + '" y="' + (yy - 3.8) + '" width="7.6" height="7.6" fill="var(--accent)">' + tit + '</rect>';
        else if (e.cls === 'sin_estado' || e.cls === 'otro') s += '<circle cx="' + x.toFixed(1) + '" cy="' + yy + '" r="3.6" fill="none" stroke="var(--ink-3)" stroke-width="1.2" stroke-dasharray="2 2">' + tit + '</circle>';
        else s += '<circle cx="' + x.toFixed(1) + '" cy="' + yy + '" r="4" fill="var(--good-soft)" stroke="var(--good)" stroke-width="1.8">' + tit + '</circle>';
      });
    } else {
      s += '<rect x="' + x0 + '" y="' + ys['c:'] + '" width="' + (x1 - x0) + '" height="22" fill="url(#hatch)"></rect>';
      s += '<text x="' + (x0 + 8) + '" y="' + (ys['c:'] + 15) + '" font-family="IBM Plex Sans,sans-serif" font-size="11" fill="var(--ink-3)">' + (c.controles ? T('ningunaEvaluacion') : T('sinControles')) + '</text>';
    }
    c.vueltas_ts.forEach(function (t, i) {
      var x = X(t);
      s += '<line x1="' + x.toFixed(1) + '" y1="10" x2="' + x.toFixed(1) + '" y2="' + (H - 34) + '" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="3 3"><title>' + T('vuelta', { n: i + 1, t: t }) + '</title></line>';
      s += '<text x="' + (x + 3).toFixed(1) + '" y="14" font-family="IBM Plex Mono,monospace" font-size="9.5" fill="var(--warn)">v' + (i + 1) + '</text>';
    });
    s += '<defs><pattern id="espera" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="var(--surface)" opacity=".82"></rect><line x1="0" y1="0" x2="0" y2="8" stroke="var(--warn)" stroke-width="2" opacity=".6"></line></pattern><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(135)"><rect width="6" height="6" fill="var(--surface-2)"></rect><line x1="0" y1="0" x2="0" y2="6" stroke="var(--hatch)" stroke-width="1.6" opacity=".55"></line></pattern></defs>';
    return s + '</svg>';
  }

  function tarjetaControles(c) {
    if (!c.controles) return '<div class="mini blind ancha"><h4>' + T('laneControles') + '</h4><p>' + T('sinControlesTarjeta') + '</p></div>';
    var f = c.controles.por_control;
    var peso = function (v) { return v.error * 1000 + v.freno * 10 + v.n / 1000; };
    var filas = Object.keys(f).sort(function (a, b) { return peso(f[b]) - peso(f[a]); }).map(function (k) {
      return '<tr><td class="ctl"><span class="ctl-es">' + esc(ctlEs(k)) + '</span>' + (ctlTec(k) ? ' <span class="ctl-tec">' + esc(ctlTec(k)) + '</span>' : '') + '</td>'
        + '<td class="num">' + f[k].n + '</td><td class="num ' + (f[k].error ? 'rojo' : '') + '">' + (f[k].error || '·') + '</td>'
        + '<td class="num">' + (f[k].freno || '·') + '</td><td class="num">' + (f[k].sin_estado || '·') + '</td>'
        + '<td class="num">' + (f[k].ms ? n1(f[k].ms / 1000) + ' s' : '—') + '</td></tr>';
    }).join('');
    return '<div class="mini ancha"><h4>' + T('ctlTitulo', { t: c.controles.total, e: c.controles.error, f: c.controles.freno })
      + (c.controles.sin_estado ? T('ctlSinEstado', { n: c.controles.sin_estado }) : '') + (c.eventos_previos ? T('ctlPrevios', { n: c.eventos_previos }) : '') + '</h4>'
      + '<table class="mt ctls"><colgroup><col><col class="c-veces"><col class="c-error"><col class="c-freno"><col class="c-sin"><col class="c-tiempo"></colgroup>'
      + '<tr><th>' + T('thControl') + '</th><th>' + T('thVeces') + '</th><th>' + T('thConError') + '</th><th>' + T('thFreno') + '</th><th>' + T('thSinEstado') + '</th><th>' + T('thTiempo') + '</th></tr>' + filas + '</table>'
      + '<p>' + T('frenoEs') + '</p></div>';
  }

  // Lo que cuesta la revisión (story 2.15): lo MEDIDO con su número y su denominador, lo ESTIMADO con
  // la palabra y en otra marca. Sin bloque: «sin medir», nunca «0 tokens».
  function loQueGastaron(c) {
    var r = c.revisores;
    if (!r) return '';
    if (r.estado === 'sin_medir') return '<p class="rev-nd">' + T('revSinMedir') + ' — ' + esc(r.motivo) + '</p>';
    var partes = [];
    var N = r.lanzamientos == null ? '?' : r.lanzamientos;
    partes.push(r.duracion_ms.mediana != null
      ? '<span class="rev-med">' + T('revTardaron', { s: Math.round(r.duracion_ms.mediana / 1000), n: r.duracion_ms.n, t: N }) + '</span>'
      : '<span class="rev-nd" title="' + esc(r.duracion_ms.motivo) + '">' + T('revDuracionNo') + '</span>');
    partes.push(r.devuelto_bytes.mediana != null
      ? '<span class="rev-med">' + T('revDevolvieron', { b: r.devuelto_bytes.mediana >= 1024 ? (r.devuelto_bytes.mediana / 1024).toFixed(1) + ' KB' : Math.round(r.devuelto_bytes.mediana) + ' bytes' }) + '</span>'
      : '<span class="rev-nd" title="' + esc(r.devuelto_bytes.motivo) + '">' + T('revTamanoNo') + '</span>');
    partes.push(r.tokens_medidos.total != null
      ? '<span class="rev-med">' + T('revConsumieron', { k: miles(r.tokens_medidos.total) }) + ' <b>' + T('revMedidos') + '</b> ' + T('revNDe', { n: r.tokens_medidos.n, t: N }) + '</span>'
      : '<span class="rev-nd" title="' + esc(r.tokens_medidos.motivo) + '">' + T('revTokensNo') + '</span>');
    var e = r.estimado;
    if (e.estado === 'estimado') {
      partes.push('<span class="rev-est"><b>' + T('revEstimado') + '</b>' + T('revEstimadoTexto', { a: miles(e.tokens_min), b: miles(e.tokens_max), n: e.lanzamientos_cubiertos, f: esc(e.medido_el || '?') }) + '</span>');
    } else if (e.estado === 'vacio') {
      partes.push('<span class="rev-nd">' + T('revNadaQueEstimar') + '</span>');
    } else {
      partes.push('<span class="rev-nd" title="' + esc(e.motivo || '') + '">' + T('revEstimadoNo') + (e.lanzamientos_sin_medir ? T('revParaSinMedir', { n: e.lanzamientos_sin_medir }) : '') + ' — ' + esc(e.motivo || '') + '</span>');
    }
    // Dos padrones distintos pueden no coincidir: el archivador cuenta lo que registró el hook; el
    // medidor, lo que vio en la conversación cuando el registro ya se resumió. Se dice, no se tapa.
    if (c.costo && r.lanzamientos != null && r.lanzamientos !== c.costo.agentes) partes.push('<span class="rev-nd">' + T('revPadrones', { n: r.lanzamientos, a: c.costo.agentes }) + '</span>');
    if (r.sin_resultado) partes.push('<span class="rev-nd">' + T('revSinResultado', { n: r.sin_resultado }) + '</span>');
    if (r.no_ubicados) partes.push('<span class="rev-nd">' + T('revNoUbicados', { n: r.no_ubicados }) + '</span>');
    if (r.fuera_del_registro) partes.push('<span class="rev-nd">' + T('revFueraDelRegistro', { n: r.fuera_del_registro }) + '</span>');
    return '<p class="kv rev' + (r.fuente ? ' rev-' + esc(r.fuente) : '') + '">' + partes.join(' · ') + '</p>'
      + (r.estado !== 'medido' && r.motivo ? '<p class="rev-nd">' + esc(r.motivo) + '</p>' : '');
  }

  // El validador de stories por fase (story 7.3): qué dijo en cada momento de la corrida, con la palabra
  // «sin veredicto» cuando no dejó el renglón, y en cuántas vueltas de revisores el pipeline no lo relanzó.
  var FASES_VAL = [['antes-de-implementar', T('faseAntes')], ['vuelta-1', T('faseVuelta1')], ['re-loop', T('faseReLoops')], ['otra-story', T('faseOtras')], ['sin-vuelta', T('faseSinVuelta')]];
  function delValidador(c) {
    var v = c.validador;
    if (!v) return '';
    var rel = v.re_loops_decididos ? T('valNoRelanzado', { n: v.re_loops_sin_relanzar, t: v.re_loops_decididos }) : '';
    if (v.estado !== 'medido') return '<p class="rev-nd">' + T('valValidador') + ': ' + esc(v.motivo || T('valSinVeredictoMedido')) + rel + '</p>';
    if (!v.lanzamientos) return rel ? '<p class="rev-nd">' + T('valValidador') + rel + '</p>' : '';
    var partes = FASES_VAL.filter(function (p) { return v.por_fase[p[0]].lanzamientos; }).map(function (p) {
      var x = v.por_fase[p[0]], q = [];
      if (x.limpio) q.push(x.limpio + ' ' + T(x.limpio > 1 ? 'valLimpios' : 'valLimpio'));
      if (x.hallazgos) q.push(x.hallazgos + ' ' + T('valConHallazgos'));
      if (x.inconsistente) q.push(x.inconsistente + ' ' + T(x.inconsistente > 1 ? 'valInconsistentes' : 'valInconsistente'));
      if (x.sin_veredicto) q.push(x.sin_veredicto + ' ' + T('valSinVeredicto'));
      if (x.no_medido) q.push(x.no_medido + ' ' + T('valSinResultado'));
      return esc(p[1]) + ': ' + q.join(', ');
    });
    return '<p class="kv rev">' + T('valValidador') + ' — ' + partes.join(' · ') + rel + '</p>';
  }

  function tarjetaAgentes(c) {
    if (!c.costo) return '<div class="mini blind"><h4>' + T('revisores') + '</h4><p>' + T(c.sin_conteo ? 'sinConteoAgentes' : 'sinAgentes') + '</p>' + loQueGastaron(c) + delValidador(c) + '</div>';
    var t = c.costo.por_tipo, ks = Object.keys(t).sort(function (a, b) { return t[b] - t[a]; });
    var mx = Math.max.apply(null, [1].concat(ks.map(function (k) { return t[k]; })));
    return '<div class="mini"><h4>' + T('revTitulo', { n: c.costo.agentes }) + (c.costo.vueltas !== null ? T('revEnVueltas', { n: c.costo.vueltas }) : '') + (c.costo.calculos_del_set !== null && c.costo.calculos_del_set !== undefined ? ' <span class="rev-nd">(' + T('revSetCalculado', { n: c.costo.calculos_del_set }) + ')</span>' : '') + '</h4>'
      + loQueGastaron(c)
      + delValidador(c)
      + (ks.length ? '<div class="bars">' + ks.map(function (k) { return '<div class="b"><span>' + esc(k.replace(/^tycon-/, '')) + '</span><i style="width:' + ((t[k] / mx) * 100).toFixed(0) + '%"></i><b>' + t[k] + '</b></div>'; }).join('') + '</div>' : '<p>' + T('sinDesglose') + '</p>') + '</div>';
  }

  function tarjetaConsumo(c) {
    var k = c.consumo;
    if (k.estado !== 'medido') return '<div class="mini blind"><h4>' + T('consumoNoMedido') + '</h4><p>' + esc(k.motivo) + '</p></div>';
    var pp = k.por_paso, ks = Object.keys(pp).sort(function (a, b) { return pp[b] - pp[a]; });
    var mx = Math.max.apply(null, [1].concat(ks.map(function (x) { return pp[x]; })));
    var nombrePaso = function (key) { return key.split('+').map(function (p) { return PASOS[+p] || p; }).join(' + '); };
    return '<div class="mini"><h4>' + T('consumoTitulo', { n: miles(tokensDe(c)) }) + '</h4>'
      + '<p class="kv">' + T('consumoDetalle', { o: miles(k.tokens.out), n: miles(k.tokens.cache_new), l: miles(k.tokens.cache_read), r: k.respuestas == null ? '?' : k.respuestas }) + '</p>'
      + '<p class="kv">' + T('modelos') + ': ' + Object.keys(k.por_modelo).map(function (m) { return esc(m) + ' ' + k.por_modelo[m].respuestas; }).join(' · ') + '</p>'
      + '<div class="bars">' + ks.map(function (i) { return '<div class="b"><span>' + esc(i) + ' ' + esc(nombrePaso(i)) + '</span><i style="width:' + ((pp[i] / mx) * 100).toFixed(0) + '%;background:' + (RAMPA[+i.split('+')[0]] || RAMPA[RAMPA.length - 1]) + '"></i><b>' + miles(pp[i]) + '</b></div>'; }).join('') + '</div>'
      + (k.fuera_de_ventana ? '<p class="kv">' + T('fueraDeTodoPaso', { n: miles(k.fuera_de_ventana) }) + '</p>' : '')
      + '</div>';
  }

  function tarjetaLoQueEncontraron(c) {
    if (!c.controles) return '';
    var g = c.eventos_agrupados;
    if (!g.length) return '<div class="mini"><h4>' + T('encontraron') + '</h4><p>' + T('encontraronNada') + '</p></div>';
    var PAL = { error: T('encError'), freno: T('encFreno') };
    return '<div class="mini"><h4>' + T('encontraron') + ' — ' + T('encTitulo', { e: c.controles.error, f: c.controles.freno }) + '</h4>'
      + '<ul class="nopaso">' + g.map(function (e) {
        var cuando = e.t === null ? T('sinMinuto2') : (e.n > 1 && e.hasta !== e.t ? 'min ' + e.t + '–' + e.hasta : 'min ' + e.t);
        return '<li class="' + e.cls + '"><span class="np-t">' + cuando + '</span>'
          + '<span class="np-n">' + esc(nombreCtl(e.control)) + ' <b>' + PAL[e.cls] + '</b>'
          + (e.n > 1 ? ' <u class="np-x">×' + e.n + '</u>' : '')
          + (e.exit !== null ? ' <i>' + T('salida', { n: e.exit }) + '</i>' : '') + '</span>'
          + (e.nota ? '<span class="np-m">' + esc(e.nota) + '</span>' : '')
          + (e.n > 1 ? '<span class="np-m">' + T('rebotes', { n: e.n }) + '</span>' : '')
          + (e.mensaje ? '<span class="np-r">' + T('rescatado') + '</span><pre class="np-s">' + esc(e.mensaje) + '</pre>' : '')
          + (!e.mensaje && e.cls === 'error' ? '<span class="np-m falta">' + (e.mensaje_estado === 'retenido' ? T('mensajeRetenido') : T('mensajeSinMotivo')) + '</span>' : '')
          + '</li>';
      }).join('') + '</ul>'
      + '<p>' + T('encNota1') + ' <b>' + T('encNota2') + '</b> ' + T('encNota3') + ' <b>' + T('encNota4') + '</b> ' + T('encNota5') + '</p></div>';
  }

  // story 2.7: qué parte del eje está medida y cuál estimada — dicho en la ficha, no deducible del dibujo.
  function notaTiempos(c) {
    var t = c.tiempos;
    if (!t) return '';
    var partes = [];
    if (t.estado === 'estimada') partes.push(' <b>' + T('durEstimadas') + '</b>' + T('durEstimadasTexto'));
    else if (t.estado === 'parcial') partes.push(' <b>' + T('durAlgunas') + '</b> (' + T(t.estimados.length === 1 ? 'pasoUno' : 'pasosVarios', { p: esc(t.estimados.join(', ')) }) + '): ' + T('durNoAnotaron'));
    if (t.trabajo_ms !== null) partes.push(' ' + T('tTrabajo', { d: dt(t.trabajo_ms / 60000) }) + (t.espera_humana_ms !== null ? ' · ' + T('tEspera', { d: dt(t.espera_humana_ms / 60000) }) : ' · ' + T('tEsperaSinMedir')) + (t.entre_pasos_ms !== null ? ' · ' + T('tEntrePasos', { d: dt(t.entre_pasos_ms / 60000) }) : '') + '.');
    return partes.join('');
  }

  // ─── los archivos que tocó (2026-09-17) ───
  function tarjetaCambios(c, idx) {
    var x = c.cambios;
    if (!x) return '';
    var hayGit = !!(x.git && x.git.estado === 'medido');
    var h = '<div class="cambios"><h4>' + T('archivosQueToco') + '</h4>';
    if (hayGit) h += bloqueGit(x.git, idx, x.estado === 'leido');
    else if (x.git && x.git.estado !== 'sin_cambio') h += '<p class="nd"><b>' + T('segunGit') + '</b> ' + esc(x.git.motivo || x.git.estado) + '</p>';
    return h + conversacion(x, idx, hayGit) + '</div>';
  }
  // Arriba: lo que dejó la corrida según git (story 2.19). Una fila por archivo; sus partes (un commit, o
  // «sin commitear») se abren a pedido, cada una con su parche. No se suman: dos diffs sumados no son un diff.
  function bloqueGit(g, idx, conLista) {
    var nC = g.commits.length, nR = g.repos.length, s = function (n) { return n === 1 ? '' : 's'; };
    var h = '<h4>' + T('gitTitulo') + '</h4><p>' + g.total_archivos + ' ' + T(g.total_archivos === 1 ? 'archivo1' : 'archivoN') + ' ' + T('en') + ' ' + nR + ' ' + T(nR === 1 ? 'repo1' : 'repoN') + ': '
      + (nC ? nC + ' ' + T(nC === 1 ? 'commitDeLaEjecucion1' : 'commitDeLaEjecucionN') : T('ningunCommit')) + ' ' + T('ySinCommitear') + ' '
      + T('gitCambioReal')
      + (g.sin_parche_por_tope ? ' <b>' + g.sin_parche_por_tope + ' ' + T(g.sin_parche_por_tope === 1 ? 'parteSinTexto1' : 'parteSinTextoN') + '</b>' + T('pasanDelTope') : '') + '</p>';
    var avisos = [];
    g.repos.forEach(function (r) {
      if (r.previo) avisos.push(T('en') + ' <b>' + esc(r.n) + '</b>, ' + T(r.previo === 1 ? 'previo1' : 'previoN', { n: r.previo }));
      if (r.otras === null) avisos.push(T('en') + ' <b>' + esc(r.n) + '</b> ' + T('otrasNoSe') + ' ' + esc(r.otras_motivo || T('sinMotivo')));
      else if (r.otras) avisos.push(T('en') + ' <b>' + esc(r.n) + '</b> ' + T('otrasSi', { n: r.otras }));
      // Copia compartida: lo que el hilo atribuyó a otra sesión se dice con su asunto (no se esconde), y lo que
      // no se pudo atribuir queda en la lista, marcado en cada parte.
      if (r.de_otras && r.de_otras.length) {
        var nO = r.de_otras.length;
        avisos.push(T('en') + ' <b>' + esc(r.n) + '</b>, ' + T(nO === 1 ? 'deOtras1' : 'deOtrasN', { n: nO }) + ': '
          + r.de_otras.slice(0, 5).map(function (k) { return '<span class="mono">' + esc(k.h.slice(0, 7)) + '</span> ' + esc(k.s); }).join(' · ') + (nO > 5 ? ' · +' + T('mas', { n: nO - 5 }) : ''));
      }
      var dudosos = g.commits.filter(function (k, ci) { return k.r === g.repos.indexOf(r) && k.at; }).length;
      if (dudosos) avisos.push(T('en') + ' <b>' + esc(r.n) + '</b>, ' + T(dudosos === 1 ? 'dudosos1' : 'dudososN', { n: dudosos }) + (r.atrib_motivo ? ': ' + esc(r.atrib_motivo) : ''));
      if (r.estado !== 'medido') avisos.push('<b>' + esc(r.n) + '</b> ' + T('noSePudoMirar') + ' ' + esc(r.motivo || T('sinMotivo')));
      else if (r.commits_motivo) avisos.push('<b>' + esc(r.n) + '</b>: ' + esc(r.commits_motivo) + ' — ' + T('soloNoCommiteado'));
    });
    if (avisos.length) h += '<p class="nd">' + avisos.join(' · ') + '</p>';
    var noMedidos = g.repos.filter(function (r) { return r.estado !== 'medido'; });
    if (!g.archivos.length) {
      return h + '<p>' + (noMedidos.length
        ? T(noMedidos.length === g.repos.length ? 'ningunRepoMirado' : 'algunosReposSinMirar', { n: noMedidos.length, t: g.repos.length })
        : T('gitSinCambios')) + '.</p>';
    }
    return h + '<ol class="cg">' + g.archivos.map(function (a, ai) {
      var p0 = a.partes[0];
      var nums = a.partes.length > 1 ? '<span class="nd">' + T('enPartes', { n: a.partes.length }) + '</span>'
        : p0.b ? '<span class="nd">' + T('binario') + '</span>' : p0.mas === null ? '<span class="nd">' + esc(p0.om || T('sinNumeros')) + '</span>'
        : '<span class="mas">+' + p0.mas + '</span> <span class="menos">−' + p0.menos + '</span>';
      return '<li><details data-cg="' + idx + '" data-a="' + ai + '"><summary><span class="ruta">' + esc(a.f) + '</span> ' + nums + '</summary><div class="cg-txt">' + T('abriendo') + '</div></details>'
        + (conLista ? '<button class="cg-f" data-g="' + ai + '">' + T('enLaConversacion') + '</button>' : '') + '</li>';
    }).join('') + '</ol>';
  }
  // Abajo: cada cambio en orden, leído de la conversación. El minuto de una edición con herramientas es exacto;
  // el de la consola, aproximado (el archivo se deduce del texto del comando), y así se muestra.
  function conversacion(x, idx, hayGit) {
    var h = hayGit ? '<h4>' + T('convTitulo') + '</h4>' : '';
    if (x.estado !== 'leido') return h + '<p class="nd">' + (x.estado === 'sin_hilo' ? '<b>' + T('sinHilo') + '</b> — ' : '') + esc(x.motivo || '') + '</p>';
    var consola = x.por_consola ? ' <b>' + T(x.por_consola === 1 ? 'consolaCorrio1' : 'consolaCorrioN', { n: x.por_consola }) + '</b> ' + T('consolaTexto') + (x.en_commits ? ' ' + T('consolaCommits') + ' <b>' + x.en_commits + ' ' + T(x.en_commits === 1 ? 'archivo1' : 'archivoN') + '</b>.' : '') : '';
    var aprox = hayGit ? '' : ' <b>' + T('convAprox') + '</b>.';
    if (!x.lista.length) return h + '<p>' + T('convNoEdito') + (x.anteriores_al_inicio ? ' (' + T('convAnteriores', { n: x.anteriores_al_inicio }) + ')' : '') + '.</p>' + commitsHtml(x);
    var vis = x.lista.filter(function (e) { return !e.o; });
    h += '<p>' + (hayGit ? '' : x.archivos.length + ' ' + T(x.archivos.length === 1 ? 'archivo1' : 'archivoN') + ' · ') + vis.length + ' ' + T(vis.length === 1 ? 'cambio1' : 'cambioN') + T('convEnOrden') + ' <b>' + T('convEntero') + '</b> ' + T('convTope', { n: miles(x.topes.edicion) })
      + aprox + consola
      + (x.no_confirmados ? ' ' + x.no_confirmados + ' ' + T(x.no_confirmados === 1 ? 'noConfirmado1' : 'noConfirmadoN') + ' ' + T('noConfirmadoPor') : '')
      + (x.sin_cambio_por_tope ? ' <b>' + T('ultimosSinTexto', { n: x.sin_cambio_por_tope }) + '</b>.' : '')
      + (x.anteriores_al_inicio ? ' ' + T('edicionesAnteriores', { n: x.anteriores_al_inicio }) : '')
      + (x.posteriores_al_cierre ? ' ' + T('edicionesPosteriores', { n: x.posteriores_al_cierre }) : '') + '</p>';
    if (!hayGit) h += '<table class="mt arch"><tr><th>' + T('archivo1') + '</th><th>' + T('cambioN') + '</th><th>+</th><th>−</th></tr>' + x.archivos.map(function (a) {
      return '<tr><td class="ruta">' + esc(a.f) + (a.escrito ? ' <span class="nd">(' + T('escritoEntero') + ')</span>' : '') + (a.consola ? ' <span class="nd">(' + T('porConsola') + (a.consola < a.veces ? ': ' + T('nDe', { n: a.consola, t: a.veces }) : '') + ')</span>' : '') + '</td><td class="num">' + a.veces + '</td><td class="num mas">' + (a.mas ? '+' + a.mas : '·') + '</td><td class="num menos">' + (a.menos ? '−' + a.menos : '·') + '</td></tr>';
    }).join('') + '</table>';
    h += '<p class="cz-filtro" hidden></p><ol class="cz">' + x.lista.map(function (e, k) {
      if (e.o) return '';
      var cab = '<span class="cz-t">' + (e.t === null ? '—' : (e.k ? '≈ ' : '') + e.t + ' min') + '</span> <span class="cz-p">' + esc(nombrePaso(e.p)) + '</span> <span class="ruta">' + esc(x.archivos[e.a].f) + '</span> ' + (e.k ? '<span class="nd">' + T('porConsola') + ' · ' + T('aproximado') + '</span>' : '<span class="mas">+' + e.mas + '</span>' + (e.w ? ' <span class="nd">' + T('escritoEntero') + '</span>' : ' <span class="menos">−' + e.menos + '</span>'));
      return '<li data-t="' + (e.t === null ? '' : e.t) + '" data-g="' + (e.g === undefined ? '' : e.g) + '">' + (e.x
        ? '<details data-cz="' + idx + '" data-k="' + k + '"><summary>' + cab + (e.c ? ' <span class="nd">' + T('cortado') + '</span>' : '') + '</summary><div class="cz-txt">' + T('abriendo') + '</div></details>'
        : '<div class="cz-sin">' + cab + ' <span class="nd">' + T('sinTextoTope') + '</span></div>') + '</li>';
    }).join('') + '</ol>';
    return h + commitsHtml(x);
  }
  function nombrePaso(p) {
    if (p === null || p === undefined) return T('sinPaso');
    if (p === 'después') return T('fueraVentana2');
    return String(p).split('+').map(function (n) { return (M.pasos.nombres || [])[+n] || (T('paso') + ' ' + n); }).join(' + ');
  }
  function commitsHtml(x) {
    if (!x.commits || !x.commits.length) return '<p class="nd">' + T('sinCommits') + '</p>';
    return '<h4>Commits</h4><ul class="commits">' + x.commits.map(function (m) { return '<li><span class="mono">' + esc(m.h) + '</span> <span class="cz-p">' + esc(nombrePaso(m.paso)) + '</span> ' + (m.archivos ? '<span class="nd">' + m.archivos + ' ' + T(m.archivos === 1 ? 'archivo1' : 'archivoN') + '</span> ' : '') + esc(m.s) + '</li>'; }).join('') + '</ul>';
  }
  // Los parches de git (story 2.19): mismo mecanismo que los cambios del hilo, en su propio bloque «cg-N».
  var cgCache = {};
  // story 2.27: el bloque comprimido sale de la FUENTE (embebido en la página local, pedido al sitio en la pestaña)
  function abrirGzip(b64) {
    var bin = atob(String(b64).trim()); var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text().then(JSON.parse);
  }
  function textosGit(idx) {
    if (cgCache[idx]) return cgCache[idx];
    cgCache[idx] = FUENTE.texto('cg', idx).then(function (b64) {
      if (!b64) throw new Error(FUENTE.forma === 'red' ? T('gitNoEsta') : T('gitNoEstaEnPagina'));
      return abrirGzip(b64);
    });
    cgCache[idx].catch(function () { delete cgCache[idx]; });
    return cgCache[idx];
  }
  function diffHtml(t) {
    return String(t).split('\n').map(function (l) {
      var cls = /^\+(?!\+\+ )/.test(l) ? 'da' : /^-(?!-- )/.test(l) ? 'dd' : /^@@/.test(l) ? 'dh' : '';
      return cls ? '<span class="' + cls + '">' + esc(l) + '</span>' : esc(l);
    }).join('\n');
  }
  function pintarGit(det) {
    var caja = det.querySelector('.cg-txt'); if (det.dataset.listo) return;
    var g = DET(+det.dataset.cg).cambios.git, ai = +det.dataset.a, a = g.archivos[ai];
    var NOMBRE = { A: T('nuevo'), M: T('modificado'), D: T('borrado'), R: T('renombrado') };
    textosGit(+det.dataset.cg).then(function (todos) {
      var tx = todos[ai] || [];
      caja.innerHTML = a.partes.map(function (p, k) {
        var cm = p.c >= 0 ? g.commits[p.c] : null;
        var marca = !cm || !cm.at ? '' : cm.at === 'coincide_la_hora'
          ? ' · <b>' + T('sinConfirmar') + '</b>' + T('coincideHora')
          : ' · <b>' + T('sinConfirmar') + '</b>' + T('noSeSabeSesion');
        var cab = (cm ? 'commit <span class="mono">' + esc(cm.h) + '</span>' + (cm.t === null ? '' : ' · min ' + cm.t) + ' · ' + esc(cm.s) + marca : T('sinCommitearAlCerrar'))
          + ' · ' + (NOMBRE[p.e] || esc(p.e)) + (p.ant ? ' (' + T('antesNombre', { n: esc(p.ant) }) + ')' : '') + (p.b || p.mas === null ? '' : ' · +' + p.mas + ' −' + p.menos);
        var cuerpo = p.b ? '<div class="nd">' + T('binarioSinTexto') + '</div>' : p.tope ? '<div class="nd">' + T('sinTextoTope') + '</div>'
          : p.om ? '<div class="nd">' + esc(p.om) + '</div>' : tx[k] ? '<pre class="diff">' + diffHtml(tx[k]) + '</pre>' : '<div class="nd">' + T('sinTexto') + '</div>';
        return '<div class="cz-lbl">' + cab + '</div>' + cuerpo + (p.cor ? '<div class="nd">' + T('cortadoMas', { n: p.cor }) + '</div>' : '');
      }).join('');
      det.dataset.listo = '1';
    }).catch(function (err) { caja.innerHTML = '<span class="nd">' + T('noSeAbrio') + ' ' + esc(err.message) + '</span>'; });
  }
  // Clic en «en la conversación» de un archivo de git: la lista de abajo muestra sólo los momentos de ese archivo.
  function filtrarPorArchivo(fila, c, gi) {
    var caja = fila.querySelector('.cambios'); if (!caja) return;
    var items = caja.querySelectorAll('ol.cz li'), vistos = [];
    items.forEach(function (li) { var ok = li.dataset.g === String(gi); li.hidden = !ok; if (ok) vistos.push(li); });
    var nota = caja.querySelector('.cz-filtro'); if (!nota) return;
    var f = '<span class="ruta">' + esc(c.cambios.git.archivos[gi].f) + '</span>';
    nota.hidden = false;
    nota.innerHTML = (vistos.length ? (vistos.length === 1 ? T('elUnico1') + ' <b>' + T('elUnico2') + '</b> ' + T('elUnico3') : T('losMomentos1') + ' <b>' + vistos.length + '</b> ' + T('losMomentos2')) + ' ' + T('enQueToco') + ' ' + f + '.'
      : T('ningunMomento') + ' ' + f + T('ningunMomentoPorque')) + ' <button class="cz-todos">' + T('verTodos') + '</button>';
    nota.querySelector('.cz-todos').onclick = function () { items.forEach(function (li) { li.hidden = false; }); nota.hidden = true; };
    nota.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  var czCache = {};
  function textosDe(idx) {
    if (czCache[idx]) return czCache[idx];
    czCache[idx] = FUENTE.texto('cz', idx).then(function (b64) {
      if (!b64) throw new Error(FUENTE.forma === 'red' ? T('textoNoEsta') : T('textoNoEstaEnPagina'));
      return abrirGzip(b64);
    });
    czCache[idx].catch(function () { delete czCache[idx]; });
    return czCache[idx];
  }
  // Clic en una barra de consumo: en qué se fue esa ventana (herramientas y agentes, sólo nombres).
  function enQueSeFue(fila, c, desde, hasta) {
    var herr = {}, ags = {}, out = 0, cache = 0;
    c.cambios.minutos.forEach(function (mm) {
      if (mm[0] < desde || mm[0] > hasta) return;
      out += mm[2]; cache += mm[3];
      Object.keys(mm[4]).forEach(function (k) { herr[k] = (herr[k] || 0) + mm[4][k]; });
      Object.keys(mm[5]).forEach(function (k) { ags[k] = (ags[k] || 0) + mm[5][k]; });
    });
    var ks = Object.keys(herr).sort(function (a, b) { return herr[b] - herr[a]; });
    var as = Object.keys(ags).sort(function (a, b) { return ags[b] - ags[a]; });
    var h = '<h4>' + T('ventana', { a: desde, b: hasta, n: miles(out + cache) }) + ' <button class="cerrar qx">' + T('cerrar') + ' ✕</button></h4>'
      + '<p><b>' + miles(out) + '</b> ' + T('escribioModelo') + ' · <b>' + miles(cache) + '</b> ' + T('esContexto') + ' <b>' + T('unPico') + '</b></p>'
      + (as.length ? '<p>' + T('agentesAca') + ': ' + as.map(function (a) { return esc(a) + (ags[a] > 1 ? ' ×' + ags[a] : ''); }).join(' · ') + '</p>' : '');
    if (ks.length) { var mxh = herr[ks[0]]; h += '<div class="bars">' + ks.slice(0, 8).map(function (k) { return '<div class="b"><span>' + esc(k) + '</span><i style="width:' + ((herr[k] / mxh) * 100).toFixed(0) + '%"></i><b>' + herr[k] + '</b></div>'; }).join('') + '</div>'; }
    else h += '<p>' + T('sinHerramientas') + '</p>';
    var caja = fila.querySelector('.qtok'); caja.hidden = false; caja.innerHTML = h;
    caja.querySelector('.qx').onclick = function () { caja.hidden = true; };
  }
  // Clic en una barrita: la lista muestra sólo los cambios de ese momento; si son pocos, los abre.
  function filtrarCambios(fila, desde, hasta) {
    var caja = fila.querySelector('.cambios'); if (!caja) return;
    var items = caja.querySelectorAll('ol.cz li'), vistos = [];
    items.forEach(function (li) { var t = li.dataset.t === '' ? null : +li.dataset.t; var ok = t !== null && t >= desde && t <= hasta; li.hidden = !ok; if (ok) vistos.push(li); });
    var nota = caja.querySelector('.cz-filtro');
    nota.hidden = false;
    nota.innerHTML = (vistos.length === 1 ? T('mostrandoUno1') + ' <b>' + T('elUnico2') + '</b> ' + T('mostrandoUno2') : T('mostrandoLos') + ' <b>' + vistos.length + '</b> ' + T('cambioN')) + ' ' + T('entreMinutos', { a: desde, b: hasta }) + ' <button class="cz-todos">' + T('verTodos') + '</button>';
    nota.querySelector('.cz-todos').onclick = function () { items.forEach(function (li) { li.hidden = false; }); nota.hidden = true; };
    if (vistos.length <= 3) vistos.forEach(function (li) { var d = li.querySelector('details'); if (d && !d.open) { d.open = true; pintarCambio(d); } });
    caja.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function pintarCambio(det) {
    var caja = det.querySelector('.cz-txt'); if (det.dataset.listo) return;
    var e = DET(+det.dataset.cz).cambios.lista[+det.dataset.k];
    textosDe(+det.dataset.cz).then(function (todos) {
      var par = todos[e.r !== undefined ? e.r : +det.dataset.k] || ['', ''];
      var bloque = function (txt, clase, rot) { return txt ? '<div class="cz-lbl">' + rot + '</div><pre class="' + clase + '">' + esc(txt) + '</pre>' : ''; };
      caja.innerHTML = bloque(par[0], 'viejo', T('antes')) + bloque(par[1], 'nuevo', e.k ? T('comandoConsola') : e.w ? T('contenidoEscrito') : T('despues')) + (e.c ? '<div class="nd">' + T('cortadoMas', { n: e.c }) + '</div>' : '');
      det.dataset.listo = '1';
    }).catch(function (err) { caja.innerHTML = '<span class="nd">' + T('noSeAbrio') + ' ' + esc(err.message) + '</span>'; });
  }

  // story 2.27: 'idx' es la fila de la corrida en C. En el sitio, 'c' es el detalle que trajo la red (otro objeto que
  // C[idx]): buscarlo con indexOf daba -1 y ningún cambio ni parche se podía abrir (pase adversarial)
  function detalle(c, idx) {
    if (idx === undefined) idx = C.indexOf(c);
    var chips = (c.sin_cerrar ? '<span class="chip warn" title="' + T('tituloSinCerrar') + '"><span class="g">◆</span>' + T('sinCerrar') + '</span>' : '') + '<span class="chip ' + (c.llego_al_final ? 'ok' : 'warn') + '"' + (!c.llego_al_final && c.sin_pasos_anotados ? ' title="' + T('tituloSinPasos') + '"' : '') + '><span class="g">' + (c.llego_al_final ? '●' : '◆') + '</span>' + (c.llego_al_final ? T('llegoAlFinal') : c.sin_pasos_anotados ? T('noAnotoSusPasos') : T('quedoEn', { p: dondeQuedo(c) === null ? '?' : (PASOS[dondeQuedo(c)] || dondeQuedo(c)) })) + '</span>'
      + (c.controles && c.controles.error ? '<span class="chip bad"><span class="g">▲</span>' + T('conErrorN', { n: c.controles.error }) + '</span>' : '')
      + (c.controles && c.controles.freno ? '<span class="chip warn"><span class="g">◆</span>' + T('frenoN', { n: c.controles.freno }) + '</span>' : '')
      + (c.costo && c.costo.vueltas !== null ? '<span class="chip neutro"><span class="g">○</span>' + T('vueltasN', { n: c.costo.vueltas }) + '</span>' : '')
      + (c.dod ? '<span class="chip ' + (c.dod === 'PASS' ? 'ok' : 'bad') + '"><span class="g">' + (c.dod === 'PASS' ? '●' : '▲') + '</span>' + T(c.dod === 'PASS' ? 'terminadoPaso' : 'terminadoNoPaso') + '</span>' : '');
    var tl = timeline(c);
    return '<div class="det">'
      + '<div class="det-head"><div><b>Story ' + esc(c.story || '—') + '</b> <span class="mono">' + esc(c.producto ? rotulo(c.producto) : T('productoSinRegistrar')) + '</span>'
      + (M.multi ? ' <span class="mono">· ' + (c.maquina ? esc(c.maquina) + (c.maquina_nota ? ' (' + esc(c.maquina_nota) + ')' : '') : T('maquinaSinDeclarar') + ' ' + esc(c.maquina_motivo || '')) + '</span>' : '')
      + (c.descripcion ? '<div class="det-desc">' + esc(c.descripcion.texto) + ' <span class="nd">— ' + esc(c.descripcion.fuente) + '</span></div>' : '<div class="det-desc nd">' + T('sinDescripcion') + '</div>')
      + '<div class="mono sub">' + esc((c.inicio || '').slice(0, 16).replace('T', ' ')) + ' UTC · ' + (c.dur_ms ? dt(c.dur_ms / 60000) : T('sinDuracion')) + '</div></div>'
      + '<div class="det-chips">' + chips + '<button class="cerrar">' + T('cerrar') + ' ✕</button></div></div>'
      + '<div class="tl">' + tl + '</div><div class="qtok" hidden></div>'
      + ((c._notas && c._notas.length) ? '<p class="fuera">' + c._notas.join(' ') + '</p>' : '')
      + '<div class="tlleg">'
      +   '<span class="lgi"><svg width="13" height="13"><circle cx="6.5" cy="6.5" r="4" fill="var(--good-soft)" stroke="var(--good)" stroke-width="1.8"></circle></svg>' + T('palPaso') + '</span>'
      +   '<span class="lgi"><svg width="13" height="13"><path d="M6.5,2 L11,10 L2,10 Z" fill="var(--crit)"></path></svg><b>' + T('encError') + '</b> — ' + T('legError') + '</span>'
      +   '<span class="lgi"><svg width="13" height="13"><rect x="2.7" y="2.7" width="7.6" height="7.6" fill="var(--accent)"></rect></svg><b>' + T('encFreno') + '</b> — ' + T('legFreno') + '</span>'
      +   '<span class="lgi"><svg width="13" height="13"><circle cx="6.5" cy="6.5" r="3.6" fill="none" stroke="var(--ink-3)" stroke-width="1.2" stroke-dasharray="2 2"></circle></svg>' + T('palSinEstado') + '</span>'
      +   '<span class="lgi"><svg width="13" height="13"><line x1="6.5" y1="0" x2="6.5" y2="13" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="3 3"></line></svg>' + T('legVuelta') + '</span>'
      +   '<span class="lgi"><svg width="13" height="13"><line x1="6.5" y1="0" x2="6.5" y2="13" stroke="var(--ink-3)" stroke-width="1.2"></line></svg>' + T('legMarcadoJunto') + '</span>'
      +   '<span class="lgi"><svg width="16" height="13"><rect x="0" y="3" width="16" height="7" fill="url(#hatch)" stroke="var(--line-strong)"></rect></svg>' + T('legEntrePasos') + '</span>'
      +   '<span class="lgi"><svg width="16" height="13"><rect x="0" y="1" width="16" height="11" fill="none" stroke="var(--warn)" stroke-dasharray="3 2"></rect></svg><b>' + T('legEsperando') + '</b> — ' + T('legEsperandoTexto') + '</span>'
      + '</div>'
      + '<p class="tlnota">' + T('ejeNota1') + ' <b>' + T('ejeNota2') + '</b> ' + T('ejeNota3')
      + notaTiempos(c)
      + (c.motivo_tramos ? ' <b>' + esc(c.motivo_tramos) + '.</b>' : '') + '</p>'
      + '<div class="minis">' + tarjetaLoQueEncontraron(c) + tarjetaControles(c) + tarjetaAgentes(c) + tarjetaConsumo(c) + '</div>'
      + tarjetaCambios(c, idx) + '</div>';
  }
  if (typeof window !== 'undefined') { window.__detalle = detalle; }

  // ─── la capa ejecutiva: se dibuja acá para que el filtro la RECALCULE ───
  var med = function (texto, den, extra) { var o = { estado: 'medido', texto: texto, den: den }; for (var k in (extra || {})) o[k] = extra[k]; return o; };
  // Mismo criterio que juzgar() de common.js: el umbral sale de sources.json; sin fila, neutro.
  var UMB = M.umbrales || {};
  // Un umbral PRESENTE pero mal formado (sin sentido o sin sus números) NO es un umbral: comparado
  // contra undefined daba siempre «atención». Se declara en la ficha, como hace common.js.
  // 'num' = Number.isFinite sin coerción: el isFinite global convierte '' y true en 0 y 1, y un umbral
  // mal tipeado pasaba acá y no en common.js (cazador de fallos silenciosos, iter 4).
  var num = function (x) { return typeof x === 'number' && isFinite(x); };
  var umbralValido = function (u) {
    if (!u || typeof u !== 'object') return false;
    if (u.sentido === 'mayor_es_mejor') return num(u.ok_min) && num(u.bad_max);
    if (u.sentido === 'menor_es_mejor') return num(u.ok_max) && num(u.bad_min);
    return false;
  };
  var juzgar = function (clave, v) {
    var u = UMB[clave]; if (u === undefined) return { est: 'neutro', palabra: T('medido') };
    if (!umbralValido(u)) return { est: 'neutro', palabra: T('sinJuicio'), nota: T('umbralMalFormado', { k: clave }) };
    var est = u.sentido === 'mayor_es_mejor' ? (v >= u.ok_min ? 'ok' : v <= u.bad_max ? 'bad' : 'warn') : (v <= u.ok_max ? 'ok' : v >= u.bad_min ? 'bad' : 'warn');
    return { est: est, palabra: { ok: T('bien'), warn: T('atencion'), bad: T('rojo') }[est] };
  };
  var gris = function (motivo) { return { estado: 'no_medido', motivo: motivo }; };
  // La misma forma que 'ficha' de common.js (mismas clases, mismo denominador al lado); vive acá
  // porque corre en el navegador, donde no hay require. Si cambia una, cambia la otra.
  function ficha(titulo, m) {
    if (!m || m.estado !== 'medido') return '<div class="tile blind"><span class="chip blind"><span class="g">▨</span>' + T('noMedido') + '</span><div class="t-label">' + esc(titulo) + '</div><div class="t-val">' + T('falta') + '</div><div class="t-den">' + esc(m && m.motivo || T('sinMotivo')) + '</div></div>';
    var e = m.est || 'neutro', gl = { ok: '●', warn: '◆', bad: '▲', neutro: '○' }[e] || '○';
    return '<div class="tile ' + (m.est || '') + '"><span class="chip ' + e + '"><span class="g">' + gl + '</span>' + esc(m.palabra || T('medido')) + '</span><div class="t-label">' + esc(titulo) + '</div><div class="t-val">' + m.texto + '</div><div class="t-den">' + esc(m.den) + '</div>' + (m.detalle ? '<div class="t-foot">' + m.detalle + '</div>' : '') + '</div>';
  }

  // story 7.12: la línea base de pasos por corrida llega en el modelo (sale del medidor). Sin ella, el motivo
  // se DICE en la ficha y en la serie: omitir la frase haría que «no la pude cargar» se vea igual que «no hay».
  var LB = M.linea_base_pasos && M.linea_base_pasos.estado === 'medida' && num(M.linea_base_pasos.mediana) ? M.linea_base_pasos : null;
  var sinLB = LB ? '' : T('sinLineaBase') + ' ' + esc((M.linea_base_pasos && M.linea_base_pasos.motivo) || T('generadaSinLineaBase'));
  // Entero positivo: el MISMO criterio que medir() de scripts/metrics/steps-per-run.js. Si cambia uno, cambia el otro.
  // (Sin comillas invertidas acá adentro: este bloque vive en una plantilla de JS y una sola la corta.)
  var pasosMedidos = function (c) { return c.consumo.estado === 'medido' && num(c.consumo.respuestas) && c.consumo.respuestas > 0 && Math.floor(c.consumo.respuestas) === c.consumo.respuestas; };

  // La serie por mes: un punto por mes con su mediana y su n. 🔴 Un mes del rango SIN corridas medidas NO se
  // dibuja en cero —como sí hace, bien, el gráfico por semana, donde cero corridas es un dato—: «mediana 0»
  // sería un número que nadie midió. Queda el hueco, con trama, y su título lo dice.
  function graficoPasos(F) {
    var porMes = {}, sinFecha = 0;
    // Una corrida medida sin fecha de arranque no tiene mes: no entra en la serie, y se CUENTA — la ficha sí la
    // incluye, y un n que no coincide con la suma de los puntos sin explicación es un número que nadie puede auditar.
    F.filter(pasosMedidos).forEach(function (c) { if (c.inicio) { var k = c.inicio.slice(0, 7); (porMes[k] = porMes[k] || []).push(c.consumo.respuestas); } else sinFecha += 1; });
    var notas = (sinFecha ? '<p class="tlnota">' + T(sinFecha === 1 ? 'sinFecha1' : 'sinFechaN', { n: sinFecha }) + '</p>' : '')
      + (LB ? '' : '<p class="tlnota">' + sinLB + '.</p>');
    var con = Object.keys(porMes).sort();
    if (!con.length) return '<p class="tlnota">' + T('sinSerie') + '</p>' + notas;
    var ks = [], y = Number(con[0].slice(0, 4)), m = Number(con[0].slice(5, 7)), fin = con[con.length - 1];
    while (ks.length < 120) { var k = y + '-' + String(m).padStart(2, '0'); ks.push(k); if (k >= fin) break; m += 1; if (m > 12) { m = 1; y += 1; } }
    var pts = ks.map(function (k) { return porMes[k] ? { k: k, v: mediana(porMes[k]), n: porMes[k].length } : { k: k, v: null, n: 0 }; });
    // El techo del eje se redondea a la centena de arriba, con aire: los números de los puntos van encima.
    var max = Math.max(100, Math.ceil(Math.max.apply(null, [1].concat(pts.map(function (p) { return p.v || 0; })).concat(LB ? [LB.mediana] : [])) * 1.2 / 100) * 100);
    // Ningún texto del gráfico mide menos de 11 px.
    var W = 720, H = 196, x0 = 40, x1 = 706, base = 148, top = 16, paso = (x1 - x0) / ks.length;
    var Y = function (v) { return base - (v / max) * (base - top); };
    var X = function (i) { return x0 + paso * i + paso / 2; };
    var s2 = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px;min-width:520px;display:block" role="img" aria-label="' + T('ariaPasos') + '">';
    [0, max / 2, max].forEach(function (t) {
      s2 += '<line x1="' + x0 + '" y1="' + Y(t) + '" x2="' + x1 + '" y2="' + Y(t) + '" stroke="var(--line)"></line><text x="' + (x0 - 7) + '" y="' + (Y(t) + 4) + '" text-anchor="end" font-family="IBM Plex Mono,monospace" font-size="11" fill="var(--ink-3)">' + t + '</text>';
    });
    // El rótulo de la línea base va en la leyenda, debajo: dentro del área se encimaba con los valores, que caen cerca
    // de ella (es lo esperable).
    if (LB) s2 += '<line x1="' + x0 + '" y1="' + Y(LB.mediana).toFixed(1) + '" x2="' + x1 + '" y2="' + Y(LB.mediana).toFixed(1) + '" stroke="var(--ink-3)" stroke-dasharray="4 4"><title>' + T('lineaBaseDel', { f: esc(LB.fecha), m: LB.mediana }) + '</title></line>';
    // La línea une sólo meses CONSECUTIVOS medidos: cruzar un hueco dibujaría una tendencia que nadie midió.
    pts.forEach(function (p, i) {
      if (i && p.v !== null && pts[i - 1].v !== null) s2 += '<line x1="' + X(i - 1).toFixed(1) + '" y1="' + Y(pts[i - 1].v).toFixed(1) + '" x2="' + X(i).toFixed(1) + '" y2="' + Y(p.v).toFixed(1) + '" stroke="var(--accent)" stroke-width="2"></line>';
    });
    pts.forEach(function (p, i) {
      var cx = X(i);
      s2 += p.v === null
        ? '<rect x="' + (cx - Math.min(15, paso * 0.31)).toFixed(1) + '" y="' + top + '" width="' + Math.min(30, paso * 0.62).toFixed(1) + '" height="' + (base - top) + '" fill="var(--hatch)" opacity=".18" rx="2"><title>' + p.k + ': ' + T('sinEjecucionesMedidas') + '</title></rect>'
        : '<circle cx="' + cx.toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="4.5" fill="var(--accent)"><title>' + p.k + ': ' + T('medianaN', { v: Math.round(p.v), n: p.n }) + '</title></circle>'
          + '<text x="' + cx.toFixed(1) + '" y="' + (Y(p.v) - 9).toFixed(1) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="11" fill="var(--ink)">' + Math.round(p.v) + '</text>';
      s2 += '<text x="' + cx.toFixed(1) + '" y="166" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="11" fill="var(--ink-3)">' + p.k + '</text>'
        + '<text x="' + cx.toFixed(1) + '" y="181" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="11" fill="var(--ink-3)">' + (p.v === null ? T('sinMedir') : 'n=' + p.n) + '</text>';
    });
    var leyenda = LB ? '<p class="tlnota leyenda"><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="var(--ink-3)" stroke-dasharray="4 4"></line></svg> ' + T('lineaBase', { m: LB.mediana, f: esc(LB.fecha) }) + '</p>' : '';
    // los meses del rango sin ejecuciones medidas se nombran: el hueco con trama sólo, en un rango largo, no se ve
    var sinMedir = pts.filter(function (p) { return p.v === null; }).map(function (p) { return p.k; });
    var aviso = sinMedir.length ? '<p class="tlnota">' + T('mesesSinMedir', { meses: sinMedir.join(', ') }) + '</p>' : '';
    return s2 + '</svg>' + leyenda + aviso + notas;
  }

  // La revisión de la historia antes de programar. Cuenta HISTORIAS: las corridas de una misma historia comparten su
  // constancia, y sumarlas contaría dos veces la revisión y su costo; de cada historia vale su corrida más nueva. Una
  // historia es su número dentro de su producto: dos productos pueden tener cada uno su «2.1». Las
  // corridas sin el campo son anteriores a la revisión previa y van aparte; las de constancia sin medir (pendiente o
  // ilegible) tampoco entran en el denominador. Tokens y duración sólo de las que los midieron: un null nunca es 0.
  function revisionPrevia(F) {
    var viejas = 0, porHistoria = {};
    F.forEach(function (c) {
      var r = c.revision_previa;
      if (!r || !r.estado || r.estado === 'sin_campo') { viejas += 1; return; }
      var k = c.story !== null && c.story !== undefined ? 'h:' + JSON.stringify([c.producto || null, c.story]) : 'c:' + c.id;
      var antes = porHistoria[k];
      if (!antes || String(c.inicio || '') > String(antes.inicio || '')) porHistoria[k] = { inicio: c.inicio, r: r };
    });
    var rs = Object.keys(porHistoria).map(function (k) { return porHistoria[k].r; });
    var de = function (e) { return rs.filter(function (r) { return r.estado === e; }); };
    var rev = de('revisada'), salt = de('saltada').length, sinRev = de('sin_revision').length, noMed = de('no_medido').length;
    var conocidas = rev.length + salt + sinRev;
    var b = function (n) { return '<b>' + n + '</b> '; };
    var aparte = (salt ? ' · ' + b(salt) + T('rpSaltadas') : '') + (sinRev ? ' · ' + b(sinRev) + T('rpSinRevision') : '')
      + (noMed ? ' · ' + b(noMed) + T('rpNoMedidas') : '') + (viejas ? ' · ' + b(viejas) + T('rpAnteriores') : '');
    if (!conocidas) return gris(T('rpSinDatoFiltro') + aparte.replace(/<\/?b>/g, '').replace(/^ · /, ': '));
    var seg = function (ms) { return ms < 90000 ? Math.round(ms / 1000) + ' s' : dt(ms / 60000); };
    var tk = rev.filter(function (r) { return num(r.tokens); }).map(function (r) { return r.tokens; });
    var du = rev.filter(function (r) { return num(r.duracion_ms); }).map(function (r) { return r.duracion_ms; });
    var costo = !rev.length ? T('rpSinCosto')
      : (tk.length ? b(miles(tk.reduce(function (a, x) { return a + x; }, 0))) + T('rpTokens', { m: miles(Math.round(mediana(tk))), n: tk.length, t: rev.length }) : T('rpSinTokens'))
        + ' · ' + (du.length ? T('rpDuracion') + ' ' + b(seg(mediana(du))).trim() + ' (n=' + du.length + ')' : T('rpSinDuracion'));
    var corregidas = rev.filter(function (r) { return r.corregida === true; }).length;
    return med(T('rpRevisadasDe', { n: rev.length, t: conocidas }), T('nEqDeEjecuciones', { n: F.length - viejas, t: F.length }), {
      detalle: b(corregidas) + T('rpCorregidas') + ' · ' + costo + aparte });
  }

  function resumen(F) {
    var N = F.length;
    // story 2.27 (AC 11): quien todavía no tiene corridas en el buzón no ve «0 corridas» como una medida
    if (!C.length && M.vacio_motivo) return ficha(T('todaviaNo'), gris(M.vacio_motivo));
    if (!N) return ficha(T('filtroVacio'), gris(M.registro.estado !== 'medido' && M.registro.motivo ? M.registro.motivo : T('filtroVacioMotivo')));
    var dur = F.filter(function (c) { return c.dur_ms; });
    var fin = F.filter(function (c) { return c.llego_al_final; });
    var gz = F.filter(function (c) { return c.controles; });
    var roj = gz.filter(function (c) { return c.controles.error > 0; });
    // las tres partes no se superponen: sólo con error, sólo frenadas y con las dos
    var ambas = roj.filter(function (c) { return c.controles.freno > 0; }).length;
    var soloFre = gz.filter(function (c) { return c.controles.freno > 0; }).length - ambas;
    var cc = F.filter(function (c) { return c.costo; });
    var ag = cc.map(function (c) { return c.costo.agentes; });
    var vu = cc.filter(function (c) { return c.costo.vueltas !== null; }).map(function (c) { return c.costo.vueltas; });
    var cs = F.filter(function (c) { return c.consumo.estado === 'medido'; });
    var tk = cs.map(tokensDe);
    // story 7.12: los pasos (respuestas del modelo) de las corridas que los MIDIERON. El mismo criterio que
    // scripts/metrics/steps-per-run.js: consumo medido y un número positivo; lo demás se cuenta aparte.
    var pa = F.filter(pasosMedidos).map(function (c) { return c.consumo.respuestas; });
    var pf = fin.length / N;
    // story 2.7: trabajo y espera, sólo de las corridas que los MIDIERON (n= lo dice); las anteriores a
    // la marca de arranque no aportan: mezclarlas pondría tiempo muerto dentro del trabajo.
    var tMed = F.filter(function (c) { return c.tiempos && c.tiempos.trabajo_ms !== null && c.tiempos.trabajo_medido; });
    var eMed = F.filter(function (c) { return c.tiempos && c.tiempos.espera_humana_ms !== null; });
    // Las corridas sin la espera de los pasos medida pero con espera en su conversación dan un PISO: va en una
    // línea aparte, nunca adentro de la mediana (lo medido y lo estimado no se suman en el mismo número).
    var ePiso = F.filter(function (c) { return c.tiempos && c.tiempos.espera_humana_ms === null && c.tiempos.espera_del_hilo_ms; });
    var pisoEspera = ePiso.length ? '. <b>' + T('aparte') + '</b>' + T('pisoTexto', { n: ePiso.length }) + ' <b>' + T('alMenos', { d: dt(mediana(ePiso.map(function (c) { return c.tiempos.espera_del_hilo_ms; })) / 60000) }) + '</b> ' + T('pisoResto') : '';
    // story 2.27: sin las conversaciones (un sitio sin disco), la espera leída del hilo no se midió: se dice, no es cero
    var sinHilo = M.sin_hilos ? '. ' + T('esperaLeida') + ' <b>' + esc(M.sin_hilos) + '</b>' : '';
    pisoEspera += sinHilo;
    var sinArranque = T('sinArranque');
    // story 7.3: el validador de stories por fase. Denominador = los lanzamientos que DEJARON veredicto
    // (limpio, con hallazgos o inconsistente); los sin veredicto y los que no volvieron (no_medido) se
    // cuentan aparte, nunca como limpios ni en silencio (pase adversarial 2026-09-17: los que no volvieron
    // desaparecían de todo número mientras la tarjeta de la corrida sí los decía).
    var val = F.filter(function (c) { return c.validador && c.validador.estado === 'medido'; });
    var porFaseVal = {}; FASES_VAL.forEach(function (p) { porFaseVal[p[0]] = { con: 0, hal: 0 }; });
    var sinVer = 0, sinRes = 0, relSin = 0, relDec = 0;
    F.forEach(function (c) { if (c.validador) { relSin += c.validador.re_loops_sin_relanzar || 0; relDec += c.validador.re_loops_decididos || 0; } });
    val.forEach(function (c) {
      FASES_VAL.forEach(function (p) {
        var x = c.validador.por_fase[p[0]];
        porFaseVal[p[0]].con += x.limpio + x.hallazgos + x.inconsistente;
        porFaseVal[p[0]].hal += x.hallazgos;
        sinVer += x.sin_veredicto;
        sinRes += x.no_medido;
      });
    });
    var conVer = 0, halVer = 0;
    FASES_VAL.forEach(function (p) { conVer += porFaseVal[p[0]].con; halVer += porFaseVal[p[0]].hal; });
    var aparte = function (b) {
      return (sinVer ? ' · ' + b(sinVer) + ' ' + T('lanzSinVeredicto') : '')
        + (sinRes ? ' · ' + b(sinRes) + ' ' + T('lanzSinResultado') : '')
        + (relDec ? T('valNoRelanzado', { n: relSin, t: relDec }) : '');
    };
    var fichaValidador = conVer
      ? med(T('conHallazgosDe', { h: halVer, t: conVer }), T('nConVeredicto', { n: val.length, t: N }), {
        detalle: FASES_VAL.filter(function (p) { return porFaseVal[p[0]].con; }).map(function (p) { return esc(p[1]) + ' ' + T('nDe', { n: porFaseVal[p[0]].hal, t: porFaseVal[p[0]].con }); }).join(' · ')
          + aparte(function (n) { return '<b>' + n + '</b>'; }) })
      : gris(T('sinVeredictoFiltro') + aparte(function (n) { return n; }).replace(/^ · /, ': '));
    var fichaRevisionPrevia = revisionPrevia(F);
    // «encontró un error» es el control funcionando (lo dice la misma ficha): se informa sin semáforo, que la pintaría de
    // rojo justo cuando los controles más trabajan
    return [
      ficha(T('fAlFinal'), med(Math.round(pf * 100) + '%', T('nDeEjecuciones', { n: fin.length, t: N }), { est: juzgar('corridas_al_final', pf).est, palabra: juzgar('corridas_al_final', pf).palabra, detalle: '<b>' + (N - fin.length) + '</b> ' + T('aMitad') + (juzgar('corridas_al_final', pf).nota ? ' · <b>' + esc(juzgar('corridas_al_final', pf).nota) + '</b>' : '') })),
      ficha(T('fDuracion'), dur.length ? med(n1(mediana(dur.map(function (c) { return c.dur_ms; })) / 3600000) + ' h', T('nEqDeEjecuciones', { n: dur.length, t: N }), { detalle: T('laMasLarga', { d: n1(Math.max.apply(null, dur.map(function (c) { return c.dur_ms; })) / 3600000) + ' h' }) }) : gris(T('sinDuracionFiltro'))),
      ficha(T('fConError'), gz.length ? med(Math.round((roj.length / gz.length) * 100) + '%', T('nDeConControles', { n: roj.length, t: gz.length }), { est: 'neutro', palabra: T('medido'), detalle: T('errorDetalle', { e: '<b>' + (roj.length - ambas) + '</b>', f: '<b>' + soloFre + '</b>', k: '<b>' + ambas + '</b>' }) + (N - gz.length ? ' ' + T('noRegistraronControles', { n: N - gz.length }) : '') }) : gris(T('sinControlesFiltro'))),
      ficha(T('fAgentes'), ag.length ? med(String(mediana(ag)), T('nEqDeEjecuciones', { n: ag.length, t: N }), { detalle: T('maximo', { n: Math.max.apply(null, ag) }) + ' · ' + T('noLoRegistran', { n: N - ag.length }) }) : gris(T('sinAgentesFiltro'))),
      ficha(T('fVueltas'), vu.length ? med(String(mediana(vu)), T('nEqDeEjecuciones', { n: vu.length, t: N }), { detalle: T('maximo', { n: Math.max.apply(null, vu) }) + ' · ' + T('vueltasDetalle') }) : gris(T('sinVueltasFiltro'))),
      ficha(T('fValidador'), fichaValidador),
      ficha(T('fRevisionPrevia'), fichaRevisionPrevia),
      ficha(T('fTrabajo'), tMed.length ? med(dt(mediana(tMed.map(function (c) { return c.tiempos.trabajo_ms; })) / 60000), T('nEqDeEjecuciones', { n: tMed.length, t: N }), { detalle: T('trabajoDetalle') + (M.sin_hilos ? ' (' + T('incluyeEsperas') + ' ' + esc(M.sin_hilos) + ')' : '') }) : gris(sinArranque + sinHilo)),
      ficha(T('fEspera'), eMed.length ? med(dt(mediana(eMed.map(function (c) { return c.tiempos.espera_humana_ms; })) / 60000), T('nEqDeEjecuciones', { n: eMed.length, t: N }), { detalle: T('esperaDefinicion') + pisoEspera }) : gris(sinArranque + pisoEspera)),
      ficha(T('fPasos'), pa.length ? med(String(Math.round(mediana(pa))), T('nEqDeEjecuciones', { n: pa.length, t: N }), { detalle: (N - pa.length ? '<b>' + (N - pa.length) + '</b> ' + T('pasosSinMedir') + ' ' : '') + T('tokensConsecuencia') + (LB ? ' ' + T('lineaBaseDelFicha', { f: esc(LB.fecha) }) + ' <b>' + LB.mediana + '</b>' + (LB.corridas ? ' (n=' + LB.corridas + ')' : '') + '.' : ' <b>' + sinLB + '</b>.') }) : gris(T('sinPasosFiltro'))),
      ficha(T('fTokens'), tk.length ? med(miles(Math.round(mediana(tk))), T('nEqDeEjecuciones', { n: tk.length, t: N }), { detalle: T('deOtras') + ' <b>' + (N - tk.length) + '</b> ' + T('sinConsumoDetalle') }) : gris(T('sinConsumoFiltro')))
    ].join('');
  }

  // La semana de cada ejecución sale de su día LOCAL, como el filtro: el domingo 22 h de Argentina ya es lunes en UTC, y la
  // barra de «esta semana» tiene que dar lo mismo que el atajo. El día local se lleva a medianoche UTC para la cuenta ISO.
  var diaComoUtc = function (iso) { var d = new Date(iso); return isNaN(d.getTime()) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); };
  var lunesDe = function (t) { var x = new Date(t.getTime()); var dn = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() - dn + 1); return x; };
  var semanaDe = function (t) { var x = new Date(t.getTime()); var dn = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - dn); var a0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1)); return x.getUTCFullYear() + '-S' + String(Math.ceil(((x - a0) / 86400000 + 1) / 7)).padStart(2, '0'); };
  var semanaLocal = function (c) { var t = c.inicio ? diaComoUtc(c.inicio) : null; return t ? semanaDe(t) : null; };
  // la semana como se ve, con la letra del idioma; la clave («2026-S44») no cambia
  var semanaVisible = function (k) { return k.slice(0, 5) + T('letraSemana') + k.slice(6); };
  // Todas las semanas del rango, aunque valgan 0: una barra ausente y una en cero no son lo mismo.
  function semanasDelRango(F) {
    var dias = F.map(function (c) { return c.inicio ? diaComoUtc(c.inicio) : null; }).filter(Boolean).sort(function (a, b) { return a - b; });
    if (!dias.length) return [];
    var ks = [], t = lunesDe(dias[0]), fin = lunesDe(dias[dias.length - 1]);
    while (t <= fin && ks.length < 400) { ks.push(semanaDe(t)); t.setUTCDate(t.getUTCDate() + 7); }
    return ks;
  }
  function graficoSemanas(F) {
    var porSem = {};
    F.forEach(function (c) { var s = semanaLocal(c); if (s) porSem[s] = (porSem[s] || 0) + 1; });
    var ks = semanasDelRango(F);
    if (!ks.length) return '<p class="tlnota">' + T('sinEjecucionesFiltro') + '</p>';
    var max = Math.max.apply(null, [1].concat(ks.map(function (k) { return porSem[k] || 0; })));
    var W = 720, H = 190, x0 = 34, x1 = 706, base = 148, top = 16, paso = (x1 - x0) / ks.length;
    var Y = function (v) { return base - (v / max) * (base - top); };
    var s2 = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px;min-width:520px;display:block" role="img" aria-label="' + T('ariaSemanas') + '">';
    [0, Math.round(max / 2), max].forEach(function (t) {
      s2 += '<line x1="' + x0 + '" y1="' + Y(t) + '" x2="' + x1 + '" y2="' + Y(t) + '" stroke="var(--line)"></line><text x="' + (x0 - 7) + '" y="' + (Y(t) + 4) + '" text-anchor="end" font-family="IBM Plex Mono,monospace" font-size="10.5" fill="var(--ink-3)">' + t + '</text>';
    });
    ks.forEach(function (k, i) {
      var n = porSem[k] || 0, cx = x0 + paso * i + paso / 2, bw = Math.min(30, paso * 0.62);
      s2 += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + Y(n).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, base - Y(n)).toFixed(1) + '" fill="' + (n ? 'var(--accent)' : 'var(--line-strong)') + '" rx="2"><title>' + semanaVisible(k) + ': ' + T('nEjecuciones', { n: n }) + '</title></rect>'
        + '<text x="' + cx.toFixed(1) + '" y="' + (Y(n) - 5).toFixed(1) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="10.5" fill="var(--ink)">' + n + '</text>'
        + (ks.length <= 26 || i % 2 === 0 ? '<text x="' + cx.toFixed(1) + '" y="166" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="9.5" fill="var(--ink-3)">' + semanaVisible(k).slice(5) + '</text>' : '');
    });
    return s2 + '<text x="' + x0 + '" y="182" font-family="IBM Plex Sans,sans-serif" font-size="11" fill="var(--ink-3)">' + T('semanaIso') + ' · ' + ks[0].slice(0, 4) + ' → ' + ks[ks.length - 1].slice(0, 4) + '</text></svg>';
  }

  // Un tramo fusionado (5+6) no da un valor a ninguno de los dos pasos: se declara aparte.
  function porPaso(F, valorDe, fmt, universo, fusionados) {
    var filas = [];
    for (var i = 0; i < PASOS.length; i++) {
      var vs = F.map(function (c) { return valorDe(c, i); }).filter(function (v) { return isFinite(v) && v > 0; });
      filas.push({ i: i, v: vs.length ? mediana(vs) : null, n: vs.length });
    }
    var max = Math.max.apply(null, [1].concat(filas.map(function (f) { return f.v || 0; })));
    return '<div class="pasos">' + filas.map(function (f) {
      return '<div class="pfila' + (f.v === null ? ' sinDato' : '') + '"><span class="pn">' + esc(PASOS[f.i]) + '</span>'
        + '<span class="pb">' + (f.v === null ? '<i class="hatch" style="width:100%"></i>' : '<i style="width:' + Math.max(1.5, (f.v / max) * 100).toFixed(1) + '%;background:' + RAMPA[f.i] + '"></i>') + '</span>'
        + '<span class="pv">' + (f.v === null ? T('sinDato') : fmt(f.v)) + '</span><span class="pnn">n=' + T('nDe', { n: f.n, t: universo }) + '</span></div>';
    }).join('') + (fusionados ? '<p class="tlnota">' + T('fusionadosNota', { n: fusionados }) + '</p>' : '') + '</div>';
  }

  // ─── el filtro ───
  var $ = function (id) { return document.getElementById(id); };
  var elMaq = (M.varias_maquinas !== undefined ? M.varias_maquinas : M.multi) ? $('f-maquina') : null;
  var maqDe = function (c) { return c.maquina || '(' + T('sinDeclarar') + ')'; };
  var elDesde = $('f-desde'), elHasta = $('f-hasta'), elRepo = $('f-repo'), elFc = $('fc'), elFf = $('ff'), elCuenta = $('cuenta'), elLimpiar = $('f-limpiar'), cuerpo = $('cuerpo');
  // La fecha de una corrida es la del navegador de quien mira, no la UTC: a las 22 h de Argentina, «hoy» ya es mañana en UTC.
  var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
  var ymd = function (d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
  var diaLocal = function (iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d.getTime()) ? '' : ymd(d); };
  var fechas = C.map(function (c) { return diaLocal(c.inicio); }).filter(Boolean).sort();
  var RANGO = [fechas[0] || '', fechas[fechas.length - 1] || ''];
  // la columna de la fecha, también en la del navegador: la tabla y el filtro dicen el mismo día (llega en UTC)
  for (var fi = 0; fi < cuerpo.rows.length; fi++) {
    var fr = cuerpo.rows[fi], fk = fr.classList.contains('fila-det') ? null : enC(fr);
    var fd = fk !== null && C[fk] ? diaLocal(C[fk].inicio) : '', ftd = fd ? fr.querySelector('td.fecha') : null;
    if (ftd && ftd.firstChild && ftd.firstChild.nodeType === 3) ftd.firstChild.nodeValue = fd;
  }
  var cuentaRepo = {};
  // Los combos van en orden alfabético (sin distinguir mayúsculas): se busca un nombre, no un ranking. Lo «sin…», al final.
  var alfabetico = function (a, b) { var sa = a.charAt(0) === '(' || a.indexOf('sin ') === 0, sb = b.charAt(0) === '(' || b.indexOf('sin ') === 0; return (sa - sb) || a.localeCompare(b, 'es', { sensitivity: 'base' }); };
  // Un grupo por producto, después los repos sin producto conocido y al final el laboratorio. El valor es el repo, como
  // siempre (los enlaces guardados siguen andando); el del laboratorio lleva «laboratorio/» adelante, para no juntarse
  // con el repo de verdad del mismo nombre.
  // Sin producto hay UNA opción, en «otros repos», venga del laboratorio o no. El mismo producto escrito con otra mayúscula
  // es una sola opción (gana la forma más usada). Una opción del laboratorio dice que lo es: así ninguna etiqueta se repite.
  var SIN_PRODUCTO = '(' + T('sinProducto') + ')';
  var formaDe = {};
  (function () {
    var usos = {};
    C.forEach(function (c) { if (c.producto) usos[c.producto] = (usos[c.producto] || 0) + 1; });
    var mejor = {};
    Object.keys(usos).forEach(function (p) { var k = p.toLowerCase(); if (!(k in mejor) || usos[p] > usos[mejor[k]] || (usos[p] === usos[mejor[k]] && p < mejor[k])) mejor[k] = p; });
    Object.keys(usos).forEach(function (p) { formaDe[p] = mejor[p.toLowerCase()]; });
  })();
  var claveRepo = function (c) { return !c.producto ? SIN_PRODUCTO : (c.grupo === 'laboratorio' ? 'laboratorio/' : '') + formaDe[c.producto]; };
  var grupoRepo = {}, reposDeGrupo = {};
  C.forEach(function (c) {
    var k = claveRepo(c), g = c.producto ? c.grupo || '' : '';
    cuentaRepo[k] = (cuentaRepo[k] || 0) + 1;
    if (!(k in grupoRepo)) { grupoRepo[k] = g; (reposDeGrupo[g] = reposDeGrupo[g] || []).push(k); }
  });
  var ordenGrupo = function (a, b) { var pa = a === 'laboratorio' ? 2 : a === '' ? 1 : 0, pb = b === 'laboratorio' ? 2 : b === '' ? 1 : 0; return (pa - pb) || alfabetico(a, b); };
  var cuentaMaq = {};
  if (elMaq) C.forEach(function (c) { cuentaMaq[maqDe(c)] = (cuentaMaq[maqDe(c)] || 0) + 1; });
  // Los conteos de los desplegables siguen el filtro de fechas (no el de producto ni el de máquina): «todos (N)» es lo que
  // hay en esas fechas. Se rearman en cada aplicar(), con la elección de la persona intacta.
  function rotularDesplegables(enFechas) {
    var nRepo = {}, nMaq = {};
    enFechas.forEach(function (c) { var k = claveRepo(c); nRepo[k] = (nRepo[k] || 0) + 1; if (elMaq) nMaq[maqDe(c)] = (nMaq[maqDe(c)] || 0) + 1; });
    var opcion = function (k) {
      var etiqueta = k === SIN_PRODUCTO ? k : k.indexOf('laboratorio/') === 0 ? rotulo(k.slice(12)) + ' (' + T('laboratorio') + ')' : rotulo(k);
      return '<option value="' + esc(k) + '">' + esc(etiqueta) + ' (' + (nRepo[k] || 0) + ')</option>';
    };
    var elegido = elRepo.value;
    elRepo.innerHTML = '<option value="">' + T('todos', { n: enFechas.length }) + '</option>' + Object.keys(reposDeGrupo).sort(ordenGrupo).map(function (g) {
      var etiqueta = g === 'laboratorio' ? T('laboratorio') : g === '' ? T('otrosRepos') : g;
      return '<optgroup label="' + esc(etiqueta) + '">' + reposDeGrupo[g].sort(alfabetico).map(opcion).join('') + '</optgroup>';
    }).join('');
    elRepo.value = elegido;
    if (elMaq) {
      var maq = elMaq.value;
      elMaq.innerHTML = '<option value="">' + T('todas', { n: enFechas.length }) + '</option>' + Object.keys(cuentaMaq).sort(alfabetico).map(function (r) { return '<option value="' + esc(r) + '">' + esc(r) + ' (' + (nMaq[r] || 0) + ')</option>'; }).join('');
      elMaq.value = maq;
    }
  }
  rotularDesplegables(C);
  elDesde.min = elHasta.min = RANGO[0]; elDesde.max = elHasta.max = RANGO[1]; elDesde.value = RANGO[0]; elHasta.value = RANGO[1];

  // '?solo=N': la ficha de UNA corrida — se esconden las otras filas y la capa ejecutiva (que con una
  // sola corrida no dice nada), y el detalle queda abierto arriba. Sirve de permalink y es lo que
  // permite fotografiar un detalle en Chrome headless, donde desplazar la página deja la captura en blanco.
  var qs = (typeof location !== 'undefined' && location.search) || '';
  // story 2.27: el enlace nombra la corrida por su id estable (16 hexadecimales); en la página local vale también el
  // índice de siempre. En el sitio, no: con el filtro de cada persona, el índice es otra corrida.
  var filaDe = function (v) {
    if (v == null) return null;
    if (/^[0-9a-f]{16}$/.test(v)) { for (var k = 0; k < C.length; k++) if (C[k].id === v) return k; return null; }
    return FUENTE.forma === 'embebida' && /^\d+$/.test(v) && Number(v) < C.length ? Number(v) : null;
  };
  var leer = function (nombre) { var m = qs.match(new RegExp('[?&]' + nombre + '=([^&]+)')); return m ? m[1] : null; };
  var numero = function (nombre) { var v = leer(nombre); return v !== null && /^\d+$/.test(v) ? Number(v) : null; };
  var SOLO = filaDe(leer('solo'));
  var ENLACE = { abrir: SOLO !== null ? SOLO : filaDe(leer('abrir')), ver: numero('ver'), git: numero('git'), solo: SOLO, maquina: null };
  // '?maquina=<nombre>' deja el filtro por máquina puesto al cargar (story 2.16): el mismo permalink
  // que '?solo=N', y lo que permite fotografiar el filtro aplicado sin un clic.
  // '?desde=&hasta=&producto=&maquina=': lo que no sirve —una fecha que no existe, un producto o una máquina
  // que no aparecen— se ignora y ese filtro queda en «todos». El filtro cambia la dirección sin recargar (escribirDireccion).
  var param = function (nombre) { var v = leer(nombre); if (v === null) return null; try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { return null; } };
  var fechaValida = function (v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(new Date(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10))) === v; };
  var esta = function (cuenta, v) { return v !== null && Object.prototype.hasOwnProperty.call(cuenta, v); };
  var qDesde = param('desde'), qHasta = param('hasta'), qRepo = param('producto'), qMaq = param('maquina');
  // Una fecha que puso la persona (a mano, con un atajo o desde la dirección) se escribe siempre, aunque coincida con el
  // rango: el enlace compartido tiene que mostrar lo mismo mañana, cuando el rango ya creció.
  var FIJADA = { desde: false, hasta: false };
  if (fechaValida(qDesde)) { elDesde.value = qDesde; FIJADA.desde = true; }
  if (fechaValida(qHasta)) { elHasta.value = qHasta; FIJADA.hasta = true; }
  // un enlace guardado a un repo que ahora es del laboratorio lo sigue mostrando
  if (esta(cuentaRepo, qRepo)) elRepo.value = qRepo;
  else if (qRepo && esta(cuentaRepo, 'laboratorio/' + qRepo)) elRepo.value = 'laboratorio/' + qRepo;
  if (elMaq && esta(cuentaMaq, qMaq)) elMaq.value = ENLACE.maquina = qMaq;
  if (typeof window !== 'undefined') window.__enlace = function () { return ENLACE; };
  if (SOLO !== null && typeof document !== 'undefined' && document.body && document.body.classList) document.body.classList.add('solo');
  function enFechas(c) {
    var f = diaLocal(c.inicio);
    return !(elDesde.value && f && f < elDesde.value) && !(elHasta.value && f && f > elHasta.value);
  }
  function pasa(c) {
    if (SOLO !== null && C.indexOf(c) !== SOLO) return false;
    if (!enFechas(c)) return false;
    if (elRepo.value && claveRepo(c) !== elRepo.value) return false;
    if (elMaq && elMaq.value && maqDe(c) !== elMaq.value) return false;
    if (elFc.checked && c.consumo.estado !== 'medido') return false;
    if (elFf.checked && !c.llego_al_final) return false;
    return true;
  }
  function aplicar() {
    rotularDesplegables(C.filter(enFechas));
    var F = C.filter(pasa);
    $('fichas').innerHTML = resumen(F);
    $('gsem').innerHTML = graficoSemanas(F);
    $('gpasos').innerHTML = graficoPasos(F);
    var fus = F.filter(function (c) { return c.tramos.some(function (t) { return t.pasos.length > 1; }); }).length;
    // dos tramos de la misma fila (el 6 y el 7 viejos caen los dos en Hallazgos) se suman
    var tramoDe = function (c, i) { var ts = c.tramos.filter(function (x) { return !x.subpaso && x.pasos.length === 1 && x.pasos[0] === i; }); return ts.length ? ts.reduce(function (a, t) { return a + t.ms; }, 0) / 60000 : null; };
    $('ppt').innerHTML = porPaso(F, tramoDe, function (v) { return n1(v) + ' min'; }, F.length, fus);
    var cs = F.filter(function (c) { return c.consumo.estado === 'medido'; });
    // Los tokens de un tramo fusionado ('5+6') no son de ningún paso: se DECLARAN, como en el de tiempo
    // (pase adversarial 2.14: el 95 % del consumo de una corrida desaparecía sin nota).
    var fusK = cs.filter(function (c) { return Object.keys(c.consumo.por_paso).some(function (k) { return k.indexOf('+') >= 0; }); }).length;
    $('ppk').innerHTML = porPaso(cs, function (c, i) { return c.consumo.por_paso[String(i)]; }, function (v) { return miles(Math.round(v)); }, cs.length, fusK);
    var dentro = 0, fuera = 0;
    cs.forEach(function (c) { fuera += c.consumo.fuera_de_ventana; Object.keys(c.consumo.por_paso).forEach(function (k) { dentro += c.consumo.por_paso[k]; }); });
    $('nota-tokens').innerHTML = cs.length
      ? T('notaTokens1') + ' <b>' + cs.length + '</b> ' + T('notaTokens2') + ' <b>' + T('notaTokens3', { p: n1((fuera / Math.max(1, fuera + dentro)) * 100) }) + '</b> ' + T('notaTokens4')
      : T('notaTokensSin1') + ' <b>' + T('notaTokensSin2') + '</b>.';
    var n = 0;
    for (var i = 0; i < cuerpo.rows.length; i++) {
      var tr = cuerpo.rows[i];
      if (tr.classList.contains('fila-det')) { tr.hidden = tr.previousElementSibling.hidden; continue; }
      var k = enC(tr), ok = k !== null && pasa(C[k]); tr.hidden = !ok; if (ok) n++;
    }
    var molde = (elCuenta.dataset && elCuenta.dataset.molde) || T('cuentaMolde');
    elCuenta.textContent = molde.replace('{n}', n).replace('{t}', C.length);
  }
  // Escribe en la dirección los filtros que difieren de su valor por defecto; lo demás (solo, abrir, ver, git) queda como estaba.
  function escribirDireccion() {
    if (typeof history === 'undefined' || !history || typeof history.replaceState !== 'function' || typeof location === 'undefined') return;
    var resto = qs.replace(/^\?/, '').split('&').filter(function (x) { return x && !/^(desde|hasta|producto|maquina)=/.test(x); });
    if (elDesde.value && (FIJADA.desde || elDesde.value !== RANGO[0])) resto.push('desde=' + encodeURIComponent(elDesde.value));
    if (elHasta.value && (FIJADA.hasta || elHasta.value !== RANGO[1])) resto.push('hasta=' + encodeURIComponent(elHasta.value));
    if (elRepo.value) resto.push('producto=' + encodeURIComponent(elRepo.value));
    if (elMaq && elMaq.value) resto.push('maquina=' + encodeURIComponent(elMaq.value));
    try { history.replaceState(null, '', (location.pathname || '') + (resto.length ? '?' + resto.join('&') : '') + (location.hash || '')); } catch (e) { /* sin historial, el filtro sigue andando */ }
  }
  function alCambiar() { aplicar(); escribirDireccion(); }
  // Los atajos llenan desde y hasta con la fecha local: hoy; esta semana, del lunes a hoy; este mes, del día 1 a hoy.
  function atajo(nombre) {
    var h = new Date(), fin = ymd(h), ini = fin;
    if (nombre === 'semana') ini = ymd(new Date(h.getFullYear(), h.getMonth(), h.getDate() - ((h.getDay() + 6) % 7)));
    else if (nombre === 'mes') ini = fin.slice(0, 8) + '01';
    elDesde.value = ini; elHasta.value = fin; FIJADA.desde = FIJADA.hasta = true; alCambiar();
  }
  function limpiar() { FIJADA.desde = FIJADA.hasta = false; elDesde.value = RANGO[0]; elHasta.value = RANGO[1]; elRepo.value = ''; if (elMaq) elMaq.value = ''; elFc.checked = false; elFf.checked = false; alCambiar(); }
  if (typeof window !== 'undefined') { window.__aplicar = alCambiar; window.__atajo = atajo; window.__limpiar = limpiar; }
  elDesde.addEventListener('change', function () { FIJADA.desde = true; });
  elHasta.addEventListener('change', function () { FIJADA.hasta = true; });
  [elDesde, elHasta, elRepo, elFc, elFf].concat(elMaq ? [elMaq] : []).forEach(function (el) { el.addEventListener('change', alCambiar); });
  [['f-hoy', 'hoy'], ['f-semana', 'semana'], ['f-mes', 'mes']].forEach(function (b) { var bt = $(b[0]); if (bt) bt.addEventListener('click', function () { atajo(b[1]); }); });
  elLimpiar.onclick = limpiar;
  aplicar();

  // ─── abrir / cerrar el detalle ───
  // story 2.27: el detalle llega de la FUENTE (enseguida si está embebido; del sitio, al pedirlo). El turno hace que,
  // con dos clics seguidos, sólo se abra el último: nunca dos detalles abiertos.
  var turno = 0;
  var ESPERA_LARGA_MS = 3000;
  function cerrarAbierta() { var abierta = cuerpo.querySelector('.fila-det'); if (abierta) { abierta.previousElementSibling.classList.remove('abierta'); abierta.remove(); } }
  function abrir(tr, alAbrir) {
    var sig = tr.nextElementSibling;
    if (sig && sig.classList.contains('fila-det')) { sig.remove(); tr.classList.remove('abierta'); turno += 1; return; }
    var i = enC(tr); if (i === null) return;
    var mio = ++turno;
    // del sitio, el detalle de una corrida que nunca se abrió se pide en ese momento: la fila lo dice enseguida, y si la
    // espera pasa de unos segundos, lo dice también; cuando llega el detalle, ocupa su lugar
    if (FUENTE.forma === 'red' && !FUENTE.cargado(i)) {
      cerrarAbierta();
      var espera = document.createElement('tr'); espera.className = 'fila-det';
      espera.innerHTML = '<td colspan="' + tr.children.length + '"><span class="nd" role="status">' + T('bajando') + '</span></td>';
      tr.after(espera); tr.classList.add('abierta');
      setTimeout(function () { var n = espera.querySelector('.nd'); if (mio === turno && espera.parentNode && n) n.textContent = T('sigueBajando'); }, ESPERA_LARGA_MS);
    }
    FUENTE.detalle(i, function (c) {
      if (mio !== turno) return;
      cerrarAbierta();
      var fila = document.createElement('tr'); fila.className = 'fila-det';
      fila.innerHTML = '<td colspan="' + tr.children.length + '">' + detalle(c, i) + '</td>';
      tr.after(fila); tr.classList.add('abierta');
      fila.querySelector('.cerrar').onclick = function () { fila.remove(); tr.classList.remove('abierta'); };
      fila.querySelectorAll('details[data-cz]').forEach(function (d) { d.addEventListener('toggle', function () { if (d.open) pintarCambio(d); }); });
      fila.querySelectorAll('details[data-cg]').forEach(function (d) { d.addEventListener('toggle', function () { if (d.open) pintarGit(d); }); });
      fila.querySelectorAll('.cg-f').forEach(function (b) { b.addEventListener('click', function () { filtrarPorArchivo(fila, c, +b.dataset.g); }); });
      fila.querySelectorAll('.tokbar').forEach(function (g) { g.addEventListener('click', function () { enQueSeFue(fila, c, +g.dataset.desde, +g.dataset.hasta); }); });
      fila.querySelectorAll('.balde').forEach(function (g) { g.addEventListener('click', function () { filtrarCambios(fila, +g.dataset.desde, +g.dataset.hasta); }); });
      if (alAbrir) alAbrir(fila);
    }, function (err) {
      if (mio !== turno) return;
      cerrarAbierta();
      var fila = document.createElement('tr'); fila.className = 'fila-det';
      fila.innerHTML = '<td colspan="' + tr.children.length + '"><span class="nd">' + (err.alDibujar ? '' : T('sinDetalle') + ' ') + esc(err.message) + '</span></td>';
      tr.after(fila); tr.classList.add('abierta');
    });
  }
  if (typeof window !== 'undefined') window.__abrirFila = function (tr) { abrir(tr); };
  cuerpo.addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr'); if (!tr || !tr.dataset.i) return;
    abrir(tr, function (fila) { fila.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  });
  // la tarjeta del celular nombra cada dato con su columna; la sombra de la derecha avisa que la tabla sigue
  var cajaTabla = document.querySelectorAll('.tabla')[0];
  if (cajaTabla) {
    var cabeceras = cajaTabla.querySelectorAll('thead th');
    cajaTabla.querySelectorAll('tbody tr[data-i]').forEach(function (tr) {
      Array.prototype.forEach.call(tr.cells, function (td, k) { if (cabeceras[k]) td.setAttribute('data-col', cabeceras[k].childNodes[0].textContent.trim()); });
    });
    var marcarSigue = function () { cajaTabla.parentElement.classList.toggle('sigue', cajaTabla.scrollLeft + cajaTabla.clientWidth < cajaTabla.scrollWidth - 1); };
    marcarSigue();
    cajaTabla.addEventListener('scroll', marcarSigue);
    window.addEventListener('resize', marcarSigue);
    // la tabla se ensancha después (las letras llegan tarde, el filtro muestra filas): se vuelve a mirar
    window.addEventListener('load', marcarSigue);
    if (typeof ResizeObserver === 'function') { var mira = new ResizeObserver(marcarSigue); mira.observe(cajaTabla); mira.observe(cajaTabla.querySelector('table')); }
  }
  // '?abrir=<id>' abre el detalle de esa corrida al cargar: es lo que permite fotografiarlo sin un clic (con '?solo=<id>'
  // queda arriba de todo). En la página local vale también el índice de la fila.
  if (ENLACE.abrir !== null && cuerpo.rows && cuerpo.rows.length) {
    var fila0 = C[ENLACE.abrir].id ? cuerpo.querySelector('tr[data-id="' + C[ENLACE.abrir].id + '"]') : cuerpo.querySelector('tr[data-i="' + ENLACE.abrir + '"]');
    if (fila0) abrir(fila0, function (fd) {
      // '&ver=K' abre además el cambio K de esa corrida (para fotografiarlo).
      if (ENLACE.ver !== null) { var dk = fd.querySelector('details[data-k="' + ENLACE.ver + '"]'); if (dk) { dk.open = true; pintarCambio(dk); } }
      // '&git=A' abre el archivo A de git (story 2.19, para fotografiarlo).
      if (ENLACE.git !== null) { var dg = fd.querySelector('details[data-a="' + ENLACE.git + '"]'); if (dg) { dg.open = true; pintarGit(dg); } }
    });
  }
  }
})();`;
// el cliente con sus textos en castellano adentro: los usa cuando la página no trae el bloque #corridas-textos
const CLIENTE = CLIENTE_FUENTE.replace('/*TEXTOS_ES*/{}', () => JSON.stringify(textosDelCliente(ES)).replace(/</g, '\\u003c'));

// ───────────────────────────── main ─────────────────────────────

const RUNS_DEFAULT = path.join(stateDirOf(os.homedir()), 'timing-history');
const SALIDA_DEFAULT = path.join(stateDirOf(os.homedir()), 'runs-dashboard.html');

const BUZON_DEFAULT = path.join(stateDirOf(os.homedir()), 'corridas-buzon');

/**
 * De dónde sale la carpeta bajada del buzón: `--mailbox` explícito, o la carpeta por defecto
 * (`TYCON_MAILBOX_DIR` o ~/.claude/.tycon-pipeline/corridas-buzon) si existe — pero SÓLO si no se pasó
 * `--runs-dir`: una suite que fabrica su registro nunca lee la carpeta real de la máquina. `--local-only`
 * la apaga siempre (la página sale sólo con las corridas de esta máquina).
 * Una carpeta por defecto que no existe es «esta máquina no baja el buzón», no un error: la página sale
 * como siempre. Una pedida con `--mailbox` que no se puede leer se dice en la página.
 */
function buzonDeclarado(opts) {
  if (opts.soloLocal) return null;
  if (opts.buzon) return path.resolve(opts.buzon);
  if (opts.runsDir) return null;
  const dir = path.resolve(readEnv('TYCON_MAILBOX_DIR', { where: 'scripts/nightly/dashboard/runs.js' }) || BUZON_DEFAULT);
  // 🔴 Sólo «no existe» es «esta máquina no baja el buzón». Cualquier otro error (sin permiso, un enlace roto)
  //    entra igual en modo multi: leerRegistro lo dice con la banda gris, en vez de pintar «una sola máquina».
  try { fs.statSync(dir); return dir; }
  catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? null : dir; }
}

/**
 * La ruta como la resuelve el sistema de archivos al ESCRIBIR: componente por componente, siguiendo cada
 * symlink ANTES de aplicar el «..» siguiente. path.resolve pliega «lnk/..» como texto y llega a otro lugar
 * que el kernel. Lo que no existe se agrega tal cual. null = cadena de enlaces
 * que no termina.
 * 🔴 La raíz y el separador son los de la plataforma: partiendo sólo por '/', en Windows
 *    ninguna ruta caería «dentro del repo» y la negativa del escritor único no se dispararía. En POSIX una '\' es parte
 *    del nombre; en Windows vale cualquiera de las dos barras. `dep` existe para probar Windows desde otra máquina.
 */
function rutaComoLaEscribe(abs, saltos = 0, dep = { path, fs }) {
  if (saltos > 32) return null;
  const P = dep.path, F = dep.fs, sep = P.sep;
  const texto = String(abs);
  const raiz = P.parse(texto).root;
  const segs = texto.slice(raiz.length).split(sep === '\\' ? /[\\/]+/ : /\/+/);
  const unir = (a, b) => (a.endsWith(sep) ? `${a}${b}` : `${a}${sep}${b}`);
  let cur = raiz || sep;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s || s === '.') continue;
    if (s === '..') { cur = P.dirname(cur); continue; }
    const sig = unir(cur, s);
    let st = null;
    try { st = F.lstatSync(sig); }
    catch (e) {
      // Sólo «no existe» se agrega tal cual. Sin permiso, un bucle o un error de disco: no se sabe adónde
      // escribiría → null → se niega (el mismo criterio que buzonDeclarado).
      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return null;
    }
    if (st && st.isSymbolicLink()) {
      let destino;
      try { destino = F.readlinkSync(sig); } catch (_) { return null; }
      const resto = segs.slice(i + 1).filter((x) => x).join(sep);
      const base = P.isAbsolute(destino) ? destino : unir(cur, destino);
      // Concatenado como texto, nunca path.join: join plegaría el «..» del resto antes de seguir el enlace.
      return rutaComoLaEscribe(resto ? unir(base, resto) : base, saltos + 1, dep);
    }
    cur = sig;
  }
  return cur;
}

/** ¿La ruta cae dentro del repo del equipo? Se compara como la resolvería la escritura: un symlink —en el
 *  archivo, en una carpeta o con «..» de por medio— no la esquiva. Ante una cadena que no termina, se niega.
 *  `dep` ({ path, fs, raiz }) sólo lo pasan las pruebas, para simular Windows. */
function dentroDelRepoDelEquipo(ruta, dep = { path, fs, raiz: RAIZ }) {
  const P = dep.path, F = dep.fs;
  const real = (p) => { try { return F.realpathSync(p); } catch (_) { return P.resolve(p); } };
  const destino = rutaComoLaEscribe(P.resolve(ruta), 0, dep);
  if (destino === null) return true;
  const r = destino.toLowerCase();
  const b = real(dep.raiz || RAIZ).toLowerCase();
  return r === b || r.startsWith(b.endsWith(P.sep) ? b : b + P.sep);
}

/**
 * La lista de productos del equipo (`repos.json` del clon de operaciones que declara la máquina), para agrupar el filtro.
 * Sin clon, o sin lista legible: null, y los repos van sin producto. Nunca tira.
 */
function reposDelEquipo() {
  try {
    const lib = path.join(__dirname, '..', '..', 'setup', 'harness', 'tycon-home.js');
    const clon = require('../../lib/night-data.js').operationsClone(require(lib));
    if (!clon.path || clon.problem) return null;
    const doc = JSON.parse(fs.readFileSync(path.join(clon.path, 'scripts', 'nightly', 'dependencies', 'repos.json'), 'utf8'));
    return doc && Array.isArray(doc.repos) ? doc.repos : null;
  } catch (_) { return null; }
}

/** Devuelve el código de salida; dashboard.js hace el exit. */
function main(opts = {}) {
  if (opts.clonRetirado) {
    console.error('--clone ya no existe (story 2.16, rediseño): las ejecuciones de otras máquinas se leen de la carpeta bajada del buzón — usá --mailbox <dir>, o nada para ~/.claude/.tycon-pipeline/corridas-buzon');
    return 2;
  }
  const runsDir = path.resolve(opts.runsDir || RUNS_DEFAULT);
  const buzon = buzonDeclarado(opts);
  const maquina = buzon ? (subida ? subida.nombreDeMaquina() : null) : null;
  const repos = reposDelEquipo();
  const M = modelo(runsDir, { ...(buzon ? { buzon, maquina } : {}), repos });
  const N = M.corridas.length;
  const log = opts.json ? console.error : console.log;
  if (!repos) log('sin la lista de productos (repos.json del clon de operaciones, paths.operations): el filtro agrupa los repos sin producto');
  log(`Ejecuciones: ${N} ejecución${N === 1 ? '' : 's'} de ${M.archivos} archivos · ${M.duplicados} duplicado${M.duplicados === 1 ? '' : 's'} · ${M.ilegibles} no se pudieron leer`);
  log(`  con consumo medido: ${M.corridas.filter((c) => c.consumo.estado === 'medido').length} · con controles: ${M.corridas.filter((c) => c.controles).length} · llegaron al final: ${M.corridas.filter((c) => c.llego_al_final).length}`);
  if (M.registro.estado !== 'medido') log(`  registro NO MEDIDO: ${M.registro.motivo}`);
  if (M.pasos.fuente !== 'tabla' || M.pasos.motivo) log(`  pasos por número: ${M.pasos.motivo}`);
  if (M.umbrales_motivo) log(`  umbrales NO LEÍDOS: ${M.umbrales_motivo}`);
  if (M.sin_rescate) log(`  rescate NO CARGADO: ${M.sin_rescate}`);
  if (M.multi) {
    log(`  máquinas: ${M.maquinas.lista.map((x) => `${x.nombre} ${x.corridas}`).join(' · ') || 'ninguna'}${M.maquinas.sin_declarar ? ` · sin declarar ${M.maquinas.sin_declarar}` : ''} (esta máquina: ${maquina || 'sin nombre'})`);
    if (M.buzon && M.buzon.estado !== 'leido') log(`  buzón NO LEÍDO: ${M.buzon.motivo}`);
    if (M.buzon && M.buzon.carpetas_ilegibles) log(`  ${M.buzon.carpetas_ilegibles} carpeta(s) del buzón no se pudieron leer`);
    if (M.buzon && M.buzon.uniones && M.buzon.uniones.estado === 'no_medidas') log(`  uniones de carpetas no medidas: ${M.buzon.uniones.motivo}`);
  }
  if (opts.json) console.log(JSON.stringify(M, (k, v) => (k === '_texto' || k === '_textoGit' ? undefined : v), 2));
  if (opts.dryRun) { log('\n--dry-run: no se escribió nada.'); return 0; }
  // 🔴 La página va a una carpeta local, fuera de todo repo, y NUNCA al repo del equipo: con corridas del
  //    buzón publicaría el trabajo de todo el equipo a todo el equipo; sin buzón, dejaría
  //    commiteada una foto de UNA máquina que cambia según quién la armó.
  const salida = path.resolve(opts.salida || (M.multi ? path.join(buzon, 'runs-dashboard.html') : SALIDA_DEFAULT));
  if (dentroDelRepoDelEquipo(salida)) {
    console.error(`se niega a escribir ${path.relative(RAIZ, salida) || salida}: esa ruta es del repo del equipo, que lo clona todo el equipo${M.multi ? ', y la página tiene ejecuciones del buzón' : ''}. La vista de ejecuciones no se commitea: sin --output va a ${M.multi ? '<carpeta bajada>/runs-dashboard.html' : '~/.claude/.tycon-pipeline/runs-dashboard.html'}.`);
    return 2;
  }
  if (!opts.salida) { try { fs.mkdirSync(path.dirname(salida), { recursive: true }); } catch (_) { /* lo dice el write */ } }
  // Una máquina que todavía tiene la página con su nombre de antes la lleva al nuevo antes
  // de escribir, aunque la página se regenera entera (la vieja queda intacta hasta el retiro). Una ruta que no está en
  // el mapa —la de --output o la de la carpeta del buzón— pasa derecho. Como la página no tiene historia que perder, no
  // poder llevar la vieja se dice y la página se escribe igual.
  try { prepareStateWrite(salida, { where: 'scripts/nightly/dashboard/runs.js' }); }
  catch (e) { console.error(`⚠️  la página de antes del renombre no se pudo llevar (${e.message}); se escribe la nueva igual`); }
  try {
    if (!fs.existsSync(path.dirname(salida))) throw Object.assign(new Error(`la carpeta de salida no existe: ${path.dirname(salida)}`), { code: 'ENOENT' });
    fs.writeFileSync(salida, render(M), 'utf8');
    log(`\nPágina escrita: ${salida}`);
  } catch (e) { console.error(`no se pudo escribir la página: ${e.message}`); return 3; }
  return 0;
}

// `dentroDelRepoDelEquipo` también la usa dashboard.js: la página de seis preguntas tiene un solo escritor en el repo.
module.exports = { enIdioma, todoEnIdioma, textosDelCliente, bloqueDeTextos, main, modelo, leerRegistro, modeloDeCorrida, clasificar, agruparEventos, producto, unificarProductos, agruparRepos, esLaboratorio, nombresDePasos, lineaBasePasos, render, CONTROLES, filaControles, semanaVisible, dentroDelRepoDelEquipo,
  // Lo que usa la pestaña Corridas del sitio
  idEstable, runKey, paraLista, paraDetalle, textosDe, cabecera, ejecutiva, tabla, pie, CLIENTE, CSS_PROPIO, SIN_HILOS,
  // el sitio con las conversaciones prendidas: el resumen de cada corrida y los textos de una, a demanda
  RESUMEN, resumirEspejo, textosDeUnaCorrida,
  // el pase no medido se pinta como error
  estadoDelPaseAdversarial, resultadoAdversarial };

if (require.main === module) {
  require('../../lib/legacy-names.js').aliasArgv('scripts/nightly/dashboard/runs.js');
  const args = process.argv.slice(2);
  const valor = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  // exitCode y no exit(): con exit() una salida grande por pipe (el --json real pesa ~1 MB) se trunca.
  process.exitCode = main({ runsDir: valor('--runs-dir'), salida: valor('--output'), buzon: valor('--mailbox'), clonRetirado: args.includes('--clone'), soloLocal: args.includes('--local-only'), json: args.includes('--json'), dryRun: args.includes('--dry-run') });
}
