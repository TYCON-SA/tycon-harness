#!/usr/bin/env node
'use strict';
// fake-glab.js — un `glab` de mentira para las pruebas del conector de GitLab. No toca la red NUNCA.
//
// Contesta `glab --version` y `glab api --hostname <host> [--method M] [-H …] <ruta> [--input <archivo>]` desde un
// estado en JSON (FAKE_GLAB_STATE), que también GUARDA lo que «crea», y anota cada llamada en FAKE_GLAB_LOG (una línea
// JSON por llamada: `{ host, method, ruta, cuerpo }`). El estado:
//   { "user": "arnes-bot", "users": { "<usuario>": <id> },
//     "issues":   { "<ruta del proyecto>": [ { iid, state: "opened"|"closed", title, description, labels: [nombres],
//                                             assignees: [usuarios], time_estimate, total_time_spent } ] },
//     "mrs":      { "<ruta del proyecto>": [ { iid, state: "opened"|"merged"|"closed", title, description, source_branch,
//                                             target_branch, sha, has_conflicts, draft, merge_when_pipeline_succeeds,
//                                             merged_at, merge_commit_sha, author, assignees: [usuarios],
//                                             head_pipeline: { status }, force_remove_source_branch, approved } ] },
//     "statuses": { "<ruta del proyecto>@<commit>": [ { id, name, status, created_at, allow_failure } ] }
//                 (por commit, como GitLab: pedidos con el nombre de una rama, la lista sale vacía y sin error),
//     "shas":     { "<rama>": "<sha>" }   (la punta de cada rama: la de un merge request que se crea, y la que
//                 contesta GET repository/commits/<rama>; un commit que no es rama se contesta a sí mismo),
//     "gone":     ["<rama o commit>"]   (GET repository/commits/<eso> da 404),
//     "pipelines": { "<rama>": "<estado>" }   (el pipeline de la punta de un merge request que se crea),
//     "notes":    { "<ruta del proyecto>#<iid>": [ textos ] },
//     "fail": { "<MÉTODO> <prefijo de ruta>": { "status": 500, "message": "…", "page": 2 } | { "red": true } | { "raw": "…" } } }
// Una ruta con fallo declarado responde como glab: el cuerpo del error por la salida, «glab: … (HTTP n)» por stderr,
// sale 1. Con `page`, falla sólo esa página. `red` es la red caída (true, o el texto del error de glab); `raw` sale 0
// con ese texto, que no es JSON.
// La ruta del proyecto llega codificada entera (`projects/grupo%2Fsub%2Frepo/…`), como la pide la API.
const fs = require('fs');

const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('glab 0.0.0 (de mentira)'); process.exit(0); }
const stateFile = process.env.FAKE_GLAB_STATE;
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
let method = 'GET';
let ruta = null;
let input = null;
let host = null;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--method' || a === '-X') method = argv[++i];
  else if (a === '--hostname') host = argv[++i];
  else if (a === '-H' || a === '--header') i++;
  else if (a === '--input') input = argv[++i];
  else if (!a.startsWith('-') && ruta === null) ruta = a.replace(/^\//, '');
}
const cuerpo = input ? JSON.parse(fs.readFileSync(input, 'utf8')) : null;
if (process.env.FAKE_GLAB_LOG) fs.appendFileSync(process.env.FAKE_GLAB_LOG, `${JSON.stringify({ host, method, ruta, cuerpo })}\n`);
const save = () => fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
const out = (v) => { process.stdout.write(`${JSON.stringify(v)}\n`); process.exit(0); };
const err = (status, message) => {
  process.stdout.write(`${JSON.stringify({ message })}\n`);
  process.stderr.write(`glab: ${message} (HTTP ${status})\n`);
  process.exit(1);
};
const [base, qs = ''] = ruta.split('?');
const q = Object.fromEntries(qs.split('&').filter(Boolean).map((x) => x.split('=').map(decodeURIComponent)));
const page = Number(q.page || 1);
const per = Number(q.per_page || 20);
const pag = (arr) => arr.slice((page - 1) * per, page * per);
for (const [k, v] of Object.entries(st.fail || {})) {
  const [m, pre] = k.split(' ');
  if (m !== method || !ruta.startsWith(pre) || (v.page && v.page !== page)) continue;
  if (v.raw !== undefined) { process.stdout.write(`${v.raw}\n`); process.exit(0); }
  // la red caída: con `red: true`, glab no llega al servidor; con un texto, es el error que escribe glab (una conexión
  // que se corta a mitad de camino, por ejemplo)
  if (v.red) { process.stderr.write(v.red === true ? `x error connecting to ${host}\n` : `${v.red}\n`); process.exit(1); }
  err(v.status || 500, v.message || '500 Internal Server Error');
}

const m = base.match(/^projects\/([^/]+)(?:\/(.*))?$/);
if (method === 'GET' && base === 'user') out({ username: st.user || 'arnes-bot' });
if (method === 'GET' && base === 'users') {
  const id = (st.users || {})[q.username];
  out(id ? [{ id, username: q.username }] : []);
}
if (!m) err(404, '404 Not found');
const proyecto = decodeURIComponent(m[1]);
const resto = m[2] || '';
const web = (tipo, iid) => `https://${host}/${proyecto}/-/${tipo}/${iid}`;
const persona = (u) => ({ id: (st.users || {})[u] || 0, username: u });
const deUsuarios = (ids) => (Array.isArray(ids) ? ids : []).map((id) => Object.keys(st.users || {}).find((u) => st.users[u] === id)).filter(Boolean);
const etiquetas = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
const issueApi = (i) => ({
  iid: i.iid, state: i.state || 'opened', title: i.title || '', description: i.description || '', labels: i.labels || [],
  assignees: (i.assignees || []).map(persona), web_url: web('issues', i.iid),
  time_stats: { time_estimate: i.time_estimate || 0, total_time_spent: i.total_time_spent || 0 },
});
const mrApi = (x) => ({
  iid: x.iid, state: x.state || 'opened', title: x.title || '', description: x.description || '', draft: x.draft === true,
  source_branch: x.source_branch, target_branch: x.target_branch, sha: x.sha || '', created_at: x.created_at || '2030-01-15T12:00:00Z',
  has_conflicts: x.has_conflicts === true, detailed_merge_status: x.detailed_merge_status || (x.has_conflicts ? 'conflict' : 'mergeable'),
  merge_when_pipeline_succeeds: x.merge_when_pipeline_succeeds === true, merged_at: x.merged_at || null,
  merge_commit_sha: x.merge_commit_sha || null, author: persona(x.author || st.user || 'arnes-bot'),
  assignees: (x.assignees || []).map(persona), head_pipeline: x.head_pipeline || null,
  force_remove_source_branch: x.force_remove_source_branch === true, web_url: web('merge_requests', x.iid),
});
// una duración como la escribe el conector («180m», «16h», «2d») en segundos; un día de GitLab son ocho horas
const segundos = (d) => { const x = String(d || '').match(/^(\d+(?:\.\d+)?)(m|h|d)$/); return x ? Math.round(Number(x[1]) * { m: 60, h: 3600, d: 28800 }[x[2]]) : null; };
const issues = () => ((st.issues = st.issues || {})[proyecto] = st.issues[proyecto] || []);
const mrs = () => ((st.mrs = st.mrs || {})[proyecto] = st.mrs[proyecto] || []);
const siguiente = () => Math.max(0, ...issues().map((i) => i.iid), ...mrs().map((x) => x.iid)) + 1;
let x;

if (method === 'GET' && resto === '') out({ path_with_namespace: proyecto, default_branch: 'main' });

// ── issues ──
if (resto === 'issues' && method === 'GET') {
  const pedidas = etiquetas(q.labels).map((l) => l.toLowerCase());
  out(pag(issues().filter((i) => (!q.state || q.state === 'all' || (i.state || 'opened') === q.state)
    && pedidas.every((l) => (i.labels || []).some((n) => n.toLowerCase() === l))).map(issueApi)));
}
if (resto === 'issues' && method === 'POST') {
  const i = { iid: siguiente(), state: 'opened', title: cuerpo.title, description: cuerpo.description || '', labels: etiquetas(cuerpo.labels), assignees: deUsuarios(cuerpo.assignee_ids) };
  issues().push(i);
  save();
  out(issueApi(i));
}
if ((x = resto.match(/^issues\/(\d+)(?:\/(time_estimate|add_spent_time|notes))?$/))) {
  const i = issues().find((y) => String(y.iid) === x[1]);
  if (!i) err(404, '404 Not found');
  if (!x[2] && method === 'GET') out(issueApi(i));
  if (!x[2] && method === 'PUT') {
    if (cuerpo.labels !== undefined) i.labels = etiquetas(cuerpo.labels);
    if (cuerpo.state_event === 'close') i.state = 'closed';
    if (cuerpo.state_event === 'reopen') i.state = 'opened';
    save();
    out(issueApi(i));
  }
  if (x[2] === 'notes' && method === 'POST') {
    const k = `${proyecto}#${i.iid}`;
    ((st.notes = st.notes || {})[k] = st.notes[k] || []).push(cuerpo.body);
    save();
    out({ id: st.notes[k].length, body: cuerpo.body });
  }
  if (x[2] && method === 'POST') {
    const s = segundos(cuerpo.duration);
    if (s === null) err(400, '400 Bad request - duration is invalid');
    if (x[2] === 'time_estimate') i.time_estimate = s; else i.total_time_spent = (i.total_time_spent || 0) + s;
    save();
    out(issueApi(i).time_stats);
  }
}

// ── merge requests ──
if (resto === 'merge_requests' && method === 'GET') {
  out(pag(mrs().filter((y) => (!q.state || q.state === 'all' || (y.state || 'opened') === q.state)
    && (!q.source_branch || y.source_branch === q.source_branch) && (!q.target_branch || y.target_branch === q.target_branch)).map(mrApi)));
}
if (resto === 'merge_requests' && method === 'POST') {
  const estado = (st.pipelines || {})[cuerpo.source_branch];
  const nuevo = { iid: siguiente(), state: 'opened', title: cuerpo.title, description: cuerpo.description || '', source_branch: cuerpo.source_branch,
    target_branch: cuerpo.target_branch, sha: (st.shas || {})[cuerpo.source_branch] || 'a'.repeat(40), force_remove_source_branch: cuerpo.remove_source_branch === true,
    has_conflicts: (st.conflicts || []).includes(cuerpo.source_branch), head_pipeline: estado ? { status: estado } : null };
  mrs().push(nuevo);
  save();
  out(mrApi(nuevo));
}
if ((x = resto.match(/^merge_requests\/(\d+)(?:\/(merge|approve))?$/))) {
  const y = mrs().find((z) => String(z.iid) === x[1]);
  if (!y) err(404, '404 Not found');
  if (!x[2] && method === 'GET') out(mrApi(y));
  if (!x[2] && method === 'PUT') {
    for (const k of ['title', 'description']) if (cuerpo[k] !== undefined) y[k] = cuerpo[k];
    if (cuerpo.remove_source_branch !== undefined) y.force_remove_source_branch = cuerpo.remove_source_branch === true;
    save();
    out(mrApi(y));
  }
  if (x[2] === 'approve' && method === 'POST') { y.approved = true; save(); out({ iid: y.iid, approved: true }); }
  if (x[2] === 'merge' && method === 'PUT') {
    if ((y.state || 'opened') !== 'opened') err(405, '405 Method Not Allowed');
    if (y.has_conflicts) err(406, '406 Branch cannot be merged');
    if (cuerpo.sha && cuerpo.sha !== y.sha) err(409, '409 SHA does not match HEAD of source branch');
    if (cuerpo.should_remove_source_branch !== undefined) y.force_remove_source_branch = cuerpo.should_remove_source_branch === true;
    y.merge_commit_message = cuerpo.merge_commit_message || null;
    if (cuerpo.merge_when_pipeline_succeeds) y.merge_when_pipeline_succeeds = true;
    else { y.state = 'merged'; y.merged_at = '2030-01-15T13:00:00Z'; y.merge_commit_sha = 'c'.repeat(40); }
    save();
    out(mrApi(y));
  }
}

// ── un commit, y sus estados ──
if (method === 'GET' && (x = resto.match(/^repository\/commits\/([^/]+)$/))) {
  const ref = decodeURIComponent(x[1]);
  if ((st.gone || []).includes(ref)) err(404, '404 Commit Not Found');
  out({ id: (st.shas || {})[ref] || ref });
}
if (method === 'GET' && (x = resto.match(/^repository\/commits\/([^/]+)\/statuses$/))) {
  const ref = decodeURIComponent(x[1]);
  // con el nombre de una rama GitLab no da los estados de su punta: da una lista vacía
  out(Object.prototype.hasOwnProperty.call(st.shas || {}, ref) ? [] : pag((st.statuses || {})[`${proyecto}@${ref}`] || []));
}
err(404, '404 Not found');
