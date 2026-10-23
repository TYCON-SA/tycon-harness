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
