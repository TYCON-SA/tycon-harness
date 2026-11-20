'use strict';
// glab-api.js — la llamada a la API de GitLab que comparten las operaciones del conector: `glab api` con el servidor, el
// método, la ruta y el cuerpo (por archivo), y su resultado en el vocabulario de la capa. TYCON_GLAB_CMD reemplaza a
// glab: un ejecutable, o un `.js` que corre con node.
//
// El servidor va siempre en la línea (`--hostname`): sin él, glab usa el del repo de la carpeta en que corre, que puede
// ser otro. El servidor de un repo lo decide `servidorDe`: el que trae, el que declara team-repos.json, o el público
// cuando la organización no declara ningún servidor propio. El nombre del público vive sólo acá.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PUBLIC_HOST = 'gitlab.com';
const no = (reason, detail) => ({ ok: false, reason, detail });

// un tramo de la ruta de un proyecto: no empieza con punto ni con guion (ni `..` ni una opción de la línea de comandos)
const TRAMO = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const SERVIDOR = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** El servidor de un repo: el que declara, o el público. Null si lo que declara no tiene forma de nombre de servidor. */
function hostOf(repo) {
  const h = repo && repo.host !== undefined && repo.host !== null ? String(repo.host) : PUBLIC_HOST;
  return SERVIDOR.test(h) ? h.toLowerCase() : null;
}

/**
 * Los tramos de `namespace/repo` de una identidad, o null si alguno no tiene forma. Un repo que llegó por su nombre de
 * dos tramos (`grupo/proyecto`) trae el grupo en `org`: es su namespace.
 */
function tramos(repo) {
  if (!repo || typeof repo !== 'object' || typeof repo.repo !== 'string') return null;
  const namespace = repo.namespace === undefined ? repo.org : repo.namespace;
  if (typeof namespace !== 'string') return null;
  const partes = [...namespace.split('/'), repo.repo];
  return partes.length >= 2 && partes.every((t) => TRAMO.test(t)) ? partes : null;
}

/** La ruta de un proyecto en la API, con su namespace codificado entero (`projects/grupo%2Fsub%2Frepo`), o null. */
function projectPath(repo) {
  const partes = tramos(repo);
  return partes ? `projects/${encodeURIComponent(partes.join('/'))}` : null;
}

/** `{value}` con la respuesta en JSON, o `{problem}` con el «no» de la capa. */
function glab(ctx, host, method, ruta, body) {
  const cmd = ctx.env.TYCON_GLAB_CMD || 'glab';
  const [bin, pre] = /\.js$/.test(cmd) ? [process.execPath, [cmd]] : [cmd, []];
  const args = [...pre, 'api', '--hostname', host, '--method', method, ruta];
  let dir = null;
  if (body) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glab-cuerpo-'));
    fs.writeFileSync(path.join(dir, 'cuerpo.json'), JSON.stringify(body));
    args.push('--input', path.join(dir, 'cuerpo.json'), '-H', 'Content-Type: application/json');
  }
  let r;
  try { r = spawnSync(bin, args, { env: ctx.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000, windowsHide: true }); } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (r.error) return { problem: no('no_medido', `${path.basename(cmd)} no se pudo ejecutar (${r.error.code || r.error.message}): ¿está instalado glab?`) };
  if (r.status !== 0) {
    // el texto de glab, recortado: el detalle llega a la salida (la capa lo limpia de credenciales y direcciones)
    const t = `${r.stderr || ''} ${r.stdout || ''}`.trim().replace(/\s+/g, ' ').slice(0, 500);
    if (/HTTP 401|glab auth login|Unauthorized|invalid_token/i.test(t)) return { problem: no('sin_credencial', `GitLab no aceptó la sesión de glab de esta máquina (glab auth login --hostname ${host}): ${t}`) };
    // el tope de pedidos: una lectura que no se hizo, o una escritura que GitLab no tomó
    if (/HTTP 429/.test(t)) return { problem: no(method === 'GET' ? 'no_medido' : 'rechazado', `GitLab frenó por el tope de pedidos; reintentar más tarde: ${t}`) };
    if (/HTTP (404|410)/.test(t)) return { problem: no('no_encontrado', t) };
    // glab no llegó al servidor, o la conexión se cortó a mitad de camino: no es una respuesta de GitLab. En una
    // escritura no se sabe si se hizo: quien llama no lo toma por «no entró»
    if (/error connecting to|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|no such host|could not resolve|i\/o timeout|dial tcp|connection reset|connection refused|broken pipe|network is unreachable|TLS handshake|deadline exceeded|unexpected EOF|: EOF\b/i.test(t)) return { problem: no('red', t) };
    // un error del servidor en una lectura es una lectura que no se hizo, nunca «no hay nada»
    if (/HTTP 5\d\d/.test(t) && method === 'GET') return { problem: no('no_medido', `GitLab no contestó la lectura: ${t}`) };
    return { problem: no('rechazado', t || `glab salió ${r.status}`) };
  }
  // una escritura que salió 0 se hizo aunque la respuesta no se entienda (tomarla por fallada invitaría a repetirla)
  try { return { value: JSON.parse(r.stdout) }; } catch (_) { return method === 'GET' ? { problem: no('no_medido', 'glab contestó algo que no es JSON') } : { value: null }; }
}

const MAX_PAGINAS = 50;

/**
 * Todas las páginas de una lista: `{value}` o `{problem}`. Una página que falla después de la primera, una respuesta sin
 * forma de lista o el tope de páginas son no_medido: la lista se devuelve entera o no se devuelve.
 */
function todas(ctx, host, ruta) {
  const out = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const g = glab(ctx, host, 'GET', `${ruta}${ruta.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (g.problem) return page === 1 ? g : { problem: no('no_medido', `la lista no se leyó entera (falló la página ${page}): ${g.problem.detail}`) };
    if (!Array.isArray(g.value)) return { problem: no('no_medido', 'GitLab contestó una lista sin forma') };
    out.push(...g.value);
    if (g.value.length < 100) return { value: out };
  }
  return { problem: no('no_medido', `tope de ${MAX_PAGINAS} páginas: la lista no se leyó entera`) };
}

/**
 * Los repos de GitLab que declara team-repos.json, estén en la clave que estén: `{ value }`, con `[]` si el archivo no
 * está, o `{ problem }` si está y no se puede leer o no valida. Con el archivo roto no se sabe en qué servidor vive un
 * proyecto: tomarlo por «no declara ninguno» lo mandaría al servidor público.
 */
function declarados(ctx) {
  const out = [];
  const ver = (v) => {
    if (!v || typeof v !== 'object') return;
    if (v.platform === 'gitlab' && typeof v.namespace === 'string' && typeof v.repo === 'string') out.push(v);
    for (const x of Object.values(v)) ver(x);
  };
  const archivo = path.join(ctx.env.TYCON_TREE || ctx.root, 'team-repos.json');
  if (!fs.existsSync(archivo)) return { value: out };
  let t;
  try { t = require(path.join(ctx.root, 'scripts', 'lib', 'team-repos.js')).load(archivo); } catch (e) {
    return { problem: no('no_medido', `no pude leer team-repos.json (${(e && e.code) || 'error'}): no sé en qué servidor de GitLab vive el proyecto`) };
  }
  if (!t.ok || !t.data) {
    const p = (t.problems || [])[0] || {};
    return { problem: no('no_medido', `team-repos.json no se puede leer o no valida (${p.path ? `${p.path}: ` : ''}${p.message || 'sin motivo'}): no sé en qué servidor de GitLab vive el proyecto`) };
  }
  ver(t.data);
  return { value: out };
}

const igual = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * El servidor de un proyecto: `{ host }` o `{ problem }`. El que trae el repo; si no trae, el que declara
 * team-repos.json para ese proyecto, o el público si lo declara sin servidor. Un proyecto sin declarar va al público
 * sólo si la organización no declara ningún repo de GitLab con su servidor: si declara alguno, el proyecto puede vivir
 * en ése, y mandarlo al público en silencio llevaría issues y pedidos a otro lado.
 */
function servidorDe(ctx, repo) {
  const host = (r) => (hostOf(r) ? { host: hostOf(r) } : { problem: no('rechazado', 'el servidor de GitLab del repo no tiene forma de nombre de servidor (team-repos.json)') });
  if (repo && repo.host !== undefined && repo.host !== null) return host(repo);
  const partes = tramos(repo);
  if (!partes) return { problem: no('rechazado', 'el repo no trae namespace y repo de GitLab (team-repos.json)') };
  const namespace = partes.slice(0, -1).join('/');
  const nombre = partes[partes.length - 1];
  const lista = declarados(ctx);
  if (lista.problem) return { problem: lista.problem };
  const mismos = lista.value.filter((r) => igual(r.namespace, namespace) && igual(r.repo, nombre));
  const servidores = [...new Set(mismos.map((r) => hostOf(r)))];
  if (servidores.length > 1) return { problem: no('rechazado', `team-repos.json declara ${namespace}/${nombre} en más de un servidor de GitLab (${servidores.join(', ')}): no elijo uno; nombrá el repo con su host`) };
  if (mismos.length) return host(mismos[0]);
  const propios = [...new Set(lista.value.filter((r) => r.host !== undefined && r.host !== null).map((r) => String(r.host).toLowerCase()))];
  if (propios.length) {
    return { problem: no('sin_plataforma', `el repo ${namespace}/${nombre} no está declarado en team-repos.json y la organización declara repos de GitLab en ${propios.join(', ')}: no lo mando al servidor público. Declaralo en team-repos.json con su host`) };
  }
  return { host: PUBLIC_HOST };
}

module.exports = { glab, todas, no, hostOf, projectPath, tramos, declarados, servidorDe, PUBLIC_HOST };
