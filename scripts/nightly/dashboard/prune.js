#!/usr/bin/env node
/**
 * prune.js — el criterio de poda del catálogo de reglas (story 2.9).
 *
 * LA PREGUNTA
 * -----------
 * ¿Qué regla no encontró nada nunca — y sabe ponerse roja?
 *
 * Hasta acá el catálogo sólo podía crecer: se contaba el numerador (los hallazgos) y no el
 * denominador (las oportunidades). Sin denominador, «esta regla nunca encontró nada» y «a esta regla
 * nunca la miró nadie» se ven idénticos, y retirar a ciegas es tan malo como no retirar nunca.
 *
 * LAS TRES PUNTAS QUE CRUZA
 * -------------------------
 *   numerador    los hallazgos, ya proyectados por `collect-findings.js`: los de esta máquina y
 *                los de la carpeta bajada del buzón (`<maq>/registros/`).
 *   denominador  cuántas veces corrió el revisor DUEÑO de cada regla, leído de los volcados de
 *                corridas (`timing-history/*.json → revisores.por_tipo`) — NO de `advisor-runs/`,
 *                que se borra a los 7 días: la serie nacería muerta.
 *
 *  🔴 LAS DOS PUNTAS CUENTAN EL MISMO UNIVERSO DE MÁQUINAS (vuelta 2). Una máquina entra sólo si sus
 *     hallazgos están MEDIDOS —esta, según el sello del recolector (`estadoDeLaSerie`, la única
 *     definición); una del buzón, según su cobertura, y no más vieja que `prune.max_findings_days`—, y
 *     de las que no entran tampoco se cuentan las corridas: sumar el denominador de todas contra el
 *     numerador de algunas infla las candidatas (medido: 8 publicadas, 4 reales). Sin ninguna máquina
 *     medida el cruce se NIEGA: cero hallazgos no medidos se leerían como «no encontró nada».
 *  🔴 La misma corrida puede llegar por dos máquinas (la evidencia viaja por git): cuenta una vez, por
 *     su huella `corrida`. Y un volcado archivado dos veces cuenta una, el más nuevo, por su sesión.
 *  🔴 Story 2.28: cada máquina sube a `<nombre>-<código>`. Una carpeta vieja que el bajador declara en
 *     `.carpetas-de-maquina.json` como unida o compartida no es una máquina más en ninguna de las dos
 *     puntas; una que siguió recibiendo sí (es otra máquina que no actualizó). Sin ese archivo, cada
 *     carpeta cuenta como antes y se dice.
 *   banco        si la regla tiene un caso que la obliga a marcar (`must-flag`) y si el examen
 *                periódico lo corrió.
 *
 * LOS SIETE ESTADOS, EN ESTE ORDEN DE PRECEDENCIA
 * -----------------------------------------------
 *   sin_revisor                    el dueño no es un revisor: no hay veredicto posible
 *   rota                           algún caso del banco corrió y FALLÓ, en cualquier sentido
 *   revision_humana                sus hallazgos son mayoritariamente refutados: grita en falso
 *   activa                         encontró algo en código real: demostró que detecta
 *   sin_examinar                   nunca encontró nada y el banco no la probó: no se juzga
 *   candidata_a_retiro             probada, cero hallazgos, con recorrido suficiente
 *   sin_oportunidades_suficientes  probada, cero hallazgos, pero con poco recorrido
 *
 *  🔴 Por qué ESTE orden y no el que la story escribió primero: el banco sólo hace falta para juzgar
 *     reglas que nunca encontraron nada. Una regla con hallazgos reales ya demostró que detecta; una
 *     rota o una que grita en falso tiene que verse aunque el banco no la haya examinado. Con
 *     `sin_examinar` antes de `rota`, la única regla rota medida hoy (una del paquete de clientes, con un caso «no debe
 *     marcar» que falló) quedaba escondida.
 *
 *  🔴 «Disuade» no es un estado: es la advertencia pegada a cada candidata. Medido el 2026-09-16,
 *     las 68 reglas con caso tienen TODAS un caso `must-flag`, así que «probada» y «sabe ponerse
 *     roja» son el mismo conjunto: una cubeta «disuade» separada de «candidata» no se llenaría nunca.
 *
 * LO QUE NUNCA HACE
 * -----------------
 *  · Nunca retira nada. Marca; decide una persona.
 *  · Nunca aplica el piso de 3 del reductor: acá «1 hallazgo» y «0 hallazgos» son la diferencia
 *    entre dejar una regla y retirarla. El piso de esta tabla es 1, declarado con su motivo.
 *  · Nunca recorta una punta y no la otra: la ventana es la misma para hallazgos y oportunidades.
 *  · Nunca publica algo del volcado que no sea el conteo por revisor: el volcado trae rutas
 *    absolutas del disco y nombres de proyecto.
 *  · Nunca lee `findings.json` originales: sólo lo que el recolector ya preparó.
 *
 * USO
 *   node scripts/nightly/dashboard/prune.js [--json] [--today AAAA-MM-DD]
 *     [--findings <jsonl>] [--mailbox <dir>] [--history <dir>] [--machine <alias>]
 *     [--cases <dir>] [--exam <json>] [--catalog <md>] [--reviewers <dir>] [--sources <json>] [--without-local]
 *
 *   --without-local (story 2.12): no hay «esta máquina». Lo usa el nocturno de Azure, que no es una máquina del equipo:
 *     sin la bandera, el agente entraría como una máquina más (sin medir, o con los hallazgos y la historia de su
 *     disco), y las dos puntas del cruce dejarían de contar sólo las máquinas del buzón.
 *
 * Exit: 0 = midió (aunque el examen no se haya podido usar: eso se dice adentro)
 *       2 = no pudo medir, o la configuración no sirve, o la suma de los estados no cierra.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const zlib = require('zlib');

const catalogoDeReglas = require('../../lib/rules-catalog.js');
const { readEnv } = require('../../lib/legacy-names.js');
const { estadoDeLaSerie, serieCoincide, conteosDelSello } = require('../../metrics/collect-findings.js');
const { aliasDeNombre, leerUnionesDeCarpetas } = require('./reducer.js');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const casaPipeline = () => path.join(stateDirOf(os.homedir()));

const MAX_VOLCADO_BYTES = 32 * 1024 * 1024;
const MAX_GZ_BYTES = 16 * 1024 * 1024;
const MAX_JSONL_BYTES = 64 * 1024 * 1024;

const ESTADOS = [
  'sin_revisor', 'rota', 'revision_humana', 'activa',
  'sin_examinar', 'candidata_a_retiro', 'sin_oportunidades_suficientes',
];

const SIN_NOMBRE = '\u0000esta-maquina';   // clave de esta máquina cuando no se pudo leer su nombre

class NoMedido extends Error {
  constructor(motivo) { super(motivo); this.motivo = motivo; }
}

// ───────────────────────────── configuración ─────────────────────────────

/**
 * 🔴 Cada valor del criterio se DECLARA en sources.json → prune, antes de mirar el resultado (regla de
 *    la casa). Un valor por defecto en el código sería un umbral que nadie commiteó: por eso lo que
 *    falte o no tenga forma hace que el cruce se NIEGUE, nombrando la clave.
 */
function leerConfig(ruta) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(ruta, 'utf8')); }
  catch (e) { throw new NoMedido(`no pude leer la configuración (${e.code || e.message})`); }
  const p = cfg && cfg.prune;
  if (!p || typeof p !== 'object') throw new NoMedido('sources.json no tiene la sección «prune»');

  const entero = (clave, min) => {
    const v = p[clave];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
      throw new NoMedido(`prune.${clave} tiene que ser un entero ≥ ${min} (es ${JSON.stringify(v)})`);
    }
    return v;
  };
  // Las claves del archivo, en inglés (story 8.9, tanda D1); los nombres de `conf` son internos y no cambian.
  const conf = {
    ventana_dias: entero('window_days', 1),
    umbral_oportunidades: entero('threshold_opportunities', 1),
    umbral_meses: entero('threshold_months', 1),
    piso: entero('floor', 1),
    examen_max_dias: entero('exam_max_days', 1),
    refutados_minimo: entero('min_refuted', 1),
    max_dias_hallazgos: entero('max_findings_days', 1),
  };
  // 🔴 El piso de ESTA tabla es 1. Un piso mayor borraría la diferencia entre 1 hallazgo y 0, que es
  //    justamente la señal que decide dejar o retirar.
  if (conf.piso !== 1) {
    throw new NoMedido(`prune.floor es ${conf.piso}: el piso de la tabla por regla tiene que ser 1 — con otro, una regla con pocos hallazgos se leería como cero y saldría candidata`);
  }
  if (!Array.isArray(p.not_reviewers) || p.not_reviewers.some((x) => typeof x !== 'string')) {
    throw new NoMedido('prune.not_reviewers tiene que ser una lista de nombres');
  }
  conf.no_revisores = new Set(p.not_reviewers);
  return conf;
}

// ───────────────────────────── fechas ─────────────────────────────

function fechaValida(f) {
  return typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f)
    && !Number.isNaN(Date.parse(`${f}T00:00:00Z`))
    && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;
}
function restarDias(dia, n) {
  const t = Date.parse(`${dia}T00:00:00Z`) - n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function diasEntre(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// ───────────────────────────── numerador ─────────────────────────────

/** Suma los conteos CONOCIDOS de un sello (la lista vive en el recolector). Nada de afuera entra por el nombre. */
function sumarConteos(destino, sello) {
  const c = conteosDelSello(sello);
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === 'number') destino[k] = (destino[k] || 0) + v;
    else {
      if (!destino[k]) destino[k] = {};
      for (const [k2, v2] of Object.entries(v)) destino[k][k2] = (destino[k][k2] || 0) + v2;
    }
  }
}

/**
 * Las series de todas las máquinas. Una máquina entra sólo si su serie está MEDIDA con la regla del
 * recolector (`estadoDeLaSerie` acá; `serieCoincide` + la fecha de su sello para las del buzón). De cada
 * máquina medida quedan sus hallazgos y el conjunto de volcados cuya corrida se leyó (el denominador).
 */
function leerHallazgos({ local, claveLocal, buzon, ventana, fuera, hoy, fuentes, maxDias, viejas = new Set() }) {
  const acc = { lista: [], duplicados: 0, medidas: new Map(), sinMedir: [], buzonIlegible: false, recolector: {} };
  const duenaDe = new Map();   // corrida → máquina que la aportó primero

  const aportar = (clave, serie) => {
    for (const h of serie.hallazgos) {
      const duena = duenaDe.get(h.corrida);
      // 🔴 La misma corrida desde otra máquina (la evidencia viaja por git): ya está contada. Dentro de
      //    una máquina, una corrida tiene tantas líneas como hallazgos, y todas cuentan.
      if (duena !== undefined && duena !== clave) { acc.duplicados += 1; continue; }
      duenaDe.set(h.corrida, clave);
      const fecha = h.ts.slice(0, 10);
      if (fecha < ventana.desde || fecha > ventana.hasta) { fuera.hallazgos += 1; continue; }
      acc.lista.push({ fecha, corrida: h.corrida, regla: h.regla, dueno: h.dueno, disposicion: h.disposicion });
    }
    acc.medidas.set(clave, new Set(serie.volcados.map((v) => v.volcado)));
  };

  // esta máquina, del disco — medida sólo si el recolector lo dice (una sola definición). Sin ruta (el nocturno, story
  // 2.12) no hay «esta máquina»: ni aporta ni se nombra como sin medir.
  if (local) {
    const est = estadoDeLaSerie({ salida: local, hoy, fuentes, maxDias });
    if (est.estado === 'medido') {
      aportar(claveLocal, est.serie);
      sumarConteos(acc.recolector, est.sello);
    } else {
      acc.sinMedir.push({ clave: claveLocal, local: true, motivo: est.motivo });
    }
  }

  // las bajadas del buzón — la de ESTA máquina, si ya se midió del disco, se saltea: gana el disco
  let entradas = [];
  try { entradas = fs.readdirSync(buzon, { withFileTypes: true }); }
  catch (e) { if (e.code !== 'ENOENT') acc.buzonIlegible = true; }
  entradas.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entradas) {
    if (!e.isDirectory() || acc.medidas.has(e.name)) continue;
    // story 2.28: una carpeta vieja unida o compartida no es una máquina más: lo suyo está en las carpetas nuevas, que
    // reciben el registro entero.
    if (viejas.has(e.name)) continue;
    // 🔴 Los motivos de acá son FIJOS o llevan sólo fechas y conteos: la cobertura viene de otra máquina y
    //    su texto no se publica.
    const no = (motivo) => acc.sinMedir.push({ clave: e.name, local: false, motivo });
    const reg = path.join(buzon, e.name, 'registros');
    let cob;
    try { cob = JSON.parse(fs.readFileSync(path.join(reg, 'cobertura.json'), 'utf8')); }
    catch (err) { no(err.code === 'ENOENT' ? 'no subió la cobertura de sus registros' : 'su cobertura no se puede leer'); continue; }
    const fh = cob && cob.fuentes && cob.fuentes.hallazgos;
    if (!fh || fh.estado !== 'medido') { no('su cobertura no declara los hallazgos como medidos'); continue; }
    // 🔴 La antigüedad es la de su SELLO (cuándo se midió), no la de la preparación de la subida.
    if (!fechaValida(fh.fecha)) { no('su cobertura no dice de qué fecha es su serie'); continue; }
    const edad = diasEntre(fh.fecha, hoy);
    if (edad < 0) { no('su serie tiene una fecha posterior a hoy'); continue; }
    if (edad > maxDias) { no(`su serie es del ${fh.fecha}, hace ${edad} días`); continue; }
    let texto;
    try {
      const gz = path.join(reg, 'hallazgos.jsonl.gz');
      if (fs.statSync(gz).size > MAX_GZ_BYTES) throw new Error('grande');
      texto = zlib.gunzipSync(fs.readFileSync(gz), { maxOutputLength: MAX_JSONL_BYTES }).toString('utf8');
    } catch (_) { no('su archivo de hallazgos no se puede leer'); continue; }
    const c = serieCoincide(texto, fh.resumen);
    if (!c.ok) { no(c.motivo); continue; }
    aportar(e.name, c.serie);
    sumarConteos(acc.recolector, fh.resumen);
  }
  // 🔴 Esta máquina puede entrar por su copia del buzón aunque su disco no esté medido: entonces NO se la
  //    nombra como «sin medir» (se contaría y se diría que no entró).
  acc.sinMedir = acc.sinMedir.filter((m) => !acc.medidas.has(m.clave));
  return acc;
}

// ───────────────────────────── denominador ─────────────────────────────

/**
 * 🔴 Del volcado se lee SÓLO `revisores.por_tipo`, `revisores.estado` y la fecha. El volcado trae
 *    rutas absolutas del disco, nombres de proyecto y huellas de archivos: nada de eso sale.
 */
function fechaDeVolcado(d, nombre) {
  const m = d && d.marker;
  const cand = [m && m.startedAt, d && d.archivedAt];
  for (const c of cand) if (typeof c === 'string' && fechaValida(c.slice(0, 10))) return c.slice(0, 10);
  const f = /(\d{4}-\d{2}-\d{2})/.exec(nombre);
  return f && fechaValida(f[1]) ? f[1] : null;
}

/** Un conteo por revisor sólo sirve si TODOS sus valores son enteros ≥ 0. */
function formaDelConteo(pt) {
  if (pt === null || pt === undefined) return 'sin';
  if (typeof pt !== 'object' || Array.isArray(pt)) return 'ilegible';
  const valores = Object.values(pt);
  if (valores.length === 0) return 'sin';
  return valores.every((n) => Number.isInteger(n) && n >= 0) ? 'ok' : 'ilegible';
}

function leerHistoria({ local, claveLocal, buzon, ventana, fuera, noRevisores, medidas, viejas = new Set() }) {
  const candidatos = [];
  let carpetasIlegibles = 0;
  const juntar = (dir, clave) => {
    let lista;
    try { lista = fs.readdirSync(dir); }
    catch (e) { if (e.code !== 'ENOENT') carpetasIlegibles += 1; return; }
    for (const f of lista.sort()) {
      if (!f.endsWith('.json') || f === 'cobertura.json') continue;
      candidatos.push({ ruta: path.join(dir, f), clave, nombre: f, orden: candidatos.length });
    }
  };
  if (local) juntar(local, claveLocal);   // sin ruta (el nocturno): la historia sale sólo del buzón
  try {
    const dirs = fs.readdirSync(buzon, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    // story 2.28: las corridas de una carpeta vieja unida o compartida tampoco suman aparte (las de la nueva son las mismas)
    for (const n of dirs) if (!viejas.has(n)) juntar(path.join(buzon, n), n);
  } catch (e) { if (e.code !== 'ENOENT') carpetasIlegibles += 1; }
  // Un mismo archivo, en el disco y en el buzón (o en dos carpetas de una máquina renombrada), cuenta UNA vez — y la copia
  // que queda es la de una máquina que lo tiene LEÍDO en su serie, después la de una medida y recién después la de
  // cualquiera. 🔴 Deduplicar por orden de llegada (pase adversarial de la 2.12) le daba el volcado a la carpeta vieja sin
  // medir cuando su nombre ordenaba primero, y con ella se iba el denominador: en el nocturno no hay disco que lo tape.
  const rango = (c) => (medidas.has(c.clave) ? (medidas.get(c.clave).has(c.nombre) ? 0 : 1) : 2);
  const vistos = new Set();
  const archivos = [];
  for (const c of candidatos.sort((a, b) => rango(a) - rango(b) || a.orden - b.orden)) {
    if (vistos.has(c.nombre)) continue;
    vistos.add(c.nombre);
    archivos.push({ ruta: c.ruta, clave: c.clave });
  }

  let ilegibles = 0, descartadas = 0, duplicadas = 0, noLeidas = 0;
  const porSesion = new Map();   // sesión → { fecha, cuando, pt }
  for (const { ruta, clave } of archivos) {
    let d;
    try {
      if (fs.statSync(ruta).size > MAX_VOLCADO_BYTES) { ilegibles += 1; continue; }
      d = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    } catch (_) { ilegibles += 1; continue; }
    const fecha = fechaDeVolcado(d, path.basename(ruta));
    if (!fecha) { ilegibles += 1; continue; }
    if (fecha < ventana.desde || fecha > ventana.hasta) { fuera.corridas += 1; continue; }
    // 🔴 Una máquina sin hallazgos medidos no aporta oportunidades: se descarta y se cuenta.
    if (!medidas.has(clave)) { descartadas += 1; continue; }
    // 🔴 Y dentro de una máquina medida, sólo aporta la corrida cuyos hallazgos se LEYERON (el recolector
    //    la nombra): una corrida sin archivo legible sumaría oportunidades con cero hallazgos.
    if (!medidas.get(clave).has(path.basename(ruta))) { noLeidas += 1; continue; }
    const pt = d && d.revisores ? d.revisores.por_tipo : undefined;
    const forma = formaDelConteo(pt);
    // 🔴 Un conteo que no es un número no es «con denominador» ni «sin conteo»: es ilegible.
    if (forma === 'ilegible') { ilegibles += 1; continue; }
    const m = d && d.marker;
    const sesion = m && typeof m.sessionId === 'string' && m.sessionId ? m.sessionId : `archivo:${path.basename(ruta)}`;
    const cuando = typeof (d && d.archivedAt) === 'string' ? d.archivedAt : '';
    const previo = porSesion.get(sesion);
    if (previo) {
      duplicadas += 1;
      if (previo.cuando >= cuando) continue;   // gana el archivado más nuevo
    }
    porSesion.set(sesion, { fecha, cuando, pt: forma === 'ok' ? pt : null });
  }

  const porRevisor = new Map();     // revisor → { lanzamientos, meses:Set<AAAA-MM> }
  let total = 0, conDenominador = 0;
  // 🔴 Se CUENTA lo descartado. Sin este número el filtro no tiene ningún efecto visible —ninguno de
  //    esos agentes es dueño de una regla— y un test no puede distinguir «filtra» de «no filtra». El
  //    día que alguien declare a uno de ellos como dueño en el catálogo, sin el filtro sus
  //    lanzamientos se volverían oportunidades de reglas que nunca miraron.
  let noRevision = 0;
  for (const { fecha, pt } of porSesion.values()) {
    total += 1;
    // 🔴 Un volcado sin conteo NO aporta cero oportunidades: no aporta nada, y se cuenta aparte.
    if (!pt) continue;
    conDenominador += 1;
    const mes = fecha.slice(0, 7);
    for (const [rev, n] of Object.entries(pt)) {
      if (noRevisores.has(rev)) { if (typeof n === 'number' && n > 0) noRevision += n; continue; }
      if (n <= 0) continue;
      if (!porRevisor.has(rev)) porRevisor.set(rev, { lanzamientos: 0, meses: new Set() });
      const r = porRevisor.get(rev);
      r.lanzamientos += n;
      r.meses.add(mes);
    }
  }
  return { porRevisor, total, conDenominador, ilegibles, noRevision, descartadas, duplicadas, carpetasIlegibles, noLeidas };
}

// ───────────────────────────── banco ─────────────────────────────

function leerBanco({ casos, examen, hoy, maxDias }) {
  // «tiene caso rojo» = un caso `must-flag`, por PAR (revisor del archivo, regla del caso)
  const conCaso = new Set();
  let casosIlegibles = 0;
  try {
    for (const f of fs.readdirSync(casos)) {
      if (!f.endsWith('.json')) continue;
      const adv = f.slice(0, -'.json'.length);
      let d;
      // 🔴 Un archivo de casos roto se cuenta: callado, sus reglas quedarían «sin caso» sin motivo.
      try { d = JSON.parse(fs.readFileSync(path.join(casos, f), 'utf8')); } catch (_) { casosIlegibles += 1; continue; }
      if (!d || !Array.isArray(d.cases)) { casosIlegibles += 1; continue; }
      for (const c of d.cases) {
        if (c && c.type === 'must-flag' && typeof c.rule === 'string') conCaso.add(`${adv}\u0000${c.rule}`);
      }
    }
  } catch (e) {
    throw new NoMedido(`no pude leer los casos del banco (${e.code || e.message})`);
  }

  // 🔴 El examen se usa SÓLO si es completo, sin recorte y reciente. Si no, «examinada» es no medido
  //    — nunca «0 examinadas» — y ninguna regla puede salir candidata en esta corrida.
  const noUsable = (motivo) => ({ conCaso, casosIlegibles, usable: false, motivo, sanas: new Set(), rotas: new Set(), sinCorrer: new Set(), noConcluyentes: new Set() });
  let ex;
  try { ex = JSON.parse(fs.readFileSync(examen, 'utf8')); }
  catch (e) { return noUsable(e.code === 'ENOENT' ? 'no hay reporte del examen periódico' : `el reporte del examen no se pudo leer (${e.code || 'ilegible'})`); }
  // 🔴 El valor de `alcance` sale en el motivo publicado: sólo si es uno de los conocidos.
  const alcance = ex && ['completo', 'acotado', 'vida', 'parcial'].includes(ex.alcance) ? ex.alcance : 'otro';
  if (!ex || ex.alcance !== 'completo') return noUsable(`el último examen es una corrida acotada (alcance «${alcance}»): no dice nada de los revisores que no cubrió`);
  if (!Array.isArray(ex.only) || ex.only.length > 0) return noUsable('el último examen se corrió con un recorte (only)');
  const fechaEx = typeof ex.ts === 'string' ? ex.ts.slice(0, 10) : '';
  if (!fechaValida(fechaEx)) return noUsable('el reporte del examen no tiene una fecha legible');
  const edad = diasEntre(fechaEx, hoy);
  if (edad > maxDias) return noUsable(`el último examen es del ${fechaEx}, hace ${edad} días (más de ${maxDias}): una foto vieja no dice cuáles están probadas hoy`);
  // 🔴 `results` es un OBJETO con claves `<revisor>::<caso>`, no un array.
  const res = ex.results;
  if (!res || typeof res !== 'object' || Array.isArray(res)) return noUsable('el reporte del examen no trae resultados con la forma esperada');

  const sanas = new Set(), rotas = new Set(), corrio = new Set(), nulas = new Set(), noConcluyentes = new Set();
  let validos = 0;
  for (const [clave, v] of Object.entries(res)) {
    if (!v || typeof v.rule !== 'string' || !v.tools || typeof v.tools !== 'object') continue;
    validos += 1;
    const adv = clave.split('::')[0];
    const par = `${adv}\u0000${v.rule}`;
    for (const t of Object.values(v.tools)) {
      if (!t) continue;
      if (t.pass === true) { corrio.add(par); if (v.type === 'must-flag') sanas.add(par); }
      // 🔴 Rota es SÓLO un error de CRITERIO (el revisor razonó mal), en cualquier sentido. Si falló la
      //    corrida —error, fuga del corral, artefactos, inestable— no se sabe nada del criterio: la
      //    regla no queda ni rota ni probada por ese caso.
      else if (t.pass === false && t.clase === 'criterio') { corrio.add(par); rotas.add(par); }
      else if (t.pass === false) noConcluyentes.add(par);
      else nulas.add(par);                                              // constancia, no verde
    }
  }
  if (validos === 0) return noUsable('el reporte del examen no trae ningún resultado legible');
  for (const r of rotas) sanas.delete(r);
  const sinCorrer = new Set([...nulas, ...noConcluyentes].filter((p) => !corrio.has(p)));
  return { conCaso, casosIlegibles, usable: true, fecha: fechaEx, sanas, rotas, sinCorrer, noConcluyentes };
}

// ───────────────────────────── el cruce ─────────────────────────────

function podar(opts = {}) {
  // Las variables renombradas a inglés (story 8.9): el nombre viejo sigue valiendo hasta el retiro.
  const variable = (nombre) => readEnv(nombre, { where: 'scripts/nightly/dashboard/prune.js' });
  // 🔴 Una fecha pedida que no se entiende NO se reemplaza por la de hoy: se niega.
  const pedida = opts.hoy !== undefined && opts.hoy !== null ? opts.hoy : variable('TYCON_TODAY');
  if (pedida !== undefined && pedida !== '' && !fechaValida(pedida)) throw new NoMedido('la fecha pedida no es un día AAAA-MM-DD válido');
  const hoy = pedida ? pedida : new Date().toISOString().slice(0, 10);
  const rutaFuentes = opts.fuentes || variable('TYCON_SOURCES_JSON') || path.join(__dirname, 'sources.json');
  const conf = leerConfig(rutaFuentes);
  const ventana = { desde: restarDias(hoy, conf.ventana_dias), hasta: restarDias(hoy, 1) };
  const fuera = { hallazgos: 0, corridas: 0 };

  const cat = catalogoDeReglas.leer({ catalogo: opts.catalogo, revisores: opts.revisores });
  if (cat.estado !== 'medido') throw new NoMedido(`sin catálogo no hay filas: ${cat.motivo}`);

  let maquina = opts.maquina || null;
  if (!maquina) {
    try { maquina = require('../../metrics/upload-runs.js').nombreDeMaquina(); } catch (_) { maquina = null; }
  }
  const casa = casaPipeline();
  const buzon = opts.buzon || variable('TYCON_MAILBOX_DIR') || path.join(casa, 'corridas-buzon');
  const claveLocal = maquina || SIN_NOMBRE;

  // 🔴 story 2.12: el nocturno de Azure no es una máquina del equipo. Con `sinLocal`, ninguna de las dos puntas lee
  //    el disco de quien corre el cruce: numerador y denominador salen de las MISMAS máquinas del buzón.
  const sinLocal = opts.sinLocal === true;
  // story 2.28 (decisiones 12 y 13): las carpetas viejas del buzón las declara el bajador en `.carpetas-de-maquina.json`.
  // Sin ese archivo no se une nada (cada carpeta cuenta como hoy) y se dice. Sin buzón, no hay nada que unir ni que decir.
  let uniones = null;
  try { if (fs.statSync(buzon).isDirectory()) uniones = leerUnionesDeCarpetas(buzon); }
  catch (e) { uniones = e && e.code === 'ENOENT' ? null : { estado: 'no_medidas', motivo: `la carpeta del buzón no se pudo mirar (${(e && e.code) || 'error'}): uniones de carpetas no medidas` }; }
  // Sólo la `unida` (sus registros están en la nueva) y la `compartida` (duplica a alguna declarante) no cuentan aparte. Una
  // `siguio_recibiendo` es otra máquina que todavía no actualizó: cuenta como una máquina propia, como siempre.
  const viejas = new Set(uniones && uniones.estado === 'medidas'
    ? [...uniones.carpetas].filter(([, u]) => u.estado === 'unida' || u.estado === 'compartida').map(([n]) => n) : []);
  const hall = leerHallazgos({
    local: sinLocal ? null : (opts.hallazgos || variable('TYCON_FINDINGS_OUTPUT') || path.join(casa, 'hallazgos.jsonl')),
    claveLocal, buzon, ventana, fuera, hoy, fuentes: rutaFuentes, maxDias: conf.max_dias_hallazgos, viejas,
  });
  // 🔴 Sin numerador no hay poda: cero hallazgos que nadie midió se leerían como «no encontró nada».
  if (hall.medidas.size === 0) {
    const local = hall.sinMedir.find((m) => m.local);
    throw new NoMedido(`ninguna máquina tiene sus hallazgos medidos, y sin numerador no hay poda${local ? ` (esta máquina: ${local.motivo})` : ''}`);
  }
  const hist = leerHistoria({
    local: sinLocal ? null : (opts.historia || variable('TYCON_HISTORY_DIR') || path.join(casa, 'timing-history')),
    claveLocal, buzon, ventana, fuera, noRevisores: conf.no_revisores, medidas: hall.medidas, viejas,
  });
  if (hist.conDenominador === 0) {
    throw new NoMedido(`ninguna corrida de las máquinas medidas trae el conteo de sus revisores, y sin denominador no hay poda${hist.carpetasIlegibles ? ` (${hist.carpetasIlegibles} carpeta(s) de corridas no se pudieron leer)` : ''}`);
  }
  const banco = leerBanco({
    casos: opts.casos || variable('TYCON_CASES_DIR') || path.join(RAIZ, 'scripts', 'controls-bench', 'cases', 'advisors'),
    examen: opts.examen || variable('TYCON_EXAM') || path.join(RAIZ, 'scripts', 'controls-bench', 'ultimo-examen.json'),
    hoy, maxDias: conf.examen_max_dias,
  });

  // hallazgos por par
  const porPar = new Map();
  for (const h of hall.lista) {
    const k = `${h.dueno}\u0000${h.regla}`;
    if (!porPar.has(k)) porPar.set(k, { total: 0, refutados: 0 });
    const a = porPar.get(k);
    a.total += 1;
    if (h.disposicion === 'refuted') a.refutados += 1;
  }

  const pares = new Set(cat.lista.map((r) => `${r.dueno || ''}\u0000${r.regla}`));
  const huerfanos = [...banco.conCaso].filter((p) => !pares.has(p)).length;

  const filas = [];
  for (const r of cat.lista) {
    const k = `${r.dueno || ''}\u0000${r.regla}`;
    const h = porPar.get(k) || { total: 0, refutados: 0 };
    const rev = r.esRevisor ? hist.porRevisor.get(r.dueno) : null;
    const oportunidades = r.esRevisor ? (rev ? rev.lanzamientos : 0) : null;
    const meses = r.esRevisor ? (rev ? rev.meses.size : 0) : null;
    const conCaso = banco.conCaso.has(k);
    const examinada = banco.usable ? banco.sanas.has(k) : null;

    let estado;
    if (!r.esRevisor) estado = 'sin_revisor';
    else if (banco.usable && banco.rotas.has(k)) estado = 'rota';
    else if (h.refutados >= conf.refutados_minimo && h.refutados * 2 > h.total) estado = 'revision_humana';
    else if (h.total > 0) estado = 'activa';
    else if (!examinada) estado = 'sin_examinar';          // incluye «examen no usable»: no se juzga
    else if (oportunidades >= conf.umbral_oportunidades && meses >= conf.umbral_meses) estado = 'candidata_a_retiro';
    else estado = 'sin_oportunidades_suficientes';

    filas.push({
      dueno: r.dueno,
      regla: r.regla,
      estado,
      hallazgos: h.total,
      refutados: h.refutados,
      oportunidades,
      meses,
      con_caso: conCaso,
      examinada,
      // «disuade» no es un estado: es la advertencia de toda candidata
      sabe_ponerse_roja: estado === 'candidata_a_retiro' ? true : (conCaso && examinada === true),
    });
  }

  const resumen = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
  for (const f of filas) resumen[f.estado] += 1;
  const suma = Object.values(resumen).reduce((a, b) => a + b, 0);
  // 🔴 La suma TIENE que cerrar: toda regla cae en exactamente un estado.
  if (suma !== cat.reglas || filas.length !== cat.reglas) {
    throw new NoMedido(`la suma de los estados (${suma}) no es el total de reglas del catálogo (${cat.reglas})`);
  }

  return {
    estado: 'medido',
    ventana,
    umbral: { oportunidades: conf.umbral_oportunidades, meses: conf.umbral_meses, refutados_minimo: conf.refutados_minimo },
    total: cat.reglas,
    resumen,
    filas,
    colisiones: cat.colisiones,
    cobertura: {
      corridas: {
        con_denominador: hist.conDenominador, total: hist.total, sin_por_tipo: hist.total - hist.conDenominador,
        ilegibles: hist.ilegibles, lanzamientos_no_revision: hist.noRevision, duplicadas: hist.duplicadas,
        // corridas de máquinas medidas que el recolector no leyó: sin archivo legible, sin carpeta en su sesión o sin repo
        descartadas_sin_hallazgos: hist.descartadas, no_leidas: hist.noLeidas,
        carpetas_ilegibles: hist.carpetasIlegibles,
      },
      hallazgos: {
        contados: hall.lista.length, duplicados: hall.duplicados,
        maquinas: hall.medidas.size,
        // 🔴 Por ALIAS, nunca por nombre: el nombre de una máquina suele ser el de su dueño.
        maquinas_sin_medir: hall.sinMedir.map((m) => ({ alias: m.clave === SIN_NOMBRE ? 'esta máquina' : aliasDeNombre(m.clave), local: m.local, motivo: m.motivo })),
        buzon_ilegible: hall.buzonIlegible,
        // story 2.28: sin nombres de carpeta, sólo el estado y nuestro motivo
        uniones_de_carpetas: uniones ? (uniones.estado === 'medidas' ? { estado: 'medidas', viejas_no_contadas: viejas.size } : { estado: 'no_medidas', motivo: uniones.motivo }) : null,
        recolector: hall.recolector,
      },
      banco: {
        con_caso: [...banco.conCaso].filter((p) => pares.has(p)).length,
        examinadas: banco.usable ? [...banco.sanas].filter((p) => pares.has(p)).length : null,
        rotas: banco.usable ? [...banco.rotas].filter((p) => pares.has(p)).length : null,
        sin_correr: banco.usable ? [...banco.sinCorrer].filter((p) => pares.has(p)).length : null,
        no_concluyentes: banco.usable ? [...banco.noConcluyentes].filter((p) => pares.has(p)).length : null,
        casos_ilegibles: banco.casosIlegibles,
        huerfanos,
      },
      examen: banco.usable ? { estado: 'medido', fecha: banco.fecha } : { estado: 'no_medido', motivo: banco.motivo },
      fuera_de_ventana: fuera,
    },
  };
}

// ───────────────────────────── CLI ─────────────────────────────

function valor(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  // un flag sin valor no se ignora: se lee como vacío y quien lo usa decide
  return v && !v.startsWith('--') ? v : '';
}

function main() {
  let res;
  try {
    if (valor('--today') === '') throw new NoMedido('--today necesita un día AAAA-MM-DD');
    res = podar({
      hoy: valor('--today'), fuentes: valor('--sources'), catalogo: valor('--catalog'),
      revisores: valor('--reviewers'), hallazgos: valor('--findings'), buzon: valor('--mailbox'),
      historia: valor('--history'), casos: valor('--cases'), examen: valor('--exam'),
      maquina: valor('--machine') || undefined,
      sinLocal: process.argv.includes('--without-local'),
    });
  } catch (e) {
    const motivo = e instanceof NoMedido ? e.motivo : `error inesperado: ${e.message}`;
    console.error(`poda: ${motivo}`);
    if (process.argv.includes('--json')) console.log(JSON.stringify({ estado: 'no_medido', motivo }, null, 2));
    process.exitCode = 2;
    return;
  }

  if (process.argv.includes('--json')) {
    // exitCode y no exit(): la salida es grande y exit() la trunca en el pipe.
    console.log(JSON.stringify(res, null, 2));
    process.exitCode = 0;
    return;
  }
  const c = res.cobertura;
  console.log(`Ventana ${res.ventana.desde} → ${res.ventana.hasta} · ${res.total} reglas (pares dueño+regla)`);
  for (const e of ESTADOS) console.log(`  ${e.padEnd(31)} ${res.resumen[e]}`);
  console.log(`Denominador: ${c.corridas.con_denominador} de ${c.corridas.total} corridas · hallazgos: ${c.hallazgos.contados} de ${c.hallazgos.maquinas} máquina(s) medida(s)`);
  for (const m of c.hallazgos.maquinas_sin_medir) console.log(`  sin medir: ${m.alias} — ${m.motivo}`);
  const un = c.hallazgos.uniones_de_carpetas;
  if (un && un.estado === 'no_medidas') console.log(`  uniones de carpetas no medidas (${un.motivo}): cada carpeta del buzón cuenta como una máquina`);
  else if (un && un.viejas_no_contadas) console.log(`  ${un.viejas_no_contadas} carpeta(s) vieja(s) del buzón no se cuentan aparte: lo suyo está en las carpetas nuevas`);
  if (c.corridas.descartadas_sin_hallazgos) console.log(`  ${c.corridas.descartadas_sin_hallazgos} corrida(s) descartadas: son de máquinas sin hallazgos medidos`);
  console.log(c.examen.estado === 'medido'
    ? `Banco: ${c.banco.con_caso} con caso · ${c.banco.examinadas} examinadas · ${c.banco.rotas} rotas · ${c.banco.huerfanos} caso(s) huérfano(s) · examen del ${c.examen.fecha}`
    : `Banco: ${c.banco.con_caso} con caso · examen NO MEDIDO — ${c.examen.motivo}`);
  process.exitCode = 0;
}

if (require.main === module) {
  require('../../lib/legacy-names.js').aliasArgv('scripts/nightly/dashboard/prune.js', { exitCode: 2, prefix: 'poda: ' });
  main();
}
module.exports = { podar, leerConfig, ESTADOS, NoMedido };
