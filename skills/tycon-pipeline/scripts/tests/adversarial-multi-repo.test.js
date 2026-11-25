#!/usr/bin/env node
'use strict';
// adversarial-multi-repo.test.js — el pase adversarial mira el código de cada repo de la historia contra su propia base
// (historia 8.330).
//
// Caso: una historia con el código en dos repos. El pase recibía un solo repo y una sola base (la de `origin/main`):
// lo que la historia cambió en el otro repo no entraba a ninguna lente, y en un repo con `master` la base no existía.
//
//   T1  freeze-adversarial devuelve cada repo con su sello y su base, calculada después de traer el remoto
//   T2  un hermano con sólo `master` toma la base de `origin/master`; un repo sin rama principal sale con base nula y
//       su motivo, sin frenar
//   T2b la lista del pase: un repo sin base y con código frena el lanzamiento y se nombra; sin código queda afuera
//   T3  el pase con dos repos: cada lente caza en los dos, cada uno con su base, y el hallazgo dice en qué repo está
//   T4  `repo`, `base` y `files` sueltos: el pase de siempre, igual que una lista de uno
//   T5  al anotar, la base de cada repo se comprueba en su repo; un resultado viejo con un solo objeto, como hoy
//   T5b una lente sin base se comprueba en el repo que nombra, y un repo ajeno al pase es «otra carpeta»
//   T6  el cierre de un pase de dos repos compara los sellos repo por repo, como hoy
//   T9  el paso «Pase adversarial» le pasa al Workflow la lista de repos, dice de dónde sale cada base y que un repo con
//       código y sin rama principal no se lanza
//
// Correr: node --test adversarial-multi-repo.test.js < /dev/null (desde skills/tycon-pipeline/scripts/tests)

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}
// las copias congeladas son de sólo lectura: se devuelve el permiso antes de borrar
after(() => { for (const d of tmpDirs) { try { execFileSync('chmod', ['-R', 'u+w', d]); } catch { /* ya no está */ } fs.rmSync(d, { recursive: true, force: true }); } });

const FECHA = '2026-01-01T10:00:00';
function repoDeJuguete(nombre, archivos) {
  const repo = path.join(tmp(`amr-${nombre}-`), nombre);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  }).trim();
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  for (const [rel, txt] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), txt);
  }
  git('add', '.');
  git('commit', '-qm', 'inicio');
  return { repo, git };
}
// Un remoto `origin` (un repo vacío aparte) con la rama principal `rama` en el commit de ahora, y un commit más en la rama
// de trabajo. El repo no trae la rama del remoto: sólo la ve quien la trae (`git fetch`). Devuelve la base esperada.
function conRemoto(r, rama) {
  const remoto = path.join(tmp('amr-remoto-'), 'origen.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', rama, remoto]);
  r.git('remote', 'add', 'origin', remoto);
  r.git('push', '-q', 'origin', `HEAD:${rama}`);
  r.git('update-ref', '-d', `refs/remotes/origin/${rama}`);
  const base = r.git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(r.repo, 'trabajo.txt'), 'un commit de la rama de trabajo\n');
  r.git('add', '.');
  r.git('commit', '-qm', 'trabajo');
  return base;
}

// La corrida de juguete: la historia en un repo, el código en otro y un hermano (Front) con archivos declarados, con
// una HOME propia.
function corridaConHermano(sid) {
  const base = tmp('amr-corrida-');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  const front = repoDeJuguete('Front', { 'src/x.js': 'module.exports = 1;\n' });
  const historias = repoDeJuguete('historias', {
    'specs/story-9.9-repos.md': ['---', 'story: "9.9"', 'title: "repos"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '  - Front/src/x.js', '---',
      '# Story 9.9', '', '## Acceptance Criteria', '', '1. **Given** algo, **Then** resultado.', '', '### Tests', '',
      '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|', '| T1 | `a.caso1` | 1 | unit | x | y |', '',
      '## Tasks / Subtasks', '', '- [ ] Task 1: hacerlo (AC: 1)', '', '## Change Log', '', '- hoy: escrita', ''].join('\n'),
  });
  const codigo = repoDeJuguete('codigo', { 'src/a.js': 'module.exports = 1;\n' });
  fs.mkdirSync(path.join(codigo.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(codigo.repo, '.tycon', 'advisors.yaml'), `evidence:\n  companion_repos:\n    - ${path.relative(codigo.repo, front.repo)}\n`);
  codigo.git('add', '.');
  codigo.git('commit', '-qm', 'declara el hermano');
  const story = path.join(historias.repo, 'specs', 'story-9.9-repos.md');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off' };
  for (const k of ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID']) delete env[k];
  const correr = (script, args) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env, input: '', cwd: codigo.repo });
  const r = correr('pipeline.js', ['start', '--story', story, '--repo', codigo.repo, '--brief']);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  return { home, historias, codigo, front, story, sid, correr };
}
const salida = (r) => `${r.stdout}\n${r.stderr}`;
const congelar = (C) => {
  const r = C.correr('marker.js', ['freeze-adversarial']);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { r, json };
};
const delRepo = (json, repo) => ((json && json.repos) || []).find((x) => x.repo === repo);

// 🔴 mutación: calcular la base sin traer el remoto, o una sola base para todos los repos.
test('T1 FreezeAdversarial_ReposConSuBase: el repo de la corrida y el hermano tocado, cada uno con su sello y la base de su rama principal', () => {
  const C = corridaConHermano('s-amr-t1');
  const baseCodigo = conRemoto(C.codigo, 'main');
  const baseFront = conRemoto(C.front, 'main');
  const { r, json } = congelar(C);
  assert.strictEqual(r.status, 0, salida(r));
  for (const [repo, base] of [[C.codigo.repo, baseCodigo], [C.front.repo, baseFront]]) {
    const x = delRepo(json, repo);
    assert.ok(x, `devuelve ${repo}: ${r.stdout}`);
    assert.match(String(x.sello), /^[0-9a-f]{40,64}$/, 'con su sello');
    assert.strictEqual(x.sello, json.sellos[repo], 'el mismo sello que `sellos`');
    assert.strictEqual(x.base, base, `la base de ${path.basename(repo)} es el punto común con su rama principal, traída del remoto`);
  }
});

// 🔴 mutación: buscar sólo `origin/main`, o frenar el congelado por un repo sin rama principal.
test('T2 FreezeAdversarial_HermanoConMaster_SinRama_BaseNula: con sólo `master`, su base; sin rama principal, base nula con el motivo y sin frenar', () => {
  const C = corridaConHermano('s-amr-t2');
  conRemoto(C.codigo, 'main');
  const baseFront = conRemoto(C.front, 'master');
  const { r, json } = congelar(C);
  assert.strictEqual(r.status, 0, salida(r));
  assert.strictEqual(delRepo(json, C.front.repo).base, baseFront, 'la base del hermano sale de origin/master');
  // el repo de la historia no tiene remoto: sale igual, sin base y con el motivo
  const hist = delRepo(json, C.historias.repo);
  assert.ok(hist, `el repo de la historia también sale: ${r.stdout}`);
  assert.strictEqual(hist.base, null);
  assert.match(String(hist.sin_base), /origin/, `el motivo dice qué faltó: ${hist.sin_base}`);
});

// ── La lista del pase y el pase con varios repos ───────────────────────────────────────────────────────────────────
const FT = path.join(SCRIPTS, 'lib', 'frozen-tree.js');
const ft = () => require(FT);
const WFLITE = path.join(SCRIPTS, 'workflow-lite.js');
const WORKFLOW = path.join(SCRIPTS, 'adversarial-verify.workflow.js');

// 🔴 mutación: dejar afuera, callado, un repo con código y sin base (su código no lo revisa nadie), o frenar por uno
// sin código.
test('T2b PasoPase_RepoSinBase_ConCodigoNoLanza_SinCodigoSigue: con código y sin base frena y se nombra; sin código queda afuera', () => {
  const back = repoDeJuguete('Back', { 'src/a.js': 'module.exports = 1;\n' });
  const base = conRemoto(back, 'main');
  // lo no commiteado y lo nuevo también es el cambio; lo que no es código, no
  fs.writeFileSync(path.join(back.repo, 'src', 'a.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(back.repo, 'src', 'nuevo.js'), 'module.exports = 3;\n');
  fs.writeFileSync(path.join(back.repo, 'notas.md'), 'notas\n');
  const front = repoDeJuguete('Front', { 'src/x.js': 'module.exports = 1;\n' });
  const historias = repoDeJuguete('historias', { 'specs/s.md': '# historia\n' });
  const sello = (r) => ft().seal(r.repo).tree;
  const conBase = { repo: back.repo, sello: sello(back), base };
  const sinBaseConCodigo = { repo: front.repo, sello: sello(front), base: null, sin_base: 'el remoto no tiene rama principal (origin/HEAD, origin/main ni origin/master)' };
  const sinBaseSinCodigo = { repo: historias.repo, sello: sello(historias), base: null, sin_base: 'no se pudo traer origin' };
  const l = ft().listaDelPase([conBase, sinBaseConCodigo, sinBaseSinCodigo]);
  assert.deepStrictEqual(l.repos, [{ repo: back.repo, base, files: ['src/a.js', 'src/nuevo.js'] }], 'los archivos de código, relativos a su repo');
  assert.strictEqual(l.frenan.length, 1, JSON.stringify(l.frenan));
  assert.strictEqual(l.frenan[0].repo, front.repo);
  assert.match(l.frenan[0].motivo, /no tiene base: el remoto no tiene rama principal/);
  // lo que corre el paso: la salida de freeze-adversarial en un archivo
  const lista = (repos) => {
    const f = path.join(tmp('amr-lista-'), 'congelado.json');
    fs.writeFileSync(f, JSON.stringify({ sellos: {}, copias: {}, repos }));
    return spawnSync(process.execPath, [FT, 'lista-del-pase', f], { encoding: 'utf8' });
  };
  const frena = lista([conBase, sinBaseConCodigo, sinBaseSinCodigo]);
  assert.strictEqual(frena.status, 2, salida(frena));
  assert.match(frena.stderr, /el pase no se lanza: .*Front tiene código en el cambio y no tiene base/);
  const corre = lista([conBase, sinBaseSinCodigo]);
  assert.strictEqual(corre.status, 0, salida(corre));
  assert.deepStrictEqual(JSON.parse(corre.stdout).repos, [{ repo: back.repo, base, files: ['src/a.js', 'src/nuevo.js'] }], 'sin código queda afuera y el pase corre con los demás');
});

// Hallazgo del pase (traversal-completeness, false-negative-classification y false-positive-edge): la lista contaba
// como código sólo lo de code-files.js, sin `.sql` ni lo que suma la organización, y listaba archivos borrados, que no
// están en el sello ni en la copia.
// 🔴 mutación: volver a `isCode` solo, o sacar el filtro de borrados.
test('T2c ListaDelPase_CodigoComoElPorton_SinBorrados: cuenta `.sql` y las extensiones de la organización, y deja afuera lo borrado', () => {
  const back = repoDeJuguete('Back', { 'src/viejo.js': 'module.exports = 1;\n', 'src/queda.js': 'module.exports = 2;\n' });
  const base = conRemoto(back, 'main');
  fs.mkdirSync(path.join(back.repo, 'db'));
  fs.writeFileSync(path.join(back.repo, 'db', '001.sql'), 'select 1;\n');
  fs.mkdirSync(path.join(back.repo, 'lib'));
  fs.writeFileSync(path.join(back.repo, 'lib', 'm.ex'), 'defmodule M do end\n');
  fs.unlinkSync(path.join(back.repo, 'src', 'viejo.js'));
  const sello = ft().seal(back.repo).tree;
  // el árbol del arnés con una organización que suma `.ex`
  const arbol = tmp('amr-arbol-');
  fs.mkdirSync(path.join(arbol, 'scripts'));
  fs.writeFileSync(path.join(arbol, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(arbol, 'team-repos.json'), JSON.stringify({ version: 1,
    public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' },
    operations: { platform: 'github', org: 'acme', repo: 'o' }, stack: { code_extensions: ['.ex'] } }));
  const f = path.join(tmp('amr-lista-'), 'congelado.json');
  fs.writeFileSync(f, JSON.stringify({ sellos: {}, copias: {}, repos: [{ repo: back.repo, sello, base }] }));
  const r = spawnSync(process.execPath, [FT, 'lista-del-pase', f], { encoding: 'utf8', env: { ...process.env, TYCON_GUIDES_DIR: arbol, HOME: tmp('amr-casa-') } });
  assert.strictEqual(r.status, 0, salida(r));
  assert.deepStrictEqual(JSON.parse(r.stdout).repos[0].files, ['db/001.sql', 'lib/m.ex'], 'el `.sql` y la extensión de la organización, sin el borrado');
});

// Corre el pase con un doble de agente: el doble anota el pedido de cada cazador en `anotar`, contesta con la base de
// cada repo que nombra el pedido y, en la lente de completitud, devuelve `hallazgo` (si hay). El verificador de cada
// lente confirma lo que recibe.
function correrPase(args, { anotar, hallazgo = null }) {
  const dir = tmp('amr-pase-');
  const stub = path.join(dir, 'stub.js');
  fs.writeFileSync(stub, `
const fs = require('fs');
const prompt = process.env.TYCON_WFLITE_PROMPT || '';
const hallazgo = ${JSON.stringify(hallazgo)};
if (/VERIFICADOR DE LA LENTE/.test(prompt)) {
  const ids = [...prompt.matchAll(/^ID=(\\S+)$/gm)].map((m) => m[1]);
  console.log(JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: 'CONFIRMED', reasoning: 'reproducido', adjusted_severity: 'bug', probe_dir: '' })) }));
} else if (/LENTE: /.test(prompt)) {
  fs.appendFileSync(${JSON.stringify(anotar)}, prompt + '\\n=====\\n');
  const base = (prompt.match(/Devolvé base = "([^"]+)"/) || [])[1] || '';
  const bases = [...prompt.matchAll(/git -C (\\S+) cat-file -e ([0-9a-f]+)\\^\\{commit\\}/g)].map((m) => ({ repo: m[1], base: m[2], base_existe: true }));
  const carpeta = (prompt.match(/Creá la carpeta (\\S+)/) || [])[1] || '';
  const findings = /LENTE: completitud/.test(prompt) && hallazgo ? [hallazgo] : [];
  console.log(JSON.stringify({ lens: 'x', findings, base, bases, probe_dir: findings.length ? '' : carpeta }));
} else console.log('{}');
`);
  const out = path.join(dir, 'out.json');
  const env = { ...process.env, TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${stub}` };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [WFLITE, WORKFLOW, '--args', JSON.stringify(args), '--out', out], { encoding: 'utf8', env });
  assert.ok(fs.existsSync(out), `el pase no devolvió salida: ${r.stderr}`);
  const pedidos = fs.existsSync(anotar) ? fs.readFileSync(anotar, 'utf8').split('\n=====\n').filter((p) => p.trim()) : [];
  return { salida: JSON.parse(fs.readFileSync(out, 'utf8')), pedidos };
}
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 🔴 mutación: mirar sólo el primer repo de la lista, darle a todos la misma base, o perder el repo del hallazgo.
test('T3 AdversarialVerify_DosRepos_CadaLenteCazaEnLosDos: cada lente mira los dos repos con su base, y el hallazgo del hermano trae su repo', () => {
  const dir = tmp('amr-t3-');
  const back = path.join(dir, 'Back');
  const front = path.join(dir, 'Front');
  for (const d of [back, front]) fs.mkdirSync(d, { recursive: true });
  const baseBack = '1111111111111111111111111111111111111111';
  const baseFront = '2222222222222222222222222222222222222222';
  const selloBack = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const selloFront = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const copiaFront = path.join(dir, 'estado', 'frozen', 'sid', 'pase-1', 'Front');
  const anotar = path.join(dir, 'pedidos.txt');
  const hallazgo = { severity: 'bug', repo: front, file: 'src/x.js', line: 3, summary: 'el hermano devuelve 200 donde la historia pide 403', repro: 'GET /x sin permiso → 200', confidence: 'high' };
  const { salida: s, pedidos } = correrPase({
    repos: [{ repo: back, base: baseBack, files: ['src/a.js'] }, { repo: front, base: baseFront, files: ['src/x.js'] }],
    runDir: path.join(dir, 'run'), sellos: { [back]: selloBack, [front]: selloFront }, copias: { [front]: copiaFront },
  }, { anotar, hallazgo });
  assert.strictEqual(pedidos.length, 6, 'un cazador por lente, no uno por repo');
  for (const p of pedidos) {
    assert.ok(p.includes(`git -C ${back} cat-file -e ${baseBack}^{commit}`) && p.includes(`git -C ${front} cat-file -e ${baseFront}^{commit}`), 'cada base se comprueba en su repo');
    // el de la copia compara contra el sello; el otro, contra el árbol de trabajo
    assert.ok(p.includes(`git -C ${front} diff ${baseFront} ${selloFront}`), 'el hermano: su base contra su sello');
    assert.ok(p.includes(`git -C ${back} diff ${baseBack}`), 'el de la corrida: su base');
    assert.ok(p.includes(copiaFront), 'nombra la copia del hermano');
    assert.match(p, new RegExp(`${escapar(back)}[^\\n]*\\n(?:[^\\n]*\\n){0,3}\\s+- src/a\\.js`), 'los archivos de cada repo, debajo de su repo');
    assert.match(p, new RegExp(`${escapar(front)}[^\\n]*\\n(?:[^\\n]*\\n){0,3}\\s+- src/x\\.js`), 'los archivos de cada repo, debajo de su repo');
  }
  assert.strictEqual(s.medido, true, s.aviso);
  assert.strictEqual(s.confirmed.length, 1);
  assert.strictEqual(s.confirmed[0].repo, front, 'el hallazgo dice en qué repo está');
  assert.strictEqual(s.confirmed[0].file, 'src/x.js', 'y su archivo, relativo a ese repo');
  assert.strictEqual(s.detalle[0].repo, front);
  assert.deepStrictEqual(s.base_del_pase, [{ repo: back, base: baseBack }, { repo: front, base: baseFront }], 'la base de cada repo, para comprobarla al anotar');
});

// 🔴 mutación: cambiar el pedido o el resultado del pase de un solo repo al sumar la lista.
test('T4 AdversarialVerify_ArgsSueltos_ComoHoy: `repo`, `base` y `files` sueltos dan el pase de siempre, igual que una lista de uno', () => {
  const dir = tmp('amr-t4-');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const base = '0123456789abcdef0123456789abcdef01234567';
  const comun = { runDir: path.join(dir, 'run'), sellos: { [repo]: 'cccccccccccccccccccccccccccccccccccccccc' } };
  const sueltos = correrPase({ repo, base, files: ['src/f1.js'], ...comun }, { anotar: path.join(dir, 'a.txt') });
  const deUno = correrPase({ repos: [{ repo, base, files: ['src/f1.js'] }], ...comun }, { anotar: path.join(dir, 'b.txt') });
  assert.strictEqual(sueltos.pedidos.length, 6);
  // los cazadores corren en paralelo: el orden en que se anotan cambia de una corrida a otra
  assert.deepStrictEqual([...deUno.pedidos].sort(), [...sueltos.pedidos].sort(), 'el mismo pedido a cada cazador');
  for (const p of sueltos.pedidos) {
    assert.ok(p.includes(`Repo: ${repo}`) && p.includes(`Devolvé base = "${base}"`), 'el pedido de siempre');
    assert.ok(!/Repos de la historia/.test(p), 'sin la lista de varios repos');
  }
  const sinCorredor = (o) => { const { corredor, ...resto } = o; return resto; };
  assert.deepStrictEqual(sinCorredor(deUno.salida), sinCorredor(sueltos.salida), 'el mismo resultado');
  assert.strictEqual(sueltos.salida.medido, true, sueltos.salida.aviso);
  assert.deepStrictEqual(sueltos.salida.base_del_pase, { repo, base }, 'la base del pase de un repo, como hoy: un objeto');
});

// ── Al anotar: la base de cada repo, en su repo ────────────────────────────────────────────────────────────────────
const VERDICT = path.join(SCRIPTS, 'lib', 'adversarial-verdict.js');
const INVENTADA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
function dosRepos() {
  const back = repoDeJuguete('Back', { 'a.txt': 'a\n' });
  const front = repoDeJuguete('Front', { 'x.txt': 'x\n' });
  return { back, front, baseBack: back.git('rev-parse', 'HEAD'), baseFront: front.git('rev-parse', 'HEAD') };
}
const MEDIDAS = { confirmed: [], lentes: [{ lens: 'x', estado: 'medida', count: 1 }], detalle: [{ lens: 'x' }] };

// 🔴 mutación: comprobar sólo la primera base de la lista, o dejar de leer el objeto de un resultado viejo.
test('T5 AdversarialVerdict_BaseDeUnRepoNoEsta_NoMedido: la base inventada del hermano deja el pase no medido y lo nombra; el resultado viejo se lee como hoy', () => {
  const { medicionDelResultado } = require(VERDICT);
  const { back, front, baseBack, baseFront } = dosRepos();
  const bien = medicionDelResultado({ ...MEDIDAS, base_del_pase: [{ repo: back.repo, base: baseBack }, { repo: front.repo, base: baseFront }] });
  assert.strictEqual(bien.medido, true, bien.motivo);
  const mal = medicionDelResultado({ ...MEDIDAS, base_del_pase: [{ repo: back.repo, base: baseBack }, { repo: front.repo, base: INVENTADA }] });
  assert.strictEqual(mal.medido, false);
  assert.deepStrictEqual(mal.lentes_sin_medir, ['x']);
  assert.ok(mal.motivo.includes(`la base ${INVENTADA} no está en ${front.repo}`), mal.motivo);
  assert.match(mal.motivo, /rama principal/, 'pide la base de la rama principal de ese repo, no la de origin/main');
  // una segunda vuelta cuenta sólo si git confirma todas las bases
  const otraVez = { ...MEDIDAS, lentes: [{ ...MEDIDAS.lentes[0], otra_vez: true }] };
  assert.strictEqual(medicionDelResultado({ ...otraVez, base_del_pase: [{ repo: back.repo, base: baseBack }, { repo: front.repo, base: baseFront }] }).medido, true);
  // el resultado viejo: un objeto, como hoy
  assert.strictEqual(medicionDelResultado({ ...MEDIDAS, base_del_pase: { repo: back.repo, base: baseBack } }).medido, true);
  const viejoMal = medicionDelResultado({ ...MEDIDAS, base_del_pase: { repo: back.repo, base: INVENTADA } });
  assert.strictEqual(viejoMal.medido, false);
  assert.match(viejoMal.motivo, /no está en .* \(lo dice git\): ninguna lente pudo comparar.*relanzá con la base de git merge-base HEAD origin\/main/);
});

// 🔴 mutación: comprobar el `sin_base` del hermano en el repo de la corrida, o aceptar un repo que no es del pase.
test('T5b AdversarialVerdict_SinBasePorRepo: la lente sin base se comprueba en el hermano; un repo ajeno al pase es otra carpeta', () => {
  const { medicionDelResultado } = require(VERDICT);
  const { back, front, baseBack, baseFront } = dosRepos();
  const pase = [{ repo: back.repo, base: baseBack }, { repo: front.repo, base: baseFront }];
  const lente = (repo, base) => ({ lens: 'x', estado: 'sin-medir', count: 0, motivo: `su cazador dijo dos veces que la base ${base} no existe en ${repo}`, sin_base: { repo, base } });
  // la base del hermano está en el hermano (y no en el repo de la corrida): el cazador miró en otra carpeta
  const esta = medicionDelResultado({ confirmed: [], lentes: [lente(front.repo, baseFront)], base_del_pase: pase });
  assert.strictEqual(esta.medido, false);
  assert.ok(esta.motivo.includes(`git sí la encuentra en ${front.repo}: el cazador miró en otra carpeta`), esta.motivo);
  // una base que tampoco está en el hermano: se relanza con la de la rama principal del hermano
  const noEsta = medicionDelResultado({ confirmed: [], lentes: [lente(front.repo, INVENTADA)], base_del_pase: pase });
  assert.ok(noEsta.motivo.includes(`git tampoco la encuentra en ${front.repo}: relanzá con la base de la rama principal de ${front.repo}`), noEsta.motivo);
  assert.doesNotMatch(noEsta.motivo, /origin\/main/);
  // un repo que no es del pase: el cazador miró en otra carpeta, sin correr git ahí
  const ajeno = repoDeJuguete('Ajeno', { 'z.txt': 'z\n' });
  const fuera = medicionDelResultado({ confirmed: [], lentes: [lente(ajeno.repo, ajeno.git('rev-parse', 'HEAD'))], base_del_pase: pase });
  assert.ok(fuera.motivo.includes(`${ajeno.repo} no es un repo del pase: el cazador miró en otra carpeta`), fuera.motivo);
});

// 🔴 mutación: que la lista de bases del resultado cambie cómo se comparan los sellos al cerrar (un cambio del hermano
// después del lanzamiento que pasa sin que nadie lo vea).
test('T6 CierreDelPase_SellosPorRepo_Igual: con dos repos, un cambio del hermano después del lanzamiento frena el cierre como hoy', () => {
  const HERMANO = /el código de un repo hermano cambió/;
  const cerrar = (C, congelado) => {
    const f = path.join(tmp('amr-res-'), 'step-05b-adversarial.json');
    const base_del_pase = congelado.repos.filter((x) => x.base).map((x) => ({ repo: x.repo, base: x.base }));
    fs.writeFileSync(f, JSON.stringify({ confirmed: [], sellos: congelado.sellos, base_del_pase }));
    return C.correr('marker.js', ['mark-adversarial-result', '0', '--type', '5b', '--result', f, '--run', 'r1']);
  };
  const lanzar = (sid) => {
    const C = corridaConHermano(sid);
    conRemoto(C.codigo, 'main');
    conRemoto(C.front, 'main');
    const { r, json } = congelar(C);
    assert.strictEqual(r.status, 0, salida(r));
    assert.strictEqual(json.repos.filter((x) => x.base).length, 2, 'dos repos con su base');
    const l = C.correr('marker.js', ['mark-adversarial-launched', 'r1', '4']);
    assert.strictEqual(l.status, 0, salida(l));
    return { C, json };
  };
  const quieto = lanzar('s-amr-t6-quieto');
  assert.doesNotMatch(salida(cerrar(quieto.C, quieto.json)), HERMANO, 'sin cambios, el hermano no frena');
  const cambiado = lanzar('s-amr-t6-cambio');
  fs.writeFileSync(path.join(cambiado.C.front.repo, 'src', 'x.js'), 'module.exports = 2;\n');
  const r = cerrar(cambiado.C, cambiado.json);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), HERMANO);
  assert.match(salida(r), /Front: src\/x\.js$/m);
});

// 🔴 mutación: el paso sigue pasando `repo`, `files` y `base` sueltos, o calcula la base contra `origin/main` a mano.
test('T9 PasoPaseAdversarial_DiceRepos: el bloque del Workflow lleva `repos` de lista-del-pase, cada base de la rama principal, y un repo sin base no se lanza', () => {
  const paso = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-08-adversarial-pass.md'), 'utf8');
  const bloque = (paso.match(/```\nWorkflow\(\{[\s\S]*?\n```/) || [''])[0];
  assert.ok(bloque, 'el paso tiene el bloque del Workflow');
  assert.match(bloque, /^\s+repos:\s+<los `repos` que devolvió `frozen-tree\.js lista-del-pase`/m, 'el Workflow recibe la lista');
  assert.match(bloque, /\{ "repo": "<abs>", "base": "<hash>", "files": \[/, 'cada entrada con su repo, su base y sus archivos');
  assert.doesNotMatch(bloque, /^\s+(repo|files|base):/m, 'sin `repo`, `files` ni `base` sueltos');
  assert.doesNotMatch(bloque, /merge-base HEAD origin\/main/, 'la base no se calcula a mano contra origin/main');
  assert.match(paso, /frozen-tree\.js lista-del-pase <RUN_DIR>\/congelado\.json/, 'cómo se arma la lista');
  assert.match(paso, /rama principal: la de `origin\/HEAD`, `origin\/main` u\s+`origin\/master`/, 'de dónde sale cada base');
  assert.match(paso, /\*\*Sale 2 si un repo con código no tiene base\*\*[\s\S]{0,120}el pase no se\s+lanza/, 'un repo con código y sin base no se lanza');
  // el lanzamiento temprano del paso 06 arma la lista igual
  const paso06 = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-06-run-tests.md'), 'utf8');
  assert.match(paso06, /frozen-tree\.js lista-del-pase <RUN_DIR>\/congelado\.json/);
});
