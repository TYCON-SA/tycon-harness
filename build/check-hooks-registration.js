#!/usr/bin/env node
/**
 * build/check-hooks-registration.js — paridad de REGISTRO de hooks Claude ↔ Codex
 * (adelanta el check #2 de la Etapa H del plan codex-migration.md).
 *
 * El drift que ataca: el registro de hooks vive dos veces (settings.json de Claude vía
 * install-tycon-hooks.sh · hooks.json de Codex vía adapters/) y ese par es exactamente el tipo
 * de copia doble que ya driftó 48 líneas una vez. Un hook que falta del lado Codex NO da error:
 * no se dispara nunca (silencio, §A.2 del inventario).
 *
 * Fuente de verdad del lado Claude: los case files del banco (cases/hooks/*.json) — cada hook
 * registrado tiene ahí su (event, matcher, script). Es a propósito: la regla "pieza sin casos no
 * entra" (principio 4) convierte al banco en el enumerador confiable del set registrado.
 *
 * Reglas:
 *   1. Todo script del banco existe en adapters/codex/hooks.json — en cualquier evento.
 *   2. Todo script de hooks.json existe en el banco (nada registrado sin casos).
 *   3. (event, matcher) coinciden EXACTO, salvo que la divergencia esté declarada en
 *      `divergences` (o `pending_e2` legacy; se matchea por basename del script en el texto de la declaración).
 *      La asimetría se permite; el silencio no.
 *
 * Uso:  node check-hooks-registration.js [--selftest]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TCG = path.resolve(__dirname, '..');

function basename(cmdOrScript) {
  const parts = String(cmdOrScript).trim().split(/\s+/);
  return path.basename(parts[parts.length - 1]);
}

/** banco → [{event, matcher, script, base}] (paths del fixture normalizados a ${TCG}) */
function bankEntries(casesDir) {
  const out = [];
  for (const f of fs.readdirSync(casesDir).filter((x) => x.endsWith('.json')).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8'));
    for (const h of d.hooks || []) {
      const script = String(h.script).replace('${FIXTURE}/tcg/', '${TCG}/');
      out.push({ event: h.event, matcher: h.matcher || '*', script, base: basename(script) });
    }
  }
  return out;
}

/** hooks.json → [{event, matcher, base}] + set de bases declaradas en pending_e2 */
function codexEntries(hooksJsonPath) {
  const d = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  const out = [];
  for (const [event, groups] of Object.entries(d.hooks || {}))
    for (const g of groups)
      for (const h of g.hooks || [])
        out.push({ event, matcher: g.matcher || '*', base: basename(h.command) });
  const pending = new Set();
  for (const p of (d.divergences || []).concat(d.pending_e2 || [])) {
    for (const e of out)
      if (JSON.stringify(p).includes(e.base)) pending.add(e.base);
    // 🔴 Los `scripts` de la declaración entran DIRECTO: el match de arriba sólo
    // recorre lo REGISTRADO en codex, así que un hook ausente-a-propósito (invocado por git,
    // launchd o el instalador — no por la herramienta) no entraría al set aunque su divergencia
    // estuviera escrita. La regla 1 lo acusaría de silencio con la declaración a la vista.
    for (const sc of (p.scripts || [])) pending.add(basename(sc));
  }
  return { out, pending };
}

/** núcleo puro (testeable offline): devuelve la lista de fallas */
function compare(bank, codex, pending) {
  const fails = [];
  const codexByBase = new Map();
  for (const e of codex) { if (!codexByBase.has(e.base)) codexByBase.set(e.base, []); codexByBase.get(e.base).push(e); }
  const bankByBase = new Map();
  for (const e of bank) { if (!bankByBase.has(e.base)) bankByBase.set(e.base, []); bankByBase.get(e.base).push(e); }

  // 1) todo hook del banco está registrado en codex — SALVO divergencia declarada:
  // sin consultar `pending`, un script del banco que legítimamente NO es un
  // hook de herramienta (lo invoca git, launchd o el instalador — el mismo invocador bajo las dos
  // herramientas) no se podría declarar: fallaría siempre. La doctrina del propio archivo es "la
  // asimetría se permite; el silencio no" — y una divergencia escrita con su motivo es lo
  // contrario del silencio.
  for (const [base, entries] of bankByBase) {
    const cx = codexByBase.get(base);
    if (!cx) {
      if (pending.has(base)) continue;
      fails.push(`FALTA en codex/hooks.json: ${base} (${entries.map((e) => e.event + '·' + e.matcher).join(', ')}) — no se dispararía nunca, sin error`);
      continue;
    }
    // 3) (event, matcher) exactos salvo pendiente declarado
    if (pending.has(base)) continue;
    for (const b of entries)
      if (!cx.some((c) => c.event === b.event && c.matcher === b.matcher))
        fails.push(`DIVERGE sin declarar: ${base} — banco=(${b.event}·${b.matcher}) vs codex=(${cx.map((c) => c.event + '·' + c.matcher).join(', ')})`);
  }
  // 2) nada registrado en codex sin casos en el banco
  for (const base of codexByBase.keys())
    if (!bankByBase.has(base)) fails.push(`SIN CASOS: ${base} está en codex/hooks.json pero no tiene casos en el banco (principio 4: pieza sin casos no entra)`);
  return fails;
}

function selftest() {
  const checks = [];
  const B = (e, m, s) => ({ event: e, matcher: m, script: s, base: s });
  const C = (e, m, s) => ({ event: e, matcher: m, base: s });
  const bank = [B('PreToolUse', 'Bash', 'a.sh'), B('PreToolUse', 'Task|Agent', 'adv.js'), B('Stop', '*', 'm.js')];
  const codexOK = [C('PreToolUse', 'Bash', 'a.sh'), C('SubagentStart', '*', 'adv.js'), C('Stop', '*', 'm.js')];
  checks.push(['paridad completa con pendiente declarado → 0 fallas',
    compare(bank, codexOK, new Set(['adv.js'])).length === 0]);
  checks.push(['divergencia SIN declarar → falla',
    compare(bank, codexOK, new Set()).some((f) => f.includes('DIVERGE') && f.includes('adv.js'))]);
  checks.push(['hook del banco ausente en codex → falla que nombra el silencio',
    compare(bank, [C('Stop', '*', 'm.js')], new Set()).some((f) => f.includes('FALTA') && f.includes('a.sh'))]);
  checks.push(['registrado en codex sin casos → falla (principio 4)',
    compare(bank, codexOK.concat([C('Stop', '*', 'fantasma.js')]), new Set(['adv.js'])).some((f) => f.includes('SIN CASOS'))]);
  checks.push(['ausente en codex PERO con divergencia declarada → pasa (no es un hook de herramienta)',
    compare(bank, [C('SubagentStart', '*', 'adv.js'), C('Stop', '*', 'm.js')], new Set(['adv.js', 'a.sh'])).length === 0]);
  checks.push(['la divergencia declarada NO tapa a un tercero ausente',
    compare(bank, [C('SubagentStart', '*', 'adv.js')], new Set(['adv.js', 'a.sh'])).some((f) => f.includes('FALTA') && f.includes('m.js'))]);
  let bad = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-registration: ${name}`); if (!ok) bad++; }
  return bad ? 1 : 0;
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const bank = bankEntries(path.join(TCG, 'scripts', 'controls-bench', 'cases', 'hooks'));
  const { out: codex, pending } = codexEntries(path.join(TCG, 'adapters', 'codex', 'hooks.json'));
  const fails = compare(bank, codex, pending);
  for (const f of fails) console.log(`❌ registro-hooks: ${f}`);
  console.log(fails.length
    ? `❌ paridad de registro: ${fails.length} fallas`
    : `✅ paridad de registro de hooks: ${bank.length} entradas del banco cubiertas en codex/hooks.json (divergencias declaradas: ${pending.size})`);
  return fails.length ? 1 : 0;
}

process.exit(main());
