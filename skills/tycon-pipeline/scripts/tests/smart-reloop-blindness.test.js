#!/usr/bin/env node
/**
 * smart-reloop-blindness.test.js — el re-loop deja de devolver un delta "chico" cuando en realidad
 * está ciego, y los probes del pase adversarial no contaminan la foto de la iteración.
 *
 * Caso: las tres
 * fuentes del delta salen todas de `marker.filesTouched`, que escribe on-edit.js desde el hook
 * PostToolUse matcher `Edit|Write`. Incluso el fallback por mtime ITERA sobre filesTouched, así que
 * cubre "archivo que el hook ya vio y se re-editó por fuera", NO "archivo que el hook no vio
 * nunca". Si el registro tiene sólo entradas de scratchpad del 5b: cero
 * ediciones del repo, delta chico, y nadie avisa. El archivo tiene ruido, así que cuesta verlo.
 *
 * Correr: node --test .../scripts/tests/smart-reloop-blindness.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

// Un repo sin `packs:` activa los paquetes que diga `packs.default` (afuera, sin perfil: ninguno).
// Esta suite corre el pipeline con una HOME aislada y cuenta con «todos los instalados».
process.env.TYCON_PACKS_DEFAULT = (process.env.TYCON_PACKS_DEFAULT || '').trim() || 'all';   // recortada, como el cargador
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const SID = 'test-blindness';

/** Repo git real con un commit base — hace falta git de verdad: es la fuente que no miente. */
function mkRepoGit() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-repo-'));
  const git = (...a) => execFileSync('git', ['-C', r, ...a], { stdio: 'ignore' });
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.mkdirSync(path.join(r, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src', 'PluginManager.cs'), '// base\n');
  fs.writeFileSync(path.join(r, 'story.md'),
    ['---', 'story: 9.3.1', 'epic: 9', 'status: in-progress', '---', '', '## Acceptance Criteria', '- AC1: x', ''].join('\n'));
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '.'); git('commit', '-qm', 'base');
  return r;
}

/** HOME temporal con un marker de esta "sesión" ya fotografiado en iter 1. */
function mkHome(marker) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-home-'));
  const dir = path.join(h, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify(marker, null, 2));
  return h;
}

function reloop(repo, home, archivo = 'src/PluginManager.cs') {
  const r = spawnSync(process.execPath,
    [PIPELINE, 'smart-reloop', '--iter', '2', '--repo', repo, '--story', path.join(repo, 'story.md'),
      '--files', archivo],
    { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: SID } });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// ── El caso real ─────────────────────────────────────────────────────────────

test('registro con SOLO scratchpad + git ve cambios reales → set completo ANUNCIADO', () => {
  const repo = mkRepoGit();
  const home = mkHome({
    storyId: '9.3.1', repoPath: repo,
    filesTouched: ['/tmp/scratch/Det.cs', '/tmp/scratch/probe931/Program.cs'],
    fileEvents: [{ path: '/tmp/scratch/Det.cs', ts: new Date(Date.now() - 1000).toISOString() }],
    iterations: { 1: { ts: new Date(Date.now() - 60000).toISOString(), filesSnapshot: [] } },
  });
  // El trabajo REAL del repo: editado por fuera del hook (como lo haría un sed/heredoc).
  fs.writeFileSync(path.join(repo, 'src', 'PluginManager.cs'), '// arreglado\n');

  const out = reloop(repo, home);
  assert.equal(out.ledger_blind, true, 'un registro con 2 entradas de scratchpad NO es un registro sano');
  assert.equal(out.mode, 'force-full-reloop', 'ciego → set COMPLETO, no un delta que no midió nada');
  assert.match(out.ledger_blind_reason, /CIEGO/);
  assert.match(out.ledger_blind_reason, /Edit\/Write/, 'tiene que nombrar la causa');
  assert.ok(out.git_sees.some((f) => f.endsWith('PluginManager.cs')), 'y mostrar lo que git SÍ vio');
  assert.deepEqual(out.rerun, out.all, 'el set completo es el set completo');
});

test('registro sano → sigue habiendo delta chico (el ahorro del re-loop no se pierde)', () => {
  const repo = mkRepoGit();
  const real = path.join(repo, 'src', 'PluginManager.cs');
  const home = mkHome({
    storyId: '9.3.1', repoPath: repo,
    filesTouched: [real],
    fileEvents: [{ path: real, ts: new Date().toISOString() }],
    iterations: { 1: { ts: new Date(Date.now() - 60000).toISOString(), filesSnapshot: [real] } },
  });
  fs.writeFileSync(real, '// arreglado\n');
  const out = reloop(repo, home);
  assert.notEqual(out.ledger_blind, true, 'con una edición real registrada, el registro mide');
  assert.equal(out.mode, 'smart-reloop');
});

test('el diagnóstico queda escrito en gates.log (la retro lo lee sin reporte a mano)', () => {
  const repo = mkRepoGit();
  const home = mkHome({
    storyId: '9.3.1', repoPath: repo,
    filesTouched: ['/tmp/scratch/x.md'],
    iterations: { 1: { ts: new Date(Date.now() - 60000).toISOString(), filesSnapshot: [] } },
  });
  fs.writeFileSync(path.join(repo, 'src', 'PluginManager.cs'), '// arreglado\n');
  reloop(repo, home);
  const log = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8');
  const entry = log.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.check === 'ledger-honesty');
  assert.ok(entry, 'sin constancia, el diagnóstico se pierde con la corrida');
  assert.equal(entry.status, 'blind');
  assert.equal(entry.registroFiles, 0);
  assert.ok(entry.gitFiles >= 1);
});

// ── La foto de la iteración no se ensucia con probes ─────────────────────────

test('snapshot-iter deja los probes del pase adversarial FUERA de la foto', () => {
  const repo = mkRepoGit();
  const home = mkHome({
    storyId: 'M-10', repoPath: repo,
    filesTouched: [
      path.join(repo, 'src', 'contacto.ts'),
      path.join(repo, 'tests', '__probe_determinism.test.ts'),
      path.join(repo, 'tests', '__adversarial_probe.test.ts'),
      path.join(repo, 'tests', '_probe_m10.test.ts'),
    ],
    iterations: {},
  });
  const r = spawnSync(process.execPath, [MARKER, 'snapshot-iter', '1'],
    { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: SID } });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.snapshot_size, 1, 'sólo el archivo real entra a la foto');
  assert.equal(out.probes_excluidos, 3, 'y se dice cuántos quedaron afuera, no se descartan en silencio');

  const m = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'active', `${SID}.json`), 'utf8'));
  assert.ok(m.iterations['1'].filesSnapshot[0].endsWith('contacto.ts'));
});

test('snapshot-iter sin probes no reporta exclusiones (nada de ruido cuando no pasó nada)', () => {
  const repo = mkRepoGit();
  const home = mkHome({
    storyId: 'M-10', repoPath: repo,
    filesTouched: [path.join(repo, 'src', 'contacto.ts')],
    iterations: {},
  });
  const r = spawnSync(process.execPath, [MARKER, 'snapshot-iter', '1'],
    { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: SID } });
  const out = JSON.parse(r.stdout);
  assert.equal(out.snapshot_size, 1);
  assert.equal(out.probes_excluidos, undefined);
});

// ── La 4ta fuente (git) — el caso que NINGUNA de las otras tres puede ver ────
// Las otras tres iteran sobre `filesTouched`. Si el registro tiene UNA edición real, el
// diagnóstico de ceguera no dispara (y está bien: el registro mide algo) — pero un SEGUNDO archivo
// editado por fuera del hook seguiría invisible sin esta fuente. Sin este test se podría borrar la
// 4ta fuente entera y las suites quedarían verdes.

test('git ve un archivo que el registro NUNCA vio → entra al delta igual', () => {
  const repo = mkRepoGit();
  const conocido = path.join(repo, 'src', 'PluginManager.cs');
  const invisible = path.join(repo, 'src', 'EndpointRegistrar.cs');
  const home = mkHome({
    storyId: '9.3.1', repoPath: repo,
    filesTouched: [conocido],                       // el registro sólo conoce UNO
    fileEvents: [{ path: conocido, ts: new Date().toISOString() }],
    iterations: { 1: { ts: new Date(Date.now() - 60000).toISOString(), filesSnapshot: [conocido] } },
  });
  fs.writeFileSync(conocido, '// fix 1\n');
  fs.writeFileSync(invisible, '// fix 2 hecho por Bash — el hook Edit|Write nunca lo vio\n');

  const out = reloop(repo, home);
  assert.notEqual(out.ledger_blind, true, 'con una edición registrada el registro no está ciego');
  assert.ok(out.delta_files.some((f) => f.endsWith('EndpointRegistrar.cs')),
    'el archivo que sólo ve git TIENE que entrar al delta: si no, su advisor no re-audita el fix');
  assert.match(out.delta_source, /git working-tree/);
});

test('los probes NO entran al delta en NINGUNA iteración (ni por nombre nuevo)', () => {
  const repo = mkRepoGit();
  const real = path.join(repo, 'src', 'PluginManager.cs');
  const probe = path.join(repo, 'tests', '__probe_determinism.test.ts');
  fs.writeFileSync(probe, '// probe\n');
  const home = mkHome({
    storyId: '9.3.1', repoPath: repo,
    filesTouched: [real, probe],                    // el probe quedó en la lista cruda…
    iterations: { 1: { ts: new Date(Date.now() - 60000).toISOString(), filesSnapshot: [real] } },
  });                                               // …y la foto ya venía filtrada
  fs.writeFileSync(real, '// fix\n');

  const out = reloop(repo, home);
  assert.ok(!out.delta_files.some((f) => f.includes('__probe')),
    'filtrar sólo la foto dejaba el probe como "archivo nuevo" en la iter 2 — y en la 3, y en todas');
});

test('lo escrito FUERA del repo no entra al delta, aunque no se llame como un probe (caso épico 11, 2026-10-07)', () => {
  const repo = mkRepoGit();
  const real = path.join(repo, 'src', 'PluginManager.cs');
  const afuera = fs.mkdtempSync(path.join(os.tmpdir(), 'cazador-5b-'));
  const sonda = path.join(afuera, 'probe.sh');       // un nombre fuera de la convención de probes
  fs.writeFileSync(sonda, 'echo sonda\n');
  const reciente = new Date(Date.now() + 1000).toISOString();
  const home = mkHome({
    storyId: '9.3.1', repoPath: repo,
    filesTouched: [real, sonda],
    fileEvents: [{ path: sonda, ts: reciente }, { path: real, ts: reciente }],
    iterations: { 1: { ts: new Date(Date.now() - 60000).toISOString(), filesSnapshot: [real] } },
  });
  fs.writeFileSync(real, '// fix\n');

  const out = reloop(repo, home);
  assert.ok(!out.delta_files.includes(sonda), `la sonda de /tmp no es trabajo del repo: ${out.delta_files.join(', ')}`);
  assert.ok(out.delta_files.some((f) => f.endsWith('PluginManager.cs')), 'el arreglo de verdad sigue en el delta');
});

test('la story en un repo de specs aparte SÍ cuenta en el delta (no es «fuera del repo»)', () => {
  const repo = mkRepoGit();
  const specs = fs.mkdtempSync(path.join(os.tmpdir(), 'specs-aparte-'));
  const story = path.join(specs, 'story-9.3.1.md');
  fs.writeFileSync(story, fs.readFileSync(path.join(repo, 'story.md')));
  const real = path.join(repo, 'src', 'PluginManager.cs');
  const home = mkHome({
    storyId: '9.3.1', repoPath: repo,
    filesTouched: [real, story],
    fileEvents: [{ path: story, ts: new Date(Date.now() + 1000).toISOString() }],
    iterations: { 1: { ts: new Date(Date.now() - 60000).toISOString(), filesSnapshot: [real] } },
  });
  fs.writeFileSync(real, '// fix\n');
  const r = spawnSync(process.execPath,
    [PIPELINE, 'smart-reloop', '--iter', '2', '--repo', repo, '--story', story, '--files', 'src/PluginManager.cs'],
    { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: SID } });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(out.delta_files.includes(story), `editar la story es trabajo de la corrida: ${out.delta_files.join(', ')}`);
});

test('un fix en `.js` NO saltea a los advisors de código (el arnés es JavaScript)', () => {
  // 🔴 La superficie auditada de security-basics y silent-failure-hunter tiene que incluir `.js`, no
  // sólo `.cs/.ts/.tsx`. El arnés mismo es JavaScript sin transpilar: sin eso, varios re-loops
  // seguidos saltearían a los dos advisors por «superficie no tocada», aunque el hallazgo del
  // cazador de fallos silenciosos se arregle justamente en un `.js`.
  // O sea: el advisor que encontró el bug no volvería a mirar su propio fix.
  const repo = mkRepoGit();
  const real = path.join(repo, 'src', 'medidor.js');
  fs.writeFileSync(real, '// fix del catch mudo\n');
  const home = mkHome({
    storyId: '9.4', repoPath: repo,
    filesTouched: [real],
    iterations: { 1: { ts: new Date(Date.now() - 60000).toISOString(), filesSnapshot: [] } },
  });

  const out = reloop(repo, home, 'src/medidor.js');
  const salteados = (out.skipped || []).map((s) => s.name);
  for (const advisor of ['tycon-plugin-security-basics', 'tycon-silent-failure-hunter']) {
    assert.ok(!salteados.includes(advisor),
      `${advisor} se salteó con un .js en el delta — razón: ` +
      `${(out.skipped || []).find((s) => s.name === advisor)?.reason}`);
  }
});

test('un `--repo` relativo no inventa ceguera (force-full falso en cada iteración)', () => {
  const repo = mkRepoGit();
  const real = path.join(repo, 'src', 'PluginManager.cs');
  const home = mkHome({
    storyId: '9.3.1', repoPath: repo,
    filesTouched: [real],
    iterations: { 1: { ts: new Date(Date.now() - 60000).toISOString(), filesSnapshot: [real] } },
  });
  fs.writeFileSync(real, '// fix\n');
  const r = spawnSync(process.execPath,
    [PIPELINE, 'smart-reloop', '--iter', '2', '--repo', '.', '--story', path.join(repo, 'story.md'),
      '--files', 'src/PluginManager.cs'],
    { encoding: 'utf8', cwd: repo, env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: SID } });
  const out = JSON.parse(r.stdout);
  assert.notEqual(out.ledger_blind, true,
    'comparar strings sin resolver hacía que `--repo .` no matcheara ninguna entrada del registro');
});

// ── La foto es de la vuelta; la versión que vio cada revisor, no ──────────────────
// 🔴 La foto de la vuelta se toma sola al lanzar el ÚLTIMO revisor. Un arreglo hecho
// mientras corrían los revisores, pero ANTES de ese último lanzamiento, queda adentro de la foto: el
// delta de la vuelta siguiente no lo trae, y el revisor que se había lanzado ANTES del arreglo —que
// nunca lo vio— se saltea por «superficie no tocada». La corrección mira, por revisor, cuándo se
// lanzó (el registro de lanzamientos que escribe el hook, no algo que el agente tipea), y trata como
// no visto todo lo editado después de ESE lanzamiento.
// Caso que cubre: `security-basics` (lanzado a t1, arreglo a t2, último revisor y foto a t3) saldría en
// `skipped` con «superficie no tocada».

/** Registro de lanzamientos de la sesión, como lo escribe on-advisor-run.js. */
function escribirRegistro(home, lineas) {
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'advisor-runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), lineas.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('un arreglo hecho entre dos lanzamientos re-corre al revisor que se lanzó antes, y sólo a ése', () => {
  const repo = mkRepoGit();
  const real = path.join(repo, 'src', 'PluginManager.cs');
  const A = 'tycon-plugin-security-basics';
  const B = 'tycon-silent-failure-hunter';          // también audita .cs (uno del núcleo: el de .NET viaja con su paquete)
  const base = Date.now() - 120000;
  const t = (s) => new Date(base + s * 1000).toISOString();
  // t0 arranca la vuelta 1 · t10 se lanza A · t20 se arregla el archivo · t30 se lanza B (el último) y sale la foto.
  // (con un `try`: así el set trae también al de fallos silenciosos, el segundo revisor que audita .cs)
  fs.writeFileSync(real, '// arreglo hecho mientras A ya estaba corriendo\ntry { Run(); } catch (Exception e) { Log(e); }\n');
  const seg = (base + 20000) / 1000;
  fs.utimesSync(real, seg, seg);
  const home = mkHome({
    storyId: '9.3.1', repoPath: repo,
    filesTouched: [real],
    fileEvents: [{ path: real, ts: t(20) }],
    iterations: { 1: { ts: t(30.3), filesSnapshot: [real] } },
  });
  escribirRegistro(home, [
    { ts: t(0), event: 'step5-start', iter: 1, expected: [A, B], mode: 'advisors' },
    { ts: t(10), advisor: A, story: '9.3.1', repo },
    { ts: t(30), advisor: B, story: '9.3.1', repo },
    { ts: t(30.2), event: 'auto-snapshot', iter: 1 },
  ]);

  const out = reloop(repo, home);
  assert.equal(out.mode, 'smart-reloop');
  assert.ok(out.rerun.includes(A),
    `${A} se lanzó ANTES del arreglo y nunca lo vio — skipped: ${JSON.stringify(out.skipped.find((s) => s.name === A))}`);
  assert.ok(out.skipped.some((s) => s.name === B),
    `${B} se lanzó DESPUÉS del arreglo: re-correrlo sería gastar de más — rerun: ${out.rerun.join(', ')}`);
  assert.ok((out.no_vistos_por_revisor || {})[A], 'y la salida dice qué archivos no vio cada revisor');
});
