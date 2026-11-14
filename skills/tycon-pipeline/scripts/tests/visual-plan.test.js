/**
 * visual-plan.test.js — cómo se abre en el navegador el plan, la maqueta y la guía de prueba.
 *
 * En Windows se abren sin pasar por `cmd`: con `cmd /c start <ruta>`, un `&` en la ruta corre otra orden. `rundll32`
 * recibe la ruta entera como un solo argumento, como ya lo hace la oficina. La guía de prueba (`qa-guide.js --open`) usa
 * el mismo abridor.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/visual-plan.test.js < /dev/null
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SK = path.join(__dirname, '..');
const v = require(path.join(SK, 'visual-plan.js'));

const RARA = 'C:\\Users\\dev\\plan & calc.html';

test('T1 Abrir_EnCadaSistema_ElProgramaDeSiempre', () => {
  assert.deepStrictEqual(v.openCommand('/tmp/p.html', 'darwin'), ['open', ['/tmp/p.html']]);
  assert.deepStrictEqual(v.openCommand('/tmp/p.html', 'linux'), ['xdg-open', ['/tmp/p.html']]);
  assert.deepStrictEqual(v.openCommand(RARA, 'win32'), ['rundll32', ['url.dll,FileProtocolHandler', RARA]]);
});

test('T2 Abrir_EnWindows_LaRutaConAmpersandVaEnteraYSinConsola', () => {
  const lanzados = [];
  const falso = (cmd, args, opts) => { lanzados.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  v.openInBrowser(RARA, 'el plan', { platform: 'win32', spawn: falso });
  assert.strictEqual(lanzados.length, 1);
  assert.notStrictEqual(lanzados[0].cmd, 'cmd');
  assert.deepStrictEqual(lanzados[0].args, ['url.dll,FileProtocolHandler', RARA]);
  assert.ok(!lanzados[0].opts.shell, 'sin consola de por medio');
});

test('T3 Abrir_SiNoArranca_DiceLaRuta', () => {
  let alError = null;
  const falso = () => ({ on(ev, f) { if (ev === 'error') alError = f; }, unref() {} });
  const errores = [];
  const original = console.error;
  console.error = (m) => errores.push(String(m));
  try {
    v.openInBrowser('/tmp/p.html', 'la maqueta', { platform: 'linux', spawn: falso });
    alError({ code: 'ENOENT' });
  } finally { console.error = original; }
  assert.match(errores.join('\n'), /No pude abrir la maqueta en el navegador \(ENOENT\) — abrilo a mano: \/tmp\/p\.html/);
});

test('T4 QaGuide_AbreConElMismoAbridor', () => {
  const fuente = fs.readFileSync(path.join(SK, 'qa-guide.js'), 'utf8');
  assert.doesNotMatch(fuente, /'\/c',\s*'start'/, 'qa-guide no abre con cmd /c start');
  assert.match(fuente, /if \(require\(path\.join\(__dirname, 'visual-plan\.js'\)\)\.openInBrowser\(/, 'qa-guide usa openInBrowser y mira si lanzó');
});

test('T5 Abrir_DevuelveSiPudoLanzar', () => {
  const ok = () => ({ on() {}, unref() {} });
  assert.strictEqual(v.openInBrowser('/tmp/p.html', 'el plan', { platform: 'linux', spawn: ok }), true);
  const roto = () => { throw new Error('spawn EACCES'); };
  const original = console.error;
  console.error = () => {};
  try {
    assert.strictEqual(v.openInBrowser('/tmp/p.html', 'el plan', { platform: 'linux', spawn: roto }), false);
  } finally { console.error = original; }
});
