'use strict';

/**
 * bench-against-base.test.js — el banco de un pedido corre los casos de la BASE contra los ganchos del pedido.
 *
 * Lo que fija: un pedido que afloja un freno no entra sin la firma del dueño, aunque además cambie el caso,
 * la línea de base o el corredor del banco; uno que endurece o suma casos entra sin trámite; lo que no se pudo medir es
 * rojo con su motivo, nunca verde.
 *
 * Todo corre sobre un repo de juguete (git de verdad): una base con un gancho de juguete que carga una biblioteca, sus
 * dos casos (uno que frena y uno que deja pasar), la línea de base, la lista de huecos, el inventario con su carpeta de
 * constancias y el corredor real del banco, copiado de este árbol. Cada prueba arma un pedido encima. HOME vacía.
 *
 * T6 no lanza `run-base-controls.sh approve --terminal` (pide una terminal de verdad): escribe la misma línea que escribe
 * `approve` (`{ hash, rules, at, by }`, con el hash de siempre: sha256 de «ruta\tblob\n» ordenadas).
 *
 * Correr: node --test scripts/tests/bench-against-base.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'bench-against-base.js');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-against-base-'));
test.after(() => { fs.rmSync(SCRATCH, { recursive: true, force: true }); });

const EMPTY_HOME = path.join(SCRATCH, 'home');
fs.mkdirSync(EMPTY_HOME);
const EMPTY_CONFIG = path.join(SCRATCH, 'gitconfig-vacio');
fs.writeFileSync(EMPTY_CONFIG, '[init]\n\tdefaultBranch = main\n');
const ENV = (() => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|TYCON_)/.test(k)) env[k] = v;
  return Object.assign(env, { HOME: EMPTY_HOME, USERPROFILE: EMPTY_HOME, GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false',
    GIT_AUTHOR_NAME: 'Prueba', GIT_AUTHOR_EMAIL: 'prueba@example.invalid', GIT_COMMITTER_NAME: 'Prueba', GIT_COMMITTER_EMAIL: 'prueba@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
})();
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ── la base de juguete ───────────────────────────────────────────────────────────────────────────────────────────────
const HOOK = 'scripts/hooks/juguete.js';
const LIB = 'scripts/hooks/juguete-lib.js';
const CASES = 'scripts/controls-bench/cases/hooks/01-juguete.json';
const BASELINE = 'scripts/controls-bench/baseline/claude.json';
const RUNNER = 'scripts/controls-bench/runner.js';
const BLOCKS = 'juguete.js::frena-peligro';

const HOOK_TEXT = `'use strict';
const { PATTERN } = require('./juguete-lib.js');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const cmd = String(((JSON.parse(input || '{}').tool_input) || {}).command || '');
  if (PATTERN.test(cmd)) { process.stderr.write('juguete: frenado\\n'); process.exit(2); }
  process.exit(0);
});
`;
const LIB_TEXT = "'use strict';\nmodule.exports = { PATTERN: /PELIGRO/ };\n";
const caseFile = (blocksType = 'must-block', extra = {}) => JSON.stringify({
  hooks: [{
    hook: 'juguete.js', script: '${TCG}/' + HOOK, event: 'PreToolUse', matcher: 'Bash',
    cases: [
      Object.assign({ id: 'frena-peligro', type: blocksType, stdin: { tool_name: 'Bash', tool_input: { command: 'PELIGRO' } },
        expect: blocksType === 'must-block' ? { exit: 2, stderr_re: ['juguete'] } : {} }, extra),
      { id: 'deja-pasar', type: 'must-not-block', stdin: { tool_name: 'Bash', tool_input: { command: 'ls' } }, expect: {} },
    ],
  }],
}, null, 2) + '\n';
const baseline = (blocks = true) => JSON.stringify({ tool: 'claude', cases: { [BLOCKS]: blocks, 'juguete.js::deja-pasar': true } }, null, 2) + '\n';
const INVENTORY = JSON.stringify({ hook: '.githooks/pre-commit-checks', controls: [], approvals: ['.github/control-changes/'] }, null, 2) + '\n';

function write(dir, rel, text) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
function copyFromHere(dir, rel) { write(dir, rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')); }

let labs = 0;
/** Una base de juguete, en `main`. `opts.base` cambia lo que trae la base antes de su commit. */
function makeLab(opts = {}) {
  const dir = path.join(SCRATCH, `lab-${++labs}`);
  fs.mkdirSync(dir);
  git(dir, ['init', '-q']);
  for (const rel of [RUNNER, 'scripts/controls-bench/report-name.js', 'scripts/lib/clean-git-env.js', 'scripts/lib/git-bash.js']) copyFromHere(dir, rel);
  write(dir, HOOK, HOOK_TEXT);
  write(dir, LIB, LIB_TEXT);
  write(dir, CASES, opts.cases || caseFile('must-block', opts.caseExtra));
  write(dir, BASELINE, baseline(opts.baselineBlocks !== false));
  write(dir, 'scripts/tests/windows/known-gaps.json', '{ "gaps": [] }\n');
  write(dir, 'scripts/ci/controls-from-base.json', INVENTORY);
  write(dir, 'README.md', 'base\n');
  if (opts.base) opts.base(dir);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return { dir, base: git(dir, ['rev-parse', 'HEAD']) };
}
/** Un pedido encima de la base: escribe o borra (texto null) y commitea. Devuelve la punta. */
function pr(lab, changes, msg = 'pedido') {
  for (const [rel, text] of Object.entries(changes)) {
    if (text === null) fs.rmSync(path.join(lab.dir, rel), { force: true });
    else write(lab.dir, rel, text);
  }
  git(lab.dir, ['add', '-A']);
  git(lab.dir, ['commit', '-q', '--allow-empty', '-m', msg]);
  return git(lab.dir, ['rev-parse', 'HEAD']);
}
function run(lab, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', lab.dir, '--base', lab.base, ...args],
    { encoding: 'utf8', env: ENV, cwd: SCRATCH, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const hashOf = (entries) => crypto.createHash('sha256').update(entries.map((e) => `${e.path}\t${e.blob}\n`).sort().join('')).digest('hex');
/** La constancia en la carpeta del inventario, como la escribe `approve`, con los campos que se le pasen. */
function sign(lab, paths, fields = { by: 'dueño' }) {
  const rules = paths.map((p) => ({ path: p, blob: git(lab.dir, ['rev-parse', `HEAD:${p}`]) }));
  const line = Object.assign({ hash: hashOf(rules), rules, at: '2030-01-15' }, fields);
  return pr(lab, { [`.github/control-changes/${line.hash}.json`]: JSON.stringify(line) + '\n' }, 'firma');
}

const LOOSE_HOOK = HOOK_TEXT.replace("process.stderr.write('juguete: frenado\\n'); process.exit(2);", 'process.exit(0);');
const LOOSE_LIB = "'use strict';\nmodule.exports = { PATTERN: /NUNCA-ESTO/ };\n";

// ── las pruebas ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('T1 Arma_BaseYPedido @story-8.152 @ac-1 — corre los casos de la base sobre los ganchos del pedido, sin tocar el clon', () => {
  const lab = makeLab();
  const tip = pr(lab, { 'README.md': 'pedido\n' });
  const status = git(lab.dir, ['status', '--porcelain']);
  const r = run(lab);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /1 caso\(s\) de la base que exigen algo de su gancho/, r.out);
  assert.strictEqual(git(lab.dir, ['rev-parse', 'HEAD']), tip, 'el clon cambió de punta');
  assert.strictEqual(git(lab.dir, ['status', '--porcelain']), status, 'el clon quedó con cambios');
  assert.strictEqual(git(lab.dir, ['worktree', 'list']).split('\n').length, 1, 'quedó una copia de trabajo armada');
});

test('T2 Aflojado_Sale1_NombraElCaso @story-8.152 @ac-2 — un gancho que deja de frenar pide la firma, con el comando', () => {
  const lab = makeLab();
  pr(lab, { [HOOK]: LOOSE_HOOK });
  const r = run(lab);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /juguete\.js::frena-peligro/, r.out);
  assert.match(r.out, /scripts\/hooks\/juguete\.js/, r.out);
  assert.match(r.out, /must-block/, r.out);
  assert.match(r.out, /NO bloqueó/, r.out);
  assert.match(r.out, /bash scripts\/ci\/run-base-controls\.sh approve --root \S+ --entries '\[\{"path":"scripts\/hooks\/juguete\.js","blob":"[0-9a-f]{40}"\}\]' --out \.github\/control-changes\//, r.out);
  assert.doesNotMatch(r.out, /deja-pasar.*aflojado/, r.out);
});

test('T3 EndurecidoYNuevo_Sale0 @story-8.152 @ac-3 — endurecer un gancho o sumar casos no pide firma', () => {
  const lab = makeLab();
  pr(lab, {
    [LIB]: "'use strict';\nmodule.exports = { PATTERN: /PELIGRO|ls/ };\n",
    'scripts/controls-bench/cases/hooks/02-nuevo.json': caseFile().replace(/frena-peligro/g, 'nuevo-caso').replace(/deja-pasar/g, 'nuevo-pasa'),
  });
  const r = run(lab);
  assert.strictEqual(r.code, 0, r.out);
});

test('T4 LineaDeBaseCasoYCorredor_NoTapanElGancho @story-8.152 @ac-4 — lo que el pedido cambia en el banco no tapa un gancho aflojado', () => {
  const tapas = {
    'la línea de base': { [BASELINE]: baseline(false) },
    'el expect del caso': { [CASES]: caseFile('must-not-block') },
    'el corredor': { [RUNNER]: "'use strict';\nconsole.log('todo verde');\nprocess.exitCode = 0;\n" },
  };
  for (const [what, change] of Object.entries(tapas)) {
    const tapado = makeLab();
    pr(tapado, Object.assign({ [HOOK]: LOOSE_HOOK }, change));
    const r1 = run(tapado);
    assert.strictEqual(r1.code, 1, `aflojar el gancho y cambiar ${what}: ${r1.out}`);
    assert.match(r1.out, /juguete\.js::frena-peligro/, r1.out);
    const solo = makeLab();
    pr(solo, change);
    const r0 = run(solo);
    assert.strictEqual(r0.code, 0, `cambiar sólo ${what}: ${r0.out}`);
  }
  // el corredor carga bibliotecas de fuera del banco: en su proceso salen de la base, así que una del pedido que
  // reescribe el informe no tapa el gancho aflojado; y cambiarla sin aflojar nada no pide firma
  const forjado = "\nif (/runner\\.js$/.test(process.argv[1] || '')) process.on('exit', () => { const a = process.argv; const f = a[a.indexOf('--json') + 1]; const r = JSON.parse(require('fs').readFileSync(f, 'utf8')); for (const k of Object.keys(r.results)) for (const t of Object.values(r.results[k].tools)) { t.pass = true; t.failures = []; } require('fs').writeFileSync(f, JSON.stringify(r)); });\n";
  const tapaLib = makeLab();
  pr(tapaLib, { [HOOK]: LOOSE_HOOK, 'scripts/lib/clean-git-env.js': fs.readFileSync(path.join(ROOT, 'scripts/lib/clean-git-env.js'), 'utf8') + forjado });
  const rl = run(tapaLib);
  assert.strictEqual(rl.code, 1, `aflojar el gancho y reescribir el informe desde una biblioteca del corredor: ${rl.out}`);
  assert.match(rl.out, /aflojado: juguete\.js::frena-peligro/, rl.out);
  const soloLib = makeLab();
  pr(soloLib, { 'scripts/lib/clean-git-env.js': fs.readFileSync(path.join(ROOT, 'scripts/lib/clean-git-env.js'), 'utf8') + forjado });
  const r0 = run(soloLib);
  assert.strictEqual(r0.code, 0, `cambiar sólo una biblioteca del corredor: ${r0.out}`);
});

test('T5 Borrar_EsAflojar @story-8.152 @ac-5 — borrar el gancho, o su caso aflojando el gancho, pide la firma', () => {
  const sinGancho = makeLab();
  pr(sinGancho, { [HOOK]: null });
  const r1 = run(sinGancho);
  assert.strictEqual(r1.code, 1, r1.out);
  assert.match(r1.out, /juguete\.js::frena-peligro/, r1.out);
  assert.match(r1.out, /"blob":"borrado"/, r1.out);
  const sinCaso = makeLab();
  pr(sinCaso, { [CASES]: null, [HOOK]: LOOSE_HOOK });
  const r2 = run(sinCaso);
  assert.strictEqual(r2.code, 1, r2.out);
  assert.match(r2.out, /juguete\.js::frena-peligro/, r2.out);
});

test('T6 ConFirma_Pasa_CambioDespues_Vuelve @story-8.152 @ac-6 — la constancia del dueño anclada al blob deja pasar; otro cambio vuelve a pedirla', () => {
  const lab = makeLab();
  pr(lab, { [LIB]: LOOSE_LIB });
  const before = run(lab);
  assert.strictEqual(before.code, 1, before.out);
  assert.match(before.out, /juguete-lib\.js/, 'la biblioteca que carga el gancho es parte del ancla');
  sign(lab, [LIB]);
  const signed = run(lab);
  assert.strictEqual(signed.code, 0, signed.out);
  pr(lab, { [LIB]: "'use strict';\nmodule.exports = { PATTERN: /OTRA-COSA/ };\n" });
  const after = run(lab);
  assert.strictEqual(after.code, 1, after.out);
});

test('T7 Delegacion_NoFirma @story-8.152 @ac-7 — ni la delegación ni la sesión designada cubren un aflojamiento', () => {
  const delegada = makeLab();
  pr(delegada, { [LIB]: LOOSE_LIB });
  sign(delegada, [LIB], { by: 'coordinadora', via: 'delegacion', quote: 'dale', maquina: 'una', signed_by_session: 'x' });
  const r1 = run(delegada);
  assert.strictEqual(r1.code, 1, r1.out);
  assert.match(r1.out, /ventana del dueño/, r1.out);
  const designada = makeLab();
  pr(designada, { [LIB]: LOOSE_LIB });
  sign(designada, [LIB], { by: 'coordinadora' });
  const r2 = run(designada);
  assert.strictEqual(r2.code, 1, r2.out);
  assert.match(r2.out, /ventana del dueño/, r2.out);
});

test('T8 NoMedido_Rojo @story-8.152 @ac-8 — lo que no se pudo medir es rojo con el motivo; lo que la base ya no juzga, no se juzga', () => {
  const sinCorredor = makeLab({ base: (dir) => fs.rmSync(path.join(dir, RUNNER)) });
  pr(sinCorredor, { 'README.md': 'x\n' });
  const a = run(sinCorredor);
  assert.strictEqual(a.code, 9, a.out);
  assert.match(a.out, /no pude correr: .*runner\.js/, a.out);

  const lab = makeLab();
  pr(lab, { 'README.md': 'x\n' });
  const b = run(lab, ['--base', 'no-existe-esta-base']);
  assert.strictEqual(b.code, 9, b.out);
  assert.match(b.out, /no pude correr: .*no-existe-esta-base/, b.out);

  const corredorRaro = makeLab({ base: (dir) => write(dir, RUNNER, "'use strict';\nprocess.exitCode = 3;\n") });
  pr(corredorRaro, { 'README.md': 'x\n' });
  const c = run(corredorRaro);
  assert.strictEqual(c.code, 9, c.out);
  assert.match(c.out, /no pude correr: el corredor de la base salió 3/, c.out);

  const tardon = makeLab({ caseExtra: { timeout_s: 1 } });
  // stable-data: el gancho de juguete espera 3 s para pasar el tope de 1 s del caso; no lee una fecha
  pr(tardon, { [LIB]: "'use strict';\nconst t = Date.now(); while (Date.now() - t < 3000) {}\nmodule.exports = { PATTERN: /PELIGRO/ };\n" });
  const d = run(tardon);
  assert.strictEqual(d.code, 1, d.out);
  assert.match(d.out, /no medido: juguete\.js::frena-peligro/, d.out);
  sign(tardon, [LIB]);
  const d2 = run(tardon);
  assert.strictEqual(d2.code, 1, `la firma no cubre un no medido: ${d2.out}`);

  // otro gancho, verde en la línea de base, para que haya algo que juzgar: el caso ya rojo de la base no se juzga
  const yaRojo = makeLab({ baselineBlocks: false, base: (dir) => {
    write(dir, 'scripts/hooks/otro.js', HOOK_TEXT);
    write(dir, 'scripts/controls-bench/cases/hooks/02-otro.json', caseFile().replace(/juguete\.js/g, 'otro.js').replace(/deja-pasar/g, 'otro-pasa'));
    write(dir, BASELINE, JSON.stringify({ tool: 'claude', cases: { [BLOCKS]: false, 'juguete.js::deja-pasar': true, 'otro.js::frena-peligro': true, 'otro.js::otro-pasa': true } }) + '\n');
  } });
  pr(yaRojo, { [HOOK]: LOOSE_HOOK });
  const e = run(yaRojo);
  assert.strictEqual(e.code, 0, e.out);

  // el corredor de la base pide un módulo que la base no trae y el pedido sí: no se toma del pedido
  const sinModulo = makeLab({ base: (dir) => write(dir, RUNNER, "require('../lib/del-pedido.js');\n" + fs.readFileSync(path.join(ROOT, RUNNER), 'utf8')) });
  pr(sinModulo, { 'scripts/lib/del-pedido.js': "process.on('exit', () => {});\n" });
  const g = run(sinModulo);
  assert.strictEqual(g.code, 9, g.out);

  // nada que juzgar (la línea de base sin casos verdes que exijan algo) no es verde: es «no pude correr»
  const nada = makeLab({ baselineBlocks: false });
  pr(nada, { [HOOK]: LOOSE_HOOK });
  const f = run(nada);
  assert.strictEqual(f.code, 9, f.out);
  assert.match(f.out, /no pude correr: ningún caso de la base se pudo juzgar/, f.out);
});

test('T6b LaFirmaCubreTodoElPedido @story-8.152 @ac-6 — un gancho que corre por una copia del caso, o un dato que lee el gancho, no queda fuera de la firma', () => {
  // la base: además del gancho de siempre, uno que el caso copia a su carpeta (la forma de los casos reales del freno de
  // producción) y que lee su lista de patrones de un .json
  const lab = makeLab({ base: (dir) => {
    write(dir, 'scripts/hooks/copiado.js', HOOK_TEXT.replace("const { PATTERN } = require('./juguete-lib.js');",
      "const PATTERN = new RegExp(require('./copiado-rules.json').join('|'));"));
    write(dir, 'scripts/hooks/copiado-rules.json', '["PELIGRO"]\n');
    write(dir, 'scripts/controls-bench/cases/hooks/02-copiado.json', JSON.stringify({ hooks: [{ hook: 'copiado.js',
      script: '${FIXTURE}/tcg/scripts/hooks/copiado.js', event: 'PreToolUse', matcher: 'Bash',
      cases: [{ id: 'frena', type: 'must-block', setup: ['mkdir -p tcg/scripts/hooks && cp "$TCG"/scripts/hooks/copiado.js "$TCG"/scripts/hooks/copiado-rules.json tcg/scripts/hooks/'],
        stdin: { tool_name: 'Bash', tool_input: { command: 'PELIGRO' } }, expect: { exit: 2 } }] }] }) + '\n');
    write(dir, BASELINE, JSON.stringify({ tool: 'claude', cases: { [BLOCKS]: true, 'juguete.js::deja-pasar': true, 'copiado.js::frena': true } }) + '\n');
  } });
  pr(lab, { [HOOK]: LOOSE_HOOK });
  assert.strictEqual(run(lab).code, 1);
  sign(lab, [HOOK]);
  const signed = run(lab);
  assert.strictEqual(signed.code, 0, signed.out);
  pr(lab, { 'scripts/hooks/copiado-rules.json': '["NUNCA-ESTO"]\n' });
  const after = run(lab);
  assert.strictEqual(after.code, 1, `el dato del gancho copiado cambió después de la firma: ${after.out}`);
  assert.match(after.out, /copiado\.js::frena/, after.out);
  assert.match(after.out, /scripts\/hooks\/copiado-rules\.json/, 'el dato entra al ancla nueva');
});

test('T6c MergeDeGitHub_FirmaLaRamaYMideContraLaBaseQueVio @story-8.152 @ac-6 — la firma se ancla a la rama del pedido, y main que avanzó no inventa un aflojamiento', () => {
  const lab = makeLab();
  const base0 = lab.base;
  git(lab.dir, ['checkout', '-q', '-b', 'pedido']);
  pr(lab, { [HOOK]: LOOSE_HOOK, [LIB]: LIB_TEXT + '// el pedido\n' });
  const prHead = git(lab.dir, ['rev-parse', 'HEAD']);
  git(lab.dir, ['checkout', '-q', 'main']);
  pr(lab, { [LIB]: '// main\n' + LIB_TEXT }, 'main avanza');
  const base1 = git(lab.dir, ['rev-parse', 'HEAD']);
  // el commit que revisa GitHub: el merge del pedido en main (primer padre, main)
  git(lab.dir, ['merge', '-q', '--no-ff', '--no-edit', 'pedido']);
  const merged = { dir: lab.dir, base: base1 };
  const r = run(merged);
  assert.strictEqual(r.code, 1, r.out);
  const libBlob = git(lab.dir, ['rev-parse', `${prHead}:${LIB}`]);
  assert.match(r.out, new RegExp(`"path":"${LIB}","blob":"${libBlob}"`), 'el blob que se firma es el de la rama, no el del merge');
  // el dueño firma en la rama del pedido y GitHub vuelve a armar el merge: la firma lo deja pasar
  git(lab.dir, ['checkout', '-q', 'pedido']);
  sign(lab, [HOOK, LIB]);
  git(lab.dir, ['checkout', '-q', '--detach', base1]);
  git(lab.dir, ['merge', '-q', '--no-ff', '--no-edit', 'pedido']);
  const firmado = run(merged);
  assert.strictEqual(firmado.code, 0, `la firma de la rama sobre el merge de GitHub: ${firmado.out}`);

  // main avanzó después del merge que revisa GitHub (una corrida repetida) y endureció el gancho con un caso nuevo: se
  // mide contra la base que vio el pedido, no se inventa un aflojamiento de un gancho que el pedido no tocó
  const lab2 = makeLab();
  git(lab2.dir, ['checkout', '-q', '-b', 'otro']);
  const prOnly = pr(lab2, { 'README.md': 'sólo el leeme\n' });
  git(lab2.dir, ['checkout', '-q', '--detach', lab2.base]);
  git(lab2.dir, ['merge', '-q', '--no-ff', '--no-edit', 'otro']);
  const tipViejo = git(lab2.dir, ['rev-parse', 'HEAD']);
  git(lab2.dir, ['checkout', '-q', 'main']);
  const baseNueva = pr(lab2, {
    [LIB]: "'use strict';\nmodule.exports = { PATTERN: /PELIGRO|RIESGO/ };\n",
    [CASES]: caseFile().replace('"id": "deja-pasar"', '"id": "frena-riesgo", "type": "must-block", "stdin": { "tool_name": "Bash", "tool_input": { "command": "RIESGO" } }, "expect": { "exit": 2 } }, { "id": "deja-pasar"'),
    [BASELINE]: JSON.stringify({ tool: 'claude', cases: { [BLOCKS]: true, 'juguete.js::deja-pasar': true, 'juguete.js::frena-riesgo': true } }) + '\n',
  }, 'main endurece');
  const viejo = run({ dir: lab2.dir, base: baseNueva }, ['--tip', tipViejo]);
  assert.strictEqual(viejo.code, 0, viejo.out);
  assert.match(viejo.out, /la punta no trae la base/, viejo.out);
  // una rama que no trae la base ni es el merge de GitHub: no se sabe contra qué medir
  const suelto = run({ dir: lab2.dir, base: baseNueva }, ['--tip', prOnly]);
  assert.strictEqual(suelto.code, 9, suelto.out);
  assert.match(suelto.out, /no pude correr: la punta \S+ no trae la base/, suelto.out);
});

test('T2b Salida_SinComandosDeLaCI_ComandoCitado @story-8.152 @ac-2 — lo que trae el pedido no arma comandos de la CI ni rompe el comando de la firma', () => {
  const { signCommand, neutral } = require(SCRIPT);
  assert.strictEqual(neutral('::error::forjado ##vso[x]'), ': :error::forjado # #vso[x]');
  assert.strictEqual(neutral('  ::warning::x'), '  : :warning::x', 'con espacios adelante también: GitHub los recorta');
  assert.strictEqual(neutral('❌ aflojado: juguete.js::frena-peligro'), '❌ aflojado: juguete.js::frena-peligro', 'el nombre de un caso queda legible');
  assert.strictEqual(neutral('a\u0007b'), 'a\\x07b');
  const cmd = signCommand([{ path: "scripts/hooks/it's.js", blob: 'a'.repeat(40) }], '.github/control-changes/');
  assert.strictEqual(cmd, `bash scripts/ci/run-base-controls.sh approve --root <repo> --entries '[{"path":"scripts/hooks/it'\\''s.js","blob":"${'a'.repeat(40)}"}]' --out .github/control-changes/`);
  const echoed = spawnSync('bash', ['-c', `printf '%s' ${cmd.split('--entries ')[1].split(' --out')[0]}`], { encoding: 'utf8' }).stdout;
  assert.strictEqual(JSON.parse(echoed)[0].path, "scripts/hooks/it's.js", 'el shell devuelve las entradas tal cual');
  assert.strictEqual(signCommand([{ path: 'a::b.js', blob: 'x' }], 'o/'), null, 'una ruta que la salida no muestra tal cual no va como comando');

  // la falla del gancho del pedido llega a la salida sin poder empezar una línea con «::»
  const lab = makeLab({ caseExtra: { expect: { exit: 2, stderr_re: ['juguete'] } } });
  pr(lab, { [HOOK]: LOOSE_HOOK.replace("'use strict';", "'use strict';\nprocess.stderr.write('\\n::error::forjado\\n');") });
  const r = run(lab);
  assert.strictEqual(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /^::/m, r.out);
});
