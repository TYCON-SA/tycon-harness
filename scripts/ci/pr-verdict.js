#!/usr/bin/env node
/**
 * pr-verdict.js — ¿lo que salió rojo en este pull request YA estaba rojo en main? (2026-09-17)
 *
 * 🔴 POR QUÉ EXISTE. La validación de un pull request del arnés corre el banco de controles y las
 * suites de prueba. Si el veredicto fuera «cero rojos o no entra», la política habría frenado el
 * 100 % de los pull requests durante 11 días seguidos: `publish-bump.test.sh` está roja en el
 * nocturno desde el 7/9 por una causa de ENTORNO de Azure que no se reproduce en local (medido en
 * la etapa 0 del plan: 0 rojos con clones frescos). Un freno que muerde por algo que el cambio no
 * hizo es un freno que se apaga en una semana — y se lleva puestos los casos donde sí importaba.
 *
 * Entonces el veredicto se da CONTRA LA ÚLTIMA FOTO NOCTURNA, que viaja commiteada en main
 * (`scripts/controls-bench/ultimo-suites.json` y `ultimo-banco.json`):
 *   · un rojo que YA estaba rojo en la foto        → AVISO (la corrida sigue verde)
 *   · un rojo que NO está en la foto               → FRENA (exit 1): eso lo trajo este cambio
 *   · un NO MEDIDO                                 → AVISO, nunca frena: no dice que el control ande
 *                                                    ni que esté roto (mismo balde que el nocturno)
 * Es la misma idea que el `--baseline check` del propio banco, aplicada también a las suites.
 *
 * 🔴 Las dos formas de «no saber» NO son la misma cosa, y por eso se resuelven distinto:
 *   · la FOTO no se puede leer (falta, JSON roto) → exit 2, «no pude decidir: sin foto», haya rojos o no
 *     (story 8.26, tanda C, AC 43). Hasta esa tanda todo rojo contaba como nuevo y frenaba, y sin rojos
 *     salía verde: con la validación sobre el repo público la foto viene de afuera (donde la deja el
 *     nocturno), y que no haya llegado no puede ser ni un freno con el motivo equivocado ni un verde en
 *     blanco. La validación pasa las rutas siempre (`--suites-snapshot`, `--bench-snapshot`).
 *   · la foto se pudo leer pero está VIEJA (más de 2 días) → se usa igual, con un aviso que dice la
 *     edad. Sí midió; lo viejo es la lista de excusas, y lo único que puede tapar es un rojo que ya
 *     estaba rojo. Frenar todos los pull requests porque el nocturno se cayó es la misma enfermedad
 *     que esta pieza viene a evitar, y que el nocturno se detuvo ya lo grita el arranque de sesión.
 *   · el reporte de ESTA corrida no se puede leer → exit 2: no se midió, y «no medido» no es verde.
 *   · el reporte de ESTA corrida trae suites NO MEDIDAS (`unmeasured`: un trabajo de suites no terminó, 2026-10-04; o la
 *     suite pasó su tope, story 8.22 tramo D)
 *     → no son un rojo que trajo el cambio ni un verde: se nombran aparte y, si nada frena, exit 2 —también en
 *     modo aviso—. Un rojo nuevo que frena sigue mandando: exit 1.
 *   · una suite que NO CORRIÓ porque el cambio no toca lo que mide (`notRun`, de suites-report.js; las dos más largas
 *     por scripts/ci/heavy-suites.json) → se lista como «no corrió: el cambio no toca lo que mide» y no cuenta como
 *     roja nueva, ni como «ya estaba roja», ni como verde.
 *   · una suite que NO VIAJA (`notTravelling`, de suites-report.js: está en la foto y en ningún registro del árbol; con
 *     el repo público como propio, las del repo de mantenimiento) → «no corrió: no viaja», contada aparte. Story 8.26,
 *     tanda C, AC 11.
 *
 * 🔴 `--public-notices` (story 8.26, tanda C, AC 45): con un repo de GitHub como propio, lo que la corrida escribe como
 * aviso de Azure llega al control del pedido, que es público. Con la bandera, cada aviso lleva un texto fijo y cuentas, y
 * el nombre y el motivo van en la línea de abajo (registro común, que sólo ve quien tiene permiso en Azure). Sin ella (la
 * validación del interno), los avisos nombran como siempre.
 *
 * 🔴 Lo que se imprime pasa por `saneadoParaAzure`: Azure interpreta `##vso[…]` en CUALQUIER línea
 * de la consola del paso, y el motivo de una suite roja es texto libre capturado de la salida del
 * test. Un motivo con `##vso[task.setvariable…]` adentro fijaría variables de la corrida.
 *
 * Uso:
 *   node scripts/ci/pr-verdict.js --suites-actual <json> --current-bench <json> \
 *        [--suites-snapshot <json>] [--bench-snapshot <json>] [--baseline <json>] [--suites-warn] [--ado] [--json]
 *   Al menos uno de --suites-actual / --current-bench. Las fotos y la baseline tienen default:
 *   los archivos del propio repo (--tcg cambia la raíz).
 *   (--current-bench, --suites-snapshot, --bench-snapshot y --suites-warn tenían nombre en castellano hasta la
 *   story 8.9, tanda B3a; los viejos siguen andando hasta el retiro. La vieja y la nueva juntas salen 2.)
 *
 * 🔴 `--suites-warn` (decisión del dev, 2026-09-17, mientras dure la Etapa 3 del plan): un rojo
 * NUEVO de una SUITE avisa y no frena; sólo frena el banco. Motivo medido en las corridas 10569 y
 * 10570: dos suites verdes en la máquina del dev salieron rojas en el agente de Azure, y NO fueron
 * las mismas en las dos corridas. Con 116 suites, aun poca intermitencia deja casi todo pull request
 * en rojo por algo que el cambio no hizo — la misma enfermedad que este guion existe para evitar, un
 * piso más abajo. La bandera es TEMPORAL y se saca cuando la Etapa 3 mida la tasa: el reporte de cada
 * corrida anota las dos pasadas de cada suite roja (`reintentos`) justamente para poder decidirlo.
 * El rojo del banco NO se reintenta y sigue frenando.
 *
 * Salida: 0 midió y no hay rojo NUEVO que frene (puede haber avisos) · 1 hay rojo nuevo · 2 no pude decidir.
 * Casos: scripts/tests/pr-verdict.test.sh
 */
'use strict';
const fs = require('fs');
const path = require('path');

// Mismo número que usa el aviso de arranque para declarar que el nocturno se detuvo, y a propósito
// una constante propia: allá decide «¿muestro estos números o los callo?» y acá «¿esta foto sirve
// todavía como lista de excusas?». Son dos preguntas distintas sobre el mismo archivo; si algún día
// una cambia, la otra no tiene por qué seguirla.
const FOTO_VIEJA_MS = 2 * 24 * 60 * 60 * 1000;

// Las opciones renombradas a inglés (story 8.9, tanda B3a): el traductor vive al lado y viaja con este archivo en el
// artefacto arnes-ci. Se traduce SÓLO en la línea de comandos (main), nunca al cargar el módulo.
const { aliasLegacyOptions, LegacyOptionsError } = (() => {
  try { return require('./legacy-options.js'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') process.stderr.write(`⚠️  legacy-options.js no cargó (${e && e.message}): los nombres viejos de este guion no se traducen\n`); return { aliasLegacyOptions: (argv) => argv, LegacyOptionsError: Error }; }
})();
let args = process.argv.slice(2);
const opcion = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TCG = path.resolve(opcion('--tcg', path.join(__dirname, '..', '..')));
const ADO = args.includes('--ado');
const PUBLICO = args.includes('--public-notices');
let SUITES_AVISAN = false;

/** Azure lee `##vso[…]` en cualquier línea: el texto de afuera entra en una sola línea y sin `#`. */
const saneadoParaAzure = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/#/g, '♯').slice(0, 400);

function leerJson(ruta) {
  try { return { ok: true, datos: JSON.parse(fs.readFileSync(ruta, 'utf8')) }; }
  catch (e) { return { ok: false, motivo: e.code === 'ENOENT' ? 'no está' : `ilegible (${e.message})` }; }
}

// ── Los nombres renombrados (story 8.9, tanda C1, AC 33) ────────────────────────────────────────
// La clave de un caso del banco lleva el nombre de su script (`<script>::<id>`) y la de una suite es
// el nombre de su archivo: un renombre cambia la clave, y un rojo viejo con la clave nueva se leería
// como nuevo. Las dos fotos y la baseline pasan por el MISMO mapa (scripts/lib/renames.json) antes de
// comparar. Sin el mapa —la copia pública, el artefacto arnes-ci— no hay nada que unir; un mapa que
// está y no se deja leer se dice, porque sin él un renombre reciente puede dar rojos nuevos falsos.
function cargarRenombres(avisos) {
  let ln;
  try { ln = require(path.join(TCG, 'scripts', 'lib', 'legacy-names.js')); }
  catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return new Map();
    avisos.push(`no pude cargar legacy-names.js (${e && e.message}) — los nombres renombrados no se unen: un rojo viejo de un script renombrado puede salir como nuevo`);
    return new Map();
  }
  const ruta = path.join(TCG, 'scripts', 'lib', 'renames.json');
  const m = leerJson(ruta);
  if (!m.ok) {
    if (m.motivo !== 'no está') avisos.push(`el mapa de renombres está ${m.motivo} — los nombres renombrados no se unen: un rojo viejo de un script renombrado puede salir como nuevo`);
    return new Map();
  }
  return ln.basenameRenames(m.datos);
}
const conClaves = (obj, f) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [f(k), v]));
/** Un reporte del banco (o la baseline) con las claves de sus casos en el nombre nuevo. */
function bancoUnido(rep, renombres) {
  if (!renombres.size || !rep || typeof rep !== 'object') return rep;
  const ln = require(path.join(TCG, 'scripts', 'lib', 'legacy-names.js'));
  const f = (k) => ln.renameKey(k, renombres);
  const out = { ...rep };
  if (rep.results && typeof rep.results === 'object') out.results = conClaves(rep.results, f);
  if (rep.cases && typeof rep.cases === 'object') out.cases = conClaves(rep.cases, f);
  return out;
}
/** Un reporte de suites con los nombres de sus suites en el nombre nuevo. */
function suitesUnidas(rep, renombres) {
  if (!renombres.size || !rep || typeof rep !== 'object') return rep;
  const ln = require(path.join(TCG, 'scripts', 'lib', 'legacy-names.js'));
  const f = (k) => ln.renameKey(k, renombres);
  const out = { ...rep };
  if (Array.isArray(rep.failures)) out.failures = rep.failures.map(f);
  if (Array.isArray(rep.unmeasured)) out.unmeasured = rep.unmeasured.map(f);
  for (const k of ['motivos', 'reintentos']) if (rep[k] && typeof rep[k] === 'object') out[k] = conClaves(rep[k], f);
  return out;
}

/** Edad de una foto, en días; `null` si la fecha no se puede leer (que cuenta como vieja). */
function edadDias(rep) {
  const t = rep && rep.ts ? Date.parse(rep.ts) : NaN;
  return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}
const fotoVieja = (rep) => {
  const t = rep && rep.ts ? Date.parse(rep.ts) : NaN;
  return isNaN(t) || (Date.now() - t) > FOTO_VIEJA_MS;
};

// ── El conjunto de rojos de un reporte del BANCO ────────────────────────────────────────────────
// Se deriva de `results`, que es lo que el runner deja escrito, con la MISMA regla que él usa:
//   · rojo por caso+herramienta   (`pass: false`, sin `nomedido`)
//   · paridad rota                (claude y codex difieren, ninguno salteado)
//   · regresión contra la baseline (era verde en la baseline y ahora es rojo, o desapareció)
// La identidad lleva la herramienta adentro: un caso rojo en codex y verde en claude no es el mismo
// hecho que el inverso, y el nocturno puede tener uno sin el otro.
function rojosDelBanco(rep, baseline) {
  const rojos = new Map();   // id → texto para el humano
  const nomedidos = [];
  const results = (rep && rep.results && typeof rep.results === 'object') ? rep.results : {};
  for (const [caso, r] of Object.entries(results)) {
    const tools = (r && r.tools) || {};
    for (const [t, x] of Object.entries(tools)) {
      if (!x || x.skipped) continue;
      if (x.nomedido) { nomedidos.push(`${caso} [${t}]`); continue; }
      if (x.pass === false) rojos.set(`rojo:${caso}::${t}`, `${caso} [${t}]${x.failures && x.failures.length ? ` — ${x.failures.join(' | ')}` : ''}`);
    }
    const a = tools.claude, b = tools.codex;
    if (a && b && !a.skipped && !b.skipped && !a.nomedido && !b.nomedido && a.pass !== b.pass) {
      rojos.set(`paridad:${caso}`, `paridad rota en ${caso}: claude=${a.pass ? 'verde' : 'rojo'} codex=${b.pass ? 'verde' : 'rojo'}`);
    }
  }
  // La baseline se lee UNA vez (la del checkout) y se aplica a las dos fotos, para que la
  // comparación sea entre iguales. Sin baseline no se derivan regresiones y se dice.
  if (baseline && baseline.cases) {
    for (const [caso, eraVerde] of Object.entries(baseline.cases)) {
      const ahora = results[caso] && results[caso].tools && results[caso].tools.claude;
      if (eraVerde && ahora && !ahora.skipped && !ahora.nomedido && ahora.pass === false) {
        rojos.set(`regresion:${caso}`, `regresión contra la baseline: ${caso} era verde`);
      }
      if (!ahora) rojos.set(`desaparecido:${caso}`, `caso de la baseline DESAPARECIÓ: ${caso}`);
    }
  }
  return { rojos, nomedidos };
}

/** Las entradas de `failures` que el reporte declara NO MEDIDAS (`unmeasured`, de suites-report.js). */
function noMedidasDeSuites(rep) {
  const nombres = Array.isArray(rep && rep.failures) ? rep.failures : [];
  return Array.isArray(rep && rep.unmeasured) ? nombres.filter((n) => rep.unmeasured.includes(n)) : [];
}

/**
 * El conjunto de rojos de un reporte de SUITES: la lista de nombres que ya escribe suites-report.js.
 * `sinNoMedidas`: una suite que no se midió (un trabajo de suites no terminó) no estaba roja —no se sabe cómo estaba—.
 * En la FOTO, así no excusa un rojo de hoy. En el reporte de ESTA corrida tampoco es un «rojo nuevo»: se cuenta aparte
 * (`suitesSinMedir`) y el veredicto sale 2, porque no medido no es verde.
 */
function rojosDeSuites(rep, { sinNoMedidas = false } = {}) {
  const rojos = new Map();
  const nombres = Array.isArray(rep && rep.failures) ? rep.failures : [];
  const motivos = (rep && rep.motivos && typeof rep.motivos === 'object') ? rep.motivos : {};
  const fuera = new Set(sinNoMedidas ? noMedidasDeSuites(rep) : []);
  for (const n of nombres) if (!fuera.has(n)) rojos.set(`suite:${n}`, `${n}${motivos[n] ? ` (${motivos[n]})` : ''}`);
  return rojos;
}

/**
 * Compara un conjunto de rojos contra el de la foto.
 * `fotoLeida === false` ⇒ no hay lista de excusas: todo rojo es nuevo.
 */
function comparar({ etiqueta, rojosAhora, rojosFoto, fotoLeida, motivoFoto, edad }) {
  const nuevos = [], viejos = [];
  for (const [id, texto] of rojosAhora) {
    if (fotoLeida && rojosFoto.has(id)) viejos.push(texto); else nuevos.push(texto);
  }
  const avisos = [];
  if (!fotoLeida) {
    avisos.push(`${etiqueta}: no pude leer la foto nocturna (${motivoFoto}) — sin ella no se distingue un rojo viejo de uno nuevo: no hay veredicto`);
  } else if (edad === null || edad >= 2) {
    avisos.push(`${etiqueta}: la foto nocturna es de hace ${edad === null ? '? (fecha ilegible)' : `${edad} día(s)`} — se usa igual, pero sólo puede tapar rojos que ya estaban rojos`);
  }
  return { nuevos, viejos, avisos };
}

function main() {
  try {
    args = aliasLegacyOptions(args, 'banco-actual:current-bench foto-banco:bench-snapshot foto-suites:suites-snapshot suites-avisan:suites-warn', 'scripts/ci/pr-verdict.js');
  } catch (e) {
    if (!(e instanceof LegacyOptionsError)) throw e;
    console.error(`⛔ veredicto — NO PUDE DECIDIR: ${e.message}`);
    return 2;
  }
  SUITES_AVISAN = args.includes('--suites-warn');
  const rutaSuitesAhora = opcion('--suites-actual');
  const rutaBancoAhora = opcion('--current-bench');
  if (!rutaSuitesAhora && !rutaBancoAhora) {
    console.error('⛔ veredicto — NO PUDE DECIDIR: no me pasaron ni --suites-actual ni --current-bench (no hay nada que juzgar)');
    return 2;
  }
  const fotoSuitesRuta = opcion('--suites-snapshot', path.join(TCG, 'scripts', 'controls-bench', 'ultimo-suites.json'));
  const fotoBancoRuta = opcion('--bench-snapshot', path.join(TCG, 'scripts', 'controls-bench', 'ultimo-banco.json'));
  const baselineRuta = opcion('--baseline', path.join(TCG, 'scripts', 'controls-bench', 'baseline', 'claude.json'));

  // `nuevos` frena; `nuevosQueAvisan` es lo mismo pero sin frenar (hoy, las suites).
  // `rojosSinFoto`: los rojos de una sección cuya foto no se leyó (no se sabe si son nuevos; la corrida sale 2).
  const salida = { nuevos: [], nuevosQueAvisan: [], viejos: [], avisos: [], nomedidos: [], intermitentes: [], suitesSinMedir: [], noCorrieron: [], noViajan: [], sinFoto: [], rojosSinFoto: [] };
  const renombres = cargarRenombres(salida.avisos);

  // ── suites ──
  if (rutaSuitesAhora) {
    const ahora = leerJson(rutaSuitesAhora);
    if (!ahora.ok) {
      console.error(`⛔ veredicto — NO PUDE DECIDIR: el reporte de suites de esta corrida ${ahora.motivo} (${rutaSuitesAhora}). No medido no es verde.`);
      return 2;
    }
    const foto = leerJson(fotoSuitesRuta);
    const fotoUnida = foto.ok ? suitesUnidas(foto.datos, renombres) : null;
    const ahoraUnida = suitesUnidas(ahora.datos, renombres);
    salida.suitesSinMedir.push(...noMedidasDeSuites(ahoraUnida));
    const notRun = (ahora.datos && ahora.datos.notRun && typeof ahora.datos.notRun === 'object' && !Array.isArray(ahora.datos.notRun)) ? ahora.datos.notRun : {};
    for (const [n, why] of Object.entries(notRun)) salida.noCorrieron.push(`${n} (${why})`);
    if (Array.isArray(ahora.datos && ahora.datos.notTravelling)) salida.noViajan.push(...ahora.datos.notTravelling.map(String));
    if (!foto.ok) salida.sinFoto.push('suites');
    const r = comparar({
      etiqueta: 'suites',
      rojosAhora: rojosDeSuites(ahoraUnida, { sinNoMedidas: true }),
      rojosFoto: foto.ok ? rojosDeSuites(fotoUnida, { sinNoMedidas: true }) : new Map(),
      fotoLeida: foto.ok,
      motivoFoto: foto.motivo,
      edad: foto.ok ? edadDias(foto.datos) : null,
    });
    // Sin foto de suites no se sabe qué es nuevo: sus rojos son rojos, no «nuevos» (AC 43), estén o no en modo aviso.
    (!foto.ok ? salida.rojosSinFoto : SUITES_AVISAN ? salida.nuevosQueAvisan : salida.nuevos).push(...r.nuevos.map((t) => `suite ${t}`));
    salida.viejos.push(...r.viejos.map((t) => `suite ${t}`));
    salida.avisos.push(...r.avisos);
    const sinMedir = foto.ok ? noMedidasDeSuites(fotoUnida).length : 0;
    if (sinMedir) salida.avisos.push(`suites: la foto nocturna quedó incompleta — ${sinMedir} suite(s) no se midieron anoche (un trabajo del nocturno no terminó): un rojo en ellas cuenta como NUEVO, no como «ya estaba rojo»`);
    if (SUITES_AVISAN) salida.avisos.push('suites: EN MODO AVISO (el interruptor del freno de suites está apagado) — un rojo nuevo de suite no frena; el banco sí. Las dos pasadas de cada suite roja quedan en el reporte (`reintentos`).');
    // Lo que el reintento distingue: `rojo→rojo` es una suite firme, `rojo→verde` una intermitente.
    const re = (ahora.datos && ahora.datos.reintentos && typeof ahora.datos.reintentos === 'object') ? ahora.datos.reintentos : {};
    for (const [n, x] of Object.entries(re)) {
      if (x && x.segunda === 'verde') salida.intermitentes.push(`${n} (roja en la 1ª pasada, verde en la 2ª)`);
    }
  }

  // ── banco ──
  if (rutaBancoAhora) {
    const ahora = leerJson(rutaBancoAhora);
    if (!ahora.ok) {
      console.error(`⛔ veredicto — NO PUDE DECIDIR: el reporte del banco de esta corrida ${ahora.motivo} (${rutaBancoAhora}). No medido no es verde.`);
      return 2;
    }
    const base = leerJson(baselineRuta);
    if (!base.ok) salida.avisos.push(`banco: no pude leer la baseline (${base.motivo}) — las regresiones contra ella no se juzgan en esta corrida`);
    const foto = leerJson(fotoBancoRuta);
    if (!foto.ok) salida.sinFoto.push('banco');
    const baseUnida = base.ok ? bancoUnido(base.datos, renombres) : null;
    const aq = rojosDelBanco(bancoUnido(ahora.datos, renombres), baseUnida);
    const r = comparar({
      etiqueta: 'banco',
      rojosAhora: aq.rojos,
      rojosFoto: foto.ok ? rojosDelBanco(bancoUnido(foto.datos, renombres), baseUnida).rojos : new Map(),
      fotoLeida: foto.ok,
      motivoFoto: foto.motivo,
      edad: foto.ok ? edadDias(foto.datos) : null,
    });
    (foto.ok ? salida.nuevos : salida.rojosSinFoto).push(...r.nuevos.map((t) => `banco ${t}`));
    salida.viejos.push(...r.viejos.map((t) => `banco ${t}`));
    salida.avisos.push(...r.avisos);
    salida.nomedidos.push(...aq.nomedidos);
  }

  if (args.includes('--json')) console.log(JSON.stringify(salida, null, 2));

  // Un aviso: en Azure, `##vso`; con `--public-notices`, el aviso lleva `fijo` (texto fijo y cuentas) y `completo` va en la
  // línea de abajo, sin `##vso` (story 8.26, tanda C, AC 45). En la terminal, con su icono.
  const aviso = (tipo, icono, completo, fijo) => {
    if (!ADO) { console.log(`${icono} ${completo}`); return; }
    if (PUBLICO) {
      console.log(`##vso[task.logissue type=${tipo}]${fijo}`);
      console.log(`   ${saneadoParaAzure(completo)}`);
      return;
    }
    console.log(`##vso[task.logissue type=${tipo}]${saneadoParaAzure(completo)}`);
  };
  const sinFoto = salida.sinFoto.length > 0;

  for (const a of salida.avisos) aviso('warning', '🟡', a, 'aviso del veredicto: el detalle, en el registro de la corrida');
  // No es un problema ni un verde: se dice, sin `##vso` (no ensucia la lista de avisos de la corrida).
  for (const n of salida.noCorrieron) console.log(`⏭ no corrió: el cambio no toca lo que mide — ${saneadoParaAzure(n)}`);
  for (const n of salida.noViajan) console.log(`⏭ no corrió: no viaja — ${saneadoParaAzure(n)} (es del repo de mantenimiento: corre en el nocturno)`);
  if (salida.nomedidos.length) {
    const m = `${salida.nomedidos.length} caso(s) NO MEDIDO(s) (se les agotó el tiempo): no son rojos, pero la corrida no está completa — ${salida.nomedidos.slice(0, 5).join(' · ')}`;
    aviso('warning', '🟡', m, `${salida.nomedidos.length} caso(s) del banco NO MEDIDO(s) (se les agotó el tiempo): los nombres, en el registro`);
  }
  for (const v of salida.viejos) aviso('warning', '🟡', `ya estaba rojo en main antes de este cambio: ${v}`, 'ya estaba rojo en main antes de este cambio: el nombre, en el registro');
  for (const n of salida.intermitentes) {
    aviso('warning', '🟠', `INTERMITENTE en el agente: ${n} — el reintento la vio verde, no es un veredicto`, 'INTERMITENTE en el agente (roja en la 1ª pasada, verde en la 2ª): el nombre, en el registro');
  }
  for (const n of salida.nuevosQueAvisan) {
    aviso('warning', '🟠', `ROJO NUEVO (no está en la foto nocturna): ${n} — en MODO AVISO: no frena`, 'ROJO NUEVO de suite, en MODO AVISO: no frena (el nombre, en el registro)');
  }
  // Sin la foto de una sección no se sabe qué es nuevo en ella: sus rojos se nombran como rojos, no como «nuevos» (AC 43);
  // los de la otra sección, cuya foto sí se leyó, siguen siendo nuevos o viejos (pase adversarial de la tanda C).
  for (const n of salida.rojosSinFoto) aviso('warning', '🟡', `rojo, sin foto para saber si ya estaba en main: ${n}`, 'rojo, sin foto para saber si ya estaba en main: el nombre, en el registro');
  for (const n of salida.nuevos) aviso('error', '🔴', `ROJO NUEVO (no está en la foto nocturna): ${n}`, 'ROJO NUEVO (no está en la foto nocturna): el nombre, en el registro');
  if (salida.suitesSinMedir.length) {
    const lista = salida.suitesSinMedir.slice(0, 5).join(' · ') + (salida.suitesSinMedir.length > 5 ? ' …' : '');
    // Story 8.22, tramo D: también llega no medida la suite que pasó su tope, desde un trabajo que sí terminó.
    const m = `${salida.suitesSinMedir.length} suite(s) NO SE MIDIERON en esta corrida (un trabajo de suites no terminó, o la suite pasó su tope: el motivo de cada una, en su salida): no son un rojo nuevo, pero tampoco un verde — ${lista}`;
    aviso('error', '⛔', m, `${salida.suitesSinMedir.length} suite(s) NO SE MIDIERON en esta corrida: no son un rojo nuevo, pero tampoco un verde (los nombres, en el registro)`);
  }

  const cola = `${salida.viejos.length} ya estaban rojos en main`
    + (salida.nuevosQueAvisan.length ? ` · ${salida.nuevosQueAvisan.length} rojo(s) nuevo(s) de suite EN MODO AVISO` : '')
    + (salida.intermitentes.length ? ` · ${salida.intermitentes.length} intermitente(s)` : '')
    + (salida.nomedidos.length ? ` · ${salida.nomedidos.length} no medido(s)` : '')
    + (salida.suitesSinMedir.length ? ` · ${salida.suitesSinMedir.length} suite(s) sin medir` : '')
    + (salida.noCorrieron.length ? ` · ${salida.noCorrieron.length} no ${salida.noCorrieron.length === 1 ? 'corrió' : 'corrieron'} (el cambio no toca lo que mide${salida.noCorrieron.length === 1 ? '' : 'n'})` : '')
    + (salida.noViajan.length ? ` · ${salida.noViajan.length} no ${salida.noViajan.length === 1 ? 'viaja' : 'viajan'} (corre${salida.noViajan.length === 1 ? '' : 'n'} en el nocturno)` : '');
  if (sinFoto) {
    console.log(`\n⛔ no pude decidir: sin foto nocturna de ${salida.sinFoto.join(' y ')} — sin ella no se distingue un rojo viejo de uno nuevo, y eso no es un verde. ${salida.rojosSinFoto.length} rojo(s) sin foto · ${salida.nuevos.length} rojo(s) nuevo(s) · ${cola}.`);
    return 2;
  }
  if (salida.nuevos.length) {
    console.log(`\n❌ ${salida.nuevos.length} rojo(s) NUEVO(s) que frenan — los trajo este cambio. ${cola}.`);
    return 1;
  }
  if (salida.suitesSinMedir.length) {
    console.log(`\n⛔ no pude decidir: ${salida.suitesSinMedir.length} suite(s) no se midieron, y no medido no es verde. ${cola}.`);
    return 2;
  }
  console.log(`\n✅ sin rojos nuevos que frenen · ${cola}.`);
  return 0;
}

// 🔴 `process.exitCode`, NO `process.exit()`: en Node las escrituras a una tubería son
// ASINCRÓNICAS y `process.exit()` mata el proceso con parte de lo escrito en el aire. Medido con
// la forma de este guión (una escritura grande y salir): a 41 KB llega cortado en 8192 y el JSON
// se rompe; el consumidor lo lee como «no pude», nunca como un error.
// Caso: guides/maintaining/incident-log.md#informe-cortado-por-la-tuberia-2026-09-28
if (require.main === module) process.exitCode = main();
module.exports = { rojosDelBanco, rojosDeSuites, comparar, saneadoParaAzure, FOTO_VIEJA_MS };
