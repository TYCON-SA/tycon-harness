#!/usr/bin/env node
/**
 * engram-rescue-unexported.js — fuerza la exportación de las observaciones que existen en la DB
 * local pero nunca llegaron a un chunk de `.engram/chunks/`.
 *
 * ── EL PROBLEMA ──────────────────────────────────────────────────────────────────────────────
 * `engram sync` decide qué exportar **por fecha**: compara el `updated_at` de cada observación
 * contra el chunk más nuevo del `.engram/` destino. Todo lo que sea más viejo que el último export
 * NO se vuelve a emitir — aunque nunca haya estado en un chunk de ESE repo.
 *
 * Eso deja memoria varada en una sola máquina, en silencio, en dos escenarios normales:
 *   · el repo sincronizaba un project name equivocado (o ninguno) y se corrigió después;
 *   · se consolidaron varios cajones en uno — el rename mueve las observaciones pero NO las
 *     re-exporta, porque su `updated_at` sigue siendo el viejo.
 *
 * Medido el 2026-08-25, después de unificar 4 repos: **1016 observaciones varadas** (749 de
 * contenido real, 217 resúmenes de sesión), incluidas decisiones de arquitectura y bugs con su
 * causa raíz. Si se perdía el disco, se perdían: nadie más del equipo las tenía.
 *
 * ── CÓMO LO ARREGLA ──────────────────────────────────────────────────────────────────────────
 * Toca `updated_at` de cada observación varada con un PATCH **no-op** contra la API local de
 * engram (`PATCH /observations/:id` con su PROPIO `type`), y después corre `engram sync`. El
 * contenido no se toca: sólo se mueve la fecha para que el export la vuelva a ver.
 *
 * 🔴 Por qué la API y no un UPDATE a la DB: `observations` tiene triggers de FTS y una capa de
 * mutaciones de sync; escribir por afuera obliga a replicar todo eso a mano sobre 44 MB de la
 * memoria compartida del equipo. La API es el mismo camino que usa `mem_update`.
 *
 * ── USO ──────────────────────────────────────────────────────────────────────────────────────
 *   node scripts/setup/engram-rescue-unexported.js                  # dry-run: dice qué haría
 *   node scripts/setup/engram-rescue-unexported.js --apply          # lo hace
 *   node scripts/setup/engram-rescue-unexported.js --apply --repo Ceibo
 *   node scripts/setup/engram-rescue-unexported.js --apply --repo Lapacho --target Lapacho/Project    # contenedor con varios sub-repos del mismo proyecto
 *
 * Requiere el server local de engram andando (`engram serve`, puerto 7437 por default; override
 * con ENGRAM_API). Si no está, avisa y NO hace nada — nunca falla en silencio.
 *
 * Después de correrlo hay que **commitear el `.engram/` de cada repo**: el script exporta, no
 * commitea. Lo dice al final, repo por repo.
 *
 * ── LÍMITE CONOCIDO (medido 2026-08-25) ──────────────────────────────────────────────────────
 * En el repo de documentación de procesos quedaron 38 observaciones que NO se pueden rescatar por esta vía: se las tocó, se
 * verificó que el `updated_at` quedó en hoy, y `engram sync` sigue diciendo *"all memories already
 * exported"* — incluso vaciando el índice del manifest, que descarta que el cursor viva ahí. O sea
 * que engram lleva el registro de lo exportado en otro lado, y para esas 38 dice que ya salieron:
 * lo más probable es que se hayan exportado desde OTRO clon del repo, y ese chunk no está en éste.
 * No se forzó nada por afuera de la API a propósito. Si aparecen más casos así, el camino es
 * mirarlo del lado de engram, no seguir empujando desde acá.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: el
// rescate corre también copiado suelto, sin scripts/setup/harness/ al lado (engram-rescue.test.js T28 lo copia así); ahí
// vale la ruta de siempre, que es la misma (T5 de scripts/tests/tycon-home.test.js). Si está y no carga, tira.
// (los `require` van adentro de la expresión: T5 de tycon-home.test.js la evalúa suelta, sin el resto del archivo)
const stateDirOf = (() => { const lib = path.join(__dirname, 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
// Los nombres viejos de las opciones siguen andando (story 8.9, tanda B3a): antes de la primera lectura de argv.
require(path.join(__dirname, '..', 'lib', 'legacy-names.js')).aliasArgv('scripts/setup/engram-rescue-unexported.js', { exitCode: 2 });
const API = process.env.ENGRAM_API || 'http://127.0.0.1:7437';
const APPLY = process.argv.includes('--apply');
// 🔴 Parser ESTRICTO (hallazgo 17): `--repo` sin valor se interpretaba como "sin filtro" y la
// corrida operaba sobre TODOS los repos — lo contrario de lo que el dev pidió. Y `--repo --apply`
// tomaba `--apply` como nombre de repo. Un flag mal escrito tiene que frenar, no ampliar el alcance.
const soloRepo = (() => {
  const i = process.argv.indexOf('--repo');
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error('⛔ --repo requiere un nombre de repo. Sin valor NO significa "todos": significa que faltó el valor.');
    process.exit(2);
  }
  return v;
})();
// 🔴 `--target <repo/sub-repo>` (2026-09-06): cuando un CONTENEDOR tiene varios sub-repos con el
// mismo proyecto, el script abortaba pidiendo «--repo <repo>» — y `--repo` es el FILTRO, no el
// destino: no había forma de elegir. Lapacho (Backend, FrontEnd y Project declaran `lapacho`)
// quedó con 11 recuerdos varados por eso. El destino se declara aparte, y se valida igual que un
// candidato: tiene que existir, ser un repo git y declarar EXACTAMENTE el proyecto.
const destinoElegido = (() => {
  const i = process.argv.indexOf('--target');
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error('⛔ --target requiere un repo (relativo a la raíz de repos, p. ej. Lapacho/Project).');
    process.exit(2);
  }
  return v;
})();
// Presupuesto GLOBAL de tiempo (hallazgo 15): el timeout era POR OBSERVACIÓN (10s) y por repo, así
// que el peor caso escalaba con N — medido: 1016 observaciones ≈ 2h49m de PATCH secuencial. El
// tope tiene que ser de la CORRIDA. Al agotarse se corta limpio: el script es idempotente.
const PRESUPUESTO_MS = (() => {
  const i = process.argv.indexOf('--budget');
  const v = i >= 0 ? Number.parseInt(process.argv[i + 1], 10) : NaN;
  return (Number.isFinite(v) && v > 0 ? v : 600) * 1000;
})();
const ARRANQUE = Date.now();
function presupuestoAgotado() { return Date.now() - ARRANQUE > PRESUPUESTO_MS; }

const DB = path.join(os.homedir(), '.engram', 'engram.db');
// engram (story 8.3, AC 9/10): con la integración apagada no hay nada que rescatar — se dice en UNA línea y sale 0, ANTES
// de exigir la raíz de repos. Configuración rota → archivo, clave y motivo, exit 2. Sin lector al lado: como hoy.
{
  let integ = null;
  try { integ = require(path.join(__dirname, '..', 'lib', 'tycon-config.js')).integracionParaComando('engram'); }
  catch (e) {
    if (e && e.name === 'ConfigError') { console.error(e.message); process.exit(2); }
    if (!(e && e.code === 'MODULE_NOT_FOUND')) throw e;   // un bug del lector no se traga: un comando frena
  }
  if (integ && !integ.prendida) { console.log(integ.apagada); process.exit(0); }
}
const audit = require(path.join(__dirname, '..', 'lib', 'harness-audit.js'));
// Misma raíz que usa el audit — nunca una carpeta escrita a mano (ver lib/repos-root.js). Sin raíz no se
// rescata nada y se dice (story 8.3, AC 6); un ~/.claude/tycon.json roto tira: un comando frena.
// todas las carpetas de repos (puede haber más de una): cada repo se busca en la que lo tiene
const REPOS_ROOTS = (() => {
  const r = require(path.join(__dirname, '..', 'lib', 'repos-root.js')).resolveReposRoot();
  if (!r.roots || !r.roots.length) { console.error(`engram-rescue-unexported: no medido — sin raíz de repos (${r.motivo})`); process.exit(2); }
  return r.roots;
})();
const REPOS_ROOT = REPOS_ROOTS[0];
const raizDe = (rel) => REPOS_ROOTS.find((x) => fs.existsSync(path.join(x, rel))) || REPOS_ROOT;

function sql(q) {
  return execFileSync(process.env.TYCON_SQLITE_BIN || 'sqlite3', ['-readonly', DB, q], { encoding: 'utf8', timeout: 20000 })
    .split('\n').map((x) => x.trim()).filter(Boolean);
}

async function apiViva() {
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

// PATCH no-op: se reescribe el `type` con su propio valor. Se usa `type` y no `title` porque
// siempre está y nunca está vacío — hay observaciones con el título en blanco, y un PATCH con
// title vacío es rechazado.
async function tocar(id, type) {
  const r = await fetch(`${API}/observations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} en obs ${id}`);
}

// ── --reindex: chunks en disco que el índice no nombra ───────────────────────────────────────
// `manifest.json` NO es decorativo: `engram sync --import` lo usa para saber qué levantar. Un chunk
// commiteado sin entrada es memoria que viajó por git y que NADIE puede leer — se ve, desde afuera,
// exactamente igual que un archivo que no existe. Medido el 2026-08-25: 5 chunks así en 3 repos,
// uno de ellos con 8 observaciones de otro dev sobre bugs de conciliación, en `main` desde hacía un
// día. Se abrió en commits NORMALES, sin conflicto de por medio — que es el único caso que la
// guarda de ENGRAM-MANIFEST-1 cubría.
//
// La entrada se reconstruye con lo que se puede saber de verdad: el id y el conteo salen del propio
// chunk; el autor y la fecha, del commit que lo trajo (y si el archivo no está en git todavía, del
// usuario actual y la mtime). Nunca se inventa: si el chunk no parsea, no se toca y se avisa.
/**
 * Cuenta lo que un chunk trae de verdad. Devuelve null si no se puede leer — "no pude mirar" y
 * "trae 0" son cosas distintas, y mezclarlas es cómo se fabrica un contador inventado.
 */
function contarChunk(f) {
  const zlib = require('zlib');
  let obs = 0, ses = 0, prompts = 0;
  try {
    for (const linea of zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n')) {
      if (!linea.trim()) continue;
      const d = JSON.parse(linea);
      obs += (d.observations || []).length;
      ses += (d.sessions || []).length;
      prompts += (d.prompts || []).length;
    }
  } catch { return null; }
  return { obs, ses, prompts };
}

function reindexar(apply) {
  const criterio = require('../lib/manifest-engram.js');
  const todos = audit.scanEngramRepos().pinned;
  // 🔴 `--repo` vale también acá (story 1.6, 2026-09-17). Antes `soloRepo` filtraba SÓLO el rescate
  // de varadas y el reindex iteraba todos los repos con nombre fijado: pedir «tocá este» tocaba
  // veinte. Una etiqueta desconocida sale 2 nombrando los conocidos, igual que el rescate.
  let pinned = todos;
  if (soloRepo) {
    pinned = todos.filter((x) => x.repo === soloRepo);
    if (!pinned.length) {
      console.error(`⛔ --repo ${soloRepo}: ese repo no existe en el escaneo. Repos conocidos:`);
      for (const x of todos) console.error(`   · ${x.repo}`);
      process.exit(2);
    }
  }
  let total = 0;
  let tocadas = 0;
  const desajustes = [];
  // 🔴 Los manifests ROTOS se acumulan y deciden el exit (hallazgo 17). Antes, un manifest ausente
  // o con `chunks` que no es lista se salteaba EN SILENCIO y la corrida cerraba con "✅ Todo chunk
  // está en el índice" — un repo cuya memoria nadie puede importar, reportado como sano.
  const rotos = [];
  for (const { repo } of pinned) {
    const base = path.join(raizDe(repo), repo, '.engram');
    const dirChunks = path.join(base, 'chunks');
    const fMan = path.join(base, 'manifest.json');
    if (!fs.existsSync(dirChunks)) continue;
    const hayChunks = (() => { try { return fs.readdirSync(dirChunks).some((f) => f.endsWith('.jsonl.gz')); } catch { return false; } })();
    if (!fs.existsSync(fMan)) {
      if (hayChunks) rotos.push(`${repo}: hay chunks y NO hay manifest.json — esa memoria viajó por git y nadie la puede importar`);
      continue;
    }
    let man;
    try { man = JSON.parse(fs.readFileSync(fMan, 'utf8')); } catch {
      rotos.push(`${repo}: manifest ilegible — NO se toca (ver ENGRAM-MANIFEST-1)`); continue;
    }
    if (!man || !Array.isArray(man.chunks)) {
      rotos.push(`${repo}: manifest sin lista \`chunks\` — el schema no es el que engram escribe; NO se toca`);
      continue;
    }
    const yaEstan = new Set(man.chunks.map((c) => c && c.id).filter(Boolean));
    const faltan = fs.readdirSync(dirChunks)
      .filter((f) => f.endsWith('.jsonl.gz'))
      .map((f) => f.replace('.jsonl.gz', ''))
      .filter((id) => !yaEstan.has(id));
    // 🔴 NO se saltea el repo cuando no falta ningún chunk (2026-09-06). Ese `continue` hacía que
    // las entradas que SÍ están no se revisaran nunca: un índice completo se leía como un índice
    // correcto. Medido en el arnés: 2 de 97 entradas declaraban `sessions:0, memories:1`
    // con 1/3 y 15/82 adentro — 83 memorias que el censo no contaba — y la corrida imprimía
    // "✅ Todo chunk en disco está en el índice de su repo". No se pierde memoria (el import lee
    // los ARCHIVOS, no los contadores): lo que miente es el censo, y un censo que miente es
    // exactamente lo que este script existe para que no pase.

    // 🔴 Las entradas que faltan las arma el CRITERIO (story 1.6): rescata primero la entrada
    // EXACTA de la historia de git —de cualquier referencia, incluido el otro lado de un merge y
    // una rama sin mergear— y sólo reconstruye desde el chunk si nadie la tuvo nunca. Este guion
    // reconstruía siempre, así que una entrada rescatable volvía con el autor y la fecha del
    // commit que trajo el archivo en vez de los suyos. Nunca inventa: lo ilegible queda sin tocar.
    const arreglo = criterio.reparar(path.dirname(base), { apply: false });
    // 🔴 «No pude medir» NO es «no hay nada que reparar» (2026-09-17, hallazgo del cazador de
    // fallos silenciosos). Sin este corte, un índice que el criterio no puede leer —por ejemplo con
    // entradas sin `id` de texto, que el pre-check de arriba no cubre— salía por acá con las listas
    // vacías y la corrida terminaba imprimiendo «✅ Todo chunk está en el índice» con código 0: un
    // verde falso, dentro del comando que existe para reparar justamente eso.
    if (arreglo.estado === 'no-medido') {
      rotos.push(`${repo}: no se pudo medir el índice — ${arreglo.motivo}; NO se toca`);
      continue;
    }
    const porId = new Map((arreglo.reparadas || []).map((x) => [x.id, x]));
    const nuevas = [];
    for (const x of (arreglo.noReparadas || [])) console.error(`   ⚠ ${repo}/${x.id}: ${x.motivo}`);
    for (const id of faltan) {
      const r = porId.get(id);
      if (!r) continue;                       // ilegible y sin historia: ya se avisó, no se inventa
      const entrada = r.entrada;
      const obs = entrada.memories;
      const autorOrigen = r.origen === 'chunk' ? 'reconstruida del chunk' : `rescatada de ${r.origen}`;

      console.log(`   ${apply ? '+' : '·'} ${repo}/${id}: ${obs} obs, de ${entrada.created_by} (${autorOrigen})`);
      if (apply) nuevas.push(entrada);
      total++;
    }
    // ── Las entradas que YA están: ¿declaran lo que su chunk trae? ──────────────────────────
    // El chunk es la fuente de verdad y el manifest es derivado, así que recontar es
    // determinístico y no toca contenido. Un chunk ILEGIBLE no es un desajuste: es "no pude
    // mirar" — confundirlos sería corregir un archivo roto con un contador inventado.
    for (const entrada of man.chunks) {
      if (!entrada || !entrada.id || faltan.includes(entrada.id)) continue;
      const f = path.join(dirChunks, entrada.id + '.jsonl.gz');
      if (!fs.existsSync(f)) continue; // entrada sin archivo: otro problema, no es sub-declarar
      const c = contarChunk(f);
      if (!c) { console.error(`   ⚠ ${repo}/${entrada.id}: no parsea — no se puede verificar su entrada`); continue; }
      const decl = (k) => (Number.isFinite(entrada[k]) ? entrada[k] : 0);
      if (decl('sessions') === c.ses && decl('memories') === c.obs && decl('prompts') === c.prompts) continue;
      desajustes.push(`${repo}/${entrada.id}: declara s=${decl('sessions')} m=${decl('memories')} p=${decl('prompts')} · real s=${c.ses} m=${c.obs} p=${c.prompts}`);
      console.log(`   ${apply ? '~' : '·'} ${repo}/${entrada.id}: el índice declara ${decl('memories')} memoria(s) y el archivo trae ${c.obs}`);
      if (apply) { entrada.sessions = c.ses; entrada.memories = c.obs; entrada.prompts = c.prompts; }
      tocadas++;
    }

    if (apply && (faltan.length || tocadas)) {
      // 🔴 Ni reordenar todo ni salto de línea final (story 1.6, 2026-09-17). Este guion hacía las
      // dos cosas: el `sort` global movía líneas que nadie pidió tocar, y el `+ '\n'` —que engram
      // no escribe— hacía que el sync siguiente lo sacara, así que el índice aparecía modificado
      // en cada commit sin que nadie lo hubiera editado. Las nuevas se insertan en su lugar por
      // fecha, las existentes quedan donde están, y el formato lo pone el criterio.
      for (const entrada of nuevas) criterio.insertarPorFecha(man.chunks, entrada);
      fs.writeFileSync(fMan, criterio.serializar(man));
      console.log(`   ▸ ${repo}: índice actualizado (${man.chunks.length} chunks) — falta commitear .engram/`);
    }
    tocadas = 0;
  }
  for (const rr of rotos) console.error(`   🔴 ${rr}`);
  // Con `--apply` ya quedaron corregidos: gritarlos igual haría que una corrida que arregló todo
  // se lea como una corrida que encontró problemas. El detalle de cada uno ya salió arriba con `~`.
  if (!apply) for (const dd of desajustes) console.error(`   🔴 el índice sub-declara su propio contenido — ${dd}`);
  else if (desajustes.length) console.log(`   ✅ ${desajustes.length} entrada(s) del índice corregidas contra su chunk`);
  if (!total && !rotos.length && !desajustes.length) console.log('✅ Todo chunk en disco está en el índice de su repo.');
  else if (total && !apply) console.log(`\n${total} chunk(s) fuera del índice. Para arreglarlo: --reindex --apply`);
  if (desajustes.length && !apply) console.log(`\n${desajustes.length} entrada(s) del índice no cierran contra su chunk. Para arreglarlo: --reindex --apply`);
  return { total, rotos, desajustes: apply ? [] : desajustes };
}

/**
 * Las observaciones de este repo que existen en la DB y NO están en ningún chunk suyo.
 *
 * Se calcula MIRANDO LOS CHUNKS, no la fecha: es la única prueba de que la memoria viajó, y es lo
 * que hace posible el post-check del hallazgo 5 (correr esto DESPUÉS del sync y exigir cero).
 *
 * @returns {Array<{id:string,type:string}>|null} null si la DB no se pudo leer (≠ "no hay nada").
 */
function pendientesDe(r) {
  const esc = String(r.project).replace(/'/g, "''");
  let todas; let sids;
  try {
    todas = sql(`SELECT id || '|' || type FROM observations WHERE deleted_at IS NULL AND sync_id IS NOT NULL AND lower(project) = lower('${esc}');`)
      .map((l) => { const i = l.indexOf('|'); return { id: l.slice(0, i), type: l.slice(i + 1) }; });
    sids = new Map(sql(`SELECT id || '|' || sync_id FROM observations WHERE deleted_at IS NULL AND sync_id IS NOT NULL AND lower(project) = lower('${esc}');`)
      .map((l) => { const i = l.indexOf('|'); return [l.slice(0, i), l.slice(i + 1)]; }));
  } catch (_e) { return null; }

  const zlib = require('zlib');
  // 🔴 Se escanea el GRUPO entero de repos que comparten el project (hallazgo 17), no sólo el
  // representante: los 3 de Ceibo sincronizan `ceibo` y una observación exportada por el chunk
  // de un hermano YA VIAJÓ — contarla como pendiente era volver a tocarla en cada corrida.
  const dirs = [];
  for (const repoDelGrupo of (Array.isArray(r.repos) && r.repos.length ? r.repos : [r.repo])) {
    const base = path.join(raizDe(repoDelGrupo), repoDelGrupo);
    dirs.push(path.join(base, '.engram', 'chunks'));
    try {
      for (const sub of fs.readdirSync(base, { withFileTypes: true })) {
        if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
        const d = path.join(base, sub.name, '.engram', 'chunks');
        if (fs.existsSync(d)) dirs.push(d);
      }
    } catch (_e) { /* raíz ilegible: se sigue con lo que haya */ }
  }

  const yaExportadas = new Set();
  const corruptos = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.jsonl.gz')) continue;
      let txt;
      try { txt = zlib.gunzipSync(fs.readFileSync(path.join(d, f))).toString('utf8'); }
      catch (_e) {
        // Un chunk ilegible NO se ignora en silencio (hallazgo 17): sus observaciones no cuentan
        // como exportadas, así que se re-tocarían en cada corrida — trabajo de más sin aviso.
        corruptos.push(path.join(d, f));
        continue;
      }
      for (const linea of txt.split('\n')) {
        if (!linea.trim()) continue;
        let obj; try { obj = JSON.parse(linea); } catch (_e) { continue; }
        for (const x of (obj.observations || [])) if (x && x.sync_id) yaExportadas.add(x.sync_id);
      }
    }
  }
  for (const c of corruptos) console.error(`   ⚠ chunk ILEGIBLE (no cuenta como exportado — sus obs van a aparecer como varadas): ${c}`);
  return todas.filter((x) => !yaExportadas.has(sids.get(x.id)));
}

// ── El JOURNAL de la corrida (hallazgo 6, 2026-08-25) ────────────────────────────────────────
// Una falla tardía en el segundo repo dejaba al primero YA mutado y sincronizado, sin rastro de
// hasta dónde había llegado. Cada paso que muta algo deja una línea acá ANTES de hacerlo y otra
// después; si la corrida se corta a la mitad, el journal dice exactamente qué quedó tocado.
const JOURNAL = path.join(stateDirOf(os.homedir()), 'engram-rescue.jsonl');
const CORRIDA = `${new Date().toISOString()}#${process.pid}`;
function anotar(evento) {
  try {
    fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
    fs.appendFileSync(JOURNAL, JSON.stringify({ ts: new Date().toISOString(), corrida: CORRIDA, ...evento }) + '\n', 'utf8');
  } catch (_e) { /* el journal nunca rompe la corrida */ }
}

/** El nombre de proyecto que el repo declara (config.json → .engram-project), o null. */
function pinDe(dir) {
  try { return audit.pinDe(dir); } catch (_e) { return null; }
}

/**
 * ¿Dónde se exporta la memoria de este repo? Resuelto SIN tocar nada (hallazgo 4).
 *
 * 🔴 El destino de un CONTENEDOR se elegía por "el sub-repo con más chunks", sin exigir que su pin
 * fuera el proyecto. Reproducido: un proyecto `target` terminó sincronizándose dentro de un repo
 * cuyo pin era `foreign`. Ahora sólo vale un candidato cuyo pin sea EXACTAMENTE el proyecto: con
 * cero o con más de uno, se aborta y se pide `--repo`. Adivinar el destino de una mutación de
 * memoria compartida no es una comodidad, es una forma de perder datos ajenos.
 *
 * @returns {{destino: string, pin: string}|{error: string}}
 */
function resolverDestino(r) {
  const base = path.join(raizDe(r.repo), r.repo);
  if (!fs.existsSync(base)) return { error: `${r.repo}: la carpeta no existe (${base})` };

  if (fs.existsSync(path.join(base, '.git'))) {
    const pin = pinDe(base);
    if (!pin) return { error: `${r.repo}: es un repo git pero no declara project name — arreglá el pin antes de rescatar` };
    if (pin.toLowerCase() !== String(r.project).toLowerCase()) {
      return { error: `${r.repo}: su pin es \`${pin}\` y las observaciones son de \`${r.project}\` — no se exporta memoria de un proyecto al cajón de otro` };
    }
    return { destino: base, pin };
  }

  // Contenedor (Ceibo, Totora, Pacara…): la carpeta de arriba no es un repo git, así que el
  // chunk tiene que ir a un sub-repo — si no, queda exportado y de todos modos sin viajar.
  const candidatos = [];
  let subs = [];
  try { subs = fs.readdirSync(base, { withFileTypes: true }); } catch (_e) { subs = []; }
  for (const sub of subs) {
    if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
    const d = path.join(base, sub.name);
    if (!fs.existsSync(path.join(d, '.git'))) continue;
    const pin = pinDe(d);
    if (!pin || pin.toLowerCase() !== String(r.project).toLowerCase()) continue;
    candidatos.push({ d, pin });
  }
  // El dev eligió: sólo vale si es uno de los candidatos legítimos (existe, es git, pin exacto).
  if (destinoElegido) {
    const elegido = candidatos.find((c) => path.resolve(c.d) === path.resolve(path.join(raizDe(destinoElegido), destinoElegido)));
    if (elegido) return { destino: elegido.d, pin: elegido.pin };
    return { error: `${r.repo}: --target ${destinoElegido} no es un sub-repo de ${r.repo} que declare \`${r.project}\` (candidatos: ${candidatos.map((c) => path.relative(REPOS_ROOT, c.d)).join(', ') || 'ninguno'})` };
  }
  if (candidatos.length === 1) return { destino: candidatos[0].d, pin: candidatos[0].pin };
  if (!candidatos.length) {
    return { error: `${r.repo}: es un contenedor y NINGÚN sub-repo declara el proyecto \`${r.project}\`. Arreglá el pin del sub-repo que corresponda y elegilo con --target ${r.repo}/<sub-repo>` };
  }
  return {
    error: `${r.repo}: ${candidatos.length} sub-repos declaran \`${r.project}\` `
      + `(${candidatos.map((c) => path.basename(c.d)).join(', ')}). Adivinar cuál es el destino sería elegir por vos: --target ${r.repo}/<sub-repo>`,
  };
}

(async () => {
  // 🔴 El guard de la base va DESPUÉS de `--reindex` (story 1.6, 2026-09-17). El reindex mira
  // ARCHIVOS (`.engram/chunks/` y el índice), no la base local, pero el guard estaba arriba de
  // todo: en un clon recién hecho, en un agente de CI, o en la máquina de alguien que todavía no
  // corrió engram, el comando salía `1` con «nada que hacer» y no arreglaba nada — justo donde el
  // aviso diario lo manda a correr. Descubierto al escribir T17 de la suite del criterio.
  if (process.argv.includes('--reindex')) {
    const r = reindexar(APPLY);
    // Un manifest roto es un problema del REPO que este script no puede arreglar: sale ≠0 para que
    // nadie lea "corrí el reindex y dio 0" como "está todo sano".
    // Un índice que SUB-DECLARA su contenido cuenta igual (2026-09-06): es dato equivocado, no
    // dato faltante — la diferencia con un chunk sin entrada, que ya se reporta por otro lado y
    // se ve. Con `--apply` queda corregido en la misma corrida, y ahí sí sale 0.
    process.exit(r.rotos.length || (r.desajustes || []).length ? 1 : 0);
  }

  // De acá para abajo SÍ se lee la base local (el rescate de observaciones varadas la necesita).
  if (!fs.existsSync(DB)) { console.error('No está ~/.engram/engram.db — nada que hacer.'); process.exit(1); }

  const varadas = audit.engramUnexportedByRepo();
  if (varadas === null) { console.error('No se pudo leer la DB (¿falta sqlite3?). No se toca nada.'); process.exit(1); }

  const objetivo = soloRepo
    ? varadas.filter((r) => r.repo === soloRepo || (Array.isArray(r.repos) && r.repos.includes(soloRepo)))
    : varadas;
  if (!objetivo.length) {
    if (soloRepo) {
      // 🔴 Un typo en --repo decía "todo viajó" con exit 0 (hallazgo 17). "No matcheó el filtro"
      // y "no hay nada varado" son respuestas distintas: la primera es un error del comando.
      const { pinned } = audit.scanEngramRepos();
      const conocidos = pinned.map((x) => x.repo);
      if (!conocidos.includes(soloRepo)) {
        console.error(`⛔ --repo ${soloRepo}: ese repo no existe en el escaneo. Repos conocidos:`);
        for (const n of conocidos.sort()) console.error(`   · ${n}`);
        process.exit(2);
      }
      console.log(`✅ ${soloRepo}: sin observaciones varadas.`);
      process.exit(0);
    }
    console.log('✅ No hay observaciones varadas: todo lo que existe ya viajó.');
    process.exit(0);
  }

  const total = objetivo.reduce((a, r) => a + r.varadas, 0);
  console.log(`${APPLY ? '🔧' : '👁'}  ${total} observación(es) varadas en ${objetivo.length} repo(s):`);
  for (const r of objetivo) console.log(`   · ${r.repo} (${r.project}): ${r.varadas} de ${r.total}`);

  if (!APPLY) {
    console.log('\nDry-run. Para hacerlo: --apply (necesita `engram serve` andando).');
    process.exit(0);
  }

  if (!await apiViva()) {
    console.error(`\n⛔ La API local de engram no responde en ${API}.`);
    console.error('   Levantala con `engram serve` (o exportá ENGRAM_API) y volvé a correr.');
    console.error('   NO se tocó nada.');
    process.exit(1);
  }

  // ── FASE 0 — resolver TODOS los destinos ANTES del primer PATCH (hallazgo 4) ────────────────
  // Antes los PATCH salían primero y el destino se resolvía después: si el destino no existía o
  // era el equivocado, la mutación ya estaba hecha. Un dry-run que promete y una fase que muta
  // tienen que estar de acuerdo ANTES de mutar.
  const destinos = new Map();
  const errores0 = [];
  for (const r of objetivo) {
    const d = resolverDestino(r);
    if (d.error) { errores0.push(d.error); continue; }
    destinos.set(r.repo, d);
  }
  if (errores0.length) {
    console.error('\n⛔ No se tocó NADA: hay destinos que no se pueden resolver sin adivinar.');
    for (const e of errores0) console.error(`   · ${e}`);
    console.error('\n   Un rescate elige dónde escribir memoria compartida: si el destino no es inequívoco, lo elegís vos.');
    anotar({ fase: 'resolucion', ok: false, errores: errores0 });
    process.exit(1);
  }
  for (const [repo, d] of destinos) {
    if (path.resolve(d.destino) !== path.resolve(path.join(raizDe(repo), repo))) {
      console.log(`   (${repo} es un contenedor → se exporta en ${path.relative(REPOS_ROOT, d.destino)}, pin \`${d.pin}\`)`);
    }
  }
  anotar({ fase: 'resolucion', ok: true, destinos: [...destinos].map(([repo, d]) => ({ repo, destino: d.destino, pin: d.pin })) });

  const paraCommitear = [];
  const problemas = [];   // 🔴 estado de error GLOBAL (hallazgo 5): cualquier parcial sale no-cero.

  for (const r of objetivo) {
    if (presupuestoAgotado()) {
      problemas.push(`la corrida se quedó sin presupuesto de tiempo (${PRESUPUESTO_MS / 1000}s) antes de tocar ${r.repo} — sin empezar, nada a medias. Volvé a correr (es idempotente) o subí --budget <segundos>`);
      continue;
    }
    const { destino, pin } = destinos.get(r.repo);
    const pendientes = pendientesDe(r);
    if (pendientes === null) {
      problemas.push(`${r.repo}: no se pudo leer la DB para calcular lo pendiente — no se tocó nada de este repo`);
      continue;
    }
    console.log(`\n▸ ${r.repo}: tocando ${pendientes.length}…`);
    anotar({ fase: 'tocar', repo: r.repo, project: r.project, destino, pendientes: pendientes.length });

    // Lotes de 8 concurrentes + corte por presupuesto GLOBAL (hallazgo 15). Secuencial con 10s de
    // timeout por observación, 1016 varadas eran ~2h49m de peor caso; el tope tiene que ser de la
    // corrida, no multiplicarse por N. Cortar a mitad de repo es seguro: sin fase completa no hay
    // sync, y el script es idempotente.
    let ok = 0; const fallos = []; let cortadoPorTiempo = false;
    for (let i = 0; i < pendientes.length; i += 8) {
      if (presupuestoAgotado()) { cortadoPorTiempo = true; break; }
      const lote = pendientes.slice(i, i + 8);
      const res = await Promise.allSettled(lote.map((x) => tocar(x.id, x.type)));
      res.forEach((rr, j) => {
        if (rr.status === 'fulfilled') ok++;
        else { fallos.push(`${lote[j].id}: ${rr.reason && rr.reason.message}`); if (fallos.length <= 3) console.error(`   ⚠ ${rr.reason && rr.reason.message}`); }
      });
    }
    console.log(`   tocadas: ${ok}${fallos.length ? ` · fallaron: ${fallos.length}` : ''}${cortadoPorTiempo ? ' · CORTADO por presupuesto' : ''}`);
    anotar({ fase: 'tocado', repo: r.repo, ok, fallos: fallos.length, cortadoPorTiempo });

    if (cortadoPorTiempo) {
      problemas.push(`${r.repo}: la corrida se quedó sin presupuesto de tiempo (${PRESUPUESTO_MS / 1000}s) con ${pendientes.length - ok} observación(es) sin tocar — NO se sincronizó. Volvé a correr (es idempotente) o subí --budget <segundos>`);
      console.error('   ⛔ presupuesto agotado → sin sync de este repo.');
      continue;
    }

    // 🔴 Una fase PATCH incompleta NO habilita el sync (hallazgo 5). Antes un HTTP 500 o un
    // timeout seguían derecho al sync y la corrida terminaba en 0: media memoria movida, verde.
    if (fallos.length) {
      problemas.push(`${r.repo}: ${fallos.length} de ${pendientes.length} PATCH fallaron — NO se sincronizó (sería exportar la mitad y declararlo hecho)`);
      console.error('   ⛔ fase incompleta → sin sync. Arreglá la API y volvé a correr: es idempotente.');
      continue;
    }
    if (!ok) {
      console.log('   nada que tocar en este repo.');
      continue;
    }

    // ── Revalidación JUSTO antes de mutar (hallazgo 4) ────────────────────────────────────────
    const ahora = resolverDestino(r);
    if (ahora.error || path.resolve(ahora.destino) !== path.resolve(destino) || ahora.pin !== pin) {
      problemas.push(`${r.repo}: el destino cambió entre la resolución y el sync (${ahora.error || ahora.destino}) — no se sincronizó`);
      console.error('   ⛔ el destino cambió mientras corría. No se sincroniza.');
      anotar({ fase: 'revalidacion', repo: r.repo, ok: false });
      continue;
    }

    let salida = '';
    try {
      salida = execFileSync('engram', ['sync', '--project', r.project],
        { cwd: destino, encoding: 'utf8', timeout: 120000 });
    } catch (e) {
      // 🔴 Un sync con exit no-cero terminaba la corrida en 0 (hallazgo 5).
      problemas.push(`${r.repo}: el sync falló (${String(e.message || e).split('\n')[0]})`);
      console.error(`   ⚠ el sync falló en ${r.repo}`);
      anotar({ fase: 'sync', repo: r.repo, ok: false, error: String(e.message || e).slice(0, 300) });
      continue;
    }
    const linea = salida.split('\n').find((l) => /Observations:|Nothing new/.test(l)) || '';
    console.log(`   sync: ${linea.trim() || 'sin salida legible'}`);

    // ── POST-CHECK POR IDs (hallazgo 5) ───────────────────────────────────────────────────────
    // Sin esto, `Nothing new` con observaciones varadas se leía como éxito — y el cierre pedía
    // commitear un `.engram/` donde no había entrado nada. Se recalcula lo pendiente MIRANDO LOS
    // CHUNKS, que es la única prueba de que la memoria viajó.
    const despues = pendientesDe(r);
    if (despues === null) {
      problemas.push(`${r.repo}: sincronizó pero no se pudo verificar (DB ilegible) — verificalo a mano`);
    } else if (despues.length) {
      problemas.push(`${r.repo}: después del sync quedan ${despues.length} observación(es) varadas de ${pendientes.length} — el sync dijo "${linea.trim() || 'nada'}" pero los chunks no las tienen`);
      console.error(`   ⛔ post-check: siguen varadas ${despues.length}.`);
      anotar({ fase: 'postcheck', repo: r.repo, ok: false, varadasAntes: pendientes.length, varadasDespues: despues.length });
      continue;
    }
    console.log(`   ✅ verificado: las ${pendientes.length} están en los chunks de ${path.relative(REPOS_ROOT, destino)}`);
    anotar({ fase: 'postcheck', repo: r.repo, ok: true, rescatadas: pendientes.length });
    paraCommitear.push(path.relative(REPOS_ROOT, destino));
  }

  // ── CIERRE — resumen SIEMPRE, y exit code que dice la verdad ────────────────────────────────
  if (paraCommitear.length) {
    console.log('\n🔴 Falta commitear `.engram/` en: ' + paraCommitear.join(', '));
    console.log('   (el script exporta; commitear es decisión tuya, repo por repo)');
  }
  if (problemas.length) {
    console.error(`\n⛔ La corrida NO fue limpia — ${problemas.length} problema(s):`);
    for (const p of problemas) console.error(`   · ${p}`);
    console.error(`\n   Journal de la corrida: ${JOURNAL}`);
    console.error('   El script es idempotente: arreglá lo de arriba y volvé a correrlo.');
    anotar({ fase: 'cierre', ok: false, problemas: problemas.length, commitear: paraCommitear });
    process.exit(1);
  }
  if (!paraCommitear.length) console.log('\n✅ Nada quedó pendiente de exportar.');
  anotar({ fase: 'cierre', ok: true, commitear: paraCommitear });
})().catch((e) => {
  // Una excepción no atrapada terminaba la corrida sin resumen ni rastro (hallazgo 6).
  console.error(`\n⛔ La corrida se cortó: ${String(e && e.message || e)}`);
  console.error(`   Journal: ${JOURNAL} — dice hasta dónde se llegó.`);
  try { anotar({ fase: 'cierre', ok: false, excepcion: String(e && e.message || e).slice(0, 300) }); } catch (_e) { /* ya está */ }
  process.exit(1);
});
