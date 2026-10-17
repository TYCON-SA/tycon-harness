#!/usr/bin/env node
'use strict';
/**
 * union-check.js — ¿el repo unido es lo que dice que es? (story 8.18, tramo 0 · 2026-10-03)
 *
 * POR QUÉ EXISTE. El arnés y agent-skills eran dos repos internos y se unieron en uno, el del arnés, con un
 * `git merge --allow-unrelated-histories` que no reescribe nada. Esa unión tiene cuatro promesas, y ninguna se ve a
 * simple vista en un árbol de tres mil archivos:
 *   · no se perdió ni se reescribió historia: cada punta de las dos historias es ancestro de la unión;
 *   · el árbol es la unión EXACTA de los dos lados, salvo una lista cerrada de excepciones (las tres rutas que se
 *     repetían: el `.gitignore`, el pre-commit y el `README.md`);
 *   · los papeles que acompañan a la unión están (la guía rescatada del README de agent-skills y su cita);
 *   · mientras tres sesiones trabajan en paralelo sobre esa base, ningún archivo lo tocan dos.
 * Este guion las comprueba. Sólo lee: nunca escribe en el repo, ni objetos de git.
 *
 * Uso:
 *   node scripts/tools/union-check.js tree    --harness <commit> --skills <commit> --union <commit>
 *   node scripts/tools/union-check.js history --union <commit> --tips <commit> [<commit>...]
 *   node scripts/tools/union-check.js papers  --base <commit> [--harness <commit> --skills <commit>]
 *   node scripts/tools/union-check.js lanes   --base <ref> [--joined <rama junta>] <rama> <rama> [<rama>...]
 *   Todas aceptan --repo <dir> (por defecto, el repo de este guion).
 *
 *   tree     `--harness` y `--skills` son los dos lados YA COMPUESTOS, antes de resolver los choques. Lo que se espera
 *            de la unión: cada archivo de cada lado en su misma ruta, con el mismo contenido y el mismo modo, y
 *              · `.gitignore`: las líneas de los dos, primero las del arnés y sin repetir —la regla con que el
 *                exportador las junta para la copia pública—, SIN el bloque `.advisors/` de agent-skills (dejaba de
 *                versionar el registro de revisores, y `git add` no avisa);
 *              · `.githooks/pre-commit`: el despachador, con el texto que genera el exportador; el de cada lado pasa
 *                a `pre-commit-harness` y `pre-commit-skills`, byte a byte;
 *              · `README.md`: el del arnés; el de agent-skills no entra.
 *   history  cada `--tips` es ancestro de `--union`. Sirve igual para una re-mezcla: la punta anterior de la base
 *            tiene que seguir siendo ancestro de la nueva (nunca se rebasa).
 *   papers   en `--base`: existe `guides/inactive-skills.md` y el `.gitignore` la cita (ya no al README que no
 *            entró). Con los dos lados, además: `.tycon/post-commit-ignore` es el de agent-skills tal cual, y los
 *            archivos de `.tycon/` del arnés no cambiaron.
 *   lanes    ningún archivo aparece tocado por dos carriles, salvo los compartidos a propósito (la story, `tasks/todo.md`,
 *            `tasks/orden-epica-8.md`, `specs/sprint-status.yaml` y `.engram/**`). De cada rama cuentan los commits que
 *            trae SÓLO ella y que no están en `--base` ni en la rama junta (`--joined`): mezclar la base o la rama junta,
 *            con merge o con avance rápido, no cuenta. Con `--joined` mira además lo que un carril toca y la rama junta
 *            ya trae cambiado por otro. Un commit que traen dos carriles sin pasar por la rama junta se dice.
 *
 * Salidas: 0 = todo en orden · 1 = hay hallazgos, uno por línea, cada uno con su archivo o su commit ·
 * 2 = no pude mirar (un commit que este clon no trae, una opción que falta): nunca es un verde.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { sinGitDelPadre } = require('../lib/clean-git-env.js');

const OWN_REPO = path.resolve(__dirname, '..', '..');
const EXPORTER_PATH = 'scripts/publishing/export.js';
const GITIGNORE = '.gitignore';
const PRE_COMMIT = '.githooks/pre-commit';
const README = 'README.md';
const ADVISORS_LINE = '.advisors/';
const GUIDE = 'guides/inactive-skills.md';
const OLD_CITE = 'README.md §«Skills que no se cargan»';
const POST_COMMIT_IGNORE = '.tycon/post-commit-ignore';
// lo que los tres carriles tocan a propósito (story 8.18, AC 3)
const SHARED_BETWEEN_LANES = Object.freeze({
  files: ['specs/story-8.18-un-solo-repo-interno.md', 'tasks/todo.md', 'tasks/orden-epica-8.md', 'specs/sprint-status.yaml'],
  folders: ['.engram/'],
});

/** «No pude mirar»: sale 2. No es un hallazgo ni un verde. */
class CannotLook extends Error {}

const ENV = sinGitDelPadre();
function run(repo, args, input) {
  return spawnSync('git', ['-C', repo, ...args], { env: ENV, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
}
/** La salida de un git que tiene que andar; si no anda, no se pudo mirar. */
function out(repo, args, input) {
  const r = run(repo, args, input);
  if (r.status !== 0) throw new CannotLook(`git ${args.join(' ')} salió ${r.status === null ? 'sin código' : r.status}: ${String(r.stderr || r.error || '').trim()}`);
  return r.stdout;
}
function commit(repo, ref, option) {
  const r = run(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (r.status !== 0) throw new CannotLook(`${option} «${ref}» no es un commit que este clon traiga`);
  return r.stdout.trim();
}
/** El árbol de un commit: ruta → { mode, sha }. */
function listTree(repo, sha) {
  const tree = new Map();
  for (const entry of out(repo, ['ls-tree', '-r', '-z', sha]).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, , object] = entry.slice(0, tab).split(' ');
    tree.set(entry.slice(tab + 1), { mode, sha: object });
  }
  return tree;
}
const fileText = (repo, sha, file) => out(repo, ['show', `${sha}:${file}`]);
/** El identificador que git le daría a ese texto, sin escribirlo. */
const blobOf = (repo, text) => out(repo, ['hash-object', '--stdin'], text).trim();

// ── las dos reglas con nombre ────────────────────────────────────────────────────────────────────────────────────────

const lines = (text) => text.split('\n').filter((l, i, all) => !(i === all.length - 1 && l === ''));

/** Las líneas de agent-skills sin su bloque `.advisors/`: la línea y los comentarios pegados arriba. */
function withoutAdvisorsBlock(skillsLines) {
  const at = skillsLines.indexOf(ADVISORS_LINE);
  if (at === -1) return skillsLines;
  let from = at;
  while (from > 0 && skillsLines[from - 1].startsWith('#')) from -= 1;
  return [...skillsLines.slice(0, from), ...skillsLines.slice(at + 1)];
}

/**
 * El `.gitignore` del repo unido: la regla de `singleRepoShape()` del exportador (primero las líneas del arnés, después
 * las de agent-skills que el arnés no trae, sin repetir ninguna) sobre agent-skills sin su bloque `.advisors/`.
 */
function unifiedGitignore(harnessText, skillsText) {
  const own = lines(harnessText);
  const added = withoutAdvisorsBlock(lines(skillsText)).filter((l) => !own.includes(l));
  return `${[...new Set([...own, ...added])].join('\n')}\n`;
}

/**
 * El texto del despachador con que se armó la unión. Un commit de la unión no cambia nunca, y el exportador de hoy ya no
 * trae el despachador (el arnés corre un solo control, .githooks/pre-commit-checks): el texto queda acá, fijo. Lo usa
 * `tree` cuando el lado del arnés no trae exportador (un repo de juguete).
 */
const DISPATCHER_AT_UNION = [
  '#!/usr/bin/env bash',
  '# .githooks/pre-commit de la copia pública: un despachador que generó el exportador (transformación merged-hooks).',
  '# La copia junta en un repo los dos del equipo, y cada uno trae su pre-commit: los dos corren SIEMPRE, cada uno en su',
  '# proceso (la salida temprana de uno no saltea al otro), con la raíz del repo como arnés y como agent-skills. El commit',
  '# se crea sólo si pasan los dos.',
  'set -u',
  'raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"',
  'export TYCON_GUIDES_DIR="$raiz" TYCON_SKILLS_DIR="$raiz"',
  'correr() { if [ -x "$1" ]; then "$1"; else bash "$1"; fi; }',
  'fallo=0',
  'correr "$raiz/.githooks/pre-commit-harness" || fallo=1',
  'correr "$raiz/.githooks/pre-commit-skills" || fallo=1',
  'exit "$fallo"',
  '',
].join('\n');

/**
 * El texto del despachador: sin argumento, el de la unión; con un exportador, el que declara su constante
 * PRE_COMMIT_DISPATCHER. Un exportador que no está o que no trae la constante es «no pude mirar».
 */
function dispatcherText(exporter = null) {
  if (exporter === null) return DISPATCHER_AT_UNION;
  let source;
  try { source = fs.readFileSync(exporter, 'utf8'); } catch (e) { throw new CannotLook(`no encontré el exportador (${exporter}): de ahí sale el texto del despachador`); }
  return dispatcherIn(source, exporter);
}
/** El texto del despachador que declara ESE fuente del exportador (el del disco, o el de un commit). */
function dispatcherIn(exporterSource, where) {
  // el fin de línea es del checkout, no del texto: con CRLF (Windows con autocrlf) la constante es la misma
  const source = exporterSource.replace(/\r\n/g, '\n');
  const found = /const PRE_COMMIT_DISPATCHER = \[\n([\s\S]*?)\n\]\.join\('\\n'\);/.exec(source);
  if (!found) throw new CannotLook(`el exportador (${where}) ya no trae PRE_COMMIT_DISPATCHER con la forma de siempre: no sé cuál es el texto del despachador`);
  let parts;
  try { parts = vm.runInNewContext(`[${found[1]}]`, Object.create(null), { timeout: 1000 }); } catch (e) { throw new CannotLook(`no pude leer PRE_COMMIT_DISPATCHER del exportador (${where}): ${e.message}`); }
  if (!Array.isArray(parts) || !parts.every((p) => typeof p === 'string')) throw new CannotLook(`PRE_COMMIT_DISPATCHER del exportador (${where}) no es una lista de líneas`);
  return parts.join('\n');
}

/** Lo que la unión de esos dos lados tiene que traer: ruta → { mode, sha }; y las rutas repetidas que no tienen regla. */
function expectedUnion(repo, harness, skills) {
  const h = listTree(repo, harness);
  const s = listTree(repo, skills);
  const expected = new Map(h);
  const noRule = [];
  for (const [file, entry] of s) {
    if (file === README) continue;
    if ((file === GITIGNORE || file === PRE_COMMIT) && h.has(file)) continue;
    if (expected.has(file)) { noRule.push(file); continue; }
    expected.set(file, entry);
  }
  if (h.has(GITIGNORE) && s.has(GITIGNORE)) {
    const text = unifiedGitignore(fileText(repo, harness, GITIGNORE), fileText(repo, skills, GITIGNORE));
    expected.set(GITIGNORE, { mode: h.get(GITIGNORE).mode, sha: blobOf(repo, text) });
  }
  if (h.has(PRE_COMMIT) && s.has(PRE_COMMIT)) {
    expected.set(`${PRE_COMMIT}-harness`, h.get(PRE_COMMIT));
    expected.set(`${PRE_COMMIT}-skills`, s.get(PRE_COMMIT));
    // El despachador que se espera es el del exportador DE ESE lado del arnés: un commit de la unión no cambia nunca, y
    // comparado contra el exportador de hoy quedaría en rojo para siempre el día que alguien retoque esa constante. Sólo
    // si ese lado no trae exportador (un repo de juguete) vale el de este clon.
    const text = h.has(EXPORTER_PATH)
      ? dispatcherIn(fileText(repo, harness, EXPORTER_PATH), `${harness.slice(0, 8)}:${EXPORTER_PATH}`)
      : dispatcherText();
    expected.set(PRE_COMMIT, { mode: '100755', sha: blobOf(repo, text) });
  }
  return { expected, noRule, harnessFiles: h.size, skillsFiles: s.size };
}

// ── los cuatro subcomandos: cada uno devuelve sus hallazgos (vacío = en orden) y lo que informa ──────────────────────

function checkTree(repo, o) {
  const harness = commit(repo, need(o, 'harness'), '--harness');
  const skills = commit(repo, need(o, 'skills'), '--skills');
  const union = commit(repo, need(o, 'union'), '--union');
  const { expected, noRule, harnessFiles, skillsFiles } = expectedUnion(repo, harness, skills);
  const actual = listTree(repo, union);
  const findings = noRule.map((file) => `sin regla  ${file}  (está en los dos lados y no es una de las tres rutas con regla)`);
  for (const [file, want] of expected) {
    const got = actual.get(file);
    if (!got) findings.push(`falta      ${file}`);
    else if (got.sha !== want.sha) findings.push(`difiere    ${file}  (el contenido no es el esperado)`);
    else if (got.mode !== want.mode) findings.push(`difiere    ${file}  (modo ${got.mode}, se esperaba ${want.mode})`);
  }
  for (const file of actual.keys()) if (!expected.has(file)) findings.push(`sobra      ${file}`);
  return { findings, info: [`árbol de la unión: ${actual.size} archivos · lado del arnés ${harnessFiles} · lado de agent-skills ${skillsFiles} · esperados ${expected.size}`] };
}

function checkHistory(repo, o) {
  const union = commit(repo, need(o, 'union'), '--union');
  if (!o.tips.length) throw new CannotLook('falta --tips <commit> [<commit>...]: las puntas que tienen que ser ancestros');
  const findings = [];
  for (const tip of o.tips) {
    const sha = commit(repo, tip, '--tips');
    const r = run(repo, ['merge-base', '--is-ancestor', sha, union]);
    if (r.status === 1) findings.push(`no es ancestro  ${sha}${sha === tip ? '' : `  (${tip})`}`);
    else if (r.status !== 0) throw new CannotLook(`git merge-base --is-ancestor ${sha} ${union} salió ${r.status}: ${String(r.stderr).trim()}`);
  }
  const count = (ref) => Number(out(repo, ['rev-list', '--count', ref]).trim());
  const parents = out(repo, ['rev-list', '--parents', '-n', '1', union]).trim().split(' ').slice(1);
  const info = [`${o.tips.length} punta(s) miradas · la unión tiene ${count(union)} commits y ${parents.length} padre(s)`];
  if (parents.length === 2 && run(repo, ['merge-base', parents[0], parents[1]]).status === 1) {
    info.push(`dos historias sin relación: ${count(parents[0])} + ${count(parents[1])} commits, más el de la unión`);
  }
  return { findings, info };
}

function checkPapers(repo, o) {
  const base = commit(repo, need(o, 'base'), '--base');
  if (Boolean(o.harness) !== Boolean(o.skills)) throw new CannotLook('--harness y --skills van juntos: son los dos lados de la unión');
  const tree = listTree(repo, base);
  const findings = [];
  if (!tree.has(GUIDE)) findings.push(`falta      ${GUIDE}  (la sección rescatada del README de agent-skills)`);
  if (!tree.has(GITIGNORE)) findings.push(`falta      ${GITIGNORE}`);
  else {
    const text = fileText(repo, base, GITIGNORE);
    if (text.includes(OLD_CITE)) findings.push(`difiere    ${GITIGNORE}  (sigue citando «${OLD_CITE}», un README que no entró)`);
    if (!lines(text).some((l) => l.startsWith('#') && l.includes(GUIDE))) findings.push(`difiere    ${GITIGNORE}  (ningún comentario cita ${GUIDE})`);
  }
  if (o.harness) {
    const same = (file, want, side) => {
      const got = tree.get(file);
      if (!got) findings.push(`falta      ${file}  (estaba en el lado ${side})`);
      else if (got.sha !== want.sha || got.mode !== want.mode) findings.push(`difiere    ${file}  (no es el del lado ${side}, tal cual)`);
    };
    const skills = listTree(repo, commit(repo, o.skills, '--skills'));
    if (!skills.has(POST_COMMIT_IGNORE)) throw new CannotLook(`el lado de agent-skills (${o.skills}) no trae ${POST_COMMIT_IGNORE}`);
    same(POST_COMMIT_IGNORE, skills.get(POST_COMMIT_IGNORE), 'de agent-skills');
    for (const [file, want] of listTree(repo, commit(repo, o.harness, '--harness'))) if (file.startsWith('.tycon/')) same(file, want, 'del arnés');
  }
  return { findings, info: [`papeles de la base ${base.slice(0, 8)}${o.harness ? ', contra los dos lados' : ''}`] };
}

/**
 * Qué es «de un carril». Una rama de git es sólo una punta: después de mezclar la base o la rama junta (con un merge o
 * con un avance rápido, que es lo que `git merge` hace por defecto) trae commits de otros, y por la forma de la historia
 * no se distingue de quién era cada uno. Lo que sí se sabe sin adivinar:
 *   · lo que ya está en la base o en la rama junta (`--joined`) no es trabajo pendiente de ningún carril;
 *   · un commit que trae UN solo carril es de ese carril;
 *   · un commit que traen dos carriles sin haber pasado por la base ni por la rama junta no tiene dueño: se dice.
 * Con eso se miran dos choques: dos carriles que tocaron el mismo archivo cada uno por su lado, y un carril que tocó
 * un archivo que la rama junta ya trae cambiado por otro y él todavía no mezcló. Lo que un carril cambia ENCIMA de lo
 * que ya mezcló no se ve acá: no es un choque de git, y lo mira quien junta. Los merges no cuentan (no son de nadie).
 */
function checkLanes(repo, o) {
  const base = commit(repo, need(o, 'base'), '--base');
  const joined = o.joined === undefined ? null : commit(repo, o.joined, '--joined');
  if (o.rest.length < 2) throw new CannotLook('hacen falta al menos dos ramas de carril para comparar');
  const lanes = o.rest.map((branch) => ({ branch, tip: commit(repo, branch, 'la rama') }));
  const settled = [`^${base}`, ...(joined ? [`^${joined}`] : [])];
  const isShared = (file) => SHARED_BETWEEN_LANES.files.includes(file) || SHARED_BETWEEN_LANES.folders.some((d) => file.startsWith(d));
  const commits = (...revs) => out(repo, ['rev-list', '--no-merges', ...revs]).split('\n').filter(Boolean);
  // las rutas, crudas (-z): con comillas, espacios o letras fuera de ASCII git las escaparía y no se reconocerían
  const filesOf = (sha) => out(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', '--root', '-z', sha]).split('\0').filter(Boolean);

  const bringers = new Map();   // commit → los carriles que lo traen
  for (const { branch, tip } of lanes) for (const sha of commits(tip, ...settled)) bringers.set(sha, [...(bringers.get(sha) || []), branch]);

  const findings = [];
  const sharedCommits = new Map();   // «a y b» → commits
  const touchedBy = new Map();       // archivo → carriles que lo tocaron con commits sólo suyos
  for (const [sha, branches] of bringers) {
    if (branches.length > 1) { const pair = branches.join(' y '); sharedCommits.set(pair, [...(sharedCommits.get(pair) || []), sha]); continue; }
    for (const file of filesOf(sha)) {
      if (isShared(file)) continue;
      const by = touchedBy.get(file) || [];
      if (!by.includes(branches[0])) touchedBy.set(file, [...by, branches[0]]);
    }
  }
  for (const [pair, shas] of sharedCommits) {
    findings.push(`commits compartidos — ${pair} traen ${shas.length} commit(s) que no están ni en la base ni en la rama junta (por ejemplo ${shas[0].slice(0, 8)}): un carril trae lo de otro sólo mezclando la rama junta${joined ? '' : ', y la rama junta se pasa con --joined'}`);
  }
  const byName = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
  for (const [file, branches] of [...touchedBy].sort(byName)) if (branches.length > 1) findings.push(`${file} — lo tocan: ${branches.join(' y ')}`);
  if (joined) {
    for (const { branch, tip } of lanes) {
      const pending = new Set(commits(joined, `^${base}`, `^${tip}`).flatMap(filesOf).filter((f) => !isShared(f)));
      for (const [file, branches] of [...touchedBy].sort(byName)) {
        if (branches.includes(branch) && pending.has(file)) findings.push(`${file} — lo tocan: ${branch} y la rama junta (que ${branch} todavía no mezcló)`);
      }
    }
  }
  return { findings, info: [`${lanes.length} ramas contra la base ${base.slice(0, 8)}${joined ? ` y la rama junta ${joined.slice(0, 8)}` : ''} · ${touchedBy.size} archivo(s) tocados fuera de los compartidos`] };
}

// ── la línea de comandos ─────────────────────────────────────────────────────────────────────────────────────────────

const COMMANDS = { tree: checkTree, history: checkHistory, papers: checkPapers, lanes: checkLanes };
const VALUE_OPTIONS = ['repo', 'harness', 'skills', 'union', 'base', 'joined'];

function need(o, name) {
  if (!o[name]) throw new CannotLook(`falta --${name} <commit>`);
  return o[name];
}

function parse(argv) {
  const o = { command: argv[0], tips: [], rest: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tips') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o.tips.push(argv[++i]);
    } else if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!VALUE_OPTIONS.includes(name)) throw new CannotLook(`no conozco la opción ${a}`);
      if (i + 1 >= argv.length) throw new CannotLook(`${a} lleva un valor`);
      // un valor vacío (una variable de shell sin nada) no es «no me lo pasaron»: sería mirar menos sin decirlo
      if (argv[i + 1] === '') throw new CannotLook(`${a} llegó vacío`);
      o[name] = argv[++i];
    } else o.rest.push(a);
  }
  return o;
}

function main(argv) {
  try {
    const o = parse(argv);
    const check = Object.prototype.hasOwnProperty.call(COMMANDS, o.command) ? COMMANDS[o.command] : null;
    if (!check) throw new CannotLook(`${o.command ? `no conozco el subcomando «${o.command}»` : 'falta el subcomando'}: los que hay son ${Object.keys(COMMANDS).join(', ')}`);
    if (o.command !== 'lanes' && o.rest.length) throw new CannotLook(`sobra «${o.rest[0]}»: ${o.command} no lleva argumentos sueltos`);
    const { findings, info } = check(path.resolve(o.repo || OWN_REPO), o);
    for (const line of info) process.stdout.write(`▸ ${o.command}: ${line}\n`);
    if (!findings.length) { process.stdout.write(`✅ ${o.command}: en orden\n`); return 0; }
    for (const line of findings) process.stdout.write(`  ${line}\n`);
    process.stdout.write(`⛔ ${o.command}: ${findings.length} hallazgo(s)\n`);
    return 1;
  } catch (e) {
    if (!(e instanceof CannotLook)) throw e;
    process.stderr.write(`⛔ union-check: no pude mirar — ${e.message}\n`);
    return 2;
  }
}

module.exports = { unifiedGitignore, dispatcherText, expectedUnion, SHARED_BETWEEN_LANES };

if (require.main === module) process.exit(main(process.argv.slice(2)));
