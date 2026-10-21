#!/usr/bin/env node
/**
 * expiring-debts.test.js — red del aviso de deudas declaradas que vencen
 * (scripts/hooks/dependencies-notice.js).
 *
 * POR QUÉ EXISTE. Una deuda de dependencias declarada tiene fecha: mientras corre, el análisis la
 * ampara; el día que vence, deja de ampararla y el repo empieza a frenar SUS PROPIOS pull requests.
 * El dato está en el snapshot y, sin el aviso, nadie lo mira: el equipo se enteraría al quedar
 * trabado, sin saber por qué.
 *
 * Los casos giran alrededor de las confusiones que matarían la pieza sin dar un solo error:
 *   · una declaración VACÍA (la que queda cuando la deuda se paga) conserva su fecha: avisar por
 *     ella sería ruido puro, y el ruido es lo que hace que el aviso se ignore;
 *   · una fecha ILEGIBLE que se ignora en silencio es peor que una vencida — si no se puede saber
 *     hasta cuándo ampara, no ampara (fail-closed, como la vejez del snapshot);
 *   · una deuda por vencer que no cuenta como «algo que decir» dejaría salir el ✅ de «no hay nada
 *     esperando decisión» al lado del aviso, y el lector se queda con el verde.
 *
 * Ninguno toca la red ni el disco del repo: se le pasa un snapshot armado a mano.
 */
const assert = require('assert');
const path = require('path');
const H = require(path.join(__dirname, '..', 'hooks', 'dependencies-notice.js'));

let casos = 0, fallos = 0;
const ok = (m) => { casos++; console.log(`✅ deudas-por-vencer: ${m}`); };
const no = (m) => { casos++; fallos++; console.log(`❌ deudas-por-vencer: ${m}`); };
const prueba = (m, fn) => { try { fn(); ok(m); } catch (e) { no(`${m} — ${e.message}`); } };

const HOY = Date.parse('2026-09-29T12:00:00Z');

/** Un repo del snapshot, con la declaración que le toque. */
const repo = (nombre, vence, paquetes, extra = {}) => ({
  producto: 'P', ruta: `X/${nombre}`, tipo: 'npm', medido: true,
  declaracion: vence === null ? { existe: false } : { existe: true, vence, paquetes },
  graves: [], no_declaradas: [], ...extra,
});

/** Corre evaluar+redactar sobre un snapshot de mentira y devuelve el texto. */
function texto(repos) {
  // `resumen` entregado a propósito: sin él, el hook calla el ✅ de «no hay nada esperando
  // decisión» (el verde no va al lado de un resumen que no llegó),
  // y los casos que comprueban ESE ✅ estarían midiendo otra cosa.
  const snap = { corrida_completa: true, repos, no_medidos: [], hallazgos: [],
                 resumen: { entregado_el: '2026-09-29T09:00:00Z' } };
  const fuente = {
    listar: () => ['dependencias-2026-09-29.json'],
    leer: () => JSON.stringify(snap),
    existe: () => true,
  };
  const v = H.evaluar({ outDir: '/x', pendingDir: '/y', ahora: HOY, fuente });
  return H.redactar(v) || '';
}

prueba('una deuda que vence en 2 días se anuncia, con repo, cuántas ampara y la fecha', () => {
  const t = texto([repo('Forms', '2026-10-01', 9)]);
  assert(/por vencer/.test(t), 'no dijo «por vencer»');
  assert(/P\/Forms \(9, 2026-10-01\), en 2 día/.test(t), `no nombró el repo, el número y la fecha:\n${t}`);
});

prueba('🔴 una deuda YA VENCIDA no se confunde con una por vencer: dice que el repo ya frena', () => {
  const t = texto([repo('Forms', '2026-09-20', 3)]);
  assert(/YA VENCIDA/.test(t), `no la marcó vencida:\n${t}`);
  assert(/frenan sus propios pull requests/.test(t), 'no dijo la consecuencia');
  assert(!/por vencer/.test(t), 'la contó además como por vencer');
});

prueba('🔴 una declaración VACÍA con fecha NO avisa (es el estado al que se llega al pagarla)', () => {
  const t = texto([repo('Forms', '2026-10-01', 0)]);
  assert(!/deuda/.test(t), `avisó por una declaración sin nada que amparar:\n${t}`);
  assert(/no hay nada esperando decisión/.test(t), 'debería salir el ✅ limpio');
});

prueba('🔴 una fecha ILEGIBLE se trata como vencida, no se ignora en silencio', () => {
  const t = texto([repo('Forms', 'cuando-se-pueda', 2)]);
  assert(/YA VENCIDA/.test(t), `una fecha ilegible pasó de largo:\n${t}`);
});

prueba('una deuda lejana no hace ruido, y el ✅ sale igual', () => {
  const t = texto([repo('Forms', '2026-12-31', 5)]);
  assert(!/deuda/.test(t), `avisó por una deuda a 93 días:\n${t}`);
  assert(/no hay nada esperando decisión/.test(t), 'se comió el ✅');
});

prueba('🔴 al lado de una deuda por vencer NO sale el ✅ de «no hay nada esperando decisión»', () => {
  const t = texto([repo('Forms', '2026-10-01', 9)]);
  assert(!/no hay nada esperando decisión/.test(t), `el verde tapa el aviso:\n${t}`);
});

prueba('un repo sin declaración no aporta nada', () => {
  const t = texto([repo('Forms', null, 0)]);
  assert(!/deuda/.test(t), `inventó una deuda donde no hay declaración:\n${t}`);
});

prueba('con muchas, se muestran las más urgentes primero y se dice cuántas quedan', () => {
  const t = texto([repo('A', '2026-10-10', 1), repo('B', '2026-09-30', 2), repo('C', '2026-10-05', 3)]);
  const i = t.indexOf('P/B'), j = t.indexOf('P/C');
  assert(i >= 0 && (j < 0 || i < j), `no ordenó por urgencia:\n${t}`);
  assert(/\+1 más/.test(t), `no dijo cuántas quedaban fuera:\n${t}`);
});

console.log(fallos === 0
  ? `✅ deudas-por-vencer: todo verde (${casos} casos)`
  : `❌ deudas-por-vencer: ${fallos} fallo(s) de ${casos}`);
process.exitCode = fallos === 0 ? 0 : 1;
