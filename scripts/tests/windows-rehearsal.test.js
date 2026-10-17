'use strict';

/**
 * windows-rehearsal.test.js — los guiones que ENSAYAN la instalación del equipo en un agente Windows: el alta de un dev
 * nuevo (`onboarding`) y la máquina del viernes que se actualiza a lo de hoy (`update`). Story 8.17, tanda W0.
 *
 * Como `windows-probe.test.js`, lo que se mide acá NO es Windows: es que los guiones (`scripts/tests/windows/`) y el
 * pipeline que los corre hagan lo que dicen. Lo que no se puede perder:
 *   R1 · el pipeline elige el escenario por un parámetro (`measure` por defecto, como antes), los ensayos tienen sus dos
 *        trabajos, no nombran ningún secreto, traen la historia y las etiquetas (la marca del viernes) y publican el
 *        reporte antes del veredicto.
 *   R2 · el texto del alta DE VERDAD (`onboarding/new-dev-harness-setup.md`) trae todas las piezas que el ensayo corre:
 *        si el texto cambia de forma, esta prueba se pone roja antes de que el ensayo corra a medias.
 *   R3 · la comparación de dos fotos pone a cada diferencia su gravedad: un hook que se perdió o que apunta a un archivo
 *        que ya no existe «pierde un control»; un freno que ahora frena lo legítimo o un enlace roto «rompe el trabajo
 *        del dev»; lo demás es «ruido». Un hook retirado a propósito no cuenta como perdido.
 *   R4 · el veredicto es rojo sólo si no se pudo ensayar (reporte vacío, un paso que falta, un paso en error): lo que
 *        el ensayo encuentra, por grave que sea, no pone roja la corrida.
 *   R5 · nunca la carpeta de usuario real: sin la marca del laboratorio nadie mide ni escribe.
 *   R6 · los bundles de los dos repos: `main` es lo de hoy, `friday` la marca; sin la marca, no hay bundle.
 *   R7 · la copia que mide `measure` se arma con el exportador y las listas DEL COMMIT QUE SE MIDE, no con los de la
 *        rama del pipeline (corrida 11678): un commit que no trae los archivos de la W0 se puede medir igual.
 *   R8 · los `.sh` y `.ps1` con `\r` se cuentan archivo por archivo (la corrida 11677 contó «0 de 1»: no había contado).
 *   R9 · el texto del alta se lee en sus DOS formas, y el ensayo dice cuál leyó: la de dos clones (el arnés y
 *        agent-skills, con los enlaces, el import y la línea de arranque a mano) y la de un solo clon (el repo trae
 *        `skills/` y `agents/` en su raíz y `harness.js install` lo deja todo). Con un clon, la carpeta de las skills
 *        ES el clon. Un texto que no calza con ninguna no se ensaya a medias: dice qué buscó de cada forma (la corrida
 *        11745 salió roja sin medir nada: el ensayo sólo entendía la de dos clones).
 *   Y un recorrido entero en modo de laboratorio sobre dos repos de juguete con su viernes y su hoy: el alta, la
 *   actualización con sus cuatro variantes, y el reporte. Y otro, más corto, sobre un arnés de juguete de un solo clon.
 *
 * Sin dependencias y sin el instalador real: nunca toca la carpeta de usuario de quien la corre. El recorrido de
 * juguete es del modo de laboratorio: se saltea en Windows (ahí corre el ensayo de verdad) y sin `pwsh`.
 *
 * Correr: node --test scripts/tests/windows-rehearsal.test.js
 * Para leer el reporte que deja el recorrido de juguete: TYCON_WINDOWS_REHEARSAL_KEEP=<carpeta> node --test …
 */

// story 8.39 (decisión 20): los laboratorios que lanzan harness.js no bajan el Node del arnés de nodejs.org (lo heredan)
process.env.TYCON_HARNESS_NODE = '0';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'scripts', 'tests', 'windows');
const FIXTURES = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'windows');
const PIPELINE = path.join(ROOT, 'pipelines', 'azure-pipelines-windows.yml');
const L = require(path.join(DIR, 'lab.js'));
const T = require(path.join(DIR, 'team-lab.js'));
const rehearse = require(path.join(DIR, 'rehearse.js'));
const sources = require(path.join(DIR, 'build-sources.js'));
const update = require(path.join(DIR, 'update-probe.js'));
const onboarding = require(path.join(DIR, 'onboarding-probe.js'));
const npx = require(path.join(DIR, 'npx-probe.js'));

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const node = (args, opts = {}) => spawnSync(process.execPath, args, Object.assign({ encoding: 'utf8', timeout: 120000 }, opts));
const tmp = (name) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `windows-rehearsal-${name}-`));
const has = (bin) => L.scanPath(bin).length > 0;
const git = (args, cwd) => spawnSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const write = (root, files) => { for (const [rel, text] of Object.entries(files)) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); } };
const listing = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(dir, p)); if (e.isDirectory()) walk(p); } }; if (fs.existsSync(dir)) walk(dir); return out.sort(); };

// ═══ R1 · el pipeline ══════════════════════════════════════════════════════════════════════════════════════════

test('RehearsalPipeline_Yaml_ScenarioParameter_TwoJobs_NoSecrets_TagsFetched', { skip: !fs.existsSync(PIPELINE) && 'NO MEDIDO — este árbol no trae pipelines/azure-pipelines-windows.yml (vive en el repo del equipo)' }, () => {
  const yml = fs.readFileSync(PIPELINE, 'utf8');
  const code = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const params = code.slice(code.indexOf('parameters:'), code.indexOf('jobs:'));
  // el escenario: un parámetro cerrado, `measure` por defecto (lo de antes no cambia si nadie dice nada)
  const scenario = /- name: scenario\n\s+displayName: .*\n\s+type: string\n\s+default: (\w+)\n\s+values:\n((?:\s+- [\w-]+\n)+)/.exec(params);
  assert.ok(scenario, 'el parámetro scenario, con su lista cerrada de valores');
  assert.strictEqual(scenario[1], 'measure', 'por defecto, measure');
  assert.deepStrictEqual(scenario[2].trim().split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean), ['measure', 'onboarding', 'update', 'portable', 'no-clone', 'codex-only', 'console-windows', 'migrate', 'waiver', 'npx', 'npx-published', 'all']);   // no-clone: story 8.23 B · codex-only: 8.23 C · npx y npx-published: 8.40
  for (const p of ['harnessRef', 'skillsRef', 'fridayTag']) assert.match(params, new RegExp(`- name: ${p}\\n\\s+displayName: .*\\n\\s+type: string\\n`), `el parámetro ${p}`);
  // la marca del viernes: el parámetro va vacío y cada fuente lo resuelve (story 8.26, tanda D): con azure, la de
  // siempre —en el paso que arma los bundles de los dos repos—; con github no hay una por defecto
  assert.match(params, /- name: fridayTag\n\s+displayName: .*\n\s+type: string\n\s+default: ''\n/, 'fridayTag: vacío por defecto');
  assert.match(code, /FRIDAY_TAG: \$\{\{ coalesce\(parameters\.fridayTag, 'retorno\/2026-10-02-fin-del-viernes'\) \}\}/, 'con azure, sin decir nada, la marca del viernes de siempre');
  // los cuatro trabajos, y cuál corre con cada escenario
  const jobs = [...code.matchAll(/^ {2}- job: (\w+)/gm)].map((m) => m[1]);
  assert.deepStrictEqual(jobs, ['Bundle', 'Windows', 'Sources', 'Rehearsal']);
  const job = (name) => code.slice(code.indexOf(`- job: ${name}`), jobs[jobs.indexOf(name) + 1] ? code.indexOf(`- job: ${jobs[jobs.indexOf(name) + 1]}`) : undefined);
  for (const name of ['Bundle', 'Windows']) assert.match(job(name), /condition: .*in\('\$\{\{ parameters\.scenario \}\}', 'measure', 'all'\)/, `${name} corre con measure y all`);
  // (y con portable, el escenario de la base portable: su contrato es windows-portable.test.js, P1)
  for (const name of ['Sources', 'Rehearsal']) assert.match(job(name), /condition: .*in\('\$\{\{ parameters\.scenario \}\}', 'onboarding', 'update', 'portable', 'no-clone', 'codex-only', 'console-windows', 'migrate', 'waiver', 'npx', 'npx-published', 'all'\)/, `${name} corre con onboarding, update, portable, no-clone, codex-only, console-windows, migrate, waiver, npx, npx-published y all`);
  // cada escenario aparte corre SU paso del ensayo, y sólo con su valor (story 8.23, tandas B y C; npx y npx-published:
  // story 8.40, AC 34 y 40)
  for (const own of ['no-clone', 'codex-only', 'console-windows', 'migrate', 'waiver', 'npx', 'npx-published']) {
    assert.match(job('Rehearsal'), new RegExp(`- \\$\\{\\{ if eq\\(parameters\\.scenario, '${own}'\\) \\}\\}:\\n\\s+- script: node scripts/tests/windows/rehearse\\.js step ${own} --lab "\\$\\(lab\\)" --out "\\$\\(report\\)"`), `el escenario ${own} corre su paso`);
  }
  // los dos repos se traen en Linux, con historia y etiquetas (la marca del viernes es una etiqueta), y viajan como bundles
  const src = job('Sources');
  assert.match(src, /vmImage: 'ubuntu-latest'/);
  assert.match(src, /fetchDepth: 0\b/, 'el checkout trae la historia');
  assert.match(src, /fetchTags: true\b/, 'y las etiquetas');
  // agent-skills es su repo de ANTES de la unión, clonado por el trabajo con el token de la corrida: la plantilla compartida,
  // en el repo unido (story 8.18), lo enlaza al propio checkout, y ahí no está la marca del viernes de agent-skills
  assert.doesNotMatch(src, /template: \/pipelines\/templates\/traer-repos\.yml/, 'el ensayo no toma agent-skills de la plantilla (en el repo unido es un enlace al arnés)');
  assert.match(src, /clone --quiet "\$\{ORG\}AgentSkills\/_git\/AgentSkills" "\$SK"/, 'clona el repo viejo de agent-skills');
  assert.match(src, /SK="\$\(Agent\.TempDirectory\)\/agent-skills"/, 'en una carpeta propia, nunca ~/.claude/agent-skills');
  assert.match(src, /AUTHORIZATION: bearer \$SYSTEM_ACCESSTOKEN/, 'con el token de la corrida');
  // y si el clon o sus etiquetas fallan, el trabajo sale rojo con el error del clon, nunca sigue sin agent-skills
  assert.match(src, /clone --quiet "\$\{ORG\}AgentSkills\/_git\/AgentSkills" "\$SK" 2>&1\); then\s+echo "##vso\[task\.logissue type=error\]No se pudo clonar AgentSkills: [^\n]*\$ERR[^\n]*"\s+exit 1/, 'un clon fallido: error con su motivo y exit 1');
  assert.match(src, /fetch --quiet --tags origin 2>&1\); then\s+echo "##vso\[task\.logissue type=error\]No pude traer las etiquetas de AgentSkills: [^\n]*\$ERR[^\n]*"\s+exit 1/, 'sin etiquetas: error con su motivo y exit 1');
  assert.match(src, /node scripts\/tests\/windows\/build-sources\.js /, 'los bundles los arma build-sources.js');
  assert.match(src, /artifact: rehearsal-sources/);
  // el ensayo: en windows-latest, espera a los bundles, corre por rehearse.js y publica el reporte antes del veredicto
  const reh = job('Rehearsal');
  assert.match(reh, /vmImage: 'windows-latest'/);
  assert.match(reh, /dependsOn: Sources\b/);
  assert.match(reh, /rehearse\.js init .*--sources .*--scenario /, 'el laboratorio se arma desde los bundles');
  for (const step of ['inventory', 'update', 'onboarding', 'count-hooks', 'fire-registered']) assert.match(reh, new RegExp(`rehearse\\.js step ${step} `), `el paso ${step} corre por rehearse.js`);
  assert.match(reh, /rehearse\.js finish /);
  assert.match(reh, /PublishPipelineArtifact@1[\s\S]*artifact: windows-rehearsal/, 'el reporte se publica como artefacto windows-rehearsal');
  assert.ok(reh.indexOf('artifact: windows-rehearsal') < reh.indexOf('rehearse.js verdict'), 'el reporte se publica ANTES del veredicto');
  for (const copy of ['CopyFiles@', 'Copy-Item', 'robocopy', 'xcopy', 'ExtractFiles@']) assert.ok(!reh.includes(copy), `el trabajo del ensayo no copia archivos (${copy}): clona`);
  // sin secretos: el ensayo no nombra ninguna credencial; el único token de la corrida lo usa la plantilla, en Linux
  assert.doesNotMatch(reh, /AccessToken|windowsSessionCredential|\$\(\w*(Token|Secret|Password|Credential)\w*\)/i, 'el trabajo de Windows del ensayo no recibe ninguna credencial');
  assert.doesNotMatch(code, /^\s*- group:/m, 'sin grupos de variables');
  assert.doesNotMatch(code, /continueOnError/);
  assert.doesNotMatch(code, /git (push|commit)\b/, 'no escribe en ningún repo');
  assert.match(code, /^trigger: none\b/m);
  assert.match(code, /^pr: none\b/m);
  assert.doesNotMatch(code, /^\s*schedules:/m);
  // cada paso que nombra el pipeline existe en el guion, y al revés
  assert.deepStrictEqual(rehearse.SCENARIOS.all, ['inventory', 'update', 'onboarding', 'count-hooks', 'fire-registered']);
  assert.deepStrictEqual([rehearse.SCENARIOS.update, rehearse.SCENARIOS.onboarding], [['inventory', 'update'], ['inventory', 'onboarding', 'count-hooks', 'fire-registered']]);
});

// ═══ R2 · el texto del alta de verdad ══════════════════════════════════════════════════════════════════════════

/** Lo que el ensayo corre de un texto del alta de UN SOLO CLON (el de verdad, o su recorte). */
function assertOneCloneDoc(doc) {
  assert.strictEqual(doc.shape, 'one-clone', 'dice qué forma leyó');
  assert.match(doc.blocks.clone_harness, /git clone https:\/\/\S+/);
  assert.doesNotMatch(doc.blocks.clone_harness, /agent-skills/, 'un solo clon: agent-skills no se clona');
  assert.deepStrictEqual([doc.urls.skills, doc.blocks.clone_skills, doc.blocks.links, doc.blocks.import_line, doc.startup, doc.installer], [null, undefined, undefined, undefined, null, null], 'nada de lo que la otra forma hace a mano');
  // `install --yes` desde la 8.16 B (sin terminal, `install` solo muestra el plan); el recorte de la 8.18, sin él
  assert.match(doc.blocks.install, /^node ".*scripts[\\/]setup[\\/]harness\.js" install( --yes)?$/, 'el PASO 2 corre el instalador');
  assert.match(doc.blocks.check_links, /^Get-Item .*agent-skills.*Format-List/m, 'el PASO 3 mira los cuatro enlaces');
  assert.match(doc.blocks.check_links, /README\.md'\)\.Count/, 'y el import');
  assert.match(doc.doctor, /^node ".*harness\.js" doctor$/, 'el diagnóstico del PASO 4, el comando de Windows');
  assert.match(doc.json_check, /^<PS> .*ConvertFrom-Json/);
  assert.match(doc.blocks.verify, /harness\.js" doctor/);
  assert.match(doc.blocks.verify, /bootstrap/, 'la verificación cuenta la línea de arranque que dejó el instalador');
  assert.doesNotMatch(doc.blocks.verify, /engram|bmad/i, 'la verificación va sin lo que no se instala');
}

test('Rehearsal_TeamDoc_RealTextHasEveryPieceTheRehearsalRuns', { skip: !fs.existsSync(path.join(ROOT, T.DOC)) && 'NO MEDIDO — copia sin el texto del alta del equipo' }, () => {
  const doc = T.parseTeamDoc(fs.readFileSync(path.join(ROOT, T.DOC), 'utf8'), fs.readFileSync(path.join(ROOT, T.STEP_ZERO), 'utf8'));
  assert.strictEqual(doc.problem, undefined, doc.problem);
  // desde la story 8.23 (tanda E) el alta no clona: la versión la instala el guion de la portada. Esa forma se lee como
  // `no-clone` y, en el árbol interno, el ensayo la reporta NO MEDIDO con su motivo: desde la story 8.28 ese alta se
  // ensaya siguiendo la página pública, contra una copia publicada (ahí la página y el guion de entrada están en su
  // lugar). Lo de abajo es lo que las dos formas con clon tienen que seguir trayendo.
  if (doc.shape === 'no-clone') {
    assert.strictEqual(doc.not_measured, 'el alta sin clon se ensaya contra una copia publicada (la fuente github): el árbol interno no trae la página ni el guion de entrada en su lugar', 'la forma sin clon dice por qué no se mide, entero');
    assert.ok(!/git clone/.test(fs.readFileSync(path.join(ROOT, T.STEP_ZERO), 'utf8')), 'el Step 0 de Windows ya no clona');
    assert.match(T.parseTeamDoc(null, null).problem, /no encuentro/);
    return;
  }
  assert.match(doc.step_zero, /^git clone https:\/\/\S+ "\$env:USERPROFILE\\SourceCode\\tycon-claude-guides"$/, 'el paso cero clona el arnés bajo SourceCode');
  // el texto de verdad tiene una de las dos formas (R9): el día que pase a ser de un solo clon, esta prueba lo sigue
  assert.ok(['two-clones', 'one-clone'].includes(doc.shape), `la forma leída: ${doc.shape}`);
  // las formas viejas de Windows que el árbol conoce: la canónica entre ellas, y la inventada «desconocida» no
  const known = T.knownWindowsLines(fs.readFileSync(path.join(ROOT, T.KNOWN_LINES), 'utf8'));
  assert.deepStrictEqual(known.map((k) => k.id), ['canonical-windows']);
  assert.ok(T.isOldStartup(known[0].command));
  assert.deepStrictEqual(T.knownWindowsLines('{'), []);
  assert.match(T.parseTeamDoc(null, null).problem, /no encuentro/);
  if (doc.shape === 'one-clone') { assertOneCloneDoc(doc); return; }
  assert.match(doc.blocks.clone_harness, /git clone https:\/\//);
  assert.match(doc.blocks.clone_skills, /git clone https:\/\/\S+ agent-skills/);
  assert.notStrictEqual(doc.urls.harness, doc.urls.skills, 'son dos repos');
  assert.match(doc.blocks.links, /mklink \/J/, 'los enlaces son junctions');
  assert.match(doc.blocks.import_line, /UTF8Encoding\(\$false\)/, 'el import se escribe sin marca de orden de bytes');
  assert.match(doc.startup.command, /^pwsh .*install-tycon-hooks\.ps1/, 'la línea de arranque de Windows llama al instalador');
  assert.strictEqual(doc.startup.async, true);
  assert.match(doc.installer, /^<PS> -NoProfile -ExecutionPolicy Bypass -File ".*install-tycon-hooks\.ps1"$/);
  assert.match(doc.json_check, /^<PS> .*ConvertFrom-Json/);
  assert.match(doc.blocks.verify, /SessionStart auto-update entries/);
  assert.doesNotMatch(doc.blocks.verify, /engram|bmad/i, 'la verificación va sin lo que no se instala');
  assert.ok(T.isOldStartup(doc.startup.command) && !T.isNewStartup(doc.startup.command), 'la línea del texto es una forma vieja');
  // un texto que perdió una pieza no se ensaya a medias: dice cuál
  const text = fs.readFileSync(path.join(ROOT, T.DOC), 'utf8');
  assert.match(T.parseTeamDoc(text.replace(/## PASO 2\b/, '## Paso dos'), '').problem, /PASO 2/);
  assert.match(T.parseTeamDoc(text.replace(/"command": "pwsh /, '"command": "bash '), '').problem, /línea de arranque de Windows/);
});

// ═══ R9 · las dos formas del texto del alta ════════════════════════════════════════════════════════════════════

test('Rehearsal_TeamDoc_ReadsBothShapes_AndSaysWhichOne', () => {
  // la de un solo clon: el texto real de la rama que une los dos repos, recortado a los pasos que el ensayo lee
  const text = fs.readFileSync(path.join(FIXTURES, 'onboarding-one-clone.md'), 'utf8');
  const zero = `1. Cloná el repo: \`git clone ${TOY_HARNESS_URL} "$env:USERPROFILE\\SourceCode\\tycon-claude-guides"\`\n`;
  const one = T.parseTeamDoc(text, zero);
  assert.strictEqual(one.problem, undefined, one.problem);
  assertOneCloneDoc(one);
  assert.strictEqual(one.step_zero, `git clone ${TOY_HARNESS_URL} "$env:USERPROFILE\\SourceCode\\tycon-claude-guides"`);
  // la dirección que el texto nombra se sigue sirviendo desde el laboratorio: un solo desvío (no hay segundo repo
  // que clonar, aunque su bundle esté), y el reporte no la nombra
  const state = { remotes: { harness: { dir: '/lab/remotes/harness.git' }, skills: { dir: '/lab/remotes/agent-skills.git' } } };
  assert.deepStrictEqual(T.redirectEnv(one, state), { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url./lab/remotes/harness.git.insteadOf', GIT_CONFIG_VALUE_0: one.urls.harness });
  assert.strictEqual(T.redactor(one, {})(`clonado de ${one.urls.harness}`), 'clonado de <team-harness-url>');
  assert.match(T.notRehearsed(one.shape).find((n) => n.step === 'PASO 1').why, /el repo se sirve desde el laboratorio/);
  // la de dos clones: lo de siempre, y dicho
  const two = T.parseTeamDoc(TOY_DOC, '');
  assert.deepStrictEqual([two.problem, two.shape, Object.keys(two.blocks), two.urls], [undefined, 'two-clones', ['clone_harness', 'clone_skills', 'links', 'import_line', 'verify'], { harness: TOY_HARNESS_URL, skills: TOY_SKILLS_URL }]);
  assert.deepStrictEqual([two.startup.async, two.doctor], [true, undefined]);
  assert.match(two.installer, /^<PS> .*install-tycon-hooks\.ps1"$/);
  assert.deepStrictEqual(T.redirectEnv(two, state), { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'url./lab/remotes/harness.git.insteadOf', GIT_CONFIG_VALUE_0: TOY_HARNESS_URL, GIT_CONFIG_KEY_1: 'url./lab/remotes/agent-skills.git.insteadOf', GIT_CONFIG_VALUE_1: TOY_SKILLS_URL });
  assert.deepStrictEqual(T.notRehearsed(two.shape), T.NOT_REHEARSED);
  assert.strictEqual(T.parseTeamDoc(TOY_ONE_CLONE_DOC, '').shape, 'one-clone', 'el texto de juguete de un solo clon');
  // un texto que no calza con NINGUNA de las dos no se ensaya a medias: dice qué buscó de cada forma
  const neither = T.parseTeamDoc(text.replace(/harness\.js" install/g, 'harness.js" setup'), zero).problem;
  assert.match(neither, /no calza con ninguna de las dos formas/);
  assert.match(neither, /la de dos clones: no trae los dos bloques powershell del PASO 1/);
  assert.match(neither, /la de un solo clon: no trae el bloque powershell del PASO 2 que corre «harness\.js install»/);
  assert.match(T.parseTeamDoc(text.replace(/^- Windows: `node .* doctor`$/m, '- Windows: (sin diagnóstico)'), zero).problem, /la de un solo clon: no trae el comando de Windows del diagnóstico/);
  assert.match(T.parseTeamDoc(text.replace(/## PASO 9\b/, '## Paso nueve'), zero).problem, /la de un solo clon: no trae .*PASO 9/);
  assert.match(T.parseTeamDoc(TOY_DOC.replace(/## PASO 3\b/, '## Paso tres'), '').problem, /la de dos clones: no trae .*PASO 3.* · la de un solo clon: no trae un solo bloque powershell en el PASO 1/);
});

test('Rehearsal_OneClone_TheSkillsFolderIsTheClone_LinksReposAndHeads', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('r9');
  try {
    // una carpeta de usuario como la deja el instalador de un solo clon: los cuatro enlaces llegan al mismo clon
    const home = path.join(base, 'home'); const dot = path.join(home, '.claude');
    const repo = path.join(home, 'SourceCode', 'tycon-claude-guides');
    write(repo, { 'README.md': '# de juguete\n', 'skills/toy/SKILL.md': '# x\n', 'agents/toy-reviewer.md': '# x\n' });
    git(['init', '-q'], repo); git(['add', '-A'], repo);
    assert.strictEqual(git(['commit', '-q', '-m', 'x'], repo).status, 0);
    git(['checkout', '-q', '-B', 'main'], repo);
    fs.mkdirSync(dot, { recursive: true });
    // el lugar y, como en una máquina instalada antes de la 8.19, el nombre viejo apuntando al lugar
    const PLACE = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'place.js'));
    for (const [name, to] of [[PLACE.PLACE_NAME, repo], [PLACE.LEGACY_PLACE_NAME, path.join(dot, PLACE.PLACE_NAME)], ['agent-skills', repo], ['skills', path.join(repo, 'skills')], ['agents', path.join(repo, 'agents')]]) fs.symlinkSync(to, path.join(dot, name), 'junction');
    fs.writeFileSync(path.join(dot, 'settings.json'), '{}\n');
    const env = T.rehearsalEnv(home);
    const head = git(['rev-parse', 'HEAD'], repo).stdout.trim();
    // con la forma de un clon no importa qué carpeta de skills le pasen: agent-skills, skills y agents llegan al clon
    for (const skills of [repo, path.join(base, 'no-such-clone')]) assert.deepStrictEqual(T.linkFacts(home, { clone: repo, skills, shape: 'one-clone' }).map((l) => [l.name, l.ok]), [[PLACE.PLACE_NAME, true], [PLACE.LEGACY_PLACE_NAME, true], ['agent-skills', true], ['agents', true], ['skills', true]]);
    // …y leída como de dos clones contra un clon aparte que no está, los tres de las skills no llegan: es otra instalación
    assert.deepStrictEqual(T.linkFacts(home, { clone: repo, skills: path.join(base, 'no-such-clone') }).map((l) => l.ok), [true, true, false, false, false]);
    // la foto: un solo repo que mirar, y nada que decir de un segundo clon
    const one = T.photo({ home, clone: repo, skills: repo, shape: 'one-clone', env });
    assert.deepStrictEqual([Object.keys(one.repos), one.repos.harness.head, one.repos.harness.branch, one.links.every((l) => l.ok)], [['harness'], head, 'main', true]);
    assert.ok(!T.judgePhoto(one).some((f) => /^(repo|links):/.test(f.id)), JSON.stringify(T.judgePhoto(one).map((f) => f.id)));
    const two = T.photo({ home, clone: repo, skills: path.join(base, 'no-such-clone'), env });
    assert.deepStrictEqual([Object.keys(two.repos), two.repos.skills.exists], [['harness', 'skills'], false], 'la de dos clones, como siempre');
    assert.ok(T.judgePhoto(two).some((f) => f.id === 'repo:missing:skills' && f.severity === 'breaks'));
    // una sesión que arranca: el commit de un solo clon
    const form = { id: 'default-shell', shell: 'sh', launch: (command) => ['sh', ['-c', command], {}] };
    assert.deepStrictEqual(T.fireSessionStart({ form, home, clone: repo, skills: repo, shape: 'one-clone', env, label: 'x' }).heads, { harness: head });
    assert.deepStrictEqual(T.fireSessionStart({ form, home, clone: repo, skills: repo, env, label: 'x' }).heads, { harness: head, skills: head });
    // quedó en lo de hoy: con un clon, sólo se le pide al arnés
    assert.strictEqual(T.answers(one, one, [], { target: { harness: head } }).updated, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ R3 · comparar dos fotos ═══════════════════════════════════════════════════════════════════════════════════

test('Rehearsal_ComparePhotos_EveryDifferenceHasItsSeverity', () => {
  const friday = fixture('rehearsal-photo-friday.json');
  const today = fixture('rehearsal-photo-today.json');
  const target = { harness: today.repos.harness.head, skills: today.repos.skills.head };
  // la misma foto dos veces: ninguna diferencia
  assert.deepStrictEqual(T.comparePhotos(friday, clone(friday)), []);
  const smokeBefore = { rows: [{ key: 'PreToolUse:@tcg:safety-brake.js[Bash]', event: 'PreToolUse', form: 'default-shell', exit: 0, error: null, blocked: false }, { key: 'Stop:@tcg:old-meter.js', event: 'Stop', form: 'default-shell', exit: 0, error: null, blocked: false }, { key: 'SessionStart:@tcg:flaky-notice.js', event: 'SessionStart', form: 'default-shell', exit: 1, error: null, blocked: false }] };
  const smokeAfter = { rows: [{ key: 'PreToolUse:@tcg:safety-brake.js[Bash]', event: 'PreToolUse', form: 'default-shell', exit: 2, error: null, blocked: true, said: 'frenado' }, { key: 'Stop:@tcg:old-meter.js', event: 'Stop', form: 'default-shell', exit: 1, error: null, blocked: false, said: 'Cannot find module' }, { key: 'SessionStart:@tcg:flaky-notice.js', event: 'SessionStart', form: 'default-shell', exit: 1, error: null, blocked: false }] };
  const sessions = [{ label: 'hoy-1', form: 'bash-c', hooks: [{ hook: 'startup-line', startup: 'new', exit: 1, error: null, out: '', err: '-ne: The term is not recognized' }, { hook: '@tcg:flaky-notice.js', startup: null, exit: 1, error: null, out: '', err: 'sin red' }] }, { label: 'hoy-2', form: 'default-shell', hooks: [{ hook: 'startup-line', startup: 'new', exit: 0, error: null, out: 'arnés actualizado', err: '' }] }];
  const diff = T.comparePhotos(friday, today, { sessions, smokeBefore, smokeAfter, target });
  const by = Object.fromEntries(diff.map((d) => [d.id, d.severity]));
  // rompe: el freno que ahora frena lo legítimo, y el enlace de skills que dejó de llegar
  assert.strictEqual(by['smoke:default-shell:PreToolUse:@tcg:safety-brake.js[Bash]'], 'breaks');
  assert.strictEqual(by['links:wrong:skills'], 'breaks');
  // pierde un control: el hook que desapareció, el que apunta a un archivo que no existe, el que ahora se cae, la línea
  // de arranque que falla lanzada por bash, y un doctor que suma un rojo
  assert.strictEqual(by['hooks:lost:SessionStart:@tcg:bench-notice.js'], 'loses-control');
  assert.strictEqual(by['hooks:dangling:Stop:@tcg:old-meter.js'], 'loses-control');
  assert.strictEqual(by['smoke:default-shell:Stop:@tcg:old-meter.js'], 'loses-control');
  assert.strictEqual(by['session:bash-c:startup-line-failed'], 'loses-control');
  assert.ok(diff.some((d) => /^doctor:fail:/.test(d.id) && d.severity === 'loses-control'), 'un rojo nuevo de doctor');
  // ruido: el hook retirado a propósito, las claves nuevas, la forma del archivo, la versión, el aviso nuevo de doctor,
  // un hook de arranque que ya fallaba, los comandos que se suman
  assert.strictEqual(by['hooks:lost:Stop:@tcg:retired-meter.js'], 'noise', 'un hook que la lista de hoy ya no trae no es un control perdido');
  for (const id of ['settings:keys-added', 'settings:rewritten', 'version:changed', 'hooks:gained', 'commands:added', 'startup:line-changed', 'session:bash-c:hook-failed:@tcg:flaky-notice.js']) assert.strictEqual(by[id], 'noise', id);
  assert.ok(diff.some((d) => /^doctor:new-warn:/.test(d.id) && d.severity === 'noise'));
  // dos sesiones seguidas, lanzadas igual, que dejan settings.json distinto; y las claves de siempre en otro orden
  const twice = [{ label: 'hoy-2', form: 'default-shell', hooks: [], settings_sha256: 'a' }, { label: 'hoy-3', form: 'default-shell', hooks: [], settings_sha256: 'b' }];
  assert.strictEqual(Object.fromEntries(T.comparePhotos(friday, today, { sessions: twice }).map((d) => [d.id, d.severity]))['settings:rewritten-every-session'], 'noise');
  assert.ok(!T.comparePhotos(friday, today, { sessions: [twice[0], Object.assign({}, twice[1], { settings_sha256: 'a' })] }).some((d) => d.id === 'settings:rewritten-every-session'));
  const shuffled = clone(today); shuffled.settings.top_keys = ['hooks', '$schema', 'cleanupPeriodDays', 'env'];
  assert.strictEqual(Object.fromEntries(T.comparePhotos(friday, shuffled).map((d) => [d.id, d.severity]))['settings:keys-reordered'], 'noise');
  assert.strictEqual(T.tellingLine('node:internal/modules/cjs/loader:1210\n  throw err;\nError: Cannot find module x'), 'Error: Cannot find module x');
  // lo que ya fallaba igual el viernes no es una diferencia; y faltar contra la lista de Mac no es de esta semana
  assert.ok(!('smoke:default-shell:SessionStart:@tcg:flaky-notice.js' in by));
  assert.ok(!diff.some((d) => /^hooks:missing:/.test(d.id)));
  // ordenadas por gravedad, un id por diferencia, y cada una con texto
  assert.deepStrictEqual(diff.map((d) => T.SEVERITY_ORDER.indexOf(d.severity)), diff.map((d) => T.SEVERITY_ORDER.indexOf(d.severity)).slice().sort((a, b) => a - b));
  assert.strictEqual(new Set(diff.map((d) => d.id)).size, diff.length);
  for (const d of diff) assert.ok(d.detail && d.detail.length > 15 && T.SEVERITY_TEXT[d.severity], d.id);
  // las respuestas cortas
  const a = T.answers(friday, today, diff, { sessions, target });
  assert.deepStrictEqual([a.healthy, a.updated, a.doctor.same_or_better, a.hooks.before, a.hooks.after, a.hooks.kept], [false, true, false, 4, 4, 2]);
  assert.deepStrictEqual(a.sessions_started.map((s) => [s.form, s.startup_exit]), [['bash-c', 1], ['default-shell', 0]]);
  // una máquina que no llegó a lo de hoy: lo dice, por repo
  const stuck = clone(today); stuck.repos.harness.head = friday.repos.harness.head;
  const notApplied = T.comparePhotos(friday, stuck, { target });
  assert.strictEqual(Object.fromEntries(notApplied.map((d) => [d.id, d.severity]))['update:not-applied:harness'], 'loses-control');
  assert.strictEqual(T.answers(friday, stuck, notApplied, { target }).updated, false);
  // la foto sola (el alta): sin settings.json no hay nada; con la marca de orden de bytes el mecanismo no lo lee
  const none = clone(today); none.settings = { exists: false };
  assert.strictEqual(T.judgePhoto(none).find((f) => f.id === 'settings:missing').severity, 'breaks');
  const bom = clone(friday); bom.settings.bom = true;
  assert.strictEqual(T.judgePhoto(bom).find((f) => f.id === 'settings:bom').severity, 'loses-control');
  const alta = T.judgePhoto(friday);
  assert.ok(alta.some((f) => f.id === 'hooks:missing:PreToolUse:@tcg:bash-brake.sh' && f.severity === 'loses-control'), 'en el alta, lo que falta de la lista sí es un hallazgo');
});

// Pase adversarial de la corrida 8.17-W0-20261005T0153 (clases 5, 15 y 16).
test('Rehearsal_ComparePhotos_JsonBlockBreaks_ManualPullIsNotEverySession_FailureChangeIsReported', () => {
  const friday = fixture('rehearsal-photo-friday.json');
  const today = fixture('rehearsal-photo-today.json');
  const row = (key, event, x) => Object.assign({ key, event, form: 'default-shell', exit: 0, error: null, blocked: false }, x);
  // un freno que hoy bloquea lo legítimo con el JSON de bloqueo y sale 0: FRENA, como si saliera 2
  const before = { rows: [row('PreToolUse:@tcg:json-brake.js[Bash]', 'PreToolUse'), row('SessionStart:@tcg:was-enoent.js', 'SessionStart', { exit: null, error: 'ENOENT' })] };
  const after = { rows: [row('PreToolUse:@tcg:json-brake.js[Bash]', 'PreToolUse', { blocked: true, said: '{"decision":"block"}' }), row('SessionStart:@tcg:was-enoent.js', 'SessionStart', { exit: null, error: 'ETIMEDOUT' })] };
  const by = Object.fromEntries(T.comparePhotos(friday, today, { smokeBefore: before, smokeAfter: after }).map((d) => [d.id, d]));
  assert.strictEqual((by['smoke:default-shell:PreToolUse:@tcg:json-brake.js[Bash]'] || {}).severity, 'breaks', 'frenar con JSON y salir 0 es «rompe»');
  // el viernes no arrancaba y hoy se cuelga: es otra falla, se reporta, y no dice «el viernes salía 0»
  const changed = by['smoke:default-shell:SessionStart:@tcg:was-enoent.js'];
  assert.ok(changed, 'un cambio de falla se reporta');
  assert.doesNotMatch(changed.detail, /el viernes salía 0/);
  assert.match(changed.detail, /el viernes no arrancaba: ENOENT/);
  // la sesión de después de avanzar los clones a mano estrena código: escribir settings.json una vez no es «cada arranque»
  const s = (label, sha) => ({ label, form: 'default-shell', hooks: [], settings_sha256: sha });
  assert.ok(!T.comparePhotos(friday, today, { sessions: [s('hoy-4', 'a'), s('hoy-a-mano', 'b')] }).some((d) => d.id === 'settings:rewritten-every-session'));
  assert.ok(T.comparePhotos(friday, today, { sessions: [s('hoy-3', 'a'), s('hoy-4', 'b'), s('hoy-a-mano', 'c')] }).some((d) => d.id === 'settings:rewritten-every-session'), 'dos sesiones de antes del avance que difieren, sí');
});

// ═══ R4 · el veredicto ═════════════════════════════════════════════════════════════════════════════════════════

test('Rehearsal_Verdict_RedOnlyWhenItCouldNotRehearse', () => {
  const report = fixture('rehearsal-report.json');
  const green = rehearse.verdict(report);
  assert.strictEqual(green.color, 'green', JSON.stringify(green));
  assert.ok(green.by_severity.breaks >= 1 && green.by_severity['loses-control'] >= 1, 'hay hallazgos graves y la corrida es verde: se pudo ensayar');
  for (const empty of [{ steps: [] }, {}, null]) {
    const v = rehearse.verdict(empty);
    assert.strictEqual(v.color, 'red');
    assert.match(v.errors.join(' '), /no trae ningún paso/);
  }
  const short = clone(report); short.steps = short.steps.filter((s) => s.name !== 'update');
  assert.deepStrictEqual([rehearse.verdict(short).color, rehearse.verdict(short).missing_steps], ['red', ['update']]);
  const failed = clone(report); Object.assign(failed.steps.find((s) => s.name === 'update'), { status: 'error', reason: 'no pude medir: ninguna variante pudo correr' });
  assert.strictEqual(rehearse.verdict(failed).color, 'red');
  assert.match(rehearse.verdict(failed).errors.join(' '), /^update: no pude medir/);
  const odd = clone(report); odd.steps[0].status = 'ok';
  assert.match(rehearse.verdict(odd).errors.join(' '), /estado desconocido/);
  const lost = clone(report); delete lost.run.expected_steps;
  assert.strictEqual(rehearse.verdict(lost).color, 'red', 'sin la lista de pasos esperados no hay verde');
  // el resumen legible: el color, la tabla corta, cada variante con sus diferencias por gravedad, y lo no ensayado
  const md = rehearse.renderMarkdown(Object.assign(clone(report), { verdict: green }));
  for (const title of ['## Veredicto: VERDE — se pudo ensayar', '## En corto — del viernes a hoy', '## En corto — el alta de un dev nuevo', '## Los pasos', '## Del viernes a hoy, máquina por máquina', '## El alta, máquina por máquina', '## No ensayado']) assert.ok(md.includes(title), `el resumen trae «${title}»`);
  assert.match(md, /\*\*rompe el trabajo del dev \(\d+\)\*\*/);
  assert.match(md, /\*\*pierde un control \(\d+\)\*\*/);
  assert.match(md, /modo de laboratorio: esto NO es un Windows/);
  assert.match(rehearse.renderMarkdown(Object.assign(clone(failed), { verdict: rehearse.verdict(failed) })), /## Veredicto: ROJO — NO se pudo ensayar/);
});

// ═══ R5 · nunca fuera de un laboratorio ════════════════════════════════════════════════════════════════════════

test('Rehearsal_RefusesToRunOutsideALab_AndWritesNothing', () => {
  const base = tmp('r5');
  try {
    const out = path.join(base, 'out');
    const real = os.homedir();
    for (const [lab, why] of [[real, /carpeta de usuario real/], [path.join(base, 'not-a-lab'), /no tiene la marca del laboratorio/], [path.join(real, '.claude', 'windows-lab'), /dentro de la carpeta \.claude real/]]) {
      for (const step of ['update', 'onboarding']) {
        const r = node([path.join(DIR, 'rehearse.js'), 'step', step, '--lab', lab, '--out', out, '--allow-temp']);
        assert.strictEqual(r.status, 2, `${step} en ${lab}: salió ${r.status}`);
        assert.match(r.stderr, why);
        assert.ok(!fs.existsSync(out), 'no escribió ni la carpeta del reporte');
      }
    }
    for (const script of ['update-probe.js', 'onboarding-probe.js']) {
      const r = node([path.join(DIR, script), '--lab', path.join(base, 'not-a-lab'), '--out', out]);
      assert.strictEqual(r.status, 2, `${script} salió ${r.status}`);
      assert.ok(!fs.existsSync(out), `${script} no escribió`);
    }
    // el laboratorio no se arma sobre la carpeta de usuario real, ni sin los bundles, ni con un escenario que no existe
    assert.match(rehearse.initLab({ lab: real, out, sources: base, scenario: 'all' }).reason, /carpeta de usuario real/);
    assert.match(rehearse.initLab({ lab: path.join(base, 'lab'), out, sources: base, scenario: 'all', allowTemp: true }).reason, /no encuentro los bundles/);
    assert.match(rehearse.initLab({ lab: path.join(base, 'lab'), out, sources: base, scenario: 'everything', allowTemp: true }).reason, /escenario desconocido/);
    // story 8.40 (AC 34): el escenario npx existe en la lista cerrada, con su paso y su tope (sin eso: «escenario desconocido»)
    assert.deepStrictEqual(rehearse.SCENARIOS.npx, ['inventory', 'npx']);
    assert.ok(rehearse.STEP_ORDER.includes('npx') && !rehearse.SCENARIOS.all.includes('npx'), 'npx va aparte: all no lo corre');
    assert.ok(rehearse.OWN_STEPS.npx && fs.existsSync(rehearse.OWN_STEPS.npx.script) && rehearse.OWN_STEPS.npx.cap > 0 && rehearse.OWN_STEPS.npx.cap <= 2400, 'la sonda npx-probe.js con su tope');
    assert.ok(!fs.existsSync(out));
    // con la marca y sin los remotos: el paso lo dice como error, no inventa una medición
    const lab = path.join(base, 'lab');
    fs.mkdirSync(lab); fs.writeFileSync(path.join(lab, L.LAB_MARK), '{}\n');
    const rec = L.recorder('update', path.join(base, 'o2'));
    assert.match(update.measure({ lab, out: path.join(base, 'o2'), allowTemp: true, rec }).reason, /no trae los remotos del laboratorio/);
    assert.match(onboarding.measure({ lab, out: path.join(base, 'o2'), allowTemp: true, rec: L.recorder('onboarding', path.join(base, 'o2')) }).reason, /no trae los remotos del laboratorio/);
    // todo ensayo corre con el examen nocturno apagado y sin instalar paquetes ni llamar a Azure
    const env = T.rehearsalEnv(path.join(lab, 'users', 'x'), { base: { PATH: '/bin', TYCON_NO_NIGHTLY_EXAM: '0' } });
    assert.deepStrictEqual([env.TYCON_NO_NIGHTLY_EXAM, env.TYCON_SQLITE_AUTO_INSTALL, env.TYCON_NO_ENGRAM_VERSION_CHECK, env.TYCON_NO_AZ_PROJECTS_REFRESH, env.GIT_TERMINAL_PROMPT, env.HOME], ['1', '0', '1', '1', '0', path.join(lab, 'users', 'x')]);
    // sacar pwsh del PATH: se va su carpeta y nada más; si se llevara a git o a node, lo dice y no ensaya
    const bin = path.join(base, 'bin-ps'); const tools = path.join(base, 'bin-tools'); const mixed = path.join(base, 'bin-mixed');
    for (const d of [bin, tools, mixed]) fs.mkdirSync(d);
    for (const f of [path.join(bin, 'pwsh'), path.join(tools, 'git'), path.join(tools, 'node'), path.join(mixed, 'pwsh'), path.join(mixed, 'git'), path.join(mixed, 'node')]) fs.writeFileSync(f, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const gone = T.withoutPwsh({ PATH: [bin, tools].join(path.delimiter) }, process.platform);
    assert.deepStrictEqual([gone.env.PATH, gone.removed], [tools, [bin]]);
    assert.match(T.withoutPwsh({ PATH: mixed }, process.platform).problem, /se lleva también a git y node/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ los dos repos de juguete, con su viernes y su hoy ═════════════════════════════════════════════════════════

const TOY_HARNESS_URL = 'https://example.com/acme/toy-harness';
const TOY_SKILLS_URL = 'https://example.com/acme/toy-skills';
const TOY_TAG = 'retorno/toy-friday';
// sin `$`: estas líneas tienen que andar lanzadas por `sh -c`, por `bash -c` y por `cmd.exe`
const TOY_DOC_LINE = 'pwsh -NoProfile -ExecutionPolicy Bypass -Command \\"try { & (Join-Path ([Environment]::GetFolderPath(\'UserProfile\')) \'SourceCode/tycon-claude-guides/scripts/install-tycon-hooks.ps1\') } catch {}\\"';
const TOY_KNOWN_LINE = 'pwsh -NoProfile -ExecutionPolicy Bypass -Command "try { Set-Location ([Environment]::GetFolderPath(\'UserProfile\')); & (Join-Path ([Environment]::GetFolderPath(\'UserProfile\')) \'.claude/tycon-claude-guides/scripts/install-tycon-hooks.ps1\') } catch {}"';
const TOY_DOC = `# El alta de juguete

═══ INICIO DEL PROMPT ═══

## PASO 1 — Clonar los dos repos

- Windows:
  \`\`\`powershell
  New-Item -ItemType Directory -Path "$env:USERPROFILE/SourceCode" -Force | Out-Null
  Set-Location "$env:USERPROFILE/SourceCode"
  if (-not (Test-Path tycon-claude-guides/.git)) { git clone ${TOY_HARNESS_URL} tycon-claude-guides }
  \`\`\`
- Windows:
  \`\`\`powershell
  New-Item -ItemType Directory -Path "$env:USERPROFILE/.claude" -Force | Out-Null
  Set-Location "$env:USERPROFILE/.claude"
  if (-not (Test-Path agent-skills/.git)) { git clone ${TOY_SKILLS_URL} agent-skills }
  \`\`\`

## PASO 2 — Los enlaces

\`\`\`powershell
foreach ($name in 'agents','skills') {
  $link = "$env:USERPROFILE/.claude/$name"
  if (-not (Test-Path $link)) { New-Item -ItemType SymbolicLink -Path $link -Target "$env:USERPROFILE/.claude/agent-skills/$name" | Out-Null }
}
\`\`\`

## PASO 3 — El import

\`\`\`powershell
$claudeMd = "$env:USERPROFILE/.claude/CLAUDE.md"
$importLine = "@$env:USERPROFILE/SourceCode/tycon-claude-guides/README.md"
if (-not (Test-Path $claudeMd)) { [System.IO.File]::WriteAllText($claudeMd, $importLine + "\`n", (New-Object System.Text.UTF8Encoding($false))) }
\`\`\`

## PASO 4 — La línea de arranque

\`\`\`json
"SessionStart": [
  { "hooks": [ { "type": "command", "command": "${TOY_DOC_LINE}", "async": true } ] }
]
\`\`\`

- Windows: \`<PS> -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE/SourceCode/tycon-claude-guides/scripts/install-tycon-hooks.ps1"\`
- Windows: \`<PS> -NoProfile -Command "Get-Content $env:USERPROFILE/.claude/settings.json -Raw | ConvertFrom-Json | Out-Null; 'JSON OK'"\`

## PASO 9 — Verificación

\`\`\`powershell
Test-Path "$env:USERPROFILE/SourceCode/tycon-claude-guides/.git/HEAD","$env:USERPROFILE/.claude/agent-skills/.git/HEAD"
engram --version
\`\`\`

═══ FIN DEL PROMPT ═══
`;
// el mismo alta, con la forma de UN SOLO CLON (la de la rama que une los dos repos): el repo trae `skills/` y `agents/`
// en su raíz, un comando lo instala todo, y los pasos 3, 4 y 9 sólo miran
const TOY_ONE_CLONE_DOC = `# El alta de juguete, de un solo clon

═══ INICIO DEL PROMPT ═══

## PASO 1 — Clonar el repo del equipo (uno solo)

- Windows:
  \`\`\`powershell
  New-Item -ItemType Directory -Path "$env:USERPROFILE/SourceCode" -Force | Out-Null
  Set-Location "$env:USERPROFILE/SourceCode"
  if (-not (Test-Path tycon-claude-guides/.git)) { git clone ${TOY_HARNESS_URL} }
  \`\`\`

## PASO 2 — Correr el instalador

- Windows:
  \`\`\`powershell
  node "$env:USERPROFILE/SourceCode/tycon-claude-guides/scripts/setup/harness.js" install
  \`\`\`

## PASO 3 — Verificar los enlaces y el import

\`\`\`powershell
Get-Item "$env:USERPROFILE/.claude/tycon-claude-guides","$env:USERPROFILE/.claude/agent-skills","$env:USERPROFILE/.claude/skills","$env:USERPROFILE/.claude/agents" | Format-List Name,Attributes,Target
(Select-String -Path "$env:USERPROFILE/.claude/CLAUDE.md" -Pattern 'tycon-claude-guides/README.md').Count
\`\`\`

## PASO 4 — El diagnóstico

- Windows: \`node "$env:USERPROFILE/.claude/tycon-claude-guides/scripts/setup/harness.js" doctor\`
- Windows: \`pwsh -NoProfile -Command "Get-Content $env:USERPROFILE/.claude/settings.json -Raw | ConvertFrom-Json | Out-Null; 'JSON OK'"\`

## PASO 9 — Verificación

\`\`\`powershell
Test-Path "$env:USERPROFILE/SourceCode/tycon-claude-guides/.git/HEAD"
engram --version
node "$env:USERPROFILE/.claude/tycon-claude-guides/scripts/setup/harness.js" doctor
\`\`\`

═══ FIN DEL PROMPT ═══
`;
const toyInstallerList = (hooks) => `#!/usr/bin/env bash
_hook_de_integracion() {
  case "$1" in
    *"|@tcg:toy-integration.js|"*) _INTEG_DE=NOCTURNOS ;;
    *) return 1 ;;
  esac
}
HOOKS_CANONICAL=(
${hooks.map((h) => `  "${h}|de juguete"`).join('\n')}
)
OPTIN_HOOKS=()
KNOWN_MATCHER_TOKENS = {"Edit", "Write", "Bash"}
SUPERSEDED_RELPATHS = {
    "tycon-pipeline/scripts/on-edit.js",
}
`;
// el aplicador de juguete: registra SU lista, quita lo que dice quitar y, la primera vez, crea el estado del mecanismo
const toyApplier = ({ hooks, remove, today }) => `const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawnSync } = require('child_process');
const tree = path.resolve(__dirname, '..'); const home = os.homedir(); const dot = path.join(home, '.claude'); const q = (p) => p.replace(/\\\\/g, '/');
const HOOKS = ${JSON.stringify(hooks)}; const REMOVE = ${JSON.stringify(remove)};
const link = path.join(dot, 'tycon-claude-guides'); try { fs.lstatSync(link); } catch (e) { fs.symlinkSync(tree, link, 'junction'); }
const file = path.join(dot, 'settings.json'); let s = {}; try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { s = {}; }
s.hooks = s.hooks || {};
const cmdOf = (spec) => (spec.startsWith('tcg:') ? 'node "' + q(tree) + '/scripts/hooks/' + spec.slice(4) + '"' : 'node "' + q(home) + '/.claude/agent-skills/skills/' + spec + '"');
for (const [ev, m, spec] of HOOKS) {
  const c = cmdOf(spec); s.hooks[ev] = s.hooks[ev] || [];
  let g = s.hooks[ev].find((x) => (x.matcher || '') === m);
  if (!g) { g = { hooks: [] }; if (m) g.matcher = m; s.hooks[ev].push(g); }
  if (!g.hooks.some((h) => h.command === c)) g.hooks.push({ type: 'command', command: c });
}
for (const name of REMOVE) for (const ev of Object.keys(s.hooks)) for (const g of s.hooks[ev]) g.hooks = g.hooks.filter((h) => !h.command.endsWith('/' + name + '"'));
${today ? "s.cleanupPeriodDays = 365; s.env = Object.assign({}, s.env, { TOY_FLAG: '1' }); fs.mkdirSync(path.join(dot, 'commands'), { recursive: true }); fs.copyFileSync(path.join(tree, 'commands', 'toy.md'), path.join(dot, 'commands', 'toy.md'));" : ''}
fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\\n');
if (!fs.existsSync(path.join(dot, '.tycon-pipeline', 'harness-state.json')) && process.env.TYCON_HARNESS_LOCK_HELD !== '1') spawnSync(process.execPath, [path.join(tree, 'scripts', 'setup', 'harness.js'), 'install', '--from-existing'], { stdio: 'inherit' });
console.log('aplicador de juguete: ' + HOOKS.length + ' hooks');
`;
// lo que el instalador de UN SOLO CLON hace antes de lo de siempre: los cuatro enlaces (las skills viven en el mismo
// clon), el import, la línea de arranque y los hooks (el aplicador). Nada de eso se hace a mano.
const TOY_UNIFIED_INSTALL = `if (!process.argv.includes('--from-existing')) {
    fs.mkdirSync(dot, { recursive: true });
    for (const [name, to] of [['tycon-claude-guides', tree], ['agent-skills', tree], ['skills', path.join(tree, 'skills')], ['agents', path.join(tree, 'agents')]]) { try { fs.lstatSync(path.join(dot, name)); } catch (e) { fs.symlinkSync(to, path.join(dot, name), 'junction'); } }
    const md = path.join(dot, 'CLAUDE.md'); if (!fs.existsSync(md)) fs.writeFileSync(md, '@' + tree.split(path.sep).join('/') + '/README.md\\n');
    const sf = path.join(dot, 'settings.json'); let st = {}; try { st = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch (e) { st = {}; }
    st.hooks = st.hooks || {}; st.hooks.SessionStart = st.hooks.SessionStart || [];
    if (!JSON.stringify(st.hooks.SessionStart).includes('harness/bootstrap.js')) st.hooks.SessionStart.push({ hooks: [{ type: 'command', command: NEW_LINE, async: true }] });
    fs.writeFileSync(sf, JSON.stringify(st, null, 2) + '\\n');
    const a = spawnSync(process.execPath, [path.join(tree, 'scripts', 'toy-apply.js')], { stdio: 'inherit', env: Object.assign({}, process.env, { TYCON_HARNESS_LOCK_HELD: '1' }) });
    if (a.status !== 0) process.exit(a.status === null ? 1 : a.status);
  }
`;
// el mecanismo de juguete: estado, copia fija de arranque, migración de la línea (sólo las que empiezan con pwsh, como
// el de verdad), y un arranque que trae lo nuevo de los dos repos y corre el aplicador con pwsh. Con `unified`, su
// `install` es además el instalador de un solo clon.
const toyHarness = ({ version, warn, unified = false }) => `#!/usr/bin/env node
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawnSync } = require('child_process');
const tree = path.resolve(__dirname, '..', '..'); const home = os.homedir(); const dot = path.join(home, '.claude');
const pipe = path.join(dot, '.tycon-pipeline'); const fixed = path.join(pipe, 'harness'); const stateFile = path.join(pipe, 'harness-state.json');
const NEW_LINE = 'node "$HOME/.claude/.tycon-pipeline/harness/bootstrap.js" || bash "$HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh"';
const log = (l) => { fs.mkdirSync(fixed, { recursive: true }); fs.appendFileSync(path.join(fixed, 'startup.log'), new Date().toISOString() + ' ' + l + '\\n'); };
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return null; } };
const inPath = (name) => String(process.env.PATH || '').split(path.delimiter).some((d) => { try { return fs.statSync(path.join(d, name)).isFile(); } catch (e) { return false; } });
const head = (dir) => String(spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim();
const cmd = process.argv[2];
if (cmd === 'install') {
  ${unified ? TOY_UNIFIED_INSTALL : ''}fs.mkdirSync(fixed, { recursive: true });
  for (const f of ['bootstrap.js', 'bootstrap-fallback.sh']) fs.copyFileSync(path.join(__dirname, 'harness', f), path.join(fixed, f));
  const file = path.join(dot, 'settings.json'); const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const g of (s.hooks && s.hooks.SessionStart) || []) for (const h of g.hooks || []) if (/^\\s*pwsh\\b.*install-tycon-hooks/.test(h.command || '')) { h.command = NEW_LINE; h.async = true; }
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\\n');
  fs.writeFileSync(stateFile, JSON.stringify({ mode: 'managed', channel: 'latest', tree, version: { number: '${version}' }, last_fetch: new Date().toISOString(), sources: [{ name: 'harness', ref: 'main', commit: head(tree) }] }, null, 2) + '\\n');
  console.log('mecanismo de juguete instalado');
} else if (cmd === 'version') { console.log('toy ${version} · ' + (readState() ? 'managed' : 'no instalado')); }
else if (cmd === 'doctor') {
  const st = readState(); const fail = [];
  try { fs.realpathSync(path.join(dot, 'tycon-claude-guides')); } catch (e) { fail.push('el enlace no resuelve'); }
  console.log(JSON.stringify({ mode: st ? 'managed' : 'no instalado', fail, warn: ${JSON.stringify(warn)}, ok: ['Node'] }));
  process.exit(st ? (fail.length ? 1 : 0) : 3);
} else if (cmd === 'startup') {
  const st = readState() || {};
  if (process.env.TYCON_UPDATE === '0') log('startup: TYCON_UPDATE=0: sin actualización');
  else if (Date.now() - (Date.parse(st.last_fetch || '') || 0) < 10 * 60 * 1000) log('startup: última salida a la red hace menos de 10 min: sin fetch');
  else {
    for (const dir of [tree, path.join(dot, 'agent-skills')]) {
      const f = spawnSync('git', ['-C', dir, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { encoding: 'utf8' });
      const m = f.status === 0 ? spawnSync('git', ['-C', dir, 'merge', '-q', '--ff-only', 'refs/remotes/origin/main'], { encoding: 'utf8' }) : f;
      log('startup: update ' + path.basename(dir) + ' → ' + (m.status === 0 ? head(dir).slice(0, 7) : 'falló: ' + String(m.stderr).trim().split('\\n')[0]));
    }
    st.last_fetch = new Date().toISOString();
  }
  delete st.notice;
  if (!inPath('pwsh') && !inPath('pwsh.exe')) { st.notice = 'el aplicador falló: falta pwsh en el PATH — instalá PowerShell 7'; log('startup: ' + st.notice); console.log(st.notice); }
  else {
    const a = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tree, 'scripts', 'install-tycon-hooks.ps1')], { encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_HARNESS_LOCK_HELD: '1' }) });
    log('startup: aplicador → ' + (a.status === 0 ? 'ok' : 'rc ' + a.status));
  }
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2) + '\\n');
} else process.exit(2);
`;
const TOY_BOOTSTRAP = `const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawnSync } = require('child_process');
const dir = path.join(os.homedir(), '.claude', '.tycon-pipeline', 'harness');
let tree; try { tree = fs.realpathSync(path.join(os.homedir(), '.claude', 'tycon-claude-guides')); } catch (e) { fs.appendFileSync(path.join(dir, 'startup.log'), 'x bootstrap: el enlace no resuelve\\n'); process.exit(1); }
const r = spawnSync(process.execPath, [path.join(tree, 'scripts', 'setup', 'harness.js'), 'startup'], { stdio: 'inherit' }); process.exit(r.status === null ? 1 : r.status);
`;
const QUIET_HOOK = 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n';
const brake = (all) => `let d = ""; process.stdin.on("data", (c) => { d += c; }).on("end", () => { let j = {}; try { j = JSON.parse(d); } catch (e) { process.exit(3); } if (${all ? 'true' : '/rm -rf \\//.test((j.tool_input || {}).command || "")'}) { console.error("toy-brake: frenado"); process.exit(2); } });\n`;

const FRIDAY_LIST = ['UserPromptSubmit||tycon-pipeline/scripts/on-prompt.js', 'PreToolUse|Bash|@tcg:toy-brake.js', 'SessionStart||@tcg:toy-notice.js', 'Stop||@tcg:toy-old.js', 'Stop||@tcg:toy-retired.js', 'PostToolUse|Edit|Write|@tcg:toy-never.js'];
const TODAY_LIST = ['UserPromptSubmit||tycon-pipeline/scripts/on-prompt.js', 'PreToolUse|Bash|@tcg:toy-brake.js', 'SessionStart||@tcg:toy-notice.js', 'Stop||@tcg:toy-renamed.js', 'PostToolUse|Edit|Write|@tcg:toy-never.js'];
const TOY_COMMON = {
  'README.md': '# Arnés de juguete\n',
  'onboarding/step-0-windows.md': `1. Cloná el repo: \`git clone ${TOY_HARNESS_URL} "$env:USERPROFILE/SourceCode/tycon-claude-guides"\`\n`,
  'onboarding/new-dev-harness-setup.md': TOY_DOC,
  'scripts/install-tycon-hooks.ps1': "param([Alias('report-json')][string]$ReportJson)\nif (-not (Get-Command node -ErrorAction SilentlyContinue)) { exit 1 }\n& node (Join-Path $PSScriptRoot 'toy-apply.js')\nexit $LASTEXITCODE\n",
  'scripts/lib/tycon-config.js': 'if (process.argv[2] === "integrations") console.log(JSON.stringify({ ado: false, clockify: false, engram: false, codegraph: false, mailbox: false, codex: false, nightly: false, telegram: false })); else process.exit(2);\n',
  'scripts/setup/harness/bootstrap.js': TOY_BOOTSTRAP,
  'scripts/setup/harness/bootstrap-fallback.sh': '#!/bin/sh\necho "x respaldo en shell: bootstrap.js no arrancó harness.js" >> "$HOME/.claude/.tycon-pipeline/harness/startup.log"\nexit 0\n',
  'scripts/tests/fixtures/startup-lines.json': `${JSON.stringify({ forms: [{ id: 'canonical-posix', platform: 'posix', expect: 'known', async: true, command: 'true' }, { id: 'canonical-windows', platform: 'windows', expect: 'known', async: true, command: TOY_KNOWN_LINE }, { id: 'unknown-windows-dev-extra', platform: 'windows', expect: 'unknown', async: true, command: 'pwsh -Command "x"' }] }, null, 2)}\n`,
  'scripts/hooks/toy-notice.js': QUIET_HOOK,
};
// el viernes: cinco hooks registrados (uno de ellos, `toy-retired`, se retira esta semana)
const TOY_FRIDAY = Object.assign({}, TOY_COMMON, {
  'scripts/install-tycon-hooks.sh': toyInstallerList(FRIDAY_LIST),
  'scripts/toy-apply.js': toyApplier({ hooks: [['UserPromptSubmit', '', 'tycon-pipeline/scripts/on-prompt.js'], ['PreToolUse', 'Bash', 'tcg:toy-brake.js'], ['SessionStart', '', 'tcg:toy-notice.js'], ['Stop', '', 'tcg:toy-old.js'], ['Stop', '', 'tcg:toy-retired.js']], remove: [], today: false }),
  'scripts/setup/harness.js': toyHarness({ version: '1', warn: ['de juguete'] }),
  'scripts/hooks/toy-brake.js': brake(false),
  'scripts/hooks/toy-old.js': QUIET_HOOK,
  'scripts/hooks/toy-retired.js': QUIET_HOOK,
});
// hoy, con cuatro defectos puestos a propósito: `toy-old` cambió de nombre y su registro viejo queda apuntando a un
// archivo que ya no existe; el aplicador QUITA `toy-notice`, que su lista sigue esperando; el freno ahora frena todo;
// y doctor suma un aviso. Además retira `toy-retired` (a propósito) y suma claves, un comando y un hook.
const TOY_TODAY = Object.assign({}, TOY_COMMON, {
  'scripts/install-tycon-hooks.sh': toyInstallerList(TODAY_LIST),
  'scripts/toy-apply.js': toyApplier({ hooks: [['UserPromptSubmit', '', 'tycon-pipeline/scripts/on-prompt.js'], ['PreToolUse', 'Bash', 'tcg:toy-brake.js'], ['Stop', '', 'tcg:toy-renamed.js']], remove: ['toy-notice.js', 'toy-retired.js'], today: true }),
  'scripts/setup/harness.js': toyHarness({ version: '2', warn: ['de juguete', 'un aviso que el viernes no estaba'] }),
  'scripts/hooks/toy-brake.js': brake(true),
  'scripts/hooks/toy-renamed.js': QUIET_HOOK,
  'commands/toy.md': '# un comando de juguete\n',
});

// el arnés de juguete de UN SOLO CLON: el mismo viernes y el mismo hoy, con las skills y los revisores en su raíz, el
// texto del alta de un clon, y un `harness.js install` que lo deja todo
const toyUnified = (files, mechanism) => Object.assign({}, files, {
  'onboarding/new-dev-harness-setup.md': TOY_ONE_CLONE_DOC,
  'scripts/setup/harness.js': toyHarness(Object.assign({ unified: true }, mechanism)),
  'skills/tycon-pipeline/scripts/on-prompt.js': QUIET_HOOK,
  'agents/toy-reviewer.md': '# revisor de juguete\n',
});
const TOY_UNIFIED_FRIDAY = toyUnified(TOY_FRIDAY, { version: '1', warn: ['de juguete'] });
const TOY_UNIFIED_TODAY = toyUnified(TOY_TODAY, { version: '2', warn: ['de juguete', 'un aviso que el viernes no estaba'] });

/** Arma los dos repos de juguete, cada uno con su commit del viernes (etiquetado) y el de hoy en `main`. */
function toyRepos(base, { friday: harnessFriday = TOY_FRIDAY, today: harnessToday = TOY_TODAY } = {}) {
  const harness = path.join(base, 'toy-harness'); const skills = path.join(base, 'toy-skills');
  for (const [dir, friday, today] of [[harness, harnessFriday, harnessToday], [skills, { 'skills/tycon-pipeline/scripts/on-prompt.js': QUIET_HOOK, 'agents/toy-reviewer.md': '# revisor de juguete\n' }, { 'skills/tycon-pipeline/scripts/on-prompt.js': QUIET_HOOK, 'agents/toy-reviewer.md': '# revisor de juguete\n', 'skills/tycon-pipeline/SKILL.md': '# de hoy\n' }]]) {
    fs.mkdirSync(dir, { recursive: true });
    git(['init', '-q'], dir);
    write(dir, friday);
    git(['add', '-A'], dir);
    assert.strictEqual(git(['commit', '-q', '-m', 'el viernes'], dir).status, 0, 'no pude armar el commit del viernes');
    git(['checkout', '-q', '-B', 'main'], dir);
    git(['tag', TOY_TAG], dir);
    for (const f of listing(dir).filter((f) => !f.startsWith('.git') && fs.statSync(path.join(dir, f)).isFile())) fs.rmSync(path.join(dir, f));
    write(dir, today);
    git(['add', '-A'], dir);
    assert.strictEqual(git(['commit', '-q', '-m', 'hoy'], dir).status, 0, 'no pude armar el commit de hoy');
  }
  return { harness, skills };
}

// ═══ R6 · los bundles de los dos repos ═════════════════════════════════════════════════════════════════════════

test('Rehearsal_BuildSources_MainIsTodayFridayIsTheTag_NoTagNoBundle', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('r6');
  try {
    const toy = toyRepos(base);
    const out = path.join(base, 'sources');
    const r = node([path.join(DIR, 'build-sources.js'), '--output', out, '--harness', toy.harness, '--skills', toy.skills, '--friday-tag', TOY_TAG]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(fs.readdirSync(out).sort(), ['agent-skills.bundle', 'harness.bundle', 'sources-info.json'], 'en la carpeta no queda nada más');
    const info = JSON.parse(fs.readFileSync(path.join(out, 'sources-info.json'), 'utf8'));
    const rev = (dir, ref) => git(['rev-parse', ref], dir).stdout.trim();
    assert.deepStrictEqual([info.harness.target, info.harness.friday, info.skills.target, info.skills.friday], [rev(toy.harness, 'main'), rev(toy.harness, TOY_TAG), rev(toy.skills, 'main'), rev(toy.skills, TOY_TAG)]);
    assert.deepStrictEqual([info.harness.commits_between, info.harness.friday_is_ancestor, info.friday_tag], [1, true, TOY_TAG]);
    // lo que se borró o cambió de nombre entre el viernes y hoy queda dicho: de ahí salen los hooks que apuntan a la nada
    const moved = info.harness.removed_or_renamed.first.map((m) => m.from).sort();
    assert.deepStrictEqual(moved, ['scripts/hooks/toy-old.js', 'scripts/hooks/toy-retired.js']);
    assert.strictEqual(git(['status', '--porcelain'], toy.harness).stdout, '', 'build-sources.js no toca el repo que empaqueta');
    // el bundle trae las dos ramas, y se clona
    const lab = path.join(base, 'lab');
    fs.mkdirSync(lab); fs.writeFileSync(path.join(lab, L.LAB_MARK), '{}\n');
    const made = T.makeRemotes({ lab, sources: out, env: process.env });
    assert.ok(made.ok, made.reason);
    assert.deepStrictEqual([made.state.remotes.harness.friday, made.state.remotes.harness.target], [info.harness.friday, info.harness.target]);
    assert.match(T.showFile(made.state.remotes.harness.dir, info.harness.friday, 'scripts/setup/harness.js'), /version: \{ number: '1' \}/, 'el archivo del viernes se lee del remoto sin clonar');
    assert.strictEqual(T.showFile(made.state.remotes.harness.dir, info.harness.friday, 'commands/toy.md'), null);
    // el remoto se apunta al viernes y a hoy
    assert.strictEqual(T.pointRemotes(made.state, 'friday', process.env), null);
    assert.strictEqual(rev(made.state.remotes.harness.dir, 'refs/heads/main'), info.harness.friday);
    assert.strictEqual(T.pointRemotes(made.state, 'target', process.env), null);
    assert.strictEqual(rev(made.state.remotes.harness.dir, 'refs/heads/main'), info.harness.target);
    // una rama pedida por su nombre, y un commit que no desciende del viernes: se dice
    git(['checkout', '-q', '--orphan', 'side'], toy.harness); git(['commit', '-q', '--allow-empty', '-m', 'suelto'], toy.harness); git(['checkout', '-q', 'main'], toy.harness);
    const side = sources.build({ output: path.join(base, 's2'), harness: toy.harness, skills: toy.skills, harnessRef: 'side', fridayTag: TOY_TAG });
    assert.ok(side.ok, side.reason);
    assert.deepStrictEqual([side.info.harness.target, side.info.harness.friday_is_ancestor], [rev(toy.harness, 'side'), false]);
    // sin la marca del viernes no hay bundle: sale 1 y dice cuál falta
    const none = node([path.join(DIR, 'build-sources.js'), '--output', path.join(base, 's3'), '--harness', toy.harness, '--skills', toy.skills, '--friday-tag', 'retorno/no-such-tag']);
    assert.strictEqual(none.status, 1);
    assert.match(none.stderr, /no encuentro la marca «retorno\/no-such-tag»/);
    assert.ok(!fs.existsSync(path.join(base, 's3', 'sources-info.json')));
    assert.strictEqual(node([path.join(DIR, 'build-sources.js'), '--output', path.join(base, 's4'), '--harness', toy.harness, '--skills', toy.skills, '--harness-ref', 'no-such-branch', '--friday-tag', TOY_TAG]).status, 1);
    assert.strictEqual(node([path.join(DIR, 'build-sources.js'), '--output', path.join(base, 's5')]).status, 2, 'sin los dos clones: uso');
    // el repo unido (story 8.18): ~/.claude/agent-skills es un enlace al arnés; como --skills, no son dos repos y frena
    fs.symlinkSync(toy.harness, path.join(base, 'skills-link'));
    const same = node([path.join(DIR, 'build-sources.js'), '--output', path.join(base, 's6'), '--harness', toy.harness, '--skills', path.join(base, 'skills-link'), '--friday-tag', TOY_TAG]);
    assert.strictEqual(same.status, 1, same.stderr);
    assert.match(same.stdout + same.stderr, /es el mismo repo que --harness/, 'dice por qué');
    // y una carpeta que no es un repo no pasa como «son distintos»: frena con su motivo
    const notRepo = node([path.join(DIR, 'build-sources.js'), '--output', path.join(base, 's7'), '--harness', toy.harness, '--skills', base, '--friday-tag', TOY_TAG]);
    assert.strictEqual(notRepo.status, 1, notRepo.stderr);
    assert.match(notRepo.stdout + notRepo.stderr, /no pude leer la carpeta de git de --skills/, 'dice cuál no pudo leer');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ R8 · los finales de línea se cuentan archivo por archivo ══════════════════════════════════════════════════

test('Rehearsal_LineEndings_CountsEveryFile_AndSeesTheOnesWithCr', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  // La primera medición (corrida 11677) dijo «0 de 1 .sh con \\r» sobre una copia con decenas de .sh: la lista de
  // archivos venía separada por ceros, que el recorte de la salida borra, y quedaba un solo «archivo» que no existía.
  const base = tmp('r8');
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo); git(['init', '-q'], repo); git(['config', 'core.autocrlf', 'false'], repo);
    write(repo, { 'a.sh': '#!/bin/sh\necho a\n', 'dir/b con espacio.sh': '#!/bin/sh\r\nif true; then\r\n  echo b\r\nfi\r\n', 'c.ps1': 'Write-Host c\r\n', 'd.ps1': 'Write-Host d\n', 'e.txt': 'x\r\n' });
    git(['add', '-A'], repo); assert.strictEqual(git(['commit', '-q', '-m', 'x'], repo).status, 0);
    const bash = L.scanPath('bash')[0] || null;
    const eol = T.eolFacts(repo, { env: process.env, bash });
    assert.deepStrictEqual([eol.sh.total, eol.sh.with_cr, eol.sh.first, eol.ps1.total, eol.ps1.with_cr, eol.gitattributes], [2, 1, ['dir/b con espacio.sh'], 2, 1, false], JSON.stringify(eol));
    if (bash) assert.ok(eol.bash_reads_first.file === 'dir/b con espacio.sh' && eol.bash_reads_first.exit !== 0, `bash no lee un .sh con \\r: ${JSON.stringify(eol.bash_reads_first)}`);
    // el contador del escenario measure, el mismo arreglo
    const probe = require(path.join(DIR, 'install-probe.js'));
    const counted = probe.shellFilesWithCr(repo, process.env);
    assert.deepStrictEqual([counted.total, counted.with_cr, counted.first], [2, 1, ['dir/b con espacio.sh']], JSON.stringify(counted));
    assert.match(T.eolFacts(path.join(base, 'no-such-repo'), { env: process.env }).problem, /git ls-files/, 'un clon que no está es «no pude medir», no «cero archivos»');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ R7 · la copia se arma con el exportador del commit que se mide ════════════════════════════════════════════

test('Bundle_ExportUsesTheMeasuredCommitsOwnExporterAndLists', { skip: (process.platform === 'win32' && 'el bundle se arma en Linux') || (!has('git') && 'NO MEDIDO — sin git') || (!has('bash') && 'NO MEDIDO — sin bash') }, () => {
  const base = tmp('r7');
  try {
    // Un arnés de mentira con dos commits. El exportador de cada uno hace lo que hace el de verdad con su lista: la
    // lee de SU carpeta y frena si declara una suite que el suites.json del commit exportado no trae.
    const exporter = (who) => `const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const a = process.argv.slice(2); const opt = (n) => a[a.indexOf(n) + 1];
const repo = process.env.TYCON_GUIDES_DIR; const sha = opt('--harness'); const out = opt('--output');
const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'allowlist.json'), 'utf8'));
const suites = JSON.parse(execFileSync('git', ['-C', repo, 'show', sha + ':scripts/tests/suites.json'], { encoding: 'utf8' }));
for (const s of list.suitesOutside) if (!suites.diarias.some((e) => e.ruta === s.path)) { console.error('suitesOutside: arnes:' + s.path + ' no está en scripts/tests/suites.json'); console.log('{}'); process.exit(2); }
fs.mkdirSync(path.join(out, '.github'), { recursive: true });
fs.writeFileSync(path.join(out, '.github', 'README.md'), '# copia de juguete\\n');
fs.writeFileSync(path.join(out, 'exported-by.txt'), '${who}\\n');
const g = (args) => execFileSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', '-C', out, ...args]);
g(['init', '-q']); g(['add', '-A']); g(['commit', '-q', '-m', 'copia']);
console.log('{}');
`;
    const repo = path.join(base, 'fake-harness');
    fs.mkdirSync(repo); git(['init', '-q'], repo);
    // el commit viejo: no trae los archivos de la W0 (ni la suite en suites.json, ni su entrada en la lista)
    write(repo, { 'scripts/publishing/export.js': exporter('old'), 'scripts/publishing/allowlist.json': JSON.stringify({ suitesOutside: [] }), 'scripts/tests/suites.json': JSON.stringify({ diarias: [] }) });
    git(['add', '-A'], repo); assert.strictEqual(git(['commit', '-q', '-m', 'sin la W0'], repo).status, 0);
    const old = git(['rev-parse', 'HEAD'], repo).stdout.trim();
    // la rama del pipeline: suma la suite de la W0 a los dos archivos
    write(repo, { 'scripts/publishing/export.js': exporter('new'), 'scripts/publishing/allowlist.json': JSON.stringify({ suitesOutside: [{ root: 'arnes', path: 'tests/windows-probe.test.js', reason: 'x' }] }), 'scripts/tests/suites.json': JSON.stringify({ diarias: [{ ruta: 'tests/windows-probe.test.js' }] }) });
    git(['add', '-A'], repo); assert.strictEqual(git(['commit', '-q', '-m', 'con la W0'], repo).status, 0);
    const skills = path.join(base, 'fake-skills');
    fs.mkdirSync(skills); git(['init', '-q'], skills); write(skills, { 'README.md': 'x\n' }); git(['add', '-A'], skills); git(['commit', '-q', '-m', 'x'], skills);
    const build = (ref, name) => spawnSync('bash', [path.join(DIR, 'build-bundle.sh'), '--output', path.join(base, name), '--repo', repo, '--harness-ref', ref, '--skills-ref', 'HEAD'], { encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_SKILLS_DIR: skills }) });
    const exportedBy = (name) => {
      const dest = path.join(base, `${name}-clone`);
      assert.strictEqual(spawnSync('git', ['clone', '--quiet', path.join(base, name, 'harness.bundle'), dest], { encoding: 'utf8' }).status, 0);
      return fs.readFileSync(path.join(dest, 'exported-by.txt'), 'utf8').trim();
    };
    // el commit viejo se mide con SU exportador y SU lista, aunque el clon esté parado en la rama del pipeline
    const a = build(old, 'old');
    assert.strictEqual(a.status, 0, `un commit sin los archivos de la W0 se tiene que poder medir: ${a.stdout}${a.stderr}`);
    assert.strictEqual(exportedBy('old'), 'old', 'corrió el exportador del commit medido');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(base, 'old', 'bundle-info.json'), 'utf8')).harness_commit, old);
    const b = build('HEAD', 'new');
    assert.strictEqual(b.status, 0, `${b.stdout}${b.stderr}`);
    assert.strictEqual(exportedBy('new'), 'new');
    // el árbol extraído (trae las listas privadas del commit) no queda bajo la carpeta del bundle; el clon, sin tocar
    for (const name of ['old', 'new']) assert.deepStrictEqual(fs.readdirSync(path.join(base, name)).sort(), ['bundle-info.json', 'harness.bundle']);
    assert.strictEqual(git(['status', '--porcelain'], repo).stdout, '');
    // el control positivo: la mezcla de antes (el exportador y la lista de la rama, contra el suites.json del commit
    // viejo) es la que frenaba con el mensaje de la corrida 11678
    const mixed = spawnSync(process.execPath, [path.join(repo, 'scripts', 'publishing', 'export.js'), '--harness', old, '--output', path.join(base, 'mixed')], { encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_GUIDES_DIR: repo }) });
    assert.strictEqual(mixed.status, 2);
    assert.match(mixed.stderr, /suitesOutside: arnes:tests\/windows-probe\.test\.js no está en scripts\/tests\/suites\.json/);
    // un commit anterior al exportador: lo dice, no arma una copia a medias
    const bare = path.join(base, 'no-exporter');
    fs.mkdirSync(bare); git(['init', '-q'], bare); write(bare, { 'README.md': 'x\n' }); git(['add', '-A'], bare); git(['commit', '-q', '-m', 'x'], bare);
    const c = spawnSync('bash', [path.join(DIR, 'build-bundle.sh'), '--output', path.join(base, 'none'), '--repo', bare, '--skills-ref', 'HEAD'], { encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_SKILLS_DIR: skills }) });
    assert.strictEqual(c.status, 1);
    assert.match(c.stderr, /no trae scripts\/publishing\/export\.js/);

    // El repo unido (story 8.18): un commit que trae skills/ exporta las dos fuentes de sí mismo, aunque
    // ~/.claude/agent-skills sea un enlace al propio arnés (lo que deja la plantilla compartida) — el pase adversarial
    // lo encontró rojo para toda rama que no fuera main. Y un commit de antes de la unión con ese enlace frena.
    write(repo, { 'skills/toy/SKILL.md': 'x\n' });
    git(['add', '-A'], repo); assert.strictEqual(git(['commit', '-q', '-m', 'unido'], repo).status, 0);
    const unified = git(['rev-parse', 'HEAD'], repo).stdout.trim();
    const link = path.join(base, 'skills-link');
    fs.symlinkSync(repo, link);
    const bundleWith = (ref, name, extra = []) => spawnSync('bash', [path.join(DIR, 'build-bundle.sh'), '--output', path.join(base, name), '--repo', repo, '--harness-ref', ref, ...extra], { encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_SKILLS_DIR: link }) });
    const u = bundleWith(unified, 'unified');
    assert.strictEqual(u.status, 0, `un commit del repo unido se mide sin otro clon: ${u.stdout}${u.stderr}`);
    const info = JSON.parse(fs.readFileSync(path.join(base, 'unified', 'bundle-info.json'), 'utf8'));
    assert.deepStrictEqual([info.harness_commit, info.agent_skills_commit], [unified, unified], 'las dos fuentes, del mismo commit');
    const withRef = bundleWith(unified, 'unified-ref', ['--skills-ref', 'HEAD']);
    assert.strictEqual(withRef.status, 1);
    assert.match(withRef.stderr, /es del repo unido: trae las skills adentro y --skills-ref no aplica/);
    const oldWithLink = bundleWith(old, 'old-link');
    assert.strictEqual(oldWithLink.status, 1, 'un commit de antes de la unión, con agent-skills enlazado al arnés, frena');
    assert.match(oldWithLink.stderr, /es de antes de la unión y .* es el mismo repo que el arnés/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ el recorrido entero, en modo de laboratorio ═══════════════════════════════════════════════════════════════

test('Rehearsal_LabRun_ToyRepos_OnboardingAndFridayToToday', { skip: (process.platform === 'win32' && 'el recorrido de juguete es del modo de laboratorio: en Windows corre el ensayo de verdad') || (!has('git') && 'NO MEDIDO — sin git') || (!has('bash') && 'NO MEDIDO — sin bash') || (!has('pwsh') && 'NO MEDIDO — sin pwsh en esta máquina') }, () => {
  const base = tmp('lab');
  try {
    const toy = toyRepos(base);
    const src = path.join(base, 'sources');
    assert.strictEqual(node([path.join(DIR, 'build-sources.js'), '--output', src, '--harness', toy.harness, '--skills', toy.skills, '--friday-tag', TOY_TAG]).status, 0);
    // un `powershell` de mentira (acá no hay PowerShell 5.1): el pwsh de la máquina, con otro nombre
    const shim = path.join(base, 'ps51');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'powershell'), `#!/bin/sh\nexec "${fs.realpathSync(L.scanPath('pwsh')[0])}" "$@"\n`, { mode: 0o755 });
    const env = Object.assign({}, process.env, { PATH: `${shim}${path.delimiter}${process.env.PATH}`, TYCON_NO_NIGHTLY_EXAM: '0' });
    const canHide = !T.withoutPwsh(env).problem;   // ¿en esta máquina pwsh vive en una carpeta propia?
    const lab = path.join(base, 'lab'); const out = path.join(base, 'out');
    const realBefore = listing(path.join(os.homedir(), '.claude', '.tycon-pipeline', 'harness'));
    const r = node([path.join(DIR, 'rehearse.js'), 'all', '--lab', lab, '--out', out, '--sources', src, '--scenario', 'all', '--run-id', '888', '--harness-ref', 'origin/main', '--allow-temp'], { env, timeout: 900000 });
    const why = `${r.stdout}\n${r.stderr}`.split('\n').slice(-40).join('\n');
    const report = JSON.parse(fs.readFileSync(path.join(out, 'windows-report.json'), 'utf8'));
    // para mirar el reporte de juguete a mano: TYCON_WINDOWS_REHEARSAL_KEEP=<carpeta> se lo lleva antes de borrar todo
    if (process.env.TYCON_WINDOWS_REHEARSAL_KEEP) fs.cpSync(out, process.env.TYCON_WINDOWS_REHEARSAL_KEEP, { recursive: true });
    const step = (name) => report.steps.find((s) => s.name === name);
    assert.deepStrictEqual(report.steps.map((s) => s.name), rehearse.SCENARIOS.all, why);
    assert.deepStrictEqual(report.steps.map((s) => s.status), ['measured', 'measured', 'measured', 'measured', 'measured'], `${JSON.stringify(report.steps.map((s) => s.reason))}\n${why}`);
    assert.deepStrictEqual([report.kind, report.run.id, report.run.scenario, report.run.lab_mode, report.run.commits.harness.between], ['windows-rehearsal', '888', 'all', true, 1]);
    // lo que encontró es grave y la corrida es verde: se pudo ensayar
    assert.deepStrictEqual([r.status, report.verdict.color], [0, 'green'], why);
    assert.ok(report.verdict.by_severity.breaks >= 1 && report.verdict.by_severity['loses-control'] >= 2, JSON.stringify(report.verdict.by_severity));
    for (const s of report.steps) assert.strictEqual(s.capped_by, 'run-capped.js', `${s.name} corrió bajo su tope`);
    assert.deepStrictEqual(listing(path.join(os.homedir(), '.claude', '.tycon-pipeline', 'harness')), realBefore, 'la carpeta de usuario real quedó como estaba');

    // ── update: del viernes a hoy
    const upd = step('update');
    const ids = upd.findings.map((f) => f.id);
    assert.deepStrictEqual(Object.keys(upd.facts.variants), update.VARIANTS.map((v) => v.id));
    const today = report.run.commits.harness.today;
    const canonical = upd.facts.variants.canonical;
    // el viernes: los pasos del alta, tal cual, con el instalador de ese commit; la línea vieja conocida, migrada a la nueva
    assert.deepStrictEqual(canonical.friday.install.steps.map((s) => [s.id, s.exit]), [['step-0', 0], ['clone-harness', 0], ['clone-skills', 0], ['links', 0], ['import', 0], ['startup-line', 0], ['installer', 0], ['json-check', 0], ['verify', 0]], JSON.stringify(canonical.friday.install.steps.map((s) => s.stderr)));
    assert.strictEqual(canonical.friday.install.startup_line.from, 'canonical-windows');
    assert.ok(L.isInside(canonical.friday.install.clone, lab), 'todo dentro del laboratorio');
    assert.deepStrictEqual([canonical.before.settings.hooks.length, canonical.before.settings.startup_lines.map((l) => l.form), canonical.before.version.text, canonical.before.repos.harness.head], [5, ['new'], 'toy 1 · managed', report.run.commits.harness.friday]);
    assert.deepStrictEqual(canonical.before.links.map((l) => l.ok), [true, true, true, true]);
    // hoy: pasó el fin de semana, cuatro sesiones, y la primera ya la deja en lo de hoy. La cuarta existe para que
    // «cada arranque reescribe settings.json» compare dos sesiones YA actualizadas (la tercera puede ser la primera en
    // que corre el programa nuevo, y esa escritura es una sola vez)
    assert.strictEqual(canonical.weekend.done, true);
    assert.deepStrictEqual(canonical.sessions.map((s) => [s.label, s.form, s.heads.harness]), [['hoy-1', 'bash-c', today], ['hoy-2', 'default-shell', today], ['hoy-3', 'default-shell', today], ['hoy-4', 'default-shell', today]]);
    assert.deepStrictEqual([canonical.updated_by_itself, canonical.answers.updated, canonical.answers.healthy, canonical.after.version.text], [true, true, false, 'toy 2 · managed']);
    // cada diferencia, con su gravedad
    const sev = (id) => (upd.findings.find((f) => f.id === id) || {}).severity;
    assert.strictEqual(sev('update:canonical:hooks:dangling:Stop:@tcg:toy-old.js'), 'loses-control', `un hook que quedó apuntando a un archivo que ya no existe: ${ids.join('\n')}`);
    assert.strictEqual(sev('update:canonical:hooks:lost:SessionStart:@tcg:toy-notice.js'), 'loses-control', 'un hook que estaba el viernes y la lista de hoy sigue esperando');
    assert.strictEqual(sev('update:canonical:hooks:lost:Stop:@tcg:toy-retired.js'), 'noise', 'un hook retirado a propósito');
    assert.strictEqual(sev('update:canonical:smoke:default-shell:PreToolUse:@tcg:toy-brake.js[Bash]'), 'breaks', 'un freno que ahora frena lo legítimo');
    for (const id of ['settings:keys-added', 'commands:added', 'version:changed', 'hooks:gained']) assert.strictEqual(sev(`update:canonical:${id}`), 'noise', id);
    assert.ok(upd.findings.some((f) => /^update:canonical:doctor:new-warn:/.test(f.id) && f.severity === 'noise'));
    assert.ok(!ids.some((id) => /^update:canonical:.*not-updated-by-itself/.test(id)));
    assert.deepStrictEqual([canonical.after.settings.cleanup_period_days, canonical.after.settings.env, canonical.after.commands], [365, { TOY_FLAG: '1' }, ['toy.md']]);
    // la línea más vieja (la del texto): también migrada, también actualizada
    assert.deepStrictEqual([upd.facts.variants['oldest-line'].friday.install.startup_line.from, upd.facts.variants['oldest-line'].answers.updated], ['el texto del alta', true]);
    if (canHide) {
      // sin pwsh el lunes: los clones avanzan, el aplicador no corre, y los hooks del viernes quedan como estaban:
      // el que cambió de nombre apunta a la nada, y el mecanismo le dice al dev qué instalar
      const missing = upd.facts.variants['pwsh-missing'];
      assert.deepStrictEqual([missing.answers.updated, missing.updated_by_itself, missing.after.settings.hooks.length], [true, true, 5]);
      assert.strictEqual(sev('update:pwsh-missing:hooks:dangling:Stop:@tcg:toy-old.js'), 'loses-control');
      assert.ok(missing.answers.what_the_dev_is_told.some((l) => /falta pwsh en el PATH/.test(l)), JSON.stringify(missing.answers.what_the_dev_is_told));
      assert.match(missing.after.state.notice, /instalá PowerShell 7/);
      // sólo el PowerShell viejo: la línea queda vieja (el mecanismo sólo migra las que empiezan con pwsh) y no trae
      // nada: la máquina no se actualiza sola, y queda dicho
      const old = upd.facts.variants.ps51;
      assert.match(old.friday.install.startup_line.command, /^powershell /);
      assert.deepStrictEqual([old.friday.install.ps, old.before.settings.startup_lines.map((l) => `${l.form}:${l.shell}`), old.updated_by_itself], ['powershell', ['old:powershell'], false]);
      assert.strictEqual(sev('update:ps51:not-updated-by-itself'), 'loses-control');
      assert.deepStrictEqual([old.by_hand.harness.exit, old.sessions[old.sessions.length - 1].label, old.answers.updated], [0, 'hoy-a-mano', true]);
    } else {
      for (const id of ['pwsh-missing', 'ps51']) assert.match(upd.facts.variants[id].not_run, /quitar pwsh del PATH/);
    }
    assert.ok(upd.facts.line_endings && upd.facts.line_endings.harness.sh.total >= 2 && upd.facts.line_endings.harness.sh.with_cr === 0, `los finales de línea de los dos clones: ${JSON.stringify(upd.facts.line_endings)}`);
    assert.ok(upd.facts.powershell_reads.some((p) => p.shell === 'pwsh' && p.file === 'install-tycon-hooks.ps1' && p.parse_errors === 0), JSON.stringify(upd.facts.powershell_reads));
    assert.ok(upd.facts.not_rehearsed.length >= 8 && upd.facts.not_rehearsed.every((n) => n.step && n.what && n.why), 'lo no ensayado, con su motivo');

    // ── onboarding: el alta con lo de hoy
    const onb = step('onboarding');
    const dev = onb.facts.variants['new-dev'];
    assert.deepStrictEqual(dev.install.steps.map((s) => s.exit), Array(9).fill(0), JSON.stringify(dev.install.steps.map((s) => s.stderr)));
    assert.deepStrictEqual(dev.installed.links.map((l) => [l.name, l.present, l.ok]), [['tycon-claude-guides', true, true], ['agent-skills', true, true], ['agents', true, true], ['skills', true, true]]);
    assert.deepStrictEqual([dev.installed.doctor.mode, dev.installed.doctor.fail.length, dev.installed.repos.harness.head, dev.installed.settings.duplicated.length, dev.installed.settings.dangling.length], ['managed', 0, today, 0, 0]);
    assert.deepStrictEqual(dev.installed.expected.missing.sort(), ['PostToolUse:@tcg:toy-never.js', 'SessionStart:@tcg:toy-notice.js']);
    const osev = (id) => (onb.findings.find((f) => f.id === id) || {}).severity;
    assert.strictEqual(osev('onboarding:new-dev:hooks:missing:SessionStart:@tcg:toy-notice.js'), 'loses-control');
    assert.strictEqual(dev.answers.usable, true, 'nada de lo que encontró le impide trabajar');
    assert.deepStrictEqual(dev.sessions.map((s) => s.form), ['default-shell', 'bash-c'], 'la primera sesión, lanzada de las dos formas');
    assert.strictEqual(onb.facts.measured_variant, 'new-dev');
    if (canHide) assert.deepStrictEqual([onb.facts.variants['new-dev-ps51'].install.ps, onb.facts.variants['new-dev-ps51'].installed.settings.startup_lines.map((l) => l.shell)], ['powershell', ['powershell']]);
    // …y sobre lo que dejó, los pasos de siempre: contar y disparar
    assert.deepStrictEqual(step('count-hooks').findings.map((f) => f.id).sort(), ['hooks:missing:PostToolUse:@tcg:toy-never.js', 'hooks:missing:SessionStart:@tcg:toy-notice.js']);
    assert.strictEqual(step('fire-registered').facts.variant, 'new-dev');
    assert.ok(step('fire-registered').facts.hooks_fired >= 3);
    // qué `bash` ve un hook registrado como `bash "<guion>"` cuando lo lanza el bash de Git: queda anotado, no supuesto
    const seenBash = step('fire-registered').facts.bash_seen_by_hooks;
    assert.ok(seenBash && seenBash.exit === 0 && /bash/.test(seenBash.path), `el paso anota qué bash resuelve un hook: ${JSON.stringify(seenBash)}`);

    // el reporte: no nombra las direcciones de los dos repos, y trae su resumen legible
    const published = listing(out).filter((f) => fs.statSync(path.join(out, f)).isFile());
    for (const f of ['windows-report.json', 'windows-report.md', 'settings-update-canonical-friday.json', 'settings-update-canonical-today.json', 'settings-onboarding-new-dev.json']) assert.ok(published.includes(f), `${f} en ${published.join(', ')}`);
    for (const f of published) assert.ok(!fs.readFileSync(path.join(out, f), 'utf8').includes('example.com/acme'), `${f} nombra la dirección de un repo`);
    const md = fs.readFileSync(path.join(out, 'windows-report.md'), 'utf8');
    for (const title of ['## Veredicto: VERDE — se pudo ensayar', '## En corto — del viernes a hoy', '### canonical', '### oldest-line', '### new-dev', '## Finales de línea', '## ¿Cada PowerShell puede leer los .ps1 del arnés de hoy?', '## No ensayado']) assert.ok(md.includes(title), `el resumen trae «${title}»`);
    // un laboratorio no se usa dos veces; y un escenario solo corre sólo sus pasos
    const twice = node([path.join(DIR, 'rehearse.js'), 'init', '--lab', lab, '--out', out, '--sources', src, '--allow-temp'], { env });
    assert.strictEqual(twice.status, 2);
    assert.match(twice.stderr, /el laboratorio es de una sola corrida/);
    const lab2 = path.join(base, 'lab2'); const out2 = path.join(base, 'out2');
    const one = node([path.join(DIR, 'rehearse.js'), 'all', '--lab', lab2, '--out', out2, '--sources', src, '--scenario', 'update', '--only', 'canonical', '--allow-temp'], { env, timeout: 600000 });
    const r2 = JSON.parse(fs.readFileSync(path.join(out2, 'windows-report.json'), 'utf8'));
    assert.deepStrictEqual([one.status, r2.steps.map((s) => s.name), Object.keys(r2.steps[1].facts.variants), r2.verdict.color], [0, ['inventory', 'update'], ['canonical'], 'green'], `${one.stdout}\n${one.stderr}`.split('\n').slice(-20).join('\n'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ R9 · el recorrido, con un arnés de un solo clon ═══════════════════════════════════════════════════════════

test('Rehearsal_LabRun_OneCloneHarness_OnboardingAndFridayToToday', { skip: (process.platform === 'win32' && 'el recorrido de juguete es del modo de laboratorio: en Windows corre el ensayo de verdad') || (!has('git') && 'NO MEDIDO — sin git') || (!has('bash') && 'NO MEDIDO — sin bash') || (!has('pwsh') && 'NO MEDIDO — sin pwsh en esta máquina') }, () => {
  const base = tmp('lab-one');
  try {
    // el arnés es de un solo clon el viernes y hoy; el bundle de agent-skills sigue estando (lo arma el pipeline) y
    // nadie lo clona
    const toy = toyRepos(base, { friday: TOY_UNIFIED_FRIDAY, today: TOY_UNIFIED_TODAY });
    const src = path.join(base, 'sources');
    assert.strictEqual(node([path.join(DIR, 'build-sources.js'), '--output', src, '--harness', toy.harness, '--skills', toy.skills, '--friday-tag', TOY_TAG]).status, 0);
    const lab = path.join(base, 'lab'); const out = path.join(base, 'out');
    const env = Object.assign({}, process.env, { TYCON_NO_NIGHTLY_EXAM: '0' });
    const r = node([path.join(DIR, 'rehearse.js'), 'all', '--lab', lab, '--out', out, '--sources', src, '--scenario', 'all', '--only', 'canonical,new-dev', '--run-id', '889', '--allow-temp'], { env, timeout: 900000 });
    const why = `${r.stdout}\n${r.stderr}`.split('\n').slice(-40).join('\n');
    const report = JSON.parse(fs.readFileSync(path.join(out, 'windows-report.json'), 'utf8'));
    if (process.env.TYCON_WINDOWS_REHEARSAL_KEEP) fs.cpSync(out, `${process.env.TYCON_WINDOWS_REHEARSAL_KEEP}-one-clone`, { recursive: true });
    const step = (name) => report.steps.find((s) => s.name === name);
    assert.deepStrictEqual(report.steps.map((s) => [s.name, s.status]), rehearse.SCENARIOS.all.map((n) => [n, 'measured']), `${JSON.stringify(report.steps.map((s) => s.reason))}\n${why}`);
    assert.deepStrictEqual([r.status, report.verdict.color], [0, 'green'], why);
    const today = report.run.commits.harness.today;
    const ONE_CLONE_STEPS = [['step-0', 0], ['clone-harness', 0], ['install', 0], ['check-links', 0], ['doctor', 0], ['json-check', 0], ['verify', 0]];
    const ALL_LINKS = [['tycon-claude-guides', true, true], ['agent-skills', true, true], ['agents', true, true], ['skills', true, true]];

    // ── onboarding: el alta de un solo clon
    const onb = step('onboarding');
    assert.deepStrictEqual([onb.facts.doc.shape, onb.facts.doc.startup_line, onb.facts.doc.installer, onb.facts.commits.skills], ['one-clone', null, null, null], 'el reporte dice qué forma leyó');
    assert.match(onb.facts.doc.doctor, /harness\.js" doctor$/);
    assert.deepStrictEqual(Object.keys(onb.facts.variants), ['new-dev']);
    const dev = onb.facts.variants['new-dev'];
    // los pasos: clonar, instalar, mirar los enlaces, el diagnóstico, el JSON y la verificación. Ninguno escribe la
    // línea de arranque a mano ni clona agent-skills
    assert.deepStrictEqual(dev.install.steps.map((s) => [s.id, s.exit]), ONE_CLONE_STEPS, JSON.stringify(dev.install.steps.map((s) => s.stderr)));
    assert.deepStrictEqual([dev.install.shape, dev.install.skills, dev.install.startup_line.from, dev.install.startup_line.async], ['one-clone', dev.install.clone, 'el instalador (PASO 2)', true]);
    assert.ok(T.isNewStartup(dev.install.startup_line.command), 'la línea de arranque la dejó el instalador');
    assert.ok(L.isInside(dev.install.clone, lab), 'todo dentro del laboratorio');
    assert.doesNotMatch(dev.install.steps.find((s) => s.id === 'verify').stderr, /engram/, 'la verificación corre sin la línea de engram');
    // la carpeta de las skills ES el clon: los cuatro enlaces llegan a él, y hay un solo repo que fotografiar
    assert.deepStrictEqual(dev.installed.links.map((l) => [l.name, l.present, l.ok]), ALL_LINKS);
    assert.strictEqual(fs.realpathSync(path.join(dev.home, '.claude', 'agent-skills')), fs.realpathSync(dev.install.clone));
    assert.strictEqual(fs.realpathSync(path.join(dev.home, '.claude', 'skills')), path.join(fs.realpathSync(dev.install.clone), 'skills'));
    assert.deepStrictEqual([Object.keys(dev.installed.repos), dev.installed.repos.harness.head, dev.installed.claude_md.imports.length], [['harness'], today, 1]);
    // lo de después se mide igual: la línea de arranque registrada, los hooks contra la lista, doctor, la primera sesión
    assert.deepStrictEqual([dev.installed.settings.startup_lines.map((l) => l.form), dev.installed.doctor.mode, dev.installed.doctor.fail.length, dev.installed.settings.duplicated.length, dev.installed.settings.dangling.length], [['new'], 'managed', 0, 0, 0]);
    assert.deepStrictEqual(dev.installed.expected.missing.sort(), ['PostToolUse:@tcg:toy-never.js', 'SessionStart:@tcg:toy-notice.js']);
    assert.deepStrictEqual(dev.sessions.map((s) => [s.form, s.heads]), [['default-shell', { harness: today }], ['bash-c', { harness: today }]]);
    assert.strictEqual(dev.answers.usable, true, JSON.stringify(onb.findings.map((f) => f.id)));
    assert.ok(!onb.findings.some((f) => /skills/.test(f.id)), `nada que decir de un segundo clon: ${onb.findings.map((f) => f.id).join(' ')}`);
    assert.strictEqual(onb.facts.not_rehearsed.find((n) => n.step === 'PASO 1').why, 'piden una credencial: el repo se sirve desde el laboratorio');
    // …y sobre lo que dejó, contar y disparar: los hooks de las skills se encuentran dentro del clon
    assert.strictEqual(onb.facts.measured_variant, 'new-dev');
    assert.deepStrictEqual(step('count-hooks').findings.map((f) => f.id).sort(), ['hooks:missing:PostToolUse:@tcg:toy-never.js', 'hooks:missing:SessionStart:@tcg:toy-notice.js']);
    assert.strictEqual(step('fire-registered').facts.variant, 'new-dev');
    assert.ok(step('fire-registered').facts.hooks_fired >= 3);

    // ── update: la máquina del viernes, instalada con un solo clon, llega a lo de hoy
    const upd = step('update');
    const canonical = upd.facts.variants.canonical;
    assert.deepStrictEqual([upd.facts.doc.shape, Object.keys(upd.facts.commits.today)], ['one-clone', ['harness']]);
    assert.deepStrictEqual(canonical.friday.install.steps.map((s) => [s.id, s.exit]), ONE_CLONE_STEPS, JSON.stringify(canonical.friday.install.steps.map((s) => s.stderr)));
    assert.deepStrictEqual([canonical.friday.install.startup_line.from, canonical.before.repos.harness.head, Object.keys(canonical.before.repos), canonical.before.settings.startup_lines.map((l) => l.form)], ['el instalador (PASO 2)', report.run.commits.harness.friday, ['harness'], ['new']]);
    assert.deepStrictEqual(canonical.before.links.map((l) => [l.name, l.present, l.ok]), ALL_LINKS);
    assert.deepStrictEqual(canonical.sessions.map((s) => [s.label, s.heads]), [['hoy-1', { harness: today }], ['hoy-2', { harness: today }], ['hoy-3', { harness: today }], ['hoy-4', { harness: today }]]);
    assert.deepStrictEqual([canonical.updated_by_itself, canonical.answers.updated, canonical.by_hand, canonical.after.version.text], [true, true, undefined, 'toy 2 · managed']);
    assert.deepStrictEqual(Object.keys(upd.facts.line_endings), ['harness']);
    const sev = (id) => (upd.findings.find((f) => f.id === id) || {}).severity;
    assert.strictEqual(sev('update:canonical:hooks:dangling:Stop:@tcg:toy-old.js'), 'loses-control', upd.findings.map((f) => f.id).join('\n'));
    assert.strictEqual(sev('update:canonical:smoke:default-shell:PreToolUse:@tcg:toy-brake.js[Bash]'), 'breaks');
    assert.ok(!upd.findings.some((f) => /:skills$|not-updated-by-itself/.test(f.id)), upd.findings.map((f) => f.id).join(' '));
    assert.ok(upd.notes.some((n) => /un solo clon/.test(n)), 'queda dicho que la línea de arranque del viernes la dejó el instalador');

    // el reporte legible dice la forma, y no nombra la dirección del repo
    const md = fs.readFileSync(path.join(out, 'windows-report.md'), 'utf8');
    for (const text of ['## Veredicto: VERDE — se pudo ensayar', '### new-dev', '### canonical', 'de **un solo clon**', 'la línea de arranque que dejó el instalador']) assert.ok(md.includes(text), `el resumen trae «${text}»`);
    for (const f of listing(out).filter((f) => fs.statSync(path.join(out, f)).isFile())) assert.ok(!fs.readFileSync(path.join(out, f), 'utf8').includes('example.com/acme'), `${f} nombra la dirección de un repo`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Rehearsal_TeamDoc_OneClone_PlanThenInstall_RunsTheInstallingBlock', () => {
  // tanda B de la 8.16: el PASO 2 trae primero el plan (`install --dry-run`) y después la instalación (`install --yes`)
  const text = fs.readFileSync(path.join(FIXTURES, 'onboarding-one-clone.md'), 'utf8');
  const line = 'node "$env:USERPROFILE\\SourceCode\\tycon-claude-guides\\scripts\\setup\\harness.js" install';
  assert.ok(text.includes(line), 'el fixture cambió: no encuentro la línea del PASO 2');
  const two = text.replace(line, `${line} --dry-run\n  \`\`\`\n  y, con el sí del dev:\n  \`\`\`powershell\n  ${line} --yes`);
  const zero = `1. Cloná el repo: \`git clone ${TOY_HARNESS_URL} "$env:USERPROFILE\\SourceCode\\tycon-claude-guides"\`\n`;
  const doc = T.parseTeamDoc(two, zero);
  assert.strictEqual(doc.problem, undefined, doc.problem);
  assert.match(doc.blocks.install, /install --yes/);
  assert.doesNotMatch(doc.blocks.install, /--dry-run/);
  // con un solo bloque, el de siempre
  assert.doesNotMatch(T.parseTeamDoc(text, zero).blocks.install, /--yes|--dry-run/);
});

// ── story 8.19 (revisión de C+E, C1): una máquina NUEVA sólo tiene el lugar; las sondas lo buscan primero ──────────────
// Desde la tanda C una máquina nueva no recibe el nombre viejo: el lugar (`place.js`) y su import
// `@~/.claude/<lugar>/README.md`. 🔴 rojo previo: team-lab.js e install-probe.js miraban sólo el viejo y cobraban
// `links:missing:<viejo>` («el arnés no se encuentra a sí mismo») e `import:missing` en una máquina sana.
test('Rehearsal_FreshMachine_PlaceOnly_ProbesFindIt_LegacyOnlyIfPresent', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const PLACE = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'place.js'));
  const probe = require(path.join(DIR, 'install-probe.js'));
  const base = tmp('place');
  try {
    const home = path.join(base, 'home'); const dot = path.join(home, '.claude');
    const repo = path.join(base, 'clon');
    write(repo, { 'README.md': '# de juguete\n', 'skills/toy/SKILL.md': '# x\n', 'agents/toy-reviewer.md': '# x\n' });
    git(['init', '-q'], repo); git(['add', '-A'], repo); git(['commit', '-q', '-m', 'x'], repo); git(['checkout', '-q', '-B', 'main'], repo);
    fs.mkdirSync(dot, { recursive: true });
    for (const [name, to] of [[PLACE.PLACE_NAME, repo], ['agent-skills', repo], ['skills', path.join(repo, 'skills')], ['agents', path.join(repo, 'agents')]]) fs.symlinkSync(to, path.join(dot, name), 'junction');
    fs.writeFileSync(path.join(dot, 'settings.json'), '{}\n');
    fs.writeFileSync(path.join(dot, 'CLAUDE.md'), `@~/.claude/${PLACE.PLACE_NAME}/README.md\n`);
    // team-lab: el lugar, sin el viejo (no existe en una máquina nueva), y ningún hallazgo de enlaces ni de import
    assert.deepStrictEqual(T.linkFacts(home, { clone: repo, skills: repo, shape: 'one-clone' }).map((l) => [l.name, l.ok]),
      [[PLACE.PLACE_NAME, true], ['agent-skills', true], ['agents', true], ['skills', true]]);
    const p = T.photo({ home, clone: repo, skills: repo, shape: 'one-clone', env: T.rehearsalEnv(home) });
    assert.ok(!T.judgePhoto(p).some((f) => /^(links|import):/.test(f.id)), JSON.stringify(T.judgePhoto(p).map((f) => f.id)));
    // install-probe: lo mismo
    assert.deepStrictEqual(probe.measureLinks({ home, clone: repo, platform: process.platform }).map((l) => [l.name, l.present, l.to_clone]),
      [[PLACE.PLACE_NAME, true, true], ['agent-skills', true, true], ['agents', true, true], ['skills', true, true]]);
    // con el viejo además (una máquina instalada antes), se mira y tiene que llegar al mismo clon
    fs.symlinkSync(path.join(dot, PLACE.PLACE_NAME), path.join(dot, PLACE.LEGACY_PLACE_NAME), 'junction');
    assert.deepStrictEqual(T.linkFacts(home, { clone: repo, skills: repo, shape: 'one-clone' }).map((l) => [l.name, l.ok]).slice(0, 2),
      [[PLACE.PLACE_NAME, true], [PLACE.LEGACY_PLACE_NAME, true]]);
    // sólo el viejo (una máquina de antes de la 8.19): el arnés se encuentra, sin hallazgo
    fs.unlinkSync(path.join(dot, PLACE.LEGACY_PLACE_NAME)); fs.unlinkSync(path.join(dot, PLACE.PLACE_NAME));
    fs.symlinkSync(repo, path.join(dot, PLACE.LEGACY_PLACE_NAME), 'junction');
    assert.deepStrictEqual(T.linkFacts(home, { clone: repo, skills: repo, shape: 'one-clone' }).map((l) => [l.name, l.ok]).slice(0, 2), [[PLACE.LEGACY_PLACE_NAME, true], ['agent-skills', true]]);
    // y sin ninguno de los dos, el hallazgo nombra el lugar (no el viejo)
    fs.unlinkSync(path.join(dot, PLACE.LEGACY_PLACE_NAME));
    const q = T.photo({ home, clone: repo, skills: repo, shape: 'one-clone', env: T.rehearsalEnv(home) });
    assert.ok(T.judgePhoto(q).some((f) => f.id === `links:missing:${PLACE.PLACE_NAME}`), JSON.stringify(T.judgePhoto(q).map((f) => f.id)));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ story 8.26, tanda D · el ensayo sobre UN SOLO REPO (el árbol publicado) ═══════════════════════════════════════
// Con la fuente github el pipeline ensaya el árbol de GitHub tal cual: un repo, con las skills adentro, traído por el
// agente con `HEAD` suelto en el commit pedido. Lo que no se puede perder:
//   · «hoy» es ESE commit, nunca la rama principal del repo (T50);
//   · la marca es opcional, y si se pasa y no está, no hay bundle (T50);
//   · un bundle que no se puede clonar no se entrega (T52);
//   · una copia publicada no trae el texto del alta del equipo: `update` y `onboarding` dicen NO MEDIDO, y una corrida
//     donde nada midió termina CON AVISOS, nunca en un verde liso (T51);
//   · con `--same-tree`, el árbol de los guiones tiene que ser el commit que se ensaya.

/**
 * Un repo de juguete con forma de árbol publicado, y su checkout como lo deja un agente: `origin/main`, las etiquetas y
 * `HEAD` suelto en el commit de una rama. `{ origin, checkout, friday, main, branch }` (los tres commits).
 */
function toySingleRepo(base, { versionFile = true, friday = {}, today = {}, name = 'toy-public' } = {}) {
  const origin = path.join(base, `${name}-origin`);
  fs.mkdirSync(origin, { recursive: true });
  git(['init', '-q', '-b', 'main'], origin);
  const common = Object.assign({ 'README.md': '# arnés de juguete\n', '.github/README.md': '# la portada de juguete\n', 'skills/toy/SKILL.md': '# x\n', 'agents/toy-reviewer.md': '# x\n', 'scripts/a.sh': '#!/bin/sh\nexit 0\n' },
    versionFile ? { 'version.json': '{ "version": "2026.01.01.1" }\n' } : {});
  const commit = (files, message) => { write(origin, files); git(['add', '-A'], origin); assert.strictEqual(git(['commit', '-q', '-m', message], origin).status, 0, `no pude armar «${message}»`); return git(['rev-parse', 'HEAD'], origin).stdout.trim(); };
  const fridaySha = commit(Object.assign({}, common, friday), 'el viernes');
  git(['tag', TOY_TAG], origin);
  const mainSha = commit(Object.assign({ 'scripts/b.sh': '#!/bin/sh\nexit 0\n' }, today), 'main de hoy');
  git(['checkout', '-q', '-b', 'una-rama'], origin);
  const branchSha = commit({ 'scripts/c.sh': '#!/bin/sh\nexit 0\n' }, 'un cambio de la rama');
  git(['checkout', '-q', 'main'], origin);
  const checkout = path.join(base, `${name}-checkout`);
  fs.mkdirSync(checkout, { recursive: true });
  git(['init', '-q'], checkout);
  git(['remote', 'add', 'origin', origin], checkout);
  assert.strictEqual(git(['fetch', '-q', '--tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'], checkout).status, 0, 'no pude traer el repo de juguete');
  assert.strictEqual(git(['checkout', '-q', '--detach', branchSha], checkout).status, 0);
  return { origin, checkout, friday: fridaySha, main: mainSha, branch: branchSha };
}
const refsOf = (bundleOrRepo) => { const r = spawnSync('git', ['ls-remote', bundleOrRepo], { encoding: 'utf8' }); return Object.fromEntries(r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t').reverse())); };
const SOURCES = path.join(DIR, 'build-sources.js');

test('Rehearsal_BuildSources_SingleRepo_TodayIsTheCheckedOutCommit_MarkOptional_LabWithOneRemote', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('t50');
  try {
    const toy = toySingleRepo(base);
    assert.notStrictEqual(toy.branch, toy.main, 'el juguete: HEAD no es la rama principal');
    // ── con la marca
    const out = path.join(base, 'sources');
    const r = node([SOURCES, '--output', out, '--harness', toy.checkout, '--single-repo', '--friday-tag', TOY_TAG]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(fs.readdirSync(out).sort(), ['harness.bundle', 'sources-info.json'], 'un solo bundle, y nada más en la carpeta');
    const info = JSON.parse(fs.readFileSync(path.join(out, 'sources-info.json'), 'utf8'));
    assert.deepStrictEqual([info.single_repo, 'skills' in info, info.friday_tag], [true, false, TOY_TAG]);
    // 🔴 «hoy» es el commit que trajo el checkout (HEAD), no la rama principal; el «antes» es el antepasado común
    assert.deepStrictEqual([info.harness.target, info.harness.target_ref, info.harness.friday, info.harness.base], [toy.branch, 'HEAD', toy.friday, toy.main]);
    assert.match(info.harness.base_from, /antepasado común/);
    assert.deepStrictEqual([info.harness.commits_between, info.harness.friday_is_ancestor, info.harness.commits_since_base], [2, true, 1]);
    const refs = refsOf(path.join(out, 'harness.bundle'));
    assert.deepStrictEqual([refs['refs/heads/main'], refs['refs/heads/friday'], refs['refs/heads/base']], [toy.branch, toy.friday, toy.main]);
    assert.doesNotMatch(r.stdout, /agent-skills/, 'no nombra un segundo repo');
    assert.strictEqual(git(['status', '--porcelain'], toy.checkout).stdout, '', 'no toca el checkout que empaqueta');
    // ── la marca puede ser un commit (un repo sin etiquetas)
    const bySha = sources.build({ output: path.join(base, 's-sha'), harness: toy.checkout, singleRepo: true, fridayTag: toy.friday });
    assert.ok(bySha.ok, bySha.reason);
    assert.strictEqual(bySha.info.harness.friday, toy.friday);
    // ── sin marca: sale igual, sin la rama friday, y lo dice
    const noMark = path.join(base, 's-no-mark');
    const r2 = node([SOURCES, '--output', noMark, '--harness', toy.checkout, '--single-repo']);
    assert.strictEqual(r2.status, 0, r2.stderr);
    const info2 = JSON.parse(fs.readFileSync(path.join(noMark, 'sources-info.json'), 'utf8'));
    assert.deepStrictEqual([info2.friday_tag, info2.harness.friday, info2.harness.commits_between, info2.harness.friday_is_ancestor, info2.harness.target, info2.harness.base], [null, null, null, null, toy.branch, toy.main]);
    assert.deepStrictEqual(Object.keys(refsOf(path.join(noMark, 'harness.bundle'))).filter((k) => k.startsWith('refs/heads/')).sort(), ['refs/heads/base', 'refs/heads/main']);
    assert.match(r2.stdout, /sin marca/);
    // … y si lo que se ensaya ES la rama principal, sin marca no hay un «antes»: tampoco se inventa
    git(['checkout', '-q', '--detach', toy.main], toy.checkout);
    const onMain = sources.build({ output: path.join(base, 's-main'), harness: toy.checkout, singleRepo: true });
    assert.ok(onMain.ok, onMain.reason);
    assert.deepStrictEqual([onMain.info.harness.target, onMain.info.harness.base], [toy.main, null]);
    assert.strictEqual(sources.build({ output: path.join(base, 's-main-mark'), harness: toy.checkout, singleRepo: true, fridayTag: TOY_TAG }).info.harness.base, toy.friday, 'con marca, el «antes» de la rama principal es la marca (como con dos repos)');
    git(['checkout', '-q', '--detach', toy.branch], toy.checkout);
    // ── una marca que no está: ningún bundle, y el motivo dice qué sirve (sin mandar a traer etiquetas de otro repo)
    const none = node([SOURCES, '--output', path.join(base, 's-none'), '--harness', toy.checkout, '--single-repo', '--friday-tag', 'retorno/no-such-tag']);
    assert.strictEqual(none.status, 1);
    assert.match(none.stderr, /no encuentro «retorno\/no-such-tag»/);
    assert.match(none.stderr, /una marca o un commit de ese repo/);
    assert.doesNotMatch(none.stderr, /fetch --tags/);
    assert.deepStrictEqual(fs.existsSync(path.join(base, 's-none')) ? fs.readdirSync(path.join(base, 's-none')) : [], [], 'ni el bundle ni su información');
    // ── las dos opciones juntas no tienen sentido: uso
    const both = node([SOURCES, '--output', path.join(base, 's-both'), '--harness', toy.checkout, '--skills', toy.origin, '--single-repo']);
    assert.strictEqual(both.status, 2);
    assert.match(both.stderr, /--single-repo/);
    assert.strictEqual(node([SOURCES, '--output', path.join(base, 's-ref'), '--harness', toy.checkout, '--single-repo', '--skills-ref', 'main']).status, 2, '--skills-ref tampoco');
    // ── el laboratorio: un solo remoto, y el reporte no inventa el segundo repo
    const lab = path.join(base, 'lab'); const rep = path.join(base, 'out');
    const made = rehearse.initLab({ lab, out: rep, sources: noMark, scenario: 'no-clone', allowTemp: true, meta: { id: '7', harness_ref: 'github' } });
    assert.ok(made.ok, made.reason);
    const state = T.readState(lab);
    assert.deepStrictEqual([Object.keys(state.remotes), state.single_repo, state.remotes.harness.target, state.remotes.harness.friday, state.remotes.harness.base], [['harness'], true, toy.branch, null, toy.main]);
    assert.deepStrictEqual(fs.readdirSync(path.join(lab, 'remotes')), ['harness.git']);
    assert.deepStrictEqual([Object.keys(made.meta.commits), made.meta.single_repo, made.meta.commits.harness.today, made.meta.commits.harness.friday], [['harness'], true, toy.branch, null]);
    assert.strictEqual(T.pointRemotes(state, 'target', process.env), null);
    assert.match(T.pointRemotes(state, 'friday', process.env), /no trae el commit «friday»/, 'sin marca, apuntar al viernes lo dice: no sigue con otro commit');
    const md = rehearse.renderMarkdown({ run: made.meta, steps: [], verdict: rehearse.verdict({ run: made.meta, steps: [] }) });
    assert.match(md, /\| arnés \| — \| `[0-9a-f]{10}` \(HEAD\) \| — \|/);
    assert.doesNotMatch(md, /\| agent-skills \|/, 'el reporte no trae la fila de un repo que no hay');
    const cli = node([path.join(DIR, 'rehearse.js'), 'init', '--lab', path.join(base, 'lab2'), '--out', path.join(base, 'out2'), '--sources', out, '--scenario', 'update', '--allow-temp']);
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.doesNotMatch(cli.stdout, /agent-skills/);
    // ── con dos repos nada cambió: sin el bundle del segundo, no hay laboratorio
    const two = toyRepos(path.join(base, 'two'));
    const src2 = path.join(base, 'sources-two');
    assert.strictEqual(node([SOURCES, '--output', src2, '--harness', two.harness, '--skills', two.skills, '--friday-tag', TOY_TAG]).status, 0);
    assert.strictEqual('single_repo' in JSON.parse(fs.readFileSync(path.join(src2, 'sources-info.json'), 'utf8')), false);
    fs.rmSync(path.join(src2, 'agent-skills.bundle'));
    const lab3 = path.join(base, 'lab3');
    fs.mkdirSync(lab3); fs.writeFileSync(path.join(lab3, L.LAB_MARK), '{}\n');
    assert.match(T.makeRemotes({ lab: lab3, sources: src2, env: process.env }).reason, /no encuentro el bundle .*agent-skills\.bundle/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Bundle_ThatCannotBeCloned_RedNoBundle_SourceModeAndSources', { skip: (!has('git') && 'NO MEDIDO — sin git') }, () => {
  const base = tmp('t52');
  try {
    const toy = toySingleRepo(base);
    // un checkout recortado a un commit. Con `file://`: sobre una ruta local, `git clone --depth` ignora la profundidad
    const shallow = path.join(base, 'shallow');
    assert.strictEqual(git(['clone', '-q', '--depth', '1', '--branch', 'una-rama', `file://${toy.origin}`, shallow], base).status, 0);
    assert.strictEqual(git(['rev-parse', '--is-shallow-repository'], shallow).stdout.trim(), 'true', 'el juguete: el clon quedó recortado');
    const srcOut = path.join(base, 's-shallow');
    const s = node([SOURCES, '--output', srcOut, '--harness', shallow, '--single-repo']);
    assert.strictEqual(s.status, 1, s.stdout);
    assert.match(s.stderr, /recortado/);
    assert.match(s.stderr, /no se puede clonar/);
    assert.deepStrictEqual(fs.existsSync(srcOut) ? fs.readdirSync(srcOut) : [], [], 'no entrega nada');
    // el entero: el bundle se clona y queda en el commit
    const ok = node([SOURCES, '--output', path.join(base, 's-full'), '--harness', toy.checkout, '--single-repo']);
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.strictEqual(git(['clone', '-q', path.join(base, 's-full', 'harness.bundle'), path.join(base, 'c-full')], base).status, 0);
    assert.strictEqual(git(['rev-parse', 'HEAD'], path.join(base, 'c-full')).stdout.trim(), toy.branch);
    // lo mismo con el bundle de la medición (el guion es de bash: en Windows no corre)
    if (process.platform !== 'win32' && has('bash')) {
      const bundle = (source, out) => spawnSync('bash', [path.join(DIR, 'build-bundle.sh'), '--output', path.join(base, out), '--source', source], { encoding: 'utf8', timeout: 120000 });
      const b = bundle(shallow, 'b-shallow');
      assert.strictEqual(b.status, 1, b.stdout);
      assert.match(b.stderr, /recortado/);
      assert.match(b.stderr, /no se puede clonar/);
      assert.ok(!fs.existsSync(path.join(base, 'b-shallow', 'harness.bundle')), 'no entrega el bundle');
      assert.ok(!fs.existsSync(path.join(base, 'b-shallow', 'bundle-info.json')));
      const full = bundle(toy.checkout, 'b-full');
      assert.strictEqual(full.status, 0, full.stderr);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(base, 'b-full', 'bundle-info.json'), 'utf8')).copy_commit, toy.branch, 'el bundle es el commit del checkout');
      assert.strictEqual(git(['clone', '-q', path.join(base, 'b-full', 'harness.bundle'), path.join(base, 'cb-full')], base).status, 0);
      assert.strictEqual(git(['rev-parse', 'HEAD'], path.join(base, 'cb-full')).stdout.trim(), toy.branch);
      assert.deepStrictEqual(fs.readdirSync(path.join(base, 'b-full')).sort(), ['bundle-info.json', 'harness.bundle'], 'la carpeta de trabajo no queda');
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Rehearsal_PublishedCopyWithoutTeamText_NotMeasuredWithNotice_OtherwiseError', { skip: (!has('git') && 'NO MEDIDO — sin git') }, () => {
  const base = tmp('t51');
  try {
    const run = (toy, name, { mark = true, scenario = 'all' } = {}) => {
      const src = path.join(base, `${name}-sources`); const lab = path.join(base, `${name}-lab`); const out = path.join(base, `${name}-out`);
      assert.strictEqual(node([SOURCES, '--output', src, '--harness', toy.checkout, '--single-repo', ...(mark ? ['--friday-tag', TOY_TAG] : [])]).status, 0);
      const r = node([path.join(DIR, 'rehearse.js'), 'all', '--lab', lab, '--out', out, '--sources', src, '--scenario', scenario, '--allow-temp'], { timeout: 300000 });
      const report = JSON.parse(fs.readFileSync(path.join(out, 'windows-report.json'), 'utf8'));
      return { r, report, step: (n) => report.steps.find((s) => s.name === n), md: fs.readFileSync(path.join(out, 'windows-report.md'), 'utf8') };
    };
    // ── una copia publicada (trae version.json): desde la story 8.28 los dos ensayos ya no dicen «no medido» ahí. Eligen
    // por lo que el árbol ES y van al ensayo que sigue la página pública de instalación (windows-guided*.test.js lo
    // prueba). Esta copia de juguete no trae la página: en una copia publicada tiene que estar, así que es «no pude
    // ensayar» —un error, con lo que buscó—, nunca «no medido», y la corrida sale ROJA, no «con avisos»
    const copy = run(toySingleRepo(base, { name: 'copy' }), 'copy');
    for (const name of ['update', 'onboarding']) {
      assert.strictEqual(copy.step(name).status, 'error', `${name}: ${copy.step(name).reason}`);
      assert.match(copy.step(name).reason, /copia publicada/);
      assert.match(copy.step(name).reason, /no pude ensayar: no encuentro la página \(getting-started\/windows\.md\)/);
      assert.doesNotMatch(copy.step(name).reason, /texto del alta del equipo/, 'no pasó por el ensayo del texto del alta');
    }
    assert.deepStrictEqual(copy.report.steps.map((s) => [s.name, s.status]), [['inventory', 'measured'], ['update', 'error'], ['onboarding', 'error'], ['count-hooks', 'not-measured'], ['fire-registered', 'not-measured']]);
    assert.deepStrictEqual([copy.report.verdict.color, copy.report.verdict.nothing_measured, copy.r.status], ['red', false, 1], 'no poder ensayar una copia publicada es rojo');
    for (const name of ['update', 'onboarding']) assert.match(copy.r.stdout, new RegExp(`##vso\\[task\\.logissue type=error\\]no pude ensayar — ${name}: `), `un error por ${name}`);
    assert.doesNotMatch(copy.r.stdout, /SucceededWithIssues/, 'un rojo no se disfraza de aviso');
    assert.match(copy.r.stdout, /veredicto ROJO/);
    assert.match(copy.md, /## Veredicto: ROJO/);
    assert.doesNotMatch(copy.md, /El viernes/, 'el reporte de una copia publicada no habla del viernes');
    // ── el mismo árbol sin version.json no es una copia publicada: la falta del texto es un error, como siempre
    const plain = run(toySingleRepo(base, { name: 'plain', versionFile: false }), 'plain');
    for (const name of ['update', 'onboarding']) {
      assert.strictEqual(plain.step(name).status, 'error');
      assert.match(plain.step(name).reason, /no pude medir: .*no encuentro onboarding\/new-dev-harness-setup\.md/);
    }
    assert.deepStrictEqual([plain.report.verdict.color, plain.r.status], ['red', 1]);
    assert.doesNotMatch(plain.r.stdout, /SucceededWithIssues/, 'un rojo no se disfraza de aviso');
    // ── un texto de DOS clones en un laboratorio de un solo repo: error con su motivo, no una excepción
    const twoDoc = { 'onboarding/new-dev-harness-setup.md': TOY_DOC, 'onboarding/step-0-windows.md': TOY_COMMON['onboarding/step-0-windows.md'] };
    const two = run(toySingleRepo(base, { name: 'two', versionFile: false, friday: twoDoc }), 'two');
    for (const name of ['update', 'onboarding']) {
      assert.strictEqual(two.step(name).status, 'error');
      assert.match(two.step(name).reason, /texto del alta es de dos clones y el laboratorio trae un solo repo/);
      assert.doesNotMatch(two.step(name).reason, /Cannot read|undefined/);
    }
    // ── `update` sin marca, en el árbol interno (sin version.json): no hay un «antes» que instalar → NO MEDIDO con ese
    // motivo (aunque el texto esté), y la corrida termina CON AVISOS, nunca en un verde liso
    const oneDoc = { 'onboarding/new-dev-harness-setup.md': TOY_ONE_CLONE_DOC, 'onboarding/step-0-windows.md': TOY_COMMON['onboarding/step-0-windows.md'] };
    const noMark = run(toySingleRepo(base, { name: 'nomark', versionFile: false, friday: oneDoc }), 'nomark', { mark: false, scenario: 'update' });
    assert.strictEqual(noMark.step('update').status, 'not-measured');
    assert.match(noMark.step('update').reason, /sin una marca/);
    assert.deepStrictEqual([noMark.report.verdict.color, noMark.report.verdict.nothing_measured, noMark.r.status], ['green', true, 0], 'no sale roja por eso');
    assert.match(noMark.r.stdout, /##vso\[task\.logissue type=warning\]no medido — update: /, 'un aviso por el paso no medido');
    assert.match(noMark.r.stdout, /##vso\[task\.complete result=SucceededWithIssues;\]/, 'la corrida termina con avisos');
    assert.match(noMark.r.stdout, /veredicto CON AVISOS/);
    assert.doesNotMatch(noMark.r.stdout, /veredicto VERDE/, 'nunca un verde liso');
    assert.match(noMark.md, /## Veredicto: CON AVISOS/);
    // … y el mismo árbol CON version.json es una copia publicada: no necesita una marca, y va al ensayo de la página
    const marked = run(toySingleRepo(base, { name: 'copymark', friday: oneDoc }), 'copymark', { mark: false, scenario: 'update' });
    assert.strictEqual(marked.step('update').status, 'error');
    assert.match(marked.step('update').reason, /no pude ensayar: no encuentro la página/);
    assert.doesNotMatch(marked.step('update').reason, /sin una marca/);
    // ── el veredicto, función pura: «nada midió» mira los pasos del escenario fuera del inventario
    const rep = (steps) => ({ run: { expected_steps: steps.map((s) => s[0]) }, steps: steps.map(([name, status]) => ({ name, status, reason: status === 'measured' ? null : 'x', findings: [] })) });
    assert.strictEqual(rehearse.verdict(rep([['inventory', 'measured'], ['update', 'not-measured']])).nothing_measured, true);
    assert.strictEqual(rehearse.verdict(rep([['inventory', 'measured'], ['update', 'measured'], ['onboarding', 'not-measured']])).nothing_measured, false);
    assert.strictEqual(rehearse.verdict(rep([['inventory', 'measured'], ['no-clone', 'measured']])).nothing_measured, false);
    const red = rehearse.verdict(rep([['inventory', 'measured'], ['update', 'error']]));
    assert.deepStrictEqual([red.color, red.nothing_measured], ['red', false], 'un error es rojo, no «con avisos»');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ── lo que encontraron los revisores y el pase adversarial de la tanda D: cada caso, con la prueba que lo reprodujo ──

test('Rehearsal_BuildSources_FailedRun_LeavesNothingInTheOutputFolder_NotEvenAPreviousDelivery', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('leftovers');
  try {
    const toy = toySingleRepo(base);
    const shallow = path.join(base, 'shallow');
    assert.strictEqual(git(['clone', '-q', '--depth', '1', '--branch', 'una-rama', `file://${toy.origin}`, shallow], base).status, 0);
    const out = path.join(base, 'sources');
    const good = () => { assert.strictEqual(node([SOURCES, '--output', out, '--harness', toy.checkout, '--single-repo']).status, 0); assert.deepStrictEqual(fs.readdirSync(out).sort(), ['harness.bundle', 'sources-info.json']); };
    // una entrega anterior en la carpeta, y después una corrida que falla temprano: no queda la de antes (de otro commit)
    for (const [why, args] of [['un clon recortado', ['--harness', shallow, '--single-repo']], ['una marca que no está', ['--harness', toy.checkout, '--single-repo', '--friday-tag', 'retorno/no-such-tag']], ['una carpeta que no es un repo', ['--harness', base, '--single-repo']], ['una referencia que no está', ['--harness', toy.checkout, '--single-repo', '--harness-ref', 'no-such-branch']]]) {
      good();
      const r = node([SOURCES, '--output', out, ...args]);
      assert.strictEqual(r.status, 1, `${why}: ${r.stdout}`);
      assert.deepStrictEqual(fs.readdirSync(out), [], `${why}: en la carpeta no queda nada, tampoco la entrega anterior`);
    }
    // si la entrega anterior no se puede borrar, no se sigue encima de ella: frena y lo dice
    const stuck = path.join(base, 'sources-stuck');
    fs.mkdirSync(path.join(stuck, 'sources-info.json'), { recursive: true });   // una CARPETA con el nombre de un entregable
    fs.writeFileSync(path.join(stuck, 'sources-info.json', 'x'), 'x\n');
    const cannot = sources.build({ output: stuck, harness: toy.checkout, singleRepo: true });
    assert.strictEqual(cannot.ok, false);
    assert.match(cannot.reason, /no pude limpiar la entrega anterior/);
    assert.ok(!fs.existsSync(path.join(stuck, 'harness.bundle')), 'no arma nada encima');
    // con dos repos, si falla el segundo no queda el bundle del primero suelto
    const two = toyRepos(path.join(base, 'two'));
    git(['tag', '-d', TOY_TAG], two.skills);
    const out2 = path.join(base, 'sources-two');
    const r2 = node([SOURCES, '--output', out2, '--harness', two.harness, '--skills', two.skills, '--friday-tag', TOY_TAG]);
    assert.strictEqual(r2.status, 1);
    assert.match(r2.stderr, /agent-skills: no encuentro la marca/);
    assert.deepStrictEqual(fs.readdirSync(out2), [], 'ni el bundle del primer repo');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Rehearsal_BuildSources_CouldNotAskIsNotAnAnswer_AndSaysWhyThereIsNoBefore', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('could-not-ask');
  try {
    const toy = toySingleRepo(base);
    const env = sources.gitEnv();
    // una referencia: «no existe» es null; «git no pudo contestar» es un error con su motivo, nunca un null
    assert.strictEqual(sources.resolveRef(toy.checkout, 'no-such-branch', env), null);
    // (`--end-of-options` existe desde git 2.24: con uno más viejo esta línea no se puede afirmar, y se dice)
    const gitVersion = (/(\d+)\.(\d+)/.exec(git(['--version'], base).stdout) || []).slice(1).map(Number);
    if (gitVersion[0] > 2 || (gitVersion[0] === 2 && gitVersion[1] >= 24)) assert.strictEqual(sources.resolveRef(toy.checkout, '--help', env), null, 'una «referencia» con forma de opción no se toma por opción');
    else console.log(`  ℹ NO MEDIDO — git ${gitVersion.join('.')} no trae --end-of-options (2.24): no se afirma la referencia con forma de opción`);
    assert.match(sources.resolveRef(path.join(base, 'no-such-dir'), 'HEAD', env).error, /no pude preguntar/);
    assert.deepStrictEqual(sources.resolveRef(toy.checkout, 'HEAD', env), { sha: toy.branch, as: 'HEAD' });
    // ¿recortado?: sí, no, o no se pudo saber (que NO es «no»)
    const shallow = path.join(base, 'shallow');
    assert.strictEqual(git(['clone', '-q', '--depth', '1', `file://${toy.origin}`, shallow], base).status, 0);
    assert.deepStrictEqual([sources.isShallow(shallow, env), sources.isShallow(toy.checkout, env)], [{ shallow: true }, { shallow: false }]);
    assert.match(sources.isShallow(path.join(base, 'no-such-dir'), env).problem, /no pude saber si .* está recortado/);
    // sin un «antes», la información dice POR QUÉ: no siempre es «lo que se ensaya es la rama principal»
    const build = (name, extra = {}) => { const r = sources.build(Object.assign({ output: path.join(base, name), harness: toy.checkout, singleRepo: true }, extra)); assert.ok(r.ok, r.reason); return r.info.harness; };
    git(['checkout', '-q', '--detach', toy.main], toy.checkout);
    const onMain = build('s-main');
    assert.deepStrictEqual([onMain.base, onMain.base_from], [null, null]);
    assert.match(onMain.no_base_reason, /ya está en la rama principal.*no se pasó una marca/);
    // una rama sin historia en común con la principal (una copia empujada como commit suelto)
    git(['checkout', '-q', '--orphan', 'suelta'], toy.origin); git(['commit', '-q', '--allow-empty', '-m', 'suelto'], toy.origin);
    const loose = git(['rev-parse', 'HEAD'], toy.origin).stdout.trim();
    git(['checkout', '-q', '-f', 'main'], toy.origin);
    git(['fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*'], toy.checkout); git(['checkout', '-q', '-f', '--detach', loose], toy.checkout);
    const orphan = build('s-orphan');
    assert.strictEqual(orphan.base, null);
    assert.match(orphan.no_base_reason, /sin historia en común con la rama principal/);
    assert.doesNotMatch(orphan.no_base_reason, /ya está en la rama principal/);
    const cli = node([SOURCES, '--output', path.join(base, 's-orphan-cli'), '--harness', toy.checkout, '--single-repo']);
    assert.match(cli.stdout, /sin un «antes» \(sin historia en común con la rama principal/);
    // un repo donde no hay `origin/main` ni `main`: no se adivina la rama principal
    const odd = path.join(base, 'odd');
    fs.mkdirSync(odd); git(['init', '-q', '-b', 'trunk'], odd); write(odd, { 'a.txt': 'x\n' }); git(['add', '-A'], odd); git(['commit', '-q', '-m', 'x'], odd);
    const noMain = sources.build({ output: path.join(base, 's-odd'), harness: odd, singleRepo: true });
    assert.ok(noMain.ok, noMain.reason);
    assert.match(noMain.info.harness.no_base_reason, /no se encontró la rama principal/);
    // con marca, el motivo va en `base_from`, como siempre, y no hay `no_base_reason`
    git(['checkout', '-q', '-f', '--detach', toy.main], toy.checkout);
    const withMark = build('s-mark', { fridayTag: TOY_TAG });
    assert.deepStrictEqual([withMark.base, withMark.no_base_reason], [toy.friday, null]);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Rehearsal_MakeRemotes_HeadIsMain_AndTheBundleIsWhatItsInfoDeclares', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('remotes');
  try {
    const toy = toySingleRepo(base);
    const lab = (name) => { const d = path.join(base, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, L.LAB_MARK), '{}\n'); return d; };
    // la marca ES el commit que se ensaya (main y friday empatan en el bundle), en una máquina cuya rama por defecto se
    // llama `friday`: git adivinaría esa rama como la del remoto, y los clones nunca verían moverse `main`
    const src = path.join(base, 'sources');
    assert.ok(sources.build({ output: src, harness: toy.checkout, singleRepo: true, fridayTag: toy.branch }).ok);
    const env = Object.assign({}, process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'init.defaultBranch', GIT_CONFIG_VALUE_0: 'friday' });
    const made = T.makeRemotes({ lab: lab('lab'), sources: src, env });
    assert.ok(made.ok, made.reason);
    assert.strictEqual(spawnSync('git', ['-C', made.state.remotes.harness.dir, 'symbolic-ref', 'HEAD'], { encoding: 'utf8', env }).stdout.trim(), 'refs/heads/main', 'la rama del remoto es main, la diga quien la diga');
    const clone = path.join(base, 'clone');
    assert.strictEqual(spawnSync('git', ['clone', '-q', made.state.remotes.harness.dir, clone], { encoding: 'utf8', env }).status, 0);
    assert.strictEqual(spawnSync('git', ['-C', clone, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', env }).stdout.trim(), 'main', 'un clon queda parado en main');
    // la información declara una marca y el bundle no la trae: no se pierde callada («no medido»), frena
    const noMark = path.join(base, 'sources-no-mark');
    assert.ok(sources.build({ output: noMark, harness: toy.checkout, singleRepo: true }).ok);
    const edit = (dir, change) => { const f = path.join(dir, 'sources-info.json'); const info = JSON.parse(fs.readFileSync(f, 'utf8')); change(info); fs.writeFileSync(f, `${JSON.stringify(info, null, 2)}\n`); };
    edit(noMark, (info) => { info.friday_tag = TOY_TAG; info.harness.friday = toy.friday; info.harness.friday_tag = TOY_TAG; });
    const lost = T.makeRemotes({ lab: lab('lab2'), sources: noMark, env: process.env });
    assert.strictEqual(lost.ok, false);
    assert.match(lost.reason, /el bundle de harness no trae lo que su información declara: friday/);
    // … ni se ensaya otro commit que el declarado (lo que comprueba --same-tree es lo declarado)
    edit(noMark, (info) => { info.friday_tag = null; info.harness.friday = null; info.harness.friday_tag = null; info.harness.target = toy.main; });
    const other = T.makeRemotes({ lab: lab('lab3'), sources: noMark, env: process.env });
    assert.strictEqual(other.ok, false);
    assert.match(other.reason, /el bundle de harness no trae lo que su información declara: main/);
    // sin tocar nada, el bundle y su información coinciden
    assert.ok(T.makeRemotes({ lab: lab('lab4'), sources: src, env: process.env }).ok);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Rehearsal_ReadTeamDoc_AbsentIsNotUnreadable_PublishedCopyIsNotAnError', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('team-doc');
  try {
    const lab = (name) => { const d = path.join(base, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, L.LAB_MARK), '{}\n'); return d; };
    const state = (toy, name) => { const src = path.join(base, `${name}-src`); assert.ok(sources.build({ output: src, harness: toy.checkout, singleRepo: true, fridayTag: TOY_TAG }).ok); const made = T.makeRemotes({ lab: lab(name), sources: src, env: process.env }); assert.ok(made.ok, made.reason); return made.state; };
    const copy = state(toySingleRepo(base, { name: 'copy' }), 'copy');
    const remote = copy.remotes.harness;
    // un archivo de un commit: está, no está, o git no lo pudo decir
    assert.deepStrictEqual(T.fileAt(remote.dir, remote.target, 'version.json', process.env), { present: true });
    assert.deepStrictEqual(T.fileAt(remote.dir, remote.target, T.DOC, process.env), { present: false });
    assert.match(T.fileAt(remote.dir, 'f'.repeat(40), T.DOC, process.env).problem, /git ls-tree/);
    assert.match(T.fileAt(path.join(base, 'no-such-remote'), remote.target, T.DOC, process.env).problem, /git ls-tree/);
    // el texto del alta: copia publicada sin él → no hay qué ensayar; sin poder leer → un problema, nunca «no medido»
    assert.match(T.readTeamDoc(copy, remote.target, process.env).not_measured, /copia publicada/);
    assert.match(T.readTeamDoc(copy, 'f'.repeat(40), process.env).problem, /no pude leer/);
    const plain = state(toySingleRepo(base, { name: 'plain', versionFile: false }), 'plain');
    assert.match(T.readTeamDoc(plain, plain.remotes.harness.target, process.env).problem, /no encuentro onboarding\/new-dev-harness-setup\.md/);
    const twoDoc = { 'onboarding/new-dev-harness-setup.md': TOY_DOC, 'onboarding/step-0-windows.md': TOY_COMMON['onboarding/step-0-windows.md'] };
    const two = state(toySingleRepo(base, { name: 'two', friday: twoDoc, today: twoDoc }), 'two');
    assert.match(T.readTeamDoc(two, two.remotes.harness.target, process.env).problem, /dos clones y el laboratorio trae un solo repo/);
    const oneDoc = { 'onboarding/new-dev-harness-setup.md': TOY_ONE_CLONE_DOC, 'onboarding/step-0-windows.md': TOY_COMMON['onboarding/step-0-windows.md'] };
    const one = state(toySingleRepo(base, { name: 'one', friday: oneDoc, today: oneDoc }), 'one');
    assert.strictEqual(T.readTeamDoc(one, one.remotes.harness.target, process.env).doc.shape, 'one-clone');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Rehearsal_Init_SameTree_ScriptsTreeMustBeTheRehearsedCommit', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('same-tree');
  try {
    const toy = toySingleRepo(base);
    const src = path.join(base, 'sources');
    assert.strictEqual(node([SOURCES, '--output', src, '--harness', toy.checkout, '--single-repo']).status, 0);
    // el árbol de los guiones es el commit que se ensaya: sigue, y la etiqueta lo dice
    const ok = rehearse.initLab({ lab: path.join(base, 'lab'), out: path.join(base, 'out'), sources: src, scenario: 'no-clone', allowTemp: true, meta: { harness_ref: 'github' }, sameTree: true, scriptsCommit: () => ({ sha: toy.branch }) });
    assert.ok(ok.ok, ok.reason);
    assert.strictEqual(ok.meta.harness_ref, `github:${toy.branch}`);
    // otro commit: no hay laboratorio, y no queda nada a medias
    const other = rehearse.initLab({ lab: path.join(base, 'lab2'), out: path.join(base, 'out2'), sources: src, scenario: 'no-clone', allowTemp: true, sameTree: true, scriptsCommit: () => ({ sha: toy.main }) });
    assert.strictEqual(other.ok, false);
    assert.match(other.reason, /el árbol de los guiones \([0-9a-f]{10}\) no es el commit que se ensaya \([0-9a-f]{10}\)/);
    assert.ok(!fs.existsSync(path.join(base, 'lab2')) && !fs.existsSync(path.join(base, 'out2')), 'ni el laboratorio ni el reporte');
    // sin poder leer el commit de los guiones: tampoco (no saber no es «coinciden»)
    const blind = rehearse.initLab({ lab: path.join(base, 'lab3'), out: path.join(base, 'out3'), sources: src, scenario: 'no-clone', allowTemp: true, sameTree: true, scriptsCommit: () => ({ problem: 'git no contestó' }) });
    assert.match(blind.reason, /no pude leer el commit del árbol de los guiones: git no contestó/);
    // sin la opción, nada de esto se mira (la fuente de siempre mide un commit con los guiones de otra rama, a propósito)
    assert.ok(rehearse.initLab({ lab: path.join(base, 'lab4'), out: path.join(base, 'out4'), sources: src, scenario: 'no-clone', allowTemp: true, scriptsCommit: () => ({ sha: toy.main }) }).ok);
    // por la línea de comandos, contra el árbol de verdad de esta prueba (que no es el juguete): frena y lo dice
    const cli = node([path.join(DIR, 'rehearse.js'), 'init', '--lab', path.join(base, 'lab5'), '--out', path.join(base, 'out5'), '--sources', src, '--scenario', 'no-clone', '--allow-temp', '--same-tree']);
    assert.strictEqual(cli.status, 2);
    assert.match(cli.stderr, /no pude ensayar: (el árbol de los guiones|no pude leer el commit del árbol de los guiones)/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ story 8.40 (AC 40 · T47) · el escenario `npx-published`: el paquete PUBLICADO, del registro y el GitHub reales ════

test('NpxPublished_Scenario_OwnStepFromRegistry_OutsideAll_WithItsCap', () => {
  // el escenario existe en la lista cerrada (sin eso, la 182 dice «escenario desconocido»), va aparte (como `npx`) y
  // corre su paso
  assert.deepStrictEqual(rehearse.SCENARIOS['npx-published'], ['inventory', 'npx-published']);
  assert.ok(rehearse.STEP_ORDER.includes('npx-published') && !rehearse.SCENARIOS.all.includes('npx-published'), 'va aparte: all no lo corre');
  const own = rehearse.OWN_STEPS['npx-published'];
  assert.ok(own, 'el paso tiene su sonda');
  // la misma sonda que `npx`, en su modo del registro
  assert.strictEqual(own.script, rehearse.OWN_STEPS.npx.script);
  assert.deepStrictEqual(own.args, ['--from', 'registry']);
  assert.ok(own.cap > 0 && own.cap <= 2400, `su tope (${own.cap} s) deja la corrida bajo 40 minutos`);
  assert.deepStrictEqual(own.pass, ['allow-temp']);
  // y `npx` sigue armando el paquete con npm pack, como antes
  assert.ok(!rehearse.OWN_STEPS.npx.args || !rehearse.OWN_STEPS.npx.args.includes('registry'));
});

test('NpxPublished_Classify_UpToDateIsGreen_NewVersionOrNoNetworkIsNotMeasured_OtherIsAFinding', () => {
  const AT = 'el arnés ya está en /x/.tycon/harness (versión 2026.10.17.3)';
  // la segunda corrida: «al día» y el árbol igual → bien
  assert.deepStrictEqual(npx.againVerdict({ exit: 0, out: `${AT}: está al día. No bajé nada (para dar de alta tu organización, --audience org).`, treeSame: true }), { ok: true });
  // «al día» pero el árbol cambió: bajó algo igual → hallazgo
  assert.match(npx.againVerdict({ exit: 0, out: `${AT}: está al día. No bajé nada.`, treeSame: false }).finding, /cambió/);
  // main se movió entre las dos corridas: no se pudo medir el «al día», y no es verde
  assert.match(npx.againVerdict({ exit: 0, out: `${AT}: hay una versión nueva (abc1234).\npara actualizarlo: node "x" update --yes. No bajé nada.`, treeSame: true }).notMeasured, /se movió/);
  // no pudo mirar la punta (sin red): tampoco
  assert.match(npx.againVerdict({ exit: 0, out: `${AT}; no pude mirar si hay una versión nueva (sin red o sin respuesta): para actualizarlo, x. No bajé nada.`, treeSame: true }).notMeasured, /no pudo mirar/);
  // cualquier otra cosa (reinstaló, salió 1, no dijo nada) → hallazgo con lo que dijo
  assert.match(npx.againVerdict({ exit: 1, out: 'tycon-harness: algo se rompió', treeSame: true }).finding, /salió 1.*algo se rompió/);
  assert.match(npx.againVerdict({ exit: 0, out: 'bajo TYCON-SA/tycon-harness (main abc1234) a una carpeta temporal', treeSame: false }).finding, /no dijo «al día»/);

  // la primera corrida que falla: por la red o por el límite de GitHub → no medido (con su motivo); lo demás, «rompe»
  for (const out of [
    'tycon-harness: sin red: no pude llegar a api.github.com (ENOTFOUND). No bajé nada.',
    'tycon-harness: GitHub limita las consultas sin permiso de esta conexión hasta las 02:13: probá de nuevo después de esa hora. No bajé nada.',
    'tycon-harness: GitHub contestó 503 al pedir la rama main de TYCON-SA/tycon-harness. No bajé nada.',
    'tycon-harness: no pude bajar el comprimido (GitHub contestó 502): no quedó nada',
    'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/@tyconsa%2fharness failed',
    'npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/@tyconsa%2fharness',
    'npm ERR! code ETIMEDOUT',
  ]) assert.strictEqual(npx.installFailureKind(out), 'not-measured', out);
  for (const out of [
    'tycon-harness: GitHub no muestra TYCON-SA/tycon-harness (404): sin permiso. No bajé nada.',
    'tycon-harness: la instalación salió 1: la comprobación de salud no pasó',
    '',
  ]) assert.strictEqual(npx.installFailureKind(out), 'breaks', out);

  // (pase adversarial del pedido 2, clases 1, 7, 8 y 12) la segunda etapa —el harness.js install del árbol bajado, que
  // imprime por la misma salida— y los topes del propio instalador también son la red, no el paquete
  for (const out of [
    'harness.js install: sin red: no pude hablar con la ref main (ECONNREFUSED)',
    'harness.js install: sin red: la API de GitHub no contestó dentro del tope (timeout)',
    'harness.js install: proxy sin respuesta: proxy.example:8080 no contestó en 15000 ms',
    'harness.js install: la ref main contestó 503',
    'harness.js install: el commit abc1234 contestó 502',
    'harness.js install: se acabó el tiempo: el tope de 60 s no alcanzó para la bajada (3 pedido(s) contestado(s); al último le quedaban 0 ms) — no es la red',
    'harness.js install: no pude verificar el certificado de la API de GitHub (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)',
    'tycon-harness: sin respuesta: api.github.com no contestó en 30 s. No bajé nada.',
    'tycon-harness: el proxy proxy.example:8080 no contestó en 30 s. No bajé nada.',
    'tycon-harness: no pude hablar con el proxy proxy.example:8080 (ECONNREFUSED). No bajé nada.',
    'npm error code ERR_SOCKET_TIMEOUT\nnpm error network Socket timeout',
  ]) assert.strictEqual(npx.installFailureKind(out), 'not-measured', out);
  // la que manda es la línea que explica la falla (la última del instalador), no una nota de red de antes
  assert.strictEqual(npx.installFailureKind('skills de terceros: sin red: las repone harness.js update\ntycon-harness: la instalación salió 1: la comprobación de salud no pasó'), 'breaks');
  assert.strictEqual(npx.installFailureKind('harness.js install: sin red: no pude hablar con la ref main (ECONNRESET)\ntycon-harness: harness.js install salió 2'), 'not-measured');
  // la corrida que cortó el tope de la sonda: no se sabe si es la red o el paquete, y no es verde
  assert.strictEqual(npx.installFailureKind('tycon-harness: bajo TYCON-SA/tycon-harness (main abc1234) a una carpeta temporal', { timedOut: true }), 'not-measured');

  // la segunda corrida (clases 4 y 9): la red o el registro caído también ahí es «no medido»; «no pude mirar» por una causa
  // que no es la red (404, la rama que no está, una respuesta que no es la de git) es un hallazgo
  assert.ok(npx.againVerdict({ exit: 1, out: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/@tyconsa%2fharness failed', treeSame: true }).notMeasured);
  assert.ok(npx.againVerdict({ exit: 1, out: 'npm error code E503\nnpm error 503 Service Unavailable', treeSame: true }).notMeasured);
  assert.ok(npx.againVerdict({ exit: null, out: '', treeSame: true, timedOut: true }).notMeasured);
  for (const why of ['GitHub contestó 404', 'la rama main no aparece en TYCON-SA/tycon-harness', 'la respuesta no es la de git (¿un proxy o un portal?)']) {
    assert.match(npx.againVerdict({ exit: 0, out: `${AT}; no pude mirar si hay una versión nueva (${why}): para actualizarlo, x. No bajé nada.`, treeSame: true }).finding || '', /no pudo mirar la punta/, why);
  }
  for (const why of ['GitHub contestó 503', 'sin red: no pude llegar a github.com (ENOTFOUND)']) {
    assert.ok(npx.againVerdict({ exit: 0, out: `${AT}; no pude mirar si hay una versión nueva (${why}): para actualizarlo, x. No bajé nada.`, treeSame: true }).notMeasured, why);
  }
  // «hay una versión nueva» con una salida que no es 0: no es la punta que se movió
  assert.ok(npx.againVerdict({ exit: 1, out: `${AT}: hay una versión nueva (abc1234).\nError: algo tiró`, treeSame: true }).finding);
  // (segunda vuelta de revisores) «hay una versión nueva» con el MISMO commit que quedó instalado: la comparación del
  // paquete está mal, no se movió nada; con otro commit, sí puede ser la punta que se movió
  const installed = 'abc1234' + '0'.repeat(33);
  assert.match(npx.againVerdict({ exit: 0, out: `${AT}: hay una versión nueva (abc1234).\npara actualizarlo: x. No bajé nada.`, treeSame: true, installedCommit: installed }).finding || '', /el mismo commit que quedó instalado/);
  assert.ok(npx.againVerdict({ exit: 0, out: `${AT}: hay una versión nueva (def5678).\npara actualizarlo: x. No bajé nada.`, treeSame: true, installedCommit: installed }).notMeasured);
  // un programa que ni arrancó (npm o npx que no está, sin tope vencido) no es ni la red ni el paquete: lo dice la sonda
  assert.strictEqual(npx.didNotStart({ exit: null, error: 'ENOENT', timed_out: false }), 'ENOENT');
  assert.strictEqual(npx.didNotStart({ exit: null, error: 'ETIMEDOUT', timed_out: true }), null);
  assert.strictEqual(npx.didNotStart({ exit: 1, error: null, timed_out: false }), null);
  // (tercera vuelta) el estado de una versión bajada sin su commit: el control de «la nueva es la instalada» no puede
  // correr, y eso es un hallazgo (el AC 35 compara contra ese commit), no un salteo callado
  assert.strictEqual(npx.installedCommitOf({ sources: [{ kind: 'release', commit: installed }] }), installed);
  for (const st of [{ sources: [{ kind: 'release' }] }, { sources: [{ kind: 'release', commit: 'abc' }] }, { sources: [] }, null]) assert.strictEqual(npx.installedCommitOf(st), '', JSON.stringify(st));
});

test('NpxPublished_RegistryAnswers404_IsAFinding_NotNotMeasured', { skip: !npx.npmProgram('npm') && `NO MEDIDO — este Node (${process.execPath}) no trae npm a su lado` }, async () => {
  // (pase adversarial del pedido 2, clase 13) el registro contesta, pero el paquete no está: eso no es la red
  const base = tmp('npx-404');
  // en otro proceso: la sonda llama a npm sin soltar este (spawnSync), y un servidor de acá nunca contestaría
  const server = require('child_process').spawn(process.execPath, ['-e', "const s = require('http').createServer((q, r) => { r.writeHead(404, { 'content-type': 'application/json' }); r.end('{\"error\":\"Not found\"}'); }); s.listen(0, '127.0.0.1', () => console.log(s.address().port));"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((resolve, reject) => { server.stdout.once('data', (b) => resolve(String(b).trim())); server.once('exit', () => reject(new Error('el registro de juguete no arrancó'))); });
    const lab = path.join(base, 'lab');
    fs.mkdirSync(lab); fs.writeFileSync(path.join(lab, L.LAB_MARK), '{}\n');
    const rec = L.recorder('npx-published', path.join(base, 'out'));
    const r = npx.measure({ lab, from: 'registry', allowTemp: true, rec, baseEnv: Object.assign({}, process.env, { npm_config_registry: `http://127.0.0.1:${port}/`, npm_config_fetch_retries: '0' }) });
    assert.strictEqual(r.status, L.STATUS.measured, JSON.stringify(r));
    assert.deepStrictEqual(rec.step.findings.map((f) => [f.id, f.severity]), [['npx-published:not-published', 'breaks']]);
    assert.ok(!fs.existsSync(path.join(lab, 'npx-published', 'users', 'lab-npx-published', '.tycon', 'harness')), 'no instaló nada');
  } finally { server.kill(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('NpxPublished_ProfileKept_TheAskedProfileIsChosen_ElseAFinding', () => {
  // la línea pide --profile minimal: el doctor tiene que decir minimal y elegido (antes del arreglo del pedido 2 quedaba
  // full, «perfil sin elegir»)
  assert.strictEqual(npx.profileProblem({ profile: { value: 'minimal', origin: 'maquina', chosen: true } }, 'minimal'), null);
  assert.match(npx.profileProblem({ profile: { value: 'full', origin: 'sin-valor', chosen: false } }, 'minimal'), /pidió minimal y quedó full \(sin-valor, sin elegir\)/);
  assert.match(npx.profileProblem({ profile: { value: 'full', origin: 'maquina', chosen: true } }, 'minimal'), /pidió minimal y quedó full/);
  // minimal elegido por otro lado (una variable heredada, el perfil del equipo) no prueba que --profile se escribió
  assert.match(npx.profileProblem({ profile: { value: 'minimal', origin: 'env', chosen: true } }, 'minimal'), /no lo eligió la máquina \(env\)/);
  assert.match(npx.profileProblem({}, 'minimal'), /no dice el perfil/);
  assert.match(npx.profileProblem(null, 'minimal'), /no dice el perfil/);
});

test('NpxPublished_Env_RealRegistryAndGitHub_NoToyServers_CacheInTheLab', () => {
  const base = tmp('npx-env');
  try {
    const home = path.join(base, 'users', 'lab-npx-published');
    const env = npx.registryEnv(home, { lab: base, base: { PATH: process.env.PATH, TYCON_RELEASE_API: 'http://127.0.0.1:1', TYCON_RELEASE_GIT: 'http://127.0.0.1:2', TYCON_RELEASE_ARCHIVE: 'http://127.0.0.1:3', TYCON_RELEASE_RAW: 'http://127.0.0.1:4', tycon_release_links: 'x', TYCON_HOME: '/otra/casa', TYCON_GUIDES_DIR: '/otro/arnes', TYCON_SKILLS_DIR: '/otras/skills', TYCON_INSTALL_PROFILE: 'minimal', TYCON_PROFILE: '/un/perfil.json', npm_config_cache: '/la/de/fabrica' } });
    // contra el GitHub real: ninguna variable del GitHub de juguete pasa, aunque quien lo corre la tenga puesta (en
    // Windows sin distinguir mayúsculas); tampoco las que mandan el arnés a otra casa o eligen el perfil por su cuenta
    // (pase adversarial del pedido 2, clase 3)
    for (const k of ['TYCON_RELEASE_API', 'TYCON_RELEASE_GIT', 'TYCON_RELEASE_ARCHIVE', 'TYCON_RELEASE_RAW', 'tycon_release_links', 'TYCON_HOME', 'TYCON_GUIDES_DIR', 'TYCON_SKILLS_DIR', 'TYCON_INSTALL_PROFILE', 'TYCON_PROFILE']) assert.ok(!(k in env), `${k} no llega a la medición`);
    // la caché de npm en el laboratorio (la de fábrica, en Windows, vive fuera de la HOME de juguete)
    assert.strictEqual(env.npm_config_cache, path.join(base, 'npx-published', 'npm-cache'));
    assert.strictEqual(env.HOME, home);
    assert.strictEqual(env.TYCON_UPDATE_APPLY, 'auto');
    assert.strictEqual(env.TYCON_NO_NIGHTLY_EXAM, '1');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// el Node propio del arnés (~/.tycon/node) viene sin npm: con él delante en el PATH esta prueba no se puede medir
test('NpxPublished_Offline_NotMeasured_NeverGreen_NothingInstalled', { skip: !npx.npmProgram('npm') && `NO MEDIDO — este Node (${process.execPath}) no trae npm a su lado` }, async () => {
  const base = tmp('npx-offline');
  try {
    const lab = path.join(base, 'lab');
    fs.mkdirSync(lab); fs.writeFileSync(path.join(lab, L.LAB_MARK), '{}\n');
    // un registro que no contesta: un puerto que se abrió y se cerró
    const port = await new Promise((resolve) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const rec = L.recorder('npx-published', path.join(base, 'out'));
    const r = npx.measure({ lab, from: 'registry', allowTemp: true, rec, baseEnv: Object.assign({}, process.env, { npm_config_registry: `http://127.0.0.1:${port}/`, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '5000' }) });
    assert.strictEqual(r.status, L.STATUS.notMeasured, JSON.stringify(r));
    assert.match(r.reason, /no medido|registro/);
    assert.deepStrictEqual(rec.step.findings, [], 'sin red no hay hallazgos: no se midió');
    assert.ok(!fs.existsSync(path.join(lab, 'npx-published', 'users', 'lab-npx-published', '.tycon', 'harness')), 'no instaló nada');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('NpxProbe_From_UnknownValue_Exit2_WritesNothing', () => {
  const base = tmp('npx-from');
  try {
    const lab = path.join(base, 'lab');
    fs.mkdirSync(lab); fs.writeFileSync(path.join(lab, L.LAB_MARK), '{}\n');
    const out = path.join(base, 'out');
    const r = node([path.join(DIR, 'npx-probe.js'), '--lab', lab, '--out', out, '--from', 'mirror', '--allow-temp']);
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /--from es pack o registry/);
    assert.ok(!fs.existsSync(out), 'no escribió el reporte');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
