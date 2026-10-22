'use strict';
/*
 * how-it-works.test.js — «Cómo trabaja»: el recorrido de una historia en el sitio de la organización.
 *
 * El modelo (skills/tycon-pipeline/scripts/lib/how-it-works.js) se arma con las fuentes con que corre el arnés: la
 * tabla de pasos, el cálculo de revisores, la lista de controles y la tabla de los despachadores, los paquetes y los
 * lectores de configuración. Estas pruebas frenan si una de esas fuentes y lo que muestra la pantalla se separan.
 * La pestaña (scripts/site/tabs/how-it-works.js) corre sobre el servidor de prueba del sitio con una sesión real del
 * emisor local; los repos son repos git locales y el GitHub es un servidor falso en el proceso. Nombres inventados.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts');
const HIW = () => require(path.join(SCRIPTS, 'lib', 'how-it-works.js'));
const PIPE = () => require(path.join(SCRIPTS, 'pipeline.js'));
const TAB = () => require(path.join(ROOT, 'scripts', 'site', 'tabs', 'how-it-works.js'));
const TX = () => require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
const TC = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
const H = require('./lib/site-harness.js');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const { crearRepoHttp, hayHttpBackend } = require('./lib/git-http-repo.js');
const { enCastellano } = require('./lib/spanish-text.js');
const hasSpanish = (texto) => enCastellano([texto]).length > 0;

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const LEAD = 'lead@acme.example';
const DEV = 'dev.a@acme.example';
const PUBLICO = 'https://github.com/acme/harness';

function git(dir, ...a) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@acme.example', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@acme.example', GIT_AUTHOR_DATE: '2026-10-16T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-16T12:00:00Z' } });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
/** Una carpeta con estos archivos (objeto → JSON; texto tal cual). Con `repo`, además un repo git con un commit. */
function carpeta(archivos, { repo = false, prefijo = 'hiw-' } = {}) {
  const d = tmp(prefijo);
  for (const [rel, c] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), typeof c === 'string' ? c : `${JSON.stringify(c, null, 2)}\n`);
  }
  if (repo) { git(d, 'init', '-q', '-b', 'main'); git(d, 'add', '-A'); git(d, 'commit', '-q', '--allow-empty', '-m', 'base'); }
  return d;
}

// ── un paquete de la organización, de juguete ──
const PAQUETE = (agentes = ['acme-pagos-reviewer']) => ({
  name: 'acme-pagos', description: 'Los revisores del cobro de Acme.', agents: 'agents',
  reviewers: agentes.map((a) => ({ agent: a, group: 'condicional', when: { detection: 'pyModified' }, surface: { paths: ['**/pagos/**/*.py'] }, depth: 'lean', prefixes: ['PAGOS'] })),
});
const AGENTE = (nombre) => `---\nname: ${nombre}\ndescription: Revisa los cambios en el cobro de Acme.\ntools: Read, Grep, Glob\n---\n\nMirá que todo cobro nuevo pase por el registro de pagos.\n`;
const perfilCon = ({ profile = {}, repos = null, paquete = PAQUETE(), extra = {} } = {}) => ({
  'team-profile.json': { integrations: { clockify: true, engram: true }, packs: { default: 'all' }, ...profile },
  ...(repos ? { 'team-repos.json': repos } : {}),
  ...(paquete ? { 'packs/acme-pagos/pack.json': paquete, 'packs/acme-pagos/agents/acme-pagos-reviewer.md': AGENTE('acme-pagos-reviewer') } : {}),
  ...extra,
});

// ════════════════════════════════════════ el modelo ════════════════════════════════════════

test('T2 ComoTrabaja_PasosDeLaTabla @story-2.61 @ac-2 — los pasos de steps.js, en orden, con su objetivo', () => {
  const { STEPS, CLOSE_STEP } = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  const pasos = HIW().readSteps(ROOT);
  assert.deepStrictEqual(pasos.map((p) => p.id), [...STEPS, CLOSE_STEP].map((s) => s.id), 'los mismos ids, en el mismo orden, con el cierre al final');
  assert.deepStrictEqual(pasos.filter((p) => !p.inSequence).map((p) => p.id), ['close-work-item'], 'el cierre, fuera del recorrido');
  for (const p of pasos) {
    const texto = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', p.file), 'utf8');
    const objetivo = /^\*\*Objetivo\*\*:\s*(.+)$/m.exec(texto)[1].trim();
    assert.strictEqual(p.goal, objetivo, `el objetivo de ${p.file} sale de su línea **Objetivo**`);
  }
  // un paso nuevo en la tabla aparece solo: un árbol de juguete con un paso más
  const arbol = carpeta({
    'skills/tycon-pipeline/scripts/lib/steps.js': `module.exports = { STEPS: [{ id: 'start', name: 'Arranque', file: 'a.md' }, { id: 'x', name: 'Nuevo', file: 'x.md' }] };\n`,
    'skills/tycon-pipeline/steps/a.md': '# Arranque\n\n**Objetivo**: arrancar.\n',
    'skills/tycon-pipeline/steps/x.md': '# Nuevo\n\n**Objetivo**: un paso que no existía.\n',
  });
  assert.deepStrictEqual(HIW().readSteps(arbol).map((p) => [p.id, p.goal]), [['start', 'arrancar.'], ['x', 'un paso que no existía.']]);
});

test('T3 ComoTrabaja_GuiasQueCita @story-2.61 @ac-3 — el archivo del paso y las guías que cita, sin repetir', () => {
  const arbol = carpeta({
    'skills/tycon-pipeline/scripts/lib/steps.js': `module.exports = { STEPS: [{ id: '1', name: 'Uno', file: 'uno.md' }, { id: '2', name: 'Dos', file: 'dos.md' }] };\n`,
    'skills/tycon-pipeline/steps/uno.md': '# Uno\n\n**Objetivo**: uno.\n\nVer `guides/b.md` y guides/a.md, otra vez `guides/b.md`, y story-format.md.\n',
    'skills/tycon-pipeline/steps/dos.md': '# Dos\n\n**Objetivo**: dos.\n\nNada que leer.\n',
  });
  const [uno, dos] = HIW().readSteps(arbol);
  assert.deepStrictEqual(uno.guides, ['skills/tycon-pipeline/steps/uno.md', 'guides/b.md', 'guides/a.md', 'story-format.md']);
  // una guía nombrada sola, como la escriben los pasos del arnés, se reconoce si existe bajo guides/
  const conSuelta = carpeta({
    'skills/tycon-pipeline/scripts/lib/steps.js': `module.exports = { STEPS: [{ id: '4', name: 'Cuatro', file: 'c.md' }] };\n`,
    'skills/tycon-pipeline/steps/c.md': '# C\n\n**Objetivo**: c.\n\nAntes de correr leé `test-execution-discipline.md`; no-existe.md no cuenta, ni otro-paso.md.\n',
    'skills/tycon-pipeline/steps/otro-paso.md': '# otro\n',
    'guides/test-execution-discipline.md': '# guía\n',
  });
  assert.deepStrictEqual(HIW().readSteps(conSuelta)[0].guides, ['skills/tycon-pipeline/steps/c.md', 'guides/test-execution-discipline.md']);
  // una carpeta de guides/ que no se puede leer se dice (sus guías no se reconocerían)
  if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
    const cerrada = carpeta({ 'skills/tycon-pipeline/scripts/lib/steps.js': `module.exports = { STEPS: [{ id: '4', name: 'Cuatro', file: 'c.md' }] };\n`, 'skills/tycon-pipeline/steps/c.md': '# C\n\n**Objetivo**: c.\n', 'guides/privadas/x.md': '# x\n' });
    fs.chmodSync(path.join(cerrada, 'guides', 'privadas'), 0o000);
    try { assert.match(HIW().readSteps(cerrada)[0].problems.join(' '), /guides\/privadas no se pudo leer/); } finally { fs.chmodSync(path.join(cerrada, 'guides', 'privadas'), 0o755); }
  }
  // en el árbol real: el paso de correr las pruebas la cita así
  assert.ok(HIW().readSteps(ROOT).find((s) => s.id === 'run-tests').guides.includes('guides/test-execution-discipline.md'));
  // un archivo de paso que no se puede leer se dice, no queda como «sin objetivo»
  const sinArchivo = carpeta({ 'skills/tycon-pipeline/scripts/lib/steps.js': `module.exports = { STEPS: [{ id: '1', name: 'Uno', file: 'falta.md' }] };\n` });
  assert.match(HIW().readSteps(sinArchivo)[0].problems.join(' '), /falta\.md no se pudo leer/);
  assert.deepStrictEqual(dos.guides, ['skills/tycon-pipeline/steps/dos.md'], 'sin guías citadas: sólo su archivo');
  const html = TAB().renderPage(HIW().buildModel({ treeDir: arbol, profileDir: null }), { idioma: 'es', publicRepo: PUBLICO, version: '2026.10.19.3' });
  assert.ok(html.includes(`href="${PUBLICO}/blob/main/guides/b.md"`), 'el enlace al código, en main del público');
  assert.ok(!/\/edit\/main\//.test(html), 'ninguna pieza abre la edición en GitHub');
  assert.ok(html.includes(TX().t('es', 'comoTrabaja.sinGuias')), 'el paso sin guías citadas lo dice');
});

test('T4 NucleoDeclarado_NoDiverge @story-2.61 @ac-4 — la tabla del núcleo y computeAdvisorSet dicen lo mismo', () => {
  const P = PIPE();
  assert.ok(Array.isArray(P.CORE_REVIEWERS) && P.CORE_REVIEWERS.length, 'la tabla existe');
  for (const r of P.CORE_REVIEWERS) {
    assert.ok(['always', 'story', 'change'].includes(r.group), `${r.agent}: grupo`);
    assert.ok(TX().t('es', r.whenKey) && TX().t('en', r.whenKey), `${r.agent}: el texto de «cuándo» en es y en`);
  }
  assert.deepStrictEqual(P.coreReviewersDrift(), { missing: [], extra: [], notTriggered: [] });
});

test('T5 NucleoDeclarado_FrenaSiSeSepara @story-2.61 @ac-4 — una tabla que pierde o inventa un revisor frena', () => {
  const P = PIPE();
  const sinUno = P.CORE_REVIEWERS.filter((r) => r.agent !== 'tycon-silent-failure-hunter');
  assert.deepStrictEqual(P.coreReviewersDrift({ table: sinUno }).missing, ['tycon-silent-failure-hunter']);
  const conInventado = [...P.CORE_REVIEWERS, { agent: 'tycon-inventado', group: 'change', whenKey: 'revisorCuando.codigo', probe: { files: { 'a.js': 'x' } } }];
  const d = P.coreReviewersDrift({ table: conInventado });
  assert.deepStrictEqual(d.extra, ['tycon-inventado']);
  assert.ok(d.notTriggered.includes('tycon-inventado'));
  // el caso de una fila que no hace entrar a su revisor
  const malCaso = P.CORE_REVIEWERS.map((r) => (r.agent === 'tycon-e2e-realness-checker' ? { ...r, probe: { files: { 'README.md': '# hola\n' } } } : r));
  assert.deepStrictEqual(P.coreReviewersDrift({ table: malCaso }).notTriggered, ['tycon-e2e-realness-checker']);
});

test('T6 Paquetes_EnSuPaso @story-2.61 @ac-5 — validacion en Validar, base y condicional en Revisores; los del perfil, marcados', () => {
  const arbolPaq = {
    name: 'del-arbol', description: 'x', agents: 'agents',
    reviewers: [{ agent: 'arbol-validador', group: 'validacion', when: { detection: 'csModified' }, prompt: 'Validá {story_path} en {repo_path}', prefixes: ['ARB'] }],
  };
  const arbol = carpeta({ 'packs/del-arbol/pack.json': arbolPaq, 'packs/del-arbol/agents/arbol-validador.md': AGENTE('arbol-validador') });
  const perfil = carpeta(perfilCon({ paquete: { ...PAQUETE(), reviewers: [...PAQUETE().reviewers, { agent: 'acme-base-reviewer', group: 'base', surface: { paths: ['**/*.py'] }, depth: 'lean', prefixes: ['ACMEB'] }] }, extra: { 'packs/acme-pagos/agents/acme-base-reviewer.md': AGENTE('acme-base-reviewer') } }));
  const m = HIW().buildModel({ treeDir: ROOT, packsTreeDir: arbol, profileDir: perfil });
  const en = (id) => m.steps.find((s) => s.id === id).reviewers.packs;
  assert.deepStrictEqual(en('validate-story').map((r) => [r.agent, r.origin]), [['arbol-validador', 'harness']]);
  assert.deepStrictEqual(en('reviewers').map((r) => [r.agent, r.origin]).sort(), [['acme-base-reviewer', 'organization'], ['acme-pagos-reviewer', 'organization']]);
  assert.deepStrictEqual(en('reviewers').map((r) => r.agent).sort(), ['acme-base-reviewer', 'acme-pagos-reviewer'], 'cada revisor, una vez: la otra vuelta es de este mismo paso');
  const pagos = en('reviewers').find((r) => r.agent === 'acme-pagos-reviewer');
  assert.deepStrictEqual(pagos.when, { detection: 'pyModified' }, 'la condición del manifiesto');
  const html = TAB().renderPage(m, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  assert.ok(html.includes(TX().t('es', 'bandera.pyModified')), 'la condición dicha en llano');
  assert.ok(html.includes(TX().t('es', 'comoTrabaja.deTuOrganizacion')), 'la marca de la organización');
  // el mismo revisor en un paquete del árbol y en uno del perfil: el problema se ve, como cuando el pipeline los carga
  const repetido = carpeta(perfilCon({ paquete: { ...PAQUETE(['arbol-validador']), reviewers: [{ ...PAQUETE().reviewers[0], agent: 'arbol-validador' }] }, extra: { 'packs/acme-pagos/agents/arbol-validador.md': AGENTE('arbol-validador') } }));
  const m2 = HIW().buildModel({ treeDir: ROOT, packsTreeDir: arbol, profileDir: repetido });
  assert.match(m2.packs.find((p) => p.origin === 'organization').problems.join(' '), /ya lo declara otro paquete/);
});

test('T7 Controles_DeclaranPasoYEfecto @story-2.61 @ac-6 — cada control y cada hijo de los despachadores declaran pasos y efecto', () => {
  assert.deepStrictEqual(HIW().controlProblems(ROOT), []);
  // un árbol de juguete con los tres errores que la prueba tiene que ver
  const arbol = carpeta({
    'skills/tycon-pipeline/scripts/lib/steps.js': `module.exports = { STEPS: [{ id: '4', name: 'Cuatro', file: 'c.md' }] };\n`,
    'skills/tycon-pipeline/steps/c.md': '# C\n\n**Objetivo**: c.\n',
    'scripts/setup/hooks-list.json': { hooks: [
      { event: 'PreToolUse', matcher: '', spec: '@tcg:sin-campos.js', when: 'always', platforms: { windows: true }, label: 'a' },
      { event: 'PreToolUse', matcher: '', spec: '@tcg:paso-raro.js', when: 'always', platforms: { windows: true }, label: 'b', steps: ['99'], effect: 'warns' },
      { event: 'PreToolUse', matcher: '', spec: '@tcg:frena-mudo.js', when: 'always', platforms: { windows: true }, label: 'c', steps: ['4'], effect: 'blocks' },
      { event: 'PreToolUse', matcher: '', spec: '@tcg:cadena-que-falta.js', when: 'always', platforms: { windows: true }, label: 'd', steps: ['4'], effect: 'records' },
    ] },
    'scripts/hooks/sin-campos.js': '', 'scripts/hooks/paso-raro.js': '', 'scripts/hooks/frena-mudo.js': 'console.log("hola")\n',
    'scripts/hooks/cadena-que-falta.js': "require('./dispatch.js').dispatch('no-existe');\n",
    'skills/tycon-pipeline/scripts/dispatch.js': "module.exports = { CHAINS: { 'pre-edit': [], 'post-edit': [] } };\n",
  });
  const p = HIW().controlProblems(arbol).map((x) => x.spec).sort();
  assert.deepStrictEqual(p, ['@tcg:cadena-que-falta.js', '@tcg:frena-mudo.js', '@tcg:paso-raro.js', '@tcg:sin-campos.js']);
});

test('T8 Controles_EnSuPaso @story-2.61 @ac-6 — cada control en sus pasos; los de todo el recorrido, aparte', () => {
  const lista = require(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json')).hooks;
  const m = HIW().buildModel({ treeDir: ROOT, profileDir: null });
  const enPasos = new Set(m.steps.flatMap((s) => s.controls.map((c) => c.spec)));
  const enTodo = new Set(m.allSteps.controls.map((c) => c.spec));
  const despachadores = ['tycon-pipeline/scripts/hook-pre-edit.js', 'tycon-pipeline/scripts/hook-post-edit.js'];
  for (const h of lista) {
    if (despachadores.includes(h.spec)) continue;
    if (h.steps.includes('all')) assert.ok(enTodo.has(h.spec), `${h.spec} en «todo el recorrido»`);
    else assert.ok(enPasos.has(h.spec), `${h.spec} en sus pasos`);
  }
  for (const d of despachadores) assert.ok(!enPasos.has(d) && !enTodo.has(d), `${d}: se muestran sus hijos, no él`);
  const { CHAINS } = require(path.join(SCRIPTS, 'dispatch.js'));
  for (const hijo of [...CHAINS['pre-edit'], ...CHAINS['post-edit']]) assert.ok(enPasos.has(hijo.name) || enTodo.has(hijo.name), `hijo ${hijo.name}`);
  for (const c of [...m.allSteps.controls, ...m.steps.flatMap((s) => s.controls)]) assert.ok(['blocks', 'warns', 'records'].includes(c.effect), c.spec);
  // la página dibuja «frena» y «avisa» en sus controles, y un control opcional apagado de fábrica no dice que frena
  const html = TAB().renderPage(m, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  const paso4 = html.slice(html.indexOf('id="paso-implement"'), html.indexOf('id="paso-run-tests"'));
  assert.ok(paso4.includes(`ct-chip frena">${TX().t('es', 'comoTrabaja.frena')}<`) && paso4.includes('on-atdd-preedit'), 'el paso Implementar muestra un control que frena');
  const guardia = html.split('data-origin="harness"').find((x) => x.includes('session-collision-guard.js'));
  assert.ok(guardia && guardia.includes(TX().t('es', 'comoTrabaja.opcional', { variable: 'TYCON_SESSION_GUARD' })) && !guardia.split('</li>')[0].includes('ct-chip frena'), 'opcional, apagado de fábrica');
});

// ════════════════════════════════════════ la pantalla ════════════════════════════════════════

test('T9 ArnesSoloLectura @story-2.61 @ac-3 @ac-7 — lo del arnés no tiene campos ni «Editar»', () => {
  const m = HIW().buildModel({ treeDir: ROOT, profileDir: null });
  const html = TAB().renderPage(m, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  const piezas = html.split('data-origin="harness"').slice(1).map((x) => x.split('</li>')[0]);
  assert.ok(piezas.length > 20, `hay piezas del arnés (${piezas.length})`);
  for (const p of piezas) {
    assert.ok(!/<input|<textarea|<select/.test(p), 'sin campos');
    assert.ok(!p.includes('data-action="edit"'), 'sin «Editar»');
    assert.ok(p.includes('data-action="improve"'), 'con «Proponer una mejora»');
  }
  for (const a of html.match(/<a [^>]*class="btn"[^>]*>/g) || []) assert.ok(/target="_blank"/.test(a) && /rel="noopener"/.test(a), a);
  // la lista: los del recorrido en su orden y, aparte al final, los que no van en él (la tabla los tiene intercalados)
  const lista = html.slice(html.indexOf('<ol class="ct-pasos'), html.indexOf('</ol>'));
  const ids = [...lista.matchAll(/data-step="([^"]+)"/g)].map((x) => x[1]);
  const { STEPS, CLOSE_STEP } = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  assert.deepStrictEqual(ids, [...STEPS, CLOSE_STEP].map((s) => s.id).concat('todo'));
  assert.ok(lista.indexOf('ct-aparte') < lista.indexOf('data-step="close-work-item"'), '«Fuera del recorrido» antes de los de afuera');
});

test('T16 ProponerMejora_IssueCompleto @story-2.61 @ac-7 — un issue del público con título y cuerpo, sin credencial', () => {
  const { issueUrl, ISSUE_URL_MAX } = TAB();
  assert.strictEqual(ISSUE_URL_MAX, 7000);
  const base = { publicRepo: PUBLICO, piece: 'guides/agent-architecture.md', stepName: 'Revisores', version: '2026.10.19.3' };
  const u = new URL(issueUrl({ ...base, text: 'No dice qué hacer si el paquete está roto & "ya".', idioma: 'es' }).url);
  assert.strictEqual(`${u.origin}${u.pathname}`, `${PUBLICO}/issues/new`);
  assert.strictEqual(u.searchParams.get('title'), 'Mejora: agent-architecture.md (Revisores)');
  const cuerpo = u.searchParams.get('body');
  for (const parte of ['No dice qué hacer si el paquete está roto & "ya".', 'guides/agent-architecture.md', 'Revisores', '2026.10.19.3']) assert.ok(cuerpo.includes(parte), parte);
  const en = new URL(issueUrl({ ...base, stepName: 'Reviewers', text: 'x', idioma: 'en' }).url);
  assert.match(en.searchParams.get('title'), /^Improvement: agent-architecture\.md \(Reviewers\)$/);
  assert.ok(!hasSpanish(en.searchParams.get('body').replace('x', '')), 'el cuerpo en inglés no trae castellano');
  assert.deepStrictEqual(issueUrl({ ...base, text: '   ', idioma: 'es' }), { url: null, cut: false }, 'vacío: sin enlace');
  const largo = issueUrl({ ...base, text: 'ñ'.repeat(20000), idioma: 'es' });
  assert.ok(largo.cut && largo.url.length <= 7000, `cortado (${largo.url.length})`);
  assert.ok(new URL(largo.url).searchParams.get('body').includes('…'));
});

test('T10 Revisar_ConElLectorDelPipeline @story-2.61 @ac-8 — el borrador pasa por validarManifiesto y la cabecera del agente', () => {
  const perfil = carpeta(perfilCon());
  const valido = { pack: 'acme-pagos', original: 'acme-pagos-reviewer', agent: 'acme-pagos-reviewer', group: 'condicional', detection: 'pyModified', paths: ['**/pagos/**/*.py'], prefix: 'PAGOS', instructions: AGENTE('acme-pagos-reviewer') };
  const ok = TAB().reviewDraft({ profileDir: perfil, draft: valido });
  assert.deepStrictEqual(ok.problems, []);
  assert.ok(ok.ok);
  const casos = [
    [{ agent: 'Acme-Malo', instructions: AGENTE('Acme-Malo') }, /minúsculas y guiones/],
    [{ paths: [] }, /surface/],
    [{ instructions: '---\nname: acme-pagos-reviewer\ndescription: x\ntools: Read\n---\n\n   \n' }, /instrucciones/],
    [{ instructions: AGENTE('otro-nombre') }, /name/],
    // un revisor nuevo sin condición elegida: se dice qué falta (antes, el error del validador sobre «when»)
    [{ original: null, agent: 'acme-nuevo-reviewer', detection: '', instructions: AGENTE('acme-nuevo-reviewer') }, /elegí qué tiene que tocar el cambio/],
  ];
  for (const [cambio, rx] of casos) {
    const r = TAB().reviewDraft({ profileDir: perfil, draft: { ...valido, ...cambio } });
    assert.strictEqual(r.ok, false, JSON.stringify(cambio));
    assert.match(r.problems.join(' · '), rx);
  }
  // el campo «extra» del navegador ya no existe: una clave desconocida sólo llega si ya estaba en el paquete, y la frena
  // el lector
  const conExtra = TAB().reviewDraft({ profileDir: perfil, draft: { ...valido, extra: { color: 'rojo' } } });
  assert.ok(conExtra.ok && !/"color"/.test(conExtra.files[0].contenido), 'lo que manda el navegador fuera de los campos no entra al paquete');
  const conClave = carpeta(perfilCon({ paquete: { ...PAQUETE(), reviewers: [{ ...PAQUETE().reviewers[0], color: 'rojo' }] } }));
  assert.match(TAB().reviewDraft({ profileDir: conClave, draft: valido }).problems.join(' · '), /clave «color» fuera del vocabulario/);
  // vaciar el prefijo de un revisor que ya tenía: queda vacío, no se conserva el viejo en silencio
  assert.deepStrictEqual(JSON.parse(TAB().reviewDraft({ profileDir: perfil, draft: { ...valido, prefix: '' } }).files[0].contenido).reviewers[0].prefixes, []);
  // el nombre entre comillas en la cabecera es el mismo nombre
  assert.deepStrictEqual(TAB().reviewDraft({ profileDir: perfil, draft: { ...valido, instructions: AGENTE('acme-pagos-reviewer').replace('name: acme-pagos-reviewer', 'name: "acme-pagos-reviewer"') } }).problems, []);
  // un revisor que ya declara OTRO paquete (del perfil o del árbol): el lector lo frena, como cuando el pipeline los carga
  const dos = carpeta(perfilCon({ extra: { 'packs/acme-otros/pack.json': { ...PAQUETE(['acme-otro-reviewer']), name: 'acme-otros' }, 'packs/acme-otros/agents/acme-otro-reviewer.md': AGENTE('acme-otro-reviewer') } }));
  const repetido = TAB().reviewDraft({ profileDir: dos, draft: { ...valido, original: null, agent: 'acme-otro-reviewer', instructions: AGENTE('acme-otro-reviewer') } });
  assert.match(repetido.problems.join(' · '), /ya lo declara otro paquete/);
  // «mira todos los archivos» se conserva mientras no se escriban archivos
  const siempre = carpeta(perfilCon({ paquete: { ...PAQUETE(), reviewers: [{ ...PAQUETE().reviewers[0], surface: { always: true } }] } }));
  const d = TAB().draftOf(siempre, 'acme-pagos', 'acme-pagos-reviewer').draft;
  assert.ok(d.uses[0].always && !d.uses[0].paths.length);
  const conSiempre = TAB().reviewDraft({ profileDir: siempre, draft: { ...d } });
  assert.deepStrictEqual(conSiempre.problems, []);
  assert.deepStrictEqual(JSON.parse(conSiempre.files[0].contenido).reviewers[0].surface, { always: true });
  // una carpeta de agentes que sale del paquete: no se escribe ni se lee nada fuera de él
  const sale = carpeta(perfilCon({ paquete: { ...PAQUETE(), agents: '../..' } }));
  assert.match(TAB().reviewDraft({ profileDir: sale, draft: valido }).problems.join(' '), /sale de su carpeta/);
  assert.ok(TAB().draftOf(sale, 'acme-pagos', 'acme-pagos-reviewer').error);
  // un .md que es un enlace simbólico no se abre: el editor mostraría el archivo al que apunta
  const enlace = carpeta(perfilCon());
  const md = path.join(enlace, 'packs', 'acme-pagos', 'agents', 'acme-pagos-reviewer.md');
  const secreto = path.join(carpeta({ 'secreto.txt': 'no se ve\n' }), 'secreto.txt');
  fs.rmSync(md); fs.symlinkSync(secreto, md);
  assert.match(TAB().draftOf(enlace, 'acme-pagos', 'acme-pagos-reviewer').error, /no es un archivo común/);
  // y «Revisar» sobre ese paquete no escribe a través del enlace: el archivo al que apunta queda igual
  TAB().reviewDraft({ profileDir: enlace, draft: valido });
  assert.strictEqual(fs.readFileSync(secreto, 'utf8'), 'no se ve\n');
  // tampoco si la carpeta de agentes entera es un enlace a otra carpeta: el .md de afuera queda igual
  const carpetaEnlazada = carpeta(perfilCon());
  const afuera = carpeta({ 'acme-pagos-reviewer.md': 'el de afuera\n' });
  fs.rmSync(path.join(carpetaEnlazada, 'packs', 'acme-pagos', 'agents'), { recursive: true });
  fs.symlinkSync(afuera, path.join(carpetaEnlazada, 'packs', 'acme-pagos', 'agents'));
  TAB().reviewDraft({ profileDir: carpetaEnlazada, draft: valido });
  assert.strictEqual(fs.readFileSync(path.join(afuera, 'acme-pagos-reviewer.md'), 'utf8'), 'el de afuera\n');
  assert.ok(!fs.existsSync(path.join(sale, 'acme-pagos-reviewer.md')) && !fs.existsSync(path.join(path.dirname(sale), 'acme-pagos-reviewer.md')));
});

test('T13 ComoTrabaja_SinPerfilDiceElMotivo @story-2.61 @ac-11 — sin perfil, bajando o roto, el motivo', () => {
  const html = (profile) => TAB().renderPage(HIW().buildModel({ treeDir: ROOT, profileDir: profile.dir, profileState: profile.estado, profileReason: profile.motivo }), { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  assert.ok(html({ dir: null, estado: 'no_configurado' }).includes(TX().t('es', 'comoTrabaja.perfilNoConfigurado')));
  assert.ok(html({ dir: null, estado: 'bajando', motivo: 'bajando el perfil' }).includes('bajando el perfil'));
  const roto = carpeta(perfilCon({ paquete: { name: 'acme-pagos', description: 'x', reviewers: 'no-es-lista' } }));
  const h = html({ dir: roto, estado: 'leido' });
  assert.match(h, /«reviewers» tiene que ser una lista no vacía/);
  assert.ok(!h.includes(TX().t('es', 'comoTrabaja.sinRevisoresOrg')), 'nunca «no hay revisores» con un paquete roto');
});

// ── el revisor del perfil se lee donde está ──
// Un paquete del perfil que no declara su carpeta de agentes, con un revisor de dos usos: su .md vive en la carpeta
// agents/ del paquete. En agents/ de la raíz del perfil es un problema (lo mide T11 NoEditable_SoloRoto).
const PAQUETE_RAIZ = () => ({
  name: 'acme-clientes', description: 'Los revisores de los clientes de Acme.',
  reviewers: [
    { agent: 'acme-hermanos-reviewer', group: 'condicional', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'deep', prefixes: ['HERM'] },
    { agent: 'acme-hermanos-reviewer', group: 'validacion', when: { detection: 'csModified' }, model: 'sonnet', prompt: 'Validá {story_path} en {repo_path}', prefixes: ['HERM'] },
  ],
});
const perfilRaiz = ({ conAgente = true } = {}) => carpeta(perfilCon({ paquete: null, extra: {
  'packs/acme-clientes/pack.json': PAQUETE_RAIZ(),
  ...(conAgente ? { 'packs/acme-clientes/agents/acme-hermanos-reviewer.md': AGENTE('acme-hermanos-reviewer') } : {}),
} }));
const deClientes = (m, id) => m.steps.find((s) => s.id === id).reviewers.packs.filter((r) => r.pack === 'acme-clientes');

test('T1 Perfil_RevisorEnAgentsDeLaRaiz_Activo @story-2.64 @ac-1 — el paquete se lee como lo lee el instalador', () => {
  const m = HIW().buildModel({ treeDir: ROOT, profileDir: perfilRaiz() });
  const p = m.packs.find((x) => x.name === 'acme-clientes');
  assert.deepStrictEqual(p.problems, []);
  assert.ok(m.org.packs.active.includes('acme-clientes'), 'activo con packs.default all');
  const [cond] = deClientes(m, 'reviewers');
  assert.ok(cond && cond.active === true && cond.editable === true, 'el uso condicional, activo y editable');
  assert.strictEqual(cond.md, 'packs/acme-clientes/agents/acme-hermanos-reviewer.md');
});

test('T2 Editor_AbreConLasInstruccionesDeLaRaiz @story-2.64 @ac-2 — el borrador trae el .md de agents/ del perfil', () => {
  const r = TAB().draftOf(perfilRaiz(), 'acme-clientes', 'acme-hermanos-reviewer');
  assert.ok(!r.error, r.error);
  // la cabecera viene en campos y el cuerpo aparte: los dos salen del .md de agents/
  assert.strictEqual(TAB().armarAgente(r.draft.cabecera, r.draft.cuerpo), AGENTE('acme-hermanos-reviewer'));
  assert.strictEqual(r.md, 'packs/acme-clientes/agents/acme-hermanos-reviewer.md');
});

test('T3 Proponer_EscribeDondeEsta @story-2.64 @ac-3 — revisar y proponer sin crear una segunda copia', () => {
  const perfil = perfilRaiz();
  const { draft } = TAB().draftOf(perfil, 'acme-clientes', 'acme-hermanos-reviewer');
  const usos = draft.uses.map((u) => (u.group === 'validacion' ? u : { ...u, paths: ['**/*.cs', '**/*.csproj'] }));
  const md = path.join(perfil, 'packs', 'acme-clientes', 'agents', 'acme-hermanos-reviewer.md');
  const antes = fs.readFileSync(md, 'utf8');
  const r = TAB().reviewDraft({ profileDir: perfil, draft: { ...draft, uses: usos, cuerpo: draft.cuerpo.replace('registro de pagos', 'registro de pagos y cobros') } });
  assert.deepStrictEqual(r.problems, []);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.files.map((f) => f.archivo), ['packs/acme-clientes/pack.json', 'packs/acme-clientes/agents/acme-hermanos-reviewer.md']);
  assert.match(r.files[1].contenido, /pagos y cobros/);
  assert.strictEqual(fs.readFileSync(md, 'utf8'), antes, 'el perfil no se toca al revisar');
  assert.ok(!fs.existsSync(path.join(perfil, 'agents')), 'ni nace una copia en agents/ de la raíz');
  // un revisor nuevo nace donde lo busca el validador: en la carpeta de agentes de su paquete, declarada o no
  const nuevo = TAB().reviewDraft({ profileDir: perfil, draft: { pack: 'acme-clientes', agent: 'acme-nuevo-reviewer', group: 'condicional', detection: 'csModified', paths: ['**/*.cs'], prefix: 'NUEVO', instructions: AGENTE('acme-nuevo-reviewer') } });
  assert.deepStrictEqual(nuevo.problems, []);
  assert.strictEqual(nuevo.files[1].archivo, 'packs/acme-clientes/agents/acme-nuevo-reviewer.md');
  const hoy = carpeta(perfilCon());
  const nuevoEnSuPaquete = TAB().reviewDraft({ profileDir: hoy, draft: { pack: 'acme-pagos', agent: 'acme-nuevo-reviewer', group: 'condicional', detection: 'pyModified', paths: ['**/*.py'], prefix: 'NUEVO', instructions: AGENTE('acme-nuevo-reviewer') } });
  assert.deepStrictEqual(nuevoEnSuPaquete.problems, []);
  assert.strictEqual(nuevoEnSuPaquete.files[1].archivo, 'packs/acme-pagos/agents/acme-nuevo-reviewer.md');
  const pagos = TAB().reviewDraft({ profileDir: hoy, draft: TAB().draftOf(hoy, 'acme-pagos', 'acme-pagos-reviewer').draft });
  assert.deepStrictEqual(pagos.files.map((f) => f.archivo), ['packs/acme-pagos/pack.json', 'packs/acme-pagos/agents/acme-pagos-reviewer.md']);
  // en los dos lugares, el editor no lo da por bueno
  const doble = carpeta(perfilCon({ extra: { 'agents/acme-pagos-reviewer.md': AGENTE('acme-pagos-reviewer') } }));
  assert.ok(TAB().reviewDraft({ profileDir: doble, draft: TAB().draftOf(doble, 'acme-pagos', 'acme-pagos-reviewer').draft }).problems.some((x) => /dos lugares/.test(x)));
});

test('T7 Editor_SinRutasNiEnlaces @story-2.64 @ac-2 @ac-6 — los mensajes del editor sin rutas de la máquina; agents/ enlazada no se lee', () => {
  // otro paquete del perfil declara el mismo revisor: el mensaje nombra su manifiesto, relativo
  const perfil = carpeta(perfilCon({ paquete: null, extra: {
    'packs/acme-clientes/pack.json': PAQUETE_RAIZ(),
    'packs/acme-clientes/agents/acme-hermanos-reviewer.md': AGENTE('acme-hermanos-reviewer'),
    'packs/acme-otro/pack.json': { name: 'acme-otro', description: 'x', agents: 'agents', reviewers: [{ agent: 'acme-hermanos-reviewer', group: 'base', surface: { paths: ['**/*.cs'] }, depth: 'lean', prefixes: ['OTRO'] }] },
  } }));
  const { draft } = TAB().draftOf(perfil, 'acme-clientes', 'acme-hermanos-reviewer');
  const r = TAB().reviewDraft({ profileDir: perfil, draft });
  assert.ok(r.problems.some((x) => /otro paquete/.test(x)), 'el repetido se dice');
  for (const x of r.problems) for (const absoluta of [perfil, ROOT, os.tmpdir()]) assert.ok(!x.includes(absoluta), `sin la ruta ${absoluta}: ${x}`);
  // la carpeta de agentes del paquete es un enlace a una carpeta de afuera: el editor no la lee
  const afuera = carpeta({ 'acme-hermanos-reviewer.md': AGENTE('acme-hermanos-reviewer') });
  const enlazado = carpeta(perfilCon({ paquete: null, extra: { 'packs/acme-clientes/pack.json': PAQUETE_RAIZ() } }));
  fs.symlinkSync(afuera, path.join(enlazado, 'packs', 'acme-clientes', 'agents'));
  assert.match(TAB().draftOf(enlazado, 'acme-clientes', 'acme-hermanos-reviewer').error || '', /no es un archivo común/);
});

test('T4 NoEditable_DiceElMotivo @story-2.64 @ac-4 — un paquete roto y un uso que valida la historia dicen por qué', () => {
  const pagina = (perfil, idioma) => TAB().renderPage(HIW().buildModel({ treeDir: ROOT, profileDir: perfil }), { idioma, publicRepo: PUBLICO, version: 'v' });
  for (const idioma of ['es', 'en']) {
    const prefijo = TX().t(idioma, 'comoTrabaja.noEditableRoto', { motivo: '' }).trim();
    // el uso que valida la historia también se edita: en un paquete sano, ningún «no se puede editar»
    const sano = pagina(perfilRaiz(), idioma);
    assert.ok(!sano.includes(prefijo), `${idioma}: un paquete sano se edita entero`);
    const roto = pagina(perfilRaiz({ conAgente: false }), idioma);
    assert.ok(roto.includes(prefijo), `${idioma}: el motivo del paquete roto`);
    const primero = TX().t(idioma, 'comoTrabaja.faltaAgente', { revisor: 'acme-hermanos-reviewer', rutas: 'packs/acme-clientes/agents/acme-hermanos-reviewer.md' });
    assert.ok(roto.includes(TX().t(idioma, 'comoTrabaja.noEditableRoto', { motivo: primero })), `${idioma}: con el primer problema del paquete`);
    for (const html of [sano, roto]) assert.ok(!html.includes('Se edita a mano') && !html.includes('edited by hand'), `${idioma}: sin «Se edita a mano»`);
    if (idioma === 'en') for (const k of ['noEditableRoto', 'faltaAgente']) assert.ok(!hasSpanish(TX().t('en', `comoTrabaja.${k}`, { motivo: 'x', revisor: 'x', rutas: 'x' })), k);
  }
});

test('T6 PaqueteRoto_UnaVezEnLlano @story-2.64 @ac-6 — el agente que falta, una vez, con las rutas del perfil', () => {
  const perfil = perfilRaiz({ conAgente: false });
  const m = HIW().buildModel({ treeDir: ROOT, profileDir: perfil });
  const p = m.packs.find((x) => x.name === 'acme-clientes');
  assert.strictEqual(new Set(p.problems).size, p.problems.length, 'sin problemas repetidos');
  // el paquete no declara carpeta de agentes: el validador lo busca en la de siempre del paquete, y eso se dice
  assert.deepStrictEqual(p.missing, [{ agent: 'acme-hermanos-reviewer', expected: ['packs/acme-clientes/agents/acme-hermanos-reviewer.md'] }]);
  const conCarpeta = carpeta(perfilCon({ paquete: null, extra: { 'packs/acme-clientes/pack.json': { ...PAQUETE_RAIZ(), agents: 'revisores' } } }));
  fs.mkdirSync(path.join(conCarpeta, 'packs', 'acme-clientes', 'revisores'));
  assert.deepStrictEqual(HIW().buildModel({ treeDir: ROOT, profileDir: conCarpeta }).packs.find((x) => x.name === 'acme-clientes').missing[0].expected,
    ['packs/acme-clientes/revisores/acme-hermanos-reviewer.md'], 'con carpeta declarada, ésa');
  for (const idioma of ['es', 'en']) {
    const html = TAB().renderPage(m, { idioma, publicRepo: PUBLICO, version: 'v' });
    const errores = html.match(/<p class="ct-error">[^]*?<\/p>/g) || [];
    assert.ok(errores.length > 0, 'el paquete muestra su error');
    for (const e of errores.filter((x) => x.includes('acme-clientes'))) {
      assert.strictEqual(e.split('acme-hermanos-reviewer').length - 1, 2, `${idioma}: el revisor una vez (más su ruta): ${e}`);
      assert.ok(e.includes('agents/acme-hermanos-reviewer.md'), 'dónde debería estar');
    }
    for (const absoluta of [perfil, ROOT, os.tmpdir(), '/app/']) assert.ok(!html.includes(absoluta), `${idioma}: sin la ruta ${absoluta}`);
  }
  for (const pr of p.problems) assert.ok(!pr.includes(perfil) && !pr.includes(ROOT), `el modelo sin rutas absolutas: ${pr}`);
});

test('T5 PaquetesDeHoy_IgualQueAntes @story-2.64 @ac-5 — el agente dentro de su paquete, los del árbol y el doble', () => {
  const hoy = carpeta(perfilCon());
  const m = HIW().buildModel({ treeDir: ROOT, profileDir: hoy });
  assert.deepStrictEqual(m.packs.find((x) => x.name === 'acme-pagos').problems, []);
  assert.deepStrictEqual(m.packs.filter((x) => x.origin === 'harness' && x.problems.length).map((x) => x.name), [], 'los del árbol, sin problemas');
  assert.strictEqual(TAB().draftOf(hoy, 'acme-pagos', 'acme-pagos-reviewer').md, 'packs/acme-pagos/agents/acme-pagos-reviewer.md');
  const doble = carpeta(perfilCon({ extra: { 'agents/acme-pagos-reviewer.md': AGENTE('acme-pagos-reviewer') } }));
  assert.ok(HIW().buildModel({ treeDir: ROOT, profileDir: doble }).packs.find((x) => x.name === 'acme-pagos').problems.some((x) => /dos lugares/.test(x)), 'en los dos lugares sigue siendo un problema');
});

test('T14 ComoTrabaja_TextosYTema @story-2.61 @ac-12 — dos idiomas sin castellano en el inglés, variables del tema y teléfono', () => {
  const { TEXTOS } = TX();
  const claves = Object.keys(TEXTOS).filter((k) => /^(comoTrabaja|paso|revisorCuando|bandera|segun)\./.test(k));
  assert.ok(claves.length > 40, `claves nuevas (${claves.length})`);
  for (const k of claves) {
    assert.ok(TEXTOS[k].es && TEXTOS[k].en, `${k}: es y en`);
    assert.ok(!hasSpanish(TEXTOS[k].en), `${k}: el inglés sin castellano («${TEXTOS[k].en}»)`);
  }
  const { STEPS } = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  for (const s of STEPS) {
    assert.strictEqual((TEXTOS[`paso.${s.id}`] || {}).es, s.name, `paso.${s.id}: el nombre en castellano es el de steps.js`);
    assert.ok(TEXTOS[`paso.${s.id}.objetivo`], `paso.${s.id}.objetivo`);
  }
  const { BANDERAS } = require(path.join(SCRIPTS, 'lib', 'packs.js'));
  for (const b of BANDERAS) assert.ok(TEXTOS[`bandera.${b}`], `bandera.${b}`);
  for (const c of HIW().STORY_CONDITIONALS) assert.ok(TEXTOS[c.textKey] && TEXTOS[`${c.textKey}.pieza`], c.id);
  const css = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'static', 'site.css'), 'utf8');
  const propio = css.slice(css.indexOf('/* cómo trabaja */'));
  assert.ok(propio.length > 200, 'la hoja tiene la parte de la pestaña');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(propio.split('/* fin de cómo trabaja */')[0]), 'sólo variables de color');
  assert.match(propio, /@(media|container)[^{]*max-width:\s*700px/, 'la regla de teléfono');
});

test('T17 ComoTrabaja_DosOrganizaciones @story-2.61 @ac-15 — cada organización con lo suyo, de los lectores del arnés', () => {
  const GH = (repo) => ({ platform: 'github', org: 'acme', repo });
  const REPOS = (rules) => ({ version: 1, public: GH('arnes'), profile: GH('perfil'), operations: GH('operaciones'), stack: { rules } });
  const A = carpeta(perfilCon({ profile: { integrations: { clockify: true, engram: true }, packs: { default: 'all' } }, repos: REPOS({ test_names: 'pascal' }) }));
  const B = carpeta(perfilCon({ profile: { integrations: { clockify: false, engram: false }, packs: { default: 'none' } }, repos: REPOS({ test_names: 'snake' }) }));
  // la máquina donde corre el sitio, con todo prendido: no cambia nada
  const casa = carpeta({ '.claude/tycon.json': { integrations: { clockify: false, engram: true } } });
  const viejo = process.env.HOME; process.env.HOME = casa;
  try {
    const mA = HIW().buildModel({ treeDir: ROOT, profileDir: A });
    const mB = HIW().buildModel({ treeDir: ROOT, profileDir: B });
    // las del lector, sin Telegram: es de cada máquina, no de la organización
    const delLector = (dir) => { const i = TC.integraciones(TC.cargar({ env: { TYCON_PROFILE: path.join(dir, 'team-profile.json') }, home: tmp('hiw-home-') })); delete i.telegram; return i; };
    assert.deepStrictEqual(mA.org.integrations, delLector(A));
    assert.deepStrictEqual(mB.org.integrations, delLector(B));
    const SC = require(path.join(SCRIPTS, 'lib', 'stack-config.js'));
    assert.deepStrictEqual(mA.org.rules, SC.orgRules({ file: path.join(A, 'team-repos.json') }).rules);
    assert.strictEqual(mA.org.rules.test_names.value, 'pascal');
    assert.strictEqual(mB.org.rules.test_names.value, 'snake');
    const paso = (m, id) => m.steps.find((s) => s.id === id);
    const piezasReloj = (m) => m.steps.flatMap((s) => s.orgPieces || []).filter((x) => x.integration === 'clockify');
    assert.ok(piezasReloj(mA).length, 'A: el registro de horas, en sus pasos');
    assert.deepStrictEqual(piezasReloj(mB), [], 'B: apagado en la organización, no aparece');
    const controlesReloj = (m) => [...m.allSteps.controls, ...m.steps.flatMap((s) => s.controls)].filter((c) => c.integration === 'clockify');
    assert.ok(controlesReloj(mA).length, 'A: sus controles');
    assert.deepStrictEqual(controlesReloj(mB), [], 'B: ni sus controles');
    // con «all» también entran los paquetes que trae el árbol (el del equipo, encima del público): el de A y todos esos
    const delArbol = fs.existsSync(path.join(ROOT, 'packs')) ? fs.readdirSync(path.join(ROOT, 'packs'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
    assert.deepStrictEqual([...mA.org.packs.active].sort(), [...new Set(['acme-pagos', ...delArbol])].sort());
    assert.deepStrictEqual(mB.org.packs.active, []);
    assert.ok(paso(mA, 'reviewers').reviewers.packs.some((r) => r.agent === 'acme-pagos-reviewer' && r.active));
    assert.ok(paso(mB, 'reviewers').reviewers.packs.every((r) => !r.active), 'B no tiene activo el paquete');
    const hB = TAB().renderPage(mB, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
    assert.ok(!hB.includes('clocki/'), 'B: nada del registro de horas en la página');
  } finally { process.env.HOME = viejo; }
});

test('T18 SegunLaHistoria_LaDecideElArnes @story-2.61 @ac-16 — cada pieza condicional pasa por la función real del arnés', () => {
  const { STORY_CONDITIONALS, checkConditionals } = HIW();
  const ids = STORY_CONDITIONALS.map((c) => c.id);
  for (const id of ['mockup', 'mockupApproval', 'browserTest', 'screenReadability', 'adversarial', 'runSize', 'liveTest', 'testerGuide', 'adoWorkItem', 'sqlCompile']) assert.ok(ids.includes(id), id);
  assert.deepStrictEqual(checkConditionals(STORY_CONDITIONALS), []);
  const rota = [{ ...STORY_CONDITIONALS[0], id: 'rota', decider: { module: 'skills/tycon-pipeline/scripts/lib/ui-signal.js', fn: 'noExiste' } }];
  assert.match(checkConditionals(rota).map((p) => p.message).join(' '), /noExiste/);
  const alReves = [{ ...STORY_CONDITIONALS[0], id: 'al-reves', probes: { yes: STORY_CONDITIONALS[0].probes.no, no: STORY_CONDITIONALS[0].probes.yes } }];
  assert.deepStrictEqual(checkConditionals(alReves).map((p) => p.id), ['al-reves', 'al-reves'], 'no dispara con «sí» y dispara con «no»');
  const m = HIW().buildModel({ treeDir: ROOT, profileDir: null });
  const paso = (id) => m.steps.find((s) => s.id === id).storyPieces.map((p) => p.id);
  assert.ok(paso('plan').includes('mockup'));
  assert.ok(paso('approve-plan').includes('mockupApproval'));
  for (const id of ['browserTest', 'screenReadability']) assert.ok(paso('live-check').includes(id), id);
  const html = TAB().renderPage(m, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  assert.ok(html.includes(TX().t('es', 'segun.pantalla')), 'la condición en llano');
  assert.ok(html.includes(`${PUBLICO}/blob/main/skills/tycon-pipeline/scripts/mockup.js`), 'el código de la maqueta');
});

// ════════════════════════════════════════ el sitio ════════════════════════════════════════

const SIN_BACKEND = !hayHttpBackend() && !process.env.CI && 'git http-backend no está en esta máquina: el repo por HTTP no se puede armar';
const ESCRITURA = `w-${crypto.randomBytes(6).toString('hex')}`;
const CAB = `Basic ${Buffer.from(`x-access-token:${ESCRITURA}`).toString('base64')}`;

/** El sitio con la pestaña; `perfil` es la carpeta del clon del perfil (o null). */
async function conSitio({ perfil = null, env = {}, opciones = {} }, fn) {
  let emisor = null; let h = null;
  try {
    emisor = await arrancarEmisor();
    const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
    const envSitio = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, ...env });
    const cfg = validarConfiguracion(envSitio).cfg;
    const fuentes = H.fuentesFijas({ config: { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] }, people: { machines: { 'maq-a': { person: DEV, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' } } } } });
    fuentes.clones = () => ({ operaciones: null, perfil: perfil ? { dir: perfil } : null });
    fuentes.exclusivo = (f) => f();
    const rutasExtra = TAB().crearRutas({ cfg, fuentes, versionImagen: '2026.10.19.3', ...opciones });
    h = await H.arrancarSitio({ env: envSitio, fuentes, rutasExtra });
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    const token = async (cookie) => { const p = await h.pedir('/como-trabaja', { cookie }); const m = /<meta name="site-token" content="([^"]+)">/.exec(p.texto); return m ? m[1] : null; };
    const escribir = (ruta, cookie, tok, cuerpo) => h.pedir(ruta, { method: 'POST', cookie, body: JSON.stringify(cuerpo), headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-site-token': tok } });
    await fn({ h, entrar, token, escribir });
  } finally { await Promise.allSettled([h, emisor].filter(Boolean).map((s) => s.cerrar())); }
}

test('T1 ComoTrabaja_SoloMantenedores @story-2.61 @ac-1 — el mantenedor la ve; el dev, 403 en la página y en las rutas', async () => {
  // el clon del perfil es un repo git (el editor lee de ahí las versiones de los archivos)
  await conSitio({ perfil: carpeta(perfilCon(), { repo: true }) }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    const p = await h.pedir('/como-trabaja', { cookie: lead });
    assert.strictEqual(p.status, 200);
    assert.ok(p.texto.includes('href="/como-trabaja"'), 'la pestaña en la barra');
    assert.ok(p.texto.includes(TX().t('es', 'paso.reviewers')));
    // el editor pide el revisor de hoy; uno que no está da 404 con su motivo
    const hoy = await h.pedir('/api/como-trabaja/revisor?pack=acme-pagos&agent=acme-pagos-reviewer', { cookie: lead });
    assert.strictEqual(hoy.status, 200);
    assert.strictEqual(TAB().armarAgente(hoy.json.draft.cabecera, hoy.json.draft.cuerpo), AGENTE('acme-pagos-reviewer'));
    assert.deepStrictEqual(hoy.json.modelos.map((m) => m.valor), ['', 'economy', 'balanced', 'strong', 'max'], 'con los modelos que puede elegir');
    const noEsta = await h.pedir('/api/como-trabaja/revisor?pack=acme-pagos&agent=otro-reviewer', { cookie: lead });
    assert.strictEqual(noEsta.status, 404);
    assert.match(noEsta.json.message, /ya no está/);
    const dev = await entrar(DEV);
    const inicio = await h.pedir('/', { cookie: dev });
    assert.ok(!inicio.texto.includes('href="/como-trabaja"'), 'el dev no la ve en la barra');
    for (const [method, ruta] of [['GET', '/como-trabaja'], ['GET', '/api/como-trabaja/revisor?pack=acme-pagos&agent=acme-pagos-reviewer'], ['POST', '/api/como-trabaja/revisar'], ['POST', '/api/como-trabaja/proponer']]) {
      const r = await h.pedir(ruta, { method, cookie: dev, body: method === 'POST' ? '{}' : undefined, headers: method === 'POST' ? { 'content-type': 'application/json', origin: 'http://127.0.0.1' } : {} });
      assert.strictEqual(r.status, 403, `${method} ${ruta}`);
    }
  });
});

/** El perfil servido por HTTP y el clon del sitio sobre él. */
async function perfilPorHttp(archivos) {
  const raiz = tmp('hiw-http-');
  const enTexto = Object.fromEntries(Object.entries(archivos).map(([k, v]) => [k, typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`]));
  const r = await crearRepoHttp({ raiz, nombre: 'perfil.git', archivos: enTexto, cabecera: CAB });
  const dir = path.join(raiz, 'clon-del-sitio');
  try { await require('util').promisify(execFile)('git', ['-c', `http.extraheader=Authorization: ${CAB}`, 'clone', '-q', '--depth', '1', '--branch', 'main', r.url, dir]); } catch (e) { await r.cerrar(); throw e; }
  return { r, dir };
}

test('T11 Proponer_DosArchivosUnPedido @story-2.61 @ac-9 @ac-10 — editar y sumar: un pedido con pack.json y el .md', { skip: SIN_BACKEND }, async () => {
  const { arrancarGithubFalso } = require('./lib/fake-github-api.js');
  let gh; let r; let dir;
  const remotos = { perfil: { platform: 'github', org: 'acme', repo: 'perfil', web: 'https://github.example/acme/perfil' } };
  try {
    gh = await arrancarGithubFalso({ owner: 'acme', repo: 'perfil' });
    gh.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
    ({ r, dir } = await perfilPorHttp(perfilCon()));
    await conSitio({ perfil: dir, env: { SITE_PROFILE_WRITE_TOKEN: ESCRITURA }, opciones: { remotos, urlBase: { github: gh.base } } }, async ({ entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      // un borrador inválido que no pasó por «Revisar» se rechaza igual
      const malo = { pack: 'acme-pagos', original: 'acme-pagos-reviewer', agent: 'Malo', group: 'condicional', detection: 'pyModified', paths: ['**/*.py'], prefix: 'PAGOS', instructions: AGENTE('Malo') };
      const rechazo = (await escribir('/api/como-trabaja/proponer', lead, tok, { draft: malo, versions: {} })).json;
      assert.strictEqual(rechazo.ok, false);
      assert.deepStrictEqual(r.empujes, [], 'nada empujado');
      // editar: revisar y proponer
      const edit = { ...malo, agent: 'acme-pagos-reviewer', paths: ['**/pagos/**/*.py', '**/cobros/**/*.py'], instructions: AGENTE('acme-pagos-reviewer').replace('registro de pagos', 'registro de pagos y cobros') };
      const rev = (await escribir('/api/como-trabaja/revisar', lead, tok, { draft: edit })).json;
      assert.strictEqual(rev.ok, true, JSON.stringify(rev));
      const p = (await escribir('/api/como-trabaja/proponer', lead, tok, { draft: edit, versions: rev.versions })).json;
      assert.ok(p.ok, JSON.stringify(p));
      const rama = r.empujes.at(-1).ref.replace('refs/heads/', '');
      // el nombre del paquete va adelante en la rama: «svelte» no confunde su pedido abierto con el de «svelte-fastapi»
      assert.match(rama, /^team-config\/acme-pagos\.reviewers-/);
      const pack = JSON.parse(r.archivoEn(rama, 'packs/acme-pagos/pack.json'));
      assert.deepStrictEqual(pack.reviewers[0].surface.paths, edit.paths);
      assert.deepStrictEqual({ ...pack, reviewers: null }, { ...PAQUETE(), reviewers: null }, 'el resto del manifiesto igual');
      assert.match(r.archivoEn(rama, 'packs/acme-pagos/agents/acme-pagos-reviewer.md'), /pagos y cobros/);
      assert.strictEqual(gh.st.pedidos.length, 1, 'un solo pedido');
    });
  } finally { await Promise.allSettled([r, gh].filter(Boolean).map((s) => s.cerrar())); }
});

test('T11b Proponer_SumarYCambioConcurrente @story-2.61 @ac-9 @ac-10 — uno nuevo al final; si otro cambió el manifiesto, avisa', { skip: SIN_BACKEND }, async () => {
  const { arrancarGithubFalso } = require('./lib/fake-github-api.js');
  let gh; let r; let dir;
  const remotos = { perfil: { platform: 'github', org: 'acme', repo: 'perfil', web: 'https://github.example/acme/perfil' } };
  try {
    gh = await arrancarGithubFalso({ owner: 'acme', repo: 'perfil' });
    gh.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
    ({ r, dir } = await perfilPorHttp(perfilCon()));
    await conSitio({ perfil: dir, env: { SITE_PROFILE_WRITE_TOKEN: ESCRITURA }, opciones: { remotos, urlBase: { github: gh.base } } }, async ({ entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      const nuevo = { pack: 'acme-pagos', original: null, agent: 'acme-cobros-reviewer', group: 'condicional', detection: 'pyModified', paths: ['**/cobros/**/*.py'], prefix: 'COBROS', instructions: AGENTE('acme-cobros-reviewer') };
      const rev = (await escribir('/api/como-trabaja/revisar', lead, tok, { draft: nuevo })).json;
      assert.strictEqual(rev.ok, true, JSON.stringify(rev));
      // otro cambia el manifiesto en main después de revisar
      r.cambiar({ 'packs/acme-pagos/pack.json': `${JSON.stringify({ ...PAQUETE(), description: 'otra' }, null, 2)}\n` });
      // la página manda una versión falsa: no se usa, el aviso sale igual
      const cambio = (await escribir('/api/como-trabaja/proponer', lead, tok, { draft: nuevo, versions: { 'packs/acme-pagos/pack.json': null } })).json;
      assert.strictEqual(cambio.ok, false);
      assert.strictEqual(cambio.codigo, 'cambio');
      assert.deepStrictEqual(r.empujes, []);
    });
    // el .md cambió en main DESPUÉS de abrir el editor y el clon del sitio ya se puso al día: con las versiones firmadas
    // al abrir, el aviso sale igual (sin ellas, el clon nuevo lo taparía)
    await r.cerrar(); r = null;
    ({ r, dir } = await perfilPorHttp(perfilCon()));
    await conSitio({ perfil: dir, env: { SITE_PROFILE_WRITE_TOKEN: ESCRITURA }, opciones: { remotos, urlBase: { github: gh.base } } }, async ({ h, entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      const abierto = (await h.pedir('/api/como-trabaja/revisor?pack=acme-pagos&agent=acme-pagos-reviewer', { cookie: lead })).json;
      assert.ok(abierto.firma && abierto.versions['packs/acme-pagos/agents/acme-pagos-reviewer.md'], JSON.stringify(abierto));
      r.cambiar({ 'packs/acme-pagos/agents/acme-pagos-reviewer.md': AGENTE('acme-pagos-reviewer').replace('registro de pagos', 'registro de pagos (lo cambió otra persona)') });
      await require('util').promisify(execFile)('git', ['-c', `http.extraheader=Authorization: ${CAB}`, 'pull', '-q', 'origin', 'main'], { cwd: dir });
      const borrador = { ...abierto.draft, paths: ['**/pagos/**/*.py', '**/cobros/**/*.py'] };
      const conFirma = (await escribir('/api/como-trabaja/proponer', lead, tok, { draft: borrador, versions: abierto.versions, firma: abierto.firma })).json;
      assert.strictEqual(conFirma.codigo, 'cambio', JSON.stringify(conFirma));
      assert.strictEqual(conFirma.archivo, 'packs/acme-pagos/agents/acme-pagos-reviewer.md');
      // una firma que no es la del servidor no cuenta: vale la versión del clon de ahora
      const conOtra = (await escribir('/api/como-trabaja/proponer', lead, tok, { draft: borrador, versions: abierto.versions, firma: 'f'.repeat(64) })).json;
      assert.ok(conOtra.ok, JSON.stringify(conOtra));
    });
    gh.st.pedidos.length = 0;   // el pedido de la firma falsa: el caso siguiente arranca sin pedidos abiertos
    // contra un manifiesto que nadie tocó: el nuevo va al final y nace su .md (el primer repo se cierra antes de armar otro)
    await r.cerrar(); r = null;
    ({ r, dir } = await perfilPorHttp(perfilCon()));
    await conSitio({ perfil: dir, env: { SITE_PROFILE_WRITE_TOKEN: ESCRITURA }, opciones: { remotos, urlBase: { github: gh.base } } }, async ({ entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      const nuevo = { pack: 'acme-pagos', original: null, agent: 'acme-cobros-reviewer', group: 'condicional', detection: 'pyModified', paths: ['**/cobros/**/*.py'], prefix: 'COBROS', instructions: AGENTE('acme-cobros-reviewer') };
      const rev = (await escribir('/api/como-trabaja/revisar', lead, tok, { draft: nuevo })).json;
      const p = (await escribir('/api/como-trabaja/proponer', lead, tok, { draft: nuevo, versions: rev.versions })).json;
      assert.ok(p.ok, JSON.stringify(p));
      const rama = r.empujes.at(-1).ref.replace('refs/heads/', '');
      const pack = JSON.parse(r.archivoEn(rama, 'packs/acme-pagos/pack.json'));
      assert.deepStrictEqual(pack.reviewers.map((x) => x.agent), ['acme-pagos-reviewer', 'acme-cobros-reviewer']);
      assert.ok(r.archivoEn(rama, 'packs/acme-pagos/agents/acme-cobros-reviewer.md'));
    });
  } finally { await Promise.allSettled([r, gh].filter(Boolean).map((s) => s.cerrar())); }
});

test('T12 Proponer_UnArchivoComoAntes @story-2.61 @ac-14 — proponer con un archivo suelto arma el mismo pedido', { skip: SIN_BACKEND }, async () => {
  const RP = require(path.join(ROOT, 'scripts', 'lib', 'repo-proposal.js'));
  const { arrancarGithubFalso } = require('./lib/fake-github-api.js');
  let gh; let r; let dir;
  try {
    gh = await arrancarGithubFalso({ owner: 'acme', repo: 'perfil' });
    gh.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
    ({ r, dir } = await perfilPorHttp({ 'team-profile.json': { packs: { default: 'all' } } }));
    const oid = git(dir, 'rev-parse', 'HEAD:team-profile.json');
    const res = await RP.proponer({ clon: dir, archivo: 'team-profile.json', contenido: '{ "packs": { "default": "none" } }\n', oidEsperado: oid, idCorto: 'profile', quien: LEAD, credencial: ESCRITURA, remote: { platform: 'github', org: 'acme', repo: 'perfil' }, urlBase: { github: gh.base } });
    assert.ok(res.ok, JSON.stringify(res));
    const rama = r.empujes.at(-1).ref.replace('refs/heads/', '');
    assert.match(r.archivoEn(rama, 'team-profile.json'), /"none"/);
    assert.match(rama, /^team-config\/profile-/);
  } finally { await Promise.allSettled([r, gh].filter(Boolean).map((s) => s.cerrar())); }
});

test('T21 ComoTrabaja_CadaArchivoQueLeeEntraALaImagen @story-2.61.1 @ac-3 — sin Docker: lo que lee la pestaña entra a la imagen, y sólo lo publicado', () => {
  const { imageFiles } = require('./lib/image-files.js');
  const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });
  const versionados = git('ls-files', '-z');
  assert.strictEqual(versionados.status, 0, `git ls-files: ${versionados.stderr}`);
  const { entran } = imageFiles(ROOT, versionados.stdout.split('\0').filter(Boolean));
  const enImagen = new Set(entran);
  // lo que la pestaña carga de verdad: los módulos que quedan cargados al armar su modelo
  const sonda = spawnSync(process.execPath, [path.join(__dirname, 'lib', 'how-it-works-probe.js'), ROOT, '--modules'], { encoding: 'utf8' });
  assert.strictEqual(sonda.status, 0, sonda.stderr);
  const modelo = JSON.parse(sonda.stdout.trim().split('\n').pop());
  assert.ok(!modelo.error, `el modelo se arma en el árbol: ${modelo.error}`);
  // y lo que lee como texto: la tabla de pasos, cada archivo de paso, la lista de controles, el guion de cada control
  // (así reconoce un despachador) y las guías (así reconoce una guía citada por su nombre)
  const { STEPS } = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  const lista = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8')).hooks;
  const leidos = [
    ...modelo.modules,
    'skills/tycon-pipeline/scripts/lib/steps.js',
    ...STEPS.map((s) => `skills/tycon-pipeline/steps/${s.file}`),
    'scripts/setup/hooks-list.json',
    // el repo público: sin él no hay «Ver el código» ni adónde mandar una mejora (2.61.2)
    'scripts/setup/public-remotes.json',
    ...lista.map((h) => (h.spec.startsWith('@tcg:') ? `scripts/hooks/${h.spec.slice(5)}` : `skills/${h.spec}`)),
    ...versionados.stdout.split('\0').filter((f) => /^guides\/.+\.md$/.test(f)),
  ];
  const faltan = [...new Set(leidos)].filter((f) => !enImagen.has(f));
  assert.deepStrictEqual(faltan, [], 'todo lo que lee la pestaña entra a la imagen');
  // sólo lo publicado: un archivo sin versionar dentro de lo que se copia entraría a una imagen armada en esta máquina
  const sueltos = git('ls-files', '-z', '--others', '--exclude-standard');
  assert.strictEqual(sueltos.status, 0, sueltos.stderr);
  assert.deepStrictEqual(imageFiles(ROOT, sueltos.stdout.split('\0').filter(Boolean)).entran, [], 'ningún archivo sin versionar entra a la imagen');
  // y ninguna prueba
  assert.deepStrictEqual(entran.filter((f) => /(^|\/)tests?\/|\.test\.|(^|\/)scenarios\//.test(f)), [], 'la imagen no trae pruebas');
});

test('T22 ComoTrabaja_LaImagenSinSecretosYLaSimulacionSinAdivinar @story-2.61.1 @ac-3 — formas de secreto afuera; lo que la simulación no sabe leer, lo dice', () => {
  const { imageFiles, patron } = require('./lib/image-files.js');
  // un archivo con forma de secreto dentro de lo que se copia no entra (en una máquina pueden estar sin versionar)
  const secretos = ['.env', '.env.local', '.env.production', '.npmrc', 'clave.p12', 'id_rsa', 'id_rsa.pub', 'id_dsa', 'id_ed25519', 'id_ecdsa', 'clave.pem', 'clave.key', 'clave.pfx', 'algo.env',
    '.netrc', '.pypirc', '.git-credentials', 'llaves.jks', 'app.keystore', 'clave.pkcs12', 'terraform.tfstate', 'terraform.tfstate.backup', 'prod.tfvars',
    'credentials.json', 'service-account-prod.json', '.aws/credentials', '.docker/config.json']
    .flatMap((n) => [`scripts/hooks/${n}`, `skills/tycon-pipeline/scripts/${n}`, `guides/${n}`, `scripts/site/${n}`]);
  assert.deepStrictEqual(imageFiles(ROOT, secretos).entran, [], 'ninguna forma de secreto entra');
  // un patrón que no sabe leer como BuildKit tira enseguida, en vez de colgarse o adivinar
  for (const p of ['a[b', '/scripts/site', 'x[!a]y', 'x[^a]y']) assert.throws(() => patron(p), /image-files/, p);
  const d = tmp('hiw-img-');
  fs.mkdirSync(path.join(d, 'scripts', 'site'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts', 'site', 'Dockerfile.dockerignore'), '*\n!scripts/\n');
  for (const copia of ['COPY --from=base /app/x scripts/x/', 'COPY scripts/a/ \\\n  scripts/a/']) {
    fs.writeFileSync(path.join(d, 'scripts', 'site', 'Dockerfile'), `FROM x\n${copia}\n`);
    assert.throws(() => imageFiles(d, ['scripts/a/b.js']), /image-files/, copia);
  }
});

test('T23 ComoTrabaja_SinRepoPublicoSinBotonesVacios @story-2.61.2 @ac-3 — sin repo público, ni «Proponer una mejora» ni «Ver el código»', () => {
  const m = HIW().buildModel({ treeDir: ROOT, profileDir: null });
  const piezas = (html) => html.split('data-origin="harness"').slice(1).map((x) => x.split('</li>')[0]);
  const sin = TAB().renderPage(m, { idioma: 'es', publicRepo: null, version: 'v' });
  assert.ok(piezas(sin).length > 20, 'hay piezas del arnés');
  assert.ok(!sin.includes('data-action="improve"'), 'sin adónde ir, no hay botón de mejora');
  assert.ok(!sin.includes('/blob/main/'), 'ni enlaces al código');
  const con = TAB().renderPage(m, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  for (const p of piezas(con)) {
    assert.ok(p.includes('data-action="improve"'), 'con repo público, cada pieza tiene «Proponer una mejora»');
    assert.ok(p.includes(`href="${PUBLICO}/blob/main/`), 'y «Ver el código»');
  }
});

test('T24 ComoTrabaja_LaSondaDiceElRepoYLosEnlaces @story-2.61.2 @ac-1 @ac-2 — la sonda exige repo público y enlaces; sin ellos, la guarda del workflow frena', () => {
  const sonda = (...extra) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'lib', 'how-it-works-probe.js'), ROOT, ...extra], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return { texto: r.stdout.trim(), json: JSON.parse(r.stdout.trim().split('\n').pop()) };
  };
  const sana = sonda();
  assert.match(sana.json.publicRepo || '', /^https:\/\//, 'en el árbol, el repo público');
  assert.ok(sana.json.codeLinks > 0, `en el árbol, enlaces al código (${sana.json.codeLinks})`);
  assert.deepStrictEqual(sana.json.problems, []);
  // sin el archivo del repo público (una carpeta vacía en su lugar, como la imagen de antes), un problema
  const vacia = fs.mkdtempSync(path.join(os.tmpdir(), 'hiw-sin-remoto-'));
  try {
    const rota = sonda('--public-remotes-tree', vacia);
    assert.strictEqual(rota.json.publicRepo, null);
    assert.strictEqual(rota.json.codeLinks, 0);
    assert.ok(rota.json.problems.some((x) => /public-remotes\.json/.test(x)), `dice qué falta: ${JSON.stringify(rota.json.problems)}`);
    // la guarda real del workflow (el renglón de site-image.yml, con bash) la frena
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'site-image.yml'), 'utf8');
    const guarda = wf.match(/case "\$SONDA_IMAGEN" in \*'"problems":\[\]\}'\) ;; \*\) echo "::error::[^"]*"; exit 1 ;; esac/);
    assert.ok(guarda, 'la guarda del workflow');
    const pasa = (salida) => spawnSync('bash', ['-c', guarda[0]], { env: { PATH: process.env.PATH, SONDA_IMAGEN: salida }, encoding: 'utf8' }).status === 0;
    assert.strictEqual(pasa(rota.texto), false, 'sin repo público, la imagen no se publica');
    assert.strictEqual(pasa(sana.texto), true, 'sana, pasa');
  } finally {
    fs.rmSync(vacia, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════ en llano: nombres, piezas de la organización, controles ════════════════════════════════════════

const VIEJOS = /Validar la story(?! en)|Cerrar en ADO/;
test('T25 ComoTrabaja_NingunNombreViejoDePaso @story-2.61.3 @ac-1 — ningún «Validar la story» ni «Cerrar en ADO» como nombre de paso', () => {
  // «Validar la story en …» es el pedido al validador, no el nombre del paso
  const archivos = ['scripts/site/texts.js', 'skills/tycon-pipeline/scripts/on-prompt.js', 'skills/tycon-pipeline/scripts/lib/story-gate.js',
    'skills/tycon-pipeline/scripts/pipeline.js', 'skills/tycon-pipeline/scripts/lib/steps.js', 'mods/harness-mods/hooks/steps.mjs',
    'skills/tycon-pipeline/SKILL.md', 'skills/tycon-pipeline/steps/step-01-start.md', 'skills/tycon-pipeline/steps/step-02-validate-story.md',
    'skills/tycon-pipeline/steps/close-work-item.md', 'guides/organization-site.md'];
  for (const a of archivos) {
    const texto = fs.readFileSync(path.join(ROOT, a), 'utf8');
    const linea = texto.split('\n').find((l) => VIEJOS.test(l));
    assert.ok(!linea, `${a}: ${linea}`);
  }
  const { STEPS, CLOSE_STEP } = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  assert.strictEqual(STEPS.find((x) => x.id === 'validate-story').name, 'Validar la historia');
  assert.strictEqual(CLOSE_STEP.name, 'Cerrar la historia');
  assert.deepStrictEqual(['validate-story', 'close-work-item'].map((id) => TX().t('en', `paso.${id}`)), ['Validate the story', 'Close the story']);
});

// ADO se prende con su organización (ado.org), las demás con su llave en integrations
const perfilIntegraciones = ({ ado, ...integrations }) => carpeta(perfilCon({ profile: { integrations, packs: { default: 'all' }, ...(ado ? { ado: { org: 'https://dev.azure.com/acme' } } : {}) } }));
const conCasa = (fn) => {
  const viejo = process.env.HOME; process.env.HOME = carpeta({ '.claude/tycon.json': { integrations: { clockify: true, engram: true } } });
  try { return fn(); } finally { process.env.HOME = viejo; }
};
const seccionDe = (html, id) => { const i = html.indexOf(`id="paso-${id}"`); return html.slice(i, html.indexOf('</section>', i)); };

test('T28 ComoTrabaja_IntegracionesSonPiezasDeSuPaso @story-2.61.3 @ac-3 — el registro de horas y ADO son piezas de «Arranque» y «Cerrar la historia»', () => {
  const H2 = HIW();
  const m = H2.buildModel({ treeDir: ROOT, profileDir: null });
  const ids = m.steps.map((x) => x.id);
  assert.ok(!ids.some((x) => /^\d/.test(x)), `ningún id de la numeración vieja: ${ids.join(',')}`);
  assert.strictEqual(H2.FOLDED_STEPS, undefined, 'no hay pasos que se plieguen en otro: el aviso de trabajo y el pedido son piezas de «Arranque»');
  // la tabla: cada fila nombra un paso que existe, una integración del lector, su texto y un archivo del árbol
  const integraciones = TC.integraciones(TC.cargar({ env: {}, home: tmp('hiw-home-') }));
  for (const f of H2.INTEGRATION_PIECES) {
    assert.ok(ids.includes(f.step), `${f.id}: el paso ${f.step}`);
    // las de horas son de la herramienta que elija la organización: no nombran ninguna
    assert.ok(f.timeTool ? f.integration === null : f.integration in integraciones, `${f.id}: ${f.integration} es una integración`);
    assert.ok(fs.existsSync(path.join(ROOT, f.code)), `${f.id}: ${f.code}`);
    for (const idioma of ['es', 'en']) assert.ok(TX().t(idioma, f.textKey), `${f.id}: su texto en ${idioma}`);
  }
  const deUnPaso = (id) => (m.steps.find((x) => x.id === id).orgPieces || []).map((x) => x.id);
  assert.deepStrictEqual(deUnPaso('start').sort(), H2.INTEGRATION_PIECES.filter((f) => f.step === 'start').map((f) => f.id).sort());
  assert.deepStrictEqual(deUnPaso('close-work-item').sort(), H2.INTEGRATION_PIECES.filter((f) => f.step === 'close-work-item').map((f) => f.id).sort());
  assert.ok(deUnPaso('start').length >= 2 && deUnPaso('close-work-item').length >= 2);
  // lo que se declara en «Arranque» aparece en él: sus controles y lo que se suma según la historia (si no, la pieza
  // «pedido en ADO» no aparece en ningún paso)
  const arranque = m.steps.find((x) => x.id === 'start');
  for (const c of H2.STORY_CONDITIONALS.filter((x) => x.steps.includes('start'))) {
    assert.ok(arranque.storyPieces.some((x) => x.id === c.id), `${c.id} (de ${c.steps}) en «Arranque»`);
  }
  const { controls } = H2.readControls(ROOT);
  for (const c of controls.filter((x) => Array.isArray(x.steps) && x.steps.includes('start'))) {
    assert.ok(arranque.controls.some((x) => x.spec === c.spec), `el control ${c.spec} (de ${c.steps}) en «Arranque»`);
  }
  const html = TAB().renderPage(m, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  for (const id of ['start', 'close-work-item']) {
    const sec = seccionDe(html, id);
    assert.ok(sec.includes(`<h3>${TX().t('es', 'comoTrabaja.segunTuOrganizacion')}</h3>`), `el paso ${id} tiene su bloque`);
    for (const f of H2.INTEGRATION_PIECES.filter((x) => x.step === id)) {
      assert.ok(sec.includes(TX().t('es', f.textKey)), `${f.id} en el paso ${id}`);
      assert.ok(sec.includes(`href="${PUBLICO}/blob/main/${f.code}"`) && sec.includes(`data-piece="${f.code}"`), `${f.id}: «Ver el código» y «Proponer una mejora»`);
    }
  }
  // lo que se ve de la pestaña no dice «Clockify»: el registro de horas puede ser otro servicio. La ruta del código de un
  // control (`integrations/<integración>/…`) es dónde vive el archivo, no un texto de la pestaña: no cuenta
  const visibleDe = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\bintegrations\/[\w./-]+/g, ' ');
  assert.doesNotMatch(visibleDe(html), /clockify/i);
  for (const idioma of ['es', 'en']) assert.doesNotMatch(visibleDe(TAB().renderPage(m, { idioma, publicRepo: PUBLICO, version: 'v' })), /clockify/i, idioma);
});

test('T47 ComoTrabaja_HorasPorLaHerramientaElegida @story-7.40 @ac-4 — la de horas la decide timeTracking, no la llave vieja', () => conCasa(() => {
  const H2 = HIW();
  const todos = (m) => [...m.allSteps.controls, ...m.steps.flatMap((x) => x.controls)];
  // Clockify elegida, con la llave vieja en false: sus controles se ven (la llave vieja no la apaga)
  const elegida = H2.buildModel({ treeDir: ROOT, profileDir: perfilIntegraciones({ timeTracking: 'clockify', clockify: false, engram: true }) });
  assert.strictEqual(elegida.org.timeTracking, 'clockify');
  assert.ok(todos(elegida).some((c) => c.integration === 'clockify' && c.timeTool), 'los controles de la herramienta elegida');
  // otra elegida: los de Clockify no
  const otra = H2.buildModel({ treeDir: ROOT, profileDir: perfilIntegraciones({ timeTracking: 'solidtime', engram: true }) });
  assert.ok(!todos(otra).some((c) => c.integration === 'clockify'), 'con Solidtime, nada de Clockify');
}));

test('HowItWorks_TimeControls_OnlyWhenChosen @story-7.40 @ac-11 — los de horas con el nombre de la elegida; con ninguna, no aparecen', () => conCasa(() => {
  const H2 = HIW();
  const todos = (m) => [...m.allSteps.controls, ...m.steps.flatMap((x) => x.controls)];
  const piezasDeHoras = (m) => m.steps.flatMap((x) => x.orgPieces || []).filter((x) => x.timeTool);
  const chip = (texto) => `ct-chip horas">${texto}<`;
  for (const [tool, label] of [['clockify', 'Clockify'], ['solidtime', 'Solidtime']]) {
    const m = H2.buildModel({ treeDir: ROOT, profileDir: perfilIntegraciones({ timeTracking: tool, engram: true }) });
    assert.strictEqual(m.org.timeToolLabel, label);
    assert.deepStrictEqual(piezasDeHoras(m).map((x) => x.id).sort(), ['timeTrackingClose', 'timeTrackingStart'], `${tool}: el 0b y el 9`);
    assert.ok(piezasDeHoras(m).every((x) => x.integration === tool), `${tool}: las piezas son de la elegida`);
    const suyos = todos(m).filter((c) => c.timeTool);
    assert.ok(suyos.length && suyos.every((c) => c.integration === tool), `${tool}: sólo sus controles`);
    const html = TAB().renderPage(m, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
    assert.ok(html.includes(chip(label)), `${tool}: el chip con su nombre`);
    // ninguna pieza ni control de horas con «del arnés» ni «según tu organización»
    const filas = html.split('<li ').map((li) => li.split('</li>')[0]).filter((li) => li.includes(chip(label)));
    assert.ok(filas.length >= suyos.length, `${tool}: cada control de horas con el nombre`);
    for (const li of filas) assert.ok(!li.includes(TX().t('es', 'comoTrabaja.delArnes')) && !li.includes(TX().t('es', 'comoTrabaja.segunTuOrganizacionMarca')), li.slice(0, 200));
  }
  // con ninguna (o la llave vieja apagada): ni las piezas ni los controles de horas
  for (const integ of [{ timeTracking: 'none', engram: true }, { clockify: false, engram: true }]) {
    const m = H2.buildModel({ treeDir: ROOT, profileDir: perfilIntegraciones(integ) });
    assert.deepStrictEqual(piezasDeHoras(m), [], JSON.stringify(integ));
    assert.ok(!todos(m).some((c) => c.timeTool), JSON.stringify(integ));
  }
  // una herramienta que el árbol no trae: sus piezas no se ven, y la franja dice por qué
  const rara = H2.buildModel({ treeDir: ROOT, profileDir: perfilIntegraciones({ timeTracking: 'harvest', engram: true }) });
  assert.deepStrictEqual(piezasDeHoras(rara), []);
  assert.ok(rara.org.problems.some((x) => /harvest/.test(x) && /no es una herramienta de horas/.test(x)), JSON.stringify(rara.org.problems));
  // sin perfil no se sabe: las piezas se ven «según tu organización»
  const sin = H2.buildModel({ treeDir: ROOT, profileDir: null });
  assert.strictEqual(piezasDeHoras(sin).length, 2);
  assert.ok(!TAB().renderPage(sin, { idioma: 'es', publicRepo: PUBLICO, version: 'v' }).includes('ct-chip horas"'));
}));

test('T29 ComoTrabaja_SoloLoQueTuOrganizacionUsa @story-2.61.3 @ac-4 — apagada no aparece; prendida o sin perfil, «según tu organización»', () => conCasa(() => {
  const H2 = HIW();
  const marca = `ct-chip segun">${TX().t('es', 'comoTrabaja.segunTuOrganizacionMarca')}<`;
  const todos = (m) => [...m.allSteps.controls, ...m.steps.flatMap((x) => x.controls)];
  const piezas = (m) => m.steps.flatMap((x) => x.orgPieces || []);
  // ADO prendido, registro de horas apagado
  const mixta = H2.buildModel({ treeDir: ROOT, profileDir: perfilIntegraciones({ ado: true, clockify: false, engram: true }) });
  assert.ok(piezas(mixta).some((x) => x.integration === 'ado'), 'ADO aparece');
  assert.ok(!piezas(mixta).some((x) => x.integration === 'clockify'), 'el registro de horas, no');
  assert.ok(!todos(mixta).some((c) => c.integration === 'clockify'), 'ni sus controles');
  const hMixta = TAB().renderPage(mixta, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  assert.ok(hMixta.includes(marca), 'lo prendido lleva la marca');
  assert.ok(!hMixta.includes(`ct-chip off">${TX().t('es', 'comoTrabaja.apagadoEnTuOrganizacion')}<`), 'ya no hay «apagado» en una pieza');
  // todo apagado en la organización: ADO se puede prender por repo (.tycon/ado-config.yaml), así que no se esconde
  const nada = H2.buildModel({ treeDir: ROOT, profileDir: perfilIntegraciones({ clockify: false, engram: false }) });
  assert.strictEqual(nada.org.integrations.ado, false, 'el perfil no tiene ADO');
  assert.ok(piezas(nada).length && piezas(nada).every((x) => x.integration === 'ado'), 'quedan sólo las de ADO');
  assert.ok(todos(nada).some((c) => c.integration === 'ado'), 'y su control');
  assert.ok(!todos(nada).some((c) => c.integration === 'clockify'));
  // un paso con piezas declaradas y ninguna visible lo dice; uno sin filas no tiene el bloque
  const vacio = { ...nada, steps: nada.steps.map((x) => (x.id === 'start' ? { ...x, orgPieces: [] } : x)) };
  const hNada = TAB().renderPage(vacio, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  assert.ok(seccionDe(hNada, 'start').includes(TX().t('es', 'comoTrabaja.sinPiezasOrg')), 'el paso dice que no tiene');
  assert.ok(!seccionDe(hNada, 'plan').includes(TX().t('es', 'comoTrabaja.segunTuOrganizacion')), 'un paso sin filas no tiene el bloque');
  // un clon del perfil sin su archivo: no se sabe qué tiene la organización, se muestra todo (como sin perfil)
  const sinArchivo = H2.buildModel({ treeDir: ROOT, profileDir: carpeta({ 'LEEME.md': 'perfil sin configurar\n' }) });
  assert.strictEqual(piezas(sinArchivo).length, H2.INTEGRATION_PIECES.length, 'todas las piezas');
  assert.ok(todos(sinArchivo).some((c) => c.integration === 'clockify'), 'y los controles del registro de horas');
  // el archivo está pero no se puede leer: tampoco se sabe, y el problema sale en la franja
  const ilegible = H2.buildModel({ treeDir: ROOT, profileDir: carpeta({ 'team-profile.json': '{ roto' }) });
  assert.strictEqual(piezas(ilegible).length, H2.INTEGRATION_PIECES.length, 'ilegible: todas las piezas');
  assert.ok(ilegible.org.problems.some((p) => /ilegible/.test(p)), `ilegible: el problema a la vista (${ilegible.org.problems})`);
  // una clave inválida no hace ilegible al archivo: lo apagado sigue sin aparecer
  const unaClave = H2.buildModel({ treeDir: ROOT, profileDir: carpeta({ 'team-profile.json': { integrations: { clockify: false }, update: { channel: 42 } } }) });
  assert.ok(!piezas(unaClave).some((x) => x.integration === 'clockify'), 'una clave mala no prende lo apagado');
  // sin perfil: todo, con la marca
  const sin = H2.buildModel({ treeDir: ROOT, profileDir: null });
  assert.strictEqual(piezas(sin).length, H2.INTEGRATION_PIECES.length);
  const hSin = TAB().renderPage(sin, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  const conIntegracion = todos(sin).filter((c) => c.integration);
  assert.ok(conIntegracion.length, 'hay controles de una integración');
  for (const c of conIntegracion) {
    const li = hSin.split(`data-piece="${c.script}"`)[1].split('</li>')[0];
    assert.ok(li.includes(marca), `${c.spec}: con la marca`);
  }
}));

test('T30 ComoTrabaja_CadaControlDeclaraSuIntegracion @story-2.61.3 @ac-4 — un control de ADO o del registro de horas lo declara', () => {
  const { controls } = HIW().readControls(ROOT);
  const deIntegracion = { 'tycon-ado-story-wi/': 'ado', 'clocki/': 'clockify' };
  for (const c of controls) {
    for (const [parte, integ] of Object.entries(deIntegracion)) {
      if (c.script.includes(parte)) assert.strictEqual(c.integration, integ, `${c.spec} (${c.script})`);
    }
  }
  assert.strictEqual(controls.find((c) => c.spec === 'ado-story-create').integration, 'ado');
});

test('T31 ComoTrabaja_CadaControlDiceQueHace @story-2.61.3 @ac-5 — el título es lo que hace; el archivo, debajo', () => {
  const { controls } = HIW().readControls(ROOT);
  const especs = [...new Set(controls.map((c) => c.spec))];
  assert.ok(especs.length > 40, `${especs.length} controles`);
  for (const spec of especs) {
    let es; let en;
    // el de una integración lo trae su manifiesto (`control`); el del arnés, los textos del sitio
    const deManifiesto = controls.find((c) => c.spec === spec && c.control);
    if (deManifiesto) ({ es, en } = deManifiesto.control);
    else try { es = TX().t('es', `control.${spec}`); en = TX().t('en', `control.${spec}`); } catch (e) {
      assert.fail(`${spec}: le falta su texto en llano (control.${spec} en scripts/site/texts.js, o «control» en su manifiesto, en castellano y en inglés)`);
    }
    assert.ok(es && en && es !== en, `${spec}: dos idiomas`);
    assert.ok(hasSpanish(es) && !hasSpanish(en), `${spec}: el castellano en castellano y el inglés en inglés`);
    assert.doesNotMatch(`${es} ${en}`, /\.(js|sh|mjs)\b|clockify/i, `${spec}: sin archivos ni Clockify`);
  }
  const m = HIW().buildModel({ treeDir: ROOT, profileDir: null });
  const html = TAB().renderPage(m, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  for (const c of [...m.allSteps.controls, ...m.steps.flatMap((x) => x.controls)]) {
    const li = html.split(`data-piece="${c.script}"`)[1].split('</li>')[0];
    assert.ok(li.includes(`<span class="ct-nom sans">${c.control ? c.control.es : TX().t('es', `control.${c.spec}`)}</span>`), `${c.spec}: su título`);
    assert.ok(li.includes(`<span class="ct-archivo">${c.script}</span>`), `${c.spec}: el archivo debajo`);
  }
});

test('T32 ComoTrabaja_EnTodoElRecorridoEsUnaEntrada @story-2.61.3 @ac-6 — la última entrada, aparte; su sección se esconde como un paso', () => {
  const m = HIW().buildModel({ treeDir: ROOT, profileDir: null });
  const html = TAB().renderPage(m, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  const lista = html.slice(html.indexOf('<ol class="ct-pasos'), html.indexOf('</ol>'));
  const items = [...lista.matchAll(/<li[^>]*>.*?<\/li>/g)].map((x) => x[0]);
  assert.match(items[items.length - 1], /data-step="todo"/, 'la última entrada');
  assert.ok(items[items.length - 2].includes(TX().t('es', 'comoTrabaja.enCualquierPaso')) && items[items.length - 2].includes('ct-aparte'), 'con su separador');
  const sel = html.slice(html.indexOf('<select data-action="step">'), html.indexOf('</select>'));
  assert.match(sel, /<option value="todo">[^<]+<\/option>$/, 'también en la lista del teléfono, al final');
  // su sección es un paso más: el guion que esconde los pasos la esconde a ella
  assert.match(html, /<section class="ct-paso card" id="paso-todo" data-step="todo"/);
  assert.ok(!html.includes('ct-todo'), 'ya no hay una sección siempre a la vista');
  const guion = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'tabs', 'how-it-works.js'), 'utf8');
  assert.match(guion, /querySelectorAll\('\.ct-paso'\)\.forEach\(function \(s\) \{ s\.hidden = s\.getAttribute\('data-step'\) !== id; \}\)/);
});

test('T34 Sonda_RepoSinEnlacesYCarpetaQueNoEsElArbol @story-2.61.3 @ac-8 — repo sí y enlaces 0, un problema; la carpeta personal o «/», error sin leer', () => {
  const SONDA = path.join(__dirname, 'lib', 'how-it-works-probe.js');
  const { problemasDeLaSonda } = require(SONDA);
  assert.deepStrictEqual(problemasDeLaSonda({ publicRepo: PUBLICO, codeLinks: 0, problems: [] }), ['sin enlaces al código en la página']);
  assert.deepStrictEqual(problemasDeLaSonda({ publicRepo: PUBLICO, codeLinks: 3, problems: [] }), []);
  assert.ok(problemasDeLaSonda({ publicRepo: null, codeLinks: 0, problems: [] })[0].includes('public-remotes.json'));
  const casa = tmp('hiw-casa-');
  for (const raiz of [casa, path.parse(casa).root]) {
    const r = spawnSync(process.execPath, [SONDA, raiz], { encoding: 'utf8', env: { ...process.env, HOME: casa, USERPROFILE: casa } });
    assert.strictEqual(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout.trim());
    assert.match(json.error || '', /no es el árbol del arnés/, `${raiz}: ${r.stdout}`);
    assert.ok(!('steps' in json), 'no armó nada');
  }
});

// ════════════════════════ el revisor entero: la cabecera en campos y sus instrucciones ════════════════════════

const MODELS = () => require(path.join(SCRIPTS, 'lib', 'models.js'));
// un revisor con la cabecera completa: una herramienta que el sitio no conoce y una clave que el editor no muestra
const AGENTE_COMPLETO = (nombre, { model = 'sonnet' } = {}) => `---\nname: ${nombre}\ndescription: Revisa los cambios en el cobro de Acme.\ntools: Read, Grep, Glob, mcp__codegraph__codegraph_search\n${model ? `model: ${model}\n` : ''}color: blue\n---\n\n## Qué mirás\n- Que todo cobro nuevo pase por el registro de pagos.\n`;
const perfilCompleto = ({ model, repos = null } = {}) => carpeta(perfilCon({ repos, extra: { 'packs/acme-pagos/agents/acme-pagos-reviewer.md': AGENTE_COMPLETO('acme-pagos-reviewer', { model }) } }));
// el borrador que manda el navegador: el que abrió, con los cambios encima
const borradorDe = (perfil, cambios = {}, cabecera = {}) => {
  const d = TAB().draftOf(perfil, 'acme-pagos', 'acme-pagos-reviewer').draft;
  return { ...d, ...cambios, cabecera: { ...d.cabecera, ...cabecera } };
};
const mdPropuesto = (r) => (r.files.find((f) => f.archivo.endsWith('.md')) || {}).contenido;

test('T2 Editor_CabeceraEnCampos @story-2.63 @ac-2 — el nombre, el modelo, las herramientas y la descripción aparte; las instrucciones sin la cabecera', () => {
  // 🔴 rojo: el editor muestra el .md entero en un solo cuadro (la cabecera mezclada con las instrucciones).
  const d = TAB().draftOf(perfilCompleto(), 'acme-pagos', 'acme-pagos-reviewer').draft;
  assert.ok(d.cabecera, 'la cabecera viene aparte');
  assert.strictEqual(d.cabecera.nombre, 'acme-pagos-reviewer');
  assert.strictEqual(d.cabecera.descripcion, 'Revisa los cambios en el cobro de Acme.');
  assert.strictEqual(d.cabecera.modelo, 'balanced', 'el modelo del archivo, dicho como su nivel');
  assert.strictEqual(d.cabecera.modeloTalCual, false);
  assert.deepStrictEqual(d.cabecera.herramientas, ['Read', 'Grep', 'Glob']);
  assert.deepStrictEqual(d.cabecera.otrasHerramientas, ['mcp__codegraph__codegraph_search']);
  assert.strictEqual(d.cuerpo, '## Qué mirás\n- Que todo cobro nuevo pase por el registro de pagos.\n', 'el cuerpo, sin la cabecera ni el renglón en blanco');
  assert.ok(!/^---/m.test(d.cuerpo) && !/name:/.test(d.cuerpo));
  // sin model en la cabecera: el que use la organización
  assert.strictEqual(TAB().draftOf(perfilCompleto({ model: '' }), 'acme-pagos', 'acme-pagos-reviewer').draft.cabecera.modelo, '');
});

test('T3 Editor_ModeloConTecho @story-2.63 @ac-3 — los niveles neutros; los que pasan el techo, apagados con su motivo; uno que no se traduce, tal cual', () => {
  // 🔴 rojo: el selector ofrece nombres de un proveedor, deja elegir lo que pasa el techo, o cambia en silencio un
  // modelo que no reconoce.
  const libre = TAB().modelosDe(perfilCompleto());
  assert.deepStrictEqual(libre.map((m) => m.valor), ['', ...MODELS().LEVELS], 'el de la organización y los cuatro niveles');
  assert.ok(libre.every((m) => !m.apagado), 'sin techo, todos se pueden elegir');
  const GH = (repo) => ({ platform: 'github', org: 'acme', repo });
  const conTecho = perfilCompleto({ repos: { version: 1, public: GH('arnes'), profile: GH('perfil'), operations: GH('operaciones'), models: { mandatory_ceiling: true, ceiling: 'balanced' } } });
  const m = TAB().modelosDe(conTecho);
  assert.deepStrictEqual(m.filter((x) => x.apagado).map((x) => x.valor), ['strong', 'max']);
  for (const x of m.filter((y) => y.apagado)) assert.match(x.motivo, /techo/, x.valor);
  const pasa = TAB().reviewDraft({ profileDir: conTecho, draft: borradorDe(conTecho, {}, { modelo: 'strong' }) });
  assert.strictEqual(pasa.ok, false);
  assert.match(pasa.problems.join(' · '), /techo/);
  // con techo, el .md crudo tampoco lo pasa
  assert.match(TAB().reviewDraft({ profileDir: conTecho, draft: { ...borradorDe(conTecho), cabecera: undefined, instructions: AGENTE_COMPLETO('acme-pagos-reviewer', { model: 'opus' }) } }).problems.join(' · '), /techo/);
  // una configuración de la organización que no se puede leer no es «sin techo»: se dice, y un modelo elegido no pasa
  const ilegible = perfilCompleto({ repos: { version: 1, models: { mandatory_ceiling: true, ceiling: 'balanced' } } });
  assert.match(TAB().avisoDeModelos(ilegible) || '', /no se pudo saber el techo/);
  assert.strictEqual(TAB().avisoDeModelos(perfilCompleto()), null, 'sin configuración, sin aviso');
  const sinSaber = TAB().reviewDraft({ profileDir: ilegible, draft: borradorDe(ilegible, {}, { modelo: 'strong' }) });
  assert.match(sinSaber.problems.join(' · '), /no se pudo saber el techo/);
  assert.deepStrictEqual(TAB().reviewDraft({ profileDir: ilegible, draft: borradorDe(ilegible, {}, { modelo: '' }) }).problems, [], 'con el de la organización, sí');
  // el nivel se guarda como el nombre que entiende quien corre el revisor (modelOf de lib/models.js)
  const elegido = TAB().reviewDraft({ profileDir: conTecho, draft: borradorDe(conTecho, {}, { modelo: 'economy' }) });
  assert.deepStrictEqual(elegido.problems, []);
  assert.match(mdPropuesto(elegido), /^model: haiku$/m);
  // un modelo que no es un nivel ni un nombre conocido: se muestra tal cual y se conserva al guardar
  const raro = carpeta(perfilCon({ extra: { 'packs/acme-pagos/agents/acme-pagos-reviewer.md': AGENTE_COMPLETO('acme-pagos-reviewer', { model: 'claude-opus-4-1-20250805' }) } }));
  const dr = TAB().draftOf(raro, 'acme-pagos', 'acme-pagos-reviewer').draft;
  assert.deepStrictEqual([dr.cabecera.modelo, dr.cabecera.modeloTalCual], ['claude-opus-4-1-20250805', true]);
  const r = TAB().reviewDraft({ profileDir: raro, draft: borradorDe(raro, {}, { descripcion: 'Otra descripción.' }) });
  assert.deepStrictEqual(r.problems, []);
  assert.match(mdPropuesto(r), /^model: claude-opus-4-1-20250805$/m, 'no se cambia en silencio');
});

test('T4 Editor_HerramientasRarasSeConservan @story-2.63 @ac-3 @ac-8 — una herramienta que el sitio no conoce se conserva al proponer', () => {
  // 🔴 rojo: al guardar desde las casillas se pierde la herramienta del servidor MCP.
  const p = perfilCompleto();
  const r = TAB().reviewDraft({ profileDir: p, draft: borradorDe(p, {}, { herramientas: ['Read', 'Grep', 'Glob', 'Bash'] }) });
  assert.deepStrictEqual(r.problems, []);
  assert.match(mdPropuesto(r), /^tools: Read, Grep, Glob, Bash, mcp__codegraph__codegraph_search$/m);
  // una casilla que no existe no entra: sólo las ocho conocidas
  const inventada = TAB().reviewDraft({ profileDir: p, draft: borradorDe(p, {}, { herramientas: ['Read', 'Borrar'] }) });
  assert.doesNotMatch(mdPropuesto(inventada) || '', /Borrar/);
  // lo que el editor no deja cambiar no se puede meter desde el navegador: sale del archivo de hoy
  const forzado = TAB().reviewDraft({ profileDir: p, draft: borradorDe(p, {}, { otrasHerramientas: ['mcp__otro__x'], otras: ['model: fable', 'permissionMode: bypass'], descripcion: 'Dos\nrenglones' }) });
  assert.deepStrictEqual(forzado.problems, []);
  assert.match(mdPropuesto(forzado), /^tools: Read, Grep, Glob, mcp__codegraph__codegraph_search$/m);
  assert.doesNotMatch(mdPropuesto(forzado), /mcp__otro__x|permissionMode|model: fable/);
  assert.match(mdPropuesto(forzado), /^description: Dos renglones$/m, 'un salto de renglón no parte la cabecera');
  // ningún separador de renglón (\r, NEL, LS, PS) mete otra clave en la cabecera, y un «:» con tab se entrecomilla
  for (const sep of ['\r', '\u0085', '\u2028', '\u2029']) {
    const r = TAB().reviewDraft({ profileDir: p, draft: borradorDe(p, {}, { descripcion: `x${sep}model:\tfable` }) });
    const md = mdPropuesto(r) || '';
    assert.ok(!/^model: fable/m.test(md) && md.split(/\r?\n/).filter((l) => /^model:/.test(l)).length === 1, `${JSON.stringify(sep)}: una sola clave model`);
    assert.match(md, /^description: "x model:\tfable"$/m, `${JSON.stringify(sep)}: en un renglón y entre comillas`);
  }
  // el .md entero (el borrador de antes del editor en campos) pasa por los mismos controles: la clave que no se muestra
  // sale del archivo y el techo se mira
  const crudo = TAB().reviewDraft({ profileDir: p, draft: { ...borradorDe(p), cabecera: undefined, instructions: '---\nname: acme-pagos-reviewer\ndescription: d\ntools: Read\nmodel: fable\npermissionMode: bypass\n---\n\nc\n' } });
  assert.doesNotMatch(mdPropuesto(crudo) || '', /permissionMode/, 'una clave nueva en el .md crudo no entra');
  // sin ninguna herramienta, se dice
  const simple = carpeta(perfilCon());
  assert.match(TAB().reviewDraft({ profileDir: simple, draft: borradorDe(simple, {}, { herramientas: [] }) }).problems.join(' · '), /herramienta/);
});

test('T8 RevisarYProponer_ElOrdenSeDice @story-2.63 @ac-7 — los botones numerados y la línea del motivo en sus tres estados', () => {
  // 🔴 rojo: «Proponer» aparece apagado sin decir por qué, o al cambiar algo no se vuelve a pedir revisar.
  for (const idioma of ['es', 'en']) {
    const t = (k) => TX().t(idioma, k);
    assert.match(t('comoTrabaja.revisar'), /^1\. /, `${idioma}: «1. Revisar»`);
    assert.match(t('comoTrabaja.proponer'), /^2\. /, `${idioma}: «2. Proponer»`);
    for (const k of ['comoTrabaja.motivoAntesDeRevisar', 'comoTrabaja.motivoRevisado', 'comoTrabaja.motivoCambiaste']) {
      assert.ok(t(k) && t(k) !== k, `${idioma}: ${k}`);
      if (idioma === 'en') assert.ok(!hasSpanish(t(k)), `${k} en inglés sin castellano`);
    }
  }
  const g = TAB().guion ? TAB().guion('es') : '';
  assert.ok(g, 'el guion del navegador se puede leer');
  // el guion lleva todos los textos en TXT: lo que se mira es que el editor los pida
  for (const k of ['motivoAntesDeRevisar', 'motivoRevisado', 'motivoCambiaste']) assert.match(g, new RegExp(`T\\('comoTrabaja\\.${k}'\\)`), `el editor usa ${k}`);
});

test('T9 Proponer_ElRevisorEntero @story-2.63 @ac-8 — el pedido trae el pack.json y el .md armado con los campos y el cuerpo', () => {
  // 🔴 rojo: el .md propuesto pierde la clave que el editor no muestra, o el pack.json cambia más que el revisor.
  const p = perfilCompleto();
  const antes = JSON.parse(fs.readFileSync(path.join(p, 'packs', 'acme-pagos', 'pack.json'), 'utf8'));
  const usos = TAB().draftOf(p, 'acme-pagos', 'acme-pagos-reviewer').draft.uses.map((u) => ({ ...u, prefix: 'COBRO' }));
  const r = TAB().reviewDraft({ profileDir: p, draft: borradorDe(p, { cuerpo: '## Qué mirás\n- Los reintentos de cobro.\n', uses: usos }, { descripcion: 'Revisa el cobro y sus reintentos.', modelo: 'strong' }) });
  assert.deepStrictEqual(r.problems, []);
  assert.deepStrictEqual(r.files.map((f) => f.archivo), ['packs/acme-pagos/pack.json', 'packs/acme-pagos/agents/acme-pagos-reviewer.md']);
  const pack = JSON.parse(r.files[0].contenido);
  assert.deepStrictEqual({ ...pack, reviewers: undefined }, { ...antes, reviewers: undefined }, 'el resto del paquete viaja igual');
  assert.deepStrictEqual(pack.reviewers[0].prefixes, ['COBRO']);
  assert.strictEqual(mdPropuesto(r), '---\nname: acme-pagos-reviewer\ndescription: Revisa el cobro y sus reintentos.\ntools: Read, Grep, Glob, mcp__codegraph__codegraph_search\nmodel: opus\ncolor: blue\n---\n\n## Qué mirás\n- Los reintentos de cobro.\n');
});

test('T10 CabeceraArmada_SeLeeComoAntes @story-2.63 @ac-8 — el .md armado lo leen la pestaña y el pipeline; comillas sólo donde hacen falta', () => {
  // 🔴 rojo: el .md armado lleva comillas de más, o una descripción con «: » rompe la cabecera.
  const armado = TAB().armarAgente({ nombre: 'acme-pagos-reviewer', descripcion: 'Revisa el cobro: pagos y reintentos', herramientas: ['Read', 'Grep'], otrasHerramientas: [], modelo: 'max', otras: [] }, 'Cuerpo.\n');
  assert.match(armado, /^description: "Revisa el cobro: pagos y reintentos"$/m, 'con «: » va entre comillas');
  assert.match(armado, /^name: acme-pagos-reviewer$/m, 'un nombre simple, sin comillas');
  const cab = TAB().cabeceraDe(armado);
  assert.deepStrictEqual([cab.claves.name, cab.claves.description, cab.claves.tools, cab.claves.model], ['acme-pagos-reviewer', 'Revisa el cobro: pagos y reintentos', 'Read, Grep', 'fable']);
  // el cargador del pipeline lee el modelo del .md armado
  const agentes = carpeta({ 'acme-pagos-reviewer.md': armado });
  assert.strictEqual(MODELS().frontmatterModel('acme-pagos-reviewer', { agentsDir: agentes }), 'fable');
  // sin modelo elegido: sin la clave (el que use la organización)
  assert.doesNotMatch(TAB().armarAgente({ nombre: 'x-reviewer', descripcion: 'd', herramientas: ['Read'], otrasHerramientas: [], modelo: '', otras: [] }, 'c\n'), /^model:/m);
});

test('T10b CabeceraArmada_IdaYVuelta_SinCambios @story-2.63 @ac-8 (pase adversarial) — abrir y guardar sin tocar nada deja los mismos bytes; YAML lee cada valor como texto', () => {
  // 🔴 rojo: cada vuelta suma barras invertidas, o un valor como «null», «123» o «termina en:» queda sin comillas y
  // YAML lo lee como otra cosa (o no lo lee).
  const descripciones = ['Mira "todo": el codigo', "It's: fine", 'Ruta C:\\x: y', 'termina en:', 'null', '~', 'true', 'no', '123', '-1.5', 'a\ttab: x', 'simple sin nada'];
  for (const d of descripciones) {
    const c = { nombre: 'acme-x-reviewer', descripcion: d, herramientas: ['Read'], otrasHerramientas: [], modelo: '', otras: [] };
    const md = TAB().armarAgente(c, 'Cuerpo.\n');
    const leida = TAB().camposDe(md).cabecera;
    assert.strictEqual(leida.descripcion, d, `${JSON.stringify(d)}: se lee igual que se escribió`);
    assert.strictEqual(TAB().armarAgente({ ...c, descripcion: leida.descripcion }, 'Cuerpo.\n'), md, `${JSON.stringify(d)}: una segunda vuelta no cambia nada`);
    const renglon = md.split('\n').find((l) => l.startsWith('description: '));
    if (d !== 'simple sin nada') assert.match(renglon, /^description: (".*"|'.*')$/, `${JSON.stringify(d)}: entre comillas (${renglon})`);
    else assert.strictEqual(renglon, 'description: simple sin nada', 'lo simple, sin comillas');
  }
  // un .md con la descripción entre comillas simples o dobles, como lo escribe otra herramienta
  assert.strictEqual(TAB().camposDe("---\nname: x\ndescription: 'It''s here'\ntools: Read\n---\nc\n").cabecera.descripcion, "It's here");
  assert.strictEqual(TAB().camposDe('---\nname: x\ndescription: "Una \\"cita\\" y \\\\barra"\ntools: Read\n---\nc\n').cabecera.descripcion, 'Una "cita" y \\barra');
});

test('T2b Editor_CabeceraEnVariosRenglones_YConBom @story-2.63 @ac-2 @ac-3 (pase adversarial) — los valores de varios renglones de YAML y un .md con BOM se leen bien y se guardan sanos', () => {
  // 🔴 rojo: la descripción en bloque se lee como «>», las herramientas en lista se pierden, sus renglones quedan colgando
  // debajo de otra clave al guardar, o un .md con BOM abre con los campos vacíos.
  const md = '---\nname: acme-x-reviewer\ndescription: >\n  Revisa los cobros\n  y sus recibos.\ntools:\n  - Read\n  - Grep\n  - mcp__codegraph__codegraph_search\nmodel: sonnet\nnotas: |\n  primera\n  segunda\ncolor: red\n---\n\nCuerpo.\n';
  const { cabecera, cuerpo } = TAB().camposDe(md);
  assert.strictEqual(cabecera.descripcion, 'Revisa los cobros y sus recibos.');
  assert.deepStrictEqual(cabecera.herramientas, ['Read', 'Grep']);
  assert.deepStrictEqual(cabecera.otrasHerramientas, ['mcp__codegraph__codegraph_search']);
  assert.strictEqual(cabecera.modelo, 'balanced');
  assert.deepStrictEqual(cabecera.otras, ['notas: |', '  primera', '  segunda', 'color: red'], 'las otras claves, con sus renglones juntos');
  assert.strictEqual(cuerpo, 'Cuerpo.\n');
  const armado = TAB().armarAgente(cabecera, cuerpo);
  assert.strictEqual(armado, '---\nname: acme-x-reviewer\ndescription: Revisa los cobros y sus recibos.\ntools: Read, Grep, mcp__codegraph__codegraph_search\nmodel: sonnet\nnotas: |\n  primera\n  segunda\ncolor: red\n---\n\nCuerpo.\n');
  // con BOM (un editor de Windows lo agrega): se reconoce la cabecera y se guarda sin él
  const conBom = TAB().camposDe(`\uFEFF${AGENTE_COMPLETO('acme-pagos-reviewer')}`);
  assert.strictEqual(conBom.cabecera.nombre, 'acme-pagos-reviewer');
  assert.ok(!/^---/.test(conBom.cuerpo), 'el cuerpo sin la cabecera');
  assert.ok(TAB().cabeceraDe(`\uFEFF${AGENTE_COMPLETO('acme-pagos-reviewer')}`), 'la revisión también la reconoce');
  // (vuelta 2) un valor entre comillas con un comentario al final, o con el comentario abajo, se lee sin las comillas;
  // una clave que el lector no reconoce y un comentario suelto no se pegan al valor de la clave anterior
  const conComentarios = TAB().camposDe('---\nname: acme-x-reviewer\ndescription: "Mira: todo" # nota\nmodel: "sonnet"\n  # abajo\n"a-b": 1\nx.y: 2\n# suelto\ntools: Read\n---\nc\n').cabecera;
  assert.strictEqual(conComentarios.descripcion, 'Mira: todo');
  assert.strictEqual(conComentarios.modelo, 'balanced', 'el modelo no cambia');
  assert.deepStrictEqual(conComentarios.otras, ['"a-b": 1', 'x.y: 2', '# suelto'], 'cada renglón como estaba');
  // una herramienta leída del archivo con un fin de renglón adentro no parte la cabecera al guardar
  const partida = TAB().armarAgente({ nombre: 'x', descripcion: 'd', herramientas: [], otrasHerramientas: ['mcp__a\nmodel: opus'], modelo: '', otras: [] }, 'c');
  assert.ok(!/^model:/m.test(partida), `ninguna clave nueva (${partida})`);
});

test('T21 Herramientas_ConSuExplicacion_EsEn @story-2.63 @ac-17 — cada casilla con su explicación corta, y que un revisor sólo lee', () => {
  // 🔴 rojo: las casillas dicen sólo el nombre de la herramienta, o la explicación en inglés sale en castellano.
  assert.deepStrictEqual(TAB().HERRAMIENTAS, ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']);
  for (const idioma of ['es', 'en']) {
    for (const h of TAB().HERRAMIENTAS) {
      const k = `comoTrabaja.herramienta.${h}`;
      const v = TX().t(idioma, k);
      assert.ok(v && v !== k, `${idioma}: ${h} con su explicación`);
      if (idioma === 'en') assert.ok(!hasSpanish(v), `${h}: «${v}» sin castellano`);
    }
    assert.ok(TX().t(idioma, 'comoTrabaja.revisorSoloLee') !== 'comoTrabaja.revisorSoloLee', `${idioma}: la línea de que un revisor sólo lee`);
  }
  assert.match(TAB().guion('es'), /T\('comoTrabaja\.herramienta\.' \+ /, 'el editor pone la explicación al lado de cada casilla');
  assert.match(TAB().guion('es'), /T\('comoTrabaja\.revisorSoloLee'\)/, 'y la línea de que un revisor sólo lee');
});

// ════════════════════════ el revisor como unidad: una solapa por uso ════════════════════════

// el revisor de dos usos («revisa el cambio» y «valida la historia»), con su .md en la carpeta de su paquete
const PAQUETE_DOS_USOS = ({ cuando = { detection: 'csModified' } } = {}) => ({
  name: 'acme-clientes', description: 'Los revisores de los clientes de Acme.', agents: 'agents',
  reviewers: [
    { agent: 'acme-hermanos-reviewer', group: 'condicional', when: cuando, surface: { paths: ['**/*.cs'] }, depth: 'deep', prefixes: ['HERM'] },
    { agent: 'acme-hermanos-reviewer', group: 'validacion', when: { detection: 'csModified' }, model: 'sonnet', prompt: 'Validá {story_path} en {repo_path}', prefixes: ['HERM'] },
  ],
});
const perfilDosUsos = ({ paquete = PAQUETE_DOS_USOS(), lugar = 'paquete', repos = null } = {}) => carpeta(perfilCon({ paquete: null, repos, extra: {
  'packs/acme-clientes/pack.json': paquete,
  ...(lugar === 'paquete' ? { 'packs/acme-clientes/agents/acme-hermanos-reviewer.md': AGENTE('acme-hermanos-reviewer') } : {}),
  ...(lugar === 'raiz' ? { 'agents/acme-hermanos-reviewer.md': AGENTE('acme-hermanos-reviewer') } : {}),
} }));
const usoDe = (d, validacion) => d.uses.find((u) => (u.group === 'validacion') === validacion);
const conUsos = (d, cambiar) => ({ ...d, uses: d.uses.map((u) => cambiar(JSON.parse(JSON.stringify(u)))) });

test('T1 Revisor_UnaVezPorPaso @story-2.63 @ac-1 — un revisor de dos usos, una vez en cada paso, y los dos «Editar» abren el mismo editor en su solapa', () => {
  // 🔴 rojo: el uso que valida la historia no se edita, y el editor abre una entrada del manifiesto, no el revisor.
  const m = HIW().buildModel({ treeDir: ROOT, profileDir: perfilDosUsos() });
  const [en5, en1] = ['reviewers', 'validate-story'].map((id) => deClientes(m, id));
  assert.deepStrictEqual([en5.length, en1.length], [1, 1], 'una vez en Revisores y una vez en Validar la historia');
  assert.deepStrictEqual([en5[0].use, en1[0].use], ['cambio', 'validacion']);
  assert.ok(en5[0].editable && en1[0].editable, 'los dos usos se editan');
  const html = TAB().renderPage(m, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
  for (const [id, uso] of [['reviewers', 'cambio'], ['validate-story', 'validacion']]) {
    const botones = seccionDe(html, id).match(/data-action="edit"[^>]*data-agent="acme-hermanos-reviewer"[^>]*/g) || [];
    assert.strictEqual(botones.length, 1, `paso ${id}: un «Editar»`);
    assert.match(botones[0], new RegExp(`data-use="${uso}"`), `paso ${id}: abre la solapa «${uso}»`);
  }
  // el editor trae el revisor entero, con sus dos usos en el orden del manifiesto
  const d = TAB().draftOf(perfilDosUsos(), 'acme-clientes', 'acme-hermanos-reviewer').draft;
  assert.deepStrictEqual(d.uses.map((u) => u.group), ['condicional', 'validacion']);
  assert.match(TAB().guion('es'), /getAttribute\('data-use'\)/, 'el guion abre la solapa del uso del botón');
});

test('T5 UsoCambio_CamposLlanos @story-2.63 @ac-4 — «Entra», «Archivos que mira» como etiquetas, «Código de sus hallazgos» con su ejemplo y la profundidad', () => {
  // 🔴 rojo: la solapa dice «Prefijo de sus reglas» y las rutas van en un cuadro de texto.
  const t = (idioma, k, v) => TX().t(idioma, k, v);
  assert.strictEqual(t('es', 'comoTrabaja.campoRutas'), 'Archivos que mira');
  assert.strictEqual(t('es', 'comoTrabaja.campoPrefijo'), 'Código de sus hallazgos');
  for (const idioma of ['es', 'en']) {
    assert.match(t(idioma, 'comoTrabaja.prefijoEjemplo', { prefijo: 'XPAT' }), /XPAT-1, XPAT-2/, `${idioma}: el ejemplo del código`);
    for (const k of ['usoCambio', 'usoValidacion', 'campoEntra', 'campoProfundidad', 'rutasAyuda', 'quitarRuta']) {
      assert.ok(t(idioma, `comoTrabaja.${k}`) !== `comoTrabaja.${k}`, `${idioma}: ${k}`);
      if (idioma === 'en') assert.ok(!hasSpanish(t('en', `comoTrabaja.${k}`, { ruta: 'x' })), `${k} sin castellano`);
    }
    for (const p of require(path.join(SCRIPTS, 'lib', 'packs.js')).VOCABULARIO.profundidades) assert.ok(t(idioma, `comoTrabaja.profundidad.${p}`) !== `comoTrabaja.profundidad.${p}`, `${idioma}: profundidad ${p}`);
    const textos = JSON.stringify(TAB().textosDelGuion(idioma));
    assert.ok(!/Prefijo de sus reglas|prefix of its rules/i.test(textos), `${idioma}: nunca «Prefijo de sus reglas»`);
  }
  const g = TAB().guion('es');
  // entre comillas simples: en el código del editor (la tabla de textos del guion va con comillas dobles)
  for (const k of ['campoRutas', 'campoPrefijo', 'prefijoEjemplo', 'campoEntra', 'campoProfundidad', 'usoCambio', 'usoValidacion', 'campoEntraCuando', 'campoModeloValidacion', 'campoPrompt', 'promptAyuda', 'rutasAyuda', 'quitarRuta']) assert.match(g, new RegExp(`'comoTrabaja\\.${k}'`), `el editor usa ${k}`);
  assert.match(g, /'Enter'/, 'las rutas se agregan con Enter');
  assert.match(g, /entrada\.addEventListener\('input', cambio\)/, 'escribir una ruta sin Enter también apaga «Proponer»');
  assert.match(g, /ct-etiqueta/, 'y se muestran como etiquetas');
  const d = TAB().draftOf(perfilDosUsos(), 'acme-clientes', 'acme-hermanos-reviewer').draft;
  assert.deepStrictEqual(usoDe(d, false), { group: 'condicional', detection: 'csModified', whenWritten: false, whenText: '', paths: ['**/*.cs'], always: false, prefix: 'HERM', depth: 'deep' });
});

test('T6 UsoValidacion_SeEdita @story-2.63 @ac-5 @ac-11 — el modelo y lo que le pide la validación se editan y viajan en el pack.json', () => {
  // 🔴 rojo: el uso que valida la historia dice «no se puede editar».
  const perfil = perfilDosUsos();
  const d = TAB().draftOf(perfil, 'acme-clientes', 'acme-hermanos-reviewer').draft;
  const v = usoDe(d, true);
  assert.deepStrictEqual([v.detection, v.modelo, v.modeloTalCual, v.prompt], ['csModified', 'balanced', false, 'Validá {story_path} en {repo_path}']);
  const antes = JSON.parse(fs.readFileSync(path.join(perfil, 'packs', 'acme-clientes', 'pack.json'), 'utf8'));
  const r = TAB().reviewDraft({ profileDir: perfil, draft: conUsos(d, (u) => (u.group === 'validacion' ? { ...u, modelo: 'strong', prompt: 'Validá con cuidado {story_path} en {repo_path}' } : u)) });
  assert.deepStrictEqual(r.problems, []);
  const pack = JSON.parse(r.files[0].contenido);
  assert.deepStrictEqual(pack.reviewers[0], antes.reviewers[0], 'el otro uso, igual');
  assert.deepStrictEqual(pack.reviewers[1], { ...antes.reviewers[1], model: 'opus', prompt: 'Validá con cuidado {story_path} en {repo_path}' });
  // «el que use la organización»: sin la clave
  const sinModelo = TAB().reviewDraft({ profileDir: perfil, draft: conUsos(d, (u) => (u.group === 'validacion' ? { ...u, modelo: '' } : u)) });
  assert.ok(!('model' in JSON.parse(sinModelo.files[0].contenido).reviewers[1]));
  // el techo de la organización vale también para la validación
  const GH = (repo) => ({ platform: 'github', org: 'acme', repo });
  const conTecho = perfilDosUsos({ repos: { version: 1, public: GH('arnes'), profile: GH('perfil'), operations: GH('operaciones'), models: { mandatory_ceiling: true, ceiling: 'balanced' } } });
  const dt = TAB().draftOf(conTecho, 'acme-clientes', 'acme-hermanos-reviewer').draft;
  assert.match(TAB().reviewDraft({ profileDir: conTecho, draft: conUsos(dt, (u) => (u.group === 'validacion' ? { ...u, modelo: 'max' } : u)) }).problems.join(' · '), /techo/);
  // un modelo que no se traduce a un nivel se muestra y se guarda tal cual
  const raro = perfilDosUsos({ paquete: { ...PAQUETE_DOS_USOS(), reviewers: PAQUETE_DOS_USOS().reviewers.map((x) => (x.group === 'validacion' ? { ...x, model: 'claude-opus-4-1-20250805' } : x)) } });
  const dr = TAB().draftOf(raro, 'acme-clientes', 'acme-hermanos-reviewer').draft;
  assert.deepStrictEqual([usoDe(dr, true).modelo, usoDe(dr, true).modeloTalCual], ['claude-opus-4-1-20250805', true]);
  assert.strictEqual(JSON.parse(TAB().reviewDraft({ profileDir: raro, draft: dr }).files[0].contenido).reviewers[1].model, 'claude-opus-4-1-20250805');
  // lo que le pide, vacío: lo dice el validador; y la explicación de {story_path} y {repo_path}, en los dos idiomas
  assert.match(TAB().reviewDraft({ profileDir: perfil, draft: conUsos(d, (u) => (u.group === 'validacion' ? { ...u, prompt: '  ' } : u)) }).problems.join(' · '), /prompt/);
  for (const idioma of ['es', 'en']) {
    const ayuda = TX().t(idioma, 'comoTrabaja.promptAyuda');
    assert.ok(ayuda.includes('{story_path}') && ayuda.includes('{repo_path}'), `${idioma}: explica los dos`);
    for (const k of ['campoEntraCuando', 'campoModeloValidacion', 'campoPrompt']) assert.ok(TX().t(idioma, `comoTrabaja.${k}`) !== `comoTrabaja.${k}`, `${idioma}: ${k}`);
  }
  assert.ok(!('comoTrabaja.noEditableValidacion' in TX().TEXTOS), 'el motivo de «no se edita la validación» ya no existe');
  // los usos no se suman ni se quitan desde el editor, ni un uso cambia de paso
  assert.strictEqual(TAB().reviewDraft({ profileDir: perfil, draft: { ...d, uses: [usoDe(d, false)] } }).ok, false);
  assert.strictEqual(TAB().reviewDraft({ profileDir: perfil, draft: conUsos(d, (u) => ({ ...u, group: 'condicional' })) }).ok, false);
});

test('T6b Usos_NombreYPasoSeCuidan @story-2.63 @ac-5 @ac-8 (pase adversarial) — renombrar sobre otro revisor del paquete frena; un uso que cambia de paso da un solo problema', () => {
  // 🔴 rojo: el nombre de otro revisor (en otro paso) pasaba y su .md se pisaba; un revisor nuevo con un uso que valida
  // sumaba «reviewers[N]: tiene que ser un objeto» al problema verdadero.
  const otro = { agent: 'acme-otro-reviewer', group: 'validacion', when: { detection: 'csModified' }, prompt: 'Validá {story_path} en {repo_path}', prefixes: ['OTRO'] };
  const perfil = perfilDosUsos({ paquete: { ...PAQUETE_DOS_USOS(), reviewers: [...PAQUETE_DOS_USOS().reviewers, otro] } });
  fs.writeFileSync(path.join(perfil, 'packs', 'acme-clientes', 'agents', 'acme-otro-reviewer.md'), AGENTE('acme-otro-reviewer'));
  const d = TAB().draftOf(perfil, 'acme-clientes', 'acme-hermanos-reviewer').draft;
  const pisa = TAB().reviewDraft({ profileDir: perfil, draft: { ...d, agent: 'acme-otro-reviewer', cabecera: { ...d.cabecera, nombre: 'acme-otro-reviewer' } } });
  assert.strictEqual(pisa.ok, false);
  assert.deepStrictEqual(pisa.files, [], 'ningún archivo propuesto');
  assert.match(pisa.problems.join(' · '), /ya tiene un revisor que se llama acme-otro-reviewer/);
  // un revisor nuevo cuyo único uso dice validar: un solo problema, el verdadero
  const nuevo = TAB().reviewDraft({ profileDir: perfil, draft: { pack: 'acme-clientes', agent: 'acme-nuevo-reviewer', uses: [{ group: 'validacion', detection: 'csModified' }], cabecera: { nombre: 'acme-nuevo-reviewer', descripcion: 'd', herramientas: ['Read'] }, cuerpo: 'x\n' } });
  assert.strictEqual(nuevo.ok, false);
  assert.ok(!nuevo.problems.some((x) => /tiene que ser un objeto/.test(x)), `sin el problema de una entrada vacía: ${nuevo.problems.join(' · ')}`);
  assert.ok(nuevo.problems.some((x) => /no pasa de revisar el cambio a validar la historia/.test(x)));
});

test('T12 TextosYTema @story-2.63 @ac-12 — los textos del editor en es y en, el inglés sin castellano; los estilos con las variables del tema y la regla del teléfono', () => {
  // 🔴 rojo: un texto del editor sin su inglés (o con castellano), un color escrito a mano, o las solapas sin la regla
  // de pantalla angosta.
  const claves = Object.keys(TX().TEXTOS).filter((k) => /^comoTrabaja\.(uso|campo|profundidad\.|rutas|quitarRuta|prefijo|prompt|condicionPropia|verComoEsta|herramienta\.|lte\.|err\.(usos|usoCambiado|profundidad|nombreEnUso|modelo)|revisorSoloLee|motivo)|^pantalla\.lte\./.test(k));
  assert.ok(claves.length >= 40, `los textos del editor (${claves.length})`);
  for (const k of claves) {
    const e = TX().TEXTOS[k];
    assert.ok(e && e.es && e.en, `${k}: es y en`);
    assert.deepStrictEqual(enCastellano([TX().t('en', k, { ruta: 'x', prefijo: 'X', modelo: 'x', revisor: 'x', techo: 'x', motivo: 'x', n: 2 })]), [], `${k}: el inglés sin castellano`);
  }
  // los estilos del editor: sólo variables del tema (nada de colores escritos a mano)
  const css = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'static', 'site.css'), 'utf8');
  const editor = css.split('\n').filter((l) => /^\.(ct-solapa|ct-usos|ct-uso|ct-campo|ct-rutas|ct-x|ct-propia|ct-panel \.ct-rutas|ct-etiqueta|ct-herramientas|ct-casilla|lte)/.test(l));
  assert.ok(editor.length >= 10, 'las reglas del editor');
  for (const l of editor) assert.doesNotMatch(l, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, `sólo variables del tema: ${l}`);
  // en pantalla angosta: las solapas se parten en renglones y las casillas van de a una (sin scroll lateral)
  assert.match(css, /\.ct-solapas\{[^}]*flex-wrap:wrap/);
  const angosta = css.slice(css.indexOf('@container (max-width:700px)'));
  assert.match(angosta, /\.ct-herramientas\{grid-template-columns:1fr\}/);
  assert.match(angosta, /\.ct-dos\{grid-template-columns:1fr\}/);
});

test('T7 CondicionPropia_ViajaIgual @story-2.63 @ac-6 — una condición escrita a mano se muestra de sólo lectura y viaja sin cambios', () => {
  // 🔴 rojo: la condición propia sale como «la condición escrita en el paquete» y se pierde al elegir otra.
  const cuando = { any: [{ added: { pattern: ':\\s*IBackendPlugin\\b', extensions: ['.cs'] } }, { detection: 'csModified' }] };
  const perfil = perfilDosUsos({ paquete: PAQUETE_DOS_USOS({ cuando }) });
  const d = TAB().draftOf(perfil, 'acme-clientes', 'acme-hermanos-reviewer').draft;
  const c = usoDe(d, false);
  assert.strictEqual(c.whenWritten, true);
  assert.deepStrictEqual(JSON.parse(c.whenText), cuando, 'cómo está escrita, para mostrarla');
  const r = TAB().reviewDraft({ profileDir: perfil, draft: conUsos(d, (u) => (u.group === 'validacion' ? u : { ...u, paths: ['**/*.cs', '**/*.csproj'] })) });
  assert.deepStrictEqual(r.problems, []);
  assert.deepStrictEqual(JSON.parse(r.files[0].contenido).reviewers[0].when, cuando, 'viaja sin cambios');
  for (const idioma of ['es', 'en']) {
    assert.match(TX().t(idioma, 'comoTrabaja.condicionPropia'), idioma === 'es' ? /se mantiene tal cual/ : /kept as is/);
    assert.ok(TX().t(idioma, 'comoTrabaja.verComoEsta') !== 'comoTrabaja.verComoEsta');
    const html = TAB().renderPage(HIW().buildModel({ treeDir: ROOT, profileDir: perfil }), { idioma, publicRepo: PUBLICO, version: 'v' });
    assert.ok(!/la condición escrita en el paquete|condition written in the pack/i.test(html + JSON.stringify(TAB().textosDelGuion(idioma))), `${idioma}: nunca «la condición escrita en el paquete»`);
  }
  assert.match(TAB().guion('es'), /T\('comoTrabaja\.verComoEsta'\)/, 'el editor ofrece verla');
});

test('T11 NoEditable_SoloRoto @story-2.63 @ac-11 — un paquete sano se edita entero; uno roto lo dice con su motivo', () => {
  // 🔴 rojo: un uso sano dice que no se puede editar.
  for (const idioma of ['es', 'en']) {
    const pagina = (perfil) => TAB().renderPage(HIW().buildModel({ treeDir: ROOT, profileDir: perfil }), { idioma, publicRepo: PUBLICO, version: 'v' });
    const prefijo = TX().t(idioma, 'comoTrabaja.noEditableRoto', { motivo: '' }).trim();
    assert.ok(!pagina(perfilDosUsos()).includes(prefijo), `${idioma}: un paquete sano no dice que no se edita`);
    // sin su .md: roto, con el motivo
    assert.ok(pagina(perfilDosUsos({ lugar: 'ninguno' })).includes(prefijo), `${idioma}: sin el .md, roto`);
    // con el .md sólo en agents/ de la raíz: roto, con la regla en llano
    const enLaRaiz = pagina(perfilDosUsos({ lugar: 'raiz' }));
    assert.ok(enLaRaiz.includes(prefijo), `${idioma}: con el .md en la raíz, roto`);
    assert.match(enLaRaiz, /tienen que estar en packs\/acme-clientes\/agents\/acme-hermanos-reviewer\.md/);
  }
});
