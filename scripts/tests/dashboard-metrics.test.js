#!/usr/bin/env node
/**
 * dashboard-metrics.test.js — red de `lib/dashboard-metrics.js` + `dashboard-series.js`.
 *
 * Los casos positivos son, a propósito, las FORMAS REALES en que los 117 archivos legacy
 * estaban rotos: value string con prosa, value null sin motivo, ratio
 * imposible, sub-campos inventados. Si el validador deja pasar una de ésas, la serie vuelve
 * a mentir y nadie se entera.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LIB = path.resolve(__dirname, '..', 'lib', 'dashboard-metrics.js');
const RAIZ = path.resolve(__dirname, '..', '..');
const SERIES = path.join(RAIZ, 'scripts', 'lib', 'dashboard-series.js');
const { validate, loadAll, toNumber } = require(LIB);

let n = 0;
function t(name, fn) { n++; try { fn(); console.log(`  ok ${n} - ${name}`); } catch (e) { console.error(`  FAIL ${n} - ${name}\n    ${e.message}`); process.exitCode = 1; } }

const base = () => ({
  schema_version: '2.0',
  repo: '/Users/dev/SourceCode/Demo',
  merge_commit: 'abc1234def56',
  project: 'demo',
  captured_at: '2026-08-28T10:00:00-03:00',
  story_id: '1.1',
  metrics: {
    advisor_warnings_per_story: { value: 3, critical: 1, warning: 2 },
    advisor_warnings_actioned_ratio: { value: 1.0, actioned: 3, denominator: 3 },
    advisor_pipeline_runtime_failures: { value: 0 },
    advisor_rerun_loop_iterations: { value: 2 },
    step_8_commit_skipped_rerun: { value: 0 },
    advisor_findings_on_verification_artifacts: { value: 1, produccion: 0, tests: 1, story_spec: 0 },
    // La fila del punto ciego es parte del contrato, así que el documento COMPLETO la trae.
    // Va en null con motivo, que es su forma normal: la correlación la hace el nocturno.
    deep_review_skipped_then_hotfixed: { value: null, unavailable_reason: 'la correlación la hace el nocturno' },
  },
});

// ── el contrato acepta lo correcto ───────────────────────────────────────────────────────────

t('un documento 2.0 completo y numérico es válido', () => {
  const v = validate(base());
  assert.deepStrictEqual(v.errors, []);
  assert.strictEqual(v.ok, true);
});

t('null CON motivo es legal y se reporta como no-medida, no como error', () => {
  const d = base();
  d.metrics.advisor_rerun_loop_iterations = { value: null, unavailable_reason: 'gates.log sin entries para esta story' };
  const v = validate(d);
  assert.strictEqual(v.ok, true);
  // 2: la del caso, más `deep_review_skipped_then_hotfixed`, que en el documento
  // completo va siempre en null con motivo (su correlación la hace el nocturno).
  assert.strictEqual(v.notMeasured.length, 2);
  assert.ok(v.notMeasured.some((x) => x.metric === 'advisor_rerun_loop_iterations'));
});

t('un archivo legacy (sin schema_version 2.x) NO es error: es legacy', () => {
  const v = validate({ project: 'viejo', metrics: { advisor_warnings_per_story: { value: 'multiple' } } });
  assert.strictEqual(v.legacy, true);
  assert.strictEqual(v.ok, true);
});

// ── el contrato rechaza las roturas REALES del legacy ────────────────────────────────────────

t('value con prosa ("multiple (pre-existing)") se rechaza', () => {
  const d = base();
  d.metrics.advisor_warnings_per_story.value = 'multiple (pre-existing, non-diff)';
  const v = validate(d);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('advisor_warnings_per_story')), v.errors.join(' | '));
});

t('null SIN unavailable_reason se rechaza — una métrica no medida se declara', () => {
  const d = base();
  d.metrics.step_8_commit_skipped_rerun = { value: null };
  const v = validate(d);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('unavailable_reason')));
});

t('un ratio > 1 se rechaza (el legacy sumaba 162%)', () => {
  const d = base();
  d.metrics.advisor_warnings_actioned_ratio.value = 1.62;
  const v = validate(d);
  assert.strictEqual(v.ok, false);
});

t('un count negativo o decimal se rechaza', () => {
  const d = base();
  d.metrics.advisor_pipeline_runtime_failures.value = 1.5;
  assert.strictEqual(validate(d).ok, false);
  d.metrics.advisor_pipeline_runtime_failures.value = -1;
  assert.strictEqual(validate(d).ok, false);
});

t('repo relativo se rechaza (contrato con retro-pending)', () => {
  const d = base();
  d.repo = 'Lapacho/Backend';
  const v = validate(d);
  assert.ok(v.errors.some((e) => e.includes('ABSOLUTO')));
});

t('métrica faltante se rechaza en modo estricto y pasa en laxo', () => {
  const d = base();
  delete d.metrics.advisor_rerun_loop_iterations;
  assert.strictEqual(validate(d, { strict: true }).ok, false);
  assert.strictEqual(validate(d, { strict: false }).ok, true);
});

// ── el lector no adivina ─────────────────────────────────────────────────────────────────────

t('toNumber: acepta "3" y "0.83", rechaza "3 de 5", "", "N/A"', () => {
  assert.strictEqual(toNumber('3'), 3);
  assert.strictEqual(toNumber('0.83'), 0.83);
  assert.strictEqual(toNumber('3 de 5'), null);
  assert.strictEqual(toNumber(''), null);
  assert.strictEqual(toNumber('N/A'), null);
  assert.strictEqual(toNumber(undefined), null);
});

// ── loadAll + el CLI, contra un directorio sintético ─────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-'));
const write = (name, doc) => fs.writeFileSync(path.join(tmp, name), JSON.stringify(doc));

write('metrics-2026-08-01-ok.json', base());
const legacyDoc = { project: 'viejo', captured_at: '2026-06-01', metrics: { advisor_warnings_per_story: { value: 4 } } };
write('metrics-2026-06-01-legacy.json', legacyDoc);
const broken = base(); broken.metrics.advisor_warnings_per_story.value = 'unas cuantas';
write('metrics-2026-08-02-roto.json', broken);
fs.writeFileSync(path.join(tmp, 'metrics-2026-08-03-basura.json'), '{no es json');
fs.writeFileSync(path.join(tmp, 'last-successful-run.json'), '{}'); // NO matchea el patrón

t('loadAll clasifica sin adivinar: 1 ok + 1 legacy + 1 roto + 1 ilegible', () => {
  const { counts } = loadAll(tmp);
  assert.deepStrictEqual(counts, { total: 4, v2ok: 1, v2bad: 1, legacy: 1, unreadable: 1 });
});

t('loadMany (story 8.132): estado + historia; el mismo nombre en las dos cuenta una vez y gana la primera', () => {
  const { loadMany } = require(LIB);
  const hist = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-hist-'));
  const enEstado = base(); enEstado.metrics.advisor_warnings_per_story.value = 7;
  const enHist = base(); enHist.metrics.advisor_warnings_per_story.value = 1;
  const estado = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-estado-'));
  fs.writeFileSync(path.join(estado, 'metrics-2026-08-01-ok.json'), JSON.stringify(enEstado));
  fs.writeFileSync(path.join(hist, 'metrics-2026-08-01-ok.json'), JSON.stringify(enHist));
  fs.writeFileSync(path.join(hist, 'metrics-2026-06-01-legacy.json'), JSON.stringify(legacyDoc));
  const r = loadMany([estado, hist]);
  assert.deepStrictEqual(r.counts, { total: 2, v2ok: 1, v2bad: 0, legacy: 1, unreadable: 0 });
  assert.strictEqual(r.records.find((x) => x.file === 'metrics-2026-08-01-ok.json').values.advisor_warnings_per_story, 7);
  assert.strictEqual(r.dir, estado);
  // el medidor, con las dos carpetas, cuenta lo que sólo está en la historia
  const { firstPassFromDashboard } = require(path.join(RAIZ, 'scripts', 'metrics', 'sdlc-stage-metrics.js'));
  const conVueltas = (v) => { const d = base(); d.metrics.advisor_rerun_loop_iterations = { value: v }; return d; };
  fs.writeFileSync(path.join(estado, 'metrics-2026-08-05-uno.json'), JSON.stringify(conVueltas(1)));
  fs.writeFileSync(path.join(hist, 'metrics-2026-08-04-dos.json'), JSON.stringify(conVueltas(2)));
  const fp = firstPassFromDashboard([estado, hist], null);
  // el ok repetido (2 vueltas) cuenta una vez: 3 medidos, 1 de primera
  assert.deepStrictEqual([fp.num, fp.den], [1, 3], JSON.stringify(fp));
  fs.rmSync(hist, { recursive: true, force: true }); fs.rmSync(estado, { recursive: true, force: true });
});

t('loadAll extrae el número de un legacy cuando es inequívoco, y null cuando no', () => {
  const { records } = loadAll(tmp);
  const leg = records.find((r) => r.file.includes('legacy'));
  assert.strictEqual(leg.values.advisor_warnings_per_story, 4);
  const rot = records.find((r) => r.file.includes('roto'));
  assert.strictEqual(rot.values.advisor_warnings_per_story, null);
});

t('el CLI --validate sale 1 y nombra el archivo roto', () => {
  let out = '', code = 0;
  try { execFileSync('node', [SERIES, '--validate', '--dir', tmp], { encoding: 'utf8' }); }
  catch (e) { code = e.status; out = String(e.stderr); }
  assert.strictEqual(code, 1);
  assert.ok(out.includes('roto.json'), out);
  assert.ok(!out.includes('legacy.json'), 'legacy no se valida');
});

t('el CLI declara cobertura: nunca un promedio sin denominador', () => {
  const out = execFileSync('node', [SERIES, '--dir', tmp], { encoding: 'utf8' });
  assert.ok(/medido en \d+ de \d+/.test(out), 'falta el "medido en X de Y"');
  assert.ok(out.includes('TODAVÍA NO HAY SERIE'), 'con 1 registro válido tiene que decir que no hay serie');
});

t('el CLI --json emite la serie parseable', () => {
  const out = execFileSync('node', [SERIES, '--json', '--dir', tmp], { encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.strictEqual(j.counts.total, 4);
  assert.ok(j.series.advisor_warnings_per_story.n >= 1);
});

// ── la fecha: cadena declarada, fuente publicada, orden cronológico real ────────
// Los archivos reales traen la fecha en campos distintos (captured_at, generated_at, date) o sólo en el
// nombre. Leer un solo campo deja nulos, `--since` los descarta en silencio y la tendencia
// ordena por String(null). Cada caso anota qué lo rompe.

const { resolveDate } = require(LIB);

t('resolveDate sigue la cadena captured_at → generated_at → date → nombre y dice de cuál salió', () => {
  // falla con: volver a `String(doc.captured_at).slice(0,10)` → los tres últimos dan null
  assert.deepStrictEqual(resolveDate({ captured_at: '2026-08-28T10:00:00-03:00' }, 'metrics-2026-08-28-x.json').date_source, 'captured_at');
  assert.deepStrictEqual(resolveDate({ generated_at: '2026-07-04' }, 'metrics-2026-07-04-x.json'), { date: '2026-07-04', date_source: 'generated_at', date_conflict: null });
  assert.deepStrictEqual(resolveDate({ date: '2026-06-10' }, 'metrics-2026-06-10-x.json').date_source, 'date');
  assert.deepStrictEqual(resolveDate({}, 'metrics-2026-05-03.json'), { date: '2026-05-03', date_source: 'filename', date_conflict: null });
  assert.deepStrictEqual(resolveDate({}, 'sin-fecha.json'), { date: null, date_source: null, date_conflict: null });
});

t('resolveDate NO adivina con basura y declara el conflicto cuando la fecha de adentro no es la del nombre', () => {
  // falla con: quitar el regex de forma → 'ayer' o 'N/A' pasarían como fecha
  assert.strictEqual(resolveDate({ captured_at: 'ayer' }, 'sin-fecha.json').date, null);
  const c = resolveDate({ captured_at: '2026-05-05' }, 'metrics-2026-09-01-tarde.json');
  assert.strictEqual(c.date, '2026-05-05', 'la declarada gana');
  assert.deepStrictEqual(c.date_conflict, { declared: '2026-05-05', filename: '2026-09-01' });
});

// fixtures con las cuatro fuentes de fecha + uno sin ninguna
write('metrics-2026-07-04-solo-generated.json', { project: 'g', generated_at: '2026-07-04T03:00:00Z', metrics: { advisor_warnings_per_story: { value: 7 } } });
write('metrics-2026-06-10-solo-date.json', { project: 'd', date: '2026-06-10', metrics: { advisor_warnings_per_story: { value: 2 } } });
write('metrics-2026-05-03-solo-nombre.json', { project: 'n', metrics: { advisor_warnings_per_story: { value: 1 } } });
write('metrics-sin-fecha.json', { project: 'x', metrics: { advisor_warnings_per_story: { value: 9 } } });

t('loadAll ya no deja en null la fecha de un registro que la tiene en otro campo o en el nombre', () => {
  // falla con: leer sólo captured_at → 3 de estos 4 quedan sin fecha
  const { records } = loadAll(tmp);
  const by = (s) => records.find((r) => r.file.includes(s));
  assert.strictEqual(by('solo-generated').date_source, 'generated_at');
  assert.strictEqual(by('solo-date').date_source, 'date');
  assert.strictEqual(by('solo-nombre').date_source, 'filename');
  assert.strictEqual(by('sin-fecha').date, null);
});

t('el CLI ordena por fecha REAL: la ventana no termina en "null" aunque haya un registro sin fecha', () => {
  // falla con: `rows.sort(String(x.date).localeCompare(...))` y window desde rows → until === null
  const j = JSON.parse(execFileSync('node', [SERIES, '--json', '--dir', tmp], { encoding: 'utf8' }));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(String(j.window.until)), `until fue ${j.window.until}`);
  assert.ok(j.window.since <= j.window.until);
  assert.strictEqual(j.undated, 1, 'el registro sin fecha se CUENTA, no se pierde');
  assert.ok(j.date_sources.filename >= 1 && j.date_sources.generated_at >= 1, JSON.stringify(j.date_sources));
});

t('un filtro por fecha reporta cuántos dejó afuera y cuántos salieron por no tener fecha', () => {
  // falla con: sin los campos excluded_by_window / undated_before_window → undefined
  const j = JSON.parse(execFileSync('node', [SERIES, '--json', '--dir', tmp, '--since', '2026-07-01'], { encoding: 'utf8' }));
  assert.ok(j.excluded_by_window >= 3, `excluidos: ${j.excluded_by_window}`);
  assert.strictEqual(j.undated_before_window, 1);
});

t('sin fecha suficiente NO hay tendencia, y se dice por qué', () => {
  // falla con: volver a dibujar la flecha con main.length >= 6 sin mirar la cobertura de fechas
  const j = JSON.parse(execFileSync('node', [SERIES, '--json', '--dir', tmp], { encoding: 'utf8' }));
  assert.strictEqual(j.trend.ok, false);
  assert.ok(typeof j.trend.motivo === 'string' && j.trend.motivo.length > 0);
  const out = execFileSync('node', [SERIES, '--dir', tmp], { encoding: 'utf8' });
  assert.ok(out.includes('sin tendencia'), 'el reporte tiene que decir "sin tendencia", no imprimir una flecha');
  assert.ok(!/→ (subiendo|bajando)/.test(out), 'no puede haber flecha');
});

// ── la INVARIANTE del contrato: qué CUENTA `value`, no sólo qué forma tiene ──────────
// Los archivos reales con las tres partes publican `tests + story_spec` (el label), el TOTAL con `produccion`
// o sólo `tests`: tres unidades en la misma serie con el validador en verde.
// Los casos rojos son, a propósito, las dos formas reales de estar mal.
t('la invariante: value = tests + story_spec pasa', () => {
  const d = base();
  d.metrics.advisor_findings_on_verification_artifacts = { value: 5, produccion: 13, tests: 3, story_spec: 2 };
  const v = validate(d);
  assert.strictEqual(v.ok, true, v.errors.join(' | '));
});
t('la invariante: publicar el TOTAL (produccion + tests + story_spec) es un error que nombra la cuenta', () => {
  // falla con: value 18 con partes 13/3/2 (el total)
  const d = base();
  d.metrics.advisor_findings_on_verification_artifacts = { value: 18, produccion: 13, tests: 3, story_spec: 2 };
  const v = validate(d);
  assert.strictEqual(v.ok, false, 'el TOTAL no es lo que el label cuenta');
  assert.ok(v.errors.some((e) => /tests \+ story_spec/.test(e) && /= 5/.test(e)), v.errors.join(' | '));
});
t('la invariante: publicar sólo `tests` también es un error', () => {
  // falla con: value 0 con partes 26/0/1 (sólo `tests`)
  const d = base();
  d.metrics.advisor_findings_on_verification_artifacts = { value: 0, produccion: 26, tests: 0, story_spec: 1 };
  assert.strictEqual(validate(d).ok, false);
});
t('la invariante NO se juzga sin las partes que la definen: «no pude mirar» no es «está mal»', () => {
  const d = base();
  d.metrics.advisor_findings_on_verification_artifacts = { value: 4 };
  assert.strictEqual(validate(d).ok, true);
  d.metrics.advisor_findings_on_verification_artifacts = { value: 4, produccion: 1 };
  assert.strictEqual(validate(d).ok, true);
});
t('la invariante NO se juzga sobre una parte con forma inválida: ese error ya se cobró y no se duplica', () => {
  const d = base();
  d.metrics.advisor_findings_on_verification_artifacts = { value: 4, produccion: 0, tests: 'tres', story_spec: 1 };
  const v = validate(d);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.errors.filter((e) => /advisor_findings_on_verification_artifacts/.test(e)).length, 1, v.errors.join(' | '));
});

// ── «No pude preguntar» no se publica como número ─────
// La fila `deep_review_skipped_then_hotfixed` mide algo que presupone una story; un cambio que entra
// SIN story no encaja en su definición y la fila imprimiría `0`.
// Un 0 que significa «esta pregunta no se pudo hacer» es el falso verde más caro del tablero, y es justo el que
// esa fila existe para denunciar.
t('una entrada que se declara no medida (`status: n/a`) NO puede publicar un número', () => {
  const d = base();
  d.metrics.deep_review_skipped_then_hotfixed = { value: 0, status: 'n/a', detail: 'sin story: la métrica no aplica' };
  const v = validate(d);
  assert.strictEqual(v.ok, false, 'un 0 con status n/a es el falso verde que esto cierra');
  assert.ok(v.errors.some((e) => /no medido no es 0/.test(e)), v.errors.join(' | '));
});
t('lo mismo con `unavailable_reason` y un número al lado', () => {
  const d = base();
  d.metrics.advisor_pipeline_runtime_failures = { value: 0, unavailable_reason: 'no pude leer el volcado' };
  assert.strictEqual(validate(d).ok, false);
});
t('y la forma correcta —value null con motivo— sigue siendo válida y se cuenta como no medida', () => {
  const d = base();
  d.metrics.deep_review_skipped_then_hotfixed = { value: null, unavailable_reason: 'la correlación la hace el nocturno',
    commits_fuera_del_pipeline: 2, commits_sin_carril: 1 };
  const v = validate(d);
  assert.strictEqual(v.ok, true, v.errors.join(' | '));
  assert.ok(v.notMeasured.some((x) => x.metric === 'deep_review_skipped_then_hotfixed'));
});
t('un valor REAL sin declararse no medida pasa: la regla no prohíbe medir cero', () => {
  const d = base();
  d.metrics.deep_review_skipped_then_hotfixed = { value: 0, commits_fuera_del_pipeline: 0, commits_sin_carril: 0 };
  assert.strictEqual(validate(d).ok, true);
});

// ── T23 · R3_Lib_MovedRequires ─────────────────────────────────────────────────────────
// La serie vive en scripts/lib/: compila desde ahí, pide su vecino `dashboard-metrics.js` sin `lib/` adelante, valida
// un directorio de juguete y, sin `--dir`, sigue leyendo el `.dashboard/` del clon (no uno inventado bajo scripts/). En la
// ruta de siempre queda el reemplazo generado —lo llaman dos pipelines y el capturador de retrospectivas—; esa ruta sale
// del mapa, y la copia pública, que no lo lleva, lo dice.
// Sólo la copia pública —que no lleva el mapa— se saltea. Con el mapa presente, ilegible o sin la entrada es un rojo
// (leer «sin entrada» como «copia pública» dejaría pasar en verde un reemplazo que falta).
const MAP_PATH = path.join(RAIZ, 'scripts', 'lib', 'renames.json');

t('T23 R3_Lib_MovedRequires — la serie compila desde scripts/lib/ y su vecino resuelve', () => {
  execFileSync(process.execPath, ['--check', SERIES], { encoding: 'utf8' });
  const src = fs.readFileSync(SERIES, 'utf8');
  const rel = [...src.matchAll(/require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)].map((m) => m[2]);
  assert.ok(rel.length >= 1, 'pide al menos su vecino');
  const muertas = rel.filter((r) => { try { require.resolve(path.resolve(path.dirname(SERIES), r)); return false; } catch { return true; } });
  assert.deepStrictEqual(muertas, [], 'todo require relativo resuelve desde scripts/lib/');
  assert.ok(!/require\(\s*['"]\.\/lib\//.test(src), 'su vecino de lib/ se pide sin `lib/` adelante');
});

t('T23 R3_Lib_MovedRequires — desde scripts/lib/, --validate sobre un directorio de juguete y la carpeta de estado por omisión', () => {
  const juguete = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-series-'));
  try {
    fs.writeFileSync(path.join(juguete, 'metrics-2026-10-02-ok.json'), JSON.stringify(base()));
    const out = execFileSync(process.execPath, [SERIES, '--validate', '--dir', juguete], { encoding: 'utf8' });
    assert.ok(/1 archivo\(s\) en formato 2\.0 válidos/.test(out), out);
  } finally { fs.rmSync(juguete, { recursive: true, force: true }); }
  // con una casa vacía: el de omisión es la carpeta de estado de esa casa (night-data.js), nunca un clon; la prueba
  // no depende de quién la corre
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-casa-'));
  try {
    const j = JSON.parse(execFileSync(process.execPath, [SERIES, '--json'], { encoding: 'utf8', cwd: os.tmpdir(), env: { ...process.env, HOME: casa, USERPROFILE: casa } }));
    assert.strictEqual(path.resolve(j.dir), path.join(casa, '.claude', '.tycon-pipeline', 'dashboard'), 'sin --dir lee la carpeta de estado, no el .dashboard/ del clon');
  } finally { fs.rmSync(casa, { recursive: true, force: true }); }
});

// La familia del capturador con lo bajado del buzón: la raíz de .dashboard y su merges/ con un registro por merge.
const conMerge = (sha, vueltas, captured_at) => {
  const d = { ...base(), merge_commit: sha, captured_at };
  d.metrics = { ...d.metrics, advisor_rerun_loop_iterations: { value: vueltas } };
  return d;
};
const carpetaConMerges = (raiz, merges) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'por-merge-'));
  fs.mkdirSync(path.join(d, 'merges'));
  for (const [f, doc] of Object.entries(raiz)) fs.writeFileSync(path.join(d, f), JSON.stringify(doc));
  for (const [f, doc] of Object.entries(merges)) fs.writeFileSync(path.join(d, 'merges', f), JSON.stringify(doc));
  return d;
};
// lo que el tablero muestra de la familia del capturador, venga en el panel que venga
const delTablero = (dir) => {
  const out = require(path.join(RAIZ, 'scripts', 'nightly', 'dashboard', 'dashboard.js')).colectar({ dir });
  const hallado = {};
  const buscar = (o, prof = 0) => {
    if (!o || typeof o !== 'object' || prof > 6) return;
    for (const [k, v] of Object.entries(o)) {
      // la medida, no la definición de la ficha que lleva el mismo nombre
      const medida = k === 'revisores' || k === '_capturer_cobertura' || (v && typeof v === 'object' && 'estado' in v);
      if (['_capturer_cobertura', 'revisores', 'contrato_v2'].includes(k) && medida && !(k in hallado)) hallado[k] = v;
      else buscar(v, prof + 1);
    }
  };
  buscar(out);
  return hallado;
};
const A40 = 'a'.repeat(40); const B40 = 'b'.repeat(40);

// Sin esto,el tablero deduplica sólo por nombre de archivo: el mismo merge en la raíz y en merges/ con otro
//    nombre (otra fecha) entra dos veces en las medianas de los revisores, y el medidor de primera vuelta lo cuenta una.
t('T44 LoadPorMerge_OtherName_CountsOnce (story 8.132) @ac-14 @ac-15: el mismo merge con otro nombre en la raíz y en merges/ cuenta una vez', () => {
  const d = carpetaConMerges(
    { 'metrics-2026-10-20-demo-1.1-aaaaaaa.json': conMerge(A40, 4, '2026-10-20T10:00:00Z') },
    { 'metrics-2026-10-21-demo-1.1-aaaaaaa.json': conMerge(A40, 4, '2026-10-21T10:00:00Z'),
      'metrics-2026-10-24-demo-1.2-bbbbbbb.json': conMerge(B40, 1, '2026-10-24T10:00:00Z') });
  try {
    const tab = delTablero(d);
    assert.strictEqual(tab._capturer_cobertura.total, 2, JSON.stringify(tab._capturer_cobertura));
    assert.strictEqual(tab.revisores.advisor_rerun_loop_iterations.valor, 2.5, JSON.stringify(tab.revisores.advisor_rerun_loop_iterations));
    const { loadPorMerge } = require(LIB);
    const r = loadPorMerge([d]);
    assert.deepStrictEqual([r.counts.total, r.counts.v2ok, r.records.length], [2, 2, 2], JSON.stringify(r.counts));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// Sin esto,con el mismo nombre en la raíz y en merges/, gana la copia de la raíz aunque sea la vieja.
t('T45 LoadPorMerge_SameName_NewestWins (story 8.132) @ac-14 @ac-15: con el mismo nombre gana la copia más nueva, no la de la raíz', () => {
  const f = 'metrics-2026-10-20-demo-1.1-aaaaaaa.json';
  const d = carpetaConMerges({ [f]: conMerge(A40, 3, '2026-10-20T10:00:00Z') }, { [f]: conMerge(A40, 5, '2026-10-22T10:00:00Z') });
  try {
    const tab = delTablero(d);
    assert.strictEqual(tab.revisores.advisor_rerun_loop_iterations.valor, 5, JSON.stringify(tab.revisores.advisor_rerun_loop_iterations));
    assert.strictEqual(tab.contrato_v2.total, 1, JSON.stringify(tab.contrato_v2));
    const { loadPorMerge } = require(LIB);
    const r = loadPorMerge([d]);
    assert.deepStrictEqual(r.records.map((x) => x.values.advisor_rerun_loop_iterations), [5]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// Sin esto,un sha corto de la raíz que calza con dos sha completos de merges/ (el mismo proyecto) se cuenta dos
//    veces en la primera vuelta, aunque `unoPorMerge` los junta en un solo merge.
t('T46 FirstPass_ShortShaJoinsGroups (story 8.132) @ac-14: un registro de la raíz nunca se cuenta dos veces', () => {
  const corto = { ...conMerge('abc1234', 1, '2026-08-28T10:00:00-03:00') };
  const d = carpetaConMerges({ 'metrics-2026-08-28-abc1234.json': corto },
    { 'metrics-2026-08-28-A.json': conMerge(`abc1234${'a'.repeat(33)}`, 2, '2026-08-27T10:00:00-03:00'),
      'metrics-2026-08-28-B.json': conMerge(`abc1234${'b'.repeat(33)}`, 2, '2026-08-27T10:00:00-03:00') });
  try {
    const { firstPassFromDashboard } = require(path.join(RAIZ, 'scripts', 'metrics', 'sdlc-stage-metrics.js'));
    const fp = firstPassFromDashboard(d, null);
    assert.deepStrictEqual([fp.num, fp.den], [1, 1], JSON.stringify(fp));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// Sin esto,`loadAll` toma una carpeta que no se puede leer como vacía, y el medidor de primera vuelta cuenta
//    lo que sí leyó: con `merges/` sin permiso daría un número parcial que parece bueno.
const esRoot = typeof process.getuid === 'function' && process.getuid() === 0;
if (process.platform === 'win32' || esRoot) {
  console.log(`  NO MEDIDO — T42 LoadAll_UnreadableDir_NotEmpty: ${esRoot ? 'como root chmod 000 no quita la lectura' : 'en Windows chmod no quita la lectura'}`);
} else {
  t('T42 LoadAll_UnreadableDir_NotEmpty (story 8.132): una carpeta ilegible no es vacía, y la primera vuelta no se mide', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ilegible-'));
    const merges = path.join(d, 'merges');
    fs.mkdirSync(merges);
    fs.writeFileSync(path.join(d, 'metrics-a.json'), JSON.stringify({ ...base(), merge_commit: 'a'.repeat(40) }));
    fs.writeFileSync(path.join(merges, 'metrics-b.json'), JSON.stringify({ ...base(), merge_commit: 'b'.repeat(40) }));
    fs.chmodSync(merges, 0o000);
    try {
      const r = loadAll(merges);
      assert.strictEqual(r.records.length, 0);
      assert.strictEqual(r.unreadableDir, 'EACCES', `una carpeta ilegible se marca, no se lee como vacía: ${JSON.stringify(r)}`);
      assert.strictEqual(loadAll(path.join(d, 'no-existe')).unreadableDir, undefined, 'una que no existe sí es «nada»');
      const { firstPassFromDashboard } = require(path.join(RAIZ, 'scripts', 'metrics', 'sdlc-stage-metrics.js'));
      const fp = firstPassFromDashboard(d, null);
      assert.strictEqual(fp.value, null, `con merges/ ilegible no hay número: ${JSON.stringify(fp)}`);
      assert.match(fp.reason, /^no medido: .*merges.*no se puede leer \(EACCES\)/);
    } finally { fs.chmodSync(merges, 0o755); fs.rmSync(d, { recursive: true, force: true }); }
  });
}

if (fs.existsSync(MAP_PATH)) {
  t('T23 R3_Lib_MovedRequires — en la ruta de siempre queda el reemplazo generado que lanza el de lib/', () => {
    const L = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
    const R3_SERIES = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')).entries
      .find((e) => e && e.batch === 'R3' && e.new === 'scripts/lib/dashboard-series.js');
    assert.ok(R3_SERIES, 'el mapa no tiene la entrada de scripts/lib/dashboard-series.js');
    const viejo = path.join(RAIZ, R3_SERIES.old);
    assert.ok(fs.existsSync(viejo) && L.isGeneratedShim(R3_SERIES.old, fs.readFileSync(viejo, 'utf8')), `${R3_SERIES.old} es el reemplazo generado, tal cual`);
    assert.strictEqual(path.resolve(L.shimTarget(viejo)), SERIES, `${R3_SERIES.old} lanza el de scripts/lib/`);
  });
} else console.log('  NO MEDIDO — copia pública sin el mapa (T23: el reemplazo de la serie)');

// Sin la lista de repos de la organización, las fichas que la usan dicen que falta (o que no se lee), con su ruta: un
// «no medido» que no nombra el archivo se confunde con una organización sin productos.
t('ReposListMissing_CardsSayItIsMissing: sin repos.json, o con uno ilegible, las fichas lo nombran', () => {
  const D = require(path.join(RAIZ, 'scripts', 'nightly', 'dashboard', 'dashboard.js'));
  const dash = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-dash-'));
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-raiz-'));
  fs.mkdirSync(path.join(raiz, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'scripts', 'ci', 'pipeline-debt.json'), '{ "debt": [] }\n');
  const motivos = () => {
    const p = D.colectar({ dir: dash, raiz }).paneles;
    return { bus: p.local.bus_factor.motivo, sinProd: p.extra.sin_prod.motivo };
  };
  let m = motivos();
  assert.match(m.bus, /falta scripts\/nightly\/dependencies\/repos\.json/);
  assert.match(m.sinProd, /falta scripts\/nightly\/dependencies\/repos\.json/);
  fs.mkdirSync(path.join(raiz, 'scripts', 'nightly', 'dependencies'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'scripts', 'nightly', 'dependencies', 'repos.json'), '{ roto');
  m = motivos();
  assert.match(m.bus, /scripts\/nightly\/dependencies\/repos\.json no se lee/);
  assert.match(m.sinProd, /scripts\/nightly\/dependencies\/repos\.json no se lee/);
  fs.rmSync(dash, { recursive: true, force: true }); fs.rmSync(raiz, { recursive: true, force: true });
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? '\nFALLARON tests' : `\n${n} tests OK`);
