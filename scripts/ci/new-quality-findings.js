#!/usr/bin/env node
'use strict';
/**
 * scripts/ci/new-quality-findings.js — avisa, en la CI de un pedido, los hallazgos de calidad de CodeQL que el pedido agrega.
 *
 * POR QUÉ EXISTE. Los hallazgos de calidad (una variable sin usar, un argumento de más que se ignora, una asignación
 * inútil) no son alertas de seguridad: la regla de main no los mira y la consulta de GitHub que los lista sólo da los de
 * main. Un pedido los metía sin que nadie lo viera.
 *
 * QUÉ HACE. Lo corre .github/workflows/code-scanning.yml en un pull request, después de analizar JavaScript: lee el
 * resultado del conjunto de calidad (SARIF) y se queda con los hallazgos que caen en renglones que el pedido agrega o
 * cambia (`git diff -U0 <base> HEAD`). Cada uno sale como anotación de aviso y en el resumen del trabajo. Un hallazgo en
 * un renglón que el pedido no tocó es de antes y no se avisa.
 *
 * NUNCA ES ROJO: sale 0 siempre. Si no puede medir (no está el resultado, no se lee, o no hay base contra la cual
 * comparar) lo dice como aviso, «NO MEDIDA», en vez de callarse: no medido no es limpio.
 *
 * Uso: node scripts/ci/new-quality-findings.js --sarif <archivo> --base <commit> [--root <carpeta del repo>]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOPE_DE_ANOTACIONES = 50;

/** La ruta de un `+++ b/...` sin el prefijo ni las comillas de git; `null` para `/dev/null`. */
function rutaDelDiff(raw) {
  let r = raw.trim();
  if (r.startsWith('"') && r.endsWith('"')) r = JSON.parse(r);
  if (r === '/dev/null') return null;
  return r.replace(/^b\//, '');
}

/** Los renglones que el pedido agrega o cambia: `Map<archivo, Set<renglón>>`, desde un `git diff -U0`. */
function changedLines(diff) {
  const out = new Map();
  let file = null;
  let anterior = '';
  for (const l of String(diff).split('\n')) {
    // la cabecera `+++` va justo después de su `---`: un renglón agregado que empieza con `++` no es una cabecera
    const esCabecera = l.startsWith('+++ ') && anterior.startsWith('--- ');
    anterior = l;
    if (esCabecera) { file = rutaDelDiff(l.slice(4)); continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (!m || !file) continue;
    const desde = Number(m[1]);
    const cuantos = m[2] === undefined ? 1 : Number(m[2]);
    if (!cuantos) continue;
    if (!out.has(file)) out.set(file, new Set());
    for (let i = 0; i < cuantos; i++) out.get(file).add(desde + i);
  }
  return out;
}

/** La ruta de un resultado relativa al repo: sin `./`, y sin el `file://<raíz>/` de una URI absoluta. */
function rutaDelResultado(uri, root) {
  let u = String(uri || '');
  // las URIs del SARIF vienen codificadas (`%20`, `%5B`, `%C3%B1`): se decodifican todas, no sólo las `file://`
  try { u = decodeURIComponent(u); } catch { /* una URI mal codificada queda como vino */ }
  if (u.startsWith('file://')) {
    u = u.slice('file://'.length);
    if (root && u.startsWith(`${root.replace(/\/$/, '')}/`)) u = u.slice(root.replace(/\/$/, '').length + 1);
  }
  return u.replace(/^\.\//, '');
}

/** Los hallazgos del SARIF que caen en renglones del pedido: `[{ file, line, rule, message }]`. */
function newFindings(sarif, changed, { root = '' } = {}) {
  const out = [];
  for (const run of (sarif && sarif.runs) || []) {
    for (const r of run.results || []) {
      const loc = r.locations && r.locations[0] && r.locations[0].physicalLocation;
      if (!loc || !loc.artifactLocation || !loc.region) continue;
      const file = rutaDelResultado(loc.artifactLocation.uri, root);
      const line = loc.region.startLine;
      if (!changed.has(file) || !changed.get(file).has(line)) continue;
      out.push({ file, line, rule: r.ruleId || (r.rule && r.rule.id) || '(sin regla)', message: (r.message && r.message.text) || '' });
    }
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

// los comandos de anotación de GitHub: en el texto se escapan `%`, `\r` y `\n`; en las propiedades, además `:` y `,`
const dato = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const propiedad = (s) => dato(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function resumen(texto) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  try { fs.appendFileSync(f, `${texto}\n`); } catch { /* sin resumen, quedan las anotaciones */ }
}

function noMedida(motivo) {
  console.log(`::warning title=Calidad de CodeQL NO MEDIDA::${dato(`no se pudo ver si el pedido agrega hallazgos de calidad: ${motivo}`)}`);
  resumen(`### Calidad de CodeQL\n\nNo medida: ${motivo}. No medido no es limpio.`);
}

function main(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const sarifFile = arg('--sarif');
  const base = arg('--base');
  const root = arg('--root') || process.cwd();
  if (!sarifFile || !base) { noMedida('faltan --sarif o --base'); return; }
  let sarif;
  try { sarif = JSON.parse(fs.readFileSync(sarifFile, 'utf8')); } catch (e) { noMedida(`el resultado del análisis (${path.basename(sarifFile)}) no se lee: ${e.code || e.message}`); return; }
  // un resultado sin ninguna corrida no es «sin hallazgos»: el análisis no dejó nada que leer
  if (!sarif || !Array.isArray(sarif.runs) || !sarif.runs.length) { noMedida('el resultado del análisis no trae ninguna corrida'); return; }
  let diff;
  try {
    diff = execFileSync('git', ['-C', root, '-c', 'core.quotepath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', base, 'HEAD'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { noMedida(`no puedo comparar con la base ${String(base).slice(0, 12)}: ${String(e.stderr || e.message).trim().split('\n')[0]}`); return; }
  const nuevos = newFindings(sarif, changedLines(diff), { root });
  if (!nuevos.length) { resumen('### Calidad de CodeQL\n\nSin hallazgos de calidad nuevos en los renglones del pedido.'); return; }
  for (const f of nuevos.slice(0, TOPE_DE_ANOTACIONES)) {
    console.log(`::warning file=${propiedad(f.file)},line=${f.line},title=${propiedad(`CodeQL calidad (${f.rule})`)}::${dato(f.message)}`);
  }
  const filas = nuevos.map((f) => `- \`${f.file}:${f.line}\` · ${f.rule} · ${f.message.replace(/\s+/g, ' ')}`);
  resumen(`### Calidad de CodeQL\n\n${nuevos.length} hallazgo(s) de calidad nuevo(s) en los renglones del pedido (aviso, no frena):\n\n${filas.join('\n')}`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { noMedida(`el aviso falló: ${e.message}`); }
  process.exit(0);
}

module.exports = { changedLines, newFindings, rutaDelResultado };
