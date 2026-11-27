#!/usr/bin/env node
'use strict';
// owner-window-give-back.test.js — el click del dueño vuelve a valer si el comando que lo gastó no llegó a ejecutarse
// (F27, decisión del dueño del 27/11: «debe gastarse sólo si el comando corre»). Sólo el caso que se puede ver: el
// comando salió 126 o 127 (sin permiso, no encontrado) y el pedido de la ventana sigue sin consumir. Si otro freno lo
// niega después, Claude Code no manda ningún evento, y ese caso sigue gastando el click (queda afuera a propósito).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ow = require('../lib/owner-window.js');
const oa = require('../lib/owner-approvals.js');

const SESION = 'ses-a';
const TOOL = 'toolu_firma_1';
const APROBACION = 'aprob-123';

/** Una casa de prueba con un pedido de la ventana que gastó una aprobación, como lo deja el freno antes de correr. */
function armar({ consumido = false, otraHerramienta = false, sinAprobacion = false } = {}) {
  const casa = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ow-giveback-')));
  const dirVentana = ow.carpeta(casa);
  fs.mkdirSync(dirVentana, { recursive: true });
  const reg = { firma: 'escape:controles', sesion: SESION, destino: SESION, tool_use_id: otraHerramienta ? 'toolu_otro' : TOOL,
    comando: 'run-base-controls.sh approve --expect abc', ts: '2026-11-27T10:00:00.000Z', ...(sinAprobacion ? {} : { via: 'click', aprobacion: APROBACION }) };
  const nombre = `escape_controles--${SESION}--${SESION}.json`;
  fs.writeFileSync(path.join(dirVentana, consumido ? `${nombre}.consumido-1` : nombre), JSON.stringify(reg));
  const usadas = path.join(oa.carpeta(casa), 'usadas');
  fs.mkdirSync(usadas, { recursive: true });
  fs.writeFileSync(path.join(usadas, APROBACION), '{}\n');
  return { casa, usada: () => fs.existsSync(path.join(usadas, APROBACION)), pedidos: () => fs.readdirSync(dirVentana) };
}
const falla = (error, o = {}) => ({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', session_id: SESION, tool_use_id: TOOL, error, ...o });

test('OwnerWindowGiveBack_NotFound_ReturnsTheClickOnce — sale 127 y el pedido sigue sin consumir: el click vuelve, una vez', () => {
  // 🔴 rojo si: el click queda gastado aunque el comando no corrió (el caso del #1747), o vuelve dos veces
  const t = armar();
  const r = ow.devolverSiNoCorrio(falla('Exit code 127\nbash: /x/run-base-controls.sh: No such file or directory'), { casa: t.casa });
  assert.ok(r && r.devuelta === APROBACION, JSON.stringify(r));
  assert.strictEqual(t.usada(), false, 'la aprobación vuelve a valer');
  assert.ok(t.pedidos().every((f) => !f.endsWith('.json')), 'el pedido queda cerrado: ningún guion lo puede consumir después');
  fs.writeFileSync(path.join(oa.carpeta(t.casa), 'usadas', APROBACION), '{}\n');
  assert.strictEqual(ow.devolverSiNoCorrio(falla('Exit code 127\nno encontrado'), { casa: t.casa }), null, 'una sola vez');
  assert.strictEqual(t.usada(), true);
});

test('OwnerWindowGiveBack_NoPermission_ReturnsTheClick — sale 126 (sin permiso de ejecución): el click vuelve', () => {
  const t = armar();
  assert.ok(ow.devolverSiNoCorrio(falla('Exit code 126\nbash: /x/run.sh: Permission denied'), { casa: t.casa }));
  assert.strictEqual(t.usada(), false);
});

test('OwnerWindowGiveBack_RanOrOtherCases_KeepsTheClickSpent — corrió, salió con otro código, o no es su pedido: queda gastado', () => {
  // 🔴 rojo si: vuelve el click de un comando que sí corrió (pedido consumido, o salió 1), o el de otro comando
  const casos = [
    ['el guion consumió el pedido', armar({ consumido: true }), falla('Exit code 127\nalgo adentro no se encontró')],
    ['salió 1', armar(), falla('Exit code 1\nrojo')],
    ['salió 2', armar(), falla('Exit code 2\nfreno')],
    ['otro comando', armar({ otraHerramienta: true }), falla('Exit code 127\nno encontrado')],
    ['un pedido sin aprobación gastada', armar({ sinAprobacion: true }), falla('Exit code 127\nno encontrado')],
    ['otro evento', armar(), falla('Exit code 127\nx', { hook_event_name: 'PostToolUse' })],
    ['otra sesión', armar(), falla('Exit code 127\nx', { session_id: 'ses-b' })],
    ['sin tool_use_id', armar(), falla('Exit code 127\nx', { tool_use_id: undefined })],
    ['el código en el medio del texto', armar(), falla('fallo: Exit code 127')],
  ];
  for (const [nombre, t, ev] of casos) {
    assert.strictEqual(ow.devolverSiNoCorrio(ev, { casa: t.casa }), null, nombre);
    assert.strictEqual(t.usada(), true, nombre);
  }
});

test('OwnerWindowBox_ExactForm — el detalle del cuadro dice el comando con su intérprete y su ruta entera', () => {
  // 🔴 rojo si: el detalle dice sólo el nombre del guion (la firma por rango decía «run-base-controls.sh approve …»), el
  // agente lo vuelve a correr sin `bash` o desde otra copia, y otro freno lo niega después de gastar el click (F27, la
  // mitigación del caso que no se puede ver)
  const ruta = '/Users/x/.tycon/harness/scripts/ci/run-base-controls.sh';
  const comando = `bash '${ruta}' approve --range origin/main...HEAD`;
  assert.deepStrictEqual(ow.formaExacta(comando, ow.canonica(comando)), ['bash', ruta, 'approve', '--range', 'origin/main...HEAD']);
  // una ruta con espacios va entre comillas, como la lee la consola
  const conEspacio = "bash '/Users/x y/run.sh' approve";
  assert.deepStrictEqual(ow.formaExacta(conEspacio, ['/Users/x y/run.sh', 'approve']), ['bash', "'/Users/x y/run.sh'", 'approve']);
  // sin intérprete delante, el programa como se pidió; con el intérprete ya en las palabras, no se repite
  assert.deepStrictEqual(ow.formaExacta('/p/marker.js sign-file x a', ['/p/marker.js', 'sign-file', 'x', 'a']), ['/p/marker.js', 'sign-file', 'x', 'a']);
  assert.deepStrictEqual(ow.formaExacta('bash /p/run.sh go', ['bash', '/p/run.sh', 'go']), ['bash', '/p/run.sh', 'go']);
  assert.strictEqual(ow.formaExacta('x', null), null);
});
