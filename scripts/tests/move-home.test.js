'use strict';
// move-home.test.js — lo que el pase adversarial de la tanda D de la story 8.23 confirmó sobre la mudanza, como pruebas
// unitarias de scripts/setup/harness/move-home.js (sin red, sin instalar nada: un HOME de juguete por caso).
//
//   T28u · dropOldHooks: una carpeta del clon CON ESPACIO entre comillas se reconoce igual (clase 1); un hook del clon cuyo
//          guion la versión nueva no trae se SACA y se dice, no se re-apunta a un archivo inexistente (clase 5).
//   T28v · stageConfigMoved funde las secciones con su nombre viejo (los del mapa de renombres) con las de hoy sin
//          dejar las dos formas (clase 12); un tycon.json que es un ENLACE a otro archivo se funde igual (clase 9), y uno
//          que ya apunta a la configuración propia no cuenta como pendiente.
//   T28w · advance: una excepción adentro de una etapa vuelve como { ok: false } (quien llama deshace y anota failed), y la
//          copia de seguridad tomada en la carpeta vieja se sigue en memoria cuando el estado se muda (clases 2, 10, 14, 16).
//
//   T46  · la casa propia sale del CONTEXTO: con un ambiente sin TYCON_HOME, `places`, el diario, `undo` y
//          `classifyPersonal` miran `<home pedida>/.tycon`, nunca la de quien corre (2026-10-11: el `undo` de T42, con el
//          ambiente vacío, borró el arnés instalado de una máquina mudada).
//   T47  · nada de esta suite intentó escribir ni borrar en la casa real (scripts/tests/lib/real-home-guard.js, que
//          además lo frena). Va última.
//
// Uso: node --test scripts/tests/move-home.test.js
const GUARD = require('./lib/real-home-guard.js');   // primera línea que hace algo: frena y anota todo toque a la casa real
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MH = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'move-home.js'));
const TH = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));
// Los nombres viejos de sección (rutas, integraciones) los traduce el mapa de renombres, que es del equipo: la copia pública
// no lo trae, y ahí nadie tiene una configuración con nombres viejos. Sin el mapa, T28v funde con los nombres de hoy.
const WITH_MAP = fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'renames.json'));

const casa = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `move-home-${name}-`));
  // nunca dentro del repo del arnés ni de una HOME de verdad (el nombre del repo no se escribe: lo publicado dice «el arnés»)
  if (d.startsWith(ROOT) || /agent-skills|\.claude\/|\.tycon\//.test(d)) throw new Error(`el laboratorio cayó en ${d}`);
  return d;
};
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const cmds = (settings) => readJson(settings).hooks.SessionStart.flatMap((b) => b.hooks.map((h) => h.command));

test('T28u DropOldHooks_PathWithSpace_Recognized_MissingScriptDroppedNotRepointed', () => {
  const lab = casa('hooks');
  const clone = path.join(lab, 'Nombre Apellido', 'clon');
  const tree = path.join(lab, 'Nombre Apellido', 'tycon', 'harness');
  fs.mkdirSync(path.join(clone, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'scripts', 'hooks'), { recursive: true });
  for (const n of ['a.js', 'b.js']) fs.writeFileSync(path.join(tree, 'scripts', 'hooks', n), '');
  const settings = path.join(lab, 'settings.json');
  writeJson(settings, { hooks: { SessionStart: [{ hooks: [
    { type: 'command', command: `node "${clone}/scripts/hooks/a.js"` },          // ya reemplazado por el árbol nuevo: se saca
    { type: 'command', command: `node "${tree}/scripts/hooks/a.js"` },
    { type: 'command', command: `node "${clone}/scripts/hooks/b.js"` },          // sin reemplazo y el guion existe: se re-apunta
    { type: 'command', command: `node "${clone}/scripts/hooks/viejo.js"` },      // el árbol nuevo no lo trae: se saca y se dice
    { type: 'command', command: 'node "$HOME/.claude/.tycon-pipeline/harness/bootstrap.js"' },   // ajeno: queda
  ] }] } });
  const logs = [];
  const r = MH.dropOldHooks(settings, fs.realpathSync(clone), { newTree: tree, log: (l) => logs.push(l) });
  assert.equal(r.removed, 2, `sacados: ${JSON.stringify(r)}`);
  assert.equal(r.repointed, 1);
  assert.equal(r.dropped.length, 1);
  assert.deepEqual(r.kept, []);
  const after = cmds(settings);
  assert.deepEqual(after, [`node "${tree}/scripts/hooks/a.js"`, `node "${tree}/scripts/hooks/b.js"`, 'node "$HOME/.claude/.tycon-pipeline/harness/bootstrap.js"']);
  assert.ok(logs.some((l) => /viejo\.js/.test(l) && /NO trae/.test(l)), `el guion que la versión no trae se dice: ${logs.join(' | ')}`);
  // el mismo caso con comillas simples y sin comillas (sin espacio) también se reconoce
  const clone2 = path.join(lab, 'clon2'); fs.mkdirSync(path.join(clone2, 'scripts', 'hooks'), { recursive: true });
  writeJson(settings, { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node '${clone2}/scripts/hooks/a.js'` }, { type: 'command', command: `node ${clone2}/scripts/hooks/b.js` }] }] } });
  const r2 = MH.dropOldHooks(settings, fs.realpathSync(clone2), { newTree: tree });
  assert.equal(r2.repointed, 2, JSON.stringify(r2));
  assert.deepEqual(cmds(settings), [`node '${tree}/scripts/hooks/a.js'`, `node ${tree}/scripts/hooks/b.js`]);
});

test('T28v ConfigMerge_OldSectionNamesNormalized_LinkedConfigMergedUnlessAlreadyOwn', () => {
  const home = casa('config');
  const env = { TYCON_HOME: path.join(home, '.tycon') };
  const ctx = { home, env, platform: process.platform, opts: {} };
  const oldTree = path.join(home, 'clon'); fs.mkdirSync(oldTree, { recursive: true });
  const oldConfig = TH.legacyConfigFile(home);
  const newConfig = TH.ownPaths({ env }).config;
  // (a) nombres viejos de sección en la vieja, nuevos en la propia: una sola forma al final, y lo de la propia gana.
  // Sin el mapa de renombres (copia pública) la vieja usa los nombres de hoy: se mide la fusión, no la traducción
  writeJson(oldConfig, WITH_MAP
    ? { rutas: { repos: '/repos' }, integraciones: { clockify: true, engram: false }, install: { profile: 'full' } }
    : { paths: { repos: '/repos' }, integrations: { clockify: true, engram: false }, install: { profile: 'full' } });
  writeJson(newConfig, { paths: { maintained: '/clon' }, integrations: { engram: true }, github: { token: 'x' } });
  const log = () => {};
  // la etapa se llama con el diario mínimo que mira
  MH.__test.stageConfigMoved(ctx, { oldTree }, log);
  const merged = readJson(newConfig);
  assert.deepEqual(Object.keys(merged).sort(), ['github', 'install', 'integrations', 'paths']);
  assert.deepEqual(merged.paths, { repos: '/repos', maintained: '/clon' });
  assert.deepEqual(merged.integrations, { clockify: true, engram: true }, 'lo de la propia gana sobre la vieja, clave por clave');
  assert.equal(fs.lstatSync(oldConfig).isSymbolicLink(), true, 'la vieja queda como enlace');
  assert.equal(fs.realpathSync(oldConfig), fs.realpathSync(newConfig));
  // (b) ya mudada: el enlace a la propia no cuenta como pendiente
  assert.equal(MH.__test.configPending(MH.__test.places(ctx, oldTree)), false);
  // (c) un tycon.json que es un ENLACE a OTRO archivo (la persona lo tiene en su Dropbox): se funde igual
  const home2 = casa('config2');
  const env2 = { TYCON_HOME: path.join(home2, '.tycon') };
  const ctx2 = { home: home2, env: env2, platform: process.platform, opts: {} };
  const elsewhere = path.join(home2, 'otro-lado', 'tycon.json');
  writeJson(elsewhere, { ado: { org: 'https://dev.azure.com/acme' } });
  fs.mkdirSync(path.dirname(TH.legacyConfigFile(home2)), { recursive: true });
  fs.symlinkSync(elsewhere, TH.legacyConfigFile(home2));
  const p2 = MH.__test.places(ctx2, oldTree);
  assert.equal(MH.__test.configPending(p2), true, 'un enlace a otro archivo está pendiente de fundir');
  MH.__test.stageConfigMoved(ctx2, { oldTree }, log);
  assert.deepEqual(readJson(TH.ownPaths({ env: env2 }).config).ado, { org: 'https://dev.azure.com/acme' });
});

test('T28x CodexReapprovalNote_OnlyWithCodexPlugged_SameTextAsPlan', () => {
  // AC 28: el aviso que va a la salida de migrate y al aviso del estado (lo que ve el arranque siguiente) — el mismo que
  // anticipa el plan (--dry-run, T27 de harness-move-home.test.sh)
  const note = MH.__test.codexReapprovalNote({ tools: ['claude', 'codex'] });
  assert.match(note, /Codex te va a pedir aprobar sus hooks una vez/);
  assert.match(note, /\/hooks/);
  assert.equal(MH.__test.codexReapprovalNote({ tools: ['claude'] }), null);
  assert.equal(MH.__test.codexReapprovalNote({}), null);
  // y el plan lo dice con las mismas palabras
  const planText = MH.planLines({ home: '/tmp/x', env: { TYCON_HOME: '/tmp/x/.tycon' }, opts: {} }, {
    p: MH.__test.places({ home: '/tmp/x', env: { TYCON_HOME: '/tmp/x/.tycon' } }, '/tmp/x/clon'), repo: { url: 'https://github.com/o/r' },
    target: { version: '2026.10.08.1', ref: 'main', commit: 'a'.repeat(40) }, channel: 'stable', tools: ['claude', 'codex'], oldConfigData: null,
  }).join('\n');
  assert.match(planText, /Codex te va a pedir aprobar sus hooks una vez/);
});

test('T28w Advance_StageThrows_ReturnsNotOk_SnapshotFollowsMovedState', () => {
  const home = casa('advance');
  const env = { TYCON_HOME: path.join(home, '.tycon') };
  const ctx = { home, env, platform: process.platform, opts: {} };
  const oldTree = path.join(home, 'clon'); fs.mkdirSync(path.join(oldTree, 'scripts'), { recursive: true });
  const oldState = TH.legacyStateDir(home);
  fs.mkdirSync(path.join(oldState, 'harness', 'backups', 'copia-1'), { recursive: true });
  fs.writeFileSync(path.join(oldState, 'harness', 'backups', 'copia-1', 'manifest.json'), '{}');
  writeJson(path.join(oldState, 'harness-state.json'), { schema: 1, tree: oldTree, sources: [] });
  fs.mkdirSync(path.join(home, '.tycon', 'harness'), { recursive: true });
  const snap = { dir: path.join(oldState, 'harness', 'backups', 'copia-1'), created: true };
  const H = { ensureLink: () => { throw new Error('EBUSY: la carpeta está tomada'); } };
  const j = { stage: 'installed', oldTree, links: { skills: { kind: 'absent' } }, notes: [] };
  const r = MH.__test.advance(ctx, j, H, { log: () => {}, snap });
  assert.equal(r.ok, false);
  assert.match(r.reason, /«links» falló: EBUSY/);
  assert.equal(snap.dir, path.join(home, '.tycon', 'backups', 'copia-1'), 'la copia se sigue a donde se mudó el estado');
  assert.ok(fs.existsSync(path.join(snap.dir, 'manifest.json')));
  assert.equal(fs.lstatSync(oldState).isSymbolicLink(), true, 'el estado ya se había mudado (un enlace atrás)');
});

// T42 (story 8.23, tanda F · AC 40): la clasificación de lo que hay en la carpeta vieja de agent-skills — del arnés (está
// en el clon que corre), de terceros (destino o enlace en third-party-skills.json) o PERSONAL (lo demás: .trash, un archivo
// suelto, un enlace sano o colgado) — y la línea del plan con N y M.
test('T42 ClassifyOldEntries_Harness_ThirdParty_Personal_TrashFilesAndLinksArePersonal', () => {
  const home = casa('t42');
  const tree = path.join(home, 'clon');
  const old = path.join(home, '.claude', 'agent-skills');
  const mk = (...p) => fs.mkdirSync(path.join(...p), { recursive: true });
  const put = (f, t = 'x\n') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  // el clon que corre hoy: una skill y un revisor del arnés, y el manifiesto de terceros con UN destino y un enlace
  put(path.join(tree, 'skills', 'tycon-pipeline', 'SKILL.md'));
  put(path.join(tree, 'agents', 'tycon-revisor.md'));
  writeJson(path.join(tree, 'scripts', 'publishing', 'third-party-skills.json'), { third_party: [
    { target: '.agents/skills/lab-third', links: ['.claude/skills/lab-third'] },
    { target: 'skills/bmad-x', links: [] },
    { target: 'agents/otro-rev.md', links: ['.claude/agents/otro-rev.md'] },
  ] });
  // la carpeta vieja: lo del arnés (con una edición a medias), terceros, y lo personal en todas sus formas
  put(path.join(old, 'skills', 'tycon-pipeline', 'SKILL.md'), 'trabajo a medias\n');
  put(path.join(old, 'skills', 'lab-third', 'SKILL.md'));
  put(path.join(old, 'skills', 'bmad-x', 'SKILL.md'));
  put(path.join(old, 'skills', 'mi-skill', 'SKILL.md'));
  put(path.join(old, 'skills', '.trash', 'vieja', 'SKILL.md'));
  put(path.join(old, 'skills', 'suelto.txt'));
  fs.symlinkSync(path.join(old, 'skills', 'mi-skill'), path.join(old, 'skills', 'enlace-sano'));
  fs.symlinkSync(path.join(home, 'no-existe'), path.join(old, 'skills', 'colgado'));
  put(path.join(old, 'agents', 'tycon-revisor.md'), 'editado\n');
  put(path.join(old, 'agents', 'otro-rev.md'));
  put(path.join(old, 'agents', 'mi-agente.md'));
  // ~/.claude/skills y ~/.claude/agents: enlaces que pasan por agent-skills (la máquina del equipo)
  mk(home, '.claude');
  fs.symlinkSync(path.join(old, 'skills'), path.join(home, '.claude', 'skills'));
  fs.symlinkSync(path.join(old, 'agents'), path.join(home, '.claude', 'agents'));

  const c = MH.__test.classifyPersonal({ home, oldSkillsDir: old, tree });
  assert.deepEqual(c.skills.harness, ['tycon-pipeline'], 'del arnés: lo que está en el clon que corre (gana aunque esté editado)');
  assert.deepEqual(c.skills.third, ['bmad-x', 'lab-third'], 'de terceros: por destino o por enlace del manifiesto');
  assert.deepEqual(c.skills.personal, ['.trash', 'colgado', 'enlace-sano', 'mi-skill', 'suelto.txt'], 'personal: lo demás, en todas sus formas');
  assert.deepEqual(c.skills.dangling, ['colgado'], 'el enlace colgado se cuenta y se dice');
  assert.deepEqual(c.agents.harness, ['tycon-revisor.md']);
  assert.deepEqual(c.agents.third, ['otro-rev.md']);
  assert.deepEqual(c.agents.personal, ['mi-agente.md']);
  assert.deepEqual(c.skills.inPlace, [], 'nada ya en su lugar: ~/.claude/skills es un enlace');
  assert.equal(c.skills.link, true); assert.equal(c.agents.link, true);
  const line = MH.__test.personalPlanLine(c);
  assert.match(line, /conserva 5 skills y 1 agente tuyos/);
  assert.match(line, /\.trash, colgado \(enlace colgado\), enlace-sano, mi-skill, suelto\.txt/);
  assert.match(line, /mi-agente\.md/);
  assert.match(line, /colgado \(enlace colgado\)/, 'el colgado va marcado');
  assert.match(line, /carpetas reales/);

  // sin nada personal: la línea dice 0 … 0 y no inventa nombres
  const home2 = casa('t42b');
  const old2 = path.join(home2, '.claude', 'agent-skills');
  put(path.join(old2, 'skills', 'tycon-pipeline', 'SKILL.md'));
  put(path.join(old2, 'agents', 'tycon-revisor.md'));
  const c2 = MH.__test.classifyPersonal({ home: home2, oldSkillsDir: old2, tree });
  assert.equal(c2.skills.personal.length + c2.agents.personal.length, 0);
  assert.match(MH.__test.personalPlanLine(c2), /conserva 0 skills y 0 agentes tuyos/);

  // ~/.claude/skills ya es una carpeta REAL con algo de la persona: cuenta como personal «ya en su lugar», no se mueve
  const home3 = casa('t42c');
  const old3 = path.join(home3, '.claude', 'agent-skills');
  put(path.join(old3, 'skills', 'tycon-pipeline', 'SKILL.md'));
  put(path.join(old3, 'skills', 'mia', 'SKILL.md'));
  put(path.join(home3, '.claude', 'skills', 'otra', 'SKILL.md'));
  const c3 = MH.__test.classifyPersonal({ home: home3, oldSkillsDir: old3, tree });
  assert.equal(c3.skills.link, false);
  assert.deepEqual(c3.skills.inPlace, ['otra']);
  assert.deepEqual(c3.skills.personal, ['mia']);
  assert.match(MH.__test.personalPlanLine(c3), /conserva 2 skills y 0 agentes tuyos/);
  assert.match(MH.__test.personalPlanLine(c3), /otra \(ya en su lugar\)/);

  // la carpeta vieja no es una carpeta real (ya era un enlace): nada que clasificar, nada que mover
  const home4 = casa('t42d');
  mk(home4, '.claude');
  fs.symlinkSync(tree, path.join(home4, '.claude', 'agent-skills'));
  const c4 = MH.__test.classifyPersonal({ home: home4, oldSkillsDir: path.join(home4, '.claude', 'agent-skills'), tree });
  assert.equal(c4.skills.personal.length + c4.agents.personal.length, 0);
  assert.equal(c4.oldIsDir, false);
  assert.deepEqual(c4.problems, []);

  // un manifiesto de terceros que está y NO se lee no es «sin terceros»: lo de terceros pasa por personal y el plan lo DICE
  const home5 = casa('t42e');
  const tree5 = path.join(home5, 'clon');
  put(path.join(tree5, 'skills', 'tycon-pipeline', 'SKILL.md'));
  put(path.join(tree5, 'scripts', 'publishing', 'third-party-skills.json'), '{ roto');
  const old5 = path.join(home5, '.claude', 'agent-skills');
  put(path.join(old5, 'skills', 'lab-third', 'SKILL.md'));
  const c5 = MH.__test.classifyPersonal({ home: home5, oldSkillsDir: old5, tree: tree5 });
  assert.deepEqual(c5.skills.personal, ['lab-third']);
  assert.equal(c5.problems.length, 1);
  assert.match(c5.problems[0], /third-party-skills\.json no se lee como JSON/);
  assert.match(MH.__test.personalPlanLine(c5), /⚠️ .*no se lee como JSON: lo de terceros se cuenta como personal/);

  // el deshacer de lo personal va lado por lado: si agents no puede volver (la carpeta apartada tiene un ARCHIVO donde iría
  // la carpeta), skills vuelve igual y el registro dice qué lado quedó a medias y dónde mirar
  const home7 = casa('t42g');
  const aside = path.join(home7, '.claude', 'agent-skills.before-migrate-x');
  put(path.join(home7, '.claude', 'skills', 'mia', 'SKILL.md'));
  put(path.join(home7, '.claude', 'agents', 'mio.md'));
  put(path.join(aside, 'skills', '.keep'));
  put(path.join(aside, 'agents'), 'un archivo donde iría la carpeta\n');
  const ctx7 = { home: home7, env: { TYCON_HOME: path.join(home7, '.tycon') }, platform: process.platform, opts: {} };
  const said = [];
  const j7 = { stage: 'personal', oldTree: path.join(home7, 'clon'), links: { skills: { aside, kind: 'dir' } },
    personal: { skills: { link: null, created: true, moved: ['mia'], kept: [], linksAdded: [] }, agents: { link: null, created: true, moved: ['mio.md'], kept: [], linksAdded: [] } } };
  MH.__test.undo(ctx7, j7, {}, { log: (l) => said.push(l), why: 'prueba' });
  // la carpeta apartada vuelve a su lugar (~/.claude/agent-skills) en el mismo deshacer: lo personal de skills está ahí
  const back7 = path.join(home7, '.claude', 'agent-skills');
  assert.ok(fs.existsSync(path.join(back7, 'skills', 'mia', 'SKILL.md')) || fs.existsSync(path.join(aside, 'skills', 'mia', 'SKILL.md')), 'skills volvió a la carpeta apartada (que vuelve a su lugar)');
  assert.ok(!fs.existsSync(path.join(home7, '.claude', 'skills')), 'la carpeta skills que creó la mudanza se sacó al quedar vacía');
  assert.ok(fs.existsSync(path.join(home7, '.claude', 'agents', 'mio.md')), 'agents no pudo volver: queda donde estaba, no se pierde');
  assert.ok(said.some((l) => /no pude volver lo personal de agents/.test(l) && l.includes(path.join(home7, '.claude', 'agents')) && l.includes(aside)), `el registro dice el lado y dónde mirar: ${said.join(' | ')}`);
  assert.ok(said.some((l) => /1 skills tuyo\(s\) vuelven a/.test(l)), 'y que skills sí volvió');

  // (pase adversarial, clases 2 y 11) ~/.claude/skills es un enlace a una carpeta PROPIA del dev (no pasa por agent-skills):
  // no se toca; lo suyo cuenta «ya en su lugar» y lo personal va adentro
  const home8 = casa('t42h');
  const old8 = path.join(home8, '.claude', 'agent-skills');
  put(path.join(old8, 'skills', 'tycon-pipeline', 'SKILL.md'));
  put(path.join(old8, 'skills', 'mia', 'SKILL.md'));
  put(path.join(home8, 'mis-skills', 'propia', 'SKILL.md'));
  put(path.join(home8, 'mis-skills', 'tycon-pipeline', 'SKILL.md'), 'copia del arnés\n');   // una copia del arnés en la propia no es del dev (clase 8)
  mk(home8, '.claude');
  fs.symlinkSync(path.join(home8, 'mis-skills'), path.join(home8, '.claude', 'skills'));
  const c8 = MH.__test.classifyPersonal({ home: home8, oldSkillsDir: old8, tree });
  assert.equal(c8.skills.own, fs.realpathSync(path.join(home8, 'mis-skills')), 'el enlace a tu carpeta propia se reconoce');
  assert.deepEqual(c8.skills.inPlace, ['propia'], 'lo tuyo de la carpeta propia cuenta ya en su lugar; la copia del arnés no');
  assert.match(MH.__test.personalPlanLine(c8), /tu carpeta, por el enlace/);
  // la etapa: el enlace no se toca y lo personal va adentro de la carpeta propia
  const aside8 = path.join(home8, '.claude', 'agent-skills.before-migrate-x');
  fs.renameSync(old8, aside8);
  const ctx8 = { home: home8, env: { TYCON_HOME: path.join(home8, '.tycon') }, platform: process.platform, opts: {} };
  fs.mkdirSync(path.join(home8, '.tycon', 'harness'), { recursive: true });
  const j8 = { stage: 'links', oldTree: tree, links: { skills: { aside: aside8, kind: 'dir' } }, personalPlan: (() => { const o = {}; for (const s of MH.__test.PERSONAL_SIDES) o[s] = { personal: c8[s].personal, link: c8[s].link, linkTarget: c8[s].linkTarget, realDir: c8[s].realDir, own: c8[s].own }; return o; })(), personal: {}, notes: [] };
  MH.__test.stagePersonal(ctx8, j8, () => {});
  assert.equal(fs.lstatSync(path.join(home8, '.claude', 'skills')).isSymbolicLink(), true, 'el enlace a la carpeta propia sigue');
  assert.ok(fs.existsSync(path.join(home8, 'mis-skills', 'mia', 'SKILL.md')), 'lo personal fue a la carpeta propia');
  assert.ok(fs.existsSync(path.join(home8, 'mis-skills', 'propia', 'SKILL.md')), 'lo tuyo sigue');
  assert.deepEqual(j8.personal.skills.moved, ['mia']);

  // (clase 1) un enlace personal se muda con su SENTIDO: relativo → absoluto resuelto desde la carpeta vieja; adentro de la
  // carpeta vieja → la apartada; colgado sigue colgado
  const home9 = casa('t42i');
  const old9 = path.join(home9, '.claude', 'agent-skills');
  put(path.join(old9, 'skills', 'tycon-pipeline', 'SKILL.md'));
  put(path.join(old9, 'skills', 'mi-skill', 'SKILL.md'));
  put(path.join(home9, '.claude', 'extra', 'rel', 'SKILL.md'));
  fs.symlinkSync('../../extra/rel', path.join(old9, 'skills', 'rel'));                      // relativo, sano desde la carpeta vieja
  fs.symlinkSync(path.join(old9, 'skills', 'mi-skill'), path.join(old9, 'skills', 'hermana'));  // absoluto, adentro de la carpeta vieja
  fs.symlinkSync('../../../.agents/skills/gsap', path.join(old9, 'skills', 'gsap'));         // relativo y colgado (no existe)
  fs.symlinkSync('./tycon-pipeline', path.join(old9, 'skills', 'al-arnes'));                  // a algo del arnés, adentro de la carpeta vieja
  mk(home9, '.claude'); fs.symlinkSync(path.join(old9, 'skills'), path.join(home9, '.claude', 'skills'));
  const c9 = MH.__test.classifyPersonal({ home: home9, oldSkillsDir: old9, tree });
  assert.deepEqual(c9.skills.personal, ['al-arnes', 'gsap', 'hermana', 'mi-skill', 'rel']);
  assert.deepEqual(c9.skills.dangling, ['gsap']);
  const aside9 = path.join(home9, '.claude', 'agent-skills.before-migrate-x');
  fs.renameSync(old9, aside9);
  const ctx9 = { home: home9, env: { TYCON_HOME: path.join(home9, '.tycon') }, platform: process.platform, opts: {} };
  put(path.join(home9, '.tycon', 'harness', 'skills', 'tycon-pipeline', 'SKILL.md'), 'la versión instalada\n');
  const j9 = { stage: 'links', oldTree: tree, links: { skills: { aside: aside9, kind: 'dir' } }, personalPlan: { skills: { personal: c9.skills.personal, link: true, linkTarget: path.join(old9, 'skills'), realDir: false, own: null } }, personal: {}, notes: [] };
  MH.__test.stagePersonal(ctx9, j9, () => {});
  const sk9 = path.join(home9, '.claude', 'skills');
  assert.ok(fs.existsSync(path.join(sk9, 'rel', 'SKILL.md')), 'el relativo sano sigue sano (ahora absoluto)');
  assert.ok(fs.existsSync(path.join(sk9, 'hermana', 'SKILL.md')), 'el absoluto adentro de la carpeta vieja sigue a su hermana, ya movida');
  assert.equal(fs.lstatSync(path.join(sk9, 'gsap')).isSymbolicLink() && !fs.existsSync(path.join(sk9, 'gsap')), true, 'el colgado sigue colgado: no se activa nada que no estaba activo');
  assert.equal(fs.readlinkSync(path.join(sk9, 'al-arnes')), path.join(home9, '.tycon', 'harness', 'skills', 'tycon-pipeline'), 'el que apuntaba a algo del arnés apunta a la versión instalada');
  assert.equal(fs.readFileSync(path.join(sk9, 'al-arnes', 'SKILL.md'), 'utf8'), 'la versión instalada\n');
  assert.deepEqual(Object.keys(j9.personal.skills.relinked).sort(), ['al-arnes', 'gsap', 'hermana', 'rel']);
  // y el deshacer repone el texto original de cada enlace en la carpeta apartada
  MH.__test.undo(ctx9, j9, {}, { log: () => {}, why: 'prueba' });
  assert.equal(fs.readlinkSync(path.join(old9, 'skills', 'rel')), '../../extra/rel', 'el relativo vuelve con su texto');
  assert.equal(fs.readlinkSync(path.join(old9, 'skills', 'gsap')), '../../../.agents/skills/gsap');
  assert.equal(fs.readlinkSync(path.join(old9, 'skills', 'al-arnes')), './tycon-pipeline', 'el que apuntaba al arnés vuelve con su texto');

  // (clases 3 y 13) agent-skills es un ENLACE a un clon viejo que vive aparte (la transición de la 8.18): lo personal de ese
  // clon se clasifica igual y la etapa lo ENLAZA (de un clon ajeno no se saca nada)
  const home10 = casa('t42j');
  const sep = path.join(home10, 'clon-viejo-de-skills');
  put(path.join(sep, 'skills', 'tycon-pipeline', 'SKILL.md'));
  put(path.join(sep, 'skills', 'mia', 'SKILL.md'));
  put(path.join(sep, '.git', 'HEAD'), 'ref\n');
  mk(home10, '.claude');
  fs.symlinkSync(sep, path.join(home10, '.claude', 'agent-skills'));
  fs.symlinkSync(path.join(home10, '.claude', 'agent-skills', 'skills'), path.join(home10, '.claude', 'skills'));
  const c10 = MH.__test.classifyPersonal({ home: home10, oldSkillsDir: path.join(home10, '.claude', 'agent-skills'), tree });
  assert.equal(c10.oldIsSeparate, true); assert.equal(c10.source, fs.realpathSync(sep));
  assert.deepEqual(c10.skills.personal, ['mia']);
  assert.match(MH.__test.personalPlanLine(c10), /enlazados desde tu clon viejo de skills/);
  const ctx10 = { home: home10, env: { TYCON_HOME: path.join(home10, '.tycon') }, platform: process.platform, opts: {} };
  fs.mkdirSync(path.join(home10, '.tycon', 'harness'), { recursive: true });
  const j10 = { stage: 'links', oldTree: tree, links: { skills: { aside: null, kind: 'link' } }, personalPlan: Object.assign({ oldIsSeparate: true, source: c10.source }, { skills: { personal: ['mia'], link: true, linkTarget: path.join(home10, '.claude', 'agent-skills', 'skills'), realDir: false, own: null } }), personal: {}, notes: [] };
  MH.__test.stagePersonal(ctx10, j10, () => {});
  assert.equal(fs.lstatSync(path.join(home10, '.claude', 'skills', 'mia')).isSymbolicLink(), true, 'mia quedó enlazada desde el clon viejo');
  assert.ok(fs.existsSync(path.join(sep, 'skills', 'mia', 'SKILL.md')), 'el clon viejo no se tocó');
  assert.deepEqual(j10.personal.skills.linked, ['mia']);
  // y el deshacer saca el enlace puesto, repone el enlace viejo de skills y no toca el clon
  MH.__test.undo(ctx10, j10, {}, { log: () => {}, why: 'prueba' });
  assert.ok(!fs.existsSync(path.join(home10, '.claude', 'skills', 'mia')) || fs.lstatSync(path.join(home10, '.claude', 'skills')).isSymbolicLink(), 'el enlace a mia se sacó (o skills volvió a ser el enlace viejo)');
  assert.equal(fs.lstatSync(path.join(home10, '.claude', 'skills')).isSymbolicLink(), true, 'skills vuelve a ser el enlace de antes');
  assert.ok(fs.existsSync(path.join(sep, 'skills', 'mia', 'SKILL.md')), 'el clon viejo sigue intacto tras deshacer');

  // (seguridad, iter 3) un enlace a una carpeta FUERA de la carpeta de la persona no cuenta como propia: no se escribe ahí, y se dice
  const home12 = casa('t42l');
  const afuera = casa('t42l-afuera');
  put(path.join(afuera, 'ajena', 'SKILL.md'));
  const old12 = path.join(home12, '.claude', 'agent-skills');
  put(path.join(old12, 'skills', 'mia', 'SKILL.md'));
  mk(home12, '.claude');
  fs.symlinkSync(afuera, path.join(home12, '.claude', 'skills'));
  const c12 = MH.__test.classifyPersonal({ home: home12, oldSkillsDir: old12, tree });
  assert.equal(c12.skills.own, null, 'fuera de tu carpeta no es «tu carpeta propia»');
  assert.ok(c12.problems.some((w) => /apunta fuera de tu carpeta/.test(w)), 'y el plan lo dice');

  // (clases 4, 5 y 12) reanudada tras un corte a mitad de la etapa: el enlace viejo ya no está y la carpeta vacía quedó; el
  // diario trae el destino del enlace desde el plan, y la carpeta cuenta como creada por la mudanza
  const home11 = casa('t42k');
  const aside11 = path.join(home11, '.claude', 'agent-skills.before-migrate-x');
  put(path.join(aside11, 'skills', 'mia', 'SKILL.md'));
  mk(home11, '.claude', 'skills');   // la carpeta vacía que quedó tras el corte
  const ctx11 = { home: home11, env: { TYCON_HOME: path.join(home11, '.tycon') }, platform: process.platform, opts: {} };
  fs.mkdirSync(path.join(home11, '.tycon', 'harness'), { recursive: true });
  const j11 = { stage: 'links', oldTree: tree, links: { skills: { aside: aside11, kind: 'dir' } }, personalPlan: { skills: { personal: ['mia'], link: true, linkTarget: path.join(home11, '.claude', 'agent-skills', 'skills'), realDir: false, own: null } }, personal: {}, notes: [] };
  MH.__test.stagePersonal(ctx11, j11, () => {});
  assert.equal(j11.personal.skills.created, true, 'la carpeta vacía cuenta como creada por la mudanza');
  assert.equal(j11.personal.skills.link, path.join(home11, '.claude', 'agent-skills', 'skills'), 'el destino del enlace viejo sale del plan');
  MH.__test.undo(ctx11, j11, {}, { log: () => {}, why: 'prueba' });
  assert.equal(fs.lstatSync(path.join(home11, '.claude', 'skills')).isSymbolicLink(), true, 'el deshacer repone el enlace viejo aunque la etapa se haya cortado');

  // (iter 4) un destino de enlace que no se puede mirar por PERMISO no es «un archivo» ni «no existe»: la etapa falla (y la
  // mudanza se deshace) en vez de inventar un enlace de archivo. El caso «readlink falla» no se puede forzar sin simular el
  // sistema de archivos (prohibido por la story): queda declarado en el AC 40, sin prueba propia
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    const home13 = casa('t42m');
    const aside13 = path.join(home13, '.claude', 'agent-skills.before-migrate-x');
    put(path.join(home13, '.claude', 'cerrada', 'adentro', 'SKILL.md'));
    mk(aside13, 'skills');
    fs.symlinkSync(path.join(home13, '.claude', 'cerrada', 'adentro'), path.join(aside13, 'skills', 'sin-permiso'));
    const ctx13 = { home: home13, env: { TYCON_HOME: path.join(home13, '.tycon') }, platform: process.platform, opts: {} };
    fs.mkdirSync(path.join(home13, '.tycon', 'harness'), { recursive: true });
    const j13 = { stage: 'links', oldTree: tree, links: { skills: { aside: aside13, kind: 'dir' } }, personalPlan: { skills: { personal: ['sin-permiso'], link: false, linkTarget: null, realDir: false, own: null } }, personal: {}, notes: [] };
    fs.chmodSync(path.join(home13, '.claude', 'cerrada'), 0o000);   // justo antes del try: el finally lo repone siempre
    try {
      assert.throws(() => MH.__test.stagePersonal(ctx13, j13, () => {}), /EACCES/, 'mirar el destino sin permiso sube: es un fallo durante, no un enlace de archivo');
    } finally { fs.chmodSync(path.join(home13, '.claude', 'cerrada'), 0o755); }
  }

  // una carpeta vieja que está y no se puede leer no es «sin personales»: se dice (sólo donde el permiso se puede quitar)
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    const home6 = casa('t42f');
    const old6 = path.join(home6, '.claude', 'agent-skills');
    put(path.join(old6, 'skills', 'mia', 'SKILL.md'));
    fs.chmodSync(path.join(old6, 'skills'), 0o000);
    try {
      const c6 = MH.__test.classifyPersonal({ home: home6, oldSkillsDir: old6, tree });
      assert.equal(c6.skills.personal.length, 0);
      assert.equal(c6.problems.length, 1);
      assert.match(c6.problems[0], /skills no se pudo leer \(EACCES\)/);
      assert.match(MH.__test.personalPlanLine(c6), /conserva 0 skills y 0 agentes tuyos.*⚠️/);
    } finally { fs.chmodSync(path.join(old6, 'skills'), 0o755); }
  }
});

// T45 (story 8.23, tanda G · AC 41): el perfil del equipo del clon pasa a la configuración propia como valores de la
// máquina. La primera máquina migrada (2026-10-08) quedó con las integraciones, el paquete por defecto y la política de
// fábrica: la versión bajada no trae perfil-equipo.json y la mudanza no lo fundía.
test('T45 ProfileFold_Classify_MachineWins_TransitionKeysSkipped_LineText', () => {
  const home = casa('t45');
  const env = { TYCON_HOME: path.join(home, '.tycon'), TYCON_ENGRAM: '0' };   // una variable puesta: gana al leer, pero no se escribe
  const ctx = { home, env, platform: process.platform, opts: {} };
  const oldTree = path.join(home, 'clon'); fs.mkdirSync(oldTree, { recursive: true });
  const newConfig = TH.ownPaths({ env }).config;
  const perfil = {
    ado: { org: 'https://dev.azure.com/acme' },
    integrations: { clockify: true, engram: true, mailbox: true, codex: 'detect', nightly: true },
    update: { channel: 'latest', apply: 'auto', skills_source: 'unified', source: 'internal' },
    packs: { default: 'all' },
    install: { profile: 'full', home: 'tycon' },
  };
  writeJson(path.join(oldTree, 'perfil-equipo.json'), perfil);
  // (a) la máquina ya tiene clockify apagada: gana lo suyo; lo demás viaja; las tres llaves de la transición no
  const own = { integrations: { clockify: false }, github: { token: 'x' } };
  const f = MH.__test.profileFold({ ctx, oldTree, ownConfigData: own });
  assert.equal(f.status, 'read', JSON.stringify(f));
  assert.equal(f.file, path.join(oldTree, 'perfil-equipo.json'));
  const rutas = (xs) => xs.map((m) => `${m.section}.${m.key}`).sort();
  assert.deepEqual(rutas(f.moves), ['ado.org', 'install.profile', 'integrations.codex', 'integrations.engram', 'integrations.mailbox', 'integrations.nightly', 'packs.default', 'update.apply', 'update.channel']);
  assert.deepEqual(rutas(f.had), ['integrations.clockify'], 'lo que la máquina ya tenía gana, clave por clave');
  assert.deepEqual(rutas(f.skipped), ['install.home', 'update.skills_source', 'update.source'], 'las llaves de la transición no viajan');
  assert.equal(f.moves.find((m) => m.key === 'codex').value, 'detect');
  assert.equal(f.moves.find((m) => m.key === 'engram').value, true, 'la variable TYCON_ENGRAM=0 no se escribe: viaja lo que dice el perfil');
  // la línea del plan: lo que pasa, lo que ya tenía, lo que no viaja; sin nombres internos
  const line = MH.__test.profileFoldLine(f, newConfig);
  assert.match(line, /^  perfil del equipo: .*perfil-equipo\.json → .*config\.json, como valores de la máquina \(la versión bajada no trae el perfil\): /);
  for (const w of ['ado.org', 'engram', 'mailbox', 'nightly', 'codex detect', 'canal latest', 'aplicación auto', 'paquete del stack all', 'perfil full']) assert.ok(line.includes(w), `la línea nombra «${w}»: ${line}`);
  assert.match(line, /· ya tenías: clockify \(gana lo tuyo\)/);
  assert.match(line, /· no viajan: update\.source, update\.skills_source, install\.home/);
  assert.doesNotMatch(line, /integraciones\.|rutas\./, 'los nombres son los del archivo, no los internos');
  // (b) la etapa funde también SIN tycon.json viejo, y la propia conserva lo suyo
  writeJson(newConfig, own);
  const j = { oldTree, profileFold: f, ownConfigText: fs.readFileSync(newConfig, 'utf8'), notes: [] };
  MH.__test.stageConfigMoved(ctx, j, () => {});
  const merged = readJson(newConfig);
  assert.deepEqual(merged.integrations, { clockify: false, engram: true, mailbox: true, codex: 'detect', nightly: true });
  assert.deepEqual(merged.ado, { org: 'https://dev.azure.com/acme' });
  assert.deepEqual(merged.update, { channel: 'latest', apply: 'auto' }, 'source y skills_source no se escriben');
  assert.deepEqual(merged.install, { profile: 'full' }, 'install.home no se escribe');
  assert.deepEqual(merged.packs, { default: 'all' });
  assert.deepEqual(merged.github, { token: 'x' }, 'lo propio queda');
  assert.equal(j.profileFolded, 9, 'el diario anota cuántos valores pasaron');
  // y el lector del árbol nuevo (sin perfil) lee lo mismo que el viejo (con perfil), con origen «maquina»
  const TC = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
  const newTree = path.join(home, '.tycon', 'harness'); fs.mkdirSync(newTree, { recursive: true });
  fs.mkdirSync(path.join(home, '.tycon', 'state'), { recursive: true }); fs.writeFileSync(path.join(home, '.tycon', 'state', 'harness-state.json'), '{}\n');
  const envRead = { TYCON_HOME: env.TYCON_HOME };
  const antes = TC.sinAnotar(() => TC.cargar({ home, env: envRead, arnes: oldTree }));
  const despues = TC.sinAnotar(() => TC.cargar({ home, env: envRead, arnes: newTree }));
  for (const k of ['ado.org', 'integraciones.engram', 'integraciones.mailbox', 'integraciones.nightly', 'integraciones.codex', 'update.channel', 'update.apply', 'packs.default', 'install.profile']) {
    const [s, c] = k.split('.');
    assert.deepEqual(despues.valores[s][c], antes.valores[s][c], `${k} igual antes y después`);
    assert.equal(despues.origenes[k], 'maquina', `${k} viene de la máquina después`);
  }
  assert.equal(despues.valores.integraciones.clockify, false);
  // (c) deshacer: la propia vuelve a como estaba (sin tycon.json viejo también)
  j.stage = 'config-moved';
  MH.__test.undo(ctx, j, {}, { log: () => {}, why: 'prueba' });
  assert.deepEqual(readJson(newConfig), own, 'la configuración propia volvió a como estaba');
  // (d) sin perfil: «nada que pasar»; con TYCON_PROFILE=0, igual; una propia que no existía se saca al deshacer
  const home2 = casa('t45b'); const tree2 = path.join(home2, 'clon'); fs.mkdirSync(tree2, { recursive: true });
  const ctx2 = { home: home2, env: { TYCON_HOME: path.join(home2, '.tycon') }, platform: process.platform, opts: {} };
  const f2 = MH.__test.profileFold({ ctx: ctx2, oldTree: tree2, ownConfigData: null });
  assert.equal(f2.status, 'absent'); assert.deepEqual(f2.moves, []);
  assert.match(MH.__test.profileFoldLine(f2, '/x/config.json'), /perfil del equipo: el clon no trae team-profile\.json \(ni perfil-equipo\.json, el nombre de antes\) — nada que pasar/);
  writeJson(path.join(tree2, 'perfil-equipo.json'), { packs: { default: 'all' } });
  const anulado = MH.__test.profileFold({ ctx: { ...ctx2, env: { ...ctx2.env, TYCON_PROFILE: '0' } }, oldTree: tree2, ownConfigData: null });
  assert.equal(anulado.status, 'absent', 'TYCON_PROFILE=0 corre sin perfil');
  assert.match(MH.__test.profileFoldLine(anulado, '/x/config.json'), /perfil del equipo: TYCON_PROFILE=0: .*sin perfil del equipo — nada que pasar/, 'con TYCON_PROFILE=0 el plan dice POR QUÉ no pasa nada, no «el clon no trae»');
  // la etapa con un tycon.json viejo que dejó de leerse en el medio: falla (se deshace), no «pasa» en silencio
  {
    const home5 = casa('t45e'); const tree5 = path.join(home5, 'clon'); fs.mkdirSync(tree5, { recursive: true });
    const ctx5 = { home: home5, env: { TYCON_HOME: path.join(home5, '.tycon') }, platform: process.platform, opts: {} };
    fs.mkdirSync(path.dirname(TH.legacyConfigFile(home5)), { recursive: true }); fs.writeFileSync(TH.legacyConfigFile(home5), '{ roto');
    assert.throws(() => MH.__test.stageConfigMoved(ctx5, { oldTree: tree5, profileFold: { status: 'read', file: 'x', moves: [{ section: 'packs', key: 'default', value: 'all' }] }, notes: [] }, () => {}), /dejó de leerse como JSON/);
    assert.equal(fs.existsSync(TH.ownPaths({ env: ctx5.env }).config), false, 'no se escribió nada');
  }
  const f2b = MH.__test.profileFold({ ctx: ctx2, oldTree: tree2, ownConfigData: null });
  const j2 = { oldTree: tree2, profileFold: f2b, ownConfigText: null, notes: [] };
  MH.__test.stageConfigMoved(ctx2, j2, () => {});
  const cfg2 = TH.ownPaths({ env: ctx2.env }).config;
  assert.deepEqual(readJson(cfg2), { packs: { default: 'all' } });
  j2.stage = 'config-moved';
  MH.__test.undo(ctx2, j2, {}, { log: () => {}, why: 'prueba' });
  assert.equal(fs.existsSync(cfg2), false, 'una propia que no existía se saca al deshacer');
  // (e) un perfil ROTO no es «sin perfil»: se dice con el archivo y el motivo (la precondición frena)
  fs.writeFileSync(path.join(tree2, 'perfil-equipo.json'), '{ "integrations": { "engram": "si" }, "telegram": { "chat_id": "123" } }\n');
  const f3 = MH.__test.profileFold({ ctx: ctx2, oldTree: tree2, ownConfigData: null });
  assert.equal(f3.status, 'broken', JSON.stringify(f3));
  assert.match(f3.reason, /perfil-equipo\.json/);
  assert.match(f3.reason, /engram|telegram/);
  fs.writeFileSync(path.join(tree2, 'perfil-equipo.json'), '{ roto');
  assert.equal(MH.__test.profileFold({ ctx: ctx2, oldTree: tree2, ownConfigData: null }).status, 'broken');
  // TYCON_PROFILE apuntando a un archivo que no existe: roto (la variable dice algo que no está), nunca «sin perfil»
  const f4 = MH.__test.profileFold({ ctx: { ...ctx2, env: { ...ctx2.env, TYCON_PROFILE: path.join(home2, 'no-existe.json') } }, oldTree: tree2, ownConfigData: null });
  assert.equal(f4.status, 'broken'); assert.match(f4.reason, /TYCON_PROFILE apunta a un archivo que no existe/);
  // la propia que existe y no se lee: la etapa falla (no se pisa: adentro viaja el permiso de GitHub)
  {
    const home7 = casa('t45g'); const tree7 = path.join(home7, 'clon'); fs.mkdirSync(tree7, { recursive: true });
    const ctx7 = { home: home7, env: { TYCON_HOME: path.join(home7, '.tycon') }, platform: process.platform, opts: {} };
    const cfg7 = TH.ownPaths({ env: ctx7.env }).config; fs.mkdirSync(path.dirname(cfg7), { recursive: true }); fs.writeFileSync(cfg7, '{ roto');
    assert.throws(() => MH.__test.stageConfigMoved(ctx7, { oldTree: tree7, profileFold: { status: 'read', file: 'x', moves: [{ section: 'packs', key: 'default', value: 'all' }] }, notes: [] }, () => {}), /no se lee como JSON: no fundo nada encima/);
    assert.equal(fs.readFileSync(cfg7, 'utf8'), '{ roto', 'la propia ilegible no se pisó');
  }
});

// T45b (pase adversarial de la tanda G, clases 1/3/4/9): el archivo de la máquina con el NOMBRE VIEJO de una clave de
// integración (nocturnos → nightly) cuenta como «ya lo tenía» y gana; al fundir, el archivo queda con un solo nombre, el de
// hoy. Se mide sólo mientras el mapa de renombres conozca ese nombre viejo (cuando se retire, el caso se reescribe o se va)
test('T45b ProfileFold_OldKeyNameInMachineFile_CountsAsHad_MergedFileReadable', (t) => {
  {
    const LN = require(path.join(ROOT, 'scripts', 'lib', 'legacy-names.js'));
    const TC2 = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
    const entry = LN.usableEntries(LN.loadMap()).find((e) => e.kind === 'key' && e.where === TC2.DONDE_CLAVES && e.new === 'nightly');
    if (!entry) { t.skip('NO MEDIDO: el mapa de renombres ya no conoce el nombre viejo de nightly — reescribir el caso con otro nombre viejo o retirarlo'); return; }
    {
      const oldName = entry.old;
      const home6 = casa('t45f'); const tree6 = path.join(home6, 'clon'); fs.mkdirSync(tree6, { recursive: true });
      const env6 = { TYCON_HOME: path.join(home6, '.tycon') };
      const ctx6 = { home: home6, env: env6, platform: process.platform, opts: {} };
      writeJson(path.join(tree6, 'perfil-equipo.json'), { integrations: { nightly: true, mailbox: true } });
      const oldCfg = { integraciones: { [oldName]: false } };
      writeJson(TH.legacyConfigFile(home6), oldCfg);
      const f6 = MH.__test.profileFold({ ctx: ctx6, oldTree: tree6, ownConfigData: null, oldConfigData: oldCfg });
      assert.deepEqual(f6.had.map((m) => m.key), ['nightly'], `el valor con nombre viejo cuenta como «ya lo tenía»: ${JSON.stringify(f6)}`);
      assert.deepEqual(f6.moves.map((m) => m.key), ['mailbox']);
      MH.__test.stageConfigMoved(ctx6, { oldTree: tree6, profileFold: f6, ownConfigText: null, notes: [] }, () => {});
      const merged6 = readJson(TH.ownPaths({ env: env6 }).config);
      assert.deepEqual(merged6.integrations, { nightly: false, mailbox: true }, 'un solo nombre (el de hoy) y gana lo de la máquina');
      fs.mkdirSync(path.join(home6, '.tycon', 'state'), { recursive: true }); fs.writeFileSync(path.join(home6, '.tycon', 'state', 'harness-state.json'), '{}\n');
      const after6 = TC2.sinAnotar(() => TC2.cargar({ home: home6, env: env6, arnes: path.join(home6, '.tycon', 'harness') }));
      assert.deepEqual(after6.errores, [], 'el archivo fundido se lee sin errores');
      assert.equal(after6.valores.integraciones.nightly, false);
      // las dos formas con valores distintos en el archivo de la máquina: configuración rota → precondición, no una excepción
      const f7 = MH.__test.profileFold({ ctx: ctx6, oldTree: tree6, ownConfigData: null, oldConfigData: { integraciones: { [oldName]: false }, integrations: { nightly: true } } });
      assert.equal(f7.status, 'broken'); assert.match(f7.reason, /no se puede fundir/);
    }
  }
});

test('T46 OwnHome_ComesFromContext_EmptyEnvNeverFallsToRunnerHome', () => {
  const home = casa('t46');
  const own = path.join(home, '.tycon');
  const tree = path.join(home, 'clon');
  const ctx = { home, env: {}, platform: process.platform, opts: {} };   // el ambiente recortado: sin TYCON_HOME ni HOME
  const p = MH.__test.places(ctx, tree);
  assert.equal(p.own.root, own, 'sin TYCON_HOME en el ambiente del contexto, la casa propia es la de SU home');
  assert.equal(p.own.harness, path.join(own, 'harness'));
  assert.equal(p.newConfig, path.join(own, 'config.json'));
  assert.equal(MH.journalPath(ctx), path.join(own, MH.JOURNAL_NAME), 'y el diario de la mudanza también');
  assert.notEqual(p.own.root, TH.ownPaths({}).root, 'nunca la de quien corre');
  // una TYCON_HOME pedida en el ambiente del contexto gana, y una vacía sigue siendo un error que la nombra
  const other = path.join(home, 'otra');
  assert.equal(MH.__test.places({ ...ctx, env: { TYCON_HOME: other } }, tree).own.root, other);
  assert.throws(() => MH.__test.places({ ...ctx, env: { TYCON_HOME: '' } }, tree), /TYCON_HOME está definida pero vacía/);

  // undo con ese contexto saca lo que la mudanza puso en la casa PEDIDA (el diario no trae harnessExisted)
  for (const d of ['harness', 'previous']) { fs.mkdirSync(path.join(own, d), { recursive: true }); fs.writeFileSync(path.join(own, d, 'x'), ''); }
  fs.writeFileSync(path.join(own, 'swap.json'), '{}'); fs.writeFileSync(path.join(own, MH.JOURNAL_NAME), '{}');
  MH.__test.undo(ctx, { stage: 'installed', oldTree: tree }, {}, { log: () => {}, why: 'prueba' });
  for (const e of ['harness', 'previous', 'swap.json', MH.JOURNAL_NAME]) assert.ok(!fs.existsSync(path.join(own, e)), `${e} de la casa pedida se sacó`);

  // classifyPersonal: un ~/.claude/skills que apunta adentro de la casa propia de ESA home es del arnés, no «tu carpeta»
  const home2 = casa('t46b');
  fs.mkdirSync(path.join(home2, '.tycon', 'harness', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(home2, '.claude'), { recursive: true });
  fs.symlinkSync(path.join(home2, '.tycon', 'harness', 'skills'), path.join(home2, '.claude', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const c = MH.__test.classifyPersonal({ home: home2, oldSkillsDir: path.join(home2, '.claude', 'agent-skills'), tree });
  assert.equal(c.skills.own, null, 'un enlace a la casa propia de esa home no se toma por carpeta del dev');
});

test('T47 RealHome_Untouched_NoWriteOrDeleteAttempted', () => {
  assert.equal(GUARD.attempts().length, 0, `esta suite intentó tocar la casa real (frenado):\n${GUARD.describe()}`);
});
