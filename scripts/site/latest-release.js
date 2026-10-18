#!/usr/bin/env node
'use strict';
/**
 * latest-release.js — la última imagen publicada en la etiqueta móvil `stable`, consultada sin credenciales.
 *
 * El registro de contenedores (la API v2 de distribución: GHCR, Docker Hub, un registro propio) da un token anónimo
 * para leer una imagen pública. Con ese token se piden el manifiesto de la etiqueta y su configuración, sin bajar capas:
 * la versión sale de la etiqueta OCI `org.opencontainers.image.version`, la huella del manifiesto (`docker-content-digest`).
 * Tres pedidos chicos. El manifiesto puede ser un índice multiplataforma (OCI o Docker) o el de una plataforma sola.
 *
 * `consultar({ imagen, etiqueta })` → `{ ok: true, version, huella, revision, creada }` o
 *   `{ ok: false, codigo, motivo }` con `codigo` ∈ `sin_etiqueta` (la etiqueta no existe) · `sin_permiso` (401/403: la
 *   imagen no es pública) · `sin_red` · `ilegible` (sin la etiqueta de versión, o una respuesta que no se entiende).
 * `decidirStable({ nueva, actual })` → `crear` (no hay stable) · `mover` (la nueva es mayor) · `queda` (igual o menor:
 *   stable nunca retrocede).
 *
 * Uso (el workflow que publica la imagen):
 *   node latest-release.js stable-decision --image <registro/repo> --version <número> [--registry-url <base>]
 *   Imprime `decision=crear|mover|queda` y el motivo. Sale 1 si no pudo leer stable (no se mueve a ciegas), 2 de uso.
 */
const { compare: compararVersiones } = require('../setup/harness/version-order.js');

const ACEPTA = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');
const PLAZO_MS = 10000;

/** `ghcr.io/acme/arnes` → `{ host, repo }`; sin host, Docker Hub. */
/**
 * El nombre de una imagen sin su etiqueta ni su huella: `registro:5000/org/sitio:1.2@sha256:…` → `registro:5000/org/sitio`.
 * La etiqueta es lo que sigue al último `:` DESPUÉS de la última `/` (un `:` antes es el puerto del registro).
 */
function nombreSinEtiqueta(imagen) {
  let s = String(imagen || '').trim();
  const at = s.indexOf('@');
  if (at >= 0) s = s.slice(0, at);
  const barra = s.lastIndexOf('/');
  const dos = s.lastIndexOf(':');
  return dos > barra ? s.slice(0, dos) : s;
}
// cada parte del repo, como las acepta la distribución OCI (minúsculas, números y separadores sueltos)
const PARTE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const HOST = /^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+|\[[0-9a-f:]+\])(?::\d{1,5})?$|^localhost(?::\d{1,5})?$|^[a-z0-9-]+:\d{1,5}$/i;

/** `ghcr.io/acme/arnes` → `{ host, repo }`; sin host, Docker Hub. Un nombre que no tiene forma de imagen → null. */
function partirImagen(imagen) {
  const s = nombreSinEtiqueta(imagen);
  const partes = s.split('/');
  let host = 'registry-1.docker.io';
  let repo = partes;
  if (partes.length >= 2 && (/[.:]/.test(partes[0]) || partes[0] === 'localhost')) { host = partes[0]; repo = partes.slice(1); }
  else if (partes.length === 1) repo = ['library', partes[0]];
  if (!HOST.test(host) || !repo.length || !repo.every((x) => PARTE.test(x))) return null;
  return { host, repo: repo.join('/') };
}

async function pedir(url, { headers = {}, fetch: f = globalThis.fetch } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PLAZO_MS);
  try {
    const r = await f(url, { headers, signal: ctl.signal, redirect: 'follow' });
    const cuerpo = await r.text();
    return { status: r.status, cuerpo, headers: r.headers };
  } catch (e) {
    return { error: e };
  } finally { clearTimeout(t); }
}

// 🔴 sólo el 404 del manifiesto de la etiqueta quiere decir «la etiqueta no existe»: un 404 del token, del manifiesto de
//    un índice o de la configuración es una respuesta que no se entiende (si no, stable se «crearía» sin comparar)
const falla = (r, que, { esLaEtiqueta = false } = {}) => {
  if (r.error) return { ok: false, codigo: 'sin_red', motivo: `${que}: ${r.error.name === 'AbortError' ? 'se acabó el tiempo' : (r.error.cause && r.error.cause.code) || r.error.message}` };
  if (r.status === 401 || r.status === 403) return { ok: false, codigo: 'sin_permiso', motivo: `${que}: el registro contestó ${r.status} (¿la imagen no es pública?)` };
  if (r.status === 404) return esLaEtiqueta ? { ok: false, codigo: 'sin_etiqueta', motivo: `${que}: no existe` } : { ok: false, codigo: 'ilegible', motivo: `${que}: el registro contestó 404` };
  return { ok: false, codigo: r.status >= 500 ? 'sin_red' : 'ilegible', motivo: `${que}: el registro contestó ${r.status}` };
};
const json = (t) => { try { return JSON.parse(t); } catch { return null; } };

/**
 * Dónde pide el token el registro, según el `WWW-Authenticate: Bearer realm="…",service="…"` del 401 de `/v2/`.
 * null: no lo anuncia (se usa `/token`, lo de GHCR); false: lo anuncia en otro origen, y no se pide afuera del registro.
 */
async function anuncioDelToken(base, repo, f) {
  const r = await pedir(`${base}/v2/`, { fetch: f });
  if (r.error || r.status !== 401 || !r.headers) return null;
  const h = String(r.headers.get('www-authenticate') || '');
  if (!/^bearer\s/i.test(h)) return null;
  const par = (k) => { const m = new RegExp(`${k}="([^"]*)"`, 'i').exec(h); return m ? m[1] : null; };
  const realm = par('realm');
  if (!realm) return null;
  let u;
  try { u = new URL(realm); } catch { return false; }
  if (u.origin !== new URL(base).origin) return false;
  u.searchParams.set('scope', `repository:${repo}:pull`);
  const servicio = par('service');
  if (servicio) u.searchParams.set('service', servicio);
  return u.toString();
}

/** La versión de `imagen:etiqueta`, sin credenciales. `urlBase`: el registro de las pruebas (http://127.0.0.1:…). */
async function consultar({ imagen, etiqueta = 'stable', urlBase = null, fetch: f } = {}) {
  const partida = partirImagen(imagen);
  if (!partida) return { ok: false, codigo: 'ilegible', motivo: 'el nombre de la imagen no tiene forma de imagen' };
  const { host, repo } = partida;
  const base = urlBase ? String(urlBase).replace(/\/$/, '') : `https://${host}`;
  const servicio = host === 'registry-1.docker.io' ? 'registry.docker.io' : host;
  let tokenUrl = host === 'registry-1.docker.io' && !urlBase ? `https://auth.docker.io/token?service=${servicio}&scope=repository:${repo}:pull` : `${base}/token?scope=repository:${repo}:pull&service=${servicio}`;
  if (!(host === 'registry-1.docker.io' && !urlBase)) {
    // como docker: el 401 de /v2/ anuncia dónde se pide el token (un registro puede darlo en /oauth2/token; GHCR, en /token)
    const anuncio = await anuncioDelToken(base, repo, f);
    if (anuncio === false) return { ok: false, codigo: 'ilegible', motivo: 'el registro anuncia su token en otro origen' };
    if (anuncio) tokenUrl = anuncio;
  }
  const t = await pedir(tokenUrl, { fetch: f });
  if (t.error || t.status !== 200) return falla(t, 'el token anónimo del registro');
  const tok = json(t.cuerpo);
  const token = tok && (tok.token || tok.access_token);
  if (!token) return { ok: false, codigo: 'ilegible', motivo: 'el registro no dio un token anónimo' };
  const auth = { authorization: `Bearer ${token}` };
  let m = await pedir(`${base}/v2/${repo}/manifests/${encodeURIComponent(etiqueta)}`, { headers: { ...auth, accept: ACEPTA }, fetch: f });
  if (m.error || m.status !== 200) return falla(m, `la etiqueta ${etiqueta}`, { esLaEtiqueta: true });
  const huella = m.headers && m.headers.get('docker-content-digest');
  let man = json(m.cuerpo);
  if (man && Array.isArray(man.manifests)) {
    // un índice multiplataforma: la de linux/amd64 (las imágenes del sitio son de esa plataforma), o la primera
    const elegido = man.manifests.find((x) => x.platform && x.platform.os === 'linux' && x.platform.architecture === 'amd64') || man.manifests[0];
    if (!elegido || !/^sha256:[0-9a-f]{64}$/.test(String(elegido.digest))) return { ok: false, codigo: 'ilegible', motivo: `el índice de ${etiqueta} no nombra ninguna imagen` };
    m = await pedir(`${base}/v2/${repo}/manifests/${elegido.digest}`, { headers: { ...auth, accept: ACEPTA }, fetch: f });
    if (m.error || m.status !== 200) return falla(m, `la imagen del índice de ${etiqueta}`);
    man = json(m.cuerpo);
  }
  const config = man && man.config && man.config.digest;
  if (!config || !/^sha256:[0-9a-f]{64}$/.test(config)) return { ok: false, codigo: 'ilegible', motivo: `el manifiesto de ${etiqueta} no se entiende` };
  const c = await pedir(`${base}/v2/${repo}/blobs/${config}`, { headers: auth, fetch: f });
  if (c.error || c.status !== 200) return falla(c, `la configuración de ${etiqueta}`);
  const conf = json(c.cuerpo);
  const labels = (conf && conf.config && conf.config.Labels) || {};
  const version = labels['org.opencontainers.image.version'];
  if (typeof version !== 'string' || !version) return { ok: false, codigo: 'ilegible', motivo: `la imagen de ${etiqueta} no trae la etiqueta de versión (org.opencontainers.image.version)` };
  const fuente = labels['org.opencontainers.image.source'];
  return { ok: true, version, huella: typeof huella === 'string' && /^sha256:[0-9a-f]{64}$/.test(huella) ? huella : null, revision: labels['org.opencontainers.image.revision'] || null, creada: labels['org.opencontainers.image.created'] || (conf && conf.created) || null, fuente: typeof fuente === 'string' && /^https:\/\/[^\s"<>]+$/.test(fuente) ? fuente : null };
}

// ── lo que el sitio sabe de la última publicada ─────────────────────────────────────────────────────────────────────
// La lista cerrada de motivos que el sitio puede mostrar cuando no pudo mirar: nunca el texto crudo del registro
const MOTIVOS = Object.freeze([
  'sin red',
  'la imagen no es pública',
  'todavía no hay una versión en stable',
  'una respuesta del registro que no se entiende',
  'la imagen de stable no trae la etiqueta de versión',
  'el sitio no sabe de qué imagen es (.tycon-release.json sin image)',
]);
const MOTIVO_DE = { sin_red: MOTIVOS[0], sin_permiso: MOTIVOS[1], sin_etiqueta: MOTIVOS[2], ilegible: MOTIVOS[3] };
const CADA_MS = 3600000;
const ARCHIVO = 'ultima-publicada.json';

/**
 * El vigía del sitio: mira `stable` una vez por hora como máximo y guarda la respuesta en `dataDir` (un reinicio no
 * vuelve a preguntar). `estado()`: `{ estado: 'medido', version, huella, creada, fuente, mirado }`,
 * `{ estado: 'no_pudo', motivo, mirado }` (motivo de `MOTIVOS`) o `{ estado: 'sin_mirar' }`. Nunca rechaza.
 */
function crearVigia({ imagen, dataDir = null, ahora = Date.now, urlBase = null, log = () => {}, fetch: f } = {}) {
  const ruta = dataDir ? require('path').join(dataDir, ARCHIVO) : null;
  let ultimo = null;
  if (ruta) {
    try {
      const g = JSON.parse(require('fs').readFileSync(ruta, 'utf8'));
      if (g && Number.isFinite(g.mirado) && (g.estado === 'medido' || (g.estado === 'no_pudo' && MOTIVOS.includes(g.motivo)))) ultimo = g;
    } catch { /* sin respuesta guardada: se mira */ }
  }
  let enCurso = null;
  async function mirarAhora() {
    const t = ahora();
    let e;
    if (!imagen) e = { estado: 'no_pudo', motivo: MOTIVOS[5], mirado: t };
    else {
      const r = await consultar({ imagen, etiqueta: 'stable', urlBase, fetch: f });
      if (r.ok) e = { estado: 'medido', version: r.version, huella: r.huella, creada: r.creada, fuente: r.fuente || null, mirado: t };
      else {
        e = { estado: 'no_pudo', motivo: r.motivo && /etiqueta de versión/.test(r.motivo) ? MOTIVOS[4] : (MOTIVO_DE[r.codigo] || MOTIVOS[3]), mirado: t };
        log(`la última publicada no se pudo mirar: ${r.motivo}`);
      }
    }
    ultimo = e;
    if (ruta) {
      try { require('fs').writeFileSync(ruta, `${JSON.stringify(e)}\n`); }
      catch (err) { log(`no se pudo guardar la última publicada en SITE_DATA_DIR (${err.code || err.message}): se vuelve a mirar al reiniciar`); }
    }
  }
  return {
    /** Mira si pasó una hora desde la última vez (o nunca miró). Dos llamadas juntas hacen un solo pedido. */
    mirar() {
      if (ultimo && ahora() - ultimo.mirado < CADA_MS) return Promise.resolve();
      if (!enCurso) enCurso = mirarAhora().catch((e) => { log(`la última publicada: falla inesperada (${e && e.message})`); }).finally(() => { enCurso = null; });
      return enCurso;
    },
    estado: () => (ultimo ? (({ mirado, ...resto }) => (resto.estado === 'no_pudo' ? { estado: resto.estado, motivo: resto.motivo } : resto))(ultimo) : { estado: 'sin_mirar' }),
  };
}

/** `crear` · `mover` · `queda`. `actual` null: no hay stable. Una versión que no se puede ordenar nunca mueve. */
function decidirStable({ nueva, actual }) {
  if (actual === null || actual === undefined) return { decision: 'crear', motivo: `stable no existe: se crea en ${nueva}` };
  const c = compararVersiones(nueva, actual);
  if (c === null) return { decision: 'queda', motivo: `no se pueden comparar ${nueva} y ${actual}: stable queda en ${actual}` };
  if (c > 0) return { decision: 'mover', motivo: `stable pasa de ${actual} a ${nueva}` };
  return { decision: 'queda', motivo: `la versión ${nueva} no es mayor que la de stable (${actual}): stable queda donde estaba` };
}

async function main(argv) {
  const [orden, ...resto] = argv;
  const op = (k) => { const i = resto.indexOf(k); return i >= 0 ? resto[i + 1] : null; };
  if (orden !== 'stable-decision' || !op('--image') || !op('--version')) {
    process.stderr.write('uso: latest-release.js stable-decision --image <registro/repo> --version <número> [--registry-url <base>]\n');
    return 2;
  }
  const r = await consultar({ imagen: op('--image'), etiqueta: 'stable', urlBase: op('--registry-url') });
  if (!r.ok && r.codigo !== 'sin_etiqueta') {
    process.stdout.write(`no se pudo leer stable (${r.motivo}): no se mueve\n`);
    return 1;
  }
  const d = decidirStable({ nueva: op('--version'), actual: r.ok ? r.version : null });
  process.stdout.write(`decision=${d.decision}\n${d.motivo}\n`);
  return 0;
}

module.exports = { consultar, decidirStable, partirImagen, nombreSinEtiqueta, crearVigia, MOTIVOS };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`latest-release: falló: ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
}
