'use strict';
// incident-cases.test.js — cada incidente del registro que un revisor debió ver tiene su caso en el banco, y el que
// ningún revisor podía ver lo dice con su motivo (por incidente, o una vez para toda su sección). Registros y bancos de
// juguete; el registro real vive en el repo de mantenimiento y se mide allá con el mismo guion.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'controls-bench', 'incident-cases.js');
const GUIDE = path.join(ROOT, 'guides', 'maintaining', 'mantener-el-arnes.md');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function world(log) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-cases-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, 'cases'));
  fs.writeFileSync(path.join(d, 'cases', 'tycon-juguete.json'), JSON.stringify({ advisor: 'tycon-juguete', cases: [{ id: 'toy-c1-pecado' }, { id: 'limpio-sin-c1' }] }));
  fs.writeFileSync(path.join(d, 'log.md'), log);
  return d;
}
function run(d, extraCases = []) {
  const args = [SCRIPT, '--log', path.join(d, 'log.md'), '--cases', path.join(d, 'cases'), ...extraCases.flatMap((c) => ['--cases', c])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const HEAD = '# Registro\n\n## Advisors\n\n';

test('T1 Incidentes_ConRevisor_TienenCaso @story-1.22 @ac-1 @ac-2: un incidente «debió verlo» sin su caso frena nombrándolo; con su caso, pasa', () => {
  let d = world(`${HEAD}### \`caso-a\` — algo se escapó\nTexto.\n\n**Revisor:** tycon-juguete · **caso:** toy-c9-no-existe\n`);
  let r = run(d);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /caso-a.*toy-c9-no-existe/);
  d = world(`${HEAD}### \`caso-a\` — algo se escapó\nTexto.\n\n**Revisor:** tycon-juguete · **caso:** toy-c1-pecado\n`);
  r = run(d);
  assert.strictEqual(r.code, 0, r.out);
  // un revisor sin archivo de casos tampoco cuenta como cubierto
  d = world(`${HEAD}### \`caso-b\` — x\n\n**Revisor:** tycon-otro · **caso:** toy-c1-pecado\n`);
  r = run(d);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /caso-b.*tycon-otro/);
  // y un incidente sin renglón, en una sección sin declaración, frena
  d = world(`${HEAD}### \`caso-c\` — x\nSin renglón.\n`);
  r = run(d);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /caso-c.*no dice qué revisor/);
});

test('T2 Incidentes_SinRevisor_ConMotivo @story-1.22 @ac-1: «ningún revisor podía verlo» sin motivo frena; con motivo, pasa; la sección lo declara una vez', () => {
  let d = world(`${HEAD}### \`caso-a\` — x\n\n**Revisor:** ninguno\n`);
  let r = run(d);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /caso-a.*sin motivo/);
  d = world(`${HEAD}### \`caso-a\` — x\n\n**Revisor:** ninguno — era un freno de la máquina, no un juicio sobre código\n`);
  assert.strictEqual(run(d).code, 0);
  // la declaración de la sección cubre a todos sus incidentes sin renglón propio; uno con renglón propio manda
  d = world('# Registro\n\n## Hooks\n\n**Revisores:** ninguno — controles mecánicos: ningún revisor podía verlos\n\n### `h1` — x\nTexto.\n\n### `h2` — x\n\n**Revisor:** tycon-juguete · **caso:** toy-c1-pecado\n');
  r = run(d);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /2 incidente\(s\)/);
  d = world('# Registro\n\n## Hooks\n\n**Revisores:** ninguno\n\n### `h1` — x\n');
  assert.strictEqual(run(d).code, 1, 'la declaración de la sección también necesita su motivo');
});

test('T2b Incidentes_CasoPendiente_SoloConSuDeuda @story-1.22 @ac-2: «pendiente» vale sólo si la deuda está declarada en la lista de pendientes', () => {
  const log = `${HEAD}### \`caso-p\` — x\n\n**Revisor:** tycon-juguete · **caso:** pendiente — DEF-9.9-casos-de-paquetes\n`;
  const d = world(log);
  const todo = path.join(d, 'todo.md');
  const runTodo = () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--log', path.join(d, 'log.md'), '--cases', path.join(d, 'cases'), '--debts', todo], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  fs.writeFileSync(todo, '- [ ] [DEF-otra-cosa] x\n');
  let r = runTodo();
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /caso-p.*DEF-9\.9-casos-de-paquetes.*no está/);
  fs.writeFileSync(todo, '- [ ] [DEF-9.9-casos-de-paquetes] los casos de los revisores de paquetes\n');
  r = runTodo();
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /1 pendiente/);
  // cerrada la deuda ([x]), el pendiente ya no vale: el caso tiene que estar
  fs.writeFileSync(todo, '- [x] [DEF-9.9-casos-de-paquetes] los casos de los revisores de paquetes\n');
  assert.strictEqual(runTodo().code, 1);
  // sin --debts, un pendiente frena: no se puede saber si la deuda existe
  assert.strictEqual(run(d).code, 1);
});

test('T7 Guia_CerrarIncidenteConSuCaso @story-1.22 @ac-5: la guía dice cómo cerrar un incidente con su caso y cómo correr el examen de un revisor', () => {
  const g = fs.readFileSync(GUIDE, 'utf8');
  const i = g.indexOf('incident-cases.js');
  assert.ok(i >= 0, 'la guía nombra el control del registro');
  const row = g.slice(g.lastIndexOf('\n', i), g.indexOf('\n', i));
  assert.match(row, /\*\*Revisor:\*\*/, 'el renglón que lleva cada incidente');
  assert.match(row, /reviewer-change-check\.js run --agent/, 'el examen de un revisor antes de cambiarlo');
  assert.match(row, /línea de base/);
});

test('T33 Incidentes_VariosDirectorios_UnionDeCasos @story-1.22 @ac-1: los casos de un revisor son la unión de todos sus archivos; uno ilegible frena', () => {
  const d = world(`${HEAD}### \`caso-u\` — x\n\n**Revisor:** tycon-juguete · **caso:** toy-w1-otro\n`);
  assert.strictEqual(run(d).code, 1, 'sin el segundo directorio el caso no está');
  const second = path.join(d, 'cases2');
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, 'tycon-juguete.json'), JSON.stringify({ cases: [{ id: 'toy-w1-otro' }] }));
  let r = run(d, [second]);
  assert.strictEqual(r.code, 0, r.out);
  fs.writeFileSync(path.join(second, 'tycon-juguete.json'), '{ roto');
  r = run(d, [second]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /caso-u.*no se puede leer/);
});

test('T34 Incidentes_SeccionesConMismoTitulo_NoSePisan @story-1.22 @ac-1: dos secciones con el mismo título se distinguen por su posición', () => {
  const d = world('# Registro\n\n## Hooks\n\n**Revisores:** ninguno — controles mecánicos\n\n### `h1` — x\n\n## Hooks\n\n### `h2` — x\nSin renglón.\n');
  const r = run(d);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /h2.*no dice qué revisor/);
  assert.doesNotMatch(r.out, /h1/);
});

test('T35 Incidentes_SeccionQueNombraUnRevisor_Frena @story-1.22 @ac-1: una sección sólo puede declarar «ninguno»; otra cosa (un revisor, un error de tipeo) no cubre a sus incidentes', () => {
  for (const decl of ['tycon-juguete', 'Ninguna — mal escrito']) {
    const d = world(`# Registro\n\n## Hooks\n\n**Revisores:** ${decl}\n\n### \`h1\` — x\nTexto.\n`);
    const r = run(d);
    assert.strictEqual(r.code, 1, `${decl}: ${r.out}`);
    assert.match(r.out, /Hooks.*sólo puede declarar «ninguno»/);
  }
});

test('T36 Incidentes_DosRenglones_SeValidanLosDos @story-1.22 @ac-1 @ac-2: un incidente con dos revisores valida los dos casos', () => {
  const d = world(`${HEAD}### \`caso-d\` — x\n\n**Revisor:** tycon-juguete · **caso:** toy-c1-pecado\n**Revisor:** tycon-juguete · **caso:** toy-c7-no-existe\n`);
  const r = run(d);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /caso-d.*toy-c7-no-existe/);
});
