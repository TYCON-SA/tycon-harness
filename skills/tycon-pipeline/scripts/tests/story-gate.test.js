#!/usr/bin/env node
/**
 * story-gate.test.js — portón de carril: lógica pura (lib/story-gate.js), capa I/O con state dir temporal y
 * guard de Bash. SIN procesos externos → corre en cada SessionStart. Lo que lanza git/marker.js CLI vive en
 * story-gate-cli.test.js (throttle diario).
 *
 * Correr: node --test ~/.claude/agent-skills/skills/tycon-pipeline/scripts/tests/story-gate.test.js
 * 0 deps (node:test). Los tests de marker.js corren el CLI real contra un HOME temporal
 * (marker.js resuelve STATE_DIR desde os.homedir() y SID desde CLAUDE_CODE_SESSION_ID).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const gate = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
const io = require(path.join(SCRIPTS, 'lib', 'story-gate-io.js'));
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));

const REPO = '/w/MiRepo';
const BASE = { filePath: `${REPO}/src/Foo.cs`, stateDir: '/home/u/.claude/.tycon-pipeline', homeDir: '/home/u', repoRoot: REPO, repoHasTycon: true, repoHasStories: false, marker: null, adhoc: null };

// ── isCodeFile ───────────────────────────────────────────────────────────────────────────────────
test('isCodeFile: código sí, specs/config/salidas del arnés no', () => {
  for (const f of ['/r/src/a.cs', '/r/src/a.ts', '/r/src/a.tsx', '/r/db/001.sql', '/r/ui/a.css', '/r/Views/a.cshtml', '/r/tests/a.test.ts', 'C:\\r\\src\\a.cs'])
    assert.equal(gate.isCodeFile(f), true, f);
  for (const f of ['/r/specs/stories/1-2.md', '/r/plugin.json', '/r/.tycon/advisors.yaml', '/r/.advisors/dod-runtime/x.md', '/r/node_modules/x/a.js', '/r/bin/Debug/a.dll', '/r/obj/a.cs', '/r/.claude/hooks/a.js', '/r/README', ''])
    assert.equal(gate.isCodeFile(f), false, f);
});

test('isCodeFile: .claude/worktrees/<x>/src SÍ es código (R12)', () => {
  assert.equal(gate.isCodeFile('/r/.claude/worktrees/wt1/src/a.ts'), true);
  assert.equal(gate.isCodeFile('/r/.claude/skills/x/a.js'), false);
});

// ── computeStoryGate ─────────────────────────────────────────────────────────────────────────────
test('state-dir: Write bajo ~/.claude/.tycon-pipeline se deniega siempre, aun apagado', () => {
  const r = gate.computeStoryGate({ ...BASE, filePath: '/home/u/.claude/.tycon-pipeline/active/s1.json', gateEnabled: false });
  assert.equal(r.action, 'block'); assert.equal(r.kind, 'state-dir');
});

test('pass: no-código / harness / gate apagado / sin repo / repo=home / repo sin arnés', () => {
  assert.equal(gate.computeStoryGate({ ...BASE, filePath: `${REPO}/specs/s.md` }).action, 'pass');
  assert.equal(gate.computeStoryGate({ ...BASE, filePath: '/u/.claude/agent-skills/skills/x/a.js' }).action, 'pass');
  assert.equal(gate.computeStoryGate({ ...BASE, gateEnabled: false }).action, 'pass');
  assert.equal(gate.computeStoryGate({ ...BASE, repoRoot: null }).action, 'pass');
  assert.equal(gate.computeStoryGate({ ...BASE, repoRoot: '/home/u' }).action, 'pass');
  assert.equal(gate.computeStoryGate({ ...BASE, repoHasTycon: false, repoHasStories: false }).action, 'pass');
});

test('no-lane: repo con .tycon/ (o con stories) sin marker ni ad-hoc → block', () => {
  const a = gate.computeStoryGate(BASE);
  assert.equal(a.action, 'block'); assert.equal(a.kind, 'no-lane');
  const b = gate.computeStoryGate({ ...BASE, repoHasTycon: false, repoHasStories: true });
  assert.equal(b.kind, 'no-lane');
});

test('marker: se mira ANTES que el repo (R2) — plan pendiente bloquea aunque el repo "no tenga stories"', () => {
  const marker = { storyId: '1.2', repoPath: REPO, stepsPending: [3, 4, 5] };
  const r = gate.computeStoryGate({ ...BASE, repoHasTycon: false, repoHasStories: false, marker });
  assert.equal(r.action, 'block'); assert.equal(r.kind, 'plan');
});

test('marker: plan cerrado → pass; plan pendiente pero archivo en OTRO repo → pass; repoPath desconocido → aplica', () => {
  assert.equal(gate.computeStoryGate({ ...BASE, marker: { storyId: '1.2', repoPath: REPO, stepsPending: [4, 5] } }).action, 'pass');
  assert.equal(gate.computeStoryGate({ ...BASE, filePath: '/w/Otro/src/a.cs', marker: { storyId: '1.2', repoPath: REPO, stepsPending: [3] } }).action, 'pass');
  assert.equal(gate.computeStoryGate({ ...BASE, marker: { storyId: '1.2', stepsPending: [3] } }).kind, 'plan');
  // repoPath con casing distinto (APFS/NTFS) sigue contando como el mismo repo
  assert.equal(gate.computeStoryGate({ ...BASE, marker: { storyId: '1.2', repoPath: '/W/mirepo', stepsPending: [3] } }).kind, 'plan');
});

test('adhoc: pasa; cupo cuenta sólo implementación; archivo ya contado no consume; case-insensitive', () => {
  const adhoc = { reason: 'hotfix botón guardar', maxFiles: 2, files: [`${REPO}/src/A.cs`, `${REPO}/src/B.cs`] };
  assert.equal(gate.computeStoryGate({ ...BASE, adhoc: { reason: 'x fix', files: [] } }).action, 'pass');
  const cap = gate.computeStoryGate({ ...BASE, filePath: `${REPO}/src/C.cs`, adhoc });
  assert.equal(cap.action, 'block'); assert.equal(cap.kind, 'adhoc-cap');
  assert.equal(gate.computeStoryGate({ ...BASE, filePath: `${REPO}/src/a.cs`, adhoc }).action, 'pass'); // ya contado (case-insens.)
  assert.equal(gate.computeStoryGate({ ...BASE, filePath: `${REPO}/tests/CTests.cs`, adhoc }).action, 'pass'); // test no cuenta
  assert.equal(gate.computeStoryGate({ ...BASE, adhoc: { reason: 'x fix', maxFiles: 'abc', files: new Array(8).fill('/z.cs') }, filePath: `${REPO}/src/Z9.cs` }).kind, 'adhoc-cap'); // default 8
});

test('blockMessage: cada kind tiene sus salidas; no-lane lista adopt-session si hay markers ajenos', () => {
  const nl = gate.blockMessage({ kind: 'no-lane' }, { filePath: BASE.filePath, repoRoot: REPO, otherMarkers: [{ sessionId: 'abc', storyId: '2.1' }] });
  assert.match(nl, /adopt-session abc/); assert.match(nl, /adhoc set/); assert.match(nl, /tycon-pipeline/); assert.match(nl, /Barry/);
  assert.match(gate.blockMessage({ kind: 'plan' }, { filePath: BASE.filePath, marker: { storyId: '2.1' } }), /complete-step 3 --approved/);
  assert.match(gate.blockMessage({ kind: 'adhoc-cap', reason: 'r' }, { filePath: BASE.filePath }), /maxFiles/);
  assert.match(gate.blockMessage({ kind: 'state-dir' }, { filePath: '/x' }), /marker\.js/);
});

// ── story-gate-io con state dir temporal ─────────────────────────────────────────────────────────
function tmpState() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
  fs.mkdirSync(path.join(d, 'active'), { recursive: true });
  return d;
}
function mkRepo(withTycon) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  fs.mkdirSync(path.join(r, '.git'));
  fs.mkdirSync(path.join(r, 'src'));
  if (withTycon) fs.mkdirSync(path.join(r, '.tycon'));
  return r;
}

test('io.evaluate: repo sin .tycon ni stories → pass; con .tycon → no-lane; con adhoc → pass; marker plan → block', () => {
  const stateDir = tmpState();
  const plain = mkRepo(false);
  assert.equal(io.evaluate({ filePath: path.join(plain, 'src/a.ts'), sessionId: 's1', stateDir }).verdict.action, 'pass');

  const repo = mkRepo(true);
  const f = path.join(repo, 'src/a.ts');
  const r1 = io.evaluate({ filePath: f, sessionId: 's1', stateDir });
  assert.equal(r1.verdict.kind, 'no-lane'); assert.match(r1.message, /CÓDIGO SIN CARRIL/);
  assert.match(fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8'), /"name":"story-gate"/);
  // GATESLOG-STORYID-NS-1: la entry lleva el repo (namespace) — misma key `repoPath` que marker.js.
  const sgEntry = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).find((e) => e.name === 'story-gate' && e.status === 'blocked');
  assert.ok(sgEntry && sgEntry.repoPath, 'story-gate blocked lleva repoPath');
  assert.equal(fs.realpathSync(sgEntry.repoPath), fs.realpathSync(repo));

  io.writeAdhoc(stateDir, 's1', { reason: 'hotfix x', maxFiles: 8, files: [], declaredAt: new Date().toISOString(), lastTouch: new Date().toISOString() });
  assert.equal(io.evaluate({ filePath: f, sessionId: 's1', stateDir }).verdict.action, 'pass');
  io.recordAdhocFile(stateDir, 's1', f);
  assert.deepEqual(io.readAdhoc(stateDir, 's1').files, [f]);
  // ad-hoc stale (7h) no vale
  io.writeAdhoc(stateDir, 's1', { reason: 'hotfix x', files: [], declaredAt: new Date(Date.now() - 7 * 3600e3).toISOString(), lastTouch: new Date(Date.now() - 7 * 3600e3).toISOString() });
  assert.equal(io.evaluate({ filePath: f, sessionId: 's1', stateDir }).verdict.kind, 'no-lane');

  fs.writeFileSync(path.join(stateDir, 'active', 's1.json'), JSON.stringify({ storyId: '1.1', sessionId: 's1', repoPath: repo, stepsPending: [3, 4], lastTouch: new Date().toISOString() }));
  assert.equal(io.evaluate({ filePath: f, sessionId: 's1', stateDir }).verdict.kind, 'plan');
  // otra sesión con marker sobre el repo → aparece como adopt-session en no-lane
  fs.writeFileSync(path.join(stateDir, 'active', 's2.json'), JSON.stringify({ storyId: '9.9', sessionId: 's2', repoPath: repo, stepsPending: [5], lastTouch: new Date().toISOString() }));
  const r3 = io.evaluate({ filePath: f, sessionId: 's3', stateDir });
  assert.equal(r3.verdict.kind, 'no-lane'); assert.match(r3.message, /adopt-session s2/);
  // Write al state dir → block siempre
  assert.equal(io.evaluate({ filePath: path.join(stateDir, 'active', 's1.json'), sessionId: 's1', stateDir }).verdict.kind, 'state-dir');
});

// ── guard de Bash ────────────────────────────────────────────────────────────────────────────────
test('extractWriteTargets: redirecciones, tee, sed -i, perl -pi, cp/mv, open(w), writeFileSync', () => {
  const T = (cmd) => bash.extractWriteTargets(cmd).sort();
  assert.deepEqual(T("cat > src/Foo.cs <<'EOF'\nx\nEOF"), ['src/Foo.cs']);
  assert.deepEqual(T('echo hi >> "src/a b.ts"'), ['src/a b.ts']);
  assert.deepEqual(T('cat src/a.ts > /dev/null 2>&1'), []);
  assert.deepEqual(T('cmd 2> err.log'), ['err.log']);
  assert.deepEqual(T('echo x | tee -a src/a.ts src/b.ts'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(T("sed -i '' 's/a/b/' src/a.cs"), ['src/a.cs']);
  assert.deepEqual(T('sed -i.bak -e s/a/b/ src/a.cs'), ['src/a.cs']);
  assert.deepEqual(T("sed -n '1,5p' src/a.cs"), []); // sin -i no escribe
  assert.deepEqual(T("perl -pi -e 's/a/b/' src/a.ts"), ['src/a.ts']);
  assert.deepEqual(T('cp tmp.cs src/Foo.cs && mv x.ts src/y.ts'), ['src/Foo.cs', 'src/y.ts']);
  assert.deepEqual(T(`python3 -c "open('src/a.py','w').write('x')"`), ['src/a.py']);
  assert.deepEqual(T(`node -e "require('fs').writeFileSync('src/a.js','x')"`), ['src/a.js']);
  assert.deepEqual(T('grep -rn foo src/ | head'), []);
  assert.deepEqual(T('git diff > /tmp/p.patch'), ['/tmp/p.patch']);
});

test('extractWriteTargets: NO lee heredocs/strings como comandos (H1/H2/H3 review #2)', () => {
  const T = (cmd) => bash.extractWriteTargets(cmd).sort();
  // mensaje de commit HEREDOC (convención del equipo) que cita paths / flechas / blockquotes
  assert.deepEqual(T('git commit -m "$(cat <<\'EOF\'\nfeat(1.2): mover a.ts\n- src/a.ts -> src/b.ts\n> nota: cat > src/x.ts\nEOF\n)"'), []);
  // .md / .html escritos por heredoc cuyo CUERPO menciona código
  assert.deepEqual(T('cat > SKILL.md <<\'EOF\'\nejemplo: cat > src/Foo.cs <<X\nEOF'), ['SKILL.md']);
  assert.deepEqual(T('cat > report.html <<EOF\n<li>src/Foo.ts</li>\nEOF'), ['report.html']);
  assert.deepEqual(T('cat > notes.md <<\'EOF\'\n> cita: ver src/Foo.cs\nEOF'), ['notes.md']);
  // strings con > o paths
  assert.deepEqual(T('git commit -m "fix > src/x.ts"'), []);
  assert.deepEqual(T('echo "a > src/b.ts" '), []);
  // tee no cruza líneas
  assert.deepEqual(T('dotnet build 2>&1 | tee build.log\ngrep -n error src/Foo.cs'), ['build.log']);
  // `sed` como palabra suelta o flag -i de otro comando
  assert.deepEqual(T('grep -i "sed" src/foo.ts'), []);
  assert.deepEqual(T('grep -rn "sed -i" src/Foo.ts'), []);
  assert.deepEqual(T('rg -i sed -g "*.ts"'), []);
  assert.deepEqual(T('npm i && ls src/a.ts'), []);
  // los targets reales siguen saliendo
  assert.deepEqual(T('echo hi >> "src/a b.ts"'), ['src/a b.ts']);
  assert.deepEqual(T('echo x | tee "src/a.ts"'), ['src/a.ts']);
  assert.deepEqual(T('sudo sed -i.bak s/a/b/ src/a.cs'), ['src/a.cs']);
  // cd inicial
  assert.equal(bash.leadingCd('cd Backend && cat > src/a.cs <<EOF\nEOF'), 'Backend');
  assert.equal(bash.leadingCd('ls; cd x'), null);
});

test('on-bash-write-gate.handle: bloquea heredoc a código sin carril; deja pasar lectura y no-código', () => {
  const stateDir = tmpState();
  const repo = mkRepo(true);
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  const b = bash.handle(ev("cat > src/Foo.cs <<'EOF'\nclass X{}\nEOF"), { stateDir });
  assert.ok(b && /CÓDIGO SIN CARRIL/.test(b.block) && /Bash:/.test(b.block));
  assert.equal(bash.handle(ev('sed -n 1,5p src/Foo.cs'), { stateDir }), null);
  assert.equal(bash.handle(ev('echo x > notes.md'), { stateDir }), null);
  assert.equal(bash.handle(ev('echo x > /tmp/scratch.ts'), { stateDir }), null); // fuera de repo
  io.writeAdhoc(stateDir, 's1', { reason: 'hotfix x', files: [], declaredAt: new Date().toISOString(), lastTouch: new Date().toISOString() });
  assert.equal(bash.handle(ev("cat > src/Foo.cs <<'EOF'\nx\nEOF"), { stateDir }), null);
  // Write al state dir por Bash también se deniega
  const sd = bash.handle(ev(`echo '{}' > ${path.join(stateDir, 'active', 's1.json')}`), { stateDir });
  assert.ok(sd && /ESTADO DEL PIPELINE/.test(sd.block));
  // `cd <dir> &&` resuelve el target contra ese dir (H10)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nocwd-'));
  io.writeAdhoc(stateDir, 's9', { reason: 'x', files: [], declaredAt: new Date(Date.now() - 7 * 3600e3).toISOString(), lastTouch: new Date(Date.now() - 7 * 3600e3).toISOString() }); // stale → no vale
  const cdb = bash.handle({ tool_name: 'Bash', session_id: 's9', cwd: outside, tool_input: { command: `cd ${repo} && cat > src/Foo.cs <<'EOF'\nx\nEOF` } }, { stateDir });
  assert.ok(cdb && /CÓDIGO SIN CARRIL/.test(cdb.block));
  // pasa bajo ad-hoc Y registra el archivo en el cupo (H9)
  const f2 = path.join(repo, 'src', 'Bar.cs');
  assert.equal(bash.handle(ev(`cat > ${f2} <<'EOF'\nx\nEOF`), { stateDir }), null);
  assert.ok(io.readAdhoc(stateDir, 's1').files.some((f) => f === f2));
  // env off apaga el hook entero (documentado así — H7)
  process.env.TYCON_STORY_GATE = 'off';
  try { assert.equal(bash.handle(ev("cat > src/Foo.cs <<'EOF'\nx\nEOF"), { stateDir: tmpState() }), null); } finally { delete process.env.TYCON_STORY_GATE; }
});

test('on-story-gate.handle (Edit|Write): bloquea sin carril, pasa con marker, env off apaga', () => {
  const onStoryGate = require(path.join(SCRIPTS, 'on-story-gate.js'));
  const stateDir = tmpState();
  const repo = mkRepo(true);
  const ev = { tool_name: 'Edit', session_id: 's1', cwd: repo, tool_input: { file_path: path.join(repo, 'src', 'A.cs') } };
  const b = onStoryGate.handle(ev, { stateDir });
  assert.ok(b && /CÓDIGO SIN CARRIL/.test(b.block) && /detectado en Edit/.test(b.block));
  fs.writeFileSync(path.join(stateDir, 'active', 's1.json'), JSON.stringify({ storyId: '1.1', sessionId: 's1', repoPath: repo, stepsPending: [4], lastTouch: new Date().toISOString() }));
  assert.equal(onStoryGate.handle(ev, { stateDir }), null);
  process.env.TYCON_STORY_GATE = 'off';
  try { assert.equal(onStoryGate.handle({ ...ev, session_id: 'sX' }, { stateDir }), null); } finally { delete process.env.TYCON_STORY_GATE; }
});

test('listOtherMarkers: ignora stale, terminados (stepsPending []) y markers de otro repo (H11)', () => {
  const stateDir = tmpState();
  const repo = mkRepo(true);
  const f = path.join(repo, 'src', 'a.ts');
  const now = new Date().toISOString();
  const w = (sid, m) => fs.writeFileSync(path.join(stateDir, 'active', `${sid}.json`), JSON.stringify({ sessionId: sid, lastTouch: now, ...m }));
  w('done', { storyId: 'D', repoPath: repo, stepsPending: [] });
  w('stale', { storyId: 'S', repoPath: repo, stepsPending: [5], lastTouch: new Date(Date.now() - 7 * 3600e3).toISOString() });
  w('other', { storyId: 'O', repoPath: '/otro/repo', stepsPending: [5] });
  w('live', { storyId: 'L', repoPath: repo, stepsPending: [5] });
  assert.deepEqual(io.listOtherMarkers(stateDir, 'me', f).map((m) => m.storyId), ['L']);
});


// ── Carril: se declara o se pregunta — la detección por frase se BORRÓ (2026-08-27) ─────────────
// Acá vivían ~180 líneas de tests de detectLane. Se fueron con la función: tres incidentes en tres
// días (#carril-sin-salida, #carril-no-detecta, y el "dale, probá con 2.5 segundos" cazado por
// revisión adversarial) demostraron que cada calibración del regex producía la falla opuesta.
// El contrato nuevo que estos tests protegen:
//   1. recordPrompt guarda el ring de prompts y NO fija carril — y LIMPIA un carril viejo.
//   2. Un ad-hoc declarado no se anula por lo que diga un prompt posterior.
//   3. Sin marker y sin ad-hoc, el portón bloquea y el mensaje manda a PREGUNTAR al user.
//   4. El juicio de `adhoc set` (cita mecánica + clasificador por modelo) vive en marker.js y el
//      clasificador tiene su propia suite (tests/lane-classifier.test.js).

test('el carril no se adivina: ningún prompt fija lane, y un lane viejo se limpia', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'));
  const sid = 's-nolane';
  // Frases de los TRES incidentes: ninguna puede volver a fijar carril.
  const frases = [
    'implementemos la story 2.3',                 // pipeline según el regex viejo
    'dale, probá con timeout de 2.5 segundos',    // el falso positivo del 2026-08-27
    'es un hotfix, hacelo sin story',             // adhoc según el regex viejo
    'arranca con la 1.1',                         // el miss del 2026-08-27
  ];
  for (const f of frases) {
    const l = io.recordPrompt(stateDir, sid, f);
    assert.equal(l.lane, undefined, `"${f}" no debe fijar carril`);
  }
  // Un lane que quedó escrito por la versión vieja del hook se limpia al primer prompt nuevo.
  const file = io.lanePath(stateDir, sid);
  const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
  stale.lane = 'pipeline'; stale.laneSetAt = new Date().toISOString(); stale.lanePrompt = 'viejo';
  fs.writeFileSync(file, JSON.stringify(stale));
  const l = io.recordPrompt(stateDir, sid, 'seguimos');
  assert.equal(l.lane, undefined, 'el lane heredado del regex borrado tiene que limpiarse');
  assert.equal(l.recentPrompts.length, 5);
});

test('un ad-hoc declarado NO se anula por un prompt posterior (el voiding se fue con el regex)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'));
  const sid = 's-novoid';
  io.recordPrompt(stateDir, sid, 'arreglá el bug del redirect');
  io.writeAdhoc(stateDir, sid, { reason: 'arreglá el bug del redirect', maxFiles: 8, files: [], declaredAt: new Date().toISOString(), lastTouch: new Date().toISOString() });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  fs.mkdirSync(path.join(repo, '.git')); fs.mkdirSync(path.join(repo, '.tycon')); fs.mkdirSync(path.join(repo, 'src'));
  const file = path.join(repo, 'src', 'Foo.cs');
  assert.equal(io.evaluate({ filePath: file, sessionId: sid, stateDir, via: 'Edit' }).verdict.action, 'pass');
  // El caso que ayer ANULABA el ad-hoc a mitad de trabajo: una frase con pinta de story.
  io.recordPrompt(stateDir, sid, 'implementemos la spec spec/x.md, tests scoped');
  const r = io.evaluate({ filePath: file, sessionId: sid, stateDir, via: 'Edit' });
  assert.equal(r.verdict.action, 'pass', 'el ad-hoc declarado sigue cubriendo — nadie lo anuló por regex');
  // ring sigue funcionando
  for (let i = 0; i < 10; i++) io.recordPrompt(stateDir, sid, `prompt ${i}`);
  assert.equal(io.readLane(stateDir, sid).recentPrompts.length, 8);
});

test('sin carril el portón bloquea y el mensaje manda a preguntar en castellano llano', () => {
  const msg = gate.blockMessage(
    { kind: 'no-lane' },
    { file: '/repo/database/x.sql', repoRoot: '/repo', otherMarkers: [] },
  );
  assert.match(msg, /PREGUNTALE/i, 'la salida sin carril es preguntar, no adivinar');
  assert.match(msg, /castellano llano/i);
  assert.match(msg, /adhoc set/, 'el camino del atajo declarado sigue documentado');
});

test('reasonInPrompts: fragmento literal del user sí (sin mayúsculas/acentos/comillas), paráfrasis no, corto no, sin prompts no', () => {
  const prompts = ['Hotfix del botón "Guardar": queda deshabilitado', 'dale'];
  assert.equal(gate.reasonInPrompts('hotfix del boton guardar', prompts), true);
  assert.equal(gate.reasonInPrompts('  Botón Guardar: queda deshabilitado ', prompts), true);
  assert.equal(gate.reasonInPrompts('arreglar el botón de guardado', prompts), false);
  assert.equal(gate.reasonInPrompts('dale', prompts), false);
  assert.equal(gate.reasonInPrompts('hotfix del botón', []), false);
});


// ── repo del harness: el dato lo resuelve el borde (remoto); la carpeta es sólo el respaldo ──────
test('harness: `isHarness` booleano manda sobre la carpeta; sin él decide la carpeta (respaldo)', () => {
  // Producto debajo de una carpeta llamada como el arnés: el borde dijo que NO es el arnés → bloquea.
  const producto = { ...BASE, filePath: '/w/tycon-claude-guides/MiProducto/src/Foo.cs', repoRoot: '/w/tycon-claude-guides/MiProducto' };
  assert.equal(gate.computeStoryGate({ ...producto, isHarness: false }).kind, 'no-lane');
  // Clon del arnés en una carpeta con otro nombre: el borde dijo que SÍ → pasa.
  const clon = gate.computeStoryGate({ ...BASE, filePath: '/tmp/scratchpad/tcg/scripts/hooks/a.js', repoRoot: '/tmp/scratchpad/tcg', isHarness: true });
  assert.equal(clon.action, 'pass'); assert.match(clon.reason, /harness/);
  // Nadie resolvió el dato (llamador viejo): la conducta de siempre, por carpeta.
  assert.equal(gate.computeStoryGate(producto).action, 'pass');
  // El state-dir bloquea siempre, también en un repo del harness.
  assert.equal(gate.computeStoryGate({ ...BASE, filePath: '/home/u/.claude/.tycon-pipeline/active/s1.json', isHarness: true }).kind, 'state-dir');
});

// ── installed-tree: el árbol instalado del arnés no se escribe, en ningún modo ─────────
function mkInstalled() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inst-')));
  const tree = path.join(base, '.tycon', 'harness');
  fs.mkdirSync(path.join(tree, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(base, '.claude'), { recursive: true });
  fs.symlinkSync(tree, path.join(base, '.claude', 'tycon-harness'), 'junction');
  return { base, tree, link: path.join(base, '.claude', 'tycon-harness'), roots: [tree] };
}

test('InstalledTree_DeniedAlways', () => {
  const { tree } = mkInstalled();
  const roots = [tree];
  const marker = { storyId: '9.9', stepsPending: [], repoPath: '/w/otro' };
  for (const f of [path.join(tree, 'skills', 'a.js'), path.join(tree, 'guia.md')]) {
    for (const extra of [{}, { marker }, { gateEnabled: false }, { isHarness: true }]) {
      const r = gate.computeStoryGate({ ...BASE, filePath: f, realFilePath: f, installedRoots: roots, ...extra });
      assert.equal(r.action, 'block', `${f} ${JSON.stringify(extra)}`);
      assert.equal(r.kind, 'installed-tree');
    }
  }
});

test('InstalledTree_ClonesConfigProjectPass', () => {
  const { base, tree } = mkInstalled();
  const roots = [tree];
  const wt = path.join(base, 'SourceCode', 'tycon-harness-wt-x', 'skills', 'a.js');
  for (const f of [wt, path.join(base, '.tycon', 'config.json'), `${REPO}/specs/s.md`, path.join(os.tmpdir(), 'x.md')]) {
    const r = gate.computeStoryGate({ ...BASE, filePath: f, realFilePath: f, installedRoots: roots });
    assert.notEqual(r.kind, 'installed-tree', f);
  }
});

test('InstalledTree_MessageInPlainWords', () => {
  const { tree } = mkInstalled();
  const f = path.join(tree, 'guia.md');
  const r = gate.computeStoryGate({ ...BASE, filePath: f, realFilePath: f, installedRoots: [tree] });
  const m = gate.blockMessage(r, { filePath: f });
  assert.match(m, /^⛔ el arnés instalado no se edita/);
  assert.match(m, /El arnés se cambia con un pedido a su repo, no editando la instalación\./);
  assert.match(m, /La próxima actualización reemplaza este árbol entero\./);
  assert.doesNotMatch(m, /installed-tree|kind|[A-Z]{3,}-[CW]\d/);
  // un paquete de revisores propio escrito en el árbol: el mensaje dice que ahí se pierde
  const pk = path.join(tree, 'packs', 'mi-stack', 'pack.json');
  const rp = gate.computeStoryGate({ ...BASE, filePath: pk, realFilePath: pk, installedRoots: [tree] });
  const mp = gate.blockMessage(rp, { filePath: pk });
  assert.match(mp, /paquete de revisores propio tampoco va acá/);
  // nombra el lugar que sobrevive a las actualizaciones, y cómo armarlo si no lo hay
  assert.match(mp, /repo del perfil/);
  assert.match(mp, /packs\/<nombre>\//);
  assert.match(mp, /harness\.js team-init --local/);
  assert.match(mp, /aunque seas una sola persona/);
  assert.doesNotMatch(mp, /todavía no tiene un lugar/);
  assert.doesNotMatch(m, /paquete de revisores/);
  // una carpeta packs más abajo en el árbol no es la de los paquetes
  const doc = path.join(tree, 'docs', 'packs', 'x.md');
  const rd = gate.computeStoryGate({ ...BASE, filePath: doc, realFilePath: doc, installedRoots: [tree] });
  assert.doesNotMatch(gate.blockMessage(rd, { filePath: doc }), /paquete de revisores/);
});

test('StateDir_ByRealPath', () => {
  const real = fs.realpathSync(tmpState());
  const linkBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lnk-')));
  const link = path.join(linkBase, '.tycon-pipeline');
  fs.symlinkSync(real, link, 'junction');
  const r = io.evaluate({ filePath: path.join(link, 'active', 's1.json'), sessionId: 's1', stateDir: real, installedRoots: [] });
  assert.equal(r.verdict.action, 'block');
  assert.equal(r.verdict.kind, 'state-dir');
});

test('BashWrite_InstalledTree_Denied', () => {
  const { tree, link } = mkInstalled();
  const stateDir = tmpState();
  const repo = mkRepo(false);
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  const opts = { stateDir, installedRoots: [tree] };
  for (const cmd of [`echo x > ${path.join(tree, 'a.md')}`, `cp src/a ${path.join(link, 'b.js')}`, `echo x | tee ${path.join(tree, 'c.txt')}`]) {
    const b = bash.handle(ev(cmd), opts);
    assert.ok(b && /el arnés instalado no se edita/.test(b.block), cmd);
  }
  assert.equal(bash.handle(ev('echo x > ./proyecto.md'), opts), null);
});

test('BashWrite_InstalledTree_OtherForms', () => {
  // las formas que el pase adversarial mostró que pasaban: sed/perl en sitio sobre un archivo que no es código, el
  // destino de cp/mv escondido por una redirección final o dado con -t, y las redirecciones &> >| >&
  const { tree, link } = mkInstalled();
  fs.writeFileSync(path.join(tree, 'guia.md'), 'x\n');
  const stateDir = tmpState();
  const repo = mkRepo(false);
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  const opts = { stateDir, installedRoots: [tree] };
  const g = path.join(link, 'guia.md');
  for (const cmd of [
    `sed -i '' 's/x/y/' ${g}`,
    `perl -pi -e 's/x/y/' ${g}`,
    `cp a ${path.join(tree, 'b.md')} 2>&1`,
    `mv a ${path.join(tree, 'b.md')} 2>/dev/null`,
    `cp -t ${tree} a`,
    `mv --target-directory=${link} a`,
    `echo x &> ${g}`,
    `echo x >| ${g}`,
    `echo x >& ${g}`,
  ]) {
    const b = bash.handle(ev(cmd), opts);
    assert.ok(b && /el arnés instalado no se edita/.test(b.block), cmd);
  }
  // el destino entre comillas, los -t agrupados o pegados, y las formas de PowerShell con redirección final
  for (const cmd of [
    `cp a "${path.join(tree, 'b.md')}"`,
    `cp a '${path.join(tree, 'b.md')}'`,
    `sed -i '' 's/x/y/' "${g}"`,
    `echo x | tee -a "${path.join(tree, 'f')}"`,
    `echo x >| "${g}"`,
    `cp -rt ${tree} a`,
    `mv -vt ${tree} a`,
    `cp -t${tree} a`,
    `Copy-Item a ${path.join(tree, 'b.md')} 2>&1`,
    `cp a "b.md"`.replace('"b.md"', `"${path.join(tree, 'b.md')}"`),
    `cp a ${path.join(tree, 'b.md')} -f`,
    `Copy-Item a ${path.join(tree, 'b.md')} -Force`,
    `cp a ${path.join(tree, 'b.md')} # nota`,
    `cp -t /tmp/x -t ${tree} a`,
    `mv --target-directory ${tree} a`,
    `perl -i.bak -pe 's/x/y/' ${g}`,
    `perl -pi.bak -e 's/x/y/' ${g}`,
    `sed -i ${g} -ne p`,
    `sed -i 's/a b/c/' ${g}`,
    `sed -i -es/a/b/ ${g}`,
    `sed -i -e 's/a/b/' ${g}`,
  ]) {
    const b = bash.handle(ev(cmd), opts);
    assert.ok(b && /el arnés instalado no se edita/.test(b.block), cmd);
  }
  // con la sesión parada en el árbol, un destino entre comillas sin barra también se ve
  const enElArbol = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: tree, tool_input: { command } });
  assert.ok(/el arnés instalado no se edita/.test((bash.handle(enElArbol('cp a "b.md"'), opts) || {}).block || ''));
  // un destino con $HOME hacia el árbol
  const prevHome = process.env.HOME;
  process.env.HOME = path.dirname(path.dirname(tree));
  try {
    const b = bash.handle(ev(`echo x > $HOME/.tycon/harness/a.md`), opts);
    assert.ok(b && /el arnés instalado no se edita/.test(b.block), '$HOME');
  } finally { process.env.HOME = prevHome; }
  // una ruta de Windows entre comillas (con barras invertidas) se lee como destino
  assert.deepEqual(bash.extractWriteTargets('Copy-Item a "C:\\Users\\x\\.tycon\\harness\\b.md"'), ['C:\\Users\\x\\.tycon\\harness\\b.md']);
  // con -t cuenta cada archivo que llega: copiar código a una carpeta del repo sigue siendo escribir código
  assert.deepEqual(bash.extractWriteTargets('cp -t src a.ts b.md').sort(), ['src', 'src/a.ts', 'src/b.md']);
  assert.deepEqual(bash.extractWriteTargets('cp a.cs -tsrc b.cs').sort(), ['src', 'src/a.cs', 'src/b.cs']);
  // la expresión de sed no es un archivo: con la sesión parada adentro del árbol, editar un archivo de afuera pasa
  const enArbol = { tool_name: 'Bash', session_id: 's1', cwd: tree, tool_input: { command: `sed -i '' 's/a/b/' ${path.join(repo, 'x.md')}` } };
  assert.equal(bash.handle(enArbol, opts), null);
  for (const cmd of [`sed -i -e 's/a/b/' ${path.join(repo, 'x.md')}`, `perl -pi -e 's/x/y/' ${path.join(repo, 'x.md')}`]) {
    assert.equal(bash.handle({ ...enArbol, tool_input: { command: cmd } }, opts), null, cmd);
  }
  // un texto entre comillas con espacios sigue sin leerse como destino
  assert.deepEqual(bash.extractWriteTargets('git commit -m "fix > src/a.ts"'), []);
  // sed en sitio sobre un archivo del proyecto que no es código sigue pasando, y `>&2` no es un destino
  assert.equal(bash.handle(ev("sed -i '' 's/x/y/' notas.md"), opts), null);
  assert.equal(bash.handle(ev('echo x >&2'), opts), null);
});

test('StateDir_RealPathOfALinkedStateDir', () => {
  // la carpeta del estado puede ser un enlace (la de ~/.claude antes de la mudanza): escribir por su destino real también
  // es escribir el estado
  const real = fs.realpathSync(tmpState());
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lnk2-')));
  const link = path.join(base, '.tycon-pipeline');
  fs.symlinkSync(real, link, 'junction');
  const r = io.evaluate({ filePath: path.join(real, 'active', 's1.json'), sessionId: 's1', stateDir: link, installedRoots: [] });
  assert.equal(r.verdict.kind, 'state-dir');
  const repo = mkRepo(false);
  const b = bash.handle({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command: `echo x > ${path.join(real, 'active', 's1.json')}` } }, { stateDir: link, installedRoots: [] });
  assert.ok(b && /ESTADO DEL PIPELINE/.test(b.block));
});

test('InstalledRoots_EmptyAnswerIsNotKept', () => {
  // las raíces se guardan una vez encontradas; una respuesta vacía no se guarda
  assert.ok(Array.isArray(io.defaultInstalledRoots()));
  const src = fs.readFileSync(path.join(SCRIPTS, 'lib', 'story-gate-io.js'), 'utf8');
  assert.match(src, /if \(r\.length\) installedRootsMemo = r;/);
});
