#!/usr/bin/env node
'use strict';
/**
 * smoke-ledger-line.js — arma, para las pruebas, la línea que smoke-run.sh deja en el registro de humos del repo
 * (`<clave>-smoke-ledger.jsonl`) y la que deja en el espejo del home (`gates.log`). Story 1.19.
 *
 * Por qué existe: las pruebas escribían esas líneas a mano, cada una con su copia del formato. Con la línea `"v":2`
 * (la que trae la salida guardada y sus sellos) el formato tiene dos versiones, y una copia desactualizada en una
 * prueba pasa en verde probando el formato de ayer. Un solo lugar que las arma, igual que el envoltorio.
 *
 * Uso desde node:
 *   const L = require('./lib/smoke-ledger-line.js');
 *   L.append({ dodDir, gatesLog, story: '9.9', acs: [1] });                         // línea vieja (sin `v`)
 *   L.append({ dodDir, gatesLog, story: '9.9', acs: [1], v2: { pasaSi: 'responde 200 con el pedido',
 *     outputText: 'HTTP 200 …' } });                                                 // línea `v:2` con su salida
 *
 * Uso desde un .sh (agrega las dos líneas):
 *   node smoke-ledger-line.js --dod <dir> --gates <archivo> --story 1.1 --acs 1 [--ts <iso>] [--exit 0]
 *        [--cmd 'curl -s http://app/x'] [--mutates] [--repo <ruta>] [--no-mirror]
 *        [--pass-if <texto> [--fail-if <texto>] [--output-text <texto>]]
 */
// stable-data: el sello por defecto es la hora real a propósito: la matriz descarta la evidencia más vieja que el código,
// y una hora fija se pudriría (caso «fechas podridas», 2026-08-13). Quien necesita un sello fijo lo pasa con `ts`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

/** Sello de ahora en el formato del envoltorio (`2026-10-15T21:45:00Z`, sin milésimas). */
function nowTs() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }

/** El sello compacto del nombre de la salida (`20261015T214500Z`), como el portón E2E. */
function compactTs(ts) { return ts.replace(/[-:]/g, ''); }

/**
 * Las dos líneas, sin salto final. `v2` (opcional): { pasaSi, fallaSi, output, outputSha }. Si `output` es la ruta
 * relativa a la carpeta del registro y `outputSha` falta, el sha lo pone quien llama (ver `append`).
 */
function lines(o) {
  const ts = o.ts || nowTs();
  const acs = o.acs || [];
  const exit = o.exit === undefined ? 0 : o.exit;
  const ledger = { ts, story: o.story, acs, cmd: o.cmd || 'curl -s http://app/x', exit, via: 'smoke-run.sh' };
  const mirror = { type: 'smoke-run', ts };
  if (o.repoPath) mirror.repoPath = o.repoPath;
  Object.assign(mirror, { story: o.story, acs, exit });
  if (o.mutates) { ledger.mutates = true; mirror.mutates = true; }
  if (o.v2) {
    const v = o.v2;
    ledger.v = 2; mirror.v = 2;
    if (v.pasaSi !== undefined) { ledger.pass_if = v.pasaSi; mirror.pass_if_sha = sha256(v.pasaSi); }
    if (v.fallaSi !== undefined) { ledger.fail_if = v.fallaSi; mirror.fail_if_sha = sha256(v.fallaSi); }
    ledger.output = v.output === undefined ? null : v.output;
    ledger.output_sha = v.outputSha === undefined ? null : v.outputSha;
    if (v.outputSha) mirror.output_sha = v.outputSha;
  }
  return { ts, ledger: JSON.stringify(ledger), mirror: JSON.stringify(mirror) };
}

/**
 * Agrega la línea al registro de `dodDir` y, salvo `mirror: false`, la del espejo a `gatesLog`. Con `v2.outputText`
 * escribe además el archivo de la salida en `<clave>-smoke-outputs/` y pone su ruta y su sha. Devuelve lo escrito.
 */
function append(o) {
  const v2 = o.v2 ? { ...o.v2 } : null;
  const ts = o.ts || nowTs();
  if (v2 && v2.outputText !== undefined) {
    const rel = path.join(`${o.story}-smoke-outputs`, `${compactTs(ts)}-${crypto.randomBytes(3).toString('hex')}.txt`);
    fs.mkdirSync(path.join(o.dodDir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(o.dodDir, rel), v2.outputText);
    v2.output = rel.split(path.sep).join('/');
    v2.outputSha = sha256(v2.outputText);
  }
  const l = lines({ ...o, ts, v2 });
  fs.mkdirSync(o.dodDir, { recursive: true });
  fs.appendFileSync(path.join(o.dodDir, `${o.story}-smoke-ledger.jsonl`), l.ledger + '\n');
  if (o.mirror !== false && o.gatesLog) fs.appendFileSync(o.gatesLog, l.mirror + '\n');
  return { ...l, output: v2 ? v2.output : undefined };
}

module.exports = { lines, append, sha256, nowTs, compactTs };

if (require.main === module) {
  const a = process.argv.slice(2);
  const o = { acs: [] };
  let v2 = null;
  const pide = (i) => { if (i + 1 >= a.length) { process.stderr.write(`smoke-ledger-line: ${a[i]} necesita un valor\n`); process.exit(2); } return a[i + 1]; };
  for (let i = 0; i < a.length; i += 1) {
    switch (a[i]) {
      case '--dod': o.dodDir = pide(i); i += 1; break;
      case '--gates': o.gatesLog = pide(i); i += 1; break;
      case '--story': o.story = pide(i); i += 1; break;
      case '--acs': o.acs = pide(i).split(',').filter(Boolean).map(Number); i += 1; break;
      case '--ts': o.ts = pide(i); i += 1; break;
      case '--exit': o.exit = Number(pide(i)); i += 1; break;
      case '--cmd': o.cmd = pide(i); i += 1; break;
      case '--repo': o.repoPath = pide(i); i += 1; break;
      case '--mutates': o.mutates = true; break;
      case '--no-mirror': o.mirror = false; break;
      case '--pass-if': v2 = v2 || {}; v2.pasaSi = pide(i); i += 1; break;
      case '--fail-if': v2 = v2 || {}; v2.fallaSi = pide(i); i += 1; break;
      case '--output-text': v2 = v2 || {}; v2.outputText = pide(i); i += 1; break;
      default: process.stderr.write(`smoke-ledger-line: no conozco ${a[i]}\n`); process.exit(2);
    }
  }
  if (!o.dodDir || !o.story) { process.stderr.write('smoke-ledger-line: faltan --dod y --story\n'); process.exit(2); }
  if (v2) o.v2 = v2;
  append(o);
}
