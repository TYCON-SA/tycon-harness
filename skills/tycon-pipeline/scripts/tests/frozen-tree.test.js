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
function corrida(sid, { masHistorias = {} } = {}) {
  const base = tmp('ft-corrida-');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  const historias = repoDeJuguete('historias', {
    'specs/story-9.9-sello.md': ['---', 'story: "9.9"', 'title: "sello"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '---',
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

// «Preparar el commit» hasta el freno de lo revisado: los pasos de antes, por fuera del orden
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
  fs.writeFileSync(C.story, st.replace('status: in-progress', 'status: review').replace('- [ ] Task 1', '- [x] Task 1').replace('- hoy: escrita', '- hoy: escrita\n- después: cerrada'));
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
  fs.writeFileSync(C.story, fs.readFileSync(C.story, 'utf8').replace('- [ ] Task 1', '- [x] Task 1') + SEGUIMIENTOS);
  let d = ft().changed(C.historias.repo, deLaHistoria.tree, ft().seal(C.historias.repo).tree, { storyRel: rel });
  assert.deepStrictEqual([d.files, d.papeleo], [[], [rel]]);
  let r = prepararCommit(C);
  assert.doesNotMatch(salida(r), MISMATCH, salida(r));
  assert.match(salida(r), new RegExp(`lo que se guarda es lo revisado[^\\n]*papeleo cambiado después[^\\n]*story-9\\.9-sello\\.md`), salida(r));
  // tildar un seguimiento después también es papeleo
  fs.writeFileSync(C.story, fs.readFileSync(C.story, 'utf8').replace('- [ ] **[WARNING]** VAL-W15', '- [x] **[WARNING]** VAL-W15'));
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
  assert.deepStrictEqual(d, { files: [], papeleo: [HISTORIA_870] });
  // la misma marca fuera de los criterios no es papeleo
  fs.writeFileSync(f, `${fs.readFileSync(f, 'utf8')}\nNota @runtime-exempt(DODRT-C8): fuera\n`);
  assert.deepStrictEqual(ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: HISTORIA_870 }).files, [HISTORIA_870]);
});

test('Seal_BatchStatusFieldsAfterRound_ArePaperwork @story-8.270 @ac-5 — el estado y lo pendiente de una tanda son papeleo', () => {
  const R = repoDeJuguete('tanda', { [HISTORIA_870]: historiaConTandas(), 'src/a.js': '1\n' });
  const antes = ft().seal(R.repo).tree;
  const f = path.join(R.repo, HISTORIA_870);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('    status: in-progress', '    status: done').replace('    acs_pending: [1, 2]', '    acs_pending: []')
    .replace('    tests_pending: [T1]', '    tests_pending:\n      - T1\n      - T2').replace('    tasks_pending: [1]', '    tasks_pending:\n    - 1\n    - 2'));
  const d = ft().changed(R.repo, antes, ft().seal(R.repo).tree, { storyRel: HISTORIA_870 });
  assert.deepStrictEqual(d, { files: [], papeleo: [HISTORIA_870] });
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
