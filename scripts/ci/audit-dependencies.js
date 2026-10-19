#!/usr/bin/env node
'use strict';
/**
 * audit-dependencies.js — EL criterio del análisis de dependencias, en un solo lugar.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * El análisis de dependencias está escrito COPIADO adentro de los 10 pipelines del equipo (5
 * formularios con `npm audit`, 5 backends con `dotnet list package --vulnerable`), y nada las
 * mantiene iguales. Ya divergieron, y no de forma inofensiva: medido el 2026-09-01, el paso de
 * `FRESNOBZExtBackend` NO restaura las dependencias antes de escanear —así que no mira nada—, el
 * fallo se pierde en el `| tee` y el paso termina en VERDE. Tiene 4 vulnerabilidades altas reales
 * y su pipeline dice que está limpio. Es el mismo defecto que ya se arregló en Ceibo (build 9027)
 * y se backporteó a Totora, URUTAU y Lapacho; a FRESNO no.
 *
 * Y hay una segunda razón, que es la que trajo esta pieza: **el veredicto de este análisis puede
 * cambiar sin que cambie una línea de código**. Es el único de los tres controles de seguridad que
 * pregunta AFUERA (la base pública de avisos de GitHub); los otros dos —secretos y código— miran
 * sólo el repo, así que el mismo código da siempre el mismo resultado. Caso medido: el pipeline de
 * los formularios de un producto del equipo pasó en verde a las 15:56 del 2026-09-01 y a las 16:42 se publicó CVE-2026-73089
 * sobre `browserslist`. Mismo código, veredicto opuesto, y nadie se enteraba hasta el próximo PR — guides/maintaining/incident-log.md#veredicto-que-cambia-sin-que-cambie-el-codigo-2026-09-01.
 *
 * ── QUÉ HACE, Y QUÉ NO ──────────────────────────────────────────────────────────────────────────
 * Mide y REPORTA. **No decide si eso frena**: eso lo decide quien lo llama, que es lo que separa
 * al control del pull request (frena) del nocturno (avisa). Un mismo criterio, dos consecuencias.
 *
 * 🔴 **"No pude medir" NUNCA sale 0.** Un escaneo que no corrió no es un escaneo limpio — es
 * exactamente el agujero de FRESNO. Sale 2 y lo dice, con el motivo.
 *
 * ── DEUDA DECLARADA ─────────────────────────────────────────────────────────────────────────────
 * Un repo puede declarar vulnerabilidades preexistentes en un `vulnerabilidades-pendientes.json`
 * (formato de `FRESNO/FRESNOBZExtForms`, el que ya existe). Lo declarado no despierta a nadie; **lo que
 * NO está declarado cuenta igual**, y una declaración VENCIDA vuelve a contar todo como nuevo. La
 * declaración registra lo que ya estaba, con nombre y fecha, para que no se vuelva permanente en
 * silencio — no apaga el control.
 *
 * ── USO ─────────────────────────────────────────────────────────────────────────────────────────
 * pip: `pip-audit` sobre el archivo de requisitos fijado, sin instalar nada; pip-audit
 * no da la gravedad y cada vulnerabilidad cuenta como alta (ver `auditarPip`).
 * npm y nuget: una gravedad vacía o desconocida también cuenta como alta, con la misma marca (ver `gravedad`).
 *
 *   node audit-dependencies.js --repo <dir> --type npm|nuget|pip [--project <rel>]
 *                                [--declared <rel>] [--json] [--block]
 *   node audit-dependencies.js --help
 *
 * Exit: 0 = midió (haya o no hallazgos) · 1 = midió y hay altas/críticas no declaradas, SÓLO con
 *       `--block` · 2 = NO PUDO MEDIR (falta el lockfile, el restore falló, la salida es ilegible)
 *
 * Inyección para pruebas: TYCON_DEP_CMD (ruta a un comando que reemplaza a npm/dotnet/pip-audit).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
// Las variables renombradas a inglés (story 8.9): el nombre viejo sigue valiendo hasta el retiro. Sin la biblioteca al
// lado (una copia suelta de este archivo, como la semilla de las pruebas de la noche), paso directo con el nombre nuevo.
const { readEnv } = (() => {
  try { return require('../lib/legacy-names.js'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') process.stderr.write(`⚠️  legacy-names.js no cargó (${e && e.message}): las variables viejas no se leen\n`); return { readEnv: (n) => process.env[n] }; }
})();
// Las opciones renombradas a inglés (story 8.9, tanda B2): los pipelines de los productos siguen pasando las viejas
// hasta el retiro. El traductor vive al lado (viaja en el artefacto arnes-ci); una copia suelta de este archivo sin él
// sólo entiende las nuevas.
const { aliasLegacyOptions, LegacyOptionsError } = (() => {
  try { return require('./legacy-options.js'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') process.stderr.write(`⚠️  legacy-options.js no cargó (${e && e.message}): los nombres viejos de este guion no se traducen\n`); return { aliasLegacyOptions: (argv) => argv, LegacyOptionsError: Error }; }
})();

const WHERE = 'scripts/ci/audit-dependencies.js';
const SEVERIDADES_GRAVES = ['high', 'critical'];
const GESTOR = { npm: 'npm', nuget: 'nuget', pip: 'pip-audit' };
const SEVERIDADES_CONOCIDAS = ['critical', 'high', 'moderate', 'low', 'info'];

/**
 * La gravedad de una vulnerabilidad de npm o nuget. Una vacía o que no es de las conocidas cuenta como ALTA, con la marca
 * `gravedad_sin_dato` y lo que vino en `gravedad_informada`, igual que pip: bajarla o descartarla sería callar lo que no
 * se sabe, y el repo salía limpio sin aviso.
 */
function gravedad(sev) {
  const s = String(sev == null ? '' : sev).trim().toLowerCase();
  if (SEVERIDADES_CONOCIDAS.includes(s)) return { severidad: s };
  return { severidad: 'high', gravedad_sin_dato: true, gravedad_informada: sev == null ? '' : String(sev) };
}

// ── Interpretación de argumentos ───────────────────────────────────────────────────────────────

function parseArgs(argv0) {
  const a = { repo: null, tipo: null, proyecto: null, declaradas: null, json: false, frenar: false, help: false };
  let argv;
  try {
    argv = [...argv0.slice(0, 2), ...aliasLegacyOptions(argv0.slice(2), 'tipo:type proyecto:project declaradas:declared frenar:block', WHERE)];
  } catch (e) {
    if (e instanceof LegacyOptionsError) { a.error = e.message; return a; }
    throw e;
  }
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--repo') a.repo = argv[++i];
    else if (v === '--type') a.tipo = argv[++i];
    else if (v === '--project') a.proyecto = argv[++i];
    else if (v === '--declared') a.declaradas = argv[++i];
    else if (v === '--json') a.json = true;
    else if (v === '--block') a.frenar = true;
    else if (v === '--help' || v === '-h') a.help = true;
    else if (v.startsWith('--')) { a.error = `opción desconocida: ${v}`; }
  }
  return a;
}

const AYUDA = `audit-dependencies.js — el criterio del análisis de dependencias, en un solo lugar.

  --repo <dir>          raíz del repo a analizar (obligatorio)
  --type npm|nuget|pip  qué gestor de paquetes (obligatorio)
  --project <rel>       nuget: el .sln/.csproj a analizar (por defecto, el .sln de la raíz);
                        pip: el archivo de requisitos fijado (por defecto, requirements.txt)
  --declared <rel>      archivo de deuda declarada (por defecto vulnerabilidades-pendientes.json)
  --json                emite el informe completo en JSON por stdout
  --block               sale 1 si hay altas/críticas NO declaradas (el modo del pull request)

Exit: 0 midió · 1 midió y frena · 2 NO PUDO MEDIR (nunca se confunde con "limpio")`;

// ── Deuda declarada ────────────────────────────────────────────────────────────────────────────

/**
 * Lee la declaración de deuda. Devuelve siempre un objeto con forma conocida.
 * 🔴 Un archivo presente pero ILEGIBLE no se trata como "sin declaración": se reporta como
 * ilegible y NO ampara a nadie. Dato malo es peor que dato ausente.
 */
function leerDeclaracion(repo, rel, hoy) {
  const nombre = rel || 'vulnerabilidades-pendientes.json';
  const p = path.join(repo, nombre);
  if (!fs.existsSync(p)) return { existe: false, archivo: nombre, paquetes: {}, vence: null, vencida: false, ilegible: false };
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { existe: true, archivo: nombre, paquetes: {}, vence: null, vencida: true, ilegible: true, error: e.message }; }
  const vence = typeof j.revision === 'string' ? j.revision : null;
  // Sin fecha de vencimiento la declaración no vale: una deuda sin plazo es una deuda permanente.
  const vencida = !vence || vence < hoy;
  const paquetes = {};
  for (const item of Array.isArray(j.paquetes) ? j.paquetes : []) {
    if (item && typeof item.paquete === 'string') paquetes[item.paquete.toLowerCase()] = item;
  }
  return { existe: true, archivo: nombre, paquetes, vence, vencida, ilegible: false, motivo: j.motivo_general || null };
}

// ── Ejecución de la herramienta externa ────────────────────────────────────────────────────────

/** Espera bloqueante, sin dependencias: el guion es sincrónico de punta a punta. */
function esperar(ms) {
  if (!(ms > 0)) return;
  spawnSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms})`]);
}

function correr(cmd, args, cwd, timeoutMs) {
  const real = process.env.TYCON_DEP_CMD || cmd;
  const opts = { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TYCON_DEP_REAL: cmd } };
  if (timeoutMs > 0) opts.timeout = timeoutMs;
  const r = spawnSync(real, args, opts);
  // 🔴 Un registro que NO CONTESTA se corta por tiempo (2026-09-03). Esa noche el registro de
  // avisos se degradó y UNA llamada tardó 267 segundos —medido desde la máquina del dev, otra red,
  // así que no era Azure—. Sin tiempo de espera, el paso por formulario de un producto del equipo (33 llamadas) se
  // comió 40 minutos contra un techo de 60 por trabajo, y el trabajo murió sin veredicto — guides/maintaining/incident-log.md#case-advisory-registry-timeout-2026-09-03.
  // Lo normal es ~1 segundo por formulario; el corte va treinta veces más arriba. Y lo que sale de
  // acá es "no pude medir" con su motivo — nunca un verde.
  if (r.error && (r.error.code === 'ETIMEDOUT' || r.signal)) {
    return { ok: false, motivo: `${cmd} no contestó en ${Math.round(timeoutMs / 1000)}s (el registro de avisos está lento o caído)` };
  }
  if (r.error) return { ok: false, motivo: `no se pudo ejecutar ${cmd}: ${r.error.message}`, salida: '' };
  return { ok: true, code: r.status, salida: (r.stdout || '') + (r.stderr || '') , stdout: r.stdout || '' };
}

// ── npm ────────────────────────────────────────────────────────────────────────────────────────

/**
 * `npm audit --json` contra el lockfile. No hace falta instalar nada: npm resuelve el árbol desde
 * `package-lock.json`. Sin lockfile NO se puede medir — y eso se dice, no se calla.
 *
 * 🔴 El exit code de `npm audit` es 1 cuando ENCUENTRA algo, no cuando falla. Usarlo como señal de
 * error es el error clásico: convierte "hay vulnerabilidades" en "el escaneo se rompió", o al revés.
 * Lo único que decide acá es si el JSON se pudo leer.
 */
function auditarNpm(repo) {
  if (!fs.existsSync(path.join(repo, 'package-lock.json'))) {
    return { medido: false, motivo: 'no hay package-lock.json: npm audit no puede resolver el árbol de dependencias' };
  }
  // 🔴 SE REINTENTA ANTE UN TROPIEZO DEL REGISTRO (2026-09-03). Este análisis es el único de los
  // tres controles de seguridad que pregunta AFUERA, y afuera se cae. Medido ese día: los pull
  // requests 2876 (Totora) y 2877 (URUTAU) quedaron rechazados a las 22:42 con "npm audit reportó
  // un error", mientras Lapacho pasaba un minuto después con el mismo guion y los mismos repos
  // habían pasado a las 21:30. El resto del arnés ya reintenta ante lo transitorio —las imágenes de
  // análisis, el ingreso al host—; esto no, y un tropiezo de red frenaba un cambio sano.
  //
  // 🔴 El reintento acorta la ventana del tropiezo; NO convierte un "no pude medir" en un verde:
  // si tras los intentos sigue sin contestar, se devuelve no-medido igual que antes.
  // 🔴 EL REINTENTO TIENE PRESUPUESTO (2026-09-03, la misma noche que nació). Este guion se llama
  // UNA vez por la raíz pero 33 veces en el bucle por formulario de FRESNO: con el registro caído,
  // 3 intentos con esperas por cada uno convierten un paso de 36 segundos en media hora, contra un
  // techo de 60 minutos por trabajo. Medido esa noche: ese paso pasó de 0,6 a 24+ minutos SÓLO por
  // la lentitud del registro, sin reintentos todavía. Un reintento tiene que ayudar con un tropiezo,
  // no amplificar una caída: pasado el presupuesto se deja de insistir y se dice no-medido.
  const INTENTOS = Number(readEnv('TYCON_DEP_ATTEMPTS', { where: WHERE }) || 3);
  const PRESUPUESTO = Number(readEnv('TYCON_DEP_BUDGET_MS', { where: WHERE }) || 20000);
  const arranque = Date.now();
  let j = null, ultimo = null;
  for (let i = 1; i <= INTENTOS; i++) {
    if (i > 1 && Date.now() - arranque > PRESUPUESTO) {
      ultimo = `${ultimo} — se dejó de insistir a los ${Math.round((Date.now() - arranque) / 1000)}s (presupuesto ${Math.round(PRESUPUESTO / 1000)}s)`;
      break;
    }
    const r = correr('npm', ['audit', '--json'], repo, Number(process.env.TYCON_DEP_TIMEOUT_MS || 30000));
    if (!r.ok) { ultimo = r.motivo; }
    else {
      let parsed = null;
      try { parsed = JSON.parse(r.stdout); }
      catch (e) { ultimo = `la salida de npm audit no es JSON legible (${e.message})`; }
      if (parsed) {
        if (!parsed.error) { j = parsed; break; }
        ultimo = `npm audit reportó un error: ${parsed.error.summary || parsed.error.code || 'sin detalle'}`;
      }
    }
    if (i < INTENTOS) {
      const espera = Math.min(Number(readEnv('TYCON_DEP_WAIT_MS', { where: WHERE }) || 3000) * i,
                              Math.max(0, PRESUPUESTO - (Date.now() - arranque)));
      esperar(espera);
      console.error(`[auditar] el registro de avisos no contestó (intento ${i}/${INTENTOS}): ${ultimo}`);
    }
  }
  if (!j) return { medido: false, motivo: `${ultimo} — tras ${INTENTOS} intento(s)` };

  const hallazgos = [];
  let sinDato = 0;
  for (const [nombre, v] of Object.entries(j.vulnerabilities || {})) {
    const g = gravedad(v.severity);
    if (g.gravedad_sin_dato) sinDato++;
    const advisories = [];
    for (const via of Array.isArray(v.via) ? v.via : []) {
      if (via && typeof via === 'object' && via.url) advisories.push(String(via.url));
    }
    hallazgos.push({ paquete: nombre, ...g, advisories: [...new Set(advisories)].sort(), directa: !!v.isDirect });
  }
  const m = (j.metadata && j.metadata.vulnerabilities) || {};
  return {
    medido: true,
    hallazgos: hallazgos.sort((a, b) => a.paquete.localeCompare(b.paquete)),
    // las de gravedad sin dato no están en el resumen de npm: se suman a las altas, que es como cuentan
    resumen: { critical: m.critical || 0, high: (m.high || 0) + sinDato, moderate: m.moderate || 0, low: m.low || 0 },
  };
}

// `--project` viene de la configuración: una ruta absoluta o con `..` que sale del repo no se mide.
function dentroDelRepo(repo, rel) {
  const r = path.relative(path.resolve(repo), path.resolve(repo, rel));
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
}

// ── NuGet ──────────────────────────────────────────────────────────────────────────────────────

function proyectoNuget(repo, explicito) {
  if (explicito) return explicito;
  const sln = fs.readdirSync(repo).filter((f) => f.endsWith('.sln')).sort();
  return sln.length ? sln[0] : null;
}

/**
 * `dotnet restore` y DESPUÉS `dotnet list package --vulnerable`.
 *
 * 🔴 El restore no es opcional ni un detalle de rendimiento: sin el assets file, `dotnet list
 * --vulnerable` sale 1 con "No assets file was found" y NO MIRA NADA. Ése es literalmente el
 * agujero del backend de un producto del equipo, donde además el 1 se perdía en un `| tee` y el paso salía verde — guides/maintaining/incident-log.md#veredicto-que-cambia-sin-que-cambie-el-codigo-2026-09-01.
 * Acá el restore es un paso propio y su fallo es "no pude medir", nunca "limpio".
 */
function auditarNuget(repo, proyectoRel) {
  const proy = proyectoNuget(repo, proyectoRel);
  if (!proy) return { medido: false, motivo: 'no se encontró un .sln en la raíz y no se indicó --project' };
  if (!dentroDelRepo(repo, proy)) return { medido: false, motivo: `--project ${proy} sale de la carpeta del repo: sólo se mide un proyecto del repo` };
  if (!fs.existsSync(path.join(repo, proy))) return { medido: false, motivo: `no existe el proyecto ${proy}` };

  const rest = correr('dotnet', ['restore', proy, '--nologo'], repo);
  if (!rest.ok) return { medido: false, motivo: rest.motivo };
  if (rest.code !== 0) {
    const pista = (rest.salida || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
    return { medido: false, motivo: `el restore falló (exit ${rest.code}) — sin él el análisis no ve nada: ${pista}` };
  }

  const r = correr('dotnet', ['list', proy, 'package', '--vulnerable', '--include-transitive', '--format', 'json'], repo);
  if (!r.ok) return { medido: false, motivo: r.motivo };
  if (r.code !== 0) {
    const pista = (r.salida || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
    return { medido: false, motivo: `dotnet list package --vulnerable falló (exit ${r.code}): ${pista}` };
  }
  let j;
  try { j = JSON.parse(r.stdout); }
  catch (e) { return { medido: false, motivo: `la salida de dotnet list no es JSON legible (${e.message})` }; }

  // Un paquete puede aparecer en varios proyectos y marcos: se agrupa por paquete, quedándose con
  // la severidad más grave. Contarlo tres veces sería inflar el ruido con el mismo hecho.
  const porPaquete = new Map();
  const orden = { critical: 4, high: 3, moderate: 2, low: 1 };
  for (const proyecto of j.projects || []) {
    for (const fw of proyecto.frameworks || []) {
      for (const grupo of ['topLevelPackages', 'transitivePackages']) {
        for (const pkg of fw[grupo] || []) {
          for (const vul of pkg.vulnerabilities || []) {
            const g = gravedad(vul.severity);
            const sev = g.severidad;
            const clave = pkg.id;
            const prev = porPaquete.get(clave);
            const adv = vul.advisoryurl ? [String(vul.advisoryurl)] : [];
            if (!prev) {
              porPaquete.set(clave, { paquete: clave, ...g, advisories: adv, directa: grupo === 'topLevelPackages' });
            } else {
              // la más grave gana; con empate, una informada gana a la de gravedad sin dato
              if ((orden[sev] || 0) > (orden[prev.severidad] || 0) || ((orden[sev] || 0) === (orden[prev.severidad] || 0) && prev.gravedad_sin_dato && !g.gravedad_sin_dato)) {
                prev.severidad = sev;
                delete prev.gravedad_sin_dato; delete prev.gravedad_informada;
                if (g.gravedad_sin_dato) Object.assign(prev, g);
              }
              prev.advisories = [...new Set([...prev.advisories, ...adv])].sort();
              prev.directa = prev.directa || grupo === 'topLevelPackages';
            }
          }
        }
      }
    }
  }
  const hallazgos = [...porPaquete.values()].sort((a, b) => a.paquete.localeCompare(b.paquete));
  const resumen = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const h of hallazgos) if (resumen[h.severidad] !== undefined) resumen[h.severidad]++;
  return { medido: true, hallazgos, resumen, proyecto: proy };
}

// ── pip ────────────────────────────────────────────────────────────────────────────────────────

/**
 * `pip-audit -r <archivo> --no-deps --disable-pip --format json` contra el archivo de requisitos
 * fijado (`requirements.txt`, o el de `--project`). Como `npm audit` contra el lockfile: no instala
 * nada ni resuelve dependencias. Un requisito sin fijar pip-audit lo rechaza, y eso es «no medido».
 *
 * 🔴 Igual que npm, el exit code no decide: pip-audit sale 1 tanto si encuentra algo como si falla.
 * Decide si el JSON se pudo leer y trae la lista de dependencias.
 *
 * 🔴 pip-audit no informa la gravedad. Cada vulnerabilidad cuenta como ALTA y el hallazgo lo dice
 * (`gravedad_sin_dato`): bajarla a moderada sería callar lo que no se sabe. Si el ruido molesta, la
 * gravedad se le puede pedir a OSV por aviso.
 */
function auditarPip(repo, archivoRel) {
  const archivo = archivoRel || 'requirements.txt';
  if (!dentroDelRepo(repo, archivo)) return { medido: false, motivo: `--project ${archivo} sale de la carpeta del repo: sólo se mide un archivo del repo` };
  if (!fs.existsSync(path.join(repo, archivo))) {
    return { medido: false, motivo: `no hay ${archivo}: pip-audit mide el archivo de requisitos fijado (declaralo con --project si tiene otro nombre)` };
  }
  const r = correr('pip-audit', ['-r', archivo, '--no-deps', '--disable-pip', '--format', 'json'], repo, Number(process.env.TYCON_DEP_TIMEOUT_MS || 30000));
  if (!r.ok) return { medido: false, motivo: r.motivo };
  let j;
  try { j = JSON.parse(r.stdout); } catch (e) {
    const pista = (r.salida || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
    return { medido: false, motivo: `pip-audit no devolvió un JSON legible (exit ${r.code}): ${pista || e.message}` };
  }
  if (!j || !Array.isArray(j.dependencies)) return { medido: false, motivo: 'la salida de pip-audit no trae la lista de dependencias' };
  // Un paquete que pip-audit no pudo revisar viene con `skip_reason` y sin vulnerabilidades: contarlo como limpio sería
  // dar por medido lo que no se miró.
  const salteados = j.dependencies.filter((d) => d && d.skip_reason);
  if (salteados.length) {
    return { medido: false, motivo: `pip-audit no pudo revisar ${salteados.length} paquete(s): ${salteados.slice(0, 5).map((d) => `${d.name} (${String(d.skip_reason).slice(0, 120)})`).join('; ')}` };
  }
  // Una entrada con otra forma (sin nombre, o sin la lista de vulnerabilidades) tampoco se da por limpia.
  // Y una vulnerabilidad sin identificador quedaría «sin aviso propio», amparada por el nombre del paquete.
  const raras = j.dependencies.filter((d) => !d || typeof d.name !== 'string' || !d.name || !Array.isArray(d.vulns)
    || d.vulns.some((v) => !v || typeof v.id !== 'string' || !v.id.trim()));
  if (raras.length) return { medido: false, motivo: `la salida de pip-audit trae ${raras.length} entrada(s) sin nombre, sin la lista de vulnerabilidades o con una vulnerabilidad sin identificador` };
  // Un archivo sin paquetes (`dependencies: []`) sí está medido: no hay nada que revisar.
  const hallazgos = [];
  for (const dep of j.dependencies) {
    const vulns = dep.vulns;
    if (!vulns.length) continue;
    const advisories = [...new Set(vulns.map((v) => String((v && v.id) || '')).filter(Boolean))].sort();
    hallazgos.push({ paquete: String(dep.name), severidad: 'high', gravedad_sin_dato: true, advisories, directa: false });
  }
  hallazgos.sort((a, b) => a.paquete.localeCompare(b.paquete));
  return { medido: true, hallazgos, resumen: { critical: 0, high: hallazgos.length, moderate: 0, low: 0 }, proyecto: archivo };
}

// ── El informe ─────────────────────────────────────────────────────────────────────────────────

function auditar({ repo, tipo, proyecto, declaradas, hoy }) {
  const base = { repo, tipo, medido: false, motivo_no_medido: null, hallazgos: [], no_declaradas: [], resumen: { critical: 0, high: 0, moderate: 0, low: 0 } };
  if (!fs.existsSync(repo)) return { ...base, motivo_no_medido: `no existe el repo ${repo}` };

  const bruto = tipo === 'npm' ? auditarNpm(repo) : tipo === 'pip' ? auditarPip(repo, proyecto) : auditarNuget(repo, proyecto);
  if (!bruto.medido) return { ...base, motivo_no_medido: bruto.motivo };

  const decl = leerDeclaracion(repo, declaradas, hoy);
  const hallazgos = bruto.hallazgos.map((h) => {
    const d = decl.paquetes[h.paquete.toLowerCase()];
    // Una declaración vencida (o ilegible, o sin fecha) NO ampara: vuelve a contar como nuevo.
    //
    // 🔴 LA AMNISTÍA ES POR (PAQUETE, AVISO), NO POR NOMBRE DE PAQUETE (2026-09-03).
    //
    // Antes bastaba con que el NOMBRE figurara: eso amparaba el paquete entero, en todo el repo y
    // para todo aviso futuro. Tres consecuencias medidas: un formulario nuevo que agregara un
    // paquete ya declarado pasaba el control sin que nadie lo mirara; un aviso NUEVO sobre un
    // paquete declarado no despertaba a nadie hasta la fecha de revisión; y un paquete declarado
    // como alto que pasara a crítico seguía amparado. Contradecía lo que la revisión nocturna
    // promete: "lo declarado no despierta y lo vencido vuelve a contar".
    //
    // Ahora la entrada tiene que nombrar los avisos concretos que ampara (campo `advisories`), y
    // sólo ampara al hallazgo si TODOS sus avisos están entre ellos. Un aviso nuevo cae afuera y
    // frena, que es exactamente lo que se quiere.
    //
    // Compatibilidad: una entrada SIN `advisories` no ampara nada. Es a propósito y se midió antes
    // de encenderlo — las 34 declaraciones que existían se anotaron primero, en la misma tanda, y
    // el análisis de los 4 repos quedó en verde. Una entrada sin avisos es una declaración a medias,
    // y una declaración a medias es la puerta por la que volvería el problema.
    // 🔴 Los dos lados se comparan NORMALIZADOS. El análisis informa la dirección completa del
    // aviso (https://github.com/advisories/GHSA-…) y la declaración anota sólo el identificador:
    // comparados en crudo NO coinciden nunca, y el resultado sería "nada está amparado" — un rojo
    // masivo que se leería como "el control se volvió loco". Se compara por el identificador.
    const idAviso = (x) => String(x).trim().replace(/\/+$/, '').split('/').pop().toLowerCase();
    const avisosDeclarados = d && Array.isArray(d.advisories)
      ? new Set(d.advisories.map(idAviso).filter(Boolean))
      : null;
    const avisosDelHallazgo = Array.isArray(h.advisories) ? h.advisories.map(idAviso).filter(Boolean) : [];
    // 🔴 SI EL ANÁLISIS NO DA UN AVISO, NO SE LE PUEDE EXIGIR UNO. Un paquete vulnerable *a través
    // de otro* no tiene aviso propio: npm lo reporta sin identificador. Exigirle uno lo volvía
    // IMPOSIBLE de declarar — quedaría en rojo para siempre, y un control que no se puede satisfacer
    // se apaga. Medido: 3 formularios de 47 caían ahí. En ese caso, y sólo en ese, la declaración
    // ampara por nombre, como antes, y el informe lo dice. Donde SÍ hay aviso —la enorme mayoría—
    // la regla apretada rige, que es donde estaba el agujero.
    const sinAvisoPropio = avisosDelHallazgo.length === 0;
    const todosAmparados = !!avisosDeclarados
      && (sinAvisoPropio || avisosDelHallazgo.every((x) => avisosDeclarados.has(x)));
    const amparada = !!d && !decl.vencida && todosAmparados;
    const porQueNo = !d ? null
      : decl.vencida ? 'la declaración venció'
      : !avisosDeclarados ? 'la declaración no dice QUÉ avisos ampara (campo advisories)'
      : todosAmparados ? null
      : `hay aviso(s) que la declaración no ampara: ${avisosDelHallazgo.filter((x) => !avisosDeclarados.has(x)).join(', ')}`;
    return { ...h, declarada: amparada, no_amparada_porque: amparada ? null : porQueNo, declaracion: amparada ? { motivo: d.origen || d.motivo || null, viaja_al_navegador: d.viaja_al_navegador, advisories: [...avisosDeclarados], amparada_por_nombre: sinAvisoPropio || undefined } : null };
  });
  const no_declaradas = hallazgos.filter((h) => SEVERIDADES_GRAVES.includes(h.severidad) && !h.declarada).map((h) => h.paquete);

  return {
    ...base,
    medido: true,
    proyecto: bruto.proyecto || null,
    hallazgos,
    resumen: bruto.resumen,
    no_declaradas,
    declaracion: { existe: decl.existe, archivo: decl.archivo, vence: decl.vence, vencida: decl.vencida, ilegible: decl.ilegible, paquetes: Object.keys(decl.paquetes).length },
  };
}

// ── Presentación ───────────────────────────────────────────────────────────────────────────────

function imprimirHumano(inf) {
  if (!inf.medido) {
    console.log(`🚧 NO MEDIDO — ${inf.repo} (${inf.tipo}): ${inf.motivo_no_medido}`);
    console.log('   No medido y limpio son cosas distintas. Esto no es un veredicto.');
    return;
  }
  const r = inf.resumen;
  console.log(`${inf.repo} (${inf.tipo}) — crít ${r.critical} · alta ${r.high} · mod ${r.moderate} · baja ${r.low}`);
  if (inf.declaracion.ilegible) console.log(`   ⚠️ ${inf.declaracion.archivo} está presente pero ILEGIBLE: no ampara a nadie.`);
  else if (inf.declaracion.existe && inf.declaracion.vencida) console.log(`   ⚠️ la deuda declarada venció el ${inf.declaracion.vence || '<sin fecha>'}: todo vuelve a contar como nuevo.`);
  else if (inf.declaracion.existe) console.log(`   ${inf.declaracion.paquetes} declarada(s) como deuda hasta el ${inf.declaracion.vence}.`);
  for (const h of inf.hallazgos.filter((x) => SEVERIDADES_GRAVES.includes(x.severidad))) {
    console.log(`   ${h.declarada ? '·' : '🔴'} ${h.paquete} [${h.severidad}${h.gravedad_sin_dato ? `, gravedad sin dato: ${GESTOR[inf.tipo] || inf.tipo} no la informa` : ''}]${h.declarada ? ' (declarada)' : ''} ${h.advisories[0] || ''}`);
  }
  if (inf.no_declaradas.length) console.log(`   NO declaradas: ${inf.no_declaradas.join(', ')}`);
}

function main() {
  const a = parseArgs(process.argv);
  if (a.help) { console.log(AYUDA); return 0; }
  if (a.error) { console.error(`error: ${a.error}\n\n${AYUDA}`); return 2; }
  if (!a.repo || !a.tipo) { console.error(`error: faltan --repo y/o --type\n\n${AYUDA}`); return 2; }
  if (!['npm', 'nuget', 'pip'].includes(a.tipo)) { console.error(`error: --type tiene que ser npm, nuget o pip\n\n${AYUDA}`); return 2; }

  const hoy = readEnv('TYCON_DEP_TODAY', { where: WHERE }) || new Date().toISOString().slice(0, 10);
  const inf = auditar({ repo: path.resolve(a.repo), tipo: a.tipo, proyecto: a.proyecto, declaradas: a.declaradas, hoy });

  if (a.json) console.log(JSON.stringify(inf, null, 2));
  else imprimirHumano(inf);

  if (!inf.medido) return 2;                                   // no pude medir ≠ limpio
  if (a.frenar && inf.no_declaradas.length) return 1;          // el modo del pull request
  return 0;
}

// 🔴 `process.exitCode`, NO `process.exit()` (2026-09-28). Cuando la salida va a una tubería
// —y ahí va siempre: el nocturno invoca este guión con spawnSync y le parsea el JSON— las
// escrituras de Node son ASINCRÓNICAS, y `process.exit()` mata el proceso con parte del
// informe todavía sin escribir. Medido: un informe de 9782 bytes llegaba CORTADO en 8192, el
// JSON no parseaba y el repo salía «no devolvió JSON legible (exit 0)», o sea NO MEDIDO — con
// un motivo que no nombra la causa real. Sólo se notaba con informes de más de 8 KB, así que
// los 8 repos que ya estaban (pocos hallazgos cada uno) nunca lo dispararon: apareció con el
// primero grande. Con `exitCode` el proceso termina solo cuando terminó de escribir.
// Caso: guides/maintaining/incident-log.md#informe-cortado-por-la-tuberia-2026-09-28
if (require.main === module) process.exitCode = main();
module.exports = { auditar, leerDeclaracion, parseArgs, SEVERIDADES_GRAVES };
