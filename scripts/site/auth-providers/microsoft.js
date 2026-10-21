'use strict';
/*
 * auth-providers/microsoft.js — el inicio de sesión con Entra ID.
 *
 * Lo leído en Microsoft Learn: «ID token claims reference» y «Optional claims reference».
 *   · El emisor de un solo inquilino es `https://login.microsoftonline.com/<inquilino>/v2.0`.
 *   · Entra no publica `email_verified`, y la claim opcional `email` NO es confiable sin `xms_edov: true` (el dominio del
 *     correo está verificado en el inquilino). Las dos son opcionales: las pide el registro de la aplicación.
 *   · La identidad estable es `oid` + `tid` (el `sub` de Entra cambia por aplicación): la sesión guarda `<oid>:<tid>`.
 * Nunca se cae a `preferred_username` ni a `upn`.
 *
 * DOS MODOS (`SITE_AUTH_MICROSOFT_ACCOUNTS`). Quién entra lo decide la lista del sitio en los dos.
 *   · `organization` (por defecto): un solo inquilino. Los emisores de varios inquilinos (`common`,
 *     `organizations`, `consumers`, `{tenantid}`) no arrancan. Sin `xms_edov`, la página dice «el registro de la
 *     aplicación no pide la claim xms_edov».
 *   · `any`: cualquier cuenta de trabajo o escuela, de cualquier inquilino. `SITE_OIDC_ISSUER` es el de `common` u
 *     `organizations`; su descubrimiento publica la plantilla `…/{tenantid}/v2.0`, y el `iss` de cada token tiene que ser
 *     esa plantilla con el `tid` del propio token (un GUID), firmado con una clave del JWKS de ese descubrimiento (así lo
 *     publica Entra). Se entra sólo con `email` y `xms_edov: true`: con varios inquilinos cualquiera crea el suyo, y un
 *     correo sin verificar saltearía la lista. Una cuenta PERSONAL que entra directo (el inquilino de `consumers`) no
 *     entra: no está comprobado que su correo sea confiable, y la página lo dice y la manda a la puerta de los
 *     invitados. La puerta de los invitados (`via: 'invitado'`) entra por el emisor del inquilino de la organización
 *     (`SITE_AUTH_MICROSOFT_TENANT`), como el modo de un inquilino: así un invitado del directorio con una cuenta personal
 *     entra con su correo verificado.
 */
// lo que este archivo le dice a una persona vive en la tabla del sitio (texts.js, `proveedor.*`); el servidor lo traduce al mostrarlo
const TX = (clave, valores) => require('../texts.js').t('es', clave, valores);
const { proveedorSobreOidc, correoDe, limitarDominio, ErrorDeIngreso } = require('../oidc.js');

const MULTI = new Set(['common', 'organizations', 'consumers', '{tenantid}']);
const PARA_CUALQUIERA = new Set(['common', 'organizations']);
const MODOS = ['organization', 'any'];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// el inquilino de las cuentas personales de Microsoft (el emisor de `consumers`, medido en la parte A)
const PERSONALES = '9188040d-6c67-4c5b-b112-36a304b66dad';
// se arma al usarse: la tabla de textos carga este archivo para sumar los suyos
const aInvitados = () => ({ href: '/auth/login?via=invitado', texto: TX('proveedor.entrarInvitado') });

/** El inquilino del emisor (el segmento antes de /v2.0), o null. */
function inquilinoDe(issuer) {
  try {
    const partes = new URL(issuer).pathname.split('/').filter(Boolean);
    const i = partes.indexOf('v2.0');
    return i > 0 ? decodeURIComponent(partes[i - 1]) : (partes[0] ? decodeURIComponent(partes[0]) : null);
  } catch { return null; }
}

/** El emisor de otro inquilino sobre el mismo servidor: `…/<inquilino>/v2.0`. */
function emisorDeInquilino(issuer, tenant) {
  const u = new URL(issuer);
  return `${u.protocol}//${u.host}/${tenant}/v2.0`;
}

function problemasDeConfig(env) {
  const modo = env.SITE_AUTH_MICROSOFT_ACCOUNTS || 'organization';
  if (!MODOS.includes(modo)) return [{ variable: 'SITE_AUTH_MICROSOFT_ACCOUNTS', motivo: 'tiene que ser organization (un solo inquilino, por defecto) o any (cualquier cuenta de trabajo o escuela)' }];
  if (!env.SITE_OIDC_ISSUER) return [{ variable: 'SITE_OIDC_ISSUER', motivo: modo === 'any' ? 'falta: el emisor de Entra ID de varios inquilinos (https://login.microsoftonline.com/common/v2.0)' : 'falta: el emisor de Entra ID de un inquilino (https://login.microsoftonline.com/<inquilino>/v2.0)' }];
  const t = inquilinoDe(env.SITE_OIDC_ISSUER);
  if (modo === 'organization') {
    if (!t || MULTI.has(t.toLowerCase())) return [{ variable: 'SITE_OIDC_ISSUER', motivo: `es un emisor de varios inquilinos («${t || 'sin inquilino'}»): dejaría entrar a cuentas de cualquier organización` }];
    if (t.toLowerCase() === PERSONALES) return [{ variable: 'SITE_OIDC_ISSUER', motivo: 'es el inquilino de las cuentas personales de Microsoft: dejaría entrar a cualquier cuenta personal' }];
    // Entra publica su emisor con el inquilino en minúsculas, y el descubrimiento se compara letra por letra
    if (t !== t.toLowerCase()) return [{ variable: 'SITE_OIDC_ISSUER', motivo: 'el inquilino va en minúsculas, como lo publica Entra' }];
    return [];
  }
  const p = [];
  if (!t || !PARA_CUALQUIERA.has(t.toLowerCase())) p.push({ variable: 'SITE_OIDC_ISSUER', motivo: `con SITE_AUTH_MICROSOFT_ACCOUNTS=any, el emisor es el de common u organizations (es «${t || 'sin inquilino'}»)` });
  if (!env.SITE_AUTH_MICROSOFT_TENANT) p.push({ variable: 'SITE_AUTH_MICROSOFT_TENANT', motivo: 'falta: el inquilino de la organización (la puerta de los invitados del directorio entra por ahí)' });
  else if (!GUID.test(env.SITE_AUTH_MICROSOFT_TENANT)) p.push({ variable: 'SITE_AUTH_MICROSOFT_TENANT', motivo: 'tiene que ser el identificador del inquilino (un GUID)' });
  else if (env.SITE_AUTH_MICROSOFT_TENANT.toLowerCase() === PERSONALES) p.push({ variable: 'SITE_AUTH_MICROSOFT_TENANT', motivo: 'es el inquilino de las cuentas personales de Microsoft, no el de la organización: la puerta de los invitados dejaría entrar a cualquier cuenta personal' });
  return p;
}

/** Lo propio de este proveedor que va a la configuración del sitio (y Configuración muestra): el modo y el inquilino. */
function opcionesDe(env) {
  const modo = MODOS.includes(env.SITE_AUTH_MICROSOFT_ACCOUNTS) ? env.SITE_AUTH_MICROSOFT_ACCOUNTS : 'organization';
  // en minúsculas: así lo publica Entra, y el emisor de la puerta de los invitados se compara letra por letra
  return { modo, tenant: modo === 'any' && env.SITE_AUTH_MICROSOFT_TENANT ? env.SITE_AUTH_MICROSOFT_TENANT.toLowerCase() : null };
}

/** Con qué se entra, en palabras (Configuración lo muestra; sin el inquilino). */
function describir(op) {
  return op && op.modo === 'any'
    ? TX('proveedor.microsoftCualquiera')
    : TX('proveedor.microsoftInquilino');
}

/** Lo que pide Entra a cualquier cuenta: el correo verificado y una identidad estable. */
function correoVerificado(claims, frase) {
  const email = correoDe(claims, 'email');
  if (!verdadero(claims.xms_edov)) throw new ErrorDeIngreso(frase, 'sin xms_edov: true');
  if (typeof claims.oid !== 'string' || typeof claims.tid !== 'string' || !claims.oid || !claims.tid) throw new ErrorDeIngreso(TX('proveedor.sinIdentidad'), 'sin oid o tid');
  return email;
}

const verdadero = (v) => v === true || v === 'true' || v === 1;

/** Un inquilino: el de hoy (y la puerta de los invitados del modo `any`). */
function deUnInquilino(cfg, { ahora, issuer, nombre, fraseSinEdov }) {
  const tenant = inquilinoDe(issuer);
  return proveedorSobreOidc({
    nombre, issuer, clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri, ahora,
    identidad(claims) {
      const email = correoVerificado(claims, fraseSinEdov);
      // aun con un inquilino mal instalado, una cuenta personal directa no entra por acá
      if (claims.tid.toLowerCase() === PERSONALES) throw new ErrorDeIngreso(TX('proveedor.personalNo'), 'una cuenta personal de Microsoft por la puerta de un inquilino');
      if (tenant && claims.tid.toLowerCase() !== tenant.toLowerCase()) throw new ErrorDeIngreso(TX('proveedor.otraOrg'), 'tid distinto del inquilino del emisor');
      limitarDominio(email, cfg.allowedDomains);
      return { email, sub: `${claims.oid}:${claims.tid}` };
    },
  });
}

function crear(cfg, { ahora }) {
  const op = cfg.opciones || { modo: 'organization' };
  if (op.modo !== 'any') return deUnInquilino(cfg, { ahora, issuer: cfg.issuer, nombre: 'microsoft', fraseSinEdov: 'el registro de la aplicación no pide la claim xms_edov' });

  const plantilla = emisorDeInquilino(cfg.issuer, '{tenantid}');
  const principal = proveedorSobreOidc({
    nombre: 'microsoft', issuer: cfg.issuer, clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri, ahora,
    emisorDelDescubrimiento: plantilla,
    // el emisor del token es el de SU inquilino; un tid que no es un GUID no tiene emisor (rechazado)
    emisorDelToken: (claims) => (typeof claims.tid === 'string' && GUID.test(claims.tid) ? emisorDeInquilino(cfg.issuer, claims.tid) : null),
    identidad(claims) {
      if (typeof claims.tid === 'string' && claims.tid.toLowerCase() === PERSONALES) {
        throw new ErrorDeIngreso(TX('proveedor.personalNoInvitado'), 'una cuenta personal de Microsoft por la puerta principal', aInvitados());
      }
      const email = correoVerificado(claims, 'tu cuenta no trae un correo verificado por su organización (la claim xms_edov), y sin él no se puede saber si el correo es tuyo');
      limitarDominio(email, cfg.allowedDomains);
      return { email, sub: `${claims.oid}:${claims.tid}` };
    },
  });
  const invitados = deUnInquilino(cfg, { ahora, issuer: emisorDeInquilino(cfg.issuer, op.tenant), nombre: 'microsoft', fraseSinEdov: 'tu cuenta no trae un correo verificado (la claim xms_edov)' });
  const de = (via) => (via === 'invitado' ? invitados : principal);
  return {
    nombre: 'microsoft',
    emisor: cfg.issuer,
    // las dos puertas de la página de inicio
    vias: [{ id: null, texto: TX('proveedor.entrarMicrosoft') }, { id: 'invitado', texto: TX('proveedor.soyInvitado') }],
    preparar: () => Promise.all([principal.preparar(), invitados.preparar()]),
    listo: () => principal.listo() && invitados.listo(),
    urlDeInicio: (o) => de(o.via).urlDeInicio(o),
    completar: (o) => de(o.via).completar(o),
  };
}

// las variables propias de este proveedor (el registro de arranque dice si están, nunca su valor)
const variables = ['SITE_AUTH_MICROSOFT_ACCOUNTS', 'SITE_AUTH_MICROSOFT_TENANT'];

// lo que este proveedor le dice a una persona, en los dos idiomas: la tabla del sitio (texts.js) lo suma a la suya
const TEXTOS = {
  'proveedor.microsoftCualquiera': { es: 'Microsoft, con cualquier cuenta de trabajo o escuela, de cualquier organización; los invitados del directorio de la organización entran por su propia puerta', en: "Microsoft, with any work or school account, from any organization; guests of the organization's directory use their own sign-in option" },
  'proveedor.microsoftInquilino': { es: 'Microsoft, con las cuentas del directorio de la organización (un solo inquilino, con sus invitados)', en: 'Microsoft accounts from the organization\'s directory (one tenant, including guests)' },
  'proveedor.personalNo': { es: 'las cuentas personales de Microsoft no se aceptan en este sitio', en: 'personal Microsoft accounts are not accepted on this site' },
  'proveedor.personalNoInvitado': { es: 'las cuentas personales de Microsoft no se aceptan en este sitio. Si sos invitado del directorio de la organización, entrá por la puerta de los invitados', en: "personal Microsoft accounts are not accepted on this site. If you are a guest of the organization's directory, use the guest sign-in option" },
  'proveedor.entrarMicrosoft': { es: 'Entrar con tu cuenta de Microsoft', en: 'Sign in with your Microsoft account' },
};

module.exports = { problemasDeConfig, opcionesDe, describir, crear, inquilinoDe, variables, PERSONALES, TEXTOS };
