#!/usr/bin/env node
'use strict';
// frozen-tree.test.js — lo que se revisa, congelado (historia 8.161).
//
// Caso: los revisores leían la carpeta viva. Un cambio hecho después de la última vuelta llegaba al commit sin que
// nadie lo mirara, y nada comparaba lo revisado con lo que se guardaba. Ahora cada vuelta sella el árbol de cada repo
// (la huella de `git write-tree`), arma una copia de sólo lectura desde lo que git guardó en ese sello, y al guardar se
// compara lo revisado con lo que se guarda.
//
//   T1   sellar y congelar dos repos: sello completo, copia de sólo lectura fuera de los repos, nada del repo tocado
//   T11  sin poder sellar, frena con el motivo
//   T12  sin poder armar la copia, frena con el motivo
//   T15  (parte A) las copias se borran, también las de una corrida que ya no está abierta
//   T16  una copia alterada no coincide con su sello; los atributos de exportación no alteran el sello
//   T24-T27 el papeleo que escribe el cierre: la sección de seguimientos de los revisores y el
//        renglón de la historia en sprint-status.yaml no piden otra vuelta; otro renglón, otra sección o un sprint-status
//        que no se deja leer, sí
//   8.270 el papeleo de «Probar en vivo»: la marca DODRT-C8 de un criterio, el estado de una tanda y el guion de la
//        prueba en vivo que su registro nombra con la misma huella; el texto de un criterio y el código siguen contando
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/frozen-tree.test.js < /dev/null

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const ft = () => require(path.join(SCRIPTS, 'lib', 'frozen-tree.js'));
// La primera aparición de un texto literal, como `replace` con un texto; con corchetes, `replace` se lee como si el
// texto quisiera ser una expresión regular (CodeQL lo marca).
const reemplazarTexto = (s, de, a) => { const i = s.indexOf(de); return i < 0 ? s : s.slice(0, i) + a + s.slice(i + de.length); };

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}
// las copias son de sólo lectura: se devuelve el permiso antes de borrar
after(() => { for (const d of tmpDirs) { try { execFileSync('chmod', ['-R', 'u+w', d]); } catch { /* ya no está */ } fs.rmSync(d, { recursive: true, force: true }); } });

const FECHA = '2026-01-01T10:00:00';
function repoDeJuguete(nombre, archivos) {
  const repo = path.join(tmp(`ft-${nombre}-`), nombre);
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
// el sello de referencia: la misma forma que treeShaDe (copia del índice, add -A, write-tree), sin cortar
function selloDeReferencia(repo) {
  const d = tmp('ft-ref-');
  const gitDir = execFileSync('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  fs.copyFileSync(path.join(gitDir, 'index'), path.join(d, 'idx'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(d, 'idx') };
  execFileSync('git', ['-C', repo, 'add', '-A'], { env, stdio: 'ignore' });
  return execFileSync('git', ['-C', repo, 'write-tree'], { env, encoding: 'utf8' }).trim();
}
const listar = (dir) => {
  const out = [];
  const ir = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) ir(p); else out.push(path.relative(dir, p)); } };
  ir(dir);
  return out.sort();
};
const escribible = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };

test('T1 Freeze_SealsEachRepo_AndCopiesReadOnly @story-8.161 @ac-1 — sello completo y copia de sólo lectura por repo', () => {
  const historia = repoDeJuguete('historias', { 'specs/story-1.md': 'historia\n' });
  const codigo = repoDeJuguete('codigo', { 'src/a.js': 'module.exports = 1;\n', '.gitignore': 'node_modules/\n' });
  // cambios sin commitear: uno modificado y uno nuevo, y lo ignorado no entra
  fs.writeFileSync(path.join(codigo.repo, 'src', 'a.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(codigo.repo, 'src', 'nuevo.js'), 'module.exports = 3;\n');
  fs.mkdirSync(path.join(codigo.repo, 'node_modules'));
  fs.writeFileSync(path.join(codigo.repo, 'node_modules', 'x.js'), 'x\n');
  fs.writeFileSync(path.join(historia.repo, 'specs', 'story-1.md'), 'historia cambiada\n');
  const estado = (r) => ({ status: r.git('status', '--porcelain'), index: fs.readFileSync(path.join(r.repo, '.git', 'index')).toString('base64') });
  const antes = [estado(historia), estado(codigo)];
  const estadoDir = tmp('ft-estado-');
  for (const r of [historia, codigo]) {
    const s = ft().seal(r.repo);
    assert.ok(!s.error, s.error);
    assert.match(s.tree, /^[0-9a-f]{40}$/);
    assert.strictEqual(s.tree, selloDeReferencia(r.repo), 'el sello es el de treeShaDe, sin cortar');
    const dir = path.join(estadoDir, 'frozen', 's1', 'iter1', path.basename(r.repo));
    const f = ft().freeze(r.repo, s.tree, dir);
    assert.ok(!f.error, f.error);
    assert.strictEqual(f.copy, dir);
    assert.ok(!dir.startsWith(r.repo), 'la copia vive fuera del repo');
    assert.ok(!escribible(path.join(dir, listar(dir)[0])), 'sólo lectura');
  }
  const copiaCodigo = path.join(estadoDir, 'frozen', 's1', 'iter1', 'codigo');
  assert.deepStrictEqual(listar(copiaCodigo), ['.gitignore', 'src/a.js', 'src/nuevo.js']);
  assert.strictEqual(fs.readFileSync(path.join(copiaCodigo, 'src', 'a.js'), 'utf8'), 'module.exports = 2;\n');
  // el índice real y el árbol de trabajo, sin cambios
  assert.deepStrictEqual([estado(historia), estado(codigo)], antes);
});

test('T11 Freeze_TreeFails_Blocks @story-8.161 @ac-10 — sin poder sellar, el motivo en una línea', () => {
  const noRepo = tmp('ft-norepo-');
  const s = ft().seal(noRepo);
  assert.ok(s.error, 'sin repo no hay sello');
  assert.ok(!s.tree);
  assert.doesNotMatch(s.error, /\n/, 'una línea');
});

test('T12 Freeze_CopyFails_Blocks @story-8.161 @ac-11 — sin poder armar la copia, el motivo en una línea', () => {
  const r = repoDeJuguete('codigo', { 'src/a.js': '1\n' });
  const s = ft().seal(r.repo);
  const padre = tmp('ft-sinpermiso-');
  fs.chmodSync(padre, 0o500);
  try {
    const f = ft().freeze(r.repo, s.tree, path.join(padre, 'copia'));
    assert.ok(f.error, 'sin permiso no hay copia');
    assert.ok(!f.copy);
    assert.doesNotMatch(f.error, /\n/, 'una línea');
  } finally {
    fs.chmodSync(padre, 0o700);
  }
});

test('T16 Freeze_AlteredCopy_Blocks @story-8.161 @ac-16 — la copia alterada no coincide; los atributos de exportación no la alteran', () => {
  const r = repoDeJuguete('codigo', {
    'src/a.js': '1\n',
    'docs/interno.md': 'no se exporta\n',
    'src/version.js': '// $Format:%H$\n',
    '.gitattributes': 'docs/interno.md export-ignore\nsrc/version.js export-subst\n',
  });
  const s = ft().seal(r.repo);
  const dir = path.join(tmp('ft-estado-'), 'frozen', 's1', 'iter1', 'codigo');
  ft().freeze(r.repo, s.tree, dir);
  // sin tocar: vuelve a sellar igual, aunque haya export-ignore y export-subst
  assert.deepStrictEqual(ft().verify(r.repo, dir, s.tree), { ok: true });
  assert.ok(fs.existsSync(path.join(dir, 'docs', 'interno.md')), 'export-ignore no saca el archivo de la copia');
  // con el permiso devuelto y un archivo cambiado: no coincide, con el repo y el sello
  fs.chmodSync(path.join(dir, 'src', 'a.js'), 0o644);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), '2\n');
  const v = ft().verify(r.repo, dir, s.tree);
  assert.strictEqual(v.ok, false);
  assert.match(v.error, /la copia de la vuelta no coincide con su sello/);
  assert.ok(v.error.includes(s.tree) && v.error.includes(r.repo), v.error);
});

// ── La corrida de juguete: la historia en un repo, el código en otro, una HOME propia ──────────────────────────────
const { spawnSync } = require('child_process');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
// `antesDeArrancar(codigo)`: lo que el repo del código ya trae cuando arranca la corrida
// `declaraTambien`: archivos de más en `files_to_modify` (los de un repo hermano, con su nombre adelante: sólo los
// hermanos con archivos declarados se sellan)
function corrida(sid, { masHistorias = {}, antesDeArrancar = null, declaraTambien = [] } = {}) {
  const base = tmp('ft-corrida-');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  const historias = repoDeJuguete('historias', {
    'specs/story-9.9-sello.md': ['---', 'story: "9.9"', 'title: "sello"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', ...declaraTambien.map((f) => `  - ${f}`), '---',
      '# Story 9.9', '', '## Acceptance Criteria', '', '1. **Given** algo, **Then** resultado.', '', '### Tests', '',
      '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|', '| T1 | `a.caso1` | 1 | unit | x | y |', '',
      '## Tasks / Subtasks', '', '- [ ] Task 1: hacerlo (AC: 1)', '', '## Change Log', '', '- hoy: escrita', ''].join('\n'),
    'tasks/todo.md': '- nada\n',
    ...masHistorias,
  });
  const codigo = repoDeJuguete('codigo', { 'src/a.js': 'module.exports = 1;\n', 'src/b.js': 'module.exports = 2;\n' });
  const story = path.join(historias.repo, 'specs', 'story-9.9-sello.md');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off' };
  for (const k of ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID']) delete env[k];
  const correr = (script, args) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env, input: '', cwd: codigo.repo });
  const estado = () => [path.join(home, '.tycon', 'state'), path.join(home, '.claude', '.tycon-pipeline')].find((d) => fs.existsSync(path.join(d, 'active')));
  const marcador = () => JSON.parse(fs.readFileSync(path.join(estado(), 'active', `${sid}.json`), 'utf8'));
  if (antesDeArrancar) antesDeArrancar(codigo);
  const r = correr('pipeline.js', ['start', '--story', story, '--repo', codigo.repo, '--brief']);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const vuelta = (iter = 1) => {
    const v = correr('pipeline.js', [iter > 1 ? 'smart-reloop' : 'advisors', '--story', story, '--repo', codigo.repo, '--files', 'src/a.js', '--iter', String(iter)]);
    return { r: v, json: (() => { try { return JSON.parse(v.stdout); } catch { return {}; } })() };
  };
  return { home, historias, codigo, story, sid, correr, estado, marcador, vuelta };
}
const salida = (r) => `${r.stdout}\n${r.stderr}`;

test('T2 Freeze_ContextFileNamesTheCopy @story-8.161 @ac-1 — el contexto de los revisores nombra la copia y el sello', () => {
  const C = corrida('s-ft2');
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'a.js'), 'module.exports = 10;\n');
  const { r, json } = C.vuelta();
  assert.strictEqual(r.status, 0, salida(r));
  assert.ok(Array.isArray(json.frozen) && json.frozen.length === 2, salida(r));
  const ctx = fs.readFileSync(json.context_file, 'utf8');
  for (const f of json.frozen) {
    assert.match(f.tree, /^[0-9a-f]{40}$/);
    assert.ok(ctx.includes(f.copy) && ctx.includes(f.tree), `el contexto nombra ${f.copy} y ${f.tree}`);
    assert.ok(f.copy.startsWith(C.estado()), 'la copia vive en la carpeta de estado');
  }
  assert.match(ctx, /no la carpeta viva/);
});

test('T3 Freeze_LiveEditDoesNotTouchTheCopy @story-8.161 @ac-2 — editar la carpeta viva no toca la copia; la foto guarda el sello del lanzamiento', () => {
  const C = corrida('s-ft3');
  const { json } = C.vuelta();
  const delCodigo = json.frozen.find((f) => f.repo === C.codigo.repo);
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'a.js'), 'module.exports = 99;\n');
  const s = C.correr('marker.js', ['snapshot-iter', '1']);
  assert.strictEqual(s.status, 0, salida(s));
  assert.strictEqual(fs.readFileSync(path.join(delCodigo.copy, 'src', 'a.js'), 'utf8'), 'module.exports = 1;\n');
  const foto = C.marcador().iterations['1'];
  assert.strictEqual((foto.sellos || {})[C.codigo.repo], delCodigo.tree, JSON.stringify(foto));
});

test('T4 Adversarial_ResultCarriesLaunchedTree @story-8.161 @ac-3 — el resultado del pase trae los sellos de su lanzamiento', () => {
  const C = corrida('s-ft4');
  const l = C.correr('marker.js', ['mark-adversarial-launched', 'r1', '4']);
  assert.strictEqual(l.status, 0, salida(l));
  const sellos = C.marcador().adversarial.sellos;
  assert.deepStrictEqual(Object.keys(sellos).sort(), [C.codigo.repo, C.historias.repo].sort(), JSON.stringify(sellos));
  const res = (extra) => {
    const f = path.join(tmp('ft-res-'), 'step-05b-adversarial.json');
    fs.writeFileSync(f, JSON.stringify({ confirmed: [], ...extra }));
    return C.correr('marker.js', ['mark-adversarial-result', '0', '--type', '5b', '--result', f, '--run', 'r1']);
  };
  const sinSellos = res({});
  assert.strictEqual(sinSellos.status, 2, salida(sinSellos));
  assert.match(salida(sinSellos), /sellos/);
  const deMenos = res({ sellos: { [C.codigo.repo]: sellos[C.codigo.repo] } });
  assert.strictEqual(deMenos.status, 2, salida(deMenos));
  const otro = res({ sellos: { ...sellos, [C.codigo.repo]: '0'.repeat(40) } });
  assert.strictEqual(otro.status, 2, salida(otro));
  const bien = res({ sellos });
  assert.strictEqual(bien.status, 0, salida(bien));
  assert.ok((C.marcador().adversarialPasses || []).length === 1, 'lo guarda');
});

// «Preparar el pull request» hasta el freno de lo revisado: los pasos de antes, por fuera del orden
const prepararCommit = (C) => C.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order']);
const MISMATCH = /lo que se guarda no es lo revisado/;

test('T5 PrepareCommit_SameTree_Passes @story-8.161 @ac-4 — sin cambios después de la vuelta, dice la huella y sigue', () => {
  const C = corrida('s-ft5');
  const { json } = C.vuelta();
  const r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  const delCodigo = json.frozen.find((f) => f.repo === C.codigo.repo);
  assert.match(salida(r), new RegExp(`lo que se guarda es lo revisado[^\\n]*${delCodigo.tree.slice(0, 12)}`), salida(r));
});

test('T6 PrepareCommit_ChangedCode_NamesFilesAndReloop @story-8.161 @ac-5 — un archivo cambiado después de la vuelta frena', () => {
  const C = corrida('s-ft6');
  C.vuelta();
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'b.js'), 'module.exports = 3;\n');
  let r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), MISMATCH, salida(r));
  assert.match(salida(r), /src\/b\.js/);
  assert.match(salida(r), /smart-reloop .*--iter 2 --files/);
  // la vuelta nueva sobre lo cambiado: sigue
  assert.strictEqual(C.vuelta(2).r.status, 0);
  r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
});

test('T7 PrepareCommit_PaperworkOnly_DoesNotBlock @story-8.161 @ac-6 — el papeleo no frena; un criterio o un .js de .advisors sí', () => {
  const C = corrida('s-ft7');
  C.vuelta();
  const st = fs.readFileSync(C.story, 'utf8');
  fs.writeFileSync(C.story, reemplazarTexto(st.replace('status: in-progress', 'status: review'), '- [ ] Task 1', '- [x] Task 1').replace('- hoy: escrita', '- hoy: escrita\n- después: cerrada'));
  fs.writeFileSync(path.join(C.historias.repo, 'tasks', 'todo.md'), '- otra cosa\n');
  fs.mkdirSync(path.join(C.codigo.repo, '.advisors', 'dod-runtime'), { recursive: true });
  fs.writeFileSync(path.join(C.codigo.repo, '.advisors', 'dod-runtime', 'x.json'), '{}\n');
  let r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  assert.match(salida(r), /papeleo/);
  // un criterio de la historia cambiado: frena
  fs.writeFileSync(C.story, fs.readFileSync(C.story, 'utf8').replace('**Then** resultado.', '**Then** otro resultado.'));
  r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /story-9\.9-sello\.md/);
  // un .js en .advisors (en la evidencia, que viaja; el resto lo ignora git): frena
  const C2 = corrida('s-ft7b');
  C2.vuelta();
  fs.mkdirSync(path.join(C2.codigo.repo, '.advisors', 'dod-runtime'), { recursive: true });
  fs.writeFileSync(path.join(C2.codigo.repo, '.advisors', 'dod-runtime', 'ayuda.js'), 'x\n');
  r = prepararCommit(C2);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /\.advisors\/dod-runtime\/ayuda\.js/);
});

// El caso de una historia real: después de la última vuelta, el portón de navegador deja sus capturas en una carpeta con
// la hora (otra en cada corrida), la guía de la prueba a mano se regenera, y la historia suma a sus archivos las pruebas
// que se escribieron. Nada de eso es código revisado; cada cosa pedía otra vuelta.
// 🔴 Falla con: una captura del portón que su índice nombra, la guía HTML de qa/ o una prueba sumada a files_to_modify que
//    frenan; o una captura que su índice no nombra con esa huella, o un archivo de código sumado a la lista, que no frenan.
test('PrepareCommit_EvidenciaDelPortonGuiaYPruebasDeLaHistoria_NoFrenan', () => {
  const C = corrida('s-ft-portón');
  C.vuelta();
  const capturas = (repo, hora, nombre, contenido, enIndice = contenido) => {
    const dir = path.join(repo, '.advisors', 'dod-runtime', `9.9-captures-${hora}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, nombre), contenido);
    const sha = require('crypto').createHash('sha256').update(enIndice).digest('hex');
    fs.writeFileSync(path.join(dir, 'captures.json'), JSON.stringify([{ file: nombre, title: 'el caso', acs: ['1'], sha256: sha }]));
  };
  capturas(C.codigo.repo, '20261122T014109Z', '01-el-caso.png', 'PNG-1');
  fs.mkdirSync(path.join(C.historias.repo, 'specs', 'qa'), { recursive: true });
  fs.writeFileSync(path.join(C.historias.repo, 'specs', 'qa', 'story-9.9-sello-guia-qa.html'), '<html>guía</html>\n');
  fs.writeFileSync(C.story, fs.readFileSync(C.story, 'utf8').replace('  - src/a.js\n', '  - src/a.js\n  - tests/a.test.js\n  - "src/__tests__/b.test.tsx"\n'));
  let r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  // otra corrida del portón, con otra hora: tampoco
  capturas(C.codigo.repo, '20261122T020054Z', '01-el-caso.png', 'PNG-2');
  r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  // una captura que su índice no nombra con esa huella: frena
  capturas(C.codigo.repo, '20261122T030000Z', '01-el-caso.png', 'PNG-3', 'otra cosa');
  r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /9\.9-captures-20261122T030000Z\/01-el-caso\.png/);
  // un archivo de código sumado a la lista de la historia: frena
  const C2 = corrida('s-ft-portón-b');
  C2.vuelta();
  fs.writeFileSync(C2.story, fs.readFileSync(C2.story, 'utf8').replace('  - src/a.js\n', '  - src/a.js\n  - src/c.js\n'));
  r = prepararCommit(C2);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /story-9\.9-sello\.md/);
  // un guion en la carpeta de capturas, aunque su índice lo nombre, y otra guía que no es la de la historia: frenan
  const C3 = corrida('s-ft-portón-c');
  C3.vuelta();
  capturas(C3.codigo.repo, '20261122T040000Z', 'ayuda.js', 'console.log(1)\n');
  fs.mkdirSync(path.join(C3.codigo.repo, 'public', 'qa'), { recursive: true });
  fs.writeFileSync(path.join(C3.codigo.repo, 'public', 'qa', 'story-9.9-sello-guia-qa.html'), '<script>x()</script>\n');
  r = prepararCommit(C3);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /9\.9-captures-20261122T040000Z\/ayuda\.js/);
  assert.match(salida(r), /public\/qa\/story-9\.9-sello-guia-qa\.html/);
});

test('T13 PrepareCommit_OldRunWithoutTree_NotMeasured @story-8.161 @ac-12 — una vuelta sin sello no se compara, y se dice', () => {
  const C = corrida('s-ft13');
  const r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  assert.match(salida(r), /la vuelta no tiene sello: no se pudo comparar/, salida(r));
  const gates = fs.readFileSync(path.join(C.estado(), 'gates.log'), 'utf8');
  assert.match(gates, /"name":"reviewed-tree"[^\n]*"status":"no-medido"/);
});

test('T16b Freeze_AlteredCopy_Blocks @story-8.161 @ac-16 — snapshot-iter, el resultado del pase y el guardado frenan con la copia alterada', () => {
  const C = corrida('s-ft16');
  const { json } = C.vuelta();
  const delCodigo = json.frozen.find((f) => f.repo === C.codigo.repo);
  fs.chmodSync(path.join(delCodigo.copy, 'src', 'a.js'), 0o644);
  fs.writeFileSync(path.join(delCodigo.copy, 'src', 'a.js'), 'alterado\n');
  for (const r of [C.correr('marker.js', ['snapshot-iter', '1']), prepararCommit(C)]) {
    assert.strictEqual(r.status, 2, salida(r));
    assert.match(salida(r), /la copia de la vuelta no coincide con su sello/);
    assert.ok(salida(r).includes(delCodigo.tree), salida(r));
  }
  // el pase: su copia alterada frena el resultado
  assert.strictEqual(C.correr('marker.js', ['mark-adversarial-launched', 'r1', '4']).status, 0);
  const m = C.marcador();
  const copia = m.adversarial.copias[C.codigo.repo];
  fs.chmodSync(path.join(copia, 'src', 'a.js'), 0o644);
  fs.writeFileSync(path.join(copia, 'src', 'a.js'), 'alterado\n');
  const f = path.join(tmp('ft-res-'), 'step-05b-adversarial.json');
  fs.writeFileSync(f, JSON.stringify({ confirmed: [], sellos: m.adversarial.sellos }));
  const res = C.correr('marker.js', ['mark-adversarial-result', '0', '--type', '5b', '--result', f, '--run', 'r1']);
  assert.strictEqual(res.status, 2, salida(res));
  assert.match(salida(res), /la copia de la vuelta no coincide con su sello/);
});

test('T17 Sensitive_CoversDecisionFiles @story-8.161 @ac-17 — lo que decide qué cuenta es sensible', () => {
  const sig = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
  const so = require(path.join(SCRIPTS, 'lib', 'save-ok.js'));
  for (const rel of ['skills/tycon-pipeline/scripts/lib/frozen-tree.js', 'skills/tycon-pipeline/scripts/runtime-matrix.js', 'skills/tycon-pipeline/scripts/smoke-run.sh']) {
    assert.ok(sig.SENSITIVE.includes(rel), `${rel} en SENSITIVE`);
    assert.ok(so.esSensible(rel), `${rel} pide save:sensible`);
  }
});

// ── Cada prueba con su procedencia ──────────────────────────────────────────────────────────────────────
const LEDGER = require(path.join(__dirname, 'lib', 'smoke-ledger-line.js'));
// Un repo con la historia y su código, y una HOME propia: el espejo de los humos vive en ella.
test('T7b PaperworkUnderSubheadings_AndLiveEvidence_DoNotBlock @story-8.161 @ac-6 — (pase de la 8.243) los ### del Dev Agent Record, el estado del cuerpo y la evidencia de un humo son papeleo', () => {
  const base = ['---', 'story: "9.9"', 'status: in-progress', '---', '', '## Story', 'algo', '', 'Status: in-progress', '',
    '## Dev Agent Record', '', '### Completion Notes List', '', '- nada todavía', '', '### File List', '', '- a.js', '',
    '## Cambios de comportamiento', '', '### Tanda C', '', '- `node cli.js save`: dice frena', '', '## Change Log', '', '### 2026-11-09', '- escrita', ''].join('\n');
  const despues = base.replace('- nada todavía', '- implementado y probado').replace('- a.js', '- a.js\n- b.js').replace('Status: in-progress', 'Status: review')
    .replace('- `node cli.js save`: dice frena', '- `node cli.js save`: dice frena con dos puntos').replace('- escrita', '- escrita\n- cerrada');
  assert.strictEqual(ft().sinPapeleoDeLaHistoria(base), ft().sinPapeleoDeLaHistoria(despues), 'todo eso es papeleo');
  // la sección siguiente al papeleo vuelve a contar
  assert.notStrictEqual(ft().sinPapeleoDeLaHistoria(base), ft().sinPapeleoDeLaHistoria(base.replace('## Story\nalgo', '## Story\notra cosa')));
  // la salida de un humo que su registro nombra con la misma huella es papeleo; un archivo suelto en esa carpeta, no
  const R = repoDeJuguete('evidencia', { 'src/a.js': 'module.exports = 1;\n' });
  const antes = ft().seal(R.repo).tree;
  const dir = path.join(R.repo, '.advisors', 'dod-runtime');
  // el registro y la salida con la forma que deja smoke-run.sh (línea `v:2`), sin espejo: acá sólo cuenta el repo
  LEDGER.append({ dodDir: dir, story: '9.9', acs: [6], mirror: false, v2: { pasaSi: 'sale 0', outputText: 'sale 0\n' } });
  let d = ft().changed(R.repo, antes, ft().seal(R.repo).tree);
  assert.deepStrictEqual(d.files, [], JSON.stringify(d));
  fs.writeFileSync(path.join(dir, '9.9-smoke-outputs', 'suelto.txt'), 'x\n');
  d = ft().changed(R.repo, antes, ft().seal(R.repo).tree);
  assert.deepStrictEqual(d.files, ['.advisors/dod-runtime/9.9-smoke-outputs/suelto.txt']);
});

test('T15c Cleanup_DotDotSession_StaysInside @story-8.161 @ac-14 — (pase de la 8.243) un nombre de sesión «..» no sale de la carpeta de las copias', () => {
  const estado = tmp('ft-estado-');
  fs.writeFileSync(path.join(estado, 'gates.log'), 'no se borra\n');
  ft().remove(estado, '..');
  ft().remove(estado, '.');
  assert.ok(fs.existsSync(path.join(estado, 'gates.log')), 'la carpeta de estado sigue entera');
  const R = repoDeJuguete('punto', { 'a.js': '1\n' });
  const d = ft().copyDir(estado, '..', '..', R.repo);
  assert.ok(d.startsWith(path.join(estado, 'frozen') + path.sep), d);
  // la procedencia sin sesión dice por qué no tiene corrida
  const p = ft().procedencia(R.repo, { env: {}, proceso: 'prueba' });
  assert.strictEqual(p.run, null);
  assert.match(p.run_error, /sin sesión/);
});

test('T15d Provenance_MarkerStoryWithoutRunDir_SaysWhy — (diferido de la 8.243) un marcador con historia y sin carpeta: la calcula, o dice por qué no', () => {
  const R = repoDeJuguete('procedencia', { 'a.js': '1\n' });
  const home = tmp('ft-home-proc-');
  const activos = path.join(require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home), 'active');
  fs.mkdirSync(activos, { recursive: true });
  fs.writeFileSync(path.join(activos, 's-proc.json'), JSON.stringify({ storyId: '9.8', repoPath: R.repo }));
  const leer = () => ft().procedencia(R.repo, { env: { CLAUDE_CODE_SESSION_ID: 's-proc' }, home });
  // sin carpeta de corrida todavía
  let p = leer();
  assert.strictEqual(p.run, null);
  assert.strictEqual(p.run_error, 'la historia del marcador todavía no tiene carpeta de corrida');
  // con su carpeta, la que calcula el pipeline para la historia
  const carpeta = path.join(R.repo, '.advisors', 'pipeline-runs', '9.8-20260101000000');
  fs.mkdirSync(carpeta, { recursive: true });
  p = leer();
  assert.strictEqual(p.run, carpeta);
  assert.ok(!('run_error' in p));
  // y si calcularla falla, lo dice con su motivo
  const RD = require(path.join(SCRIPTS, 'lib', 'run-dir.js'));
  const original = RD.resolveRunDir;
  RD.resolveRunDir = () => { throw new Error('sin permiso\nsegunda línea'); };
  try { p = leer(); } finally { RD.resolveRunDir = original; }
  assert.strictEqual(p.run, null);
  assert.strictEqual(p.run_error, 'no pude calcular la carpeta de la corrida (sin permiso)');
});

function repoConHistoria() {
  const home = tmp('ft-home-');
  const r = repoDeJuguete('producto', {
    'specs/story-9.8-humo.md': ['---', 'story: "9.8"', 'title: "humo"', 'status: in-progress', 'files_to_modify:', '  - src/a.js', '---', '',
      '## Acceptance Criteria', '', '1. **Given** algo, **Then** resultado.', '', '### Tests', '',
      '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|', '| T1 | `a.caso1` | 1 | integration | x | y |', ''].join('\n'),
    'src/a.js': 'module.exports = 1;\n',
    'src/z.js': 'module.exports = 26;\n',
  });
  const story = path.join(r.repo, 'specs', 'story-9.8-humo.md');
  const dodDir = path.join(r.repo, '.advisors', 'dod-runtime');
  const gatesLog = path.join(home, '.claude', '.tycon-pipeline', 'gates.log');
  fs.mkdirSync(path.dirname(gatesLog), { recursive: true });
  return { ...r, home, story, dodDir, gatesLog };
}
const SMOKE = path.join(SCRIPTS, 'smoke-run.sh');
const humoReal = (R, extraEnv = {}) => spawnSync('bash', [SMOKE, R.dodDir, R.story, '--acs', '1', '--pass-if', 'sale 0', '--', 'true'], {
  encoding: 'utf8', cwd: R.repo, env: { ...process.env, HOME: R.home, USERPROFILE: R.home, TYCON_HOME: '', CLAUDE_CODE_SESSION_ID: 's-humo', ...extraEnv },
});
const renglones = (R) => fs.readFileSync(path.join(R.dodDir, '9.8-smoke-ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('T8 Smoke_RowCarriesProvenance @story-8.161 @ac-7 — el renglón del humo trae su procedencia', () => {
  const R = repoConHistoria();
  const r = humoReal(R);
  assert.strictEqual(r.status, 0, r.stderr);
  const [e] = renglones(R);
  for (const k of ['run', 'tree', 'commit', 'acs', 'cmd', 'exit', 'ts', 'env', 'by']) assert.ok(k in e, `falta ${k}: ${JSON.stringify(e)}`);
  assert.match(e.tree, /^[0-9a-f]{40}$/);
  assert.match(e.commit, /^[0-9a-f]{40}$/);
  assert.deepStrictEqual(Object.keys(e.env).sort(), ['node', 'os', 'tool']);
  assert.strictEqual(e.env.tool, 'claude-code');
  assert.strictEqual(e.by.session, 's-humo');
  // el sello también va al espejo
  assert.ok(fs.readFileSync(R.gatesLog, 'utf8').includes(`"tree":"${e.tree}"`));
});

test('T9 TestGate_ResultCarriesProvenance @story-8.161 @ac-8 — el resultado del portón de pruebas trae su procedencia', () => {
  const R = repoConHistoria();
  const resultados = tmp('ft-resultados-');
  const out = path.join(tmp('ft-out-'), 'tests-result.json');
  const tg = require(path.join(SCRIPTS, 'lib', 'test-gate-report.js'));
  const antes = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 's-portón';
  try {
    tg.informe(['node', R.repo, R.repo, resultados, out, '0', '', '', new Date().toISOString()]);
  } finally {
    if (antes === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = antes;
  }
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  for (const k of ['run', 'tree', 'commit', 'cmd', 'exit', 'ts', 'env', 'by']) assert.ok(k in res, `falta ${k}`);
  assert.match(res.tree, /^[0-9a-f]{40}$/);
  assert.strictEqual(res.by.session, 's-portón');
});

test('T10 Matrix_OtherTree_IsNotRun @story-8.161 @ac-9 — un humo de otra versión de lo declarado no cuenta', () => {
  const R = repoConHistoria();
  const rm = require(path.join(SCRIPTS, 'runtime-matrix.js'));
  const h1 = ft().seal(R.repo).tree;
  LEDGER.append({ dodDir: R.dodDir, gatesLog: R.gatesLog, story: '9.8', acs: [1], sello: { tree: h1 } });
  const matriz = () => rm.compute({ storyPath: R.story, gatesLogPath: R.gatesLog });
  // con lo declarado igual, cuenta
  assert.strictEqual(matriz().perAc[1].verdict, 'RUNTIME');
  // un archivo no declarado distinto: sigue contando
  fs.writeFileSync(path.join(R.repo, 'src', 'z.js'), 'module.exports = 27;\n');
  assert.strictEqual(matriz().perAc[1].verdict, 'RUNTIME', 'un cambio en un archivo no declarado no lo vence');
  // el declarado distinto: sin correr, con la nota
  fs.writeFileSync(path.join(R.repo, 'src', 'a.js'), 'module.exports = 2;\n');
  let m = matriz();
  assert.strictEqual(m.perAc[1].verdict, 'NOT-RUN');
  assert.ok(m.warnings.some((w) => w.includes(`otra versión de lo declarado (${h1.slice(0, 12)})`)), m.warnings.join('\n'));
  // un humo de la versión actual: corrido
  const h2 = ft().seal(R.repo).tree;
  // stable-data: un segundo después, para no compartir la hora con el anterior
  LEDGER.append({ dodDir: R.dodDir, gatesLog: R.gatesLog, story: '9.8', acs: [1], sello: { tree: h2 }, ts: new Date(Date.now() + 1000).toISOString().replace(/\.\d+Z$/, 'Z') });
  m = matriz();
  assert.strictEqual(m.perAc[1].verdict, 'RUNTIME', m.warnings.join('\n'));
});

test('T14 Smoke_TreeFails_NotCountedAsCurrent @story-8.161 @ac-13 — sin poder sellar, el humo no cuenta como de la versión actual', () => {
  const R = repoConHistoria();
  // un archivo cambiado y la base de objetos sin permiso: git no puede escribir el árbol
  fs.writeFileSync(path.join(R.repo, 'src', 'a.js'), 'module.exports = 3;\n');
  const objetos = path.join(R.repo, '.git', 'objects');
  execFileSync('chmod', ['-R', 'a-w', objetos]);
  let r;
  try { r = humoReal(R); } finally { execFileSync('chmod', ['-R', 'u+w', objetos]); }
  assert.strictEqual(r.status, 0, r.stderr);
  const [e] = renglones(R);
  assert.strictEqual(e.tree, null);
  assert.ok(e.tree_error, JSON.stringify(e));
  const m = require(path.join(SCRIPTS, 'runtime-matrix.js')).compute({ storyPath: R.story, gatesLogPath: R.gatesLog });
  assert.strictEqual(m.perAc[1].verdict, 'NOT-RUN', m.warnings.join('\n'));
});

test('T15b Regression_OldLedgersAndCleanup @story-8.161 @ac-15 — (parte B) un renglón viejo, sin los campos nuevos, se lee como antes', () => {
  const R = repoConHistoria();
  // el código, viejo: la evidencia de ahora es posterior
  // stable-data: una hora antes, para que la regla de la fecha decida como antes
  const viejo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(R.repo, 'src', 'a.js'), viejo, viejo);
  LEDGER.append({ dodDir: R.dodDir, gatesLog: R.gatesLog, story: '9.8', acs: [1] });
  const m = require(path.join(SCRIPTS, 'runtime-matrix.js')).compute({ storyPath: R.story, gatesLogPath: R.gatesLog });
  assert.strictEqual(m.perAc[1].verdict, 'RUNTIME', m.warnings.join('\n'));
});

test('T15 Regression_OldLedgersAndCleanup @story-8.161 @ac-14 — (parte A) las copias se borran, también las de una corrida cerrada', () => {
  const r = repoDeJuguete('codigo', { 'src/a.js': '1\n' });
  const s = ft().seal(r.repo);
  const estado = tmp('ft-estado-');
  for (const sid of ['s-abierta', 's-cerrada', 's-propia']) ft().freeze(r.repo, s.tree, ft().copyDir(estado, sid, 'iter1', r.repo));
  // la propia se borra al cerrar la corrida, aunque sea de sólo lectura
  ft().remove(estado, 's-propia');
  assert.ok(!fs.existsSync(path.join(estado, 'frozen', 's-propia')));
  // la próxima vuelta barre las de las corridas que ya no están abiertas
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.writeFileSync(path.join(estado, 'active', 's-abierta.json'), JSON.stringify({ storyId: '1' }));
  const barridas = ft().sweep(estado);
  assert.deepStrictEqual(barridas, ['s-cerrada']);
  assert.ok(fs.existsSync(path.join(estado, 'frozen', 's-abierta')));
  assert.ok(!fs.existsSync(path.join(estado, 'frozen', 's-cerrada')));
});

// ── El papeleo que escribe el cierre ─────────────────────────────────────────────────────────────────────────────────
// Sin esto, una historia frenaba sólo por su sección de seguimientos, u otra por esa sección más su renglón de
// sprint-status, y cada una pedía una vuelta de revisores sin nada que revisar.
// La sección que escribe `pipeline.js write-followups` en «Hallazgos», con la forma de `renderFollowupItem`.
const SEGUIMIENTOS = ['', '', '## Review Follow-ups (Advisors)', '',
  '<!-- tycon-pipeline: generado por el paso de hallazgos. Cada item = finding advisor no resuelto (CRITICAL waived o WARNING). -->', '',
  '- [x] **[WARNING]** SILENT-W2 — `src/a.js:3` — un aviso que no se veía <!-- fkey:SILENT-W2|src/a.js -->',
  '- [ ] **[WARNING]** VAL-W15 — `specs/story-9.9-sello.md` — papeleo al día <!-- fkey:VAL-W15|specs/story-9.9-sello.md -->', ''].join('\n');
const SPRINT = ['# generated: 2026-01-01', '# STATUS DEFINITIONS: backlog | done', '', 'development_status:', '', 'epic-9: in-progress',
  '9-8-otra: done   # 2026-01-01: cerrada', '9-9-sello: ready-for-dev   # 2026-01-01: escrita', '9-90-otra: backlog', ''].join('\n');
const SPRINT_REL = path.join('specs', 'sprint-status.yaml');

test('T24 PrepareCommit_ReviewFollowupsSection_IsPaperwork @story-8.263 @ac-21 — la sección de seguimientos que escribe «Hallazgos» es papeleo', () => {
  const C = corrida('s-ft24');
  const { json } = C.vuelta();
  const deLaHistoria = json.frozen.find((f) => f.repo === C.historias.repo);
  const rel = path.relative(C.historias.repo, C.story).split(path.sep).join('/');
  // «Hallazgos» agrega la sección al final de la historia, además del papeleo de siempre
  fs.writeFileSync(C.story, reemplazarTexto(fs.readFileSync(C.story, 'utf8'), '- [ ] Task 1', '- [x] Task 1') + SEGUIMIENTOS);
  let d = ft().changed(C.historias.repo, deLaHistoria.tree, ft().seal(C.historias.repo).tree, { storyRel: rel });
  assert.deepStrictEqual([d.files, d.papeleo], [[], [rel]]);
  let r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  assert.match(salida(r), new RegExp(`lo que se guarda es lo revisado[^\\n]*papeleo cambiado después[^\\n]*story-9\\.9-sello\\.md`), salida(r));
  // tildar un seguimiento después también es papeleo
  fs.writeFileSync(C.story, reemplazarTexto(fs.readFileSync(C.story, 'utf8'), '- [ ] **[WARNING]** VAL-W15', '- [x] **[WARNING]** VAL-W15'));
  r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  // la sección llega hasta el próximo título de nivel 2: lo que sigue vuelve a contar
  fs.writeFileSync(C.story, `${fs.readFileSync(C.story, 'utf8')}\n## Notas\n\nun criterio nuevo escondido\n`);
  d = ft().changed(C.historias.repo, deLaHistoria.tree, ft().seal(C.historias.repo).tree, { storyRel: rel });
  assert.deepStrictEqual(d.files, [rel]);
  r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), MISMATCH);
});

test('T25 PrepareCommit_SprintStatusOwnRow_IsPaperwork @story-8.263 @ac-22 — el renglón de la historia en sprint-status.yaml es papeleo, también si se agrega', () => {
  // el estado y el comentario del propio renglón
  const C = corrida('s-ft25', { masHistorias: { [SPRINT_REL]: SPRINT } });
  const { json } = C.vuelta();
  const sello = json.frozen.find((f) => f.repo === C.historias.repo).tree;
  const rel = path.relative(C.historias.repo, C.story).split(path.sep).join('/');
  const sprint = path.join(C.historias.repo, SPRINT_REL);
  fs.writeFileSync(sprint, SPRINT.replace('9-9-sello: ready-for-dev   # 2026-01-01: escrita', '9-9-sello: review   # 2026-01-02: implementada, 1 vuelta'));
  let d = ft().changed(C.historias.repo, sello, ft().seal(C.historias.repo).tree, { storyRel: rel });
  assert.deepStrictEqual([d.files, d.papeleo], [[], ['specs/sprint-status.yaml']]);
  let r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  assert.match(salida(r), /papeleo cambiado después[^\n]*sprint-status\.yaml/, salida(r));
  // el renglón que no estaba y se agrega
  const sinRenglon = SPRINT.replace('9-9-sello: ready-for-dev   # 2026-01-01: escrita\n', '');
  const C2 = corrida('s-ft25b', { masHistorias: { [SPRINT_REL]: sinRenglon } });
  const sello2 = C2.vuelta().json.frozen.find((f) => f.repo === C2.historias.repo).tree;
  fs.writeFileSync(path.join(C2.historias.repo, SPRINT_REL), SPRINT);
  d = ft().changed(C2.historias.repo, sello2, ft().seal(C2.historias.repo).tree, { storyRel: rel });
  assert.deepStrictEqual(d.files, []);
  r = prepararCommit(C2);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
});

test('PrepareCommit_SubStoryRow_StillBlocks @story-8.263 @ac-23 — el renglón de una sub-historia empieza igual y no es el propio', () => {
  const conSub = SPRINT.replace('9-90-otra: backlog', '9-9-1-sub-historia: backlog\n9-90-otra: backlog');
  const C = corrida('s-ft26s', { masHistorias: { [SPRINT_REL]: conSub } });
  C.vuelta();
  fs.writeFileSync(path.join(C.historias.repo, SPRINT_REL), conSub.replace('9-9-1-sub-historia: backlog', '9-9-1-sub-historia: done'));
  const r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), MISMATCH);
  assert.ok(salida(r).includes('specs/sprint-status.yaml'), salida(r));
});

test('T26 PrepareCommit_OtherRowsOrSections_StillBlock @story-8.263 @ac-23 — otro renglón, otra carpeta u otra sección siguen frenando', () => {
  const C = corrida('s-ft26', { masHistorias: { [SPRINT_REL]: SPRINT, 'otra/sprint-status.yaml': SPRINT } });
  C.vuelta();
  const sprint = path.join(C.historias.repo, SPRINT_REL);
  const otra = path.join(C.historias.repo, 'otra', 'sprint-status.yaml');
  const historiaBase = fs.readFileSync(C.story, 'utf8');
  const conDevNotes = historiaBase.replace('## Tasks / Subtasks', '## Dev Notes\n\nnada\n\n## Tasks / Subtasks');
  const casos = [
    ['el renglón de otra historia con el mismo comienzo', () => fs.writeFileSync(sprint, SPRINT.replace('9-90-otra: backlog', '9-90-otra: done')), 'specs/sprint-status.yaml'],
    ['la épica', () => fs.writeFileSync(sprint, SPRINT.replace('epic-9: in-progress', 'epic-9: done')), 'specs/sprint-status.yaml'],
    ['un comentario suelto', () => fs.writeFileSync(sprint, SPRINT.replace('epic-9: in-progress', '# nota suelta\nepic-9: in-progress')), 'specs/sprint-status.yaml'],
    ['la cabecera', () => fs.writeFileSync(sprint, SPRINT.replace('# generated: 2026-01-01', '# generated: 2026-01-02')), 'specs/sprint-status.yaml'],
    ['el renglón propio en un sprint-status de otra carpeta', () => fs.writeFileSync(otra, SPRINT.replace('9-9-sello: ready-for-dev', '9-9-sello: review')), 'otra/sprint-status.yaml'],
    ['los seguimientos de BMAD', () => fs.writeFileSync(C.story, historiaBase + SEGUIMIENTOS.replace('(Advisors)', '(AI)')), 'story-9.9-sello.md'],
    ['un título con texto de más', () => fs.writeFileSync(C.story, historiaBase + SEGUIMIENTOS.replace('(Advisors)', '(Advisors) extra')), 'story-9.9-sello.md'],
    ['un ### dentro de otra sección', () => fs.writeFileSync(C.story, conDevNotes.replace('nada\n', `nada\n\n### Review Follow-ups (Advisors)\n\n- [ ] algo\n`)), 'story-9.9-sello.md'],
  ];
  for (const [nombre, cambiar, archivo] of casos) {
    fs.writeFileSync(sprint, SPRINT);
    fs.writeFileSync(otra, SPRINT);
    fs.writeFileSync(C.story, historiaBase);
    cambiar();
    const r = prepararCommit(C);
    assert.strictEqual(r.status, 2, `${nombre}: ${salida(r)}`);
    assert.match(salida(r), MISMATCH, nombre);
    assert.ok(salida(r).includes(archivo), `${nombre}: nombra ${archivo}`);
    assert.match(salida(r), /smart-reloop .*--iter 2/, nombre);
  }
});

test('T27 PrepareCommit_SprintStatusMissingOrStoryWithoutId_Blocks @story-8.263 @ac-24 — sin saber de qué historia es el renglón, o sin el archivo en un sello, cuenta como cambio', () => {
  const historia = (frontmatter) => ['---', ...frontmatter, 'status: in-progress', '---', '', '# Story', ''].join('\n');
  const STORY = 'specs/story-9.9-sello.md';
  const conRenglon = (estado) => SPRINT.replace('9-9-sello: ready-for-dev', `9-9-sello: ${estado}`);
  const casos = [
    ['creado después con sólo su renglón', { [STORY]: historia(['story: "9.9"']) }, () => ({ [SPRINT_REL]: '9-9-sello: review\n' })],
    ['borrado después', { [STORY]: historia(['story: "9.9"']), [SPRINT_REL]: SPRINT }, () => ({ [SPRINT_REL]: null })],
    ['la historia sin story:', { [STORY]: historia([]), [SPRINT_REL]: SPRINT }, () => ({ [SPRINT_REL]: conRenglon('review') })],
    ['la historia con story: "9.9b"', { [STORY]: historia(['story: "9.9b"']), [SPRINT_REL]: SPRINT }, () => ({ [SPRINT_REL]: conRenglon('review') })],
  ];
  for (const [nombre, inicio, despues] of casos) {
    const R = repoDeJuguete('t27', inicio);
    const a = ft().seal(R.repo).tree;
    for (const [rel, txt] of Object.entries(despues())) {
      if (txt === null) fs.rmSync(path.join(R.repo, rel));
      else { fs.mkdirSync(path.dirname(path.join(R.repo, rel)), { recursive: true }); fs.writeFileSync(path.join(R.repo, rel), txt); }
    }
    const d = ft().changed(R.repo, a, ft().seal(R.repo).tree, { storyRel: STORY });
    assert.deepStrictEqual(d.files, ['specs/sprint-status.yaml'], nombre);
  }
});

// --- lo que trae main después de la última vuelta (historia 8.272) ------------------------------------------------
// Un repo con su origin: main con dos archivos; la rama de la corrida cambia `a.js` y se sella. Después main cambia
// `otro.js` (y, según el caso, `a.js`) desde otro clon, y la rama lo trae por merge o por rebase
function conMain() {
  const base = tmp('ft-main-');
  const origen = path.join(base, 'origen.git');
  const repo = path.join(base, 'repo');
  const otro = path.join(base, 'otro');
  const env = { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const en = (dir) => (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  fs.mkdirSync(repo);
  const git = en(repo);
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', origen);
  fs.writeFileSync(path.join(repo, 'a.js'), 'uno\ndos\ntres\ncuatro\ncinco\n');
  fs.writeFileSync(path.join(repo, 'otro.js'), 'otro\n');
  fs.writeFileSync(path.join(repo, 'quieto.sh'), 'echo quieto\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  git('push', '-q', 'origin', 'main');
  git('fetch', '-q', 'origin');
  git('checkout', '-q', '-b', 'story/9.9');
  fs.writeFileSync(path.join(repo, 'a.js'), 'uno de la corrida\ndos\ntres\ncuatro\ncinco\n');
  git('commit', '-qam', 'la corrida');
  execFileSync('git', ['clone', '-q', origen, otro], { env });
  const o = en(otro);
  const avanzarMain = (cambios) => {
    for (const [rel, txt] of Object.entries(cambios)) fs.writeFileSync(path.join(otro, rel), txt);
    o('commit', '-qam', 'otro pedido');
    o('push', '-q', 'origin', 'main');
    git('fetch', '-q', 'origin');
  };
  return { repo, git, avanzarMain };
}

test('T8 Seal_MainBroughtFileRunDidNotTouch_IsPaperwork @story-8.272 @ac-9 — lo que trae main en un archivo que la corrida no tocó es papeleo', () => {
  for (const como of ['merge', 'rebase']) {
    const R = conMain();
    const v = ft().sealAndFreeze({ stateDir: tmp('ft-main-estado-'), sid: 's-main', etiqueta: 'rev-iter1', repos: [R.repo] });
    assert.ok(!v.error, v.error);
    const antes = v.repos[0];
    assert.match(String(antes.mainBase), /^[0-9a-f]{40}$/, `${como}: el sello anota el punto en común con main`);
    R.avanzarMain({ 'otro.js': 'otro cambiado por main\n' });
    if (como === 'merge') R.git('merge', '-q', '--no-edit', 'origin/main');
    else R.git('rebase', '-q', 'origin/main');
    const ahora = ft().puntoComunConMain(R.repo);
    assert.ok(ahora.sha, ahora.error);
    let d = ft().changed(R.repo, antes.tree, ft().seal(R.repo).tree, { mainAntes: antes.mainBase, mainAhora: ahora.sha });
    assert.deepStrictEqual([d.files, d.deMain], [[], ['otro.js']], como);
    // main vuelve a cambiar el archivo y la rama no lo trae: el punto en común no cambia, sigue siendo papeleo
    R.avanzarMain({ 'otro.js': 'otro cambiado otra vez\n' });
    const otraVez = ft().puntoComunConMain(R.repo);
    assert.strictEqual(otraVez.sha, ahora.sha, como);
    d = ft().changed(R.repo, antes.tree, ft().seal(R.repo).tree, { mainAntes: antes.mainBase, mainAhora: otraVez.sha });
    assert.deepStrictEqual([d.files, d.deMain], [[], ['otro.js']], como);
  }
});

test('T9 Seal_RunFileAlsoChangedByMain_Counts @story-8.272 @ac-10 @ac-26 — un archivo de la corrida que main también cambió cuenta', () => {
  const R = conMain();
  const antes = ft().seal(R.repo).tree;
  const mainAntes = ft().puntoComunConMain(R.repo).sha;
  R.avanzarMain({ 'a.js': 'uno\ndos\ntres\ncuatro\ncinco de main\n', 'otro.js': 'otro de main\n' });
  R.git('merge', '-q', '--no-edit', 'origin/main');
  const d = ft().changed(R.repo, antes, ft().seal(R.repo).tree, { mainAntes, mainAhora: ft().puntoComunConMain(R.repo).sha });
  assert.deepStrictEqual(d.files, ['a.js']);
  assert.deepStrictEqual(d.deMain, ['otro.js']);
  // un cambio de la corrida después de la vuelta sigue frenando
  fs.writeFileSync(path.join(R.repo, 'a.js'), 'uno otra vez\n');
  const d2 = ft().changed(R.repo, antes, ft().seal(R.repo).tree, { mainAntes, mainAhora: ft().puntoComunConMain(R.repo).sha });
  assert.ok(d2.files.includes('a.js'));
});

test('T10 Seal_NoMainBaseOrNoMain_CountsAsToday @story-8.272 @ac-11 — sin la base de main en el sello, o sin main, todo cuenta como hoy', () => {
  const R = conMain();
  const antes = ft().seal(R.repo).tree;
  R.avanzarMain({ 'otro.js': 'otro de main\n' });
  R.git('merge', '-q', '--no-edit', 'origin/main');
  const ahora = ft().puntoComunConMain(R.repo).sha;
  // un sello de antes, sin mainBase
  const d = ft().changed(R.repo, antes, ft().seal(R.repo).tree, { mainAntes: null, mainAhora: ahora });
  assert.deepStrictEqual([d.files, d.deMain], [['otro.js'], []]);
  // un repo sin origin/main ni main: el motivo
  const J = repoDeJuguete('t10', { 'x.js': 'x\n' });
  const sin = ft().puntoComunConMain(J.repo);
  assert.strictEqual(sin.sha, undefined);
  assert.match(sin.error, /sin origin\/main ni main/);
});

test('PrepareCommit_NoMainToSeparate_SaysWhy @story-8.272 @ac-11 — (revisores de la 8.272) sin main para separar, «Preparar» frena como hoy y dice por qué', () => {
  // los repos de la corrida de juguete no tienen origin/main ni main: el sello no anota el punto en común
  const C = corrida('s-ft11');
  C.vuelta();
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'b.js'), 'module.exports = 4;\n');
  const r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), MISMATCH);
  assert.match(salida(r), /No pude separar lo que trajo main \(.*(sin el punto en común con main|sin origin\/main ni main).*\): cuenta como cambio/, salida(r));
});

test('Seal_ModeOrSubmoduleChangedByRun_CountsEvenAfterMain @story-8.272 @ac-10 — (pase de la 8.272) un cambio de permisos o de submódulo de la corrida no pasa como «lo trajo main»', () => {
  const R = conMain();
  // un submódulo de juguete: un repo adentro, que git anota por su puntero (el commit de su HEAD)
  const sub = path.join(R.repo, 'sub');
  const enSub = (...a) => execFileSync('git', ['-C', sub, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  fs.mkdirSync(sub);
  enSub('init', '-q');
  fs.writeFileSync(path.join(sub, 'x'), '1\n');
  enSub('add', '.');
  enSub('commit', '-qm', 'uno');
  R.git('add', 'sub');
  R.git('commit', '-qm', 'el submódulo');
  const antes = ft().seal(R.repo).tree;
  const mainAntes = ft().puntoComunConMain(R.repo).sha;
  R.avanzarMain({ 'otro.js': 'otro de main\n' });
  R.git('merge', '-q', '--no-edit', 'origin/main');
  // después de traer main, la sesión hace dos cambios que nadie revisó: el permiso de ejecución y el puntero
  fs.chmodSync(path.join(R.repo, 'quieto.sh'), 0o755);
  fs.writeFileSync(path.join(sub, 'x'), '2\n');
  enSub('commit', '-qam', 'dos');
  R.git('add', 'quieto.sh', 'sub');
  R.git('commit', '-qm', 'cambios sin revisar');
  const d = ft().changed(R.repo, antes, ft().seal(R.repo).tree, { mainAntes, mainAhora: ft().puntoComunConMain(R.repo).sha });
  assert.deepStrictEqual([d.files.sort(), d.deMain], [['quieto.sh', 'sub'], ['otro.js']]);
});

// ── El papeleo de «Probar en vivo» (@story-8.270, AC 4-7, 19, 23) ────────────────────────────────────────────────────
// «Probar en vivo» corre después de la última vuelta y deja siempre lo mismo: la marca DODRT-C8 de un criterio, el estado
// de la tanda en `pipelines:` y el guion de la prueba en vivo, que su registro de humos nombra con la misma huella.

const HISTORIA_870 = 'specs/story-9.9-vivo.md';
const historiaConTandas = () => ['---', 'story: "9.9"', 'status: in-progress', 'pipelines:', '  a:', '    name: "la tanda A"',
  '    status: in-progress', '    files:', '      - src/a.js', '    acs_pending: [1, 2]', '    tasks_pending: [1]', '    tests_pending: [T1]', '---', '',
  '## Acceptance Criteria', '', '1. **Given** algo **Then** resultado.', '2. **Given** otra cosa **Then** otro resultado.', '',
  '## Tasks', '', '- [ ] Task 1', ''].join('\n');
const sha256 = (txt) => require('crypto').createHash('sha256').update(txt).digest('hex');

test('Seal_RuntimeExemptMarkAfterRound_IsPaperwork @story-8.270 @ac-4 — la marca DODRT-C8 en un criterio es papeleo', () => {
  const R = repoDeJuguete('marca', { [HISTORIA_870]: historiaConTandas(), 'src/a.js': '1\n' });
  const antes = ft().seal(R.repo).tree;
  const f = path.join(R.repo, HISTORIA_870);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('**Then** resultado.', '**Then** resultado. @runtime-exempt(DODRT-C8): se lee, no se ejecuta'));
  const d = ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: HISTORIA_870 });
  assert.deepStrictEqual(d, { files: [], papeleo: [HISTORIA_870], deMain: [] });
  // la misma marca fuera de los criterios no es papeleo
  fs.writeFileSync(f, `${fs.readFileSync(f, 'utf8')}\nNota @runtime-exempt(DODRT-C8): fuera\n`);
  assert.deepStrictEqual(ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: HISTORIA_870 }).files, [HISTORIA_870]);
});

test('Seal_BatchStatusFieldsAfterRound_ArePaperwork @story-8.270 @ac-5 — el estado y lo pendiente de una tanda son papeleo', () => {
  const R = repoDeJuguete('tanda', { [HISTORIA_870]: historiaConTandas(), 'src/a.js': '1\n' });
  const antes = ft().seal(R.repo).tree;
  const f = path.join(R.repo, HISTORIA_870);
  const cerrada = [['    acs_pending: [1, 2]', '    acs_pending: []'], ['    tests_pending: [T1]', '    tests_pending:\n      - T1\n      - T2'],
    ['    tasks_pending: [1]', '    tasks_pending:\n    - 1\n    - 2']].reduce((s, [de, a]) => reemplazarTexto(s, de, a), fs.readFileSync(f, 'utf8').replace('    status: in-progress', '    status: done'));
  fs.writeFileSync(f, cerrada);
  const d = ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: HISTORIA_870 });
  assert.deepStrictEqual(d, { files: [], papeleo: [HISTORIA_870], deMain: [] });
});

// el guion de la prueba en vivo y el renglón del registro de humos que lo nombra
function conGuion(nombre, { huella } = {}) {
  const R = repoDeJuguete(nombre, { [HISTORIA_870]: historiaConTandas(), 'src/a.js': '1\n', '.advisors/dod-runtime/9.9-en-vivo.js': 'console.log(1);\n' });
  const antes = ft().seal(R.repo).tree;
  const guion = path.join(R.repo, '.advisors', 'dod-runtime', '9.9-en-vivo.js');
  fs.writeFileSync(guion, 'console.log(2);\n');
  const rel = '.advisors/dod-runtime/9.9-en-vivo.js';
  fs.writeFileSync(path.join(R.repo, '.advisors', 'dod-runtime', '9.9-smoke-ledger.jsonl'),
    `${JSON.stringify({ v: 2, story: '9.9', acs: [1], exit: 0, cmd: `node ${rel}`, script: rel, script_sha: huella || sha256('console.log(2);\n') })}\n`);
  return { R, antes, rel };
}

test('Seal_LiveCheckScriptNamedByLedger_IsPaperwork @story-8.270 @ac-6 — el guion que el registro nombra con su huella es papeleo', () => {
  const { R, antes, rel } = conGuion('guion');
  const d = ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: HISTORIA_870 });
  assert.deepStrictEqual(d.files, [], JSON.stringify(d));
  assert.ok(d.papeleo.includes(rel), JSON.stringify(d));
});

test('Seal_LiveCheckScriptOtherHash_Counts @story-8.270 @ac-6 — con otra huella, o sin renglón que lo nombre, cuenta', () => {
  const { R, antes, rel } = conGuion('otra-huella', { huella: sha256('console.log(1);\n') });
  assert.deepStrictEqual(ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: HISTORIA_870 }).files, [rel]);
  fs.writeFileSync(path.join(R.repo, '.advisors', 'dod-runtime', '9.9-smoke-ledger.jsonl'), `${JSON.stringify({ v: 2, story: '9.9', acs: [1], exit: 0 })}\n`);
  assert.deepStrictEqual(ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: HISTORIA_870 }).files, [rel]);
});

test('Seal_RuntimeExemptMarkEveryForm_IsPaperwork @story-8.270 @ac-4 — (pase de la 8.270) la marca entre comillas invertidas, en su renglón, con el motivo partido o después de un bloque de código', () => {
  // las formas que escriben las historias reales y la que pide la guía del pipeline (entre comillas invertidas)
  const base = ['---', 'story: "9.9"', 'status: in-progress', '---', '', '## Acceptance Criteria', '',
    '1. **Given** algo **Then** resultado.', '   ```bash', '   # un comentario dentro del bloque', '   node x.js', '   ```',
    '2. **Given** otra cosa **Then** otro resultado.', '', '## Tasks', '', '- [ ] Task 1', ''].join('\n');
  const formas = [
    ['entre comillas invertidas', (s) => s.replace('**Then** resultado.', '**Then** resultado. `@runtime-exempt(DODRT-C8): se lee`')],
    ['en su renglón', (s) => s.replace('**Then** resultado.', '**Then** resultado.\n   @runtime-exempt(DODRT-C8): se lee')],
    ['en su renglón, entre comillas', (s) => s.replace('**Then** resultado.', '**Then** resultado.\n   `@runtime-exempt(DODRT-C8): se lee`')],
    ['con el motivo partido', (s) => s.replace('**Then** resultado.', '**Then** resultado.\n   @runtime-exempt(DODRT-C8): se lee y no se\n   ejecuta nunca')],
    ['después de un bloque con #', (s) => s.replace('**Then** otro resultado.', '**Then** otro resultado. @runtime-exempt(DODRT-C8): se lee')],
  ];
  for (const [nombre, cambio] of formas) {
    assert.strictEqual(ft().sinPapeleoDeLaHistoria(cambio(base)), ft().sinPapeleoDeLaHistoria(base), nombre);
  }
  // lo que sigue a la marca y es otro criterio, otra sección o texto nuevo sigue contando
  const conMarca = formas[1][1](base);
  assert.notStrictEqual(ft().sinPapeleoDeLaHistoria(conMarca.replace('2. **Given** otra cosa', '2. **Given** otra cosa distinta')), ft().sinPapeleoDeLaHistoria(base));
  assert.notStrictEqual(ft().sinPapeleoDeLaHistoria(base.replace('# un comentario dentro del bloque', '# otro comentario')), ft().sinPapeleoDeLaHistoria(base));
});

test('Seal_AcWordingOrBatchFilesChanged_Counts @story-8.270 @ac-7 @ac-19 — el texto de un criterio, los archivos de una tanda o el código siguen contando', () => {
  const casos = [
    ['texto', (s) => s.replace('**Then** resultado.', '**Then** resultado distinto.'), [HISTORIA_870]],
    ['files', (s) => s.replace('      - src/a.js', '      - src/a.js\n      - src/b.js'), [HISTORIA_870]],
    ['name', (s) => s.replace('la tanda A', 'otra tanda'), [HISTORIA_870]],
  ];
  for (const [nombre, cambio, esperado] of casos) {
    const R = repoDeJuguete(`cuenta-${nombre}`, { [HISTORIA_870]: historiaConTandas(), 'src/a.js': '1\n' });
    const antes = ft().seal(R.repo).tree;
    const f = path.join(R.repo, HISTORIA_870);
    fs.writeFileSync(f, cambio(fs.readFileSync(f, 'utf8')));
    assert.deepStrictEqual(ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: HISTORIA_870 }).files, esperado, nombre);
  }
  const R = repoDeJuguete('cuenta-codigo', { [HISTORIA_870]: historiaConTandas(), 'src/a.js': '1\n' });
  const antes = ft().seal(R.repo).tree;
  fs.writeFileSync(path.join(R.repo, 'src', 'a.js'), '2\n');
  assert.deepStrictEqual(ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: HISTORIA_870 }).files, ['src/a.js']);
});

test('SmokeRun_LiveCheckScript_LedgerCarriesScriptSha @story-8.270 @ac-23 — el renglón del humo trae el guion que corrió y su huella', () => {
  const R = repoConHistoria();
  fs.mkdirSync(R.dodDir, { recursive: true });
  const guion = path.join(R.dodDir, '9.8-en-vivo.js');
  fs.writeFileSync(guion, 'process.exit(0);\n');
  const correr = (args) => spawnSync('bash', [SMOKE, R.dodDir, R.story, '--acs', '1', '--pass-if', 'sale 0', '--', ...args], {
    encoding: 'utf8', cwd: R.repo, env: { ...process.env, HOME: R.home, USERPROFILE: R.home, TYCON_HOME: '', CLAUDE_CODE_SESSION_ID: 's-humo' },
  });
  let r = correr(['node', '.advisors/dod-runtime/9.8-en-vivo.js', 'x']);
  assert.strictEqual(r.status, 0, r.stderr);
  r = correr(['echo', 'hola']);
  assert.strictEqual(r.status, 0, r.stderr);
  // otra forma: dentro de una consola, la palabra es todo el texto, y no nombra el guion
  r = correr(['bash', '-c', 'node .advisors/dod-runtime/9.8-en-vivo.js']);
  assert.strictEqual(r.status, 0, r.stderr);
  const [conGuionL, sinGuion, enConsola] = renglones(R);
  assert.strictEqual(conGuionL.script, '.advisors/dod-runtime/9.8-en-vivo.js');
  assert.strictEqual(conGuionL.script_sha, sha256('process.exit(0);\n'));
  for (const e of [sinGuion, enConsola]) assert.ok(!('script' in e) && !('script_sha' in e), JSON.stringify(e));
});

test('Seal_QaLegibilidadUiAfterRound_IsPaperwork @story-8.271 @ac-3 @ac-15 — la revisión de la pantalla en qa/ al lado de specs/ es papeleo; el código no', () => {
  const R = repoDeJuguete('qa-al-lado', { 'specs/story-9.9.md': '---\nstory: "9.9"\n---\n', 'qa/9.9-legibilidad-ui.md': 'antes\n', 'src/a.js': 'module.exports = 1;\n' });
  const antes = ft().seal(R.repo).tree;
  fs.writeFileSync(path.join(R.repo, 'qa', '9.9-legibilidad-ui.md'), 'después\n');
  let d = ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: 'specs/story-9.9.md' });
  assert.deepStrictEqual(d.files, [], JSON.stringify(d));
  assert.deepStrictEqual(d.papeleo, ['qa/9.9-legibilidad-ui.md']);
  fs.writeFileSync(path.join(R.repo, 'src', 'a.js'), 'module.exports = 2;\n');
  d = ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: 'specs/story-9.9.md' });
  assert.deepStrictEqual(d.files, ['src/a.js']);
});

test('T16 ReviewedTree_ControlChangeConstancy_NotAChange @story-8.277 @ac-22 — una constancia de cambio de control después de la vuelta es papeleo', () => {
  const C = corrida('s-ft-t16');
  C.vuelta();
  fs.mkdirSync(path.join(C.codigo.repo, '.github', 'control-changes'), { recursive: true });
  fs.writeFileSync(path.join(C.codigo.repo, '.github', 'control-changes', 'x.json'), '{"firma":"acme"}\n');
  const r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  assert.match(salida(r), /papeleo[^\n]*\.github\/control-changes\/x\.json/, salida(r));
});

test('T16 ReviewedTree_CodeOrOtherDotFile_StillBlocks @story-8.277 @ac-22 — un .js o un workflow después de la vuelta siguen frenando', () => {
  for (const [sid, rel] of [['s-ft-t16b', 'src/b.js'], ['s-ft-t16c', '.github/workflows/ci.yml']]) {
    const C = corrida(sid);
    C.vuelta();
    fs.mkdirSync(path.dirname(path.join(C.codigo.repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(C.codigo.repo, rel), 'cambio\n');
    const r = prepararCommit(C);
    assert.strictEqual(r.status, 2, salida(r));
    assert.match(salida(r), MISMATCH, salida(r));
    assert.ok(salida(r).includes(rel), `${rel} nombrado: ${salida(r)}`);
  }
});

test('T11 FrozenTree_ReemplazoLiteral_SinHallazgoCodeQL @story-8.283 @ac-21 — un reemplazo de texto con forma de expresión regular se escribe como texto', () => {
  // CodeQL marca «String instead of regular expression» en un `.replace` cuyo texto lleva corchetes: se lee como si
  // quisiera ser una expresión. Acá esos reemplazos van por `reemplazarTexto`, que dice que es un texto literal.
  const fuente = fs.readFileSync(__filename, 'utf8');
  const conCorchete = [...fuente.matchAll(/\.replace\(('(?:[^'\\\n]|\\.)*')/g)].map((m) => m[1]).filter((s) => s.includes('['));
  assert.deepStrictEqual(conCorchete, []);
  assert.strictEqual(reemplazarTexto('a [x] b [x]', '[x]', '[ok]'), 'a [ok] b [x]');
  assert.strictEqual(reemplazarTexto('sin nada', '[x]', '[ok]'), 'sin nada');
});

// ── Mover un comentario no reabre a los revisores (historia 8.217) ──────────────────────────────────────────────
// Una corrida de juguete con una vuelta sellada y cerrada: `src/a.js` trae un comentario antes de la vuelta, y después
// se edita. El primer freno (`reviewersRound`) se mira en este proceso, con la HOME de la corrida; el segundo, con
// `complete-step prepare-commit`.
const PRE_8217 = "'use strict';\n";
const A_REVISADO = `${PRE_8217}// la suma de los dos\nconst a = 1;\nconst b = 2;\nmodule.exports = a + b;\n`;
const A_MOVIDO = `${PRE_8217}const a = 1;\nconst b = 2;\n// la suma de los dos\nmodule.exports = a + b;\n`;
const A_CODIGO = `${PRE_8217}// la suma de los dos\nconst a = 1;\nconst b = 3;\nmodule.exports = a + b;\n`;
const B_REVISADO = `${PRE_8217}module.exports = 2;\n`;
const B_CODIGO = `${PRE_8217}module.exports = 20;\n`;
const HECHOS_8217 = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings'];

/** Una corrida con `src/a.js` y `src/b.js` revisados en una vuelta (sellada, y cerrada si `cerrar`). */
function corridaRevisada(sid, { cerrar = true, extra = {} } = {}) {
  const C = corrida(sid);
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'a.js'), A_REVISADO);
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'b.js'), B_REVISADO);
  for (const [rel, txt] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(C.codigo.repo, rel)), { recursive: true }); fs.writeFileSync(path.join(C.codigo.repo, rel), txt); }
  const v = C.vuelta();
  assert.strictEqual(v.r.status, 0, salida(v.r));
  const cierre = Date.now() + 1000;
  const archivo = path.join(C.estado(), 'active', `${sid}.json`);
  const escribir = (cambios) => { const m = JSON.parse(fs.readFileSync(archivo, 'utf8')); fs.writeFileSync(archivo, JSON.stringify({ ...m, ...cambios(m) }, null, 2)); };
  if (cerrar) {
    escribir((m) => ({ stepScheme: 2, stepsCompleted: [...new Set([...(m.stepsCompleted || []), ...HECHOS_8217])],
      stepsPending: ['live-check', 'prepare-commit'], stepTimings: { ...(m.stepTimings || {}), reviewers: { completedAt: new Date(cierre).toISOString(), rounds: 1 } } }));
  }
  let n = 0;
  /** Una edición posterior al cierre, con su evento como lo anota on-edit (si `evento`). */
  const editar = (rel, txt, { evento = true } = {}) => {
    const abs = path.join(C.codigo.repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, txt);
    if (evento) escribir((m) => ({ fileEvents: [...(m.fileEvents || []), { path: abs, ts: new Date(cierre + 1000 * ++n).toISOString(), code: true }] }));
  };
  /** El primer freno, en este proceso, con la HOME de la corrida. */
  const ronda = (opts) => {
    const antes = process.env.HOME;
    process.env.HOME = C.home;
    try { return require(path.join(SCRIPTS, 'lib', 'steps.js')).reviewersRound(C.marcador(), opts); } finally { process.env.HOME = antes; }
  };
  return { ...C, cierre, editar, escribir, ronda };
}
const gatesDe = (C) => fs.readFileSync(path.join(C.estado(), 'gates.log'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } });

test('T2 ReviewersRound_BloqueSubidoSobreComentario_NoPideVuelta @story-8.217 @ac-1 — un comentario movido no pide otra vuelta', () => {
  const C = corridaRevisada('s-ft-8217-t2');
  C.editar('src/a.js', A_MOVIDO);
  assert.strictEqual(C.ronda(), null);
  const antes = process.env.HOME;
  process.env.HOME = C.home;
  try { assert.strictEqual(require(path.join(SCRIPTS, 'lib', 'steps.js')).otraVueltaDe(C.marcador()), null); } finally { process.env.HOME = antes; }
});

test('T3 ReviewedTree_ComentarioMovido_NoFrenaYLoDice @story-8.217 @ac-2 — «Preparar el pull request» sigue y lo anota', () => {
  const C = corridaRevisada('s-ft-8217-t3');
  C.editar('src/a.js', A_MOVIDO);
  const r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  assert.match(salida(r), /sólo se movieron comentarios: src\/a\.js/, salida(r));
  const ok = gatesDe(C).filter((g) => g.name === 'reviewed-tree' && g.status === 'ok').pop();
  assert.strictEqual(ok && ok.comentarios_movidos, 1, JSON.stringify(ok));
});

test('T4 ReviewersRound_ContenidoIgualAlSello_NoPideVuelta @story-8.217 @ac-3 — vuelto a lo revisado: un .js y un .ts no cuentan; un .py sí', () => {
  // el .ts se lee desde lib/change-kind.js; un lenguaje sin lector sigue contando como código
  const C = corridaRevisada('s-ft-8217-t4', { extra: { 'src/c.ts': 'export const c = 1;\n', 'src/d.py': 'c = 1\n' } });
  C.editar('src/a.js', A_CODIGO);
  C.editar('src/a.js', A_REVISADO);
  C.editar('src/c.ts', 'export const c = 2;\n');
  C.editar('src/c.ts', 'export const c = 1;\n');
  C.editar('src/d.py', 'c = 2\n');
  C.editar('src/d.py', 'c = 1\n');
  const r = C.ronda();
  assert.ok(r, 'la vuelta se pide por el .py');
  assert.deepStrictEqual(r.archivos, ['src/d.py']);
});

// ── Sólo comentarios no pide vuelta; sólo textos pide la vuelta chica ──
const B_TEXTO = "'use strict';\nmodule.exports = { n: 2, motivo: 'sin permiso' };\n";
test('T80b ReviewersRound_ComentarioCambiado_NoPideVuelta: el texto de un comentario cambiado, en un .ts, no reabre a los revisores', () => {
  const C = corridaRevisada('s-ft-80b', { extra: { 'src/c.ts': '// la constante\nexport const c = 1;\n' } });
  C.editar('src/c.ts', '// la constante de la prueba, explicada\nexport const c = 1;\n');
  assert.strictEqual(C.ronda(), null);
});

test('T80c ReviewersRound_SoloTextos_VueltaChica: un texto cambiado pide la vuelta chica; con la otra decisión, ninguna', () => {
  const C = corridaRevisada('s-ft-80c', { extra: { 'src/m.js': B_TEXTO } });
  C.editar('src/m.js', B_TEXTO.replace('sin permiso', 'no autorizado'));
  const r = C.ronda();
  assert.ok(r, 'la vuelta se pide');
  assert.deepStrictEqual(r.archivos, ['src/m.js']);
  assert.strictEqual(r.chica, true, JSON.stringify(r));
  // `next` lo dice al pedir la vuelta
  assert.match(salida(C.correr('pipeline.js', ['next'])), /Sólo cambiaron textos: es una vuelta chica/);
  assert.strictEqual(C.ronda({ textosConVueltaChica: false }), null, 'si el dueño elige que los textos no pidan vuelta');
  // un texto y una línea de código: la vuelta de siempre
  C.editar('src/b.js', B_CODIGO);
  const r2 = C.ronda();
  assert.deepStrictEqual(r2.archivos.sort(), ['src/b.js', 'src/m.js']);
  assert.strictEqual(r2.chica, undefined, JSON.stringify(r2));
});

test('T80j ReviewersRound_ArchivoGrande_CuentaComoCodigo: un archivo de más de 256 KiB no se lee en el gancho y cuenta como código', () => {
  const grande = `${B_TEXTO}${'const x = 1;\n'.repeat(22000)}`;
  const C = corridaRevisada('s-ft-80j', { extra: { 'src/g.js': grande } });
  C.editar('src/g.js', grande.replace('sin permiso', 'no autorizado'));
  const r = C.ronda();
  assert.deepStrictEqual(r && r.archivos, ['src/g.js']);
  assert.strictEqual(r.chica, undefined, JSON.stringify(r));
  // la comparación del sello tampoco lo lee: un comentario cambiado en un archivo grande cuenta como cambio
  const sello = require(path.join(SCRIPTS, 'lib', 'frozen-tree.js'));
  const g = (...a) => spawnSync('git', ['-C', C.codigo.repo, ...a], { encoding: 'utf8' }).stdout.trim();
  const blob = (txt) => { fs.writeFileSync(path.join(C.codigo.repo, 'src', 'g.js'), txt); g('add', 'src/g.js'); return g('write-tree'); };
  const antes = blob(grande);
  const despues = blob(grande.replace("'use strict';\n", "'use strict';\n// nota\n"));
  const c = sello.changed(C.codigo.repo, antes, despues, { comentarios: true });
  assert.ok(c.files.includes('src/g.js'), JSON.stringify(c));
  const chico = blob(B_TEXTO);
  const chicoConNota = blob(B_TEXTO.replace("'use strict';\n", "'use strict';\n// nota\n"));
  assert.deepStrictEqual(sello.changed(C.codigo.repo, chico, chicoConNota, { comentarios: true }).comentarios, ['src/g.js'], 'uno chico sí se lee');
});

test('T80d ReviewersRound_PedidaComoCodigo_NoSeAchica: lo ya pedido como código no se vuelve chico con un texto después', () => {
  const C = corridaRevisada('s-ft-80d', { extra: { 'src/m.js': B_TEXTO } });
  C.escribir(() => ({ otraVuelta: { round: 2, archivos: ['src/b.js'], desde: new Date(C.cierre + 500).toISOString() } }));
  C.editar('src/m.js', B_TEXTO.replace('sin permiso', 'no autorizado'));
  const r = C.ronda();
  assert.deepStrictEqual(r.archivos.sort(), ['src/b.js', 'src/m.js']);
  assert.strictEqual(r.chica, undefined, JSON.stringify(r));
});

/**
 * Los lanzamientos de los revisores de la vuelta `iter`, como los anota el gancho de cada lanzamiento: después del sello
 * de la vuelta, o antes con `antes` (un set pedido otra vez a mitad de la vuelta la vuelve a sellar).
 */
function lanzarRevisores(C, iter, { antes = false } = {}) {
  const reg = path.join(C.estado(), 'advisor-runs', `${C.sid}.jsonl`);
  const inicio = fs.readFileSync(reg, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.event === 'step5-start' && Number(l.iter) === 1).pop();
  const ts = new Date(antes ? Date.parse(inicio.ts) - 60000 : C.cierre - 200).toISOString();
  const nuevas = iter === 1 ? [] : [{ ts: new Date(C.cierre - 400).toISOString(), event: 'step5-start', iter, expected: inicio.expected }];
  for (const a of inicio.expected) nuevas.push({ ts, advisor: a });
  fs.appendFileSync(reg, `${nuevas.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** La foto de la vuelta 1, de antes del cierre, como la deja el arnés al lanzar el último revisor, y sus lanzamientos. */
function conFotoDeLaVuelta(C, rels, { antes = false } = {}) {
  const abs = rels.map((r) => path.join(C.codigo.repo, r));
  C.escribir(() => ({ iterations: { 1: { ts: new Date(C.cierre - 500).toISOString(), filesSnapshot: abs } }, filesTouched: abs }));
  lanzarRevisores(C, 1, { antes });
}

test('T80f SmartReloop_SoloTextos_VueltaChica: con sólo textos cambiados vuelve el revisor de seguridad; con código, el set de siempre', () => {
  const C = corridaRevisada('s-ft-80f', { extra: { 'src/m.js': B_TEXTO } });
  conFotoDeLaVuelta(C, ['src/a.js', 'src/b.js', 'src/m.js']);
  C.editar('src/m.js', B_TEXTO.replace('sin permiso', 'no autorizado'));
  const v = C.vuelta(2);
  assert.strictEqual(v.r.status, 0, salida(v.r));
  assert.strictEqual(v.json.mode, 'small-round', salida(v.r));
  assert.deepStrictEqual(v.json.rerun, ['tycon-plugin-security-basics']);
  assert.ok(v.json.skipped.length > 0 && v.json.skipped.every((s) => /textos/.test(s.reason)), JSON.stringify(v.json.skipped));
  C.editar('src/b.js', B_CODIGO);
  const v2 = C.vuelta(2);
  assert.strictEqual(v2.r.status, 0, salida(v2.r));
  assert.notStrictEqual(v2.json.mode, 'small-round', salida(v2.r));
});

test('T80i SmartReloop_RevisorLanzadoAntesDelSello_NoAchica: si un revisor no leyó el sello, ni se cierra sola ni es chica', () => {
  // el set se pidió otra vez a mitad de la vuelta: el sello trae un arreglo que los revisores lanzados antes no vieron
  for (const [nombre, editar] of [['un texto', (C) => C.editar('src/m.js', B_TEXTO.replace('sin permiso', 'no autorizado'))],
    ['un comentario', (C) => C.editar('src/m.js', B_TEXTO.replace("'use strict';\n", "'use strict';\n// el motivo\n"))]]) {
    const C = corridaRevisada(`s-ft-80i-${nombre.length}`, { extra: { 'src/m.js': B_TEXTO } });
    conFotoDeLaVuelta(C, ['src/a.js', 'src/b.js', 'src/m.js'], { antes: true });
    editar(C);
    const v = C.vuelta(2);
    assert.strictEqual(v.r.status, 0, salida(v.r));
    assert.notStrictEqual(v.json.mode, 'small-round', `${nombre}: ${salida(v.r)}`);
    assert.ok(!v.json.no_code_delta, `${nombre}: la vuelta no se cierra sola`);
    assert.ok(v.json.rerun.length > 1, `${nombre}: ${JSON.stringify(v.json.rerun)}`);
  }
});

test('T80g Tope_VueltaChica_PasaSinFirma: pasado el tope, sólo textos se sirve sin firma y queda anotado; código pide la vuelta extra', () => {
  const tope = { '.tycon/advisors.yaml': 'review:\n  max_rounds: 1\n' };
  // el tope del repo se lee de lo commiteado
  const commitearElTope = (X) => {
    for (const a of [['add', '.tycon/advisors.yaml'], ['commit', '-qm', 'tope']]) {
      const g = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', X.codigo.repo, ...a], { encoding: 'utf8' });
      assert.strictEqual(g.status, 0, g.stderr);
    }
  };
  const C = corridaRevisada('s-ft-80g', { extra: { 'src/m.js': B_TEXTO, ...tope } });
  commitearElTope(C);
  conFotoDeLaVuelta(C, ['src/a.js', 'src/b.js', 'src/m.js']);
  C.editar('src/m.js', B_TEXTO.replace('sin permiso', 'no autorizado'));
  const v = C.vuelta(2);
  assert.strictEqual(v.r.status, 0, salida(v.r));
  assert.strictEqual(v.json.mode, 'small-round', salida(v.r));
  assert.match(v.r.stderr, /pasa el tope de 1 como vuelta chica/);
  assert.ok(gatesDe(C).some((g) => g.name === 'small-round' && g.status === 'ok'), 'la vuelta chica queda anotada');
  const C2 = corridaRevisada('s-ft-80g2', { extra: tope });
  commitearElTope(C2);
  conFotoDeLaVuelta(C2, ['src/a.js', 'src/b.js']);
  C2.editar('src/b.js', B_CODIGO);
  const v2 = C2.vuelta(2);
  assert.strictEqual(v2.r.status, 3, salida(v2.r));
  assert.match(v2.r.stderr, /Llegaste al tope de 1/);
  assert.ok(!gatesDe(C2).some((g) => g.name === 'small-round'), 'el código no pasa como vuelta chica');
  // con un crítico de seguridad abierto, la vuelta chica tampoco pasa el tope: lo decide una persona
  const C3 = corridaRevisada('s-ft-80g3', { extra: { 'src/m.js': B_TEXTO, ...tope } });
  commitearElTope(C3);
  conFotoDeLaVuelta(C3, ['src/a.js', 'src/b.js', 'src/m.js']);
  const corridas = path.join(C3.codigo.repo, '.advisors', 'pipeline-runs');
  const run = path.join(corridas, fs.readdirSync(corridas)[0]);
  fs.writeFileSync(path.join(run, 'findings.json'), JSON.stringify([{ rule_id: 'SEC-C1', severity: 'CRITICAL', advisor: 'tycon-plugin-security-basics', file: 'src/m.js', disposition: 'open' }]));
  C3.editar('src/m.js', B_TEXTO.replace('sin permiso', 'no autorizado'));
  const v3 = C3.vuelta(2);
  assert.strictEqual(v3.r.status, 3, salida(v3.r));
  assert.match(v3.r.stderr, /SEC-C1/);
  assert.ok(!gatesDe(C3).some((g) => g.name === 'small-round'), 'con un crítico abierto no pasa como vuelta chica');
});

// Caso: tras la última vuelta permitida sólo cambiaron pruebas E2E y la historia. El portón de «Preparar» lo contaba como
// código sin revisar y pedía otra vuelta; el re-loop la negaba por el tope y hacía falta la firma del dueño para una vuelta
// que salía vacía. Una vuelta sin código se cierra sola: sin tope, sin firma y sin nota de repensar.
// 🔴 Falla con: la vuelta sin código frenada por el tope (sale 3), o una firma de vuelta extra anotada.
test('Tope_VueltaSinCodigo_SeCierraSolaSinFirma: pasado el tope, sólo pruebas E2E y la historia se cierran solas', () => {
  const C = corridaRevisada('s-ft-a66', { extra: { '.tycon/advisors.yaml': 'review:\n  max_rounds: 1\n' } });
  for (const a of [['add', '.tycon/advisors.yaml'], ['commit', '-qm', 'tope']]) {
    const g = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', C.codigo.repo, ...a], { encoding: 'utf8' });
    assert.strictEqual(g.status, 0, g.stderr);
  }
  conFotoDeLaVuelta(C, ['src/a.js', 'src/b.js']);
  C.editar('tests/e2e/flujo.spec.ts', "test('flujo', async () => { expect(1).toBe(1); });\n");
  fs.writeFileSync(C.story, fs.readFileSync(C.story, 'utf8').replace('- hoy: escrita', '- hoy: escrita\n- después: pruebas E2E'));
  const v = C.vuelta(2);
  assert.strictEqual(v.r.status, 0, salida(v.r));
  assert.strictEqual(v.json.no_code_delta, true, salida(v.r));
  assert.deepStrictEqual(v.json.rerun, []);
  assert.ok(!gatesDe(C).some((g) => g.name === 'extra-round'), 'una vuelta sin código no pide firma');
  // el código, en cambio, sigue frenando en el tope
  C.editar('src/b.js', B_CODIGO);
  const v2 = C.vuelta(3);
  assert.strictEqual(v2.r.status, 3, salida(v2.r));
  assert.match(v2.r.stderr, /Llegaste al tope de 1/);
});

// El otro lado: el portón de «Preparar» usa el lector del re-loop y, de lo que el re-loop no revisa, perdona sólo lo que
// no se ejecuta: una prueba del proyecto cambiada después de la vuelta no pide otra. El código, una nota .md suelta (puede
// ser la instrucción de un agente), la configuración y la historia siguen por sus reglas.
// 🔴 Falla con: una prueba E2E cambiada después de la vuelta que frena, o un .js o una nota .md que no frenan.
test('PrepareCommit_PruebasDespuesDeLaVuelta_NoFrenan: el mismo lector de código que el re-loop', () => {
  const C = corrida('s-ft-a66-b');
  C.vuelta();
  fs.mkdirSync(path.join(C.codigo.repo, 'tests', 'e2e'), { recursive: true });
  fs.writeFileSync(path.join(C.codigo.repo, 'tests', 'e2e', 'flujo.spec.ts'), "test('flujo', () => {});\n");
  let r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  assert.match(salida(r), /no se ejecuta[^\n]*tests\/e2e\/flujo\.spec\.ts/, salida(r));
  // una nota suelta, la configuración de una herramienta y el código siguen frenando
  fs.mkdirSync(path.join(C.codigo.repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(C.codigo.repo, 'docs', 'notas.md'), '# notas\n');
  fs.writeFileSync(path.join(C.codigo.repo, 'package.json'), '{"scripts":{"test":"true"}}\n');
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'b.js'), 'module.exports = 3;\n');
  r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /package\.json/);
  assert.match(salida(r), /src\/b\.js/);
  assert.match(salida(r), /docs\/notas\.md/);
  assert.doesNotMatch(salida(r), /· tests\/e2e\/flujo\.spec\.ts/);
});

// Pasado el tope, la coordinadora no firma sola un cambio de código. «Preparar»
// dice las tres salidas: volver a lo revisado (con los comandos), llevarlo a una historia de arreglo, o la vuelta extra
// que firma el dueño.
// 🔴 Falla con: el aviso que sólo manda a otra vuelta, comandos que no vuelven a lo revisado, o un `$` que se expande.
test('PrepareCommit_PastTheCap_RestoreToReviewed: pasado el tope, los comandos para volver a lo revisado', () => {
  const C = corrida('s-ft-s254-tope', { antesDeArrancar: (codigo) => {
    fs.mkdirSync(path.join(codigo.repo, '.tycon'), { recursive: true });
    fs.writeFileSync(path.join(codigo.repo, '.tycon', 'advisors.yaml'), 'review:\n  max_rounds: 1\n');
    for (const a of [['add', '.tycon/advisors.yaml'], ['commit', '-qm', 'tope']]) {
      const g = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', codigo.repo, ...a], { encoding: 'utf8' });
      assert.strictEqual(g.status, 0, g.stderr);
    }
  } });
  assert.strictEqual(C.vuelta(1).r.status, 0);
  // un arreglo después de la última vuelta: un .js cambiado, uno nuevo sin agregar y uno con `$` en el nombre
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'b.js'), 'module.exports = 3;\n');
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'c.js'), 'module.exports = 4;\n');
  fs.writeFileSync(path.join(C.codigo.repo, 'src', '$HOME`id`.js'), 'module.exports = 5;\n');
  const r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /Pasaste el tope de 1 vuelta/, salida(r));
  assert.match(salida(r), /historia de arreglo/);
  assert.match(salida(r), /--extra-round[^\n]*(\n[^\n]*)?el dueño/);
  const comandos = salida(r).split('\n').map((l) => l.trim()).filter((l) => /^git -C /.test(l));
  assert.ok(comandos.some((l) => / stash push --include-untracked /.test(l)), salida(r));
  // los comandos, tal cual y con el shell, guardan el cambio y vuelven a lo revisado; el `$` no se expande
  for (const l of comandos) execFileSync('bash', ['-c', l], { stdio: 'ignore', env: { ...process.env, HOME: C.home } });
  assert.strictEqual(fs.existsSync(path.join(C.codigo.repo, 'src', 'c.js')), false);
  assert.match(execFileSync('git', ['-C', C.codigo.repo, 'stash', 'show', '--include-untracked', '--name-only'], { encoding: 'utf8' }), /src\/\$HOME`id`\.js/);
  const despues = prepararCommit(C);
  assert.doesNotMatch(salida(despues), MISMATCH, salida(despues));
});

// Caso: al abrir una historia de arreglo, el arnés le agrega a la que sigue su enlace `followed_up_by:` en el encabezado;
// después de la tercera vuelta, ese renglón pedía una cuarta que no existe. Es papeleo, como para la revisión del plan.
test('T35 StoryPaperwork_FollowedUpBy_IsPaperwork — el enlace a la historia que la sigue; otro campo del encabezado cuenta', () => {
  const base = ['---', 'story: "9.9"', 'title: "x"', 'status: review', '---', '# h', '', '## Acceptance Criteria', '', '1. algo', ''].join('\n');
  const conEnlace = base.replace('status: review\n', 'status: review\nfollowed_up_by:\n  - id: "9.10"\n    date: "2026-11-20"\n    summary: "el arreglo"\n');
  const aLaMisma = base.replace('status: review\n', 'status: review\nfollowed_up_by:\n- id: "9.10"\n  type: "gap-fill"\n');
  assert.strictEqual(ft().sinPapeleoDeLaHistoria(conEnlace), ft().sinPapeleoDeLaHistoria(base));
  assert.strictEqual(ft().sinPapeleoDeLaHistoria(aLaMisma), ft().sinPapeleoDeLaHistoria(base));
  // otro campo del encabezado, o uno que viene después del enlace, sigue contando
  assert.notStrictEqual(ft().sinPapeleoDeLaHistoria(base.replace('title: "x"', 'title: "y"')), ft().sinPapeleoDeLaHistoria(base));
  const despues = conEnlace.replace('---\n# h', 'files_to_modify:\n  - src/a.js\n---\n# h');
  assert.notStrictEqual(ft().sinPapeleoDeLaHistoria(despues), ft().sinPapeleoDeLaHistoria(base));
  // una clave que no es del enlace, escondida con sangría dentro de él, cuenta
  const escondida = conEnlace.replace('    summary: "el arreglo"\n', '    summary: "el arreglo"\n  files_to_create:\n    - src/b.js\n');
  assert.notStrictEqual(ft().sinPapeleoDeLaHistoria(escondida), ft().sinPapeleoDeLaHistoria(base));
});

// Caso: en un producto con la historia y el código en el mismo repo, la corrida en una copia de trabajo
// (worktree) y la historia nombrada en la copia principal. Después de la tercera vuelta sólo cambió el papeleo de la
// historia en la copia (el registro de cambios y la sección de seguimientos, nueva), y el freno la contaba como código.
test('T36 PrepareCommit_StoryInAnotherCopyOfTheRepo_PaperworkStillPaperwork — la misma historia en otra copia del repo', () => {
  const base = tmp('ft-copia-');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  const historia = ['---', 'story: "9.9"', 'title: "sello"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '---',
    '# Story 9.9', '', '## Acceptance Criteria', '', '1. **Given** algo, **Then** resultado.', '', '### Tests', '',
    '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|', '| T1 | `a.caso1` | 1 | unit | x | y |', '',
    '## Tasks / Subtasks', '', '- [ ] Task 1: hacerlo (AC: 1)', '', '## Change Log', '', '- hoy: escrita', ''].join('\n');
  const uno = repoDeJuguete('uno', { 'stories/story-9.9-sello.md': historia, 'src/a.js': 'module.exports = 1;\n' });
  const copia = path.join(base, 'uno--wt-9.9');
  uno.git('worktree', 'add', '-q', '-b', 'wt/9.9', copia);
  const enLaPrincipal = path.join(uno.repo, 'stories', 'story-9.9-sello.md');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 's-ft36', TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off' };
  for (const k of ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID']) delete env[k];
  const correr = (script, args) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env, input: '', cwd: copia });
  const r0 = correr('pipeline.js', ['start', '--story', enLaPrincipal, '--repo', copia, '--brief']);
  assert.strictEqual(r0.status, 0, salida(r0));
  const v = correr('pipeline.js', ['advisors', '--story', enLaPrincipal, '--repo', copia, '--files', 'src/a.js', '--iter', '1']);
  assert.strictEqual(v.status, 0, salida(v));
  // en la copia: entradas nuevas en el registro y la sección de seguimientos que escribe «Hallazgos», por primera vez
  const enLaCopia = path.join(copia, 'stories', 'story-9.9-sello.md');
  fs.writeFileSync(enLaCopia, `${fs.readFileSync(enLaCopia, 'utf8')}- después: revisores, vuelta 1\n${SEGUIMIENTOS}`);
  let r = correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order']);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  // un criterio cambiado en la copia sigue contando
  fs.writeFileSync(enLaCopia, fs.readFileSync(enLaCopia, 'utf8').replace('**Then** resultado.', '**Then** otro resultado.'));
  r = correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order']);
  assert.match(salida(r), MISMATCH, salida(r));
});

// Caso: después de la tercera vuelta, «Probar en vivo» marcó un criterio con
// `@sin-pantalla` y pedía una cuarta vuelta. La marca de pantalla de un criterio es papeleo; el texto del criterio, no.
test('T37 StoryPaperwork_ScreenMarkOnCriterion_IsPaperwork — @sin-pantalla suelta; @pantalla, una marca pegada y el texto siguen contando', () => {
  const base = ['---', 'story: "9.9"', 'status: review', '---', '# h', '', '## Acceptance Criteria', '', '1. **Given** algo, **Then** resultado.', '', '## Tasks', ''].join('\n');
  for (const marca of [' `@sin-pantalla`', ' @sin-pantalla']) {
    assert.strictEqual(ft().sinPapeleoDeLaHistoria(base.replace('resultado.', `resultado.${marca}`)), ft().sinPapeleoDeLaHistoria(base), marca);
  }
  assert.notStrictEqual(ft().sinPapeleoDeLaHistoria(base.replace('resultado.', 'otro resultado. @sin-pantalla')), ft().sinPapeleoDeLaHistoria(base));
  // `@pantalla` (agregarla o cambiarla) y una marca pegada a otra palabra cuentan
  const conPantalla = base.replace('resultado.', 'resultado. @pantalla');
  assert.notStrictEqual(ft().sinPapeleoDeLaHistoria(conPantalla), ft().sinPapeleoDeLaHistoria(base));
  assert.notStrictEqual(ft().sinPapeleoDeLaHistoria(conPantalla.replace('@pantalla', '@sin-pantalla')), ft().sinPapeleoDeLaHistoria(conPantalla));
  assert.notStrictEqual(ft().sinPapeleoDeLaHistoria(base.replace('resultado.', 'resultado@sin-pantallax.')), ft().sinPapeleoDeLaHistoria(base));
  // fuera de los criterios, la palabra no se toca
  assert.notStrictEqual(ft().sinPapeleoDeLaHistoria(base.replace('## Tasks\n', '## Tasks\n\n- usar @sin-pantalla\n')), ft().sinPapeleoDeLaHistoria(base));
});

// Caso: después de la tercera vuelta, un control de la historia pidió cambiar la columna «Bloquea» del archivo de
// intención (`<historia>.intent.md`) de «sólo T14» a «no», y esa palabra pedía una cuarta vuelta. Las tablas de ese
// archivo son el registro de lo preguntado y lo decidido: papeleo. Su encabezado (el objetivo y los resultados) cuenta.
test('T38 Changed_IntentFile_TablesArePaperwork_HeaderCounts — el archivo de intención de la historia', () => {
  // 🔴 mutación: sacar la rama del archivo de intención en changed (entonces la respuesta cuenta como código).
  const intencion = ['---', 'id: story-9.9-sello', 'status: draft', 'objective: "que algo pase"', 'outcomes:', '  - "resultado uno"', '---', '',
    '# Sello', '', '## Preguntas abiertas', '', '| # | Pregunta | Bloquea | Estado | Respuesta |', '|---|---|---|---|---|',
    '| Q1 | ¿Algo? | sólo T14 | abierta | |', ''].join('\n');
  // la historia en `stories/`, como en los productos con la historia y el código en el mismo repo (`specs/` ya es papeleo)
  const R = repoDeJuguete('intencion', { 'stories/story-9.9-sello.md': '---\nstory: "9.9"\n---\n# 9.9\n', 'stories/story-9.9-sello.intent.md': intencion, 'src/a.js': '1;\n' });
  const rel = 'stories/story-9.9-sello.md';
  const relI = 'stories/story-9.9-sello.intent.md';
  const antes = ft().seal(R.repo).tree;
  const archivo = path.join(R.repo, relI);
  const cambiar = (de, a) => fs.writeFileSync(archivo, reemplazarTexto(fs.readFileSync(archivo, 'utf8'), de, a));
  const d = () => ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: rel });
  cambiar('| sólo T14 | abierta | |', '| no | contestada | Sí, con lo que dijo el dueño. |');
  cambiar('status: draft', 'status: approved');
  assert.deepStrictEqual([d().files, d().papeleo], [[], [relI]]);
  // el objetivo o un resultado cambiado cuenta
  cambiar('"resultado uno"', '"resultado distinto"');
  assert.deepStrictEqual(d().files, [relI]);
});

// Lo que no se ejecuta no pide otra vuelta (una imagen suelta, la guía o el informe de la historia en su carpeta qa), pero
// una instrucción para un agente o una imagen que compara una prueba visual sí: cambian lo que un agente hace o lo que la
// prueba acepta.
// 🔴 Falla con: una imagen suelta que frena, o una instrucción de un agente o una imagen de referencia que no frenan.
test('PrepareCommit_NoSeEjecuta_NoFrena_InstruccionesEImagenesDePrueba_Si', () => {
  const C = corrida('s-ft-noejec');
  C.vuelta();
  fs.mkdirSync(path.join(C.codigo.repo, 'docs', 'img'), { recursive: true });
  fs.writeFileSync(path.join(C.codigo.repo, 'docs', 'img', 'pantalla.png'), 'PNG');
  fs.mkdirSync(path.join(C.historias.repo, 'specs', 'qa'), { recursive: true });
  fs.writeFileSync(path.join(C.historias.repo, 'specs', 'qa', 'story-9.9-sello-informe.pdf'), 'PDF');
  let r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  const casos = [['skills/x/SKILL.md', '# haz esto\n'], ['CLAUDE.local.md', '# instrucciones\n'], ['tests/visual/__screenshots__/home.png', 'PNG2']];
  for (const [rel, txt] of casos) {
    const C2 = corrida(`s-ft-noejec-${rel.length}`);
    C2.vuelta();
    fs.mkdirSync(path.dirname(path.join(C2.codigo.repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(C2.codigo.repo, rel), txt);
    r = prepararCommit(C2);
    assert.strictEqual(r.status, 2, `${rel}: ${salida(r)}`);
    assert.match(salida(r), MISMATCH, `${rel}: ${salida(r)}`);
    assert.match(salida(r), new RegExp(rel.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), rel);
  }
});

test('T80h Rethink_VueltaChica_SinNota: la tercera vuelta, si es chica, no pide la nota de repensar; con código, sí', () => {
  const tercera = (C) => {
    const abs = ['src/a.js', 'src/b.js', 'src/m.js'].map((r) => path.join(C.codigo.repo, r));
    const foto = { ts: new Date(C.cierre - 500).toISOString(), filesSnapshot: abs };
    C.escribir(() => ({ iterations: { 1: foto, 2: foto }, filesTouched: abs }));
    lanzarRevisores(C, 2);
  };
  const C = corridaRevisada('s-ft-80h', { extra: { 'src/m.js': B_TEXTO } });
  tercera(C);
  C.editar('src/m.js', B_TEXTO.replace('sin permiso', 'no autorizado'));
  const v = C.vuelta(3);
  assert.strictEqual(v.r.status, 0, salida(v.r));
  assert.strictEqual(v.json.mode, 'small-round', salida(v.r));
  const C2 = corridaRevisada('s-ft-80h2', { extra: { 'src/m.js': B_TEXTO } });
  tercera(C2);
  C2.editar('src/b.js', B_CODIGO);
  const v2 = C2.vuelta(3);
  assert.strictEqual(v2.r.status, 3, salida(v2.r));
  assert.match(salida(v2.r), /repens|nota/i);
});

test('T80e ReviewedTree_ComentarioCambiado_NoFrena_TextoSi: «Preparar el pull request» perdona un comentario cambiado y frena un texto', () => {
  const C = corridaRevisada('s-ft-80e');
  C.editar('src/a.js', A_REVISADO.replace('la suma de los dos', 'la suma de a y b'), { evento: false });
  const r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  const C2 = corridaRevisada('s-ft-80e2', { extra: { 'src/m.js': B_TEXTO } });
  C2.editar('src/m.js', B_TEXTO.replace('sin permiso', 'no autorizado'), { evento: false });
  const r2 = prepararCommit(C2);
  assert.strictEqual(r2.status, 2, salida(r2));
  assert.match(salida(r2), MISMATCH);
  assert.match(salida(r2), /src\/m\.js/);
});

test('T7 ReviewedTree_CodigoCambiado_SigueFrenando @story-8.217 @ac-5 — una línea de código cambiada frena como hoy', () => {
  const C = corridaRevisada('s-ft-8217-t7');
  C.editar('src/a.js', A_CODIGO, { evento: false });
  const r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), MISMATCH, salida(r));
  assert.match(salida(r), /src\/a\.js/);
  assert.ok(gatesDe(C).some((g) => g.name === 'reviewed-tree-mismatch'));
});

test('T19 ReviewersRound_ConsolaYLuegoComentario_PideVuelta @story-8.217 @ac-13 — se compara el disco con lo revisado, no con la edición anterior', () => {
  const C = corridaRevisada('s-ft-8217-t19');
  // código por consola, sin evento; después una edición que sólo mueve el comentario de ese código
  C.editar('src/a.js', A_CODIGO, { evento: false });
  C.editar('src/a.js', A_CODIGO.replace('// la suma de los dos\nconst a = 1;\nconst b = 3;\n', 'const a = 1;\nconst b = 3;\n// la suma de los dos\n'));
  const r = C.ronda();
  assert.ok(r && r.archivos.includes('src/a.js'), JSON.stringify(r));
});

test('T20 ReviewedTree_ConsolaSinEvento_Frena @story-8.217 @ac-14 — un cambio de código por consola, sin evento, frena', () => {
  const C = corridaRevisada('s-ft-8217-t20');
  C.editar('src/b.js', B_CODIGO, { evento: false });
  const r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /src\/b\.js/);
});

test('T22 ReviewersRound_NoComparable_PideVuelta @story-8.217 @ac-15 — lo que no se puede comparar cuenta', () => {
  // archivo nuevo (no está en el sello)
  let C = corridaRevisada('s-ft-8217-t22a');
  C.editar('src/nuevo.js', `${PRE_8217}// x\nmodule.exports = 1;\n`);
  assert.deepStrictEqual((C.ronda() || {}).archivos, ['src/nuevo.js'], 'nuevo');
  // permisos cambiados
  C = corridaRevisada('s-ft-8217-t22b');
  C.editar('src/a.js', A_MOVIDO);
  fs.chmodSync(path.join(C.codigo.repo, 'src', 'a.js'), 0o755);
  assert.deepStrictEqual((C.ronda() || {}).archivos, ['src/a.js'], 'permisos');
  // vuelta de otra historia
  C = corridaRevisada('s-ft-8217-t22c');
  C.editar('src/a.js', A_MOVIDO);
  C.escribir(() => ({ storyId: '9.8' }));
  assert.deepStrictEqual((C.ronda() || {}).archivos, ['src/a.js'], 'otra historia');
  // vuelta sin historia
  C = corridaRevisada('s-ft-8217-t22d');
  C.editar('src/a.js', A_MOVIDO);
  const reg = path.join(C.estado(), 'frozen', 's-ft-8217-t22d', 'vueltas.jsonl');
  fs.writeFileSync(reg, fs.readFileSync(reg, 'utf8').split('\n').filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), story: null })).join('\n') + '\n');
  assert.deepStrictEqual((C.ronda() || {}).archivos, ['src/a.js'], 'story: null');
  // más de 20 archivos en la misma decisión
  C = corridaRevisada('s-ft-8217-t22e');
  C.editar('src/a.js', A_MOVIDO);
  for (let k = 0; k < 20; k++) C.editar(`src/otro-${k}.js`, `${PRE_8217}module.exports = ${k};\n`);
  assert.ok(((C.ronda() || {}).archivos || []).includes('src/a.js'), 'con 21 archivos no se mira ninguno');
});

test('T23 ReviewersRound_SelloSinCerrar_PideVuelta @story-8.217 @ac-16 — una vuelta lanzada y sin cerrar no perdona nada', () => {
  const C = corridaRevisada('s-ft-8217-t23');
  C.editar('src/a.js', A_CODIGO);
  // la vuelta 2 sella el arreglo y no cierra: después, sólo se mueve un comentario
  assert.strictEqual(C.vuelta(2).r.status, 0);
  // lanzada después del cierre de la vuelta 1 (la corrida de juguete fecha ese cierre un segundo adelante)
  const reg = path.join(C.estado(), 'frozen', 's-ft-8217-t23', 'vueltas.jsonl');
  const vs = fs.readFileSync(reg, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  vs[vs.length - 1].ts = new Date(C.cierre + 5000).toISOString();
  fs.writeFileSync(reg, vs.map((v) => JSON.stringify(v)).join('\n') + '\n');
  C.editar('src/a.js', A_CODIGO.replace('// la suma de los dos\nconst a = 1;\nconst b = 3;\n', 'const a = 1;\nconst b = 3;\n// la suma de los dos\n'));
  const r = C.ronda();
  assert.ok(r && r.archivos.includes('src/a.js'), JSON.stringify(r));
});

test('T24 ReviewedTree_SelloSinCerrar_NoPerdonaComentarios @story-8.217 @ac-16 — con la última vuelta sin cerrar, el segundo freno frena', () => {
  const C = corridaRevisada('s-ft-8217-t24', { cerrar: false });
  C.editar('src/a.js', A_MOVIDO, { evento: false });
  const r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /src\/a\.js/);
});

test('T26 ReviewersRound_LectorFalla_PideVuelta @story-8.217 @ac-18 — si el lector lanza, el archivo cuenta y queda en hook-errors.log', () => {
  const C = corridaRevisada('s-ft-8217-t26');
  C.editar('src/a.js', A_MOVIDO);
  const ruta = require.resolve(path.join(SCRIPTS, 'lib', 'change-kind.js'));
  const original = require.cache[ruta];
  require(ruta);
  const guardado = require.cache[ruta].exports;
  require.cache[ruta].exports = { ...guardado, queCambio: () => { throw new Error('lector roto de prueba'); } };
  try {
    const r = C.ronda();
    assert.ok(r && r.archivos.includes('src/a.js'), JSON.stringify(r));
  } finally { if (original) require.cache[ruta] = original; require.cache[ruta].exports = guardado; }
  // la falla dentro de tipoContraElSello la absorbe: cuenta. Una que sale de frozen-tree.js queda en el registro
  const ft = path.join(SCRIPTS, 'lib', 'frozen-tree.js');
  const ftMod = require(ft);
  const guardadoFt = ftMod.tiposDesdeLaVuelta;
  ftMod.tiposDesdeLaVuelta = () => { throw new Error('frozen-tree roto de prueba'); };
  try {
    const r = C.ronda();
    assert.ok(r && r.archivos.includes('src/a.js'), JSON.stringify(r));
  } finally { ftMod.tiposDesdeLaVuelta = guardadoFt; }
  assert.match(fs.readFileSync(path.join(C.estado(), 'hook-errors.log'), 'utf8'), /frozen-tree roto de prueba/);
});

test('T27 FrozenTree_ChangedSinOpcion_ComoHoy @story-8.217 @ac-19 — changed sin la opción devuelve lo de hoy', () => {
  const C = corridaRevisada('s-ft-8217-t27');
  const v = ft().ultimaVuelta(C.estado(), 's-ft-8217-t27', 'revisores');
  const r = v.repos.find((x) => x.repo === C.codigo.repo);
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'a.js'), A_MOVIDO);
  const ahora = ft().seal(C.codigo.repo).tree;
  const sin = ft().changed(C.codigo.repo, r.tree, ahora);
  assert.deepStrictEqual(sin.files, ['src/a.js']);
  assert.ok(!('comentarios' in sin), JSON.stringify(sin));
  const con = ft().changed(C.codigo.repo, r.tree, ahora, { comentarios: true });
  assert.deepStrictEqual([con.files, con.comentarios], [[], ['src/a.js']]);
});

test('T29 ReviewersRound_ArchivoYaAnotado_SeConserva @story-8.217 @ac-20 — lo ya pedido no se retira', () => {
  for (const [sid, final] of [['s-ft-8217-t29a', A_MOVIDO], ['s-ft-8217-t29b', A_REVISADO]]) {
    const C = corridaRevisada(sid);
    C.editar('src/a.js', A_CODIGO);
    const pedida = C.ronda();
    assert.ok(pedida && pedida.archivos.includes('src/a.js'));
    C.escribir(() => ({ otraVuelta: pedida }));
    C.editar('src/a.js', final);
    const r = C.ronda();
    assert.ok(r && r.archivos.includes('src/a.js'), `${sid}: ${JSON.stringify(r)}`);
  }
});

test('T30 ReviewersRound_MezclaConCambioReal_NombraElReal @story-8.217 @ac-21 — un comentario movido y un cambio de código', () => {
  const C = corridaRevisada('s-ft-8217-t30');
  C.editar('src/a.js', A_MOVIDO);
  C.editar('src/b.js', B_CODIGO);
  assert.deepStrictEqual((C.ronda() || {}).archivos, ['src/b.js']);
});

test('T31 ReviewedTree_MezclaConCambioReal_FrenaPorElReal @story-8.217 @ac-21 — frena y nombra sólo el de código', () => {
  const C = corridaRevisada('s-ft-8217-t31');
  C.editar('src/a.js', A_MOVIDO, { evento: false });
  C.editar('src/b.js', B_CODIGO, { evento: false });
  const r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /· src\/b\.js/, salida(r));
  assert.doesNotMatch(salida(r), /· src\/a\.js/, salida(r));
});

// ── El pase congela también los repos hermanos ───────────────────────────────────────────────────────────────────────
// Caso: el pase sellaba sólo el repo de la historia; el código de los repos hermanos (backend y formularios) podía cambiar
// mientras corría, y el pase daba por bueno algo que ya no era lo que miró.
function conHermano() {
  const front = repoDeJuguete('Front', { 'src/x.js': 'module.exports = 1;\n', 'tests/x.test.js': '// prueba\n' });
  const priv = repoDeJuguete('Priv', { 'specs/s.md': '# historia\n' });
  fs.mkdirSync(path.join(priv.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(priv.repo, '.tycon', 'advisors.yaml'),
    `evidence:\n  companion_repos:\n    - ${path.relative(priv.repo, front.repo)}\n`);
  priv.git('add', '.');
  priv.git('commit', '-qm', 'declara el hermano');
  return { front, priv, story: path.join(priv.repo, 'specs', 's.md') };
}

test('Pase_ReposDelPase_SumaLosHermanos — el congelado del pase incluye cada repo hermano declarado', () => {
  // 🔴 rojo si: el pase congela sólo la historia y el repo de la corrida → el código del hermano no tiene sello.
  const { front, priv, story } = conHermano();
  const r = ft().reposDelPase({ story, repo: priv.repo });
  assert.ok(!r.error, JSON.stringify(r));
  assert.deepStrictEqual(r.repos, [priv.repo, front.repo]);
  assert.deepStrictEqual(r.hermanos, [front.repo]);
  // una configuración que no se deja leer no es «sin hermanos»: el congelado frena con el motivo
  fs.writeFileSync(path.join(priv.repo, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos: [\n');
  const roto = ft().reposDelPase({ story, repo: priv.repo });
  assert.ok(roto.error, `una configuración rota no da «sin hermanos»: ${JSON.stringify(roto)}`);
});

test('Pase_HermanoCambiado_FrenaElCierre — si el código de un hermano cambió desde el lanzamiento, el cierre lo nombra; las pruebas propias declaradas no cuentan', () => {
  // 🔴 rojo si: el cierre compara sólo las copias → un cambio en el hermano durante el pase pasa sin que nadie lo vea.
  const { front } = conHermano();
  const sello = ft().seal(front.repo).tree;
  const sellos = { [front.repo]: sello };
  assert.deepStrictEqual(ft().hermanosCambiados({ sellos, hermanos: [front.repo] }), [], 'sin cambios no frena');
  fs.writeFileSync(path.join(front.repo, 'src', 'x.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(front.repo, 'tests', 'x.test.js'), '// prueba de regresión del pase\n');
  const cambio = ft().hermanosCambiados({ sellos, hermanos: [front.repo] });
  assert.deepStrictEqual(cambio, [{ repo: front.repo, files: ['src/x.js', 'tests/x.test.js'] }]);
  // la prueba propia que el cierre declara (--own --in) no cuenta; el código sí
  const conPropia = ft().hermanosCambiados({ sellos, hermanos: [front.repo], permitidos: [path.join(front.repo, 'tests', 'x.test.js')] });
  assert.deepStrictEqual(conPropia, [{ repo: front.repo, files: ['src/x.js'] }]);
  // sin el sello del lanzamiento no se sabe: cuenta como cambio, con el motivo
  const sinSello = ft().hermanosCambiados({ sellos: {}, hermanos: [front.repo] });
  assert.strictEqual(sinSello.length, 1);
  assert.match(sinSello[0].error, /sello/);
});

test('Pase_PropiaDelHermanoConRepo_NoFrenaElCierre — la prueba propia declarada como `(<repo>) <ruta>` no cuenta como cambio del hermano; el código sí', () => {
  // 🔴 rojo si: el cierre toma el `--in` crudo y lo resuelve contra la raíz del hermano → la forma `(Front) tests/x.test.js`,
  // la que pide el paso del pase, frena el cierre como si el hermano hubiera cambiado.
  const C = corrida('s-ft-hermano', { declaraTambien: ['Front/src/x.js'] });
  const front = repoDeJuguete('Front', { 'src/x.js': 'module.exports = 1;\n', 'tests/x.test.js': '// prueba\n' });
  fs.mkdirSync(path.join(C.codigo.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(C.codigo.repo, '.tycon', 'advisors.yaml'),
    `evidence:\n  companion_repos:\n    - ${path.relative(C.codigo.repo, front.repo)}\n`);
  C.codigo.git('add', '.');
  C.codigo.git('commit', '-qm', 'declara el hermano');
  const l = C.correr('marker.js', ['mark-adversarial-launched', 'r1', '4']);
  assert.strictEqual(l.status, 0, salida(l));
  const sellos = C.marcador().adversarial.sellos;
  assert.ok(sellos[front.repo], `el lanzamiento sella el hermano: ${JSON.stringify(sellos)}`);
  const cerrar = () => {
    const f = path.join(tmp('ft-res-'), 'step-05b-adversarial.json');
    fs.writeFileSync(f, JSON.stringify({ confirmed: [{ lens: 'x', summary: 'y' }], sellos }));
    return C.correr('marker.js', ['mark-adversarial-result', '1', '--type', '5b', '--result', f, '--run', 'r1', '--tests', '1', '--own', '1', '--in', '(Front) tests/x.test.js']);
  };
  const HERMANO = /el código de un repo hermano cambió/;
  fs.writeFileSync(path.join(front.repo, 'tests', 'x.test.js'), '// prueba de regresión del pase\n');
  const propia = cerrar();
  assert.doesNotMatch(salida(propia), HERMANO, salida(propia));
  fs.writeFileSync(path.join(front.repo, 'src', 'x.js'), 'module.exports = 2;\n');
  const codigo = cerrar();
  assert.strictEqual(codigo.status, 2, salida(codigo));
  assert.match(salida(codigo), HERMANO);
  assert.match(salida(codigo), /Front: src\/x\.js$/m);
});

// Arreglar los hallazgos del pase en un repo hermano obligaba a relanzar el pase entero: el cierre frenaba cualquier
// cambio del hermano, y la vuelta de revisores, que cubre los arreglos del repo principal, no sellaba los hermanos.
function corridaConHermano(sid) {
  const front = repoDeJuguete('Front', { 'src/x.js': 'module.exports = 1;\n', 'tests/x.test.js': '// prueba\n' });
  const C = corrida(sid, { declaraTambien: ['Front/src/x.js'], antesDeArrancar: (codigo) => {
    fs.mkdirSync(path.join(codigo.repo, '.tycon'), { recursive: true });
    fs.writeFileSync(path.join(codigo.repo, '.tycon', 'advisors.yaml'), `evidence:\n  companion_repos:\n    - ${path.relative(codigo.repo, front.repo)}\n`);
    codigo.git('add', '.');
    codigo.git('commit', '-qm', 'declara el hermano');
  } });
  const cerrarPase = (confirmados) => {
    const f = path.join(tmp('ft-res-'), 'step-05b-adversarial.json');
    fs.writeFileSync(f, JSON.stringify({ confirmed: Array.from({ length: confirmados }, (_, i) => ({ lens: 'x', summary: `y${i}` })), sellos: C.marcador().adversarial.sellos }));
    const destino = confirmados ? ['--tests', '0', '--deferred', String(confirmados), '--reason', 'caso de prueba'] : [];
    return C.correr('marker.js', ['mark-adversarial-result', String(confirmados), '--type', '5b', '--result', f, '--run', 'r1', ...destino]);
  };
  return { ...C, front, cerrarPase };
}
const HERMANO_CAMBIADO = /el código de un repo hermano cambió/;

test('Revisores_LaVueltaSellaLosHermanos — la vuelta de revisores congela cada repo hermano, y guardar un hermano distinto de lo revisado frena', () => {
  // 🔴 rojo si: la vuelta sella sólo la historia y el código → el arreglo del hermano no tiene contra qué compararse al guardar.
  const C = corridaConHermano('s-ft-hermano-vuelta');
  const { r } = C.vuelta();
  assert.strictEqual(r.status, 0, salida(r));
  const v = ft().ultimaVuelta(C.estado(), C.sid, 'revisores');
  assert.ok(v && (v.repos || []).some((x) => x.repo === C.front.repo), `la vuelta sella el hermano: ${JSON.stringify(v)}`);
  fs.writeFileSync(path.join(C.front.repo, 'src', 'x.js'), 'module.exports = 2;\n');
  const p = prepararCommit(C);
  assert.strictEqual(p.status, 2, salida(p));
  assert.match(salida(p), MISMATCH);
  assert.match(salida(p), /src\/x\.js/);
});

test('Pase_ArregloDelHermanoConHallazgos_QuedaParaLaVuelta — con hallazgos, el arreglo del hermano no frena el cierre y queda anotado; sin hallazgos frena como antes', () => {
  // 🔴 rojo si: el cierre frena cualquier cambio del hermano → arreglar los hallazgos obliga a relanzar el pase entero.
  const C = corridaConHermano('s-ft-hermano-arreglo');
  assert.strictEqual(C.vuelta().r.status, 0);
  const l = C.correr('marker.js', ['mark-adversarial-launched', 'r1', '4']);
  assert.strictEqual(l.status, 0, salida(l));
  fs.writeFileSync(path.join(C.front.repo, 'src', 'x.js'), 'module.exports = 2;\n');
  const con = C.cerrarPase(1);
  assert.strictEqual(con.status, 0, salida(con));
  assert.doesNotMatch(salida(con), HERMANO_CAMBIADO, salida(con));
  assert.match(salida(con), /lo revisa la próxima vuelta de revisores/);
  const anotado = gatesDe(C).filter((g) => g.name === 'frozen-sibling');
  assert.deepStrictEqual(anotado.map((g) => g.status), ['al-re-loop']);
  assert.deepStrictEqual(anotado[0].repos, [{ repo: C.front.repo, files: ['src/x.js'] }]);
  // sin hallazgos no hay nada que arreglar: un cambio del hermano es código que nadie miró
  const S = corridaConHermano('s-ft-hermano-sin');
  assert.strictEqual(S.vuelta().r.status, 0);
  assert.strictEqual(S.correr('marker.js', ['mark-adversarial-launched', 'r1', '4']).status, 0);
  fs.writeFileSync(path.join(S.front.repo, 'src', 'x.js'), 'module.exports = 2;\n');
  const sin = S.cerrarPase(0);
  assert.strictEqual(sin.status, 2, salida(sin));
  assert.match(salida(sin), HERMANO_CAMBIADO);
});

// ¿El disco de las pruebas distingue mayúsculas? APFS y NTFS no; ext4 sí.
const sinDistinguirMayusculas = (() => {
  const d = tmp('ft-mayus-');
  fs.writeFileSync(path.join(d, 'a'), '');
  return fs.existsSync(path.join(d, 'A'));
})();

test('Pase_HermanoSinGit_FallaCerrado — un hermano declarado que está en disco pero no es un repo git frena el congelado y nombra la carpeta', () => {
  // 🔴 rojo si: la carpeta sin git se descarta con un aviso → su código queda sin sello y el cierre no lo mira.
  const { front, priv, story } = conHermano();
  const sinGit = path.join(tmp('ft-sin-git-'), 'SinGit');
  fs.mkdirSync(path.join(sinGit, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sinGit, 'src', 'y.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(priv.repo, '.tycon', 'advisors.yaml'),
    `evidence:\n  companion_repos:\n    - ${path.relative(priv.repo, front.repo)}\n    - ${path.relative(priv.repo, sinGit)}\n`);
  const r = ft().reposDelPase({ story, repo: priv.repo });
  assert.ok(r.error, `un hermano sin git no se deja afuera callado: ${JSON.stringify(r)}`);
  assert.match(r.error, /SinGit/);
});

test('Pase_ListaVaciaExplicita_SinHermanosSinError — `companion_repos: []`, la llave sin valor o el bloque vacío dicen «sin hermanos»; lo que no se entiende sigue frenando', () => {
  // 🔴 rojo si: el congelado toma una lista vacía declarada a propósito por un bloque que no se pudo leer → el pase no se lanza.
  const { priv, story } = conHermano();
  const conYaml = (txt) => {
    fs.writeFileSync(path.join(priv.repo, '.tycon', 'advisors.yaml'), txt);
    return ft().reposDelPase({ story, repo: priv.repo });
  };
  for (const txt of ['evidence:\n  companion_repos: []\n', 'evidence:\n  companion_repos: [] # ninguno\n  fe_paths: []\n', 'evidence:\n  companion_repos:\n', 'evidence:\n']) {
    const r = conYaml(txt);
    assert.ok(!r.error, `${JSON.stringify(txt)} es «sin hermanos»: ${JSON.stringify(r)}`);
    assert.deepStrictEqual(r.repos, [priv.repo]);
    assert.deepStrictEqual(r.hermanos, []);
  }
  for (const txt of ['evidence:\n  companion_repos: [\n', 'evidence:\n  companion_repos: ../Front\n', 'evidence: {companion_repos: [../Front]}\n']) {
    const r = conYaml(txt);
    assert.ok(r.error, `${JSON.stringify(txt)} no se pudo leer, no es «sin hermanos»: ${JSON.stringify(r)}`);
  }
});

test('Pase_PropiaConOtrasMayusculas_NoFrena — la prueba propia declarada con otras mayúsculas libera el mismo archivo donde el disco no las distingue', () => {
  // 🔴 rojo si: el cierre compara las rutas de --in distinguiendo mayúsculas → en APFS o NTFS `(Front) Tests/X.test.js`
  // frena el cierre aunque verificarPruebasPropias lo acepta como la misma prueba.
  const { front } = conHermano();
  const sellos = { [front.repo]: ft().seal(front.repo).tree };
  fs.writeFileSync(path.join(front.repo, 'tests', 'x.test.js'), '// prueba de regresión del pase\n');
  fs.mkdirSync(path.join(front.repo, 'Specs'), { recursive: true });
  fs.writeFileSync(path.join(front.repo, 'Specs', 'Foo.test.js'), '// prueba nueva\n');
  // una prueba declarada que es un enlace al código no libera nada: ni el enlace ni el código al que apunta
  const enlace = repoDeJuguete('Enlace', { 'src/x.js': 'module.exports = 1;\n' });
  const selloDelEnlace = { [enlace.repo]: ft().seal(enlace.repo).tree };
  fs.writeFileSync(path.join(enlace.repo, 'src', 'x.js'), 'module.exports = 2;\n');
  fs.mkdirSync(path.join(enlace.repo, 'tests'), { recursive: true });
  let hayEnlaces = true;
  try { fs.symlinkSync(path.join('..', 'src', 'x.js'), path.join(enlace.repo, 'tests', 'x.test.js')); } catch (_) { hayEnlaces = false; }
  if (hayEnlaces) {
    const conEnlace = ft().hermanosCambiados({ sellos: selloDelEnlace, hermanos: [enlace.repo], permitidos: [path.join(enlace.repo, 'tests', 'x.test.js')] });
    assert.deepStrictEqual(conEnlace, [{ repo: enlace.repo, files: ['src/x.js', 'tests/x.test.js'] }]);
  }
  const permitidos = [path.join(front.repo, 'Tests', 'X.test.js'), path.join(front.repo, 'specs', 'foo.test.js')];
  const r = ft().hermanosCambiados({ sellos, hermanos: [front.repo], permitidos });
  // donde el disco sí las distingue, son otros archivos: no liberan nada
  if (!sinDistinguirMayusculas) { assert.deepStrictEqual(r, [{ repo: front.repo, files: ['Specs/Foo.test.js', 'tests/x.test.js'] }]); return; }
  assert.deepStrictEqual(r, [], JSON.stringify(r));
  // el cierre entero, con la forma `(<repo>) <ruta>` y otras mayúsculas
  const C = corrida('s-ft-mayus');
  const fr = repoDeJuguete('Front', { 'src/x.js': 'module.exports = 1;\n', 'tests/x.test.js': '// prueba\n' });
  fs.mkdirSync(path.join(C.codigo.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(C.codigo.repo, '.tycon', 'advisors.yaml'), `evidence:\n  companion_repos:\n    - ${path.relative(C.codigo.repo, fr.repo)}\n`);
  C.codigo.git('add', '.');
  C.codigo.git('commit', '-qm', 'declara el hermano');
  const l = C.correr('marker.js', ['mark-adversarial-launched', 'r1', '4']);
  assert.strictEqual(l.status, 0, salida(l));
  const lanzados = C.marcador().adversarial.sellos;
  fs.writeFileSync(path.join(fr.repo, 'tests', 'x.test.js'), '// prueba de regresión del pase\n');
  const f = path.join(tmp('ft-res-'), 'step-05b-adversarial.json');
  fs.writeFileSync(f, JSON.stringify({ confirmed: [{ lens: 'x', summary: 'y' }], sellos: lanzados }));
  const cierre = C.correr('marker.js', ['mark-adversarial-result', '1', '--type', '5b', '--result', f, '--run', 'r1', '--tests', '1', '--own', '1', '--in', '(Front) Tests/X.test.js']);
  assert.doesNotMatch(salida(cierre), /el código de un repo hermano cambió/, salida(cierre));
});

test('Pase_HermanoConSubmodulo_FrenaSiCambiaAdentro — un archivo sin commitear dentro de un submódulo o de un repo anidado del hermano frena el cierre y nombra la carpeta', () => {
  // 🔴 rojo si: el sello anota sólo el commit de cada submódulo → editar sus archivos después de lanzar el pase no cambia
  // el sello y el cierre no lo ve.
  const sub = repoDeJuguete('Sub', { 's.js': 'module.exports = 1;\n', 'tests/s.test.js': '// prueba\n' });
  const sib = repoDeJuguete('Sib', { 'a.js': 'module.exports = 1;\n' });
  sib.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.repo, 'vend');
  // un repo anidado sin registrar como submódulo: `add -A` también lo anota sólo por su commit
  const anidado = path.join(sib.repo, 'anidado');
  fs.mkdirSync(anidado);
  fs.writeFileSync(path.join(anidado, 'n.js'), 'module.exports = 1;\n');
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['add', '.'], ['commit', '-qm', 'anidado']]) {
    execFileSync('git', ['-C', anidado, ...a], { stdio: 'ignore' });
  }
  sib.git('add', '-A');
  sib.git('commit', '-qm', 'con submódulo y repo anidado');
  const sellos = { [sib.repo]: ft().seal(sib.repo).tree };
  const cambio = (permitidos) => ft().hermanosCambiados({ sellos, hermanos: [sib.repo], permitidos });
  assert.deepStrictEqual(cambio(), [], 'limpio no frena');
  fs.writeFileSync(path.join(sib.repo, 'vend', 's.js'), 'module.exports = 2;\n');
  assert.deepStrictEqual(cambio(), [{ repo: sib.repo, files: ['vend/s.js'] }]);
  fs.writeFileSync(path.join(anidado, 'nuevo.js'), 'module.exports = 3;\n');
  assert.deepStrictEqual(cambio(), [{ repo: sib.repo, files: ['anidado/nuevo.js', 'vend/s.js'] }]);
  // la prueba propia que el cierre declara adentro del submódulo no cuenta, como afuera; el código sí
  fs.writeFileSync(path.join(sib.repo, 'vend', 'tests', 's.test.js'), '// prueba de regresión del pase\n');
  assert.deepStrictEqual(cambio([path.join(sib.repo, 'vend', 'tests', 's.test.js')]), [{ repo: sib.repo, files: ['anidado/nuevo.js', 'vend/s.js'] }]);
});

test('PrepareCommit_SubmoduloDelPrincipal_FrenaSiCambiaAdentro — lo sin commitear dentro de un submódulo o de un repo anidado del repo de la corrida frena «Preparar» y nombra la carpeta; si no se puede mirar, también', () => {
  // 🔴 rojo si: el sello anota sólo el commit de cada submódulo → editar sus archivos después de la vuelta no cambia el
  // sello, y lo que se guarda pasa por revisado.
  const sub = repoDeJuguete('Sub', { 's.js': 'module.exports = 1;\n' });
  const C = corrida('s-ft-sub-principal', { antesDeArrancar: (codigo) => {
    codigo.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.repo, 'vend');
    codigo.git('commit', '-qm', 'con submódulo');
    // un repo anidado sin registrar: el sello también lo anota sólo por su commit
    const dir = path.join(codigo.repo, 'anidado');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'n.js'), 'module.exports = 1;\n');
    for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['add', '.'], ['commit', '-qm', 'anidado']]) {
      execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    }
  } });
  const anidado = path.join(C.codigo.repo, 'anidado');
  const v = C.vuelta();
  assert.strictEqual(v.r.status, 0, salida(v.r));
  let r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  // editado sin commitear adentro del submódulo: frena con la carpeta adelante y dice cómo salir
  fs.writeFileSync(path.join(C.codigo.repo, 'vend', 's.js'), 'module.exports = 2;\n');
  r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), MISMATCH);
  assert.match(salida(r), /vend\/s\.js/);
  assert.match(salida(r), /submódulo/);
  assert.ok(gatesDe(C).some((g) => g.name === 'reviewed-tree-mismatch'));
  // nuevo adentro del repo anidado: también
  fs.writeFileSync(path.join(C.codigo.repo, 'vend', 's.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(anidado, 'nuevo.js'), 'module.exports = 3;\n');
  r = prepararCommit(C);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /anidado\/nuevo\.js/);
  assert.doesNotMatch(salida(r), /vend\/s\.js/, 'lo que volvió a como estaba no cuenta');
  fs.rmSync(path.join(anidado, 'nuevo.js'));
  r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  // uno cuyo estado no se puede leer no se da por igual: frena con su carpeta (el sello del repo no lee el índice de un
  // repo anidado sin registrar; el de un submódulo registrado, sí, y sin él ya frenaba)
  const indice = path.join(anidado, '.git', 'index');
  fs.chmodSync(indice, 0o000);
  try {
    r = prepararCommit(C);
  } finally {
    fs.chmodSync(indice, 0o644);
  }
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /no pude ver el estado del submódulo anidado/, salida(r));
});

// ── Reusar la copia del pase (historia 8.330) ─────────────────────────────────────────────────────────────────────
// Caso: el pase y la primera vuelta de revisores sellaban y copiaban los mismos repos dos veces (con un repo grande,
// cientos de MB cada vez), aunque nada hubiera cambiado entre los dos.
const congelarElPase = (C) => {
  const r = C.correr('marker.js', ['freeze-adversarial']);
  assert.strictEqual(r.status, 0, salida(r));
  return ft().ultimaVuelta(C.estado(), C.sid, 'pase');
};
const tocarLaCopia = (copia, rel) => {
  fs.chmodSync(path.join(copia, rel), 0o644);
  fs.appendFileSync(path.join(copia, rel), '// tocada a mano\n');
};

test('T7 SealAndFreeze_ReusaLaCopiaDelPase @story-8.330 @ac-7 — sin cambios entre el pase y la vuelta 1, la vuelta usa la copia del pase y no arma otra', () => {
  // 🔴 rojo si: la vuelta vuelve a copiar lo que el pase ya copió con el mismo sello.
  const C = corrida('s-ft-reusa');
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'a.js'), 'module.exports = 10;\n');
  const pase = congelarElPase(C);
  const { r, json } = C.vuelta();
  assert.strictEqual(r.status, 0, salida(r));
  const v = ft().ultimaVuelta(C.estado(), C.sid, 'revisores');
  assert.strictEqual(v.repos.length, pase.repos.length, JSON.stringify(v));
  for (const x of v.repos) {
    const delPase = pase.repos.find((p) => p.repo === x.repo);
    assert.ok(delPase, `el pase congeló ${x.repo}`);
    assert.strictEqual(x.copy, delPase.copy, 'la copia del pase');
    assert.strictEqual(x.reusada_de, pase.etiqueta, 'y anota de dónde salió');
    assert.ok(!fs.existsSync(ft().copyDir(C.estado(), C.sid, 'rev-iter1', x.repo)), 'no se armó la copia de la vuelta');
  }
  // el contexto de los revisores nombra la copia que usan
  const ctx = fs.readFileSync(json.context_file, 'utf8');
  for (const p of pase.repos) assert.ok(ctx.includes(p.copy), `el contexto nombra ${p.copy}`);
});

test('T8 SealAndFreeze_CambioOCopiaTocada_CopiaDeNuevo_Vuelta2NoBorraLaQueNombra @story-8.330 @ac-8 — lo que cambió o se tocó se copia de nuevo, lo demás se reusa, y la vuelta 2 no borra lo que usa', () => {
  // 🔴 rojo si: se reusa una copia de otro sello o una tocada a mano, o la vuelta 2 borra una copia que ella misma nombra.
  const C = corridaConHermano('s-ft-reusa-cambio');
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'a.js'), 'module.exports = 10;\n');
  const pase = congelarElPase(C);
  const copiaDelPase = (repo) => pase.repos.find((p) => p.repo === repo).copy;
  // el código cambia después del pase; la copia de la historia se toca a mano; el hermano queda igual
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'a.js'), 'module.exports = 11;\n');
  tocarLaCopia(copiaDelPase(C.historias.repo), path.join('specs', 'story-9.9-sello.md'));
  assert.strictEqual(C.vuelta().r.status, 0);
  const v1 = ft().ultimaVuelta(C.estado(), C.sid, 'revisores');
  const en = (v, repo) => v.repos.find((x) => x.repo === repo);
  for (const repo of [C.codigo.repo, C.historias.repo]) {
    assert.strictEqual(en(v1, repo).reusada_de, undefined, `${path.basename(repo)} se copia de nuevo`);
    assert.strictEqual(en(v1, repo).copy, ft().copyDir(C.estado(), C.sid, 'rev-iter1', repo));
    assert.deepStrictEqual(ft().verify(repo, en(v1, repo).copy, en(v1, repo).tree), { ok: true });
  }
  assert.strictEqual(en(v1, C.front.repo).reusada_de, pase.etiqueta, 'el hermano sin cambios se reusa');
  assert.strictEqual(en(v1, C.front.repo).copy, copiaDelPase(C.front.repo));
  // la vuelta 2, sin cambios: reusa lo de la vuelta 1, y borrar las copias de la vuelta 1 no toca las que ella nombra
  assert.strictEqual(C.vuelta(2).r.status, 0);
  const v2 = ft().ultimaVuelta(C.estado(), C.sid, 'revisores');
  for (const x of v2.repos) assert.ok(fs.existsSync(x.copy), `la vuelta 2 no borró la copia que usa: ${x.copy}`);
  assert.strictEqual(en(v2, C.codigo.repo).copy, en(v1, C.codigo.repo).copy);
});

// Hallazgo del pase (integration-contracts): una vuelta que se relanza con la misma etiqueta rearmaba su copia en la
// misma carpeta, aunque el pase abierto la estuviera leyendo porque la reusó.
test('T8c SealAndFreeze_MismaEtiqueta_NoPisaLaCopiaQueElPaseReuso @story-8.330 @ac-8 — relanzar la vuelta 1 con un cambio arma su copia aparte; la del pase sigue siendo la de su sello', () => {
  // 🔴 rojo si: la vuelta relanzada vuelve a armar su copia en la carpeta que el pase reusó y la pisa con otro sello.
  const C = corrida('s-ft-reusa-misma-etiqueta');
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'a.js'), 'module.exports = 10;\n');
  assert.strictEqual(C.vuelta().r.status, 0);
  const pase = congelarElPase(C);
  const delPase = pase.repos.find((p) => p.repo === C.codigo.repo);
  assert.strictEqual(delPase.copy, ft().copyDir(C.estado(), C.sid, 'rev-iter1', C.codigo.repo), 'el pase reusó la copia de la vuelta 1');
  const l = C.correr('marker.js', ['mark-adversarial-launched', 'r1', '4']);
  assert.strictEqual(l.status, 0, salida(l));
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'a.js'), 'module.exports = 11;\n');
  assert.strictEqual(C.vuelta().r.status, 0, 'la vuelta 1 se relanza con el cambio');
  assert.deepStrictEqual(ft().verify(C.codigo.repo, delPase.copy, delPase.tree), { ok: true }, 'la copia que lee el pase sigue siendo la de su sello');
  const v = ft().ultimaVuelta(C.estado(), C.sid, 'revisores').repos.find((x) => x.repo === C.codigo.repo);
  assert.notStrictEqual(v.copy, delPase.copy, 'la vuelta relanzada armó su copia aparte');
  assert.deepStrictEqual(ft().verify(C.codigo.repo, v.copy, v.tree), { ok: true });
});

test('T8b SealAndFreeze_Vuelta2_NoBorraLaCopiaDelPaseAbierto @story-8.330 @ac-8 — la copia del pase que reusó la vuelta 1 sigue en disco mientras el pase no se anota', () => {
  // 🔴 rojo si: la vuelta 2 borra, con las copias de la vuelta 1, la copia que el pase abierto sigue leyendo.
  const C = corrida('s-ft-reusa-abierto');
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'a.js'), 'module.exports = 10;\n');
  const pase = congelarElPase(C);
  const copiaDelCodigo = pase.repos.find((p) => p.repo === C.codigo.repo).copy;
  const l = C.correr('marker.js', ['mark-adversarial-launched', 'r1', '4']);
  assert.strictEqual(l.status, 0, salida(l));
  assert.strictEqual(C.vuelta().r.status, 0);
  assert.strictEqual(ft().ultimaVuelta(C.estado(), C.sid, 'revisores').repos.find((x) => x.repo === C.codigo.repo).copy, copiaDelCodigo, 'la vuelta 1 reusó la copia del pase');
  // un arreglo en el código: la vuelta 2 copia de nuevo el código y borra lo de la vuelta 1, menos lo del pase abierto
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'a.js'), 'module.exports = 11;\n');
  assert.strictEqual(C.vuelta(2).r.status, 0);
  assert.ok(fs.existsSync(copiaDelCodigo), 'la copia del pase abierto sigue en disco');
  // anotado el pase, la vuelta siguiente sí la borra
  const f = path.join(tmp('ft-res-'), 'step-05b-adversarial.json');
  fs.writeFileSync(f, JSON.stringify({ confirmed: [], sellos: C.marcador().adversarial.sellos }));
  C.correr('marker.js', ['mark-adversarial-result', '0', '--type', '5b', '--result', f, '--run', 'r1']);
  assert.ok((C.marcador().adversarialPasses || []).some((p) => p.tipo === '5b'), 'el pase quedó anotado');
  fs.writeFileSync(path.join(C.codigo.repo, 'src', 'a.js'), 'module.exports = 12;\n');
  // la tercera vuelta pide la nota de «repensar el enfoque», como en una corrida de verdad
  const nota = C.correr('marker.js', ['rethink', '--iter', '3', '--repeated', 'nada se repitió: la prueba cambia el código en cada vuelta',
    '--keep', 'el enfoque sigue igual: la prueba sólo mira qué copias quedan en disco']);
  assert.strictEqual(nota.status, 0, salida(nota));
  const v3 = C.vuelta(3);
  assert.strictEqual(v3.r.status, 0, salida(v3.r));
  assert.ok(!fs.existsSync(copiaDelCodigo), 'anotado el pase, la vuelta siguiente la borra');
});
