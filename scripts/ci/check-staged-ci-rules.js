#!/usr/bin/env node
'use strict';
// check-staged-ci-rules.js — tres reglas que hasta acá sólo veía la CI pública, ahora antes del commit, sobre lo que el
// commit trae (el índice, no el disco).
//
// Por qué: las tres salieron rojas en la CI pública después de pasar por la máquina, varias veces en una semana. Un rojo
// en la CI cuesta una vuelta entera (empujar, esperar, arreglar, empujar); en la máquina, diez segundos.
//   1. `| grep -q` en un guion .sh con pipefail (scripts/lib/grep-q-pipefail.js; la prueba: grep-q-pipefail.test.js).
//   2. Una prueba nueva o tocada que crea commits sin fechas fijas ni el mantenimiento automático de git apagado, o que
//      lee el reloj sin inyectar la fecha ni declarar «stable-data: <motivo>» (scripts/lib/stable-test-data.js; la
//      prueba: stable-test-data.test.js). Las de la lista de las que ya existían pasan, como en la prueba; una de la
//      lista que ya cumple pide salir de la lista.
//   3. El conteo del catálogo de reglas, cuando el commit toca agents/ o el catálogo (scripts/lib/rules-catalog-count.js;
//      la prueba: el caso C5 de rules-catalog.test.sh).
//   4. Ésta la veía sólo la revisión de la noche: el inventario de los controles contra el pre-commit del repo privado,
//      cuando el commit toca el inventario o el pre-commit, en la máquina que declara el clon privado
//      (scripts/lib/private-inventory.js; la prueba: private-inventory.test.js). Avisa y no frena: el privado sólo puede
//      sumar un control nuevo después de que éste entra.
// La lógica de cada regla vive en su módulo y la usan la prueba y este freno: no hay una segunda copia que se separe.
//
// Rápido a propósito, porque corre en cada commit: una sola lectura del índice (`git cat-file --batch`) para todos los
// archivos, y el conteo del catálogo sólo si el commit lo toca.
//
// USO   node scripts/ci/check-staged-ci-rules.js [--repo <raíz>]
// Exit  0 = nada que decir · 1 = encontró algo (dice archivo, línea y cómo arreglarlo) · 2 = no pudo mirar.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// Sin sus módulos no hay reglas que aplicar: «no pude mirar» (2), no un hallazgo (1) ni un error de programa a secas.
let grepQ, stable, catalogCount, privateInventory;
try {
  grepQ = require('../lib/grep-q-pipefail.js');
  stable = require('../lib/stable-test-data.js');
  catalogCount = require('../lib/rules-catalog-count.js');
  privateInventory = require('../lib/private-inventory.js');
} catch (e) {
  console.error(`⛔ reglas de la CI antes del commit: no pude mirar (falta un módulo: ${e.message.split('\n')[0]}). Si el checkout está incompleto: git checkout scripts/lib/`);
  process.exit(2);
}

const CATALOG_REL = 'guides/advisor-rules-catalog.md';

function git(root, args, input) {
  const r = spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { input, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : String(r.stderr || '').trim();
    throw new Error(`git ${args.join(' ')} falló: ${why}`);
  }
  return r.stdout;
}

/** El contenido en el índice de cada ruta, con una sola llamada a git: Map(ruta → texto | null si no está). */
function readIndex(root, rels) {
  const out = new Map();
  if (!rels.length) return out;
  const buf = git(root, ['cat-file', '--batch'], rels.map((r) => `:${r}`).join('\n') + '\n');
  let pos = 0;
  for (const rel of rels) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) throw new Error(`git cat-file --batch cortó la salida antes de ${rel}`);
    const header = buf.slice(pos, nl).toString('utf8');
    pos = nl + 1;
    if (/ missing$/.test(header) || / ambiguous$/.test(header)) { out.set(rel, null); continue; }
    const size = Number(header.split(' ')[2]);
    if (!Number.isFinite(size)) throw new Error(`git cat-file --batch: cabecera inesperada «${header}»`);
    out.set(rel, buf.slice(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return out;
}

// Separadas por NUL (`-z`): sin eso git pone entre comillas una ruta con comillas, tabulador o barra invertida, aunque
// core.quotePath esté apagado, y esa ruta no coincidiría con ninguna regla.
function paths(out) { return String(out).split('\0').filter(Boolean); }

function main() {
  const i = process.argv.indexOf('--repo');
  let root = i > 0 ? process.argv[i + 1] : null;
  const findings = [];
  try {
    if (!root) root = String(git(process.cwd(), ['rev-parse', '--show-toplevel'])).trim();
    // lo que hay que LEER (la ruta vieja de un movido ya no está) y lo que TOCA una ruta vigilada (también al irse)
    const toRead = paths(git(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']));
    const touched = paths(git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames']));

    const shs = toRead.filter(grepQ.inScope);
    const tests = toRead.filter(stable.isTestFile);
    // las pruebas que el commit borra (o mueve): si siguen en la lista de las que ya existían, la CI pide sacarlas
    const gone = touched.filter((r) => stable.isTestFile(r) && !toRead.includes(r));
    // agents/ y el catálogo (el pedido), más lo que también mueve el conteo: el padrón de revisores y el paquete de clientes.
    const catalogTouched = touched.some((r) => r === CATALOG_REL || r.startsWith('agents/')
      || r.startsWith('adapters/codex/agents/') || r === 'packs/clients/pack.json');
    const inventoryTouched = privateInventory.toca(touched);
    if (!shs.length && !tests.length && !gone.length && !catalogTouched && !inventoryTouched) return 0;

    const wanted = [...new Set([...shs, ...tests, ...(tests.length || gone.length ? stable.BASELINES : []), ...(catalogTouched ? [CATALOG_REL] : [])])];
    const index = readIndex(root, wanted);

    // 1. `| grep -q` con pipefail
    for (const rel of shs) {
      const text = index.get(rel);
      if (text == null || !grepQ.hasPipefail(text)) continue;
      for (const h of grepQ.findings(text)) {
        findings.push(`${rel}:${h.line} — tubería a \`grep -q\` con pipefail (\`${h.text}\`). Arreglo: ${grepQ.FIX}.`);
      }
    }

    // 2. datos estables en las pruebas que el commit trae
    if (tests.length || gone.length) {
      const baselines = stable.readBaselines((rel) => index.get(rel) ?? null);
      const listed = { commits: new Map(), reloj: new Map() };
      for (const b of baselines) for (const k of ['commits', 'reloj']) for (const r of b[k]) listed[k].set(r, b.file);
      for (const rel of gone) {
        for (const k of ['commits', 'reloj']) {
          if (listed[k].has(rel)) findings.push(`${rel} — el commit la saca y sigue en ${listed[k].get(rel)} («${k}»). Arreglo: sacala también de la lista.`);
        }
      }
      for (const rel of tests) {
        const text = index.get(rel);
        if (text == null) continue;
        const f = stable.faltas(text, rel);
        if (f.commits && !listed.commits.has(rel)) {
          findings.push(`${rel}:${f.commitLine} — crea commits sin ${f.commits.join(', ')}. Arreglo: ${stable.FIX.commits}.`);
        } else if (!f.commits && listed.commits.has(rel)) {
          findings.push(`${rel} — ya cumple la regla de los commits y sigue en ${listed.commits.get(rel)} («commits»). Arreglo: sacala de la lista, que sólo puede achicarse.`);
        }
        if (f.reloj && !listed.reloj.has(rel)) {
          findings.push(`${rel}:${f.clockLine} — lee el reloj sin inyectar la fecha. Arreglo: ${stable.FIX.reloj}.`);
        } else if (!f.reloj && listed.reloj.has(rel)) {
          findings.push(`${rel} — ya cumple la regla del reloj y sigue en ${listed.reloj.get(rel)} («reloj»). Arreglo: sacala de la lista, que sólo puede achicarse.`);
        }
      }
    }

    // 3. el conteo del catálogo de reglas, sobre el catálogo del índice
    if (catalogTouched) {
      // El padrón de revisores y el paquete de clientes se leen del disco (no del índice): con un staging parcial de esos
      // archivos puede contar una versión que no es la del commit. La CI lo vuelve a contar sobre lo commiteado.
      const text = index.get(CATALOG_REL);
      if (text == null) {
        console.error(`ℹ️  reglas de la CI: el commit deja sin ${CATALOG_REL}: no hay conteo del catálogo que hacer (la prueba C5 también lo saltea).`);
      } else {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-ci-rules-'));
        try {
          const cat = path.join(tmp, 'advisor-rules-catalog.md');
          fs.writeFileSync(cat, text);
          const r = catalogCount.check({ root, catalogPath: cat });
          if (r.error) throw new Error(`el conteo del catálogo: ${r.error}`);
          if (r.skipped) console.error(`ℹ️  reglas de la CI: conteo del catálogo saltado — ${r.skipped}.`);
          for (const c of r.checks) if (!c.ok) findings.push(`${CATALOG_REL} — conteo del catálogo de reglas: ${c.msg}.`);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
    }

    // 4. el inventario contra el pre-commit del privado: un aviso, nunca un hallazgo que frene
    if (inventoryTouched) {
      console.error('▸ reglas de la CI: el inventario de los controles contra el pre-commit del privado…');
      const msg = privateInventory.aviso(privateInventory.comparar({ repo: root }));
      if (msg) console.error(msg);
    }
  } catch (e) {
    console.error(`⛔ reglas de la CI antes del commit: no pude mirar (${e.message}). No medido no es verde.`);
    return 2;
  }
  if (!findings.length) return 0;
  console.error('⛔ Esto la CI pública lo frena; mejor ahora que después de empujar:');
  for (const f of findings) console.error(`   · ${f}`);
  return 1;
}

process.exitCode = main();
