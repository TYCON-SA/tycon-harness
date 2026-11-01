/**
 * projects-estimates.test.js — La foto por proyecto lee el registro de estimaciones de cada repo de historias: por épica,
 * el rango, el plan, lo vigente y lo real; sin registro o con líneas ilegibles, lo dice en vez de mostrar ceros.
 *
 * Corre con: node --test scripts/tests/projects-estimates.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SNAP = require(path.join(ROOT, 'scripts', 'nightly', 'projects', 'snapshot.js'));
const E = require(path.join(ROOT, 'scripts', 'lib', 'estimates.js'));
const views = require(path.join(ROOT, 'scripts', 'site', 'views.js'));

/** Un repo de historias de laboratorio: git, la huella del arnés y una historia por id (`epic` del primer tramo). */
function repoDeHistorias(historias) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-275-snap-'));
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), 'stories: {}\n');
  for (const [id, status] of historias) {
    fs.writeFileSync(path.join(repo, 'specs', `story-${id}.md`),
      `---\nepic: ${id.split('.')[0]}\nstory: "${id}"\ntitle: "Historia ${id}"\nstatus: ${status}\nsprint: 1\npriority: "P1"\nado_work_item: 9${id.replace('.', '')}\n---\n\nCuerpo.\n`);
  }
  return repo;
}
const registro = (repo, filas) => fs.writeFileSync(path.join(repo, E.REGISTRO), `${filas.map((f) => (typeof f === 'string' ? f : JSON.stringify(E.linea({ cuando: '2026-10-23T00:00:00Z', ...f })))).join('\n')}\n`);
const foto = (repo) => SNAP.fotoDeRepo(repo, { budgetMs: 20000, sdlc: null, sdlcError: 'sin métricas en la prueba' });

test('2.75-T28 Snapshot_LeeElRegistro @story-2.75 @ac-23 — cada épica trae su estimación: rango, plan, vigente y real', () => {
  // 🔴 rojo: la foto no mira el registro, o una épica estimada sin historias escritas no aparece.
  const repo = repoDeHistorias([['3.1', 'done'], ['3.2', 'in-progress']]);
  try {
    registro(repo, [
      { nivel: 'epica', epica: '3', min: 40, max: 60, unidad: 'hours' },
      { nivel: 'plan', epica: '3', historia: '3.1', valor: 20, unidad: 'hours' },
      { nivel: 'plan', epica: '3', historia: '3.2', valor: 30, unidad: 'hours' },
      { nivel: 'historia', epica: '3', historia: '3.2', valor: 45, unidad: 'hours' },
      { nivel: 'real', epica: '3', historia: '3.1', valor: 22, unidad: 'hours', ejecucion: 'r1' },
      { nivel: 'epica', epica: '5', min: 10, max: 20, unidad: 'hours' },
    ]);
    const f = foto(repo);
    assert.deepStrictEqual(f.cobertura.estimaciones, { estado: 'medido', motivo: null, ilegibles: 0, unidad: 'hours' });
    const e3 = f.epicas.find((e) => String(e.id) === '3');
    assert.ok(e3 && e3.estimacion, 'la épica 3 con su estimación');
    const x = e3.estimacion;
    assert.deepStrictEqual([x.rango.min, x.rango.max, x.unidad, x.suma_plan, x.suma_vigente], [40, 60, 'hours', 50, 65]);
    assert.deepStrictEqual([x.dentro, x.fuera, x.por], [false, 'encima', 5]);
    assert.deepStrictEqual(x.en_horas, { min: 40, max: 60, plan: 50, vigente: 65 });
    assert.deepStrictEqual([x.real.cerrada, x.real.faltan], [false, 1], 'abierta: falta lo real de la 3.2');
    // una épica que está en el registro y todavía no tiene historias escritas: tiene fila, con el conteo en cero
    const e5 = f.epicas.find((e) => String(e.id) === '5');
    assert.ok(e5, 'la épica sólo estimada también entra');
    assert.ok(Object.values(e5.conteo).every((n) => n === 0), JSON.stringify(e5.conteo));
    assert.deepStrictEqual([e5.estimacion.rango.min, e5.estimacion.rango.max], [10, 20]);
    // lo que viaja es una lista cerrada: nada de las versiones ni de quién estimó
    assert.ok(!('historias' in x) && !('versiones' in x), Object.keys(x).join(','));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('2.75-T29 Snapshot_SinRegistroOIlegible @story-2.75 @ac-24 — sin registro, «sin estimaciones»; ilegibles, cuántas; una foto anterior, no medido', () => {
  // 🔴 rojo: un repo sin registro muestra ceros, las líneas rotas se callan, o una foto anterior dice «sin estimaciones».
  const repo = repoDeHistorias([['3.1', 'in-progress']]);
  try {
    let f = foto(repo);
    assert.strictEqual(f.cobertura.estimaciones.estado, 'sin_registro');
    assert.ok(f.epicas.every((e) => !e.estimacion), 'sin registro, ninguna épica trae estimación');
    registro(repo, [{ nivel: 'epica', epica: '3', min: 4, max: 8, unidad: 'hours' }, '{ roto', '{"v":1,"nivel":"plan"}']);
    f = foto(repo);
    assert.deepStrictEqual([f.cobertura.estimaciones.estado, f.cobertura.estimaciones.ilegibles], ['medido', 2]);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  // la vista: sin registro, con ilegibles, y una foto anterior a las estimaciones (sin la clave)
  const una = (estimaciones, epicas = []) => ({ proyecto: 'Proy', repo: 'R', fecha: '2026-10-23', vieja: false, stories: [], epicas, ...(estimaciones ? { estimaciones } : {}) });
  const html = (foto1) => views.paginaProyectos({ modelo: { productos: [{ producto: 'Producto P', proyectos: ['Proy'], rutas: [] }], productosFuente: { estado: 'medido' }, proyectos: { estado: 'medido', lista: [foto1] } }, quien: { rol: 'maintainer', email: 'lider@acme.example' }, pestanas: [], ahora: Date.parse('2026-10-23T12:00:00Z') });
  const sec = (h) => h.slice(h.indexOf('id="estimaciones"'));
  assert.match(sec(html(una({ estado: 'sin_registro', motivo: null, ilegibles: 0, unidad: 'hours' }))), /sin estimaciones/);
  assert.doesNotMatch(sec(html(una({ estado: 'sin_registro', motivo: null, ilegibles: 0, unidad: 'hours' }))), /0 h/, 'no ceros');
  assert.match(sec(html(una({ estado: 'medido', motivo: null, ilegibles: 2, unidad: 'hours' }))), /2 líneas ilegibles/);
  const anterior = sec(html(una(null)));
  assert.match(anterior, /no medido/i);
  assert.doesNotMatch(anterior, /sin estimaciones/, 'una foto que no lo midió no dice «sin estimaciones»');
});

test('Adversarial_EpicaSoloReal_NoEsEstimacion @story-2.75 @ac-23 — el cierre anota horas aunque nadie estime: esa épica no tiene fila', () => {
  // 🔴 rojo: la épica con sólo `real` entra como estimación sin unidad y saca el total del producto de horas.
  const repo = repoDeHistorias([['3.1', 'done'], ['9.1', 'done']]);
  try {
    registro(repo, [
      { nivel: 'epica', epica: '3', min: 10, max: 20, unidad: 'hours' },
      { nivel: 'plan', epica: '3', historia: '3.1', valor: 12, unidad: 'hours' },
      { nivel: 'real', epica: '3', historia: '3.1', valor: 11, unidad: 'hours', ejecucion: 'r1' },
      { nivel: 'real', epica: '9', historia: '9.1', valor: 4, unidad: 'hours', ejecucion: 'r2' },
    ]);
    const f = foto(repo);
    assert.strictEqual(f.epicas.find((e) => String(e.id) === '9').estimacion, null);
    assert.ok(f.epicas.find((e) => String(e.id) === '3').estimacion);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('Adversarial_HistoriaQueSeMudo_SinFilaFantasma @story-2.75 @ac-23 — la épica vieja de una historia que cambió de épica no es una fila', () => {
  // 🔴 rojo: la épica vieja (sólo el plan de una historia que ahora es de otra) sale como estimación vacía.
  const repo = repoDeHistorias([['2.1', 'in-progress']]);
  try {
    registro(repo, [{ nivel: 'plan', epica: '1', historia: '2.1', valor: 5, unidad: 'hours' }, { nivel: 'plan', epica: '2', historia: '2.1', valor: 7, unidad: 'hours' }]);
    const f = foto(repo);
    assert.ok(!f.epicas.some((e) => String(e.id) === '1'), JSON.stringify(f.epicas.map((e) => e.id)));
    assert.strictEqual(f.epicas.find((e) => String(e.id) === '2').estimacion.suma_vigente, 7);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('Adversarial_OrdenDeEpicas_SinIdiomaDeLaMaquina @story-2.75 @ac-23 — las épicas sin números salen en el mismo orden en cualquier máquina', () => {
  // 🔴 rojo: el orden depende del idioma de la máquina (localeCompare pone «a» antes que «A»).
  // un repo sin historias no tiene foto: una historia con una épica numérica, que va primero por ser un número
  const repo = repoDeHistorias([['1.1', 'in-progress']]);
  try {
    registro(repo, ['b', 'a', 'A'].map((epica) => ({ nivel: 'epica', epica, min: 1, max: 2, unidad: 'hours' })));
    assert.deepStrictEqual(foto(repo).epicas.map((e) => e.id), [1, 'A', 'a', 'b']);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('Adversarial_EpicaConCeros_UnaSolaFila @story-2.75 @ac-23 — `epic: 02` y la línea del registro con «02» son la misma épica', () => {
  // 🔴 rojo: la épica sale dos veces, una con sus historias sin estimación y otra con la estimación y el conteo en cero.
  const repo = repoDeHistorias([['2.1', 'in-progress']]);
  try {
    const spec = path.join(repo, 'specs', 'story-2.1.md');
    fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('epic: 2', 'epic: 02'));
    registro(repo, [{ nivel: 'epica', epica: '02', min: 10, max: 20, unidad: 'hours' }, { nivel: 'plan', epica: '02', historia: '2.1', valor: 12, unidad: 'hours' }]);
    const f = foto(repo);
    assert.strictEqual(f.epicas.length, 1, JSON.stringify(f.epicas.map((e) => e.id)));
    assert.strictEqual(f.epicas[0].conteo.en_curso, 1);
    assert.deepStrictEqual([f.epicas[0].estimacion.rango.min, f.epicas[0].estimacion.suma_plan], [10, 12]);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('Adversarial_SinRangoYUnidadDelPerfil @story-2.75 @ac-23 — sin rango igual pasa a horas, y la unidad sale del --org-config', () => {
  // 🔴 rojo: una épica en días sin rango queda sin `en_horas`; la foto ignora las tasas del team-repos.json que le pasan.
  const repo = repoDeHistorias([['4.1', 'in-progress']]);
  const cfg = path.join(repo, 'org-team-repos.json');
  try {
    registro(repo, [{ nivel: 'plan', epica: '4', historia: '4.1', valor: 2, unidad: 'days' }]);
    let x = foto(repo).epicas.find((e) => String(e.id) === '4').estimacion;
    assert.deepStrictEqual(x.en_horas, { min: null, max: null, plan: 16, vigente: 16 }, 'días de 8 h de fábrica');
    const TR = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
    const gh = (r) => ({ platform: 'github', org: 'acme', repo: r });
    fs.writeFileSync(cfg, JSON.stringify({ version: TR.VERSION, public: gh('h'), profile: gh('p'), operations: gh('o'), estimates: { unit: 'days', hours_per_day: 6 } }));
    x = SNAP.fotoDeRepo(repo, { budgetMs: 20000, sdlc: null, sdlcError: 'x', orgConfig: cfg }).epicas.find((e) => String(e.id) === '4').estimacion;
    assert.strictEqual(x.en_horas.vigente, 12, 'con el perfil, días de 6 h');
    assert.strictEqual(SNAP.parseArgs(['--repo', repo, '--out', repo, '--org-config', cfg]).orgConfig, cfg);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('Adversarial_TotalParcial_PorUnidadYRepoNoMedido @story-2.75 @ac-23 — el total no se lee completo si falta una épica o un repo', () => {
  // 🔴 rojo: en la suma por unidad una épica sin suma se cae callada, o un repo no medido deja un total que parece entero.
  const est = (o) => ({ rango: null, unidad: 'hours', suma_plan: null, suma_vigente: null, dentro: null, fuera: null, por: null, sumas_por_unidad: null, motivo: null, en_horas: null, real: { cerrada: true, suma: null, faltan: 0, motivo: null }, ...o });
  const f1 = (repo, epicas, estimaciones = { estado: 'medido', motivo: null, ilegibles: 0, unidad: 'hours' }) => ({ proyecto: 'Proy', repo, fecha: '2026-10-23', vieja: false, stories: [], epicas, estimaciones });
  const filas = (lista) => views.filasEstimaciones({ productos: [{ producto: 'P', proyectos: ['Proy'], rutas: [] }], proyectos: { estado: 'medido', lista } })[0];
  const porUnidad = filas([f1('R', [{ id: '1', estimacion: est({ suma_vigente: 12, en_horas: { min: null, max: null, plan: null, vigente: 12 } }) },
    { id: '2', estimacion: est({ unidad: 'points', rango: { min: 5, max: 8, unidad: 'points' } }) }])]);
  assert.strictEqual(porUnidad.total.unidad, null);
  assert.strictEqual(porUnidad.total.parciales.vigente, true, 'la épica en puntos sin suma falta en la suma');
  const conNoMedido = filas([f1('R', [{ id: '1', estimacion: est({ suma_vigente: 12, en_horas: { min: null, max: null, plan: null, vigente: 12 } }) }]), f1('S', [], null)]);
  assert.deepStrictEqual(Object.values(conNoMedido.total.parciales), [true, true, true, true]);
});
