#!/usr/bin/env node
'use strict';
// hook-delegation.test.js — la copia propia del pre-commit de otro repo (la del privado adelgazado) le pide al gancho
// público del arnés que corra los controles del inventario que ella no nombra.
// stable-data: los commits de la prueba fijan sus fechas y apagan el mantenimiento.
//
// Lo que no se puede perder:
//   · con TYCON_CHECKS_ONLY, el gancho público corre sólo esos controles, con los guiones del arnés que dice
//     TYCON_CHECKS_CODE_ROOT, y el rojo de uno frena;
//   · como gancho del propio repo, TYCON_CHECKS_ONLY y TYCON_CHECKS_CODE_ROOT no valen: corren todos, con sus guiones;
//   · `run-base-controls.sh unnamed` lista los controles que el gancho público llama y la copia no (ni los de las
//     pasadas, ni el destino de un atajo declarado que la copia llama), y frena si el arnés no trae uno;
//   · un guion pedido que ningún filtro del gancho nombra frena, y cada control del gancho tiene su filtro;
//   · el control de la base no pide paso para un control que la copia declarada delega; sin la declaración, o con la
//     llamada sólo en un comentario, sí;
//   · en un pedido, la declaración sale de la base (uno que la trae no la hace valer) y cambiar una copia que delega
//     pide la constancia del dueño.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const HOOK = path.join(RAIZ, '.githooks', 'pre-commit-checks');
/** ¿El gancho de `raiz` es la copia propia de otro repo? Lo declara su `.tycon/internal-forms.json` (`own`). */
function copiaPropiaEn(raiz) {
  try { const f = JSON.parse(fs.readFileSync(path.join(raiz, '.tycon', 'internal-forms.json'), 'utf8')); return Boolean(f && f.own && f.own['.githooks/pre-commit-checks']); } catch { return false; }
}
// En el árbol armado de la CI del privado, el gancho de la raíz es la copia propia del privado: el gancho público no
// está, y lo prueba la CI del público. Las pruebas del gancho público lo dicen en vez de leer la copia
const SIN_GANCHO_PUBLICO = copiaPropiaEn(RAIZ)
  && 'NO MEDIDO: en este árbol el gancho es la copia propia de otro repo (.tycon/internal-forms.json); el gancho público lo prueba la CI del público';
const RBC = path.join(RAIZ, 'scripts', 'ci', 'run-base-controls.sh');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'TYCON_CHECKS_ONLY', 'TYCON_CHECKS_CODE_ROOT', 'TYCON_GUIDES_DIR', 'TYCON_SKILLS_DIR', 'TYCON_CHECKS_HARNESS_NAMED']) delete ENV[k];

const LABS = [];
test.after(() => { for (const d of LABS) fs.rmSync(d, { recursive: true, force: true }); });
function tmpdir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); LABS.push(d); return d; }
function put(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { env: ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
// un guion de control de juguete: deja su marca y sale con `code`
const marca = (nombre, code = 0) => `'use strict';\nrequire('fs').appendFileSync(process.env.TEST_MARKS, ${JSON.stringify(`${nombre}\n`)});\nprocess.exit(${code});\n`;
const marcas = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).sort() : []);

/** El repo del commit, con algo en el índice; `con` le suma archivos versionados antes. */
function repo(con = {}) {
  const d = tmpdir('delegacion-repo-');
  git(d, 'init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(con)) put(d, rel, text);
  put(d, 'LEEME.txt', 'uno\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'base');
  put(d, 'a.txt', 'cambio\n');
  git(d, 'add', 'a.txt');
  return d;
}
function correHook(cwd, hook, env) {
  const home = tmpdir('delegacion-home-');
  const r = spawnSync('bash', [hook], { cwd, env: { ...ENV, HOME: home, USERPROFILE: home, ...env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('PublicHook_ChecksOnly_RunsOnlyRequested', { skip: SIN_GANCHO_PUBLICO }, () => {
  const arnes = tmpdir('delegacion-arnes-');
  put(arnes, 'scripts/ci/tool-names.js', marca('tool-names-arnes', 1));
  put(arnes, 'scripts/ci/vocabulary.js', marca('vocabulary-arnes'));
  put(arnes, 'scripts/lib/provider-secret-shapes.js', marca('provider-arnes'));
  // los del repo del commit no corren: los guiones salen del arnés
  const r = repo({ 'scripts/ci/tool-names.js': marca('tool-names-repo') });
  const m = path.join(tmpdir('delegacion-marcas-'), 'marcas');
  const env = { TEST_MARKS: m, TYCON_CHECKS_CODE_ROOT: arnes };
  const pedido = correHook(r, HOOK, { ...env, TYCON_CHECKS_ONLY: 'scripts/ci/tool-names.js' });
  assert.strictEqual(pedido.status, 1, `el rojo del control pedido frena\n${pedido.out}`);
  assert.match(pedido.out, /corren sólo los controles que pidió la copia del gancho de este repo: scripts\/ci\/tool-names\.js/);
  assert.match(pedido.out, /el nombre de una herramienta de horas fuera de su integración/);
  assert.deepStrictEqual(marcas(m), ['tool-names-arnes'], 'sólo el pedido, y del arnés');
  fs.rmSync(m, { force: true });
  const dos = correHook(r, HOOK, { ...env, TYCON_CHECKS_ONLY: 'scripts/ci/vocabulary.js scripts/lib/provider-secret-shapes.js' });
  assert.strictEqual(dos.status, 0, dos.out);
  assert.deepStrictEqual(marcas(m), ['provider-arnes', 'vocabulary-arnes']);
  fs.rmSync(m, { force: true });
  const ninguno = correHook(r, HOOK, { ...env, TYCON_CHECKS_ONLY: '' });
  assert.strictEqual(ninguno.status, 0, ninguno.out);
  assert.deepStrictEqual(marcas(m), [], 'con la lista vacía no corre ninguno');
  // un fin de renglón de Windows pegado al nombre no lo esconde
  const conCr = correHook(r, HOOK, { ...env, TYCON_CHECKS_ONLY: 'scripts/ci/vocabulary.js\r\n' });
  assert.strictEqual(conCr.status, 0, conCr.out);
  assert.deepStrictEqual(marcas(m), ['vocabulary-arnes']);
});

test('PublicHook_ChecksOnly_UnknownControlBlocks', { skip: SIN_GANCHO_PUBLICO }, () => {
  const arnes = tmpdir('delegacion-arnes-');
  put(arnes, 'scripts/ci/vocabulary.js', marca('vocabulary-arnes'));
  const m = path.join(tmpdir('delegacion-marcas-'), 'marcas');
  const res = correHook(repo(), HOOK, { TEST_MARKS: m, TYCON_CHECKS_CODE_ROOT: arnes, TYCON_CHECKS_ONLY: 'scripts/ci/vocabulary.js scripts/ci/no-esta.js' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /pidió scripts\/ci\/no-esta\.js y este gancho no tiene un control con ese guion/);
  assert.deepStrictEqual(marcas(m), [], 'frena antes de correr nada');
});

// el mismo detector que el inventario: cada guion que un tramo del gancho llama está en el filtro de ese tramo
test('PublicHook_EveryControlHasItsFilter', { skip: SIN_GANCHO_PUBLICO }, () => {
  const texto = fs.readFileSync(HOOK, 'utf8');
  const llama = /\$\{?(?:REPO_ROOT|TCG)\}?\/([\w.@/-]+?\.(?:js|sh))(?![\w.])/g;
  const publicacion = /harness_publishing\s+([\w.-]+\.js)\b/g;
  const tramos = texto.split(/\n(?=# ── )/).slice(1);
  assert.ok(tramos.length >= 20, `el gancho tiene sus tramos (${tramos.length})`);
  const sinFiltro = [];
  for (const t of tramos) {
    const vivos = t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !/^echo\b/.test(l));
    const guiones = new Set();
    for (const l of vivos) {
      for (const x of l.matchAll(llama)) guiones.add(x[1]);
      for (const x of l.matchAll(publicacion)) guiones.add(`scripts/publishing/${x[1]}`);
    }
    const filtro = new Set([...t.matchAll(/_checks_wanted ([^;\n]+)/g)].flatMap((x) => x[1].trim().split(/\s+/)));
    for (const g of guiones) if (!filtro.has(g)) sinFiltro.push(`${t.split('\n')[0]} → ${g}`);
  }
  assert.deepStrictEqual(sinFiltro, [], 'un control sin su filtro correría aunque la copia pidiera otros');
});

test('PublicHook_OwnRepo_IgnoresChecksOnly', { skip: SIN_GANCHO_PUBLICO }, () => {
  const otro = tmpdir('delegacion-otro-');
  put(otro, 'scripts/ci/tool-names.js', marca('tool-names-otro'));
  put(otro, 'scripts/ci/vocabulary.js', marca('vocabulary-otro'));
  const r = repo({
    '.githooks/pre-commit-checks': fs.readFileSync(HOOK, 'utf8'),
    'scripts/ci/tool-names.js': marca('tool-names-repo'),
    'scripts/ci/vocabulary.js': marca('vocabulary-repo'),
  });
  const m = path.join(tmpdir('delegacion-marcas-'), 'marcas');
  const res = correHook(r, '.githooks/pre-commit-checks', { TEST_MARKS: m, TYCON_CHECKS_ONLY: 'scripts/ci/tool-names.js', TYCON_CHECKS_CODE_ROOT: otro });
  assert.strictEqual(res.status, 0, res.out);
  assert.match(res.out, /TYCON_CHECKS_ONLY no vale en el gancho del propio repo: corren todos los controles/);
  assert.deepStrictEqual(marcas(m), ['tool-names-repo', 'vocabulary-repo'], 'corren todos, con los guiones del repo');
});

/** Un arnés de juguete para `unnamed`: su inventario, su gancho público y los guiones que existen. */
function arnesUnnamed({ publico, controls, existen, renames = null }) {
  const h = tmpdir('delegacion-unnamed-');
  put(h, 'scripts/ci/controls-from-base.json', JSON.stringify({
    hook: '.githooks/pre-commit-checks',
    passes: [{ name: 'pre-commit', mode: 'index', cmd: ['bash', '.githooks/pre-commit-checks'] }, { name: 'p', mode: 'tree', cmd: ['node', 'scripts/ci/p.js'] }],
    controls, content: [], workflows: [], approvals: [],
  }));
  put(h, '.githooks/pre-commit-checks', `#!/usr/bin/env bash\n${publico.map((s) => `node "$REPO_ROOT/${s}" || exit 1`).join('\n')}\n`);
  for (const [rel, text] of Object.entries(existen)) put(h, rel, text);
  if (renames) put(h, 'scripts/lib/renames.json', JSON.stringify({ entries: renames }));
  return h;
}
function unnamed(h, copia, extra = []) {
  const c = path.join(tmpdir('delegacion-copia-'), 'pre-commit-checks');
  fs.writeFileSync(c, `#!/usr/bin/env bash\n${copia.map((s) => `node "$TCG/${s}" || exit 1`).join('\n')}\n`);
  const r = spawnSync('bash', [RBC, 'unnamed', '--hook', c, '--harness', h, ...extra.map((x) => (x === '@copia' ? c : x))], { env: ENV, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

test('Unnamed_ListsWhatCopyDoesNotName', () => {
  const ok = "'use strict';\n";
  const controls = ['a', 'b', 'p', 'v'].map((n) => ({ name: n, script: `scripts/ci/${n}.js`, rules: [] }))
    .concat([{ name: 'o', script: 'scripts/ci/o.js', rules: [], optional: true }]);
  const existen = { 'scripts/ci/a.js': ok, 'scripts/ci/b.js': ok, 'scripts/ci/p.js': ok, 'scripts/ci/v.js': ok,
    'scripts/ci/viejo.js': "'use strict';\n// tycon-legacy-shim: scripts/ci/v.js\nrequire('./v.js');\n" };
  const h = arnesUnnamed({ publico: ['scripts/ci/a.js', 'scripts/ci/b.js', 'scripts/ci/v.js', 'scripts/ci/o.js'], controls, existen,
    renames: [{ kind: 'file', old: 'scripts/ci/viejo.js', new: 'scripts/ci/v.js' }] });
  // b: el público lo llama y la copia no. p corre en una pasada; o es opcional y el arnés no lo trae; v lo nombra el
  // atajo declarado que la copia llama
  const r = unnamed(h, ['scripts/ci/a.js', 'scripts/ci/viejo.js']);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(r.out, 'scripts/ci/b.js');
  // un atajo que el mapa no declara no nombra a su destino
  fs.writeFileSync(path.join(h, 'scripts/lib/renames.json'), JSON.stringify({ entries: [] }));
  const sinMapa = unnamed(h, ['scripts/ci/a.js', 'scripts/ci/viejo.js']);
  assert.strictEqual(sinMapa.out, 'scripts/ci/b.js\nscripts/ci/v.js');
  // la copia que los nombra todos no pide nada
  assert.strictEqual(unnamed(h, ['scripts/ci/a.js', 'scripts/ci/b.js', 'scripts/ci/v.js']).out, '');
  // un gancho público que llama al atajo declarado: se pide con su nombre, que es el que su filtro reconoce
  fs.writeFileSync(path.join(h, 'scripts/lib/renames.json'), JSON.stringify({ entries: [{ kind: 'file', old: 'scripts/ci/viejo.js', new: 'scripts/ci/v.js' }] }));
  fs.writeFileSync(path.join(h, '.githooks/pre-commit-checks'), '#!/usr/bin/env bash\nnode "$REPO_ROOT/scripts/ci/viejo.js" || exit 1\n');
  assert.strictEqual(unnamed(h, ['scripts/ci/a.js']).out, 'scripts/ci/viejo.js');
  assert.strictEqual(unnamed(h, ['scripts/ci/v.js']).out, '', 'la copia que llama al destino ya lo nombra');
});

test('Unnamed_MissingFromHarness_Exits1', () => {
  const controls = ['a', 'c'].map((n) => ({ name: n, script: `scripts/ci/${n}.js`, rules: [] }));
  const h = arnesUnnamed({ publico: ['scripts/ci/a.js', 'scripts/ci/c.js'], controls, existen: { 'scripts/ci/a.js': "'use strict';\n" } });
  const r = unnamed(h, ['scripts/ci/a.js']);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /falta scripts\/ci\/c\.js en el arnés .*: ese control no podría correr/);
  // sin un gancho público distinto de la copia no hay a quién pedirle nada: no pude correr
  const misma = unnamed(h, ['scripts/ci/a.js'], ['--public-hook', '@copia']);
  assert.strictEqual(misma.status, 9, misma.out);
  assert.match(misma.out, /es la misma copia/);
});

/** El árbol armado del privado: el inventario público con un control que la copia propia no nombra. */
function privadoArmado({ delega = 'linea', declarada = true } = {}) {
  const d = tmpdir('delegacion-privado-');
  git(d, 'init', '-q', '-b', 'main');
  put(d, 'scripts/ci/controls-from-base.json', JSON.stringify({
    hook: '.githooks/pre-commit-checks',
    passes: [{ name: 'pre-commit', mode: 'index', cmd: ['bash', '.githooks/pre-commit-checks'] }],
    controls: [{ name: 'a', script: 'scripts/ci/a.sh', rules: [] }, { name: 'nuevo', script: 'scripts/ci/nuevo.sh', rules: [] }],
    content: [], workflows: [], approvals: [],
  }));
  put(d, 'scripts/ci/a.sh', '#!/usr/bin/env bash\nexit 0\n');
  put(d, 'scripts/ci/nuevo.sh', '#!/usr/bin/env bash\nexit 0\n');
  const llamada = 'faltan="$(bash "$TCG/scripts/ci/run-base-controls.sh" unnamed --hook "${BASH_SOURCE[0]}" --harness "$TCG")" || exit 1';
  const linea = { linea: llamada, comentario: `# ${llamada}`, ninguna: 'echo sin delegar' }[delega];
  put(d, '.githooks/pre-commit-checks', `#!/usr/bin/env bash\nbash "$TCG/scripts/ci/a.sh" || exit 1\n${linea}\n`);
  if (declarada) put(d, '.tycon/internal-forms.json', JSON.stringify({ layout: 'thin', own: { '.githooks/pre-commit-checks': 'la copia propia' }, mirror: {} }));
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'armado');
  return d;
}
function checkInventory(d) {
  const r = spawnSync('bash', [RBC, 'check-inventory', '--root', d, '--ref', 'HEAD'], { env: ENV, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('PrivateBase_NewPublicControl_NoStepMissing', () => {
  const ok = checkInventory(privadoArmado());
  assert.strictEqual(ok.status, 0, `la copia declarada que delega: el control nuevo tiene su paso\n${ok.out}`);
  assert.doesNotMatch(ok.out, /ningún paso corre/);
  for (const [caso, opts] of [['sin la declaración', { declarada: false }], ['la llamada en un comentario', { delega: 'comentario' }], ['sin delegar', { delega: 'ninguna' }]]) {
    const r = checkInventory(privadoArmado(opts));
    assert.strictEqual(r.status, 1, `${caso}\n${r.out}`);
    assert.match(r.out, /ningún paso corre scripts\/ci\/nuevo\.sh/, caso);
  }
});

/**
 * Un pedido de juguete para `run`: la base con el inventario, el control `a`, su gancho y (si `declaradaEnBase`) la
 * copia declarada; el pedido cambia el gancho y puede traer su propia declaración.
 */
function pedido({ ganchoBase, ganchoDelPedido, declaradaEnBase, declaradaEnPedido = false }) {
  const d = tmpdir('delegacion-pedido-');
  git(d, 'init', '-q', '-b', 'main');
  put(d, 'scripts/ci/controls-from-base.json', JSON.stringify({
    hook: '.githooks/pre-commit-checks',
    passes: [{ name: 'pre-commit', mode: 'index', cmd: ['bash', '.githooks/pre-commit-checks'] }],
    controls: [{ name: 'a', script: 'scripts/ci/a.sh', rules: [] }],
    content: ['.tycon/'], workflows: [], approvals: ['.tycon/control-changes.jsonl'],
  }));
  put(d, 'scripts/ci/a.sh', '#!/usr/bin/env bash\nexit 0\n');
  put(d, '.githooks/pre-commit-checks', ganchoBase);
  const forms = JSON.stringify({ layout: 'thin', own: { '.githooks/pre-commit-checks': 'la copia propia' }, mirror: {} });
  if (declaradaEnBase) put(d, '.tycon/internal-forms.json', forms);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'base');
  git(d, 'switch', '-q', '-c', 'pedido');
  put(d, '.githooks/pre-commit-checks', ganchoDelPedido);
  if (declaradaEnPedido) put(d, '.tycon/internal-forms.json', forms);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'pedido');
  const r = spawnSync('bash', [RBC, 'run', '--root', d, '--base', 'main', '--range', 'main...pedido'], { env: ENV, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const RAIZ_DEL_GANCHO = 'TCG="$(git rev-parse --show-toplevel)"';
const LLAMA_A = 'bash "$TCG/scripts/ci/a.sh" || exit 1';
// la llamada que delega, muerta: el texto está, pero nunca corre
const DELEGA_MUERTA = 'exit 0\nfaltan="$(bash "$TCG/scripts/ci/run-base-controls.sh" unnamed --hook x --harness "$TCG")" || exit 1';

test('PrivateBase_DelegatingCopyChange_AsksOwner', () => {
  // el pedido saca el control de la copia que delega y deja la delegación muerta: pide la constancia del dueño
  const r = pedido({
    ganchoBase: `#!/usr/bin/env bash\n${RAIZ_DEL_GANCHO}\n${LLAMA_A}\n${DELEGA_MUERTA}\n`,
    ganchoDelPedido: `#!/usr/bin/env bash\n${RAIZ_DEL_GANCHO}\n${DELEGA_MUERTA}\n`,
    declaradaEnBase: true,
  });
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /el pedido afloja un control sin la constancia del dueño: [^\n]*\.githooks\/pre-commit-checks/);
  // el pedido que EMPIEZA a delegar (la copia de la base no delega) y saca el control en el mismo cambio, también
  const primero = pedido({
    ganchoBase: `#!/usr/bin/env bash\n${RAIZ_DEL_GANCHO}\n${LLAMA_A}\n`,
    ganchoDelPedido: `#!/usr/bin/env bash\n${RAIZ_DEL_GANCHO}\n${DELEGA_MUERTA}\n`,
    declaradaEnBase: true,
  });
  assert.strictEqual(primero.status, 1, primero.out);
  assert.match(primero.out, /el pedido afloja un control sin la constancia del dueño: [^\n]*\.githooks\/pre-commit-checks/);
});

test('PublicBase_DeclarationBroughtByPr_NotAccepted', () => {
  // el gancho del arnés no delega: un pedido que saca un control y trae su propia declaración no apaga «ningún paso»
  const r = pedido({
    ganchoBase: `#!/usr/bin/env bash\n${RAIZ_DEL_GANCHO}\n${LLAMA_A}\n`,
    ganchoDelPedido: `#!/usr/bin/env bash\n${RAIZ_DEL_GANCHO}\n${DELEGA_MUERTA}\n`,
    declaradaEnBase: false,
    declaradaEnPedido: true,
  });
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /ningún paso corre scripts\/ci\/a\.sh/);
});

test('ArmedTree_OwnCopyDeclared_PublicHookNotMeasured — en el árbol armado, las pruebas del gancho público dicen que no miden', () => {
  // el árbol armado del privado declara el gancho como copia propia: ahí el gancho de la raíz no es el público
  const armado = tmpdir('delegacion-armado-');
  put(armado, '.tycon/internal-forms.json', JSON.stringify({ layout: 'thin', own: { '.githooks/pre-commit-checks': 'el suyo' }, mirror: {} }));
  assert.strictEqual(copiaPropiaEn(armado), true);
  // sin la declaración, con otro archivo propio o con el archivo roto, el gancho de la raíz es el público
  const publico = tmpdir('delegacion-publico-');
  assert.strictEqual(copiaPropiaEn(publico), false);
  put(publico, '.tycon/internal-forms.json', JSON.stringify({ layout: 'thin', own: { 'pipelines/x.yml': 'otro' } }));
  assert.strictEqual(copiaPropiaEn(publico), false);
  put(publico, '.tycon/internal-forms.json', '{ roto');
  assert.strictEqual(copiaPropiaEn(publico), false);
  // en este árbol, lo que vale para las pruebas del gancho público sale de la misma lectura
  assert.strictEqual(Boolean(SIN_GANCHO_PUBLICO), copiaPropiaEn(RAIZ));
});
