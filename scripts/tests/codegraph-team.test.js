'use strict';
// codegraph-team.test.js — CodeGraph prendido por la organización: el plan del instalador, el paso después del sí, los
// efectos, doctor y el tooling del pipeline; y Telegram fuera de «Tu organización» en «Cómo trabaja».
// Nada lee el HOME real: los hogares, los perfiles y los binarios son de juguete.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const H = require(path.join(ROOT, 'scripts', 'setup', 'harness.js'));
const P = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js'));
const HIW = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'how-it-works.js'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// un perfil del equipo de juguete y un PATH sin codegraph (o con uno falso)
function profile(integrations) {
  const dir = tmp('cg-profile-');
  fs.writeFileSync(path.join(dir, 'team-profile.json'), JSON.stringify({ integrations }));
  return dir;
}
function pathWith(names) {
  const bin = tmp('cg-bin-');
  for (const n of names) fs.writeFileSync(path.join(bin, n), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}
const envFor = (prof, bin) => ({ HOME: tmp('cg-home-'), PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter), ...(prof ? { TYCON_PROFILE: path.join(prof, 'team-profile.json') } : {}) });
const onWindows = process.platform === 'win32' ? 'los binarios falsos son guiones de sh' : false;

test('T3 HowItWorks_OrgStrip_NoTelegram @story-8.75 @ac-3: «Tu organización» no lista Telegram', () => {
  const dir = profile({ clockify: true, codegraph: true });
  fs.writeFileSync(path.join(dir, 'team-repos.json'), JSON.stringify({ version: 1 }));
  const org = HIW.readOrg({ treeDir: ROOT, profileDir: dir });
  assert.ok(!('telegram' in org.integrations), JSON.stringify(org.integrations));
  assert.strictEqual(org.integrations.codegraph, true);
  const tab = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'tabs', 'how-it-works.js'), 'utf8');
  assert.match(tab, /comoTrabaja\.telegramDeCadaMaquina/);
});

test('T4 InstallPlan_TeamCodegraphOn_MissingBinary_HasLine @story-8.75 @ac-4: el plan suma el renglón de CodeGraph', () => {
  const prof = profile({ codegraph: true });
  const env = envFor(prof, pathWith([]));
  // sin terminal el instalador pide el perfil por opción antes de armar el plan
  const out = H.installQuestions({ home: env.HOME, env, opts: { profile: 'minimal' }, tree: ROOT }, ROOT, null);
  assert.ok((out.head || []).some((l) => /CodeGraph: tu organización lo usa/.test(l)), JSON.stringify(out));
  assert.strictEqual(out.codegraphInstall, true);
});

test('T5 InstallPlan_CodegraphOffOrPresent_NoLine @story-8.75 @ac-4: sin el perfil, o con el binario, no hay renglón', { skip: onWindows }, () => {
  for (const [prof, names] of [[profile({ codegraph: false }), []], [null, []], [profile({ codegraph: true }), ['codegraph']]]) {
    const env = envFor(prof, pathWith(names));
    const out = H.installQuestions({ home: env.HOME, env, opts: { profile: 'minimal' }, tree: ROOT }, ROOT, null);
    assert.ok(!(out.head || []).some((l) => /CodeGraph: tu organización/.test(l)), JSON.stringify(out.head));
    assert.ok(!out.codegraphInstall);
  }
});

test('T6 Install_CodegraphOn_RunsInstallerAndFailureContinues @story-8.75 @ac-5: lo corre; si falla, lo dice y sigue', { skip: onWindows }, () => {
  for (const [code, ok] of [[0, true], [1, false]]) {
    const tree = tmp('cg-tree-');
    fs.mkdirSync(path.join(tree, 'scripts', 'setup'), { recursive: true });
    const mark = path.join(tree, 'corrido');
    fs.writeFileSync(path.join(tree, 'scripts', 'setup', 'install-codegraph.sh'), `#!/bin/sh\necho "$@" > "${mark}"\nexit ${code}\n`, { mode: 0o755 });
    const r = H.codegraphInstall({ tree, env: { PATH: process.env.PATH, HOME: tmp('cg-home-') } });
    assert.ok(fs.existsSync(mark), 'corrió el instalador de CodeGraph');
    // sólo la herramienta y el hook: no indexa la carpeta desde la que corre el instalador
    assert.strictEqual(fs.readFileSync(mark, 'utf8').trim(), '--tool-only');
    assert.strictEqual(r.ok, ok);
    if (!ok) assert.match(r.note, /CodeGraph no se pudo instalar.*el arnés quedó instalado/);
  }
});

test('T7 Effects_CodegraphNotInformative @story-8.75 @ac-6: el efecto dice qué hace prendida por la organización', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'install-effects.json'), 'utf8'));
  const cg = JSON.stringify(fx).match(/\{[^{}]*"key": ?"codegraph"[^{}]*\}/)[0];
  assert.doesNotMatch(cg, /informativa/);
  assert.match(cg, /organización/);
});

test('T8 Doctor_TeamCodegraphOn_MissingBinary_Warns @story-8.75 @ac-7: doctor avisa sólo si está prendida y falta', { skip: onWindows }, () => {
  const run = (prof, names) => {
    const env = envFor(prof, pathWith(names));
    const items = [];
    H.doctorConfigItems({ home: env.HOME, env }, ROOT, null, { ok: false }, (level, line) => items.push({ level, line }), {});
    return items.filter((i) => /CodeGraph/.test(i.line) && i.level === 'warn');
  };
  assert.strictEqual(run(profile({ codegraph: true }), []).length, 1);
  assert.match(run(profile({ codegraph: true }), [])[0].line, /esta máquina no lo tiene.*install-codegraph/);
  assert.strictEqual(run(profile({ codegraph: true }), ['codegraph']).length, 0);
  assert.strictEqual(run(profile({ codegraph: false }), []).length, 0);
});

test('T9 ToolingExpected_TeamCodegraphOn_ExpectsCodegraph @story-8.75 @ac-8: sin .codegraph/, la integración prendida lo espera', () => {
  const repo = tmp('cg-repo-');
  const on = P.computeToolingExpected(repo, { integrations: { codegraph: true }, exec: () => { throw new Error('no está'); }, skillsDir: tmp('cg-skills-') });
  const list = on.expected || on;
  assert.ok(list.some((e) => e.name === 'codegraph'), JSON.stringify(list.map((e) => e.name)));
  const off = P.computeToolingExpected(repo, { integrations: { codegraph: false }, exec: () => { throw new Error('no está'); }, skillsDir: tmp('cg-skills-') });
  assert.ok(!(off.expected || off).some((e) => e.name === 'codegraph'));
});
