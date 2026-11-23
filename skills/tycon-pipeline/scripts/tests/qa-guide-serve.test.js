#!/usr/bin/env node
/**
 * qa-guide-serve.test.js — con `--serve`, «Guardar» escribe en el archivo de la guía sin preguntar dónde.
 *
 * Caso: abierta como archivo, el botón Guardar de la guía pide elegir carpeta, porque el navegador no deja que una
 * página escriba en el disco por su cuenta. Servida desde la máquina, la guía le manda el archivo entero a quien la
 * sirve, y éste lo escribe en su lugar del repo. Sólo lo acepta con la ficha de la dirección, y sólo si es una guía.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/qa-guide-serve.test.js < /dev/null
 */
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serveGuide } = require(path.join(__dirname, '..', 'qa-guide.js'));

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-serve-')));
const servers = [];
after(() => {
  for (const s of servers) s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const GUIA = '<!doctype html>\n<html><body><script id="qa-state" type="application/json">{}</script></body></html>';

async function servida() {
  const out = path.join(dir, `guia-${servers.length}.html`);
  fs.writeFileSync(out, GUIA);
  const s = await serveGuide(out);
  servers.push(s.server);
  return { out, ...s, base: s.url.replace(/\/\?t=.*$/, '') };
}

test('con la ficha, la guía se lee y Guardar la reemplaza en su archivo', async () => {
  const { out, url, base, token } = await servida();
  const leida = await fetch(url);
  assert.strictEqual(leida.status, 200);
  assert.strictEqual(await leida.text(), GUIA);

  const nueva = GUIA.replace('{}', '{"v1":"pass"}');
  const r = await fetch(`${base}/guardar`, { method: 'POST', headers: { 'X-QA-Token': token }, body: nueva });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), nueva);
  assert.ok(!fs.existsSync(`${out}.guardando`), 'no queda el archivo intermedio');
});

test('sin la ficha no se lee ni se escribe', async () => {
  const { out, base } = await servida();
  assert.strictEqual((await fetch(`${base}/`)).status, 403);
  const r = await fetch(`${base}/guardar`, { method: 'POST', headers: { 'X-QA-Token': 'otra' }, body: GUIA.replace('{}', '{"v1":"fail"}') });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), GUIA);
});

test('un cuerpo que no es una guía no pisa el archivo', async () => {
  const { out, base, token } = await servida();
  const r = await fetch(`${base}/guardar`, { method: 'POST', headers: { 'X-QA-Token': token }, body: '<p>hola</p>' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), GUIA);
});

test('escucha sólo en esta máquina', async () => {
  const { url } = await servida();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
});
