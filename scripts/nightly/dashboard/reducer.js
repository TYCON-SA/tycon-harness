#!/usr/bin/env node
'use strict';
/*
 * reducer.js — LA CUENTA DE FRENOS Y ESCAPES DE TODAS LAS MÁQUINAS
 *
 * Los frenos y los escapes del tablero no son «de esta máquina»: cada máquina sube sus dos registros completos
 * al buzón (`upload-runs.js`, una vez por día, comprimidos, con una `cobertura.json` que dice si pudo leerlos), la
 * bajada los deja en `~/.claude/.tycon-pipeline/corridas-buzon/<maquina>/registros/`, y este archivo los
 * CUENTA —junto con los de esta máquina, leídos del disco— y le entrega al tablero sólo números.
 *
 * 🔴 LO QUE SALE DE ACÁ LO VE TODO EL EQUIPO (la página del tablero se commitea). Los registros traen
 *    comandos, rutas, prompts y nombres de cliente; nada de eso puede salir. Por eso, lista blanca en dos capas:
 *    · Qué CAMPOS se leen lo decide este archivo (`FUENTES`, abajo), no la configuración: del `gates.log`, el
 *      nombre del control y su estado, los dos conteos de la mutación (`killed`, `total`)
 *      y el `esquema` de la línea de guía de QA, que son números, más su `clave` —una huella que sólo decide qué línea
 *      representa a cada cierre y nunca sale—; del `bypass.log`, el tipo (`type` o `kind`).
 *      Ni `cmd`, ni `repoPath`, ni `text` (el prompt del dev), ni `command`, ni `cwd`, ni `reason`, ni `story`.
 *      Agregar un campo es código con su prueba de fuga.
 *    · Una métrica puede JUNTAR valores en vez de sumarlos (`DISTRIBUCIONES`): la mediana de un
 *      puntaje se calcula sobre la unión de las muestras de todas las máquinas, nunca promediando medianas.
 *    · Qué VALORES puede publicar una dimensión lo declara `sources.json → reducer.metrics.*.values`, una
 *      lista cerrada. Lo que no está sale `otro`. Una métrica con una fuente, una dimensión o un tipo que este
 *      archivo no conoce, o sin lista cerrada, hace que el reductor SE NIEGUE.
 *    · Toda palabra que sale es un alias validado, una fecha validada o un valor de la lista. Ningún motivo trae
 *      una ruta ni un mensaje del sistema: sólo texto nuestro y el `code` del error.
 *
 * Además de contar, junta la RETENCIÓN de una vuelta atrás que declara cada máquina (`hold` de su cobertura; la de esta
 * máquina, de su `harness-state.json`): qué máquina no se actualiza sola, la versión que deshizo y desde cuándo. Sólo
 * esos dos datos, validados por su forma; una máquina que no la declaró es «no medida», nunca «sin retención».
 *
 * 🔴 RECALCULA DESDE EL DISCO, NUNCA ACUMULA: nada se guarda. Las máquinas se suman por numerador y
 *    denominador, jamás promediando; la misma máquina en el disco local y en la carpeta bajada cuenta una vez.
 *
 * 🔴 «NO MEDIDO» NUNCA ES 0: una máquina cuya cobertura declara una fuente `no_medido`, o cuyo registro no se
 *    puede descomprimir, no cuenta para esa métrica — ni como cero. Una carpeta sin cobertura legible se cuenta
 *    como ilegible.
 *
 * El alias de una máquina es una HUELLA de su nombre (`maq-` + 6 hex). No es anonimato (con el nombre en la
 * mano se recalcula); es que el nombre de una persona no termine en la página.
 *
 * Uso:
 *   node scripts/nightly/dashboard/reducer.js [--json]            # la cuenta, sólo números, alias y fechas
 *   node scripts/nightly/dashboard/reducer.js --alias             # el alias de esta máquina (para declararla): el de
 *                                                                 # su carpeta del buzón, `<nombre>-<código>`
 *   node scripts/nightly/dashboard/reducer.js --alias-of <nombre> # el alias de otra máquina, por su carpeta entera
 *                                                                 # (`macbook-pro-1a2b3c4d`) o por su nombre viejo
 *
 * Carpetas viejas: una carpeta `unida` a su nueva (`.carpetas-de-maquina.json` del bajador) no se cuenta
 * aparte, y la cobertura muestra «maq-<nuevo> (antes, maq-<viejo>)»; una `compartida` tampoco. Una `siguio_recibiendo`
 * se cuenta como una máquina propia (lo que recibió después de la mudanza es de otra máquina que no actualizó).
 *
 * Contrato de salida:
 *   0 → contó (aunque alguna máquina o fuente no se haya podido medir: eso va en la cobertura)
 *   1 → no pudo (sources.json ilegible o sin sección, sin nombre de máquina)
 *   2 → se negó (la lista blanca de sources.json está rota)
 *
 * Variables (para el banco): TYCON_LOGS_SOURCE (registros de esta máquina), TYCON_MAILBOX_DIR (carpeta
 * bajada), TYCON_SOURCES_JSON, TYCON_TODAY, TYCON_MACHINE.
 */

const fs = require('fs');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { nombreDeMaquina, normalizarNombreDeMaquina, FORMA_MAQUINA, REGISTROS, holdForMailbox, FORMA_DESHECHA, FORMA_MOMENTO } = require('../../metrics/upload-runs.js');
const { readEnv } = require('../../lib/legacy-names.js');
/** Una variable renombrada a inglés: el nombre viejo sigue valiendo hasta el retiro. */
const variable = (nombre) => readEnv(nombre, { where: 'scripts/nightly/dashboard/reducer.js' });

const ESQUEMA = 1;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const FORMA_ALIAS = /^maq-[0-9a-f]{6}$/;
const FORMA_VALOR = /^[A-Za-z0-9_-]{1,40}$/;
const FORMA_METRICA = /^[a-z][a-z0-9_]{0,30}$/;
const ESTADOS_BLOQUEO = new Set(['blocked', 'red', 'fail', 'failed', 'FAIL', 'rejected']);

/**
 * ¿Ese estado es un bloqueo?
 *
 * 🔴 El vocabulario NO es plano: las pruebas y la compilación escriben el detalle pegado al estado
 *    —`red:exit=1`, `red:exit=127`, `fail:timeout`—, así que la igualdad exacta los contaría como «no
 *    bloqueó» y publicaría bloqueos como cero, con una ficha que diría «0 % de bloqueos» sobre
 *    evaluaciones que salieron en rojo. Se mira lo que hay ANTES de los dos puntos, y sólo si los dos puntos están: `redundante`
 *    y `greenish` empiezan igual que un bloqueo y no lo son.
 */
function esBloqueo(v) {
  if (typeof v !== 'string') return false;            // un objeto raro es evaluación sin bloqueo
  if (ESTADOS_BLOQUEO.has(v)) return true;
  const i = v.indexOf(':');
  return i > 0 && ESTADOS_BLOQUEO.has(v.slice(0, i));
}
const DIAS_ATRASO = 3;   // una máquina cuya última subida es anterior a ayer − 2 está atrasada
// 🔴 Topes contra un registro inflado a propósito (la llave de escritura del buzón la tiene cualquiera con el
//    repo): un .gz de más de 16 MB, o que descomprime a más de 64 MB, no se lee — esa máquina no mide.
const MAX_GZ_BYTES = 16 * 1024 * 1024;
const MAX_REGISTRO_BYTES = 64 * 1024 * 1024;

/**
 * La lista CERRADA de lo que cada fuente puede leer. `etiqueta` devuelve el valor crudo de la dimensión (que
 * después se filtra contra la lista cerrada de la métrica); cada tipo devuelve { num, den } de un evento.
 */
/** El nombre del control de una línea de `gates.log`, por las cuatro formas en que se escribe. */
const controlDe = (d) => d.name || d.check || d.gate || d.type;
/** Un entero no negativo de verdad: `null`, `12.5` o `"12"` no son un conteo de mutantes. */
const enteroNoNegativo = (x) => Number.isInteger(x) && x >= 0;
/**
 * La duración de una corrida de la suite, en segundos, o null si la línea no es una. Una sola lectura
 * para la ficha local (el gates.log de esta máquina) y para la cuenta del equipo: control `tests` y `durationMs` número
 * finito ≥ 0. `"1500"`, un negativo o un infinito no son una duración.
 */
function duracionSuite(d) {
  if (!d || typeof d !== 'object' || controlDe(d) !== 'tests') return null;
  return typeof d.durationMs === 'number' && Number.isFinite(d.durationMs) && d.durationMs >= 0 ? d.durationMs / 1000 : null;
}

const FUENTES = {
  gates: {
    archivo: 'gates.log',
    // `type` es la CUARTA forma de nombrar un control: sin leerla, líneas como las de
    // `smoke-run` y `RUNTIME_WAIVER` caerían en un balde anónimo.
    dims: {
      control: { etiqueta: controlDe, sinValor: 'sin-nombre' },
      // el estado de una línea, para las métricas de mutación y guía de QA. Sólo lo usan tipos que
      // descartan las líneas de otros controles; y como toda dimensión, sale filtrado por la lista cerrada.
      estado: { etiqueta: (d) => d.status, sinValor: 'sin-estado' },
    },
    // Sólo un estado que es TEXTO puede bloquear: un objeto raro cuenta como evaluación sin bloqueo (String() sobre
    // un objeto con toString no llamable tiraba la cuenta entera).
    tipos: {
      // `cobertura-tocada` no es una evaluación que pueda bloquear: se observa sin frenar, así que
      // no suma al denominador de los bloqueos — si sumara, la proporción de bloqueos bajaría sola.
      // Tampoco una guía de QA que NO APLICA: no se evaluó nada.
      ratio: (d) => ((d.name || d.check) === 'cobertura-tocada' || (controlDe(d) === 'qa-guide' && d.status === 'no-aplica')
        ? { num: 0, den: 0 }
        : { num: esBloqueo(d.status || d.verdict || d.decision) ? 1 : 0, den: 1 }),
      // ── mutación y guía de QA ──────────────────────────────────────────────────────────
      // Estos tipos devuelven `null` para las líneas que no les tocan: una línea de otro control no es ni una
      // muestra ni un chequeo, y no puede crear una entrada en la dimensión.
      // 🔴 Un puntaje es una MUESTRA sólo con los dos conteos enteros, `total > 0` y `killed ≤ total`. Un
      //    chequeo que no pudo correr (`structural`, `error`, un `pass` sin mutantes) no es un 0 %: no midió.
      muestra_mutacion: (d) => (controlDe(d) === 'mutation' && tienePuntaje(d) ? { muestra: d.killed / d.total } : null),
      // la duración de la suite: una muestra por corrida de `tests`, en segundos. Sólo el número sale.
      muestra_duracion_suite: (d) => { const s = duracionSuite(d); return s === null ? null : { muestra: s }; },
      ratio_mutacion_con_puntaje: (d) => (controlDe(d) === 'mutation' ? { num: tienePuntaje(d) ? 1 : 0, den: 1 } : null),
      conteo_qa_guia: (d) => (controlDe(d) === 'qa-guide' ? { num: 1, den: null, clave: claveDeCierre(d) } : null),
      // 🔴 La proporción sólo con el REGISTRO COMPLETO (`esquema: 2`): un registro que anota sólo
      //    las guías que faltan o están viejas deja «presentes» en 0 por construcción.
      //    `no-aplica` tampoco entra: esa story no necesitaba guía.
      ratio_qa_presente: (d) => (controlDe(d) === 'qa-guide' && d.esquema === 2 && ['presente', 'missing', 'stale'].includes(d.status)
        ? { num: d.status === 'presente' ? 1 : 0, den: 1, clave: claveDeCierre(d) }
        : null),
      // la observación del 75 % sobre las líneas tocadas (`cobertura-tocada`), que no frena.
      // `ratio_evaluo`: de las corridas, cuántas pudieron medir (todo lo que no es `no-medido`).
      // `ratio_habria_frenado`: de las que midieron, cuántas habrían frenado. Un `no-medido` NO entra al
      // denominador del segundo: una corrida que no pudo mirar no «cumplió».
      // Las dos sólo cuentan las líneas `cobertura-tocada`: el resto de gates.log no es una corrida de test-gate.
      ratio_evaluo: (d) => {
        const es = (d.name || d.check) === 'cobertura-tocada';
        return { num: es && (d.status === 'cumple' || d.status === 'habria-frenado') ? 1 : 0, den: es ? 1 : 0 };
      },
      ratio_habria_frenado: (d) => {
        const es = (d.name || d.check) === 'cobertura-tocada';
        return { num: es && d.status === 'habria-frenado' ? 1 : 0, den: es && (d.status === 'cumple' || d.status === 'habria-frenado') ? 1 : 0 };
      },
    },
  },
  bypass: {
    archivo: 'bypass.log',
    dims: { tipo: { etiqueta: (d) => d.type || d.kind, sinValor: 'sin-tipo' } },
    tipos: { conteo: () => ({ num: 1, den: null }) },
  },
  // la constancia de los frenos PREVIOS a la herramienta. Unidad distinta a `gates`
  // (que son evaluaciones de una corrida del pipeline): acá cada línea es una decisión sobre UN
  // comando. Del archivo se leen tres campos y ninguno más: ni la huella del comando sale.
  frenos: {
    archivo: 'frenos.jsonl',
    dims: {
      freno: { etiqueta: (d) => d.freno, sinValor: 'sin-freno' },
      regla: { etiqueta: (d) => d.regla, sinValor: 'sin-regla' },
    },
    // Dos numeradores sobre el MISMO denominador para que la ficha pueda poner, de una regla,
    // cuántas veces frenó y cuántas la saltearon — uno al lado del otro (AC 10).
    tipos: {
      ratio_bloqueo: (d) => ({ num: d.veredicto === 'bloqueo' ? 1 : 0, den: 1 }),
      ratio_escape: (d) => ({ num: d.veredicto === 'escape' ? 1 : 0, den: 1 }),
      // 🔴 `aviso` es el ÚNICO veredicto que puede producir `push-referencia-fantasma`, que nunca
      //    bloquea. Sin este agregador la ficha lo publicaría como «frenó 0, lo saltearon 0»: se
      //    vería igual que uno que nunca se disparó, justo lo que la ficha existe para evitar.
      ratio_aviso: (d) => ({ num: d.veredicto === 'aviso' ? 1 : 0, den: 1 }),
    },
  },
  // el carril de cada commit hecho desde una sesión. Del archivo se lee UN campo: el
  // carril. La story viaja en el registro (sirve para leerlo a mano en el buzón) pero no es una
  // dimensión: nunca puede salir a la página.
  carriles: {
    archivo: 'carriles.jsonl',
    dims: { carril: { etiqueta: (d) => d.carril, sinValor: 'sin-carril' } },
    tipos: { conteo: () => ({ num: 1, den: null }) },
  },
  // los hallazgos de los revisores, ya proyectados por `collect-findings.js` a seis
  // claves. 🔴 La dimensión publicada por ACÁ es la GRAVEDAD, no la regla: esta métrica contesta
  // «cuántos hallazgos tuvo el equipo», que es una cuenta agregada con piso y ventana. La tabla POR
  // REGLA la arma `prune.js` leyendo el mismo material sin piso ni recorte — porque ahí «1 hallazgo»
  // y «0 hallazgos» son la diferencia entre dejar una regla y retirarla, y el piso la borraría.
  hallazgos: {
    archivo: 'hallazgos.jsonl',
    dims: { severidad: { etiqueta: (d) => d.severidad, sinValor: 'sin-gravedad' } },
    tipos: { conteo: () => ({ num: 1, den: null }) },
    // La serie trae también las líneas `{volcado, medida}` (qué corridas se leyeron): no son hallazgos.
    incluye: (d) => typeof d.regla === 'string',
    // 🔴 «Medida» es la regla del recolector, UNA sola: en esta máquina, el sello; del buzón, que la serie
    //    coincida con el resumen que viajó con ella. Sin esto, un archivo sin sello o vacío contaba.
    local: (archivo, dia, cfg) => {
      const maxDias = cfg && cfg.prune && cfg.prune.max_findings_days;
      const e = recolector().estadoDeLaSerie({ salida: archivo, hoy: dia, maxDias });
      return e.estado === 'medido' ? { texto: e.texto } : null;
    },
    remota: (texto, fuente) => recolector().serieCoincide(texto, fuente && fuente.resumen).ok,
  },
};
function recolector() { return require('../../metrics/collect-findings.js'); }
/**
 * La identidad de un CIERRE en la línea de la guía de QA. El aviso escribe su
 * línea en cada intento de commit, antes de frenos que pueden cortarlo: sin esta clave, un cierre que rebotó tres
 * veces contaba como tres. Es una huella de 16 hexadecimales de repo + story + contenido (sin el estado); cualquier otra
 * cosa no deduplica (cuenta la línea). De cada clave cuenta la ÚLTIMA línea: el resultado final del cierre, no el
 * primer rebote. Nunca sale del reductor: sólo decide qué línea representa al cierre.
 */
function claveDeCierre(d) { return typeof d.clave === 'string' && /^[0-9a-f]{16}$/.test(d.clave) ? d.clave : null; }
function tienePuntaje(d) { return enteroNoNegativo(d.killed) && enteroNoNegativo(d.total) && d.total > 0 && d.killed <= d.total; }
/**
 * Los tipos que JUNTAN valores en vez de sumarlos. Una mediana no se suma: con dos máquinas hay que
 * calcularla sobre la unión de sus muestras, nunca promediando las medianas de cada una. Lo que sale son números,
 * sin ninguna etiqueta de la línea de origen.
 */
const DISTRIBUCIONES = new Set(['muestra_mutacion', 'muestra_duracion_suite']);
// Lo que se cuenta tiene que ser lo que la subida sube: una sola lista de archivos, y si se separan, se dice.
for (const f of Object.values(FUENTES)) {
  if (!REGISTROS.includes(f.archivo)) throw new Error(`reductor: ${f.archivo} no está entre los registros que sube upload-runs.js`);
}
// El NOMBRE de la fuente tiene que ser el que la cobertura declara (el archivo sin su
// última extensión). Si no, la máquina se lee «no medida» para siempre y en silencio.
for (const [id, f] of Object.entries(FUENTES)) {
  const esperado = f.archivo.replace(/\.[^.]+$/, '');
  if (id !== esperado) throw new Error(`reductor: la fuente «${id}» declara el archivo ${f.archivo}, cuya cobertura se llama «${esperado}»`);
}

const casaPipeline = () => path.join(stateDirOf(os.homedir()));

function fechaValida(f) {
  return typeof f === 'string' && FECHA.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`))
    && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;
}
function restarDias(fecha, n) {
  return new Date(Date.parse(`${fecha}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}

/**
 * El alias de un nombre de máquina YA normalizado (el de una carpeta del buzón, el de nombreDeMaquina()). No se
 * vuelve a normalizar: la normalización no es idempotente para todo nombre («maq.local.local» → «maq.local» →
 * «maq»), y renormalizar haría que la copia bajada de esta máquina no se reconozca.
 */
function aliasDeNombre(n) {
  if (typeof n !== 'string' || !n || !FORMA_MAQUINA.test(n)) return null;
  return `maq-${crypto.createHash('sha256').update(`tycon-maquina:${n}`).digest('hex').slice(0, 6)}`;
}
/** El alias de un nombre tal como lo escribe una persona (`--alias-of`): se normaliza UNA vez, como la subida. */
function aliasDe(nombre) { return aliasDeNombre(normalizarNombreDeMaquina(nombre)); }

/**
 * Las uniones de carpetas del buzón. Cada máquina sube a `<nombre>-<código>`; la
 * carpeta vieja (`<nombre>`) puede seguir existiendo. La unión la calcula UNA función del bajador (`carpetasDeMaquina` de
 * `download-runs.js`), que la deja en `<espejo>/.carpetas-de-maquina.json`; el reductor, la poda y la vista de corridas
 * leen ese archivo y nunca `place.json` (que trae el correo). Devuelve `{ estado: 'medidas', carpetas: Map(vieja →
 * { estado, nueva, declarantes, desde }) }`, o `{ estado: 'no_medidas', motivo }` si no está o no tiene forma: entonces
 * no se une nada, cada carpeta cuenta como hoy, y quien lee lo dice («uniones de carpetas no medidas»).
 * 🔴 Una entrada sin forma invalida el archivo entero: unir a medias falla hacia mostrar de más.
 */
const ARCHIVO_UNIONES = '.carpetas-de-maquina.json';
const ESTADOS_UNION = new Set(['unida', 'compartida', 'siguio_recibiendo']);
function leerUnionesDeCarpetas(buzon) {
  const no = (motivo) => ({ estado: 'no_medidas', motivo });
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(buzon, ARCHIVO_UNIONES), 'utf8')); }
  catch (e) { return no(e instanceof SyntaxError ? 'el archivo de uniones del bajador no es JSON' : e.code === 'ENOENT' ? 'el bajador no dejó el archivo de uniones' : `el archivo de uniones no se pudo leer (${e.code || 'error'})`); }
  if (!d || typeof d !== 'object' || d.schema !== 1 || !d.carpetas || typeof d.carpetas !== 'object' || Array.isArray(d.carpetas)) return no('el archivo de uniones no tiene la forma esperada');
  const carpetas = new Map();
  for (const [vieja, u] of Object.entries(d.carpetas)) {
    const forma = FORMA_MAQUINA.test(vieja) && u && typeof u === 'object' && ESTADOS_UNION.has(u.estado)
      && Number.isInteger(u.declarantes) && u.declarantes >= 1 && (u.desde === null || u.desde === undefined || fechaValida(u.desde))
      && (u.estado === 'unida' ? typeof u.nueva === 'string' && FORMA_MAQUINA.test(u.nueva) && u.nueva !== vieja : (u.nueva === null || u.nueva === undefined));
    if (!forma) return no('una entrada del archivo de uniones no tiene forma');
    carpetas.set(vieja, { estado: u.estado, nueva: u.estado === 'unida' ? u.nueva : null, declarantes: u.declarantes, desde: u.desde || null });
  }
  return { estado: 'medidas', carpetas };
}

/** Los baldes que juntan muchos valores («otro» y los «sin-…»): nunca son «una regla». */
const BALDES_GENERICOS = new Set(['otro', ...Object.values(FUENTES).flatMap((f) => Object.values(f.dims).map((d) => d.sinValor))]);

/**
 * Valida la sección `reducer` de sources.json. Devuelve { reductor } o { codigo, motivo }:
 * codigo 1 = no hay con qué contar (sección ausente); codigo 2 = la lista blanca está rota (se niega).
 */
function validarConfig(cfg) {
  const r = cfg && typeof cfg === 'object' ? cfg.reducer : null;
  if (r === undefined || r === null) return { codigo: 1, motivo: 'sources.json no tiene la sección «reducer»' };
  const niega = (m) => ({ codigo: 2, motivo: `se niega: ${m}` });
  // Presente pero sin forma es una configuración ROTA, no una ausente: se niega (exit 2), no «no hay con qué contar».
  if (typeof r !== 'object' || Array.isArray(r)) return niega('«reducer» tiene que ser un objeto');
  if (r.schema !== ESQUEMA) return niega(`«reducer.schema» tiene que ser ${ESQUEMA}`);
  for (const k of ['window_days', 'floor']) {
    if (!Number.isInteger(r[k]) || r[k] < 1 || r[k] > 400) return niega(`«reducer.${k}» tiene que ser un entero entre 1 y 400`);
  }
  if (!Array.isArray(r.expected_machines)) return niega('«reducer.expected_machines» tiene que ser una lista');
  const vistos = new Set();
  for (const m of r.expected_machines) {
    if (!m || !FORMA_ALIAS.test(String(m.alias)) || !fechaValida(m.from)) return niega('cada máquina esperada necesita «alias» (maq-xxxxxx) y «from» (AAAA-MM-DD)');
    if (vistos.has(m.alias)) return niega(`la máquina esperada ${m.alias} está declarada dos veces: inflaría la cobertura`);
    vistos.add(m.alias);
  }
  const metricas = r.metrics;
  if (!metricas || typeof metricas !== 'object' || !Object.keys(metricas).length) return niega('«reducer.metrics» está vacía');
  for (const [nombre, m] of Object.entries(metricas)) {
    if (!FORMA_METRICA.test(nombre)) return niega('un nombre de métrica no tiene forma de identificador');
    if (!m || typeof m !== 'object') return niega(`la métrica «${nombre}» no es un objeto`);
    const f = Object.prototype.hasOwnProperty.call(FUENTES, m.source) ? FUENTES[m.source] : null;
    if (!f) return niega(`la métrica «${nombre}» declara una fuente que el reductor no conoce`);
    if (!Object.prototype.hasOwnProperty.call(f.dims, m.dim)) return niega(`la métrica «${nombre}» declara una dimensión que su fuente no permite leer`);
    if (!Object.prototype.hasOwnProperty.call(f.tipos, m.type)) return niega(`la métrica «${nombre}» declara un tipo que su fuente no permite`);
    if (!Array.isArray(m.values) || !m.values.length) return niega(`la métrica «${nombre}» no declara la lista cerrada de valores de su dimensión`);
    if (!m.values.every((v) => typeof v === 'string' && FORMA_VALOR.test(v))) return niega(`la métrica «${nombre}» tiene un valor que no es un identificador (letras, números, - y _)`);
    // `values_only` cuenta SÓLO lo de la lista (lo demás no entra ni como «otro»). Dos grupos de frenos
    // comparten fuente —los previos a la herramienta y los del cierre— y cada ficha tiene que contar el suyo.
    if (m.values_only !== undefined && typeof m.values_only !== 'boolean') return niega(`la métrica «${nombre}» declara «values_only» y no es verdadero/falso`);
  }
  return { reductor: r };
}

/** El valor publicable de una dimensión: de la lista cerrada, `sin-…` si falta, `otro` si no está. */
function valorPublicable(crudo, def, valores) {
  if (crudo === undefined || crudo === null || crudo === '') return valores.includes(def.sinValor) ? def.sinValor : 'otro';
  if (typeof crudo !== 'string') return 'otro';
  return valores.includes(crudo) ? crudo : 'otro';
}

/** La cobertura de una máquina bajada, validada: sólo campos con forma. null si no sirve. */
function coberturaValida(c) {
  if (!c || typeof c !== 'object' || c.esquema !== ESQUEMA || !fechaValida(c.fecha) || !c.fuentes || typeof c.fuentes !== 'object') return null;
  const fuentes = {};
  for (const id of Object.keys(FUENTES)) fuentes[id] = c.fuentes[id] && c.fuentes[id].estado === 'medido' ? 'medido' : 'no_medido';
  // `detalle` es lo que la máquina declaró de cada fuente, tal cual: sólo lo leen los chequeos de `remota`.
  return { fecha: c.fecha, fuentes, detalle: c.fuentes, retencion: retencionValida(c.hold) };
}

/**
 * La retención de una vuelta atrás que declaró una máquina (`hold` de su cobertura, `holdForMailbox` de upload-runs.js),
 * validada otra vez: a la página llegan sólo la versión deshecha y el momento, con su forma. Una cobertura sin el campo
 * (una máquina con un arnés anterior) o que dice `no_medido` es «no medida», nunca «sin retención».
 */
function retencionValida(h) {
  if (h === null) return { estado: 'ninguna' };
  if (!h || typeof h !== 'object' || Array.isArray(h)) return { estado: 'no_medido' };
  // sin el mecanismo de instalación no hay nada que retenga la actualización
  if (h.status === 'no_aplica') return { estado: 'ninguna' };
  if (h.status !== undefined) return { estado: 'no_medido' };
  return {
    estado: 'vigente',
    deshizo: typeof h.undone === 'string' && FORMA_DESHECHA.test(h.undone) ? h.undone : null,
    desde: typeof h.since === 'string' && FORMA_MOMENTO.test(h.since) ? h.since : null,
  };
}

/**
 * Cuenta los registros de esta máquina (`registros`: la carpeta con gates.log y bypass.log) y de la carpeta
 * bajada del buzón (`buzon`: `<buzon>/<maquina>/registros/`). Devuelve:
 *   { estado, motivo?, ventana:{desde,hasta}, piso, cobertura:{esperadas, reportaron, ausentes, atrasadas,
 *     sin_declarar, carpetas_ilegibles}, metricas:{<nombre>:{tipo, num, den, porDim, maquinas, midieron}} }
 */
function juntar({ registros, buzon, cfg, hoy, maquina } = {}) {
  const v = validarConfig(cfg);
  if (!v.reductor) return { estado: 'no_medido', codigo: v.codigo, motivo: `la configuración del reductor no sirve: ${v.motivo}` };
  const r = v.reductor;
  const dia = fechaValida(hoy) ? hoy : new Date().toISOString().slice(0, 10);
  const ventana = { desde: restarDias(dia, r.window_days), hasta: restarDias(dia, 1) };

  // 1 · las máquinas: esta, leída del disco, y las bajadas del buzón.
  // 🔴 «No existe» (ENOENT) es legítimo: la máquina no participa. Cualquier otra falla es «no pude mirar» y se
  //    DICE (no_leidos / carpetas_ilegibles): leída como «no hay», la página publicaría a las esperadas como
  //    «no reportó» cuando en realidad no se pudo leer.
  const maquinas = new Map();   // alias → { fecha, fuentes, leer(id) }
  let carpetasIlegibles = 0;
  const noLeidos = [];
  let lineasIlegibles = 0;
  const tamanoOk = (archivo, max) => fs.statSync(archivo).size <= max;
  const aliasLocal = registros ? aliasDeNombre(maquina === undefined ? nombreDeMaquina() : maquina) : null;
  // Sin nombre con forma no hay alias: se DICE (sin el nombre crudo), o la página la mostraría como «no reportó».
  if (registros && !aliasLocal) noLeidos.push('no se pudo saber el nombre de esta máquina: sus registros no se cuentan');
  if (registros && aliasLocal) {
    let esCarpeta = false;
    try {
      esCarpeta = fs.statSync(registros).isDirectory();
      if (!esCarpeta) noLeidos.push('los registros de esta máquina no están en una carpeta (no es un directorio)');
    } catch (e) {
      if (e.code !== 'ENOENT') noLeidos.push(`no se pudieron leer los registros de esta máquina (${e.code || 'error'})`);
    }
    if (esCarpeta) {
      const textos = {};
      const fuentes = {};
      for (const [id, f] of Object.entries(FUENTES)) {
        try {
          const archivo = path.join(registros, f.archivo);
          if (f.local) {
            const r = f.local(archivo, dia, cfg);
            if (!r) throw new Error('no medida');
            textos[id] = r.texto; fuentes[id] = 'medido';
            continue;
          }
          if (!tamanoOk(archivo, MAX_REGISTRO_BYTES)) throw Object.assign(new Error('grande'), { code: 'EFBIG' });
          textos[id] = fs.readFileSync(archivo, 'utf8'); fuentes[id] = 'medido';
        } catch (_) { fuentes[id] = 'no_medido'; }
      }
      // la retención de esta máquina sale de su estado, al lado de sus registros (la misma lectura que sube al buzón). Con
      // los registros de otra carpeta (--logs, TYCON_LOGS_SOURCE), que falte el estado no prueba que la máquina no tenga
      // el mecanismo de instalación: sale «sin medir», nunca «ninguna».
      let retencion;
      try {
        const hold = holdForMailbox(path.join(registros, 'harness-state.json'));
        const propia = path.resolve(registros) === path.resolve(casaPipeline());
        retencion = retencionValida(!propia && hold && hold.status === 'no_aplica' ? { status: 'no_medido', reason: 'el estado no está junto a los registros leídos' } : hold);
      } catch (_) { retencion = { estado: 'no_medido' }; }
      maquinas.set(aliasLocal, { fecha: dia, fuentes, retencion, leer: (id) => textos[id] });
    }
  }
  // las carpetas viejas del buzón. Una `unida` no se cuenta aparte (sus registros están enteros en la nueva);
  // una `compartida` tampoco (duplica a alguna de sus declarantes, que vuelven a subir lo suyo a su carpeta nueva). Una
  // `siguio_recibiendo` SÍ se cuenta, como una máquina propia: lo que llegó después de la mudanza es de OTRA máquina que
  // todavía no actualizó, y el juego de registros más nuevo que eligió el bajador es el suyo, no un duplicado.
  let uniones = null;
  const unidas = [];      // { vieja, nueva }
  const apartadas = [];   // { alias, estado, declarantes }
  if (buzon) {
    let entradas = [];
    let leido = false;
    try { entradas = fs.readdirSync(buzon, { withFileTypes: true }); leido = true; }
    catch (e) {
      entradas = [];
      if (e.code !== 'ENOENT') noLeidos.push(`no se pudo leer la carpeta bajada del buzón (${e.code || 'error'}): las otras máquinas faltan, no son cero`);
    }
    if (leido) uniones = leerUnionesDeCarpetas(buzon);
    const aliasEsperados = new Set(r.expected_machines.map((m) => m.alias));
    for (const en of entradas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!FORMA_MAQUINA.test(en.name)) continue;
      const u = uniones && uniones.estado === 'medidas' ? uniones.carpetas.get(en.name) : null;
      if (u && u.estado === 'unida') { unidas.push({ vieja: en.name, nueva: u.nueva }); continue; }
      if (u && u.estado === 'compartida') { apartadas.push({ alias: aliasDeNombre(en.name), estado: u.estado, declarantes: u.declarantes }); continue; }
      // Un ARCHIVO suelto en la carpeta bajada (la página de la vista de corridas vive ahí) no es una máquina. Un enlace
      // se decide por lo que apunta, y uno roto sí se cuenta: no se puede afirmar qué es. Pero si el archivo lleva el
      // nombre de una máquina ESPERADA, es esa máquina rota: ilegible, no «no reportó».
      let esCarpeta = en.isDirectory();
      if (en.isSymbolicLink()) {
        try { esCarpeta = fs.statSync(path.join(buzon, en.name)).isDirectory(); } catch (_) { carpetasIlegibles += 1; continue; }
      }
      if (!esCarpeta) { if (aliasEsperados.has(aliasDeNombre(en.name))) carpetasIlegibles += 1; continue; }
      const dirReg = path.join(buzon, en.name, 'registros');
      let hay = false;
      try {
        hay = fs.statSync(dirReg).isDirectory();
        if (!hay) { carpetasIlegibles += 1; continue; }   // existe pero no es una carpeta: no se puede afirmar nada
      } catch (e) {
        if (e.code === 'ENOENT') continue;   // una máquina que sólo sube corridas: no reportó registros
        carpetasIlegibles += 1; continue;
      }
      const alias = aliasDeNombre(en.name);
      if (!alias || maquinas.has(alias)) continue;   // esta máquina: gana el disco local
      let c = null;
      try { c = coberturaValida(JSON.parse(fs.readFileSync(path.join(dirReg, 'cobertura.json'), 'utf8'))); } catch (_) { c = null; }
      if (!c) { carpetasIlegibles += 1; continue; }
      maquinas.set(alias, {
        fecha: c.fecha,
        fuentes: c.fuentes,
        retencion: c.retencion,
        remota: true,
        detalle: c.detalle,
        leer: (id) => {
          const gz = path.join(dirReg, `${FUENTES[id].archivo}.gz`);
          if (!tamanoOk(gz, MAX_GZ_BYTES)) throw Object.assign(new Error('grande'), { code: 'EFBIG' });
          return zlib.gunzipSync(fs.readFileSync(gz), { maxOutputLength: MAX_REGISTRO_BYTES }).toString('utf8');
        },
      });
    }
  }

  // 2 · contar
  const metricas = {};
  // Las claves de cierre ya contadas, por métrica y entre TODAS las máquinas. Fuera de `metricas` a propósito:
  // no se publican.
  const vistas = {};
  for (const [nombre, m] of Object.entries(r.metrics)) {
    const dist = DISTRIBUCIONES.has(m.type);
    // `aportaron`: máquinas con al menos un evento de esta métrica. «Midió» dice que pudo leer su
    // registro; «aportó» dice que había algo. Con una sola que aporta, la serie no es del equipo, y la página lo dice.
    metricas[nombre] = { tipo: m.type, num: 0, den: m.type === 'conteo' || /^conteo_/.test(m.type) || dist ? null : 0, porDim: {}, maquinas: maquinas.size, midieron: 0, aportaron: 0 };
    if (dist) metricas[nombre].muestras = [];
  }
  for (const maq of maquinas.values()) {
    const eventos = {};   // id de fuente → objetos en la ventana, o null si no se pudo leer
    for (const id of Object.keys(FUENTES)) {
      if (maq.fuentes[id] !== 'medido') { eventos[id] = null; continue; }
      let texto;
      try { texto = maq.leer(id); } catch (_) { eventos[id] = null; continue; }
      if (typeof texto !== 'string') { eventos[id] = null; continue; }
      if (maq.remota && FUENTES[id].remota && !FUENTES[id].remota(texto, maq.detalle && maq.detalle[id])) { eventos[id] = null; continue; }
      const lista = [];
      for (const linea of texto.split('\n')) {
        const t = linea.trim();
        if (!t) continue;
        // Una línea rota se CUENTA (cobertura.lineas_ilegibles): descartarla en silencio bajaría el número sin decir por qué.
        let o; try { o = JSON.parse(t); } catch (_) { lineasIlegibles += 1; continue; }
        if (!o || typeof o !== 'object' || Array.isArray(o)) { lineasIlegibles += 1; continue; }
        if (FUENTES[id].incluye && !FUENTES[id].incluye(o)) continue;
        // Sin fecha legible no se puede ubicar en la ventana: es una línea ilegible, no una «fuera de la ventana».
        const fecha = typeof o.ts === 'string' ? o.ts.slice(0, 10) : '';
        if (!fechaValida(fecha)) { lineasIlegibles += 1; continue; }
        if (fecha < ventana.desde || fecha > ventana.hasta) continue;
        lista.push(o);
      }
      eventos[id] = lista;
    }
    for (const [nombre, m] of Object.entries(r.metrics)) {
      const lista = eventos[m.source];
      if (!lista) continue;
      const acc = metricas[nombre];
      acc.midieron += 1;
      const def = FUENTES[m.source].dims[m.dim];
      const aporte = FUENTES[m.source].tipos[m.type];
      let aporto = false;
      // De cada clave de cierre, la ÚLTIMA línea de esta máquina es la que cuenta: los intentos
      // anteriores del mismo cierre se saltean. Entre máquinas, la primera que la trae (el mismo cierre en dos
      // máquinas es excepcional).
      const ultima = new Map();
      lista.forEach((o, i) => {
        if (m.values_only === true && !m.values.includes(def.etiqueta(o))) return;
        const a = aporte(o); if (a && a.clave) ultima.set(a.clave, i);
      });
      for (const [i, o] of lista.entries()) {
        // Un tipo devuelve null para la línea que no le toca: se descarta ANTES de calcular la dimensión,
        // para que las líneas de otros controles no creen entradas «otro» ni «sin-estado».
        const a = aporte(o);
        if (!a) continue;
        // Se mira antes de la clave, para que una línea ajena no ocupe el lugar de un cierre: con `values_only`, lo que no es de la lista no es de esta métrica — ni aporta ni sale «otro».
        if (m.values_only === true && !m.values.includes(def.etiqueta(o))) continue;
        if (a.clave) {
          if (ultima.get(a.clave) !== i) { aporto = true; continue; }
          const v = vistas[nombre] || (vistas[nombre] = new Set());
          if (v.has(a.clave)) { aporto = true; continue; }
          v.add(a.clave);
        }
        aporto = true;
        const dim = valorPublicable(def.etiqueta(o), def, m.values);
        if (!acc.porDim[dim]) acc.porDim[dim] = { num: 0, den: acc.den === null ? null : 0 };
        if (acc.muestras) { acc.muestras.push(a.muestra); acc.num += 1; acc.porDim[dim].num += 1; continue; }
        acc.num += a.num; acc.porDim[dim].num += a.num;
        if (acc.den !== null) { acc.den += a.den; acc.porDim[dim].den += a.den; }
      }
      if (aporto) acc.aportaron += 1;
    }
  }

  // 3 · la cobertura de máquinas
  // Una máquina se espera DESDE su fecha: antes de que empiece a subir, no puede faltar.
  const esperadas = r.expected_machines.filter((m) => m.from <= ventana.hasta).map((m) => m.alias);
  const vistos = [...maquinas.keys()].sort();
  const limiteAtraso = restarDias(dia, DIAS_ATRASO);
  // la esperada vieja cuenta como reportada si reportó su nueva —nunca «ausente»—, y la nueva no es
  // una máquina «sin declarar» más: es la misma, y la cobertura pide declararla en lugar de la vieja.
  const antesDe = new Map();   // alias nuevo → alias viejo, sólo si la nueva reportó
  for (const { vieja, nueva } of unidas) {
    const an = aliasDeNombre(nueva), av = aliasDeNombre(vieja);
    if (an && av && maquinas.has(an)) antesDe.set(an, av);
  }
  const cubiertas = new Set(antesDe.values());
  const aliasApartados = new Set(apartadas.map((x) => x.alias));
  // una carpeta apartada mandó sus registros: no está ausente, sólo no se cuenta aparte (y se dice por qué)
  const reporto = (a) => maquinas.has(a) || cubiertas.has(a) || aliasApartados.has(a);
  const cobertura = {
    esperadas: esperadas.length,
    reportaron: esperadas.filter(reporto).length,
    ausentes: esperadas.filter((a) => !reporto(a)).sort(),
    sin_declarar: vistos.filter((a) => !esperadas.includes(a) && !(antesDe.has(a) && esperadas.includes(antesDe.get(a)))),
    uniones: [...antesDe].sort().map(([alias, antes]) => ({ alias, antes, declarar: !esperadas.includes(alias) && esperadas.includes(antes) })),
    apartadas: apartadas.filter((x) => x.alias).sort((a, b) => a.alias.localeCompare(b.alias)),
    uniones_de_carpetas: uniones ? (uniones.estado === 'medidas' ? { estado: 'medidas' } : { estado: 'no_medidas', motivo: uniones.motivo }) : null,
    atrasadas: vistos.filter((a) => maquinas.get(a).fecha < limiteAtraso).map((a) => ({ alias: a, hasta: maquinas.get(a).fecha })),
    carpetas_ilegibles: carpetasIlegibles,
    no_leidos: noLeidos,
    lineas_ilegibles: lineasIlegibles,
  };
  // 4 · las vueltas atrás vigentes: qué máquina no se actualiza sola, desde cuándo y qué deshizo
  const retenciones = { vigentes: [], sin_retencion: 0, no_medidas: [] };
  for (const a of vistos) {
    const t = maquinas.get(a).retencion || { estado: 'no_medido' };
    if (t.estado === 'vigente') retenciones.vigentes.push({ alias: a, deshizo: t.deshizo, desde: t.desde });
    else if (t.estado === 'ninguna') retenciones.sin_retencion += 1;
    else retenciones.no_medidas.push(a);
  }
  return { estado: 'medido', ventana, piso: r.floor, cobertura, metricas, retenciones };
}

/** El texto de cobertura de máquinas para la página. Sólo alias y fechas validados. */
function textoCobertura(j) {
  if (!j || j.estado !== 'medido') return 'no se pudieron contar los registros de las máquinas';
  const c = j.cobertura;
  const partes = [`reportaron ${c.reportaron} de ${c.esperadas} máquina${c.esperadas === 1 ? '' : 's'} esperada${c.esperadas === 1 ? '' : 's'}`];
  if (c.ausentes.length) partes.push(`no reportó: ${c.ausentes.join(', ')}`);
  // dónde se declara una máquina: la lista existe para ver cuándo una deja de reportar, así que no se
  // arma sola — la declara una persona en la configuración de su organización
  if (c.sin_declarar.length) partes.push(`+${c.sin_declarar.length} sin declarar: ${c.sin_declarar.join(', ')} (una máquina se declara en reducer.expected_machines del sources.json de la organización)`);
  if (c.atrasadas.length) partes.push(`atrasada${c.atrasadas.length === 1 ? '' : 's'}: ${c.atrasadas.map((x) => `${x.alias} (hasta ${x.hasta})`).join(', ')}`);
  if (c.carpetas_ilegibles) partes.push(`${c.carpetas_ilegibles} carpeta${c.carpetas_ilegibles === 1 ? '' : 's'} de registros ilegible${c.carpetas_ilegibles === 1 ? '' : 's'}`);
  if (c.lineas_ilegibles) partes.push(`${c.lineas_ilegibles} línea${c.lineas_ilegibles === 1 ? '' : 's'} ilegible${c.lineas_ilegibles === 1 ? '' : 's'} en los registros`);
  // sólo alias (validados por su forma) y texto nuestro, nunca el nombre de una carpeta
  for (const u of c.uniones || []) partes.push(`${u.alias} (antes, ${u.antes})${u.declarar ? ': declararla en reducer.expected_machines en lugar de la vieja' : ''}`);
  for (const x of c.apartadas || []) partes.push(`${x.alias}: compartida por ${x.declarantes} máquinas, no se une ni se cuenta aparte`);
  if (c.uniones_de_carpetas && c.uniones_de_carpetas.estado === 'no_medidas') partes.push(`uniones de carpetas no medidas (${c.uniones_de_carpetas.motivo}): cada carpeta cuenta como una máquina`);
  for (const n of c.no_leidos || []) partes.push(n);
  return `${partes.join(' · ')} — ventana ${j.ventana.desde} → ${j.ventana.hasta}`;
}

module.exports = { juntar, textoCobertura, retencionValida, validarConfig, aliasDe, aliasDeNombre, leerUnionesDeCarpetas, duracionSuite, FUENTES, BALDES_GENERICOS, ESQUEMA };

if (require.main === module) {
  // El nombre viejo de --alias-of sigue andando hasta el retiro
  require('../../lib/legacy-names.js').aliasArgv('scripts/nightly/dashboard/reducer.js', { exitCode: 1 });
  const args = process.argv.slice(2);
  const i = args.indexOf('--alias-of');
  if (i >= 0) {
    const a = aliasDe(args[i + 1]);
    if (!a) { console.error('--alias-of necesita un nombre de máquina con forma de nombre'); process.exitCode = 1; }
    else console.log(a);
  } else if (args.includes('--alias')) {
    const a = aliasDeNombre(nombreDeMaquina());
    if (!a) { console.error('no se pudo saber el nombre de esta máquina'); process.exitCode = 1; }
    else console.log(a);
  } else {
    const json = args.includes('--json');
    const falla = (codigo, motivo) => { console.error(motivo); if (json) console.log(JSON.stringify({ estado: codigo === 2 ? 'se_nego' : 'no_pudo', motivo })); process.exitCode = codigo; };
    const SIN_LEER = Symbol('sin leer');
    let cfg = SIN_LEER;
    try { cfg = JSON.parse(fs.readFileSync(path.resolve(variable('TYCON_SOURCES_JSON') || path.join(__dirname, 'sources.json')), 'utf8')); }
    catch (e) { falla(1, e instanceof SyntaxError ? 'sources.json no es JSON válido' : `no se pudo leer sources.json (${e.code || 'error'})`); }
    // 🔴 Un JSON válido pero vacío de sentido (null, 0, false) no es «sin leer»: sigue y validarConfig lo rechaza.
    if (cfg !== SIN_LEER) {
      const v = validarConfig(cfg);
      const maquina = nombreDeMaquina();
      if (!v.reductor) falla(v.codigo, v.motivo);
      else if (!aliasDeNombre(maquina)) falla(1, 'no se pudo saber el nombre de esta máquina (vacío o sin forma de nombre)');
      else {
        const h = variable('TYCON_TODAY');
        const j = juntar({
          registros: path.resolve(variable('TYCON_LOGS_SOURCE') || casaPipeline()),
          buzon: path.resolve(variable('TYCON_MAILBOX_DIR') || path.join(casaPipeline(), 'corridas-buzon')),
          cfg, maquina, hoy: h && fechaValida(h) ? h : undefined,
        });
        if (json) console.log(JSON.stringify(j, null, 2));
        else {
          const m = j.metricas;
          console.log(`contado: ${textoCobertura(j)} · ${Object.entries(m).map(([k, x]) => `${k} ${x.num}${x.den === null ? '' : `/${x.den}`} (midieron ${x.midieron} de ${x.maquinas})`).join(' · ')}`);
        }
        process.exitCode = 0;
      }
    }
  }
}
