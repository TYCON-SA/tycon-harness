#!/usr/bin/env node
/**
 * bench-notice.js — destino del reporte del controls-bench (Etapa B del plan codex-migration.md).
 *
 * Hook SessionStart (mismo mecanismo que los meters de estilo/bloqueo): si la ÚLTIMA corrida
 * del banco dejó rojos —casos fallados, paridad rota o regresiones vs la línea de base— lo
 * grita al arranque de sesión. El rojo se ve sin que nadie se acuerde de mirar; si todo está
 * verde, silencio total.
 *
 * Lee los reportes que escriben runner.js y live-fire.js en scripts/controls-bench/.bench/.
 * Fail-open completo: sin reportes, o reportes ilegibles → exit 0 mudo.
 * Opt-out: TYCON_BENCH_NOTICE=0
 */
'use strict';
const fs = require('fs');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
// Las variables renombradas a inglés (story 8.9): el nombre viejo sigue valiendo hasta el retiro. Sin la biblioteca al
// lado (el hook copiado a un arnés de mentira, como hace el banco): paso directo con el nombre nuevo, fail-open.
// Lo mismo con el sello del examen renombrado en la tanda D2: el nombre nuevo y, si falta, el viejo.
const { leerVariable, leerEstado } = (() => {
  try {
    const { readEnv, resolveFile } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));
    return {
      leerVariable: (n) => readEnv(n, { where: 'scripts/hooks/bench-notice.js' }),
      // leer nunca rompe: con el mapa ilegible o un sello que no se deja mirar, el nombre nuevo — dicho, no callado
      leerEstado: (p) => {
        try { return resolveFile(p, { where: 'scripts/hooks/bench-notice.js' }); } catch (e) {
          process.stderr.write(`⚠️  aviso del banco: ${(e && e.message) || e} — se lee ${p}\n`);
          return p;
        }
      },
    };
  } catch (_) { return { leerVariable: (n) => process.env[n], leerEstado: (p) => p }; }
})();

if (process.env.TYCON_BENCH_NOTICE === '0' || process.env.TYCON_EVAL_SANDBOX === '1') process.exit(0);

// ── nocturnos (story 8.3, AC 9 — la octava integración) ─────────────────────────────────────────
// «Esta máquina espera los resultados de los procesos nocturnos del equipo». Apagada (sin perfil del equipo ni
// llave), el banco NOCTURNO y las suites NOCTURNAS detenidos no se denuncian: afuera gritarían «NO ESTÁ CORRIENDO»
// en cada arranque por procesos que esa máquina no tiene. Lo LOCAL (.bench/, sellos) sigue. El examen de revisores
// también sigue hablando siempre (decisión del dev, 2026-09-26). Con la configuración ROTA: el aviso en cada arranque
// y lo nocturno no se hace (AC 2). Sin la lib al lado (un hook copiado a un arnés de mentira, como hace el banco):
// como hoy — fail-open. El perfil del equipo la prende: adentro nada cambia.
let NOCTURNOS = true;
try {
  const cfg = require(path.join(__dirname, '..', 'lib', 'tycon-config.js'));
  if (typeof cfg.integracionParaHook === 'function') {
    const n = cfg.integracionParaHook('nightly');
    if (!n.ok) console.log(n.aviso);
    NOCTURNOS = n.prendida;
  }
} catch (e) {
  // sin la lib al lado (hook copiado a un arnés de mentira): como hoy. Cualquier OTRO error del lector se dice —
  // un hook no frena, pero tragarlo dejaría un bug del lector invisible en todos los hooks a la vez (revisor de
  // fallos silenciosos, tanda B).
  if (!(e && e.code === 'MODULE_NOT_FOUND')) console.log(`bench-notice: el lector de configuración falló (${e && e.message}) — sigo como si los nocturnos estuvieran prendidos`);
}

// TYCON_BENCH_DIR: override PARA EL BANCO (2026-08-25) — sin él, los casos del propio notice no
// pueden aislarse del .bench real y un laboratorio con sello trucho leería los reportes de verdad.
const BENCH = process.env.TYCON_BENCH_DIR || path.join(__dirname, '..', 'controls-bench', '.bench');

// El umbral de vejez lo define el PRODUCTOR del reporte de paridad (su cadencia); acá sólo se
// consume. Fallback local si la lib no está (clon viejo). Un ts ilegible cuenta como viejo:
// fail-closed — NaN comparaba false y el reporte ilegible quedaba eternamente "fresco".
let STALE_MS = 3 * 24 * 60 * 60 * 1000;
// y dónde ESCRIBE el reporte de paridad (story 8.23, tanda G): en una versión bajada va a la carpeta del estado, no a
// .bench/ del árbol; la decide el productor, acá sólo se lee. Sin la lib (clon viejo), el de .bench/ de siempre.
let PARITY_REPORT = null;
try {
  const HP = require(path.join(__dirname, '..', 'lib', 'harness-parity.js'));
  STALE_MS = HP.STALE_MS;
  if (typeof HP.reportPath === 'function' && !process.env.TYCON_BENCH_DIR) PARITY_REPORT = HP.reportPath();
} catch { /* fallback */ }
function esViejo(ts) {
  const t = Date.parse(ts || '');
  return isNaN(t) || (Date.now() - t) > STALE_MS;
}

// ── El examen periódico de revisores (Story 1.1) ───────────────────────────────────────────────
// 🔴 Su umbral es OTRO y vive en un solo lugar: `periodic-exam.js`. Son dos preguntas
// distintas — `STALE_MS` contesta "¿cuán vieja es esta foto de paridad?" y el de allá contesta
// "¿el examen está corriendo?" —. Unificarlas las rompería a las dos, así que acá se importa,
// nunca se redefine. Si el módulo no está (clon viejo), NO se inventa un número: se dice que no
// se pudo evaluar, que es lo honesto — un "no sé" callado se lee igual que un verde.
let EXAMEN = null;
try { EXAMEN = require(path.join(__dirname, '..', 'controls-bench', 'periodic-exam.js')); } catch { /* clon viejo */ }
// 🔴 "NO MEDIDO" NO SE PINTA DE CERO (Story 1.1, 2026-09-10). El chequeo de vida hace una corrida
// por caso sobre una herramienta, así que la inestabilidad y la paridad son imposibles de medir —
// y el reporte las publicaba en 0, y este aviso las mostraba así en cada arranque, al lado de los
// rubros que sí se midieron. El criterio vive en UN archivo (lo usa también el corredor al
// escribir) y se deriva de `tool`/`runs`, que todo reporte real trae: así el reporte que HOY está
// en disco se corrige en el arranque siguiente, sin esperar a la próxima corrida. Con un clon
// viejo (sin el hermano) se muestra como antes — fail-open, como todo en este archivo.
let rubrosNoMedidos = () => ({ inestables: null, paridad: null });
try { ({ rubrosNoMedidos } = require(path.join(__dirname, '..', 'controls-bench', 'unmeasured-categories.js'))); } catch { /* clon viejo */ }
const RUTA_EXAMEN = leerVariable('TYCON_EXAM_REPORT')
  || path.join(__dirname, '..', 'controls-bench', 'ultimo-examen.json');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ── ¿Alguien corre el examen? (story 8.4, AC 28) ──────────────────────────────────────────────────
// El examen corre sólo en la máquina que designa `exam-config.json`. Con el archivo presente y SIN máquina designada
// —la copia pública la deja vacía: afuera nadie corre ese examen— el aviso calla sobre él: si no, diría «NO ESTÁ
// CORRIENDO» en cada arranque, para siempre, por un proceso que nadie tiene. Sin el archivo, o ilegible, no se sabe si
// alguien lo corre: el aviso sigue como siempre (un «no sé» callado se lee igual que un verde). Con máquina designada
// —el equipo— nada cambia: sigue la decisión del 2026-09-26 de que el examen avisa siempre.
function examenSinMaquinaDesignada() {
  const ruta = leerVariable('TYCON_EXAM_CONFIG') || path.join(__dirname, '..', 'controls-bench', 'exam-config.json');
  const cfg = readJson(ruta);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  return !String(cfg.designated_machine == null ? '' : cfg.designated_machine).trim();
}

// ── El banco de controles NOCTURNO (2026-09-05) ─────────────────────────────────────────────────
// El banco determinista dejó de correr en las máquinas: corre de noche en Azure DevOps
// (pipelines/azure-pipelines-banco.yml) y su reporte viaja por git, FUERA de `.bench/` (que git ignora),
// para que todas las máquinas lean la MISMA foto. Motivo: en la máquina del dev corría dos veces
// por arranque, la segunda en cada sesión, y dos bancos superpuestos agotaban el tiempo de los
// casos — el aviso gritó "regresiones" durante días sin un defecto real detrás.
// Criterio, el mismo que dependencies-notice: sin reporte = todavía no se estrenó (nada que decir);
// reporte con más de dos días = NO ESTÁ CORRIENDO, y se callan los números viejos; fresco con
// rojos o no medidos = se dicen; fresco y limpio = silencio.
const RUTA_BANCO = leerVariable('TYCON_BENCH_REPORT')
  || path.join(__dirname, '..', 'controls-bench', 'ultimo-banco.json');
const BANCO_VEJEZ_MS = 2 * 24 * 60 * 60 * 1000; // corre todas las noches: dos sin foto = se detuvo
const BANCO_TS = (() => {
  if (!NOCTURNOS) return null;   // sin nocturnos, la foto local no se compara contra ninguna nocturna
  const b = readJson(RUTA_BANCO);
  const t = b && b.ts ? Date.parse(b.ts) : NaN;
  return isNaN(t) ? null : t;
})();

// Las SUITES nocturnas juegan el mismo juego que el banco: reporte que viaja, denuncia si
// envejece, silencio si está fresco y limpio (2026-09-05).
const RUTA_SUITES = leerVariable('TYCON_SUITES_REPORT')
  || path.join(__dirname, '..', 'controls-bench', 'ultimo-suites.json');
/** La fecha de la foto nocturna de suites, o null (sin foto, ilegible, o nocturnos apagada). */
function tsSuitesNocturnas() {
  if (!NOCTURNOS) return null;
  const b = readJson(RUTA_SUITES);
  const t = b && b.ts ? Date.parse(b.ts) : NaN;
  return isNaN(t) ? null : t;
}

function estadoDeLasSuitesNocturnas() {
  const rep = readJson(RUTA_SUITES);
  if (!rep) return [];
  const t = rep.ts ? Date.parse(rep.ts) : NaN;
  const fecha = rep.ts ? String(rep.ts).slice(0, 10) : '?';
  const dias = isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
  if (isNaN(t) || (Date.now() - t) > BANCO_VEJEZ_MS) {
    return [`🔕 las suites de prueba NOCTURNAS NO ESTÁN CORRIENDO desde el ${fecha}`
      + (dias === null ? ' (fecha ilegible)' : ` (hace ${dias} día(s))`)
      + ' — sus números no se muestran a propósito: no son el estado de hoy'
      + ' · revisar el pipeline "Banco de controles (nocturno)" en Azure DevOps'];
  }
  const f = rep.failures || [];
  if (!f.length) return [];
  // 🔴 La EDAD de la foto va en la línea (2026-09-06, pedido del dev): esto no mide nada, muestra lo
  // que vio el nocturno de la madrugada. Un rojo que se arregló durante el día se sigue mostrando
  // hasta la corrida siguiente, y sin la edad se lee como «está roto AHORA»: pasó el 06-09 con
  // sdlc-transitions-nightly.test.sh, que a las 05:08 UTC estaba roja de verdad (un commit de esa
  // madrugada aún sin pushear) y a la mañana ya pasaba, con tres sesiones repitiendo el mismo aviso.
  const horas = isNaN(t) ? null : Math.floor((Date.now() - t) / 3600000);
  const cuando = horas === null ? '' : horas < 1 ? ', recién' : horas < 24 ? `, hace ${horas} h` : `, hace ${Math.floor(horas / 24)} día(s)`;
  // El MOTIVO al lado del nombre (2026-09-14, PIPE-DEBT-2.13-b): con el nombre solo, saber por qué
  // estaba roja exigía volver a correrla. Corto a propósito; el reporte trae hasta tres líneas.
  const motivos = rep.motivos && typeof rep.motivos === 'object' ? rep.motivos : {};
  // 🔴 «No medida» no es «roja» (2026-10-04). Desde que las suites corren en trabajos paralelos, las de un trabajo que
  // no terminó viajan en `failures` con su marca y, aparte, en `unmeasured`. Contadas como rojas y listadas una por
  // una, un solo trabajo cortado eran 108 nombres y 8.328 caracteres en cada arranque de cada máquina. Las rojas se
  // nombran; las no medidas se CUENTAN, agrupadas por su motivo («el trabajo 2 no terminó»). El detalle, en el reporte.
  const noMedidas = Array.isArray(rep.unmeasured) ? f.filter((n) => rep.unmeasured.includes(n)) : [];
  const rojas = f.filter((n) => !noMedidas.includes(n));
  const conMotivo = rojas.map((n) => (typeof motivos[n] === 'string' && motivos[n]
    ? `${n} (${motivos[n].length > 140 ? `${motivos[n].slice(0, 139)}…` : motivos[n]})` : n));
  const porMotivo = new Map();
  for (const n of noMedidas) {
    const m = typeof motivos[n] === 'string' && motivos[n] ? motivos[n].replace(/^no medida:\s*/, '').slice(0, 140) : 'sin motivo anotado';
    porMotivo.set(m, (porMotivo.get(m) || 0) + 1);
  }
  const sinMedir = [...porMotivo].map(([m, cuantas]) => `${cuantas} suite(s) no medidas: ${m}`).join(' · ');
  const cola = horas !== null && horas >= 2 ? ' · es lo que vio el nocturno, no una medición de ahora: si se arregló después, esto no lo sabe' : '';
  if (!rojas.length) {
    return [`🟡 suites de prueba nocturnas (foto del ${fecha}${cuando}): ${sinMedir} — la noche quedó incompleta: no son rojas ni verdes`
      + ' · detalle: scripts/controls-bench/ultimo-suites.json' + cola];
  }
  return [`🔴 suites de prueba nocturnas (foto del ${fecha}${cuando}): ${rojas.length} en rojo — ${conMotivo.join(' · ')}`
    + (sinMedir ? ` · 🟡 ${sinMedir} (detalle: scripts/controls-bench/ultimo-suites.json)` : '') + cola];
}

function estadoDelBancoNocturno() {
  const rep = readJson(RUTA_BANCO);
  if (!rep) return [];
  const t = rep.ts ? Date.parse(rep.ts) : NaN;
  const fecha = rep.ts ? String(rep.ts).slice(0, 10) : '?';
  const dias = isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
  if (isNaN(t) || (Date.now() - t) > BANCO_VEJEZ_MS) {
    // 🔴 Se denuncia y NO se muestran los números: una foto vieja hace perseguir rojos que
    // quizá ya se arreglaron, o tranquiliza con un verde que ya no es de hoy.
    return [`🔕 el banco de controles NOCTURNO NO ESTÁ CORRIENDO desde el ${fecha}`
      + (dias === null ? ' (fecha ilegible)' : ` (hace ${dias} día(s))`)
      + ' — sus números no se muestran a propósito: no son el estado de hoy'
      + ' · revisar el pipeline "Banco de controles (nocturno)" en Azure DevOps'];
  }
  const rojos = (rep.failed || 0) + (rep.parityBreaks || 0) + (rep.baselineRegressions || 0);
  const nm = rep.nomedido || 0;
  if (rojos === 0 && nm === 0) return [];
  return [`${rojos ? '🔴' : '🟡'} banco de controles nocturno (${fecha}): ${rep.failed || 0} rojos`
    + ` · paridad rota ${rep.parityBreaks || 0} · regresiones ${rep.baselineRegressions || 0}`
    + (nm ? ` · 🟡 ${nm} NO MEDIDO(s) (se les agotó el tiempo — la corrida no está completa)` : '')
    + ' · detalle: scripts/controls-bench/ultimo-banco.json'];
}

// ── ¿El sello diario lo escribió el JOB, o una mano? (§5.3, 2026-08-25) ─────────────────────────
// Los frenos diarios se gatean por un archivo-sello con la fecha (`*-last-run`): si dice hoy, la
// suite no corre. Reproducido: `echo 2026-08-25 > ~/.claude/.tycon-pipeline/bash-tests-last-run`
// saltea la tanda del día sin error y sin rastro — el mismo patrón de C1, sobre el estado local.
// La detección usa lo que el flujo legítimo YA produce: el job escribe SIEMPRE su reporte en
// .bench/ ANTES del sello, así que un sello de hoy con reporte viejo (o sin reporte) no salió del
// job. No se bloquea nada: se grita acá, que es el canal donde ya se cobran los rojos del banco.
function selloSinReporte(stampPath, reportPath, etiqueta) {
  let sello = '';
  try { sello = fs.readFileSync(stampPath, 'utf8').trim(); } catch { return null; }
  const hoy = new Date().toISOString().slice(0, 10);
  // `.slice(0,10)`: los sellos diarios guardan `YYYY-MM-DD` y el del examen un timestamp ISO
  // completo (marca el INSTANTE en que terminó, no el día que le tocaba).
  if (sello.slice(0, 10) !== hoy) return null;          // sello viejo: mañana corre igual, no hay salto
  const rep = readJson(reportPath);
  const tsRep = rep && rep.ts ? String(rep.ts).slice(0, 10) : null;
  if (tsRep === hoy) return null;                       // el job corrió hoy: sello legítimo
  return `${etiqueta}: el sello de HOY (${stampPath.replace(process.env.HOME || '', '~')}) no lo escribió el job — ` +
    (tsRep ? `su reporte es del ${tsRep}` : 'no hay reporte suyo en .bench/') +
    '. La suite de hoy NO corrió y algo la selló igual. Borrá el sello para que corra: rm <sello>';
}

/**
 * ¿El examen de los 28 revisores está corriendo? (Story 1.1, AC 5/8/13b/22/23)
 *
 * 🔴 Hasta hoy este aviso hablaba SÓLO si había fallas, y leía SÓLO `.bench/` — que git ignora.
 * O sea: el resultado del examen no salía nunca de la máquina que lo corrió, y "no corrió" y
 * "corrió verde hace nueve días" eran exactamente el mismo silencio. Ése es el bug de fondo: una
 * foto vieja mostrada sin fecha se lee como el estado de esta semana.
 *
 * Devuelve las líneas a decir. Vacío = hay una medición completa y fresca, y no tenía rojos:
 * ése es el único silencio legítimo.
 */
function estadoDelExamen(benchDir) {
  const lineas = [];
  if (examenSinMaquinaDesignada()) return lineas;   // nadie corre el examen: no hay nada que denunciar
  if (!EXAMEN) {
    lineas.push('examen de revisores: no pude evaluar si está corriendo (falta scripts/controls-bench/periodic-exam.js — ¿clon desactualizado?)');
    return lineas;
  }
  const rep = readJson(RUTA_EXAMEN);
  const t = rep && rep.ts ? Date.parse(rep.ts) : NaN;
  const fecha = rep && rep.ts ? String(rep.ts).slice(0, 10) : null;
  const dias = isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);

  if (!rep || rep.estado !== 'completo' || isNaN(t)) {
    lineas.push('🔕 el examen de los revisores NO ESTÁ CORRIENDO: no hay ninguna medición completa registrada'
      + ' · diagnóstico: node scripts/controls-bench/periodic-exam.js --dry-run');
  } else if ((Date.now() - t) > EXAMEN.VEJEZ_MS) {
    // 🔴 Se denuncia y NO se muestran los números: una foto de hace 9 días no es el estado de
    // esta semana, y mostrarla hace perseguir rojos que quizá ya arregló lo que vino después.
    lineas.push(`🔕 el examen de los revisores NO ESTÁ CORRIENDO desde el ${fecha} (hace ${dias} días)`
      + ` — sus números no se muestran a propósito: no son el estado de esta semana`
      + ` · diagnóstico: node scripts/controls-bench/periodic-exam.js --dry-run`);
  } else {
    // 🔴 `erroresDeCorrida` y `skippedMcp` CUENTAN. Los dos los reprodujo el pase adversarial: un
    // reporte fresco y "completo" con 30 casos caídos en error de corrida, y los otros contadores
    // en cero, no imprimía absolutamente nada — silencio, o sea verde. Y los casos salteados por un
    // servidor MCP ausente tampoco: el propio examen los llama "constancia, no verde", pero acá se
    // perdían. La rama hermana de este mismo archivo (la de los reportes locales) ya usaba `failed`,
    // que sí los incluye: la inconsistencia era sólo del camino nuevo.
    const errores = rep.erroresDeCorrida || 0;
    const salteados = rep.skippedMcp || 0;
    // 🔴 LAS FUGAS TAMBIÉN SE DENUNCIAN (2026-09-01). Con el desglose nuevo, un examen que se
    // escapó del corral deja `criterio` en cero — y sin esta línea el aviso se quedaba callado
    // sobre 99 corridas que NO quedaron aisladas, o sea que cantaba verde una corrida no medida.
    // Es el mismo error que la nota de arriba documenta para `erroresDeCorrida`, con otro nombre.
    const fugas = rep.fugas || 0;
    const rojos = (rep.criterio || 0) + (rep.inestables || 0) + (rep.paridadReal || 0)
      + (rep.baselineRegressions || 0) + errores + salteados + fugas;
    // Lo que esta corrida NO pudo medir se dice con esas palabras, nunca "0" (Story 1.1). No suma
    // rojos —no dice nada del revisor— y NO fuerza la línea: un examen fresco y sin rojos sigue
    // callado (caso `quiet-examen-fresco-y-verde` del banco). Con el chequeo de vida estos dos
    // rubros quedan sin medir en TODA corrida, por diseño; hablar por eso sería una línea en cada
    // arranque para siempre, y un aviso que sale siempre se ignora. El silencio no afirma nada;
    // lo que afirmaba era el 0 — y ése ya no se imprime ni cuando la línea sale (T50, T54).
    const nm = rubrosNoMedidos({ tool: rep.tool, runs: rep.runs });
    const inestables = nm.inestables
      ? `inestables NO MEDIDOS (${nm.inestables})`
      : `${rep.inestables || 0} inestables (cambia de opinión entre corridas)`;
    const paridad = nm.paridad
      ? `paridad NO MEDIDA (${nm.paridad})`
      : `paridad rota ${rep.paridadReal || 0}`;
    if (rojos > 0) {
      lineas.push(`examen de revisores (${fecha}, hace ${dias} día(s), máquina ${rep.maquina || '?'}):`
        + ` ${rep.criterio || 0} de criterio (el revisor razona mal) · ${inestables}`
        + ` · ${paridad} · regresiones ${rep.baselineRegressions || 0}`
        + (fugas ? ` · 🚧 ${fugas} corridas que se escaparon del corral (NO están medidas: el veredicto depende de qué tiene el dev en el disco)` : '')
        + (errores ? ` · ${errores} en error de corrida (no llegaron a correr — esa parte del examen NO está medida)` : '')
        + (salteados ? ` · ${salteados} salteados por MCP ausente (constancia, no verde)` : ''));
    }
  }

  // Las corridas ACOTADAS son información complementaria, jamás el estado general (AC 13b). Sólo
  // se nombran si ya estamos hablando del examen: si no, serían ruido en una mañana tranquila.
  if (lineas.length) {
    try {
      for (const f of fs.readdirSync(benchDir).filter((x) => /^advisors-.*-parcial-.*\.json$/.test(x))) {
        const p = readJson(path.join(benchDir, f));
        if (!p) continue;
        lineas.push(`   ℹ️ hay además una corrida PARCIAL (${(p.only || []).join(', ') || 'alcance acotado'}, ${String(p.ts || '').slice(0, 10)})`
          + ' — es complementaria; no dice nada de los revisores que no cubrió');
      }
    } catch { /* sin .bench/, nada que agregar */ }
  }
  return lineas;
}

// 🔴 El examen se evalúa Y SE IMPRIME acá arriba, en su propio `try`, ANTES de tocar nada del
// banco. Todo lo de abajo vive dentro de un único bloque que atrapa cualquier error y se calla
// (fail-open: un aviso jamás puede romper el arranque de sesión) — así que si la denuncia del
// examen se computara ahí adentro, un reporte corrupto de OTRO control, o un permiso mal puesto,
// la borraría sin dejar rastro. Sería reintroducir, por la puerta del arreglo, el mismo fallo
// silencioso que esta pieza vino a cerrar. Su reporte además vive FUERA de `.bench/`, así que una
// máquina que nunca corrió el banco igual tiene que enterarse de que el examen se detuvo.
try {
  for (const l of estadoDelExamen(BENCH)) console.log(l);
} catch (e) {
  console.log(`examen de revisores: no pude evaluar si está corriendo (${e && e.message}) — asumilo NO medido`);
}
if (NOCTURNOS) {
  try {
    for (const l of estadoDelBancoNocturno()) console.log(l);
  } catch (e) {
    console.log(`banco nocturno: no pude evaluar si está corriendo (${e && e.message}) — asumilo NO medido`);
  }
  try {
    for (const l of estadoDeLasSuitesNocturnas()) console.log(l);
  } catch (e) {
    console.log(`suites nocturnas: no pude evaluar si están corriendo (${e && e.message}) — asumilo NO medido`);
  }
}

try {
  const problems = [];
  // sin .bench/ no hay nada que cobrar… salvo el reporte de paridad, que en una versión bajada vive en la carpeta del
  // estado y el árbol bajado no trae .bench/ (git lo ignora): salir acá lo callaba para siempre (pase adversarial, tanda G)
  const parityElsewhere = Boolean(PARITY_REPORT && path.dirname(PARITY_REPORT) !== BENCH && fs.existsSync(path.dirname(PARITY_REPORT)));
  if (!fs.existsSync(BENCH) && !parityElsewhere) process.exit(0);
  {
    const os = require('os');
    const ST = path.join(stateDirOf(os.homedir()));
    // Los 4 sellos diarios y el reporte que cada job deja. Las dos suites EN LÍNEA (backfill y
    // matriz) empezaron a dejar reporte el 2026-08-25 para poder entrar acá: sin reporte, un sello
    // escrito a mano en ésas era indetectable.
    for (const [stamp, rep, tag] of [
      ['bash-tests-last-run', 'bash-tests.json', 'suites bash diarias'],
      ['bash-tests-semanal-last-run', 'bash-tests-semanal.json', 'suites bash semanales (las caras: vacuidad del banco)'],
      ['controls-bench-last-run', 'last-run-claude.json', 'banco de controles'],
      ['backfill-tests-last-run', 'backfill-tests.json', 'suite diaria de descubrimiento y lints'],
      ['matrix-tests-last-run', 'matrix-tests.json', 'suite de la matriz runtime'],
    ]) {
      const w = selloSinReporte(path.join(ST, stamp), path.join(BENCH, rep), tag);
      if (w) problems.push(w);
    }
    // El sello del examen periódico juega el mismo juego, pero su reporte vive FUERA de .bench/
    // (tiene que viajar por git). Sellar a mano acá se robaría un turno del examen entero.
    const we = selloSinReporte(leerEstado(path.join(ST, 'periodic-exam-last-run')), RUTA_EXAMEN, 'examen de revisores');
    if (we) problems.push(we);
  }
  // los reportes de .bench/, y el de paridad desde donde lo escribe su productor (si es otro lugar): se suma a la lista
  // con su nombre; si en .bench/ quedó uno viejo con el mismo nombre, manda el del productor
  const reportFiles = (fs.existsSync(BENCH) ? fs.readdirSync(BENCH) : []).filter((x) => x.endsWith('.json')).map((f) => [f, path.join(BENCH, f)]);
  if (PARITY_REPORT && path.dirname(PARITY_REPORT) !== BENCH && fs.existsSync(PARITY_REPORT)) {
    const i = reportFiles.findIndex(([f]) => f === 'harness-parity.json');
    if (i >= 0) reportFiles.splice(i, 1);
    reportFiles.push(['harness-parity.json', PARITY_REPORT]);
  }
  // …y los del disparo real (live-fire-*.json), que desde el 2026-10-11 se escriben en esa misma carpeta del productor:
  // en una versión bajada quedaban en .bench/ del árbol, que cada actualización reemplaza entero, y el rojo se iba con él
  if (PARITY_REPORT && path.dirname(PARITY_REPORT) !== BENCH) {
    const dir = path.dirname(PARITY_REPORT);
    let names = [];
    try { names = fs.readdirSync(dir).filter((x) => /^live-fire-.*\.json$/.test(x)); } catch (e) { if (e && e.code !== 'ENOENT') problems.push(`no pude leer ${dir} (${e.code || e.message}): los reportes del disparo real NO se miraron`); }
    for (const f of names) {
      const i = reportFiles.findIndex(([n]) => n === f);
      if (i >= 0) reportFiles.splice(i, 1);
      reportFiles.push([f, path.join(dir, f)]);
    }
  }
  for (const [f, file] of reportFiles) {
    const r = readJson(file);
    if (!r) continue;
    if (/^last-run-.*-parcial-.*\.json$/.test(f)) {
      // Corrida ACOTADA del banco determinista (`--only`): NO es el estado general, y muchas son
      // experimentos de "rojo previo" —el arreglo desactivado a propósito— que dejan rojos
      // deliberados en el disco (2026-09-05: el arranque mostraba 14, 5 y 3 rojos de tres
      // corridas así, con días de antigüedad, como si fueran del banco). Mismo criterio que las
      // acotadas del examen: complementarias, no estado.
      continue;
    }
    if (/^advisors-.*-parcial-.*\.json$/.test(f)) {
      // Corrida ACOTADA: la trata `estadoDelExamen()` como información complementaria. Acá se
      // saltea a propósito — si cayera en el brazo de abajo, tres revisores en verde se mostrarían
      // con la misma cara que la foto de los 28, que es justo el error que la Story 1.1 vino a
      // cerrar. (Y si cayera en el brazo de "kind desconocido", gritaría en cada arranque.)
      continue;
    }
    if (r.kind === 'examen-periodico-intento') {
      // Un intento que no terminó NO es un verde y NO es una medición: es un "no pude mirar".
      if (r.estado === 'no-viajo') {
        // Midió bien, pero el resultado no llegó a nadie. En la máquina que lo corrió el sello y el
        // reporte local quedan frescos, así que sin esta línea el único lugar donde se sabría sería
        // el log de launchd — el canal invisible que esta pieza vino a reemplazar.
        problems.push(`el examen midió pero el resultado NO VIAJÓ (${String(r.ts || '').slice(0, 16)}): ${r.motivo || 'sin motivo'}`
          + ` — el resto del equipo no lo ve; hay que pushearlo a mano`);
      } else if (r.estado !== 'completo') {
        problems.push(`el examen de revisores quedó INCOMPLETO (${String(r.ts || '').slice(0, 16)}): ${r.motivo || 'sin motivo registrado'}`
          + ` — es una corrida que NO midió, no un resultado`);
      }
      continue;
    }
    if (f.startsWith('last-run-') || f.startsWith('advisors-')) {
      // 🔴 Una foto LOCAL más vieja que el nocturno no se muestra (2026-09-05): desde que el banco
      // corre en Azure DevOps, el `last-run-*.json` de esta máquina es lo que quedó de la última
      // vez que alguien lo corrió a mano — y con el lanzamiento local retirado, ese archivo va a
      // envejecer para siempre gritando rojos que el nocturno ya dio por arreglados. Sólo se
      // muestra si es MÁS NUEVO que el nocturno (una corrida a mano de hoy sí es información).
      if (f.startsWith('last-run-') && BANCO_TS !== null && r.ts && Date.parse(r.ts) < BANCO_TS) continue;
      // 🔴 Los NO MEDIDOS también hablan (2026-09-04). Son casos a los que se les agotó el
      // tiempo dos veces: no son rojos —no dicen nada del control— pero tampoco son verdes, y
      // una corrida con no medidos NO está completa. Si no se contaran acá, el aviso diría
      // "todo bien" sobre una foto con agujeros, que es el modo de falla que este arnés
      // persigue en todos lados ("no medido nunca es limpio").
      const noMedidos = r.nomedido || 0;
      // En Windows una corrida también es roja por un hueco viejo de known-gaps.json (`staleGaps`, story 8.17): el
      // banco sale 1 por eso solo, y sin contarlo acá el aviso diría «todo bien».
      const total = (r.failed || 0) + (r.parityBreaks || 0) + (r.baselineRegressions || 0) + (r.staleGaps || 0) + noMedidos;
      if (total > 0) {
        // 🔴 El aviso distingue CRITERIO de INESTABILIDAD cuando el reporte lo trae (2026-08-25).
        // "19 rojos" mezclaba dos problemas opuestos —el revisor razona mal vs. el revisor cambia
        // de opinión entre corridas— y se leía como el peor de los dos. Un aviso que no se puede
        // usar para decidir es un aviso que se ignora: ese reporte estuvo un día en rojo sin que
        // nadie lo mirara. Los reportes viejos (sin el desglose) se siguen mostrando como antes.
        // Y lo que esa corrida NO pudo medir se nombra así, no "0" (Story 1.1) — mismo criterio
        // que la rama del examen que viaja, derivado de `tool`/`runs`.
        const nm = rubrosNoMedidos({ tool: r.tool, runs: r.runs });
        const desglose = typeof r.criterio === 'number'
          ? `${r.criterio} de criterio (el revisor razona mal) · `
            + (nm.inestables ? `inestables NO MEDIDOS (${nm.inestables})` : `${r.inestables || 0} inestables (cambia de opinión entre corridas)`)
            + (r.fugas ? ` · 🚧 ${r.fugas} que se escaparon del corral (NO medidas)` : '')
          : `${r.failed} rojos`;
        const par = nm.paridad
          ? `paridad NO MEDIDA (${nm.paridad})`
          : typeof r.paridadReal === 'number'
            ? `paridad rota ${r.paridadReal}${r.paridadPorInestabilidad ? ` (+${r.paridadPorInestabilidad} por ruido)` : ''}`
            : `paridad rota ${r.parityBreaks || 0}`;
        // 🔴 La ANTIGÜEDAD va en el aviso (2026-08-28): un reporte de hace 4 días se leía igual
        // que uno de recién ("la última corrida"), y esa lectura hace perseguir rojos que quizá
        // ya arregló lo que vino después. Caso: una corrida de esta suite se canceló a las 5h30
        // y los rojos mostrados eran fotos anteriores a dos días de arreglos. Si el reporte trae
        // `nota` (cancelación, contexto), se muestra: es la explicación que evita el susto.
        const dias = r.ts ? Math.floor((Date.now() - new Date(r.ts).getTime()) / 86400000) : null;
        const edad = dias === null ? '' : dias >= 1 ? ` — FOTO DE HACE ${dias} DÍA(S), anterior a lo que se arregló después` : '';
        problems.push(`${f}: ${desglose} · ${par} · regresiones ${r.baselineRegressions}`
          + (noMedidos ? ` · 🟡 ${noMedidos} NO MEDIDO(s) (se les agotó el tiempo — la corrida no está completa)` : '')
          + ` (${r.ts})${edad}`
          + (r.nota ? `\n     ℹ️ ${r.nota}` : ''));
      }
    } else if (f === 'live-fire-guard.json') {
      for (const [t, v] of Object.entries(r.tools || {}))
        if (v && v.pass === false) problems.push(`${f} [${t}]: ${(v.failures || []).join(' | ')} (${r.ts})`);
    } else if (f.startsWith('live-fire-')) {
      // Los reportes en modo prueba (r.prove) son reconocidos y se saltean a propósito — si
      // cayeran a la rama "sin dueño" de abajo, cada --prove-detection gritaría un falso rojo.
      if (!r.prove && (r.failures || []).length > 0) problems.push(`${f}: ${r.failures.join(' | ')} (${r.ts})`);
    } else if (f === 'harness-parity.json' || r.kind === 'harness-parity') {
      // Paridad de instalación Claude↔Codex (Etapa H). Dos gritos, INDEPENDIENTES (la 2ª ronda
      // adversarial cazó que como else-if un reporte viejo CON rojos nunca decía "dejó de
      // correr"): superficies en rojo, y reporte viejo — pero SÓLO en máquinas con lado Codex
      // (deployed:true): en las demás no hay nada corriendo que pueda "dejar de correr".
      if (r.deployed && (r.reds || 0) > 0)
        problems.push(`${f}: ${r.reds} superficie(s) de paridad en rojo — ${(r.surfaces || []).filter((s) => !s.ok).map((s) => s.name).join(', ')} · correr: node scripts/lib/harness-audit.js --parity (${r.ts})`);
      if (r.deployed && esViejo(r.ts))
        problems.push(`${f}: el reporte de paridad quedó viejo (${r.ts || 'sin fecha'}) — la auditoría dejó de correr; revisá el bloque de paridad del instalador`);
    } else if (r.kind === 'backfill-tests' || r.kind === 'matrix-tests') {
      // Desde el 2026-09-05 estas dos familias también corren en ADO (job `Suites`): el reporte
      // local es lo que quedó de la última corrida en esta máquina, y si es más viejo que el
      // nocturno de suites no es el estado de nada (así apareció "11 suites en rojo" en una sesión).
      const SUITES_TS3 = tsSuitesNocturnas();
      if (SUITES_TS3 !== null && r.ts && Date.parse(r.ts) < SUITES_TS3) continue;
      // Suites diarias del instalador con el MISMO contrato que bash-tests: {kind, ts, failures[]}.
      // Ramas propias (no un fallback genérico por shape) a propósito: el brazo "kind desconocido"
      // de abajo es el que garantiza que un reporte nuevo GRITE hasta que alguien lo mire y decida
      // su rama — un fallback silencioso por forma lo dejaría nacer sin que nadie lo revisara.
      if ((r.failures || []).length > 0)
        problems.push(`${f}: suite(s) en rojo — ${r.failures.join(' · ')} (${r.ts})`);
    } else if (r.kind === 'bash-tests-semanal') {
      // Las suites SEMANALES (la cara: vacuidad del banco). Desde el 2026-09-05 también corren en
      // ADO (job `Suites`, todas las noches — allá los 135 s no le cuestan a nadie); el reporte
      // local es lo que quedó de la última corrida en esta máquina y, si es más viejo que el
      // nocturno de suites, no es el estado de nada.
      const SUITES_TS2 = tsSuitesNocturnas();
      if (SUITES_TS2 !== null && r.ts && Date.parse(r.ts) < SUITES_TS2) continue;
      if ((r.failures || []).length > 0) problems.push(`${f}: suite(s) semanal(es) en rojo — ${r.failures.join(' · ')} (${r.ts})`);
    } else if (r.kind === 'bash-tests') {
      // 🔴 Con las suites mudadas a ADO (2026-09-05), el bash-tests.json LOCAL es lo que quedó de la
      // última corrida en esta máquina y no se refresca más: si es más viejo que el reporte
      // nocturno, no es el estado de las suites — es una foto vieja, y una foto vieja con rojos
      // hace perseguir lo que el nocturno ya dio por verde (pasó esa misma madrugada en otra sesión).
      const SUITES_TS = tsSuitesNocturnas();
      if (SUITES_TS !== null && r.ts && Date.parse(r.ts) < SUITES_TS) continue;
      // La corrida diaria de suites bash del instalador (que corre DE FONDO: su stdout no llega
      // al SessionStart — este reporte es su único canal de cobro).
      if ((r.failures || []).length > 0)
        problems.push(`${f}: suite(s) bash en rojo — ${r.failures.join(' · ')} · diagnóstico: bash <suite> (${r.ts})`);
    } else if (r.kind) {
      // Un reporte con `kind` que ningún brazo reconoce NO se ignora: así un control nuevo no
      // nace muerto. Los .json SIN kind (scratch de advisor-runner --json, ~45 en esta máquina)
      // se ignoran como siempre — gritarlos habría sido una pared de 45 falsos rojos por
      // arranque (2ª ronda adversarial, verificado contra el .bench real).
      problems.push(`${f}: reporte con kind "${r.kind}" que bench-notice no reconoce — agregale su rama`);
    }
  }
  if (problems.length) {
    console.log('🔴 controls-bench EN ROJO — el banco de pruebas de controles detectó fallas en la última corrida:');
    for (const p of problems) console.log(`   · ${p}`);
    console.log(`   Correr: node ${path.join(BENCH, '..', 'runner.js')} --tool claude --baseline check · detalle en ${BENCH}/`);
  }
} catch { /* fail-open */ }
process.exit(0);
