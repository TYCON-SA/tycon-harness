#!/usr/bin/env node
'use strict';
// fake-gh.js — un `gh` de mentira para las pruebas de los issues de GitHub. No toca la red NUNCA.
//
// Contesta `gh --version` y `gh api [--method M] [-H …] <ruta> [--input <archivo>]` desde un estado en JSON
// (FAKE_GH_STATE), que también GUARDA lo que «crea» (como GitHub), y anota cada llamada en FAKE_GH_LOG (una línea JSON
// por llamada, con el cuerpo que recibió). El estado:
//   { "user": "arnes-bot", "now": "2026-10-14T05:00:00Z", "users": ["lider", …], "collaborators": { "<o>/<r>": [logins] },
//     "issues": { "<o>/<r>": [ { number, state, state_reason, title, body, labels:[nombres], assignees:[logins], user,
//                               created_at, closed_at, closed_by } ] },
//     "timeline": { "<o>/<r>#<n>": [ eventos ] }, "gone": ["<o>/<r>#<n>"], "moved": { "<o>/<r>#<n>": "<otro>/<repo>" },
//     "owners": { "<dueño>": "Organization"|"User" }, "repos": { "<dueño>": [ { name, private? } ] },
//     "installation": ["<o>/<r>", …]   (los repos donde está instalada la App: GET installation/repositories),
//     "visible": ["<o>/<r>", …]        (los que la credencial ve como dueño o colaboradora: GET user/repos),
//     "fail": { "<MÉTODO> <prefijo de ruta>": { "status": 500, "message": "…" } | { "raw": "<html>…" } } }
//   (con `raw` la ruta sale 0 y contesta ese texto tal cual: una respuesta que no es JSON)
// Una ruta con fallo declarado responde como gh: el cuerpo de error por la salida, «gh: … (HTTP n)» por stderr, sale 1.
//
// Pull requests. Los issues y los pull requests comparten numeración, como en GitHub.
//   "pulls": { "<o>/<r>": [ { number, state:"open"|"closed", merged_at, created_at, closed_at, title, body,
//                              head:{ref}, base:{repo:{full_name}}, user:{login,type}, requested_reviewers:[logins],
//                              leak? } ] }
//       `leak: true` (o `leak: "<rama>"`, sólo cuando se pide esa) = GET pulls?head=… lo devuelve aunque su rama no sea la
//       pedida (para probar que el guion comprueba head.ref y que recorre las páginas).
//   "comments": { "<o>/<r>#<n>": [ { body, created_at, user:{login,type} } ] }   (issues Y pull requests: GET/POST issues/N/comments)
//   "reviews":  { "<o>/<r>#<n>": [ { state, body, submitted_at, user:{login,type} } ] }   (GET pulls/N/reviews)
//   "review_comments": { "<o>/<r>#<n>": [ { body, created_at, user:{login,type} } ] }   (GET pulls/N/comments: comentarios sobre una línea del diff)
//   "no_pr_create": true   POST pulls responde el 403 «GitHub Actions is not permitted to create or approve pull requests»
//   "pr_create_raw": "<texto>"   POST pulls crea el pedido y contesta ese texto, que no es JSON
//   "remotes": { "<o>/<r>": "<ruta del repo bare>" }   POST pulls exige que la rama `head` exista allá (422 si no), como GitHub
//   "projects": { "<dueño>#<número>": { id, fields: [ { id, name, dataType } ], items: { "<nodo del issue>": { id, values: { <id del campo>: n } } } } }
//   "graphql_error": { type, message }   toda consulta GraphQL contesta ese error (un token sin permiso de proyectos)
// POST graphql (Projects v2): la consulta del proyecto de un dueño (organización o usuario) con sus campos, agregar un
// issue (idempotente, como GitHub) y cargar el número de un campo. Un proyecto que no existe contesta NOT_FOUND.
// Los issues traen `node_id` (`I_<o>/<r>#<n>`), el nodo con que GraphQL los nombra.
// GET pulls?head=<dueño>:<rama>&state=&per_page=&page= filtra y pagina de verdad (state por defecto: open). GET pulls/N sobre un
// número que es un issue da 404. PATCH pulls/N cambia `state`, `title` y `body` (uno mergeado no se puede reabrir). POST pulls/N/requested_reviewers
// pide revisores (422 si el repo declara `collaborators` y alguno no está). PUT pulls/N/merge junta la rama en la base del
// repo bare de `remotes` con un solo commit (405 si no está abierto, 409 si `sha` no es la punta de la rama).
// Para los pedidos de cambio por la capa: "allow_auto_merge": { "<o>/<r>": true } (GET repos/o/r lo trae), los pulls con
// `node_id` (`PR_<o>/<r>#<n>`), `mergeable` (false = en conflicto), `auto_merge`, `draft` y `assignees`; "shas":
// { "<rama>": "<sha>" } es la punta de cada rama; "checks", "autoMerge", "merge_falla", "merge_sin_git" e
// "issuesConPulls" se explican donde se usan. Un fallo `{ "red": true }` es la red caída (sin cuerpo, sale 1).
const fs = require('fs');

const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('gh version 0.0.0 (de mentira)'); process.exit(0); }
const stateFile = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
let method = 'GET', ruta = null, input = null;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--method' || a === '-X') method = argv[++i];
  else if (a === '-H') i++;
  else if (a === '--input') input = argv[++i];
  else if (!a.startsWith('-') && ruta === null) ruta = a.replace(/^\//, '');
}
const cuerpo = input ? JSON.parse(fs.readFileSync(input, 'utf8')) : null;
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ method, ruta, cuerpo })}\n`);
const save = () => fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
const out = (v) => { process.stdout.write(`${JSON.stringify(v)}\n`); process.exit(0); };
const err = (status, message) => {
  process.stdout.write(`${JSON.stringify({ message, status: String(status) })}\n`);
  process.stderr.write(`gh: ${message} (HTTP ${status})\n`);
  process.exit(1);
};
for (const [k, v] of Object.entries(st.fail || {})) {
  const [m, pre] = k.split(' ');
  // un prefijo que termina en `$` es la ruta exacta (sin la consulta): `GET repos/o/r$` falla la lectura del repo y no
  // la de sus pull requests
  const tocada = pre.endsWith('$') ? ruta.split('?')[0] === pre.slice(0, -1) : ruta.startsWith(pre);
  if (m === method && tocada) {
    if (v.raw !== undefined) { process.stdout.write(`${v.raw}\n`); process.exit(0); }   // sale bien con algo que no es JSON
    // la red caída: gh no llega a GitHub y no hay cuerpo de error
    if (v.red) { process.stderr.write('error connecting to api.github.com\n'); process.exit(1); }
    err(v.status || 500, v.message || 'falla de prueba');
  }
}
const [base, qs = ''] = ruta.split('?');
const q = Object.fromEntries(qs.split('&').filter(Boolean).map((x) => x.split('=').map(decodeURIComponent)));
const page = Number(q.page || 1), per = Number(q.per_page || 30);
const pag = (arr) => arr.slice((page - 1) * per, page * per);
const issueApi = (repo, i) => ({
  ...i, node_id: i.node_id || `I_${repo}#${i.number}`, repository_url: `https://api.github.com/repos/${(st.moved || {})[`${repo}#${i.number}`] || repo}`,
  labels: (i.labels || []).map((name) => ({ name })), assignees: (i.assignees || []).map((login) => ({ login })),
  user: { login: i.user || st.user, type: /\[bot\]$/.test(i.user || '') ? 'Bot' : 'User' },
  closed_by: i.closed_by ? { login: i.closed_by } : null,
});
let m;
if (method === 'GET' && base === 'user') out({ login: st.user });
if (method === 'GET' && (m = base.match(/^users\/([^/]+)$/))) {
  if ((st.owners || {})[m[1]]) out({ login: m[1], type: st.owners[m[1]] });
  if ((st.users || []).includes(m[1]) || m[1] === st.user) out({ login: m[1], type: 'User' });
  err(404, 'Not Found');
}
// como GitHub: la de una organización trae los privados que la credencial ve; la de un usuario, SÓLO los públicos
const delDueno = (o) => ((st.repos || {})[o] || []).map((r) => ({ ...r, private: !!r.private, owner: { login: o } }));
const porNombre = (lista) => (lista || []).map((full) => { const [o, n] = full.split('/'); return delDueno(o).find((r) => r.name === n) || { name: n, private: true, owner: { login: o } }; });
if (method === 'GET' && (m = base.match(/^orgs\/([^/]+)\/repos$/))) out(pag(delDueno(m[1])));
if (method === 'GET' && (m = base.match(/^users\/([^/]+)\/repos$/))) out(pag(delDueno(m[1]).filter((r) => !r.private)));
if (method === 'GET' && base === 'installation/repositories') {
  if (!st.installation) err(403, 'Resource not accessible by personal access token');
  const l = porNombre(st.installation);
  out({ total_count: l.length, repositories: pag(l) });
}
if (method === 'GET' && base === 'user/repos') out(pag(porNombre(st.visible)));
// La foto de despliegues: environments, deployments con sus statuses, corridas de Actions y sus despliegues
// pendientes. Estado: "environments": { "<o>/<r>": [nombres] }, "default_branch": { "<o>/<r>": "main" },
//   "deployments": { "<o>/<r>": [ { id, sha, environment, created_at, statuses: [ { id, state, created_at } ] } ] },
//   "runs": { "<o>/<r>": [ { id, run_number, status, conclusion, created_at, head_branch, workflow, pending: [env] } ] }.
// Las listas salen en el orden del estado: la API no documenta su orden y el guion no puede confiar en él.
if (method === 'GET' && (m = base.match(/^repos\/([^/]+\/[^/]+)\/environments\/([^/]+)$/))) {
  if (((st.environments || {})[m[1]] || []).includes(m[2])) out({ name: m[2] });
  err(404, 'Not Found');
}
if (method === 'GET' && (m = base.match(/^repos\/([^/]+\/[^/]+)\/deployments$/))) {
  out(pag(((st.deployments || {})[m[1]] || []).filter((d) => !q.environment || d.environment === q.environment).map(({ statuses, ...d }) => d)));
}
if (method === 'GET' && (m = base.match(/^repos\/([^/]+\/[^/]+)\/deployments\/(\d+)\/statuses$/))) {
  const d = ((st.deployments || {})[m[1]] || []).find((x) => String(x.id) === m[2]);
  if (!d) err(404, 'Not Found');
  out(pag(d.statuses || []));
}
if (method === 'GET' && (m = base.match(/^repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/pending_deployments$/))) {
  const r = ((st.runs || {})[m[1]] || []).find((x) => String(x.id) === m[2]);
  out((r && r.pending ? r.pending : []).map((name) => ({ environment: { name } })));
}
if (method === 'GET' && (m = base.match(/^repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/runs$/))) {
  const l = ((st.runs || {})[m[1]] || []).filter((r) => r.workflow === m[2] && (!q.branch || r.head_branch === q.branch));
  out({ total_count: l.length, workflow_runs: pag(l) });
}
if (method === 'GET' && (m = base.match(/^repos\/([^/]+\/[^/]+)\/actions\/runs$/))) {
  const l = ((st.runs || {})[m[1]] || []).filter((r) => !q.status || r.status === q.status);
  out({ total_count: l.length, workflow_runs: pag(l) });
}
if (method === 'GET' && (m = base.match(/^repos\/([^/]+\/[^/]+)$/))) {
  const db = (st.default_branch || {})[m[1]];
  const am = (st.allow_auto_merge || {})[m[1]];
  if (db || am !== undefined) out({ full_name: m[1], default_branch: db || 'main', allow_auto_merge: am === true });
}
// Los controles de un commit: "checks": { "<sha>": [ { name, status, conclusion } ] }, o { "fotos": [ [ … ], [ … ] ] }:
// cada lectura de la primera página toma la foto siguiente (la última se repite), para un control que pasa de en curso
// a terminado. Pagina con per_page y page, como GitHub.
if (method === 'GET' && (m = base.match(/^repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/check-runs$/))) {
  const c = (st.checks || {})[m[2]];
  let l = Array.isArray(c) ? c : [];
  if (c && Array.isArray(c.fotos)) {
    st.checks_leidas = st.checks_leidas || {};
    const i = st.checks_leidas[m[2]] || 0;
    l = c.fotos[Math.min(i, c.fotos.length - 1)] || [];
    // la foto avanza con la primera página: las demás páginas de la misma lectura son de la misma foto
    if (page === 1) { st.checks_leidas[m[2]] = i + 1; save(); } else l = c.fotos[Math.min(Math.max(i - 1, 0), c.fotos.length - 1)] || [];
  }
  out({ total_count: l.length, check_runs: pag(l) });
}
// Los estados de un commit (la API vieja de controles): "statuses": { "<sha>": [ { context, state } ] }, el más nuevo
// primero, como GitHub. Pagina igual.
if (method === 'GET' && (m = base.match(/^repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/statuses$/))) {
  out(pag(((st.statuses || {})[m[2]]) || []));
}
// ── Pull requests ──
const pullsOf = (repo) => { st.pulls = st.pulls || {}; st.pulls[repo] = st.pulls[repo] || []; return st.pulls[repo]; };
const nextNumber = (repo) => Math.max(0, ...((st.issues || {})[repo] || []).map((i) => i.number), ...pullsOf(repo).map((p) => p.number)) + 1;
const persona = (u) => { const login = (u && u.login) || st.user; return { login, type: (u && u.type) || (/\[bot\]$/.test(login) ? 'Bot' : 'User') }; };
const pullApi = (repo, p) => ({
  ...p, merged: !!p.merged_at, merged_at: p.merged_at || null, closed_at: p.closed_at || null,
  node_id: p.node_id || `PR_${repo}#${p.number}`, draft: p.draft === true, auto_merge: p.auto_merge || null,
  mergeable: p.mergeable === undefined ? true : p.mergeable, mergeable_state: p.mergeable_state || (p.mergeable === false ? 'dirty' : 'clean'),
  html_url: `https://github.com/${repo}/pull/${p.number}`, assignees: (p.assignees || []).map((login) => ({ login })),
  head: { ref: p.head.ref, sha: p.head.sha || (st.shas || {})[p.head.ref] || '0'.repeat(40) },
  base: { ref: (p.base && p.base.ref) || 'main', repo: { full_name: (p.base && p.base.repo && p.base.repo.full_name) || repo } },
  user: persona(p.user), requested_reviewers: (p.requested_reviewers || []).map((r) => (typeof r === 'string' ? { login: r } : r)),
});
if ((m = base.match(/^repos\/([^/]+\/[^/]+)\/pulls$/))) {
  const repo = m[1];
  if (method === 'GET') {
    let l = pullsOf(repo);
    if (q.head) { const ref = q.head.includes(':') ? q.head.split(':').slice(1).join(':') : q.head; l = l.filter((p) => p.leak === true || p.leak === ref || p.head.ref === ref); }
    if (q.base) l = l.filter((p) => ((p.base && p.base.ref) || 'main') === q.base);
    const est = q.state || 'open';
    if (est !== 'all') l = l.filter((p) => p.state === est);
    out(pag(l.map((p) => pullApi(repo, p))));
  }
  if (method === 'POST') {
    if (st.no_pr_create) err(403, 'GitHub Actions is not permitted to create or approve pull requests.');
    const head = String((cuerpo || {}).head || '').replace(/^[^:]+:/, '');
    if (!cuerpo || !cuerpo.title || !head || !cuerpo.base) err(422, 'Validation Failed');
    const remoto = (st.remotes || {})[repo];
    if (remoto) {
      const r = require('child_process').spawnSync('git', ['ls-remote', remoto, `refs/heads/${head}`], { encoding: 'utf8' });
      if (r.status !== 0 || !r.stdout.trim()) err(422, `Validation Failed: la rama ${head} no existe en ${repo}`);
    }
    if (pullsOf(repo).some((p) => p.state === 'open' && p.head.ref === head)) err(422, `A pull request already exists for ${repo.split('/')[0]}:${head}.`);
    const p = { number: nextNumber(repo), state: 'open', merged_at: null, created_at: st.now, closed_at: null, title: cuerpo.title, body: cuerpo.body || '',
      head: { ref: head }, base: { ref: cuerpo.base, repo: { full_name: repo } }, user: { login: st.user, type: /\[bot\]$/.test(st.user) ? 'Bot' : 'User' }, requested_reviewers: [] };
    pullsOf(repo).push(p); save();
    if (st.pr_create_raw !== undefined) { process.stdout.write(`${st.pr_create_raw}\n`); process.exit(0); }
    out(pullApi(repo, p));
  }
}
if ((m = base.match(/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/reviews|\/requested_reviewers|\/comments)?$/))) {
  const repo = m[1], n = Number(m[2]);
  const p = pullsOf(repo).find((x) => x.number === n);
  if (!p) err(404, 'Not Found');
  if (m[3] === '/reviews' && method === 'GET') out(pag(((st.reviews || {})[`${repo}#${n}`] || []).map((r) => ({ ...r, user: persona(r.user) }))));
  if (m[3] === '/comments' && method === 'GET') out(pag(((st.review_comments || {})[`${repo}#${n}`] || []).map((c) => ({ ...c, user: persona(c.user) }))));
  if (m[3] === '/requested_reviewers' && method === 'POST') {
    const colab = (st.collaborators || {})[repo];
    const malos = ((cuerpo || {}).reviewers || []).filter((r) => colab && !colab.includes(r));
    if (malos.length) err(422, `Reviews may only be requested from collaborators. One or more of the users or teams you specified is not a collaborator of the ${repo} repository.`);
    p.requested_reviewers = [...(p.requested_reviewers || []), ...cuerpo.reviewers]; save(); out(pullApi(repo, p));
  }
  if (!m[3] && method === 'GET') out(pullApi(repo, p));
  if (!m[3] && method === 'PATCH') {
    if (cuerpo.title !== undefined) p.title = cuerpo.title;
    if (cuerpo.body !== undefined) p.body = cuerpo.body;
    if (cuerpo.state === 'closed') Object.assign(p, { state: 'closed', closed_at: st.now });
    if (cuerpo.state === 'open') {
      if (p.merged_at) err(422, 'Validation Failed: el pull request ya está mergeado');
      Object.assign(p, { state: 'open', closed_at: null });
    }
    save(); out(pullApi(repo, p));
  }
}
if (method === 'PUT' && (m = base.match(/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/))) {
  const repo = m[1], n = Number(m[2]);
  const p = pullsOf(repo).find((x) => x.number === n);
  if (!p) err(404, 'Not Found');
  if (p.state !== 'open') err(405, 'Pull Request is not mergeable');
  // "merge_falla": { "<o>/<r>#<n>": { status, message } } — el merge que GitHub rechaza (405 sin poder, 409 punta movida)
  const falla = (st.merge_falla || {})[`${repo}#${n}`];
  if (falla) err(falla.status, falla.message || 'Pull Request is not mergeable');
  const remoto = (st.remotes || {})[repo];
  // "merge_sin_git": true — el merge se da por hecho sin un repo bare (para lo que mira las llamadas y no las ramas)
  if (!remoto && st.merge_sin_git) {
    Object.assign(p, { state: 'closed', merged_at: st.now, closed_at: st.now });
    save(); out({ sha: 'f'.repeat(40), merged: true, message: 'Pull Request successfully merged' });
  }
  if (!remoto) err(405, 'Pull Request is not mergeable');
  const git = (...a) => {
    // identidad y fecha fijas y sin mantenimiento automático: el commit del merge sale igual en cada corrida, también en
    // una HOME vacía, donde git no tiene a quién poner
    const r = require('child_process').spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', remoto, ...a], {
      encoding: 'utf8', env: {
        ...process.env, GIT_AUTHOR_NAME: 'github', GIT_AUTHOR_EMAIL: 'github@acme.example', GIT_COMMITTER_NAME: 'github',
        GIT_COMMITTER_EMAIL: 'github@acme.example', GIT_AUTHOR_DATE: '2026-10-28T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-28T00:00:00Z',
      } });
    if (r.status !== 0) err(409, `git ${a[0]}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  const baseRef = (p.base && p.base.ref) || 'main';
  const cabeza = git('rev-parse', `refs/heads/${p.head.ref}`);
  if (cuerpo && cuerpo.sha && cuerpo.sha !== cabeza) err(409, 'Head branch was modified. Review and try the merge again.');
  const destino = git('rev-parse', `refs/heads/${baseRef}`);
  const arbol = git('merge-tree', '--write-tree', destino, cabeza).split('\n')[0];
  const titulo = (cuerpo && cuerpo.commit_title) || `${p.title} (#${n})`;
  const nuevo = git('commit-tree', arbol, '-p', destino, '-m', titulo);
  git('update-ref', `refs/heads/${baseRef}`, nuevo, destino);
  Object.assign(p, { state: 'closed', merged_at: st.now, closed_at: st.now });
  save(); out({ sha: nuevo, merged: true, message: 'Pull Request successfully merged' });
}
if ((m = base.match(/^repos\/([^/]+\/[^/]+)\/issues$/))) {
  const repo = m[1];
  st.issues = st.issues || {}; st.issues[repo] = st.issues[repo] || [];
  if (method === 'GET') {
    let l = st.issues[repo];
    // como GitHub: el filtro por etiqueta no distingue mayúsculas
    if (q.labels) l = l.filter((i) => (i.labels || []).some((x) => x.toLowerCase() === q.labels.toLowerCase()));
    if (q.state && q.state !== 'all') l = l.filter((i) => i.state === q.state);
    const issues = l.map((i) => ({ ...issueApi(repo, i), html_url: `https://github.com/${repo}/issues/${i.number}` }));
    // "issuesConPulls": true — como GitHub, la lista de issues trae también los pull requests, con `pull_request`
    const pulls = st.issuesConPulls ? pullsOf(repo).filter((p) => !q.state || q.state === 'all' || p.state === q.state)
      .map((p) => ({ ...pullApi(repo, p), pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${p.number}` } })) : [];
    out(pag([...issues, ...pulls].sort((a, b) => a.number - b.number)));
  }
  if (method === 'POST') {
    const number = nextNumber(repo);
    const colab = (st.collaborators || {})[repo];
    const i = { number, state: 'open', state_reason: null, title: cuerpo.title, body: cuerpo.body, labels: cuerpo.labels || [],
      assignees: (cuerpo.assignees || []).filter((a) => !colab || colab.includes(a)), user: st.user, created_at: st.now, closed_at: null, closed_by: null };
    if (st.labels_drop) i.labels = i.labels.filter((x) => x !== st.labels_drop);
    st.issues[repo].push(i); save(); out(issueApi(repo, i));
  }
}
if ((m = base.match(/^repos\/([^/]+\/[^/]+)\/issues\/(\d+)(\/comments|\/timeline)?$/))) {
  const repo = m[1], n = Number(m[2]);
  if ((st.gone || []).includes(`${repo}#${n}`)) err(410, 'This issue was deleted');
  const i = ((st.issues || {})[repo] || []).find((x) => x.number === n);
  const esPull = m[3] === '/comments' && pullsOf(repo).some((x) => x.number === n);
  if (!i && !esPull) err(404, 'Not Found');
  const k = `${repo}#${n}`;
  if (m[3] === '/comments' && method === 'GET') out(pag(((st.comments || {})[k] || []).map((c) => ({ ...c, user: persona(c.user) }))));
  if (m[3] === '/comments' && method === 'POST') {
    st.comments = st.comments || {}; st.comments[k] = [...(st.comments[k] || []), { body: cuerpo.body, created_at: st.now, user: { login: st.user } }];
    if (i) {
      i.comments = [...(i.comments || []), cuerpo.body];
      st.timeline = st.timeline || {};
      st.timeline[k] = [...(st.timeline[k] || []), { event: 'commented', actor: { login: st.user }, body: cuerpo.body, created_at: st.now }];
    }
    save(); out({ id: st.comments[k].length });
  }
  if (m[3] === '/timeline') out(pag((st.timeline || {})[`${repo}#${n}`] || []));
  if (method === 'GET') out(issueApi(repo, i));
  if (method === 'PATCH') {
    if (cuerpo.state === 'closed') Object.assign(i, { state: 'closed', state_reason: cuerpo.state_reason || 'completed', closed_at: st.now, closed_by: st.user });
    if (cuerpo.state === 'open') Object.assign(i, { state: 'open', state_reason: 'reopened', closed_at: null, closed_by: null });
    // las etiquetas, como GitHub: la lista que llega reemplaza a la que había
    if (Array.isArray(cuerpo.labels)) i.labels = cuerpo.labels.map(String);
    save(); out(issueApi(repo, i));
  }
}
// ── GraphQL de proyectos ──
if (method === 'POST' && base === 'graphql') {
  const qy = String((cuerpo || {}).query || '');
  const vars = (cuerpo || {}).variables || {};
  const gqlErr = (type, message) => {
    process.stdout.write(`${JSON.stringify({ data: null, errors: [{ type, message }] })}\n`);
    process.stderr.write(`gh: ${message}\n`);
    process.exit(1);
  };
  if (st.graphql_error) gqlErr(st.graphql_error.type, st.graphql_error.message);
  // auto-merge de un pull request: "autoMerge": "funciona" (lo deja puesto) | "sin-efecto" (contesta bien y no lo pone,
  // como un repo sin reglas de protección) | "error" (contesta el error de GitHub)
  if (/enablePullRequestAutoMerge/.test(qy)) {
    if (st.autoMerge === 'error') gqlErr('UNPROCESSABLE', 'Pull request Auto merge is not allowed for this repository');
    const todos = Object.entries(st.pulls || {}).flatMap(([repo, l]) => l.map((p) => ({ repo, p })));
    const x = todos.find(({ repo, p }) => (p.node_id || `PR_${repo}#${p.number}`) === vars.pullRequestId);
    if (!x) gqlErr('NOT_FOUND', `Could not resolve to a node with the global id of '${vars.pullRequestId}'`);
    if (st.autoMerge === 'funciona') { x.p.auto_merge = { merge_method: String(vars.mergeMethod || '').toLowerCase(), enabled_by: { login: st.user } }; save(); }
    out({ data: { enablePullRequestAutoMerge: { pullRequest: { number: x.p.number } } } });
  }
  const projs = st.projects || {};
  const porId = (pid) => Object.values(projs).find((x) => x.id === pid);
  if (/projectV2\(number/.test(qy)) {
    const p = projs[`${vars.owner}#${vars.number}`];
    if (!p) {
      if (!Object.keys(projs).some((k) => k.startsWith(`${vars.owner}#`))) out({ data: { repositoryOwner: null } });
      gqlErr('NOT_FOUND', `Could not resolve to a ProjectV2 with the number ${vars.number}.`);
    }
    out({ data: { repositoryOwner: { projectV2: { id: p.id, fields: { nodes: p.fields || [] } } } } });
  }
  if (/addProjectV2ItemById/.test(qy)) {
    const p = porId(vars.project);
    if (!p) gqlErr('NOT_FOUND', `Could not resolve to a node with the global id of '${vars.project}'`);
    p.items = p.items || {};
    if (!p.items[vars.content]) p.items[vars.content] = { id: `PVTI_${Object.keys(p.items).length + 1}`, values: {} };
    save(); out({ data: { addProjectV2ItemById: { item: { id: p.items[vars.content].id } } } });
  }
  if (/updateProjectV2ItemFieldValue/.test(qy)) {
    const p = porId(vars.project);
    const item = p && Object.values(p.items || {}).find((x) => x.id === vars.item);
    if (!item) gqlErr('NOT_FOUND', 'Could not resolve the item');
    item.values[vars.field] = vars.value;
    save(); out({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } } });
  }
  gqlErr('UNKNOWN', 'consulta GraphQL de prueba desconocida');
}
err(404, `ruta de prueba desconocida: ${method} ${ruta}`);
