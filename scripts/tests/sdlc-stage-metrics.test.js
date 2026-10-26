'use strict';
/**
 * sdlc-stage-metrics.test.js — red del agregador de métricas de etapa del SDLC. Fixture determinista: repo git efímero con commits
 * retro-fechados + dashboard 2.0 de juguete. Fuerza el descubridor de FALLBACK
 * (TYCON_SKILLS_DIR inexistente) para que el test no dependa de agent-skills — el descubridor
 * canónico tiene su propia suite (story-discovery.test.js).
 *
 * Lo que cuida: que lead time salga de las fechas de git (no del mtime), que las ratios
 * declaren numerador/denominador, que "sin .advisors/dod-runtime" sea NO-MEDIDO con motivo
 * (null no es 0), y que el first-pass lea el dashboard 2.0 de verdad.
 *
 * Spawnea git → va en el throttle DIARIO del instalador, no en UNIT_TESTS de cada arranque.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'metrics', 'sdlc-stage-metrics.js');

function sh(cwd, cmd, args, env = {}) {
  return execFileSync(cmd, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  });
}

function gitCommit(repo, msg, isoDate) {
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], {
    GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate,
  });
}

function story(id, status, extra = '') {
  return `---\nstory: ${id}\nepic: 1\nstatus: ${status}\n${extra}---\n\n# Story ${id}\n`;
}

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-metrics-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  sh(root, 'git', ['init', '-q', 'repo']);

  // T-1: done, creada el día 1, último toque el día 11 → lead time 10 días. Con follow-up.
  fs.writeFileSync(path.join(repo, 'specs', 'story-t1.md'),
    story('T-1', 'ready-for-dev', 'followed_up_by:\n  - id: T-9\n'));
  // T-2: done, creada y cerrada el mismo día. Exenta de DoD por declaración.
  fs.writeFileSync(path.join(repo, 'specs', 'story-t2.md'),
    story('T-2', 'done', 'dod_runtime_exempt: true\n'));
  // T-3: done sin evidencia ni exención. T-4: in-progress (no entra en done).
  fs.writeFileSync(path.join(repo, 'specs', 'story-t3.md'), story('T-3', 'done'));
  fs.writeFileSync(path.join(repo, 'specs', 'story-t4.md'), story('T-4', 'in-progress'));
  gitCommit(repo, 'stories nacen', '2026-08-01T10:00:00-03:00');

  fs.writeFileSync(path.join(repo, 'specs', 'story-t1.md'),
    story('T-1', 'done', 'followed_up_by:\n  - id: T-9\n'));
  gitCommit(repo, 'T-1 cierra 10 días después', '2026-08-11T10:00:00-03:00');

  // Evidencia DoD: solo T-1 la tiene por archivo (T-2 por exención, T-3 nada).
  // 🔴 Es el INFORME de cierre, no la matriz: la matriz no cuenta como evidencia
  // en las cuatro capas.
  fs.mkdirSync(path.join(repo, '.advisors', 'dod-runtime'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.advisors', 'dod-runtime', 'T-1-dod-runtime-checker.md'), 'AC #1 ✅\n');
  gitCommit(repo, 'evidencia', '2026-08-11T11:00:00-03:00');

  // Dashboard 2.0 de juguete: iteraciones 1, 1, 2 → first-pass 2/3.
  const dash = path.join(root, 'dash');
  fs.mkdirSync(dash);
  [1, 1, 2].forEach((iter, i) => {
    fs.writeFileSync(path.join(dash, `metrics-t${i}.json`), JSON.stringify({
      schema_version: '2.0',
      repo, merge_commit: 'abcdef' + (10 + i), project: 'test', captured_at: `2026-08-1${i}T00:00:00Z`,
      metrics: { advisor_rerun_loop_iterations: { value: iter } },
    }));
  });

  // Repo mínimo SIN .advisors → dod no-medido con motivo. En contenedor propio (solo/),
  // porque el barrido de hermanos encontraría la evidencia del fixture principal.
  const solo = path.join(root, 'solo');
  fs.mkdirSync(solo, { recursive: true });
  const bare = path.join(solo, 'bare');
  fs.mkdirSync(path.join(bare, 'specs'), { recursive: true });
  sh(solo, 'git', ['init', '-q', 'bare']);
  fs.writeFileSync(path.join(bare, 'specs', 'story-b1.md'), story('B-1', 'done'));
  gitCommit(bare, 'b1', '2026-08-05T10:00:00-03:00');

  return { root, repo, dash, bare };
}

function run(args) {
  const out = execFileSync('node', [SCRIPT, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, TYCON_SKILLS_DIR: '/nonexistent-sdlc-metrics-test' },
  });
  return JSON.parse(out);
}

const fx = buildFixture();
test.after(() => { try { fs.rmSync(fx.root, { recursive: true, force: true }); } catch {} });

test('lead time sale de las fechas de git y la serie mensual existe', () => {
  const r = run(['--repo', fx.repo, '--dashboard', fx.dash]);
  const repo = r.repos[0];
  assert.equal(repo.done_total, 3);
  assert.equal(repo.lead_time_days.max.toFixed(0), '10'); // T-1: 01→11 de agosto
  assert.ok(r.global.lead_time_monthly.some((m) => m.month === '2026-08'));
});

test('las ratios declaran numerador y denominador', () => {
  const r = run(['--repo', fx.repo, '--dashboard', fx.dash]);
  const repo = r.repos[0];
  assert.deepEqual(repo.rework_ratio, { num: 1, den: 3 });       // solo T-1 tiene follow-up
  // T-1 archivo → cubre. T-2 exenta SIN archivo → sale del cociente y se cuenta aparte
  // (la exención es «no hay prueba», no «hay prueba»). T-3 nada → no cubre.
  assert.deepEqual(repo.dod_evidence_ratio, { num: 1, den: 2, exentas: 1 });
});

// 🔴 Una story que declara `dod_runtime_exempt: true` para pasar el portón no puede contarse como «cierre que dejó
// prueba de que la cosa anda corriendo»: inflaría la ficha con stories que justamente NO la dejaron.
// Una exención es una declaración de que no hay prueba; no puede sumar como prueba.
// Falla si: esto da { num: 2, den: 3 } (la exenta suma arriba).
test('una exenta sin evidencia sale del cociente y se cuenta aparte; con evidencia real, cuenta', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-exenta-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  sh(root, 'git', ['init', '-q', 'repo']);
  fs.writeFileSync(path.join(repo, 'specs', 'story-e1.md'), story('E-1', 'done'));
  fs.writeFileSync(path.join(repo, 'specs', 'story-e2.md'), story('E-2', 'done', 'dod_runtime_exempt: true\n'));
  fs.writeFileSync(path.join(repo, 'specs', 'story-e3.md'), story('E-3', 'done', 'dod_runtime_exempt: true\n'));
  fs.writeFileSync(path.join(repo, 'specs', 'story-e4.md'), story('E-4', 'done'));
  gitCommit(repo, 'cuatro done', '2026-08-01T10:00:00-03:00');
  const dod = path.join(repo, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true });
  // E-1: informe de cierre real. E-3: exenta PERO con informe real — la evidencia gana.
  fs.writeFileSync(path.join(dod, 'E-1-dod-runtime-checker.md'), 'AC #1 ✅\n');
  fs.writeFileSync(path.join(dod, 'E-3-dod-runtime-checker.md'), 'AC #1 ✅\n');
  gitCommit(repo, 'evidencia', '2026-08-02T10:00:00-03:00');
  const dash = path.join(root, 'dash'); fs.mkdirSync(dash);
  const r = run(['--repo', repo, '--dashboard', dash]);
  assert.deepEqual(r.repos[0].dod_evidence_ratio, { num: 2, den: 3, exentas: 1 },
    'E-1 y E-3 cubren (E-3 tiene el archivo aunque esté exenta); E-2 exenta sin archivo sale; E-4 no cubre');
  // El global suma las exentas y lo dice: un salto en esta fecha es cambio de conteo, no de conducta.
  assert.equal(r.global.dod_evidence_ratio.exentas, 1);
  assert.match(r.global.dod_evidence_ratio.nota || '', /2026-09-18/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('first-pass se lee del dashboard 2.0', () => {
  const r = run(['--repo', fx.repo, '--dashboard', fx.dash]);
  assert.equal(r.global.first_pass_ratio.num, 2);
  assert.equal(r.global.first_pass_ratio.den, 3);
});

test('sin .advisors/dod-runtime (ni en hermanos) es NO-MEDIDO con motivo, nunca 0%', () => {
  const r = run(['--repo', fx.bare, '--dashboard', fx.dash]);
  const repo = r.repos[0];
  assert.equal(repo.dod_evidence_ratio, null);
  assert.ok(repo.not_measured.some((n) => n.includes('dod_evidence')));
});

test('la evidencia DoD se encuentra en un repo HERMANO (layout Project + Backend)', () => {
  // Contenedor propio: proj/ tiene la story, impl/ tiene la evidencia.
  const cont = path.join(fx.root, 'split');
  fs.mkdirSync(path.join(cont, 'proj', 'specs'), { recursive: true });
  sh(cont, 'git', ['init', '-q', 'proj']);
  fs.writeFileSync(path.join(cont, 'proj', 'specs', 'story-s1.md'), story('S-1', 'done'));
  gitCommit(path.join(cont, 'proj'), 's1', '2026-08-05T10:00:00-03:00');
  fs.mkdirSync(path.join(cont, 'impl', '.advisors', 'dod-runtime'), { recursive: true });
  fs.writeFileSync(path.join(cont, 'impl', '.advisors', 'dod-runtime', 'S-1-smoke.md'), 'ok\n');

  const r = run(['--repo', path.join(cont, 'proj'), '--dashboard', fx.dash]);
  assert.deepEqual(r.repos[0].dod_evidence_ratio, { num: 1, den: 1, exentas: 0 });
});

test('un path que no es repo git se reporta como error, no como ceros', () => {
  const r = run(['--repo', path.join(fx.root, 'dash'), '--dashboard', fx.dash]);
  assert.ok(r.repos[0].error);
});

test('--scan descubre los repos solo y omite del reporte los que no tienen stories', () => {
  // fx.root contiene repo/ (con stories), bare/ dentro de solo/, split/ y dash/ (no repo).
  const r = run(['--scan', fx.root, '--dashboard', fx.dash]);
  const paths = r.repos.map((x) => x.repo);
  assert.ok(paths.includes(fx.repo), 'tiene que encontrar el repo con stories');
  assert.ok(r.repos.every((x) => x.stories_total > 0),
    'ningún repo sin stories debería llegar al reporte');
});

test('--only-harness deja afuera del scan los repos sin huella del arnés', () => {
  // Contenedor con dos repos con stories: uno con .tycon (del equipo) y uno pelado (curso/demo).
  const cont = path.join(fx.root, 'org');
  for (const [name, harness] of [['delequipo', true], ['curso', false]]) {
    const r = path.join(cont, name);
    fs.mkdirSync(path.join(r, 'specs'), { recursive: true });
    sh(cont, 'git', ['init', '-q', name]);
    fs.writeFileSync(path.join(r, 'specs', 'story-x1.md'), story('X-1', 'done'));
    if (harness) fs.mkdirSync(path.join(r, '.tycon'), { recursive: true });
    gitCommit(r, 'x1', '2026-08-05T10:00:00-03:00');
  }
  const out = execFileSync('node', [SCRIPT, '--scan', cont, '--only-harness', '--dashboard', fx.dash, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, TYCON_SKILLS_DIR: '/nonexistent-sdlc-metrics-test' },
  });
  const r = JSON.parse(out);
  const names = r.repos.map((x) => path.basename(x.repo));
  assert.deepEqual(names, ['delequipo'], 'el repo sin .tycon/.advisors no debe medirse');
});

test('--snapshot deja el punto de serie en el dashboard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-snap-'));
  execFileSync('node', [SCRIPT, '--repo', fx.repo, '--dashboard', dir, '--snapshot', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, TYCON_SKILLS_DIR: '/nonexistent-sdlc-metrics-test' },
  });
  const files = fs.readdirSync(dir).filter((f) => /^sdlc-stage-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  assert.equal(files.length, 1, 'un snapshot por día');
  const doc = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.ok(doc.global && doc.repos.length, 'el snapshot trae global + repos');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── El medidor cuenta evidencia con el MISMO criterio que el portón ─────────────
// Si contara cualquier `<id>-*` — la matriz por AC, el self-audit, hasta un `.jsonl` —, el tablero diría «cubierta»
// de stories que el portón rechaza. Un número que no significa lo que parece es peor que no tenerlo: por eso
// importa `esEvidenciaDeCierre` del portón (mismo repo).
// 🔴 Falla si: la matriz sola cubre la story.
test('la matriz por AC sola NO cubre una story en el tablero (mismo criterio que el portón)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-matriz-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  sh(root, 'git', ['init', '-q', 'repo']);
  fs.writeFileSync(path.join(repo, 'specs', 'story-m1.md'), story('M-1', 'done'));
  fs.writeFileSync(path.join(repo, 'specs', 'story-m2.md'), story('M-2', 'done'));
  fs.writeFileSync(path.join(repo, 'specs', 'story-m3.md'), story('M-3', 'done'));
  gitCommit(repo, 'tres stories done', '2026-08-01T10:00:00-03:00');
  const dod = path.join(repo, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true });
  // M-1: sólo la matriz y el self-audit — la declaración, no la prueba.
  fs.writeFileSync(path.join(dod, 'M-1-runtime-matrix.md'), '| AC | (sin evidencia) |\n');
  fs.writeFileSync(path.join(dod, 'M-1-self-audit-iter2.md'), 'self\n');
  // M-2: el informe de cierre real.
  fs.writeFileSync(path.join(dod, 'M-2-dod-runtime-checker.md'), 'AC #1 ✅\n');
  // M-3: SÓLO el ledger de smokes — el registro crudo de lo que corrió. CUENTA: es más difícil de falsear que un informe redactado.
  fs.writeFileSync(path.join(dod, 'M-3-smoke-ledger.jsonl'), '{"story":"M-3","acs":[1],"exit":0}\n');
  gitCommit(repo, 'evidencia', '2026-08-02T10:00:00-03:00');
  const dash = path.join(root, 'dash'); fs.mkdirSync(dash);
  const r = run(['--repo', repo, '--dashboard', dash]);
  assert.deepEqual(r.repos[0].dod_evidence_ratio, { num: 2, den: 3, exentas: 0 },
    'M-1 (matriz+self-audit) NO cubre; M-2 (informe) y M-3 (ledger) SÍ — mismo criterio que el portón');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── los merges que baja el nocturno (`.dashboard/merges/`) y su constancia ─────────────────────────
// Un archivo 2.0 mínimo, con la forma del fixture de arriba.
function metricsDoc(dir, nombre, sha, iter, fecha, project = 'test') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, nombre), JSON.stringify({
    schema_version: '2.0', repo: fx.repo, merge_commit: sha, project, captured_at: fecha,
    metrics: { advisor_rerun_loop_iterations: { value: iter } },
  }));
}
const copiaDash = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-8132-'));
  for (const f of fs.readdirSync(fx.dash)) fs.copyFileSync(path.join(fx.dash, f), path.join(d, f));
  return d;
};
const notMeasured = (r) => (r.global.not_measured || []).join(' · ');

// Sin esto,`merges/` no se lee (el merge que sólo está ahí no entra), o se lee sumado a la raíz y el merge que
//    está en las dos cuenta dos veces.
test('T23 FirstPass_RootAndMerges_NoDouble @story-8.132 @ac-14: raíz + merges/, el repetido una vez', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-8132-'));
  metricsDoc(d, 'metrics-1.json', '1'.repeat(40), 1, '2026-10-20T00:00:00Z');
  metricsDoc(d, 'metrics-2.json', '2'.repeat(40), 2, '2026-10-20T00:00:00Z');
  // el mismo merge que metrics-2, bajado después con su última vuelta; y uno que sólo está en merges/
  metricsDoc(path.join(d, 'merges'), 'metrics-2b.json', '2'.repeat(40), 1, '2026-10-21T00:00:00Z', 'test-wt');
  metricsDoc(path.join(d, 'merges'), 'metrics-3.json', '3'.repeat(40), 1, '2026-10-21T00:00:00Z');
  const r = run(['--repo', fx.repo, '--dashboard', d]);
  assert.equal(r.global.first_pass_ratio.den, 3, JSON.stringify(r.global.first_pass_ratio));
  assert.equal(r.global.first_pass_ratio.num, 3, 'entre los dos del mismo merge, el más nuevo; el de merges/ solo entra');
  fs.rmSync(d, { recursive: true, force: true });
});

// Sin esto, una corrida sin `--merges-receipt` (a mano, o un nocturno que no la pasa) cambia la medida o sale «no medido».
test('T33 FirstPass_NoReceiptFlag_AsToday @story-8.132 @ac-22 @ac-20: sin la opción, como hoy', () => {
  const r = run(['--repo', fx.repo, '--dashboard', fx.dash]);
  assert.deepEqual([r.global.first_pass_ratio.num, r.global.first_pass_ratio.den], [2, 3]);
  assert.doesNotMatch(notMeasured(r), /bajada de los merges/);
});

// Sin esto,la primera noche nueva, sin `merges/` ni constancia, el nocturno sale distinto de 0, no deja la foto, o
//    mide la primera vuelta con lo versionado en la raíz.
test('T36 Transition_NewNightNoMergesFolder_NotMeasured @story-8.132 @ac-22: sin constancia, foto entera y «no medido»', () => {
  const d = copiaDash();
  const out = execFileSync('node', [SCRIPT, '--repo', fx.repo, '--dashboard', d, '--merges-receipt', path.join(d, 'merges', 'bajada.json'), '--snapshot', '--json'], {
    encoding: 'utf8', env: { ...process.env, TYCON_SKILLS_DIR: '/nonexistent-sdlc-metrics-test' },
  });
  const r = JSON.parse(out);
  assert.strictEqual(r.global.first_pass_ratio.value, null, JSON.stringify(r.global.first_pass_ratio));
  assert.strictEqual(r.global.first_pass_ratio.num, undefined, 'nunca el número de la raíz');
  assert.match(notMeasured(r), /no medido: la bajada de los merges/);
  assert.ok(r.global.lead_time_days, 'las demás métricas se miden igual');
  assert.equal(fs.readdirSync(d).filter((f) => /^sdlc-stage-\d{4}-\d{2}-\d{2}\.json$/.test(f)).length, 1, 'la foto del día queda escrita');
  fs.rmSync(d, { recursive: true, force: true });
});

// La línea de `sdlc-stage-metrics.js` de un `stage-metrics.yml` de operaciones sin `--merges-receipt`, copiada tal
// cual: mientras el público tiene el código nuevo y operaciones no, ésta es la que corre.
const STAGE_METRICS_ANTES = `
          node scripts/metrics/sdlc-stage-metrics.js \\
            --scan "$(Agent.TempDirectory)/repos" \\
            --only-harness \\
            --dashboard "$(Build.SourcesDirectory)/.dashboard" \\
            --snapshot
          FIN=$(date +%s)
`;
// Sin esto, el código nuevo exige `--merges-receipt`, o sin ella deja de medir la primera vuelta: la noche de
//    transición sale roja o con el número en blanco.
test('T43 Transition_NewCodeOldYaml_AsToday @story-8.132 @ac-22: el YAML viejo con el código nuevo mide como hoy', () => {
  const lineas = STAGE_METRICS_ANTES.split('\n').map((l) => l.trim());
  const i = lineas.findIndex((l) => l.startsWith('node scripts/metrics/sdlc-stage-metrics.js'));
  const comando = [];
  for (let k = i; k < lineas.length; k++) { comando.push(lineas[k].replace(/\\$/, '').trim()); if (!lineas[k].endsWith('\\')) break; }
  const cont = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-8132-yaml-'));
  const repos = path.join(cont, 'repos');
  const r = path.join(repos, 'delequipo');
  fs.mkdirSync(path.join(r, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(r, '.tycon'), { recursive: true });
  sh(repos, 'git', ['init', '-q', 'delequipo']);
  fs.writeFileSync(path.join(r, 'specs', 'story-y1.md'), story('Y-1', 'done'));
  gitCommit(r, 'y1', '2026-08-05T10:00:00-03:00');
  const d = copiaDash();
  const args = comando.join(' ').replace('$(Agent.TempDirectory)', cont).replace('$(Build.SourcesDirectory)/.dashboard', d)
    .match(/"[^"]*"|\S+/g).map((x) => x.replace(/^"|"$/g, '')).slice(2);
  assert.ok(!args.includes('--merges-receipt'), 'la línea de antes no trae la constancia');
  execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, TYCON_SKILLS_DIR: '/nonexistent-sdlc-metrics-test' } });
  const foto = fs.readdirSync(d).find((f) => /^sdlc-stage-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  assert.ok(foto, 'la foto del día queda escrita');
  const doc = JSON.parse(fs.readFileSync(path.join(d, foto), 'utf8'));
  assert.deepEqual([doc.global.first_pass_ratio.num, doc.global.first_pass_ratio.den], [2, 3], 'el mismo número que hoy');
  assert.doesNotMatch((doc.global.not_measured || []).join(' '), /bajada de los merges/);
  fs.rmSync(cont, { recursive: true, force: true }); fs.rmSync(d, { recursive: true, force: true });
});
