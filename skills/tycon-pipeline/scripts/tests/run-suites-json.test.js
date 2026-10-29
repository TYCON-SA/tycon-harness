#!/usr/bin/env node
/**
 * run-suites-json.test.js — el 5to stack del test-gate: repos cuya suite es `scripts/tests/suites.json`.
 *
 * 🔴 Un repo sin package.json ni .csproj (el del arnés) tiene sus suites como archivos sueltos declarados en
 *    `suites.json`, que el pipeline de Azure ya corre. Sin este stack el gate diría «no se detectó stack» y saldría 3,
 *    así que NUNCA escribiría `tests-result.json`, y sin ese artefacto la matriz de DoD marcaría criterios como
 *    NOT-RUN con la suite realmente verde: «un gate que no puede mirar bloquea igual que uno que mira y ve rojo,
 *    pero por la razón equivocada».
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.join(__dirname, '..', 'lib', 'run-suites-json.js');

function armar(suites, { conSkills = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suites-json-'));
  const repo = path.join(root, 'repo');
  const skills = path.join(root, 'skills');
  fs.mkdirSync(path.join(repo, 'scripts', 'tests'), { recursive: true });
  if (conSkills) fs.mkdirSync(path.join(skills, 'x', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'suites.json'),
    JSON.stringify({ diarias: suites.diarias || [], semanales: suites.semanales || [] }));
  const escribir = (raiz, ruta, cuerpo) => {
    const base = raiz === 'agent-skills' ? skills : path.join(repo, 'scripts');
    const p = path.join(base, ruta);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, cuerpo);
  };
  return { root, repo, skills, escribir };
}

function correr(repo, skills, out) {
  const r = spawnSync('node', [RUNNER, repo, out, '--skills', skills], { encoding: 'utf8' });
  const resumen = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, resumen };
}

test('todas verdes → exit 0 y el resumen cuenta cada una', () => {
  // 🔴 mutación: no escribir el resumen, o contar «corridas» sin distinguir verdes.
  const f = armar({ diarias: [
    { raiz: 'arnes', ruta: 'tests/a.test.js' },
    { raiz: 'arnes', ruta: 'tests/b.test.sh' },
    { raiz: 'agent-skills', ruta: 'x/tests/c.test.js' },
  ] });
  f.escribir('arnes', 'tests/a.test.js', 'process.exit(0)');
  f.escribir('arnes', 'tests/b.test.sh', 'exit 0');
  f.escribir('agent-skills', 'x/tests/c.test.js', 'process.exit(0)');
  const r = correr(f.repo, f.skills, path.join(f.root, 'out.json'));
  assert.equal(r.status, 0, `esperaba exit 0 y salió ${r.status}: ${r.stderr}`);
  assert.equal(r.resumen.corridas, 3);
  assert.equal(r.resumen.verdes, 3);
  assert.deepEqual(r.resumen.fallas, []);
  assert.equal(r.resumen.ausentes.length, 0);
});

test('UNA roja → exit ≠ 0 y la nombra (el exit code es el real, no el del último)', () => {
  // 🔴 mutación: devolver el exit del ÚLTIMO comando (el clásico `$?` tras un loop) → con la
  //    roja en el medio y una verde al final, el gate daría verde con la suite en rojo.
  const f = armar({ diarias: [
    { raiz: 'arnes', ruta: 'tests/a.test.js' },
    { raiz: 'arnes', ruta: 'tests/rota.test.sh' },
    { raiz: 'arnes', ruta: 'tests/z.test.js' },
  ] });
  f.escribir('arnes', 'tests/a.test.js', 'process.exit(0)');
  f.escribir('arnes', 'tests/rota.test.sh', 'echo "se rompió acá" >&2; exit 7');
  f.escribir('arnes', 'tests/z.test.js', 'process.exit(0)');
  const r = correr(f.repo, f.skills, path.join(f.root, 'out.json'));
  assert.notEqual(r.status, 0, 'con una roja el gate NO puede salir 0');
  assert.equal(r.resumen.verdes, 2);
  assert.equal(r.resumen.fallas.length, 1);
  assert.match(r.resumen.fallas[0].ruta, /rota\.test\.sh$/);
  assert.equal(r.resumen.fallas[0].exit, 7, 'y guarda el exit real de la que falló');
  assert.match(r.resumen.fallas[0].cola || '', /se rompió acá/, 'con la cola de su salida, para no tener que re-correrla');
});

test('una suite AUSENTE es una falla, no un salteo en silencio', () => {
  // 🔴 mutación: `[ -f "$T" ] || continue` → una suite que desapareció del disco (o un
  //    agent-skills sin instalar) deja el gate en verde habiendo medido MENOS de lo declarado.
  //    «No pude mirar» y «miré y está bien» no se escriben igual.
  const f = armar({ diarias: [
    { raiz: 'arnes', ruta: 'tests/a.test.js' },
    { raiz: 'agent-skills', ruta: 'x/tests/no-existe.test.js' },
  ] });
  f.escribir('arnes', 'tests/a.test.js', 'process.exit(0)');
  const r = correr(f.repo, f.skills, path.join(f.root, 'out.json'));
  assert.notEqual(r.status, 0, 'una suite declarada que no está tiene que poner el gate en rojo');
  assert.equal(r.resumen.ausentes.length, 1);
  assert.match(r.resumen.ausentes[0], /no-existe\.test\.js$/);
  assert.equal(r.resumen.verdes, 1, 'la que sí estaba se corrió igual');
});

test('sin suites.json legible → exit 3 y NO escribe un resumen verde', () => {
  // 🔴 mutación: tratar un JSON roto como lista vacía → «0 suites, 0 rojas», verde, sin haber
  //    corrido nada. Es el cero falso que el arnés persigue en todos lados.
  const f = armar({ diarias: [] });
  fs.writeFileSync(path.join(f.repo, 'scripts', 'tests', 'suites.json'), '{ esto no es json');
  const out = path.join(f.root, 'out.json');
  const r = correr(f.repo, f.skills, out);
  assert.equal(r.status, 3, `esperaba 3 (no pude medir) y salió ${r.status}`);
  assert.ok(!r.resumen || r.resumen.verdes === undefined || r.resumen.no_medido,
    'no puede quedar un resumen que se lea como verde');
});

test('las semanales también entran: la lista es TODA la de suites.json', () => {
  // 🔴 mutación: leer sólo `diarias` → la semanal desaparece del gate y nadie lo nota.
  const f = armar({ diarias: [{ raiz: 'arnes', ruta: 'tests/a.test.js' }],
    semanales: [{ raiz: 'arnes', ruta: 'tests/semanal.test.sh' }] });
  f.escribir('arnes', 'tests/a.test.js', 'process.exit(0)');
  f.escribir('arnes', 'tests/semanal.test.sh', 'exit 1');
  const r = correr(f.repo, f.skills, path.join(f.root, 'out.json'));
  assert.notEqual(r.status, 0);
  assert.equal(r.resumen.corridas, 2, 'la semanal se corrió');
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// En paralelo, con diferidas y exclusivas. En serie el gate del arnés tarda más de 45 minutos. Estas pruebas fijan que
// el paralelo da el MISMO resultado: mismas rojas, mismo orden del resumen, nada huérfano al cortar, «no pude mirar» ≠ verde.
// Las suites de mentira anotan inicio y fin en un archivo compartido: el solapamiento se mide de ahí,
// no de la salida del runner.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const { spawn } = require('child_process');

const MS = "perl -MTime::HiRes=time -e 'printf \"%d\\n\", time*1000'";

/** Suite .sh que anota `<nombre> start|end <ms>` en LOG y duerme `secs`; sale `exit`. */
function timedSuite(log, name, secs, exit = 0) {
  return `echo "${name} start $(${MS})" >> "${log}"\nsleep ${secs}\necho "${name} end $(${MS})" >> "${log}"\nexit ${exit}\n`;
}

/** Intervalos por suite y concurrencia máxima, leídos del log compartido. */
function intervals(log) {
  const by = {};
  for (const l of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    const [name, kind, ms] = l.split(' ');
    (by[name] = by[name] || {})[kind] = Number(ms);
  }
  const ev = [];
  for (const [name, iv] of Object.entries(by)) { ev.push([iv.start, 1, name]); ev.push([iv.end, -1, name]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0; let max = 0;
  for (const [, d] of ev) { cur += d; max = Math.max(max, cur); }
  return { by, max };
}

function runWith(f, { env = {}, touched = null } = {}) {
  const out = path.join(f.root, 'out.json');
  const args = [RUNNER, f.repo, out, '--skills', f.skills];
  if (touched) {
    const tf = path.join(f.root, 'touched.json');
    fs.writeFileSync(tf, JSON.stringify(touched));
    args.push('--touched', tf);
  }
  const r = spawnSync('node', args, { encoding: 'utf8', env: { ...process.env, ...env } });
  const resumen = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, resumen };
}

const PUB = ['scripts/lab-pub/**'];
function deferrableLab() {
  const f = armar({ diarias: [
    { raiz: 'arnes', ruta: 'tests/verde.test.sh' },
    { raiz: 'arnes', ruta: 'tests/diferible.test.sh', gate_only_when_touching: PUB },
  ] });
  f.escribir('arnes', 'tests/verde.test.sh', 'exit 0');
  f.escribir('arnes', 'tests/diferible.test.sh', 'echo "corrió la diferible"; exit 1');
  return f;
}

test('T6 RunSuites_DefersWhenNotTouching — la story no toca la carpeta: la suite no corre y queda dicho por qué', () => {
  // 🔴 mutación: ignorar `gate_only_when_touching` → la diferible corre (exit 1) y el gate queda en rojo.
  const f = deferrableLab();
  const r = runWith(f, { touched: { known: true, files: ['scripts/hooks/x.js'] } });
  assert.equal(r.status, 0, `esperaba 0: ${r.stdout}${r.stderr}`);
  assert.equal(r.resumen.corridas, 1);
  assert.equal(r.resumen.deferred_suites.length, 1);
  assert.match(r.resumen.deferred_suites[0].suite, /diferible\.test\.sh$/);
  assert.match(r.resumen.deferred_suites[0].reason, /scripts\/lab-pub\/\*\*/);
  assert.match(r.stdout, /diferible\.test\.sh/, 'el gate lo dice en su salida');
});

test('T7 RunSuites_RunsDeferrableWhenTouching — la story toca la carpeta: corre y su rojo cuenta', () => {
  // 🔴 mutación: diferir siempre → una story de publicación cierra sin exportador-real.
  const f = deferrableLab();
  // un archivo de laboratorio que no existe en el arnés: la copia pública traduce las rutas reales ya mudadas
  const r = runWith(f, { touched: { known: true, files: ['scripts/lab-pub/lab-tool.js'] } });
  assert.equal(r.status, 1);
  assert.equal(r.resumen.deferred_suites.length, 0);
  assert.match(r.resumen.fallas[0].ruta, /diferible\.test\.sh$/);
});

test('T7b RunSuites_RunsDeferrableWhenItsOwnFileIsTouched — editar la propia suite la hace correr aunque no toque su carpeta', () => {
  // Las suites lentas del arnés son diferibles: una tanda que sólo cambia la prueba no puede cerrar sin haberla corrido.
  // 🔴 mutación: decidir sólo por `gate_only_when_touching` → la suite editada se difiere.
  const f = deferrableLab();
  const r = runWith(f, { touched: { known: true, files: ['scripts/tests/diferible.test.sh'] } });
  assert.equal(r.status, 1, `esperaba que corra (y salga roja): ${r.stdout}${r.stderr}`);
  assert.equal(r.resumen.deferred_suites.length, 0);
});

// Una suite PARTIDA (`<suite>.p<k>.test.*`, una línea que carga el archivo entero) se registra por sus partes.
// «Editar la propia suite» es editar el entero, donde viven sus casos.
// 🔴 mutación: tomar «la propia suite» como sólo la parte → tocar el archivo entero difiere todas sus partes.
test('T7c RunSuites_PartitionedSuite_WholeFileTouched_RunsItsParts — editar el archivo entero de una suite partida corre sus partes', () => {
  const lab = () => {
    const f = armar({ diarias: [
      { raiz: 'arnes', ruta: 'tests/verde.test.sh' },
      { raiz: 'arnes', ruta: 'tests/partida.p1.test.sh', gate_only_when_touching: PUB },
      { raiz: 'arnes', ruta: 'tests/partida.p2.test.sh', gate_only_when_touching: PUB },
    ] });
    f.escribir('arnes', 'tests/verde.test.sh', 'exit 0');
    f.escribir('arnes', 'tests/partida.test.sh', 'echo "corrió la partida"; exit 1');
    for (const k of [1, 2]) f.escribir('arnes', `tests/partida.p${k}.test.sh`, 'exec bash "$(dirname "$0")/partida.test.sh"');
    return f;
  };
  // (una de consola: su archivo entero y la biblioteca de consola; el reparto por duración es de las de Node)
  for (const file of ['scripts/tests/partida.test.sh', 'scripts/tests/lib/suite-parts.sh']) {
    const r = runWith(lab(), { touched: { known: true, files: [file] } });
    assert.equal(r.status, 1, `${file}: esperaba que corran las partes (y salgan rojas): ${r.stdout}${r.stderr}`);
    assert.equal(r.resumen.deferred_suites.length, 0, `${file}: ninguna parte diferida`);
  }
  // el espejo: lo que no la toca la sigue difiriendo
  const other = runWith(lab(), { touched: { known: true, files: ['scripts/hooks/x.js'] } });
  assert.equal(other.status, 0, other.stdout + other.stderr);
  assert.equal(other.resumen.deferred_suites.length, 2);
  // el archivo entero BORRADO o movido también es «lo propio»: sus partes corren (y salen rojas) en vez de diferirse
  const gone = lab();
  fs.rmSync(path.join(gone.repo, 'scripts', 'tests', 'partida.test.sh'));
  const r = runWith(gone, { touched: { known: true, files: ['scripts/tests/partida.test.sh'] } });
  assert.notEqual(r.status, 0, `el entero se fue: sus partes corren y fallan\n${r.stdout}${r.stderr}`);
  assert.equal(r.resumen.deferred_suites.length, 0);
});

// Una partida de NODE suma, a lo propio, el reparto por duración (suite-parts.json).
test('T7c — una suite partida de Node: su archivo entero, la biblioteca de Node y el reparto por duración la corren', () => {
  const lab = () => {
    const f = armar({ diarias: [
      { raiz: 'arnes', ruta: 'tests/nodal.p1.test.js', gate_only_when_touching: PUB },
      { raiz: 'arnes', ruta: 'tests/nodal.p2.test.js', gate_only_when_touching: PUB },
    ] });
    f.escribir('arnes', 'tests/nodal.test.js', "console.log('corrió la partida de Node'); process.exit(1);\n");
    for (const k of [1, 2]) f.escribir('arnes', `tests/nodal.p${k}.test.js`, "require('./nodal.test.js');\n");
    return f;
  };
  for (const file of ['scripts/tests/nodal.test.js', 'scripts/tests/lib/suite-parts.js', 'scripts/tests/suite-parts.json']) {
    const r = runWith(lab(), { touched: { known: true, files: [file] } });
    assert.equal(r.status, 1, `${file}: esperaba que corran las partes (y salgan rojas): ${r.stdout}${r.stderr}`);
    assert.equal(r.resumen.deferred_suites.length, 0, `${file}: ninguna parte diferida`);
  }
  // la biblioteca de consola no es de una partida de Node
  const sh = runWith(lab(), { touched: { known: true, files: ['scripts/tests/lib/suite-parts.sh'] } });
  assert.equal(sh.resumen.deferred_suites.length, 2, sh.stdout);
});

test('T8 RunSuites_UnknownTouched_RunsAll — sin datos de lo tocado (o known:false), corre todo', () => {
  // 🔴 mutación: tratar «sin --touched» o `known:false` como «no toca» → se difiere sin haber mirado.
  const f1 = deferrableLab();
  const sin = runWith(f1);
  assert.equal(sin.status, 1, 'sin --touched la diferible corre');
  const f2 = deferrableLab();
  const nose = runWith(f2, { touched: { known: false, files: [], reason: 'git falló' } });
  assert.equal(nose.status, 1, 'con known:false la diferible corre');
  assert.match(nose.stdout + nose.stderr, /git falló/, 'y el motivo se dice');
});

test('T28 RunSuites_BrokenTouchedFile_RunsAll — un --touched ilegible, inexistente o con otra forma también es «no sé»: corre todo y lo dice', () => {
  // 🔴 mutación (TEST-W4): tratar un JSON roto como lista vacía → «no toca» → difiere.
  const casos = [
    ['roto', (tf) => fs.writeFileSync(tf, '{ esto no es json')],
    ['inexistente', (tf) => { try { fs.unlinkSync(tf); } catch { /* no estaba */ } }],
    ['otra forma', (tf) => fs.writeFileSync(tf, JSON.stringify({ files: 'scripts/hooks/x.js' }))],
  ];
  for (const [nombre, preparar] of casos) {
    const f = deferrableLab();
    const tf = path.join(f.root, 'touched.json');
    preparar(tf);
    const out = path.join(f.root, 'out.json');
    const r = spawnSync('node', [RUNNER, f.repo, out, '--skills', f.skills, '--touched', tf], { encoding: 'utf8' });
    assert.equal(r.status, 1, `con un --touched ${nombre} la diferible corre (y sale roja)`);
    assert.match(r.stdout + r.stderr, /no pude saber qué archivos toca la story/, `con un --touched ${nombre} lo dice`);
  }
});

test('T27 RunSuites_CannotWriteSummaryEarly_Exit3 —si no puede escribir el resumen en una salida temprana, sale 3 y lo dice', () => {
  // 🔴 mutación: las salidas tempranas llaman a escribir() de forma
  //    síncrona fuera de la promesa → la excepción se escapa con exit 1 y un stack, no «no pude medir».
  const f = armar({ diarias: [] });
  fs.writeFileSync(path.join(f.repo, 'scripts', 'tests', 'suites.json'), '{ esto no es json');
  const out = path.join(f.root, 'no-es-carpeta');
  fs.writeFileSync(out, 'un archivo, no una carpeta');
  const r = spawnSync('node', [RUNNER, f.repo, path.join(out, 'out.json'), '--skills', f.skills], { encoding: 'utf8' });
  assert.equal(r.status, 3, `esperaba 3 y salió ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /falló antes de dejar el resumen/);
});

test('T9 RunSuites_AllSuitesOverride_RunsAll — TYCON_GATE_ALL_SUITES=1 corre todo como antes', () => {
  // 🔴 mutación: leer la variable con otro nombre, o no leerla.
  const f = deferrableLab();
  const r = runWith(f, { env: { TYCON_GATE_ALL_SUITES: '1' }, touched: { known: true, files: [] } });
  assert.equal(r.status, 1);
  assert.equal(r.resumen.deferred_suites.length, 0);
});

test('T10 RunSuites_MaxConcurrencyIsW — nunca más de W a la vez, y sí W', () => {
  // 🔴 mutación: seguir en serie (máximo 1) o lanzar todas juntas (máximo 6).
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const f = armar({ diarias: names.map((n) => ({ raiz: 'arnes', ruta: `tests/${n}.test.sh` })) });
  const log = path.join(f.root, 'log.txt');
  for (const n of names) f.escribir('arnes', `tests/${n}.test.sh`, timedSuite(log, n, 0.4));
  const r = runWith(f, { env: { TYCON_SUITES_MAX_WORKERS: '2' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.resumen.workers, 2);
  assert.equal(intervals(log).max, 2, 'la concurrencia medida es exactamente 2');
  assert.ok(typeof r.resumen.wall_ms === 'number' && r.resumen.wall_ms > 0);
});

test('T11 RunSuites_SummaryInListOrder — el resumen sigue el orden de la lista, no el de llegada', () => {
  // 🔴 mutación: empujar al resumen cuando cada una termina → la lenta del principio queda última.
  const f = armar({ diarias: ['lenta', 'r1', 'r2'].map((n) => ({ raiz: 'arnes', ruta: `tests/${n}.test.sh` })) });
  const log = path.join(f.root, 'log.txt');
  f.escribir('arnes', 'tests/lenta.test.sh', timedSuite(log, 'lenta', 0.8));
  f.escribir('arnes', 'tests/r1.test.sh', timedSuite(log, 'r1', 0.1));
  f.escribir('arnes', 'tests/r2.test.sh', timedSuite(log, 'r2', 0.1));
  const r = runWith(f, { env: { TYCON_SUITES_MAX_WORKERS: '3' } });
  assert.deepEqual(r.resumen.suites.map((s) => path.basename(s.ruta)), ['lenta.test.sh', 'r1.test.sh', 'r2.test.sh']);
  for (const k of ['corridas', 'verdes', 'fallas', 'ausentes', 'suites', 'workers', 'wall_ms', 'deferred_suites']) {
    assert.ok(k in r.resumen, `el resumen trae «${k}»`);
  }
  assert.ok(r.resumen.suites.every((s) => typeof s.exit === 'number' && typeof s.ms === 'number'));
});

test('T12 RunSuites_ExclusiveRunsAlone — la exclusiva corre sola, después del tramo paralelo', () => {
  // 🔴 mutación: ignorar `exclusive` → se solapa con las otras.
  const f = armar({ diarias: [
    { raiz: 'arnes', ruta: 'tests/x.test.sh', exclusive: true },
    { raiz: 'arnes', ruta: 'tests/p1.test.sh' },
    { raiz: 'arnes', ruta: 'tests/p2.test.sh' },
    { raiz: 'arnes', ruta: 'tests/p3.test.sh' },
  ] });
  const log = path.join(f.root, 'log.txt');
  f.escribir('arnes', 'tests/x.test.sh', timedSuite(log, 'x', 0.3));
  for (const n of ['p1', 'p2', 'p3']) f.escribir('arnes', `tests/${n}.test.sh`, timedSuite(log, n, 0.4));
  const r = runWith(f, { env: { TYCON_SUITES_MAX_WORKERS: '3' } });
  assert.equal(r.status, 0, r.stderr);
  const { by } = intervals(log);
  const lastParallelEnd = Math.max(by.p1.end, by.p2.end, by.p3.end);
  assert.ok(by.x.start >= lastParallelEnd, `la exclusiva arrancó (${by.x.start}) antes de que terminara el tramo paralelo (${lastParallelEnd})`);
  assert.equal(path.basename(r.resumen.suites[0].ruta), 'x.test.sh', 'y el resumen conserva el orden de la lista');
});

test('T13 RunSuites_RedDoesNotStopOthers — roja, ausente y matada por señal cuentan; las verdes corren igual', () => {
  // 🔴 mutación: cortar al primer rojo (Promise.all que rechaza) → las verdes de atrás no corren.
  const f = armar({ diarias: [
    { raiz: 'arnes', ruta: 'tests/roja.test.sh' },
    { raiz: 'arnes', ruta: 'tests/no-existe.test.sh' },
    { raiz: 'arnes', ruta: 'tests/matada.test.sh' },
    { raiz: 'arnes', ruta: 'tests/v1.test.sh' },
    { raiz: 'arnes', ruta: 'tests/v2.test.sh' },
  ] });
  f.escribir('arnes', 'tests/roja.test.sh', 'echo "falló la roja" >&2; exit 5');
  f.escribir('arnes', 'tests/matada.test.sh', 'kill -9 $$');
  f.escribir('arnes', 'tests/v1.test.sh', 'sleep 0.2; exit 0');
  f.escribir('arnes', 'tests/v2.test.sh', 'sleep 0.2; exit 0');
  const r = runWith(f, { env: { TYCON_SUITES_MAX_WORKERS: '2' } });
  assert.equal(r.status, 1);
  assert.equal(r.resumen.verdes, 2);
  assert.equal(r.resumen.ausentes.length, 1);
  const roja = r.resumen.fallas.find((x) => /roja/.test(x.ruta));
  assert.equal(roja.exit, 5);
  assert.match(roja.cola, /falló la roja/);
  assert.equal(r.resumen.fallas.find((x) => /matada/.test(x.ruta)).exit, 124);
});

test('T14 RunSuites_InterruptKillsChildren — cortar el runner no deja suites huérfanas ni un resumen verde', async () => {
  // 🔴 mutación: no manejar SIGTERM → el runner muere y las suites (y sus hijos) siguen corriendo.
  const f = armar({ diarias: ['s1', 's2'].map((n) => ({ raiz: 'arnes', ruta: `tests/${n}.test.sh` })) });
  const pids = path.join(f.root, 'pids.txt');
  for (const n of ['s1', 's2']) {
    f.escribir('arnes', `tests/${n}.test.sh`, `echo $$ >> "${pids}"\nsleep 30 &\necho $! >> "${pids}"\nwait\n`);
  }
  const out = path.join(f.root, 'out.json');
  const child = spawn('node', [RUNNER, f.repo, out, '--skills', f.skills],
    { env: { ...process.env, TYCON_SUITES_MAX_WORKERS: '2' }, stdio: 'ignore' });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 100));
    if (fs.existsSync(pids) && fs.readFileSync(pids, 'utf8').trim().split('\n').length >= 4) break;
  }
  const code = await new Promise((res) => { child.on('exit', (c, s) => res(c === null ? s : c)); child.kill('SIGTERM'); });
  assert.notEqual(code, 0, 'el runner cortado no sale 0');
  await new Promise((res) => setTimeout(res, 300));
  const vivos = fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number)
    .filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  vivos.forEach((pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* ya murió */ } });
  assert.deepEqual(vivos, [], 'ninguna suite ni hijo de suite sigue vivo');
  const resumen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.match(resumen.no_medido || '', /interrumpida/);
});

test('T15 RunSuites_MalformedFields_Conservative — un campo mal formado hace lo seguro y avisa con el nombre', () => {
  // 🔴 mutación: `if (s.exclusive === true)` → «si» corre en paralelo; `includes` sobre un string → difiere.
  const f = armar({ diarias: [
    { raiz: 'arnes', ruta: 'tests/rara.test.sh', exclusive: 'si' },
    { raiz: 'arnes', ruta: 'tests/mal-patron.test.sh', gate_only_when_touching: 'scripts/lab-pub' },
    { raiz: 'arnes', ruta: 'tests/p1.test.sh' },
  ] });
  const log = path.join(f.root, 'log.txt');
  f.escribir('arnes', 'tests/rara.test.sh', timedSuite(log, 'rara', 0.3));
  f.escribir('arnes', 'tests/mal-patron.test.sh', timedSuite(log, 'malpatron', 0.3));
  f.escribir('arnes', 'tests/p1.test.sh', timedSuite(log, 'p1', 0.3));
  const r = runWith(f, { env: { TYCON_SUITES_MAX_WORKERS: '3' }, touched: { known: true, files: [] } });
  assert.equal(r.status, 0, r.stderr);
  const { by } = intervals(log);
  assert.ok(by.rara.start >= Math.max(by.p1.end, by.malpatron.end), 'exclusive mal formado → se trata como exclusiva');
  assert.ok(by.malpatron, 'patrón mal formado → no se difiere');
  assert.match(r.stderr + r.stdout, /rara\.test\.sh/);
  assert.match(r.stderr + r.stdout, /mal-patron\.test\.sh/);
});

test('T16 RunSuites_NothingLeftToRun_NotMeasured — si no queda nada para correr, no es un verde', () => {
  // 🔴 mutación: «0 corridas, 0 rojas» → exit 0.
  const f = armar({ diarias: [{ raiz: 'arnes', ruta: 'tests/diferible.test.sh', gate_only_when_touching: PUB }] });
  f.escribir('arnes', 'tests/diferible.test.sh', 'exit 0');
  const r = runWith(f, { touched: { known: true, files: [] } });
  assert.equal(r.status, 3);
  assert.ok(r.resumen.no_medido, 'el resumen dice que no midió');
});

test('T17 RunSuites_BadWorkersEnv_FallsBack — valor inválido avisa y usa el defecto; 1 es la serie de siempre', () => {
  // 🔴 mutación: `parseInt('mucho')` → NaN → 0 procesos y el runner no corre nada (o cuelga).
  const def = Math.max(1, Math.floor((os.availableParallelism ? os.availableParallelism() : os.cpus().length) / 2));
  for (const bad of ['0', '-2', 'mucho']) {
    const f = armar({ diarias: [{ raiz: 'arnes', ruta: 'tests/a.test.sh' }] });
    f.escribir('arnes', 'tests/a.test.sh', 'exit 0');
    const r = runWith(f, { env: { TYCON_SUITES_MAX_WORKERS: bad } });
    assert.equal(r.status, 0);
    assert.equal(r.resumen.workers, def, `con «${bad}» usa el defecto`);
    assert.match(r.stderr, /TYCON_SUITES_MAX_WORKERS/, `con «${bad}» avisa`);
  }
  // 🔴 mutación: con W=1 lanzar igual en paralelo, o en otro orden.
  const names = ['a', 'b', 'c'];
  const f = armar({ diarias: names.map((n) => ({ raiz: 'arnes', ruta: `tests/${n}.test.sh` })) });
  const log = path.join(f.root, 'log.txt');
  for (const n of names) f.escribir('arnes', `tests/${n}.test.sh`, timedSuite(log, n, 0.1));
  const r = runWith(f, { env: { TYCON_SUITES_MAX_WORKERS: '1' } });
  const { by, max } = intervals(log);
  assert.equal(max, 1);
  assert.ok(by.a.start < by.b.start && by.b.start < by.c.start, 'arrancan en el orden de la lista');
  assert.equal(r.resumen.workers, 1);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// En el repo unido las suites con raíz `agent-skills` viven en `<repo>/skills`. Buscarlas sólo en `TYCON_SKILLS_DIR` o en
// `~/.claude/agent-skills/skills` correría, en un clon de trabajo, las suites INSTALADAS en la máquina y el gate daría
// verde sin haber probado el cambio. Por eso la raíz la contesta la función del repo cuyas suites se corren
// (`<repo>/scripts/lib/skills-dir.js`, la misma que usan los demás lectores de suites.json): la variable › el propio
// clon si es unido › lo instalado.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const HARNESS_LIB_FILES = ['skills-dir.js', 'canonical-path.js', 'legacy-names.js'];
/** La biblioteca de un arnés que ya trae la regla: la variable, el clon que contiene esta prueba, o el enlace de la máquina. */
function harnessLib() {
  const cands = [process.env.TYCON_GUIDES_DIR, path.resolve(__dirname, '..', '..', '..', '..'), path.join(os.homedir(), '.claude', 'tycon-harness'), path.join(os.homedir(), '.claude', 'tycon-claude-guides')].filter(Boolean);
  for (const c of cands) {
    const lib = path.join(c, 'scripts', 'lib');
    if (!HARNESS_LIB_FILES.every((f) => fs.existsSync(path.join(lib, f)))) continue;
    if (/own-clone/.test(fs.readFileSync(path.join(lib, 'skills-dir.js'), 'utf8'))) return lib;
  }
  return null;
}
const HARNESS_LIB = harnessLib();
const NO_HARNESS = !HARNESS_LIB && 'NO MEDIDO — no encontré un arnés con «el propio clon primero» en scripts/lib/skills-dir.js (TYCON_GUIDES_DIR, el clon de esta prueba, ~/.claude/tycon-harness o el nombre viejo)';
const CANARY = 'tycon-pipeline/scripts/tests/canary.test.js';
const workClones = [];
test.after(() => { for (const d of workClones) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * Un clon de trabajo de juguete y una HOME de juguete.
 *   unified:   el clon trae skills/ y agents/ (el repo unido), con la canario según `clone` ('red' | 'green')
 *   installed: la HOME trae ~/.claude/agent-skills con la canario según su valor ('red' | 'green'); false = sin instalar
 *   harness:   el clon trae scripts/lib/skills-dir.js (es el arnés); false = un repo cualquiera con suites.json
 */
function workClone({ unified = true, clone = 'red', installed = 'green', harness = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suites-json-clone-')));
  workClones.push(root);
  const repo = path.join(root, 'clone');
  const home = path.join(root, 'home');
  const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  const canary = (where, color) => `console.error("canario ${where}: ${color === 'red' ? 'rojo a propósito' : 'verde'}"); process.exit(${color === 'red' ? 1 : 0})\n`;
  put(path.join(repo, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: [
    { raiz: 'arnes', ruta: 'tests/a.test.js' },
    { raiz: 'agent-skills', ruta: CANARY },
  ] }));
  put(path.join(repo, 'scripts', 'tests', 'a.test.js'), 'process.exit(0)\n');
  if (harness) for (const f of HARNESS_LIB_FILES) put(path.join(repo, 'scripts', 'lib', f), fs.readFileSync(path.join(HARNESS_LIB, f)));
  if (unified) {
    put(path.join(repo, 'skills', CANARY), canary('del CLON de trabajo', clone));
    fs.mkdirSync(path.join(repo, 'agents'), { recursive: true });
  }
  fs.mkdirSync(home, { recursive: true });
  const inst = path.join(home, '.claude', 'agent-skills', 'skills');
  if (installed) put(path.join(inst, CANARY), canary('INSTALADO', installed));
  return { root, repo, home, inst };
}
function runClone(w, { variable, extra = [] } = {}) {
  const out = path.join(w.root, 'out.json');
  const env = { ...process.env, HOME: w.home, USERPROFILE: w.home };
  delete env.TYCON_SKILLS_DIR;
  if (variable !== undefined) env.TYCON_SKILLS_DIR = variable;
  const r = spawnSync('node', [RUNNER, w.repo, out, ...extra], { encoding: 'utf8', env });
  const resumen = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, resumen };
}

test('T11 Suites_CanaryInWorkClone_RunsOwnTree_NotInstalled — sin variable ni --skills, corre la canario del CLON (roja) y no la instalada (verde)', { skip: NO_HARNESS }, () => {
  // 🔴 mutación: `env.TYCON_SKILLS_DIR || ~/.claude/agent-skills/skills` → corre la instalada, exit 0: el verde
  //    que no probó nada.
  const w = workClone();
  const r = runClone(w);
  assert.equal(r.status, 1, `con la canario del clon en rojo el gate no puede salir ${r.status}: ${r.stdout}${r.stderr}`);
  assert.equal(r.resumen.fallas.length, 1);
  assert.equal(r.resumen.fallas[0].ruta, path.join(w.repo, 'skills', CANARY), 'la que corrió es la del clon de trabajo');
  assert.match(r.resumen.fallas[0].cola, /canario del CLON de trabajo/);
  // la línea de resultado dice de qué raíz salió, y el resumen también
  assert.ok(r.stdout.includes(`raíz agent-skills: ${path.join(w.repo, 'skills')} (salió de: own-clone)`), r.stdout);
  assert.deepEqual(r.resumen.skills_root, { dir: path.join(w.repo, 'skills'), source: 'own-clone' });
});

test('T11 — el espejo: la canario del clon verde sale verde; y con dos repos físicos corre la instalada, como siempre', { skip: NO_HARNESS }, () => {
  const healthy = runClone(workClone({ clone: 'green', installed: 'red' }));
  assert.equal(healthy.status, 0, `${healthy.stdout}${healthy.stderr}`);
  assert.equal(healthy.resumen.verdes, 2);
  // el clon del arnés SIN skills/ (el layout de dos repos): nada cambia
  const w = workClone({ unified: false });
  const twoRepos = runClone(w);
  assert.equal(twoRepos.status, 0, `${twoRepos.stdout}${twoRepos.stderr}`);
  assert.deepEqual(twoRepos.resumen.skills_root, { dir: w.inst, source: 'installed' });
  assert.ok(twoRepos.stdout.includes(`raíz agent-skills: ${w.inst} (salió de: installed)`), twoRepos.stdout);
  const installedRed = runClone(workClone({ unified: false, installed: 'red' }));
  assert.equal(installedRed.status, 1, 'y si la instalada está roja, rojo');
});

test('T11 — la variable gana al propio clon; --skills gana a las dos; y un repo sin la función sigue como antes', { skip: NO_HARNESS }, () => {
  const w = workClone();
  const v = runClone(w, { variable: path.join(w.home, '.claude', 'agent-skills') });   // la variable como RAÍZ
  assert.equal(v.status, 0, `${v.stdout}${v.stderr}`);
  assert.deepEqual(v.resumen.skills_root, { dir: w.inst, source: 'variable' });
  const o = runClone(w, { variable: path.join(w.repo, 'skills'), extra: ['--skills', w.inst] });
  assert.equal(o.status, 0, `${o.stdout}${o.stderr}`);
  assert.deepEqual(o.resumen.skills_root, { dir: w.inst, source: '--skills' });
  // un repo que no es el arnés (sin scripts/lib/skills-dir.js): la variable como carpeta, o lo instalado
  const plain = workClone({ unified: false, harness: false });
  assert.deepEqual(runClone(plain).resumen.skills_root, { dir: plain.inst, source: 'installed' });
  assert.deepEqual(runClone(plain, { variable: plain.inst }).resumen.skills_root, { dir: plain.inst, source: 'variable' });
});

test('T12 Suites_MissingRoot_NotMeasuredWithReason — la raíz agent-skills no existe: «NO MEDIDA» con su motivo, nunca verde ni salteada', { skip: NO_HARNESS }, () => {
  // 🔴 mutación: `if (!fs.existsSync(ruta)) continue` → 1 corrida, 1 verde, exit 0 con la mitad sin mirar.
  const w = workClone({ unified: false, installed: false });
  const r = runClone(w);
  assert.equal(r.status, 1, 'una suite que no se pudo medir no deja el gate en verde');
  assert.equal(r.resumen.verdes, 1, 'la del arnés corrió igual');
  const reason = `la raíz agent-skills no existe: ${w.inst} (salió de: installed)`;
  assert.deepEqual(r.resumen.unmeasured_suites, [{ suite: path.join(w.inst, CANARY), reason }]);
  assert.ok(r.stdout.includes(`NO MEDIDA canary.test.js — ${reason}`), r.stdout);
  assert.match(r.stdout, /1 no medidas/);
  // quien sólo lee `ausentes` (el gate) la sigue viendo: no desaparece de ninguna cuenta
  assert.deepEqual(r.resumen.ausentes, [path.join(w.inst, CANARY)]);
  // el espejo: con la raíz en su lugar, un archivo que falta sigue siendo AUSENTE (no «no medida»)
  const f = armar({ diarias: [{ raiz: 'agent-skills', ruta: 'x/tests/no-existe.test.js' }, { raiz: 'arnes', ruta: 'tests/a.test.js' }] });
  f.escribir('arnes', 'tests/a.test.js', 'process.exit(0)');
  const a = correr(f.repo, f.skills, path.join(f.root, 'out.json'));
  assert.equal(a.status, 1);
  assert.deepEqual(a.resumen.unmeasured_suites, []);
  assert.match(a.stdout, /AUSENTE/);
});

test('T12 — si la función del repo no se deja usar, no se adivina la raíz: exit 3 y el resumen dice que no midió', { skip: NO_HARNESS }, () => {
  // 🔴 mutación: caer callado a ~/.claude/agent-skills → vuelve el verde que no probó nada.
  const w = workClone();
  fs.writeFileSync(path.join(w.repo, 'scripts', 'lib', 'skills-dir.js'), 'throw new Error("biblioteca rota a propósito")\n');
  const r = runClone(w);
  assert.equal(r.status, 3);
  assert.match(r.resumen.no_medido, /raíz de las skills/);
  assert.match(r.stderr, /biblioteca rota a propósito/);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Dos bordes del repo unido.
//
// En un clon unido, un `require` a un archivo que no existe en la cadena canonical-path.js → legacy-names.js
// no puede leerse como «el clon no es unido»: el runner diría «salió de: installed», correría la canario
// INSTALADA (verde) y saldría 0 con la del clon en rojo.
//
// «Editar la propia suite la hace correr» compara la ruta de la suite con el repo TAL COMO LLEGÓ. La raíz de las
// skills sale ya resuelta a su ruta real (el `__dirname` de skills-dir.js); si el repo llega por un enlace (el lugar
// `~/.claude/tycon-harness`, o `/tmp` en Mac, que test-gate.sh conserva con su `pwd`), la ruta propia daría
// `../../…`, no coincidiría con lo tocado y la suite editada se DIFERIRÍA con el gate en verde. Lo mismo al revés: el repo
// por su ruta real y la raíz de las skills por el enlace instalado (`--skills` o la variable).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test('5b-19 Suites_NeighborPresentButBroken_NotMeasured — un require roto en la biblioteca del clon: exit 3 «no la adivino», nunca la canario instalada en verde', { skip: NO_HARNESS }, () => {
  // 🔴 mutación: `if (e.code === 'MODULE_NOT_FOUND') return false` en skills-dir.js → exit 0, 2 verdes, «installed».
  const w = workClone();   // la canario del clon, roja; la instalada, verde
  assert.equal(runClone(w).status, 1, 'control: el clon sano corre SU canario (roja)');
  const f = path.join(w.repo, 'scripts', 'lib', 'legacy-names.js');
  const anchor = "const path = require('path');";
  const body = fs.readFileSync(f, 'utf8');
  assert.ok(body.includes(anchor), 'no encontré dónde insertar el require roto');
  fs.writeFileSync(f, body.replace(anchor, `${anchor}\nconst moved = require('./renamed-helper-that-moved.js');`));
  fs.rmSync(path.join(w.root, 'out.json'), { force: true });
  const r = runClone(w);
  assert.equal(r.status, 3, `tenía que salir «no pude medir» y salió ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.resumen.no_medido, /raíz de las skills/);
  assert.equal(r.resumen.corridas, 0);
  assert.match(r.stderr, /renamed-helper-that-moved\.js/, 'nombra el archivo que falta');
  assert.ok(!/canario INSTALADO/.test(r.stdout + r.stderr) && !/salió de: installed/.test(r.stdout), 'no corrió lo instalado');
});

const OWN_GATE = ['scripts/zzz/**'];
const OWN_FILE = `skills/${CANARY}`;   // la propia suite, como la nombra git: relativa a la raíz del repo
/** Un clon unido cuya canario (roja: si corre, se ve) es diferible, y un enlace a ese clon. */
function gatedClone() {
  const w = workClone({ clone: 'red', installed: false });
  fs.writeFileSync(path.join(w.repo, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: [
    { raiz: 'arnes', ruta: 'tests/a.test.js' },
    { raiz: 'agent-skills', ruta: CANARY, gate_only_when_touching: OWN_GATE },
  ] }));
  const link = path.join(w.root, 'link');
  fs.symlinkSync(w.repo, link, 'junction');
  return { ...w, link };
}
function runGated(w, { repo = w.repo, files, variable, extra = [] }) {
  const out = path.join(w.root, 'out.json');
  fs.rmSync(out, { force: true });
  const tf = path.join(w.root, 'touched.json');
  fs.writeFileSync(tf, JSON.stringify({ known: true, files }));
  const env = { ...process.env, HOME: w.home, USERPROFILE: w.home };
  delete env.TYCON_SKILLS_DIR;
  delete env.TYCON_GATE_ALL_SUITES;
  if (variable !== undefined) env.TYCON_SKILLS_DIR = variable;
  const r = spawnSync('node', [RUNNER, repo, out, '--touched', tf, ...extra], { encoding: 'utf8', env });
  const resumen = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, resumen };
}
/** La canario corrió (es roja: exit 1) y no quedó diferida. */
function assertRan(r, how) {
  assert.ok(r.resumen, `${how}: sin resumen — ${r.stdout}${r.stderr}`);
  assert.deepEqual(r.resumen.deferred_suites, [], `${how}: la suite editada quedó DIFERIDA — ${r.stdout}`);
  assert.equal(r.status, 1, `${how}: la canario (roja) tenía que correr — ${r.stdout}${r.stderr}`);
  assert.match(r.resumen.fallas[0].ruta, /canary\.test\.js$/);
}

test('5b-4 Suites_OwnSuiteTouched_RepoThroughLink_Runs — el repo llega por un enlace y la suite agent-skills editada corre igual', { skip: NO_HARNESS }, () => {
  // 🔴 mutación: `path.relative(repo, p.ruta)` con el repo como llegó → `../clone/skills/…`, que no está en lo
  //    tocado: «DIFERIDA canary.test.js», exit 0.
  const w = gatedClone();
  assertRan(runGated(w, { files: [OWN_FILE] }), 'control, el repo por su ruta real');
  assertRan(runGated(w, { repo: w.link, files: [OWN_FILE] }), 'el repo por un enlace');
});

test('5b-6 — al revés: el repo por su ruta real y la raíz de las skills por un enlace (--skills, la variable, o enlaces por entrada)', { skip: NO_HARNESS }, () => {
  // 🔴 mutación: el mismo `path.relative`, con la punta sin resolver del otro lado.
  const w = gatedClone();
  assertRan(runGated(w, { files: [OWN_FILE], extra: ['--skills', path.join(w.link, 'skills')] }), '--skills por el enlace');
  assertRan(runGated(w, { files: [OWN_FILE], variable: w.link }), 'la variable (como raíz) por el enlace');
  // la carpeta `~/.claude/skills` de la máquina de un solo árbol: real, con un enlace por cada skill
  const entries = path.join(w.root, 'entries');
  fs.mkdirSync(entries);
  fs.symlinkSync(path.join(w.repo, 'skills', 'tycon-pipeline'), path.join(entries, 'tycon-pipeline'), 'junction');
  assertRan(runGated(w, { files: [OWN_FILE], extra: ['--skills', entries] }), '--skills con un enlace por entrada');
});

test('5b-4 — los espejos sanos: por el enlace, lo que NO se tocó se sigue difiriendo; y una suite de OTRO repo no se confunde con una ruta de éste', { skip: NO_HARNESS }, () => {
  const w = gatedClone();
  for (const repo of [w.repo, w.link]) {
    const r = runGated(w, { repo, files: ['scripts/hooks/x.js'] });
    assert.equal(r.status, 0, `${repo}: ${r.stdout}${r.stderr}`);
    assert.equal(r.resumen.deferred_suites.length, 1, `${repo}: sin tocar la suite ni su carpeta, se difiere`);
    const touching = runGated(w, { repo, files: ['scripts/zzz/tool.js'] });
    assert.equal(touching.status, 1, `${repo}: tocar su carpeta la hace correr, como siempre`);
  }
  // dos repos físicos: la suite de agent-skills vive FUERA del repo que se mide; una ruta `skills/…` tocada en éste
  // no es su archivo, y no la hace correr
  const f = armar({ diarias: [
    { raiz: 'arnes', ruta: 'tests/a.test.js' },
    { raiz: 'agent-skills', ruta: 'x/tests/g.test.js', gate_only_when_touching: OWN_GATE },
  ] });
  f.escribir('arnes', 'tests/a.test.js', 'process.exit(0)');
  f.escribir('agent-skills', 'x/tests/g.test.js', 'process.exit(1)');
  const two = runWith(f, { touched: { known: true, files: ['skills/x/tests/g.test.js'] }, env: { TYCON_GATE_ALL_SUITES: '' } });
  assert.equal(two.status, 0, `${two.stdout}${two.stderr}`);
  assert.equal(two.resumen.deferred_suites.length, 1);
});

// ── La cobertura pedida ──────────────────────────────────────────────────────────────────────────────────────────────
// Con `--coverage <carpeta>`, cada suite corre bajo el envoltorio de Node (lib/coverage-wrapper.js) con el medidor de
// cobertura: la suite es su hijo, con su misma salida y su mismo código; deja su lcov en la carpeta y al final quedan
// juntos en `lcov.info`. Sin pedirla, nada cambia: ni envoltorio ni carpeta.
test('T5 7.31-ConCobertura_CadaSuiteConSuCarpeta_SinPedirlaIgualQueHoy @story-7.31 @ac-4 @ac-5 — con cobertura, un lcov por suite; sin pedirla, como hoy', (t) => {
  // 🔴 mutación: el medidor (o la carpeta) también sin pedirla; o el código de la roja cambiado por el envoltorio.
  const f = armar({ diarias: [
    { raiz: 'arnes', ruta: 'tests/de-node.test.js' },
    { raiz: 'arnes', ruta: 'tests/sin-node.test.sh' },
    { raiz: 'arnes', ruta: 'tests/roja.test.sh' },
  ] });
  const modos = path.join(f.root, 'modos.txt');
  f.escribir('arnes', 'lib/acme.js', 'module.exports = (n) => {\n  if (n > 0) return "sí";\n  return "no";\n};\n');
  // la suite de Node lanza el código como hijo, como las del arnés, y anota si corrió con el medidor prendido
  f.escribir('arnes', 'tests/de-node.test.js', [
    "const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');",
    `fs.appendFileSync(${JSON.stringify(modos)}, 'node:' + (process.env.NODE_V8_COVERAGE ? 'medida' : 'sin medir') + '\\n');`,
    "const r = spawnSync(process.execPath, ['-e', 'require(process.argv[1])(1)', path.join(__dirname, '..', 'lib', 'acme.js')]);",
    'process.exit(r.status);',
  ].join('\n'));
  f.escribir('arnes', 'tests/sin-node.test.sh', `echo "bash:\${NODE_V8_COVERAGE:+medida}" >> ${JSON.stringify(modos)}\nexit 0\n`);
  f.escribir('arnes', 'tests/roja.test.sh', 'echo "se rompió" >&2\nexit 7\n');
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  const cov = path.join(f.root, 'cov');
  const out = path.join(f.root, 'out.json');

  const r = spawnSync(process.execPath, [RUNNER, f.repo, out, '--skills', f.skills, '--coverage', cov], { encoding: 'utf8', env });
  const resumen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(r.status, 1, `una roja: ${r.stdout}${r.stderr}`);
  assert.equal(resumen.corridas, 3);
  assert.equal(resumen.verdes, 2);
  assert.equal(resumen.fallas.length, 1);
  assert.equal(resumen.fallas[0].exit, 7, 'la roja sale con SU código, no con el del envoltorio');
  assert.match(resumen.fallas[0].cola, /se rompió/, 'la salida de la suite llega igual');
  assert.doesNotMatch(resumen.fallas[0].cola, /SF:|coverage report|all files/, 'el reporte del medidor no tapa la cola');
  assert.deepEqual(fs.readFileSync(modos, 'utf8').trim().split('\n').sort(), ['bash:medida', 'node:medida'], 'las dos, con el medidor heredado');
  const lcov = fs.readFileSync(path.join(cov, 'lcov.info'), 'utf8');
  assert.match(lcov, /^SF:.*lib[\\/]acme\.js$/m, 'trae el código que la suite de Node corrió como hijo');
  assert.doesNotMatch(lcov, /coverage-wrapper/, 'el envoltorio no se mide a sí mismo');
  assert.doesNotMatch(lcov, /de-node\.test\.js/, 'la suite misma no cuenta como código');
  const sinDatos = [path.join(f.repo, 'scripts', 'tests', 'roja.test.sh'), path.join(f.repo, 'scripts', 'tests', 'sin-node.test.sh')];
  assert.deepEqual([...resumen.coverage.without_data].sort(), sinDatos.sort(), 'las de bash que no lanzan node quedan «sin datos», con su ruta');
  assert.equal(resumen.coverage.with_data, 1);
  assert.equal(resumen.coverage.lcov, path.join(cov, 'lcov.info'));

  // sin pedirla: sin cambios
  fs.writeFileSync(modos, '');
  const out2 = path.join(f.root, 'out2.json');
  const r2 = spawnSync(process.execPath, [RUNNER, f.repo, out2, '--skills', f.skills], { encoding: 'utf8', env });
  const resumen2 = JSON.parse(fs.readFileSync(out2, 'utf8'));
  assert.equal(r2.status, 1);
  assert.equal(resumen2.fallas[0].exit, 7);
  assert.equal(resumen2.coverage, undefined, 'sin pedirla, el resumen no trae cobertura');
  const modosSin = fs.readFileSync(modos, 'utf8').trim().split('\n').sort();
  // Si esta prueba corre medida, Node le vuelve a poner su carpeta de V8 a cada hijo aunque se la borre del entorno:
  // ahí «sin medidor» no se puede comprobar y se dice, en vez de dar rojo.
  if (process.env.NODE_V8_COVERAGE) t.diagnostic('NO MEDIDO «ni medidor ni variable»: esta prueba corre medida y Node le pasa NODE_V8_COVERAGE a los hijos');
  else assert.deepEqual(modosSin, ['bash:', 'node:sin medir'], `ni medidor ni variable: ${JSON.stringify(modosSin)}`);
  assert.deepEqual(fs.readdirSync(f.root).filter((n) => n.startsWith('cov')), ['cov'], 'ni otra carpeta');
});

// chmod 000 no quita la lectura en Windows ni a root: ahí este caso no prueba nada (joinLcov lo prueba con una carpeta)
const SIN_CHMOD = (process.platform === 'win32' || (process.getuid && process.getuid() === 0))
  && 'NO MEDIDO — chmod 000 no quita la lectura en Windows ni a root; el ilegible lo prueba node-coverage.test.js';
test('T5 …--coverage sin carpeta es un error de uso, y un lcov ilegible se nombra con su motivo @story-7.31 @ac-5', { skip: SIN_CHMOD }, () => {
  // 🔴 mutación: `--coverage` sin valor corre sin cobertura en silencio; un lcov ilegible queda como «sin datos».
  const f = armar({ diarias: [{ raiz: 'arnes', ruta: 'tests/a.test.sh' }] });
  // Node ya abrió el lcov de la suite cuando ella corre: le saca el permiso de lectura y el juntado no lo puede leer
  f.escribir('arnes', 'tests/a.test.sh', `chmod 000 "${path.join(f.root, 'cov', '0000.lcov')}"\nexit 0\n`);
  const out = path.join(f.root, 'out.json');
  const uso = spawnSync(process.execPath, [RUNNER, f.repo, out, '--skills', f.skills, '--coverage'], { encoding: 'utf8' });
  assert.equal(uso.status, 2, `${uso.stdout}${uso.stderr}`);
  assert.match(uso.stderr, /--coverage <dir>/);
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [RUNNER, f.repo, out, '--skills', f.skills, '--coverage', path.join(f.root, 'cov')], { encoding: 'utf8', env });
  const resumen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(resumen.coverage.unreadable.length, 1, JSON.stringify(resumen.coverage));
  assert.equal(resumen.coverage.unreadable[0].ruta, path.join(f.repo, 'scripts', 'tests', 'a.test.sh'));
  assert.match(resumen.coverage.unreadable[0].motivo, /no se pudo leer/);
  assert.deepEqual(resumen.coverage.without_data, [], 'ilegible no es «sin datos»');
  assert.match(r.stdout, /1 ilegible/);
});

// ── la corrida cruzada (la del repo hermano, o con la story en otro repo), acotada a lo tocado ────────

function hermanoLab() {
  const f = armar({ diarias: [
    { raiz: 'arnes', ruta: 'tests/lee.test.js' },
    { raiz: 'arnes', ruta: 'tests/otra.test.js' },
  ] }, { conSkills: false });
  // la primera nombra el archivo tocado; la otra no
  f.escribir('arnes', 'tests/lee.test.js', "// lee scripts/lib/acme.js\nprocess.exit(0)\n");
  f.escribir('arnes', 'tests/otra.test.js', 'process.exit(0)\n');
  return f;
}
function runOnlyTouched(f, { env = {}, touched } = {}) {
  const out = path.join(f.root, 'out.json');
  const args = [RUNNER, f.repo, out, '--skills', f.skills, '--only-touched'];
  if (touched !== undefined) {
    const tf = path.join(f.root, 'touched.json');
    fs.writeFileSync(tf, JSON.stringify(touched));
    args.push('--touched', tf);
  }
  const e = { ...process.env, ...env };
  if (!('TYCON_GATE_ALL_SUITES' in env)) delete e.TYCON_GATE_ALL_SUITES;
  const r = spawnSync('node', args, { encoding: 'utf8', env: e });
  const resumen = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, resumen };
}

test('T4 8.55-SoloLoTocado_CorreAunqueToqueCodigo @story-8.55 @ac-4 — --only-touched corre sólo lo que lee lo tocado, aunque sea código', () => {
  // 🔴 mutación: sin --only-touched el corredor corre las dos (o, con --light, se apaga porque lo tocado es código).
  const f = hermanoLab();
  const r = runOnlyTouched(f, { touched: { known: true, files: ['scripts/lib/acme.js'] } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.resumen.corridas, 1, JSON.stringify(r.resumen));
  assert.equal(r.resumen.deferred_suites.length, 1);
  assert.match(r.resumen.deferred_suites[0].suite, /otra\.test\.js$/);
  assert.match(r.resumen.deferred_suites[0].reason, /corre sólo las suites que leen lo tocado; la completa la corre la CI del pedido/);
  // tocar una suite corre esa suite, no todas las de su carpeta (la regla de la corrida liviana arrastraría a las ~400)
  const suiteTocada = runOnlyTouched(f, { touched: { known: true, files: ['scripts/tests/lee.test.js'] } });
  assert.equal(suiteTocada.status, 0, suiteTocada.stderr);
  assert.equal(suiteTocada.resumen.corridas, 1, `sólo la suite tocada: ${JSON.stringify(suiteTocada.resumen.deferred_suites)}`);
  const todas = runOnlyTouched(f, { touched: { known: true, files: ['scripts/lib/acme.js'] }, env: { TYCON_GATE_ALL_SUITES: '1' } });
  assert.equal(todas.status, 0, todas.stderr);
  assert.equal(todas.resumen.corridas, 2, 'TYCON_GATE_ALL_SUITES=1 corre todo');
});

test('T5 8.55-SoloLoTocado_SinSaber_O_SinSuites_Sale7 @story-8.55 @ac-5 — sin saber qué se tocó, o sin suite que lo lea, no corre nada y sale 7', () => {
  // 🔴 mutación: «no sé qué se tocó» no debe correr las ~400 suites; «ninguna lo lee» no debe salir 3 («0 corridas»), que no dice por qué.
  const f = hermanoLab();
  const sinSaber = runOnlyTouched(f, { touched: { known: false, files: [], reason: 'la base cayó a HEAD' } });
  assert.equal(sinSaber.status, 7, `${sinSaber.stdout}\n${sinSaber.stderr}`);
  assert.equal(sinSaber.resumen.corridas, 0);
  assert.match(sinSaber.resumen.unscoped.reason, /no sé qué archivos tocó la story en este repo.*la base cayó a HEAD/);
  const sinArchivo = runOnlyTouched(f, {});
  assert.equal(sinArchivo.status, 7, 'sin --touched tampoco se sabe');
  const nadieLee = runOnlyTouched(f, { touched: { known: true, files: ['docs/nada.md'] } });
  assert.equal(nadieLee.status, 7, nadieLee.stdout);
  assert.equal(nadieLee.resumen.corridas, 0);
  assert.match(nadieLee.resumen.unscoped.reason, /ninguna suite lee lo que la story tocó en este repo/);
});

function runScopedByRepo(f, { touched, ci = 'la CI de GitHub del pedido' } = {}) {
  const out = path.join(f.root, 'out.json');
  const args = [RUNNER, f.repo, out, '--skills', f.skills, '--scoped-by-repo', ci];
  if (touched !== undefined) {
    const tf = path.join(f.root, 'touched.json');
    fs.writeFileSync(tf, JSON.stringify(touched));
    args.push('--touched', tf);
  }
  const e = { ...process.env };
  delete e.TYCON_GATE_ALL_SUITES;
  const r = spawnSync('node', args, { encoding: 'utf8', env: e });
  const resumen = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, resumen };
}

test('T29 PortonAcotadoPorElRepo_CorreSoloLoTocado — con --scoped-by-repo corre sólo lo que lee lo tocado y el resumen dice qué CI corre la completa', () => {
  // 🔴 mutación: sin el modo, el corredor corre las dos; sin `scoped`, el informe no puede decir quién corre la completa.
  const f = hermanoLab();
  const r = runScopedByRepo(f, { touched: { known: true, files: ['scripts/lib/acme.js'] } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.resumen.corridas, 1, JSON.stringify(r.resumen));
  assert.match(r.resumen.deferred_suites[0].suite, /otra\.test\.js$/);
  assert.match(r.resumen.deferred_suites[0].reason, /la suite completa la corre la CI del pedido \(la CI de GitHub del pedido\)/);
  assert.deepEqual(r.resumen.scoped, { by: 'repo', full_suite_by: 'la CI de GitHub del pedido', none_touched: false });
  assert.equal(r.resumen.unscoped, undefined);
});

test('T30 PortonAcotadoPorElRepo_NadieLee_Verde_SinSaber_CorreTodo — si ninguna suite lee lo tocado sale verde y lo dice; sin saber qué se tocó, corre todo', () => {
  // 🔴 mutación: «ninguna lo lee» no debe salir 3 (rojo) ni 7 (el repo declaró que lo respalda la CI); «no sé» no debe
  //    acotar: saldría 7 sin correr nada, y una suite roja pasaría.
  const f = hermanoLab();
  const nadieLee = runScopedByRepo(f, { touched: { known: true, files: ['docs/nada.md'] } });
  assert.equal(nadieLee.status, 0, `${nadieLee.stdout}\n${nadieLee.stderr}`);
  assert.equal(nadieLee.resumen.corridas, 0);
  assert.equal(nadieLee.resumen.scoped.none_touched, true);
  assert.match(nadieLee.stdout, /ninguna suite lee lo tocado; la suite completa la corre la CI del pedido/);
  const sinSaber = runScopedByRepo(f, { touched: { known: false, files: [], reason: 'la base cayó a HEAD' } });
  assert.equal(sinSaber.status, 0, sinSaber.stdout);
  assert.equal(sinSaber.resumen.corridas, 2, JSON.stringify(sinSaber.resumen));
  assert.equal(sinSaber.resumen.unscoped, undefined);
  assert.equal(sinSaber.resumen.scoped, undefined);
  assert.match(sinSaber.stdout, /no sé qué se tocó \(la base cayó a HEAD\): corren todas las suites/);
  // una suite roja entre las elegidas sigue siendo rojo
  f.escribir('arnes', 'tests/lee.test.js', "// lee scripts/lib/acme.js\nprocess.exit(1)\n");
  const roja = runScopedByRepo(f, { touched: { known: true, files: ['scripts/lib/acme.js'] } });
  assert.equal(roja.status, 1, roja.stdout);
  // sin texto de la CI, el modo no se prende: «no sé quién corre la completa» no acota
  const sinCi = spawnSync('node', [RUNNER, f.repo, path.join(f.root, 'o2.json'), '--skills', f.skills, '--scoped-by-repo'], { encoding: 'utf8' });
  assert.equal(sinCi.status, 2, sinCi.stderr);
});

test('T15 8.55-Suites_NoHeredanLasVariablesDelPorton @story-8.55 @ac-10 — las suites no ven las variables internas del portón', () => {
  // 🔴 mutación: cada suite hereda la clave de la evidencia y las marcas del hermano; una suite que corre su propio portón de
  //    juguete las toma como suyas (la clave renombra su copia sellada; la marca del hermano la acota).
  const f = armar({ diarias: [{ raiz: 'arnes', ruta: 'tests/eco.test.js' }] }, { conSkills: false });
  const VARS = ['TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED', 'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_STORY_REPO', 'TYCON_TEST_GATE_CROSS_REPO'];
  f.escribir('arnes', 'tests/eco.test.js', `const v = ${JSON.stringify(VARS)}.filter((k) => k in process.env); if (v.length) { console.error('heredó ' + v.join(',')); process.exit(1); }\n`);
  const env = Object.fromEntries(VARS.map((k) => [k, '1']));
  for (const extra of [[], ['--coverage', path.join(f.root, 'cov')]]) {
    const out = path.join(f.root, 'out.json');
    const r = spawnSync('node', [RUNNER, f.repo, out, '--skills', f.skills, ...extra], { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(r.status, 0, `${extra.length ? 'con' : 'sin'} cobertura la suite heredó variables del portón:\n${r.stdout}\n${r.stderr}\n${fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''}`);
  }
});

test('T15b 7.36-Suites_NoHeredanLaMarcaDelPorton @story-7.36 @ac-15 — una suite no ve TYCON_TEST_GATE', () => {
  // 🔴 mutación: test-gate.sh exporta TYCON_TEST_GATE=1 para que `marker.js run-check` anote la
  //    procedencia; cada suite la hereda, y la del freno de cierre (test-stop-dod-gate.sh) cambia de conducta: roja
  //    dentro del portón, verde sola. Se pone en rojo sacando TYCON_TEST_GATE de DEL_PORTON en run-suites-json.js.
  const f = armar({ diarias: [{ raiz: 'arnes', ruta: 'tests/eco.test.js' }] }, { conSkills: false });
  //    Lo mismo con TYCON_TEST_GATE_TREE_TOUCHED (las bases del árbol armado para el informe): heredada, el portón de
  //    juguete de test-gate-report / test-gate-runners / test-coverage-parser cuenta las líneas de otro árbol.
  const VARS = ['TYCON_TEST_GATE', 'TYCON_TEST_GATE_TREE_TOUCHED'];
  f.escribir('arnes', 'tests/eco.test.js', `const v = ${JSON.stringify(VARS)}.filter((k) => k in process.env); if (v.length) { console.error('heredó ' + v.join(',')); process.exit(1); }\n`);
  for (const extra of [[], ['--coverage', path.join(f.root, 'cov')]]) {
    const out = path.join(f.root, 'out.json');
    const r = spawnSync('node', [RUNNER, f.repo, out, '--skills', f.skills, ...extra], { encoding: 'utf8', env: { ...process.env, TYCON_TEST_GATE: '1', TYCON_TEST_GATE_TREE_TOUCHED: '/tmp/x.json' } });
    assert.equal(r.status, 0, `${extra.length ? 'con' : 'sin'} cobertura la suite heredó la marca del portón:\n${r.stdout}\n${r.stderr}`);
  }
});

test('T20 8.55-SoloLoTocado_RequireSinExtension_CodigoQueEmpiezaConTest @story-8.55 @ac-4 — la corrida cruzada no difiere una suite que prueba lo tocado', () => {
  // 🔴 mutación: una suite que carga el archivo tocado
  //    sin extensión o por su carpeta queda diferida, y un archivo de código que empieza con «test-» (test-gate.sh) se
  //    toma por otra suite: ninguna de las suites que lo nombran corre.
  const f = armar({ diarias: [
    { raiz: 'arnes', ruta: 'tests/sinext.test.js' },
    { raiz: 'arnes', ruta: 'tests/carpeta.test.js' },
    { raiz: 'arnes', ruta: 'tests/porton.test.sh' },
    { raiz: 'arnes', ruta: 'tests/otra.test.js' },
  ] }, { conSkills: false });
  f.escribir('arnes', 'tests/sinext.test.js', "require('../lib/acme');\nprocess.exit(0)\n");
  f.escribir('arnes', 'tests/carpeta.test.js', "require('../lib/gen');\nprocess.exit(0)\n");
  f.escribir('arnes', 'tests/porton.test.sh', 'bash "$(dirname "$0")/../test-gate.sh" --help >/dev/null 2>&1; exit 0\n');
  f.escribir('arnes', 'tests/otra.test.js', 'process.exit(0)\n');
  f.escribir('arnes', 'lib/acme.js', 'module.exports = 1;\n');
  f.escribir('arnes', 'lib/gen/index.js', 'module.exports = 2;\n');
  f.escribir('arnes', 'test-gate.sh', 'exit 0\n');
  const r = runOnlyTouched(f, { touched: { known: true, files: ['scripts/lib/acme.js', 'scripts/lib/gen/index.js', 'scripts/test-gate.sh'] } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(r.resumen.deferred_suites.map((d) => path.basename(d.suite)), ['otra.test.js'], JSON.stringify(r.resumen.deferred_suites));
  assert.equal(r.resumen.corridas, 3);
});

test('T21 8.55-AusenteYDiferidas_ElMotivoDiceLaVerdad @story-8.55 @ac-5 — con una ausente y el resto diferidas, el rojo no dice «todas ausentes»', () => {
  // 🔴 mutación: el motivo dice «todas las suites declaradas están ausentes» con una suite
  //    existente diferida en el mismo resumen. La ausente sigue siendo rojo.
  const f = armar({ diarias: [{ raiz: 'arnes', ruta: 'tests/a.test.js' }, { raiz: 'arnes', ruta: 'tests/fantasma.test.js' }] }, { conSkills: false });
  f.escribir('arnes', 'tests/a.test.js', 'process.exit(0)\n');
  const r = runOnlyTouched(f, { touched: { known: true, files: ['scripts/lib/nada.js'] } });
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.resumen.no_medido || '', /todas las suites declaradas están ausentes/);
  assert.match(r.resumen.no_medido || '', /1 ausente.*1 diferida/);
});

test('T22 7.51-Coverage_DeclaresExclude_SoTestNamedFilesAreMeasured @story-7.51 @ac-16 — un archivo llamado test-*.js se mide', (t) => {
  // 🔴 mutación: lanzar la suite sin `--test-coverage-exclude`; Node aplica su exclusión de fábrica y `test-acme.js` no
  //    aparece en el lcov (la receta y el informe de la puerta salían «sin datos de cobertura»).
  if (!process.allowedNodeEnvironmentFlags.has('--test-coverage-exclude')) { t.skip('NO MEDIDO: este Node no tiene --test-coverage-exclude'); return; }
  const f = armar({ diarias: [{ raiz: 'arnes', ruta: 'tests/usa-test-acme.test.js' }] });
  f.escribir('arnes', 'lib/test-acme.js', 'module.exports = (n) => (n > 0 ? "sí" : "no");\n');
  f.escribir('arnes', 'tests/usa-test-acme.test.js', "require('../lib/test-acme.js')(1);\nprocess.exit(0)\n");
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  const cov = path.join(f.root, 'cov');
  const out = path.join(f.root, 'out.json');
  const r = spawnSync(process.execPath, [RUNNER, f.repo, out, '--skills', f.skills, '--coverage', cov], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const lcov = fs.readFileSync(path.join(cov, 'lcov.info'), 'utf8');
  assert.match(lcov, /^SF:.*lib[\\/]test-acme\.js$/m, 'el código llamado test-*.js está en el lcov');
  assert.doesNotMatch(lcov, /coverage-wrapper/, 'el envoltorio sigue afuera');
  assert.doesNotMatch(lcov, /usa-test-acme\.test\.js/, 'la suite sigue afuera');
});

// Las suites del grupo `installer` de scripts/ci/heavy-suites.json corren en el portón sólo si la story toca el
// instalador o la suite misma: el criterio de la validación de Azure, leído con el selector del repo que se mide
// (scripts/ci/suites-for-change.js). Sin poder leerlo, o sin saber qué se tocó, corren.
const SELECTOR = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'ci', 'suites-for-change.js');
const NO_SELECTOR = !fs.existsSync(SELECTOR) && 'NO MEDIDO — sin scripts/ci/suites-for-change.js (dos repos físicos)';
function installerLab({ selector = true, heavy = null } = {}) {
  const f = armar({ diarias: [
    { raiz: 'arnes', ruta: 'tests/verde.test.sh' },
    { raiz: 'arnes', ruta: 'tests/inst.test.sh' },
  ] });
  f.escribir('arnes', 'tests/verde.test.sh', 'exit 0');
  f.escribir('arnes', 'tests/inst.test.sh', 'echo "corrió la del instalador"; exit 1');
  if (selector) f.escribir('arnes', 'ci/suites-for-change.js', fs.readFileSync(SELECTOR, 'utf8'));
  f.escribir('arnes', 'ci/heavy-suites.json', heavy !== null ? heavy : JSON.stringify({
    groups: { installer: { patterns: ['scripts/setup/**'] } },
    suites: { 'inst.test.sh': { group: 'installer', patterns: ['scripts/tests/inst.test.sh'] } },
  }));
  return f;
}

test('RunSuites_InstallerGroup_DeferredWhenTheStoryDoesNotTouchIt — la del instalador queda diferida y se dice por qué', { skip: NO_SELECTOR }, () => {
  // 🔴 mutación: no mirar heavy-suites.json → la del instalador corre (exit 1).
  const r = runWith(installerLab(), { touched: { known: true, files: ['guides/x.md', 'scripts/lib/a.js'] } });
  assert.equal(r.status, 0, `esperaba 0: ${r.stdout}${r.stderr}`);
  assert.equal(r.resumen.corridas, 1);
  assert.equal(r.resumen.deferred_suites.length, 1);
  assert.match(r.resumen.deferred_suites[0].suite, /inst\.test\.sh$/);
  assert.match(r.resumen.deferred_suites[0].reason, /no toca el instalador/);
  assert.match(r.stdout, /DIFERIDA inst\.test\.sh/);
});

test('RunSuites_InstallerGroup_RunsWhenInDoubt — tocar el instalador, la suite, el criterio; sin lista, sin selector o con todo pedido: corre', { skip: NO_SELECTOR }, () => {
  // 🔴 mutación: diferir siempre → una story del instalador cierra sin sus suites.
  const touching = ['scripts/setup/harness/a.js', 'scripts/tests/inst.test.sh', 'scripts/ci/heavy-suites.json', 'scripts/ci/suites-for-change.js'];
  for (const file of touching) {
    const r = runWith(installerLab(), { touched: { known: true, files: [file] } });
    assert.equal(r.status, 1, `${file}: la del instalador corre\n${r.stdout}`);
  }
  const cases = [
    [installerLab(), { touched: { known: false, reason: 'x' } }, 'sin saber qué se tocó'],
    [installerLab({ selector: false }), { touched: { known: true, files: ['guides/x.md'] } }, 'sin el selector'],
    [installerLab({ heavy: '{ roto' }), { touched: { known: true, files: ['guides/x.md'] } }, 'con el criterio roto'],
    [installerLab(), { touched: { known: true, files: ['guides/x.md'] }, env: { TYCON_GATE_ALL_SUITES: '1' } }, 'con TYCON_GATE_ALL_SUITES=1'],
  ];
  for (const [f, opts, why] of cases) {
    const r = runWith(f, opts);
    assert.equal(r.status, 1, `${why}: la del instalador corre\n${r.stdout}${r.stderr}`);
  }
  const broken = runWith(installerLab({ selector: false }), { touched: { known: true, files: ['guides/x.md'] } });
  assert.match(broken.stdout + broken.stderr, /no pude leer el criterio del instalador/, 'y lo dice');
});

// Una suite de juguete con el caso roto en el medio de una salida larga: queda fuera de las últimas 25 líneas.
const SUITE_LARGA = [
  'for (let i = 0; i < 400; i++) console.log(`ruido ${i}`);',
  "console.log('✖ el candado choca con otra sesión (12ms)');",
  "console.log('  otra sesión está actualizando (candado de prueba)');",
  "console.log('not ok 3 - el segundo caso roto');",
  'for (let i = 400; i < 800; i++) console.log(`ruido ${i}`);',
  'process.exit(1);',
].join('\n');

test('RunSuites_RedSuite_KeepsFailedCasesAndFullOutput — el caso roto fuera de la cola queda en el resumen, con la ruta de la salida entera', () => {
  // 🔴 mutación: guardar sólo la cola (las últimas 25 líneas) → el caso del medio se pierde y el rojo no se puede leer.
  const f = armar({ diarias: [{ raiz: 'arnes', ruta: 'tests/larga.test.js' }] }, { conSkills: false });
  f.escribir('arnes', 'tests/larga.test.js', SUITE_LARGA);
  const out = path.join(f.root, 'out.json');
  const r = spawnSync('node', [RUNNER, f.repo, out, '--skills', f.skills], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  const resumen = JSON.parse(fs.readFileSync(out, 'utf8'));
  const falla = resumen.fallas[0];
  assert.doesNotMatch(falla.cola, /el candado choca/, 'el juguete pone el caso fuera de la cola');
  const casos = (falla.casos || []).join('\n');
  assert.match(casos, /✖ el candado choca con otra sesión/, 'el caso con «✖» llega al resumen');
  assert.match(casos, /otra sesión está actualizando/, 'con el texto que lo explica');
  assert.match(casos, /not ok 3 - el segundo caso roto/, 'y el de TAP también');
  assert.doesNotMatch(casos, /ruido/, 'sin el ruido de alrededor');
  assert.ok(falla.salida_completa && fs.existsSync(falla.salida_completa), `la salida entera queda en un archivo: ${falla.salida_completa}`);
  const entera = fs.readFileSync(falla.salida_completa, 'utf8');
  assert.match(entera, /ruido 0\n/);
  assert.match(entera, /ruido 799\n/);
  assert.equal(typeof falla.ms, 'number', 'con el tiempo de la suite');
  assert.match(r.stdout, /✖ el candado choca con otra sesión/, 'el resumen de la consola nombra el caso');
  assert.ok(r.stdout.includes(falla.salida_completa), 'y la ruta del archivo entero');
});

test('RunSuites_RedSuite_RecordsTheGateEnvironment — el resumen dice con qué marcas corrió, si fue con run-check y qué variables se quitaron', () => {
  // 🔴 mutación: no anotar el ambiente → un rojo que sólo pasa dentro de la puerta no deja rastro de qué cambia.
  const f = armar({ diarias: [{ raiz: 'arnes', ruta: 'tests/larga.test.js' }] }, { conSkills: false });
  f.escribir('arnes', 'tests/larga.test.js', SUITE_LARGA);
  const out = path.join(f.root, 'out.json');
  const env = { ...process.env, TYCON_TEST_GATE: '1', TYCON_SUITE_RUNNER: 'test-gate', TYCON_MAILBOX: '0', TYCON_TEST_SECRET: 'no-se-imprime' };
  const r = spawnSync('node', [RUNNER, f.repo, out, '--skills', f.skills, '--run-check', 'tests-suite'], { encoding: 'utf8', env });
  assert.equal(r.status, 1, r.stderr);
  const amb = JSON.parse(fs.readFileSync(out, 'utf8')).ambiente || {};
  assert.equal(amb.run_check, 'tests-suite');
  assert.equal(amb.marks.TYCON_SUITE_RUNNER, 'test-gate');
  assert.equal(amb.marks.TYCON_MAILBOX, '0');
  assert.ok(amb.removed.includes('TYCON_TEST_GATE'), 'la marca que la suite no ve también se anota');
  assert.ok(amb.other_names.includes('TYCON_TEST_SECRET'), 'de las demás variables del arnés va el nombre');
  assert.doesNotMatch(JSON.stringify(amb) + r.stdout, /no-se-imprime/, 'pero nunca su valor');
  assert.equal(typeof amb.workers, 'number');
  assert.match(r.stdout, /run-check tests-suite/, 'la consola lo dice');
  const sin = spawnSync('node', [RUNNER, f.repo, out, '--skills', f.skills], { encoding: 'utf8' });
  assert.equal(sin.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).ambiente.run_check, null, 'sin la marca, sin run-check');
  const sinValor = spawnSync('node', [RUNNER, f.repo, out, '--skills', f.skills, '--run-check'], { encoding: 'utf8' });
  assert.equal(sinValor.status, 2, '--run-check sin nombre es un error de uso');
});

test('RunSuites_FullOutput_CappedKeepsHeadAndTail — la salida entera tiene un tope en bytes por suite y guarda el principio y el final', () => {
  // 🔴 mutación: escribir la salida sin tope en saveFullOutput (una suite que escupe megas llena el disco), recortar sólo
  //    por la cola, o contar caracteres en vez de bytes.
  const { capOutput, saveFullOutput, failedCases } = require(RUNNER);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suites-cap-'));
  const out = path.join(root, 'suites.json');
  const amb = { run_check: null, workers: 1, marks: {}, removed: [], other_names: [] };
  const r = { idx: 3, ruta: '/x/tests/larga.test.js', exit: 1, ms: 5, salida: `${'a'.repeat(5000)}MEDIO${'z'.repeat(5000)}` };
  const g = saveFullOutput(out, r, amb, { left: 1e9 }, 1000);
  assert.equal(g.truncated, true);
  const texto = fs.readFileSync(g.file, 'utf8');
  assert.ok(fs.statSync(g.file).size < 1500, `el archivo quedó de ${fs.statSync(g.file).size} bytes con tope de 1000`);
  assert.match(texto, /a{400}/);
  assert.match(texto, /z{400}$/);
  assert.doesNotMatch(texto, /MEDIO/);
  assert.match(texto, /recortad/);
  // en bytes: 1000 «ñ» son 2000 bytes; con tope de 1000 no entran enteras
  const multi = capOutput('ñ'.repeat(1000), 1000);
  assert.equal(multi.truncated, true, 'el tope cuenta bytes, no caracteres');
  assert.ok(Buffer.byteLength(multi.text) < 1200);
  assert.deepEqual(capOutput('corto', 200), { text: 'corto', truncated: false });
  // los formatos de falla de las suites del arnés, con colores y sin la línea de título del reportero de Node
  const casos = failedCases(['\u001b[31m✖ uno\u001b[39m', 'ok 1 - bien', 'MAL dos', '❌ tres', 'FAIL cuatro', '✖ failing tests:', '  ✖ uno', 'bien'].join('\n'));
  assert.deepEqual(casos, ['✖ uno', 'MAL dos', '❌ tres', 'FAIL cuatro']);
});

test('RunSuites_FullOutput_RunBudget — pasado el tope de la corrida, de las suites que siguen queda sólo el resumen de sus casos, y se dice', () => {
  // 🔴 mutación: no descontar lo escrito del tope de la corrida → muchas suites rojas escriben cada una sus 8 MB.
  const { saveFullOutput } = require(RUNNER);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suites-budget-'));
  const out = path.join(root, 'suites.json');
  const amb = { run_check: null, workers: 1, marks: {}, removed: [], other_names: [] };
  const budget = { left: 3000 };
  const una = (idx) => ({ idx, ruta: `/x/tests/s${idx}.test.js`, exit: 1, ms: 1, salida: 'x'.repeat(2500) });
  const a = saveFullOutput(out, una(1), amb, budget, 1e6);
  const b = saveFullOutput(out, una(2), amb, budget, 1e6);
  const c = saveFullOutput(out, una(3), amb, budget, 1e6);
  assert.ok(a.file && fs.existsSync(a.file), 'la primera entra entera');
  assert.ok(b.file && b.truncated, 'la segunda entra recortada a lo que le queda a la corrida');
  assert.equal(c.file, null, 'la tercera ya no se escribe');
  assert.match(c.skipped, /tope .*corrida.*casos/);
  const total = [a.file, b.file].reduce((n, f) => n + fs.statSync(f).size, 0);
  assert.ok(total < 3000 + 600, `entre todas escribieron ${total} bytes con tope de 3000`);
});

test('TestGate_OldResultFolders_Pruned — al arrancar, la puerta borra sus carpetas de más de 7 días, sólo las suyas y sólo en el temporal', () => {
  // 🔴 mutación: borrar por prefijo sin mirar el nombre exacto, la edad o si es un enlace; o no llamarlo desde la puerta.
  const { pruneOldResults } = require(path.join(__dirname, '..', 'lib', 'old-gate-results.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-prune-'));
  const afuera = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-prune-afuera-'));
  const viejo = (Date.now() - 8 * 86400000) / 1000;
  const mk = (name, old) => { const d = path.join(root, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'f'), 'x'); if (old) fs.utimesSync(d, viejo, viejo); return d; };
  const vieja = mk('test-gate-Ab12Cd', true);
  const nueva = mk('test-gate-Zz99Yy', false);
  const otroNombre = mk('test-gate-mia-de-otro', true);
  const ajena = mk('otra-cosa-Ab12Cd', true);
  fs.writeFileSync(path.join(afuera, 'f'), 'x');
  fs.symlinkSync(afuera, path.join(root, 'test-gate-Enlace'));
  fs.lutimesSync(path.join(root, 'test-gate-Enlace'), viejo, viejo);
  const deOtro = mk('test-gate-Otro01', true);
  pruneOldResults(root, { uid: process.getuid() + 1, now: Date.now() });
  assert.ok(fs.existsSync(deOtro), 'la de otro usuario no se toca');
  const borradas = pruneOldResults(root);
  assert.deepEqual(borradas.sort(), [deOtro, vieja].sort());
  for (const d of [nueva, otroNombre, ajena]) assert.ok(fs.existsSync(d), `${path.basename(d)} queda`);
  assert.ok(fs.existsSync(path.join(afuera, 'f')), 'un enlace no se sigue');
  const gate = fs.readFileSync(path.join(__dirname, '..', 'test-gate.sh'), 'utf8');
  const llamada = gate.indexOf('lib/old-gate-results.js" /tmp');
  assert.ok(llamada >= 0 && llamada < gate.indexOf('mktemp -d /tmp/test-gate-XXXXXX'), 'la puerta limpia el mismo temporal donde crea su carpeta, antes de crearla');
});
