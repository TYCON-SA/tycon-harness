#!/usr/bin/env node
'use strict';
/**
 * ¿Algún paso ESCRIBE EN EL REPOSITORIO o PUBLICA UN ARTEFACTO sin exigir que lo anterior haya salido bien?
 *
 * 🔴 POR QUÉ EXISTE (2026-09-02).
 *
 * En Azure DevOps, un `condition:` explícito **reemplaza** al `succeeded()` implícito. Es la misma
 * trampa que el arnés ya cerró para las ETAPAS (`check-stage-dependencies.js`) — pero ese
 * control mira etapas y jobs, no pasos, a propósito.
 *
 * Medido ese día en los cinco pipelines de formularios: el paso que commitea y sube el número de
 * versión nuevo tiene condición explícita, y en **cuatro de los cinco** esa condición NO incluye
 * `succeeded()`. Consecuencia: si la construcción de los formularios falla, el paso que arma los
 * paquetes se saltea (ése sí la tiene) pero el commit `chore: update form versions [skip ci]`
 * **entra a la rama principal igual**. Tres daños encadenados:
 *
 *   1. la rama principal dice que se publicó una versión que no existe;
 *   2. ese commit es la BASE del próximo cálculo de versiones;
 *   3. al re-correr, el envío queda rechazado y hace falta una corrida manual — que sube la
 *      versión de TODOS los formularios.
 *
 * 🔴 ALCANCE: pasos que **escriben en el repositorio** (git commit/push/tag) y, desde el
 * 2026-09-03, pasos que **publican un artefacto** (PublishPipelineArtifact / PublishBuildArtifacts).
 * Nació acotado al primero A PROPÓSITO: los cinco pipelines de formularios publicaban sus ZIP sin
 * la cláusula y eso estaba declarado como deuda con fecha — un control que nace rojo por diez
 * hallazgos que el plan excluye es un control que se apaga, y se lleva puestos los casos donde sí
 * importaba. Ese mismo día se arreglaron los cinco (`and(succeeded(), …)` en Prepare y Publish),
 * así que el alcance se amplió SIN nacer rojo: medido sobre los 14 pipelines publicados, cero
 * hallazgos; sobre la evidencia congelada del 2026-09-02, 4 commits + 5 publicaciones (caso 8).
 * Copiar o empaquetar NO es publicar: el alcance es lo que SALE del pipeline (el paquete o el
 * commit), no los pasos intermedios.
 *
 * Uso:  check-conditional-writes.js <pipeline.yml> [...]
 * Salida: 0 todos exigen éxito · 1 alguno no · 2 no se pudo mirar (que NO es "está bien").
 */
const fs = require('fs');

const ESCRIBE = /\bgit\s+(commit|push|tag)\b/;
const PUBLICA = /\b(PublishPipelineArtifact|PublishBuildArtifacts)@/;
const SALE = new RegExp(`${ESCRIBE.source}|${PUBLICA.source}`);
// `always()` y `failed()` son deliberados: un paso que corre siempre no está "olvidándose" de la
// cláusula, la está contradiciendo a propósito (publicar un informe, limpiar). No se marcan.
const DELIBERADO = /\b(always|failed|canceled)\s*\(/;

/**
 * Devuelve los pasos que escriben en el repositorio y su condición.
 * El YAML se lee por indentación, no con un parser: los pipelines tienen scripts embebidos con
 * `|` que un parser normaliza y que acá hay que leer literalmente.
 */
function pasosQueEscriben(texto) {
  const lineas = texto.split('\n');
  const pasos = [];
  let actual = null;

  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    const inicio = /^(\s*)-\s+(task|script|bash|pwsh|powershell|checkout):(.*)$/.exec(l);
    if (inicio) {
      if (actual) pasos.push(actual);
      // 🔴 El resto de la línea de arranque ES cuerpo. Un guion en una sola línea
      // (`- script: git push origin main`) tiene el comando ahí y en ninguna otra parte:
      // saltearla dejaba pasar exactamente esa forma. Lo cazaron los casos 6 de la suite.
      actual = { indent: inicio[1].length, linea: i + 1, nombre: null, condicion: null, cuerpo: [inicio[3] || ''] };
      continue;
    }
    if (!actual) continue;
    const sangria = /^(\s*)\S/.exec(l);
    // Una línea con menos sangría que el guion del paso cierra el paso (salvo vacías).
    if (sangria && sangria[1].length <= actual.indent && l.trim() !== '') {
      pasos.push(actual); actual = null;
      i--; continue;
    }
    const dn = /^\s*displayName:\s*['"]?(.+?)['"]?\s*$/.exec(l);
    if (dn && !actual.nombre) { actual.nombre = dn[1]; continue; }
    const cond = /^\s*condition:\s*(.+?)\s*$/.exec(l);
    if (cond && actual.condicion === null) { actual.condicion = cond[1]; continue; }
    actual.cuerpo.push(l);
  }
  if (actual) pasos.push(actual);

  return pasos
    .filter((p) => SALE.test(p.cuerpo.join('\n')))
    .map((p) => ({ ...p, verbo: ESCRIBE.test(p.cuerpo.join('\n')) ? 'escribe en el repositorio' : 'publica un artefacto' }));
}

function revisar(archivo) {
  let texto;
  try { texto = fs.readFileSync(archivo, 'utf8'); }
  catch (e) { return { archivo, fatal: `no pude leer: ${e.message}` }; }
  const hallazgos = [];
  for (const p of pasosQueEscriben(texto)) {
    // Sin `condition:` rige el `succeeded()` implícito: correcto por default, no es hallazgo.
    if (p.condicion === null) continue;
    if (DELIBERADO.test(p.condicion)) continue;
    if (/\bsucceeded\s*\(/.test(p.condicion)) continue;
    hallazgos.push({
      linea: p.linea,
      verbo: p.verbo,
      nombre: p.nombre || '(sin rótulo)',
      condicion: p.condicion.length > 96 ? `${p.condicion.slice(0, 96)}…` : p.condicion,
    });
  }
  return { archivo, hallazgos };
}

function main(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log('uso: check-conditional-writes.js <pipeline.yml> [...]');
    return argv.length ? 0 : 2;
  }
  let malos = 0, fatales = 0, mirados = 0;
  for (const f of argv) {
    const r = revisar(f);
    if (r.fatal) { console.log(`  🔴 ${f}: ${r.fatal}`); fatales++; continue; }
    mirados++;
    if (!r.hallazgos.length) continue;
    malos++;
    console.log(`  🔴 ${f}`);
    for (const h of r.hallazgos) {
      console.log(`       línea ${h.linea} · «${h.nombre}» ${h.verbo} con condición propia y SIN succeeded()`);
      console.log(`         ${h.condicion}`);
    }
  }
  console.log('');
  if (fatales) { console.log(`🔴 ${fatales} archivo(s) que no se pudieron leer — eso NO es "está bien"`); return 2; }
  if (malos) {
    console.log(`🔴 ${malos} pipeline(s) commitean o publican aunque lo anterior haya fallado, sobre ${mirados}.`);
    console.log('   Una `condition:` explícita REEMPLAZA al succeeded() implícito: hay que nombrarlo.');
    return 1;
  }
  console.log(`✅ escrituras condicionadas: ${mirados} pipeline(s), ninguno escribe en el repositorio ni publica con lo anterior en rojo`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { pasosQueEscriben, revisar };
