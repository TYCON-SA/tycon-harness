'use strict';
/**
 * main-entries.test.js — cuántas entradas a la rama principal no pasaron por su CI, en GitHub y en Azure DevOps.
 *
 * GitHub es un servidor local que contesta como su API (`TYCON_GITHUB_API`); Azure es un `az` de mentira escrito acá,
 * que contesta por los argumentos desde unos archivos (`TYCON_ADO_CMD`). Ningún caso toca la red.
 * Correr: node --test scripts/tests/main-entries.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const GUION = path.join(RAIZ, 'scripts', 'nightly', 'main-entries', 'main-entries.js');
const LINEA = /^Main sin su CI \(72 h\): GitHub (\d+|\?) · Azure (\d+|\?) · reglas (al día|cambiaron|\?)$/;

// stable-data: la ventana de 72 horas se mide contra un reloj fijo que se le pasa al guion (--now)
const AHORA = Date.parse('2026-11-07T12:00:00Z');
const hace = (h) => new Date(AHORA - h * 3600000).toISOString();

/** Una cadena de primer padre de la rama principal, de la punta hacia atrás: cada commit con su hora (horas atrás). */
function cadena(horas, { segundos = {} } = {}) {
  const shas = horas.map((_, i) => `c${String(i).padStart(39, '0')}`);
  const raiz = 'r'.padEnd(40, '0');
  return horas.map((h, i) => ({ sha: shas[i], commit: { committer: { date: hace(h) } },
    parents: [{ sha: shas[i + 1] || raiz }, ...(segundos[i] ? [{ sha: segundos[i] }] : [])] }));
}
/** Una corrida de cola: `horas` es cuándo terminó (cuándo entró su commit), en horas atrás. */
const corrida = (sha, { conclusion = 'success', name = 'public-ci', branch = 'gh-readonly-queue/main/pr-1-x', event = 'merge_group', horas = 1 } = {}) =>
  ({ name, path: '.github/workflows/ci.yml', head_branch: branch, head_sha: sha, conclusion, status: 'completed', event,
    created_at: hace(horas + 0.5), updated_at: hace(horas) });

/** El GitHub de mentira: `commits` (la lista desde la punta), `corridas`, el padre fuera de la lista y lo que falla. */
function github(t, { commits, corridas = [], padre = null, falla = null }) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (falla && falla.test(u.pathname)) return json(500, { message: 'falla de mentira' });
    if (u.pathname === '/repos/o/r') return json(200, { default_branch: 'main' });
    if (u.pathname === '/repos/o/r/commits') {
      const page = Number(u.searchParams.get('page') || 1);
      const per = Number(u.searchParams.get('per_page') || 30);
      return json(200, commits.slice((page - 1) * per, page * per));
    }
    const uno = /^\/repos\/o\/r\/commits\/([0-9a-z]+)$/.exec(u.pathname);
    if (uno) return padre && padre.sha === uno[1] ? json(200, padre) : json(404, { message: 'Not Found' });
    if (u.pathname === '/repos/o/r/actions/runs') {
      const page = Number(u.searchParams.get('page') || 1);
      const per = Number(u.searchParams.get('per_page') || 30);
      // como la API: por evento, por commit y por hora de creación (`created=>=<fecha>`)
      const creado = /^>=(.+)$/.exec(u.searchParams.get('created') || '');
      const lista = corridas.filter((c) => (!u.searchParams.get('event') || c.event === u.searchParams.get('event'))
        && (!u.searchParams.get('head_sha') || c.head_sha === u.searchParams.get('head_sha'))
        && (!creado || Date.parse(c.created_at) >= Date.parse(creado[1])));
      return json(200, { total_count: lista.length, workflow_runs: lista.slice((page - 1) * per, page * per) });
    }
    return json(404, { message: 'Not Found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => server.close());
    resolve(`http://127.0.0.1:${server.address().port}`);
  }));
}

/** El `az` de mentira: los pedidos completados, el repo y sus políticas, desde una carpeta. `basura`: contesta texto. */
function azFalso(t, { pedidos = [], politicas = [], basura = false, falla = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-entries-az-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'pedidos.json'), JSON.stringify(pedidos));
  fs.writeFileSync(path.join(dir, 'politicas.json'), JSON.stringify(politicas));
  const az = path.join(dir, 'az');
  fs.writeFileSync(az, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2); const D = ${JSON.stringify(dir)};
if (${falla}) { process.stderr.write('ERROR: de mentira\\n'); process.exit(1); }
if (${basura}) { process.stdout.write('esto no es json'); process.exit(0); }
if (!args.includes('--org') || !args.includes('-o')) { process.stderr.write('ERROR: sin --org o sin -o json\\n'); process.exit(1); }
const v = (k) => { const i = args.indexOf(k); return i < 0 ? null : args[i + 1]; };
if (args[0] === 'devops' && args[1] === 'invoke' && v('--resource') === 'pullRequests') {
  const skip = Number((args.find((a) => a.startsWith('$skip=')) || '$skip=0').slice(6));
  const todos = JSON.parse(fs.readFileSync(path.join(D, 'pedidos.json'), 'utf8'));
  process.stdout.write(JSON.stringify({ count: 0, value: todos.slice(skip, skip + 100) })); process.exit(0);
}
if (args[0] === 'repos' && args[1] === 'show') { process.stdout.write(JSON.stringify({ id: 'id-del-repo', name: v('--repository') })); process.exit(0); }
if (args[0] === 'repos' && args[1] === 'policy' && args[2] === 'list') { process.stdout.write(fs.readFileSync(path.join(D, 'politicas.json'), 'utf8')); process.exit(0); }
process.stderr.write('az de mentira: no sé contestar ' + args.join(' ') + '\\n'); process.exit(2);
`, { mode: 0o755 });
  return az;
}
const pedido = (id, horas, bypass) => ({ pullRequestId: id, status: 'completed', closedDate: hace(horas), targetRefName: 'refs/heads/main',
  completionOptions: { bypassPolicy: bypass }, title: `pedido ${id}` });
const politica = (build, { enabled = true, blocking = true } = {}) => ({ id: build * 10, isEnabled: enabled, isBlocking: blocking, type: { displayName: 'Build' },
  settings: { buildDefinitionId: build, scope: [{ refName: 'refs/heads/main', matchKind: 'Exact', repositoryId: 'id-del-repo' }] } });

/** Corre el guion de verdad (de forma asíncrona: el GitHub de mentira vive en este mismo proceso). */
function correr(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [GUION, ...args, '--now', new Date(AHORA).toISOString()], { env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', ...env } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
function salida(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'main-entries-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'linea.txt');
}
const GH = () => ['github', '--repo', 'o/r', '--workflow', 'public-ci', '--hours', '72'];
const AZ_ARGS = ['azure', '--org', 'https://dev.azure.com/acme', '--project', 'p', '--repo', 'r', '--required-builds', '194,170', '--hours', '72'];

test('T16 Entradas_SinCola_SeCuentan @story-8.241 @ac-10', async (t) => {
  // la frontera es el commit que entró por la cola antes de la ventana (a las 100 h)
  const commits = cadena([2, 10, 30, 100], { segundos: { 0: 'x'.padEnd(40, '1') } });
  const api = await github(t, { commits, corridas: [corrida(commits[0].sha, { horas: 1 }), corrida(commits[2].sha, { horas: 29 }), corrida(commits[3].sha, { horas: 99 })] });
  const out = salida(t);
  const r = await correr([...GH(), '--out', out], { TYCON_GITHUB_API: api });
  assert.strictEqual(r.code, 0, r.err + r.out);
  const linea = fs.readFileSync(out, 'utf8').trim();
  assert.match(linea, /GitHub 1 /, linea);
  // el detalle (el commit sin cola) va a la salida estándar, no a la línea
  assert.match(r.out, new RegExp(commits[1].sha.slice(0, 12)));
  // un commit con fecha vieja empujado hoy (sin cola) cuenta: la fecha del commit no dice cuándo entró
  const vieja = cadena([100, 5, 10, 200]);
  const api2 = await github(t, { commits: vieja, corridas: [corrida(vieja[1].sha, { horas: 4 }), corrida(vieja[2].sha, { horas: 9 }), corrida(vieja[3].sha, { horas: 199 })] });
  const out2 = salida(t);
  const r2 = await correr([...GH(), '--out', out2], { TYCON_GITHUB_API: api2 });
  assert.strictEqual(r2.code, 0, r2.err + r2.out);
  assert.match(fs.readFileSync(out2, 'utf8'), /GitHub 1 /);
  assert.match(r2.out, new RegExp(`${vieja[0].sha.slice(0, 12)}.*fecha vieja`));
});

test('T17 Entradas_ColaQueNoAlcanza @story-8.241 @ac-10', async (t) => {
  // fallida, cancelada, de otro flujo, de otro commit, de otro evento, o de una rama que no es la de la cola: ninguna es cola
  const commits = cadena([1, 2, 3, 4, 5, 6, 90]);
  const api = await github(t, { commits,
    corridas: [corrida(commits[0].sha, { conclusion: 'failure' }), corrida(commits[1].sha, { conclusion: 'cancelled' }),
      corrida(commits[2].sha, { name: 'otro-flujo' }), corrida('d'.padEnd(40, '9')),
      corrida(commits[4].sha, { event: 'push' }), corrida(commits[5].sha, { branch: 'main' }), corrida(commits[6].sha, { horas: 89 })] });
  const out = salida(t);
  const r = await correr([...GH(), '--out', out], { TYCON_GITHUB_API: api });
  assert.strictEqual(r.code, 0, r.err + r.out);
  assert.match(fs.readFileSync(out, 'utf8'), /GitHub 6 /);
});

test('T18 Azure_PedidoSalteado_SeCuenta @story-8.241 @ac-11', async (t) => {
  const az = azFalso(t, { pedidos: [pedido(1, 5, false), pedido(2, 20, true), pedido(3, 100, true)], politicas: [politica(194), politica(170)] });
  const out = salida(t);
  const r = await correr([...AZ_ARGS, '--out', out], { TYCON_ADO_CMD: az });
  assert.strictEqual(r.code, 0, r.err + r.out);
  const linea = fs.readFileSync(out, 'utf8').trim();
  assert.match(linea, /Azure 1 · reglas al día$/, linea);
  assert.match(r.out, /pedido 2|#2\b/);
});

test('T19 Azure_PoliticaApagada_Cambiaron @story-8.241 @ac-11', async (t) => {
  for (const politicas of [[politica(194)], [politica(194), politica(170, { enabled: false })], [politica(194), politica(170, { blocking: false })]]) {
    const az = azFalso(t, { pedidos: [], politicas });
    const out = salida(t);
    const r = await correr([...AZ_ARGS, '--out', out], { TYCON_ADO_CMD: az });
    assert.strictEqual(r.code, 0, r.err + r.out);
    assert.match(fs.readFileSync(out, 'utf8').trim(), /reglas cambiaron$/, JSON.stringify(politicas));
  }
});

test('T20 NoMedido_NoEsCero @story-8.241 @ac-10 @ac-12 @ac-13', async (t) => {
  // GitHub contesta 500
  const commits = cadena([1, 2]);
  const caida = await github(t, { commits, falla: /commits/ });
  const az = azFalso(t, { pedidos: [], politicas: [politica(194), politica(170)] });
  let out = salida(t);
  let r = await correr([...GH(), ...AZ_ARGS, '--out', out], { TYCON_GITHUB_API: caida, TYCON_ADO_CMD: az });
  assert.strictEqual(r.code, 1, r.err + r.out);
  let linea = fs.readFileSync(out, 'utf8').trim();
  assert.match(linea, LINEA, linea);
  assert.match(linea, /GitHub \? · Azure 0 · reglas al día/, linea);
  assert.match(r.out, /no se pudo consultar/);
  // la cadena de primer padre se corta antes de la frontera de la ventana: no se cuenta lo que no se leyó
  const corta = cadena([1, 2]);
  const cortada = await github(t, { commits: corta, corridas: [corrida(corta[0].sha), corrida(corta[1].sha, { horas: 2 })] });
  out = salida(t);
  r = await correr([...GH(), '--out', out], { TYCON_GITHUB_API: cortada });
  assert.strictEqual(r.code, 1, r.err + r.out);
  assert.match(fs.readFileSync(out, 'utf8'), /GitHub \? /);
  // az contesta algo ilegible
  const ilegible = azFalso(t, { basura: true });
  out = salida(t);
  r = await correr([...AZ_ARGS, '--out', out], { TYCON_ADO_CMD: ilegible });
  assert.strictEqual(r.code, 1, r.err + r.out);
  linea = fs.readFileSync(out, 'utf8').trim();
  assert.match(linea, /Azure \? · reglas \?$/, linea);
  // la línea es una sola, con números: ni commits, ni pedidos, ni motivos
  assert.strictEqual(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).length, 1);
  assert.doesNotMatch(linea, /acme|pedido|no se pudo/);
});
