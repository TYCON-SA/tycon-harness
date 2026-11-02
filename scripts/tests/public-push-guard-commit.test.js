'use strict';
/**
 * public-push-guard-commit.test.js — el freno de publicación dentro del control del commit.
 *
 * Corre `git commit` de verdad, con el freno como gancho `pre-commit`, en un repo descartable con su `origin` público y una
 * lista inventada: lo que entra en cada commit lo dice git, no una lectura del comando.
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 *
 * stable-data: no lee el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const GUARD = path.join(REPO, 'scripts', 'hooks', 'public-push-guard.js');
const SO = require(path.join(REPO, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'save-ok.js'));

// armados acá: escritos de corrido, este archivo —que viaja en la copia— dispararía el detector que prueba
const LLAVE = `gh${'p'}_${'a1B2'.repeat(9)}`;
const TERMINO = ['nombre', 'inventado', 'de', 'prueba'].join('-');
const NOREPLY = '1+prueba@users.noreply.github.com';
const FRENADO = /COMMIT FRENADO/;

function lab(t, { esPublico = true, lista = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ppgc-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publico = path.join(root, 'publico');
  fs.mkdirSync(publico);
  const remoto = path.join(publico, 'remoto.git');
  const hooks = path.join(root, 'hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/usr/bin/env bash\nexec "${process.execPath}" "${GUARD}" pre-commit\n`, { mode: 0o755 });
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline'), { recursive: true });
  const archivoLista = path.join(root, 'lista.json');
  fs.writeFileSync(archivoLista, JSON.stringify({ terminos: [{ patron: TERMINO, categoria: 'cliente' }], permitidos: [] }));
  const env = {
    ...Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'ComSpec', 'PATHEXT', 'LANG'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
    HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    // `lista: null` es una máquina sin lista declarada; `false`, una declarada que no está
    ...(lista === null ? {} : { TYCON_PUBLISH_DENYLIST: lista ? archivoLista : path.join(root, 'no-esta.json') }),
    ...(esPublico ? { TYCON_PUBLIC_PUSH_TREAT_AS_PUBLIC: publico } : {}),
  };
  const d = path.join(root, 'trabajo');
  const raw = (dir, args, extra = {}) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remoto], { env });
  spawnSync('git', ['init', '-q', '-b', 'main', d], { env });
  const git = (...args) => {
    const r = raw(d, args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('config', 'user.name', 'prueba');
  git('config', 'user.email', NOREPLY);
  const escribir = (rel, texto) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), texto); };
  escribir('scripts/install-tycon-hooks.sh', '#!/bin/sh\n');
  escribir('LEEME.md', 'hola\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('remote', 'add', 'origin', remoto);
  git('push', '-q', 'origin', 'main');
  git('config', 'core.hooksPath', hooks);
  git('checkout', '-q', '-b', 'trabajo');
  // un commit, como sale de git: `{ status, salida }`
  const commit = (...args) => { const r = raw(d, ['commit', '-q', ...args]); return { status: r.status, salida: `${r.stdout}${r.stderr}` }; };
  return { d, git, escribir, commit, env, raw, home, hooks };
}

test('DatoConFormaDeLlave_ConAddEnElMismoComando_FrenaElCommit', (t) => {
  // 🔴 mutación: mirar antes del `git add` no ve nada, y es la forma del 79 % de los commits.
  const l = lab(t);
  const antes = l.git('rev-parse', 'HEAD');
  l.escribir('LEEME.md', `${LLAVE}\n`);
  l.git('add', 'LEEME.md');
  const r = l.commit('-m', 'x');
  assert.strictEqual(r.status, 1, r.salida);
  assert.match(r.salida, FRENADO);
  assert.match(r.salida, /\[secreto\/token-github\] LEEME\.md/);
  assert.ok(!r.salida.includes(LLAVE), 'la salida no trae lo encontrado');
  assert.doesNotMatch(r.salida, /\(commit [0-9a-f]+\)/, 'el commit armado no existe en la historia de nadie');
  assert.strictEqual(l.git('rev-parse', 'HEAD'), antes, 'el commit no se hizo');
});

test('NombreDeLaLista_FrenaElCommit', (t) => {
  // 🔴 mutación: un freno que mira sólo los secretos deja salir un nombre, y el empuje frena después.
  const l = lab(t);
  l.escribir('LEEME.md', `hecho para ${TERMINO}\n`);
  l.git('add', 'LEEME.md');
  const r = l.commit('-m', 'x');
  assert.strictEqual(r.status, 1, r.salida);
  assert.ok(!r.salida.includes(TERMINO), 'la salida no trae lo encontrado');
});

test('SinNadaEncontrado_ElCommitPasaSinDecirNada', (t) => {
  // 🔴 mutación: un freno sobre un commit armado que frena por su propia identidad o su mensaje frena todo.
  const l = lab(t);
  l.escribir('LEEME.md', 'cambiado\n');
  l.git('add', 'LEEME.md');
  const r = l.commit('-m', 'x');
  assert.strictEqual(r.status, 0, r.salida);
  assert.strictEqual(r.salida, '');
});

test('AutorConCorreoReal_NoFrena_LoMiraElEmpuje', (t) => {
  // 🔴 mutación: git le exporta el autor al gancho en todo commit: sin pisarlo, un commit limpio frena por su autor, y el
  // chequeo previo del ok, que no recibe esas variables, da verde igual.
  const l = lab(t);
  l.git('config', 'user.email', 'alguien@ejemplo.invalid');
  l.escribir('LEEME.md', 'cambiado\n');
  l.git('add', 'LEEME.md');
  const r = l.commit('-m', 'x');
  assert.strictEqual(r.status, 0, r.salida);
  l.escribir('LEEME.md', 'cambiado otra vez\n');
  l.git('add', 'LEEME.md');
  const a = l.commit('--author', 'Otra <otra@ejemplo.invalid>', '-m', 'y');
  assert.strictEqual(a.status, 0, a.salida);
});

test('SinListaNiPerfil_NoMira', (t) => {
  // 🔴 mutación: mirar sin la lista frena en la CI pública lo que sus excepciones permiten: 16 de los últimos 40 merges.
  const l = lab(t, { lista: null });
  l.escribir('LEEME.md', `${LLAVE}\n`);
  l.git('add', 'LEEME.md');
  const r = l.commit('-m', 'x');
  assert.strictEqual(r.status, 0, r.salida);
  assert.strictEqual(r.salida, '');
});

test('ConDashA_MiraLoQueEntra', (t) => {
  // 🔴 mutación: mirar sólo el índice de la persona deja pasar lo que `-a` suma al commit.
  for (const args of [['-a', '-m', 'x'], ['-am', 'x'], ['-am"con espacios"'], ['--all', '-m', 'x']]) {
    const l = lab(t);
    l.escribir('LEEME.md', `${LLAVE}\n`);
    const r = l.commit(...args);
    assert.strictEqual(r.status, 1, `${args.join(' ')}: ${r.salida}`);
  }
});

test('ConRutasOAlias_MiraLoQueEntra', (t) => {
  // 🔴 mutación: leer las palabras del comando no ve las rutas ni lo que un alias suma.
  const l = lab(t);
  l.escribir('LEEME.md', `${LLAVE}\n`);
  assert.strictEqual(l.commit('-m', 'x', 'LEEME.md').status, 1);
  assert.strictEqual(l.commit('-m', 'x', '--', 'LEEME.md').status, 1);
  l.git('config', 'alias.cia', 'commit -a');
  assert.strictEqual(l.raw(l.d, ['cia', '-q', '-m', 'x']).status, 1);
});

test('LoNoPreparado_NoFrena', (t) => {
  // 🔴 mutación: mirar todo el disco frena un commit por lo que no lleva.
  const l = lab(t);
  l.escribir('limpio.js', '// limpio\n');
  l.git('add', 'limpio.js');
  l.escribir('LEEME.md', `${LLAVE}\n`);
  l.escribir('suelto.js', `const x = '${LLAVE}';\n`);
  const r = l.commit('-m', 'x');
  assert.strictEqual(r.status, 0, r.salida);
});

test('RemotoPrivado_NoMira', (t) => {
  // 🔴 mutación: mirar sin preguntar si el remoto es público le pone esta regla a todo repo.
  const l = lab(t, { esPublico: false });
  l.escribir('LEEME.md', `${LLAVE}\n`);
  l.git('add', 'LEEME.md');
  const r = l.commit('-m', 'x');
  assert.strictEqual(r.status, 0, r.salida);
});

test('SinOrigin_NoMira', (t) => {
  // 🔴 mutación: sin remoto no hay empuje que frenar.
  const l = lab(t);
  l.git('remote', 'remove', 'origin');
  l.escribir('LEEME.md', `${LLAVE}\n`);
  l.git('add', 'LEEME.md');
  assert.strictEqual(l.commit('-m', 'x').status, 0);
});

test('NoPudoMirar_ElCommitSigueConAviso', (t) => {
  // 🔴 mutación: frenar el commit por no poder mirar traba todo el trabajo; callarlo se ve igual que «limpio».
  const l = lab(t, { lista: false });
  l.escribir('LEEME.md', 'cambiado\n');
  l.git('add', 'LEEME.md');
  const r = l.commit('-m', 'x');
  assert.strictEqual(r.status, 0, r.salida);
  assert.match(r.salida, /no pude mirar lo que lleva este commit/);
});

test('ConAmend_ElArregloPasa', (t) => {
  // 🔴 mutación: mirar también el commit que se reemplaza frena el arreglo por lo que viene a sacar.
  const l = lab(t);
  l.git('config', '--unset', 'core.hooksPath');
  l.escribir('LEEME.md', `${LLAVE}\n`);
  l.git('add', 'LEEME.md');
  l.git('commit', '-q', '-m', 'con el dato');
  l.git('config', 'core.hooksPath', l.hooks);
  l.escribir('LEEME.md', 'sin el dato\n');
  l.git('add', 'LEEME.md');
  for (const forma of ['--amend', '--am']) {
    const r = l.commit(forma, '-m', 'ok');
    assert.strictEqual(r.status, 0, `${forma}: ${r.salida}`);
  }
});

test('DatoEnUnCommitAnterior_NoFrenaUnCommitAjeno', (t) => {
  // 🔴 mutación: mirar toda la historia sin empujar traba cualquier commit de la rama, y esto ya lo frena el empuje.
  const l = lab(t);
  l.git('config', '--unset', 'core.hooksPath');
  l.escribir('LEEME.md', `${LLAVE}\n`);
  l.git('add', 'LEEME.md');
  l.git('commit', '-q', '-m', 'con el dato');
  l.git('config', 'core.hooksPath', l.hooks);
  l.escribir('otro.js', '// otro\n');
  l.git('add', 'otro.js');
  assert.strictEqual(l.commit('-m', 'x').status, 0);
});

test('MergeConElDatoDelOtroLado_NoFrena', (t) => {
  // 🔴 mutación: armar el commit con un solo padre toma como nuevo todo lo que trae el otro lado, que ya está publicado.
  const l = lab(t);
  l.git('config', '--unset', 'core.hooksPath');
  l.git('checkout', '-q', 'main');
  l.escribir('publicado.js', `const x = '${LLAVE}';\n`);
  l.git('add', 'publicado.js');
  l.git('commit', '-q', '-m', 'ya publicado');
  l.git('checkout', '-q', 'trabajo');
  l.escribir('propio.js', '// propio\n');
  l.git('add', 'propio.js');
  l.git('commit', '-q', '-m', 'propio');
  l.git('config', 'core.hooksPath', l.hooks);
  l.git('merge', '-q', '--no-ff', '--no-commit', 'main');
  const r = l.commit('-m', 'merge main');
  assert.strictEqual(r.status, 0, r.salida);
});

test('MergeConUnDatoPropioResuelto_Frena', (t) => {
  // 🔴 mutación: no mirar un merge deja entrar lo que se escribió al resolverlo.
  const l = lab(t);
  l.git('checkout', '-q', 'main');
  l.escribir('otro.js', '// otro\n');
  l.git('add', 'otro.js');
  l.git('-c', `core.hooksPath=${os.devNull}`, 'commit', '-q', '-m', 'main');
  l.git('checkout', '-q', 'trabajo');
  l.escribir('propio.js', '// propio\n');
  l.git('add', 'propio.js');
  l.git('-c', `core.hooksPath=${os.devNull}`, 'commit', '-q', '-m', 'propio');
  l.git('merge', '-q', '--no-ff', '--no-commit', 'main');
  l.escribir('resuelto.js', `const x = '${LLAVE}';\n`);
  l.git('add', 'resuelto.js');
  assert.strictEqual(l.commit('-m', 'merge').status, 1);
});

test('NoAnotaEnElRegistroDeFrenos', (t) => {
  // 🔴 mutación: contar estas miradas como bloqueos cambia el número con que se decide si el freno se queda.
  const l = lab(t);
  l.escribir('LEEME.md', `${LLAVE}\n`);
  l.git('add', 'LEEME.md');
  assert.strictEqual(l.commit('-m', 'x').status, 1);
  assert.ok(!fs.existsSync(path.join(l.home, '.claude', '.tycon-pipeline', 'frenos.jsonl')));
});

test('ChequeoPrevioDelOk_Hallazgo_NoSeFirma_YSinPoderMirarTampoco', (t) => {
  // 🔴 mutación: un chequeo previo que no corre este control firma un ok que el empuje después frena; uno que toma «no pude
  // mirar» por verde, también.
  for (const [opts, texto, espera] of [[{}, `${LLAVE}\n`, /los controles del commit/], [{ lista: false }, 'cambiado\n', /los controles del commit/]]) {
    const l = lab(t, opts);
    l.escribir('LEEME.md', texto);
    const puestas = Object.fromEntries(['TYCON_PUBLISH_DENYLIST', 'TYCON_PUBLIC_PUSH_TREAT_AS_PUBLIC', 'HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map((k) => [k, process.env[k]]));
    for (const k of Object.keys(puestas)) process.env[k] = l.env[k];
    try {
      const r = SO.controlesDelCommit({ repos: [l.d] });
      assert.strictEqual(r.codigo, 2, r.motivo);
      assert.match(r.motivo, espera);
      assert.ok(!r.motivo.includes(LLAVE), 'el motivo no trae lo encontrado');
    } finally {
      for (const [k, v] of Object.entries(puestas)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }
});

test('ElControlDelCommitLoLlama', () => {
  // 🔴 mutación: un control con sus pruebas verdes que nadie llama no frena nada.
  const checks = fs.readFileSync(path.join(REPO, '.githooks', 'pre-commit-checks'), 'utf8');
  assert.match(checks, /node "\$PUBLISH_GUARD" pre-commit/);
});
