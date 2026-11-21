#!/usr/bin/env node
'use strict';
// control-signer.test.js — la constancia de un cambio de control dice quién firmó de verdad.
//
// Firmaba siempre «dueño», también cuando aprobaba la sesión designada en su ventana: la cuenta de firmas del dueño
// salía inflada y no se podía separar lo que vio él de lo que aprobó la coordinadora.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { signerOf } = require('../lib/delegated-signing.js');

function casaConDesignada(t, sesion) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'control-signer-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, '.tycon', 'state');
  fs.mkdirSync(state, { recursive: true });
  if (sesion) {
    fs.writeFileSync(path.join(state, 'gates.log'),
      `${JSON.stringify({ name: 'relay-designation', status: 'ok', sesion, cita: 'sos la coordinadora', ts: '2026-10-29T10:00:00Z' })}\n`);
  }
  return home;
}

test('Signer_VentanaDeLaDesignada_EsCoordinadora', (t) => {
  const home = casaConDesignada(t, 'sesion-coord');
  assert.equal(signerOf({ via: 'ventana', sesion: 'sesion-coord' }, { home }), 'coordinadora');
});

test('Signer_VentanaDeOtraSesion_EsDueno', (t) => {
  const home = casaConDesignada(t, 'sesion-coord');
  assert.equal(signerOf({ via: 'ventana', sesion: 'otra-sesion' }, { home }), 'dueño');
});

test('Signer_Terminal_EsDueno_AunqueHayaDesignada', (t) => {
  const home = casaConDesignada(t, 'sesion-coord');
  assert.equal(signerOf({ via: 'terminal', sesion: 'sesion-coord' }, { home }), 'dueño');
});

test('Signer_SinDesignada_EsDueno', (t) => {
  const home = casaConDesignada(t, null);
  assert.equal(signerOf({ via: 'ventana', sesion: 'sesion-coord' }, { home }), 'dueño');
});
