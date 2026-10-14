'use strict';

/**
 * public-push-guard.test.js — el freno antes de publicar, en un empuje (story 8.26, tanda F1 · AC 22 y 53).
 *
 * Con el arnés mantenido directo en el repo público, una rama empujada ya es pública. Este freno es lo único que hay
 * antes. Lo que no puede pasar:
 *   · que mire la diferencia neta (un commit mete un nombre y el siguiente lo saca: el nombre queda en la historia);
 *   · que mire sólo los términos de la lista (un token, un correo o una ruta de máquina salen igual);
 *   · que «no pude mirar» —sin lista en una máquina del equipo, un objeto ilegible, el tope de tiempo— salga verde;
 *   · que frene lo sano (un freno que corta el camino normal se apaga): por eso cada rojo tiene su verde al lado;
 *   · que la salida o el registro traigan el texto encontrado.
 *
 * Cómo se prueba sin un repo público: el freno corre COPIADO a un arnés de laboratorio (así la prueba decide si esa
 * «máquina» tiene el perfil del equipo y dónde está la lista), contra repos de juguete. Un repo desnudo local hace de
 * público con TYCON_PUBLIC_PUSH_TREAT_AS_PUBLIC, que sólo AGREGA remotos a mirar. La lista es inventada: ningún término
 * de esta prueba sale de una lista de verdad. El empuje real, con el hook instalado, lo corre githook-pre-push.test.sh.
 *
 * Tanda F2 (AC 23): el MODO DE RANGO (`range --base … --head …`), con el que la validación mira un pedido —cada commit
 * que suma a su rama destino, la rama, el título y el cuerpo—: T23 y T63. Y lo que la F1 dejó para cuando el control de
 * historia interna estuviera en el árbol: T67, con el control de verdad. El paso real del YAML que llama a ese modo se
 * mide en pr-suites-shards.test.js.
 *
 * Correr: node --test scripts/tests/public-push-guard.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const TERM = 'Zorblax';            // inventado
const OTHER_TERM = 'Quimbaya9';    // inventado, para la segunda lista
const GOOD = { name: 'Mantenedor De Prueba', email: '4242+mantenedor@users.noreply.github.com' };
const BAD_EMAIL = 'alguien@example.com';
const ZERO = '0'.repeat(40);
// armados acá: escritos de corrido, este archivo —que viaja en la copia— dispararía el detector que prueba
const TOKEN = `gh${'p'}_${'a1B2'.repeat(9)}`;
const MACHINE_PATH = ['', 'Users', 'alguien', 'proyecto', ''].join('/');
const REAL_LOOKING_EMAIL = ['otra.persona', 'empresa-de-verdad.com'].join('@');

// lo que el freno necesita para correr, copiado a un arnés de laboratorio
const PIECES = ['scripts/hooks/public-push-guard.js', 'scripts/lib/az-pr.js', 'scripts/lib/gh-pr.js', 'scripts/lib/harness-repo.js',
  'scripts/lib/legacy-names.js', 'scripts/lib/guard-record.js', 'scripts/publishing/detector.js', 'scripts/setup/harness/tycon-home.js'];
// El control de historia interna, el de verdad (tanda G): de él sale la forma del número de pedido. Hasta que estuvo
// en el árbol, esta prueba usaba un doble con el mismo contrato; un doble más generoso que el real daba verde a casos
// que el real no frena (`arreglo/PR#123`, `pr-123`), y por eso ya no hay doble: lo que se mide es el control que corre.
const HISTORY = 'scripts/publishing/internal-history.js';

const cleanEnv = () => {
  const env = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'ComSpec', 'PATHEXT', 'LANG']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
};

function git(cwd, args, { who = GOOD, committer = who, env = {}, tolerate = false } = {}) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], {
    cwd, encoding: 'utf8',
    env: { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, HOME: cwd,
      GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, ...env },
  });
  if (r.status !== 0 && !tolerate) throw new Error(`git ${args.join(' ')} salió ${r.status}: ${r.stderr}`);
  return String(r.stdout || '').trim();
}

/** Un laboratorio: el arnés de la «máquina» (con o sin perfil del equipo), el repo de trabajo y los remotos. */
function lab(t, { team = true, harnessTree = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ppg-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const harness = path.join(root, 'arnes');
  for (const p of PIECES) {
    fs.mkdirSync(path.dirname(path.join(harness, p)), { recursive: true });
    fs.copyFileSync(path.join(REPO, p), path.join(harness, p));
  }
  fs.copyFileSync(path.join(REPO, HISTORY), path.join(harness, HISTORY));
  if (team) fs.writeFileSync(path.join(harness, 'perfil-equipo.json'), '{}\n');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.tycon'), { recursive: true });
  const publicDir = path.join(root, 'publico');
  const publicUrl = path.join(publicDir, 'remoto.git');
  const localUrl = path.join(root, 'local.git');
  fs.mkdirSync(publicDir);
  git(root, ['init', '--quiet', '--bare', '--initial-branch=main', publicUrl]);
  git(root, ['init', '--quiet', '--bare', '--initial-branch=main', localUrl]);
  const work = path.join(root, 'trabajo');
  git(root, ['init', '--quiet', '--initial-branch=main', work]);
  if (harnessTree) write(work, 'scripts/install-tycon-hooks.sh', '#!/bin/sh\n');
  write(work, 'README.md', 'un repo de juguete\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'base']);
  git(work, ['remote', 'add', 'origin', publicUrl]);
  git(work, ['push', '--quiet', 'origin', 'main']);
  const list = path.join(root, 'lista.json');
  writeList(list, TERM);
  return { root, harness, home, publicDir, publicUrl, localUrl, work, list };
}

function write(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}
function writeList(file, term, extra = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ terminos: [{ patron: term, categoria: 'cliente' }], permitidos: [], ...extra }, null, 2)}\n`);
}

/** Un commit en una rama nueva desde main. `files`: ruta → contenido (un Buffer vale). Devuelve el sha. */
function commitOn(fx, branch, files, message = 'un cambio', opts = {}) {
  git(fx.work, ['checkout', '--quiet', '-B', branch, opts.from || 'main']);
  return commitHere(fx, files, message, opts);
}
function commitHere(fx, files, message = 'un cambio', opts = {}) {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) fs.rmSync(path.join(fx.work, rel));
    else write(fx.work, rel, content);
  }
  git(fx.work, ['add', '-A']);
  git(fx.work, ['commit', '--quiet', '--allow-empty', '-m', message], opts);
  return git(fx.work, ['rev-parse', 'HEAD']);
}
const line = (ref, sha, remoteSha = ZERO, remoteRef = ref) => `${ref} ${sha} ${remoteRef} ${remoteSha}\n`;
const branchLine = (fx, branch) => line(`refs/heads/${branch}`, git(fx.work, ['rev-parse', `refs/heads/${branch}`]));

/** Corre el freno del laboratorio como lo corre git: `pre-push <remoto> <dirección>`, con las líneas por la entrada. */
function guard(fx, input, { remote = 'origin', url = fx.publicUrl, env = {}, list = fx.list, cwd = fx.work, args = ['--json'] } = {}) {
  const r = spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js'), 'pre-push', remote, url, ...args], {
    cwd, input, encoding: 'utf8',
    // GIT_ALLOW_PROTOCOL=file: el freno le pregunta al remoto qué tiene; con una dirección de otro servidor (las de
    // ejemplo de estas pruebas) git se niega enseguida, sin salir a la red
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      GIT_ALLOW_PROTOCOL: 'file', TYCON_PUBLIC_PUSH_TREAT_AS_PUBLIC: fx.publicDir, ...(list ? { TYCON_PUBLISH_DENYLIST: list } : {}), ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { json = null; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}\n${r.stderr}`, json };
}

const everythingWritten = (fx) => {
  const out = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else out.push(fs.readFileSync(p, 'utf8')); } };
  walk(fx.home);
  return out.join('\n');
};

/** Un rojo: sale 1, con la categoría y el lugar, y sin el texto en la salida ni en lo que el freno deja escrito. */
function assertBlocked(fx, r, { category, place, secret = TERM } = {}) {
  assert.strictEqual(r.status, 1, `tenía que frenar (1), salió ${r.status}\n${r.all}`);
  assert.strictEqual(r.json && r.json.verdict, 'findings', r.all);
  if (category) assert.ok(r.json.findings.some((f) => f.category === category), `falta un hallazgo «${category}»: ${JSON.stringify(r.json.findings)}`);
  if (place) assert.ok(r.json.findings.some((f) => place.test(f.place)), `ningún lugar coincide con ${place}: ${JSON.stringify(r.json.findings)}`);
  for (const s of [secret].flat().filter(Boolean)) {
    assert.ok(!r.all.toLowerCase().includes(s.toLowerCase()), `la salida trae el texto encontrado\n${r.all}`);
    assert.ok(!everythingWritten(fx).toLowerCase().includes(s.toLowerCase()), 'lo que el freno dejó escrito trae el texto encontrado');
  }
  assert.ok(!/--no-verify/.test(r.all), 'el mensaje del freno nunca sugiere --no-verify');
}
function assertPassed(r) {
  assert.strictEqual(r.status, 0, `tenía que pasar, salió ${r.status}\n${r.all}`);
  assert.strictEqual(r.json && r.json.verdict, 'pass', r.all);
  assert.deepStrictEqual(r.json.findings, []);
}

// ── AC 22: qué se mira en cada commit nuevo ─────────────────────────────────────────────────────────────────────

test('T22_PublicPush_CleanBranch_Passes_AndSaysWhatItLooked', (t) => {
  const fx = lab(t);
  commitOn(fx, 'limpia', { 'guides/nueva.md': 'una guía nueva, sin nada raro\n' }, 'docs: una guía nueva');
  const r = guard(fx, branchLine(fx, 'limpia'));
  assertPassed(r);
  assert.strictEqual(r.json.remote, 'public');
  assert.strictEqual(r.json.looked.commits, 1, 'mira el commit nuevo, no la historia que el remoto ya tiene');
  assert.ok(r.json.looked.objects >= 1);
  // sin --json dice una línea por la salida de errores (git la muestra) y nada por la estándar
  const plain = guard(fx, branchLine(fx, 'limpia'), { args: [] });
  assert.strictEqual(plain.status, 0);
  assert.match(plain.stderr, /freno de publicación/);
});

test('T22_TermInContentPathMessageBranchAndTag_EachBlocked_PlaceNeverText', (t) => {
  const fx = lab(t);
  commitOn(fx, 'contenido', { 'guides/a.md': `linea uno\nacá aparece ${TERM} en la línea dos\n` });
  assertBlocked(fx, guard(fx, branchLine(fx, 'contenido')), { category: 'cliente', place: /guides\/a\.md:2/ });

  commitOn(fx, 'ruta', { [`docs/${TERM.toLowerCase()}-notas.md`]: 'nada\n' });
  const byPath = guard(fx, branchLine(fx, 'ruta'));
  assertBlocked(fx, byPath, { category: 'cliente', place: /una ruta que no se imprime/, secret: [TERM, `${TERM.toLowerCase()}-notas`] });

  const sha = commitOn(fx, 'mensaje', { 'guides/b.md': 'limpio\n' }, `docs: una guía\n\npara el caso de ${TERM}`);
  assertBlocked(fx, guard(fx, branchLine(fx, 'mensaje')), { category: 'cliente', place: new RegExp(`el mensaje del commit ${sha.slice(0, 10)}.*línea 3`) });

  commitOn(fx, `feature/${TERM.toLowerCase()}-x`, { 'guides/c.md': 'limpio\n' });
  assertBlocked(fx, guard(fx, branchLine(fx, `feature/${TERM.toLowerCase()}-x`)), { category: 'cliente', place: /el nombre de la ref nº 1 del empuje/ });

  const clean = commitOn(fx, 'para-marcas', { 'guides/d.md': 'limpio\n' });
  git(fx.work, ['tag', `${TERM.toLowerCase()}-v1`, clean]);
  assertBlocked(fx, guard(fx, line(`refs/tags/${TERM.toLowerCase()}-v1`, clean)), { category: 'cliente', place: /el nombre de la ref nº 1 del empuje/ });

  git(fx.work, ['tag', '-a', 'v2', '-m', `la versión de ${TERM}`, clean]);
  const tagSha = git(fx.work, ['rev-parse', 'refs/tags/v2']);
  assertBlocked(fx, guard(fx, line('refs/tags/v2', tagSha)), { category: 'cliente', place: /la marca anotada .*mensaje/ });

  git(fx.work, ['tag', '-a', 'v3', '-m', 'una versión limpia', clean], { committer: { name: 'Otra Persona', email: BAD_EMAIL } });
  const tag3 = git(fx.work, ['rev-parse', 'refs/tags/v3']);
  assertBlocked(fx, guard(fx, line('refs/tags/v3', tag3)), { category: 'identidad', place: /la marca anotada .*quien la firmó/, secret: [] });

  // el gemelo verde de las marcas: una anotada limpia, firmada con el correo que corresponde
  git(fx.work, ['tag', '-a', 'v4', '-m', 'una versión limpia', clean]);
  assertPassed(guard(fx, line('refs/tags/v4', git(fx.work, ['rev-parse', 'refs/tags/v4']))));
});

test('T22_EveryNewCommit_NotTheNetDiff_AndNotWhatTheRemoteAlreadyHas', (t) => {
  const fx = lab(t);
  // un commit mete el término y el siguiente lo saca: la punta está limpia y la historia no
  const dirty = commitOn(fx, 'neto', { 'guides/a.md': `con ${TERM}\n` }, 'docs: primera versión');
  commitHere(fx, { 'guides/a.md': 'ya sin nada\n' }, 'docs: corregido');
  const r = guard(fx, branchLine(fx, 'neto'));
  assertBlocked(fx, r, { category: 'cliente', place: new RegExp(`guides/a\\.md:1 \\(commit ${dirty.slice(0, 10)}`) });
  assert.strictEqual(r.json.looked.commits, 2);

  // lo que el remoto YA tiene no se vuelve a mirar: una rama nueva sobre un commit publicado pasa aunque ese commit
  // traiga un hallazgo (lo publicado lo mira la verificación de noche, no el empuje)
  git(fx.work, ['push', '--quiet', 'origin', 'neto']);
  git(fx.work, ['fetch', '--quiet', 'origin']);
  git(fx.work, ['branch', 'otra-rama', 'neto']);
  const again = guard(fx, branchLine(fx, 'otra-rama'));
  assertPassed(again);
  assert.strictEqual(again.json.looked.commits, 0);
  // y con la punta remota que informa git (una actualización): sólo lo de arriba de esa punta
  const remoteTip = git(fx.work, ['rev-parse', 'refs/heads/neto']);
  git(fx.work, ['checkout', '--quiet', 'neto']);
  const next = commitHere(fx, { 'guides/e.md': 'limpio\n' }, 'docs: otra');
  const update = guard(fx, line('refs/heads/neto', next, remoteTip), { remote: fx.publicUrl });
  assertPassed(update);
  assert.strictEqual(update.json.looked.commits, 1);
});

test('T22_FullDetector_TokenMachinePathBinaryLinkAndSubmodule_Blocked', (t) => {
  const fx = lab(t);
  commitOn(fx, 'token', { 'scripts/x.js': `const t = '${TOKEN}';\n` });
  assertBlocked(fx, guard(fx, branchLine(fx, 'token')), { category: 'secreto', place: /scripts\/x\.js:1/, secret: [TOKEN, TOKEN.slice(0, 12)] });

  commitOn(fx, 'maquina', { 'guides/f.md': `corré ${MACHINE_PATH}guion.sh\n` });
  assertBlocked(fx, guard(fx, branchLine(fx, 'maquina')), { category: 'ruta-de-maquina', place: /guides\/f\.md:1/, secret: [MACHINE_PATH] });

  commitOn(fx, 'binario', { 'artifacts/imagen.bin': Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00, 0xff]) });
  assertBlocked(fx, guard(fx, branchLine(fx, 'binario')), { category: 'sin-leer', place: /artifacts\/imagen\.bin/, secret: [] });

  git(fx.work, ['checkout', '--quiet', '-B', 'enlace', 'main']);
  fs.symlinkSync('README.md', path.join(fx.work, 'atajo.md'));
  git(fx.work, ['add', '-A']);
  git(fx.work, ['commit', '--quiet', '-m', 'un enlace']);
  assertBlocked(fx, guard(fx, branchLine(fx, 'enlace')), { category: 'sin-leer', place: /atajo\.md.*enlace simbólico/, secret: [] });

  git(fx.work, ['checkout', '--quiet', '-B', 'submodulo', 'main']);
  git(fx.work, ['update-index', '--add', '--cacheinfo', `160000,${git(fx.work, ['rev-parse', 'main'])},vendor/otro`]);
  git(fx.work, ['commit', '--quiet', '-m', 'un submódulo']);
  assertBlocked(fx, guard(fx, branchLine(fx, 'submodulo')), { category: 'sin-leer', place: /vendor\/otro.*submódulo/, secret: [] });
  // 🔴 …también si el propio árbol le dice a git que lo ignore (`ignore = all` en `.gitmodules`): lo que se mira no puede
  // depender de un archivo que viene en lo mismo que se empuja. En el empuje y en el modo de rango (pase adversarial F2).
  write(fx.work, '.gitmodules', '[submodule "vendor/otro"]\n\tpath = vendor/otro\n\turl = ./otro\n\tignore = all\n');
  git(fx.work, ['add', '.gitmodules']);
  git(fx.work, ['commit', '--quiet', '-m', 'que git ignore ese submódulo']);
  assertBlocked(fx, guard(fx, branchLine(fx, 'submodulo')), { category: 'sin-leer', place: /vendor\/otro.*submódulo/, secret: [] });
  assertBlocked(fx, rangeGuard(fx, { branch: 'submodulo' }), { category: 'sin-leer', place: /vendor\/otro.*submódulo/, secret: [] });
});

test('T22_Identity_AuthorAndCommitterMustBeGithubNoreply_AssistantTrailerPasses', (t) => {
  const fx = lab(t);
  const bad = { name: 'Mantenedor De Prueba', email: BAD_EMAIL };
  const a = commitOn(fx, 'autor', { 'guides/a.md': 'limpio\n' }, 'docs: a', { who: bad, committer: GOOD });
  assertBlocked(fx, guard(fx, branchLine(fx, 'autor')), { category: 'identidad', place: new RegExp(`el autor del commit ${a.slice(0, 10)}`), secret: [BAD_EMAIL] });
  const c = commitOn(fx, 'committer', { 'guides/b.md': 'limpio\n' }, 'docs: b', { who: GOOD, committer: bad });
  assertBlocked(fx, guard(fx, branchLine(fx, 'committer')), { category: 'identidad', place: new RegExp(`el committer del commit ${c.slice(0, 10)}`), secret: [BAD_EMAIL] });
  // el nombre de quien firma también se mira contra la lista
  commitOn(fx, 'nombre', { 'guides/c.md': 'limpio\n' }, 'docs: c', { who: { name: `${TERM} Pérez`, email: GOOD.email }, committer: GOOD });
  assertBlocked(fx, guard(fx, branchLine(fx, 'nombre')), { category: 'cliente', place: /el autor del commit/ });
  // verdes: el renglón del asistente, el committer de un merge hecho por GitHub, y la forma sin número del noreply
  commitOn(fx, 'asistente', { 'guides/d.md': 'limpio\n' }, 'docs: d\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  assertPassed(guard(fx, branchLine(fx, 'asistente')));
  commitOn(fx, 'web', { 'guides/e.md': 'limpio\n' }, 'docs: e', { who: { name: 'Mantenedor De Prueba', email: 'mantenedor@users.noreply.github.com' }, committer: { name: 'GitHub', email: 'noreply@github.com' } });
  assertPassed(guard(fx, branchLine(fx, 'web')));
  // un correo de otra persona en un renglón del mensaje lo frena el detector, como en cualquier texto
  commitOn(fx, 'firmado', { 'guides/g.md': 'limpio\n' }, `docs: g\n\nSigned-off-by: Otra Persona <${REAL_LOOKING_EMAIL}>`);
  assertBlocked(fx, guard(fx, branchLine(fx, 'firmado')), { category: 'email', place: /el mensaje del commit/, secret: ['otra.persona'] });
});

test('T22_OtherCommitHeaders_AreReviewedToo', (t) => {
  // un commit lleva más que autor, committer y mensaje: la marca que un merge incrusta (`mergetag`) y cualquier otra
  // cabecera son texto que se publica. Se arma el objeto a mano, con una cabecera de más.
  const fx = lab(t);
  const base = commitOn(fx, 'cabecera', { 'guides/a.md': 'limpio\n' });
  const raw = git(fx.work, ['cat-file', 'commit', base]);
  const withHeader = (extra) => {
    const cut = raw.indexOf('\n\n');
    const sha = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], { cwd: fx.work, input: `${raw.slice(0, cut)}\n${extra}${raw.slice(cut)}\n`, encoding: 'utf8' });
    assert.strictEqual(sha.status, 0, sha.stderr);
    return sha.stdout.trim();
  };
  const dirty = withHeader(`mergetag object ${base}\n type commit\n tag v9\n \n la marca de ${TERM}`);
  assertBlocked(fx, guard(fx, line('refs/heads/cabecera', dirty)), { category: 'cliente', place: new RegExp(`la cabecera del commit ${dirty.slice(0, 10)}`) });
  // el gemelo: la misma cabecera, limpia; y una firma (un bloque que no es texto) no se revisa como texto
  const clean = withHeader(`mergetag object ${base}\n type commit\n tag v9\n \n una marca limpia\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE${'x'.repeat(20)}\n -----END PGP SIGNATURE-----`);
  assertPassed(guard(fx, line('refs/heads/cabecera', clean)));
});

test('T22_PrNumberInMessageBranchAndTag_Blocked_StoryNumbersPass', (t) => {
  const fx = lab(t);
  const sha = commitOn(fx, 'pedido', { 'guides/a.md': 'limpio\n' }, 'fix: lo que quedó del PR 1234');
  assertBlocked(fx, guard(fx, branchLine(fx, 'pedido')), { category: 'historia-interna', place: new RegExp(`el mensaje del commit ${sha.slice(0, 10)}`), secret: ['1234'] });
  commitOn(fx, 'arreglo/PR#1234', { 'guides/b.md': 'limpio\n' }, 'fix: un arreglo');
  assertBlocked(fx, guard(fx, branchLine(fx, 'arreglo/PR#1234')), { category: 'historia-interna', place: /el nombre de la ref nº 1/, secret: ['1234'] });
  const clean = commitOn(fx, 'para-marca', { 'guides/c.md': 'limpio\n' }, 'fix: otro');
  git(fx.work, ['tag', 'PR#1234', clean]);
  assertBlocked(fx, guard(fx, line('refs/tags/PR#1234', clean)), { category: 'historia-interna', place: /el nombre de la ref nº 1/, secret: ['1234'] });
  // En un nombre de ref no hay espacios, y la forma del control pide uno: se mira también con los separadores vueltos
  // espacios, en mayúsculas y en minúsculas. Cada una de estas formas salía sin freno.
  ['arreglo/pr-1234', 'pr1234-arreglo', 'pull-request-1234', 'Pull_Request.1234', 'PULL-REQUEST-1234', 'hotfix/PRs_1234'].forEach((name) => {
    git(fx.work, ['branch', '-f', name, clean]);
    assertBlocked(fx, guard(fx, branchLine(fx, name)), { category: 'historia-interna', place: /el nombre de la ref nº 1/, secret: ['1234'] });
  });
  // los números de story del arnés pasan, en el mensaje y en la rama; y un nombre que sólo se parece
  commitOn(fx, 'story/8.26-f', { 'guides/d.md': 'limpio\n' }, 'feat(8.26): la tanda F de la story 8.26');
  assertPassed(guard(fx, branchLine(fx, 'story/8.26-f')));
  for (const name of ['expr-2024', 'sprint/1234', 'v1.2.3456', 'upr-1234']) {
    git(fx.work, ['branch', '-f', name, clean]);
    assertPassed(guard(fx, branchLine(fx, name)));
  }
  // y lo demás del asunto de un merge se mira igual: el nombre de la rama que nombra
  commitOn(fx, 'merge-con-termino', { 'guides/h.md': 'limpio\n' }, `Merge pull request #1234 from acme/${TERM.toLowerCase()}-x`);
  assertBlocked(fx, guard(fx, branchLine(fx, 'merge-con-termino')), { category: 'cliente', place: /el mensaje del commit/ });
});

// El asunto con que GitHub mergea («Merge pull request #N from …») trae el número de un pedido del repo PÚBLICO: no es
// historia interna, y desde el pedido 100 coincide con la forma del número de pedido. Ya no hay una salvedad por la forma
// del asunto: el control le pregunta al repo al que se empuja qué pedidos tiene (`git ls-remote`, sin la API de GitHub).
// Acá el desnudo local hace de GitHub y publica el pedido como lo publica GitHub, `refs/pull/<N>/head`.
test('T22_PublicPullRequestNumber_Passes_AzureNumberAndUnansweredPublicRepo_Blocked', (t) => {
  const fx = lab(t);
  // armados por partes: este archivo viaja, y la prueba de los números de pedido lo recorre como a cualquier otro
  const pr = (words, num) => [words, num].join(' ');
  const publishPr = (n) => git(fx.root, ['--git-dir', fx.publicUrl, 'update-ref', `refs/pull/${n}/head`, git(fx.root, ['--git-dir', fx.publicUrl, 'rev-parse', 'main'])]);
  commitOn(fx, 'merge-de-la-web', { 'guides/e.md': 'limpio\n' }, `Merge ${pr('pull request', '#100')} from acme/una-rama\n\nun arreglo`);
  // sin ese pedido en el público, el número cuenta: es lo que lo distingue de uno del equipo
  assertBlocked(fx, guard(fx, branchLine(fx, 'merge-de-la-web')), { category: 'historia-interna', secret: ['100'] });
  publishPr(100);
  assertPassed(guard(fx, branchLine(fx, 'merge-de-la-web')));
  // en cualquier línea: un pedido del público, nombrado con numeral, no es historia interna
  commitOn(fx, 'nota', { 'guides/g.md': 'limpio\n' }, `docs: una nota\n\nsigue lo del ${pr('pull request', '#100')}`);
  assertPassed(guard(fx, branchLine(fx, 'nota')));
  // el mismo número escrito como lo escribe Azure (sin numeral: el asunto de un merge de Azure, o «PR N»), y uno con
  // numeral que el público no tiene, cuentan
  const azure = commitOn(fx, 'merge-de-azure', { 'guides/f.md': 'limpio\n' }, `Merge ${pr('pull request', '100')} from dev into main`);
  assertBlocked(fx, guard(fx, branchLine(fx, 'merge-de-azure')), { category: 'historia-interna', place: new RegExp(`el mensaje del commit ${azure.slice(0, 10)} \\(línea 1\\)`), secret: [] });
  const other = commitOn(fx, 'merge-con-cuerpo', { 'guides/i.md': 'limpio\n' }, `Merge ${pr('pull request', '#100')} from acme/una-rama\n\nsigue lo del ${pr('PR', '#4504')}`);
  assertBlocked(fx, guard(fx, branchLine(fx, 'merge-con-cuerpo')), { category: 'historia-interna', place: new RegExp(`el mensaje del commit ${other.slice(0, 10)} \\(línea 3\\)`), secret: ['4504'] });
  // si el repo público no contesta, nada es suyo: frena, y dice por qué (una dirección de GitHub que git se niega a
  // usar en esta prueba es un GitHub que no contesta)
  const silent = guard(fx, branchLine(fx, 'merge-de-la-web'), { url: 'https://github.com/acme/arnes-de-prueba' });
  assertBlocked(fx, silent, { category: 'historia-interna', secret: [] });
  assert.match(String(silent.json.publicProblem), /no pude preguntarle al repo público qué pedidos tiene/);
  const said = guard(fx, branchLine(fx, 'merge-de-la-web'), { url: 'https://github.com/acme/arnes-de-prueba', args: [] });
  assert.strictEqual(said.status, 1, said.all);
  assert.match(said.all, /no pude preguntarle al repo público qué pedidos tiene/, 'la salida dice por qué no lo distinguió');
});

test('T22_ForbiddenPaths_EveryPrivateFolderAndTheListOnes_Blocked_NewGuidePasses', (t) => {
  const fx = lab(t);
  writeList(fx.list, TERM, { forbiddenPaths: ['interno/**', 'perfil-de-prueba.json'] });
  const cases = ['.engram/x.jsonl.gz', 'specs/story-1.md', 'tasks/todo.md', 'inbox/a.md', '.advisors/r.md', '.dashboard/m.json', 'interno/notas/a.md', 'perfil-de-prueba.json'];
  cases.forEach((rel, i) => {
    commitOn(fx, `vedada-${i}`, { [rel]: 'contenido limpio\n' });
    assertBlocked(fx, guard(fx, branchLine(fx, `vedada-${i}`)), { category: 'ruta-vedada', place: new RegExp(rel.replace(/[.]/g, '\\.')), secret: [] });
  });
  // agregada y sacada en la misma rama: sigue en la historia
  commitOn(fx, 'vedada-neta', { 'specs/story-2.md': 'x\n' });
  commitHere(fx, { 'specs/story-2.md': null }, 'la saco');
  assertBlocked(fx, guard(fx, branchLine(fx, 'vedada-neta')), { category: 'ruta-vedada', place: /specs\/story-2\.md/, secret: [] });
  // un archivo nuevo bajo una carpeta pública pasa; y una carpeta que sólo se PARECE a una vedada, también
  commitOn(fx, 'publica', { 'guides/nueva.md': 'limpio\n', 'specsheet/a.md': 'limpio\n', 'scripts/tasks/a.js': '// limpio\n' });
  assertPassed(guard(fx, branchLine(fx, 'publica')));
});

test('T22_OnlyBranchesAndTags_OtherRefsBlocked_DeletingARemoteBranchPasses', (t) => {
  const fx = lab(t);
  const sha = commitOn(fx, 'limpia', { 'guides/a.md': 'limpio\n' });
  const notes = guard(fx, line('refs/notes/commits', sha));
  assertBlocked(fx, notes, { category: 'ref-no-publicable', place: /la ref nº 1 del empuje/, secret: [] });
  assertBlocked(fx, guard(fx, line('refs/stash', sha)), { category: 'ref-no-publicable', secret: [] });
  // una rama local empujada a una ref remota que no es rama ni marca: manda la remota
  assertBlocked(fx, guard(fx, line('refs/heads/limpia', sha, ZERO, 'refs/replace/abc')), { category: 'ref-no-publicable', secret: [] });
  // borrar una rama remota no publica nada, se llame como se llame
  const del = guard(fx, `(delete) ${ZERO} refs/heads/${TERM.toLowerCase()}-vieja ${sha}\n`);
  assertPassed(del);
  // y un empuje sin nada (git no manda líneas cuando está al día)
  assertPassed(guard(fx, ''));
});

test('T22_CouldNotLook_UnreadableObjectAndTimeLimit_NeverGreen', (t) => {
  const fx = lab(t);
  commitOn(fx, 'roto', { 'guides/a.md': 'un contenido que se va a perder\n' });
  const blob = git(fx.work, ['rev-parse', 'HEAD:guides/a.md']);
  fs.rmSync(path.join(fx.work, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const broken = guard(fx, branchLine(fx, 'roto'));
  assert.strictEqual(broken.status, 2, broken.all);
  assert.strictEqual(broken.json.verdict, 'blind');
  assert.match(broken.json.reason, /no pude leer/);

  commitOn(fx, 'lenta', { 'guides/b.md': 'limpio\n' });
  const slow = guard(fx, branchLine(fx, 'lenta'), { env: { TYCON_PUBLIC_PUSH_LIMIT_MS: '0' } });
  assert.strictEqual(slow.status, 2, slow.all);
  assert.match(slow.json.reason, /tope de tiempo/);
  // con el tope vencido y algo YA encontrado (el nombre de la rama se mira antes que nada): se dice eso, y que faltó mirar
  commitOn(fx, `lenta-${TERM.toLowerCase()}`, { 'guides/c.md': 'limpio\n' });
  const partial = guard(fx, branchLine(fx, `lenta-${TERM.toLowerCase()}`), { env: { TYCON_PUBLIC_PUSH_LIMIT_MS: '0' } });
  assertBlocked(fx, partial, { category: 'cliente', place: /el nombre de la ref nº 1/ });
  assert.match(partial.json.partial, /tope de tiempo/);
  assert.match(guard(fx, branchLine(fx, `lenta-${TERM.toLowerCase()}`), { env: { TYCON_PUBLIC_PUSH_LIMIT_MS: '0' }, args: [] }).stderr, /no terminé de mirar/);
  // las líneas que git manda, mal formadas: tampoco es verde
  const garbage = guard(fx, 'esto no es una línea de git\n');
  assert.strictEqual(garbage.status, 2, garbage.all);
});

test('T22_PrivateAndLocalRemotes_AndTreesThatAreNotTheHarness_SkipWithoutReadingTheList', (t) => {
  const fx = lab(t);
  commitOn(fx, 'sucia', { 'guides/a.md': `con ${TERM}\n` });
  const broken = path.join(fx.root, 'rota.json');
  fs.writeFileSync(broken, '{ esto no es json');
  const input = branchLine(fx, 'sucia');
  for (const url of ['https://dev.azure.com/org-de-prueba/proyecto/_git/repo', 'https://org-de-prueba.visualstudio.com/proyecto/_git/repo',
    'git@ssh.dev.azure.com:v3/org-de-prueba/proyecto/repo', fx.localUrl]) {
    const r = guard(fx, input, { remote: url, url, list: broken });
    assert.strictEqual(r.status, 0, `${url}: ${r.all}`);
    assert.strictEqual(r.json.verdict, 'skip');
    assert.strictEqual(r.json.list, null, 'ni siquiera busca la lista');
    assert.strictEqual(guard(fx, input, { remote: url, url, list: broken, args: [] }).all.trim(), '', 'callado: ni una línea');
  }
  // todo lo demás es público: GitHub, un alias de ssh, un servidor cualquiera, una dirección que no se sabe leer
  for (const url of ['https://github.com/acme/widgets.git', 'git@github.com:acme/widgets.git', 'git@mi-alias:acme/widgets.git',
    'https://git.ejemplo.test/acme/widgets', 'esto no es una direccion']) {
    const r = guard(fx, input, { remote: url, url });
    assertBlocked(fx, r, { category: 'cliente' });
    assert.strictEqual(r.json.remote, 'public');
  }
  // un clon local de un repo cuyo origin es público, es público (se sigue la cadena)
  const mirror = path.join(fx.root, 'espejo');
  git(fx.root, ['clone', '--quiet', fx.publicUrl, mirror]);
  assertBlocked(fx, guard(fx, input, { remote: mirror, url: mirror }), { category: 'cliente' });

  // un árbol que no es del arnés no es asunto de este freno
  const other = lab(t, { harnessTree: false });
  commitOn(other, 'sucia', { 'a.md': `con ${TERM}\n` });
  const skipped = guard(other, branchLine(other, 'sucia'), { list: broken });
  assert.strictEqual(skipped.status, 0, skipped.all);
  assert.strictEqual(skipped.json.verdict, 'skip');
});

// ── AC 53: de dónde sale la lista, y en qué máquina es obligatoria ────────────────────────────────────────────────

test('T56_ListLookupOrder_EnvMaintainersMaintainedHarness_FirstOneWins_NeverThePushedTree', (t) => {
  const fx = lab(t);
  commitOn(fx, 'dos', { 'guides/a.md': `uno: ${TERM}\ndos: ${OTHER_TERM}\n` });
  const input = branchLine(fx, 'dos');
  const maintainers = path.join(fx.root, 'mantenimiento');
  const maintained = path.join(fx.root, 'mantenido');
  const inTheTree = path.join(fx.work, 'scripts/publishing/denylist.json');
  const places = [
    ['env', fx.list],
    ['maintainers', path.join(maintainers, 'scripts/publishing/denylist.json')],
    ['maintained', path.join(maintained, 'scripts/publishing/denylist.json')],
    ['harness', path.join(fx.harness, 'scripts/publishing/denylist.json')],
  ];
  const config = path.join(fx.home, '.tycon', 'config.json');
  const declare = (paths) => fs.writeFileSync(config, JSON.stringify({ paths }));
  declare({ maintainers, maintained });
  // todas puestas: cada una con SU término (la primera con TERM, las demás con el otro)
  for (const [, file] of places) writeList(file, OTHER_TERM);
  for (let i = 0; i < places.length; i += 1) {
    writeList(places[i][1], TERM);
    const r = guard(fx, input, { list: i === 0 ? fx.list : null });
    assert.strictEqual(r.status, 1, r.all);
    assert.strictEqual(r.json.list.source, places[i][0], `gana ${places[i][0]}`);
    assert.deepStrictEqual(r.json.findings.map((f) => f.place.replace(/ \(commit.*/, '')), ['guides/a.md:1'], 'usa ESA lista: sólo su término');
    fs.rmSync(places[i][1]);   // la saco: en la vuelta siguiente gana la que sigue
    // Los dos primeros lugares son una DECLARACIÓN («la lista está acá»): declarados y sin lista es «no pude mirar»,
    // aunque más abajo haya otra.
    if (places[i][0] === 'env') {
      const gone = guard(fx, input, { list: fx.list });
      assert.strictEqual(gone.status, 2, gone.all);
      assert.match(gone.json.reason, /TYCON_PUBLISH_DENYLIST está declarado y ahí no hay lista/);
    }
    if (places[i][0] === 'maintainers') {
      const gone = guard(fx, input, { list: null });
      assert.strictEqual(gone.status, 2, gone.all);
      assert.match(gone.json.reason, /el clon de mantenimiento.*está declarado y ahí no hay lista/);
      declare({ maintained });   // la máquina deja de declararlo: ahora sí sigue con las demás
    }
  }
  // ya no queda ninguna, en una máquina del equipo: no pude mirar
  const none = guard(fx, input, { list: null });
  assert.strictEqual(none.status, 2, none.all);
  assert.match(none.json.reason, /sin la lista/);
  // 🔴 La lista que trae el ÁRBOL QUE SE EMPUJA no es un lugar: la rama elegiría con qué lista se la mira (una lista
  // adelgazada en la rama dejaría pasar lo que sacó). Con una ahí —en el árbol y en el commit—, sigue sin lista.
  writeList(inTheTree, OTHER_TERM);
  git(fx.work, ['add', '-A']);
  git(fx.work, ['commit', '--quiet', '-m', 'una lista en la rama']);
  const fromTree = guard(fx, branchLine(fx, 'dos'), { list: null });
  assert.strictEqual(fromTree.status, 2, `usó la lista del árbol que se empuja\n${fromTree.all}`);
  assert.match(fromTree.json.reason, /sin la lista/);
  // y cuando hay otra, manda la otra: la del árbol no suma ni resta (con ella sola pasaría el primer término)
  writeList(places[3][1], TERM);
  const withBoth = guard(fx, branchLine(fx, 'dos'), { list: null });
  assert.strictEqual(withBoth.json.list.source, 'harness');
  assert.ok(withBoth.json.findings.some((f) => /guides\/a\.md:1/.test(f.place)), withBoth.all);
  // una configuración de la máquina que no se deja leer tampoco es «no declaró nada»
  fs.writeFileSync(config, '{ roto');
  const broken = guard(fx, input, { list: null });
  assert.strictEqual(broken.status, 2, broken.all);
  assert.match(broken.json.reason, /configuración de esta máquina/);
  // ni una casa del arnés que no es una ruta
  fs.rmSync(config);
  const relative = guard(fx, input, { list: null, env: { TYCON_HOME: 'una/ruta/relativa' } });
  assert.strictEqual(relative.status, 2, relative.all);
});

test('T22_Merges_WhatComesFromAParentIsNotNew_WhatTheMergeItselfAddsIs', (t) => {
  const fx = lab(t);
  // main del remoto avanza con un commit que trae el término (ya publicado: lo mira la verificación de noche)
  git(fx.work, ['checkout', '--quiet', 'main']);
  commitHere(fx, { 'guides/vieja.md': `publicado hace rato, con ${TERM}\n` }, 'docs: lo que ya estaba');
  git(fx.work, ['push', '--quiet', 'origin', 'main']);
  git(fx.work, ['fetch', '--quiet', 'origin']);
  // una rama que salió ANTES de ese commit lo trae con un merge: no es contenido nuevo
  commitOn(fx, 'con-merge', { 'guides/mia.md': 'limpio\n' }, 'docs: lo mío', { from: 'main~1' });
  git(fx.work, ['merge', '--quiet', '--no-ff', '--no-edit', 'main']);
  const merged = guard(fx, branchLine(fx, 'con-merge'));
  assertPassed(merged);
  assert.strictEqual(merged.json.looked.commits, 2, 'el commit propio y el merge; el de main ya está en el remoto');
  // un merge que agrega algo por su cuenta (no viene de ninguno de sus padres): eso sí es nuevo
  commitOn(fx, 'merge-con-agregado', { 'guides/otra.md': 'limpio\n' }, 'docs: otra', { from: 'main~1' });
  git(fx.work, ['merge', '--quiet', '--no-ff', '--no-commit', 'main']);
  write(fx.work, 'guides/colada.md', `metido en el merge: ${TERM}\n`);
  git(fx.work, ['add', '-A']);
  git(fx.work, ['commit', '--quiet', '-m', 'merge: main en la rama']);
  assertBlocked(fx, guard(fx, branchLine(fx, 'merge-con-agregado')), { category: 'cliente', place: /guides\/colada\.md:1/ });
});

test('T56_MaintainersClone_DeclaredWithTheHarnessCommand_IsWhereTheGuardReadsTheList', (t) => {
  const fx = lab(t);
  const maintainers = path.join(fx.root, 'mantenimiento');
  git(fx.root, ['init', '--quiet', '--initial-branch=main', maintainers]);
  writeList(path.join(maintainers, 'scripts/publishing/denylist.json'), TERM);
  const env = { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon') };
  const config = (...args) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'setup', 'harness.js'), 'config', ...args], { encoding: 'utf8', env });
  // la clave la guarda el comando del arnés, como `paths.maintained`: una ruta absoluta, que exista y que sea un clon
  for (const bad of ['relativa/mantenimiento', path.join(fx.root, 'no-existe'), fx.home]) {
    const r = config('set', 'paths.maintainers', bad);
    assert.strictEqual(r.status, 2, `tenía que rechazar «${bad}»: ${r.stdout}${r.stderr}`);
  }
  const ok = config('set', 'paths.maintainers', maintainers);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(config('show').stdout, /paths\.maintainers/);
  // 🔴 …y el LECTOR de la configuración la conoce. La primera versión la guardaba y el lector de esa misma versión la
  // rechazaba («clave desconocida»): declarar la lista como pide el freno dejaba inválida la configuración de la máquina.
  // El lector mira ese archivo sólo en una máquina que vive en su carpeta propia (`~/.tycon/state` existe): sin eso
  // esta afirmación pasaba aunque el lector no conociera la clave, porque ni abría el archivo.
  fs.mkdirSync(path.join(fx.home, '.tycon', 'state'), { recursive: true });
  const valid = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'lib', 'tycon-config.js'), 'validate'], { encoding: 'utf8', env });
  assert.strictEqual(valid.status, 0, `el lector rechaza lo que el comando guardó:\n${valid.stdout}${valid.stderr}`);
  assert.match(valid.stdout, /máquina: leido/, 'el lector leyó el archivo que el comando escribió');
  // y el freno la lee de ahí
  commitOn(fx, 'sucia', { 'guides/a.md': `con ${TERM}\n` });
  const r = guard(fx, branchLine(fx, 'sucia'), { list: null });
  assertBlocked(fx, r, { category: 'cliente' });
  assert.strictEqual(r.json.list.source, 'maintainers');
  assert.strictEqual(config('unset', 'paths.maintainers').status, 0);
  assert.strictEqual(guard(fx, branchLine(fx, 'sucia'), { list: null }).status, 2, 'sin la clave, en una máquina del equipo: sin la lista');
});

test('T56_EveryKeyTheConfigCommandWrites_IsAcceptedByTheConfigReader', (t) => {
  // La clase entera, no sólo la clave que falló: toda clave que `harness.js config set` sabe escribir (la lista es de
  // github-auth.js) se guarda en una máquina de laboratorio y después se valida con el lector REAL. Una clave que el
  // comando escribe y el lector no conoce rompe la configuración de quien la usa.
  const fx = lab(t);
  const GA = require(path.join(REPO, 'scripts', 'setup', 'harness', 'github-auth.js'));
  const clone = path.join(fx.root, 'un-clon');
  git(fx.root, ['init', '--quiet', '--initial-branch=main', clone]);
  const env = { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon') };
  const run = (script, args, input) => spawnSync(process.execPath, [path.join(REPO, ...script), ...args], { encoding: 'utf8', env, input });
  // una máquina que vive en su carpeta propia: ahí el archivo que el comando escribe ES el de la máquina para el lector
  fs.mkdirSync(path.join(fx.home, '.tycon', 'state'), { recursive: true });
  assert.ok(GA.KEYS.length >= 4, 'la lista de claves del comando');
  for (const key of GA.KEYS) {
    const secret = GA.SECRET_KEYS.includes(key);
    const set = secret ? run(['scripts', 'setup', 'harness.js'], ['config', 'set', key], 'un-permiso-de-laboratorio\n') : run(['scripts', 'setup', 'harness.js'], ['config', 'set', key, clone]);
    assert.strictEqual(set.status, 0, `config set ${key}: ${set.stdout}${set.stderr}`);
    const valid = run(['scripts', 'lib', 'tycon-config.js'], ['validate']);
    assert.strictEqual(valid.status, 0, `después de «config set ${key}», el lector rechaza la configuración:\n${valid.stdout}${valid.stderr}`);
    assert.match(valid.stdout, /máquina: leido/, `después de «config set ${key}», el lector leyó ese archivo`);
  }
});

test('T56_ConfigSet_AFileAReaderRejects_IsNotLeftWritten', (t) => {
  // El gemelo: el freno de producción tiene su PROPIA copia del lector, instalada con permisos de administrador, que no
  // se actualiza sola. Una clave que este arnés ya conoce y esa copia todavía no, le rompería la lectura de la
  // configuración. Antes de dar una clave por guardada se le pregunta a cada lector; si uno que aceptaba el archivo de
  // antes rechaza el nuevo, el archivo vuelve a como estaba y se dice quién lo rechazó.
  const fx = lab(t);
  const GA = require(path.join(REPO, 'scripts', 'setup', 'harness', 'github-auth.js'));
  const env = { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon') };
  const file = path.join(fx.home, '.tycon', 'config.json');
  // Lectores de mentira con el contrato del real: leen `<TYCON_HOME>/config.json`, rechazan (2) la clave de `paths` que
  // no conocen y si no salen 0. Cada uno deja anotado lo que vio, para comprobar que NUNCA se le muestra el archivo
  // real ni un secreto.
  const seen = path.join(fx.root, 'visto.txt');
  const reader = (name, body, known = ['repos', 'tree', 'maintained', 'maintainers']) => {
    const f = path.join(fx.root, `${name}.js`);
    fs.writeFileSync(f, [
      "const fs = require('fs'); const path = require('path');",
      "const f = path.join(process.env.TYCON_HOME, 'config.json');",
      "const raw = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;",
      `fs.appendFileSync(${JSON.stringify(seen)}, process.env.TYCON_HOME + '\\n' + (raw || '') + '\\n');`,
      'const j = raw ? JSON.parse(raw) : {};',
      `for (const k of Object.keys(j.paths || {})) if (!${JSON.stringify(known)}.includes(k)) { process.stderr.write('· config.json · paths.' + k + ' · clave desconocida, vale «un-valor-que-no-se-repite»\\n'); process.exit(2); }`,
      body,
      "process.stdout.write('configuración válida (máquina: ' + (raw ? 'leido' : 'ausente') + ')\\n');",
    ].join('\n'));
    return f;
  };
  const old = reader('lector-viejo', '', ['repos', 'tree', 'maintained']);   // el de la versión anterior: no conoce `maintainers`
  const guard = [{ label: 'el freno de producción instalado', file: old, guard: true }];
  // sin archivo antes: no queda ninguno, y se dice quién la rechazó y por qué, sin repetir lo que el lector imprimió
  let r = GA.setKeyChecked('paths.maintainers', fx.work, { env, readers: guard });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /el freno de producción instalado no conoce esa clave/);
  assert.ok(!/un-valor-que-no-se-repite/.test(JSON.stringify(r)), 'el texto del lector no se repite');
  assert.ok(!fs.existsSync(file), 'sin archivo antes, no queda ninguno');
  // lo que el comando le dice a la persona: el motivo, cómo seguir con el freno de producción y la salida para ESTA clave
  const lines = GA.rejectionLines('paths.maintainers', r);
  assert.strictEqual(lines.length, 3, lines.join('\n'));
  assert.match(lines[1], /Reinstalalo \(bash scripts\/production\/install-guard\.sh/);
  assert.match(lines[2], /TYCON_PUBLISH_DENYLIST/);
  assert.strictEqual(GA.rejectionLines('paths.maintained', r).length, 2, 'la salida de la lista es sólo para la clave de la lista');
  assert.strictEqual(GA.rejectionLines('paths.maintainers', { ...r, guard: false }).length, 1, 'si no fue el freno de producción, sólo el motivo');
  // con un archivo antes —y un secreto adentro—: queda byte a byte como estaba
  assert.strictEqual(GA.setKeyChecked('paths.maintained', fx.work, { env, readers: guard }).ok, true);
  assert.strictEqual(GA.setKeyChecked('github.token', 'un-permiso-de-laboratorio-secreto', { env, readers: guard }).ok, true);
  const before = fs.readFileSync(file, 'utf8');
  r = GA.setKeyChecked('paths.maintainers', fx.work, { env, readers: guard });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'el archivo real no se tocó');
  // 🔴 a los lectores se les muestra una COPIA, en otra carpeta y sin el valor de los secretos
  const shown = fs.readFileSync(seen, 'utf8');
  assert.ok(!shown.includes('un-permiso-de-laboratorio-secreto'), 'el secreto no sale del archivo real');
  assert.ok(!shown.includes(`${path.join(fx.home, '.tycon')}\n`), 'el lector nunca miró la carpeta real');
  assert.match(shown, /sin-valor-en-la-copia/);
  assert.deepStrictEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tycon-config-check-')), [], 'las copias no quedan');
  // un lector que rechaza por OTRA cosa (no una clave desconocida) se dice distinto
  const picky = reader('lector-quisquilloso', "if (j.paths && j.paths.maintainers !== undefined) { process.stderr.write('ruta inválida\\n'); process.exit(2); }");
  r = GA.setKeyChecked('paths.maintainers', fx.work, { env, readers: [{ label: 'otro lector', file: picky }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /otro lector rechaza el archivo con esa clave/);
  // un lector que YA rechazaba el archivo de antes no es motivo para no escribir: se escribe y se AVISA
  const broken = reader('lector-roto', "process.stderr.write('otra cosa rota\\n'); process.exit(2);");
  r = GA.setKeyChecked('paths.maintainers', fx.work, { env, readers: [{ label: 'un lector que ya rechazaba', file: broken }] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.match(r.warning || '', /un lector que ya rechazaba ya rechazaba la configuración/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).paths.maintainers, fx.work);
  assert.strictEqual(GA.setKeyChecked('paths.maintainers', null, { env, readers: guard }).ok, true, 'sacar una clave no se comprueba');
  // 🔴 «no pude preguntar» nunca queda como «preguntó y está bien» en silencio: se escribe y se AVISA.
  // (1) un lector que no termina a tiempo cuando se le muestra el archivo nuevo
  const loop = 'const until = Date.now() + 20000; while (Date.now() < until) { /* no termina */ }';
  const hangs = reader('lector-colgado', `if (j.paths && j.paths.maintainers !== undefined) { ${loop} }`);
  r = GA.setKeyChecked('paths.maintainers', fx.work, { env, readers: [{ label: 'un lector lento', file: hangs }], readerMs: 400 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.match(r.warning || '', /no pude comprobarlo con un lector lento \(no terminó a tiempo\)/);
  GA.setKeyChecked('paths.maintainers', null, { env });
  // (2) 🔴 un lector que NO LEE la copia que se le muestra y contesta «válida, máquina: leido» igual: una copia vieja
  // del freno de producción lee el archivo de la carpeta de Claude Code, pase lo que pase con TYCON_HOME. Se lo
  // descubre mostrándole primero un archivo que tiene que rechazar. Sin eso contestaba «válida» antes y después, y la
  // clave quedaba «guardada» sin que nadie la hubiera mirado.
  const blind = path.join(fx.root, 'lector-ciego.js');
  fs.writeFileSync(blind, "process.stdout.write('configuración válida (máquina: leido)\\n');\n");
  r = GA.setKeyChecked('paths.maintainers', fx.work, { env, readers: [{ label: 'un lector que no mira', file: blind }] });
  assert.strictEqual(r.ok, true);
  assert.match(r.warning || '', /no pude comprobarlo con un lector que no mira \(no lee la copia que se le muestra/);
  GA.setKeyChecked('paths.maintainers', null, { env });
  // (3) uno que se muere antes de contestar
  const dies = path.join(fx.root, 'lector-muerto.js');
  fs.writeFileSync(dies, "process.kill(process.pid, 'SIGKILL');\n");
  r = GA.setKeyChecked('paths.maintainers', fx.work, { env, readers: [{ label: 'un lector que se muere', file: dies }] });
  assert.strictEqual(r.ok, true);
  assert.match(r.warning || '', /no pude comprobarlo con un lector que se muere \(no se lo pudo correr\)/);
  GA.setKeyChecked('paths.maintainers', null, { env });
  // (4) uno al que no se le pudo preguntar por el archivo de HOY y acepta el nuevo: también se dice
  const slowToday = reader('lector-lento-con-el-de-hoy', `if (raw && !(j.paths && j.paths.maintainers !== undefined)) { ${loop} }`);
  r = GA.setKeyChecked('paths.maintainers', fx.work, { env, readers: [{ label: 'otro lector', file: slowToday }], readerMs: 400 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.match(r.warning || '', /otro lector acepta el archivo nuevo, pero no pude preguntarle por el de antes \(no terminó a tiempo\)/);
  GA.setKeyChecked('paths.maintainers', null, { env });
  // (5) no se pudo armar la copia (la carpeta temporal no existe)
  const tmp = process.env.TMPDIR;
  process.env.TMPDIR = path.join(fx.root, 'no-existe');
  try { r = GA.setKeyChecked('paths.maintainers', fx.work, { env, readers: guard }); } finally { if (tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmp; }
  if (process.platform !== 'win32') {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.match(r.warning || '', /no pude comprobarlo con el freno de producción instalado \(no pude armar la copia para preguntarle\)/);
  }
  GA.setKeyChecked('paths.maintainers', null, { env });
  // un lector que no está no frena ni avisa (una máquina sin freno de producción)
  r = GA.setKeyChecked('paths.maintained', fx.work, { env, readers: [{ label: 'uno que no está', file: path.join(fx.root, 'no-esta.js') }] });
  assert.deepStrictEqual([r.ok, r.warning], [true, null]);
  // lo que no llega a preguntarse: una clave que no es del arnés, y un archivo que hoy no se puede leer
  assert.match(GA.setKeyChecked('paths.otra', fx.work, { env, readers: guard }).reason, /la clave «paths\.otra» no es del arnés/);
  // 🔴 un secreto escrito a mano con otra forma (un objeto, no un texto) tampoco viaja a la copia
  fs.writeFileSync(file, JSON.stringify({ github: { token: { valor: 'un-secreto-con-otra-forma' } }, paths: { maintained: fx.work } }));
  assert.strictEqual(GA.setKeyChecked('paths.maintained', fx.work, { env, readers: guard }).ok, true);
  assert.ok(!fs.readFileSync(seen, 'utf8').includes('un-secreto-con-otra-forma'), 'el secreto con otra forma no sale del archivo real');
  // si el archivo de hoy no se puede leer, no se escribe encima ni se pregunta
  fs.writeFileSync(file, '{ roto');
  r = GA.setKeyChecked('paths.maintainers', fx.work, { env, readers: guard });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no se puede leer/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ roto', 'un archivo ilegible no se pisa');
  fs.rmSync(file);
  // …y si los lectores aprobaron pero después no se puede escribir, se dice (no «guardada»)
  if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
    fs.chmodSync(path.join(fx.home, '.tycon'), 0o500);
    try { r = GA.setKeyChecked('paths.maintained', fx.work, { env, readers: guard }); } finally { fs.chmodSync(path.join(fx.home, '.tycon'), 0o700); }
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /no pude escribir/);
  }
  // qué lectores se consultan: siempre el de este arnés; el del freno de producción, si está instalado y quien corre es
  // la cuenta real de la máquina (su HOME es el de la cuenta, esté donde esté TYCON_HOME), no un laboratorio
  const mine = GA.configReaders({ env, guardReader: old, realHome: path.join(fx.root, 'otra-cuenta') });
  assert.deepStrictEqual(mine.map((x) => path.basename(x.file)), ['tycon-config.js']);
  assert.ok(mine[0].file.startsWith(REPO), 'el lector de este arnés');
  const real = GA.configReaders({ env: { ...env, TYCON_HOME: path.join(fx.root, 'fuera-de-la-cuenta') }, guardReader: old, realHome: fx.home });
  assert.deepStrictEqual(real.map((x) => [path.basename(x.file), Boolean(x.guard)]), [['tycon-config.js', false], ['lector-viejo.js', true]]);
  assert.strictEqual(GA.configReaders({ env, guardReader: path.join(fx.root, 'no-esta.js'), realHome: fx.home }).length, 1, 'sin freno instalado, sólo el de este arnés');
  // en Windows la cuenta se nombra por USERPROFILE; sin ninguna de las dos, o sin saber cuál es la cuenta real, no se consulta
  assert.strictEqual(GA.configReaders({ env: { USERPROFILE: fx.home }, guardReader: old, realHome: fx.home }).length, 2);
  assert.strictEqual(GA.configReaders({ env: {}, guardReader: old, realHome: fx.home }).length, 1);
  assert.strictEqual(GA.configReaders({ env, guardReader: old, realHome: null }).length, 1);
});

test('T56_TeamMachineWithoutListOrWithABrokenOne_Blocks_OutsiderRunsGenericOnly', (t) => {
  const team = lab(t, { team: true });
  commitOn(team, 'limpia', { 'guides/a.md': 'limpio\n' });
  const none = guard(team, branchLine(team, 'limpia'), { list: null });
  assert.strictEqual(none.status, 2, 'máquina del equipo sin lista: «no pude mirar» no es «limpio»');
  assert.strictEqual(none.json.verdict, 'blind');
  for (const content of ['{ roto', '[]', JSON.stringify({ terminos: [{ categoria: 'cliente' }] })]) {
    fs.writeFileSync(team.list, content);
    const broken = guard(team, branchLine(team, 'limpia'));
    assert.strictEqual(broken.status, 2, `una lista ilegible no es una lista vacía: ${content}\n${broken.all}`);
  }
  // el perfil en el ÁRBOL que se empuja también hace a la máquina del equipo
  const byTree = lab(t, { team: false });
  commitOn(byTree, 'limpia', { 'guides/a.md': 'limpio\n', 'perfil-equipo.json': '{}\n' });
  assert.strictEqual(guard(byTree, branchLine(byTree, 'limpia'), { list: null }).status, 2);

  // sin perfil del equipo y sin lista (alguien de afuera con su copia): corre lo que no necesita lista, y lo dice
  const outsider = lab(t, { team: false });
  commitOn(outsider, 'limpia', { 'guides/a.md': `acá ${TERM} no es de ninguna lista\n` });
  const clean = guard(outsider, branchLine(outsider, 'limpia'), { list: null });
  assertPassed(clean);
  assert.strictEqual(clean.json.generic_only, true);
  assert.match(guard(outsider, branchLine(outsider, 'limpia'), { list: null, args: [] }).stderr, /sin lista/);
  commitOn(outsider, 'token', { 'scripts/x.js': `const t = '${TOKEN}';\n` });
  assertBlocked(outsider, guard(outsider, branchLine(outsider, 'token'), { list: null }), { category: 'secreto', secret: [TOKEN] });
  commitOn(outsider, 'vedada', { '.engram/x.jsonl.gz': 'x\n' });
  assertBlocked(outsider, guard(outsider, branchLine(outsider, 'vedada'), { list: null }), { category: 'ruta-vedada', secret: [] });
});

test('T56_NoOffSwitch_NoVariableChangesTheVerdict_AndTheMessageSaysHowToGetOut', (t) => {
  const fx = lab(t);
  commitOn(fx, 'sucia', { 'guides/a.md': `con ${TERM}\n` });
  const off = { TYCON_PUBLIC_PUSH_GUARD: '0', TYCON_PUBLIC_PUSH: '0', TYCON_NEW_NAMES: '0', TYCON_NO_GIT_HOOKS: '1', TYCON_SAFETY_GUARD: '0',
    TYCON_STORY_GATE: 'off', TYCON_PROFILE: '0', DOD_BYPASS: '1', TYCON_PR_BY_HAND: '1' };
  const r = guard(fx, branchLine(fx, 'sucia'), { env: off });
  assertBlocked(fx, r, { category: 'cliente' });
  const plain = guard(fx, branchLine(fx, 'sucia'), { env: off, args: [] });
  assert.strictEqual(plain.status, 1);
  assert.strictEqual(plain.stdout, '', 'por la salida estándar, nada: git la mezcla con la del empuje');
  assert.match(plain.stderr, /EMPUJE FRENADO/);
  assert.match(plain.stderr, /excepción con motivo/, 'dice cómo se sale de un freno falso');
  assert.ok(!/--no-verify/.test(plain.stderr));
  assert.ok(!plain.stderr.toLowerCase().includes(TERM.toLowerCase()));
  // una excepción con motivo en la lista es la salida: el mismo empuje pasa
  writeList(fx.list, TERM, { permitidos: [{ archivo: 'guides/a.md', patron: TERM, motivo: 'un ejemplo de la prueba' }] });
  assertPassed(guard(fx, branchLine(fx, 'sucia')));
});

test('T56_Status_SaysWhereTheListComesFrom_AndFailsWhenSomethingIsMissing', (t) => {
  const fx = lab(t);
  const hooks = path.join(fx.root, 'hooks-globales');
  fs.mkdirSync(hooks);
  // la carpeta de hooks que git usa en este repo (en una máquina de verdad la pone el `core.hooksPath` global)
  git(fx.work, ['config', 'core.hooksPath', hooks]);
  const status = (env = {}, list = fx.list) => spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js'), 'status'], {
    cwd: fx.work, encoding: 'utf8',
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      ...(list ? { TYCON_PUBLISH_DENYLIST: list } : {}), ...env },
  });
  // sin el pre-push puesto: 1, y lo dice
  let r = status();
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /pre-push.*NO está puesto/);
  // con el pre-push del arnés puesto (y con permiso de ejecución) y la lista legible: 0
  const ours = () => fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/usr/bin/env bash\n# git-pre-push-global.sh\nexit 0\n', { mode: 0o755 });
  ours();
  fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
  r = status();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /la lista: .*TYCON_PUBLISH_DENYLIST/);
  assert.ok(!r.stdout.includes(TERM), 'nunca un término de la lista');
  // el del arnés SIN permiso de ejecución: git no lo corre, así que no está puesto (en Windows git no mira ese permiso)
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(hooks, 'pre-push'), 0o644);
    r = status();
    assert.strictEqual(r.status, 1, r.stdout);
    assert.match(r.stdout, /el pre-push: NO corre .*permiso de ejecución/);
    fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
  }
  // uno ajeno en ese lugar no es el del arnés
  fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n');
  assert.strictEqual(status().status, 1);
  ours();
  // máquina del equipo sin lista: 1
  r = status({}, null);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /la lista: NO/);
  // T79 (tanda H1c): fuera de un repo se mira la carpeta GLOBAL de hooks. Puesta desde un archivo INCLUIDO por la
  // configuración global (`[include]`), git la usa: leída sin seguir los incluidos, status decía «git no tiene carpeta
  // global de hooks» con el freno puesto — distinto de lo que dicen el instalador y `doctor`.
  const included = path.join(fx.root, 'gitconfig-incluido');
  const globalConfig = path.join(fx.root, 'gitconfig-global');
  fs.writeFileSync(included, `[core]\n\thooksPath = ${hooks.split(path.sep).join('/')}\n`);
  fs.writeFileSync(globalConfig, `[include]\n\tpath = ${included.split(path.sep).join('/')}\n`);
  const outside = spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js'), 'status'], {
    cwd: fx.root, encoding: 'utf8',
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, TYCON_PUBLISH_DENYLIST: fx.list },
  });
  assert.strictEqual(outside.status, 0, outside.stdout + outside.stderr);
  assert.match(outside.stdout, /el pre-push: está puesto/);
});

// ── lo que encontró la primera vuelta de revisores: cada caso de acá salía VERDE sin que nadie hubiera mirado ─────

test('T22_UnreadableInput_IsNotAnEmptyPush', (t) => {
  // git manda por la entrada qué se empuja. Una entrada VACÍA es «nada que empujar» (pasa); una que no se pudo leer
  // no es eso. Leída como vacía, un empuje entero salía sin mirarse.
  const fx = lab(t);
  commitOn(fx, 'sucia', { 'guides/a.md': `con ${TERM}\n` });
  const call = (input) => spawnSync(process.execPath, ['-e',
    'const g = require(process.argv[1]); const r = g.prePush({ remoteName: "origin", url: process.argv[2], input: JSON.parse(process.argv[3]) }); process.stdout.write(JSON.stringify(r));',
    path.join(fx.harness, 'scripts/hooks/public-push-guard.js'), fx.publicUrl, JSON.stringify(input)], {
    cwd: fx.work, encoding: 'utf8',
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      TYCON_PUBLIC_PUSH_TREAT_AS_PUBLIC: fx.publicDir, TYCON_PUBLISH_DENYLIST: fx.list },
  });
  const unreadable = JSON.parse(call(null).stdout);
  assert.strictEqual(unreadable.code, 2, JSON.stringify(unreadable));
  assert.strictEqual(unreadable.result.verdict, 'blind');
  assert.match(unreadable.result.reason, /no pude leer lo que git le pasó/);
  // el gemelo: la entrada vacía sigue siendo «nada que empujar»
  assert.strictEqual(JSON.parse(call('').stdout).code, 0);
  // Y cuando el que no pudo leerla es el despachador, lo dice con un argumento. Con cerrarle la entrada al freno no
  // alcanzaba: Node reabre ese descriptor sobre nada y lee vacío — que es justo «nada que empujar».
  const told = guard(fx, '', { args: ['--json', '--input-unreadable'] });
  assert.strictEqual(told.status, 2, told.all);
  assert.match(told.json.reason, /no pude leer lo que git le pasó/);
  assert.strictEqual(guard(fx, '', { args: ['--json'] }).status, 0, 'sin ese argumento, la entrada vacía pasa');
  // y hacia un remoto que no es público ni siquiera hace falta leerla
  const local = spawnSync(process.execPath, ['-e',
    'const g = require(process.argv[1]); process.stdout.write(String(g.prePush({ remoteName: "x", url: process.argv[2], input: null }).code));',
    path.join(fx.harness, 'scripts/hooks/public-push-guard.js'), fx.localUrl], {
    cwd: fx.work, encoding: 'utf8',
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  });
  assert.strictEqual(local.stdout, '0', local.stderr);
});

test('T22_TrackingRefs_OnlyCountForARemoteThatFetchesFromTheAddressBeingPushedTo', (t) => {
  // «Lo que ese remoto ya tiene no se vuelve a mirar» se decidía por el NOMBRE del remoto. Un remoto que trae de un
  // lado y empuja a otro (`url` privada, `pushurl` pública: una mudanza) tiene de seguimiento lo que hay en el
  // privado: darlo por publicado dejaba salir sin mirar todo lo que el público todavía no tenía.
  const fx = lab(t);
  git(fx.work, ['remote', 'add', 'mudanza', fx.localUrl]);
  git(fx.work, ['remote', 'set-url', '--push', 'mudanza', fx.publicUrl]);
  commitOn(fx, 'sucia', { 'guides/a.md': `con ${TERM}\n` });
  git(fx.work, ['push', '--quiet', fx.localUrl, 'sucia']);
  git(fx.work, ['fetch', '--quiet', 'mudanza']);
  assert.ok(git(fx.work, ['rev-parse', 'refs/remotes/mudanza/sucia']), 'el laboratorio: la rama de seguimiento existe');
  const r = guard(fx, branchLine(fx, 'sucia'), { remote: 'mudanza', url: fx.publicUrl });
  assertBlocked(fx, r, { category: 'cliente', place: /guides\/a\.md:1/ });
  assert.strictEqual(r.json.looked.commits, 1, 'el commit está en el privado, no en el público: es nuevo ahí');
  // el gemelo: lo que el público SÍ tiene no se vuelve a mirar, aunque este clon no tenga ninguna rama de seguimiento
  // suya (se le pregunta al remoto: no depende de haber traído nada antes)
  commitOn(fx, 'publicada', { 'guides/b.md': 'limpio\n' });
  git(fx.work, ['push', '--quiet', fx.publicUrl, 'publicada']);
  git(fx.work, ['branch', 'sobre-publicada', 'publicada']);
  const again = guard(fx, branchLine(fx, 'sobre-publicada'));
  assertPassed(again);
  assert.strictEqual(again.json.looked.commits, 0);
  assert.strictEqual(again.json.looked.askedRemote, true);
  // la misma carpeta escrita de otra forma es la misma: se le pregunta a la dirección que git pasa
  const spelled = guard(fx, branchLine(fx, 'sobre-publicada'), { remote: 'origin', url: `${fx.publicUrl}${path.sep}.` });
  assertPassed(spelled);
  assert.strictEqual(spelled.json.looked.commits, 0, 'la misma carpeta, escrita distinto');
});

test('T22_ARemoteRepointedToThePublicRepo_ItsOldTrackingBranchesAreNotWhatThePublicHas', (t) => {
  // 🔴 EL GESTO DEL DÍA DEL CORTE (pase adversarial, dos lentes): en el clon de siempre, `git remote set-url origin
  // <público>`. Las ramas de seguimiento de `origin` siguen siendo las del repo INTERNO —no guardan de qué repo
  // salieron—; dándolas por «lo que el remoto ya tiene», toda la historia interna se excluía, el freno decía «1 commit
  // mirado» y git publicaba la historia entera. Ahora se le pregunta al remoto qué tiene.
  const fx = lab(t);
  const interno = path.join(fx.root, 'interno.git');
  git(fx.root, ['init', '--quiet', '--bare', '--initial-branch=main', interno]);
  git(fx.work, ['remote', 'set-url', 'origin', interno]);
  // la historia interna: un término en una guía, una ruta vedada, un autor con su correo de verdad
  git(fx.work, ['checkout', '--quiet', '-B', 'dev', 'main']);
  commitHere(fx, { 'guides/interna.md': `del caso de ${TERM}\n`, 'specs/secreto.md': 'una story\n' }, 'docs: lo interno', { who: { name: 'Alguien', email: BAD_EMAIL } });
  git(fx.work, ['push', '--quiet', 'origin', 'main', 'dev']);
  git(fx.work, ['fetch', '--quiet', 'origin']);
  // el corte: el mismo remoto, ahora hacia el público (que no tiene nada de eso); un `fetch` sin podar deja origin/dev
  git(fx.work, ['remote', 'set-url', 'origin', fx.publicUrl]);
  git(fx.work, ['fetch', '--quiet', 'origin']);
  assert.ok(git(fx.work, ['rev-parse', 'refs/remotes/origin/dev']), 'el laboratorio: la rama de seguimiento vieja sigue ahí');
  commitOn(fx, 'nueva', { 'guides/limpia.md': 'limpio\n' }, 'docs: una guía', { from: 'dev' });
  const r = guard(fx, branchLine(fx, 'nueva'));
  assert.strictEqual(r.status, 1, `la historia interna salía sin mirarse\n${r.all}`);
  assert.strictEqual(r.json.looked.commits, 2, 'los dos commits que el público no tiene: el interno y el nuevo');
  for (const category of ['cliente', 'ruta-vedada', 'identidad']) assert.ok(r.json.findings.some((f) => f.category === category), `falta ${category}: ${JSON.stringify(r.json.findings)}`);
  // lo mismo si el repo público se borró y se volvió a crear vacío en la misma dirección
  fs.rmSync(fx.publicUrl, { recursive: true, force: true });
  git(fx.root, ['init', '--quiet', '--bare', '--initial-branch=main', fx.publicUrl]);
  const recreated = guard(fx, branchLine(fx, 'nueva'));
  assert.strictEqual(recreated.status, 1, recreated.all);
  assert.ok(recreated.json.looked.commits >= 3, 'ahora el público no tiene nada: se mira todo');
});

test('T22_WhenTheRemoteDoesNotAnswer_NothingIsTakenAsPublished_AndItIsSaid', (t) => {
  // sin poder preguntarle al remoto no se da nada por publicado (las ramas de seguimiento no alcanzan): se mira todo
  // lo que el empuje alcanza. Una dirección de otro servidor acá no contesta: la prueba no sale a la red.
  const fx = lab(t);
  git(fx.work, ['remote', 'add', 'publico', 'https://github.com/acme/widgets.git']);
  git(fx.work, ['update-ref', 'refs/remotes/publico/main', git(fx.work, ['rev-parse', 'main'])]);
  commitOn(fx, 'una-mas', { 'guides/c.md': 'limpio\n' });
  const r = guard(fx, branchLine(fx, 'una-mas'), { remote: 'publico', url: 'https://github.com/acme/widgets.git' });
  assertPassed(r);
  assert.strictEqual(r.json.looked.askedRemote, false);
  assert.strictEqual(r.json.looked.commits, 2, 'también el commit que la rama de seguimiento decía publicado');
  assert.match(guard(fx, branchLine(fx, 'una-mas'), { remote: 'publico', url: 'https://github.com/acme/widgets.git', args: [] }).stderr, /el remoto no contestó qué tiene/);
  // con la punta remota que informa git (una actualización de la rama) eso sí se sabe, conteste o no
  const base = git(fx.work, ['rev-parse', 'main']);
  const update = guard(fx, line('refs/heads/una-mas', git(fx.work, ['rev-parse', 'una-mas']), base), { remote: 'publico', url: 'https://github.com/acme/widgets.git' });
  assert.strictEqual(update.json.looked.commits, 1);
});

test('T22_WhatIsReadIsWhatIsPushed_ReplacedObjects_NoreplyAccount_RefsWithSpaces', (t) => {
  const fx = lab(t);
  // un commit sucio «arreglado» con `git replace`: git muestra el reemplazo, pero el empuje manda el ORIGINAL
  const dirty = commitOn(fx, 'reemplazada', { 'guides/a.md': `con ${TERM}\n` }, 'docs: a');
  git(fx.work, ['checkout', '--quiet', '-B', 'limpia-aparte', 'main']);
  const clean = commitHere(fx, { 'guides/a.md': 'sin nada\n' }, 'docs: a');
  git(fx.work, ['replace', dirty, clean]);
  const replaced = guard(fx, line('refs/heads/reemplazada', dirty));
  assertBlocked(fx, replaced, { category: 'cliente', place: /guides\/a\.md:1/ });
  git(fx.work, ['replace', '-d', dirty]);
  // el nombre de la CUENTA que va adentro del correo noreply también se publica: va contra la lista
  commitOn(fx, 'cuenta', { 'guides/b.md': 'limpio\n' }, 'docs: b', { who: { name: 'Mantenedor De Prueba', email: `4242+${TERM.toLowerCase()}-dev@users.noreply.github.com` } });
  assertBlocked(fx, guard(fx, branchLine(fx, 'cuenta')), { category: 'cliente', place: /la cuenta de su correo/ });
  // una cuenta administrada por una empresa lleva guion bajo: es un noreply válido
  commitOn(fx, 'empresa', { 'guides/c.md': 'limpio\n' }, 'docs: c', { who: { name: 'Mantenedor De Prueba', email: '77+mantenedor_empresa@users.noreply.github.com' } });
  assertPassed(guard(fx, branchLine(fx, 'empresa')));
  // git escribe la ref local tal como se tipeó: puede llevar espacios, y la línea se lee desde el final
  const sha = git(fx.work, ['rev-parse', 'empresa']);
  const spaced = guard(fx, `empresa@{1 day ago} ${sha} refs/heads/empresa ${ZERO}\n`);
  assertPassed(spaced);
  assert.strictEqual(spaced.json.looked.refs, 1);
});

test('T56_TheListNeverComesFromThePushedTree_EvenWhenTheMachineNamesThatTreeAsItsClone', (t) => {
  // La máquina puede declarar como «el clon que mantiene» al mismo clon que se está empujando: con la lista adentro,
  // la rama elegía con qué lista se la mira (una lista propia con una excepción general apagaba hasta lo genérico).
  const fx = lab(t);
  const config = path.join(fx.home, '.tycon', 'config.json');
  writeList(path.join(fx.work, 'scripts/publishing/denylist.json'), OTHER_TERM, { permitidos: [{ archivo: '**', motivo: 'todo vale' }] });
  commitOn(fx, 'sucia', { 'guides/a.md': `con ${TERM}\n`, 'scripts/x.js': `const t = '${TOKEN}';\n` });
  // tampoco nombrada por la variable: un archivo del árbol de trabajo lo dejó ahí la rama que está sacada
  const byVariable = guard(fx, branchLine(fx, 'sucia'), { list: path.join(fx.work, 'scripts/publishing/denylist.json') });
  assert.strictEqual(byVariable.status, 2, `la variable: usó la lista del árbol que se empuja\n${byVariable.all}`);
  assert.match(byVariable.json.reason, /sin la lista: TYCON_PUBLISH_DENYLIST es el mismo árbol que se empuja/);
  for (const key of ['maintained', 'maintainers']) {
    fs.writeFileSync(config, JSON.stringify({ paths: { [key]: fx.work } }));
    const r = guard(fx, branchLine(fx, 'sucia'), { list: null });
    assert.strictEqual(r.status, 2, `${key}: usó la lista del árbol que se empuja\n${r.all}`);
    assert.match(r.json.reason, /sin la lista/);
  }
  // el gemelo: el mismo clon declarado como el que la máquina mantiene, y la lista en OTRO lado (el arnés que corre): ésa manda
  fs.writeFileSync(config, JSON.stringify({ paths: { maintained: fx.work } }));
  writeList(path.join(fx.harness, 'scripts/publishing/denylist.json'), TERM);
  const r = guard(fx, branchLine(fx, 'sucia'), { list: null });
  assertBlocked(fx, r, { category: 'cliente', secret: [TERM, TOKEN] });
  assert.strictEqual(r.json.list.source, 'harness');
});

test('T22_HarnessPush_ByWhatIsPushedAndByTheDeclaredRepo_NotOnlyByTheWorkingTree', (t) => {
  // Se decidía mirando si el árbol de TRABAJO traía el instalador. Parado en una rama que no lo trae, una rama del
  // arnés salía sin freno; y un repo del arnés que no trae ese archivo (el de las skills) no tenía freno nunca.
  const fx = lab(t, { harnessTree: false });
  commitOn(fx, 'del-arnes', { 'scripts/install-tycon-hooks.sh': '#!/bin/sh\n', 'guides/a.md': `con ${TERM}\n` });
  git(fx.work, ['checkout', '--quiet', 'main']);
  assert.ok(!fs.existsSync(path.join(fx.work, 'scripts/install-tycon-hooks.sh')), 'el laboratorio: el árbol de trabajo no trae la marca');
  assertBlocked(fx, guard(fx, branchLine(fx, 'del-arnes')), { category: 'cliente', place: /guides\/a\.md:1/ });
  // desde un repo desnudo (no hay árbol de trabajo que mirar)
  const bare = path.join(fx.root, 'desnudo.git');
  git(fx.root, ['clone', '--quiet', '--bare', fx.work, bare]);
  assertBlocked(fx, guard(fx, branchLine(fx, 'del-arnes'), { cwd: bare }), { category: 'cliente' });
  // por el repo al que va: uno que el arnés declara suyo, aunque ni el árbol ni la rama traigan el instalador
  commitOn(fx, 'sin-marca', { 'skills/a.md': `con ${TERM}\n` });
  const declared = 'https://github.com/acme/skills-de-prueba';
  const byRepo = guard(fx, branchLine(fx, 'sin-marca'), { remote: 'otro', url: `${declared}.git`, env: { TYCON_HARNESS_IDENTITIES: declared } });
  assertBlocked(fx, byRepo, { category: 'cliente', place: /skills\/a\.md:1/ });
  // el gemelo: la misma rama a un repo público que NO es del arnés no es asunto de este freno
  const elsewhere = guard(fx, branchLine(fx, 'sin-marca'), { remote: 'otro', url: 'https://github.com/acme/otra-cosa.git', env: { TYCON_HARNESS_IDENTITIES: declared } });
  assert.strictEqual(elsewhere.status, 0, elsewhere.all);
  assert.strictEqual(elsewhere.json.verdict, 'skip');
  // 🔴 Esa variable SUMA repos, no saca: el que el arnés declara en sus archivos sigue contando con la variable puesta
  // en otra cosa (con ella como única fuente, ponerla alcanzaba para que el repo público saliera sin mirar).
  write(fx.harness, 'scripts/publishing/public-repos.json', `${JSON.stringify({ org: 'acme', repo: 'declarado' })}\n`);
  const stillDeclared = guard(fx, branchLine(fx, 'sin-marca'), { remote: 'otro', url: 'https://github.com/acme/declarado.git', env: { TYCON_HARNESS_IDENTITIES: 'https://github.com/acme/otra-cosa' } });
  assertBlocked(fx, stillDeclared, { category: 'cliente', place: /skills\/a\.md:1/ });
});

test('T22_HistoryControl_BrokenIsCouldNotLook_AbsentIsSaidOutLoud', (t) => {
  const fx = lab(t);
  commitOn(fx, 'pedido', { 'guides/a.md': 'limpio\n' }, 'fix: lo que quedó del PR 1234');
  const file = path.join(fx.harness, HISTORY);
  const input = branchLine(fx, 'pedido');
  // está y no carga · está y no trae `scan` · `scan` tira · `scan` no devuelve una lista: ninguno es «sin números»
  for (const broken of ['esto no es javascript (', 'module.exports = {};', 'module.exports = { scan() { throw new TypeError("x"); } };', 'module.exports = { scan() { return null; } };']) {
    fs.writeFileSync(file, broken);
    const r = guard(fx, input);
    assert.strictEqual(r.status, 2, `un control roto no es «no hay números de pedido»: ${broken}\n${r.all}`);
    assert.match(r.json.reason, /control de historia interna/);
  }
  // no está (un arnés anterior a ese control): no se mide, y se DICE — en la salida de un empuje que pasa y en `status`
  fs.rmSync(file);
  const absent = guard(fx, input);
  assertPassed(absent);
  assert.strictEqual(absent.json.history, false);
  assert.match(guard(fx, input, { args: [] }).stderr, /números de pedido .* NO se miraron/);
  const status = spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js'), 'status'], {
    cwd: fx.work, encoding: 'utf8',
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, TYCON_PUBLISH_DENYLIST: fx.list },
  });
  assert.strictEqual(status.status, 1, status.stdout);
  assert.match(status.stdout, /números de pedido: NO se miden/);
});

test('T22_WhenGitCannotAnswer_ItIsCouldNotLook_NeverAnEmptyAnswer', (t) => {
  // Las funciones que le preguntan algo a git y arman una lista: si git no contesta, una lista vacía se leería como
  // «no hay remotos» (nada que excluir es inofensivo; «ningún remoto público» haría que el freno de `gh` no mire).
  const fx = lab(t);
  const g = require(path.join(REPO, 'scripts', 'hooks', 'public-push-guard.js'));
  const nowhere = path.join(fx.root, 'no-es-un-repo');
  fs.mkdirSync(nowhere);
  for (const ask of [() => g.publicRemotesOf(nowhere, {}), () => g.newPairs(nowhere, ['0'.repeat(40)], new Map())]) {
    assert.throws(ask, (e) => e instanceof g.Blind && !/Zorblax/.test(e.message), 'tenía que ser «no pude mirar»');
  }
  // preguntarle al remoto qué tiene: si no contesta es `null` (no se da nada por publicado), nunca una lista vacía
  assert.strictEqual(g.remoteHas(fx.work, path.join(fx.root, 'no-existe.git')), null);
  assert.deepStrictEqual(g.remoteHas(fx.work, fx.localUrl), [], 'un remoto que contesta y no tiene nada');
  assert.deepStrictEqual(g.remoteHas(fx.work, fx.publicUrl), [git(fx.work, ['rev-parse', 'main'])]);
  // una respuesta de git cortada tampoco es «no hay objetos»: se pide uno que no existe junto a uno que sí
  const have = git(fx.work, ['rev-parse', 'HEAD']);
  const got = g.readObjects(fx.work, [have, 'f'.repeat(40)]);
  assert.strictEqual(got.get(have).type, 'commit');
  assert.strictEqual(got.get('f'.repeat(40)), null, 'lo que git no tiene se dice (null), no se saltea');
  // y las líneas que git manda, cuando no tienen su forma
  for (const bad of ['refs/heads/x abc refs/heads/x def\n', `refs/heads/x ${have} otra-cosa ${ZERO}\n`, `refs/heads/x ${have} refs/heads/x\n`]) {
    assert.throws(() => g.parseLines(bad), (e) => e instanceof g.Blind, bad);
  }
  assert.deepStrictEqual(g.parseLines(''), []);
  // una dirección vacía DE ENTRADA no es «una carpeta sin origin» (eso es local): es una que no se sabe leer → pública
  assert.strictEqual(g.judgeRemote('', fx.work, {}).kind, 'public');
  assert.strictEqual(g.judgeRemote(fx.localUrl, fx.work, {}).kind, 'local', 'la carpeta sin origin sigue siendo local');
  // «la punta no trae el instalador» y «no pude leer la punta» no son lo mismo: lo segundo no es «no es del arnés»
  const product = lab(t, { harnessTree: false });
  const tip = git(product.work, ['rev-parse', 'HEAD']);
  const asked = { repo: product.work, top: product.work, url: 'https://github.com/acme/otra-cosa.git', env: {} };
  assert.strictEqual(g.concernsHarness({ ...asked, lines: [{ localSha: tip }] }), false);
  assert.throws(() => g.concernsHarness({ ...asked, lines: [{ localSha: 'e'.repeat(40) }] }), (e) => e instanceof g.Blind);
});

// ── AC 23: el modo de rango, con el que la validación mira un pedido (tanda F2) ─────────────────────────────────────
//
// `range --base <commit> --head <commit> [--branch <nombre>] [--title-file <f>] [--body-file <f>]`: cada commit que el
// pedido suma a su rama destino, el nombre de la rama, y el título y el cuerpo. No le pregunta nada al remoto, y la
// lista es siempre obligatoria. Lo corre el paso «El freno de publicación sobre el pedido» de la validación.

/** Corre el modo de rango del freno del laboratorio. `title` y `body`: el texto (se escribe a un archivo), o nada. */
function rangeGuard(fx, { base = 'main', head, branch, title, body, titleFile, bodyFile, env = {}, list = fx.list, args = ['--json'], cwd = fx.work } = {}) {
  const argv = ['range', '--base', base, '--head', head || git(fx.work, ['rev-parse', 'HEAD'])];
  if (branch !== undefined) argv.push('--branch', branch);
  const file = (name, text) => { const f = path.join(fx.root, name); fs.writeFileSync(f, text); return f; };
  if (title !== undefined) argv.push('--title-file', file('titulo.txt', title));
  else if (titleFile) argv.push('--title-file', titleFile);
  if (body !== undefined) argv.push('--body-file', file('cuerpo.txt', body));
  else if (bodyFile) argv.push('--body-file', bodyFile);
  const r = spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js'), ...argv, ...args], {
    cwd, encoding: 'utf8',
    // sin GIT_ALLOW_PROTOCOL ni TYCON_PUBLIC_PUSH_TREAT_AS_PUBLIC: este modo no habla con ningún remoto
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      ...(list ? { TYCON_PUBLISH_DENYLIST: list } : {}), ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { json = null; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}\n${r.stderr}`, json };
}

test('T23_RangeMode_TermInAMiddleCommitMessageOrTitle_Blocked_DocsOnlyToo_NoListIsCouldNotLook_CleanPasses', (t) => {
  const fx = lab(t);
  // el término sólo en un commit INTERMEDIO: la punta del pedido está limpia y su historia no
  const dirty = commitOn(fx, 'pedido-neto', { 'scripts/a.js': `// para ${TERM}\n` }, 'feat: primera versión');
  commitHere(fx, { 'scripts/a.js': '// ya sin nada\n' }, 'feat: corregido');
  const net = rangeGuard(fx, { branch: 'pedido-neto', title: 'feat: una cosa', body: 'un cuerpo\n' });
  assertBlocked(fx, net, { category: 'cliente', place: new RegExp(`scripts/a\\.js:1 \\(commit ${dirty.slice(0, 10)}`) });
  assert.strictEqual(net.json.looked.commits, 2, 'mira cada commit del pedido, no la diferencia neta');

  // en un mensaje
  const msg = commitOn(fx, 'pedido-mensaje', { 'scripts/b.js': '// limpio\n' }, `fix: un arreglo\n\npara el caso de ${TERM}`);
  assertBlocked(fx, rangeGuard(fx, { branch: 'pedido-mensaje', title: 'fix: un arreglo', body: '' }),
    { category: 'cliente', place: new RegExp(`el mensaje del commit ${msg.slice(0, 10)}.*línea 3`) });

  // en el título, con los commits limpios
  commitOn(fx, 'pedido-titulo', { 'scripts/c.js': '// limpio\n' }, 'fix: otro arreglo');
  assertBlocked(fx, rangeGuard(fx, { branch: 'pedido-titulo', title: `fix: lo de ${TERM}`, body: 'un cuerpo limpio\n' }), { category: 'cliente', place: /el título del pedido/ });

  // un pedido de SÓLO documentación se mira igual (que el paso corra siempre lo mide la prueba del YAML)
  commitOn(fx, 'pedido-docs', { 'guides/nota.md': `una nota sobre ${TERM}\n` }, 'docs: una nota');
  assertBlocked(fx, rangeGuard(fx, { branch: 'pedido-docs', title: 'docs: una nota', body: '' }), { category: 'cliente', place: /guides\/nota\.md:1/ });

  // sin lista: «no pude mirar», nunca verde — en la máquina del equipo y en una sin perfil (acá no hay «sólo lo genérico»)
  commitOn(fx, 'pedido-limpio', { 'guides/limpia.md': 'una guía limpia\n' }, 'docs: una guía');
  for (const where of [fx, lab(t, { team: false })]) {
    if (where !== fx) commitOn(where, 'pedido-limpio', { 'guides/limpia.md': 'una guía limpia\n' }, 'docs: una guía');
    const blind = rangeGuard(where, { branch: 'pedido-limpio', title: 'docs: una guía', body: '', list: null });
    assert.strictEqual(blind.status, 2, `sin lista tenía que salir 2\n${blind.all}`);
    assert.strictEqual(blind.json.verdict, 'blind');
    assert.match(blind.json.reason, /sin la lista/);
  }

  // el gemelo verde: el pedido limpio, con su título y su cuerpo
  const clean = rangeGuard(fx, { branch: 'pedido-limpio', title: 'docs: una guía', body: 'Suma una guía.\n\nNada más.\n' });
  assertPassed(clean);
  assert.strictEqual(clean.json.looked.commits, 1);
  assert.deepStrictEqual(clean.json.texts, { title: true, body: true });
  assert.strictEqual(clean.json.looked.askedRemote, undefined, 'este modo no le pregunta nada al remoto');
  // lo que ya está en la rama destino no es del pedido: un commit con el término en la BASE no se vuelve a mirar
  git(fx.work, ['checkout', '--quiet', 'main']);
  commitHere(fx, { 'guides/vieja.md': `ya publicada, con ${TERM}\n` }, 'docs: de antes');
  commitOn(fx, 'pedido-sobre-eso', { 'guides/otra.md': 'limpia\n' }, 'docs: otra');
  assertPassed(rangeGuard(fx, { branch: 'pedido-sobre-eso', title: 'docs: otra', body: '' }));
});

test('T63_RangeMode_BranchBodyIdentityAndForbiddenPath_EachBlocked_AndItSaysWhatToDo', (t) => {
  const fx = lab(t);
  const limpio = { title: 'docs: una guía', body: 'un cuerpo limpio\n' };
  // el nombre de la rama
  commitOn(fx, 'rama', { 'guides/a.md': 'limpio\n' }, 'docs: a');
  assertBlocked(fx, rangeGuard(fx, { ...limpio, branch: `feature/${TERM.toLowerCase()}-x` }), { category: 'cliente', place: /el nombre de la rama del pedido/ });
  // el cuerpo, con su línea
  assertBlocked(fx, rangeGuard(fx, { branch: 'rama', title: limpio.title, body: `Primera línea.\nLa segunda nombra a ${TERM}.\n` }), { category: 'cliente', place: /el cuerpo del pedido \(línea 2\)/ });
  // un número de pedido en el título o en el cuerpo (la forma del control de historia interna); un número de story pasa
  assertBlocked(fx, rangeGuard(fx, { branch: 'rama', title: 'fix: lo que quedó del PR 1234', body: '' }), { category: 'historia-interna', place: /el título del pedido/, secret: ['1234'] });
  assertBlocked(fx, rangeGuard(fx, { branch: 'rama', title: limpio.title, body: 'Sigue lo del pull request 1235.\n' }), { category: 'historia-interna', place: /el cuerpo del pedido \(línea 1\)/, secret: ['1235'] });
  assertPassed(rangeGuard(fx, { branch: 'story/8.26-f2', title: 'feat(8.26): la tanda F2 de la story 8.26', body: 'Criterios 23 y 24.\n' }));
  // un secreto en el cuerpo: el detector completo, no sólo la lista
  assertBlocked(fx, rangeGuard(fx, { branch: 'rama', title: limpio.title, body: `la llave es ${TOKEN}\n` }), { category: 'secreto', place: /el cuerpo del pedido/, secret: [TOKEN, TOKEN.slice(0, 12)] });

  // el autor (su nombre contra la lista) y el committer (su correo: un `noreply` de GitHub)
  const a = commitOn(fx, 'autor', { 'guides/b.md': 'limpio\n' }, 'docs: b', { who: { name: `${TERM} Pérez`, email: GOOD.email }, committer: GOOD });
  assertBlocked(fx, rangeGuard(fx, { ...limpio, branch: 'autor' }), { category: 'cliente', place: new RegExp(`el autor del commit ${a.slice(0, 10)}`) });
  const c = commitOn(fx, 'committer', { 'guides/c.md': 'limpio\n' }, 'docs: c', { who: GOOD, committer: { name: 'Mantenedor De Prueba', email: BAD_EMAIL } });
  assertBlocked(fx, rangeGuard(fx, { ...limpio, branch: 'committer' }), { category: 'identidad', place: new RegExp(`el committer del commit ${c.slice(0, 10)}`), secret: [BAD_EMAIL] });

  // una ruta vedada, también si se agregó y se sacó en el mismo pedido
  commitOn(fx, 'vedada', { 'specs/story-9.md': 'x\n' }, 'docs: una story');
  commitHere(fx, { 'specs/story-9.md': null }, 'la saco');
  const forbidden = rangeGuard(fx, { ...limpio, branch: 'vedada' });
  assertBlocked(fx, forbidden, { category: 'ruta-vedada', place: /specs\/story-9\.md/, secret: [] });

  // 🔴 qué hacer: la rama de un pedido YA es pública. Sin `--json`, el mensaje dice las tres cosas, y que un secreto se rota
  const said = rangeGuard(fx, { ...limpio, branch: 'vedada', args: [] });
  assert.strictEqual(said.status, 1);
  assert.match(said.all, /PEDIDO FRENADO/);
  assert.match(said.all, /cerr[áa]r? el pedido/i);
  assert.match(said.all, /borr[áa]r? la rama/i);
  assert.match(said.all, /purga/);
  assert.match(said.all, /secreto.*rot/i);
  assert.match(said.all, /permitidos/, 'de un freno falso se sale con una excepción en la lista');
  assert.ok(!/--no-verify/.test(said.all));
  // …y deja su línea de cuentas, que es lo que el paso de la validación lee para armar su aviso de texto fijo
  assert.match(said.stdout, /^public-push-guard: verdict=findings findings=1 commits=2 branch=1 title=1 body=1$/m);
  const rama = git(fx.work, ['rev-parse', 'refs/heads/rama']);
  const ok = rangeGuard(fx, { ...limpio, branch: 'rama', head: rama, args: [] });
  assert.strictEqual(ok.status, 0, ok.all);
  assert.match(ok.stdout, /^public-push-guard: verdict=pass findings=0 commits=1 branch=1 title=1 body=1$/m);
  assert.match(ok.stdout, /el nombre de la rama, mirado; el título y el cuerpo, mirados/);
  // la línea de cuentas dice cada cosa por lo que pasó con ELLA (pase adversarial F2): sin el nombre de la rama, `branch=0`
  // —el paso de la validación exige 1 en un pedido—; y con sólo el título, no dice haber mirado «el título y el cuerpo»
  const noBranch = rangeGuard(fx, { ...limpio, head: rama, args: [] });
  assert.match(noBranch.stdout, /^public-push-guard: verdict=pass findings=0 commits=1 branch=0 title=1 body=1$/m);
  assert.match(noBranch.stdout, /sin nombre de rama que mirar/);
  const onlyTitle = rangeGuard(fx, { branch: 'rama', title: limpio.title, head: rama, args: [] });
  assert.match(onlyTitle.stdout, /^public-push-guard: verdict=pass findings=0 commits=1 branch=1 title=1 body=0$/m);
  assert.match(onlyTitle.stdout, /el título, mirado \(sin cuerpo que mirar\)/);
  assert.doesNotMatch(onlyTitle.stdout, /el título y el cuerpo/);
  const onlyBody = rangeGuard(fx, { branch: 'rama', body: limpio.body, head: rama, args: [] });
  assert.match(onlyBody.stdout, /^public-push-guard: verdict=pass findings=0 commits=1 branch=1 title=0 body=1$/m);
  assert.match(onlyBody.stdout, /el cuerpo, mirado \(sin título que mirar\)/);
});

test('T63_RangeMode_WhatItCannotLookAt_IsTwo_AndWithoutAPullRequestItSaysThereIsNoTitle', (t) => {
  const fx = lab(t);
  const head = commitOn(fx, 'pedido', { 'guides/a.md': 'limpio\n' }, 'docs: a');
  const two = (r, why, what) => {
    assert.strictEqual(r.status, 2, `${what}: tenía que salir 2\n${r.all}`);
    assert.strictEqual(r.json && r.json.verdict, 'blind', r.all);
    assert.match(r.json.reason, why, what);
  };
  // la lista ADENTRO del árbol del pedido no cuenta: el pedido elegiría con qué lista se lo mira
  write(fx.work, 'scripts/publishing/denylist.json', `${JSON.stringify({ terminos: [{ patron: OTHER_TERM, categoria: 'cliente' }], permitidos: [] })}\n`);
  two(rangeGuard(fx, { branch: 'pedido', title: 'x', body: '', list: path.join(fx.work, 'scripts/publishing/denylist.json') }), /mismo árbol/, 'la lista adentro del árbol');
  fs.rmSync(path.join(fx.work, 'scripts/publishing/denylist.json'));
  // una lista que no se deja leer
  fs.writeFileSync(path.join(fx.root, 'rota.json'), '{ esto no es json');
  two(rangeGuard(fx, { branch: 'pedido', title: 'x', body: '', list: path.join(fx.root, 'rota.json') }), /no se puede leer/, 'una lista rota');
  // una base o una punta que git no conoce: no es «un pedido sin commits»
  two(rangeGuard(fx, { branch: 'pedido', base: 'origin/no-existe', title: 'x', body: '' }), /la base/, 'una base que no existe');
  two(rangeGuard(fx, { branch: 'pedido', head: 'e'.repeat(40), title: 'x', body: '' }), /la punta/, 'una punta que no existe');
  // un archivo de título o de cuerpo que no está: no es «un título vacío»
  two(rangeGuard(fx, { branch: 'pedido', titleFile: path.join(fx.root, 'no-esta.txt'), body: '' }), /el título/, 'el archivo del título no está');
  two(rangeGuard(fx, { branch: 'pedido', title: 'x', bodyFile: path.join(fx.root, 'no-esta.txt') }), /el cuerpo/, 'el archivo del cuerpo no está');
  // 🔴 un clon al que le falta historia (superficial): los commits del pedido que no están no son «commits limpios».
  // Acá el pedido tiene dos commits y el clon «sabe» sólo de la punta (pase adversarial de la tanda F2).
  commitOn(fx, 'pedido-largo', { 'guides/b.md': `para ${TERM}\n` }, 'docs: b');
  const longTip = commitHere(fx, { 'guides/b.md': 'limpio\n' }, 'docs: b, corregido');
  const shallowFile = path.join(git(fx.work, ['rev-parse', '--absolute-git-dir']), 'shallow');
  fs.writeFileSync(shallowFile, `${longTip}\n`);
  two(rangeGuard(fx, { branch: 'pedido-largo', head: longTip, title: 'x', body: '' }), /no trae la historia entera/, 'un clon superficial');
  fs.rmSync(shallowFile);
  assertBlocked(fx, rangeGuard(fx, { branch: 'pedido-largo', head: longTip, title: 'x', body: '' }), { category: 'cliente', place: /guides\/b\.md:1/ });
  git(fx.work, ['checkout', '--quiet', 'pedido']);
  // fuera de un repo, y sin los argumentos que hacen falta
  const nowhere = path.join(fx.root, 'suelta');
  fs.mkdirSync(nowhere);
  two(rangeGuard(fx, { branch: 'pedido', head, title: 'x', body: '', cwd: nowhere }), /repo/, 'una carpeta que no es un repo');
  const raw = (argv) => spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js'), 'range', ...argv], { cwd: fx.work, encoding: 'utf8', env: { ...cleanEnv(), HOME: fx.home, TYCON_PUBLISH_DENYLIST: fx.list } });
  assert.strictEqual(raw(['--head', head]).status, 2, 'sin --base no hay rango');
  // una opción que no se conoce, o sin su valor, no se saltea: un `--base` mal escrito dejaría el rango sin base
  for (const argv of [['--base', 'main', '--head', head, '--unknown'], ['--bases', 'main', '--head', head], ['--base', 'main', '--head'], ['--base', 'main', '--head', head, 'suelto']]) {
    const r = raw(argv);
    assert.strictEqual(r.status, 2, `${argv.join(' ')}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^uso: public-push-guard\.js range /m);
    assert.doesNotMatch(r.stdout, /verdict=pass/, 'sin haber mirado no hay línea de cuentas en verde');
  }
  // …y el valor de una opción puede empezar con guiones (una rama se puede llamar así): es un valor, no otra opción
  assertPassed(rangeGuard(fx, { branch: '--json', title: 'docs: a', body: '' }));
  // 🔴 …también el de la base y el de la punta, que van a parar a git: un valor con forma de opción de git se lee como
  // el nombre de un commit (que no existe), nunca como una opción — ni corre nada, ni escribe nada
  const planted = path.join(fx.root, 'plantado.txt');
  for (const evil of [`--output=${planted}`, '--upload-pack=touch plantado', '-n1', '--all']) {
    two(rangeGuard(fx, { branch: 'pedido', base: evil, title: 'x', body: '' }), /la base/, `la base «${evil}»`);
    two(rangeGuard(fx, { branch: 'pedido', head: evil, title: 'x', body: '' }), /la punta/, `la punta «${evil}»`);
  }
  assert.ok(!fs.existsSync(planted), 'git no leyó ese valor como una opción');
  // un valor VACÍO no es un valor (una variable del pipeline que quedó vacía): 2, no «sin rama» o «sin título» callado
  for (const option of ['--base', '--head', '--branch', '--title-file', '--body-file']) {
    const argv = ['--base', 'main', '--head', head].filter((a, i, all) => !(a === option || all[i - 1] === option));
    const r = raw([...argv, option, '']);
    assert.strictEqual(r.status, 2, `${option} vacío\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^uso: public-push-guard\.js range /m, `${option} vacío`);
  }
  // el tope de tiempo vencido tampoco es verde
  two(rangeGuard(fx, { branch: 'pedido', title: 'x', body: '', env: { TYCON_PUBLIC_PUSH_LIMIT_MS: '0' } }), /tope de tiempo/, 'el tope de tiempo');
  // …y si para entonces ya había hallazgos (la rama, el título y el cuerpo se miran primero, que no cuesta nada), se
  // DICEN, con lo que faltó mirar: 1, no 2
  const partial = rangeGuard(fx, { branch: 'pedido', title: `docs: lo de ${TERM}`, body: '', env: { TYCON_PUBLIC_PUSH_LIMIT_MS: '0' } });
  assertBlocked(fx, partial, { category: 'cliente', place: /el título del pedido/ });
  assert.match(partial.json.partial, /tope de tiempo/);
  const partialSaid = rangeGuard(fx, { branch: 'pedido', title: `docs: lo de ${TERM}`, body: '', env: { TYCON_PUBLIC_PUSH_LIMIT_MS: '0' }, args: [] });
  assert.match(partialSaid.stdout, /Y no terminé de mirar: .*tope de tiempo.*Puede haber más/);
  assert.match(partialSaid.stdout, /^public-push-guard: verdict=findings findings=1 /m);
  // lo que dice cuando no pudo mirar, sin `--json`: que el pedido queda frenado, y su línea de cuentas
  const blindSaid = rangeGuard(fx, { branch: 'pedido', title: 'x', body: '', list: null, args: [] });
  assert.strictEqual(blindSaid.status, 2);
  assert.match(blindSaid.stdout, /PEDIDO FRENADO — no pude mirar lo que este pedido publica: sin la lista/);
  assert.match(blindSaid.stdout, /«No pude mirar» no es «limpio»/);
  assert.match(blindSaid.stdout, /^public-push-guard: verdict=blind findings=0 commits=0 /m);
  // 🔴 sin el control de historia interna: en un empuje se dice y sigue (un arnés instalado anterior a ese control);
  // acá NO — la validación corre el árbol del repo, que lo trae: si falta, los números de pedido no se miraron
  const history = path.join(fx.harness, HISTORY);
  const kept = fs.readFileSync(history);
  fs.rmSync(history);
  two(rangeGuard(fx, { branch: 'pedido', title: 'docs: a', body: '' }), /control de historia interna/, 'sin el control de historia interna');
  fs.writeFileSync(history, 'module.exports = {};');
  two(rangeGuard(fx, { branch: 'pedido', title: 'docs: a', body: '' }), /control de historia interna/, 'con el control roto');
  fs.writeFileSync(history, kept);

  // una corrida que no es de un pedido (a mano, sobre una rama): se miran los commits y la rama, y se DICE que no hubo
  // título ni cuerpo que mirar — callarlo se leería como «el título está limpio»
  const manual = rangeGuard(fx, { branch: 'pedido' });
  assertPassed(manual);
  assert.deepStrictEqual(manual.json.texts, { title: false, body: false });
  assert.match(rangeGuard(fx, { branch: 'pedido', args: [] }).stdout, /sin título ni cuerpo/);
  // y un rango vacío (la punta ya está en la base) pasa diciendo que no había commits
  const empty = rangeGuard(fx, { branch: 'main', head: git(fx.work, ['rev-parse', 'main']), title: 'x', body: '' });
  assertPassed(empty);
  assert.strictEqual(empty.json.looked.commits, 0);
  // sin el nombre de la rama (no se sabe): pasa lo demás, sin inventar un nombre que mirar
  assertPassed(rangeGuard(fx, { title: 'docs: a', body: '' }));
});

test('T67_PrNumber_InAGhTitle_AndInARefName_WithTheRealControl', (t) => {
  // Lo que la tanda F1 dejó para cuando el control de historia interna estuviera en el árbol: estas formas se miden
  // con el control de VERDAD, sin doble.
  const fx = lab(t);
  const real = require(path.join(REPO, HISTORY));
  assert.strictEqual(fs.readFileSync(path.join(fx.harness, HISTORY), 'utf8'), fs.readFileSync(path.join(REPO, HISTORY), 'utf8'), 'el laboratorio corre el control de verdad');
  assert.deepStrictEqual(real.scan('lo del PR 1234', 'message').map((f) => f.form), ['pr-number'], 'el contrato del control: scan(texto, zona) → formas');
  // «Pull request» con mayúscula sólo en la P también es la forma: en un nombre de ref, con cualquier separador
  const clean = commitOn(fx, 'base-limpia', { 'guides/a.md': 'limpio\n' }, 'fix: un arreglo');
  for (const name of ['Pull-request-1234', 'arreglo/Pull_request_1234', 'pULL-rEQUEST-1234', 'pull.requests.1234']) {
    git(fx.work, ['branch', '-f', name, clean]);
    assertBlocked(fx, guard(fx, branchLine(fx, name)), { category: 'historia-interna', place: /el nombre de la ref nº 1/, secret: ['1234'] });
    assert.strictEqual(guard(fx, branchLine(fx, name)).json.findings.find((f) => f.category === 'historia-interna').rule, 'pr-number', 'dice la forma, no el texto');
  }
  // en el título de un `gh pr create`, como lo llama la herramienta
  git(fx.work, ['remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git']);
  const hook = (command) => spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js')], {
    cwd: fx.work, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: fx.work }), encoding: 'utf8',
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, TYCON_PUBLISH_DENYLIST: fx.list },
  });
  for (const title of ['fix: lo que quedó del PR 1234', 'Sigue el Pull request 1234', 'cierra el pull request #1234']) {
    const r = hook(`gh pr create --title "${title}" --body "un cuerpo"`);
    assert.strictEqual(r.status, 2, `${title}\n${r.stderr}`);
    assert.match(r.stderr, /historia-interna\/pr-number/);
    assert.ok(!r.stderr.includes('1234'), 'ni el número aparece en la salida');
  }
  // los gemelos: un número de story, y un número que no tiene la forma de un pedido
  for (const title of ['feat(8.26): la tanda F2 de la story 8.26', 'fix: el caso 1234 del banco', 'docs: la versión 2026.10.10.2']) {
    const r = hook(`gh pr create --title "${title}" --body "un cuerpo"`);
    assert.strictEqual(r.status, 0, `${title}\n${r.stderr}`);
  }
  // y `status`, con el control en su lugar, dice que los números de pedido SE MIDEN (sin él decía que no: T22)
  const status = spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js'), 'status'], {
    cwd: fx.work, encoding: 'utf8',
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, TYCON_PUBLISH_DENYLIST: fx.list },
  });
  assert.match(status.stdout, /números de pedido: se miden/);
  assert.doesNotMatch(status.stdout, /números de pedido: NO/);
});

test('T57_LineFacts_TheVariablesThatMoveTheGuard_AreSeenQuotedAndTheWayPowerShellSetsThem', () => {
  // El freno de la sesión no deja correr un `push` ni un `gh` que publica junto a una variable que cambia de dónde
  // salen la lista o el freno, o la configuración con que git encuentra sus hooks. Mirando sólo `NOMBRE=` sin
  // comillas, `export "TYCON_GUIDES_DIR=…"; git push` y `$env:TYCON_GUIDES_DIR = …` salían con un freno ajeno.
  const g = require(path.join(REPO, 'scripts', 'hooks', 'public-push-guard.js'));
  const both = (cmd) => { const f = g.lineFacts(cmd); return f.sets && f.pushes; };
  for (const cmd of ['TYCON_GUIDES_DIR=/tmp/x git push', 'export "TYCON_GUIDES_DIR=/tmp/x"; git push origin rama', "export 'TYCON_HOME=/tmp/x' && \"git\" push",
    'TYCON_PUBLISH_DENYLIST=/tmp/l.json git "push" origin rama', "$env:TYCON_GUIDES_DIR = '/tmp/x'; git push", "$env:TYCON_HOME='/tmp/x'; git push",
    'Set-Item env:TYCON_PUBLISH_DENYLIST /tmp/l.json; git push', 'HOME=/tmp/otra git push origin rama', 'GIT_CONFIG_GLOBAL=/dev/null git push',
    'env GIT_CONFIG_GLOBAL=/dev/null XDG_CONFIG_HOME=/tmp git push', `git -c core.hooks${'Path'}=/dev/null push origin rama`]) {
    assert.ok(both(cmd), `tenía que verse: ${cmd}\n${JSON.stringify(g.lineFacts(cmd))}`);
  }
  // 🔴 …pero sólo cuando el empuje PUEDE ser del arnés: en un repo que se sabe que no lo es, esas variables junto a un
  // `push` no son asunto de este freno (frenarlas ahí era frenar a un repo de producto)
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ppg-prod-')));
  try {
    const sh = (dir, args) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf8', env: { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, HOME: dir } });
    const product = path.join(root, 'producto');
    const harness = path.join(root, 'arnes');
    for (const d of [product, harness]) { fs.mkdirSync(d); sh(d, ['init', '--quiet']); }
    sh(product, ['remote', 'add', 'origin', 'https://dev.azure.com/org-de-prueba/proyecto/_git/producto']);
    fs.mkdirSync(path.join(harness, 'scripts'));
    fs.writeFileSync(path.join(harness, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/sh\n');
    const cmd = 'HOME=/tmp/otra git push origin rama';
    assert.strictEqual(g.pushMayBeHarness(cmd, product, {}), false, 'un repo de producto, con remoto de Azure');
    assert.strictEqual(g.pushMayBeHarness(cmd, harness, {}), true, 'un clon del arnés');
    assert.strictEqual(g.pushMayBeHarness(cmd, root, {}), false, 'una carpeta que no es un repo');
    assert.strictEqual(g.pushMayBeHarness(cmd, path.join(root, 'no-existe'), {}), true, 'una carpeta de la que no se sabe');
    // y si la línea se va a otra carpeta o a otro repo, no se sabe: cuenta
    for (const elsewhere of ['cd ../arnes && HOME=/tmp/otra git push', 'HOME=/tmp/otra git -C ../arnes push', 'GIT_DIR=../arnes/.git HOME=/tmp/otra git push']) {
      assert.strictEqual(g.pushMayBeHarness(elsewhere, product, {}), true, elsewhere);
    }
    // de punta a punta, como lo llama la herramienta (en un proceso aparte: el freno deja constancia en la casa de quien corre)
    const hook = (cwd) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'hooks', 'public-push-guard.js')], {
      cwd, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, cwd }), encoding: 'utf8',
      env: { ...cleanEnv(), HOME: root, USERPROFILE: root, TYCON_HOME: path.join(root, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
    });
    assert.strictEqual(hook(product).status, 0, 'en el repo de producto no frena');
    assert.strictEqual(hook(harness).status, 2, 'en el clon del arnés, sí');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  // los gemelos: leer una de esas variables no es ponerla; y sin un `push` (ni un `gh`) no hay nada que frenar
  for (const cmd of ['echo "$HOME" && git push origin rama', 'ls "$TYCON_HOME"; git push', 'git push origin rama', 'cd "$HOME/clon" && git push']) {
    assert.strictEqual(g.lineFacts(cmd).sets, false, cmd);
  }
  assert.strictEqual(g.lineFacts('TYCON_GUIDES_DIR=/tmp/x node scripts/tests/algo.test.js').pushes, false);
});

test('T57_WhereAGhRuns_AFolderThatIsNotThere_OrThatTheShellLooksUpElsewhere_IsUnknown', (t) => {
  const fx = lab(t);
  const g = require(path.join(REPO, 'scripts', 'hooks', 'public-push-guard.js'));
  const c = (cds, extra = {}) => ({ cds, cdIncierto: false, cwdDesconocido: false, ...extra });
  fs.mkdirSync(path.join(fx.root, 'esta'));
  assert.strictEqual(g.whereItRuns(fx.root, c(['esta']), {}).dir, path.join(fx.root, 'esta'));
  assert.deepStrictEqual(g.whereItRuns(fx.root, c(['esta']), {}).candidates, [path.join(fx.root, 'esta')]);
  // no está: el `cd` va a fallar (o la arma la terminal). Leída como «una carpeta que no es un clon», el pedido salía
  const gone = g.whereItRuns(fx.root, c(['no-esta']), {});
  assert.strictEqual(gone.dir, null);
  assert.ok(gone.candidates.includes(fx.root), 'y entre las candidatas sigue la carpeta de antes');
  // con CDPATH, un nombre suelto se busca primero en otras carpetas: aunque acá exista, no se sabe
  assert.strictEqual(g.whereItRuns(fx.root, c(['esta']), { CDPATH: '/otra' }).dir, null);
  assert.strictEqual(g.whereItRuns(fx.root, c(['./esta']), { CDPATH: '/otra' }).dir, path.join(fx.root, 'esta'), 'con ./ no se busca en CDPATH');
  // un `cd` que puede fallar sin cortar la línea: las dos carpetas
  assert.deepStrictEqual(g.whereItRuns(fx.root, c(['esta'], { cdIncierto: true }), {}).candidates, [fx.root, path.join(fx.root, 'esta')]);
});

// ── AC 54: el freno de `gh`, cuando el evento no se puede leer (el resto de ese freno se mide en el banco de controles) ──

test('T57_HookMode_AnEventItCannotRead_IsSaid_AndWithAPublishingGhInSight_DoesNotRun', (t) => {
  // Para la herramienta sólo el código 2 frena. Un evento que no es JSON, o que no trae el comando donde siempre,
  // pasaba con código 0 y sin una línea: todo `gh` salía sin mirar y nadie se enteraba.
  const fx = lab(t);
  const hook = (stdin) => spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js')], {
    cwd: fx.work, input: stdin, encoding: 'utf8',
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, TYCON_PUBLISH_DENYLIST: fx.list },
  });
  const event = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: fx.work });
  // no es JSON, y su texto trae un `gh` que publica: no corre
  for (const raw of [`esto no es json: gh pr create --title "lo de ${TERM}"`, `{"tool_input":{"command":"gh issue comment 3 --body x"`, '["gh", "release", "create"]']) {
    const r = hook(raw);
    assert.strictEqual(r.status, 2, `${raw}\n${r.stderr}`);
    assert.match(r.stderr, /FRENADO/);
    assert.ok(!r.stderr.includes(TERM), 'ni así imprime el texto');
  }
  // no es JSON y no trae nada que publique: no frena (frenar todo por un evento raro apagaría el freno), y lo DICE
  for (const raw of ['esto no es json', '{"tool_input": 7}', 'null', '']) {
    const r = hook(raw);
    assert.strictEqual(r.status, 0, `${raw}\n${r.stderr}`);
    assert.match(r.stderr, /no freno, pero tampoco miré/, `calló con «${raw}»`);
  }
  // el gemelo: un evento bien formado sin `gh` pasa callado, y uno con un `gh` de lectura también
  for (const command of ['ls -la', 'gh pr view 12', '']) {
    const r = hook(event(command));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stderr, '', `no tenía nada que decir de «${command}»`);
  }
  // y la entrada que no se pudo leer (null) tampoco pasa callada
  const g = require(path.join(REPO, 'scripts', 'hooks', 'public-push-guard.js'));
  const unread = g.hookMode(null, {});
  assert.strictEqual(unread.code, 0);
  assert.match(unread.lines.join('\n'), /no pude leer la entrada/);
});

test('T57_GhFromAFolderGitWillNotOpen_IsNotAFolderThatIsNotAClone', (t) => {
  // «Esta carpeta no es un repo» es una respuesta; «git no pudo contestar» no. Un clon que git se niega a abrir (es
  // de otro dueño: pasa en un volumen montado o en un contenedor) se leía como «no es un clon», y el `gh` corrido
  // ahí —en el clon del arnés— salía sin mirar, con código 0 y sin una línea.
  const fx = lab(t);
  git(fx.work, ['remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git']);
  const hook = (command, env = {}, cwd = fx.work) => spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js')], {
    cwd, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), encoding: 'utf8',
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      TYCON_PUBLISH_DENYLIST: fx.list, ...env },
  });
  const dirty = `gh pr create --title "lo de ${TERM}" --body "un cuerpo"`;
  assert.strictEqual(hook(dirty).status, 2, 'el laboratorio: en el clon, con el término, frena');
  const refused = hook(dirty, { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' });
  if (/dubious ownership/i.test(spawnSync('git', ['-C', fx.work, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', LC_ALL: 'C' } }).stderr)) {
    assert.strictEqual(refused.status, 2, `git no quiso abrir el clon y el \`gh\` salió igual\n${refused.stderr}`);
    assert.ok(!refused.stderr.includes(TERM));
    // el gemelo: en esa misma situación, un texto limpio pasa (no se frena por no saber: se mira)
    assert.strictEqual(hook('gh pr create --title "limpio" --body "un cuerpo"', { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }).status, 0);
  } else t.diagnostic('este git no tiene la variable de prueba del dueño dudoso: el caso no se midió');
  // una carpeta que de verdad no es un repo sigue sin ser asunto del freno
  const nowhere = path.join(fx.root, 'suelta');
  fs.mkdirSync(nowhere);
  const g = require(path.join(REPO, 'scripts', 'hooks', 'public-push-guard.js'));
  assert.deepStrictEqual(g.repoAt(nowhere), { top: null, known: true });
  assert.strictEqual(g.repoAt(path.join(fx.root, 'no-existe')).known, false);
  assert.strictEqual(g.repoAt(fx.work).top, fx.work);
  // 🔴 En la máquina de alguien del equipo que NO mantiene (tiene el perfil, no tiene la lista), un `gh` de destino
  // desconocido no se frena por «sin la lista» —esa persona no puede cumplir la instrucción, y el `gh` puede ser de un
  // repo de producto—: se mira lo que no necesita lista, y se dice. Si se SABE que va al arnés, la lista sigue siendo
  // obligatoria.
  const noList = (command, cwd) => spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js')], {
    cwd, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), encoding: 'utf8',
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  });
  const unknownClean = noList('cd "$DESTINO" && gh pr create --title "un título" --body "un cuerpo"', nowhere);
  assert.strictEqual(unknownClean.status, 0, unknownClean.stderr);
  assert.match(unknownClean.stderr, /sin lista en esta máquina/);
  assert.strictEqual(noList(`cd "$DESTINO" && gh pr create --title "x" --body "con ${TOKEN}"`, nowhere).status, 2, 'un secreto se frena igual, sin lista');
  const known = noList('gh pr create --title "un título" --body "un cuerpo"', fx.work);
  assert.strictEqual(known.status, 2, 'en el clon del arnés la lista es obligatoria');
  assert.match(known.stderr, /sin la lista/);
  // el repo de la sesión no tapa un repo que el comando nombra y no se puede leer (desde una carpeta que no es un clon)
  const blurry = hook(`gh pr comment 12 --repo "$R" --body "lo de ${TERM}"`, { GH_REPO: 'otra-org/otro-repo' }, nowhere);
  assert.strictEqual(blurry.status, 2, blurry.stderr);
  // el gemelo: con ese repo de la sesión y sin nombrar otro, el comando va a ese otro repo y no es asunto del freno
  assert.strictEqual(hook(`gh pr comment 12 --body "lo de ${TERM}"`, { GH_REPO: 'otra-org/otro-repo' }, nowhere).status, 0);
  // la sesión habla con otro servidor (GH_HOST), o trae un GH_REPO que no se sabe leer: no se sabe a dónde va → se mira
  for (const env of [{ GH_HOST: 'github.otra.test' }, { GH_REPO: 'esto no es un repo' }]) {
    assert.strictEqual(hook(`gh pr comment 12 --body "lo de ${TERM}"`, env, nowhere).status, 2, JSON.stringify(env));
    assert.strictEqual(hook('gh pr comment 12 --body "limpio"', env, nowhere).status, 0, `limpio, con ${JSON.stringify(env)}`);
  }
  // Un «remoto» sin dirección no es un remoto (git lista uno cuando la configuración trae una sección con ese nombre y
  // nada más): tomarlo por «no pude leer los remotos» frenaba todo `gh` de ese repo
  git(fx.work, ['config', 'remote.fantasma.prune', 'true']);
  assert.strictEqual(hook('gh pr create --title "limpio" --body "un cuerpo"').status, 0, 'con un remoto sin dirección, el limpio pasa');
  assert.strictEqual(hook(dirty).status, 2, 'y el que trae el término sigue frenado');
  // 🔴 El repo que el arnés DECLARA como suyo, en un arnés instalado (que no es un clon: no tiene un remoto propio que
  // leer). Ahí esa señal no se cumplía nunca: un `gh` que nombraba el repo público desde otra carpeta salía sin mirar.
  write(fx.harness, 'scripts/publishing/public-repos.json', `${JSON.stringify({ org: 'acme', repo: 'declarado' })}\n`);
  const named = `gh issue create --repo acme/declarado --title "bug" --body "lo de ${TERM}"`;
  assert.strictEqual(hook(named, {}, nowhere).status, 2, 'el repo declarado, nombrado desde una carpeta cualquiera');
  assert.strictEqual(hook('gh issue create --repo acme/declarado --title "bug" --body "limpio"', {}, nowhere).status, 0);
  assert.strictEqual(hook(`gh issue create --repo acme/otra-cosa --title "bug" --body "lo de ${TERM}"`, {}, nowhere).status, 0, 'otro repo no es asunto del freno');
});

// El commit de merge de un pedido lo escribe el skill con `gh pr merge --subject … --body-file …`. Su título es
// «asunto (#N)»: el número al final. La forma «<verbo en pasado> PR N: asunto» —la de un merge hecho en otro servidor— es
// historia interna por su forma, y el freno la frena desde el pedido de tres cifras: con ella, el skill no podría mergear.
test('T18_MergeSubject_TopicThenNumber_Passes_AndTheOtherServersFormIsInternalHistory', (t) => {
  const fx = lab(t);
  git(fx.work, ['remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git']);
  const hook = (command, env = {}, cwd = fx.work) => spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js')], {
    cwd, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), encoding: 'utf8',
    env: { ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      TYCON_PUBLISH_DENYLIST: fx.list, ...env },
  });
  write(fx.root, 'cuerpo-del-merge.md', 'feat(x): una cosa\n\nEl detalle del cambio.\n');
  const body = path.join(fx.root, 'cuerpo-del-merge.md').split(path.sep).join('/');
  const number = ['4', '1', '2'].join('');   // de tres cifras, armado por partes: este archivo viaja en la copia
  const merge = (subject) => `gh pr merge ${number} --repo acme/widgets --merge --match-head-commit ${'a'.repeat(40)} --subject "${subject}" --body-file ${body}`;
  const ours = hook(merge(`feat(x): una cosa (#${number})`));
  assert.strictEqual(ours.status, 0, `el título del skill tiene que pasar\n${ours.stderr}`);
  const theirs = hook(merge(`${['Merged', 'PR'].join(' ')} ${number}: feat(x): una cosa`));
  assert.strictEqual(theirs.status, 2, 'la forma del otro servidor, con tres cifras, es historia interna');
  assert.ok(!theirs.stderr.includes(number), 'el mensaje dice dónde, nunca el texto');
  // Los otros dos `gh` que el skill escribe, en la forma de su paso para GitHub: cada uno solo en su llamada, el texto
  // entre comillas SIMPLES y el cuerpo por archivo. El freno los tiene que LEER (si no los lee, no salen) y dejar pasar.
  const create = (title) => `gh pr create --repo 'acme/widgets' --base 'main' --head 'feat/x' --title ${title} --body-file '${body}'`;
  const created = hook(create("'feat(x): una cosa'"));
  assert.strictEqual(created.status, 0, `el gh pr create del skill tiene que pasar\n${created.stderr}`);
  const edited = hook(`gh pr edit ${number} --repo 'acme/widgets' --title 'feat(x): una cosa' --body-file '${body}'`);
  assert.strictEqual(edited.status, 0, `el gh pr edit del skill tiene que pasar\n${edited.stderr}`);
  // un asunto que NOMBRA una sustitución: entre comillas simples es texto y se lee; entre dobles lo armaría la terminal
  assert.strictEqual(hook(create("'arregla $(algo) en el lector'")).status, 0, 'entre comillas simples, un «$(…)» es texto');
  assert.strictEqual(hook(create('"arregla $(algo) en el lector"')).status, 2, 'entre comillas dobles no se puede leer: no sale');
  assert.strictEqual(hook(create(`'lo de ${TERM}'`)).status, 2, 'y el título se mira: con un término de la lista no sale');
  // y el cuerpo también se mira: es el archivo que el comando nombra
  write(fx.root, 'cuerpo-del-merge.md', `feat(x): una cosa\n\nlo de ${TERM}\n`);
  assert.strictEqual(hook(merge(`feat(x): una cosa (#${number})`)).status, 2, 'un cuerpo con un término de la lista no sale');
  assert.strictEqual(hook(create("'feat(x): una cosa'")).status, 2, 'tampoco el del pedido');
});

// ── Tanda H1c (AC 65 f) · T79: el aviso de la lista atrasada ─────────────────────────────────────────────────────
// El freno lee la lista del disco de un clon (el de mantenimiento, el que la máquina mantiene, el arnés que corre) y
// nunca miraba si ese clon estaba al día. El caso (2026-10-10): una lista 36 commits atrás de su remoto frenó a quien
// mantiene por su propia firma, que una excepción ya publicada dejaba pasar. Lo que se mide acá:
//   · que lo AVISE —al empujar (pase o frene), en `status`—, con tres medidas: el archivo del disco contra el de la rama
//     principal remota como la conoce el clon, la edad de la última traída, y (sólo al empujar o con `status --fetch`)
//     lo que contesta el remoto;
//   · que el aviso sea eso: el veredicto y el código de un empuje son los MISMOS con y sin atraso;
//   · que lleve sólo cuentas y la ruta del clon: nunca el asunto de un commit ni el nombre de una rama del repo privado.
// El laboratorio: un «remoto» desnudo del repo de mantenimiento, una copia de quien publica en él, y el clon de
// mantenimiento que la máquina declara. La rama principal lleva una palabra marcadora en su nombre, y los commits en su
// asunto: si una de las dos aparece en una salida, el aviso está citando lo que no puede.
const MARK = 'Xilofago77';                 // inventado
const MAINT_MAIN = `principal-${MARK}`;
const LIST_REL = 'scripts/publishing/denylist.json';
const T79 = 'T79 MaintainerMachine_CommitLooksWithMachineList_DoctorNamesGuard_HooksPathElsewhereWarned_StaleListWarned';

function maintLab(t, { main = MAINT_MAIN } = {}) {
  const fx = lab(t);
  Object.assign(fx, { main, maintRemote: path.join(fx.root, 'interno.git'), author: path.join(fx.root, 'autor'), maint: path.join(fx.root, 'mantenimiento') });
  git(fx.root, ['init', '--quiet', '--bare', `--initial-branch=${main}`, fx.maintRemote]);
  git(fx.root, ['init', '--quiet', `--initial-branch=${main}`, fx.author]);
  writeList(path.join(fx.author, LIST_REL), TERM);
  git(fx.author, ['add', '-A']);
  git(fx.author, ['commit', '--quiet', '-m', 'base']);
  git(fx.author, ['remote', 'add', 'origin', fx.maintRemote]);
  git(fx.author, ['push', '--quiet', 'origin', main]);
  git(fx.root, ['clone', '--quiet', fx.maintRemote, fx.maint]);
  git(fx.maint, ['fetch', '--quiet', 'origin']);   // una traída de recién (un clon nuevo no deja constancia de ninguna)
  fs.writeFileSync(path.join(fx.home, '.tycon', 'config.json'), JSON.stringify({ paths: { maintainers: fx.maint } }));
  fx.listFile = path.join(fx.maint, LIST_REL);
  return fx;
}
/** `n` commits nuevos en el remoto de mantenimiento; cada uno cambia la lista (una excepción más), o no la toca. */
function publishToMaint(fx, n, { changeList = true } = {}) {
  const allowed = [];
  for (let i = 0; i < n; i += 1) {
    allowed.push({ archivo: `guides/caso-${i}.md`, patron: TERM, motivo: `una excepción de la prueba (${i})` });
    if (changeList) writeList(path.join(fx.author, LIST_REL), TERM, { permitidos: allowed });
    else write(fx.author, `notas/nota-${Date.now()}-${i}.md`, 'sin tocar la lista\n');
    git(fx.author, ['add', '-A']);
    git(fx.author, ['commit', '--quiet', '-m', `${MARK}: el asunto del commit ${i}`]);
  }
  git(fx.author, ['push', '--quiet', 'origin', fx.main]);
}
const labEnv = (fx, extra = {}) => ({ ...cleanEnv(), HOME: fx.home, USERPROFILE: fx.home, TYCON_HOME: path.join(fx.home, '.tycon'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
  GIT_ALLOW_PROTOCOL: 'file', ...extra });
function statusOf(fx, { args = [], env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js'), 'status', ...args], { cwd: fx.work, encoding: 'utf8', env: labEnv(fx, env) });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}
const freshnessOf = (fx, opts = {}, file = fx.listFile) => require(path.join(fx.harness, 'scripts/hooks/public-push-guard.js')).listFreshness(file, { env: labEnv(fx), ...opts });
const noMark = (text, what) => assert.ok(!String(text).includes(MARK), `${what} trae el asunto de un commit o el nombre de una rama del repo privado:\n${text}`);
const WARNING = /la lista .*sale de un clon atrasado/;

test(`${T79} — al día: no avisa, y status lo dice`, (t) => {
  const fx = maintLab(t);
  commitOn(fx, 'limpia', { 'guides/a.md': 'limpio\n' });
  const r = guard(fx, branchLine(fx, 'limpia'), { list: null });
  assertPassed(r);
  assert.strictEqual(r.json.list.source, 'maintainers');
  const f = r.json.list.freshness;
  assert.ok(f && f.measured === true, `tenía que medir la frescura de la lista: ${JSON.stringify(r.json.list)}`);
  assert.deepStrictEqual([f.differs, f.behind, f.fetchedDaysAgo, f.remoteAsked, f.remoteAhead], [false, 0, 0, true, false]);
  assert.strictEqual(f.clone, fx.maint);
  const plain = guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] });
  assert.strictEqual(plain.status, 0);
  assert.doesNotMatch(plain.stderr, WARNING, 'con la lista al día no avisa nada');
  const s = statusOf(fx);
  assert.match(s.stdout, /la lista está al día/);
  assert.doesNotMatch(s.stdout, WARNING);
  noMark(r.all + plain.all + s.all, 'la salida');
  // commits que NO tocan la lista, traídos sin fusionar: el clon está atrás, pero la lista que lee es la del remoto
  publishToMaint(fx, 2, { changeList: false });
  git(fx.maint, ['fetch', '--quiet', 'origin']);
  const behind = freshnessOf(fx);
  assert.deepStrictEqual([behind.measured, behind.differs, behind.behind], [true, false, 2]);
  assert.doesNotMatch(guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] }).stderr, WARNING, 'atrás, con la misma lista: no es un aviso');
});

test(`${T79} — traído sin fusionar: «N atrás, la lista cambió», pase o frene, sin asuntos ni ramas`, (t) => {
  const fx = maintLab(t);
  publishToMaint(fx, 3);
  git(fx.maint, ['fetch', '--quiet', 'origin']);
  const f = freshnessOf(fx);
  assert.deepStrictEqual([f.measured, f.differs, f.behind], [true, true, 3]);
  // un empuje que PASA lo dice
  commitOn(fx, 'limpia', { 'guides/a.md': 'limpio\n' });
  const pass = guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] });
  assert.strictEqual(pass.status, 0, pass.all);
  assert.match(pass.stderr, WARNING);
  assert.match(pass.stderr, /3 commit\(s\) atrás de su rama principal remota, y la lista cambió/);
  assert.ok(pass.stderr.includes(fx.maint), 'nombra el clon por su ruta en esta máquina');
  assert.match(pass.stderr, /git -C .* pull/, 'dice cómo traerlo');
  // …y uno que FRENA, que es cuando más importa (la excepción que falta puede estar en esos commits)
  commitOn(fx, 'sucia', { 'guides/caso-0.md': `con ${TERM}\n` });
  const blocked = guard(fx, branchLine(fx, 'sucia'), { list: null, args: [] });
  assert.strictEqual(blocked.status, 1, blocked.all);
  assert.match(blocked.stderr, /EMPUJE FRENADO/);
  assert.match(blocked.stderr, WARNING);
  assert.match(blocked.stderr, /ya tiene su excepción/);
  const json = guard(fx, branchLine(fx, 'sucia'), { list: null });
  assert.strictEqual(json.json.list.freshness.behind, 3);
  // «no pude mirar» con la lista ya elegida: también lo dice
  const blind = guard(fx, branchLine(fx, 'sucia'), { list: null, args: [], env: { TYCON_PUBLIC_PUSH_LIMIT_MS: '0' } });
  assert.strictEqual(blind.status, 2, blind.all);
  assert.match(blind.stderr, WARNING);
  // status, sin salir a la red, también
  const s = statusOf(fx);
  assert.match(s.stdout, WARNING);
  assert.match(s.stdout, /3 commit\(s\) atrás/);
  // 🔴 sólo cuentas y la ruta del clon: ni el asunto de un commit ni el nombre de una rama del repo privado
  noMark(pass.all + blocked.all + json.all + blind.all + s.all + JSON.stringify(f), 'el aviso');
  assert.ok(!(pass.all + blocked.all + s.all).includes(TERM), 'ni un término de la lista');
  // traído y fusionado: deja de avisar
  git(fx.maint, ['merge', '--quiet', '--ff-only', `origin/${fx.main}`]);
  assert.doesNotMatch(guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] }).stderr, WARNING);
  assert.strictEqual(guard(fx, branchLine(fx, 'sucia'), { list: null }).status, 0, 'y con la lista de hoy, la excepción publicada deja pasar');
});

test(`${T79} — la lista del clon no se deja leer (un merge a medias): «no pude mirar», y dice que ese clon está atrasado`, (t) => {
  // traer el clon a medias es justo lo que deja una lista ilegible: las marcas de un conflicto adentro del archivo
  const fx = maintLab(t);
  publishToMaint(fx, 2);
  git(fx.maint, ['fetch', '--quiet', 'origin']);
  fs.writeFileSync(fx.listFile, '<<<<<<< HEAD\n{ "terminos": [] }\n=======\n');
  commitOn(fx, 'limpia', { 'guides/a.md': 'limpio\n' });
  const r = guard(fx, branchLine(fx, 'limpia'), { list: null });
  assert.strictEqual(r.status, 2, r.all);
  assert.strictEqual(r.json.verdict, 'blind');
  assert.match(r.json.reason, /no se puede leer/);
  assert.ok(r.json.list && r.json.list.freshness, `con la lista elegida, aunque no se deje leer, se mide su clon: ${JSON.stringify(r.json.list)}`);
  assert.deepStrictEqual([r.json.list.source, r.json.list.freshness.differs, r.json.list.freshness.behind], ['maintainers', true, 2]);
  const plain = guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] });
  assert.strictEqual(plain.status, 2);
  assert.match(plain.stderr, /EMPUJE FRENADO — no pude mirar/);
  assert.match(plain.stderr, WARNING);
  assert.match(plain.stderr, /2 commit\(s\) atrás/);
  noMark(r.all + plain.all, 'el aviso');
  // el gemelo: una lista ilegible que no vive en un clon es «no pude mirar» igual, sin aviso que inventar
  fs.writeFileSync(fx.list, '{ roto');
  const loose = guard(fx, branchLine(fx, 'limpia'), { args: [] });
  assert.strictEqual(loose.status, 2, loose.all);
  assert.doesNotMatch(loose.stderr, WARNING);
});

test(`${T79} — nadie trajo el clon: sin preguntarle al remoto no se ve; el empuje y status --fetch sí`, (t) => {
  const fx = maintLab(t);
  publishToMaint(fx, 4);   // el remoto avanzó y el clon no se enteró: es la forma del caso real
  const offline = freshnessOf(fx);
  assert.deepStrictEqual([offline.measured, offline.differs, offline.behind], [true, false, 0], 'sin red, el clon se ve al día consigo mismo');
  assert.strictEqual(offline.remoteAhead, undefined, 'sin askRemote no dice nada del remoto');
  assert.doesNotMatch(statusOf(fx).stdout, WARNING);
  const asked = freshnessOf(fx, { askRemote: true });
  assert.deepStrictEqual([asked.remoteAsked, asked.remoteAhead], [true, true]);
  commitOn(fx, 'limpia', { 'guides/a.md': 'limpio\n' });
  const push = guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] });
  assert.strictEqual(push.status, 0, push.all);
  assert.match(push.stderr, WARNING);
  assert.match(push.stderr, /su remoto tiene commits que este clon todavía no trajo/);
  const s = statusOf(fx, { args: ['--fetch'] });
  assert.match(s.stdout, /su remoto tiene commits que este clon todavía no trajo/);
  noMark(push.all + s.all + JSON.stringify(asked), 'el aviso');
  // preguntar no trae: el clon queda como estaba (el freno no escribe en el repo de nadie)
  assert.strictEqual(git(fx.maint, ['rev-list', '--count', `HEAD..origin/${fx.main}`]), '0');
});

test(`${T79} — el clon en una rama de trabajo, HEAD suelto o la lista editada a mano: la lista del disco no es la del remoto`, (t) => {
  const fx = maintLab(t);
  // parado en una rama de trabajo que cambió la lista (ningún commit atrás de la principal)
  git(fx.maint, ['checkout', '--quiet', '-b', `trabajo-${MARK}`]);
  writeList(fx.listFile, OTHER_TERM);
  git(fx.maint, ['add', '-A']);
  git(fx.maint, ['commit', '--quiet', '-m', `${MARK}: la lista de la rama`]);
  let f = freshnessOf(fx);
  assert.deepStrictEqual([f.measured, f.differs, f.behind], [true, true, 0]);
  const s = statusOf(fx);
  assert.match(s.stdout, WARNING);
  assert.match(s.stdout, /la lista del disco no es la de su rama principal remota/);
  commitOn(fx, 'limpia', { 'guides/a.md': 'limpio\n' });
  const push = guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] });
  assert.match(push.stderr, /la lista del disco no es la de su rama principal remota/);
  noMark(s.all + push.all + JSON.stringify(f), 'el aviso');
  // de vuelta en la principal: al día
  git(fx.maint, ['checkout', '--quiet', fx.main]);
  assert.strictEqual(freshnessOf(fx).differs, false);
  // HEAD suelto sobre un commit viejo, con la principal remota ya más adelante y traída
  publishToMaint(fx, 2);
  git(fx.maint, ['fetch', '--quiet', 'origin']);
  git(fx.maint, ['checkout', '--quiet', '--detach', 'HEAD']);
  f = freshnessOf(fx);
  assert.deepStrictEqual([f.measured, f.differs, f.behind], [true, true, 2]);
  git(fx.maint, ['checkout', '--quiet', fx.main]);
  git(fx.maint, ['merge', '--quiet', '--ff-only', `origin/${fx.main}`]);
  assert.strictEqual(freshnessOf(fx).differs, false);
  // editada a mano, sin commitear: 0 atrás y la lista ya no es la publicada
  writeList(fx.listFile, OTHER_TERM);
  f = freshnessOf(fx);
  assert.deepStrictEqual([f.measured, f.differs, f.behind], [true, true, 0]);
  assert.match(statusOf(fx).stdout, /la lista del disco no es la de su rama principal remota/);
});

test(`${T79} — la última traída hace más de tres días: avisa por edad (y no, si el remoto contesta que no hay nada nuevo)`, (t) => {
  const fx = maintLab(t);
  const fetchHead = path.join(fx.maint, '.git', 'FETCH_HEAD');
  const daysAgo = (n) => { const at = new Date(Date.now() - n * 86400000 - 60000); fs.utimesSync(fetchHead, at, at); };
  daysAgo(2);
  let f = freshnessOf(fx);
  assert.strictEqual(f.fetchedDaysAgo, 2);
  assert.doesNotMatch(statusOf(fx).stdout, WARNING, 'dos días no es un aviso');
  // el borde: «pasados 3 días». A las 71 horas todavía no; con 3 días cumplidos, sí (avisaba recién al cuarto día
  // completo: la cuenta es un piso en días enteros y se comparaba con «más de 3»)
  const hoursAgo = (n) => { const at = new Date(Date.now() - n * 3600000); fs.utimesSync(fetchHead, at, at); };
  hoursAgo(71);
  assert.doesNotMatch(statusOf(fx).stdout, WARNING, '71 horas no son 3 días');
  daysAgo(3);
  f = freshnessOf(fx);
  assert.strictEqual(f.fetchedDaysAgo, 3);
  assert.match(statusOf(fx).stdout, /la última traída fue hace 3 día\(s\)/, 'con 3 días cumplidos ya avisa');
  daysAgo(5);
  f = freshnessOf(fx);
  assert.deepStrictEqual([f.measured, f.differs, f.behind, f.fetchedDaysAgo], [true, false, 0, 5]);
  const s = statusOf(fx);
  assert.match(s.stdout, WARNING);
  assert.match(s.stdout, /la última traída fue hace 5 día\(s\)/);
  // al empujar se le pregunta al remoto: si contesta que no tiene nada nuevo, la edad de la traída ya no dice nada
  commitOn(fx, 'limpia', { 'guides/a.md': 'limpio\n' });
  assert.doesNotMatch(guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] }).stderr, WARNING);
  // …y si no contesta (una dirección que no existe), la edad es lo único que hay: avisa
  git(fx.maint, ['remote', 'set-url', 'origin', path.join(fx.root, 'no-existe.git')]);
  const unanswered = guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] });
  assert.strictEqual(unanswered.status, 0, unanswered.all);
  assert.match(unanswered.stderr, /la última traída fue hace 5 día\(s\)/);
  // un clon que nunca trajo nada (recién clonado): no hay fecha, y no se inventa una
  fs.rmSync(fetchHead);
  f = freshnessOf(fx);
  assert.deepStrictEqual([f.measured, f.fetchedDaysAgo], [true, null]);
  assert.doesNotMatch(statusOf(fx).stdout, WARNING);
});

test(`${T79} — sin rama principal remota, o la lista fuera de un clon: no se mide, y status lo dice`, (t) => {
  const fx = maintLab(t);
  // sin `origin/HEAD`: se usa `origin/main` si existe; con otro nombre de rama principal y sin esa referencia, no se mide
  git(fx.maint, ['remote', 'set-head', 'origin', '--delete']);
  let f = freshnessOf(fx);
  assert.strictEqual(f.measured, false);
  assert.match(f.why, /rama principal remota/);
  const s = statusOf(fx);
  assert.match(s.stdout, /no pude medir si la lista está al día: .*rama principal remota/);
  noMark(s.all + JSON.stringify(f), 'el motivo');
  // una carpeta que no es un clon de git (la lista suelta que nombra TYCON_PUBLISH_DENYLIST)
  f = freshnessOf(fx, {}, fx.list);
  assert.strictEqual(f.measured, false);
  assert.match(f.why, /no vive en un clon de git/);
  assert.match(statusOf(fx, { env: { TYCON_PUBLISH_DENYLIST: fx.list } }).stdout, /no pude medir si la lista está al día: .*no vive en un clon de git/);
  // un archivo que no está, o cualquier otra cosa rara: «no se pudo medir», nunca una excepción
  assert.strictEqual(freshnessOf(fx, {}, path.join(fx.root, 'no', 'existe.json')).measured, false);
  // …y nada de esto cambia un empuje: pasa igual, sin aviso
  commitOn(fx, 'limpia', { 'guides/a.md': 'limpio\n' });
  const push = guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] });
  assert.strictEqual(push.status, 0, push.all);
  assert.doesNotMatch(push.stderr, WARNING);
  // con la rama principal llamada `main` y sin `origin/HEAD`: se mide contra `origin/main`
  const plain = maintLab(t, { main: 'main' });
  git(plain.maint, ['remote', 'set-head', 'origin', '--delete']);
  assert.strictEqual(freshnessOf(plain).measured, true);
});

test(`${T79} — el remoto de la lista no contesta: no cuelga, respeta su tope y el empuje sigue`, (t) => {
  const fx = maintLab(t);
  // un «ssh» que no contesta nunca: git queda esperándolo, y el tope lo corta
  const slow = path.join(fx.root, 'ssh-lento.sh');
  const pidFile = path.join(fx.root, 'ssh-lento.pid');
  const argsFile = path.join(fx.root, 'ssh-lento.args');
  fs.writeFileSync(slow, `#!/bin/sh\necho $$ >> '${pidFile.split(path.sep).join('/')}'\necho "$*" >> '${argsFile.split(path.sep).join('/')}'\nexec sleep 20\n`, { mode: 0o755 });
  // el tope mata a git, no a lo que git lanzó: lo que quedó durmiendo es de esta prueba, y lo corta esta prueba
  const stopSleepers = () => {
    let pids = [];
    try { pids = fs.readFileSync(pidFile, 'utf8').split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 1); } catch (_) { pids = []; }
    for (const pid of pids) { try { process.kill(pid); } catch (_) { /* ya terminó */ } }
  };
  git(fx.maint, ['remote', 'set-url', 'origin', 'ssh://servidor.invalid/acme/interno.git']);
  const G = require(path.join(fx.harness, 'scripts/hooks/public-push-guard.js'));
  assert.ok(G.LIST_REMOTE_ANSWER_MS <= 10000, 'el tope de la pregunta al remoto de la lista es corto');
  const started = Date.now();
  let f;
  try {
    f = G.listFreshness(fx.listFile, { env: { ...labEnv(fx), GIT_ALLOW_PROTOCOL: 'ssh', GIT_SSH_COMMAND: slow.split(path.sep).join('/') }, askRemote: true, remoteMs: 1500 });
  } finally { stopSleepers(); }
  const took = Date.now() - started;
  assert.ok(took >= 1200, `volvió en ${took} ms: el remoto de juguete no llegó a colgar, y entonces este caso no mide el tope`);
  assert.ok(took < 8000, `tardó ${took} ms con un tope de 1500: quedó esperando al remoto`);
  assert.deepStrictEqual([f.measured, f.remoteAsked, f.differs, f.behind], [true, false, false, 0], 'que el remoto no conteste no es un error: se mide lo demás');
  assert.ok(f.remoteAhead === undefined || f.remoteAhead === null, 'y no se afirma nada del remoto');
  // 🔴 SIEMPRE sin interacción, también cuando la persona trae su propio GIT_SSH_COMMAND (acá, el «ssh» de juguete): sin
  // `BatchMode`, ssh puede pedir una clave o confirmar un host por la terminal en medio del empuje
  const sshArgs = fs.readFileSync(argsFile, 'utf8');
  assert.match(sshArgs, /-oBatchMode=yes/, `al comando de ssh de la persona le faltó BatchMode: ${sshArgs}`);
  // un empuje con el remoto de la lista caído (una dirección que no existe): mismo veredicto, sin aviso inventado
  git(fx.maint, ['remote', 'set-url', 'origin', path.join(fx.root, 'no-existe.git')]);
  commitOn(fx, 'sucia', { 'guides/a.md': `con ${TERM}\n` });
  const blocked = guard(fx, branchLine(fx, 'sucia'), { list: null });
  assertBlocked(fx, blocked, { category: 'cliente' });
  assert.strictEqual(blocked.json.list.freshness.remoteAsked, false);
  assert.doesNotMatch(guard(fx, branchLine(fx, 'sucia'), { list: null, args: [] }).stderr, WARNING);
});

test(`${T79} — es un aviso: el veredicto y el código de un empuje son los mismos con y sin atraso`, (t) => {
  const fx = maintLab(t);
  commitOn(fx, 'sucia', { 'guides/a.md': `con ${TERM}\n` });
  commitOn(fx, 'limpia', { 'guides/b.md': 'limpio\n' });
  const hooks = path.join(fx.root, 'hooks-globales');
  fs.mkdirSync(hooks);
  git(fx.work, ['config', 'core.hooksPath', hooks]);
  fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/usr/bin/env bash\n# git-pre-push-global.sh\nexit 0\n', { mode: 0o755 });
  const picture = () => {
    const dirty = guard(fx, branchLine(fx, 'sucia'), { list: null });
    const clean = guard(fx, branchLine(fx, 'limpia'), { list: null });
    return { dirty: [dirty.status, dirty.json.verdict, dirty.json.findings], clean: [clean.status, clean.json.verdict, clean.json.findings], status: statusOf(fx).status,
      warned: WARNING.test(guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] }).stderr) };
  };
  const fresh = picture();
  assert.deepStrictEqual([fresh.dirty[0], fresh.dirty[1], fresh.clean[0], fresh.clean[1], fresh.status, fresh.warned], [1, 'findings', 0, 'pass', 0, false]);
  // el remoto suma commits que NO cambian qué frena la lista (una excepción para otro archivo), traídos sin fusionar,
  // y la traída envejece: el aviso aparece, y todo lo demás queda igual
  publishToMaint(fx, 3);
  git(fx.maint, ['fetch', '--quiet', 'origin']);
  const at = new Date(Date.now() - 9 * 86400000);
  fs.utimesSync(path.join(fx.maint, '.git', 'FETCH_HEAD'), at, at);
  const stale = picture();
  assert.strictEqual(stale.warned, true, 'con el clon atrasado, avisa');
  assert.deepStrictEqual({ ...stale, warned: null }, { ...fresh, warned: null }, 'el atraso no cambia ni un veredicto ni un código (ni el de status)');
  // un empuje a un remoto que no es público, o que no es del arnés, no mide nada (no hay lista elegida)
  const local = guard(fx, branchLine(fx, 'limpia'), { list: null, url: fx.localUrl });
  assert.deepStrictEqual([local.status, local.json.verdict, local.json.list], [0, 'skip', null]);
  // el pedido en su validación (el modo de rango) tampoco: ahí la lista llega por variable
  const inClone = path.join(fx.maint, LIST_REL);
  const range = rangeGuard(fx, { branch: 'limpia', list: inClone });
  assert.strictEqual(range.status, 0, range.all);
  assert.ok(!range.json.list.freshness, 'el modo de rango no mide la frescura');
  assert.doesNotMatch(rangeGuard(fx, { branch: 'limpia', list: inClone, args: [] }).all, WARNING);
});

// ── T79 · lo que encontraron los revisores y el pase adversarial de la tanda H1c ─────────────────────────────────
// Cada caso de acá salía mal: el aviso desaparecía, decía algo que no era, o —el primero— la lista salía del propio
// árbol que se empuja. Las pruebas con que se confirmó cada uno son la base de estos casos.

/** La misma carpeta con su último tramo en OTRAS mayúsculas, si el disco no las distingue (la Mac por defecto,
 *  Windows); null si las distingue —ahí otra caja es otra carpeta, y no hay nada que medir— o si no se pudo comprobar. */
function otherCase(dir) {
  const other = path.join(path.dirname(dir), path.basename(dir).toUpperCase());
  if (other === dir) return null;
  try { return fs.statSync(other).ino === fs.statSync(dir).ino ? other : null; } catch (_) { return null; }
}
const NOT_MEASURED = 'NO MEDIDO: el disco del laboratorio distingue mayúsculas (otra caja es otra carpeta): no hay caso que medir';

test(`${T79} — la lista nombrada con otras mayúsculas (disco que no las distingue): se mide igual y el aviso sale`, (t) => {
  // `fs.realpathSync` no corrige la caja; git sí. La ruta relativa de la lista dentro de su clon salía con `..`, el
  // motivo decía «git no contestó» (falso) y el aviso de la lista atrasada desaparecía. Se llega con el comando
  // soportado: `config set paths.maintainers <ruta>` guarda la ruta como se tipeó.
  const fx = maintLab(t);
  const upper = otherCase(fx.maint);
  if (!upper) { t.skip(NOT_MEASURED); return; }
  publishToMaint(fx, 2);
  git(fx.maint, ['fetch', '--quiet', 'origin']);
  const exact = freshnessOf(fx);
  assert.deepStrictEqual([exact.measured, exact.differs, exact.behind], [true, true, 2]);
  const variants = {
    'el clon en otra caja': path.join(upper, LIST_REL),
    'una carpeta de adentro en otra caja': path.join(fx.maint, 'Scripts', 'Publishing', 'denylist.json'),
    'un tramo de más arriba en otra caja': path.join(path.dirname(fx.root), path.basename(fx.root).toUpperCase(), 'mantenimiento', LIST_REL),
  };
  for (const [name, file] of Object.entries(variants)) {
    const f = freshnessOf(fx, {}, file);
    assert.deepStrictEqual([f.measured, f.why, f.differs, f.behind], [true, null, true, 2], `${name}: es el mismo archivo del disco, y tiene que dar la misma medida`);
  }
  // de punta a punta: la máquina declara su clon con otra caja
  fs.writeFileSync(path.join(fx.home, '.tycon', 'config.json'), JSON.stringify({ paths: { maintainers: upper } }));
  commitOn(fx, 'limpia', { 'guides/a.md': 'limpio\n' });
  const push = guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] });
  assert.strictEqual(push.status, 0, push.all);
  assert.match(push.stderr, WARNING);
  assert.match(push.stderr, /2 commit\(s\) atrás/);
  assert.match(statusOf(fx).stdout, WARNING);
});

test(`${T79} — la lista nunca sale del árbol que se empuja, lo nombre la máquina con las mayúsculas que sea`, (t) => {
  // «Está adentro del árbol que se empuja» se decidía letra por letra: con `paths.maintained`/`paths.maintainers`
  // escritas en otra caja, el MISMO clon no se reconocía y la rama elegía con qué lista se la mira.
  const fx = lab(t);
  const upper = otherCase(fx.work);
  if (!upper) { t.skip(NOT_MEASURED); return; }
  // el árbol que se empuja trae una lista PROPIA, adelgazada: con ella, el término de la lista de verdad pasa
  writeList(path.join(fx.work, LIST_REL), OTHER_TERM);
  commitOn(fx, 'sucia', { 'guides/a.md': `con ${TERM}\n` });
  const declare = (paths) => fs.writeFileSync(path.join(fx.home, '.tycon', 'config.json'), JSON.stringify({ paths }));
  for (const [name, dir] of [['con su caja', fx.work], ['con otra caja', upper]]) {
    declare({ maintainers: dir });
    const declared = guard(fx, branchLine(fx, 'sucia'), { list: null });
    assert.strictEqual(declared.status, 2, `paths.maintainers ${name}: usó la lista del árbol que se empuja\n${declared.all}`);
    assert.match(declared.json.reason, /es el mismo árbol que se empuja/, `paths.maintainers ${name}`);
    declare({ maintained: dir });
    const maintained = guard(fx, branchLine(fx, 'sucia'), { list: null });
    assert.strictEqual(maintained.status, 2, `paths.maintained ${name}: usó la lista del árbol que se empuja\n${maintained.all}`);
    assert.match(maintained.json.reason, /sin la lista/, `paths.maintained ${name}`);
  }
});

test(`${T79} — un archivo que gh sube, nombrado con otras mayúsculas: la excepción de su ruta vale igual`, (t) => {
  // el mismo patrón en otro sitio del freno: la ruta del archivo dentro del repo (con la que la lista decide sus
  // excepciones) se sacaba comparando letra por letra
  const fx = lab(t);
  write(fx.work, 'guides/a.md', `un ejemplo con ${TERM}\n`);
  if (!otherCase(path.join(fx.work, 'guides'))) { t.skip(NOT_MEASURED); return; }
  git(fx.work, ['remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git']);
  const hook = (command) => spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js')], {
    cwd: fx.work, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: fx.work }), encoding: 'utf8', env: labEnv(fx, { TYCON_PUBLISH_DENYLIST: fx.list }),
  });
  const upload = (file) => hook(`gh release upload v1 ${file} --repo acme/widgets`);
  // sin la excepción frena, se escriba como se escriba
  for (const file of ['guides/a.md', 'GUIDES/a.md']) assert.strictEqual(upload(file).status, 2, `sin excepción, ${file} no sale`);
  // con la excepción para ESA ruta del repo, pasa — también nombrada con otra caja (es el mismo archivo)
  writeList(fx.list, TERM, { permitidos: [{ archivo: 'guides/a.md', patron: TERM, motivo: 'un ejemplo de la prueba' }] });
  for (const file of ['guides/a.md', 'GUIDES/a.md', 'guides/A.MD']) {
    const r = upload(file);
    assert.strictEqual(r.status, 0, `con la excepción de guides/a.md, ${file} tenía que pasar\n${r.stderr}`);
  }
});

test(`${T79} — una traída que FALLA no es una traída: se dice, y la edad no vuelve a cero`, (t) => {
  // git vacía `FETCH_HEAD` antes de conectarse: una traída fallida lo deja en 0 bytes y con fecha de hoy. Leída como
  // «última traída: hoy», el aviso por edad no salía nunca justo con el remoto inalcanzable.
  const fx = maintLab(t);
  const fetchHead = path.join(fx.maint, '.git', 'FETCH_HEAD');
  publishToMaint(fx, 2);   // el remoto avanzó y este clon no se enteró
  const old = new Date(Date.now() - 30 * 86400000);
  fs.utimesSync(fetchHead, old, old);
  git(fx.maint, ['remote', 'set-url', 'origin', path.join(fx.root, 'no-existe.git')]);
  assert.strictEqual(freshnessOf(fx).fetchedDaysAgo, 30);
  git(fx.maint, ['fetch', '--quiet', 'origin'], { tolerate: true });   // falla: el remoto no está
  assert.strictEqual(fs.statSync(fetchHead).size, 0, 'la premisa del caso: git deja FETCH_HEAD vacío cuando la traída falla');
  const f = freshnessOf(fx);
  assert.deepStrictEqual([f.measured, f.fetchFailed, f.fetchedDaysAgo], [true, true, null]);
  const s = statusOf(fx);
  assert.match(s.stdout, /la última traída de ese clon falló/);
  assert.doesNotMatch(s.stdout, /hace 0 día/);
  // también al empujar (el remoto de la lista no contesta), sin cambiar el veredicto
  commitOn(fx, 'limpia', { 'guides/a.md': 'limpio\n' });
  const push = guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] });
  assert.strictEqual(push.status, 0, push.all);
  assert.match(push.stderr, /la última traída de ese clon falló: no sé si la lista está al día/);
  noMark(s.all + push.all + JSON.stringify(f), 'el aviso');
  // si el remoto vuelve y contesta que no tiene nada nuevo, aquella traída fallida ya no dice nada
  git(fx.maint, ['remote', 'set-url', 'origin', fx.maintRemote]);
  git(fx.maint, ['fetch', '--quiet', 'origin']);
  git(fx.maint, ['merge', '--quiet', '--ff-only', `origin/${fx.main}`]);
  fs.writeFileSync(fetchHead, '');
  assert.doesNotMatch(guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] }).stderr, /la última traída de ese clon falló/);
  // la traída de OTRO remoto tampoco es la de la rama principal de la lista: no se cuenta como «traído hoy»
  const other = path.join(fx.root, 'otro.git');
  git(fx.root, ['init', '--quiet', '--bare', `--initial-branch=${fx.main}`, other]);
  git(fx.author, ['push', '--quiet', other, `${fx.main}:${fx.main}`]);
  git(fx.maint, ['remote', 'add', 'otro', other]);
  git(fx.maint, ['fetch', '--quiet', 'origin']);
  fs.utimesSync(fetchHead, old, old);
  assert.strictEqual(freshnessOf(fx).fetchedDaysAgo, 30);
  git(fx.maint, ['fetch', '--quiet', 'otro']);
  const afterOther = freshnessOf(fx);
  assert.strictEqual(afterOther.fetchedDaysAgo, null, `la traída de otro remoto se contó como la del remoto de la lista: ${JSON.stringify(afterOther)}`);
  assert.doesNotMatch(statusOf(fx).stdout, /última traída: hace 0 día/);
});

test(`${T79} — el clon de la lista ADELANTE de su remoto (una excepción sin subir): no es «atrasado» ni se arregla con pull`, (t) => {
  const fx = maintLab(t);
  // en su rama principal, una excepción commiteada en la lista y sin subir
  writeList(fx.listFile, TERM, { permitidos: [{ archivo: 'guides/a.md', patron: TERM, motivo: 'una excepción todavía sin subir' }] });
  git(fx.maint, ['add', '-A']);
  git(fx.maint, ['commit', '--quiet', '-m', `${MARK}: una excepción`]);
  let f = freshnessOf(fx);
  assert.deepStrictEqual([f.measured, f.differs, f.behind, f.ahead], [true, true, 0, 1]);
  const G = require(path.join(fx.harness, 'scripts/hooks/public-push-guard.js'));
  let text = G.freshnessText(f);
  assert.strictEqual(text.level, 'warn');
  assert.match(text.text, /tiene cambios que su remoto todavía no tiene/);
  assert.match(text.text, /1 commit\(s\) sin subir/);
  assert.doesNotMatch(text.text, /atrasad/);
  commitOn(fx, 'limpia', { 'guides/b.md': 'limpio\n' });
  const push = guard(fx, branchLine(fx, 'limpia'), { list: null, args: [] });
  assert.strictEqual(push.status, 0, push.all);
  assert.match(push.stderr, /tiene cambios que su remoto todavía no tiene/);
  assert.match(push.stderr, /git -C .* push/, 'la salida que sirve es subirlos');
  assert.doesNotMatch(push.stderr, /atrasad|pull/, 'ni «atrasado» ni «pull»: traerlo no cambia nada');
  const s = statusOf(fx);
  assert.match(s.stdout, /tiene cambios que su remoto todavía no tiene/);
  assert.doesNotMatch(s.stdout, /atrasad|pull/);
  noMark(push.all + s.all + JSON.stringify(f), 'el aviso');
  // adelante Y atrás: las dos cuentas
  publishToMaint(fx, 2);
  git(fx.maint, ['fetch', '--quiet', 'origin']);
  f = freshnessOf(fx);
  assert.deepStrictEqual([f.differs, f.behind, f.ahead], [true, 2, 1]);
  text = G.freshnessText(f);
  assert.match(text.text, /2 commit\(s\) atrás/);
  assert.match(text.text, /1 commit\(s\) (propios )?sin subir/);
  // lo que no es ese caso sigue diciéndose como antes: en otra rama, o con la lista tocada a mano
  git(fx.maint, ['checkout', '--quiet', '-b', `trabajo-${MARK}`]);
  assert.doesNotMatch(G.freshnessText(freshnessOf(fx)).text, /tiene cambios que su remoto todavía no tiene/, 'en una rama de trabajo no es «subilos»');
  // un conteo que git no pudo hacer (null) no es «cero atrás»: sin saber cuántos faltan no se dice «sólo falta subir»
  // (cazador de fallos silenciosos, vuelta 2)
  const unknownBehind = G.freshnessText({ measured: true, why: null, clone: '/tmp/clon', differs: true, behind: null, ahead: 2, edited: false, onMain: true, fetchedDaysAgo: 0, fetchFailed: false });
  assert.notStrictEqual(unknownBehind.kind, 'ahead', 'sin poder contar lo de atrás, no afirma que el clon sólo está adelante');
  assert.strictEqual(unknownBehind.level, 'warn');
});

test(`${T79} — medir no ejecuta nada de lo que el clon de la lista configure, ni depende de sus fines de línea`, (t) => {
  const fx = maintLab(t);
  const marker = path.join(fx.root, 'se-ejecuto.txt');
  const planted = path.join(fx.root, 'plantado.sh');
  fs.writeFileSync(planted, `#!/bin/sh\necho "$0 $*" >> '${marker.split(path.sep).join('/')}'\ncat\n`, { mode: 0o755 });
  const plantedCommand = planted.split(path.sep).join('/');
  publishToMaint(fx, 1);
  git(fx.maint, ['fetch', '--quiet', 'origin']);
  commitOn(fx, 'limpia', { 'guides/a.md': 'limpio\n' });
  // un filtro `clean` para la lista (lo corre todo lo que calcule la huella del archivo del disco) y un vigía del
  // sistema de archivos (lo corre todo lo que refresque el índice): los dos, configurados en el clon AJENO
  git(fx.maint, ['config', 'filter.plantado.clean', plantedCommand]);
  fs.writeFileSync(path.join(fx.maint, '.git', 'info', 'attributes'), `${LIST_REL} filter=plantado\n`);
  git(fx.maint, ['config', 'core.fsmonitor', plantedCommand]);
  fs.rmSync(marker, { force: true });   // (lo que haya corrido el armado del laboratorio no cuenta)
  // un `git` testigo: cada llamada sobre ese clon tiene que apagar el vigía y el protocolo `ext`
  const bin = path.join(fx.root, 'testigo');
  const log = path.join(fx.root, 'git-testigo.log');
  fs.mkdirSync(bin);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: cleanEnv() }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log.split(path.sep).join('/')}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}${path.delimiter}${cleanEnv().PATH}` };
  const push = guard(fx, branchLine(fx, 'limpia'), { list: null, args: [], env });
  assert.strictEqual(push.status, 0, push.all);
  assert.match(push.stderr, WARNING, 'y la medida sigue saliendo');
  const s = statusOf(fx, { args: ['--fetch'], env });
  assert.match(s.stdout, WARNING);
  // la medida sola, con el testigo: lo que anota son sólo sus llamadas
  fs.writeFileSync(log, '');
  const G = require(path.join(fx.harness, 'scripts/hooks/public-push-guard.js'));
  const f = G.listFreshness(fx.listFile, { env: labEnv(fx, env), askRemote: true });
  assert.deepStrictEqual([f.measured, f.differs, f.behind, f.remoteAsked], [true, true, 1, true]);
  assert.ok(!fs.existsSync(marker), `medir la lista ejecutó algo que el clon de la lista configura:\n${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
  const onClone = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.includes(`-C ${fx.maint}`));
  assert.ok(onClone.length >= 5, `el testigo no vio las llamadas sobre el clon de la lista:\n${fs.readFileSync(log, 'utf8')}`);
  for (const l of onClone) {
    assert.ok(l.includes('-c core.fsmonitor=false') && l.includes('-c protocol.ext.allow=never'), `una llamada a git sobre el clon de la lista va sin apagar el vigía o el protocolo ext: ${l.replace(fx.maint, '<clon>')}`);
    assert.ok(!/\bhash-object\b/.test(l), 'la lista del disco no se compara con hash-object (corre los filtros del clon)');
  }
  // …ni depende de los fines de línea: la misma lista con CRLF en el disco (un clon de Windows) no es «la lista cambió»
  git(fx.maint, ['config', '--unset', 'filter.plantado.clean']);
  git(fx.maint, ['merge', '--quiet', '--ff-only', `origin/${fx.main}`]);
  assert.strictEqual(freshnessOf(fx).differs, false);
  fs.writeFileSync(fx.listFile, fs.readFileSync(fx.listFile, 'utf8').replace(/\n/g, '\r\n'));
  assert.strictEqual(freshnessOf(fx).differs, false, 'sólo cambió el fin de línea: es la misma lista');
});

test(`${T79} — status: «git falló» no es «git no tiene carpeta global de hooks»`, { skip: process.platform === 'win32' ? 'el git de mentira es un guion de sh' : false }, (t) => {
  const fx = lab(t);
  const run = (env) => spawnSync(process.execPath, [path.join(fx.harness, 'scripts/hooks/public-push-guard.js'), 'status'], { cwd: fx.root, encoding: 'utf8', env: labEnv(fx, { TYCON_PUBLISH_DENYLIST: fx.list, ...env }) });
  // fuera de un repo y sin la clave: «git no tiene carpeta global de hooks», 1 (como siempre)
  const none = run({});
  assert.strictEqual(none.status, 1, none.stdout);
  assert.match(none.stdout, /git no tiene carpeta global de hooks/);
  // git contesta con un error al leer su configuración: no se sabe, y se dice eso (sigue siendo 1)
  const bin = path.join(fx.root, 'git-roto');
  fs.mkdirSync(bin);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: cleanEnv() }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$*" in *core.hooksPath*) echo "fatal: de mentira" >&2; exit 3 ;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const broken = run({ PATH: `${bin}${path.delimiter}${cleanEnv().PATH}` });
  assert.strictEqual(broken.status, 1, broken.stdout);
  assert.match(broken.stdout, /no pude leer la carpeta global de hooks de git/);
  assert.doesNotMatch(broken.stdout, /git no tiene carpeta global de hooks/);
  // sin git en la máquina: lo mismo (no «no tiene»)
  const nodeOnly = path.join(fx.root, 'solo-node');
  fs.mkdirSync(nodeOnly);
  fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
  const absent = run({ PATH: nodeOnly });
  assert.strictEqual(absent.status, 1, absent.stdout + absent.stderr);
  assert.match(absent.stdout, /no pude leer la carpeta global de hooks de git/);
});
