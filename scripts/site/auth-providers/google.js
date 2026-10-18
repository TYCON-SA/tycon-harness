'use strict';
/*
 * auth-providers/google.js — el inicio de sesión con Google (story 2.23, decisiones 9 y 11; AC 7 y 8).
 *
 * El emisor es fijo (`https://accounts.google.com`). Cualquier cuenta de Google puede pasar por él, así que el sitio se
 * limita a la organización con DOS cosas, las dos obligatorias:
 *   · `SITE_AUTH_ALLOWED_DOMAINS` (sin ella, no arranca);
 *   · la claim `hd` (el dominio de Google Workspace de la cuenta) igual a uno de esos dominios. Una cuenta personal no
 *     trae `hd`: no entra.
 * El correo sale de `email` con `email_verified: true`. La identidad estable es `sub`.
 *
 * Para las pruebas, `SITE_OIDC_ISSUER` puede reemplazar al emisor fijo SÓLO con una dirección http://127.0.0.1 (el
 * emisor local de scripts/tests/lib/fake-oidc.js); cualquier otro valor no arranca.
 */
// lo que este archivo le dice a una persona vive en la tabla del sitio (texts.js, `proveedor.*`); el servidor lo traduce al mostrarlo
const TX = (clave, valores) => require('../texts.js').t('es', clave, valores);
const { proveedorSobreOidc, correoDe, ErrorDeIngreso, dominioDe } = require('../oidc.js');

const EMISOR = 'https://accounts.google.com';
const esDePrueba = (u) => { try { const x = new URL(u); return x.protocol === 'http:' && x.hostname === '127.0.0.1'; } catch { return false; } };

function emisorDe(env) {
  return env.SITE_OIDC_ISSUER && esDePrueba(env.SITE_OIDC_ISSUER) ? env.SITE_OIDC_ISSUER : EMISOR;
}

function problemasDeConfig(env, { dominios }) {
  const p = [];
  if (env.SITE_OIDC_ISSUER && env.SITE_OIDC_ISSUER !== EMISOR && !esDePrueba(env.SITE_OIDC_ISSUER)) p.push({ variable: 'SITE_OIDC_ISSUER', motivo: `con google el emisor es fijo (${EMISOR}): sacá la variable` });
  if (!dominios.length) p.push({ variable: 'SITE_AUTH_ALLOWED_DOMAINS', motivo: 'falta: con google es obligatoria (sin ella entraría cualquier cuenta de Google)' });
  return p;
}

function crear(cfg, { ahora }) {
  return proveedorSobreOidc({
    nombre: 'google', issuer: cfg.issuer, clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri, ahora,
    identidad(claims) {
      const email = correoDe(claims, 'email');
      if (claims.email_verified !== true) throw new ErrorDeIngreso(TX('proveedor.googleSinVerificar'), 'email_verified no es true');
      const hd = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : null;
      if (!hd || !cfg.allowedDomains.includes(hd)) throw new ErrorDeIngreso(TX('proveedor.googleOtraOrg'), hd ? `hd ${hd} fuera de SITE_AUTH_ALLOWED_DOMAINS` : 'sin hd: una cuenta personal');
      if (dominioDe(email) !== hd) throw new ErrorDeIngreso(TX('proveedor.googleOtraOrg'), 'el dominio del correo no es el hd');
      if (typeof claims.sub !== 'string' || !claims.sub) throw new ErrorDeIngreso(TX('proveedor.sinIdentidad'), 'sin sub');
      return { email, sub: claims.sub };
    },
  });
}

/** Lo fijo de Google en la configuración del sitio: su emisor. */
function completarConfig(env, cfg) { cfg.issuer = emisorDe(env); }

/** Con qué se entra, en palabras (Configuración lo muestra). */
const describir = () => TX('proveedor.google');

module.exports = { EMISOR, emisorDe, problemasDeConfig, completarConfig, describir, crear };
