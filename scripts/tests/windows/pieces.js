'use strict';
/**
 * pieces.js — la lista de piezas que usa una máquina con el arnés instalado, y la comparación de dos listas.
 *
 * POR QUÉ EXISTE. Mover skills, revisores y guías de lugar (del núcleo a un paquete, o del público al perfil de un
 * equipo) tiene una forma de fallar que no da error: la máquina se actualiza bien y tiene una pieza menos. Esta lista se
 * toma antes y después de una actualización y se compara pieza por pieza, por NOMBRE (que una pieza cambie a dónde apunta
 * no es perderla). La usan la foto del ensayo de actualización (release-photo.js, en Mac y en Windows) y la prueba de
 * actualización de los paquetes.
 *
 * LAS PIEZAS:
 *   · skills, agents: cada entrada de ~/.claude/skills y ~/.claude/agents que resuelve adentro del árbol instalado;
 *   · codex_skills: lo mismo en ~/.codex/skills (o $CODEX_HOME), si la carpeta está;
 *   · guides: cada guía que nombra el índice del árbol (INDEX.md) y existe;
 *   · commit_controls: los controles de commit globales (~/.git-hooks);
 *   · hooks: cada hook registrado en ~/.claude/settings.json, como «<evento>:<archivo del guion>»;
 *   · reviewers: el set de revisores de un repo de juguete .NET + React y de uno Next.js + Postgres, con el pipeline del
 *     árbol instalado y la configuración de la máquina.
 *
 * Sólo lee (los repos de juguete se arman en `scratch`). Sin dependencias.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const KINDS = Object.freeze(['skills', 'agents', 'codex_skills', 'guides', 'commit_controls', 'hooks', 'reviewers']);
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const under = (p, dir) => !!p && !!dir && (p === dir || p.startsWith(dir + path.sep));
const entries = (d) => { try { return fs.readdirSync(d).filter((n) => !n.startsWith('.')).sort(); } catch (_) { return null; } };

/** Las entradas de `dir` que resuelven adentro del árbol: nombres ordenados, o null si la carpeta no está. */
function linkedInto(dir, tree) {
  const names = entries(dir);
  if (names === null) return null;
  const t = real(tree);
  return names.filter((n) => under(real(path.join(dir, n)), t));
}

/** Las guías que nombra el índice del árbol y existen (rutas relativas al árbol, ordenadas). */
function indexGuides(tree) {
  let md = '';
  try { md = fs.readFileSync(path.join(tree, 'INDEX.md'), 'utf8'); } catch (_) { return null; }
  const out = new Set();
  for (const m of md.matchAll(/(?:`|\(|\s|^)((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md)(?=`|\)|\s|$|§)/gm)) {
    const rel = m[1].replace(/^\.\//, '');
    if (fs.existsSync(path.join(tree, rel))) out.add(rel);
  }
  return [...out].sort();
}

/** Cada hook registrado, como «<evento>:<archivo del guion>» (sin ruta: la ruta cambia con la versión). */
function registeredHooks(home) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')); } catch (_) { return null; }
  const out = new Set();
  for (const [event, groups] of Object.entries((s && s.hooks) || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
        const cmd = String((h && h.command) || '');
        const scripts = cmd.match(/[A-Za-z0-9._-]+\.(?:js|sh|ps1|py)\b/g);
        out.add(`${event}:${scripts ? scripts[scripts.length - 1] : cmd.split(/\s+/)[0]}`);
      }
    }
  }
  return [...out].sort();
}

/** Los dos repos de juguete (se arman una vez por carpeta): `{ dotnet, next }` con sus archivos cambiados. */
function toyRepos(scratch) {
  const g = (dir, args) => spawnSync('git', ['-C', dir, '-c', 'user.email=lab@example.com', '-c', 'user.name=lab', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', ...args],
    { encoding: 'utf8', env: Object.assign({}, process.env, { GIT_AUTHOR_DATE: '2030-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' }) });
  const make = (name, base, changed) => {
    const d = path.join(scratch, 'pieces-repos', name);
    if (!fs.existsSync(path.join(d, '.git'))) {
      fs.mkdirSync(d, { recursive: true });
      for (const [rel, text] of Object.entries(base)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); }
      g(d, ['init', '-q', '-b', 'main']); g(d, ['add', '-A']); g(d, ['commit', '-q', '-m', 'base']);
      for (const [rel, text] of Object.entries(changed)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.appendFileSync(path.join(d, rel), text); }
    }
    return { dir: d, files: Object.keys(changed) };
  };
  return {
    dotnet: make('dotnet-react', { 'Plugin/Plugin.csproj': '<Project />\n', 'Plugin/Hubs/Chat.cs': 'class Chat {}\n', 'web/package.json': '{ "dependencies": { "react": "18.3.1" } }\n', 'web/src/A.tsx': 'export const A = 1;\n', 'database/001_init.sql': 'SELECT 1;\n' },
      { 'Plugin/Hubs/Chat.cs': 'public class ChatHub : Hub { public async Task Send() { await Clients.All.SendAsync("x"); } }\n', 'web/src/A.tsx': 'export const B = 2;\n', 'database/002_more.sql': 'ALTER TABLE x ADD y INT;\n' }),
    next: make('next-postgres', { 'package.json': '{ "dependencies": { "next": "15.0.0", "drizzle-orm": "0.36.0", "next-auth": "5.0.0" } }\n', 'src/db/schema.ts': 'export const a = 1;\n', 'src/app/api/x/route.ts': 'export const GET = 1;\n' },
      { 'src/db/schema.ts': 'export const users = pgTable("users", {});\n', 'src/app/api/x/route.ts': 'export async function POST() { return Response.json({}); }\n', 'drizzle/0001_x.sql': 'ALTER TABLE users ADD c INT;\n' }),
  };
}

/** El set de revisores de un repo de juguete con el pipeline del árbol: nombres ordenados, o `{ problem }`. */
function reviewerSet(tree, repo, env) {
  const pipeline = path.join(tree, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js');
  if (!fs.existsSync(pipeline)) return { problem: 'el árbol no trae el pipeline' };
  const r = spawnSync(process.execPath, [pipeline, 'advisors', '--repo', repo.dir, '--files', ...repo.files], { encoding: 'utf8', env: Object.assign({}, env, { TYCON_SESSION_ID: 'pieces-photo' }), timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) return { problem: `pipeline.js advisors salió ${r.error ? r.error.code || r.error.message : r.status}: ${String(r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300)}` };
  try { return [...new Set(JSON.parse(r.stdout).all || [])].sort(); } catch (e) { return { problem: `la salida de pipeline.js advisors no es JSON (${e.message})` }; }
}

/** La lista de piezas de una máquina: `{ skills, agents, codex_skills, guides, commit_controls, hooks, reviewers }`. */
function list({ home, tree, env = process.env, scratch }) {
  const codexHome = (env && env.CODEX_HOME) || path.join(home, '.codex');
  const repos = scratch ? toyRepos(scratch) : null;
  return {
    skills: linkedInto(path.join(home, '.claude', 'skills'), tree),
    agents: linkedInto(path.join(home, '.claude', 'agents'), tree),
    codex_skills: linkedInto(path.join(codexHome, 'skills'), tree),
    guides: indexGuides(tree),
    commit_controls: entries(path.join(home, '.git-hooks')),
    hooks: registeredHooks(home),
    reviewers: repos ? { 'dotnet-react': reviewerSet(tree, repos.dotnet, env), 'next-postgres': reviewerSet(tree, repos.next, env) } : null,
  };
}

/** Los nombres de una pieza (`reviewers` se aplana como «<repo>:<revisor>»). */
function namesOf(p, kind) {
  const v = p && p[kind];
  if (kind === 'reviewers') return v && typeof v === 'object' ? Object.entries(v).flatMap(([r, set]) => (Array.isArray(set) ? set.map((a) => `${r}:${a}`) : [`${r}:(no medido: ${set && set.problem})`])) : [];
  return Array.isArray(v) ? v : [];
}

/**
 * Lo que cambió entre dos listas: `{ same, lost: [{ kind, name }], gained: [{ kind, name }], renamed: [{ kind, from, to }] }`.
 * `renames` es `{ <nombre viejo>: <nombre nuevo> }` (los renombres declarados): una pieza que salió con su nombre viejo y
 * está con el nuevo no se perdió.
 */
function compare(before, after, { renames = {} } = {}) {
  const out = { same: true, lost: [], gained: [], renamed: [] };
  for (const kind of KINDS) {
    const a = new Set(namesOf(before, kind)); const b = new Set(namesOf(after, kind));
    for (const n of a) {
      if (b.has(n)) continue;
      const to = renames[n] || renames[n.replace(/\.md$/, '')];
      const toName = to && (n.endsWith('.md') && !to.endsWith('.md') ? `${to}.md` : to);
      if (toName && b.has(toName)) out.renamed.push({ kind, from: n, to: toName });
      else out.lost.push({ kind, name: n });
    }
    for (const n of b) if (!a.has(n) && !out.renamed.some((r) => r.kind === kind && r.to === n)) out.gained.push({ kind, name: n });
  }
  out.same = out.lost.length === 0 && out.gained.length === 0;
  return out;
}

/** Los renombres de skills, agentes y guías del mapa del árbol (`scripts/lib/renames.json`), por nombre. */
function renamesOf(tree) {
  let map;
  try { map = JSON.parse(fs.readFileSync(path.join(tree, 'scripts', 'lib', 'renames.json'), 'utf8')); } catch (_) { return {}; }
  const out = {};
  for (const e of (map && Array.isArray(map.entries) ? map.entries : [])) {
    if (!e || typeof e.old !== 'string' || typeof e.new !== 'string') continue;
    out[path.posix.basename(e.old)] = path.posix.basename(e.new);
    out[e.old] = e.new;
  }
  return out;
}

/** Una lista, en renglones que lee una persona («skills (12): a, b, …»). */
function text(p) {
  return KINDS.map((k) => { const n = namesOf(p, k); return `${k} (${n.length}): ${n.join(', ') || '—'}`; });
}

module.exports = { KINDS, list, compare, renamesOf, text, namesOf, toyRepos, reviewerSet, indexGuides, registeredHooks };
