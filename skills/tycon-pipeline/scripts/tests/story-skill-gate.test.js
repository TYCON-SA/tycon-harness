#!/usr/bin/env node
/**
 * story-skill-gate.test.js — freno de STORY A MANO: lógica pura (lib/story-skill-gate.js), capa I/O con
 * state dir + repo temporales (lib/story-skill-gate-io.js), la constancia (on-skill-invoke.js), la puerta
 * Bash (on-bash-write-gate.js) y el disparo end-to-end por el despachador (hook-pre-edit.js, spawn →
 * por eso vive en el throttle DIARIO del instalador y no en UNIT_TESTS).
 *
 * 🔴 El ROJO se prueba, no se supone: los casos "sin el fix no frena" son (a) el mismo evento por el
 * handler viejo del carril (on-story-gate.js) → pasa, y (b) el mismo evento por el despachador entero
 * con SÓLO este freno apagado → pasa. Si alguno de esos dos bloqueara, el bloqueo del caso verde no
 * sería atribuible a esta pieza (la lección del gate de ATDD, que nació ciego y dio verde 15 corridas).
 *
 * Correr: node --test ~/.claude/agent-skills/skills/tycon-pipeline/scripts/tests/story-skill-gate.test.js
 */

// Story 7.2 del arnés: estas pruebas llaman a los hooks del cierre con el HOME real (y el instalador las corre en
// cada arranque). Sin esto, sus decisiones de mentira se anotarían en ~/.claude/.tycon-pipeline/frenos.jsonl, que
// sube al buzón y alimenta la métrica «evidencias rechazadas por los hooks del cierre» del tablero.
process.env.TYCON_CLOSURE_RECORD = 'off';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Story 7.16 del arnés: HOME temporal para TODO el proceso, devuelta en `test.after`. Va ANTES de los `require`
// de abajo: story-discovery.js fija la ruta de su caché (story-dirs-cache.json) con os.homedir() al cargarse, y
// con la HOME real la dejaba en la del dev. El arnés y agent-skills se fijan con lo que resolvían con la HOME
// real, si no venían puestos (lo mismo que scripts/tests/lib/fake-home.sh del arnés para las suites bash).
const REAL_HOME = os.homedir();
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ssg-home-'));
const PREV_ENV = { HOME: process.env.HOME, TYCON_SKILLS_DIR: process.env.TYCON_SKILLS_DIR, TYCON_GUIDES_DIR: process.env.TYCON_GUIDES_DIR };
const REAL_SKILLS = path.join(REAL_HOME, '.claude', 'agent-skills', 'skills');
// el arnés de la máquina por su lugar y, si no, por el nombre viejo (story 8.19): los dos nombres, escritos (copia declarada)
const REAL_GUIDES = [path.join(REAL_HOME, '.claude', 'tycon-harness'), path.join(REAL_HOME, '.claude', 'tycon-claude-guides')].find((p) => fs.existsSync(p)) || '';
if (!process.env.TYCON_SKILLS_DIR && fs.existsSync(REAL_SKILLS)) process.env.TYCON_SKILLS_DIR = REAL_SKILLS;
if (!process.env.TYCON_GUIDES_DIR && REAL_GUIDES) process.env.TYCON_GUIDES_DIR = REAL_GUIDES;
process.env.HOME = FAKE_HOME;
test.after(() => {
  for (const [k, v] of Object.entries(PREV_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

const SCRIPTS = path.join(__dirname, '..');
const gate = require(path.join(SCRIPTS, 'lib', 'story-skill-gate.js'));
const sio = require(path.join(SCRIPTS, 'lib', 'story-skill-gate-io.js'));
const invoke = require(path.join(SCRIPTS, 'on-skill-invoke.js'));
const handler = require(path.join(SCRIPTS, 'on-story-skill-gate.js'));
const laneHandler = require(path.join(SCRIPTS, 'on-story-gate.js'));
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));

const TOTORA_PATTERN = "stories:\n  id_pattern: '^(?:[A-Z]{1,4}-)?\\d+(?:[.-]\\d+)*$'\n";
const AS1 = '---\nstory: "AS-1"\nepic: "pedidos"\nstatus: ready-for-dev\ntitle: "Pedidos del día"\n---\n# Story AS-1\n';
const S99 = '---\nstory: "9.9"\nepic: "9"\nstatus: backlog\n---\n# Story 9.9\n';
const PRD = '---\nstatus: draft\ntitle: "PRD"\n---\n# PRD\n';

function mkRepo({ tycon = true, yaml = null } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'ssg-repo-'));
  fs.mkdirSync(path.join(r, '.git'));
  fs.mkdirSync(path.join(r, 'specs'));
  if (tycon) fs.mkdirSync(path.join(r, '.tycon'));
  if (yaml) fs.writeFileSync(path.join(r, '.tycon', 'advisors.yaml'), yaml);
  return r;
}
function mkState() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ssg-state-')); }
function mark(stateDir, sid, obj) { sio.writeMark(stateDir, sid, { skill: 'tycon-create-story', at: new Date().toISOString(), ...obj }); }
function gatesLog(stateDir) { try { return fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8'); } catch { return ''; } }
const NOW = Date.now();
const TTL = gate.ttlMsFrom(undefined);

// ── lógica pura ──────────────────────────────────────────────────────────────────────────────────
test('computeStorySkillGate: tabla de verdad', () => {
  const base = { filePath: '/r/specs/story-x.md', existsOnDisk: false, isStoryCandidate: true, isHarness: false, repoUnderHarness: true, idIsWork: true, mark: null, nowMs: NOW, ttlMs: TTL };
  const v = (o) => gate.computeStorySkillGate({ ...base, ...o });
  assert.equal(v({}).action, 'block'); assert.equal(v({}).kind, 'no-skill');
  assert.equal(v({ isStoryCandidate: false }).kind, 'not-story');
  assert.equal(v({ existsOnDisk: true }).kind, 'exists');
  assert.equal(v({ isHarness: true }).kind, 'harness');
  assert.equal(v({ gateEnabled: false }).kind, 'repo-off');
  assert.equal(v({ repoUnderHarness: false }).kind, 'unknown-no-harness');
  assert.equal(v({ idIsWork: false }).kind, 'unknown-material');
  assert.equal(v({ isCodex: true }).kind, 'unknown-codex');
  // bajo Codex una marca/bypass vigente igual se reconoce (queda auditado como bypass, no como unknown)
  assert.equal(v({ isCodex: true, mark: { skill: 'bypass', reason: 'r', at: new Date(NOW).toISOString() } }).kind, 'bypass');
  assert.equal(v({ mark: { skill: 'tycon-create-story', at: new Date(NOW - 60e3).toISOString() } }).kind, 'mark');
  assert.equal(v({ mark: { skill: 'bypass', reason: 'el dev lo pidió', at: new Date(NOW).toISOString() } }).kind, 'bypass');
  const exp = v({ mark: { skill: 'tycon-create-story', at: new Date(NOW - TTL - 1).toISOString() } });
  assert.equal(exp.action, 'block'); assert.equal(exp.kind, 'mark-expired');
  // idIsWork null (no se pudo leer el id) NO abre el portón: se asume trabajo.
  assert.equal(v({ idIsWork: null }).action, 'block');
  // una marca corrupta no es salvoconducto
  assert.equal(v({ mark: { skill: 'tycon-create-story' } }).action, 'block');
});

test('isCreatorSkill / ttlMsFrom / markState', () => {
  assert.equal(gate.isCreatorSkill('tycon-create-story'), true);
  assert.equal(gate.isCreatorSkill('bmad-create-epics-and-stories'), true);
  assert.equal(gate.isCreatorSkill('tycon-pipeline'), false);
  assert.equal(gate.isCreatorSkill(''), false);

  // 🔴 Nombres CALIFICADOS por directorio (2026-09-21). Cuando un repo tiene skills en
  // `<repo>/.claude/skills/`, Claude Code expone variantes `<dir>:<skill>` y su propio
  // system-reminder RECOMIENDA usarlas cuando los archivos están bajo ese subdirectorio.
  // Antes de este caso, la comparación exacta no las reconocía: el skill corría, la marca no
  // se escribía, y el portón seguía cerrado sin decir por qué. Caso real: OC-2a en
  // PacaraBackend — se invocó `PacaraBackend:tycon-create-story` y hubo que repetir
  // todo con el nombre pelado.
  assert.equal(gate.isCreatorSkill('PacaraBackend:tycon-create-story'), true);
  assert.equal(gate.isCreatorSkill('Backend:bmad-correct-course'), true);
  assert.equal(gate.isCreatorSkill('apps/web:gds-create-story'), true);
  assert.equal(gate.isCreatorSkill('  PacaraBackend:tycon-create-story  '), true);
  // …y lo que NO es creator sigue sin serlo aunque venga calificado.
  assert.equal(gate.isCreatorSkill('PacaraBackend:tycon-pipeline'), false);
  assert.equal(gate.isCreatorSkill('tycon-create-story:algo-mas'), false);
  assert.equal(gate.isCreatorSkill('algo:'), false);
  assert.equal(gate.ttlMsFrom(undefined), 120 * 60e3);
  assert.equal(gate.ttlMsFrom('30'), 30 * 60e3);
  assert.equal(gate.ttlMsFrom('basura'), 120 * 60e3);
  assert.equal(gate.markState(null, NOW, TTL), 'none');
  assert.equal(gate.markState({ at: 'x' }, NOW, TTL), 'none');
  assert.equal(gate.markState({ at: new Date(NOW - 1000).toISOString() }, NOW, TTL), 'valid');
  assert.equal(gate.markState({ at: new Date(NOW - TTL - 1000).toISOString() }, NOW, TTL), 'expired');
});

test('blockMessage: nombra el archivo, el skill y las dos salidas', () => {
  const m = gate.blockMessage({ kind: 'no-skill' }, { filePath: '/r/specs/story-as1.md', via: 'Write', ttlMs: TTL });
  assert.match(m, /story-as1\.md/); assert.match(m, /tycon-create-story/); assert.match(m, /story-skill-bypass/); assert.match(m, /TYCON_STORY_SKILL_GATE/);
  assert.match(gate.blockMessage({ kind: 'mark-expired' }, { filePath: '/r/x.md', ttlMs: TTL }), /VENCIÓ/);
});

// ── capa I/O (evaluate) ──────────────────────────────────────────────────────────────────────────
test('evaluate: story NUEVA con id del repo (caso real AS-1) sin marca → block + gates.log', () => {
  const repo = mkRepo({ yaml: TOTORA_PATTERN }); const st = mkState();
  const r = sio.evaluate({ absPath: path.join(repo, 'specs', 'story-as1-pedidos.md'), content: AS1, sessionId: 's1', via: 'Write', stateDir: st });
  assert.equal(r.verdict.action, 'block'); assert.equal(r.verdict.kind, 'no-skill'); assert.match(r.message, /DENEGADA/);
  assert.match(gatesLog(st), /"name":"story-skill-gate".*"status":"blocked"/);
  assert.match(gatesLog(st), /"storyId":"AS-1"/);
});

test('evaluate: story numérica nueva sin yaml → block (patrón por default)', () => {
  const repo = mkRepo(); const st = mkState();
  assert.equal(sio.evaluate({ absPath: path.join(repo, 'specs', '9-9.md'), content: S99, sessionId: 's1', stateDir: st }).verdict.action, 'block');
});

test('evaluate: EDITAR una story existente pasa siempre (el falso positivo que mataría el control)', () => {
  const repo = mkRepo(); const st = mkState();
  const p = path.join(repo, 'specs', '9-9.md'); fs.writeFileSync(p, S99);
  const r = sio.evaluate({ absPath: p, content: S99.replace('backlog', 'done'), sessionId: 's1', stateDir: st });
  assert.equal(r.verdict.action, 'pass'); assert.equal(r.verdict.kind, 'exists');
  assert.equal(gatesLog(st), '');
});

test('evaluate: con constancia del skill pasa; vencida bloquea; bypass pasa y queda en bypass.log', () => {
  const repo = mkRepo(); const st = mkState();
  const abs = path.join(repo, 'specs', '9-9.md');
  mark(st, 's1', {});
  assert.equal(sio.evaluate({ absPath: abs, content: S99, sessionId: 's1', stateDir: st }).verdict.kind, 'mark');
  // otra sesión NO hereda la marca
  assert.equal(sio.evaluate({ absPath: abs, content: S99, sessionId: 's2', stateDir: st }).verdict.action, 'block');
  mark(st, 's1', { at: new Date(Date.now() - TTL - 5000).toISOString() });
  assert.equal(sio.evaluate({ absPath: abs, content: S99, sessionId: 's1', stateDir: st }).verdict.kind, 'mark-expired');
  mark(st, 's1', { skill: 'bypass', reason: 'el dev pidió a mano' });
  assert.equal(sio.evaluate({ absPath: abs, content: S99, sessionId: 's1', stateDir: st }).verdict.kind, 'bypass');
  assert.match(fs.readFileSync(path.join(st, 'bypass.log'), 'utf8'), /STORY_SKILL_BYPASS_USED/);
});

test('evaluate: .md que NO declara story (PRD) pasa sin log; .txt ni se mira', () => {
  const repo = mkRepo(); const st = mkState();
  assert.equal(sio.evaluate({ absPath: path.join(repo, 'specs', 'prd.md'), content: PRD, sessionId: 's1', stateDir: st }).verdict.kind, 'not-story');
  assert.equal(sio.evaluate({ absPath: path.join(repo, 'specs', 'story.txt'), content: S99, sessionId: 's1', stateDir: st }).verdict.kind, 'not-story');
  assert.equal(gatesLog(st), '');
});

test('evaluate: repo fuera del arnés y material tipo evals pasan y quedan MEDIDOS (unknown)', () => {
  const st = mkState();
  const suelto = mkRepo({ tycon: false });
  const r1 = sio.evaluate({ absPath: path.join(suelto, 'specs', '9-9.md'), content: S99, sessionId: 's1', stateDir: st });
  assert.equal(r1.verdict.action, 'pass'); assert.equal(r1.verdict.kind, 'unknown-no-harness');
  const repo = mkRepo();
  const r2 = sio.evaluate({ absPath: path.join(repo, 'specs', 'ev1.md'), content: S99.replace('"9.9"', '"EV-1"'), sessionId: 's1', stateDir: st });
  assert.equal(r2.verdict.kind, 'unknown-material');
  const log = gatesLog(st);
  assert.equal((log.match(/"status":"unknown"/g) || []).length, 2);
});

test('evaluate: repo del harness y ~/.claude pasan; config commiteada del repo apaga (kill-switch por repo)', () => {
  const st = mkState();
  assert.equal(sio.evaluate({ absPath: '/x/tycon-claude-guides/casos/story-1.md', content: S99, sessionId: 's1', stateDir: st }).verdict.kind, 'harness');
  // gemelo con el nombre público (story 8.19, tanda E, AC 39). El
  // criterio es el del arnés INSTALADO en la máquina: si es anterior a la 8.19 A no conoce el nombre público, y se dice.
  // El nombre, de place.js del repo único (nunca escrito a mano).
  const pub = (() => { try { return require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'setup', 'harness', 'place.js')).PLACE_NAME; } catch (_) { return null; } })();
  const knowsPublic = !!pub && (() => { try { const r = require(path.join(SCRIPTS, 'lib', 'harness-path.js')).rutaArnesHook(); return !!r.dir && require(path.join(r.dir, 'scripts', 'lib', 'harness-repo.js')).SEGMENTOS_DEL_ARNES.includes(pub); } catch (_) { return false; } })();
  if (knowsPublic) assert.equal(sio.evaluate({ absPath: `/x/${pub}/casos/story-1.md`, content: S99, sessionId: 's1', stateDir: st }).verdict.kind, 'harness');
  else console.log('⏭ gemelo con el nombre público: NO MEDIDO — el arnés instalado en esta máquina es anterior a la story 8.19 A');
  assert.equal(sio.evaluate({ absPath: path.join(os.homedir(), '.claude', 'x', 'story-1.md'), content: S99, sessionId: 's1', stateDir: st }).verdict.kind, 'harness');
  // kill-switch por repo: sólo lo COMMITEADO cuenta
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ssg-git-'));
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, '.tycon')); fs.mkdirSync(path.join(repo, 'specs'));
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), 'pipeline:\n  story_skill_gate: false\n');
  assert.equal(sio.evaluate({ absPath: path.join(repo, 'specs', '9-9.md'), content: S99, sessionId: 's1', stateDir: st }).verdict.action, 'block', 'sin commit sigue frenando');
  git('add', '.'); git('commit', '-qm', 'off');
  assert.equal(sio.evaluate({ absPath: path.join(repo, 'specs', '9-9.md'), content: S99, sessionId: 's1', stateDir: st }).verdict.kind, 'repo-off');
});

test('evaluate: bajo Codex (turn_id en el payload) no frena y queda unknown', () => {
  const repo = mkRepo(); const st = mkState();
  const r = sio.evaluate({ absPath: path.join(repo, 'specs', '9-9.md'), content: S99, sessionId: 's1', stateDir: st, event: { turn_id: 'turn-1', model: 'x' } });
  assert.equal(r.verdict.kind, 'unknown-codex');
  assert.match(gatesLog(st), /unknown-codex/);
});

// ── la constancia (on-skill-invoke) ──────────────────────────────────────────────────────────────
test('on-skill-invoke: tycon-create-story deja la marca; otro skill no; las viejas se purgan', () => {
  const st = mkState();
  assert.equal(invoke.handle({ tool_name: 'Skill', tool_input: { skill: 'tycon-pipeline' }, session_id: 's1' }, { stateDir: st }), null);
  assert.equal(fs.existsSync(sio.markPath(st, 's1')), false);
  const m = invoke.handle({ tool_name: 'Skill', tool_input: { skill: 'tycon-create-story', args: '4.2' }, session_id: 's1', cwd: '/w' }, { stateDir: st });
  assert.equal(m.skill, 'tycon-create-story');
  assert.equal(sio.readMark(st, 's1').skill, 'tycon-create-story');
  // marca vieja de otra sesión → se purga al escribir una nueva
  fs.writeFileSync(sio.markPath(st, 'vieja'), JSON.stringify({ skill: 'tycon-create-story', at: new Date(Date.now() - 48 * 3600e3).toISOString() }));
  invoke.handle({ tool_name: 'Skill', tool_input: { skill: 'gds-create-story' }, session_id: 's3' }, { stateDir: st });
  assert.equal(fs.existsSync(sio.markPath(st, 'vieja')), false);
  assert.equal(fs.existsSync(sio.markPath(st, 's1')), true);
  // otra tool → no es asunto de este hook
  assert.equal(invoke.handle({ tool_name: 'Bash', tool_input: { skill: 'tycon-create-story' } }, { stateDir: st }), null);
});

// ── handler Edit|Write + el ROJO ─────────────────────────────────────────────────────────────────
test('on-story-skill-gate.handle: Write nuevo bloquea; el handler viejo del carril NO lo frena (rojo previo)', () => {
  const repo = mkRepo({ yaml: TOTORA_PATTERN }); const st = mkState();
  const ev = { tool_name: 'Write', session_id: 's1', cwd: repo, tool_input: { file_path: path.join(repo, 'specs', 'story-as1.md'), content: AS1 } };
  const r = handler.handle(ev, { stateDir: st });
  assert.ok(r && r.block, 'tiene que bloquear');
  assert.equal(laneHandler.handle(ev, { stateDir: st }), null, 'ROJO: el portón de carril solo NO frena una story a mano (por eso hizo falta esta pieza)');
  // Edit sobre la existente → pasa
  fs.writeFileSync(ev.tool_input.file_path, AS1);
  assert.equal(handler.handle({ ...ev, tool_name: 'Edit', tool_input: { file_path: ev.tool_input.file_path, old_string: 'a', new_string: 'b' } }, { stateDir: st }), null);
});

test('on-story-skill-gate.handle: kill-switch por env apaga', () => {
  const repo = mkRepo(); const st = mkState();
  const ev = { tool_name: 'Write', session_id: 's1', tool_input: { file_path: path.join(repo, 'specs', '9-9.md'), content: S99 } };
  const prev = process.env.TYCON_STORY_SKILL_GATE;
  process.env.TYCON_STORY_SKILL_GATE = 'off';
  try { assert.equal(handler.handle(ev, { stateDir: st }), null); } finally { if (prev === undefined) delete process.env.TYCON_STORY_SKILL_GATE; else process.env.TYCON_STORY_SKILL_GATE = prev; }
  assert.ok(handler.handle(ev, { stateDir: st }).block);
});

// ── la puerta Bash ───────────────────────────────────────────────────────────────────────────────
test('on-bash-write-gate: el heredoc REAL de AS-1 bloquea; >> a la existente pasa; con marca pasa', () => {
  const repo = mkRepo({ yaml: TOTORA_PATTERN }); const st = mkState();
  const cmd = `cat > specs/story-as1-pedidos-del-dia.md <<'STORYEOF'\n${AS1}STORYEOF`;
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  const r = bash.handle(ev(cmd), { stateDir: st });
  assert.ok(r && r.block, 'el caso real tiene que frenar'); assert.match(r.block, /STORY A MANO/);
  fs.writeFileSync(path.join(repo, 'specs', 'story-as1-pedidos-del-dia.md'), AS1);
  assert.equal(bash.handle(ev(cmd.replace('cat >', 'cat >>')), { stateDir: st }), null, 'append a la existente no es crear');
  fs.unlinkSync(path.join(repo, 'specs', 'story-as1-pedidos-del-dia.md'));
  mark(st, 's1', {});
  assert.equal(bash.handle(ev(cmd), { stateDir: st }), null, 'con constancia pasa');
});

test('on-bash-write-gate: printf inline con \\n bloquea; cp a story-*.md (sin contenido) bloquea por nombre; README no', () => {
  const repo = mkRepo(); const st = mkState();
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  assert.ok(bash.handle(ev(`printf '---\\nstory: "9.9"\\nepic: "9"\\nstatus: backlog\\n---\\n# S\\n' > specs/9-9.md`), { stateDir: st }).block);
  // la plantilla NO es una story (sin frontmatter): copiarla a un nombre de story frena por nombre.
  // (Copiar una story EXISTENTE es otro caso — F3 — y pasa como rename/duplicado.)
  fs.writeFileSync(path.join(repo, 'specs', 'plantilla.md'), '# Plantilla de story\n\n<!-- completar -->\n');
  assert.ok(bash.handle(ev('cp specs/plantilla.md specs/story-nueva.md'), { stateDir: st }).block, 'cp a nombre de story frena por nombre');
  assert.equal(bash.handle(ev('cp specs/plantilla.md specs/notas.md'), { stateDir: st }), null, 'cp a un nombre cualquiera no');
  assert.equal(bash.handle(ev('echo hola > README.md'), { stateDir: st }), null);
  assert.equal(bash.handle(ev('git commit -m "docs: story-1.md creada"'), { stateDir: st }), null, 'un path mencionado en un string no es un target');
});

test('on-bash-write-gate: TYCON_STORY_SKILL_GATE=off apaga sólo esta puerta (el carril sigue)', () => {
  const repo = mkRepo(); const st = mkState();
  const prev = process.env.TYCON_STORY_SKILL_GATE;
  process.env.TYCON_STORY_SKILL_GATE = 'off';
  try {
    assert.equal(bash.handle({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command: `cat > specs/9-9.md <<'EOF'\n${S99}EOF` } }, { stateDir: st }), null);
    const lane = bash.handle({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command: "cat > src/Foo.cs <<'EOF'\nclass Foo {}\nEOF" } }, { stateDir: st });
    assert.ok(lane && lane.block, 'el carril sigue frenando código');
  } finally { if (prev === undefined) delete process.env.TYCON_STORY_SKILL_GATE; else process.env.TYCON_STORY_SKILL_GATE = prev; }
});

test('on-bash-write-gate (F2): el heredoc de una story EXISTENTE no contagia a otro .md nuevo del mismo comando', () => {
  const repo = mkRepo(); const st = mkState();
  fs.writeFileSync(path.join(repo, 'specs', '9-9.md'), S99);
  const cmd = `cat > specs/9-9.md <<'EOF'\n${S99}EOF\necho notas > docs-notas.md`;
  assert.equal(bash.handle({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command: cmd } }, { stateDir: st }), null);
  // y el cuerpo SÍ se atribuye a su propio target cuando ese target es nuevo
  const cmd2 = `echo notas > docs-notas.md\ncat > specs/9-8.md <<'EOF'\n${S99.replace('9.9', '9.8')}EOF`;
  assert.ok(bash.handle({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command: cmd2 } }, { stateDir: st }).block);
  const hd = bash.heredocs(`cat <<'EOF' > a.md\nx\nEOF`);
  assert.equal(hd[0].target, 'a.md');
});

test('on-bash-write-gate (F3): mv/cp desde una story existente pasa (unknown-rename); un índice frena por nombre con el mensaje correcto', () => {
  const repo = mkRepo(); const st = mkState();
  fs.writeFileSync(path.join(repo, 'specs', 'story-a.md'), S99);
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  assert.equal(bash.handle(ev('mv specs/story-a.md specs/story-a-renamed.md'), { stateDir: st }), null);
  assert.match(gatesLog(st), /unknown-rename/);
  fs.mkdirSync(path.join(repo, 'specs', 'stories'));
  const r = bash.handle(ev('echo "# índice" > specs/stories/INDEX.md'), { stateDir: st });
  assert.ok(r && r.block); assert.match(r.block, /por el NOMBRE parece/); assert.match(gatesLog(st), /no-skill-by-name/);
});

test('on-bash-write-gate (F4): node -e con template literal se ve', () => {
  const repo = mkRepo(); const st = mkState();
  const cmd = 'node -e "require(\'fs\').writeFileSync(\'specs/as1.md\', `---\\nstory: \\"9.9\\"\\nstatus: x\\n---\\n# S\\n`)"';
  assert.ok(bash.handle({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command: cmd } }, { stateDir: st }).block);
});

test('on-prompt (F1): el slash del user deja la marca con via slash; otro slash no', () => {
  const home = mkState();
  const run = (prompt) => spawnSync(process.execPath, [path.join(SCRIPTS, 'on-prompt.js')], { input: JSON.stringify({ session_id: 'sl1', prompt }), encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0' } });
  run('/tycon-pipeline specs/x.md');
  const st = path.join(home, '.claude', '.tycon-pipeline');
  assert.equal(fs.existsSync(sio.markPath(st, 'sl1')), false);
  run('/tycon-create-story 4.2');
  const m = sio.readMark(st, 'sl1');
  assert.equal(m && m.skill, 'tycon-create-story'); assert.equal(m.via, 'slash');
  assert.match(gatesLog(st), /mark-written.*"via":"slash"/);
});

test('writeMark deja constancia auditable (mark-written) en gates.log', () => {
  const st = mkState();
  sio.writeMark(st, 's1', { skill: 'tycon-create-story', at: new Date().toISOString(), via: 'hook' });
  assert.match(gatesLog(st), /"status":"mark-written".*"via":"hook"/);
});

// ── disparo end-to-end por el despachador (spawn) ────────────────────────────────────────────────
test('hook-pre-edit.js e2e: bloquea (exit 2) y con SÓLO este freno apagado el mismo Write pasa (exit 0)', () => {
  const repo = mkRepo({ yaml: TOTORA_PATTERN }); const home = mkState();
  const ev = { session_id: 'e2e', tool_name: 'Write', cwd: repo, tool_input: { file_path: path.join(repo, 'specs', 'story-as1.md'), content: AS1 } };
  const run = (extra) => spawnSync(process.execPath, [path.join(SCRIPTS, 'hook-pre-edit.js')], {
    input: JSON.stringify(ev), encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', ...extra },
  });
  const r1 = run({});
  assert.equal(r1.status, 2, `esperaba exit 2 · stderr: ${r1.stderr.slice(0, 200)}`);
  assert.match(r1.stderr, /STORY A MANO/);
  const r2 = run({ TYCON_STORY_SKILL_GATE: 'off' });
  assert.equal(r2.status, 0, `ROJO atribuible: sin este freno el despachador deja pasar · stderr: ${r2.stderr.slice(0, 200)}`);
});

// ── T12 (story 7.16 del arnés): la caché de carpetas de stories va a la HOME temporal ───────────────
// Evidencia POSITIVA (la real no sirve de control: las sesiones del dev la escriben al mismo tiempo). Rojo
// previo: con la HOME real, story-discovery.js fija CACHE_PATH al cargarse y la caché queda en la del dev.
test('T12 StorySkillGate_NoRealHome — story-dirs-cache.json quedó en la HOME temporal', () => {
  const cache = path.join(FAKE_HOME, '.claude', '.tycon-pipeline', 'story-dirs-cache.json');
  assert.ok(fs.existsSync(cache), `la caché de carpetas de stories no está en la HOME temporal (${cache}): fue a la real`);
});
