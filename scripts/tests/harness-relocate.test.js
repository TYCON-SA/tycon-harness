'use strict';
/**
 * harness-relocate.test.js — `harness.js relocate [--check]`: la mudanza A MANO de lo registrado por el nombre viejo del
 * lugar del arnés (story 8.19, tanda B · AC 17 y 18). En Node a propósito: corre igual en el agente Windows.
 *
 * EL CASO. El nombre viejo del lugar (place.js) sigue resolviendo, y lo que una máquina registró por él sigue
 * andando. Ninguna máquina se muda sola (la mudanza por el perfil es el primer paso del retiro, story 8.15): la persona
 * corre `relocate` cuando quiere. Comprueba sólo leyendo (los dos nombres a la misma carpeta, la copia fija de arranque
 * al día), toma la copia del mecanismo, corre `--reroot <viejo> <lugar>`, cambia la línea de CLAUDE.md y el id de su
 * pieza, y dice qué cambió. No guarda estado: una corrida cortada se termina corriéndolo otra vez.
 *
 * Qué fija (la tabla de pruebas de la story):
 *   T23 --check (el plan, sin escribir), relocate (copia `relocate`, cero por el viejo salvo los permisos, una línea de
 *       CLAUDE.md, el id de la pieza), otra vez («nada que cambiar», sin escribir), en modo `developer` y con TYCON_UPDATE=0;
 *   T24 startup, update y apply NUNCA mudan: lo registrado por el viejo queda igual;
 *   T25 cada precondición rota (1, sin tocar nada); un relocate matado a mitad (TYCON_RELOCATE_DIE_AT, variable de
 *       prueba) y, antes de volver a correrlo, un permiso nuevo guardado por otra sesión: la segunda corrida termina y el
 *       permiso sigue; y `rollback` a la copia de antes: los archivos vuelven a nombrar el viejo, el viejo resuelve y
 *       doctor lo vuelve a contar.
 */
const LABLIB = require('./lib/relocate-lab.js');

const LAB = LABLIB.createLab('harness-relocate');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const { ROOT, IS_WIN, PLACE, placeOf, legacyOf, link, machineEnv, machine, homeHash, hookCommands, readJson, legacyMentions } = LABLIB;
const LN = require(path.join(ROOT, 'scripts', 'lib', 'legacy-names.js'));
const { clone, home } = LABLIB.makeLab(LAB);
test.after(() => { try { fs.rmSync(LAB, { recursive: true, force: true }); } catch (_) { /* nada */ } });

const OLD_IMPORT = `@~/.claude/${PLACE.LEGACY_PLACE_NAME}/README.md`;
const NEW_IMPORT = `@~/.claude/${PLACE.PLACE_NAME}/README.md`;
const pipelineDir = (h) => path.join(h, '.claude', '.tycon-pipeline');
const stateFile = (h) => path.join(pipelineDir(h), 'harness-state.json');

/** La copia fija de arranque y del programa, como la deja `install` (la del árbol). */
function fixedCopy(h, tree) {
  const src = path.join(tree, 'scripts', 'setup');
  const dst = path.join(pipelineDir(h), 'harness');
  fs.mkdirSync(path.join(dst, 'program', 'harness'), { recursive: true });
  for (const f of ['bootstrap.js', 'bootstrap-fallback.sh', 'bootstrap-fallback.ps1']) fs.copyFileSync(path.join(src, 'harness', f), path.join(dst, f));
  // los módulos del programa y la lista fija de skills con datos, que team.js lee de su carpeta (story 8.25, tanda A2c: la copia
  // fija la lleva; sin ella relocate dice «la copia fija de arranque no es la del árbol», como con un módulo que falta)
  for (const f of fs.readdirSync(path.join(src, 'harness')).filter((n) => n.endsWith('.js') || n === 'team-skill-extras.json')) fs.copyFileSync(path.join(src, 'harness', f), path.join(dst, 'program', 'harness', f));
  fs.copyFileSync(path.join(src, 'harness.js'), path.join(dst, 'program', 'harness.js'));
}
/** Una máquina ya instalada que registró cosas por el nombre viejo (sin LaunchAgents: no los necesita esta prueba). */
function installed(name, { mode = 'managed' } = {}) {
  const h = home(name); const C = clone(`arbol-${name}`, { full: true });
  const m = machine(LAB, h, C, { plists: false });
  fixedCopy(h, C);
  fs.writeFileSync(stateFile(h), JSON.stringify({
    schema: 1, mode, tree: C, tree_before: mode === 'developer' ? C : null, sources: [], channel: 'stable',
    version: { number: '0.0.1-lab', installed_at: '2026-10-05T00:00:00.000Z' },
    managed: [{ kind: 'import', where: m.files.claudeMd, id: OLD_IMPORT, version: '0.0.1-lab' }],
    hold: null, notice: null, last_fetch: null, last_apply: null, last_health: null, failed: null,
    bootstrap: { version: null, sha256: {} },
  }, null, 2));
  return { h, C, m };
}
function harness(h, tree, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(tree, 'scripts', 'setup', 'harness.js'), ...args], { encoding: 'utf8', env: machineEnv(h, env), timeout: 120000 });
  return { rc: r.status, signal: r.signal, out: String(r.stdout || ''), err: String(r.stderr || ''), all: String(r.stdout || '') + String(r.stderr || '') };
}
const registered = (h, tree) => LN.countRegistered({ from: legacyOf(h), home: h, env: machineEnv(h), tree });
/** Lo que relocate toca (para «no tocó nada»): la máquina menos la carpeta del mecanismo (registro, candado, copias). */
const machineHash = (h) => homeHash(h, { skip: [pipelineDir(h)] });
const snapshots = (h) => { try { return fs.readdirSync(path.join(pipelineDir(h), 'harness', 'backups')).filter((n) => /^\d{8}-\d{6}/.test(n)).sort(); } catch (_) { return []; } };
const manifest = (h, name) => readJson(path.join(pipelineDir(h), 'harness', 'backups', name, 'manifest.json'));

// ── T23 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T23 Relocate_Manual_SnapshotRerootImport_Idempotent_AnyMode', () => {
  const { h, C, m } = installed('mudanza');
  // --check: el plan, sin escribir (ni siquiera la carpeta del mecanismo)
  const hash0 = homeHash(h);
  const chk = harness(h, C, ['relocate', '--check']);
  assert.strictEqual(chk.rc, 0, chk.all);
  assert.match(chk.out, /settings\.json/, chk.out);
  assert.match(chk.out, /CLAUDE\.md/, chk.out);
  assert.strictEqual(homeHash(h), hash0, '--check escribió algo');
  // relocate
  const r = harness(h, C, ['relocate']);
  assert.strictEqual(r.rc, 0, r.all);
  const snaps = snapshots(h);
  assert.strictEqual(snaps.length, 1, `copias: ${snaps.join(', ')}`);
  assert.strictEqual(manifest(h, snaps[0]).reason, 'relocate');
  const left = registered(h, C);
  assert.ok(left.files.every((f) => f.count === f.permissions), `queda algo por el viejo fuera de los permisos: ${JSON.stringify(left.files)}`);
  assert.ok(left.total > 0, 'los permisos tienen que quedar con las dos formas (la vieja sigue)');
  const s = readJson(m.files.settings);
  assert.ok(s.permissions.allow.some((p) => p.includes(`/.claude/${PLACE.PLACE_NAME}/`)), 'el permiso no tiene la forma nueva al lado');
  assert.ok(hookCommands(s).some((c) => c.includes('lab-real.js') && c.includes(C)), 'tocó el hook por la ruta real');
  const md = fs.readFileSync(m.files.claudeMd, 'utf8').split('\n').map((l) => l.trim());
  assert.strictEqual(md.filter((l) => l === NEW_IMPORT).length, 1, `CLAUDE.md: ${md.join(' | ')}`);
  assert.ok(!md.includes(OLD_IMPORT), 'CLAUDE.md sigue con la línea vieja');
  const st = readJson(stateFile(h));
  assert.deepStrictEqual(st.managed.filter((p) => p.kind === 'import').map((p) => p.id), [NEW_IMPORT], 'el id de la pieza registrada');
  assert.match(r.out, /settings\.json/, r.out);
  assert.match(r.out, /total/i, r.out);
  assert.match(r.out, /\/hooks/, `cambió el hooks.json de Codex y no dijo que hay que volver a aprobarlos: ${r.out}`);
  assert.doesNotMatch(r.out, /la deshace/, 'promete que rollback deshace todo (sólo vuelve lo que nadie tocó después)');
  assert.match(r.out, /\.bak-reroot-/, 'no dice dónde quedaron los respaldos de cada archivo');
  // una nota propia en CLAUDE.md que nombra la ruta vieja no es la línea de arranque: relocate no la muda y doctor no la
  // cuenta como algo que relocate mudaría
  fs.appendFileSync(m.files.claudeMd, `nota mía: antes leía ~/.claude/${PLACE.LEGACY_PLACE_NAME}/guides\n`);
  const docNote = JSON.parse(harness(h, C, ['doctor', '--json']).out);
  assert.ok(!docNote.registered_by_legacy.files.some((f) => f.file === 'CLAUDE.md'), `doctor cuenta la nota de CLAUDE.md: ${JSON.stringify(docNote.registered_by_legacy)}`);
  // otra vez: «nada que cambiar» y no escribe
  const hash1 = homeHash(h);
  const again = harness(h, C, ['relocate']);
  assert.strictEqual(again.rc, 0, again.all);
  assert.match(again.out, /nada que cambiar/, again.out);
  assert.strictEqual(homeHash(h), hash1, 'la segunda corrida escribió algo');
  // con las dos líneas en CLAUDE.md, queda una
  const both = installed('dos-lineas');
  fs.appendFileSync(both.m.files.claudeMd, `${NEW_IMPORT}\n`);
  assert.strictEqual(harness(both.h, both.C, ['relocate']).rc, 0);
  const lines = fs.readFileSync(both.m.files.claudeMd, 'utf8').split('\n').map((l) => l.trim());
  assert.deepStrictEqual(lines.filter((l) => l === NEW_IMPORT || l === OLD_IMPORT), [NEW_IMPORT]);
  // en modo developer y con TYCON_UPDATE=0, igual
  for (const [name, opts, env] of [['developer', { mode: 'developer' }, {}], ['update-apagado', {}, { TYCON_UPDATE: '0' }]]) {
    const x = installed(name, opts);
    const rr = harness(x.h, x.C, ['relocate'], env);
    assert.strictEqual(rr.rc, 0, `${name}: ${rr.all}`);
    assert.ok(registered(x.h, x.C).files.every((f) => f.count === f.permissions), `${name}: no mudó`);
  }
});

// ── T24 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T24 Relocate_NeverFromStartupUpdateApply', () => {
  // por construcción: el módulo sólo lo carga el subcomando relocate
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'harness.js'), 'utf8');
  const uses = src.split('\n').filter((l) => /mod\('relocate'\)/.test(l));
  const body = (name) => { const i = src.indexOf(`function ${name}(`); const j = src.indexOf('\nfunction ', i + 1); return src.slice(i, j); };
  assert.ok(uses.length >= 1, 'harness.js no usa relocate.js');
  for (const fn of ['cmdStartup', 'cmdUpdate', 'cmdApply', 'doUpdate', 'cmdInstall']) assert.doesNotMatch(body(fn), /relocate/, `${fn} nombra relocate`);
  // y corriéndolos: lo registrado por el viejo no cambia
  const { h, C, m } = installed('nunca-solo');
  const before = registered(h, C).total;
  const hooksBefore = hookCommands(readJson(m.files.settings)).join('\n');
  const mdBefore = fs.readFileSync(m.files.claudeMd, 'utf8');
  for (const cmd of [['startup'], ['update', '--check'], ['apply']]) harness(h, C, cmd, { TYCON_UPDATE: '0', TYCON_STARTUP_DETACH: '0' });
  assert.strictEqual(registered(h, C).total, before, 'startup, update o apply mudaron algo');
  assert.strictEqual(hookCommands(readJson(m.files.settings)).join('\n'), hooksBefore, 'cambiaron los hooks');
  assert.strictEqual(fs.readFileSync(m.files.claudeMd, 'utf8'), mdBefore, 'cambió CLAUDE.md');
  // y después de relocate, ni startup ni update ni apply vuelven a traer nada por el viejo (las copias que gestiona el
  // arnés —comandos, pre-commit global— no cuentan: se refrescan solas y su texto es del árbol)
  assert.strictEqual(harness(h, C, ['relocate']).rc, 0);
  const onlyPerms = () => registered(h, C).files.every((f) => f.count === f.permissions);
  assert.ok(onlyPerms(), `después de relocate queda algo fuera de los permisos: ${JSON.stringify(registered(h, C).files)}`);
  for (const cmd of [['startup'], ['update', '--check'], ['apply']]) harness(h, C, cmd, { TYCON_UPDATE: '0', TYCON_STARTUP_DETACH: '0' });
  assert.ok(onlyPerms(), `startup/update/apply volvieron a traer algo por el viejo: ${JSON.stringify(registered(h, C).files)}`);
});

// ── T25 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T25 Relocate_Preconditions_KilledThenPersonEdits_RollbackOlderStillRuns', () => {
  // (a) el lugar y el viejo a clones distintos
  const a = installed('distintos');
  const other = clone('otro');
  fs.unlinkSync(legacyOf(a.h)); link(other, legacyOf(a.h));
  const ha = machineHash(a.h);
  const ra = harness(a.h, a.C, ['relocate']);
  assert.strictEqual(ra.rc, 1, ra.all);
  assert.match(ra.all, /distint/, ra.all);
  assert.match(ra.all, /--link/, ra.all);
  assert.strictEqual(machineHash(a.h), ha, 'tocó algo con los nombres a clones distintos');
  // (b) la copia fija de arranque vieja
  const b = installed('copia-vieja');
  fs.appendFileSync(path.join(pipelineDir(b.h), 'harness', 'bootstrap.js'), '\n// la de antes\n');
  const hb = machineHash(b.h);
  const rb = harness(b.h, b.C, ['relocate']);
  assert.strictEqual(rb.rc, 1, rb.all);
  assert.match(rb.all, /copia fija/, rb.all);
  assert.strictEqual(machineHash(b.h), hb, 'tocó algo con la copia fija vieja');
  // (c) el lugar que no resuelve
  const c = installed('sin-lugar');
  fs.unlinkSync(placeOf(c.h)); link(c.C, placeOf(c.h)); fs.unlinkSync(placeOf(c.h));
  fs.unlinkSync(legacyOf(c.h)); link(c.C, legacyOf(c.h));
  const hc = machineHash(c.h);
  const rc = harness(c.h, c.C, ['relocate']);
  assert.strictEqual(rc.rc, 1, rc.all);
  assert.strictEqual(machineHash(c.h), hc, 'tocó algo sin el lugar');
  // (d) el nombre viejo ya no existe y quedaron hooks por él (rotos): doctor lo dice como aviso y relocate los muda
  const g = installed('viejo-borrado');
  fs.unlinkSync(legacyOf(g.h));
  const dg = JSON.parse(harness(g.h, g.C, ['doctor', '--json']).out);
  assert.ok(dg.warn.some((w) => /ya no resuelve/.test(w)), `doctor no avisa los registros rotos: ${JSON.stringify(dg.warn)} ${JSON.stringify(dg.ok.filter((o) => /viejo/.test(o)))}`);
  assert.ok(!dg.ok.some((o) => /sigue andando/.test(o)), 'doctor dice que sigue andando sin el viejo');
  const rg = harness(g.h, g.C, ['relocate']);
  assert.strictEqual(rg.rc, 0, rg.all);
  assert.ok(registered(g.h, g.C).files.every((f) => f.count === f.permissions), `sin el viejo, relocate no mudó: ${rg.all}`);
  // (e) el nombre viejo es una carpeta real (el clon vive ahí): no hay nada que mudar, y doctor no manda a relocate
  const e = installed('viejo-es-el-clon');
  fs.unlinkSync(legacyOf(e.h)); fs.mkdirSync(path.join(legacyOf(e.h), 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(legacyOf(e.h), 'scripts', 'install-tycon-hooks.sh'), '');
  const he = machineHash(e.h);
  const re = harness(e.h, e.C, ['relocate']);
  assert.strictEqual(re.rc, 0, re.all);
  assert.match(re.out, /tu clon/, re.out);
  assert.strictEqual(machineHash(e.h), he, 'mudó con el viejo como carpeta real');
  const de = JSON.parse(harness(e.h, e.C, ['doctor', '--json']).out);
  assert.ok(![...de.ok, ...de.warn].some((x) => /harness\.js relocate/.test(x)), `doctor manda a relocate con el viejo como carpeta real: ${JSON.stringify(de.ok.filter((o) => /viejo/.test(o)))}`);
  // matado a mitad, una sesión que guarda un permiso, otra corrida: termina y el permiso sigue
  const k = installed('cortado');
  const killed = harness(k.h, k.C, ['relocate'], { TYCON_RELOCATE_DIE_AT: 'after-reroot' });
  assert.ok(killed.rc !== 0, `no se cortó: ${killed.all}`);
  // el candado del corrido que murió queda tomado, pero su PID ya no existe: la corrida siguiente lo pisa en el acto, sin
  // esperar los 10 minutos de antes (story 8.23, AC 37; un candado de un proceso VIVO sigue diciendo «otra sesión»: T38
  // de harness-state.test.js)
  const lockDir = path.join(pipelineDir(k.h), 'harness', 'harness.lock');
  assert.ok(fs.existsSync(lockDir), 'el corte no dejó el candado tomado: la prueba no reproduce el caso');
  assert.ok(fs.readFileSync(k.m.files.claudeMd, 'utf8').includes(OLD_IMPORT), 'el corte tenía que quedar antes de CLAUDE.md');
  const s = readJson(k.m.files.settings);
  s.permissions.allow.push('Bash(npm test -- lab)');
  fs.writeFileSync(k.m.files.settings, JSON.stringify(s, null, 2));
  const fin = harness(k.h, k.C, ['relocate']);
  assert.strictEqual(fin.rc, 0, fin.all);
  assert.ok(readJson(k.m.files.settings).permissions.allow.includes('Bash(npm test -- lab)'), 'se perdió el permiso nuevo');
  assert.ok(fs.readFileSync(k.m.files.claudeMd, 'utf8').includes(NEW_IMPORT), 'la segunda corrida no terminó CLAUDE.md');
  assert.ok(registered(k.h, k.C).files.every((f) => f.count === f.permissions), 'la segunda corrida no terminó');
  // rollback a la copia de antes de relocate: vuelven a nombrar el viejo, el viejo resuelve, doctor lo cuenta
  const v = installed('vuelta');
  assert.strictEqual(harness(v.h, v.C, ['relocate']).rc, 0);
  const before = snapshots(v.h).find((n) => manifest(v.h, n).reason === 'relocate');
  assert.ok(before, `sin copia relocate: ${snapshots(v.h).join(', ')}`);
  const rb2 = harness(v.h, v.C, ['rollback', '--to', before]);
  assert.ok(legacyMentions(hookCommands(readJson(v.m.files.settings)).join('\n')) > 0, `los hooks no volvieron al viejo: ${rb2.all}`);
  assert.ok(fs.readFileSync(v.m.files.claudeMd, 'utf8').includes(OLD_IMPORT), `CLAUDE.md no volvió al viejo: ${rb2.all}`);
  assert.ok(fs.realpathSync(legacyOf(v.h)) === v.C, 'el viejo no resuelve');
  const doc = harness(v.h, v.C, ['doctor', '--json']);
  let j = null;
  try { j = JSON.parse(doc.out); } catch (_) { j = null; }
  assert.ok(j && j.registered_by_legacy && j.registered_by_legacy.total > 0, `doctor no lo cuenta: ${doc.out.slice(0, 400)}`);
});
