'use strict';
// remote.js — de qué repo de GitLab es la dirección de un remoto de git. GitLab no tiene un servidor único: una
// instalación propia vive en cualquier nombre, así que un remoto sólo se reconoce si su servidor es el de algún repo de
// GitLab que la organización declara en team-repos.json (o el público, si alguno se declara sin servidor).
//
// Devuelve la identidad como está declarada (sin `host` si el repo se declaró sin él): el núcleo compara identidades por
// sus claves. De un repo que no está declarado pero vive en un servidor declarado, la identidad sale de la dirección.

const { PUBLIC_HOST, tramos } = require('./glab-api.js');

/** El servidor y la ruta de una dirección de git (`esquema://[usuario@]servidor[:puerto]/ruta` o `[usuario@]servidor:ruta`), o null. */
function partes(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  let m = u.match(/^(?:ssh|git|https?|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  // la forma de scp, con o sin una barra antes de la ruta. Una ruta de Windows (`C:\repos`) no entra: el servidor
  // lleva al menos dos letras
  if (!m) m = u.match(/^(?:[^@/\\:]+@)?([^/\\:@]{2,}):\/?(?![\\/])(.+)$/);
  if (!m) return null;
  const ruta = m[2].replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  return { host: m[1].toLowerCase(), ruta };
}

const igual = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const hostDe = (r) => String(r.host === undefined || r.host === null ? PUBLIC_HOST : r.host).toLowerCase();

/**
 * La identidad `{ platform, host?, namespace, repo }` del remoto, o null si su servidor no es el de ningún repo de
 * `declarados` (los de GitLab de team-repos.json) o si su ruta no es la de un proyecto dentro de un grupo.
 */
function identityFromRemote(url, declarados) {
  const p = partes(url);
  const lista = (Array.isArray(declarados) ? declarados : []).filter((r) => r && typeof r === 'object' && r.platform === 'gitlab');
  if (!p || !lista.some((r) => hostDe(r) === p.host)) return null;
  const segmentos = p.ruta.split('/');
  const id = { namespace: segmentos.slice(0, -1).join('/'), repo: segmentos[segmentos.length - 1] };
  if (segmentos.length < 2 || !tramos(id)) return null;
  const declarado = lista.find((r) => hostDe(r) === p.host && igual(r.namespace, id.namespace) && igual(r.repo, id.repo));
  if (declarado) return { platform: 'gitlab', ...(declarado.host === undefined ? {} : { host: declarado.host }), namespace: declarado.namespace, repo: declarado.repo };
  // un repo sin declarar de un servidor declarado: lleva el servidor de su dirección, también el público. Sin él, el
  // conector no sabría dónde vive (con un servidor propio declarado, un repo sin declarar y sin host se rechaza)
  return { platform: 'gitlab', host: p.host, ...id };
}

module.exports = { identityFromRemote };
