'use strict';
/**
 * weekly-release.test.js — la versión de la semana (scripts/ci/weekly-release.js): cuándo se publica, desde qué
 * etiqueta se cuenta, a quién nombra «Contribuciones de afuera» y qué hace cuando algo falta o falla. La API de GitHub
 * es de mentira (una función que contesta por ruta y anota lo que se le pidió): sin red.
 *
 * 🔴 Falla con: la guía de colaboración promete nombrar en las notas de la versión publicada a quien contribuyó, y no
 * había versión publicada; y las notas automáticas de GitHub nombran al autor del PEDIDO, que en un pedido de un fork
 * de organización (entra por una rama nuestra) es una cuenta del equipo.
 *
 * Correr:   node --test scripts/tests/weekly-release.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WR = require(path.join(__dirname, '..', 'ci', 'weekly-release.js'));

const DAY = 24 * 3600;
const NOW = Date.UTC(2026, 10, 24, 12) / 1000;
const SHA = 'a'.repeat(40);

test('T1 Due_SieteDiasDesdeLaUltima: sin ninguna publica; con 6 días no; con 7 sí', () => {
  assert.strictEqual(WR.due({ now: NOW, latest: null }).due, true);
  assert.strictEqual(WR.due({ now: NOW, latest: { tag: 'v2026.11.18.4', publishedAt: NOW - 6 * DAY } }).due, false);
  assert.strictEqual(WR.due({ now: NOW, latest: { tag: 'v2026.11.17.4', publishedAt: NOW - 7 * DAY } }).due, true);
  assert.match(WR.due({ now: NOW, latest: { tag: 'v2026.11.20.1', publishedAt: NOW - 4 * DAY } }).reason, /4 días/);
});

test('T2 PreviousTag_LaDeLaUltimaVersion_OLaDeHaceUnaSemana', () => {
  const tags = [
    { name: 'v2026.11.10.3', date: NOW - 14 * DAY },
    { name: 'v2026.11.16.9', date: NOW - 8 * DAY },
    { name: 'v2026.11.16.10', date: NOW - 8 * DAY },
    { name: 'v2026.11.23.2', date: NOW - 1 * DAY },
    { name: 'v2026.11.24.1', date: NOW },
    { name: 'otra-cosa', date: NOW - 30 * DAY },
  ];
  // con una versión publicada, desde su etiqueta
  assert.strictEqual(WR.previousTag({ latest: { tag: 'v2026.11.16.9' }, tags, now: NOW, current: 'v2026.11.24.1' }), 'v2026.11.16.9');
  // la primera: la etiqueta más nueva de hace 7 días o más (por número, no por orden de texto)
  assert.strictEqual(WR.previousTag({ latest: null, tags, now: NOW, current: 'v2026.11.24.1' }), 'v2026.11.16.10');
  // ninguna tan vieja: la más vieja que hay; ninguna otra: null
  assert.strictEqual(WR.previousTag({ latest: null, tags: tags.slice(3), now: NOW, current: 'v2026.11.24.1' }), 'v2026.11.23.2');
  assert.strictEqual(WR.previousTag({ latest: null, tags: [{ name: 'v2026.11.24.1', date: NOW }], now: NOW, current: 'v2026.11.24.1' }), null);
});

test('T3 Maintainers_ComasEspaciosYArroba', () => {
  assert.deepStrictEqual(WR.parseMaintainers(' @Dev-A, dev-b\ndev-c ,, '), ['Dev-A', 'dev-b', 'dev-c']);
  assert.deepStrictEqual(WR.parseMaintainers(''), []);
  assert.deepStrictEqual(WR.parseMaintainers(undefined), []);
});

test('T4 Outsiders_PorAutorDelCommit: el equipo (sin importar mayúsculas) y los robots no; sin cuenta se cuenta aparte', () => {
  const commits = [
    { sha: '1', author: { login: 'dev-a', type: 'User' } },
    { sha: '2', author: { login: 'DEV-B', type: 'User' } },
    { sha: '3', author: { login: 'colabora-x', type: 'User' } },
    { sha: '4', author: { login: 'colabora-x', type: 'User' } },
    { sha: '5', author: { login: 'dependabot[bot]', type: 'Bot' } },
    { sha: '6', author: { login: 'algo-app', type: 'Bot' } },
    { sha: '7', author: null },
    { sha: '8', author: { login: 'colabora-y', type: 'User' } },
  ];
  const r = WR.outsiders({ commits, maintainers: ['Dev-A', 'dev-b'] });
  assert.deepStrictEqual(r.outsiders, [{ login: 'colabora-x', shas: ['3', '4'] }, { login: 'colabora-y', shas: ['8'] }]);
  assert.strictEqual(r.unknown, 1);
});

test('T5 Body_NombraConSusPedidos_YCortaLoGeneradoSiNoEntra', () => {
  const b = WR.releaseBody({ outsiders: [{ login: 'colabora-x', prs: [1686, 1690] }, { login: 'colabora-y', prs: [] }], generated: '## What\'s Changed\n* algo', compareUrl: 'https://x/compare/a...b' });
  assert.match(b, /^## Contribuciones de afuera\n/);
  assert.match(b, /^- @colabora-x en #1686 y #1690$/m);
  assert.match(b, /^- @colabora-y$/m);
  assert.ok(b.indexOf('Contribuciones de afuera') < b.indexOf('What\'s Changed'), 'lo nuestro va arriba');
  // sin nadie de afuera, sólo lo generado
  assert.strictEqual(WR.releaseBody({ outsiders: [], generated: 'G', compareUrl: 'u' }), 'G');
  // lo generado que no entra en el límite de GitHub se corta en un renglón y dice dónde está el resto
  const largo = Array.from({ length: 5000 }, (_, i) => `* pedido ${i} ${'x'.repeat(40)}`).join('\n');
  const c = WR.releaseBody({ outsiders: [{ login: 'colabora-x', prs: [1] }], generated: largo, compareUrl: 'https://x/compare/a...b', max: 2000 });
  assert.ok(c.length <= 2000, `${c.length}`);
  assert.match(c, /@colabora-x/);
  assert.match(c, /el resto: https:\/\/x\/compare\/a\.\.\.b$/);
});

/** Una API de mentira: `rutas` contesta por «MÉTODO ruta» (sin el query) y anota cada pedido. */
function fakeApi(rutas) {
  const calls = [];
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    const key = `${method} ${route.split('?')[0]}`;
    const h = rutas[key];
    if (!h) return { status: 404, json: { message: 'Not Found' } };
    return typeof h === 'function' ? h(route, body) : h;
  };
  return { api, calls };
}

const TAGS = [
  { name: 'v2026.11.16.9', date: NOW - 8 * DAY, sha: 'b'.repeat(40) },
  { name: 'v2026.11.24.1', date: NOW, sha: SHA },
];

function correr({ env = { MAINTAINER_LOGINS: 'dev-a dev-b' }, rutas, tags = TAGS }) {
  const { api, calls } = fakeApi(rutas);
  const log = [];
  return WR.run({ sha: SHA, now: NOW, env, api, readTags: () => tags, repoUrl: 'https://github.com/o/r', log: (l) => log.push(l) })
    .then((rc) => ({ rc, calls, log: log.join('\n') }));
}

const RUTAS_DE_UNA_SEMANA = (extra = {}) => ({
  'GET /releases/latest': { status: 200, json: { tag_name: 'v2026.11.16.9', published_at: new Date((NOW - 8 * DAY) * 1000).toISOString() } },
  'GET /git/ref/tags/v2026.11.24.1': { status: 200, json: { ref: 'refs/tags/v2026.11.24.1' } },
  'GET /compare/v2026.11.16.9...v2026.11.24.1': (route) => {
    const page = Number((/[?&]page=(\d+)/.exec(route) || [])[1] || 1);
    const todos = [
      { sha: '1', author: { login: 'dev-a', type: 'User' } },
      { sha: '2', author: { login: 'colabora-x', type: 'User' } },
      { sha: '3', author: null },
    ];
    return { status: 200, json: { total_commits: todos.length, commits: page === 1 ? todos : [] } };
  },
  'GET /commits/2/pulls': { status: 200, json: [
    { number: 1681, merged_at: null, base: { ref: 'main' } },
    { number: 1686, merged_at: '2026-11-24T10:00:00Z', base: { ref: 'main' } }] },
  'POST /releases/generate-notes': { status: 200, json: { name: 'x', body: '## What\'s Changed\n* algo por @dev-a' } },
  'POST /releases': { status: 201, json: { html_url: 'https://github.com/o/r/releases/tag/v2026.11.24.1' } },
  ...extra,
});

test('T6 Run_PasaronSieteDias_PublicaConLasNotasYLosDeAfuera', async () => {
  const r = await correr({ rutas: RUTAS_DE_UNA_SEMANA() });
  assert.strictEqual(r.rc, 0, r.log);
  const notas = r.calls.find((c) => c.method === 'POST' && c.route === '/releases/generate-notes');
  assert.deepStrictEqual(notas.body, { tag_name: 'v2026.11.24.1', previous_tag_name: 'v2026.11.16.9' });
  const pub = r.calls.find((c) => c.method === 'POST' && c.route === '/releases');
  assert.ok(pub, r.log);
  assert.strictEqual(pub.body.tag_name, 'v2026.11.24.1');
  assert.strictEqual(pub.body.generate_release_notes, false, 'las notas ya vienen armadas: GitHub no las arma otra vez');
  assert.match(pub.body.body, /^- @colabora-x en #1686$/m, 'el pedido que entró, no el del fork que se cerró');
  assert.doesNotMatch(pub.body.body, /@dev-a en/, 'el equipo no va en «de afuera»');
  assert.match(pub.body.body, /What's Changed/);
  assert.match(r.log, /1 commit\(s\) sin cuenta de GitHub/);
});

test('T7 Run_MenosDeSieteDias_NoPublica', async () => {
  const r = await correr({ rutas: RUTAS_DE_UNA_SEMANA({
    'GET /releases/latest': { status: 200, json: { tag_name: 'v2026.11.20.1', published_at: new Date((NOW - 4 * DAY) * 1000).toISOString() } } }) });
  assert.strictEqual(r.rc, 0, r.log);
  assert.ok(!r.calls.some((c) => c.method === 'POST'), r.log);
  assert.match(r.log, /4 días/);
});

test('T8 Run_SinLaVariableDelEquipo_NoPublicaYAvisa', async () => {
  for (const env of [{}, { MAINTAINER_LOGINS: '  ' }]) {
    const r = await correr({ env, rutas: RUTAS_DE_UNA_SEMANA() });
    assert.strictEqual(r.rc, 0, r.log);
    assert.ok(!r.calls.some((c) => c.method === 'POST'), r.log);
    assert.match(r.log, /::warning::.*MAINTAINER_LOGINS/);
  }
});

test('T9 Run_ElCommitSinNumero_OLaEtiquetaQueNoLlego_NoPublica', async () => {
  // el commit no tiene etiqueta (no era la punta de main): nada, ni siquiera preguntar
  const sin = await correr({ rutas: RUTAS_DE_UNA_SEMANA(), tags: [TAGS[0]] });
  assert.strictEqual(sin.rc, 0, sin.log);
  assert.deepStrictEqual(sin.calls, []);
  // la etiqueta está en la copia pero no en el servidor: crear la versión crearía la etiqueta en otro commit
  const r = await correr({ rutas: RUTAS_DE_UNA_SEMANA({ 'GET /git/ref/tags/v2026.11.24.1': { status: 404, json: {} } }) });
  assert.strictEqual(r.rc, 0, r.log);
  assert.ok(!r.calls.some((c) => c.method === 'POST'), r.log);
  assert.match(r.log, /no está en el servidor/);
});

test('T10 Run_LaApiFalla_EsRojo; la que ya existe no', async () => {
  const caida = await correr({ rutas: RUTAS_DE_UNA_SEMANA({ 'GET /releases/latest': { status: 500, json: {} } }) });
  assert.strictEqual(caida.rc, 2, caida.log);
  const pub = await correr({ rutas: RUTAS_DE_UNA_SEMANA({ 'POST /releases': { status: 403, json: { message: 'Resource not accessible' } } }) });
  assert.strictEqual(pub.rc, 2, pub.log);
  assert.match(pub.log, /403/);
  const ya = await correr({ rutas: RUTAS_DE_UNA_SEMANA({ 'POST /releases': { status: 422, json: { errors: [{ code: 'already_exists' }] } } }) });
  assert.strictEqual(ya.rc, 0, ya.log);
  assert.match(ya.log, /ya existe/);
  // la primera versión: sin ninguna publicada, desde la etiqueta de hace una semana
  const primera = await correr({ rutas: RUTAS_DE_UNA_SEMANA({ 'GET /releases/latest': { status: 404, json: {} } }) });
  assert.strictEqual(primera.rc, 0, primera.log);
  assert.ok(primera.calls.some((c) => c.method === 'POST' && c.route === '/releases'), primera.log);
});

test('T11 Run_LaComparacionEnVariasPaginas_LasJuntaTodas', async () => {
  const todos = Array.from({ length: 230 }, (_, i) => ({ sha: `s${i}`, author: { login: i === 229 ? 'colabora-z' : 'dev-a', type: 'User' } }));
  const r = await correr({ rutas: RUTAS_DE_UNA_SEMANA({
    'GET /compare/v2026.11.16.9...v2026.11.24.1': (route) => {
      const page = Number(/[?&]page=(\d+)/.exec(route)[1]);
      const per = Number(/[?&]per_page=(\d+)/.exec(route)[1]);
      return { status: 200, json: { total_commits: todos.length, commits: todos.slice((page - 1) * per, page * per) } };
    },
    'GET /commits/s229/pulls': { status: 200, json: [{ number: 1700, merged_at: '2026-11-24T10:00:00Z', base: { ref: 'main' } }] } }) });
  assert.strictEqual(r.rc, 0, r.log);
  const pub = r.calls.find((c) => c.method === 'POST' && c.route === '/releases');
  assert.match(pub.body.body, /^- @colabora-z en #1700$/m);
});

test('T12 ReadTags_LasEtiquetasDeNumeroConSuFechaYSuCommit (git de verdad)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-release-'));
  const git = (...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...a], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-20T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-20T10:00:00Z' },
  });
  git('init', '-q');
  git('-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', 'commit', '-q', '--allow-empty', '-m', 'uno');
  git('tag', 'v2026.11.20.1');
  git('tag', 'no-es-de-numero');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  assert.deepStrictEqual(WR.readTags(dir), [{ name: 'v2026.11.20.1', date: Date.parse('2026-11-20T10:00:00Z') / 1000, sha: head }]);
});
