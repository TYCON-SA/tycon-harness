#!/usr/bin/env node
'use strict';
// stub-pipeline-steps.js — deja un pipeline de Azure DevOps con la MISMA cadena de etapas,
// jobs, dependencias y condiciones, pero con cada paso reemplazado por un `echo`, para que el
// corredor local (Runner.Client) pueda recorrer la cadena entera sin ejecutar nada de verdad.
//
// 🔴 POR QUÉ EXISTE. El corredor local sin agente sólo evalúa las condiciones de la
// PRIMERA capa: un job que tiene pasos y nadie que los ejecute termina `Failed`, y todo lo que
// depende de él se saltea en cascada. Al simular `main`, `Build` y `Deploy` se saltan — no porque su condición esté
// mal, sino porque `Pruebas` "falló". O sea que la condición de `Deploy` —la que más cuesta cuando está mal— no se
// puede probar sin una corrida real. Con los pasos vaciados y `-P ubuntu-latest=-`, cada job termina
// bien en segundos y la cadena se evalúa completa; con `--fail` se hace fallar UN paso a
// propósito y se ve que corta lo que tiene que cortar (Pruebas en rojo → Build no arma).
//
// QUÉ CONSERVA de cada paso: `displayName`, `name` (los pasos siguientes leen sus salidas),
// `condition` y `continueOnError`. Las variables que el paso original publicaba con
// `##vso[task.setvariable ...]` se vuelven a publicar con valor `true` (o el que se pase con
// `--output NOMBRE=VALOR`), porque las condiciones de más adelante las leen.
//
// QUÉ NO HACE: no interpreta YAML (recorre líneas por indentación). Todo lo que está fuera de un
// bloque `steps:` viaja intacto. Un pipeline que no se pueda recorrer sale 2, no 0.
//
// Uso:
//   node stub-pipeline-steps.js <azure-pipelines.yml> [--a <salida.yml>]
//        [--fail <regex sobre displayName|name>] [--output NOMBRE=VALOR ...]
//   (--fail y --output tienen también su nombre en castellano; los viejos siguen andando hasta
//   el retiro. La vieja y la nueva juntas salen 2.)
//
// Casos: scripts/tests/stub-pipeline-steps.test.sh

const fs = require('fs');
// El traductor de las opciones viejas vive al lado y viaja con este archivo en el artefacto arnes-ci.
const { aliasLegacyOptions, LegacyOptionsError } = (() => {
  try { return require('./legacy-options.js'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') process.stderr.write(`⚠️  legacy-options.js no cargó (${e && e.message}): los nombres viejos de este guion no se traducen\n`); return { aliasLegacyOptions: (argv) => argv, LegacyOptionsError: Error }; }
})();

function args(argv) {
  const o = { fallar: null, salidas: {}, a: null, archivo: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--fail') o.fallar = new RegExp(argv[++i]);
    else if (x === '--output') { const [k, ...v] = String(argv[++i]).split('='); o.salidas[k] = v.join('='); }
    else if (x === '--a') o.a = argv[++i];
    else if (x === '--help' || x === '-h') { o.help = true; }
    else if (!o.archivo) o.archivo = x;
    else { console.error(`argumento de más: ${x}`); process.exit(2); }
  }
  return o;
}

function indentDe(l) { return l.match(/^ */)[0].length; }
function esVacia(l) { return /^\s*$/.test(l); }
function esComentario(l) { return /^\s*#/.test(l); }

// Lee el valor escalar de `clave:` dentro de las líneas de un item, en la indentación de sus
// claves. Devuelve las líneas tal cual (puede ser un bloque `|`/`>` de varias líneas).
function claveDelItem(lineas, indClave, clave) {
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    const m = l.match(new RegExp(`^ {${indClave}}(?:- )?${clave}:(.*)$`));
    if (!m) continue;
    // la primera línea del item es `- clave: valor`: la clave viene a indClave-2 con el guion
    const valor = m[1];
    if (/^\s*[|>][-+]?\s*(#.*)?$/.test(valor)) {
      const bloque = [l];
      for (let j = i + 1; j < lineas.length; j++) {
        if (esVacia(lineas[j]) || indentDe(lineas[j]) > indClave) bloque.push(lineas[j]); else break;
      }
      return bloque;
    }
    return [l];
  }
  return null;
}

function escalar(lineasClave) {
  if (!lineasClave || lineasClave.length !== 1) return null;
  const m = lineasClave[0].match(/^\s*(?:- )?[A-Za-z]+:\s*(.*?)\s*$/);
  if (!m) return null;
  let v = m[1];
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function comilla(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function vaciar(texto, opciones) {
  const lineas = texto.split('\n');
  const salida = [];
  let i = 0;
  let items = 0;
  while (i < lineas.length) {
    const l = lineas[i];
    const mSteps = l.match(/^( *)steps:\s*(#.*)?$/);
    if (!mSteps) { salida.push(l); i++; continue; }
    salida.push(l);
    i++;
    const indSteps = mSteps[1].length;
    // la indentación de los items la dicta la primera línea real que sigue
    let j = i;
    while (j < lineas.length && (esVacia(lineas[j]) || esComentario(lineas[j]))) j++;
    if (j >= lineas.length || !/^ *- /.test(lineas[j]) || indentDe(lineas[j]) < indSteps) continue; // `steps: []`, plantilla, etc.
    const indItem = indentDe(lineas[j]);
    const indClave = indItem + 2;
    // recorre los items
    let buffer = []; // comentarios/vacías entre items, decididos después
    while (i < lineas.length) {
      const x = lineas[i];
      if (esVacia(x) || esComentario(x)) { buffer.push(x); i++; continue; }
      const ind = indentDe(x);
      const arrancaItem = ind === indItem && /^ *- /.test(x);
      if (!arrancaItem) break; // se acabó el bloque (menor indentación o clave hermana)
      buffer = []; // los comentarios entre items se van con el paso vaciado
      const item = [x];
      i++;
      while (i < lineas.length) {
        const y = lineas[i];
        if (esVacia(y) || esComentario(y)) { item.push(y); i++; continue; }
        const iy = indentDe(y);
        if (iy < indItem || (iy === indItem && /^ *- /.test(y)) || (iy === indItem)) break;
        item.push(y); i++;
      }
      // los vacíos/comentarios finales del item vuelven al buffer para decidir después
      while (item.length && (esVacia(item[item.length - 1]) || esComentario(item[item.length - 1]))) buffer.unshift(item.pop());
      salida.push(...reemplazo(item, indItem, indClave, opciones));
      items++;
    }
    salida.push(...buffer);
  }
  return { texto: salida.join('\n'), items };
}

function reemplazo(item, indItem, indClave, opciones) {
  const p = ' '.repeat(indItem);
  const k = ' '.repeat(indClave);
  const displayName = escalar(claveDelItem(item, indClave, 'displayName'));
  const name = escalar(claveDelItem(item, indClave, 'name'));
  const condicion = claveDelItem(item, indClave, 'condition');
  const continueOnError = escalar(claveDelItem(item, indClave, 'continueOnError'));
  const primera = item[0].match(/^ *- ([A-Za-z${][^:]*):?\s*(.*)$/);
  const etiqueta = displayName || (primera ? `${primera[1]}${primera[2] ? ' ' + primera[2] : ''}` : 'paso');
  const cuerpo = item.join('\n');
  const variables = new Map();
  for (const m of cuerpo.matchAll(/task\.setvariable variable=([A-Za-z_][A-Za-z0-9_]*)(;isOutput=true)?\]/g)) {
    const actual = variables.get(m[1]) || false;
    variables.set(m[1], actual || !!m[2]);
  }
  const falla = !!(opciones.fallar && (opciones.fallar.test(etiqueta) || (name && opciones.fallar.test(name))));
  const out = [];
  out.push(`${p}- script: |`);
  out.push(`${k}  echo "[vaciado] ${etiqueta.replace(/"/g, '\\"')}"`);
  for (const [v, esSalida] of variables) {
    const valor = Object.prototype.hasOwnProperty.call(opciones.salidas, v) ? opciones.salidas[v] : 'true';
    out.push(`${k}  echo "##vso[task.setvariable variable=${v}${esSalida ? ';isOutput=true' : ''}]${valor}"`);
  }
  if (falla) out.push(`${k}  echo "[vaciado] FALLA A PROPÓSITO (--fail)"; exit 1`);
  out.push(`${k}displayName: ${comilla(etiqueta)}`);
  if (name) out.push(`${k}name: ${name}`);
  if (condicion) out.push(...condicion.map(c => c.replace(/^ *- /, '  '))); // por si venía en la primera línea
  if (continueOnError) out.push(`${k}continueOnError: ${continueOnError}`);
  return out;
}

function main() {
  let argv;
  try { argv = aliasLegacyOptions(process.argv.slice(2), 'fallar:fail salida:output', 'scripts/ci/stub-pipeline-steps.js'); }
  catch (e) {
    if (!(e instanceof LegacyOptionsError)) throw e;
    console.error(e.message); process.exit(2);
  }
  const o = args(argv);
  if (o.help || !o.archivo) {
    console.log('Uso: stub-pipeline-steps.js <azure-pipelines.yml> [--a <salida.yml>] [--fail <regex>] [--output NOMBRE=VALOR ...]');
    process.exit(o.help ? 0 : 2);
  }
  let texto;
  try { texto = fs.readFileSync(o.archivo, 'utf8'); } catch (e) { console.error(`no pude leer ${o.archivo}: ${e.message}`); process.exit(2); }
  const r = vaciar(texto, o);
  if (r.items === 0) { console.error(`${o.archivo}: no encontré ningún paso que vaciar — ¿es un pipeline?`); process.exit(2); }
  if (o.fallar) {
    if (!r.texto.includes('FALLA A PROPÓSITO')) { console.error(`--fail ${o.fallar}: ningún paso coincide — la prueba no probaría nada`); process.exit(2); }
  }
  if (o.a) fs.writeFileSync(o.a, r.texto); else process.stdout.write(r.texto);
  console.error(`${r.items} paso(s) vaciado(s)${o.fallar ? ', uno o más fallan a propósito' : ''}`);
}

if (require.main === module) main();
module.exports = { vaciar };
