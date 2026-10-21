'use strict';
// people.test.js — quién es quién: los correos que informan las máquinas, la regla de quién ve qué máquina,
// el plazo de la configuración rota, las máquinas por confirmar y dónde trabaja cada persona.
// Correos, máquinas y productos inventados.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RAIZ = path.resolve(__dirname, '..', '..');
const ARCHIVO = path.join(RAIZ, 'scripts', 'lib', 'people.js');
const P = require(ARCHIVO);

const sha = (c) => crypto.createHash('sha256').update(String(c).trim().toLowerCase()).digest('hex');
// la huella de una carpeta sin corridas (la unión pide la huella de lo que la máquina subió a la vieja)
const HUELLA_VACIA = crypto.createHash('sha256').update('').digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'people-'));
/** espejo(dir, { maq: place | 'roto' | null, ... }) — la forma que deja el bajador */
function espejo(dir, maquinas, corridas = {}) {
  for (const [m, place] of Object.entries(maquinas)) {
    const reg = path.join(dir, m, 'registros');
    fs.mkdirSync(reg, { recursive: true });
    if (place === 'roto') fs.writeFileSync(path.join(reg, 'place.json'), '{ esto no es json');
    else if (place) fs.writeFileSync(path.join(reg, 'place.json'), JSON.stringify(place));
    for (let i = 0; i < (corridas[m] || 0); i++) fs.writeFileSync(path.join(dir, m, `9.${i}-2026-10-14T0900.json`), '{}');
  }
  return dir;
}
const informa = (correo, day = '2026-10-15', folder) => ({ schema: 1, day, owner: { email: correo, source: 'git-global' }, ...(folder ? { folder } : {}) });
const noMedido = (reason, day = '2026-10-15') => ({ schema: 1, day, owner: { status: 'no_medido', reason } });
const conf = (person, reported, by = 'jefa@acme.example') => ({ person, reported_sha256: reported, confirmed_by: by, confirmed_on: '2026-10-15' });

// ── T4 · LeerCorreosInformados_DelEspejo ── 🔴 Falla si tira con el JSON roto.
test('2.28 T4 LeerCorreosInformados_DelEspejo', () => {
  const dir = espejo(tmp(), { 'maq-a': informa('dev-a@ejemplo.test'), 'maq-b': null, 'maq-c': 'roto', 'maq-d': noMedido('esta máquina no tiene configuración global de git') });
  const antes = fs.readdirSync(dir).sort();
  const r = P.leerCorreosInformados(dir);
  assert.deepEqual(r.maquinas['maq-a'], { estado: 'informa', correo: 'dev-a@ejemplo.test', dia: '2026-10-15', corridas: 0 });
  assert.equal(r.maquinas['maq-b'].estado, 'no_informa');
  assert.ok(r.maquinas['maq-b'].motivo);
  assert.equal(r.maquinas['maq-c'].estado, 'ilegible');
  assert.ok(r.maquinas['maq-c'].motivo);
  assert.equal(r.maquinas['maq-d'].estado, 'no_informa');
  assert.equal(r.maquinas['maq-d'].motivo, 'esta máquina no tiene configuración global de git');
  assert.deepEqual(fs.readdirSync(dir).sort(), antes, 'no escribe nada en el espejo');
  assert.doesNotThrow(() => P.leerCorreosInformados(path.join(dir, 'no-existe')));
  // el motivo viene de OTRA máquina: sin controles ni separadores de línea, y acotado (pase de seguridad)
  const sucio = `x${String.fromCharCode(0x2028)}y${String.fromCharCode(7)}z${'w'.repeat(500)}`;
  const r2 = P.leerCorreosInformados(espejo(tmp(), { 'maq-e': noMedido(sucio) }));
  const m = r2.maquinas['maq-e'].motivo;
  assert.ok(!/[\u0000-\u001f]/.test(m) && !m.includes(String.fromCharCode(0x2028)) && m.length <= 200, JSON.stringify(m.slice(0, 40)));
});

/** ctx con la configuración, los mantenedores y lo informado */
function ctx({ machines = {}, projects, maintainers = ['jefa@acme.example'], espejoDir, maquinas = {}, corridas = {} }) {
  const dir = espejoDir || espejo(tmp(), maquinas, corridas);
  return P.contexto({ operations: { people: { machines, ...(projects ? { projects } : {}) }, site: { maintainers } }, informados: P.leerCorreosInformados(dir) });
}

// ── T7 · EstadoDeMaquina_CuatroEstados ──
test('2.28 T7 EstadoDeMaquina_CuatroEstados', () => {
  const c = ctx({
    maquinas: { 'maq-a': informa('dev-a@ejemplo.test'), 'maq-b': informa('dev-b@ejemplo.test'), 'maq-c': informa('otro@ejemplo.test'), 'maq-d': null },
    machines: { 'maq-a': conf('dev-a@ejemplo.test', sha('dev-a@ejemplo.test')), 'maq-c': conf('dev-c@ejemplo.test', sha('dev-c@ejemplo.test')) },
  });
  assert.equal(P.estadoDeMaquina('maq-a', c).estado, 'confirmada');
  assert.equal(P.estadoDeMaquina('maq-b', c).estado, 'sin_confirmar');
  assert.equal(P.estadoDeMaquina('maq-c', c).estado, 'cambio');
  assert.equal(P.estadoDeMaquina('maq-d', c).estado, 'sin_correo');
  for (const m of ['maq-a', 'maq-b', 'maq-c', 'maq-d']) assert.ok(P.estadoDeMaquina(m, c).motivo, `motivo de ${m}`);
});

// ── T8 · PuedeVer_MantenedorTodo_PersonaLoSuyo_SueltaSoloMantenedor ── 🔴 Falla si la suelta es visible para una
//    persona; la de `cambio` sin rol.
test('2.28 T8 PuedeVer_MantenedorTodo_PersonaLoSuyo_SueltaSoloMantenedor', () => {
  const c = ctx({
    maquinas: { 'maq-a': informa('dev-a@ejemplo.test'), 'maq-b': informa('dev-b@ejemplo.test'), 'maq-c': informa('otro@ejemplo.test') },
    machines: { 'maq-a': conf('dev-a@ejemplo.test', sha('dev-a@ejemplo.test')), 'maq-b': conf('dev-b@ejemplo.test', sha('dev-b@ejemplo.test')), 'maq-c': conf('dev-c@ejemplo.test', sha('dev-c@ejemplo.test')) },
  });
  const tabla = [
    ['jefa@acme.example', 'maq-a', true], ['jefa@acme.example', 'maq-b', true], ['jefa@acme.example', 'maq-c', true], ['jefa@acme.example', null, true],
    ['dev-a@ejemplo.test', 'maq-a', true], ['dev-a@ejemplo.test', 'maq-b', false], ['dev-a@ejemplo.test', 'maq-c', false], ['dev-a@ejemplo.test', null, false],
    ['dev-b@ejemplo.test', 'maq-a', false], ['dev-b@ejemplo.test', 'maq-b', true], ['dev-b@ejemplo.test', null, false],
    ['dev-c@ejemplo.test', 'maq-c', false], ['dev-c@ejemplo.test', null, false],
    ['nadie@ejemplo.test', 'maq-a', false], ['nadie@ejemplo.test', null, false],
  ];
  for (const [s, m, v] of tabla) assert.equal(P.puedeVer(s, m, c), v, `${s} ve ${m}`);
  assert.equal(P.esPersona('dev-a@ejemplo.test', c), true);
  assert.equal(P.esPersona('dev-b@ejemplo.test', c), true);
  assert.equal(P.esPersona('dev-c@ejemplo.test', c), true, 'con su única máquina caída sigue siendo persona');
  assert.equal(P.esPersona('nadie@ejemplo.test', c), false);
  assert.equal(P.esPersona('jefa@acme.example', c), false, 'mantener no es tener una máquina');
});

// ── T9 · PuedeVer_CambioEsComoSinConfirmar ── 🔴 Falla si la persona confirmada sigue viendo la máquina cuando informa otro correo.
test('2.28 T9 PuedeVer_CambioEsComoSinConfirmar', () => {
  const c = ctx({ maquinas: { 'maq-a': informa('otro@ejemplo.test') }, machines: { 'maq-a': conf('dev-a@ejemplo.test', sha('dev-a@ejemplo.test')) } });
  assert.equal(P.estadoDeMaquina('maq-a', c).estado, 'cambio');
  assert.equal(P.puedeVer('dev-a@ejemplo.test', 'maq-a', c), false);
  assert.equal(P.puedeVer('jefa@acme.example', 'maq-a', c), true);
});

// ── T10 · PuedeVer_SinCorreoConfirmadaVale_YCaeSiDespuesInformaOtro ── 🔴 Falla si la máquina sigue
//    confirmada con huella null y otro correo.
test('2.28 T10 PuedeVer_SinCorreoConfirmadaVale_YCaeSiDespuesInformaOtro', () => {
  const machines = { 'maq-x': conf('dev-x@ejemplo.test', null) };
  let c = ctx({ maquinas: { 'maq-x': null }, machines });
  assert.equal(P.estadoDeMaquina('maq-x', c).estado, 'confirmada');
  assert.equal(P.puedeVer('dev-x@ejemplo.test', 'maq-x', c), true);
  c = ctx({ maquinas: { 'maq-x': informa('otro@ejemplo.test') }, machines });
  assert.equal(P.estadoDeMaquina('maq-x', c).estado, 'cambio');
  assert.equal(P.puedeVer('dev-x@ejemplo.test', 'maq-x', c), false);
  c = ctx({ maquinas: { 'maq-x': informa('dev-x@ejemplo.test') }, machines });
  assert.equal(P.estadoDeMaquina('maq-x', c).estado, 'confirmada');
});

// ── T11 · Correo_SinMayusculasNiEspacios ──
test('2.28 T11 Correo_SinMayusculasNiEspacios', () => {
  const c = ctx({ maquinas: { 'maq-a': informa('dev.uno@ejemplo.test') }, machines: { 'maq-a': conf('dev.uno@ejemplo.test', sha('dev.uno@ejemplo.test')) } });
  assert.equal(P.puedeVer('Dev.Uno@Ejemplo.test ', 'maq-a', c), true);
  assert.equal(P.esPersona('  DEV.UNO@ejemplo.TEST', c), true);
  assert.equal(P.huellaDeCorreo('Dev.Uno@Ejemplo.test '), sha('dev.uno@ejemplo.test'));
  const m = ctx({ maquinas: {}, maintainers: ['Jefa@Acme.Example'] });
  assert.equal(P.puedeVer(' jefa@acme.example', null, m), true);
});

// ── T12 · OperationsIlegible_UltimoBueno24HorasYFreno ── 🔴 Falla si apaga todo con el primer refresco roto, o si
//    a las 25 horas sigue usando los datos de mantenedores del último refresco bueno.
test('2.28 T12 OperationsIlegible_UltimoBueno24HorasYFreno', () => {
  const ahora = Date.parse('2026-10-15T12:00:00Z');
  const hace = (h) => new Date(ahora - h * 3600000).toISOString();
  const motivo = 'people.machines.maq-a.person: «x» no es un correo';
  let e = P.estadoDeLaConfiguracion({ hayUltimoBueno: true, fallaDesde: hace(2), ahora, motivo });
  assert.equal(e.estado, 'ultimo_bueno'); assert.equal(e.desde, hace(2)); assert.equal(e.motivo, motivo);
  e = P.estadoDeLaConfiguracion({ hayUltimoBueno: true, fallaDesde: hace(25), ahora, motivo });
  assert.equal(e.estado, 'frenado'); assert.equal(e.desde, hace(25)); assert.equal(e.motivo, motivo);
  e = P.estadoDeLaConfiguracion({ hayUltimoBueno: false, fallaDesde: hace(0), ahora, motivo });
  assert.equal(e.estado, 'frenado', 'sin último bueno, el freno es inmediato');
  e = P.estadoDeLaConfiguracion({ hayUltimoBueno: true, fallaDesde: null, ahora });
  assert.deepEqual(e, { estado: 'vigente' }, 'un refresco bueno destraba');
  // durante el plazo vale el último bueno: sus confirmaciones y sus mantenedores
  const ultimoBueno = ctx({ maquinas: { 'maq-a': informa('dev-a@ejemplo.test') }, machines: { 'maq-a': conf('dev-a@ejemplo.test', sha('dev-a@ejemplo.test')) } });
  assert.equal(P.puedeVer('dev-a@ejemplo.test', 'maq-a', ultimoBueno), true);
  assert.equal(P.puedeVer('jefa@acme.example', 'maq-a', ultimoBueno), true);
  // un operations.json válido sin people: vigente, ninguna confirmada
  const sinPeople = P.contexto({ operations: { version: 1, owners: { default: 'x' } }, informados: P.leerCorreosInformados(espejo(tmp(), { 'maq-a': informa('dev-a@ejemplo.test') })) });
  assert.equal(P.estadoDeMaquina('maq-a', sinPeople).estado, 'sin_confirmar');
  assert.equal(P.puedeVer('dev-a@ejemplo.test', 'maq-a', sinPeople), false);
  assert.equal(P.puedeVer('jefa@acme.example', 'maq-a', sinPeople), false, 'sin site.maintainers nadie mantiene');
});

// ── MaquinasSinActividad_NoSeOfrecenParaConfirmar ── una carpeta del buzón sin place.json, sin fecha y sin corridas no
//    se ofrece para confirmar: sin esto, cada carpeta que deja un laboratorio sale «por confirmar», con el botón.
test('MaquinasSinActividad_NoSeOfrecenParaConfirmar', () => {
  const c = ctx({
    maquinas: { 'lab-1': null, 'lab-2': null, 'nueva': null, 'sin-git': noMedido('esta máquina no tiene configuración global de git'), 'maq-a': informa('dev-a@ejemplo.test') },
    corridas: { 'nueva': 2 },
  });
  const por = P.maquinasPorConfirmar(c).map((x) => x.maquina).sort();
  assert.deepEqual(por, ['maq-a', 'nueva', 'sin-git'], 'sin place.json pero con corridas, o con fecha, sigue por confirmar');
  assert.deepEqual(P.maquinasSinActividad(c), [{ maquina: 'lab-1' }, { maquina: 'lab-2' }]);
  // «no pude contar» (corridas null) no es «ninguna corrida»: sigue por confirmar
  c.informados.maquinas['lab-1'].corridas = null;
  assert.ok(P.maquinasPorConfirmar(c).some((x) => x.maquina === 'lab-1'));
  assert.deepEqual(P.maquinasSinActividad(c), [{ maquina: 'lab-2' }]);
});

// ── T13 · MaquinasPorConfirmar_EstadoCorreoDiaCorridasYOtras ── 🔴 Falla si deja afuera la `sin_correo`.
test('2.28 T13 MaquinasPorConfirmar_EstadoCorreoDiaCorridasYOtras', () => {
  const c = ctx({
    maquinas: {
      'maq-a': informa('dev-a@ejemplo.test', '2026-10-14'), 'maq-b': informa('otro@ejemplo.test'), 'maq-c': null,
      'maq-d': informa('dev-e@ejemplo.test'), 'maq-e': informa('dev-e@ejemplo.test'),
    },
    corridas: { 'maq-a': 3, 'maq-c': 1 },
    machines: { 'maq-b': conf('dev-b@ejemplo.test', sha('dev-b@ejemplo.test')), 'maq-e': conf('dev-e@ejemplo.test', sha('dev-e@ejemplo.test')) },
  });
  const l = P.maquinasPorConfirmar(c);
  const por = Object.fromEntries(l.map((x) => [x.maquina, x]));
  assert.deepEqual(Object.keys(por).sort(), ['maq-a', 'maq-b', 'maq-c', 'maq-d'], 'la confirmada no aparece');
  assert.equal(por['maq-a'].estado, 'sin_confirmar'); assert.equal(por['maq-a'].correo, 'dev-a@ejemplo.test');
  assert.equal(por['maq-a'].dia, '2026-10-14'); assert.equal(por['maq-a'].corridas, 3);
  assert.equal(por['maq-b'].estado, 'cambio'); assert.equal(por['maq-b'].correo, 'otro@ejemplo.test');
  assert.equal(por['maq-c'].estado, 'sin_correo'); assert.equal(por['maq-c'].correo, null); assert.ok(por['maq-c'].motivo); assert.equal(por['maq-c'].corridas, 1);
  assert.equal(por['maq-d'].estado, 'sin_confirmar'); assert.deepEqual(por['maq-d'].otras, ['maq-e']);
  assert.deepEqual(por['maq-a'].otras, []);
});

// ── repos.json y fotos de prueba (T14-T17): un repo `Project` en tres fotos ──
const REPOS = [
  { producto: 'Alfa', ruta: 'Alfa/Web', ado: 'Alfa/Web' }, { producto: 'Alfa', ruta: 'Alfa/Api', ado: 'Alfa/Api' },
  { producto: 'Beta', ruta: 'Beta/Front', ado: 'Beta/Front' }, { producto: 'Gama', ruta: 'Gama/Front', ado: 'Gama/Front' },
  { producto: 'Beta', ruta: 'BetaDos/Back', ado: 'Beta%20Dos/Back' },
];
const FOTOS = [{ proyecto: 'Alfa', repo: 'Project' }, { proyecto: 'Beta', repo: 'Project' }, { proyecto: 'Gama', repo: 'Project' }];
function datosDeA(extra = {}) {
  const c = ctx({
    maquinas: { 'maq-a': informa('dev.a@ejemplo.test'), 'maq-z': informa('otro@ejemplo.test') },
    machines: { 'maq-a': conf('dev.a@ejemplo.test', sha('dev.a@ejemplo.test')) },
    projects: extra.projects,
  });
  return {
    c,
    datos: {
      repos: extra.repos === undefined ? { repos: REPOS } : extra.repos,
      fotos: extra.fotos === undefined ? FOTOS : extra.fotos,
      corridas: [
        { maquina: 'maq-a', producto: 'Varios/Project', cambio: { repos: [{ nombre: 'Project', proyecto: 'Beta', principal: true }] } },
        { maquina: 'maq-a', producto: 'Alfa/AlfaWeb', cambio: null },
        { maquina: 'maq-a', producto: 'Gama/Front', cambio: null },
        { maquina: 'maq-z', producto: 'Omega/Nada', cambio: null },   // de otra máquina: no cuenta
        ...(extra.corridas || []),
      ],
      pedidos: [{ proyecto: 'Beta Dos', asignado: 'Dev.A@Ejemplo.test ' }, ...(extra.pedidos || [])],
    },
  };
}

// ── T14 · DondeTrabaja_ClaveDeRepoDeAzureYCarpeta ── 🔴 Falla si `Project` queda sin ubicar con el proyecto guardado;
//    o si parte el nombre de la foto.
test('2.28 T14 DondeTrabaja_ClaveDeRepoDeAzureYCarpeta', () => {
  const { c, datos } = datosDeA();
  const d = P.dondeTrabaja('dev.a@ejemplo.test', c, datos);
  assert.equal(d.estado, 'medido');
  const por = Object.fromEntries(d.productos.map((p) => [p.producto, p.de.slice().sort()]));
  assert.deepEqual(por, { Alfa: ['corridas'], Beta: ['corridas', 'pedidos'], Gama: ['corridas'] });
  assert.deepEqual(d.sin_ubicar, []);
});

// ── T15 · DondeTrabaja_AgregaYQuita ──
test('2.28 T15 DondeTrabaja_AgregaYQuita', () => {
  const { c, datos } = datosDeA({
    projects: { 'dev.a@ejemplo.test': { add: ['Gama', 'Delta'], remove: ['Beta'] } },
    corridas: [], pedidos: [],
  });
  datos.corridas = datos.corridas.filter((x) => x.producto !== 'Gama/Front');
  const d = P.dondeTrabaja('Dev.A@ejemplo.test', c, datos);
  const por = Object.fromEntries(d.productos.map((p) => [p.producto, p]));
  assert.deepEqual(Object.keys(por).sort(), ['Alfa', 'Delta', 'Gama']);
  assert.equal(por.Gama.agregado, true);
  assert.equal(por.Delta.agregado, true);
  assert.ok(!por.Alfa.agregado);
});

// ── T16 · DondeTrabaja_SinUbicar_ConMotivo ── 🔴 Falla si ubica `Project` en el primer producto que aparece.
test('2.28 T16 DondeTrabaja_SinUbicar_ConMotivo', () => {
  const repos = { repos: [...REPOS, { producto: 'Uno', ruta: 'Mixto/Uno', ado: 'Mixto/Uno' }, { producto: 'Dos', ruta: 'Mixto/Dos', ado: 'Mixto/Dos' }] };
  const { c, datos } = datosDeA({ repos });
  datos.corridas = [
    { maquina: 'maq-a', producto: 'Varios/Project', cambio: { repos: [{ nombre: 'Project', principal: true }] } },   // cambio viejo sin proyecto
    { maquina: 'maq-a', producto: 'Suelto/Nada', cambio: null },
  ];
  datos.pedidos = [{ proyecto: 'Mixto', asignado: 'dev.a@ejemplo.test' }, { proyecto: 'Alfa', asignado: 'dev-a-github' }];
  const d = P.dondeTrabaja('dev.a@ejemplo.test', c, datos);
  assert.deepEqual(d.productos, [], 'ningún producto adivinado');
  assert.equal(d.sin_ubicar.length, 3);
  const project = d.sin_ubicar.find((x) => /Project/.test(x.clave));
  assert.ok(project, JSON.stringify(d.sin_ubicar));
  for (const f of ['Alfa/Project', 'Beta/Project', 'Gama/Project']) assert.ok(project.motivo.includes(f), `${project.motivo} nombra la foto ${f}`);
  const mixto = d.sin_ubicar.find((x) => /Mixto/.test(x.clave));
  assert.ok(mixto && /Uno/.test(mixto.motivo) && /Dos/.test(mixto.motivo), JSON.stringify(mixto));
  assert.ok(d.sin_ubicar.find((x) => /Suelto\/Nada/.test(x.clave)));
  assert.equal(d.pedidos_no_medidos.length, 1);
  assert.match(d.pedidos_no_medidos[0].motivo, /correo/);
});

// ── T17 · DondeTrabaja_SinReposJson_NoMedido ──
test('2.28 T17 DondeTrabaja_SinReposJson_NoMedido', () => {
  const { c, datos } = datosDeA({ repos: null, projects: { 'dev.a@ejemplo.test': { add: ['Gama'] } } });
  const d = P.dondeTrabaja('dev.a@ejemplo.test', c, datos);
  assert.equal(d.estado, 'no_medido'); assert.ok(d.motivo);
  assert.deepEqual(d.productos.map((p) => p.producto), ['Gama']);
  // con repos.json y sin fotos: el mismo resultado de T14, y los motivos no nombran fotos
  const t14 = datosDeA({ fotos: null });
  const sinFotos = P.dondeTrabaja('dev.a@ejemplo.test', t14.c, t14.datos);
  assert.deepEqual(sinFotos.productos.map((p) => p.producto).sort(), ['Alfa', 'Beta', 'Gama']);
  const t16 = datosDeA({ fotos: null });
  t16.datos.corridas = [{ maquina: 'maq-a', producto: 'Varios/Project', cambio: { repos: [{ nombre: 'Project', principal: true }] } }];
  const m = P.dondeTrabaja('dev.a@ejemplo.test', t16.c, t16.datos).sin_ubicar[0].motivo;
  assert.ok(!/foto/.test(m), m);
});

// ── T18 · VistaDePersona_NadaDeOtro ── 🔴 Falla si devuelve la tabla entera.
test('2.28 T18 VistaDePersona_NadaDeOtro', () => {
  const c = ctx({
    maquinas: { 'maq-a': informa('dev-a@ejemplo.test'), 'maq-zqx-b': informa('zqx-dev-b@ejemplo.test') },
    machines: { 'maq-a': conf('dev-a@ejemplo.test', sha('dev-a@ejemplo.test')), 'maq-zqx-b': conf('zqx-dev-b@ejemplo.test', sha('zqx-dev-b@ejemplo.test')) },
    projects: { 'zqx-dev-b@ejemplo.test': { add: ['ZqxProducto'] } },
  });
  const datos = {
    repos: { repos: [...REPOS, { producto: 'ZqxProducto', ruta: 'Zqx/Repo', ado: 'Zqx/Repo' }] }, fotos: [],
    corridas: [{ maquina: 'maq-a', producto: 'Gama/Front', cambio: null }, { maquina: 'maq-zqx-b', producto: 'Zqx/Repo', cambio: null }, { maquina: 'maq-zqx-b', producto: 'ZqxSuelto/Nada', cambio: null }],
    pedidos: [{ proyecto: 'Zqx', asignado: 'zqx-dev-b@ejemplo.test' }],
  };
  const v = P.vistaDePersona('dev-a@ejemplo.test', c, datos);
  assert.deepEqual(v.maquinas.map((m) => m.maquina), ['maq-a']);
  assert.deepEqual(v.productos.map((p) => p.producto), ['Gama']);
  assert.ok(!/zqx/i.test(JSON.stringify(v)), JSON.stringify(v));
});

// ── T19 · Codigo_SinValoresDeUnaOrganizacion ──
test('2.28 T19 Codigo_SinValoresDeUnaOrganizacion', () => {
  const texto = fs.readFileSync(ARCHIVO, 'utf8');
  // sin nombrar a nadie acá (esta prueba también se publica): ningún dominio de correo fuera de los de ejemplo, ningún
  // texto entre comillas con nombre propio (una mayúscula inicial: un cliente, una persona, un producto) y ningún
  // nombre de máquina con forma de nombre de fábrica
  assert.ok(!/@(?!ejemplo\.test\b|acme\.example\b)[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(texto), 'ningún dominio de correo real');
  const literales = [...texto.matchAll(/'([^'\n]*)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(literales.filter((l) => /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+$/.test(l)), [], 'ningún nombre propio entre comillas');
  assert.ok(!/\b(mac|imac|macbook|pc|laptop|desktop)-?[a-z]*\b/.test(literales.join(' ')), 'ningún nombre de máquina');
});

// ── T22 · SesionDeOtroProveedor_MismaRegla ──
test('2.28 T22 SesionDeOtroProveedor_MismaRegla', () => {
  const { c, datos } = datosDeA();
  // la sesión de un OIDC genérico trae el correo en el claim `email`; los pedidos de GitHub, con un correo asignado
  const sesion = { email: 'dev.a@ejemplo.test', proveedor: 'oidc' };
  assert.equal(P.puedeVer(sesion, 'maq-a', c), P.puedeVer('dev.a@ejemplo.test', 'maq-a', c));
  assert.equal(P.esPersona(sesion, c), true);
  datos.pedidos = [{ proyecto: 'Beta Dos', asignado: 'dev.a@ejemplo.test', fuente: 'github' }];
  const r = P.dondeTrabaja(sesion, c, datos);
  assert.deepEqual(r.productos.find((p) => p.producto === 'Beta').de.slice().sort(), ['corridas', 'pedidos']);
});

// ── casos de borde de people.js, cada uno con su falla ──
test('2.28 adversarial: una cadena de uniones con ciclo no revienta y no confirma nada', () => {
  // 🔴 Falla si estadoDeMaquina sigue `unida` sin cortar ciclos → RangeError en puedeVer.
  const c = P.contexto({
    operations: { people: { machines: { 'maq-x': conf('a@ejemplo.test', null) } }, site: { maintainers: ['jefa@acme.example'] } },
    informados: { maquinas: { 'maq-x': { estado: 'no_informa', motivo: 'x', corridas: 0 }, 'maq-y': { estado: 'no_informa', motivo: 'x', corridas: 0 } },
      uniones: { carpetas: { 'maq-x': { estado: 'unida', nueva: 'maq-y' }, 'maq-y': { estado: 'unida', nueva: 'maq-x' } }, regeneradas: {} } },
  });
  assert.doesNotThrow(() => P.puedeVer('a@ejemplo.test', 'maq-x', c));
  assert.equal(P.puedeVer('a@ejemplo.test', 'maq-x', c), false);
  assert.equal(P.estadoDeMaquina('maq-x', c).estado, 'compartida');
  assert.doesNotThrow(() => P.maquinasPorConfirmar(c));
});

test('2.28 adversarial: otras sale ordenada, corridas null sigue null, el empate de ruta queda sin ubicar, y las claves __ no cuentan', () => {
  // 🔴 Falla si: `otras` sale en el orden del disco; «no pude contar» vuelve a 0; el empate de la
  //    ruta exacta cae al paso del padre y elige un producto; una clave de comentario `__…` hace persona.
  const c = ctx({
    maquinas: { 'zz-maq': informa('a@ejemplo.test'), 'aa-maq': informa('a@ejemplo.test'), 'mm-maq': informa('a@ejemplo.test') },
    machines: { 'zz-maq': conf('a@ejemplo.test', sha('a@ejemplo.test')), 'aa-maq': conf('a@ejemplo.test', sha('a@ejemplo.test')), '__ejemplo': { person: 'comentario@ejemplo.test' } },
    projects: { '__nota': { add: ['Fantasma'] } },
  });
  const sin = P.maquinasPorConfirmar(c).find((x) => x.maquina === 'mm-maq');
  assert.deepEqual(sin.otras, ['aa-maq', 'zz-maq']);
  c.informados.maquinas['mm-maq'].corridas = null;
  assert.equal(P.maquinasPorConfirmar(c).find((x) => x.maquina === 'mm-maq').corridas, null);
  assert.equal(P.esPersona('comentario@ejemplo.test', c), false);
  assert.deepEqual(P.vistaDePersona('comentario@ejemplo.test', c, {}).maquinas, []);
  const datos = { repos: [{ producto: 'Gama', ruta: 'beta/front', ado: 'P%202/r1' }, { producto: 'Beta', ruta: 'beta/front', ado: 'P%202/back' }], corridas: [{ maquina: 'aa-maq', producto: 'beta/front', cambio: null }], pedidos: [] };
  const d = P.dondeTrabaja('a@ejemplo.test', c, datos);
  assert.deepEqual(d.productos, []);
  assert.match(d.sin_ubicar[0].motivo, /Beta, Gama/);
});

test('2.28 seguridad (iter 2): una unión que pasaría la carpeta confirmada de una persona a otra no se aplica; día y correo ajenos saneados', () => {
  // 🔴 Falla si la carpeta con código de A, unida a la de B, pasa a ser de B, o si un `day` cualquiera y un correo con
  //    caracteres de control llegan tal cual a quien mantiene.
  const c = P.contexto({
    operations: { people: { machines: { 'beta-bbbbbbbb': conf('a@ejemplo.test', null), 'beta-aaaaaaaa': conf('b@ejemplo.test', null) } }, site: { maintainers: [] } },
    informados: { maquinas: { 'beta-bbbbbbbb': { estado: 'no_informa', motivo: 'x', corridas: 1 }, 'beta-aaaaaaaa': { estado: 'no_informa', motivo: 'x', corridas: 1 } },
      uniones: { carpetas: { 'beta-bbbbbbbb': { estado: 'unida', nueva: 'beta-aaaaaaaa' } }, regeneradas: {} } },
  });
  assert.equal(P.puedeVer('b@ejemplo.test', 'beta-bbbbbbbb', c), false);
  assert.equal(P.estadoDeMaquina('beta-bbbbbbbb', c).estado, 'compartida');
  // la vieja SIN entrada, que informa otro correo que su nueva, tampoco hereda la confirmación
  // 🔴 Falla si sólo frena cuando la vieja tiene entrada: una vieja sin confirmar la vería la persona de la nueva
  const c3 = P.contexto({
    operations: { people: { machines: { 'beta-aaaaaaaa': conf('b@ejemplo.test', null) } }, site: { maintainers: [] } },
    informados: { maquinas: { 'beta': { estado: 'informa', correo: 'a@ejemplo.test', dia: null, corridas: 1 }, 'beta-aaaaaaaa': { estado: 'informa', correo: 'b@ejemplo.test', dia: null, corridas: 1 } },
      uniones: { carpetas: { beta: { estado: 'unida', nueva: 'beta-aaaaaaaa' } }, regeneradas: {} } },
  });
  assert.equal(P.puedeVer('b@ejemplo.test', 'beta', c3), false);
  assert.equal(P.estadoDeMaquina('beta', c3).estado, 'compartida');
  // y una vieja cuya unión se descarta sale en la lista de quien mantiene, para resolverla
  // 🔴 Falla si toda vieja marcada `unida` sale de la lista, también la descartada
  const lista = P.maquinasPorConfirmar(c3);
  assert.ok(lista.some((x) => x.maquina === 'beta' && x.estado === 'compartida'), JSON.stringify(lista));
  const r = P.leerCorreosInformados(espejo(tmp(), {
    'maq-d': { schema: 1, day: '<script>', owner: { email: 'dev@ejemplo.test', source: 'git-global' } },
    'maq-e': { schema: 1, day: '2026-10-15', owner: { email: `dev${String.fromCharCode(7)}@ejemplo.test`, source: 'git-global' } },
  }));
  assert.equal(r.maquinas['maq-d'].dia, null);
  assert.equal(r.maquinas['maq-e'].estado, 'no_informa');
});

// ── T41 · CarpetaVieja_CompartidaSoloMantenedores_EntradaViejaNoCuenta ── 🔴 Falla si confirma la
//    compartida por su entrada vieja.
test('2.28 T41 CarpetaVieja_CompartidaSoloMantenedores_EntradaViejaNoCuenta', () => {
  const dir = espejo(tmp(), {
    'maq-vieja': informa('dev-v@ejemplo.test', '2026-10-14'),
    'maq-vieja-1a2b3c4d': informa('dev-v@ejemplo.test', '2026-10-15', { name: 'maq-vieja-1a2b3c4d', code: '1a2b3c4d', previous_folder: 'maq-vieja', moved_on: '2026-10-15' }),
    'maq-vieja-9f8e7d6c': informa('dev-w@ejemplo.test', '2026-10-15', { name: 'maq-vieja-9f8e7d6c', code: '9f8e7d6c', previous_folder: 'maq-vieja', moved_on: '2026-10-15', code_regenerated: { on: '2026-10-15', reason: 'no estaba' } }),
    'maq-b': informa('dev-b@ejemplo.test', '2026-10-13'),
    'maq-b-1a2b3c4d': informa('dev-b@ejemplo.test', '2026-10-15', { name: 'maq-b-1a2b3c4d', code: '1a2b3c4d', previous_folder: 'maq-b', moved_on: '2026-10-15', previous_runs_sha256: HUELLA_VACIA }),
  }, { 'maq-vieja': 2 });
  const c = P.contexto({
    operations: { people: { machines: { 'maq-vieja': conf('dev-v@ejemplo.test', sha('dev-v@ejemplo.test')), 'maq-b': conf('dev-b@ejemplo.test', sha('dev-b@ejemplo.test')) } }, site: { maintainers: ['jefa@acme.example'] } },
    informados: P.leerCorreosInformados(dir),
  });
  assert.equal(P.estadoDeMaquina('maq-vieja', c).estado, 'compartida');
  assert.equal(P.puedeVer('dev-v@ejemplo.test', 'maq-vieja', c), false, 'la entrada vieja no confirma nada');
  assert.equal(P.puedeVer('jefa@acme.example', 'maq-vieja', c), true);
  // la unida sigue a su nueva, que no tiene entrada: sin_confirmar; la entrada con el nombre viejo no cuenta
  assert.equal(P.estadoDeMaquina('maq-b', c).estado, 'sin_confirmar');
  assert.equal(P.puedeVer('dev-b@ejemplo.test', 'maq-b', c), false);
  assert.equal(P.puedeVer('dev-b@ejemplo.test', 'maq-b-1a2b3c4d', c), false);
  const l = P.maquinasPorConfirmar(c);
  const por = Object.fromEntries(l.map((x) => [x.maquina, x]));
  assert.match(por['maq-vieja'].motivo, /compartida por 2 máquinas: no se une/);
  assert.ok(!por['maq-b'], 'una carpeta vieja unida no es una máquina');
  assert.ok(por['maq-b-1a2b3c4d']);
  assert.deepEqual(por['maq-vieja-9f8e7d6c'].regenerado, { on: '2026-10-15', reason: 'no estaba' });
  // al confirmar la nueva, la vieja unida la sigue
  const c2 = P.contexto({
    operations: { people: { machines: { 'maq-b-1a2b3c4d': conf('dev-b@ejemplo.test', sha('dev-b@ejemplo.test')) } }, site: { maintainers: [] } },
    informados: P.leerCorreosInformados(dir),
  });
  assert.equal(P.puedeVer('dev-b@ejemplo.test', 'maq-b', c2), true);
  assert.equal(P.estadoDeMaquina('maq-b', c2).antes_de, 'maq-b-1a2b3c4d');
});
