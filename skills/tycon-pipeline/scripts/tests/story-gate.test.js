#!/usr/bin/env node
/**
 * story-gate.test.js — portón de carril: lógica pura (lib/story-gate.js), capa I/O con state dir temporal y
 * guard de Bash. SIN procesos externos → corre en cada SessionStart. Lo que lanza git/marker.js CLI vive en
 * story-gate-cli.test.js (throttle diario).
 *
 * stable-data: no crea commits — «git commit» aparece sólo como texto de comandos que el freno lee sin ejecutarlos.
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

const SCRIPTS = path.join(__dirname, '..');
const gate = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
const io = require(path.join(SCRIPTS, 'lib', 'story-gate-io.js'));
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));
const { conCarpetaPersonal } = require(path.join(__dirname, 'lib', 'fake-home.js'));

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

// Un arreglo rápido que abrió la coordinadora por delegación nunca toca lo sensible (firmas, frenos, avisos, permisos, el
// perfil): eso va con la firma del dueño. Vale también en los repos del arnés, que es donde están esos archivos; el
// arreglo rápido que firmó una persona sigue como siempre.
// 🔴 mutación: sin mirar la vía del carril → la coordinadora edita scripts/lib/signatures.js con su propio arreglo.
test('adhoc-sensitive: el carril delegado no toca lo sensible, en ningún repo', () => {
  const delegado = { reason: 'x fix', maxFiles: 5, files: [], via: 'delegacion' };
  for (const [repo, archivo, harness] of [[REPO, 'scripts/lib/signatures.js', false], ['/w/arnes', 'scripts/lib/owner-window.js', true], [REPO, 'scripts/production/guard.sh', false]]) {
    const r = gate.computeStoryGate({ ...BASE, repoRoot: repo, filePath: `${repo}/${archivo}`, adhoc: delegado, isHarness: harness });
    assert.equal(r.action, 'block', `${archivo}: ${r.reason}`);
    assert.equal(r.kind, 'adhoc-sensitive', archivo);
    assert.ok(r.reason.includes(archivo), `el motivo nombra el archivo: ${r.reason}`);
  }
  // lo que no es sensible, por delegación: pasa
  assert.equal(gate.computeStoryGate({ ...BASE, adhoc: delegado }).action, 'pass');
  // el mismo archivo con el carril que firmó una persona: lo de siempre
  for (const via of ['terminal', 'ventana', undefined]) {
    const r = gate.computeStoryGate({ ...BASE, filePath: `${REPO}/scripts/lib/signatures.js`, adhoc: { ...delegado, via } });
    assert.equal(r.action, 'pass', `${via}: ${r.reason}`);
  }
  // y con el portón del repo apagado, el delegado tampoco
  assert.equal(gate.computeStoryGate({ ...BASE, filePath: `${REPO}/scripts/lib/signatures.js`, adhoc: delegado, gateEnabled: false }).kind, 'adhoc-sensitive');
});

// El cupo de un arreglo rápido delegado: hasta 5 archivos, pida lo que pida.
// 🔴 mutación: el tope de antes (8) → un pedido de 8 queda en 8.
test('cupoDelegado: el arreglo rápido delegado queda en 5 archivos como mucho', () => {
  assert.equal(gate.DELEGATED_ADHOC_MAX_FILES, 5);
  for (const [pedido, queda] of [[1, 1], [5, 5], [6, 5], [8, 5], [50, 5]]) assert.equal(gate.cupoDelegado(pedido), queda, String(pedido));
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

// La declaración del arreglo rápido como la deja `marker.js adhoc set`: el archivo con la hora de la firma y el renglón
// `adhoc-lane-signed` de esa sesión en gates.log.
function adhocFirmado(stateDir, sid, obj, { firmaTs = new Date(Date.now() - 1000), destino = sid } = {}) {
  const firmadaEn = new Date(firmaTs.getTime() + 500).toISOString();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify({ ts: firmaTs.toISOString(), name: 'adhoc-lane-signed', status: 'ok', via: 'ventana', sesion: sid, destino })}\n`);
  return io.writeAdhoc(stateDir, sid, { ...obj, firmadaEn });
}

// 8.141 T18 AdhocSinFirma_NoAbreElPorton @story-8.141 @ac-4 @ac-8
// El portón abre con la declaración del arreglo rápido sólo si trae su firma en gates.log. Limitación: gates.log vive en
// la misma carpeta de estado; esto frena el archivo escrito suelto, no a quien esquive el freno de esa carpeta.
// 🔴 Falla con: un archivo del arreglo rápido escrito a mano (sin la hora de la firma, sin su renglón, con el renglón de
// otra sesión o de otro momento) que abre el portón.
test('8.141 T18 AdhocSinFirma_NoAbreElPorton', () => {
  const ahora = new Date().toISOString();
  const base = { reason: 'hotfix x', maxFiles: 8, files: [], declaredAt: ahora, lastTouch: ahora };
  const repo = mkRepo(true);
  const f = path.join(repo, 'src/a.ts');
  const veredicto = (stateDir) => io.evaluate({ filePath: f, sessionId: 's1', stateDir }).verdict.kind;
  // a mano, sin la hora de la firma
  let sd = tmpState();
  io.writeAdhoc(sd, 's1', base);
  assert.equal(veredicto(sd), 'no-lane', 'sin la hora de la firma');
  // con la hora pero sin renglón
  sd = tmpState();
  io.writeAdhoc(sd, 's1', { ...base, firmadaEn: ahora });
  assert.equal(veredicto(sd), 'no-lane', 'sin el renglón adhoc-lane-signed');
  // el bloqueo dice que hay una declaración sin firma reconocida, y por qué; el registro también
  const sinFirma = io.evaluate({ filePath: f, sessionId: 's1', stateDir: sd });
  assert.match(sinFirma.message, /declaración del arreglo rápido.*sin su firma/s);
  assert.match(sinFirma.message, /no está el renglón de su firma/);
  const bloqueo = fs.readFileSync(path.join(sd, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.name === 'story-gate').pop();
  assert.match(String(bloqueo.adhocSinFirma), /no está el renglón de su firma/);
  // el renglón es de otra sesión
  sd = tmpState();
  adhocFirmado(sd, 's1', base, { destino: 's2' });
  assert.equal(veredicto(sd), 'no-lane', 'firma de otra sesión');
  // el renglón es de mucho antes de la declaración
  sd = tmpState();
  const vieja = adhocFirmado(sd, 's1', base, { firmaTs: new Date(Date.now() - 3600e3) });
  io.writeAdhoc(sd, 's1', { ...vieja, firmadaEn: ahora });
  assert.equal(veredicto(sd), 'no-lane', 'firma de otro momento');
  // firmada: abre, y sumar un archivo al cupo no le saca la firma
  sd = tmpState();
  adhocFirmado(sd, 's1', base);
  assert.equal(io.evaluate({ filePath: f, sessionId: 's1', stateDir: sd }).verdict.action, 'pass');
  io.recordAdhocFile(sd, 's1', f);
  assert.equal(io.evaluate({ filePath: f, sessionId: 's1', stateDir: sd }).verdict.action, 'pass');
});

test('io.evaluate: repo sin .tycon ni stories → pass; con .tycon → no-lane; con adhoc → pass; marker plan → block', () => {
  const stateDir = tmpState();
  const plain = mkRepo(false);
  assert.equal(io.evaluate({ filePath: path.join(plain, 'src/a.ts'), sessionId: 's1', stateDir }).verdict.action, 'pass');

  const repo = mkRepo(true);
  const f = path.join(repo, 'src/a.ts');
  const r1 = io.evaluate({ filePath: f, sessionId: 's1', stateDir });
  assert.equal(r1.verdict.kind, 'no-lane'); assert.match(r1.message, /CÓDIGO SIN CARRIL/);
  assert.match(fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8'), /"name":"story-gate"/);
  // La entry lleva el repo (namespace) — misma key `repoPath` que marker.js.
  const sgEntry = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).find((e) => e.name === 'story-gate' && e.status === 'blocked');
  assert.ok(sgEntry && sgEntry.repoPath, 'story-gate blocked lleva repoPath');
  assert.equal(fs.realpathSync(sgEntry.repoPath), fs.realpathSync(repo));

  adhocFirmado(stateDir, 's1', { reason: 'hotfix x', maxFiles: 8, files: [], declaredAt: new Date().toISOString(), lastTouch: new Date().toISOString() });
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
  adhocFirmado(stateDir, 's1', { reason: 'hotfix x', files: [], declaredAt: new Date().toISOString(), lastTouch: new Date().toISOString() });
  assert.equal(bash.handle(ev("cat > src/Foo.cs <<'EOF'\nx\nEOF"), { stateDir }), null);
  // Write al state dir por Bash también se deniega
  const sd = bash.handle(ev(`echo '{}' > ${path.join(stateDir, 'active', 's1.json')}`), { stateDir });
  assert.ok(sd && /ESTADO DEL PIPELINE/.test(sd.block));
  // `cd <dir> &&` resuelve el target contra ese dir
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nocwd-'));
  io.writeAdhoc(stateDir, 's9', { reason: 'x', files: [], declaredAt: new Date(Date.now() - 7 * 3600e3).toISOString(), lastTouch: new Date(Date.now() - 7 * 3600e3).toISOString() }); // stale → no vale
  const cdb = bash.handle({ tool_name: 'Bash', session_id: 's9', cwd: outside, tool_input: { command: `cd ${repo} && cat > src/Foo.cs <<'EOF'\nx\nEOF` } }, { stateDir });
  assert.ok(cdb && /CÓDIGO SIN CARRIL/.test(cdb.block));
  // pasa bajo ad-hoc Y registra el archivo en el cupo
  const f2 = path.join(repo, 'src', 'Bar.cs');
  assert.equal(bash.handle(ev(`cat > ${f2} <<'EOF'\nx\nEOF`), { stateDir }), null);
  assert.ok(io.readAdhoc(stateDir, 's1').files.some((f) => f === f2));
  // env off apaga el hook entero (documentado así)
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


// ── Carril: se declara o se pregunta — no hay detección por frase ─────────────
// El carril no se detecta por regex sobre la frase: cada calibración de un regex produce la falla
// opuesta (un "dale, probá con 2.5 segundos" fijaría carril, por ejemplo).
// El contrato que estos tests protegen:
//   1. Un ad-hoc declarado no se anula por lo que diga un prompt posterior.
//   2. Sin marker y sin ad-hoc, el portón bloquea y el mensaje manda a PREGUNTAR al user.
//   3. Declarar el ad-hoc (`marker.js adhoc set`) es una firma del dueño en la ventana de permiso: vive en marker.js y
//      en owner-window.js, y lo prueban story-gate-cli.test.js y owner-window.test.js.

test('un ad-hoc declarado NO se anula por un prompt posterior (el voiding se fue con el regex)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'));
  const sid = 's-novoid';
  adhocFirmado(stateDir, sid, { reason: 'arreglá el bug del redirect', maxFiles: 8, files: [], declaredAt: new Date().toISOString(), lastTouch: new Date().toISOString() });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  fs.mkdirSync(path.join(repo, '.git')); fs.mkdirSync(path.join(repo, '.tycon')); fs.mkdirSync(path.join(repo, 'src'));
  const file = path.join(repo, 'src', 'Foo.cs');
  assert.equal(io.evaluate({ filePath: file, sessionId: sid, stateDir, via: 'Edit' }).verdict.action, 'pass');
  // Una frase con pinta de story no anula el ad-hoc a mitad de trabajo: el portón no lee los mensajes.
  const r = io.evaluate({ filePath: file, sessionId: sid, stateDir, via: 'Edit' });
  assert.equal(r.verdict.action, 'pass', 'el ad-hoc declarado sigue cubriendo — nadie lo anuló por regex');
});

test('sin carril el portón bloquea y el mensaje manda a preguntar en castellano llano', () => {
  const msg = gate.blockMessage(
    { kind: 'no-lane' },
    { file: '/repo/database/x.sql', repoRoot: '/repo', otherMarkers: [] },
  );
  assert.match(msg, /PREGUNTALE/i, 'la salida sin carril es preguntar, no adivinar');
  assert.match(msg, /castellano llano/i);
  assert.match(msg, /adhoc set/, 'el camino del atajo declarado sigue documentado');
  assert.match(msg, /ventana de permiso/, 'el atajo lo aprueba el dueño en la ventana');
  assert.doesNotMatch(msg, /fragmento LITERAL|LITERAL de un prompt/i, 'no pide citar al user');
});

test('T34 SinCarril_TraeLaPreguntaAprobada_TextualYSinCuadro', () => {
  const msg = gate.blockMessage({ kind: 'no-lane' }, { filePath: '/repo/src/a.ts', repoRoot: '/repo', otherMarkers: [] });
  const pregunta = [
    'Este cambio no tiene historia. ¿Cómo sigo?',
    '1. Directo en el código (arreglo rápido: corre igual las pruebas y la revisión). Escribí: arreglo rápido: <qué cambio>',
    '2. Con historia. Escribí: con historia',
    'Lo tenés que escribir vos en el chat: el cuadro de botones no vale.',
  ];
  const lineas = msg.split('\n').map((l) => l.trim());
  const desde = lineas.indexOf(pregunta[0]);
  assert.ok(desde >= 0, 'el bloqueo trae la pregunta aprobada, con su primera línea tal cual');
  assert.deepEqual(lineas.slice(desde, desde + pregunta.length), pregunta, 'las cuatro líneas, seguidas y sin cambios');
  assert.match(msg, /textual/i, 'le dice al agente que la muestre tal cual');
  assert.match(msg, /cuadro de opciones/i, 'y que no la ponga en un cuadro de opciones');
});

// ── repo del harness: el dato lo resuelve el borde (remoto); la carpeta es sólo el respaldo ──────
test('harness: `isHarness` booleano manda sobre la carpeta; sin él decide la carpeta (respaldo)', () => {
  // Producto debajo de una carpeta llamada como el arnés: el borde dijo que NO es el arnés → bloquea.
  const producto = { ...BASE, filePath: '/w/tycon-claude-guides/MiProducto/src/Foo.cs', repoRoot: '/w/tycon-claude-guides/MiProducto' };
  assert.equal(gate.computeStoryGate({ ...producto, isHarness: false }).kind, 'no-lane');
  // Clon del arnés en una carpeta con otro nombre: el borde dijo que SÍ → pasa.
  const clon = gate.computeStoryGate({ ...BASE, filePath: '/tmp/scratchpad/tcg/scripts/hooks/a.js', repoRoot: '/tmp/scratchpad/tcg', isHarness: true });
  assert.equal(clon.action, 'pass'); assert.match(clon.reason, /harness/);
  // Nadie resolvió el dato (llamador sin el dato): la conducta por defecto, por carpeta.
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
  // otras formas posibles: sed/perl en sitio sobre un archivo que no es código, el
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
  conCarpetaPersonal(path.dirname(path.dirname(tree)), () => {
    const b = bash.handle(ev(`echo x > $HOME/.tycon/harness/a.md`), opts);
    assert.ok(b && /el arnés instalado no se edita/.test(b.block), '$HOME');
  });
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
  // la carpeta del estado puede ser un enlace (por ejemplo la de ~/.claude): escribir por su destino real también
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

// ── ediciones por la terminal con el pipeline abierto: manifiestos, intérpretes, borrar y deshacer ──────────
// Una corrida abierta con el plan aprobado: el carril deja editar y el registro exige Edit/Write.
/** Una carpeta temporal escrita como la escribe un comando del bash de Git: el nombre largo (sin el `~` del nombre corto
 *  de Windows) y con barras normales (la barra invertida es un escape para bash). En Mac y Linux, la ruta real. */
function carpetaParaBash(prefijo) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefijo))).replace(/\\/g, '/');
}

function corridaAbierta({ pendiente = [4, 5, 6, 7, 8] } = {}) {
  const stateDir = tmpState();
  const repo = fs.realpathSync(mkRepo(false));
  fs.writeFileSync(path.join(stateDir, 'active', 's1.json'), JSON.stringify({
    storyId: '9.9', repoPath: repo, sessionId: 's1', stepsCompleted: [0, 1, 2, 3], stepsPending: pendiente,
  }));
  return { stateDir, repo };
}
function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}
const SIN_REGISTRO = { TYCON_LEDGER_VISIBLE: undefined, TYCON_STORY_GATE: undefined, TYCON_NO_RUN_CHANGE: '1' };
const INVISIBLE = /EDICIÓN INVISIBLE/;
// los argumentos de un programa que llega por un heredoc los lee el lector compartido de la entrada; una instalación sin
// él (un clon de skills suelto) toma cada cuerpo de heredoc como programa sin argumentos y frena de más
const CON_LECTOR = fs.existsSync(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'shell-parse.js'));
const heredocConArgumentos = (b, cmd) => (CON_LECTOR ? assert.equal(b, null, cmd) : assert.ok(b && INVISIBLE.test(b.block), cmd));

test('T29 Freno_ManifiestosYLocks_SonCodigo', () => {
  const { stateDir, repo } = corridaAbierta();
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  conEnv(SIN_REGISTRO, () => {
    for (const cmd of [
      `node -e "require('fs').writeFileSync('package.json','{}')"`,
      'echo {} > package-lock.json',
      "sed -i 's/a/b/' yarn.lock",
      'echo x >> pnpm-lock.yaml',
      "perl -pi -e 's/1/2/' Directory.Packages.props",
      'cp /tmp/otro.json npm-shrinkwrap.json',
      'echo {} > src/packages.lock.json',
    ]) {
      const b = bash.handle(ev(cmd), { stateDir, installedRoots: [] });
      assert.ok(b && INVISIBLE.test(b.block), cmd);
    }
  });
  // el carril no cambia: sin corrida, un manifiesto sigue sin ser código para el portón
  assert.equal(gate.isCodeFile('/r/package.json'), false);
  assert.equal(gate.isManifestFile('/r/package.json'), true);
  assert.equal(gate.isManifestFile('/r/node_modules/x/package.json'), false, 'el de una dependencia no es del repo');
});

test('T41 Freno_CarpetaPorEnlace_FrenaIgual @story-8.93 @ac-15 @ac-22', () => {
  // la sesión parada en el repo por un enlace (en la Mac, /tmp y /var/folders; en Windows, una unión): el marcador
  // guarda la ruta real y la escritura se compara por ruta real, no por cómo llegó la carpeta
  const { stateDir, repo } = corridaAbierta();
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const enlace = path.join(path.dirname(repo), `${path.basename(repo)}-enlace`);
  fs.symlinkSync(repo, enlace, process.platform === 'win32' ? 'junction' : 'dir');
  conEnv(SIN_REGISTRO, () => {
    for (const cmd of [`node -e "require('fs').writeFileSync('package.json','{}')"`, 'echo x > src/a.ts', 'echo {} > package-lock.json']) {
      const b = bash.handle({ tool_name: 'Bash', session_id: 's1', cwd: enlace, tool_input: { command: cmd } }, { stateDir, installedRoots: [] });
      assert.ok(b && INVISIBLE.test(b.block), `por el enlace: ${cmd}`);
    }
    // y al revés: el marcador con la ruta del enlace y la sesión en la ruta real
    const marcador = path.join(stateDir, 'active', 's1.json');
    fs.writeFileSync(marcador, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(marcador, 'utf8')), { repoPath: enlace })));
    const b = bash.handle({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command: 'echo x > src/a.ts' } }, { stateDir, installedRoots: [] });
    assert.ok(b && INVISIBLE.test(b.block), 'el marcador por el enlace');
  });
});

test('T36 Freno_FalsosPositivosDeLaMedicion @story-8.93 @ac-22', () => {
  // falsos positivos de la medición contra los comandos reales que no frenan: el cd mínimo y los argumentos por índice;
  // y los que siguen frenando por duda
  const { stateDir, repo } = corridaAbierta();
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'x');
  const fuera = carpetaParaBash('fuera-');
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  conEnv(SIN_REGISTRO, () => {
    // 1. la forma mínima del cd: `VAR=literal; … && cd DIR && <escritura>`, la escritura en la misma cadena de &&
    for (const cmd of [
      `L=${fuera}; cd $L && git checkout -q . && git clean -qfd`,
      `S=${fuera}; mkdir -p $S/d && cd $S/d && rm -f *`,
      `SP=${fuera}; rm -rf ${fuera}/r; mkdir -p ${fuera}/r; cd $SP/r && echo '{}' > package.json`,
      // lo que viene después de la cadena no cambia la carpeta de la escritura
      `S=${fuera}; mkdir -p $S/d && cd $S/d && rm -f *; for f in a b; do echo $f; done`,
      `cd ${fuera} && python3 - <<'EOF'\nopen('a.ts','w').write('x')\nEOF`,
    ]) assert.equal(bash.handle(ev(cmd), { stateDir, installedRoots: [] }), null, cmd);
    // 2. los argumentos del script por índice (`B, OUTF = sys.argv[1], sys.argv[2]` · `const f = process.argv[2]`)
    const porIndice = `OUTF=${fuera}/evidencia.md; python3 - "$OUTF" "${fuera}/otro.md" <<'EOF'\nimport sys\nOUTF,OTRO=sys.argv[1],sys.argv[2]\nopen(OUTF,'w').write('x')\nopen(OTRO,'w').write('y')\nEOF`;
    heredocConArgumentos(bash.handle(ev(porIndice), { stateDir, installedRoots: [] }), 'argumentos por índice, en Python');
    heredocConArgumentos(bash.handle(ev(`node - "${fuera}/a.ts" <<'EOF'\nconst f = process.argv[2]; require('fs').writeFileSync(f, 'x')\nEOF`), { stateDir, installedRoots: [] }), 'argumento por índice, en Node');
    // lo que sigue frenando
    for (const cmd of [
      // una llamada de Node escrita como texto en otro script: frena por duda (no se lee un lenguaje dentro de otro)
      `python3 - <<'EOF'\np='${fuera}/casos.json'\nt="node -e \\"require('fs').writeFileSync('package.json', 'x')\\""\nopen(p,'w').write(t)\nEOF`,
      `node -e 'const ejemplo = "fs.writeFileSync(path.join(d, f), x)"; console.log(ejemplo)'`,
      // lo que se escribe ANTES del cd, un cd que no se resuelve, un cd a otra carpeta del repo
      `echo x > src/a.ts; S=${fuera}; cd $S && ls`,
      'cd $NADIE_LA_DEFINE && echo x > src/a.ts',
      `cd ${repo}/src && python3 - <<'EOF'\np='a.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF\ncd ${fuera} && ls`,
      `S=${fuera}; for x in 1; do S=${repo}; done; cd $S && echo x > src/a.ts`,
      `D=${repo}/src; cd $D && echo x > a.ts`,
      `python3 - <<'EOF'\nimport os\nopen(os.path.join('src', 'a.ts'), 'w').write('x')\nEOF`,
      // un argumento por índice que cae en el repo, o que se reasigna después
      `python3 - "src/a.ts" <<'EOF'\nimport sys\nP,=sys.argv[1],\nopen(P,'w').write('x')\nEOF`,
      `node - "src/a.ts" <<'EOF'\nconst f = process.argv[2]; require('fs').writeFileSync(f, 'x')\nEOF`,
      `python3 - "${fuera}/x.md" <<'EOF'\nimport sys,os\nB = sys.argv[1]\nB = os.path.join('src','a.ts')\nopen(B,'w').write('x')\nEOF`,
    ]) {
      const b = bash.handle(ev(cmd), { stateDir, installedRoots: [] });
      assert.ok(b && INVISIBLE.test(b.block), cmd);
    }
  });
});

test('T41 Freno_PaseAdversarialE_SigueFrenando @story-8.93 @ac-15 @ac-22', () => {
  // comandos que escriben código o un manifiesto del repo de la ejecución por formas que esconden el destino (un cd que
  // no corre o corre en otro proceso, un intérprete que lanza otro, strings que tapan la llamada, una variable
  // reasignada): todos frenan
  const { stateDir, repo } = corridaAbierta();
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'x');
  const F = carpetaParaBash('fuera-');
  const R = repo;
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  const casos = [
    // el cd que no corre, corre en otro proceso o no es del nivel de arriba
    `false && cd ${F}; echo x > src/a.ts`, `( true; cd ${F} ); echo x > src/a.ts`, `echo "; cd ${F}"; echo x > src/a.ts`,
    `: '; cd ${F}'\necho x > src/a.ts`, `f() {\n cd ${F}\n}\necho x > src/a.ts`, `if false; then\ncd ${F}\nfi\necho x > src/a.ts`,
    `bash -c 'echo; cd ${F}'; echo x > src/a.ts`, `test -d ${F}/nope && cd ${F}/nope; echo x > src/a.ts`,
    `[ -d ${F}/nope ] && cd ${F}/nope; echo {} > package.json`, `cd ${F}/nope 2>/dev/null || true; echo x > src/a.ts`,
    `cd ${F} | cat; echo x > src/a.ts`, `cd ${F} & echo x > src/a.ts`, `while false; do\ncd ${F}\ndone; echo x > src/a.ts`,
    `git commit -qm "a; cd ${F}"; echo x > src/a.ts`, `echo hola # luego; cd ${F}\necho x > src/a.ts`,
    `D=$(true; cd ${F}; pwd); echo x > src/a.ts`, `true; cd ${F} | true; echo x > src/a.ts`, `true; ( true; cd ${F} ); echo x > src/a.ts`,
    `printf '%s\\n' 'a; cd ${F}'; echo x > src/a.ts`, `cd ${F}/../$(basename ${R}) && echo x > src/a.ts`,
    `cd ${F}/$(echo ..)/${path.basename(R)} && echo x > src/a.ts`, `cd ${F} || true; cd -P ${R} && echo x > src/a.ts`,
    `cd ${F} && cd - && echo x > src/a.ts`, `(true && cd ${F}) && echo x > src/a.ts`, `(cd /usr; cd ${F}) && echo x > src/a.ts`,
    `true | cd ${F}; echo x > src/a.ts`, `f(){ true; cd ${F}; }; echo x > src/a.ts`, `echo 'a; cd ${F}' && echo x > src/a.ts`,
    `sh -c 'true; cd ${F}'; echo x > src/a.ts`, `true || cd ${F}; echo x > src/a.ts`,
    `x=1; cd ${F}; for d in 1; do cd ${R}; done; echo x > src/a.ts`, `cd ${R}/src && cd .. && cd ${F} && cd - && echo x > src/a.ts`,
    `echo 'nota; cd ${F} ' >/dev/null; echo x > src/a.ts`, `node -e "console.log('; cd ${F}')" ; echo x > src/a.ts`,
    `cd ${F} && echo x > a.ts && cd ${R} && echo y > src/b.ts`,
    // un intérprete que lanza otro, y un script corto que tapaba la escritura de otro
    `python3 -c "import subprocess; subprocess.run(['node','-e', \\"require('fs').writeFileSync('src/a.ts','x')\\"])"`,
    `pwsh -Command "node -e \\"require('fs').writeFileSync('src/a.ts','x')\\""`,
    `node - <<'EOF'\nrequire('child_process').execSync("python3 -c \\"open('src/a.ts','w').write('1')\\"")\nEOF`,
    `python3 -c "w"; node -e "require('fs').writeFileSync('src/a.ts','x')"`, `python3 -c "("; node -e "require('fs').writeFileSync('src/a.ts','x')"`,
    `python3 -c "write" ; node -e "require('fs').writeFileSync('src/a.ts','x')"`, `python3 -c "src/a.ts" ; node -e "require('fs').writeFileSync('src/a.ts','x')"`,
    `python3 -c "ts"; node -e "require('fs').writeFileSync('src/a.ts','x')"`, `perl -e 'writeFileSync' ; node -e "require('fs').writeFileSync('src/a.ts','x')"`,
    `python3 -c 'Sync' ; node -e "require('fs').writeFileSync('src/a.ts','x')"`,
    // strings, regex e interpolaciones que tapaban la llamada de escritura
    `python3 - <<'EOF'\nimport os\n'''Fix the thing's import.'''\np = os.path.join('src', 'a.ts')\nopen(p, 'w').write('x')\n# don't forget\nEOF`,
    `node - <<'EOF'\nconst fs=require('fs'),path=require('path'); const re=/'/; fs.writeFileSync(path.join('src','a.ts'),'x'); const q=/'/;\nEOF`,
    `node - <<'EOF'\nconst fs=require('fs'); let p=process.env.T; let t=fs.readFileSync(p,'utf8'); t=t.replace(/'/g,'x'); fs.writeFileSync(p,t); const z=/'/;\nEOF`,
    `node - <<'EOF'\nconsole.log(\`\${require('fs').writeFileSync(process.env.T,'x')}\`)\nEOF`,
    `python3 - <<'EOF'\nimport os\np=os.environ['T']\nprint(f"{open(p,'w').write('x')}")\nEOF`,
    `node - <<'EOF'\nconst re=/'/; const p=require('path').join('src','a.ts'); require('fs').writeFileSync(p,'x'); const z=/'/;\nEOF`,
    `node -e "const fs=require('fs'); fs.open(process.env.T,'w',(e,fd)=>fs.writeSync(fd,'x'))"`,
    // un argumento por índice reasignado después
    `python3 - "${F}/x.md" "${F}/y.md" <<'EOF'\nimport sys,os\nA, B = sys.argv[1], sys.argv[2]\nB = os.path.join('src','a.ts')\nopen(B,'w').write('x')\nEOF`,
    `python3 - src/a.ts ${F}/x.json <<'EOF'\nimport sys\nA, B = sys.argv[1], sys.argv[2]\nB = A\nopen(B,'w')\nEOF`,
    `python3 - ${F}/a.md ${F}/b.ts <<'EOF'\nimport sys\nA,B=sys.argv[1],sys.argv[2]\nB='src/a.ts'\nopen(B,'w').write('x')\nEOF`,
  ];
  conEnv(SIN_REGISTRO, () => {
    for (const cmd of casos) {
      const b = bash.handle(ev(cmd), { stateDir, installedRoots: [] });
      assert.ok(b && INVISIBLE.test(b.block), `tiene que frenar: ${cmd}`);
    }
    // el falso positivo del pase (el nombre del destino aparece antes del cd, sin escribirse ahí): escribe sólo afuera
    assert.equal(bash.handle(ev(`SP=${F}; rm -f $SP/index.ts; cd $SP && echo x > index.ts`), { stateDir, installedRoots: [] }), null);
  });
});

test('T41 Freno_RevisoresVuelta2E_SigueFrenando @story-8.93 @ac-15 @ac-22', () => {
  // con la sesión parada fuera del repo de la ejecución (un worktree), un `cd` que no es un comando no aleja la
  // escritura, y una asignación compuesta, entre paréntesis, con tipo o en un bucle no deja resuelta una variable a medias
  const { stateDir, repo } = corridaAbierta();
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'x');
  const sesion = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sesion-')));
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: sesion, tool_input: { command } });
  conEnv(SIN_REGISTRO, () => {
    for (const cmd of [
      `cd ${repo} && echo "cd" > src/a.ts`,
      `cd ${repo} && cd src && sed -i 's/a/b/' a.ts`,
      `node -e "let p='${repo}/src/a'; p+='.ts'; require('fs').writeFileSync(p,'x')"`,
      `node -e "let p='/tmp/ok'; (p='${repo}/src/a.ts'); require('fs').writeFileSync(p,'x')"`,
      `python3 - <<'EOF'\np='/tmp/ok.md'\nfor p in ['${repo}/src/a.ts']:\n    open(p,'w').write('x')\nEOF`,
      `node - <<'EOF'\nlet p = '/tmp/ok.md'; [p] = ['${repo}/src/a.ts']; require('fs').writeFileSync(p, 'x')\nEOF`,
      // una escritura que no es código no fija la carpeta de las demás; y una asignación con tipo cuenta
      `cd ${repo} && echo 1 > a.txt; cd ${sesion}/x/y && echo 2 > ${path.relative(path.join(sesion, 'x', 'y'), path.join(repo, 'src', 'b.ts'))}`,
      `python3 -c "p='notes.md'; p: str = '${repo}/src/a.ts'; open(p,'w').write('x')"`,
      `node - <<'EOF'\nlet p = '/tmp/ok.md'; let q: string = ''; p = '${repo}/src/a.ts'; require('fs').writeFileSync(p, 'x')\nEOF`,
    ]) {
      const b = bash.handle(ev(cmd), { stateDir, installedRoots: [] });
      assert.ok(b && INVISIBLE.test(b.block), `tiene que frenar: ${cmd}`);
    }
  });
});

test('T41 Freno_CdQueNoEsLaFormaMinima_ResuelveComoHoy @story-8.93 @ac-15', () => {
  // un cd que no es `[VAR=literal; …] [… &&] cd DIR && <escritura>` resuelve con el cd del
  // principio (`leadingCd`: `cd X &&` o `cd X;` al inicio), o con la carpeta de la sesión; y un segundo cd antes de una
  // escritura relativa, con la de la sesión
  const repo = fs.realpathSync(mkRepo(false));
  const F = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fuera-')));
  for (const [cmd, esperado] of [
    [`cd ${F}; echo x > src/a.ts`, F],                  // el cd del principio, con ;
    [`cd ${F} && ls; echo x > src/a.ts`, F],            // el cd del principio, la escritura fuera de su cadena
    [`cd "${F}" && echo x > src/a.ts`, F],              // con comillas
    [`cd ${F} || echo x > src/a.ts`, repo],             // con ||: no es el cd del principio
    [`cd -P ${F} && echo x > src/a.ts`, repo],          // con opciones
    [`cd ${F} && cd ${F} && echo x > src/a.ts`, repo],  // un segundo cd antes de la escritura
    [`echo "x" ; cd ${F} && echo x > src/a.ts`, repo],  // el cd no está al principio y lo de antes no es simple
    [`A=$(pwd); cd ${F} && echo x > src/a.ts`, repo],
    [`true | true; cd ${F} && echo x > src/a.ts`, repo],
    [`echo x > src/a.ts`, repo],                        // sin cd
  ]) assert.equal(bash.cwdDelComando(cmd, repo), esperado, cmd);
});

test('T30 Freno_GestoresDePaquetes_Pasan', () => {
  const { stateDir, repo } = corridaAbierta();
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  conEnv(SIN_REGISTRO, () => {
    for (const cmd of ['npm install', 'npm ci', 'npm update lodash', 'pnpm add x', 'yarn add x', 'dotnet add package X', 'dotnet restore', 'npm install 2>&1 | tail -5']) {
      assert.equal(bash.handle(ev(cmd), { stateDir, installedRoots: [] }), null, cmd);
    }
  });
});

test('T31 Freno_InterpreteConDestinoArmado_Frena', () => {
  const { stateDir, repo } = corridaAbierta();
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  conEnv(SIN_REGISTRO, () => {
    for (const cmd of [
      `node -e "const fs=require('fs'); const p='src/a.ts'; fs.writeFileSync(p, 'x')"`,
      `node -e "const fs=require('fs'),path=require('path'); fs.writeFileSync(path.join('src','a.ts'), 'x')"`,
      `python3 -c "f='src/a.py'; open(f,'w').write('x')"`,
    ]) {
      const b = bash.handle(ev(cmd), { stateDir, installedRoots: [] });
      assert.ok(b && INVISIBLE.test(b.block), cmd);
    }
    assert.equal(bash.handle(ev(`node -e "require('fs').writeFileSync('/tmp/fuera-893.ts','x')"`), { stateDir, installedRoots: [] }), null, 'literal fuera del repo');
    // lo que se sabe sin ejecutar (medido con los comandos reales: los más comunes)
    for (const cmd of [
      `node -e "const f='/tmp/fuera-893/x.ts'; require('fs').writeFileSync(f,'x')"`,
      `node -e "const p = 'notas.md'; require('fs').writeFileSync(p, 'x')"`,
      `node -e "require('fs').writeFileSync(process.argv[1]+'/findings.json','[]')" .advisors/x`,
      `node -e 'const fs=require("fs"); const f=process.argv[1]; fs.writeFileSync(f, "x")' specs/story-9.9.md`,
      `node -e 'const fs=require("fs");const [s,m]=process.argv.slice(1); fs.writeFileSync(s, "x")' specs/story-9.9.md /tmp/lista.md`,
      `python3 -c "import sys; a, b = sys.argv[1:]; open(a,'w').write('x')" notas.md otra.md`,
    ]) assert.equal(bash.handle(ev(cmd), { stateDir, installedRoots: [] }), null, cmd);
    const porEntrada = `S=specs/story-9.9.md; python3 - "$S" <<'PY'\nimport sys\np=sys.argv[1]\nopen(p,'w').write('x')\nPY`;
    heredocConArgumentos(bash.handle(ev(porEntrada), { stateDir, installedRoots: [] }), porEntrada);
    assert.ok(INVISIBLE.test((bash.handle(ev(`node -e "require('fs').writeFileSync(d+'/a.ts','x')"`), { stateDir, installedRoots: [] }) || {}).block || ''), 'cola con extensión de código');
    assert.ok(INVISIBLE.test((bash.handle(ev(`node -e 'const f=process.argv[1]; require("fs").writeFileSync(f, "x")' src/a.ts`), { stateDir, installedRoots: [] }) || {}).block || ''), 'el argumento es código del repo');
    assert.ok(INVISIBLE.test((bash.handle(ev(`perl -e 'open(my $fh, ">", $ARGV[0]); print $fh "x"' src/a.ts`), { stateDir, installedRoots: [] }) || {}).block || ''), 'perl -e: el argumento es código');
    assert.ok(INVISIBLE.test((bash.handle(ev(`perl -e 'my $d = shift; open(my $fh, ">", "$d/a.ts")'`), { stateDir, installedRoots: [] }) || {}).block || ''), 'perl -e con destino armado');
    assert.ok(INVISIBLE.test((bash.handle(ev(`python3 -c "import sys; a, b = sys.argv[1:]; open(a,'w').write('x')" src/a.py otra.md`), { stateDir, installedRoots: [] }) || {}).block || ''), 'el primer argumento es código');
  });
  // el escape del dev deja pasar y deja su línea en gates.log
  conEnv({ ...SIN_REGISTRO, TYCON_LEDGER_VISIBLE: 'off' }, () => {
    assert.equal(bash.handle(ev(`node -e "const p=x; require('fs').writeFileSync(p,'1')"`), { stateDir, installedRoots: [] }), null);
  });
  const escapes = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((g) => g.status === 'escaped');
  assert.equal(escapes.length, 1);
  conEnv(SIN_REGISTRO, () => {
  });
  // con la corrida cerrada, el destino armado no frena: el carril no cambia
  const cerrada = corridaAbierta({ pendiente: [] });
  conEnv(SIN_REGISTRO, () => {
    const cmd = `node -e "const p='src/a.ts'; require('fs').writeFileSync(p,'x')"`;
    assert.equal(bash.handle({ tool_name: 'Bash', session_id: 's1', cwd: cerrada.repo, tool_input: { command: cmd } }, { stateDir: cerrada.stateDir, installedRoots: [] }), null);
  });
});

test('T32 Freno_BorrarYDeshacer', () => {
  const { stateDir, repo } = corridaAbierta();
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  conEnv({ ...SIN_REGISTRO, TYCON_NO_RUN_CHANGE: undefined }, () => {
    for (const cmd of ['rm package-lock.json', 'rm -f src/a.ts', 'git checkout -- package.json', 'git restore src/a.ts',
      'git rm src/a.ts', 'git restore --source HEAD~1 src/a.ts', 'rm -rf node_modules src/a.ts 2>/dev/null']) {
      const b = bash.handle(ev(cmd), { stateDir, installedRoots: [] });
      assert.ok(b && INVISIBLE.test(b.block) && /Edit|Write/.test(b.block), cmd);
    }
    assert.equal(bash.handle(ev('rm -rf node_modules'), { stateDir, installedRoots: [] }), null);
    assert.equal(bash.handle(ev('rm notas.md'), { stateDir, installedRoots: [] }), null, 'un .md no es código');
    assert.equal(bash.handle(ev('git restore --staged src/a.ts'), { stateDir, installedRoots: [] }), null, 'sólo el índice: el archivo no cambia');
    assert.equal(bash.handle(ev('git rm --cached src/a.ts'), { stateDir, installedRoots: [] }), null, 'sólo el índice');
    assert.equal(bash.handle(ev('git checkout feat/otra'), { stateDir, installedRoots: [] }), null, 'cambiar de rama no es deshacer un archivo');
    assert.equal(bash.handle(ev('rm /tmp/fuera-893.ts'), { stateDir, installedRoots: [] }), null, 'fuera del repo');
  });
  const lineas = fs.readFileSync(path.join(stateDir, 'console-writes', 's1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lineas.some((l) => l.path === path.join(repo, 'node_modules') && l.kind === 'delete'), JSON.stringify(lineas));
  // con la corrida cerrada, borrar código pasa como hoy
  const cerrada = corridaAbierta({ pendiente: [] });
  conEnv(SIN_REGISTRO, () => {
    assert.equal(bash.handle({ tool_name: 'Bash', session_id: 's1', cwd: cerrada.repo, tool_input: { command: 'rm src/a.ts' } }, { stateDir: cerrada.stateDir, installedRoots: [] }), null);
  });
});

test('T33 Freno_PowerShell_FormasNuevas', () => {
  const { stateDir, repo } = corridaAbierta();
  const ev = (command) => ({ tool_name: 'PowerShell', session_id: 's1', cwd: repo, tool_input: { command } });
  conEnv(SIN_REGISTRO, () => {
    for (const cmd of [
      'Remove-Item package-lock.json',
      'Remove-Item -Path src/a.ts -Force',
      'del package-lock.json',
      'ri src/a.ts',
      "pwsh -Command \"Set-Content $p 'x'\"",
      'git checkout -- package.json',
    ]) {
      const b = bash.handle(ev(cmd), { stateDir, installedRoots: [] });
      assert.ok(b && INVISIBLE.test(b.block), cmd);
    }
    // un parámetro con valor no es una ruta: sólo el archivo se anota
    assert.deepEqual(bash.destinosBorrados('Remove-Item -ErrorAction SilentlyContinue -Filter *.log out').map((d) => d.raw), ['out']);
  });
});
