'use strict';
/**
 * night-notices.test.js — los avisos de arranque leen la noche del clon de mantenimiento (T85).
 *
 * POR QUÉ. La máquina de quien mantiene el arnés usa la versión bajada y tiene dos clones: el del repo
 * público (el código) y el del repo de mantenimiento (donde los nocturnos dejan sus datos). Si los avisos de arranque
 * buscaran esos datos en el clon del público, que no los trae, callarían: de cinco nocturnos sanos el arranque mostraría
 * una línea, y una pieza muerta se vería igual que una sana. Lo que la máquina escribe (el registro de cada merge) caería
 * en una carpeta ignorada del clon del público y no viajaría a ningún repo.
 *
 * QUÉ VERIFICA. En una máquina con versión bajada que declara su clon de mantenimiento (`paths.maintainers`):
 *   · una línea por nocturno —dependencias, vigilante, banco, suites, tablero—, leída de lo publicado en ese clon;
 *   · una pieza muerta, una sin foto y una con la foto ilegible lo dicen, cada una con su texto;
 *   · foto vencida y copia del clon sin traer desde antes: «no sé si corrió», no «no está corriendo»;
 *   · ningún ✅ con la noche incompleta;
 *   · sin clon declarado en una máquina que mantiene, o con uno que no sirve: una línea con el comando;
 *   · lo que escribe la máquina cae en el clon de mantenimiento, nunca en el del público;
 *   · en cualquier otra máquina, lo de siempre.
 *
 * 🔴 El clon de mantenimiento se alcanza SÓLO por la configuración de la máquina de juguete: ningún caso pasa una
 * variable que apunte un aviso a él. Con el arreglo sacado, estos casos tienen que fallar.
 * 🔴 Nada toca la máquina real: `HOME` y `TYCON_HOME` propios, git sin configuración de sistema ni de usuario, y los
 * remotos son carpetas locales. Cada aviso corre en un proceso hijo con un ambiente armado de cero.
 */
// partida en tres (scripts/tests/suite-parts.json): cada caso arma su máquina de juguete y, en el agente de la validación, el
// archivo entero pasa de 45 s. Corrido a mano corre todo, como siempre.
const test = require('./lib/suite-parts.js').test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const day = (ms) => iso(ms).slice(0, 10);
const LABS = [];
test.after(() => { for (const d of LABS) fs.rmSync(d, { recursive: true, force: true }); });

function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

/** El ambiente de un proceso del laboratorio: armado de cero, sin heredar nada de quien corre la prueba. */
function labEnv(lab, more = {}) {
  const env = {
    PATH: process.env.PATH, HOME: lab.home, USERPROFILE: lab.home, TYCON_HOME: lab.tycon,
    TMPDIR: lab.tmp, TEMP: lab.tmp, TMP: lab.tmp, LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(lab.base, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
    TYCON_NIGHTLY: '1',
    // el examen de los revisores no es de esta prueba: nadie lo corre en el laboratorio, y lo local queda vacío
    TYCON_EXAM_CONFIG: path.join(lab.base, 'exam-config.json'), TYCON_BENCH_DIR: path.join(lab.base, 'bench-local'),
    // sin llave del buzón, salvo que el caso traiga la suya: sin esto se lee la del árbol que corre la prueba, y el repo
    // del equipo la trae
    TYCON_MAILBOX_JSON: path.join(lab.base, 'llaves', 'no-hay-llave.json'),
    ...more,
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  for (const k of Object.keys(env)) if (env[k] === undefined || env[k] === null) delete env[k];
  return env;
}

function git(lab, cwd, args) {
  const r = spawnSync('git', ['-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', '-c', 'init.defaultBranch=main',
    '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', env: labEnv(lab) });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} en ${cwd}: ${r.stderr || r.error}`);
  return r.stdout.trim();
}

const SEAL = (generado) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>t</title><script type="application/json" id="tablero-sello">${JSON.stringify({
  esquema: 1, generado, snapshot: generado.slice(0, 10), modo: 'nocturno', corrida: '4242',
  fuentes: { esperadas: 13, al_dia: 13 }, buzon: { estado: 'leido', maquinas: 3 } })}</script></head><body></body></html>`;

/** Lo que una noche sana deja publicado. `at`: cuándo corrió. Cada clave se puede pisar o sacar (`null`). */
function night(at, over = {}) {
  const d = day(at);
  const delivered = { canal: 'telegram', message_id: 3, editado: null, entregado_el: iso(at), motivo: null, rubros: {} };
  const files = {
    'README.md': 'el repo de mantenimiento de juguete\n',
    [`.dashboard/dependencias/dependencias-${d}.json`]: JSON.stringify({
      fecha: d, corrida_completa: true, linea_base: false, no_medidos: [], hallazgos: [],
      pedidos: { simulado: false, creados: [], fallidos: [] },
      cruce: { consultado: true, cerrados_vivos: [], no_leidos: [], huerfanos: [], huerfanos_no_consultados: [] },
      resumen: delivered }),
    [`.dashboard/vigilante/vigilante-${d}.json`]: JSON.stringify({ fecha: d, generado: iso(at), hallazgos: [], no_medido: [], modo: 'normal', aviso: null, resumen: delivered }),
    'scripts/controls-bench/ultimo-banco.json': JSON.stringify({ ts: iso(at), tool: 'both', ran: 12, failed: 0, skipped: 0, nomedido: 0, parityBreaks: 0, baselineRegressions: 0, origen: 'azure-pipelines', estado: 'completo' }),
    'scripts/controls-bench/ultimo-suites.json': JSON.stringify({ kind: 'bash-tests', ts: iso(at), origen: 'azure-pipelines', corridas: 3, failures: [], motivos: {}, unmeasured: [], complete: true, ran: ['a.test.js', 'b.test.sh', 'c.test.js'], disappeared: [] }),
    'artifacts/tablero-del-arnes.html': SEAL(iso(at)),
  };
  for (const [k, v] of Object.entries(over)) { if (v === null) delete files[k]; else files[k] = v; }
  return files;
}
const BANCO = 'scripts/controls-bench/ultimo-banco.json';
const SUITES = 'scripts/controls-bench/ultimo-suites.json';
const TABLERO = 'artifacts/tablero-del-arnes.html';
const depsFile = (at) => `.dashboard/dependencias/dependencias-${day(at)}.json`;
const vigFile = (at) => `.dashboard/vigilante/vigilante-${day(at)}.json`;
const edit = (files, key, fn) => { const j = JSON.parse(files[key]); fn(j); return JSON.stringify(j); };

/**
 * Una máquina de juguete. `published`: lo que trae `origin/main` del clon de mantenimiento. `fetched`: hace cuánto se
 * trajo ese clon (ms), `'failed'` (la última traída falló) o `null` (nunca). `config`: qué declara la máquina
 * (`both` | `maintained` | `none`, o un objeto con las rutas). `release`: `false` = no es una versión bajada.
 */
function machine({ published = night(Date.now() - HOUR), fetched = 60 * 1000, fetchedBranch = 'main', config = 'both', release = true, disk = null, ops = null, opsFetched = 60 * 1000 } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'night-notices-')));
  LABS.push(base);
  const lab = { base, home: path.join(base, 'home'), tmp: path.join(base, 'tmp') };
  lab.tycon = path.join(lab.home, '.tycon');
  for (const d of [lab.home, lab.tmp, path.join(base, 'bench-local')]) fs.mkdirSync(d, { recursive: true });
  // sin el mantenimiento automático de git: un commit puede dejar de fondo un empaquetado en el repo de origen, y el clon
  // que lo copia en ese momento falla con «failed to copy file … tmp_idx» (visto en la CI de Linux)
  write(path.join(base, 'gitconfig'), '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
  write(path.join(base, 'exam-config.json'), JSON.stringify({ designated_machine: '' }));
  if (release) write(path.join(lab.tycon, 'state', 'harness-state.json'), JSON.stringify({ schema: 1, sources: [{ kind: 'release', version: '0.0.0' }] }));

  // el clon del público: código, ningún dato de la noche
  lab.pub = path.join(base, 'clones', 'publico');
  write(path.join(lab.pub, 'README.md'), 'el repo público de juguete\n');
  git(lab, lab.pub, ['init', '-q', '.']);
  git(lab, lab.pub, ['add', '-A']); git(lab, lab.pub, ['commit', '-qm', 'v1']);
  git(lab, lab.pub, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  // el repo de mantenimiento (una carpeta local hace de remoto) y su clon en la máquina
  const origin = path.join(base, 'remotos', 'mantenimiento');
  for (const [rel, text] of Object.entries(published)) write(path.join(origin, ...rel.split('/')), text);
  git(lab, origin, ['init', '-q', '.']);
  git(lab, origin, ['add', '-A', '-f']); git(lab, origin, ['commit', '-qm', 'la noche']);
  lab.priv = path.join(base, 'clones', 'mantenimiento');
  fs.mkdirSync(path.dirname(lab.priv), { recursive: true });
  const c = spawnSync('git', ['clone', '-q', origin, lab.priv], { encoding: 'utf8', env: labEnv(lab) });
  assert.strictEqual(c.status, 0, c.stderr);
  if (fetched !== null) {
    const head = path.join(lab.priv, '.git', 'FETCH_HEAD');
    fs.writeFileSync(head, fetched === 'failed' ? '' : `${git(lab, lab.priv, ['rev-parse', 'HEAD'])}\t\tbranch '${fetchedBranch}' of ${origin}\n`);
    const when = new Date(Date.now() - (fetched === 'failed' ? 60 * 1000 : fetched));
    fs.utimesSync(head, when, when);
  }
  // el disco del clon puede decir otra cosa que lo publicado (otra rama, archivos pisados)
  if (disk) {
    git(lab, lab.priv, ['checkout', '-q', '-b', 'otra-rama']);
    for (const [rel, text] of Object.entries(disk)) {
      const f = path.join(lab.priv, ...rel.split('/'));
      if (text === null) fs.rmSync(f, { recursive: true, force: true }); else write(f, text);
    }
  }
  // el repo de operaciones, aparte: `ops` = lo que trae su origin/main; sin `ops`, no hay clon de operaciones
  if (ops) lab.ops = dataClone(lab, 'operaciones', ops, opsFetched);
  // `both`: el mismo clon hace de mantenimiento y de operaciones (los datos viven en las mismas rutas en los dos repos)
  const paths = config === 'both' ? { maintained: lab.pub, maintainers: lab.priv, operations: lab.priv }
    : config === 'maintained' ? { maintained: lab.pub } : config === 'none' ? null : config(lab);
  if (paths) write(path.join(lab.tycon, 'config.json'), JSON.stringify({ paths }));
  // ¿esta máquina lee la noche de su clon de mantenimiento? Si no, el aviso del banco cae a las fotos que haya AL LADO
  // del hook —las del árbol donde corre esta prueba, que en el árbol del nocturno son las de anoche de verdad—: ahí se
  // lo apunta a un archivo que no existe, para que el resultado no dependa de dónde se corre. 🔴 En la máquina que sí
  // espera los nocturnos NO se pasa ninguna variable: el clon se alcanza sólo por la configuración.
  lab.expects = release && config === 'both';
  return lab;
}

/** Un repo de datos (una carpeta local hace de remoto) y su clon en la máquina, traído hace `fetched` ms (o nunca: null). */
function dataClone(lab, name, published, fetched) {
  const origin = path.join(lab.base, 'remotos', name);
  for (const [rel, text] of Object.entries(published)) write(path.join(origin, ...rel.split('/')), text);
  git(lab, origin, ['init', '-q', '.']);
  git(lab, origin, ['add', '-A', '-f']); git(lab, origin, ['commit', '-qm', 'la noche']);
  const clone = path.join(lab.base, 'clones', name);
  const c = spawnSync('git', ['clone', '-q', origin, clone], { encoding: 'utf8', env: labEnv(lab) });
  assert.strictEqual(c.status, 0, c.stderr);
  if (fetched !== null) {
    const head = path.join(clone, '.git', 'FETCH_HEAD');
    fs.writeFileSync(head, `${git(lab, clone, ['rev-parse', 'HEAD'])}\t\tbranch 'main' of ${origin}\n`);
    const when = new Date(Date.now() - fetched);
    fs.utimesSync(head, when, when);
  }
  return clone;
}

function hook(lab, name, env = {}, tree = ROOT) {
  const r = spawnSync(process.execPath, [path.join(tree, 'scripts', 'hooks', name)], { encoding: 'utf8', env: labEnv(lab, env), input: '{"source":"startup"}', timeout: 60000 });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
/** El arranque de la máquina: los tres avisos de los nocturnos. → `{ deps, bench, board, all, lines }`. */
function startup(lab, more = {}, tree = ROOT) {
  const nothingBeside = lab.expects || tree !== ROOT ? {} : { TYCON_BENCH_REPORT: path.join(lab.base, 'no-hay-foto-del-banco.json'), TYCON_SUITES_REPORT: path.join(lab.base, 'no-hay-foto-de-suites.json') };
  const env = { ...nothingBeside, ...more };
  const deps = hook(lab, 'dependencies-notice.js', env, tree);
  const bench = hook(lab, 'bench-notice.js', env, tree);
  const board = hook(lab, 'dashboard-notice.js', env, tree);
  for (const r of [deps, bench, board]) assert.strictEqual(r.status, 0, `un aviso salió ${r.status}: ${r.err}`);
  const all = [deps.out, bench.out, board.out].join('');
  return { deps: deps.out, bench: bench.out, board: board.out, all, lines: all.split('\n').filter((l) => /^\S/.test(l)) };
}
const line = (s, re) => s.lines.find((l) => re.test(l)) || '';
const NIGHTLIES = { dependencias: /dependencias\b/, vigilante: /vigilante\b/, banco: /banco de controles/i, suites: /suites de prueba/i, tablero: /tablero del arnés/ };
/** La línea de cada nocturno, o '' si no habló. */
const perNightly = (s) => Object.fromEntries(Object.entries(NIGHTLIES).map(([k, re]) => [k, line(s, re)]));

// ── 1 · todo sano: cinco líneas ───────────────────────────────────────────────────────────────────────────────────────
test('T85 NightNotices_MaintainersClone_OneLinePerNightly_DeadIsNeverSilent_MachineWritesLandThere', () => {
  const at = Date.now() - HOUR;
  const s = startup(machine({ published: night(at) }));
  const n = perNightly(s);
  const d = day(at);
  assert.match(n.dependencias, new RegExp(`^✅ dependencias \\(${d}\\): miró y no hay nada esperando decisión`), s.all);
  assert.match(n.vigilante, new RegExp(`^✅ vigilante \\(${d}\\): corrió y entregó su resumen`), s.all);
  assert.match(n.banco, new RegExp(`^✅ banco de controles nocturno \\(${d}\\): 12 caso\\(s\\), sin rojos`), s.all);
  assert.match(n.suites, new RegExp(`^✅ suites de prueba nocturnas \\(foto del ${d}[^)]*\\): 3 ejecución\\(es\\), ninguna en rojo`), s.all);
  assert.match(n.tablero, new RegExp(`^✅ tablero del arnés \\(${d} [0-9:]+ UTC\\): completo`), s.all);
  assert.strictEqual(s.lines.length, 5, `una línea por nocturno, ni una más:\n${s.all}`);
  assert.doesNotMatch(s.all, /leído del disco/, 'con el clon al día se lee lo publicado, sin nota');
});

// ── 2 · una pieza muerta cambia sólo su línea ─────────────────────────────────────────────────────────────────────────
test('T85 DeadPiece_ChangesOnlyItsLine_AndSaysNotRunning', () => {
  const at = Date.now() - HOUR;
  const old = Date.now() - 6 * DAY;
  const healthy = perNightly(startup(machine({ published: night(at) })));
  const cases = {
    dependencias: { files: night(at, { [depsFile(at)]: null, [depsFile(old)]: night(old)[depsFile(old)] }), says: /NO ESTÁ CORRIENDO/ },
    vigilante: { files: night(at, { [vigFile(at)]: null, [vigFile(old)]: night(old)[vigFile(old)] }), says: /no dejó snapshot desde/ },
    banco: { files: night(at, { [BANCO]: night(old)[BANCO] }), says: /NO ESTÁ CORRIENDO/ },
    suites: { files: night(at, { [SUITES]: night(old)[SUITES] }), says: /NO ESTÁN CORRIENDO/ },
    tablero: { files: night(at, { [TABLERO]: night(old)[TABLERO] }), says: /NO SE ESTÁ GENERANDO/ },
  };
  for (const [dead, c] of Object.entries(cases)) {
    const s = startup(machine({ published: c.files, fetched: 60 * 1000 }));   // la copia se trajo recién: la noche se ve entera
    const n = perNightly(s);
    assert.match(n[dead], c.says, `${dead} muerto no lo dice:\n${s.all}`);
    assert.doesNotMatch(n[dead], /^✅/, `${dead} muerto sale en verde`);
    for (const other of Object.keys(NIGHTLIES)) if (other !== dead) assert.strictEqual(n[other], healthy[other], `${dead} muerto cambió la línea de ${other}`);
  }
});

// ── 3 · sin foto y foto ilegible, cada una con su texto ───────────────────────────────────────────────────────────────
test('T85 NoPhoto_AndUnreadablePhoto_AreSaid_EachWithItsOwnText', () => {
  const at = Date.now() - HOUR;
  const none = startup(machine({ published: { 'README.md': 'sin datos\n' } }));
  const n = perNightly(none);
  for (const k of ['dependencias', 'vigilante', 'banco', 'suites']) assert.match(n[k], /^🔴 .*no hay ninguna foto/, `${k} sin foto calla o dice otra cosa:\n${none.all}`);
  assert.match(n.tablero, /no está publicado/, none.all);
  assert.strictEqual(none.lines.length, 5, none.all);

  const broken = startup(machine({ published: night(at, { [BANCO]: '{', [SUITES]: 'esto no es JSON', [depsFile(at)]: 'null', [vigFile(at)]: '[' }) }));
  const b = perNightly(broken);
  for (const k of ['dependencias', 'vigilante', 'banco', 'suites']) {
    assert.match(b[k], /^🔴 /, `${k} con la foto rota no sale en rojo:\n${broken.all}`);
    assert.match(b[k], /ILEGIBLE|no se puede leer/, `${k} con la foto rota no dice que no se lee:\n${broken.all}`);
    assert.doesNotMatch(b[k], /no hay ninguna foto/, `${k}: «está y no se lee» se confunde con «no está»`);
  }
});

// ── 4 · de cuándo es la copia: los tres pares ─────────────────────────────────────────────────────────────────────────
test('T85 CopyAge_StalePhotoWithOldCopyIsUnknown_FreshCopyIsNotRunning_FreshPhotoIsItsState', () => {
  const old = Date.now() - 6 * DAY;
  const stale = night(old);
  // foto vencida, y el clon no se trae desde ANTES de que venciera: no se sabe si hubo otra noche
  const before = day(Date.now() - 5 * DAY);
  const unknown = startup(machine({ published: stale, fetched: 5 * DAY }));
  const u = perNightly(unknown);
  const copyDays = [before, day(Date.now() - 5 * DAY)];   // los dos, por si la medianoche UTC cae mientras se arma la máquina
  for (const k of Object.keys(NIGHTLIES)) {
    assert.match(u[k], /^🟠 .*no sé si/, `${k}: foto vencida con la copia vieja no dice «no sé»:\n${unknown.all}`);
    assert.ok(copyDays.some((d) => u[k].includes(d)), `${k}: no dice de cuándo es la copia (${copyDays.join(' o ')}):\n${u[k]}`);
    assert.doesNotMatch(u[k], /NO EST[ÁA]N? CORRIENDO|NO SE ESTÁ GENERANDO|no dejó snapshot/, `${k}: acusa al nocturno con una copia vieja`);
  }
  assert.match(unknown.deps, /git -C .* fetch origin/, 'no dice cómo traer la copia');
  assert.strictEqual((unknown.all.match(/fetch origin/g) || []).length, 1, 'el comando para traerla se dice una sola vez');

  // la misma foto vencida con la copia traída recién: ahí sí, el nocturno no corrió
  const dead = perNightly(startup(machine({ published: stale, fetched: 60 * 1000 })));
  for (const k of Object.keys(NIGHTLIES)) {
    assert.match(dead[k], /NO EST[ÁA]N? CORRIENDO|NO SE ESTÁ GENERANDO|no dejó snapshot/, `${k}: con la copia al día no acusa al nocturno:\n${dead[k]}`);
    assert.doesNotMatch(dead[k], /no sé si/);
  }
  // la última traída falló, o nunca hubo una: tampoco se sabe
  for (const fetched of ['failed', null]) {
    const f = perNightly(startup(machine({ published: stale, fetched })));
    for (const k of Object.keys(NIGHTLIES)) assert.match(f[k], /^🟠 .*no sé si/, `${k} con la traída ${fetched}: ${f[k]}`);
  }
  // 🔴 y una traída de OTRA rama (o de la referencia de un pedido) recién hecha no trajo la rama principal: `git fetch
  // origin <rama>` reescribe FETCH_HEAD con fecha de hoy y no mueve origin/main. Contada, los cinco acusaban al nocturno.
  for (const fetchedBranch of ['story/otra', 'refs/pull/7/merge']) {
    const o = startup(machine({ published: stale, fetched: 60 * 1000, fetchedBranch }));
    for (const [k, l] of Object.entries(perNightly(o))) {
      assert.match(l, /^🟠 .*no sé si/, `${k}: una traída de ${fetchedBranch} se contó como si hubiera traído la rama principal:\n${o.all}`);
      assert.doesNotMatch(l, /NO EST[ÁA]N? CORRIENDO|NO SE ESTÁ GENERANDO|no dejó snapshot/);
    }
  }
  // de verdad, con git: el remoto tiene la noche de hoy, el clon trae SÓLO otra rama → «no sé»; trae todo → cinco ✅
  {
    const lab = machine({ published: stale, fetched: null });
    const origin = path.join(lab.base, 'remotos', 'mantenimiento');
    for (const [rel, text] of Object.entries(night(Date.now() - HOUR))) write(path.join(origin, ...rel.split('/')), text);
    git(lab, origin, ['add', '-A', '-f']); git(lab, origin, ['commit', '-qm', 'la noche de hoy']);
    git(lab, origin, ['branch', 'otra']);
    git(lab, lab.priv, ['fetch', '-q', 'origin', 'otra']);
    for (const [k, l] of Object.entries(perNightly(startup(lab)))) assert.match(l, /^🟠 .*no sé si/, `${k} tras «git fetch origin otra»: ${l}`);
    git(lab, lab.priv, ['fetch', '-q', 'origin']);
    const all = startup(lab);
    for (const [k, l] of Object.entries(perNightly(all))) assert.match(l, /^✅/, `${k} tras «git fetch origin»: ${l}\n${all.all}`);
  }
  // 🔴 el comando para traerla no depende de que dependencias o el vigilante estén vencidos: el banco, las suites y el
  // tablero vencen un día antes. Fotos de hace 2,2 días y copia de hace 2,1: tres «no sé», dos ✅, y el comando igual
  {
    const at = Date.now() - 2.2 * DAY;
    const w = startup(machine({ published: night(at), fetched: 2.1 * DAY }));
    const n = perNightly(w);
    for (const k of ['banco', 'suites', 'tablero']) assert.match(n[k], /^🟠 .*no sé si/, `${k}: ${n[k]}`);
    for (const k of ['dependencias', 'vigilante']) assert.match(n[k], /^✅/, `${k}: ${n[k]}`);
    assert.strictEqual((w.all.match(/fetch origin/g) || []).length, 1, `tres «no sé» y nadie dice cómo traer la copia:\n${w.all}`);
  }
  // y con todo al día, nadie lo dice
  assert.doesNotMatch(startup(machine({})).all, /fetch origin/);
  // copia vieja y foto fresca: se dice el estado, con la fecha de la foto
  const at = Date.now() - HOUR;
  const fresh = startup(machine({ published: night(at), fetched: 5 * DAY }));
  for (const [k, l] of Object.entries(perNightly(fresh))) { assert.match(l, /^✅/, `${k}: ${l}`); assert.ok(l.includes(day(at)), `${k} no lleva la fecha de su foto`); }
});

// ── 5 · se lee lo publicado, no el disco del clon ─────────────────────────────────────────────────────────────────────
test('T85 ReadsWhatIsPublished_NotTheWorkingTreeOfTheClone', () => {
  const at = Date.now() - HOUR;
  const files = night(at);
  const s = startup(machine({
    published: files,
    disk: {   // el clon quedó en otra rama, con todo pisado o borrado
      [BANCO]: edit(files, BANCO, (j) => { j.failed = 9; }), [SUITES]: edit(files, SUITES, (j) => { j.failures = ['a.test.js']; }),
      [depsFile(at)]: null, [vigFile(at)]: null, [TABLERO]: '<html>sin sello</html>',
    },
  }));
  for (const [k, l] of Object.entries(perNightly(s))) assert.match(l, /^✅/, `${k} leyó el disco del clon y no lo publicado:\n${s.all}`);
});

// ── 6 y 7 · sin clon de mantenimiento declarado, o con uno que no sirve ───────────────────────────────────────────────
test('T85 MaintainerWithoutMaintainersClone_OrWithOneThatIsNotOne_OneLineWithTheCommand', () => {
  const said = (lab, why) => {
    const s = startup(lab);
    assert.strictEqual(s.lines.length, 1, `tiene que ser UNA línea por arranque:\n${s.all}`);
    assert.match(s.deps, why, s.all);
    assert.match(s.deps, /harness\.js config set paths\.maintainers /, 'no dice el comando');
    assert.strictEqual(s.bench + s.board, '', 'los otros dos avisos repiten el problema');
  };
  said(machine({ config: 'maintained' }), /no declara el de mantenimiento/);
  // una carpeta que no es un clon
  const folder = machine({ config: (lab) => { const d = path.join(lab.base, 'una-carpeta'); fs.mkdirSync(d); return { maintained: lab.pub, maintainers: d }; } });
  said(folder, /no es (la raíz de )?un clon/);
  assert.ok(!fs.existsSync(path.join(folder.base, 'una-carpeta', '.dashboard')), 'se escribió en una carpeta que no es el clon de mantenimiento');
  // el clon del público declarado por error como el de mantenimiento (los dos clones de quien mantiene se cruzan fácil).
  // Se reconoce por su remoto: el del clon de juguete se arma con la identidad pública que este árbol declara, sin
  // escribirla acá (nunca se le pide nada a ese remoto)
  const publicId = require(path.join(ROOT, 'scripts', 'lib', 'harness-repo.js')).declaradas().publicas[0];
  assert.ok(publicId, 'este árbol no declara cuál es el repo público: no se puede medir el clon cruzado');
  const crossed = machine({ config: (lab) => ({ maintained: lab.pub, maintainers: lab.pub }) });   // sin remoto: se reconoce por la carpeta
  said(crossed, /mismo clon que paths\.maintained/);
  const otherPublic = machine({ config: (lab) => {   // otra carpeta, con el remoto del público: se reconoce por el remoto
    const d = path.join(lab.base, 'clones', 'otro-publico');
    write(path.join(d, 'README.md'), 'x\n');
    git(lab, d, ['init', '-q', '.']); git(lab, d, ['add', '-A']); git(lab, d, ['commit', '-qm', 'v1']);
    git(lab, d, ['remote', 'add', 'origin', `https://${publicId.host}/${publicId.ruta}.git`]);
    return { maintained: lab.pub, maintainers: d };
  } });
  said(otherPublic, /clon del repo público/);
  assert.ok(!fs.existsSync(path.join(otherPublic.base, 'clones', 'otro-publico', '.dashboard')));
  // …y lo que escribe la máquina no cae ahí
  const where = spawnSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'night-data.js'))}).machineDashboardDir(${JSON.stringify(ROOT)})))`], { encoding: 'utf8', env: labEnv(crossed) });
  assert.strictEqual(where.status, 0, where.stderr);
  assert.strictEqual(where.stdout, path.join(crossed.tycon, 'state', 'dashboard'), 'con un clon que no sirve, lo de la máquina va a la carpeta del estado');
});

// ── 8 · quien no mantiene el arnés, o tiene los nocturnos apagados, no ve nada nuevo ──────────────────────────────────
test('T85 MachineThatDoesNotMaintain_OrNightliesOff_SeesNothing', () => {
  assert.strictEqual(startup(machine({ config: 'none' })).all, '', 'una máquina que no mantiene el arnés vio algo');
  assert.strictEqual(startup(machine({}), { TYCON_NIGHTLY: '0' }).all, '', 'con los nocturnos apagados vio algo');
});

// ── 9 · desde un clon: lo mismo de siempre ────────────────────────────────────────────────────────────────────────────
/** Un árbol que corre desde un clon (no es una versión bajada): los avisos y sus bibliotecas, con sus propios datos. */
function ownClone(lab, files) {
  const tree = path.join(lab.base, 'clon-propio');
  for (const d of ['scripts/hooks', 'scripts/lib', 'scripts/setup/harness', 'scripts/nightly/dashboard']) fs.cpSync(path.join(ROOT, ...d.split('/')), path.join(tree, ...d.split('/')), { recursive: true });
  fs.mkdirSync(path.join(tree, 'scripts', 'controls-bench'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts', 'controls-bench'))) if (/\.js$/.test(f)) fs.copyFileSync(path.join(ROOT, 'scripts', 'controls-bench', f), path.join(tree, 'scripts', 'controls-bench', f));
  write(path.join(tree, 'scripts', 'controls-bench', 'exam-config.json'), JSON.stringify({ designated_machine: '' }));
  for (const [rel, text] of Object.entries(files)) write(path.join(tree, ...rel.split('/')), text);
  git(lab, tree, ['init', '-q', '.']); git(lab, tree, ['add', '-A', '-f']); git(lab, tree, ['commit', '-qm', 'v1']);
  git(lab, tree, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return tree;
}
test('T85 RunningFromAClone_SameOutputAsBefore_ByteForByte', () => {
  const at = Date.now() - HOUR;
  const d = day(at);
  // máquina sana: dependencias y el tablero hablan,
  // el vigilante que entregó calla, el banco y las suites frescos y limpios callan
  const lab = machine({ release: false, config: 'none' });
  const s = startup(lab, { TYCON_EXAM_CONFIG: undefined, TYCON_BENCH_DIR: undefined }, ownClone(lab, night(at)));
  assert.strictEqual(s.deps, `✅ dependencias (${d}): miró y no hay nada esperando decisión. · resumen entregado (Telegram)\n`);
  assert.strictEqual(s.bench, '');
  assert.strictEqual(s.board, `✅ tablero del arnés (${d} ${iso(at).slice(11, 16)} UTC): completo · artifacts/tablero-del-arnes.html\n`);
  // sin ningún dato (alguien de afuera que clonó el público): silencio, salvo el tablero, que dice que no está
  const empty = machine({ release: false, config: 'none' });
  const e = startup(empty, { TYCON_EXAM_CONFIG: undefined, TYCON_BENCH_DIR: undefined }, ownClone(empty, { 'README.md': 'x\n' }));
  assert.strictEqual(e.deps + e.bench, '');
  assert.match(e.board, /^🔕 el tablero del arnés no está publicado/);
  // y una foto vencida se sigue acusando como siempre, sin «no sé»: en un clon propio no hay otra copia que traer
  const old = Date.now() - 6 * DAY;
  const stale = machine({ release: false, config: 'none' });
  const st = startup(stale, { TYCON_EXAM_CONFIG: undefined, TYCON_BENCH_DIR: undefined }, ownClone(stale, night(old)));
  assert.match(st.deps, /NO ESTÁ CORRIENDO/); assert.match(st.bench, /NO ESTÁ CORRIENDO/); assert.match(st.board, /NO SE ESTÁ GENERANDO/);
  assert.doesNotMatch(st.all, /no sé si/);
});

// ── 10 · ningún ✅ con la noche incompleta ────────────────────────────────────────────────────────────────────────────
test('T85 NoGreenLine_WithAnIncompleteNight', () => {
  const at = Date.now() - HOUR;
  const base = night(at);
  const cases = [
    ['vigilante', vigFile(at), (j) => { delete j.resumen; }],
    ['vigilante', vigFile(at), (j) => { j.resumen = { canal: 'telegram', message_id: null, entregado_el: null, motivo: 'sin red' }; }],
    ['banco', BANCO, (j) => { j.ran = 0; }],
    ['banco', BANCO, (j) => { delete j.ran; }],
    ['banco', BANCO, (j) => { j.nomedido = 2; }],
    ['suites', SUITES, (j) => { j.ran = []; j.corridas = 0; }],
    ['suites', SUITES, (j) => { j.disappeared = ['b.test.sh']; }],
    ['suites', SUITES, (j) => { j.failures = ['a.test.js']; }],
    ['dependencias', depsFile(at), (j) => { j.corrida_completa = false; }],
  ];
  for (const [who, file, fn] of cases) {
    const s = startup(machine({ published: { ...base, [file]: edit(base, file, fn) } }));
    const l = perNightly(s)[who];
    assert.ok(l, `${who} calló con la noche incompleta (${fn}):\n${s.all}`);
    assert.doesNotMatch(l, /^✅/, `${who} dice ✅ con la noche incompleta (${fn}): ${l}`);
  }
});

// ── 11 · lo que escribe la máquina cae en su carpeta de estado, nunca en un clon ──────────────────────────────────
test('T85 MachineWrites_LandInTheStateDir_NeverInAClone', () => {
  const lab = machine({});
  const state = path.join(lab.tycon, 'state', 'dashboard');
  const product = path.join(lab.base, 'un-producto');
  write(path.join(product, 'README.md'), 'x\n');
  git(lab, product, ['init', '-q', '.']); git(lab, product, ['add', '-A']); git(lab, product, ['commit', '-qm', 'v1']);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'metrics', 'retro-heartbeat.js'), '--repo', product, '--merge', 'HEAD'], { encoding: 'utf8', env: labEnv(lab) });
  assert.strictEqual(r.status, 0, r.stderr);
  const written = r.stdout.trim();
  assert.strictEqual(path.dirname(written), state, `el registro del merge no cayó en la carpeta de estado: ${written}`);
  assert.ok(fs.existsSync(written));
  assert.ok(!fs.existsSync(path.join(lab.pub, '.dashboard')), 'se escribió en el clon del público');
  assert.strictEqual(git(lab, lab.priv, ['status', '--porcelain']), '', 'se ensució el clon de mantenimiento');
  // y los que leen eso lo buscan en el mismo lugar
  const dirOf = (file, expr) => spawnSync(process.execPath, ['-e', `process.stdout.write(String(${expr}))`], { encoding: 'utf8', env: labEnv(lab), cwd: path.dirname(file) }).stdout;
  assert.strictEqual(dirOf(path.join(ROOT, 'scripts', 'lib', 'night-data.js'), `require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'night-data.js'))}).machineDashboardDir(${JSON.stringify(ROOT)})`), state);
  // los que LEEN esos registros los buscan ahí, corridos de verdad sin decirles dónde:
  // · la serie
  const series = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'dashboard-series.js'), '--json'], { encoding: 'utf8', env: labEnv(lab) });
  assert.strictEqual(series.status, 0, series.stderr);
  assert.strictEqual(JSON.parse(series.stdout).dir, state, 'la serie no leyó la carpeta de estado');
  // · el medidor (de dónde saca los registros; lo dice su salida)
  const read = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'metrics', 'sdlc-stage-metrics.js'), '--repo', product, '--json'], { encoding: 'utf8', env: labEnv(lab), timeout: 120000 });
  assert.strictEqual(read.status, 0, read.stderr);
  assert.strictEqual(JSON.parse(read.stdout).dashboard, state, 'el medidor no leyó los registros de la carpeta de estado');
  // · el aviso de vejez: caso aparte, más abajo. · El de retrospectivas pendientes no se deja correr sin su libro de
  //   empujes: se exige que la carpeta la pida con una LLAMADA (un comentario no alcanza)
  const code = fs.readFileSync(path.join(ROOT, 'scripts', 'hooks', 'retro-pending.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.match(code, /require\(lib\)\.machineDashboardDirs\(/,'retro-pending.js no le pide a night-data.js dónde escribe la máquina');
  // 🔴 la foto diaria del medidor NO es un dato de la máquina: es del nocturno, y vive en el clon de mantenimiento con
  // ese nombre. El medidor corrido desde la versión bajada no la escribe ahí (la pisaría, o trabaría el `pull` siguiente)…
  const meter = path.join(ROOT, 'scripts', 'metrics', 'sdlc-stage-metrics.js');
  const snap = spawnSync(process.execPath, [meter, '--repo', product, '--snapshot', '--json'], { encoding: 'utf8', env: labEnv(lab), timeout: 120000 });
  assert.strictEqual(snap.status, 0, snap.stderr);
  const stages = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^sdlc-stage-/.test(f)) : []);
  assert.deepStrictEqual(stages(path.join(lab.priv, '.dashboard')), [], 'el medidor escribió su foto diaria en el clon de mantenimiento');
  // …salvo que quien lo corre diga dónde
  const elsewhere = path.join(lab.base, 'otra-carpeta');
  const given = spawnSync(process.execPath, [meter, '--repo', product, '--snapshot', '--json', '--dashboard', elsewhere], { encoding: 'utf8', env: labEnv(lab), timeout: 120000 });
  assert.strictEqual(given.status, 0, given.stderr);
  assert.strictEqual(stages(elsewhere).length, 1, 'con --dashboard el medidor no escribió donde se le dijo');
  // sin llave del buzón: a la carpeta del estado, diciendo que no viaja
  const alone = machine({ config: 'maintained' });
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'metrics', 'retro-heartbeat.js'), '--repo', product, '--merge', 'HEAD'], { encoding: 'utf8', env: labEnv(alone) });
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(path.dirname(r2.stdout.trim()), path.join(alone.tycon, 'state', 'dashboard'));
  assert.match(r2.stderr, /no viaja/, 'no dice que el registro quedó en la máquina');
  assert.ok(!fs.existsSync(path.join(alone.pub, '.dashboard')), 'sin clon de mantenimiento se escribió en el del público');
});

// ── 12 · cada aviso copiado solo anda como hoy ────────────────────────────────────────────────────────────────────────
test('T85 EachNotice_CopiedAlone_WorksAsToday', () => {
  const at = Date.now() - HOUR;
  const files = night(at);
  const lab = machine({});   // una máquina que SÍ declara el clon: el aviso suelto no lo tiene que mirar
  const alone = path.join(lab.base, 'suelto', 'scripts', 'hooks');
  fs.mkdirSync(alone, { recursive: true });
  for (const f of ['dependencies-notice.js', 'bench-notice.js']) fs.copyFileSync(path.join(ROOT, 'scripts', 'hooks', f), path.join(alone, f));
  const data = path.join(lab.base, 'datos');
  write(path.join(data, 'dash', path.basename(depsFile(at))), files[depsFile(at)]);
  write(path.join(data, 'banco.json'), files[BANCO]); write(path.join(data, 'suites.json'), files[SUITES]);
  const tree = path.join(lab.base, 'suelto');
  const deps = hook(lab, 'dependencies-notice.js', { TYCON_DEPS_OUT: path.join(data, 'dash'), TYCON_DEPS_PENDING: path.join(data, 'pend'), TYCON_WATCHER_OUT: path.join(data, 'vig') }, tree);
  assert.strictEqual(deps.out, `✅ dependencias (${day(at)}): miró y no hay nada esperando decisión. · resumen entregado (Telegram)\n`, deps.err);
  const bench = hook(lab, 'bench-notice.js', { TYCON_BENCH_REPORT: path.join(data, 'banco.json'), TYCON_SUITES_REPORT: path.join(data, 'suites.json'), TYCON_EXAM_REPORT: path.join(data, 'no-hay.json') }, tree);
  assert.strictEqual(bench.status, 0, bench.err);
  assert.doesNotMatch(bench.out, /banco de controles nocturno|suites de prueba nocturnas/, `el aviso suelto con la foto fresca y limpia habló:\n${bench.out}`);
  // y en la máquina que declara el clon, una variable explícita sigue ganando y lee ese disco
  const explicit = hook(lab, 'bench-notice.js', { TYCON_BENCH_REPORT: path.join(data, 'no-hay.json') });
  assert.doesNotMatch(explicit.out, /banco de controles/, 'la variable explícita no ganó sobre el clon declarado');
  assert.match(explicit.out, /suites de prueba nocturnas/, 'una variable de un reporte apagó la lectura del otro');
});

// ── 13 · queda escrito quién trae el clon y cuándo ────────────────────────────────────────────────────────────────────
test('T85 TheGuide_SaysWhoBringsTheMaintainersClone_AndWhen', () => {
  const guide = fs.readFileSync(path.join(ROOT, 'guides', 'piezas-del-arnes.md'), 'utf8');
  const i = guide.indexOf('## scripts/lib/night-data.js');
  assert.ok(i >= 0, 'guides/piezas-del-arnes.md no tiene la ficha de scripts/lib/night-data.js');
  // la ficha corta y su detalle (guides/maintaining/piezas-en-detalle.md, mismo título) se leen juntos
  const cut = (txt) => { const k = txt.indexOf('## scripts/lib/night-data.js'); if (k < 0) return ''; const e = txt.indexOf('\n## ', k + 5); return txt.slice(k, e < 0 ? undefined : e); };
  const detailPath = path.join(ROOT, 'guides', 'maintaining', 'piezas-en-detalle.md');
  const section = cut(guide) + '\n' + (fs.existsSync(detailPath) ? cut(fs.readFileSync(detailPath, 'utf8')) : '');
  assert.match(section, /Quién trae ese clon/i);
  assert.match(section, /nightly-dod-notice\.sh/);
  assert.match(section, /paths\.maintainers/);
  assert.match(section, /cada noche/, 'la guía dice quién trae el clon y no dice cuándo');
  assert.match(section, /git fetch|git pull/, 'la guía no dice con qué se trae');
  // y los dos textos del arnés no aconsejan declarar `paths.maintained` «para que los avisos hablen»
  const doctor = fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'harness.js'), 'utf8');
  assert.doesNotMatch(doctor, /los avisos de los nocturnos callan/, 'doctor sigue aconsejando paths.maintained para que los avisos hablen');
  const moved = fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'harness', 'move-home.js'), 'utf8');
  assert.doesNotMatch(moved, /los avisos leen de ahí/, 'el cierre de la mudanza sigue diciendo que los avisos leen del clon que se mantiene');
  assert.match(moved, /config set paths\.maintained [^\n]*paths\.maintainers: de ahí leen los avisos de los nocturnos/, 'el cierre de la mudanza no nombra el clon de mantenimiento');
});

// ── 14 · «no pude mirar lo publicado»: se lee el disco del clon, y se dice ────────────────────────────────────────────
test('T85 PublishedCannotBeRead_ReadsTheDiskOfTheClone_AndSaysSo', () => {
  const at = Date.now() - HOUR;
  const lab = machine({ published: night(at) });
  git(lab, lab.priv, ['update-ref', '-d', 'refs/remotes/origin/main']);   // un clon al que le falta origin/main
  const s = startup(lab);
  const n = perNightly(s);
  for (const [k, l] of Object.entries(n)) assert.match(l, /^✅/, `${k}: sin lo publicado no leyó el disco del clon:\n${s.all}`);
  for (const k of ['banco', 'suites', 'tablero']) assert.match(n[k], /leído del disco.*no de lo publicado \(esta copia no tiene origin\/main\)/, `${k} leyó el disco sin decirlo`);
  assert.match(s.deps, /dependencias y vigilante: leído del disco, no de lo publicado \(esta copia no tiene origin\/main\)/, 'dependencias y vigilante leyeron el disco sin decirlo');
  // y un git que falla no es «no está»: con un git que sale con error en todo, nada dice «no hay ninguna foto»
  const bin = path.join(lab.base, 'git-roto');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  if (process.platform !== 'win32') {
    const broken = startup(machine({ published: night(at) }), { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.doesNotMatch(broken.all, /no hay ninguna foto/, `un git que falla se leyó como «no está»:\n${broken.all}`);
    // …y en positivo: los cinco leen el disco del clon y hablan, diciéndolo
    for (const [k, l] of Object.entries(perNightly(broken))) assert.match(l, /^✅/, `${k} con un git que falla no leyó el disco:\n${broken.all}`);
    assert.match(broken.all, /leído del disco/);
    // las ramas de readPublished, de a una, con un git que falla en cada paso
    const N = require(path.join(ROOT, 'scripts', 'lib', 'night-data.js'));
    const fakeGit = (name, body) => { const f = path.join(lab.base, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };
    const asked = (git) => { const r = N.readPublished(lab.priv, 'README.md', git); return [r.state, r.from, r.why]; };
    assert.deepStrictEqual(asked(fakeGit('git-sin-ref', 'exit 1')), ['ok', 'disk', 'esta copia no tiene origin/main']);
    assert.deepStrictEqual(asked(fakeGit('git-no-lista', 'case "$3" in rev-parse) exit 0 ;; *) exit 3 ;; esac')), ['ok', 'disk', 'no pude listar lo publicado']);
    assert.deepStrictEqual(asked(fakeGit('git-no-lee', 'case "$3" in rev-parse) exit 0 ;; ls-tree) echo "100644 blob abc\tREADME.md"; exit 0 ;; *) exit 3 ;; esac')), ['ok', 'disk', 'no pude leer lo publicado']);
    assert.deepStrictEqual(asked(path.join(lab.base, 'no-hay-tal-git')), ['ok', 'disk', 'no se pudo ejecutar git']);
    const gone = N.readPublished(lab.priv, 'no/esta.json', fakeGit('git-roto-2', 'exit 3'));
    assert.deepStrictEqual([gone.state, gone.from], ['missing', 'disk'], 'con git roto y el archivo ausente del disco: «no está», dicho del disco');
  }
});

// ── una cola que no se puede evaluar, en la máquina que espera los nocturnos, se dice (y no calla a la otra) ─────────
test('T85 AQueueThatCannotBeEvaluated_IsSaid_AndDoesNotSilenceTheOther', () => {
  const at = Date.now() - HOUR;
  const base = night(at);
  // una foto con forma inesperada hace tirar a la evaluación de dependencias (`no_medidos` no es una lista)
  const s = startup(machine({ published: { ...base, [depsFile(at)]: edit(base, depsFile(at), (j) => { j.no_medidos = 7; }) } }));
  const n = perNightly(s);
  assert.match(n.dependencias, /^🔴 dependencias: no pude evaluar la noche \(/, `la cola que tiró calló:\n${s.all}`);
  assert.match(n.vigilante, /^✅ vigilante\b/, 'el error de una cola calló a la otra');
  assert.strictEqual(s.lines.length, 5, s.all);
});

// ── 15 · la configuración de la máquina rota: lo dice su lector; ninguna línea de nocturno; nada al clon del público ──
test('T85 BrokenMachineConfig_IsSaidByItsReader_NoNightlyLine_NothingWrittenInThePublicClone', () => {
  const lab = machine({});
  fs.writeFileSync(path.join(lab.tycon, 'config.json'), '{ esto no es JSON');
  const s = startup(lab);
  assert.match(s.bench, /configuración del arnés está ROTA/, `la configuración rota no la dijo nadie:\n${s.all}`);
  assert.doesNotMatch(s.all, /banco de controles nocturno|suites de prueba nocturnas|✅|no hay ninguna foto/, `con la configuración rota un aviso afirmó algo de la noche:\n${s.all}`);
  assert.strictEqual(s.deps + s.board, '', 'los otros dos avisos hablaron con la configuración rota');
  const product = path.join(lab.base, 'un-producto');
  write(path.join(product, 'README.md'), 'x\n');
  git(lab, product, ['init', '-q', '.']); git(lab, product, ['add', '-A']); git(lab, product, ['commit', '-qm', 'v1']);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'metrics', 'retro-heartbeat.js'), '--repo', product, '--merge', 'HEAD'], { encoding: 'utf8', env: labEnv(lab) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(path.dirname(r.stdout.trim()), path.join(lab.tycon, 'state', 'dashboard'), 'con la configuración rota, el registro no fue a la carpeta del estado');
  assert.match(r.stderr, /no viaja/);
  assert.ok(!fs.existsSync(path.join(lab.pub, '.dashboard')), 'con la configuración rota se escribió en el clon del público');
});

// ── 16b · lo que escribe la máquina viaja si hay llave del buzón legible y no vencida ──────────────────────────────
const N_JS_ = path.join(ROOT, 'scripts', 'lib', 'night-data.js');
const askWrites = (lab, tree, env = {}) => {
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(N_JS_)}).machineDashboard(${JSON.stringify(tree)})))`], { encoding: 'utf8', env: labEnv(lab, env) });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('T6 NightData_Travels_ByKey @story-8.132 @ac-3: viaja con la llave vigente; vencida, ilegible o ausente, no, y dice por qué', () => {
  const lab = machine({});
  const state = path.join(lab.tycon, 'state', 'dashboard');
  const vigente = { cuenta: 'cuentaprueba', contenedor: 'corridas', sas: 'si=p&sig=x', vence: '2099-01-01' };
  for (const [caso, body, viaja, motivo] of [
    ['vigente', vigente, true, null],
    ['vencida', { ...vigente, vence: '2020-01-01' }, false, /venció el 2020-01-01/],
    ['ilegible', '{ no es JSON', false, /no es JSON válido/],
    ['ausente', null, false, /falta la llave del buzón/],
  ]) {
    const f = path.join(lab.base, 'llaves', `${caso}.json`);
    if (body !== null) write(f, typeof body === 'string' ? body : JSON.stringify(body));
    const w = askWrites(lab, ROOT, { TYCON_MAILBOX_JSON: f });
    assert.strictEqual(w.dir, state, `llave ${caso}: siempre la carpeta de estado`);
    assert.strictEqual(w.travels, viaja, `llave ${caso}`);
    if (motivo) assert.match(w.why, motivo, `llave ${caso}`); else assert.strictEqual(w.why, null);
  }
});

test('T5 NightData_BrokenLib_Refuses @story-8.132 @ac-3: con tycon-home.js que tira, no hay carpeta y el latido no escribe', () => {
  const lab = machine({});
  const broken = path.join(lab.base, 'arbol-roto');
  for (const d of ['scripts/lib', 'scripts/metrics', 'scripts/setup/harness']) fs.mkdirSync(path.join(broken, ...d.split('/')), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts', 'lib'))) { const from = path.join(ROOT, 'scripts', 'lib', f); if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(broken, 'scripts', 'lib', f)); }
  fs.copyFileSync(path.join(ROOT, 'scripts', 'metrics', 'retro-heartbeat.js'), path.join(broken, 'scripts', 'metrics', 'retro-heartbeat.js'));
  fs.writeFileSync(path.join(broken, 'scripts', 'setup', 'harness', 'tycon-home.js'), "throw new Error('roto a propósito');\n");
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(broken, 'scripts', 'lib', 'night-data.js'))}).machineDashboard(${JSON.stringify(broken)})))`], { encoding: 'utf8', env: labEnv(lab) });
  const w = JSON.parse(r.stdout);
  assert.deepStrictEqual([w.dir, w.travels], [null, false]);
  assert.match(w.why, /no pude saber dónde escribe.*roto a propósito/);
  const repo = path.join(lab.base, 'un-repo');
  write(path.join(repo, 'README.md'), 'x\n');
  git(lab, repo, ['init', '-q', '.']); git(lab, repo, ['add', '-A']); git(lab, repo, ['commit', '-qm', 'v1']);
  const beat = spawnSync(process.execPath, [path.join(broken, 'scripts', 'metrics', 'retro-heartbeat.js'), '--repo', repo, '--merge', 'HEAD'], { encoding: 'utf8', env: labEnv(lab) });
  assert.notStrictEqual(beat.status, 0, 'con la biblioteca rota el latido salió 0');
  assert.strictEqual(beat.stdout, '', 'dijo haber escrito un archivo');
  assert.match(beat.stderr, /roto a propósito|no se escribió nada/, 'no dice por qué no escribió');
  const merges = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^metrics-.*\.json$/.test(f)) : []);
  for (const d of [path.join(lab.tycon, 'state', 'dashboard'), path.join(broken, '.dashboard'), path.join(lab.priv, '.dashboard'), path.join(lab.pub, '.dashboard')]) {
    assert.deepStrictEqual(merges(d), [], `sin poder saber dónde, escribió igual en ${d}`);
  }
});

// ── 16 · las funciones de night-data.js, de a una ─────────────────────────────────────────────────────────────────────
test('T85 NightData_EachFunction_AnsweredDirectly', () => {
  const N_JS = path.join(ROOT, 'scripts', 'lib', 'night-data.js');
  const J = JSON.stringify;
  const ask = (lab, expr, env = {}) => {
    const r = spawnSync(process.execPath, ['-e', `const N=require(${J(N_JS)});const v=(${expr});process.stdout.write(JSON.stringify(v===undefined?null:v))`], { encoding: 'utf8', env: labEnv(lab, env) });
    assert.strictEqual(r.status, 0, `${expr}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const tree = path.join(os.tmpdir(), 'un-arbol-cualquiera');
  const resolveIt = `N.resolve(${J(tree)})`;
  const writes = `N.machineDashboard(${J(tree)})`;
  // la tabla de resolve y la de machineDashboard, fila por fila
  // dónde escribe la máquina: siempre su carpeta de estado, en un clon y en una versión
  // bajada, con o sin clon de mantenimiento; `travels` lo decide la llave del buzón (T6 NightData_Travels_ByKey)
  const both = machine({});
  // la carpeta de estado de tycon-home.js: en una versión bajada, ~/.tycon/state; corriendo desde un clon, la de siempre
  const stateOf = (lab) => (fs.existsSync(path.join(lab.tycon, 'state', 'harness-state.json')) ? path.join(lab.tycon, 'state', 'dashboard') : path.join(lab.home, '.claude', '.tycon-pipeline', 'dashboard'));
  const key = (lab, body, name = 'corridas-buzon.json') => { const f = path.join(lab.base, 'llaves', name); if (body !== null) write(f, typeof body === 'string' ? body : JSON.stringify(body)); return { TYCON_MAILBOX_JSON: f }; };
  const vigente = { cuenta: 'cuentaprueba', contenedor: 'corridas', sas: 'si=p&sig=x', vence: '2099-01-01' };
  assert.deepStrictEqual(ask(both, resolveIt), { dir: both.priv, source: 'maintainers', problem: null });
  // `history`: dónde quedó lo de antes (el .dashboard del clon de mantenimiento declarado; desde un clon, el suyo)
  const histBoth = path.join(both.priv, '.dashboard');
  assert.deepStrictEqual(ask(both, writes, key(both, vigente)), { dir: stateOf(both), history: histBoth, travels: true, why: null }, 'con llave vigente: la carpeta de estado, y viaja');
  assert.deepStrictEqual(ask(both, resolveIt, { TYCON_NIGHTLY: '0' }), { dir: null, source: null, problem: null }, 'con los nocturnos apagados no se lee de ningún lado');
  assert.deepStrictEqual(ask(both, writes, { TYCON_NIGHTLY: '0', ...key(both, vigente) }), { dir: stateOf(both), history: histBoth, travels: true, why: null }, 'dónde escribe la máquina no depende de la llave de los nocturnos');
  const clone = machine({ release: false, config: 'none' });
  assert.deepStrictEqual(ask(clone, resolveIt), { dir: tree, source: 'own', problem: null });
  assert.deepStrictEqual(ask(clone, writes, key(clone, vigente)), { dir: stateOf(clone), history: path.join(tree, '.dashboard'), travels: true, why: null }, 'desde un clon, la máquina también escribe en su carpeta de estado');
  assert.strictEqual(ask(clone, `N.machineDashboardDir(${J(tree)})`), stateOf(clone));
  const only = machine({ config: 'maintained' });
  const r1 = ask(only, resolveIt);
  assert.deepStrictEqual([r1.dir, r1.source], [null, null]);
  assert.match(r1.problem, /paths\.maintained.*no declara el de mantenimiento \(paths\.maintainers\)/);
  const w1 = ask(only, writes);
  assert.deepStrictEqual([w1.dir, w1.travels], [stateOf(only), false]);
  assert.match(w1.why, /falta la llave del buzón/);
  const nobody = machine({ config: 'none' });
  assert.deepStrictEqual(ask(nobody, resolveIt), { dir: null, source: null, problem: null });
  assert.deepStrictEqual(ask(nobody, writes).dir, stateOf(nobody));
  const gone = machine({ config: (lab) => ({ maintained: lab.pub, maintainers: path.join(lab.base, 'no-esta') }) });
  const r2 = ask(gone, resolveIt);
  assert.deepStrictEqual([r2.dir, r2.source], [null, 'maintainers']);
  assert.match(r2.problem, /carpeta que no está/);
  // 🔴 «no pude saber» no se devuelve con la forma de «no mantiene el arnés»: un tycon-home.js que tira deja `problem`
  const brokenTree = path.join(both.base, 'arbol-roto');
  fs.mkdirSync(path.join(brokenTree, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(brokenTree, 'scripts', 'setup', 'harness'), { recursive: true });
  fs.copyFileSync(N_JS, path.join(brokenTree, 'scripts', 'lib', 'night-data.js'));
  fs.writeFileSync(path.join(brokenTree, 'scripts', 'setup', 'harness', 'tycon-home.js'), "throw new Error('roto a propósito');\n");
  const askBroken = (expr) => {
    const r = spawnSync(process.execPath, ['-e', `const N=require(${J(path.join(brokenTree, 'scripts', 'lib', 'night-data.js'))});process.stdout.write(JSON.stringify(${expr}))`], { encoding: 'utf8', env: labEnv(both) });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const failed = askBroken(resolveIt);
  assert.strictEqual(failed.dir, null);
  assert.match(failed.problem, /no pude saber de qué clon.*roto a propósito/);
  const failedWrite = askBroken(writes);
  assert.deepStrictEqual([failedWrite.dir, failedWrite.travels], [null, false], 'sin poder saber, no se devuelve una carpeta donde escribir');
  assert.match(failedWrite.why, /no pude saber dónde escribe/);
  // …y el registro de un merge, sin poder saber dónde va, NO se escribe en ningún lado y lo dice (no vuelve callado al
  // clon del público, que en una versión bajada no es donde se escribe)
  fs.mkdirSync(path.join(brokenTree, 'scripts', 'metrics'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts', 'lib'))) { const from = path.join(ROOT, 'scripts', 'lib', f); if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(brokenTree, 'scripts', 'lib', f)); }
  fs.copyFileSync(path.join(ROOT, 'scripts', 'metrics', 'retro-heartbeat.js'), path.join(brokenTree, 'scripts', 'metrics', 'retro-heartbeat.js'));
  const someRepo = path.join(both.base, 'otro-producto');
  write(path.join(someRepo, 'README.md'), 'x\n');
  git(both, someRepo, ['init', '-q', '.']); git(both, someRepo, ['add', '-A']); git(both, someRepo, ['commit', '-qm', 'v1']);
  const beat = spawnSync(process.execPath, [path.join(brokenTree, 'scripts', 'metrics', 'retro-heartbeat.js'), '--repo', someRepo, '--merge', 'HEAD'], { encoding: 'utf8', env: labEnv(both) });
  assert.notStrictEqual(beat.status, 0, `con la biblioteca rota el registro del merge salió 0: ${beat.stdout}`);
  assert.strictEqual(beat.stdout, '', 'dijo haber escrito un archivo');
  assert.ok(!fs.existsSync(path.join(both.pub, '.dashboard')) && !fs.existsSync(path.join(brokenTree, '.dashboard')), 'sin poder saber dónde, escribió igual');
  // unfit
  assert.strictEqual(ask(both, `N.unfit(${J(both.priv)})`), null);
  assert.match(ask(both, `N.unfit(${J(both.home)})`), /no es la raíz de un clon de git/);
  // copyAfter: el texto según lo que consta de la última traída
  assert.strictEqual(ask(both, `N.copyAfter(${J(both.priv)}, Date.now() - ${HOUR})`), null, 'traída hace un minuto: es posterior a hace una hora');
  assert.match(ask(both, `N.copyAfter(${J(both.priv)}, Date.now() + ${HOUR})`), /^la copia del clon de mantenimiento es del \d{4}-\d{2}-\d{2}$/);
  const failedFetch = machine({ fetched: 'failed' });
  assert.match(ask(failedFetch, `N.copyAfter(${J(failedFetch.priv)}, 0)`), /la última traída .* falló/);
  const never = machine({ fetched: null });
  assert.match(ask(never, `N.copyAfter(${J(never.priv)}, 0)`), /no consta ninguna traída/);
  // 🔴 la traída de la rama principal cuenta aunque git anote la dirección del remoto de otro modo que la configuración
  // (reescrita por `insteadOf`, con `file://`, con `.git`): comparada letra por letra, no se contaría nunca. Sólo se
  // descarta la que es, con certeza, de OTRO remoto del clon.
  const rewritten = machine({});
  const fh = path.join(rewritten.priv, '.git', 'FETCH_HEAD');
  const stamp = fs.statSync(fh).mtime;
  fs.writeFileSync(fh, `0000000000000000000000000000000000000000\t\tbranch 'main' of file://otro-modo-de-escribirlo/Mantenimiento.git\n`);
  fs.utimesSync(fh, stamp, stamp);
  assert.strictEqual(ask(rewritten, `N.copyAfter(${J(rewritten.priv)}, Date.now() - ${HOUR})`), null, 'una traída de la rama principal con la dirección escrita de otro modo no se contó');
  git(rewritten, rewritten.priv, ['remote', 'add', 'otro', 'https://example.invalid/otro/repo.git']);
  fs.writeFileSync(fh, `0000000000000000000000000000000000000000\t\tbranch 'main' of https://example.invalid/otro/repo\n`);
  fs.utimesSync(fh, stamp, stamp);
  assert.match(ask(rewritten, `N.copyAfter(${J(rewritten.priv)}, Date.now() - ${HOUR})`), /no consta ninguna traída/, 'la traída de OTRO remoto se contó como si hubiera traído la rama principal de origin');
  // copyOlderThan: sólo con una traída que consta
  assert.strictEqual(ask(both, `N.copyOlderThan(${J(both.priv)}, ${HOUR})`), false, 'traída hace un minuto: no tiene más de una hora');
  assert.strictEqual(ask(both, `N.copyOlderThan(${J(both.priv)}, 1000)`), true);
  assert.strictEqual(ask(never, `N.copyOlderThan(${J(never.priv)}, 1000)`), false, 'sin traída que conste no se afirma que es vieja');
  // una traída fechada en el futuro no dice cuándo fue: «no pude leer», no «se trajo recién»
  const ahead = machine({});
  const aheadHead = path.join(ahead.priv, '.git', 'FETCH_HEAD');
  const later = new Date(Date.now() + 3 * DAY);
  fs.utimesSync(aheadHead, later, later);
  assert.match(ask(ahead, `N.copyAfter(${J(ahead.priv)}, Date.now() - ${HOUR})`), /no pude leer cuándo se trajo/);
  // un árbol enlazado del clon (su `.git` es un archivo): la traída hecha en el clon principal cuenta también ahí
  const linked = machine({ fetched: 5 * DAY });
  const tree2 = path.join(linked.base, 'clones', 'enlazado');
  git(linked, linked.priv, ['worktree', 'add', '-q', '--detach', tree2]);
  assert.ok(fs.statSync(path.join(tree2, '.git')).isFile());
  assert.match(ask(linked, `N.copyAfter(${J(tree2)}, Date.now() - ${HOUR})`), /la copia del clon de mantenimiento es del \d{4}-/, 'desde un árbol enlazado no se vio la traída del clon');
  assert.strictEqual(ask(linked, `N.copyAfter(${J(tree2)}, Date.now() - ${10 * DAY})`), null);
  // readPublished: está, no está, y un archivo que sólo vive en el disco no se lee como publicado
  assert.deepStrictEqual(ask(both, `(({state,from,text})=>({state,from,text}))(N.readPublished(${J(both.priv)}, 'README.md'))`), { state: 'ok', from: 'published', text: 'el repo de mantenimiento de juguete\n' });
  assert.deepStrictEqual(ask(both, `(({state,from})=>({state,from}))(N.readPublished(${J(both.priv)}, 'no/esta.json'))`), { state: 'missing', from: 'published' });
  fs.writeFileSync(path.join(both.priv, 'solo-en-disco.json'), '{}');
  assert.deepStrictEqual(ask(both, `(({state,from})=>({state,from}))(N.readPublished(${J(both.priv)}, 'solo-en-disco.json'))`), { state: 'missing', from: 'published' });
  // los textos que van a la pantalla: una línea, sin caracteres de control; la ruta del comando, entre comillas
  const ugly = `motivo\u0007 con\ncorte y \u001b[31mcolor`;
  const said = ask(both, `N.problemLine(${J(ugly)})`);
  assert.doesNotMatch(said, /[\u0000-\u001f\u007f]/, 'problemLine deja pasar caracteres de control');
  assert.match(said, /harness\.js config set paths\.maintainers /);
  assert.strictEqual(ask(both, `N.fetchHint(${J('/una carpeta/con espacios')})`), '   Para traerla: git -C "/una carpeta/con espacios" fetch origin');
  const tricky = ask(both, `N.fetchHint(${J('/una/"carpeta" $(rara)`x`')})`);
  assert.doesNotMatch(tricky, /git -C/, 'con una ruta que no se puede citar sin riesgo no se arma un comando para pegar');
});

// ── 17 · sin ninguna foto y con la copia vieja: tampoco se sabe ───────────────────────────────────────────────────────
test('T85 NoPhoto_WithAnOldCopy_IsUnknown_NotMissing', () => {
  for (const fetched of [5 * DAY, 'failed', null]) {
    const s = startup(machine({ published: { 'README.md': 'sin datos\n' }, fetched }));
    for (const [k, l] of Object.entries(perNightly(s))) {
      assert.match(l, /^🟠 .*no sé si/, `${k} sin foto y con la copia ${fetched}: ${l || '(calló)'}`);
      assert.doesNotMatch(l, /^🔴|no está publicado \(/, `${k} afirmó que no hay foto con una copia que no se trae`);
    }
    assert.strictEqual((s.all.match(/fetch origin/g) || []).length, 1, 'el comando para traerla se dice una sola vez');
  }
});

// ── 18 · el problema se dice aunque el aviso de dependencias esté apagado ─────────────────────────────────────────────
test('T85 TheProblem_IsSaid_EvenWithTheDependenciesNoticeSwitchedOff', () => {
  const s = startup(machine({ config: 'maintained' }), { TYCON_DEPS_NOTICE: '0' });
  assert.strictEqual(s.deps, '');
  assert.match(s.bench, /no declara el de mantenimiento.*harness\.js config set paths\.maintainers /, `con el aviso de dependencias apagado nadie dijo el problema:\n${s.all}`);
  assert.strictEqual(s.lines.length, 1, s.all);
  // prendido, lo dice él y el del banco no lo repite
  const on = startup(machine({ config: 'maintained' }));
  assert.match(on.deps, /no declara el de mantenimiento/); assert.strictEqual(on.bench, '');
});

// ── 19 · lo que sale de una foto publicada va saneado a la pantalla ───────────────────────────────────────────────────
test('T85 TextFromAPublishedPhoto_IsSanitizedBeforeTheScreen', () => {
  const at = Date.now() - HOUR;
  const base = night(at);
  const name = 'a.test.js\u001b[31m\nUNA LINEA INVENTADA';
  const s = startup(machine({ published: { ...base, [SUITES]: edit(base, SUITES, (j) => { j.failures = [name]; j.motivos = { [name]: 'motivo\u0007 con\ncorte' }; }), [BANCO]: edit(base, BANCO, (j) => { j.failed = 2; }) } }));
  assert.doesNotMatch(s.bench, /[\u0000-\u0009\u000b-\u001f\u007f]/, `un carácter de control de la foto llegó a la pantalla:\n${JSON.stringify(s.bench)}`);
  assert.strictEqual(s.bench.split('\n').filter(Boolean).length, 2, `un salto de línea de la foto partió el aviso:\n${s.bench}`);
  assert.match(s.bench, /suites de prueba nocturnas .*1 en rojo — a\.test\.js/);
  // un contador del banco que no es un número no se imprime ni se suma: la foto no se puede leer
  const text = startup(machine({ published: { ...base, [BANCO]: edit(base, BANCO, (j) => { j.failed = 'muchos\u001b[31m\nOTRA LINEA'; }) } }));
  assert.match(line(text, /banco de controles/i), /^🔴 .*contadores que no son números — no se puede leer/, text.all);
  assert.doesNotMatch(text.bench, /muchos|OTRA LINEA/);
  // y lo que dependencias y el vigilante sacan de sus fotos (el motivo de un resumen que no se entregó, el nombre de un
  // repo sin medir) llega sin caracteres de control ni renglones inventados
  const reason = { canal: 'telegram', message_id: null, entregado_el: null, motivo: 'sin red\u001b[31m\u0007 y un timbre' };
  const d = startup(machine({ published: { ...base,
    [depsFile(at)]: edit(base, depsFile(at), (j) => { j.resumen = reason; j.no_medidos = [{ ruta: 'un-repo\u001b[2J\u0007' }]; }),
    [vigFile(at)]: edit(base, vigFile(at), (j) => { j.resumen = reason; }) } }));
  assert.match(d.deps, /NO se entregó/);
  assert.doesNotMatch(d.deps, /[\u0000-\u0009\u000b-\u001f\u007f]/, `un carácter de control de la foto llegó a la pantalla:\n${JSON.stringify(d.deps)}`);
});

// ── 19b · con muchas suites rojas el aviso nombra tres y cuenta el resto: viaja en cada arranque ──────────────────────
test('T87 ManyRedSuites_NamesThreeCountsTheRest_PointsToTheDetail @story-7.53', () => {
  const at = Date.now() - HOUR;
  const base = night(at);
  const names = ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js', 'e.test.js', 'f.test.js'];
  const s = startup(machine({ published: { ...base, [SUITES]: edit(base, SUITES, (j) => {
    j.failures = names; j.motivos = Object.fromEntries(names.map((n) => [n, `✖ T1 ${'x'.repeat(130)}`]));
  }) } }));
  const l = line(s, /suites de prueba nocturnas/);
  assert.match(l, /6 en rojo — a\.test\.js \(.*\) · b\.test\.js \(.*\) · c\.test\.js \(.*\) · y 3 más/, s.all);
  assert.doesNotMatch(l, /d\.test\.js|e\.test\.js|f\.test\.js/, `nombró más de tres:\n${l}`);
  assert.match(l, /detalle: scripts\/controls-bench\/ultimo-suites\.json/, l);
  assert.ok(Buffer.byteLength(l) < 900, `la línea pesa ${Buffer.byteLength(l)} bytes:\n${l}`);
});

// ── 20 · el aviso de vejez de los registros de la máquina los busca donde se escriben, viajen o no ───────────────────
// T25 Staleness_ReadsStateDir: la carpeta de estado y la de la historia; con llave y sin llave
test('T85 StalenessOfMachineRecords_ReadsWhereTheyAreWritten (T25 Staleness_ReadsStateDir @story-8.132 @ac-17)', () => {
  const old = 'metrics-2026-01-05-un-producto-adhoc-abc1234.json';
  const withClone = machine({});
  const llave = path.join(withClone.base, 'corridas-buzon.json');
  write(llave, JSON.stringify({ cuenta: 'cuentaprueba', contenedor: 'corridas', sas: 'si=p&sig=x', vence: '2099-01-01' }));
  write(path.join(withClone.tycon, 'state', 'dashboard', old), '{}');
  const a =hook(withClone, 'retro-staleness-notice.js', { TYCON_MAILBOX_JSON: llave });
  assert.match(a.out, /retro capturer: última ejecución hace \d+ días/, `no leyó los registros de la carpeta de estado:\n${a.out}${a.err}`);
  // sin llave del buzón el latido igual alimenta la carpeta de estado: el aviso habla (callar apagaba el control en
  // toda copia sin la integración del equipo)
  const alone = machine({ config: 'maintained' });
  write(path.join(alone.tycon, 'state', 'dashboard', old), '{}');
  const sinLlave = hook(alone, 'retro-staleness-notice.js', { TYCON_MAILBOX_JSON: path.join(alone.base, 'no-hay-llave.json') });
  assert.match(sinLlave.out, /retro capturer: última ejecución hace \d+ días/, `sin llave calló:\n${sinLlave.out}${sinLlave.err}`);
  // y lo de hoy en la carpeta de la historia (el clon de mantenimiento declarado) cuenta: no avisa
  const fresh = machine({});
  write(path.join(fresh.tycon, 'state', 'dashboard', old), '{}');
  write(path.join(fresh.priv, '.dashboard', `metrics-${day(Date.now())}-un-producto-adhoc-def5678.json`), '{}');
  const alDia = hook(fresh, 'retro-staleness-notice.js', { TYCON_MAILBOX_JSON: llave });
  assert.deepStrictEqual([alDia.status, alDia.out], [0, ''], `con lo de hoy en la historia avisó:\n${alDia.out}${alDia.err}`);
  // 🔴 y «no pude saber dónde están» no es «no viajan»: con la biblioteca de rutas rota, lo dice
  const broken = path.join(withClone.base, 'arbol-roto');
  for (const d of ['scripts/hooks', 'scripts/lib', 'scripts/setup/harness']) fs.mkdirSync(path.join(broken, ...d.split('/')), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'hooks', 'retro-staleness-notice.js'), path.join(broken, 'scripts', 'hooks', 'retro-staleness-notice.js'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', 'night-data.js'), path.join(broken, 'scripts', 'lib', 'night-data.js'));
  fs.writeFileSync(path.join(broken, 'scripts', 'setup', 'harness', 'tycon-home.js'), "throw new Error('roto a propósito');\n");
  const said = hook(withClone, 'retro-staleness-notice.js', {}, broken);
  assert.match(said.out + said.err, /no pude saber dónde escribe esta máquina/, `con la biblioteca rota el aviso de vejez calló:\n${said.out}${said.err}`);
});

// ── 20b · los registros de la máquina se leen también en la historia, y «viaja» usa la vara de la subida ─────────────
test('MachineRecords_ReadAlsoTheHistory_TravelsLikeTheUpload @story-8.132 @ac-17 @ac-3', () => {
  const lab = machine({});
  const nd = path.join(ROOT, 'scripts', 'lib', 'night-data.js');
  const ask = (expr, more = {}) => {
    const r = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(${expr}))`], { encoding: 'utf8', env: labEnv(lab, more), cwd: lab.base });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  // versión bajada con clon de mantenimiento declarado: la carpeta de estado y, después, el .dashboard de ese clon
  assert.deepStrictEqual(ask(`require(${JSON.stringify(nd)}).machineDashboardDirs(${JSON.stringify(ROOT)})`),
    [path.join(lab.tycon, 'state', 'dashboard'), path.join(lab.priv, '.dashboard')]);
  // la serie cuenta lo de la historia sin que se le diga dónde
  write(path.join(lab.priv, '.dashboard', 'metrics-2026-10-20-un-producto-adhoc-c21a5f8.json'), '{"schema_version":"1.0"}');
  const series = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'dashboard-series.js'), '--json'], { encoding: 'utf8', env: labEnv(lab) });
  assert.strictEqual(series.status, 0, series.stderr);
  assert.strictEqual(JSON.parse(series.stdout).counts.total, 1, 'la serie no leyó la historia');
  // «viaja» con la misma vara que la subida: sin firma, o con un vencimiento con espacios ya pasado, no viaja
  const travels = (cfg) => {
    const k = path.join(lab.base, `llave-${Math.random().toString(36).slice(2)}.json`);
    write(k, JSON.stringify({ cuenta: 'cuentaprueba', contenedor: 'corridas', ...cfg }));
    return ask(`require(${JSON.stringify(nd)}).machineDashboard(${JSON.stringify(ROOT)})`, { TYCON_MAILBOX_JSON: k });
  };
  assert.strictEqual(travels({ sas: 'si=p&sig=x', vence: '2099-01-01' }).travels, true);
  const sinFirma = travels({ sas: 'sp=rcl&sv=2022', vence: '2099-01-01' });
  assert.deepStrictEqual([sinFirma.travels, /rechaza la llave/.test(sinFirma.why)], [false, true], JSON.stringify(sinFirma));
  for (const vence of [' 2020-01-01', '2020-01-01 ']) {
    const v = travels({ sas: 'si=p&sig=x', vence });
    assert.deepStrictEqual([v.travels, /venció/.test(v.why)], [false, true], `${JSON.stringify(vence)}: ${JSON.stringify(v)}`);
  }
  // el clon declarado ya no está: la historia no se lee, y eso se dice (no es lo mismo que no tenerla)
  fs.renameSync(lab.priv, `${lab.priv}-movido`);
  const roto = ask(`require(${JSON.stringify(nd)}).machineDashboard(${JSON.stringify(ROOT)})`);
  assert.deepStrictEqual([roto.history, /no leo la historia/.test(roto.historyWhy || '')], [null, true], JSON.stringify(roto));
  const dirs = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(nd)}).machineDashboardDirs(${JSON.stringify(ROOT)})`], { encoding: 'utf8', env: labEnv(lab), cwd: lab.base });
  assert.match(dirs.stderr, /no leo la historia/);
  fs.renameSync(`${lab.priv}-movido`, lab.priv);
});

// ── 21 · la nota «leído del disco» va en TODAS las líneas de suites y del banco, también en las rojas ────────────────
test('T85 DiskNote_IsOnEveryLine_AlsoOnTheRedOnes', () => {
  const at = Date.now() - HOUR;
  const base = night(at);
  const cases = [
    [SUITES, (j) => { j.failures = ['a.test.js']; }, /suites de prueba nocturnas .*1 en rojo/],
    [SUITES, (j) => { j.failures = ['a.test.js']; j.unmeasured = ['a.test.js']; j.motivos = { 'a.test.js': 'no medida: el trabajo 2 no terminó' }; }, /suites de prueba nocturnas .*no medidas/],
    [BANCO, (j) => { j.failed = 3; }, /banco de controles nocturno .*3 rojos/],
  ];
  for (const [file, fn, re] of cases) {
    const lab = machine({ published: { ...base, [file]: edit(base, file, fn) } });
    git(lab, lab.priv, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const s = startup(lab);
    const l = line(s, re);
    assert.ok(l, `no encontré la línea (${re}):\n${s.all}`);
    assert.match(l, /leído del disco/, `la línea roja se leyó del disco del clon y no lo dice:\n${l}`);
  }
});

// ── 22 · una foto fechada en el futuro no es verde ────────────────────────────────────────────────────────────────────
test('T85 PhotoDatedInTheFuture_IsNotGreen', () => {
  const at = Date.now() - HOUR;
  const base = night(at);
  const later = iso(Date.now() + 3 * DAY);
  const s = startup(machine({ published: { ...base, [BANCO]: edit(base, BANCO, (j) => { j.ts = later; }), [SUITES]: edit(base, SUITES, (j) => { j.ts = later; }) } }));
  const n = perNightly(s);
  for (const k of ['banco', 'suites']) { assert.match(n[k], /^🟡 .*posterior a hoy/, `${k} con la foto en el futuro: ${n[k]}`); assert.doesNotMatch(n[k], /✅/); }
});

// ── 23 · los datos de operaciones se leen del clon de operaciones ─────────────────────────────────────────────────────
// Dependencias, vigilante, el resumen diario, las métricas y el tablero guardan
// en el repo de OPERACIONES; el banco, las suites y el examen guardan en el de mantenimiento. Si los avisos leyeran
// todo del de mantenimiento, mostrarían la noche anterior con la de hoy ya guardada en operaciones, y al día
// siguiente dirían «foto vieja» con los nocturnos sanos. Con el clon de mantenimiento viejo y el de
// operaciones al día, dependencias, vigilante y tablero no acusan al nocturno (NO ESTÁ CORRIENDO).
const OPS_ONLY = (files) => Object.fromEntries(Object.entries(files).filter(([k]) => !k.startsWith('scripts/controls-bench/')));
const MAINT_ONLY = (files) => Object.fromEntries(Object.entries(files).filter(([k]) => k === 'README.md' || k.startsWith('scripts/controls-bench/')));
const split = (lab) => ({ maintained: lab.pub, maintainers: lab.priv, operations: lab.ops });
// estas máquinas SÍ esperan los nocturnos del clon de mantenimiento: el banco y las suites no se apuntan a ninguna variable
const BY_CONFIG = { TYCON_BENCH_REPORT: undefined, TYCON_SUITES_REPORT: undefined };

test('T86 OperationsClone_DependenciesWatcherAndBoardReadFromIt_BenchAndSuitesFromMaintainers', () => {
  const at = Date.now() - HOUR;
  const old = Date.now() - 6 * DAY;
  // el clon de mantenimiento trae el banco y las suites de hoy, y la noche de operaciones VIEJA;
  // el de operaciones trae la de hoy
  const maint = { ...OPS_ONLY(night(old)), ...MAINT_ONLY(night(at)) };
  const s = startup(machine({ published: maint, ops: OPS_ONLY(night(at)), config: split }), BY_CONFIG);
  const n = perNightly(s);
  const d = day(at);
  for (const k of Object.keys(NIGHTLIES)) assert.match(n[k], /^✅/, `${k} no salió en verde:\n${s.all}`);
  for (const k of Object.keys(NIGHTLIES)) assert.ok(n[k].includes(d), `${k} no dice la fecha de hoy (${d}): ${n[k]}`);
  assert.strictEqual(s.lines.length, 5, s.all);
  assert.doesNotMatch(s.all, /NO EST[ÁA]N? CORRIENDO|NO SE ESTÁ GENERANDO|no dejó snapshot|fetch origin/);
});

test('T86 MaintainerWithoutOperationsClone_OneLineWithTheCommand_BenchAndSuitesStillSpeak', () => {
  const at = Date.now() - HOUR;
  const s = startup(machine({ published: night(at), config: (lab) => ({ maintained: lab.pub, maintainers: lab.priv }) }), BY_CONFIG);
  const problem = s.lines.filter((l) => /^🔴 avisos de los nocturnos/.test(l));
  assert.strictEqual(problem.length, 1, `el clon de operaciones que falta se dice UNA vez:\n${s.all}`);
  assert.match(problem[0], /no declara el clon del repo de operaciones \(paths\.operations\)/);
  assert.match(problem[0], /harness\.js config set paths\.operations /, 'no dice el comando');
  assert.doesNotMatch(problem[0], /config set paths\.maintainers/, 'receta declarar el clon de mantenimiento, que ya está');
  assert.strictEqual(s.board, '', 'el tablero repite el problema o lee de otro lado');
  const n = perNightly(s);
  assert.doesNotMatch(n.dependencias, /^✅/, 'dependencias sale en verde sin clon de operaciones (leyó el de mantenimiento)');
  for (const k of ['banco', 'suites']) assert.match(n[k], /^✅/, `${k} dejó de leer el clon de mantenimiento:\n${s.all}`);
  // …y si tampoco declara el de mantenimiento, es UNA línea con los dos comandos
  const both = startup(machine({ config: 'maintained' }));
  assert.strictEqual(both.lines.length, 1, both.all);
  assert.match(both.deps, /config set paths\.maintainers .*config set paths\.operations /, both.all);
});

test('T86 OperationsCopyAge_IsSaidAsTheOperationsClone_AndTheFetchHintNamesIt', () => {
  const at = Date.now() - HOUR;
  const old = Date.now() - 6 * DAY;
  const lab = machine({ published: MAINT_ONLY(night(at)), ops: OPS_ONLY(night(old)), opsFetched: 5 * DAY, config: split });
  const s = startup(lab, BY_CONFIG);
  const n = perNightly(s);
  for (const k of ['dependencias', 'vigilante', 'tablero']) {
    assert.match(n[k], /^🟠 .*no sé si/, `${k}: foto vencida con la copia de operaciones vieja no dice «no sé»:\n${s.all}`);
    assert.match(n[k], /la copia del clon de operaciones es del /, `${k} no nombra el clon de operaciones: ${n[k]}`);
  }
  for (const k of ['banco', 'suites']) assert.match(n[k], /^✅/, `${k}: ${n[k]}`);
  const hints = s.all.split('\n').filter((l) => /fetch origin/.test(l));
  assert.strictEqual(hints.length, 1, `un solo comando para traer, el de operaciones:\n${s.all}`);
  assert.ok(hints[0].includes(lab.ops), `el comando no trae el clon de operaciones: ${hints[0]}`);
});

test('T86 NightData_ResolveOperations_TableRowByRow', () => {
  const N_JS = path.join(ROOT, 'scripts', 'lib', 'night-data.js');
  const J = JSON.stringify;
  const ask = (lab, expr, env = {}) => {
    const r = spawnSync(process.execPath, ['-e', `const N=require(${J(N_JS)});process.stdout.write(JSON.stringify(${expr}))`], { encoding: 'utf8', env: labEnv(lab, env) });
    assert.strictEqual(r.status, 0, `${expr}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const tree = path.join(os.tmpdir(), 'un-arbol-cualquiera');
  const ops = `N.resolveOperations(${J(tree)})`;
  const sep = machine({ ops: OPS_ONLY(night(Date.now() - HOUR)), config: split });
  assert.deepStrictEqual(ask(sep, ops), { dir: sep.ops, source: 'operations', problem: null });
  assert.deepStrictEqual(ask(sep, `N.resolve(${J(tree)})`), { dir: sep.priv, source: 'maintainers', problem: null }, 'el clon de mantenimiento sigue siendo el del banco y las suites');
  assert.deepStrictEqual(ask(sep, ops, { TYCON_NIGHTLY: '0' }), { dir: null, source: null, problem: null });
  const clone = machine({ release: false, config: 'none' });
  assert.deepStrictEqual(ask(clone, ops), { dir: tree, source: 'own', problem: null }, 'desde un clon, el árbol propio');
  assert.deepStrictEqual(ask(machine({ config: 'none' }), ops), { dir: null, source: null, problem: null }, 'la máquina de un dev no tiene estos avisos');
  const noOps = ask(machine({ config: (lab) => ({ maintainers: lab.priv }) }), ops);
  assert.deepStrictEqual([noOps.dir, noOps.source], [null, null]);
  assert.match(noOps.problem, /no declara el clon del repo de operaciones \(paths\.operations\)/);
  const folder = ask(machine({ config: (lab) => { const d = path.join(lab.base, 'una-carpeta'); fs.mkdirSync(d); return { maintainers: lab.priv, operations: d }; } }), ops);
  assert.deepStrictEqual([folder.dir, folder.source], [null, 'operations']);
  assert.match(folder.problem, /paths\.operations no es la raíz de un clon de git/);
  assert.match(ask(machine({ config: (lab) => ({ maintained: lab.pub, operations: lab.pub }) }), ops).problem, /paths\.operations es el mismo clon que paths\.maintained/);
  assert.match(ask(machine({ config: (lab) => ({ operations: path.join(lab.base, 'no-esta') }) }), ops).problem, /paths\.operations nombra una carpeta que no está/);
  // la línea de comandos que usa el aviso nocturno de evidencia
  const plain = spawnSync(process.execPath, [N_JS, '--plain', '--operations'], { encoding: 'utf8', env: labEnv(sep) });
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.strictEqual(plain.stdout.trim(), sep.ops);
  // el texto de la copia nombra el clon que se le pasa
  assert.match(ask(sep, `N.copyAfter(${J(sep.ops)}, Date.now() + ${HOUR}, 'el clon de operaciones')`), /^la copia del clon de operaciones es del \d{4}-\d{2}-\d{2}$/);
});

test('T85 PhotoFolderThatCannotBeListed_IsSaid_NotReadAsNoHistory', () => {
  const D = require(path.join(ROOT, 'scripts', 'hooks', 'dependencies-notice.js'));
  // a source whose listing fails the way a folder without permission does; one where the folder is simply missing
  const denied = { listar: () => { throw Object.assign(new Error("EACCES: permission denied, scandir '/x'"), { code: 'EACCES' }); }, leer: () => '', exists: () => true };
  const missing = { listar: () => { throw Object.assign(new Error("ENOENT: no such file or directory, scandir '/x'"), { code: 'ENOENT' }); }, leer: () => '', exists: () => false };
  const ahora = Date.parse('2026-10-20T12:00:00Z');
  // dependencies: «could not list» is its own state and always speaks, also on a machine that does not wait for the nightlies
  const v = D.evaluar({ outDir: '/x', pendingDir: '/y', ahora, fuente: denied });
  assert.strictEqual(v.estado, 'no-leida', JSON.stringify(v));
  const line = D.redactar(v, {});
  assert.match(line || '', /^🔴 dependencias: no pude leer la carpeta de las fotos de la revisión nocturna \(EACCES/);
  assert.strictEqual(D.evaluar({ outDir: '/x', pendingDir: '/y', ahora, fuente: missing }).estado, 'sin-historia', 'una carpeta que no está sigue siendo «sin historia»');
  // the watcher: the same
  const w = D.evaluarVigilante({ vigOut: '/x', ahora, fuente: denied });
  assert.strictEqual(w.estado, 'no-leida', JSON.stringify(w));
  assert.match(D.redactarVigilante(w, {}) || '', /^🔴 vigilante: no pude leer la carpeta de sus fotos \(EACCES/);
  assert.strictEqual(D.evaluarVigilante({ vigOut: '/x', ahora, fuente: missing }).estado, 'sin-historia');
});
