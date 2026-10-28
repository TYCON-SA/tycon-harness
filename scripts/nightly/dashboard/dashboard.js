#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * dashboard.js — EL LECTOR DEL TABLERO
 *
 * El arnés mide mucho: los nocturnos dejan una serie diaria en git. Esto es la mitad que mira: lee
 * lo que dejan y lo muestra en un tablero.
 *
 * 🔴 LAS TRES REGLAS QUE LO GOBIERNAN (si se rompe alguna, el tablero deja de servir):
 *
 *   1. «No medido» NUNCA es «verde» y NUNCA es cero. Hay CUATRO estados, y el gris es el default:
 *      una métrica que no dijo explícitamente que fue medida nace gris. Con tres colores, "no sé"
 *      se disfraza de alguno de los tres — y siempre se disfraza del más barato.
 *   2. Ningún número sin su denominador AL LADO (no en un globito). Un promedio sin `n`
 *      esconde si sale de 32 archivos o de 125.
 *   3. Se recorre la LISTA DE FUENTES ESPERADAS (sources.json), nunca el directorio. Un `readdir`
 *      sólo puede encontrar lo que está; la lista es lo único que detecta una AUSENCIA. Y un dato
 *      más viejo que su umbral se pinta gris y SE LE CALLA EL NÚMERO — no se tacha, se borra.
 *
 * Contrato de salida (regla de la casa):
 *   exit 0 → MIDIÓ, aunque haya rojos. El rojo se cobra en el tablero, no en el código de salida.
 *   exit 2 → NO PUDO medir una fuente obligatoria.
 *   exit 3 → NO PUDO escribir la página.
 *   exit 1 → error de uso.
 *
 * Uso:
 *   node scripts/nightly/dashboard/dashboard.js                 # en una máquina: genera ~/.claude/.tycon-pipeline/tablero-del-arnes.html
 *   node scripts/nightly/dashboard/dashboard.js --nightly --mailbox <dir> --mailbox-state <json>
 *                                                               # el nocturno de Azure: genera artifacts/tablero-del-arnes.html
 *   node scripts/nightly/dashboard/dashboard.js --dry-run       # mide e imprime, NO escribe
 *   node scripts/nightly/dashboard/dashboard.js --json          # el modelo de vista, para otra pieza
 *   node scripts/nightly/dashboard/dashboard.js --output <ruta>
 *   node scripts/nightly/dashboard/dashboard.js --logs <dir>    # la carpeta de registros de la máquina (default ~/.claude/.tycon-pipeline)
 *   node scripts/nightly/dashboard/dashboard.js --view runs [--runs-dir <dir>]   # la vista de corridas → ~/.claude/.tycon-pipeline/runs-dashboard.html (no se commitea)
 *     [--mailbox <dir>] [--local-only]  # con la carpeta bajada del buzón lee las corridas de todas las máquinas y escribe en <carpeta>/runs-dashboard.html; --local-only = sólo las corridas de esta máquina. Nunca escribe en el repo
 *
 * 🔴 UN SOLO ESCRITOR. La página del repo la escribe el nocturno (`pipelines/azure-pipelines-tablero.yml`), con
 *    `--nightly`: el agente de Azure no es una máquina del equipo, así que las fichas que leen el disco de una
 *    máquina dicen «no aplica en el nocturno», las del equipo salen sólo del buzón bajado, y si la bajada no terminó
 *    completa lo dicen sin número. Sin `--nightly` (una máquina) la página va a la carpeta personal y se NIEGA a
 *    escribirse dentro del repo: mezclaría el disco de una máquina con los datos del equipo. La página trae adentro un
 *    sello con su fecha, su snapshot y si salió completa (`seal.js`), que verifican el pipeline y el aviso de arranque.
 */

const fs = require('fs');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { execSync } = require('child_process');
const { medida, noMedida, ratio, mediana, pct, num1, edadDias, edadTexto, esc, juzgar, chip, ficha, CSS_BASE, CSS_CHIPS } = require('./common');
const { readEnv } = require('../../lib/legacy-names.js');
const { constancia } = require('../../lib/merge-metrics.js');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const CONFIG = path.join(__dirname, 'sources.json');
const SALIDA_DEFAULT = path.join(RAIZ, 'artifacts', 'tablero-del-arnes.html');
const SALIDA_LOCAL_DEFAULT = path.join(stateDirOf(require('os').homedir()), 'tablero-del-arnes.html');

// Los nombres viejos de las opciones se traducen ANTES de leer argv: éste lo lee al cargar.
if (require.main === module) require('../../lib/legacy-names.js').aliasArgv('scripts/nightly/dashboard/dashboard.js', { exitCode: 1 });
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valor = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
/**
 * Lo que decide de dónde y cómo se mide: carpeta de las fotos, modo, buzón y registros. Sale de los argumentos de la línea de
 * órdenes y `colectar(opts)` lo sobreescribe mientras mide (el sitio llama al mismo cálculo con su copia de
 * operaciones y el espejo de su buzón, sin pasar por argv).
 */
const AMB_ARGV = {
  nocturno: flag('--nightly'),
  mailbox: valor('--mailbox', null),
  mailboxState: valor('--mailbox-state', null),
  logs: valor('--logs', null),
  runsDir: valor('--runs-dir', undefined),
  config: CONFIG,
  raiz: RAIZ,   // de dónde salen repos.json, pipeline-debt.json, declared.json y lane-hypothesis.json (el sitio pasa su copia de operaciones)
  // el examen y los casos del banco para la poda: el sitio pasa los de su copia de operaciones si los trae; sin ellos, los
  // de siempre
  examen: undefined,
  casos: undefined,
  hoy: null,
  // `--now <milisegundos>`: el instante contra el que se mide la frescura de cada fuente. Existe para PROBAR, como
  // `--dir`: con `TYCON_TODAY` fijo y el reloj real, una foto de juguete se vuelve vieja sola al pasar los días
  ahora: Number.isFinite(Number(valor('--now', ''))) && valor('--now', '') !== '' ? Number(valor('--now', '')) : null,
};
let AMB = { ...AMB_ARGV };
/**
 * El día de la página (AAAA-MM-DD, UTC): `TYCON_TODAY` si es una fecha, si no el reloj. Es el que
 * usa el reductor, y así las pruebas fijan el mes en curso, el vencimiento de la observación y la ventana del equipo.
 */
function hoyUTC() {
  if (AMB.hoy) return AMB.hoy;
  const h = readEnv('TYCON_TODAY', { where: 'scripts/nightly/dashboard/dashboard.js' });
  return typeof h === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h) && !Number.isNaN(Date.parse(`${h}T00:00:00Z`)) ? h : new Date().toISOString().slice(0, 10);
}

// `--dir` existe para poder PROBAR el camino gris: sin él, el único escenario que importa
// (una fuente ausente o vieja) sólo se podría verificar rompiendo el repo de verdad.
AMB_ARGV.dashboard = path.resolve(valor('--dir', path.join(RAIZ, '.dashboard')));
AMB.dashboard = AMB_ARGV.dashboard;

// ───────────────────────────── utilidades honestas ─────────────────────────────

function fechaDelNombre(f) { const m = f.match(/(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; }

// ───────────────────────────── el colector ─────────────────────────────

function leerFuente(f) {
  const dir = path.join(AMB.dashboard, f.dir === '.' ? '' : f.dir);
  let archivos = [];
  try {
    const rx = new RegExp('^' + f.pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$');
    archivos = fs.readdirSync(dir).filter((n) => rx.test(n)).sort();
  } catch (e) {
    // 🔴 El error se DICE —tapar el error convierte "no pude preguntar" en "pregunté y no hay", la mentira más barata
    //    de producir y la más cara de detectar—, pero por la fuente y su carpeta RELATIVA y con el código del error:
    //    la ruta absoluta trae el disco de quien la generó, y la página se publica.
    return { ...f, leida: false, motivo: `no se pudo leer la carpeta de la fuente «${f.id}» (${f.dir}): ${e.code === 'ENOENT' ? 'no existe' : (e.code || e.name || 'error')}`, archivos: 0 };
  }
  if (archivos.length === 0) {
    return { ...f, leida: false, motivo: `no hay ningún archivo que cumpla "${f.pattern}" en ${f.dir}`, archivos: 0 };
  }
  const ultimo = archivos[archivos.length - 1];
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(path.join(dir, ultimo), 'utf8')); }
  catch (e) { return { ...f, leida: false, motivo: `el último archivo (${ultimo}) es ilegible: ${e instanceof SyntaxError ? 'no es JSON válido' : (e.code || e.name || 'error')}`, archivos: archivos.length }; }
  return {
    ...f, leida: true, motivo: null, archivos: archivos.length, ultimoArchivo: ultimo,
    fechas: archivos.map(fechaDelNombre).filter(Boolean),
    ts: doc.generated_at || doc.ts || doc.generado || doc.fecha || fechaDelNombre(ultimo), doc,
  };
}

function colectar(opts = {}) {
  const previo = AMB;
  AMB = { ...AMB_ARGV, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  if (opts.dir) AMB.dashboard = path.resolve(opts.dir);
  try { return colectarAhora(); } finally { AMB = previo; }
}

// Una carpeta de la familia del capturador que no se puede leer no es una carpeta vacía: la ficha sale «no medido» con
// la carpeta (relativa a .dashboard, nunca la ruta del disco) y el código del error.
function noSeLeyo(ilegibles) {
  const d = (ilegibles || [])[0];
  if (d) throw new Error(`la carpeta ${path.relative(AMB.dashboard, d.dir) || '.'} no se puede leer (${d.code})`);
}

function colectarAhora() {
  const hoy = Number.isFinite(AMB.ahora) ? AMB.ahora : Date.now();
  const cfg = JSON.parse(fs.readFileSync(AMB.config, 'utf8'));
  // Las fuentes `local: true` son de la vista de corridas: viven fuera de .dashboard y
  // las lee runs.js. Acá se saltean; si no, la de seis preguntas las listaría como «no leída».
  const fuentes = cfg.sources.filter((f) => !f.local).map(leerFuente).map((f) => {
    const d = f.leida ? edadDias(f.ts, hoy) : null;
    // INV-8: pasado el umbral, la fuente deja de ser vigente y sus valores NO se emiten.
    const vigente = f.leida && d !== null && d <= f.max_age_days;
    // una fuente con constancia (`receipt`: la bajada que la trae) vale sólo con la bajada completa y al día; se mira
    // también sin archivos leídos, para que el motivo sea el de la bajada y no un «no leída» a secas
    const c = f.receipt ? constancia(path.join(AMB.dashboard, f.dir || '.'), hoy) : null;
    if (c && !c.al_dia) return { ...f, edad_dias: d, vigente: false, motivo: `no medido: la bajada de los merges de las máquinas no está al día — ${c.motivo}` };
    return { ...f, edad_dias: d, vigente, motivo: f.motivo || (f.leida && !vigente ? `sin medición desde ${(f.ts || '').slice(0, 10)} (${edadTexto(d)})` : null) };
  });
  const por = Object.fromEntries(fuentes.map((f) => [f.id, f]));
  const faltantes = fuentes.filter((f) => f.required && !f.vigente);

  const ctx = contexto();
  const buzon = !AMB.nocturno ? { estado: 'no_aplica' }
    : !AMB.mailbox ? { estado: 'no_leido', motivo: 'no se le pasó la carpeta del buzón (--mailbox)' }
      : (AMB.estadoBuzon || estadoDelBuzon(AMB.mailboxState));
  const eq = equipo(cfg, buzon);
  const L = { ...local(buzon), ...localExtra(ctx, por, cfg), ...eq, pasos: pasosPorCorrida(cfg, buzon) };
  // en el nocturno la duración de la suite sale de los registros de todas las máquinas (el reductor); en una
  // máquina, de su propio gates.log, con la misma lectura de la línea
  if (AMB.nocturno) L.gates_dur = eq.suite_duracion;
  const paneles = { corriendo: fuentes.map(fuenteParaSalida), encuentra: encuentra(por), mejora: mejora(por), local: L, extra: extra(por, ctx, cfg), poda: podaPanel(buzon) };
  return { hoy, cfg, fuentes, por, faltantes, paneles, cobertura: cobertura(fuentes), buzon };
}

// La configuración se lee con sus claves en inglés; la salida `--json` conserva los
// nombres en castellano: el panel `corriendo` copia cada fuente declarada y los mapea acá.
const CLAVES_SALIDA_FUENTE = { title: 'titulo', pattern: 'patron', required: 'obligatoria', max_age_days: 'max_edad_dias', written_by: 'escrito_por', _note: '_nota' };
function fuenteParaSalida(f) {
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [CLAVES_SALIDA_FUENTE[k] || k, v]));
}

function cobertura(fuentes) {
  return { esperadas: fuentes.length, encontradas: fuentes.filter((f) => f.leida).length, vigentes: fuentes.filter((f) => f.vigente).length };
}

/** Sólo emite si la fuente está vigente. Si no, devuelve el gris con su motivo. */
function desde(f, fn) {
  if (!f) return noMedida('la fuente no está declarada');
  if (!f.leida) return noMedida(f.motivo);
  if (!f.vigente) return noMedida(f.motivo);
  try { return fn(f.doc, f); } catch (e) { return noMedida(`el dato existe pero no tiene la forma esperada: ${e.message}`); }
}

function encuentra(por) {
  const m = {};
  m.banco_rojos = desde(por.banco, (d) => medida(d.failed, d.ran, d.ran, { unidad: 'conteo', den_etiqueta: 'casos', detalle: `${d.skipped} salteados · ${d.nomedido} no medidos` }));
  m.banco_regresiones = desde(por.banco, (d) => medida(d.baselineRegressions, d.ran, d.ran, { unidad: 'conteo', den_etiqueta: 'casos' }));
  m.banco_paridad = desde(por.banco, (d) => medida(d.parityBreaks, d.ran, d.ran, { unidad: 'conteo', den_etiqueta: 'casos' }));
  m.suites = desde(por.suites, (d) => {
    // Las rojas se cuentan aunque falte alguna, y la ficha dice cuáles faltan. Una
    // sola regla para todo reporte: `failures` menos `unmeasured` (suites-report.js). Si no, una sola suite sin medir
    // pondría la ficha gris y escondería las rojas que el aviso de arranque sí muestra.
    const failures = Array.isArray(d.failures) ? d.failures : [];
    const corridas = Number(d.corridas);
    const conLista = Array.isArray(d.unmeasured);
    // Incompleta y sin decir qué falta: no se sabe qué restar.
    if (d.complete === false && !conLista) return noMedida('el reporte dice que la noche quedó incompleta pero no dice qué suites faltan');
    const sinMedir = conLista ? d.unmeasured : [];
    const marca = (n) => String(n).replace(/\s*\(no-medida\)$/, '');
    // `corridas` es lo que dice `ran` (las suites que ARRANCARON): una suite cortada a mitad de camino está adentro, y
    // la de un trabajo que murió antes de arrancarla, no (suites-shard.js `readShard`). Con la lista `ran` en el reporte
    // se resta sólo lo que está adentro y el total suma lo que nunca arrancó; sin la lista (un reporte antiguo),
    // se toma que todas están adentro. Restarlas dos veces encogería el denominador y, con medio nocturno
    // caído, diría «ninguna suite se midió» escondiendo las rojas.
    const ran = Array.isArray(d.ran) ? new Set(d.ran.map(String)) : null;
    const adentro = ran ? sinMedir.filter((n) => ran.has(marca(n))).length : sinMedir.length;
    const total = Number.isFinite(corridas) ? corridas + (sinMedir.length - adentro) : NaN;
    const medidas = Number.isFinite(corridas) ? corridas - adentro : NaN;
    if (!Number.isFinite(corridas) || corridas <= 0 || medidas <= 0) return noMedida('ninguna suite se midió esta noche');
    const rojas = failures.filter((f) => !sinMedir.includes(f)).length;
    const otroLado = d.measuredElsewhere && typeof d.measuredElsewhere === 'object' && !Array.isArray(d.measuredElsewhere) ? Object.entries(d.measuredElsewhere) : [];
    const detalle = [
      sinMedir.length ? `${sinMedir.length} sin medir: ${sinMedir.map(marca).join(', ')}` : null,
      otroLado.length ? `${otroLado.length} se mide en otro lado: ${otroLado.map(([n, por]) => `${n} — ${por}`).join(' · ')}` : null,
      typeof d.measuredElsewhereProblem === 'string' && d.measuredElsewhereProblem ? d.measuredElsewhereProblem : null,
    ].filter(Boolean).join(' · ');
    return medida(rojas, medidas, total, { unidad: 'conteo', den_etiqueta: 'suites', ...(detalle ? { detalle } : {}) });
  });
  m.deps_hallazgos = desde(por.dependencias, (d) => {
    if (d.corrida_completa === false) return noMedida(`la ejecución quedó incompleta: ${(d.no_medidos || []).length} repos sin medir`);
    return medida((d.hallazgos || []).length, d.repos_activos, d.repos_activos, { unidad: 'conteo', den_etiqueta: 'repos' });
  });
  m.vigilante = desde(por.vigilante, (d) => {
    const productos = Object.keys(d.productos || {});
    const ok = productos.filter((p) => d.productos[p] && d.productos[p].ok).length;
    if (ok === 0) return noMedida('ningún producto pudo medirse esta noche');
    return medida((d.hallazgos || []).length, ok, productos.length, { unidad: 'conteo', den_etiqueta: 'productos vigilados', detalle: `${d.nuevos === undefined || d.nuevos === null ? '?' : d.nuevos} nuevos · ${d.repetidos === undefined || d.repetidos === null ? '?' : d.repetidos} repetidos` });
  });
  return m;
}

function mejora(por) {
  const m = {};
  m.lead_time = desde(por['sdlc-stage'], (d) => {
    const l = d.global && d.global.lead_time_days;
    if (!l || !Number.isFinite(l.median)) return noMedida('el snapshot no trae la mediana');
    return medida(l.median, l.n, l.n, { unidad: 'dias', den_etiqueta: 'stories cerradas', detalle: `media ${num1(l.mean)} · máx ${num1(l.max)}` });
  });
  const r = (campo) => desde(por['sdlc-stage'], (d) => {
    const x = d.global && d.global[campo];
    if (!x || !Number.isFinite(x.num) || !Number.isFinite(x.den)) return noMedida('el snapshot no trae numerador y denominador');
    return { ...ratio(x.num, x.den), den_etiqueta: 'stories' };
  });
  m.dod = r('dod_evidence_ratio');
  // Las exentas por declaración NO están en el cociente: se dicen al lado, con su número,
  // para que un salto en la serie se lea como cambio de conteo y no como stories que ganaron prueba.
  const exDod = por['sdlc-stage'] && por['sdlc-stage'].vigente && ((por['sdlc-stage'].doc.global || {}).dod_evidence_ratio || {}).exentas;
  if (m.dod && m.dod.estado === 'medido' && Number.isFinite(exDod) && exDod > 0) {
    m.dod.detalle = `además ${exDod} cerrada${exDod === 1 ? '' : 's'} con exención declarada (dod_runtime_exempt) — fuera del cociente: una exención dice que NO hay prueba`;
  }
  m.rework = r('rework_ratio');
  m.first_pass = r('first_pass_ratio');
  m.repos = desde(por['sdlc-stage'], (d) => {
    const rs = d.repos || [];
    const sin = rs.filter((x) => (x.not_measured || []).length > 0).length;
    return medida(rs.length - sin, rs.length - sin, rs.length, { unidad: 'conteo', den_etiqueta: 'repos', detalle: sin ? `${sin} con algo sin medir` : 'todos medidos' });
  });

  // La familia del capturador: se reusa loadAll, no se reimplementa el parser. Lo versionado en la raíz y lo que el
  // nocturno baja del buzón a merges/, con un registro por merge (el mismo merge en las dos cuenta una vez).
  try {
    const dm = require(path.join(RAIZ, 'scripts', 'lib', 'dashboard-metrics.js'));
    const { records, counts, unreadableDirs } = dm.loadPorMerge([AMB.dashboard]);
    noSeLeyo(unreadableDirs);
    m._capturer_cobertura = counts;
    m._capturer_fechas = records.filter((x) => x.date).length;
    m.revisores = {};
    for (const [clave, def] of Object.entries(dm.METRICS)) {
      const vals = records.map((x) => x.values && x.values[clave]).filter((v) => typeof v === 'number' && isFinite(v));
      m.revisores[clave] = vals.length === 0
        ? noMedida('ningún registro trae un valor utilizable para esta métrica')
        // 🔴 La MEDIANA de un ratio no es un ratio: su denominador es "cuántos registros la traen",
        //    no un numerador sobre un total. Mostrarla como "16 de 125" sería la mentira M-10.
        : medida(mediana(vals), vals.length, records.length,
            { unidad: 'conteo', den_etiqueta: 'registros', formato: def.kind === 'ratio' ? 'ratio' : 'num',
              etiqueta: def.label, rango: [Math.min(...vals), Math.max(...vals)] });
    }
  } catch (e) {
    m.revisores = { _error: noMedida(`no se pudo cargar la familia del capturador: ${e.message}`) };
  }
  return m;
}


// ─────────────── el nocturno: el buzón y lo que no aplica ───────────────
// 🔴 El motivo crudo de la bajada NUNCA llega a la página: trae nombres de blob, y el nombre de una máquina suele ser el
//    de su dueño. Sale de esta lista cerrada, por estado de `download-runs.js`.
const MOTIVOS_BUZON = {
  sin_az: 'no hay az en el agente del nocturno',
  sin_sesion: 'la conexión a Azure del nocturno no dio una sesión',
  sin_permiso: 'la identidad del nocturno no tiene el rol de lectura del buzón',
  sin_permiso_a_mitad: 'el buzón dejó listar pero no leer',
  sin_red: 'sin red o sin respuesta del buzón',
  sin_contenedor: 'el contenedor del buzón no existe',
  servicio_fallo: 'el servicio del buzón falló',
  parcial: 'la bajada del buzón quedó incompleta',
  sin_tiempo: 'la bajada del buzón se quedó sin tiempo',
  sin_config: 'falta la configuración del buzón',
  config_ilegible: 'la configuración del buzón es ilegible',
};
/**
 * ¿El nocturno leyó el buzón entero? Lo decide `download-runs.js` (`completo`, un solo criterio) y acá sólo se
 * exige además que haya salido 0. Todo lo demás es «no leído»: contar la mitad de las máquinas como el equipo es
 * exactamente lo que la página existe para no hacer.
 */
function estadoDelBuzon(ruta) {
  const no = (motivo) => ({ estado: 'no_leido', motivo });
  if (!ruta) return no('la bajada del buzón no dejó su resultado');
  let r;
  try { r = JSON.parse(fs.readFileSync(ruta, 'utf8')); }
  catch (e) { return no(e.code === 'ENOENT' ? 'la bajada del buzón no dejó su resultado (¿falló la conexión a Azure?)' : 'el resultado de la bajada del buzón es ilegible'); }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return no('el resultado de la bajada del buzón es ilegible');
  if (r.completo === true && r.codigo === 0) return { estado: 'leido' };
  const est = typeof r.estado === 'string' ? r.estado : '';
  if (Number(r.sin_tiempo) > 0) return no(MOTIVOS_BUZON.sin_tiempo);
  if (est === 'bajado' || est === 'al_dia') return no('la bajada del buzón no dice que terminó completa');
  return no(Object.prototype.hasOwnProperty.call(MOTIVOS_BUZON, est) ? MOTIVOS_BUZON[est] : 'la bajada del buzón terminó en un estado desconocido');
}
const noAplica = (que) => noMedida(`no aplica en el nocturno: la página la genera Azure DevOps, que no es una máquina del equipo — ${que}`);
const noLeido = (buzon) => noMedida(`el nocturno no pudo leer el buzón (${buzon.motivo})`);

// ─────────────── el anillo local: lo que sólo existe en la máquina del dev ───────────────
// 🔴 Sale AGREGADO y por LISTA BLANCA: sólo conteos y medianas. Nunca un comando, nunca una ruta,
//    nunca un nombre de repo o de story, nunca un prompt. Lo que no está nombrado acá no existe
//    para este lector — una lista negra fallaría con el primer campo que nadie previó.
// 🔴 Y se rotula SIEMPRE como "en esta máquina": presentarlo como el equipo sería la mentira de
//    la máquina que no reportó leída como cero.
const HOME_TYCON = path.join(require('os').homedir(), '.claude');

// Contador explícito. El idioma habitual para acumular usa el mismo atajo que convierte un dato
// ausente en un cero, y un chequeo textual no puede distinguirlos. Un control que hay que aflojar
// para que pase deja de ser un control: el que se cambia es el código, no el chequeo.
const inc = (o, k) => { if (!Object.prototype.hasOwnProperty.call(o, k)) o[k] = 0; o[k] += 1; };

function leerJsonl(ruta, max) {
  const txt = fs.readFileSync(ruta, 'utf8');
  const out = [];
  for (const linea of txt.split('\n')) {
    const t = linea.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (e) { /* la línea rota se cuenta abajo, no se ignora */ out.push(null); }
    if (max && out.length >= max) break;
  }
  return out;
}

/**
 * La lectura de las corridas archivadas: la página de una máquina la usa sobre su `timing-history/`
 * y el nocturno sobre los volcados del buzón. UNA sola lectura, así la misma corrida da el mismo número en las dos.
 * `archivos`: rutas, o `{ ruta, grupo }` (el grupo es la máquina, para el denominador «de M máquinas»). Del volcado salen
 * sólo el inicio y el último toque del marcador, `costo.spawns`, `costo.iteraciones` y los tiempos de los pasos: ni la
 * story, ni la ruta, ni nada más. Un JSON sano sin `marker` (la cobertura que sube cada máquina) no es una corrida; uno
 * que no se puede leer puede serlo: cuenta en el denominador y no en la mediana, y el detalle lo dice.
 * `opts`: `vacio` (el motivo sin ninguna corrida) y `etiqueta(grupos)` (el denominador).
 */
function leerCorridas(archivos, opts = {}) {
  const etiqueta = opts.etiqueta || (() => 'ejecuciones');
  const dur = [], spawns = [], iters = [], trab = [], esp = [];
  const grupos = new Set();
  let ultima = null, tiempos = null, sinTiempos = null, total = 0, ilegibles = 0;
  try { tiempos = require('../../metrics/step-times.js'); }
  // el código o la clase del error, nunca su mensaje: trae rutas del disco y la página del nocturno se commitea
  catch (e) { sinTiempos = `scripts/metrics/step-times.js no se pudo cargar (${e.code || e.name || 'error'}): trabajo y espera no se miden`; }
  for (const a of archivos) {
    const ruta = typeof a === 'string' ? a : a.ruta;
    let o; try { o = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (e) { total += 1; ilegibles += 1; if (a.grupo) grupos.add(a.grupo); continue; }
    if (!o || typeof o !== 'object' || !o.marker || typeof o.marker !== 'object') continue;
    total += 1; if (a.grupo) grupos.add(a.grupo);
    const mk = o.marker, co = o.costo || {};
    if (typeof o.archivedAt === 'string' && (!ultima || o.archivedAt > ultima)) ultima = o.archivedAt;
    const ini = Date.parse(mk.startedAt || ''), fin = Date.parse(mk.lastTouch || '');
    if (Number.isFinite(ini) && Number.isFinite(fin) && fin > ini) dur.push((fin - ini) / 3600000);
    if (Number.isFinite(co.spawns)) spawns.push(co.spawns);
    if (Number.isFinite(co.iteraciones)) iters.push(co.iteraciones);
    if (tiempos) {
      const t = tiempos.tiempos(mk.stepTimings || {}, { inicio: mk.startedAt });
      if (t.trabajo_ms !== null && t.trabajo_medido) trab.push(t.trabajo_ms / 3600000);
      if (t.espera_humana_ms !== null) esp.push(t.espera_humana_ms / 3600000);
    }
  }
  if (!total) { const n = noMedida(opts.vacio || 'no hay ninguna ejecución'); return { corridas: n, agentes: n, vueltas: n, trabajo_espera: n, maquinas: 0 }; }
  const den = etiqueta(grupos.size);
  const rotos = ilegibles ? ` · ${ilegibles} volcado(s) no se pudieron leer (¿subida cortada?): cuentan en el total, no en la mediana` : '';
  const edad = edadDias(ultima, Date.now());
  const nota = edad !== null && edad > 2 ? ` · la última ejecución es de ${edadTexto(edad)}` : '';
  return {
    maquinas: grupos.size,
    trabajo_espera: sinTiempos ? noMedida(sinTiempos) : (trab.length || esp.length)
      ? { estado: 'medido', trabajo: trab.length ? mediana(trab) : null, n_trabajo: trab.length, espera: esp.length ? mediana(esp) : null, n_espera: esp.length, total }
      : noMedida('ninguna ejecución anotó el arranque de sus pasos (las anteriores a la story 2.7 no lo tienen)'),
    corridas: dur.length
      ? medida(mediana(dur), dur.length, total, { unidad: 'conteo', den_etiqueta: den, detalle: `máximo ${num1(Math.max(...dur))} h${nota}${rotos}` })
      : noMedida('ninguna ejecución dejó su duración'),
    agentes: spawns.length
      ? medida(mediana(spawns), spawns.length, total, { unidad: 'conteo', den_etiqueta: den, detalle: `máximo ${Math.max(...spawns)}${rotos}` })
      : noMedida('ninguna ejecución registró cuántos agentes lanzó'),
    vueltas: iters.length
      ? medida(mediana(iters), iters.length, total, { unidad: 'conteo', den_etiqueta: den, detalle: `máximo ${Math.max(...iters)}${rotos}` })
      : noMedida('ninguna ejecución registró sus vueltas de revisión'),
  };
}

/** Los `.json` bajo una carpeta de máquina del buzón, siguiendo enlaces sin volver sobre sí mismos. */
function jsonsDe(dir, malas, vistas = new Set()) {
  let real; try { real = fs.realpathSync(dir); } catch (e) { malas.push(e.code || 'ilegible'); return []; }
  if (vistas.has(real)) return [];
  vistas.add(real);
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { malas.push(e.code || 'ilegible'); return []; }
  const out = [];
  for (const it of ents) {
    const p = path.join(dir, it.name);
    let carpeta = it.isDirectory(), archivo = it.isFile();
    if (it.isSymbolicLink()) { try { const st = fs.statSync(p); carpeta = st.isDirectory(); archivo = st.isFile(); } catch (e) { malas.push(e.code || 'ilegible'); continue; } }
    if (carpeta) out.push(...jsonsDe(p, malas, vistas));
    else if (archivo && it.name.endsWith('.json')) out.push(p);
  }
  return out;
}

/**
 * Las corridas en el nocturno: de los volcados `<máquina>/*.json` del buzón que el nocturno ya
 * baja, con la misma lectura que la página de una máquina. Sin el buzón entero, nada: la mitad de las máquinas no es el
 * equipo. Nunca lee `timing-history/` del disco: el agente no es una máquina del equipo.
 */
function corridasDelBuzon(buzon) {
  const todas = (n) => ({ corridas: n, agentes: n, vueltas: n, trabajo_espera: n, maquinas: null });
  if (buzon.estado !== 'leido') return todas(noLeido(buzon));
  const dir = path.resolve(AMB.mailbox || path.join(stateDirOf(require('os').homedir()), 'corridas-buzon'));
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return todas(noMedida(`no se pudo leer la carpeta bajada del buzón (${e.code || 'error'}): no es un buzón vacío`)); }
  const archivos = [], malas = [];
  for (const en of ents) {
    let carpeta = en.isDirectory();
    if (en.isSymbolicLink()) { try { carpeta = fs.statSync(path.join(dir, en.name)).isDirectory(); } catch (e) { malas.push(e.code || 'ilegible'); continue; } }
    if (!carpeta || en.name.startsWith('.')) continue;
    for (const ruta of jsonsDe(path.join(dir, en.name), malas)) archivos.push({ ruta, grupo: en.name });
  }
  // Sin una máquina, la mediana no es la del equipo — el mismo criterio que los pasos por corrida.
  if (malas.length) return todas(noMedida(`${malas.length} carpeta(s) del buzón de ejecuciones no se pudieron leer: la mediana saldría sin sus ejecuciones, y eso no es la del equipo`));
  return leerCorridas(archivos, { vacio: 'el buzón no tiene ejecuciones', etiqueta: (m) => `ejecuciones, de ${m} máquina${m === 1 ? '' : 's'}` });
}

function local(buzon = { estado: 'no_aplica' }) {
  if (AMB.nocturno) {
    return {
      // la duración de la suite la pone colectar() con la cuenta del equipo
      freno: noAplica('el freno de mano anota en el disco de cada máquina'),
      ...corridasDelBuzon(buzon),
      estilo: noAplica('el medidor de estilo vive en cada máquina'),
      bloqueo: noAplica('el medidor de bloqueos vive en cada máquina'),
    };
  }
  const m = {};
  const falta = (q) => noMedida(`esta página se generó donde no está ${q} (vive en el disco de cada máquina, fuera de todo repo)`);

  // 1 · Duración de la suite de pruebas (de gates.log de esta máquina). Los BLOQUEOS y los ESCAPES no se
  //     cuentan acá: salen de `equipo()`, que cuenta los registros de todas las máquinas. Este
  //     lector publicaría el nombre crudo del control y del tipo de escape en el detalle — la prueba de fuga
  //     lo caza con un nombre de cliente y un comando sembrados.
  const gates = path.join(stateDirOf(require('os').homedir()), 'gates.log');
  if (!fs.existsSync(gates)) { m.gates_dur = falta('el registro de frenos'); }
  else {
    try {
      // la lectura de la línea es la del reductor: la misma muestra que la cuenta del equipo
      const { duracionSuite } = require('./reducer');
      const durTests = [];
      for (const d of leerJsonl(gates)) {
        const s = duracionSuite(d);
        if (s !== null) durTests.push(s);
      }
      let maximo = -Infinity;
      for (const x of durTests) if (x > maximo) maximo = x;
      m.gates_dur = durTests.length
        ? medida(mediana(durTests), durTests.length, durTests.length,
            { unidad: 'conteo', den_etiqueta: 'ejecuciones de la suite', detalle: `máximo ${num1(maximo / 60)} minutos` })
        : noMedida('ninguna ejecución de tests dejó su duración');
    } catch (e) { m.gates_dur = noMedida(`el registro de frenos no se pudo leer: ${e.code || e.message}`); }
  }

  // 3 · Freno de mano: bloqueos por regla (texto plano, se extrae SÓLO el identificador de regla).
  const sg = path.join(HOME_TYCON, 'safety-guard.log');
  m.freno = !fs.existsSync(sg) ? falta('el registro del freno de mano') : (() => {
    try {
      const txt = fs.readFileSync(sg, 'utf8');
      const reglas = {};
      for (const mm of txt.matchAll(/rule=([A-Za-z0-9_-]+)/g)) inc(reglas, mm[1]);
      const n = Object.values(reglas).reduce((a, b) => a + b, 0);
      if (n === 0) return noMedida('el registro existe pero no tiene ningún bloqueo con regla identificada');
      const top = Object.entries(reglas).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ');
      return medida(n, Object.keys(reglas).length, Object.keys(reglas).length,
        { unidad: 'conteo', den_etiqueta: 'reglas distintas', detalle: top });
    } catch (e) { return noMedida(`el registro del freno de mano no se pudo leer: ${e.code || e.message}`); }
  })();

  // 4 · Corridas completas del pipeline: duración, agentes y vueltas.
  // (la lectura es leerCorridas(), la misma del nocturno sobre el buzón)
  const th = path.join(stateDirOf(require('os').homedir()), 'timing-history');
  const vacio = () => { m.corridas = falta('el registro de ejecuciones'); m.agentes = m.corridas; m.vueltas = m.corridas; };
  if (!fs.existsSync(th)) vacio();
  else {
    try {
      const archivos = fs.readdirSync(th).filter((n) => n.endsWith('.json')).map((n) => path.join(th, n));
      const r = leerCorridas(archivos, { vacio: 'ninguna ejecución dejó su duración' });
      m.corridas = r.corridas; m.agentes = r.agentes; m.vueltas = r.vueltas; m.trabajo_espera = r.trabajo_espera;
    } catch (e) { vacio(); }
  }

  // 5 · Los dos medidores de conducta.
  const medidor = (rel, campo, etiqueta) => {
    const r = path.join(HOME_TYCON, rel);
    if (!fs.existsSync(r)) return falta(`el medidor de ${etiqueta}`);
    try {
      const ls = leerJsonl(r).filter(Boolean);
      if (!ls.length) return noMedida(`el medidor de ${etiqueta} no tiene ninguna medición`);
      const dentro = ls.filter((d) => d[campo] !== true).length;
      return ratio(dentro, ls.length);
    } catch (e) { return noMedida(`el medidor de ${etiqueta} no se pudo leer: ${e.code || e.message}`); }
  };
  m.estilo = { ...medidor('response-style/log.jsonl', 'over', 'estilo'), den_etiqueta: 'respuestas' };
  m.bloqueo = { ...medidor('blocking-meter/log.jsonl', 'over', 'bloqueo'), den_etiqueta: 'turnos' };
  return m;
}

// ─────────────── el anillo del EQUIPO: frenos y escapes de todas las máquinas ───────────────
// Cada máquina sube sus registros de frenos y escapes al buzón; `reducer.js` los cuenta (los de
// esta máquina, del disco; los de las otras, de la carpeta bajada) por lista blanca, recalculando cada vez.
// Toda palabra que llega a la página es un alias validado, una fecha validada o un valor de la lista cerrada.
// El piso (sources.json → reducer.floor) calla todo valor con menos eventos: un corte chico es un evento
// con sus metadatos, no una estadística.
function equipo(cfg, buzon = { estado: 'no_aplica' }) {
  // en el nocturno, sin el buzón entero no hay fichas del equipo — nunca «ninguna máquina reportó».
  if (AMB.nocturno && buzon.estado !== 'leido') {
    const n = noLeido(buzon);
    return { bloqueos: n, escapes: n, escapes_dom: n, frenos: n, evidencia_cierre: n, carriles: n, cobertura_tocada: n, mutacion: n, qa_guia: n, suite_duracion: n, cobertura_maquinas: n.motivo, maquinas_equipo: null };
  }
  const reductor = require('./reducer');
  let j;
  try {
    j = reductor.juntar({
      // 🔴 El nocturno no lee registros del disco: el agente no es una máquina del equipo.
      registros: AMB.nocturno ? null : path.resolve(AMB.logs || stateDirOf(require('os').homedir())),
      buzon: path.resolve(AMB.mailbox || path.join(stateDirOf(require('os').homedir()), 'corridas-buzon')),
      cfg, hoy: hoyUTC(),
    });
  } catch (e) {
    // Una falla inesperada de la cuenta no tira la página entera: las dos fichas quedan no medidas con motivo.
    j = { estado: 'no_medido', motivo: `la cuenta de los registros falló (${e.code || e.name || 'error'})` };
  }
  const cobertura_maquinas = reductor.textoCobertura(j);
  if (j.estado !== 'medido') { const n = noMedida(j.motivo); return { bloqueos: n, escapes: n, escapes_dom: n, frenos: n, evidencia_cierre: n, carriles: n, cobertura_tocada: n, mutacion: n, qa_guia: n, suite_duracion: n, cobertura_maquinas, maquinas_equipo: null }; }
  // Cuántas máquinas entraron a la cuenta (las esperadas que reportaron y las no declaradas): lo lleva el sello.
  const maquinas_equipo = j.cobertura.reportaron + j.cobertura.sin_declarar.length;
  const piso = j.piso;
  const ventana = `${j.ventana.desde} → ${j.ventana.hasta}`;
  const sinMaquinas = j.metricas && Object.values(j.metricas).every((x) => x.maquinas === 0);
  // Las que más, por encima del piso. Lo que no llega se agrupa: «otras (N)», sin nombrarlas.
  const lasQueMas = (porDim) => {
    const filas = Object.entries(porDim).filter(([, v]) => v.num > 0);
    const arriba = filas.filter(([, v]) => (v.den === null ? v.num : v.den) >= piso)
      .sort((a, b) => b[1].num - a[1].num || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([k, v]) => `${k}: ${v.num}`);
    const abajo = filas.filter(([, v]) => (v.den === null ? v.num : v.den) < piso).length;
    return [...arriba, ...(abajo ? [`otras (${abajo}, debajo del piso)`] : [])].join(' · ');
  };
  const parcial = (acc, que) => (acc.midieron < acc.maquinas ? ` · ${que}: midieron ${acc.midieron} de ${acc.maquinas} máquinas` : '');

  const b = j.metricas.bloqueos, e = j.metricas.escapes;
  let bloqueos, escapes, escapes_dom = null;
  if (!b) bloqueos = noMedida('la configuración del reductor no declara la métrica de bloqueos');
  else if (sinMaquinas || b.midieron === 0) bloqueos = noMedida(sinMaquinas ? 'ninguna máquina reportó sus registros' : 'ninguna máquina pudo leer su registro de frenos');
  else if (b.den < piso) bloqueos = noMedida(`por debajo del piso (${b.den} evaluaciones en la ventana; hacen falta ${piso})`);
  else {
    const top = lasQueMas(b.porDim);
    bloqueos = medida(b.num, b.den, b.den, { unidad: 'conteo', den_etiqueta: 'evaluaciones registradas', detalle: `${ventana}${top ? ' · ' + top : ''}${parcial(b, 'frenos')}` });
  }
  if (!e) escapes = noMedida('la configuración del reductor no declara la métrica de escapes');
  else if (sinMaquinas || e.midieron === 0) escapes = noMedida(sinMaquinas ? 'ninguna máquina reportó sus registros' : 'ninguna máquina pudo leer su registro de escapes');
  else if (e.num < piso) escapes = noMedida(`por debajo del piso (${e.num} escapes en la ventana; hacen falta ${piso})`);
  else {
    escapes = medida(e.num, e.num, e.num, { unidad: 'conteo', den_etiqueta: 'escapes', detalle: `${ventana} · ${lasQueMas(e.porDim)}${parcial(e, 'escapes')}` });
    // «otro» y «sin-tipo» juntan muchas reglas: nunca pueden ser «la regla dominante».
    const dom = Object.entries(e.porDim).filter(([k, v]) => !reductor.BALDES_GENERICOS.has(k) && v.num >= piso).sort((x, y) => y[1].num - x[1].num || (x[0] < y[0] ? -1 : 1))[0];
    escapes_dom = dom
      ? { ...ratio(dom[1].num, e.num), den_etiqueta: 'escapes', detalle: `la regla dominante es ${dom[0]}` }
      : noMedida('ningún tipo de escape con nombre llega al piso: lo que más aparece son tipos fuera de la lista o sin tipo');
  }
  // Sin escapes publicables, la ficha de la regla dominante dice lo mismo que la de escapes: nunca queda sin motivo.
  if (!escapes_dom) escapes_dom = escapes;

  // ── los frenos PREVIOS a la herramienta, con sus dos números juntos ───────────────
  // Hasta acá el panel sabía cuántas veces se SALTEÓ un freno y no cuántas frenó: un freno que
  // funcionó todo el mes se veía igual que uno que nunca se disparó. Las dos métricas comparten
  // fuente, ventana y denominador a propósito, así que de una misma regla se pueden poner los dos
  // números uno al lado del otro — que es lo que decide si se retira.
  const fb = j.metricas.frenos_bloqueos, fe = j.metricas.frenos_escapes, fa = j.metricas.frenos_avisos;
  let frenos;
  if (!fb || !fe || !fa) frenos = noMedida('la configuración del reductor no declara las métricas de los frenos previos a la herramienta');
  else if (sinMaquinas || fb.midieron === 0) frenos = noMedida(sinMaquinas ? 'ninguna máquina reportó sus registros' : 'ninguna máquina pudo leer su registro de frenos previos');
  else if (fb.den < piso) frenos = noMedida(`por debajo del piso (${fb.den} decisiones en la ventana; hacen falta ${piso})`);
  else {
    // Un freno con decisiones y sin líneas de escape tuvo CERO escapes de verdad: misma fuente,
    // misma ventana y las mismas máquinas que sus bloqueos. No es una ausencia rellenada.
    const escapesDe = (k) => (Object.prototype.hasOwnProperty.call(fe.porDim, k) ? fe.porDim[k].num : 0);
    // 🔴 Un freno que NUNCA bloquea (sólo avisa) publicaría «frenó 0, lo saltearon 0»: los dos números
    //    ciertos, y la única señal que produce perdida en la cuenta. El aviso se publica al lado.
    const avisosDe = (k) => (Object.prototype.hasOwnProperty.call(fa.porDim, k) ? fa.porDim[k].num : 0);
    const arriba = Object.entries(fb.porDim).filter(([, v]) => v.den >= piso)
      .sort((a, b) => b[1].den - a[1].den || (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => {
        const av = avisosDe(k);
        return `${k}: frenó ${v.num}${av ? `, avisó ${av}` : ''}, lo saltearon ${escapesDe(k)}, de ${v.den}`;
      });
    const abajo = Object.entries(fb.porDim).filter(([, v]) => v.den < piso).length;
    const filas = [...arriba, ...(abajo ? [`otros (${abajo}, debajo del piso)`] : [])].join(' · ');
    // 🔴 El TOTAL es una CUENTA de bloqueos, no una proporción: los seis frenos no comparten
    //    denominador. `safety-guard` no anota sus «dejé pasar» (decisión D1: corre en cada comando
    //    de la terminal), así que su denominador son «las veces que una regla peligrosa saltó» y el
    //    de los otros cinco son «las veces que el comando les competía». Dividir la suma de unos por
    //    la suma de los otros produce un número que no significa nada. La proporción vive por freno,
    //    en el detalle, donde cada uno lleva SU denominador.
    frenos = medida(fb.num, fb.num, fb.num, {
      unidad: 'conteo', den_etiqueta: 'veces que un freno frenó',
      detalle: `${ventana}${filas ? ' · ' + filas : ''}${parcial(fb, 'frenos previos')}`,
    });
  }
  // ── cuántas evidencias rechazan los hooks del CIERRE ─────────────────────────────
  // El cierre de una story se recortó (sale lo que relee con modelo, se queda lo que corre código) y el
  // número que dice si el mínimo alcanza es éste: de las decisiones de `on-frontmatter-write`, `on-pre-commit`
  // y `on-dod-evidence-guard` sobre una evidencia, cuántas la rechazaron. A diferencia de los frenos previos,
  // los tres SÍ comparten unidad —una decisión sobre la evidencia de un cierre—, así que el total es una
  // proporción; el detalle la abre por hook, cada uno con su denominador.
  const er = j.metricas.evidencia_rechazada_por_hook;
  let evidencia_cierre;
  if (!er) evidencia_cierre = noMedida('la configuración del reductor no declara la métrica de evidencias rechazadas por los hooks del cierre');
  else if (sinMaquinas || er.midieron === 0) evidencia_cierre = noMedida(sinMaquinas ? 'ninguna máquina reportó sus registros' : 'ninguna máquina pudo leer su registro de frenos');
  else if (er.den === 0) evidencia_cierre = noMedida('ningún hook del cierre dejó constancia en la ventana (la medición empezó con la story 7.2)');
  else if (er.den < piso) evidencia_cierre = noMedida(`por debajo del piso (${er.den} decisiones en la ventana; hacen falta ${piso})`);
  else {
    const filas = Object.entries(er.porDim).filter(([, v]) => v.den >= piso)
      .sort((a, b) => b[1].den - a[1].den || (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}: rechazó ${v.num} de ${v.den}`);
    const abajo = Object.entries(er.porDim).filter(([, v]) => v.den < piso).length;
    evidencia_cierre = {
      ...ratio(er.num, er.den), den_etiqueta: 'decisiones sobre una evidencia',
      detalle: `${ventana} · ${[...filas, ...(abajo ? [`otros (${abajo}, debajo del piso)`] : [])].join(' · ')}${parcial(er, 'hooks del cierre')}`,
    };
  }
  // ── commits por carril ──────────────────────────────────────────────────────────
  // Sólo los commits que una sesión vio. Los hechos desde la terminal o el editor no pasan por
  // ningún hook: no se ven, y el pie lo dice — nunca se leen como cero.
  const ca = j.metricas.carriles;
  let carriles;
  if (!ca) carriles = noMedida('la configuración del reductor no declara la métrica de carriles');
  else if (sinMaquinas || ca.midieron === 0) carriles = noMedida(sinMaquinas ? 'ninguna máquina reportó sus registros' : 'ninguna máquina subió todavía el carril de sus commits');
  else if (ca.num < piso) carriles = noMedida(`por debajo del piso (${ca.num} commits en la ventana; hacen falta ${piso})`);
  else {
    carriles = medida(ca.num, ca.num, ca.num, {
      unidad: 'conteo', den_etiqueta: 'commits hechos desde una sesión',
      detalle: `${ventana} · ${lasQueMas(ca.porDim)}${parcial(ca, 'carriles')}`,
    });
  }
  // El 75 % sobre las LÍNEAS TOCADAS, en observación. Cada corrida de test-gate deja una línea
  // `cobertura-tocada` en gates.log; acá se cuenta, en todas las máquinas, cuántas corridas pudieron
  // evaluar el umbral y cuántas de ésas habrían frenado.
  // La fecha de la observación sale de UNA definición, la del informe de test-gate: una copia acá
  // envejecería sola («en observación hasta <fecha>» pasada esa fecha). Vencida se dice; decidir si el umbral
  // frena es del dueño, no de esta página. Si el módulo no carga (una copia de scripts/ sola), el pie lo dice.
  const observacion = (() => {
    let obs;
    try { obs = require(path.join(__dirname, '..', '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'test-gate-report.js')).OBS_HASTA; }
    catch (e) { return `no se pudo leer la fecha de la observación (${e.code || e.name || 'error'}): no frena`; }
    if (typeof obs !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obs)) return 'no se pudo leer la fecha de la observación (sin forma de fecha): no frena';
    return hoyUTC() > obs ? `la observación terminó el ${obs} y no se decidió: sigue sin frenar` : `en observación hasta el ${obs}, no frena`;
  })();
  const ce = j.metricas.cobertura_tocada_evaluo, cf = j.metricas.cobertura_tocada_frenaria;
  let cobertura_tocada;
  if (!ce || !cf) cobertura_tocada = noMedida('la configuración del reductor no declara las métricas de cobertura de las líneas tocadas');
  else if (sinMaquinas || ce.midieron === 0) cobertura_tocada = noMedida(sinMaquinas ? 'ninguna máquina reportó sus registros' : 'ninguna máquina pudo leer su registro de controles (gates.log), que es donde queda la cobertura de las líneas tocadas');
  else {
    const corridas = (ce.porDim['cobertura-tocada'] || { num: 0, den: 0 });
    const frenaria = (cf.porDim['cobertura-tocada'] || { num: 0, den: 0 });
    if (corridas.den === 0) cobertura_tocada = noMedida('ninguna ejecución de test-gate dejó constancia de cobertura de las líneas tocadas en la ventana (la medición empezó con la story 2.4)');
    else if (corridas.den < piso) cobertura_tocada = noMedida(`por debajo del piso (${corridas.den} ejecuciones en la ventana; hacen falta ${piso})`);
    else {
      cobertura_tocada = {
        ...ratio(corridas.num, corridas.den), den_etiqueta: 'ejecuciones de test-gate',
        detalle: `${ventana} · habría frenado ${frenaria.num} de ${corridas.num} · ${observacion}${parcial(ce, 'cobertura')}`,
      };
    }
  }
  // ── mutación y guía de QA, de todas las máquinas ─────────────────────────────────
  // Las dos fichas no leen el gates.log del disco de quien genera la página: las cuenta el
  // reductor en todas las máquinas, y cada ficha dice de cuántas sale su número: con una sola, no es una serie
  // del equipo y lo dice. Lo que no pudo medir se cuenta aparte y nunca es un 0 %.
  const deMaquinas = (acc) => (acc.aportaron === 1 ? 'de una sola máquina: todavía no es una serie del equipo' : `de ${acc.aportaron} máquinas`);
  const porCantidad = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
  const mp = j.metricas.mutacion_puntaje, mc = j.metricas.mutacion_chequeos;
  let mutacion;
  if (!mp || !mc || !Array.isArray(mp.muestras)) mutacion = noMedida('la configuración del reductor no declara las métricas de mutación');
  else if (sinMaquinas || mp.midieron === 0) mutacion = noMedida(sinMaquinas ? 'ninguna máquina reportó sus registros' : 'ninguna máquina pudo leer su registro de controles (gates.log), que es donde queda la mutación');
  else {
    const n = mp.muestras.length;
    const sinPuntaje = Object.entries(mc.porDim).map(([k, v]) => [k, v.den - v.num]).filter(([, x]) => x > 0).sort(porCantidad)
      .map(([k, x]) => `${k} ${x}`).join(' · ');
    const chequeos = `con puntaje ${mc.num} de ${mc.den} chequeo${mc.den === 1 ? '' : 's'}${sinPuntaje ? ` · no pudieron medir: ${sinPuntaje}` : ''}`;
    if (mc.den === 0) mutacion = noMedida('ninguna ejecución registró un chequeo de mutación en la ventana');
    else if (n === 0) mutacion = noMedida(`ninguno de los ${mc.den} chequeo${mc.den === 1 ? '' : 's'} de mutación de la ventana pudo medir (${sinPuntaje})`);
    else if (n < piso) mutacion = noMedida(`por debajo del piso (${n} chequeo${n === 1 ? '' : 's'} con puntaje en la ventana; hacen falta ${piso}) — ${chequeos}`);
    else {
      // 🔴 Sin argumentos sueltos (revisión adversarial): `Math.min(...muestras)` desborda la pila con ~100 mil
      //    muestras —un registro inflado en el buzón entra en los topes del reductor— y está fuera del try de
      //    juntar(): se caía la página entera, no sólo esta ficha.
      let minimo = Infinity, maximo = -Infinity;
      for (const x of mp.muestras) { if (x < minimo) minimo = x; if (x > maximo) maximo = x; }
      mutacion = medida(mediana(mp.muestras), n, n, {
        unidad: 'conteo', formato: 'ratio', den_etiqueta: 'chequeos con puntaje',
        detalle: `${ventana} · mínimo ${pct(minimo)} · máximo ${pct(maximo)} · ${chequeos} · ${deMaquinas(mp)}${parcial(mp, 'mutación')}`,
      });
    }
  }
  const qe = j.metricas.qa_guia_estados, qp = j.metricas.qa_guia_presente;
  let qa_guia;
  if (!qe || !qp) qa_guia = noMedida('la configuración del reductor no declara las métricas de la guía de QA');
  else if (sinMaquinas || qe.midieron === 0) qa_guia = noMedida(sinMaquinas ? 'ninguna máquina reportó sus registros' : 'ninguna máquina pudo leer su registro de controles (gates.log), que es donde queda la guía de QA');
  else {
    const cuenta = (k) => (Object.prototype.hasOwnProperty.call(qe.porDim, k) ? qe.porDim[k].num : 0);
    const avisos = cuenta('missing') + cuenta('stale');
    const desglose = Object.entries(qe.porDim).map(([k, v]) => [k, v.num]).filter(([, x]) => x > 0).sort(porCantidad).map(([k, x]) => `${k} ${x}`).join(' · ');
    const lista = `${avisos} aviso${avisos === 1 ? '' : 's'} en la ventana${desglose ? ` (${desglose})` : ''}`;
    if (qe.num === 0) qa_guia = noMedida('ninguna ejecución evaluó la guía de QA en la ventana');
    // 🔴 Sin líneas del registro completo NO hay proporción: las viejas sólo anotaban las guías que faltaban o
    //    estaban viejas, así que «presentes» daría 0 por construcción. Se dice, con los avisos contados.
    // Con líneas del registro completo que son TODAS `no-aplica`, el arnés ya está actualizado: lo que pasa es que
    // ningún cierre necesitaba guía. Decir «falta actualizar» sería falso (revisión, AC 6).
    else if (qp.den === 0 && cuenta('no-aplica') > 0) qa_guia = noMedida(`ningún cierre del registro completo necesitaba guía en la ventana (${cuenta('no-aplica')} no aplicaban) — ${lista}`);
    else if (qp.den === 0) qa_guia = noMedida(`ningún cierre con el registro completo todavía: hasta que las máquinas actualicen el arnés sólo se anotan las guías que faltan o quedaron viejas — ${lista}`);
    else if (qp.den < piso) qa_guia = noMedida(`por debajo del piso (${qp.den} cierre${qp.den === 1 ? '' : 's'} con registro completo; hacen falta ${piso}) — ${lista}`);
    else {
      qa_guia = {
        ...ratio(qp.num, qp.den), den_etiqueta: 'cierres que necesitaban guía (registro completo)',
        detalle: `${ventana} · ${desglose} · ${deMaquinas(qp)}${parcial(qe, 'guía de QA')}`,
      };
    }
  }
  // ── la duración de la suite, de todas las máquinas ─────────────────────────────────
  // gates.log ya viaja entero al buzón: el reductor junta la duración de cada corrida de `tests` en una
  // distribución —la mediana sale de la unión de las muestras, nunca promediando medianas— dentro de su ventana.
  const sd = j.metricas.suite_duracion;
  let suite_duracion;
  if (!sd || !Array.isArray(sd.muestras)) suite_duracion = noMedida('la configuración del reductor no declara la duración de la suite');
  else if (sinMaquinas || sd.midieron === 0) suite_duracion = noMedida(sinMaquinas ? 'ninguna máquina reportó sus registros' : 'ninguna máquina pudo leer su registro de controles (gates.log), que es donde queda la duración de la suite');
  else if (!sd.muestras.length) suite_duracion = noMedida('ninguna ejecución de tests dejó su duración');
  // el piso, como la mutación y todas las fichas del equipo: un corte chico es un evento con su máquina, no una estadística
  else if (sd.muestras.length < piso) suite_duracion = noMedida(`por debajo del piso (${sd.muestras.length} ejecución${sd.muestras.length === 1 ? '' : 's'} de la suite en la ventana; hacen falta ${piso})`);
  else {
    let maximo = -Infinity;
    for (const x of sd.muestras) if (x > maximo) maximo = x;
    suite_duracion = medida(mediana(sd.muestras), sd.muestras.length, sd.muestras.length, {
      unidad: 'conteo', den_etiqueta: 'ejecuciones de la suite',
      detalle: `${ventana} · máximo ${num1(maximo / 60)} minutos · midieron ${sd.midieron} de ${sd.maquinas} máquina${sd.maquinas === 1 ? '' : 's'}`,
    });
  }
  return { bloqueos, escapes, escapes_dom, frenos, evidencia_cierre, carriles, cobertura_tocada, mutacion, qa_guia, suite_duracion, cobertura_maquinas, maquinas_equipo };
}

// ─────────────── el criterio de poda: hallazgos por regla, con su denominador ───────────────
// `prune.js` cruza los hallazgos de todas las máquinas con las veces que corrió el revisor dueño de cada regla
// y con el banco de pruebas. Acá sólo se traduce a fichas. 🔴 Nunca tira la página: si el cruce no puede
// medir, las fichas quedan no medidas con su motivo — el examen y el catálogo no son fuentes obligatorias.
// Lo que llega a la página son pares (dueño, regla) del CATÁLOGO, que es público en este repo: un
// identificador escrito a mano en un hallazgo nunca llega hasta acá (el recolector lo cuenta y lo tira).
// ─────────────── los PASOS de una corrida: la variable que explica su costo ───────────────
// El consumo de una corrida lo explica la cantidad de pasos que da (la correlación es casi total)
// y casi todo son relecturas del contexto. El número lo produce `scripts/metrics/steps-per-run.js`
// leyendo el buzón de corridas —el de todas las máquinas, no el registro de ésta—, y la línea base contra la
// que se compara sale de ESE archivo (`LINEA_BASE`), nunca de esta página: tipeada acá envejecería callada.
// 🔴 No propone un tope ni pinta un color: primero la serie. Por eso la ficha no tiene umbral en sources.json.
// 🔴 Nunca un cero: buzón ausente, vacío, sin ninguna corrida medida o con la última demasiado vieja son
//    cuatro «no medido» con cuatro motivos distintos. Las corridas sin consumo medido siguen en el
//    denominador (`n de N`) y se dicen: ni se promedian como cero ni desaparecen.
function pasosPorCorrida(cfg, buzon = { estado: 'no_aplica' }, opts = {}) {
  const nocturno = opts.nocturno === undefined ? AMB.nocturno : opts.nocturno;
  // En el nocturno, sin el buzón ENTERO no hay ficha: la mitad de las máquinas no es el equipo.
  if (nocturno && buzon.estado !== 'leido') return noLeido(buzon);
  // 🔴 La fuente se BUSCA en la lista cerrada. Leer el buzón por su ruta fija sin mirar la lista dejaría la
  //    declaración de adorno: sacarla no cambiaría nada, y una ausencia no se detectaría nunca.
  const fuente = ((cfg && cfg.sources) || []).find((f) => f && f.id === 'pasos-corrida');
  if (!fuente) return noMedida('la fuente «pasos-corrida» no está declarada en sources.json: sin declarar no se lee, porque su ausencia no se podría detectar');
  let medidor;
  // 🔴 El código o el tipo del error, NUNCA su mensaje: trae rutas del disco y esta página se commitea.
  try { medidor = require('../../metrics/steps-per-run.js'); }
  catch (e) { return noMedida(`scripts/metrics/steps-per-run.js no se pudo cargar (${e.code || e.name || 'error'})`); }
  // La antigüedad máxima es parte de la declaración (AC 6): mal escrita no APAGA el control de vejez, lo frena.
  if (!Number.isFinite(fuente.max_age_days) || fuente.max_age_days <= 0) return noMedida('sources.json declara «pasos-corrida» sin una antigüedad máxima válida (max_age_days tiene que ser un número de días mayor que cero): sin ella no se puede saber si el número está al día');
  const dir = path.resolve(opts.dir || AMB.mailbox || path.join(stateDirOf(require('os').homedir()), 'corridas-buzon'));
  // El medidor trata una carpeta que no puede leer como vacía; acá se distingue: «no está» no es «no hay corridas».
  if (!fs.existsSync(dir)) return noMedida('no está la carpeta bajada del buzón de ejecuciones (la llena download-runs.js en las máquinas con permiso de lectura)');
  let r;
  try { r = medidor.medir({ buzon: dir }); }
  catch (e) { return noMedida(`el medidor de pasos por ejecución falló (${e.code || e.name || 'error'})`); }
  // Lo que el medidor no pudo LEER: «no pude preguntar» no es «pregunté y no hay».
  if (r.legible === false) return noMedida(`la carpeta bajada del buzón de ejecuciones existe pero no se pudo leer (${r.motivo_ilegible}): no es un buzón vacío`);
  // Sin una máquina, la mediana no es la del equipo — el mismo criterio que el nocturno con el buzón a medias.
  if (r.carpetas_ilegibles) return noMedida(`${r.carpetas_ilegibles} carpeta(s) del buzón de ejecuciones no se pudieron leer: la mediana saldría sin sus ejecuciones, y eso no es la del equipo`);
  // Un volcado cortado puede ser una corrida: se queda en el denominador, como las sin medir.
  const N = r.corridas + r.sin_medir + r.ilegibles;
  if (!N) return noMedida('el buzón de ejecuciones está vacío: no hay ninguna ejecución que contar');
  if (!r.corridas) return noMedida(`ninguna de las ${N} ejecución(es) del buzón tiene su consumo medido: los pasos no se estiman`);
  // La fecha del número es la de la corrida MEDIDA más nueva (`filas` viene ordenada por inicio).
  const fecha = r.filas[r.filas.length - 1].inicio || null;
  const edad = edadDias(fecha, opts.hoy || Date.now());
  if (edad === null || edad > fuente.max_age_days) {
    return noMedida(fecha
      ? `sin ejecuciones medidas desde ${fecha} (${edadTexto(edad)}): pasados ${fuente.max_age_days} días el número se calla`
      : 'las ejecuciones medidas del buzón no traen su fecha: no se puede saber si el número está al día');
  }
  const serie = r.por_mes.map((m) => ({ mes: m.mes, n: m.n, mediana: m.mediana }));
  const lb = medidor.LINEA_BASE;
  const detalle = [
    `última ejecución medida: ${fecha || 'sin fecha'}`,
    r.sin_medir ? `${r.sin_medir} sin consumo medido: no entran en la mediana ni se estiman` : null,
    r.ilegibles ? `${r.ilegibles} volcado(s) no se pudieron leer (¿subida cortada?): cuentan en el total, no en la mediana` : null,
    `por mes — ${serie.map((m) => `${m.mes}: ${Math.round(m.mediana)} (n=${m.n})`).join(' · ')}`,
    `línea base del ${lb.fecha}: ${lb.mediana} (n=${lb.corridas})`,
  ].filter(Boolean).join(' · ');
  return medida(r.pasos.mediana, r.corridas, N, { unidad: 'conteo', den_etiqueta: 'ejecuciones', detalle, fecha, serie });
}

const ETIQUETA_ESTADO = {
  sin_revisor: 'sin revisor', rota: 'rota', revision_humana: 'revisión humana', activa: 'activa',
  sin_examinar: 'sin probar', candidata_a_retiro: 'candidata a retiro', sin_oportunidades_suficientes: 'sin recorrido suficiente',
};
/**
 * El rótulo de las dos puntas: de cuántas máquinas salen, y QUÉ máquinas no entraron y por qué (por alias:
 * el nombre de una máquina suele ser el de su dueño). Sin esto, «4 candidatas» no dice sobre qué universo.
 */
function denominadorPoda(c) {
  const sinMedir = c.hallazgos.maquinas_sin_medir || [];
  return `hallazgos y oportunidades de ${c.hallazgos.maquinas} máquina(s) con los hallazgos medidos; `
    + `el denominador sale de ${c.corridas.con_denominador} de ${c.corridas.total} ejecuciones`
    + (c.corridas.no_leidas ? ` (${c.corridas.no_leidas} ejecución(es) más no cuentan: el recolector no pudo leer sus hallazgos)` : '')
    + (sinMedir.length ? `; sin medir: ${sinMedir.map((m) => `${m.alias} (${m.motivo})`).join(' · ')}` : '')
    + (c.corridas.descartadas_sin_hallazgos ? `; ${c.corridas.descartadas_sin_hallazgos} ejecución(es) de las máquinas sin medir no se cuentan` : '');
}
function podaPanel(buzon = { estado: 'no_aplica' }) {
  if (AMB.nocturno && buzon.estado !== 'leido') {
    const n = noLeido(buzon);
    return { estado: 'no_medido', motivo: n.motivo, candidatas: n, probadas: n };
  }
  let r;
  try {
    const registros = path.resolve(AMB.logs || stateDirOf(require('os').homedir()));
    r = require('./prune').podar({
      fuentes: AMB.config,
      hallazgos: path.join(registros, 'hallazgos.jsonl'),
      buzon: path.resolve(AMB.mailbox || path.join(stateDirOf(require('os').homedir()), 'corridas-buzon')),
      historia: AMB.runsDir,
      examen: AMB.examen,
      casos: AMB.casos,
      // las dos puntas del cruce salen sólo del buzón — el disco del agente no es una máquina.
      sinLocal: AMB.nocturno,
    });
  } catch (e) {
    // 🔴 El motivo propio del cruce (sus textos son fijos) se publica. Un error inesperado se nombra en la
    //    página por su clase y su mensaje va a la terminal: puede traer rutas del disco, y callado se pierde.
    if (!e.motivo) console.error(`tablero: el cruce de hallazgos por regla falló — ${e.stack || e.message}`);
    const n = noMedida(e.motivo || `el cruce de hallazgos por regla falló (${e.name || 'error'}; el detalle está en la salida de error del tablero)`);
    return { estado: 'no_medido', motivo: n.motivo, candidatas: n, probadas: n };
  }
  const c = r.cobertura;
  const ventana = `${r.ventana.desde} → ${r.ventana.hasta}`;
  const conRevisor = r.total - r.resumen.sin_revisor;
  const examenOk = c.examen.estado === 'medido';
  // Sin examen usable no se puede decir cuáles están probadas NI cuáles son candidatas: las dos fichas callan.
  const candidatas = examenOk
    ? medida(r.resumen.candidata_a_retiro, r.total, r.total, { unidad: 'conteo', den_etiqueta: 'reglas del catálogo',
        detalle: `${ventana} · medido en ${c.hallazgos.maquinas} de ${c.hallazgos.maquinas + (c.hallazgos.maquinas_sin_medir || []).length} máquina(s) · probadas, con cero hallazgos y el recorrido que pide el criterio (${r.umbral.oportunidades} ejecuciones de su revisor en ${r.umbral.meses} meses). Decide una persona.` })
    : noMedida(`sin un examen del banco que se pueda usar no se puede decir cuáles sobran: ${c.examen.motivo}`);
  const probadas = examenOk
    ? { ...ratio(c.banco.examinadas, conRevisor, 'ninguna regla del catálogo tiene un revisor'), den_etiqueta: 'reglas con revisor',
        detalle: `${c.banco.con_caso} tienen un caso que las obliga a marcar; ${c.banco.examinadas} las corrió el último examen (${c.examen.fecha}) y pasaron` }
    : noMedida(`el examen del banco no se puede usar: ${c.examen.motivo}`);
  return {
    estado: 'medido', ventana: r.ventana, umbral: r.umbral, total: r.total, resumen: r.resumen,
    candidatas, probadas,
    denominador: denominadorPoda(c),
    cobertura: c, colisiones: r.colisiones,
    filas: r.filas,
  };
}

// ─────────────── adaptadores para la vista por pregunta ───────────────
// Todo lo que la vista muestra sale de acá. Ningún número se escribe en el HTML: uno tipeado
// envejecería (por ejemplo, «1 de 6 productos vigilados» cuando el archivo real dice 3).

function leerJson(ruta) { try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (e) { return null; } }
/**
 * Un archivo de datos del arnés (repos.json, pipeline-debt.json, declared.json, lane-hypothesis.json): sólo del árbol que se
 * mide (`AMB.raiz`: el repo de operaciones, o la copia que lee el sitio). Si ahí no está, la ficha que lo usa sale «no
 * medida»: el del arnés que corre no es el de la organización.
 */
function datoDelArbol(...partes) {
  return leerJson(path.join(AMB.raiz, ...partes));
}
const SRC = path.dirname(RAIZ); // la carpeta que contiene a todos los repos del equipo

const REPOS_JSON = 'scripts/nightly/dependencies/repos.json';
/** El motivo de una ficha que cuenta productos y no tiene ninguno: el de la lista de repos, o que no nombra productos. */
const sinProductos = (ctx) => ctx.reposMotivo || `${REPOS_JSON} no nombra ningún producto (la clave «producto» de cada repo)`;
function contexto() {
  const rj = datoDelArbol(...REPOS_JSON.split('/'));
  const repos = rj && Array.isArray(rj.repos) ? rj.repos : (Array.isArray(rj) ? rj : []);
  const productos = [...new Set(repos.map((r) => r.producto).filter(Boolean))];
  const debt = datoDelArbol('scripts', 'ci', 'pipeline-debt.json');
  const declarados = datoDelArbol('scripts', 'nightly', 'dashboard', 'declared.json');
  // por qué no hay lista de repos, para el motivo de cada ficha que la usa: falta el archivo, no se lee, o no declara
  // productos. Las tres se dicen distinto: «no medido» sin el archivo nombrado se confunde con una organización sin productos
  const reposMotivo = rj === null
    ? (fs.existsSync(path.join(AMB.raiz, ...REPOS_JSON.split('/'))) ? `${REPOS_JSON} no se lee (no es JSON)` : `falta ${REPOS_JSON}: la organización no declaró sus productos (la lista de productos del equipo no viene con la copia pública; la trae el repo de operaciones)`)
    : (repos.length ? null : `${REPOS_JSON} no declara ningún repo`);
  return { repos, productos, debt, declarados: (declarados && declarados.declared) || [], reposMotivo };
}

/**
 * La ficha de despliegues lee la foto de la noche (scripts/nightly/deployments/deployments.js).
 * «Productos con producción al día» sobre los productos MEDIDOS (los «no medido» no cuentan como atrasados). Sin foto,
 * con una de más de dos días o sin ningún producto medido: «no medido» con el motivo, nunca 0. Pura: la usa la prueba.
 */
function fichaDespliegues(doc, hoy) {
  if (!doc || typeof doc !== 'object') return noMedida('no hay foto de despliegues de la noche');
  const edad = edadDias(doc.generado, Date.parse(`${String(hoy).slice(0, 10)}T23:59:59Z`));
  if (edad === null || edad > 2) return noMedida(`la foto de despliegues es de ${String(doc.generado || 'sin fecha').slice(0, 10)}: más de dos días`);
  const todos = Object.entries(doc.productos || {}).filter(([, p]) => p);
  const medidos = todos.filter(([, p]) => p.estado !== 'no_medido' && typeof p.produccion_atrasada === 'boolean');
  if (medidos.length === 0) return noMedida('ningún producto con staging y producción medidos en la foto de la noche');
  // los que no se pudieron comparar se DICEN: sin esto «N de M al día» sube sin que se vea quién quedó afuera
  const sinComparar = todos.length - medidos.length;
  const atrasados = medidos.filter(([, p]) => p.produccion_atrasada).map(([n]) => n);
  // las vencidas se cuentan sobre TODOS los productos con la aprobación medida (el caso típico es el que nunca llegó a
  // producción: sin despliegue en la ventana, su comparación es null) y se suman sus `cuantas`, no se cuentan productos
  const vencidas = todos.filter(([, p]) => p.aprobacion && p.aprobacion.estado === 'vencida')
    .reduce((n, [, p]) => n + (Number.isInteger(p.aprobacion.cuantas) && p.aprobacion.cuantas > 0 ? p.aprobacion.cuantas : 1), 0);
  const detalle = [atrasados.length ? `producción atrasada: ${atrasados.join(', ')}` : 'ninguno con producción atrasada',
    `${vencidas} ${vencidas === 1 ? 'aprobación vencida' : 'aprobaciones vencidas'}`,
    sinComparar ? `${sinComparar} producto${sinComparar === 1 ? '' : 's'} sin comparar (no medido, sin despliegue o sin commit confiable)` : null].filter(Boolean).join(' · ');
  return medida(medidos.length - atrasados.length, medidos.length, medidos.length, { unidad: 'conteo', den_etiqueta: 'productos medidos', detalle });
}

/**
 * La edad en el estado, de las fotos por proyecto (`.dashboard/proyectos/`) con `stateAge`, la misma
 * definición que usa el sitio. El número es lo empezado (en curso y bloqueado) con más del primer umbral; el detalle,
 * el segundo y los sin dato. Sin fotos o sin los días en `params`, «no medido» con el motivo. Sólo conteos.
 */
function fichaEdad(cfg, ctx) {
  const { stateAge } = require(path.join(__dirname, '..', 'projects', 'state-age.js'));
  const r = stateAge({ photosDir: path.join(AMB.dashboard, 'proyectos'), products: ctx.repos.length ? ctx.repos : null, today: hoyUTC(),
    dias: cfg && cfg.params ? cfg.params.edad_en_estado_dias : undefined });
  if (r.estado !== 'medido') return noMedida(r.motivo);
  const [d1, d2] = r.dias; const t = r.titular;
  // ninguna story empezada con dato no es «ninguna parada»: sin dato no hay número
  if (!t.con_dato) return noMedida(`ninguna story empezada tiene medidos sus días en el estado (${t.sin_dato} sin dato)`);
  return medida(t[`mas_de_${d1}`], t.con_dato, t.con_dato + t.sin_dato, {
    unidad: 'conteo', den_etiqueta: 'stories empezadas con dato',
    detalle: `${t[`mas_de_${d2}`]} más de ${d2} · de ${t.con_dato} con dato · ${t.sin_dato} sin dato`,
    edad: { dias: r.dias, fotos_no_medidas: r.no_medidos.length, productos: r.productos.map((p) => ({
      producto: p.producto, estado: p.estado, motivo: p.motivo, sin_producto_declarado: !!p.sin_producto_declarado,
      compartido_con: p.compartido_con || null, por_estado: p.por_estado, desconocido: p.desconocido })) },
  });
}
// El detalle desplegable producto × estado de la ficha de edad (sólo conteos).
function detalleEdad(m) {
  if (!m || m.estado !== 'medido' || !m.edad) return '';
  const [d1, d2] = m.edad.dias;
  const filas = [];
  for (const p of m.edad.productos) {
    const marca = p.sin_producto_declarado ? ' <span class="muted">(sin producto declarado)</span>' : p.compartido_con ? ` <span class="muted">(compartido con ${p.compartido_con})</span>` : '';
    if (p.estado !== 'medido') { filas.push(`<tr><td>${esc(p.producto)}${marca}</td><td colspan="5" class="muted">no medido: ${esc(p.motivo || '')}</td></tr>`); continue; }
    for (const [estado, c] of Object.entries(p.por_estado)) filas.push(`<tr><td>${esc(p.producto)}${marca}</td><td>${esc(estado)}</td><td>${c.total}</td><td>${c[`mas_de_${d1}`]}</td><td>${c[`mas_de_${d2}`]}</td><td>${c.sin_dato}</td></tr>`);
    if (p.desconocido) filas.push(`<tr><td>${esc(p.producto)}${marca}</td><td class="muted">estado que el diccionario no reconoce</td><td>${p.desconocido}</td><td colspan="3" class="muted">aparte</td></tr>`);
  }
  return `<details style="margin-top:10px"><summary>La edad en el estado, por producto y estado</summary>
    <table><tr><th>Producto</th><th>Estado</th><th>Stories</th><th>Más de ${d1} días</th><th>Más de ${d2}</th><th>Sin dato</th></tr>
    ${filas.join('\n    ')}</table>
    ${m.edad.fotos_no_medidas ? `<p class="chart-note">${m.edad.fotos_no_medidas} foto(s) por proyecto viejas o ilegibles no suman.</p>` : ''}
  </details>`;
}

/**
 * Los cambios de código que llegaron a main sin nombrar su historia, del archivo que deja el nocturno de
 * métricas (`scripts/metrics/story-reference.js`). El número es la parte sin historia de las entradas de código de los 28
 * días; el detalle trae las tablas por repo, por persona (con su nombre, para saber con quién hablar) y por tipo. Al sitio
 * llega sólo el número (`scripts/site/tabs/cards.js`).
 */
function fichaSinHistoria(f) {
  return desde(f, (d) => {
    const t = d.totales; const c = d.cobertura || {};
    if (!t || !Number.isFinite(t.codigo) || !Number.isFinite(t.sin)) throw new Error('faltan los totales');
    if (!c.repos_medidos) return noMedida('ningún repo medido en el archivo del día');
    const r = ratio(t.sin, t.codigo, 'ninguna entrada de código en la ventana');
    if (r.estado !== 'medido') return r;
    const v = t.por_via || {};
    const via = (k) => (v[k] && Number.isFinite(v[k].sin) && Number.isFinite(v[k].con) ? `${v[k].sin} de ${v[k].con + v[k].sin}` : '—');
    return { ...r, den_etiqueta: 'entradas de código', fecha: (f.ts || '').slice(0, 10),
      detalle: `${t.sin} de ${t.codigo} en ${(d.ventana && d.ventana.dias) || 28} días · por pedido ${via('pedido')}, directo a main ${via('directo')} · ${c.repos_medidos} de ${c.repos_declarados} repos medidos`,
      sin_historia: { repos: Array.isArray(d.repos) ? d.repos : [], por_persona: t.por_persona || {}, por_tipo: t.por_tipo || {} } };
  });
}
const TIPOS_SIN_HISTORIA = { hotfix: 'hotfix', dependencias: 'dependencias', arnes_ci: 'arnés y CI', merge_dev: 'merge de dev sin detalle', otro: 'otro' };
// El detalle desplegable de la ficha de cambios sin historia: por repo, por persona y por tipo.
function detalleSinHistoria(m) {
  if (!m || m.estado !== 'medido' || !m.sin_historia) return '';
  const { repos, por_persona: pp, por_tipo: pt } = m.sin_historia;
  // un número que falta o no se lee sale «—», nunca 0
  const ok = (x) => Number.isFinite(x);
  const n = (x) => (ok(x) ? String(x) : '—');
  const fr = repos.map((r) => (r.estado === 'medido'
    ? `<tr><td>${esc(r.repo)}</td><td>${n(r.codigo)}</td><td>${n(r.sin)}</td><td>${ok(r.sin) && ok(r.codigo) && r.codigo ? pct(r.sin / r.codigo) : '—'}</td></tr>`
    : `<tr><td>${esc(r.repo)}</td><td colspan="3" class="muted">no medido: ${esc(r.motivo || '')}</td></tr>`));
  const sinDe = (c) => (c && ok(c.sin) ? c.sin : -1);
  const fp = Object.entries(pp).sort((a, b) => sinDe(b[1]) - sinDe(a[1]) || a[0].localeCompare(b[0]))
    .map(([quien, c]) => `<tr><td>${esc(quien)}</td><td>${c && ok(c.con) && ok(c.sin) ? c.con + c.sin : '—'}</td><td>${n(c && c.sin)}</td></tr>`);
  const ft = Object.entries(TIPOS_SIN_HISTORIA).map(([k, nombre]) => `<tr><td>${esc(nombre)}</td><td>${n(pt[k])}</td></tr>`);
  return `<details style="margin-top:10px"><summary>Los cambios de código sin historia, por repo, por persona y por tipo</summary>
    <table><tr><th>Repo</th><th>Entradas de código</th><th>Sin historia</th><th>%</th></tr>
    ${fr.join('\n    ')}</table>
    <table><tr><th>Persona</th><th>Entradas de código</th><th>Sin historia</th></tr>
    ${fp.join('\n    ')}</table>
    <table><tr><th>Tipo (de las que no nombran historia)</th><th>Entradas</th></tr>
    ${ft.join('\n    ')}</table>
  </details>`;
}

function extra(por, ctx, cfg) {
  const m = {};
  m.despliegues = desde(por.deployments, (d) => fichaDespliegues(d, new Date().toISOString()));
  m.edad_estado = fichaEdad(cfg, ctx);
  m.sin_historia = fichaSinHistoria(por['story-reference']);
  const sdlc = por['sdlc-stage'];

  m.por_repo = desde(sdlc, (d) => ({
    estado: 'medido',
    repos: (d.repos || []).map((r) => {
      const st = Number.isFinite(r.stories_total) ? r.stories_total : null;
      const dn = Number.isFinite(r.done_total) ? r.done_total : null;
      // 🔴 `en_curso` se usa en lugar de la resta `stories_total − done_total`: es la
      //    misma resta que la ficha de arriba descarta, y dejarla publicaría el
      //    número descartado justo abajo del nuevo. `null` cuando el repo no trae el campo — no 0.
      const epc = r.estados_por_canonico;
      const enCurso = epc && epc.por_grupo && Number.isFinite(epc.por_grupo.en_curso)
        ? epc.por_grupo.en_curso : null;
      return { nombre: String(r.repo || '').split('/').pop().replace(/__/g, ' / '), stories: st, done: dn,
        en_curso: enCurso, rework: r.rework_ratio || null,
        dod: r.dod_evidence_ratio || null, sin_medir: (r.not_measured || []).length };
    }),
  }));

  // ── el trabajo en curso, el backlog y lo que el diccionario no reconoce ─────────
  //
  // Una sola ficha con la resta `stories_total − done_total` («Stories abiertas en toda la historia
  // medida») sería casi inútil para decidir: mezcla una story que alguien está desarrollando ahora con una
  // escrita hace meses que nadie va a tocar, y no dice si hay tres cosas en vuelo o ciento veinte.
  //
  // 🔴 Los tres números salen del SNAPSHOT ya sumado (`estados_por_canonico.por_grupo`), NO de
  //    leer `states.json` del disco. El tablero se renderiza cuando alguien lo corre, con un
  //    snapshot que pudo generarse ayer: si entonces alguien mueve un canónico de grupo, las
  //    stories de ese estado desaparecerían de los tres números y nada lo delataría — los tres no
  //    suman al total por diseño (cerrado y cancelado no se muestran), así que faltar uno más no
  //    se nota. Una sola fuente, y es la que midió.
  const SIN_CAMPO = 'el snapshot no trae el conteo de estados por canónico (es anterior a la story 2.2)';
  const suma = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
  // Lectura EXPLÍCITA. El idioma corto para poner un cero por defecto convierte «no pude mirar»
  // en «miré y da cero», y por eso el chequeo C-10 de la suite lo prohíbe en este archivo. Acá se
  // llega SÓLO con el campo ya validado, así que una clave ausente sí significa «ninguna story en
  // ese estado» — y eso se dice preguntando por la clave, no se deja implícito.
  const cuenta = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : 0);

  /** Una de las tres fichas. `valorDe` recibe el campo del global ya validado. */
  const fichaEstados = (valorDe, detalleDe) => desde(sdlc, (d) => {
    const rs = d.repos || [];
    const e = (d.global || {}).estados_por_canonico;
    // Sin default `{}`: un objeto vacío dibujaría tres ceros, y «0 en curso» se lee como «no hay
    // nada en vuelo» — la mentira más cara que este tablero puede contar.
    if (!e || !e.por_grupo || !Number.isFinite(e.total)) return noMedida(SIN_CAMPO);
    const con = rs.filter((r) => r.estados_por_canonico).length;
    const v = valorDe(e);
    if (!Number.isFinite(v)) return noMedida(`${SIN_CAMPO}: falta el grupo pedido`);
    return medida(v, v, e.total, {
      unidad: 'conteo',
      den_etiqueta: `stories · ${con} de ${rs.length} repos`,
      detalle: detalleDe(e),
    });
  });

  // 🔴 «En curso» se DESGLOSA por canónico, y no es decoración: si la mayoría de lo «en curso»
  //    está en `review` y poco en desarrollo, eso no es trabajo fluyendo, es una cola de cierres pendientes. Sin el desglose la ficha esconde
  //    lo que más importa y del lado que da lindo — y la ficha vecina no lo rescata, porque el
  //    tiempo por etapa excluye por diseño la etapa en la que la story está AHORA.
  m.en_curso = fichaEstados(
    (e) => e.por_grupo.en_curso,
    // Las bloqueadas NO están adentro de «en curso» (una story bloqueada no es trabajo que está
    // pasando), pero tampoco se esconden: si hay alguna, se nombra acá.
    (e) => `${cuenta(e.conteo, 'in-progress')} en desarrollo · ${cuenta(e.conteo, 'review')} en revisión`
      + (cuenta(e.por_grupo, 'bloqueado') ? ` · ${cuenta(e.por_grupo, 'bloqueado')} bloqueadas, fuera de esta cuenta` : ''));

  m.backlog = fichaEstados(
    (e) => e.por_grupo.backlog,
    (e) => `${cuenta(e.conteo, 'ready-for-dev')} ya listas para desarrollar`);

  // 🔴 Lee `sin_diccionario` (el contador ACTUAL), no el `estados_desconocidos` que ya existe (el
  //    HISTÓRICO): son dos números distintos y el histórico no cuadra con este denominador.
  m.estados_sin_diccionario = desde(sdlc, (d) => {
    const rs = d.repos || [];
    const e = (d.global || {}).estados_por_canonico;
    if (!e || !e.sin_diccionario || !Number.isFinite(e.total)) return noMedida(SIN_CAMPO);
    const con = rs.filter((r) => r.estados_por_canonico).length;
    // 🔴 Desempate por NOMBRE, no por orden de llegada. El orden de las claves viene de cómo el
    //    medidor recorrió los repos: con dos estados empatados, cuál entra al top-3 lo decidía
    //    ese recorrido, así que la misma realidad podía mostrar listas distintas entre corridas.
    const top = Object.entries(e.sin_diccionario)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
    return medida(suma(e.sin_diccionario), suma(e.sin_diccionario), e.total, {
      unidad: 'conteo',
      den_etiqueta: `stories · ${con} de ${rs.length} repos`,
      // Se NOMBRAN, no sólo se cuentan: son la lista de trabajo del próximo diccionario, y
      // esconderlos es exactamente cómo un diccionario se queda viejo.
      detalle: top.length ? top.map(([k, n]) => `${k} ${n}`).join(' · ') : 'ninguno',
    });
  });

  m.lead_mensual = desde(sdlc, (d) => {
    const ms = (d.global && d.global.lead_time_monthly) || [];
    const ok = ms.filter((x) => x && x.month && Number.isFinite(x.median) && Number.isFinite(x.mean) && Number.isFinite(x.n));
    if (!ok.length) return noMedida('el snapshot no trae la serie mensual');
    return { estado: 'medido', meses: ok };
  });

  // Tiempo por etapa. El snapshot lo trae `null` —no `{}`— cuando no se pudo medir,
  // así que acá NO hay default: si falta, `noMedida` con el motivo. Un `{}` por defecto sería una
  // ficha de ceros, que es la mentira que este tablero existe para no contar.
  m.tiempo_por_etapa = desde(sdlc, (d) => {
    const t = (d.global || {}).tiempo_por_etapa;
    if (!t || !Object.keys(t).length) return noMedida('el snapshot no trae el tiempo por etapa');
    const es = Object.entries(t).filter(([, v]) => v && Number.isFinite(v.median) && Number.isFinite(v.n));
    if (!es.length) return noMedida('el snapshot trae la clave pero ninguna etapa con mediana y n');
    // «donde se queda parado el trabajo» no puede ser un estado TERMINAL (`done` es el final, no una
    // espera) ni una etapa con menos stories que el piso del reductor (`backlog` con 2
    // stories le ganaría por milésimas a `review` con 344). Los terminales salen del diccionario de estados —los grupos
    // `cerrado` y `sin_entrega`—, nunca de una lista escrita acá; el detalle sigue listando todas las etapas.
    const floor = cfg && cfg.reducer ? cfg.reducer.floor : undefined;
    if (!Number.isInteger(floor) || floor < 1) return noMedida('la configuración del reductor no declara el piso (reducer.floor)');
    let terminales;
    try {
      const dic = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'metrics', 'states.json'), 'utf8'));
      const g = dic && dic.groups;
      if (!g || !Array.isArray(g.cerrado) || !Array.isArray(g.sin_entrega)) throw new Error('sin los grupos cerrado y sin_entrega');
      terminales = new Set([...g.cerrado, ...g.sin_entrega]);
    } catch (e) { return noMedida('no pude leer el diccionario de estados (scripts/metrics/states.json): sin él no se sabe qué etapa es terminal'); }
    const candidatas = es.filter(([k, v]) => !terminales.has(k) && v.n >= floor);
    if (!candidatas.length) return noMedida(`ninguna etapa no terminal llega al piso de ${floor} stories`, { detalle: es.map(([k, v]) => `${k} ${num1(v.median)} d · n=${v.n}`).join(' · ') });
    const [lenta, s] = [...candidatas].sort((a, b) => b[1].median - a[1].median)[0];
    return medida(s.median, s.n, s.n, { unidad: 'dias', den_etiqueta: `stories que pasaron por ${lenta}`,
      detalle: es.map(([k, v]) => `${k} ${num1(v.median)} d · n=${v.n}`).join(' · '),
      etapa_lenta: lenta });
  });

  m.repos_en_cero_dod = desde(sdlc, (d) => {
    const rs = (d.repos || []).filter((r) => r.dod_evidence_ratio && Number.isFinite(r.dod_evidence_ratio.den) && r.dod_evidence_ratio.den > 0);
    const cero = rs.filter((r) => r.dod_evidence_ratio.num === 0);
    return medida(cero.length, rs.length, rs.length, { unidad: 'conteo', den_etiqueta: 'repos con cierres',
      detalle: cero.map((r) => `${String(r.repo).split('/').pop().replace(/__/g, ' / ')} 0 de ${r.dod_evidence_ratio.den}`).join(' · ') });
  });

  // ── Por qué volvió: la causa del reproceso en cinco barras ──────────────────────
  //
  // 🔴 Sale del SNAPSHOT ya contado, no de leer `rework-causes.json` del disco — mismo motivo
  //    que los tres números de «en curso»: el tablero se renderiza cuando alguien lo
  //    corre, con una foto que pudo generarse ayer con otro vocabulario. Ninguna lista de causas
  //    en este archivo: las etiquetas legibles se derivan de la clave que vino en el snapshot.
  m.rework_por_causa = desde(sdlc, (d) => {
    const x = d.global && d.global.rework_por_causa;
    if (!x || !Number.isFinite(x.total)) {
      return noMedida('el snapshot no trae la causa del reproceso (es anterior a la story 2.3)');
    }
    const conRep = (d.repos || []).filter((r) => r.rework_por_causa).length;
    // Lectura EXPLÍCITA de cada balde: el idioma corto para poner un cero por defecto convierte
    // «no pude mirar» en «miré y da cero», y el chequeo C-10 lo prohíbe en este archivo.
    const cuenta = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : 0);
    const barras = Object.keys(x.conteo || {}).map((k) => ({ clave: k, n: cuenta(x.conteo, k) }));
    barras.push({ clave: 'sin-declarar', n: Number.isFinite(x.sin_declarar) ? x.sin_declarar : 0 });
    const tipos = Object.entries(x.sin_declarar_por_type || {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    const fuera = Object.entries(x.fuera_de_vocabulario || {})
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    // Mismo formato de denominador que las tres fichas de «en curso»: el universo primero, la
    // cobertura de repos después. El valor es el TOTAL de seguimientos, que es el denominador de
    // las cinco barras — sin él, «9 sin declarar» no dice si es de 16 o de 900.
    return medida(x.total, x.total, x.total, {
      unidad: 'conteo',
      den_etiqueta: `sobre ${x.total} seguimientos · ${conRep} de ${(d.repos || []).length} repos`,
      barras, tipos_sin_declarar: tipos, fuera_de_vocabulario: fuera,
    });
  });

  // ── El reproceso por CARRIL ─────────────────────────────────────────────────────
  // 🔴 La hipótesis y el mínimo se LEEN de `scripts/metrics/lane-hypothesis.json`, commiteado antes
  //    de mirar un número. Sin ese archivo (o con un mínimo que no es un entero ≥ 1) no se dibuja.
  // 🔴 Por repo y sólo por repo: el valor es cuántos repos se pueden comparar, no una proporción
  //    global — sumar entre productos mezcla ventanas y equipos distintos.
  // 🔴 Bajo el mínimo el repo NO publica su proporción: dice cuánto falta. Y el resultado en contra
  //    del pipeline sale igual que el resultado a favor: la ficha no juzga, no tiene color.
  m.rework_por_carril = desde(sdlc, (d) => {
    const rutaH = readEnv('TYCON_LANE_HYPOTHESIS', { where: 'scripts/nightly/dashboard/dashboard.js' });
    const h = rutaH ? leerJson(rutaH) : datoDelArbol('scripts', 'metrics', 'lane-hypothesis.json');
    const nMin = h && Number.isInteger(h.min_n_per_group) && h.min_n_per_group >= 1 ? h.min_n_per_group : null;
    if (!h || !nMin) return noMedida('la hipótesis del reproceso por carril no está declarada (scripts/metrics/lane-hypothesis.json, con su mínimo por grupo): sin ella no se dibuja');
    const rs = (d.repos || []).filter((r) => r && Object.prototype.hasOwnProperty.call(r, 'rework_por_carril'));
    if (!rs.length) return noMedida('el snapshot no trae el reproceso por carril (es anterior a la story 2.7)');
    const nombre = (r) => String(r.repo).split('/').pop().replace(/__/g, ' / ');
    const par = (g) => (g && Number.isInteger(g.num) && Number.isInteger(g.den) ? g : null);
    const pctDe = (g) => `${Math.round((g.num / g.den) * 100)} %`;
    const lineas = [];
    let comparables = 0;
    let conCarpeta = 0;
    for (const r of rs) {
      const x = r.rework_por_carril;
      if (!x) continue;
      const con = par(x.con_corrida), sin = par(x.sin_constancia);
      if (!con || !sin) continue;
      conCarpeta += 1;
      // Texto PLANO: lo escapa `ficha()` una sola vez. Con `<b>` y `esc()` acá, la página mostraría
      // `&lt;b&gt;` y el `--json` llevaría etiquetas.
      if (con.den >= nMin && sin.den >= nMin) {
        comparables += 1;
        lineas.push(`${nombre(r)}: con ejecución volvieron ${con.num} de ${con.den} (${pctDe(con)}) · sin constancia ${sin.num} de ${sin.den} (${pctDe(sin)})`);
      } else {
        const falta = [con.den < nMin ? `${nMin - con.den} con ejecución` : null, sin.den < nMin ? `${nMin - sin.den} sin constancia` : null].filter(Boolean).join(' y ');
        lineas.push(`${nombre(r)}: todavía no se compara — faltan ${falta} (desde ${String(x.desde || '?')})`);
      }
    }
    const sinCarpeta = rs.length - conCarpeta;
    if (!conCarpeta) return noMedida(`ningún repo guarda las ejecuciones del pipeline todavía (${rs.length} medidos): no hay con qué separar los carriles`);
    const detalle = `${lineas.join(' · ')}${sinCarpeta ? ` · ${sinCarpeta} repo(s) no guardan ejecuciones: no se comparan` : ''}`;
    if (!comparables) return noMedida(`ningún repo llega al mínimo de ${nMin} stories cerradas por grupo — ${detalle}`, { detalle });
    return medida(comparables, comparables, conCarpeta, { unidad: 'conteo', den_etiqueta: `repos comparables de ${conCarpeta} que guardan ejecuciones · mínimo ${nMin} por grupo`, detalle });
  });

  m.rework_top = desde(sdlc, (d) => {
    const rs = (d.repos || []).filter((r) => r.rework_ratio && r.rework_ratio.den >= 5).map((r) => ({ n: String(r.repo).split('/').pop().replace(/__/g, ' / '), v: r.rework_ratio.num / r.rework_ratio.den, num: r.rework_ratio.num, den: r.rework_ratio.den }));
    if (!rs.length) return noMedida('ningún repo con al menos 5 cierres');
    rs.sort((a, b) => b.v - a.v);
    return { estado: 'medido', top: rs.slice(0, 3) };
  });

  m.vigilados = desde(por.vigilante, (d) => {
    const ok = Object.entries(d.productos || {}).filter(([, v]) => v && v.ok).map(([k]) => k);
    if (!ctx.productos.length) return noMedida(sinProductos(ctx));
    return { ...ratio(ok.length, ctx.productos.length), den_etiqueta: 'productos declarados', detalle: ok.length ? `vigilados: ${ok.join(' · ')}` : 'ninguno' };
  });

  m.sin_prod = (() => {
    if (!ctx.debt || !Array.isArray(ctx.debt.debt)) return noMedida('no se pudo leer la deuda declarada de pipelines');
    if (!ctx.productos.length) return noMedida(sinProductos(ctx));
    const abiertas = ctx.debt.debt.filter((x) => /^PROD-PIPELINE-/.test(String(x.id)));
    const nombres = abiertas.map((x) => String(x.id).replace(/^PROD-PIPELINE-/, '').replace(/-\d+$/, '').toLowerCase());
    const rev = abiertas.map((x) => x.revision).filter(Boolean).sort()[0];
    return medida(abiertas.length, ctx.productos.length, ctx.productos.length, { unidad: 'conteo', den_etiqueta: 'productos declarados',
      detalle: `${nombres.join(' · ')}${rev ? ` · deuda con revisión ${rev}` : ''}` });
  })();

  // La familia del capturador: contrato y fechas, con loadAll (no se reimplementa el parser), sobre la raíz y merges/,
  // un registro por merge.
  try {
    const dm = require(path.join(RAIZ, 'scripts', 'lib', 'dashboard-metrics.js'));
    const { records, counts, unreadableDirs } = dm.loadPorMerge([AMB.dashboard]);
    noSeLeyo(unreadableDirs);
    m.contrato_v2 = counts.total ? { ...ratio(counts.v2ok, counts.total), den_etiqueta: 'registros' } : noMedida('no hay registros del capturador');
    const fuentes = {};
    for (const r of records) inc(fuentes, r.date_source || 'ninguna');
    const declaradas = records.filter((r) => r.date_source && r.date_source !== 'filename').length;
    m.fechas_declaradas = counts.total
      ? { ...ratio(declaradas, records.length), den_etiqueta: 'registros', detalle: Object.entries(fuentes).map(([k, v]) => `${k} ${v}`).join(' · ') }
      : noMedida('no hay registros del capturador');
  } catch (e) { m.contrato_v2 = noMedida(`no se pudo cargar la familia del capturador: ${e.message}`); m.fechas_declaradas = m.contrato_v2; }

  // Declarados: los escribió una persona. Se muestran con marca propia y vencen.
  m.declarados = {};
  const hoyISO = new Date().toISOString().slice(0, 10);
  for (const dcl of ctx.declarados) {
    if (!dcl.review_before) { m.declarados[dcl.id] = noMedida('declaración sin fecha de revisión: no ampara'); continue; }
    if (dcl.review_before < hoyISO) { m.declarados[dcl.id] = noMedida(`declaración vencida el ${dcl.review_before} (fuente: ${dcl.source})`); continue; }
    m.declarados[dcl.id] = medida(dcl.valor, dcl.measured, dcl.total, { unidad: dcl.unit || 'conteo', den_etiqueta: dcl.den_label, detalle: dcl.detail, prov: 'declarada', fuente: dcl.source, fecha: dcl.date, titulo: dcl.title });
  }
  return m;
}

/**
 * La concentración por persona, del archivo del nocturno o de la misma función en local
 * (`scripts/metrics/author-concentration.js#concentracion`). Por producto: «N de M medidos», el detalle «producto NN %»
 * —nunca un repo ni una persona—. Sin ningún producto medido, «no medido» con el motivo; nunca 0. Pura: la usa la prueba.
 */
function fichaConcentracion(doc) {
  const ps = doc && Array.isArray(doc.productos) ? doc.productos : [];
  const med = ps.filter((p) => p && p.estado === 'medido' && Number.isFinite(p.concentracion)).sort((a, b) => b.concentracion - a.concentracion);
  if (!med.length) {
    // los motivos que trae el archivo (por producto), no uno fijo: «sin la lista de máquinas» no es «poca actividad»
    const motivos = [...new Set(ps.map((p) => p && p.motivo).filter(Boolean))];
    return noMedida(motivos.length ? `ningún producto medido: ${motivos.slice(0, 3).join('; ')}` : 'ningún producto declarado en el archivo de concentración');
  }
  const cob = (doc && doc.cobertura) || {};
  const riesgo = med.filter((p) => p.en_riesgo === true);
  return medida(riesgo.length, med.length, Number.isFinite(cob.productos_declarados) ? cob.productos_declarados : ps.length, { unidad: 'conteo', den_etiqueta: 'productos medidos',
    detalle: med.map((p) => `${p.producto} ${pct(p.concentracion)}`).join(' · ')
      + (Number.isFinite(cob.repos_medidos) ? ` · ${cob.repos_medidos} de ${cob.repos_declarados} repos declarados medidos (20 commits o más en 12 meses)` : '') });
}

// Más anillo local: calidad de las pruebas y dependencia de personas.
function localExtra(ctx, por, cfg) {
  const m = {};
  // Bus factor: la concentración del autor principal por producto DECLARADO, nunca el nombre. En el
  // nocturno la lee del archivo que deja el nocturno de métricas (la fuente `concentracion`); en una máquina, la calcula
  // con la MISMA función sobre los repos del disco (por `ruta`), así el número es el mismo.
  if (AMB.nocturno) {
    const f = por && por.concentracion;
    if (f && f.vigente) m.bus_factor = fichaConcentracion(f.doc);
    else if (!ctx.repos.length) m.bus_factor = noMedida(ctx.reposMotivo);
    else m.bus_factor = noMedida(f ? (f.motivo || 'el archivo de concentración no está al día') : 'la fuente «concentracion» no está declarada en sources.json');
    return m;
  }

  // Mutación y guía de QA no se leen acá: salen de `equipo()`, que cuenta los registros de todas las máquinas.
  // Leerlas acá publicaría el estado crudo de cada línea de guía en el detalle —la prueba de fuga lo caza con un
  // nombre de cliente sembrado— y la proporción de guías presentes sería 0 por construcción.

  if (!ctx.repos.length) m.bus_factor = noMedida(ctx.reposMotivo);
  else {
    const ac = require(path.join(__dirname, '..', '..', 'metrics', 'author-concentration.js'));
    const r = ac.concentracion({ repos: ac.resolverLocal(ctx.repos, SRC), today: hoyUTC(), maquinas: ac.maquinasDe(cfg) });
    m.bus_factor = fichaConcentracion(r);
  }

  // Los repos declarados contra el disco no son de esta página: son de cada máquina y los
  // dice `harness.js doctor`, contra la lista de la organización.
  return m;
}

// ───────────────────────────── el render: por PREGUNTA, no por fuente ─────────────────────────────
// Un tablero de comando se ordena por el orden en que una persona decide qué mirar hoy. La cero es
// "¿está midiendo?", porque si eso no se contesta el resto vale cero. Cuatro reglas de presentación:
//   1. «No medido» se dibuja con TRAMA, no con color: un hueco no puede parecerse a un verde ni a un rojo.
//   2. Toda ficha lleva su denominador a la vista.
//   3. Los estados van con GLIFO y PALABRA además de color: ámbar y rojo quedan a ΔE 3,8 en visión
//      deutan (medido con el validador de paletas) — para una parte de la sala son el mismo color.
//   4. Los huecos van en la misma pantalla que los logros.

/**
 * Las cinco barras de «por qué volvió», en HTML plano — no hay render de barras
 * genérico en este archivo y no se agrega uno para un solo uso.
 *
 * La etiqueta legible se DERIVA de la clave del snapshot (`defecto-propio` → «Defecto propio»):
 * una tabla de nombres acá sería una tercera copia del vocabulario, y las copias se separan solas.
 * La barra de «sin declarar» va con trama y con la palabra: es la única que el lector tiene que
 * poder distinguir de un vistazo, porque no es una causa — es la ausencia de una.
 */
function barrasCausa(m) {
  const bs = Array.isArray(m.barras) ? m.barras : [];
  if (!bs.length) return '';
  const max = Math.max(1, ...bs.map((b) => b.n));
  const legible = (k) => {
    const s = String(k).replace(/-/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  return `<div class="causas">${bs.map((b) => {
    const sd = b.clave === 'sin-declarar';
    return `<div class="causa-barra${sd ? ' sd' : ''}"><span class="cn">${esc(legible(b.clave))}</span>`
      + `<span class="cb"><i style="width:${Math.round((b.n / max) * 100)}%"></i></span>`
      + `<span class="cv">${b.n}</span></div>`;
  }).join('')}</div>`;
}

function filaFuente(f) {
  const est = !f.leida ? 'bad' : !f.vigente ? 'warn' : 'ok';
  const palabra = !f.leida ? 'no se pudo leer' : !f.vigente ? 'dato viejo' : 'al día';
  return `<div class="src ${est}"><span class="who">${esc(f.title)}<br><small>${esc(f.written_by)}</small></span><span>${chip(est, palabra)}</span><span class="age">${esc(edadTexto(f.edad_dias))}</span><span class="ser">${f.archivos} archivo${f.archivos === 1 ? '' : 's'}${f.archivos === 1 ? ' · sin serie todavía' : ''}</span><span class="why">${esc(f.motivo || '')}</span></div>`;
}

function grafico(lm) {
  if (!lm || lm.estado !== 'medido') return `<div class="tile blind">${chip('blind', 'no medido')}<div class="t-label">Vida de una story por mes de cierre</div><div class="t-val">falta</div><div class="t-den">${esc((lm && lm.motivo) || '')}</div></div>`;
  const meses = lm.meses.slice(-8);
  // el mes UTC de hoy todavía no cerró. Se dibuja, con la palabra «en curso»; la nota habla del último
  // mes ANTERIOR. Llamarlo cerrado con quince días de datos era lo que engañaba.
  const enCurso = hoyUTC().slice(0, 7);
  const W = 720, H = 250, x0 = 58, x1 = 700, base = 200, top = 20;
  const maxV = Math.max(30, ...meses.map((x) => Math.max(x.mean, x.median)));
  const y = (v) => base - (v / maxV) * (base - top);
  const paso = (x1 - x0) / meses.length;
  const NOM = { '01': 'ene', '02': 'feb', '03': 'mar', '04': 'abr', '05': 'may', '06': 'jun', '07': 'jul', '08': 'ago', '09': 'sep', '10': 'oct', '11': 'nov', '12': 'dic' };
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;min-width:520px;display:block" role="img" aria-label="Vida de una story por mes: mediana en barras, media en anillos.">`;
  const ticks = [0, Math.round(maxV / 3), Math.round(2 * maxV / 3), Math.round(maxV)];
  s += '<g font-family="IBM Plex Mono, monospace" font-size="11" fill="var(--ink-3)">';
  for (const t of ticks) s += `<line x1="${x0}" y1="${y(t)}" x2="${x1}" y2="${y(t)}" stroke="var(--line)" stroke-width="1"></line><text x="${x0 - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  s += '</g>';
  meses.forEach((mth, i) => {
    const cx = x0 + paso * i + paso / 2, bw = Math.min(66, paso * 0.55);
    s += `<rect x="${cx - bw / 2}" y="${y(mth.median)}" width="${bw}" height="${Math.max(2, base - y(mth.median))}" fill="var(--accent)" rx="2"></rect>`;
    s += `<circle cx="${cx}" cy="${y(mth.mean)}" r="5.5" fill="none" stroke="var(--ink-2)" stroke-width="2"></circle>`;
    s += `<text x="${cx}" y="${y(mth.median) - 6}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="11.5" font-weight="600" fill="var(--ink)">${num1(mth.median)}</text>`;
    s += `<text x="${cx}" y="${y(mth.mean) - 9}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="11" fill="var(--ink-2)">${num1(mth.mean)}</text>`;
    s += `<text x="${cx}" y="220" text-anchor="middle" font-family="IBM Plex Sans, sans-serif" font-size="12" fill="var(--ink-2)">${NOM[mth.month.slice(5, 7)] || mth.month} ${mth.month.slice(2, 4)}</text>`;
    s += `<text x="${cx}" y="236" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="10" fill="var(--ink-3)">n=${mth.n}${mth.month === enCurso ? ' · en curso' : ''}</text>`;
  });
  s += '</svg>';
  const cerrados = lm.meses.filter((x) => x.month < enCurso);
  const ult = cerrados[cerrados.length - 1];
  const nota = ult ? `Último mes cerrado (${esc(ult.month)}): mediana ${num1(ult.median)} días, media ${num1(ult.mean)}. <b>La distancia entre las dos es el número que importa</b>: cuando se abre, hay trabajo parado semanas que el promedio esconde.`
    : meses.length ? 'La serie trae sólo el mes en curso: todavía no hay un mes cerrado en la serie.' : '';
  return `<div class="chart-card"><div class="chart-head"><div class="chart-title">Vida de una story, por mes de cierre — días</div><div class="legend"><span><i class="bar-key"></i>mediana</span><span><i class="ring-key"></i>media</span></div></div><div class="chart-scroll">${s}</div><p class="chart-note">${nota}</p></div>`;
}

/**
 * La tabla del criterio de poda. Arriba, los siete estados con su número; abajo, una fila por (dueño,
 * regla) de los estados que piden a alguien: candidatas, rotas, revisión humana y sin recorrido. Las 300 y
 * pico «activas» y «sin probar» se cuentan pero no se listan: una tabla que nadie puede recorrer no poda nada.
 */
function tablaPoda(P) {
  if (!P || P.estado !== 'medido') {
    return `<details><summary>Hallazgos por regla, con su denominador</summary><p class="chart-note">${chip('blind', 'no medido')} ${esc((P && P.motivo) || 'sin datos')}</p></details>`;
  }
  const orden = ['candidata_a_retiro', 'rota', 'revision_humana', 'sin_oportunidades_suficientes'];
  const filas = P.filas.filter((f) => orden.includes(f.estado))
    .sort((a, b) => orden.indexOf(a.estado) - orden.indexOf(b.estado) || (a.dueno < b.dueno ? -1 : a.dueno > b.dueno ? 1 : (a.regla < b.regla ? -1 : 1)));
  const c = P.cobertura;
  const colision = (P.colisiones || []).length
    ? ` <b>${P.colisiones.length} identificador(es) tienen dos dueños</b> (${P.colisiones.map((x) => esc(x.regla)).join(', ')}): la tabla cuenta por (dueño, regla), no por identificador.`
    : '';
  return `<details><summary>Hallazgos por regla, con su denominador — ${P.total} reglas, del ${esc(P.ventana.desde)} al ${esc(P.ventana.hasta)}</summary>
    <table><tr><th>Estado</th><th>Reglas</th></tr>
    ${Object.entries(P.resumen).map(([e, n]) => `<tr><td>${esc(ETIQUETA_ESTADO[e] || e)}</td><td>${n}</td></tr>`).join('\n    ')}
    </table>
    <table><tr><th>Dueño</th><th>Regla</th><th>Estado</th><th>Hallazgos</th><th>Ejecuciones de su revisor</th><th>Meses</th></tr>
    ${filas.map((f) => `<tr><td>${esc(f.dueno)}</td><td>${esc(f.regla)}</td><td>${esc(ETIQUETA_ESTADO[f.estado] || f.estado)}${f.estado === 'candidata_a_retiro' ? ' · sabe ponerse roja' : ''}</td><td>${f.hallazgos}</td><td>${f.oportunidades === null ? '—' : f.oportunidades}</td><td>${f.meses === null ? '—' : f.meses}</td></tr>`).join('\n    ')}
    </table>
    <p class="chart-note">${esc(P.denominador)}. ${c.corridas.sin_por_tipo} ejecuciones no dejaron el conteo por revisor y no aportan: no son cero. ${c.banco.huerfanos ? `${c.banco.huerfanos} caso(s) del banco apuntan a una regla que el catálogo le asigna a otro dueño.` : ''}${colision} Se listan sólo los estados que piden una decisión; «activa», «sin probar» y «sin revisor» se cuentan arriba.</p>
  </details>`;
}

/**
 * El sello de la página: de cuándo es, con qué snapshot, quién la generó y si leyó el buzón. Lo leen el
 * pipeline (prueba de vida) y el aviso de arranque; la forma vive en `seal.js`, que lo valida al escribirlo.
 */
function selloDe(d, ahora) {
  const sdlc = d.por && d.por['sdlc-stage'];
  const snapshot = sdlc && sdlc.leida && sdlc.ultimoArchivo ? fechaDelNombre(sdlc.ultimoArchivo) : null;
  const corrida = AMB.nocturno && /^\d{1,20}$/.test(process.env.BUILD_BUILDID || '') ? process.env.BUILD_BUILDID : null;
  const b = d.buzon || { estado: 'no_aplica' };
  const maquinas = d.paneles && d.paneles.local ? d.paneles.local.maquinas_equipo : null;
  let buzon;
  if (!AMB.nocturno) buzon = { estado: 'no_aplica' };
  else if (b.estado !== 'leido') buzon = { estado: 'no_leido', motivo: String(b.motivo || 'sin motivo').slice(0, 300) };
  // Leído, pero la cuenta no pudo decir cuántas máquinas entraron: las fichas del equipo no tienen número.
  else if (!Number.isInteger(maquinas) || maquinas < 0) buzon = { estado: 'no_leido', motivo: 'la cuenta de los registros del buzón falló' };
  else buzon = { estado: 'leido', maquinas };
  return {
    // el modo del nocturno se graba con su nombre registrado (seal.js)
    esquema: 1, generado: ahora, snapshot: snapshot || null, modo: AMB.nocturno ? require('./seal').NIGHTLY_RECORDED : 'local', corrida,
    fuentes: { esperadas: d.cobertura.esperadas, al_dia: d.cobertura.vigentes }, buzon,
  };
}

function render(d) {
  const cfg = d.cfg, E = d.paneles.extra || {}, L = d.paneles.local || {}, X = d.paneles.encuentra || {}, M = d.paneles.mejora || {};
  const P = d.paneles.poda || { candidatas: noMedida('sin panel de poda'), probadas: noMedida('sin panel de poda') };
  const commit = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return 'desconocido'; } })();
  const ahora = new Date().toISOString();
  const sello = selloDe(d, ahora);
  const cob = d.cobertura;
  const inc0 = d.faltantes.length > 0;
  const F = (clave, titulo, m, fmt, palabras, pie) => ficha(cfg, clave, titulo, m, fmt, palabras, pie);
  const entero = (v) => String(v);
  const redondo = (v) => String(Math.round(v));   // una mediana de conteos puede caer en ,5

  // Estado de cada pregunta = el peor estado de sus fichas medidas (blind no cuenta como rojo: es otra categoría).
  const peor = (...ms) => { const orden = ['ok', 'warn', 'bad']; let w = -1; for (const [k, m] of ms) { const e = juzgar(cfg, k, m); const i = orden.indexOf(e); if (i > w) w = i; } return w < 0 ? '' : orden[w]; };
  const cabecera = (n, titulo, est, palabra) => `<div class="q-head"><span class="q-n">${n}</span><h2>${titulo}</h2>${est ? chip(est, palabra) : ''}</div>`;

  const banda = inc0 ? `<div class="banda">${chip('bad', 'medición incompleta')} MEDICIÓN INCOMPLETA — ${d.faltantes.map((f) => esc(f.title)).join(' · ')}. No hay resumen global: una pata rota no se tapa con un promedio.</div>` : '';

  // ── pregunta 1: repos con más trabajo EN CURSO
  const repos = E.por_repo && E.por_repo.estado === 'medido' ? E.por_repo.repos : [];
  const enCursoTop = repos.filter((r) => r.en_curso !== null).sort((a, b) => b.en_curso - a.en_curso || a.nombre.localeCompare(b.nombre)).slice(0, 5).map((r) => `${esc(r.nombre)} <b>${r.en_curso}</b>`).join(' · ');
  const etapaLenta = E.tiempo_por_etapa && E.tiempo_por_etapa.estado === 'medido'
    ? `Donde se queda parado el trabajo: <b>${esc(E.tiempo_por_etapa.etapa_lenta)}</b>. La etapa que una story NACE ocupando no se mide: no tuvo transición de entrada.`
    : 'Está entero en el historial de git de cada story y nadie lo lee. <b>Un lector retroactivo da cuatro meses de historia el día uno.</b>';
  const reworkTop = E.rework_top && E.rework_top.estado === 'medido' ? E.rework_top.top.map((r) => `${esc(r.n)} <b>${pct(r.v)}</b> (${r.num} de ${r.den})`).join(' · ') : '';

  // ── el pie de «por qué volvió» ──────────────────────────────────────────────────
  // Las barras van ACÁ y no en el valor de la ficha porque `F()` dibuja un número y su
  // denominador; el pie es el único lugar donde entra HTML propio. Con la métrica sin medir el
  // pie es vacío: cinco barras en cero se leerían como «no volvió nada», que es la mentira que
  // esta ficha existe para no contar.
  const pieCausas = (() => {
    const c = E.rework_por_causa;
    if (!c || c.estado !== 'medido') return null;
    const tipos = (c.tipos_sin_declarar || []).map(([t, n]) => `${esc(t === 'sin_type' ? 'sin type' : t)} ${n}`).join(' · ');
    const fuera = (c.fuera_de_vocabulario || []).map(([v, n]) => `${esc(v)} (${n})`).join(' · ');
    return `${barrasCausa(c)}<b>La señal a mirar: cambio-de-requisito subiendo mientras defecto-propio baja.</b> `
      + 'La causa la escribe quien causó el reproceso — por eso el vocabulario es cerrado y «sin declarar» es una barra propia.'
      + (tipos ? ` De las <b>sin declarar</b>, esto es lo que ya traen en su <code>type</code> —${' '}<i>derivado del <code>type</code>, no declarado</i>—: ${tipos}.` : '')
      + (fuera ? ` Fuera del vocabulario: ${fuera} — se publican con su nombre, no se cuentan como causa.` : '');
  })();

  // ── trabajo contra espera, al pie de la ficha de la corrida ───────────────────────
  const te = L.trabajo_espera;
  const pieTiempos = !te ? null : te.estado !== 'medido'
    ? `<i>Trabajo y espera: ${esc(te.motivo)}.</i>`
    : `De punta a punta no es lo mismo que trabajo: <b>${te.trabajo === null ? 'trabajo sin medir' : `${num1(te.trabajo)} h de trabajo`}</b> (n=${te.n_trabajo} de ${te.total}) y <b>${te.espera === null ? 'espera sin medir' : `${num1(te.espera)} h esperando a una persona`}</b> (n=${te.n_espera} de ${te.total}), medianas de las ejecuciones que anotaron el arranque de sus pasos.`;

  // ── en el nocturno, la duración, los agentes y las vueltas salen del buzón — se dice de cuántas máquinas
  const notaCorridasNocturno = Number.isInteger(L.maquinas)
    ? `La duración, los agentes y las vueltas de una ejecución salen del buzón de ejecuciones, de ${L.maquinas} máquina${L.maquinas === 1 ? '' : 's'}, con la misma lectura que la página de una máquina; los pasos, también.`
    : 'La duración, los agentes y las vueltas de una ejecución salen del buzón de ejecuciones, que esta noche no se pudo leer entero; los pasos, también.';

  // ── pregunta 4: escapes — la regla dominante
  const escapesDom = L.escapes_dom || null;   // se calcula desde los conteos juntados, no parseando el texto del detalle

  const decl = E.declarados || {};
  const dInc = decl['incidentes-detectados-por-maquina'];

  const q0 = peor(['contrato_v2', E.contrato_v2]);
  const q2 = peor(['dod', M.dod], ['rework', M.rework]);
  const q3 = peor(['mutacion', L.mutacion], ['cobertura_tocada_evaluo', L.cobertura_tocada], ['qa_guia', L.qa_guia]);
  const q4 = peor(['banco_rojos', X.banco_rojos], ['suites_rojas', X.suites], ['escapes_regla_dominante', escapesDom]);
  const q5 = peor(['bus_factor_productos_en_riesgo', L.bus_factor], ['vigilados', E.vigilados]);

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>El arnés en seis preguntas</title>
${require('./seal').escribir(sello)}
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
${CSS_BASE}
.causas{margin-top:10px;display:flex;flex-direction:column;gap:5px}
.causa-barra{display:grid;grid-template-columns:130px 1fr 34px;align-items:center;gap:8px;font-size:12px}
.causa-barra .cn{color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.causa-barra .cb{height:9px;background:var(--line);border-radius:5px;overflow:hidden}
.causa-barra .cb i{display:block;height:100%;background:var(--accent);border-radius:5px}
.causa-barra.sd .cb i{background:repeating-linear-gradient(45deg,var(--ink-3),var(--ink-3) 3px,transparent 3px,transparent 6px)}
.causa-barra .cv{text-align:right;font-family:'IBM Plex Mono',monospace;color:var(--ink)}
${CSS_CHIPS}
.sources{display:grid;gap:1px;background:var(--line);border:1px solid var(--line);margin-top:4px}
.src{display:grid;grid-template-columns:minmax(180px,1.6fr) 130px 92px 120px minmax(150px,1fr);gap:12px;align-items:center;background:var(--surface);padding:9px 14px;font-size:13px}
.src.hdr{background:var(--surface-2);font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
.src .who{font-weight:500}.src .who small{font-weight:400;color:var(--ink-3)}.src .age,.src .ser{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--ink-2);font-variant-numeric:tabular-nums}.src .why{font-size:12.5px;color:var(--ink-3)}
.chart-card{background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);padding:18px 20px 14px;margin-top:14px}.chart-head{display:flex;flex-wrap:wrap;gap:10px 22px;align-items:baseline;justify-content:space-between;margin-bottom:6px}
.chart-title{font-size:15px;font-weight:600}.legend{display:flex;gap:16px;font-size:12px;color:var(--ink-2);align-items:center}.legend i{display:inline-block;width:13px;height:13px;margin-right:6px;vertical-align:-2px}.legend .bar-key{background:var(--accent)}.legend .ring-key{border:2px solid var(--ink-2);border-radius:50%;background:transparent;width:11px;height:11px}
.chart-scroll{overflow-x:auto}.chart-note{font-size:12.5px;color:var(--ink-3);margin-top:8px}
.gaps{display:grid;gap:1px;background:var(--line);border:1px solid var(--line);margin-top:14px}.gap{display:grid;grid-template-columns:26px 1.25fr 1fr;gap:16px;background:var(--surface);padding:13px 16px;align-items:start}
.gap .rank{font-family:"IBM Plex Mono",monospace;font-weight:600;color:var(--accent);font-size:14px}.gap .what{font-size:14px}.gap .what b{display:block;margin-bottom:2px}.gap .what span{color:var(--ink-2);font-size:13px}.gap .cost{font-size:12.5px;color:var(--ink-2)}
details{margin-top:14px;border:1px solid var(--line);background:var(--surface);padding:10px 14px}summary{cursor:pointer;font-weight:600;font-size:14px}details table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}details th,details td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}details th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3)}
.kicker{margin-top:46px;border:1px solid var(--ink);border-left:5px solid var(--accent);background:var(--surface);padding:22px 24px}.kicker h3{font-size:19px;letter-spacing:-.01em;margin-bottom:8px}.kicker p{margin:0 0 10px;color:var(--ink-2);font-size:14.5px}.kicker p:last-child{margin-bottom:0}.kicker b{color:var(--ink)}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--ink-3);font-family:"IBM Plex Mono",monospace;line-height:1.7}
@media (max-width:640px){.src{grid-template-columns:1fr 1fr;row-gap:4px}.src .why{grid-column:1/-1}.gap{grid-template-columns:22px 1fr}.gap .cost{grid-column:2/-1}}
</style></head><body>
<div class="wrap">
<header class="head">
  <div class="eyebrow">Tablero de comando · arnés TYCON · las ejecuciones del pipeline, una por una: <span class="mono">node scripts/nightly/dashboard/dashboard.js --view runs</span> (se arman en tu máquina)</div>
  <h1>El arnés en seis preguntas</h1>
  <p class="lede">Un tablero no es una lista de números: es el orden en que alguien decide qué mirar hoy. Éste está armado por <strong>pregunta</strong>, no por fuente de datos, y cada ficha declara su denominador. <strong>Lo que no se mide aparece igual</strong> — con trama en vez de color, porque «no medido» no es «cero» ni es «bien». <strong>Ningún número está escrito a mano</strong>: los produce <span class="mono">scripts/nightly/dashboard/dashboard.js</span> leyendo los registros.</p>
  <div class="stamp"><span><b>Generado:</b> ${esc(ahora.slice(0, 16).replace('T', ' '))} UTC</span><span><b>Datos del commit:</b> ${esc(commit)}</span><span><b>Fuentes esperadas:</b> ${cob.esperadas} · al día ${cob.vigentes}</span><span><b>Generada:</b> ${require('./seal').isNightly(sello.modo) ? `en el nocturno de Azure DevOps${sello.corrida ? ` (ejecución ${esc(sello.corrida)})` : ''}` : 'en una máquina — no es la página del equipo'}</span>${sello.buzon.estado === 'leido' ? `<span><b>Buzón:</b> leído, ${sello.buzon.maquinas} máquina${sello.buzon.maquinas === 1 ? '' : 's'}</span>` : sello.buzon.estado === 'no_leido' ? `<span><b>Buzón:</b> no leído — ${esc(sello.buzon.motivo)}</span>` : ''}</div>
  ${banda}
</header>

<section class="q">
  ${cabecera('0', '¿Está midiendo?', inc0 ? 'bad' : (q0 || 'ok'), inc0 ? `${cob.vigentes} de ${cob.esperadas} al día` : `${cob.vigentes} de ${cob.esperadas} al día`)}
  <p class="q-note">La pregunta madre: <strong>cualquier número de esta página vale cero si la respuesta es «no sé»</strong>. Se recorre la lista de fuentes esperadas, nunca la carpeta — una carpeta sólo puede mostrar lo que está. Y un dato más viejo que su umbral no se tacha: <strong>se borra</strong>, porque una foto vieja tranquiliza sobre lo que se rompió después.</p>
  <div class="sources">
    <div class="src hdr"><span>Fuente</span><span>Estado</span><span>Edad</span><span>Serie</span><span>Motivo</span></div>
    ${d.fuentes.map(filaFuente).join('\n    ')}
  </div>
  <div class="grid" style="margin-top:14px">
    ${F('contrato_v2', 'Registros por merge que cumplen el contrato de formato', E.contrato_v2, pct, { bad: 'casi ninguno', warn: 'parcial', ok: 'bien' }, 'Los escribe a mano un agente al cerrar cada merge. El validador corre en el nocturno <b>en modo aviso</b>: veinte días midiendo antes de discutir si frena.')}
    ${F('', 'Registros por merge con fecha declarada adentro (no inferida del nombre)', E.fechas_declaradas, pct, {}, 'Una fecha inferida del nombre del archivo ordena, pero no cuenta para dibujar una tendencia.')}
  </div>
</section>

<section class="q">
  ${cabecera('1', '¿El trabajo fluye?', 'warn', 'medido a medias')}
  <p class="q-note">Hay historia real, pero la etiqueta importa: lo que se mide es <strong>del primer al último toque del archivo</strong> de la story, no del pedido a la entrega. Es un proxy, y el propio código lo declara como proxy.</p>
  ${grafico(E.lead_mensual)}
  <div class="grid" style="margin-top:14px">
    ${F('', 'Trabajo en curso: stories en desarrollo o en revisión', E.en_curso, entero, {}, enCursoTop ? `Los que más tienen: ${enCursoTop}.` : null)}
    ${F('', 'En el backlog: escritas y todavía sin arrancar', E.backlog, entero, {}, null)}
    ${F('', 'Con un estado que el diccionario no reconoce', E.estados_sin_diccionario, entero, {}, 'Son la <b>lista de trabajo del próximo diccionario</b>: se muestran con su nombre porque esconderlas es cómo un vocabulario se queda viejo.')}
    ${F('', 'Tiempo por etapa: listo-para-desarrollar → en curso → revisión → cerrado', E.tiempo_por_etapa, num1, {}, etapaLenta)}
    ${F('', `Stories empezadas que llevan más de ${E.edad_estado && E.edad_estado.edad ? E.edad_estado.edad.dias[0] : 'N'} días en su estado`, E.edad_estado, entero, {}, E.edad_estado && E.edad_estado.estado === 'medido' ? `${esc(E.edad_estado.detalle)}. Cuenta lo empezado (en curso y bloqueado); el backlog va en el detalle. Sale de las fotos por proyecto: no se mide nada de nuevo.` : null)}
  </div>
  ${detalleEdad(E.edad_estado)}
  <div class="grid" style="margin-top:14px">
    ${F('', 'Cambios de código sin historia: entradas a main de los últimos 28 días que no nombran ninguna', E.sin_historia, pct, {}, E.sin_historia && E.sin_historia.estado === 'medido' ? 'Sólo se mide: no frena ni le avisa a nadie.' : null)}
  </div>
  ${detalleSinHistoria(E.sin_historia)}
</section>

<section class="q">
  ${cabecera('2', '¿Lo que entregamos aguanta?', q2, q2 === 'bad' ? 'rojo' : q2 === 'warn' ? 'atención' : 'bien')}
  <p class="q-note">Las dos únicas preguntas de calidad que un cliente reconoce: <strong>¿queda constancia de que alguien lo probó?</strong> y <strong>¿cuánto vuelve?</strong></p>
  <div class="grid">
    ${F('dod', 'Cierres que dejaron prueba de que la cosa anda corriendo', M.dod, pct, { bad: 'rojo', warn: 'atención', ok: 'bien' }, E.repos_en_cero_dod && E.repos_en_cero_dod.estado === 'medido' && E.repos_en_cero_dod.valor > 0 ? `<b>${E.repos_en_cero_dod.valor} de ${E.repos_en_cero_dod.total} repos en cero</b>: ${esc(E.repos_en_cero_dod.detalle)}. No es que estén rotos: es que de esos cierres no queda constancia.` : null)}
    ${F('rework', 'Lo que vuelve: stories con un seguimiento posterior', M.rework, pct, { bad: 'concentrado', warn: 'atención', ok: 'bien' }, reworkTop ? `Los que más vuelven: ${reworkTop}.` : null)}
    ${F('', 'Por qué volvió: defecto nuestro contra cambio de requisito', E.rework_por_causa, entero, {}, pieCausas)}
    ${F('', '¿Vuelve menos lo que pasó por el pipeline? Por repo, con ejecución contra sin constancia', E.rework_por_carril, entero, {}, `La hipótesis y el mínimo por grupo se escribieron <b>antes</b> de mirar un número (<code>scripts/metrics/lane-hypothesis.json</code>) y el resultado se publica aunque salga en contra del pipeline. «Sin constancia» no quiere decir «a mano»: una ejecución que no se guardó en el repo cae ahí. Nunca se suma entre productos.`)}
    ${F('', dInc && dInc.titulo ? dInc.titulo : 'Incidentes de producción detectados por una máquina', dInc, entero, {}, 'Es un dato <b>declarado</b> por una persona, no producido por un registro: se muestra, no se juzga, y vence.')}
  </div>
</section>

<section class="q">
  ${cabecera('3', '¿Las pruebas prueban algo?', q3, q3 === 'bad' ? 'rojo' : q3 === 'warn' ? 'atención' : 'bien')}
  <p class="q-note">La pregunta que separa un tablero honesto de uno decorativo. Una suite en verde no dice nada por sí sola: lo que dice algo es <strong>si esas pruebas se rompen cuando el código se rompe</strong>. <em>La mutación, la cobertura y la guía de QA cuentan los registros de todas las máquinas que los suben, y cada ficha dice de cuántas sale su número; ${AMB.nocturno ? 'la duración de la suite, también: sale del registro de controles que sube cada máquina' : 'la duración de la suite sale todavía de esta máquina'}.</em></p>
  <div class="grid">
    ${F('mutacion', 'Puntaje de mutación: proporción de mutantes que las pruebas matan (mediana)', L.mutacion, pct, { bad: 'flojo', warn: 'hubo ceros', ok: 'bien' }, 'Un chequeo que <b>no pudo medir</b> —hoy el chequeo sólo sabe correr las pruebas de Node, así que en .NET y React no mide— se cuenta aparte y <b>nunca es un 0 %</b>.')}
    ${F('cobertura_tocada_evaluo', 'Ejecuciones de pruebas que evaluaron el umbral del 75 % sobre las líneas tocadas', L.cobertura_tocada, pct, { bad: 'casi nunca mide', warn: 'parcial', ok: 'bien' }, 'La cobertura se mide sobre las <b>líneas que la story agregó o modificó</b>, no sólo sobre los archivos que creó (medido: casi ninguna story crea archivos, y el umbral no juzgaba nada). Una ejecución no evalúa cuando su herramienta no produce cobertura o no hubo líneas de código tocadas. <b>En observación</b>: el detalle dice hasta cuándo y cuántas habrían frenado, y con ese número se decide si el 75 % pasa a frenar. Cuenta todas las máquinas.')}
    ${F('qa_guia', 'Cierres que necesitaban la guía para que una persona pruebe a mano, y la tenían', L.qa_guia, pct, { bad: 'casi siempre falta', warn: 'parcial', ok: 'bien' }, 'Es el puente entre «las pruebas pasan» y «alguien lo usó». Hasta septiembre de 2026 sólo quedaba anotada la guía que <b>faltaba</b>, así que la proporción se arma sólo con los cierres que anotan los cuatro resultados; los avisos viejos se cuentan, no se dividen.')}
    ${F('', 'Cuánto tarda verificar: duración de la suite de pruebas (mediana, segundos)', L.gates_dur, num1, {}, 'Una suite que tarda horas no se corre antes de commitear — se saltea.')}
  </div>
</section>

<section class="q">
  ${cabecera('4', '¿Los controles sirven, o estorban?', q4, q4 === 'bad' ? 'una regla concentra todo' : q4 === 'warn' ? 'atención' : 'bien')}
  <p class="q-note">Un catálogo de reglas sólo puede crecer si nadie mide cuáles frenan de verdad y cuáles se esquivan todos los días. <strong>Éste es el panel que decide qué regla se retira</strong>. <em>Frenos y escapes, de todas las máquinas: ${esc(L.cobertura_maquinas || 'sin cobertura de máquinas')}. ${AMB.nocturno ? notaCorridasNocturno : 'La duración, los agentes y las vueltas salen de los registros de esta máquina; los pasos, del buzón de ejecuciones de todas.'}</em></p>
  <div class="grid">
    ${F('', 'Veces que un control del pipeline bloqueó una acción', L.bloqueos, entero, {}, 'Cuenta las evaluaciones de los <b>controles del pipeline</b> (el registro de controles, <code>gates.log</code>) que bloquearon. Los frenos previos a la herramienta —los que corren antes de cada comando— son otra cuenta, de otro registro: están en la ficha siguiente.')}
    ${F('', 'Los frenos previos a la herramienta: cuántas veces frenaron, y cuántas los saltearon', L.frenos, entero, {}, 'Los dos números de la misma regla, juntos: sin el primero, un freno que funcionó todo el mes se ve igual que uno que nunca se disparó. <b>El total es una cuenta, no un porcentaje</b>: los seis no comparten denominador —el freno de comandos peligrosos no cuenta los «dejé pasar», porque corre en cada comando de la terminal—, así que la proporción vive por freno, cada uno con el suyo.')}
    ${F('', 'Los hooks del cierre: de sus decisiones sobre una evidencia, cuántas la rechazaron', L.evidencia_cierre, pct, {}, 'Cuenta a los tres frenos que impiden cerrar una story sin evidencia: el del cambio de estado, el del commit y el que no deja escribir evidencia a mano. Proporción de rechazos: <b>es el número que dice si el cierre mínimo alcanza</b>. El cierre soltó los revisores que releían la evidencia con un modelo; si este número baja a cero mientras suben los criterios sin correr de la matriz, el recorte se revisa.')}
    ${F('escapes_regla_dominante', 'Escapes concentrados en una sola regla', escapesDom, pct, { bad: 'una regla concentra todo', warn: 'atención', ok: 'repartido' }, L.escapes && L.escapes.estado === 'medido' ? `${L.escapes.valor} escapes declarados en total. <b>Eso no es abuso: es un tope puesto donde molesta</b>, y se recalibra o se retira.${escapesDom && escapesDom.detalle && /FULL_SUITE_RUN/.test(escapesDom.detalle) ? ' <b>Acá la dominante es una declaración esperada, no un freno esquivado</b>: correr la suite completa está permitido y se declara — la regla existe para que no se corra sin querer, no para impedirla.' : ''}` : null)}
    ${F('banco_rojos', 'Los controles rindiendo su propio examen: casos en rojo', X.banco_rojos, entero, { ok: 'verde', bad: 'rojo' }, 'Cada control tiene al menos un caso que <b>lo rompe a propósito para verlo ponerse rojo</b>.')}
    ${F('suites_rojas', 'Suites del arnés en rojo', X.suites, entero, { ok: 'verde', bad: 'rojo' })}
    ${F('', 'Reglas candidatas a retiro: probadas, que nunca encontraron nada con recorrido de sobra', P.candidatas, entero, {}, 'Cada una <b>sabe ponerse roja</b>: retirarla pierde disuasión. <b>La tabla marca; decide una persona.</b>')}
    ${F('', 'Reglas que el banco de pruebas probó de verdad', P.probadas, pct, {}, 'Una regla sin prueba que la obligue a marcar <b>no se juzga</b>: sale «sin probar», nunca candidata.')}
    ${F('', 'Una ejecución del pipeline, de punta a punta (mediana, horas)', L.corridas, num1, {}, [L.vueltas && L.vueltas.estado === 'medido' ? `<b>${L.vueltas.valor} vueltas de revisión de mediana</b>${L.agentes && L.agentes.estado === 'medido' ? ` y ${L.agentes.valor} agentes por ejecución` : ''}: si los revisores piden en la vuelta 2 y 3 algo que se sabía antes, eso se mueve a la spec.` : null, pieTiempos].filter(Boolean).join(' ') || null)}
    ${F('', 'Pasos de una ejecución del pipeline (mediana): la variable que explica lo que consume', L.pasos, redondo, {}, 'Una ejecución consume según cuántos pasos da, porque en cada paso el modelo relee todo lo anterior: <b>los tokens son la consecuencia, esto es la palanca</b>. Sale de las ejecuciones de todas las máquinas que las suben. <b>No tiene tope ni color a propósito</b>: primero la serie, y recién si alguna palanca la mueve se discute un umbral.')}
    ${F('', 'Commits por carril: pipeline, atajo declarado o ninguno', L.carriles, entero, {}, 'Sale del hook que ya registra cada commit de una sesión. <b>Los commits hechos fuera de una sesión no se ven</b> (desde la terminal o el editor), ni los que toman el mensaje de un archivo o de una variable: no están en este número, y eso es «no medido», no cero. Un commit hasta 3 h después de cerrar una ejecución cuenta como de esa ejecución; un atajo vencido no es un carril.')}
    ${F('', 'Despliegues: productos con producción al día', E.despliegues, entero, {}, 'Sale de la foto de despliegues de cada noche, leída del <b>stage</b> de cada ejecución: una ejecución «succeeded» con la aprobación vencida no cuenta como desplegada. Sobre los productos medidos; el detalle dice cuáles tienen producción atrasada y cuántas aprobaciones vencieron. Duración, cola y frecuencia de despliegues: story 2.11.')}
  </div>
  ${tablaPoda(P)}
  <details><summary>Detalle: las 6 métricas de revisores del capturador, con su cobertura</summary>
    <table><tr><th>Métrica</th><th>Mediana</th><th>Rango</th><th>Cobertura</th></tr>
    ${Object.entries(M.revisores || {}).filter(([k]) => k !== '_error').map(([k, m]) => m.estado === 'medido'
      ? `<tr><td>${esc(m.etiqueta || k)}</td><td>${m.formato === 'ratio' ? pct(m.valor) : num1(m.valor)}</td><td>${m.rango ? (m.formato === 'ratio' ? pct(m.rango[0]) + '–' + pct(m.rango[1]) : num1(m.rango[0]) + '–' + num1(m.rango[1])) : ''}</td><td>n=${m.medidos} de ${m.total} registros</td></tr>`
      : `<tr><td>${esc(k)}</td><td colspan="3">${chip('blind', 'no medido')} ${esc(m.motivo)}</td></tr>`).join('\n    ')}
    </table>
    <p class="chart-note">Son valores actuales con su cobertura, nunca una tendencia: la serie del capturador todavía no lo permite (ver pregunta 0).</p>
  </details>
</section>

<section class="q">
  ${cabecera('5', '¿De qué depende que esto siga funcionando?', q5, q5 === 'bad' ? 'riesgo dominante' : q5 === 'warn' ? 'atención' : 'bien')}
  <p class="q-note">El riesgo de ingeniería no es el código: es <strong>quién es la única persona que sabe tocarlo</strong>. ${AMB.nocturno ? 'Medido cada noche sobre los commits del último año de los repos declarados de la organización, con las identidades de una persona unidas y sin los commits de las máquinas.' : 'Medido sobre los commits del último año de los repos declarados que están en este disco, con la misma regla que el nocturno.'} <strong>Se publica la concentración, nunca el nombre.</strong></p>
  <div class="grid g2">
    ${F('bus_factor_productos_en_riesgo', 'Productos donde una sola persona hizo el 75 % o más de los commits del último año', L.bus_factor, entero, { bad: 'una persona', warn: 'atención', ok: 'repartido' }, 'La diferencia entre los concentrados y los repartidos no es el tamaño ni la antigüedad: es quién los arrancó.')}
    ${F('vigilados', 'Productos con algo mirando su producción todas las noches', E.vigilados, pct, { bad: 'casi ninguno', warn: 'parcial', ok: 'todos' })}
    ${F('', 'Productos sin pipeline de producción', E.sin_prod, entero, {}, 'No es una métrica de calidad: es exposición. Para ellos «despliegues» es estructuralmente cero y la página tiene que decir <b>«sin pipeline»</b>, nunca «0».')}
  </div>
</section>

<section class="q">
  ${cabecera('→', 'Lo que hay que instrumentar, por valor sobre costo', '', '')}
  <p class="q-note">Ninguno de estos pide infraestructura nueva: <strong>la materia prima ya está escrita</strong> en git, en el encabezado de las stories o en los registros que los nocturnos ya producen. Lo que falta es agregarla.</p>
  <div class="gaps">
    ${(cfg.instrument || []).map((g, i) => `<div class="gap"><span class="rank">${i + 1}</span><div class="what"><b>${esc(g.what)}</b><span>${esc(g.sub)}</span></div><div class="cost">${esc(g.cost)}</div></div>`).join('\n    ')}
  </div>
  <details><summary>Lo que hoy NO se puede medir, con el motivo</summary>
    <table><tr><th>Qué falta</th><th>Por qué</th></tr>
    ${(cfg.not_measurable_today || []).map((x) => `<tr><td><b>${esc(x.what)}</b></td><td>${esc(x.reason)}</td></tr>`).join('\n    ')}
    </table>
  </details>
</section>

<div class="kicker">
  <h3>Y la advertencia que va antes de mostrar esto a nadie</h3>
  <p>Este tablero contesta <b>«¿el arnés funciona?»</b>. No contesta «¿la empresa gana plata?». De los seis números que decide el dueño del negocio, <b>el arnés emite uno</b> —lo que vuelve—; los otros cinco necesitan el precio de cada contrato, el costo por hora y lo facturado, y nada de eso vive ni va a vivir en un repositorio.</p>
  <p>Las horas registradas por proyecto <b>no son horas gastadas en ese cliente</b>: buena parte es trabajo de plataforma imputado al proyecto en el que se estaba. Un cálculo de rentabilidad hecho con eso le cobraría a un cliente un trabajo que sirvió a todos (medición: <span class="mono">tasks/plan-metricas-de-negocio-2026-09-05.md</span> §2).</p>
</div>

<footer>
  Generado por <span class="mono">scripts/nightly/dashboard/dashboard.js</span> · fuentes esperadas en <span class="mono">scripts/nightly/dashboard/sources.json</span> · umbrales en la misma lista · datos declarados con vencimiento en <span class="mono">declared.json</span> · plan: <span class="mono">tasks/plan-tablero-de-control-del-arnes-2026-09-05.md</span><br>
  Los estados van con glifo y palabra además de color: ámbar y rojo son casi indistinguibles para daltonismo deutan (ΔE 3,8 medido). «No medido» va con trama, nunca con color. Material interno de TYCON: los nombres de productos son reales.
</footer>
</div></body></html>`;
}

// ───────────────────────────── main ─────────────────────────────

function main() {
  // Segunda página de la misma pieza: la vista de corridas. Lee otro registro (local,
  // no obligatorio) y tiene su propio módulo; acá sólo se despacha.
  const vista = valor('--view', null);
  if (vista && vista !== 'runs') { console.error(`uso: --view runs (recibí «${vista}»)`); process.exit(1); }
  if (vista === 'runs') {
    // exitCode, no exit(): el --json de la vista pesa ~1 MB y con exit() se truncaba en el pipe.
    process.exitCode = require('./runs').main({ runsDir: valor('--runs-dir', null), salida: valor('--output', null), buzon: valor('--mailbox', null), clonRetirado: flag('--clone'), soloLocal: flag('--local-only'), json: flag('--json'), dryRun: flag('--dry-run') });
    return;
  }
  // 🔴 Un solo escritor: sin --nightly, la página NO se escribe dentro del repo. Se decide ANTES de medir.
  const salida = path.resolve(valor('--output', AMB.nocturno ? SALIDA_DEFAULT : SALIDA_LOCAL_DEFAULT));
  // Sólo si la raíz es un repo git: es lo que se commitea. Una copia suelta de los guiones (una prueba, un zip) no lo es.
  if (!flag('--dry-run') && !AMB.nocturno && fs.existsSync(path.join(RAIZ, '.git'))) {
    let dentro;
    // sin el detector no se puede afirmar que la ruta está afuera
    try { dentro = require('./runs').dentroDelRepoDelEquipo(salida); } catch (e) { dentro = true; }
    if (dentro) {
      console.error(`se niega a escribir ${salida}: la página del repo la escribe sólo el nocturno (pipelines/azure-pipelines-tablero.yml) — generada en una máquina, mezclaría el disco de esa máquina con los datos del equipo. Sin --output va a ${SALIDA_LOCAL_DEFAULT}.`);
      process.exit(1);
    }
  }
  let d;
  try { d = colectar(); }
  catch (e) { console.error(`no se pudo medir: ${e.message}`); process.exit(2); }

  const cob = d.cobertura;
  console.log(`Fuentes esperadas: ${cob.esperadas} · encontradas: ${cob.encontradas} · al día: ${cob.vigentes}`);
  for (const f of d.fuentes) {
    const est = !f.leida ? 'NO LEÍDA' : !f.vigente ? 'VIEJA' : 'al día';
    console.log(`  ${f.id.padEnd(14)} ${est.padEnd(9)} ${edadTexto(f.edad_dias).padEnd(14)} ${f.archivos} archivo(s)${f.motivo ? ' — ' + f.motivo : ''}`);
  }

  if (flag('--json')) { console.log(JSON.stringify(d.paneles, null, 2)); }

  if (!flag('--dry-run')) {
    try {
      fs.mkdirSync(path.dirname(salida), { recursive: true });
      fs.writeFileSync(salida, render(d), 'utf8');
      const rel = path.relative(RAIZ, salida);
      console.log(`\nPágina escrita: ${rel.startsWith('..') ? salida : rel}`);
    } catch (e) { console.error(`no se pudo escribir la página: ${e.message}`); process.exit(3); }
  } else {
    console.log('\n--dry-run: no se escribió nada.');
  }

  // 🔴 El contrato: sale 0 si MIDIÓ, aunque haya rojos. Distinto de 0 sólo si NO PUDO medir.
  // exitCode y no exit(): con --json la salida es grande y exit() la trunca en el pipe (PIPE-DEBT-2.14).
  if (d.faltantes.length > 0) {
    console.error(`\nNO MEDIDO: ${d.faltantes.length} fuente(s) obligatoria(s) sin dato vigente — ${d.faltantes.map((f) => f.id).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  process.exitCode = 0;
}

if (require.main === module) main();
module.exports = { colectar, render, equipo, pasosPorCorrida, ratio, medida, noMedida, edadDias, estadoDelBuzon, selloDe, MOTIVOS_BUZON, fichaDespliegues };
