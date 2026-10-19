'use strict';
// weekly-review.test.js — la revisión de la semana: junta los merges de siete días con sus retros y sus hallazgos, le
// pasa el material a un agente en una sola corrida con tope, valida lo que vuelve y escribe sólo propuestas. Repos de
// juguete de verdad (git) y un agente inyectado (TYCON_WEEKLY_REVIEW_AGENT) que contesta lo que la prueba le da.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REVIEW = path.join(ROOT, 'scripts', 'nightly', 'weekly-review', 'weekly-review.js');
const SUMMARY = path.join(ROOT, 'scripts', 'nightly', 'dependencies', 'daily-summary.js');
const GUIDE = path.join(ROOT, 'guides', 'maintaining', 'mantener-el-arnes.md');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-review-')); dirs.push(d); return d; };
// una casa propia: sin ella, una corrida sin --stamp escribe el sello y los clones en el estado de quien corre la suite
const CASA = tmp();

function env(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|TYCON_|BUILD_|SYSTEM_|TF_BUILD)/.test(k)) e[k] = v;
  return { ...e, HOME: CASA, USERPROFILE: CASA, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'weekly-review-no-global'),
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
    TYCON_TODAY: '2026-10-19', ...extra };
}
function git(dir, args, extra = {}) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args], { env: env(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const write = (dir, rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };

/**
 * Un repo con main y un merge por entrada: `{ date, branch, files: { ruta: texto } }`. La rama lleva el número de la
 * story, como las reales («<prefijo>/<número>-<tema>»). Devuelve { dir, shas }.
 */
function repo(entries, base = {}) {
  const dir = tmp();
  git(dir, ['init', '--quiet', '-b', 'main']);
  write(dir, 'base.txt', 'base\n');
  for (const [rel, body] of Object.entries(base)) write(dir, rel, body);
  git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '-m', 'base'], { GIT_AUTHOR_DATE: '2026-10-01T10:00:00', GIT_COMMITTER_DATE: '2026-10-01T10:00:00' });
  const shas = [];
  entries.forEach((e, i) => {
    const dates = { GIT_AUTHOR_DATE: e.date, GIT_COMMITTER_DATE: e.date };
    git(dir, ['checkout', '--quiet', '-b', e.branch]);
    for (const [rel, body] of Object.entries(e.files || { [`f${i}.txt`]: `${i}\n` })) write(dir, rel, body);
    git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '-m', e.commit || `feat: trabajo ${i}`], dates);
    git(dir, ['checkout', '--quiet', 'main']);
    git(dir, ['merge', '--quiet', '--no-ff', e.branch, '-m', `Merge pull request ${100 + i} from ${e.branch} into main`], dates);
    shas.push(git(dir, ['rev-parse', 'HEAD']));
  });
  return { dir, shas };
}
/** El repo de operaciones: los archivos de retro de los merges dados, en `.dashboard/retros/`. */
function retros(list) {
  const files = {};
  for (const r of list) {
    files[`.dashboard/retros/metrics-${r.sha.slice(0, 7)}.json`] = JSON.stringify({ schema_version: '2.0', repo: '/agente/x', merge_commit: r.sha,
      story: r.story || null, generated_by: r.by || 'retro-latido.js', ...(r.learnings ? { learnings: r.learnings } : {}), metrics: {} });
  }
  return repo([{ date: '2026-10-18T23:00:00', branch: 'chore/retros', files }]).dir;
}
/** El clon de mantenimiento, donde van las propuestas y el informe. */
function maintainers() {
  return repo([], { 'guides/guide-update-proposals.md': '# Guide Update Proposals\n\nPropuestas.\n\n---\n' }).dir;
}
/** El agente de juguete: guarda lo que recibió y contesta `respuesta` (un objeto, o texto crudo). */
function agent(respuesta) {
  const d = tmp();
  const calls = path.join(d, 'calls.jsonl');
  const resp = path.join(d, 'resp.txt');
  fs.writeFileSync(resp, typeof respuesta === 'string' ? respuesta : JSON.stringify(respuesta));
  const script = path.join(d, 'agent.js');
  fs.writeFileSync(script, `const fs=require('fs');let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>{
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ chars: s.length, argv: process.argv.slice(2), prompt: s })+'\\n');
    process.stdout.write(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.42, result: fs.readFileSync(${JSON.stringify(resp)}, 'utf8') }));
  });\n`);
  return { script, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}
function review(args, extra = {}) {
  const r = spawnSync(process.execPath, [REVIEW, ...args], { env: env(extra), encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const informe = (out) => JSON.parse(fs.readFileSync(path.join(out, '.dashboard', 'weekly-review', 'latest.json'), 'utf8'));

/** La semana de prueba: cuatro merges dentro (tres de story y uno que no) y uno de antes. */
function semana() {
  const a = repo([
    { date: '2026-10-05T10:00:00', branch: 'story/8.40-vieja', files: { 'specs/story-8.40.md': 'vieja\n' } },
    { date: '2026-10-13T10:00:00', branch: 'story/8.54-oferta', files: { 'specs/story-8.54.md': '- el pase adversarial dio «limpio» sin agentes vivos\n',
      '.advisors/pipeline-runs/8.54-1/findings.json': JSON.stringify([{ rule_id: 'TEST-C1', severity: 'CRITICAL', disposition: 'waived', reason: 'del ambiente' }]) } },
    { date: '2026-10-14T10:00:00', branch: 'story/8.55-porton', files: { 'tasks/todo.md': '- [ ] DEF-workflow-lite-agentes-muertos-verde-falso\n' } },
    { date: '2026-10-15T10:00:00', branch: 'story/8.57-x', files: { 'specs/story-8.57.md': 'otra vez «limpio» falso\n' } },
    { date: '2026-10-16T10:00:00', branch: 'chore/sube-version', files: { 'version.txt': '2\n' } },
  ]);
  const ops = retros(a.shas.slice(1).map((sha) => ({ sha })));
  return { a, ops, enSemana: a.shas.slice(1), vieja: a.shas[0] };
}
/** Un commit directo en main, con su autor y su asunto (los guardados de los nocturnos entran así). Devuelve el sha. */
function directo(dir, date, author, subject, files = { [`n-${date}.txt`]: 'x\n' }) {
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', subject], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: author, GIT_COMMITTER_NAME: author });
  return git(dir, ['rev-parse', 'HEAD']);
}
const patron = (merges, extra = {}) => ({ patron: 'el pase adversarial da todo limpio sin revisar', titulo_llano: 'el pase adversarial da todo limpio sin haber revisado',
  forma: 'prueba', texto: 'una prueba que corre el pase con los agentes muertos y exige rojo', por_que: 'los tres habrían salido rojos', merges, ...extra });

test('T1 Semana_JuntaMergesRetrosYHallazgos @story-1.27 @ac-1: sólo los de la semana, cada uno con su retro y sus hallazgos', () => {
  const s = semana();
  const out = maintainers();
  const ag = agent({ patrones: [] });
  const r = review(['--out', out, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push'], { TYCON_WEEKLY_REVIEW_AGENT: ag.script });
  assert.strictEqual(r.code, 0, r.out);
  const j = informe(out);
  const leidos = j.merges_leidos.filter((m) => m.repo === 'acme-a');
  assert.deepStrictEqual(leidos.map((m) => m.sha).sort(), s.enSemana.slice().sort(), 'los cuatro de la semana, no el del 5');
  const prompt = ag.calls()[0].prompt;
  assert.ok(!prompt.includes(s.vieja.slice(0, 12)), 'el merge de antes de la semana no va al agente');
  assert.ok(prompt.includes('DEF-workflow-lite-agentes-muertos-verde-falso'), 'lo agregado a tasks/todo.md va');
  assert.ok(prompt.includes('TEST-C1'), 'los hallazgos de su findings.json van');
  const m854 = leidos.find((m) => m.story === '8.54');
  assert.ok(m854 && m854.retro === 'latido', `el de la 8.54 con su retro (latido): ${JSON.stringify(m854)}`);
  assert.ok(m854.hallazgos === 1, 'y su hallazgo contado');
  assert.ok(prompt.includes('specs/story-8.54.md'), 'la lista de archivos de cada merge va al agente');
});

test('T13 Semana_NocturnosSalteados_HallazgosIlegiblesDichos @story-1.27 @ac-1 @ac-6: los guardados de los nocturnos no cuentan contra el tope y se nombran; un findings.json roto se marca', () => {
  const s = semana();
  directo(s.a.dir, '2026-10-17T03:00:00', 'Azure Pipelines', 'chore(tablero): página del arnés 2026-10-17 [nocturno]');
  const roto = repo([{ date: '2026-10-17T10:00:00', branch: 'story/8.58-roto', files: { '.advisors/pipeline-runs/8.58-1/findings.json': '{ no es json' } }]);
  const ops = retros([...s.enSemana, ...roto.shas].map((sha) => ({ sha })));
  const out = maintainers();
  const ag = agent({ patrones: [] });
  const r = review(['--out', out, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-b=${roto.dir}`, '--repo', `acme-ops=${ops}`, '--no-push'], { TYCON_WEEKLY_REVIEW_AGENT: ag.script });
  assert.strictEqual(r.code, 0, r.out);
  const j = informe(out);
  assert.strictEqual(j.merges_salteados['proceso nocturno'], 1, JSON.stringify(j.merges_salteados));
  assert.ok(!ag.calls()[0].prompt.includes('página del arnés'), 'el guardado del nocturno no va al agente');
  assert.match(r.out, /1 merges? salteados?.*proceso nocturno/);
  const m = j.merges_leidos.find((x) => x.story === '8.58');
  assert.ok(m && Array.isArray(m.incompleto) && m.incompleto.includes('hallazgos'), `el merge del findings.json roto queda marcado: ${JSON.stringify(m)}`);
  assert.ok(ag.calls()[0].prompt.includes('"incompleto"'), 'y el agente lo ve marcado');
  // la story de un merge de Azure DevOps sale del título (sin eso, esos merges quedaban sin story)
  const W = require(REVIEW);
  assert.strictEqual(W.storyDe('Merged PR 1: Story 5.4 — spec', '', null), '5.4');
  assert.strictEqual(W.storyDe('Merged PR 1: arreglo del tablero', 'docs(2.42): lo que quedó', null), '2.42');
  assert.strictEqual(W.storyDe('Merged PR 1: chore sin story', '', null), null);
});

test('T2 Agente_UnaCorrida_ConTope @story-1.27 @ac-2 @ac-6: una sola llamada, con el material recortado al tope y lo que no entró nombrado', () => {
  const s = semana();
  const out = maintainers();
  const entero = agent({ patrones: [] });
  const r0 = review(['--out', maintainers(), '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push'], { TYCON_WEEKLY_REVIEW_AGENT: entero.script });
  assert.strictEqual(r0.code, 0, r0.out);
  // el tope: lo que mide la semana entera menos un poco, para que algo quede afuera
  const tope = entero.calls()[0].prompt.length - fs.readFileSync(path.join(ROOT, 'scripts', 'nightly', 'weekly-review', 'prompt.md'), 'utf8').length - 50;
  const ag = agent({ patrones: [] });
  const r = review(['--out', out, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push', '--max-chars', String(tope)], { TYCON_WEEKLY_REVIEW_AGENT: ag.script });
  assert.strictEqual(r.code, 0, r.out);
  const calls = ag.calls();
  assert.strictEqual(calls.length, 1, 'una sola corrida del agente');
  const j = informe(out);
  assert.ok(j.tope.material_chars <= tope, `el material respeta el tope: ${j.tope.material_chars} de ${tope}`);
  assert.ok(j.merges_no_leidos.length >= 1, 'algo quedó afuera y se nombra');
  assert.ok(j.merges_no_leidos.some((m) => m.story === null), 'lo primero que queda afuera es lo que no es de story');
  assert.match(r.out, /no entr[óo]|no leído/i, 'la salida dice que no leyó todo');
  // el agente de verdad: el tope en dólares, sin herramientas, sin MCP, sin ganchos ni sesión guardada
  const cmd = require(REVIEW).comandoDelAgente({ model: 'opus', budget: 2.5 });
  assert.strictEqual(cmd[0], 'claude');
  const at = cmd.indexOf('--max-budget-usd');
  assert.ok(at > 0 && cmd[at + 1] === '2.5', JSON.stringify(cmd));
  for (const f of ['-p', '--strict-mcp-config', '--no-session-persistence']) assert.ok(cmd.includes(f), f);
  assert.strictEqual(cmd[cmd.indexOf('--tools') + 1], '', 'sin herramientas');
  // el orden con una semana más grande que el tope: el primero de cada story antes que el segundo de ninguna (medido: con
  // orden por fecha, la primera semana real leyó sólo los primeros días y dejó afuera las stories del final)
  const W = require(REVIEW);
  const m = (story, fecha, sha) => ({ story, fecha, sha, asunto: '', commitsTexto: '', archivos: [], hallazgos: [], agregado: '', retro: null, repo: 'r' });
  const orden = W.ordenDeLectura([m('1.1', '2026-10-13', 'a'), m('1.1', '2026-10-14', 'b'), m('1.1', '2026-10-15', 'c'), m(null, '2026-10-12', 'n'), m('2.2', '2026-10-18', 'd'), m('3.3', '2026-10-19', 'e')]);
  assert.deepStrictEqual(orden.map((x) => x.sha), ['a', 'd', 'e', 'b', 'c', 'n']);
});

test('T3 Patron_MenosDeTres_Descartado @story-1.27 @ac-3: dos merges, o tres de una sola story, se descartan y quedan anotados', () => {
  const s = semana();
  const extra = repo([
    { date: '2026-10-13T11:00:00', branch: 'story/7.34-a' }, { date: '2026-10-14T11:00:00', branch: 'story/7.34-b' }, { date: '2026-10-15T11:00:00', branch: 'story/7.34-c' },
  ]);
  const ops = retros([...s.enSemana, ...extra.shas].map((sha) => ({ sha })));
  const out = maintainers();
  const ag = agent({ patrones: [
    patron(s.enSemana.slice(0, 2).map((sha) => ({ repo: 'acme-a', sha }))),
    patron(extra.shas.map((sha) => ({ repo: 'acme-b', sha })), { patron: 'tres de la misma story' }),
  ] });
  const r = review(['--out', out, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-b=${extra.dir}`, '--repo', `acme-ops=${ops}`, '--no-push'], { TYCON_WEEKLY_REVIEW_AGENT: ag.script });
  assert.strictEqual(r.code, 0, r.out);
  const j = informe(out);
  assert.strictEqual(j.propuestas.length, 0, 'ninguna pasa la regla');
  assert.strictEqual(j.descartadas.length, 2);
  assert.match(j.descartadas[0].motivo, /3 o más merges/);
  assert.match(j.descartadas[1].motivo, /2 o más stories/);
  assert.ok(!fs.readFileSync(path.join(out, 'guides', 'guide-update-proposals.md'), 'utf8').includes('revisión semanal'), 'nada escrito en la lista');
});

test('T4 Patron_Valido_Propuesta @story-1.27 @ac-3 @ac-4: tres merges de dos stories o más dan una propuesta con todos sus campos', () => {
  const s = semana();
  const out = maintainers();
  const ag = agent({ patrones: [patron(s.enSemana.slice(0, 3).map((sha) => ({ repo: 'acme-a', sha: sha.slice(0, 9) })))] });
  const r = review(['--out', out, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push'], { TYCON_WEEKLY_REVIEW_AGENT: ag.script });
  assert.strictEqual(r.code, 0, r.out);
  const j = informe(out);
  assert.strictEqual(j.propuestas.length, 1, JSON.stringify(j.descartadas));
  const p = j.propuestas[0];
  for (const k of ['patron', 'forma', 'texto', 'por_que']) assert.ok(typeof p[k] === 'string' && p[k], `trae ${k}`);
  assert.strictEqual(p.forma, 'prueba');
  assert.deepStrictEqual(p.stories.sort(), ['8.54', '8.55', '8.57'], 'las stories las cuenta la revisión, no el agente');
  assert.strictEqual(p.merges.length, 3);
  for (const m of p.merges) assert.match(m.sha, /^[0-9a-f]{40}$/, 'el sha se completa con el del merge leído');
});

test('T5 Propuesta_MergeQueNoExiste_Descartada @story-1.27 @ac-4: un merge inventado, o una forma que no es de las tres, la descartan', () => {
  const s = semana();
  const out = maintainers();
  const reales = s.enSemana.slice(0, 2).map((sha) => ({ repo: 'acme-a', sha }));
  const ag = agent({ patrones: [
    patron([...reales, { repo: 'acme-a', sha: 'deadbeefdeadbeef' }]),
    patron(s.enSemana.slice(0, 3).map((sha) => ({ repo: 'acme-a', sha })), { forma: 'refactor' }),
    patron([...reales, { repo: 'acme-a', sha: s.vieja }], { patron: 'con uno de fuera de la semana' }),
  ] });
  const r = review(['--out', out, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push'], { TYCON_WEEKLY_REVIEW_AGENT: ag.script });
  assert.strictEqual(r.code, 0, r.out);
  const j = informe(out);
  assert.strictEqual(j.propuestas.length, 0);
  assert.strictEqual(j.descartadas.length, 3);
  assert.match(j.descartadas[0].motivo, /no está entre los leídos/);
  assert.match(j.descartadas[1].motivo, /forma/);
  assert.match(j.descartadas[2].motivo, /no está entre los leídos/, 'un merge real pero que no se leyó tampoco cuenta');
});

test('T6 Destino_SoloLaListaDePropuestas @story-1.27 @ac-5: una propuesta válida va a la lista con fecha y marca; ningún otro archivo cambia', () => {
  const s = semana();
  const out = maintainers();
  const ag = agent({ patrones: [patron(s.enSemana.slice(0, 3).map((sha) => ({ repo: 'acme-a', sha })))] });
  const r = review(['--out', out, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push'], { TYCON_WEEKLY_REVIEW_AGENT: ag.script });
  assert.strictEqual(r.code, 0, r.out);
  const lista = fs.readFileSync(path.join(out, 'guides', 'guide-update-proposals.md'), 'utf8');
  assert.match(lista, /## Revisión semanal 2026-10-19 — el pase adversarial da todo limpio sin revisar — ⏳ PENDIENTE/);
  assert.match(lista, /\*\*Origen\*\*: revisión semanal/);
  assert.match(lista, /\*\*Forma\*\*: prueba/);
  assert.ok(lista.startsWith('# Guide Update Proposals\n\nPropuestas.\n'), 'lo que ya estaba no se toca');
  const cambios = git(out, ['status', '--porcelain', '--untracked-files=all']).split('\n').map((l) => l.replace(/^\s*\S+\s+/, '')).sort();
  assert.deepStrictEqual(cambios, ['.dashboard/weekly-review/latest.json', 'guides/guide-update-proposals.md']);
  // dos veces el mismo día: no se duplica
  const r2 = review(['--out', out, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push'], { TYCON_WEEKLY_REVIEW_AGENT: ag.script });
  assert.strictEqual(r2.code, 0, r2.out);
  assert.strictEqual(fs.readFileSync(path.join(out, 'guides', 'guide-update-proposals.md'), 'utf8').split('## Revisión semanal 2026-10-19').length, 2);
});

test('T7 SinRetros_LoDice @story-1.27 @ac-6: sin archivos de retro de la semana lo dice, no llama al agente y no propone', () => {
  const s = semana();
  const out = maintainers();
  const ag = agent({ patrones: [patron(s.enSemana.slice(0, 3).map((sha) => ({ repo: 'acme-a', sha })))] });
  const r = review(['--out', out, '--repo', `acme-a=${s.a.dir}`, '--no-push'], { TYCON_WEEKLY_REVIEW_AGENT: ag.script });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /no hay retros de la semana/);
  const j = informe(out);
  assert.strictEqual(j.estado, 'sin_retros');
  assert.strictEqual(j.propuestas.length, 0);
  assert.strictEqual(ag.calls().length, 0, 'sin retros no se gasta la corrida');
  // y sin agente: lo dice y sale distinto de 0 (no pudo mirar)
  const out2 = maintainers();
  const r2 = review(['--out', out2, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push'], { TYCON_WEEKLY_REVIEW_AGENT: path.join(tmp(), 'no-existe.js') });
  assert.notStrictEqual(r2.code, 0, r2.out);
  assert.strictEqual(informe(out2).estado, 'sin_agente');
  // una retro ilegible no es «no hay retros»: lo dice, no sella y sale distinto de 0
  const malo = repo([{ date: '2026-10-18T22:00:00', branch: 'chore/retros-rotas', files: { '.dashboard/retros/metrics-roto.json': '{ no es json' } }]);
  const out3 = maintainers();
  const stamp = path.join(tmp(), 'sello');
  const r3 = review(['--out', out3, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${malo.dir}`, '--no-push', '--stamp', stamp], { TYCON_WEEKLY_REVIEW_AGENT: ag.script });
  assert.notStrictEqual(r3.code, 0, r3.out);
  assert.strictEqual(informe(out3).estado, 'no_pudo');
  assert.match(informe(out3).motivo, /retro.*no se pudo leer|ilegible/);
  assert.ok(!fs.existsSync(stamp), 'no sella lo que no pudo leer');
  // un repo que no se pudo mirar: el informe y la salida lo dicen, y no sella
  const out4 = maintainers();
  const r4 = review(['--out', out4, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--repo', `acme-x=${path.join(tmp(), 'no-es-repo')}`, '--no-push', '--stamp', stamp], { TYCON_WEEKLY_REVIEW_AGENT: ag.script });
  assert.strictEqual(r4.code, 2, r4.out);
  assert.strictEqual(informe(out4).repos_sin_mirar, 1);
  assert.ok(!fs.existsSync(stamp));
  // ningún merge entra en el tope: no llama al agente y lo dice con su causa
  const out5 = maintainers();
  const ag5 = agent({ patrones: [] });
  const r5 = review(['--out', out5, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push', '--max-chars', '10'], { TYCON_WEEKLY_REVIEW_AGENT: ag5.script });
  assert.strictEqual(r5.code, 3, r5.out);
  assert.strictEqual(informe(out5).motivo_corto, 'tope_vacio');
  assert.strictEqual(ag5.calls().length, 0);
  // sin la lista de propuestas en el clon: lo dice y no llama al agente
  const out6 = tmp();
  const r6 = review(['--out', out6, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push'], { TYCON_WEEKLY_REVIEW_AGENT: ag5.script });
  assert.strictEqual(r6.code, 2, r6.out);
  assert.strictEqual(informe(out6).motivo_corto, 'sin_lista');
  assert.strictEqual(ag5.calls().length, 0);
});

test('T8 ResumenDeLaManana_LasPropuestas @story-1.27 @ac-7: el resumen cuenta las propuestas por forma, dice dónde se deciden y lleva la línea llana', () => {
  const d = tmp();
  for (const dia of ['2026-10-20', '2026-10-24', '2026-10-29']) fs.writeFileSync(path.join(d, `dependencias-${dia}.json`), '{}');
  fs.writeFileSync(path.join(d, 'ops.json'), '{}');
  const weekly = path.join(d, 'latest.json');
  fs.writeFileSync(weekly, JSON.stringify({ schema: 1, estado: 'hecho', hasta: '2026-10-19', linea_llana: 'el pase adversarial da todo limpio sin haber revisado',
    propuestas: [{ patron: 'p1', forma: 'prueba' }, { patron: 'p2', forma: 'regla' }], descartadas: [], merges_no_leidos: [] }));
  const run = (hoy) => spawnSync(process.execPath, [SUMMARY, 'deliver', '--source', 'dependencies', '--today', hoy, '--dry-run', '--out', d,
    '--pending', path.join(d, 'p'), '--operations', path.join(d, 'ops.json'), '--weekly', weekly], { env: env(), encoding: 'utf8' }).stdout;
  const texto = run('2026-10-20');
  const linea = texto.split('\n').find((l) => l.startsWith('revisión semanal:'));
  assert.ok(linea, texto);
  assert.match(linea, /2 propuestas/);
  assert.match(linea, /1 regla de revisor · 1 prueba · 0 línea de guía/);
  assert.match(linea, /lista de propuestas/);
  assert.match(linea, /lo más repetido: el pase adversarial da todo limpio sin haber revisado/);
  assert.ok(!run('2026-10-24').includes('revisión semanal:'), 'sólo la mañana siguiente: a los cinco días ya no sale');
  // la de hace más de 8 días se dice todos los días: la revisión dejó de correr
  assert.match(run('2026-10-29'), /revisión semanal: la última es de hace 10 días/);
  // cada estado que no es «hecho» dice el suyo, y lo que no se leyó o no se miró se cuenta
  const lineaCon = (j, hoy = '2026-10-20') => { fs.writeFileSync(weekly, JSON.stringify({ schema: 1, hasta: '2026-10-19', propuestas: [], merges_no_leidos: [], ...j })); return run(hoy).split('\n').find((l) => l.startsWith('revisión semanal:')) || ''; };
  assert.match(lineaCon({ estado: 'sin_retros' }), /no hay retros de la semana/);
  assert.match(lineaCon({ estado: 'sin_agente' }), /sin agente/);
  assert.match(lineaCon({ estado: 'respuesta_ilegible' }), /respuesta ilegible/);
  assert.match(lineaCon({ estado: 'no_pudo', motivo_corto: 'lista_sucia' }), /la lista de propuestas tiene cambios sin commitear/);
  assert.match(lineaCon({ estado: 'no_pudo', motivo_corto: 'retros_ilegibles' }), /retros que no se pudieron leer/);
  assert.match(lineaCon({ estado: 'no_pudo', motivo_corto: 'sin_lista' }), /no está la lista de propuestas/);
  assert.match(lineaCon({ estado: 'no_pudo', motivo_corto: 'tope_vacio' }), /ningún merge entró en el tope/);
  assert.match(lineaCon({ estado: 'hecho', propuestas: [{ patron: 'p', forma: 'regla' }], retros_ilegibles: ['a: 1 archivo(s) de retro no son JSON'] }), /1 lugar con retros ilegibles/);
  const h = lineaCon({ estado: 'hecho', propuestas: [{ patron: 'p', forma: 'guia' }], merges_no_leidos: [{}, {}], repos_sin_mirar: 1 });
  assert.match(h, /1 propuesta \(0 regla de revisor · 0 prueba · 1 línea de guía\)/);
  assert.match(h, /2 merges no entraron en el tope/);
  assert.match(h, /1 repo sin mirar/);
  // el --json del resumen trae el patrón y la forma de cada propuesta
  fs.writeFileSync(weekly, JSON.stringify({ schema: 1, estado: 'hecho', hasta: '2026-10-19', propuestas: [{ patron: 'p1', forma: 'prueba' }, { patron: 'p2', forma: 'regla' }], merges_no_leidos: [] }));
  const b = spawnSync(process.execPath, [SUMMARY, 'build', '--source', 'dependencies', '--today', '2026-10-20', '--json', '--out', d,
    '--pending', path.join(d, 'p'), '--weekly', weekly], { env: env(), encoding: 'utf8' });
  // la plantilla del nocturno le pasa el informe al resumen (la de operaciones tiene su copia en su repo)
  const plantilla = fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'dependency-audit.yml'), 'utf8');
  assert.match(plantilla, /SEM=\(--weekly "\$SEMF"\)/);
  assert.match(plantilla, /daily-summary\.js deliver [^\n]*\$\{SEM\[@\]\+"\$\{SEM\[@\]\}"\}/);
  const js = JSON.parse(b.stdout);
  assert.deepStrictEqual(js.revision_semanal.propuestas, [{ patron: 'p1', forma: 'prueba' }, { patron: 'p2', forma: 'regla' }], b.stdout.slice(0, 400));
});

test('T9 Guia_LaRevisionSemanal @story-1.27 @ac-8: «Mantener el arnés» dice cuándo corre, qué lee, la regla de patrón y cómo se decide', () => {
  const g = fs.readFileSync(GUIDE, 'utf8');
  const i = g.indexOf('La revisión de la semana');
  assert.ok(i >= 0, 'tiene la sección');
  const sec = g.slice(i, i + 4000);
  assert.match(sec, /una vez por semana/i);
  assert.match(sec, /3 o más merges de 2 o más stories/);
  assert.match(sec, /nunca aplica nada|no aplica nada/i);
  assert.match(sec, /guide-update-proposals\.md/);
  assert.match(sec, /TYCON_NO_WEEKLY_REVIEW/);
  assert.match(sec, /US\$ ?5/);
  assert.match(sec, /siete días/, 'qué lee: la semana');
  assert.match(sec, /findings\.json/, 'qué lee: los hallazgos');
  assert.match(sec, /retro/, 'qué lee: las retros');
  assert.match(sec, /martes y viernes/, 'cuándo corre');
});

test('T10 Disparador_UnaVezPorSemana @story-1.27 @ac-9: con --if-due corre sólo si pasaron 6 días, apagado no corre, y sella al terminar', () => {
  const s = semana();
  const out = maintainers();
  const ag = agent({ patrones: [] });
  const stamp = path.join(tmp(), 'sello');
  const base = ['--out', out, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push', '--if-due', '--stamp', stamp];
  const e = { TYCON_WEEKLY_REVIEW_AGENT: ag.script };
  fs.writeFileSync(stamp, '2026-10-16T02:30:00.000Z\n');
  let r = review(base, { ...e, TYCON_WEEKLY_REVIEW_NOW: '2026-10-20T02:00:00Z' });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /no le toca/);
  assert.strictEqual(ag.calls().length, 0);
  fs.writeFileSync(stamp, '2026-10-13T02:30:00.000Z\n');
  r = review(base, { ...e, TYCON_WEEKLY_REVIEW_NOW: '2026-10-20T02:00:00Z', TYCON_NO_WEEKLY_REVIEW: '1' });
  assert.match(r.out, /apagad/);
  assert.strictEqual(ag.calls().length, 0, 'apagado no corre');
  r = review(base, { ...e, TYCON_WEEKLY_REVIEW_NOW: '2026-10-20T02:00:00Z' });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(ag.calls().length, 1, 'a los 6 días y 23 h (martes a martes) le toca');
  assert.ok(fs.readFileSync(stamp, 'utf8').startsWith('2026-10-20'), 'el sello se escribe al terminar, con la hora de la corrida');
  // el disparador del examen la llama sólo en la máquina designada, y no con --dry-run ni --help
  const PE = require(path.join(ROOT, 'scripts', 'controls-bench', 'periodic-exam.js'));
  const llamadas = [];
  const correr = (argv, designada) => PE.revisionSemanal(argv, { designada, repo: out, spawn: (cmd, args) => { llamadas.push(args); return { status: 0 }; } });
  correr([], false); correr(['--dry-run'], true); correr(['--help'], true); correr([], true);
  assert.strictEqual(llamadas.length, 1);
  assert.ok(llamadas[0].includes('--if-due') && llamadas[0].includes(out), JSON.stringify(llamadas[0]));
  // si la revisión sale mal (no viajó, corte por tiempo), queda en el registro del disparador
  const dichos = [];
  PE.revisionSemanal([], { designada: true, repo: out, spawn: () => ({ status: 5 }), log: (x) => dichos.push(x) });
  PE.revisionSemanal([], { designada: true, repo: out, spawn: () => ({ status: null, signal: 'SIGTERM' }), log: (x) => dichos.push(x) });
  assert.match(dichos[0], /revisión de la semana salió 5/);
  assert.match(dichos[1], /no terminó.*SIGTERM/);
});

test('T11 Resumen_LineaLlanaSinNombres @story-1.27 @ac-7: la línea llana no pasa si nombra un repo, una regla, una ruta o una story', () => {
  const W = require(REVIEW);
  const nombres = { repos: ['acme-a', 'harness-maintainers'], personas: ['Lab Person'] };
  assert.strictEqual(W.lineaLlana('el pase adversarial da todo limpio sin revisar', nombres), 'el pase adversarial da todo limpio sin revisar');
  for (const malo of ['en acme-a se repite el falso verde', 'la regla TEST-C1 se waivea siempre', 'scripts/ci/x.js no mira el código',
    'las stories 8.54 y 8.55 lo repiten', 'lo dijo Lab Person tres veces', 'ver https://ejemplo.com', 'el servidor acme.visualstudio.com no responde', 'la validación falla siempre en api.interno.ejemplo', 'el sitio acme.com tarda', 'el portal.interno no contesta', 'falla en acme.corp']) {
    assert.strictEqual(W.lineaLlana(malo, nombres), null, malo);
  }
});

test('T12 Configuracion_DeLaOrganizacion @story-1.27 @ac-10: weekly_review de la organización apaga, fija el tope, y un valor mal escrito cae al de por defecto', () => {
  const TEAM = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
  const az = (repo) => ({ platform: 'azure', org: 'acme', project: 'p', repo });
  const team = (weekly) => JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'h' }, profile: az('perfil'), operations: az('ops'), weekly_review: weekly });
  // el lector: lo bueno pasa; lo mal escrito se marca en su sección y no invalida el archivo
  const bien = TEAM.parse(team({ enabled: true, budget_usd: 2.5, max_chars: 100000 }));
  assert.ok(bien.ok && !bien.sectionProblems, JSON.stringify(bien.problems));
  const mal = TEAM.parse(team({ enabled: 'si', budget_usd: 0, max_chars: 10, otra: 1 }));
  assert.ok(mal.ok, 'el archivo sigue valiendo');
  assert.deepStrictEqual(mal.sectionProblems.weekly_review.map((p) => p.path).sort(),
    ['weekly_review.budget_usd', 'weekly_review.enabled', 'weekly_review.max_chars', 'weekly_review.otra']);
  assert.strictEqual(mal.data.weekly_review, undefined, 'la sección con problemas no llega a quien la usa');
  // la revisión la usa
  const s = semana();
  const correr = (weekly) => {
    const f = path.join(tmp(), 'team-repos.json');
    fs.writeFileSync(f, team(weekly));
    const out = maintainers();
    const ag = agent({ patrones: [] });
    const r = review(['--out', out, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--org-config', f, '--no-push'],
      { TYCON_WEEKLY_REVIEW_AGENT: ag.script });
    return { r, calls: ag.calls(), out };
  };
  const apagada = correr({ enabled: false });
  assert.strictEqual(apagada.r.code, 0, apagada.r.out);
  assert.match(apagada.r.out, /apagada por la organización/);
  assert.strictEqual(apagada.calls.length, 0);
  const propia = correr({ budget_usd: 2.5, max_chars: 20000 });
  assert.strictEqual(propia.r.code, 0, propia.r.out);
  const j = informe(propia.out);
  assert.strictEqual(j.tope.budget_usd, 2.5);
  assert.strictEqual(j.tope.max_chars, 20000);
  assert.ok(j.tope.material_chars <= 20000);
  // sin --stamp el sello va al estado de la casa del proceso: el de la suite, nunca el de quien la corre
  const sellos = ['.tycon/state', '.claude/.tycon-pipeline'].map((d) => path.join(CASA, d, 'weekly-review-last-run'));
  assert.ok(sellos.some((f) => fs.existsSync(f)), `el sello quedó en la casa de la suite: ${sellos.join(' o ')}`);
  const malEscrita = correr({ budget_usd: -1 });
  assert.strictEqual(malEscrita.r.code, 0, malEscrita.r.out);
  assert.match(malEscrita.r.out, /weekly_review.*por defecto/);
  assert.strictEqual(informe(malEscrita.out).tope.budget_usd, 5);
  // --budget de la línea de comandos pisa el de la organización; uno que no es un monto frena antes de leer nada
  const outCli = maintainers();
  const rCli = review(['--out', outCli, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push', '--budget', '1.5'], { TYCON_WEEKLY_REVIEW_AGENT: agent({ patrones: [] }).script });
  assert.strictEqual(rCli.code, 0, rCli.out);
  assert.strictEqual(informe(outCli).tope.budget_usd, 1.5);
  const rMal = review(['--out', outCli, '--repo', `acme-a=${s.a.dir}`, '--no-push', '--budget', '0']);
  assert.strictEqual(rMal.code, 2);
  assert.match(rMal.out, /--budget pide un monto en dólares mayor que 0/);
});
