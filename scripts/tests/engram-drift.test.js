#!/usr/bin/env node
/**
 * engram-drift.test.js — los dos chequeos de ENGRAM-PROJECT-NAME-DRIFT-1 (harness-audit.js,
 * categoría Memory Persistence).
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 * engram autodetecta el project name desde el basename del cwd cuando el repo no lo fija. Eso
 * fragmenta la memoria SIN dar error: `mem_search` con el nombre equivocado devuelve
 * "no memories found", que es indistinguible de "este repo todavía no tiene historia". Medido el
 * 2026-08-24 en dos repos el mismo día — el repo del framework (74 obs en 6 nombres, disparado por un
 * rename de carpeta) y el arnés (135 obs en 7 nombres, porque la guía mandaba `tycon` y
 * `.engram-project` declaraba otro nombre; 11 de esas obs NUNCA se exportaron a un chunk, o sea
 * que vivían en UNA sola máquina).
 *
 * Los casos de abajo no son decorativos: cada uno es un modo de falla que la primera versión del
 * chequeo TENÍA, cazado corriéndolo contra la máquina real antes de commitear.
 *   · sin normalizar mayúsculas, el chequeo acusaba 17 directorios de los cuales ~11 no tenían
 *     nada roto (`FRESNO`/`fresno` es EL MISMO cajón — engram 1.20 filtra case-insensitive). Un control
 *     que cría lobos se ignora, y se lleva puestos los casos donde sí importaba.
 *   · sin excluir los proyectos transversales, acusaba a todo repo donde alguien tocó el arnés —
 *     guardar bajo `tycon` desde el cwd de un producto es la CONVENCIÓN (engram-workflow.md §2),
 *     no drift. Un control que castiga el comportamiento correcto no sobrevive dos corridas.
 *   · el camino "no pude mirar la DB" tiene que devolver null y NO una lista vacía: "no sé" no es
 *     "está limpio". Es la misma regla que el resto del arnés aplica a los listados atrasados.
 *
 * Correr: node --test scripts/tests/engram-drift.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const AUDIT = path.join(__dirname, '..', 'lib', 'harness-audit.js');
const { scanEngramRepos, engramDirsWithMultipleProjects, CROSS_CUTTING_PROJECTS } = require(AUDIT);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engramdrift-'));
const SKIP = !haySqlite3() && 'sin sqlite3';

function haySqlite3() {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// Arma una DB de laboratorio con la forma real de engram: `sessions` + `observations`.
// Las observaciones importan porque el chequeo sólo cuenta nombres que TODAVÍA tienen memoria viva
// (ver el caso `SoloCuentanLosCajonesConMemoriaViva` más abajo). `obs` por fila: cuántas
// observaciones vivas tiene ese project; 0 = cajón vaciado por una consolidación previa.
function dbConSesiones(dir, filas) {
  const db = path.join(dir, 'engram.db');
  const esc = (x) => String(x).replace(/'/g, "''");
  const inserts = [];
  let oid = 0;
  filas.forEach((f, i) => {
    inserts.push(`INSERT INTO sessions VALUES ('s${i}', '${esc(f.project)}', '${esc(f.directory)}');`);
    const n = f.obs === undefined ? 1 : f.obs;
    for (let k = 0; k < n; k++) {
      inserts.push(`INSERT INTO observations VALUES (${++oid}, '${esc(f.project)}', NULL);`);
    }
  });
  const sql = [
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT NOT NULL, directory TEXT NOT NULL);',
    'CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, deleted_at TEXT);',
    ...inserts,
  ].join('\n');
  execFileSync('sqlite3', [db], { input: sql });
  return db;
}

// ── Chequeo 1: el PIN (previene) ──────────────────────────────────────────────────────────────

test('scanEngramRepos: separa repos con project name fijado de los que lo dejan a la autodetección', () => {
  const root = tmp();
  const mk = (nombre, opts = {}) => {
    fs.mkdirSync(path.join(root, nombre, '.engram'), { recursive: true });
    if (opts.config) fs.writeFileSync(path.join(root, nombre, '.engram', 'config.json'),
      JSON.stringify({ project_name: opts.config }));
    if (opts.legacy) fs.writeFileSync(path.join(root, nombre, '.engram-project'), opts.legacy + '\n');
  };
  mk('con-config', { config: 'proyecto-a' });
  mk('con-legacy', { legacy: 'proyecto-b' });          // `.engram-project` también cuenta como pin
  mk('sin-nada');                                       // ← el que hay que avisar
  fs.mkdirSync(path.join(root, 'sin-engram'));          // repo sin memoria: ni se mira

  const r = scanEngramRepos(root);
  assert.deepEqual(r.unpinned.map((x) => x.repo), ['sin-nada']);
  assert.deepEqual(r.pinned.map((x) => x.repo).sort(), ['con-config', 'con-legacy']);
  assert.equal(r.pinned.find((x) => x.repo === 'con-config').project, 'proyecto-a');
  assert.equal(r.pinned.find((x) => x.repo === 'con-legacy').project, 'proyecto-b');

  fs.rmSync(root, { recursive: true, force: true });
});

test('scanEngramRepos: un config.json vacío, ilegible o con project_name en blanco NO cuenta como pin', () => {
  const root = tmp();
  const mk = (nombre, contenido) => {
    fs.mkdirSync(path.join(root, nombre, '.engram'), { recursive: true });
    fs.writeFileSync(path.join(root, nombre, '.engram', 'config.json'), contenido);
  };
  mk('roto', '{ esto no es json');
  mk('vacio', '{}');
  mk('blanco', JSON.stringify({ project_name: '   ' }));

  const r = scanEngramRepos(root);
  assert.deepEqual(r.unpinned.map((x) => x.repo).sort(), ['blanco', 'roto', 'vacio'],
    'un pin que no se puede leer es lo mismo que no tener pin — si no, el aviso se pierde justo donde más falta');
  assert.equal(r.pinned.length, 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test('scanEngramRepos: root inexistente no explota (fail-open)', () => {
  const r = scanEngramRepos(path.join(os.tmpdir(), 'no-existe-' + process.pid));
  // No explota Y no inventa repos. Que además DIGA que no pudo mirar lo cubre el test de abajo:
  // acá sólo se fija que el fail-open siga siendo fail-open.
  assert.deepEqual(r.pinned, []);
  assert.deepEqual(r.unpinned, []);
  assert.deepEqual(r.nuncaSincronizo, []);
});

// ── Escaneo de DOS niveles + el tercer estado (2026-08-25) ───────────────────────────────────
// La primera versión miraba sólo los hijos directos de ~/SourceCode y era ciega justo donde
// estaban los casos: Ceibo, Totora, Pacara, FRESNO y URUTAU son contenedores (la carpeta de
// arriba no es un repo git) y sus repos viven un nivel más abajo. Medido: con un solo nivel se
// perdían 4 repos sin pin y 2 que declaran el nombre hace meses sin haber exportado jamás.
test('scanEngramRepos: ve los sub-repos de un contenedor, y separa "declaró pero nunca sincronizó"', () => {
  const root = tmp();
  const mk = (rel, opts = {}) => {
    const d = path.join(root, rel);
    fs.mkdirSync(path.join(d, '.engram', 'chunks'), { recursive: true });
    if (opts.pin) fs.writeFileSync(path.join(d, '.engram', 'config.json'), JSON.stringify({ project_name: opts.pin }));
    if (opts.git) fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    if (opts.chunks) fs.writeFileSync(path.join(d, '.engram', 'chunks', 'a1b2c3d4.jsonl.gz'), 'x');
    return d;
  };
  mk('Contenedor/SubConPin', { pin: 'proyecto-x', git: true, chunks: true });
  mk('Contenedor/SubSinPin', { git: true });
  mk('Contenedor/SubQueNuncaSincronizo', { pin: 'proyecto-x', git: true });   // pin, git, 0 chunks
  mk('Contenedor', { pin: 'proyecto-x' });                                     // contenedor: sin .git

  const r = scanEngramRepos(root);
  assert.ok(r.pinned.some((x) => x.repo === 'Contenedor/SubConPin'),
    'el sub-repo con pin tiene que aparecer — con un solo nivel de escaneo era invisible');
  assert.deepEqual(r.unpinned.map((x) => x.repo), ['Contenedor/SubSinPin']);
  assert.deepEqual(r.nuncaSincronizo.map((x) => x.repo), ['Contenedor/SubQueNuncaSincronizo'],
    'declarar el nombre y no haber exportado nunca es su propio estado: el pin engaña, el repo parece cubierto');
  assert.ok(!r.nuncaSincronizo.some((x) => x.repo === 'Contenedor'),
    'un contenedor SIN .git no tiene por qué llevar chunks — los suyos viven en los sub-repos');

  fs.rmSync(root, { recursive: true, force: true });
});

// ── "No pude mirar" NUNCA es "está limpio" (2026-08-25, revisión adversarial) ────────────────
// Los tres casos de abajo devolvían exactamente lo mismo que un repo sano: listas vacías. Y una
// lista vacía, río abajo, se lee como "no hay nada raro". Es el modo de falla que estos chequeos
// existen para cazar, adentro de los chequeos.

test('scanEngramRepos: una raíz inexistente NO se lee como "no hay repos"', () => {
  const r = scanEngramRepos(path.join(os.tmpdir(), 'no-existe-' + process.pid));
  assert.deepEqual(r.pinned, []);
  assert.ok(r.error, 'tiene que DECIR que no pudo mirar — si no, cero repos parece salud');
  assert.match(r.error, /no existe/);
});

test('engramChunksSinIndexar: chunks SIN manifest = todos invisibles, no "sano"', () => {
  const root = tmp();
  const d = path.join(root, 'repo', '.engram');
  fs.mkdirSync(path.join(d, 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ project_name: 'p' }));
  fs.writeFileSync(path.join(d, 'chunks', 'aaaaaaaa.jsonl.gz'), 'x');
  fs.writeFileSync(path.join(d, 'chunks', 'bbbbbbbb.jsonl.gz'), 'x');
  // sin manifest.json

  const r = require(AUDIT).engramChunksSinIndexar(root);
  assert.equal(r.length, 1, 'el peor caso posible —NINGÚN chunk indexado— era el que menos ruido hacía');
  assert.deepEqual(r[0].sinIndexar.sort(), ['aaaaaaaa', 'bbbbbbbb']);
  assert.ok(r[0].sinManifest);

  fs.rmSync(root, { recursive: true, force: true });
});

test('engramChunksSinIndexar: manifest SIN carpeta de chunks = entradas fantasma', () => {
  const root = tmp();
  const d = path.join(root, 'repo', '.engram');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ project_name: 'p' }));
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ version: 1, chunks: [{ id: 'zzzzzzzz' }] }));

  const r = require(AUDIT).engramChunksSinIndexar(root);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].fantasma, ['zzzzzzzz'], 'el índice apunta a un archivo que no está: es una referencia rota, no "todo bien"');

  fs.rmSync(root, { recursive: true, force: true });
});

test('un repo SIN memoria sigue sin reportarse (el filtro no se pasó de largo)', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'repo', 'src'), { recursive: true });
  assert.deepEqual(require(AUDIT).engramChunksSinIndexar(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('las consultas se hacen por ARRAY, así que una ruta con espacios funciona', { skip: SKIP }, () => {
  // 🔴 Windows normal: C:\Program Files\sqlite3.exe. Con la versión vieja —que armaba una línea
  // de shell— el binario ni se invocaba y la consulta devolvía null, que se leía como "limpio".
  const dir = tmp();
  const conEspacios = path.join(dir, 'Program Files');
  fs.mkdirSync(conEspacios, { recursive: true });
  const shim = path.join(conEspacios, 'sqlite3');
  const real = execFileSync('sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(shim, `#!/bin/sh\nexec ${real} "$@"\n`);
  fs.chmodSync(shim, 0o755);

  const db = path.join(dir, 'engram.db');
  execFileSync('sqlite3', [db], { input: 'CREATE TABLE sessions (id TEXT, project TEXT NOT NULL, directory TEXT NOT NULL);\nCREATE TABLE observations (id INTEGER, project TEXT, deleted_at TEXT);\n' });

  const prev = process.env.TYCON_SQLITE_BIN;
  try {
    process.env.TYCON_SQLITE_BIN = shim;
    delete require.cache[require.resolve(AUDIT)];
    const a = require(AUDIT);
    assert.notStrictEqual(a.engramDirsWithMultipleProjects(db, path.join(dir, 'repos')), null,
      'con la ruta entre espacios la consulta tiene que funcionar, no devolver null');
  } finally {
    if (prev === undefined) delete process.env.TYCON_SQLITE_BIN; else process.env.TYCON_SQLITE_BIN = prev;
    delete require.cache[require.resolve(AUDIT)];
    require(AUDIT);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Chequeo 2: el CONTEO por directorio (detecta lo ya fragmentado) ───────────────────────────

test('engramDirsWithMultipleProjects: dos nombres en el mismo directorio = memoria partida', { skip: !haySqlite3() && 'sin sqlite3' }, () => {
  const dir = tmp();
  const scope = path.join(dir, 'repos');
  const db = dbConSesiones(dir, [
    { project: 'ceibo', directory: path.join(scope, 'Ceibo') },
    { project: 'ceiboproject', directory: path.join(scope, 'Ceibo') },
    { project: 'totora', directory: path.join(scope, 'Totora') },   // uno solo: sano
  ]);

  const r = engramDirsWithMultipleProjects(db, scope);
  assert.equal(r.length, 1);
  assert.equal(path.basename(r[0].dir), 'Ceibo');
  assert.deepEqual(r[0].names.sort(), ['ceibo', 'ceiboproject']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('engramDirsWithMultipleProjects: mayúsculas NO son drift (engram 1.20 filtra case-insensitive)', { skip: !haySqlite3() && 'sin sqlite3' }, () => {
  const dir = tmp();
  const scope = path.join(dir, 'repos');
  const db = dbConSesiones(dir, [
    { project: 'FRESNO', directory: path.join(scope, 'FRESNO') },
    { project: 'fresno', directory: path.join(scope, 'FRESNO') },
  ]);

  assert.deepEqual(engramDirsWithMultipleProjects(db, scope), [],
    'la primera versión contaba esto como drift y hacía saltar 17 repos, ~11 de ellos sanos');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('engramDirsWithMultipleProjects: guardar bajo un proyecto TRANSVERSAL no es drift', { skip: !haySqlite3() && 'sin sqlite3' }, () => {
  const dir = tmp();
  const scope = path.join(dir, 'repos');
  const db = dbConSesiones(dir, [
    { project: 'totora', directory: path.join(scope, 'Totora') },
    { project: 'tycon', directory: path.join(scope, 'Totora') },   // arnés desde el cwd del producto: correcto
  ]);

  assert.deepEqual(engramDirsWithMultipleProjects(db, scope), [],
    'engram-workflow.md §2 manda guardar el arnés como `tycon` desde cualquier repo — acusarlo castiga lo correcto');

  // ...pero DOS proyectos de producto en el mismo directorio sí se avisa, aunque haya un `tycon` en el medio.
  const db2 = dbConSesiones(tmp(), [
    { project: 'totora', directory: path.join(scope, 'Totora') },
    { project: 'tycon', directory: path.join(scope, 'Totora') },
    { project: 'nimbobackend', directory: path.join(scope, 'Totora') },
  ]);
  const r2 = engramDirsWithMultipleProjects(db2, scope);
  assert.equal(r2.length, 1);
  assert.deepEqual(r2[0].names.sort(), ['nimbobackend', 'totora']);
  assert.ok(!r2[0].names.includes('tycon'), 'el transversal no ensucia el reporte');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('engramDirsWithMultipleProjects: sólo mira dentro del scope — una sesión suelta desde ~ no es un repo que arreglar', { skip: !haySqlite3() && 'sin sqlite3' }, () => {
  const dir = tmp();
  const scope = path.join(dir, 'repos');
  const db = dbConSesiones(dir, [
    { project: 'downloads', directory: path.join(dir, 'Downloads') },
    { project: 'Downloads2', directory: path.join(dir, 'Downloads') },
  ]);

  assert.deepEqual(engramDirsWithMultipleProjects(db, scope), []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('engramDirsWithMultipleProjects: un cajón ya VACIADO por una consolidación no cuenta', { skip: !haySqlite3() && 'sin sqlite3' }, () => {
  const dir = tmp();
  const scope = path.join(dir, 'repos');
  const db = dbConSesiones(dir, [
    { project: 'pluginforms', directory: path.join(scope, 'PluginHost'), obs: 74 },
    // La etiqueta vieja sobrevive en `sessions` tras consolidar, pero su cajón quedó en 0 obs.
    { project: 'plugin%20host', directory: path.join(scope, 'PluginHost'), obs: 0 },
  ]);

  assert.deepEqual(engramDirsWithMultipleProjects(db, scope), [],
    'sin este filtro el chequeo queda en rojo PARA SIEMPRE sobre memoria ya unificada — y un rojo permanente se aprende a ignorar (4 falsos positivos medidos el 2026-08-25, apenas terminó la consolidación)');

  // Control: si el cajón viejo TODAVÍA tiene memoria, sí se avisa.
  const db2 = dbConSesiones(tmp(), [
    { project: 'pluginforms', directory: path.join(scope, 'PluginHost'), obs: 74 },
    { project: 'plugin%20host', directory: path.join(scope, 'PluginHost'), obs: 12 },
  ]);
  assert.equal(engramDirsWithMultipleProjects(db2, scope).length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('engramDirsWithMultipleProjects: sin DB devuelve null — "no sé" NUNCA es "está limpio"', () => {
  const r = engramDirsWithMultipleProjects(path.join(os.tmpdir(), 'no-existe-' + process.pid + '.db'), '/tmp');
  assert.strictEqual(r, null,
    'si devolviera [] el scorecard pintaría verde sin haber mirado nada — el modo de falla que el arnés persigue');
});

test('CROSS_CUTTING_PROJECTS incluye el proyecto del arnés', () => {
  assert.ok(CROSS_CUTTING_PROJECTS.has('tycon'));
});

// ── El CLI no se rompió al exportar ───────────────────────────────────────────────────────────

test('harness-audit.js sigue corriendo como CLI, y como require no imprime nada', () => {
  const salida = execFileSync('node', [AUDIT], { encoding: 'utf8' });
  assert.match(salida, /Score total: \d+\/\d+/);

  const callado = execFileSync('node', ['-e', `require(${JSON.stringify(AUDIT)})`], { encoding: 'utf8' });
  assert.equal(callado.trim(), '',
    'el guard require.main es lo que permite testear los helpers sin disparar el scorecard entero');
});

// ── story 8.12, R3: el aviso diario importa desde scripts/lib/ y dice la ruta nueva ───────────────

const SCRIPTS = path.join(__dirname, '..');

test('T28 R3_HarnessAuditAutoheal_HooksRequireLib — el aviso diario corre con harness-audit sólo en scripts/lib/ y su comando dice esa ruta', () => {
  // Arnés de laboratorio SIN los reemplazos de las rutas viejas: con ellos al lado, un `require` viejo seguiría
  // andando y esta prueba no lo vería. Sólo el hook y scripts/lib/ (lo que harness-audit carga al empezar).
  const raiz = tmp();
  const tcg = path.join(raiz, 'tcg');
  fs.mkdirSync(path.join(tcg, 'scripts', 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(SCRIPTS, 'hooks', 'engram-drift-notice.js'), path.join(tcg, 'scripts', 'hooks', 'engram-drift-notice.js'));
  fs.cpSync(path.join(SCRIPTS, 'lib'), path.join(tcg, 'scripts', 'lib'), { recursive: true });
  const home = path.join(raiz, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), JSON.stringify({ paths: { repos: '~/SourceCode' } }));
  fs.mkdirSync(path.join(home, 'SourceCode', 'repo-de-laboratorio', '.engram', 'chunks'), { recursive: true });

  const salida = execFileSync(process.execPath, [path.join(tcg, 'scripts', 'hooks', 'engram-drift-notice.js'), '--force'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, TYCON_ENGRAM: '1', TYCON_NO_NIGHTLY_EXAM: '1', LANG: 'en_US.UTF-8' },
  });
  assert.match(salida, /SIN nombre de proyecto fijado: repo-de-laboratorio/,
    `el hook no llegó a los chequeos de harness-audit (¿lo busca fuera de scripts/lib/?): ${salida}`);
  assert.match(salida, /Detalle y score: node \S*\/scripts\/lib\/harness-audit\.js --verbose/,
    'el comando que el aviso imprime tiene que ser la ruta nueva');
  fs.rmSync(raiz, { recursive: true, force: true });
});

test('T28 R3_HarnessAuditAutoheal_HooksRequireLib — los comandos que imprimen los avisos dicen la ruta nueva', () => {
  // El aviso del autoheal (memoria partida unificable) y el del banco (paridad en rojo) necesitan una base de engram
  // o un resultado del banco para salir; lo que se fija acá es el comando que muestran.
  const drift = fs.readFileSync(path.join(SCRIPTS, 'hooks', 'engram-drift-notice.js'), 'utf8');
  assert.match(drift, /node ~\/\.claude\/tycon-harness\/scripts\/lib\/engram-autoheal\.js\\n/);
  assert.match(drift, /require\(path\.join\(__dirname, '\.\.', 'lib', 'engram-autoheal\.js'\)\)/);
  assert.match(drift, /require\(path\.join\(__dirname, '\.\.', 'lib', 'harness-audit\.js'\)\)/);
  const bench = fs.readFileSync(path.join(SCRIPTS, 'hooks', 'bench-notice.js'), 'utf8');
  assert.match(bench, /correr: node scripts\/lib\/harness-audit\.js --parity/);
});
