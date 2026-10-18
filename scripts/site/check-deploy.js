#!/usr/bin/env node
'use strict';
/**
 * check-deploy.js — la prueba sin sesión de un sitio de la organización ya instalado, en cualquier instalación.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * Un sitio que se instaló mal puede quedar abierto sin que nadie lo note: la página carga, el que la mira tiene sesión,
 * y nadie prueba entrar sin ella. Esto pide, SIN sesión, lo que un extraño pediría, y el aviso de la mañana sólo lleva
 * el enlace si pasó: un enlace a un sitio abierto es la peor forma de enterarse.
 *
 * ── LO QUE PIDE ─────────────────────────────────────────────────────────────────────────────────
 * · `/healthz`: 200 `{"ok":true}` sin otra clave. 503 = el sitio está frenado por operations.json (falla). Ni en 200
 *   ni en 503 trae una dirección, un host, una ruta ni un nombre de cuenta (falla «/healthz cuenta de más»).
 * · `/` y `/api/inicio` (este con `Accept: application/json`): nunca 200 con cuerpo. Vale un 401/403, o una
 *   redirección al inicio de sesión: el de la plataforma en el mismo host (`/.auth/login/…`) o el de un emisor con
 *   `response_type=code` (el sitio; con GitHub, que no lo lleva, `client_id`, `redirect_uri` y `code_challenge`). Se siguen hasta 3 redirecciones del mismo origen; una cadena que termina en 200
 *   es «el sitio responde sin iniciar sesión» (o «/api contesta con datos»).
 * · `Cache-Control: no-store` en `/`, sólo cuando la respuesta la dio el sitio (el destino no es `/.auth/`).
 * · `http://` de la misma dirección: redirige a https o no contesta.
 * El primer pedido espera hasta `--wake-timeout` (90 s por defecto): un sitio dormido tarda ~1 minuto en despertar.
 *
 * ── USO ─────────────────────────────────────────────────────────────────────────────────────────
 *   node scripts/site/check-deploy.js --url https://<dirección> [--out <archivo.json>] [--wake-timeout <segundos>]
 *   SALIDA: 0 pasa · 1 falla, con el motivo de la primera que falla (vocabulario cerrado, sin la dirección) · 2 no pudo
 *   preguntar (sin red, dirección inválida, no despertó a tiempo). Con `--out`: `{ resultado: "paso"|"fallo"|"no_pudo",
 *   motivo, hora, capas }`, donde `capas` dice qué contestó cada pedido (el código y adónde redirigió, sin la dirección).
 *   Sólo https; http sólo contra la propia máquina (las pruebas). La gemela http de una dirección local se prueba sólo
 *   si `TYCON_CHECK_DEPLOY_HTTP_URL` la da (las pruebas).
 */
const fs = require('fs');

const MOTIVOS = Object.freeze(['/healthz cuenta de más', 'el sitio está frenado', 'el sitio responde sin iniciar sesión', '/api contesta con datos', 'falta no-store', 'acepta http',
  'sin Referer: el candado de la plataforma frenaría las escrituras de Configuración']);
const [HEALTHZ_DE_MAS, FRENADO, SIN_SESION, API_CON_DATOS, SIN_NO_STORE, ACEPTA_HTTP, SIN_REFERER] = MOTIVOS;
const WAKE_DEFAULT_S = 90;
const PLAZO_MS = 15000;
const PLAZO_HTTP_MS = 5000;
const MAX_REDIRECCIONES = 3;
// lo que /healthz no puede nombrar: una dirección, un host de almacenamiento o de un repo. Los hosts de cada nube los
// dice su módulo en cloud/, como para el resto del núcleo: se recorren todos sin nombrar a ninguno
const NUBES = (() => {
  const dir = require('path').join(__dirname, 'cloud');
  // sin catch: una carpeta que no se lee achicaría la lista en silencio, y eso es aceptar un /healthz que cuenta de más
  const archivos = fs.readdirSync(dir).filter((f) => /^[a-z][a-z0-9-]*\.js$/.test(f));
  return archivos.map((f) => ({ archivo: f, modulo: require(require('path').join(dir, f)) }));
})();
const NOMBRA = (() => {
  // cada módulo de nube dice sus hosts; uno que no los diga achicaría el control sin avisar: se frena acá
  const hosts = NUBES.map(({ archivo, modulo }) => {
    const r = modulo.HOSTS_QUE_NO_SE_NOMBRAN;
    if (!(r instanceof RegExp)) throw new Error(`cloud/${archivo} no exporta HOSTS_QUE_NO_SE_NOMBRAN: sin esa lista la prueba sin sesión no puede mirar /healthz`);
    return r;
  });
  return new RegExp([':\\/\\/', 'github\\.com', ...hosts.map((r) => r.source)].join('|'), 'i');
})();
// ¿Esta respuesta la dio el candado de la plataforma, delante del sitio? Cada nube que pone uno dice cómo se reconoce
// (`esDelCandado(headers)`); la que no pone ninguno no lo exporta
const esDelCandado = (headers) => NUBES.some(({ modulo }) => typeof modulo.esDelCandado === 'function' && modulo.esDelCandado(headers));

class NoPudo extends Error {}

const esLocal = (u) => u.hostname === '127.0.0.1' || u.hostname === 'localhost';

function direccion(texto) {
  let u;
  try { u = new URL(String(texto)); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol === 'https:' || (u.protocol === 'http:' && esLocal(u))) return u;
  return null;
}

/** Un pedido, sin seguir redirecciones. `{ status, headers, cuerpo }`; NoPudo si no hubo respuesta. */
async function pedir(url, { plazoMs, accept }) {
  try {
    const res = await fetch(url, { redirect: 'manual', headers: accept ? { Accept: accept } : {}, signal: AbortSignal.timeout(plazoMs) });
    const cuerpo = await res.text();
    return { status: res.status, headers: res.headers, cuerpo };
  } catch (e) {
    throw new NoPudo(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'red');
  }
}

/**
 * `/` o `/api/inicio`: sigue redirecciones del mismo origen (hasta 3) y clasifica dónde termina. Devuelve
 * `{ capa, falla }`: `capa` es lo que se anota (códigos y el tipo de destino, sin direcciones).
 */
async function sinSesion(base, ruta, { esApi, plazoMs }) {
  let url = new URL(ruta, base);
  const pasos = [];
  let primeraDelSitio = null;
  for (let i = 0; i <= MAX_REDIRECCIONES; i++) {
    const r = await pedir(url, { plazoMs, accept: esApi ? 'application/json' : 'text/html' });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      const destino = new URL(loc, url);
      const plataforma = destino.origin === base.origin && destino.pathname.startsWith('/.auth/');
      if (primeraDelSitio === null) primeraDelSitio = { plataforma, r };
      if (plataforma) { pasos.push(`${r.status} → inicio de sesión de la plataforma`); return { capa: pasos.join(' · '), falla: null, primera: primeraDelSitio }; }
      if (destino.origin !== base.origin) {
        const sp = destino.searchParams;
        // un emisor OIDC pide `response_type=code`; GitHub (OAuth) no lo lleva, y
        // pide `client_id`, `redirect_uri` y `code_challenge` (PKCE): las dos formas son «el sitio pide iniciar sesión»
        const conCodigo = (sp.get('response_type') || '').split(/[\s+]/).includes('code')
          || Boolean(sp.get('client_id') && sp.get('redirect_uri') && sp.get('code_challenge'));
        pasos.push(`${r.status} → ${conCodigo ? 'un emisor (inicio de sesión con código)' : 'otro origen'}`);
        if (conCodigo) return { capa: pasos.join(' · '), falla: null, primera: primeraDelSitio };
        return { capa: pasos.join(' · '), falla: esApi ? API_CON_DATOS : SIN_SESION, primera: primeraDelSitio };
      }
      pasos.push(`${r.status} → el mismo origen`);
      url = destino;
      continue;
    }
    // un 401 o 403 sin redirección puede ser del candado de la plataforma (a un pedido que no parece de navegador no lo
    // manda al inicio de sesión): entonces el sitio no contestó, y su no-store no se le pide
    const delCandado = (r.status === 401 || r.status === 403) && esDelCandado(r.headers);
    if (primeraDelSitio === null) primeraDelSitio = { plataforma: delCandado, r };
    pasos.push(delCandado ? `${r.status} (el candado de la plataforma)` : String(r.status));
    if (r.status === 401 || r.status === 403) return { capa: pasos.join(' · '), falla: null, primera: primeraDelSitio };
    if (r.status >= 200 && r.status < 300) return { capa: pasos.join(' · '), falla: esApi ? API_CON_DATOS : SIN_SESION, primera: primeraDelSitio };
    // otro código (404, 5xx): no expone nada, pero tampoco es un sitio sano cerrado
    return { capa: pasos.join(' · '), falla: null, raro: true, primera: primeraDelSitio };
  }
  pasos.push('demasiadas redirecciones');
  return { capa: pasos.join(' · '), falla: esApi ? API_CON_DATOS : SIN_SESION, primera: primeraDelSitio };
}

/** La gemela http: redirige a https o no contesta. `{ capa, falla }`. */
async function gemelaHttp(base) {
  let url = process.env.TYCON_CHECK_DEPLOY_HTTP_URL || null;
  if (!url) {
    if (base.protocol !== 'https:') return { capa: 'no aplica (dirección local)', falla: null };
    const u = new URL(base.href);
    u.protocol = 'http:';
    url = u.href;
  }
  let r;
  try { r = await pedir(new URL('/', url), { plazoMs: PLAZO_HTTP_MS }); } catch { return { capa: 'no contesta', falla: null }; }
  const loc = r.headers.get('location');
  if (r.status >= 300 && r.status < 400 && loc && new URL(loc, url).protocol === 'https:') return { capa: `${r.status} → https`, falla: null };
  return { capa: String(r.status), falla: ACEPTA_HTTP };
}

async function probar(base, { wakeMs }) {
  const capas = {};
  // 1. /healthz, esperando que despierte
  let h;
  try { h = await pedir(new URL('/healthz', base), { plazoMs: wakeMs }); } catch (e) {
    throw new NoPudo(e.message === 'timeout' ? 'no despertó a tiempo' : 'sin conexión con el sitio');
  }
  capas.healthz = String(h.status);
  let doc = null;
  try { doc = JSON.parse(h.cuerpo); } catch { doc = null; }
  if (NOMBRA.test(h.cuerpo)) return { motivo: HEALTHZ_DE_MAS, capas };
  if (h.status === 503) return { motivo: FRENADO, capas };
  if (h.status !== 200 || !doc || typeof doc !== 'object') throw new NoPudo('/healthz no contestó como el sitio');
  if (doc.ok !== true || Object.keys(doc).length !== 1) return { motivo: HEALTHZ_DE_MAS, capas };
  // el sitio que no deja viajar el Referer ni dentro de sí mismo: el anti-CSRF del candado de la plataforma lo mira, y sin él
  // rechaza cada escritura de Configuración (403, subestado 60). /healthz lo contesta el sitio también detrás del candado
  // una lista vale por su último valor; «never» es el nombre viejo de no-referrer (no-referrer-when-downgrade sí lo manda)
  const politica = String(h.headers.get('referrer-policy') || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).pop();
  if (politica === 'no-referrer' || politica === 'never') return { motivo: SIN_REFERER, capas };
  // 2. / sin sesión. Un error que no es de la red (una redirección que no es una dirección) es una respuesta rara del
  // sitio, no «sin conexión»: el motivo dice cuál de las dos fue
  const motivoDe = (e) => (!(e instanceof NoPudo) ? 'respuesta inesperada del sitio' : e.message === 'timeout' ? 'el sitio dejó de contestar' : 'sin conexión con el sitio');
  const ini = await sinSesion(base, '/', { esApi: false, plazoMs: PLAZO_MS }).catch((e) => { throw new NoPudo(motivoDe(e)); });
  capas.inicio = ini.capa;
  if (ini.falla) return { motivo: ini.falla, capas };
  if (ini.primera && !ini.primera.plataforma && !/\bno-store\b/i.test(ini.primera.r.headers.get('cache-control') || '')) return { motivo: SIN_NO_STORE, capas };
  // 3. /api/inicio sin sesión
  const api = await sinSesion(base, '/api/inicio', { esApi: true, plazoMs: PLAZO_MS }).catch((e) => { throw new NoPudo(motivoDe(e)); });
  capas.api = api.capa;
  if (api.falla) return { motivo: api.falla, capas };
  if (ini.raro || api.raro) throw new NoPudo('el sitio contestó con un código inesperado');
  // 4. la gemela http
  const g = await gemelaHttp(base);
  capas.http = g.capa;
  if (g.falla) return { motivo: g.falla, capas };
  return { motivo: null, capas };
}

function escribir(out, doc) {
  if (!out) return;
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
}

async function main(argv) {
  let url = null; let out = null; let wake = WAKE_DEFAULT_S; let error = null;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--url') url = argv[++i];
    else if (v === '--out') out = argv[++i];
    else if (v === '--wake-timeout') wake = Number(argv[++i]);
    else error = `opción desconocida: ${v}`;
  }
  const hora = () => new Date().toISOString();
  if (error || url == null || !Number.isFinite(wake) || wake <= 0) {
    if (error) process.stderr.write(`${error}\n`);
    process.stderr.write('uso: check-deploy.js --url https://<dirección> [--out <archivo.json>] [--wake-timeout <segundos>]\n');
    return 2;
  }
  const base = direccion(url);
  if (!base) {
    escribir(out, { resultado: 'no_pudo', motivo: 'dirección inválida', hora: hora(), capas: {} });
    process.stderr.write('🔴 check-deploy: no pudo preguntar: dirección inválida (https, sin usuario ni clave)\n');
    return 2;
  }
  try {
    const r = await probar(base, { wakeMs: wake * 1000 });
    escribir(out, { resultado: r.motivo ? 'fallo' : 'paso', motivo: r.motivo, hora: hora(), capas: r.capas });
    if (r.motivo) { process.stdout.write(`🔴 check-deploy: falla: ${r.motivo}\n`); return 1; }
    process.stdout.write('✅ check-deploy: pasa (sin sesión no se ve nada)\n');
    return 0;
  } catch (e) {
    if (!(e instanceof NoPudo)) throw e;
    escribir(out, { resultado: 'no_pudo', motivo: e.message, hora: hora(), capas: {} });
    process.stderr.write(`🔴 check-deploy: no pudo preguntar: ${e.message}\n`);
    return 2;
  }
}

module.exports = { MOTIVOS };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    process.stderr.write(`🔴 check-deploy: error inesperado: ${String((e && e.name) || 'error')}\n`);
    process.exit(2);
  });
}
