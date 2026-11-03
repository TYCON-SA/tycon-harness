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

async function main() {
  const playwright = PINNED_PW.load();
  if (!playwright) { console.error(`sin navegador: ${PINNED_PW.locate().why}`); return 2; }

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
  } finally {
    await browser.close();
    try { process.kill(lock.pid, 'SIGKILL'); } catch { /* ya salió */ }
  }
  console.log(fails.length ? `E1: FALLA (${fails.length})` : 'E1: OK');
  return fails.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`E1: ${e && e.stack ? e.stack : e}`); process.exitCode = 1; });
