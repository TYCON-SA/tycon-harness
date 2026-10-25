'use strict';
/**
 * how-it-works.js — el recorrido de una historia, armado con las fuentes con que corre el arnés.
 *
 * Lo usa la pestaña «Cómo trabaja» del sitio de la organización. Nada de acá es una lista copiada: los pasos salen de
 * lib/steps.js y del archivo de cada paso (su línea **Objetivo** y las guías que cita); los revisores del núcleo, de la
 * tabla declarada de pipeline.js (CORE_REVIEWERS, que una prueba ata a computeAdvisorSet); los de los paquetes, de sus
 * manifiestos, leídos con el validador del pipeline; los controles, de scripts/setup/hooks-list.json y de la tabla de
 * los despachadores (dispatch.js), y los frenos del cierre de cada paso, de STEP_CLOSE_CHECKS de lib/steps.js; lo que se suma según la historia, de STORY_CONDITIONALS, cuyas filas nombran la
 * función del arnés que decide cada pieza; lo de la organización, de los lectores de configuración del arnés aplicados
 * al clon de su perfil, nunca a la máquina donde corre el sitio.
 *
 * Las claves de texto (`whenKey`, `textKey`) apuntan a scripts/site/texts.js: acá no hay texto de pantalla.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// el código que lee (los lectores, el validador de paquetes, el cálculo de revisores) es el del árbol donde vive este
// archivo; `treeDir` sólo dice de dónde salen los datos (la tabla de pasos, sus archivos, la lista de controles)
const CODE = path.join(__dirname, '..', '..', '..', '..');
const STEPS_FILE = path.join('skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js');
const STEPS_DIR = path.join('skills', 'tycon-pipeline', 'steps');
const PIPELINE_SCRIPTS = path.join('skills', 'tycon-pipeline', 'scripts');
const HOOKS_LIST = path.join('scripts', 'setup', 'hooks-list.json');
const EFFECTS = ['blocks', 'warns', 'records'];
const EFFECT_RANK = { records: 0, warns: 1, blocks: 2 };
// una salida que niega la acción: la decisión de un hook (deny/block), un código de salida 2 o el `{ block }` de un hijo
// de los despachadores
const DENY_RX = /permissionDecision|['"]deny['"]|exit\(2\)|exitCode|\bexit 2\b|decision:\s*['"]block['"]|"decision":\s*"block"|\bblock:\s|\breturn 2\b/;
// Las piezas de una integración de la organización, cada una en el paso de la pantalla que la lleva: id estable, paso,
// integración (la clave del lector de configuración), clave del texto y archivo del árbol. Los textos dicen qué hace sin
// nombrar el servicio, así que cambiar de servicio es cambiar la integración de una fila. El aviso de trabajo y el pedido
// en ADO son piezas de «Arranque»; el cierre del pedido y de las horas, de «Cerrar la historia».
// Las integraciones que un repo puede prender por su cuenta aunque la organización no las tenga (ADO, con su
// .tycon/ado-config.yaml): apagadas en la organización no se esconden, porque en algún repo pueden correr.
const PER_REPO_INTEGRATIONS = Object.freeze(['ado']);
function stepFile(archivo) { return `${STEPS_DIR.split(path.sep).join('/')}/${archivo}`; }
const INTEGRATION_PIECES = Object.freeze([
  // las dos de horas son de la herramienta que elija la organización (`timeTool`): el núcleo no las ata a ninguna
  // `anchor`: el título del archivo al que salta el enlace, como lo arma GitHub
  { id: 'timeTrackingStart', step: 'start', integration: null, timeTool: true, textKey: 'piezaOrg.registroDeHorasAbre', code: stepFile('step-01-start.md'), anchor: 'parte-opcional-el-aviso-de-trabajo' },
  { id: 'workItemActive', step: 'start', integration: 'ado', textKey: 'piezaOrg.pedidoDeTrabajoActivo', code: stepFile('step-01-start.md'), anchor: 'parte-opcional-el-pedido-de-trabajo' },
  { id: 'workItemClose', step: 'close-work-item', integration: 'ado', textKey: 'piezaOrg.pedidoDeTrabajoCierra', code: stepFile('close-work-item.md') },
  { id: 'timeTrackingClose', step: 'close-work-item', integration: null, timeTool: true, textKey: 'piezaOrg.registroDeHorasCierra', code: stepFile('close-work-item.md') },
].map(Object.freeze));

const rel = (p) => p.split(path.sep).join('/');
const leer = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const unique = (xs) => [...new Set(xs)];

// ── los pasos ──

/**
 * Las guías del árbol por su nombre de archivo (`definition-of-done.md` → `guides/definition-of-done.md`). Una carpeta
 * que no se pudo leer (salvo que no exista) se anota en `problems`: sus guías no se reconocerían, y eso se dice.
 */
function guidesByName(treeDir, problems = []) {
  const out = new Map();
  const recorrer = (rel) => {
    let entradas = [];
    try { entradas = fs.readdirSync(path.join(treeDir, rel), { withFileTypes: true }); } catch (e) {
      if (e && e.code !== 'ENOENT') problems.push(`${rel} no se pudo leer (${e.code}): las guías citadas por su nombre ahí no se reconocen`);
      return;
    }
    for (const e of entradas) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) recorrer(r);
      else if (e.name.endsWith('.md') && !out.has(e.name)) out.set(e.name, r);
    }
  };
  if (treeDir) recorrer('guides');
  return out;
}

/**
 * Las guías que cita el texto de un paso, en el orden en que aparecen: `guides/….md` (también bajo
 * `~/.claude/tycon-harness/`), `story-format.md` y una guía nombrada sola (`test-execution-discipline.md`), que se
 * reconoce si existe con ese nombre bajo `guides/` del árbol.
 */
function citedGuides(text, treeDir = null, porNombreDado = null) {
  const t = String(text || '');
  const porNombre = porNombreDado || guidesByName(treeDir);
  const out = [];
  for (const m of t.matchAll(/([\w./~-]*[\w-]\.md)\b/g)) {
    const antes = t.slice(Math.max(0, m.index - 40), m.index);
    if (/[\w-]$/.test(antes)) continue;
    const ruta = m[1];
    const enGuides = /(?:^|\/)(guides\/[\w./-]*[\w-]\.md)$/.exec(ruta);
    if (/(^|\/)packs\/[\w-]+\//.test(ruta)) continue;   // la guía de un paquete no es del núcleo
    if (enGuides && !/(^|[^\w.-])(skills|scripts)\//.test(ruta)) out.push(enGuides[1]);
    else if (ruta === 'story-format.md') out.push(ruta);
    else if (!ruta.includes('/') && porNombre.has(ruta)) out.push(porNombre.get(ruta));
  }
  return unique(out);
}

/** Los pasos de la tabla del árbol, en su orden: id, nombre, si van en el recorrido, archivo, objetivo y guías. */
function readSteps(treeDir) {
  treeDir = path.resolve(treeDir);
  const { STEPS, CLOSE_STEP } = require(path.join(treeDir, STEPS_FILE));
  // las guías por nombre, una sola vez; lo que no se pudo leer de guides/ va con el primer paso (se muestra una vez)
  const problemasDeGuias = [];
  const porNombre = guidesByName(treeDir, problemasDeGuias);
  // el cierre en ADO corre aparte, después del merge: va al final y fuera del recorrido
  return [...STEPS, ...(CLOSE_STEP ? [CLOSE_STEP] : [])].map((s, i) => {
    const archivo = rel(path.join(STEPS_DIR, s.file));
    const leido = leer(path.join(treeDir, STEPS_DIR, s.file));
    // un archivo de paso que no se pudo leer no es «un paso sin objetivo ni guías»: se dice
    const problems = [...(i === 0 ? problemasDeGuias : []), ...(leido === null ? [`${archivo} no se pudo leer: su objetivo y sus guías faltan`] : [])];
    const texto = leido || '';
    const objetivo = /^\*\*Objetivo\*\*:\s*(.+)$/m.exec(texto);
    return { id: s.id, name: s.name, inSequence: s !== CLOSE_STEP, file: s.file, goal: objetivo ? objetivo[1].trim() : null, guides: [archivo, ...citedGuides(texto, treeDir, porNombre).filter((g) => g !== archivo)], problems };
  });
}

// ── los controles ──

/** La ruta del guion de un registro de la lista: `@tcg:x` es scripts/hooks/x, `@int:<n>/x` integrations/<n>/x; si no, skills/. */
function scriptOf(spec) {
  if (spec.startsWith('@tcg:')) return `scripts/hooks/${spec.slice(5)}`;
  if (spec.startsWith('@int:')) return `integrations/${spec.slice(5)}`;
  return `skills/${spec}`;
}
// la integración de la que depende un control: una llave (`integration:<llave>`) o la herramienta de horas (`time:<n>`)
const integrationOf = (when) => {
  const m = typeof when === 'string' ? /^(?:integration|time):([a-z0-9-]+)$/.exec(when) : null;
  return m ? m[1] : null;
};
/**
 * Los hooks (lado Claude Code) y las entradas del despachador de las integraciones del árbol, de sus manifiestos.
 * `problems`: un manifiesto roto o la biblioteca que no carga (sin ella, sólo se calla si el árbol no la trae).
 */
function integrationPieces(treeDir) {
  const lib = path.join(treeDir, 'scripts', 'lib', 'integrations.js');
  try {
    const INT = require(lib);
    const listing = INT.listManifests({ dir: path.join(treeDir, 'integrations') });
    const manifests = listing.manifests;
    const timeKinds = new Set(manifests.filter((m) => m.kind === 'timeTracking').map((m) => m.name));
    return {
      // el nombre para mostrar de cada herramienta de horas, del campo `label` de su manifiesto
      timeLabels: Object.fromEntries(manifests.filter((m) => m.kind === 'timeTracking').map((m) => [m.name, m.label])),
      // cada hook con qué hace, de su manifiesto (`control`): lo que muestra «Cómo trabaja», sin nombrar la herramienta.
      // Uno sin `control` muestra su `label` y queda dicho en `problems`: los textos del sitio no traen los de las integraciones
      hooks: manifests.flatMap((m) => INT.hookEntries(m, { tool: 'claude' }).map((e) => {
        const h = m.hooks.find((x) => `${INT.INT_PREFIX}${m.name}/${x.script}` === e.spec && x.event === e.event);
        return Object.assign(e, { control: (h && h.control) || { es: e.label, en: e.label }, controlMissing: !(h && h.control) });
      })),
      dispatch: (mode) => manifests.flatMap((m) => INT.dispatchEntries(m, mode).map((d) => Object.assign(d, { timeTool: timeKinds.has(m.name), control: d.control || { es: d.name, en: d.name }, controlMissing: !d.control }))),
      problems: listing.problems.map((b) => ({ spec: `integrations/${b.name}`, message: `el manifiesto está roto (${b.reasons.join('; ')}): sus controles no se muestran` })),
    };
  } catch (e) {
    const problems = fs.existsSync(lib) ? [{ spec: 'scripts/lib/integrations.js', message: `no se pudo cargar (${e.code || e.message}): los controles de las integraciones no se muestran` }] : [];
    return { timeLabels: {}, hooks: [], dispatch: () => [], problems };
  }
}
// un control que hay que prender a mano (`optin:<VARIABLE>` con `default: off`): no corre salvo que alguien lo prenda
const optionalOf = (h) => (typeof h.when === 'string' && h.when.startsWith('optin:') && h.default === 'off' ? h.when.slice('optin:'.length) : null);

/**
 * Los controles del árbol: los de la lista y, en lugar de cada despachador, los hijos de su cadena. Cada uno con
 * `{ spec, script, event, steps, effect, integration, dispatcher }`. `problems`: lo que no se pudo leer.
 */
function readControls(treeDir) {
  treeDir = path.resolve(treeDir);
  const problems = [];
  let lista = [];
  try { lista = JSON.parse(fs.readFileSync(path.join(treeDir, HOOKS_LIST), 'utf8')).hooks || []; } catch (e) { problems.push({ spec: HOOKS_LIST, message: `no se pudo leer (${e.code || e.message})` }); }
  let chains = {};
  try { chains = require(path.join(treeDir, PIPELINE_SCRIPTS, 'dispatch.js')).CHAINS || {}; } catch (e) { problems.push({ spec: 'dispatch.js', message: `no se pudo leer (${e.code || e.message})` }); }
  // las integraciones: sus hooks se suman a la lista, y sus entradas del despachador van delante de cada cadena
  const ints = integrationPieces(treeDir);
  problems.push(...ints.problems);
  lista = lista.concat(ints.hooks);
  const withInts = {};
  for (const [mode, chain] of Object.entries(chains)) withInts[mode] = ints.dispatch(mode).concat(chain);
  chains = withInts;
  const controls = [];
  for (const h of lista) {
    const script = scriptOf(h.spec);
    const texto = leer(path.join(treeDir, script));
    // sin poder leer el guion no se sabe si es un despachador: se dice, y se muestra como control suelto
    if (texto === null) problems.push({ spec: h.spec, message: `su guion (${script}) no se pudo leer` });
    const cadena = /dispatch\('([\w-]+)'\)/.exec(texto || '');
    // un despachador que nombra una cadena que dispatch.js no tiene: sus controles no se pueden mostrar, y se dice
    if (cadena && !chains[cadena[1]]) problems.push({ spec: h.spec, message: `despacha la cadena «${cadena[1]}», que dispatch.js no tiene` });
    if (cadena && chains[cadena[1]]) {
      for (const c of chains[cadena[1]]) {
        controls.push({ spec: c.name, script: rel(path.relative(treeDir, c.path)), event: h.event, steps: c.steps, effect: c.effect, integration: c.integration || null, optional: null, viaDispatcher: h.spec, timeTool: Boolean(c.timeTool), control: c.control || null });
        if (c.controlMissing) problems.push({ spec: c.name, message: 'su manifiesto no dice qué hace el control («control», en castellano y en inglés): se muestra su nombre' });
      }
      continue;
    }
    controls.push({ spec: h.spec, script, event: h.event, steps: h.steps, effect: h.effect, integration: integrationOf(h.when), optional: optionalOf(h), viaDispatcher: null, timeTool: String(h.when || '').startsWith('time:'), control: h.control || null });
    if (h.controlMissing) problems.push({ spec: h.spec, message: 'su manifiesto no dice qué hace el control («control», en castellano y en inglés): se muestra su «label»' });
  }
  return { controls, problems, timeLabels: ints.timeLabels };
}

/** Lo que frena la prueba: un control sin pasos o efecto, un paso que no existe, un «frena» sin salida que niega. */
function controlProblems(treeDir) {
  treeDir = path.resolve(treeDir);
  const ids = new Set(readSteps(treeDir).map((s) => s.id));
  const { controls, problems } = readControls(treeDir);
  const out = [...problems];
  for (const c of controls) {
    if (!Array.isArray(c.steps) || !c.steps.length) { out.push({ spec: c.spec, message: 'no declara en qué pasos actúa (steps)' }); continue; }
    const raros = c.steps.filter((s) => s !== 'all' && !ids.has(s));
    if (raros.length) out.push({ spec: c.spec, message: `pasos que no existen: ${raros.join(', ')}` });
    if (!EFFECTS.includes(c.effect)) out.push({ spec: c.spec, message: `effect «${c.effect}» fuera del vocabulario (${EFFECTS.join(', ')})` });
    else if (c.effect === 'blocks') {
      const guion = leer(path.join(treeDir, c.script));
      if (guion === null) out.push({ spec: c.spec, message: `dice que frena y su guion (${c.script}) no se pudo leer` });
      else if (!DENY_RX.test(guion)) out.push({ spec: c.spec, message: `dice que frena y su guion (${c.script}) no tiene una salida que niegue` });
    }
  }
  return out;
}

// ── lo que se suma según la historia ──

const STORY_PANTALLA = (archivo) => `---\nstory: "9.9"\nstatus: in-progress\nfiles_to_modify:\n  - ${archivo}\n---\n\n# Story 9.9\n\n## Acceptance Criteria\n\n1. algo\n`;
const PROBE_SCREEN = { story: STORY_PANTALLA('src/components/Pantalla.tsx') };
const PROBE_NO_SCREEN = { story: STORY_PANTALLA('scripts/lib/calculo.js') };
const conStory = (fn) => (mod, probe, ctx) => fn(mod, ctx.story, ctx.content, ctx.repo, probe);

/**
 * Una fila por pieza que se suma según la historia: id estable, pasos, código y guía (rutas del árbol), la clave del
 * texto de la condición (`textKey`; el de la pieza es `<textKey>.pieza`), la función del arnés que la decide
 * (`decider`: módulo del árbol y nombre exportado) y cómo se la llama (`decide`). `probes`: una historia que la dispara
 * (`yes`) y una que no (`no`). checkConditionals las corre por la función real.
 */
const STORY_CONDITIONALS = Object.freeze([
  { id: 'adoWorkItem', steps: ['start'], code: 'skills/tycon-pipeline/steps/step-01-start.md', anchor: 'parte-opcional-el-pedido-de-trabajo', guide: 'guides/integrations/ado-projects.md', textKey: 'segun.pedidoAdo',
    decider: { module: 'skills/tycon-pipeline/scripts/pipeline.js', fn: 'parseFrontmatterPipeline' },
    decide: conStory((fn, story, content) => Boolean(require(path.join(CODE, 'scripts', 'lib', 'platform', 'work-item-field.js')).idOf(fn(content)))),
    probes: { yes: { story: '---\nstory: "9.9"\nwork_item: 1234\n---\n' }, no: { story: '---\nstory: "9.9"\n---\n' } } },
  { id: 'mockup', steps: ['plan'], code: 'skills/tycon-pipeline/scripts/mockup.js', guide: 'skills/tycon-pipeline/steps/step-04-approve-plan.md', textKey: 'segun.pantalla',
    decider: { module: 'skills/tycon-pipeline/scripts/mockup.js', fn: 'screenStory' },
    decide: conStory((fn, story) => fn(story).screen === true), probes: { yes: PROBE_SCREEN, no: PROBE_NO_SCREEN } },
  { id: 'mockupApproval', steps: ['approve-plan'], code: 'skills/tycon-pipeline/scripts/mockup.js', guide: 'skills/tycon-pipeline/steps/step-04-approve-plan.md', textKey: 'segun.pantallaAprobar',
    decider: { module: 'skills/tycon-pipeline/scripts/mockup.js', fn: 'screenStory' },
    decide: conStory((fn, story) => fn(story).screen === true), probes: { yes: PROBE_SCREEN, no: PROBE_NO_SCREEN } },
  { id: 'runSize', steps: ['implement'], code: 'skills/tycon-pipeline/scripts/lib/run-size.js', guide: 'skills/tycon-pipeline/steps/step-05-implement.md', textKey: 'segun.liviana',
    decider: { module: 'skills/tycon-pipeline/scripts/lib/run-size.js', fn: 'classifyStory' },
    decide: (fn, probe) => fn({ files: probe.files }).size === 'liviana',
    probes: { yes: { files: ['docs/guia.md'] }, no: { files: ['src/a.js'] } } },
  { id: 'adversarial', steps: ['adversarial-pass'], code: 'skills/tycon-pipeline/scripts/pipeline.js', guide: 'skills/tycon-pipeline/steps/step-08-adversarial-pass.md', textKey: 'segun.adversarial',
    decider: { module: 'skills/tycon-pipeline/scripts/pipeline.js', fn: 'computeDeepReviewGate' },
    decide: (fn, probe, ctx) => fn({ story: ctx.story, repo: ctx.repo, files: probe.files }).run === true,
    probes: { yes: { story: STORY_PANTALLA('src/auth/sesion.js'), files: ['src/auth/sesion.js'] }, no: { story: STORY_PANTALLA('docs/guia.md'), files: ['docs/guia.md'] } } },
  { id: 'liveTest', steps: ['live-check'], code: 'skills/tycon-pipeline/scripts/runtime-matrix.js', guide: 'guides/definition-of-done.md', textKey: 'segun.enVivo',
    decider: { module: 'skills/tycon-pipeline/scripts/pipeline.js', fn: 'storyRequiresRuntimeEvidenceCheck' },
    decide: conStory((fn, story, content) => fn(content) === true),
    probes: { yes: { story: '---\nstory: "9.9"\n---\n\n### Tests\n\n| # | Nombre | AC | Nivel |\n|---|---|---|---|\n| T1 | `Vivo` | 1 | e2e |\n\nVer tests/e2e/vivo.spec.ts\n' }, no: { story: '---\nstory: "9.9"\n---\n\nSólo documentación.\n' } } },
  { id: 'browserTest', steps: ['live-check'], code: 'skills/tycon-pipeline/scripts/runtime-matrix.js', guide: 'skills/tycon-pipeline/steps/step-10-live-check.md', textKey: 'segun.pantallaNavegador',
    decider: { module: 'skills/tycon-pipeline/scripts/lib/ui-signal.js', fn: 'storyTouchesUi' },
    decide: conStory((fn, story, content, repo) => fn(content, repo) === true), probes: { yes: PROBE_SCREEN, no: PROBE_NO_SCREEN } },
  { id: 'testerGuide', steps: ['live-check'], code: 'skills/tycon-pipeline/scripts/qa-guide.js', guide: 'skills/tycon-pipeline/steps/step-10-live-check.md', textKey: 'segun.aMano',
    decider: { module: 'skills/tycon-pipeline/scripts/lib/atdd-commit-gate.js', fn: 'storyIsHandOperable' },
    decide: conStory((fn, story, content, repo) => fn(content, repo) === true), probes: { yes: PROBE_SCREEN, no: PROBE_NO_SCREEN } },
  { id: 'screenReadability', steps: ['live-check'], code: 'skills/tycon-pipeline/scripts/qa-guide.js', guide: 'skills/tycon-pipeline/steps/step-10-live-check.md', textKey: 'segun.pantallaLegible',
    decider: { module: 'skills/tycon-pipeline/scripts/qa-guide.js', fn: 'isUiStory' },
    decide: conStory((fn, story, content, repo) => fn(content, (/^---\r?\n([\s\S]*?)\r?\n---/.exec(content) || [])[1] || '', repo) === true), probes: { yes: PROBE_SCREEN, no: PROBE_NO_SCREEN } },
  { id: 'sqlCompile', steps: ['prepare-commit'], code: 'scripts/ci/sql-compile.js', guide: 'guides/definition-of-done.md', textKey: 'segun.sql',
    decider: { module: 'scripts/ci/sql-compile.js', fn: 'isMigration' },
    decide: (fn, probe) => probe.files.some((f) => fn(f)),
    probes: { yes: { files: ['database/014_cobros.sql'] }, no: { files: ['src/a.js', 'docs/consultas.sql'] } } },
]);

/** Corre la función que decide una fila con una historia de juguete; devuelve true/false o tira. */
function decideRow(row, probe, treeDir) {
  const mod = require(path.join(treeDir, row.decider.module));
  const fn = mod[row.decider.fn];
  if (typeof fn !== 'function') throw new Error(`${row.decider.module} no exporta ${row.decider.fn}`);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'how-it-works-'));
  try {
    fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
    let story = null; let content = '';
    if (probe.story) { story = path.join(repo, 'story.md'); content = probe.story; fs.writeFileSync(story, content); }
    for (const f of probe.files || []) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), 'x\n'); }
    return row.decide(fn, probe, { story, content, repo });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}

/** Las filas que no dicen lo que su función decide: `[{ id, message }]`, vacío si todas coinciden. */
function checkConditionals(table = STORY_CONDITIONALS, treeDir = path.join(__dirname, '..', '..', '..', '..')) {
  const out = [];
  for (const row of table) {
    try {
      if (decideRow(row, row.probes.yes, treeDir) !== true) out.push({ id: row.id, message: `${row.decider.fn} no dispara con la historia que la tiene que disparar` });
      if (decideRow(row, row.probes.no, treeDir) !== false) out.push({ id: row.id, message: `${row.decider.fn} dispara con la historia que no la tiene que disparar` });
    } catch (e) { out.push({ id: row.id, message: String(e.message || e).split('\n')[0] }); }
  }
  return out;
}

// ── la organización ──

/**
 * Lo de la organización, leído del clon de su perfil con los lectores del arnés del árbol: integraciones y `packs.default`
 * con tycon-config.js (el perfil del clon y un hogar vacío: nada de la máquina del sitio), las reglas con stack-config.js
 * sobre su team-repos.json. Sin clon, null.
 */
function readOrg({ treeDir, profileDir }) {
  if (!profileDir) return null;
  const TC = require(path.join(CODE, 'scripts', 'lib', 'tycon-config.js'));
  const SC = require(path.join(CODE, PIPELINE_SCRIPTS, 'lib', 'stack-config.js'));
  const perfil = ['team-profile.json', 'perfil-equipo.json'].map((f) => path.join(profileDir, f)).find((f) => fs.existsSync(f)) || path.join(profileDir, 'team-profile.json');
  const hogar = fs.mkdtempSync(path.join(os.tmpdir(), 'how-it-works-home-'));
  let integrations = {}; let packsDefault = null; let timeTracking = null; const problems = [];
  // sin el archivo del perfil, o sin poder leerlo, no se sabe qué integraciones tiene la organización (no «todas apagadas»)
  let integrationsKnown = false;
  try {
    const cfg = TC.cargar({ env: { TYCON_PROFILE: perfil }, home: hogar });
    integrations = TC.integraciones(cfg);
    // la herramienta de horas elegida (con la llave vieja leída): los controles de las otras no se muestran
    if (typeof TC.timeTracking === 'function') timeTracking = TC.timeTracking(cfg).value;
    // Telegram es de cada máquina (el perfil rechaza un chat): no es una integración de la organización
    delete integrations.telegram;
    // un error del archivo entero (sin clave: ilegible) es no haberlo leído; uno de una clave deja leído el resto
    integrationsKnown = fs.existsSync(perfil) && !(cfg.errores || []).some((e) => e.archivo === perfil && !e.clave);
    packsDefault = cfg.valores && cfg.valores.packs ? cfg.valores.packs.default : null;
    for (const e of cfg.errores || []) problems.push(`${e.clave || path.basename(e.archivo)}: ${e.motivo}`);
  } catch (e) { problems.push(`no se pudo leer la configuración (${String(e.message || e).split('\n')[0]})`); } finally { fs.rmSync(hogar, { recursive: true, force: true }); }
  const reglas = SC.orgRules({ file: path.join(profileDir, 'team-repos.json') });
  return { integrations, integrationsKnown, timeTracking, packsDefault, rules: reglas.rules, problems: [...problems, ...reglas.problems] };
}

// ── los paquetes ──

/** La carpeta de agentes que declara un paquete, si es segura (relativa, sin «..»); si no, null. */
function agentsFolderOf(json) {
  const a = json && typeof json.agents === 'string' && json.agents ? json.agents : 'agents';
  return !path.isAbsolute(a) && !a.includes('\\') && !a.split('/').some((s) => s === '..' || s === '') ? a : null;
}

/**
 * Dónde tiene que estar el `.md` de un revisor, relativo a la raíz del árbol o del perfil: la carpeta de agentes de su
 * paquete (la declarada, o `agents`). Es la única casa que acepta el validador.
 */
function agentFileOf({ pack, json, agent }) {
  return rel(path.join('packs', pack, agentsFolderOf(json) || 'agents', `${agent}.md`));
}

/** El texto con las rutas absolutas de estas carpetas pasadas a relativas: la pantalla no muestra rutas de la máquina. */
function withoutAbsolutePaths(texto, carpetas) {
  let t = String(texto);
  for (const c of carpetas.filter(Boolean).map((x) => path.resolve(x)).sort((a, b) => b.length - a.length)) t = t.split(`${c}${path.sep}`).join('').split(c).join('.');
  return t;
}

/**
 * Los paquetes de una carpeta `packs/`, con sus revisores y los errores del validador del pipeline. `origin`:
 * `harness` (los del árbol) u `organization` (los del perfil). `agentsDir`: la carpeta de agentes de respaldo con que
 * se valida, la de la raíz de donde vienen los paquetes (la del árbol, o la del perfil: la que el instalador copia al
 * árbol antes de validar). `yaDeclarados` (agente → { paquete, archivo }) es el mismo mapa que arma el cargador del
 * pipeline: se comparte entre las carpetas para que un revisor declarado en dos paquetes salga como problema, como
 * cuando el pipeline los carga. Los problemas salen sin repetir y sin rutas absolutas; los agentes que faltan, además,
 * en `missing` con dónde deberían estar, para que la pantalla los diga en llano.
 */
function readPacks({ treeDir, packsDir, origin, agentsDir = path.join(treeDir, 'agents'), yaDeclarados = new Map() }) {
  const baseDir = path.dirname(packsDir);
  const out = [];
  let nombres = [];
  try { nombres = fs.readdirSync(packsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch (e) {
    if (e && e.code !== 'ENOENT') out.push({ name: rel(path.basename(packsDir)), origin, reviewers: [], problems: [`la carpeta no se pudo leer (${e.code})`], missing: [] });
    return out;
  }
  const P = require(path.join(CODE, PIPELINE_SCRIPTS, 'lib', 'packs.js'));
  const PIPE = require(path.join(CODE, PIPELINE_SCRIPTS, 'pipeline.js'));
  for (const n of nombres) {
    const archivo = path.join(packsDir, n, 'pack.json');
    if (!fs.existsSync(archivo)) continue;
    let json = null; const problems = []; const missing = [];
    // el código del error o su tipo (SyntaxError), nunca el mensaje del parser: podría citar el contenido del archivo
    try { json = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) { problems.push(`pack.json no se pudo leer (${(e && (e.code || e.name)) || 'Error'})`); }
    if (json) {
      for (const e of P.validarManifiesto(json, { archivo, agentsDir, nucleo: PIPE.revisoresDelNucleo(), banderas: P.BANDERAS, yaDeclarados })) {
        const texto = `${e.revisor ? `${e.revisor}: ` : ''}${withoutAbsolutePaths(e.motivo, [baseDir, treeDir])}`;
        if (!problems.includes(texto)) problems.push(texto);
        if (e.revisor && /^no existe el agente /.test(e.motivo) && !missing.some((x) => x.agent === e.revisor)) {
          missing.push({ agent: e.revisor, expected: [agentFileOf({ pack: n, json, agent: e.revisor })] });
        }
      }
      for (const r of Array.isArray(json.reviewers) ? json.reviewers : []) {
        // la ruta del manifiesto, relativa: sale en el mensaje de un revisor repetido
        if (r && typeof r.agent === 'string' && !yaDeclarados.has(r.agent)) yaDeclarados.set(r.agent, { paquete: n, archivo: rel(path.join('packs', n, 'pack.json')) });
      }
    }
    const carpeta = agentsFolderOf(json);
    const reviewers = json && Array.isArray(json.reviewers) ? json.reviewers.filter((r) => r && typeof r === 'object' && typeof r.agent === 'string').map((r) => ({
      agent: r.agent, group: r.group, when: r.when || null, surface: r.surface || null, prefixes: r.prefixes || [],
      file: carpeta ? rel(path.join(n, carpeta, `${r.agent}.md`)) : rel(path.join(n, 'pack.json')),
      md: carpeta ? agentFileOf({ pack: n, json, agent: r.agent }) : null,
    })) : [];
    out.push({ name: n, origin, dir: path.join(packsDir, n), reviewers, problems, missing });
  }
  return out;
}

// ── el modelo ──

/**
 * El recorrido entero para la pantalla. `profileDir`: el clon del perfil (o null, con `profileState` y `profileReason`
 * diciendo por qué); `packsTreeDir`: de dónde salen los paquetes del árbol (por defecto, el árbol).
 */
function buildModel({ treeDir, profileDir = null, profileState = null, profileReason = null, packsTreeDir = null }) {
  treeDir = path.resolve(treeDir);
  const PIPE = require(path.join(CODE, PIPELINE_SCRIPTS, 'pipeline.js'));
  const org = readOrg({ treeDir, profileDir });
  // una integración que la organización tiene apagada: sus piezas y sus controles no se muestran. Sin perfil, o con el
  // perfil sin su archivo, no se sabe qué tiene, y se muestra todo
  const llaveApagada = (integration) => Boolean(org && org.integrationsKnown && integration && !PER_REPO_INTEGRATIONS.includes(integration) && org.integrations[integration] === false);
  // un control de una herramienta de horas: apagado si la organización eligió otra (o ninguna); sin perfil no se sabe, y
  // se muestra como los demás, «según tu organización»
  const horasDeOtra = (c) => Boolean(c && c.timeTool && org && org.integrationsKnown && typeof org.timeTracking === 'string' && org.timeTracking !== c.integration);
  // la de horas se decide sólo por la herramienta elegida: la llave vieja de la primera herramienta no la apaga, porque una
  // organización que la elige en `timeTracking` puede no tener esa llave
  const apagada = (x) => (x && typeof x === 'object' ? (x.timeTool ? horasDeOtra(x) : llaveApagada(x.integration)) : llaveApagada(x));
  // un mismo mapa para las dos carpetas: un revisor declarado en dos paquetes sale como problema, como en el pipeline
  const yaDeclarados = new Map();
  const packs = [
    ...readPacks({ treeDir, packsDir: path.join(packsTreeDir || treeDir, 'packs'), origin: 'harness', yaDeclarados }),
    ...(profileDir ? readPacks({ treeDir, packsDir: path.join(profileDir, 'packs'), origin: 'organization', agentsDir: path.join(profileDir, 'agents'), yaDeclarados }) : []),
  ];
  const instalados = unique(packs.filter((p) => !p.problems.length).map((p) => p.name)).sort();
  const v = org ? org.packsDefault : null;
  const activos = !org ? null : v === 'all' ? instalados : Array.isArray(v) ? instalados.filter((n) => v.includes(n)) : [];
  const { controls, problems: problemasDeControles, timeLabels = {} } = readControls(treeDir);
  // la herramienta de horas elegida, con su nombre: ninguna, una desconocida o una con el manifiesto roto apagan las
  // piezas de horas; sin perfil no se sabe, y se ven «según tu organización»
  const toolLabel = org && org.integrationsKnown && typeof org.timeTracking === 'string' ? (timeLabels[org.timeTracking] || null) : null;
  const piezaApagada = (f) => (f.timeTool ? Boolean(org && org.integrationsKnown && !toolLabel) : apagada(f.integration));
  // el validador de stories del paso «Validar la historia» sale del mismo cálculo que el pipeline (sin paquetes: sólo el núcleo)
  const validadores = (() => {
    const prev = process.env.TYCON_PACKS_DIR;
    const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'how-it-works-packs-'));
    process.env.TYCON_PACKS_DIR = vacio;
    const story = path.join(vacio, 'story.md');
    fs.writeFileSync(story, '---\nstory: "9.9"\n---\n\n# Story 9.9\n');
    // la vista muestra qué validadores hay, no archivos de una historia: sin consultar la lista de código deprecado
    try { return PIPE.computeValidadores({ story, repo: vacio, todos: true, deprecados: false }).validadores; } finally {
      if (prev === undefined) delete process.env.TYCON_PACKS_DIR; else process.env.TYCON_PACKS_DIR = prev;
      fs.rmSync(vacio, { recursive: true, force: true });
    }
  })();
  const pasos = readSteps(treeDir);
  // la tabla de frenos del cierre del árbol; uno anterior a ella no trae ni la tabla ni closeControlsByStep. Con el
  // esquema nuevo y la tabla ausente o mal formada, los pasos saldrían sin frenos: se dice
  const libPasos = require(path.join(treeDir, STEPS_FILE));
  const esquemaNuevo = libPasos.STEP_CLOSE_CHECKS !== undefined || typeof libPasos.closeControlsByStep === 'function';
  const problemasDelCierre = esquemaNuevo && !Array.isArray(libPasos.STEP_CLOSE_CHECKS)
    ? [`${rel(STEPS_FILE)}: STEP_CLOSE_CHECKS no es una lista: los frenos del cierre de cada paso no se muestran`] : [];
  // una fila que no es una fila, o que nombra un paso que no existe, no se mostraría en ningún lado: se dice y se sigue
  const idsDePasos = new Set(pasos.map((s) => s.id));
  const frenosDelCierre = (Array.isArray(libPasos.STEP_CLOSE_CHECKS) ? libPasos.STEP_CLOSE_CHECKS : []).filter((r, i) => {
    if (!r || typeof r !== 'object') {
      problemasDelCierre.push(`${rel(STEPS_FILE)}: STEP_CLOSE_CHECKS[${i}] no es una fila: ese freno del cierre no se muestra`);
      return false;
    }
    const ajenos = [r.shownIn, r.checkedIn].filter((id) => !idsDePasos.has(id));
    if (ajenos.length) {
      problemasDelCierre.push(`${rel(STEPS_FILE)}: STEP_CLOSE_CHECKS[${i}] (${r.key}) nombra un paso que no existe: ${ajenos.join(', ')}`);
      return false;
    }
    return true;
  });
  const steps = pasos.map((s) => {
    const core = (grupo) => (s.id === 'reviewers' ? PIPE.CORE_REVIEWERS.filter((r) => r.group === grupo).map((r) => ({ agent: r.agent, whenKey: r.whenKey, file: `agents/${r.agent}.md` })) : []);
    const grupos = s.id === 'validate-story' ? ['validacion'] : s.id === 'reviewers' ? ['base', 'condicional'] : [];
    const dePaquetes = packs.flatMap((p) => p.reviewers.filter((r) => grupos.includes(r.group)).map((r) => ({
      ...r, pack: p.name, origin: p.origin, active: activos === null ? null : activos.includes(p.name), editable: p.origin === 'organization' && !p.problems.length,
      // el uso que abre «Editar»: la solapa que revisa el cambio o la que valida la historia
      use: r.group === 'validacion' ? 'validacion' : 'cambio',
      // por qué no se edita un revisor de la organización: sólo con su paquete roto, con el primer problema
      notEditable: p.origin === 'organization' && p.problems.length ? { reason: 'broken', detail: p.problems[0] } : null,
    })));
    const bloque = {
      always: core('always'),
      story: s.id === 'validate-story' ? validadores.map((a) => ({ agent: a, whenKey: 'revisorCuando.hayHistoria', file: `agents/${a}.md` })) : core('story'),
      change: core('change'),
      packs: dePaquetes,
    };
    // los controles del paso: uno por guion, con el efecto más fuerte de sus registros
    const propios = new Map();
    for (const c of controls.filter((x) => Array.isArray(x.steps) && x.steps.includes(s.id) && !apagada(x))) {
      const ya = propios.get(c.spec);
      if (!ya || EFFECT_RANK[c.effect] > EFFECT_RANK[ya.effect]) propios.set(c.spec, c);
    }
    const declaradas = INTEGRATION_PIECES.filter((f) => f.step === s.id);
    return {
      ...s, reviewers: bloque, controls: [...propios.values()],
      orgPiecesDeclared: declaradas.length,
      orgPieces: declaradas.filter((f) => !piezaApagada(f)).map((f) => ({ id: f.id, integration: f.timeTool ? (toolLabel ? org.timeTracking : null) : f.integration, timeTool: Boolean(f.timeTool), textKey: f.textKey, code: f.code, anchor: f.anchor || null })),
      storyPieces: STORY_CONDITIONALS.filter((c) => c.steps.includes(s.id)).map((c) => ({ id: c.id, code: c.code, anchor: c.anchor || null, guide: c.guide, textKey: c.textKey })),
      // los frenos del cierre que este paso muestra (`checkedIn`: el paso cuyo cierre los revisa)
      closeChecks: frenosDelCierre.filter((r) => r.shownIn === s.id).map((r) => ({ key: r.key, checkedIn: r.checkedIn, textKey: r.textKey, gate: r.gate || null, code: rel(path.join(PIPELINE_SCRIPTS, 'marker.js')) })),
    };
  });
  const enTodo = new Map();
  for (const c of controls.filter((x) => Array.isArray(x.steps) && x.steps.includes('all') && !apagada(x))) {
    const ya = enTodo.get(c.spec);
    if (!ya || EFFECT_RANK[c.effect] > EFFECT_RANK[ya.effect]) enTodo.set(c.spec, c);
  }
  return {
    steps, allSteps: { controls: [...enTodo.values()] },
    // una herramienta de horas elegida que el árbol no trae (o con el manifiesto roto): sus piezas no se ven, y se dice por qué
    org: org ? { ...org, timeToolLabel: toolLabel, problems: [...org.problems, ...(org.integrationsKnown && typeof org.timeTracking === 'string' && org.timeTracking !== 'none' && !toolLabel ? [`integrations.timeTracking: «${org.timeTracking}» no es una herramienta de horas de este árbol (o su manifiesto está roto): sus piezas no se muestran`] : [])], packs: { installed: instalados, active: activos } } : null,
    profile: { state: profileDir ? 'leido' : (profileState || 'no_configurado'), reason: profileReason || null },
    packs: packs.map((p) => ({ name: p.name, origin: p.origin, problems: p.problems, missing: p.missing || [], reviewers: p.reviewers.map((r) => r.agent) })),
    // lo que no se pudo leer de las fuentes del arnés: la pantalla lo dice, no lo esconde detrás de un «no hay»
    problems: [...pasos.flatMap((s) => s.problems), ...problemasDelCierre, ...problemasDeControles.map((p) => `${p.spec}: ${p.message}`)],
  };
}

module.exports = { readSteps, citedGuides, readControls, controlProblems, STORY_CONDITIONALS, checkConditionals, readOrg, readPacks, agentsFolderOf, agentFileOf, withoutAbsolutePaths, buildModel, INTEGRATION_PIECES, PER_REPO_INTEGRATIONS, DENY_RX };
