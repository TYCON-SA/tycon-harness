'use strict';
// pr-update-source-branch.test.js — el freno de pedidos juzga `--delete-source-branch` de un `az repos pr update` con la
// rama del pedido, que le pregunta a la plataforma (scripts/lib/pr-source-branch.js con el conector de Azure DevOps). Antes
// el `update` frenaba `true` siempre y el mensaje terminaba con la regla de crear («false sólo desde dev…»): reponer el
// auto-completar de una rama story/… no tenía salida (con false pedía true, con true pedía false).
// Todo con un az de mentira (tests/lib/fake-az.sh) y un repo cuyo remoto es de Azure DevOps.
// Correr: cd scripts/tests && HOME=$(mktemp -d) node --test pr-update-source-branch.test.js < /dev/null

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const GUARD = path.join(ROOT, 'scripts', 'hooks', 'pr-auto-complete-guard.js');
const FAKE_AZ = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-az.sh');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const pedido = (n, rama) => ({ pullRequestId: n, status: 'active', isDraft: false, title: `pedido ${n}`, sourceRefName: `refs/heads/${rama}`,
  targetRefName: 'refs/heads/main', repository: { name: 'Backend', project: { name: 'Producto' } } });

/** Un mundo con el perfil en Azure DevOps, el az de mentira con los pedidos 7 (story/7) y 8 (dev), y el repo del remoto. */
function mundo() {
  const tree = tmp('arbol-');
  const home = tmp('casa-');
  fs.writeFileSync(path.join(tree, 'team-profile.json'), JSON.stringify({ integrations: { platform: { default: 'azure-devops' } } }));
  fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' },
    profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'github', org: 'acme', repo: 'operaciones' } }));
  const fix = tmp('fixaz-');
  fs.writeFileSync(path.join(fix, 'repos-pr.json'), JSON.stringify([pedido(7, 'story/7-algo'), pedido(8, 'dev')]));
  const az = path.join(tmp('az-'), 'az');
  fs.copyFileSync(FAKE_AZ, az);
  fs.chmodSync(az, 0o755);
  const repo = tmp('repo-');
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'maintenance.auto=false', ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://dev.azure.com/acme/Producto/_git/Backend');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_TREE: tree, TYCON_INTEGRATIONS_DIR: path.join(ROOT, 'integrations'),
    TYCON_HOME: path.join(home, '.tycon'), TYCON_ADO_CMD: az, FIXAZ: fix };
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|PLATFORM|PROFILE|PR_BY_HAND)$/.test(k)) delete env[k];
  delete env.TYCON_PR_AUTO_COMPLETE_GUARD;
  return { env, repo };
}

function frenar(m, command) {
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: m.repo }), env: m.env, encoding: 'utf8', timeout: 30000 });
  return { code: r.status, err: r.stderr || '' };
}
const upd = (n, v, extra = '') => `az repos pr update --id ${n} --auto-complete true --squash false ${extra}--delete-source-branch ${v}`;

// 🔴 Falla con: el freno de antes, que frena `true` en todo `update` (el pedido de una rama story/… no podía borrarla).
test('PrUpdate_EphemeralBranch_TrueGoesFalseStops — un pedido de una rama efímera: true pasa y false frena', () => {
  const m = mundo();
  assert.strictEqual(frenar(m, upd(7, 'true')).code, 0, 'true desde story/7 pasa');
  const r = frenar(m, upd(7, 'false'));
  assert.strictEqual(r.code, 2, 'false desde story/7 frena: la rama quedaría viva');
  assert.match(r.err, /story\/7-algo/, 'el motivo nombra la rama');
  assert.match(r.err, /va `--delete-source-branch true`/, 'y dice el valor que va');
});

test('PrUpdate_LongLivedBranch_FalseGoesTrueStops — un pedido de dev: false pasa y true frena', () => {
  const m = mundo();
  assert.strictEqual(frenar(m, upd(8, 'false')).code, 0, 'false desde dev pasa');
  const r = frenar(m, upd(8, 'true'));
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /borraría `dev`/);
});

// 🔴 Falla con: un mensaje del update que termina con la regla de crear («false sólo desde dev…»), que contradice lo que pide.
test('PrUpdate_Message_HasNoCreateRule — el mensaje de un update no trae la regla de crear', () => {
  const m = mundo();
  const r = frenar(m, upd(7, 'false'));
  assert.doesNotMatch(r.err, /az repos pr create \.\.\./, 'no propone un create');
  assert.doesNotMatch(r.err, /sólo desde dev, develop, main o master: las demás ramas/, 'ni la línea de crear');
  assert.match(r.err, /el mismo update lleva/);
});

// 🔴 Falla con: un freno que confía en una rama que no pudo leer, o que la pregunta en otro repo u otra organización.
test('PrUpdate_BranchUnknown_TrueStopsFalseGoes — sin la rama (pedido que no existe, otra organización, otra carpeta, sin detección), true frena y false pasa', () => {
  const m = mundo();
  const casos = [
    ['pedido que no existe', (v) => upd(99, v)],
    ['otra organización', (v) => upd(7, v, '--org https://dev.azure.com/otra ')],
    ['la misma organización, escrita', (v) => upd(7, v, '--org https://dev.azure.com/acme ')],
    ['cambia de carpeta', (v) => `cd /tmp && ${upd(7, v)}`],
    ['sin detección', (v) => upd(7, v, '--detect false ')],
  ];
  for (const [nombre, c] of casos) {
    const conTrue = frenar(m, c('true'));
    const conFalse = frenar(m, c('false'));
    if (nombre === 'la misma organización, escrita') {
      assert.deepStrictEqual([conTrue.code, conFalse.code], [0, 2], `${nombre}: con la rama leída, como un story`);
      continue;
    }
    assert.strictEqual(conTrue.code, 2, `${nombre}: true frena`);
    assert.match(conTrue.err, /no pude leer la rama del pedido/, `${nombre}: dice que no pudo leerla`);
    assert.strictEqual(conFalse.code, 0, `${nombre}: false pasa`);
  }
});

test('PrUpdate_PublishDraft_UsesTheBranch — publicar un borrador de una rama efímera con true pasa', () => {
  const m = mundo();
  assert.strictEqual(frenar(m, upd(7, 'true', '--draft false ')).code, 0);
  assert.strictEqual(frenar(m, upd(8, 'true', '--draft false ')).code, 2, 'de dev, true frena');
});

test('PrUpdate_OrgName_Forms — la organización escrita como nombre o como dirección que termina en él', () => {
  const { mismaOrg } = require('../lib/pr-source-branch.js');
  assert.strictEqual(mismaOrg('https://dev.azure.com/Acme/', 'acme'), true);
  assert.strictEqual(mismaOrg('acme', 'Acme'), true);
  assert.strictEqual(mismaOrg('https://dev.azure.com/acme/Producto', 'acme'), false, 'con algo detrás no se da por la misma');
  assert.strictEqual(mismaOrg('https://dev.azure.com/notacme', 'acme'), false, 'otra que termina igual no cuenta');
  assert.strictEqual(mismaOrg('https://dev.azure.com/acme', ''), false);
});
