'use strict';
/*
 * fake-ado-api.js — la API REST de Azure DevOps que usa la propuesta, en un servidor local (story 2.29, T15 a T27).
 *
 * Sirve en http://127.0.0.1:<puerto>/{org}/{project}/_apis/ lo que la pestaña Configuración llama (api-version 7.1):
 * refs y pedidos del repo, las políticas de la rama principal, y —para la propuesta de stages— la definición de un
 * pipeline, su última corrida y el timeline. Anota CADA llamada (`llamadas`: method, ruta, query, auth, cuerpo) y marca
 * las que la pestaña nunca debe hacer: un pedido con `autoCompleteSetBy` o `completionOptions` (auto-completar) y un
 * PATCH al pedido (`prohibidas()` las devuelve). NUNCA habla con la red.
 *
 *   const a = await arrancarAdoFalso({ org: 'acme', project: 'Proy', repo: 'ops', token });
 *   a.base · a.llamadas · a.st · a.prohibidas() · a.politicaDeRevisores(n) · await a.cerrar()
 *
 * `st`: mainOid · pedidos[] · fallarPedido (500 | 403) · politicas[] · politicas403 · repoId · pipelines{} · builds{} ·
 * timeline[] · pipelines403 · exigirAuth (la cabecera exacta; con `token`, `Basic base64(':' + token)`).
 */
const http = require('http');

// el tipo se reconoce por `displayName`; el id de verdad es un GUID y acá va uno inventado (el freno de publicación lo tomaría por interno)
const TIPO_REVISORES = { id: 'tipo-minimo-de-revisores', displayName: 'Minimum number of reviewers' };

function leerCuerpo(req) {
  return new Promise((resolve) => {
    let t = '';
    req.on('data', (c) => { t += c; });
    req.on('end', () => { try { resolve(t ? JSON.parse(t) : null); } catch { resolve({ __ilegible: t }); } });
  });
}

async function arrancarAdoFalso({ org = 'acme', project = 'Proy', repo = 'ops', token } = {}) {
  const llamadas = [];
  const st = {
    mainOid: 'a'.repeat(40), pedidos: [], fallarPedido: null, politicas: [], politicas403: false, repoId: 'r-0001',
    pipelines: {}, builds: {}, timeline: [], pipelines403: false,
    exigirAuth: token ? `Basic ${Buffer.from(`:${token}`).toString('base64')}` : null,
  };
  let siguienteId = 100;
  const webRepo = `https://dev.azure.example/${org}/${project}/_git/${repo}`;
  const prefijo = `/${org}/${project}/_apis/`;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const ruta = decodeURIComponent(u.pathname);
    const cuerpo = (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') ? await leerCuerpo(req) : null;
    const auth = req.headers.authorization || null;
    const llamada = { method: req.method, ruta, query: Object.fromEntries(u.searchParams), auth, cuerpo, autoCompletar: !!(cuerpo && (cuerpo.autoCompleteSetBy || cuerpo.completionOptions)), prohibida: false };
    llamadas.push(llamada);
    const json = (status, doc) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(doc)); };
    if (!auth || (st.exigirAuth && auth !== st.exigirAuth)) return json(401, { message: 'sin credencial' });
    if (!ruta.startsWith(prefijo)) return json(404, { message: `fuera de ${prefijo}` });
    const resto = ruta.slice(prefijo.length);
    let m;
    if (req.method === 'GET' && resto === `git/repositories/${repo}`) return json(200, { id: st.repoId, name: repo, webUrl: webRepo });
    if (req.method === 'GET' && resto === `git/repositories/${repo}/refs`) {
      const filtro = u.searchParams.get('filter') || '';
      const refs = [{ name: 'refs/heads/main', objectId: st.mainOid }].filter((r) => r.name.startsWith(`refs/${filtro}`));
      return json(200, { value: refs, count: refs.length });
    }
    if (resto === `git/repositories/${repo}/pullrequests`) {
      if (req.method === 'GET') {
        const estado = u.searchParams.get('searchCriteria.status') || 'active';
        const destino = u.searchParams.get('searchCriteria.targetRefName');
        const v = st.pedidos.filter((p) => (estado === 'all' || p.status === estado) && (!destino || p.targetRefName === destino));
        return json(200, { value: v, count: v.length });
      }
      if (req.method === 'POST') {
        if (llamada.autoCompletar) llamada.prohibida = true;
        if (st.fallarPedido) return json(st.fallarPedido, { message: st.fallarPedido === 403 ? 'TF401027: sin permiso para abrir pedidos' : 'se cayó el servidor' });
        if (!cuerpo || !cuerpo.sourceRefName || !cuerpo.targetRefName || !cuerpo.title) return json(400, { message: 'faltan sourceRefName, targetRefName o title' });
        const id = siguienteId; siguienteId += 1;
        const pedido = { pullRequestId: id, status: 'active', sourceRefName: cuerpo.sourceRefName, targetRefName: cuerpo.targetRefName, title: cuerpo.title, description: cuerpo.description || '', url: `${u.origin}${prefijo}git/repositories/${st.repoId}/pullRequests/${id}`, webUrl: `${webRepo}/pullrequest/${id}` };
        st.pedidos.push(pedido);
        return json(201, { ...pedido, repository: { id: st.repoId, name: repo, webUrl: webRepo } });
      }
    }
    if ((m = new RegExp(`^git/repositories/${repo}/pullrequests/(\\d+)$`).exec(resto)) && req.method === 'PATCH') {
      llamada.prohibida = true;
      const p = st.pedidos.find((x) => String(x.pullRequestId) === m[1]);
      return p ? json(200, p) : json(404, { message: 'no existe el pedido' });
    }
    if (req.method === 'GET' && resto === 'policy/configurations') {
      if (st.politicas403) return json(403, { message: 'TF400813: la identidad no tiene permiso para leer políticas' });
      const repoId = u.searchParams.get('repositoryId');
      const refName = u.searchParams.get('refName');
      const v = st.politicas.filter((p) => !repoId || !p.settings || !Array.isArray(p.settings.scope) || p.settings.scope.some((s) => (!s.repositoryId || s.repositoryId === repoId) && (!refName || s.refName === refName)));
      return json(200, { value: v, count: v.length });
    }
    if (req.method === 'GET' && (m = /^pipelines\/(\d+)$/.exec(resto))) {
      if (st.pipelines403) return json(403, { message: 'sin permiso sobre pipelines' });
      const p = st.pipelines[m[1]];
      return p ? json(200, { id: Number(m[1]), name: p.name, configuration: { path: p.path, type: 'yaml' } }) : json(404, { message: 'no existe el pipeline' });
    }
    if (req.method === 'GET' && resto === 'build/builds') {
      if (st.pipelines403) return json(403, { message: 'sin permiso sobre corridas' });
      const def = u.searchParams.get('definitions');
      const v = (st.builds[def] || []).slice(0, Number(u.searchParams.get('$top') || 1)).map((b) => ({ id: b.id, result: b.result || 'succeeded', sourceBranch: 'refs/heads/main' }));
      return json(200, { value: v, count: v.length });
    }
    if (req.method === 'GET' && (m = /^build\/builds\/(\d+)\/timeline$/.exec(resto))) {
      if (st.pipelines403) return json(403, { message: 'sin permiso sobre corridas' });
      return json(200, { records: st.timeline });
    }
    return json(404, { message: `ruta desconocida: ${req.method} ${resto}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    llamadas, st,
    /** Las llamadas que la pestaña nunca debe hacer: auto-completar o editar un pedido. */
    prohibidas: () => llamadas.filter((l) => l.prohibida),
    /** Una política «al menos N revisores», habilitada y bloqueante, sobre refs/heads/main de este repo. */
    politicaDeRevisores: (n = 1) => ({ isEnabled: true, isBlocking: true, type: { ...TIPO_REVISORES }, settings: { minimumApproverCount: n, creatorVoteCounts: false, scope: [{ refName: 'refs/heads/main', matchKind: 'Exact', repositoryId: st.repoId }] } }),
    cerrar: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }),
  };
}

module.exports = { arrancarAdoFalso, TIPO_REVISORES };
