'use strict';

/**
 * engram-rescue.test.js — red de caja negra de `scripts/setup/engram-rescue-unexported.js`, la
 * herramienta que MUTA la memoria compartida del equipo.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 * *"La red de tests no cubre los caminos que mutan y puede quedar verde con producción rota."* Sin
 * casos para los caminos que mutan datos —elegir destino, tocar por la API, sincronizar—, se podrían
 * desconectar caminos productivos y las pruebas unitarias seguirían en verde.
 *
 * Todo corre contra un laboratorio de mentira: HOME propio, raíz de repos propia, una base SQLite
 * de verdad pero de juguete, un binario `engram` falso y una API falsa en localhost. **No se toca
 * nada real**: ni la DB del dev, ni sus repos, ni la red.
 *
 * Lo que fija:
 *   · el destino se resuelve ANTES del primer PATCH, y sólo si es inequívoco;
 *   · una fase incompleta NO habilita el sync, y cualquier parcial sale con exit ≠ 0;
 *   · después del sync se verifica POR IDs que la memoria haya viajado de verdad.
 *
 * Lanza procesos → throttle DIARIO.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawnSync, spawn, execFileSync } = require('child_process');

const TCG = path.resolve(__dirname, '..', '..');
const RESCUE = path.join(TCG, 'scripts', 'setup', 'engram-rescue-unexported.js');
const HAY_SQLITE = (() => { try { execFileSync('sqlite3', ['--version'], { stdio: 'ignore' }); return true; } catch (_e) { return false; } })();

// ── el laboratorio ──────────────────────────────────────────────────────────────────────────────
function lab() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'engres-'));
  const home = path.join(raiz, 'home');
  const repos = path.join(raiz, 'repos');
  const bin = path.join(raiz, 'bin');
  fs.mkdirSync(path.join(home, '.engram'), { recursive: true });
  fs.mkdirSync(repos, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  return { raiz, home, repos, bin, db: path.join(home, '.engram', 'engram.db') };
}

/** Base SQLite de juguete con las columnas que el script consulta. */
function db(L, filas) {
  const sqlLines = [
    'CREATE TABLE observations (id TEXT, type TEXT, project TEXT, deleted_at TEXT, sync_id TEXT);',
    ...filas.map((f) => `INSERT INTO observations VALUES ('${f.id}','${f.type || 'manual'}','${f.project}',NULL,'${f.sync_id}');`),
  ].join('\n');
  execFileSync('sqlite3', [L.db], { input: sqlLines });
}

/** Un repo del laboratorio. `pin` null = sin project name declarado. `git` false = no es repo git. */
function repo(L, nombre, { pin, git = true, chunks = [] } = {}) {
  const d = path.join(L.repos, nombre);
  fs.mkdirSync(path.join(d, '.engram', 'chunks'), { recursive: true });
  if (git) fs.mkdirSync(path.join(d, '.git'), { recursive: true });
  if (pin) fs.writeFileSync(path.join(d, '.engram', 'config.json'), JSON.stringify({ project_name: pin }));
  fs.writeFileSync(path.join(d, '.engram', 'manifest.json'), JSON.stringify({ chunks: [] }));
  for (const c of chunks) escribirChunk(d, c.id, c.sync_ids);
  return d;
}

function escribirChunk(repoDir, id, syncIds) {
  const linea = JSON.stringify({ observations: syncIds.map((s) => ({ sync_id: s })) });
  fs.writeFileSync(path.join(repoDir, '.engram', 'chunks', `${id}.jsonl.gz`), zlib.gzipSync(Buffer.from(linea + '\n')));
}

/**
 * El binario `engram` falso. `modo`:
 *   'exports'     → escribe un chunk con los sync_ids que recibe y sale 0
 *   'nothing-new' → imprime "Nothing new" y NO escribe nada (el falso verde de un «Nothing new»)
 *   'fails'       → exit 7
 */
function fakeEngram(L, modo, syncIds = []) {
  const js = path.join(L.bin, 'engram-impl.js');
  fs.writeFileSync(js, `
const fs=require('fs'),path=require('path'),zlib=require('zlib');
fs.appendFileSync(process.env.ENGRAM_LOG, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+'\\n');
const modo=${JSON.stringify(modo)};
if(modo==='fails'){ console.error('boom'); process.exit(7); }
if(modo==='nothing-new'){ console.log('Nothing new to export'); process.exit(0); }
const ids=${JSON.stringify(syncIds)};
const d=path.join(process.cwd(),'.engram','chunks');
fs.mkdirSync(d,{recursive:true});
fs.writeFileSync(path.join(d,'nuevo.jsonl.gz'), zlib.gzipSync(Buffer.from(JSON.stringify({observations:ids.map(s=>({sync_id:s}))})+'\\n')));
console.log('Observations: '+ids.length);
`);
  const sh = path.join(L.bin, 'engram');
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
}

/**
 * API falsa, EN OTRO PROCESO. `modo`: 'ok' | 'error500'.
 *
 * 🔴 Tiene que ser otro proceso: el script se lanza con `spawnSync`, que BLOQUEA el bucle de
 * eventos del proceso que corre el test. Un servidor http creado acá adentro nunca llegaría a
 * aceptar la conexión, y el `fetch` del hijo moriría por timeout — un test que falla por el
 * laboratorio, no por el código.
 */
function fakeApi(L, modo, borrarEnPrimerPatch, demoraMs) {
  const logApi = path.join(L.raiz, 'api.log');
  const puerto = path.join(L.raiz, 'api.port');
  fs.writeFileSync(logApi, '');
  const js = path.join(L.raiz, 'api.js');
  fs.writeFileSync(js, `
const http=require('http'),fs=require('fs');
const modo=${JSON.stringify(modo)};
const borrar=${JSON.stringify(borrarEnPrimerPatch || null)};
const demora=${JSON.stringify(demoraMs || 0)};
let primero=true;
const srv=http.createServer((req,res)=>{
  fs.appendFileSync(${JSON.stringify(logApi)}, req.method+' '+req.url+'\\n');
  if(req.url==='/health'){res.writeHead(200);res.end('ok');return;}
  if(borrar&&primero){primero=false;try{fs.rmSync(borrar,{recursive:true,force:true});}catch(e){}}
  if(demora&&req.url.startsWith('/observations')){setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');},demora);return;}
  if(modo==='error500'){res.writeHead(500);res.end('nope');return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');
});
srv.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(puerto)}, String(srv.address().port)));
`);
  const proc = spawn(process.execPath, [js], { stdio: 'ignore', detached: false });
  // Espera activa corta: el puerto se conoce recién cuando el server escucha.
  const hasta = Date.now() + 5000;
  let port = null;
  while (Date.now() < hasta) {
    try { const t = fs.readFileSync(puerto, 'utf8').trim(); if (t) { port = Number(t); break; } } catch (_e) { /* todavía no */ }
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']);   // ~50ms sin sleep de shell
  }
  if (!port) { try { proc.kill(); } catch (_e) {} throw new Error('la API falsa no levantó');  }
  return {
    port,
    close: () => { try { proc.kill(); } catch (_e) { /* ya murió */ } },
    get calls() { try { return fs.readFileSync(logApi, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')[1]); } catch (_e) { return []; } },
  };
}

function correr(L, api, args = ['--apply']) {
  const log = path.join(L.raiz, 'engram.log');
  fs.writeFileSync(log, '');
  const r = spawnSync(process.execPath, [RESCUE, ...args], {
    encoding: 'utf8', timeout: 60000,
    env: {
      PATH: `${L.bin}:${process.env.PATH}`, HOME: L.home,
      TYCON_REPOS_ROOT: L.repos, ENGRAM_API: `http://127.0.0.1:${api.port}`,
      ENGRAM_LOG: log, LANG: 'en_US.UTF-8',
      // La suite ejercita el rescate con dobles: declara su llave. Sin ella depende de que el
      // perfil del equipo prenda la memoria, y en la copia pública —sin perfil— el rescate dice «apagado» y sale
      // antes de lo que se mide.
      TYCON_ENGRAM: '1',
    },
  });
  return { ...r, engramCalls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), patches: api.calls.filter((u) => u.startsWith('/observations')) };
}

const SKIP = { skip: HAY_SQLITE ? false : 'sin sqlite3 en esta máquina' };

// ── el destino se resuelve ANTES de tocar, y sólo si es inequívoco ─────────────────
test('un contenedor cuyo sub-repo declara OTRO proyecto NO se usa como destino, y no se toca nada', SKIP, async () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'target', sync_id: 's1' }]);
  fs.mkdirSync(path.join(L.repos, 'Cont'), { recursive: true });
  fs.mkdirSync(path.join(L.repos, 'Cont', '.engram'), { recursive: true });
  fs.writeFileSync(path.join(L.repos, 'Cont', '.engram', 'config.json'), JSON.stringify({ project_name: 'target' }));
  repo(L, 'Cont/Ajeno', { pin: 'foreign', chunks: [{ id: 'c', sync_ids: ['x'] }] });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', ['s1']);
  const r = correr(L, api); api.close();

  assert.notEqual(r.status, 0, 'elegir un destino ajeno tiene que abortar, no seguir');
  assert.match(r.stderr, /No se tocó NADA/);
  assert.match(r.stderr, /--target/, 'tiene que pedir que el destino lo elija el dev (con --target, desde el 2026-09-06)');
  assert.equal(r.patches.length, 0, '🔴 ni un PATCH antes de saber dónde va a escribir');
  assert.equal(r.engramCalls.length, 0, 'ni un sync');
});

test('un contenedor con DOS sub-repos del mismo proyecto aborta en vez de adivinar', SKIP, async () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  fs.mkdirSync(path.join(L.repos, 'Cont', '.engram'), { recursive: true });
  fs.writeFileSync(path.join(L.repos, 'Cont', '.engram', 'config.json'), JSON.stringify({ project_name: 'p' }));
  repo(L, 'Cont/A', { pin: 'p' });
  repo(L, 'Cont/B', { pin: 'p' });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', ['s1']);
  const r = correr(L, api); api.close();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /2 sub-repos declaran/);
  assert.equal(r.patches.length, 0);
});

// 🔴 --target: con dos sub-repos del mismo proyecto el script aborta pidiendo
// «--repo <repo>» — y --repo es el filtro, no el destino: no hay forma de elegir. Falla con: sin la opción,
// la corrida aborta con «2 sub-repos».
test('un contenedor con DOS sub-repos del mismo proyecto SÍ rescata si el dev elige con --target', SKIP, async () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  fs.mkdirSync(path.join(L.repos, 'Cont', '.engram'), { recursive: true });
  fs.writeFileSync(path.join(L.repos, 'Cont', '.engram', 'config.json'), JSON.stringify({ project_name: 'p' }));
  repo(L, 'Cont/A', { pin: 'p' });
  repo(L, 'Cont/B', { pin: 'p' });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', ['s1']);
  const r = correr(L, api, ['--apply', '--target', 'Cont/B']); api.close();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.patches.length, 1);
  assert.ok(r.engramCalls.some((l) => JSON.parse(l).cwd.endsWith(path.join('Cont', 'B'))), 'el sync corrió en el sub-repo elegido: ' + r.engramCalls.join(' '));
  assert.match(r.stdout, /Falta commitear/);
});

test('--target que NO es un sub-repo legítimo del proyecto aborta sin tocar nada', SKIP, async () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  fs.mkdirSync(path.join(L.repos, 'Cont', '.engram'), { recursive: true });
  fs.writeFileSync(path.join(L.repos, 'Cont', '.engram', 'config.json'), JSON.stringify({ project_name: 'p' }));
  repo(L, 'Cont/A', { pin: 'p' });
  repo(L, 'Cont/B', { pin: 'p' });
  repo(L, 'Cont/Otro', { pin: 'ajeno' });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', ['s1']);
  const r = correr(L, api, ['--apply', '--target', 'Cont/Otro']); api.close();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--target Cont\/Otro no es un sub-repo/);
  assert.equal(r.patches.length, 0);
});

test('si el destino DESAPARECE mientras corre, no se sincroniza y la corrida sale con error', SKIP, () => {
  // 🔴 El escenario `rescue-missing-repo`: el repo se fue, pero el PATCH ya había
  // salido. Omitir el sync y terminar en 0 sería una mutación a medias declarada
  // como éxito. El destino se REVALIDA justo antes de sincronizar.
  //
  // El pin no se cambia ANTES de correr: el escaneo dejaría de ver observaciones varadas y el test
  // pasaría sin ejercer nada.
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }, { id: 'o2', project: 'p', sync_id: 's2' }]);
  const d = repo(L, 'Solo', { pin: 'p' });
  const api = fakeApi(L, 'ok', d); fakeEngram(L, 'exports', ['s1', 's2']);
  const r = correr(L, api); api.close();
  assert.notEqual(r.status, 0, 'el repo se fue: no puede terminar en 0');
  assert.equal(r.engramCalls.length, 0, 'no se sincroniza contra un destino que ya no está');
});

// ── nada de éxitos parciales ───────────────────────────────────────────────────────
test('si un PATCH falla, NO se sincroniza y la corrida sale con error', SKIP, async () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  repo(L, 'Solo', { pin: 'p' });
  const api = fakeApi(L, 'error500'); fakeEngram(L, 'exports', ['s1']);
  const r = correr(L, api); api.close();
  assert.notEqual(r.status, 0, '🔴 un HTTP 500 terminaba la corrida en 0');
  assert.equal(r.engramCalls.length, 0, 'exportar la mitad y declararlo hecho es el modo de falla que se está cerrando');
  assert.match(r.stderr, /NO se sincroniz/);
});

test('un sync con exit no-cero sale con error', SKIP, async () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  repo(L, 'Solo', { pin: 'p' });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'fails');
  const r = correr(L, api); api.close();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /el sync falló/);
});

test('"Nothing new" con observaciones varadas es ERROR, no éxito', SKIP, async () => {
  // El falso verde más peligroso: el cierre pedía commitear un `.engram/` donde no entró nada.
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  repo(L, 'Solo', { pin: 'p' });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'nothing-new');
  const r = correr(L, api); api.close();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /siguen varadas|quedan 1/);
  assert.doesNotMatch(r.stdout, /Falta commitear/, 'no se pide commitear lo que no viajó');
});

test('el camino feliz verifica POR IDs que la memoria viajó, y recién ahí pide commitear', SKIP, async () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }, { id: 'o2', project: 'p', sync_id: 's2' }]);
  repo(L, 'Solo', { pin: 'p' });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', ['s1', 's2']);
  const r = correr(L, api); api.close();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.patches.length, 2);
  assert.match(r.stdout, /verificado: las 2 están en los chunks/);
  assert.match(r.stdout, /Falta commitear/);
});

test('si el sync exporta SÓLO LA MITAD, el post-check lo caza', SKIP, async () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }, { id: 'o2', project: 'p', sync_id: 's2' }]);
  repo(L, 'Solo', { pin: 'p' });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', ['s1']);   // s2 se queda afuera
  const r = correr(L, api); api.close();
  assert.notEqual(r.status, 0, 'un export incompleto no puede dar verde');
  assert.match(r.stderr, /quedan 1/);
});

// ── rastro de hasta dónde llegó ────────────────────────────────────────────────────
test('la corrida deja journal de cada fase que muta', SKIP, async () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  repo(L, 'Solo', { pin: 'p' });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', ['s1']);
  const r = correr(L, api); api.close();
  assert.equal(r.status, 0, r.stderr);
  const j = path.join(L.home, '.claude', '.tycon-pipeline', 'engram-rescue.jsonl');
  const fases = fs.readFileSync(j, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).fase);
  for (const f of ['resolucion', 'tocar', 'tocado', 'postcheck', 'cierre']) {
    assert.ok(fases.includes(f), `falta la fase "${f}" en el journal: si la corrida se corta, nadie sabe hasta dónde llegó`);
  }
});

test('el dry-run no toca NADA', SKIP, async () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  repo(L, 'Solo', { pin: 'p' });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', ['s1']);
  const r = correr(L, api, []); api.close();
  assert.equal(r.status, 0);
  assert.equal(r.patches.length, 0);
  assert.equal(r.engramCalls.length, 0);
  assert.match(r.stdout, /Dry-run/);
});

// ── autoheal — el punto de restauración ─────────────────────────────────
//
// El autoheal tiene el `--apply` automático APAGADO a propósito, pero una persona lo puede correr
// a mano. Su backup con SÓLO LA FECHA haría que la segunda corrida del día pisara el único punto de
// restauración — justo cuando más falta hace, porque la primera ya movió memoria. Y sin
// verificar que la copia se pueda leer, un backup corrupto sería peor que ninguno, porque se
// decide mutar confiando en él.

test('el backup del autoheal no se pisa entre corridas y se verifica que se pueda leer', SKIP, () => {
  // 🔴 Corre en OTRO PROCESO con HOME de laboratorio: `engram-autoheal.js` resuelve la ruta de la
  // base AL CARGARSE, así que pisar `process.env.HOME` después del require no aísla nada — y el
  // test terminaría haciendo backups de la base REAL del dev. Un test que toca producción para
  // probar que algo no toca producción no es un test.
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  const runner = path.join(L.raiz, 'backup-runner.js');
  fs.writeFileSync(runner, `
const { hacerBackup } = require(${JSON.stringify(path.join(TCG, 'scripts', 'lib', 'engram-autoheal.js'))});
const a = hacerBackup(); const b = hacerBackup();
console.log(JSON.stringify({ a, b }));
`);
  const r = spawnSync(process.execPath, [runner], {
    encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME: L.home, LANG: 'en_US.UTF-8' },
  });
  assert.equal(r.status, 0, r.stderr);
  const { a, b } = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.ok(!a.error, `primer backup: ${a.error}`);
  assert.ok(!b.error, `segundo backup: ${b.error}`);
  assert.notEqual(a.destino, b.destino, '🔴 dos corridas no pueden compartir el único punto de restauración');
  assert.equal(typeof a.observaciones, 'number', 'el backup se verifica consultándolo, no mirando si el archivo existe');
  assert.equal(fs.existsSync(a.destino), true, 'el primer punto de restauración sigue estando después del segundo');
});

// ── filtros y schemas que producen falsos verdes ─────────────────────────────────

test('un typo en --repo es ERROR con la lista de repos válidos, no "todo viajó"', SKIP, () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  repo(L, 'Solo', { pin: 'p' });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', ['s1']);
  const r = correr(L, api, ['--apply', '--repo', 'NoExiste']); api.close();
  assert.equal(r.status, 2, '"no matcheó el filtro" y "no hay nada varado" son respuestas distintas');
  assert.match(r.stderr, /Repos conocidos/);
  assert.match(r.stderr, /Solo/, 'tiene que nombrar los válidos para que el typo se corrija solo');
  assert.equal(r.patches.length, 0);
});

test('--repo sin valor es ERROR, no "sin filtro"', SKIP, () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  repo(L, 'Solo', { pin: 'p' });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', ['s1']);
  const r = correr(L, api, ['--repo', '--apply']); api.close();
  assert.equal(r.status, 2, 'un flag mal escrito tiene que frenar, no ampliar el alcance a todos los repos');
  assert.equal(r.patches.length, 0, 'y mucho menos tocar nada');
});

test('una observación exportada por el chunk de un repo HERMANO no se vuelve a tocar', SKIP, () => {
  // Los 3 repos del grupo comparten un proyecto. El conteo de ARRIBA (harness-audit) agrupa bien; el
  // recálculo DE ADENTRO del loop, si mirara sólo al representante del grupo, con
  // una observación de verdad varada en el grupo volvería a tocar la que exportó un hermano en
  // CADA corrida — trabajo de más, para siempre, sin que nadie sepa por qué.
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }, { id: 'o2', project: 'p', sync_id: 's2' }]);
  repo(L, 'GrupoA', { pin: 'p' });
  repo(L, 'GrupoB', { pin: 'p', chunks: [{ id: 'c', sync_ids: ['s1'] }] });
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', ['s1', 's2']);
  const r = correr(L, api, ['--apply']); api.close();
  assert.equal(r.patches.length, 1, `s1 ya viajó por el hermano: tocarla de nuevo es el bug (tocadas: ${r.patches.length})`);
});

test('un chunk ilegible se AVISA — sus observaciones van a aparecer como varadas', SKIP, () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  const d = repo(L, 'Solo', { pin: 'p' });
  fs.writeFileSync(path.join(d, '.engram', 'chunks', 'roto.jsonl.gz'), Buffer.from('esto no es gzip'));
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', ['s1']);
  const r = correr(L, api, ['--apply']); api.close();
  assert.match(r.stderr, /ILEGIBLE/, 'ignorarlo en silencio era re-tocar sus observaciones en cada corrida sin que nadie supiera por qué');
});

test('reindex: chunks sin manifest es ROJO, no "todo está en el índice"', SKIP, () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  const d = repo(L, 'Solo', { pin: 'p', chunks: [{ id: 'c', sync_ids: ['s1'] }] });
  fs.unlinkSync(path.join(d, '.engram', 'manifest.json'));
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', []);
  const r = correr(L, api, ['--reindex']); api.close();
  assert.equal(r.status, 1, 'memoria que viajó por git y nadie puede importar, reportada como sana: ése era el falso verde');
  assert.match(r.stderr, /NO hay manifest/);
});

// ── El índice que MIENTE sobre lo que ya tiene indexado ──────────────────────────
// Un `--reindex` que mire sólo los chunks que FALTAN en el índice, con `if (!faltan.length) continue;`,
// saltea el repo entero apenas no falte ninguno, y nunca revisa las entradas que sí están.
// Una entrada puede declarar `sessions: 0, memories: 1` mientras su archivo trae 1/3 o 15/82 — memorias que el
// índice no cuenta (por ejemplo tras una reconstrucción manual post-conflicto), y la corrida imprimiría, sin
// pestañear, "✅ Todo chunk en disco está en el índice de su repo".
// No se pierde memoria (el import lee los archivos, no los contadores): lo que miente es el censo.

test('reindex: una entrada que declara MENOS de lo que trae su chunk es ROJO', SKIP, () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  const d = repo(L, 'Solo', { pin: 'p', chunks: [{ id: 'c', sync_ids: ['s1', 's2', 's3'] }] });
  // el índice está COMPLETO (no falta ningún chunk) pero la entrada sub-declara: 1 de 3
  fs.writeFileSync(path.join(d, '.engram', 'manifest.json'), JSON.stringify({
    chunks: [{ id: 'c', created_by: 'x', created_at: '2026-08-22T00:00:00Z', sessions: 0, memories: 1, prompts: 0 }],
  }));
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', []);
  const r = correr(L, api, ['--reindex']); api.close();
  assert.notEqual(r.status, 0, 'un índice que sub-declara su propio contenido no puede salir en verde');
  assert.match(`${r.stdout}${r.stderr}`, /Solo\/c/, 'tiene que nombrar la entrada que no cierra');
  assert.doesNotMatch(r.stdout, /Todo chunk en disco está en el índice/,
    'ése era el falso verde: el índice completo se leía como índice correcto');
});

test('reindex --apply corrige los contadores de la entrada, sin tocar el chunk', SKIP, () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  const d = repo(L, 'Solo', { pin: 'p', chunks: [{ id: 'c', sync_ids: ['s1', 's2', 's3'] }] });
  const fMan = path.join(d, '.engram', 'manifest.json');
  const fChunk = path.join(d, '.engram', 'chunks', 'c.jsonl.gz');
  const antesChunk = fs.readFileSync(fChunk);
  fs.writeFileSync(fMan, JSON.stringify({
    chunks: [{ id: 'c', created_by: 'x', created_at: '2026-08-22T00:00:00Z', sessions: 0, memories: 1, prompts: 0 }],
  }));
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', []);
  const r = correr(L, api, ['--reindex', '--apply']); api.close();
  // Una corrida que ARREGLÓ todo no puede leerse como una que encontró problemas: el 🔴 es para
  // lo que queda pendiente. Sin esto, `--apply` grita por lo que acaba de corregir.
  assert.doesNotMatch(r.stderr, /🔴 el índice sub-declara/,
    'con --apply ya está corregido: gritarlo igual entrena a ignorar el 🔴');
  assert.equal(r.status, 0, 'corregido = verde');
  const man = JSON.parse(fs.readFileSync(fMan, 'utf8'));
  assert.equal(man.chunks.length, 1, 'no duplica la entrada: la corrige');
  assert.equal(man.chunks[0].memories, 3, `el contador tiene que salir del chunk (dio ${man.chunks[0].memories})`);
  assert.equal(man.chunks[0].created_by, 'x', 'lo que no es un contador no se toca');
  assert.deepEqual(fs.readFileSync(fChunk), antesChunk, 'el chunk es la fuente de verdad: no se reescribe');
});

test('reindex: un manifest que CIERRA exacto sigue saliendo en verde', SKIP, () => {
  // El espejo obligatorio. Sin él, el chequeo nuevo podría estar dando rojo siempre y nadie lo
  // notaría hasta que alguien lo apague por ruidoso — con lo que se pierde también la señal real.
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  const d = repo(L, 'Solo', { pin: 'p', chunks: [{ id: 'c', sync_ids: ['s1', 's2'] }] });
  fs.writeFileSync(path.join(d, '.engram', 'manifest.json'), JSON.stringify({
    chunks: [{ id: 'c', created_by: 'x', created_at: '2026-08-22T00:00:00Z', sessions: 0, memories: 2, prompts: 0 }],
  }));
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', []);
  const r = correr(L, api, ['--reindex']); api.close();
  assert.equal(r.status, 0, `un índice correcto no puede dar rojo (stderr: ${r.stderr.slice(0, 200)})`);
  assert.match(r.stdout, /Todo chunk en disco está en el índice/);
});

test('reindex: un chunk ILEGIBLE no se cuenta como desajuste — se avisa', SKIP, () => {
  // "No pude leerlo" y "declara mal" son cosas distintas: confundirlas haría que un archivo roto
  // se corrija con un contador inventado.
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  const d = repo(L, 'Solo', { pin: 'p' });
  fs.writeFileSync(path.join(d, '.engram', 'chunks', 'c.jsonl.gz'), Buffer.from('esto no es gzip'));
  fs.writeFileSync(path.join(d, '.engram', 'manifest.json'), JSON.stringify({
    chunks: [{ id: 'c', created_by: 'x', created_at: '2026-08-22T00:00:00Z', sessions: 0, memories: 1, prompts: 0 }],
  }));
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', []);
  const r = correr(L, api, ['--reindex', '--apply']); api.close();
  const man = JSON.parse(fs.readFileSync(path.join(d, '.engram', 'manifest.json'), 'utf8'));
  assert.equal(man.chunks[0].memories, 1, 'un chunk ilegible NO se "corrige": no hay con qué');
  assert.match(`${r.stdout}${r.stderr}`, /no parsea|ilegible|ILEGIBLE/i, 'y se avisa');
});

test('reindex: un manifest con schema ajeno es ROJO y no se toca', SKIP, () => {
  const L = lab();
  db(L, [{ id: 'o1', project: 'p', sync_id: 's1' }]);
  const d = repo(L, 'Solo', { pin: 'p', chunks: [{ id: 'c', sync_ids: ['s1'] }] });
  fs.writeFileSync(path.join(d, '.engram', 'manifest.json'), JSON.stringify({ chunks: 'no-soy-una-lista' }));
  const api = fakeApi(L, 'ok'); fakeEngram(L, 'exports', []);
  const r = correr(L, api, ['--reindex']); api.close();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /schema no es el que engram escribe/);
});

// ── el tope es de la CORRIDA, no por observación ──────────────────────────────────

test('el presupuesto global corta limpio: lo no tocado queda anotado y la corrida sale con error', SKIP, () => {
  // Con timeout POR OBSERVACIÓN, mil varadas serían horas de peor caso. Acá: 2 repos, la API tarda
  // 1,5 s por PATCH y el presupuesto es 1 s — el primer repo entra (el corte se mira ENTRE repos, no
  // a mitad de uno), y al terminar ya se pasó del presupuesto: el segundo se corta ANTES de empezar
  // (nada a medias) y el cierre lo dice con el flag para subirlo.
  // 🔴 Con una demora de 700 ms y el mismo presupuesto de 1 s, el caso DEPENDERÍA DE LA MÁQUINA:
  // en una Mac el arranque (node + sqlite3 + git) suma lo que falta para pasar el segundo, pero
  // en un agente de Linux el primer repo terminaría en ~700 ms, el segundo entraría y la corrida saldría
  // en verde. Con la demora MAYOR que el presupuesto, el corte es seguro en cualquier máquina.
  const L = lab();
  db(L, [{ id: 'o1', project: 'p1', sync_id: 's1' }, { id: 'o2', project: 'p2', sync_id: 's2' }]);
  repo(L, 'Uno', { pin: 'p1' });
  repo(L, 'Dos', { pin: 'p2' });
  const api = fakeApi(L, 'ok', null, 1500); fakeEngram(L, 'exports', ['s1', 's2']);
  const r = correr(L, api, ['--apply', '--budget', '1']); api.close();
  assert.notEqual(r.status, 0, 'quedarse sin tiempo con trabajo pendiente no puede ser un verde');
  assert.match(r.stderr, /presupuesto de tiempo/);
  assert.match(r.stderr, /--budget/, 'el mensaje trae la salida: subir el presupuesto o volver a correr');
});

// ── el rescate importa harness-audit desde scripts/lib/ ──────────────────────────
// Arnés de laboratorio SIN los reemplazos de las rutas viejas (con ellos al lado, un `require` viejo seguiría andando):
// el rescate y scripts/lib/. Tiene que llegar a donde llega desde el árbol de verdad (sin base de engram: «nada que
// hacer»), no caerse buscando el módulo. No necesita sqlite3: corta antes de leer la base.
test('T28 R3_HarnessAuditAutoheal_HooksRequireLib — el rescate resuelve harness-audit desde scripts/lib/', () => {
  const L = lab();
  const tcg = path.join(L.raiz, 'tcg');
  fs.mkdirSync(path.join(tcg, 'scripts', 'setup'), { recursive: true });
  fs.copyFileSync(RESCUE, path.join(tcg, 'scripts', 'setup', 'engram-rescue-unexported.js'));
  fs.cpSync(path.join(TCG, 'scripts', 'lib'), path.join(tcg, 'scripts', 'lib'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: L.home, TYCON_REPOS_ROOT: L.repos, TYCON_ENGRAM: '1', TYCON_NO_NIGHTLY_EXAM: '1', LANG: 'en_US.UTF-8' };
  const enLab = spawnSync(process.execPath, [path.join(tcg, 'scripts', 'setup', 'engram-rescue-unexported.js')], { encoding: 'utf8', timeout: 60000, env });
  const enArbol = spawnSync(process.execPath, [RESCUE], { encoding: 'utf8', timeout: 60000, env });
  assert.doesNotMatch(enLab.stderr, /Cannot find module/, `el rescate no encontró harness-audit en scripts/lib/: ${enLab.stderr}`);
  assert.deepEqual([enLab.status, enLab.stdout, enLab.stderr], [enArbol.status, enArbol.stdout, enArbol.stderr]);
  assert.match(enLab.stderr, /nada que hacer/);
  fs.rmSync(L.raiz, { recursive: true, force: true });
});
