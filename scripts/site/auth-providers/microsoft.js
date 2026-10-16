'use strict';
/*
 * auth-providers/microsoft.js — el inicio de sesión con Entra ID (story 2.23, decisiones 9 y 11; AC 7 y 8).
 *
 * Lo leído en Microsoft Learn (Task 0, 2026-10-15): «ID token claims reference» y «Optional claims reference».
 *   · El emisor de un solo inquilino es `https://login.microsoftonline.com/<inquilino>/v2.0`. Los de varios inquilinos
 *     (`common`, `organizations`, `consumers`, y el literal `{tenantid}` del descubrimiento multi-inquilino) dejarían
 *     entrar a cuentas de cualquier organización: con ellos el sitio NO arranca.
 *   · Entra no publica `email_verified`, y la claim opcional `email` NO es confiable sin `xms_edov: true` (el dominio del
 *     correo está verificado en el inquilino). Las dos son opcionales: las pide el registro de la aplicación (2.30). Sin
 *     `xms_edov`, no se entra y la página dice «el registro de la aplicación no pide la claim xms_edov».
 *   · La identidad estable es `oid` + `tid` (el `sub` de Entra cambia por aplicación): la sesión guarda `<oid>:<tid>`.
 * Nunca se cae a `preferred_username` ni a `upn`.
 */
const { proveedorSobreOidc, correoDe, limitarDominio, ErrorDeIngreso } = require('../oidc.js');

const MULTI = new Set(['common', 'organizations', 'consumers', '{tenantid}']);

/** El inquilino del emisor (el segmento antes de /v2.0), o null. */
function inquilinoDe(issuer) {
  try {
    const partes = new URL(issuer).pathname.split('/').filter(Boolean);
    const i = partes.indexOf('v2.0');
    return i > 0 ? decodeURIComponent(partes[i - 1]) : (partes[0] ? decodeURIComponent(partes[0]) : null);
  } catch { return null; }
}

function problemasDeConfig(env) {
  if (!env.SITE_OIDC_ISSUER) return [{ variable: 'SITE_OIDC_ISSUER', motivo: 'falta: el emisor de Entra ID de un inquilino (https://login.microsoftonline.com/<inquilino>/v2.0)' }];
  const t = inquilinoDe(env.SITE_OIDC_ISSUER);
  if (!t || MULTI.has(t.toLowerCase())) return [{ variable: 'SITE_OIDC_ISSUER', motivo: `es un emisor de varios inquilinos («${t || 'sin inquilino'}»): dejaría entrar a cuentas de cualquier organización` }];
  return [];
}

const verdadero = (v) => v === true || v === 'true' || v === 1;

function crear(cfg, { ahora }) {
  const tenant = inquilinoDe(cfg.issuer);
  return proveedorSobreOidc({
    nombre: 'microsoft', issuer: cfg.issuer, clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri, ahora,
    identidad(claims) {
      const email = correoDe(claims, 'email');
      if (!verdadero(claims.xms_edov)) throw new ErrorDeIngreso('el registro de la aplicación no pide la claim xms_edov', 'sin xms_edov: true');
      if (typeof claims.oid !== 'string' || typeof claims.tid !== 'string' || !claims.oid || !claims.tid) throw new ErrorDeIngreso('el emisor no mandó una identidad estable', 'sin oid o tid');
      if (tenant && claims.tid.toLowerCase() !== tenant.toLowerCase()) throw new ErrorDeIngreso('tu cuenta no es de esta organización', 'tid distinto del inquilino del emisor');
      limitarDominio(email, cfg.allowedDomains);
      return { email, sub: `${claims.oid}:${claims.tid}` };
    },
  });
}

module.exports = { problemasDeConfig, crear, inquilinoDe };
