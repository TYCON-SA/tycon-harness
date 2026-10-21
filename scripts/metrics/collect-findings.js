#!/usr/bin/env node
/**
 * collect-findings.js — junta los hallazgos que dejan las corridas del pipeline en TODOS los
 * repos de esta máquina y los normaliza a una serie que puede viajar.
 *
 * POR QUÉ EXISTE
 * --------------
 * El arnés sabe qué regla saltó en cada corrida, pero ese dato no sale del disco donde corrió:
 * hay **143 archivos en 10 repos** y **sólo 3 repos los commitean** (medido). Los otros
 * viven en una sola máquina y el buzón compartido no trae ninguno. Sin esto, cualquier tabla por regla
 * sería de una persona y de un proyecto.
 *
 * LA REGLA QUE LO ORDENA: «UNA LECTURA QUE FALLA NUNCA ES UN DATO BUENO»
 * --------------------------------------------------------------------
 * Cumplir la lista blanca no alcanza: quedan ~20 caminos por los
 * que una lectura rota, vacía, vieja o duplicada termina contada como hallazgo o como cero. Cada
 * decisión de abajo cierra uno de ellos, y cada una tiene su caso en `collect-findings.test.sh`.
 *
 * 1. 🔴 **Lista blanca de SEIS claves** — `{ts, corrida, regla, dueno, severidad, disposicion}`.
 *    `reason` y `file` son prosa y rutas (medido: rutas del home, nombres de persona, un host de
 *    cliente, decisiones citadas del dev) y el segundo esquema trae prosa en `resumen`,
 *    `los_que_mas_pesan` y `verificacion`. Lo que aparezca mañana tampoco sale.
 *    `corrida` es una huella opaca (ver 5): no dice qué repo ni qué story.
 *
 * 2. 🔴 **UN archivo por corrida.** Las corridas guardan la misma lista varias veces
 *    (`findings-input`, `-iterN`, `-final` y `findings.json`): sumarlas contaría cada hallazgo hasta
 *    cinco veces, y un único refutado real mandaría una regla a revisión humana. Se lee `findings.json`
 *    (el que escribe el paso 6); si no está, `findings-final`; si no, el `-iterN` más alto. Nunca
 *    `findings-input` (es la foto de ANTES de arreglar). Medido: 129 canónicos, 17 copias.
 *
 * 3. 🔴 **Fecha del nombre de la corrida, en sus dos formas** (`AAAAMMDD` y `AAAA-MM-DD`). Una corrida
 *    sin fecha legible **no emite** hallazgos: se cuenta. Inventarle «hoy» la metería en la ventana
 *    actual en una máquina y afuera en otra.
 *
 * 4. 🔴 **Cada corrida cae en exactamente un balde**, y los baldes suman el total:
 *      ilegible · sin_fecha · sin_nada · sin_evidencia · otro_esquema · revisado_sin_hallazgos · con_hallazgos
 *    «Sin evidencia» (no dejó el archivo pero SÍ corrieron revisores: la carpeta de informes, informes
 *    sueltos o el consolidado del paso 6) nunca es «cero hallazgos».
 *
 * 5. 🔴 **La identidad de una corrida es la misma en todas las máquinas.** Un `findings.json` commiteado
 *    existe en cada clon del repo: sin identidad, el total del equipo lo contaría una vez por máquina.
 *    `corrida` = huella de (dirección del remoto `origin` + nombre de la carpeta de la corrida). El
 *    remoto es el mismo en cualquier clon; el nombre de la carpeta local no.
 *
 * 6. 🔴 **«No pude mirar» se cuenta, no desaparece.** Una carpeta que no se puede listar suma a
 *    `carpetas_ilegibles`; una raíz sin un solo repo, un catálogo ilegible, vocabularios sin declarar,
 *    una fecha de hoy inválida o el tiempo agotado son `no_medido` (exit 2) y NO dejan archivo.
 *
 * 7. 🔴 **«Está medido» tiene UNA definición**: `estadoDeLaSerie()`. La usan la subida (para decidir si
 *    declara la fuente medida), el reductor y el cruce. Sin ella, un archivo viejo —el recolector
 *    apagado— se subiría como medido todos los días. Medida = sello de hace no más de
 *    `max_findings_days` días, con al menos un repo, y una serie cuyas líneas tienen TODAS forma y
 *    suman lo que el sello dice (una serie vacía o a medio escribir con un sello bueno no es «0»).
 *
 * 8. 🔴 **Qué corridas midió, para el denominador**. El cruce cuenta oportunidades con los
 *    volcados de `timing-history/`; una corrida cuyo archivo de hallazgos no se pudo leer sumaría
 *    oportunidades con cero hallazgos — medido: 49 de 113. Acá, que están las dos cosas en el mismo
 *    disco, cada volcado se empareja con su carpeta de corrida (mismo repo, misma story, dentro de la
 *    ventana de la sesión) y sale una línea `{volcado, medida}` sólo si esa corrida se leyó. El
 *    nombre del volcado es `<story>-<fecha>.json`: no dice ni repo ni persona.
 *
 * 9. 🔴 **Dos clones del mismo repo en la misma máquina** dan la misma huella: la corrida se lee una
 *    vez y la otra cae en el balde `repetida`.
 *
 * DÓNDE ESCRIBE
 * -------------
 * `~/.claude/.tycon-pipeline/hallazgos.jsonl` + `findings-seal.json`, junto a `gates.log` y
 * `bypass.log`, sin carpeta propia: la subida lo manda como un registro más, con una sola cobertura.
 * Los dos se escriben de forma atómica (primero la serie, después el sello). La salida tiene que
 * terminar en `.jsonl`: una ruta equivocada no se pisa ni se borra. El sello se lee por su nombre
 * actual y, si sólo está el del mapa de renombres (scripts/lib/renames.json), por ése; antes de
 * escribir el actual se le pasa su contenido, y el otro queda intacto.
 *
 * USO
 *   node scripts/metrics/collect-findings.js [--json] [--dry-run] [--budget-ms N]
 *        [--root <dir>] [--output <archivo>] [--catalog <md>] [--reviewers <dir>]
 *        [--sources <json>] [--today AAAA-MM-DD] [--history <dir>]
 *
 * Env: TYCON_REPOS_ROOT · TYCON_FINDINGS_OUTPUT · TYCON_TODAY · TYCON_CATALOG · TYCON_REVIEWERS_DIR ·
 *      TYCON_SOURCES_JSON · TYCON_HISTORY_DIR
 * Exit: 0 = midió (o ya lo había hecho hoy) · 2 = NO pudo medir.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const crypto = require('crypto');

const catalogoDeReglas = require('../lib/rules-catalog.js');
const { readEnv, resolveFile, prepareStateWrite } = require('../lib/legacy-names.js');
const DONDE = 'scripts/metrics/collect-findings.js';
/** Una variable renombrada a inglés: el nombre viejo sigue valiendo hasta el retiro. */
const variable = (nombre) => readEnv(nombre, { where: DONDE });

const RAIZ_REPO = path.resolve(__dirname, '..', '..');
const FUENTES_DEFAULT = path.join(RAIZ_REPO, 'scripts', 'nightly', 'dashboard', 'sources.json');

// Carpetas donde no se entra nunca: ni son repos del equipo ni su contenido es nuestro.
const NO_ENTRAR = new Set(['node_modules', 'bin', 'obj', '.git', 'dist', 'build', 'vendor', 'target', '.venv', 'venv']);
const PROFUNDIDAD = 2;              // <raiz>/*/ y <raiz>/*/*/ — medido: 49 de 128 archivos viven en el nivel 2
const MAX_BYTES = 8 * 1024 * 1024;  // un archivo de hallazgos más grande que esto no se lee (y se cuenta)
const MAX_SERIE_BYTES = 64 * 1024 * 1024;
const MAX_VOLCADO_BYTES = 32 * 1024 * 1024;
const MARGEN_SESION_MS = 30 * 60 * 1000;   // una corrida pertenece a la sesión si nació dentro de ella ± 30 min
const BUDGET_DEFAULT_MS = 60000;
// Un worktree hermano (`<Repo>--merge`, `<Repo>--wt-<slug>`, ver scripts/tools/tycon-worktree.sh) repite el repo.
const WORKTREE = /--(merge|wt-)/;

const casaPipeline = () => path.join(stateDirOf(os.homedir()));

class NoMedido extends Error {
  constructor(motivo) { super(motivo); this.motivo = motivo; }
}

function fechaValida(f) {
  return typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f)
    && !Number.isNaN(Date.parse(`${f}T00:00:00Z`))
    && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;
}
function diasEntre(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** El día de trabajo. 🔴 Un --today o TYCON_TODAY presente e inválido NO se reemplaza en silencio. */
function dia(opt) {
  const h = opt || variable('TYCON_TODAY');
  if (h === undefined || h === null || h === '') return new Date().toISOString().slice(0, 10);
  if (!fechaValida(h)) throw new NoMedido(`la fecha de hoy «${h}» no es una fecha AAAA-MM-DD válida`);
  return h;
}

/**
 * El `ts` sale del NOMBRE de la carpeta de la corrida, en sus dos formas reales:
 *   `2.9-AAAAMMDDTHHMMSS` · `3.25-AAAA-MM-DD-HHMM` · `D.6.6-AAAA-MM-DDTHH-MM-SS` · `R-7-AAAA-MM-DD`
 * Devuelve null si no hay una fecha válida: la corrida no emite (no se inventa «hoy»).
 */
/**
 * ¿La carpeta de corrida `nombre` es de la story `storyId`? `<número>-<sello>`, o `<tema>__<número>-<sello>` cuando el
 * número se repite en el repo. El volcado sólo trae el número: se aceptan las dos formas, como los
 * otros medidores (es una medición, no un freno; con número repetido sigue siendo ambiguo).
 */
function esCorridaDe(nombre, storyId) {
  return String(nombre).startsWith(`${storyId}-`) || String(nombre).includes(`__${storyId}-`);
}

function tsDeRunDir(nombre) {
  const conGuiones = /(\d{4})-(\d{2})-(\d{2})(?:[T-](\d{2})-?(\d{2})(?:-?(\d{2}))?)?/.exec(nombre);
  const compacta = /(\d{4})(\d{2})(\d{2})(?:[T-]?(\d{2})(\d{2})(\d{2})?)?/.exec(nombre);
  for (const m of [conGuiones, compacta]) {
    if (!m) continue;
    const [, a, mes, d, hh, mm, ss] = m;
    const fecha = `${a}-${mes}-${d}`;
    if (!fechaValida(fecha)) continue;
    const h = hh && Number(hh) < 24 ? hh : '00';
    const mi = mm && Number(mm) < 60 ? mm : '00';
    const se = ss && Number(ss) < 60 ? ss : '00';
    return `${fecha}T${h}:${mi}:${se}Z`;
  }
  return null;
}

// ─────────────── la forma de la serie: UNA definición, la usan el sello, la subida y el cruce ───────────────

const FORMA_CORRIDA = /^c-[0-9a-f]{12}$/;
const FORMA_VOLCADO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/;
const CLAVES_HALLAZGO = ['corrida', 'disposicion', 'dueno', 'regla', 'severidad', 'ts'];
const CLAVES_VOLCADO = ['medida', 'volcado'];
const MEDIDAS = ['con_hallazgos', 'revisado_sin_hallazgos'];

/** 'hallazgo' | 'volcado' | null. Una línea con cualquier otra forma es ilegible. */
function formaDeLinea(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const claves = Object.keys(o).sort().join(',');
  if (claves === CLAVES_HALLAZGO.join(',')) {
    const f = typeof o.ts === 'string' ? o.ts.slice(0, 10) : '';
    const textos = ['regla', 'dueno', 'severidad', 'disposicion'].every((k) => typeof o[k] === 'string' && o[k]);
    return fechaValida(f) && typeof o.corrida === 'string' && FORMA_CORRIDA.test(o.corrida) && textos ? 'hallazgo' : null;
  }
  if (claves === CLAVES_VOLCADO.join(',')) {
    return typeof o.volcado === 'string' && FORMA_VOLCADO.test(o.volcado) && MEDIDAS.includes(o.medida) ? 'volcado' : null;
  }
  return null;
}

/** Lee una serie: { hallazgos:[], volcados:[], ilegibles }. */
function leerSerie(texto) {
  const r = { hallazgos: [], volcados: [], ilegibles: 0 };
  for (const linea of String(texto).split('\n')) {
    const t = linea.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch (_) { r.ilegibles += 1; continue; }
    const forma = formaDeLinea(o);
    if (forma === 'hallazgo') r.hallazgos.push(o);
    else if (forma === 'volcado') r.volcados.push(o);
    else r.ilegibles += 1;
  }
  return r;
}

/**
 * ¿La serie es la que su sello (o el resumen que viajó con ella) dice? Todas las líneas con forma, y los
 * dos conteos iguales. 🔴 La MISMA regla del lado de la máquina que mide y del lado de quien lee el buzón:
 * una serie vacía o a medio escribir con un sello bueno nunca es «medida con cero».
 * Devuelve { ok:true, serie } o { ok:false, motivo }.
 */
function serieCoincide(texto, sello) {
  const serie = leerSerie(texto);
  if (serie.ilegibles > 0) return { ok: false, motivo: `la serie trae ${serie.ilegibles} línea(s) ilegibles o de otro formato` };
  const hallazgos = sello && sello.hallazgos;
  const medidos = sello && sello.volcados && sello.volcados.medidos;
  if (serie.hallazgos.length !== hallazgos || serie.volcados.length !== medidos) {
    return { ok: false, motivo: `la serie no coincide con su sello (${serie.hallazgos.length} hallazgos y ${serie.volcados.length} corridas contra ${hallazgos} y ${medidos})` };
  }
  return { ok: true, serie };
}

// 🔴 Los conteos del sello que pueden salir de la máquina: una LISTA de claves, no «todo lo que sea número».
//    El resumen de otra máquina llega por el buzón (la llave de escritura la tiene cualquiera con el repo):
//    filtrar sólo por valor dejaría pasar texto en el NOMBRE de una clave, y `__proto__`.
const CONTEOS_SELLO = ['repos', 'profundidad', 'run_dirs', 'hallazgos', 'fuera_de_catalogo', 'ambiguos',
  'elementos_sin_regla', 'elementos_otro_esquema', 'archivos_ilegibles', 'copias_ignoradas',
  'carpetas_ilegibles', 'worktrees_salteados', 'enlaces_salteados'];
const BALDES = ['ilegible', 'sin_fecha', 'sin_nada', 'sin_evidencia', 'otro_esquema', 'revisado_sin_hallazgos', 'con_hallazgos', 'repetida'];
const VOLCADOS = ['leidos', 'medidos', 'sin_corrida', 'sin_hallazgos_legibles', 'sin_repo', 'ilegibles'];

/** Sólo los conteos conocidos, sólo números finitos ≥ 0. Nada más sale, ni de acá ni de otra máquina. */
function conteosDelSello(sello) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const r = {};
  if (!sello || typeof sello !== 'object') return r;
  for (const k of CONTEOS_SELLO) if (num(sello[k])) r[k] = sello[k];
  for (const [grupo, claves] of [['baldes', BALDES], ['volcados', VOLCADOS]]) {
    const g = sello[grupo];
    if (!g || typeof g !== 'object' || Array.isArray(g)) continue;
    const sub = {};
    for (const k of claves) if (num(g[k])) sub[k] = g[k];
    if (Object.keys(sub).length) r[grupo] = sub;
  }
  return r;
}

/**
 * El instante de la carpeta de corrida, en milisegundos. 🔴 El nombre lo escribe el pipeline con la hora
 * LOCAL de la máquina (medido: `startedAt` 12:45Z → carpeta `…-095132` en UTC−3), así que se interpreta como
 * local — el recolector corre en la misma máquina. Sin hora no se puede ubicar en una sesión: null.
 */
function instanteDeRunDir(nombre) {
  const conGuiones = /(\d{4})-(\d{2})-(\d{2})[T-](\d{2})-?(\d{2})(?:-?(\d{2}))?/.exec(nombre);
  const compacta = /(\d{4})(\d{2})(\d{2})[T-]?(\d{2})(\d{2})(\d{2})?/.exec(nombre);
  for (const m of [conGuiones, compacta]) {
    if (!m) continue;
    const [, a, mes, d, hh, mm, ss] = m;
    if (!fechaValida(`${a}-${mes}-${d}`) || Number(hh) > 23 || Number(mm) > 59 || (ss && Number(ss) > 59)) continue;
    return new Date(Number(a), Number(mes) - 1, Number(d), Number(hh), Number(mm), Number(ss || 0)).getTime();
  }
  return null;
}

function enLista(valor, lista) {
  return typeof valor === 'string' && lista.includes(valor) ? valor : 'otro';
}

/**
 * Los vocabularios cerrados, de `sources.json → prune.vocabularies`. 🔴 Sin ellos no se decide nada:
 * inventar la lista mirando los datos es lo que la regla de la casa prohíbe.
 */
function leerVocabularios(rutaFuentes) {
  const ruta = rutaFuentes || variable('TYCON_SOURCES_JSON') || FUENTES_DEFAULT;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(ruta, 'utf8')); }
  catch (e) { throw new NoMedido(`no pude leer los vocabularios (${e.code || 'sources.json ilegible'})`); }
  const v = cfg && cfg.prune && cfg.prune.vocabularies;
  const lista = (x) => Array.isArray(x) && x.length > 0 && x.every((y) => typeof y === 'string');
  if (!v || !lista(v.severity) || !lista(v.disposition)) {
    throw new NoMedido('sources.json no declara prune.vocabularies.severity y prune.vocabularies.disposition');
  }
  const maxDias = cfg.prune.max_findings_days;
  // Los nombres de lo que devuelve son internos: si se renombran las claves de sources.json, éstos no cambian.
  return {
    severidad: v.severity,
    disposicion: v.disposition,
    maxDias: Number.isInteger(maxDias) && maxDias >= 1 ? maxDias : null,
  };
}

/** La dirección del remoto `origin`, leída del config de git (sin lanzar git). null si no hay. */
function remotoDe(repo) {
  try {
    const cfg = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(cfg);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

/** La huella opaca de una corrida: igual en todos los clones, sin decir qué repo ni qué story. */
function huellaCorrida(repo, runDir) {
  const base = remotoDe(repo) || `local:${path.basename(repo)}`;
  return `c-${crypto.createHash('sha256').update(`${base}\n${runDir}`).digest('hex').slice(0, 12)}`;
}

/** Los repos bajo la raíz, hasta PROFUNDIDAD niveles. Cuenta lo que no pudo mirar. */
function buscarRepos(raiz, cuenta, reloj) {
  const repos = [];
  const bajar = (dir, nivel) => {
    if (nivel > PROFUNDIDAD) return;
    reloj();
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { cuenta.carpetas_ilegibles += 1; return; }
    for (const e of entradas) {
      if (NO_ENTRAR.has(e.name) || e.name.startsWith('.')) continue;
      // Un enlace no se sigue (puede apuntar a otro repo ya recorrido, o a sí mismo): se cuenta.
      if (e.isSymbolicLink()) { cuenta.enlaces_salteados += 1; continue; }
      if (!e.isDirectory()) continue;
      const ruta = path.join(dir, e.name);
      let git = null;
      try { git = fs.statSync(path.join(ruta, '.git')); }
      catch (err) {
        git = null;
        // En el último nivel no se baja más, así que nadie más va a contar esta carpeta ilegible.
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR' && nivel >= PROFUNDIDAD) cuenta.carpetas_ilegibles += 1;
      }
      if (git) {
        // Un worktree hermano repite las corridas del repo principal: se saltea y se cuenta.
        if (git.isFile() && WORKTREE.test(e.name)) { cuenta.worktrees_salteados += 1; continue; }
        repos.push(ruta);
      }
      // 🔴 Se sigue bajando AUNQUE sea repo: `Acme/` es un contenedor y `Acme/Backend` el repo.
      bajar(ruta, nivel + 1);
    }
  };
  bajar(raiz, 1);
  return repos;
}

/**
 * Las carpetas de corridas de un repo: la suya y la de cada subproyecto de primer nivel (monorepos), con su
 * DUEÑO: un subproyecto que es su propio repo es el dueño de sus corridas (su remoto da la huella).
 */
function carpetasDeCorridas(repo) {
  const dirs = [{ dir: path.join(repo, '.advisors', 'pipeline-runs'), dueno: repo }];
  let hijos = [];
  try { hijos = fs.readdirSync(repo, { withFileTypes: true }); } catch (_) { hijos = []; }
  for (const h of hijos) {
    if (!h.isDirectory() || NO_ENTRAR.has(h.name) || h.name.startsWith('.')) continue;
    const sub = path.join(repo, h.name);
    const d = path.join(sub, '.advisors', 'pipeline-runs');
    if (fs.existsSync(d)) dirs.push({ dir: d, dueno: fs.existsSync(path.join(sub, '.git')) ? sub : repo });
  }
  return dirs;
}

/** El único archivo de hallazgos que cuenta en una corrida (decisión 2). */
function archivoCanonico(archivos) {
  if (archivos.includes('findings.json')) return 'findings.json';
  if (archivos.includes('findings-final.json')) return 'findings-final.json';
  const iters = archivos
    .map((f) => /^findings-iter(\d+)\.json$/.exec(f))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (iters.length) return iters[0][0];
  const otros = archivos.filter((f) => f !== 'findings-input.json').sort();
  return otros.length ? otros[otros.length - 1] : null;
}

/** ¿Corrieron revisores en esta corrida? Carpeta de informes, informes sueltos o el consolidado. */
function huboRevisores(archivos) {
  return archivos.some((f) => f.startsWith('step-05-advisor-reports')
    || /^step-05-.+\.md$/.test(f)
    || f === 'step-06-consolidated-report.md');
}

/**
 * 🔴 LA definición del nombre del sello (la usan la subida, el reductor y la poda a través de
 *    `estadoDeLaSerie`). La serie de la máquina, `hallazgos.jsonl` (no cambia de nombre: viaja al buzón),
 *    lleva `findings-seal.json` al lado; cualquier otra serie, `<serie sin .jsonl>-seal.json`.
 */
function selloDe(salida) {
  if (path.basename(salida) === 'hallazgos.jsonl') return path.join(path.dirname(salida), 'findings-seal.json');
  return `${salida.replace(/\.jsonl$/, '')}-seal.json`;
}
/** El sello que se lee: el nuevo y, si sólo está el de antes del renombre, ése. */
const selloALeer = (salida) => resolveFile(selloDe(salida), { where: DONDE });

/**
 * 🔴 LA definición de «la serie de esta máquina está medida» (decisión 7). Medida = el sello dice que
 *    se recolectó, con al menos un repo, no hace más de `max_findings_days` días, y el archivo existe.
 */
function estadoDeLaSerie({ salida, hoy, fuentes, maxDias: maxDeclarado } = {}) {
  const rutaSalida = salida || variable('TYCON_FINDINGS_OUTPUT') || path.join(casaPipeline(), 'hallazgos.jsonl');
  let elDia;
  try { elDia = dia(hoy); } catch (e) { return { estado: 'no_medido', motivo: e.motivo }; }
  let maxDias = Number.isInteger(maxDeclarado) && maxDeclarado >= 1 ? maxDeclarado : null;
  if (!maxDias) {
    try { maxDias = leerVocabularios(fuentes).maxDias; } catch (e) { return { estado: 'no_medido', motivo: e.motivo }; }
  }
  if (!maxDias) return { estado: 'no_medido', motivo: 'sources.json no declara prune.max_findings_days' };
  let sello;
  try { sello = JSON.parse(fs.readFileSync(selloALeer(rutaSalida), 'utf8')); }
  catch (e) { return { estado: 'no_medido', motivo: e.code === 'ENOENT' ? 'el recolector nunca corrió en esta máquina (sin sello)' : 'el sello del recolector no se puede leer' }; }
  if (sello && sello.estado === 'fallido') return { estado: 'no_medido', motivo: `la última recolección${fechaValida(sello.fecha) ? ` (${sello.fecha})` : ''} falló: no hay serie medida` };
  if (!sello || sello.estado !== 'recolectado') return { estado: 'no_medido', motivo: 'el sello no dice que se haya recolectado' };
  if (!Number.isInteger(sello.repos) || sello.repos < 1) return { estado: 'no_medido', motivo: 'el sello no registra ningún repo recorrido' };
  if (!fechaValida(sello.fecha)) return { estado: 'no_medido', motivo: 'el sello no tiene una fecha legible' };
  const edad = diasEntre(sello.fecha, elDia);
  if (edad > maxDias) return { estado: 'no_medido', motivo: `la serie es del ${sello.fecha}, hace ${edad} días: el recolector dejó de correr` };
  let texto;
  try {
    if (fs.statSync(rutaSalida).size > MAX_SERIE_BYTES) return { estado: 'no_medido', motivo: 'la serie es demasiado grande para leerse' };
    texto = fs.readFileSync(rutaSalida, 'utf8');
  } catch (e) {
    return { estado: 'no_medido', motivo: e.code === 'ENOENT' ? 'el sello existe pero la serie no' : 'la serie no se puede leer' };
  }
  const c = serieCoincide(texto, sello);
  if (!c.ok) return { estado: 'no_medido', motivo: c.motivo };
  return { estado: 'medido', fecha: sello.fecha, sello, serie: c.serie, texto };
}

function recolectar({ raiz, salida, catalogo, revisores, hoy, dryRun, fuentes, budgetMs, historia } = {}) {
  const rutaRaiz = raiz || process.env.TYCON_REPOS_ROOT || null;
  const rutaSalida = salida || variable('TYCON_FINDINGS_OUTPUT') || path.join(casaPipeline(), 'hallazgos.jsonl');
  const rutaHistoria = historia || variable('TYCON_HISTORY_DIR') || path.join(casaPipeline(), 'timing-history');
  // 🔴 Antes de tocar nada: una salida que no es una serie no se pisa ni se BORRA (fallar() borra).
  if (!/\.jsonl$/.test(rutaSalida)) {
    return { estado: 'no_medido', codigo: 2, motivo: 'la salida tiene que ser un archivo .jsonl' };
  }
  const sello = selloDe(rutaSalida);
  const tope = Number.isFinite(budgetMs) ? budgetMs : BUDGET_DEFAULT_MS;
  const inicio = Date.now();

  const fallar = (motivo) => {
    // 🔴 Si no se pudo medir, lo de ayer NO se queda (se subiría como de hoy). Pero una SIMULACIÓN no
    //    toca nada: un --dry-run que fallara borraría la serie real del día.
    if (!dryRun) {
      try { fs.unlinkSync(rutaSalida); } catch (_) { /* no estaba */ }
      // 🔴 El sello con su nombre anterior queda intacto hasta el retiro, y borrar el nuevo lo haría
      //    volver a contestar por la serie (con su fecha vieja). El nuevo queda diciendo que la última falló.
      let fecha = null;
      try { fecha = dia(hoy); } catch (_) { /* sin fecha legible */ }
      try {
        const tmp = `${sello}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, `${JSON.stringify({ estado: 'fallido', fecha }, null, 2)}\n`);
        fs.renameSync(tmp, sello);
      } catch (_) {
        try { fs.unlinkSync(sello); } catch (__) { /* no estaba */ }
      }
    }
    return { estado: 'no_medido', codigo: 2, motivo };
  };

  try {
    const elDia = dia(hoy);
    const vocab = leerVocabularios(fuentes);

    // ¿ya se hizo hoy? (una simulación siempre recorre: su trabajo es mostrar qué pasaría)
    if (!dryRun) {
      try {
        const s = JSON.parse(fs.readFileSync(selloALeer(rutaSalida), 'utf8'));
        if (s && s.estado === 'recolectado' && s.fecha === elDia && fs.existsSync(rutaSalida)) {
          return { ...s, estado: 'ya_recolectado_hoy' };
        }
      } catch (_) { /* primera vez del día */ }
    }

    const cat = catalogoDeReglas.leer({ catalogo, revisores });
    if (cat.estado !== 'medido') throw new NoMedido(`sin catálogo de reglas no se puede resolver el dueño: ${cat.motivo}`);
    const duenosPorRegla = new Map();
    for (const r of cat.lista) {
      if (!r.dueno) continue;
      if (!duenosPorRegla.has(r.regla)) duenosPorRegla.set(r.regla, []);
      duenosPorRegla.get(r.regla).push(r.dueno);
    }

    // todas las carpetas de repos de la máquina (puede haber más de una); declarada a mano, la de la opción o la variable
    let raices = rutaRaiz ? String(rutaRaiz).split(path.delimiter).filter(Boolean) : null;
    let fuenteRaiz = rutaRaiz ? 'declarada' : null;
    if (!raices) {
      try {
        const r = require('../lib/repos-root.js').resolveReposRoot();
        raices = (r && r.roots) || [];
        fuenteRaiz = r && r.fuente;
      } catch (e) { throw new NoMedido(`no pude resolver la raíz de repos (${e.message})`); }
      if (!raices.length) throw new NoMedido('la raíz de repos vino vacía');
    }
    for (const raizReal of raices) {
      try {
        if (!fs.statSync(raizReal).isDirectory()) throw new NoMedido(`la raíz de repos ${raizReal} no es un directorio`);
      } catch (e) {
        if (e instanceof NoMedido) throw e;
        throw new NoMedido(`no pude leer la raíz de repos ${raizReal} (${e.code || e.message})`);
      }
    }

    const reloj = () => {
      if (Date.now() - inicio > tope) throw new NoMedido(`se agotó el tiempo (${tope} ms): una recolección a medias no se sube`);
    };
    const cuenta = { carpetas_ilegibles: 0, worktrees_salteados: 0, enlaces_salteados: 0 };
    const repos = [...new Set(raices.flatMap((r) => buscarRepos(r, cuenta, reloj)))];
    if (repos.length === 0) throw new NoMedido('no encontré ningún repo bajo la raíz (¿raíz equivocada?)');

    const baldes = Object.fromEntries(BALDES.map((b) => [b, 0]));
    const indice = new Map();      // carpeta que tiene `.advisors` → [{ nombre, instante, medida }]
    const vistas = new Map();      // huella → balde de su primera copia: un segundo clon cae en `repetida`
    const recorridas = new Set();  // carpetas de corridas ya leídas (un subproyecto-repo aparece dos veces)
    // Una corrida que ya se vio en otra copia es `repetida`, en CUALQUIER balde. Si la copia anterior no se
    // pudo leer y ésta sí, ésta pasa a ser la que cuenta y la anterior se vuelve la repetida.
    const MEDIDOS = new Set(['con_hallazgos', 'revisado_sin_hallazgos']);
    const contar = (corrida, balde) => {
      const previo = vistas.get(corrida);
      if (previo === undefined) { vistas.set(corrida, balde); baldes[balde] += 1; return true; }
      if (MEDIDOS.has(balde) && !MEDIDOS.has(previo)) {
        baldes[previo] -= 1; baldes.repetida += 1;
        vistas.set(corrida, balde); baldes[balde] += 1;
        return true;
      }
      baldes.repetida += 1;
      return false;
    };
    const items = { fuera_de_catalogo: 0, ambiguos: 0, elementos_sin_regla: 0, elementos_otro_esquema: 0, archivos_ilegibles: 0, copias_ignoradas: 0 };
    const lineas = [];
    let runDirs = 0;

    for (const repo of repos) {
      for (const { dir: base, dueno: duenoCorridas } of carpetasDeCorridas(repo)) {
        reloj();
        let baseReal = base;
        try { baseReal = fs.realpathSync(base); } catch (_) { /* se usa tal cual */ }
        if (recorridas.has(baseReal)) continue;
        recorridas.add(baseReal);
        // El índice es por la carpeta que TIENE `.advisors` (el repo, o el subproyecto de un monorepo).
        let conAdvisors = path.dirname(path.dirname(base));
        try { conAdvisors = fs.realpathSync(conAdvisors); } catch (_) { /* se usa tal cual */ }
        if (!indice.has(conAdvisors)) indice.set(conAdvisors, []);
        const delRepo = indice.get(conAdvisors);
        let corridas;
        try { corridas = fs.readdirSync(base, { withFileTypes: true }); }
        catch (e) { if (e.code !== 'ENOENT') cuenta.carpetas_ilegibles += 1; continue; }
        for (const c of corridas) {
          if (!c.isDirectory()) continue;
          runDirs += 1;
          // Toda corrida entra al índice; `medida` queda null salvo que su archivo se haya LEÍDO.
          const entrada = { nombre: c.name, instante: instanteDeRunDir(c.name), medida: null };
          delRepo.push(entrada);
          const corrida = huellaCorrida(duenoCorridas, c.name);
          const dirCorrida = path.join(base, c.name);
          let archivos;
          try { archivos = fs.readdirSync(dirCorrida); }
          catch (_) { contar(corrida, 'ilegible'); cuenta.carpetas_ilegibles += 1; continue; }

          const ts = tsDeRunDir(c.name);
          if (!ts) { contar(corrida, 'sin_fecha'); continue; }

          const deHallazgos = archivos.filter((f) => /^findings.*\.json$/.test(f));
          const canonico = archivoCanonico(deHallazgos);
          items.copias_ignoradas += deHallazgos.length - (canonico ? 1 : 0);
          if (!canonico) {
            contar(corrida, huboRevisores(archivos) ? 'sin_evidencia' : 'sin_nada');
            continue;
          }

          let crudo;
          try {
            const ruta = path.join(dirCorrida, canonico);
            if (fs.statSync(ruta).size > MAX_BYTES) throw new Error('grande');
            crudo = JSON.parse(fs.readFileSync(ruta, 'utf8'));
          } catch (_) { items.archivos_ilegibles += 1; contar(corrida, 'ilegible'); continue; }

          if (!Array.isArray(crudo)) { contar(corrida, 'otro_esquema'); continue; }
          const medida = crudo.length === 0 ? 'revisado_sin_hallazgos' : 'con_hallazgos';
          entrada.medida = medida;
          if (!contar(corrida, medida)) continue;
          if (crudo.length === 0) continue;

          for (const h of crudo) {
            // Un elemento que no es un objeto es de OTRO esquema, no «sin regla».
            if (!h || typeof h !== 'object' || Array.isArray(h)) { items.elementos_otro_esquema += 1; continue; }
            if (typeof h.rule_id !== 'string') {
              // Un tercer esquema existe (`ruleId`, `resolved`): no se traduce inventando la disposición.
              if (typeof h.ruleId === 'string') items.elementos_otro_esquema += 1; else items.elementos_sin_regla += 1;
              continue;
            }
            const duenos = duenosPorRegla.get(h.rule_id);
            if (!duenos) { items.fuera_de_catalogo += 1; continue; }
            let dueno = duenos[0];
            if (duenos.length > 1) {
              // Identificador con dos dueños (SEC-C1/SEC-C2): se atribuye sólo si el `advisor` declarado
              // coincide con uno de ellos; si no, se cuenta como ambiguo y NO se inventa.
              const decl = typeof h.advisor === 'string' ? h.advisor : null;
              if (!decl || !duenos.includes(decl)) { items.ambiguos += 1; continue; }
              dueno = decl;
            }
            lineas.push(JSON.stringify({
              ts,
              corrida,
              regla: h.rule_id,
              dueno,
              severidad: enLista(h.severity, vocab.severidad),
              disposicion: enLista(h.disposition, vocab.disposicion),
            }));
          }
        }
      }
    }

    // ── qué volcados de esta máquina corresponden a una corrida leída (decisión 8) ──
    const volcados = Object.fromEntries(VOLCADOS.map((v) => [v, 0]));
    let nombresVolcados = [];
    try { nombresVolcados = fs.readdirSync(rutaHistoria).filter((f) => f.endsWith('.json')).sort(); }
    catch (e) { if (e.code !== 'ENOENT') cuenta.carpetas_ilegibles += 1; }
    for (const nombre of nombresVolcados) {
      reloj();
      volcados.leidos += 1;
      let d;
      try {
        const ruta = path.join(rutaHistoria, nombre);
        if (!FORMA_VOLCADO.test(nombre) || fs.statSync(ruta).size > MAX_VOLCADO_BYTES) throw new Error('forma');
        d = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      } catch (_) { volcados.ilegibles += 1; continue; }
      const m = d && d.marker;
      const inicio = m && Date.parse(m.startedAt);
      const fines = [m && Date.parse(m.lastTouch), Date.parse(d && d.archivedAt)].filter(Number.isFinite);
      if (!m || typeof m.storyId !== 'string' || !m.storyId || typeof m.repoPath !== 'string'
        || !Number.isFinite(inicio) || fines.length === 0) { volcados.ilegibles += 1; continue; }
      let repoReal;
      try { repoReal = fs.realpathSync(m.repoPath); } catch (_) { volcados.sin_repo += 1; continue; }
      const desde = inicio - MARGEN_SESION_MS;
      const hasta = Math.max(...fines) + MARGEN_SESION_MS;
      const candidatas = (indice.get(repoReal) || []).filter((r) => esCorridaDe(r.nombre, m.storyId)
        && r.instante !== null && r.instante >= desde && r.instante <= hasta);
      const leida = candidatas.find((r) => r.medida === 'con_hallazgos') || candidatas.find((r) => r.medida);
      if (leida) {
        volcados.medidos += 1;
        lineas.push(JSON.stringify({ volcado: nombre, medida: leida.medida }));
      } else if (candidatas.length) {
        volcados.sin_hallazgos_legibles += 1;   // la corrida está, pero su archivo no se pudo leer
      } else {
        volcados.sin_corrida += 1;              // ninguna carpeta de esa story dentro de la sesión
      }
    }

    const resumen = {
      estado: 'recolectado',
      fecha: elDia,
      repos: repos.length,
      profundidad: PROFUNDIDAD,
      raiz_fuente: fuenteRaiz,
      run_dirs: runDirs,
      hallazgos: lineas.length - volcados.medidos,
      baldes,
      volcados,
      ...items,
      ...cuenta,
      // Alias planos, para quien lee los conteos de a uno (tablero, subida).
      con_hallazgos: baldes.con_hallazgos,
      revisado_sin_hallazgos: baldes.revisado_sin_hallazgos,
      sin_evidencia: baldes.sin_evidencia,
      otro_esquema: baldes.otro_esquema,
      sin_fecha: baldes.sin_fecha,
      ilegibles: baldes.ilegible,
    };

    if (dryRun) return { ...resumen, estado: 'simulado' };

    // 🔴 Atómico, y la serie ANTES que el sello: quien lea en el medio ve una serie que no coincide con su
    //    sello y la da por no medida, nunca «medida con cero».
    fs.mkdirSync(path.dirname(rutaSalida), { recursive: true });
    // Antes de escribir nada: si sólo está el sello de antes del renombre, pasa al nuevo (si eso falla,
    // lanza y no se escribe ni la serie: el catch lo da por no medido).
    prepareStateWrite(sello, { where: DONDE });
    const escribir = (ruta, texto) => {
      const tmp = `${ruta}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, texto, 'utf8');
      fs.renameSync(tmp, ruta);
    };
    escribir(rutaSalida, lineas.length ? `${lineas.join('\n')}\n` : '');
    escribir(sello, `${JSON.stringify(resumen, null, 2)}\n`);
    return resumen;
  } catch (e) {
    if (e instanceof NoMedido) return fallar(e.motivo);
    return fallar(`error inesperado del recolector: ${e.message}`);
  }
}

// ───────────────────────────────── CLI ─────────────────────────────────

function valor(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

function main() {
  const budget = valor('--budget-ms', undefined);
  const res = recolectar({
    raiz: valor('--root', null),
    salida: valor('--output', null),
    catalogo: valor('--catalog', null),
    revisores: valor('--reviewers', null),
    fuentes: valor('--sources', null),
    hoy: valor('--today', null),
    budgetMs: budget !== undefined ? Number(budget) : undefined,
    historia: valor('--history', null),
    dryRun: process.argv.includes('--dry-run'),
  });

  if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2));

  if (res.estado === 'no_medido') {
    console.error(`recolectar-hallazgos: ${res.motivo}`);
    process.exitCode = res.codigo || 2;
    return;
  }
  if (!process.argv.includes('--json')) {
    console.log(`${res.estado} · ${res.hallazgos} hallazgo(s) de ${res.repos} repo(s), ${res.run_dirs} corrida(s)`);
    console.log(`  baldes: ${Object.entries(res.baldes).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`  fuera de catálogo ${res.fuera_de_catalogo} · ambiguos ${res.ambiguos} · sin regla ${res.elementos_sin_regla} · copias ignoradas ${res.copias_ignoradas} · carpetas ilegibles ${res.carpetas_ilegibles}`);
    if (res.volcados) console.log(`  corridas del registro: ${Object.entries(res.volcados).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }
  process.exitCode = 0;
}

if (require.main === module) {
  require('../lib/legacy-names.js').aliasArgv('scripts/metrics/collect-findings.js', { exitCode: 2, prefix: 'recolectar-hallazgos: ' });
  main();
}
module.exports = {
  recolectar, estadoDeLaSerie, leerVocabularios, esCorridaDe, tsDeRunDir, huellaCorrida, archivoCanonico, NoMedido,
  formaDeLinea, leerSerie, serieCoincide, conteosDelSello, instanteDeRunDir, FORMA_CORRIDA, FORMA_VOLCADO,
  selloDe,
};
