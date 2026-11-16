#!/usr/bin/env node
'use strict';
/**
 * own-copy.js — la copia de trabajo propia de una historia, cuando hay otra sesión viva en el checkout.
 *
 * `pipeline.js start` no la crea: con otra sesión en el checkout se pausa (`PIPE-C6-own-copy`) sin escribir nada y
 * devuelve este comando. La sesión lo corre, se pasa a la copia y vuelve a correr `start` desde ahí.
 *
 * Qué hace, en orden:
 *   1. Se niega en el arnés público y en `agent-skills` (`sinCopiaPropia`): ahí una sola sesión toca git a la vez
 *      (guides/git-worktrees.md §1). Sale 2.
 *   2. Trae `main` de `origin`, una vez. Si falla, sale 1.
 *   3. Elige de dónde nace la copia: `origin/main` si la historia está ahí con el mismo contenido que en el checkout; si
 *      no, el commit de `HEAD` del checkout (resuelto ahí: la copia se crea desde la carpeta principal) si la historia
 *      está commiteada en él con ese contenido. Si la historia está sin commitear o cambiada, no crea nada, no mueve ni
 *      guarda en un stash ningún archivo, y sale 3. Una historia de otro repo no pide nada: la base es `origin/main`.
 *   4. Crea `<principal>--wt-<clave>` con la rama `wt/<clave>` (la clave de la carpeta de la corrida); si la carpeta o la
 *      rama existen, prueba `-2`, `-3`… sin pisar ni reusar ninguna. Si `git worktree add` falla, saca lo que dejó y
 *      sale 1.
 *   5. Imprime `{ path, branch, base, sha, story, checklist, next }`: `story` es la ruta de la historia en la copia y
 *      `next` el `start` para correr desde ahí. Sale 0.
 *
 * Uso: node own-copy.js --story <ruta de la historia> --repo <checkout>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ_ARNES = path.join(__dirname, '..', '..', '..');
const { siblingCopy, gitIn } = require(path.join(RAIZ_ARNES, 'scripts', 'lib', 'sibling-copy.js'));
const MAX_INTENTOS = 20;

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(String(p)); } };

/**
 * ¿Es el arnés público o `agent-skills`, donde no se abre una copia propia? Lo dice el remoto, no la carpeta: el `origin`
 * del repo (seguido como `resolverRemoto` de harness-repo.js) es un público que declara el árbol instalado
 * (`esPublicoDeclarado`, de `public-remotes.json`), o es el `origin` de lo instalado en `agent-skills` cuando es un clon.
 * Sin `origin` legible decide el nombre de la carpeta. No usa `juzgarRepo`: con el arnés instalado y sin un clon de
 * desarrollo no reconoce nada por el remoto, y con `paths.maintainers` cuenta también el repo privado de mantenimiento,
 * que sí trabaja en copias. Un árbol instalado que no declara el público reconoce el arnés sólo por la carpeta.
 * `{ sin: boolean, por: string }`.
 */
function sinCopiaPropia(root, { env = process.env } = {}) {
  const hr = require(path.join(RAIZ_ARNES, 'scripts', 'lib', 'harness-repo.js'));
  const r = hr.resolverRemoto(root);
  if (r.por === 'sin-origin') return { sin: hr.porNombreDeCarpeta(real(r.dir)), por: 'carpeta' };
  if (!r.id) return { sin: false, por: r.por };
  if (hr.esPublicoDeclarado(r.id)) return { sin: true, por: 'publico-declarado' };
  const skills = env.TYCON_SKILLS_DIR || require(path.join(RAIZ_ARNES, 'scripts', 'setup', 'harness', 'tycon-home.js')).installedSkillsDir(env.HOME || os.homedir());
  const top = gitIn(skills, ['rev-parse', '--show-toplevel']);
  if (top.code === 0 && top.out && real(top.out) === real(skills)) {
    const s = hr.resolverRemoto(skills);
    if (s.id && hr.mismaIdentidad(s.id, r.id)) return { sin: true, por: 'agent-skills' };
  }
  return { sin: false, por: 'remoto' };
}

function storyIdDe(texto) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  const m = fm && /^story:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm[1]);
  return m ? m[1].trim() : null;
}

/** De dónde nace la copia: `{ base, sha, rel }`, o `{ error, codigo }`. */
function elegirBase({ checkout, root, storyAbs }) {
  const rel = path.relative(real(root), real(storyAbs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { base: 'origin/main', sha: null, rel: null };
  const relGit = rel.split(path.sep).join('/');
  const contenido = fs.readFileSync(storyAbs, 'utf8');
  const enMain = gitIn(root, ['show', `origin/main:${relGit}`]);
  if (enMain.code === 0 && enMain.out === contenido.trim()) return { base: 'origin/main', sha: null, rel };
  const head = gitIn(checkout, ['rev-parse', 'HEAD^{commit}']);
  if (head.code === 0 && head.out) {
    const enHead = gitIn(root, ['show', `${head.out}:${relGit}`]);
    if (enHead.code === 0 && enHead.out === contenido.trim()) return { base: 'HEAD', sha: head.out, rel };
  }
  return { codigo: 3, error: `La historia ${relGit} no está commiteada (o tiene cambios sin commitear) ni en origin/main ni en HEAD: no creé la copia ni toqué ningún archivo. Commiteala primero en su rama, o trabajá coordinado con la otra sesión.` };
}

const CHECKLIST = (dir) => [
  ...(fs.existsSync(path.join(dir, 'package.json')) ? ['npm install   (node_modules no viaja con la copia)'] : []),
  ...((() => { try { return fs.readdirSync(dir).some((f) => f.endsWith('.sln')); } catch { return false; } })() ? ['dotnet restore   (bin/obj no viajan)'] : []),
  '.env / secretos sin trackear: copialos a mano si la prueba en vivo los necesita',
];

/** `{ codigo, salida }`: 0 creada, 1 git falló, 2 no corresponde (arnés o pedido mal), 3 historia sin commitear. */
function crear({ story, repo, env = process.env }) {
  const fin = (codigo, salida) => ({ codigo, salida });
  if (!story || !repo) return fin(2, { error: 'Faltan --story y --repo.' });
  const storyAbs = path.resolve(story);
  const checkout = path.resolve(repo);
  if (!fs.existsSync(storyAbs)) return fin(2, { error: `La historia ${storyAbs} no existe.` });
  const top = gitIn(checkout, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.out) return fin(2, { error: `${checkout} no es un repo de git (${top.err || 'sin raíz'}).` });
  const root = top.out;
  const no = sinCopiaPropia(root, { env });
  if (no.sin) return fin(2, { error: `${root} es el arnés o agent-skills: ahí no se abre una copia propia, una sola sesión toca git a la vez (guides/git-worktrees.md §1).` });
  const texto = fs.readFileSync(storyAbs, 'utf8');
  const clave = require('./lib/run-dir.js').runDirKey(storyIdDe(texto), storyAbs);
  if (!clave.key) return fin(2, { error: `No pude calcular la clave de la historia (${clave.error || 'sin motivo'}).` });
  const fetched = gitIn(root, ['fetch', '--quiet', '--no-tags', 'origin', 'main']);
  if (fetched.code !== 0) return fin(1, { error: `No pude traer main de origin en ${root}: ${fetched.err || `git salió con código ${fetched.code}`}. No creé nada.` });
  const b = elegirBase({ checkout, root, storyAbs });
  if (b.error) return fin(b.codigo, { error: b.error });
  let copia = null;
  for (let i = 1; i <= MAX_INTENTOS && !copia; i++) {
    const nombre = i === 1 ? clave.key : `${clave.key}-${i}`;
    const c = siblingCopy({ repo: root, name: nombre, branch: `wt/${nombre}`, base: b.sha || 'origin/main', fetch: false });
    if (c.ok) copia = c;
    else if (c.reason !== 'exists') return fin(1, { error: c.message });
  }
  if (!copia) return fin(1, { error: `Las copias ${clave.key} a ${clave.key}-${MAX_INTENTOS} ya existen: no creé otra.` });
  const storyEnCopia = b.rel ? path.join(copia.path, b.rel) : storyAbs;
  return fin(0, {
    path: copia.path, branch: copia.branch, base: b.base, sha: b.sha, story: storyEnCopia, checklist: CHECKLIST(copia.path),
    next: `node ${path.join(__dirname, 'pipeline.js')} start --story ${storyEnCopia} --repo ${copia.path} --brief`,
  });
}

module.exports = { crear, sinCopiaPropia, elegirBase };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const r = crear({ story: val('--story'), repo: val('--repo') });
  process.stdout.write(JSON.stringify(r.salida, null, 2) + '\n');
  process.exit(r.codigo);
}
