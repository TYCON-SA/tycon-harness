#!/usr/bin/env node
/**
 * suites-report.js — arma `ultimo-suites.json`, el reporte del nocturno de suites, con el MOTIVO de
 * cada suite roja y no sólo su nombre (2026-09-14, propuesta PIPE-DEBT-2.13-b). Tuvo nombre en castellano
 * hasta la story 8.9 (tanda C3), sin reemplazo: sólo lo llaman los pipelines del arnés.
 *
 * Caso: esa mañana el aviso de arranque decía «1 en rojo — pipeline-debt.test.js» y para saber por
 * qué hubo que volver a correr la suite a mano: era una deuda vencida por fecha, no un defecto. Con
 * sólo el nombre, tampoco se puede saber si la roja de hoy es la misma causa que la de ayer.
 *
 * El reporte viaja por git a todas las máquinas del equipo, así que el motivo se SANEA con el mismo
 * `sanear` de tokens-digest.js (importado, no copiado): ni rutas de la máquina ni credenciales. Y se
 * corta: tres líneas, las del fallo (❌ / not ok / AssertionError / Error / MAL / ✗), o las últimas si no hay.
 *
 * `failures` sigue siendo la lista de nombres de siempre (lo leen bench-notice y el tablero); los
 * motivos van en un campo aparte, `motivos`, que existe aunque esté vacío.
 *
 * 🔴 «No medida» no es «roja» (2026-10-04). Con las suites del nocturno en trabajos paralelos, las de un trabajo que
 * no terminó llegan en `--failures` con la marca «(no-medida)» (scripts/ci/suites-shard.js). Siguen en `failures`, con
 * su marca, y además van a `unmeasured`; `complete` es false si hay alguna. Los que leen el reporte (el aviso de
 * arranque, el tablero, pr-verdict.js) miran esos dos campos, no la marca. Tampoco se cuentan como desaparecidas.
 *
 * 🔴 Ninguna suite «desaparece» sin que se note (story 8.9, tanda C3, AC 38). Renombrar una prueba
 * cambia su nombre, que es la clave de la suite: sin unir las dos fotos por el mapa de renombres, la
 * suite vieja se leería como perdida y la nueva como recién llegada. Con `--ran` (la lista de suites
 * que corrieron) el reporte guarda la lista en `ran` y compara contra la foto anterior (`--previous`,
 * por defecto el propio `--rep` antes de pisarlo): las suites de antes —su `ran`, o sus `failures` si la
 * foto es de antes de este cambio—, pasadas por el mapa (scripts/lib/renames.json), que hoy no corrieron
 * van a `disappeared` y se avisan (en Azure, como warning de la corrida). Sin mapa —la copia pública—
 * se compara sin traducir. Sin `--ran` no hay lista que comparar y el reporte sale como antes.
 *
 * 🔴 «No corrió» tampoco es «roja», ni «verde», ni «desaparecida» (2026-10-04). La validación de cada pedido de merge
 * deja para el nocturno las suites que el cambio no toca (scripts/ci/suites-for-change.js; las dos más largas, por
 * scripts/ci/heavy-suites.json). Con `--not-run <archivo>` (una por línea: nombre<TAB>motivo) van a `notRun`
 * ({nombre: motivo}) y no se cuentan como desaparecidas. Sin la opción —el nocturno, que corre todas— no hay `notRun`.
 *
 * 🔴 «No viaja» (story 8.26, tanda C, AC 11). Con la validación sobre el repo público, la foto nocturna (la del repo de
 * mantenimiento) nombra suites que el árbol validado no trae: no son desaparecidas, y nombrarlas en el aviso escondía
 * entre ellas la que el cambio borró de verdad. Con `--registry <suites.json>` (repetible: el de la rama y el de main),
 * una suite de la foto que hoy no corrió y no está en ningún registro va a `notTravelling` (se cuenta, no se nombra en
 * el aviso); la que está en alguno sigue siendo desaparecida. Un registro que no se deja leer no esconde nada: sin él no
 * se sabe qué viaja, y ninguna se da por «no viaja».
 *
 * 🔴 `--public-notices` (story 8.26, tanda C, AC 45): el aviso de Azure lleva la cuenta y texto fijo; los nombres, en la
 * salida común (el control del pedido del repo público es público).
 *
 * Uso (desde pipelines/azure-pipelines-banco.yml y pipelines/azure-pipelines-pr.yml):
 *   node scripts/ci/suites-report.js --rep <ultimo-suites.json> --build <id> --runs <N>
 *     --failures "<nombres separados por espacio>" --detail <dir con <nombre>.txt de cada roja> [--retries <json>]
 *     [--ran <archivo con un nombre de suite por línea>] [--previous <foto anterior>] [--not-run <nombre<TAB>motivo por línea>]
 *     [--registry <suites.json>]… [--public-notices]
 *   (--runs, --failures, --detail y --retries tenían nombre en castellano hasta la story 8.9, tanda B3a; los
 *   viejos siguen andando hasta el retiro. Las claves del reporte —`corridas`, `failures`…— no cambian.)
 * Red: scripts/tests/suites-report.test.sh · scripts/tests/legacy-names-c3.test.js (T42)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { sanear } = require('../metrics/tokens-digest.js');
// El traductor de las opciones viejas vive al lado (story 8.9).
const { aliasLegacyOptions, LegacyOptionsError } = (() => {
  try { return require('./legacy-options.js'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') process.stderr.write(`⚠️  legacy-options.js no cargó (${e && e.message}): los nombres viejos de este guion no se traducen\n`); return { aliasLegacyOptions: (argv) => argv, LegacyOptionsError: Error }; }
})();
let ARGV = process.argv.slice(2);

// «MAL» (23 suites) y «✗» (5; no es el «✖» de node) son las marcas de falla de las suites bash y de
// algunos selftests: medido el 2026-09-17 sobre las 110 de suites.json. Sin ellas el motivo de
// publish-bump.test.sh mostró un caso verde y «FALLARON 1» sin decir cuál. Van anclados al principio
// (la línea ya viene sin sangría): en la prosa de un chequeo verde no son una falla.
const LINEA_DE_FALLO = /❌|\bnot ok\b|✖|AssertionError|\bError:|\bFAIL\b|^MAL\b|^✗/;

function arg(nombre) {
  const i = ARGV.indexOf(nombre);
  return i >= 0 ? ARGV[i + 1] : undefined;
}
/** Todos los valores de una opción repetible. */
function args(nombre) {
  return ARGV.flatMap((a, i) => (a === nombre && ARGV[i + 1] !== undefined ? [ARGV[i + 1]] : []));
}

/**
 * Los nombres de suite (el nombre del archivo) de los registros `suites.json` que se le pasan, o null si alguno no se deja
 * leer: sin un registro no se sabe qué viaja, y nada se da por «no viaja».
 */
function suitesDeLosRegistros(rutas) {
  const nombres = new Set();
  for (const ruta of rutas) {
    let d;
    try { d = JSON.parse(fs.readFileSync(ruta, 'utf8')); }
    catch (e) {
      console.error(`⚠️  suites-report: no pude leer el registro ${ruta} (${e.code === 'ENOENT' ? 'no está' : e.message}) — sin él no se sabe qué viaja: ninguna suite se da por «no viaja»`);
      return null;
    }
    for (const lista of Object.values(d || {})) {
      if (!Array.isArray(lista)) continue;
      for (const s of lista) if (s && typeof s.ruta === 'string') nombres.add(path.posix.basename(s.ruta));
    }
  }
  return nombres;
}

// La marca que scripts/ci/suites-shard.js le pega a una suite cuyo trabajo no terminó. No es una roja: no se midió.
const UNMEASURED = /\(no-medida\)$/;

function motivoDe(nombre, detalleDir) {
  if (/\(ausente\)$/.test(nombre)) return 'la suite no está en el clon: no se midió';
  let txt;
  try { txt = fs.readFileSync(path.join(detalleDir || '', `${nombre}.txt`), 'utf8'); }
  catch { return UNMEASURED.test(nombre) ? 'no medida: el trabajo que la corría no terminó' : 'sin salida guardada de esta corrida'; }
  const lineas = txt.split('\n').map((l) => l.trim()).filter(Boolean);
  const deFallo = lineas.filter((l) => LINEA_DE_FALLO.test(l));
  const elegidas = (deFallo.length ? deFallo : lineas.slice(-3)).slice(0, 3).map((l) => l.slice(0, 200));
  return sanear(elegidas.join(' · ')) || 'la suite salió con error y sin salida';
}

/**
 * Nombre viejo → nuevo de las suites renombradas, del mapa de renombres. Sin la biblioteca —el artefacto
 * `arnes-ci` es sólo `scripts/ci`— o sin el mapa —la copia pública—, no hay nada que unir.
 */
function cargarRenombres() {
  let ln;
  try { ln = require('../lib/legacy-names.js'); }
  catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return { renombres: new Map(), f: (k) => k };
    console.error(`⚠️  suites-report: no pude cargar legacy-names.js (${e && e.message}) — comparo con la foto anterior sin unir los renombres: una suite renombrada puede salir como desaparecida`);
    return { renombres: new Map(), f: (k) => k };
  }
  const mapa = ln.loadMap();
  const renombres = mapa ? ln.basenameRenames(mapa) : new Map();
  return { renombres, f: (k) => ln.renameKey(k, renombres) };
}

/** La foto anterior, o null si no hay (o no se deja leer: se dice). Se lee ANTES de pisar `--rep`. */
function fotoAnterior(ruta) {
  if (!ruta || !fs.existsSync(ruta)) return null;
  try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); }
  catch (e) { console.error(`⚠️  suites-report: la foto anterior (${ruta}) no se deja leer (${e.message}) — no comparo contra ella`); return null; }
}

/**
 * Las suites de la foto anterior que hoy no corrieron, con su nombre nuevo. De la foto, su lista (`ran`) o, si es de
 * antes de que el reporte la guardara, sus rojas (`failures`, sin la marca «(ausente)» que les pone el pipeline).
 */
function desaparecidas(anterior, ran, f, noMedidas = [], noCorrieron = []) {
  if (!anterior) return [];
  const antes = Array.isArray(anterior.ran) ? anterior.ran
    : (Array.isArray(anterior.failures) ? anterior.failures.map((x) => String(x).replace(/\s*\(ausente\)$/, '')) : []);
  // Las DOS fotos pasan por el mapa: una suite que suites.json todavía corre por su nombre viejo (su reemplazo) es la
  // misma que la renombrada, de una noche a la otra (pase adversarial de la C3; pr-verdict.js une igual las dos).
  // Una suite que hoy no se midió no «desapareció»: está en el reporte, nombrada como no medida.
  // Tampoco la que hoy no corrió porque el cambio no toca lo que mide: está nombrada en `notRun`.
  const hoy = new Set([...ran, ...noMedidas.map((n) => n.replace(UNMEASURED, '')), ...noCorrieron].map(f));
  return [...new Set(antes.map(f))].filter((s) => !hoy.has(s)).sort();
}

function main() {
  try { ARGV = aliasLegacyOptions(ARGV, 'corridas:runs detalle:detail fallas:failures reintentos:retries', 'scripts/ci/suites-report.js'); }
  catch (e) {
    if (!(e instanceof LegacyOptionsError)) throw e;
    console.error(`suites-report: ${e.message}`); process.exit(2);
  }
  const rep = arg('--rep');
  if (!rep) { console.error('uso: suites-report.js --rep <archivo> --build <id> --runs <N> --failures "<nombres>" --detail <dir> [--retries <json>] [--ran <archivo>] [--previous <foto>]'); process.exit(2); }
  // La lista de suites corridas y la foto anterior (AC 38): sin `--ran`, el reporte sale como antes.
  let ran = null;
  const rutaRan = arg('--ran');
  if (rutaRan) {
    try { ran = [...new Set(fs.readFileSync(rutaRan, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))].sort(); }
    catch (e) { console.error(`⚠️  suites-report: no pude leer la lista de suites corridas (${rutaRan}): ${e.message} — el reporte sale sin ella y sin comparar`); }
  }
  const anterior = ran ? fotoAnterior(arg('--previous') || rep) : null;
  const failures = String(arg('--failures') || '').trim().split(/\s+/).filter(Boolean);
  const motivos = {};
  for (const f of failures) motivos[f] = motivoDe(f, arg('--detail'));
  // 🔴 «No medida» no es «roja» (revisión del 2026-10-04). Las dos viajan en `failures` —el control de cada cambio
  // compara por ese nombre, y una suite que anoche no se midió no puede excusar un rojo de verdad—, pero el reporte las
  // separa para quien lo lee: `unmeasured` son las mismas entradas de `failures` que no se midieron, y `complete` dice
  // si la noche midió todo. Existen siempre, también vacío y true: «no hubo» y «este reporte no lo anota» no se leen igual.
  const unmeasured = failures.filter((f) => UNMEASURED.test(f));
  // 🔴 Las DOS corridas de cada suite que salió roja alguna vez (decisión del dev, 2026-09-17).
  // Es el dato que la Etapa 3 necesita para decidir si las suites vuelven a frenar: `rojo→rojo` es
  // una suite firme y `rojo→verde` una intermitente, y hoy no hay forma de distinguirlas. Existe
  // aunque esté vacío —como `motivos`— para que «no hubo reintentos» y «este reporte no los anota»
  // no se lean igual. El nocturno no reintenta y lo deja en {}.
  let reintentos = {};
  const rutaRe = arg('--retries');
  if (rutaRe) {
    try { reintentos = JSON.parse(fs.readFileSync(rutaRe, 'utf8')); }
    catch (e) { console.error(`⚠️  suites-report: no pude leer los reintentos (${rutaRe}): ${e.message} — el reporte sale sin ellos`); }
  }
  // Las que no corrieron porque el cambio no toca lo que miden (sólo la validación de cada pedido de merge).
  let notRun = null;
  const rutaNotRun = arg('--not-run');
  if (rutaNotRun) {
    try {
      notRun = {};
      for (const line of fs.readFileSync(rutaNotRun, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)) {
        const [name, ...why] = line.split('\t');
        notRun[name] = why.join(' ').trim() || 'el cambio no toca lo que mide';
      }
    } catch (e) { console.error(`⚠️  suites-report: no pude leer las suites que no corrieron (${rutaNotRun}): ${e.message} — el reporte sale sin ellas`); notRun = null; }
  }
  const reporte = {
    kind: 'bash-tests',
    ts: new Date().toISOString(),
    origen: 'azure-pipelines',
    build: arg('--build') || null,
    corridas: Number(arg('--runs') || 0),
    failures,
    motivos,
    reintentos,
    unmeasured,
    complete: unmeasured.length === 0,
  };
  if (notRun) reporte.notRun = notRun;
  if (ran) {
    reporte.ran = ran;
    const { f } = cargarRenombres();
    let perdidas = desaparecidas(anterior, ran, f, unmeasured, Object.keys(notRun || {}));
    const rutasRegistro = args('--registry');
    const registro = rutasRegistro.length ? suitesDeLosRegistros(rutasRegistro) : null;
    if (registro) {
      const viajan = new Set([...registro].map(f));
      reporte.notTravelling = perdidas.filter((s) => !viajan.has(s));
      perdidas = perdidas.filter((s) => viajan.has(s));
      if (reporte.notTravelling.length) console.error(`suites-report: ${reporte.notTravelling.length} suite(s) de la foto no viajan en este árbol (no están en ningún registro): corren en el nocturno`);
    }
    reporte.disappeared = perdidas;
    if (reporte.disappeared.length) {
      const cuantas = `${reporte.disappeared.length} suite(s) de la foto anterior${anterior && anterior.build ? ` (build ${anterior.build})` : ''} no corrieron hoy`;
      const txt = `${cuantas}: ${reporte.disappeared.join(' ')}`;
      console.error(`⚠️  suites-report: ${txt}`);
      if (process.env.TF_BUILD) console.log(`##vso[task.logissue type=warning]${ARGV.includes('--public-notices') ? `${reporte.disappeared.length} suite(s) de la foto anterior no corrieron hoy: los nombres, en el registro` : txt}`);
    }
  }
  fs.writeFileSync(rep, JSON.stringify(reporte, null, 2) + '\n');
}

main();
