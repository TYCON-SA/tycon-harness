#!/usr/bin/env node
'use strict';
/**
 * ¿La condición de cada etapa (y de cada job) dice la verdad sobre de qué depende?
 *
 * 🔴 POR QUÉ EXISTE.
 *
 * En Azure DevOps hay DOS maneras de que una etapa quede mal enganchada, y NINGUNA da error:
 * el pipeline corre, se ve verde, y falla el día que alguien reordena las etapas.
 *
 *   (a) LA CONDICIÓN NOMBRA UNA ETAPA DE LA QUE NO DEPENDE.
 *       `dependsOn: Build` + `condition: ... in(dependencies.TraerArnes.result, ...)`.
 *       Anda de casualidad: ADO resuelve dependencias TRANSITIVAS (si Build depende de
 *       TraerArnes, Deploy la alcanza). El día que Build deje de depender de TraerArnes, la
 *       condición pasa a evaluar contra la nada. Ejemplo: el Deploy del backend de un producto.
 *
 *   (b) 🔴 LA PEOR: DEPENDE DE UNA ETAPA QUE SU CONDICIÓN NO NOMBRA.
 *       Un `condition:` explícito REEMPLAZA al `succeeded()` implícito — `dependsOn` a secas
 *       sólo ORDENA. O sea que `dependsOn: [Pruebas, Build]` con una condición que sólo mira
 *       `Build` deja pasar el empaquetado CON LAS PRUEBAS EN ROJO. Es exactamente el agujero
 *       que el flujo canónico existe para cerrar, y se ve idéntico a un pipeline correcto.
 *
 * Sin condición explícita NO hay hallazgo en (a)/(b): ahí rige `succeeded()`, que es lo correcto
 * por default. Esas dos reglas sólo juzgan a quien escribió una condición propia.
 *
 *   (c) 🔴 `succeeded()` SOBRE UNA DEPENDENCIA QUE TIENE CONDICIÓN PROPIA. Si la dependencia queda `Skipped` porque
 *       su condición dio falso, `succeeded()` —el implícito de no escribir condición, o el
 *       explícito— se envenena y el dependiente TAMBIÉN se saltea, sin ponerse rojo. Ejemplo:
 *       `ActivatePlugin` (y el humo adentro) depende de `RecycleAppPool`, que sólo corre si el
 *       upload devuelve 200; con un 409 el reciclado se saltea, la activación se saltea, el
 *       humo no corre y el stage queda VERDE. La única forma de no pisar esa trampa es nombrar
 *       a esa dependencia en la condición diciendo qué resultados se aceptan (incluido `Skipped`
 *       si corresponde). Esta regla aplica a etapas Y a jobs.
 *
 *   🔴 Por qué (a) y (b) NO se copian a los jobs: los jobs sin
 *   `dependsOn` corren EN PARALELO —no cuelgan del anterior como las etapas—, y un
 *   `condition: succeeded()` explícito SÍ honra a las dependencias. Copiar (a)/(b) tal cual daría
 *   falsos positivos y no describiría el defecto real de los jobs, que es (c).
 *
 * Uso:  node check-stage-dependencies.js [ruta ...]
 *       Sin argumentos revisa los `azure-pipelines*.yml` del repo donde corre.
 * Sale 0 si está limpio · 1 si hay hallazgos · 2 si no pudo leer algo (ilegible NO es aprobado).
 */
const fs = require('fs');
const path = require('path');

function buscarPipelines(raiz) {
  const out = [];
  const mira = (dir, prof) => {
    if (prof > 2) return;
    let e = [];
    try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const x of e) {
      if (x.name.startsWith('.') || x.name === 'node_modules') continue;
      const p = path.join(dir, x.name);
      if (x.isDirectory()) mira(p, prof + 1);
      else if (/^azure-pipelines.*\.ya?ml$/i.test(x.name)) out.push(p);
    }
  };
  mira(raiz, 0);
  return out.sort();
}

/** `dependsOn:` en sus tres formas: inline, lista `[a, b]`, o lista en varias líneas (indentItem espacios). */
function parsearDependsOn(lineas, i, valor, indentItem) {
  const v = valor.trim();
  if (v === '') {
    const items = [];
    const rx = new RegExp(`^ {${indentItem}}-\\s*(['"]?)([A-Za-z0-9_]+)\\1\\s*$`);
    for (let j = i + 1; j < lineas.length; j++) {
      const it = lineas[j].match(rx);
      if (!it) break;
      items.push(it[2]);
    }
    return items;
  }
  if (v.startsWith('[')) {
    return v.replace(/^\[|\]$/g, '').split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return [v.replace(/^['"]|['"]$/g, '')];
}

/** Una condición puede seguir en las líneas siguientes si quedaron paréntesis abiertos. */
function parsearCondition(lineas, i, valor) {
  let txt = valor;
  let abre = (txt.match(/\(/g) || []).length, cierra = (txt.match(/\)/g) || []).length;
  let j = i, guarda = 0;
  while (abre > cierra && guarda < 20) {
    j++; guarda++;
    if (j >= lineas.length) break;
    txt += ' ' + lineas[j].trim();
    abre = (txt.match(/\(/g) || []).length; cierra = (txt.match(/\)/g) || []).length;
  }
  return { condition: abre === cierra ? txt : null, ilegible: abre !== cierra };
}

/**
 * Lee nodos (`- stage:` a 2 espacios, o `- job:`/`- deployment:` a 6) sin depender de un parser
 * de YAML: el formato de estos archivos es regular. Sólo mira las claves del propio nodo (a
 * `indent + 2` espacios); lo que está más adentro es de otro nivel y no interesa.
 */
function leerNodos(lineas, desde, hasta, indent, claves) {
  const nodos = [];
  let actual = null;
  const rxItem = new RegExp(`^ {${indent}}- (?:${claves.join('|')}):\\s*(['"]?)([A-Za-z0-9_]+)\\1\\s*(?:#.*)?$`);
  const rxDep = new RegExp(`^ {${indent + 2}}dependsOn:\\s*(.*)$`);
  const rxCon = new RegExp(`^ {${indent + 2}}condition:\\s*(.*)$`);
  for (let i = desde; i < hasta; i++) {
    const l = lineas[i];
    const m = l.match(rxItem);
    if (m) { actual = { nombre: m[2], dependsOn: null, condition: null, linea: i + 1, inicio: i }; nodos.push(actual); continue; }
    if (!actual) continue;
    const dep = l.match(rxDep);
    if (dep) { actual.dependsOn = parsearDependsOn(lineas, i, dep[1], indent + 4); continue; }
    const con = l.match(rxCon);
    if (con) {
      const r = parsearCondition(lineas, i, con[1]);
      actual.condition = r.condition;
      actual.condicionIlegible = r.ilegible;
    }
  }
  nodos.forEach((n, idx) => { n.fin = idx + 1 < nodos.length ? nodos[idx + 1].inicio : hasta; });
  return nodos;
}

function leerEtapas(texto) {
  const lineas = texto.split('\n');
  const etapas = leerNodos(lineas, 0, lineas.length, 2, ['stage']);
  for (const e of etapas) e.jobs = leerNodos(lineas, e.inicio, e.fin, 6, ['job', 'deployment']);
  return etapas;
}

/** Regla (c): `succeeded()` —implícito o explícito— sobre una dependencia con condición propia. */
function salteosEnSilencio(nodo, efectivas, porNombre, tipo) {
  const out = [];
  for (const d of efectivas) {
    const D = porNombre[d];
    if (!D || !D.condition) continue;                   // la dependencia corre siempre: nada que temer
    const laNombra = nodo.condition && new RegExp(`dependencies\\.${d}\\.result`).test(nodo.condition);
    const usaSucceeded = !nodo.condition || /\bsucceeded\(\)/.test(nodo.condition);
    if (laNombra || !usaSucceeded) continue;
    out.push({ etapa: nodo.nombre, linea: nodo.linea, tipo: 'salteo-en-silencio',
      texto: `🔴 ${tipo} depende de \`${d}\`, que tiene condición propia, y usa \`succeeded()\`${nodo.condition ? '' : ' (implícito: no escribió condición)'}:` +
             ` si \`${d}\` queda Skipped, ${tipo === 'el job' ? 'este job' : 'esta etapa'} se saltea también y nada se pone rojo. Nombrala en la condición diciendo qué resultados aceptás (incluido 'Skipped' si corresponde).` });
  }
  return out;
}

function revisar(archivo) {
  const texto = fs.readFileSync(archivo, 'utf8');
  if (!/^stages:/m.test(texto)) return { archivo, hallazgos: [], sinEtapas: true };
  const etapas = leerEtapas(texto);
  const orden = etapas.map((e) => e.nombre);
  const porEtapa = Object.fromEntries(etapas.map((e) => [e.nombre, e]));
  const hallazgos = [];
  etapas.forEach((e, idx) => {
    if (e.condicionIlegible) {
      hallazgos.push({ etapa: e.nombre, linea: e.linea, tipo: 'ilegible',
        texto: 'no pude leer su condición entera — y un control que no puede leer NO aprueba' });
      return;
    }
    // Sin `dependsOn` explícito, ADO cuelga la ETAPA de la anterior (los jobs no: corren en paralelo).
    const efectivas = e.dependsOn !== null ? e.dependsOn : (idx > 0 ? [orden[idx - 1]] : []);
    hallazgos.push(...salteosEnSilencio(e, efectivas, porEtapa, 'la etapa'));

    if (e.condition) {   // (a) y (b) sólo juzgan a quien escribió una condición propia
      const nombradas = [...new Set([...e.condition.matchAll(/dependencies\.([A-Za-z0-9_]+)\./g)].map((m) => m[1]))];
      const fantasma = nombradas.filter((n) => !efectivas.includes(n));
      if (fantasma.length) {
        hallazgos.push({ etapa: e.nombre, linea: e.linea, tipo: 'nombra-sin-depender',
          texto: `su condición mira ${fantasma.join(', ')} pero no depende de ${fantasma.length > 1 ? 'ellas' : 'ella'}` +
                 ` (depende de: ${efectivas.join(', ') || 'nada'}). Anda mientras la dependencia sea INDIRECTA; el día que eso cambie, la condición evalúa contra la nada.` });
      }
      const mudas = efectivas.filter((n) => !nombradas.includes(n));
      if (mudas.length) {
        hallazgos.push({ etapa: e.nombre, linea: e.linea, tipo: 'depende-en-silencio',
          texto: `🔴 depende de ${mudas.join(', ')} pero su condición NO ${mudas.length > 1 ? 'las' : 'la'} nombra:` +
                 ` ${mudas.length > 1 ? 'pueden fallar' : 'puede fallar'} y esta etapa corre igual. Un \`condition:\` explícito REEMPLAZA al \`succeeded()\` implícito; \`dependsOn\` a secas sólo ordena.` });
      }
    }

    // Jobs: sólo la regla (c). Un job sin dependsOn no cuelga de nadie.
    const porJob = Object.fromEntries((e.jobs || []).map((j) => [j.nombre, j]));
    for (const j of e.jobs || []) {
      if (j.condicionIlegible) {
        hallazgos.push({ etapa: `${e.nombre} › ${j.nombre}`, linea: j.linea, tipo: 'ilegible',
          texto: 'no pude leer la condición entera del job — y un control que no puede leer NO aprueba' });
        continue;
      }
      const h = salteosEnSilencio(j, j.dependsOn || [], porJob, 'el job');
      h.forEach((x) => { x.etapa = `${e.nombre} › ${j.nombre}`; });
      hallazgos.push(...h);
    }
  });
  return { archivo, hallazgos };
}

function main(args) {
  const objetivos = args.length ? args : buscarPipelines(process.cwd());
  if (!objetivos.length) { console.log('sin pipelines que revisar'); return 0; }
  let hallazgos = 0, ilegibles = 0, revisados = 0;
  for (const f of objetivos) {
    let r;
    try { r = revisar(f); }
    catch (e) { console.log(`🔴 ${f}: no se pudo leer (${e.message}) — ilegible NO es aprobado`); ilegibles++; continue; }
    if (r.sinEtapas) continue;
    revisados++;
    if (!r.hallazgos.length) continue;
    console.log(`\n🔴 ${path.relative(process.cwd(), f) || f}`);
    for (const h of r.hallazgos) {
      if (h.tipo === 'ilegible') ilegibles++; else hallazgos++;
      console.log(`   · [${h.tipo}] \`${h.etapa}\` (línea ${h.linea}): ${h.texto}`);
    }
  }
  if (!hallazgos && !ilegibles) { console.log(`✅ dependencias de etapas: ${revisados} pipeline(s) coherentes`); return 0; }
  console.log(`\n${hallazgos} hallazgo(s) · ${ilegibles} ilegible(s), sobre ${revisados} pipeline(s)`);
  return ilegibles && !hallazgos ? 2 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { revisar, leerEtapas, buscarPipelines };
