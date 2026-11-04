#!/usr/bin/env node
'use strict';
// office-live.smoke.js — la oficina viva en un navegador de verdad: la página se actualiza en el lugar cuando cambia un
// marcador (sin mover la cámara ni cerrar el detalle abierto), y cuando el proceso se cierra deja la última foto con su
// aviso. Corre con el Chromium fijo del arnés (scripts/lib/pinned-playwright.js) sobre una máquina de juguete.
//
//   node scripts/tests/office-live.smoke.js        sale 0 si todo pasó; 1 si algo no; 2 si no hay navegador
//
// La oficina corre con una HOME de juguete; el navegador se busca en la carpeta personal de quien lo corre.
// stable-data: las sesiones de juguete se fechan con el reloj real a propósito, porque la oficina viva compara contra
// la hora de la máquina para saber si una sesión está viva; no compara fechas fijas ni crea commits.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const OFFICE = path.join(ROOT, 'scripts', 'tools', 'office.js');
const PINNED_PW = require(path.join(ROOT, 'scripts', 'lib', 'pinned-playwright.js'));
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'MAL'} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Las tablas por tema: la oficina de verdad clasifica con un proveedor de juguete (un guion que deja los temas en su lugar), se
// abre una fila y una foto nueva no la cierra. Deja una captura en OFFICE_E1_SHOT, si está.
async function tablesByTopic(playwright, baseEnv, sdir) {
  const classifier = path.join(path.dirname(sdir), 'topics-de-juguete.js');
  fs.writeFileSync(classifier, `const fs = require('fs');
const dir = ${JSON.stringify(path.join(sdir, 'office'))};
const pending = JSON.parse(fs.readFileSync(dir + '/topics-pending.json', 'utf8')).trabajos;
fs.writeFileSync(dir + '/topics.json', JSON.stringify({ version: 1, temas: Object.fromEntries(pending.map((w) => [w.clave, /banco/.test(w.titulo) ? 'Controles' : 'Oficina'])) }));
`);
  // las dos sesiones trabajan en un repo que el arnés sigue: de lo que no se sabe de qué proyecto es no se clasifica nada
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'office-e1-repo-'));
  spawnSync('git', ['-c', 'maintenance.auto=false', '-C', repo, 'init', '-q']);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/repo.git']);
  fs.writeFileSync(path.join(sdir, 'stuck-prs-photo.json'), JSON.stringify({ at: new Date().toISOString(), lecturas: { 'acme/repo': { ok: true, value: [] } } }));
  const working = (sid, name, reason) => {
    fs.writeFileSync(path.join(claudeDir(baseEnv.HOME), 'sessions', `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name, status: 'busy', statusUpdatedAt: Date.now(), cwd: repo }));
    fs.writeFileSync(path.join(sdir, 'adhoc', `${sid}.json`), JSON.stringify({ reason, declaredAt: new Date().toISOString(), cwd: repo }));
  };
  working('s2', 'Beto', 'revisión del banco de controles');
  working('s3', 'Cata', 'arreglo del banco de controles');
  const env ={ ...baseEnv, TYCON_OFFICE_TOPICS_RUN: classifier, TYCON_OFFICE_TOPICS_MS: '300' };
  const open = spawnSync(process.execPath, [OFFICE, '--open'], { input: '', env, encoding: 'utf8', timeout: 20000 });
  const url = (open.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/) || [])[0];
  check(open.status === 0 && Boolean(url), 'E1: la oficina volvió a abrir');
  if (!url) return;
  const lock = JSON.parse(fs.readFileSync(path.join(sdir, 'office', 'server.json'), 'utf8'));
  // sin 3D: las tablas no lo necesitan, y dos escenas a la vez traban al navegador con la máquina cargada
  const browser = await playwright.chromium.launch({ args: ['--disable-3d-apis'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    await page.goto(url);
    await page.waitForSelector('#tablas .temaBoton', { timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.temaBoton')].some((b) => b.textContent === 'Controles'), null, { timeout: 15000 });
    check(true, 'E1: las filas salen por tema, con el tema que clasificó el proceso de fondo');
    const hoy = page.locator('#tablas .una').first();
    check((await hoy.locator('.escrito').innerText()).startsWith('Armada a las'), 'E1: dice «Armada a las…»');
    // Beto y Cata: los dos trabajos hablan del banco de controles
    check(/2 en curso/.test(await hoy.locator('.temaFila', { hasText: 'Controles' }).innerText()), 'E1: la línea sale contada de las tarjetas');
    await hoy.locator('.temaBoton', { hasText: 'Controles' }).click();
    const detail = hoy.locator('.temaTrabajos:not([hidden])');
    check(/arreglo del banco de controles/.test(await detail.innerText()), 'E1: al tocarla se abren sus trabajos');
    // una foto nueva: cambia algo, y la fila sigue abierta
    working('s3', 'Cata', 'arreglo del banco de controles, segunda parte');
    await page.waitForFunction(() => [...document.querySelectorAll('.temaTrabajos')].some((t) => t.textContent.includes('segunda parte')), null, { timeout: 8000 });
    check(await hoy.locator('.temaTrabajos:not([hidden])').count() === 1, 'E1: una foto nueva no la cierra');
    if (process.env.OFFICE_E1_SHOT) await page.locator('#tablas').screenshot({ path: process.env.OFFICE_E1_SHOT });
  } finally {
    await browser.close();
    try { process.kill(lock.pid, 'SIGKILL'); } catch { /* ya salió */ }
  }
}

// El número de cada tarea en la oficina de verdad: la fila cuyo `quien` es una sesión que hace otra cosa se ve, la línea
// de arriba, la búsqueda, las ventanas que se cierran igual, las dos manos y el tablero que se mueve solo. Deja una
// captura de cada cosa en OFFICE_8198_SHOTS, si está.
async function taskNumbers(playwright) {
  const BOARD = require(path.join(ROOT, 'scripts', 'tools', 'office', 'board.js'));
  const shots = process.env.OFFICE_8198_SHOTS || null;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  // la página se redibuja con cada foto: se fotografía el lugar del elemento, sin esperar a que quede quieto
  const shot = async (page, name, locator = null) => {
    if (!shots) return;
    if (!locator) { await page.screenshot({ path: path.join(shots, `${name}.png`) }); return; }
    await locator.evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await sleep(200);
    const box = await locator.boundingBox();
    const vp = page.viewportSize();
    const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.width, vp.width), height: Math.min(box.height, vp.height - Math.max(0, box.y)) };
    await page.screenshot({ path: path.join(shots, `${name}.png`), clip });
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-8198-'));
  const sdir = stateDir(home);
  for (const d of ['active', 'adhoc', 'doing', 'coordination']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  const sessions = path.join(claudeDir(home), 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const session = (sid, name, status = 'busy') => fs.writeFileSync(path.join(sessions, `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name, status, statusUpdatedAt: Date.now() }));
  const doing = (sid, text, more = {}) => fs.writeFileSync(path.join(sdir, 'doing', `${sid}.json`), JSON.stringify({ text, at: new Date().toISOString(), ...more }));
  // Sand hace otra cosa y no dice su fila: la fila tiene que verse. Funes dice T-2: va en su tarjeta. Pinola espera a la
  // coordinadora. Rita pidió una firma que sigue pendiente. Y una ejecución de la historia 9.1 que arranca sola
  session('s1', 'Sand'); doing('s1', 'arreglo de otra cosa');
  session('s2', 'Funes'); doing('s2', 'T-2 · la búsqueda de la oficina');
  session('s3', 'Pinola', 'idle'); doing('s3', 'espera el click', { waitingFor: 'la coordinadora', waitingSince: new Date(Date.now() - 60000).toISOString() });
  session('s4', 'Rita'); doing('s4', 'el carril de Rita');
  // una firma de la terminal pedida para la sesión de Rita (`--for-session`): la lista de firmas de la máquina de juguete
  // está apagada, y ésas igual se leen
  fs.writeFileSync(path.join(sdir, 'coordination', 'signatures.json'), JSON.stringify([{ id: 'f1', destino: 's4', title: 'el carril de Rita', at: Date.now() }]));
  const saved = BOARD.save(sdir, { meta: { resumen: 'UN RESUMEN VIEJO' }, pendientes: [
    { titulo: 'El arreglo que Sand dejó', estado: 'curso', quien: 'Sand', grupo: 'Hoy', orden: 1, nota: 'lo pidió el dueño' },
    { titulo: 'La búsqueda por número', estado: 'curso', grupo: 'Hoy', orden: 2, nota: 'la nota de la fila' },
    { titulo: 'La historia que arranca sola', estado: 'espera', historia: '9.1', grupo: 'Hoy', orden: 3 },
  ] }, { home });
  check(saved.code === 0, 'E1: el tablero de prueba se guardó con board.js y tiene números');
  // E3: la conversación de Funes dice su modelo y su esfuerzo; la de Sand todavía no tiene respuestas
  const projects = path.join(claudeDir(home), 'projects', 'juguete');
  fs.mkdirSync(projects, { recursive: true });
  const ts = (min) => new Date(Date.now() - min * 60000).toISOString();
  const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  fs.writeFileSync(path.join(projects, 's2.jsonl'), `${JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: ts(2), perTurnEffort: 'high', effort: 'high', message: { id: 'm1', model: 'claude-opus-5-5', usage } })}\n`);
  fs.writeFileSync(path.join(projects, 's1.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: ts(2), message: { role: 'user', content: 'hola' } })}\n`);
  // E5: una coordinadora designada que habló con Funes (viva) y con Olvido (cerrada, con su conversación de fondo)
  fs.appendFileSync(path.join(sdir, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), name: 'relay-designation', status: 'ok', sesion: 'c9', rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' })}\n`);
  const peer = (name, body, min) => JSON.stringify({ type: 'user', isMeta: true, timestamp: ts(min), origin: { kind: 'peer', name, body, msg_id: `m-${name}-${min}` }, message: { role: 'user', content: `<cross-session-message from="x">${body}</cross-session-message>` } });
  fs.writeFileSync(path.join(projects, 'c9.jsonl'), [peer('Olvido', 'Terminé lo mío.', 9), peer('Funes', 'Voy con la búsqueda.', 5)].join('\n') + '\n');
  const olvido = path.join(home, 'olvido.jsonl');
  fs.writeFileSync(olvido, `${JSON.stringify({ type: 'assistant', timestamp: ts(8) })}\n`);
  fs.mkdirSync(path.join(claudeDir(home), 'jobs', 'j1'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir(home), 'jobs', 'j1', 'state.json'), JSON.stringify({ name: 'Olvido', updatedAt: ts(8), linkScanPath: olvido }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_OFFICE_NO_BROWSER: '1', TYCON_OFFICE_LINK: '0', TYCON_OFFICE_TEST: '1' };
  const open = spawnSync(process.execPath, [OFFICE, '--open'], { input: '', env, encoding: 'utf8', timeout: 20000 });
  const url = (open.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/) || [])[0];
  check(open.status === 0 && Boolean(url), `8.198: la oficina viva arrancó (${url || open.stderr.trim()})`);
  if (!url) return;
  const lock = JSON.parse(fs.readFileSync(path.join(sdir, 'office', 'server.json'), 'utf8'));
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
    await page.goto(url);
    await page.waitForFunction(() => window.tablero && window.tablero.started, null, { timeout: 45000 });
    await page.locator('input[name="vista"][value="kanban"]').check({ force: true });
    await page.waitForSelector('#boardBody .item[data-numero]');
    // E1: los números, la fila de Sand a la vista, una sola tarjeta para T-2 y la línea de arriba sin `meta.resumen`
    const sandRow = page.locator('#boardBody .item', { hasText: 'El arreglo que Sand dejó' });
    check(await sandRow.count() === 1 && /T-1/.test(await sandRow.innerText()), 'E1: la fila de Sand se ve, con su número');
    check(await page.locator('#boardBody .item[data-numero="T-2"]').count() === 1, 'E1: T-2 va en una sola tarjeta, la de Funes');
    check(/Funes/.test(await page.locator('#boardBody .item[data-numero="T-2"]').innerText()), 'E1: la tarjeta de T-2 es la de Funes');
    const top = await page.locator('#boardBody p.sum').innerText();
    check(/Tu firma: \d+ · Trabado: \d+/.test(top) && !/UN RESUMEN VIEJO/.test(top), `E1: la línea de arriba se arma sola (${top})`);
    await shot(page, 'e1-kanban-numeros', page.locator('#trabajo'));
    // E2: buscar por número, y uno que no está
    await page.fill('#buscarTarea', '2');
    await page.press('#buscarTarea', 'Enter');
    await page.waitForSelector('#ventana:not([hidden])');
    check(/T-2/.test(await page.locator('#ventana').innerText()) && await page.locator('#boardBody .item.marcada').count() === 1, 'E2: «2» marca la tarjeta de T-2 y la abre');
    await shot(page, 'e2-buscar-abre');
    // E6: la ventana se cierra con Escape y el foco vuelve a la tarjeta
    await page.keyboard.press('Escape');
    check(await page.locator('#ventana').isHidden(), 'E6: Escape cierra la ventana');
    await page.fill('#buscarTarea', 'T-99');
    await page.press('#buscarTarea', 'Enter');
    check(/no está en el tablero/.test(await page.locator('#buscarAviso').innerText()), 'E2: un número que no está lo dice debajo del campo');
    await shot(page, 'e2-buscar-no-esta', page.locator('#trabajo'));
    // E6: la X arriba, sin «Cerrar» abajo; tocar afuera cierra; seleccionar adentro y soltar afuera no
    await page.locator('#boardBody .item[data-numero="T-1"]').click();
    await page.waitForSelector('#ventana:not([hidden])');
    check(await page.locator('#ventana button.close[aria-label="Cerrar"]').count() === 1 && await page.locator('#ventana button', { hasText: /^Cerrar$/ }).count() === 0, 'E6: la ventana tiene la X y no el botón de abajo');
    await shot(page, 'e6-ventana-x');
    const panelBox = await page.locator('#ventana .panel3').boundingBox();
    await page.mouse.move(panelBox.x + 40, panelBox.y + 60);
    await page.mouse.down();
    await page.mouse.move(panelBox.x - 30, panelBox.y + 60, { steps: 4 });
    await page.mouse.up();
    check(await page.locator('#ventana').isVisible(), 'E6: seleccionar adentro y soltar afuera no la cierra');
    await page.mouse.click(Math.max(5, panelBox.x - 15), panelBox.y + 10);
    check(await page.locator('#ventana').isHidden(), 'E6: tocar afuera la cierra');
    // E8: las manos, cada una con su color
    await page.waitForFunction(() => document.querySelectorAll('.tag.alert').length >= 2, null, { timeout: 15000 });
    check(await page.locator('.tag.alert-coord', { hasText: 'Pinola' }).count() === 1, 'E8: Pinola levanta la mano en azul: espera a la Coordinadora');
    check(await page.locator('.tag.alert:not(.alert-coord)', { hasText: 'Rita' }).count() === 1, 'E8: Rita levanta la mano por su firma pendiente');
    // el brazo sube de a poco y la sala quieta dibuja pocas veces por segundo: la captura espera a que termine de subir
    await sleep(4000);
    await shot(page, 'e8-manos', page.locator('#stage'));
    if (shots) {
      const tag = await page.locator('.tag', { hasText: 'Rita' }).boundingBox();
      await page.screenshot({ path: path.join(shots, 'e8-mano-de-cerca.png'), clip: { x: Math.max(0, tag.x - 60), y: tag.y, width: 320, height: 260 } });
    }
    await page.locator('.tag', { hasText: 'Rita' }).click();
    await page.waitForSelector('#panel:not([hidden])');
    check(/Firma: el carril de Rita/.test(await page.locator('#panel').innerText()), 'E8: al tocarla, dice qué firma espera');
    await shot(page, 'e8-detalle-firma', page.locator('#panel'));
    // E6: el panel de la persona con Escape, y el foco vuelve
    await page.keyboard.press('Escape');
    check(await page.locator('#panel').isHidden(), 'E6: Escape cierra el panel de la persona');
    // E9: arranca una ejecución con historia y su fila pasa sola a «En curso», con quién la hace
    session('s5', 'Ortega');
    fs.writeFileSync(path.join(sdir, 'active', 's5.json'), JSON.stringify({ storyId: '9.1', sessionId: 's5', repoPath: home, stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'], stepsPending: ['implement'], startedAt: new Date().toISOString() }));
    let row = null;
    for (let i = 0; i < 40 && !(row && row.estado === 'curso'); i += 1) { await sleep(500); row = JSON.parse(fs.readFileSync(path.join(sdir, 'coordination', 'tablero.json'), 'utf8')).pendientes.find((r) => r.historia === '9.1'); }
    check(Boolean(row) && row.estado === 'curso' && row.quien === 'Ortega', `E9: la fila de la 9.1 pasó sola a «En curso» con Ortega (${row && row.estado} ${row && row.quien})`);
    await shot(page, 'e9-se-movio-sola', page.locator('#trabajo'));
    // E3: el modelo y el esfuerzo, arriba de la persona y en su tarjeta; «sin dato» en la que no respondió
    await page.waitForFunction(() => [...document.querySelectorAll('.tag')].some((t) => t.textContent.includes('Opus 5.5 · High')), null, { timeout: 20000 });
    check(/Opus 5\.5 · High/.test(await page.locator('.tag', { hasText: 'Funes' }).innerText()), 'E3: la etiqueta de Funes dice «Opus 5.5 · High»');
    check(/Opus 5\.5 · High/.test(await page.locator('#boardBody .item[data-numero="T-2"]').innerText()), 'E3: su tarjeta del kanban también');
    check(/sin dato · sin dato/.test(await page.locator('.tag', { hasText: 'Sand' }).innerText()), 'E3: Sand, sin respuestas, dice «sin dato»');
    await shot(page, 'e3-modelo-y-esfuerzo', page.locator('#stage'));
    // E5: «Con las sesiones» de la coordinadora: la viva primero, después «Cerradas» con la cerrada en gris y su hora
    // la coordinadora llega recién ahora: antes, con más personas que escritorios, se habría llevado el de Rita
    session('c9', 'Coordinadora');
    await page.waitForFunction(() => [...document.querySelectorAll('#crew > *')].some((c) => c.textContent.includes('Coordinadora')), null, { timeout: 20000 });
    // desde su ficha en «Las sesiones»
    await page.locator('#crew > *', { hasText: 'Coordinadora' }).first().locator('button', { hasText: 'Ver conversación' }).evaluate((b) => b.click());
    await page.waitForSelector('#ventana:not([hidden])');
    try { await page.waitForFunction(() => document.querySelector('#ventana').textContent.includes('Con las sesiones'), null, { timeout: 20000 }); } catch (e) {
      console.log(`E5: la ventana dice: ${(await page.locator('#ventana').innerText()).replace(/\s+/g, ' ').slice(0, 400)}`);
      throw e;
    }
    await page.locator('#ventana label', { hasText: 'Con las sesiones' }).locator('input').check({ force: true });
    await page.waitForSelector('#ventana .quienes .cerradas', { timeout: 15000 });
    const order = await page.locator('#ventana .quienes > *').allInnerTexts();
    check(/^Funes/.test(order[0]) && order.some((t) => t === 'Cerradas') && /^Olvido/.test(order[order.length - 1]), `E5: la viva primero, después «Cerradas» (${order.join(' | ').replace(/\n/g, ' ')})`);
    check(/última actividad \d\d:\d\d/.test(await page.locator('#ventana .quienes button.cerrada').innerText()), 'E5: la cerrada dice su última actividad');
    await page.locator('#ventana .quienes button.cerrada').click();
    check(await page.locator('#ventana', { hasText: 'Esta sesión está cerrada: no recibe mensajes.' }).count() === 1, 'E5: al elegirla dice que no recibe mensajes');
    await shot(page, 'e5-sesiones-cerradas', page.locator('#ventana .panel3'));
  } finally {
    await browser.close();
    try { process.kill(lock.pid, 'SIGKILL'); } catch { /* ya salió */ }
  }
}

// Escribirle a una sesión desde la oficina (E1-E6). Una máquina de juguete con cuatro sesiones: Alfa, con su
// vigilante «vivo» y una sesión falsa que toma el mensaje y contesta; Beto, sin vigilante; Cata, con un cuadro abierto; y
// Gama, de Codex. Deja capturas en OFFICE_8183_SHOTS (una carpeta), si está.
async function talkToSession(playwright) {
  const om = require(path.join(ROOT, 'scripts', 'lib', 'office-messages.js'));
  const http = require('http');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-8183-'));
  const sdir = stateDir(home);
  for (const d of ['active', 'adhoc', 'doing', 'sessions']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  const sessions = path.join(claudeDir(home), 'sessions');
  const projects = path.join(claudeDir(home), 'projects', 'toy');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  const now = () => new Date().toISOString();
  const transcript = (sid) => path.join(projects, `${sid}.jsonl`);
  const append = (sid, lines) => fs.appendFileSync(transcript(sid), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  for (const [sid, name] of [['s1', 'Alfa'], ['s2', 'Beto'], ['s3', 'Cata']]) {
    fs.writeFileSync(path.join(sessions, `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name, status: 'idle', statusUpdatedAt: Date.now() }));
    append(sid, [{ type: 'user', timestamp: now(), origin: { kind: 'human' }, message: { role: 'user', content: `Hola ${name}` } }, { type: 'assistant', timestamp: now(), message: { content: [{ type: 'text', text: `Hola, soy ${name}.` }] } }]);
  }
  fs.writeFileSync(path.join(sdir, 'sessions', 's3.json'), JSON.stringify({ schema: 1, session: 's3', tool: 'claude', name: 'Cata', waitingForOwner: true, waitingFor: 'una respuesta', pid: process.pid, updatedAt: now() }));
  fs.writeFileSync(path.join(sdir, 'sessions', 'cx1.json'), JSON.stringify({ schema: 1, session: 'cx1', tool: 'codex', name: 'Gama', pid: process.pid, busy: false, updatedAt: now() }));
  fs.mkdirSync(om.paths(sdir).watchers, { recursive: true });
  for (const sid of ['s1', 's3']) fs.writeFileSync(om.paths(sdir).watcher(sid), JSON.stringify({ pid: process.pid, started: om.processStart(process.pid) }));
  // la sesión falsa de Alfa: toma lo que llega y, un momento después, lo anota y contesta como lo anota la herramienta
  let taking = true;
  const taker = setInterval(() => {
    if (!taking) return;
    const got = om.take(sdir, 's1');
    if (!got || got.estado !== 'recibido') return;
    setTimeout(() => append('s1', [
      { type: 'user', timestamp: now(), origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', message: { role: 'user', content: `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": ${got.envelope}\n</system-reminder>` } },
      { type: 'assistant', timestamp: now(), message: { content: [{ type: 'text', text: 'Listo: el pedido 12 está verde.' }] } },
      { type: 'system', subtype: 'stop_hook_summary', timestamp: now() },
    ]), 800);
  }, 300);
  const shots = process.env.OFFICE_8183_SHOTS || null;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_OFFICE_NO_BROWSER: '1', TYCON_OFFICE_LINK: '0', TYCON_OFFICE_TEST: '1', TYCON_OFFICE_MESSAGES: '', TYCON_OFFICE_MESSAGE_DEADLINE_MS: '2500' };
  const open = spawnSync(process.execPath, [OFFICE, '--open'], { input: '', env, encoding: 'utf8', timeout: 20000 });
  const url = (open.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/) || [])[0];
  check(open.status === 0 && Boolean(url), 'E1: la oficina con mensajes arrancó');
  if (!url) { clearInterval(taker); return; }
  const lock = JSON.parse(fs.readFileSync(path.join(sdir, 'office', 'server.json'), 'utf8'));
  const browser = await playwright.chromium.launch();
  const other = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>otra</title>'); });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => console.log(`error de la página: ${e.message}`));
    page.on('websocket', (s) => s.on('framereceived', (f) => { if (String(f.payload).includes('"mensaje"')) console.log(`aviso: ${String(f.payload).slice(0, 160)}`); }));
    await page.goto(url);
    await page.waitForFunction(() => window.tablero && window.tablero.started, null, { timeout: 45000 });
    const ventana = page.locator('#ventana');
    const abrirVentana = async (nombre) => {
      if (await ventana.isVisible()) await page.keyboard.press('Escape');
      await page.locator('.tag', { hasText: nombre }).click();
      await page.waitForSelector('#panel:not([hidden])');
      await page.locator('#panel .verCharla').click();
      await page.waitForFunction(() => { const v = document.getElementById('ventana'); return v && !v.hidden && !v.querySelector('p.m') ? true : v && !v.hidden && ![...v.querySelectorAll('p.m')].some((p) => p.textContent === 'Leyendo…'); }, null, { timeout: 8000 });
    };
    const shot = async (name) => { if (shots) await ventana.screenshot({ path: path.join(shots, `${name}.png`) }); };

    // E2: sin vigilante, no se ofrece y lo dice; Codex, lo mismo con su texto
    await abrirVentana('Beto');
    check(await ventana.locator('textarea').count() === 0, 'E2: a Beto, sin vigilante, no se ofrece escribirle');
    check((await ventana.locator('.noRecibe').innerText()) === 'Esta sesión no puede recibir mensajes de la oficina. Escribile una vez en su pestaña y vuelve a poder.', 'E2: y la ventana dice por qué');
    await shot('E2-sin-vigilante');
    if (await page.locator('.tag', { hasText: 'Gama' }).count()) {
      await abrirVentana('Gama');
      check((await ventana.locator('.noRecibe').innerText()) === 'Esta sesión es de Codex: desde acá no se le puede escribir.', 'E2: a una sesión de Codex no se le escribe, y lo dice');
      await shot('E2-codex');
    } else check(true, 'E2: la sesión de Codex de juguete no tiene escritorio en esta máquina: su texto lo prueban T17 y T23');

    // E5: con un cuadro abierto, dice que espera
    await abrirVentana('Cata');
    check((await ventana.locator('.estadoMensaje').innerText()) === 'Está esperando que contestes su cuadro: lo va a leer cuando lo hagas.', 'E5: con un cuadro abierto, dice que lo lee al contestar');
    await shot('E5-cuadro-abierto');

    // E1: mandar, el avioncito, «lo recibió» y la respuesta en «Con vos»
    await abrirVentana('Alfa');
    check((await ventana.locator('.mandarFijo').innerText()) === 'Esto le llega como un mensaje tuyo. No firma ni aprueba nada.', 'E1: el texto fijo');
    await ventana.locator('textarea').fill('revisá el pedido 12');
    await ventana.locator('.mandar .verCharla', { hasText: 'Mandar' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sobre.desdeOficina').length > 0, null, { timeout: 4000 }).then(() => check(true, 'E1: el avioncito sale hacia Alfa'), () => check(false, 'E1: el avioncito sale hacia Alfa'));
    check((await ventana.locator('textarea').inputValue()) === '', 'E1: el campo queda vacío');
    await page.waitForFunction(() => document.querySelector('.estadoMensaje') && document.querySelector('.estadoMensaje').textContent === 'Lo recibió.', null, { timeout: 8000 }).then(() => check(true, 'E1: dice «Lo recibió.»'), () => check(false, 'E1: dice «Lo recibió.»'));
    await page.waitForFunction(() => /Listo: el pedido 12 está verde\./.test(document.querySelector('.conVos') ? document.querySelector('.conVos').textContent : ''), null, { timeout: 15000 }).then(() => check(true, 'E1: la respuesta aparece en «Con vos»'), () => check(false, 'E1: la respuesta aparece en «Con vos»'));
    check(/Vos · desde la oficina/.test(await ventana.locator('.conVos').innerText()), 'E1: el mensaje va marcado «desde la oficina»');
    await shot('E1-mandar-y-respuesta');

    // E6: «aprobado» avisa antes de mandar, y la ventana no tiene nada que apruebe
    await ventana.locator('textarea').fill('aprobado');
    await ventana.locator('.mandar .verCharla', { hasText: 'Mandar' }).click();
    await page.waitForFunction(() => /Esto no aprueba nada: para aprobar, contestá el cuadro\./.test(document.querySelector('.estadoMensaje').textContent), null, { timeout: 4000 }).then(() => check(true, 'E6: avisa antes de mandar un «aprobado»'), () => check(false, 'E6: avisa antes de mandar un «aprobado»'));
    const botones = await ventana.locator('button').allInnerTexts();
    check(botones.every((b) => !/aprob|firm|s[ií],/i.test(b)), `E6: ningún botón aprueba ni firma (${botones.join(' · ')})`);
    check(fs.readdirSync(om.paths(sdir).inbox('s1')).filter((f) => f.endsWith('.json')).length === 0, 'E6: no se mandó sin «Mandar igual»');
    await shot('E6-parece-aprobacion');

    // E4: otra página, en otro puerto del mismo navegador, no puede mandar aunque sepa el token
    const page2 = await browser.newPage();
    await page2.goto(`http://127.0.0.1:${other.address().port}/`);
    const rejected = await page2.evaluate(async ([port, token]) => {
      try { const r = await fetch(`http://127.0.0.1:${port}/mensaje?t=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ s: 'Alfa', texto: 'desde otra página' }) }); return `contestó ${r.status}`; } catch (e) { return 'rechazado'; }
    }, [lock.port, lock.token]);
    check(rejected === 'rechazado', `E4: la otra página no puede mandar (${rejected})`);
    check(!om.readLog(sdir).rows.some((x) => x.estado === 'mandado' && x.largo === 'desde otra página'.length), 'E4: nada llegó al buzón');
    await page2.close();

    // E3: nadie lo toma: «No le llegó» y el texto vuelve al campo; con la oficina caída, «No se pudo mandar»
    taking = false;
    await ventana.locator('textarea').fill('esto no lo toma nadie');
    await ventana.locator('.mandar .verCharla', { hasText: 'Mandar' }).click();
    await page.waitForFunction(() => document.querySelector('.estadoMensaje').textContent === 'No le llegó.', null, { timeout: 10000 }).then(() => check(true, 'E3: dice «No le llegó.»'), () => check(false, 'E3: dice «No le llegó.»'));
    check((await ventana.locator('textarea').inputValue()) === 'esto no lo toma nadie', 'E3: el texto vuelve al campo');
    await shot('E3-no-le-llego');
    process.kill(lock.pid, 'SIGTERM');
    await sleep(800);
    await ventana.locator('textarea').fill('con la oficina caída');
    await ventana.locator('.mandar .verCharla', { hasText: 'Mandar' }).click();
    await page.waitForFunction(() => document.querySelector('.estadoMensaje').textContent === 'No se pudo mandar.', null, { timeout: 6000 }).then(() => check(true, 'E3: con la oficina caída, «No se pudo mandar.»'), () => check(false, 'E3: con la oficina caída, «No se pudo mandar.»'));
    check((await ventana.locator('textarea').inputValue()) === 'con la oficina caída', 'E3: y el texto queda en el campo');
    await shot('E3-oficina-caida');
  } finally {
    clearInterval(taker);
    other.close();
    await browser.close();
    try { process.kill(lock.pid, 'SIGKILL'); } catch { /* ya salió */ }
  }
}

async function main() {
  const playwright = PINNED_PW.load();
  if (!playwright) { console.error(`sin navegador: ${PINNED_PW.locate().why}`); return 2; }
  if (process.argv.includes('--messages')) {
    await talkToSession(playwright);
    console.log(fails.length ? `E1-E6 (8.183): FALLA (${fails.length})` : 'E1-E6 (8.183): OK');
    return fails.length ? 1 : 0;
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-e1-'));
  const sdir = stateDir(home);
  for (const d of ['active', 'adhoc', 'doing']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  const sessions = path.join(claudeDir(home), 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  for (const [sid, name] of [['s1', 'Alfa'], ['s2', 'Beto']]) {
    fs.writeFileSync(path.join(sessions, `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name, status: 'busy', statusUpdatedAt: Date.now() }));
  }
  fs.writeFileSync(path.join(sdir, 'adhoc', 's1.json'), JSON.stringify({ reason: 'arreglo de la oficina', declaredAt: new Date().toISOString() }));

  // en modo de prueba, el proceso sólo corre los guiones que le den: ni los pedidos reales ni el modelo de verdad
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_OFFICE_NO_BROWSER: '1', TYCON_OFFICE_LINK: '0', TYCON_OFFICE_TEST: '1' };
  const open = spawnSync(process.execPath, [OFFICE, '--open'], { input: '', env, encoding: 'utf8', timeout: 20000 });
  const url = (open.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/) || [])[0];
  check(open.status === 0 && Boolean(url), `la oficina viva arrancó (${url || open.stderr.trim()})`);
  if (!url) return 1;
  const lock = JSON.parse(fs.readFileSync(path.join(sdir, 'office', 'server.json'), 'utf8'));

  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url);
    // con la máquina cargada, la escena llega a tardar más de 25 s
    await page.waitForFunction(() => window.tablero && window.tablero.started, null, { timeout: 45000 });
    check(true, 'la escena 3D arrancó');
    // la cámara se mueve y se abre el detalle de una persona
    const stage = page.locator('#stage canvas');
    const box = await stage.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    await page.locator('.tag', { hasText: 'Alfa' }).click();
    await page.waitForSelector('#panel:not([hidden])');
    // la cámara tiene inercia: se espera a que quede quieta antes de tomar dónde está
    let camBefore = null;
    for (let i = 0; i < 40; i += 1) {
      const now = await page.evaluate(() => window.tablero.camara());
      if (camBefore && JSON.stringify(now) === JSON.stringify(camBefore)) break;
      camBefore = now;
      await sleep(250);
    }
    check((await page.locator('#panel h3').innerText()) === 'Alfa', 'el detalle de Alfa abierto');
    // un cambio: Beto declara su arreglo; la tarjeta llega sola
    fs.writeFileSync(path.join(sdir, 'adhoc', 's2.json'), JSON.stringify({ reason: 'revisión del banco de controles', declaredAt: new Date().toISOString() }));
    // el carril es el título: va en su tarjeta del kanban; sin conversación legible, la de la persona dice «Sin novedades»
    await page.waitForFunction(() => [...document.querySelectorAll('.item')].some((c) => c.textContent.includes('revisión del banco de controles')), null, { timeout: 5000 });
    check(true, 'la tarjeta de Beto cambió sola');
    check(await page.locator('#panel').isVisible() && (await page.locator('#panel h3').innerText()) === 'Alfa', 'el detalle sigue abierto');
    await sleep(300);
    const camAfter = await page.evaluate(() => window.tablero.camara());
    check(JSON.stringify(camAfter) === JSON.stringify(camBefore), `la cámara no se movió (${camBefore} → ${camAfter})`);
    // cambia quiénes están: Alfa se va con su detalle abierto y llega Cata. Los escritorios se rehacen y el detalle se cierra
    fs.unlinkSync(path.join(sdir, 'adhoc', 's1.json'));
    fs.unlinkSync(path.join(sessions, 's1.json'));
    fs.writeFileSync(path.join(sessions, 's3.json'), JSON.stringify({ pid: process.pid, sessionId: 's3', name: 'Cata', status: 'busy', statusUpdatedAt: Date.now() }));
    await page.waitForFunction(() => [...document.querySelectorAll('.tag')].some((t) => t.textContent.includes('Cata')), null, { timeout: 5000 });
    check(true, 'los escritorios se rehicieron con Cata');
    check(await page.locator('.tag', { hasText: 'Alfa' }).count() === 0, 'Alfa ya no tiene escritorio');
    check(!(await page.locator('#panel').isVisible()), 'el detalle de Alfa se cerró');
    // se cierra el proceso: la última foto queda y el aviso aparece
    process.kill(lock.pid, 'SIGTERM');
    await page.waitForFunction(() => document.getElementById('ovl').textContent.includes('La oficina se cerró'), null, { timeout: 5000 });
    check(true, 'el aviso «La oficina se cerró…» apareció');
    check(await page.locator('.item', { hasText: 'revisión del banco de controles' }).count() === 1, 'la última foto quedó');
    await tablesByTopic(playwright, env, sdir);
    await taskNumbers(playwright);
  } finally {
    await browser.close();
    try { process.kill(lock.pid, 'SIGKILL'); } catch { /* ya salió */ }
  }
  console.log(fails.length ? `E1: FALLA (${fails.length})` : 'E1: OK');
  return fails.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`E1: ${e && e.stack ? e.stack : e}`); process.exitCode = 1; });
