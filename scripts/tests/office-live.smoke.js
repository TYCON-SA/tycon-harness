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

  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_OFFICE_NO_BROWSER: '1' };
  const open = spawnSync(process.execPath, [OFFICE, '--open'], { input: '', env, encoding: 'utf8', timeout: 20000 });
  const url = (open.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/) || [])[0];
  check(open.status === 0 && Boolean(url), `la oficina viva arrancó (${url || open.stderr.trim()})`);
  if (!url) return 1;
  const lock = JSON.parse(fs.readFileSync(path.join(sdir, 'office', 'server.json'), 'utf8'));

  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url);
    await page.waitForFunction(() => window.tablero && window.tablero.started, null, { timeout: 15000 });
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
    await page.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('revisión del banco de controles')), null, { timeout: 5000 });
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
    check(await page.locator('.card', { hasText: 'revisión del banco de controles' }).count() === 1, 'la última foto quedó');
  } finally {
    await browser.close();
    try { process.kill(lock.pid, 'SIGKILL'); } catch { /* ya salió */ }
  }
  console.log(fails.length ? `E1: FALLA (${fails.length})` : 'E1: OK');
  return fails.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`E1: ${e && e.stack ? e.stack : e}`); process.exitCode = 1; });
