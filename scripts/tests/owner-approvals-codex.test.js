'use strict';
/**
 * owner-approvals-codex.test.js — en Codex, la constancia de la persona es la firma en su terminal.
 *
 * La conversación guardada de Codex no distingue lo que tipeó la persona de lo que mete un programa (la medición está en
 * fixtures/codex-typed/). Por eso la constancia de Codex se da con `harness.js sign acknowledge` en una terminal de la
 * persona: anota un renglón en el registro de aprobaciones y deja una marca aparte, y `buscar` la acepta sólo si quien
 * pide pasa `plataformas` con Codex.
 *
 *   T3  · `buscar` acepta Codex sólo con `plataformas`; lo de Claude Code se lee igual que antes.
 *   T10 · `acknowledge` en la terminal: renglón y marca, nada en el registro común; no firma si lo lanzó Codex.
 *   T11 · sin la terminal, sin la marca, con otra marca, otro sello, otro renglón o desde la coordinadora: no vale.
 *   T16 · la guía dice qué constancia vale en Codex y para quién.
 *   T19 · los frenos de escritura cuidan la carpeta de la marca y la del registro.
 *
 * stable-data: la hora es fija (AHORA) y se pasa a cada función; los frenos de T19 no miran la hora.
 *
 * 🔴 Mutaciones que las ponen en rojo: aceptar Codex sin `plataformas` o leer como Codex una de hoy (T3), anotar en el
 * registro común, no dejar la marca, guardar la marca en otra casa o firmar lanzado por Codex (T10), aceptar sin
 * `via: 'terminal'`, sin marca, con una marca de otro sello u otro renglón, con otro sello o desde la coordinadora (T11),
 * sacar la carpeta de la marca de los frenos (T19).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts');
const HARNESS = path.join(RAIZ, 'scripts', 'setup', 'harness.js');
const oa = require('../lib/owner-approvals.js');
const firma = require('../lib/harness-sign.js');
const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));

const AHORA = Date.parse('2026-11-11T18:00:00Z');
const hace = (min) => AHORA - min * 60000;
const SES = 'ses-codex';
const SELLO = 'firma intent-approve · sesión ses-codex · código ab12cd34';
const TEXTO = '¿Seguimos con la opción (a)? Respuesta: sí';
const CUADRO = { pregunta: TEXTO, sello: SELLO };
const AMBAS = ['claude', 'codex'];
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function casaNueva(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-codex-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  return casa;
}

// la terminal de la persona: contesta lo que se le diga y guarda lo que se le preguntó
function terminal(respuesta = 's') {
  const preguntas = [];
  return { preguntas, hay: () => true, preguntar: (m) => { preguntas.push(m); return respuesta; } };
}
const DE_LA_PERSONA = () => ({ ok: true });

// la constancia dada en la terminal, por el camino de verdad
function constancia(casa, extra = {}) {
  return firma.acknowledge({ casa, session: SES, seal: SELLO, text: TEXTO, ahora: hace(1), tty: terminal(), origen: DE_LA_PERSONA, signer: 'el-dev', ...extra });
}

const renglones = (casa, sesion = SES) => oa.leerSesion(casa, sesion);
const marcas = (casa) => { try { return fs.readdirSync(firma.carpetaConstancias(casa)); } catch (_) { return []; } };

// ── T3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T3 Buscar_CodexOnlyWhenAsked — Codex vale sólo con plataformas; la de hoy sigue igual @ac-5', (t) => {
  const casa = casaNueva(t);
  assert.equal(constancia(casa).code, 0);
  const sin = oa.buscar({ casa, sesion: SES, cuadro: CUADRO, ahora: AHORA });
  assert.equal(sin.ok, false, 'sin plataformas una constancia de Codex no vale');
  const con = oa.buscar({ casa, sesion: SES, cuadro: CUADRO, ahora: AHORA, plataformas: AMBAS });
  assert.equal(con.ok, true, con.motivo);
  assert.equal(con.plataforma, 'codex');
  assert.equal(con.via, 'terminal');
  // la terminal contesta también un cuadro de sólo click
  const soloClick = oa.buscar({ casa, sesion: SES, cuadro: { ...CUADRO, soloClick: true }, ahora: AHORA, plataformas: AMBAS });
  assert.equal(soloClick.ok, true, soloClick.motivo);

  // la de hoy: sin `plataforma`, con su proceso de la herramienta; pasa con y sin la opción, y se lee como claude
  const casa2 = casaNueva(t);
  const herramienta = { pid: 900, inicio: 'Wed Nov 11 14:00:00 2026' };
  const arbol = [{ pid: 900, ppid: 1, inicio: herramienta.inicio, comando: 'claude' }];
  oa.anotar(casa2, { tipo: 'click', sesion: 'ses-a', ts: new Date(hace(2)).toISOString(), pregunta: TEXTO, respuesta: oa.APRUEBA, herramienta });
  for (const plataformas of [undefined, AMBAS]) {
    const r = oa.buscar({ casa: casa2, sesion: 'ses-a', cuadro: CUADRO, ahora: AHORA, herramienta, arbol, validar: () => ({ ok: true }), plataformas });
    assert.equal(r.ok, true, `${plataformas}: ${r.motivo}`);
    assert.equal(r.plataforma, 'claude');
    assert.deepEqual(r.aprobacion.herramienta, herramienta);
    assert.equal(r.aprobacion.plataforma, undefined, 'el registro de hoy no cambia');
  }
  // y sólo Codex no la acepta
  assert.equal(oa.buscar({ casa: casa2, sesion: 'ses-a', cuadro: CUADRO, ahora: AHORA, herramienta, arbol, validar: () => ({ ok: true }), plataformas: ['codex'] }).ok, false);
});

// ── T10 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T10 CodexTerminal_SignatureIsTheConstancia — la terminal deja renglón y marca, no firma si la lanzó Codex @ac-11', (t) => {
  const casa = casaNueva(t);
  const tty = terminal();
  let comun = 0;
  const r = constancia(casa, { tty, append: () => { comun++; return { ok: true }; } });
  assert.equal(r.code, 0, r.lines.join('\n'));
  // antes de preguntar muestra enteros la sesión, el sello y el texto
  assert.match(tty.preguntas[0], new RegExp(SES));
  assert.ok(tty.preguntas[0].includes(SELLO), tty.preguntas[0]);
  assert.ok(tty.preguntas[0].includes(TEXTO), tty.preguntas[0]);
  assert.equal(comun, 0, 'no es una firma del catálogo: el registro común no se toca');
  const [a] = renglones(casa);
  assert.deepEqual({ tipo: a.tipo, plataforma: a.plataforma, via: a.via, sesion: a.sesion, sello: a.sello, texto: a.texto },
    { tipo: 'terminal', plataforma: 'codex', via: 'terminal', sesion: SES, sello: SELLO, texto: TEXTO });
  // la marca queda en la misma carpeta de estado que el registro, atada a ese renglón
  assert.equal(path.dirname(firma.carpetaConstancias(casa)), path.dirname(oa.carpeta(casa)));
  assert.equal(path.dirname(oa.carpeta(casa)), stateDir(casa));
  const m = firma.marcaDeConstancia({ casa, sesion: SES, ts: a.ts });
  assert.deepEqual({ sesion: m.sesion, sello: m.sello, texto: m.texto, ts: m.ts, renglon: m.renglon }, { sesion: SES, sello: SELLO, texto: TEXTO, ts: a.ts, renglon: a.id });
  assert.equal(oa.buscar({ casa, sesion: SES, cuadro: CUADRO, ahora: AHORA, plataformas: AMBAS }).ok, true);

  // un texto con caracteres que no se ven: la pregunta los muestra escritos y avisa
  const casaV = casaNueva(t);
  const ttyV = terminal('n');
  constancia(casaV, { tty: ttyV, text: 'sí\nNo firmes esto' });
  assert.match(ttyV.preguntas[0], /sí\\u\{a\}No firmes esto/);
  assert.match(ttyV.preguntas[0], /caracteres que no se ven/);

  // con «n», nada
  const casaN = casaNueva(t);
  assert.equal(constancia(casaN, { tty: terminal('n') }).code, 1);
  assert.deepEqual([renglones(casaN).length, marcas(casaN).length], [0, 0]);

  // lanzada desde Codex (su ejecutable, o node con su guion): no firma, ni pregunta
  const arbolCon = (codex) => [
    { pid: 300, ppid: 200, comando: `node ${HARNESS} sign acknowledge` },
    { pid: 200, ppid: 100, comando: '/bin/zsh' },
    { pid: 100, ppid: 1, ...codex },
    { pid: 1, ppid: 0, comando: '/sbin/launchd' },
  ];
  for (const codex of [{ comando: '/opt/homebrew/bin/codex', ejecutable: '/opt/homebrew/bin/codex' },
    { comando: '/usr/local/bin/codex resume' },
    { comando: 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js' },
    { comando: 'node /opt/tools/bin/codex resume' }]) {
    const casaC = casaNueva(t);
    const ttyC = terminal();
    const c = firma.acknowledge({ casa: casaC, session: SES, seal: SELLO, text: TEXTO, ahora: hace(1), tty: ttyC, arbol: arbolCon(codex), pid: 300 });
    assert.equal(c.code, 2, `${codex.comando}: ${c.lines.join('\n')}`);
    assert.match(c.lines.join('\n'), /Codex/);
    assert.deepEqual([ttyC.preguntas.length, renglones(casaC).length, marcas(casaC).length], [0, 0, 0]);
  }
  // la línea del proceso se corta por el ejecutable (su ruta puede tener espacios), una ruta entre comillas va entera y
  // las opciones de node antes del guion no cuentan; el texto de la constancia no es el guion
  const NODE_CON_ESPACIOS = '/Users/Ana Paz/.nvm/v20/bin/node';
  for (const p of [{ comando: `${NODE_CON_ESPACIOS} /opt/codex/bin/codex.js`, ejecutable: NODE_CON_ESPACIOS },
    { comando: `${NODE_CON_ESPACIOS} /Users/Ana Paz/lib/node_modules/@openai/codex/bin/codex.js`, ejecutable: NODE_CON_ESPACIOS },
    { comando: 'node --no-warnings /usr/lib/node_modules/@openai/codex/bin/codex.js' },
    { comando: 'bun /usr/lib/node_modules/@openai/codex/bin/codex.js' },
    { comando: '"/Users/Ana Paz/bin/codex" resume' }]) assert.equal(firma.esCodex(p), true, p.comando);
  for (const p of [{ comando: '"/Users/Ana Paz/bin/node" /x/node_modules/@openai/codex/bin/codex.js', ejecutable: '/Users/Ana Paz/bin/node' },
    { comando: "'/Users/Ana Paz/bin/codex' resume" },
    { comando: 'NODE.EXE C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.js' }]) assert.equal(firma.esCodex(p), true, p.comando);
  for (const p of [{ comando: '"/Users/Ana Paz/bin/node" /x/run.js', ejecutable: '/Users/Ana Paz/bin/node' },
    { comando: `node ${HARNESS} sign acknowledge --session s --text lo aprobé en codex` }, { comando: '/bin/zsh' },
    { comando: 'node /opt/tools/codexify.js' }, { comando: `${NODE_CON_ESPACIOS} /opt/x/run.js codex`, ejecutable: NODE_CON_ESPACIOS }]) assert.equal(firma.esCodex(p), false, p.comando);

  // la misma cadena, desde la aplicación de terminal de la persona: firma
  const casaT = casaNueva(t);
  const deTerminal = firma.acknowledge({ casa: casaT, session: SES, seal: SELLO, text: TEXTO, ahora: hace(1), tty: terminal(), arbol: arbolCon({ comando: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' }), pid: 300 });
  assert.equal(deTerminal.code, 0, deTerminal.lines.join('\n'));
  // en Windows el árbol no se lee: cuida la ventana de las tres palabras, como en `sign`
  const casaW = casaNueva(t);
  const win = { windows: true, enVentana: () => true, dentro: () => {}, hay: () => true, confirmarFrase: () => true };
  assert.equal(firma.acknowledge({ casa: casaW, session: SES, seal: SELLO, text: TEXTO, ahora: hace(1), tty: win, arbol: arbolCon({ comando: 'codex.exe', ejecutable: 'C:\\codex\\codex.exe' }), pid: 300 }).code, 0);

  // Windows desde afuera de la ventana: el resultado es el de la ventana nueva
  const ventana = (v) => ({ windows: true, enVentana: () => false, abrir: () => v, hay: () => true });
  assert.equal(firma.acknowledge({ casa: casaNueva(t), session: SES, seal: SELLO, text: TEXTO, tty: ventana({ estado: 'vencida', tope: 60 }) }).code, 1);
  assert.equal(firma.acknowledge({ casa: casaNueva(t), session: SES, seal: SELLO, text: TEXTO, tty: ventana({ estado: 'rota', motivo: 'x' }) }).code, 1);
  assert.equal(firma.acknowledge({ casa: casaNueva(t), session: SES, seal: SELLO, text: TEXTO, tty: ventana({ estado: 'cerrada', codigo: 0 }) }).code, 0);
  assert.equal(firma.acknowledge({ casa: casaNueva(t), session: SES, seal: SELLO, text: TEXTO, tty: ventana({ estado: 'cerrada', codigo: 1 }) }).code, 1);

  // sin terminal, o una terminal que no se lee: no firma ni escribe
  for (const tty of [{ hay: () => false, preguntar: () => 's' }, { hay: () => true, preguntar: () => { throw new Error('cerrada'); } }]) {
    const casaS = casaNueva(t);
    assert.equal(constancia(casaS, { tty }).code, 2);
    assert.deepEqual([renglones(casaS).length, marcas(casaS).length], [0, 0]);
  }

  // si la marca no se puede dejar, no se anota nada; si el renglón no se puede anotar, la marca se saca
  const casaE = casaNueva(t);
  fs.mkdirSync(stateDir(casaE), { recursive: true });
  fs.writeFileSync(firma.carpetaConstancias(casaE), 'no es una carpeta');
  assert.equal(constancia(casaE).code, 1);
  assert.equal(renglones(casaE).length, 0);
  const casaR = casaNueva(t);
  fs.mkdirSync(stateDir(casaR), { recursive: true });
  fs.writeFileSync(oa.carpeta(casaR), 'no es una carpeta');
  const sinRenglon = constancia(casaR);
  assert.equal(sinRenglon.code, 1);
  assert.match(sinRenglon.lines.join('\n'), /no pude anotar/);
  assert.equal(marcas(casaR).length, 0, 'quedó una marca sin renglón');

  // las marcas de más de un día se barren al dar otra; las recientes quedan
  const casaB = casaNueva(t);
  const dirB = firma.carpetaConstancias(casaB);
  fs.mkdirSync(dirB, { recursive: true });
  const vieja = path.join(dirB, 'vieja.json');
  const reciente = path.join(dirB, 'reciente.json');
  fs.writeFileSync(vieja, '{}');
  fs.writeFileSync(reciente, '{}');
  // stable-data: la fecha de la vieja se corre dos días para atrás desde el reloj real, que es el que mira el barrido
  const dosDias = new Date(Date.now() - 2 * 24 * 3600000);
  fs.utimesSync(vieja, dosDias, dosDias);
  assert.equal(constancia(casaB).code, 0);
  assert.deepEqual([fs.existsSync(vieja), fs.existsSync(reciente)], [false, true]);

  // `sinCodex` es sólo de la constancia: sin él, Codex en la cadena no frena (las firmas del catálogo siguen igual)
  const cadena = arbolCon({ comando: '/opt/homebrew/bin/codex' });
  assert.equal(firma.origenDeVerdad({ arbol: cadena, pid: 300 }).ok, true);
  assert.equal(firma.origenDeVerdad({ arbol: cadena, pid: 300, sinCodex: true }).ok, false);
  const desdeCodex = [{ ...cadena[0], pid: process.pid }, ...cadena.slice(1)].map((p) => (p.ppid === 300 ? { ...p } : p));
  desdeCodex[0].ppid = 200;
  let anotadaC = null;
  const fC = firma.sign({ id: 'plan-approval', casa: casaNueva(t), ahora: AHORA, signer: 'el-dev', tty: terminal(), levels: {}, arbol: desdeCodex, append: (x) => { anotadaC = x; return { ok: true, path: '/registro' }; } });
  assert.equal(fC.code, 0, fC.lines.join('\n'));
  assert.equal(anotadaC.signature, 'plan-approval');

  // datos que faltan o una sesión con otra forma: uso mal hecho, sin preguntar
  for (const mal of [{ session: '' }, { session: '../x' }, { seal: '' }, { text: '  ' }]) {
    const casaM = casaNueva(t);
    const ttyM = terminal();
    assert.equal(constancia(casaM, { tty: ttyM, ...mal }).code, 2, JSON.stringify(mal));
    assert.equal(ttyM.preguntas.length, 0);
  }

  // la firma del catálogo sigue como hoy: al registro común, sin renglón ni marca
  const casaF = casaNueva(t);
  let anotada = null;
  const f = firma.sign({ id: 'plan-approval', casa: casaF, ahora: AHORA, signer: 'el-dev', cwd: casaF, tty: terminal(), levels: {}, origen: DE_LA_PERSONA, append: (x) => { anotada = x; return { ok: true, path: '/registro' }; } });
  assert.equal(f.code, 0, f.lines.join('\n'));
  assert.equal(anotada.signature, 'plan-approval');
  assert.deepEqual([renglones(casaF, 'el-dev').length, marcas(casaF).length], [0, 0]);

  // por la consola: `sign acknowledge` se enruta antes del catálogo, y un texto que empieza con guion es un valor
  const casaK = casaNueva(t);
  // TYCON_HARNESS_NODE=0: el harness.js de la prueba no baja su node
  const env = { ...process.env, HOME: casaK, USERPROFILE: casaK, TYCON_HARNESS_NODE: '0' };
  delete env.TYCON_HOME;
  const k = spawnSync(process.execPath, [HARNESS, 'sign', 'acknowledge', '--session', SES, '--seal', SELLO, '--text', '-no, la (b)'], { encoding: 'utf8', env, input: '' });
  const dijo = `${k.stdout}${k.stderr}`;
  assert.doesNotMatch(dijo, /necesita un valor|catálogo/, dijo);
  assert.equal(k.status, 2, dijo);
  assert.match(dijo, /terminal/);
  const mal = spawnSync(process.execPath, [HARNESS, 'sign', 'plan-approval', '--seal', SELLO], { encoding: 'utf8', env, input: '' });
  assert.equal(mal.status, 2, `${mal.stdout}${mal.stderr}`);
  assert.match(`${mal.stdout}${mal.stderr}`, /acknowledge/);
});

// ── T11 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T11 Buscar_CodexWithoutTerminal_No — sin terminal, sin marca, otra marca, otro sello, otro renglón o la coordinadora @ac-12', (t) => {
  const busca = (casa, extra = {}) => oa.buscar({ casa, sesion: SES, cuadro: CUADRO, ahora: AHORA, plataformas: AMBAS, ...extra });
  const ts = new Date(hace(1)).toISOString();
  const renglon = (extra = {}) => ({ tipo: 'terminal', plataforma: 'codex', via: 'terminal', sesion: SES, sello: SELLO, texto: TEXTO, ts, firmante: 'el-dev', ...extra });
  // la marca escrita a mano en la carpeta de juguete (en una casa de verdad la cuidan los frenos: T19)
  const marcar = (casa, datos) => {
    const dir = firma.carpetaConstancias(casa);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sha(`${datos.sesion}\n${datos.ts}`)}.json`), JSON.stringify(datos));
  };

  // 1 · Codex sin la terminal: un mensaje (lo que anotaría un gancho de Codex)
  const c1 = casaNueva(t);
  oa.anotar(c1, { tipo: 'mensaje', plataforma: 'codex', sesion: SES, ts, texto: 'aprobado' });
  assert.match(busca(c1).motivo, /en Codex la constancia se da en la terminal/);

  // 2 · `via: 'terminal'` escrita en el registro, sin la marca
  const c2 = casaNueva(t);
  oa.anotar(c2, renglon());
  assert.match(busca(c2).motivo, /falta la marca de la terminal/);

  // 3 · la marca de otro sello
  const c3 = casaNueva(t);
  oa.anotar(c3, renglon());
  marcar(c3, { sesion: SES, sello: 'firma otra · sesión ses-codex · código 00000000', texto: TEXTO, ts, renglon: oa.leerSesion(c3, SES)[0].id });
  assert.match(busca(c3).motivo, /la marca de la terminal no coincide/);

  // 4 · una constancia buena, pedida con otro sello
  const c4 = casaNueva(t);
  assert.equal(constancia(c4).code, 0);
  assert.match(busca(c4, { cuadro: { pregunta: TEXTO, sello: 'firma intent-approve · sesión ses-codex · código ffffffff' } }).motivo, /otro sello/);

  // 4b · el sello bueno con otro texto: la persona firmó algo distinto de la pregunta
  assert.match(busca(c4, { cuadro: { pregunta: '¿Seguimos con la opción (b)? Respuesta: sí', sello: SELLO } }).motivo, /otro texto que la pregunta/);

  // 5 · el renglón cambiado después de la marca: la marca es de otro renglón
  const c5 = casaNueva(t);
  oa.anotar(c5, renglon());
  marcar(c5, { sesion: SES, sello: SELLO, texto: TEXTO, ts, renglon: sha('otro renglón') });
  assert.match(busca(c5).motivo, /otro renglón/);

  // 6 · una constancia con su marca, en el registro de la coordinadora: no pasa por ella
  const c6 = casaNueva(t);
  const coord = 'ses-coord';
  assert.equal(firma.acknowledge({ casa: c6, session: coord, seal: SELLO, text: TEXTO, ahora: hace(1), tty: terminal(), origen: DE_LA_PERSONA }).code, 0);
  const r6 = busca(c6, { coordinadora: coord, arbol: [] });
  assert.equal(r6.ok, false, 'la de la coordinadora no vale para otra sesión');
  assert.match(r6.motivo, /no hay un click/, 'se descarta antes de mirarla, no por otro motivo');

  // 8 · una marca que no se puede leer no es «falta la marca»: lo dice
  const c8 = casaNueva(t);
  oa.anotar(c8, renglon());
  const dir8 = firma.carpetaConstancias(c8);
  fs.mkdirSync(dir8, { recursive: true });
  fs.writeFileSync(path.join(dir8, `${sha(`${SES}\n${ts}`)}.json`), '{ a medias');
  assert.match(busca(c8).motivo, /no pude leer la marca de la terminal .*dañada/);

  // 8b · una marca que no es un objeto, o que no se deja abrir, tampoco es «falta»
  const c8b = casaNueva(t);
  oa.anotar(c8b, renglon());
  const m8b = path.join(firma.carpetaConstancias(c8b), `${sha(`${SES}\n${ts}`)}.json`);
  fs.mkdirSync(path.dirname(m8b), { recursive: true });
  fs.writeFileSync(m8b, 'null');
  assert.match(busca(c8b).motivo, /dañada/);
  if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
    fs.writeFileSync(m8b, '{}');
    fs.chmodSync(m8b, 0o000);
    assert.match(busca(c8b).motivo, /no pude leer la marca de la terminal \(EACCES\)/);
    fs.chmodSync(m8b, 0o600);
  }

  // 8c · `via: 'terminal'` escrito en un renglón que no es de la terminal
  const c8c = casaNueva(t);
  oa.anotar(c8c, renglon({ tipo: 'mensaje' }));
  assert.match(busca(c8c).motivo, /en Codex la constancia se da en la terminal/);

  // 9 · se gasta una sola vez
  const c9 = casaNueva(t);
  assert.equal(constancia(c9).code, 0);
  const r9 = busca(c9);
  assert.equal(r9.ok, true, r9.motivo);
  assert.equal(oa.consumir(c9, r9.aprobacion, { ahora: AHORA, firma: 'intent-approve', sesion: SES }).ok, true);
  assert.equal(busca(c9).ok, false, 'una constancia gastada no vale otra vez');

  // y vencida (más de 30 minutos) tampoco
  const c7 = casaNueva(t);
  assert.equal(constancia(c7, { ahora: hace(oa.VENCE_MIN + 1) }).code, 0);
  assert.equal(busca(c7).ok, false);
});

// ── T16 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T16 Docs_FirmasEnCodex_SaysWhatCounts — la guía dice qué constancia vale en Codex y para quién @ac-5', () => {
  const guia = fs.readFileSync(path.join(RAIZ, 'guides', 'firmas-del-arnes.md'), 'utf8');
  const i = guia.indexOf('### En Codex');
  assert.ok(i >= 0, 'falta §«En Codex»');
  const seccion = guia.slice(i, guia.indexOf('\n### ', i + 1));
  assert.match(seccion, /harness\.js sign acknowledge/);
  assert.match(seccion, /plataformas/);
  assert.match(seccion, /terminal-acknowledgments/);
  assert.match(seccion, /el click .*no vale|no vale .*click/s);
});

// ── T19 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T19 CodexTerminalMark_ProtectedByBrakes — los frenos cuidan la marca y el registro @ac-12', (t) => {
  const casa = casaNueva(t);
  const estado = stateDir(casa);
  assert.equal(constancia(casa).code, 0);
  const marca = path.join(firma.carpetaConstancias(casa), marcas(casa)[0]);
  const registro = path.join(oa.carpeta(casa), `${SES}.jsonl`);
  const sg = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
  assert.equal(sg.signedRecordKind(marca), 'terminal-acknowledgments');
  assert.equal(sg.signedRecordKind(registro), 'owner-approvals');
  const env = { ...process.env, HOME: casa, USERPROFILE: casa };
  delete env.TYCON_HOME;
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const frenado = (r) => r.status === 2 || /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/.test(out(r));
  for (const archivo of [marca, registro]) {
    // Edit y Write: el freno de edición, por su gancho, y la decisión sin depender de la carpeta de estado
    for (const herramienta of ['Edit', 'Write']) {
      const ev = { session_id: 's-t19', tool_name: herramienta, cwd: casa, tool_input: { file_path: archivo, content: '{}', old_string: 'a', new_string: 'b' } };
      const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-story-gate.js')], { input: JSON.stringify(ev), env, encoding: 'utf8', cwd: casa });
      assert.ok(frenado(r), `${herramienta} no frenó ${archivo}\n${out(r)}`);
    }
    const d = sg.computeStoryGate({ filePath: archivo, stateDir: null, homeDir: casa, repoRoot: null });
    assert.equal(d.action, 'block', archivo);
    // la consola: escribir, borrar y mover
    for (const cmd of [`echo '{}' > ${archivo}`, `rm ${archivo}`, `mv ${archivo} ${path.join(casa, 'x')}`]) {
      const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-bash-write-gate.js')], { input: JSON.stringify({ session_id: 's-t19', tool_name: 'Bash', cwd: casa, tool_input: { command: cmd } }), env, encoding: 'utf8', cwd: casa });
      assert.ok(frenado(r), `no frenó: ${cmd}\n${out(r)}`);
    }
  }
  // borrar la carpeta entera de la marca también
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-bash-write-gate.js')], { input: JSON.stringify({ session_id: 's-t19', tool_name: 'Bash', cwd: estado, tool_input: { command: 'rm -rf terminal-acknowledgments' } }), env, encoding: 'utf8', cwd: estado });
  assert.ok(frenado(r), out(r));
  assert.ok(fs.existsSync(marca) && fs.existsSync(registro), 'algo se borró');
});
