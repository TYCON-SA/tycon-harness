#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * story-index.js — los dos índices de historias de un repo (`specs/epics.md` y `specs/sprint-status.yaml`), armados
 * desde el frontmatter de cada historia.
 *
 * Escritos a mano, dos ramas que suman una historia cada una chocan en esos dos archivos aunque cada una sólo sumó su
 * renglón, y el índice se desfasa del frontmatter. Generados, el frontmatter es la única fuente: la prosa de cada épica
 * es lo único que se escribe a mano, en `specs/epics-intro.md`. Un repo los declara generados en el perfil del equipo
 * (`team-repos.json` → `story_index`).
 *
 *   node story-index.js --repo <dir> --write                 arma los dos y los escribe
 *   node story-index.js --repo <dir> --check                 0 si lo escrito es lo que generaría; 1 con las diferencias
 *   node story-index.js --repo <dir> --mode [--team-repos <archivo>]   «generated» o «manual», según el perfil instalado
 *   node story-index.js --repo <dir> --guard [--team-repos <archivo>]
 *        el freno del pre-commit: en una rama de un repo con índice generado, frena un índice preparado que no es el
 *        generado. Deja pasar un merge en curso, `main` y lo igual al generado; sin perfil legible avisa y no frena.
 *   node story-index.js --repo <dir> --regenerate-on-main [--remote origin] [--before-push <comando>]
 *        lo que corre en main después de cada merge: trae main, regenera, y si cambió commitea los dos con [skip ci] y
 *        empuja sin forzar; si el empuje choca, trae main y vuelve a intentar, hasta 3 veces. `--before-push` corre un
 *        comando antes de cada empuje (lo usan las pruebas para simular otro merge que entra en el medio).
 *   node story-index.js --repo <dir> --migrate --report <archivo> [--date AAAA-MM-DD]
 *        el paso de un índice a mano a generado: el informe de lo que no coincide, una historia mínima por cada entrada
 *        sin archivo (así su número sigue reservado), la nota de cada renglón al Change Log de su historia, y los dos
 *        índices regenerados.
 *
 * Las historias las encuentra el mismo descubridor que los demás lectores del arnés. Lo que el descubridor descarta (sin
 * `story` o sin `status`, o con un id fuera del patrón) y lo que vuelve sin `epic` se avisa con su ruta, y nada se
 * escribe: un índice al que le falta una historia es peor que uno viejo. Un escaneo que quedó incompleto, igual.
 *
 * Salidas: 0 bien · 1 frenado (lo dice la última línea) · 2 mal llamado.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TREE = path.resolve(__dirname, '..', '..');
const discovery = require(path.join(TREE, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-discovery.js'));
const { idiomaFijo } = require(path.join(TREE, 'scripts', 'lib', 'clean-git-env.js'));

const SPECS = 'specs';
const EPICS = `${SPECS}/epics.md`;
const SPRINT = `${SPECS}/sprint-status.yaml`;
const INTRO = `${SPECS}/epics-intro.md`;
// el escaneo de una herramienta que se corre a mano, o en un pipeline, no tiene el apuro del de cada edición
const BUDGET_MS = 60000;
const TRIES = 3;
const SELF = `node ${path.relative(TREE, __filename).split(path.sep).join('/')}`;

const SPRINT_HEADER = [
  '# Generado por scripts/tools/story-index.js desde el frontmatter de cada historia: no se edita a mano.',
  '# El estado de una historia se cambia en su frontmatter (marker.js update-story-status), y este archivo se regenera.',
  '# El orden es por épica y por número. El título y la introducción de cada épica viven en specs/epics-intro.md.',
  `story_location: ${SPECS}`,
  'development_status:',
];
const EPICS_HEADER = [
  '# Épicas',
  '',
  '> Generado por scripts/tools/story-index.js desde el frontmatter de cada historia: no se edita a mano. El título y la',
  '> introducción de cada épica viven en specs/epics-intro.md.',
];

// ── armar ──────────────────────────────────────────────────────────────────────────────────────

const nums = (id) => (String(id).match(/\d+/g) || []).map(Number);
function cmpNums(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] === undefined ? -1 : a[i]) - (b[i] === undefined ? -1 : b[i]);
    if (d) return d;
  }
  return 0;
}

/** El slug de una historia: el nombre del archivo sin `story-<número>-` ni `.md`. */
function slugOf(file) { return path.basename(file, '.md').replace(/^story-\d+(?:\.\d+)*-?/, ''); }

/** El id (ya trae la épica adelante: `collect` lo exige) y la clave de `sprint-status.yaml`: `8.17.1` → `8-17-1-<slug>`. */
function fullId(s) { return String(s.id); }
function keyOf(s) { const slug = slugOf(s.rel); return `${fullId(s).replace(/\./g, '-')}${slug ? `-${slug}` : ''}`; }

/** Lo que hay entre las rayas del frontmatter de un archivo, o null. */
function frontmatter(abs) {
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (_) { return null; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : null;
}

/** El título y la introducción de cada épica, de `specs/epics-intro.md`: Map épica → { title, body }. */
function readIntro(repo) {
  const out = new Map();
  let text;
  // sin el archivo, cada épica sale «sin introducción»; uno que está y no se puede leer frena: no es lo mismo
  try { text = fs.readFileSync(path.join(repo, INTRO), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return out;
    out.problem = `${INTRO}: no se puede leer (${(e && e.code) || e}): sin él se perdería la prosa de cada épica`;
    return out;
  }
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^## Épica (\S+?)(?: — (.*))?$/.exec(line);
    if (h) { cur = { title: (h[2] || '').trim(), lines: [] }; out.set(h[1], cur); continue; }
    if (/^#{1,2} /.test(line)) { cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  for (const v of out.values()) { v.body = v.lines.join('\n').trim(); delete v.lines; }
  return out;
}

/**
 * Las historias de `specs/` y lo que no se pudo leer: `{ stories, problems, partial }`. Cada historia trae `id`, `epic`,
 * `title`, `status` y `rel` (su ruta desde el repo).
 */
function collect(repo) {
  const budgetMs = process.env.TYCON_STORY_SCAN_BUDGET_MS ? discovery.BUDGET_MS : BUDGET_MS;
  const res = discovery.discoverStories(repo, { cache: false, budgetMs });
  const rel = (abs) => path.relative(repo, abs).split(path.sep).join('/');
  const inSpecs = (abs) => path.dirname(rel(abs)) === SPECS;
  const problems = [];
  if (res.partial) problems.push(`el escaneo quedó incompleto (tope de ${budgetMs} ms): no sé si están todas las historias`);
  const stories = [];
  const seen = new Set();
  for (const s of res.stories.filter((x) => inSpecs(x.path))) {
    seen.add(rel(s.path));
    if (!s.epic) { problems.push(`${rel(s.path)}: le falta epic en el frontmatter`); continue; }
    // el id tiene que ser <épica>.<n>[.<n>…] con la épica del frontmatter: si no, la historia saldría en otra épica
    if (!new RegExp(`^${String(s.epic).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.\\d+)+$`).test(String(s.id))) {
      problems.push(`${rel(s.path)}: su id «${s.id}» no es <épica>.<número> con su épica (${s.epic})`);
      continue;
    }
    stories.push({ id: s.id, epic: String(s.epic), title: s.title || '', status: s.status, rel: rel(s.path) });
  }
  const outside = new Set(res.excluded.filter((x) => inSpecs(x.path)).map((x) => rel(x.path)));
  // lo que el descubridor dejó afuera por su id, se llame como se llame
  for (const r of [...outside].sort()) if (!/^story-.*\.md$/.test(path.posix.basename(r))) problems.push(`${r}: su id está fuera del patrón de ids de historia`);
  let files = [];
  try { files = fs.readdirSync(path.join(repo, SPECS)).filter((f) => /^story-.*\.md$/.test(f)); } catch (_) { files = []; }
  for (const f of files.sort()) {
    const r = `${SPECS}/${f}`;
    if (seen.has(r)) continue;
    if (outside.has(r)) { problems.push(`${r}: su id está fuera del patrón de ids de historia`); continue; }
    if (res.partial) continue;
    const fm = frontmatter(path.join(repo, r));
    if (fm === null) { problems.push(`${r}: no tiene frontmatter legible`); continue; }
    const missing = ['story', 'status'].filter((k) => !new RegExp(`^${k}:\\s*\\S`, 'm').test(fm));
    problems.push(`${r}: le falta ${missing.length ? missing.join(' y ') : 'story o status legible'} en el frontmatter`);
  }
  stories.sort((a, b) => cmpNums(nums(a.epic), nums(b.epic)) || cmpNums(nums(fullId(a)), nums(fullId(b))) || (a.rel < b.rel ? -1 : 1));
  // dos historias con la misma clave (`8.17` con slug `1-x` y `8.17.1` con slug `x`) serían un solo renglón
  const byKey = new Map();
  for (const s of stories) byKey.set(keyOf(s), [...(byKey.get(keyOf(s)) || []), s.rel]);
  for (const [k, rels] of byKey) if (rels.length > 1) problems.push(`la clave ${k} está repetida: ${rels.join(', ')}`);
  return { stories, problems, partial: !!res.partial };
}

const yamlValue = (v) => (/^[\w.-]+$/.test(v) ? v : JSON.stringify(v));
// la barra invertida se escapa antes que la `|`: si no, `\|` en el texto cerraría la celda
const cell = (v) => String(v).replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/** Los dos textos, de historias ya ordenadas. */
function render(stories, intro) {
  const epics = [...new Set(stories.map((s) => s.epic))];
  const sprint = [...SPRINT_HEADER];
  const md = [...EPICS_HEADER];
  for (const e of epics) {
    const it = intro.get(e);
    const head = `Épica ${e}${it && it.title ? ` — ${it.title}` : ''}`;
    sprint.push(`  # ${head}`);
    md.push('', `## ${head}`, '');
    md.push(it ? (it.body || '> sin introducción todavía') : `> sin introducción: falta en ${INTRO}`, '');
    md.push('| Historia | Título | Estado | Archivo |', '|---|---|---|---|');
    for (const s of stories.filter((x) => x.epic === e)) {
      sprint.push(`  ${keyOf(s)}: ${yamlValue(s.status)}`);
      md.push(`| ${cell(fullId(s))} | ${cell(s.title)} | ${cell(s.status)} | \`${s.rel}\` |`);
    }
  }
  return { [EPICS]: `${md.join('\n')}\n`, [SPRINT]: `${sprint.join('\n')}\n` };
}

/** `{ files, problems }`: los dos textos generados, o lo que impide generarlos. */
function build(repo) {
  const c = collect(repo);
  if (c.problems.length) return { files: null, problems: c.problems };
  const intro = readIntro(repo);
  if (intro.problem) return { files: null, problems: [intro.problem] };
  return { files: render(c.stories, intro), problems: [] };
}

function writeFiles(repo, files) {
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, rel), text);
}

/** Las diferencias entre lo escrito y lo generado, en renglones legibles. */
function differences(repo, files) {
  const out = [];
  for (const [rel, text] of Object.entries(files)) {
    let now = null;
    try { now = fs.readFileSync(path.join(repo, rel), 'utf8'); } catch (_) { now = null; }
    if (now === text) continue;
    if (now === null) { out.push(`${rel}: no está`); continue; }
    const a = new Set(now.split('\n'));
    const b = new Set(text.split('\n'));
    const sobra = [...a].filter((l) => l.trim() && !b.has(l));
    const falta = [...b].filter((l) => l.trim() && !a.has(l));
    out.push(`${rel}: distinto${sobra.length || falta.length ? '' : ' (el orden o los espacios)'}`);
    for (const l of falta.slice(0, 20)) out.push(`  + ${l.trim()}`);
    for (const l of sobra.slice(0, 20)) out.push(`  - ${l.trim()}`);
  }
  return out;
}

// ── git ────────────────────────────────────────────────────────────────────────────────────────

function git(repo, args) {
  const r = gitRaw(repo, args);
  return { ok: r.ok, out: r.out.trim(), err: r.err };
}
// la salida tal cual: un archivo comparado byte por byte no puede perder sus renglones en blanco
function gitRaw(repo, args) {
  const r = spawnSync('git', args, { windowsHide: true, cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: idiomaFijo() });
  return { ok: r.status === 0, out: String(r.stdout || ''), err: String(r.stderr || '').trim() };
}

/**
 * Lo mismo que `build`, pero con las historias que están preparadas para el commit (el índice de git), no con las del
 * disco: un borrador sin seguir, o un cambio sin preparar, no entra. Copia a una carpeta temporal los `.md` de `specs/`
 * y la configuración de ids del repo, tal como están en el índice de git.
 */
function buildFromIndex(repo) {
  const ls = gitRaw(repo, ['ls-files', '-z', '--', SPECS, '.tycon/advisors.yaml']);
  if (!ls.ok) return { files: null, problems: [`no pude listar lo preparado (${ls.err})`] };
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'story-index-'));
  try {
    for (const rel of ls.out.split('\0').filter(Boolean)) {
      // el propio índice no es entrada (en un merge puede estar a medias, con su choque)
      if (rel === EPICS || !(rel === '.tycon/advisors.yaml' || (path.posix.dirname(rel) === SPECS && rel.endsWith('.md')))) continue;
      const show = gitRaw(repo, ['show', `:${rel}`]);
      if (!show.ok) return { files: null, problems: [`no pude leer ${rel} de lo preparado (${show.err})`] };
      fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), show.out);
    }
    fs.mkdirSync(path.join(tmp, SPECS), { recursive: true });
    return build(tmp);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ── el freno del pre-commit ────────────────────────────────────────────────────────────────────

/** El modo del repo según el perfil instalado: `{ mode }`, o `{ unreadable }` con el motivo. */
function modeOf(repo, teamReposFile) {
  const TR = require(path.join(TREE, 'scripts', 'lib', 'team-repos.js'));
  const file = teamReposFile || path.join(TREE, 'team-repos.json');
  const read = TR.load(file);
  if (!read.ok || !read.data) return { unreadable: `no pude leer ${file}: ${((read.problems || [])[0] || {}).message || 'sin motivo'}` };
  let identity = null;
  try {
    const where = require(path.join(TREE, 'scripts', 'tools', 'merge-pr.js')).hostOf(repo);
    if (where && where.problem) return { unreadable: where.problem };
    identity = require(path.join(TREE, 'scripts', 'lib', 'platform', 'platform.js')).identityFromRemote(where);
  } catch (e) { return { unreadable: `no pude leer el remoto de ${repo} (${String((e && e.message) || e).split('\n')[0]})` }; }
  if (!identity) return { mode: 'manual' };
  return { mode: TR.storyIndexFor(read.data, identity).mode };
}

function guard(repo, teamReposFile) {
  const m = modeOf(repo, teamReposFile);
  if (m.unreadable) { console.log(`⚠️ story-index: ${m.unreadable}: no sé si los índices son generados, no freno`); return 0; }
  if (m.mode !== 'generated') return 0;
  // sin detectar renombres: renombrar un índice es sacarlo, y el nombre viejo tiene que aparecer
  const staged = git(repo, ['diff', '--cached', '--name-only', '--no-renames']);
  if (!staged.ok) { console.log(`⚠️ story-index: no pude leer lo preparado (${staged.err}): no freno`); return 0; }
  const touched = staged.out.split('\n').filter((f) => f === EPICS || f === SPRINT);
  if (!touched.length) return 0;
  const gitDir = git(repo, ['rev-parse', '--git-dir']);
  if (gitDir.ok && fs.existsSync(path.resolve(repo, gitDir.out, 'MERGE_HEAD'))) return 0;
  const branch = git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (branch.ok && branch.out === 'main') return 0;
  const b = buildFromIndex(repo);
  const cmd = `${SELF} --repo ${repo} --write`;
  if (b.problems.length) {
    for (const p of b.problems) console.log(`   ${p}`);
    console.log(`🔒 story-index: preparaste ${touched.join(' y ')}, y no puedo generarlos para compararlos (arriba el motivo). En este repo se generan: arreglá el frontmatter y corré ${cmd}`);
    return 1;
  }
  // un índice sacado (borrado o renombrado) no está en lo preparado: también es distinto del generado
  const distintos = touched.filter((f) => { const s = gitRaw(repo, ['show', `:${f}`]); return !s.ok || s.out !== b.files[f]; });
  if (!distintos.length) return 0;
  console.log(`🔒 story-index: ${distintos.join(' y ')} se generan desde el frontmatter y en una rama no se editan a mano. Cambiá el frontmatter de la historia y regeneralos: ${cmd} (después, git add de los dos)`);
  return 1;
}

// ── la regeneración en main ────────────────────────────────────────────────────────────────────

/** El índice que todavía se escribe a mano (está y no trae la cabecera del generado), o null si ninguno. */
function handWritten(repo) {
  const marks = { [SPRINT]: SPRINT_HEADER[0], [EPICS]: EPICS_HEADER[2] };
  for (const [rel, mark] of Object.entries(marks)) {
    let now = null;
    // uno que está y no se puede leer cuenta como escrito a mano: no se pisa lo que no se pudo mirar
    try { now = fs.readFileSync(path.join(repo, rel), 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') return rel; }
    if (now !== null && !now.includes(mark)) return rel;
  }
  return null;
}

function regenerateOnMain(repo, { remote = 'origin', beforePush = null } = {}) {
  for (let i = 1; i <= TRIES; i++) {
    const f = git(repo, ['fetch', '-q', remote, 'main']);
    if (!f.ok) { console.log(`🔒 story-index: no pude traer ${remote}/main (${f.err}): no regenero`); return 1; }
    const co = git(repo, ['checkout', '-q', '-B', 'main', `${remote}/main`]);
    if (!co.ok) { console.log(`🔒 story-index: no pude ponerme en ${remote}/main (${co.err}): no regenero`); return 1; }
    // un índice que todavía no se migró (sin la cabecera del generado) no se pisa: perdería lo escrito a mano
    const aMano = handWritten(repo);
    if (aMano) {
      console.log(`story-index: ${aMano} todavía se escribe a mano (no trae la cabecera del generado): no regenero. Para pasarlo a generado: ${SELF} --repo <repo> --migrate --report <archivo>`);
      return 0;
    }
    const b = build(repo);
    if (b.problems.length) {
      for (const p of b.problems) console.log(`   ${p}`);
      console.log('🔒 story-index: no regeneré los índices de main: hay historias que no se pueden leer (arriba la ruta). Quedan como estaban hasta que se arregle.');
      return 1;
    }
    writeFiles(repo, b.files);
    const st = git(repo, ['status', '--porcelain', '--', EPICS, SPRINT]);
    if (st.ok && !st.out) { console.log('story-index: los índices de main ya estaban al día'); return 0; }
    const add = git(repo, ['add', '--', EPICS, SPRINT]);
    const ci = add.ok && git(repo, ['commit', '-q', '-m', 'chore(specs): regenerar los índices de historias desde el frontmatter [skip ci]', '--', EPICS, SPRINT]);
    if (!ci || !ci.ok) { console.log(`🔒 story-index: no pude commitear los índices (${(ci && ci.err) || add.err})`); return 1; }
    if (beforePush) spawnSync(beforePush, { windowsHide: true, cwd: repo, shell: true, stdio: 'ignore' });
    const push = git(repo, ['push', '-q', remote, 'HEAD:main']);
    if (push.ok) { console.log(`story-index: índices regenerados y empujados a ${remote}/main`); return 0; }
    console.log(`story-index: el empuje chocó (intento ${i} de ${TRIES}): traigo main y regenero de nuevo`);
  }
  console.log(`🔒 story-index: no pude empujar los índices en ${TRIES} intentos: main queda como estaba, y el próximo merge los regenera`);
  return 1;
}

// ── la migración ───────────────────────────────────────────────────────────────────────────────

/**
 * Los renglones de historia de un `sprint-status.yaml` escrito a mano: `[{ key, ids, status, note }]`. `ids` son las
 * lecturas posibles de la clave: en `8-17-1-foo` el `1` puede ser parte del id (`8.17.1`, slug `foo`) o del slug
 * (`8.17`, slug `1-foo`); cada una trae su `id` y su `slug`.
 */
function oldEntries(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    // `\d+-[^\s:#]+` y no `\d+(?:-[^\s:#]+)+`: el guion entra en los dos lados y anidarlos retrocede sin fin
    const m = /^\s*(\d+-[^\s:#]+)\s*:\s*([^\s#]+)\s*(?:#\s*(.*))?$/.exec(line);
    if (!m) continue;
    const parts = m[1].split('-');
    let run = 0;
    while (run < parts.length && /^\d+$/.test(parts[run])) run++;
    if (run < 2) continue;
    const ids = [];
    for (let k = 2; k <= run; k++) ids.push({ id: parts.slice(0, k).join('.'), slug: parts.slice(k).join('-') });
    out.push({ key: m[1], ids, status: m[2].replace(/^["']|["']$/g, ''), note: (m[3] || '').trim() });
  }
  return out;
}

/** Suma un renglón al principio del Change Log de una historia (lo crea si no está), con los finales de renglón del archivo. */
function addToChangeLog(abs, line) {
  const text = fs.readFileSync(abs, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const head = `${eol}## Change Log${eol}`;
  const at = text.indexOf(head);
  if (at < 0) { fs.writeFileSync(abs, `${text.replace(/(\r?\n)*$/, eol)}${eol}## Change Log${eol}${eol}${line}${eol}`); return; }
  const start = at + head.length;
  const rest = text.slice(start).replace(/^(\r?\n)*/, '');
  fs.writeFileSync(abs, `${text.slice(0, start)}${eol}${line}${eol}${rest}`);
}

function migrate(repo, report, date) {
  let old = '';
  // sin el archivo no hay nada que migrar; uno que está y no se lee no es un índice vacío
  try { old = fs.readFileSync(path.join(repo, SPRINT), 'utf8'); } catch (e) {
    if (!e || e.code !== 'ENOENT') {
      console.log(`🔒 story-index: no migro: ${SPRINT} está y no se puede leer (${(e && e.code) || e})`);
      return 1;
    }
  }
  const entries = oldEntries(old);
  const c = collect(repo);
  if (c.problems.length) {
    for (const p of c.problems) console.log(`   ${p}`);
    console.log('🔒 story-index: no migro: hay historias que no se pueden leer (arriba la ruta)');
    return 1;
  }
  const byId = new Map(c.stories.map((s) => [fullId(s), s]));
  const distintas = [];
  const sinArchivo = [];
  const ambiguas = [];
  const conNota = [];
  const invalidas = [];
  for (const e of entries) {
    // la clave arma un nombre de archivo: con una barra o un `..` saldría de specs/, y no se toca
    if (/[/\\]|(^|-)\.\.?(-|$)/.test(e.key)) { invalidas.push(e); continue; }
    // la lectura de la clave que coincide con una historia existente; sin ninguna, sólo vale una clave sin dudas
    const found = e.ids.filter((x) => byId.has(x.id));
    if (found.length === 1) {
      const s = byId.get(found[0].id);
      if (s.status !== e.status) distintas.push({ e, s });
      if (e.note) conNota.push({ s, note: e.note });
      continue;
    }
    if (found.length === 0 && e.ids.length === 1) { sinArchivo.push({ ...e, ...e.ids[0] }); continue; }
    ambiguas.push(e);
  }
  // ninguna historia mínima pisa un archivo que ya está: se mira todo antes de escribir nada
  const minima = (e) => `${SPECS}/story-${e.id}${e.slug ? `-${e.slug}` : ''}.md`;
  const ocupados = sinArchivo.filter((e) => fs.existsSync(path.join(repo, minima(e))));
  if (ocupados.length) {
    for (const e of ocupados) console.log(`   ${minima(e)}: ya existe y no es la historia ${e.id}`);
    console.log('🔒 story-index: no migro: la historia mínima de un renglón sin archivo pisaría un archivo que ya está (arriba la ruta)');
    return 1;
  }
  for (const { s, note } of conNota) addToChangeLog(path.join(repo, s.rel), `- ${date}: nota de su renglón en sprint-status.yaml, al pasar los índices a generados: ${note}`);
  for (const e of sinArchivo) {
    const epic = e.id.split('.')[0];
    const title = e.slug ? e.slug.replace(/-/g, ' ') : e.id;
    const note = e.note ? ` Nota de su renglón en sprint-status.yaml: ${e.note}` : '';
    fs.writeFileSync(path.join(repo, minima(e)), [
      '---', `epic: ${epic}`, `story: "${e.id}"`, `title: ${JSON.stringify(title)}`, `status: ${e.status}`, 'minimal: true', '---', '',
      `# Story ${e.id}: ${title}`, '', 'Historia mínima: reserva su número. No tiene criterios todavía.', '',
      '## Change Log', '', `- ${date}: creada al pasar los índices a generados: era un renglón de sprint-status.yaml sin archivo.${note}`, '',
    ].join('\n'));
  }
  const lines = [
    `# Migración de los índices de historias a generados (${date})`, '',
    `Renglones de historia en el sprint-status.yaml escrito a mano: ${entries.length}. Con el estado distinto del de su`,
    `historia: ${distintas.length} (gana el frontmatter). Sin archivo: ${sinArchivo.length} (cada uno pasa a una historia`,
    `mínima). Ambiguos: ${ambiguas.length} (no se tocan: los decide una persona).`, '',
    '## Estado distinto (gana el frontmatter)', '',
    ...(distintas.length ? distintas.map(({ e, s }) => `- \`${e.key}\`: el índice decía ${e.status}; el frontmatter dice ${s.status} (\`${s.rel}\`)`) : ['- ninguna']), '',
    '## Sin archivo (pasan a historia mínima)', '',
    ...(sinArchivo.length ? sinArchivo.map((e) => `- \`${e.key}\`: ${e.status}${e.note ? ` — ${e.note}` : ''}`) : ['- ninguna']), '',
    '## Ambiguos (no se tocan)', '',
    ...(ambiguas.length ? ambiguas.map((e) => `- \`${e.key}\`: ${e.status} — la clave es ambigua: puede ser ${e.ids.map((x) => x.id).join(' o ')}${e.note ? ` (${e.note})` : ''}`) : ['- ninguno']), '',
    '## Claves que no van en un nombre de archivo (no se tocan)', '',
    ...(invalidas.length ? invalidas.map((e) => `- \`${e.key}\`: ${e.status} — tiene una barra o un «..»: no va en un nombre de archivo`) : ['- ninguna']), '',
  ];
  fs.mkdirSync(path.dirname(path.resolve(repo, report)), { recursive: true });
  fs.writeFileSync(path.resolve(repo, report), lines.join('\n'));
  const b = build(repo);
  if (b.problems.length) { for (const p of b.problems) console.log(`   ${p}`); console.log('🔒 story-index: migré pero no pude regenerar los índices'); return 1; }
  writeFiles(repo, b.files);
  console.log(`story-index: migración hecha: ${distintas.length} con estado distinto, ${sinArchivo.length} historias mínimas, ${ambiguas.length} ambiguas; informe en ${report}`);
  return 0;
}

// ── la línea de comandos ───────────────────────────────────────────────────────────────────────

function arg(argv, flag) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; }

function main(argv) {
  const repoArg = arg(argv, '--repo');
  if (!repoArg) { console.error('uso: story-index.js --repo <dir> (--write | --check | --guard | --regenerate-on-main | --migrate --report <archivo>)'); return 2; }
  const repo = path.resolve(repoArg);
  if (argv.includes('--mode')) {
    const m = modeOf(repo, arg(argv, '--team-repos'));
    if (m.unreadable) { console.log(`manual\n⚠️ story-index: ${m.unreadable}: tomo «manual»`); return 0; }
    console.log(m.mode);
    return 0;
  }
  if (argv.includes('--guard')) return guard(repo, arg(argv, '--team-repos'));
  if (argv.includes('--regenerate-on-main')) return regenerateOnMain(repo, { remote: arg(argv, '--remote') || 'origin', beforePush: arg(argv, '--before-push') || null });
  if (argv.includes('--migrate')) {
    const report = arg(argv, '--report');
    if (!report) { console.error('story-index.js --migrate: falta --report <archivo>'); return 2; }
    return migrate(repo, report, arg(argv, '--date') || new Date().toISOString().slice(0, 10));
  }
  const write = argv.includes('--write');
  if (!write && !argv.includes('--check')) { console.error('story-index.js: falta --write o --check'); return 2; }
  const b = build(repo);
  if (b.problems.length) {
    for (const p of b.problems) console.log(`   ${p}`);
    console.log(`🔒 story-index: no ${write ? 'escribí' : 'puedo comparar'} los índices: hay historias que no se pueden leer (arriba la ruta y el motivo)`);
    return 1;
  }
  if (write) { writeFiles(repo, b.files); console.log(`story-index: ${EPICS} y ${SPRINT} generados`); return 0; }
  const diff = differences(repo, b.files);
  if (!diff.length) { console.log('story-index: los índices están al día'); return 0; }
  for (const l of diff) console.log(l);
  console.log(`story-index: los índices no están al día: ${SELF} --repo ${repo} --write`);
  return 1;
}

module.exports = { build, buildFromIndex, handWritten, collect, render, readIntro, keyOf, slugOf, writeFiles, differences, guard, regenerateOnMain, migrate, oldEntries, EPICS, SPRINT, INTRO };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
