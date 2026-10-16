'use strict';
/*
 * assigned-items.test.js — los pedidos abiertos asignados a cada persona, de cada noche (story 2.23, AC 16; T27).
 *
 * El guion deja `.dashboard/assigned/assigned-<día>.json` para el sitio de la organización, con LISTA BLANCA: id,
 * proyecto, tipo, estado, identidad del asignado, días en el estado, enlace y si es un Bug de dependencias del arnés.
 * Nunca el título. Azure es scripts/tests/lib/fake-az.sh (TYCON_ADO_CMD): ningún caso toca la red.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const GUION = path.join(ROOT, 'scripts', 'nightly', 'assigned', 'assigned-items.js');
const HOY = '2026-10-15';

function mundo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'assigned-'));
  const fix = path.join(d, 'fixaz');
  fs.mkdirSync(fix);
  const doble = path.join(d, 'az');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-az.sh'), doble);
  fs.chmodSync(doble, 0o755);
  const repos = path.join(d, 'repos.json');
  fs.writeFileSync(repos, JSON.stringify({ azure: { org: 'https://dev.azure.com/prueba' }, repos: [
    { producto: 'Producto X', ruta: 'X/back', ado: 'Proyecto X/Back', activo: true },
    { producto: 'Producto X', ruta: 'X/front', ado: 'Proyecto X/Front', activo: true },
    { producto: 'Producto Y', ruta: 'Y/back', ado: 'Proyecto Y/Back', activo: false },
  ] }));
  return { d, fix, doble, repos, out: path.join(d, 'out') };
}
const wi = (fix, id, campos) => fs.writeFileSync(path.join(fix, `wi-${id}.json`), JSON.stringify({ id, fields: campos }));
const correr = (m, extra = [], env = {}) => spawnSync(process.execPath, [GUION, '--today', HOY, '--out', m.out, '--repos', m.repos, '--org', 'https://dev.azure.com/prueba', ...extra], {
  encoding: 'utf8', env: { ...process.env, FIXAZ: m.fix, TYCON_ADO_CMD: m.doble, ...env }, timeout: 60000,
});
const leer = (m) => JSON.parse(fs.readFileSync(path.join(m.out, `assigned-${HOY}.json`), 'utf8'));

test('T27 Asignados_ListaBlancaYNoMedido', () => {
  const m = mundo();
  try {
    fs.writeFileSync(path.join(m.fix, 'wiql-Proyecto X.json'), JSON.stringify({ workItems: [{ id: 11 }, { id: 12 }, { id: 13 }] }));
    const base = (extra) => ({ 'System.TeamProject': 'Proyecto X', 'System.Title': 'TITULO-SECRETO', 'System.State': 'Active', 'Microsoft.VSTS.Common.StateChangeDate': '2026-10-12T10:00:00Z', ...extra });
    wi(m.fix, 11, base({ 'System.WorkItemType': 'Bug', 'System.AssignedTo': { uniqueName: 'Dev.A@Acme.Example', displayName: 'NOMBRE-VISIBLE' }, 'System.Tags': 'arnes-hallazgo; arnes:abc12345' }));
    wi(m.fix, 12, base({ 'System.WorkItemType': 'Task', 'System.AssignedTo': { uniqueName: 'dev.b@acme.example', displayName: 'Otro' }, 'System.State': 'New' }));
    wi(m.fix, 13, base({ 'System.WorkItemType': 'User Story', 'System.AssignedTo': { uniqueName: 'dev.a@acme.example' }, 'Microsoft.VSTS.Common.StateChangeDate': null }));
    const r = correr(m);
    assert.strictEqual(r.status, 0, r.stderr);
    const d = leer(m);
    assert.strictEqual(d.estado, 'medido');
    assert.strictEqual(d.fecha, HOY);
    assert.deepStrictEqual(d.pedidos.map((p) => p.id), [11, 12, 13]);
    for (const p of d.pedidos) assert.deepStrictEqual(Object.keys(p).sort(), ['asignado', 'dependencias', 'dias_en_estado', 'enlace', 'estado', 'id', 'proyecto', 'tipo']);
    const p11 = d.pedidos[0];
    assert.deepStrictEqual([p11.asignado, p11.tipo, p11.estado, p11.dias_en_estado, p11.dependencias], ['dev.a@acme.example', 'Bug', 'Active', 3, true], 'el Bug de dependencias marcado');
    assert.strictEqual(p11.enlace, 'https://dev.azure.com/prueba/Proyecto%20X/_workitems/edit/11');
    assert.strictEqual(d.pedidos[1].dependencias, false);
    assert.strictEqual(d.pedidos[2].dias_en_estado, null, 'sin fecha de estado: null, nunca 0');
    assert.ok(!/TITULO-SECRETO|NOMBRE-VISIBLE/.test(JSON.stringify(d)), 'sin título ni nombre para mostrar');
    // la consulta: sólo los proyectos activos de repos.json, una vez cada uno, acotada al proyecto y sin pedir el título
    const llamadas = fs.readFileSync(path.join(m.fix, 'llamadas.log'), 'utf8').trim().split('\n');
    const wiql = llamadas.filter((l) => l.startsWith('wiql'));
    assert.strictEqual(wiql.length, 1, 'Proyecto X una vez, Proyecto Y (inactivo) ninguna');
    const lote = llamadas.filter((l) => l.startsWith('lote')).map((l) => JSON.parse(l.split('\t')[1]));
    assert.ok(lote.length >= 1);
    for (const l of lote) assert.ok(!Object.values(l.archivos).join('').includes('System.Title'), 'el lote no pide el título');
  } finally { fs.rmSync(m.d, { recursive: true, force: true }); }

  // la consulta falla: el archivo se escribe igual con no_medido y el motivo, y el guion sale 1
  const f = mundo();
  try {
    const r = correr(f, [], { TYCON_AZ_FAIL: 'wiql' });
    assert.strictEqual(r.status, 1);
    const d = leer(f);
    assert.strictEqual(d.estado, 'no_medido');
    assert.ok(d.motivo);
    assert.deepStrictEqual(d.pedidos, []);
  } finally { fs.rmSync(f.d, { recursive: true, force: true }); }

  // una organización en GitHub: no_medido con su frase, sin consultar nada
  const g = mundo();
  try {
    const r = correr(g, ['--provider', 'github']);
    assert.strictEqual(r.status, 0);
    const d = leer(g);
    assert.strictEqual(d.estado, 'no_medido');
    assert.match(d.motivo, /los pull requests y los pedidos de GitHub todavía no se leen/);
    assert.ok(!fs.existsSync(path.join(g.fix, 'llamadas.log')), 'no consulta Azure');
  } finally { fs.rmSync(g.d, { recursive: true, force: true }); }
});
