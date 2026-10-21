#!/usr/bin/env node
/**
 * uncut-output.test.js — que ningún guión del arnés termine con `process.exit(main())`.
 *
 * POR QUÉ EXISTE. En Node las escrituras a una TUBERÍA son asincrónicas:
 * `process.exit()` mata el proceso con parte de lo escrito todavía en el aire. Casi todos los
 * guiones de acá los ejecuta OTRO proceso y le parsea la salida, así que la tubería es el caso
 * normal, no el raro.
 *
 * Ejemplo: `audit-dependencies.js` con un informe de 9782 bytes que llega cortado en 8192, el
 * JSON no parsea, y el repo sale «no devolvió JSON legible (exit 0)» — NO MEDIDO, con un
 * motivo que no nombra la causa y que manda a buscar el problema al repo equivocado. Pasa
 * inadvertido porque sólo muerde cuando la salida pasa de 8 KB.
 *
 * El primer caso de abajo demuestra el mecanismo con la forma exacta y un tamaño mayor que el
 * buffer del caño (el snapshot del nocturno pesa ~41 KB, el listado del banco ~112 KB); el segundo
 * es el que impide que el patrón vuelva a entrar.
 *
 * 🔴 Ojo al arreglar: `process.exitCode` sólo sirve si `main` es SINCRÓNICA y no deja
 * manejadores abiertos (servidores, timers, watchers). Si los deja, el proceso no termina: eso
 * se verifica de a uno, no se cambia en masa.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
let casos = 0, fallos = 0;
const prueba = (m, fn) => { casos++; try { fn(); console.log(`✅ salida-sin-cortar: ${m}`); } catch (e) { fallos++; console.log(`❌ salida-sin-cortar: ${m} — ${e.message}`); } };

// Cuánto se lleva el corte depende de la máquina: el caño guarda lo que entra en su buffer (8 KB en unos, 64 KB en
// macOS) y lo demás se pierde. Con 41 KB (un snapshot del nocturno) en una Mac no se corta nada; por eso la
// demostración usa 200 KB, más que cualquier buffer conocido (el listado real del banco pesa ~112 KB). Donde ni así
// se corta (en Linux, node escribe al caño de forma sincrónica), la demostración dice NO MEDIDO en vez de rojo: el
// control que importa es el de abajo, y ése corre igual en todas partes.
const TAM_DEMO = 200000;
let noMedido = false;
prueba(`🔴 el mecanismo: con process.exit() una salida de ${TAM_DEMO / 1000} KB llega cortada; con exitCode, entera`, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'corte-'));
  const g = path.join(d, 'forma.js');
  fs.writeFileSync(g, [
    "console.log(JSON.stringify({ relleno: 'x'.repeat(Number(process.argv[2])) }));",
    "if (process.argv[3] === 'exit') process.exit(0); else process.exitCode = 0;",
  ].join('\n'));
  const corre = (tam, modo) => spawnSync(process.execPath, [g, String(tam), modo], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
  const conExit = corre(TAM_DEMO, 'exit'), conCode = corre(TAM_DEMO, 'exitCode');
  fs.rmSync(d, { recursive: true, force: true });
  assert(conCode.length > TAM_DEMO, `con exitCode también se cortó (${conCode.length} bytes)`);
  JSON.parse(conCode);
  if (conExit.length > TAM_DEMO) { noMedido = true; return; }
  assert.throws(() => JSON.parse(conExit), 'la salida cortada igual parseó');
});
if (noMedido) console.log(`⏭ salida-sin-cortar: NO MEDIDO — en esta máquina process.exit() no cortó ${TAM_DEMO / 1000} KB (caño sincrónico): la demostración no aplica acá; el control de abajo sí`);

prueba('🔴 ningún guión del arnés termina con process.exit(main())', () => {
  const malos = [];
  const recorrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) recorrer(f); continue; }
      if (!e.name.endsWith('.js')) continue;
      const t = fs.readFileSync(f, 'utf8');
      // El opt-out deja CONSTANCIA, no apaga en silencio: sirve para un `main` asincrónico o que
      // deje manejadores abiertos, donde exitCode colgaría el proceso.
      if (/process\.exit\(\s*main\(\)\s*\)/.test(t) && !/@salida-sin-cortar-exento/.test(t)) {
        malos.push(path.relative(RAIZ, f));
      }
    }
  };
  recorrer(path.join(RAIZ, 'scripts'));
  assert.deepStrictEqual(malos, [], `usan process.exit(main()): ${malos.join(', ')}\n   ` +
    'Cambiar a `process.exitCode = main()` — y si `main` es asincrónica o deja manejadores abiertos, ' +
    'marcar el archivo con @salida-sin-cortar-exento y decir por qué.');
});

console.log(fallos === 0 ? `✅ salida-sin-cortar: todo verde (${casos} casos)` : `❌ salida-sin-cortar: ${fallos} fallo(s) de ${casos}`);
process.exitCode = fallos === 0 ? 0 : 1;
