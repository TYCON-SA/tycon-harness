'use strict';
// harness-team-codex.test.js — los revisores de la capa del equipo del lado de Codex (T30u), como
// pruebas unitarias de build/generate.js y del registro de lo desplegado (scripts/setup/harness/tools.js).
//
//   T30u · Codex_GenerateOneTakesRootAndEquivalences_SameFrontmatterRuleAsLayer_AdvisorsToDeployManifestPlusLayer_EnvIgnored_
//          PerAgentFailure_RecordValidatedBeforeDelete — `generateOne(root, name)` lee los agentes y las equivalencias de
//          ESA raíz (nunca de la constante del módulo); el frontmatter se lee con la regla de la capa (BOM, CRLF, `name` entre
//          comillas, `model:` con comentario); `advisorsToDeploy(root)` da `{ manifest, team }` sin mirar TYCON_PACKS_DIR ni
//          TYCON_AGENTS_DIR; un agente que no se puede generar vuelve como SU falla y los demás se generan; una entrada del
//          registro con `..` o con un nombre fuera de la forma no se borra.
//
// Nombres inventados: ningún revisor ni paquete real. Uso: node --test scripts/tests/harness-team-codex.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const GEN = require(path.join(ROOT, 'build', 'generate.js'));
const TOOLS = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tools.js'));

const casa = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `team-codex-${name}-`));
  if (d.startsWith(ROOT) || /agent-skills|\.claude\/|\.tycon\//.test(d)) throw new Error(`el laboratorio cayó en ${d}`);
  return d;
};
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const agentMd = (name, { model = 'sonnet', tools = 'Read, Grep, Glob', extra = '' } = {}) =>
  `---\nname: ${name}\ndescription: revisor de juguete\nmodel: ${model}\ntools: ${tools}\n${extra}---\n\nRevisa cosas de juguete.\n`;

/** Una equivalencia de juguete: la real con modelos que no existen, así se ve de qué raíz salió. */
function toyEquivalences() {
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'equivalences.json'), 'utf8'));
  return Object.assign({}, real, { models: { sonnet: 'modelo-de-juguete-s', opus: 'modelo-de-juguete-o' } });
}

/** Un árbol de juguete: MANIFEST.json con un revisor, agents/, build/equivalences.json de juguete y la capa con dos. */
function toyTree(dir, { team = ['rev-capa-uno', 'rev-capa-dos'], manifest = ['rev-version'] } = {}) {
  write(path.join(dir, 'build', 'equivalences.json'), JSON.stringify(toyEquivalences(), null, 2));
  write(path.join(dir, 'adapters', 'codex', 'agents', 'MANIFEST.json'), JSON.stringify({ advisors: manifest }, null, 2));
  for (const n of [...manifest, ...team]) write(path.join(dir, 'agents', `${n}.md`), agentMd(n));
  write(path.join(dir, '.tycon-team.json'), JSON.stringify({
    schema: 1, repo: 'acme/equipo', commit: 'a'.repeat(40), tree: 'b'.repeat(40), name: 'equipo-juguete', requires: '2026.10.01.1',
    files: [{ path: 'perfil-equipo.json', mode: '100644', blob: 'c'.repeat(40) }, ...team.map((n) => ({ path: `agents/${n}.md`, mode: '100644', blob: 'd'.repeat(40) }))],
  }, null, 1));
  return dir;
}

test('T30u generateOne(root, name) lee los agentes y las equivalencias de ESA raíz, no las del módulo', () => {
  const root = toyTree(casa('root'));
  assert.equal(typeof GEN.generateOne, 'function', 'generateOne se exporta');
  const g = GEN.generateOne(root, 'rev-capa-uno');
  assert.equal(g.name, 'rev-capa-uno');
  assert.match(g.toml, /^model = "modelo-de-juguete-s"$/m, 'el perfil usa el modelo de la equivalencia de juguete');
  assert.match(g.nativeToml, /^name = "rev-capa-uno"$/m);
  assert.match(g.nativeToml, /^model = "modelo-de-juguete-s"$/m, 'el subagente nativo, también');
  assert.match(g.toml, /# canónico: agents\/rev-capa-uno\.md/);
  assert.throws(() => GEN.generateOne(root, 'no-existe'), /no existe/);
});

test('T30u el frontmatter se lee con la regla de la A2a: BOM, CRLF, name entre comillas y model con comentario', () => {
  const root = toyTree(casa('fm'), { team: [] });
  write(path.join(root, 'agents', 'rev-bom.md'), `﻿${agentMd('rev-bom')}`);
  write(path.join(root, 'agents', 'rev-crlf.md'), agentMd('rev-crlf').replace(/\n/g, '\r\n'));
  write(path.join(root, 'agents', 'rev-comillas.md'), agentMd('rev-comillas').replace('name: rev-comillas', 'name: "rev-comillas"'));
  write(path.join(root, 'agents', 'rev-comentario.md'), agentMd('rev-comentario').replace('model: sonnet', 'model: opus   # el más caro'));
  for (const n of ['rev-bom', 'rev-crlf', 'rev-comillas']) {
    const g = GEN.generateOne(root, n);
    assert.match(g.nativeToml, new RegExp(`^name = "${n}"$`, 'm'), `${n}: el name se lee`);
    assert.match(g.toml, /^model = "modelo-de-juguete-s"$/m, `${n}: el modelo se lee`);
    assert.match(g.toml, /Revisa cosas de juguete\./, `${n}: el cuerpo llega entero`);
  }
  assert.match(GEN.generateOne(root, 'rev-comentario').toml, /^model = "modelo-de-juguete-o"$/m, 'el comentario no es parte del modelo');
});

test('T30u advisorsToDeploy(root) da { manifest, team } del árbol, sin mirar TYCON_PACKS_DIR ni TYCON_AGENTS_DIR', () => {
  const root = toyTree(casa('set'));
  const vacia = casa('vacia');
  const before = { p: process.env.TYCON_PACKS_DIR, a: process.env.TYCON_AGENTS_DIR };
  process.env.TYCON_PACKS_DIR = vacia; process.env.TYCON_AGENTS_DIR = vacia;
  try {
    const set = GEN.advisorsToDeploy(root);
    assert.deepEqual(set.manifest, ['rev-version']);
    assert.deepEqual(set.team, ['rev-capa-dos', 'rev-capa-uno']);
    assert.equal(set.teamProblem, null);
    assert.match(GEN.generateOne(root, 'rev-capa-dos').toml, /modelo-de-juguete-s/, 'las variables no cambian de dónde se lee');
  } finally {
    for (const [k, v] of [['TYCON_PACKS_DIR', before.p], ['TYCON_AGENTS_DIR', before.a]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  // sin capa: team vacío y sin problema; con el manifiesto de la capa ilegible: team null y el motivo
  const sin = toyTree(casa('sin'), { team: [] }); fs.rmSync(path.join(sin, '.tycon-team.json'));
  const vacio = GEN.advisorsToDeploy(sin);
  assert.deepEqual({ ...vacio, teamDirs: { ...vacio.teamDirs } }, { manifest: ['rev-version'], team: [], teamDirs: {}, teamProblem: null, halfDone: false, lines: [] });
  const roto = toyTree(casa('roto')); fs.writeFileSync(path.join(roto, '.tycon-team.json'), '{ esto no es json');
  const r = GEN.advisorsToDeploy(roto);
  assert.equal(r.team, null);
  assert.match(r.teamProblem, /\.tycon-team\.json/);
});

test('T30u un agente de la capa que no se puede generar vuelve como SU falla; los demás se despliegan y nada tira', () => {
  const root = toyTree(casa('falla'));
  write(path.join(root, 'agents', 'rev-capa-dos.md'), agentMd('rev-capa-dos', { model: 'haiku' }));   // sin equivalencia en el juguete
  const codex = casa('codexhome');
  const record = path.join(casa('estado'), TOOLS.CODEX_TEAM_RECORD);
  const r = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  assert.deepEqual(r.skipped.map((s) => s.name), ['rev-capa-dos']);
  assert.match(r.skipped[0].reason, /haiku/);
  assert.ok(fs.existsSync(path.join(codex, 'rev-capa-uno.config.toml')), 'el otro sí está');
  assert.ok(fs.existsSync(path.join(codex, 'agents', 'rev-capa-uno.toml')));
  assert.ok(!fs.existsSync(path.join(codex, 'rev-capa-dos.config.toml')));
  assert.ok(r.lines.some((l) => /^⚠ tycon\/codex: revisor de la capa rev-capa-dos no desplegado: /.test(l)), r.lines.join('\n'));
  const rec = TOOLS.readCodexTeamRecord(record);
  assert.deepEqual(Object.keys(rec.files).sort(), ['agents/rev-capa-uno.toml', 'rev-capa-uno.config.toml']);
  assert.equal(rec.files['rev-capa-uno.config.toml'].sha256, sha256(fs.readFileSync(path.join(codex, 'rev-capa-uno.config.toml'))));
});

test('T30u un archivo del dev con el nombre de un revisor no se pisa; lo sacado se borra sólo si es el suyo', () => {
  const root = toyTree(casa('dev'));
  const codex = casa('codexhome');
  const record = path.join(casa('estado'), TOOLS.CODEX_TEAM_RECORD);
  write(path.join(codex, 'rev-capa-dos.config.toml'), '# del dev\n');
  const r1 = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  assert.equal(fs.readFileSync(path.join(codex, 'rev-capa-dos.config.toml'), 'utf8'), '# del dev\n', 'el del dev intacto');
  assert.deepEqual(r1.devFiles, ['rev-capa-dos.config.toml']);
  assert.ok(r1.lines.some((l) => /⚠/.test(l) && /rev-capa-dos\.config\.toml/.test(l)), 'y se dice');
  // la capa saca a los dos: el sin tocar se borra; el editado a mano queda y se dice; el del dev nunca fue suyo
  write(path.join(codex, 'agents', 'rev-capa-uno.toml'), '# editado a mano\n');
  toyTree(root, { team: [] });
  const r2 = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  assert.ok(!fs.existsSync(path.join(codex, 'rev-capa-uno.config.toml')), 'el sin tocar se borró');
  assert.ok(fs.existsSync(path.join(codex, 'agents', 'rev-capa-uno.toml')), 'el editado quedó');
  assert.ok(fs.existsSync(path.join(codex, 'rev-capa-dos.config.toml')), 'el del dev quedó');
  // el subagente de rev-capa-dos sí lo escribió el arnés (sólo su perfil era del dev): se borra
  assert.deepEqual(r2.removed, ['agents/rev-capa-dos.toml', 'rev-capa-uno.config.toml']);
  assert.deepEqual(r2.kept, ['agents/rev-capa-uno.toml']);
  assert.deepEqual(Object.keys(TOOLS.readCodexTeamRecord(record).files), [], 'el registro quedó vacío');
});

test('T30u sin manifiesto de la capa legible, o con un refresco a medias, no se borra nada de la capa en Codex', () => {
  const root = toyTree(casa('medias'));
  const codex = casa('codexhome');
  const record = path.join(casa('estado'), TOOLS.CODEX_TEAM_RECORD);
  GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  fs.writeFileSync(path.join(root, '.tycon-team.json'), 'ilegible');
  const r = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  assert.deepEqual(r.removed, []);
  assert.ok(fs.existsSync(path.join(codex, 'rev-capa-uno.config.toml')));
  assert.ok(r.lines.some((l) => /no se borra nada/.test(l)), r.lines.join('\n'));
  toyTree(root, { team: [] });
  fs.writeFileSync(path.join(root, '.tycon-team.pending.json'), '{}');
  const r2 = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  assert.deepEqual(r2.removed, []);
  assert.ok(fs.existsSync(path.join(codex, 'rev-capa-uno.config.toml')), 'a medias, tampoco');
});

test('T30u las entradas inválidas del registro no se borran: ni con «..» ni con un nombre fuera de la forma', () => {
  const root = toyTree(casa('reg'), { team: [] });
  const codex = path.join(casa('codex-padre'), 'codex');
  fs.mkdirSync(codex, { recursive: true });
  const afuera = path.join(path.dirname(codex), 'x.config.toml');
  write(afuera, 'afuera\n');
  write(path.join(codex, 'mal nombre.config.toml'), 'raro\n');
  const record = path.join(casa('estado'), TOOLS.CODEX_TEAM_RECORD);
  write(record, JSON.stringify({ schema: 1, codex_home: codex, files: {
    '../x.config.toml': { agent: '../x', sha256: sha256(Buffer.from('afuera\n')) },
    'mal nombre.config.toml': { agent: 'mal nombre', sha256: sha256(Buffer.from('raro\n')) },
  } }));
  const rec = TOOLS.readCodexTeamRecord(record);
  assert.deepEqual(Object.keys(rec.files), [], 'ninguna entrada válida');
  assert.equal(rec.invalid.length, 2);
  const r = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  assert.deepEqual(r.removed, []);
  assert.equal(fs.readFileSync(afuera, 'utf8'), 'afuera\n');
  assert.ok(fs.existsSync(path.join(codex, 'mal nombre.config.toml')));
  assert.ok(r.lines.some((l) => /registro/.test(l) && /no se borra/.test(l)), r.lines.join('\n'));
});

test('T30u una máquina con clon (generate.js --deploy) hace lo de hoy: sólo el MANIFEST, nada de la capa', () => {
  const root = toyTree(casa('clon'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'scripts', 'setup'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'setup', 'harness'), path.join(root, 'scripts', 'setup', 'harness'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'build', 'generate.js'), path.join(root, 'build', 'generate.js'));
  const home = casa('home');
  const env = Object.assign({}, process.env, { CODEX_HOME: path.join(home, '.codex'), HOME: home, USERPROFILE: home, TYCON_AGENTS_DIR: path.join(root, 'agents') });
  const r = require('child_process').spawnSync(process.execPath, [path.join(root, 'build', 'generate.js'), '--deploy'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(fs.existsSync(path.join(home, '.codex', 'rev-version.config.toml')), 'el del MANIFEST, desplegado como siempre');
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'rev-capa-uno.config.toml')), 'nada de la capa');
  assert.ok(!fs.existsSync(TOOLS.codexTeamRecordPath({ home })), 'ni registro de la capa');
  assert.doesNotMatch(r.stdout, /capa del equipo/);
});

// ── casos de regresión (cada uno falla sin su arreglo) ──────────────────
const caseInsensitiveFs = (() => { const d = casa('caja'); fs.writeFileSync(path.join(d, 'A'), 'x'); return fs.existsSync(path.join(d, 'a')); })();

test('T30u un registro ilegible o de otra carpeta de Codex: no se despliega la capa, no se reescribe el registro, y se dice', () => {
  const root = toyTree(casa('regmalo'));
  const codex = casa('codexhome');
  const record = path.join(casa('estado'), TOOLS.CODEX_TEAM_RECORD);
  write(record, '{ ilegible');
  const r = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  assert.deepEqual(r.written, []);
  assert.equal(fs.readFileSync(record, 'utf8'), '{ ilegible', 'el registro queda como estaba');
  assert.ok(r.lines.some((l) => /registro/.test(l) && /no se despliega/.test(l)), r.lines.join('\n'));
  const otra = casa('otro-codex');
  write(record, JSON.stringify({ schema: 1, codex_home: otra, files: { 'rev-capa-uno.config.toml': { agent: 'rev-capa-uno', sha256: 'a'.repeat(64) } } }));
  const antes = fs.readFileSync(record, 'utf8');
  const r2 = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  assert.deepEqual(r2.written, []);
  assert.equal(fs.readFileSync(record, 'utf8'), antes, 'lo de la otra carpeta no se pierde');
  assert.ok(r2.lines.some((l) => /otra carpeta de Codex/.test(l)), r2.lines.join('\n'));
});

test('T30u codexPieces con el registro ilegible no se calla: lo dice en su `problem`', () => {
  const root = toyTree(casa('piezas-mal'));
  const home = casa('home');
  write(TOOLS.codexTeamRecordPath({ home }), 'ilegible');
  const p = TOOLS.codexPieces({ tree: root, home, env: { CODEX_HOME: path.join(home, '.codex') } });
  assert.match(String(p.teamRecordProblem || ''), /ilegible|registro/);
});

test('T30u un error al leer un archivo que la capa sacó (no «no existe») no suelta su entrada', () => {
  const root = toyTree(casa('eisdir'));
  const codex = casa('codexhome');
  const record = path.join(casa('estado'), TOOLS.CODEX_TEAM_RECORD);
  GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  fs.rmSync(path.join(codex, 'rev-capa-uno.config.toml')); fs.mkdirSync(path.join(codex, 'rev-capa-uno.config.toml'));
  toyTree(root, { team: ['rev-capa-dos'] });
  const r = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  assert.ok(Object.keys(TOOLS.readCodexTeamRecord(record).files).includes('rev-capa-uno.config.toml'), 'la entrada sigue');
  assert.ok(r.lines.some((l) => /rev-capa-uno\.config\.toml/.test(l) && /no pude/.test(l)), r.lines.join('\n'));
});

test('T30u un nombre de revisor que el registro no aceptaría no se escribe: se saltea y se dice', () => {
  const root = toyTree(casa('nombre'), { team: ['.oculto', 'rev-capa-uno'] });
  const codex = casa('codexhome');
  const r = GEN.deployTeam({ root, codexHome: codex, recordFile: path.join(casa('estado'), TOOLS.CODEX_TEAM_RECORD) });
  assert.ok(!fs.existsSync(path.join(codex, '.oculto.config.toml')));
  assert.ok(r.skipped.some((s) => s.name === '.oculto'));
  assert.ok(fs.existsSync(path.join(codex, 'rev-capa-uno.config.toml')));
});

test('T30u un revisor que pasa de la capa a la versión (MANIFEST) no se borra: queda de la versión', () => {
  const root = toyTree(casa('promo'));
  const codex = casa('codexhome');
  const record = path.join(casa('estado'), TOOLS.CODEX_TEAM_RECORD);
  GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  toyTree(root, { team: ['rev-capa-dos'], manifest: ['rev-version', 'rev-capa-uno'] });
  const r = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  assert.deepEqual(r.removed, []);
  assert.ok(fs.existsSync(path.join(codex, 'rev-capa-uno.config.toml')) && fs.existsSync(path.join(codex, 'agents', 'rev-capa-uno.toml')));
  assert.ok(!Object.keys(TOOLS.readCodexTeamRecord(record).files).some((k) => k.includes('rev-capa-uno')), 'sale del registro de la capa');
  assert.ok(!r.lines.some((l) => /editado a mano/.test(l)), r.lines.join('\n'));
});

test('T30u un archivo generado por el arnés (con su cabecera) que no está en el registro se toma como del arnés, no del dev', () => {
  const root = toyTree(casa('cabecera'));
  const codex = casa('codexhome');
  write(path.join(codex, 'rev-capa-uno.config.toml'), '# ⚙️ GENERADO por build/generate.js — NO EDITAR A MANO (se pisa en la próxima ejecución)\nmodel = "viejo"\n');
  const r = GEN.deployTeam({ root, codexHome: codex, recordFile: path.join(casa('estado'), TOOLS.CODEX_TEAM_RECORD) });
  assert.deepEqual(r.devFiles, []);
  assert.match(fs.readFileSync(path.join(codex, 'rev-capa-uno.config.toml'), 'utf8'), /modelo-de-juguete-s/);
});

test('T30u un cambio sólo de caja en el nombre de un revisor no lo deja sin archivos en Codex', { skip: !caseInsensitiveFs && 'el disco distingue mayúsculas: el caso no existe acá' }, () => {
  const root = toyTree(casa('caja'), { team: ['Rev-Uno', 'dos'] });
  const codex = casa('codexhome');
  const record = path.join(casa('estado'), TOOLS.CODEX_TEAM_RECORD);
  GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  fs.rmSync(path.join(root, 'agents', 'Rev-Uno.md'));
  toyTree(root, { team: ['rev-uno', 'dos'] });
  GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  const has = (n) => fs.readdirSync(codex).some((f) => f.toLowerCase() === n);
  assert.ok(has('rev-uno.config.toml'), fs.readdirSync(codex).join(', '));
  assert.ok(fs.readdirSync(path.join(codex, 'agents')).some((f) => f.toLowerCase() === 'rev-uno.toml'));
});

test('T30u la capa que desaparece del árbol (una versión sin capa) deja sus archivos en Codex, y se dice', () => {
  const root = toyTree(casa('sincapa'));
  const home = casa('home');
  const codex = path.join(home, '.codex');
  const record = TOOLS.codexTeamRecordPath({ home });
  GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  fs.rmSync(path.join(root, '.tycon-team.json'));
  const r = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  assert.ok(fs.existsSync(path.join(codex, 'rev-capa-uno.config.toml')), 'nada se borra sin manifiesto');
  assert.ok(r.lines.some((l) => /no trae capa/.test(l) && /quedan/.test(l)), r.lines.join('\n'));
});

test('T30u un pendiente que quedó de un refresco terminado (mismo commit) no frena el borrado', () => {
  const root = toyTree(casa('pend'));
  const codex = casa('codexhome');
  const record = path.join(casa('estado'), TOOLS.CODEX_TEAM_RECORD);
  GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  toyTree(root, { team: ['rev-capa-dos'] });
  fs.writeFileSync(path.join(root, '.tycon-team.pending.json'), JSON.stringify({ commit: 'a'.repeat(40) }));
  assert.equal(GEN.advisorsToDeploy(root).halfDone, false);
  const r = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
  assert.deepEqual(r.removed.sort(), ['agents/rev-capa-uno.toml', 'rev-capa-uno.config.toml']);
  fs.writeFileSync(path.join(root, '.tycon-team.pending.json'), JSON.stringify({ commit: 'f'.repeat(40) }));
  assert.equal(GEN.advisorsToDeploy(root).halfDone, true, 'otro commit: a medias');
});

test('T30u un agente con `tools:` en forma de lista no se traduce mal: falla como suya', () => {
  const root = toyTree(casa('lista'), { team: [] });
  write(path.join(root, 'agents', 'rev-lista.md'), '---\nname: rev-lista\ndescription: x\nmodel: sonnet\ntools:\n  - Read\n  - Write\n---\nCuerpo.\n');
  assert.throws(() => GEN.generateOne(root, 'rev-lista'), /tools/);
});

test('T30u un valor entre comillas llega a Codex como lo lee Claude Code: sin sus escapes', () => {
  const root = toyTree(casa('escapes'), { team: [] });
  write(path.join(root, 'agents', 'rev-esc.md'), '---\nname: rev-esc\ndescription: "con \\"comillas\\" y \\\\barra"\nmodel: sonnet\ntools: Read\n---\nCuerpo.\n');
  write(path.join(root, 'agents', 'rev-simple.md'), "---\nname: rev-simple\ndescription: 'it''s'\nmodel: sonnet\ntools: Read\n---\nCuerpo.\n");
  assert.ok(GEN.generateOne(root, 'rev-esc').nativeToml.includes('description = "con \\"comillas\\" y \\\\barra"'), GEN.generateOne(root, 'rev-esc').nativeToml.split('\n').find((l) => l.startsWith('description')));
  assert.ok(GEN.generateOne(root, 'rev-simple').nativeToml.includes('description = "it\'s"'));
  // y los escapes de código (\u, \x): llegan como el carácter, no con la barra
  write(path.join(root, 'agents', 'rev-uni.md'), '---\nname: rev-uni\ndescription: "caf\\u00e9 \\x41"\nmodel: sonnet\ntools: Read\n---\nCuerpo.\n');
  assert.ok(GEN.generateOne(root, 'rev-uni').nativeToml.includes('description = "café A"'), GEN.generateOne(root, 'rev-uni').nativeToml.split('\n').find((l) => l.startsWith('description')));
  // los de un carácter: \t llega como tabulador (TOML lo admite tal cual en una cadena básica)
  write(path.join(root, 'agents', 'rev-tab.md'), '---\nname: rev-tab\ndescription: "a\\tb"\nmodel: sonnet\ntools: Read\n---\nCuerpo.\n');
  assert.ok(GEN.generateOne(root, 'rev-tab').nativeToml.includes('description = "a\tb"'));
  // un carácter de control que TOML no admite crudo en una cadena básica sale escapado (si no, Codex no carga el revisor)
  write(path.join(root, 'agents', 'rev-ctl.md'), '---\nname: rev-ctl\ndescription: "a\\x01b\\nc"\nmodel: sonnet\ntools: Read\n---\nCuerpo con \u0001 adentro.\n');
  const ctl = GEN.generateOne(root, 'rev-ctl');
  assert.ok(ctl.nativeToml.includes('description = "a\\u0001b\\nc"'), ctl.nativeToml.split('\n').find((l) => l.startsWith('description')));
  assert.doesNotMatch(ctl.toml, /\u0001/, 'tampoco en las instrucciones (cadena de varias líneas)');
  // un retorno de carro suelto en el cuerpo (no es salto de línea en TOML) sale escapado
  write(path.join(root, 'agents', 'rev-cr.md'), '---\nname: rev-cr\ndescription: x\nmodel: sonnet\ntools: Read\n---\nuno\rdos\n');
  const cr = GEN.generateOne(root, 'rev-cr');
  assert.doesNotMatch(cr.toml, /\r/, 'ningún \\r crudo');
  assert.ok(cr.toml.includes('uno\\rdos'));
});

test('T30u codexPieces suma los dos archivos de cada revisor que el despliegue de la capa escribió', () => {
  const root = toyTree(casa('piezas'));
  const home = casa('home');
  const env = { CODEX_HOME: path.join(home, '.codex') };
  const record = TOOLS.codexTeamRecordPath({ home });
  GEN.deployTeam({ root, codexHome: env.CODEX_HOME, recordFile: record });
  const ids = TOOLS.codexPieces({ tree: root, home, env }).map((p) => p.id).sort();
  for (const id of ['rev-capa-uno.config.toml', 'agents/rev-capa-uno.toml', 'rev-capa-dos.config.toml', 'agents/rev-capa-dos.toml']) assert.ok(ids.includes(id), `${id} en ${ids.join(', ')}`);
  for (const p of TOOLS.codexPieces({ tree: root, home, env })) assert.equal(p.kind, 'codex');
});

// ── el modelo de la organización en lo que se despliega a Codex ─────────────────────────────────────────
const equipoModels = (models) => JSON.stringify({
  version: 1, public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' },
  operations: { platform: 'github', org: 'acme', repo: 'o' }, ...(models ? { models } : {}),
});
/** Un árbol de juguete con las equivalencias reales, el lector de team-repos y un revisor del núcleo en `opus`. */
function treeConModelos(name, teamRepos, eqModels) {
  const root = toyTree(casa(name), { team: ['rev-capa-uno'], manifest: ['rev-version', 'tycon-spec-first-checker'] });
  const eq = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'equivalences.json'), 'utf8'));
  if (eqModels) eq.models = eqModels;
  write(path.join(root, 'build', 'equivalences.json'), JSON.stringify(eq, null, 2));
  write(path.join(root, 'agents', 'tycon-spec-first-checker.md'), agentMd('tycon-spec-first-checker', { model: 'opus' }));
  write(path.join(root, 'scripts', 'lib', 'team-repos.js'), fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'), 'utf8'));
  if (teamRepos !== undefined) write(path.join(root, 'team-repos.json'), teamRepos);
  return root;
}
const modelLine = (toml) => (toml.match(/^model = (.*)$/m) || [])[1] || null;

test('T24 Codex_DespliegueConModeloDeLaOrganizacion @story-7.29 @ac-16', () => {
  const models = { reviewers: 'haiku', reviewer: { 'tycon-spec-first-checker': 'opus' }, mandatory_ceiling: true, ceiling: 'sonnet' };
  const root = treeConModelos('org', equipoModels(models));
  // el núcleo: lo que se despliega es la traducción con el modelo resuelto (la misma función que --deploy y --deploy-only)
  for (const [n, slug] of [['rev-version', '"gpt-5.4-mini"'], ['tycon-spec-first-checker', '"gpt-5.6-luna"']]) {
    const g = GEN.generateOne(root, n);
    const org = GEN.orgCodexModel(root, n);
    assert.equal(org.declared, true);
    assert.equal(modelLine(GEN.deployedContent(g.toml, org)), slug, `${n} (perfil)`);
    assert.equal(modelLine(GEN.deployedContent(g.nativeToml, org)), slug, `${n} (nativo)`);
  }
  // la capa del equipo: deployTeam escribe con el modelo resuelto
  const home = casa('home-org');
  const codex = path.join(home, '.codex');
  GEN.deployTeam({ root, codexHome: codex, recordFile: TOOLS.codexTeamRecordPath({ home }) });
  assert.equal(modelLine(fs.readFileSync(path.join(codex, 'agents', 'rev-capa-uno.toml'), 'utf8')), '"gpt-5.4-mini"');
  assert.equal(modelLine(fs.readFileSync(path.join(codex, 'rev-capa-uno.config.toml'), 'utf8')), '"gpt-5.4-mini"');
  // sin models, y con el archivo ilegible: byte a byte lo de siempre (el ilegible, con la línea)
  for (const [nombre, texto] of [['sin', equipoModels(null)], ['ilegible', '{ roto']]) {
    const r = treeConModelos(nombre, texto);
    const g = GEN.generateOne(r, 'rev-version');
    const org = GEN.orgCodexModel(r, 'rev-version');
    assert.equal(org.declared, false, nombre);
    assert.equal(GEN.deployedContent(g.toml, org), g.toml, nombre);
    if (nombre === 'ilegible') assert.ok(org.lines.some((l) => /no pude leer la configuración de la organización/.test(l)), org.lines.join('\n'));
    const h = casa(`home-${nombre}`);
    GEN.deployTeam({ root: r, codexHome: path.join(h, '.codex'), recordFile: TOOLS.codexTeamRecordPath({ home: h }) });
    assert.equal(fs.readFileSync(path.join(h, '.codex', 'agents', 'rev-capa-uno.toml'), 'utf8'), GEN.generateOne(r, 'rev-capa-uno').nativeToml, nombre);
  }
});

test('T25 Codex_SinEquivalente_SinLineaDeModelo @story-7.29 @ac-17', () => {
  const sinHaiku = { opus: 'gpt-5.6-terra', sonnet: 'gpt-5.6-luna', fable: 'gpt-5.6-sol' };
  const root = treeConModelos('sin-haiku', equipoModels({ reviewers: 'haiku' }), sinHaiku);
  const org = GEN.orgCodexModel(root, 'rev-version');
  assert.equal(org.declared, true);
  assert.equal(org.slug, null);
  assert.ok(org.lines.some((l) => /el modelo haiku de rev-version no tiene equivalente en Codex/.test(l)), org.lines.join('\n'));
  const g = GEN.generateOne(root, 'rev-version');
  for (const toml of [GEN.deployedContent(g.toml, org), GEN.deployedContent(g.nativeToml, org)]) {
    assert.equal(modelLine(toml), null, 'sin la línea model =');
    const lines = toml.split('\n');
    const primeraTabla = lines.findIndex((l) => /^\s*\[/.test(l));
    const sueltas = lines.map((l, i) => [l, i]).filter(([l]) => /^[A-Za-z_][\w.-]*\s*=/.test(l)).map(([, i]) => i);
    assert.ok(primeraTabla < 0 || sueltas.filter((i) => i < primeraTabla).length > 0, 'las claves sueltas siguen antes de las tablas');
  }
  // withCodexModel directo: reemplaza la línea, la saca con null, y no toca una `model =` de una tabla
  const conTabla = 'model = "viejo"\nsandbox_mode = "read-only"\n\n[mcp_servers.x]\nmodel = "de-la-tabla"\n';
  assert.equal(GEN.withCodexModel(conTabla, 'nuevo'), 'model = "nuevo"\nsandbox_mode = "read-only"\n\n[mcp_servers.x]\nmodel = "de-la-tabla"\n');
  assert.equal(GEN.withCodexModel(conTabla, null), 'sandbox_mode = "read-only"\n\n[mcp_servers.x]\nmodel = "de-la-tabla"\n');
  assert.equal(GEN.withCodexModel('sandbox_mode = "x"\n', 'nuevo'), 'sandbox_mode = "x"\n', 'sin línea de modelo no inventa una');
  // un árbol sin el lector de team-repos y con el archivo: lo dice
  const sinLector = treeConModelos('sin-lector', equipoModels({ reviewers: 'haiku' }));
  fs.rmSync(path.join(sinLector, 'scripts', 'lib', 'team-repos.js'));
  const o = GEN.orgCodexModel(sinLector, 'rev-version');
  assert.equal(o.declared, false);
  assert.ok(o.lines.some((l) => /no pude leer la configuración de la organización.*no trae su lector/.test(l)), o.lines.join('\n'));
  // el despliegue de la capa lo dice
  const home = casa('home-sin-haiku');
  const r = GEN.deployTeam({ root, codexHome: path.join(home, '.codex'), recordFile: TOOLS.codexTeamRecordPath({ home }) });
  assert.ok(r.lines.some((l) => /no tiene equivalente en Codex/.test(l)), r.lines.join('\n'));
  assert.equal(modelLine(fs.readFileSync(path.join(home, '.codex', 'agents', 'rev-capa-uno.toml'), 'utf8')), null);
});

// ── T43: un revisor de un PAQUETE que llega por la capa (`packs/<p>/agents/<r>.md`) también va a Codex
//    si el paquete está activo para la organización; con el paquete apagado, no, igual que del lado de Claude. Con los
//    paquetes reales lo mide el privado ───────────────────────────────────────────────────────────────────────────────────
function withPacksDefault(value, fn) {
  const before = process.env.TYCON_PACKS_DEFAULT;
  process.env.TYCON_PACKS_DEFAULT = value;
  try { return fn(); } finally { if (before === undefined) delete process.env.TYCON_PACKS_DEFAULT; else process.env.TYCON_PACKS_DEFAULT = before; }
}
function toyTreeWithPack(dir) {
  toyTree(dir, { team: ['rev-capa-uno'] });
  write(path.join(dir, 'packs', 'paq-juguete', 'pack.json'), JSON.stringify({ name: 'paq-juguete', description: 'paquete de juguete', agents: 'agents', reviewers: [] }));
  write(path.join(dir, 'packs', 'paq-juguete', 'agents', 'rev-paquete.md'), agentMd('rev-paquete'));
  const m = JSON.parse(fs.readFileSync(path.join(dir, '.tycon-team.json'), 'utf8'));
  m.files.push({ path: 'packs/paq-juguete/pack.json', mode: '100644', blob: 'e'.repeat(40) }, { path: 'packs/paq-juguete/agents/rev-paquete.md', mode: '100644', blob: 'f'.repeat(40) });
  fs.writeFileSync(path.join(dir, '.tycon-team.json'), JSON.stringify(m, null, 1));
  return dir;
}

test('T43 Codex_TeamLayerPackAgents_DeployedWhenPackActive_SameAsClaude', () => {
  const root = toyTreeWithPack(casa('paq'));
  withPacksDefault('all', () => {
    const set = GEN.advisorsToDeploy(root);
    assert.deepEqual(set.team, ['rev-capa-uno', 'rev-paquete']);
    const g = GEN.generateOne(root, 'rev-paquete', { agentsDir: set.teamDirs['rev-paquete'] });
    assert.match(g.toml, /# canónico: packs\/paq-juguete\/agents\/rev-paquete\.md/, 'el canónico dice dónde vive');
    const codex = casa('codex-paq');
    const record = path.join(casa('estado-paq'), TOOLS.CODEX_TEAM_RECORD);
    const r = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
    assert.deepEqual(r.skipped, []);
    for (const f of ['rev-paquete.config.toml', 'agents/rev-paquete.toml', 'rev-capa-uno.config.toml']) assert.ok(fs.existsSync(path.join(codex, ...f.split('/'))), `${f} en Codex`);
  });
  // el paquete apagado para la organización: su revisor no va
  withPacksDefault('none', () => assert.deepEqual(GEN.advisorsToDeploy(root).team, ['rev-capa-uno']));
  // la configuración de paquetes no se puede resolver: no se sabe qué está activo — no se despliega ni se borra nada, y se dice
  withPacksDefault('no-existe-este-paquete', () => {
    const set = GEN.advisorsToDeploy(root);
    assert.equal(set.team, null);
    assert.match(set.teamProblem, /paquete/);
  });
});

// ── T46: un paquete roto de la capa no es «ausente»; la carpeta de agentes que
//    declara el manifiesto; un nombre repetido se queda con el primero; lo que salió de la versión no queda en Codex ────
test('T46 Codex_BrokenLayerPack_NothingDeployedNorRemoved · AgentsKey · FirstWins · RetiredRemoved', () => {
  // (a) el manifiesto de un paquete de la capa, roto: team null y se dice; nada de la capa se borra de Codex
  const root = toyTreeWithPack(casa('roto'));
  const codex = casa('codex-roto');
  const record = path.join(casa('estado-roto'), TOOLS.CODEX_TEAM_RECORD);
  withPacksDefault('all', () => GEN.deployTeam({ root, codexHome: codex, recordFile: record }));
  assert.ok(fs.existsSync(path.join(codex, 'rev-paquete.config.toml')));
  fs.writeFileSync(path.join(root, 'packs', 'paq-juguete', 'pack.json'), '{ esto no es json');
  withPacksDefault('all', () => {
    const set = GEN.advisorsToDeploy(root);
    assert.equal(set.team, null);
    assert.match(set.teamProblem, /manifiesto roto/);
    const r = GEN.deployTeam({ root, codexHome: codex, recordFile: record });
    assert.deepEqual(r.removed, [], 'con un paquete roto no se borra nada de la capa');
    assert.ok(fs.existsSync(path.join(codex, 'rev-paquete.config.toml')));
  });
  // (b) la carpeta de agentes que declara el manifiesto (no siempre `agents`), y (c) el mismo revisor en dos paquetes: gana el
  //     primero por nombre de paquete, como del lado de Claude
  const otro = toyTree(casa('carpeta'), { team: [] });
  const m = JSON.parse(fs.readFileSync(path.join(otro, '.tycon-team.json'), 'utf8'));
  for (const [p, dir] of [['a-paq', 'revisores'], ['b-paq', 'agents']]) {
    write(path.join(otro, 'packs', p, 'pack.json'), JSON.stringify({ name: p, description: 'x', agents: dir, reviewers: [] }));
    write(path.join(otro, 'packs', p, dir, 'rev-doble.md'), agentMd('rev-doble'));
    m.files.push({ path: `packs/${p}/pack.json`, mode: '100644', blob: 'e'.repeat(40) }, { path: `packs/${p}/${dir}/rev-doble.md`, mode: '100644', blob: 'f'.repeat(40) });
  }
  fs.writeFileSync(path.join(otro, '.tycon-team.json'), JSON.stringify(m));
  withPacksDefault('all', () => {
    const set = GEN.advisorsToDeploy(otro);
    assert.deepEqual(set.team, ['rev-doble']);
    assert.equal(set.teamDirs['rev-doble'], path.join(otro, 'packs', 'a-paq', 'revisores'), 'el primer paquete, con su carpeta');
    assert.match(GEN.generateOne(otro, 'rev-doble', { agentsDir: set.teamDirs['rev-doble'] }).toml, /# canónico: packs\/a-paq\/revisores\/rev-doble\.md/);
  });
  // (d) lo que el arnés desplegó para un revisor que ya no es de la versión ni de la capa se quita; lo de la persona, no
  const viejo = casa('codex-viejo');
  const gen = GEN.generateOne(toyTree(casa('fuente')), 'rev-version').toml.replace(/rev-version/g, 'rev-que-se-fue');
  write(path.join(viejo, 'rev-que-se-fue.config.toml'), gen);
  write(path.join(viejo, 'agents', 'rev-que-se-fue.toml'), gen);
  write(path.join(viejo, 'mio.config.toml'), 'model = "el de la persona"\n');
  const sinCapa = toyTree(casa('sin-capa'), { team: [] }); fs.rmSync(path.join(sinCapa, '.tycon-team.json'));
  // otro revisor con la cabecera del generador que NO está en la lista de los que salieron: no se toca
  write(path.join(viejo, 'rev-ajeno.config.toml'), gen.replace(/rev-que-se-fue/g, 'rev-ajeno'));
  // uno de la lista que deployTeam acaba de dejar como de la persona: tampoco
  write(path.join(viejo, 'rev-editado.config.toml'), gen.replace(/rev-que-se-fue/g, 'rev-editado'));
  const sinRegistro = path.join(casa('rec'), 'no-esta.json');
  const retired = ['rev-que-se-fue', 'rev-editado', 'rev-version'];
  const r = GEN.removeRetired({ root: sinCapa, codexHome: viejo, manifest: ['rev-version'], recordFile: sinRegistro, retired, kept: ['rev-editado.config.toml'] });
  assert.deepEqual(r.removed.sort(), ['agents/rev-que-se-fue.toml', 'rev-que-se-fue.config.toml']);
  assert.ok(fs.existsSync(path.join(viejo, 'mio.config.toml')), 'lo que no escribió el arnés queda');
  assert.ok(fs.existsSync(path.join(viejo, 'rev-ajeno.config.toml')), 'un revisor que no salió de la versión queda aunque tenga la cabecera');
  assert.ok(fs.existsSync(path.join(viejo, 'rev-editado.config.toml')), 'lo que deployTeam dejó como de la persona queda');
  assert.ok(r.lines.some((l) => /quité 2 archivo/.test(l)), r.lines.join('\n'));
  // (d2) uno de la lista generado desde un paquete de la capa (lo que deployTeam dejó como de la persona en un arranque
  //      anterior, ya fuera del registro): tampoco, en ningún arranque
  write(path.join(viejo, 'rev-de-capa.config.toml'), gen.replace(/rev-que-se-fue/g, 'rev-de-capa').replace('# canónico: agents/rev-de-capa.md', '# canónico: packs/paq-x/agents/rev-de-capa.md'));
  assert.match(fs.readFileSync(path.join(viejo, 'rev-de-capa.config.toml'), 'utf8'), /# canónico: packs\/paq-x\/agents\/rev-de-capa\.md/, 'control: el archivo de prueba dice que vino de un paquete');
  const rDeCapa = GEN.removeRetired({ root: sinCapa, codexHome: viejo, manifest: [], recordFile: sinRegistro, retired: ['rev-de-capa'] });
  assert.deepEqual(rDeCapa.removed, []);
  assert.ok(fs.existsSync(path.join(viejo, 'rev-de-capa.config.toml')));
  // (e) con el registro de la capa ilegible no se borra nada, y se dice
  write(path.join(viejo, 'rev-que-se-fue.config.toml'), gen);
  const roto = path.join(casa('rec-roto'), 'registro.json'); write(roto, '{ roto');
  const r2 = GEN.removeRetired({ root: sinCapa, codexHome: viejo, manifest: [], recordFile: roto, retired });
  assert.deepEqual(r2.removed, []);
  assert.ok(r2.lines.some((l) => /registro de la capa no se lee/.test(l)), r2.lines.join('\n'));
  // (f) con capa y el paquete que trae al revisor sin activar: también se quita (no es de la versión ni de la capa activa)
  const conPaq = toyTreeWithPack(casa('paq-inactivo'));
  write(path.join(viejo, 'rev-paquete.config.toml'), gen.replace(/rev-que-se-fue/g, 'rev-paquete'));
  const r3 = withPacksDefault('none', () => GEN.removeRetired({ root: conPaq, codexHome: viejo, manifest: [], recordFile: sinRegistro, retired: ['rev-paquete'] }));
  assert.deepEqual(r3.removed, ['rev-paquete.config.toml'], r3.lines.join('\n'));
  write(path.join(viejo, 'rev-paquete.config.toml'), gen.replace(/rev-que-se-fue/g, 'rev-paquete'));
  const r4 = withPacksDefault('all', () => GEN.removeRetired({ root: conPaq, codexHome: viejo, manifest: [], recordFile: sinRegistro, retired: ['rev-paquete'] }));
  assert.deepEqual(r4.removed, [], 'con el paquete activo es de la capa: queda');
  // (g) la lista real de la versión nombra a los 13 que salieron, y ninguno sigue en el MANIFEST
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'build', 'retired-reviewers.json'), 'utf8')).reviewers;
  const enVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'adapters', 'codex', 'agents', 'MANIFEST.json'), 'utf8')).advisors;
  assert.equal(real.length, 13);
  assert.deepEqual(real.filter((n) => enVersion.includes(n)), []);
});

// ── un nombre repetido entre paquetes se dice; un nombre como `constructor` no se pierde; el canónico
//    de un paquete fuera del árbol (TYCON_PACKS_DIR) se nombra igual; una carpeta de un paquete sin su pack.json tira ────
test('T46b Codex_PackNames_DuplicateSaid · PrototypeNames · CanonicalOutsideTree', () => {
  const otro = toyTree(casa('dup'), { team: [] });
  const m = JSON.parse(fs.readFileSync(path.join(otro, '.tycon-team.json'), 'utf8'));
  for (const p of ['a-paq', 'b-paq']) {
    write(path.join(otro, 'packs', p, 'pack.json'), JSON.stringify({ name: p, description: 'x', agents: 'agents', reviewers: [] }));
    for (const n of ['rev-doble', 'constructor']) {
      write(path.join(otro, 'packs', p, 'agents', `${n}.md`), agentMd(n));
      m.files.push({ path: `packs/${p}/agents/${n}.md`, mode: '100644', blob: 'f'.repeat(40) });
    }
    m.files.push({ path: `packs/${p}/pack.json`, mode: '100644', blob: 'e'.repeat(40) });
  }
  fs.writeFileSync(path.join(otro, '.tycon-team.json'), JSON.stringify(m));
  withPacksDefault('all', () => {
    const set = GEN.advisorsToDeploy(otro);
    assert.deepEqual(set.team, ['constructor', 'rev-doble']);
    assert.equal(set.teamDirs.constructor, path.join(otro, 'packs', 'a-paq', 'agents'));
    assert.ok(set.lines.some((l) => /rev-doble está en packs\/b-paq\/agents y en packs\/a-paq\/agents/.test(l)), set.lines.join('\n'));
    const r = GEN.deployTeam({ root: otro, codexHome: casa('codex-dup'), recordFile: path.join(casa('estado-dup'), TOOLS.CODEX_TEAM_RECORD) });
    assert.ok(r.lines.some((l) => /rev-doble está en/.test(l)), 'deployTeam lo dice');
  });
  // uno de un paquete con el nombre de uno de la versión: queda el de la versión, y se dice
  const choque = toyTree(casa('choque-version'), { team: [] });
  const mc = JSON.parse(fs.readFileSync(path.join(choque, '.tycon-team.json'), 'utf8'));
  write(path.join(choque, 'packs', 'paq-c', 'pack.json'), JSON.stringify({ name: 'paq-c', description: 'x', agents: 'agents', reviewers: [] }));
  write(path.join(choque, 'packs', 'paq-c', 'agents', 'rev-version.md'), agentMd('rev-version'));
  mc.files.push({ path: 'packs/paq-c/pack.json', mode: '100644', blob: 'e'.repeat(40) }, { path: 'packs/paq-c/agents/rev-version.md', mode: '100644', blob: 'f'.repeat(40) });
  fs.writeFileSync(path.join(choque, '.tycon-team.json'), JSON.stringify(mc));
  withPacksDefault('all', () => {
    const set = GEN.advisorsToDeploy(choque);
    assert.deepEqual(set.team, []);
    assert.ok(set.lines.some((l) => /rev-version de packs\/paq-c\/agents tiene el nombre de uno de la versión/.test(l)), set.lines.join('\n'));
  });
  // fuera del árbol: el pack.json de arriba da el nombre, no la ruta del disco
  const fuera = casa('fuera');
  write(path.join(fuera, 'mis-paquetes', 'paq-x', 'pack.json'), JSON.stringify({ name: 'paq-x', description: 'x', agents: 'revisores/de-a-uno', reviewers: [] }));
  write(path.join(fuera, 'mis-paquetes', 'paq-x', 'revisores', 'de-a-uno', 'rev-fuera.md'), agentMd('rev-fuera'));
  const raiz = toyTree(casa('raiz-fuera'), { team: [] });
  assert.match(GEN.generateOne(raiz, 'rev-fuera', { agentsDir: path.join(fuera, 'mis-paquetes', 'paq-x', 'revisores', 'de-a-uno') }).toml, /# canónico: packs\/paq-x\/revisores\/de-a-uno\/rev-fuera\.md/);
  // dentro de packs/<p>/ sin pack.json: tira en vez de nombrar un agents/<r>.md que no existe
  write(path.join(fuera, 'packs', 'sin-manifiesto', 'agents', 'rev-huerfano.md'), agentMd('rev-huerfano'));
  assert.throws(() => GEN.generateOne(raiz, 'rev-huerfano', { agentsDir: path.join(fuera, 'packs', 'sin-manifiesto', 'agents') }), /no encuentro el pack\.json/);
});

// ── T18, del lado de la paridad: la superficie «skills» de la paridad Claude↔Codex cuenta las skills de los
//    paquetes activos igual que las del núcleo (una que falta en Codex es rojo), y si no las puede leer lo dice ──────────
test('T18 Codex_PackSkillsLinked · la paridad cuenta las skills de los paquetes', () => {
  const PAR = require(path.join(ROOT, 'scripts', 'lib', 'harness-parity.js'));
  const DS = require(path.join(ROOT, 'build', 'deploy-shared-skills.js'));
  const base = casa('paridad');
  const clone = path.join(base, 'agent-skills', 'skills');
  write(path.join(clone, 'del-nucleo', 'SKILL.md'), '# núcleo\n');
  const paqSkills = path.join(base, 'agent-skills', 'packs', 'paq-x', 'skills');
  write(path.join(paqSkills, 'del-paquete', 'SKILL.md'), '# paquete\n');
  const codex = casa('codex-paridad');
  fs.mkdirSync(path.join(codex, 'skills'), { recursive: true });
  fs.symlinkSync(path.join(clone, 'del-nucleo'), path.join(codex, 'skills', 'del-nucleo'));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codex;
  try {
    const pol = (packSkills) => ({ pol: { skillsDirs: { skills: clone }, skills: { linkState: DS.linkState, packSkills } } });
    const conPaquete = () => ({ extra: [{ name: 'del-paquete', src: path.join(paqSkills, 'del-paquete') }] });
    let r = PAR.sSkills(pol(conPaquete));
    assert.equal(r.ok, false, r.detail);
    assert.match(r.detail, /faltan 1.*del-paquete/);
    fs.symlinkSync(path.join(paqSkills, 'del-paquete'), path.join(codex, 'skills', 'del-paquete'));
    r = PAR.sSkills(pol(conPaquete));
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, /^2 linkeadas/);
    r = PAR.sSkills(pol(() => { throw new Error('pack.json roto'); }));
    assert.equal(r.ok, false);
    assert.match(r.detail, /no pude leer las skills de los paquetes \(pack\.json roto\)/);
  } finally { if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before; }
});
