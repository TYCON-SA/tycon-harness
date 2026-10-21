'use strict';
/*
 * assigned-items.test.js — los pedidos abiertos asignados a cada persona, de cada noche (T27).
 *
 * El guion deja `.dashboard/assigned/assigned-<día>.json` para el sitio de la organización, con LISTA BLANCA: id,
 * proyecto, tipo, estado, identidad del asignado, días en el estado, enlace, si es un Bug de dependencias del arnés y el
 * título recortado. Nunca el nombre para mostrar. Abierto es la CATEGORÍA del estado (Proposed o InProgress) según el tipo
 * del pedido en su proyecto, no su nombre; un proyecto que no se puede medir sale «no medido» sólo él.
 * Azure es scripts/tests/lib/fake-az.sh (TYCON_ADO_CMD), con las categorías de cada tipo en
 * `estados-<proyecto>-<tipo>.json`: ningún caso toca la red.
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
// las categorías de estado de un tipo en un proyecto, como las devuelve workItemTypeStates
const estados = (fix, proyecto, tipo, mapa) => fs.writeFileSync(path.join(fix, `estados-${proyecto}-${tipo}.json`),
  JSON.stringify({ value: Object.entries(mapa).map(([name, category]) => ({ name, category })) }));
const ESTANDAR = { New: 'Proposed', Active: 'InProgress', Resolved: 'Resolved', Closed: 'Completed', Removed: 'Removed' };
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
    for (const tipo of ['Bug', 'Task', 'User Story']) estados(m.fix, 'Proyecto X', tipo, ESTANDAR);
    const r = correr(m);
    assert.strictEqual(r.status, 0, r.stderr);
    const d = leer(m);
    assert.strictEqual(d.estado, 'medido');
    assert.strictEqual(d.fecha, HOY);
    assert.deepStrictEqual(d.pedidos.map((p) => p.id), [11, 12, 13]);
    for (const p of d.pedidos) assert.deepStrictEqual(Object.keys(p).sort(), ['asignado', 'dependencias', 'dias_en_estado', 'enlace', 'estado', 'id', 'proyecto', 'tipo', 'titulo']);
    assert.strictEqual(d.pedidos[0].titulo, 'TITULO-SECRETO', 'el título entra al archivo');
    assert.deepStrictEqual(d.proyectos_no_medidos, []);
    const p11 = d.pedidos[0];
    assert.deepStrictEqual([p11.asignado, p11.tipo, p11.estado, p11.dias_en_estado, p11.dependencias], ['dev.a@acme.example', 'Bug', 'Active', 3, true], 'el Bug de dependencias marcado');
    assert.strictEqual(p11.enlace, 'https://dev.azure.com/prueba/Proyecto%20X/_workitems/edit/11');
    assert.strictEqual(d.pedidos[1].dependencias, false);
    assert.strictEqual(d.pedidos[2].dias_en_estado, null, 'sin fecha de estado: null, nunca 0');
    assert.ok(!/NOMBRE-VISIBLE/.test(JSON.stringify(d)), 'sin el nombre para mostrar');
    // la consulta: sólo los proyectos activos de repos.json, una vez cada uno, acotada al proyecto
    const llamadas = fs.readFileSync(path.join(m.fix, 'llamadas.log'), 'utf8').trim().split('\n');
    const wiql = llamadas.filter((l) => l.startsWith('wiql'));
    assert.strictEqual(wiql.length, 1, 'Proyecto X una vez, Proyecto Y (inactivo) ninguna');
    const lote = llamadas.filter((l) => l.startsWith('lote')).map((l) => JSON.parse(l.split('\t')[1]));
    assert.ok(lote.length >= 1);
    for (const l of lote) assert.ok(Object.values(l.archivos).join('').includes('System.Title'), 'el lote pide el título');
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

// ── abierto por categoría, el título, el orden y el proyecto que no se puede medir ─────────────────────

const RIESGO = { Identificado: 'Proposed', 'En Mitigación': 'InProgress', 'Mitigado de Riesgo': 'Completed', Desplegado: 'Completed', Descartado: 'Removed' };
const pedido = (fix, id, extra) => wi(fix, id, { 'System.TeamProject': 'Proyecto X', 'System.WorkItemType': 'Bug', 'System.State': 'Active',
  'System.AssignedTo': { uniqueName: 'dev.a@acme.example' }, 'System.Title': `pedido ${id}`, ...extra });
const listaWiql = (fix, proyecto, ids) => fs.writeFileSync(path.join(fix, `wiql-${proyecto}.json`), JSON.stringify({ workItems: ids.map((id) => ({ id })) }));
const llamadasDe = (m, paso) => fs.readFileSync(path.join(m.fix, 'llamadas.log'), 'utf8').trim().split('\n').filter((l) => l.startsWith(`${paso}\t`)).map((l) => JSON.parse(l.split('\t')[1]));

test('T1 Asignados_SoloCategoriasAbiertas', () => {
  const m = mundo();
  try {
    listaWiql(m.fix, 'Proyecto X', [1, 2, 3, 4, 5]);
    estados(m.fix, 'Proyecto X', 'Riesgo', RIESGO);
    estados(m.fix, 'Proyecto X', 'Bug', ESTANDAR);
    pedido(m.fix, 1, { 'System.WorkItemType': 'Riesgo', 'System.State': 'Desplegado' });
    pedido(m.fix, 2, { 'System.WorkItemType': 'Riesgo', 'System.State': 'Mitigado de Riesgo' });
    pedido(m.fix, 3, { 'System.State': 'Resolved' });
    pedido(m.fix, 4, { 'System.WorkItemType': 'Riesgo', 'System.State': 'En Mitigación' });
    pedido(m.fix, 5, { 'System.State': 'New' });
    const r = correr(m);
    assert.strictEqual(r.status, 0, r.stderr);
    const d = leer(m);
    assert.strictEqual(d.estado, 'medido');
    assert.deepStrictEqual(d.pedidos.map((p) => p.id).sort(), [4, 5], 'sólo Proposed e InProgress, también con estados propios');
  } finally { fs.rmSync(m.d, { recursive: true, force: true }); }
});

test('T2 Asignados_CategoriasDeSuTipo_UnaVezCadaUna', () => {
  const m = mundo();
  try {
    listaWiql(m.fix, 'Proyecto X', [1, 2, 3]);
    // «Cerrado» es abierto para el Bug de este proceso y terminado para el Riesgo: cada uno con las de su tipo
    estados(m.fix, 'Proyecto X', 'Bug', { ...ESTANDAR, Cerrado: 'InProgress' });
    estados(m.fix, 'Proyecto X', 'Riesgo', { ...RIESGO, Cerrado: 'Completed' });
    pedido(m.fix, 1, { 'System.State': 'Cerrado' });
    pedido(m.fix, 2, { 'System.WorkItemType': 'Riesgo', 'System.State': 'Cerrado' });
    pedido(m.fix, 3, { 'System.State': 'Active' });
    const r = correr(m);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(leer(m).pedidos.map((p) => p.id).sort(), [1, 3]);
    const tipos = llamadasDe(m, 'estados').map((l) => l.args.find((a) => a.startsWith('type=')));
    assert.deepStrictEqual(tipos.sort(), ['type=Bug', 'type=Riesgo'], 'una lectura por proyecto y tipo');
    for (const w of llamadasDe(m, 'wiql')) assert.ok(!/NOT IN/i.test(Object.values(w.archivos).join('')), 'la consulta no excluye estados por nombre');
  } finally { fs.rmSync(m.d, { recursive: true, force: true }); }
});

test('T3 Asignados_ProyectoIlegible_SoloEseNoMedido', () => {
  const dosProyectos = (m) => fs.writeFileSync(m.repos, JSON.stringify({ azure: { org: 'https://dev.azure.com/prueba' }, repos: [
    { producto: 'Producto X', ruta: 'X/back', ado: 'Proyecto X/Back', activo: true },
    { producto: 'Producto Y', ruta: 'Y/back', ado: 'Proyecto Y/Back', activo: true },
  ] }));
  const armar = (m) => {
    dosProyectos(m);
    listaWiql(m.fix, 'Proyecto X', [1]);
    listaWiql(m.fix, 'Proyecto Y', [2]);
    estados(m.fix, 'Proyecto X', 'Bug', ESTANDAR);
    pedido(m.fix, 1, {});
    pedido(m.fix, 2, { 'System.TeamProject': 'Proyecto Y', 'System.WorkItemType': 'Riesgo' });
  };
  // (a) sin categorías para el tipo Riesgo de Proyecto Y; (b) categorías sin «category»; (c) su consulta falla
  const casos = [
    ['sin categorías', () => {}, {}, /Proyecto Y/, /Riesgo/],
    ['sin category', (m) => fs.writeFileSync(path.join(m.fix, 'estados-Proyecto Y-Riesgo.json'), JSON.stringify({ value: [{ name: 'Active' }] })), {}, /Proyecto Y/, /Riesgo/],
    ['consulta fallida', (m) => estados(m.fix, 'Proyecto Y', 'Riesgo', RIESGO), { TYCON_AZ_FAIL: 'wiql:Proyecto Y' }, /Proyecto Y/, null],
  ];
  for (const [nombre, preparar, env, conProyecto, conTipo] of casos) {
    const m = mundo();
    try {
      armar(m);
      preparar(m);
      const r = correr(m, [], env);
      assert.strictEqual(r.status, 1, `${nombre}: un proyecto sin medir sale 1`);
      const d = leer(m);
      assert.strictEqual(d.estado, 'medido', `${nombre}: los demás proyectos quedan medidos`);
      assert.deepStrictEqual(d.pedidos.map((p) => p.id), [1], `${nombre}: los del otro proyecto, ninguno del roto`);
      assert.strictEqual(d.proyectos_no_medidos.length, 1, nombre);
      assert.strictEqual(d.proyectos_no_medidos[0].proyecto, 'Proyecto Y', nombre);
      assert.match(d.proyectos_no_medidos[0].motivo, conProyecto, nombre);
      if (conTipo) assert.match(d.proyectos_no_medidos[0].motivo, conTipo, `${nombre}: el motivo dice el tipo`);
    } finally { fs.rmSync(m.d, { recursive: true, force: true }); }
  }
  // los dos rotos: la noche entera no medida
  const m = mundo();
  try {
    armar(m);
    fs.rmSync(path.join(m.fix, 'estados-Proyecto X-Bug.json'));
    const r = correr(m);
    assert.strictEqual(r.status, 1);
    const d = leer(m);
    assert.strictEqual(d.estado, 'no_medido');
    assert.deepStrictEqual(d.pedidos, []);
    assert.ok(d.motivo);
    assert.deepStrictEqual(d.proyectos_no_medidos.map((p) => p.proyecto), ['Proyecto X', 'Proyecto Y']);
  } finally { fs.rmSync(m.d, { recursive: true, force: true }); }
});

test('T4 Asignados_TituloRecortado', () => {
  const m = mundo();
  try {
    listaWiql(m.fix, 'Proyecto X', [1, 2]);
    estados(m.fix, 'Proyecto X', 'Bug', ESTANDAR);
    pedido(m.fix, 1, { 'System.Title': `  primera\nlínea   ${'x'.repeat(300)}` });
    pedido(m.fix, 2, { 'System.Title': '   ' });
    const r = correr(m);
    assert.strictEqual(r.status, 0, r.stderr);
    const [p1, p2] = leer(m).pedidos.sort((a, b) => a.id - b.id);
    assert.strictEqual(p1.titulo.length, 120);
    assert.ok(p1.titulo.startsWith('primera línea x'), 'una sola línea, sin espacios repetidos');
    assert.strictEqual(p2.titulo, null, 'sin título: null');
  } finally { fs.rmSync(m.d, { recursive: true, force: true }); }
});

test('T5 Asignados_MasRecientePrimero', () => {
  const m = mundo();
  try {
    listaWiql(m.fix, 'Proyecto X', [1, 2, 3, 4, 5]);
    estados(m.fix, 'Proyecto X', 'Bug', ESTANDAR);
    pedido(m.fix, 1, { 'System.ChangedDate': '2026-10-01T10:00:00Z' });
    pedido(m.fix, 2, {});
    pedido(m.fix, 3, { 'System.ChangedDate': '2026-10-14T10:00:00Z' });
    pedido(m.fix, 4, { 'System.ChangedDate': '2026-10-01T10:00:00Z' });
    pedido(m.fix, 5, { 'System.ChangedDate': '2026-10-10T08:00:00Z' });
    const r = correr(m);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(leer(m).pedidos.map((p) => p.id), [3, 5, 1, 4, 2], 'el más reciente primero, sin fecha al final, empate por id');
  } finally { fs.rmSync(m.d, { recursive: true, force: true }); }
});

// el tipo y el estado no se recortan a 40 caracteres ANTES de buscar su categoría
test('T9 Asignados_TipoYEstadoLargos_SeJuzganEnteros', () => {
  const TIPO = 'Requerimiento de Cambio de Configuración Mayor';   // 46 caracteres
  const ESTADO = 'En Revisión del Comité de Arquitectura Técnica';    // 46 caracteres
  const m = mundo();
  try {
    listaWiql(m.fix, 'Proyecto X', [1]);
    estados(m.fix, 'Proyecto X', TIPO, { [ESTADO]: 'InProgress', Cerrado: 'Completed' });
    pedido(m.fix, 1, { 'System.WorkItemType': TIPO, 'System.State': ESTADO });
    const r = correr(m);
    assert.strictEqual(r.status, 0, r.stderr);
    const d = leer(m);
    assert.deepStrictEqual(d.pedidos.map((p) => p.id), [1], 'se juzga con el tipo y el estado enteros');
    assert.strictEqual(d.pedidos[0].estado.length, 40, 'lo que se ESCRIBE sigue recortado');
  } finally { fs.rmSync(m.d, { recursive: true, force: true }); }
  // un estado que su tipo ya no declara (por ejemplo, Tasks en «Closed» tras un cambio de proceso): no se muestra,
  // se cuenta, y el proyecto sigue medido
  const n = mundo();
  try {
    listaWiql(n.fix, 'Proyecto X', [1, 2, 3]);
    estados(n.fix, 'Proyecto X', 'Bug', ESTANDAR);
    pedido(n.fix, 1, { 'System.State': 'Estado Viejo' });
    pedido(n.fix, 2, { 'System.State': 'Estado Viejo' });
    pedido(n.fix, 3, {});
    const r = correr(n);
    assert.strictEqual(r.status, 0, r.stderr);
    const d = leer(n);
    assert.strictEqual(d.estado, 'medido');
    assert.deepStrictEqual(d.pedidos.map((p) => p.id), [3]);
    assert.deepStrictEqual(d.proyectos_no_medidos, []);
    assert.deepStrictEqual(d.estados_sin_categoria, [{ proyecto: 'Proyecto X', tipo: 'Bug', estado: 'Estado Viejo', pedidos: 2 }]);
    assert.match(r.stdout, /2 pedido\(s\) del tipo Bug en «Estado Viejo»/);
  } finally { fs.rmSync(n.d, { recursive: true, force: true }); }
});
