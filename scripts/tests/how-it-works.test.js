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
  const { STEPS } = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  const pasos = HIW().readSteps(ROOT);
  assert.deepStrictEqual(pasos.map((p) => p.id), STEPS.map((s) => s.id), 'los mismos ids, en el mismo orden');
  assert.deepStrictEqual(pasos.filter((p) => !p.inSequence).map((p) => p.id), ['7b', '9'], 'los dos fuera del recorrido');
  for (const p of pasos) {
    const texto = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', p.file), 'utf8');
    const objetivo = /^\*\*Objetivo\*\*:\s*(.+)$/m.exec(texto)[1].trim();
    assert.strictEqual(p.goal, objetivo, `el objetivo de ${p.file} sale de su línea **Objetivo**`);
  }
  // un paso nuevo en la tabla aparece solo: un árbol de juguete con un paso más
  const arbol = carpeta({
    'skills/tycon-pipeline/scripts/lib/steps.js': `module.exports = { STEPS: [{ id: '0', name: 'Arranque', file: 'a.md' }, { id: 'x', name: 'Nuevo', file: 'x.md' }] };\n`,
    'skills/tycon-pipeline/steps/a.md': '# Arranque\n\n**Objetivo**: arrancar.\n',
    'skills/tycon-pipeline/steps/x.md': '# Nuevo\n\n**Objetivo**: un paso que no existía.\n',
  });
  assert.deepStrictEqual(HIW().readSteps(arbol).map((p) => [p.id, p.goal]), [['0', 'arrancar.'], ['x', 'un paso que no existía.']]);
});

test('T3 ComoTrabaja_GuiasQueCita @story-2.61 @ac-3 — el archivo del paso y las guías que cita, sin repetir', () => {
  const arbol = carpeta({
    'skills/tycon-pipeline/scripts/lib/steps.js': `module.exports = { STEPS: [{ id: '1', name: 'Uno', file: 'uno.md' }, { id: '2', name: 'Dos', file: 'dos.md' }] };\n`,
    'skills/tycon-pipeline/steps/uno.md': '# Uno\n\n**Objetivo**: uno.\n\nVer `guides/b.md` y guides/a.md, otra vez `guides/b.md`, y story-format.md.\n',
    'skills/tycon-pipeline/steps/dos.md': '# Dos\n\n**Objetivo**: dos.\n\nNada que leer.\n',
  });
  const [uno, dos] = HIW().readSteps(arbol);
  assert.deepStrictEqual(uno.guides, ['skills/tycon-pipeline/steps/uno.md', 'guides/b.md', 'guides/a.md', 'story-format.md']);
  // una guía nombrada sola, como la escriben los pasos 4 y 7b del arnés, se reconoce si existe bajo guides/
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
  // en el árbol real: el paso 4 la cita así
  assert.ok(HIW().readSteps(ROOT).find((s) => s.id === '4').guides.includes('guides/test-execution-discipline.md'));
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
  assert.deepStrictEqual(en('1').map((r) => [r.agent, r.origin]), [['arbol-validador', 'harness']]);
  assert.deepStrictEqual(en('5').map((r) => [r.agent, r.origin]).sort(), [['acme-base-reviewer', 'organization'], ['acme-pagos-reviewer', 'organization']]);
  assert.deepStrictEqual(en('7b').map((r) => r.agent).sort(), ['acme-base-reviewer', 'acme-pagos-reviewer']);
  const pagos = en('5').find((r) => r.agent === 'acme-pagos-reviewer');
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
  const paso4 = html.slice(html.indexOf('id="paso-4"'), html.indexOf('id="paso-5"'));
  assert.ok(paso4.includes(`ct-chip frena">${TX().t('es', 'comoTrabaja.frena')}<`) && paso4.includes('on-atdd-preedit'), 'el paso 4 muestra un control que frena');
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
  const { STEPS } = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  assert.deepStrictEqual(ids, [...STEPS.filter((s) => s.inSequence !== false), ...STEPS.filter((s) => s.inSequence === false)].map((s) => s.id));
  assert.ok(lista.indexOf('ct-aparte') < lista.indexOf('data-step="7b"'), '«Fuera del recorrido» antes de los de afuera');
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
  assert.ok(d.always && !d.paths.length);
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
    const delLector = (dir) => TC.integraciones(TC.cargar({ env: { TYCON_PROFILE: path.join(dir, 'team-profile.json') }, home: tmp('hiw-home-') }));
    assert.deepStrictEqual(mA.org.integrations, delLector(A));
    assert.deepStrictEqual(mB.org.integrations, delLector(B));
    const SC = require(path.join(SCRIPTS, 'lib', 'stack-config.js'));
    assert.deepStrictEqual(mA.org.rules, SC.orgRules({ file: path.join(A, 'team-repos.json') }).rules);
    assert.strictEqual(mA.org.rules.test_names.value, 'pascal');
    assert.strictEqual(mB.org.rules.test_names.value, 'snake');
    const paso = (m, id) => m.steps.find((s) => s.id === id);
    assert.strictEqual(paso(mA, '0b').off, null, 'A: el reloj corre');
    assert.strictEqual(paso(mB, '0b').off, 'clockify', 'B: el reloj, apagado en la organización');
    const controlesReloj = (m) => [...m.allSteps.controls, ...m.steps.flatMap((s) => s.controls)].filter((c) => c.integration === 'clockify');
    assert.ok(controlesReloj(mA).length && controlesReloj(mA).every((c) => !c.off));
    assert.ok(controlesReloj(mB).every((c) => c.off === 'clockify'));
    assert.deepStrictEqual(mA.org.packs.active, ['acme-pagos']);
    assert.deepStrictEqual(mB.org.packs.active, []);
    assert.ok(paso(mA, '5').reviewers.packs.some((r) => r.agent === 'acme-pagos-reviewer' && r.active));
    assert.ok(paso(mB, '5').reviewers.packs.every((r) => !r.active), 'B no tiene activo el paquete');
    const hB = TAB().renderPage(mB, { idioma: 'es', publicRepo: PUBLICO, version: 'v' });
    assert.ok(hB.includes(TX().t('es', 'comoTrabaja.apagadoEnTuOrganizacion')));
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
  assert.ok(paso('2').includes('mockup'));
  assert.ok(paso('3').includes('mockupApproval'));
  for (const id of ['browserTest', 'screenReadability']) assert.ok(paso('7c').includes(id), id);
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
    assert.ok(p.texto.includes(TX().t('es', 'paso.5')));
    // el editor pide el revisor de hoy; uno que no está da 404 con su motivo
    const hoy = await h.pedir('/api/como-trabaja/revisor?pack=acme-pagos&agent=acme-pagos-reviewer', { cookie: lead });
    assert.strictEqual(hoy.status, 200);
    assert.strictEqual(hoy.json.draft.instructions, AGENTE('acme-pagos-reviewer'));
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
