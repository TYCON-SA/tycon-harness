#!/usr/bin/env node
'use strict';
/**
 * scripts/ci/weekly-release.js — la versión de la semana, con notas que nombran a quien contribuyó de afuera.
 *
 * POR QUÉ EXISTE. La guía de colaboración (.github/CONTRIBUTING.md) promete que las contribuciones aceptadas se nombran
 * en las notas de la versión publicada. Cada merge a main recibe su etiqueta `v<número>` (version-tag.js), pero una
 * etiqueta no lleva notas: la versión publicada es una release de GitHub, una por semana.
 *
 * CUÁNDO. Lo corre .github/workflows/version-tag.yml después de etiquetar, en cada push a main. Publica la versión sobre
 * la etiqueta de ese commit si pasaron 7 días desde la última; si no, no hace nada. Un commit sin etiqueta (ya no era la
 * punta de main) tampoco: la corrida siguiente numera la punta y la ve. Una etiqueta que está en la copia y no en el
 * servidor no se publica: crear la versión crearía la etiqueta en otro commit.
 *
 * A QUIÉN NOMBRA. Las notas que arma GitHub (`releases/generate-notes`) listan los pedidos y nombran al autor del
 * PEDIDO. Un pedido de un fork de organización entra por una rama nuestra (CONTRIBUTING.md, «Dos límites de GitHub con
 * los forks»): su autor es una cuenta del equipo, y quien contribuyó no aparecería. Por eso las notas llevan arriba
 * «Contribuciones de afuera»: los autores de los COMMITS del período que no son del equipo, con los pedidos por los que
 * entraron. Las cuentas del equipo están en la variable de Actions MAINTAINER_LOGINS (separadas por comas o espacios),
 * no en el repo. Sin la variable no se publica: no hay cómo saber quién es de afuera, y nombrar al equipo como de afuera
 * es peor que esperar. Las cuentas de robots no se nombran; un commit sin cuenta de GitHub tampoco, y lo dice el
 * registro de la corrida.
 *
 * SALIDAS. 0 = hecho (publicó, no le tocaba, o falta la variable: lo avisa con ::warning::) · 2 = no pude (git o la API
 * fallaron): rojo, pero la etiqueta ya está puesta, porque el paso que etiqueta va antes y no depende de éste.
 *
 * USO: node scripts/ci/weekly-release.js --sha <commit>   (con el ambiente que pone Actions: el token, el repo y las direcciones)
 */

const path = require('path');
const { spawnSync } = require('child_process');

const VO = require(path.join(__dirname, '..', 'setup', 'harness', 'version-order.js'));

const DAY = 24 * 3600;
const PERIOD_DAYS = 7;
// el límite de GitHub para el texto de una release es 125000 caracteres: algo de margen
const MAX_BODY = 120000;
const PER_PAGE = 100;
const MAX_PAGES = 50;
// los pedidos se buscan por commit: con estos alcanza para nombrarlos todos, sin una llamada por cada commit
const MAX_SHAS_PER_LOGIN = 20;

/** ¿Toca publicar? `latest`: `{ tag, publishedAt }` (segundos) o null · `now` en segundos. */
function due({ now, latest }) {
  if (!latest) return { due: true, reason: 'todavía no hay ninguna versión publicada' };
  const days = Math.floor((now - latest.publishedAt) / DAY);
  if (now - latest.publishedAt >= PERIOD_DAYS * DAY) return { due: true, reason: `la última (${latest.tag}) tiene ${days} días` };
  return { due: false, reason: `la última (${latest.tag}) tiene ${days} días: la próxima sale a los ${PERIOD_DAYS}` };
}

/**
 * Desde qué etiqueta se cuenta: la de la última versión publicada. Sin ninguna, la etiqueta de número más nueva de hace
 * 7 días o más; si no hay tan vieja, la más vieja que hay; si no hay otra, null. `tags`: `[{ name, date }]`.
 */
function previousTag({ latest, tags, now, current }) {
  if (latest) return latest.tag;
  const numbered = (tags || []).filter((t) => t.name !== current && VO.fromTag(t.name));
  if (!numbered.length) return null;
  const older = numbered.filter((t) => t.date <= now - PERIOD_DAYS * DAY);
  if (older.length) return VO.tagName(VO.bestTag(older.map((t) => t.name)));
  const oldest = numbered.map((t) => VO.fromTag(t.name)).sort(VO.compare)[0];
  return VO.tagName(oldest);
}

/** Las cuentas del equipo, de la variable: separadas por comas o espacios, con o sin `@`. */
function parseMaintainers(text) {
  return String(text || '').split(/[\s,]+/).map((s) => s.replace(/^@/, '')).filter(Boolean);
}

/**
 * Los de afuera, por autor de commit. `commits` como los da la API de comparación (`[{ sha, author: { login, type } |
 * null }]`). El equipo se compara sin mayúsculas; los robots no cuentan; un commit sin cuenta va a `unknown`.
 */
function outsiders({ commits, maintainers }) {
  const team = new Set((maintainers || []).map((l) => l.toLowerCase()));
  const byLogin = new Map();
  let unknown = 0;
  for (const c of commits || []) {
    const a = c && c.author;
    if (!a || !a.login) { unknown += 1; continue; }
    if (a.type === 'Bot' || /\[bot\]$/i.test(a.login) || team.has(a.login.toLowerCase())) continue;
    if (!byLogin.has(a.login)) byLogin.set(a.login, []);
    byLogin.get(a.login).push(c.sha);
  }
  return { outsiders: [...byLogin].map(([login, shas]) => ({ login, shas })), unknown };
}

/** `[1, 2, 3]` → `#1, #2 y #3`. */
function prList(prs) {
  const refs = prs.map((n) => `#${n}`);
  return refs.length > 1 ? `${refs.slice(0, -1).join(', ')} y ${refs[refs.length - 1]}` : refs.join('');
}

/**
 * El texto de la versión: «Contribuciones de afuera» arriba (si hay alguien) y las notas de GitHub abajo. Si no entra en
 * `max`, lo de GitHub se corta en un renglón y el final dice dónde ver el resto.
 */
function releaseBody({ outsiders: people, generated, compareUrl, max = MAX_BODY }) {
  const gen = String(generated || '');
  const head = people && people.length ? [
    '## Contribuciones de afuera',
    '',
    'Gracias a quienes contribuyeron en este período:',
    '',
    ...people.map((p) => `- @${p.login}${p.prs && p.prs.length ? ` en ${prList(p.prs)}` : ''}`),
  ].join('\n') : '';
  const sep = head && gen ? '\n\n' : '';
  if (head.length + sep.length + gen.length <= max) return head + sep + gen;
  const tail = `\n\n…la lista sigue; el resto: ${compareUrl}`;
  const room = Math.max(0, max - head.length - sep.length - tail.length);
  const cut = gen.lastIndexOf('\n', room);
  return head + sep + gen.slice(0, cut > 0 ? cut : room) + tail;
}

// ── git y la API ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Las etiquetas de número de la copia: `[{ name, date, sha }]` (la fecha, en segundos; el commit al que apuntan). */
function readTags(root) {
  const r = spawnSync('git', ['-C', root, 'for-each-ref', '--format=%(refname:strip=2)%09%(creatordate:unix)%09%(objectname)%09%(*objectname)', `refs/tags/${VO.TAG_PREFIX}*`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  if (r.status !== 0) throw new Error(`no pude listar las etiquetas: ${String(r.stderr || '').trim() || 'git falló'}`);
  return String(r.stdout || '').split('\n').filter(Boolean).map((l) => {
    const [name, date, obj, deref] = l.split('\t');
    return { name, date: Number(date), sha: deref || obj };
  }).filter((t) => VO.fromTag(t.name));
}

/** Un cliente de la API REST del repo: `api(método, ruta, cuerpo)` → `{ status, json }`. */
function apiClient({ token, repo, base }) {
  return async (method, route, body) => {
    const r = await fetch(`${base}/repos/${repo}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { status: r.status, json };
  };
}

/** Todos los commits entre dos etiquetas, página por página. `{ commits, cut }` o `{ error }`. */
async function compareAll(api, prev, current) {
  const commits = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const r = await api('GET', `/compare/${prev}...${current}?per_page=${PER_PAGE}&page=${page}`);
    if (r.status !== 200 || !r.json) return { error: `no pude comparar ${prev} con ${current} (HTTP ${r.status})` };
    const got = Array.isArray(r.json.commits) ? r.json.commits : [];
    commits.push(...got);
    if (got.length < PER_PAGE || commits.length >= Number(r.json.total_commits || 0)) return { commits, cut: false };
  }
  return { commits, cut: true };
}

/** Los pedidos que entraron a main con alguno de esos commits (el de un fork que se cerró sin entrar no cuenta). */
async function mergedPrs(api, shas, log) {
  const prs = new Set();
  for (const sha of shas.slice(0, MAX_SHAS_PER_LOGIN)) {
    const r = await api('GET', `/commits/${sha}/pulls`);
    if (r.status !== 200 || !Array.isArray(r.json)) { log(`weekly-release: no pude ver los pedidos de ${String(sha).slice(0, 7)} (HTTP ${r.status})`); continue; }
    for (const p of r.json) if (p && p.merged_at && p.base && p.base.ref === 'main') prs.add(p.number);
  }
  return [...prs].sort((a, b) => a - b);
}

function fail(log, message) { log(`::error::weekly-release: ${message}`); return 2; }

/**
 * La corrida. `readTags()` → las etiquetas de la copia; `api` como la de `apiClient`; `now` en segundos; `repoUrl` la
 * página del repo (para el enlace al resto de la lista). Devuelve la salida.
 */
async function run({ sha, now, env, api, readTags: tagsOf, repoUrl, log = console.log }) {
  let tags;
  try { tags = tagsOf(); } catch (e) { return fail(log, e.message); }
  const best = VO.bestTag(tags.filter((t) => t.sha === sha).map((t) => t.name));
  if (!best) { log(`weekly-release: ${String(sha).slice(0, 7)} no tiene número (ya no era la punta de main): la corrida siguiente lo ve`); return 0; }
  const current = VO.tagName(best);
  const maintainers = parseMaintainers(env.MAINTAINER_LOGINS);
  if (!maintainers.length) {
    log('::warning::weekly-release: falta la variable de Actions MAINTAINER_LOGINS (las cuentas del equipo, separadas por comas): sin ella no sé quién es de afuera, y no publico la versión de la semana');
    return 0;
  }
  const last = await api('GET', '/releases/latest');
  let latest = null;
  if (last.status === 200 && last.json) latest = { tag: last.json.tag_name, publishedAt: Date.parse(last.json.published_at) / 1000 };
  else if (last.status !== 404) return fail(log, `no pude leer la última versión publicada (HTTP ${last.status})`);
  const d = due({ now, latest });
  if (!d.due) { log(`weekly-release: no toca: ${d.reason}`); return 0; }
  const ref = await api('GET', `/git/ref/tags/${current}`);
  if (ref.status === 404) { log(`weekly-release: ${current} no está en el servidor: no publico (crear la versión crearía la etiqueta en otro commit)`); return 0; }
  if (ref.status !== 200) return fail(log, `no pude ver si ${current} está en el servidor (HTTP ${ref.status})`);

  const prev = previousTag({ latest, tags, now, current });
  let commits = [];
  if (prev) {
    const c = await compareAll(api, prev, current);
    if (c.error) return fail(log, c.error);
    if (c.cut) log(`::warning::weekly-release: más de ${PER_PAGE * MAX_PAGES} commits desde ${prev}: miro los primeros`);
    commits = c.commits;
  } else {
    log('weekly-release: no hay etiqueta anterior: las notas no nombran a nadie de afuera');
  }
  const o = outsiders({ commits, maintainers });
  if (o.unknown) log(`weekly-release: ${o.unknown} commit(s) sin cuenta de GitHub: no se nombran (si alguno es de afuera, se suma a mano en la página de la versión)`);
  const people = [];
  for (const x of o.outsiders) people.push({ login: x.login, prs: await mergedPrs(api, x.shas, log) });

  const gen = await api('POST', '/releases/generate-notes', { tag_name: current, ...(prev ? { previous_tag_name: prev } : {}) });
  if (gen.status !== 200 || !gen.json) return fail(log, `no pude armar las notas de ${current} (HTTP ${gen.status})`);
  const compareUrl = prev ? `${repoUrl}/compare/${prev}...${current}` : `${repoUrl}/commits/${current}`;
  const body = releaseBody({ outsiders: people, generated: gen.json.body, compareUrl });
  const pub = await api('POST', '/releases', { tag_name: current, name: current, body, generate_release_notes: false, make_latest: 'true' });
  const errors = pub.json && Array.isArray(pub.json.errors) ? pub.json.errors : [];
  if (pub.status === 422 && errors.some((e) => e && e.code === 'already_exists')) { log(`weekly-release: la versión ${current} ya existe`); return 0; }
  if (pub.status !== 201) return fail(log, `no pude publicar la versión ${current} (HTTP ${pub.status}${pub.json && pub.json.message ? `: ${pub.json.message}` : ''})`);
  log(`weekly-release: publiqué ${current} (${d.reason}) · de afuera: ${people.map((p) => `@${p.login}`).join(', ') || 'nadie'}`);
  return 0;
}

async function main(argv) {
  const i = argv.indexOf('--sha');
  const sha = i >= 0 ? argv[i + 1] : null;
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) return fail(console.log, `--sha tiene que ser el commit completo (40 hex), llegó «${sha}»`);
  // las direcciones las pone Actions en el ambiente de la corrida: el guion no escribe ninguna
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_API_URL: apiBase, GITHUB_SERVER_URL: server } = process.env;
  if (!token || !repo || !apiBase || !server) {
    return fail(console.log, 'faltan GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL o GITHUB_SERVER_URL: corre en Actions (version-tag.yml), que las pone');
  }
  return run({
    sha,
    now: Math.floor(Date.now() / 1000),
    env: process.env,
    api: apiClient({ token, repo, base: apiBase }),
    readTags: () => readTags(process.cwd()),
    repoUrl: `${server}/${repo}`,
  });
}

if (require.main === module) main(process.argv.slice(2)).then((rc) => { process.exitCode = rc; });

module.exports = { due, previousTag, parseMaintainers, outsiders, releaseBody, readTags, run, PERIOD_DAYS };
