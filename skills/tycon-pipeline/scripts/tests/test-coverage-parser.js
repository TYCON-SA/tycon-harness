#!/usr/bin/env node
/**
 * Guard del cálculo de COBERTURA de test-gate.sh (2026-08-25).
 *
 * 🔴 Por qué existe. El % de cobertura sobre los archivos nuevos es un gate del pipeline
 * (>75%), y lo calculaba un bloque Python embebido en test-gate.sh que NADIE testeaba —
 * medido: cero tests sobre él hasta hoy. Ese bloque tomaba el `max(line-rate)` por
 * filename, y en C# cada método `async` compila a una clase APARTE con el MISMO filename:
 * para un repository que los tests mockean, la clase "real" tiene sólo el constructor y da
 * line-rate=1, las máquinas de estado con las consultas dan 0, y el max() se quedaba con
 * el 1. Reproducido contra el cobertura REAL de un producto del equipo: un repository
 * (acá `OrderImportRepository.cs`, nombre cambiado) reportaba 100.0% y su valor real es 13.3% (8 líneas de 60);
 * 45 de sus 187 archivos con datos inflaban más de 5 puntos, el peor 86.7. El gate que
 * debía avisar "no probaste la capa de datos" decía que estaba cubierta.
 *
 * Desde la story 8.17 (tanda W6) el cálculo ya no es un bloque de Python embebido: es
 * lib/test-gate-report.js, y este test lo corre como lo corre test-gate.sh (mismo argv). Que
 * el JSON sea el mismo que escribía el Python lo prueba tests/test-gate-report.test.js (T69).
 *
 * Correr: node tests/test-coverage-parser.js   (exit 0 OK, exit 1 fail).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- el informe de test-gate.sh, tal cual lo llama en producción (story 8.17: antes era un heredoc de Python).
const REPORT = path.join(__dirname, '..', 'lib', 'test-gate-report.js');

// --- un cobertura.xml sintético: `clases` = [{name, filename, lines: [hits...]}, …]
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function cobertura(clases) {
  const cls = clases.map((c) => {
    const lines = (c.lines || []).map((h, i) => `<line number="${i + 1}" hits="${h}"/>`).join('');
    const total = (c.lines || []).length;
    const cov = (c.lines || []).filter((h) => h > 0).length;
    const lr = c.lineRate !== undefined ? c.lineRate : (total ? cov / total : 1);
    return `<class name="${esc(c.name)}" filename="${esc(c.filename)}" line-rate="${lr}">`
      + `<lines>${lines}</lines></class>`;
  }).join('');
  return `<?xml version="1.0"?><coverage line-rate="0.5"><packages><package name="P">`
    + `<classes>${cls}</classes></package></packages></coverage>`;
}

// --- corre el parser real sobre un escenario y devuelve el % del archivo nuevo.
//     `assemblies` = [ [clases del cobertura 1], [clases del cobertura 2], … ]
//     `opts.commit` = commitear el archivo (git deja de reportarlo como nuevo — es el estado
//     de una iteración de fix POSTERIOR al commit). `opts.declared` = lo que la story declara
//     en `files_to_create`, tal como se lo pasa test-gate.sh (argv 13).
function correr(nuevoArchivo, assemblies, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covp-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.dirname(path.join(repo, nuevoArchivo)), { recursive: true });
  fs.writeFileSync(path.join(repo, nuevoArchivo), '// código nuevo de la story\n');
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  if (opts.commit) {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    };
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore', env });
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'story'], { stdio: 'ignore', env });
  }
  const results = path.join(tmp, 'TestResults');
  assemblies.forEach((clases, i) => {
    const d = path.join(results, `asm-${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'coverage.cobertura.xml'), cobertura(clases));
  });
  const out = path.join(tmp, 'out.json');
  execFileSync(process.execPath, [REPORT, 'dotnet', repo, repo, results, out, '0', '9.9', '75',
    '2026-01-01T00:00:00Z', '1', 'src', 'explicito', (opts.declared || []).join('\n')],
    { stdio: 'ignore' });
  return JSON.parse(fs.readFileSync(out, 'utf8')).coverage;
}

console.log('test-gate — cálculo de cobertura:');

// 1. EL CASO REAL: async → una clase por método, todas con el mismo filename.
//    Números tomados del cobertura real de un producto del equipo (los nombres están cambiados).
{
  const F = 'AcmeBackend/Features/Orders/Imports/OrderImportRepository.cs';
  const ocho = Array(8).fill(1);
  const c = correr(F, [[
    { name: 'OrderImportRepository', filename: F, lines: ocho },                          // ctor: 8/8
    { name: 'OrderImportRepository/<GetExistingHashesAsync>d__3', filename: F, lines: Array(24).fill(0) },
    { name: 'OrderImportRepository/<GetSourceAsync>d__2', filename: F, lines: Array(16).fill(0) },
    { name: 'OrderImportRepository/<GetNextBatchAsync>d__4', filename: F, lines: Array(6).fill(0) },
    { name: 'OrderImportRepository/<InsertBatchAsync>d__5', filename: F, lines: Array(6).fill(0) },
  ]]);
  const pct = c.per_new_file[F];
  check('async: 8 líneas de 60 → 13.3%, NO el 100% de la clase del constructor',
    pct === 13.3, `dio ${pct}`);
  check('…y por lo tanto el gate del 75% BLOQUEA', c.meets_threshold === false, `meets=${c.meets_threshold}`);
  // @story-2.4 @ac-2 — sin base (llamada vieja) no hay líneas tocadas: el umbral se juzga sobre los archivos nuevos.
  check('…sobre la base de los archivos nuevos (threshold_basis new_files)', c.threshold_basis === 'new_files',
    `basis=${c.threshold_basis}`);
}

// 2. La razón por la que el max() existe SIGUE cubierta: entre cobertura DISTINTOS (un
//    assembly que no tocó el archivo lo reporta en 0) se toma el mejor, no el promedio.
{
  const F = 'src/Servicio.cs';
  const c = correr(F, [
    [{ name: 'Servicio', filename: F, lines: Array(50).fill(0) }],                        // assembly que no lo ejerció
    [{ name: 'Servicio', filename: F, lines: Array(50).fill(0).map((_, i) => (i < 45 ? 1 : 0)) }], // el que sí: 45/50
  ]);
  check('entre cobertura distintos sigue ganando el mejor (90%, no 45%)',
    c.per_new_file[F] === 90.0, `dio ${c.per_new_file[F]}`);
}

// 3. El orden de los cobertura no cambia el resultado (el glob NO es determinístico).
{
  const F = 'src/Servicio.cs';
  const c = correr(F, [
    [{ name: 'Servicio', filename: F, lines: Array(50).fill(0).map((_, i) => (i < 45 ? 1 : 0)) }],
    [{ name: 'Servicio', filename: F, lines: Array(50).fill(0) }],
  ]);
  check('el orden de los cobertura no cambia el resultado', c.per_new_file[F] === 90.0, `dio ${c.per_new_file[F]}`);
}

// 4. Una clase SIN líneas medibles (interface, record sin cuerpo) no inventa un 0 que
//    bloquearía de más: se cae al line-rate declarado.
{
  const F = 'src/IContrato.cs';
  const c = correr(F, [[{ name: 'IContrato', filename: F, lines: [], lineRate: 1 }]]);
  check('clase sin líneas medibles → cae al line-rate, no a 0', c.per_new_file[F] === 100.0,
    `dio ${c.per_new_file[F]}`);
}

// 5. Un archivo sin datos en NINGÚN cobertura queda declarado como tal — no como 0% ni
//    como 100%. Es la diferencia entre "lo medí y está mal" y "no lo medí".
{
  const c = correr('src/Nuevo.cs', [[{ name: 'Otro', filename: 'src/Otro.cs', lines: [1, 1] }]]);
  check('archivo sin datos de cobertura → null y declarado, no 0 ni 100',
    c.per_new_file['src/Nuevo.cs'] === null && c.new_files_without_coverage_data.includes('src/Nuevo.cs'),
    JSON.stringify(c.per_new_file));
}

// --- Respaldo post-commit (hallazgo de otra persona del equipo, 2026-08-25) ------------------------------
// El modo de falla: apenas la story se commitea, `--diff-filter=A` no reporta nada, el cruce
// de cobertura no se hace, y el reporte publicaba `new_files_pct: null` SIN decir por qué —
// que se lee igual que "esto está bien".

// 6. LA REGRESIÓN: post-commit, sin respaldo, el cruce se perdía en silencio.
{
  const F = 'src/Servicio.cs';
  const cls = [{ name: 'Servicio', filename: F, lines: Array(50).fill(0).map((_, i) => (i < 45 ? 1 : 0)) }];
  const c = correr(F, [cls], { commit: true });
  check('post-commit sin declaración → NO hay cruce…', c.new_files_pct === null,
    `dio ${c.new_files_pct}`);
  check('…pero el reporte lo DICE (no un null mudo)',
    typeof c.no_cross_check === 'string' && c.no_cross_check.length > 0,
    JSON.stringify(c.no_cross_check));
}

// 7. Con la story declarando `files_to_create`, el cruce se recupera post-commit.
{
  const F = 'src/Servicio.cs';
  const cls = [{ name: 'Servicio', filename: F, lines: Array(50).fill(0).map((_, i) => (i < 45 ? 1 : 0)) }];
  const c = correr(F, [cls], { commit: true, declared: [F, 'src/Servicio.test.ts', 'docs/nota.md'] });
  check('post-commit con files_to_create → el cruce vuelve (90%)', c.new_files_pct === 90.0,
    `dio ${c.new_files_pct}`);
  check('…y queda dicho de dónde salió la lista', c.new_files_source === 'story:files_to_create',
    `dio ${c.new_files_source}`);
  check('…sin arrastrar tests ni no-código', Object.keys(c.per_new_file).join(',') === F,
    JSON.stringify(Object.keys(c.per_new_file)));
  check('…y sin la nota de "no hubo cruce"', c.no_cross_check === undefined,
    JSON.stringify(c.no_cross_check));
}

// 8. Lo declarado que NO existe en el repo no se inventa como archivo nuevo: se lista aparte
//    (si no, un rename viejo en el frontmatter metería un `null` que parece falta de tests).
{
  const F = 'src/Servicio.cs';
  const cls = [{ name: 'Servicio', filename: F, lines: Array(50).fill(1) }];
  const c = correr(F, [cls], { commit: true, declared: [F, 'src/Fantasma.cs'] });
  check('declarado inexistente → no entra al cruce, queda declarado aparte',
    !('src/Fantasma.cs' in c.per_new_file) && (c.declared_not_found || []).includes('src/Fantasma.cs'),
    JSON.stringify({ per: Object.keys(c.per_new_file), nf: c.declared_not_found }));
}

// 9. Pre-commit (untracked) sigue ganándole al respaldo: git es la fuente cuando tiene algo.
{
  const F = 'src/Servicio.cs';
  const cls = [{ name: 'Servicio', filename: F, lines: Array(50).fill(1) }];
  const c = correr(F, [cls], { declared: ['src/Otro.cs'] });
  check('pre-commit → la fuente sigue siendo git, no la declaración',
    c.new_files_source === 'git' && !('src/Otro.cs' in c.per_new_file),
    JSON.stringify({ src: c.new_files_source, per: Object.keys(c.per_new_file) }));
}

// =============================================================================================
// Story 2.4 — cobertura de las LÍNEAS TOCADAS (@story-2.4). El parser recibe la base del diff en
// argv 15 (ref) y 16 (JSON {source, descartadas}); con HOME falso, la línea de observación va al
// gates.log de ese HOME y no al real.
// =============================================================================================
console.log('');
console.log('test-gate — cobertura de las líneas tocadas (story 2.4):');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
const lineas = (n, f = (i) => `linea ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

// Cobertura con números de línea EXPLÍCITOS: `numbered` = [[línea, hits], …].
function coberturaNumerada(clases) {
  const cls = clases.map((c) => {
    const ls = c.numbered.map(([n, h]) => `<line number="${n}" hits="${h}"/>`).join('');
    return `<class name="${esc(c.name)}" filename="${esc(c.filename)}" line-rate="0.5"><lines>${ls}</lines></class>`;
  }).join('');
  return `<?xml version="1.0"?><coverage line-rate="0.5"><packages><package name="P"><classes>${cls}</classes></package></packages></coverage>`;
}

/**
 * opts: base {ruta: contenido} (commiteado como base) · despues {ruta: contenido} commiteado después
 * de la base · ahora {ruta: contenido} sin commitear · runner · dotnet [clases numeradas] ·
 * final (coverage-final.json, rutas relativas → se hacen absolutas) · baseRef (default: la base) ·
 * baseJson · coberturaRota.
 */
function correrTocadas(opts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covt-'));
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const escribir = (m) => Object.entries(m || {}).forEach(([r, c]) => {
    fs.mkdirSync(path.dirname(path.join(repo, r)), { recursive: true });
    fs.writeFileSync(path.join(repo, r), c);
  });
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  escribir(opts.base);
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base', '--allow-empty']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  if (opts.despues) { escribir(opts.despues); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'despues']); }
  for (const [de, a] of opts.mover || []) {
    fs.mkdirSync(path.dirname(path.join(repo, a)), { recursive: true });
    git(repo, ['mv', de, a]);
  }
  escribir(opts.ahora);
  for (const r of opts.ilegibles || []) fs.chmodSync(path.join(repo, r), 0o000);
  const repoRun = opts.repoRunSub ? path.join(repo, opts.repoRunSub) : repo;
  const runner = opts.runner || 'dotnet';
  const results = path.join(tmp, 'TestResults');
  fs.mkdirSync(path.join(results, 'asm-0'), { recursive: true });
  if (opts.dotnet) {
    fs.writeFileSync(path.join(results, 'asm-0', 'coverage.cobertura.xml'),
      opts.coberturaRota ? '<coverage><roto' : coberturaNumerada(opts.dotnet));
  }
  if (opts.final) {
    const abs = {};
    for (const [r, e] of Object.entries(opts.final)) {
      const k = opts.finalRelativo ? r : path.join(repo, r);
      abs[k] = { path: k, ...e };
    }
    fs.mkdirSync(path.join(repoRun, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(repoRun, 'coverage', 'coverage-final.json'), JSON.stringify(abs));
  }
  const out = path.join(tmp, 'out.json');
  const baseRef = opts.baseRef !== undefined ? opts.baseRef : baseSha;
  const baseJson = opts.baseJson || JSON.stringify({ source: 'marcador', descartadas: [] });
  const r = require('child_process').spawnSync(process.execPath, [REPORT, runner, repo, repoRun, results, out, '0', '9.9', '75',
    '2026-09-16T00:00:00Z', '1', '', '', '', '{"git":false}', baseRef, baseJson],
  { encoding: 'utf8', env: { ...process.env, HOME: home, ...(opts.env || {}) } });
  const gl = path.join(home, '.claude', '.tycon-pipeline', 'gates.log');
  const gates = fs.existsSync(gl) ? fs.readFileSync(gl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  let res = null;
  try { res = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { /* queda null: el caso lo reporta */ }
  return { res, cov: res ? res.coverage : {}, gates, rc: r.status, stderr: r.stderr, repo, home, baseSha };
}

// T1 · 10 líneas medibles tocadas, 6 cubiertas → 60 % y el umbral NO se cumple. @ac-1 @ac-2
// Rojo previo: con los archivos nuevos como denominador (el archivo no es nuevo) sale null.
const T1_OPTS = {
  base: { 'src/Calc.cs': lineas(20) },
  ahora: { 'src/Calc.cs': lineas(20, (i) => (i >= 3 && i <= 12 ? `cambio ${i}` : `linea ${i}`)) },
  dotnet: [{ name: 'Calc', filename: 'src/Calc.cs',
    numbered: Array.from({ length: 20 }, (_, k) => [k + 1, (k + 1 >= 3 && k + 1 <= 8) ? 1 : ((k + 1) > 12 ? 1 : 0)]) }],
};
{
  const { cov } = correrTocadas(T1_OPTS);
  check('T1 10 tocadas, 6 cubiertas → touched_lines_pct 60.0', cov.touched_lines_pct === 60.0, `dio ${cov.touched_lines_pct}`);
  check('T1 …con measurable 10 y covered 6', cov.touched_lines && cov.touched_lines.measurable === 10 && cov.touched_lines.covered === 6,
    JSON.stringify(cov.touched_lines));
  check('T1 …y el umbral se evalúa sobre las tocadas (no se cumple)',
    cov.meets_threshold === false && cov.threshold_basis === 'touched_lines',
    `meets=${cov.meets_threshold} basis=${cov.threshold_basis}`);
  check('T1 …new_files_pct se sigue publicando con su nombre', 'new_files_pct' in cov, JSON.stringify(Object.keys(cov)));
}

// T2 · las líneas que el reporte no lista (vacías, comentarios) no entran al denominador. @ac-1
// Rojo previo: contar toda línea del diff → 2 de 6 = 33.3.
{
  const { cov } = correrTocadas({
    base: { 'src/B.cs': lineas(5) },
    ahora: { 'src/B.cs': lineas(5) + '\n// c\n\n// d\nx = 1;\ny = 2;\n' },
    dotnet: [{ name: 'B', filename: 'src/B.cs', numbered: [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [10, 1], [11, 1]] }],
  });
  check('T2 sólo las medibles cuentan → 2 de 2 = 100.0',
    cov.touched_lines_pct === 100.0 && cov.touched_lines && cov.touched_lines.measurable === 2,
    JSON.stringify({ pct: cov.touched_lines_pct, tl: cov.touched_lines }));
}

// T3 · vitest y jest: las líneas salen de statementMap (una línea es medible si una sentencia
// EMPIEZA en ella). @ac-3 — Rojo previo: leer sólo `s` → no hay líneas → null.
{
  const final = { 'src/foo.ts': {
    statementMap: { 0: { start: { line: 4, column: 0 }, end: { line: 4, column: 9 } },
      1: { start: { line: 5, column: 0 }, end: { line: 6, column: 3 } },
      2: { start: { line: 9, column: 0 }, end: { line: 9, column: 3 } } },
    s: { 0: 1, 1: 0, 2: 5 }, fnMap: {}, f: {}, branchMap: {}, b: {},
  } };
  const opts = (runner) => ({
    runner, base: { 'src/foo.ts': lineas(10) },
    ahora: { 'src/foo.ts': lineas(10, (i) => (i >= 4 && i <= 6 ? `cambio ${i}` : `linea ${i}`)) },
    final,
  });
  const v = correrTocadas(opts('vitest')).cov;
  const j = correrTocadas(opts('jest')).cov;
  check('T3 vitest: línea 4 cubierta, 5 no, 6 no medible → 50.0', v.touched_lines_pct === 50.0, `dio ${v.touched_lines_pct}`);
  check('T3 jest da lo mismo que vitest', j.touched_lines_pct === 50.0, `dio ${j.touched_lines_pct}`);
}

// T4 · sin líneas tocadas → null con motivo, nunca 0. @ac-4
{
  const { cov, gates } = correrTocadas({ base: { 'src/A.cs': lineas(3) },
    dotnet: [{ name: 'A', filename: 'src/A.cs', numbered: [[1, 1]] }], baseRef: 'HEAD',
    baseJson: JSON.stringify({ source: 'HEAD', descartadas: [] }) });
  check('T4 sin diff → touched_lines_pct null', cov.touched_lines_pct === null, `dio ${cov.touched_lines_pct}`);
  check('T4 …y dice por qué', typeof cov.touched_no_cross_check === 'string' && cov.touched_no_cross_check.length > 0,
    JSON.stringify(cov.touched_no_cross_check));
  check('T4 …sin inventar un cero en el detalle', !cov.touched_lines || cov.touched_lines.measurable !== 0 || cov.touched_lines_pct === null,
    JSON.stringify(cov.touched_lines));
  check('T4/T8 sin medir, la observación queda como no-medido',
    gates.some((g) => g.name === 'cobertura-tocada' && g.status === 'no-medido'), JSON.stringify(gates));
}

// T5 · runners sin cobertura → «no produce cobertura», no el motivo de «sin diff». @ac-3
// El de suites.json sí la produce con --coverage: sin su lcov, el motivo dice que falta.
for (const [runner, motivo] of [['node-test', /no produce cobertura/], ['suites-json', /no dejó reporte de cobertura \(falta coverage\/lcov\.info/]]) {
  const { cov } = correrTocadas({ runner, base: { 'lib/a.js': lineas(3) }, ahora: { 'lib/a.js': lineas(3) + 'x();\n' } });
  check(`T5 ${runner}: touched null con el motivo de por qué no hay cobertura`,
    cov.touched_lines_pct === null && motivo.test(cov.touched_no_cross_check || ''),
    JSON.stringify({ pct: cov.touched_lines_pct, m: cov.touched_no_cross_check }));
}

// T6 · un archivo tocado sin datos se lista aparte, fuera del %. @ac-1 — Rojo previo: contarlo como 0.
{
  const o = JSON.parse(JSON.stringify(T1_OPTS));
  o.base['src/Otro.cs'] = lineas(4);
  o.ahora['src/Otro.cs'] = lineas(4) + 'nuevo();\n';
  const { cov } = correrTocadas(o);
  check('T6 archivo sin datos → listado aparte y el % no cambia (60.0)',
    (cov.touched_files_without_coverage_data || []).includes('src/Otro.cs') && cov.touched_lines_pct === 60.0,
    JSON.stringify({ sin: cov.touched_files_without_coverage_data, pct: cov.touched_lines_pct }));
}

// T7 · tests y no-código no entran. @ac-1
{
  const stm = { statementMap: { 0: { start: { line: 2, column: 0 }, end: { line: 2, column: 1 } } }, s: { 0: 1 } };
  const { cov } = correrTocadas({
    runner: 'vitest',
    base: { 'src/foo.ts': 'a\n', 'src/foo.test.ts': 'a\n', 'README.md': 'a\n' },
    ahora: { 'src/foo.ts': 'a\nb\n', 'src/foo.test.ts': 'a\nb\n', 'README.md': 'a\nb\n' },
    final: { 'src/foo.ts': stm, 'src/foo.test.ts': stm },
  });
  const archivos = Object.keys((cov.touched_lines || {}).per_file || {});
  check('T7 sólo src/foo.ts entra a las tocadas', archivos.join(',') === 'src/foo.ts', JSON.stringify(archivos));
}

// T8 · la observación deja su línea en gates.log, sin porcentajes ni rutas, y no frena. @ac-7
{
  const { res, cov, gates, rc } = correrTocadas(T1_OPTS);
  const g = gates.filter((x) => x.name === 'cobertura-tocada');
  check('T8 una línea cobertura-tocada con habria-frenado', g.length === 1 && g[0].status === 'habria-frenado', JSON.stringify(gates));
  // El repo va, como en toda línea de gates.log (appendLog de marker.js); lo que no va es el número ni
  // la ruta de un archivo: el reductor sólo lee nombre y estado. 🔴 Se mira la línea SIN sesión, fecha ni
  // repo (story 2.19): buscar «60» en la línea entera lo encontraba en el identificador de sesión (`…f609f`)
  // y el caso salía rojo según la sesión que lo corría. Mutación que lo pone rojo: escribir el porcentaje
  // o la ruta del archivo en la línea de gates.log.
  const crudo = JSON.stringify(g.map(({ sessionId, ts, repoPath, ...resto }) => resto));
  check('T8 …sin porcentajes ni rutas de archivos', !/pct|60|Calc\.cs|touched/.test(crudo), crudo);
  check('T8 …el artefacto declara la observación sin freno',
    res && res.coverage.observacion && res.coverage.observacion.frena === false && res.coverage.observacion.hasta === '2026-10-06',
    JSON.stringify(cov.observacion));
  check('T8 …y el parser sale 0 (no cambia el exit del gate)', rc === 0, `rc=${rc}`);
  check('T8 …la base usada queda publicada', cov.touched_base && cov.touched_base.source === 'marcador' && cov.touched_base.ref,
    JSON.stringify(cov.touched_base));
  const verde = JSON.parse(JSON.stringify(T1_OPTS));
  verde.dotnet[0].numbered = verde.dotnet[0].numbered.map(([n]) => [n, 1]);
  const g2 = correrTocadas(verde).gates.filter((x) => x.name === 'cobertura-tocada');
  check('T8 …y una corrida que cumple deja cumple', g2.length === 1 && g2[0].status === 'cumple', JSON.stringify(g2));
}

// T8c · si bash no pudo resolver la sesión, el parser usa la cadena completa, no sólo la de Claude. @ac-7
// Rojo previo: `GATE_SESSION_ID or CLAUDE_CODE_SESSION_ID` → null bajo Codex.
{
  const { gates } = correrTocadas({ ...T1_OPTS,
    env: { GATE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', TYCON_SESSION_ID: '', CODEX_SESSION_ID: 'codex-t8c' } });
  const g = gates.filter((x) => x.name === 'cobertura-tocada');
  check('T8c sesión por la cadena completa (Codex)', g.length === 1 && g[0].sessionId === 'codex-t8c', JSON.stringify(g));
}

// T10 · lo commiteado después de la base TAMBIÉN es tocado. @ac-6 — Rojo previo: diff contra HEAD.
{
  const { cov } = correrTocadas({
    base: { 'src/C.cs': lineas(6) },
    despues: { 'src/C.cs': lineas(6, (i) => (i <= 2 ? `commit ${i}` : `linea ${i}`)) },
    ahora: { 'src/C.cs': lineas(6, (i) => (i <= 2 ? `commit ${i}` : i === 5 ? 'ahora 5' : `linea ${i}`)) },
    dotnet: [{ name: 'C', filename: 'src/C.cs', numbered: [[1, 1], [2, 1], [3, 1], [4, 1], [5, 0], [6, 1]] }],
  });
  check('T10 commiteado + sin commitear → 3 tocadas medibles (2 cubiertas)',
    cov.touched_lines && cov.touched_lines.measurable === 3 && cov.touched_lines.covered === 2,
    JSON.stringify(cov.touched_lines));
}

// T14 · base inexistente o cobertura ilegible → null con motivo, sin excepción. @ac-5
{
  const a = correrTocadas({ ...T1_OPTS, baseRef: '0123456789abcdef0123456789abcdef01234567' });
  check('T14 base inexistente → null con motivo y exit 0',
    a.rc === 0 && a.cov.touched_lines_pct === null && /diff/i.test(a.cov.touched_no_cross_check || ''),
    JSON.stringify({ rc: a.rc, pct: a.cov.touched_lines_pct, m: a.cov.touched_no_cross_check, err: a.stderr.slice(-300) }));
  const b = correrTocadas({ ...T1_OPTS, coberturaRota: true });
  check('T14 cobertura ilegible → null con motivo',
    b.rc === 0 && b.cov.touched_lines_pct === null && typeof b.cov.touched_no_cross_check === 'string',
    JSON.stringify({ rc: b.rc, pct: b.cov.touched_lines_pct, m: b.cov.touched_no_cross_check }));
  const c = correrTocadas({ ...T1_OPTS, baseRef: '' });
  check('T14 sin base (argv vacío) → null con motivo, no un diff inventado',
    c.cov.touched_lines_pct === null && typeof c.cov.touched_no_cross_check === 'string',
    JSON.stringify({ pct: c.cov.touched_lines_pct, m: c.cov.touched_no_cross_check }));
}

// ---------------------------------------------------------------------------------------------
// Regresiones del pase adversarial (Step 5b, 2026-09-16). Cada caso reproduce un defecto confirmado.
// ---------------------------------------------------------------------------------------------

// T16 · el alcance de las tocadas es la carpeta que se TESTEÓ (repo_run), no el contenedor. @ac-1
// Rojo previo: con `repo` como alcance, pkgB/b.cs (fuera de la corrida) salía como «sin datos».
{
  const { cov } = correrTocadas({
    repoRunSub: 'pkgA',
    base: { 'pkgA/a.cs': lineas(3), 'pkgB/b.cs': lineas(3) },
    ahora: { 'pkgA/a.cs': lineas(4), 'pkgB/b.cs': lineas(4) },
    dotnet: [{ name: 'A', filename: 'pkgA/a.cs', numbered: [[1, 1], [2, 1], [3, 1], [4, 1]] }],
  });
  check('T16 sólo entra lo tocado dentro de la carpeta testeada',
    !(cov.touched_files_without_coverage_data || []).includes('pkgB/b.cs')
      && Object.keys((cov.touched_lines || {}).per_file || {}).join(',') === 'pkgA/a.cs',
    JSON.stringify({ sin: cov.touched_files_without_coverage_data, per: Object.keys((cov.touched_lines || {}).per_file || {}) }));
}

// T17 · dos entradas del reporte que calzan igual por sufijo = ambiguo: no se elige una, se dice. @ac-1
// Rojo previo: se quedaba con la primera del orden de glob → 100 % o 0 % según la corrida.
{
  const opts = (orden) => ({
    base: { 'Calc.cs': lineas(5) },
    ahora: { 'Calc.cs': lineas(5, (i) => `cambio ${i}`) },
    dotnet: orden.map((m) => ({ name: m, filename: `${m}/Calc.cs`,
      numbered: [1, 2, 3, 4, 5].map((n) => [n, m === 'modA' ? 1 : 0]) })),
  });
  const a = correrTocadas(opts(['modA', 'modB'])).cov;
  const b = correrTocadas(opts(['modB', 'modA'])).cov;
  check('T17 el orden del reporte no cambia el resultado', a.touched_lines_pct === b.touched_lines_pct,
    `${a.touched_lines_pct} vs ${b.touched_lines_pct}`);
  check('T17 …y el archivo ambiguo se declara, no se mide',
    a.touched_lines_pct === null && (a.touched_files_ambiguous || []).includes('Calc.cs'),
    JSON.stringify({ pct: a.touched_lines_pct, amb: a.touched_files_ambiguous }));
}

// T18 · una clave relativa del reporte que no corresponde al archivo tocado no le presta cobertura. @ac-1
// Rojo previo: `moduleA/shared/util.ts` (sin tests) heredaba el 100 % de `shared/util.ts` de otro módulo.
{
  const stm = { statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
    1: { start: { line: 2, column: 0 }, end: { line: 2, column: 1 } } }, s: { 0: 3, 1: 3 } };
  const { cov } = correrTocadas({
    runner: 'vitest',
    base: { 'moduleA/shared/util.ts': 'a\nb\n', 'moduleB/shared/util.ts': 'a\nb\n' },
    ahora: { 'moduleA/shared/util.ts': 'x\ny\n' },
    final: { 'shared/util.ts': stm }, finalRelativo: true,
  });
  check('T18 no hereda la cobertura de otro archivo con la misma cola',
    cov.touched_lines_pct === null && (cov.touched_files_without_coverage_data || []).includes('moduleA/shared/util.ts'),
    JSON.stringify({ pct: cov.touched_lines_pct, sin: cov.touched_files_without_coverage_data }));
}

// T19 · un archivo renombrado sólo aporta las líneas que cambiaron. @ac-1
// Rojo previo: con --no-renames el archivo entero contaba como tocado (20 de 20).
{
  const cob = [{ name: 'L', filename: 'src/moved/Legacy.cs', numbered: Array.from({ length: 20 }, (_, k) => [k + 1, k < 2 ? 1 : 0]) }];
  const puro = correrTocadas({ base: { 'src/Legacy.cs': lineas(20) }, mover: [['src/Legacy.cs', 'src/moved/Legacy.cs']], dotnet: cob }).cov;
  check('T19 renombre sin cambios → ninguna línea tocada', puro.touched_lines_pct === null && !puro.touched_lines,
    JSON.stringify({ pct: puro.touched_lines_pct, tl: puro.touched_lines, m: puro.touched_no_cross_check }));
  const con = correrTocadas({ base: { 'src/Legacy.cs': lineas(20) }, mover: [['src/Legacy.cs', 'src/moved/Legacy.cs']],
    ahora: { 'src/moved/Legacy.cs': lineas(20, (i) => (i === 1 ? 'cambio 1' : `linea ${i}`)) }, dotnet: cob }).cov;
  check('T19 renombre con una línea cambiada → 1 tocada', con.touched_lines && con.touched_lines.measurable === 1,
    JSON.stringify(con.touched_lines));
}

// T20 · la base mal formada se dice. @ac-5 — Rojo previo: se vaciaba a {} sin señal.
{
  const { cov } = correrTocadas({ ...T1_OPTS, baseJson: '{ roto' });
  check('T20 base ilegible queda en descartadas',
    (cov.touched_base.descartadas || []).some((d) => /base/i.test(d.motivo || '')), JSON.stringify(cov.touched_base));
}

// T21 · un archivo nuevo que no se puede leer se nombra. @ac-1 — Rojo previo: se caía del cálculo en silencio.
if (process.getuid && process.getuid() !== 0) {
  const { cov } = correrTocadas({ ...T1_OPTS, ahora: { ...T1_OPTS.ahora, 'src/Nuevo.cs': 'x\n' }, ilegibles: ['src/Nuevo.cs'] });
  check('T21 archivo nuevo ilegible → touched_files_unreadable',
    (cov.touched_files_unreadable || []).includes('src/Nuevo.cs'), JSON.stringify(cov.touched_files_unreadable));
}

// T9 · la base se resuelve en orden y lo inválido se descarta con motivo. @ac-6
{
  let cb = null;
  try { cb = require('../lib/coverage-base.js'); } catch (e) { /* rojo previo: el módulo no existe */ }
  check('T9 existe lib/coverage-base.js con resolver()', cb && typeof cb.resolver === 'function', 'no se pudo cargar');
  if (cb && typeof cb.resolver === 'function') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covb-'));
    const repo = path.join(tmp, 'r');
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'a'), '1');
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'c1']);
    const c1 = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['switch', '-qc', 'otra']);
    fs.writeFileSync(path.join(repo, 'a'), 'otra'); git(repo, ['commit', '-qam', 'otra']);
    const ajeno = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['switch', '-q', 'main']);
    fs.writeFileSync(path.join(repo, 'a'), '2'); git(repo, ['commit', '-qam', 'c2']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    const sub = path.join(repo, 'sub'); fs.mkdirSync(sub);

    const r1 = cb.resolver({ repo: sub, env: { TYCON_COVERAGE_BASE: c1 }, marker: { repoPath: repo, baseSha: head } });
    check('T9 la variable de entorno gana', r1.source === 'env' && r1.ref === c1, JSON.stringify(r1));
    const r2 = cb.resolver({ repo: sub, env: {}, marker: { repoPath: repo, baseSha: c1 } });
    check('T9 el baseSha del marcador (mismo repo, ancestro) va segundo', r2.source === 'marcador' && r2.ref === c1, JSON.stringify(r2));
    const r3 = cb.resolver({ repo, env: {}, marker: { repoPath: repo, baseSha: ajeno } });
    check('T9 un baseSha que no es ancestro se descarta con motivo y cae a HEAD',
      r3.source === 'HEAD' && r3.ref === head && r3.descartadas.some((d) => d.source === 'marcador' && /ancestro/.test(d.motivo)),
      JSON.stringify(r3));
    const r4 = cb.resolver({ repo, env: {}, marker: { repoPath: path.join(tmp, 'otro-repo'), baseSha: c1 } });
    check('T9 un marcador de otro repo se descarta', r4.source === 'HEAD' && r4.descartadas.some((d) => d.source === 'marcador'),
      JSON.stringify(r4));
    const r5 = cb.resolver({ repo, env: { TYCON_COVERAGE_BASE: 'no-existe' }, marker: null });
    check('T9 una variable ilegible se descarta y sin marcador queda HEAD',
      r5.source === 'HEAD' && r5.descartadas.some((d) => d.source === 'env'), JSON.stringify(r5));
    const r6 = cb.resolver({ repo: path.join(tmp, 'no-git'), env: {}, marker: null });
    check('T9 fuera de git no hay base (ref null) y se dice', r6.ref === null && r6.descartadas.length > 0, JSON.stringify(r6));
    check('T9 …con el detalle de git, no sólo «no es un repo»', /cannot change|No such file|not a git/i.test(r6.descartadas[0].motivo || ''),
      JSON.stringify(r6.descartadas));
    const r7 = cb.resolver({ repo, env: {}, marker: null, markerError: 'marker.js get salió 1: boom' });
    check('T9 un marcador que no se pudo leer queda en descartadas',
      r7.source === 'HEAD' && r7.descartadas.some((d) => d.source === 'marcador' && /boom/.test(d.motivo)), JSON.stringify(r7));
  }
}

// T11 · marker.js set conserva el baseSha de la misma story y lo resetea al cambiar. @ac-6
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'covm-'));
  const MARKER = path.join(__dirname, '..', 'marker.js');
  const env = { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'test-2-4-sesion' };
  const m = (...a) => execFileSync('node', [MARKER, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const get = () => JSON.parse(m('get') || '{}');
  try {
    m('set', JSON.stringify({ storyId: '9.1', repoPath: home, baseSha: 'abc123' }));
    check('T11 set guarda el baseSha', get().baseSha === 'abc123', JSON.stringify(get()));
    m('set', JSON.stringify({ storyId: '9.1', repoPath: home }));
    check('T11 un set de la misma story sin baseSha lo conserva', get().baseSha === 'abc123', JSON.stringify(get().baseSha));
    m('set', JSON.stringify({ storyId: '9.2', repoPath: home }));
    check('T11 un set de OTRA story lo resetea', !get().baseSha, JSON.stringify(get().baseSha));
  } catch (e) {
    check('T11 marker.js set/get corre', false, String(e.stderr || e.message).slice(0, 300));
  }
}

// T11b · pipeline.js start anota el commit de partida en el marcador (corrida real). @ac-6
// Rojo previo: sin el campo en el payload, el marcador queda sin baseSha.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covs-'));
  const home = path.join(tmp, 'home');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  // pipeline.js start invoca ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js: el HOME falso
  // apunta a ESTE checkout.
  fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', '..'), path.join(home, '.claude', 'agent-skills'));
  execFileSync('git', ['init', '-q', '-b', 'story/x', repo], { stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'story-9.9-x.md'),
    '---\nepic: 9\nstory: "9.9"\ntitle: "x"\nstatus: ready-for-dev\nfiles_to_modify:\n  - a.js\n---\n\n# Story 9.9\n\n## Acceptance Criteria\n\n1. x\n');
  fs.writeFileSync(path.join(repo, 'a.js'), '1\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'c']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const env = { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'test-2-4-start', TYCON_STORY_GATE: 'off' };
  const r = require('child_process').spawnSync('node', [path.join(__dirname, '..', 'pipeline.js'), 'start',
    '--story', path.join(repo, 'specs', 'story-9.9-x.md'), '--repo', repo], { encoding: 'utf8', env });
  let m = {};
  try { m = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'marker.js'), 'get'], { encoding: 'utf8', env })); } catch (e) { /* queda {} */ }
  check('T11b pipeline.js start deja baseSha = HEAD del repo en el marcador', m.baseSha === head,
    JSON.stringify({ baseSha: m.baseSha, head, rc: r.status, out: (r.stdout || '').slice(0, 300), err: (r.stderr || '').slice(-300) }));
}

// T11c · sin commit de partida, start no se calla: avisa y deja baseSha en null. @ac-5 @ac-6
// Rojo previo: el catch devolvía null sin decir nada.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covsv-'));
  const home = path.join(tmp, 'home');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', '..'), path.join(home, '.claude', 'agent-skills'));
  execFileSync('git', ['init', '-q', '-b', 'story/x', repo], { stdio: 'ignore' });   // sin commits
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'story-9.7-x.md'), '---\nepic: 9\nstory: "9.7"\ntitle: "x"\nstatus: ready-for-dev\n---\n\n# Story 9.7\n');
  const env = { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'test-2-4-start-vacio', TYCON_STORY_GATE: 'off' };
  const r = require('child_process').spawnSync('node', [path.join(__dirname, '..', 'pipeline.js'), 'start',
    '--story', path.join(repo, 'specs', 'story-9.7-x.md'), '--repo', repo], { encoding: 'utf8', env });
  let out = {}; try { out = JSON.parse(r.stdout); } catch (e) { /* {} */ }
  let m = {};
  try { m = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'marker.js'), 'get'], { encoding: 'utf8', env })); } catch (e) { /* {} */ }
  const avisos = [...(out.actions_done || []), ...(out.actions || [])].join(' | ');
  check('T11c repo sin commits → aviso de base de cobertura y baseSha null',
    /BASE DE COBERTURA/.test(avisos) && m.storyId === '9.7' && !m.baseSha,
    JSON.stringify({ avisos: avisos.slice(0, 300), baseSha: m.baseSha, story: m.storyId, rc: r.status }));
}

// T22 · el tramo bash de test-gate.sh lleva la base del marcador hasta el artefacto. @ac-6
// Rojo previo: ningún test corría BASE_JSON/BASE_REF; un error ahí dejaba la base en HEAD sin que nadie lo viera.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covg-'));
  const home = path.join(tmp, 'home');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts', 'tests'), { recursive: true });
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'ok.test.sh'), 'exit 0\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'suites.json'),
    JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/ok.test.sh' }], semanales: [] }));
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'x.js'), 'y\n'); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'despues']);
  // Sesión por la variable de Codex, no la de Claude: la línea de gates.log tiene que resolverla igual.
  const env = { ...process.env, HOME: home, CODEX_SESSION_ID: 'test-2-4-gate-codex', TYCON_COVERAGE_BASE: '' };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.TYCON_SESSION_ID;
  const MARKER = path.join(__dirname, '..', 'marker.js');
  execFileSync('node', [MARKER, 'set', JSON.stringify({ storyId: '9.8', repoPath: repo, baseSha: base })], { env, stdio: 'ignore' });
  const r = require('child_process').spawnSync('bash', [path.join(__dirname, '..', 'test-gate.sh'), repo, '9.8'],
    { encoding: 'utf8', env, timeout: 120000 });
  let tb = null;
  try { tb = JSON.parse(fs.readFileSync(path.join(repo, '.advisors', 'tests-result.json'), 'utf8')).coverage.touched_base; } catch (e) { /* null */ }
  check('T22 test-gate.sh publica la base del marcador', tb && tb.source === 'marcador' && tb.ref === base,
    JSON.stringify({ tb, rc: r.status, err: (r.stderr || '').slice(-400) }));
  let linea = null;
  try {
    linea = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((l) => l.name === 'cobertura-tocada').pop();
  } catch (e) { /* null */ }
  check('T22 …y la constancia lleva la sesión aunque no sea de Claude', linea && linea.sessionId === 'test-2-4-gate-codex',
    JSON.stringify(linea));
  // Story 7.15: la forma de totals del runner suites-json. Rojo previo: el parser sin las claves nuevas.
  let tot = null;
  try { tot = JSON.parse(fs.readFileSync(path.join(repo, '.advisors', 'tests-result.json'), 'utf8')).totals; } catch (e) { /* null */ }
  check('T22b (7.15) totals de suites-json traen deferred, deferred_suites, workers y wall_ms',
    tot && tot.deferred === 0 && Array.isArray(tot.deferred_suites) && tot.workers >= 1 && typeof tot.wall_ms === 'number'
      && tot.suites === 1 && tot.passed === 1,
    JSON.stringify(tot));
}

// T15 · el revisor de cobertura lee las líneas tocadas y dice que está en observación. @ac-8
{
  const md = path.join(__dirname, '..', '..', '..', '..', 'agents', 'tycon-plugin-tests-coverage.md');
  const t = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
  check('T15 el revisor cita touched_lines_pct, threshold_basis y la fecha de observación',
    /touched_lines_pct/.test(t) && /threshold_basis/.test(t) && /2026-10-06/.test(t), t ? 'falta alguno' : `no existe ${md}`);
}

console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} caso(s) fallando`);
  process.exit(1);
}
console.log('✓ test-gate cobertura — todos los casos verdes');
