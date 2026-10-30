'use strict';

/**
 * legacy-names-d2.test.js — el estado de la máquina en inglés. T47.
 *
 * Lo que no se puede perder:
 *   · Cada archivo de estado de ~/.claude/.tycon-pipeline/ de la lista tiene su entrada `state-file` en el mapa,
 *     y la primera escritura con el nombre nuevo se lleva lo que había en el viejo: lo escrito antes del renombre sigue
 *     ahí, lo nuevo se suma, y el viejo queda intacto byte a byte hasta el retiro. Una segunda escritura no vuelve a
 *     copiar (lo que alguien escribió después en el viejo no pisa el nuevo).
 *   · La carpeta de las escrituras por consola se lleva entera, y dos procesos a la vez no la dejan a medias.
 *   · Lo que abre bash o launchd antes de que corra node (los cuatro registros del arranque, el del examen) se copia
 *     ANTES de abrirlo: después sería tarde, el nuevo ya existiría vacío.
 *   · Cada escritor corre de verdad, en una HOME de juguete: nunca la real, nunca launchctl.
 *
 * Los nombres viejos salen del mapa en tiempo de ejecución (escritos acá, mantendrían vivos los nombres en castellano
 * que cuenta el termómetro). En la copia pública, sin el mapa del equipo, se saltea con motivo.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const MAP = path.join(RAIZ, 'scripts', 'lib', 'renames.json');
const LIB = path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js');
const TEAM = fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) && fs.existsSync(MAP);
const SKIP_PUBLIC = !TEAM && 'copia pública: sin el mapa';

// Los archivos de estado: catorce, más el sello de vencimiento.
const EXPECTED_STATES = 15;
const STATE_DIR = '~/.claude/.tycon-pipeline/';

const entries = () => (TEAM ? JSON.parse(fs.readFileSync(MAP, 'utf8')).entries : []);
const d2 = () => entries().filter((e) => e.batch === 'D2');
/** La entrada D2 por su nombre nuevo (sin la carpeta de estado). */
function byNew(name) {
  const e = d2().find((x) => x.new === `${STATE_DIR}${name}`);
  assert.ok(e, `el mapa no tiene la entrada D2 de ${name}`);
  return e;
}
const base = (p) => p.slice(STATE_DIR.length);

function cleanEnv(extra) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'TF_BUILD') e[k] = v;
  return { ...e, ...extra };
}
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `d2-${p}-`));

/** Una HOME de juguete con la carpeta de estado; `seed` escribe los viejos que pida el caso. */
function toyHome(p) {
  const home = tmp(p);
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline'), { recursive: true });
  return home;
}
const stateOf = (home, name) => path.join(home, '.claude', '.tycon-pipeline', name);

/** Un proceso de node con la biblioteca, en la HOME de juguete. */
function libEval(home, code) {
  const r = spawnSync(process.execPath, ['-e', `const lib = require(${JSON.stringify(LIB)});\n${code}`], {
    env: cleanEnv({ HOME: home }), encoding: 'utf8', timeout: 30000,
  });
  return r;
}

/** Todos los archivos de una carpeta, relativos, con su contenido. */
function tree(dir) {
  const out = {};
  const walk = (d, pre) => {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = pre ? `${pre}/${x.name}` : x.name;
      if (x.isDirectory()) walk(path.join(d, x.name), rel); else out[rel] = fs.readFileSync(path.join(d, x.name), 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

// ── el mapa ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('T47a · BatchD_StateFilesMigrateOnWrite — los estados de la lista tienen su entrada state-file, con ~/ y en inglés', { skip: SKIP_PUBLIC }, () => {
  const st = d2();
  assert.strictEqual(st.length, EXPECTED_STATES, `entradas D2: ${st.map((e) => e.old).join(', ')}`);
  const words = require(path.join(RAIZ, 'scripts', 'lib', 'spanish-words.json'));
  const spanish = new Set([...Object.keys(words.glossary), ...words.words].map((w) => String(w).toLowerCase()));
  const inSpanish = (p) => base(p).split(/[-./]/).filter((x) => spanish.has(x.toLowerCase()));
  for (const e of st) {
    assert.strictEqual(e.kind, 'state-file', `${e.old}: kind`);
    assert.ok(e.old.startsWith(STATE_DIR) && e.new.startsWith(STATE_DIR), `${e.old}: vive en la carpeta de estado`);
    assert.ok(inSpanish(e.old).length, `${e.old}: el viejo tiene que tener alguna palabra de la lista (si no, el control de abajo no mide nada)`);
    assert.deepStrictEqual(inSpanish(e.new), [], `${e.new}: palabras en castellano`);
  }
});

// ── la biblioteca ────────────────────────────────────────────────────────────────────────────────────────────────

test('T47b · BatchD_StateFilesMigrateOnWrite — un archivo: la primera escritura copia el viejo, el viejo queda, la segunda no vuelve a copiar', { skip: SKIP_PUBLIC }, () => {
  const e = byNew('sql-compile.jsonl');
  const home = toyHome('file');
  const oldP = stateOf(home, base(e.old));
  const newP = stateOf(home, base(e.new));
  fs.writeFileSync(oldP, '{"antes":1}\n');
  const r = libEval(home, `process.stdout.write(lib.prepareStateWrite(${JSON.stringify(e.new)}))`);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, newP, 'devuelve la ruta nueva');
  assert.strictEqual(fs.readFileSync(newP, 'utf8'), '{"antes":1}\n', 'el nuevo trae lo del viejo');
  fs.appendFileSync(oldP, '{"tarde":1}\n');   // alguien con el código de antes escribió en el viejo
  const r2 = libEval(home, `lib.prepareStateWrite(${JSON.stringify(e.new)})`);
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(fs.readFileSync(newP, 'utf8'), '{"antes":1}\n', 'la segunda escritura no vuelve a copiar');
  assert.strictEqual(fs.readFileSync(oldP, 'utf8'), '{"antes":1}\n{"tarde":1}\n', 'el viejo queda intacto');
  const r3 = libEval(home, `process.stdout.write(lib.resolveFile(${JSON.stringify(e.new)}))`);
  assert.strictEqual(r3.stdout, newP, 'con los dos, se lee el nuevo');
});

test('T47c · BatchD_StateFilesMigrateOnWrite — una carpeta se lleva entera, y cuatro procesos a la vez no la dejan a medias', { skip: SKIP_PUBLIC }, async () => {
  const e = byNew('console-writes');
  const home = toyHome('dir');
  const oldD = stateOf(home, base(e.old));
  const newD = stateOf(home, base(e.new));
  fs.mkdirSync(path.join(oldD, 'sub'), { recursive: true });
  const want = {};
  for (let i = 0; i < 40; i++) { const f = `s${i}.jsonl`; want[f] = `{"path":"/x/${i}","ts":"2026-10-01T00:00:00Z"}\n`; fs.writeFileSync(path.join(oldD, f), want[f]); }
  fs.writeFileSync(path.join(oldD, 'sub', 'z.jsonl'), 'z\n'); want['sub/z.jsonl'] = 'z\n';
  // sólo el viejo: resolveFile lee el viejo
  const r0 = libEval(home, `process.stdout.write(lib.resolveFile(${JSON.stringify(e.new)}))`);
  assert.strictEqual(r0.stdout, oldD, 'sin el nuevo, se lee el viejo');
  const code = `try { process.stdout.write(lib.prepareStateWrite(${JSON.stringify(e.new)})); } catch (err) { process.stderr.write(String(err && err.message)); process.exit(2); }`;
  const runs = await Promise.all([0, 1, 2, 3].map(() => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', `const lib = require(${JSON.stringify(LIB)});\n${code}`], { env: cleanEnv({ HOME: home }) });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (status) => resolve({ status, out, err }));
  })));
  for (const r of runs) { assert.strictEqual(r.status, 0, r.err); assert.strictEqual(r.out, newD); }
  assert.deepStrictEqual(tree(newD), want, 'el nuevo tiene la carpeta entera');
  assert.deepStrictEqual(tree(oldD), want, 'el viejo queda intacto');
  // (al lado viven también el registro de usos de nombres viejos: lo que no puede quedar es una copia a medias)
  const sobras = fs.readdirSync(path.dirname(newD)).filter((x) => x.startsWith(`${base(e.new)}.`));
  assert.deepStrictEqual(sobras, [], 'no quedan carpetas temporales');
  assert.ok(fs.readFileSync(stateOf(home, 'legacy-names.jsonl'), 'utf8').includes(base(e.old)), 'la migración anota el uso del nombre viejo');
  fs.writeFileSync(path.join(oldD, 'tarde.jsonl'), 'tarde\n');
  const r2 = libEval(home, `lib.prepareStateWrite(${JSON.stringify(e.new)})`);
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.ok(!fs.existsSync(path.join(newD, 'tarde.jsonl')), 'la segunda escritura no vuelve a copiar');
});

test('T47d · BatchD_StateFilesMigrateOnWrite — --prepare-state: lo que abre bash se copia antes, con una sola llamada', { skip: SKIP_PUBLIC }, () => {
  const logs = ['download-runs.log', 'upload-runs.log', 'collect-findings.log', 'thread-rescue.log'].map(byNew);
  const home = toyHome('cli');
  for (const e of logs) fs.writeFileSync(stateOf(home, base(e.old)), `antes ${base(e.new)}\n`);
  const fuera = path.join(home, 'no-es-del-mapa.log');
  const r = spawnSync(process.execPath, [LIB, '--prepare-state', ...logs.map((e) => stateOf(home, base(e.new))), fuera], {
    env: cleanEnv({ HOME: home }), encoding: 'utf8', timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  for (const e of logs) {
    assert.strictEqual(fs.readFileSync(stateOf(home, base(e.new)), 'utf8'), `antes ${base(e.new)}\n`, `${base(e.new)}: trae lo del viejo`);
    assert.strictEqual(fs.readFileSync(stateOf(home, base(e.old)), 'utf8'), `antes ${base(e.new)}\n`, `${base(e.old)}: intacto`);
  }
  assert.ok(!fs.existsSync(fuera), 'una ruta que no está en el mapa no se crea');
  const vacio = spawnSync(process.execPath, [LIB, '--prepare-state'], { env: cleanEnv({ HOME: home }), encoding: 'utf8' });
  assert.strictEqual(vacio.status, 2, 'sin rutas es un error de uso');
});

// ── cada escritor, de verdad ─────────────────────────────────────────────────────────────────────────────────────
// Cada caso corre el script real en una HOME de juguete (HOME=<juguete> en el entorno del hijo, sin variables TYCON_ de
// esta máquina) con los estados VIEJOS sembrados con un contenido reconocible, y mira tres cosas: el nuevo trae lo del
// viejo y lo de la corrida (o, si el escritor reescribe entero por diseño, existe con lo de la corrida); el viejo queda
// intacto byte a byte; y nada sale de la juguete: sin red (los buzones son servidores locales), sin `az`, sin `sqlcmd`,
// sin launchctl (dobles), sin modelo. Fallan todos si el escritor escribe con el nombre viejo, o escribe
// el nuevo sin llevarse el viejo.

const SCRATCH = [];
test.after(() => { for (const d of SCRATCH) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* */ } } });
const scratch = (p) => { const d = tmp(p); SCRATCH.push(d); return d; };
const toyHomeW = (p) => { const h = toyHome(p); SCRATCH.push(h); return h; };
const TODAY = () => new Date().toISOString().slice(0, 10);
const readOr = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };
const jsonlOf = (p) => (readOr(p) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/**
 * agent-skills, por la regla común (scripts/lib/skills-dir.js; el mismo criterio que legacy-names-d1.test.js):
 * TYCON_SKILLS_DIR › el propio clon si es unido › la copia de la máquina. `null` si ahí no hay skills. Sin `catch`: si
 * la biblioteca no puede contestar, la suite es roja con la causa.
 */
function skillsRoot() {
  const root = require(path.join(RAIZ, 'scripts', 'lib', 'skills-dir.js')).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || '').repo;
  return fs.existsSync(path.join(root, 'skills', 'tycon-pipeline')) ? root : null;
}
/** ¿Ese agent-skills ya trae el puente con prepareStateWrite? Uno anterior es el orden de los merges, no un
 *  defecto: el caso se saltea con motivo. */
function skillsHasD2() {
  const s = skillsRoot();
  if (!s) return false;
  try { return typeof require(path.join(s, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'legacy-names.js')).prepareStateWrite === 'function'; } catch (_) { return false; }
}

/** Un proceso hijo sin bloquear el bucle (los buzones de mentira viven en ESTE proceso). Corta a los 20 s. */
function run(cmd, args, { env, cwd, input, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (_) { /* */ } }, timeoutMs);
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('error', (e) => { clearTimeout(t); resolve({ status: null, stdout: out, stderr: `${err}${e.message}` }); });
    c.on('close', (status, signal) => { clearTimeout(t); resolve({ status, signal, stdout: out, stderr: err }); });
    c.stdin.end(input || '');
  });
}
const json = (r) => { try { return JSON.parse(r.stdout); } catch (_) { return {}; } };

/** Un ejecutable de mentira (sh) en `dir`. */
function fakeBin(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

/** Entorno para git en la juguete: sin la config global ni la de sistema, y sin GIT_* heredados (un gancho los pone). */
function gitEnv(home, extra) {
  const e = cleanEnv({});
  for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k];
  const cfg = path.join(home, '.gitconfig-juguete');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, '[user]\n\tname = Prueba\n\temail = prueba@ejemplo.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\thooksPath = /dev/null\n');
  return { ...e, HOME: home, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', ...extra };
}
function git(cwd, env, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/**
 * El buzón de mentira: imita Blob Storage lo justo para la subida (PUT → 201) y la bajada (listado XML y GET con
 * `Authorization: Bearer token-bueno`). Vive en este proceso, en 127.0.0.1: ningún pedido sale de la máquina.
 */
function mailboxServer(blobs = {}) {
  const http = require('http');
  const crypto = require('crypto');
  const md5 = (b) => crypto.createHash('md5').update(b).digest('base64');
  const puts = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const trozos = [];
    req.on('data', (c) => trozos.push(c));
    req.on('end', () => {
      if (req.method === 'PUT') { puts.push(decodeURIComponent(u.pathname)); res.writeHead(201); return res.end(); }
      if (req.headers.authorization !== 'Bearer token-bueno') { res.writeHead(403); return res.end('<Error><Code>AuthorizationPermissionMismatch</Code></Error>'); }
      if (u.searchParams.get('comp') === 'list') {
        const items = Object.entries(blobs).map(([n, c]) => `<Blob><Name>${n}</Name><Properties><Content-Length>${Buffer.byteLength(c)}</Content-Length><Content-MD5>${md5(Buffer.from(c))}</Content-MD5><Etag>0x1</Etag></Properties></Blob>`).join('');
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs>${items}</Blobs><NextMarker></NextMarker></EnumerationResults>`);
      }
      const nombre = decodeURIComponent(u.pathname).split('/').filter(Boolean).slice(1).join('/');
      if (!(nombre in blobs)) { res.writeHead(404); return res.end(); }
      const b = Buffer.from(blobs[nombre]);
      res.writeHead(200, { 'content-length': b.length, 'content-md5': md5(b) });
      return res.end(b);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`, puts, close: () => new Promise((r) => srv.close(() => r())),
  })));
}
const MAILBOX_CFG = (extra = {}) => JSON.stringify({ cuenta: 'cuentadeprueba', contenedor: 'corridas', tenant: '11111111-2222-3333-4444-555555555555', politica: 'p', vence: '2099-01-01', sas: 'sv=2022-11-02&si=subida-prueba&sr=c&spr=https&sig=juguete', ...extra });   // corta: el detector de la copia pública toma una firma larga por un secreto

test('T47e · BatchD_StateFilesMigrateOnWrite — download-runs.js: el índice de bajadas se lleva el viejo, y el sello sin permiso respeta el de hoy', { skip: SKIP_PUBLIC }, async () => {
  const idx = byNew('mailbox-downloads.json');
  const seal = byNew('download-runs-no-permission.seal');
  const script = path.join(RAIZ, 'scripts', 'metrics', 'download-runs.js');
  const nueva = 'equipo-deva/2.1-2026-09-01T1000.json';
  // lo que el buzón ya no lista sale del índice: la entrada del índice viejo está en el buzón y ya bajada, así que la
  // bajada la deja como la anotó el viejo (su etag es la prueba de que el nuevo se la llevó)
  const anterior = 'viejo/1.1-2026-01-01T1000.json';
  const contenido = 'abc';
  const srv = await mailboxServer({ [nueva]: '{"corrida":"nueva"}\n', [anterior]: contenido });
  try {
    const env = (home, az) => cleanEnv({ HOME: home, TYCON_MAILBOX: '1', TYCON_ADO_ORG: 'https://dev.azure.com/prueba',
      TYCON_MAILBOX_JSON: path.join(home, 'cfg.json'), TYCON_MAILBOX_URL_BASE: srv.url, TYCON_AZ_BIN: az });
    // 1 · con permiso: el índice
    const home = toyHomeW('dl');
    fs.writeFileSync(path.join(home, 'cfg.json'), MAILBOX_CFG());
    const az = fakeBin(path.join(home, 'bin'), 'az', 'echo token-bueno');
    const md5 = require('crypto').createHash('md5').update(contenido).digest('base64');
    const enDisco = path.join(stateOf(home, 'corridas-buzon'), anterior);
    fs.mkdirSync(path.dirname(enDisco), { recursive: true });
    fs.writeFileSync(enDisco, contenido);
    const viejo = `${JSON.stringify({ version: 1, destino: 'cuentadeprueba/corridas', blobs: { [anterior]: { etag: '0xviejo', size: 3, md5, mtimeMs: fs.statSync(enDisco).mtimeMs } } }, null, 1)}\n`;
    fs.writeFileSync(stateOf(home, base(idx.old)), viejo);
    const r = await run(process.execPath, [script, '--json'], { env: env(home, az) });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(stateOf(home, 'corridas-buzon'), nueva)), `bajó a la carpeta de la juguete: ${r.stderr}`);
    const nuevo = JSON.parse(readOr(stateOf(home, base(idx.new))) || '{}');
    assert.deepStrictEqual(Object.keys(nuevo.blobs || {}).sort(), [nueva, anterior],
      `${base(idx.new)}: trae lo del viejo y lo de esta ejecución`);
    assert.strictEqual((nuevo.blobs[anterior] || {}).etag, '0xviejo', `${base(idx.new)}: la entrada vieja es la que anotó el viejo, no una bajada nueva`);
    assert.strictEqual(readOr(stateOf(home, base(idx.old))), viejo, `${base(idx.old)}: intacto`);
    // 2 · sin permiso, con un sello viejo de otro día: el nuevo nace con lo de hoy (se reescribe entero por diseño)
    const home2 = toyHomeW('dl-sello');
    fs.writeFileSync(path.join(home2, 'cfg.json'), MAILBOX_CFG());
    const sinSesion = fakeBin(path.join(home2, 'bin'), 'az', 'echo "ERROR: Please run az login" >&2\nexit 1');
    const selloViejo = '2026-01-01 sin_sesion: el sello viejo\n';
    fs.writeFileSync(stateOf(home2, base(seal.old)), selloViejo);
    const r2 = await run(process.execPath, [script, '--json'], { env: env(home2, sinSesion) });
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.strictEqual(json(r2).aviso, 'emitido', 'un sello de otro día no calla el aviso');
    assert.ok((readOr(stateOf(home2, base(seal.new))) || '').startsWith(`${TODAY()} `), `${base(seal.new)}: existe con lo de hoy`);
    assert.strictEqual(readOr(stateOf(home2, base(seal.old))), selloViejo, `${base(seal.old)}: intacto`);
    // 3 · sin permiso, con el sello viejo de HOY: el aviso ya salió hoy, no se repite por el renombre
    const home3 = toyHomeW('dl-hoy');
    fs.writeFileSync(path.join(home3, 'cfg.json'), MAILBOX_CFG());
    const sinSesion3 = fakeBin(path.join(home3, 'bin'), 'az', 'echo "ERROR: Please run az login" >&2\nexit 1');
    const selloHoy = `${TODAY()} sin_sesion: ya avisado hoy\n`;
    fs.writeFileSync(stateOf(home3, base(seal.old)), selloHoy);
    const r3 = await run(process.execPath, [script, '--json'], { env: env(home3, sinSesion3) });
    assert.strictEqual(r3.status, 0, r3.stderr);
    assert.strictEqual(json(r3).aviso, 'ya_emitido_hoy', 'el sello de hoy con el nombre viejo sigue valiendo');
    assert.strictEqual(readOr(stateOf(home3, base(seal.old))), selloHoy, `${base(seal.old)}: intacto`);
  } finally { await srv.close(); }
});

test('T47f · BatchD_StateFilesMigrateOnWrite — upload-runs.js: el registro de subidas se lleva el viejo, y el sello de vencimiento respeta el de hoy', { skip: SKIP_PUBLIC }, async () => {
  const reg = byNew('mailbox-uploads.json');
  const seal = byNew('upload-runs-expiry.seal');
  const script = path.join(RAIZ, 'scripts', 'metrics', 'upload-runs.js');
  const vence = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);   // vence en 5 días: sale el aviso
  const srv = await mailboxServer();
  try {
    const env = (home) => cleanEnv({ HOME: home, TYCON_MAILBOX: '1', TYCON_MAILBOX_JSON: path.join(home, 'cfg.json'),
      TYCON_MAILBOX_URL_BASE: srv.url, TYCON_MACHINE: 'maq-juguete' });
    const sembrar = (home, selloViejo) => {
      fs.writeFileSync(path.join(home, 'cfg.json'), MAILBOX_CFG({ vence }));
      const hist = stateOf(home, 'timing-history');
      fs.mkdirSync(hist, { recursive: true });
      fs.writeFileSync(path.join(hist, '9.9-2026-09-14T1000.json'), '{"marker":{"storyId":"9.9"}}\n');
      fs.writeFileSync(stateOf(home, base(seal.old)), selloViejo);
    };
    // 1 · el registro, y un sello de otro día
    const home = toyHomeW('up');
    const viejo = `${JSON.stringify({ version: 1, destino: 'cuentadeprueba/corridas', archivos: { 'maq-juguete/viejo.json': { size: 1, mtimeMs: 1, sha256: 'x', subido: '2026-01-01T00:00:00.000Z' } } }, null, 1)}\n`;
    fs.writeFileSync(stateOf(home, base(reg.old)), viejo);
    const selloViejo = '2026-01-01 la llave del buzón vence (sello viejo)\n';
    sembrar(home, selloViejo);
    const r = await run(process.execPath, [script, '--json'], { env: env(home) });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(srv.puts.some((p) => p.endsWith('/maq-juguete/9.9-2026-09-14T1000.json')), `subió la ejecución: ${r.stderr}`);
    const nuevo = JSON.parse(readOr(stateOf(home, base(reg.new))) || '{}');
    const claves = Object.keys(nuevo.archivos || {});
    assert.ok(claves.includes('maq-juguete/viejo.json') && claves.includes('maq-juguete/9.9-2026-09-14T1000.json'),
      `${base(reg.new)}: trae lo del viejo y lo de esta ejecución (tiene: ${claves.join(', ')})`);
    assert.strictEqual(readOr(stateOf(home, base(reg.old))), viejo, `${base(reg.old)}: intacto`);
    assert.strictEqual(json(r).aviso_vence, 'emitido', 'un sello de otro día no calla el aviso');
    assert.ok((readOr(stateOf(home, base(seal.new))) || '').startsWith(`${TODAY()} `), `${base(seal.new)}: existe con lo de hoy`);
    assert.strictEqual(readOr(stateOf(home, base(seal.old))), selloViejo, `${base(seal.old)}: intacto`);
    // 2 · con el sello viejo de HOY, el aviso no se repite por el renombre
    const home2 = toyHomeW('up-hoy');
    const selloHoy = `${TODAY()} la llave del buzón vence (ya avisado hoy)\n`;
    sembrar(home2, selloHoy);
    const r2 = await run(process.execPath, [script, '--json'], { env: env(home2) });
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.strictEqual(json(r2).aviso_vence, 'ya_emitido_hoy', 'el sello de hoy con el nombre viejo sigue valiendo');
    assert.strictEqual(readOr(stateOf(home2, base(seal.old))), selloHoy, `${base(seal.old)}: intacto`);
  } finally { await srv.close(); }
});

test('T47g · BatchD_StateFilesMigrateOnWrite — collect-findings.js: el sello de la serie, y estadoDeLaSerie con sólo el viejo', { skip: SKIP_PUBLIC }, async () => {
  const seal = byNew('findings-seal.json');
  const script = path.join(RAIZ, 'scripts', 'metrics', 'collect-findings.js');
  const HOY = '2026-09-16';
  const selloDe = (fecha) => `${JSON.stringify({ estado: 'recolectado', fecha, repos: 1, hallazgos: 0, volcados: { medidos: 0 }, marca: 'sello-viejo' }, null, 2)}\n`;
  // 1 · sólo el sello viejo, de hoy: la subida y el tablero lo encuentran, y el recolector no recorre de nuevo
  const home = toyHomeW('cf');
  fs.writeFileSync(stateOf(home, 'hallazgos.jsonl'), '');
  const viejoHoy = selloDe(HOY);
  fs.writeFileSync(stateOf(home, base(seal.old)), viejoHoy);
  const e = spawnSync(process.execPath, ['-e', `const r = require(${JSON.stringify(script)}).estadoDeLaSerie({ hoy: ${JSON.stringify(HOY)} }); process.stdout.write(JSON.stringify({ estado: r.estado, motivo: r.motivo, marca: r.sello && r.sello.marca }));`],
    { env: cleanEnv({ HOME: home }), encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(e.status, 0, e.stderr);
  assert.deepStrictEqual(JSON.parse(e.stdout), { estado: 'medido', marca: 'sello-viejo' }, 'estadoDeLaSerie encuentra el sello con el nombre viejo');
  const y = await run(process.execPath, [script, '--today', HOY, '--json'], { env: cleanEnv({ HOME: home, TZ: 'America/Argentina/Buenos_Aires' }) });
  assert.strictEqual(y.status, 0, y.stderr);
  assert.strictEqual(json(y).estado, 'ya_recolectado_hoy', 'el sello de hoy con el nombre viejo sigue valiendo');
  assert.strictEqual(readOr(stateOf(home, base(seal.old))), viejoHoy, `${base(seal.old)}: intacto`);
  // 2 · un sello viejo de otro día: el recolector recorre y deja el nuevo con lo de hoy (se reescribe entero por diseño)
  const home2 = toyHomeW('cf-rec');
  fs.writeFileSync(stateOf(home2, 'hallazgos.jsonl'), '');
  const viejoAntes = selloDe('2026-09-10');
  fs.writeFileSync(stateOf(home2, base(seal.old)), viejoAntes);
  const w = scratch('cf-raiz');
  fs.writeFileSync(path.join(w, 'catalogo.md'), '# Catálogo\n\n## Silent Failure Hunter — `tycon-silent-failure-hunter`\n\n| Regla | Qué detecta | Fix |\n|---|---|---|\n| **SILENT-C2** | catch vacío | loguear |\n');
  fs.mkdirSync(path.join(w, 'revisores'));
  fs.writeFileSync(path.join(w, 'revisores', 'tycon-silent-failure-hunter.toml'), 'name = "tycon-silent-failure-hunter"\n');
  const corrida = path.join(w, 'raiz', 'repoA', '.advisors', 'pipeline-runs', '2.9-20260910T101010');
  fs.mkdirSync(path.join(w, 'raiz', 'repoA', '.git'), { recursive: true });
  fs.mkdirSync(corrida, { recursive: true });
  fs.writeFileSync(path.join(corrida, 'findings.json'), '[{"rule_id":"SILENT-C2","severity":"CRITICAL","advisor":"tycon-silent-failure-hunter","file":"x","disposition":"fixed","reason":"y"}]');
  const r = await run(process.execPath, [script, '--root', path.join(w, 'raiz'), '--catalog', path.join(w, 'catalogo.md'), '--reviewers', path.join(w, 'revisores'), '--today', HOY, '--json'],
    { env: cleanEnv({ HOME: home2, TZ: 'America/Argentina/Buenos_Aires' }) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(json(r).estado, 'recolectado', r.stdout);
  assert.strictEqual(jsonlOf(stateOf(home2, 'hallazgos.jsonl')).length, 1, 'la serie conserva su nombre y trae el hallazgo');
  const nuevo = JSON.parse(readOr(stateOf(home2, base(seal.new))) || '{}');
  assert.strictEqual(nuevo.fecha, HOY, `${base(seal.new)}: existe con lo de esta ejecución`);
  assert.strictEqual(nuevo.marca, undefined, `${base(seal.new)}: es el resumen de esta ejecución, no una copia del viejo`);
  assert.strictEqual(readOr(stateOf(home2, base(seal.old))), viejoAntes, `${base(seal.old)}: intacto`);
});

test('T47h · BatchD_StateFilesMigrateOnWrite — reviewer-rules.js: la medición se agrega a la que traía el viejo', { skip: SKIP_PUBLIC }, async () => {
  const e = byNew('reviewer-rules.jsonl');
  const home = toyHomeW('rr');
  const env = gitEnv(home, { TYPESAFE_API_KEY: '' });   // sin llave: ni un pedido a TypeSafe
  const repo = path.join(home, 'repo-reglas');
  fs.mkdirSync(repo);
  git(repo, env, 'init', '-q', '.');
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Proyecto\n\n## Reglas para revisores\n\n- Nunca SQL concatenado.\n\n## Otra sección\n\nTexto.\n');
  git(repo, env, 'add', 'CLAUDE.md');
  git(repo, env, 'commit', '-qm', 'init');
  fs.appendFileSync(path.join(repo, 'CLAUDE.md'), '- Toda migración nace con su rollback.\n');
  git(repo, env, 'add', 'CLAUDE.md');
  const linea = '{"ts":"2026-01-01T00:00:00.000Z","repo":"de-antes","archivo":"CLAUDE.md","marca":"linea-vieja"}\n';
  fs.writeFileSync(stateOf(home, base(e.old)), linea);
  const r = await run(process.execPath, [path.join(RAIZ, 'scripts', 'ci', 'reviewer-rules.js'), '--repo', repo], { env, cwd: repo });
  assert.strictEqual(r.status, 0, r.stderr);
  const filas = jsonlOf(stateOf(home, base(e.new)));
  assert.strictEqual(filas.length, 2, `${base(e.new)}: la línea vieja y la de esta ejecución (${filas.length})`);
  assert.strictEqual(filas[0].marca, 'linea-vieja');
  assert.strictEqual(filas[1].repo, 'repo-reglas');
  assert.strictEqual(readOr(stateOf(home, base(e.old))), linea, `${base(e.old)}: intacto`);
});

test('T47i · BatchD_StateFilesMigrateOnWrite — sql-compile.js: la medición se agrega a la que traía el viejo (sqlcmd de mentira)', { skip: SKIP_PUBLIC }, async () => {
  const e = byNew('sql-compile.jsonl');
  const home = toyHomeW('sql');
  const sqlcmd = fakeBin(path.join(home, 'bin'), 'sqlcmd', 'exit 0');
  const env = gitEnv(home, { TYCON_SQL_CMD: sqlcmd, TYCON_SQL_COMPILE_SERVER: 'prueba.local', TYCON_SQL_COMPILE_DATABASE: 'Pruebas',
    TYCON_SQL_COMPILE_USER: 'lector', SQLCMDPASSWORD: 'juguete' });
  const repo = path.join(home, 'repo-sql');
  fs.mkdirSync(path.join(repo, 'database'), { recursive: true });
  git(repo, env, 'init', '-q', '.');
  git(repo, env, 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'database', '055_ok.sql'), 'PRINT 1;\n');
  git(repo, env, 'add', 'database/055_ok.sql');
  const linea = '{"ts":"2026-01-01T00:00:00.000Z","repo":"de-antes","archivo":"database/001.sql","resultado":"compila","marca":"linea-vieja"}\n';
  fs.writeFileSync(stateOf(home, base(e.old)), linea);
  const r = await run(process.execPath, [path.join(RAIZ, 'scripts', 'ci', 'sql-compile.js'), '--staged', '--repo', repo], { env, cwd: repo });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /055_ok\.sql compila/, 'el doble de sqlcmd contestó «compila»');
  const filas = jsonlOf(stateOf(home, base(e.new)));
  assert.strictEqual(filas.length, 2, `${base(e.new)}: la línea vieja y la de esta ejecución (${filas.length})`);
  assert.strictEqual(filas[0].marca, 'linea-vieja');
  assert.deepStrictEqual([filas[1].archivo, filas[1].resultado], ['database/055_ok.sql', 'compila']);
  assert.strictEqual(readOr(stateOf(home, base(e.old))), linea, `${base(e.old)}: intacto`);
});

/** El banco del examen: repo git con remoto, config con máquina designada, un examen falso y la sonda que dice que sí. */
function examBench(p) {
  const raiz = scratch(p);
  const casa = path.join(raiz, 'casa');
  fs.mkdirSync(path.join(casa, '.claude', '.tycon-pipeline'), { recursive: true });
  const env = gitEnv(casa);
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts', 'controls-bench', '.bench'), { recursive: true });
  git(raiz, env, 'init', '-q', '-b', 'main', repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'scripts/controls-bench/.bench/\n');
  git(repo, env, 'add', '-A');
  git(repo, env, 'commit', '-qm', 'base');
  git(raiz, env, 'init', '-q', '--bare', path.join(raiz, 'remoto.git'));
  git(repo, env, 'remote', 'add', 'origin', path.join(raiz, 'remoto.git'));
  git(repo, env, 'push', '-q', '-u', 'origin', 'main');
  const cfg = path.join(raiz, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ designated_machine: 'Devas-Mac-mini', days_between_runs: 3, scheduled_days: ['martes', 'viernes'], hour: '02:00' }));
  const runner = path.join(raiz, 'runner-falso.js');
  fs.writeFileSync(runner, "const i = process.argv.indexOf('--json');\n"
    + "require('fs').writeFileSync(process.argv[i + 1], JSON.stringify({ ts: new Date().toISOString(), tool: 'claude', runs: 1, failed: 0, criterio: 0,"
    + " inestables: null, erroresDeCorrida: 0, skippedMcp: 0, parityBreaks: null, paridadReal: null, baselineRegressions: 0, alcance: 'completo', results: { 'a|claude': {} } }));\n");
  const sonda = fakeBin(path.join(raiz, 'bin'), 'sonda-ok.sh', 'exit 0');
  return { raiz, casa, repo, cfg, runner, sonda, env };
}

test('T47j · BatchD_StateFilesMigrateOnWrite — periodic-exam.js: el sello de la última ejecución, el registro de launchd y el aviso del arranque', { skip: SKIP_PUBLIC }, async () => {
  const seal = byNew('periodic-exam-last-run');
  const log = byNew('periodic-exam.log');
  const EXAM = path.join(RAIZ, 'scripts', 'controls-bench', 'periodic-exam.js');
  // 1 · con sólo el sello viejo, el diagnóstico lo lee; una corrida completa deja el nuevo (se reescribe por diseño)
  const b = examBench('ex');
  const selloViejo = '2026-09-29T02:12:34.000Z\n';
  fs.writeFileSync(path.join(b.casa, '.claude', '.tycon-pipeline', base(seal.old)), selloViejo);
  const env = { ...b.env, TYCON_EXAM_CONFIG: b.cfg, TYCON_EXAM_RUNNER: b.runner, TYCON_EXAM_REPO: b.repo, TYCON_EXAM_MACHINE: 'Devas-Mac-mini', TYCON_EXAM_PROBE: b.sonda };
  const d = await run(process.execPath, [EXAM, '--dry-run'], { env });
  assert.strictEqual(d.status, 0, d.stderr);
  assert.match(d.stdout, /última completa:\s+2026-09-29T02:12:34\.000Z/, `el diagnóstico lee el sello con el nombre viejo:\n${d.stdout}`);
  const antes = Date.now();
  const r = await run(process.execPath, [EXAM, '--force'], { env });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const nuevo = (readOr(path.join(b.casa, '.claude', '.tycon-pipeline', base(seal.new))) || '').trim();
  assert.ok(Date.parse(nuevo) >= antes - 1000, `${base(seal.new)}: existe con el fin de esta ejecución (tiene «${nuevo}»)`);
  assert.strictEqual(readOr(path.join(b.casa, '.claude', '.tycon-pipeline', base(seal.old))), selloViejo, `${base(seal.old)}: intacto`);

  // 2 · el disparador: el plist nombra el registro nuevo, y al instalarlo el viejo pasa al nuevo ANTES (launchd lo abre
  //     con su propio proceso: si el nuevo naciera vacío, lo de antes quedaría sólo en el viejo). Node falso con las
  //     herramientas de mentira al lado (como periodic-exam.test.js) y launchctl de mentira: nunca el de verdad.
  const b2 = examBench('ex-plist');
  const st = path.join(b2.casa, '.claude', '.tycon-pipeline');
  const registroViejo = 'examen: lo que launchd anotó antes del renombre\n';
  fs.writeFileSync(path.join(st, base(log.old)), registroViejo);
  const binFalso = path.join(b2.raiz, 'bin-falso');
  fs.mkdirSync(binFalso, { recursive: true });
  const nodeFalso = path.join(binFalso, 'node');
  try { fs.linkSync(process.execPath, nodeFalso); } catch (_) { fs.copyFileSync(process.execPath, nodeFalso); fs.chmodSync(nodeFalso, 0o755); }
  fakeBin(binFalso, 'claude', 'echo ok');
  fs.writeFileSync(path.join(binFalso, 'codex'), '#!/usr/bin/env node\nconsole.log("ok");\n');
  fs.chmodSync(path.join(binFalso, 'codex'), 0o755);
  const bitacora = path.join(b2.raiz, 'launchctl.log');
  const launchctl = fakeBin(path.join(b2.raiz, 'bin'), 'launchctl-falso', `echo "$@" >> "${bitacora}"`);
  const agentes = path.join(b2.raiz, 'LaunchAgents');
  const i = await run(nodeFalso, [EXAM, '--install-task'], { env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: b2.casa, TYCON_EXAM_CONFIG: b2.cfg, TYCON_EXAM_MACHINE: 'Devas-Mac-mini',
    TYCON_EXAM_LAUNCHAGENTS: agentes, TYCON_EXAM_REAL_HOME: b2.casa, LAUNCHCTL_BIN: launchctl,
  } });
  assert.strictEqual(i.status, 0, `${i.stdout}\n${i.stderr}`);
  const plist = readOr(path.join(agentes, 'ar.com.tycon.examen-periodico.plist')) || '';
  const nuevoLog = path.join(st, base(log.new));
  assert.strictEqual(plist.split(`<string>${nuevoLog}</string>`).length - 1, 2, `el plist manda la salida y los errores a ${base(log.new)}:\n${plist}`);
  assert.ok(!plist.includes(base(log.old)), `el plist ya no nombra ${base(log.old)}`);
  assert.ok((readOr(bitacora) || '').includes('bootstrap'), 'se instaló con el launchctl de mentira');
  assert.strictEqual(readOr(nuevoLog), registroViejo, `${base(log.new)}: trae lo del viejo, copiado antes de que launchd lo abra`);
  assert.strictEqual(readOr(path.join(st, base(log.old))), registroViejo, `${base(log.old)}: intacto`);

  // 3 · el aviso del arranque lee el sello por resolveFile: con sólo el viejo (de hoy, sin reporte de hoy) lo denuncia
  //     igual que si fuera el nuevo — si lo buscara sólo por el nombre nuevo, un sello a mano quedaría invisible.
  const b3 = examBench('ex-aviso');
  const bench = path.join(b3.repo, 'scripts', 'controls-bench', '.bench');
  const ayer = new Date(Date.now() - 86400000).toISOString();
  const reporte = path.join(b3.repo, 'scripts', 'controls-bench', 'ultimo-examen.json');
  fs.writeFileSync(reporte, JSON.stringify({ kind: 'examen-periodico', estado: 'completo', alcance: 'completo', ts: ayer, criterio: 0, inestables: 0, paridadReal: 0, baselineRegressions: 0, maquina: 'mini' }));
  const suites = path.join(b3.raiz, 'ultimo-suites.json');
  const banco = path.join(b3.raiz, 'ultimo-banco.json');
  fs.writeFileSync(suites, JSON.stringify({ kind: 'bash-tests', ts: new Date().toISOString(), origen: 'banco-falso', corridas: 1, failures: [] }));
  fs.writeFileSync(banco, JSON.stringify({ ts: new Date().toISOString(), ran: 1, failed: 0, skipped: 0, nomedido: 0, parityBreaks: 0, baselineRegressions: 0 }));
  const avisar = () => run(process.execPath, [path.join(RAIZ, 'scripts', 'hooks', 'bench-notice.js')], { input: '{"source":"startup"}', env: cleanEnv({
    HOME: b3.casa, TYCON_EXAM_CONFIG: b3.cfg, TYCON_BENCH_DIR: bench, TYCON_EXAM_REPORT: reporte, TYCON_SUITES_REPORT: suites, TYCON_BENCH_REPORT: banco, TYCON_EVAL_SANDBOX: '' }) });
  const sinSello = await avisar();
  assert.ok(!/examen de revisores: el sello de HOY/.test(sinSello.stdout), `control: sin sello no lo denuncia:\n${sinSello.stdout}`);
  fs.writeFileSync(path.join(b3.casa, '.claude', '.tycon-pipeline', base(seal.old)), `${new Date().toISOString()}\n`);
  const conViejo = await avisar();
  assert.strictEqual(conViejo.status, 0, conViejo.stderr);
  assert.match(conViejo.stdout, /examen de revisores: el sello de HOY/, `con sólo el sello viejo, el aviso lo ve:\n${conViejo.stdout}`);
});

test('T47k · BatchD_StateFilesMigrateOnWrite — la vista de ejecuciones escribe runs-dashboard.html en la HOME (se reescribe entera por diseño)', { skip: SKIP_PUBLIC }, async () => {
  const e = byNew('runs-dashboard.html');
  const home = toyHomeW('runs');
  const vieja = '<!-- la página de antes del renombre -->\n';
  fs.writeFileSync(stateOf(home, base(e.old)), vieja);
  const runs = scratch('runs-dir');
  const r = await run(process.execPath, [path.join(RAIZ, 'scripts', 'nightly', 'dashboard', 'dashboard.js'), '--view', 'runs', '--runs-dir', runs], { env: cleanEnv({ HOME: home }) });
  assert.strictEqual(r.status, 0, r.stderr);
  const nueva = readOr(stateOf(home, base(e.new))) || '';
  assert.ok(/<html/i.test(nueva) && !nueva.includes('la página de antes'), `${base(e.new)}: existe con la página de esta ejecución`);
  assert.strictEqual(readOr(stateOf(home, base(e.old))), vieja, `${base(e.old)}: intacto`);
});

test('T47l · BatchD_StateFilesMigrateOnWrite — la puerta de la consola (agent-skills): la primera anotación se lleva la carpeta vieja entera', { skip: SKIP_PUBLIC || (!skillsRoot() && 'sin agent-skills (TYCON_SKILLS_DIR)') || (!skillsHasD2() && 'el agent-skills de TYCON_SKILLS_DIR (o de la máquina) es anterior a la D2') }, () => {
  const e = byNew('console-writes');
  const gate = path.join(skillsRoot(), 'skills', 'tycon-pipeline', 'scripts', 'on-bash-write-gate.js');
  const home = toyHomeW('cw');
  const trabajo = path.join(home, 'trabajo');
  fs.mkdirSync(trabajo);
  const oldD = stateOf(home, base(e.old));
  const newD = stateOf(home, base(e.new));
  fs.mkdirSync(oldD);
  const otra = '{"path":"/otra/sesion.js","ts":"2026-10-01T00:00:00.000Z"}\n';
  fs.writeFileSync(path.join(oldD, 'otra-sesion.jsonl'), otra);
  const code = `require(${JSON.stringify(gate)}).handle({ tool_name: 'Bash', session_id: 's-t47l', cwd: ${JSON.stringify(trabajo)}, tool_input: { command: 'echo x > a.ts' } });`;
  const r = spawnSync(process.execPath, ['-e', code], { env: cleanEnv({ HOME: home, TYCON_GUIDES_DIR: RAIZ, TYCON_STORY_GATE: 'off', TYCON_STORY_SKILL_GATE: 'off' }), encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readOr(path.join(newD, 'otra-sesion.jsonl')), otra, `${base(e.new)}/: trae lo de la otra sesión`);
  assert.deepStrictEqual(jsonlOf(path.join(newD, 's-t47l.jsonl')).map((x) => x.path), [path.join(trabajo, 'a.ts')], `${base(e.new)}/: la anotación de esta ejecución`);
  assert.deepStrictEqual(tree(oldD), { 'otra-sesion.jsonl': otra }, `${base(e.old)}/: intacta`);
});

test('T47m · BatchD_StateFilesMigrateOnWrite — run-change.js lee la unión de las dos carpetas de la consola', { skip: SKIP_PUBLIC }, async () => {
  const e = byNew('console-writes');
  const home = toyHomeW('rc');
  const env = gitEnv(home);
  const mk = (n) => {
    const d = path.join(home, n);
    fs.mkdirSync(d);
    git(d, env, 'init', '-q', '.');
    fs.writeFileSync(path.join(d, 'a.js'), 'uno\n');
    git(d, env, 'add', '-A');
    spawnSync('git', ['commit', '-qm', 'inicial'], { cwd: d, env: { ...env, GIT_COMMITTER_DATE: '2026-01-01T10:00:00', GIT_AUTHOR_DATE: '2026-01-01T10:00:00' } });
    return d;
  };
  const principal = mk('repo-principal');
  const [antes, despues, tarde] = ['repo-copiado', 'repo-nueva', 'repo-vieja-tarde'].map(mk);
  const sid = 'sesion-t47m';
  const ts = new Date(Date.now() - 120000).toISOString();
  const linea = (repo) => `${JSON.stringify({ path: path.join(repo, 'a.js'), ts })}\n`;
  // La sesión anotó `antes` con el código viejo; la migración lo copió; después anotó `despues` en la nueva, y una
  // sesión con el código de antes siguió anotando `tarde` en la vieja. La corrida tiene que ver los tres repos.
  fs.mkdirSync(stateOf(home, base(e.old)));
  fs.mkdirSync(stateOf(home, base(e.new)));
  fs.writeFileSync(path.join(stateOf(home, base(e.old)), `${sid}.jsonl`), linea(antes) + linea(tarde));
  fs.writeFileSync(path.join(stateOf(home, base(e.new)), `${sid}.jsonl`), linea(antes) + linea(despues));
  const volcado = path.join(home, 'corrida.json');
  fs.writeFileSync(volcado, JSON.stringify({ archivedAt: new Date(Date.now() + 5000).toISOString(),
    marker: { storyId: '9.9', sessionId: sid, repoPath: principal, startedAt: new Date(Date.now() - 600000).toISOString(), filesTouched: [] } }));
  const r = await run(process.execPath, [path.join(RAIZ, 'scripts', 'metrics', 'run-change.js'), '--dump', volcado], { env });
  assert.strictEqual(r.status, 0, r.stderr);
  const c = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(home, 'corrida.cambio.json.gz'))).toString());
  const porConsola = (c.repos || []).filter((x) => (x.por || []).includes('consola')).map((x) => x.nombre).sort();
  assert.deepStrictEqual(porConsola, ['repo-copiado', 'repo-nueva', 'repo-vieja-tarde'], 'la sesión queda entera: lo de las dos carpetas, cada repo una vez');
});

test('T47n · BatchD_StateFilesMigrateOnWrite — el instalador copia los cuatro registros ANTES de abrirlos, en su tanda de fondo', { skip: SKIP_PUBLIC }, async () => {
  const logs = ['download-runs.log', 'upload-runs.log', 'collect-findings.log', 'thread-rescue.log'].map(byNew);
  // El bloque de fondo del instalador REAL, extraído como lo hace download-runs.test.sh (T9): correr el instalador
  // entero arrastra decenas de dependencias ajenas. SCRIPT_DIR es un temporal con dobles de los cuatro pasos, y la
  // biblioteca y el mapa reales enlazados en su lugar.
  const src = fs.readFileSync(path.join(RAIZ, 'scripts', 'install-tycon-hooks.sh'), 'utf8');
  let i = src.indexOf('# Rescate del hilo y el consumo de las ejecuciones del pipeline');
  assert.ok(i >= 0, 'no encontré el bloque de fondo en el instalador');
  i = src.lastIndexOf('# ====', i);
  let j = src.indexOf('# Hook de git PRE-COMMIT global', i);
  j = src.lastIndexOf('# ====', j);
  const w = scratch('inst');
  const home = path.join(w, 'home');
  const st = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(st, { recursive: true });
  const bloque = path.join(w, 'bloque.sh');
  fs.writeFileSync(bloque, src.slice(i, j));
  const sd = path.join(w, 'scripts');
  fs.mkdirSync(path.join(sd, 'metrics'), { recursive: true });
  fs.mkdirSync(path.join(sd, 'lib'), { recursive: true });
  for (const f of ['legacy-names.js', 'renames.json']) fs.symlinkSync(path.join(RAIZ, 'scripts', 'lib', f), path.join(sd, 'lib', f));
  const orden = path.join(w, 'orden.txt');
  for (const [f, paso] of [['tokens-digest.js', 'rescate'], ['collect-findings.js', 'recoleccion'], ['upload-runs.js', 'subida'], ['download-runs.js', 'bajada']]) {
    fs.writeFileSync(path.join(sd, 'metrics', f), `console.log('${paso} de esta ejecución'); require('fs').appendFileSync(process.env.ORDER_LOG, '${paso}\\n');\n`);
  }
  for (const e of logs) fs.writeFileSync(path.join(st, base(e.old)), `antes: ${base(e.new)}\n`);
  const r = spawnSync('bash', ['-c', 'source "$1"', '_', bloque], { encoding: 'utf8', timeout: 20000,
    // PROFILE_FULL: lo fija el instalador antes de este bloque (el rescate y la recolección son de full)
    env: cleanEnv({ HOME: home, SCRIPT_DIR: sd, CHECK_ONLY: '0', TYCON_INTEG_MAILBOX: '1', PROFILE_FULL: '1', ORDER_LOG: orden }) });
  assert.strictEqual(r.status, 0, r.stderr);
  for (let n = 0; n < 60 && (readOr(orden) || '').split('\n').filter(Boolean).length < 4; n++) await new Promise((ok) => setTimeout(ok, 250));
  assert.strictEqual(readOr(orden), 'rescate\nrecoleccion\nsubida\nbajada\n', 'la tanda de fondo corrió los cuatro pasos, en orden');
  await new Promise((ok) => setTimeout(ok, 300));   // el último paso termina de escribir su registro
  for (const [nuevo, paso] of [['download-runs.log', 'bajada'], ['upload-runs.log', 'subida'], ['collect-findings.log', 'recoleccion']]) {
    assert.strictEqual(readOr(path.join(st, nuevo)), `antes: ${nuevo}\n${paso} de esta ejecución\n`, `${nuevo}: lo del viejo y lo de esta ejecución`);
  }
  assert.strictEqual(readOr(path.join(st, 'thread-rescue.log')), 'rescate de esta ejecución\n', 'thread-rescue.log: se reescribe por diseño, con lo de esta ejecución');
  for (const e of logs) assert.strictEqual(readOr(path.join(st, base(e.old))), `antes: ${base(e.new)}\n`, `${base(e.old)}: intacto`);
});

// ── casos de borde del estado ─────────────────────────────────────────────────────────────────────────────────────

const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;

test('T47o · BatchD_StateFilesMigrateOnWrite — oldPathOf: la ruta vieja de un estado del mapa, null fuera del mapa, sin anotar uso', { skip: SKIP_PUBLIC }, () => {
  const e = byNew('console-writes');
  const home = toyHomeW('old-path');
  const r = libEval(home, `process.stdout.write(JSON.stringify([lib.oldPathOf(${JSON.stringify(e.new)}), lib.oldPathOf(${JSON.stringify(stateOf(home, base(e.new)))}), lib.oldPathOf(${JSON.stringify(stateOf(home, 'no-es-del-mapa.json'))})]))`);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), [stateOf(home, base(e.old)), stateOf(home, base(e.old)), null]);
  assert.ok(!fs.existsSync(stateOf(home, 'legacy-names.jsonl')), 'mirar no es usar el nombre viejo: no se anota');
});

// SILENT-C2: «no pude mirar» el viejo no es «no hay viejo».
test('T47p · BatchD_StateFilesMigrateOnWrite — un estado viejo que no se deja mirar es error, no «no hay nada que migrar»', { skip: SKIP_PUBLIC || (ROOT_USER && 'como root los permisos no frenan') }, () => {
  const home = toyHomeW('locked');
  const cerrado = path.join(home, 'cerrado');
  fs.mkdirSync(cerrado);
  fs.writeFileSync(path.join(cerrado, 'viejo.json'), '{"antes":1}\n');
  fs.chmodSync(cerrado, 0o000);
  try {
    const map = JSON.stringify({ entries: [{ kind: 'state-file', old: '~/cerrado/viejo.json', new: '~/nuevo.json', batch: 'lab' }] });
    for (const fn of ['prepareStateWrite', 'resolveFile']) {
      const r = libEval(home, `try { lib.${fn}('~/nuevo.json', { map: ${map} }); process.stdout.write('sin error'); } catch (e) { process.stdout.write(e instanceof lib.LegacyNamesError ? 'error: ' + e.message : 'otro: ' + e); }`);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /^error: .*viejo\.json/, `${fn}: con el viejo sin poder mirarlo tiene que decirlo`);
    }
    assert.ok(!fs.existsSync(path.join(home, 'nuevo.json')), 'el nuevo no nace vacío');
  } finally { fs.chmodSync(cerrado, 0o755); }
});

/** El bloque de fondo del instalador real en un temporal, como en T47n; `prep(st)` siembra el estado antes de correrlo. */
async function installerBlock(p, prep) {
  const src = fs.readFileSync(path.join(RAIZ, 'scripts', 'install-tycon-hooks.sh'), 'utf8');
  let i = src.indexOf('# Rescate del hilo y el consumo de las ejecuciones del pipeline');
  i = src.lastIndexOf('# ====', i);
  let j = src.indexOf('# Hook de git PRE-COMMIT global', i);
  j = src.lastIndexOf('# ====', j);
  const w = scratch(p);
  const home = path.join(w, 'home');
  const st = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(st, { recursive: true });
  const bloque = path.join(w, 'bloque.sh');
  fs.writeFileSync(bloque, src.slice(i, j));
  const sd = path.join(w, 'scripts');
  fs.mkdirSync(path.join(sd, 'metrics'), { recursive: true });
  fs.mkdirSync(path.join(sd, 'lib'), { recursive: true });
  for (const f of ['legacy-names.js', 'renames.json']) fs.symlinkSync(path.join(RAIZ, 'scripts', 'lib', f), path.join(sd, 'lib', f));
  const orden = path.join(w, 'orden.txt');
  for (const [f, paso] of [['tokens-digest.js', 'rescate'], ['collect-findings.js', 'recoleccion'], ['upload-runs.js', 'subida'], ['download-runs.js', 'bajada']]) {
    fs.writeFileSync(path.join(sd, 'metrics', f), `console.log('${paso} de esta ejecución'); require('fs').appendFileSync(process.env.ORDER_LOG, '${paso}\\n');\n`);
  }
  prep(st);
  const r = spawnSync('bash', ['-c', 'source "$1"', '_', bloque], { encoding: 'utf8', timeout: 20000,
    // PROFILE_FULL: lo fija el instalador antes de este bloque (el rescate y la recolección son de full)
    env: cleanEnv({ HOME: home, SCRIPT_DIR: sd, CHECK_ONLY: '0', TYCON_INTEG_MAILBOX: '1', PROFILE_FULL: '1', ORDER_LOG: orden }) });
  for (let n = 0; n < 60 && (readOr(orden) || '').split('\n').filter(Boolean).length < 4; n++) await new Promise((ok) => setTimeout(ok, 250));
  await new Promise((ok) => setTimeout(ok, 300));
  return { r, st, orden };
}

// SILENT-C1: una copia que falla en el arranque deja rastro, y las demás se hacen igual.
test('T47q · BatchD_StateFilesMigrateOnWrite — si el instalador no puede llevar un registro viejo, queda en hook-errors.log y los otros se llevan igual', { skip: SKIP_PUBLIC || (ROOT_USER && 'como root los permisos no frenan') }, async () => {
  const logs = ['download-runs.log', 'upload-runs.log', 'collect-findings.log', 'thread-rescue.log'].map(byNew);
  const cerrado = byNew('collect-findings.log');
  let st0;
  try {
    const { r, st, orden } = await installerBlock('inst-err', (st) => {
      st0 = st;
      for (const e of logs) fs.writeFileSync(path.join(st, base(e.old)), `antes: ${base(e.new)}\n`);
      fs.chmodSync(path.join(st, base(cerrado.old)), 0o000);
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(readOr(orden), 'rescate\nrecoleccion\nsubida\nbajada\n', 'el arranque sigue con sus cuatro pasos');
    const errores = readOr(path.join(st, 'hook-errors.log')) || '';
    assert.match(errores, /--prepare-state/, 'la copia que falló deja rastro en hook-errors.log');
    assert.ok(errores.includes(base(cerrado.old)), 'y nombra el registro que no se pudo llevar');
    for (const nuevo of ['download-runs.log', 'upload-runs.log']) {
      assert.ok((readOr(path.join(st, nuevo)) || '').startsWith(`antes: ${nuevo}\n`), `${nuevo}: se llevó igual`);
    }
  } finally { if (st0) try { fs.chmodSync(path.join(st0, base(cerrado.old)), 0o644); } catch (_) { /* */ } }
});

// un nombre de estado viejo que quede en agent-skills también
// es una mención de más. Un estado vive en la HOME, no en un repo: las dos fuentes se miran.
test('T47r · BatchD_StateFilesMigrateOnWrite — --stale-mentions cuenta un estado viejo nombrado en agent-skills', { skip: SKIP_PUBLIC }, () => {
  const e = byNew('console-writes');
  const g = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv({ GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.com' }) }); assert.strictEqual(r.status, 0, r.stderr); };
  const repo = (files) => {
    const d = scratch('sn-lab');
    g(d, ['init', '-q', '-b', 'main']);
    for (const [f, txt] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), txt); }
    g(d, ['add', '-A']);
    g(d, ['commit', '-q', '-m', 'lab']);
    return d;
  };
  const arnes = repo({ 'scripts/lib/renames.json': `${JSON.stringify({ __about: 'mapa de laboratorio', retire_after: null, entries: [{ kind: 'state-file', old: e.old, new: e.new, batch: 'lab' }] })}\n`, 'README.md': 'nada\n' });
  const skills = repo({ 'skills/x/scripts/escribe.js': `// anota en ${e.old}/<sesión>.jsonl\n` });
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js'), '--stale-mentions', '--json', '--repo', arnes], { encoding: 'utf8', env: cleanEnv({ TYCON_SKILLS_DIR: skills }), timeout: 60000 });
  assert.strictEqual(r.status, 1, `la mención vieja en agent-skills cuenta (rc ${r.status})\n${r.stdout}\n${r.stderr}`);
  const found = JSON.parse(r.stdout).findings.map((f) => `${f.source || f.repo}:${f.rel}`);
  assert.ok(found.some((f) => f.endsWith('skills/x/scripts/escribe.js')), found.join(', '));
});

// si la recolección falla, el sello viejo (que queda intacto) no puede volver a contestar por
// la serie con su fecha vieja: la falla queda dicha en el nuevo.
test('T47s · BatchD_StateFilesMigrateOnWrite — collect-findings.js: una recolección que falla no resucita el sello viejo', { skip: SKIP_PUBLIC }, async () => {
  const seal = byNew('findings-seal.json');
  const script = path.join(RAIZ, 'scripts', 'metrics', 'collect-findings.js');
  const HOY = '2026-09-16';
  const home = toyHomeW('cf-falla');
  fs.writeFileSync(stateOf(home, 'hallazgos.jsonl'), '');
  const viejo = `${JSON.stringify({ estado: 'recolectado', fecha: '2026-09-14', repos: 1, hallazgos: 0, volcados: { medidos: 0 } })}\n`;
  fs.writeFileSync(stateOf(home, base(seal.old)), viejo);
  const w = scratch('cf-falla');
  fs.writeFileSync(path.join(w, 'catalogo.md'), '# Catálogo\n');
  fs.mkdirSync(path.join(w, 'revisores'));
  const r = await run(process.execPath, [script, '--root', path.join(w, 'no-existe'), '--catalog', path.join(w, 'catalogo.md'), '--reviewers', path.join(w, 'revisores'), '--today', HOY, '--json'],
    { env: cleanEnv({ HOME: home, TZ: 'America/Argentina/Buenos_Aires' }) });
  assert.strictEqual(r.status, 2, `la recolección falla (rc ${r.status})\n${r.stdout}\n${r.stderr}`);
  const e = spawnSync(process.execPath, ['-e', `const r = require(${JSON.stringify(script)}).estadoDeLaSerie({ hoy: ${JSON.stringify(HOY)} }); process.stdout.write(JSON.stringify(r));`],
    { env: cleanEnv({ HOME: home }), encoding: 'utf8', timeout: 20000 });
  const est = JSON.parse(e.stdout || '{}');
  assert.strictEqual(est.estado, 'no_medido');
  assert.match(est.motivo || '', /fall/, `el motivo dice que la última recolección falló, no lo del sello viejo: «${est.motivo}»`);
  assert.ok(!String(est.motivo).includes('2026-09-14'), 'no contesta con la fecha del sello viejo');
  assert.strictEqual(readOr(stateOf(home, base(seal.old))), viejo, `${base(seal.old)}: intacto`);
});

// la página de corridas se regenera entera; no poder llevar la vieja no la frena.
test('T47t · BatchD_StateFilesMigrateOnWrite — la vista de ejecuciones se escribe aunque la página vieja no se pueda copiar', { skip: SKIP_PUBLIC || (ROOT_USER && 'como root los permisos no frenan') }, async () => {
  const e = byNew('runs-dashboard.html');
  const home = toyHomeW('runs-err');
  const vieja = stateOf(home, base(e.old));
  fs.writeFileSync(vieja, '<!-- la de antes -->\n');
  fs.chmodSync(vieja, 0o000);
  try {
    const runs = scratch('runs-dir-err');
    const r = await run(process.execPath, [path.join(RAIZ, 'scripts', 'nightly', 'dashboard', 'dashboard.js'), '--view', 'runs', '--runs-dir', runs], { env: cleanEnv({ HOME: home }) });
    assert.strictEqual(r.status, 0, `la página se escribe igual (rc ${r.status})\n${r.stderr}`);
    assert.ok(/<html/i.test(readOr(stateOf(home, base(e.new))) || ''), `${base(e.new)}: escrita`);
  } finally { fs.chmodSync(vieja, 0o644); }
});

// Los lectores y los escritores que no pueden mirar o llevar un
// estado lo DICEN. Los que leen el sello del examen, con la carpeta de estado cerrada; los que agregan una medición, con
// el registro viejo sin poder copiarse. Sin esto, el examen y el aviso caen al nombre nuevo callados, y la medición
// de reglas y de sql no se anota sin decir nada.
test('T47u · BatchD_StateFilesMigrateOnWrite — no poder mirar o llevar un estado se dice: examen, aviso del banco, reglas y sql', { skip: SKIP_PUBLIC || (ROOT_USER && 'como root los permisos no frenan') }, async () => {
  // lectores del sello del examen: la carpeta de estado cerrada
  const cerrada = toyHomeW('lectores');
  const st = stateOf(cerrada, '');
  fs.chmodSync(st, 0o000);
  try {
    const ex = await run(process.execPath, [path.join(RAIZ, 'scripts', 'controls-bench', 'periodic-exam.js'), '--dry-run'], { env: cleanEnv({ HOME: cerrada }) });
    assert.match(ex.stderr, /examen-periodico: no pude mirar .*periodic-exam-last-run/, `el examen lo dice\n${ex.stderr}`);
    // la carpeta local del banco de juguete: sin ella el aviso sale antes de mirar los sellos (una copia recién
    // clonada no la tiene)
    const bench = scratch('bench');
    const av = await run(process.execPath, [path.join(RAIZ, 'scripts', 'hooks', 'bench-notice.js')], { input: '{"source":"startup"}', env: cleanEnv({ HOME: cerrada, TYCON_BENCH_DIR: bench }) });
    assert.match(av.stdout + av.stderr, /aviso del banco: no pude mirar .*periodic-exam-last-run/, `el aviso del arranque lo dice\n${av.stderr}`);
  } finally { fs.chmodSync(st, 0o755); }
  // escritores de una medición: el registro viejo que no se deja copiar
  const rr = byNew('reviewer-rules.jsonl');
  const home = toyHomeW('rr-err');
  const env = gitEnv(home, { TYPESAFE_API_KEY: '' });
  const repo = path.join(home, 'repo-reglas');
  fs.mkdirSync(repo);
  git(repo, env, 'init', '-q', '.');
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Proyecto\n\n## Reglas para revisores\n\n- Nunca SQL concatenado.\n');
  git(repo, env, 'add', 'CLAUDE.md');
  git(repo, env, 'commit', '-qm', 'init');
  fs.appendFileSync(path.join(repo, 'CLAUDE.md'), '- Toda migración nace con su rollback.\n');
  git(repo, env, 'add', 'CLAUDE.md');
  const viejoRR = stateOf(home, base(rr.old));
  fs.writeFileSync(viejoRR, '{"marca":"linea-vieja"}\n');
  fs.chmodSync(viejoRR, 0o000);
  try {
    const r = await run(process.execPath, [path.join(RAIZ, 'scripts', 'ci', 'reviewer-rules.js'), '--repo', repo], { env, cwd: repo });
    assert.strictEqual(r.status, 0, `medir nunca rompe el commit (rc ${r.status})`);
    assert.match(r.stderr, /reglas-revisores: no se anotó la medición/, `las reglas lo dicen\n${r.stderr}`);
  } finally { fs.chmodSync(viejoRR, 0o644); }
  const sq = byNew('sql-compile.jsonl');
  const sqlcmd = fakeBin(path.join(home, 'bin'), 'sqlcmd', 'exit 0');
  const envSql = gitEnv(home, { TYCON_SQL_CMD: sqlcmd, TYCON_SQL_COMPILE_SERVER: 'prueba.local', TYCON_SQL_COMPILE_DATABASE: 'Pruebas',
    TYCON_SQL_COMPILE_USER: 'lector', SQLCMDPASSWORD: 'juguete' });
  const repoSql = path.join(home, 'repo-sql');
  fs.mkdirSync(path.join(repoSql, 'database'), { recursive: true });
  git(repoSql, envSql, 'init', '-q', '.');
  git(repoSql, envSql, 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.writeFileSync(path.join(repoSql, 'database', '055_ok.sql'), 'PRINT 1;\n');
  git(repoSql, envSql, 'add', 'database/055_ok.sql');
  const viejoSql = stateOf(home, base(sq.old));
  fs.writeFileSync(viejoSql, '{"marca":"linea-vieja"}\n');
  fs.chmodSync(viejoSql, 0o000);
  try {
    const r = await run(process.execPath, [path.join(RAIZ, 'scripts', 'ci', 'sql-compile.js'), '--staged', '--repo', repoSql], { env: envSql, cwd: repoSql });
    assert.strictEqual(r.status, 0, `medir nunca rompe el commit (rc ${r.status})`);
    assert.match(r.stderr, /sql: no se anotó la medición/, `sql lo dice\n${r.stderr}`);
  } finally { fs.chmodSync(viejoSql, 0o644); }
});
