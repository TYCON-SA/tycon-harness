'use strict';
/*
 * site-decisions.test.js — «dónde se decide»: cada tarjeta de «Qué decidir hoy» lleva a la lista exacta de lo que hay
 * que decidir, una ficha por renglón con el enlace a SU pedido, y nunca a la portada del repo de operaciones.
 *
 * Decisiones_PorFicha_EnlaceAlPedidoExacto     Decisiones_FichaSinPr_ApareceConElPorQue
 * Decisiones_FuenteAbierta_SeListaIgual        Inicio_NingunaTarjetaALaPortada
 * Inicio_SinRepoNavegable_LaListaLoDice        Inicio_Declarados_DicenDondeSeDecidenSinEnlace
 * Fuentes_LeeElPedidoDeCadaFicha
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
