'use strict';
// toy-azure-server.js — un Azure DevOps de JUGUETE para las pruebas de la capa del equipo (story 8.25, fuente Azure).
//
// Atiende, sobre repos bare de git, lo que `scripts/setup/harness/team-azure.js` pide por la API de Azure DevOps (forma
// 7.1): la ref de una rama, un commit (su treeId), un árbol recursivo (rutas con modo y tipo) y el contenido de un item en
// un commit. Y el acceso tal como Azure lo da: `Authorization: Basic base64(:PAT)`; sin credencial contesta como Azure a un
// anónimo (una página de login, 203/302, nunca JSON); una credencial que no vale, 401; una que vale y no ve el repo, 403
// (TF401019 cuando el repo no existe: 404). Nada sale a la red: localhost.
//
// Rutas: https://dev.azure.com/<org>/<proyecto>/_apis/git/repositories/<repo>/{refs,commits/<sha>,trees/<sha>,items}
// (el prefijo lo da `--org`/`--project`; el nombre del repo, `--name`; `--repo` es el bare).
//
// Control (`--control <json>`, releído en cada pedido): { "pat": "<el PAT que vale>" | null (sin credencial: todo pasa),
//   "blind": true (la credencial vale pero no ve el repo: 403), "missing_repo": true (404 TF401019), "ratelimit": true,
//   "mute": true (acepta y calla), "latency_ms": N, "truncate_tree": true (la lista del árbol cortada: Azure no lo hace,
//   pero el cliente tiene que tratar una lista incompleta), "tamper_item": "<ruta>" (ese item vuelve con otro contenido:
//   su blob ya no es el objectId de la lista) }.
// Registro (`--log`): un JSON por pedido con host, ruta, si traía credencial (sha256, nunca el valor) y el repo.
//
// Medido contra la API real el 2026-10-08 (repo del equipo de TYCON): el árbol recursivo trae `mode` "40000" para los
// árboles (sin el cero adelante) y "100644" para los blobs; un anónimo Y un PAT inválido reciben 302 a la página de login
// (no 401); el item crudo con `Accept: application/octet-stream` vuelve tal cual y su blob es el objectId de la lista.
//
// Uso: node toy-azure-server.js --repo <bare> --org <o> --project <p> --name <n> [--git <ruta>] [--control <json>] [--log <archivo>] --port-file <archivo>
//   El archivo de puertos queda con `AZURE=http://127.0.0.1:<p>` cuando escucha.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function arg(name, def = null) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def; }
const REPO = arg('--repo'), ORG = arg('--org', 'acme'), PROJECT = arg('--project', 'proyecto'), NAME = arg('--name', 'equipo-lab');
const CONTROL = arg('--control'), LOG = arg('--log'), PORT_FILE = arg('--port-file');
const GIT = arg('--git', 'git');
if (!REPO || !PORT_FILE) { process.stderr.write('uso: toy-azure-server.js --repo <bare> --org <o> --project <p> --name <n> [--git <ruta>] [--control <json>] [--log <archivo>] --port-file <archivo>\n'); process.exit(2); }

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const git = (args, opts = {}) => spawnSync(GIT, ['-C', REPO, ...args], Object.assign({ encoding: 'utf8' }, opts));
const control = () => { try { return JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch (_) { return { pat: null }; } };
const log = (o) => { if (LOG) { try { fs.appendFileSync(LOG, `${JSON.stringify(o)}\n`); } catch (_) { /* nada */ } } };

const send = (res, code, body, headers = {}) => {
  if (body === null) { res.writeHead(code, headers); return res.end(); }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, Object.assign({ 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : (typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'), 'Content-Length': String(buf.length) }, headers));
  res.end(buf);
};
// Azure a un anónimo (y a un PAT inválido, medido el 2026-10-08): 302 a la página de login, nunca JSON — el cliente no sigue la
// redirección y tiene que decir «sin credencial / no vale», no «sin red»
const anonymous = (res) => send(res, 302, '<!DOCTYPE html><html><head><title>Azure DevOps Services | Sign In</title></head><body>Sign in</body></html>', { Location: 'https://spsprodcus3.vssps.visualstudio.com/_signin?realm=dev.azure.com' });
const azureError = (res, code, typeKey, message) => send(res, code, { $id: '1', innerException: null, message, typeName: `Microsoft.TeamFoundation.Git.Server.${typeKey}Exception`, typeKey: `${typeKey}Exception`, errorCode: 0, eventId: 3000 });

/** La credencial del pedido: `{ given, pat }` (Basic base64(usuario:pat); Azure ignora el usuario). */
function credentialOf(req) {
  const h = req.headers.authorization || '';
  const m = /^Basic (.+)$/.exec(h);
  if (!m) return { given: false, pat: null };
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch (_) { decoded = ''; }
  const i = decoded.indexOf(':');
  return { given: true, pat: i >= 0 ? decoded.slice(i + 1) : decoded };
}

function api(req, res) {
  const c = control();
  const u = new URL(req.url, 'http://azure');
  const cred = credentialOf(req);
  log({ host: 'azure', method: req.method, path: u.pathname + u.search, auth: cred.given, auth_sha256: cred.given ? sha256(cred.pat) : null });
  const go = () => {
    if (c.mute) return;
    if (c.ratelimit) return send(res, 429, { message: 'TF400733: The request has been canceled: Request was blocked due to exceeding usage of resource' }, { 'Retry-After': '30' });
    const prefix = `/${ORG}/${PROJECT}/_apis/git/repositories/${NAME}/`;
    // el acceso, como Azure: sin credencial → página de login; credencial que no vale → 401; vale y no ve el repo → 403
    if (c.pat) {
      if (!cred.given) return anonymous(res);
      if (cred.pat !== c.pat) return anonymous(res);   // un PAT inválido recibe LO MISMO que un anónimo (medido contra la API real)
    }
    if (!u.pathname.startsWith(prefix)) {
      // otro proyecto u otro repo: 404 con el error de Azure (TF200016 proyecto · TF401019 repo)
      if (u.pathname.startsWith(`/${ORG}/${PROJECT}/_apis/git/repositories/`)) return azureError(res, 404, 'GitRepositoryNotFound', `TF401019: The Git repository with name or identifier ${u.pathname.split('/')[6] || '?'} does not exist or you do not have permissions for the operation you are attempting.`);
      return azureError(res, 404, 'ProjectDoesNotExist', `TF200016: The following project does not exist: ${u.pathname.split('/')[2] || '?'}. Verify that the name of the project is correct and that the project exists on the specified Azure DevOps Server.`);
    }
    if (c.blind) return azureError(res, 403, 'GitRepositoryNotFound', `TF401027: You need the Git 'Read' permission to perform this action. Details: identity '${sha256(cred.pat || '').slice(0, 8)}', scope 'repository'.`);
    if (c.missing_repo) return azureError(res, 404, 'GitRepositoryNotFound', `TF401019: The Git repository with name or identifier ${NAME} does not exist or you do not have permissions for the operation you are attempting.`);
    const rest = u.pathname.slice(prefix.length);
    let m;
    if (rest === 'refs') {
      // como Azure: `filter` es un PREFIJO del nombre sin `refs/` (heads/main trae también heads/main-old)
      const filter = u.searchParams.get('filter') || 'heads/';
      const r = git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/']);
      const value = r.stdout.split('\n').filter(Boolean).map((l) => { const [name, sha] = l.split(' '); return { name, sha }; })
        .filter((x) => x.name.startsWith(`refs/${filter}`))
        .map((x) => ({ name: x.name, objectId: c.ref_moved_to || x.sha, creator: { displayName: 'Lab' }, url: `${u.origin}${prefix}refs?filter=${filter}` }));
      return send(res, 200, { value, count: value.length });
    }
    if ((m = /^commits\/([0-9a-f]{7,40})$/.exec(rest))) {
      const t = git(['rev-parse', '--verify', '-q', `${m[1]}^{tree}`]);
      if (t.status !== 0) return azureError(res, 404, 'GitObjectNotFound', `TF401175: The version descriptor <Commit: ${m[1]}> could not be resolved to a commit.`);
      return send(res, 200, { commitId: git(['rev-parse', m[1]]).stdout.trim(), treeId: t.stdout.trim(), comment: git(['log', '-1', '--format=%s', m[1]]).stdout.trim(), author: { name: 'Lab' }, committer: { name: 'Lab' } });
    }
    if ((m = /^trees\/([0-9a-f]{7,40})$/.exec(rest))) {
      const recursive = u.searchParams.get('recursive') === 'true';
      const r = git(['ls-tree', '-l', ...(recursive ? ['-r', '-t'] : []), m[1]]);
      if (r.status !== 0) return azureError(res, 404, 'GitObjectNotFound', `TF401175: The tree ${m[1]} could not be resolved.`);
      let entries = r.stdout.split('\n').filter(Boolean).map((l) => {
        const [meta, p] = l.split('\t');
        const [mode, type, sha, size] = meta.trim().split(/\s+/);
        return { objectId: sha, relativePath: p, mode, gitObjectType: type, size: type === 'blob' ? Number(size) : 0, url: `${u.origin}${prefix}${type === 'tree' ? 'trees' : 'blobs'}/${sha}` };
      });
      if (c.truncated_tree) entries = entries.slice(0, Math.max(1, Math.floor(entries.length / 2)));
      return send(res, 200, { objectId: git(['rev-parse', m[1]]).stdout.trim(), treeEntries: entries, size: entries.length, url: `${u.origin}${u.pathname}` });
    }
    if (rest === 'items') {
      const p = (u.searchParams.get('path') || '/').replace(/^\/+/, '');
      const version = u.searchParams.get('versionDescriptor.version') || u.searchParams.get('versionDescriptor[version]') || 'main';
      const type = u.searchParams.get('versionDescriptor.versionType') || u.searchParams.get('versionDescriptor[versionType]') || 'branch';
      const ref = type === 'commit' ? version : (type === 'tag' ? `refs/tags/${version}` : `refs/heads/${version}`);
      const blob = git(['rev-parse', '--verify', '-q', `${ref}:${p}`]);
      if (blob.status !== 0) return azureError(res, 404, 'GitItemNotFound', `TF401174: The item ${p} could not be found in the repository ${NAME} at the version specified by ${version}.`);
      let content = git(['show', `${ref}:${p}`], { encoding: 'buffer' }).stdout;
      if (c.tamper_item && c.tamper_item === p) { content = Buffer.from(content); content[0] = content[0] === 0x7b ? 0x5b : 0x7b; }   // otro primer byte: otro blob
      const wantsJson = /application\/json/.test(String(req.headers.accept || '')) && !/octet-stream/.test(String(req.headers.accept || ''));
      if (wantsJson) return send(res, 200, { objectId: blob.stdout.trim(), gitObjectType: 'blob', commitId: git(['rev-parse', ref]).stdout.trim(), path: `/${p}`, content: content.toString('utf8'), contentMetadata: { encoding: 65001, fileName: path.basename(p) }, url: `${u.origin}${u.pathname}` });
      return send(res, 200, content, { 'Content-Type': 'application/octet-stream' });
    }
    return azureError(res, 404, 'ResourceNotFound', `No HTTP resource was found that matches the request URI '${u.pathname}'.`);
  };
  if (c.latency_ms) setTimeout(go, c.latency_ms); else go();
}

const srv = http.createServer(api);
srv.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(PORT_FILE, `AZURE=http://127.0.0.1:${srv.address().port}\n`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { srv.close(); process.exit(0); });
