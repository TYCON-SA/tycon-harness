#!/usr/bin/env node
/**
 * check-artifact-paths.js — un pipeline no puede LEER de una carpeta que él nunca LLENA.
 *
 * 🔴 POR QUÉ EXISTE (2026-09-03 — guides/incident-log.md#case-artifact-read-from-empty-folder-2026-09-03). Los pipelines de producción de los plugins de dos productos del equipo bajan
 * su artefacto con `- download: ci`, que lo deja en `$(Pipeline.Workspace)/ci`. Nueve pasos de cada
 * archivo lo leen de ahí. UNO —justo el que sube el paquete al host— lo buscaba en
 * `$(System.ArtifactsDirectory)`, que en esos pipelines nadie llena. Resultado: el despliegue a
 * producción fallaba SIEMPRE, después de la aprobación humana y después de que el freno de retroceso
 * ya había interrogado al host. Cada intento quemaba una aprobación, y de los dos productos no salía
 * una sola versión a producción por ese camino.
 *
 * Quedó de una migración a medias: se actualizaron nueve referencias y ésta no. Es la SEGUNDA vez en
 * el mismo día que el mismo archivo muerde por lo mismo (antes fue la ruta del guion compartido), y
 * por eso esto es un control y no un arreglo más: lo que falla dos veces igual, falla una tercera.
 *
 * QUÉ MIRA, exactamente una cosa: si un archivo LEE de `$(System.ArtifactsDirectory)` sin que nada
 * en ese mismo archivo la LLENE. Se llena con `DownloadPipelineArtifact`/`DownloadBuildArtifact` con
 * `targetPath`/`downloadPath` apuntando ahí, o con `- download:` sin `path:` en un pipeline clásico.
 *
 * 🔴 QUÉ NO MIRA, a propósito: no juzga cuál de las dos carpetas es "la correcta" — las dos lo son,
 * según cómo baje el artefacto. Un pipeline que baja A `System.ArtifactsDirectory` y lee de ahí está
 * perfecto y no se marca. Marcar por nombre de variable sería ruido en los 19 pipelines.
 *
 * Salida: 0 sin hallazgos · 1 hay al menos uno · 2 no se pudo leer algún archivo (ilegible NO es
 * aprobado). Uso: check-artifact-paths.js <archivo.yml> [<archivo.yml>...]
 */
const fs = require('fs');

const LEE = /\$\(\s*System\.ArtifactsDirectory\s*\)/;
// La llena una bajada que apunte explícitamente ahí, o el `- download:` de un pipeline clásico
// (sin `path:`), que es el único caso en que ADO usa esa carpeta por defecto.
const LLENA = [
  /(?:targetPath|downloadPath)\s*:\s*['"]?\$\(\s*System\.ArtifactsDirectory\s*\)/,
  /ArtifactStagingDirectory.*\$\(\s*System\.ArtifactsDirectory\s*\)/,
];

let hallazgos = 0, ilegibles = 0;
const archivos = process.argv.slice(2);
if (!archivos.length) { console.log('uso: check-artifact-paths.js <archivo.yml> [...]'); process.exit(2); }

for (const f of archivos) {
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); }
  catch (e) { console.log(`🔴 ${f}: no se pudo leer (${e.message}) — ilegible NO es aprobado`); ilegibles++; continue; }

  const lineas = txt.split('\n');
  // Sólo código: un comentario que la nombre no es una lectura.
  const lecturas = lineas
    .map((l, i) => ({ n: i + 1, l }))
    .filter(({ l }) => LEE.test(l) && !/^\s*#/.test(l));
  if (!lecturas.length) continue;

  const laLlena = LLENA.some(r => r.test(txt));
  if (laLlena) continue;

  // ¿De dónde SÍ baja? Se lo decimos, para que el arreglo sea obvio.
  const m = txt.match(/(?:targetPath|downloadPath)\s*:\s*['"]?(\$\([A-Za-z.]+\)[^'"\s]*)/);
  const baja = m ? m[1] : (/^\s*-\s*download\s*:/m.test(txt) ? '$(Pipeline.Workspace)/<artefacto>' : null);

  console.log(`🔴 ${f}: lee de $(System.ArtifactsDirectory) y NADA en este archivo la llena`);
  for (const { n, l } of lecturas) console.log(`     línea ${n}: ${l.trim().slice(0, 110)}`);
  if (baja) console.log(`     el artefacto de este pipeline baja a: ${baja}`);
  console.log('     → esa carpeta queda VACÍA en la corrida: el paso no encuentra nada y falla, o peor, sigue con la ruta vacía');
  hallazgos += lecturas.length;
}

const total = archivos.length;
if (ilegibles) { console.log(`\n🔴 ${ilegibles} archivo(s) ilegible(s), sobre ${total}`); process.exit(2); }
if (hallazgos) { console.log(`\n🔴 ${hallazgos} lectura(s) de una carpeta que nadie llena, sobre ${total} pipeline(s)`); process.exit(1); }
console.log(`✅ rutas de artefacto: ${total} pipeline(s), ninguno lee de una carpeta que no llene`);
process.exit(0);
