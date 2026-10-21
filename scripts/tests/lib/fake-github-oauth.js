'use strict';
/*
 * fake-github-oauth.js — GitHub OAuth y las tres lecturas de su API que hace el sitio, en local.
 *
 * Una sola dirección http://127.0.0.1:<puerto> hace de las dos de GitHub: la del inicio de sesión (`/login/oauth/…`) y la
 * de la API (`/api/user`, `/api/user/emails`, `/api/user/memberships/orgs/<org>`). NUNCA habla con la red.
 *
 *   · `emitirCodigo({ usuario, challenge })` → un código de un solo uso. `usuario` = { id, login, emails: [{ email,
 *     primary, verified }], orgs: { <org>: 'active' | 'pending' } }. El canje exige el secreto del cliente y, si hubo
 *     challenge, el `code_verifier` cuyo S256 coincide.
 *   · `pedidos` → las rutas pedidas, para afirmar qué consultó el sitio.
 */
const http = require('http');
const crypto = require('crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');

async function arrancarGithub({ clientId = 'gh-client', clientSecret = 'gh-secret' } = {}) {
  const codigos = new Map();
  const tokens = new Map();
  const pedidos = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    pedidos.push(`${req.method} ${u.pathname}`);
    const json = (status, cuerpo) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(cuerpo)); };
    if (u.pathname === '/login/oauth/access_token' && req.method === 'POST') {
      let cuerpo = '';
      req.on('data', (c) => { cuerpo += c; });
      req.on('end', () => {
        const p = new URLSearchParams(cuerpo);
        const intento = codigos.get(p.get('code'));
        codigos.delete(p.get('code'));
        if (!intento) return json(200, { error: 'bad_verification_code' });
        if (p.get('client_id') !== clientId || p.get('client_secret') !== clientSecret) return json(200, { error: 'incorrect_client_credentials' });
        if (intento.challenge && b64u(crypto.createHash('sha256').update(p.get('code_verifier') || '').digest()) !== intento.challenge) return json(200, { error: 'bad_verification_code' });
        const token = crypto.randomBytes(12).toString('hex');
        tokens.set(token, intento.usuario);
        return json(200, { access_token: token, token_type: 'bearer', scope: 'read:user,user:email,read:org' });
      });
      return undefined;
    }
    const auth = String(req.headers.authorization || '');
    const usuario = tokens.get(auth.replace(/^Bearer /, ''));
    if (u.pathname.startsWith('/api/')) {
      if (!usuario) return json(401, { message: 'Bad credentials' });
      if (u.pathname === '/api/user') return json(200, { id: usuario.id, login: usuario.login });
      if (u.pathname === '/api/user/emails') return json(200, usuario.emails || []);
      const m = u.pathname.match(/^\/api\/user\/memberships\/orgs\/([^/]+)$/);
      if (m) {
        const estado = (usuario.orgs || {})[decodeURIComponent(m[1])];
        if (!estado) return json(404, { message: 'Not Found' });
        return json(200, { state: estado, role: 'member', organization: { login: decodeURIComponent(m[1]) } });
      }
    }
    return json(404, { message: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, api: `${base}/api`, clientId, clientSecret, pedidos,
    emitirCodigo: ({ usuario, challenge }) => { const code = crypto.randomBytes(12).toString('hex'); codigos.set(code, { usuario, challenge }); return code; },
    cerrar: () => new Promise((r) => server.close(() => r())),
  };
}

module.exports = { arrancarGithub };
