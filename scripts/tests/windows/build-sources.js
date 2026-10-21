#!/usr/bin/env node
'use strict';
/**
 * build-sources.js — los DOS repos internos del arnés, entregados como bundles de git para el ensayo en Windows
 * (los escenarios `onboarding` y `update`). Corre en el trabajo de Linux del pipeline.
 *
 * POR QUÉ EXISTE. El escenario `measure` instala la copia pública, que es un solo repo. El equipo se instala distinto:
 * con sus dos repos internos (el arnés y agent-skills), clonados cada uno en su lugar. Para ensayar eso en un agente
 * Windows —el alta de un dev nuevo, y una máquina instalada el viernes que se actualiza a lo de hoy— el agente tiene
 * que CLONAR los dos repos (un clon aplica la conversión de finales de línea; una copia de archivos la esconde) y
 * poder TRAER una versión nueva, como lo hace una sesión al arrancar. Un bundle es un repo entero en un archivo:
 * viaja como artefacto y, del lado de Windows, se vuelve el «remoto» del laboratorio. Así el agente no necesita
 * ninguna credencial ni sale a la red del equipo.
 *
 * QUÉ ENTREGA en <output>, por cada repo, un bundle con tres ramas y nada más:
 *   main     el commit que se ensaya («hoy»): el pedido con --harness-ref / --skills-ref, o `origin/main`
 *   friday   el commit de la marca del viernes (--friday-tag): desde dónde arranca el escenario `update`
 *   base     el «antes» de lo que se ensaya: el antepasado común con la rama principal (`origin/main`). De ahí arranca
 *            «el clon que ya existía» del escenario `portable`: un dev parado en la rama principal que trae el cambio con
 *            su `git pull`. Si lo que se ensaya ES la rama principal no hay un antes propio, y `base` es el viernes.
 * y `sources-info.json`: qué commits son, cuántos hay entre uno y otro, si «hoy» desciende del viernes (si no, una
 * actualización sin reescribir historia no puede llegar) y qué archivos se borraron o renombraron en el medio.
 *
 * Uso: node scripts/tests/windows/build-sources.js --output <carpeta> --harness <clon> --skills <clon>
 *        [--harness-ref <commit o rama>] [--skills-ref <commit o rama>] [--friday-tag <marca>]
 * Una rama se puede pedir por su nombre: si no está como rama local, se busca como `origin/<rama>`.
 *
 * UN SOLO REPO (`--single-repo`, sin `--skills`): el árbol publicado es un repo, con las skills adentro, y un agente lo
 * trae con `HEAD` suelto en el commit que se le pidió. Sale un solo bundle (`harness.bundle`); «hoy» es ESE commit
 * (`HEAD`), nunca la rama principal, que sólo sirve para calcular `base`; y la marca es opcional (una etiqueta o un
 * commit de ese repo): sin ella el bundle no trae la rama `friday`, y `base` sólo existe si lo que se ensaya no es la
 * rama principal. `sources-info.json` lo dice con `single_repo: true` y no trae `skills`.
 *
 * Un bundle que no se puede clonar no se entrega: después de armarlo se clona acá, que es lo que va a hacer el agente
 * (un clon recortado, sin su historia, deja un bundle que pasa `git bundle verify` y no se clona).
 *
 * SALIDAS: 0 los dos bundles quedaron y se verificaron · 1 no pude armarlos (dice por qué) · 2 uso.
 * Sin red. No escribe en ninguno de los dos clones: sólo lee sus objetos de git.
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');

const DEFAULT_FRIDAY = 'retorno/2026-10-02-fin-del-viernes';
const DEFAULT_REFS = ['origin/main', 'main', 'HEAD'];
const RENAMES_CAP = 200;

/** El ambiente de git de este guion: sin el git de quien lo lanza y sin preguntas. */
function gitEnv(base = process.env) {
  const env = Object.assign({}, base);
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) L.setEnv(env, k, null);
  L.setEnv(env, 'GIT_TERMINAL_PROMPT', '0');
  return env;
}
function git(dir, args, { env, cap = 200000 } = {}) {
  return L.run('git', ['-C', dir, ...args], { env, timeoutMs: 10 * 60 * 1000, cap });
}

/** El commit de una referencia, probando las formas en que puede estar en ese clon. `{ sha, as }` o `null`. */
function resolveRef(dir, ref, env) {
  for (const candidate of [ref, `origin/${ref}`, `refs/tags/${ref}`]) {
    // `--end-of-options`: lo que viene es una referencia aunque empiece con guion (llega de un parámetro del pipeline)
    const r = git(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${candidate}^{commit}`], { env });
    const sha = String(r.stdout || '').split('\n').map((l) => l.trim()).find((l) => /^[0-9a-f]{40,64}$/.test(l));
    if (r.exit === 0 && sha) return { sha, as: candidate };
    // «no existe» sale 1 y callado. Cualquier otra cosa (no es un repo, git no arrancó, venció) es «no pude preguntar»:
    // no se contesta `null`, que quien llama leería como «no existe»
    if (r.error || r.exit !== 1) return { error: `no pude preguntar por «${candidate}» en ${dir}: git rev-parse ${r.error || `salió ${r.exit}`}${L.firstLine(r.stderr) ? ` — ${L.firstLine(r.stderr)}` : ''}` };
  }
  return null;
}
/** La primera de esas referencias que exista: `{ sha, as }`, `null` si ninguna, o `{ error }` si git no pudo contestar. */
function firstRef(dir, refs, env) {
  for (const ref of refs) {
    const r = resolveRef(dir, ref, env);
    if (r) return r;
  }
  return null;
}
/** ¿El clon está recortado (sin su historia)? `{ shallow }`, o `{ problem }` si git no lo pudo decir (que no es «no»). */
function isShallow(dir, env) {
  const r = git(dir, ['rev-parse', '--is-shallow-repository'], { env });
  const said = L.firstLine(r.stdout);
  if (r.error || r.exit !== 0 || !['true', 'false'].includes(said)) return { problem: `no pude saber si ${dir} está recortado: git rev-parse ${r.error || `salió ${r.exit}`}${L.firstLine(r.stderr) ? ` — ${L.firstLine(r.stderr)}` : ''}` };
  return { shallow: said === 'true' };
}

/**
 * Arma el bundle de un repo. Devuelve `{ ok, reason, info }`; `info` es lo que va a `sources-info.json`.
 * Los objetos se traen a un repo de trabajo propio (nunca se escribe en el clon de origen).
 */
function bundleOne({ name, source, ref, fridayTag, output, work, env, singleRepo = false }) {
  if (!source || !fs.existsSync(source)) return { ok: false, reason: `${name}: no encuentro el clon ${source || '(falta la ruta)'}` };
  if (git(source, ['rev-parse', '--git-dir'], { env }).exit !== 0) return { ok: false, reason: `${name}: ${source} no es un repo de git` };
  // un clon recortado no trae los padres de sus commits: el bundle se arma, pasa `git bundle verify` y después no se
  // puede clonar. Se dice acá, con su motivo, antes de armar nada.
  const cut = isShallow(source, env);
  if (cut.problem) return { ok: false, reason: `${name}: ${cut.problem}` };
  if (cut.shallow) return { ok: false, reason: `${name}: ${source} es un clon recortado (sin su historia): un bundle armado desde ahí no se puede clonar — hay que traerlo entero` };
  // «hoy»: lo pedido; si no se pidió nada, la rama principal. Con un solo repo (el árbol que trajo un agente, con HEAD
  // suelto en el commit pedido) es ESE commit, nunca la rama principal: si no, se ensayaría otro árbol que el traído.
  const target = ref ? resolveRef(source, ref, env) : firstRef(source, singleRepo ? ['HEAD'] : DEFAULT_REFS, env);
  if (target && target.error) return { ok: false, reason: `${name}: ${target.error}` };
  if (!target) return { ok: false, reason: `${name}: no encuentro ${ref ? `la referencia «${ref}»` : (singleRepo ? 'HEAD' : 'origin/main, main ni HEAD')} en ${source}` };
  // la marca: con dos repos hace falta siempre; con uno solo es opcional (sólo la usa el escenario `update`, y como
  // «antes» de `portable` cuando lo que se ensaya es la rama principal)
  const friday = fridayTag ? resolveRef(source, fridayTag, env) : null;
  if (friday && friday.error) return { ok: false, reason: `${name}: ${friday.error}` };
  if (fridayTag && !friday) return { ok: false, reason: singleRepo ? `${name}: no encuentro «${fridayTag}» en ${source}: tiene que ser una marca o un commit de ese repo` : `${name}: no encuentro la marca «${fridayTag}» en ${source} (¿se trajeron las etiquetas? git fetch --tags)` };
  if (!friday && !singleRepo) return { ok: false, reason: `${name}: falta la marca del viernes (--friday-tag)` };
  // la rama principal, para calcular el «antes». `HEAD` queda de último recurso: si se llega a él, la rama principal
  // no se encontró (se llama distinto, o el clon no la trae), y eso se dice
  const mainline = firstRef(source, DEFAULT_REFS, env);
  if (mainline && mainline.error) return { ok: false, reason: `${name}: ${mainline.error}` };
  const mainlineFound = Boolean(mainline) && mainline.as !== 'HEAD';

  const stage = path.join(work, `${name}.git`);
  fs.rmSync(stage, { recursive: true, force: true });
  let r = L.run('git', ['init', '--quiet', '--bare', stage], { env, timeoutMs: 60000 });
  if (r.exit !== 0) return { ok: false, reason: `${name}: git init salió ${r.error || r.exit}: ${L.firstLine(r.stderr)}` };
  // todo lo que el clon de origen conoce, a un espacio aparte: de ahí salen los dos commits, estén donde estén
  r = git(stage, ['fetch', '--quiet', '--no-tags', source, '+refs/heads/*:refs/import/heads/*', '+refs/remotes/*:refs/import/remotes/*', '+refs/tags/*:refs/import/tags/*', '+HEAD:refs/import/head'], { env });
  if (r.exit !== 0) return { ok: false, reason: `${name}: no pude traer los objetos de ${source}: ${L.firstLine(r.stderr) || r.error || r.exit}` };
  // el «antes»: el antepasado común entre lo que se ensaya y la rama principal. Sin uno propio (lo que se ensaya es la
  // rama principal, o no comparten historia), el viernes.
  const common = mainline ? git(stage, ['merge-base', target.sha, mainline.sha], { env }) : null;
  // `merge-base` sale 1 cuando no hay historia en común; otra salida es que git no pudo contestar
  if (common && (common.error || ![0, 1].includes(common.exit))) return { ok: false, reason: `${name}: no pude calcular el antepasado común con ${mainline.as}: git merge-base ${common.error || `salió ${common.exit}`}${L.firstLine(common.stderr) ? ` — ${L.firstLine(common.stderr)}` : ''}` };
  const shared = common && common.exit === 0 && /^[0-9a-f]{40,64}$/.test(L.firstLine(common.stdout)) ? L.firstLine(common.stdout) : null;
  // por qué no hay un «antes» propio: no siempre es «lo que se ensaya es la rama principal»
  const why = !mainlineFound ? 'no se encontró la rama principal (ni origin/main ni main)'
    : (shared ? 'lo que se ensaya ya está en la rama principal' : 'sin historia en común con la rama principal');
  // sin un «antes» propio, la marca; y sin marca (sólo con un repo), ninguno: no se inventa, y se dice por qué
  const base = mainlineFound && shared && shared !== target.sha
    ? { sha: shared, from: `el antepasado común con ${mainline.as}` }
    : (friday ? { sha: friday.sha, from: `la marca del viernes (${why})` } : null);
  const noBase = base ? null : `${why}, y no se pasó una marca`;
  const branches = [['main', target.sha], ...(friday ? [['friday', friday.sha]] : []), ...(base ? [['base', base.sha]] : [])];
  for (const [branch, sha] of branches) {
    if (git(stage, ['cat-file', '-e', `${sha}^{commit}`], { env }).exit !== 0) return { ok: false, reason: `${name}: el commit ${sha.slice(0, 10)} (${branch}) no llegó al repo de trabajo` };
    r = git(stage, ['update-ref', `refs/heads/${branch}`, sha], { env });
    if (r.exit !== 0) return { ok: false, reason: `${name}: no pude fijar la rama ${branch}: ${L.firstLine(r.stderr)}` };
  }
  git(stage, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { env });
  const file = path.join(output, `${name}.bundle`);
  fs.rmSync(file, { force: true });
  const refuse = (reason) => { fs.rmSync(file, { force: true }); return { ok: false, reason }; };
  r = git(stage, ['bundle', 'create', '--quiet', file, 'HEAD', ...branches.map(([branch]) => `refs/heads/${branch}`)], { env });
  if (r.exit !== 0 || !fs.existsSync(file)) return refuse(`${name}: git bundle create salió ${r.error || r.exit}: ${L.firstLine(r.stderr)}`);
  r = git(stage, ['bundle', 'verify', '--quiet', file], { env });
  if (r.exit !== 0) return refuse(`${name}: el bundle no verifica: ${L.firstLine(r.stderr)}`);
  // la prueba que vale es la que va a hacer el agente: clonarlo. `git bundle verify` da por bueno un bundle al que le
  // faltan objetos que el repo donde se verifica tampoco tiene.
  const probe = path.join(work, `${name}-clone-check.git`);
  r = L.run('git', ['clone', '--quiet', '--bare', file, probe], { env, timeoutMs: 10 * 60 * 1000 });
  fs.rmSync(probe, { recursive: true, force: true });
  if (r.error || r.exit !== 0) return refuse(`${name}: el bundle no se puede clonar (git clone salió ${r.error || r.exit}: ${L.firstLine(r.stderr)})`);

  // «¿hoy desciende de…?»: `merge-base --is-ancestor` sale 0 (sí) o 1 (no); otra salida es que git no pudo contestar,
  // y eso no se anota como «no desciende»
  const descends = (sha, what) => {
    const x = git(stage, ['merge-base', '--is-ancestor', sha, target.sha], { env });
    if (x.error || ![0, 1].includes(x.exit)) return { problem: `no pude saber si lo que se ensaya desciende ${what}: git merge-base ${x.error || `salió ${x.exit}`}${L.firstLine(x.stderr) ? ` — ${L.firstLine(x.stderr)}` : ''}` };
    return { yes: x.exit === 0 };
  };
  const fromFriday = friday ? descends(friday.sha, 'de la marca') : null;
  const fromBase = base ? descends(base.sha, 'del «antes»') : null;
  for (const d of [fromFriday, fromBase]) if (d && d.problem) return refuse(`${name}: ${d.problem}`);
  const count = friday ? git(stage, ['rev-list', '--count', `${friday.sha}..${target.sha}`], { env }) : null;
  const sinceBase = base ? git(stage, ['rev-list', '--count', `${base.sha}..${target.sha}`], { env }) : null;
  // lo que se borró o cambió de nombre entre el viernes y hoy: un hook registrado el viernes puede apuntar ahí
  const diff = friday ? git(stage, ['diff', '--name-status', '-M', '--diff-filter=DR', friday.sha, target.sha], { env, cap: 4 * 1024 * 1024 }) : null;
  const moved = diff && diff.exit === 0 ? diff.stdout.split('\n').filter(Boolean).map((l) => { const [status, from, to] = l.split('\t'); return to ? { status: status[0], from, to } : { status: status[0], from }; }) : null;
  return {
    ok: true,
    info: {
      bundle: `${name}.bundle`, bytes: fs.statSync(file).size,
      target: target.sha, target_ref: ref || target.as, friday: friday ? friday.sha : null, friday_tag: fridayTag || null,
      commits_between: count && count.exit === 0 ? Number(L.firstLine(count.stdout)) : null,
      friday_is_ancestor: fromFriday ? fromFriday.yes : null,
      base: base ? base.sha : null, base_from: base ? base.from : null, no_base_reason: noBase, commits_since_base: sinceBase && sinceBase.exit === 0 ? Number(L.firstLine(sinceBase.stdout)) : null,
      base_is_ancestor: fromBase ? fromBase.yes : null,
      removed_or_renamed: moved ? { total: moved.length, first: moved.slice(0, RENAMES_CAP) } : null,
    },
  };
}

/**
 * Arma los bundles. Con `singleRepo` (el árbol publicado: UN repo, con las skills adentro, tal como lo trajo un agente)
 * sale un solo bundle, `harness.bundle`: «hoy» es `HEAD` de ese clon, la marca es opcional (sin ella el bundle no trae
 * la rama `friday`) y `sources-info.json` lo dice con `single_repo: true` y sin `skills`.
 */
function build({ output, harness, skills, harnessRef = null, skillsRef = null, singleRepo = false, fridayTag = singleRepo ? null : DEFAULT_FRIDAY, env = gitEnv() }) {
  try { fs.mkdirSync(output, { recursive: true }); } catch (e) { return { ok: false, reason: `no pude crear ${output}: ${e.code || e.message}` }; }
  const work = path.join(output, '.work');
  // Lo que este guion entrega. Se borra AL ENTRAR —una corrida que falla temprano no deja en la carpeta la entrega de
  // una corrida anterior, que es de otro commit— y otra vez en cada fallo: o están los bundles con su información, o
  // no hay nada.
  const DELIVERED = ['harness.bundle', 'agent-skills.bundle', 'sources-info.json'];
  const wipe = () => { for (const f of DELIVERED) fs.rmSync(path.join(output, f), { force: true }); };
  const refuse = (reason) => { try { wipe(); } catch (e) { return { ok: false, reason: `${reason} — y no pude limpiar ${output}: ${e.code || e.message}` }; } return { ok: false, reason }; };
  try { wipe(); } catch (e) { return { ok: false, reason: `no pude limpiar la entrega anterior de ${output}: ${e.code || e.message}` }; }
  const info = { schema: L.SCHEMA, made_by: 'scripts/tests/windows/build-sources.js', at: L.nowIso(), friday_tag: fridayTag || null };
  if (singleRepo) info.single_repo = true;
  // En el repo unido ~/.claude/agent-skills es un enlace al propio arnés: ese «agent-skills» no trae la marca
  // del viernes de agent-skills (una etiqueta con ese nombre, ahí, es la del arnés) y el ensayo saldría con dos copias del
  // mismo repo sin decirlo. Las dos fuentes tienen que ser dos repos.
  const realGitDir = (dir) => { const r = git(dir, ['rev-parse', '--git-common-dir'], { env }); try { return r.exit === 0 ? fs.realpathSync(path.resolve(dir, L.firstLine(r.stdout))) : null; } catch (e) { return null; } };
  if (!singleRepo) {
    const hd = realGitDir(harness); const sd = realGitDir(skills);
    // sin poder preguntarle a git no se sabe si son dos repos: eso frena, no pasa como «son distintos»
    if (!hd || !sd) return { ok: false, reason: `no pude leer la carpeta de git de ${!hd ? `--harness (${harness})` : `--skills (${skills})`}: sin eso no sé si son dos repos` };
    if (hd === sd) return { ok: false, reason: `--skills (${skills}) es el mismo repo que --harness (${harness}): hace falta el clon de agent-skills de antes de la unión, no un enlace al arnés` };
  }
  try {
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const repos = singleRepo ? [['harness', 'harness', harness, harnessRef]] : [['harness', 'harness', harness, harnessRef], ['agent-skills', 'skills', skills, skillsRef]];
    for (const [name, key, source, ref] of repos) {
      const r = bundleOne({ name, source, ref, fridayTag, output, work, env, singleRepo });
      if (!r.ok) return refuse(r.reason);
      info[key] = r.info;
    }
    L.writeJsonAtomic(path.join(output, 'sources-info.json'), info);
    return { ok: true, info };
  } catch (e) {
    return refuse(`el guion tiró: ${e.message}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function main(argv) {
  const args = L.parseArgs(argv, { '--output': 'value', '--harness': 'value', '--skills': 'value', '--harness-ref': 'value', '--skills-ref': 'value', '--friday-tag': 'value', '--single-repo': 'flag' });
  const single = args['single-repo'] === true;
  const usage = args.problem
    || (single && (args.skills || args['skills-ref']) ? '--single-repo es un solo repo, con las skills adentro: no va con --skills ni con --skills-ref' : null)
    || (!args.output || !args.harness || (!single && !args.skills) ? 'faltan --output <carpeta>, --harness <clon> y --skills <clon> (o --single-repo, sin --skills)' : null);
  if (usage) {
    process.stderr.write(`build-sources.js: ${usage}\n`);
    return 2;
  }
  const r = single
    ? build({ output: path.resolve(args.output), harness: path.resolve(args.harness), harnessRef: args['harness-ref'] || null, singleRepo: true, fridayTag: args['friday-tag'] || null })
    : build({ output: path.resolve(args.output), harness: path.resolve(args.harness), skills: path.resolve(args.skills), harnessRef: args['harness-ref'] || null, skillsRef: args['skills-ref'] || null, fridayTag: args['friday-tag'] || DEFAULT_FRIDAY });
  if (!r.ok) { process.stderr.write(`build-sources.js: no pude armar los bundles — ${r.reason}\n`); return 1; }
  for (const key of ['harness', 'skills'].filter((k) => r.info[k])) {
    const i = r.info[key];
    const friday = i.friday ? `viernes ${i.friday.slice(0, 10)} · ${i.commits_between} commit(s) en el medio${i.friday_is_ancestor ? '' : ' · ⚠ hoy NO desciende del viernes'}` : 'sin marca (no hay un viernes del que arrancar)';
    const before = i.base ? `antes ${i.base.slice(0, 10)} (${i.base_from}; ${i.commits_since_base} commit(s))${i.base_is_ancestor ? '' : ' · ⚠ hoy NO desciende del antes'}` : `sin un «antes» (${i.no_base_reason})`;
    process.stdout.write(`build-sources: ${i.bundle} · hoy ${i.target.slice(0, 10)} (${i.target_ref}) · ${friday} · ${before} · ${Math.round(i.bytes / 1024)} KB\n`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { DEFAULT_FRIDAY, resolveRef, firstRef, isShallow, bundleOne, build, gitEnv };
