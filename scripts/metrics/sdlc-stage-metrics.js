#!/usr/bin/env node
/**
 * sdlc-stage-metrics.js — Las métricas de ETAPA del SDLC que el playbook pide.
 *
 * Cierra una brecha contra el AI-Native SDLC Playbook: las métricas de etapa no se miden —
 * tiempo de una story hasta entregarse, cuánto sale bien al primer intento, cuánto se rehace.
 * La materia prima ya existe toda; esto es agregación, no infraestructura.
 *
 * LAS 4 SERIES y su fuente (nada se inventa; lo no medible se declara — `null` no es `0`,
 * regla heredada de lib/dashboard-metrics.js):
 *
 *  1. lead_time_days   — por story con status done: fecha del commit que CREÓ el archivo de la
 *                        story (git --diff-filter=A) → fecha del ÚLTIMO commit que la tocó.
 *                        Es un proxy declarado: "último toque estando done" ≈ cierre. Con
 *                        buckets mensuales para tener serie histórica desde el día uno.
 *  2. first_pass_ratio — del dashboard 2.0 (.dashboard/metrics-*.json, la métrica
 *                        advisor_rerun_loop_iterations): proporción de corridas del pipeline con UNA
 *                        sola vuelta de revisores. 🔴 La escribe retro-heartbeat.js con la última vuelta de
 *                        los revisores medidos; los archivos más viejos traen el conteo del
 *                        retrospective-capturer, de criterio propio (en 13 archivos cotejados, 5
 *                        contaban una vuelta de más). La serie lo dice en `nota`: un salto entre los dos
 *                        métodos es cambio de conteo, no de conducta.
 *  3. rework_ratio     — proporción de stories done con follow-ups declarados
 *                        (frontmatter `followed_up_by:` no vacío — convención §1.2 story-format).
 *  4. dod_evidence_ratio — proporción de stories done con su evidencia de cierre en el repo
 *                        (.advisors/dod-runtime/<id>-*). El escape declarado
 *                        `dod_runtime_exempt: true` NO cuenta como evidencia:
 *                        sale del cociente y va en `exentas`.
 *
 * Descubrimiento de stories: DELEGA en lib/story-discovery.js de tycon-pipeline (fuente única —
 * dos buscadores en dos repos se rompen por separado). Si el skill no está, cae RUIDOSAMENTE a un escaneo recursivo por identidad
 * declarada (`story:` en frontmatter), avisando por stderr.
 *
 * Uso:
 *   node scripts/metrics/sdlc-stage-metrics.js --repo ~/Proyectos/Acme/Backend [--repo ...]
 *   ... [--dashboard <dir>] [--since YYYY-MM-DD] [--json] [--merges-receipt <dir>/merges/bajada.json]
 *
 *   La primera vuelta lee también `<dashboard>/merges/` (los merges que el nocturno del tablero baja del buzón; un
 *   merge que está también en la raíz cuenta una vez). --merges-receipt: la constancia de esa bajada; si no es completa
 *   y de las últimas 36 horas, la primera vuelta sale «no medido» con el motivo en `global.not_measured`. Sin la opción
 *   (una corrida a mano) se mide con lo que haya.
 *
 * Exit 0 siempre (es informativo). Cobertura declarada en toda salida: un número sin
 * denominador es el problema que este script existe para arreglar.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const FO = require(path.join(__dirname, '..', 'lib', 'followup-of.js'));
const { readEnv } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));
// Qué archivo cuenta como «evidencia de cierre» lo decide el portón de CI, no este medidor:
// contar cualquier `<id>-*` —matriz, self-audit, hasta un `.jsonl`— publicaría
// «cubierta» a stories que el portón rechaza. Medido en los repos reales: con el
// criterio del portón SIN el ledger da 246/538 (un repo del equipo 128 → 35: 116 de sus 272 archivos
// son ledgers); con el ledger de smokes, que SÍ cuenta, da 359/538:
// cada «cubierta» pasa el portón.
const { esEvidenciaDeCierre } = require(path.join(__dirname, '..', 'ci', 'tycon-ci-gate.js'));

const TCG = path.resolve(__dirname, '..', '..');
// dónde escribe esta máquina sus `metrics-*.json` lo sabe night-data.js: la carpeta de estado (`<stateDir>/dashboard`),
// también desde un clon. Si este archivo viaja suelto, el `.dashboard` de siempre.
function dashboardDefault() {
  // lo que escribe la máquina vive donde dice scripts/lib/night-data.js: su carpeta de estado, nunca un clon.
  // Sin esa biblioteca al lado, el de siempre.
  // (si la biblioteca ESTÁ y no carga, tira: no se vuelve callado a otra ruta; si no pudo saber, lo avisa ella)
  { const lib = path.join(__dirname, '..', 'lib', 'night-data.js'); if (fs.existsSync(lib)) { const d = require(lib).machineDashboardDir(TCG); if (d) return d; } }
  try {
    const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
    const d = typeof TH.dashboardDir === 'function' ? TH.dashboardDir(require('os').homedir(), TCG) : null;
    if (d) return d;
  } catch (_) { /* el de siempre */ }
  return path.join(TCG, '.dashboard');
}
// Lo que se LEE por defecto: la carpeta de estado y la de la historia, donde quedaron los registros de antes (night-data.js).
// El punto del día va a la de la historia, donde lo buscan el instalador y el tablero: la de estado no la mira nadie.
function nightDefaults() {
  const lib = path.join(__dirname, '..', 'lib', 'night-data.js');
  if (!fs.existsSync(lib)) return null;
  const m = require(lib).machineDashboard(TCG);
  if (m.historyWhy) process.stderr.write(`⚠️ sdlc-stage-metrics: ${m.historyWhy}\n`);
  return m.dir ? { dirs: [m.dir, m.history].filter(Boolean), snapshot: m.history || m.dir } : null;
}
// Dónde están las skills lo dice LA función que usan todos, no una ruta armada acá: la variable
// TYCON_SKILLS_DIR › el propio clon si es unido › ~/.claude/agent-skills. Así, corriendo desde un clon que trae su propio
// descubridor de stories, se usa ése y no el INSTALADO.
const SKILLS_DIR = require(path.join(__dirname, '..', 'lib', 'skills-dir.js')).resolveSkillsDirs().skills;
const DISCOVERY_PATH = path.join(SKILLS_DIR, 'tycon-pipeline', 'scripts', 'lib', 'story-discovery.js');

// ── args ─────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { repos: [], scan: [], dashboard: dashboardDefault(), since: null,
              json: false, snapshot: false, help: false, budgetMs: BUDGET_TRANSICIONES_MS };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--repo') a.repos.push(path.resolve(argv[++i]));
    else if (k === '--scan') a.scan.push(path.resolve(argv[++i]));
    else if (k === '--dashboard') { a.dashboard = path.resolve(argv[++i]); a.dashboardGiven = true; }
    else if (k === '--since') a.since = argv[++i];
    else if (k === '--merges-receipt') a.mergesReceipt = path.resolve(argv[++i]);
    else if (k === '--json') a.json = true;
    else if (k === '--snapshot') a.snapshot = true;
    else if (k === '--only-harness') a.onlyHarness = true;
    else if (k === '--transitions-budget-ms') {
      const v = Number.parseInt(argv[++i], 10);
      // Un presupuesto ilegible NO se toma como "sin presupuesto": eso es exactamente el
      // cuelgue que este tope existe para impedir. Se avisa y se usa el default.
      if (Number.isFinite(v) && v > 0) a.budgetMs = v;
      else console.error(`⚠️  --transitions-budget-ms inválido — sigo con el default de ${BUDGET_TRANSICIONES_MS} ms`);
    } else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

/**
 * Descubre repos git bajo una raíz (depth ≤ 2: `<raíz>/<repo>` y `<raíz>/<proyecto>/<repo>`,
 * que es como suele estar organizada la raíz de repos).
 *
 * 🔴 Existe porque pasar la lista a mano falla: una
 * pasada global mide los repos de implementación —que no contienen las stories— y
 * reporta "0 stories" en 15 repos que sí tienen trabajo, en otro repo del mismo proyecto. Una
 * lista escrita a mano sólo mide lo que alguien se acordó de anotar, que es justo el modo de
 * falla que el arnés persigue en todas partes.
 */
function discoverRepos(root, depth = 0, out = []) {
  if (depth > 2 || out.length > 200) return out;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.name === '.git')) { out.push(root); return out; }
  const SKIP = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', 'Library', 'Applications']);
  // 🔴 ORDENADO. `fs.readdirSync` no garantiza orden, y ese orden se propaga hasta el tablero: los
  //    mapas agregados (`conteo`, `sin_diccionario`, `por_grupo`) se construyen por inserción, y
  //    las fichas que muestran «los tres/cinco que más tienen» ordenan por valor — con empates,
  //    cuáles aparecen lo decide el orden de inserción. Con cuatro repos empatados en 1, invertir el orden de escaneo cambia la lista
  //    entera de la ficha sin que haya cambiado un solo dato. En el nocturno los clones se rehacen
  //    cada noche, así que ese orden puede cambiar solo.
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
    discoverRepos(path.join(root, e.name), depth + 1, out);
  }
  return out;
}

// ── frontmatter (mismo espíritu que lint-story-frontmatter: regex tolerante, no parser) ──────

/**
 * El regex de UNA clave del frontmatter. Fuente ÚNICA: lo comparten el lector de archivos del
 * disco y el lector de versiones HISTÓRICAS que salen de git. Dos
 * expresiones para la misma línea se separan solas el día que alguien toca una de las dos —
 * y el síntoma sería silencioso: un `status: review  # nota` leído como `review  # nota`.
 */
function fmKeyRe(key) { return new RegExp(`^\\s*${key}:\\s*["']?([^"'#\\n]+)`, 'm'); }

/** El parser sobre TEXTO. `readFrontmatter` es este mismo sobre un archivo del disco. */
function parseFrontmatter(body) {
  const m = String(body).match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!m) return null;
  const fm = m[1];
  const get = (key) => {
    const r = fm.match(fmKeyRe(key));
    return r ? r[1].trim() : null;
  };
  // followed_up_by: inline no-vacío (`[x]`) o bloque con al menos un `- item`.
  let followups = false;
  const fu = fm.match(/^\s*followed_up_by:\s*(.*)$/m);
  if (fu) {
    const inline = fu[1].trim();
    if (inline && inline !== '[]' && !inline.startsWith('#')) followups = true;
    else {
      const after = fm.slice(fm.indexOf(fu[0]) + fu[0].length);
      const next = after.match(/^\s*-\s+\S/m);
      const nextKey = after.match(/^\S/m);
      if (next && (!nextKey || after.indexOf(next[0]) < after.indexOf(nextKey[0]))) followups = true;
    }
  }
  // ── La causa del reproceso — lado HIJA ──────────────────────────────────────────
  // `followups` (arriba) mira `followed_up_by:`: las PADRES que volvieron, que es lo que cuenta
  // `rework_ratio`. Acá se mira la otra punta: la story que HACE el seguimiento, que es quien
  // escribe la causa. Una padre con tres hijas de causas distintas no tiene *una* causa.
  //
  // 🔴 La lectura del bloque vive en `lib/followup-of.js` — UNA sola, compartida con el lint. Ver
  //    la cabecera de esa lib para los cuatro defectos que produjo tenerla duplicada.
  return {
    id: get('story'),
    status: (get('status') || '').toLowerCase(),
    followups,
    followupOf: FO.tieneFollowupOf(fm),
    // El valor CRUDO: el medidor no juzga si es válido, lo clasifica (lo que no está en el
    // vocabulario se publica con su nombre en `fuera_de_vocabulario`, no se descarta).
    followupReason: get('followup_reason'),
    followupTypes: FO.tiposDeFollowupOf(fm),
    dodExempt: /^\s*dod_runtime_exempt:\s*true\b/m.test(fm),
  };
}

function readFrontmatter(file) {
  let body;
  try { body = fs.readFileSync(file, 'utf8'); } catch { return null; }
  return parseFrontmatter(body);
}

// ── descubrimiento (canónico, con fallback ruidoso) ──────────────────────────────────────────

// `partial`: un recorrido que no terminó puede dejar afuera a las stories que repiten un número, y con
// eso la clave de la evidencia se calcularía a ciegas. Quien mide la evidencia lo mira y dice «no medido».
function discoverStoryFiles(repo, budgetMs = 15000) {
  try {
    const discovery = require(DISCOVERY_PATH);
    const configRoot = discovery.findRepoRoot(repo) || repo;
    const found = discovery.discoverStories(repo, { configRoot, budgetMs, cache: false });
    for (const w of found.warnings || []) console.error(`⚠️  [${path.basename(repo)}] ${w}`);
    return { files: found.stories.map((s) => s.path), canonical: true, partial: !!found.partial };
  } catch {
    console.error(`⚠️  [${path.basename(repo)}] lib/story-discovery.js de tycon-pipeline no disponible `
      + `(${DISCOVERY_PATH}) — caigo al escaneo plano por identidad declarada. `
      + 'Instalá agent-skills o seteá TYCON_SKILLS_DIR para el descubridor canónico.');
    const out = [];
    const SKIP = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', '.advisors', '.engram', 'artifacts']);
    const walk = (dir, depth) => {
      if (depth > 6 || out.length > 5000) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), depth + 1); }
        else if (e.name.endsWith('.md')) out.push(path.join(dir, e.name));
      }
    };
    walk(repo, 0);
    return { files: out, canonical: false };
  }
}

// ── git ──────────────────────────────────────────────────────────────────────────────────────

function git(repo, args, timeoutMs = 15000) {
  try {
    return execFileSync('git', ['-C', repo, ...args],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }).trim();
  } catch { return null; }
}

function storyDates(repo, file) {
  const rel = path.relative(repo, file);
  const created = git(repo, ['log', '--follow', '--diff-filter=A', '--format=%aI', '--', rel]);
  const last = git(repo, ['log', '-1', '--format=%aI', '--', rel]);
  const createdAt = created ? created.split('\n').filter(Boolean).pop() : null;
  return { createdAt: createdAt || null, lastAt: last || null };
}

// ── el reproceso por CARRIL ──────────────────────────────────────────────────────
//
// ¿Lo que pasó por el pipeline vuelve menos que lo que no? El carril de una STORY se deduce de lo
// que ya viaja por git: la carpeta `.advisors/pipeline-runs/<story>-<ts>/` que el pipeline deja en el
// repo de la story (medido en 5 repos). Sólo árboles y commits: en un
// clon sin blobs no baja nada.
//
// 🔴 La VENTANA: sólo cuentan las stories cerradas desde la primera corrida guardada en ESE repo. Una
//    story cerrada antes no pudo dejar constancia aunque haya pasado por el pipeline; contarla como
//    «sin constancia» haría que el grupo sin corrida cargue con toda la historia del repo.
// 🔴 El grupo se llama «sin constancia de corrida», no «a mano»: una corrida que no se guardó cae ahí.
// Repo sin la carpeta → `null` con motivo, nunca dos ceros.
/** @param {Map} cierreDe story → fecha ISO de su cierre (o null: no se pudo fechar). */
function reworkPorCarril(repo, done, cierreDe, claveDe = (s) => s.id) {
  const lista = git(repo, ['ls-tree', '-d', '--name-only', 'HEAD', '.advisors/pipeline-runs/']);
  if (lista === null) return { valor: null, motivo: 'rework por carril: no se pudo leer el árbol del repo' };
  const corridas = lista.split('\n').map((l) => path.basename(l.trim())).filter(Boolean);
  if (!corridas.length) return { valor: null, motivo: 'rework por carril: el repo no guarda las ejecuciones del pipeline (.advisors/pipeline-runs/) — no se puede separar lo que pasó por él' };
  const altas = git(repo, ['log', '--diff-filter=A', '--format=%aI', '--', '.advisors/pipeline-runs']);
  const primera = altas ? altas.split('\n').filter(Boolean).pop() : null;
  const desde = primera ? primera.slice(0, 10) : null;
  if (!desde) return { valor: null, motivo: 'rework por carril: no se pudo fechar la primera ejecución guardada' };
  const con = { num: 0, den: 0 };
  const sin = { num: 0, den: 0 };
  let fuera = 0;
  let sinFecha = 0;
  for (const s of done) {
    const cierre = cierreDe.get(s);
    if (!cierre) { sinFecha += 1; continue; }
    if (cierre.slice(0, 10) < desde) { fuera += 1; continue; }
    // La carpeta es `<clave>-<fecha>`: después del guion viene la fecha (8 dígitos). Así la corrida de
    // «1.10» no le da constancia a «1.1», ni la de «1.3-B» a «1.3». La clave es el número si
    // es único en el repo y `<tema>__<número>` si se repite: una corrida de otra story del mismo número
    // no cuenta como «pasó por el pipeline».
    const suya = new RegExp(`^${String(claveDe(s)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}`);
    const g = corridas.some((c) => suya.test(c)) ? con : sin;
    g.den += 1;
    if (s.followups) g.num += 1;
  }
  return { valor: { desde, con_corrida: con, sin_constancia: sin, fuera_de_ventana: fuera, sin_fecha: sinFecha }, motivo: null };
}

// ── transiciones de estado derivadas de git ──────────────────────────────────────
//
// La serie de estados de cada story YA está escrita: cada cambio de `status:` fue un commit.
// Lo caro no es leerla, es CÓMO se lee en los clones que usa el nocturno, que son
// `--filter=blob:none`: ahí git baja cada versión de archivo BAJO DEMANDA, con un viaje de red
// por blob. Medido sobre un repo de 282 stories y 1430 versiones:
//
//   · `git log -p --follow -G'^status:'` por story ... 142 s para SÓLO 20 stories (~33 min
//     extrapolado) y 51 viajes de red: `-G` tiene que DIFERENCIAR, así que baja los dos blobs
//     de cada commit que toca el archivo, no sólo los que cambian el estado.
//   · `--follow` por story ....................... 31 s para 20: la detección de renombres
//     inexactos compara CONTENIDO, así que también baja blobs.
//   · lo que se hace acá ......................... 7,5 s para las 282, en 3 viajes.
//
// La mecánica son tres pasos, y el orden es lo que la hace barata:
//   1. UNA consulta al historial con `--raw`, que devuelve los OIDs de blob desde los ÁRBOLES:
//      cero red, 0,06 s. (`--no-renames` es a propósito: la detección de renombres es
//      justamente lo que obliga a bajar contenido.) 🔴 Con `--diff-merges=first-parent`
//      EXPLÍCITO: sin él, que un commit de merge emita o no sus líneas `--raw`
//      depende de la versión de git —con git 2.50 de Apple no las emite—, y la resolución de
//      un conflicto sobre la línea `status:` desaparece de la serie sin error ni aviso.
//      Medido en este repo (1109 commits, 34
//      merges): +168 líneas leídas, mismo tiempo.
//   2. UN `git fetch` por lote de esos OIDs — el mismo mecanismo de la bajada perezosa, pero
//      en un viaje en vez de 1430.
//   3. `git cat-file --batch`, ya sin red.
//
// El renombre NO se resuelve con `--follow` sino agrupando por la IDENTIDAD DECLARADA
// (`story:` dentro del frontmatter) en vez de por la ruta: queda a prueba de renombres y de
// mudanzas de carpeta por construcción, sin heurística que calibrar. Es el mismo criterio que
// este arnés adopta para DESCUBRIR stories (lib/story-discovery.js: la pertenencia la decide
// lo declarado, no la ruta) — decidir por ruta acá sería caer en el defecto que ese
// criterio evita.

// ── el diccionario de estados ────────────────────────────────────────────────────
//
// 🔴 Se lee AL MEDIR, no al cargar el módulo. Dos razones, y la segunda es la que importa:
//   (a) `TYCON_STATES_PATH` permite inyectar un diccionario de fixture en los casos, y con la
//       carga al `require` el fixture no tendría ningún efecto (el módulo ya leyó el canónico);
//   (b) el criterio de «cerrado» sale de `groups.cerrado` — cachearlo al arranque haría que
//       mover un estado de grupo NO mueva el conteo, y tiene que moverlo.
//
// 🔴 Y la inyección DEJA RASTRO: `global.diccionario` publica ruta y hash del archivo realmente
//    usado. Sin eso sería un control apagable por config — una máquina con esa
//    variable puesta publicaría métricas de otro diccionario y el snapshot se vería idéntico.
const ESTADOS_PATH = path.join(__dirname, 'states.json');
const rutaEstados = () => readEnv('TYCON_STATES_PATH', { where: 'scripts/metrics/sdlc-stage-metrics.js' }) || ESTADOS_PATH;

/**
 * Motivo por el que el diccionario NO se puede usar, o `null` si está bien.
 *
 * 🔴 Es UNA función y no cinco `if` desperdigados: los cinco caminos terminan en el mismo cero
 *    falso, y con la guarda repetida el día que alguien agregue el sexto se olvida de uno.
 *    Los cinco, medidos: (a) archivo ausente · (b) JSON roto · (c) JSON válido SIN la clave
 *    `groups` —que es el diccionario mínimo, o sea a donde vuelve el archivo si
 *    alguien lo revierte o un merge lo pisa— · (d) `groups.cerrado` presente pero vacío ·
 *    (e) `groups.cerrado` con valores que no son canónicos (un alias en vez del canónico: el
 *    archivo se ve bien formado y `done` da []).
 */
function validarDiccionario(d) {
  if (!d || d.__error) return `no se pudo leer el diccionario de estados (${(d && d.__error) || 'ausente'})`;
  if (!Array.isArray(d.canonical) || !d.canonical.length) {
    return 'el diccionario de estados no trae la lista `canonical`';
  }
  if (!d.groups || typeof d.groups !== 'object') {
    return 'el diccionario de estados no trae la clave `groups` — es el archivo mínimo de la 2.1, '
      + 'que no sabe qué es «cerrado» ni qué es «en curso»';
  }
  const cerrado = d.groups.cerrado;
  if (!Array.isArray(cerrado) || !cerrado.length) {
    return 'el diccionario de estados trae `groups.cerrado` vacío: sin él no se sabe qué story está cerrada';
  }
  // 🔴 Las DOS direcciones, y se validan ACÁ y no sólo sobre el archivo commiteado.
  //    El caso de `states-dictionary.test.js` mira el `states.json` del repo; el que llega
  //    al medidor puede ser OTRO (`TYCON_STATES_PATH`, un merge que pise el archivo, una edición
  //    a mano), y ahí no habría ninguna guarda. Son dos fallas distintas con el mismo disfraz de archivo
  //    bien formado:
  //      (a) una entrada de grupo que NO es canónica (un alias, un typo) → ese estado desaparece
  //          de `por_grupo` y `sum(por_grupo) < sum(conteo)` sin que nada lo diga;
  //      (b) un canónico en DOS grupos → `porGrupo` corta en el primero que matchea, así que
  //          `por_grupo.cerrado` puede dar 0 mientras `done_total` da 2 — dos números que el
  //          smoke asume iguales, desincronizados en cada corrida nocturna;
  //      (c) un canónico SIN grupo → sale del denominador de la ficha sin que nadie lo note.
  const grupoDe = new Map();
  for (const [g, lista] of Object.entries(d.groups)) {
    if (!Array.isArray(lista)) {
      return `el diccionario de estados tiene el grupo \`${g}\` que no es una lista`;
    }
    for (const e of lista) {
      if (!d.canonical.includes(e)) {
        return `el diccionario de estados tiene en \`groups.${g}\` un valor que no es canónico `
          + `(${e}) — ese estado queda fuera del conteo por grupo con el archivo bien formado`;
      }
      if (grupoDe.has(e)) {
        return `el diccionario de estados tiene el canónico \`${e}\` en dos grupos `
          + `(${grupoDe.get(e)} y ${g}) — los números por grupo dejan de sumar su denominador`;
      }
      grupoDe.set(e, g);
    }
  }
  const huerfanos = d.canonical.filter((c) => !grupoDe.has(c));
  if (huerfanos.length) {
    return `el diccionario de estados tiene canónicos sin grupo (${huerfanos.join(', ')}) — `
      + 'salen del denominador de la ficha sin que nadie lo note';
  }
  return null;
}

let _dicCache = null;
let _dicKey = null;

/**
 * El diccionario vigente: `{ruta, hash, canonicos, alias, grupos, motivo}`. Las claves del archivo están en inglés
 * (`canonical`, `groups`); los nombres de este objeto son internos y no cambian.
 */
function diccionario() {
  const ruta = rutaEstados();
  let key = `${ruta}|ausente`;
  try { const st = fs.statSync(ruta); key = `${ruta}|${st.mtimeMs}|${st.size}`; } catch { /* ausente */ }
  if (key === _dicKey) return _dicCache;
  _dicKey = key;

  let crudo = null;
  let hash = null;
  try {
    const txt = fs.readFileSync(ruta, 'utf8');
    hash = require('crypto').createHash('sha256').update(txt).digest('hex').slice(0, 12);
    crudo = JSON.parse(txt);
  } catch (e) {
    crudo = { __error: e.message };
  }
  const d = {
    ruta,
    hash,
    canonicos: Array.isArray(crudo.canonical) ? crudo.canonical : [],
    alias: (crudo.alias && typeof crudo.alias === 'object') ? crudo.alias : {},
    grupos: (crudo.groups && typeof crudo.groups === 'object') ? crudo.groups : null,
    motivo: validarDiccionario(crudo),
  };
  _dicCache = d;
  return d;
}

// ── El vocabulario de CAUSAS del reproceso ────────────────────────────────────────
//
// Mismo archivo que lee `lint-story-frontmatter.js` — dos listas del mismo vocabulario en dos
// archivos se separan solas (como pasaría con los diccionarios de estados). Y misma guarda que
// `TYCON_STATES_PATH`: la ruta y el hash del archivo REALMENTE usado se publican en el snapshot,
// para que la variable de inyección no se vuelva un interruptor invisible.
const CAUSAS_PATH = path.join(__dirname, 'rework-causes.json');
const rutaCausas = () => readEnv('TYCON_CAUSES_PATH', { where: 'scripts/metrics/sdlc-stage-metrics.js' }) || CAUSAS_PATH;

let _causasCache = null;
let _causasKey = null;

/** `{ruta, hash, causas[], motivo}` — la lectura vive en `lib/followup-of.js`; acá sólo el cache. */
function causasReproceso() {
  const ruta = rutaCausas();
  let key = `${ruta}|ausente`;
  try { const st = fs.statSync(ruta); key = `${ruta}|${st.mtimeMs}|${st.size}`; } catch { /* ausente */ }
  if (key === _causasKey) return _causasCache;
  _causasKey = key;
  _causasCache = FO.leerCausas(ruta);
  return _causasCache;
}

/**
 * El conteo por CAUSA sobre las stories que declaran `followup_of:` — las HIJAS, en cualquier
 * estado (la causa se conoce al crearlas, no al cerrarlas).
 *
 * Invariante que se verifica desde el JSON publicado:
 *   sum(conteo) + sin_declarar + sum(fuera_de_vocabulario) === total
 *   sum(sin_declarar_por_type) === sin_declarar
 *
 * Las cuatro causas aparecen SIEMPRE, aun en cero: una barra ausente y una barra en cero no son
 * lo mismo. Un valor fuera del vocabulario NO se descarta ni se manda a «sin declarar»: se
 * publica con su nombre, que es la lista de trabajo de quien lo escribió mal.
 */
function contarCausas(stories, vocab) {
  // `Object.create(null)`: la clave es el valor CRUDO del frontmatter — texto que escribe
  // cualquiera en cualquier repo. Con un objeto literal, `followup_reason: __proto__` lee la
  // propiedad HEREDADA en vez de un contador (le pasa también a `status:`).
  const conteo = Object.create(null);
  for (const c of vocab.causas) conteo[c] = 0;
  const fuera = Object.create(null);
  const porType = Object.create(null);
  // `sin_type` es un balde CONOCIDO, no un `type` cualquiera: va siempre, aunque valga 0 — igual
  // que `sin_status` en el contador de estados. Que aparezca o no según el fixture haría
  // que el pie del tablero diga «13 sin type» un día y nada al otro, sin que cambie el criterio.
  porType.sin_type = 0;
  let sinDeclarar = 0;
  let total = 0;
  for (const s of stories) {
    if (!s.followupOf) continue;
    total += 1;
    const raw = s.followupReason == null ? '' : String(s.followupReason).trim();
    if (!raw) {
      sinDeclarar += 1;
      // El desglose de las «sin declarar» por el `type` que YA traen. Es contexto DERIVADO —el
      // tablero lo rotula así— y nunca entra a las cuatro barras: una causa adivinada
      // contaminaría la línea base contra la que se mide la alarma de esta ficha.
      const tipos = Array.isArray(s.followupTypes) ? s.followupTypes : [];
      if (!tipos.length) porType.sin_type = (porType.sin_type || 0) + 1;
      else {
        // Una story con varios padres cuenta UNA vez, por su `type` dominante (el primero): el
        // desglose tiene que sumar exactamente `sin_declarar`, o el invariante deja de cerrar.
        const t = tipos[0];
        porType[t] = (porType[t] || 0) + 1;
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(conteo, raw)) conteo[raw] += 1;
    else fuera[raw] = (fuera[raw] || 0) + 1;
  }
  return { conteo, sin_declarar: sinDeclarar, fuera_de_vocabulario: fuera,
    sin_declarar_por_type: porType, total };
}

const BUDGET_TRANSICIONES_MS = 60000;   // configurable con --transitions-budget-ms
const LOTE_BLOBS = 500;                 // el tamaño medido: 1430 OIDs → 3 viajes

/** Canónico del estado, o `desconocido:<crudo>`. Nunca descarta: lo que no conoce, lo marca. */
function canonEstado(valor) {
  const k = String(valor == null ? '' : valor).trim().toLowerCase();
  if (!k) return null;
  const d = diccionario();
  if (d.canonicos.includes(k)) return { estado: k, desconocido: null };
  if (Object.prototype.hasOwnProperty.call(d.alias, k)) return { estado: d.alias[k], desconocido: null };
  return { estado: `desconocido:${k}`, desconocido: k };
}

/**
 * El contador del PRESENTE: el `status:` de HOY de cada story, en tres baldes que suman exacto.
 *
 * 🔴 Es OTRA cosa que `estados_desconocidos`, que mira cada versión HISTÓRICA de cada story
 *    (ahí `blocked 6` son seis que ALGUNA VEZ lo estuvieron, hoy ninguna). Los dos hacen falta y
 *    miden cosas distintas; el nombre distinto es a propósito.
 * 🔴 `sin_status` es un balde propio y obligatorio: una story con `story:` y sin `status:` entra
 *    a `stories_total` (el medidor sólo exige el id) y `canonEstado('')` devuelve `null`. Sin
 *    balde, o el invariante no cierra o alguien la descarta en silencio para que cierre — que es
 *    peor, porque desaparece del denominador y nada lo dice.
 */
function contarEstados(stories, d) {
  // 🔴 `Object.create(null)` y no `{}`: la clave es el valor CRUDO del frontmatter, o sea texto
  //    que escribe cualquiera en cualquier repo. Con un objeto literal, una story con
  //    `status: __proto__` (o `constructor`, o `toString`) lee la propiedad HEREDADA en vez de un
  //    contador: el conteo sale mal o revienta, y el invariante de los conteos se rompe sin decir por
  //    qué.
  const conteo = Object.create(null);
  const sinDiccionario = Object.create(null);
  let sinStatus = 0;
  for (const s of stories) {
    const c = canonEstado(s.status);
    if (!c) { sinStatus += 1; continue; }
    if (c.desconocido) {
      sinDiccionario[c.desconocido] = (sinDiccionario[c.desconocido] || 0) + 1;
    } else {
      conteo[c.estado] = (conteo[c.estado] || 0) + 1;
    }
  }
  return { conteo, sin_diccionario: sinDiccionario, sin_status: sinStatus, total: stories.length,
    por_grupo: porGrupo(conteo, d) };
}

/**
 * El conteo YA SUMADO por grupo. Lo publica el medidor para que el tablero lea ESTO y no el
 * diccionario del disco: el tablero se renderiza cuando alguien lo corre, con un snapshot que
 * pudo generarse ayer con otro diccionario. Si entonces alguien agrega un canónico o lo mueve de
 * grupo, las stories de ese estado desaparecerían de los tres números y nada lo delataría — los
 * tres no suman al total por diseño (cerrado y cancelado no se muestran), así que faltar uno más
 * no se nota. Una sola fuente: el snapshot.
 */
function porGrupo(conteo, d) {
  const out = Object.create(null);
  for (const g of Object.keys((d && d.grupos) || {})) out[g] = 0;
  for (const [estado, n] of Object.entries(conteo)) {
    for (const [g, lista] of Object.entries((d && d.grupos) || {})) {
      if (Array.isArray(lista) && lista.includes(estado)) { out[g] += n; break; }
    }
  }
  return out;
}

/** ¿Es un clon parcial? Sólo ahí tiene sentido salir a la red; en un clon normal ya está todo. */
function esClonParcial(repo) {
  if (git(repo, ['config', '--get', 'remote.origin.promisor']) === 'true') return true;
  return git(repo, ['config', '--get', 'extensions.partialclone']) !== null;
}

/** Baja un lote de blobs en UN viaje. Devuelve false si no pudo (queda como `faltante`). */
function traerBlobs(repo, oids) {
  return git(repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin', ...oids],
    120000) !== null;
}

/** Lee un lote de blobs YA locales. Devuelve el texto de los que están y la lista de los que no. */
function leerBlobs(repo, oids) {
  const textos = new Map();
  const faltantes = [];
  if (!oids.length) return { textos, faltantes };
  let buf;
  try {
    buf = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], {
      input: `${oids.join('\n')}\n`, timeout: 120000, maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    return { textos, faltantes: oids.slice() };   // no pude leer NINGUNO: todos faltantes
  }
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) break;
    const partes = buf.slice(i, nl).toString('utf8').split(' ');
    i = nl + 1;
    // `<oid> missing` (blob ausente en un clon parcial sin red) vs `<oid> blob <tamaño>`
    if (partes.length < 3) { if (partes[0]) faltantes.push(partes[0]); continue; }
    const size = Number.parseInt(partes[2], 10);
    if (!Number.isFinite(size)) break;            // salida inesperada: se corta, no se adivina
    textos.set(partes[0], buf.slice(i, i + size).toString('utf8'));
    i += size + 1;                                // el \n que git agrega después del contenido
  }
  return { textos, faltantes };
}

/**
 * Desescapa una ruta que git citó entre comillas. Con `core.quotepath=false` esto casi nunca
 * hace falta (las tildes ya vienen literales), pero una ruta con comillas o saltos de línea
 * sigue viniendo citada — y una ruta que no matchea se pierde en SILENCIO, que es el modo de
 * falla que este archivo persigue. Lo levantó el revisor de seguridad en la 3ª vuelta.
 */
function desescaparRuta(r) {
  if (!r.startsWith('"')) return r;
  const cuerpo = r.slice(1, -1);
  return cuerpo.replace(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (m, g) => {
    if (g[0] === 'x') return String.fromCharCode(parseInt(g.slice(1), 16));
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8));
    return ({ n: '\n', t: '\t', '"': '"', '\\': '\\' })[g] || g;
  });
}

/**
 * Las rutas que fueron RENOMBRADAS, encadenadas hasta la actual. Se calcula DESPUÉS de traer
 * los blobs, porque la detección de renombres compara contenido: en ese momento ya es gratis.
 *
 * Cubre un caso fácil de pasar por alto: una story que se MUDA de carpeta **y** se RENUMERA queda sin poder
 * atribuirse por ninguno de los dos lados —ni por el `story:` declarado (ya no existe) ni por la
 * ruta (es la vieja)— y su historia previa se descartaría sin dejar rastro.
 */
function mapaDeRenombres(repo) {
  const mapa = new Map();
  const log = git(repo, ['-c', 'core.quotepath=false', 'log', '--topo-order', '--reverse',
    '--format=', '--raw', '--no-abbrev', '--find-renames', '--diff-merges=first-parent', '--', '*.md'], 120000);
  // 🔴 `ok` existe porque un Map vacío por FALLO se leería igual que "miré y no hay renombres" —
  // y es la consulta más lenta del archivo, justo la que se cae en los repos grandes.
  if (log === null) return { mapa, ok: false };
  for (const linea of log.split('\n')) {
    if (!linea.startsWith(':')) continue;
    const partes = linea.split('\t');
    if (partes.length < 3) continue;
    const estado = partes[0].trim().split(/\s+/).pop();
    if (!/^R/.test(estado)) continue;
    mapa.set(desescaparRuta(partes[1]), desescaparRuta(partes[2]));
  }
  return { mapa, ok: true };
}

/**
 * La serie de estados de cada story del repo, derivada del historial.
 *
 * `stories` son las stories ACTUALES ({file, id}) — el denominador. Las borradas no entran:
 * medir el tiempo de etapa de algo que ya no existe ensuciaría la serie sin que nadie pueda
 * accionarla.
 */
function derivarTransiciones(repo, stories, opts = {}) {
  // El reloj y el tamaño de lote son inyectables SÓLO para poder escribir el caso del
  // agotamiento a mitad de camino sin depender de la velocidad de la máquina.
  const ahora = typeof opts.reloj === 'function' ? opts.reloj : Date.now;
  const lote = Number.isFinite(opts.loteBlobs) && opts.loteBlobs > 0 ? opts.loteBlobs : LOTE_BLOBS;
  const t0 = ahora();
  const budget = Number.isFinite(opts.budgetMs) ? opts.budgetMs : BUDGET_TRANSICIONES_MS;
  const vacio = {
    transiciones: {}, sinTransiciones: 0, desconocidos: {}, storiesFaltantes: [],
    medidas: 0, idsDuplicados: [], archivosDuplicados: 0, idsRenumerados: [],
    versionesHuerfanas: 0, versionesIlegibles: 0, renombresLeidos: true, cadenasTruncadas: 0,
    total: stories.length, agotado: null, motivo: null, medible: true,
  };
  if (!stories.length) return { ...vacio, motivo: 'transiciones: el repo no tiene stories' };

  // Dos archivos distintos que declaran el MISMO `story:` no se pueden atribuir: agruparlos por
  // ese id fusiona dos historias independientes en una serie inventada, con transiciones que no
  // ocurrieron en ninguno de los dos, y hace desaparecer a uno adentro del otro.
  // Se sacan del cálculo y se NOMBRAN — no se adivina cuál es cuál.
  const cuentaPorId = new Map();
  for (const st of stories) cuentaPorId.set(st.id, (cuentaPorId.get(st.id) || 0) + 1);
  const idsDuplicados = [...cuentaPorId].filter(([, n]) => n > 1).map(([k]) => k).sort();
  const dup = new Set(idsDuplicados);
  const archivosDuplicados = stories.filter((st) => dup.has(st.id)).length;

  const idsActuales = new Set(stories.filter((st) => !dup.has(st.id)).map((st) => st.id));
  const rutaAId = new Map(stories.filter((st) => !dup.has(st.id))
    .map((st) => [path.relative(repo, st.file), st.id]));

  // 1 · UNA consulta, sobre TODOS los markdown del repo. El pathspec es `*.md` y no la carpeta
  //     de cada story a propósito: una story que se MUDÓ de carpeta perdería toda su historia
  //     anterior a la mudanza si el filtro fuera por carpeta (medido: 0,14 s contra 0,06 s por
  //     acotar a una carpeta — el seguro sale 0,08 s).
  // `--topo-order --reverse`: los commits salen del más viejo al más nuevo y SIEMPRE un
  // ancestro antes que su descendiente. Ese orden es el causal y viene gratis — un desempate
  // por sha no tiene ninguna relación con el orden real y podría INVERTIR
  // dos transiciones e inventar una que nunca ocurrió.
  const log = git(repo, ['-c', 'core.quotepath=false', 'log', '--topo-order', '--reverse',
    '--format=C%x09%H%x09%aI', '--raw', '--no-abbrev', '--no-renames', '--diff-merges=first-parent', '--', '*.md'], 120000);
  if (log === null) {
    return { ...vacio, medible: false,
      motivo: 'transiciones: no se pudo leer el historial de git (git log falló o se pasó de su tope '
        + 'de 120 s, que NO lo gobierna --transitions-budget-ms) — este repo no aporta nada, ni ceros' };
  }

  const entradas = [];
  let sha = null;
  let fecha = null;
  for (const linea of log.split('\n')) {
    if (linea.startsWith('C\t')) { const p = linea.split('\t'); sha = p[1]; fecha = p[2]; continue; }
    if (!linea.startsWith(':')) continue;
    const m = linea.match(/^:\S+ \S+ \S+ ([0-9a-f]+) (\S+)\t(.+)$/);
    if (!m || !sha) continue;
    if (/^0+$/.test(m[1])) continue;     // borrado: no hay versión que leer
    entradas.push({ sha, fecha, oid: m[1], ruta: desescaparRuta(m[3]), orden: entradas.length });
  }

  // 2 y 3 · bajar (sólo si el clon es parcial) y leer, por lotes. El presupuesto se chequea
  //         ENTRE lotes: así un repo enorme se corta con la mitad hecha en vez de colgar el paso.
  const oids = [...new Set(entradas.map((e) => e.oid))];
  const parcial = esClonParcial(repo);
  const textos = new Map();
  const faltantes = new Set();
  let agotado = null;
  for (let i = 0; i < oids.length; i += lote) {
    if (ahora() - t0 > budget) { agotado = { blobs: i, de: oids.length }; break; }
    const chunk = oids.slice(i, i + lote);
    if (parcial) traerBlobs(repo, chunk);
    const { textos: t, faltantes: f } = leerBlobs(repo, chunk);
    for (const [k, v] of t) textos.set(k, v);
    for (const x of f) faltantes.add(x);
  }
  if (agotado) for (const o of oids.slice(agotado.blobs)) faltantes.add(o);

  // 4 · agrupar por IDENTIDAD DECLARADA. Una versión con el frontmatter roto (no declara
  //     `story:`) cae a su RUTA como identidad — que es exactamente el caso que el lint de
  //     frontmatter persigue, y no puede hacer desaparecer la serie entera de esa story.
  // La cadena de renombres se arma acá, con los blobs ya locales (antes costaría red). Con el
  // presupuesto YA agotado no se arma: es otro `git log` sobre todo el historial, con su propio
  // tope de 2 minutos, y gastarlo reproduce el cuelgue que ese tope existe para impedir.
  // Inyectable para poder probar justamente eso.
  const armarRenombres = typeof opts.mapaRenombres === 'function' ? opts.mapaRenombres : mapaDeRenombres;
  const rn = agotado ? { mapa: new Map(), ok: true } : armarRenombres(repo);
  const renombres = rn.mapa;
  const renombresLeidos = rn.ok !== false;
  let cadenasTruncadas = 0;
  const TOPE_CADENA = 50;
  const rutaActual = (r) => {                     // sigue la cadena hasta una ruta de hoy
    let cur = r;
    let i = 0;
    for (; i < TOPE_CADENA && !rutaAId.has(cur) && renombres.has(cur); i++) cur = renombres.get(cur);
    // Un corte sin marca es un dato incompleto que se lee como completo.
    if (i >= TOPE_CADENA && !rutaAId.has(cur)) cadenasTruncadas++;
    return cur;
  };

  const porId = new Map();
  const storiesConFalta = new Set();
  const renumeradas = new Set();
  let versionesHuerfanas = 0;
  let versionesIlegibles = 0;
  for (const e of entradas) {
    const txt = textos.get(e.oid);
    const fm = txt === undefined ? null : parseFrontmatter(txt);
    const declarado = fm && fm.id ? fm.id : null;
    const porRuta = rutaAId.get(e.ruta) || rutaAId.get(rutaActual(e.ruta)) || null;
    // La identidad declarada manda (así sobrevive un renombre de ruta). Pero si esa
    // versión declara un id que HOY no existe, la RUTA sigue diciendo de qué story es: es una
    // renumeración, y descartarla perdería toda la historia previa al cambio de número, en
    // silencio e indistinguible de "nunca existió".
    let id = null;
    if (declarado && idsActuales.has(declarado)) id = declarado;
    else if (porRuta) {
      id = porRuta;
      if (declarado && declarado !== porRuta) renumeradas.add(porRuta);
    }
    // Una versión que DECLARA ser de una story y no se puede atribuir NO se descarta callada: se
    // cuenta. La diferencia entre "no hay" y "no pude atribuirlo" es la que este arnés existe para
    // no perder. 🔴 Un `.md` que NO declara `story:` (un README, una guía) no es una huérfana: es
    // que no es una story. Contarlo daría 683 en un repo real — un número siempre grande enseña a
    // ignorar el aviso, que es la forma más barata de romper un control.
    if (!id) { if (declarado) versionesHuerfanas++; continue; }
    if (txt === undefined) { storiesConFalta.add(id); continue; }
    if (!porId.has(id)) porId.set(id, []);
    porId.get(id).push({ fecha: e.fecha, sha: e.sha, orden: e.orden, crudo: fm ? fm.status : null });
  }

  const transiciones = {};
  // La primera versión de cada story, por su IDENTIDAD declarada. Es la fecha de cierre de
  // una story que nació cerrada; `git log --follow` no sirve para eso porque confunde dos archivos
  // casi iguales y le da a la nueva la fecha de alta de la vieja.
  const altas = {};
  // …y las que tienen alguna versión con el estado ilegible: su historia está incompleta, así que no se
  // les puede asignar una fecha de cierre (ni la de alta ni la de una transición calculada salteando).
  const conIlegibles = new Set();
  const descPorStory = new Map();               // valor crudo → stories donde aparece
  for (const [id, versiones] of porId) {
    if (storiesConFalta.has(id)) continue;      // serie incompleta: no se publica a medias
    // La fecha manda (orden cronológico) y el empate lo rompe el ORDEN CAUSAL del log,
    // no el sha. Dos commits del mismo segundo son cosa de todos los días en cambios de estado
    // hechos por un guion o retro-fechados.
    versiones.sort((a, b) => (Date.parse(a.fecha) - Date.parse(b.fecha)) || (a.orden - b.orden));
    if (versiones.length) altas[id] = versiones[0].fecha;
    const serie = [];
    let prev = null;
    for (const v of versiones) {
      const c = canonEstado(v.crudo);
      // Una versión sin `status:` legible NO se saltea callada: se cuenta. Es el mismo patrón que
      // los otros caminos de "no pude" de esta función — la serie sale más corta y hay que decirlo.
      if (!c) { versionesIlegibles++; conIlegibles.add(id); continue; }
      if (c.desconocido) {
        if (!descPorStory.has(c.desconocido)) descPorStory.set(c.desconocido, new Set());
        descPorStory.get(c.desconocido).add(id);
      }
      // Se compara el VALOR, no la presencia del cambio: un commit que tocó el archivo sin
      // mover el estado no es una transición.
      if (prev !== null && c.estado !== prev) {
        serie.push({ de: prev, a: c.estado, fecha: v.fecha, commit: v.sha.slice(0, 7) });
      }
      prev = c.estado;
    }
    if (serie.length) transiciones[id] = serie;
  }

  const desconocidos = Object.create(null);
  for (const [k, set] of descPorStory) desconocidos[k] = set.size;

  const medidas = Object.keys(transiciones).length;
  const storiesFaltantes = [...storiesConFalta].sort();
  // El invariante: nadie se pierde en el camino. Los archivos con id duplicado tampoco — se
  // restan acá y se nombran abajo, en vez de contarse como "no cambiaron de estado".
  const sinTransiciones = stories.length - medidas - storiesFaltantes.length - archivosDuplicados;

  let motivo = null;
  if (!renombresLeidos) {
    motivo = 'transiciones: no se pudo leer la cadena de renombres (git log falló o se pasó de '
      + 'tiempo) — una story que se mudó de carpeta Y se renumeró puede quedar sin su historia '
      + 'previa; el resto se midió igual';
  }
  if (versionesIlegibles) {
    motivo = `${motivo ? `${motivo} · ` : ''}transiciones: ${versionesIlegibles} versión(es) con el `
      + 'frontmatter ilegible (no se pudo leer su `status:`) — esas series salen más cortas';
  }
  if (cadenasTruncadas) {
    motivo = `${motivo ? `${motivo} · ` : ''}transiciones: ${cadenasTruncadas} cadena(s) de `
      + `renombres cortada(s) en ${TOPE_CADENA} saltos — esas versiones pueden haber perdido su `
      + 'historia previa';
  }
  if (idsDuplicados.length) {
    motivo = `${motivo ? `${motivo} · ` : ''}`
      + `transiciones: ${archivosDuplicados} archivos declaran un \`story:\` duplicado `
      + `(${idsDuplicados.join(', ')}) — no se puede atribuir su historia, quedan fuera del tiempo `
      + 'por etapa y siguen contando en stories_total';
  }
  if (agotado) {
    // El motivo se da en stories, no en blobs: es la unidad que el lector entiende.
    motivo = `${motivo ? `${motivo} · ` : ''}transiciones: presupuesto de tiempo agotado tras ${medidas + sinTransiciones} `
      + `stories de ${stories.length} (${agotado.blobs} de ${agotado.de} versiones leídas en ${budget} ms)`;
  } else if (storiesFaltantes.length) {
    motivo = `${motivo ? `${motivo} · ` : ''}transiciones: ${storiesFaltantes.length} de ${stories.length} stories con versiones no `
      + 'descargables (clon parcial sin acceso al remoto) — quedan fuera del tiempo por etapa, '
      + 'siguen contando en stories_total';
  }

  return {
    transiciones, altas, conIlegibles: [...conIlegibles].sort(), sinTransiciones, desconocidos, storiesFaltantes, medidas,
    idsDuplicados, archivosDuplicados, idsRenumerados: [...renumeradas].sort(),
    versionesHuerfanas, versionesIlegibles, renombresLeidos, cadenasTruncadas, medible: true,
    total: stories.length, agotado, motivo,
  };
}

/**
 * Tiempo por etapa, en días: de la transición que ENTRA a la etapa hasta la que SALE.
 *
 * Dos ausencias son deliberadas y no se rellenan con 0 (un cero donde hubo ausencia baja
 * la mediana en silencio):
 *   · la etapa que la story SALTÓ no aparece en su cuenta;
 *   · la etapa en la que la story NACIÓ, y la etapa en la que está AHORA, no tienen transición
 *     de entrada / de salida — no se les inventa un comienzo ni un final.
 * Si una story entra y sale de la misma etapa varias veces (volvió de revisión), sus visitas se
 * SUMAN y cuenta como UNA en el `n`: el `n` son stories, que es el denominador legible.
 */
function tiempoPorEtapa(transiciones) {
  const porEtapa = {};
  for (const [id, serie] of Object.entries(transiciones || {})) {
    for (let i = 0; i < serie.length - 1; i++) {
      const etapa = serie[i].a;
      if (serie[i + 1].de !== etapa) continue;          // serie incoherente: no se inventa
      const dias = (Date.parse(serie[i + 1].fecha) - Date.parse(serie[i].fecha)) / 86400000;
      if (!Number.isFinite(dias) || dias < 0) continue;
      (porEtapa[etapa] ||= {})[id] = (porEtapa[etapa][id] || 0) + dias;
    }
  }
  const out = {};
  const canonicos = diccionario().canonicos;
  const orden = [...canonicos, ...Object.keys(porEtapa).filter((e) => !canonicos.includes(e))];
  for (const etapa of orden) {
    if (!porEtapa[etapa]) continue;
    const s = stats(Object.values(porEtapa[etapa]));
    if (s) out[etapa] = s;
  }
  return out;
}

// ── series por repo ──────────────────────────────────────────────────────────────────────────

// 🔴 No hay una lista fija de estados de cierre (`done`, `completed`, `closed`): contradiría
//    al diccionario que este mismo archivo carga —él da por cerrados a seis valores—. Dos listas
//    que dicen casi lo mismo y que nada obliga a moverse juntas se separan, y el desacuerdo
//    tendría consecuencias. El criterio sale de `groups.cerrado`, igual que «en curso», y una
//    prueba impide que la lista reaparezca en el código.

/**
 * Las carpetas `.advisors/dod-runtime` donde el medidor busca la evidencia de cierre de un repo: la
 * propia y la de sus hermanos del MISMO proyecto. Extraída de `measureRepo` para que la
 * foto por proyecto la importe en vez de copiarla: dos copias de esta regla se separan solas.
 *
 * "Hermano" es del MISMO PROYECTO, no cualquier carpeta vecina. En el disco del dev el
 * layout es `Producto/Repo`, así que el padre alcanza; en el servidor el nocturno clona los repos de
 * la organización PLANOS, como `Proyecto__Repo`, y ahí "el mismo padre" son TODOS. Medido: 12 de las
 * 24 stories que un producto da por cubiertas estarían cubiertas por archivos de otro — los números
 * de story se repiten entre productos (`4.3`, `5.1`, `3.2`…).
 */
function dirsDeEvidencia(repo) {
  const dodDirs = [path.join(repo, '.advisors', 'dod-runtime')];
  const base = path.basename(repo);
  const sep = base.indexOf('__');
  const grupo = sep > 0 ? base.slice(0, sep + 2) : null; // "Proyecto__" en el layout plano
  try {
    const parent = path.dirname(repo);
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!e.isDirectory() || path.join(parent, e.name) === repo) continue;
      // Layout plano: sólo los del mismo proyecto. Layout del disco: todo el padre
      // (el padre YA es el producto).
      if (grupo && !e.name.startsWith(grupo)) continue;
      if (!grupo && e.name.includes('__')) continue; // no mezclar los dos layouts
      const d = path.join(parent, e.name, '.advisors', 'dod-runtime');
      if (fs.existsSync(d)) dodDirs.push(d);
    }
  } catch { /* sin hermanos legibles: se mide solo el propio */ }
  return dodDirs;
}

/**
 * ¿El repo tiene la huella del arnés (`.tycon/` o `.advisors/`)? Es el criterio de `--only-harness`
 * —el mismo que usa unpushed-work-notice para decidir qué repos vigila—; extraído de `main`
 * para que la foto por proyecto mida exactamente los mismos repos.
 */
function tieneHuellaDelArnes(repo) {
  return fs.existsSync(path.join(repo, '.tycon')) || fs.existsSync(path.join(repo, '.advisors'));
}

function measureRepo(repo, since, opts = {}) {
  const notMeasured = [];
  if (!fs.existsSync(path.join(repo, '.git'))) {
    return { repo, error: 'no es un repo git' };
  }
  let files;
  let canonical;
  let partialScan = false;
  try {
    ({ files, canonical, partial: partialScan } = discoverStoryFiles(repo, opts.discoveryBudgetMs ?? 15000));
  } catch (e) {
    // El descubridor no puede fallar hacia una lista vacía: cero stories y "no pude descubrirlas"
    // se ven idénticos en el snapshot, y el segundo es el que hay que arreglar.
    return { repo, error: `el descubridor de stories falló: ${e.message}` };
  }
  const stories = [];
  for (const f of files) {
    const fm = readFrontmatter(f);
    if (fm && fm.id) stories.push({ file: f, ...fm });
  }

  // 🔴 El criterio de «cerrado» sale del diccionario, y si el diccionario no vale NO se publica
  //    un cero: `done_total` y `estados_por_canonico` salen `null` con su motivo, y con ellos las
  //    tres métricas que se calculan SOBRE stories cerradas. Sin esta guarda, un `states.json`
  //    ilegible publicaría «0 cerradas» en los 20 repos, con `rework` y `dod` diciendo «sin
  //    stories done», y nada se pondría rojo — el patrón que este repo entero existe para no
  //    repetir. El riesgo aparece porque el diccionario vive en un archivo.
  // 🔴 La causa del reproceso se calcula ANTES del gate del diccionario de ESTADOS, y a propósito:
  //    `contarCausas` no depende de él para nada — su dato es el `followup_of:`/`followup_reason:`
  //    del frontmatter, que está en el disco. Apagarla porque `states.json` no valida sería el
  //    «no medido falso» que este archivo entero existe para no escribir: publicar `null` teniendo
  //    el dato.
  const vocabCausas = causasReproceso();
  const reworkPorCausa = vocabCausas.motivo ? null : contarCausas(stories, vocabCausas);
  if (vocabCausas.motivo) notMeasured.push(`${vocabCausas.motivo} (${vocabCausas.ruta}) — sin `
    + 'el vocabulario no se publica un cero por causa: se publica "no medido"');

  const dic = diccionario();
  if (dic.motivo) {
    return {
      repo,
      canonicalDiscovery: canonical,
      storiesTotal: stories.length,
      doneTotal: null,
      estadosPorCanonico: null,
      reworkPorCausa,
      leads: null,
      rework: null,
      dod: null,
      transiciones: null, tiempoPorEtapa: null, sinTransiciones: null, estadosDesconocidos: null,
      storiesSinHistorial: null, idsDuplicados: null, idsRenumerados: null,
      archivosDuplicados: null, storiesMedidas: null, cadenasTruncadas: null,
      versionesHuerfanas: null, versionesIlegibles: null,
      notMeasured: [`${dic.motivo} (${dic.ruta}) — sin saber qué estados son de cierre no se `
        + 'publica un 0: se publica "no medido"'],
    };
  }
  const cerrado = new Set(dic.grupos.cerrado);
  const done = stories.filter((s) => {
    const c = canonEstado(s.status);
    return !!c && !c.desconocido && cerrado.has(c.estado);
  });
  const estadosPorCanonico = contarEstados(stories, dic);

  // 1 · lead time (por story done, con fechas de git; las sin fecha salen del denominador)
  const leads = [];
  for (const s of done) {
    const { createdAt, lastAt } = storyDates(repo, s.file);
    if (!createdAt || !lastAt) continue;
    if (since && lastAt.slice(0, 10) < since) continue;
    const days = (Date.parse(lastAt) - Date.parse(createdAt)) / 86400000;
    if (Number.isFinite(days) && days >= 0) {
      leads.push({ id: s.id, days, closedMonth: lastAt.slice(0, 7) });
    }
  }

  // 3 · rework
  const rework = done.length
    ? { num: done.filter((s) => s.followups).length, den: done.length }
    : null;
  if (!rework) notMeasured.push('rework: sin stories done');


  // 4 · evidencia DoD — la evidencia puede vivir en OTRO repo del MISMO proyecto: en los
  // layouts "Project + Backend/FrontEnd" las stories están en el repo de specs y el
  // .advisors/dod-runtime en el de implementación. Se barren el repo Y sus hermanos
  // — sin esto, esos proyectos medirían 0% siendo mentira.
  //
  // 🔴 "Hermano" es del MISMO PROYECTO, no cualquier carpeta vecina. En el
  // disco del dev el layout es `Producto/Repo`, así que el padre alcanza; en el servidor
  // el nocturno clona los 131 repos de la organización PLANOS, como `Proyecto__Repo`, y
  // ahí "el mismo padre" son TODOS. Medido: 12 de las 24 stories que un repo del equipo da por
  // cubiertas estarían cubiertas por archivos de otro producto — los números de story se repiten
  // entre productos (`4.3`, `5.1`, `3.2`…). De paso eso mata el "no medido": ningún
  // repo podría salir sin nota, aunque no tuviera una sola evidencia propia.
  let dod = null;
  const dodDirs = dirsDeEvidencia(repo);
  const dodFiles = [];
  for (const d of dodDirs) {
    try { dodFiles.push(...fs.readdirSync(d)); } catch { /* ilegible: no suma */ }
  }
  // Las claves de la evidencia sirven también para las carpetas de corrida (rework por
  // carril): se calculan una vez, con la lista completa. Con el recorrido incompleto no hay clave: el número.
  let claves = null;
  if (partialScan) {
    notMeasured.push('dod_evidence: el recorrido de stories quedó incompleto — sin la lista entera no se sabe qué números se repiten, y cruzar la evidencia con una clave adivinada puede contarle a una story la de otra (story 1.17)');
  } else if (!done.length) {
    notMeasured.push('dod_evidence: sin stories done');
  } else if (!dodFiles.length) {
    notMeasured.push('dod_evidence: ni el repo ni sus hermanos del mismo proyecto tienen .advisors/dod-runtime con archivos — NO es 0%, es que la evidencia no llegó al servidor');
  } else {
    // Por la CLAVE de la evidencia: con un número repetido en el repo, `<id>-*` es la evidencia
    // de cualquiera de las stories que lo comparten y una sola corrida contaría como cubiertas a todas. Las
    // claves salen de la lista completa de stories que este medidor ya tiene; sin la biblioteca, el número.
    try {
      claves = require(path.join(SKILLS_DIR, 'tycon-pipeline', 'scripts', 'lib', 'evidence-key.js'))
        .keysForStories(stories.map((s) => ({ path: s.file, id: s.id })), repo);
    } catch { notMeasured.push('dod_evidence: sin lib/evidence-key.js la evidencia se cruza por número solo — en un número repetido puede contar la de otra story'); }
    const claveDe = (s) => (claves && claves.get(path.resolve(s.file))) || s.id;
    const tieneEvidencia = (s) => dodFiles.some((f) => f.startsWith(`${claveDe(s)}-`) && esEvidenciaDeCierre(f));
    const covered = done.filter(tieneEvidencia).length;
    // 🔴 Una exención declara que NO hay prueba: sale del cociente y se cuenta aparte.
    //    Sumarla ARRIBA sería tratarla como evidencia — un cierre retroactivo de 49 stories
    //    subiría la ficha de 41 % a ~47 % sin que nadie probara nada. Si la story
    //    además trae su informe real, la evidencia gana y cuenta arriba.
    const exentas = done.filter((s) => s.dodExempt && !tieneEvidencia(s)).length;
    dod = { num: covered, den: done.length - exentas, exentas };
  }

  // 5 · transiciones de estado y tiempo por etapa. Se derivan del historial, en la
  //     MISMA corrida y sin clonar nada nuevo. `tiempo_por_etapa` es `null` —nunca `{}`, nunca
  //     0— cuando no se pudo medir, y el motivo va en `not_measured` en castellano.
  const tr = derivarTransiciones(repo, stories, opts);
  const noMedido = tr.agotado || tr.medible === false;   // dos caminos, un solo tratamiento
  let tiempoPorEtapaRepo = null;
  if (tr.agotado) {
    notMeasured.push(tr.motivo);
  } else if (tr.medible === false) {
    notMeasured.push(tr.motivo);
  } else if (tr.motivo && !tr.medidas) {
    notMeasured.push(tr.motivo);
  } else {
    if (tr.motivo) notMeasured.push(tr.motivo);      // faltantes / duplicados: se nombran y se sigue
    const t = tiempoPorEtapa(tr.transiciones);
    if (Object.keys(t).length) tiempoPorEtapaRepo = t;
    else notMeasured.push('transiciones: ninguna story recorrió una etapa de punta a punta '
      + '(hay que entrar Y salir de la etapa para poder medirla)');
  }

  // 3b · rework por CARRIL — ver reworkPorCarril(). Va DESPUÉS de las transiciones porque
  //      la fecha de cierre de una story es la de su entrada al estado cerrado, no la de su último
  //      commit (una story vieja retocada después entraría a la ventana — medido en real).
  let reworkPorCarrilRepo = null;
  if (noMedido) {
    notMeasured.push('rework por carril: no se pudo leer el historial de estados, y sin él no hay fecha de cierre confiable — no se separa por carril');
  } else {
    const faltan = new Set([...(tr.storiesFaltantes || []), ...(tr.conIlegibles || [])]);
    const cierreDe = new Map();
    for (const s of done) {
      if (faltan.has(s.id)) { cierreDe.set(s, null); continue; }
      const serie = tr.transiciones[s.id] || [];
      const entrada = serie.filter((t) => cerrado.has(t.a)).pop();
      // Sin transición a cerrado la story NACIÓ cerrada: su cierre es su primera versión.
      cierreDe.set(s, entrada ? entrada.fecha : ((tr.altas || {})[s.id] || null));
    }
    const rpc = reworkPorCarril(repo, done, cierreDe, (s) => (claves && claves.get(path.resolve(s.file))) || s.id);
    if (rpc.motivo) notMeasured.push(rpc.motivo);
    reworkPorCarrilRepo = rpc.valor;
  }

  return {
    repo,
    canonicalDiscovery: canonical,
    storiesTotal: stories.length,
    doneTotal: done.length,
    // 🔴 NO se gatea por el agotamiento del presupuesto ni por un historial ilegible: el estado
    //    ACTUAL se lee del frontmatter, que está en el disco, y ahí SIEMPRE está disponible.
    //    Copiar acá el gate de su campo hermano `estadosDesconocidos` publicaría `null` teniendo
    //    el dato — el «no medido» falso, que es la mentira gemela del cero falso. Y no es
    //    hipotético: el presupuesto de 60 s se agota en repos reales.
    estadosPorCanonico,
    // La causa del reproceso. Mismo criterio que su vecino de arriba: se lee del
    // frontmatter, así que no se gatea por git ni por el presupuesto. `null` sólo cuando el
    // vocabulario no se pudo leer (motivo en `notMeasured`) o cuando el repo entero no se midió.
    reworkPorCausa,
    reworkPorCarril: reworkPorCarrilRepo,
    leads,
    rework,
    dod,
    // 🔴 Los CINCO campos se gatean por igual con el agotamiento, no sólo el del propio repo.
    // Sin esto, el
    // presupuesto puede agotarse DESPUÉS de haber procesado algún lote, y esas stories quedan
    // con serie completa. El repo publica "no medido" en su fila y su muestra PARCIAL entra
    // igual al número global — y no es una muestra cualquiera: `git log` entrega los commits del
    // más nuevo al más viejo, así que lo que alcanza a leerse está sesgado hacia lo reciente.
    // Un repo que no pudo medir aporta NADA, ni siquiera lo que alcanzó a ver.
    transiciones: noMedido ? null : tr.transiciones,
    tiempoPorEtapa: tiempoPorEtapaRepo,
    sinTransiciones: noMedido ? null : tr.sinTransiciones,
    estadosDesconocidos: noMedido ? null : tr.desconocidos,
    storiesSinHistorial: noMedido ? null : tr.storiesFaltantes.length,
    idsDuplicados: noMedido ? null : tr.idsDuplicados,
    idsRenumerados: noMedido ? null : tr.idsRenumerados,
    archivosDuplicados: noMedido ? null : tr.archivosDuplicados,
    storiesMedidas: noMedido ? null : tr.medidas,
    cadenasTruncadas: noMedido ? null : tr.cadenasTruncadas,
    versionesHuerfanas: noMedido ? null : tr.versionesHuerfanas,
    versionesIlegibles: noMedido ? null : tr.versionesIlegibles,
    notMeasured,
  };
}

// ── first-pass desde el dashboard 2.0 ────────────────────────────────────────────────────────

// `dir`: una carpeta, o varias (la de estado y la de la historia; el mismo archivo en dos cuenta una vez)
// Además de cada carpeta se lee su `merges/` (lo que el nocturno del tablero baja del buzón): un merge que está en las dos
// cuenta una vez, el que trae vueltas y, entre iguales, el más nuevo. Lo que está sólo en la carpeta se cuenta como
// siempre. Con `receipt` (la constancia que deja `merge-metrics.js juntar`), sin una bajada completa y al día no hay
// número: con lo versionado solo se publicaría la primera vuelta de los merges que nadie bajó.
function firstPassFromDashboard(dir, since, receipt) {
  let loadPorMerge, MM;
  try { ({ loadPorMerge } = require(path.join(TCG, 'scripts', 'lib', 'dashboard-metrics.js'))); }
  catch { return { value: null, reason: 'lib/dashboard-metrics.js no disponible' }; }
  try { MM = require(path.join(TCG, 'scripts', 'lib', 'merge-metrics.js')); }
  catch { return { value: null, reason: 'lib/merge-metrics.js no disponible' }; }
  if (receipt) {
    const c = MM.constancia(path.dirname(receipt));
    if (!c.al_dia) return { value: null, reason: `no medido: la bajada de los merges de las máquinas no está al día — ${c.motivo}` };
  }
  const raices = Array.isArray(dir) ? dir : [dir];
  const todo = loadPorMerge(raices);
  const ilegible = (todo.unreadableDirs || [])[0];
  if (ilegible) {
    const nombre = path.basename(ilegible.dir) === 'merges' ? `${path.basename(path.dirname(ilegible.dir))}/merges` : path.basename(ilegible.dir);
    return { value: null, reason: `no medido: la carpeta ${nombre} no se puede leer (${ilegible.code})` };
  }
  let rows = todo.records.filter((r) => r.status === 'ok' || r.status === 'legacy');
  if (since) rows = rows.filter((r) => r.date && r.date >= since);
  const iters = rows.map((r) => r.values.advisor_rerun_loop_iterations).filter((v) => v !== null);
  if (!iters.length) return { value: null, reason: `ningún registro de ${dir} trae iteraciones utilizables` };
  return { num: iters.filter((v) => v === 1).length, den: iters.length, dir,
    nota: 'desde el 2026-09-16 las vueltas las escribe retro-heartbeat.js (última vuelta de los revisores medidos); antes, el retrospective-capturer con criterio propio — un salto en esa fecha es cambio de conteo, no de conducta' };
}

// ── agregación y salida ──────────────────────────────────────────────────────────────────────

function stats(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    n: s.length,
    mean: s.reduce((t, n) => t + n, 0) / s.length,
    median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    min: s[0],
    max: s[s.length - 1],
  };
}

function fmtRatio(r) {
  if (!r || r.den === 0) return '—';
  return `${Math.round((r.num / r.den) * 100)}% (${r.num}/${r.den})`;
}

/** `in-progress 2,1 d · n=380 · review 6,4 d · n=402`. Sin dato dice sin dato, no dice 0. */
function fmtEtapas(t) {
  if (!t || !Object.keys(t).length) return 'sin dato';
  return Object.entries(t)
    .map(([e, s]) => `${e} ${s.median.toFixed(1)}d · n=${s.n}`)
    .join(' · ');
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || (!a.repos.length && !a.scan.length)) {
    console.log('uso: sdlc-stage-metrics.js [--repo <path>]... [--scan <raíz>]... '
      + '[--dashboard <dir>] [--since YYYY-MM-DD] [--json] [--snapshot]\n'
      + '  --scan     descubre solos los repos git bajo una raíz (ej: ~/Proyectos) — evita\n'
      + '             listas a mano, que sólo miden lo que alguien se acordó de anotar.\n'
      + '  --snapshot escribe el resultado a <dashboard>/sdlc-stage-<fecha>.json (punto de serie).\n'
      + '  --transitions-budget-ms  tope por repo para derivar las transiciones de estado del\n'
      + '             historial (default 60000). Agotado: ese repo sale `tiempo_por_etapa: null`\n'
      + '             con su motivo y los demás se miden igual — el paso NUNCA se cuelga.');
    process.exit(a.help ? 0 : 1);
  }

  // Escaneo: se miden sólo los repos con al menos una story; los demás se cuentan y se callan
  // (un reporte con 15 filas de "0 stories" es ruido que enseña a no leer el reporte).
  const scanned = [];
  for (const root of a.scan) scanned.push(...discoverRepos(root));
  const targets = [...new Set([...a.repos, ...scanned])];

  let skippedNoStories = 0;
  const skippedNames = [];
  let skippedNoHarness = 0;
  const repos = [];
  for (const r of targets) {
    const fromScan = !a.repos.includes(r);
    // --only-harness: en un barrido de toda la organización (155 repos),
    // cursos, demos y repos de otros equipos pueden tener fichas con formato de story y
    // ensuciarían la estadística DEL EQUIPO. El criterio de pertenencia es la huella del
    // arnés (.tycon/ o .advisors/) — el mismo que usa unpushed-work-notice para decidir
    // qué repos vigila. Sólo filtra los descubiertos por --scan; un --repo explícito entra
    // igual (si lo nombraste, lo querés medir).
    if (a.onlyHarness && fromScan && !tieneHuellaDelArnes(r)) {
      skippedNoHarness++;
      continue;
    }
    const m = measureRepo(r, a.since, { budgetMs: a.budgetMs });
    if (fromScan && !m.error && m.storiesTotal === 0) {
      skippedNoStories++; skippedNames.push(path.basename(r)); continue;
    }
    repos.push(m);
  }
  if (a.scan.length) {
    console.error(`ℹ️  escaneadas ${a.scan.length} raíz(ces) → ${targets.length} repos git · `
      + `${repos.length} con stories · ${skippedNoStories} sin stories (omitidos del reporte)`);
    // Los omitidos se NOMBRAN (la pregunta típica es "¿dónde está X?"): un
    // conteo a secas no distingue "no tiene fichas" de "no se midió", y esa duda se contesta
    // sola si la línea dice quiénes son.
    if (skippedNames.length) {
      console.error(`    sin stories: ${skippedNames.sort().join(' · ')}`);
    }
  }
  const defaults = a.dashboardGiven ? null : nightDefaults();
  const firstPass = firstPassFromDashboard(defaults ? defaults.dirs : a.dashboard, a.since, a.mergesReceipt);

  const allLeads = repos.flatMap((r) => r.leads || []);
  const byMonth = {};
  for (const l of allLeads) (byMonth[l.closedMonth] ||= []).push(l.days);
  const monthly = Object.keys(byMonth).sort().map((m) => ({ month: m, ...stats(byMonth[m]) }));

  const sum = (key) => {
    const rs = repos.map((r) => r[key]).filter(Boolean);
    if (!rs.length) return null;
    const out = { num: rs.reduce((t, r) => t + r.num, 0), den: rs.reduce((t, r) => t + r.den, 0) };
    // Sólo las ratios que las cuentan (hoy, la de evidencia de cierre) llevan `exentas`.
    if (rs.some((r) => Number.isFinite(r.exentas))) out.exentas = rs.reduce((t, r) => t + (r.exentas || 0), 0);
    return out;
  };
  // Tiempo por etapa GLOBAL: se recalcula sobre las series de TODOS los repos juntos, no se
  // promedian las medianas por repo (promediar medianas es la forma más barata de publicar un
  // número que no significa nada). Un repo que no pudo medir aporta `null` en los tres campos
  // (ver measureRepo) y acá simplemente no entra: no aporta ceros NI aporta su parte.
  const seriesGlobal = {};
  let sinTransGlobal = 0;
  let sinTransMedible = false;
  let sinHistGlobal = 0;
  const descGlobal = Object.create(null);
  for (const r of repos) {
    for (const [id, se] of Object.entries(r.transiciones || {})) seriesGlobal[`${r.repo}::${id}`] = se;
    if (Number.isFinite(r.sinTransiciones)) { sinTransGlobal += r.sinTransiciones; sinTransMedible = true; }
    if (Number.isFinite(r.storiesSinHistorial)) sinHistGlobal += r.storiesSinHistorial;
    for (const [k, n] of Object.entries(r.estadosDesconocidos || {})) descGlobal[k] = (descGlobal[k] || 0) + n;
  }
  const tpeGlobal = tiempoPorEtapa(seriesGlobal);

  // El contador del presente, sumado. Un repo que no lo pudo producir aporta NADA — ni ceros ni
  // su parte —, y si no lo produjo ninguno el campo sale `null`: `{}` con tres baldes vacíos se
  // leería como «medí los 20 repos y no hay una sola story en curso».
  const epcGlobal = { conteo: Object.create(null), sin_diccionario: Object.create(null),
    sin_status: 0, total: 0, por_grupo: Object.create(null) };
  let epcMedible = false;
  for (const r of repos) {
    const e = r.estadosPorCanonico;
    if (!e) continue;
    epcMedible = true;
    for (const [k, n] of Object.entries(e.conteo)) epcGlobal.conteo[k] = (epcGlobal.conteo[k] || 0) + n;
    for (const [k, n] of Object.entries(e.sin_diccionario)) epcGlobal.sin_diccionario[k] = (epcGlobal.sin_diccionario[k] || 0) + n;
    for (const [k, n] of Object.entries(e.por_grupo)) epcGlobal.por_grupo[k] = (epcGlobal.por_grupo[k] || 0) + n;
    epcGlobal.sin_status += e.sin_status;
    epcGlobal.total += e.total;
  }

  // La causa del reproceso, sumada. Mismo trato que su vecino: un repo que no la pudo
  // producir aporta NADA, y si no la produjo ninguno el campo global sale `null` — un objeto con
  // las cuatro causas en cero se leería como «medí los 20 repos y no volvió nada por ningún lado».
  const rpcGlobal = { conteo: Object.create(null), sin_declarar: 0,
    fuera_de_vocabulario: Object.create(null), sin_declarar_por_type: Object.create(null), total: 0 };
  for (const c of causasReproceso().causas) rpcGlobal.conteo[c] = 0;
  let rpcMedible = false;
  for (const r of repos) {
    const x = r.reworkPorCausa;
    if (!x) continue;
    rpcMedible = true;
    for (const [k, n] of Object.entries(x.conteo)) rpcGlobal.conteo[k] = (rpcGlobal.conteo[k] || 0) + n;
    for (const [k, n] of Object.entries(x.fuera_de_vocabulario)) rpcGlobal.fuera_de_vocabulario[k] = (rpcGlobal.fuera_de_vocabulario[k] || 0) + n;
    for (const [k, n] of Object.entries(x.sin_declarar_por_type)) rpcGlobal.sin_declarar_por_type[k] = (rpcGlobal.sin_declarar_por_type[k] || 0) + n;
    rpcGlobal.sin_declarar += x.sin_declarar;
    rpcGlobal.total += x.total;
  }

  const global = {
    lead_time_days: stats(allLeads.map((l) => l.days)),
    lead_time_monthly: monthly,
    first_pass_ratio: firstPass,
    // lo que no se midió de lo global, con su motivo (hoy, la primera vuelta sin la bajada de los merges al día)
    ...(firstPass.value === null && /^no medido: /.test(firstPass.reason || '') ? { not_measured: [firstPass.reason] } : {}),
    rework_ratio: sum('rework'),
    dod_evidence_ratio: (() => {
      const x = sum('dod');
      // Mismo patrón que la `nota` de first_pass: un salto en la serie esta fecha es cambio de conteo.
      return x && { ...x, nota: 'desde el 2026-09-18 las stories con dod_runtime_exempt y sin informe real '
        + 'salen del cociente y se cuentan en `exentas`: un salto en esa fecha es cambio de conteo, no de conducta' };
    })(),
    // `null`, jamás `{}`: un objeto vacío se lee como "medí y no hay etapas", que es mentira.
    tiempo_por_etapa: Object.keys(tpeGlobal).length ? tpeGlobal : null,
    sin_transiciones: sinTransMedible ? sinTransGlobal : null,
    // Las stories cuyo historial no se pudo leer NO se van del recuento en silencio: se publican.
    // Invariante: medidas + sin_transiciones + sin_historial = stories_total.
    sin_historial: sinTransMedible ? sinHistGlobal : null,
    // Mismo gate que sus tres hermanos: sin NINGÚN repo medible, un `{}` acá se leería como
    // "medí todo y no había nada raro" — que es exactamente la mentira que este archivo evita.
    estados_desconocidos: sinTransMedible ? descGlobal : null,
    // El estado ACTUAL. Nombre distinto del de arriba a propósito: aquél es el
    // histórico —los estados que aparecieron alguna vez en una transición— y éste el presente.
    // Dos campos casi homónimos que miden cosas distintas es cómo se elige el equivocado.
    estados_por_canonico: epcMedible ? epcGlobal : null,
    // 🔴 Qué diccionario se usó de verdad. Sin esto, `TYCON_STATES_PATH` sería un interruptor
    //    invisible: una máquina con la variable puesta publicaría métricas de otro vocabulario y
    //    el snapshot se vería idéntico al normal.
    diccionario: { ruta: diccionario().ruta, hash: diccionario().hash },
    // La causa del reproceso. Es la OTRA punta de `rework_ratio`: aquél cuenta las
    // padres que volvieron (165 de 496), éste las hijas que hicieron el seguimiento y por qué.
    rework_por_causa: rpcMedible ? rpcGlobal : null,
    // Mismo rastro que `diccionario`: qué vocabulario se usó de verdad, para que
    // `TYCON_CAUSES_PATH` no sea un interruptor invisible.
    causas_reproceso: { ruta: causasReproceso().ruta, hash: causasReproceso().hash },
  };

  // 🔴 UNA sola definición del snapshot, que consumen el `--snapshot` y el `--json`. Duplicadas,
  // agregar un campo obliga a acordarse de los dos lugares, y el día que alguien
  // se olvidara, el archivo del nocturno y la salida que se mira a mano dirían cosas distintas
  // sin que nada fallara.
  const payload = () => ({
      generated_at: new Date().toISOString(),
      since: a.since,
      dashboard: a.dashboard,
      global,
      repos: repos.map((r) => ({
        repo: r.repo,
        error: r.error,
        canonical_discovery: r.canonicalDiscovery,
        stories_total: r.storiesTotal,
        done_total: r.doneTotal,
        lead_time_days: stats((r.leads || []).map((l) => l.days)),
        rework_ratio: r.rework,
        // Por repo y SÓLO por repo — sumarlo entre productos mezclaría ventanas y equipos
        // distintos, así que en `global` no existe.
        rework_por_carril: r.reworkPorCarril || null,
        dod_evidence_ratio: r.dod,
        tiempo_por_etapa: r.tiempoPorEtapa || null,
        sin_transiciones: Number.isFinite(r.sinTransiciones) ? r.sinTransiciones : null,
        sin_historial: Number.isFinite(r.storiesSinHistorial) ? r.storiesSinHistorial : null,
        // 🔴 Estos cinco salen al archivo para que el invariante
        //    `stories_medidas + sin_transiciones + sin_historial + archivos_duplicados = stories_total`
        //    se pueda verificar DESDE AFUERA. Sin ellos, el invariante vive sólo adentro del código: quien lee el
        //    snapshot y quiere reconstruir cuántas se midieron se pasa de más, en silencio,
        //    exactamente en la cantidad de archivos con id duplicado.
        stories_medidas: Number.isFinite(r.storiesMedidas) ? r.storiesMedidas : null,
        archivos_duplicados: Number.isFinite(r.archivosDuplicados) ? r.archivosDuplicados : null,
        ids_duplicados: r.idsDuplicados || null,
        ids_renumerados: r.idsRenumerados || null,
        cadenas_truncadas: Number.isFinite(r.cadenasTruncadas) ? r.cadenasTruncadas : null,
        versiones_huerfanas: Number.isFinite(r.versionesHuerfanas) ? r.versionesHuerfanas : null,
        versiones_ilegibles: Number.isFinite(r.versionesIlegibles) ? r.versionesIlegibles : null,
        estados_desconocidos: r.estadosDesconocidos || null,
        // El contador del PRESENTE: `null` con motivo en `not_measured` cuando el
        // repo no se pudo medir (no es git, o el descubridor falló) o cuando el diccionario no
        // vale — nunca `{}` ni un objeto con ceros: «no pude mirar» y «miré y no hay» no se
        // escriben igual.
        estados_por_canonico: r.estadosPorCanonico || null,
        // La causa del reproceso: `null` con motivo en `not_measured` cuando el repo
        // no se pudo medir o el vocabulario no vale. Un repo SIN seguimientos sale con `total: 0`
        // y las cuatro causas en cero — eso sí es «miré y no hay».
        rework_por_causa: r.reworkPorCausa || null,
        not_measured: r.notMeasured,
      })),
  });

  // Snapshot: un archivo por día en el .dashboard. Es lo que convierte una foto en SERIE —
  // sin esto, cada corrida reemplaza a la anterior y la tendencia (que es el único uso real
  // de estas métricas) no existe. Idempotente dentro del mismo día a propósito.
  // 🔴 El punto del día lo escribe el NOCTURNO, en su propio árbol. Si la carpeta por defecto cae en otro clon (el de
  // mantenimiento, donde vive el punto del nocturno con ESE nombre), escribir acá lo pisa (o
  // deja un archivo suelto que traba el `pull` siguiente — pasó el 11 y el 12 de octubre de 2026 con una foto vacía de
  // 939 bytes sobre una de 49.945). Ahí no se escribe; quien de verdad lo quiera, dice dónde con `--dashboard`.
  const snapshotDir = defaults ? defaults.snapshot : a.dashboard;
  const enOtroClon = !a.dashboardGiven && path.resolve(snapshotDir) !== path.join(TCG, '.dashboard')
    && fs.existsSync(path.join(path.dirname(path.resolve(snapshotDir)), '.git'));
  if (a.snapshot && enOtroClon) {
    console.error(`⚠️  no escribo el punto del día: iría a ${snapshotDir}, que es el clon de mantenimiento y trae el del nocturno con ese nombre. Para escribirlo igual, decí dónde: --dashboard <carpeta>`);
  } else if (a.snapshot) {
    const day = new Date().toISOString().slice(0, 10);
    const out = path.join(snapshotDir, `sdlc-stage-${day}.json`);
    try {
      fs.mkdirSync(snapshotDir, { recursive: true });
      fs.writeFileSync(out, JSON.stringify(payload(), null, 2));
      console.error(`📈 snapshot: ${out}`);
    } catch (e) {
      console.error(`⚠️  no se pudo escribir el snapshot en ${out}: ${e.message}`);
    }
  }

  if (a.json) {
    console.log(JSON.stringify(payload(), null, 2));
    return;
  }

  const W = 78;
  console.log('═'.repeat(W));
  console.log('  MÉTRICAS DE ETAPA DEL SDLC — vs AI-Native SDLC Playbook');
  console.log('═'.repeat(W));
  for (const r of repos) {
    console.log(`\n  ${r.repo}`);
    if (r.error) { console.log(`    🔴 ${r.error}`); continue; }
    console.log(`    ${r.storiesTotal} stories descubiertas · ${r.doneTotal} done`
      + (r.canonicalDiscovery ? '' : '   ⚠️ descubridor de FALLBACK, no el canónico'));
    const lt = stats((r.leads || []).map((l) => l.days));
    console.log(`    lead time story→cierre : ${lt ? `mediana ${lt.median.toFixed(1)}d · media ${lt.mean.toFixed(1)}d · rango ${lt.min.toFixed(0)}–${lt.max.toFixed(0)}d · n=${lt.n}` : 'sin dato'}`);
    console.log(`    rework (follow-ups)    : ${fmtRatio(r.rework)}`);
    console.log(`    evidencia DoD          : ${fmtRatio(r.dod)}`);
    console.log(`    tiempo por etapa       : ${fmtEtapas(r.tiempoPorEtapa)}`);
    for (const nm of r.notMeasured) console.log(`    ∅ no medido — ${nm}`);
  }

  console.log('\n  ' + '─'.repeat(W - 4));
  console.log('  GLOBAL');
  const g = global.lead_time_days;
  console.log(`    lead time story→cierre : ${g ? `mediana ${g.median.toFixed(1)}d · media ${g.mean.toFixed(1)}d · n=${g.n}` : 'sin dato'}`);
  if (monthly.length) {
    console.log('    serie mensual (mediana de días, por mes de cierre):');
    for (const m of monthly) console.log(`      ${m.month}  ${m.median.toFixed(1)}d  (n=${m.n})`);
  }
  const fp = global.first_pass_ratio;
  console.log(`    first-pass del pipeline: ${fp.value === null ? `∅ no medido — ${fp.reason}` : fmtRatio(fp)}   (fuente: dashboard 2.0)`);
  console.log(`    rework (follow-ups)    : ${fmtRatio(global.rework_ratio)}`);
  console.log(`    evidencia DoD          : ${fmtRatio(global.dod_evidence_ratio)}`);
  console.log(`    tiempo por etapa       : ${fmtEtapas(global.tiempo_por_etapa)}`);
  if (Number.isFinite(global.sin_transiciones)) {
    console.log(`    stories sin una sola transición registrada: ${global.sin_transiciones}`);
  }
  const desc = Object.entries(global.estados_desconocidos || {}).sort((x, y) => y[1] - x[1]);
  if (desc.length) {
    // Se MUESTRAN, no se descartan: esta lista es la que dice qué alias falta declarar.
    console.log(`    estados fuera del diccionario: ${desc.map(([k, n]) => `${k} (${n})`).join(' · ')}`);
  }
  // Los repos barridos SIN stories se listan acá, al FINAL del reporte (la pregunta típica es
  // "¿dónde está X?"): la línea informativa del arranque sale antes del
  // reporte y nadie la ve — lo que se lee es el final. No puntúan; se nombran.
  if (skippedNames.length) {
    console.log('\n  ' + '─'.repeat(W - 4));
    console.log(`  Barridos y SIN stories propias (no puntúan): ${skippedNames.length} repos`);
    for (const n of skippedNames.sort()) console.log(`    · ${n}`);
  }
  console.log('');
}

if (require.main === module) {
  require('../lib/legacy-names.js').aliasArgv('scripts/metrics/sdlc-stage-metrics.js');
  main();
}
module.exports = {
  readFrontmatter, parseFrontmatter, fmKeyRe, measureRepo, firstPassFromDashboard,
  stats, discoverRepos, derivarTransiciones, tiempoPorEtapa, canonEstado, esClonParcial, reworkPorCarril,
  diccionario, validarDiccionario, contarEstados, ESTADOS_PATH, dirsDeEvidencia, tieneHuellaDelArnes,
};
