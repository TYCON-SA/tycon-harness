'use strict';
/*
 * fake-github-api.js — la API REST de GitHub que usa la propuesta, en un servidor local (T15 a T27).
 *
 * Sirve en http://127.0.0.1:<puerto>/repos/{owner}/{repo}/... lo que la pestaña Configuración llama (API v3): la rama
 * principal, su protección o sus reglas, los pedidos abiertos, y —para la propuesta de stages— los environments. Anota
 * CADA llamada (`llamadas`: method, ruta, query, auth, cuerpo) y marca las que la pestaña nunca debe hacer: mergear un
 * pedido (`PUT /pulls/{n}/merge`) o pedir el auto-merge (`POST /graphql` con enablePullRequestAutoMerge);
 * `prohibidas()` las devuelve. NUNCA habla con la red.
 *
 *   const g = await arrancarGithubFalso({ owner: 'acme', repo: 'ops', token });
 *   g.base · g.llamadas · g.st · g.prohibidas() · await g.cerrar()
 *
 * `st`: mainOid · proteccion (null = 404, sin protección) · reglas[] · politicas403 · pedidos[] · fallarPedido (500 |
 * 403) · environments[] · environments403 · exigirAuth (la cabecera exacta; con `token`, `Bearer <token>`) · archivosDe(pedido)
 * (las rutas que trae el pedido; sin ella, ninguna).
 */
const http = require('http');

function leerCuerpo(req) {
  return new Promise((resolve) => {
    let t = '';
    req.on('data', (c) => { t += c; });
    req.on('end', () => { try { resolve(t ? JSON.parse(t) : null); } catch { resolve({ __ilegible: t }); } });
  });
}

/*
 * El modo de VARIOS repos (el inventario de adopción del portón): actúa sólo con `st.repos` cargado; sin él, el servidor
 * es el de un repo de siempre. Cada repo: `{ name, archived, default_branch, size, sinRama, flujos: { 'ci.yml': texto },
 * reglas: [], proteccion (null = 404), proteccion403, reglas500, fallarFlujos, cortarCuerpo }` (`cortarCuerpo`: la lista de
 * flujos llega cortada a la mitad). `st.reposPorPagina` parte la lista
 * con el encabezado `Link`; `st.fallarListaRepos` (código) la hace fallar entera y `st.fallarPaginaRepos` (número de
 * página) sólo esa. Devuelve true si contestó.
 */
function variosRepos(st, owner, u, ruta, res, host) {
  const json = (status, doc, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(doc)); return true; };
  if (ruta === `/orgs/${owner}/repos`) {
    if (st.fallarListaRepos) return json(st.fallarListaRepos, { message: 'lista de repos caída' });
    const tam = Number(st.reposPorPagina || u.searchParams.get('per_page') || 30);
    const pagina = Number(u.searchParams.get('page') || 1);
    if (st.fallarPaginaRepos === pagina) return json(500, { message: `página ${pagina} caída` });
    const lista = st.repos.slice((pagina - 1) * tam, pagina * tam).map((r) => ({ name: r.name, full_name: `${owner}/${r.name}`, archived: !!r.archived, size: r.size === undefined ? 100 : r.size, default_branch: r.default_branch === undefined ? 'main' : r.default_branch }));
    const sig = new URL(`${u.pathname}${u.search}`, `http://${host}`); sig.searchParams.set('page', String(pagina + 1));
    const link = pagina * tam < st.repos.length ? { link: `<${sig.href}>; rel="next"` } : {};
    return json(200, lista, link);
  }
  const m = new RegExp(`^/repos/${owner}/([^/]+)/(.+)$`).exec(ruta);
  if (!m) return false;
  const r = st.repos.find((x) => x.name === m[1]);
  if (!r) return json(404, { message: 'Not Found' });
  const resto = m[2];
  const rama = r.default_branch === undefined ? 'main' : r.default_branch;
  if (resto === `branches/${rama}`) return r.sinRama ? json(404, { message: 'Branch not found' }) : json(200, { name: rama, commit: { sha: 'c'.repeat(40) } });
  if (resto === 'contents/.github/workflows') {
    if (r.fallarFlujos) return json(r.fallarFlujos, { message: 'flujos ilegibles' });
    // la respuesta se corta a la mitad: llegan las cabeceras y parte del cuerpo, y la conexión se cae
    if (r.cortarCuerpo) { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '500' }); res.write('[{"name":'); res.destroy(); return true; }
    const nombres = Object.keys(r.flujos || {});
    if (!nombres.length) return json(404, { message: 'Not Found' });
    return json(200, nombres.map((n) => ({ name: n, path: `.github/workflows/${n}`, type: 'file' })));
  }
  const a = /^contents\/\.github\/workflows\/(.+)$/.exec(resto);
  if (a) {
    if (r.fallarArchivo) return json(r.fallarArchivo, { message: 'archivo ilegible' });
    const txt = (r.flujos || {})[a[1]];
    return txt === undefined ? json(404, { message: 'Not Found' }) : json(200, { name: a[1], encoding: 'base64', content: Buffer.from(txt).toString('base64') });
  }
  if (resto === `rules/branches/${rama}`) return r.reglas500 ? json(500, { message: 'reglas caídas' }) : json(200, r.reglas || []);
  if (resto === `branches/${rama}/protection`) {
    if (r.proteccion403) return json(403, { message: 'Resource not accessible by integration' });
    return r.proteccion ? json(200, r.proteccion) : json(404, { message: 'Branch not protected' });
  }
  return false;
}

async function arrancarGithubFalso({ owner = 'acme', repo = 'ops', token } = {}) {
  const llamadas = [];
  const st = {
    mainOid: 'b'.repeat(40), proteccion: null, reglas: [], politicas403: false, pedidos: [], fallarPedido: null,
    environments: [], environments403: false, mergeDirecto: 200, autoMerge: 'ok', exigirAuth: token ? `Bearer ${token}` : null,
  };
  let siguiente = 1;
  const web = `https://github.example/${owner}/${repo}`;
  const prefijo = `/repos/${owner}/${repo}/`;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const ruta = decodeURIComponent(u.pathname);
    const cuerpo = (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') ? await leerCuerpo(req) : null;
    const auth = req.headers.authorization || null;
    const llamada = { method: req.method, ruta, query: Object.fromEntries(u.searchParams), auth, cuerpo, accept: req.headers.accept || null, prohibida: false };
    llamadas.push(llamada);
    const json = (status, doc) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(doc)); };
    if (!auth || (st.exigirAuth && auth !== st.exigirAuth)) return json(401, { message: 'Bad credentials' });
    if (req.method === 'POST' && ruta === '/graphql') {
      if (/enablePullRequestAutoMerge|mergePullRequest/.test(JSON.stringify(cuerpo || {}))) llamada.prohibida = true;
      if (/enablePullRequestAutoMerge/.test(JSON.stringify(cuerpo || {}))) {
        if (st.autoMerge !== 'ok') return json(200, { data: { enablePullRequestAutoMerge: null }, errors: [{ message: st.autoMerge }] });
        return json(200, { data: { enablePullRequestAutoMerge: { pullRequest: { number: 1 } } } });
      }
      return json(200, { data: {} });
    }
    if (st.repos && req.method === 'GET' && variosRepos(st, owner, u, ruta, res, req.headers.host)) return;
    if (!ruta.startsWith(prefijo)) return json(404, { message: 'Not Found' });
    const resto = ruta.slice(prefijo.length);
    let m;
    if (req.method === 'GET' && resto === 'branches/main') return json(200, { name: 'main', commit: { sha: st.mainOid }, protected: !!st.proteccion });
    if (req.method === 'GET' && resto === 'branches/main/protection') {
      if (st.politicas403) return json(403, { message: 'Resource not accessible by integration' });
      return st.proteccion ? json(200, st.proteccion) : json(404, { message: 'Branch not protected' });
    }
    if (req.method === 'GET' && resto === 'rules/branches/main') {
      if (st.politicas403) return json(403, { message: 'Resource not accessible by integration' });
      return json(200, st.reglas);
    }
    if (resto === 'pulls') {
      if (req.method === 'GET') {
        const estado = u.searchParams.get('state') || 'open';
        const base = u.searchParams.get('base');
        // como GitHub: de a 30 por página si no se pide otra cosa, con tope de 100
        const porPagina = Math.min(Number(u.searchParams.get('per_page')) || 30, 100);
        const pagina = Math.max(Number(u.searchParams.get('page')) || 1, 1);
        return json(200, st.pedidos.filter((p) => (estado === 'all' || p.state === estado) && (!base || p.base.ref === base)).slice((pagina - 1) * porPagina, pagina * porPagina));
      }
      if (req.method === 'POST') {
        if (st.fallarPedido) return json(st.fallarPedido, { message: st.fallarPedido === 403 ? 'Resource not accessible by personal access token' : 'Server Error' });
        if (!cuerpo || !cuerpo.title || !cuerpo.head || !cuerpo.base) return json(422, { message: 'Validation Failed' });
        const n = siguiente; siguiente += 1;
        const pedido = { number: n, node_id: `PR_nodo${n}`, state: 'open', html_url: `${web}/pull/${n}`, title: cuerpo.title, body: cuerpo.body || '', head: { ref: cuerpo.head }, base: { ref: cuerpo.base } };
        st.pedidos.push(pedido);
        return json(201, pedido);
      }
    }
    if ((m = /^pulls\/(\d+)\/merge$/.exec(resto)) && req.method === 'PUT') {
      llamada.prohibida = true;
      if (st.mergeDirecto === 'perdido') return json(502, { message: 'Bad Gateway' });
      if (st.mergeDirecto !== 200) return json(st.mergeDirecto, { message: 'At least 1 approving review is required by reviewers with write access.' });
      return json(200, { merged: true, sha: 'c'.repeat(40) });
    }
    if ((m = /^pulls\/(\d+)\/files$/.exec(resto)) && req.method === 'GET') {
      const pedido = st.pedidos.find((p) => p.number === Number(m[1]));
      if (!pedido) return json(404, { message: 'Not Found' });
      const porPagina = Math.min(Number(u.searchParams.get('per_page')) || 30, 100);
      const pagina = Math.max(Number(u.searchParams.get('page')) || 1, 1);
      return json(200, (st.archivosDe ? st.archivosDe(pedido) : []).map((filename) => ({ filename, status: 'added' })).slice((pagina - 1) * porPagina, pagina * porPagina));
    }
    if ((m = /^pulls\/(\d+)$/.exec(resto)) && req.method === 'GET') {
      const pedido = st.pedidos.find((p) => p.number === Number(m[1]));
      return pedido ? json(200, { ...pedido, merged: st.mergeDirecto === 'perdido' }) : json(404, { message: 'Not Found' });
    }
    if ((m = /^pulls\/(\d+)$/.exec(resto)) && req.method === 'PATCH') { llamada.prohibida = true; return json(200, {}); }
    if (req.method === 'GET' && resto === 'environments') {
      if (st.environments403) return json(403, { message: 'Resource not accessible by personal access token' });
      return json(200, { total_count: st.environments.length, environments: st.environments });
    }
    return json(404, { message: `Not Found: ${req.method} ${resto}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    llamadas, st,
    /** Las llamadas que la pestaña nunca debe hacer: mergear, auto-merge o editar un pedido. */
    prohibidas: () => llamadas.filter((l) => l.prohibida),
    cerrar: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }),
  };
}

module.exports = { arrancarGithubFalso };
