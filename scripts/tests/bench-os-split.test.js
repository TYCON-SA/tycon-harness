#!/usr/bin/env node
'use strict';
// bench-os-split.test.js — el banco de controles por sistema: cada caso se corre donde está declarado, la noche junta los
// reportes y lo que nadie corrió sale «no medido», nunca verde.
// stable-data: lee el reloj sólo para fechar la foto que lee el aviso; no depende del día.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'controls-bench', 'runner.js');
const MERGE = path.join(ROOT, 'scripts', 'controls-bench', 'merge-reports.js');
const NOTICE = path.join(ROOT, 'scripts', 'hooks', 'bench-notice.js');
const PIPELINE = path.join(ROOT, 'pipelines/azure-pipelines-banco.yml');
const SIN_PRIVADO = fs.existsSync(PIPELINE) ? false : 'NO MEDIDO: el pipeline vive en el repo privado; corre en el árbol armado';

const temporal = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-so-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const CASOS = {
  comun: {},
  mac: { so: ['darwin'] },
  win: { so: ['win32'] },
  ambos: { so: ['linux', 'darwin'] },
  freno: { sin_freno_instalado: true },
  asimetria: { tools: ['codex'], asymmetry: 'sólo de la otra herramienta' },
  macroja: { so: ['darwin'], expect: { stdout_re: ['esto no sale'] } },
};

/** Corre el banco de juguete con la plataforma y el freno inyectados. */
function banco(t, { ids, args = [], platform, frenoInstalado = false, base = null }) {
  const dir = temporal(t);
  const script = path.join(dir, 'gancho.sh');
  fs.writeFileSync(script, '#!/bin/sh\necho sale\n', { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'casos'));
  const cases = ids.map((id) => ({ id, type: 'must-emit', tools: ['claude', 'codex'], stdin: { source: 'startup' }, expect: { stdout_re: ['sale'] }, ...CASOS[id] }));
  fs.writeFileSync(path.join(dir, 'casos', '01-juguete.json'), JSON.stringify({ hooks: [{ hook: 'gancho.sh', script, event: 'SessionStart', matcher: '*', cases }] }));
  const baseline = path.join(dir, 'base.json');
  fs.writeFileSync(baseline, JSON.stringify({ cases: base || {} }));
  const json = path.join(dir, 'reporte.json');
  const codigo = 'process.argv=[process.argv[0],"runner",...JSON.parse(process.env.ARGS)];process.exitCode=require(process.env.RUNNER).main(JSON.parse(process.env.BENCH_CONTEXT));';
  const r = spawnSync(process.execPath, ['-e', codigo], {
    encoding: 'utf8',
    env: { ...process.env, RUNNER, ARGS: JSON.stringify(['--tool', 'claude', '--json', json, ...args]), BENCH_CONTEXT: JSON.stringify({ platform, frenoInstalado }), TYCON_BENCH_CASES_DIR: path.join(dir, 'casos'), TYCON_BENCH_BASELINE: baseline },
  });
  const reporte = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null;
  const corrieron = reporte ? Object.keys(reporte.results).filter((k) => reporte.results[k].tools.claude && !reporte.results[k].tools.claude.skipped).map((k) => k.split('::').pop()).sort() : [];
  return { status: r.status, out: r.stdout, err: r.stderr, reporte, corrieron };
}

test('T1 OnlyNotOn_RunsOnlyWhatLinuxSkips @story-8.300 @ac-3', (t) => {
  const r = banco(t, { ids: ['comun', 'mac', 'win', 'ambos'], platform: 'darwin', args: ['--only-not-on', 'linux'] });
  assert.strictEqual(r.status, 0, r.out + r.err);
  assert.deepStrictEqual(r.corrieron, ['mac']);
  assert.strictEqual(Object.keys(r.reporte.results).length, 1, 'el caso de otro sistema no cuenta');
  assert.strictEqual(r.reporte.skippedOs, 0);
});

test('T2 OnlyNotOn_Baseline_LooksOnlyAtItsCases @story-8.300 @ac-3', (t) => {
  const limpio = banco(t, { ids: ['comun', 'mac'], platform: 'darwin', args: ['--only-not-on', 'linux', '--baseline', 'check'], base: { 'gancho.sh::comun': true, 'gancho.sh::otro': true, 'gancho.sh::mac': true } });
  assert.strictEqual(limpio.reporte.baselineRegressions, 0, limpio.out);
  assert.doesNotMatch(limpio.out, /DESAPARECIÓ/);
  const rojo = banco(t, { ids: ['macroja'], platform: 'darwin', args: ['--only-not-on', 'linux', '--baseline', 'check'], base: { 'gancho.sh::comun': true, 'gancho.sh::macroja': true } });
  assert.strictEqual(rojo.reporte.baselineRegressions, 1, rojo.out);
});

test('T9 Runner_EmptyRun_IsNotGreen @story-8.300 @ac-9', (t) => {
  let r = banco(t, { ids: ['comun'], platform: 'linux', args: ['--only', 'nada-que-exista'] });
  assert.strictEqual(r.status, 3);
  assert.doesNotMatch(r.out, /✅/);
  assert.match(r.out, /🟡 el filtro no deja ningún caso: nada medido/);
  assert.strictEqual(r.reporte.ran, 0);
  r = banco(t, { ids: ['mac'], platform: 'linux', args: ['--only', 'mac'] });
  assert.strictEqual(r.status, 3);
  assert.doesNotMatch(r.out, /✅/);
  assert.match(r.out, /🟡 1 caso\(s\) salteados acá: nada medido/);
  assert.strictEqual(banco(t, { ids: ['comun'], platform: 'linux', args: ['--only', 'comun'] }).status, 0);
});

test('T10 Runner_SkippedHere_CountedApart @story-8.300 @ac-10', (t) => {
  const r = banco(t, { ids: ['comun', 'mac', 'freno', 'asimetria'], platform: 'linux', frenoInstalado: true });
  assert.strictEqual(r.reporte.skippedOs, 2, r.out);
  assert.strictEqual(r.reporte.skipped, 1, r.out);
  assert.match(r.out, /2 salteados acá \(no medidos\)/);
  assert.match(r.out, /1 skip-con-asimetría/);
  for (const id of ['mac', 'freno']) assert.ok(r.reporte.results[`gancho.sh::${id}`].tools.claude.motivo, id);
});

test('T15 Runner_Linux_RunsTheSameAsToday @story-8.300 @ac-12', (t) => {
  const r = banco(t, { ids: ['comun', 'ambos', 'mac', 'asimetria'], platform: 'linux' });
  assert.strictEqual(r.status, 0, r.out + r.err);
  assert.deepStrictEqual(r.corrieron, ['ambos', 'comun']);
  for (const campo of ['ran', 'failed', 'skipped', 'nomedido', 'parityBreaks', 'baselineRegressions', 'carteles', 'results', 'skippedOs']) assert.ok(campo in r.reporte, campo);
  assert.strictEqual(r.reporte.ran, 2);
  assert.match(r.out, /✅ 2 corridos · 0 rojos/);
});

// ── juntar ──
const verde = { pass: true, failures: [] };
const rojo = { pass: false, failures: ['falló'] };
const salteado = (so) => ({ skipped: true, so, motivo: 'salteado acá' });
const caso = (tools, declarado) => ({ type: 'must-emit', asymmetry: null, ...(declarado ? { so: declarado } : {}), tools });
const reporte = (so, results, extra = {}) => ({ ts: '2026-11-18T05:00:00.000Z', tool: 'both', so, build: `b-${so}`, estado: 'completo', ran: 0, failed: 0, skipped: 0, skippedOs: 0, nomedido: 0, parityBreaks: 0, baselineRegressions: 0, carteles: { comando: 0, llano: 0, callejon: 0 }, results, ...extra });
const juntar = (...a) => require(MERGE).juntar(...a);
const trabajo = (so, rep) => ({ so, reporte: rep });

test('T3 MergeReports_TakesTheResultOfWhoRan @story-8.300 @ac-4', () => {
  const j = juntar([
    trabajo('linux', reporte('linux', { 'g::m': caso({ claude: salteado('linux') }, ['darwin']) })),
    trabajo('darwin', reporte('darwin', { 'g::m': caso({ claude: rojo }, ['darwin']) })),
  ], {});
  assert.strictEqual(j.failed, 1);
  assert.strictEqual(j.ran, 1);
  assert.strictEqual(j.results['g::m'].trabajo, 'darwin');
  assert.deepStrictEqual(j.trabajos.map((x) => [x.so, x.build, x.estado]), [['linux', 'b-linux', 'completo'], ['darwin', 'b-darwin', 'completo']]);
});

test('T4 MergeReports_SkippedEverywhere_IsNotMeasured @story-8.300 @ac-5', () => {
  const entrada = caso({ claude: salteado('x') }, ['win32']);
  const j = juntar([trabajo('linux', reporte('linux', { 'g::w': entrada })), trabajo('darwin', reporte('darwin', { 'g::w': entrada }))], {});
  assert.strictEqual(j.results['g::w'].nomedido, true);
  assert.match(j.results['g::w'].motivo, /ningún trabajo de la noche corre en win32/);
  assert.deepStrictEqual([j.nomedido, j.skipped, j.skippedOs], [1, 0, 0]);
  assert.strictEqual(j.nomedidoPorMotivo['ningún trabajo de la noche corre en win32'], 1);
});

function cli(t, { base, adds }) {
  const dir = temporal(t);
  const escribir = (n, v) => { const p = path.join(dir, n); if (v !== undefined) fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); return p; };
  const args = ['--base', escribir('banco-linux.json', base)];
  for (const [n, v] of adds) args.push('--add', escribir(n, v));
  const out = path.join(dir, 'junto.json');
  const baseline = escribir('base.json', { cases: {} });
  const r = spawnSync(process.execPath, [MERGE, ...args, '--out', out], { encoding: 'utf8', env: { ...process.env, TYCON_BENCH_BASELINE: baseline } });
  return { ...r, out, junto: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
}
const conMac = () => reporte('linux', { 'g::m': caso({ claude: salteado('linux') }, ['darwin']), 'g::c': caso({ claude: verde }) });

test('T5 MergeReports_JobWithoutReport @story-8.300 @ac-6', (t) => {
  const r = cli(t, { base: conMac(), adds: [['banco-darwin.json', undefined]] });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.junto.results['g::m'].nomedido, true);
  assert.match(r.junto.results['g::m'].motivo, /el trabajo de darwin no dejó reporte/);
  assert.match(r.stdout, /darwin.*no dejó reporte/);
  assert.strictEqual(r.junto.trabajos.find((x) => x.so === 'darwin').estado, 'sin reporte');
});

test('T6 MergeReports_UnreadableReport @story-8.300 @ac-7', (t) => {
  const r = cli(t, { base: conMac(), adds: [['banco-darwin.json', '{roto']] });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.junto.results['g::m'].motivo, /el trabajo de darwin no dejó reporte/);
  const mal = cli(t, { base: { ...conMac(), failed: 'dos' }, adds: [] });
  assert.strictEqual(mal.status, 3);
  assert.strictEqual(mal.junto, null);
});

test('T7 MergeReports_NotMeasured_IsNotARegression @story-8.300 @ac-8', () => {
  const j = juntar([trabajo('linux', reporte('linux', { 'g::m': caso({ claude: salteado('linux') }, ['darwin']) }))], { 'g::m': true, 'g::ausente': true });
  assert.strictEqual(j.nomedido, 1);
  assert.strictEqual(j.baselineRegressions, 1);
});

// 🔴 Falla con: tomar una línea de base que no se pudo leer como «0 regresiones»: no se comparó, y el reporte lo dice.
test('T7b MergeReports_NoBaseline_SaysItDidNotCompare @story-8.300 @ac-8', (t) => {
  const dir = temporal(t);
  const base = path.join(dir, 'banco-linux.json');
  fs.writeFileSync(base, JSON.stringify(conMac()));
  const out = path.join(dir, 'junto.json');
  const r = spawnSync(process.execPath, [MERGE, '--base', base, '--out', out], { encoding: 'utf8', env: { ...process.env, TYCON_BENCH_BASELINE: path.join(dir, 'no-esta.json') } });
  assert.strictEqual(r.status, 0, r.stderr);
  const junto = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(junto.baselineRegressions, null, 'sin línea de base no hay cuenta de regresiones');
  assert.match(junto.sinLineaDeBase, /no-esta\.json/);
  assert.match(r.stdout, /regresiones sin comparar/);
});

test('T8 MergeReports_CountersAreRecomputed @story-8.300 @ac-4 @ac-12', () => {
  const j = juntar([
    trabajo('linux', reporte('linux', { 'g::a': caso({ claude: rojo, codex: rojo }), 'g::p': caso({ claude: verde, codex: rojo }), 'g::m': caso({ claude: salteado('l'), codex: salteado('l') }, ['darwin']) })),
    trabajo('darwin', reporte('darwin', { 'g::m': caso({ claude: { pass: false, nomedido: true, failures: ['NO MEDIDO: se agotaron los 20 s dos veces'] }, codex: verde }, ['darwin']) })),
  ], {});
  assert.deepStrictEqual([j.ran, j.failed, j.nomedido, j.parityBreaks], [6, 3, 1, 2]);
  assert.strictEqual(j.nomedidoPorMotivo['con el tiempo agotado'], 1);
});

// ── el aviso ──
function aviso(t, foto) {
  const dir = temporal(t);
  const p = path.join(dir, 'banco.json');
  // la foto es siempre de ahora: un informe juntado trae el `ts` fijo de `reporte`, y una foto de más de dos días el aviso
  // la cuenta como un banco que NO ESTÁ CORRIENDO (el caso se pondría rojo solo, con el paso de los días)
  fs.writeFileSync(p, JSON.stringify({ origen: 'azure-pipelines', ...foto, ts: new Date().toISOString() }));
  return spawnSync(process.execPath, [NOTICE], { encoding: 'utf8', env: { ...process.env, HOME: dir, TYCON_NIGHTLY: '1', TYCON_BENCH_REPORT: p, TYCON_SUITES_REPORT: path.join(dir, 'no-hay.json') } }).stdout;
}

test('T11 BenchNotice_SaysWhy @story-8.300 @ac-11', (t) => {
  const con = aviso(t, { ran: 10, failed: 0, parityBreaks: 0, baselineRegressions: 0, nomedido: 252, nomedidoPorMotivo: { 'ningún trabajo de la noche corre en darwin': 250, 'con el tiempo agotado': 2 } });
  assert.match(con, /🟡 banco de controles nocturno/);
  assert.match(con, /250: ningún trabajo de la noche corre en darwin/);
  assert.match(con, /2: con el tiempo agotado/);
  assert.doesNotMatch(con, /✅ banco/);
  const vieja = aviso(t, { ran: 10, failed: 0, parityBreaks: 0, baselineRegressions: 0, nomedido: 2 });
  assert.match(vieja, /se les agotó el tiempo/);
});

test('T13 MergeReports_TwoOldCases_ComeOutRed @story-8.300 @ac-13', (t) => {
  const salt = caso({ claude: salteado('linux') }, ['darwin']);
  const j = juntar([
    trabajo('linux', reporte('linux', { 'prod-access-guard.js::a': salt, 'prod-access-guard.js::b': salt })),
    trabajo('darwin', reporte('darwin', { 'prod-access-guard.js::a': caso({ claude: rojo }, ['darwin']), 'prod-access-guard.js::b': caso({ claude: rojo }, ['darwin']) })),
  ], {});
  assert.strictEqual(j.failed, 2);
  assert.match(aviso(t, j), /🔴 banco de controles nocturno/);
});

// ── el pipeline ──
const yaml = () => fs.readFileSync(PIPELINE, 'utf8');

test('T14 Pipeline_HasTheNewJobs @story-8.300 @ac-1 @ac-2 @ac-4', { skip: SIN_PRIVADO }, () => {
  const y = yaml();
  assert.match(y, /vmImage: 'macOS-latest'/);
  assert.match(y, /vmImage: 'windows-latest'/);
  assert.strictEqual((y.match(/runner\.js --tool both --only-not-on linux --baseline check --json/g) || []).length, 2);
  assert.ok((y.match(/CODIGO=\$\{PIPESTATUS\[0\]\}/g) || []).length >= 4, 'Linux, macOS, Windows y el paso que junta');
  assert.match(y, /merge-reports\.js --base [^\n]*--add [^\n]*--add /);
  const juntar_ = y.indexOf('merge-reports.js --base');
  const copia = y.indexOf('banco-$HOY.json');
  assert.ok(copia > juntar_, 'la copia del día sale del reporte junto');
  for (const so of ['linux', 'darwin', 'win32']) assert.match(y, new RegExp(`artifact: 'banco-${so}'\\n\\s+condition: always\\(\\)`), so);
  // el reporte de la noche anterior está en el repo: si el banco de Linux no midió, no se entrega como si fuera de hoy
  assert.match(y, /Agent\.JobStatus\)" in Succeeded\|SucceededWithIssues\)[\s\S]{0,300}cp ultimo-banco\.json/);
});

test('T12 PipelineMergeStep_DoesNotHideTheError @story-8.300 @ac-6 @ac-7', { skip: SIN_PRIVADO }, (t) => {
  const lineas = yaml().split('\n');
  const fin = lineas.findIndex((l) => /displayName: 'Juntar los reportes del banco'/.test(l));
  assert.ok(fin > 0, 'el paso que junta');
  let ini = fin;
  while (!/- (?:script|bash): \|/.test(lineas[ini])) ini--;
  const sangria = lineas[ini + 1].match(/^ */)[0].length;
  // las rutas van por el entorno, no dentro del texto del comando: el guion de bash queda fijo
  const paso = lineas.slice(ini + 1, fin).map((l) => l.slice(sangria)).join('\n').replace(/\$\(Pipeline\.Workspace\)/g, '${BENCH_WORKSPACE}').replace(/\$\(Build\.SourcesDirectory\)/g, '${BENCH_SOURCES}').replace(/\$\(Build\.BuildId\)/g, '1');
  const correr = (dejar) => {
    const raiz = temporal(t);
    fs.mkdirSync(path.join(raiz, 'w'));
    for (const [so, rep] of Object.entries(dejar)) { fs.mkdirSync(path.join(raiz, 'w', `banco-${so}`)); fs.writeFileSync(path.join(raiz, 'w', `banco-${so}`, `banco-${so}.json`), JSON.stringify(rep)); }
    const out = path.join(raiz, 'junto.json');
    const r = spawnSync('bash', ['-c', paso], { cwd: raiz, encoding: 'utf8', env: { ...process.env, BENCH_WORKSPACE: path.join(raiz, 'w'), BENCH_SOURCES: ROOT, BENCH_MERGED: out, BENCH_HISTORY: path.join(raiz, 'hist') } });
    return { ...r, out };
  };
  const sinMac = correr({ linux: conMac() });
  assert.strictEqual(sinMac.status, 0, sinMac.stdout + sinMac.stderr);
  assert.match(sinMac.stdout, /##vso\[task\.logissue type=warning\].*sin medir/);
  assert.ok(fs.existsSync(sinMac.out));
  const sinLinux = correr({ darwin: reporte('darwin', {}) });
  assert.notStrictEqual(sinLinux.status, 0);
  assert.match(sinLinux.stdout, /##vso\[task\.logissue type=error\]/);
});
