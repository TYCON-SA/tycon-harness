'use strict';
/*
 * auth-providers/github.js — el inicio de sesión con GitHub (story 2.23, decisiones 9 y 11; AC 7 y 8).
 *
 * GitHub no emite id_token: va por su OAuth (código, `state`, PKCE S256 —GitHub lo admite desde 2025; un servidor que
 * lo ignore igual exige el `state`—) y tres lecturas de su API con el token de la persona:
 *   · `GET /user`                              → el id numérico: la identidad estable (`github:<id>`), nunca el `login`;
 *   · `GET /user/emails`                       → el correo PRIMARIO y VERIFICADO; sin él, no se entra;
 *   · `GET /user/memberships/orgs/<org>`       → `state: active` en `SITE_AUTH_GITHUB_ORG` (obligatoria: sin ella
 *                                                entraría cualquier cuenta de GitHub); pendiente o ausente, no se entra.
 * Alcances pedidos: `read:user user:email read:org`.
 *
 * Para las pruebas, `SITE_GITHUB_URL` y `SITE_GITHUB_API_URL` reemplazan a las direcciones fijas SÓLO con una dirección
 * http://127.0.0.1 (scripts/tests/lib/fake-github-oauth.js); cualquier otro valor no arranca.
 */
const { pedir, ErrorOidc, ErrorDeIngreso, limitarDominio, CORREO, codigoOAuth } = require('../oidc.js');

const WEB = 'https://github.com';
const API = 'https://api.github.com';
const esDePrueba = (u) => { try { const x = new URL(u); return x.protocol === 'http:' && x.hostname === '127.0.0.1'; } catch { return false; } };

function direcciones(env) {
  return {
    web: env.SITE_GITHUB_URL && esDePrueba(env.SITE_GITHUB_URL) ? env.SITE_GITHUB_URL.replace(/\/+$/, '') : WEB,
    api: env.SITE_GITHUB_API_URL && esDePrueba(env.SITE_GITHUB_API_URL) ? env.SITE_GITHUB_API_URL.replace(/\/+$/, '') : API,
  };
}

function problemasDeConfig(env) {
  const p = [];
  if (!env.SITE_AUTH_GITHUB_ORG) p.push({ variable: 'SITE_AUTH_GITHUB_ORG', motivo: 'falta: con github es obligatoria (sin ella entraría cualquier cuenta de GitHub)' });
  else if (!/^[A-Za-z0-9-]{1,39}$/.test(env.SITE_AUTH_GITHUB_ORG)) p.push({ variable: 'SITE_AUTH_GITHUB_ORG', motivo: 'no tiene la forma de una organización de GitHub' });
  for (const v of ['SITE_GITHUB_URL', 'SITE_GITHUB_API_URL']) {
    if (env[v] && !esDePrueba(env[v])) p.push({ variable: v, motivo: 'GitHub tiene sus direcciones fijas: esta variable sólo vale en pruebas, con http://127.0.0.1' });
  }
  if (env.SITE_OIDC_ISSUER) p.push({ variable: 'SITE_OIDC_ISSUER', motivo: 'con github no hay emisor OIDC: sacá la variable' });
  return p;
}

async function apiJson(base, ruta, token) {
  const r = await pedir(`${base}${ruta}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` } });
  if (r.error) throw new ErrorOidc(`sin respuesta de la API de GitHub (${r.error.code || r.error.message})`);
  let json = null;
  try { json = JSON.parse(r.cuerpo); } catch { /* abajo */ }
  return { status: r.status, json };
}

function crear(cfg) {
  const { web, api } = cfg.github;
  return {
    nombre: 'github',
    emisor: web,
    preparar: async () => {},
    listo: () => true,
    urlDeInicio({ state, challenge }) {
      const u = new URL(`${web}/login/oauth/authorize`);
      const p = { client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: 'read:user user:email read:org', state, code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'false' };
      for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
      return u.toString();
    },
    async completar({ code, verifier }) {
      const body = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: cfg.redirectUri, code_verifier: verifier }).toString();
      const r = await pedir(`${web}/login/oauth/access_token`, { method: 'POST', body, headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' } });
      if (r.error) throw new ErrorOidc(`sin respuesta de GitHub al canjear (${r.error.code || r.error.message})`);
      let tok = null;
      try { tok = JSON.parse(r.cuerpo); } catch { /* abajo */ }
      if (r.status !== 200 || !tok || typeof tok.access_token !== 'string') throw new ErrorOidc(`GitHub no canjeó el código (${tok && tok.error ? codigoOAuth(tok.error) : r.status})`);
      const token = tok.access_token;

      const user = await apiJson(api, '/user', token);
      if (user.status !== 200 || !user.json || !Number.isInteger(user.json.id)) throw new ErrorOidc(`GET /user contestó ${user.status}`);
      const emails = await apiJson(api, '/user/emails', token);
      if (emails.status !== 200 || !Array.isArray(emails.json)) throw new ErrorOidc(`GET /user/emails contestó ${emails.status}`);
      const primario = emails.json.find((e) => e && e.primary === true);
      if (!primario || primario.verified !== true || typeof primario.email !== 'string' || !CORREO.test(primario.email.trim())) {
        throw new ErrorDeIngreso('tu cuenta de GitHub no tiene un correo primario verificado', 'sin correo primario verificado');
      }
      const email = primario.email.trim().toLowerCase();
      const m = await apiJson(api, `/user/memberships/orgs/${encodeURIComponent(cfg.githubOrg)}`, token);
      if (m.status !== 200 || !m.json || m.json.state !== 'active') {
        throw new ErrorDeIngreso('tu cuenta de GitHub no es miembro activo de la organización', `membresía: ${m.status === 200 && m.json ? String(m.json.state).slice(0, 20) : m.status}`);
      }
      limitarDominio(email, cfg.allowedDomains);
      return { email, sub: `github:${user.json.id}` };
    },
  };
}

/** Lo fijo de GitHub en la configuración del sitio: sus direcciones y la organización. */
function completarConfig(env, cfg) { cfg.github = direcciones(env); cfg.githubOrg = env.SITE_AUTH_GITHUB_ORG; }

module.exports = { WEB, API, direcciones, problemasDeConfig, completarConfig, crear };
