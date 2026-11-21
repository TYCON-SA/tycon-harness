'use strict';
/**
 * adhoc-base.test.js — la base del camino corto desde la punta con constancia: un arreglo de seguimiento en una rama que
 * ya pasó por el freno (un guardado del carril que dejó pasar) o por una corrida cerrada completa mide sólo lo que cambió
 * desde esa punta. Sin punta, con la constancia ilegible, con la punta fuera de la rama o con `main` traído después, mide
 * como siempre: desde el punto en común con main.
 *
 * Laboratorio por prueba: una HOME vacía, un repo con su `origin` (un repo desnudo local) y la rama del arreglo empujada,
 * y el carril firmado en el estado de esa HOME. El freno se llama como lo llama el gancho (`decidir`), antes del commit.
 *
 * stable-data: las horas de los carriles y de los cierres son las del momento; ninguna se compara con el reloj.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/adhoc-base.test.js < /dev/null
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
// Sin arnés instalado packs.default no se puede leer y el freno de paquetes frenaría: la suite fija el valor del perfil
process.env.TYCON_PACKS_DEFAULT = 'all';
const SID = 'ses-punta';
const RAMA = 'story/la-punta';

const GIT_ENV = { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@example.com', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@example.com' };
function sh(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const tmp = (t, pre) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), pre)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function escribir(d, r, c = 'x\n') {
  const f = path.join(d, r);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, c);
  return f;
}

/** Un repo con `origin` (desnudo, local), `main` empujada y la rama del arreglo empujada con seguimiento. */
function repoConOrigin(t) {
  const base = tmp(t, 'punta-repo-');
  const origen = path.join(base, 'origen.git');
  const d = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  escribir(d, 'LEEME.md', 'hola\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'base');
  sh(d, 'remote', 'add', 'origin', origen);
  sh(d, 'push', '-q', 'origin', 'main');
  sh(d, 'checkout', '-q', '-b', RAMA);
  sh(d, 'push', '-q', '-u', 'origin', RAMA);
  return d;
}
// La HOME de la prueba: el estado del arnés vive ahí, y el módulo lo lee de la HOME del proceso
function home(t) {
  const h = tmp(t, 'punta-home-');
  fs.mkdirSync(path.join(h, '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  const antes = process.env.HOME;
  process.env.HOME = h;
  t.after(() => { process.env.HOME = antes; });
  return h;
}
const estado = (h) => path.join(h, '.claude', '.tycon-pipeline');
const carrilPath = (h) => path.join(estado(h), 'adhoc', `${SID}.json`);
const guardadosPath = (h) => path.join(estado(h), 'carril-guardados.jsonl');

/** El carril firmado, como lo deja `marker.js adhoc set`. */
function carril(h, d, extra = {}) {
  const ahora = new Date().toISOString();
  fs.mkdirSync(path.join(estado(h), 'adhoc'), { recursive: true });
  fs.writeFileSync(carrilPath(h), JSON.stringify({ reason: 'el combo muestra el nombre completo', maxFiles: 8, files: [],
    declaredAt: ahora, lastTouch: ahora, firmadaEn: ahora,
    bases: { [d]: { sha: sh(d, 'rev-parse', 'origin/main'), traida: true, ts: ahora, origen: sh(d, 'remote', 'get-url', 'origin') } }, ...extra }));
  fs.appendFileSync(path.join(estado(h), 'gates.log'), `${JSON.stringify({ name: 'adhoc-lane-signed', status: 'ok', destino: SID, ts: ahora })}\n`);
}
const cerrarCarril = (h) => fs.rmSync(carrilPath(h), { force: true });
const leerCarril = (h) => JSON.parse(fs.readFileSync(carrilPath(h), 'utf8'));

const brake = () => require(path.join(SCRIPTS, 'lib', 'save-brake.js'));
const base = () => require(path.join(SCRIPTS, 'lib', 'adhoc-base.js'));
const saveOk = () => require(path.join(SCRIPTS, 'lib', 'save-ok.js'));
const decidir = (h, cwd, command = 'git commit -m x') => brake().decidir({ command, cwd, sid: SID, home: h });

/** El commit de un carril: lo que el gancho ve antes (el freno) y el commit de verdad. Devuelve lo que dijo el freno. */
function guardarPorElCarril(h, d, rutas, contenido = 'v1') {
  for (const r of rutas) escribir(d, r, `// ${r} ${contenido}\n`);
  sh(d, 'add', '-A');
  const r = decidir(h, d);
  if (!(r && r.texto)) sh(d, 'commit', '-q', '-m', `carril: ${rutas.length}`);
  return r;
}
/** El cierre archivado de una corrida, como lo deja `marker.js clear`, con la foto de «Preparar el pull request». */
function corridaArchivada(h, d, { estadoDelCierre = 'completa', arbol } = {}) {
  const dir = path.join(estado(h), 'timing-history');
  fs.mkdirSync(dir, { recursive: true });
  const foto = arbol || saveOk().arbolDelCommit(d, 'HEAD').arbol;
  const marker = { storyId: '9.99', cierre: { estado: estadoDelCierre, at: new Date().toISOString() },
    prepareCommitHuellas: [{ repo: d, rama: RAMA, base: sh(d, 'rev-parse', 'origin/main'), arbol: foto, cabeza: sh(d, 'rev-parse', 'HEAD') }] };
  fs.writeFileSync(path.join(dir, `9.99-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`), JSON.stringify({ archivedAt: new Date().toISOString(), marker }));
}
function medida(h, d) {
  const m = base().medirLoPropio(leerCarril(h));
  return { ...m.porRepo[d], avisos: m.avisos, fallas: m.fallas };
}
const rutasDe = (e) => e.cambios.map((c) => c.ruta).sort();
const archivos = (prefijo, n) => Array.from({ length: n }, (_, i) => `src/${prefijo}${i}.js`);

// ── la punta con constancia ───────────────────────────────────────────────────────────────────────────────────────────

// 🔴 Falla con: la base del carril en el punto en común con main aunque la rama ya tenga su punta revisada.
test('T11 AdhocBase_FollowupOnBranchWithConstancy_MeasuresFromThatTip @story-8.276 @ac-13', async (t) => {
  await t.test('desde el guardado de un carril', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    carril(h, d);
    const freno = guardarPorElCarril(h, d, archivos('a', 5));
    assert.ok(!(freno && freno.texto), JSON.stringify(freno));
    const P = sh(d, 'rev-parse', 'HEAD');
    cerrarCarril(h);
    carril(h, d);
    escribir(d, 'src/a0.js', '// el arreglo de seguimiento\n');
    const e = medida(h, d);
    assert.deepStrictEqual(e.base, { sha: P, de: 'constancia' });
    assert.deepStrictEqual(rutasDe(e), ['src/a0.js']);
  });
  await t.test('desde el cierre de una corrida', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    for (const r of archivos('b', 5)) escribir(d, r, `// ${r}\n`);
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'la corrida');
    const P = sh(d, 'rev-parse', 'HEAD');
    corridaArchivada(h, d);
    carril(h, d);
    escribir(d, 'src/b3.js', '// el arreglo de seguimiento\n');
    const e = medida(h, d);
    assert.deepStrictEqual(e.base, { sha: P, de: 'constancia' });
    assert.deepStrictEqual(rutasDe(e), ['src/b3.js']);
  });
});

// Defecto 13 (21/11, Producto A 2.10): un arreglo rápido sobre la rama de una historia con su corrida abierta, ya revisada,
// medía contra main: un cambio de un archivo vio como «fuera de la lista» los 11 ya revisados y pidió el sobre-cupo. La punta
// con constancia es también el commit igual (sin papeleo) a lo que vio la última vuelta cerrada de revisores de una corrida
// abierta de ese repo. Lo que cambió después de esa punta cuenta igual: no se cuela nada sin revisar.
const FT = () => require(path.join(SCRIPTS, 'lib', 'frozen-tree.js'));
/** La corrida abierta de la historia, con su vuelta de revisores sellada sobre el árbol de ahora y cerrada `cierre` ms después. */
function corridaRevisada(h, d, { cierre = 1000 } = {}) {
  const sid = 'ses-corrida';
  const v = FT().sealAndFreeze({ stateDir: estado(h), sid, etiqueta: 'vuelta-1', repos: [d], tipo: 'revisores', story: '9.99' });
  assert.ok(!v.error, v.error);
  const ts = Date.parse(FT().ultimaVuelta(estado(h), sid, 'revisores').ts);
  fs.writeFileSync(path.join(estado(h), 'active', `${sid}.json`), JSON.stringify({ sessionId: sid, storyId: '9.99', repoPath: d,
    stepTimings: { reviewers: { completedAt: new Date(ts + cierre).toISOString() } } }));
}

test('T1 AdhocBase_OpenRunReviewedRound_MeasuresFromTheReviewedTip — la vuelta cerrada de la corrida abierta es la punta', async (t) => {
  await t.test('un arreglo de un archivo sobre 11 revisados cuenta uno', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    for (const r of archivos('r', 11)) escribir(d, r, `// ${r}\n`);
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'la historia, revisada');
    const P = sh(d, 'rev-parse', 'HEAD');
    corridaRevisada(h, d);
    carril(h, d);
    escribir(d, 'src/r3.js', '// el arreglo rápido\n');
    const e = medida(h, d);
    assert.deepStrictEqual(e.base, { sha: P, de: 'constancia' });
    assert.deepStrictEqual(rutasDe(e), ['src/r3.js']);
  });
  await t.test('lo commiteado después de la vuelta, sin revisar, cuenta', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    for (const r of archivos('r', 3)) escribir(d, r, `// ${r}\n`);
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'la historia, revisada');
    const P = sh(d, 'rev-parse', 'HEAD');
    corridaRevisada(h, d);
    escribir(d, 'src/sin-revisar.js', '// después de la vuelta\n');
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'sin revisar');
    carril(h, d);
    escribir(d, 'src/r0.js', '// el arreglo rápido\n');
    const e = medida(h, d);
    assert.deepStrictEqual(e.base, { sha: P, de: 'constancia' });
    assert.deepStrictEqual(rutasDe(e), ['src/r0.js', 'src/sin-revisar.js']);
  });
  await t.test('una vuelta sin cerrar no es constancia', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    const M = sh(d, 'rev-parse', 'origin/main');
    for (const r of archivos('r', 3)) escribir(d, r, `// ${r}\n`);
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'la historia');
    corridaRevisada(h, d, { cierre: -60000 });
    carril(h, d);
    escribir(d, 'src/r0.js', '// el arreglo rápido\n');
    const e = medida(h, d);
    assert.strictEqual(e.base.sha, M);
    assert.strictEqual(rutasDe(e).length, 3);
  });
});

// 🔴 Falla con: un archivo que la constancia no cubría perdonado por medir desde la punta.
test('T12 AdhocBase_FileOutsideConstancyCounts @story-8.276 @ac-14', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  carril(h, d);
  guardarPorElCarril(h, d, archivos('a', 3));
  cerrarCarril(h);
  carril(h, d);
  escribir(d, 'src/a1.js', '// cambia\n');
  escribir(d, 'src/nuevo.js', '// no estaba en la constancia\n');
  const e = medida(h, d);
  assert.strictEqual(e.base.de, 'constancia');
  assert.deepStrictEqual([...rutasDe(e), ...e.sinSeguir].sort(), ['src/a1.js', 'src/nuevo.js']);
});

// 🔴 Falla con: sin constancia, una base distinta de la de hoy; ilegible, sin decirlo; la punta fuera de la rama, usada.
test('T13 AdhocBase_NoConstancyOrUnreadable_MainAsToday @story-8.276 @ac-15 @ac-20', async (t) => {
  await t.test('sin constancias: la de hoy, con las mismas rutas', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    const M = sh(d, 'rev-parse', 'origin/main');
    for (const r of archivos('a', 3)) escribir(d, r);
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'sin carril');
    carril(h, d);
    escribir(d, 'src/a0.js', '// cambia\n');
    const e = medida(h, d);
    assert.deepStrictEqual(e.base, { sha: M, de: 'integracion' });
    assert.deepStrictEqual(rutasDe(e), archivos('a', 3));
  });
  await t.test('constancia ilegible: la de hoy y la línea', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    fs.mkdirSync(guardadosPath(h), { recursive: true });
    // con un commit en la rama: sin ninguno no hay punta posible y no hay nada que leer
    escribir(d, 'src/ya.js');
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'algo en la rama');
    carril(h, d);
    escribir(d, 'src/x.js');
    const e = medida(h, d);
    assert.strictEqual(e.base.de, 'integracion');
    assert.ok(e.avisos.some((a) => /no pude leer las constancias/.test(a)), e.avisos.join('\n'));
    assert.deepStrictEqual(e.fallas, []);
  });
  await t.test('la punta ya no es de la rama (un reset)', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    const M = sh(d, 'rev-parse', 'origin/main');
    carril(h, d);
    guardarPorElCarril(h, d, archivos('a', 2));
    cerrarCarril(h);
    sh(d, 'reset', '-q', '--hard', M);
    escribir(d, 'src/otro.js');
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'otra historia');
    carril(h, d);
    const e = medida(h, d);
    assert.deepStrictEqual(e.base, { sha: M, de: 'integracion' });
  });
});

// 🔴 Falla con: una punta anotada por un guardado que el freno frenó, por un commit con otro contenido o con algo de
// más, o por una corrida que no cerró completa; o un guardado frenado porque no se pudo escribir la constancia.
test('T16 AdhocBase_UnbackedClose_NoTip @story-8.276 @ac-21', async (t) => {
  const sinPunta = (h, d) => {
    cerrarCarril(h);
    carril(h, d);
    escribir(d, 'LEEME.md', 'cambio\n');
    return medida(h, d).base.de;
  };
  await t.test('el freno del tope frena: no anota', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    carril(h, d, { maxFiles: 2 });
    const r = guardarPorElCarril(h, d, archivos('a', 4));
    assert.ok(r && r.texto, JSON.stringify(r));
    sh(d, 'commit', '-q', '-m', 'igual');
    assert.strictEqual(sinPunta(h, d), 'integracion');
  });
  await t.test('riesgo alto sin revisores: no anota', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    carril(h, d);
    const r = guardarPorElCarril(h, d, ['src/auth/session.ts']);
    assert.ok(r && r.texto, JSON.stringify(r));
    sh(d, 'commit', '-q', '-m', 'igual');
    assert.strictEqual(sinPunta(h, d), 'integracion');
  });
  await t.test('sin marca y limpio: anota', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    carril(h, d);
    guardarPorElCarril(h, d, archivos('a', 2));
    assert.strictEqual(sinPunta(h, d), 'constancia');
  });
  await t.test('el contenido sale del índice: lo sin agregar sigue contando', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    carril(h, d);
    escribir(d, 'src/a.js', '// agregado\n');
    escribir(d, 'src/b.js', '// agregado\n');
    sh(d, 'add', '-A');
    escribir(d, 'src/b.js', '// cambio sin agregar\n');
    assert.ok(!(decidir(h, d) || {}).texto);
    sh(d, 'commit', '-q', '-m', 'lo del índice');
    const P = sh(d, 'rev-parse', 'HEAD');
    cerrarCarril(h);
    carril(h, d);
    const e = medida(h, d);
    assert.deepStrictEqual(e.base, { sha: P, de: 'constancia' });
    assert.deepStrictEqual(rutasDe(e), ['src/b.js']);
  });
  await t.test('commiteado con otro contenido: no anota', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    carril(h, d);
    escribir(d, 'src/a.js', '// lo que vio el freno\n');
    sh(d, 'add', '-A');
    assert.ok(!(decidir(h, d) || {}).texto);
    escribir(d, 'src/a.js', '// otro contenido\n');
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'otro');
    assert.strictEqual(sinPunta(h, d), 'integracion');
  });
  await t.test('un archivo fuera de la lista entre la base y la punta: no anota', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    carril(h, d);
    escribir(d, 'src/a.js', '// del carril\n');
    sh(d, 'add', '-A');
    assert.ok(!(decidir(h, d) || {}).texto);
    escribir(d, 'src/de-mas.js', '// colado\n');
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'con algo de más');
    assert.strictEqual(sinPunta(h, d), 'integracion');
  });
  await t.test('corridas abortada, perdida o con otro árbol: no dan punta', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    escribir(d, 'src/c.js');
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'la corrida');
    corridaArchivada(h, d, { estadoDelCierre: 'abortada' });
    corridaArchivada(h, d, { estadoDelCierre: 'perdida' });
    corridaArchivada(h, d, { arbol: sh(d, 'rev-parse', 'HEAD^{tree}').replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) });
    carril(h, d);
    escribir(d, 'src/c.js', 'cambio\n');
    assert.strictEqual(medida(h, d).base.de, 'integracion');
  });
  await t.test('sin poder escribir la constancia: la línea, y el guardado sigue', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    fs.mkdirSync(guardadosPath(h), { recursive: true });
    carril(h, d);
    const r = guardarPorElCarril(h, d, archivos('a', 1));
    assert.ok(!(r && r.texto), JSON.stringify(r));
    // en pantalla, no sólo en el registro: con la carpeta de estado sin escritura, el registro tampoco se escribe
    assert.match((r && r.aviso) || '', /no anoté la constancia del guardado/);
    const log = fs.readFileSync(path.join(estado(h), 'gates.log'), 'utf8');
    assert.match(log, /"name":"carril-guardado","status":"warn"/);
  });
  // 🔴 Falla con: el carril abierto midiéndose desde su propio guardado anterior (partir en commits esquiva el tope)
  await t.test('el mismo carril abierto no se mide desde su propio guardado: el tope cuenta todo', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    carril(h, d, { maxFiles: 3 });
    assert.ok(!(guardarPorElCarril(h, d, archivos('a', 2)) || {}).texto);
    const r = guardarPorElCarril(h, d, archivos('b', 2));
    assert.ok(r && r.texto && /tope/i.test(r.texto), JSON.stringify(r));
  });
  // 🔴 Falla con: el `git add` del mismo comando sin constancia, o con la del índice de antes del add
  await t.test('git add -A && git commit en un solo comando: anota lo que se commitea', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    carril(h, d);
    for (const r of archivos('a', 2)) escribir(d, r, `// ${r}\n`);
    assert.ok(!(decidir(h, d, 'git add -A && git commit -m x') || {}).texto);
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'x');
    const P = sh(d, 'rev-parse', 'HEAD');
    cerrarCarril(h);
    carril(h, d);
    escribir(d, 'src/a0.js', '// el arreglo\n');
    assert.deepStrictEqual(medida(h, d).base, { sha: P, de: 'constancia' });
  });
  // 🔴 Falla con: con marca de riesgo alto, un índice distinto de lo revisado bendecido como punta
  await t.test('con marca: sólo lo revisado (el disco) da punta', async (tt) => {
    const conMarca = (ttt, indiceDistinto) => {
      const d = repoConOrigin(ttt);
      const h = home(ttt);
      carril(h, d);
      escribir(d, 'src/auth/session.ts', '// lo revisado\n');
      sh(d, 'add', '-A');
      assert.ok((decidir(h, d) || {}).texto, 'la marca frena sin revisores');
      const c = leerCarril(h);
      const huella = base().huellaDelCarril(c);
      fs.writeFileSync(carrilPath(h), JSON.stringify({ ...c, revisores: { huella }, pase: { huella } }));
      if (indiceDistinto) {
        escribir(d, 'src/auth/session.ts', '// sin revisar\n');
        sh(d, 'add', '-A');
        escribir(d, 'src/auth/session.ts', '// lo revisado\n');
      }
      assert.ok(!(decidir(h, d) || {}).texto, 'con las constancias vigentes guarda');
      sh(d, 'commit', '-q', '-m', 'x');
      const P = sh(d, 'rev-parse', 'HEAD');
      cerrarCarril(h);
      carril(h, d);
      escribir(d, 'LEEME.md', 'cambio\n');
      return { P, base: medida(h, d).base };
    };
    await tt.test('el índice es lo revisado: punta', (t3) => {
      const { P, base: b } = conMarca(t3, false);
      assert.deepStrictEqual(b, { sha: P, de: 'constancia' });
    });
    await tt.test('el índice no es lo revisado: sin punta', (t3) => {
      assert.strictEqual(conMarca(t3, true).base.de, 'integracion');
    });
  });
  // 🔴 Falla con: la medida con fallas o el HEAD suelto anotando, o diciéndolo como «nada que anotar»
  await t.test('medida con fallas no anota; sin rama, lo dice', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    const dir = estado(h);
    const medidaDe = { porRepo: { [d]: { base: { sha: sh(d, 'rev-parse', 'HEAD') }, cambios: [{ ruta: 'LEEME.md', vieja: null }], anotados: [], sinSeguir: [] } }, fallas: [] };
    assert.deepStrictEqual(base().anotarGuardadoDelCarril({ medida: { ...medidaDe, fallas: ['git no contestó'] }, repo: d, dir }), { anotado: false });
    sh(d, 'checkout', '-q', '--detach');
    const r = base().anotarGuardadoDelCarril({ medida: medidaDe, repo: d, dir });
    assert.strictEqual(r.anotado, false);
    assert.match(r.aviso, /sin rama/);
    assert.ok(!fs.existsSync(guardadosPath(h)));
  });
  // 🔴 Falla con: un renglón roto de las constancias tomado como «no hay», sin decirlo
  await t.test('un renglón que no se lee: la de hoy y la línea', (tt) => {
    const d = repoConOrigin(tt);
    const h = home(tt);
    escribir(d, 'src/ya.js');
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'algo en la rama');
    fs.writeFileSync(guardadosPath(h), '{"esto no cierra\n');
    carril(h, d);
    const e = medida(h, d);
    assert.strictEqual(e.base.de, 'integracion');
    assert.ok(e.avisos.some((a) => /renglón\(es\) que no se leen/.test(a)), e.avisos.join('\n'));
  });
});

// 🔴 Falla con: lo que trajo un merge de `main` commiteado después de la punta contado como del carril.
test('T17 AdhocBase_MainMergedAfterTip_MainAsToday @story-8.276 @ac-15', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  carril(h, d);
  guardarPorElCarril(h, d, archivos('a', 2));
  cerrarCarril(h);
  sh(d, 'checkout', '-q', 'main');
  for (const r of archivos('de-main', 3)) escribir(d, r);
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'de otro pedido');
  sh(d, 'push', '-q', 'origin', 'main');
  sh(d, 'checkout', '-q', RAMA);
  sh(d, 'merge', '-q', '--no-edit', 'main');
  sh(d, 'fetch', '-q', 'origin');
  carril(h, d);
  escribir(d, 'src/a1.js', '// el arreglo\n');
  const e = medida(h, d);
  assert.deepStrictEqual(e.base, { sha: sh(d, 'rev-parse', 'origin/main'), de: 'integracion' });
  assert.deepStrictEqual(rutasDe(e), ['src/a0.js', 'src/a1.js']);
});
