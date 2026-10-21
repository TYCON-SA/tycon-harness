#!/usr/bin/env node
/**
 * state-age.test.js — la edad de cada story en su estado, sumada por producto y estado.
 *
 * Una página que no dice cuántas stories llevan semanas en revisión no sirve para decidir. El dato está en
 * cada foto por proyecto (`dias_en_estado`): hay que sumarlo.
 * «No medido» nunca es cero: una story sin dato va aparte, y una foto vieja no suma.
 *
 *   T1  umbrales estrictos («más de 30» no cuenta los 30)
 *   T2  sin dato aparte, nunca «menos de 30»
 *   T3  cerrado y sin entrega no cuentan; desconocido sólo en desconocido
 *   T4  el titular suma en curso y bloqueado; el backlog sólo en el detalle
 *   T5  producto por proyecto decodificado; sin declarar y compartido
 *   T6  foto vieja, ilegible, sin fotos, producto sin foto: «no medido»
 *   T7  sin los días en params: «no medido», nada escrito en el código
 *   T8  ni ids ni títulos ni rutas en el resultado
 *   T11 paradas y compartidos
 *
 * Los ejemplos son inventados (Acme, Otro, Comun). Correr: node --test scripts/tests/state-age.test.js < /dev/null
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const { stateAge } = require(path.join(RAIZ, 'scripts', 'nightly', 'projects', 'state-age.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'state-age-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* nada */ } });
const HOY = '2026-10-15';
const DIAS = [30, 60];

let n = 0;
// una carpeta de fotos por proyecto: { v, generated_at, proyecto, repo, stories: [{ grupo, canonico, dias_en_estado, … }] }
function fotos(lista) {
  const dir = path.join(TMP, `f${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of lista) {
    const nombre = `${f.proyecto}__${f.repo || 'Specs'}.json`;
    const cuerpo = f.raw !== undefined ? f.raw : JSON.stringify({ v: 1, generated_at: f.generated_at || `${HOY}T06:00:00Z`, proyecto: f.proyecto, repo: f.repo || 'Specs', stories: f.stories || [] });
    fs.writeFileSync(path.join(dir, nombre), cuerpo);
  }
  return dir;
}
let sid = 0;
const st = (grupo, canonico, dias, extra = {}) => ({ id: `9.${++sid}`, titulo: `Story ${sid}`, ruta: `specs/story-9.${sid}.md`, estado: canonico, canonico, grupo, dias_en_estado: dias, ...extra });
const enCurso = (dias) => st('en_curso', 'in-progress', dias);
const productos = (entries) => ({ repos: entries });
const prod = (r, nombre) => r.productos.find((p) => p.producto === nombre);

test('T1 2.26-PorProductoYEstado_UmbralesEstrictos', () => {
  const dir = fotos([{ proyecto: 'Acme', stories: [enCurso(29), enCurso(30), enCurso(31), enCurso(60), enCurso(61)] }]);
  const r = stateAge({ photosDir: dir, products: productos([{ producto: 'Acme', ado: 'Acme/Back' }]), today: HOY, dias: DIAS });
  assert.strictEqual(r.estado, 'medido', JSON.stringify(r));
  const c = prod(r, 'Acme').por_estado['in-progress'];
  assert.deepStrictEqual(c, { total: 5, mas_de_30: 3, mas_de_60: 1, sin_dato: 0 });
});

test('T2 2.26-SinDatoAparte_NuncaBajo30', () => {
  const dir = fotos([{ proyecto: 'Acme', stories: [enCurso(null), enCurso(null), enCurso(40)] }]);
  const r = stateAge({ photosDir: dir, products: productos([{ producto: 'Acme', ado: 'Acme/Back' }]), today: HOY, dias: DIAS });
  const c = prod(r, 'Acme').por_estado['in-progress'];
  assert.strictEqual(c.sin_dato, 2);
  assert.strictEqual(c.mas_de_30, 1);
  assert.strictEqual(r.titular.con_dato, 1);
  assert.strictEqual(r.titular.sin_dato, 2);
  assert.match(r.titular.texto, /2 sin dato/);
});

test('T3 2.26-CerradoYSinEntregaNoCuentan_DesconocidoAparte', () => {
  const dir = fotos([{ proyecto: 'Acme', stories: [st('cerrado', 'done', 90), st('sin_entrega', 'cancelled', 90),
    st('desconocido', null, 90, { estado: 'deferred' }), st('desconocido', null, null, { estado: 'deferred' })] }]);
  const r = stateAge({ photosDir: dir, products: productos([{ producto: 'Acme', ado: 'Acme/Back' }]), today: HOY, dias: DIAS });
  const p = prod(r, 'Acme');
  assert.deepStrictEqual(Object.keys(p.por_estado), []);
  assert.strictEqual(p.desconocido, 2);
  assert.strictEqual(r.titular.sin_dato, 0);
});

test('T4 2.26-Titular_EnCursoYBloqueado', () => {
  const dir = fotos([{ proyecto: 'Acme', stories: [st('backlog', 'backlog', 200), enCurso(40), st('bloqueado', 'blocked', 70)] }]);
  const r = stateAge({ photosDir: dir, products: productos([{ producto: 'Acme', ado: 'Acme/Back' }]), today: HOY, dias: DIAS });
  assert.strictEqual(r.titular.mas_de_30, 2);
  assert.strictEqual(r.titular.mas_de_60, 1);
  assert.match(r.titular.texto, /^2 stories en curso llevan más de 30 días en su estado · 1 más de 60/);
  assert.strictEqual(prod(r, 'Acme').por_estado.backlog.mas_de_30, 1);
});

test('T5 2.26-ProductoPorProyectoDecodificado_SinDeclararYCompartido', () => {
  const dir = fotos([
    { proyecto: 'Acme Ventas', stories: [enCurso(40)] },
    { proyecto: 'Otro', stories: [enCurso(40)] },
    { proyecto: 'Comun', stories: [enCurso(40), enCurso(40), enCurso(40), enCurso(40)] },
  ]);
  const r = stateAge({ photosDir: dir, products: productos([
    { producto: 'Ventas', ado: 'Acme%20Ventas/Back' },
    { producto: 'Uno', ado: 'Comun/Front' }, { producto: 'Dos', ado: 'Comun/Back' },
  ]), today: HOY, dias: DIAS });
  assert.strictEqual(prod(r, 'Ventas').por_estado['in-progress'].total, 1);
  const otro = prod(r, 'Otro');
  assert.strictEqual(otro.sin_producto_declarado, true);
  for (const p of ['Uno', 'Dos']) {
    assert.strictEqual(prod(r, p).compartido_con, 2);
    assert.strictEqual(prod(r, p).por_estado['in-progress'].total, 4);
  }
  // el titular cuenta el proyecto compartido una vez: 1 + 1 + 4, no 10
  assert.strictEqual(r.titular.mas_de_30, 6);
});

test('T6 2.26-FotoViejaIlegibleOSinFotos_NoMedido', () => {
  const dir = fotos([
    { proyecto: 'Acme', stories: [enCurso(40)] },
    { proyecto: 'Viejo', generated_at: '2026-10-12T06:00:00Z', stories: [enCurso(40)] },
    { proyecto: 'Roto', raw: '{no es json' },
  ]);
  const r = stateAge({ photosDir: dir, products: productos([{ producto: 'Acme', ado: 'Acme/Back' }, { producto: 'Sinfoto', ado: 'Sinfoto/Back' }]), today: HOY, dias: DIAS });
  assert.strictEqual(r.titular.mas_de_30, 1);
  const motivos = r.no_medidos.map((x) => x.motivo).join(' | ');
  assert.match(motivos, /foto vieja, del 2026-10-12/);
  assert.match(motivos, /foto ilegible/);
  assert.strictEqual(prod(r, 'Sinfoto').estado, 'no_medido');
  assert.match(prod(r, 'Sinfoto').motivo, /sin foto por proyecto/);
  const vacia = path.join(TMP, 'vacia'); fs.mkdirSync(vacia);
  for (const d of [vacia, path.join(TMP, 'no-existe')]) {
    const v = stateAge({ photosDir: d, products: null, today: HOY, dias: DIAS });
    assert.strictEqual(v.estado, 'no_medido');
    assert.match(v.motivo, /no hay fotos por proyecto/);
  }
});

test('T7 2.26-SinUmbral_NoMedido', () => {
  const dir = fotos([{ proyecto: 'Acme', stories: [enCurso(40)] }]);
  for (const dias of [undefined, [60, 30], [30], ['30', '60'], [30.5, 60]]) {
    const r = stateAge({ photosDir: dir, products: null, today: HOY, dias });
    assert.strictEqual(r.estado, 'no_medido', JSON.stringify(dias));
    assert.match(r.motivo, /edad_en_estado_dias/);
  }
  // los días van en params, al lado de thresholds: thresholds no gana ninguna clave de edad
  for (const f of ['scripts/nightly/dashboard/sources.json', 'pipelines/operations/examples/sources.json']) {
    const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, f), 'utf8'));
    assert.deepStrictEqual(cfg.params && cfg.params.edad_en_estado_dias, [30, 60], f);
    assert.ok(!Object.keys(cfg.thresholds || {}).some((k) => /edad|age/i.test(k)), f);
  }
});

test('T8 2.26-SinIdsNiTitulosEnLaSalida', () => {
  const dir = fotos([{ proyecto: 'Acme', stories: [st('en_curso', 'in-progress', 40, { id: 'ZQX-1', titulo: 'ZQX-EDAD-1', ruta: 'specs/ZQX-EDAD-1.md' })] }]);
  const r = stateAge({ photosDir: dir, products: productos([{ producto: 'Acme', ado: 'Acme/Back' }]), today: HOY, dias: DIAS });
  const s = JSON.stringify(r);
  assert.ok(!s.includes('ZQX'), s);
  assert.ok(!s.includes('specs/'), s);
});

test('T11 2.26-ElCasoDeLa2_23_ParadasYCompartidos', () => {
  const dir = fotos([
    { proyecto: 'Acme', stories: [enCurso(45), enCurso(10), enCurso(null)] },
    { proyecto: 'Comun', stories: [enCurso(5), enCurso(5), enCurso(5), enCurso(5)] },
  ]);
  const r = stateAge({ photosDir: dir, products: productos([
    { producto: 'Acme', ado: 'Acme/Back' }, { producto: 'Uno', ado: 'Comun/Front' }, { producto: 'Dos', ado: 'Comun/Back' },
  ]), today: HOY, dias: [30, 60] });
  assert.strictEqual(prod(r, 'Acme').paradas, 1);
  assert.strictEqual(prod(r, 'Acme').sin_medir, 1);
  for (const p of ['Uno', 'Dos']) assert.strictEqual(prod(r, p).compartido_con, 2);
  // 4 stories del proyecto compartido en el total, no 8: 3 de Acme + 4
  assert.strictEqual(r.titular.con_dato + r.titular.sin_dato, 7);
});

// ── regresiones ──────────────────────────────────────────────────
test('2.26-adv FotoViejaAtribuidaASuProducto', () => {
  const dir = fotos([
    { proyecto: 'Acme', repo: 'Front', generated_at: '2026-10-01T06:00:00Z', stories: [enCurso(40)] },
    { proyecto: 'Beta', repo: 'Back', stories: [enCurso(5)] },
    { proyecto: 'Beta', repo: 'Old', generated_at: '2026-09-01T06:00:00Z', stories: [enCurso(200)] },
    { proyecto: 'Gama', repo: 'Roto', raw: '{no es json' },
  ]);
  const r = stateAge({ photosDir: dir, products: productos([{ producto: 'A', ado: 'Acme/Front' }, { producto: 'B', ado: 'Beta/Back' }, { producto: 'B', ado: 'Beta/Old' }, { producto: 'G', ado: 'Gama/Roto' }]), today: HOY, dias: DIAS });
  // la única foto de A es vieja: «no medido» con ESE motivo, no «sin foto»
  assert.strictEqual(prod(r, 'A').estado, 'no_medido');
  assert.match(prod(r, 'A').motivo, /foto vieja, del 2026-10-01/);
  // B se mide con su foto al día, y dice qué repo le falta
  assert.strictEqual(prod(r, 'B').estado, 'medido');
  assert.strictEqual(prod(r, 'B').repos_no_medidos.length, 1);
  assert.match(prod(r, 'B').repos_no_medidos[0].motivo, /foto vieja/);
  assert.strictEqual(prod(r, 'B').paradas, 0);
  // la ilegible se atribuye por el nombre del archivo
  assert.match(prod(r, 'G').motivo, /foto ilegible/);
});

test('2.26-adv ProyectoSinDeclararConNombreDeProducto_NoSeMezcla', () => {
  const dir = fotos([{ proyecto: 'Zeta', stories: [enCurso(40)] }, { proyecto: 'Ventas', stories: [enCurso(40), enCurso(40)] }]);
  const r = stateAge({ photosDir: dir, products: productos([{ producto: 'Ventas', ado: 'Zeta/Back' }]), today: HOY, dias: DIAS });
  const ventas = r.productos.filter((p) => p.producto === 'Ventas');
  assert.strictEqual(ventas.length, 2, JSON.stringify(r.productos));
  assert.strictEqual(ventas.find((p) => !p.sin_producto_declarado).por_estado['in-progress'].total, 1);
  assert.strictEqual(ventas.find((p) => p.sin_producto_declarado).por_estado['in-progress'].total, 2);
});

test('2.26-adv OtrosDias_LasClavesSalenDeLosDias', () => {
  // las claves de los umbrales salen de params, no de un 30/60 escrito
  const dir = fotos([{ proyecto: 'Acme', stories: [enCurso(5), enCurso(15), enCurso(25)] }]);
  const r = stateAge({ photosDir: dir, products: productos([{ producto: 'Acme', ado: 'Acme/Back' }]), today: HOY, dias: [10, 20] });
  assert.deepStrictEqual(prod(r, 'Acme').por_estado['in-progress'], { total: 3, mas_de_10: 2, mas_de_20: 1, sin_dato: 0 });
  assert.match(r.titular.texto, /^2 stories en curso llevan más de 10 días en su estado · 1 más de 20/);
});

test('2.26-adv CarpetaIlegible_NoEsNoHayFotos', (t) => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) { t.skip('sin permisos que negar acá (constancia, no verde)'); return; }
  const dir = fotos([{ proyecto: 'Acme', stories: [enCurso(40)] }]);
  fs.chmodSync(dir, 0o000);
  try {
    const r = stateAge({ photosDir: dir, products: null, today: HOY, dias: DIAS });
    assert.strictEqual(r.estado, 'no_medido');
    assert.match(r.motivo, /no pude leer la carpeta de fotos \(EACCES\)/);
  } finally { fs.chmodSync(dir, 0o755); }
});
