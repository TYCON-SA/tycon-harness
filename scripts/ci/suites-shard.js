#!/usr/bin/env node
'use strict';

/**
 * suites-shard.js — reparte las suites de `scripts/tests/suites.json` en trabajos que corren a la vez, y después junta
 * lo que midió cada uno.
 *
 * POR QUÉ (2026-10-04): el job de suites del nocturno (pipelines/azure-pipelines-banco.yml) corría las 213 suites una
 * detrás de otra en un solo trabajo: 62 minutos en `main` (corrida 11738), con un tope de 75. Ocupaba un carril de
 * Azure más de una hora y, si pasaba el tope, se cortaba sin escribir el reporte: la noche quedaba sin medición (ya
 * pasó con el tope en 45, corrida 11616). Una sola suite, la copia pública de verdad, se lleva 24 de esos minutos.
 *
 * EL REPARTO es por PESO y siempre da lo mismo con la misma entrada: los segundos medidos de cada suite larga están en
 * `scripts/ci/suites-weights.json`, y las demás (también una suite nueva, que nadie midió todavía) llevan el peso por
 * defecto. Se ordenan de la más pesada a la más liviana (a igual peso, por nombre) y cada una va al trabajo que hasta
 * ahí lleva menos. Dentro de cada trabajo las suites corren en el orden de suites.json, como antes.
 *
 * LO QUE GARANTIZA: la unión de los trabajos es exactamente la lista entera y ninguna suite queda en dos. Y al juntar,
 * cada suite de la lista termina nombrada: corrió, no estaba en el clon («(ausente)») o no se midió («(no-medida)»).
 * Las suites de un trabajo que no terminó (se cortó por tiempo, no publicó nada, publicó sin la marca de terminado o
 * no pasó por toda su lista) NO se dan por verdes ni desaparecen: van a la lista de fallas con el motivo «no medida:
 * el trabajo <i> no terminó», y cada trabajo sin terminar se denuncia como error de la corrida. De un trabajo cortado
 * a mitad de camino se conserva lo que sí midió; la suite que estaba corriendo cuando lo cortaron cuenta como no medida.
 * La marca «(no-medida)» va pegada al nombre, igual que «(ausente)», a propósito: el control de cada cambio
 * (pr-verdict.js) perdona un rojo que ya estaba rojo en la foto nocturna, y una suite que anoche no se midió no puede
 * servirle de excusa a un rojo de verdad. Quien lee el reporte no mira la marca: suites-report.js separa esas entradas
 * en `unmeasured` y pone `complete` en false.
 *
 * SÓLO LAS QUE CORREN (`--only`, 2026-10-04): la validación de los pedidos de merge (pipelines/azure-pipelines-pr.yml)
 * no corre todas las suites —scripts/ci/suites-for-change.js deja para el nocturno las que el cambio no toca—, y el
 * reparto se hace sobre las que de verdad corren: sobre la lista entera, la copia pública (la más pesada, casi siempre
 * salteada) se quedaba un trabajo para ella sola y el otro cargaba con todo lo demás. `--only` es un archivo con una
 * suite por línea (su ruta o su nombre); `list`, `plan` y `merge` tienen que recibir el MISMO, o `merge` esperaría
 * otro reparto. Las que no están en ese archivo no son fallas ni no medidas: no le tocaban a ningún trabajo.
 *
 * CÓMO FALLA: sale 2, dice por qué y NO imprime ninguna lista cuando el pedido no se puede cumplir: `--shard` fuera
 * de rango, `--of` que no es un entero mayor que 0 o que pasa la cantidad de suites, suites.json o el archivo de pesos
 * ilegibles, una entrada sin ruta, dos suites con el mismo nombre, un `--only` vacío, ilegible o que nombra una suite
 * que no está en suites.json. Lo mismo `jobs` con un `--max` o un `--budget` que no son números, o sin presupuesto, y
 * `of` con una matriz que no es la que arma `matrix`. Una lista vacía nunca puede leerse como «no hay suites». `merge` sale 0 cuando juntó,
 * aunque haya trabajos sin terminar: eso lo dice el reporte y el error de la corrida.
 *
 * Uso:
 *   node scripts/ci/suites-shard.js list  --shard <i> --of <n> --skills <carpeta de skills> --scripts <raíz scripts del arnés>
 *        imprime, una por línea, las rutas de las suites del trabajo <i> de <n>
 *        (raíz «agent-skills» → <skills>/<ruta>; las demás → <scripts>/<ruta>)
 *   node scripts/ci/suites-shard.js plan  --of <n>
 *        cuántas suites y cuántos segundos estimados lleva cada trabajo (para leer a mano)
 *   node scripts/ci/suites-shard.js merge --of <n> --artifacts <carpeta con suites-shard-<i>-a<intento>/> --out <carpeta>
 *        deja en <out> ran.txt, failures.txt y red-output/ con lo de todos los trabajos, listo para suites-report.js
 *        y, si algún trabajo publicó las dos pasadas de sus rojas, retries.json con las de todos ({} si ninguno)
 *   node scripts/ci/suites-shard.js jobs  --max <n> --weight-set pr [--budget <s>]
 *        cuántos trabajos hacen falta para las suites del plan (un número, entre 1 y <n>); el porqué, por stderr
 *   node scripts/ci/suites-shard.js caps  [--weight-set pr] [--only <archivo>]
 *        el tope de cada suite, una por línea: «<suite>\t<segundos>» (ver «EL TOPE DE CADA SUITE», abajo); sin juego,
 *        el del nocturno
 *   node scripts/ci/suites-shard.js matrix --of <n>
 *        la matriz del job de suites para Azure, en una línea: {"shard_1":{"SUITES_SHARD":"1","SUITES_OF":"<n>"},…}
 *   node scripts/ci/suites-shard.js of --matrix '<la matriz>'
 *        cuántos trabajos tiene esa matriz (revisa su forma: shard_1…shard_n, cada uno con su número y la misma cuenta)
 *   opciones de list, plan, merge y jobs: --suites <suites.json> (por defecto <scripts>/tests/suites.json) · --weights <pesos.json>
 *   (por defecto el de al lado de este guion) · --scripts <raíz> (por defecto la de este guion) · --only <archivo>
 *   (sólo las suites que nombra, una por línea) · --weight-set <nombre> (un juego de pesos de adentro del archivo;
 *   la validación de cada rama pide `pr`, ver abajo)
 *
 * LOS PESOS DE LA VALIDACIÓN (`--weight-set pr`, story 8.22): una suite no tarda lo mismo en el nocturno que en la
 * validación de cada rama. clean-machine son minutos en el nocturno y ~3 s en la validación; export-real, ~391 s en la
 * validación contra los 1439 anotados para el nocturno. La validación pide su juego, `pr`, medido en sus propias
 * corridas; el nocturno sigue con el de arriba. Lo mismo que con `--only`: `list`, `plan` y `merge` tienen que pedir el
 * MISMO juego, o `merge` esperaría otro reparto.
 *
 * CUÁNTOS TRABAJOS (`jobs`, story 8.22 tramo C): la validación de cada rama ya no pide siempre el máximo. Un trabajo
 * de suites cuesta un carril de Azure, y a una corrida le tocan dos en la práctica: un plan chico en dos trabajos más el
 * banco eran tres pedidos, y el tercero esperaba ~5 min. La cuenta es el peso total del plan dividido por lo que entra
 * en un trabajo (`job_budget` del juego pedido, o `--budget`), redondeada para arriba, entre 1 y el máximo (y nunca más
 * trabajos que suites). Un juego sin `job_budget` es un pedido negado: el número no se adivina. Quien la usa (el YAML)
 * cae al máximo si esto sale 2: nunca menos trabajos por no saber. El número viaja como la matriz misma (`matrix`) y
 * cada paso que necesita la cuenta la saca de ella (`of`): así la matriz y los `--of` no pueden quedar distintos.
 *
 * EL TOPE DE CADA SUITE (`caps`, story 8.22 tramo D): en la validación de cada rama una suite colgada se comía el
 * trabajo entero (harness-update: 1185 y 1373 s contra ~161). Cada trabajo pide los topes de su lista una vez y corre
 * cada suite con `scripts/ci/run-capped.js`. El tope es el peso de la suite en el juego pedido por `suite_cap.factor`,
 * nunca menos que `suite_cap.floor` (regla del dueño, 2026-10-06: el doble, con piso de 180 s; en las corridas medidas
 * ninguna suite sana pasó de 1,3 veces su peso). Un juego sin `suite_cap` es un pedido negado: el tope no se adivina.
 * Una suite cortada la anota su trabajo como «(no-medida)», con el motivo en `red-output/<suite>(no-medida).txt`, y
 * `merge` la deja así, con ese motivo: ni verde ni roja. Desde el AC 32 (2026-10-07) también el banco nocturno: su
 * regla es el `suite_cap` de arriba del archivo de pesos, con `per_suite` para la suite cuyo tiempo depende de su
 * resultado (export-real: ~405 s con la copia verde, ~17 min más con la roja).
 *
 * Lo que cada trabajo deja en su carpeta `suites-shard-<i>-a<intento>/`: `ran.txt` (las que corrió, una por línea),
 * `failures.txt` (las rojas, las «(ausente)» y las «(no-medida)» que cortó su tope), `red-output/<suite>.txt` (la salida
 * de cada roja, o el motivo de cada no medida), `done.txt` (sólo la validación: cada suite que terminó, de cualquier
 * forma; en un trabajo cortado separa las que quedaron a medio correr) y `finished` (la
 * marca de que pasó por toda su lista, con su cuenta: «<corridas> <fallas>») y, sólo en la validación de los pedidos de
 * merge —que reintenta una vez cada roja—, `retries.json`: por suite roja en la 1ª pasada, `{ primera: "rojo",
 * segunda: "rojo" | "verde" }`. Una «rojo» en la 2ª es firme y está entre las fallas; una «verde» pasó al reintento y no
 * lo está. Un trabajo reintentado desde Azure
 * publica otra carpeta, con el intento siguiente: `merge` lee la del intento más alto.
 *
 * 🔴 A lo publicado no se le cree sin mirar: a una carpeta a la que le falta un archivo, que nombra suites ajenas o
 * cuya marca no coincide con lo que trae, no se le toma nada, y todas las suites de ese trabajo quedan no medidas, con
 * el motivo «no medida: lo que publicó el trabajo <i> está incompleto».
 *
 * LAS QUE CORREN SOLAS, AL TRABAJO DEL BANCO (`--exclusive-apart`, story 8.22 tramo I): en la validación de cada rama las
 * suites `exclusive: true` de suites.json corrían solas al final de un trabajo de suites. Medido el 2026-10-08: la copia
 * pública de verdad tardaba 370 a 383 s ahí, mientras el trabajo del banco terminaba a los ~5 min y dejaba su carril
 * ocioso. Con la opción, las exclusivas salen del reparto: `list --shard bench` da su lista (en el orden de
 * suites.json), `jobs` y `plan` cuentan el peso de las que quedan, y `merge` junta también lo que publicó el trabajo
 * del banco (`suites-shard-bench-a<intento>`), con las mismas exigencias que a cualquier trabajo: lo que no publique
 * queda no medido. Sin exclusivas en el plan no cambia nada, y `merge` no espera nada del banco. Si TODAS las del plan
 * son exclusivas se pide igual un trabajo de suites, que no tiene ninguna. `list` sale 3, sin lista y diciendo por qué,
 * cuando al trabajo pedido no le toca ninguna suite: no es un pedido negado (2) ni una lista vacía. `list`, `plan`,
 * `jobs` y `merge` tienen que recibir la opción los cuatro, o `merge` esperaría otro reparto. El nocturno no la pasa.
 *
 * Red: scripts/tests/suites-shard.test.js · scripts/tests/nightly-suites-shards.test.js (los pasos del YAML)
 */

const fs = require('fs');
const path = require('path');

const RAN_FILE = 'ran.txt';
const FAILURES_FILE = 'failures.txt';
const RED_OUTPUT_DIR = 'red-output';
const FINISHED_FILE = 'finished';
const RETRIES_FILE = 'retries.json';
const DONE_FILE = 'done.txt';
const ABSENT_MARK = '(ausente)';
const UNMEASURED_MARK = '(no-medida)';
const USAGE = 'uso: suites-shard.js list --shard <i> --of <n> --skills <dir> --scripts <dir>\n'
  + '     suites-shard.js plan --of <n>\n'
  + '     suites-shard.js merge --of <n> --artifacts <dir> --out <dir>\n'
  + '     suites-shard.js jobs --max <n> [--budget <segundos>]\n'
  + '     suites-shard.js caps [--weight-set <nombre>]\n'
  + '     suites-shard.js matrix --of <n>\n'
  + '     suites-shard.js of --matrix <la matriz>\n'
  + '     opciones: --suites <suites.json> · --weights <pesos.json> · --scripts <raíz scripts del arnés> · --only <archivo>\n'
  + '               --weight-set <nombre> (un juego de pesos del archivo; la validación de cada rama pide «pr»)\n'
  + '               --exclusive-apart (las exclusive de suites.json van al trabajo del banco: list --shard bench)\n';
/** El trabajo del banco, como trabajo de suites: su nombre en `--shard` y en la carpeta que publica. */
const BENCH_SHARD = 'bench';

/** Un pedido que no se puede cumplir: sale 2 con el motivo y sin lista. */
class Refused extends Error {}
/** Un pedido bien hecho al que no le toca ninguna suite (sólo con --exclusive-apart): sale 3 con el motivo y sin lista. */
class Nothing extends Error {}

function option(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** Un entero mayor que 0 escrito sólo con dígitos: «3», nunca «3x», «1.5» ni «-1». */
function positiveInteger(text) {
  return typeof text === 'string' && /^[1-9]\d*$/.test(text) ? Number(text) : null;
}

/** La lista entera, en el orden de suites.json (diarias y semanales). Cualquier duda es un pedido negado. */
function readSuites(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Refused(`la lista de suites (suites.json: ${file}) no se deja leer (${e.message})`);
  }
  if (!data || !Array.isArray(data.diarias)) throw new Refused(`la lista de suites (${file}) no trae «diarias»: no sé qué repartir`);
  if (data.semanales !== undefined && !Array.isArray(data.semanales)) throw new Refused(`la lista de suites (${file}) trae «semanales» y no es una lista`);
  const suites = [];
  const seen = new Map();
  for (const entry of [...data.diarias, ...(data.semanales || [])]) {
    if (!entry || typeof entry.ruta !== 'string' || !entry.ruta) {
      throw new Refused(`una entrada de la lista de suites (${file}) no trae «ruta»: ${JSON.stringify(entry)} — repartir sin ella sería dejarla sin correr`);
    }
    const name = path.posix.basename(entry.ruta);
    if (seen.has(name)) {
      throw new Refused(`dos suites se llaman ${name} (${seen.get(name)} y ${entry.ruta}): el reporte las nombra por ese nombre y las confundiría`);
    }
    seen.set(name, entry.ruta);
    suites.push({ root: entry.raiz, rel: entry.ruta, name, exclusive: entry.exclusive === true });
  }
  if (!suites.length) throw new Refused(`la lista de suites (${file}) no trae ninguna suite`);
  return suites;
}

/** El `default` y los `weights` de un juego de pesos, revisados: cualquier duda es un pedido negado. */
function checkWeights(data, where) {
  const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (!data || !valid(data.default)) throw new Refused(`${where} no trae «default» como un número mayor que 0`);
  const weights = data.weights === undefined ? {} : data.weights;
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) throw new Refused(`${where} trae «weights» y no es un objeto`);
  for (const [name, seconds] of Object.entries(weights)) {
    if (!valid(seconds)) throw new Refused(`${where} trae un peso que no es un número mayor que 0: ${name} = ${JSON.stringify(seconds)}`);
  }
  return { fallback: data.default, weights };
}

/**
 * Los segundos medidos de las suites largas y el peso por defecto de las demás. Con `set` (story 8.22), el juego de
 * pesos con ese nombre: el peso de una suite sale de ese juego, si no está ahí del juego de arriba (el del nocturno: algo
 * medido es mejor que el por defecto) y si tampoco, del `default` del juego pedido. Un juego que no existe o está roto
 * es un pedido negado: seguir con el de siempre repartiría con pesos que quien lo pidió no quería.
 */
function readWeights(file, set = null) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Refused(`el archivo de pesos (${file}) no se deja leer (${e.message})`);
  }
  const base = checkWeights(data, `el archivo de pesos (${file})`);
  // El juego del nocturno no trae `job_budget`: el nocturno corre siempre todos sus trabajos. Su `suite_cap` (el de
  // arriba) es el tope de cada suite del banco nocturno (story 8.22, AC 32).
  if (set === null) return { ...base, budget: null, cap: readCapRule(data.suite_cap, `el archivo de pesos (${file})`) };
  const chosen = data[set];
  if (!chosen || typeof chosen !== 'object' || Array.isArray(chosen)) throw new Refused(`el archivo de pesos (${file}) no trae el juego «${set}» que pide --weight-set`);
  const own = checkWeights(chosen, `el juego de pesos «${set}» (${file})`);
  if (chosen.job_budget !== undefined && !(typeof chosen.job_budget === 'number' && Number.isFinite(chosen.job_budget) && chosen.job_budget > 0)) {
    throw new Refused(`el juego de pesos «${set}» (${file}) trae «job_budget» y no es un número mayor que 0: ${JSON.stringify(chosen.job_budget)}`);
  }
  return {
    fallback: own.fallback,
    weights: { ...base.weights, ...own.weights },
    budget: chosen.job_budget === undefined ? null : chosen.job_budget,
    cap: readCapRule(chosen.suite_cap, `el juego de pesos «${set}» (${file})`),
  };
}

/**
 * La regla del tope de cada suite (`suite_cap`, story 8.22 tramo D): `{ factor, floor }`, los dos números mayores que 0,
 * y opcional `per_suite` (AC 32): un tope propio en segundos, por nombre, para la suite cuyo tiempo depende de su
 * resultado (export-real en el nocturno). No está: null. Está y no cumple: pedido negado, igual que un peso roto.
 */
function readCapRule(rule, label) {
  if (rule === undefined) return null;
  const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule) || !positive(rule.factor) || !positive(rule.floor)) {
    throw new Refused(`${label} trae «suite_cap» y no es { factor, floor } con dos números mayores que 0: ${JSON.stringify(rule)}`);
  }
  const perSuite = rule.per_suite === undefined ? {} : rule.per_suite;
  if (!perSuite || typeof perSuite !== 'object' || Array.isArray(perSuite) || !Object.values(perSuite).every(positive)) {
    throw new Refused(`${label} trae «suite_cap.per_suite» y no es { suite: segundos } con números mayores que 0: ${JSON.stringify(rule.per_suite)}`);
  }
  return { factor: rule.factor, floor: rule.floor, perSuite };
}

/**
 * El tope de una suite: el propio si lo tiene; si no, su peso por el factor, nunca menos que el piso. En segundos
 * enteros, redondeado para arriba.
 */
function capOf(suite, weights) {
  if (Object.prototype.hasOwnProperty.call(weights.cap.perSuite, suite.name)) return Math.ceil(weights.cap.perSuite[suite.name]);
  return Math.ceil(Math.max(weights.cap.floor, weightOf(suite, weights) * weights.cap.factor));
}

function weightOf(suite, weights) {
  return Object.prototype.hasOwnProperty.call(weights.weights, suite.name) ? weights.weights[suite.name] : weights.fallback;
}

/**
 * El reparto: de la más pesada a la más liviana (a igual peso, por nombre), cada suite al trabajo que hasta ahí lleva
 * menos (a igual carga, el de número más bajo). Devuelve, por trabajo, sus suites en el orden de suites.json y su carga.
 */
function assign(suites, weights, count) {
  const shards = Array.from({ length: count }, () => ({ load: 0, picked: [] }));
  const order = suites
    .map((suite, position) => ({ suite, position, weight: weightOf(suite, weights) }))
    .sort((a, b) => (b.weight - a.weight) || (a.suite.name < b.suite.name ? -1 : a.suite.name > b.suite.name ? 1 : 0));
  for (const item of order) {
    let lightest = shards[0];
    for (const shard of shards) if (shard.load < lightest.load) lightest = shard;
    lightest.load += item.weight;
    lightest.picked.push(item);
  }
  return shards.map((shard) => ({
    load: shard.load,
    suites: shard.picked.sort((a, b) => a.position - b.position).map((item) => item.suite),
  }));
}

/**
 * Las suites de la lista que nombra el archivo de `--only` (su ruta o su nombre, una por línea), en el orden de
 * suites.json. Un archivo vacío, ilegible o que nombra una suite que no está en la lista es un pedido negado: repartir
 * sin ella sería dejarla sin correr, y repartir «nada» se leería como «no hay suites».
 */
function restrictTo(suites, file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Refused(`--only: la lista de las suites que corren (${file}) no se deja leer (${e.code || e.message})`);
  }
  const wanted = new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => path.posix.basename(l.replace(/\\/g, '/'))));
  if (!wanted.size) throw new Refused(`--only: la lista de las suites que corren (${file}) está vacía — «ninguna» no es «no hay suites»`);
  const known = new Set(suites.map((s) => s.name));
  const unknown = [...wanted].filter((name) => !known.has(name));
  if (unknown.length) throw new Refused(`--only nombra suites que no están en suites.json: ${unknown.slice(0, 5).join(' ')}`);
  return suites.filter((s) => wanted.has(s.name));
}

/** La lista (con `--only`, sólo las que corren) y los pesos del juego pedido. */
function load(argv) {
  const scriptsRoot = option(argv, '--scripts') || path.resolve(__dirname, '..');
  let suites = readSuites(option(argv, '--suites') || path.join(scriptsRoot, 'tests', 'suites.json'));
  if (argv.includes('--only')) {
    const only = option(argv, '--only');
    if (!only) throw new Refused('--only viene sin archivo: sin él no sé cuáles corren');
    suites = restrictTo(suites, only);
  }
  let set = null;
  if (argv.includes('--weight-set')) {
    set = option(argv, '--weight-set');
    if (!set) throw new Refused('--weight-set viene sin nombre: sin él no sé con qué pesos repartir');
  }
  const weights = readWeights(option(argv, '--weights') || path.join(__dirname, 'suites-weights.json'), set);
  // --exclusive-apart (tramo I): las que corren solas no entran al reparto; son la lista del trabajo del banco
  const apart = argv.includes('--exclusive-apart');
  return { suites, weights, apart, regular: apart ? suites.filter((s) => !s.exclusive) : suites, bench: apart ? suites.filter((s) => s.exclusive) : [] };
}

/** Lo que piden list, plan y merge: cuántos trabajos, la lista y el reparto. */
function prepare(argv) {
  const count = positiveInteger(option(argv, '--of'));
  if (count === null) throw new Refused(`--of tiene que ser un entero mayor que 0 (vino ${JSON.stringify(option(argv, '--of'))})`);
  const { suites, weights, apart, regular, bench } = load(argv);
  // Con todo el plan en el trabajo del banco se pide igual UN trabajo de suites (la matriz no puede quedar sin patas).
  if (count > Math.max(regular.length, bench.length ? 1 : 0)) throw new Refused(`--of ${count} pasa la cantidad de suites (${regular.length}): algún trabajo quedaría vacío`);
  return { count, suites, weights, apart, bench, shards: assign(regular, weights, count) };
}

function commandList(argv, write) {
  const skillsRoot = option(argv, '--skills');
  const scriptsRoot = option(argv, '--scripts');
  if (!skillsRoot) throw new Refused('falta --skills <carpeta de skills>: sin ella no sé dónde viven las suites de agent-skills');
  if (!scriptsRoot) throw new Refused('falta --scripts <raíz scripts del arnés>: sin ella no sé dónde viven las suites del arnés');
  const { count, shards, apart, bench } = prepare(argv);
  const asked = option(argv, '--shard');
  let picked;
  if (apart && asked === BENCH_SHARD) {
    if (!bench.length) throw new Nothing('ninguna suite corre sola en este plan: el trabajo del banco no tiene suites que correr');
    picked = bench;
  } else {
    const index = positiveInteger(asked);
    if (index === null || index > count) throw new Refused(`--shard tiene que ser un entero entre 1 y ${count}${apart ? ` o «${BENCH_SHARD}»` : ''} (vino ${JSON.stringify(asked)})`);
    picked = shards[index - 1].suites;
    if (!picked.length) throw new Nothing('todas las suites de este plan corren solas: este trabajo de suites no tiene ninguna que correr (van al trabajo del banco)');
  }
  // La misma cuenta que hacía el YAML: la raíz y la ruta pegadas con «/», sin normalizar.
  const lines = picked.map((s) => `${s.root === 'agent-skills' ? skillsRoot : scriptsRoot}/${s.rel}`);
  write(`${lines.join('\n')}\n`);
}

function commandPlan(argv, write) {
  const { count, suites, weights, shards, bench } = prepare(argv);
  const width = String(suites.length).length;
  const lines = shards.map((shard, i) => `trabajo ${i + 1} de ${count}: ${String(shard.suites.length).padStart(width)} suite(s) · ~${Math.round(shard.load)} s (${Math.round(shard.load / 60)} min)`);
  const benchLoad = bench.reduce((sum, suite) => sum + weightOf(suite, weights), 0);
  if (bench.length) lines.push(`trabajo del banco: ${bench.length} suite(s) que corren solas · ~${Math.round(benchLoad)} s (${Math.round(benchLoad / 60)} min), de a una, después del banco`);
  const total = shards.reduce((sum, shard) => sum + shard.load, 0) + benchLoad;
  const unweighted = suites.filter((s) => !Object.prototype.hasOwnProperty.call(weights.weights, s.name)).length;
  lines.push(`total: ${suites.length} suite(s) · ~${Math.round(total)} s (${Math.round(total / 60)} min) · ${unweighted} sin peso medido (${weights.fallback} s cada una por defecto)`);
  write(`${lines.join('\n')}\n`);
}

/**
 * Cuántos trabajos hacen falta: el peso total sobre lo que entra en uno, para arriba, entre 1 y el máximo (y no más que
 * las suites). Imprime el número solo; el porqué va por `complain`, para el registro.
 */
function commandJobs(argv, write, complain) {
  const max = positiveInteger(option(argv, '--max'));
  if (max === null) throw new Refused(`--max tiene que ser un entero mayor que 0 (vino ${JSON.stringify(option(argv, '--max'))})`);
  let budget = null;
  if (argv.includes('--budget')) {
    const text = option(argv, '--budget');
    budget = typeof text === 'string' && /^\d+(\.\d+)?$/.test(text) && Number(text) > 0 ? Number(text) : null;
    if (budget === null) throw new Refused(`--budget tiene que ser un número de segundos mayor que 0 (vino ${JSON.stringify(text)})`);
  }
  const { weights, regular, bench } = load(argv);
  if (budget === null) budget = weights.budget;
  if (budget === null) throw new Refused('el juego de pesos no trae «job_budget» (lo que entra en un trabajo) y no vino --budget: el número de trabajos no se adivina');
  // El peso que cuenta es el de las que corren en los trabajos de suites: las que corren solas van al del banco.
  const total = regular.reduce((sum, suite) => sum + weightOf(suite, weights), 0);
  const count = Math.max(1, Math.min(max, regular.length || 1, Math.ceil(total / budget)));
  const benchLoad = bench.reduce((sum, suite) => sum + weightOf(suite, weights), 0);
  const aside = bench.length ? ` · ${bench.length} suite(s) que corren solas van al trabajo del banco (~${Math.round(benchLoad)} s)` : '';
  complain(`suites: ${count} trabajo(s) de un máximo de ${max} · ~${Math.round(total)} s de peso · ${budget} s por trabajo${aside}\n`);
  write(`${count}\n`);
}

/**
 * El tope de cada suite (story 8.22, tramo D): una línea `<suite>\t<segundos>` por suite de la lista, en el orden de
 * suites.json. Sin `suite_cap` en el juego pedido no hay tope que adivinar: pedido negado (quien llama corre sin tope y
 * lo dice).
 */
function commandCaps(argv, write) {
  const { suites, weights } = load(argv);
  if (weights.cap === null) throw new Refused('el juego de pesos no trae «suite_cap» (la regla del tope de cada suite): el tope no se adivina');
  // Un tope propio para una suite que no está en suites.json (un renombre, un error de tipeo) frena: si no, la suite de
  // verdad volvía en silencio al doble de su peso (pase adversarial del AC 32). Se mira la lista entera, no sólo --only.
  const scriptsRoot = option(argv, '--scripts') || path.resolve(__dirname, '..');
  const known = new Set(readSuites(option(argv, '--suites') || path.join(scriptsRoot, 'tests', 'suites.json')).map((s) => s.name));
  const stale = Object.keys(weights.cap.perSuite).filter((name) => !known.has(name));
  if (stale.length) throw new Refused(`«suite_cap.per_suite» le da tope propio a suites que no están en suites.json: ${stale.join(' ')} — renombrá o borrá su entrada en el archivo de pesos`);
  write(`${suites.map((suite) => `${suite.name}\t${capOf(suite, weights)}`).join('\n')}\n`);
}

const MATRIX_KEY = (i) => `shard_${i}`;

/** La matriz del job de suites, en una línea: una pata por trabajo, cada una con su número y la cuenta. */
function commandMatrix(argv, write) {
  const count = positiveInteger(option(argv, '--of'));
  if (count === null) throw new Refused(`--of tiene que ser un entero mayor que 0 (vino ${JSON.stringify(option(argv, '--of'))})`);
  const matrix = {};
  for (let i = 1; i <= count; i += 1) matrix[MATRIX_KEY(i)] = { SUITES_SHARD: String(i), SUITES_OF: String(count) };
  write(`${JSON.stringify(matrix)}\n`);
}

/**
 * Cuántos trabajos tiene una matriz. Sólo la de `matrix`: shard_1…shard_n, en ese orden, cada una con su número y la misma
 * cuenta n. Cualquier otra cosa es un pedido negado: quien la lee no sabría qué reparto esperar.
 */
function commandOf(argv, write) {
  const text = option(argv, '--matrix');
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Refused(`--matrix no se deja leer como JSON (vino ${JSON.stringify(String(text).slice(0, 80))})`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Refused('--matrix no es un objeto');
  const keys = Object.keys(data);
  const count = keys.length;
  if (!count) throw new Refused('--matrix no trae ningún trabajo');
  keys.forEach((key, at) => {
    const leg = data[key];
    const i = at + 1;
    if (key !== MATRIX_KEY(i) || !leg || leg.SUITES_SHARD !== String(i) || leg.SUITES_OF !== String(count)) {
      throw new Refused(`--matrix no es la de «matrix --of ${count}»: ${key} = ${JSON.stringify(leg)}`);
    }
  });
  write(`${count}\n`);
}

/** Las líneas no vacías de un archivo, o null si no está. */
function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * La carpeta que publicó el trabajo `number`: `suites-shard-<number>-a<intento>`. Un trabajo reintentado desde Azure
 * publica otra carpeta (los artefactos no se pueden pisar): vale la del intento MÁS ALTO, sea mejor o peor que la
 * anterior, porque es lo último que se supo de ese trabajo. null si no publicó ninguna.
 */
function latestAttempt(artifacts, number) {
  let names;
  try {
    names = fs.readdirSync(artifacts);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let latest = null;
  for (const name of names) {
    const m = name.match(/^suites-shard-([1-9]\d*|bench)-a([1-9]\d*)$/);
    if (!m || m[1] !== String(number)) continue;
    const attempt = Number(m[2]);
    if (!latest || attempt > latest.attempt) latest = { dir: path.join(artifacts, name), attempt };
  }
  return latest;
}

/**
 * Lo que midió un trabajo, cruzado con lo que TENÍA que correr. Devuelve las que corrió, las fallas, las no medidas y,
 * si algo no cierra, por qué.
 *
 * 🔴 A lo publicado no se le cree sin mirar (revisión del 2026-10-04): una bajada a medias dejaba la carpeta con su
 * marca y sin `failures.txt`, y «no hay archivo» se leía como «no hubo fallas». Si a la carpeta le falta `ran.txt` o
 * `failures.txt` (el trabajo crea los dos antes de correr nada), si trae un nombre que no era de su lista, una roja
 * que no figura entre las corridas, o una marca cuya cuenta no coincide con lo publicado, NADA de ese trabajo se da
 * por bueno: todas sus suites quedan no medidas (`broken`).
 */
function readShard(found, expected) {
  const all = (problem, broken) => ({ ran: [], recorded: [], unmeasured: [...expected], retries: {}, problem, broken });
  if (!found) return all('no publicó lo que midió', false);
  const ran = readLines(path.join(found.dir, RAN_FILE));
  const recorded = readLines(path.join(found.dir, FAILURES_FILE));
  const missing = [ran === null && RAN_FILE, recorded === null && FAILURES_FILE].filter(Boolean);
  if (missing.length) return all(`lo que publicó está incompleto (falta ${missing.join(' y ')})`, true);
  const absent = new Set(recorded.filter((f) => f.endsWith(ABSENT_MARK)).map((f) => f.slice(0, -ABSENT_MARK.length)));
  // Las que el trabajo cortó por su tope (story 8.22, tramo D): corrieron y no se midieron. Las anota él mismo.
  const capped = recorded.filter((f) => f.endsWith(UNMEASURED_MARK)).map((f) => f.slice(0, -UNMEASURED_MARK.length));
  const red = recorded.filter((f) => !f.endsWith(ABSENT_MARK) && !f.endsWith(UNMEASURED_MARK));
  const foreign = [...ran, ...red, ...absent, ...capped].filter((name) => !expected.includes(name));
  if (foreign.length) return all(`lo que publicó nombra suites que no eran de su lista (${[...new Set(foreign)].slice(0, 3).join(' ')})`, true);
  const neverRan = [...red, ...capped].filter((name) => !ran.includes(name));
  if (neverRan.length) return all(`lo que publicó trae rojas que no figuran entre las corridas (${neverRan.slice(0, 3).join(' ')})`, true);
  const mark = readLines(path.join(found.dir, FINISHED_FILE));
  const finished = mark !== null;
  if (finished) {
    // La marca es la cuenta que hizo el propio trabajo al terminar: «<corridas> <fallas>».
    const counts = (mark[0] || '').match(/^(\d+) (\d+)$/);
    if (mark.length !== 1 || !counts || Number(counts[1]) !== ran.length || Number(counts[2]) !== recorded.length) {
      return all(`su marca de terminado dice «${mark.join(' ').slice(0, 40)}» y lo publicado trae ${ran.length} corrida(s) y ${recorded.length} falla(s)`, true);
    }
  }
  const retries = readRetries(path.join(found.dir, RETRIES_FILE), { expected, ran, red });
  if (retries.problem) return all(`lo que publicó trae las dos pasadas de sus rojas y no cuadran (${retries.problem})`, true);
  const unmeasured = [];
  // Sin la marca, lo que arrancó y no terminó quedó a medias: no se sabe cómo terminó. Con `done.txt` (cada suite que
  // termina, de cualquier forma: story 8.22 tramo D) son todas las que arrancaron y no figuran ahí; con `xargs -P` hay
  // varias a la vez. Sin `done.txt` (el nocturno, que corre de a una) es la última que arrancó, si no se anotó como roja.
  const done = readLines(path.join(found.dir, DONE_FILE));
  const halfway = new Set();
  if (!finished && done !== null) {
    // Una que ya se anotó roja o cortada llegó a su resultado, aunque el corte la agarrara antes de anotarse en done.txt.
    for (const name of ran) if (!done.includes(name) && !red.includes(name) && !capped.includes(name)) halfway.add(name);
  } else if (!finished) {
    const last = ran[ran.length - 1];
    if (last !== undefined && !recorded.includes(last) && !capped.includes(last)) halfway.add(last);
  }
  for (const name of expected) {
    if (absent.has(name)) continue;
    if (!ran.includes(name) || halfway.has(name)) unmeasured.push(name);
  }
  let problem = null;
  if (!finished) problem = 'publicó sin la marca de terminado (se cortó a mitad de camino)';
  else if (unmeasured.length) problem = 'dejó la marca de terminado sin pasar por toda su lista';
  return { ran, recorded, unmeasured, retries: retries.value, problem, broken: false };
}

/**
 * Las dos pasadas de las rojas de un trabajo (`retries.json`). No está: {} — el nocturno no reintenta. Está y no
 * cuadra con lo publicado (no se deja leer, no es un objeto, nombra una suite que no corrió o que no era suya, una
 * firme que no figura entre las fallas o una que pasó al reintento y figura): `problem`, y no se le cree a nada del
 * trabajo, igual que a una carpeta a la que le falta un archivo.
 */
function readRetries(file, { expected, ran, red }) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { value: {} };
    throw e;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { problem: `${RETRIES_FILE} no se deja leer` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { problem: `${RETRIES_FILE} no es un objeto` };
  for (const [name, passes] of Object.entries(data)) {
    if (!expected.includes(name) || !ran.includes(name)) return { problem: `${name} no corrió en este trabajo` };
    const second = passes && passes.primera === 'rojo' ? passes.segunda : null;
    if (second !== 'rojo' && second !== 'verde') return { problem: `${name}: las pasadas no dicen «rojo» y después «rojo» o «verde»` };
    if ((second === 'rojo') !== red.includes(name)) return { problem: `${name}: ${second === 'rojo' ? 'firme y no figura entre las fallas' : 'pasó al reintento y figura entre las fallas'}` };
  }
  return { value: data };
}

function commandMerge(argv, write) {
  const artifacts = option(argv, '--artifacts');
  const out = option(argv, '--out');
  if (!artifacts) throw new Refused('falta --artifacts <carpeta con lo que publicó cada trabajo>');
  if (!out) throw new Refused('falta --out <carpeta donde dejar lo de todos los trabajos juntos>');
  const { count, shards, bench } = prepare(argv);
  const ran = [];
  const failures = [];
  const retries = {};
  const outputs = [];   // [nombre del archivo en red-output, de dónde copiarlo o qué texto escribirle]
  const lines = [];
  // Cada trabajo de suites, y el del banco si el plan trae suites que corren solas (tramo I): a los dos se les exige lo mismo.
  const jobs = shards.map((shard, i) => ({ key: i + 1, name: `trabajo ${i + 1}`, title: `trabajo ${i + 1} de ${count}`, suites: shard.suites }));
  if (bench.length) jobs.push({ key: BENCH_SHARD, name: 'trabajo del banco', title: 'trabajo del banco', suites: bench });
  jobs.forEach((job) => {
    const number = job.name.replace(/^trabajo /, '');
    const found = latestAttempt(artifacts, job.key);
    const result = readShard(found, job.suites.map((s) => s.name));
    const label = `${job.title}${found && found.attempt > 1 ? ` (intento ${found.attempt})` : ''}`;
    for (const name of result.ran) if (!ran.includes(name)) ran.push(name);
    Object.assign(retries, result.retries);
    for (const name of result.recorded) {
      failures.push(name);
      const saved = path.join(found.dir, RED_OUTPUT_DIR, `${name}.txt`);
      if (fs.existsSync(saved)) outputs.push([`${name}.txt`, { copy: saved }]);
      // Una cortada por su tope sin el archivo del motivo igual lleva uno: nunca una no medida sin decir por qué.
      else if (name.endsWith(UNMEASURED_MARK)) outputs.push([`${name}.txt`, { text: `no medida: el trabajo ${number} la cortó por su tope\n` }]);
    }
    const motive = result.broken ? `no medida: lo que publicó el trabajo ${number} está incompleto` : `no medida: el trabajo ${number} no terminó`;
    for (const name of result.unmeasured) {
      failures.push(`${name}${UNMEASURED_MARK}`);
      outputs.push([`${name}${UNMEASURED_MARK}.txt`, { text: `${motive}\n` }]);
    }
    if (result.problem) {
      const some = result.unmeasured.slice(0, 5).join(' ') + (result.unmeasured.length > 5 ? ' …' : '');
      lines.push(`##vso[task.logissue type=error]El ${label} de las suites no terminó: ${result.problem}. ${result.unmeasured.length} suite(s) quedan como NO MEDIDAS, no como verdes: ${some}`);
    } else {
      lines.push(`${label}: terminó · ${result.ran.length} corrida(s) · ${result.recorded.length} en rojo o ausente(s)`);
    }
  });
  fs.mkdirSync(path.join(out, RED_OUTPUT_DIR), { recursive: true });
  for (const [name, source] of outputs) {
    const target = path.join(out, RED_OUTPUT_DIR, name);
    if (source.copy) fs.copyFileSync(source.copy, target); else fs.writeFileSync(target, source.text);
  }
  fs.writeFileSync(path.join(out, RAN_FILE), ran.map((n) => `${n}\n`).join(''));
  fs.writeFileSync(path.join(out, FAILURES_FILE), failures.map((n) => `${n}\n`).join(''));
  fs.writeFileSync(path.join(out, RETRIES_FILE), `${JSON.stringify(retries, null, 2)}\n`);
  write(`${lines.join('\n')}\n`);
}

const COMMANDS = { list: commandList, plan: commandPlan, merge: commandMerge, jobs: commandJobs, caps: commandCaps, matrix: commandMatrix, of: commandOf };

function main(argv, write = (text) => process.stdout.write(text), complain = (text) => process.stderr.write(text)) {
  const command = COMMANDS[argv[0]];
  if (!command) {
    complain(USAGE);
    return 2;
  }
  try {
    command(argv.slice(1), write, complain);
    return 0;
  } catch (e) {
    // Al trabajo pedido no le toca ninguna suite (--exclusive-apart): ni un pedido negado ni una lista vacía. Sale 3.
    if (e instanceof Nothing) {
      complain(`ℹ️  suites-shard ${argv[0]}: ${e.message}\n`);
      return 3;
    }
    if (!(e instanceof Refused)) throw e;
    complain(`❌ suites-shard ${argv[0]}: ${e.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, assign, readSuites, readWeights, latestAttempt, RAN_FILE, FAILURES_FILE, RED_OUTPUT_DIR, FINISHED_FILE, RETRIES_FILE, UNMEASURED_MARK };
