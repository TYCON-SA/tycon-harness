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

test('Golden_Recorded_StillMatchesTree @story-8.85 @ac-27', () => {
  const dir = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'platform-golden');
  for (const f of ['hard-signals-baseline.json', 'az-commands.json', ...G.SUITES.map((s) => `${s.replace(/\.test\.(js|sh)$/, '')}.calls`)]) assert.ok(fs.existsSync(path.join(dir, f)), `falta ${f}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tests', 'lib', 'record-platform-golden.js'), 'compare', '--without-suites'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});
