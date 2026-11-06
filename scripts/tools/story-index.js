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

/** El id completo (con la épica adelante) y la clave de `sprint-status.yaml`: `8.17.1` → `8-17-1-<slug>`. */
function fullId(s) { const id = String(s.id); return id.startsWith(`${s.epic}.`) ? id : `${s.epic}.${id}`; }
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
  try { text = fs.readFileSync(path.join(repo, INTRO), 'utf8'); } catch (_) { return out; }
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
    stories.push({ id: s.id, epic: String(s.epic), title: s.title || '', status: s.status, rel: rel(s.path) });
  }
  const outside = new Set(res.excluded.filter((x) => inSpecs(x.path)).map((x) => rel(x.path)));
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
  return { stories, problems, partial: !!res.partial };
}

const yamlValue = (v) => (/^[\w.-]+$/.test(v) ? v : JSON.stringify(v));
const cell = (v) => String(v).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

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
  return { files: render(c.stories, readIntro(repo)), problems: [] };
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
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
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
    identity = require(path.join(TREE, 'scripts', 'lib', 'platform', 'platform.js')).identityFromRemote(where);
  } catch (e) { return { unreadable: `no pude leer el remoto de ${repo} (${String((e && e.message) || e).split('\n')[0]})` }; }
  if (!identity) return { mode: 'manual' };
  return { mode: TR.storyIndexFor(read.data, identity).mode };
}

function guard(repo, teamReposFile) {
  const m = modeOf(repo, teamReposFile);
  if (m.unreadable) { console.log(`⚠️ story-index: ${m.unreadable}: no sé si los índices son generados, no freno`); return 0; }
  if (m.mode !== 'generated') return 0;
  const staged = git(repo, ['diff', '--cached', '--name-only']);
  if (!staged.ok) { console.log(`⚠️ story-index: no pude leer lo preparado (${staged.err}): no freno`); return 0; }
  const touched = staged.out.split('\n').filter((f) => f === EPICS || f === SPRINT);
  if (!touched.length) return 0;
  const gitDir = git(repo, ['rev-parse', '--git-dir']);
  if (gitDir.ok && fs.existsSync(path.resolve(repo, gitDir.out, 'MERGE_HEAD'))) return 0;
  const branch = git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (branch.ok && branch.out === 'main') return 0;
  const b = build(repo);
  const cmd = `${SELF} --repo ${repo} --write`;
  if (b.problems.length) {
    for (const p of b.problems) console.log(`   ${p}`);
    console.log(`🔒 story-index: preparaste ${touched.join(' y ')}, y no puedo generarlos para compararlos (arriba el motivo). En este repo se generan: arreglá el frontmatter y corré ${cmd}`);
    return 1;
  }
  const distintos = touched.filter((f) => git(repo, ['show', `:${f}`]).out + '\n' !== b.files[f]);
  if (!distintos.length) return 0;
  console.log(`🔒 story-index: ${distintos.join(' y ')} se generan desde el frontmatter y en una rama no se editan a mano. Cambiá el frontmatter de la historia y regeneralos: ${cmd} (después, git add de los dos)`);
  return 1;
}

// ── la regeneración en main ────────────────────────────────────────────────────────────────────

function regenerateOnMain(repo, { remote = 'origin', beforePush = null } = {}) {
  for (let i = 1; i <= TRIES; i++) {
    const f = git(repo, ['fetch', '-q', remote, 'main']);
    if (!f.ok) { console.log(`🔒 story-index: no pude traer ${remote}/main (${f.err}): no regenero`); return 1; }
    const co = git(repo, ['checkout', '-q', '-B', 'main', `${remote}/main`]);
    if (!co.ok) { console.log(`🔒 story-index: no pude ponerme en ${remote}/main (${co.err}): no regenero`); return 1; }
    // un índice que todavía no se migró (sin la cabecera del generado) no se pisa: perdería lo escrito a mano
    let now = null;
    try { now = fs.readFileSync(path.join(repo, SPRINT), 'utf8'); } catch (_) { now = null; }
    if (now !== null && !now.startsWith(SPRINT_HEADER[0])) {
      console.log(`story-index: ${SPRINT} todavía se escribe a mano (no trae la cabecera del generado): no regenero. Para pasarlo a generado: ${SELF} --repo <repo> --migrate --report <archivo>`);
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
    if (beforePush) spawnSync(beforePush, { cwd: repo, shell: true, stdio: 'ignore' });
    const push = git(repo, ['push', '-q', remote, 'HEAD:main']);
    if (push.ok) { console.log(`story-index: índices regenerados y empujados a ${remote}/main`); return 0; }
    console.log(`story-index: el empuje chocó (intento ${i} de ${TRIES}): traigo main y regenero de nuevo`);
  }
  console.log(`🔒 story-index: no pude empujar los índices en ${TRIES} intentos: main queda como estaba, y el próximo merge los regenera`);
  return 1;
}

// ── la migración ───────────────────────────────────────────────────────────────────────────────

/** Los renglones de historia de un `sprint-status.yaml` escrito a mano: `[{ key, id, slug, status, note }]`. */
function oldEntries(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*((\d+(?:-\d+)+)(?:-([^\s:]*?))?)\s*:\s*([^\s#]+)\s*(?:#\s*(.*))?$/.exec(line);
    if (!m) continue;
    out.push({ key: m[1], id: m[2].replace(/-/g, '.'), slug: m[3] || '', status: m[4].replace(/^["']|["']$/g, ''), note: (m[5] || '').trim() });
  }
  return out;
}

function addToChangeLog(abs, line) {
  const text = fs.readFileSync(abs, 'utf8');
  const at = text.indexOf('\n## Change Log\n');
  if (at < 0) { fs.writeFileSync(abs, `${text.replace(/\n*$/, '\n')}\n## Change Log\n\n${line}\n`); return; }
  const start = at + '\n## Change Log\n'.length;
  const rest = text.slice(start).replace(/^\n*/, '');
  fs.writeFileSync(abs, `${text.slice(0, start)}\n${line}\n${rest}`);
}

function migrate(repo, report, date) {
  let old = '';
  try { old = fs.readFileSync(path.join(repo, SPRINT), 'utf8'); } catch (_) { old = ''; }
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
  for (const e of entries) {
    const s = byId.get(e.id);
    if (!s) { sinArchivo.push(e); continue; }
    if (s.status !== e.status) distintas.push({ e, s });
    if (e.note) addToChangeLog(path.join(repo, s.rel), `- ${date}: nota de su renglón en sprint-status.yaml, al pasar los índices a generados: ${e.note}`);
  }
  for (const e of sinArchivo) {
    const epic = e.id.split('.')[0];
    const title = e.slug ? e.slug.replace(/-/g, ' ') : e.id;
    const rel = `${SPECS}/story-${e.id}${e.slug ? `-${e.slug}` : ''}.md`;
    const note = e.note ? ` Nota de su renglón en sprint-status.yaml: ${e.note}` : '';
    fs.writeFileSync(path.join(repo, rel), [
      '---', `epic: ${epic}`, `story: "${e.id}"`, `title: ${JSON.stringify(title)}`, `status: ${e.status}`, 'minimal: true', '---', '',
      `# Story ${e.id}: ${title}`, '', 'Historia mínima: reserva su número. No tiene criterios todavía.', '',
      '## Change Log', '', `- ${date}: creada al pasar los índices a generados: era un renglón de sprint-status.yaml sin archivo.${note}`, '',
    ].join('\n'));
  }
  const lines = [
    `# Migración de los índices de historias a generados (${date})`, '',
    `Renglones de historia en el sprint-status.yaml escrito a mano: ${entries.length}. Con el estado distinto del de su`,
    `historia: ${distintas.length} (gana el frontmatter). Sin archivo: ${sinArchivo.length} (cada uno pasa a una historia mínima).`, '',
    '## Estado distinto (gana el frontmatter)', '',
    ...(distintas.length ? distintas.map(({ e, s }) => `- \`${e.key}\`: el índice decía ${e.status}; el frontmatter dice ${s.status} (\`${s.rel}\`)`) : ['- ninguna']), '',
    '## Sin archivo (pasan a historia mínima)', '',
    ...(sinArchivo.length ? sinArchivo.map((e) => `- \`${e.key}\`: ${e.status}${e.note ? ` — ${e.note}` : ''}`) : ['- ninguna']), '',
  ];
  fs.mkdirSync(path.dirname(path.resolve(repo, report)), { recursive: true });
  fs.writeFileSync(path.resolve(repo, report), lines.join('\n'));
  const b = build(repo);
  if (b.problems.length) { for (const p of b.problems) console.log(`   ${p}`); console.log('🔒 story-index: migré pero no pude regenerar los índices'); return 1; }
  writeFiles(repo, b.files);
  console.log(`story-index: migración hecha: ${distintas.length} con estado distinto, ${sinArchivo.length} historias mínimas; informe en ${report}`);
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

module.exports = { build, collect, render, readIntro, keyOf, slugOf, writeFiles, differences, guard, regenerateOnMain, migrate, oldEntries, EPICS, SPRINT, INTRO };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
