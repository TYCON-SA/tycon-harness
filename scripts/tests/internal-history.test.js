'use strict';
// internal-history.test.js — lo publicado no cuenta la historia interna con números de pull request.
//
// POR QUÉ EXISTE: la copia pública no puede traer números de pull request del repo del equipo —en comentarios, en
// guías, en pruebas—. Desde afuera no llevan a nada: son ruido para quien no conoce la historia.
// La lección va sin el número. Un número que una prueba usa como DATO (el título de un commit que
// un control tiene que reconocer, un comando de laboratorio) queda, declarado con su archivo, el valor EXACTO y el motivo
// en `fixtures/internal-history-allowed.json` — nunca un archivo entero.
//
// Qué fija:
//   · ningún archivo publicado trae un número fuera de esa lista (la expresión cuenta los números de pull request);
//   · cada entrada de la lista sigue apareciendo donde dice (una declaración que ya no hace falta, sale).
// Corre en el repo y en la copia. En el repo, «publicado» es la lista blanca resuelta por el exportador (`whatShips`,
// paquetes públicos) y se lee el archivo del disco; en la copia, todo archivo de la copia. Cuál de los dos es se sabe
// por la tabla privada de reemplazos, que nunca viaja.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const LISTA = 'scripts/tests/fixtures/internal-history-allowed.json';
// La expresión del número de pull request, con el plural, «de prueba» en el medio y el «!» con que Azure DevOps
// nombra un pull request. Vive en un solo lugar: la forma `pr-number` del control de historia interna, que mira la
// prosa al commitear; así las dos redes ven lo mismo.
const NUMERO_DE_PR = require('../publishing/internal-history.js').FORMS['pr-number'].re;
const EN_EL_REPO = fs.existsSync(path.join(RAIZ, 'scripts', 'publishing', 'replacements.json'));

function publicados() {
  if (!EN_EL_REPO) {
    // en un clon de la copia, lo que viaja es lo que git conoce: las carpetas que otras pruebas escriben mientras ésta
    // recorre (las carpetas personales de juguete bajo `.advisors/`) no son de la copia, y un archivo puede irse a mitad
    const git = spawnSync('git', ['-C', RAIZ, 'ls-files', '-z'], { encoding: 'utf8' });
    if (fs.existsSync(path.join(RAIZ, '.git')) && git.status === 0) return git.stdout.split('\0').filter((r) => r && fs.existsSync(path.join(RAIZ, r)));
    const out = [];
    (function walk(dir, base) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else if (e.isFile()) out.push(rel);
      }
    })(RAIZ, '');
    return out;
  }
  const ex = require('../publishing/export.js');
  const ctx = { repos: { arnes: { dir: RAIZ }, 'agent-skills': { dir: RAIZ } } };
  const base = path.join(RAIZ, 'scripts', 'publishing');
  ex.prepararFuentes(ctx, { arnes: 'HEAD', 'agent-skills': 'HEAD' }, {
    lista: path.join(base, 'allowlist.json'), reemplazos: path.join(base, 'replacements.json'),
    denegados: path.join(base, 'denylist.json'), publicRepos: path.join(base, 'public-repos.json'),
  });
  // la ruta en el repo de cada archivo que sale (un sintético se lee desde su `from`, que es lo que viaja con su texto)
  const rutas = new Set();
  for (const p of ex.whatShips(ctx).packages) {
    // un sintético viaja con el texto de su `from` («synthetic-source»), no con el del archivo que reemplaza
    for (const [, a] of p.files) if (a.ruta && a.kind !== 'synthetic') rutas.add(a.ruta);
  }
  return [...rutas].filter((r) => fs.existsSync(path.join(RAIZ, r)));
}

// Los ejemplos se arman por partes (`n`): este archivo viaja y la prueba de abajo lo recorre como a cualquier otro.
test('InternalHistory_Expression_SeesLooseForms', () => {
  const ve = (t) => [...t.matchAll(NUMERO_DE_PR)].map((m) => m[0]);
  const n = (palabra, numero) => `${palabra} ${numero}`;
  assert.deepStrictEqual(ve(`el ${n('PR', 1234)} y el ${n('pull request', '#5678')}`), [n('PR', 1234), n('pull request', '#5678')]);
  assert.deepStrictEqual(ve(`Evidencia (${n('PR de prueba', 4321)}, del arnés)`), [n('PR de prueba', 4321)]);
  assert.deepStrictEqual(ve(`(${n('PR', '!2345')}, rename)`), [n('PR', '!2345')]);
  assert.deepStrictEqual(ve(`los ${n('pull requests', 1111)} y 2222`), [n('pull requests', 1111)]);
  assert.deepStrictEqual(ve('«Merged PR <id>: …» y un pull request (2026-09-05)'), [], 'un marcador o una fecha no son un número de pull request');
});

test('PublishedFiles_PrNumbers_OnlyDeclaredTestData', () => {
  const declarados = JSON.parse(fs.readFileSync(path.join(RAIZ, LISTA), 'utf8')).allowed;
  assert.ok(Array.isArray(declarados), `${LISTA}: sin «allowed»`);
  for (const e of declarados) {
    assert.ok(e && e.file && e.form && e.value && e.reason && String(e.reason).trim(), `${LISTA}: cada entrada necesita file, form, value y reason (${JSON.stringify(e)})`);
  }
  // la lista la comparte el control de historia interna de la prosa: esta prueba mira sólo los
  // números de pull request; las demás formas las cuida scripts/tests/internal-history-guard.test.js
  const permitidos = declarados.filter((e) => e.form === 'pr-number');
  const archivos = publicados();
  assert.ok(archivos.length > 100, `pocos archivos publicados (${archivos.length}): la lista no se resolvió`);
  // un pedido del repo público no es historia interna: se le pregunta a ese repo, y sólo si aparece uno sin declarar
  const ih = require('../publishing/internal-history.js');
  const lookup = ih.publicLookup(RAIZ);
  const vistos = new Set();
  const fuera = [];
  for (const f of archivos) {
    if (f === LISTA) continue;
    const datos = fs.readFileSync(path.join(RAIZ, f));
    if (datos.includes(0)) continue;
    datos.toString('utf8').split('\n').forEach((linea, i) => {
      for (const m of linea.matchAll(NUMERO_DE_PR)) {
        const ok = permitidos.find((e) => e.file === f && m[0] === e.value);
        if (ok) vistos.add(`${ok.file}\0${ok.value}`);
        else if (!ih.isPublicReference({ form: 'pr-number', value: m[0] }, lookup)) fuera.push(`${f}:${i + 1}: «${m[0]}»`);
      }
    });
  }
  assert.deepStrictEqual(fuera, [], `números de pull request en lo publicado, fuera de la lista de datos de prueba${lookup.problem() ? ` (el repo público no contestó: ${lookup.problem()})` : ''}`);
  const sobran = permitidos.filter((e) => !vistos.has(`${e.file}\0${e.value}`)).map((e) => `${e.file}: «${e.value}»`);
  assert.deepStrictEqual(sobran, [], 'declaraciones que ya no aparecen (o el archivo ya no se publica): sacalas de la lista');
});

// La prosa que se publica, entera, en cero (T59). Las guías y las portadas, las skills,
// los revisores y los bloques dicen la regla y su porqué, sin el caso; lo que es un dato o el ejemplo de un formato
// está declarado con su motivo. Con la prosa en cero, el control frena por escrito: quien agrega una forma no crea el
// commit. Corre en el repo y en la copia (ahí el control mira en modo público: lo que dejaría de llevar a algún lado).
test('PublishedProse_ZeroForms_GuardBlocksByDefault', () => {
  const ih = require('../publishing/internal-history.js');
  const d = ih.run({ mode: 'all', repo: RAIZ, ref: 'HEAD', config: null });
  assert.strictEqual(d.outcome, 'counted', 'el control pudo mirar');
  const quedan = Object.entries(d.files).map(([file, forms]) => `${file}: ${Object.entries(forms).map(([form, n]) => `${form} ${n}`).join(', ')}`);
  assert.deepStrictEqual(quedan, [], 'formas de historia interna en la prosa que se publica, fuera de lo declarado');
  assert.strictEqual(d.total, 0);
  assert.ok(d.looked > 100, `pocos archivos de prosa mirados (${d.looked}): el cero sería un cero vacío`);
  assert.deepStrictEqual(d.stale, [], 'una declaración que ya no hace falta, sale');
  // el modo ESCRITO es frenar, y ninguna forma quedó escrita por debajo sin decir por qué
  const config = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.json'), 'utf8'));
  assert.strictEqual(config.mode, 'block', 'con la prosa en cero el control frena: el modo escrito es `block`');
  for (const [form, c] of Object.entries(config.forms)) {
    assert.ok(c.mode === 'block' || (c.mode === 'warn' && String(c.why || '').trim()), `${form}: frena, o avisa diciendo por qué`);
  }
});

// ── lo que ya es del repo público ─────────────────────────────────────────────────────────────────────────────
// Un pedido o un commit del repo público son referencias legítimas. Tres formas —`pr-number`,
// `private-commit` y el `#N` suelto de `azure-run`— le preguntan al repo público (`publicLookup`, con `git ls-remote`)
// antes de contar. Un repo desnudo local hace de GitHub: publica cada pedido como `refs/pull/<N>/head`, como GitHub.
// Lo de Azure sigue siendo interno, y si el público no contesta, nada es suyo: frena igual.
const n = (palabra, numero) => `${palabra}${numero}`;   // armados por partes: este archivo viaja y se recorre
// 🔴 Fecha, autor y committer fijos: el sha de cada commit del laboratorio sale siempre igual. Sin esto, sale de la hora
// de la corrida, y cuando sus primeros 8 caracteres son sólo dígitos (~2,3 % de las corridas) la forma
// `private-commit`, que pide dígito y letra, no los ve y tres casos dan rojo de azar. Y el
// mantenimiento automático de git, apagado: no queda nada de fondo tocando el laboratorio.
const FECHA_FIJA = '2026-10-15T00:00:00Z';
function gitIn(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: 'Prueba', GIT_AUTHOR_EMAIL: '1+prueba@users.noreply.github.com', GIT_COMMITTER_NAME: 'Prueba', GIT_COMMITTER_EMAIL: '1+prueba@users.noreply.github.com',
      GIT_AUTHOR_DATE: FECHA_FIJA, GIT_COMMITTER_DATE: FECHA_FIJA },
  });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
/** El «GitHub» de juguete (con el pedido 100 y un commit publicado) y un clon con un commit que sólo tiene el equipo. */
function publicLab(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ih-publico-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publico = path.join(root, 'publico.git');
  const work = path.join(root, 'trabajo');
  gitIn(root, ['init', '--quiet', '--bare', '--initial-branch=main', publico]);
  gitIn(root, ['init', '--quiet', '--initial-branch=main', work]);
  fs.writeFileSync(path.join(work, 'README.md'), 'un repo de juguete\n');
  gitIn(work, ['add', '-A']);
  gitIn(work, ['commit', '--quiet', '-m', 'lo publicado']);
  const published = gitIn(work, ['rev-parse', 'HEAD']);
  gitIn(work, ['remote', 'add', 'origin', publico]);
  gitIn(work, ['push', '--quiet', 'origin', 'main']);
  gitIn(root, ['--git-dir', publico, 'update-ref', 'refs/pull/100/head', published]);
  gitIn(work, ['commit', '--quiet', '--allow-empty', '-m', 'sólo del equipo']);
  const internal = gitIn(work, ['rev-parse', 'HEAD']);
  return { root, publico, work, published: prefijoCitable(published, 'publicado'), internal: prefijoCitable(internal, 'del equipo') };
}
/** Los casos citan los primeros 8 caracteres del sha: con fecha fija salen siempre iguales, pero si un cambio del
 * laboratorio los dejara sin dígito o sin letra, `private-commit` no los vería. Eso se dice acá, con su motivo, y no como
 * un rojo de la regla. */
function prefijoCitable(sha, cual) {
  const p = sha.slice(0, 8);
  assert.ok(/[0-9]/.test(p) && /[a-f]/.test(p), `el commit ${cual} del laboratorio quedó con el prefijo ${p}, sin dígito y letra: la forma private-commit no lo ve. Cambiá FECHA_FIJA (story 8.38)`);
  return sha;
}

test('PublicHistory_LabPrefix_WithoutDigitOrLetter_SaysWhy', () => {
  assert.throws(() => prefijoCitable(`12345678${'a'.repeat(32)}`, 'de prueba'), /prefijo 12345678, sin dígito y letra/);
  assert.throws(() => prefijoCitable(`abcdefab${'1'.repeat(32)}`, 'de prueba'), /sin dígito y letra/);
  const bueno = `1234567a${'0'.repeat(32)}`;
  assert.strictEqual(prefijoCitable(bueno, 'de prueba'), bueno);
});

test('PublicHistory_LabSha_SameEveryRun', (t) => {
  const a = publicLab(t);
  const b = publicLab(t);
  assert.strictEqual(a.published, b.published, 'con fecha fija el commit publicado sale igual en cada laboratorio');
  assert.strictEqual(a.internal, b.internal, 'y el del equipo también');
});
const formsOf = (found) => found.map((f) => f.form);

test('PublicHistory_GithubMergeSubject_PublicPullRequest_Passes', (t) => {
  const ih = require('../publishing/internal-history.js');
  const fx = publicLab(t);
  const subject = `Merge pull request ${n('#', 100)} from acme/una-rama`;
  // sin preguntarle al público, el asunto con que GitHub mergea coincide con la forma desde el pedido 100
  assert.deepStrictEqual(formsOf(ih.scan(subject, 'message')), ['pr-number']);
  const lookup = ih.publicLookup(fx.work, fx.publico);
  assert.deepStrictEqual(ih.scan(subject, 'message', lookup), [], 'el pedido 100 es del repo público: no es historia interna');
  assert.deepStrictEqual(ih.scan(`lo del PR ${n('#', 100)}`, 'prose', lookup), [], 'en la prosa también');
  assert.deepStrictEqual(ih.scan(n('ver #', 10000), 'prose', lookup).length, 1, 'un #N suelto que el público no tiene sigue siendo una ejecución');
  assert.strictEqual(lookup.problem(), null);
});

test('PublicHistory_AzurePullRequestNumber_Blocked', (t) => {
  const ih = require('../publishing/internal-history.js');
  const fx = publicLab(t);
  const lookup = ih.publicLookup(fx.work, fx.publico);
  // el asunto de un merge de Azure (sin numeral), «PR !N» y «PR N»: las formas de Azure cuentan aunque el número
  // coincida con un pedido del público; y un #N que el público no tiene, también
  for (const text of [`Merge pull request ${n('', 4504)} from docs/una-rama into main`, `Merge pull request ${n('', 100)} from dev into main`,
    `el PR ${n('!', 100)}`, `el PR ${n('', 100)}`, `el PR ${n('#', 4504)}`]) {
    assert.deepStrictEqual(formsOf(ih.scan(text, 'message', lookup)), ['pr-number'], text);
  }
  // las corridas son de Azure siempre, con numeral o sin él
  assert.deepStrictEqual(formsOf(ih.scan(n('la ejecución #', 12511), 'prose', lookup)), ['azure-run']);
});

test('PublicHistory_PublicCommit_Passes', (t) => {
  const ih = require('../publishing/internal-history.js');
  const fx = publicLab(t);
  const lookup = ih.publicLookup(fx.work, fx.publico);
  const short = fx.published.slice(0, 8);
  assert.deepStrictEqual(formsOf(ih.scan(`hasta el commit \`${short}\``, 'prose')), ['private-commit'], 'sin preguntar, cuenta');
  assert.deepStrictEqual(ih.scan(`hasta el commit \`${short}\``, 'prose', lookup), [], 'abreviado: es del repo público');
  assert.deepStrictEqual(ih.scan(`hasta el commit ${fx.published}`, 'prose', lookup), [], 'entero');
});

test('PublicHistory_InternalOnlyCommit_Blocked', (t) => {
  const ih = require('../publishing/internal-history.js');
  const fx = publicLab(t);
  const lookup = ih.publicLookup(fx.work, fx.publico);
  // está en este clon, pero ninguna punta del público llega a él
  assert.deepStrictEqual(formsOf(ih.scan(`hasta el commit \`${fx.internal.slice(0, 8)}\``, 'prose', lookup)), ['private-commit']);
  // y uno que este clon ni tiene
  assert.deepStrictEqual(formsOf(ih.scan(n('hasta el commit ', 'c6cbe1d4'), 'prose', lookup)), ['private-commit']);
});

test('PublicHistory_PublicRepoDoesNotAnswer_Blocked', (t) => {
  const ih = require('../publishing/internal-history.js');
  const fx = publicLab(t);
  const lookup = ih.publicLookup(fx.work, path.join(fx.root, 'no-contesta.git'));
  assert.deepStrictEqual(formsOf(ih.scan(`Merge pull request ${n('#', 100)} from acme/una-rama`, 'message', lookup)), ['pr-number']);
  assert.deepStrictEqual(formsOf(ih.scan(`hasta el commit \`${fx.published.slice(0, 8)}\``, 'prose', lookup)), ['private-commit']);
  assert.match(String(lookup.problem()), /no contestó/);
  // sin decir cuál es el público y con un `origin` que no es de GitHub, tampoco se distingue (y se dice por qué)
  const local = ih.publicLookup(fx.work);
  assert.deepStrictEqual(formsOf(ih.scan(`lo del PR ${n('#', 100)}`, 'prose', local)), ['pr-number']);
  assert.match(String(local.problem()), /origin/);
});

// De punta a punta: el control del commit, con la prosa stageada en un repo con la forma del público.
test('PublicHistory_StagedProse_PublicReferencesPass_InternalOnesBlock', (t) => {
  const ih = require('../publishing/internal-history.js');
  const fx = publicLab(t);
  const runOn = (text, publicRemote) => {
    fs.mkdirSync(path.join(fx.work, 'guides'), { recursive: true });
    fs.writeFileSync(path.join(fx.work, 'guides', 'a.md'), `# Guía\n\n${text}\n`);
    gitIn(fx.work, ['add', '-A']);
    return ih.run({ mode: 'staged', repo: fx.work, range: null, json: false, ref: 'HEAD', config: null, publicRemote });
  };
  const good = `Lo arregló el pull request ${n('#', 100)}, en el commit \`${fx.published.slice(0, 8)}\`.`;
  assert.strictEqual(runOn(good, fx.publico).outcome, 'clean');
  const silent = runOn(good, path.join(fx.root, 'no-contesta.git'));
  assert.deepStrictEqual(silent.findings.map((f) => f.form).sort(), ['pr-number', 'private-commit']);
  assert.match(String(silent.publicProblem), /no contestó/);
  const bad = runOn(`Lo arregló el PR ${n('', 4504)}, en el commit \`${fx.internal.slice(0, 8)}\`.`, fx.publico);
  assert.deepStrictEqual(bad.findings.map((f) => f.form).sort(), ['pr-number', 'private-commit']);
});

// ── el repo de mantenimiento adelgazado: lo que se publica es lo que trae el público ─────────────────────────────────
// En el árbol armado (el privado con el público encima, como lo arma su overlay-harness.js --after-cut) se mezclan los
// archivos de los dos repos. Se publica lo que trae el público: lo que el commit de la superposición agrega o cambia
// sobre la punta del privado. Lo sólo-privado (reemplazos de dos líneas, historia, el registro real) no cuenta, y una
// versión propia del privado («own») tampoco: la del público la mide su CI.
const DEUDA = n('DEF-', '9.9-de-juguete');   // una forma que el control reconoce, armada por partes
const MARCA_SUPERPOSICION = '[superposición local, no se empuja]';
function thinLab(t, { thinList = true, profile = false, composed = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ih-adelgazado-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  gitIn(root, ['init', '--quiet', '--initial-branch=main']);
  put('scripts/publishing/internal-history.json', fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.json'), 'utf8'));
  if (thinList === 'broken') put('.tycon/internal-forms.json', '{ "layout": "thin", roto');
  else if (thinList) put('.tycon/internal-forms.json', `${JSON.stringify({ layout: 'thin', own: { 'guides/propia.md': 'la versión del privado' } })}\n`);
  if (profile) { put('perfil-equipo.json', '{}\n'); put('scripts/publishing/replacements.json', '{}\n'); }
  put('guides/privada.md', `# Sólo del privado\n\nLa deuda ${DEUDA} sigue abierta.\n`);
  put('guides/propia.md', `# La versión propia\n\nLa deuda ${DEUDA} sigue abierta.\n`);
  gitIn(root, ['add', '-A']);
  gitIn(root, ['commit', '--quiet', '-m', 'la punta del privado']);
  const tip = gitIn(root, ['rev-parse', 'HEAD']);
  put('guides/publica.md', `# Del público\n\nLa deuda ${DEUDA} sigue abierta.\n`);
  // una versión propia que la superposición compone con la del público: queda distinta de la punta, con lo del privado
  if (composed) put('guides/propia.md', `# La del público\n\n## La sección del privado\n\nLa deuda ${DEUDA} sigue abierta.\n`);
  gitIn(root, ['add', '-A']);
  gitIn(root, ['commit', '--quiet', '-m', `arnés de GitHub ${'a'.repeat(40)} sobre la punta ${tip} del privado, adelgazado ${MARCA_SUPERPOSICION}`]);
  return { root, tip };
}
const allOf = (repo) => require('../publishing/internal-history.js').run({ mode: 'all', repo, ref: 'HEAD', config: null });

test('ThinOverlay_PublishedIsWhatThePublicBrings_PrivateOnlyAndOwnNotCounted', (t) => {
  const lab = thinLab(t);
  const d = allOf(lab.root);
  assert.strictEqual(d.mode, 'thin', 'el repo con la lista del adelgazado se mide como adelgazado');
  assert.deepStrictEqual(Object.keys(d.files), ['guides/publica.md'], 'cuenta sólo lo que trajo el público');
  assert.deepStrictEqual(d.paths.filter((p) => p.startsWith('guides/')), ['guides/publica.md'], 'lo sólo-privado y lo propio ni se miran');
  // sin la superposición, el árbol es sólo lo privado: no se publica nada
  gitIn(lab.root, ['checkout', '--quiet', lab.tip]);
  assert.deepStrictEqual(allOf(lab.root).files, {}, 'la punta del privado sola no publica nada');
});

test('ThinOverlay_BroughtByOverlay_SameAsPublished @story-8.112 @ac-1', (t) => {
  // lo que trajo la superposición, para las pruebas que recorren el árbol entero: lo mismo que se publica
  const { broughtByOverlay } = require('../publishing/internal-history.js');
  const lab = thinLab(t);
  assert.deepStrictEqual([...broughtByOverlay(lab.root)], ['guides/publica.md'], 'sólo lo que la superposición agregó o cambió');
  gitIn(lab.root, ['checkout', '--quiet', lab.tip]);
  assert.strictEqual(broughtByOverlay(lab.root), null, 'sin la superposición no hay árbol armado: null');
  // un repo sin commits (los de juguete de las pruebas que recorren el árbol) tampoco es el árbol armado
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'brought-vacio-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  gitIn(empty, ['init', '--quiet']);
  assert.strictEqual(broughtByOverlay(empty), null, 'sin commits: null, no un error');
});

test('ThinOverlay_ComposedOwnFile_NotBroughtNorPublished', (t) => {
  // una versión propia compuesta (lo del público más lo del privado) cambia en el commit de la superposición, pero no
  // viaja: lo que sale es la del público, que se mide en su CI. Contarla haría leer lo privado como publicado
  const { broughtByOverlay } = require('../publishing/internal-history.js');
  const lab = thinLab(t, { composed: true });
  assert.deepStrictEqual([...broughtByOverlay(lab.root)], ['guides/publica.md'], 'la propia compuesta no es de lo traído');
  assert.deepStrictEqual(Object.keys(allOf(lab.root).files), ['guides/publica.md'], 'ni se cuenta como publicada');
});

test('ThinOverlay_UnreadableThinList_CouldNotMeasure', (t) => {
  // la lista del adelgazado rota no es «no hay lista»: leída como vacía, lo propio compuesto contaría como publicado
  const { broughtByOverlay } = require('../publishing/internal-history.js');
  const lab = thinLab(t, { thinList: 'broken', composed: true });
  assert.throws(() => broughtByOverlay(lab.root), /internal-forms\.json no es JSON válido/);
  // la clasificación, en cambio, la toma por pública: se mide todo lo versionado, lo más estricto
  assert.strictEqual(allOf(lab.root).mode, 'public');
});

test('ThinOverlay_PublicAndTeamClassificationUnchanged', (t) => {
  // sin la lista del adelgazado, el mismo árbol se mide como el público: todo lo versionado
  const pub = allOf(thinLab(t, { thinList: false }).root);
  assert.strictEqual(pub.mode, 'public');
  assert.deepStrictEqual(Object.keys(pub.files).sort(), ['guides/privada.md', 'guides/propia.md', 'guides/publica.md']);
  // con el perfil y la tabla (el repo del equipo, completo) sigue el camino del equipo, no el del adelgazado
  let mode = null;
  try { mode = allOf(thinLab(t, { thinList: false, profile: true }).root).mode; } catch (e) { mode = `no pudo: ${e.message}`; }
  assert.ok(mode === 'team' || /repo unido/.test(String(mode)), `el clon del equipo sigue clasificado como del equipo (salió ${mode})`);
});

test('ThinOverlay_Travels_WithoutComputedNorTeamLayer', async (t) => {
  // 🔴 rojo: un registro calculado o la capa del equipo cuentan como lo que viaja, o un temporal dentro del repo hereda
  // la superposición del repo que lo contiene
  const { travels, TEAM_LAYER } = require('../publishing/internal-history.js');
  const { overlayLab } = require('./lib/overlay-lab.js');
  const traido = { 'scripts/a.js': 'a\n', 'scripts/tests/suites.json': '{}\n', 'perfil-equipo.json': '{}\n', 'onboarding/alta.md': 'alta\n' };
  const lab = overlayLab({ privado: { 'specs/s.md': 's\n' }, publico: traido });
  t.after(lab.cleanup);
  const viaja = travels(lab.root);
  assert.deepStrictEqual([...Object.keys(traido), 'specs/s.md'].filter(viaja), ['scripts/a.js'], 'viaja sólo lo traído que no es calculado ni del equipo');
  assert.ok(TEAM_LAYER('perfil-equipo.json') && TEAM_LAYER('onboarding/alta.md'), 'el perfil y el alta son la capa del equipo');
  assert.ok(!TEAM_LAYER('onboarding/interno/README.md') && !TEAM_LAYER('scripts/onboarding/x.md'), 'sólo los .md de la raíz de onboarding/');
  // un temporal sin git propio dentro del repo armado: no es el árbol armado, todo viaja
  const dentro = fs.mkdtempSync(path.join(lab.root, 'temporal-'));
  assert.ok(travels(dentro)('specs/s.md'), 'un temporal dentro del repo no hereda la superposición');
  // la misma carpeta escrita con otras mayúsculas, donde el disco no las distingue (la Mac, Windows): sigue siendo el
  // árbol armado
  await t.test('la ruta con otras mayúsculas', (st) => {
    const otraForma = lab.root.replace(/[a-z]/g, (c) => c.toUpperCase());
    if (otraForma === lab.root || !fs.existsSync(otraForma)) { st.skip('NO MEDIDO — este disco distingue mayúsculas'); return; }
    assert.ok(!travels(otraForma)('specs/s.md'), 'con otras mayúsculas, lo del privado sigue sin viajar');
  });
  lab.git(['checkout', '--quiet', lab.tip]);
  assert.ok(travels(lab.root)('specs/s.md'), 'la punta sola: todo viaja');
  // la superposición que no trae nada: no hay qué medir
  const vacio = overlayLab({ privado: { 'specs/s.md': 's\n' } });
  t.after(vacio.cleanup);
  assert.throws(() => travels(vacio.root), /no trajo nada/, 'sin nada traído, lanza');
  // fuera de todo repo, todo viaja; si git no se puede correr ahí, no se toma por «no hay superposición»
  const suelto = fs.mkdtempSync(path.join(os.tmpdir(), 'viaja-suelto-'));
  t.after(() => fs.rmSync(suelto, { recursive: true, force: true }));
  assert.ok(travels(suelto)('specs/s.md'), 'una carpeta sin repo: todo viaja');
  assert.throws(() => travels(path.join(suelto, 'no-existe')), /no pude correr git/, 'git que no corre, lanza');
});

test('OverlayComputed_SameNamesAsTheOverlay @story-8.128 @ac-1', () => {
  // los dos registros que la superposición calcula: los mismos nombres que su lista REGISTRIES
  const { OVERLAY_COMPUTED } = require('../publishing/internal-history.js');
  assert.deepStrictEqual([...OVERLAY_COMPUTED].sort(), ['scripts/tests/suite-parts.json', 'scripts/tests/suites.json']);
});
