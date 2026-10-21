'use strict';
// Cuántos cambios de código llegan a main sin nombrar su historia. Repos de juguete con git de verdad, sin red.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const GUION = path.join(RAIZ, 'scripts', 'metrics', 'story-reference.js');
const sr = () => require(GUION);
const HOY = '2026-10-20';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const limpiar = [];
test.after(() => { for (const d of limpiar) fs.rmSync(d, { recursive: true, force: true }); });

/** Un repo de juguete con su `main`. `git(args, {autor, fecha})` commitea con autor y fecha fijos. */
function repo() {
  const dir = tmp('sr-repo-');
  limpiar.push(dir);
  const env = (autor, fecha) => ({ ...process.env, GIT_AUTHOR_NAME: autor, GIT_AUTHOR_EMAIL: `${autor.toLowerCase().replace(/\s+/g, '-')}@ej.test`,
    GIT_COMMITTER_NAME: autor, GIT_COMMITTER_EMAIL: `${autor.toLowerCase().replace(/\s+/g, '-')}@ej.test`,
    GIT_AUTHOR_DATE: `${fecha}T12:00:00Z`, GIT_COMMITTER_DATE: `${fecha}T12:00:00Z`, GIT_CONFIG_NOSYSTEM: '1', HOME: dir });
  const git = (args, { autor = 'Ana Uno', fecha = HOY } = {}) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'commit.gpgsign=false', '-C', dir, ...args], { encoding: 'utf8', env: env(autor, fecha) });
  git(['init', '-q', '-b', 'main']);
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), txt); };
  /** Un commit que toca `archivos` con el título `asunto` (y el cuerpo `cuerpo`). */
  const commit = (asunto, archivos = ['src/a.js'], o = {}) => {
    for (const a of archivos) escribir(a, `${asunto} ${Math.random()}\n`);
    git(['add', '-A'], o);
    git(['commit', '-q', '-m', asunto, ...(o.cuerpo ? ['-m', o.cuerpo] : [])], o);
  };
  /** Un merge a main desde la rama `rama`, con los commits `traidos` ([asunto, autor]). */
  const merge = (rama, titulo, traidos, o = {}) => {
    git(['checkout', '-q', '-b', rama], o);
    for (const [asunto, autor, archivos] of traidos) commit(asunto, archivos || ['src/b.js'], { ...o, autor });
    git(['checkout', '-q', 'main'], o);
    git(['merge', '-q', '--no-ff', '-m', titulo, rama], o);
  };
  commit('inicio', ['README.md'], { fecha: '2026-01-01' });
  return { dir, git, commit, merge };
}

test('T1 Nombra_LasFormasDeD3_YNoElCuerpoNiUnaVersion @story-1.31 @ac-1', () => {
  const { nombra } = sr();
  for (const t of ['feat: story 12.1 el alta', 'Historia 2.3: el cierre', 'Merge pull request 41 from story/9-1-1-algo into main',
    'Merge pull request 7 from feature/2.14-tablero into main', 'fix/3.2-el-borde', 'docs(5.9): la guía', 'arreglo (GE-1)', 'GE-3 el mensaje']) {
    assert.ok(nombra(t), `«${t}» nombra una historia`);
  }
  for (const t of ['chore: bump a (4.1.2)', 'Merge pull request 51 from dev into main', 'arreglo del login', 'UTF-8 en el csv', 'CVE-2026 parche']) {
    assert.ok(!nombra(t), `«${t}» no nombra una historia`);
  }
  // el cuerpo no cuenta: una historia se cita de pasada
  const r = repo();
  r.commit('arreglo del login', ['src/login.js'], { cuerpo: 'relacionado con la story 4.4' });
  const e = sr().entradasDe(r.dir, { today: HOY }).filter((x) => x.asunto === 'arreglo del login');
  assert.strictEqual(e.length, 1);
  assert.strictEqual(sr().clasificar(e[0]).nombra, false, 'el cuerpo del commit no cuenta');
});

test('T2 Nombra_MergeDeDevConCommitsQueNombran_Cuenta @story-1.31 @ac-1', () => {
  const r = repo();
  r.merge('dev', 'Merge pull request 88 from dev into main', [['feat(4.2): el filtro', 'Ana Uno'], ['ajuste', 'Ana Uno']]);
  r.merge('dev2', 'Merge pull request 89 from dev2 into main', [['ajuste sin número', 'Ana Uno']]);
  const c = sr().entradasDe(r.dir, { today: HOY }).map((x) => [x.asunto, sr().clasificar(x).nombra]);
  assert.deepStrictEqual(Object.fromEntries(c.filter(([a]) => a.startsWith('Merge'))),
    { 'Merge pull request 88 from dev into main': true, 'Merge pull request 89 from dev2 into main': false });
});

test('T3 Tipo_HotfixDependenciasArnesMergeYOtro @story-1.31 @ac-1', () => {
  const { tipo } = sr();
  assert.strictEqual(tipo('arreglo del login', 'fix/login'), 'hotfix');
  assert.strictEqual(tipo('hotfix: el cálculo', null), 'hotfix');
  assert.strictEqual(tipo('corrección del total', null), 'hotfix');
  assert.strictEqual(tipo('deuda: renovar paquetes', null), 'dependencias');
  assert.strictEqual(tipo('sube imagesharp a 3.1.12', null), 'dependencias');
  assert.strictEqual(tipo('ci: el pipeline de staging', null), 'arnes_ci');
  assert.strictEqual(tipo('actualiza el CLAUDE.md del arnés', null), 'arnes_ci');
  assert.strictEqual(tipo('Merge pull request 5 from dev into main', 'dev'), 'merge_dev');
  assert.strictEqual(tipo('agrega el campo nuevo', 'cambios-varios'), 'otro');
  assert.deepStrictEqual([...sr().TIPOS], ['hotfix', 'dependencias', 'arnes_ci', 'merge_dev', 'otro']);
});

test('T4 NoCuenta_SoloDocumentalYAumentoDeVersion @story-1.31 @ac-2', () => {
  const r = repo();
  r.commit('docs: la guía', ['README.md', 'specs/story-1.md', 'docs/x.txt', '.advisors/a.json', '.engram/m.json', '.tycon/c.yaml', 'tasks/t.md']);
  r.commit('chore: bump version to 1.2.3 [skip ci]', ['package.json']);
  r.commit('agrega el campo', ['src/campo.js']);
  const cuenta = sr().entradasDe(r.dir, { today: HOY }).map(sr().clasificar).filter((c) => c.cuenta);
  assert.deepStrictEqual(cuenta.map((c) => c.asunto), ['agrega el campo']);
});

test('T5 Persona_ElAutorMasFrecuenteDelMerge @story-1.31 @ac-3', () => {
  const r = repo();
  r.merge('feature/x', 'Merge pull request 3 from feature/x into main',
    [['uno', 'Ana Uno'], ['dos', 'Ana Uno'], ['tres', 'Beto Dos'], ['chore: bump [skip ci]', 'Azure Pipelines'], ['cuatro [skip ci]', 'Azure Pipelines']], { autor: 'Ceci Merge' });
  r.commit('directo a main', ['src/d.js'], { autor: 'Dani Tres' });
  const conteo = sr().contarRepo(r.dir, { today: HOY });
  assert.strictEqual(conteo.estado, 'medido');
  assert.deepStrictEqual(Object.keys(conteo.por_persona).sort(), ['Ana Uno', 'Dani Tres']);
  assert.ok(!JSON.stringify(conteo).includes('@ej.test'), 'ningún correo en la cuenta');
});

test('T6 Cuenta_PorPersonaTipoYVia_EnLaVentana @story-1.31 @ac-4', () => {
  const r = repo();
  r.commit('viejo sin historia', ['src/v.js'], { fecha: '2026-09-01' });              // fuera de los 28 días
  r.commit('arreglo directo', ['src/h.js'], { autor: 'Beto Dos', fecha: '2026-09-23' }); // el primer día de la ventana
  r.merge('feature/1.2-algo', 'Merge pull request 9 from feature/1.2-algo into main', [['feat: el filtro', 'Ana Uno']]);
  r.merge('cambios', 'Merge pull request 10 from cambios into main', [['deuda: renovar paquetes', 'Ana Uno']]);
  const c = sr().contarRepo(r.dir, { today: HOY });
  assert.deepStrictEqual({ codigo: c.codigo, con: c.con, sin: c.sin }, { codigo: 3, con: 1, sin: 2 });
  assert.deepStrictEqual(c.por_persona, { 'Ana Uno': { con: 1, sin: 1 }, 'Beto Dos': { con: 0, sin: 1 } });
  assert.deepStrictEqual(c.por_tipo, { hotfix: 1, dependencias: 1, arnes_ci: 0, merge_dev: 0, otro: 0 });
  assert.deepStrictEqual(c.por_via, { pedido: { con: 1, sin: 1 }, directo: { con: 0, sin: 1 } });
  assert.deepStrictEqual(c.ventana, { desde: '2026-09-23', hasta: HOY, dias: 28 });
});

test('T7 NoMedido_ClonQueFalla_DiceElMotivo @story-1.31 @ac-5', () => {
  const r = repo();
  r.commit('agrega el campo', ['src/campo.js']);
  const superficial = tmp('sr-shallow-'); limpiar.push(superficial);
  execFileSync('git', ['clone', '-q', '--depth=1', `file://${r.dir}`, path.join(superficial, 'c')]);
  const noGit = tmp('sr-nogit-'); limpiar.push(noGit);
  const d = sr().contar({ today: HOY, repos: [
    { producto: 'Alfa', repo: 'Alfa/Back', dir: r.dir },
    { producto: 'Alfa', repo: 'Alfa/Front', dir: null, motivo: 'no está entre los clones del nocturno' },
    { producto: 'Beta', repo: 'Beta/Back', dir: path.join(superficial, 'c') },
    { producto: 'Gama', repo: 'Gama/Back', dir: noGit },
  ] });
  const por = Object.fromEntries(d.repos.map((x) => [x.repo, x]));
  assert.strictEqual(por['Alfa/Back'].estado, 'medido');
  assert.match(por['Alfa/Front'].motivo, /no está entre los clones/);
  assert.match(por['Beta/Back'].motivo, /superficial/);
  assert.strictEqual(por['Gama/Back'].estado, 'no_medido');
  assert.ok(por['Gama/Back'].motivo, 'un repo que no es git dice por qué');
  for (const k of ['Alfa/Front', 'Beta/Back', 'Gama/Back']) assert.strictEqual(por[k].codigo, null, `${k}: no medido no es 0`);
  assert.deepStrictEqual(d.cobertura, { repos_declarados: 4, repos_medidos: 1 });
  assert.deepStrictEqual({ codigo: d.totales.codigo, sin: d.totales.sin }, { codigo: 1, sin: 1 });
});

test('T8 Archivo_LaFormaQueLeeElTablero @story-1.31 @ac-5 @ac-6', () => {
  const scan = tmp('sr-scan-'); limpiar.push(scan);
  const r = repo();
  r.commit('agrega el campo', ['src/campo.js'], { autor: 'Ana Uno' });
  r.commit('feat(2.1): el filtro', ['src/f.js'], { autor: 'Ana Uno' });
  execFileSync('git', ['clone', '-q', '--no-checkout', '--filter=blob:none', `file://${r.dir}`, path.join(scan, 'Alfa__Back')]);
  const prods = path.join(scan, '..', `repos-${path.basename(scan)}.json`); limpiar.push(prods);
  // la misma entrada dos veces (raíz y subcarpeta, como un producto con un servicio adentro): el repo se cuenta una vez
  fs.writeFileSync(prods, JSON.stringify({ repos: [{ producto: 'Alfa', ruta: 'Alfa/Back', ado: 'Alfa/Back', tipo: 'npm' },
    { producto: 'Alfa', ruta: 'Alfa/Back', ado: 'Alfa/Back', tipo: 'npm', subruta: 'tools/x' }, { producto: 'Beta', ruta: 'Beta/Back', ado: 'Beta/Back' }] }));
  const out = path.join(scan, `story-reference-${HOY}.json`);
  const p = spawnSync(process.execPath, [GUION, '--scan', scan, '--products', prods, '--out', out], { encoding: 'utf8', env: { ...process.env, TYCON_TODAY: HOY } });
  assert.strictEqual(p.status, 0, p.stderr);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(doc.v, 1);
  assert.ok(doc.generated_at);
  assert.deepStrictEqual(doc.ventana, { desde: '2026-09-23', hasta: HOY, dias: 28 });
  assert.deepStrictEqual(doc.cobertura, { repos_declarados: 2, repos_medidos: 1 });
  assert.deepStrictEqual({ codigo: doc.totales.codigo, con: doc.totales.con, sin: doc.totales.sin }, { codigo: 2, con: 1, sin: 1 });
  assert.deepStrictEqual(doc.totales.por_persona, { 'Ana Uno': { con: 1, sin: 1 } });
  // la ficha también lee el tipo y la vía: si el productor les cambia el nombre, esto lo ve
  assert.deepStrictEqual(doc.totales.por_tipo, { hotfix: 0, dependencias: 0, arnes_ci: 0, merge_dev: 0, otro: 1 });
  assert.deepStrictEqual(doc.totales.por_via, { pedido: { con: 0, sin: 0 }, directo: { con: 1, sin: 1 } });
  assert.deepStrictEqual(doc.repos.map((x) => [x.repo, x.estado]), [['Alfa/Back', 'medido'], ['Beta/Back', 'no_medido']]);
  assert.ok(!fs.readFileSync(out, 'utf8').includes('@ej.test'), 'ningún correo en el archivo');
  // sin argumentos: uso, exit 1
  assert.strictEqual(spawnSync(process.execPath, [GUION], { encoding: 'utf8' }).status, 1);
});

// ── las regresiones del pase adversarial y de los revisores (vuelta 1) ──

test('T13 Documental_ConTildeEnElNombre_NoCuenta @story-1.31 @ac-2', () => {
  // git escribe entre comillas y con escapes octales las rutas no ASCII si no se le apaga core.quotePath
  const r = repo();
  r.commit('docs: la señal', ['docs/señal.md']);
  r.commit('specs: la medición', ['specs/medición.md']);
  r.commit('agrega el campo', ['src/campo.js']);
  const c = sr().contarRepo(r.dir, { today: HOY });
  assert.strictEqual(c.codigo, 1, JSON.stringify(c));
});

test('T14 Ventana_FastForwardViejo_NoCortaLaCuenta @story-1.31 @ac-4', () => {
  // un commit con fecha de committer vieja en la línea principal no corta el recorrido de la ventana
  const r = repo();
  r.commit('directo en la ventana', ['src/a.js'], { fecha: '2026-10-10' });
  r.commit('viejo traído por fast-forward', ['src/v.js'], { fecha: '2026-09-01' });
  r.commit('directo después', ['src/c.js'], { fecha: '2026-10-18' });
  const asuntos = sr().entradasDe(r.dir, { today: HOY }).map((e) => e.asunto);
  assert.deepStrictEqual(asuntos, ['directo después', 'directo en la ventana']);
});

test('T15 Via_SquashDeUnPedido_CuentaComoPedido @story-1.31 @ac-4', () => {
  const r = repo();
  r.commit('Merged PR 29: arregla los pasos', ['src/s.js']);     // squash de Azure DevOps
  r.commit('agrega el filtro (#41)', ['src/g.js']);               // squash de GitHub
  r.commit('directo sin pedido', ['src/d.js']);
  const c = sr().contarRepo(r.dir, { today: HOY });
  assert.deepStrictEqual(c.por_via, { pedido: { con: 0, sin: 2 }, directo: { con: 0, sin: 1 } });
});

test('T16 Tipo_LosAumentosDeVersionTraidosNoDanElTipo @story-1.31 @ac-1', () => {
  const r = repo();
  r.merge('cambios', 'Merge pull request 12 from cambios into main',
    [['agrega el campo', 'Ana Uno'], ['chore: bump version to 1.2.3 [skip ci]', 'Azure Pipelines']]);
  const c = sr().contarRepo(r.dir, { today: HOY });
  assert.strictEqual(c.por_tipo.otro, 1, JSON.stringify(c.por_tipo));
});

test('T17 Nombra_MayusculasConTilde_NoSonUnCodigo @story-1.31 @ac-1', () => {
  const { nombra } = sr();
  assert.ok(!nombra('ÉXITO-2 en el alta'), 'una palabra con tilde no es un código de historia');
  assert.ok(!nombra('CAMPAÑA-3 nueva'), 'tampoco con ñ');
  assert.ok(nombra('GE-3 el mensaje'));
});

test('T18 Persona_MailmapYNombreRaro_SinRomperLaCuenta @story-1.31 @ac-3', () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.mailmap'), 'Ana Uno <ana-vieja@ej.test>\n');
  r.git(['add', '.mailmap']); r.git(['commit', '-q', '-m', 'docs: mailmap']);
  r.commit('cambio con el alias', ['src/a.js'], { autor: 'Ana Vieja' });
  r.commit('cambio de un nombre raro', ['src/p.js'], { autor: '__proto__' });
  const c = sr().contarRepo(r.dir, { today: HOY });
  assert.deepStrictEqual(Object.keys(c.por_persona).sort(), ['Ana Uno', '__proto__']);
  assert.deepStrictEqual(c.por_persona.__proto__, { con: 0, sin: 1 });
  assert.strictEqual(({}).con, undefined, 'el nombre raro no tocó Object.prototype');
});

test('T19 Entradas_CommitRaizYMergeBranch @story-1.31 @ac-1', () => {
  const dir = tmp('sr-raiz-'); limpiar.push(dir);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ana Uno', GIT_AUTHOR_EMAIL: 'a@ej.test', GIT_COMMITTER_NAME: 'Ana Uno', GIT_COMMITTER_EMAIL: 'a@ej.test', GIT_AUTHOR_DATE: `${HOY}T12:00:00Z`, GIT_COMMITTER_DATE: `${HOY}T12:00:00Z`, HOME: dir };
  const g = (a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', dir, ...a], { encoding: 'utf8', env });
  g(['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'a.js'), '1');
  g(['add', '-A']); g(['commit', '-q', '-m', 'inicio con código']);
  g(['checkout', '-q', '-b', 'story/4.4-x']); fs.writeFileSync(path.join(dir, 'src', 'b.js'), '2'); g(['add', '-A']); g(['commit', '-q', '-m', 'algo']);
  g(['checkout', '-q', 'main']); g(['merge', '-q', '--no-ff', '-m', "Merge branch 'story/4.4-x'", 'story/4.4-x']);
  const e = sr().entradasDe(dir, { today: HOY });
  assert.deepStrictEqual(e.map((x) => [x.asunto, x.archivos]), [["Merge branch 'story/4.4-x'", ['src/b.js']], ['inicio con código', ['src/a.js']]]);
  assert.strictEqual(sr().ramaDe("Merge branch 'story/4.4-x'"), 'story/4.4-x');
  assert.strictEqual(sr().clasificar(e[0]).nombra, true);
});

test('T20 NoMedido_ClonEnOtraRamaSinOriginMain @story-1.31 @ac-5', () => {
  const r = repo();
  r.commit('agrega el campo', ['src/campo.js']);
  r.git(['checkout', '-q', '-b', 'dev']);
  const c = sr().contarRepo(r.dir, { today: HOY });
  assert.strictEqual(c.estado, 'no_medido');
  assert.match(c.motivo, /main/);
});

test('T12 CiGate_DiceDondeSeMide @story-1.31 @ac-8', () => {
  const g = fs.readFileSync(path.join(RAIZ, 'guides', 'ci-gate.md'), 'utf8');
  const i = g.indexOf('## Lo que este control NO cubre');
  const j = g.indexOf('\n## ', i + 1);
  const sec = g.slice(i, j);
  assert.ok(i >= 0, 'la sección existe');
  assert.match(sec, /Cambios de código sin historia/, 'nombra la ficha');
  assert.match(sec, /nocturno de métricas/, 'dice qué nocturno lo mide');
  assert.match(sec, /scripts\/metrics\/story-reference\.js/, 'nombra el guion');
});
