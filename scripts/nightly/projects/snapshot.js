#!/usr/bin/env node
/**
 * snapshot.js — La foto por proyecto: por cada repo con stories, UN archivo JSON con la
 * lista que muestra el control de proyectos de un producto del equipo —stories, épicas, sprints, plan,
 * alertas— y las métricas que el medidor ya calculó. Ese producto lee el archivo; no vuelve a parsear
 * ningún `.md`.
 *
 * 🔴 PROYECTA, NO MIDE. Todo lo que DECIDE algo viene importado, nunca copiado:
 *   · qué es una story ............ `discoverStories` (skills/tycon-pipeline/scripts/lib/story-discovery.js)
 *   · qué estado es cerrado ....... `diccionario`/`canonEstado` del medidor (scripts/metrics/states.json)
 *   · días en el estado ........... `derivarTransiciones` del medidor (la serie y el alta de cada story)
 *   · qué archivo es evidencia .... `esEvidenciaDeCierre` del portón (scripts/ci/tycon-ci-gate.js)
 *   · con qué clave se nombra ..... `keysForStories` (lib/evidence-key.js)
 *   · dónde se busca .............. `dirsDeEvidencia` del medidor + `productEvidenceRoots` (lib/evidence-config.js)
 *   · qué repo es del arnés ....... `tieneHuellaDelArnes` del medidor (`--only-harness`)
 * Dos definiciones de la misma regla se separan solas.
 *
 * LAS MÉTRICAS SE COPIAN, no se recalculan: con `--sdlc <sdlc-stage-<día>.json>` (lo que pasa el
 * nocturno) salen de la entrada del repo en el snapshot que el medidor acaba de escribir.
 * `measureRepo` tarda 11,8 s en un repo de 140 stories; descubrir y derivar las
 * transiciones, 1,2 s. Medir dos veces se comería el tope del paso. Sin `--sdlc` (modo a mano) se
 * llama a `measureRepo` para ese repo.
 *
 * ── EL CONTRATO (v 1) ──────────────────────────────────────────────────────────────────────────
 * `<out>/<Proyecto>__<Repo>.json`, reemplazado cada corrida (sin fecha en el nombre: la historia la
 * guarda git), con EXACTAMENTE estas claves de primer nivel:
 *   v (1) · generated_at (UTC ISO) · proyecto · repo (los dos tramos del nombre de la carpeta; sin
 *   `__`, proyecto null) · cobertura · plan · epicas · sprints · stories · alertas · metricas
 *
 * stories[] (orden numérico del id, el del descubridor) — 16 claves y nada más. 🔴 El `id` puede
 * repetirse entre temas de un mismo repo (hay repos que numeran cada tema desde 1.1): la clave única
 * de una story es su `ruta`.
 *   id · titulo · ruta (relativa al repo) · estado (crudo) · canonico (o null) ·
 *   grupo (backlog | en_curso | bloqueado | cerrado | sin_entrega | desconocido) · epica · sprint
 *   (entero o null) · prioridad · ado_work_item (entero o null: `TBD` y vacío son null) · depends_on ·
 *   followup_of (listas de ids) · followup_reason · evidencia_de_cierre (true | false | null: null si
 *   el escaneo fue parcial o la clave no se pudo decidir) · dias_en_estado (entero o null: null si las
 *   transiciones no se midieron — nunca 0) · tandas_pendientes (`name` de las tandas del bloque
 *   `pipelines:` con status blocked o pending)
 * epicas[] — {id, titulo, conteo, estimacion}: título del primer `# ` de `epica-<id>*.md`/`epic-<id>*.md`, o del
 *   primer encabezado de un `epics.md` con `Épica <id>`/`Epic <id>`, o null (nunca se inventa).
 *   `conteo` trae SIEMPRE las cinco claves de grupo; una story `desconocido` no suma ahí (se ve en
 *   `cobertura.desconocidos`). `estimacion` sale del registro `.tycon/estimates.jsonl` (`estimacionesDe`), o null si
 *   la épica no está en él; una épica que está en el registro sin historias escritas también entra, con el conteo en 0.
 *   El estado del registro va en `cobertura.estimaciones` (medido · sin_registro · no_medido, con su motivo y las
 *   líneas ilegibles).
 * sprints[] — {n, stories, conteo} por sprint entero en orden, y al final {n: null, …} con las sin
 *   sprint o con sprint no entero. Toda story está en exactamente una.
 * plan[] — {ruta, ultimo_commit}: prd.md, epics.md, plan*.md, PLAN*.md, sprint-plan.md,
 *   sprint-status.yaml y el README.md de la carpeta de specs, en la raíz o bajo specs/, .specs/,
 *   docs/ (hasta 3 niveles). `ultimo_commit` null si git no lo sabe.
 * cobertura — stories_total · ilegibles (archivos con `story:` y `status:` cuyo frontmatter no cierra:
 *   se CUENTAN) · desconocidos (estado crudo → n) · partial · transiciones, metricas y evidencia,
 *   cada una {estado: "medido" | "no_medido", motivo}.
 * alertas[] — {tipo, story, detalle}, de esta lista cerrada: done_sin_evidencia · sin_work_item ·
 *   estado_desconocido · frontmatter_ilegible · dependencia_rota · estancada (en curso > 14 días;
 *   nunca con días null).
 * metricas — lista blanca: lead_time_days, rework_ratio, rework_por_causa, dod_evidence_ratio,
 *   tiempo_por_etapa, estados_por_canonico, not_measured. null con motivo si no hay de dónde copiarlas.
 *
 * 🔴 LISTA BLANCA en dos capas (el molde del reductor): qué campos viajan lo decide este código, nunca
 *    un spread del frontmatter —que trae rutas de máquina y correos— ni del cuerpo. Y todo texto que
 *    viaja pasa además por `sanear` (correos y rutas absolutas fuera).
 *
 * Uso:
 *   node scripts/nightly/projects/snapshot.js --scan <raíz> [--only-harness] --out <dir> [--sdlc <archivo>]
 *   node scripts/nightly/projects/snapshot.js --repo <dir> --out <dir> [--sdlc <archivo>]
 *   Opcional: --transitions-budget-ms <n> (el mismo presupuesto del medidor). Reloj: TYCON_TODAY=AAAA-MM-DD.
 *   Opcional: --org-config <team-repos.json> (la unidad de las estimaciones; sin él, el del árbol que corre).
 *
 * Exit: 0 escribió al menos un archivo, o todos los repos estaban sin stories · 2 no escribió ninguno y
 * hubo fallas (o no encontró ningún repo) · 1 argumentos. Un repo que falla
 * se anota con su motivo y los demás siguen: la foto nunca rompe el nocturno.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(RAIZ, 'scripts', 'metrics', 'sdlc-stage-metrics.js'));
const FO = require(path.join(RAIZ, 'scripts', 'lib', 'followup-of.js'));
const { readEnv } = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
const { esEvidenciaDeCierre } = require(path.join(RAIZ, 'scripts', 'ci', 'tycon-ci-gate.js'));
const SKILLS = require(path.join(RAIZ, 'scripts', 'lib', 'skills-dir.js')).resolveSkillsDirs().skills;
const LIB = path.join(SKILLS, 'tycon-pipeline', 'scripts', 'lib');
const discovery = require(path.join(LIB, 'story-discovery.js'));
const WORK_ITEM = require(path.join(RAIZ, 'scripts', 'lib', 'platform', 'work-item-field.js'));
const evidenceKey = require(path.join(LIB, 'evidence-key.js'));
const evidenceConfig = require(path.join(LIB, 'evidence-config.js'));
const deprecated = require(path.join(LIB, 'deprecated.js'));
const ESTIMATES = require(path.join(RAIZ, 'scripts', 'lib', 'estimates.js'));

const GRUPOS = ['backlog', 'en_curso', 'bloqueado', 'cerrado', 'sin_entrega'];
const CAMPOS_METRICAS = ['lead_time_days', 'rework_ratio', 'rework_por_causa', 'dod_evidence_ratio',
  'tiempo_por_etapa', 'estados_por_canonico', 'not_measured'];
const DIAS_ESTANCADA = 14;
// El mismo presupuesto de descubrimiento que usa el medidor (`discoveryBudgetMs ?? 15000`): con el
// default del descubridor (500 ms) un repo grande sale parcial.
const BUDGET_DESCUBRIMIENTO_MS = Number(process.env.TYCON_STORY_SCAN_BUDGET_MS) || 15000;

// ── args ─────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { repos: [], scan: [], out: null, sdlc: null, orgConfig: null, onlyHarness: false, budgetMs: undefined, error: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const valor = () => {
      const v = argv[++i];
      // Un valor VACÍO también es «falta»: en el nocturno `--sdlc "$SDLC"` con el snapshot ausente
      // llega como "", y tomarlo como «sin --sdlc» mediría todo de nuevo en silencio.
      if (!v || v.startsWith('--')) { a.error = `${k} necesita un valor`; return null; }
      return v;
    };
    if (k === '--repo') { const v = valor(); if (v) a.repos.push(path.resolve(v)); }
    else if (k === '--scan') { const v = valor(); if (v) a.scan.push(path.resolve(v)); }
    else if (k === '--out') { const v = valor(); if (v) a.out = path.resolve(v); }
    else if (k === '--sdlc') { const v = valor(); if (v) a.sdlc = path.resolve(v); }
    else if (k === '--org-config') { const v = valor(); if (v) a.orgConfig = path.resolve(v); }
    else if (k === '--only-harness') a.onlyHarness = true;
    else if (k === '--transitions-budget-ms') {
      const v = Number.parseInt(valor(), 10);
      if (Number.isFinite(v) && v > 0) a.budgetMs = v;
      else a.error = '--transitions-budget-ms inválido';
    } else a.error = `argumento desconocido: ${k}`;
  }
  if (!a.error && !a.out) a.error = 'falta --out <dir>';
  if (!a.error && !a.repos.length && !a.scan.length) a.error = 'falta --repo <dir> o --scan <raíz>';
  return a;
}

// ── texto que viaja ──────────────────────────────────────────────────────────────────────────

/**
 * Saca correos y rutas absolutas de máquina de un texto que va a viajar al JSON. Ruta absoluta es
 * CUALQUIER `/<carpeta>/…` que arranca un token —no sólo `/Users/` y `/home/`: también `/private/var/…`,
 * `/opt/…`, `/Volumes/…`—, también pegada a `:` o `<` (`ruta:/Users/…`),
 * `file://…`, y `C:\…` o `C:/…`. Una ruta relativa (`specs/x.md`) no arranca un token con `/`
 * y queda como está; una URL (`https://host/x`) tampoco: después de `://` viene otra barra, no un nombre.
 */
function sanear(s) {
  if (s == null) return null;
  return String(s)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[correo]')
    .replace(/\bfile:\/\/[^\s"'`)\],;]*/gi, '[ruta]')
    // Una barra que arranca una ruta es la que NO viene pegada a una letra, un punto u otra barra: así entran
    // `ruta:/…`, `**/…`, `-/…`, `<\/…` sin enumerar prefijos (una lista de prefijos siempre queda corta)
    // y quedan afuera `specs/a/b`, `2026/10/07` y el `//host/` de una URL.
    .replace(/(?<![\w./])\/[\w.-]+\/[^\s"'`)\],;<>*]*/g, '[ruta]')
    .replace(/\b[A-Za-z]:[\\/][^\s"'`)\],;<>]*/g, '[ruta]');
}

const rel = (repo, f) => path.relative(repo, f).split(path.sep).join('/');

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

// ── frontmatter: campos que el medidor no publica ────────────────────────────────────────────

/** El cuerpo del frontmatter — el mismo patrón que `parseFrontmatter` del medidor. */
function cuerpoFrontmatter(texto) {
  const m = String(texto).replace(/^﻿/, '').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  return m ? m[1] : null;
}

/**
 * El escalar de una clave, con el regex del medidor (`fmKeyRe`, que corta el comentario de fin de línea).
 * 🔴 Ese regex lleva `\s*` después de los dos puntos, y `\s` cruza el salto de línea: con `epic:` VACÍO
 *    captura la línea siguiente (`epica: "priority:"`, y una épica inventada).
 *    Un valor que no está en la MISMA línea que su clave es un valor vacío.
 */
function escalar(fm, clave) {
  const r = fm.match(M.fmKeyRe(clave));
  if (!r || r[0].includes('\n')) return null;
  const v = r[1].trim();
  return v || null;
}

/** `null`, `~` y vacío son el nulo de YAML: no son un id. */
const esNuloYaml = (v) => v === '' || v === '~' || /^null$/i.test(v);

/** Ids de una lista del frontmatter: inline `["1.2", "1.3"]`, escalar suelto, o bloque `- x` / `- id: x`. */
function listaDeIds(fm, clave) {
  const m = new RegExp(`^${clave}:[ \\t]*(.*)$`, 'm').exec(fm);
  if (!m) return [];
  const inline = FO.sinComentario(m[1]);
  const limpio = (x) => String(x).trim().replace(/^["']|["']$/g, '').trim();
  if (inline) {
    if (inline === '[]') return [];
    const dentro = inline.startsWith('[') ? inline.replace(/^\[|\]$/g, '') : inline;
    return dentro.split(',').map(limpio).filter((x) => !esNuloYaml(x));
  }
  const cuerpo = FO.cuerpoBloque(fm.slice(m.index + m[0].length));
  return [...cuerpo.matchAll(/^[ \t]*-[ \t]*(?:id:[ \t]*)?["']?([^"'#\n]+?)["']?[ \t]*(?:#.*)?$/gm)]
    .map((x) => limpio(x[1])).filter((x) => !esNuloYaml(x));
}

/**
 * Los `name` de las tandas del bloque `pipelines:` con status blocked o pending.
 * 🔴 Las tandas se separan por la SANGRÍA del primer item, no por cada `- `: una tanda puede traer
 *    sublistas (`files:`, `tasks_partial:`) antes de su `status:`, y partir ahí dejaría el status en un
 *    trozo sin `name`.
 */
function tandasPendientes(fm) {
  const m = /^pipelines:[ \t]*(.*)$/m.exec(fm);
  if (!m || FO.sinComentario(m[1])) return [];
  const cuerpo = FO.cuerpoBloque(fm.slice(m.index + m[0].length));
  const primero = /^([ \t]*)-[ \t]+\S/m.exec(cuerpo);
  if (!primero) return [];
  const sangria = primero[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = [];
  for (const tanda of cuerpo.split(new RegExp(`^${sangria}-[ \\t]+(?=\\S)`, 'm')).slice(1)) {
    const nombre = (tanda.match(/^[ \t]*(?:-[ \t]*)?name:[ \t]*["']?([^"'#\n]+?)["']?[ \t]*(?:#.*)?$/m) || [])[1];
    const estado = (tanda.match(/^[ \t]*status:[ \t]*["']?([^"'#\n]+?)["']?[ \t]*(?:#.*)?$/m) || [])[1];
    if (nombre && /^(blocked|pending)$/i.test(String(estado || '').trim())) out.push(nombre.trim());
  }
  return out;
}

const entero = (v) => (v != null && /^\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : null);
const valorEpica = (v) => (v == null ? null : (/^\d+$/.test(v) ? Number(v) : v));

// ── archivos del repo ────────────────────────────────────────────────────────────────────────

/**
 * Los `.md`/`.yaml` del repo que git conoce (commiteados o nuevos sin ignorar) y que están en disco, o
 * `null` si git no pudo listarlos: una lista vacía se leería como «el repo no tiene plan ni épicas ni
 * ilegibles», así que quien llama no escribe la foto.
 */
function archivosDelRepo(repo) {
  const salida = git(repo, ['-c', 'core.quotepath=false', 'ls-files', '-co', '--exclude-standard', '-z',
    '--', '*.md', '*.yaml', '*.yml']);
  if (salida === null) return null;
  return [...new Set(salida.split('\0').filter(Boolean))]
    .map((r) => path.join(repo, r)).filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}

/** ¿Forma de story con el frontmatter roto? `---` al principio, `story:` y `status:`, y no cierra. */
function esIlegible(f) {
  if (!f.endsWith('.md')) return null;
  let texto;
  try { texto = fs.readFileSync(f, 'utf8').replace(/^﻿/, ''); } catch { return null; }
  if (!texto.startsWith('---') || cuerpoFrontmatter(texto) !== null) return null;
  const cabeza = texto.split('\n').slice(0, 60).join('\n');
  if (!/^\s*story\s*:\s*\S/m.test(cabeza) || !/^\s*status\s*:\s*\S/m.test(cabeza)) return null;
  const id = (cabeza.match(/^\s*story\s*:\s*["']?([^"'#\n]+?)["']?\s*$/m) || [])[1];
  return { id: id || null };
}

function tituloDeEpica(id, archivos, repo) {
  if (id == null) return null;
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const porArchivo = new RegExp(`^(?:epica|epic)-${esc}(?:[-_][^/]*)?\\.md$`, 'i');
  for (const f of archivos.filter((x) => porArchivo.test(path.basename(x))).sort()) {
    try {
      const h = fs.readFileSync(f, 'utf8').split('\n').find((l) => /^#\s+\S/.test(l));
      if (h) return sanear(h.replace(/^#\s+/, '').trim());
    } catch { /* ilegible: sigue */ }
  }
  const enEpics = new RegExp(`(?:^|[\\s#*_])(?:épica|epica|epic)\\s+${esc}(?![\\w.])`, 'iu');
  for (const f of archivos.filter((x) => path.basename(x).toLowerCase() === 'epics.md').sort((a, b) => rel(repo, a).length - rel(repo, b).length || a.localeCompare(b))) {
    try {
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        const h = l.match(/^#{1,6}\s+(.*\S)\s*$/);
        if (h && enEpics.test(h[1])) return sanear(h[1].replace(/\s+#+\s*$/, '').trim());
      }
    } catch { /* ilegible: sigue */ }
  }
  return null;
}

const NOMBRES_DE_PLAN = [/^prd\.md$/, /^epics\.md$/, /^plan.*\.md$/, /^PLAN.*\.md$/, /^sprint-plan\.md$/, /^sprint-status\.yaml$/];
const CARPETAS_DE_PLAN = new Set(['specs', '.specs', 'docs']);

function plan(repo, archivos) {
  const out = [];
  for (const f of archivos) {
    const r = rel(repo, f);
    const partes = r.split('/');
    const base = partes[partes.length - 1];
    if (partes.length - 1 > 3) continue;                       // hasta 3 niveles de carpeta
    if (partes.length > 1 && !CARPETAS_DE_PLAN.has(partes[0])) continue;
    const esReadmeDeSpecs = base === 'README.md' && (partes[0] === 'specs' || partes[0] === '.specs');
    if (!esReadmeDeSpecs && !NOMBRES_DE_PLAN.some((re) => re.test(base))) continue;
    const fecha = (git(repo, ['log', '-1', '--format=%cI', '--', r]) || '').trim();
    out.push({ ruta: r, ultimo_commit: fecha || null });
  }
  return out.sort((a, b) => a.ruta.localeCompare(b.ruta));
}

// ── evidencia de cierre (la del portón) ──────────────────────────────────────────────────────

/**
 * Los archivos de evidencia del repo, sus hermanos y sus compañeros declarados: `{archivos}`, o
 * `{motivo}` si alguna fuente no se pudo leer. 🔴 Mirar con una carpeta de menos da `false` donde la
 * respuesta es «no sé» —y una alerta `done_sin_evidencia` falsa—:
 * una carpeta que no existe no es un problema; una que existe y no se lee, sí.
 */
function archivosDeEvidencia(repo) {
  const dirs = [...M.dirsDeEvidencia(repo)];
  try {
    for (const r of evidenceConfig.productEvidenceRoots(repo)) dirs.push(path.join(r, '.advisors', 'dod-runtime'));
  } catch (e) {
    return { motivo: `no se pudo leer la declaración de compañeros (.tycon/advisors.yaml → evidence): ${e.message}` };
  }
  const vistos = new Set();
  const archivos = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    let real;
    try {
      real = fs.realpathSync(d);
      if (vistos.has(real)) continue;
      vistos.add(real);
      archivos.push(...fs.readdirSync(real));
    } catch (e) {
      return { motivo: `no se pudo leer la carpeta de evidencia ${path.basename(path.dirname(path.dirname(d)))}/.advisors/dod-runtime: ${e.code || e.message}` };
    }
  }
  return { archivos };
}

// ── la foto de un repo ───────────────────────────────────────────────────────────────────────

function hoyUTC() {
  const h = readEnv('TYCON_TODAY', { where: 'scripts/nightly/projects/snapshot.js' });
  if (h && /^\d{4}-\d{2}-\d{2}$/.test(h)) return h;
  return new Date().toISOString().slice(0, 10);
}

function fotoDeRepo(repo, opts) {
  if (!fs.existsSync(path.join(repo, '.git'))) return { error: 'no es un repo git' };
  let found;
  try {
    found = discovery.discoverStories(repo, {
      configRoot: discovery.findRepoRoot(repo) || repo, budgetMs: BUDGET_DESCUBRIMIENTO_MS, cache: false,
    });
  } catch (e) {
    return { error: `el descubridor de stories falló: ${e.message}` };
  }
  const partial = !!found.partial;
  const archivos = archivosDelRepo(repo);
  if (archivos === null) return { error: 'git no pudo listar los archivos del repo (ls-files) — sin la lista no hay plan, títulos de épica ni ilegibles que publicar' };
  const vistos = new Set([...found.stories, ...(found.excluded || [])].map((s) => path.resolve(s.path)));

  // 1 · stories y frontmatters ilegibles
  const ilegibles = [];
  const stories = [];
  for (const s of found.stories) {
    const fm = M.readFrontmatter(s.path);
    let texto = '';
    try { texto = fs.readFileSync(s.path, 'utf8'); } catch { /* cae a ilegible */ }
    const cuerpo = cuerpoFrontmatter(texto);
    if (!fm || !fm.id || cuerpo === null) { ilegibles.push({ id: s.id || null, ruta: rel(repo, s.path) }); continue; }
    stories.push({ file: s.path, ...fm, descubierta: s, fmTexto: cuerpo });
  }
  for (const f of archivos) {
    if (vistos.has(path.resolve(f))) continue;
    const il = esIlegible(f);
    if (il) ilegibles.push({ id: il.id, ruta: rel(repo, f) });
  }
  // Sin una sola story legible no hay foto (`stories_total > 0`), pero los ilegibles no se callan:
  // el repo sale nombrado como «sin stories» CON su cuenta de frontmatters rotos.
  if (!stories.length) return { vacio: true, ilegibles: ilegibles.length };

  // 2 · estado canónico y grupo — del diccionario del medidor
  const dic = M.diccionario();
  const grupoDe = new Map();
  if (!dic.motivo) for (const [g, lista] of Object.entries(dic.grupos)) for (const e of lista) grupoDe.set(e, g);
  const desconocidos = Object.create(null);
  for (const s of stories) {
    s.canonico = null;
    s.grupo = 'desconocido';
    if (dic.motivo) continue;
    // El estado lo lee el MEDIDOR (`fmKeyRe`, que corta el comentario de fin de línea): con el escalar
    // del descubridor, `status: done   # habilitada…` saldría «desconocido» y el medidor lo contaría cerrado.
    const c = M.canonEstado(s.status);
    if (!c) continue;
    // La CLAVE es el estado crudo: viaja saneada como cualquier otro texto.
    if (c.desconocido) { const k = sanear(c.desconocido); desconocidos[k] = (desconocidos[k] || 0) + 1; continue; }
    s.canonico = c.estado;
    s.grupo = grupoDe.get(c.estado) || 'desconocido';
  }

  // 3 · días en el estado — de las transiciones del medidor
  let transiciones = { estado: 'no_medido', motivo: null };
  let tr = null;
  if (dic.motivo) {
    transiciones.motivo = `${dic.motivo} — sin saber qué estado es cuál no se cuentan días en el estado`;
  } else {
    tr = M.derivarTransiciones(repo, stories, { budgetMs: opts.budgetMs });
    if (tr.agotado || tr.medible === false) transiciones.motivo = tr.motivo || 'transiciones: no se pudieron medir';
    else transiciones = { estado: 'medido', motivo: tr.motivo || null };
  }
  const hoy = Date.parse(`${hoyUTC()}T00:00:00Z`);
  const fueraDeSerie = new Set([...((tr && tr.storiesFaltantes) || []), ...((tr && tr.conIlegibles) || []),
    ...((tr && tr.idsDuplicados) || [])]);
  const diasEnEstado = (s) => {
    if (transiciones.estado !== 'medido' || !s.canonico || fueraDeSerie.has(s.id)) return null;
    const serie = (tr.transiciones || {})[s.id] || [];
    let desde = null;
    if (serie.length) { const u = serie[serie.length - 1]; if (u.a === s.canonico) desde = u.fecha; }
    else desde = (tr.altas || {})[s.id] || null;
    if (!desde) return null;
    const d = Math.round((hoy - Date.parse(`${String(desde).slice(0, 10)}T00:00:00Z`)) / 86400000);
    return Number.isFinite(d) && d >= 0 ? d : null;
  };

  // 4 · evidencia de cierre — criterio y clave del portón
  let evidenciaDe = () => null;
  const evidencia = { estado: 'no_medido', motivo: null };
  if (partial) {
    evidencia.motivo = 'el recorrido de stories quedó incompleto — sin la lista entera no se sabe qué números se repiten, y la clave de la evidencia no se puede decidir';
  } else {
    const ev = archivosDeEvidencia(repo);
    if (ev.motivo) evidencia.motivo = ev.motivo;
    else {
      try {
        const claves = evidenceKey.keysForStories(stories.map((s) => ({ path: s.file, id: s.id })), repo);
        evidenciaDe = (s) => {
          const clave = claves.get(path.resolve(s.file));
          if (!clave) return null;
          return ev.archivos.some((f) => f.startsWith(`${clave}-`) && esEvidenciaDeCierre(f));
        };
        evidencia.estado = 'medido';
      } catch (e) {
        // La clave no se puede decidir: null para todas, nunca false — y se dice por qué.
        evidencia.motivo = `la clave de la evidencia no se pudo decidir: ${e.message}`;
      }
    }
  }

  // 5 · las stories, en el orden del descubridor, con la lista blanca
  const listaStories = stories.map((s) => {
    const fm = s.fmTexto;
    return {
      id: sanear(s.id),
      titulo: sanear(s.descubierta.title),
      ruta: rel(repo, s.file),
      estado: sanear(escalar(fm, 'status')),
      canonico: s.canonico,
      grupo: s.grupo,
      epica: valorEpica(sanear(escalar(fm, 'epic'))),
      sprint: entero(escalar(fm, 'sprint')),
      prioridad: sanear(escalar(fm, 'priority')),
      // el pedido de trabajo: `work_item`, o su nombre viejo (la clave del contrato no cambia)
      ado_work_item: entero(WORK_ITEM.idOf(fm)),
      depends_on: listaDeIds(fm, 'depends_on').map(sanear),
      followup_of: listaDeIds(fm, 'followup_of').map(sanear),
      followup_reason: sanear(s.followupReason),
      evidencia_de_cierre: evidenciaDe(s),
      dias_en_estado: diasEnEstado(s),
      tandas_pendientes: tandasPendientes(fm).map(sanear),
    };
  });

  // 6 · épicas y sprints
  const conteoVacio = () => Object.fromEntries(GRUPOS.map((g) => [g, 0]));
  const sumar = (conteo, st) => { if (GRUPOS.includes(st.grupo)) conteo[st.grupo] += 1; };
  const ordenId = (a, b) => {
    const ka = discovery.idSortKey(a); const kb = discovery.idSortKey(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (ka[i] ?? Infinity) - (kb[i] ?? Infinity);
      if (d) return d;
    }
    // sin el idioma de la máquina: la misma foto sale en el mismo orden en cualquier máquina
    const sa = String(a); const sb = String(b);
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  };
  const epicasMap = new Map();
  for (const st of listaStories) {
    const k = st.epica == null ? null : String(st.epica);
    if (!epicasMap.has(k)) epicasMap.set(k, { id: st.epica, conteo: conteoVacio() });
    sumar(epicasMap.get(k).conteo, st);
  }
  // las estimaciones: una épica que está en el registro sin historias escritas también tiene fila, con el conteo en cero
  const est = estimacionesDe(repo, opts.orgConfig);
  for (const id of est.epicas.keys()) if (!epicasMap.has(id)) epicasMap.set(id, { id: valorEpica(id), conteo: conteoVacio() });
  const epicas = [...epicasMap.entries()]
    .sort(([a], [b]) => (a === null) - (b === null) || (a === null ? 0 : ordenId(a, b)))
    .map(([k, e]) => ({ id: e.id, titulo: tituloDeEpica(e.id, archivos, repo), conteo: e.conteo, estimacion: (k !== null && est.epicas.get(k)) || null }));

  const sprintsMap = new Map();
  const sinSprint = { n: null, stories: [], conteo: conteoVacio() };
  for (const st of listaStories) {
    const destino = st.sprint == null ? sinSprint
      : (sprintsMap.get(st.sprint) || sprintsMap.set(st.sprint, { n: st.sprint, stories: [], conteo: conteoVacio() }).get(st.sprint));
    destino.stories.push(st.id);
    sumar(destino.conteo, st);
  }
  const sprints = [...sprintsMap.values()].sort((a, b) => a.n - b.n);
  if (sinSprint.stories.length) sprints.push(sinSprint);

  // 7 · alertas (lista cerrada)
  const alertas = [];
  const porId = new Map(listaStories.map((st) => [st.id, st]));
  for (const st of listaStories) {
    if (st.grupo === 'cerrado' && st.evidencia_de_cierre === false) {
      alertas.push({ tipo: 'done_sin_evidencia', story: st.id, detalle: 'cerrada sin evidencia de cierre en .advisors/dod-runtime (criterio del portón)' });
    }
    if (st.ado_work_item === null && st.grupo !== 'sin_entrega') {
      alertas.push({ tipo: 'sin_work_item', story: st.id, detalle: 'sin pedido de trabajo (work_item)' });
    }
    if (!dic.motivo && st.grupo === 'desconocido') {
      alertas.push({ tipo: 'estado_desconocido', story: st.id, detalle: `el estado «${st.estado}» no está en el diccionario de estados` });
    }
    for (const dep of st.depends_on) {
      const otra = porId.get(dep);
      if (!otra) alertas.push({ tipo: 'dependencia_rota', story: st.id, detalle: `depende de ${dep}, que no existe en el repo` });
      else if (otra.grupo === 'sin_entrega') alertas.push({ tipo: 'dependencia_rota', story: st.id, detalle: `depende de ${dep}, que no se va a entregar (${otra.estado})` });
    }
    if (st.grupo === 'en_curso' && st.dias_en_estado !== null && st.dias_en_estado > DIAS_ESTANCADA) {
      alertas.push({ tipo: 'estancada', story: st.id, detalle: `${st.dias_en_estado} días en ${st.estado} (más de ${DIAS_ESTANCADA})` });
    }
  }
  for (const il of ilegibles) {
    alertas.push({ tipo: 'frontmatter_ilegible', story: sanear(il.id), detalle: `frontmatter sin cerrar o ilegible: ${il.ruta}` });
  }
  // La lista de código deprecado que se pudre: rutas que ya no alcanzan ningún archivo y entradas que pasaron su
  // fecha de revisión. Son del repo, no de una story.
  const deprecadas = deprecated.podridas(repo, { hoy: hoyUTC() });
  if (String(deprecadas.estado).startsWith('unknown-')) {
    // «no pude mirar» no se ve igual que «está sana»
    alertas.push({ tipo: 'deprecado_no_medido', story: null, detalle: sanear(`código deprecado: no medido (${deprecadas.motivo || deprecadas.estado})`) });
  }
  for (const p of deprecadas.podridas) {
    alertas.push({
      tipo: 'deprecado_podrido',
      story: null,
      detalle: sanear(p.motivo === 'no-existe'
        ? `código deprecado: ${p.entry.path} ya no alcanza ningún archivo`
        : `código deprecado: ${p.entry.path} pasó su fecha de revisión (${p.entry.review_by})`),
    });
  }

  // 8 · métricas (copiadas, lista blanca)
  const { metricas, motivo: motivoMetricas } = metricasDe(repo, opts, dic);

  return {
    stories: listaStories,
    epicas,
    sprints,
    plan: plan(repo, archivos),
    alertas,
    metricas,
    cobertura: {
      stories_total: listaStories.length,
      ilegibles: ilegibles.length,
      desconocidos: { ...desconocidos },
      partial,
      transiciones: { estado: transiciones.estado, motivo: sanear(transiciones.motivo) },
      metricas: { estado: metricas ? 'medido' : 'no_medido', motivo: sanear(motivoMetricas) },
      evidencia: { estado: evidencia.estado, motivo: sanear(evidencia.motivo) },
      estimaciones: est.estado,
    },
  };
}

/**
 * Las estimaciones del repo (`.tycon/estimates.jsonl`, scripts/lib/estimates.js), por épica y por lista blanca: el
 * rango, las sumas del plan y vigente, dentro o fuera y por cuánto, lo mismo en horas si se puede convertir, y lo real.
 * Las versiones, quién estimó y los supuestos no viajan. Devuelve `{ estado, epicas: Map<id, estimacion> }`; `estado` es
 * `{ estado: medido | sin_registro | no_medido, motivo, ilegibles, unidad }`. Un registro o una configuración que no se
 * leen no rompen la foto: quedan `no_medido` con su motivo.
 */
function estimacionesDe(repo, orgConfig) {
  const epicas = new Map();
  // sólo «no existe» es «sin registro»: un registro que está y no se puede mirar es «no medido» (lo dice `read`)
  try { fs.statSync(path.join(repo, ESTIMATES.REGISTRO)); } catch (e) {
    if (e && e.code === 'ENOENT') return { estado: { estado: 'sin_registro', motivo: null, ilegibles: 0, unidad: null }, epicas };
  }
  let registro;
  let org;
  try {
    registro = ESTIMATES.read(repo);
    // la unidad la edita el sitio en el team-repos.json del perfil: la noche lo pasa con --org-config; sin él, el del árbol
    org = ESTIMATES.orgEstimates(orgConfig || undefined);
  } catch (e) {
    return { estado: { estado: 'no_medido', motivo: sanear(String((e && e.message) || e).split('\n')[0]), ilegibles: 0, unidad: null }, epicas };
  }
  const ids = [...new Set(registro.lines.map((l) => String(l.epica)))];
  for (const id of ids) {
    const r = ESTIMATES.report(registro, id, org);
    // una épica que sólo tiene horas reales (el cierre las anota aunque nadie haya estimado), o la épica vieja de una
    // historia que se mudó, no es una estimación: no tiene fila
    if (r.sin_estimaciones) continue;
    // la misma clave que las historias (un id con ceros a la izquierda es el mismo número): si no, la misma épica sale
    // dos veces
    const clave = String(valorEpica(id));
    if (epicas.has(clave)) continue;
    const u = r.unidad;
    const horas = (v) => (v === null || !u ? null : ESTIMATES.aHoras(v, u, org));
    const enHoras = u ? { min: r.rango ? horas(r.rango.min) : null, max: r.rango ? horas(r.rango.max) : null, plan: horas(r.suma_plan), vigente: horas(r.suma_vigente) } : null;
    // con puntos sin tasa, nada pasa a horas: sin `en_horas` (la vista suma por unidad). Sin rango, también vale: lo
    // que hay se convierte
    const pasa = (valor, enH) => valor === null || valor === undefined || enH !== null;
    const convertible = enHoras && pasa(r.rango && r.rango.min, enHoras.min) && pasa(r.rango && r.rango.max, enHoras.max)
      && pasa(r.suma_plan, enHoras.plan) && pasa(r.suma_vigente, enHoras.vigente);
    epicas.set(clave, {
      rango: r.rango ? { min: r.rango.min, max: r.rango.max, unidad: r.rango.unidad } : null,
      unidad: u,
      suma_plan: r.suma_plan,
      suma_vigente: r.suma_vigente,
      dentro: r.dentro,
      fuera: r.fuera,
      por: r.por,
      sumas_por_unidad: r.sumas_por_unidad,
      motivo: sanear(r.motivo),
      en_horas: convertible ? enHoras : null,
      real: { cerrada: r.real.cerrada, suma: r.real.suma, faltan: r.real.faltan, motivo: sanear(r.real.motivo) },
    });
  }
  return { estado: { estado: 'medido', motivo: null, ilegibles: registro.unreadable.length, unidad: org.unit }, epicas };
}

/**
 * Saneado en profundidad: textos Y claves. Las métricas copiadas traen mapas cuya CLAVE es un valor crudo
 * del frontmatter (`estados_por_canonico.sin_diccionario`, `rework_por_causa.fuera_de_vocabulario`): un
 * `status:` con un correo viajaba ahí aunque el resto estuviera saneado.
 */
function sanearProfundo(v) {
  if (typeof v === 'string') return sanear(v);
  if (Array.isArray(v)) return v.map(sanearProfundo);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[sanear(k)] = sanearProfundo(x);
    return out;
  }
  return v;
}

function listaBlanca(entrada) {
  const out = {};
  for (const c of CAMPOS_METRICAS) out[c] = sanearProfundo(entrada[c] === undefined ? null : entrada[c]);
  return out;
}

function metricasDe(repo, opts, dic) {
  if (opts.sdlcError) return { metricas: null, motivo: opts.sdlcError };
  if (opts.sdlc) {
    const repos = Array.isArray(opts.sdlc.repos) ? opts.sdlc.repos : [];
    let e = repos.find((r) => r && r.repo && path.resolve(r.repo) === path.resolve(repo));
    if (!e) {
      const mismos = repos.filter((r) => r && r.repo && path.basename(r.repo) === path.basename(repo));
      if (mismos.length === 1) [e] = mismos;
    }
    if (!e) return { metricas: null, motivo: 'el snapshot SDLC del día no trae este repo' };
    if (e.error) return { metricas: null, motivo: `el medidor no pudo medir este repo: ${e.error}` };
    return { metricas: listaBlanca(e), motivo: null };
  }
  if (dic.motivo) return { metricas: null, motivo: dic.motivo };
  const m = M.measureRepo(repo, null, { budgetMs: opts.budgetMs });
  if (m.error) return { metricas: null, motivo: `el medidor no pudo medir este repo: ${m.error}` };
  // La misma proyección que el `payload` del medidor, campo por campo.
  return {
    metricas: listaBlanca({
      lead_time_days: M.stats((m.leads || []).map((l) => l.days)),
      rework_ratio: m.rework,
      rework_por_causa: m.reworkPorCausa || null,
      dod_evidence_ratio: m.dod,
      tiempo_por_etapa: m.tiempoPorEtapa || null,
      estados_por_canonico: m.estadosPorCanonico || null,
      not_measured: m.notMeasured,
    }),
    motivo: null,
  };
}

// ── escritura ────────────────────────────────────────────────────────────────────────────────

function escribir(out, nombre, datos) {
  const destino = path.join(out, `${nombre}.json`);
  const tmp = path.join(out, `.${nombre}.json.tmp-${process.pid}`);
  try {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(datos, null, 2)}\n`);
    fs.renameSync(tmp, destino);
    return null;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* no quedó */ }
    return `no se pudo escribir ${nombre}.json: ${e.code || e.message}`;
  }
}

function main() {
  const t0 = Date.now();
  const a = parseArgs(process.argv.slice(2));
  if (a.error) {
    console.error(`snapshot.js: ${a.error}\nuso: snapshot.js (--repo <dir> | --scan <raíz> [--only-harness]) --out <dir> [--sdlc <sdlc-stage.json>]`);
    return 1;
  }
  const opts = { budgetMs: a.budgetMs, sdlc: null, sdlcError: null, orgConfig: a.orgConfig };
  if (a.sdlc) {
    try { opts.sdlc = JSON.parse(fs.readFileSync(a.sdlc, 'utf8')); }
    catch (e) { opts.sdlcError = `no se pudo leer el snapshot SDLC (${path.basename(a.sdlc)}): ${e.code || e.message}`; }
  }

  const objetivos = [...a.repos.map((r) => ({ repo: r, explicito: true }))];
  for (const raiz of a.scan) for (const r of M.discoverRepos(raiz)) objetivos.push({ repo: r, explicito: false });

  let escritos = 0;
  const sinStories = [];
  const fallidos = [];
  let sinHuella = 0;
  for (const { repo, explicito } of objetivos) {
    if (a.onlyHarness && !explicito && !M.tieneHuellaDelArnes(repo)) { sinHuella++; continue; }
    const nombre = path.basename(repo);
    let f;
    try { f = fotoDeRepo(repo, opts); } catch (e) { f = { error: `falló la foto: ${e.message}` }; }
    if (f.error) { fallidos.push(`${nombre}: ${sanear(f.error)}`); continue; }
    if (f.vacio) {
      sinStories.push(f.ilegibles ? `${nombre} (${f.ilegibles} con el frontmatter roto)` : nombre);
      // Todas sus stories rotas: su foto de anoche quedaría vieja sin que nada lo diga.
      if (f.ilegibles && process.env.TF_BUILD) {
        console.log(`##vso[task.logissue type=warning]Foto por proyecto, no escrito — ${nombre}: sus ${f.ilegibles} story(s) tienen el frontmatter roto`);
      }
      continue;
    }
    const sep = nombre.indexOf('__');
    const datos = {
      v: 1,
      generated_at: new Date().toISOString(),
      proyecto: sep > 0 ? nombre.slice(0, sep) : null,
      repo: sep > 0 ? nombre.slice(sep + 2) : nombre,
      cobertura: f.cobertura,
      plan: f.plan,
      epicas: f.epicas,
      sprints: f.sprints,
      stories: f.stories,
      alertas: f.alertas,
      metricas: f.metricas,
    };
    const err = escribir(a.out, nombre, datos);
    if (err) { fallidos.push(`${nombre}: ${err}`); continue; }
    escritos++;
    console.log(`  ${nombre}: ${f.stories.length} stories · ${f.alertas.length} alertas · métricas ${f.cobertura.metricas.estado}`);
  }

  console.log(`foto por proyecto: ${escritos} archivo(s) en ${a.out} · ${sinStories.length} repo(s) sin stories`
    + `${sinStories.length ? ` (${sinStories.join(', ')})` : ''}`
    + `${sinHuella ? ` · ${sinHuella} sin huella del arnés` : ''} · ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const f of fallidos) {
    console.error(`⚠️  no escrito — ${f}`);
    // En Azure DevOps (`TF_BUILD`), un repo que no se pudo fotografiar es un AVISO visible en la corrida: con
    // otros repos escritos el guion sale 0 y el `|| logissue` del paso no se dispara; sin esto, quien la lee vería la
    // foto vieja de ese repo y el único rastro sería una línea en el log.
    if (process.env.TF_BUILD) console.log(`##vso[task.logissue type=warning]Foto por proyecto, no escrito — ${f}`);
  }
  // Todos los repos sin stories y ninguna falla NO es una falla;
  // una raíz sin ningún repo, sí: casi siempre es una ruta equivocada.
  if (escritos > 0) return 0;
  if (!fallidos.length && sinStories.length) return 0;
  if (!objetivos.length) console.error('⚠️  no encontré ningún repo git que mirar');
  return 2;
}

if (require.main === module) process.exitCode = main();

module.exports = { parseArgs, sanear, listaDeIds, tandasPendientes, fotoDeRepo };
