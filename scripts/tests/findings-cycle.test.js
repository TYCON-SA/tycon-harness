// El ciclo de la ficha, común a las fuentes de la noche: la forma, las carpetas, contar noches y
// dependencias usando la pieza sin cambiar lo que hace.
//
// A mano: node --test scripts/tests/findings-cycle.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const cycle = require(path.join(RAIZ, 'scripts', 'nightly', 'findings', 'cycle.js'));
const sources = require(path.join(RAIZ, 'scripts', 'nightly', 'findings', 'sources.js'));
const deps = require(path.join(RAIZ, 'scripts', 'nightly', 'dependencies', 'nightly-dependencies.js'));
const OPS = require(path.join(RAIZ, 'scripts', 'lib', 'operations-config.js'));
const ESC = require(path.join(__dirname, 'fixtures', 'findings', 'dependencies-scenario.js'));
const ESPERADO = path.join(__dirname, 'fixtures', 'findings', 'dependencies-expected');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ciclo-'));
const CLAVES_COMUNES = ['id', 'fuente', 'causa', 'nombre', 'primera_vez', 'ultima_vez', 'apariciones', 'veredicto',
  'veredicto_anterior', 'propuesta', 'pedido', 'asignado', 'estado', 'casos'];

const caso = (i) => ({ enlace: `https://sitio.example/corridas?abrir=${String(i).padStart(4, '0')}`, fecha: '2026-10-20' });
const vigilar = (dir, snapshot, opciones) => deps.vigilarFichas(dir, snapshot.fecha, snapshot, new Set(), ESC.cfg,
  new Set(), { restante: Infinity, nuevas: new Set() }, opciones);

test('T1 Ficha_FormaComun_TodasLasFuentes', () => {
  for (const fuente of ['dependencias', 'vigilante', 'ejecuciones']) {
    const f = cycle.nuevaFicha({ fuente, causa: 'RR-ESCAPE:TYCON_NO_DEEP_REVIEW', nombre: 'Se saltó el pase adversarial',
      hoy: '2026-10-20', casos: [caso(1)] });
    for (const k of CLAVES_COMUNES) assert.ok(k in f, `${fuente}: falta ${k}`);
    assert.strictEqual(f.fuente, fuente);
    assert.strictEqual(f.veredicto, 'pendiente');
    assert.strictEqual(f.estado, 'viva');
    assert.strictEqual(f.apariciones, 1);
    assert.strictEqual(f.primera_vez, '2026-10-20');
    assert.strictEqual(f.ultima_vez, '2026-10-20');
    assert.deepStrictEqual(cycle.problemasDeForma(f), []);
    // la ficha escrita se vuelve a leer igual
    assert.deepStrictEqual(cycle.parsear(cycle.serializar(f)), f);
  }
  assert.throws(() => cycle.nuevaFicha({ fuente: 'instintos', causa: 'x', nombre: 'x', hoy: '2026-10-20' }), /fuente/);
  // la misma causa en la misma fuente da el mismo id; en otra fuente, otro
  const a = cycle.nuevaFicha({ fuente: 'vigilante', causa: 'c1', nombre: 'n', hoy: '2026-10-20' });
  const b = cycle.nuevaFicha({ fuente: 'vigilante', causa: 'c1', nombre: 'n', hoy: '2026-10-21' });
  const c = cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'c1', nombre: 'n', hoy: '2026-10-20' });
  assert.strictEqual(a.id, b.id);
  assert.notStrictEqual(a.id, c.id);
});

test('T2 Ficha_TopeDe50Casos', () => {
  const casos = Array.from({ length: 60 }, (_, i) => caso(i));
  const f = cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'c', nombre: 'n', hoy: '2026-10-20', casos });
  assert.strictEqual(f.casos.length, cycle.TOPE_CASOS);
  assert.strictEqual(cycle.TOPE_CASOS, 50);
  assert.strictEqual(f.casos_total, 60);
  assert.deepStrictEqual(f.casos[0], caso(10), 'se guardan los 50 más nuevos');
  assert.deepStrictEqual(f.casos[49], caso(59));
});

test('T3 Ficha_CarpetasPorFuente', () => {
  const base = tmp();
  const esperadas = { dependencias: 'dependencies', vigilante: 'watcher', ejecuciones: 'runs-review' };
  for (const [fuente, carpeta] of Object.entries(esperadas)) {
    const c = cycle.carpetasDe(base, fuente);
    assert.deepStrictEqual(Object.keys(c).sort(), ['archived', 'decisions', 'pending', 'promoted']);
    for (const [k, p] of Object.entries(c)) assert.strictEqual(p, path.join(base, 'inbox', carpeta, k));
    cycle.asegurarCarpetas(c);
    for (const p of Object.values(c)) assert.ok(fs.statSync(p).isDirectory());
  }
  assert.strictEqual(sources.FUENTES.dependencias.carpeta, 'dependencies', 'dependencias conserva su carpeta de hoy');
});

test('T4 Ficha_TextoLibreNoEntra', () => {
  const ok = cycle.nuevaFicha({ fuente: 'vigilante', causa: 'c', nombre: 'n', hoy: '2026-10-20', casos: [caso(1)] });
  const malas = [
    { ...ok, diagnostico: 'la sesión dijo esto y aquello' },                 // una clave que no es de la forma
    { ...ok, causa: 'texto con espacios\ny un salto' },                      // una clave estable con texto libre
    { ...ok, casos: [{ enlace: 'https://x.example/a b' }] },                 // un enlace sin forma
    { ...ok, casos: [{ nota: 'rm -rf / y otras cosas' }] },                  // un caso con texto libre
    { ...ok, veredicto: 'quizás' },                                           // fuera del vocabulario
    { ...ok, primera_vez: 'ayer' },                                           // fecha sin forma
    { ...ok, nombre: 'dos\nrenglones' },                                      // el nombre en llano, en un renglón
  ];
  for (const m of malas) {
    assert.ok(cycle.problemasDeForma(m).length > 0, `debió rechazar ${JSON.stringify(m).slice(0, 80)}`);
    assert.throws(() => cycle.serializar(m), /forma/);
  }
  assert.throws(() => cycle.nuevaFicha({ fuente: 'vigilante', causa: 'c', nombre: 'n', hoy: '2026-10-20',
    casos: [{ texto: 'hola mundo' }] }), /forma/);
});

test('T5 Noche_MismaCausa_MismaFicha', () => {
  const f = cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-ESCAPE:X', nombre: 'n', hoy: '2026-10-20', casos: [caso(1)] });
  const g = cycle.registrarAparicion({ ...f, noches_sin_aparecer: 2 }, '2026-10-21', [caso(1), caso(2)]);
  assert.strictEqual(g.id, f.id);
  assert.strictEqual(g.primera_vez, '2026-10-20');
  assert.strictEqual(g.ultima_vez, '2026-10-21');
  assert.strictEqual(g.apariciones, 2);
  assert.deepStrictEqual(g.casos, [caso(1), caso(2)], 'un caso repetido no se duplica');
  assert.strictEqual(g.casos_total, 2);
  assert.ok(!('noches_sin_aparecer' in g), 'volver a aparecer borra el contador');
  // la misma noche dos veces no cuenta dos apariciones
  assert.strictEqual(cycle.registrarAparicion(g, '2026-10-21', []).apariciones, 2);
  // buscar por causa devuelve la que ya existe
  const fichas = [{ ficha: f }, { ficha: cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'otra', nombre: 'n', hoy: '2026-10-20' }) }];
  assert.strictEqual(cycle.fichaDeCausa(fichas, 'ejecuciones', 'RR-ESCAPE:X').ficha, f);
  assert.strictEqual(cycle.fichaDeCausa(fichas, 'vigilante', 'RR-ESCAPE:X'), null);
});

test('T6 Noche_FuenteSinMedir_NoAvanzaContador', () => {
  assert.deepStrictEqual(cycle.contarNoche({ contador: 1, presente: false, medida: false, n: 3 }), { contador: 1, resuelta: false });
  assert.deepStrictEqual(cycle.contarNoche({ contador: 1, presente: false, medida: true, n: 3 }), { contador: 2, resuelta: false });
  assert.deepStrictEqual(cycle.contarNoche({ contador: 2, presente: false, medida: true, n: 3 }), { contador: 3, resuelta: true });
  assert.deepStrictEqual(cycle.contarNoche({ contador: 2, presente: true, medida: true, n: 3 }), { contador: 0, resuelta: false });
  assert.deepStrictEqual(cycle.contarNoche({ contador: undefined, presente: false, medida: true, n: 1 }), { contador: 1, resuelta: true });
  // N que bajó: lo ya contado alcanza
  assert.deepStrictEqual(cycle.contarNoche({ contador: 4, presente: false, medida: true, n: 2 }), { contador: 5, resuelta: true });

  // en dependencias: un repo de la ficha sin medir deja el contador donde estaba
  const dir = tmp();
  ESC.armar(dir);
  fs.writeFileSync(path.join(dir, 'pending', 'hhhh8888.yaml'),
    ESC.FICHAS['pending/hhhh8888.yaml'].replace('noches: 1\n', 'noches: 1\nnoches_sin_aparecer: 1\n'));
  vigilar(dir, ESC.snapshot, { n: 3, ok: true });
  assert.match(fs.readFileSync(path.join(dir, 'pending', 'hhhh8888.yaml'), 'utf8'), /^noches_sin_aparecer: 1$/m);
});

test('T7 Dependencias_MismosCamposQueHoy', () => {
  const dir = tmp();
  ESC.armar(dir);
  const res = vigilar(dir, ESC.snapshot, { n: 1, ok: true });
  const foto = ESC.foto(dir);
  const esperado = {};
  for (const c of ['pending', 'promoted', 'archived']) {
    const d = path.join(ESPERADO, c);
    for (const f of fs.readdirSync(d).sort()) esperado[`${c}/${f}`] = fs.readFileSync(path.join(d, f), 'utf8');
  }
  assert.deepStrictEqual(Object.keys(foto), Object.keys(esperado), 'las mismas fichas en las mismas carpetas');
  for (const k of Object.keys(esperado)) assert.strictEqual(foto[k], esperado[k], `${k} salió distinta`);
  assert.deepStrictEqual(res.resueltos, ['aaaa1111']);
  assert.deepStrictEqual(res.descartados, ['cccc3333']);
  assert.deepStrictEqual(res.reaparecidos, ['dddd4444']);

  // y la pieza lee esas fichas con el mapa de dependencias (sus palabras de hoy, la vista común)
  const v = (rel) => {
    const [carpeta] = rel.split('/');
    return sources.FUENTES.dependencias.vista(deps.leerFicha(foto[rel]), carpeta);
  };
  assert.deepStrictEqual(v('promoted/aaaa1111.yaml'), { estado: 'resuelta', veredicto: 'arreglo' });
  assert.deepStrictEqual(v('archived/cccc3333.yaml'), { estado: 'viva', veredicto: 'aceptada' });
  assert.deepStrictEqual(v('pending/dddd4444.yaml'), { estado: 'reaparecio', veredicto: 'pendiente' });
  assert.deepStrictEqual(v('pending/bbbb2222.yaml'), { estado: 'viva', veredicto: 'pendiente' });
  const ignorada = deps.leerFicha('id: x\nveredicto: ignorado\n');
  assert.deepStrictEqual(sources.FUENTES.dependencias.vista(ignorada, 'archived'), { estado: 'viva', veredicto: 'ignorada' });
});

test('T8 Ficha_Ilegible_SeCuentaYNoFrena', () => {
  const base = tmp();
  const c = cycle.carpetasDe(base, 'vigilante');
  cycle.asegurarCarpetas(c);
  const buena = cycle.nuevaFicha({ fuente: 'vigilante', causa: 'c', nombre: 'n', hoy: '2026-10-20' });
  fs.writeFileSync(path.join(c.pending, `${buena.id}.yaml`), cycle.serializar(buena));
  fs.writeFileSync(path.join(c.pending, 'rota.yaml'), 'id: "sin cerrar\nfuente: vigilante\n');
  fs.writeFileSync(path.join(c.promoted, 'sin-fuente.yaml'), 'id: "abc"\n');
  fs.mkdirSync(path.join(c.archived, 'carpeta.yaml'));
  const r = cycle.leerCarpetas(path.dirname(c.pending), { leer: cycle.parsear });
  assert.deepStrictEqual(r.fichas.map((x) => x.ficha.id), [buena.id]);
  assert.deepStrictEqual(r.ilegibles.sort((a, b) => a.ficha.localeCompare(b.ficha)), [
    { ficha: 'archived/carpeta.yaml', motivo: 'EISDIR' },
    { ficha: 'pending/rota.yaml', motivo: 'sin forma' },
    { ficha: 'promoted/sin-fuente.yaml', motivo: 'sin forma' },
  ], 'cada ilegible dice por qué');

  // en dependencias, una ficha vieja sin `ids:` es legible; un archivo que no se puede leer se cuenta y la noche sigue
  const dir = tmp();
  ESC.armar(dir);
  fs.writeFileSync(path.join(dir, 'pending', 'aaaa1111.yaml'),
    ESC.FICHAS['pending/aaaa1111.yaml'].replace('ids:\n  - aaaa1111\n', ''));
  fs.mkdirSync(path.join(dir, 'pending', 'carpeta.yaml'));
  const res = vigilar(dir, ESC.snapshot, { n: 1, ok: true });
  assert.deepStrictEqual(res.resueltos, ['aaaa1111']);
  assert.deepStrictEqual(res.ilegibles, ['pending/carpeta.yaml']);
  assert.deepStrictEqual(deps.leerTodasLasFichas(dir).ilegibles, ['pending/carpeta.yaml']);
  // y los pasos que siguen en la misma noche tampoco se caen con ella
  assert.doesNotThrow(() => deps.archivarIgnorados(dir, '2026-10-30', ESC.cfg, null, []));
  assert.doesNotThrow(() => deps.cruzarPedidos({ pendingDir: dir, hoy: ESC.HOY, snapshot: ESC.snapshot,
    volcado: { archivo: null, consultado: false, motivo: 'sin volcado' }, cfg: ESC.cfg, escribir: true }));
});

test('T19 Dependencias_NNoches_NoReabreLasResueltas', () => {
  const dir = tmp();
  ESC.armar(dir);
  const antes = fs.readFileSync(path.join(dir, 'promoted', 'eeee5555.yaml'), 'utf8');
  const noche = (fecha) => vigilar(dir, { ...ESC.snapshot, fecha }, { n: 3, ok: true });
  const leer = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

  let r = noche('2026-10-20');
  assert.deepStrictEqual(r.resueltos, []);
  assert.match(leer('pending/aaaa1111.yaml'), /^noches_sin_aparecer: 1$/m);
  assert.doesNotMatch(leer('pending/aaaa1111.yaml'), /^resuelto:/m);
  assert.deepStrictEqual(r.esperando_resolver, [{ id: 'aaaa1111', noches_sin_aparecer: 1, n: 3 }]);
  r = noche('2026-10-21');
  assert.match(leer('pending/aaaa1111.yaml'), /^noches_sin_aparecer: 2$/m);
  r = noche('2026-10-22');
  assert.deepStrictEqual(r.resueltos, ['aaaa1111']);
  const resuelta = leer('promoted/aaaa1111.yaml');
  assert.match(resuelta, /^resuelto: 2026-10-22$/m);
  assert.doesNotMatch(resuelta, /noches_sin_aparecer/);
  // la que ya estaba resuelta antes del cambio sigue igual, sin contador
  assert.strictEqual(leer('promoted/eeee5555.yaml'), antes);

  // si la causa vuelve antes de las N noches, el contador se borra
  const dir2 = tmp();
  ESC.armar(dir2);
  fs.writeFileSync(path.join(dir2, 'pending', 'bbbb2222.yaml'),
    ESC.FICHAS['pending/bbbb2222.yaml'].replace('noches: 2\n', 'noches: 2\nnoches_sin_aparecer: 2\n'));
  vigilar(dir2, ESC.snapshot, { n: 3, ok: true });
  assert.doesNotMatch(fs.readFileSync(path.join(dir2, 'pending', 'bbbb2222.yaml'), 'utf8'), /noches_sin_aparecer/);

  // con operations.json inválido no se resuelve nada y el contador no avanza
  const dir3 = tmp();
  ESC.armar(dir3);
  const r3 = vigilar(dir3, ESC.snapshot, { n: null, ok: false, motivo: 'operations.json no valida' });
  assert.deepStrictEqual(r3.resueltos, []);
  assert.deepStrictEqual(r3.sin_resolver_por_configuracion, ['aaaa1111']);
  assert.doesNotMatch(fs.readFileSync(path.join(dir3, 'pending', 'aaaa1111.yaml'), 'utf8'), /noches_sin_aparecer/);

  // una pendiente que espera sus N noches no se archiva como «ignorada»: dejó de aparecer, alguien la arregló
  const dir4 = tmp();
  ESC.armar(dir4);
  vigilar(dir4, ESC.snapshot, { n: 3, ok: true });
  const ignorados = deps.archivarIgnorados(dir4, '2026-10-20', ESC.cfg, null, []);
  assert.ok(!ignorados.includes('aaaa1111'), 'la que espera no es ignorada');
});

test('T51 Ficha_EstadoYVeredicto_DanLaCarpeta', () => {
  const casos = [
    [{ estado: 'viva', veredicto: 'pendiente' }, 'pending'],
    [{ estado: 'reaparecio', veredicto: 'pendiente' }, 'pending'],
    [{ estado: 'viva', veredicto: 'aceptada' }, 'promoted'],
    [{ estado: 'viva', veredicto: 'arreglo' }, 'promoted'],
    [{ estado: 'reaparecio', veredicto: 'arreglo' }, 'promoted'],
    [{ estado: 'resuelta', veredicto: 'pendiente' }, 'archived'],
    [{ estado: 'resuelta', veredicto: 'arreglo' }, 'archived'],
    [{ estado: 'viva', veredicto: 'ignorada' }, 'archived'],
    [{ estado: 'viva', veredicto: 'migrada' }, 'archived'],
  ];
  for (const [f, carpeta] of casos) assert.strictEqual(cycle.carpetaDe(f), carpeta, JSON.stringify(f));
  assert.throws(() => cycle.carpetaDe({ estado: 'viva', veredicto: 'quizás' }), /veredicto/);
  // dependencias conserva sus carpetas de hoy (AC 2): una aceptada que se resuelve se queda en promoted/
  const dep = sources.FUENTES.dependencias;
  assert.strictEqual(dep.carpetaDe({ estado: 'resuelta', veredicto: 'arreglo' }), 'promoted');
  assert.strictEqual(dep.carpetaDe({ estado: 'viva', veredicto: 'aceptada' }), 'archived');
  assert.strictEqual(dep.carpetaDe({ estado: 'viva', veredicto: 'pendiente' }), 'pending');
});

test('T53 Casos_MasDe50_GuardaLosMasNuevosYElTotal', () => {
  const f = cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'c', nombre: 'n', hoy: '2026-10-20',
    casos: Array.from({ length: 45 }, (_, i) => caso(i)) });
  const g = cycle.registrarAparicion(f, '2026-10-21', Array.from({ length: 10 }, (_, i) => caso(100 + i)));
  assert.strictEqual(g.casos.length, 50);
  assert.strictEqual(g.casos_total, 55);
  assert.deepStrictEqual(g.casos[0], caso(5));
  assert.deepStrictEqual(g.casos[49], caso(109));
});

// Casos_LlegadosSinOrden_GuardaLosMasNuevosPorDia @story-4.11 @ac-8 — lo confirmó el pase adversarial
// 🔴 Falla con: guardar los últimos 50 en el orden de llegada (carpeta de máquina, nombre de archivo): con más de 50
// casos en una pasada, los de hoy de la máquina que se lee primero se pierden y quedan los de hace días.
test('T53b Casos_LlegadosSinOrden_GuardaLosMasNuevosPorDia @story-4.11 @ac-8', () => {
  const de = (dia, i) => ({ ejecucion: `e${dia}-${i}`, dia });
  const hoy = Array.from({ length: 30 }, (_, i) => de('2026-10-22', i));
  const viejos = Array.from({ length: 40 }, (_, i) => de('2026-10-16', i));
  const f = cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'c', nombre: 'n', hoy: '2026-10-22', casos: [...hoy, ...viejos] });
  assert.strictEqual(f.casos_total, 70);
  assert.strictEqual(f.casos.filter((c) => c.dia === '2026-10-22').length, 30, 'los 30 de hoy quedan');
  assert.strictEqual(f.casos.filter((c) => c.dia === '2026-10-16').length, 20);
  assert.deepStrictEqual(f.casos[49], de('2026-10-22', 29), 'el más nuevo al final');
});

// Vista_PedidoVacioEscritoAMano_QuedaVacio @story-4.11 @ac-18 — lo confirmó el pase adversarial
// 🔴 Falla con: tomar el `null` o el `~` de YAML como el id de un pedido de trabajo (la fila diría «null»).
test('T31b Vista_PedidoVacioEscritoAMano_QuedaVacio @story-4.11 @ac-18', () => {
  const base = 'id: "2026-09-01-acme-dddd0001"\nfuente: "vigilante"\nregla: "errores-500"\nfecha: "2026-09-01"\nveredicto: util\n';
  for (const v of ['null', '~', 'null  # todavía no creada', 'Null']) {
    assert.strictEqual(sources.comoFicha('vigilante', `${base}story_creada: ${v}\n`).pedido, null, v);
  }
  assert.deepStrictEqual(sources.comoFicha('vigilante', `${base}story_creada: 4567\n`).pedido, { id: '4567', enlace: null });
});

// Vista_PedidoDeLaNocheAbierto_SeLee @story-4.11 @ac-20 — lo confirmó el pase adversarial
// 🔴 Falla con: que la vista común no sepa que la ficha ya tiene abierto el pedido de la noche (`pr:`); el sitio la
// ofrecería para decidir y el pedido de la noche quedaría huérfano.
test('T31c Vista_PedidoDeLaNocheAbierto_SeLee @story-4.11 @ac-20', () => {
  const vig = 'id: "vig-1"\nfuente: "vigilante"\nregla: "errores-500"\nfecha: "2026-09-01"\nveredicto: pendiente\n';
  const dep = 'id: dep-1\ndetectado: 2026-10-19\nveredicto: pendiente\npaquete: pkg\nseveridad: high\nnoches: 3\n';
  for (const [fuente, txt] of [['vigilante', vig], ['dependencias', dep]]) {
    assert.strictEqual(sources.comoFicha(fuente, txt).pr_noche, null, `${fuente}: sin pr`);
    assert.strictEqual(sources.comoFicha(fuente, `${txt}pr: 123\n`).pr_noche, 123, `${fuente}: con pr`);
    assert.strictEqual(sources.comoFicha(fuente, `${txt}pr: 123\nrechazado: 2026-10-20\n`).pr_noche, null, `${fuente}: rechazado`);
    assert.strictEqual(sources.comoFicha(fuente, `${txt}pr: 123\npr_cerrado: 2026-10-20\n`).pr_noche, null, `${fuente}: cerrado`);
  }
  const ej = cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'c', nombre: 'n', hoy: '2026-10-20' });
  assert.strictEqual(sources.comoFicha('ejecuciones', cycle.serializar(ej)).pr_noche, null);
});

test('T56 OperationsConfig_ResolveAfterNights_ValidaYPorDefecto3', () => {
  const base = { version: 1, owners: { default: 'quien@acme.example' } };
  const ok = (v) => OPS.parse(JSON.stringify({ ...base, findings: { resolve_after_nights: v } })).ok;
  assert.ok(OPS.KEYS.includes('findings'));
  for (const v of [1, 3, 30]) assert.ok(ok(v), `${v} vale`);
  for (const v of [0, 31, 2.5, '3', null, -1]) assert.ok(!ok(v), `${JSON.stringify(v)} no vale`);
  assert.ok(!OPS.parse(JSON.stringify({ ...base, findings: { otra: 1 } })).ok, 'una clave desconocida es un problema');
  assert.ok(!OPS.parse(JSON.stringify({ ...base, findings: 3 })).ok, 'findings es un objeto');
  assert.ok(OPS.parse(JSON.stringify({ ...base, findings: {} })).ok);

  const dir = tmp();
  const p = path.join(dir, 'operations.json');
  assert.deepStrictEqual(cycle.nochesParaResolver(p), { ok: true, n: 3, origen: 'por defecto (sin operations.json)' });
  fs.writeFileSync(p, JSON.stringify(base));
  assert.deepStrictEqual(cycle.nochesParaResolver(p), { ok: true, n: 3, origen: 'por defecto' });
  fs.writeFileSync(p, JSON.stringify({ ...base, findings: { resolve_after_nights: 5 } }));
  assert.deepStrictEqual(cycle.nochesParaResolver(p), { ok: true, n: 5, origen: 'operations.json' });
  fs.writeFileSync(p, JSON.stringify({ ...base, findings: { resolve_after_nights: 0 } }));
  const r = cycle.nochesParaResolver(p);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.n, null);
  assert.match(r.motivo, /operations\.json no valida/);
  fs.writeFileSync(p, '{ no es json');
  assert.strictEqual(cycle.nochesParaResolver(p).ok, false);
});

// ── regresiones del pase adversarial y de los revisores ──────────────────────────────────────

const conContador = (rel, n, fecha) => ESC.FICHAS[rel].replace(/^noches: (\d+)\n/m,
  (m) => `${m}noches_sin_aparecer: ${n}\n${fecha ? `noche_contada: ${fecha}\n` : ''}`);

test('Contador_CausaVistaEnNocheMedidaAMedias_VuelveACero', () => {
  // la causa aparece en acme (medido) y initech no se midió: la noche no decide, pero el contador se borra
  const dir = tmp();
  ESC.armar(dir);
  const rel = 'pending/bbbb2222.yaml';
  fs.writeFileSync(path.join(dir, rel), conContador(rel, 2, '2026-10-19').replace('  - acme/acme\n', '  - acme/acme\n  - initech/initech\n'));
  vigilar(dir, ESC.snapshot, { n: 3, ok: true });
  assert.doesNotMatch(fs.readFileSync(path.join(dir, rel), 'utf8'), /noches_sin_aparecer|noche_contada/);
  // un repo APAGADO sin la causa en lo medido deja el contador quieto
  const dir2 = tmp();
  ESC.armar(dir2);
  const rel2 = 'pending/hhhh8888.yaml';
  fs.writeFileSync(path.join(dir2, rel2), conContador(rel2, 1, '2026-10-19'));
  deps.vigilarFichas(dir2, ESC.HOY, ESC.snapshot, new Set(['initech/initech']), ESC.cfg, new Set(),
    { restante: Infinity, nuevas: new Set() }, { n: 3, ok: true });
  const txt = fs.readFileSync(path.join(dir2, rel2), 'utf8');
  assert.match(txt, /^noches_sin_aparecer: 1$/m);
  assert.match(txt, /^bloqueada_por: "repo apagado: initech\/initech"$/m);
});

test('Contador_MismaNocheDosCorridas_CuentaUnaVez', () => {
  const dir = tmp();
  ESC.armar(dir);
  for (let i = 0; i < 3; i++) vigilar(dir, ESC.snapshot, { n: 3, ok: true });
  const txt = fs.readFileSync(path.join(dir, 'pending', 'aaaa1111.yaml'), 'utf8');
  assert.match(txt, /^noches_sin_aparecer: 1$/m);
  assert.match(txt, /^noche_contada: 2026-10-20$/m);
  assert.ok(!fs.existsSync(path.join(dir, 'promoted', 'aaaa1111.yaml')), 'tres corridas el mismo día no resuelven');
  assert.deepStrictEqual(cycle.contarNoche({ contador: 2, presente: false, medida: true, n: 3, hoy: '2026-10-20',
    nocheContada: '2026-10-20' }), { contador: 2, resuelta: false });
  assert.deepStrictEqual(cycle.contarNoche({ contador: 2, presente: false, medida: true, n: 3, hoy: '2026-10-21',
    nocheContada: '2026-10-20' }), { contador: 3, resuelta: true });
  assert.deepStrictEqual(cycle.contarNoche({ contador: 2, presente: true, medida: false, n: 3 }), { contador: 0, resuelta: false },
    'la causa vista vuelve a cero aunque la noche no esté medida entera');
});

test('Parsear_SinPrototipoYConCRLF', () => {
  const f = cycle.nuevaFicha({ fuente: 'vigilante', causa: 'c', nombre: 'n', hoy: '2026-10-20', casos: [caso(1)] });
  const txt = cycle.serializar(f);
  assert.deepStrictEqual(cycle.parsear(txt.replace(/\n/g, '\r\n')), f, 'una ficha con fin de renglón de Windows se lee igual');
  assert.throws(() => cycle.parsear(`${txt}__proto__: {"veredicto":"pendiente"}\n`), /no es un campo/);
  assert.throws(() => cycle.parsear(`${txt}constructor: 1\n`), /no es un campo/);
  assert.throws(() => cycle.carpetasDe(tmp(), 'constructor'), /fuente desconocida/);
});

test('Casos_FueraDeLaVentana_NoSeCuentanDosVeces', () => {
  const casos = Array.from({ length: 60 }, (_, i) => caso(i));
  const f = cycle.nuevaFicha({ fuente: 'dependencias', causa: 'c', nombre: 'n', hoy: '2026-10-20', casos });
  const g = cycle.registrarAparicion(f, '2026-10-21', casos);
  assert.strictEqual(g.casos_total, 60, 'los mismos 60 casos otra noche no suman');
  assert.deepStrictEqual(g.casos, f.casos, 'los viejos no desplazan a los nuevos');
  assert.strictEqual(g.casos_vistos.length, 60);
  assert.deepStrictEqual(cycle.parsear(cycle.serializar(g)), g);
});

test('Forma_CamposDeLaPropuestaYElPedido', () => {
  const ok = cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'c', nombre: 'n', hoy: '2026-10-20', casos: [caso(1)] });
  const buenas = [
    { ...ok, propuesta: { accion: 'arreglar', razon: 'se repite cada noche', modelo: 'modelo-1' } },
    { ...ok, pedido: 1234, asignado: 'quien@acme.example' },
  ];
  for (const b of buenas) assert.deepStrictEqual(cycle.problemasDeForma(b), [], JSON.stringify(b).slice(0, 80));
  const malas = [
    { ...ok, propuesta: { accion: 'borrar', razon: 'x' } },
    { ...ok, propuesta: { accion: 'aceptar', razon: 'x'.repeat(201) } },
    { ...ok, propuesta: { accion: 'aceptar', razon: 'dos\nrenglones' } },
    { ...ok, propuesta: { accion: 'aceptar', razon: 'x', otra: 1 } },
    { ...ok, pedido: 'con espacios' },
    { ...ok, asignado: 'dos palabras' },
    { ...ok, casos_total: 0 },
    { ...ok, casos_vistos: ['no-es-huella'] },
    { ...ok, noche_contada: 'ayer' },
    { ...ok, causa: 'x'.repeat(121) },
  ];
  for (const m of malas) assert.ok(cycle.problemasDeForma(m).length > 0, `debió rechazar ${JSON.stringify(m).slice(0, 100)}`);
});

test('NochesParaResolver_MotivoSinDatosDelArchivo', () => {
  const dir = tmp();
  const p = path.join(dir, 'operations.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1, owners: { default: 'secreta@acme.example' }, findings: { resolve_after_nights: 99 } }));
  const r = cycle.nochesParaResolver(p);
  assert.strictEqual(r.ok, false);
  assert.doesNotMatch(r.motivo, /secreta|acme|99/, 'el motivo no copia valores del archivo');
  // presente pero ilegible no es «sin archivo»
  const carpeta = path.join(dir, 'es-carpeta.json');
  fs.mkdirSync(carpeta);
  assert.strictEqual(cycle.nochesParaResolver(carpeta).ok, false);
});

test('Pedido_FichaQueCuentaNoches_NoPide', () => {
  const wi = require(path.join(RAIZ, 'scripts', 'nightly', 'dependencies', 'work-items.js'));
  const dir = tmp();
  ESC.armar(dir);
  vigilar(dir, ESC.snapshot, { n: 3, ok: true });
  const fichas = deps.leerTodasLasFichas(dir);
  const pares = wi.paresPorPedir(fichas, ESC.cfg).map((x) => x.ficha.idFicha).sort();
  assert.ok(!pares.includes('aaaa1111'), 'la que cuenta sus noches sin aparecer no pide un pedido');
  assert.ok(pares.includes('bbbb2222'), 'la que sigue apareciendo sí');
});

test('Ilegibles_ReportYFotoYSalida', () => {
  const { spawnSync } = require('child_process');
  const NOC = path.join(RAIZ, 'scripts', 'nightly', 'dependencies', 'nightly-dependencies.js');
  const dir = tmp();
  ESC.armar(dir);
  fs.mkdirSync(path.join(dir, 'pending', 'carpeta.yaml'));
  // report sigue con las demás y dice cuál no pudo leer
  const r = spawnSync(process.execPath, [NOC, 'report', '--pending', dir, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /pending\/carpeta\.yaml/);
  // la ficha que cuenta y recibe un id nuevo sigue marcada como «contando» al releerse
  const rel = 'pending/aaaa1111.yaml';
  fs.writeFileSync(path.join(dir, rel), conContador(rel, 1, '2026-10-19'));
  const f = deps.leerTodasLasFichas(dir).find((x) => x.idFicha === 'aaaa1111');
  assert.strictEqual(f.contando, true);
  fs.writeFileSync(path.join(dir, rel), ESC.FICHAS[rel]);
  const g = deps.leerTodasLasFichas(dir).find((x) => x.idFicha === 'aaaa1111');
  assert.strictEqual(g.contando, false);
  // misma noche, contador ya en N: resuelta sin sumar
  assert.deepStrictEqual(cycle.contarNoche({ contador: 3, presente: false, medida: true, n: 3, hoy: '2026-10-20',
    nocheContada: '2026-10-20' }), { contador: 3, resuelta: true });
});

test('NochesParaResolver_StatQueFallaNoEsSinArchivo', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const dir = tmp();
  const cerrada = path.join(dir, 'cerrada');
  fs.mkdirSync(cerrada);
  fs.chmodSync(cerrada, 0o000);
  try {
    const r = cycle.nochesParaResolver(path.join(cerrada, 'operations.json'));
    assert.strictEqual(r.ok, false);
    assert.match(r.motivo, /no se pudo leer \(EACCES\)/);
  } finally { fs.chmodSync(cerrada, 0o700); }
});

// ── Las ejecuciones por causa, el vigilante como fuente, el resumen y los nombres ─────────────────────────────────

const RR = require(path.join(RAIZ, 'scripts', 'nightly', 'runs-review', 'runs-review.js'));
const VIG = require(path.join(RAIZ, 'scripts', 'nightly', 'watcher', 'vigilante.js'));
const DS = require(path.join(RAIZ, 'scripts', 'nightly', 'dependencies', 'daily-summary.js'));
const NOMBRES = require(path.join(RAIZ, 'scripts', 'nightly', 'findings', 'cause-names.js'));

const HOY_B = '2026-10-22';
const SID_B = (k) => `bbbbbbbb-0000-4000-8000-00000000000${k}`;
const URL_B = 'https://sitio.ejemplo.test';

/** Un volcado de `marker.js clear`: con pasos pendientes, la regla del cierre da `derivada`. */
// archivada después de la constancia del cierre (8.92): antes, la regla la cuenta aparte (runs-review T64)
const volcadoB = (sid, pendientes = [7], marca = {}) => ({ archivedAt: `${HOY_B}T22:19:00.000Z`, gates: [],
  marker: { storyId: '1.1', sessionId: sid, startedAt: `${HOY_B}T14:00:00.000Z`, stepsCompleted: [0, 1, 2, 3, 4, 5, 6],
    stepsPending: pendientes, checks: { tests: 'green' }, autonomous: true, ...marca } });
/** El buzón de mentira: `[{ maquina, base, volcado }]`, sin conversaciones (la regla del cierre lee sólo el volcado). */
function buzonB(corridas) {
  const dir = tmp();
  for (const c of corridas) {
    fs.mkdirSync(path.join(dir, c.maquina), { recursive: true });
    fs.writeFileSync(path.join(dir, c.maquina, `${c.base}.json`), JSON.stringify(c.volcado));
  }
  return dir;
}
function opsB({ url = URL_B } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'operations.json'), JSON.stringify({ version: 1, owners: { default: 'lead@ejemplo.test' }, ...(url ? { site: { url } } : {}) }));
  return dir;
}
const rrDir = (op, carpeta) => path.join(op, 'inbox', 'runs-review', carpeta);
const yamls = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort(); } catch { return []; } };
/** Las fichas por causa de una carpeta (las viejas, sin `fuente`, quedan afuera). */
const comunes = (op, carpeta = 'pending') => yamls(rrDir(op, carpeta))
  .map((f) => ({ f, txt: fs.readFileSync(path.join(rrDir(op, carpeta), f), 'utf8') }))
  .filter((x) => !sources.esVieja(x.txt)).map((x) => ({ archivo: x.f, ...cycle.parsear(x.txt) }));
const viejas = (op, carpeta) => yamls(rrDir(op, carpeta)).map((f) => ({ f, ...RR.leerFicha(path.join(rrDir(op, carpeta), f)) }))
  .filter((x) => !x.fuente);
const correrB = (mb, op, today = HOY_B, extra = {}) => RR.run({ mailbox: mb, ops: op, today, noDownload: true, ...extra });
const lastRunB = (op) => JSON.parse(fs.readFileSync(path.join(op, 'inbox', 'runs-review', 'last-run.json'), 'utf8'));
/** Una ficha por ejecución, como la escribía antes runs-review.js. */
function viejaB(op, carpeta, { id, fecha, vista, base, reglas, maquina = 'acme-0000aaaa', veredicto = 'pendiente' }) {
  fs.mkdirSync(rrDir(op, carpeta), { recursive: true });
  const nombre = `${fecha}-${maquina}-${id}-abcdef.yaml`;
  fs.writeFileSync(path.join(rrDir(op, carpeta), nombre), ['# Ficha de la revisión nocturna de las ejecuciones.',
    `id: ${JSON.stringify(id)}`, `fecha: ${JSON.stringify(fecha)}`, `maquina: ${JSON.stringify(maquina)}`, 'story: "1.1"',
    `base: ${JSON.stringify(base)}`, 'archivada: null', 'cierre: null', `reglas: ${JSON.stringify(reglas)}`, 'sin_hilo: false',
    'escapes_registro: "medido"', `enlace: ${JSON.stringify(`${URL_B}/corridas?abrir=${id}`)}`,
    `veredicto: ${JSON.stringify(veredicto)}`, `vista_por_ultima_vez: ${JSON.stringify(vista)}`, ''].join('\n'));
  return nombre;
}
const DERIVADA = { regla: 'RR-CIERRE', categoria: 'derivada', cuenta: 1 };
const APAGO = { regla: 'RR-APAGO', categoria: null, cuenta: 1 };
/** Tres fichas viejas en pending/ (cuatro casos entre dos causas) y una decidida en promoted/. */
function sembrarViejas(op) {
  viejaB(op, 'pending', { id: 'e0000000000000a1', fecha: '2026-10-18', vista: '2026-10-20', base: '1.1-2026-10-18T1000', reglas: [DERIVADA] });
  viejaB(op, 'pending', { id: 'e0000000000000a2', fecha: '2026-10-19', vista: '2026-10-21', base: '1.2-2026-10-19T1000', reglas: [DERIVADA] });
  viejaB(op, 'pending', { id: 'e0000000000000a3', fecha: '2026-10-20', vista: '2026-10-20', base: '1.3-2026-10-20T1000', reglas: [DERIVADA, APAGO] });
  return viejaB(op, 'promoted', { id: 'e0000000000000a4', fecha: '2026-10-17', vista: '2026-10-17', base: '1.4-2026-10-17T1000', reglas: [APAGO], veredicto: 'util' });
}

// T9 Ejecuciones_UnaFichaPorCausa @story-4.11 @ac-8
// 🔴 Falla con: una ficha por ejecución, una causa con `|` (no entra en la clave), el enlace guardado en el caso (un
//    cambio de site.url volvería a contar los casos) o una segunda ficha la noche que la causa vuelve.
test('T9 Ejecuciones_UnaFichaPorCausa', async () => {
  const mb = buzonB([
    { maquina: 'acme-0000aaaa', base: `1.1-${HOY_B}T1519`, volcado: volcadoB(SID_B(1)) },
    { maquina: 'acme-0000aaaa', base: `1.2-${HOY_B}T1600`, volcado: volcadoB(SID_B(2)) },
    { maquina: 'acme-0000bbbb', base: `2.1-${HOY_B}T1700`, volcado: volcadoB(SID_B(3), [], { cierre: { estado: 'abortada', via: 'persona' } }) },
  ]);
  const op = opsB();
  await correrB(mb, op);
  const f = comunes(op);
  const porCausa = Object.fromEntries(f.map((x) => [x.causa, x]));
  assert.deepStrictEqual(Object.keys(porCausa).sort(), ['RR-CIERRE:abortada', 'RR-CIERRE:derivada']);
  const d = porCausa['RR-CIERRE:derivada'];
  assert.strictEqual(d.fuente, 'ejecuciones');
  assert.strictEqual(d.archivo, `${d.id}.yaml`);
  assert.strictEqual(d.nombre, 'cerrada con pendientes', 'el nombre en llano de cause-names.js');
  assert.deepStrictEqual([d.casos.length, d.casos_total, d.apariciones, d.veredicto, d.estado], [2, 2, 1, 'pendiente', 'viva']);
  for (const c of d.casos) {
    assert.deepStrictEqual(Object.keys(c).filter((k) => !['ejecucion', 'base', 'dia', 'maquina', 'story', 'sin_hilo', 'escapes_registro'].includes(k)), []);
    assert.strictEqual(c.dia, HOY_B);
  }
  assert.strictEqual(lastRunB(op).nuevas, 2, 'las fichas por causa que nacieron esta noche');
  // el enlace se arma al leer: con el sitio, o relativo sin él
  const c0 = d.casos[0];
  assert.strictEqual(RR.enlaceDeCaso(c0, URL_B), `${URL_B}/corridas?abrir=${c0.ejecucion}`);
  assert.strictEqual(RR.enlaceDeCaso(c0, null), `/corridas?abrir=${c0.ejecucion}`);
  // la noche siguiente ve las mismas ejecuciones (siguen en la ventana): misma ficha, una aparición más, sin repetir casos
  await correrB(mb, op, '2026-10-23');
  const g = comunes(op);
  assert.strictEqual(g.length, 2, 'no nace otra ficha');
  const d2 = g.find((x) => x.causa === 'RR-CIERRE:derivada');
  assert.deepStrictEqual([d2.apariciones, d2.ultima_vez, d2.primera_vez, d2.casos.length], [2, '2026-10-23', HOY_B, 2]);
  assert.strictEqual(lastRunB(op).nuevas, 0);
});

// T10 Ejecuciones_MigracionDeFichasViejas @story-4.11 @ac-9
// 🔴 Falla con: perder un caso al agrupar, migrar lo que una persona ya decidió (promoted/), mover la vieja antes de
//    escribir su ficha por causa, contar las viejas legibles como ilegibles, o que el simulacro mueva algo.
test('T10 Ejecuciones_MigracionDeFichasViejas', async () => {
  const op = opsB();
  const decidida = sembrarViejas(op);
  const antesDecidida = fs.readFileSync(path.join(rrDir(op, 'promoted'), decidida), 'utf8');
  // el simulacro cuenta y no toca nada
  const sim = RR.migrar({ ops: op, today: HOY_B, simular: true });
  assert.deepStrictEqual(sim, { viejas: 3, causas: 2, casos: 4, ilegibles: 0, movidas: 0 });
  assert.strictEqual(viejas(op, 'pending').length, 3);
  assert.strictEqual(comunes(op).length, 0);
  // la pasada de la noche migra antes de revisar
  await correrB(buzonB([]), op);
  const f = Object.fromEntries(comunes(op).map((x) => [x.causa, x]));
  assert.deepStrictEqual(Object.keys(f).sort(), ['RR-APAGO', 'RR-CIERRE:derivada']);
  const d = f['RR-CIERRE:derivada'];
  assert.deepStrictEqual(d.casos.map((c) => c.ejecucion).sort(), ['e0000000000000a1', 'e0000000000000a2', 'e0000000000000a3']);
  assert.deepStrictEqual([d.primera_vez, d.ultima_vez, d.apariciones], ['2026-10-18', '2026-10-21', 4]);
  assert.deepStrictEqual(f['RR-APAGO'].casos.map((c) => c.ejecucion), ['e0000000000000a3']);
  assert.strictEqual(Object.values(f).reduce((s, x) => s + x.casos_total, 0), 4, 'ningún caso perdido');
  assert.strictEqual(viejas(op, 'pending').length, 0);
  const archivadas = viejas(op, 'archived');
  assert.strictEqual(archivadas.length, 3);
  for (const a of archivadas) assert.strictEqual(a.veredicto, 'migrada');
  assert.strictEqual(fs.readFileSync(path.join(rrDir(op, 'promoted'), decidida), 'utf8'), antesDecidida, 'lo decidido no se toca');
  const l = lastRunB(op);
  assert.deepStrictEqual([l.completo, l.ilegibles], [true, 0], 'las viejas legibles no son ilegibles');
});

// T11 Ejecuciones_MigracionCorreUnaSolaVez @story-4.11 @ac-9
// 🔴 Falla con: volver a migrar las archivadas como `migrada`, o sumar casos o apariciones en cada noche.
test('T11 Ejecuciones_MigracionCorreUnaSolaVez', async () => {
  const op = opsB();
  sembrarViejas(op);
  const mb = buzonB([]);
  await correrB(mb, op);
  const foto = () => comunes(op).map((x) => JSON.stringify(x)).sort();
  const una = foto();
  await correrB(mb, op);
  assert.deepStrictEqual(foto(), una);
  assert.strictEqual(viejas(op, 'archived').length, 3);
  assert.deepStrictEqual(RR.migrar({ ops: op, today: HOY_B, simular: true }), { viejas: 0, causas: 0, casos: 0, ilegibles: 0, movidas: 0 });
});

// T55 Migracion_IlegibleQuietaYCortadaSigue @story-4.11 @ac-9
// 🔴 Falla con: mover o borrar una vieja que no se lee, no contarla, o que una migración cortada duplique casos o fichas.
test('T55 Migracion_IlegibleQuietaYCortadaSigue', async () => {
  const op = opsB();
  sembrarViejas(op);
  fs.writeFileSync(path.join(rrDir(op, 'pending'), '2026-10-20-acme-0000aaaa-rota-abcdef.yaml'), 'id: {esto no es json\nreglas: "no es una lista"\n');
  // la primera noche se corta al mover la segunda vieja a archived/
  const orig = fs.renameSync;
  let movidas = 0;
  fs.renameSync = (a, b) => {
    if (String(b).includes(`${path.sep}archived${path.sep}`) && ++movidas === 2) { const e = new Error('corte'); e.code = 'EIO'; throw e; }
    return orig(a, b);
  };
  try { await correrB(buzonB([]), op); } finally { fs.renameSync = orig; }
  assert.strictEqual(lastRunB(op).completo, false);
  // la noche siguiente sigue donde quedó
  await correrB(buzonB([]), op);
  const d = comunes(op).find((x) => x.causa === 'RR-CIERRE:derivada');
  assert.strictEqual(d.casos.length, 3, 'sin casos repetidos');
  assert.strictEqual(d.apariciones, 4);
  assert.strictEqual(comunes(op).length, 2, 'sin fichas repetidas');
  assert.strictEqual(viejas(op, 'archived').length, 3);
  assert.deepStrictEqual(yamls(rrDir(op, 'pending')).filter((f) => f.includes('rota')), ['2026-10-20-acme-0000aaaa-rota-abcdef.yaml'], 'la ilegible queda quieta');
  assert.strictEqual(lastRunB(op).ilegibles, 1);
});

// T12 Vigilante_BorradorEsFicha @story-4.11 @ac-10
// 🔴 Falla con: un borrador sin fuente ni causa, un mapa de veredictos distinto del de la historia, que la vista común
//    traiga el diagnóstico, o que un borrador de antes (sin los campos nuevos) no se lea.
test('T12 Vigilante_BorradorEsFicha', () => {
  const dir = tmp();
  const p = VIG.escribirBorrador(path.join(dir, 'pending'), { producto: 'acme', regla: 'goteo', severidad: 'media', huella: '1caab4a0',
    plugin: 'p', endpoint: '/e', senal: { errores: 3 }, diagnostico: 'ZZTEXTO del diagnóstico', evidencia: [] }, '2026-10-20');
  const txt = fs.readFileSync(p, 'utf8');
  assert.match(txt, /^fuente: "vigilante"$/m);
  assert.match(txt, /^causa: "1caab4a0"$/m);
  const f = sources.comoFicha('vigilante', txt);
  assert.deepStrictEqual({ fuente: f.fuente, causa: f.causa, nombre: f.nombre, primera_vez: f.primera_vez, ultima_vez: f.ultima_vez,
    apariciones: f.apariciones, veredicto: f.veredicto, estado: f.estado },
  { fuente: 'vigilante', causa: '1caab4a0', nombre: 'goteo', primera_vez: '2026-10-20', ultima_vez: '2026-10-20', apariciones: 1,
    veredicto: 'pendiente', estado: 'viva' });
  assert.doesNotMatch(JSON.stringify(f), /ZZTEXTO/, 'la vista común no trae el diagnóstico');
  for (const [suyo, comun] of [['util', 'arreglo'], ['descartado', 'aceptada'], ['ignorado', 'ignorada']]) {
    assert.strictEqual(sources.comoFicha('vigilante', txt.replace(/^veredicto:.*$/m, `veredicto: ${suyo}`)).veredicto, comun);
  }
  const deAntes = txt.replace(/^fuente:.*\n/m, '').replace(/^causa:.*\n/m, '');
  assert.strictEqual(sources.comoFicha('vigilante', deAntes).causa, '1caab4a0', 'un borrador de antes se lee igual');
  assert.strictEqual(sources.FUENTES.vigilante.carpetaDe({ estado: 'viva', veredicto: 'arreglo' }), 'promoted');
  assert.strictEqual(sources.FUENTES.vigilante.carpetaDe({ estado: 'viva', veredicto: 'aceptada' }), 'archived');
});

/** Las carpetas de una fuente con fichas sembradas, para el renglón del resumen. */
function fuenteConFichas(carpeta, archivos) {
  const base = tmp();
  for (const [rel, txt] of Object.entries(archivos)) {
    const p = path.join(base, 'inbox', carpeta, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, txt);
  }
  return path.join(base, 'inbox', carpeta);
}
const depFicha = (id, campos) => `id: ${id}\n${Object.entries(campos).map(([k, v]) => `${k}: ${v}`).join('\n')}\nrepos:\n  - acme/repo\n`;
const comun = (causa, extra = {}) => cycle.serializar({ ...cycle.nuevaFicha({ fuente: 'ejecuciones', causa, nombre: NOMBRES.nombreDe('ejecuciones', { regla: causa.split(':')[0], categoria: causa.split(':')[1] || null }), hoy: '2026-10-10' }), ...extra });

// T13 Resumen_RubrosIgualesPorFuente @story-4.11 @ac-11
// 🔴 Falla con: un rubro distinto por fuente, un 0 donde la noche todavía no mide (reaparecidas y resueltas del
//    vigilante y de ejecuciones), o contar una resuelta como viva.
test('T13 Resumen_RubrosIgualesPorFuente', () => {
  const dep = fuenteConFichas('dependencies', {
    'pending/a.yaml': depFicha('a', { detectado: HOY_B, veredicto: 'pendiente', paquete: 'js-yaml', severidad: 'high' }),
    'pending/b.yaml': depFicha('b', { detectado: '2026-10-01', veredicto: 'pendiente', reaparecido: HOY_B, paquete: 'x', severidad: 'low' }),
    'promoted/c.yaml': depFicha('c', { detectado: '2026-10-01', veredicto: 'util', resuelto: HOY_B, paquete: 'y', severidad: 'low' }),
    'archived/d.yaml': depFicha('d', { detectado: '2026-10-01', veredicto: 'descartado', paquete: 'z', severidad: 'low' }),
  });
  assert.strictEqual(DS.lineaFichas('dependencias', dep, HOY_B), 'fichas de dependencias: vivas 2 · nuevas 1 · reaparecidas 1 · resueltas 1');
  const ej = fuenteConFichas('runs-review', {
    'pending/x.yaml': cycle.serializar({ ...cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-APAGO', nombre: 'pipeline pasado a manual', hoy: HOY_B }) }),
    'pending/y.yaml': comun('RR-CIERRE:derivada'),
    'promoted/z.yaml': comun('RR-CIERRE:abortada', { veredicto: 'aceptada' }),
    'archived/2026-10-01-acme-e0-abcdef.yaml': 'id: "e0"\nreglas: []\nveredicto: "migrada"\n',
  });
  const NM = 'reaparecidas ? (no medido) · resueltas ? (no medido)';
  assert.strictEqual(DS.lineaFichas('ejecuciones', ej, HOY_B), `fichas de ejecuciones: vivas 2 · nuevas 1 · ${NM}`);
  const vig = tmp();
  VIG.escribirBorrador(path.join(vig, 'pending'), { producto: 'acme', regla: 'deriva', severidad: 'alta', huella: 'aaaa0001', plugin: 'p',
    endpoint: null, senal: {}, diagnostico: 'd', evidencia: [] }, HOY_B);
  assert.strictEqual(DS.lineaFichas('vigilante', vig, HOY_B), `fichas de vigilante: vivas 1 · nuevas 1 · ${NM}`);
  assert.match(DS.lineaFichas('ejecuciones', path.join(tmp(), 'no-esta'), HOY_B), /^fichas de ejecuciones: \? \(no se pudieron leer\)$/);
});

// T14 Resumen_AceptadasNoSeRepiten @story-4.11 @ac-11
// 🔴 Falla con: contar las aceptadas entre las vivas, o repetir en la lista de ejecuciones una causa ya aceptada.
test('T14 Resumen_AceptadasNoSeRepiten', () => {
  const base = tmp();
  const raiz = path.join(base, 'inbox', 'runs-review');
  fs.mkdirSync(path.join(raiz, 'promoted'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'promoted', 'z.yaml'), comun('RR-APAGO', { veredicto: 'aceptada' }));
  fs.writeFileSync(path.join(raiz, 'last-run.json'), JSON.stringify({ fecha: HOY_B, completo: true, motivo: null, miradas: 9, con_fallas: 5,
    nuevas: 0, sin_hilo: 0, hilos_sin_hooks: 0, ilegibles: 0, causas: [
      { regla: 'RR-APAGO', categoria: null, ejecuciones: 3, nueva: false },
      { regla: 'RR-CIERRE', categoria: 'derivada', ejecuciones: 2, nueva: false }] }));
  const lineas = DS.lineaEjecuciones(base, HOY_B);
  assert.ok(lineas.includes('· cerrada con pendientes: 2'));
  assert.ok(!lineas.some((l) => l.includes('pipeline pasado a manual')), 'la causa aceptada no se repite');
  assert.match(DS.lineaFichas('ejecuciones', raiz, HOY_B), /vivas 0/);
});

// T15 Nombres_MudanzaSinCambiarTexto @story-4.11 @ac-12
// 🔴 Falla con: cambiar una letra de la tabla al mudarla (la huella es la de la tabla de antes), que el resumen use otra
//    copia, o un nombre de más de 120 caracteres o con un salto de renglón.
test('T15 Nombres_MudanzaSinCambiarTexto', () => {
  const crypto = require('crypto');
  assert.strictEqual(crypto.createHash('sha1').update(JSON.stringify(NOMBRES.NOMBRES_CAUSA)).digest('hex'), 'fd038a3b2dc6425db833b67c3794569e062be4c3');
  assert.strictEqual(DS.NOMBRES_CAUSA, NOMBRES.NOMBRES_CAUSA, 'el resumen usa la misma tabla');
  assert.strictEqual(NOMBRES.nombreDe('ejecuciones', { regla: 'RR-HOOK', categoria: 'Stop/tiempo' }), 'aviso automático que se pasó de tiempo');
  assert.strictEqual(NOMBRES.nombreDe('ejecuciones', { regla: 'RR-ESCAPE', categoria: 'ZZDESCONOCIDA' }), 'otro freno salteado');
  assert.strictEqual(NOMBRES.nombreDe('dependencias', { paquete: 'js-yaml', severidad: 'high' }), 'js-yaml (high)');
  assert.strictEqual(NOMBRES.nombreDe('vigilante', { regla: 'goteo' }), 'goteo');
  const largo = NOMBRES.nombreDe('dependencias', { paquete: `${'a'.repeat(200)}\nZZ`, severidad: 'high' });
  assert.ok(largo.length <= 120 && !/[\n\r]/.test(largo));
});

// ── Las fichas que no se leen, la migración cortada y el comando del simulacro ─────────────────────────────────────

// Migracion_ReglasRotas_QuedaYSeCuenta @story-4.11 @ac-9
// 🔴 Falla con: tomar como legible una vieja cuyo `reglas:` no es JSON (se archiva vacía y sus causas se pierden).
test('Migracion_ReglasRotas_QuedaYSeCuenta', () => {
  const op = opsB();
  fs.mkdirSync(rrDir(op, 'pending'), { recursive: true });
  const p = path.join(rrDir(op, 'pending'), '2026-10-22-acme-0000aaaa-e0000000000000b1-abcdef.yaml');
  const txt = 'id: "e0000000000000b1"\nfecha: "2026-10-22"\nbase: "1.1-2026-10-22T1000"\nreglas: [{"regla":"RR-APAGO","categoria":null,"cuenta":1},{"regla":"RR-ESCAPE"\nveredicto: "pendiente"\n';
  fs.writeFileSync(p, txt);
  assert.deepStrictEqual(RR.migrar({ ops: op, today: HOY_B }), { viejas: 0, causas: 0, casos: 0, ilegibles: 1, movidas: 0 });
  assert.strictEqual(fs.readFileSync(p, 'utf8'), txt, 'queda quieta, sin tocar');
  assert.strictEqual(viejas(op, 'archived').length, 0);
});

// Migracion_FichaArchivadaNoSeToca @story-4.11 @ac-9
// 🔴 Falla con: sumarle casos o apariciones a una ficha por causa que está en archived/ (la decisión 3 la deja quieta).
test('Migracion_FichaArchivadaNoSeToca', () => {
  const op = opsB();
  const archivada = cycle.serializar({ ...cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-APAGO', nombre: 'pipeline pasado a manual', hoy: '2026-10-01' }), veredicto: 'ignorada' });
  const f = cycle.parsear(archivada);
  fs.mkdirSync(rrDir(op, 'archived'), { recursive: true });
  fs.writeFileSync(path.join(rrDir(op, 'archived'), `${f.id}.yaml`), archivada);
  viejaB(op, 'pending', { id: 'e0000000000000c1', fecha: '2026-10-20', vista: '2026-10-21', base: '1.1-2026-10-20T1000', reglas: [APAGO] });
  RR.migrar({ ops: op, today: HOY_B });
  assert.strictEqual(fs.readFileSync(path.join(rrDir(op, 'archived'), `${f.id}.yaml`), 'utf8'), archivada);
  assert.strictEqual(comunes(op).length, 0, 'no nace otra ficha de la misma causa');
  assert.strictEqual(viejas(op, 'archived')[0].veredicto, 'migrada', 'sus casos quedan en la migrada');
});

// Migracion_DiaComoLaPasada @story-4.11 @ac-9
// 🔴 Falla con: armar el día del caso con la fecha de la ficha vieja cuando el nombre del volcado no la trae: la pasada
//    usa la hora de archivado, y la misma ejecución quedaría dos veces en la ficha.
test('Migracion_DiaComoLaPasada', () => {
  const op = opsB();
  const nombre = viejaB(op, 'pending', { id: 'e0000000000000d1', fecha: '2026-10-21', vista: '2026-10-21', base: 'sin-fecha-en-el-nombre', reglas: [APAGO] });
  const p = path.join(rrDir(op, 'pending'), nombre);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('archivada: null', 'archivada: "2026-10-19T10:00:00.000Z"'));
  RR.migrar({ ops: op, today: HOY_B });
  assert.strictEqual(comunes(op)[0].casos[0].dia, '2026-10-19');
});

// Pasada_CorteDespuesDeEscribir_NoRepiteNuevas @story-4.11 @ac-8
// 🔴 Falla con: que el camino del error vuelva a escribir las causas ya escritas y las cuente otra vez como nuevas.
test('Pasada_CorteDespuesDeEscribir_NoRepiteNuevas', async () => {
  const mb = buzonB([
    { maquina: 'acme-0000aaaa', base: `1.1-${HOY_B}T1519`, volcado: volcadoB(SID_B(1)) },
    { maquina: 'acme-0000bbbb', base: `2.1-${HOY_B}T1700`, volcado: volcadoB(SID_B(3), [], { cierre: { estado: 'abortada', via: 'persona' } }) },
  ]);
  const op = opsB();
  const orig = fs.renameSync;
  fs.renameSync = (a, b) => { if (String(b).endsWith('causas-vistas.json')) { const e = new Error('corte'); e.code = 'EIO'; throw e; } return orig(a, b); };
  try { await correrB(mb, op); } finally { fs.renameSync = orig; }
  assert.strictEqual(lastRunB(op).completo, false);
  assert.strictEqual(lastRunB(op).nuevas, 2, 'dos causas nuevas, contadas una vez');
  assert.strictEqual(comunes(op).length, 2);
});

// FichaPorCausaIlegible_NoSePisa @story-4.11 @ac-7 @ac-8
// 🔴 Falla con: escribir una ficha nueva encima de la de la misma causa que no se pudo leer (se pierden su veredicto y
//    sus casos), o no contarla.
test('FichaPorCausaIlegible_NoSePisa', async () => {
  const op = opsB();
  const id = cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-CIERRE:derivada', nombre: 'x', hoy: HOY_B }).id;
  fs.mkdirSync(rrDir(op, 'promoted'), { recursive: true });
  const rota = path.join(rrDir(op, 'promoted'), `${id}.yaml`);
  fs.writeFileSync(rota, 'fuente: "ejecuciones"\nveredicto: {esto no es json\n');
  await correrB(buzonB([{ maquina: 'acme-0000aaaa', base: `1.1-${HOY_B}T1519`, volcado: volcadoB(SID_B(1)) }]), op);
  assert.strictEqual(fs.readFileSync(rota, 'utf8'), 'fuente: "ejecuciones"\nveredicto: {esto no es json\n');
  assert.strictEqual(fs.existsSync(path.join(rrDir(op, 'pending'), `${id}.yaml`)), false, 'no nace otra con el mismo nombre');
  assert.ok(lastRunB(op).ilegibles >= 1);
  assert.strictEqual(lastRunB(op).nuevas, 0);
});

// Resumen_FichasQueNoSeLeen_NoSonCero @story-4.11 @ac-11
// 🔴 Falla con: tomar una carpeta que no se puede leer como vacía («vivas 0»), o una ficha ilegible como que no está.
test('Resumen_FichasQueNoSeLeen_NoSonCero', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const ej = fuenteConFichas('runs-review', { 'pending/y.yaml': comun('RR-CIERRE:derivada'), 'pending/rota.yaml': 'fuente: "ejecuciones"\nid: {mal\n' });
  assert.strictEqual(DS.lineaFichas('ejecuciones', ej, HOY_B), 'fichas de ejecuciones: vivas 1 · nuevas 0 · reaparecidas ? (no medido) · resueltas ? (no medido) · ilegibles 1');
  fs.chmodSync(path.join(ej, 'pending'), 0o000);
  try {
    assert.strictEqual(DS.lineaFichas('ejecuciones', ej, HOY_B), 'fichas de ejecuciones: ? (no se pudieron leer)');
  } finally { fs.chmodSync(path.join(ej, 'pending'), 0o700); }
});

// Migracion_FichaPorCausaIlegible_LaViejaEspera @story-4.11 @ac-9
// 🔴 Falla con: archivar como migrada una vieja cuya ficha por causa no se pudo leer (sus casos no quedan en ningún
//    lado), o pisar esa ficha.
test('Migracion_FichaPorCausaIlegible_LaViejaEspera', () => {
  const op = opsB();
  const id = cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-APAGO', nombre: 'x', hoy: HOY_B }).id;
  fs.mkdirSync(rrDir(op, 'pending'), { recursive: true });
  const rota = path.join(rrDir(op, 'pending'), `${id}.yaml`);
  fs.writeFileSync(rota, 'fuente: "ejecuciones"\nid: {mal\n');
  const vieja = viejaB(op, 'pending', { id: 'e0000000000000f1', fecha: '2026-10-20', vista: '2026-10-21', base: '1.1-2026-10-20T1000', reglas: [APAGO] });
  const r = RR.migrar({ ops: op, today: HOY_B });
  assert.deepStrictEqual([r.movidas, r.ilegibles >= 1], [0, true]);
  assert.ok(fs.existsSync(path.join(rrDir(op, 'pending'), vieja)), 'la vieja espera en pending/');
  assert.strictEqual(fs.readFileSync(rota, 'utf8'), 'fuente: "ejecuciones"\nid: {mal\n', 'la ilegible no se pisa');
});

// Migrate_PorLaLineaDeComandos @story-4.11 @ac-9
// 🔴 Falla con: un simulacro que mueve archivos, un código de salida 0 con alguna ilegible, o un uso mal hecho que no
//    sale 2.
test('Migrate_PorLaLineaDeComandos', () => {
  const { spawnSync } = require('child_process');
  const guion = path.join(RAIZ, 'scripts', 'nightly', 'runs-review', 'runs-review.js');
  const correrGuion = (args) => spawnSync(process.execPath, [guion, ...args], { encoding: 'utf8', input: '' });
  const op = opsB();
  sembrarViejas(op);
  const sim = correrGuion(['migrate', '--operations', op, '--today', HOY_B, '--dry-run']);
  assert.strictEqual(sim.status, 0);
  assert.deepStrictEqual(JSON.parse(sim.stdout), { viejas: 3, causas: 2, casos: 4, ilegibles: 0, movidas: 0 });
  assert.strictEqual(viejas(op, 'pending').length, 3, 'el simulacro no mueve nada');
  fs.writeFileSync(path.join(rrDir(op, 'pending'), '2026-10-20-acme-rota-abcdef.yaml'), 'id: {mal\nreglas: "x"\n');
  const real = correrGuion(['migrate', '--operations', op, '--today', HOY_B]);
  assert.strictEqual(real.status, 1, 'con alguna ilegible sale 1');
  assert.strictEqual(JSON.parse(real.stdout).movidas, 3);
  assert.strictEqual(correrGuion(['migrate', '--operations', op]).status, 2, 'sin --today es un uso mal hecho');
});

// Resumen_RenglonDelVigilante_EnSuSeccion @story-4.11 @ac-11
// 🔴 Falla con: que la sección del vigilante no traiga su renglón de fichas.
test('Resumen_RenglonDelVigilante_EnSuSeccion', () => {
  const base = tmp();
  const out = path.join(base, 'out');
  const vig = path.join(base, 'inbox', 'watcher');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `vigilante-${HOY_B}.json`), JSON.stringify({ fecha: HOY_B, hallazgos: [], no_medido: [], ignorados_ids: [] }));
  VIG.escribirBorrador(path.join(vig, 'pending'), { producto: 'acme', regla: 'goteo', severidad: 'media', huella: 'aaaa0002', plugin: 'p',
    endpoint: null, senal: {}, diagnostico: 'd', evidencia: [] }, HOY_B);
  const r = DS.armar({ fuente: 'vigilante', hoy: HOY_B, out, pending: vig, resumenConfig: path.join(base, 'no-esta.json'), runs: null, weekly: null });
  assert.ok(r.texto.split('\n').includes(`fichas de vigilante: vivas 1 · nuevas 1 · reaparecidas ? (no medido) · resueltas ? (no medido)`), r.texto);
});

// Resumen_ConstanciaDeFichasAlterada_NoSeVuelveAEscribir @story-4.11 @ac-11
// 🔴 Falla con: volver a escribir a las 08:00 un renglón de fichas que alguien cambió en la constancia.
test('Resumen_ConstanciaDeFichasAlterada_NoSeVuelveAEscribir', () => {
  const bueno = 'fichas de ejecuciones: vivas 2 · nuevas 1 · reaparecidas ? (no medido) · resueltas ? (no medido)';
  assert.deepStrictEqual(DS.fichasDeLaConstancia({ fichas: [bueno] }), [bueno]);
  assert.strictEqual(DS.fichasDeLaConstancia({ fichas: [bueno, 'fichas de ejecuciones: ZZTEXTO de una conversación'] }), null);
  assert.strictEqual(DS.fichasDeLaConstancia({ fichas: [bueno, bueno, bueno, bueno] }), null, 'más de tres no es la forma');
  assert.strictEqual(DS.fichasDeLaConstancia({ fichas: 'no es lista' }), null);
  assert.strictEqual(DS.fichasDeLaConstancia({}), null);
});

// Ejecuciones_NuevaSinCausasVistas_SaleDeLasFichas @story-4.11 @ac-8
// 🔴 Falla con: tomar como nueva una causa que ya tiene su ficha de antes de hoy cuando falta causas-vistas.json.
test('Ejecuciones_NuevaSinCausasVistas_SaleDeLasFichas', async () => {
  const mb = buzonB([{ maquina: 'acme-0000aaaa', base: `1.1-${HOY_B}T1519`, volcado: volcadoB(SID_B(1)) }]);
  const op = opsB();
  await correrB(mb, op);
  assert.strictEqual(lastRunB(op).causas[0].nueva, true);
  fs.unlinkSync(path.join(op, 'inbox', 'runs-review', 'causas-vistas.json'));
  await correrB(mb, op, '2026-10-23');
  assert.deepStrictEqual(lastRunB(op).causas.map((c) => c.nueva), [false], 'la primera_vez de su ficha dice que ya se conocía');
});

// ── la decisión del sitio la aplica la noche ────────────────────────────────────────────

/** Un repo de operaciones de juguete con dos fichas pendientes de cada fuente, en su formato. */
function opsConFichas() {
  const base = tmp();
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), txt); };
  escribir('inbox/dependencies/pending/dep-uno.yaml', 'id: dep-uno\ndetectado: 2026-10-20\nveredicto: pendiente\npaquete: pkg-uno\nseveridad: high\nnoches: 2\nrepos:\n  - Producto X/FrontEnd\n');
  escribir('inbox/dependencies/pending/dep-dos.yaml', 'id: dep-dos\ndetectado: 2026-10-20\nveredicto: pendiente\npaquete: pkg-dos\nseveridad: low\nnoches: 1\n');
  escribir('inbox/watcher/pending/vig-uno.yaml', '# borrador del vigilante\nid: vig-uno\nfuente: vigilante\ncausa: acme:errores-500\nfecha: 2026-10-21\nproducto: acme\nregla: errores-500\nveredicto: pendiente\n');
  escribir('inbox/watcher/pending/vig-dos.yaml', 'id: vig-dos\nfuente: vigilante\ncausa: acme:lentitud\nfecha: 2026-10-21\nproducto: acme\nregla: lentitud\nveredicto: pendiente\n');
  const ej = cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-ESCAPE:TYCON_NO_DEEP_REVIEW', nombre: 'Se saltó el pase adversarial', hoy: '2026-10-21' });
  const ej2 = cycle.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-ROJO:pruebas', nombre: 'Las pruebas quedaron en rojo', hoy: '2026-10-21' });
  escribir(`inbox/runs-review/pending/${ej.id}.yaml`, cycle.serializar(ej));
  escribir(`inbox/runs-review/pending/${ej2.id}.yaml`, cycle.serializar(ej2));
  const decidir = (carpeta, id, d) => escribir(`inbox/${carpeta}/decisions/${id}.json`, typeof d === 'string' ? d : JSON.stringify(d));
  return { base, ej, ej2, decidir };
}
const decision = (fuente, id, accion) => ({ fuente, id, accion, quien: 'lead@acme.example', el: '2026-10-24' });

// Noche_DecisionSinForma_QuedaYSeCuenta @story-4.11 @ac-20
// 🔴 Falla con: aplicar una decisión sin forma (o un «aceptar» de dependencias), o dejar viva la decisión de una ficha que
// ya no está pendiente.
test('T68 Noche_DecisionSinForma_QuedaYSeCuenta', () => {
  const { base, ej, ej2, decidir } = opsConFichas();
  // las tres fuentes con su mapa (decisión 16)
  decidir('dependencies', 'dep-uno', decision('dependencias', 'dep-uno', 'arreglar'));
  decidir('watcher', 'vig-uno', decision('vigilante', 'vig-uno', 'aceptar'));
  decidir('watcher', 'vig-dos', decision('vigilante', 'vig-dos', 'arreglar'));
  decidir('runs-review', ej.id, decision('ejecuciones', ej.id, 'aceptar'));
  decidir('runs-review', ej2.id, decision('ejecuciones', ej2.id, 'arreglar'));
  // sin forma: un «aceptar» de dependencias (decisión 14), JSON roto, una clave de más, una fuente que no es la suya
  decidir('dependencies', 'dep-dos', decision('dependencias', 'dep-dos', 'aceptar'));
  decidir('dependencies', 'rota', '{ no es json');
  decidir('watcher', 'vig-extra', { ...decision('vigilante', 'vig-extra', 'aceptar'), nota: 'texto libre' });
  decidir('runs-review', 'otra-fuente', decision('vigilante', 'otra-fuente', 'aceptar'));
  // la de una ficha que no está
  decidir('watcher', 'no-esta', decision('vigilante', 'no-esta', 'aceptar'));

  const dep = cycle.aplicarDecisiones({ base, fuente: 'dependencias' });
  const vig = cycle.aplicarDecisiones({ base, fuente: 'vigilante' });
  const eje = cycle.aplicarDecisiones({ base, fuente: 'ejecuciones' });

  const en = (rel) => fs.existsSync(path.join(base, rel));
  const leer = (rel) => fs.readFileSync(path.join(base, rel), 'utf8');
  // dependencias: arreglar → util, a promoted/, decisión borrada
  assert.ok(en('inbox/dependencies/promoted/dep-uno.yaml') && !en('inbox/dependencies/pending/dep-uno.yaml'));
  assert.match(leer('inbox/dependencies/promoted/dep-uno.yaml'), /^veredicto: util$/m);
  assert.match(leer('inbox/dependencies/promoted/dep-uno.yaml'), /^repos:\n {2}- Producto X\/FrontEnd$/m, 'el resto de la ficha queda igual');
  assert.ok(!en('inbox/dependencies/decisions/dep-uno.json'));
  // el vigilante: aceptar → descartado (archived/), arreglar → util (promoted/); el comentario del borrador sigue
  assert.match(leer('inbox/watcher/archived/vig-uno.yaml'), /^veredicto: descartado$/m);
  assert.match(leer('inbox/watcher/archived/vig-uno.yaml'), /^# borrador del vigilante$/m);
  assert.match(leer('inbox/watcher/promoted/vig-dos.yaml'), /^veredicto: util$/m);
  // ejecuciones: aceptar → aceptada, arreglar → arreglo; las dos a promoted/ y se siguen leyendo
  assert.strictEqual(cycle.parsear(leer(`inbox/runs-review/promoted/${ej.id}.yaml`)).veredicto, 'aceptada');
  assert.strictEqual(cycle.parsear(leer(`inbox/runs-review/promoted/${ej2.id}.yaml`)).veredicto, 'arreglo');
  assert.deepStrictEqual([dep.aplicadas.length, vig.aplicadas.length, eje.aplicadas.length], [1, 2, 2]);

  // las sin forma quedan en decisions/ y se cuentan; la ficha de dependencias sigue pendiente
  assert.ok(en('inbox/dependencies/decisions/dep-dos.json') && en('inbox/dependencies/decisions/rota.json'));
  assert.ok(en('inbox/dependencies/pending/dep-dos.yaml'));
  assert.ok(en('inbox/watcher/decisions/vig-extra.json') && en('inbox/runs-review/decisions/otra-fuente.json'));
  assert.deepStrictEqual([dep.sinForma, vig.sinForma, eje.sinForma], [2, 1, 1]);
  assert.ok(dep.lineas.some((l) => /sin la forma esperada/.test(l)), dep.lineas.join('\n'));
  assert.ok(!dep.lineas.join('\n').includes('no es json'), 'el contenido de la decisión no va a la salida');

  // la de una ficha que no está se borra con su renglón
  assert.ok(!en('inbox/watcher/decisions/no-esta.json'));
  assert.deepStrictEqual(vig.borradas.map((b) => b.id), ['no-esta']);
  assert.ok(vig.lineas.some((l) => /no-esta.*no está pendiente/.test(l)), vig.lineas.join('\n'));

  // una segunda noche con la decisión de una ficha que ya se decidió: se borra, la ficha no se toca
  decidir('watcher', 'vig-dos', decision('vigilante', 'vig-dos', 'aceptar'));
  const otra = cycle.aplicarDecisiones({ base, fuente: 'vigilante' });
  assert.deepStrictEqual([otra.aplicadas.length, otra.borradas.length], [0, 1]);
  assert.match(leer('inbox/watcher/promoted/vig-dos.yaml'), /^veredicto: util$/m);
  // sin carpeta de decisiones: nada que aplicar, sin error
  assert.deepStrictEqual(cycle.aplicarDecisiones({ base: tmp(), fuente: 'ejecuciones' }), { aplicadas: [], borradas: [], sinForma: 0, ilegibles: 0, lineas: [] });

  // 🔴 «no pude leer la ficha» no es «ya no está pendiente»: la decisión de la persona queda y se cuenta
  const b2 = opsConFichas();
  fs.mkdirSync(path.join(b2.base, 'inbox/watcher/pending/vig-tapada.yaml'));   // una carpeta con el nombre de la ficha
  b2.decidir('watcher', 'vig-tapada', decision('vigilante', 'vig-tapada', 'aceptar'));
  fs.writeFileSync(path.join(b2.base, `inbox/runs-review/pending/${b2.ej.id}.yaml`), 'esto: [ no es una ficha\n');
  b2.decidir('runs-review', b2.ej.id, decision('ejecuciones', b2.ej.id, 'aceptar'));
  const v2 = cycle.aplicarDecisiones({ base: b2.base, fuente: 'vigilante' });
  const e2 = cycle.aplicarDecisiones({ base: b2.base, fuente: 'ejecuciones' });
  assert.ok(fs.existsSync(path.join(b2.base, 'inbox/watcher/decisions/vig-tapada.json')), 'la decisión sobre una ficha que no se lee queda');
  assert.ok(fs.existsSync(path.join(b2.base, `inbox/runs-review/decisions/${b2.ej.id}.json`)), 'también la de una ficha que no se entiende');
  assert.deepStrictEqual([v2.ilegibles, v2.borradas.length, e2.ilegibles, e2.borradas.length], [1, 0, 1, 0]);
  assert.ok(v2.lineas.some((l) => /vig-tapada.*no se pudo leer/.test(l)), v2.lineas.join('\n'));
  // una carpeta de decisiones que no se puede leer se dice, sin tumbar la noche
  const b3 = tmp();
  fs.mkdirSync(path.join(b3, 'inbox/dependencies'), { recursive: true });
  fs.writeFileSync(path.join(b3, 'inbox/dependencies/decisions'), 'no es una carpeta');
  const d3 = cycle.aplicarDecisiones({ base: b3, fuente: 'dependencias' });
  assert.strictEqual(d3.ilegibles, 1);
  assert.ok(d3.lineas.some((l) => /carpeta de decisiones no se pudo leer/.test(l)), d3.lineas.join('\n'));
});

// SitioDecide_PorSiteUrl @story-4.11 @ac-20
// 🔴 Falla con: decir que el sitio decide sin `site.url`, o tratar un operations.json ilegible como «sí».
test('T67 SitioDecide_PorSiteUrl (el lector que pregunta el guion)', () => {
  const { spawnSync } = require('child_process');
  const base = tmp();
  let n = 0;
  const ops = (doc) => { const p = path.join(base, `ops-${n += 1}.json`); fs.writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc)); return p; };
  assert.strictEqual(cycle.sitioDecide(ops({ version: 1, site: { url: 'https://sitio.acme.example' } })).codigo, 0);
  assert.strictEqual(cycle.sitioDecide(ops({ version: 1, site: { refresh_minutes: 15 } })).codigo, 1);
  assert.strictEqual(cycle.sitioDecide(ops({ version: 1 })).codigo, 1);
  assert.strictEqual(cycle.sitioDecide(path.join(base, 'no-esta.json')).codigo, 1);
  const ilegible = cycle.sitioDecide(ops('{ roto'));
  assert.strictEqual(ilegible.codigo, 2);
  assert.ok(ilegible.motivo && !/roto/.test(ilegible.motivo), ilegible.motivo);
  // por la línea de comandos: el código de salida y el motivo en un renglón
  const CLI = path.join(RAIZ, 'scripts', 'nightly', 'findings', 'cycle.js');
  const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
  const si = cli('site-decides', '--operations', ops({ version: 1, site: { url: 'https://sitio.acme.example' } }));
  assert.strictEqual(si.status, 0, si.stderr);
  assert.strictEqual(si.stdout.trim().split('\n').length, 1);
  assert.strictEqual(cli('site-decides', '--operations', ops({ version: 1 })).status, 1);
  assert.strictEqual(cli('site-decides', '--operations', ops('{ roto')).status, 2);
  assert.strictEqual(cli('site-decides').status, 2);
});
