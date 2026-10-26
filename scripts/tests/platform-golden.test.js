'use strict';
// platform-golden.test.js — la foto de llamadas a Azure DevOps (scripts/tests/lib/record-platform-golden.js): que la
// normalización deje la misma foto en cada corrida, que el núcleo excluya lo que no es núcleo, y que la foto grabada siga
// valiendo para el árbol de hoy (sin escribir nada en el árbol).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const G = require(path.join(ROOT, 'scripts', 'tests', 'lib', 'record-platform-golden.js'));

test('Golden_Normalize_TmpAndDatesReplaced @story-8.85 @ac-27', () => {
  const tmp = path.join(os.tmpdir(), 'foto-xyz', 'cuerpo.json');
  assert.strictEqual(G.normalizar(`crear\t["boards","work-item","create","--description","@${tmp}","2026-10-22T05:34:50Z"]`),
    'crear\t["boards","work-item","create","--description","@<tmp>","<fecha>"]');
  assert.strictEqual(G.normalizar(G.normalizar('x /tmp/a/b 2026-10-22')), G.normalizar('x /tmp/a/b 2026-10-22'), 'normalizar dos veces da lo mismo');
});

test('Golden_HardSignal_CommandsNotWords @story-8.85 @ac-27', () => {
  for (const s of ['az repos pr list --org x', 'https://dev.azure.com/acme/p', 'System.Title', 'Microsoft.VSTS.Scheduling.Effort', '.tycon/ado-config.yaml']) assert.ok(G.DURA.test(s), s);
  for (const s of ['Azure DevOps', 'el pedido de trabajo', 'azure', 'github.com/acme/r']) assert.ok(!G.DURA.test(s), s);
});

test('Golden_Core_ExcludesIntegrationsTestsAndSiteCloud @story-8.85 @ac-27', () => {
  const fuera = (f) => G.AFUERA.some((rx) => rx.test(f));
  for (const f of ['integrations/azure-devops/scripts/connector.js', 'guides/integrations/ado-projects.md', 'scripts/tests/x.test.js', 'scripts/site/cloud/azure.js', 'scripts/controls-bench/cases/hooks/01.json']) assert.ok(fuera(f), f);
  for (const f of ['scripts/hooks/pr-auto-complete-guard.js', 'skills/tycon-pipeline/steps/step-09-ado-story-closure.md']) assert.ok(!fuera(f), f);
});

test('Golden_Core_OnlyWhatTravels — en el árbol armado, un comando az en una spec del privado no es del núcleo', (t) => {
  // 🔴 rojo: una spec del privado que cita un comando az aparece como un comando nuevo del público
  const { overlayLab } = require('./lib/overlay-lab.js');
  const lab = overlayLab({ privado: { 'specs/s.md': 'az boards query\n' }, publico: { 'guides/g.md': 'az boards query\n' } });
  t.after(lab.cleanup);
  assert.deepStrictEqual(G.nucleo(lab.root), ['guides/g.md'], 'el núcleo es sólo lo que trajo el público');
  assert.deepStrictEqual(Object.keys(G.literales({ root: lab.root })), ['guides/g.md'], 'los comandos az, sólo de lo que viaja');
  // la foto grabada se compara sólo en lo que viaja: el archivo del privado no trae la versión del público
  const grabada = { 'specs/s.md': ['az boards query'], 'guides/g.md': ['az boards query'] };
  assert.deepStrictEqual(Object.keys(G.grabadosQueViajan(grabada, lab.root)), ['guides/g.md']);
  lab.git(['checkout', '--quiet', lab.tip]);
  assert.deepStrictEqual(Object.keys(G.grabadosQueViajan(grabada, lab.root)), ['specs/s.md', 'guides/g.md'], 'sin superposición, la foto entera');
  assert.deepStrictEqual(G.nucleo(lab.root), ['specs/s.md'], 'sin superposición, el árbol entero');
  // lo traído es sólo una integración: del núcleo no viaja nada, y eso no es verde
  const fuera = overlayLab({ privado: { 'specs/s.md': 'az boards query\n' }, publico: { 'integrations/x/a.js': 'a\n' } });
  t.after(fuera.cleanup);
  assert.throws(() => G.nucleo(fuera.root), /no se midió/, 'sin nada que revisar, rojo');
  // las integraciones: la del privado no cuenta, la del público sí; y si ninguna viaja, la foto no las miró
  const integ = overlayLab({ privado: { 'integrations/p/a.js': 'az boards query\n' }, publico: { 'integrations/q/b.js': 'az repos pr list\n', 'guides/g.md': 'g\n' } });
  t.after(integ.cleanup);
  assert.deepStrictEqual(G.deIntegraciones(integ.root), ['integrations/q/b.js']);
  const sinInteg = overlayLab({ privado: { 'integrations/p/a.js': 'az boards query\n' }, publico: { 'guides/g.md': 'g\n' } });
  t.after(sinInteg.cleanup);
  assert.throws(() => G.deIntegraciones(sinInteg.root), /no se midió/, 'integraciones que no viajan: rojo');
  assert.deepStrictEqual(G.deIntegraciones(lab.root), [], 'sin integraciones, nada que contar');
});

test('Golden_Recorded_StillMatchesTree @story-8.85 @ac-27', () => {
  const dir = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'platform-golden');
  for (const f of ['hard-signals-baseline.json', 'az-commands.json', ...G.SUITES.map((s) => `${s.replace(/\.test\.(js|sh)$/, '')}.calls`)]) assert.ok(fs.existsSync(path.join(dir, f)), `falta ${f}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tests', 'lib', 'record-platform-golden.js'), 'compare', '--without-suites'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});
