'use strict';
/*
 * site-decisions.test.js — «dónde se decide»: cada tarjeta de «Qué decidir hoy» lleva a la lista exacta de lo que hay
 * que decidir, una ficha por renglón con el enlace a SU pedido, y nunca a la portada del repo de operaciones.
 *
 * Decisiones_PorFicha_EnlaceAlPedidoExacto     Decisiones_FichaSinPr_ApareceConElPorQue
 * Decisiones_FuenteAbierta_SeListaIgual        Inicio_NingunaTarjetaALaPortada
 * Inicio_SinRepoNavegable_LaListaLoDice        Inicio_Declarados_DicenDondeSeDecidenSinEnlace
 * Fuentes_LeeElPedidoDeCadaFicha               Decisiones_PrCerradoSinTarea_NadieLoSigueYVaPrimero
 * Decisiones_PrCerradoConTarea_SeSigueEnSuTarea Decisiones_Orden_NadieGravedadNoches
 * Fuentes_LeeElSeguimientoDeLaFicha             Inicio_CadaFilaDiceSuGravedadYSusNoches
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SITE = path.join(__dirname, '..', 'site');
const decisions = require(path.join(SITE, 'decisions.js'));
const views = require(path.join(SITE, 'views.js'));
const sources = require(path.join(SITE, 'sources.js'));

const HOY = '2026-10-22';
const AHORA = Date.parse(`${HOY}T12:00:00Z`);
const ADO = 'https://dev.azure.com/acme/arnes/_git/operaciones';
const GH = 'https://github.com/acme/operaciones';
const medida = (extra) => ({ estado: 'medido', codigo: null, motivo: null, fecha: HOY, ...extra });

/** Un modelo con las dos colas y sus fichas, como lo arma sources.js. */
function modelo() {
  return {
    dependencias: medida({ rubros: { nuevos: 2, aceptadas_sin_resolver: 0, rechazadas_sin_deuda: 0, pedidos_cerrados_con_vivas: 0 } }),
    vigilante: medida({ pendientes: 1, aceptadas_sin_story: 0, productos: [] }),
    declarados: medida({ lista: [{ id: 'GHSA-xxxx', review_before: '2026-10-25' }] }),
    decisiones: medida({
      items: [
        { fuente: 'dependencias', rubro: 'nuevos', id: '0da8b2f2', titulo: 'paquete-a', pr: 5255 },
        { fuente: 'dependencias', rubro: 'nuevos', id: '171bed99', titulo: 'paquete-b', pr: null },
        { fuente: 'vigilante', rubro: 'pendientes', id: '2026-10-16-tienda-58d02289', titulo: 'tienda · deriva', pr: 4669 },
      ],
    }),
  };
}

test('Decisiones_PorFicha_EnlaceAlPedidoExacto', () => {
  const ado = decisions.decisiones(modelo(), { operationsRepo: `${ADO}.git` });
  const una = ado.find((d) => d.id === '0da8b2f2');
  assert.strictEqual(una.enlace, `${ADO}/pullrequest/5255`, 'Azure DevOps: el pedido de esa ficha');
  assert.strictEqual(una.fuente, 'dependencias');
  assert.strictEqual(una.sinLugar, null);
  const gh = decisions.decisiones(modelo(), { operationsRepo: GH });
  assert.strictEqual(gh.find((d) => d.id === '2026-10-16-tienda-58d02289').enlace, `${GH}/pull/4669`, 'GitHub: /pull/<n>');
});

test('Decisiones_FichaSinPr_ApareceConElPorQue', () => {
  const ds = decisions.decisiones(modelo(), { operationsRepo: ADO });
  const sin = ds.find((d) => d.id === '171bed99');
  assert.ok(sin, 'la ficha sin pedido se lista igual');
  assert.strictEqual(sin.enlace, null);
  assert.strictEqual(sin.sinLugar, 'sin_pedido');
  // sin una dirección https del repo de operaciones, ninguna lleva enlace y todas dicen por qué
  for (const d of decisions.decisiones(modelo(), { operationsRepo: 'ssh://ssh.dev.azure.com/v3/acme/arnes/operaciones' })) {
    assert.strictEqual(d.enlace, null);
    assert.ok(d.sinLugar, d.id);
  }
  assert.strictEqual(decisions.decisiones(modelo(), { operationsRepo: 'https://git.example.com/acme/operaciones' })[0].sinLugar, 'plataforma_desconocida');
  assert.match(decisions.fraseSinLugar('sin_pedido', 'es'), /pull request/);
});

// una aceptada ya se decidió y la noche no le abre otro pedido: no dice «la noche lo abre», lleva a su tarea
test('Decisiones_AceptadaSinPr_SeSigueEnSuTarea', () => {
  const m = modelo();
  m.dependencias.rubros.aceptadas_sin_resolver = 1;
  m.decisiones.items.push({ fuente: 'dependencias', rubro: 'aceptadas_sin_resolver', id: '9abc1234', titulo: 'paquete-c', pr: null });
  const d = decisions.decisiones(m, { operationsRepo: ADO }).find((x) => x.id === '9abc1234');
  assert.deepStrictEqual([d.enlace, d.sinLugar], [null, 'en_su_tarea']);
  // sin repo navegable también: el lugar es Mantenimiento, no el repo de operaciones
  assert.strictEqual(decisions.decisiones(m, { operationsRepo: null }).find((x) => x.id === '9abc1234').sinLugar, 'en_su_tarea');
  // una nueva sin pedido sigue esperando a la noche
  assert.strictEqual(decisions.decisiones(m, { operationsRepo: ADO }).find((x) => x.id === '171bed99').sinLugar, 'sin_pedido');
  const html = views.listasDeDecision(m, { enlaceOperaciones: ADO, ahora: AHORA });
  const seccion = html.split('id="decidir-dependencias_aceptadas_sin_resolver"')[1].split('</section>')[0];
  // la fila en dos partes, para que la grilla alinee todas: el enlace adelante y el texto después
  assert.match(seccion, /<li><a href="\/mantenimiento">ya decidida: se sigue en su tarea, en Mantenimiento<\/a><span>9abc1234 · paquete-c<\/span><\/li>/);
  assert.doesNotMatch(seccion, /la noche lo abre/);
});

test('Decisiones_FuenteAbierta_SeListaIgual', () => {
  const m = modelo();
  m.decisiones.items.push({ fuente: 'ejecuciones', rubro: 'pendientes', id: 'e-1', titulo: 'una ejecución', pr: 77 });
  const e = decisions.decisiones(m, { operationsRepo: ADO }).find((d) => d.id === 'e-1');
  assert.ok(e, 'una fuente que el sitio todavía no dibuja se devuelve igual');
  assert.strictEqual(e.enlace, `${ADO}/pullrequest/77`);
  // sin la lista medida: nada, nunca un renglón inventado
  assert.deepStrictEqual(decisions.decisiones({ decisiones: { estado: 'no_medido', codigo: 'sin_foto' } }, { operationsRepo: ADO }), []);
});

test('Inicio_NingunaTarjetaALaPortada', () => {
  const filas = views.filasInicioMantenedor(modelo(), { ahora: AHORA, enlaceOperaciones: ADO });
  for (const f of filas) assert.notStrictEqual(f.enlace, ADO, `${f.clave} no lleva a la portada`);
  const dep = filas.find((f) => f.clave === 'dependencias_por_decidir');
  // las dependencias se deciden en Mantenimiento, una fila por ficha con Aceptar o Rechazar
  assert.strictEqual(dep.enlace, '/mantenimiento');
  assert.strictEqual(filas.find((f) => f.clave === 'vigilante_pendientes').enlace, '#decidir-vigilante_pendientes');
  // la lista a la que lleva: un renglón por ficha, con el enlace a su pedido o el motivo
  const html = views.listasDeDecision(modelo(), { enlaceOperaciones: ADO });
  // las nuevas de anoche no tienen lista propia: todas las que esperan están en Mantenimiento
  assert.doesNotMatch(html, /id="decidir-dependencias_nuevas"/);
  assert.match(html, /id="decidir-vigilante_pendientes"[\s\S]*pullrequest\/4669/);
});

test('Inicio_SinRepoNavegable_LaListaLoDice', () => {
  const html = views.listasDeDecision(modelo(), { enlaceOperaciones: null });
  assert.doesNotMatch(html, /href=/, 'sin dirección navegable no se inventa un enlace');
  assert.match(html, /no tiene una dirección https/i);
});

test('Inicio_Declarados_DicenDondeSeDecidenSinEnlace', () => {
  const filas = views.filasInicioMantenedor(modelo(), { ahora: AHORA, enlaceOperaciones: ADO });
  const dec = filas.find((f) => f.clave === 'declarados_por_vencer');
  assert.strictEqual(dec.enlace, '#decidir-declarados_por_vencer');
  const html = views.listasDeDecision(modelo(), { enlaceOperaciones: ADO, ahora: AHORA });
  const seccion = html.split('id="decidir-declarados_por_vencer"')[1].split('</section>')[0];
  assert.match(seccion, /pending-vulnerabilities\.json/, 'dice dónde se decide');
  assert.match(seccion, /GHSA-xxxx · vence el 2026-10-25/, 'y lista lo que vence');
  assert.doesNotMatch(seccion, /href=/, 'sin enlace: no hay un pedido');
});

test('Fuentes_LeeElPedidoDeCadaFicha', (t) => {
  const clon = fs.mkdtempSync(path.join(os.tmpdir(), 'decisiones-'));
  t.after(() => fs.rmSync(clon, { recursive: true, force: true }));
  const escribir = (rel, cont) => { const p = path.join(clon, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof cont === 'string' ? cont : JSON.stringify(cont)); };
  escribir(`.dashboard/dependencias/dependencias-${HOY}.json`, { resumen: { rubros: {
    nuevos: { valor: [{ id: '0da8b2f2', paquete: 'paquete-a' }, { id: '171bed99', paquete: 'paquete-b' }, { id: '../afuera', paquete: 'x' }] },
    aceptadas_sin_resolver: { valor: [] }, rechazadas_sin_deuda: { valor: [] }, pedidos_cerrados_con_vivas: { valor: [] } } } });
  escribir(`.dashboard/vigilante/vigilante-${HOY}.json`, { resumen: { rubros: { pendientes: { valor: [{ id: '2026-10-16-tienda-58d02289', producto: 'tienda', regla: 'deriva' }] }, aceptadas_sin_story: { valor: [] } } } });
  escribir('inbox/dependencies/pending/0da8b2f2.yaml', 'id: 0da8b2f2\nveredicto: pendiente\npr: 5255\n');
  escribir('inbox/dependencies/pending/171bed99.yaml', 'id: 171bed99\nveredicto: pendiente\n');
  escribir('inbox/watcher/pending/2026-10-16-tienda-58d02289.yaml', 'id: x\npr: 4669\n');
  const m = sources.construirDesdeClon(clon, { ahora: AHORA });
  assert.strictEqual(m.decisiones.estado, 'medido');
  const por = Object.fromEntries(m.decisiones.items.map((d) => [d.id, d]));
  assert.strictEqual(por['0da8b2f2'].pr, 5255);
  assert.strictEqual(por['0da8b2f2'].titulo, 'paquete-a');
  assert.strictEqual(por['171bed99'].pr, null, 'sin pr: en la ficha');
  assert.strictEqual(por['2026-10-16-tienda-58d02289'].pr, 4669);
  assert.strictEqual(por['2026-10-16-tienda-58d02289'].fuente, 'vigilante');
  assert.ok(!por['../afuera'], 'un id con forma de ruta no se lee');
  // el conteo de siempre no cambia
  assert.strictEqual(m.dependencias.rubros.nuevos, 3);
});

test('8.101-Decisiones_SinRemotoComoHoy_ConRemotoEnlaza', () => {
  const resumen = (ds) => ds.map((d) => `${d.id}:${d.enlace}:${d.sinLugar}`);
  // sin `remoto`, y con `remoto: null`, exactamente lo de hoy en cada caso
  for (const operationsRepo of [`${ADO}.git`, GH, 'https://git.example.com/acme/operaciones', 'ssh://ssh.dev.azure.com/v3/acme/arnes/operaciones', null]) {
    assert.deepStrictEqual(resumen(decisions.decisiones(modelo(), { operationsRepo, remoto: null })), resumen(decisions.decisiones(modelo(), { operationsRepo })), String(operationsRepo));
  }
  assert.strictEqual(decisions.decisiones(modelo(), { operationsRepo: 'https://dev.azure.example/acme/Producto%20X/_git/operaciones' })[0].sinLugar, 'plataforma_desconocida');
  // con el remoto ya resuelto (el que declara la plataforma de ejemplo), cada renglón con su pedido
  const remoto = { platform: 'azure', web: 'https://dev.azure.example/acme/Producto%20X/_git/operaciones' };
  const ds = decisions.decisiones(modelo(), { operationsRepo: remoto.web, remoto });
  assert.strictEqual(ds.find((d) => d.id === '0da8b2f2').enlace, `${remoto.web}/pullrequest/5255`);
  assert.strictEqual(ds.find((d) => d.id === '171bed99').sinLugar, 'sin_pedido', 'una ficha sin pedido sigue diciendo por qué');
  const gh = decisions.decisiones(modelo(), { operationsRepo: GH, remoto: { platform: 'github', web: `${GH}.git` } });
  assert.strictEqual(gh.find((d) => d.id === '2026-10-16-tienda-58d02289').enlace, `${GH}/pull/4669`);
  // un remoto sin plataforma no inventa un enlace
  assert.strictEqual(decisions.decisiones(modelo(), { operationsRepo: remoto.web, remoto: { platform: null, web: remoto.web } })[0].sinLugar, 'plataforma_desconocida');
});

/** Una aceptada como la arma sources.js, con lo que anota su ficha. */
const aceptada = (id, extra) => ({ fuente: 'dependencias', rubro: 'aceptadas_sin_resolver', id, titulo: `paquete-${id}`, pr: null, prCerrado: false, conTarea: false, severidad: 'high', noches: 1, ...extra });
const conAceptadas = (...items) => { const m = modelo(); m.decisiones.items = items; return m; };

// el pull request se abandonó y nadie le creó una tarea: no se muestra como su seguimiento
test('Decisiones_PrCerradoSinTarea_NadieLoSigueYVaPrimero', () => {
  const m = conAceptadas(aceptada('aaaa0001', { severidad: 'critical', noches: 7, conTarea: true }), aceptada('ffff0002', { pr: 5430, prCerrado: true, severidad: 'low' }));
  const ds = decisions.decisiones(m, { operationsRepo: ADO });
  assert.deepStrictEqual(ds.map((d) => `${d.id}:${d.sinLugar}:${d.enlace}`), ['ffff0002:nadie_lo_sigue:null', 'aaaa0001:en_su_tarea:null'], 'sale primero aunque sea baja');
  const html = views.listasDeDecision(m, { enlaceOperaciones: ADO, ahora: AHORA });
  const seccion = html.split('id="decidir-dependencias_aceptadas_sin_resolver"')[1].split('</section>')[0];
  assert.match(seccion, /ffff0002 · paquete-ffff0002 · baja · 1 noche · pull request #5430 cerrado sin resolver: nadie lo sigue/);
  assert.doesNotMatch(seccion, /pullrequest\/5430/, 'el pull request cerrado no es un enlace a su seguimiento');
  assert.ok(seccion.indexOf('ffff0002') < seccion.indexOf('aaaa0001'), 'en la página también va primero');
  assert.match(decisions.fraseSinLugar('nadie_lo_sigue', 'en', { n: 5430 }), /#5430 closed without a fix: nobody follows it/);
});

// el caso medido del 3/11: la noche del 29/10 anotó el pull request cerrado y creó las tareas en el mismo paso
test('Decisiones_PrCerradoConTarea_SeSigueEnSuTarea', () => {
  const m = conAceptadas(aceptada('18eb40cc', { pr: 5430, prCerrado: true, conTarea: true }), aceptada('bbbb0003', { pr: 5300 }));
  const ds = decisions.decisiones(m, { operationsRepo: ADO });
  assert.deepStrictEqual([ds.find((d) => d.id === '18eb40cc').sinLugar, ds.find((d) => d.id === '18eb40cc').enlace], ['en_su_tarea', null]);
  // un pull request todavía abierto sigue siendo su lugar
  assert.strictEqual(ds.find((d) => d.id === 'bbbb0003').enlace, `${ADO}/pullrequest/5300`);
  const html = views.listasDeDecision(m, { enlaceOperaciones: ADO, ahora: AHORA });
  assert.match(html, /<li><a href="\/mantenimiento">ya decidida: se sigue en su tarea, en Mantenimiento<\/a><span>18eb40cc · paquete-18eb40cc · alta · 1 noche<\/span><\/li>/);
  assert.doesNotMatch(html, /pull request #5430/);
  // las otras colas no cambian: un pull request cerrado de otra lista no se reinterpreta
  const nueva = decisions.decisiones(conAceptadas({ ...aceptada('cccc0004', { pr: 5431, prCerrado: true }), rubro: 'nuevos' }), { operationsRepo: ADO })[0];
  assert.strictEqual(nueva.enlace, `${ADO}/pullrequest/5431`);
});

test('Decisiones_Orden_NadieGravedadNoches', () => {
  const m = conAceptadas(
    aceptada('a-baja', { severidad: 'low', noches: 9, conTarea: true }),
    aceptada('a-media', { severidad: 'moderate', noches: 9, conTarea: true }),
    aceptada('a-alta-1', { severidad: 'high', noches: 1, conTarea: true }),
    aceptada('a-alta-7', { severidad: 'high', noches: 7, conTarea: true }),
    aceptada('a-critica', { severidad: 'critical', noches: 2, conTarea: true }),
    aceptada('a-sin-gravedad', { severidad: null, noches: 30, conTarea: true }),
    aceptada('z-nadie-alta', { pr: 1, prCerrado: true, severidad: 'high', noches: 1 }),
    aceptada('y-nadie-critica', { pr: 2, prCerrado: true, severidad: 'critical', noches: 1 }),
  );
  assert.deepStrictEqual(decisions.decisiones(m, { operationsRepo: ADO }).map((d) => d.id),
    ['y-nadie-critica', 'z-nadie-alta', 'a-critica', 'a-alta-7', 'a-alta-1', 'a-media', 'a-baja', 'a-sin-gravedad']);
  // a igualdad de todo, por id: el orden no depende del orden de la foto
  const iguales = [aceptada('b2'), aceptada('b1')];
  assert.deepStrictEqual(decisions.decisiones(conAceptadas(...iguales), {}).map((d) => d.id), ['b1', 'b2']);
  assert.deepStrictEqual(decisions.decisiones(conAceptadas(...iguales.reverse()), {}).map((d) => d.id), ['b1', 'b2']);
});

test('Fuentes_LeeElSeguimientoDeLaFicha', (t) => {
  const clon = fs.mkdtempSync(path.join(os.tmpdir(), 'decisiones-'));
  t.after(() => fs.rmSync(clon, { recursive: true, force: true }));
  const escribir = (rel, cont) => { const p = path.join(clon, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof cont === 'string' ? cont : JSON.stringify(cont)); };
  escribir(`.dashboard/dependencias/dependencias-${HOY}.json`, { resumen: { rubros: {
    nuevos: { valor: [] }, rechazadas_sin_deuda: { valor: [] }, pedidos_cerrados_con_vivas: { valor: [] },
    aceptadas_sin_resolver: { valor: [{ id: '18eb40cc', paquete: 'ws' }, { id: '2541df17', paquete: 'brace-expansion' }, { id: '9abc1234', paquete: 'otro' }] } } } });
  // como la ficha real: pull request cerrado y sus tareas por proyecto
  escribir('inbox/dependencies/promoted/18eb40cc.yaml', 'id: 18eb40cc\npaquete: ws\nseveridad: high\nnoches: 7\npr: 5430\npr_cerrado: 2026-10-29\nrepos:\n  - A/b\npedidos:\n  - Proyecto A: 5498\n  - Proyecto B: 5499\nasignados:\n  - 5498: alguien\n');
  // pull request cerrado y la lista de tareas vacía
  escribir('inbox/dependencies/promoted/2541df17.yaml', 'id: 2541df17\nseveridad: critical\nnoches: 3\npr: 5257\npr_cerrado: 2026-10-29\npedidos:\nasignados:\n  - 5257: alguien\n');
  escribir('inbox/dependencies/promoted/9abc1234.yaml', 'id: 9abc1234\nseveridad: low\n');
  const m = sources.construirDesdeClon(clon, { ahora: AHORA });
  const por = Object.fromEntries(m.decisiones.items.map((d) => [d.id, d]));
  assert.deepStrictEqual([por['18eb40cc'].pr, por['18eb40cc'].prCerrado, por['18eb40cc'].conTarea, por['18eb40cc'].severidad, por['18eb40cc'].noches], [5430, true, true, 'high', 7]);
  assert.deepStrictEqual([por['2541df17'].prCerrado, por['2541df17'].conTarea], [true, false], 'los asignados no son tareas');
  assert.deepStrictEqual([por['9abc1234'].pr, por['9abc1234'].prCerrado, por['9abc1234'].conTarea, por['9abc1234'].noches], [null, false, false, null]);
  const ds = decisions.decisiones(m, { operationsRepo: ADO });
  assert.deepStrictEqual(ds.map((d) => `${d.id}:${d.sinLugar}`), ['2541df17:nadie_lo_sigue', '18eb40cc:en_su_tarea', '9abc1234:en_su_tarea']);
});

// el orden se entiende al leer: cada fila dice su gravedad y cuántas noches lleva
test('Inicio_CadaFilaDiceSuGravedadYSusNoches', () => {
  const m = conAceptadas(
    aceptada('a1', { severidad: 'critical', noches: 7, conTarea: true }),
    aceptada('a2', { severidad: 'moderate', noches: 1, conTarea: true }),
    aceptada('a3', { severidad: 'rara', noches: null, conTarea: true }),
  );
  const seccion = (idioma) => views.listasDeDecision(m, { enlaceOperaciones: ADO, ahora: AHORA, idioma })
    .split('id="decidir-dependencias_aceptadas_sin_resolver"')[1].split('</section>')[0];
  const es = seccion('es');
  assert.match(es, /<span>a1 · paquete-a1 · crítica · 7 noches<\/span>/);
  assert.match(es, /<span>a2 · paquete-a2 · media · 1 noche<\/span>/, 'una noche, en singular; «moderate» es media');
  assert.match(es, /<span>a3 · paquete-a3<\/span>/, 'sin gravedad reconocida ni noches, no se inventan');
  assert.match(seccion('en'), /<span>a1 · paquete-a1 · critical · 7 nights<\/span>/);
  assert.deepStrictEqual(['critical', 'CRÍTICA', 'high', 'moderate', 'baja', 'rara', null].map(decisions.gravedadNormal), ['critical', 'critical', 'high', 'medium', 'low', null, null]);
});
