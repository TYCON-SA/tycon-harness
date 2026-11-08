#!/usr/bin/env node
'use strict';
/**
 * marker-archive-signatures.test.js — las firmas en el volcado del cierre.
 *
 * QUÉ CUIDA: que el cierre (`marker.js clear`) ponga en el volcado el campo `firmas`, con las firmas del registro común
 * de la sesión de la corrida dentro de su ventana, y que cerrar nunca falle por ellas.
 *
 * El registro común se lee en dos casas: la de la cuenta (la que escribe `appendSignature` por defecto, y que una HOME
 * de prueba no cambia) y la de HOME. La prueba siembra sólo el de su HOME temporal, con una sesión inventada que el de
 * la cuenta no tiene, y comprueba que el de la cuenta no cambió: ninguna prueba escribe ahí.
 *
 * El arnés real es este mismo árbol (`TYCON_GUIDES_DIR`): el cierre carga de ahí la biblioteca de las firmas y el
 * saneador.
 *
 * stable-data: las horas son relativas a la corrida de la prueba; ninguna prueba crea commits fuera de su carpeta.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKER = path.join(__dirname, '..', 'marker.js');
const ARBOL = path.resolve(__dirname, '..', '..', '..', '..');
const { logPath } = require(path.join(ARBOL, 'scripts', 'lib', 'signature-log.js'));
const SID = 'aaaaaaaa-0000-4000-8000-0000000000a1';

function corral(t) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'firmas-corrida-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  fs.mkdirSync(path.join(raiz, 'home', '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'repo'), { recursive: true });
  return raiz;
}

function correrMarker(args, raiz) {
  return spawnSync(process.execPath, [MARKER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: path.join(raiz, 'home'),
      CLAUDE_CODE_SESSION_ID: SID,
      TYCON_GUIDES_DIR: ARBOL,
      TYCON_PROJECTS_DIR: path.join(raiz, 'projects'),
      TYCON_NO_THREAD_RESCUE: '1',
      TYCON_NO_RUN_CHANGE: '1',
      TYCON_LANE_LLM: '0',
    },
  });
}

/** El marcador de la corrida; `sinArranque` le saca la hora de arranque después de escribirlo. */
function marcarCorrida(raiz, { startedAt, sinArranque } = {}) {
  const repo = path.join(raiz, 'repo');
  const r = correrMarker(['set', JSON.stringify({ storyId: '2.78-prueba', storyPath: path.join(repo, 'story.md'), repoPath: repo, sessionId: SID, stepsPending: [], ...(startedAt ? { startedAt } : {}) })], raiz);
  assert.strictEqual(r.status, 0, `marker set falló: ${r.stderr}`);
  const archivo = path.join(raiz, 'home', '.claude', '.tycon-pipeline', 'active', `${SID}.json`);
  const m = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  if (sinArranque) delete m.startedAt;
  else m.startedAt = startedAt;
  fs.writeFileSync(archivo, JSON.stringify(m, null, 2));
}

function volcado(raiz) {
  const d = path.join(raiz, 'home', '.claude', '.tycon-pipeline', 'timing-history');
  const fs1 = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')) : [];
  assert.strictEqual(fs1.length, 1, `un volcado: ${fs1.join(', ')}`);
  return JSON.parse(fs.readFileSync(path.join(d, fs1[0]), 'utf8'));
}

const tamano = (p) => { try { return fs.statSync(p).size; } catch (e) { return e.code; } };

const firma = (ts, reason) => JSON.stringify({ ts, signature: 'plan-approval', level: 1, covers: ['plan-approval'], via: 'click',
  delegated: false, signer: 'persona', ordered_by: SID, target: SID, machine: 'm', reason, source: 'marker.js' });

test('T5 2.78-Clear_VolcadoConFirmas @story-2.78 @ac-6', (t) => {
  const raiz = corral(t);
  const ahora = Date.now();
  marcarCorrida(raiz, { startedAt: new Date(ahora - 3600 * 1000).toISOString() });
  const log = logPath(path.join(raiz, 'home'));
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, `${firma(new Date(ahora - 1800 * 1000).toISOString(), 'adentro de la ventana')}\n${firma(new Date(ahora - 7200 * 1000).toISOString(), 'antes del arranque')}\n`);
  const cuenta = logPath();
  const antes = tamano(cuenta);

  const c = correrMarker(['clear', '--discard'], raiz);
  assert.strictEqual(c.status, 0, `el clear no debe fallar: ${c.stderr}`);
  const d = volcado(raiz);
  assert.ok(d.firmas, `el volcado trae firmas: ${Object.keys(d).join(', ')}`);
  assert.strictEqual(d.firmas.estado, 'leido', JSON.stringify(d.firmas));
  assert.deepStrictEqual(d.firmas.lineas.map((l) => l.razon), ['adentro de la ventana']);
  assert.strictEqual(d.firmas.lineas[0].otra_casa, true, 'vino sólo del registro de HOME');
  assert.strictEqual(tamano(cuenta), antes, 'el registro de la cuenta no cambió');
});

test('T6 2.78-Clear_NoFrenaPorLasFirmas @story-2.78 @ac-5', (t) => {
  const raiz = corral(t);
  marcarCorrida(raiz, { sinArranque: true });
  const c = correrMarker(['clear', '--discard'], raiz);
  assert.strictEqual(c.status, 0, `el clear no debe fallar: ${c.stderr}`);
  const d = volcado(raiz);
  assert.ok(d.firmas, 'el volcado trae firmas');
  assert.strictEqual(d.firmas.estado, 'no_medido');
  assert.match(String(d.firmas.motivo || ''), /hora de arranque/);
});
