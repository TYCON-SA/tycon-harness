'use strict';
/**
 * Vigilante de producción — las cuatro reglas, la huella y el presupuesto de ruido.
 *
 * Los casos NO son inventados: cada uno reproduce la forma de un incidente real del corpus de los
 * 11 (el inventario de telemetría de producción del equipo, 2026-08-30, §2.2). Si una regla deja de cazar el
 * incidente que la justifica, la pieza perdió su razón de ser y el test lo dice con ese nombre.
 */
const test = require('node:test');
const assert = require('node:assert');
const V = require('../nightly/watcher/vigilante.js');

const CFG = {
  umbral_piso: 3, factor: 3, ventana_linea_base_dias: 14, noches_arranque_frio: 3,
  umbral_rafaga_azure: 5, concentracion_min: 0.8, max_hallazgos_por_aviso: 2,
};
const ej = (o) => ({
  ts: o.ts || '2026-08-31T02:00:00Z', plugin: o.plugin || 'P', endpoint: o.endpoint || 'GET /x',
  estado: o.estado === undefined ? 500 : o.estado, duracionMs: o.d || 100,
  mensaje: o.msg === undefined ? 'boom' : o.msg, usuario: o.u || null, ip: o.ip || null,
});
const correr = (ejecuciones, extra = {}) => V.evaluar({
  producto: 'acme', ejecuciones, salud: extra.salud || {}, totales: extra.totales || {},
  base: extra.base || {}, cfg: { ...CFG, ...(extra.cfg || {}) }, modoFrio: !!extra.modoFrio,
});

// ── la huella ──────────────────────────────────────────────────────────────────────────────────

test('la huella agrupa el MISMO problema aunque cambien los números del mensaje', () => {
  const a = V.huella('acme', 'P', 'GET /x', 500, 'Timeout expired (id 4471)');
  const b = V.huella('acme', 'P', 'GET /x', 500, 'Timeout expired (id 9982)');
  assert.equal(a, b, 'sin esto, cada error es único y no existe línea base posible');
});

test('la huella separa endpoints y productos distintos', () => {
  const a = V.huella('acme', 'P', 'GET /x', 500, 'boom');
  assert.notEqual(a, V.huella('acme', 'P', 'GET /y', 500, 'boom'));
  assert.notEqual(a, V.huella('globex', 'P', 'GET /x', 500, 'boom'));
});

test('normalizar también colapsa GUIDs', () => {
  assert.equal(
    V.normalizarMensaje('fallo el request 3f2c9a1e-1111-2222-3333-444455556666'),
    V.normalizarMensaje('fallo el request aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000'),
  );
});

// ── goteo (incidentes #7 y #11: sub-umbral, invisible para Azure) ──────────────────────────────

test('goteo: 3 errores con línea base 1 levantan hallazgo (incidente #11)', () => {
  const filas = [ej({ ts: '2026-08-31T02:00:00Z' }), ej({ ts: '2026-08-31T06:00:00Z' }), ej({ ts: '2026-08-31T10:00:00Z' })];
  const fp = V.huella('acme', 'P', 'GET /x', 500, 'boom');
  const { hallazgos } = correr(filas, { base: { [fp]: 1 } });
  assert.equal(hallazgos.length, 1);
  assert.equal(hallazgos[0].regla, 'goteo');
});

test('piso: 2 errores sueltos NO despiertan a nadie', () => {
  const fp = V.huella('acme', 'P', 'GET /x', 500, 'boom');
  const { hallazgos } = correr([ej({}), ej({ ts: '2026-08-31T09:00:00Z' })], { base: { [fp]: 1 } });
  assert.equal(hallazgos.length, 0);
});

test('goteo: si la línea base ya era alta, 3 errores son normales y no levantan nada', () => {
  const fp = V.huella('acme', 'P', 'GET /x', 500, 'boom');
  const filas = [ej({}), ej({ ts: '2026-08-31T05:00:00Z' }), ej({ ts: '2026-08-31T09:00:00Z' })];
  const { hallazgos } = correr(filas, { base: { [fp]: 20 } });
  assert.equal(hallazgos.length, 0, 'umbral = 3 x 20 = 60');
});

// ── deriva (incidente #6: excepción NUEVA tras un cambio) ──────────────────────────────────────

test('deriva: un tipo de error que nunca se había visto es hallazgo de severidad alta (incidente #6)', () => {
  const filas = [ej({ msg: 'MissingMethodException' }), ej({ msg: 'MissingMethodException' }), ej({ msg: 'MissingMethodException' })];
  const { hallazgos } = correr(filas, { base: {} });
  assert.equal(hallazgos.length, 1);
  assert.equal(hallazgos[0].regla, 'deriva');
  assert.equal(hallazgos[0].severidad, 'alta');
});

// ── desagregación (incidente #9: una cuenta de servicio perdió un permiso) ─────────────────────

test('desagregación: el total no llama la atención pero una cuenta concentra los errores (incidente #9)', () => {
  const fp = V.huella('acme', 'P', 'GET /x', 500, 'boom');
  const filas = [
    ej({ u: 'cuenta-servicio' }), ej({ u: 'cuenta-servicio', ts: '2026-08-31T03:00:00Z' }),
    ej({ u: 'cuenta-servicio', ts: '2026-08-31T04:00:00Z' }), ej({ u: 'cuenta-servicio', ts: '2026-08-31T05:00:00Z' }),
    ej({ u: 'otro', ts: '2026-08-31T06:00:00Z' }),
  ];
  const { hallazgos } = correr(filas, { base: { [fp]: 30 } }); // umbral alto: el goteo NO dispara
  assert.equal(hallazgos.length, 1);
  assert.equal(hallazgos[0].regla, 'desagregacion');
  assert.match(hallazgos[0].diagnostico, /4 de 5 errores concentrados en un solo usuario/);
  // 🔴 La señal es "son todos el mismo", no "es fulano": el diagnóstico se commitea a un repo del
  // equipo y viaja por Telegram. Se publica un seudónimo estable, nunca el usuario real.
  assert.doesNotMatch(hallazgos[0].diagnostico, /cuenta-servicio/, 'el nombre real NO puede salir del host');
  assert.match(hallazgos[0].diagnostico, /#[0-9a-f]{6}/);
});

test('la evidencia se persiste TACHADA y con el usuario seudonimizado', () => {
  const filas = [
    // la contraseña se arma en dos pedazos: escrita entera, el detector de publicación la toma (con razón) por una de verdad
    ej({ msg: "Login failed for user 'sa'; Pass" + "word=Sup3rSecreta; contacto persona@example.com desde 10.0.0.7", u: 'cuenta-servicio' }),
    ej({ msg: 'otra cosa', ts: '2026-08-31T03:00:00Z' }),
    ej({ msg: 'otra cosa', ts: '2026-08-31T04:00:00Z' }),
  ];
  const { hallazgos } = correr(filas, { base: {} });
  const texto = JSON.stringify(hallazgos);
  assert.doesNotMatch(texto, /Sup3rSecreta/, 'una contraseña de producción no puede terminar commiteada');
  assert.doesNotMatch(texto, /persona@example\.com/, 'ni un correo');
  assert.doesNotMatch(texto, /10\.0\.0\.7/, 'ni una IP');
  assert.doesNotMatch(texto, /cuenta-servicio/, 'ni el usuario real');
});

test('desagregación: el borde — 3 de 4 (75%) NO alcanza; hace falta 80%', () => {
  // El borde se fija a propósito: bajarlo convierte cualquier endpoint con un usuario dominante
  // en un hallazgo, y ése es el camino directo a la casilla que nadie mira.
  const fp = V.huella('acme', 'P', 'GET /x', 500, 'boom');
  const filas = [
    ej({ u: 'cuenta-servicio' }), ej({ u: 'cuenta-servicio', ts: '2026-08-31T03:00:00Z' }),
    ej({ u: 'cuenta-servicio', ts: '2026-08-31T04:00:00Z' }), ej({ u: 'otro', ts: '2026-08-31T05:00:00Z' }),
  ];
  assert.equal(correr(filas, { base: { [fp]: 30 } }).hallazgos.length, 0);
});

// ── salud (incidente #8: el gateway que latía y no atendía) ────────────────────────────────────

test('salud: un plugin caído es hallazgo directo, sin línea base', () => {
  const { hallazgos } = correr([], { salud: { Bueno: 'Running', Roto: 'Failed' } });
  assert.equal(hallazgos.length, 1);
  assert.equal(hallazgos[0].regla, 'salud');
  assert.equal(hallazgos[0].plugin, 'Roto');
});

test('salud: un plugin que no se pudo consultar NO se cuenta como caído', () => {
  const { hallazgos } = correr([], { salud: { X: 'no medido — HTTP 503' } });
  assert.equal(hallazgos.length, 0, 'no medido ≠ roto: inventar un hallazgo por un timeout es ruido');
});

// ── arranque en frío ───────────────────────────────────────────────────────────────────────────

test('en frío sólo se levanta la salud: sin historia no se finge criterio', () => {
  const filas = [ej({}), ej({ ts: '2026-08-31T03:00:00Z' }), ej({ ts: '2026-08-31T04:00:00Z' })];
  const { hallazgos, modo } = correr(filas, { modoFrio: true, salud: { R: 'Failed' } });
  assert.equal(modo, 'solo-linea-base');
  assert.deepEqual(hallazgos.map((h) => h.regla), ['salud']);
});

// ── frontera con Azure ─────────────────────────────────────────────────────────────────────────

test('una ráfaga que Azure ya alertó se detecta sobre nuestros propios datos', () => {
  const filas = Array.from({ length: 6 }, (_, i) => ej({ ts: `2026-08-31T02:0${i}:00Z` }));
  assert.equal(V.yaAlertadoPorAzure(filas, 5), true);
});

test('los mismos 6 errores repartidos en el día NO son una ráfaga (ahí vive esta pieza)', () => {
  const filas = Array.from({ length: 6 }, (_, i) => ej({ ts: `2026-08-31T0${i}:00:00Z` }));
  assert.equal(V.yaAlertadoPorAzure(filas, 5), false);
});

// ── presupuesto de ruido ───────────────────────────────────────────────────────────────────────

test('el aviso cuenta todos los hallazgos, sin listarlos (story 2.30: sólo cantidades)', () => {
  const hs = [
    { producto: 'acme', plugin: 'A', endpoint: '/1', severidad: 'media', diagnostico: 'uno' },
    { producto: 'acme', plugin: 'B', endpoint: '/2', severidad: 'alta', diagnostico: 'dos' },
    { producto: 'acme', plugin: 'C', endpoint: '/3', severidad: 'media', diagnostico: 'tres' },
  ];
  const a = V.construirAviso('2026-08-31', hs, [], CFG);
  assert.match(a.split('\n')[0], /^vigilante 2026-08-31: 3 hallazgo\(s\) nuevo\(s\), 0 sin medir, 0 borrador\(es\) esperando$/);
  assert.doesNotMatch(a, /^• /m, 'ningún hallazgo listado');
});

test('una noche sin nada NO manda mensaje: el silencio no miente', () => {
  assert.equal(V.construirAviso('2026-08-31', [], [], CFG), null);
});

test('pero un producto que no se pudo consultar SÍ avisa, aunque no haya hallazgos', () => {
  const a = V.construirAviso('2026-08-31', [], ['acme: login 401'], CFG);
  assert.match(a, /1 sin medir/, 'una noche sin datos no puede parecerse a una noche tranquila');
  assert.doesNotMatch(a, /acme|login 401/, 'sin el producto ni el motivo (story 2.30)');
});

// ── Hallazgos del pase adversarial (2026-08-31) ────────────────────────────────────────────────

test('una ráfaga en UN endpoint no silencia los hallazgos de otro (ni la salud)', () => {
  // Antes la marca "de esto Azure ya avisó" se estampaba a TODOS los hallazgos del producto: una
  // ráfaga en un endpoint tapaba del aviso a un plugin caído que no tenía nada que ver.
  const rafaga = Array.from({ length: 6 }, (_, i) => ej({ endpoint: '/rafaga', ts: `2026-08-31T02:0${i}:00Z`, msg: 'x' }));
  const goteo = [
    ej({ endpoint: '/goteo', ts: '2026-08-31T05:00:00Z', msg: 'y' }),
    ej({ endpoint: '/goteo', ts: '2026-08-31T09:00:00Z', msg: 'y' }),
    ej({ endpoint: '/goteo', ts: '2026-08-31T13:00:00Z', msg: 'y' }),
  ];
  const { hallazgos } = correr([...rafaga, ...goteo], { base: {}, salud: { Roto: 'Failed' } });
  const porEndpoint = Object.fromEntries(hallazgos.map((h) => [h.endpoint || h.regla, h.ya_alertado]));
  assert.equal(porEndpoint['/rafaga'], true, 'la ráfaga sí la alertó Azure');
  assert.equal(porEndpoint['/goteo'], false, 'el goteo de otro endpoint NO');
  assert.equal(porEndpoint.salud, false, 'un plugin caído nunca hereda la ráfaga de otro');
});

test('la línea base cuenta los CEROS de las noches medidas (si no, el goteo sub-detecta)', () => {
  // Un error esporádico —3 ocurrencias una noche de cada 14— tenía mediana 3 y umbral 9, así que
  // el goteo del incidente #11 quedaba por debajo. Con los ceros, la mediana es 0 y el umbral el piso.
  assert.equal(V.mediana([0, 0, 0, 3, 0]), 0);
  assert.equal(V.mediana([3]), 3, 'sin los ceros, la misma huella daba 3');
});

test('un hallazgo que sigue vivo NO se auto-archiva por antigüedad', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vig-'));
  fs.mkdirSync(path.join(dir, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pending', 'x.yaml'), [
    'id: "2026-08-01-acme-abc"', 'fecha: "2026-08-01"', 'producto: "acme"',
    'regla: "salud"', 'huella: "abc"', 'veredicto: pendiente',
    'vista_por_ultima_vez: "2026-08-30"', 'noches_seguidas: 30', '',
  ].join('\n'));
  // Creado hace un mes, pero visto ANOCHE: sigue vivo. Antes se archivaba como "ignorado" y el
  // dedup lo callaba para siempre — un plugin caído en forma permanente quedaba permanentemente mudo.
  assert.deepEqual(V.marcarIgnorados(dir, '2026-08-31'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Fuente degradada y latido (2026-08-31, probado contra producción) ──────────────────────────

test('latido: un plugin vivo que hace horas no recibe un pedido (incidente #8)', () => {
  const salud = {
    Activo: { estado: 'Running', ultimoPedido: '2026-08-31T11:00:00Z', pedidos: 100 },
    Zombie: { estado: 'Running', ultimoPedido: '2026-08-29T10:00:00Z', pedidos: 5000 },
  };
  const { hallazgos } = V.evaluar({
    producto: 'acme', ejecuciones: [], salud, stats: {}, totales: {}, base: {},
    cfg: { ...CFG, horas_sin_pedidos: 20 }, modoFrio: false, fuente: 'stats',
    ahoraIso: '2026-08-31T12:00:00Z',
  });
  assert.deepEqual(hallazgos.map((h) => h.plugin), ['Zombie']);
  assert.equal(hallazgos[0].regla, 'latido');
  // Su salud decía "Running": es justo el caso que ninguna otra señal ve.
  assert.match(hallazgos[0].diagnostico, /está vivo y no lo está usando nadie/);
});

test('sin el detalle por pedido, el goteo sale igual por estadísticas (más grueso, pero sale)', () => {
  const stats = { GestionApi: { total: 520, fallidos: 23, porCodigo: { 200: 497, 500: 23 }, porEndpoint: {} } };
  const { hallazgos } = V.evaluar({
    producto: 'acme', ejecuciones: [], salud: {}, stats, totales: {}, base: {},
    cfg: CFG, modoFrio: false, fuente: 'stats', ahoraIso: '2026-08-31T12:00:00Z',
  });
  assert.equal(hallazgos.length, 1);
  assert.equal(hallazgos[0].senal.errores, 23);
  // Y DICE lo que no puede decir: sin el detalle no hay endpoint ni mensaje.
  assert.match(hallazgos[0].diagnostico, /no se puede decir en qué endpoint/);
});

test('con el detalle disponible, la regla fina manda y la gruesa no duplica', () => {
  const stats = { P: { total: 100, fallidos: 3, porCodigo: { 500: 3 }, porEndpoint: {} } };
  const filas = [ej({}), ej({ ts: '2026-08-31T03:00:00Z' }), ej({ ts: '2026-08-31T04:00:00Z' })];
  const { hallazgos } = V.evaluar({
    producto: 'acme', ejecuciones: filas, salud: {}, stats, totales: {}, base: {},
    cfg: CFG, modoFrio: false, fuente: 'ejecuciones', ahoraIso: '2026-08-31T12:00:00Z',
  });
  assert.equal(hallazgos.length, 1, 'un solo hallazgo: la gruesa se calla cuando hay detalle');
  assert.ok(hallazgos[0].evidencia.length, 'y trae la evidencia por pedido');
});

// ── La cola que envejece (2026-08-31) ──────────────────────────────────────────────────────────
// El aviso sólo sonaba por hallazgos NUEVOS: un borrador ya abierto no volvía a sonar nunca y se
// archivaba solo como `ignorado` a los 7 días. El recordatorio cierra ese hueco — una sola vez.

const _fs = require('fs'); const _os = require('os'); const _path = require('path');
function colaCon(borradores) {
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'vig-cola-'));
  _fs.mkdirSync(_path.join(dir, 'pending'), { recursive: true });
  for (const [nombre, campos] of Object.entries(borradores)) {
    _fs.writeFileSync(_path.join(dir, 'pending', `${nombre}.yaml`), [
      `id: "${nombre}"`, `fecha: "${campos.fecha}"`, 'producto: "acme"', 'regla: "latido"',
      'huella: "abc"', `veredicto: ${campos.veredicto || 'pendiente'}`,
      `vista_por_ultima_vez: "${campos.visto || campos.fecha}"`, 'noches_seguidas: 1',
      ...(campos.recordado ? [`recordado_el: "${campos.recordado}"`] : ['recordado_el: null']), '',
    ].join('\n'));
  }
  return dir;
}

test('un borrador de 3 días sin decisión entra al recordatorio', () => {
  const dir = colaCon({ viejo: { fecha: '2026-08-28' } });
  const r = V.pendientesQueEnvejecen(dir, '2026-08-31', 3);
  assert.equal(r.length, 1);
  assert.equal(r[0].edad, 3);
  _fs.rmSync(dir, { recursive: true, force: true });
});

test('el de anoche NO molesta: 3 días es el piso, no una sugerencia', () => {
  const dir = colaCon({ nuevo: { fecha: '2026-08-30' } });
  assert.equal(V.pendientesQueEnvejecen(dir, '2026-08-31', 3).length, 0);
  _fs.rmSync(dir, { recursive: true, force: true });
});

test('suena UNA sola vez: el sello apaga el recordatorio de ese borrador', () => {
  const dir = colaCon({ viejo: { fecha: '2026-08-20' } });
  const primera = V.pendientesQueEnvejecen(dir, '2026-08-31', 3);
  assert.equal(primera.length, 1, 'la primera noche sí');
  V.marcarRecordados(primera, '2026-08-31');
  assert.equal(V.pendientesQueEnvejecen(dir, '2026-09-01', 3).length, 0,
    'un recordatorio que se repite todas las noches se lee como ruido y se filtra');
  _fs.rmSync(dir, { recursive: true, force: true });
});

test('lo ya decidido no se recuerda: sólo pesa la decisión que falta', () => {
  const dir = colaCon({ decidido: { fecha: '2026-08-01', veredicto: 'descartado' } });
  assert.equal(V.pendientesQueEnvejecen(dir, '2026-08-31', 3).length, 0);
  _fs.rmSync(dir, { recursive: true, force: true });
});

test('una noche SIN hallazgos pero con la casilla pudriéndose SÍ manda mensaje', () => {
  // El rojo previo: acá el aviso era null y el borrador moría solo a los 7 días, sin que nadie
  // supiera que había algo que decidir.
  const a = V.construirAviso('2026-08-31', [], [], CFG, [{ edad: 4, campos: { id: '2026-08-27-acme-ee00' } }]);
  assert.ok(a, 'el silencio no puede tapar una casilla que nadie mira');
  assert.match(a, /1 borrador\(es\) esperando/);
  assert.doesNotMatch(a, /2026-08-27-acme-ee00|acme/, 'sin el id (story 2.30): el borrador se busca con /tycon-vigilante review');
});

test('sin hallazgos, sin fallas de lectura y sin cola vieja, sigue sin mandar nada', () => {
  assert.equal(V.construirAviso('2026-08-31', [], [], CFG, []), null);
});

test('T31 Vigilante_AvisoSoloCantidades @story-2.30 @ac-21', () => {
  const hs = [
    { producto: 'ProductoMarcador', plugin: 'PluginMarcador', endpoint: '/api/EndpointMarcador', severidad: 'alta', diagnostico: 'DiagnosticoMarcador con datos de cliente' },
    { producto: 'OtroMarcador', plugin: 'x', endpoint: '/y', severidad: 'media', diagnostico: 'otro' },
  ];
  const a = V.construirAviso('2026-08-31', hs, ['host-marcador.example: sin respuesta'], CFG, [{ edad: 5, campos: { id: '2026-08-26-IdMarcador-0000' } }]);
  assert.strictEqual(a.split('\n')[0], 'vigilante 2026-08-31: 2 hallazgo(s) nuevo(s), 1 sin medir, 1 borrador(es) esperando');
  for (const m of ['Marcador', 'host-marcador', 'EndpointMarcador', 'Diagnostico', 'IdMarcador', '/api/']) assert.ok(!a.includes(m), `«${m}» no puede salir en el aviso: ${a}`);
  // y sale por notify.js, nunca por el script de Telegram directo
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'nightly', 'watcher', 'vigilante.js'), 'utf8');
  assert.doesNotMatch(src, /tycon-telegram-notify\.sh/);
});

// ── El PR con el que se decide (2026-08-31) ────────────────────────────────────────────────────

const CAMPOS = {
  id: '2026-08-31-acme-ee00fa42', producto: 'acme', plugin: 'acmeutils',
  endpoint: null, regla: 'latido', severidad: 'media', noches_seguidas: 1,
  diagnostico: 'El plugin "acmeutils" no recibe un pedido desde hace 52 h. Su salud dice "Running".',
};

test('el título del PR no repite el nombre del plugin que ya está en el "dónde"', () => {
  const { titulo } = V.textoPr(CAMPOS, []);
  assert.equal((titulo.match(/acmeutils/g) || []).length, 1,
    'el renglón que se ve en la lista de PRs es corto: no se gasta la mitad en decirlo dos veces');
  assert.match(titulo, /no recibe un pedido/);
});

test('el cuerpo del PR se entiende SIN abrir el YAML', () => {
  const { cuerpo } = V.textoPr(CAMPOS, ['horas sin pedidos: 52']);
  assert.match(cuerpo, /no recibe un pedido desde hace 52 h/, 'el diagnóstico completo, en castellano');
  assert.match(cuerpo, /horas sin pedidos: 52/, 'y la señal que lo sostiene');
  assert.doesNotMatch(cuerpo, /\(sin diagnóstico\)/);
});

test('el cuerpo dice que el motivo del rechazo es obligatorio', () => {
  // Es la razón de ser del canal: el PR obliga a escribir el motivo, que hasta ahora dependía de
  // que la persona se acordara — y sin motivo, "no servía" y "nadie lo miró" son lo mismo.
  const { cuerpo } = V.textoPr(CAMPOS, []);
  assert.match(cuerpo, /comentario del rechazo ES el motivo/);
  assert.match(cuerpo, /nadie lo miró/);
});

test('un diagnóstico con comillas adentro NO deja el PR mocho', () => {
  // El lector escalar del YAML corta en la primera comilla: el nombre del plugin va entrecomillado
  // dentro del diagnóstico, así que el título salía cortado y el cuerpo decía "(sin diagnóstico)".
  const fs2 = require('fs'); const os2 = require('os'); const path2 = require('path');
  const d = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'vig-pr-'));
  const f = path2.join(d, 'b.yaml');
  fs2.writeFileSync(f, [
    'id: "x"', 'fecha: "2026-08-31"', 'producto: "acme"', 'regla: "latido"',
    'severidad: "media"', 'plugin: "P"', 'endpoint: null',
    `diagnostico: ${JSON.stringify('El plugin "P" no atiende hace 52 h.')}`,
    'veredicto: pendiente', 'noches_seguidas: 1', '',
  ].join('\n'));
  assert.equal(V.camposDe(fs2.readFileSync(f, 'utf8')).diagnostico, 'El plugin "P" no atiende hace 52 h.');
  fs2.rmSync(d, { recursive: true, force: true });
});

test('lo que se archiva por ignorado devuelve su id, para poder cerrar su PR', () => {
  // Un PR abierto cuyo borrador ya se dio por perdido pide una decisión sobre algo muerto: es la
  // clase de PR que enseña a no mirar la lista.
  const dir = colaCon({ viejo: { fecha: '2026-08-01', visto: '2026-08-01' } });
  assert.deepEqual(V.marcarIgnorados(dir, '2026-08-31'), ['viejo']);
  _fs.rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Story 4.2 — rechazar el pull request ES `/tycon-vigilante reject`.
//
// El caso REAL que esto cierra: la rama de un hallazgo recibió su pull request, una persona lo rechazó
// horas después, y a la mañana siguiente el pipeline abrió otro —que también se rechazó— y apareció un
// tercero. Tres pull requests para la
// misma decisión ya tomada. La única ficha que NO se reabrió es la que el dev, además de rechazar,
// archivó a mano con `/tycon-vigilante reject`. `note --rejected` automatiza exactamente eso.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const _cp = require('child_process');
const GUION = _path.resolve(__dirname, '..', 'nightly', 'watcher', 'vigilante.js');
const anotar = (args) => _cp.spawnSync('node', [GUION, 'note', ...args], { encoding: 'utf8' });

/** Un borrador escrito por el guion REAL: si `escribirBorrador` cambia, estos casos lo ven. */
function borradorReal(dir, extra = {}) {
  const h = {
    producto: 'globex', regla: 'salud', severidad: 'alta', huella: 'c6dc06a2',
    plugin: 'GlobexBZExt', endpoint: null, senal: { estado_plugin: 'Stopped' },
    diagnostico: 'El host reporta el plugin "GlobexBZExt" en estado "Stopped".', evidencia: [],
    ...extra,
  };
  return V.escribirBorrador(_path.join(dir, 'pending'), h, '2026-09-06');
}

test('W1: el borrador recuerda su pull request, y eso no rompe ningún campo que ya se leía', () => {
  // Sin `pr:` la relación ficha↔PR vive sólo en el nombre de la rama, y "no hay PR activo" —que es
  // también lo que devuelve una consulta que falló— se lee como "nunca tuvo uno": un PR por noche.
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'vig-w1-'));
  const f = borradorReal(dir);
  const antesCampos = V.camposDe(_fs.readFileSync(f, 'utf8'));

  assert.equal(anotar(['--card', f, '--pr', '3044']).status, 0);
  const txt = _fs.readFileSync(f, 'utf8');
  assert.match(txt, /^pr: 3044$/m);
  const lineas = txt.split('\n');
  assert.ok(lineas.indexOf('pr: 3044') > lineas.findIndex((l) => l.startsWith('noches_seguidas:')),
    'la línea nueva va DESPUÉS de noches_seguidas:, donde el guion la pone');
  assert.deepEqual(V.camposDe(txt), antesCampos, 'ningún campo que ya se leía cambia de valor');

  anotar(['--card', f, '--pr', '3044']);
  assert.equal(_fs.readFileSync(f, 'utf8'), txt, 'idempotente: la segunda noche no reescribe nada');
  assert.equal(anotar(['--card', f, '--pr', 'abc']).status, 2, 'un id que no es entero es error de uso');
  _fs.rmSync(dir, { recursive: true, force: true });
});

test('W2: 🔴 rechazar el pull request archiva la ficha como descartada, con el comentario de motivo', () => {
  // Es lo que el README ya promete ("Rechazar = no servía, y el comentario es el motivo") y lo que
  // el dev hacía a mano. Sin esto la ficha se queda en pending/ con `veredicto: pendiente` y el
  // pipeline le abre otro PR cada noche: rechazar no significa nada.
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'vig-w2-'));
  const f = borradorReal(dir);
  const r = anotar(['--card', f, '--rejected', '2026-09-06',
    '--reason', 'fue una "caida" de azure', '--pr', '3061']);
  assert.equal(r.status, 0, r.stderr);

  assert.ok(!_fs.existsSync(f), 'la ficha ya no está en pending/');
  const destino = _path.join(dir, 'archived', _path.basename(f));
  assert.ok(_fs.existsSync(destino), 'y sí en archived/');
  const txt = _fs.readFileSync(destino, 'utf8');
  assert.match(txt, /^veredicto: descartado$/m);
  assert.match(txt, /^pr: 3061$/m);
  assert.match(txt, /^pr_cerrado: 2026-09-06$/m, 'el PR ya está cerrado y su fecha se conoce');
  // 🔴 El motivo tiene comillas ADENTRO: sin JSON.stringify, `camposDe` lo devuelve mocho — el
  // mismo defecto que ya mordió con el diagnóstico y que la primera corrida real destapó.
  assert.equal(V.leerTexto(txt, 'motivo'),
    'fue una "caida" de azure (rechazo del PR !3061, 2026-09-06)');
  assert.equal(V.camposDe(txt).veredicto, 'descartado');

  const rep = _cp.spawnSync('node', [GUION, 'report', '--pending', dir, '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(rep.stdout).por_veredicto.descartado, 1, 'report la cuenta descartada');
  _fs.rmSync(dir, { recursive: true, force: true });
});

test('W2b: sin comentario de una persona, el motivo lo dice — "sin motivo escrito" es un dato', () => {
  // De los tres PR abandonados que se leyeron por la API, DOS no tenían un solo comentario de
  // texto: sólo "voted -10" y el cambio de estado, los dos de sistema. Inventar un motivo o dejarlo
  // vacío borraría la única diferencia que calibra la pieza.
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'vig-w2b-'));
  const f = borradorReal(dir);
  anotar(['--card', f, '--rejected', '2026-09-06', '--reason', 'sin motivo escrito', '--pr', '3015']);
  const txt = _fs.readFileSync(_path.join(dir, 'archived', _path.basename(f)), 'utf8');
  assert.equal(V.leerTexto(txt, 'motivo'), 'sin motivo escrito (rechazo del PR !3015, 2026-09-06)');
  _fs.rmSync(dir, { recursive: true, force: true });
});

test('W2c: --clear-rejection no aplica en el vigilante, y lo dice sin fallar', () => {
  // En dependencias un PR reactivado borra el rechazo; acá la ficha ya está archivada y la decisión
  // se toma con /tycon-vigilante. El guion compartido llama a los dos igual: la cola contesta.
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'vig-w2c-'));
  const f = borradorReal(dir);
  const r = anotar(['--card', f, '--clear-rejection']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no aplica en el vigilante/);
  _fs.rmSync(dir, { recursive: true, force: true });
});

test('W3: 🔴 la segunda noche respeta el descarte, y a los 60 días vuelve como reincidente', () => {
  // Lo que se prueba no es el dedup (ya existía): es que el archivo que escribe `note` sea uno
  // que el dedup RECONOZCA. Si le faltara `huella:`, o el veredicto no fuera `descartado`, el
  // pipeline volvería a abrir un PR por el mismo hecho la noche siguiente — el defecto entero.
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'vig-w3-'));
  const out = _path.join(dir, 'out');
  const fixture = _path.join(dir, 'fix');
  _fs.mkdirSync(fixture, { recursive: true });
  _fs.writeFileSync(_path.join(fixture, 'globex.json'),
    JSON.stringify({ ejecuciones: [], salud: { GlobexBZExt: { estado: 'Stopped' } }, stats: {}, totales: {} }));
  const cfg = _path.join(dir, 'hosts.json');
  _fs.writeFileSync(cfg, JSON.stringify({
    ventana_horas: 25, umbral_piso: 3, factor: 3, ventana_linea_base_dias: 14,
    noches_arranque_frio: 3, umbral_rafaga_azure: 5, concentracion_min: 0.8,
    dias_silencio_descartado: 60, dias_silencio_ignorado: 7, horas_sin_pedidos: 48,
    dias_recordatorio_pendiente: 3, max_hallazgos_por_aviso: 2,
    productos: [{ id: 'globex', url: 'https://x', env_user: 'U', env_pass: 'P', plugins: [], activo: true }],
  }));
  const noche = (hoy) => {
    const r = _cp.spawnSync('node', [GUION, 'run', '--config', cfg, '--fixture', fixture,
      '--out', out, '--pending', dir, '--today', hoy, '--json'],
    { encoding: 'utf8', env: { ...process.env, TYCON_WATCHER_QUIET: '1' } });
    return JSON.parse(r.stdout);
  };

  const n1 = noche('2026-09-06');
  assert.equal(n1.nuevos, 1, 'el plugin caído es hallazgo aun en arranque frío');
  const ficha = _path.join(dir, 'pending', `${n1.hallazgos[0].id}.yaml`);
  anotar(['--card', ficha, '--rejected', '2026-09-06', '--reason', 'no era del plugin', '--pr', '3015']);

  const n2 = noche('2026-09-07');
  assert.equal(n2.nuevos, 0, '🔴 la noche siguiente NO nace otro borrador: rechazar significa algo');
  assert.equal(n2.repetidos, 1, 'y el dedup lo reconoce como el mismo hecho, ya decidido');

  const n3 = noche('2026-11-30');   // pasados los 60 días de silencio
  assert.equal(n3.nuevos, 1, 'vencido el silencio vuelve a sonar: descartar no es enmudecer para siempre');
  assert.notEqual(n3.hallazgos[0].id, n1.hallazgos[0].id, 'con id nuevo');
  const nuevo = _fs.readFileSync(_path.join(dir, 'pending', `${n3.hallazgos[0].id}.yaml`), 'utf8');
  assert.match(nuevo, /veredicto_previo: descartado/, 'y marcado reincidente sobre el descarte');
  _fs.rmSync(dir, { recursive: true, force: true });
});

test('W4: 🔴 un motivo con $& o $\' no corrompe la ficha archivada', () => {
  // `String.replace` interpreta esos patrones en la cadena de REEMPLAZO, y acá la cadena es el
  // comentario de rechazo escrito por una persona. Reproducido: `$&` inyectaba `motivo: null` en el
  // medio del texto, y `$'` copiaba el resto ENTERO de la ficha adentro del valor, dejándola con
  // claves duplicadas y un `motivo:` multilínea que ningún lector por expresión regular puede leer.
  for (const raro of ['ver ticket R$&D antes de subir', "no aplica $' fin", 'costo $$ alto', 'ver $`x']) {
    const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'vig-w4-'));
    const f = borradorReal(dir);
    assert.equal(anotar(['--card', f, '--rejected', '2026-09-06', '--reason', raro, '--pr', '7']).status, 0);
    const txt = _fs.readFileSync(_path.join(dir, 'archived', _path.basename(f)), 'utf8');
    assert.equal(V.leerTexto(txt, 'motivo'), `${raro} (rechazo del PR !7, 2026-09-06)`,
      `el motivo «${raro}» no llegó entero`);
    // Y la ficha sigue siendo legible: ninguna clave duplicada.
    for (const k of ['veredicto', 'motivo', 'noches_seguidas', 'vista_por_ultima_vez', 'pr']) {
      assert.equal((txt.match(new RegExp(`^${k}:`, 'gm')) || []).length, 1, `${k} quedó duplicada con «${raro}»`);
    }
    _fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W3b: 🔴 lo aceptado (promoted/) tampoco vuelve a abrir borrador, y a los 60 días vuelve como reincidente', () => {
  // El dedup miraba `pending/` y `archived/`, nunca `promoted/`: un hallazgo aceptado que se repetía
  // dentro de su ventana volvía a escribir la ficha y abría otro borrador y otro pull request por el
  // mismo hecho, que ya tenía el suyo.
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'vig-w3b-'));
  const out = _path.join(dir, 'out');
  const fixture = _path.join(dir, 'fix');
  _fs.mkdirSync(fixture, { recursive: true });
  _fs.writeFileSync(_path.join(fixture, 'globex.json'),
    JSON.stringify({ ejecuciones: [], salud: { GlobexBZExt: { estado: 'Stopped' } }, stats: {}, totales: {} }));
  const cfg = _path.join(dir, 'hosts.json');
  _fs.writeFileSync(cfg, JSON.stringify({
    ventana_horas: 25, umbral_piso: 3, factor: 3, ventana_linea_base_dias: 14,
    noches_arranque_frio: 3, umbral_rafaga_azure: 5, concentracion_min: 0.8,
    dias_silencio_descartado: 60, dias_silencio_ignorado: 7, horas_sin_pedidos: 48,
    dias_recordatorio_pendiente: 3, max_hallazgos_por_aviso: 2,
    productos: [{ id: 'globex', url: 'https://x', env_user: 'U', env_pass: 'P', plugins: [], activo: true }],
  }));
  const noche = (hoy) => {
    const r = _cp.spawnSync('node', [GUION, 'run', '--config', cfg, '--fixture', fixture,
      '--out', out, '--pending', dir, '--today', hoy, '--json'],
    { encoding: 'utf8', env: { ...process.env, TYCON_WATCHER_QUIET: '1' } });
    return JSON.parse(r.stdout);
  };

  const n1 = noche('2026-09-06');
  assert.equal(n1.nuevos, 1);
  // Aceptar = lo que hace el merge del pull request del hallazgo: la ficha pasa a `promoted/` con
  // veredicto `util` (la misma sustitución que `open-pr-per-finding.sh`).
  const nombre = `${n1.hallazgos[0].id}.yaml`;
  _fs.mkdirSync(_path.join(dir, 'promoted'), { recursive: true });
  const txt = _fs.readFileSync(_path.join(dir, 'pending', nombre), 'utf8');
  _fs.writeFileSync(_path.join(dir, 'promoted', nombre), txt.replace(/^veredicto: pendiente$/m, 'veredicto: util'));
  _fs.rmSync(_path.join(dir, 'pending', nombre));

  const n2 = noche('2026-09-07');
  assert.equal(n2.nuevos, 0, '🔴 la noche siguiente NO nace otro borrador: el hallazgo ya fue aceptado');
  assert.equal(n2.repetidos, 1, 'y el dedup lo reconoce como el mismo hecho, ya decidido');
  assert.deepEqual(_fs.readdirSync(_path.join(dir, 'pending')).filter((f) => f.endsWith('.yaml')), [],
    'pending/ queda vacía: no hay ficha nueva que abra otro pedido');

  const n3 = noche('2026-11-30');   // pasados los 60 días de silencio
  assert.equal(n3.nuevos, 1, 'vencida la ventana vuelve a sonar');
  const nuevo = _fs.readFileSync(_path.join(dir, 'pending', `${n3.hallazgos[0].id}.yaml`), 'utf8');
  assert.match(nuevo, /veredicto_previo: util/, 'y marcado reincidente sobre lo aceptado');
  _fs.rmSync(dir, { recursive: true, force: true });
});

test('W5: con dos vidas archivadas de la misma huella, el dedup mira la MÁS RECIENTE', () => {
  // `.find()` tomaba la primera que devolviera el sistema de archivos, que no ordena: la ventana de
  // silencio se evaluaba contra una decisión arbitraria y el `reincidente.desde` señalaba cualquiera.
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'vig-w5-'));
  _fs.mkdirSync(_path.join(dir, 'archived'), { recursive: true });
  const escribir = (nombre, fecha, visto) => _fs.writeFileSync(_path.join(dir, 'archived', `${nombre}.yaml`), [
    `id: "${nombre}"`, `fecha: "${fecha}"`, 'producto: "globex"', 'regla: "salud"', 'huella: "abc"',
    'veredicto: descartado', 'motivo: "no servía"', `vista_por_ultima_vez: "${visto}"`,
    'noches_seguidas: 1', '',
  ].join('\n'));
  escribir('zzz-vieja', '2026-01-01', '2026-01-01');
  escribir('aaa-nueva', '2026-09-01', '2026-09-01');
  const archivadas = V.listarBorradores(dir).filter((b) => b.carpeta === 'archived');
  const masReciente = archivadas
    .sort((a, b) => String(b.campos.vista_por_ultima_vez).localeCompare(String(a.campos.vista_por_ultima_vez)))[0];
  assert.equal(masReciente.campos.id, 'aaa-nueva',
    'el orden por fecha es el que decide, no el que devuelva readdir');
  _fs.rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T30 · R4_Watcher_YmlBenchAndDefaults (story 8.12, tanda R4, AC 26)
//
// El vigilante pasó a `scripts/nightly/watcher/`, una carpeta más abajo. Lo que se puede romper sin
// que nadie lo vea: la raíz del repo calculada un nivel corta (los borradores y la foto de la noche
// irían a parar adentro de `scripts/`), el traductor de opciones viejas buscando la ruta de antes
// (la opción vieja de la fecha dejaría de andar sin error), y el pipeline nocturno o el banco llamando la ruta vieja,
// que sólo existe como reemplazo y que la copia pública no lleva. Las rutas viejas salen del mapa,
// nunca escritas acá.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const R4_RAIZ = _path.resolve(__dirname, '..', '..');
const R4_MAPA = _path.join(R4_RAIZ, 'scripts', 'lib', 'renames.json');
const R4_CON_MAPA = _fs.existsSync(R4_MAPA);
const R4_NUEVA = 'scripts/nightly/watcher';
/** Las dos entradas de la tanda (carpeta y archivo). Sin ellas el mapa está roto: falla, no se saltea. */
function r4Entradas() {
  const R4 = JSON.parse(_fs.readFileSync(R4_MAPA, 'utf8')).entries.filter((e) => e && e.batch === 'R4');
  const carpeta = R4.find((e) => e.kind === 'folder' && e.new === R4_NUEVA);
  const archivo = R4.find((e) => e.kind === 'file' && e.new === `${R4_NUEVA}/vigilante.js`);
  assert.ok(carpeta, `el mapa no tiene la entrada de carpeta de ${R4_NUEVA}`);
  assert.ok(archivo, `el mapa no tiene la entrada de ${R4_NUEVA}/vigilante.js`);
  return { carpeta, archivo };
}
/** Una noche en modo que no escribe (`--dry-run --json`), con HOME de mentira: el reemplazo anota su uso ahí. */
function r4Noche(guion, extra = []) {
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'vig-r4-'));
  const fixture = _path.join(dir, 'fix'); const out = _path.join(dir, 'out'); const home = _path.join(dir, 'home');
  _fs.mkdirSync(fixture, { recursive: true }); _fs.mkdirSync(home);
  // los umbrales, del ejemplo publicado: el arnés no trae ningún hosts.json (viene apagado de fábrica)
  const cfg = JSON.parse(_fs.readFileSync(_path.join(R4_RAIZ, 'pipelines', 'operations', 'examples', 'hosts.json'), 'utf8'));
  cfg.productos = [{ id: 'acme', url: 'x', env_user: 'U', env_pass: 'P', plugins: [], activo: true }];
  _fs.writeFileSync(_path.join(dir, 'cfg.json'), JSON.stringify(cfg));
  _fs.writeFileSync(_path.join(fixture, 'acme.json'), JSON.stringify({ ejecuciones: [], salud: { Roto: 'Failed' } }));
  const env = { ...process.env, HOME: home, TYCON_WATCHER_QUIET: '1', TYCON_NO_NIGHTLY_EXAM: '1' };
  delete env.TF_BUILD;
  const r = _cp.spawnSync(process.execPath, [guion, 'run', '--config', _path.join(dir, 'cfg.json'), '--fixture', fixture,
    '--out', out, '--pending', _path.join(dir, 'cola'), '--dry-run', '--json', ...extra], { encoding: 'utf8', env });
  const escribio = _fs.existsSync(out) || _fs.existsSync(_path.join(dir, 'cola'));
  _fs.rmSync(dir, { recursive: true, force: true });
  let json = null;
  try { json = JSON.parse(r.stdout); delete json.generado; } catch { /* queda null: lo dice el assert */ }
  return { status: r.status, json, stderr: r.stderr, escribio };
}

test('T30 R4_Watcher_YmlBenchAndDefaults — desde nightly/watcher/ los defaults siguen apuntando a la raíz del repo', () => {
  const d = V.defaults;
  assert.ok(d, 'vigilante.js exporta sus rutas por omisión');
  assert.strictEqual(d.root, R4_RAIZ, 'la raíz es la del repo, no scripts/');
  assert.strictEqual(d.out, _path.join(R4_RAIZ, '.dashboard', 'vigilante'), 'la foto de la noche sigue yendo a .dashboard/vigilante');
  // story 8.9, tanda F: la cola de borradores se mudó a inbox/watcher/ (la foto de la noche NO se mudó)
  assert.strictEqual(d.pending, _path.join(R4_RAIZ, 'inbox', 'watcher'), 'la cola de borradores vive en inbox/watcher/ de la raíz');
  // la cola y la configuración son de cada organización (su repo de operaciones): el pipeline las pasa con --pending y
  // --config. El arnés no trae ninguna de las dos (decisión 1 del dueño, story 8.26): sin configuración, viene apagado.
  assert.strictEqual(d.config, _path.join(R4_RAIZ, R4_NUEVA, 'hosts.json'), 'hosts.json se buscaría junto a vigilante.js');
  assert.ok(!_fs.existsSync(d.config), 'y el arnés no lo trae: los hosts de una organización no viajan');
});

test('story 8.9, tanda F — el texto del pull request nombra el borrador en la carpeta donde la noche lo deja', () => {
  // El cuerpo del PR le dice a quien decide dónde está el borrador. Si la carpeta se muda y el texto no,
  // la ruta que lee la persona no existe. Se compara contra la ruta por omisión, no contra un literal.
  const { cuerpo } = V.textoPr(CAMPOS, []);
  const m = cuerpo.match(/_Borrador: `([^`]+)`/);
  assert.ok(m, 'el cuerpo nombra el borrador');
  const cola = _path.relative(V.defaults.root, V.defaults.pending).split(_path.sep).join('/');
  assert.strictEqual(m[1], `${cola}/pending/${CAMPOS.id}.yaml`, 'la ruta del texto es la de la cola por omisión');
});

test('T30 R4_Watcher_YmlBenchAndDefaults — una noche que no escribe anda por la ruta nueva', () => {
  const a = r4Noche(GUION, ['--today', '2026-08-31']);
  assert.strictEqual(a.status, 0, `la ruta nueva corre (${a.stderr.slice(0, 400)})`);
  assert.ok(a.json && a.json.fecha === '2026-08-31', 'y contesta en JSON con la fecha pedida');
  assert.ok(a.json.hallazgos.length >= 1, 'el plugin caído es hallazgo');
  assert.strictEqual(a.escribio, false, '--dry-run no escribe ni la foto ni la cola');
});

test('T30 R4_Watcher_YmlBenchAndDefaults — la opción vieja de la fecha se traduce desde la ruta nueva',
  { skip: !R4_CON_MAPA && 'NO MEDIDO — copia pública sin el mapa' }, () => {
    // la opción vieja sale del mapa (la entrada con `where` en la ruta nueva), nunca escrita acá
    const op = JSON.parse(_fs.readFileSync(R4_MAPA, 'utf8')).entries
      .find((e) => e && e.kind === 'option' && e.new === 'today' && e.where === `${R4_NUEVA}/vigilante.js`);
    assert.ok(op, `el mapa no tiene el alias de --today con where ${R4_NUEVA}/vigilante.js`);
    const a = r4Noche(GUION, ['--today', '2026-08-31']);
    assert.ok(a.status === 0 && a.json, `la nueva contesta (si no, «iguales» sería dos caídas iguales): ${a.stderr.slice(0, 300)}`);
    const b = r4Noche(GUION, [`--${op.old}`, '2026-08-31']);
    assert.deepStrictEqual([b.status, b.json], [a.status, a.json], 'la opción vieja se traduce desde la ruta nueva (aliasArgv)');
  });

test('T30 R4_Watcher_YmlBenchAndDefaults — la ruta vieja es el reemplazo generado y da la misma salida',
  { skip: !R4_CON_MAPA && 'NO MEDIDO — copia pública sin el mapa' }, () => {
    const L = require(_path.join(R4_RAIZ, 'scripts', 'lib', 'legacy-names.js'));
    const { archivo } = r4Entradas();
    const viejo = _path.join(R4_RAIZ, archivo.old);
    assert.ok(_fs.existsSync(viejo) && L.isGeneratedShim(archivo.old, _fs.readFileSync(viejo, 'utf8')), `${archivo.old} es el reemplazo generado, tal cual`);
    assert.strictEqual(_path.resolve(L.shimTarget(viejo)), GUION, `${archivo.old} lanza el de ${R4_NUEVA}/`);
    const a = r4Noche(GUION, ['--today', '2026-08-31']);
    const b = r4Noche(viejo, ['--today', '2026-08-31']);
    assert.ok(a.status === 0 && a.json, `la nueva contesta (si no, «iguales» sería dos caídas iguales): ${a.stderr.slice(0, 300)}`);
    assert.deepStrictEqual([b.status, b.json], [a.status, a.json], 'misma salida y código por las dos rutas');
    assert.strictEqual(b.escribio, false, 'tampoco escribe por la vieja');
  });

test('T30 R4_Watcher_YmlBenchAndDefaults — el pipeline, el banco y el adaptador de Codex nombran la ruta nueva',
  { skip: !R4_CON_MAPA && 'NO MEDIDO — copia pública sin el mapa' }, () => {
    const { carpeta } = r4Entradas();
    const vieja = `${carpeta.old}/`;
    const problemas = [];
    for (const rel of ['pipelines/azure-pipelines-vigilante.yml', 'scripts/controls-bench/cases/hooks/31-vigilante.json', 'adapters/codex/hooks.json']) {
      const t = _fs.readFileSync(_path.join(R4_RAIZ, rel), 'utf8');
      if (t.includes(vieja)) problemas.push(`${rel} todavía nombra ${vieja}`);
      // sólo las de esta carpeta: el adaptador de Codex nombra también rutas de agent-skills, que no viven acá
      for (const m of t.matchAll(/scripts\/nightly\/watcher\/[\w./-]+\.(?:js|json)(?![\w-])/g)) {
        if (!_fs.existsSync(_path.join(R4_RAIZ, m[0]))) problemas.push(`${rel}: ${m[0]} no existe`);
      }
    }
    const yml = _fs.readFileSync(_path.join(R4_RAIZ, 'pipelines/azure-pipelines-vigilante.yml'), 'utf8');
    if ((yml.match(new RegExp(`${R4_NUEVA}/vigilante\\.js`, 'g')) || []).length < 3) problemas.push('el yml no llama a la ruta nueva en sus tres pasos');
    const caso = JSON.parse(_fs.readFileSync(_path.join(R4_RAIZ, 'scripts/controls-bench/cases/hooks/31-vigilante.json'), 'utf8'));
    if (!JSON.stringify(caso).includes('pipelines/operations/examples/hosts.json')) problemas.push('el caso 31 del banco no toma los umbrales del ejemplo publicado');
    assert.deepStrictEqual(problemas, []);
  });

test('T30 R4_Watcher_YmlBenchAndDefaults — pipelines/azure-pipelines-vigilante.yml parsea', (t) => {
  // el pipeline del vigilante es de cada organización (su repo de operaciones): donde no está, no hay qué parsear
  if (!_fs.existsSync(_path.join(R4_RAIZ, 'pipelines/azure-pipelines-vigilante.yml'))) { t.skip('NO MEDIDO — este árbol no trae el pipeline del vigilante (es de cada organización)'); return; }
  const py = _cp.spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
  if (py.status !== 0) { t.skip('NO MEDIDO — sin PyYAML en esta máquina. No es un verde.'); return; }
  const p = _cp.spawnSync('python3', ['-c', 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))', _path.join(R4_RAIZ, 'pipelines/azure-pipelines-vigilante.yml')], { encoding: 'utf8' });
  assert.strictEqual(p.status, 0, `no parsea: ${p.stderr.trim().split('\n').pop()}`);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Story 8.9, tanda F — los bloques bash de `commands/tycon-vigilante.md`, EXTRAÍDOS Y CORRIDOS
//
// El comando es una instrucción para el agente, y sus bloques bash son lo que el agente ejecuta. La
// versión de antes contaba `<cola>/pending/*.yaml` con el error tapado: con la cola mudada daba 0 y la
// instrucción decía «no hay nada que revisar». La de ahora tiene que distinguir tres cosas: la cola
// está (y cuenta, aunque sea 0), el checkout es anterior a la mudanza, o la cola no está.
//
// 🔴 Se corre el bloque REAL, sacado del .md por el título de su sección (no una copia, ni por
// posición): si alguien edita el bloque, estos casos lo ejercitan editado. La carpeta de antes sale
// del mapa, nunca escrita acá. El repo de juguete vive bajo /tmp/x.XXXXXX, fuera de cualquier repo.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const F_COMANDO = _path.join(R4_RAIZ, 'commands', 'tycon-vigilante.md');
const F_COLA = 'inbox/watcher';
const F_SHELLS = ['bash', 'zsh'].filter((s) => _cp.spawnSync(s, ['-c', 'true']).status === 0);

/** El bloque ```bash de la sección cuyo título contiene `titulo`. */
function fBloque(titulo) {
  const L = _fs.readFileSync(F_COMANDO, 'utf8').split('\n');
  const i = L.findIndex((l) => l.startsWith('## ') && l.includes(titulo));
  assert.ok(i >= 0, `commands/tycon-vigilante.md no tiene la sección «${titulo}»`);
  const sig = L.findIndex((l, j) => j > i && l.startsWith('## '));
  const tramo = L.slice(i + 1, sig < 0 ? L.length : sig);
  const a = tramo.indexOf('```bash');
  const b = tramo.indexOf('```', a + 1);
  assert.ok(a >= 0 && b > a, `la sección «${titulo}» no tiene un bloque bash`);
  return `${tramo.slice(a + 1, b).join('\n')}\n`;
}
/** La carpeta donde vivía la cola antes de mudarse, según el mapa. */
function fColaVieja() {
  const e = JSON.parse(_fs.readFileSync(R4_MAPA, 'utf8')).entries.find((x) => x && x.kind === 'folder' && x.new === F_COLA);
  assert.ok(e && e.old, `el mapa no tiene la carpeta que pasó a ${F_COLA}`);
  return e.old;
}
/** Un checkout de juguete con los archivos dados (rutas relativas), y lo que le pasa `fn`. */
function fJuguete(archivos, fn) {
  const lab = _fs.mkdtempSync(_path.join(_fs.existsSync('/tmp') ? '/tmp' : _os.tmpdir(), 'x.'));
  try {
    const repo = _path.join(lab, 'checkout'); _fs.mkdirSync(repo);
    for (const rel of archivos) {
      _fs.mkdirSync(_path.join(repo, _path.dirname(rel)), { recursive: true });
      _fs.writeFileSync(_path.join(repo, rel), 'id: x\n');
    }
    _fs.writeFileSync(_path.join(lab, 'guarda.sh'), fBloque('¿está la cola?'));
    _fs.writeFileSync(_path.join(lab, 'conteo.sh'), fBloque('review'));
    const correr = (sh, guion) => _cp.spawnSync(sh, [_path.join(lab, guion)], { cwd: repo, encoding: 'utf8' });
    for (const sh of F_SHELLS) {
      // como lo corre el agente: primero la guarda; el conteo, sólo si la guarda dejó seguir
      const guarda = correr(sh, 'guarda.sh');
      fn({ sh, guarda, conteo: guarda.status === 0 ? correr(sh, 'conteo.sh') : null, conteoSinGuarda: () => correr(sh, 'conteo.sh') });
    }
  } finally { _fs.rmSync(lab, { recursive: true, force: true }); }
}
const F_NADA = /no hay nada que revisar|no hay hallazgos/i;

test('story 8.9, tanda F — /tycon-vigilante: con la cola en su carpeta nueva, la encuentra y cuenta bien', () => {
  assert.ok(F_SHELLS.includes('bash'), 'hace falta bash para correr los bloques');
  const conFichas = [`${F_COLA}/pending/.gitkeep`, `${F_COLA}/pending/a.yaml`, `${F_COLA}/pending/b.yaml`,
    `${F_COLA}/pending/nota.txt`, `${F_COLA}/pending/sub/c.yaml`, `${F_COLA}/promoted/d.yaml`, `${F_COLA}/archived/e.yaml`];
  fJuguete(conFichas, ({ sh, guarda, conteo }) => {
    assert.strictEqual(guarda.status, 0, `${sh}: la guarda deja seguir (${guarda.stderr})`);
    assert.strictEqual(guarda.stdout.trim(), `cola: ${F_COLA}`, `${sh}: dice qué cola encontró`);
    assert.ok(conteo, `${sh}: el conteo corre`);
    assert.strictEqual(conteo.stdout.trim(), '2', `${sh}: cuenta los .yaml de pending/, y sólo ésos (ni .gitkeep, ni subcarpetas, ni promoted/)`);
    assert.strictEqual(conteo.stderr, '', `${sh}: sin errores`);
  });
  // la cola está y no tiene borradores: ESE es el único «no hay nada que revisar», y es un 0 limpio
  fJuguete([`${F_COLA}/pending/.gitkeep`], ({ sh, guarda, conteo }) => {
    assert.strictEqual(guarda.status, 0, `${sh}: la guarda deja seguir con la cola vacía`);
    assert.deepStrictEqual([conteo.stdout.trim(), conteo.stderr], ['0', ''], `${sh}: una cola vacía cuenta 0, sin error`);
  });
});

test('story 8.9, tanda F — /tycon-vigilante: sin la carpeta nueva y con la de antes, dice CHECKOUT ATRASADO',
  { skip: !R4_CON_MAPA && 'NO MEDIDO — copia pública sin el mapa' }, () => {
    const vieja = fColaVieja();
    fJuguete([`${vieja}/pending/a.yaml`, `${vieja}/pending/b.yaml`], ({ sh, guarda, conteo, conteoSinGuarda }) => {
      const todo = guarda.stdout + guarda.stderr;
      assert.strictEqual(guarda.status, 2, `${sh}: la guarda frena (sale 2), no deja seguir: «${todo.trim()}»`);
      assert.match(guarda.stderr, /CHECKOUT ATRASADO/, `${sh}: dice que el checkout es anterior a la mudanza`);
      assert.ok(guarda.stderr.includes(`${F_COLA}/pending`) && guarda.stderr.includes(`${vieja}/pending`), `${sh}: nombra la carpeta que falta y la que encontró`);
      assert.doesNotMatch(todo, /NO ESTÁ LA COLA/, `${sh}: no lo confunde con «no está la cola»`);
      assert.doesNotMatch(todo, F_NADA, `${sh}: no dice que no hay nada que revisar`);
      assert.strictEqual(conteo, null, `${sh}: el conteo no llega a correr`);
      // y si alguien corriera el conteo igual, salteando la guarda: el error se ve, no es un 0 limpio
      assert.notStrictEqual(conteoSinGuarda().stderr.trim(), '', `${sh}: el conteo sin la carpeta deja ver el error`);
    });
  });

test('story 8.9, tanda F — /tycon-vigilante: sin ninguna de las dos carpetas, dice NO ESTÁ LA COLA y no «no hay nada que revisar»', () => {
  fJuguete(['README.md'], ({ sh, guarda, conteo, conteoSinGuarda }) => {
    const todo = guarda.stdout + guarda.stderr;
    assert.strictEqual(guarda.status, 2, `${sh}: la guarda frena (sale 2): «${todo.trim()}»`);
    assert.match(guarda.stderr, /NO ESTÁ LA COLA/, `${sh}: dice que la cola no está`);
    assert.ok(guarda.stderr.includes(`${F_COLA}/pending`), `${sh}: nombra la carpeta que buscó`);
    assert.doesNotMatch(todo, /CHECKOUT ATRASADO/, `${sh}: no lo confunde con un checkout atrasado`);
    assert.doesNotMatch(todo, F_NADA, `${sh}: no dice que no hay nada que revisar`);
    assert.strictEqual(guarda.stdout.trim(), '', `${sh}: no imprime ningún conteo`);
    assert.strictEqual(conteo, null, `${sh}: el conteo no llega a correr`);
    assert.notStrictEqual(conteoSinGuarda().stderr.trim(), '', `${sh}: el conteo sin la carpeta deja ver el error`);
  });
});

test('story 8.9, tanda F — /tycon-vigilante: la instrucción manda parar ante los dos errores', () => {
  // Los bloques distinguen; lo que hace el agente con cada resultado lo dice la prosa de esa sección.
  const L = _fs.readFileSync(F_COMANDO, 'utf8').split('\n');
  for (const marca of ['CHECKOUT ATRASADO', 'NO ESTÁ LA COLA']) {
    const i = L.findIndex((l) => l.startsWith('- ') && l.includes(`\`${marca}\``));
    assert.ok(i >= 0, `la sección explica qué hacer ante ${marca}`);
    const sig = L.findIndex((l, j) => j > i && (l.startsWith('- ') || l.startsWith('## ')));
    assert.match(L.slice(i, sig < 0 ? L.length : sig).join(' '), /\*\*pará\*\*/, `ante ${marca} la instrucción es parar`);
  }
});

// ── story 8.26, decisión 1 del dueño — el programa es público y viene APAGADO DE FÁBRICA ─────────────────────────────
// El arnés publicado no trae ningún hosts.json: qué se mira es un dato de cada organización (su repo de operaciones).
// Sin --config y sin el archivo al lado del guion, `run` no mira nada, lo dice y sale 0 sin escribir. El espejo: con
// --config dada y un archivo que no está, sale 1 (quien lo prendió espera que mire).
test('apagado de fábrica — sin configuración no mira nada, lo dice y no escribe; con --config ilegible sale 1', () => {
  const dir = _fs.mkdtempSync(_path.join(require('os').tmpdir(), 'vig-apagado-'));
  try {
    const copia = _path.join(dir, 'scripts', 'nightly', 'watcher');
    _fs.mkdirSync(copia, { recursive: true });
    _fs.copyFileSync(GUION, _path.join(copia, 'vigilante.js'));
    _fs.mkdirSync(_path.join(dir, 'scripts', 'lib'), { recursive: true });
    for (const lib of ['legacy-names.js']) {
      const src = _path.join(__dirname, '..', 'lib', lib);
      if (_fs.existsSync(src)) _fs.copyFileSync(src, _path.join(dir, 'scripts', 'lib', lib));
    }
    const out = _path.join(dir, 'out');
    const pend = _path.join(dir, 'pend');
    const r = _cp.spawnSync('node', [_path.join(copia, 'vigilante.js'), 'run', '--out', out, '--pending', pend], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `sale 0: ${r.stderr}`);
    assert.match(r.stdout, /vigilante apagado/, 'dice que está apagado');
    assert.ok(!_fs.existsSync(out) && !_fs.existsSync(pend), 'no escribe ni la foto ni la cola');
    const r2 = _cp.spawnSync('node', [_path.join(copia, 'vigilante.js'), 'run', '--config', _path.join(dir, 'no-esta.json'), '--out', out, '--pending', pend], { encoding: 'utf8' });
    assert.strictEqual(r2.status, 1, `con --config dada y sin archivo sale 1: ${r2.stdout} ${r2.stderr}`);
    assert.doesNotMatch(r2.stdout, /vigilante apagado/, 'no se hace pasar por apagado');
  } finally {
    _fs.rmSync(dir, { recursive: true, force: true });
  }
});
