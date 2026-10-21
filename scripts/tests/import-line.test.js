'use strict';
/**
 * import-line.test.js — la línea de ~/.claude/CLAUDE.md que carga el índice de guías (scripts/setup/harness/import-line.js).
 * En Node a propósito: corre igual en el agente Windows.
 *
 * EL CASO. El índice es INDEX.md y README.md es la portada para personas. Una
 * máquina con la línea vieja cargaría la portada en cada sesión. La línea vieja se reescribe en su lugar, sin duplicarla
 * ni tocar el resto del archivo, en tres momentos: el aplicador del árbol nuevo (la misma actualización), harness.js
 * (install y cada arranque) y el aviso sincrónico del arranque, que además le pide a la sesión que ya arrancó con la
 * línea vieja que lea el índice.
 *
 *   T1 · la forma vieja (README.md del lugar) pasa a INDEX.md en su lugar; lo de antes y lo de después quedan igual.
 *   T2 · con la vieja y la nueva, queda UNA, en el lugar de la primera; con el nombre viejo del lugar, pasa a INDEX.md
 *        con ese mismo nombre (sólo `relocate` la muda al lugar); con los dos nombres, queda la del lugar.
 *   T3 · los finales de línea \r\n se conservan; sin la línea, nada cambia y fixFile no la agrega.
 *   T4 · la línea suelta: --fix reescribe, --check no escribe, --quiet calla cuando no hay nada que hacer.
 *   T5 · el aviso del arranque (branch-guard-notice.js) con la línea vieja: la reescribe y pide leer INDEX.md;
 *        con la línea actual, no dice nada del índice; con las dos, saca la vieja y calla.
 *   T6 · los dos aplicadores (sh y ps1) llaman a la línea suelta con --fix, también con --check.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..', '..');
const IL = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'import-line.js'));
const PLACE = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'place.js'));

const NEW = `@~/.claude/${PLACE.PLACE_NAME}/INDEX.md`;
const OLD = `@~/.claude/${PLACE.PLACE_NAME}/README.md`;
const LEGACY = `@~/.claude/${PLACE.LEGACY_PLACE_NAME}/README.md`;
const LEGACY_NEW = `@~/.claude/${PLACE.LEGACY_PLACE_NAME}/INDEX.md`;

const LAB = fs.mkdtempSync(path.join(os.tmpdir(), 'import-line-'));
test.after(() => { try { fs.rmSync(LAB, { recursive: true, force: true }); } catch (_) { /* nada */ } });
let n = 0;
const md = (text) => { const f = path.join(LAB, `CLAUDE-${++n}.md`); fs.writeFileSync(f, text); return f; };
const node = (args, env = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', env: Object.assign({}, process.env, env) });

test('T1 · la forma vieja pasa a INDEX.md en su lugar, sin tocar lo demás', () => {
  assert.strictEqual(IL.IMPORT_LINE, NEW);
  const before = `# mío\n\n${OLD}\n\n## más mío\nuna línea\n`;
  const r = IL.rewrite(before);
  assert.strictEqual(r.changed, 1);
  assert.strictEqual(r.text, `# mío\n\n${NEW}\n\n## más mío\nuna línea\n`);
});

test('T2 · vieja y nueva: queda una, en el lugar de la primera; el nombre viejo del lugar también', () => {
  const r = IL.rewrite(`a\n${OLD}\nb\n${NEW}\nc\n`);
  assert.strictEqual(r.text, `a\n${NEW}\nb\nc\n`);
  const r2 = IL.rewrite(`${NEW}\nx\n${LEGACY}\n${OLD}\n`);
  assert.strictEqual(r2.text, `${NEW}\nx\n`);
  assert.strictEqual(r2.changed, 2);
  // con el nombre viejo del lugar: pasa a INDEX.md con el mismo nombre; mudarla al lugar es de `relocate`
  const r3 = IL.rewrite(`x\n${LEGACY}\n`);
  assert.strictEqual(r3.text, `x\n${LEGACY_NEW}\n`);
  assert.strictEqual(IL.rewrite(`x\n${LEGACY}\n`, { relocate: true }).text, `x\n${NEW}\n`);
  assert.strictEqual(IL.rewrite(`x\n${LEGACY_NEW}\n`).changed, 0, 'la de hoy por el nombre viejo vale tal cual');
  assert.strictEqual(IL.rewrite(`${LEGACY}\ny\n${OLD}\n`).text, `${NEW}\ny\n`, 'con los dos nombres queda la del lugar');
  assert.ok(IL.hasOldForm(`x\n  ${LEGACY}  \n`));
  assert.ok(!IL.hasOldForm(`x\n${NEW}\n`));
});

test('T3 · \\r\\n se conserva; sin la línea no cambia nada y fixFile no la agrega', () => {
  const r = IL.rewrite(`a\r\n${OLD}\r\nb\r\n`);
  assert.strictEqual(r.text, `a\r\n${NEW}\r\nb\r\n`);
  const none = 'sin la línea\n@~/.claude/otra-cosa/README.md\n';
  assert.deepStrictEqual(IL.rewrite(none), { text: none, changed: 0, present: false });
  const f = md(none);
  assert.strictEqual(IL.fixFile(f).status, 'absent');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), none);
  assert.strictEqual(IL.fixFile(path.join(LAB, 'no-existe.md')).status, 'no-file');
});

test('T4 · la línea suelta: --fix, --check y --quiet', () => {
  const lib = path.join(ROOT, 'scripts', 'setup', 'harness', 'import-line.js');
  const f = md(`mío\n${OLD}\n`);
  let r = node([lib, '--fix', '--check'], { CLAUDE_MD_PATH: f });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(simulado\)/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), `mío\n${OLD}\n`, '--check escribió');
  r = node([lib, '--fix', '--quiet'], { CLAUDE_MD_PATH: f });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /pasa a/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), `mío\n${NEW}\n`);
  r = node([lib, '--fix', '--quiet', f]);
  assert.strictEqual(r.stdout, '', 'con --quiet y nada que hacer, calla');
  r = node([lib]);
  assert.strictEqual(r.status, 2);
});

test('T5 · el aviso del arranque: con la línea vieja la reescribe y pide leer INDEX.md', () => {
  const hook = path.join(ROOT, 'scripts', 'hooks', 'branch-guard-notice.js');
  const home = fs.mkdtempSync(path.join(LAB, 'home-'));
  const f = md(`mío\n${OLD}\nmás\n`);
  const env = { HOME: home, USERPROFILE: home, CLAUDE_MD_PATH: f, TYCON_HOME: path.join(home, '.tycon') };
  let r = node([hook], env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), `mío\n${NEW}\nmás\n`);
  assert.ok(r.stdout.includes(path.join(ROOT, 'INDEX.md')), `no pidió leer el índice: ${r.stdout}`);
  assert.match(r.stdout, /cargó la portada/);
  r = node([hook], env);
  assert.ok(!/índice de guías/.test(r.stdout), `con la línea de hoy habló del índice: ${r.stdout}`);
  // la sesión siguiente a una actualización por el arranque: la actual y, abajo, la que agregó el programa de antes
  fs.writeFileSync(f, `mío\n${NEW}\nmás\n${OLD}\n`);
  r = node([hook], env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), `mío\n${NEW}\nmás\n`, 'no sacó la repetida');
  assert.ok(!/índice de guías/.test(r.stdout), `con las dos líneas la sesión cargó el índice y no hay que pedirlo: ${r.stdout}`);
});

test('T6 · los dos aplicadores llaman a la línea suelta', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'install-tycon-hooks.sh'), 'utf8');
  assert.match(sh, /setup\/harness\/import-line\.js" --fix --quiet/);
  assert.match(sh, /setup\/harness\/import-line\.js" --fix --check --quiet/);
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'install-tycon-hooks.ps1'), 'utf8');
  assert.match(ps, /'import-line\.js'/);
  assert.match(ps, /\$ilArgs = @\('--fix', '--quiet'\); if \(\$Check\) \{ \$ilArgs \+= '--check' \}/);
});
