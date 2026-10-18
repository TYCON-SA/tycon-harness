'use strict';
// retro-sweep.test.js — el barrido de cada noche que deja el latido de cada merge a main sin archivo. Repos de juguete de
// verdad (git), el latido real (retro-heartbeat.js) y, donde hace falta, uno inyectado que falla.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SWEEP = path.join(ROOT, 'scripts', 'metrics', 'retro-sweep.js');
const GUIDE = path.join(ROOT, 'guides', 'maintaining', 'mantener-el-arnes.md');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-sweep-')); dirs.push(d); return d; };

function env(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|TYCON_|BUILD_|SYSTEM_|TF_BUILD)/.test(k)) e[k] = v;
  return { ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'retro-sweep-no-global'),
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
    TYCON_TODAY: '2026-10-18', ...extra };
}
function git(dir, args, extra = {}) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args], { env: env(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
/** Un repo con main y, por cada entrada, un merge (o un commit directo) en main. Devuelve { dir, shas }. */
function repo(entries) {
  const dir = tmp();
  git(dir, ['init', '--quiet', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '-m', 'base'], { GIT_AUTHOR_DATE: '2026-10-01T10:00:00', GIT_COMMITTER_DATE: '2026-10-01T10:00:00' });
  const shas = [];
  entries.forEach((e, i) => {
    const date = `2026-10-${String(10 + i).padStart(2, '0')}T10:00:00`;
    const who = e.author ? { GIT_AUTHOR_NAME: e.author, GIT_COMMITTER_NAME: e.author } : {};
    const dates = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    if (e.direct) {
      fs.writeFileSync(path.join(dir, `d${i}.txt`), `${i}\n`);
      git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '-m', e.subject], { ...who, ...dates });
    } else {
      git(dir, ['checkout', '--quiet', '-b', `r${i}`]);
      fs.writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`);
      git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '-m', `trabajo ${i}`], dates);
      git(dir, ['checkout', '--quiet', 'main']);
      git(dir, ['merge', '--quiet', '--no-ff', `r${i}`, '-m', e.subject], { ...who, ...dates });
    }
    shas.push(git(dir, ['rev-parse', 'HEAD']));
  });
  return { dir, shas };
}
function sweep(args, extra = {}) {
  const r = spawnSync(process.execPath, [SWEEP, ...args], { env: env(extra), encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort() : []);
const report = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
/** Un archivo de métricas que cubre `sha` en `repoDir`, con quién lo generó. */
function metrics(dir, repoDir, sha, generatedBy) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `metrics-x-${sha.slice(0, 7)}.json`),
    JSON.stringify({ schema_version: '2.0', repo: repoDir, merge_commit: sha, generated_by: generatedBy, metrics: {} }));
}

test('T1 Barrido_MergeSinArchivo_CorreElLatido @story-1.26 @ac-1: corre el latido de los dos merges que faltan', () => {
  const { dir, shas } = repo([{ subject: 'Merge branch r0' }, { subject: 'Merge branch r1' }, { subject: 'Merge branch r2' }]);
  const out = path.join(tmp(), 'retros');
  metrics(out, dir, shas[0], 'tycon-retrospective-capturer');
  const rep = path.join(tmp(), 'barrido.json');
  const r = sweep(['--repo', `juguete=${dir}`, '--out', out, '--since', '2026-10-05', '--report', rep]);
  assert.strictEqual(r.code, 0, r.out);
  const j = report(rep).repos[0];
  assert.strictEqual(j.nombre, 'juguete');
  assert.strictEqual(j.merges, 3);
  assert.strictEqual(j.aprendizajes, 1, 'el que ya tenía su archivo cuenta como retro con aprendizajes');
  assert.strictEqual(j.latido, 2, 'los dos que faltaban, con su latido');
  assert.deepStrictEqual(j.faltan, []);
  const written = files(out).filter((f) => !f.startsWith('metrics-x-'));
  assert.strictEqual(written.length, 2, `dos archivos nuevos: ${written}`);
  for (const sha of shas.slice(1)) assert.ok(written.some((f) => f.endsWith(`-${sha.slice(0, 7)}.json`)), `latido de ${sha}`);
});

test('T2 Barrido_DosVeces_NoDuplica @story-1.26 @ac-2: la segunda corrida no corre latidos ni escribe archivos', () => {
  const { dir } = repo([{ subject: 'Merge branch r0' }, { subject: 'Merge branch r1' }]);
  const out = path.join(tmp(), 'retros');
  const rep = path.join(tmp(), 'barrido.json');
  assert.strictEqual(sweep(['--repo', `juguete=${dir}`, '--out', out, '--since', '2026-10-05', '--report', rep]).code, 0);
  const before = files(out);
  assert.strictEqual(before.length, 2);
  const r = sweep(['--repo', `juguete=${dir}`, '--out', out, '--since', '2026-10-05', '--report', rep]);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(files(out), before, 'cero archivos nuevos');
  const j = report(rep).repos[0];
  assert.strictEqual(j.latido, 2, 'siguen cubiertos por su latido');
  assert.strictEqual(j.latidos_corridos, 0, 'cero latidos nuevos');
});

test('T3 Barrido_MergeDePlataforma_CuentaIgual @story-1.26 @ac-1: un pedido de GitHub y uno de Azure, los dos cubiertos', () => {
  const { dir, shas } = repo([
    { subject: 'Merge pull request #226 from acme/fix/algo' },
    // la forma de un pedido de Azure DevOps; el número se arma aparte (escrito entero parece un pedido de verdad)
    { subject: `Merge pull request ${40 + 2} from docs/propuesta into main`, author: 'Project Collection Build Service (acme)' },
    { subject: 'feat: un pedido entrado con squash (#227)', direct: true },
  ]);
  const out = path.join(tmp(), 'retros');
  const rep = path.join(tmp(), 'barrido.json');
  const r = sweep(['--repo', `juguete=${dir}`, '--out', out, '--since', '2026-10-05', '--report', rep]);
  assert.strictEqual(r.code, 0, r.out);
  const j = report(rep).repos[0];
  assert.strictEqual(j.merges, 3);
  assert.strictEqual(j.latido, 3, 'los tres, aunque nadie hizo push desde una máquina');
  for (const sha of shas) assert.ok(files(out).some((f) => f.endsWith(`-${sha.slice(0, 7)}.json`)), `cubierto ${sha}`);
});

test('T4 Barrido_ListaDeclarada_ConMotivo @story-1.26 @ac-3: la versión y el nocturno no piden retro, con su motivo; el común, latido', () => {
  const { dir, shas } = repo([
    { subject: 'chore: bump version to 2026.10.18.3 [skip ci]', direct: true, author: 'Azure Pipelines' },
    { subject: 'chore(dependencias): revisión nocturna 2026-10-12 [nocturno]', direct: true, author: 'Azure Pipelines' },
    { subject: 'Merge branch r2' },
  ]);
  const out = path.join(tmp(), 'retros');
  const rep = path.join(tmp(), 'barrido.json');
  const r = sweep(['--repo', `juguete=${dir}`, '--out', out, '--since', '2026-10-05', '--report', rep]);
  assert.strictEqual(r.code, 0, r.out);
  const j = report(rep).repos[0];
  assert.strictEqual(j.merges, 3);
  assert.deepStrictEqual(j.no_piden, { 'subida de versión': 1, 'proceso nocturno': 1 });
  assert.strictEqual(j.latido, 1);
  assert.deepStrictEqual(files(out).map((f) => f.slice(-12, -5)), [shas[2].slice(0, 7)], 'sólo el común tiene latido');
  // la lista vive declarada, cada entrada con su motivo
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'metrics', 'retro-sweep.json'), 'utf8'));
  assert.ok(Array.isArray(cfg.no_piden_retro) && cfg.no_piden_retro.length >= 2);
  for (const e of cfg.no_piden_retro) assert.ok(typeof e.motivo === 'string' && e.motivo, 'cada entrada con su motivo');
});

test('T5 Barrido_RepoQueNoSeBaja_LoDice @story-1.26 @ac-4: sale distinto de cero con «no pude mirar»; el otro repo, cubierto', () => {
  const { dir } = repo([{ subject: 'Merge branch r0' }]);
  const out = path.join(tmp(), 'retros');
  const rep = path.join(tmp(), 'barrido.json');
  const gone = path.join(tmp(), 'no-existe.git');
  const r = sweep(['--repo', `juguete=${dir}`, '--repo', `perdido=${gone}`, '--clone-dir',tmp(), '--out', out, '--since', '2026-10-05', '--report', rep]);
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.out, /no pude mirar: perdido/);
  const j = report(rep);
  const lost = j.repos.find((x) => x.nombre === 'perdido');
  assert.strictEqual(lost.mirado, false);
  assert.ok(lost.motivo, 'con su motivo');
  const ok = j.repos.find((x) => x.nombre === 'juguete');
  assert.strictEqual(ok.latido, 1, 'el otro repo quedó cubierto igual');
});

test('T6 Barrido_LatidoQueFalla_NoCuentaCubierto @story-1.26 @ac-4: queda en «faltan», con el motivo, y no es «no pude mirar»', () => {
  const { dir, shas } = repo([{ subject: 'Merge branch r0' }]);
  const out = path.join(tmp(), 'retros');
  const rep = path.join(tmp(), 'barrido.json');
  const broken = path.join(tmp(), 'latido-roto.js');
  fs.writeFileSync(broken, "process.stderr.write('el validador rechazó el archivo\\n'); process.exit(2);\n");
  const r = sweep(['--repo', `juguete=${dir}`, '--out', out, '--since', '2026-10-05', '--report', rep], { TYCON_RETRO_SWEEP_HEARTBEAT: broken });
  assert.strictEqual(r.code, 0, `un latido que falla no es «no pude mirar»: ${r.out}`);
  const j = report(rep).repos[0];
  assert.strictEqual(j.latido, 0);
  assert.strictEqual(j.faltan.length, 1);
  assert.strictEqual(j.faltan[0].sha, shas[0]);
  assert.match(j.faltan[0].motivo, /el latido falló/);
  assert.deepStrictEqual(files(out), [], 'nada escrito');
});

test('T10 Guia_DiceQueHaceLaNocheConLasRetros @story-1.26 @ac-7: nombra el barrido, el comando a mano y que no corre la retro con modelo', () => {
  const g = fs.readFileSync(GUIDE, 'utf8');
  const i = g.indexOf('retro-sweep.js');
  assert.ok(i >= 0, 'la guía nombra retro-sweep.js');
  const sec = g.slice(Math.max(0, g.lastIndexOf('\n#', i)), g.indexOf('\n#', i + 1) > 0 ? g.indexOf('\n#', i + 1) : undefined);
  assert.match(sec, /node scripts\/metrics\/retro-sweep\.js /, 'el comando a mano');
  assert.match(sec, /latido/);
  assert.match(sec, /no corre la retro con modelo/i);
});

// ── los bordes: fechas, lo ya guardado, la lista de repos, lo que no se puede leer ─────────────────────────────────────
test('T11 Barrido_DesdeElUltimoInformeQueMiroEseRepo @story-1.26 @ac-1: un repo que una noche no se miró no pierde sus merges', () => {
  const { dir } = repo([{ subject: 'Merge branch r0' }, { subject: 'Merge branch r1' }]);
  const out = path.join(tmp(), 'retros');
  const reports = tmp();
  // la noche anterior miró «otro» hasta el 16 y NO miró «juguete»
  fs.writeFileSync(path.join(reports, 'retro-sweep-2026-10-16.json'), JSON.stringify({ hasta: '2026-10-16',
    repos: [{ nombre: 'otro', mirado: true, hasta: '2026-10-16' }, { nombre: 'juguete', mirado: false }] }));
  const rep = path.join(reports, 'retro-sweep-2026-10-18.json');
  const r = sweep(['--repo', `juguete=${dir}`, '--out', out, '--report', rep], { TYCON_TODAY: '2026-10-17' });
  assert.strictEqual(r.code, 0, r.out);
  const j = report(rep).repos[0];
  assert.strictEqual(j.desde, '2026-10-10', 'sin un informe que lo haya mirado: los 7 días de siempre');
  assert.strictEqual(j.merges, 2);
  // con un informe que sí lo miró, arranca un día antes de ese `hasta`
  fs.writeFileSync(path.join(reports, 'retro-sweep-2026-10-17.json'), JSON.stringify({ hasta: '2026-10-17', repos: [{ nombre: 'juguete', mirado: true, hasta: '2026-10-17' }] }));
  assert.strictEqual(sweep(['--repo', `juguete=${dir}`, '--out', out, '--report', rep], { TYCON_TODAY: '2026-10-18' }).code, 0);
  assert.strictEqual(report(rep).repos[0].desde, '2026-10-16');
});

test('T18 Barrido_LatidoFallido_SeReintenta @story-1.26 @ac-4: un merge que quedó en «faltan» se vuelve a barrer, aunque sea viejo', () => {
  const { dir, shas } = repo([{ subject: 'Merge branch r0' }, { subject: 'Merge branch r1' }]);
  const reports = tmp();
  fs.writeFileSync(path.join(reports, 'retro-sweep-2026-10-17.json'), JSON.stringify({ hasta: '2026-10-17',
    repos: [{ nombre: 'juguete', mirado: true, hasta: '2026-10-17', faltan: [{ sha: shas[0], fecha: '2026-10-10', motivo: 'el latido falló' }] }] }));
  const rep = path.join(reports, 'retro-sweep-2026-10-18.json');
  const out = path.join(tmp(), 'retros');
  const r = sweep(['--repo', `juguete=${dir}`, '--out', out, '--report', rep], { TYCON_TODAY: '2026-10-18' });
  assert.strictEqual(r.code, 0, r.out);
  const j = report(rep).repos[0];
  assert.strictEqual(j.desde, '2026-10-10', 'desde el merge que faltaba, no desde el último informe');
  assert.ok(files(out).some((f) => f.endsWith(`-${shas[0].slice(0, 7)}.json`)), 'el que faltaba tiene ahora su latido');
  // y lo que falta guarda su fecha, para la próxima noche
  const broken = path.join(tmp(), 'latido-roto.js');
  fs.writeFileSync(broken, 'process.exit(2);\n');
  const { dir: d2 } = repo([{ subject: 'Merge branch r0' }]);
  const rep2 = path.join(tmp(), 'b.json');
  sweep(['--repo', `otro=${d2}`, '--out', path.join(tmp(), 'o'), '--since', '2026-10-05', '--report', rep2], { TYCON_RETRO_SWEEP_HEARTBEAT: broken });
  assert.strictEqual(report(rep2).repos[0].faltan[0].fecha, '2026-10-10');
});

test('T19 Barrido_UsoMal_Sale2ConMotivo @story-1.26 @ac-4: fecha mal escrita, --repo sin «=», opción desconocida, valor ausente; e informes anteriores ilegibles se dicen', () => {
  for (const [argv, re] of [[['--out', 'x', '--since', '18-10-2026'], /--since pide/], [['--out', 'x', '--repo', 'juguete'], /--repo pide/],
    [['--out', 'x', '--bogus'], /opción desconocida/], [['--out'], /pide un valor|falta --out/], [['--repo', 'a=b'], /falta --out/]]) {
    const r = sweep(argv);
    assert.strictEqual(r.code, 2, `${argv.join(' ')}: ${r.out}`);
    assert.match(r.out, re);
  }
  const { dir } = repo([{ subject: 'Merge branch r0' }]);
  const reports = tmp();
  fs.writeFileSync(path.join(reports, 'retro-sweep-2026-10-16.json'), '{ roto');
  const rep = path.join(reports, 'retro-sweep-2026-10-18.json');
  const r = sweep(['--repo', `juguete=${dir}`, '--out', path.join(tmp(), 'o'), '--report', rep], { TYCON_TODAY: '2026-10-18' });
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(report(rep).informes_ilegibles, ['retro-sweep-2026-10-16.json']);
  assert.match(r.out, /informe.* ilegible/);
});

test('T12 Barrido_LoGuardadoEnGit_CuentaCubierto @story-1.26 @ac-2: un archivo en .dashboard/ (o una subcarpeta) de main cubre el merge sin correr el latido', () => {
  const { dir, shas } = repo([{ subject: 'Merge branch r0' }, { subject: 'Merge branch r1' }]);
  // otra máquina guardó en main: un latido en .dashboard/retros/ y una retro con aprendizajes en .dashboard/
  fs.mkdirSync(path.join(dir, '.dashboard', 'retros'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.dashboard', 'retros', 'metrics-a.json'), JSON.stringify({ repo: '/otra/maquina/juguete', merge_commit: shas[0], generated_by: ['retro', 'latido.js'].join('-') }));
  fs.writeFileSync(path.join(dir, '.dashboard', 'metrics-b.json'), JSON.stringify({ repo: '/otra/maquina/juguete', merge_commit: shas[1], generated_by: 'tycon-retrospective-capturer' }));
  git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '-m', 'chore(metricas): guardar [nocturno]'], { GIT_AUTHOR_NAME: 'Azure Pipelines', GIT_COMMITTER_NAME: 'Azure Pipelines' });
  const out = path.join(tmp(), 'retros');
  const rep = path.join(tmp(), 'barrido.json');
  const r = sweep(['--repo', `juguete=${dir}`, '--out', out, '--since', '2026-10-05', '--report', rep]);
  assert.strictEqual(r.code, 0, r.out);
  const j = report(rep).repos[0];
  assert.strictEqual(j.latidos_corridos, 0, 'nada se volvió a correr');
  assert.strictEqual(j.latido, 1);
  assert.strictEqual(j.aprendizajes, 1);
  assert.deepStrictEqual(j.no_piden, { 'proceso nocturno': 1 });
});

test('T13 Barrido_ReposDeTeamRepos @story-1.26 @ac-1: public, maintainers y operations, con su url; un archivo roto frena con su motivo', () => {
  const f = path.join(tmp(), 'team-repos.json');
  fs.writeFileSync(f, JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' },
    profile: { platform: 'github', org: 'acme', repo: 'profile' }, operations: { platform: 'azure', org: 'acme', project: 'Harness', repo: 'operations' },
    maintainers: { platform: 'azure', org: 'acme', project: 'Harness', repo: 'maintainers' } }));
  const { teamRepos } = require(SWEEP);
  assert.deepStrictEqual(teamRepos(f), [
    { nombre: 'harness', fuente: 'https://github.com/acme/harness' },
    { nombre: 'maintainers', fuente: 'https://dev.azure.com/acme/Harness/_git/maintainers' },
    { nombre: 'operations', fuente: 'https://dev.azure.com/acme/Harness/_git/operations' },
  ]);
  fs.writeFileSync(f, '{ roto');
  const r = sweep(['--team-repos', f, '--out', tmp()]);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /team-repos\.json/);
});

test('T14 Barrido_CoveredInYShaCompleto @story-1.26 @ac-2: una carpeta de --covered-in, y un archivo con el sha completo aunque nombre otra ruta', () => {
  const { dir, shas } = repo([{ subject: 'Merge branch r0' }, { subject: 'Merge branch r1' }]);
  const extra = tmp();
  metrics(extra, dir, shas[0].slice(0, 9), 'tycon-retrospective-capturer');
  metrics(extra, '/otra/maquina/juguete', shas[1], ['retro', 'latido.js'].join('-'));
  const rep = path.join(tmp(), 'barrido.json');
  const r = sweep(['--repo', `juguete=${dir}`, '--out', path.join(tmp(), 'retros'), '--covered-in', extra, '--since', '2026-10-05', '--report', rep]);
  assert.strictEqual(r.code, 0, r.out);
  const j = report(rep).repos[0];
  assert.strictEqual(j.latidos_corridos, 0);
  assert.strictEqual(j.aprendizajes, 1, 'sha corto + misma ruta');
  assert.strictEqual(j.latido, 1, 'sha completo, otra ruta');
});

test('T15 Barrido_MetricaNull_NoMiradoConMotivo @story-1.26 @ac-4: un archivo `null` no aborta el barrido en silencio', () => {
  const { dir } = repo([{ subject: 'Merge branch r0' }]);
  const out = path.join(tmp(), 'retros');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'metrics-roto.json'), 'null');
  const rep = path.join(tmp(), 'barrido.json');
  const r = sweep(['--repo', `juguete=${dir}`, '--out', out, '--since', '2026-10-05', '--report', rep]);
  assert.strictEqual(r.code, 2, r.out);
  const j = report(rep).repos[0];
  assert.strictEqual(j.mirado, false);
  assert.match(j.motivo, /metrics-roto\.json|null/);
});

test('T16 Barrido_MotivosSinCredencialNiRutas @story-1.26 @ac-4: el informe que se guarda no lleva tokens ni rutas de la máquina', () => {
  const { dir } = repo([{ subject: 'Merge branch r0' }]);
  const broken = path.join(tmp(), 'latido-roto.js');
  fs.writeFileSync(broken, "process.stderr.write('falló con bearer abc123secreto en /srv/alguien/privado/x.json\\n'); process.exit(2);\n");
  const rep = path.join(tmp(), 'barrido.json');
  const r = sweep(['--repo', `juguete=${dir}`, '--out', path.join(tmp(), 'retros'), '--since', '2026-10-05', '--report', rep], { TYCON_RETRO_SWEEP_HEARTBEAT: broken });
  assert.strictEqual(r.code, 0, r.out);
  const text = fs.readFileSync(rep, 'utf8') + r.out;
  assert.doesNotMatch(text, /abc123secreto/);
  assert.doesNotMatch(text, /\/srv\/alguien/);
  assert.match(report(rep).repos[0].faltan[0].motivo, /el latido falló/);
});

test('T16b Barrido_Clean_RutasDeTodaForma @story-1.26 @ac-4: rutas absolutas, de la casa y relativas no viajan', () => {
  const { clean } = require(SWEEP);
  const t = clean('falló en /srv/x/a.json, ~/privado/b, ../otro/c y C:\\\\dev\\\\d con bearer abc');
  for (const bad of ['/srv/x', '~/privado', '../otro', 'C:\\\\dev', 'abc']) assert.ok(!t.includes(bad), `${bad} en «${t}»`);
  // una ruta de Windows con una sola barra y una url con credencial
  // la url se arma por partes: escrita entera tiene forma de dirección de correo
  const w = clean(`no se pudo bajar C:\\dev\\repo ni https://usuario:tok123${'@'}git.example/acme/_git/x`);
  for (const bad of ['C:\\dev', 'tok123', 'usuario']) assert.ok(!w.includes(bad), `${bad} en «${w}»`);
});

test('T16c Barrido_LatidoQueNoArranca_DiceLaCausa @story-1.26 @ac-4: un latido que no se pudo lanzar no queda como «código null»', () => {
  const { dir } = repo([{ subject: 'Merge branch r0' }]);
  const rep = path.join(tmp(), 'b.json');
  const r = sweep(['--repo', `juguete=${dir}`, '--out', path.join(tmp(), 'o'), '--since', '2026-10-05', '--report', rep], { TYCON_RETRO_SWEEP_HEARTBEAT: path.join(tmp(), 'no-existe.js') });
  assert.strictEqual(r.code, 0, r.out);
  assert.doesNotMatch(report(rep).repos[0].faltan[0].motivo, /código null/);
});

test('T12b Barrido_GuardadoIlegible_LoDice @story-1.26 @ac-4: un archivo de .dashboard/ de main que no se lee queda dicho en el informe', () => {
  const { dir } = repo([{ subject: 'Merge branch r0' }]);
  fs.mkdirSync(path.join(dir, '.dashboard'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.dashboard', 'metrics-roto.json'), '{ roto');
  git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '-m', 'chore(metricas): guardar [nocturno]'], { GIT_AUTHOR_NAME: 'Azure Pipelines', GIT_COMMITTER_NAME: 'Azure Pipelines' });
  const rep = path.join(tmp(), 'b.json');
  const r = sweep(['--repo', `juguete=${dir}`, '--out', path.join(tmp(), 'o'), '--since', '2026-10-05', '--report', rep]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(report(rep).repos[0].guardado_sin_leer, /1 archivo/);
  assert.match(r.out, /juguete: .*1 archivo/);
});

test('T20 Barrido_RepoPorUrl_ClonaYDespuesTrae @story-1.26 @ac-1: el camino de la noche — clona la url sin checkout, corre el latido sobre el clon, y la noche siguiente trae lo nuevo', () => {
  const { dir, shas } = repo([{ subject: 'Merge branch r0' }]);
  const clones = tmp();
  const out = path.join(tmp(), 'retros');
  const rep = path.join(tmp(), 'b.json');
  const url = `file://${dir}`;
  let r = sweep(['--repo', `juguete=${url}`, '--clone-dir',clones, '--out', out, '--since', '2026-10-05', '--report', rep]);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(report(rep).repos[0].latido, 1);
  assert.ok(fs.existsSync(path.join(clones, 'juguete', '.git')), 'el clon queda para la próxima');
  // un merge nuevo en el origen: la segunda corrida hace fetch sobre el clon y lo cubre
  git(dir, ['checkout', '--quiet', '-b', 'r9']);
  fs.writeFileSync(path.join(dir, 'f9.txt'), '9\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '-m', 'trabajo 9']);
  git(dir, ['checkout', '--quiet', 'main']); git(dir, ['merge', '--quiet', '--no-ff', 'r9', '-m', 'Merge branch r9']);
  const nuevo = git(dir, ['rev-parse', 'HEAD']);
  r = sweep(['--repo', `juguete=${url}`, '--clone-dir',clones, '--out', out, '--since', '2026-10-05', '--report', rep]);
  assert.strictEqual(r.code, 0, r.out);
  const j = report(rep).repos[0];
  assert.strictEqual(j.merges, 2);
  assert.strictEqual(j.latidos_corridos, 1, 'sólo el nuevo');
  for (const sha of [shas[0], nuevo]) assert.ok(files(out).some((f) => f.endsWith(`-${sha.slice(0, 7)}.json`)), `cubierto ${sha}`);
});

test('T17 Cobertura_LaRegla @story-1.26 @ac-1: ruta absoluta, sufijo relativo, sha corto en los dos sentidos, y quién lo escribió', () => {
  const RC = require(path.join(ROOT, 'scripts', 'lib', 'retro-coverage.js'));
  const d = tmp();
  const sub = path.join(d, 'Producto', 'Backend');
  fs.mkdirSync(sub, { recursive: true });
  assert.ok(RC.sameRepo({ repoStr: sub }, sub));
  assert.ok(RC.sameRepo({ repoStr: 'Producto/Backend' }, sub));
  assert.ok(!RC.sameRepo({ repoStr: 'Backend2' }, sub));
  assert.ok(!RC.sameRepo({ repoStr: 'ducto/Backend' }, sub), 'el sufijo corta en separador');
  assert.ok(RC.sameSha('abcdef1', 'abcdef1234') && RC.sameSha('abcdef1234', 'abcdef1') && !RC.sameSha('abcdef2', 'abcdef1234'));
  assert.strictEqual(RC.kindOf({ generatedBy: ['retro', 'latido.js'].join('-') }), 'latido');
  assert.strictEqual(RC.kindOf({ generatedBy: null }), 'aprendizajes');
  fs.writeFileSync(path.join(d, 'm.json'), 'null');
  assert.throws(() => RC.coveringRecords({ repoPath: sub, sha: 'abc' }, [d]), /metrics null/);
});
