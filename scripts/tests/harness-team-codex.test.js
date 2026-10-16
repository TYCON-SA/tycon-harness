'use strict';
// harness-team-codex.test.js — los revisores de la capa del equipo del lado de Codex (story 8.25, tanda A2b · T30u), como
// pruebas unitarias de build/generate.js y del registro de lo desplegado (scripts/setup/harness/tools.js).
//
//   T30u · Codex_GenerateOneTakesRootAndEquivalences_SameFrontmatterRuleAsLayer_AdvisorsToDeployManifestPlusLayer_EnvIgnored_
//          PerAgentFailure_RecordValidatedBeforeDelete — `generateOne(root, name)` lee los agentes y las equivalencias de
//          ESA raíz (nunca de la constante del módulo); el frontmatter se lee con la regla de la A2a (BOM, CRLF, `name` entre
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
  assert.deepEqual(GEN.advisorsToDeploy(sin), { manifest: ['rev-version'], team: [], teamProblem: null, halfDone: false });
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

// ── vuelta 2: lo que encontraron los revisores y el pase adversarial (cada caso falla sin su arreglo) ──────────────────
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
  write(path.join(codex, 'rev-capa-uno.config.toml'), '# ⚙️ GENERADO por build/generate.js — NO EDITAR A MANO (se pisa en la próxima corrida)\nmodel = "viejo"\n');
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

// ── story 7.29: el modelo de la organización en lo que se despliega a Codex ─────────────────────────────────────────
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
  // sin models, y con el archivo ilegible: byte a byte lo de hoy (el ilegible, con la línea)
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
