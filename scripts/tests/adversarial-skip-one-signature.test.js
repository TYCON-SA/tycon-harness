'use strict';
/**
 * adversarial-skip-one-signature.test.js — saltear el pase adversarial se firma una sola vez (@story-8.238).
 *
 * `--no-deep-review` y `TYCON_NO_DEEP_REVIEW=1` son pedidos: el portón sólo saltea con la constancia `adversarial-skip`.
 * El freno de la consola no les pide otra firma, y la revisión de la noche no los cuenta como un salteo sin firma. Lo
 * que sigue frenando: un `--env-file` delante de los guiones del pase (puede traer una variable que cambia la decisión)
 * y la variable escrita en el archivo de arranque del shell.
 *
 * Corre el freno y su lector de verdad, con una casa de juguete. Los comandos van en las tablas de abajo, no en el texto
 * de un comando: el freno de esta máquina los leería.
 * Correr: node --test scripts/tests/adversarial-skip-one-signature.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const HOOK = path.join(RAIZ, 'scripts', 'hooks', 'safety-guard-pre.sh');
const SCRIPTS = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts');
const RUN_CLOSE = path.join(SCRIPTS, 'lib', 'run-close.js');
const P = `${SCRIPTS}/pipeline.js`;
const M = `${SCRIPTS}/marker.js`;

function casaNueva(t) {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skip-una-firma-')));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
}
function entorno(home) {
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
  return env;
}
// el lector del freno de la consola: los renglones `frena=` que devuelve para el comando
function frenos(home, comando) {
  const r = spawnSync(process.execPath, [RUN_CLOSE, '--gate', '--session', 's-una-firma', '--command-stdin', '--shell', 'bash'],
    { input: comando, encoding: 'utf8', env: entorno(home) });
  return String(r.stdout || '').split('\n').filter((l) => l.startsWith('frena='));
}
// el freno entero, como lo llama la herramienta
function freno(home, comando) {
  const input = JSON.stringify({ session_id: 's-una-firma', tool_name: 'Bash', tool_input: { command: comando }, cwd: home, permission_mode: 'bypassPermissions' });
  return spawnSync('bash', [HOOK], { input, encoding: 'utf8', env: entorno(home) });
}

// T1 OneSignature_NoDeepReviewFlagDoesNotBrake @story-8.238 @ac-1
// 🔴 Falla con: la bandera vieja pidiendo su propia firma (escape:no-deep-review) antes de la única que saltea.
test('T1 OneSignature_NoDeepReviewFlagDoesNotBrake @story-8.238 @ac-1', (t) => {
  const h = casaNueva(t);
  for (const c of [
    `node ${P} start --story s.md --no-deep-review`,
    `node ${P} deep-review-gate --repo /x --story /x/s.md --files a.md --no-deep-review`,
    `node ${M} mark-adversarial-skipped --files a.md --no-deep-review`,
    `F=--no-deep-review; node ${P} start --story s.md $F`,
    `node ${M} mark-adversarial-skipped --files a.md "$F"`,
  ]) {
    assert.deepStrictEqual(frenos(h, c), [], `no frena: ${c}`);
  }
  // escondido sin subcomando a la vista: ya no es el pase, pero puede ser `clear` (lo decide la ejecución, como siempre)
  assert.deepStrictEqual(frenos(h, `node ${P} $S --no-deep-review`), [], 'pipeline.js sin subcomando: la bandera no es un escape');
});

// T2 OneSignature_EnvFileStillBrakesWithItsReason @story-8.238 @ac-3
// 🔴 Falla con: un --env-file delante de los guiones del pase que pasa sin firma, o un cartel que habla de la bandera.
test('T2 OneSignature_EnvFileStillBrakesWithItsReason @story-8.238 @ac-3', (t) => {
  const h = casaNueva(t);
  for (const [c, sub] of [
    [`node --env-file=x.env ${P} start --story s.md`, 'start'],
    [`node --env-file=x.env ${P} deep-review-gate --repo /x --story /x/s.md --files a.md`, 'deep-review-gate'],
    [`node --env-file=x.env ${M} mark-adversarial-skipped --files a.md`, 'mark-adversarial-skipped'],
  ]) {
    const f = frenos(h, c);
    assert.strictEqual(f.length, 1, `frena una vez: ${c}\n${f.join('\n')}`);
    assert.match(f[0], new RegExp(`^frena=no-deep-review\\t${sub}\\t`), c);
  }
  const r = freno(h, `node --env-file=x.env ${P} deep-review-gate --repo /x --story /x/s.md --files a.md`);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /ESC-C3/);
  assert.match(r.stderr, /--env-file delante de deep-review-gate puede traer una variable que cambia la decisión del pase/, r.stderr);
});

// T3 OneSignature_VariableDoesNotAskEscC1ButRcStillBrakes @story-8.238 @ac-2
// 🔴 Falla con: ESC-C1 pidiendo una firma por la variable (que no saltea nada), o el archivo de arranque del shell que
//    deja de frenar.
test('T3 OneSignature_VariableDoesNotAskEscC1ButRcStillBrakes @story-8.238 @ac-2', (t) => {
  const h = casaNueva(t);
  for (const c of [
    `TYCON_NO_DEEP_REVIEW=1 node ${P} deep-review-gate --repo /x --story /x/s.md --files a.md`,
    `export TYCON_NO_DEEP_REVIEW=1; node ${P} next`,
  ]) {
    const r = freno(h, c);
    assert.doesNotMatch(r.stderr, /ESC-C1|ESC-C3/, `${c}\n${r.stderr}`);
    assert.strictEqual(r.status, 0, `${c}\n${r.stderr}`);
  }
  const rc = freno(h, `echo 'export TYCON_NO_DEEP_REVIEW=1' >> ~/.zshrc`);
  assert.strictEqual(rc.status, 2, rc.stderr);
  assert.match(rc.stderr, /HARNESS-C1/);
});

// T4 OneSignature_NightDoesNotCountTheOldFlagAsUnsigned @story-8.238 @ac-4
// 🔴 Falla con: la noche sumando «pase salteado sin firma» por la variable vieja, que sólo pide la firma que saltea.
test('T4 OneSignature_NightDoesNotCountTheOldFlagAsUnsigned @story-8.238 @ac-4', () => {
  const RULES = require(path.join(RAIZ, 'scripts', 'nightly', 'runs-review', 'rules.js'));
  assert.ok(!RULES.ESCAPES.includes('TYCON_NO_DEEP_REVIEW'), 'la variable no es un escape de la noche');
  const ts = '2026-11-21T15:00:00.000Z';
  const linea = (command) => [
    { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command } }] } },
    { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] } },
  ];
  const volcado = { archivedAt: '2026-11-21T22:00:00.000Z', marker: { sessionId: 's', startedAt: '2026-11-21T10:00:00.000Z', stepsCompleted: [], stepsPending: [], checks: {} } };
  const registros = { cobertura: { fuentes: { bypass: { estado: 'medido' }, frenos: { estado: 'medido' } } }, bypass: [], frenos: [] };
  for (const c of [`TYCON_NO_DEEP_REVIEW=1 node ${P} next`, `TYCON_NO_DEEP_REVIEW=1 node ${M} mark-adversarial-skipped --files a.js`, `node ${P} start --no-deep-review`]) {
    const r = RULES.revisar({ volcado, lineasHilo: linea(c), registros });
    assert.deepStrictEqual(r.reglas.filter((x) => x.regla === 'RR-ESCAPE'), [], c);
  }
  // la línea vieja del registro (de cuando la bandera salteaba sin constancia) sigue contando
  const vieja = { ...registros, bypass: [{ ts, kind: 'ADVERSARIAL_SKIP_FORZADO', sessionId: 's' }] };
  const r = RULES.revisar({ volcado, lineasHilo: [], registros: vieja });
  assert.deepStrictEqual(r.reglas.filter((x) => x.regla === 'RR-ESCAPE').map((x) => x.categoria), ['ADVERSARIAL_SKIP_FORZADO']);
});

// T5 OneSignature_SignatureIdsStayWithNewText @story-8.238 @ac-5
// 🔴 Falla con: un id sacado de la tabla (rompe un perfil que lo nombra en owner_only) o el texto viejo, que promete
//    saltear el pase.
test('T5 OneSignature_SignatureIdsStayWithNewText @story-8.238 @ac-5', () => {
  delete require.cache[require.resolve(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'))];
  const cat = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
  const de = (id) => cat.SIGNATURES.find((s) => s.id === id);
  for (const id of ['escape:no-deep-review', 'escape:TYCON_NO_DEEP_REVIEW']) {
    const s = de(id);
    assert.ok(s, `${id} sigue en la tabla`);
    const todo = JSON.stringify(s);
    assert.doesNotMatch(todo, /arranca sin el pase adversarial|sigue sin el pase adversarial/, `${id}: el texto viejo`);
  }
  assert.match(JSON.stringify(de('escape:no-deep-review')), /--env-file/, 'la firma que queda es la del --env-file');
  // la variable sólo pide saltear el pase y esta firma no lo saltea (sin el sustantivo «pedido», que los textos no
  // usan): en la pregunta, en su inglés y en su «si sale mal»
  const variable = de('escape:TYCON_NO_DEEP_REVIEW');
  assert.match(variable.approves, /^pedir .*no lo saltea.*adversarial-skip/, 'la variable sólo pide saltear el pase');
  assert.match(variable.approvesEn, /^ask .*does not skip it.*adversarial-skip/, 'también en inglés');
  assert.match(variable.ifWrong, /el pase corre igual/, 'si sale mal: el pase corre igual');
  const en = JSON.stringify(de('escape:no-deep-review'));
  assert.match(en, /env-file/);
});
