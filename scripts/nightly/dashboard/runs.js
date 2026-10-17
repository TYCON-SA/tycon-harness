#!/usr/bin/env node
'use strict';
/*
 * runs.js — LA VISTA DE CORRIDAS DEL TABLERO, sesión por sesión (story 2.14, 2026-09-09)
 *
 * Una fila por corrida del pipeline —cuánto duró, dónde se fue el tiempo y los tokens, qué control
 * encontró un error o frenó, cuántas vueltas dio, cuántos agentes lanzó— y una capa ejecutiva
 * arriba que resume el conjunto. Segunda página de la misma pieza: la genera
 * `node scripts/nightly/dashboard/dashboard.js --view runs` y escribe `~/.claude/.tycon-pipeline/runs-dashboard.html`.
 *
 * 🔴 NO SE COMMITEA (2026-09-17): hasta ese día había una copia en `artifacts/`, armada con las corridas de
 * UNA máquina —la que la regeneraba—, así que mostraba 232 corridas o 18 según quién la hubiera armado
 * por última vez. La vista completa sale de la carpeta bajada del buzón, que cualquier máquina con la
 * sesión de Azure de quien tiene el permiso llena sola al arrancar.
 *
 * VARIAS MÁQUINAS (story 2.16): si en esta máquina está la carpeta bajada del buzón de corridas
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
 * LO QUE LEE DEL HILO (2026-09-17): sólo las ediciones y escrituras de archivos con su cambio, y los
 * commits (`changes.js`). La 2.14 los había sacado porque la página se commiteaba y los cambios traen
 * código de cliente; desde el 2026-09-17 la página NO se commitea (vive en ~/.claude, o en la carpeta
 * bajada del buzón, que sólo leen quienes tienen permiso), así que el detalle de cada corrida los
 * muestra, saneados (credenciales tapadas) y con tope de largo. Los prompts y las respuestas del hilo
 * siguen sin publicarse. El cambio va comprimido adentro de la página y se abre a pedido.
 *
 * LO QUE LEE DE GIT (story 2.19): el `<volcado>.cambio.json.gz` que deja el archivador — los commits de la
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
 * EN EL SITIO DE LA ORGANIZACIÓN (story 2.27): la pestaña Corridas (scripts/site/tabs/runs.js) usa ESTE modelo y ESTE
 * cliente, no una copia. Cada corrida lleva un id estable (`idEstable`: máquina + sesión, sin publicar la sesión), y el
 * modelo se parte en lo que viaja por separado: `paraLista` (lista blanca: la cabecera, las fichas, los gráficos y el
 * filtro), `paraDetalle` (al abrir una corrida) y `textosDe` (al abrir un cambio). La página se arma con `cabecera`,
 * `ejecutiva`, `tabla` y `pie`, que `render` compone igual que antes; el sitio las usa con `opts.sitio` y lo ya filtrado
 * para quien pide. El cliente lee sus datos de una FUENTE: embebida en la página local (como siempre) o por la red
 * en el sitio (`#fuente-corridas`). `modelo()` acepta `soloBuzon`, `sinUnificar`, `sinHilos`, `umbralesArchivo` y
 * `skillsDir` para el sitio; sin ellas, la vista local es la de siempre.
 *
 * Contrato de salida (`main` devuelve el código; dashboard.js hace el exit):
 *   0 → midió (aunque haya rojos; registro ausente también es 0: la fuente no es obligatoria)
 *   2 → se negó a escribir una página con corridas del buzón dentro del repo del equipo, o se pidió
 *       `--clone` (retirado con el repo git de la primera implementación: ahora es `--mailbox`)
 *   3 → no pudo escribir la página
 */

const fs = require('fs');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { mediana, num1, esc, CSS_BASE, CSS_CHIPS } = require('./common');
const { readEnv, prepareStateWrite } = require('../../lib/legacy-names.js');

const RAIZ = path.resolve(__dirname, '..', '..', '..');

// El rescate (story 2.13) exporta el saneado del mensaje y el corte de pasos. Se importa, no se
// copia: dos saneados se separan solos. Si el módulo no está (arnés partido), se DICE y el
// mensaje no se publica — un mensaje sin sanear es peor que ninguno.
let rescate = null;
let motivoSinRescate = null;
try { rescate = require('../../metrics/tokens-digest.js'); }
catch (e) { motivoSinRescate = `scripts/metrics/tokens-digest.js no se pudo cargar (${e.code || e.message}): los mensajes de error no se publican y los pasos no se cortan`; }

// Los archivos que tocó cada corrida y su cambio, leídos del hilo (2026-09-17). Sin el módulo, el detalle lo dice.
let cambios = null;
let motivoSinCambios = null;
try { cambios = require('./changes.js'); }
catch (e) { motivoSinCambios = `scripts/nightly/dashboard/changes.js no se pudo cargar (${e.code || e.message}): el detalle no muestra los archivos que tocó cada corrida`; }

// La cuenta de trabajo, espera y hueco (story 2.7) vive en UN archivo, el mismo para la corrida nueva
// (con arranque por paso) y la vieja (sin arranque: estimada). Sin él, los tramos se cortan como antes.
let cuentaTiempos = null;
let motivoSinTiempos = null;
// La cuenta de VUELTAS es la del latido (story 7.1: `vueltaDeVolcado`), no `costo.iteraciones` —
// ése cuenta las veces que se calculó el set de revisores y acertaba 17 de 43 contra lo medido; se
// publica aparte, con su nombre. Sin el script la columna sale «—» y la página lo dice.
let cuentaVueltas = null; let motivoSinVueltas = null;
try { ({ vueltaDeVolcado: cuentaVueltas } = require('../../metrics/retro-heartbeat.js')); }
catch (e) { motivoSinVueltas = `scripts/metrics/retro-heartbeat.js no se pudo cargar (${e.code || e.message}): las vueltas de revisión no se publican`; }
try { cuentaTiempos = require('../../metrics/step-times.js'); }
catch (e) { motivoSinTiempos = `scripts/metrics/step-times.js no se pudo cargar (${e.code || e.message}): los pasos se cortan del fin del anterior al fin de éste, sin separar trabajo, espera ni tiempo entre pasos`; }

// El nombre de esta máquina sale de la subida (story 2.16): la carpeta que la subida crea en el buzón
// y la máquina que esta vista le atribuye a las corridas locales tienen que ser la MISMA
// palabra. Sin el módulo, las corridas locales salen «sin declarar» con el motivo — nunca inventadas.
let subida = null;
let motivoSinSubida = null;
try { subida = require('../../metrics/upload-runs.js'); }
catch (e) { motivoSinSubida = `scripts/metrics/upload-runs.js no se pudo cargar (${e.code || e.message}): no se sabe el nombre de esta máquina`; }

// Una carpeta de la bajada es de una máquina si tiene la forma que la subida le da a ese nombre: la MISMA
// definición que usa la subida (si el módulo no está, la copia de respaldo es idéntica).
const FORMA_MAQUINA = (subida && subida.FORMA_MAQUINA) || /^[a-z0-9][a-z0-9._-]*$/;

// Las uniones de carpetas (story 2.28): cada máquina sube a `<nombre>-<código>`, y el bajador declara qué carpeta vieja
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
  // story 1.8: el 5b sin pase lo anota el portón, y el paso 8 no cierra sin el pase atendido.
  'adversarial-skip': 'pase adversarial (salteado por el portón)',
  'adversarial-result-gate': 'pase adversarial con su resultado (paso 8)',
};

// La línea `adversarial-pass` (marker.js mark-adversarial-result, 2026-09-14) no trae `status`: trae
// `veredicto` (`listo` = 0 confirmados · `no-listo` = hubo) y, desde el 2026-09-17, cuántos de los
// confirmados quedaron con su prueba en la suite y cuántos se difirieron. Sin esto salía «sin estado»
// —un pase con 13 confirmados dibujado igual que uno que no dejó constancia— y los números no se veían.
// La nota se arma SÓLO con enteros: el `motivo` del diferido es prosa del dev y no se publica.
function resultadoAdversarial(g) {
  if (String(g.check || g.name || g.gate || '') !== 'adversarial-pass' || g.status !== undefined) return null;
  const cls = g.veredicto === 'listo' ? 'paso' : g.veredicto === 'no-listo' ? 'error' : 'sin_estado';
  const n = (k) => (Number.isInteger(g[k]) && g[k] >= 0 ? g[k] : null);
  const c = n('confirmados');
  let nota = null;
  if (c !== null) {
    nota = `${c} confirmado${c === 1 ? '' : 's'}`;
    if (c > 0) {
      const p = n('pruebas'), d = n('diferidos'), pr = n('propias');
      // Desde la story 1.8 la línea trae `propias` (la prueba escrita a mano, verificada por el comando): con
      // ese campo son cuatro números. Una línea anterior conserva su texto — no se reescribe la historia.
      nota += p === null && d === null
        ? ' · sin constancia de sus pruebas de regresión (pase anterior al 2026-09-17)'
        : pr !== null
          ? ` · ${p ?? 0} con prueba promovida · ${pr} con prueba propia · ${d ?? 0} diferido${d === 1 ? '' : 's'}`
          : ` · ${p ?? 0} con prueba en la suite · ${d ?? 0} diferido${d === 1 ? '' : 's'}`;
    }
  }
  return { cls, nota };
}

// La nota del salteo del 5b (story 1.8): sale de los BOOLEANOS de la línea, nunca de su `motivo` — el `reason`
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
  // Story 2.8: la guía de QA anota también cuando está al día (`presente`) y cuando no hacía falta
  // (`no-aplica`). Las dos son «miró y dejó pasar»: sin esto caían en «estado no reconocido».
  if (s === 'presente' || s === 'no-aplica') return 'paso';
  if (ERROR.some((x) => s.startsWith(x))) return 'error';
  if (FRENO.some((x) => s.startsWith(x))) return 'freno';
  return 'otro';
}

/**
 * Los nombres de los pasos salen de la tabla única del pipeline (`skills/tycon-pipeline/scripts/lib/steps.js`, story
 * 7.23), no se tipean ni se leen del título de cada archivo de paso. Son los de 0 a 8: los que tienen marca en
 * `stepTimings`. Si la tabla no se puede cargar, van los números y la página lo declara con el motivo.
 */
const TABLA_DE_PASOS = path.join(__dirname, '..', '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js');
function nombresDePasos(tabla = TABLA_DE_PASOS) {
  const nombres = Array.from({ length: 9 }, (_, i) => String(i));
  const faltan = [];
  try {
    const T = require(tabla);
    // una tabla que carga pero está mal armada (exporta null, `stepName` que lanza) degrada igual que una que no
    // carga: el tablero no se cae entero por los nombres (pase adversarial de la 7.23)
    for (let i = 0; i < nombres.length; i++) {
      const n = T && typeof T.stepName === 'function' ? T.stepName(i) : null;
      if (typeof n === 'string' && n) nombres[i] = n; else faltan.push(i);
    }
  } catch (e) {
    // «No está» y «está rota» no son lo mismo (cazador de fallos silenciosos, 2.14): el motivo lleva el tipo de error,
    // nunca su mensaje (puede traer rutas de la máquina, y la página se publica); algo lanzado que no es un Error, igual.
    const codigo = (e && e.code) || (e instanceof SyntaxError ? 'SyntaxError' : (e && e.name) || 'error');
    const donde = String(tabla).split(/[\\/]/).slice(-5).join('/');
    return { nombres: nombres.map((_, i) => String(i)), fuente: 'numeros', motivo: `la tabla de pasos del pipeline no se pudo cargar (${codigo}, ${donde}): los pasos van por número, sin nombre` };
  }
  if (faltan.length === nombres.length) {
    return { nombres, fuente: 'numeros', motivo: 'la tabla de pasos del pipeline no trae los nombres de 0 a 8: los pasos van por número, sin nombre' };
  }
  return { nombres, fuente: 'tabla', motivo: faltan.length ? `la tabla de pasos no nombra el/los paso(s) ${faltan.join(', ')}: van por número` : null };
}

/**
 * 🔴 Todo texto que llega de AFUERA de la lista blanca pasa por el saneado: el mensaje rescatado y
 * también los MOTIVOS. Medido en la corrida real (2026-09-09): el motivo de «conversación borrada»
 * que escribe el rescate dice «se buscó <sessionId>.jsonl en las 1970 carpetas» — 144 identificadores
 * de sesión llegaban a la página por un campo que parecía prosa inocente. Sin saneador, el texto no
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
 * 🔴 2026-09-17: el filtro agrupaba por carpeta, así que el mismo repo salía partido según la máquina y el
 * clon (`Codigo/FRESNOBZExtBackend` en la de DevB y `FRESNO/FRESNOBZExtBackend` en la de DevA, un worktree
 * `…--wt-5-17-tanda-b`, catorce clones descartables `tcg-2.10`, `tcg-215`… del arnés) y se colaban `.` y
 * `tmp`. Ahora, en orden:
 *  - sin ruta, `.` o una carpeta temporal pelada → null (sin registrar);
 *  - un clon del scratchpad de una sesión (`…/claude-NNN/-Users-u-SourceCode-<repo>/…`) → el repo de esa
 *    sesión, que es el que se clonó;
 *  - el sufijo de worktree o de clon (`--wt-x`, `--merge`, `--7.2`) no es parte del nombre;
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
  const temporal = /^(private|tmp|var)$/.test(segs[0] || '') && segs.includes('tmp');
  const iHome = segs.findIndex((x, i) => i <= 1 && (x === 'Users' || x === 'home'));
  const limpio = (x) => String(x || '').replace(/--.*$/, '');
  const esGen = (x) => GENERICAS.has(limpio(x).toLowerCase());
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

/** Junta el mismo repo escrito distinto: mayúsculas (`MIRepo`/`MiRepo`) y el nombre
 *  suelto con su ÚNICO par con producto (`CeiboBackend` → `Ceibo/CeiboBackend`). Gana la forma más usada. */
function unificarProductos(corridas) {
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

function semanaIso(iso) {
  const d0 = new Date(iso);
  if (!Number.isFinite(d0.getTime())) return null;
  const t = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()));
  const dn = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dn);
  const a0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-S${String(Math.ceil(((t - a0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

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
function modeloDeCorrida(d, nombresPasos) {
  const m = d.marker || {};
  const ini = Date.parse(m.startedAt || '');
  const fin = Date.parse(m.lastTouch || '');
  const off = (ts) => {
    const t = Date.parse(ts || '');
    return (Number.isFinite(t) && Number.isFinite(ini)) ? Math.round((t - ini) / 60000) : null;
  };

  // Tramos: del fin del anterior al fin de éste. Pasos con marcas invertidas o empatadas salen
  // FUSIONADOS (`5+6`) con la misma regla que `consumo.por_paso` (cortesDePaso de la 2.13): se
  // declara en vez de fingir un reparto que las marcas no sostienen.
  let tramos = [];
  let motivoTramos = null;
  let tiempos = null;
  if (!rescate) motivoTramos = 'los pasos no se cortan: el saneado y el corte de pasos (tokens-digest.js) no están en esta máquina';
  else if (!Number.isFinite(ini)) motivoTramos = 'la corrida no anotó su hora de inicio: sin eje de tiempo';
  else if (cuentaTiempos) {
    // story 2.7: con arranque, el paso dura fin − arranque y el hueco previo es un tramo PROPIO
    // (`tipo: 'entre'`), nunca parte del paso. Sin arranque, la cuenta lo estima como siempre y lo dice.
    const t = cuentaTiempos.tiempos(m.stepTimings || {}, { inicio: m.startedAt });
    for (const p of t.pasos) {
      if (p.hueco_previo_ms > 0) tramos.push({ tipo: 'entre', paso: 'entre', pasos: [], ms: p.hueco_previo_ms, nombre: 'entre pasos' });
      tramos.push(p.subpaso
        ? { tipo: 'paso', paso: p.paso, pasos: [Number(p.paso[0])], ms: p.ms, medida: true, subpaso: true, nombre: `sub-paso ${p.paso}` }
        : { tipo: 'paso', paso: p.paso, pasos: p.pasos, ms: p.ms, medida: p.medida, nombre: p.pasos.map((x) => nombresPasos[x] || String(x)).join(' + ') });
    }
    tiempos = {
      estado: t.estado,
      motivo: t.motivo,
      trabajo_ms: t.trabajo_ms,
      trabajo_medido: t.trabajo_medido,
      espera_humana_ms: t.espera_humana_ms,
      entre_pasos_ms: t.entre_pasos_ms,
      sin_repartir_ms: t.sin_repartir_ms,
      estimados: t.estimados.filter((x) => /^\d$/.test(x)),
    };
  } else {
    let ant = ini;
    for (const c of rescate.cortesDePaso(m.stepTimings || {})) {
      const pasos = String(c.paso).split('+').map(Number);
      tramos.push({ paso: String(c.paso), pasos, ms: Math.max(0, c.hasta - ant), nombre: pasos.map((p) => nombresPasos[p] || String(p)).join(' + ') });
      ant = c.hasta;
    }
  }
  const marcados = new Set(tramos.filter((t) => !t.subpaso).flatMap((t) => t.pasos));
  const sinMarca = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => !marcados.has(i));

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
      // no entra en NINGUNA de las dos vistas (tabla y lista cuentan sobre el MISMO universo — pase
      // adversarial 2.14, lente de contratos). Sin hora de inicio no hay «antes»: el evento se queda,
      // sin minuto (t: null), y el detalle lo dice — antes desaparecían todos.
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
  }
  const vueltas = Object.values(m.iterations || {}).map((it) => off(it && it.ts)).filter((t) => t !== null && t >= 0);

  const co = d.costo && typeof d.costo === 'object' ? d.costo : null;
  const vueltaMedida = cuentaVueltas ? cuentaVueltas(d) : null;
  const costo = co && Number.isFinite(co.spawns)
    ? { agentes: co.spawns, vueltas: vueltaMedida ? vueltaMedida.value : null,
        vueltas_fuente: vueltaMedida ? vueltaMedida.fuente : (motivoSinVueltas || 'el volcado no registra vueltas: sin revisores por vuelta ni fotos de iteración'),
        calculos_del_set: Number.isFinite(co.iteraciones) ? co.iteraciones : null,
        por_tipo: Object.fromEntries(Object.entries(co.por_tipo || {}).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [String(k), v])) }
    : null;

  const c = d.consumo && typeof d.consumo === 'object' ? d.consumo : null;
  let consumo;
  if (!c) consumo = { estado: 'no_medido', motivo: 'esta corrida es anterior al rescate del consumo (story 2.13): no se registró' };
  else if (c.estado !== 'medido' || !c.tokens) consumo = { estado: String(c.estado || 'no_medido'), motivo: limpio(c.motivo, 'el volcado no trae el consumo medido') };
  else {
    const tk = c.tokens;
    consumo = {
      estado: 'medido',
      respuestas: Number.isFinite(c.respuestas) ? c.respuestas : null,
      tokens: { in: tk.in || 0, out: tk.out || 0, cache_new: tk.cache_new || 0, cache_read: tk.cache_read || 0 },
      por_modelo: Object.fromEntries(Object.entries(c.por_modelo || {}).map(([k, v]) => [String(k), { respuestas: (v && v.respuestas) || 0, out: (v && v.out) || 0, cache_new: (v && v.cache_new) || 0 }])),
      por_paso: Object.fromEntries(Object.entries(c.por_paso || {}).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [String(k), v])),
      fuera_de_ventana: Number.isFinite(c.fuera_de_ventana) ? c.fuera_de_ventana : 0,
    };
  }

  // Los REVISORES (story 2.15): lo medido con su número, lo estimado con la palabra. Lista blanca,
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
    revisores = { estado: 'sin_medir', motivo: 'esta corrida no tiene medidos los revisores: los mide el barrido del arranque, o a mano `scripts/metrics/reviewers-cost.js --run <volcado>`' };
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
        ? { estado: 'no_medido', motivo: 'el volcado no trae el campo estimado' }
        : est.estado === 'estimado'
          ? { estado: 'estimado', lanzamientos_cubiertos: num(est.lanzamientos_cubiertos), tokens_min: num(est.tokens_min), tokens_max: num(est.tokens_max),
              medido_el: est.supuesto && est.supuesto.medido_el ? String(est.supuesto.medido_el) : null,
              revisar_antes_de: est.supuesto && est.supuesto.revisar_antes_de ? String(est.supuesto.revisar_antes_de) : null }
          : { estado: String(est.estado || 'no_medido'), motivo: limpio(est.motivo, 'sin estimación'), lanzamientos_sin_medir: num(est.lanzamientos_sin_medir) },
    };
  }

  // El VALIDADOR DE STORIES por fase (story 7.3): sólo los conteos de las fases conocidas —lista blanca: ni
  // el `detalle`, ni campos que el volcado traiga de más— y las decisiones de los re-loops, contadas de las
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
        ? 'sin medir los revisores de esta corrida; el veredicto del validador existe desde la story 7.3'
        : !vr ? 'la corrida es anterior a la story 7.3: el validador no dejaba veredicto'
          : limpio(vr.motivo, 'el volcado no trae el veredicto del validador medido'),
    };
  }
  validador.re_loops_sin_relanzar = decisiones.filter((g) => g.invoca === false).length;
  validador.re_loops_decididos = decisiones.length;

  const completados = Array.isArray(m.stepsCompleted) ? m.stepsCompleted : [];
  return {
    story: m.storyId ? String(m.storyId) : null,
    producto: producto(m.repoPath),
    inicio: Number.isFinite(ini) ? new Date(ini).toISOString() : null,
    semana: Number.isFinite(ini) ? semanaIso(new Date(ini).toISOString()) : null,
    dur_ms: (Number.isFinite(ini) && Number.isFinite(fin) && fin > ini) ? fin - ini : null,
    tramos, sin_marca: sinMarca, motivo_tramos: motivoTramos,
    tiempos,
    pasos_completos: completados.length,
    // El ÚLTIMO paso completado, no `length - 1`: stepsCompleted tiene huecos en 22 de 231 corridas
    // reales ([0,1,4,5,6,7] decía «quedó en el 5» y quedó en el 7 — pase adversarial 2.14).
    ultimo_paso: completados.length ? Math.max(...completados.map(Number).filter(Number.isFinite)) : null,
    llego_al_final: completados.map(Number).includes(8),
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
 * lo tuvo a la vista: 104 de 120 hilos medidos), el asunto de su primer commit (8 más), y si no hay hilo,
 * el nombre del archivo de la story sin su número. Nunca el prompt del dev: medido, suele ser «listo» o «seguí».
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
 * El cambio de la corrida según git (story 2.19), compacto para el modelo: repos, commits (con su minuto de
 * la corrida) y archivos con sus PARTES (una por commit, y la de «sin commitear»), sin sumar partes: una
 * suma de dos diffs no es un diff. Los parches van aparte, comprimidos, saneados OTRA VEZ (el archivo pudo
 * escribirlo el guion de otra máquina). Lo que no se pudo leer dice por qué.
 */
function modeloGit(rutas, marker, cambioDelVolcado) {
  const conCambio = rutas.find((r) => fs.existsSync(cambios.rutaDeCambio(r)));
  // 🔴 Sin el archivo, no da igual «esta corrida es anterior a la 2.19» que «el archivador lo intentó y no
  // pudo»: el volcado guarda el motivo (arnés atrasado, guion roto, tope de tiempo) y la vista lo dice.
  if (!conCambio) {
    const c = cambioDelVolcado;
    if (c && typeof c === 'object' && c.estado && c.estado !== 'medido') {
      const S0 = rescate && rescate.sanear;
      // Sin el saneado NO se publica ningún texto de afuera, tampoco este motivo — era la única rama que lo
      // dejaba pasar crudo (revisor de seguridad, vuelta 3). El resto del archivo ya se comporta así.
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
      // Copia compartida (arreglo del 2026-09-18): los commits que el hilo atribuye a otra sesión, y el motivo si no se pudo atribuir.
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

/** El resumen guardado de una corrida, o null (no está, o no se puede leer: entonces la corrida se lee como hoy). */
function leerResumen(volcado) {
  try {
    const r = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(RESUMEN.nombre(volcado))).toString('utf8'));
    return r && r.v === 1 && r.cambios && typeof r.cambios === 'object' ? r : null;
  } catch (e) {
    if (e.code !== 'ENOENT') process.stderr.write(`corridas: el resumen de ${path.basename(volcado)} no se pudo leer (${e.code || e.message})\n`);
    return null;
  }
}

/** Los cambios de una corrida: de su conversación si está en el disco; si no, de su resumen; si no, como hoy. */
function cambiosDeLaCorrida(rutas, marker, nombresPasos, cambioDelVolcado) {
  const hayCrudo = cambios && rutas.some((r) => fs.existsSync(cambios.rutaDeHilo(r)) || fs.existsSync(cambios.rutaDeCambio(r)));
  if (!hayCrudo) {
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
  // oculta (contado) si git no lo confirma — `p.Id` salía como archivo porque `p => p.Id` parece `> archivo`.
  // Las ediciones con herramientas no se tocan: su nombre es exacto aunque git no lo tenga (un archivo revertido).
  // 🔴 `ids` sólo sirve para DESMENTIR un nombre de la consola, y para eso git tiene que haber medido algo:
  // con la lista vacía (0 archivos, o repos que no se pudieron mirar) se ocultaba TODO lo hecho por consola
  // rotulándolo «texto del comando que parecía un archivo» (pase adversarial).
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
    return { t: e.t, p: e.paso, a: idx.get(f), w: e.w, k: e.k ? 1 : 0, r: e.ref, mas: e.mas, menos: e.menos,
      x: e.nuevo !== undefined ? 1 : 0, c: (e.nuevo_cortado || 0) + (e.viejo_cortado || 0), ...(g !== undefined ? { g } : {}), ...(o ? { o } : {}) };
  });
  const texto = x.ediciones.map((e) => (e.nuevo === undefined ? null : [e.viejo, e.nuevo]));
  // Minuto a minuto: [minuto, tokens nuevos, salida, caché nueva, {herramienta: veces}, {agente: veces}].
  const minutos = [...new Set([...Object.keys(x.consumo.serie), ...Object.keys(x.consumo.que)])].map(Number).sort((a, b) => a - b)
    .map((mi) => { const q = x.consumo.que[mi] || { h: {}, ag: {}, out: 0, cache: 0 }; return [mi, x.consumo.serie[mi] || 0, q.out, q.cache, q.h, q.ag]; });
  const ini = Date.parse((marker || {}).startedAt || '');
  return { estado: 'leido', motivo: null, lista, archivos, commits: x.commits, titulo: x.titulo, minutos, git: git.modelo, _textoGit: git.texto, no_confirmados: noConfirmados,
    _esperas: x.esperas || [],
    esperas_min: Number.isFinite(ini) ? (x.esperas || []).map(([a, b]) => [Math.round((a - ini) / 600) / 100, Math.round((b - ini) / 600) / 100]) : [], por_consola: x.por_consola,
    en_commits: x.commits.reduce((a, k) => a + (k.archivos || 0), 0),
    anteriores_al_inicio: x.anteriores_al_inicio, posteriores_al_cierre: x.posteriores_al_cierre, sin_cambio_por_tope: x.sin_cambio_por_tope, topes: x.topes,
    _texto: lista.length ? require('zlib').gzipSync(JSON.stringify(texto)).toString('base64') : null };
}

/**
 * El registro: una corrida por sesión (el archivo con `archivedAt` mayor); lo ilegible se cuenta.
 *
 * Con `opts.buzon` (story 2.16) lee además la carpeta bajada del buzón: `<buzon>/<maquina>/*.json`. La
 * máquina de cada corrida sale de la CARPETA que la contiene —nunca del volcado, que no la trae: los
 * volcados archivados no se reescriben— y la de las locales, del nombre de esta máquina. Lo que no se
 * puede atribuir (un volcado suelto en la raíz, una carpeta sin forma de nombre de máquina) sale con
 * `maquina: null` y su motivo. 🔴 Cuando la misma sesión está en varias copias, gana la de
 * `archivedAt` mayor, pero la máquina es la de la primera copia que SÍ la declara: una copia suelta
 * más nueva no puede dejar «sin declarar» a una corrida atribuible (AC12).
 * Story 2.28: la corrida de una carpeta vieja que `.carpetas-de-maquina.json` declara `unida` es de su carpeta nueva
 * (`maquina_nota: «antes, <vieja>»`), y entre las dos copias de una sesión gana la de la nueva; una `compartida` o
 * `siguio_recibiendo` queda en su carpeta, con su marca. Sin el archivo, nada se une y `buzon.uniones` lo dice.
 */
function leerRegistro(dir, nombresPasos, opts = {}) {
  const out = { registro: { estado: 'medido', motivo: null, dir: null }, corridas: [], archivos: 0, duplicados: 0, ilegibles: 0, buzon: null };
  const multi = Boolean(opts.buzon);
  const maquinaLocal = multi ? (opts.maquina || null) : null;
  const motivoLocal = multi && !maquinaLocal ? (motivoSinSubida || 'no se pudo saber el nombre de esta máquina') : null;
  const copias = [];   // { ruta, maquina, motivo }
  // story 2.27: el sitio lee SÓLO el espejo del buzón; no tener registro propio no es un faltante (AC 18)
  if (opts.soloBuzon) out.registro = { estado: 'no_aplica', motivo: null, dir: null };
  else try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) copias.push({ ruta: path.join(dir, f), origen: maquinaLocal, maquina: maquinaLocal, motivo: motivoLocal });
  } catch (e) {
    out.registro = { estado: 'no_medido', motivo: `esta página se generó donde no está el registro de corridas (${e.code || 'ilegible'}): vive en ~/.claude/.tycon-pipeline/timing-history, en el disco de cada máquina, fuera de todo repo`, dir: null };
    if (!multi) return out;
  }
  if (multi) {
    out.buzon = { estado: 'leido', motivo: null, carpetas_ilegibles: 0 };
    let entradas = [];
    // 🔴 Ordenado: «la primera copia que declara la máquina» no puede depender del orden del disco.
    try { entradas = fs.readdirSync(opts.buzon, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); }
    catch (e) { out.buzon = { estado: 'no_medido', motivo: `la carpeta bajada del buzón de corridas no se pudo leer (${e.code || 'ilegible'})`, carpetas_ilegibles: 0 }; }
    // story 2.28: la corrida de una carpeta vieja `unida` es de su nueva («antes, <vieja>»); una `compartida` o
    // `siguio_recibiendo` queda en su carpeta, marcada. Sin el archivo del bajador no se une nada, y se dice.
    const uniones = out.buzon.estado === 'leido' ? leerUniones(opts.buzon) : null;
    if (uniones) out.buzon.uniones = uniones.estado === 'medidas' ? { estado: 'medidas', motivo: null } : { estado: 'no_medidas', motivo: uniones.motivo };
    const unionDe = (nombre) => (uniones && uniones.estado === 'medidas' ? uniones.carpetas.get(nombre) || null : null);
    for (const en of entradas) {
      if (en.name.startsWith('.')) continue;
      const ruta = path.join(opts.buzon, en.name);
      // 🔴 Un symlink no es ni archivo ni carpeta para el Dirent: se decide por statSync (sigue el enlace), y lo
      //    que no se puede mirar (un enlace roto) se CUENTA — nunca desaparece en silencio (pase adversarial).
      let esArchivo = en.isFile(), esCarpeta = en.isDirectory();
      if (en.isSymbolicLink()) {
        try { const st = fs.statSync(ruta); esArchivo = st.isFile(); esCarpeta = st.isDirectory(); }
        catch (e) { out.buzon.carpetas_ilegibles += 1; continue; }
      }
      if (esArchivo && en.name.endsWith('.json')) {
        copias.push({ ruta, maquina: null, motivo: 'volcado suelto en la raíz de la carpeta bajada del buzón: no está bajo la carpeta de ninguna máquina' });
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
            motivo: declarada ? null : `la carpeta «${en.name}» del buzón no tiene la forma de un nombre de máquina (minúsculas, sin espacios ni .local)`,
            deVieja: Boolean(u), nota: u ? notaDeCarpeta(en.name, u) : null });
        }
      }
    }
  }
  out.archivos = copias.length;
  const porSesion = new Map();   // sid → { d, maquina, motivo }
  for (const cp of copias) {
    let d;
    try { d = JSON.parse(fs.readFileSync(cp.ruta, 'utf8')); } catch (e) { out.ilegibles += 1; continue; }
    const sid = d && d.marker && d.marker.sessionId;
    if (!sid || typeof sid !== 'string') { out.ilegibles += 1; continue; }
    const prev = porSesion.get(sid);
    if (!prev) { porSesion.set(sid, { d, maquina: cp.maquina, origen: cp.origen || null, motivo: cp.motivo, rutas: [cp.ruta], deVieja: Boolean(cp.deVieja), nota: cp.nota || null }); continue; }
    out.duplicados += 1;
    // story 2.28 (decisión 12): entre la copia de una carpeta vieja —unida, compartida o que siguió recibiendo— y la de
    // una carpeta nueva (o la local), gana la nueva, sea cual sea su fecha de archivo: la máquina volvió a subir ahí lo de
    // su disco. Con una vieja compartida la sesión es de la carpeta nueva que la re-subió, no de la vieja (pase adversarial).
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
  for (const [sid, { d, maquina, origen, motivo, rutas, nota }] of porSesion) {
    const c = modeloDeCorrida(d, nombresPasos);
    c.id = idEstable(multi ? maquina : null, sid);
    if (multi) { c.maquina = maquina; c.maquina_origen = maquina ? (origen || maquina) : null; c.maquina_motivo = maquina ? null : motivo; c.maquina_nota = maquina ? nota : null; }
    c.cambios = opts.sinHilos ? { estado: 'no_medido', motivo: SIN_HILOS } : cambiosDeLaCorrida(rutas, d.marker, nombresPasos, d.cambio);
    // de qué volcado salió (para bajar su detalle a demanda): sólo del lado del servidor, nunca en lo que se sirve
    Object.defineProperty(c, '_volcado', { value: rutas[0], enumerable: false });
    if (opts.sinHilos && c.tiempos) c.tiempos.espera_del_hilo_ms = null;
    aplicarEsperasDelHilo(c, d.marker);
    c.descripcion = descripcionDe(d.marker, c.cambios);
    out.corridas.push(c);
  }
  out.corridas.sort((a, b) => String(b.inicio || '').localeCompare(String(a.inicio || '')));
  return out;
}

function umbrales(archivo = path.join(__dirname, 'sources.json')) {
  // El JUICIO vive en sources.json → thresholds (misma regla que la página de seis preguntas): sin fila,
  // la ficha sale neutra. Antes el 80 % estaba escrito en el cliente (spec-first, SPEC-W7).
  // 🔴 Un sources.json roto NO es «no hay umbral»: sin motivo, las fichas perdían el color en silencio
  //    y eso se veía igual que «no hace falta umbral acá» (cazador de fallos silenciosos, iter 2).
  // El modelo (y su `--json`) conserva el nombre de antes, `sentido` (story 8.9, pregunta decidida 2): la
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
 * La línea base de los pasos por corrida (story 7.12): sale del MEDIDOR, que es su única copia. Tipeada acá
 * envejecería callada. 🔴 Si no se puede traer, NO vuelve un nulo mudo: vuelve el motivo, y la página lo dice —
 * «no la pude cargar» y «no hay línea base» no se pueden ver iguales. El motivo lleva el CÓDIGO del error,
 * nunca su mensaje (trae rutas del disco). `ruta` existe para que la suite pueda ejercitar los dos caminos malos.
 */
function lineaBasePasos(ruta = '../../metrics/steps-per-run.js') {
  let lb;
  try { lb = require(ruta).LINEA_BASE; }
  catch (e) { return { estado: 'sin_linea_base', motivo: `el medidor de pasos por corrida no se pudo cargar (${e.code || e.name || 'error'})` }; }
  if (!lb || !Number.isFinite(lb.mediana) || !/^\d{4}-\d{2}-\d{2}$/.test(String(lb.fecha))) {
    return { estado: 'sin_linea_base', motivo: 'el medidor de pasos por corrida no declara una línea base con su mediana y su fecha' };
  }
  return { estado: 'medida', mediana: lb.mediana, fecha: String(lb.fecha), corridas: Number.isFinite(lb.corridas) ? lb.corridas : null };
}

function modelo(runsDir, opts = {}) {
  const pasos = opts.skillsDir ? pasosDeLaImagen(opts.skillsDir) : nombresDePasos();
  const reg = leerRegistro(runsDir, pasos.nombres, opts);
  // story 2.27 (decisión 13): el sitio unifica los productos sobre lo que cada persona ve, nunca sobre todo
  if (!opts.sinUnificar) unificarProductos(reg.corridas);
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
    controles_nombres: CONTROLES,
    sin_rescate: motivoSinRescate,
    sin_tiempos: motivoSinTiempos,
    corridas: reg.corridas,
  };
}


// ───────────────────────────── lo que viaja al sitio (story 2.27) ─────────────────────────────

// Lo que sale del hilo en un sitio que no baja las conversaciones (sin disco o con `site.mailbox.threads` apagado).
const SIN_HILOS = 'no medido: este sitio no baja las conversaciones';

/**
 * El id estable de una corrida (decisión 3): 16 hexadecimales del sha256 de «máquina \n sesión». Ni el índice de la lista
 * (cambia con el filtro de cada persona) ni el id de sesión crudo (no se publica). Sin máquina, la máquina es ''.
 */
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
 * La corrida para la LISTA (AC 15): lista BLANCA, campo por campo — lo que usan la cabecera, las fichas, los gráficos y
 * el filtro. La tabla, que usa más, se arma en el servidor. Nada del detalle ni de los textos.
 */
function paraLista(c) {
  return {
    id: c.id, story: c.story, producto: c.producto, maquina: c.maquina === undefined ? null : c.maquina, maquina_motivo: c.maquina_motivo === undefined ? null : c.maquina_motivo,
    inicio: c.inicio, semana: c.semana, dur_ms: c.dur_ms, llego_al_final: c.llego_al_final, ultimo_paso: c.ultimo_paso,
    tramos: copiar(c.tramos), sin_marca: copiar(c.sin_marca),
    tiempos: elegir(c.tiempos, ['trabajo_ms', 'trabajo_medido', 'espera_humana_ms', 'espera_del_hilo_ms']),
    controles: elegir(c.controles, ['total', 'error', 'freno', 'por_control']),
    costo: elegir(c.costo, ['agentes', 'vueltas']),
    validador: elegir(c.validador, ['estado', 'por_fase', 're_loops_decididos', 're_loops_sin_relanzar']),
    consumo: elegir(c.consumo, ['estado', 'respuestas', 'tokens', 'por_paso', 'fuera_de_ventana']),
  };
}

/** La corrida para su DETALLE: el modelo de la corrida tal cual (ya es lista blanca), sin los textos. */
function paraDetalle(c) {
  return JSON.parse(JSON.stringify(c, (k, v) => (k === '_texto' || k === '_textoGit' ? undefined : v)));
}

/** Los TEXTOS de una corrida (los cambios y los parches), con la forma de hoy: gzip en base64, ya saneados. */
function textosDe(c) {
  const x = c && c.cambios;
  return { texto: (x && x._texto) || null, textoGit: (x && x._textoGit) || null };
}

// ───────────────────────────── la página ─────────────────────────────

const RAMPA = ['#BEE0DE', '#9CD0CE', '#79BFBE', '#57ADAE', '#3D9799', '#2C8084', '#1E6A70', '#14555C', '#0D4148'];
const miles = (n) => n == null ? '—' : n >= 1e6 ? `${num1(n / 1e6)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n);
const dur = (ms) => ms == null ? '—' : ms < 90 * 60000 ? `${Math.round(ms / 60000)} min` : `${num1(ms / 3600000)} h`;

function barraTramos(c, escala) {
  const total = c.tramos.reduce((a, t) => a + t.ms, 0);
  if (!total) return `<span class="nobar">${esc(c.motivo_tramos || 'sin tiempos por paso')}</span>`;
  const ancho = Math.max(2, Math.min(100, (total / escala) * 100));
  const segs = c.tramos.map((t) => (t.tipo === 'entre'
    ? `<i class="entre" style="width:${((t.ms / total) * 100).toFixed(2)}%" title="entre pasos — ${dur(t.ms)} sin paso abierto"></i>`
    : `<i style="width:${((t.ms / total) * 100).toFixed(2)}%;background:${RAMPA[t.pasos[0]] || RAMPA[8]}" title="${esc(t.paso)} · ${esc(t.nombre)} — ${dur(t.ms)}${t.pasos.length > 1 ? ' (marcas invertidas o empatadas: fusionados)' : ''}${t.medida === false ? ' (estimada por diferencia)' : ''}"></i>`)).join('');
  const faltan = c.sin_marca.length;
  return `<span class="bar" style="width:${ancho.toFixed(1)}%">${segs}${faltan ? `<i class="falta" style="width:6px" title="${faltan} paso(s) sin marca"></i>` : ''}</span>`;
}

// story 2.7: las dos columnas. Lo estimado lleva «~» y lo dice en el título; lo que no se midió es
// «sin medir», nunca 0.
function colTrabajo(c) {
  const t = c.tiempos;
  if (!t || t.trabajo_ms === null) return `<span class="nd" title="${esc((t && t.motivo) || c.motivo_tramos || 'sin tiempos por paso')}">—</span>`;
  return t.trabajo_medido ? dur(t.trabajo_ms) : `<span title="estimada por diferencia: la corrida no anotó el arranque de todos sus pasos">~${dur(t.trabajo_ms)}</span>`;
}
function colEspera(c) {
  const t = c.tiempos;
  const hilo = t && t.espera_del_hilo_ms ? t.espera_del_hilo_ms : 0;
  if (!t || t.espera_humana_ms === null) {
    // Sin la espera de los pasos 3 y 7 medida, lo que el hilo muestra es un piso: se dice «al menos».
    if (hilo) return `<span title="al menos esto esperó a una persona según su conversación (preguntas y turnos que esperaron un mensaje); la espera de los pasos 3 y 7 no está medida">≥ ${dur(hilo)}</span>`;
    return `<span class="nd" title="${esc((t && t.motivo) || 'sin tiempos por paso')}">sin medir</span>`;
  }
  return hilo ? `<span title="incluye ${dur(hilo)} esperando una respuesta fuera de los pasos de aprobación (una pregunta o un turno que esperó al dev)">${dur(t.espera_humana_ms)}</span>` : dur(t.espera_humana_ms);
}

function colArchivos(c) {
  const x = c.cambios;
  if (x && x.git && x.git.estado === 'medido') {
    const nR = x.git.repos.length;
    const sinMedir = x.git.repos.filter((r) => r.estado !== 'medido');
    // Un 0 con repos sin mirar es «no pude mirar» escrito como «no cambió nada» (pase adversarial).
    if (!x.git.total_archivos && sinMedir.length) {
      return `<span class="nd" title="${esc(`no se pudo mirar ${sinMedir.length} de ${nR} repo(s): ${sinMedir.map((r) => `${r.n} (${r.motivo || 'sin motivo'})`).join(' · ')}`)} — no es cero">—</span>`;
    }
    return `<span title="según git: ${x.git.total_archivos} archivo${x.git.total_archivos === 1 ? '' : 's'} en ${nR} repo${nR === 1 ? '' : 's'}${sinMedir.length ? `, ${sinMedir.length} sin poder mirar` : ''} (commits de la corrida y lo que quedó sin commitear)">${x.git.total_archivos}</span>`;
  }
  if (!x || x.estado !== 'leido') return `<span class="nd" title="${esc((x && x.motivo) || 'no se sabe qué archivos tocó')} — no es cero">—</span>`;
  const n = x.archivos.filter((a) => !/^script por consola/.test(a.f)).length;
  if (n) return `<span title="${x.lista.length} cambio${x.lista.length === 1 ? '' : 's'} en ${n} archivo${n === 1 ? '' : 's'}${x.por_consola ? `, más ${x.por_consola} comando(s) de consola que escriben archivos` : ''}">${n}</span>`;
  if (x.en_commits) return `<span title="no usó las herramientas de edición: cambió los archivos desde la consola. Sus commits llevaron ${x.en_commits} archivo(s)">${x.en_commits}</span><small class="nd">por consola</small>`;
  if (x.por_consola) return `<span class="nd" title="no usó las herramientas de edición, pero corrió ${x.por_consola} comando(s) de consola que escriben archivos: no se sabe cuántos tocó — no es cero">por consola</span>`;
  return '<span title="según su hilo, no editó ni escribió archivos">0</span>';
}

function filaControles(c) {
  if (!c.controles) return '<span class="nd" title="esta corrida no registró controles — no quiere decir que hayan salido verdes">sin controles registrados</span>';
  const peso = (v) => v.error * 1000 + v.freno * 10 + v.n / 1000;
  return Object.entries(c.controles.por_control).sort((a, b) => peso(b[1]) - peso(a[1])).slice(0, 3).map(([k, v]) => {
    const cls = v.error ? 'f-error' : v.freno ? 'f-freno' : (v.paso === 0 && v.sin_estado) ? 'f-sin' : '';
    const marca = v.error ? ` <b>${v.error} con error</b>` : v.freno ? ` <b>frenó ${v.freno}</b>` : (v.paso === 0 && v.sin_estado) ? ' <b>sin estado</b>' : '';
    const t = `${k} — ${v.n} ${v.n === 1 ? 'vez' : 'veces'}: ${v.paso} pasó, ${v.error} encontró un error, ${v.freno} frenó${v.sin_estado ? `, ${v.sin_estado} sin estado registrado` : ''}`;
    return `<span class="f ${cls}" title="${esc(t)}">${esc(CONTROLES[k] || k)}${marca}</span>`;
  }).join('');
}

/**
 * La cabecera de la vista (story 2.27, decisión 12): el título, el sello y las bandas. `opts.sitio` = { rol, version }
 * pone los textos fijos del modo sitio (decisión 14): la versión del sitio en lugar del commit y el eyebrow que enlaza el
 * tablero sólo para quien mantiene. Sin conteos globales en el modelo (el de un dev), el sello no los nombra (AC 8).
 */
function cabecera(M, opts = {}) {
  const sitio = opts.sitio || null;
  const C = M.corridas;
  const N = C.length;
  const conConsumo = C.filter((c) => c.consumo.estado === 'medido').length;
  const conControles = C.filter((c) => c.controles).length;
  const alFinal = C.filter((c) => c.llego_al_final).length;
  const origen = sitio ? 'versión del sitio' : `commit ${esc((() => { try { return execSync('git rev-parse --short HEAD', { cwd: RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return 'desconocido'; } })())}`;
  const selloCorridas = Number.isFinite(M.archivos) ? `${N} de ${M.archivos} archivos · ${M.duplicados} duplicado${M.duplicados === 1 ? '' : 's'} · ${M.ilegibles} no se pudieron leer` : String(N);
  const eyebrow = !sitio ? 'Tablero del arnés · vista de corridas · el arnés en seis preguntas: <span class="mono">artifacts/tablero-del-arnes.html</span>, en el repo del arnés'
    : sitio.rol === 'maintainer' ? 'Sitio de la organización · vista de corridas · el arnés en seis preguntas: <a href="/arnes/tablero">el tablero del arnés</a>'
      : 'Sitio de la organización · tus corridas';
  const alcance = !M.multi || (M.maquinas && M.maquinas.solo_esta)
    ? 'esta máquina'
    : [...M.maquinas.lista.map((x) => `${x.nombre} ${x.corridas}`), ...(M.maquinas.sin_declarar ? [`sin declarar ${M.maquinas.sin_declarar}`] : [])].join(' · ') || (sitio ? 'ninguna máquina' : '');   // la vista local, igual que antes
  const bandaBuzon = !M.multi || !M.buzon ? ''
    // al dev del sitio le llega sólo si se leyó entero, sin el número de carpetas (decisión 6, AC 19)
    : M.buzon.parcial !== undefined && !M.buzon.incompleto ? (M.buzon.estado !== 'leido' || M.buzon.parcial ? '<div class="banda gris"><b>Ojo:</b> puede faltar alguna corrida tuya: el buzón no se leyó entero. Lo que falta no es cero.</div>' : '')
    // quien mantiene, en el sitio, cuando la última bajada no terminó entera: se sirve el último armado entero
    : M.buzon.incompleto && M.buzon.estado === 'leido' && !M.buzon.carpetas_ilegibles ? '<div class="banda gris"><b>La última bajada del buzón no terminó entera.</b> Se muestra la última entera: pueden faltar las corridas más nuevas, y eso no es cero.</div>'
    : M.buzon.estado !== 'leido' ? `<div class="banda gris"><b>No se leyó la carpeta bajada del buzón.</b> ${esc(M.buzon.motivo)} — las corridas de otras máquinas faltan, no son cero.</div>`
    : M.buzon.carpetas_ilegibles ? `<div class="banda gris"><b>${M.buzon.carpetas_ilegibles} carpeta${M.buzon.carpetas_ilegibles === 1 ? '' : 's'} de máquina del buzón no se pudo leer.</b> Sus corridas no están en esta página ni en ningún número: faltan, no son cero.</div>`
    : '';
  // story 2.28: sin el archivo de uniones del bajador, la carpeta vieja de una máquina que se mudó sale como otra máquina
  const bandaUniones = M.multi && M.buzon && M.buzon.uniones && M.buzon.uniones.estado === 'no_medidas'
    ? `<div class="banda gris"><b>Carpetas de máquina:</b> uniones de carpetas no medidas (${esc(M.buzon.uniones.motivo)}). Cada carpeta del buzón sale como una máquina aparte, también la vieja de una máquina que se mudó a su carpeta con código.</div>`
    : '';
  // Con corridas del buzón, que esta máquina no tenga registro propio no deja las fichas sin medir: salen sólo
  // con lo bajado. Decir «salen con trama» ahí era una alarma falsa al lado de números (pase adversarial de la 2.16).
  const bandaRegistro = M.registro.estado === 'medido' || M.registro.estado === 'no_aplica' ? ''
    : M.multi && M.corridas.length
      ? `<div class="banda gris"><b>Sin registro de corridas propio en esta máquina.</b> ${esc(M.registro.motivo)} La página sale sólo con lo bajado del buzón: las corridas de esta máquina, si las hay, faltan.</div>`
      : `<div class="banda gris"><b>Sin registro de corridas en esta máquina.</b> ${esc(M.registro.motivo)} Las fichas salen con trama, y eso no es cero.</div>`;
  // 'skill': la tabla de pasos que trae la imagen del sitio (story 2.27) — con nombre, como 'tabla'
  const bandaPasos = (M.pasos.fuente !== 'tabla' && M.pasos.fuente !== 'skill') || M.pasos.motivo ? `<div class="banda gris">${esc(M.pasos.motivo)}</div>` : '';
  const bandaRescate = M.sin_rescate ? `<div class="banda gris">${esc(M.sin_rescate)}</div>` : '';
  const bandaTiempos = M.sin_tiempos ? `<div class="banda gris">${esc(M.sin_tiempos)}</div>` : '';
  const bandaUmbrales = M.umbrales_motivo ? `<div class="banda gris">${esc(M.umbrales_motivo)}</div>` : '';
  return `<header class="head">
  <div class="eyebrow">${eyebrow}</div>
  <h1>Las corridas del pipeline</h1>
  <p class="lede">Una fila por corrida: <b>en qué paso se fue el tiempo</b>, qué control encontró un error o frenó, cuántas vueltas dio y cuánto consumió. Los números salen del resumen que el archivador deja por corrida, y lo que no está registrado se dice, no se rellena. <b>De la conversación sólo se toman los archivos que tocó y sus cambios</b>, en el detalle de cada corrida.</p>
  <div class="stamp"><span><b>Corridas:</b> ${selloCorridas}</span><span><b>Con consumo medido:</b> ${conConsumo} de ${N}</span><span><b>Con controles:</b> ${conControles} de ${N}</span><span><b>Llegaron al paso 8:</b> ${alFinal} de ${N}</span><span><b>Generado:</b> ${esc(M.generado.slice(0, 16).replace('T', ' '))} UTC · ${origen}</span><span><b>Alcance:</b> ${esc(alcance)}</span></div>
  ${bandaBuzon}${bandaUniones}${bandaRegistro}${bandaPasos}${bandaRescate}${bandaTiempos}${bandaUmbrales}
</header>
`;
}

/** La capa ejecutiva: el glosario, el filtro y los contenedores que dibuja el cliente (las fichas y los gráficos). */
function ejecutiva(M) {
  return `<section id="ejecutiva">
  <div class="q-head"><span class="q-n">01</span><h2>Lo que se mira primero</h2></div>
  <div class="claves">
    <div><b>Encontró un error</b><span>una prueba o la compilación no pasaron, y se arreglaron ahí mismo. <b>Es el control haciendo su trabajo.</b></span></div>
    <div><b>Frenó</b><span>el control vio algo y no dejó pasar. También es el control funcionando.</span></div>
    <div><b>Trama</b><span>«no medido»: esa corrida no registró ese dato. <b>No es cero ni es verde.</b></span></div>
    <div><b>n=</b><span>al lado de cada mediana: de cuántas corridas sale el número, sobre cuántas hay.</span></div>
  </div>
  <div class="filtrera"><span class="fl">Filtro</span>
    <label>desde <input type="date" id="f-desde"></label><label>hasta <input type="date" id="f-hasta"></label>
    <label>producto <select id="f-repo"></select></label>${M.varias_maquinas ? `
    <label>máquina <select id="f-maquina"></select></label>` : ''}
    <label><input type="checkbox" id="fc"> sólo con consumo medido</label>
    <label><input type="checkbox" id="ff"> sólo las que llegaron al paso 8</label>
    <button id="f-limpiar">limpiar</button><span class="fcount" id="cuenta"></span></div>
  <div class="grid" id="fichas"></div>
  <div class="dos">
    <div class="card"><h3>Corridas por semana</h3><div id="gsem"></div><p>Semana ISO. Una semana sin corridas se dibuja en cero: una barra ausente y una barra en cero no son lo mismo.</p></div>
    <div class="card"><h3>Pasos por corrida, mes a mes (mediana)</h3><div id="gpasos"></div><p>Cuántas respuestas dio el modelo en cada corrida: <b>es lo que explica su consumo</b>, porque en cada paso relee todo lo anterior. Un punto por mes, con su <span class="mono">n</span>; un mes sin corridas medidas se deja en blanco y se dice — no es cero. La línea punteada es la línea base contra la que se compara. No tiene tope: primero la serie.</p></div>
    <div class="card"><h3>Dónde se va el TIEMPO, por paso (mediana)</h3><div id="ppt"></div><p>Del arranque al fin de cada paso cuando la corrida lo anotó; en las corridas anteriores a esa marca, estimado del fin del paso anterior al fin de éste. El tiempo entre pasos no entra en ningún paso. Los pasos con marcas invertidas o empatadas salen fusionados y no entran en la mediana de ninguno de los dos (se dicen aparte).</p></div>
    <div class="card"><h3>Dónde se van los TOKENS, por paso (mediana)</h3><div id="ppk"></div><p id="nota-tokens"></p></div>
  </div>
</section>
`;
}

/** La tabla, armada en el servidor (decisión 12): usa campos que la lista no lleva (los archivos tocados). */
function tabla(M) {
  const C = M.corridas;
  const escala = Math.max(1, ...C.map((c) => c.tramos.reduce((a, t) => a + t.ms, 0))) * 0.55;
  const filas = C.map((c, idx) => {
    const tk = c.consumo.estado === 'medido'
      ? miles(c.consumo.tokens.out + c.consumo.tokens.in + c.consumo.tokens.cache_new)
      : `<span class="nd" title="${esc(c.consumo.motivo)}">${esc(c.consumo.estado === 'borrada' ? 'borrada' : 'no medido')}</span>`;
    return `<tr data-i="${idx}" data-id="${esc(c.id || '')}" id="c-${idx}">
      <td class="fecha">${esc((c.inicio || '').slice(0, 10) || 'sin fecha')}<small>${esc(c.semana || '')}</small></td>
      <td class="story"><b>${esc(c.story || '—')}</b>${c.descripcion ? `<span class="desc" title="${esc(c.descripcion.texto)}">${esc(c.descripcion.texto)}</span>` : ''}<small>${esc(c.producto || 'producto sin registrar')}</small></td>${M.varias_maquinas ? `
      <td class="maq-td">${c.maquina ? `<span class="maq">${esc(c.maquina)}</span>${c.maquina_nota ? `<small>${esc(c.maquina_nota)}</small>` : ''}` : `<span class="nd" title="${esc(c.maquina_motivo || '')}">sin declarar</span>`}</td>` : ''}
      <td class="barra">${barraTramos(c, escala)}</td>
      <td class="dur">${dur(c.dur_ms)}</td>
      <td class="dur tr">${colTrabajo(c)}</td>
      <td class="dur es">${colEspera(c)}</td>
      <td class="pasos-n">${c.llego_al_final ? '<span class="ok9">llegó al 8</span>' : `<span class="parcial">quedó en el ${c.ultimo_paso === null ? '—' : c.ultimo_paso}</span>`}</td>
      <td class="ag">${c.costo ? c.costo.agentes : '<span class="nd" title="no registra agentes lanzados — no es cero">—</span>'}</td>
      <td class="vu">${c.costo && c.costo.vueltas !== null ? c.costo.vueltas : '<span class="nd">—</span>'}</td>
      <td class="tk">${tk}</td>
      <td class="ar">${colArchivos(c)}</td>
      <td class="frenos">${filaControles(c)}</td>
    </tr>`;
  }).join('\n');

  const leyenda = M.pasos.nombres.map((p, i) => `<span class="lg"><i style="background:${RAMPA[i]}"></i>${i} ${esc(p)}</span>`).join('');
  return `<section>
  <div class="q-head"><span class="q-n">02</span><h2>Corrida por corrida</h2></div>
  <p class="note">Ordenadas de la más nueva a la más vieja. La barra reparte el tiempo por paso con la rampa de abajo. <b>Clic en una fila</b> abre el detalle: la línea de tiempo con cada control en su carril, la tabla de controles y el consumo por paso.</p>
  <div class="leyenda">${leyenda}<span class="lg"><i class="falta"></i>sin marca</span></div>
  <div class="tabla"><table>
    <thead><tr><th>fecha<small>semana ISO</small></th><th>story<small>producto</small></th>${M.varias_maquinas ? '<th>máquina<small>su carpeta</small></th>' : ''}<th>tiempo por paso</th><th>duró</th><th>trabajo<small>pasos con trabajo</small></th><th>espera<small>por una persona</small></th><th>pasos</th><th>agentes</th><th>vueltas</th><th>tokens</th><th>archivos<small>tocados</small></th><th>controles<small>los 3 que más pesan</small></th></tr></thead>
    <tbody id="cuerpo">${filas}</tbody></table></div>
</section>
`;
}

/** El pie: las notas de la vista. En el sitio, «De dónde sale» dice el espejo del buzón (decisión 14). */
function pie(M, opts = {}) {
  const deDondeSale = opts.sitio
    ? 'del espejo del buzón de corridas que el sitio baja con su identidad de sólo lectura; la máquina de cada corrida es su carpeta. Una corrida por sesión: si la misma corrida se subió dos veces, vale la más nueva.'
    : `del registro global del archivador del pipeline (<span class="mono">~/.claude/.tycon-pipeline/timing-history</span>), una corrida por sesión: si la misma corrida se archivó dos veces, vale la más nueva. Lo ilegible se cuenta arriba.${M.multi ? ' <b>Y de la carpeta bajada del buzón de corridas</b> (story 2.16): la máquina de cada corrida es la carpeta que la contiene; lo que no está bajo una carpeta de máquina sale «sin declarar».' : ''}`;
  return `<footer><div class="pie">
  <div><b>De dónde sale</b><span>${deDondeSale}</span></div>
  <div><b>Lo que se publica de git</b><span>los commits que la corrida creó y lo que dejó sin commitear, en cada repo donde escribió, con su parche: es el cambio real, venga de una edición, de la consola o de un subagente. Credenciales, correos, rutas absolutas y UUID salen tapados; tope de largo por archivo y por corrida, dicho donde corta. Las corridas anteriores a la story 2.19 no lo tienen y muestran sólo la conversación.</span></div>
  <div><b>Lo que se publica del hilo</b><span>sólo los archivos que tocó cada corrida, su cambio y sus commits: rutas relativas al repo, credenciales y rutas absolutas tapadas, con tope de largo. Los prompts, las respuestas, los comandos y los identificadores de sesión no. Esta página no se commitea, pero se comparte. El mensaje de cada error llega del rescate de la story 2.13, saneado dos veces.</span></div>
  <div><b>Tokens, no plata</b><span>el registro trae tokens; una tabla de precios adentro del arnés envejece sin que nadie lo note.</span></div>
  <div><b>Lo que se mide de un revisor</b><span>cuánto tardó, cuánto devolvió y —si su notificación lo trajo— cuánto consumió; no lo que leyó. Lo que no se pudo medir se estima aparte y lleva la palabra «estimado», con la fecha de su supuesto: nunca se suma a lo medido.</span></div>
  <div><b>Trabajo, espera y tiempo entre pasos</b><span>cada paso anota cuándo arranca y cuándo termina. <b>Espera</b> es lo que duraron los dos pasos que aguardan a una persona (aprobar el plan y aprobar los hallazgos); <b>trabajo</b>, todos los demás; lo que pasa entre el fin de un paso y el arranque del siguiente es un tramo aparte, rayado, que no se le cobra a ninguno. Las corridas anteriores a esa marca salen <b>estimadas por diferencia</b> y lo dicen; un paso de menos de un minuto se dibuja como una raya: se marcó junto con el anterior.</span></div>
</div></footer>`;
}

function render(M) {
  // El texto de los cambios va FUERA del modelo, comprimido, un bloque por corrida: se descomprime al abrirlo.
  const textos = M.corridas.map((c, i) => (c.cambios && c.cambios._texto ? `<script type="text/plain" id="cz-${i}">${c.cambios._texto}</script>` : '')
    + (c.cambios && c.cambios._textoGit ? `<script type="text/plain" id="cg-${i}">${c.cambios._textoGit}</script>` : '')).join('');
  const modeloJson = JSON.stringify(M, (k, v) => (k === '_texto' || k === '_textoGit' ? undefined : v)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Las corridas del pipeline</title>
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
const CLIENTE = String.raw`(function () {
  // story 2.27: la FUENTE de los datos. Embebida en la página local (el modelo en #modelo y los textos en cz-N/cg-N,
  // sin red); por la red en la pestaña del sitio (#fuente-corridas: la lista, el detalle al abrir una corrida y los
  // textos al abrir un cambio, ya filtrados por el servidor). El resto del cliente es el mismo.
  var FE = typeof document !== 'undefined' && document.getElementById('fuente-corridas');
  var API = FE && FE.dataset && FE.dataset.api;
  if (API) {
    fetch(API, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('el sitio contestó ' + r.status); return r.json(); }).then(function (M) {
      // la tabla vino con la página: si el sitio rearmó entre la página y la lista, se recarga (nunca una mezcla)
      if (FE.dataset.generado && M.generado !== FE.dataset.generado) { location.reload(); return; }
      vista(M, fuenteRed(M));
    }).catch(function (err) { var f = document.getElementById('fichas'); if (f) f.textContent = 'no se pudo traer la lista de corridas: ' + err.message; });
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
    var pedir = function (ruta) { return fetch(ruta, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('el sitio contestó ' + r.status); return r.json(); }); };
    return { forma: 'red',
      detalle: function (i, fn, falla) {
        if (det[i]) { fn(det[i]); return; }
        // la falla de la RED va a «falla»; una falla al dibujar el detalle no se disfraza de «no se pudo traer»
        pedir(API + '/' + encodeURIComponent(M.corridas[i].id)).then(function (d) { det[i] = d; fn(d); }, function (err) { if (falla) falla(err); })
          // una falla al DIBUJAR el detalle tampoco queda muda: la fila lo dice, y la consola lleva el error
          .catch(function (err) { if (typeof console !== 'undefined') console.error(err); if (falla) { var e = new Error('no se pudo dibujar el detalle: ' + (err && err.message ? err.message : String(err))); e.alDibujar = true; falla(e); } });
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
  var RAMPA = ['#BEE0DE','#9CD0CE','#79BFBE','#57ADAE','#3D9799','#2C8084','#1E6A70','#14555C','#0D4148'];
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); };
  var n1 = function (x) { return (Math.round(x * 10) / 10).toString().replace('.', ','); };
  var miles = function (n) { return n == null ? '—' : n >= 1e6 ? n1(n / 1e6) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n); };
  var dt = function (min) { return min < 90 ? Math.round(min) + ' min' : n1(min / 60) + ' h'; };
  var nombreCtl = function (k) { return CTL[k] ? CTL[k] + ' (' + k + ')' : k; };
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
    if (c.consumo.estado === 'medido' && c.consumo.fuera_de_ventana) notas.push('+' + miles(c.consumo.fuera_de_ventana) + ' tokens se consumieron <b>después del último paso</b> registrado: quedan fuera del eje y no se reparten.');
    if (c.eventos_previos) notas.push(c.eventos_previos + ' evaluación(es) de control son <b>anteriores al inicio</b> de esta corrida (la misma sesión corrió otro pipeline antes): no se dibujan.');
    var durMin = c.dur_ms ? c.dur_ms / 60000 : null;
    var finTramos = c.tramos.reduce(function (a, t) { return a + t.ms / 60000; }, 0);
    var conT = c.eventos.filter(function (e) { return e.t !== null; });
    var sinT = c.eventos.length - conT.length;
    if (sinT) notas.push(sinT + ' evaluación(es) <b>sin minuto</b>: la corrida no anotó su hora de inicio, así que no se dibujan en el eje pero sí cuentan en la tabla y en la lista.');
    var eds = (c.cambios && c.cambios.estado === 'leido') ? c.cambios.lista.filter(function (e) { return e.t !== null && e.t >= 0; }) : [];
    var maxT = Math.max(durMin || 0, finTramos,
      conT.reduce(function (a, e) { return Math.max(a, e.t); }, 0),
      eds.reduce(function (a, e) { return Math.max(a, e.t); }, 0),
      c.vueltas_ts.reduce(function (a, t) { return Math.max(a, t); }, 0));
    if (!Number.isFinite(maxT) || maxT <= 0) return '<p class="tlnota">no se pudo calcular la escala de tiempo de esta corrida — no se dibuja un eje inventado</p>';
    var W = 1080, x0 = 300, x1 = W - 14;
    var X = function (t) { return x0 + (t / maxT) * (x1 - x0); };
    var tipos = [], conteo = {};
    conT.forEach(function (e) { conteo[e.control] = (conteo[e.control] || 0) + 1; if (tipos.indexOf(e.control) < 0) tipos.push(e.control); });
    tipos.sort(function (a, b) { return conteo[b] - conteo[a] || a.localeCompare(b); });
    var lanes = [{ k: 'pasos', t: 'Pasos', h: 26 }];
    if (c.cambios) lanes.push({ k: 'act', t: 'Archivos tocados', h: 22 });
    if (c.cambios) lanes.push({ k: 'tok', t: 'Consumo', h: 34 });
    tipos.forEach(function (t) { lanes.push({ k: 'c:' + t, t: t, h: 15, ctl: t }); });
    if (!tipos.length) lanes.push({ k: 'c:', t: 'Controles', h: 22 });
    var y = 16, ys = {};
    lanes.forEach(function (l, i3) { if (l.ctl && (i3 === 0 || !lanes[i3 - 1].ctl)) y += 12; ys[l.k] = y; y += l.h + (l.ctl ? 3 : 12); });
    var H = y + 40;
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="min-width:760px;display:block" role="img" aria-label="Línea de tiempo de la corrida.">';
    ejeTicks(maxT).forEach(function (t) {
      s += '<line x1="' + X(t).toFixed(1) + '" y1="10" x2="' + X(t).toFixed(1) + '" y2="' + (H - 34) + '" stroke="var(--line)"></line>';
      s += '<text x="' + X(t).toFixed(1) + '" y="' + (H - 18) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="10" fill="var(--ink-3)">' + (t >= 60 ? n1(t / 60) + ' h' : t + '′') + '</text>';
    });
    var lf = lanes.filter(function (l) { return l.ctl; });
    if (lf.length) {
      var y1g = ys[lf[0].k], y2g = ys[lf[lf.length - 1].k] + lf[lf.length - 1].h;
      s += '<line x1="' + (x0 - 6) + '" y1="' + y1g + '" x2="' + (x0 - 6) + '" y2="' + y2g + '" stroke="var(--accent)" stroke-width="2"></line>';
      s += '<text x="' + (x0 - 14) + '" y="' + (y1g - 6) + '" text-anchor="end" font-family="IBM Plex Mono,monospace" font-size="10" letter-spacing="1.2" fill="var(--accent)">CONTROLES DEL PIPELINE</text>';
    }
    lanes.forEach(function (l) {
      var f = l.ctl;
      s += '<text x="' + (x0 - 8) + '" y="' + (ys[l.k] + l.h / 2 + (f ? 3.5 : 4)) + '" text-anchor="end" font-family="' + (f ? 'IBM Plex Mono,monospace' : 'IBM Plex Sans,sans-serif') + '" font-size="' + (f ? 10 : 11) + '" fill="var(--ink-' + (f ? '3' : '2') + ')">' + esc(f ? nombreCtl(l.t) : l.t) + '</text>';
      if (f) s += '<line x1="' + x0 + '" y1="' + (ys[l.k] + l.h / 2) + '" x2="' + x1 + '" y2="' + (ys[l.k] + l.h / 2) + '" stroke="var(--line)" stroke-dasharray="2 4"></line>';
    });
    // pasos (tramos)
    var acc = 0;
    c.tramos.forEach(function (p) {
      var a = X(acc), b = X(acc + p.ms / 60000); acc += p.ms / 60000;
      var w = Math.max(1.2, b - a), i = p.pasos[0];
      if (p.tipo === 'entre') {
        if (p.ms >= 60000) s += '<rect x="' + a.toFixed(1) + '" y="' + (ys.pasos + 9) + '" width="' + w.toFixed(1) + '" height="8" fill="url(#hatch)"><title>entre pasos — ' + dt(p.ms / 60000) + ' sin ningún paso abierto: no se le cobra a ninguno</title></rect>';
        return;
      }
      if (p.ms < 60000) {
        s += '<line x1="' + a.toFixed(1) + '" y1="' + (ys.pasos - 3) + '" x2="' + a.toFixed(1) + '" y2="' + (ys.pasos + 29) + '" stroke="var(--ink-3)" stroke-width="1.2"><title>paso ' + esc(p.paso) + ' · ' + esc(p.nombre) + ' — marcado junto con el anterior (menos de un minuto): no tuvo tiempo propio</title></line>';
        return;
      }
      s += '<rect x="' + a.toFixed(1) + '" y="' + ys.pasos + '" width="' + w.toFixed(1) + '" height="26" fill="' + (RAMPA[i] || RAMPA[8]) + '" rx="1.5"><title>paso ' + esc(p.paso) + ' · ' + esc(p.nombre) + ' — ' + dt(p.ms / 60000) + (p.pasos.length > 1 ? ' (marcas invertidas o empatadas: fusionados)' : '') + (p.medida === false ? ' (estimada por diferencia)' : '') + '</title></rect>';
      if (w > 26) s += '<text x="' + (a + w / 2).toFixed(1) + '" y="' + (ys.pasos + 17) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="10.5" font-weight="600" fill="' + (i > 4 ? '#fff' : '#0D4148') + '">' + esc(p.paso) + '</text>';
    });
    // La espera por una persona que salió del hilo: una banda rayada sobre los pasos, con su duración.
    ((c.cambios && c.cambios.esperas_min) || []).forEach(function (w) {
      var ea = X(Math.max(0, w[0])), eb = X(Math.min(maxT, w[1]));
      if (eb - ea < 1) return;
      s += '<rect x="' + ea.toFixed(1) + '" y="' + (ys.pasos - 4) + '" width="' + (eb - ea).toFixed(1) + '" height="34" fill="url(#espera)" stroke="var(--warn)" stroke-width=".8"><title>esperando a una persona — ' + dt(w[1] - w[0]) + ' (del minuto ' + Math.round(w[0]) + ' al ' + Math.round(w[1]) + '): una pregunta sin responder o un turno que esperó un mensaje. No es trabajo.</title></rect>';
      if (eb - ea > 60) s += '<text x="' + ((ea + eb) / 2).toFixed(1) + '" y="' + (ys.pasos + 17) + '" text-anchor="middle" font-family="IBM Plex Sans,sans-serif" font-size="10" font-weight="600" fill="var(--warn)">esperando ' + dt(w[1] - w[0]) + '</text>';
    });
    if (c.sin_marca.length) s += '<rect x="' + X(acc).toFixed(1) + '" y="' + ys.pasos + '" width="' + Math.max(4, x1 - X(acc)).toFixed(1) + '" height="26" fill="url(#hatch)"><title>' + c.sin_marca.length + ' paso(s) sin marca</title></rect>';
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
          + '<title>' + bal[k] + ' cambio' + (bal[k] === 1 ? '' : 's') + ' de archivos entre el minuto ' + desde + ' y el ' + hasta + ' — clic para verlos</title></g>';
      });
    } else if (c.cambios) {
      s += '<rect x="' + x0 + '" y="' + ys.act + '" width="' + (x1 - x0) + '" height="22" fill="url(#hatch)"></rect>';
      s += '<text x="' + (x0 + 8) + '" y="' + (ys.act + 15) + '" font-family="IBM Plex Sans,sans-serif" font-size="11" fill="var(--ink-3)">' + (c.cambios.estado === 'leido' ? (c.cambios.por_consola ? 'cambió archivos desde la consola, no con las herramientas de edición: sin antes y después' : 'según su hilo, no editó ni escribió archivos') : c.cambios.estado === 'sin_hilo' ? 'sin hilo: no se sabe qué archivos tocó' : 'los archivos que tocó no se publican: ' + esc(c.cambios.motivo || '')) + '</text>';
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
          + '<title>' + miles(b2[k2]) + ' tokens entre el minuto ' + d2 + ' y el ' + h2 + ' — clic para ver en qué se fue</title></g>';
      });
      if (post) notas.push(miles(post) + ' tokens del hilo son <b>posteriores al cierre</b> de la corrida: quedan fuera del eje.');
    } else if (c.cambios) {
      s += '<rect x="' + x0 + '" y="' + ys.tok + '" width="' + (x1 - x0) + '" height="34" fill="url(#hatch)"></rect>';
      s += '<text x="' + (x0 + 8) + '" y="' + (ys.tok + 21) + '" font-family="IBM Plex Sans,sans-serif" font-size="11" fill="var(--ink-3)">' + (c.cambios.estado === 'sin_hilo' ? 'sin hilo: no hay consumo minuto a minuto que mostrar, y eso no es cero' : 'sin consumo minuto a minuto en el hilo de esta corrida') + '</text>';
    }
    // controles, cada uno en su carril
    if (conT.length) {
      conT.forEach(function (e) {
        var x = X(e.t), yy = ys['c:' + e.control] + 7.5;
        var PAL = { paso: 'miró y dejó pasar', error: 'ENCONTRÓ UN ERROR', freno: 'NO DEJÓ PASAR: el control frenó algo', sin_estado: 'sin estado registrado', otro: 'estado no reconocido' };
        var tit = '<title>' + esc(nombreCtl(e.control)) + ' — ' + PAL[e.cls] + (e.nota ? ' · ' + esc(e.nota) : '') + (e.ms ? ' · ' + n1(e.ms / 1000) + ' s' : '') + ' · minuto ' + e.t + '</title>';
        if (e.cls === 'error') s += '<path d="M' + x.toFixed(1) + ',' + (yy - 5) + ' L' + (x + 4.6).toFixed(1) + ',' + (yy + 3.6) + ' L' + (x - 4.6).toFixed(1) + ',' + (yy + 3.6) + ' Z" fill="var(--crit)">' + tit + '</path>';
        else if (e.cls === 'freno') s += '<rect x="' + (x - 3.8).toFixed(1) + '" y="' + (yy - 3.8) + '" width="7.6" height="7.6" fill="var(--accent)">' + tit + '</rect>';
        else if (e.cls === 'sin_estado' || e.cls === 'otro') s += '<circle cx="' + x.toFixed(1) + '" cy="' + yy + '" r="3.6" fill="none" stroke="var(--ink-3)" stroke-width="1.2" stroke-dasharray="2 2">' + tit + '</circle>';
        else s += '<circle cx="' + x.toFixed(1) + '" cy="' + yy + '" r="4" fill="var(--good-soft)" stroke="var(--good)" stroke-width="1.8">' + tit + '</circle>';
      });
    } else {
      s += '<rect x="' + x0 + '" y="' + ys['c:'] + '" width="' + (x1 - x0) + '" height="22" fill="url(#hatch)"></rect>';
      s += '<text x="' + (x0 + 8) + '" y="' + (ys['c:'] + 15) + '" font-family="IBM Plex Sans,sans-serif" font-size="11" fill="var(--ink-3)">' + (c.controles ? 'ninguna evaluación cae dentro de esta corrida' : 'esta corrida no registró controles — no quiere decir que hayan salido verdes') + '</text>';
    }
    c.vueltas_ts.forEach(function (t, i) {
      var x = X(t);
      s += '<line x1="' + x.toFixed(1) + '" y1="10" x2="' + x.toFixed(1) + '" y2="' + (H - 34) + '" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="3 3"><title>vuelta de revisión ' + (i + 1) + ' · minuto ' + t + '</title></line>';
      s += '<text x="' + (x + 3).toFixed(1) + '" y="14" font-family="IBM Plex Mono,monospace" font-size="9.5" fill="var(--warn)">v' + (i + 1) + '</text>';
    });
    s += '<defs><pattern id="espera" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="var(--surface)" opacity=".82"></rect><line x1="0" y1="0" x2="0" y2="8" stroke="var(--warn)" stroke-width="2" opacity=".6"></line></pattern><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(135)"><rect width="6" height="6" fill="var(--surface-2)"></rect><line x1="0" y1="0" x2="0" y2="6" stroke="var(--hatch)" stroke-width="1.6" opacity=".55"></line></pattern></defs>';
    return s + '</svg>';
  }

  function tarjetaControles(c) {
    if (!c.controles) return '<div class="mini blind ancha"><h4>Controles</h4><p>esta corrida no registró controles — no quiere decir que hayan salido verdes. Gris con motivo, nunca verde.</p></div>';
    var f = c.controles.por_control;
    var peso = function (v) { return v.error * 1000 + v.freno * 10 + v.n / 1000; };
    var filas = Object.keys(f).sort(function (a, b) { return peso(f[b]) - peso(f[a]); }).map(function (k) {
      return '<tr><td class="ctl"><span class="ctl-es">' + esc(ctlEs(k)) + '</span>' + (ctlTec(k) ? '<span class="ctl-tec">' + esc(ctlTec(k)) + '</span>' : '') + '</td>'
        + '<td class="num">' + f[k].n + '</td><td class="num ' + (f[k].error ? 'rojo' : '') + '">' + (f[k].error || '·') + '</td>'
        + '<td class="num">' + (f[k].freno || '·') + '</td><td class="num">' + (f[k].sin_estado || '·') + '</td>'
        + '<td class="num">' + (f[k].ms ? n1(f[k].ms / 1000) + ' s' : '—') + '</td></tr>';
    }).join('');
    return '<div class="mini ancha"><h4>Controles — ' + c.controles.total + ' evaluaciones: ' + c.controles.error + ' con error, ' + c.controles.freno + ' frenaron'
      + (c.controles.sin_estado ? ', ' + c.controles.sin_estado + ' sin estado' : '') + (c.eventos_previos ? ' · ' + c.eventos_previos + ' anteriores al inicio, no contadas' : '') + '</h4>'
      + '<table class="mt ctls"><colgroup><col><col class="c-veces"><col class="c-error"><col class="c-freno"><col class="c-sin"><col class="c-tiempo"></colgroup>'
      + '<tr><th>control</th><th>veces</th><th>con error</th><th>frenó</th><th>sin estado</th><th>tiempo</th></tr>' + filas + '</table>'
      + '<p>«Frenó» es que el control no dejó pasar: eso es el control funcionando, no un problema.</p></div>';
  }

  // Lo que cuesta la revisión (story 2.15): lo MEDIDO con su número y su denominador, lo ESTIMADO con
  // la palabra y en otra marca. Sin bloque: «sin medir», nunca «0 tokens».
  function loQueGastaron(c) {
    var r = c.revisores;
    if (!r) return '';
    if (r.estado === 'sin_medir') return '<p class="rev-nd">sin medir los revisores — ' + esc(r.motivo) + '</p>';
    var partes = [];
    var N = r.lanzamientos == null ? '?' : r.lanzamientos;
    partes.push(r.duracion_ms.mediana != null
      ? '<span class="rev-med">tardaron ' + Math.round(r.duracion_ms.mediana / 1000) + ' s (mediana, n=' + r.duracion_ms.n + ' de ' + N + ')</span>'
      : '<span class="rev-nd" title="' + esc(r.duracion_ms.motivo) + '">duración no medida</span>');
    partes.push(r.devuelto_bytes.mediana != null
      ? '<span class="rev-med">devolvieron ' + (r.devuelto_bytes.mediana >= 1024 ? (r.devuelto_bytes.mediana / 1024).toFixed(1) + ' KB' : Math.round(r.devuelto_bytes.mediana) + ' bytes') + ' (mediana)</span>'
      : '<span class="rev-nd" title="' + esc(r.devuelto_bytes.motivo) + '">tamaño de los informes no medido</span>');
    partes.push(r.tokens_medidos.total != null
      ? '<span class="rev-med">consumieron ' + miles(r.tokens_medidos.total) + ' tokens <b>medidos</b> (n=' + r.tokens_medidos.n + ' de ' + N + ')</span>'
      : '<span class="rev-nd" title="' + esc(r.tokens_medidos.motivo) + '">tokens no medidos</span>');
    var e = r.estimado;
    if (e.estado === 'estimado') {
      partes.push('<span class="rev-est"><b>estimado</b>: entre ' + miles(e.tokens_min) + ' y ' + miles(e.tokens_max) + ' tokens para ' + e.lanzamientos_cubiertos + ' sin medir (supuesto del ' + esc(e.medido_el || '?') + ')</span>');
    } else if (e.estado === 'vacio') {
      partes.push('<span class="rev-nd">nada que estimar: todos con tokens medidos</span>');
    } else {
      partes.push('<span class="rev-nd" title="' + esc(e.motivo || '') + '">estimado no disponible' + (e.lanzamientos_sin_medir ? ' para ' + e.lanzamientos_sin_medir + ' sin medir' : '') + ' — ' + esc(e.motivo || '') + '</span>');
    }
    // Dos padrones distintos pueden no coincidir: el archivador cuenta lo que registró el hook; el
    // medidor, lo que vio en la conversación cuando el registro ya se resumió. Se dice, no se tapa.
    if (c.costo && r.lanzamientos != null && r.lanzamientos !== c.costo.agentes) partes.push('<span class="rev-nd">' + r.lanzamientos + ' lanzamientos vistos en la conversación; el archivador contó ' + c.costo.agentes + '</span>');
    if (r.sin_resultado) partes.push('<span class="rev-nd">' + r.sin_resultado + ' no volvieron (sin resultado: no cuentan como cero)</span>');
    if (r.no_ubicados) partes.push('<span class="rev-nd">' + r.no_ubicados + ' sin ubicar en la conversación</span>');
    if (r.fuera_del_registro) partes.push('<span class="rev-nd">' + r.fuera_del_registro + ' vistos en la conversación que el registro no anotó (entran al padrón, vuelta «sin registro»)</span>');
    return '<p class="kv rev' + (r.fuente ? ' rev-' + esc(r.fuente) : '') + '">' + partes.join(' · ') + '</p>'
      + (r.estado !== 'medido' && r.motivo ? '<p class="rev-nd">' + esc(r.motivo) + '</p>' : '');
  }

  // El validador de stories por fase (story 7.3): qué dijo en cada momento de la corrida, con la palabra
  // «sin veredicto» cuando no dejó el renglón, y en cuántos re-loops el pipeline no lo relanzó.
  var FASES_VAL = [['antes-de-implementar', 'antes de implementar'], ['vuelta-1', 'vuelta 1'], ['re-loop', 're-loops'], ['otra-story', 'otras stories'], ['sin-vuelta', 'sin vuelta']];
  function delValidador(c) {
    var v = c.validador;
    if (!v) return '';
    var rel = v.re_loops_decididos ? ' · no se relanzó en ' + v.re_loops_sin_relanzar + ' de ' + v.re_loops_decididos + ' re-loops' : '';
    if (v.estado !== 'medido') return '<p class="rev-nd">validador de stories: ' + esc(v.motivo || 'sin veredicto medido') + rel + '</p>';
    if (!v.lanzamientos) return rel ? '<p class="rev-nd">validador de stories' + rel + '</p>' : '';
    var partes = FASES_VAL.filter(function (p) { return v.por_fase[p[0]].lanzamientos; }).map(function (p) {
      var x = v.por_fase[p[0]], q = [];
      if (x.limpio) q.push(x.limpio + ' limpio' + (x.limpio > 1 ? 's' : ''));
      if (x.hallazgos) q.push(x.hallazgos + ' con hallazgos');
      if (x.inconsistente) q.push(x.inconsistente + ' inconsistente' + (x.inconsistente > 1 ? 's' : ''));
      if (x.sin_veredicto) q.push(x.sin_veredicto + ' sin veredicto');
      if (x.no_medido) q.push(x.no_medido + ' sin resultado');
      return esc(p[1]) + ': ' + q.join(', ');
    });
    return '<p class="kv rev">validador de stories — ' + partes.join(' · ') + rel + '</p>';
  }

  function tarjetaAgentes(c) {
    if (!c.costo) return '<div class="mini blind"><h4>Revisores</h4><p>esta corrida no registra agentes lanzados (es anterior al conteo mecánico) — no es «cero agentes»</p>' + loQueGastaron(c) + delValidador(c) + '</div>';
    var t = c.costo.por_tipo, ks = Object.keys(t).sort(function (a, b) { return t[b] - t[a]; });
    var mx = Math.max.apply(null, [1].concat(ks.map(function (k) { return t[k]; })));
    return '<div class="mini"><h4>Revisores — ' + c.costo.agentes + ' agentes' + (c.costo.vueltas !== null ? ' en ' + c.costo.vueltas + ' vuelta(s)' : '') + (c.costo.calculos_del_set !== null && c.costo.calculos_del_set !== undefined ? ' <span class="rev-nd">(set de revisores calculado ' + c.costo.calculos_del_set + ' veces)</span>' : '') + '</h4>'
      + loQueGastaron(c)
      + delValidador(c)
      + (ks.length ? '<div class="bars">' + ks.map(function (k) { return '<div class="b"><span>' + esc(k.replace(/^tycon-/, '')) + '</span><i style="width:' + ((t[k] / mx) * 100).toFixed(0) + '%"></i><b>' + t[k] + '</b></div>'; }).join('') + '</div>' : '<p>sin desglose por tipo</p>') + '</div>';
  }

  function tarjetaConsumo(c) {
    var k = c.consumo;
    if (k.estado !== 'medido') return '<div class="mini blind"><h4>Consumo — no medido</h4><p>' + esc(k.motivo) + '</p></div>';
    var pp = k.por_paso, ks = Object.keys(pp).sort(function (a, b) { return pp[b] - pp[a]; });
    var mx = Math.max.apply(null, [1].concat(ks.map(function (x) { return pp[x]; })));
    var nombrePaso = function (key) { return key.split('+').map(function (p) { return PASOS[+p] || p; }).join(' + '); };
    return '<div class="mini"><h4>Consumo — ' + miles(tokensDe(c)) + ' tokens</h4>'
      + '<p class="kv">' + miles(k.tokens.out) + ' de salida · ' + miles(k.tokens.cache_new) + ' de caché nueva · ' + miles(k.tokens.cache_read) + ' leídos de caché · ' + (k.respuestas == null ? '?' : k.respuestas) + ' respuestas</p>'
      + '<p class="kv">modelos: ' + Object.keys(k.por_modelo).map(function (m) { return esc(m) + ' ' + k.por_modelo[m].respuestas; }).join(' · ') + '</p>'
      + '<div class="bars">' + ks.map(function (i) { return '<div class="b"><span>' + esc(i) + ' ' + esc(nombrePaso(i)) + '</span><i style="width:' + ((pp[i] / mx) * 100).toFixed(0) + '%;background:' + (RAMPA[+i.split('+')[0]] || RAMPA[8]) + '"></i><b>' + miles(pp[i]) + '</b></div>'; }).join('') + '</div>'
      + (k.fuera_de_ventana ? '<p class="kv">' + miles(k.fuera_de_ventana) + ' fuera de todo paso (trabajo posterior al último registrado) — se cuenta aparte, no se reparte</p>' : '')
      + '</div>';
  }

  function tarjetaLoQueEncontraron(c) {
    if (!c.controles) return '';
    var g = c.eventos_agrupados;
    if (!g.length) return '<div class="mini"><h4>Qué encontraron los controles</h4><p>en esta corrida ningún control encontró un error ni tuvo que frenar nada</p></div>';
    var PAL = { error: 'encontró un error', freno: 'no dejó pasar' };
    return '<div class="mini"><h4>Qué encontraron los controles — ' + c.controles.error + ' con error · ' + c.controles.freno + ' frenaron</h4>'
      + '<ul class="nopaso">' + g.map(function (e) {
        var cuando = e.t === null ? 'sin minuto' : (e.n > 1 && e.hasta !== e.t ? 'min ' + e.t + '–' + e.hasta : 'min ' + e.t);
        return '<li class="' + e.cls + '"><span class="np-t">' + cuando + '</span>'
          + '<span class="np-n">' + esc(nombreCtl(e.control)) + ' <b>' + PAL[e.cls] + '</b>'
          + (e.n > 1 ? ' <u class="np-x">×' + e.n + '</u>' : '')
          + (e.exit !== null ? ' <i>salida ' + e.exit + '</i>' : '') + '</span>'
          + (e.nota ? '<span class="np-m">' + esc(e.nota) + '</span>' : '')
          + (e.n > 1 ? '<span class="np-m">volvió a rebotar ' + e.n + ' veces seguidas sobre lo mismo</span>' : '')
          + (e.mensaje ? '<span class="np-r">rescatado del hilo (story 2.13), saneado</span><pre class="np-s">' + esc(e.mensaje) + '</pre>' : '')
          + (!e.mensaje && e.cls === 'error' ? '<span class="np-m falta">' + (e.mensaje_estado === 'retenido' ? 'el registro trae el mensaje, pero el saneado (tokens-digest.js) no está en esta máquina: no se publica sin sanear' : 'el registro no guarda el motivo; el mensaje se rescata del hilo cuando la conversación seguía viva (story 2.13) — acá no había de dónde') + '</span>' : '')
          + '</li>';
      }).join('') + '</ul>'
      + '<p>Las dos cosas son el control haciendo su trabajo. <b>Encontró un error</b> = una prueba o la compilación no pasaron, y se arreglaron ahí mismo. <b>No dejó pasar</b> = el control vio algo y frenó antes de seguir. Los rebotes idénticos y seguidos se agrupan (×N); dos iguales separados por otro evento no, porque son dos momentos.</p></div>';
  }

  // story 2.7: qué parte del eje está medida y cuál estimada — dicho en la ficha, no deducible del dibujo.
  function notaTiempos(c) {
    var t = c.tiempos;
    if (!t) return '';
    var partes = [];
    if (t.estado === 'estimada') partes.push(' <b>Duraciones estimadas por diferencia</b>: esta corrida no anotó el arranque de sus pasos, así que cada paso va del fin del anterior al fin de éste y el tiempo muerto queda adentro.');
    else if (t.estado === 'parcial') partes.push(' <b>Algunas duraciones estimadas por diferencia</b> (paso' + (t.estimados.length === 1 ? ' ' : 's ') + esc(t.estimados.join(', ')) + '): no anotaron su arranque.');
    if (t.trabajo_ms !== null) partes.push(' Trabajo ' + dt(t.trabajo_ms / 60000) + (t.espera_humana_ms !== null ? ' · espera ' + dt(t.espera_humana_ms / 60000) : ' · espera sin medir') + (t.entre_pasos_ms !== null ? ' · entre pasos ' + dt(t.entre_pasos_ms / 60000) : '') + '.');
    return partes.join('');
  }

  // ─── los archivos que tocó (2026-09-17) ───
  function tarjetaCambios(c, idx) {
    var x = c.cambios;
    if (!x) return '';
    var hayGit = !!(x.git && x.git.estado === 'medido');
    var h = '<div class="cambios"><h4>Archivos que tocó</h4>';
    if (hayGit) h += bloqueGit(x.git, idx, x.estado === 'leido');
    else if (x.git && x.git.estado !== 'sin_cambio') h += '<p class="nd"><b>según git:</b> ' + esc(x.git.motivo || x.git.estado) + '</p>';
    return h + conversacion(x, idx, hayGit) + '</div>';
  }
  // Arriba: lo que dejó la corrida según git (story 2.19). Una fila por archivo; sus partes (un commit, o
  // «sin commitear») se abren a pedido, cada una con su parche. No se suman: dos diffs sumados no son un diff.
  function bloqueGit(g, idx, conLista) {
    var nC = g.commits.length, nR = g.repos.length, s = function (n) { return n === 1 ? '' : 's'; };
    var h = '<h4>Cómo quedó cada archivo · según git</h4><p>' + g.total_archivos + ' archivo' + s(g.total_archivos) + ' en ' + nR + ' repo' + s(nR) + ': '
      + (nC ? nC + ' commit' + s(nC) + ' de la corrida' : 'ningún commit de la corrida') + ' y lo que quedó sin commitear al cerrar. '
      + 'Es el cambio real, venga de una edición, de la consola o de un subagente. Las credenciales, los correos, las rutas absolutas y los UUID salen tapados.'
      + (g.sin_parche_por_tope ? ' <b>' + g.sin_parche_por_tope + ' parte' + s(g.sin_parche_por_tope) + ' sin texto</b>: pasan del tope por corrida.' : '') + '</p>';
    var avisos = [];
    g.repos.forEach(function (r) {
      if (r.previo) avisos.push('en <b>' + esc(r.n) + '</b>, ' + r.previo + ' archivo' + (r.previo === 1 ? ' que ya estaba' : 's que ya estaban') + ' sin commitear antes de la corrida no se muestra' + (r.previo === 1 ? '' : 'n'));
      if (r.otras === null) avisos.push('en <b>' + esc(r.n) + '</b> no se sabe si escribió otra sesión: ' + esc(r.otras_motivo || 'sin motivo declarado'));
      else if (r.otras) avisos.push('en <b>' + esc(r.n) + '</b> escribió también otra sesión mientras corría (' + r.otras + '): lo no commiteado puede ser de la otra');
      // Copia compartida: lo que el hilo atribuyó a otra sesión se dice con su asunto (no se esconde), y lo que
      // no se pudo atribuir queda en la lista, marcado en cada parte.
      if (r.de_otras && r.de_otras.length) {
        var nO = r.de_otras.length;
        avisos.push('en <b>' + esc(r.n) + '</b>, ' + nO + ' commit' + s(nO) + ' de otra' + s(nO) + ' sesi' + (nO === 1 ? 'ón' : 'ones') + ' no se cuenta' + s(nO) + ': '
          + r.de_otras.slice(0, 5).map(function (k) { return '<span class="mono">' + esc(k.h.slice(0, 7)) + '</span> ' + esc(k.s); }).join(' · ') + (nO > 5 ? ' · +' + (nO - 5) + ' más' : ''));
      }
      var dudosos = g.commits.filter(function (k, ci) { return k.r === g.repos.indexOf(r) && k.at; }).length;
      if (dudosos) avisos.push('en <b>' + esc(r.n) + '</b>, ' + dudosos + ' commit' + s(dudosos) + ' no se pudo confirmar como de esta sesión y se muestra' + s(dudosos) + ' marcado' + s(dudosos) + (r.atrib_motivo ? ': ' + esc(r.atrib_motivo) : ''));
      if (r.estado !== 'medido') avisos.push('<b>' + esc(r.n) + '</b> no se pudo mirar: ' + esc(r.motivo || 'sin motivo declarado'));
      else if (r.commits_motivo) avisos.push('<b>' + esc(r.n) + '</b>: ' + esc(r.commits_motivo) + ' — sale sólo lo no commiteado');
    });
    if (avisos.length) h += '<p class="nd">' + avisos.join(' · ') + '</p>';
    var noMedidos = g.repos.filter(function (r) { return r.estado !== 'medido'; });
    if (!g.archivos.length) {
      return h + '<p>' + (noMedidos.length
        ? 'no se pudo mirar ' + (noMedidos.length === g.repos.length ? 'ningún repo' : noMedidos.length + ' de los ' + g.repos.length + ' repos') + ' de esta corrida: por eso no hay archivos, y eso no es «no cambió nada»'
        : 'según git, esta corrida no dejó cambios: ningún commit propio y nada sin commitear') + '.</p>';
    }
    return h + '<ol class="cg">' + g.archivos.map(function (a, ai) {
      var p0 = a.partes[0];
      var nums = a.partes.length > 1 ? '<span class="nd">en ' + a.partes.length + ' partes</span>'
        : p0.b ? '<span class="nd">binario</span>' : p0.mas === null ? '<span class="nd">' + esc(p0.om || 'sin números') + '</span>'
        : '<span class="mas">+' + p0.mas + '</span> <span class="menos">−' + p0.menos + '</span>';
      return '<li><details data-cg="' + idx + '" data-a="' + ai + '"><summary><span class="ruta">' + esc(a.f) + '</span> ' + nums + '</summary><div class="cg-txt">abriendo…</div></details>'
        + (conLista ? '<button class="cg-f" data-g="' + ai + '">en la conversación</button>' : '') + '</li>';
    }).join('') + '</ol>';
  }
  // Abajo: cada cambio en orden, leído de la conversación. El minuto de una edición con herramientas es exacto;
  // el de la consola, aproximado (el archivo se deduce del texto del comando), y así se muestra.
  function conversacion(x, idx, hayGit) {
    var h = hayGit ? '<h4>Cada cambio, en orden · según la conversación</h4>' : '';
    if (x.estado !== 'leido') return h + '<p class="nd">' + (x.estado === 'sin_hilo' ? '<b>sin hilo</b> — ' : '') + esc(x.motivo || '') + '</p>';
    var consola = x.por_consola ? ' <b>Corrió ' + x.por_consola + ' comando' + (x.por_consola === 1 ? '' : 's') + ' de consola que escriben archivos</b> (un script, un reemplazo en el lugar): de eso el hilo guarda el comando, no un antes y después, así que en la lista salen «por consola», con el comando como cambio y el minuto aproximado.' + (x.en_commits ? ' Sus commits llevaron <b>' + x.en_commits + ' archivo' + (x.en_commits === 1 ? '' : 's') + '</b>.' : '') : '';
    var aprox = hayGit ? '' : ' <b>según la conversación: lo hecho por consola se reconoce por aproximación y lo de los subagentes no está</b>.';
    if (!x.lista.length) return h + '<p>según su hilo, esta corrida no editó ni escribió archivos' + (x.anteriores_al_inicio ? ' (' + x.anteriores_al_inicio + ' ediciones de la misma sesión son anteriores a su inicio y no cuentan)' : '') + '.</p>' + commitsHtml(x);
    var vis = x.lista.filter(function (e) { return !e.o; });
    h += '<p>' + (hayGit ? '' : x.archivos.length + ' archivo' + (x.archivos.length === 1 ? '' : 's') + ' · ') + vis.length + ' cambio' + (vis.length === 1 ? '' : 's') + ', en orden. Cada cambio se abre a pedido y se muestra <b>entero</b> (sólo un cambio de más de ' + miles(x.topes.edicion) + ' caracteres, un archivo generado, se corta, y se dice). Las credenciales y las rutas absolutas salen tapadas. Las barritas del gráfico, arriba, filtran esta lista por momento.'
      + aprox + consola
      + (x.no_confirmados ? ' ' + x.no_confirmados + (x.no_confirmados === 1 ? ' nombre de la consola que git no confirma no se muestra' : ' nombres de la consola que git no confirma no se muestran') + ' (texto del comando que parecía un archivo).' : '')
      + (x.sin_cambio_por_tope ? ' <b>Los últimos ' + x.sin_cambio_por_tope + ' cambios no traen el texto</b>.' : '')
      + (x.anteriores_al_inicio ? ' ' + x.anteriores_al_inicio + ' ediciones de la misma sesión, anteriores a esta corrida, no se muestran.' : '')
      + (x.posteriores_al_cierre ? ' ' + x.posteriores_al_cierre + ' ediciones posteriores al cierre (la conversación siguió con otro trabajo) tampoco.' : '') + '</p>';
    if (!hayGit) h += '<table class="mt arch"><tr><th>archivo</th><th>cambios</th><th>+</th><th>−</th></tr>' + x.archivos.map(function (a) {
      return '<tr><td class="ruta">' + esc(a.f) + (a.escrito ? ' <span class="nd">(escrito entero)</span>' : '') + (a.consola ? ' <span class="nd">(por consola' + (a.consola < a.veces ? ': ' + a.consola + ' de ' + a.veces : '') + ')</span>' : '') + '</td><td class="num">' + a.veces + '</td><td class="num mas">' + (a.mas ? '+' + a.mas : '·') + '</td><td class="num menos">' + (a.menos ? '−' + a.menos : '·') + '</td></tr>';
    }).join('') + '</table>';
    h += '<p class="cz-filtro" hidden></p><ol class="cz">' + x.lista.map(function (e, k) {
      if (e.o) return '';
      var cab = '<span class="cz-t">' + (e.t === null ? '—' : (e.k ? '≈ ' : '') + e.t + ' min') + '</span> <span class="cz-p">' + esc(nombrePaso(e.p)) + '</span> <span class="ruta">' + esc(x.archivos[e.a].f) + '</span> ' + (e.k ? '<span class="nd">por consola · aproximado</span>' : '<span class="mas">+' + e.mas + '</span>' + (e.w ? ' <span class="nd">escrito entero</span>' : ' <span class="menos">−' + e.menos + '</span>'));
      return '<li data-t="' + (e.t === null ? '' : e.t) + '" data-g="' + (e.g === undefined ? '' : e.g) + '">' + (e.x
        ? '<details data-cz="' + idx + '" data-k="' + k + '"><summary>' + cab + (e.c ? ' <span class="nd">cortado</span>' : '') + '</summary><div class="cz-txt">abriendo…</div></details>'
        : '<div class="cz-sin">' + cab + ' <span class="nd">sin texto: pasa del tope por corrida</span></div>') + '</li>';
    }).join('') + '</ol>';
    return h + commitsHtml(x);
  }
  function nombrePaso(p) {
    if (p === null || p === undefined) return 'sin paso';
    if (p === 'después') return 'después del último paso';
    return String(p).split('+').map(function (n) { return 'paso ' + n + ((M.pasos.nombres || [])[+n] ? ' ' + M.pasos.nombres[+n] : ''); }).join(' + ');
  }
  function commitsHtml(x) {
    if (!x.commits || !x.commits.length) return '<p class="nd">sin commits en el hilo de esta corrida</p>';
    return '<h4>Commits</h4><ul class="commits">' + x.commits.map(function (m) { return '<li><span class="mono">' + esc(m.h) + '</span> <span class="cz-p">' + esc(nombrePaso(m.paso)) + '</span> ' + (m.archivos ? '<span class="nd">' + m.archivos + ' archivo' + (m.archivos === 1 ? '' : 's') + '</span> ' : '') + esc(m.s) + '</li>'; }).join('') + '</ul>';
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
      if (!b64) throw new Error(FUENTE.forma === 'red' ? 'el cambio de git de esta corrida no está' : 'el cambio de git de esta corrida no está en la página');
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
    var NOMBRE = { A: 'nuevo', M: 'modificado', D: 'borrado', R: 'renombrado' };
    textosGit(+det.dataset.cg).then(function (todos) {
      var tx = todos[ai] || [];
      caja.innerHTML = a.partes.map(function (p, k) {
        var cm = p.c >= 0 ? g.commits[p.c] : null;
        var marca = !cm || !cm.at ? '' : cm.at === 'coincide_la_hora'
          ? ' · <b>sin confirmar</b>: coincide con un comando de esta sesión que no lo nombra; puede ser de otra sesión'
          : ' · <b>sin confirmar</b>: no se pudo saber si lo hizo esta sesión';
        var cab = (cm ? 'commit <span class="mono">' + esc(cm.h) + '</span>' + (cm.t === null ? '' : ' · min ' + cm.t) + ' · ' + esc(cm.s) + marca : 'sin commitear al cerrar')
          + ' · ' + (NOMBRE[p.e] || esc(p.e)) + (p.ant ? ' (antes ' + esc(p.ant) + ')' : '') + (p.b || p.mas === null ? '' : ' · +' + p.mas + ' −' + p.menos);
        var cuerpo = p.b ? '<div class="nd">binario: sin texto</div>' : p.tope ? '<div class="nd">sin texto: pasa del tope por corrida</div>'
          : p.om ? '<div class="nd">' + esc(p.om) + '</div>' : tx[k] ? '<pre class="diff">' + diffHtml(tx[k]) + '</pre>' : '<div class="nd">sin texto</div>';
        return '<div class="cz-lbl">' + cab + '</div>' + cuerpo + (p.cor ? '<div class="nd">cortado: ' + p.cor + ' caracteres más no se muestran</div>' : '');
      }).join('');
      det.dataset.listo = '1';
    }).catch(function (err) { caja.innerHTML = '<span class="nd">no se pudo abrir el cambio: ' + esc(err.message) + '</span>'; });
  }
  // Clic en «en la conversación» de un archivo de git: la lista de abajo muestra sólo los momentos de ese archivo.
  function filtrarPorArchivo(fila, c, gi) {
    var caja = fila.querySelector('.cambios'); if (!caja) return;
    var items = caja.querySelectorAll('ol.cz li'), vistos = [];
    items.forEach(function (li) { var ok = li.dataset.g === String(gi); li.hidden = !ok; if (ok) vistos.push(li); });
    var nota = caja.querySelector('.cz-filtro'); if (!nota) return;
    var f = '<span class="ruta">' + esc(c.cambios.git.archivos[gi].f) + '</span>';
    nota.hidden = false;
    nota.innerHTML = (vistos.length ? (vistos.length === 1 ? 'El <b>único</b> momento' : 'Los <b>' + vistos.length + '</b> momentos') + ' en que la conversación tocó ' + f + '.'
      : 'La conversación no registró ningún momento para ' + f + ': lo cambió un subagente, un programa o un comando que no se reconoció.') + ' <button class="cz-todos">ver todos</button>';
    nota.querySelector('.cz-todos').onclick = function () { items.forEach(function (li) { li.hidden = false; }); nota.hidden = true; };
    nota.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  var czCache = {};
  function textosDe(idx) {
    if (czCache[idx]) return czCache[idx];
    czCache[idx] = FUENTE.texto('cz', idx).then(function (b64) {
      if (!b64) throw new Error(FUENTE.forma === 'red' ? 'el texto de esta corrida no está' : 'el texto de esta corrida no está en la página');
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
    var h = '<h4>Minuto ' + desde + ' a ' + hasta + ' — ' + miles(out + cache) + ' tokens <button class="cerrar qx">cerrar ✕</button></h4>'
      + '<p><b>' + miles(out) + '</b> los escribió el modelo · <b>' + miles(cache) + '</b> es contexto mandado por primera vez y guardado en caché: releerlo después sale casi gratis, mandarlo se paga una vez. <b>Un pico casi siempre es contexto nuevo, no texto escrito.</b></p>'
      + (as.length ? '<p>agentes lanzados acá: ' + as.map(function (a) { return esc(a) + (ags[a] > 1 ? ' ×' + ags[a] : ''); }).join(' · ') + '</p>' : '');
    if (ks.length) { var mxh = herr[ks[0]]; h += '<div class="bars">' + ks.slice(0, 8).map(function (k) { return '<div class="b"><span>' + esc(k) + '</span><i style="width:' + ((herr[k] / mxh) * 100).toFixed(0) + '%"></i><b>' + herr[k] + '</b></div>'; }).join('') + '</div>'; }
    else h += '<p>en esta ventana no se usó ninguna herramienta: el consumo es conversación y razonamiento</p>';
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
    nota.innerHTML = (vistos.length === 1 ? 'Mostrando el <b>único</b> cambio' : 'Mostrando los <b>' + vistos.length + '</b> cambios') + ' entre el minuto ' + desde + ' y el ' + hasta + '. <button class="cz-todos">ver todos</button>';
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
      caja.innerHTML = bloque(par[0], 'viejo', 'antes') + bloque(par[1], 'nuevo', e.k ? 'comando de consola que escribió el archivo (no queda un antes y después)' : e.w ? 'contenido escrito' : 'después') + (e.c ? '<div class="nd">cortado: ' + e.c + ' caracteres más no se muestran</div>' : '');
      det.dataset.listo = '1';
    }).catch(function (err) { caja.innerHTML = '<span class="nd">no se pudo abrir el cambio: ' + esc(err.message) + '</span>'; });
  }

  // story 2.27: 'idx' es la fila de la corrida en C. En el sitio, 'c' es el detalle que trajo la red (otro objeto que
  // C[idx]): buscarlo con indexOf daba -1 y ningún cambio ni parche se podía abrir (pase adversarial)
  function detalle(c, idx) {
    if (idx === undefined) idx = C.indexOf(c);
    var chips = '<span class="chip ' + (c.llego_al_final ? 'ok' : 'warn') + '"><span class="g">' + (c.llego_al_final ? '●' : '◆') + '</span>' + (c.llego_al_final ? 'llegó al paso 8' : 'quedó en el paso ' + (c.ultimo_paso === null ? '?' : c.ultimo_paso)) + '</span>'
      + (c.controles && c.controles.error ? '<span class="chip bad"><span class="g">▲</span>' + c.controles.error + ' con error</span>' : '')
      + (c.controles && c.controles.freno ? '<span class="chip warn"><span class="g">◆</span>frenó ' + c.controles.freno + '</span>' : '')
      + (c.costo && c.costo.vueltas !== null ? '<span class="chip neutro"><span class="g">○</span>' + c.costo.vueltas + ' vueltas</span>' : '')
      + (c.dod ? '<span class="chip ' + (c.dod === 'PASS' ? 'ok' : 'bad') + '"><span class="g">' + (c.dod === 'PASS' ? '●' : '▲') + '</span>DoD ' + esc(c.dod) + '</span>' : '');
    var tl = timeline(c);
    return '<div class="det">'
      + '<div class="det-head"><div><b>Story ' + esc(c.story || '—') + '</b> <span class="mono">' + esc(c.producto || 'producto sin registrar') + '</span>'
      + (M.multi ? ' <span class="mono">· ' + (c.maquina ? esc(c.maquina) + (c.maquina_nota ? ' (' + esc(c.maquina_nota) + ')' : '') : 'máquina sin declarar: ' + esc(c.maquina_motivo || '')) + '</span>' : '')
      + (c.descripcion ? '<div class="det-desc">' + esc(c.descripcion.texto) + ' <span class="nd">— ' + esc(c.descripcion.fuente) + '</span></div>' : '<div class="det-desc nd">sin descripción: la corrida no guardó su conversación ni el archivo de su story</div>')
      + '<div class="mono sub">' + esc((c.inicio || '').slice(0, 16).replace('T', ' ')) + ' UTC · ' + (c.dur_ms ? dt(c.dur_ms / 60000) : 'sin duración registrada') + '</div></div>'
      + '<div class="det-chips">' + chips + '<button class="cerrar">cerrar ✕</button></div></div>'
      + '<div class="tl">' + tl + '</div><div class="qtok" hidden></div>'
      + ((c._notas && c._notas.length) ? '<p class="fuera">' + c._notas.join(' ') + '</p>' : '')
      + '<div class="tlleg">'
      +   '<span class="lgi"><svg width="13" height="13"><circle cx="6.5" cy="6.5" r="4" fill="var(--good-soft)" stroke="var(--good)" stroke-width="1.8"></circle></svg>miró y dejó pasar</span>'
      +   '<span class="lgi"><svg width="13" height="13"><path d="M6.5,2 L11,10 L2,10 Z" fill="var(--crit)"></path></svg><b>encontró un error</b> — una prueba, la compilación</span>'
      +   '<span class="lgi"><svg width="13" height="13"><rect x="2.7" y="2.7" width="7.6" height="7.6" fill="var(--accent)"></rect></svg><b>no dejó pasar</b> — el control frenó algo</span>'
      +   '<span class="lgi"><svg width="13" height="13"><circle cx="6.5" cy="6.5" r="3.6" fill="none" stroke="var(--ink-3)" stroke-width="1.2" stroke-dasharray="2 2"></circle></svg>sin estado registrado</span>'
      +   '<span class="lgi"><svg width="13" height="13"><line x1="6.5" y1="0" x2="6.5" y2="13" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="3 3"></line></svg>arranca una vuelta de revisión</span>'
      +   '<span class="lgi"><svg width="13" height="13"><line x1="6.5" y1="0" x2="6.5" y2="13" stroke="var(--ink-3)" stroke-width="1.2"></line></svg>paso marcado junto con el anterior</span>'
      +   '<span class="lgi"><svg width="16" height="13"><rect x="0" y="3" width="16" height="7" fill="url(#hatch)" stroke="var(--line-strong)"></rect></svg>entre pasos</span>'
      +   '<span class="lgi"><svg width="16" height="13"><rect x="0" y="1" width="16" height="11" fill="none" stroke="var(--warn)" stroke-dasharray="3 2"></rect></svg><b>esperando a una persona</b> — una pregunta o un turno sin respuesta</span>'
      + '</div>'
      + '<p class="tlnota">El eje es el tiempo real desde que arrancó. Cada control tiene su propio carril: la fila dice cuál es, el icono si pasó o no. Los pasos que aparecen como una <b>raya vertical</b> no duraron: se marcaron junto con el anterior.'
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
    var u = UMB[clave]; if (u === undefined) return { est: 'neutro', palabra: 'medido' };
    if (!umbralValido(u)) return { est: 'neutro', palabra: 'sin juicio', nota: 'umbral «' + clave + '» mal formado en sources.json: sin juicio de color' };
    var est = u.sentido === 'mayor_es_mejor' ? (v >= u.ok_min ? 'ok' : v <= u.bad_max ? 'bad' : 'warn') : (v <= u.ok_max ? 'ok' : v >= u.bad_min ? 'bad' : 'warn');
    return { est: est, palabra: { ok: 'bien', warn: 'atención', bad: 'rojo' }[est] };
  };
  var gris = function (motivo) { return { estado: 'no_medido', motivo: motivo }; };
  // La misma forma que 'ficha' de common.js (mismas clases, mismo denominador al lado); vive acá
  // porque corre en el navegador, donde no hay require. Si cambia una, cambia la otra.
  function ficha(titulo, m) {
    if (!m || m.estado !== 'medido') return '<div class="tile blind"><span class="chip blind"><span class="g">▨</span>no medido</span><div class="t-label">' + esc(titulo) + '</div><div class="t-val">falta</div><div class="t-den">' + esc(m && m.motivo || 'sin motivo declarado') + '</div></div>';
    var e = m.est || 'neutro', gl = { ok: '●', warn: '◆', bad: '▲', neutro: '○' }[e] || '○';
    return '<div class="tile ' + (m.est || '') + '"><span class="chip ' + e + '"><span class="g">' + gl + '</span>' + esc(m.palabra || 'medido') + '</span><div class="t-label">' + esc(titulo) + '</div><div class="t-val">' + m.texto + '</div><div class="t-den">' + esc(m.den) + '</div>' + (m.detalle ? '<div class="t-foot">' + m.detalle + '</div>' : '') + '</div>';
  }

  // story 7.12: la línea base de pasos por corrida llega en el modelo (sale del medidor). Sin ella, el motivo
  // se DICE en la ficha y en la serie: omitir la frase haría que «no la pude cargar» se vea igual que «no hay».
  var LB = M.linea_base_pasos && M.linea_base_pasos.estado === 'medida' && num(M.linea_base_pasos.mediana) ? M.linea_base_pasos : null;
  var sinLB = LB ? '' : 'sin línea base contra la que comparar: ' + esc((M.linea_base_pasos && M.linea_base_pasos.motivo) || 'esta página se generó sin ella');
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
    var notas = (sinFecha ? '<p class="tlnota">' + sinFecha + ' corrida' + (sinFecha === 1 ? ' medida no trae' : 's medidas no traen') + ' su fecha de arranque: está' + (sinFecha === 1 ? '' : 'n') + ' en la mediana de la ficha y no en esta serie.</p>' : '')
      + (LB ? '' : '<p class="tlnota">' + sinLB + '.</p>');
    var con = Object.keys(porMes).sort();
    if (!con.length) return '<p class="tlnota">ninguna corrida del filtro tiene sus pasos medidos con fecha: no hay serie que dibujar (y no es cero)</p>' + notas;
    var ks = [], y = Number(con[0].slice(0, 4)), m = Number(con[0].slice(5, 7)), fin = con[con.length - 1];
    while (ks.length < 120) { var k = y + '-' + String(m).padStart(2, '0'); ks.push(k); if (k >= fin) break; m += 1; if (m > 12) { m = 1; y += 1; } }
    var pts = ks.map(function (k) { return porMes[k] ? { k: k, v: mediana(porMes[k]), n: porMes[k].length } : { k: k, v: null, n: 0 }; });
    // El techo del eje se redondea a la centena de arriba, con aire: los números de los puntos van encima.
    var max = Math.max(100, Math.ceil(Math.max.apply(null, [1].concat(pts.map(function (p) { return p.v || 0; })).concat(LB ? [LB.mediana] : [])) * 1.2 / 100) * 100);
    var W = 720, H = 190, x0 = 40, x1 = 706, base = 148, top = 16, paso = (x1 - x0) / ks.length;
    var Y = function (v) { return base - (v / max) * (base - top); };
    var X = function (i) { return x0 + paso * i + paso / 2; };
    var s2 = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px;min-width:520px;display:block" role="img" aria-label="Pasos por corrida, mediana por mes.">';
    [0, max / 2, max].forEach(function (t) {
      s2 += '<line x1="' + x0 + '" y1="' + Y(t) + '" x2="' + x1 + '" y2="' + Y(t) + '" stroke="var(--line)"></line><text x="' + (x0 - 7) + '" y="' + (Y(t) + 4) + '" text-anchor="end" font-family="IBM Plex Mono,monospace" font-size="10.5" fill="var(--ink-3)">' + t + '</text>';
    });
    if (LB) s2 += '<line x1="' + x0 + '" y1="' + Y(LB.mediana).toFixed(1) + '" x2="' + x1 + '" y2="' + Y(LB.mediana).toFixed(1) + '" stroke="var(--ink-3)" stroke-dasharray="4 4"><title>línea base del ' + esc(LB.fecha) + ': ' + LB.mediana + '</title></line>'
      + '<text x="' + (x0 + 4) + '" y="' + (Y(LB.mediana) + 13).toFixed(1) + '" text-anchor="start" font-family="IBM Plex Mono,monospace" font-size="10" fill="var(--ink-3)">línea base ' + LB.mediana + ' · ' + esc(LB.fecha) + '</text>';
    // La línea une sólo meses CONSECUTIVOS medidos: cruzar un hueco dibujaría una tendencia que nadie midió.
    pts.forEach(function (p, i) {
      if (i && p.v !== null && pts[i - 1].v !== null) s2 += '<line x1="' + X(i - 1).toFixed(1) + '" y1="' + Y(pts[i - 1].v).toFixed(1) + '" x2="' + X(i).toFixed(1) + '" y2="' + Y(p.v).toFixed(1) + '" stroke="var(--accent)" stroke-width="2"></line>';
    });
    pts.forEach(function (p, i) {
      var cx = X(i);
      s2 += p.v === null
        ? '<rect x="' + (cx - Math.min(15, paso * 0.31)).toFixed(1) + '" y="' + top + '" width="' + Math.min(30, paso * 0.62).toFixed(1) + '" height="' + (base - top) + '" fill="var(--hatch)" opacity=".18" rx="2"><title>' + p.k + ': sin corridas medidas</title></rect>'
        : '<circle cx="' + cx.toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="4.5" fill="var(--accent)"><title>' + p.k + ': mediana ' + Math.round(p.v) + ' · n=' + p.n + '</title></circle>'
          + '<text x="' + cx.toFixed(1) + '" y="' + (Y(p.v) - 9).toFixed(1) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="10.5" fill="var(--ink)">' + Math.round(p.v) + '</text>';
      s2 += '<text x="' + cx.toFixed(1) + '" y="164" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="9.5" fill="var(--ink-3)">' + p.k + '</text>'
        + '<text x="' + cx.toFixed(1) + '" y="176" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="9.5" fill="var(--ink-3)">' + (p.v === null ? 'sin medir' : 'n=' + p.n) + '</text>';
    });
    return s2 + '</svg>' + notas;
  }

  function resumen(F) {
    var N = F.length;
    // story 2.27 (AC 11): quien todavía no tiene corridas en el buzón no ve «0 corridas» como una medida
    if (!C.length && M.vacio_motivo) return ficha('Todavía no hay corridas', gris(M.vacio_motivo));
    if (!N) return ficha('El filtro no deja ninguna corrida', gris(M.registro.estado !== 'medido' && M.registro.motivo ? M.registro.motivo : 'sin corridas en el filtro: ampliá el rango o cambiá de producto'));
    var dur = F.filter(function (c) { return c.dur_ms; });
    var fin = F.filter(function (c) { return c.llego_al_final; });
    var gz = F.filter(function (c) { return c.controles; });
    var roj = gz.filter(function (c) { return c.controles.error > 0; });
    var fre = gz.filter(function (c) { return c.controles.freno > 0; });
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
    var pisoEspera = ePiso.length ? '. <b>Aparte</b>, en otras ' + ePiso.length + ' corridas sin la espera de los pasos medida, la conversación muestra <b>al menos ' + dt(mediana(ePiso.map(function (c) { return c.tiempos.espera_del_hilo_ms; })) / 60000) + '</b> de espera (mediana): es un piso y no entra en el número de arriba' : '';
    // story 2.27: sin las conversaciones (un sitio sin disco), la espera leída del hilo no se midió: se dice, no es cero
    var sinHilo = M.sin_hilos ? '. La espera leída de la conversación: <b>' + esc(M.sin_hilos) + '</b>' : '';
    pisoEspera += sinHilo;
    var sinArranque = 'ninguna corrida del filtro anotó el arranque de sus pasos (las anteriores a la story 2.7 no lo tienen): se estimaría por diferencia, y eso no se publica como medida';
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
      return (sinVer ? ' · ' + b(sinVer) + ' lanzamientos sin veredicto' : '')
        + (sinRes ? ' · ' + b(sinRes) + ' lanzamientos sin resultado' : '')
        + (relDec ? ' · no se relanzó en ' + relSin + ' de ' + relDec + ' re-loops' : '');
    };
    var fichaValidador = conVer
      ? med(halVer + ' de ' + conVer + ' con hallazgos', 'n=' + val.length + ' de ' + N + ' corridas con el veredicto medido', {
        detalle: FASES_VAL.filter(function (p) { return porFaseVal[p[0]].con; }).map(function (p) { return esc(p[1]) + ' ' + porFaseVal[p[0]].hal + ' de ' + porFaseVal[p[0]].con; }).join(' · ')
          + aparte(function (n) { return '<b>' + n + '</b>'; }) })
      : gris('las corridas del filtro no dejan veredicto del validador (existe desde la story 7.3)' + aparte(function (n) { return n; }).replace(/^ · /, ': '));
    return [
      ficha('Corridas que llegaron al último paso', med(Math.round(pf * 100) + '%', fin.length + ' de ' + N + ' corridas', { est: juzgar('corridas_al_final', pf).est, palabra: juzgar('corridas_al_final', pf).palabra, detalle: '<b>' + (N - fin.length) + '</b> quedaron a mitad de camino' + (juzgar('corridas_al_final', pf).nota ? ' · <b>' + esc(juzgar('corridas_al_final', pf).nota) + '</b>' : '') })),
      ficha('Cuánto dura una corrida, de punta a punta (mediana)', dur.length ? med(n1(mediana(dur.map(function (c) { return c.dur_ms; })) / 3600000) + ' h', 'n=' + dur.length + ' de ' + N + ' corridas', { detalle: 'la más larga ' + n1(Math.max.apply(null, dur.map(function (c) { return c.dur_ms; })) / 3600000) + ' h' }) : gris('ninguna corrida del filtro dejó su duración')),
      ficha('Corridas donde un control encontró un error', gz.length ? med(Math.round((roj.length / gz.length) * 100) + '%', roj.length + ' de ' + gz.length + ' corridas con controles', { est: juzgar('corridas_con_error', roj.length / gz.length).est, palabra: juzgar('corridas_con_error', roj.length / gz.length).palabra, detalle: 'una prueba o la compilación que no pasaron y se arreglaron. En otras <b>' + fre.length + '</b> el control frenó antes de seguir. Las dos son el control funcionando.' + (N - gz.length ? ' ' + (N - gz.length) + ' corridas no registraron controles.' : '') + (juzgar('corridas_con_error', roj.length / gz.length).nota ? ' <b>' + esc(juzgar('corridas_con_error', roj.length / gz.length).nota) + '</b>' : '') }) : gris('ninguna corrida del filtro registró controles')),
      ficha('Agentes lanzados por corrida (mediana)', ag.length ? med(String(mediana(ag)), 'n=' + ag.length + ' de ' + N + ' corridas', { detalle: 'máximo ' + Math.max.apply(null, ag) + ' · ' + (N - ag.length) + ' no lo registran (anteriores al conteo mecánico)' }) : gris('ninguna corrida del filtro registró cuántos agentes lanzó')),
      ficha('Vueltas de revisión por corrida (mediana)', vu.length ? med(String(mediana(vu)), 'n=' + vu.length + ' de ' + N + ' corridas', { detalle: 'máximo ' + Math.max.apply(null, vu) + ' · la última vuelta de los revisores medidos (o de las fotos de iteración): la misma cuenta que el latido de la retrospectiva' }) : gris('ninguna corrida del filtro registró sus vueltas')),
      ficha('El validador de stories, por fase', fichaValidador),
      ficha('Trabajo por corrida (mediana)', tMed.length ? med(dt(mediana(tMed.map(function (c) { return c.tiempos.trabajo_ms; })) / 60000), 'n=' + tMed.length + ' de ' + N + ' corridas', { detalle: 'los pasos con trabajo, del arranque al fin; sin la espera ni el tiempo entre pasos' + (M.sin_hilos ? ' (incluye las esperas que sólo se ven en la conversación: ' + esc(M.sin_hilos) + ')' : '') }) : gris(sinArranque + sinHilo)),
      ficha('Espera humana por corrida (mediana)', eMed.length ? med(dt(mediana(eMed.map(function (c) { return c.tiempos.espera_humana_ms; })) / 60000), 'n=' + eMed.length + ' de ' + N + ' corridas', { detalle: 'aprobar el plan y los hallazgos, más las preguntas y los turnos que esperaron una respuesta del dev (leídos de la conversación)' + pisoEspera }) : gris(sinArranque + pisoEspera)),
      ficha('Pasos de una corrida (mediana)', pa.length ? med(String(Math.round(mediana(pa))), 'n=' + pa.length + ' de ' + N + ' corridas', { detalle: (N - pa.length ? '<b>' + (N - pa.length) + '</b> no tienen sus pasos medidos (sin consumo medido): no entran en la mediana ni se estiman. ' : '') + 'Los tokens de al lado son su consecuencia: en cada paso el modelo relee todo lo anterior.' + (LB ? ' Línea base del ' + esc(LB.fecha) + ': <b>' + LB.mediana + '</b>' + (LB.corridas ? ' (n=' + LB.corridas + ')' : '') + '.' : ' <b>' + sinLB + '</b>.') }) : gris('ninguna corrida del filtro tiene sus pasos medidos: salen del consumo medido, y sin él no se estiman')),
      ficha('Tokens de una corrida (mediana)', tk.length ? med(miles(Math.round(mediana(tk))), 'n=' + tk.length + ' de ' + N + ' corridas', { detalle: 'de otras <b>' + (N - tk.length) + '</b> no hay consumo medido (conversación borrada antes del rescate, o corrida anterior a él)' }) : gris('ninguna corrida del filtro tiene su consumo medido'))
    ].join('');
  }

  // Todas las semanas del rango, aunque valgan 0: una barra ausente y una en cero no son lo mismo.
  function semanasDelRango(F) {
    var fechas = F.map(function (c) { return c.inicio; }).filter(Boolean).sort();
    if (!fechas.length) return [];
    var lunes = function (iso) { var d = new Date(iso); var t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); var dn = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() - dn + 1); return t; };
    var semana = function (t) { var x = new Date(t.getTime()); var dn = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - dn); var a0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1)); return x.getUTCFullYear() + '-S' + String(Math.ceil(((x - a0) / 86400000 + 1) / 7)).padStart(2, '0'); };
    var ks = [], t = lunes(fechas[0]), fin = lunes(fechas[fechas.length - 1]);
    while (t <= fin && ks.length < 400) { ks.push(semana(t)); t.setUTCDate(t.getUTCDate() + 7); }
    return ks;
  }
  function graficoSemanas(F) {
    var porSem = {};
    F.forEach(function (c) { if (c.semana) porSem[c.semana] = (porSem[c.semana] || 0) + 1; });
    var ks = semanasDelRango(F);
    if (!ks.length) return '<p class="tlnota">sin corridas en el filtro</p>';
    var max = Math.max.apply(null, [1].concat(ks.map(function (k) { return porSem[k] || 0; })));
    var W = 720, H = 190, x0 = 34, x1 = 706, base = 148, top = 16, paso = (x1 - x0) / ks.length;
    var Y = function (v) { return base - (v / max) * (base - top); };
    var s2 = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px;min-width:520px;display:block" role="img" aria-label="Corridas por semana.">';
    [0, Math.round(max / 2), max].forEach(function (t) {
      s2 += '<line x1="' + x0 + '" y1="' + Y(t) + '" x2="' + x1 + '" y2="' + Y(t) + '" stroke="var(--line)"></line><text x="' + (x0 - 7) + '" y="' + (Y(t) + 4) + '" text-anchor="end" font-family="IBM Plex Mono,monospace" font-size="10.5" fill="var(--ink-3)">' + t + '</text>';
    });
    ks.forEach(function (k, i) {
      var n = porSem[k] || 0, cx = x0 + paso * i + paso / 2, bw = Math.min(30, paso * 0.62);
      s2 += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + Y(n).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, base - Y(n)).toFixed(1) + '" fill="' + (n ? 'var(--accent)' : 'var(--line-strong)') + '" rx="2"><title>' + k + ': ' + n + ' corridas</title></rect>'
        + '<text x="' + cx.toFixed(1) + '" y="' + (Y(n) - 5).toFixed(1) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="10.5" fill="var(--ink)">' + n + '</text>'
        + (ks.length <= 26 || i % 2 === 0 ? '<text x="' + cx.toFixed(1) + '" y="166" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="9.5" fill="var(--ink-3)">' + k.slice(5) + '</text>' : '');
    });
    return s2 + '<text x="' + x0 + '" y="182" font-family="IBM Plex Sans,sans-serif" font-size="11" fill="var(--ink-3)">semana ISO · ' + ks[0].slice(0, 4) + ' → ' + ks[ks.length - 1].slice(0, 4) + '</text></svg>';
  }

  // Un tramo fusionado (5+6) no da un valor a ninguno de los dos pasos: se declara aparte.
  function porPaso(F, valorDe, fmt, universo, fusionados) {
    var filas = [];
    for (var i = 0; i <= 8; i++) {
      var vs = F.map(function (c) { return valorDe(c, i); }).filter(function (v) { return isFinite(v) && v > 0; });
      filas.push({ i: i, v: vs.length ? mediana(vs) : null, n: vs.length });
    }
    var max = Math.max.apply(null, [1].concat(filas.map(function (f) { return f.v || 0; })));
    return '<div class="pasos">' + filas.map(function (f) {
      return '<div class="pfila' + (f.v === null ? ' sinDato' : '') + '"><span class="pn"><b>' + f.i + '</b> ' + esc(PASOS[f.i]) + '</span>'
        + '<span class="pb">' + (f.v === null ? '<i class="hatch" style="width:100%"></i>' : '<i style="width:' + Math.max(1.5, (f.v / max) * 100).toFixed(1) + '%;background:' + RAMPA[f.i] + '"></i>') + '</span>'
        + '<span class="pv">' + (f.v === null ? 'sin dato' : fmt(f.v)) + '</span><span class="pnn">n=' + f.n + ' de ' + universo + '</span></div>';
    }).join('') + (fusionados ? '<p class="tlnota">' + fusionados + ' corrida(s) tienen pasos con marcas invertidas o empatadas (por ejemplo «5+6»): lo de esos tramos va fusionado y no entra en la mediana de ningún paso — se ve en el detalle de cada una.</p>' : '') + '</div>';
  }

  // ─── el filtro ───
  var $ = function (id) { return document.getElementById(id); };
  var elMaq = (M.varias_maquinas !== undefined ? M.varias_maquinas : M.multi) ? $('f-maquina') : null;
  var maqDe = function (c) { return c.maquina || '(sin declarar)'; };
  var elDesde = $('f-desde'), elHasta = $('f-hasta'), elRepo = $('f-repo'), elFc = $('fc'), elFf = $('ff'), elCuenta = $('cuenta'), elLimpiar = $('f-limpiar'), cuerpo = $('cuerpo');
  var fechas = C.map(function (c) { return (c.inicio || '').slice(0, 10); }).filter(Boolean).sort();
  var RANGO = [fechas[0] || '', fechas[fechas.length - 1] || ''];
  var cuentaRepo = {};
  // Los combos van en orden alfabético (sin distinguir mayúsculas): se busca un nombre, no un ranking. Lo «sin…», al final.
  var alfabetico = function (a, b) { var sa = a.charAt(0) === '(' || a.indexOf('sin ') === 0, sb = b.charAt(0) === '(' || b.indexOf('sin ') === 0; return (sa - sb) || a.localeCompare(b, 'es', { sensitivity: 'base' }); };
  C.forEach(function (c) { var r = c.producto || '(sin producto)'; cuentaRepo[r] = (cuentaRepo[r] || 0) + 1; });
  elRepo.innerHTML = '<option value="">todos (' + C.length + ')</option>' + Object.keys(cuentaRepo).sort(alfabetico).map(function (r) { return '<option value="' + esc(r) + '">' + esc(r) + ' (' + cuentaRepo[r] + ')</option>'; }).join('');
  if (elMaq) {
    var cuentaMaq = {};
    C.forEach(function (c) { cuentaMaq[maqDe(c)] = (cuentaMaq[maqDe(c)] || 0) + 1; });
    elMaq.innerHTML = '<option value="">todas (' + C.length + ')</option>' + Object.keys(cuentaMaq).sort(alfabetico).map(function (r) { return '<option value="' + esc(r) + '">' + esc(r) + ' (' + cuentaMaq[r] + ')</option>'; }).join('');
  }
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
  var mMaq = qs.match(/[?&]maquina=([^&]+)/);
  if (elMaq && mMaq) { try { elMaq.value = ENLACE.maquina = decodeURIComponent(mMaq[1]); } catch (e) { /* un nombre mal escrito deja el filtro en «todas» */ } }
  if (typeof window !== 'undefined') window.__enlace = function () { return ENLACE; };
  if (SOLO !== null && typeof document !== 'undefined' && document.body && document.body.classList) document.body.classList.add('solo');
  function pasa(c) {
    if (SOLO !== null && C.indexOf(c) !== SOLO) return false;
    var f = (c.inicio || '').slice(0, 10);
    if (elDesde.value && f && f < elDesde.value) return false;
    if (elHasta.value && f && f > elHasta.value) return false;
    if (elRepo.value && (c.producto || '(sin producto)') !== elRepo.value) return false;
    if (elMaq && elMaq.value && maqDe(c) !== elMaq.value) return false;
    if (elFc.checked && c.consumo.estado !== 'medido') return false;
    if (elFf.checked && !c.llego_al_final) return false;
    return true;
  }
  function aplicar() {
    var F = C.filter(pasa);
    $('fichas').innerHTML = resumen(F);
    $('gsem').innerHTML = graficoSemanas(F);
    $('gpasos').innerHTML = graficoPasos(F);
    var fus = F.filter(function (c) { return c.tramos.some(function (t) { return t.pasos.length > 1; }); }).length;
    var tramoDe = function (c, i) { var t = c.tramos.filter(function (x) { return !x.subpaso && x.pasos.length === 1 && x.pasos[0] === i; })[0]; return t ? t.ms / 60000 : null; };
    $('ppt').innerHTML = porPaso(F, tramoDe, function (v) { return n1(v) + ' min'; }, F.length, fus);
    var cs = F.filter(function (c) { return c.consumo.estado === 'medido'; });
    // Los tokens de un tramo fusionado ('5+6') no son de ningún paso: se DECLARAN, como en el de tiempo
    // (pase adversarial 2.14: el 95 % del consumo de una corrida desaparecía sin nota).
    var fusK = cs.filter(function (c) { return Object.keys(c.consumo.por_paso).some(function (k) { return k.indexOf('+') >= 0; }); }).length;
    $('ppk').innerHTML = porPaso(cs, function (c, i) { return c.consumo.por_paso[String(i)]; }, function (v) { return miles(Math.round(v)); }, cs.length, fusK);
    var dentro = 0, fuera = 0;
    cs.forEach(function (c) { fuera += c.consumo.fuera_de_ventana; Object.keys(c.consumo.por_paso).forEach(function (k) { dentro += c.consumo.por_paso[k]; }); });
    $('nota-tokens').innerHTML = cs.length
      ? 'Sólo de las <b>' + cs.length + '</b> corridas del filtro con consumo medido (n= al lado de cada paso). <b>' + n1((fuera / Math.max(1, fuera + dentro)) * 100) + ' % del consumo cae fuera de los pasos</b> — trabajo posterior al último paso registrado; se cuenta aparte, no se reparte.'
      : 'Ninguna corrida del filtro tiene su consumo medido: no hay consumo que mostrar, y eso <b>no es cero</b>.';
    var n = 0;
    for (var i = 0; i < cuerpo.rows.length; i++) {
      var tr = cuerpo.rows[i];
      if (tr.classList.contains('fila-det')) { tr.hidden = tr.previousElementSibling.hidden; continue; }
      var k = enC(tr), ok = k !== null && pasa(C[k]); tr.hidden = !ok; if (ok) n++;
    }
    elCuenta.textContent = n + ' de ' + C.length + ' corridas a la vista';
  }
  if (typeof window !== 'undefined') window.__aplicar = aplicar;
  [elDesde, elHasta, elRepo, elFc, elFf].concat(elMaq ? [elMaq] : []).forEach(function (el) { el.addEventListener('change', aplicar); });
  elLimpiar.onclick = function () { elDesde.value = RANGO[0]; elHasta.value = RANGO[1]; elRepo.value = ''; if (elMaq) elMaq.value = ''; elFc.checked = false; elFf.checked = false; aplicar(); };
  aplicar();

  // ─── abrir / cerrar el detalle ───
  // story 2.27: el detalle llega de la FUENTE (enseguida si está embebido; del sitio, al pedirlo). El turno hace que,
  // con dos clics seguidos, sólo se abra el último: nunca dos detalles abiertos.
  var turno = 0;
  function cerrarAbierta() { var abierta = cuerpo.querySelector('.fila-det'); if (abierta) { abierta.previousElementSibling.classList.remove('abierta'); abierta.remove(); } }
  function abrir(tr, alAbrir) {
    var sig = tr.nextElementSibling;
    if (sig && sig.classList.contains('fila-det')) { sig.remove(); tr.classList.remove('abierta'); turno += 1; return; }
    var i = enC(tr); if (i === null) return;
    var mio = ++turno;
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
      fila.innerHTML = '<td colspan="' + tr.children.length + '"><span class="nd">' + (err.alDibujar ? '' : 'no se pudo traer el detalle: ') + esc(err.message) + '</span></td>';
      tr.after(fila); tr.classList.add('abierta');
    });
  }
  if (typeof window !== 'undefined') window.__abrirFila = function (tr) { abrir(tr); };
  cuerpo.addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr'); if (!tr || !tr.dataset.i) return;
    abrir(tr, function (fila) { fila.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  });
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

// ───────────────────────────── main ─────────────────────────────

const RUNS_DEFAULT = path.join(stateDirOf(os.homedir()), 'timing-history');
const SALIDA_DEFAULT = path.join(stateDirOf(os.homedir()), 'runs-dashboard.html');

const BUZON_DEFAULT = path.join(stateDirOf(os.homedir()), 'corridas-buzon');

/**
 * De dónde sale la carpeta bajada del buzón (story 2.16): `--mailbox` explícito, o la carpeta por defecto
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
 * que el kernel (pase adversarial de la 2.16). Lo que no existe se agrega tal cual. null = cadena de enlaces
 * que no termina.
 * 🔴 La raíz y el separador son los de la plataforma (pase adversarial de la 2.12): partiendo sólo por '/', en Windows
 *    ninguna ruta caía «dentro del repo» y la negativa del escritor único no se disparaba. En POSIX una '\' es parte
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
      // escribiría → null → se niega (el mismo criterio que buzonDeclarado; cazador de fallos silenciosos, iter 5).
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

/** Devuelve el código de salida; dashboard.js hace el exit. */
function main(opts = {}) {
  if (opts.clonRetirado) {
    console.error('--clone ya no existe (story 2.16, rediseño): las corridas de otras máquinas se leen de la carpeta bajada del buzón — usá --mailbox <dir>, o nada para ~/.claude/.tycon-pipeline/corridas-buzon');
    return 2;
  }
  const runsDir = path.resolve(opts.runsDir || RUNS_DEFAULT);
  const buzon = buzonDeclarado(opts);
  const maquina = buzon ? (subida ? subida.nombreDeMaquina() : null) : null;
  const M = modelo(runsDir, buzon ? { buzon, maquina } : {});
  const N = M.corridas.length;
  const log = opts.json ? console.error : console.log;
  log(`Corridas: ${N} corrida${N === 1 ? '' : 's'} de ${M.archivos} archivos · ${M.duplicados} duplicado${M.duplicados === 1 ? '' : 's'} · ${M.ilegibles} no se pudieron leer`);
  log(`  con consumo medido: ${M.corridas.filter((c) => c.consumo.estado === 'medido').length} · con controles: ${M.corridas.filter((c) => c.controles).length} · llegaron al paso 8: ${M.corridas.filter((c) => c.llego_al_final).length}`);
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
  //    buzón publicaría el trabajo de todo el equipo a todo el equipo (AC16 de la 2.16); sin buzón, dejaría
  //    commiteada una foto de UNA máquina que cambia según quién la armó (retirada el 2026-09-17).
  const salida = path.resolve(opts.salida || (M.multi ? path.join(buzon, 'runs-dashboard.html') : SALIDA_DEFAULT));
  if (dentroDelRepoDelEquipo(salida)) {
    console.error(`se niega a escribir ${path.relative(RAIZ, salida) || salida}: esa ruta es del repo del equipo, que lo clona todo el equipo${M.multi ? ', y la página tiene corridas del buzón' : ''}. La vista de corridas no se commitea: sin --output va a ${M.multi ? '<carpeta bajada>/runs-dashboard.html' : '~/.claude/.tycon-pipeline/runs-dashboard.html'}.`);
    return 2;
  }
  if (!opts.salida) { try { fs.mkdirSync(path.dirname(salida), { recursive: true }); } catch (_) { /* lo dice el write */ } }
  // story 8.9 (tanda D2, AC 43): una máquina que todavía tiene la página con su nombre de antes la lleva al nuevo antes
  // de escribir, aunque la página se regenera entera (la vieja queda intacta hasta el retiro). Una ruta que no está en
  // el mapa —la de --output o la de la carpeta del buzón— pasa derecho. Como la página no tiene historia que perder, no
  // poder llevar la vieja se dice y la página se escribe igual (pase adversarial de la D2).
  try { prepareStateWrite(salida, { where: 'scripts/nightly/dashboard/runs.js' }); }
  catch (e) { console.error(`⚠️  la página de antes del renombre no se pudo llevar (${e.message}); se escribe la nueva igual`); }
  try {
    if (!fs.existsSync(path.dirname(salida))) throw Object.assign(new Error(`la carpeta de salida no existe: ${path.dirname(salida)}`), { code: 'ENOENT' });
    fs.writeFileSync(salida, render(M), 'utf8');
    log(`\nPágina escrita: ${salida}`);
  } catch (e) { console.error(`no se pudo escribir la página: ${e.message}`); return 3; }
  return 0;
}

// `dentroDelRepoDelEquipo` también la usa dashboard.js (story 2.12): la página de seis preguntas tiene un solo escritor en el repo.
module.exports = { main, modelo, leerRegistro, modeloDeCorrida, clasificar, agruparEventos, producto, unificarProductos, nombresDePasos, lineaBasePasos, render, CONTROLES, dentroDelRepoDelEquipo,
  // story 2.27: lo que usa la pestaña Corridas del sitio
  idEstable, paraLista, paraDetalle, textosDe, cabecera, ejecutiva, tabla, pie, CLIENTE, CSS_PROPIO, SIN_HILOS,
  // el sitio con las conversaciones prendidas: el resumen de cada corrida y los textos de una, a demanda
  RESUMEN, resumirEspejo, textosDeUnaCorrida };

if (require.main === module) {
  require('../../lib/legacy-names.js').aliasArgv('scripts/nightly/dashboard/runs.js');
  const args = process.argv.slice(2);
  const valor = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  // exitCode y no exit(): con exit() una salida grande por pipe (el --json real pesa ~1 MB) se trunca.
  process.exitCode = main({ runsDir: valor('--runs-dir'), salida: valor('--output'), buzon: valor('--mailbox'), clonRetirado: args.includes('--clone'), soloLocal: args.includes('--local-only'), json: args.includes('--json'), dryRun: args.includes('--dry-run') });
}
