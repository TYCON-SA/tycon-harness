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

// ── invitar a alguien al directorio (el núcleo es scripts/site/invitations.js) ───────────────────────────────────
// Sólo en «organization», con la identidad administrada del sitio (`tokenDeIdentidad` de cloud/azure.js) y un solo
// permiso de Graph: `User.Invite.All` de aplicación. Lo leído en Microsoft Learn («Create invitation»): `POST
// /v1.0/invitations` con `invitedUserEmailAddress` e `inviteRedirectUrl`, 201 con `invitedUser.id`; las invitaciones de
// aplicación no andan si el directorio las cerró. El dominio de un correo, sin permiso: el descubrimiento público
// (`<login>/<dominio>/v2.0/.well-known/openid-configuration`) da el inquilino donde está verificado, o `invalid_tenant`.
// El id público de la aplicación de Microsoft Graph: el mismo en todos los inquilinos, no es de ninguna organización
const GRAPH_APP = '00000003-0000-0000-c000-000000000000';
const RECURSO_GRAPH = 'https://graph.microsoft.com/';
const ROL_INVITAR = 'User.Invite.All';
const COMANDO_PERMISO = 'node scripts/site/deploy/azure-container-apps.js --config <el archivo de tu instalación> --phase permiso-de-invitar --apply';
const PORTAL_USUARIOS = 'https://entra.microsoft.com/#view/Microsoft_AAD_UsersAndTenants/UserManagementMenuBlade/~/AllUsers';
const portalDeUsuario = (id) => `https://entra.microsoft.com/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${encodeURIComponent(id)}`;
// un dominio con su terminación: letras, o internacionalizada en punycode (`xn--…`)
const DOMINIO = /^[a-z0-9.-]+\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i;

/** El cuerpo de un token (sin verificar): `{ roles, oid, tid }`, o null si no tiene la forma de un JWT. */
function rolesDelToken(token) {
  const partes = String(token || '').split('.');
  if (partes.length < 2) return null;
  try {
    const c = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
    return { roles: Array.isArray(c.roles) ? c.roles.map(String) : [], oid: typeof c.oid === 'string' ? c.oid : null, tid: typeof c.tid === 'string' ? c.tid : null };
  } catch { return null; }
}

/** Lo que Graph recibe, siempre igual: invitado, de vuelta al sitio, con el mensaje de Microsoft. */
function cuerpoDeLaInvitacion(correo, cfg) {
  return { invitedUserEmailAddress: String(correo || '').trim().toLowerCase(), inviteRedirectUrl: cfg.publicUrl, sendInvitationMessage: true, invitedUserType: 'Guest' };
}

/** El motivo de un rechazo de Graph, en llano y con el texto de Microsoft. */
function motivoDeGraph(status, cuerpo) {
  let detalle = '';
  try { const j = JSON.parse(cuerpo); detalle = String((j && j.error && (j.error.message || j.error.code)) || ''); } catch { detalle = String(cuerpo || ''); }
  // el texto de Microsoft puede repetir el correo invitado: se tapa, porque el motivo va al registro y al disco
  detalle = detalle.replace(/[^\s@<>"'()]+@[^\s@<>"'()]+/g, '<correo>').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (status === 403 && /invitation|guest|B2B/i.test(detalle)) return TX('proveedor.invitarCerradas', { detalle });
  if (status === 401 || status === 403) return TX('proveedor.invitarSinPermisoGraph', { detalle: detalle || String(status) });
  return TX('proveedor.invitarGraph', { status, detalle: detalle || '-' });
}

/**
 * El invitador de este proveedor, para invitations.js: `{ disponible, permiso, dominio, invitar, portal, aviso }`.
 * `urlGraph` y `urlLogin` cambian los servidores (las pruebas).
 */
function invitador({ cfg, env = process.env, urlGraph = 'https://graph.microsoft.com', urlLogin = 'https://login.microsoftonline.com' }) {
  const { pedir } = require('../oidc.js');
  const { tokenDeIdentidad } = require('../cloud/azure.js');
  const propio = String(inquilinoDe(cfg.issuer) || '').toLowerCase() || null;
  const codigoPorCorreo = ['on', 'off'].includes(env.SITE_INVITE_EMAIL_CODE) ? env.SITE_INVITE_EMAIL_CODE : 'unknown';
  const token = async () => { const t = await tokenDeIdentidad(RECURSO_GRAPH, env); return t.token ? { token: t.token } : { error: t.motivo || t.estado }; };
  return {
    /** ¿Se puede invitar con esta instalación? `{ ok, motivo, texto }` (sin el disco: lo mira el núcleo). */
    disponible() {
      const modo = cfg.inicioDeSesion && cfg.inicioDeSesion.modo;
      if (modo === 'any') return { ok: false, motivo: 'cualquier_cuenta', texto: TX('proveedor.invitarCualquierCuenta') };
      if (!env.IDENTITY_ENDPOINT || !env.IDENTITY_HEADER) return { ok: false, motivo: 'sin_identidad', texto: TX('proveedor.invitarSinIdentidad') };
      return { ok: true, motivo: 'microsoft_organizacion', texto: null };
    },
    /** ¿La identidad tiene el permiso? Lo dicen los roles de su token, sin llamar a Graph. */
    async permiso() {
      const t = await token();
      if (t.error) return { ok: false, texto: TX('proveedor.invitarSinToken', { detalle: String(t.error).slice(0, 200) }), comando: COMANDO_PERMISO };
      const c = rolesDelToken(t.token) || { roles: [], oid: null, tid: null };
      // el inquilino, el de la configuración del sitio (el del emisor); el del token, sólo si aquélla no lo trae
      const tid = propio || c.tid || '-';
      if (c.roles.includes(ROL_INVITAR)) return { ok: true };
      return { ok: false, texto: TX('proveedor.invitarSinPermiso', { tenant: tid, oid: c.oid || '-' }), comando: COMANDO_PERMISO };
    },
    /** propio · ajeno · ninguno · no_contesto: dónde está verificado el dominio del correo. */
    async dominio(correo) {
      const d = String(correo || '').trim().toLowerCase().split('@')[1] || '';
      if (!DOMINIO.test(d)) return 'ninguno';
      const r = await pedir(`${urlLogin}/${encodeURIComponent(d)}/v2.0/.well-known/openid-configuration`, { headers: { accept: 'application/json' }, timeoutMs: 8000 });
      if (r.error || !r.status || r.status >= 500) return 'no_contesto';
      let j = null;
      try { j = JSON.parse(r.cuerpo); } catch { return 'no_contesto'; }
      if (r.status === 400 && j && /invalid_tenant/i.test(String(j.error || ''))) return 'ninguno';
      if (r.status !== 200 || !j || typeof j.issuer !== 'string') return 'no_contesto';
      const tid = String(inquilinoDe(j.issuer) || '').toLowerCase();
      return tid && tid === propio ? 'propio' : 'ajeno';
    },
    /** Lo que se le dice a quien invita según el dominio: el motivo para no invitar, o un aviso; null si nada. */
    aviso(dominio) {
      if (dominio === 'propio') return { rechazo: TX('proveedor.invitarDominioPropio') };
      if (dominio === 'ninguno' && codigoPorCorreo !== 'on') return { aviso: TX('proveedor.invitarCodigoPorCorreo', { estado: TX(codigoPorCorreo === 'off' ? 'proveedor.invitarCodigoApagado' : 'proveedor.invitarCodigoSinDato') }) };
      return null;
    },
    /** La invitación: `{ ok, usuario }`, `{ yaEstaba }` o `{ falla }`. */
    async invitar(correo) {
      const t = await token();
      if (t.error) return { falla: TX('proveedor.invitarSinToken', { detalle: String(t.error).slice(0, 200) }) };
      const r = await pedir(`${urlGraph}/v1.0/invitations`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(cuerpoDeLaInvitacion(correo, cfg)), timeoutMs: 20000 });
      // sin respuesta (también un corte por tiempo después de que Microsoft la creó): se reintenta en el próximo ciclo, y
      // en ese caso la persona puede recibir un segundo correo; la guía lo dice
      if (r.error) return { falla: TX('proveedor.invitarSinRed', { detalle: r.error.code || 'sin respuesta' }) };
      if (r.status === 201 || r.status === 200) {
        let id = null;
        try { const j = JSON.parse(r.cuerpo); id = j && j.invitedUser && typeof j.invitedUser.id === 'string' ? j.invitedUser.id : null; } catch { /* sin id: el enlace va a la lista de usuarios */ }
        return { ok: true, usuario: id };
      }
      if (r.status === 400 && /already exist|ya existe/i.test(String(r.cuerpo || ''))) return { yaEstaba: true };
      return { falla: motivoDeGraph(r.status, r.cuerpo) };
    },
    /** El enlace del portal para sacar a alguien del directorio: el de su usuario si se sabe, si no la lista. */
    portal: (usuario) => (usuario ? portalDeUsuario(usuario) : PORTAL_USUARIOS),
    codigoPorCorreo,
  };
}

// las variables propias de este proveedor (el registro de arranque dice si están, nunca su valor)
const variables = ['SITE_AUTH_MICROSOFT_ACCOUNTS', 'SITE_AUTH_MICROSOFT_TENANT', 'SITE_INVITE_EMAIL_CODE'];

// lo que este proveedor le dice a una persona, en los dos idiomas: la tabla del sitio (texts.js) lo suma a la suya
const TEXTOS = {
  'proveedor.microsoftCualquiera': { es: 'Microsoft, con cualquier cuenta de trabajo o escuela, de cualquier organización; los invitados del directorio de la organización entran por su propia puerta', en: "Microsoft, with any work or school account, from any organization; guests of the organization's directory use their own sign-in option" },
  'proveedor.microsoftInquilino': { es: 'Microsoft, con las cuentas del directorio de la organización (un solo inquilino, con sus invitados)', en: 'Microsoft accounts from the organization\'s directory (one tenant, including guests)' },
  'proveedor.personalNo': { es: 'las cuentas personales de Microsoft no se aceptan en este sitio', en: 'personal Microsoft accounts are not accepted on this site' },
  'proveedor.personalNoInvitado': { es: 'las cuentas personales de Microsoft no se aceptan en este sitio. Si sos invitado del directorio de la organización, entrá por la puerta de los invitados', en: "personal Microsoft accounts are not accepted on this site. If you are a guest of the organization's directory, use the guest sign-in option" },
  'proveedor.entrarMicrosoft': { es: 'Entrar con tu cuenta de Microsoft', en: 'Sign in with your Microsoft account' },
  // invitar a alguien (el invitador de arriba)
  'proveedor.invitarCualquierCuenta': { es: 'El sitio deja entrar con «cualquier cuenta» de Microsoft: no hace falta invitar. Sumá a la persona a la lista y que entre con su cuenta.', en: 'The site lets in "any account" from Microsoft: no invitation needed. Add the person to the list and have them sign in with their account.' },
  'proveedor.invitarSinIdentidad': { es: 'Este sitio no tiene identidad administrada: invitá a la persona a mano en el portal de Entra y después sumala a la lista.', en: 'This site has no managed identity: invite the person by hand in the Entra portal, then add them to the list.' },
  'proveedor.invitarSinPermiso': { es: 'Falta el permiso de invitar. Lo da, una vez, un administrador del directorio de la organización (inquilino {tenant}) con el instalador, para la identidad del sitio ({oid}). Si lo acabás de dar, reiniciá el sitio.', en: 'The invite permission is missing. A directory administrator of the organization (tenant {tenant}) grants it once with the installer, for the site\'s identity ({oid}). If you just granted it, restart the site.' },
  'proveedor.invitarSinToken': { es: 'no se pudo pedir el token de la identidad del sitio ({detalle})', en: 'could not get the site identity\'s token ({detalle})' },
  'proveedor.invitarDominioPropio': { es: 'Esa persona necesita una cuenta en el Microsoft 365 de tu organización; pedísela a quien lo administra.', en: 'That person needs an account in your organization\'s Microsoft 365; ask whoever manages it.' },
  'proveedor.invitarCodigoPorCorreo': { es: 'Ese correo no es una cuenta de Microsoft: la persona acepta con un código de un solo uso que Microsoft le manda al correo. Esa opción {estado} en tu directorio; hasta que se prenda, no va a poder aceptar. Se prende en el centro de administración de Entra → External Identities → Todos los proveedores de identidad → Código de acceso de un solo uso por correo.', en: 'That email is not a Microsoft account: the person accepts with a one-time passcode Microsoft emails to them. That option {estado} in your directory; until it is on, they will not be able to accept. Turn it on in the Entra admin center → External Identities → All identity providers → Email one-time passcode.' },
  'proveedor.invitarCodigoApagado': { es: 'está apagada', en: 'is off' },
  'proveedor.invitarCodigoSinDato': { es: 'no se sabe si está prendida', en: 'may not be on' },
  'proveedor.invitarCerradas': { es: 'las invitaciones están cerradas en el directorio (Microsoft: {detalle})', en: 'invitations are closed in the directory (Microsoft: {detalle})' },
  'proveedor.invitarSinPermisoGraph': { es: 'Microsoft no dejó invitar: falta el permiso o está restringido ({detalle})', en: 'Microsoft did not allow the invitation: the permission is missing or restricted ({detalle})' },
  'proveedor.invitarGraph': { es: 'Microsoft contestó {status} ({detalle})', en: 'Microsoft answered {status} ({detalle})' },
  'proveedor.invitarSinRed': { es: 'Microsoft no respondió ({detalle})', en: 'Microsoft did not respond ({detalle})' },
};

module.exports = { problemasDeConfig, opcionesDe, describir, crear, inquilinoDe, invitador, rolesDelToken, cuerpoDeLaInvitacion, motivoDeGraph, variables, PERSONALES, GRAPH_APP, TEXTOS };
