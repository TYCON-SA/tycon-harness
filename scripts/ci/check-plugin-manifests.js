#!/usr/bin/env node
'use strict';
/**
 * ¿Los dos manifiestos de un plugin dicen lo mismo, y el que viaja habilita lo que el paquete lleva?
 *
 * 🔴 POR QUÉ EXISTE.
 *
 * Un plugin Bizuit tiene DOS manifiestos con roles distintos:
 *   · `plugin.json.example` — el CANÓNICO. Es el que el pipeline copia encima del real para sacar
 *     credenciales, así que es el que viaja DENTRO del paquete y el único que el host lee.
 *     Lleva además el bloque `defaultSettings` con la configuración del plugin (entre 5 y 72
 *     opciones según el producto), que el real no tiene, a propósito.
 *   · `plugin.json` — el del repositorio. Sólo metadatos. Es el que una persona edita cuando
 *     agrega una bandera nueva, y el que el bot reescribe al subir la versión.
 *
 * NADA obligaba a que la parte común —los metadatos— coincidiera. Quien agrega una bandera la pone
 * en uno y se olvida del otro, y no hay error: hay SILENCIO. Por ejemplo:
 *
 *   · `hasSignalRHubs` — sin ese campo el host no inyecta el resolver de hubs y el tiempo real
 *     queda sin mapear, sin un solo mensaje.
 *   · `relayHubsOnly` — sin él, el plugin vuelve a cargar de otra manera, también en silencio.
 *   · `migrations` — si la bandera se agrega al `plugin.json` y no al `example`, que es el que
 *     viaja, el flujo de migraciones administradas queda INERTE: el host nunca mira la carpeta
 *     `migrations/` del ZIP. Todo verde.
 *
 * Agregar el campo de nuevo arregla un caso y deja abierto el siguiente. Este control cierra la
 * puerta en vez de la clave.
 *
 * 🔴 COMPARA CLAVES **Y VALORES**, no sólo claves. `"migrations": {"enabled": false}` en un archivo
 * y `true` en el otro pasa cualquier comparación por nombre, y el paquete viaja con el valor del
 * ejemplo: el mismo agujero, en verde. Las dos únicas diferencias legítimas son `defaultSettings`
 * (vive sólo en el ejemplo) y `version` (el bot la mueve en el real).
 *
 * 🔴 Y VERIFICA LA SEGUNDA MITAD: si el paquete lleva migraciones, el manifiesto que viaja tiene
 * que declararlas — las DOS banderas que el host exige juntas (`requiresDatabase` y
 * `migrations.enabled`), no una. Sin esto, un paquete con SQL adentro se despliega, el host
 * informa "sin migraciones pendientes" y la base queda sin tocar, en verde.
 *
 * LÍMITE DECLARADO, no promesa: un piso `firstManagedMigration` mal puesto (por encima del último
 * archivo) hace que viajen CERO migraciones, y eso es indistinguible de "este plugin no tiene
 * migraciones". El control no lo detecta y no finge detectarlo.
 *
 * Uso:
 *   check-plugin-manifests.js --repo <ruta>              # un plugin
 *   check-plugin-manifests.js --repo <ruta> --migrations <n>    # además, n archivos van al ZIP
 *   check-plugin-manifests.js --pairs <dir>              # pares <nombre>.plugin.json[.example]
 *
 * Salida: 0 coinciden · 1 divergen · 2 no se pudo mirar (que NO es "coinciden").
 */
const fs = require('fs');
const path = require('path');
// Las opciones renombradas a inglés: los pipelines de los productos siguen pasando las viejas
// hasta el retiro. El traductor vive al lado y viaja con este archivo en el artefacto arnes-ci.
const { aliasLegacyOptions, LegacyOptionsError } = (() => {
  try { return require('./legacy-options.js'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') process.stderr.write(`⚠️  legacy-options.js no cargó (${e && e.message}): los nombres viejos de este guion no se traducen\n`); return { aliasLegacyOptions: (argv) => argv, LegacyOptionsError: Error }; }
})();

const SOLO_EN_EL_EJEMPLO = new Set(['defaultSettings']);
const PUEDE_DIFERIR = new Set(['version']);

function leerJson(f) {
  const crudo = fs.readFileSync(f, 'utf8');
  return JSON.parse(crudo);
}

/** Compara los metadatos de los dos manifiestos. Devuelve la lista de problemas (vacía = coinciden). */
function compararManifiestos(real, ejemplo) {
  const problemas = [];
  const claves = new Set([...Object.keys(real), ...Object.keys(ejemplo)]);
  for (const k of claves) {
    if (SOLO_EN_EL_EJEMPLO.has(k)) {
      if (k in real && Object.keys(real[k] || {}).length > 0) {
        problemas.push(`\`${k}\` tiene contenido en plugin.json; vive sólo en el ejemplo`);
      }
      continue;
    }
    const enReal = k in real, enEjemplo = k in ejemplo;
    if (enReal && !enEjemplo) { problemas.push(`\`${k}\` está en plugin.json y NO en el ejemplo — el ejemplo es el que VIAJA, así que esto no llega al host`); continue; }
    if (!enReal && enEjemplo) { problemas.push(`\`${k}\` está en el ejemplo y NO en plugin.json — quien edite el real no lo va a ver`); continue; }
    if (PUEDE_DIFERIR.has(k)) continue;
    const a = JSON.stringify(real[k]), b = JSON.stringify(ejemplo[k]);
    if (a !== b) problemas.push(`\`${k}\` difiere: plugin.json=${a} · ejemplo=${b} — viaja el del ejemplo`);
  }
  return problemas;
}

/** El manifiesto que viaja, ¿habilita las migraciones que el paquete lleva? */
function compararMigraciones(ejemplo, cuantas) {
  if (cuantas === null) return [];
  const declara = ejemplo.requiresDatabase === true
    && !!ejemplo.migrations && ejemplo.migrations.enabled === true;
  if (cuantas > 0 && !declara) {
    return [`el paquete lleva ${cuantas} migración(es) y el manifiesto que viaja NO las declara `
      + `(requiresDatabase=${JSON.stringify(ejemplo.requiresDatabase)}, `
      + `migrations=${JSON.stringify(ejemplo.migrations)}) — el host las ignora y el despliegue `
      + `dice "sin migraciones pendientes", en verde`];
  }
  return [];
}

function unPar(nombre, fReal, fEjemplo, cuantas) {
  let real, ejemplo;
  try { real = leerJson(fReal); }
  catch (e) { return { nombre, fatal: `no pude leer ${fReal}: ${e.message}` }; }
  try { ejemplo = leerJson(fEjemplo); }
  catch (e) { return { nombre, fatal: `no pude leer ${fEjemplo}: ${e.message}` }; }
  return { nombre, problemas: [...compararManifiestos(real, ejemplo), ...compararMigraciones(ejemplo, cuantas)] };
}

function main(argv0) {
  const o = { repo: null, pares: null, migraciones: null };
  let argv;
  try { argv = aliasLegacyOptions(argv0, 'pares:pairs migraciones:migrations', 'scripts/ci/check-plugin-manifests.js'); }
  catch (e) { if (e instanceof LegacyOptionsError) { console.log(`🔴 ${e.message}`); return 2; } throw e; }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') o.repo = argv[++i];
    else if (argv[i] === '--pairs') o.pares = argv[++i];
    else if (argv[i] === '--migrations') o.migraciones = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('uso: --repo <ruta> [--migrations <n>]  |  --pairs <dir>');
      return 0;
    } else { console.log(`🔴 argumento desconocido: ${argv[i]}`); return 2; }
  }
  if (o.migraciones !== null && !Number.isFinite(o.migraciones)) {
    console.log('🔴 --migrations necesita un número'); return 2;
  }

  const casos = [];
  if (o.repo) {
    casos.push([path.basename(path.resolve(o.repo)),
      path.join(o.repo, 'plugin.json'), path.join(o.repo, 'plugin.json.example'), o.migraciones]);
  } else if (o.pares) {
    let archivos;
    try { archivos = fs.readdirSync(o.pares); }
    catch (e) { console.log(`🔴 no pude leer ${o.pares}: ${e.message}`); return 2; }
    const bases = archivos.filter((f) => f.endsWith('.plugin.json')).map((f) => f.slice(0, -'.plugin.json'.length));
    if (!bases.length) { console.log(`🔴 no hay ningún par <nombre>.plugin.json en ${o.pares} — "no encontré nada" no es "coinciden"`); return 2; }
    for (const b of bases.sort()) {
      casos.push([b, path.join(o.pares, `${b}.plugin.json`), path.join(o.pares, `${b}.plugin.json.example`), o.migraciones]);
    }
  } else { console.log('🔴 falta --repo o --pairs'); return 2; }

  let divergen = 0, fatales = 0;
  for (const [n, a, b, m] of casos) {
    const r = unPar(n, a, b, m);
    if (r.fatal) { console.log(`  🔴 ${n}: ${r.fatal}`); fatales++; continue; }
    if (!r.problemas.length) { console.log(`  ✅ ${n}`); continue; }
    divergen++;
    console.log(`  🔴 ${n}`);
    for (const p of r.problemas) console.log(`       ${p}`);
  }
  console.log('');
  if (fatales) { console.log(`🔴 ${fatales} manifiesto(s) que no se pudieron leer — eso NO es "coinciden"`); return 2; }
  if (divergen) {
    console.log(`🔴 ${divergen} plugin(s) con los dos manifiestos separados, sobre ${casos.length}.`);
    console.log('   El que viaja dentro del paquete es el `.example`: lo que no esté ahí, no llega al host.');
    return 1;
  }
  console.log(`✅ manifiestos: ${casos.length} plugin(s), los dos manifiestos dicen lo mismo`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { compararManifiestos, compararMigraciones };
