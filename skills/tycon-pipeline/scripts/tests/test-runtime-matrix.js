#!/usr/bin/env node
/**
 * Tests de runtime-matrix.js (regla DODRT-C6) — cubre los caminos de bypass que la
 * capa existe para cerrar. Correr: node test-runtime-matrix.js (exit 0 OK / 1 fail).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const rm = require(path.join(__dirname, '..', 'runtime-matrix.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---------------------------------------------------------------- fixture builder
// Workspace sintético: <ws>/Proj/ es un REPO GIT (con .git) que contiene la story, el código
// y su evidencia — el layout real. Hasta 2026-08-14 el fixture separaba story (Proj/) de
// evidencia (Repo/, un HERMANO): la suite entera dependía del barrido cross-repo que era
// exactamente el bug de atribución (evidencia ajena contada como propia).
function makeWorkspace(opts = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rmx-'));
  const repo = path.join(ws, 'Proj');
  const specsDir = path.join(repo, 'specs', 'stories');
  const advDir = path.join(repo, '.advisors');
  const dodDir = path.join(advDir, 'dod-runtime');
  if (!opts.noGit) fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(specsDir, { recursive: true });
  fs.mkdirSync(dodDir, { recursive: true });

  const srcDir = path.join(repo, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const codeFile = path.join(srcDir, 'Feature.cs');
  fs.writeFileSync(codeFile, '// code\n');
  // Código "viejo" por defecto (los artefactos de evidencia serán posteriores).
  const past = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(codeFile, new Date(past), new Date(past));

  const fm = [
    '---',
    'story: 9.9',
    'status: in-progress',
    'files_to_modify:',
    // repo-relativo (como las stories reales de un repo del equipo); ws-relativo con opts.wsRelFiles
    // (como las de Ceibo, que nombran el repo hermano en el path).
    `  - ${opts.wsRelFiles ? 'Proj/src/Feature.cs' : 'src/Feature.cs'}`,
    ...(opts.ack || []),
    '---',
  ].join('\n');
  const body = [
    '',
    '## Acceptance Criteria',
    '',
    '1. **Given** algo, **When** pasa, **Then** resultado.',
    '2. **ERROR_CASE:** input inválido → 422.',
    '3. **Given** otra cosa, **Then** otro resultado.',
    '',
    '### Tests',
    '',
    '| ID | Test | AC | Nivel | Escenario | Esperado |',
    '|---|---|---|---|---|---|',
    '| T1 | `FeatureTests.Caso1` | 1 | integration | x | y |',
    '| T2 | `FeatureTests.Caso2` | 2 | unit | x | y |',
    '| E1 | `story-9-9.spec.ts::flujo` | 1,3 | e2e | x | y |',
    '',
  ].join('\n');
  const storyPath = path.join(specsDir, '9-9-fixture.md');
  fs.writeFileSync(storyPath, fm + body);
  const gatesLog = path.join(ws, 'gates.log');
  return { ws, repo, storyPath, dodDir, advDir, codeFile, gatesLog };
}

// Un repo git HERMANO del de la story, con su propio .advisors/ — el vecino cuya evidencia
// NO debe atribuirse a la story salvo declaración explícita (evidence.companion_repos).
function addSiblingRepo(ws, name) {
  const root = path.join(ws, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const advDir = path.join(root, '.advisors');
  const dodDir = path.join(advDir, 'dod-runtime');
  fs.mkdirSync(dodDir, { recursive: true });
  return { root, advDir, dodDir };
}

// Smoke ledger espejado (la vía legítima completa: entry en el ledger + espejo en gates.log).
// Armada por el ayudante compartido (story 1.19): una línea vieja, sin `v`, como la escribía el envoltorio.
// Los casos de forja de abajo escriben sus líneas a mano a propósito: lo que prueban es una línea que el envoltorio
// nunca escribiría (registro y espejo que no coinciden).
function writeMirroredSmoke(dodDir, gatesLog, sid, acs, cmd = 'curl -s http://app/x') {
  require(path.join(__dirname, 'lib', 'smoke-ledger-line.js')).append({ dodDir, gatesLog, story: sid, acs, cmd });
}

// Escribe el gate .md Y (por default) el ESPEJO run-check en gates.log — como lo hace
// `marker.js run-check dod -- bash <gate> ... <specFilter>` en producción. Pasar
// mirror=false para simular un gate forjado a mano (sin espejo → no debe contar).
function writeGate(dodDir, sid, tsCompact, verdict, specFilter, gatesLog, mirror = true, titulos = null) {
  fs.writeFileSync(path.join(dodDir, `${sid}-e2e-gate-${tsCompact}.md`), [
    `# DoD Runtime Evidence — Story ${sid} — Playwright Gate (scoped)`,
    `**Spec filter**: ${specFilter}`,
    '```', `verdict=${verdict}`, 'total=1', `passed=${verdict === 'PASS' ? 1 : 0}`, '```',
    // Contrato DODRT-C8: los títulos de los tests que pasaron.
    ...(titulos ? ['', '## Tests corridos (títulos completos — contrato DODRT-C8)', ...titulos.map((t) => `- ${t}`), ''] : []),
  ].join('\n'));
  if (mirror && gatesLog) {
    fs.appendFileSync(gatesLog, JSON.stringify({
      ts: new Date().toISOString(), check: 'dod', status: verdict === 'PASS' ? 'green' : 'red:exit=1',
      provenance: 'run-check', cmd: `bash e2e-gate.sh /fe ${sid} /dir ${specFilter}`, exit: verdict === 'PASS' ? 0 : 1,
    }) + '\n');
  }
}

function writeTestsResult(advDir, sid, green, tsIso) {
  fs.writeFileSync(path.join(advDir, 'tests-result.json'),
    JSON.stringify({ ts: tsIso, story_id: sid, suite_green: green }));
}

// Timestamp compacto RECIENTE (now − minsAgo). Se llamaba `futureCompact` y el nombre mentía:
// produce PASADO cercano — posterior a la mtime del código (now − 1h), que es lo que importa.
function recentCompact(minsAgo = 1) {
  const d = new Date(Date.now() - minsAgo * 60 * 1000);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// ---------------------------------------------------------------- casos

console.log('runtime-matrix — casos:');

// 1. Sin evidencia alguna → ROJO, 3 ACs pendientes, fail-closed no estructural.
{
  const f = makeWorkspace();
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('sin evidencia → rojo con 3 pendientes', !r.green && r.pendientes.length === 3, JSON.stringify(r.pendientes));
}

// 2. Gate E2E PASS fresco + tests-result verde → ACs 1,3 RUNTIME; AC 2 CODE-ONLY → sigue rojo.
{
  const f = makeWorkspace();
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString());
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('gate PASS cubre sus ACs', r.perAc[1].verdict === 'RUNTIME' && r.perAc[3].verdict === 'RUNTIME',
    JSON.stringify(r.perAc));
  check('AC solo-unit (no declarado imposible) queda NOT-RUN y bloquea', r.perAc[2].verdict === 'NOT-RUN' && !r.green);
}

// 2d. DOS CATEGORÍAS (el dev, 2026-07-10): AC declarado runtime_not_verifiable CON test que lo
//     cubre → NOT-VERIFIABLE (waiveable); sin declarar → NOT-RUN (bloquea, no waiveable).
{
  const f = makeWorkspace({ ack: ['runtime_not_verifiable:', '  - ac: 2', '    reason: "esquema, no observable"', '    covered_by: T2'] });
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString());
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('AC declarado imposible + con test → NOT-VERIFIABLE', r.perAc[2].verdict === 'NOT-VERIFIABLE' &&
    r.notVerifiable.includes(2) && r.notRun.length === 0);
}

// 2e. Declaración INVÁLIDA: AC declarado imposible pero SIN test que lo cubra → NOT-RUN + warning.
{
  const f = makeWorkspace({ ack: ['runtime_not_verifiable:', '  - ac: 2', '    reason: "sin test"', '    covered_by: TX'] });
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  // NO tests-result → AC#2 no tiene evidencia de código
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('declarado imposible SIN test que lo cubra → NOT-RUN + warning', r.perAc[2].verdict === 'NOT-RUN' &&
    r.warnings.some((w) => /declaración inválida/.test(w)));
}

// 2b. VECTOR 1 (re-ataque 2026-07-10): gate .md forjado a mano SIN espejo en gates.log NO cuenta.
{
  const f = makeWorkspace();
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog, /* mirror */ false);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('gate .md forjado sin espejo NO da runtime + warning', r.perAc[1].verdict !== 'RUNTIME' &&
    r.warnings.some((w) => /SIN espejo run-check/.test(w)));
}

// 2c. Espejo que NO menciona el spec filter (ej. run-check dod -- true) NO habilita el gate.
{
  const f = makeWorkspace();
  fs.writeFileSync(path.join(f.dodDir, '9.9-e2e-gate-' + recentCompact() + '.md'), [
    '# gate', '**Spec filter**: story-9-9.spec.ts', '```', 'verdict=PASS', '```',
  ].join('\n'));
  fs.appendFileSync(f.gatesLog, JSON.stringify({
    ts: new Date().toISOString(), check: 'dod', status: 'green', provenance: 'run-check', cmd: 'true', exit: 0,
  }) + '\n');
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('espejo run-check con cmd trivial (sin spec) NO habilita el gate', r.perAc[1].verdict !== 'RUNTIME');
}

// 3. Gate FAIL NO cuenta (el bypass "el archivo existe" no alcanza — importa el verdict).
{
  const f = makeWorkspace();
  writeGate(f.dodDir, '9.9', recentCompact(), 'FAIL', 'story-9-9.spec.ts', f.gatesLog);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('gate FAIL no da runtime', r.perAc[1].verdict !== 'RUNTIME');
}

// 4. Gate PASS pero STALE (código editado DESPUÉS del gate) NO cuenta.
{
  const f = makeWorkspace();
  writeGate(f.dodDir, '9.9', recentCompact(30), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  fs.utimesSync(f.codeFile, new Date(), new Date()); // código recién editado
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('gate stale no da runtime + warning', r.perAc[1].verdict !== 'RUNTIME' &&
    r.warnings.some((w) => /ANTERIOR al último edit/.test(w)));
}

// 5. Smoke ledger SIN espejo en gates.log NO cuenta (anti escritura a mano).
{
  const f = makeWorkspace();
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(f.dodDir, '9.9-smoke-ledger.jsonl'),
    JSON.stringify({ ts, story: '9.9', acs: [2], cmd: 'curl x', exit: 0, via: 'smoke-run.sh' }) + '\n');
  const fakeGatesLog = path.join(f.ws, 'gates.log'); // vacío — sin espejo
  fs.writeFileSync(fakeGatesLog, '');
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: fakeGatesLog });
  check('ledger sin espejo no cuenta', r.perAc[2].verdict !== 'RUNTIME' &&
    r.warnings.some((w) => /SIN espejo/.test(w)));
}

// 6. Smoke ledger CON espejo válido SÍ cuenta.
{
  const f = makeWorkspace();
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(f.dodDir, '9.9-smoke-ledger.jsonl'),
    JSON.stringify({ ts, story: '9.9', acs: [2], cmd: 'curl x', exit: 0, via: 'smoke-run.sh' }) + '\n');
  const fakeGatesLog = path.join(f.ws, 'gates.log');
  fs.writeFileSync(fakeGatesLog,
    JSON.stringify({ type: 'smoke-run', ts, story: '9.9', acs: [2], exit: 0 }) + '\n');
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: fakeGatesLog });
  check('ledger con espejo da RUNTIME al AC', r.perAc[2].verdict === 'RUNTIME');
}

// 6b. Un smoke que corre TESTS no es evidencia runtime (fix 2026-07-25).
// El bug: el ledger se leía sin mirar NUNCA el `cmd`, así que `node --test` y una sonda contra la
// plataforma real contaban igual — 🟢 RUNTIME las dos. Eso vaciaba de sentido al gate, que existe
// para cazar "los tests pasan pero en la plataforma no anda". Destapado por el sweep de drift de
// un repo del equipo: 5 stories con matriz 🟢 "N/N en RUNTIME" y ledger 100% `node --test`.
{
  const f = makeWorkspace();
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(f.dodDir, '9.9-smoke-ledger.jsonl'),
    JSON.stringify({ ts, story: '9.9', acs: [2], cmd: 'node --test tests/unit/foo.test.js', exit: 0, via: 'smoke-run.sh' }) + '\n');
  const fakeGatesLog = path.join(f.ws, 'gates.log');
  fs.writeFileSync(fakeGatesLog,
    JSON.stringify({ type: 'smoke-run', ts, story: '9.9', acs: [2], exit: 0 }) + '\n');
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: fakeGatesLog });
  check('smoke `node --test` NO da RUNTIME (es evidencia de código)',
    r.perAc[2].verdict !== 'RUNTIME' && r.warnings.some((w) => /NO ejercita la app \(unit-test\)/.test(w)));
}

// 6c. Un smoke que corre un gate de build tampoco es evidencia runtime.
{
  const f = makeWorkspace();
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(f.dodDir, '9.9-smoke-ledger.jsonl'),
    JSON.stringify({ ts, story: '9.9', acs: [2], cmd: 'npm run lint && npm run typecheck', exit: 0, via: 'smoke-run.sh' }) + '\n');
  const fakeGatesLog = path.join(f.ws, 'gates.log');
  fs.writeFileSync(fakeGatesLog,
    JSON.stringify({ type: 'smoke-run', ts, story: '9.9', acs: [2], exit: 0 }) + '\n');
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: fakeGatesLog });
  check('smoke `npm run lint` NO da RUNTIME (build-gate)',
    r.perAc[2].verdict !== 'RUNTIME' && r.warnings.some((w) => /NO ejercita la app \(build-gate\)/.test(w)));
}

// 6d. La escotilla TYCON_RUNTIME_MATRIX_LEGACY=1 restaura el comportamiento viejo, gritando.
// Se recarga el módulo porque la constante se evalúa al importar.
{
  const f = makeWorkspace();
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(f.dodDir, '9.9-smoke-ledger.jsonl'),
    JSON.stringify({ ts, story: '9.9', acs: [2], cmd: 'node --test tests/unit/foo.test.js', exit: 0, via: 'smoke-run.sh' }) + '\n');
  const fakeGatesLog = path.join(f.ws, 'gates.log');
  fs.writeFileSync(fakeGatesLog,
    JSON.stringify({ type: 'smoke-run', ts, story: '9.9', acs: [2], exit: 0 }) + '\n');
  const prev = process.env.TYCON_RUNTIME_MATRIX_LEGACY;
  process.env.TYCON_RUNTIME_MATRIX_LEGACY = '1';
  const rmPath = require.resolve('../runtime-matrix.js');
  delete require.cache[rmPath];
  const rmLegacy = require(rmPath);
  const r = rmLegacy.compute({ storyPath: f.storyPath, gatesLogPath: fakeGatesLog });
  if (prev === undefined) delete process.env.TYCON_RUNTIME_MATRIX_LEGACY;
  else process.env.TYCON_RUNTIME_MATRIX_LEGACY = prev;
  delete require.cache[rmPath];
  check('escotilla LEGACY=1 restaura RUNTIME y avisa que la matriz puede mentir',
    r.perAc[2].verdict === 'RUNTIME' && r.warnings.some((w) => /LEGACY=1/.test(w)));
}

// 7. Smoke con exit != 0 NO cuenta aunque esté espejado.
{
  const f = makeWorkspace();
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(f.dodDir, '9.9-smoke-ledger.jsonl'),
    JSON.stringify({ ts, story: '9.9', acs: [2], cmd: 'curl x', exit: 7, via: 'smoke-run.sh' }) + '\n');
  const fakeGatesLog = path.join(f.ws, 'gates.log');
  fs.writeFileSync(fakeGatesLog, JSON.stringify({ type: 'smoke-run', ts, story: '9.9', acs: [2], exit: 7 }) + '\n');
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: fakeGatesLog });
  check('smoke exit!=0 no cuenta', r.perAc[2].verdict !== 'RUNTIME');
}

// ---- WAIVER TTY (reemplaza los casos de ack) ----
// Log de waivers aislado por test (TYCON_WAIVER_LOG). appendWaiver simula lo que escribe el
// comando marker.js runtime-waiver DESPUÉS de la confirmación TTY del humano.
const waiverLib = require(path.join(__dirname, '..', 'lib', 'runtime-waiver.js'));
// AC#2 declarado imposible-de-verificar-corriendo (con T2 que lo cubre) → NOT-VERIFIABLE,
// que es lo ÚNICO waiveable. Sin esta declaración AC#2 sería NOT-RUN (no waiveable).
const DECL2 = ['runtime_not_verifiable:', '  - ac: 2', '    reason: "esquema, no observable"', '    covered_by: T2'];
function withWaiverLog(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wvr-'));
  const log = path.join(tmp, 'waivers.jsonl');
  const prev = process.env.TYCON_WAIVER_LOG;
  process.env.TYCON_WAIVER_LOG = log;
  try { return fn(log); } finally {
    if (prev === undefined) delete process.env.TYCON_WAIVER_LOG; else process.env.TYCON_WAIVER_LOG = prev;
  }
}

// 8. Waiver del usuario (hash correcto) pone verde el/los AC pendientes.
withWaiverLog(() => {
  const f = makeWorkspace({ ack: DECL2 });
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString());
  const r1 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog }); // AC 2 pendiente (solo unit)
  waiverLib.appendWaiver({ story: '9.9', acs: r1.pendientes, matrixHash: r1.hash, approvedBy: 'DevA', nowIso: new Date().toISOString() });
  const r2 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('waiver TTY con hash correcto → verde', r2.green === true && r2.stats.waived >= 1, JSON.stringify(r2.stats));
});

// 9. Waiver con hash VIEJO (la matriz cambió) NO cuenta — anti-drift.
withWaiverLog(() => {
  const f = makeWorkspace({ ack: DECL2 });
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString());
  const r1 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  waiverLib.appendWaiver({ story: '9.9', acs: r1.pendientes, matrixHash: '000000000000', approvedBy: 'DevA', nowIso: new Date().toISOString() });
  const r2 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('waiver con hash desactualizado NO cuenta', !r2.green && r2.stats.waived === 0);
});

// 10. Waiver de OTRA story NO cuenta.
withWaiverLog(() => {
  const f = makeWorkspace({ ack: DECL2 });
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString());
  const r1 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  waiverLib.appendWaiver({ story: '8.8', acs: r1.pendientes, matrixHash: r1.hash, approvedBy: 'DevA', nowIso: new Date().toISOString() });
  const r2 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('waiver de otra story NO cuenta', !r2.green && r2.stats.waived === 0);
});

// 11. Cadena de waivers ROTA (edición manual del log) → los waivers NO cuentan + warning.
withWaiverLog((log) => {
  const f = makeWorkspace({ ack: DECL2 });
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString());
  const r1 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  // forja a mano: línea con chain inventado (no calculado) — rompe la cadena
  const forged = { ts: new Date().toISOString(), story: '9.9', acs: r1.pendientes, matrixHash: r1.hash, approvedBy: 'DevA', tty: true, chain: 'deadbeefdeadbeef' };
  fs.writeFileSync(log, JSON.stringify(forged) + '\n');
  const r2 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('waiver forjado a mano (cadena rota) NO cuenta + chainOk=false', !r2.green && r2.chainOk === false);
});

// 12. Un waiver legítimo seguido de uno forjado: el forjado rompe la cadena, el legítimo previo SÍ vale.
withWaiverLog((log) => {
  const f = makeWorkspace({ ack: DECL2 });
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString());
  const r1 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  waiverLib.appendWaiver({ story: '9.9', acs: r1.pendientes, matrixHash: r1.hash, approvedBy: 'DevA', nowIso: new Date().toISOString() });
  // append forjado detrás (cadena inválida)
  fs.appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), story: '9.9', acs: [999], matrixHash: r1.hash, approvedBy: 'x', tty: true, chain: 'ffff' }) + '\n');
  const r2 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('legítimo previo cuenta, forjado posterior no (chainOk=false)', r2.green === true && r2.chainOk === false);
});

// ---- Story 7.17 — una firma descartada se DICE (no «esperan waiver» a secas) ----
// Caso: épico 11 de un producto del equipo (2026-10-07). El dev firmó, la cadena del registro del repo se había roto al
// unir dos ramas, y la matriz decía «esperan waiver»: parecía que no había firmado. Los registros se arman a mano con
// el hash y el canónico del verificador (copiados: son el formato que ya está firmado en los repos).
const crypto717 = require('crypto');
function canon717(e) {
  const base = [e.ts, String(e.story), [...e.acs].sort((a, b) => a - b), e.matrixHash, e.approvedBy || null];
  if (e.declHashByAc !== undefined) base.push(Object.keys(e.declHashByAc).sort((a, b) => Number(a) - Number(b)).map((k) => [Number(k), e.declHashByAc[k]]));
  return JSON.stringify(base);
}
const colgada717 = (padre, e) => ({ ...e, chain: crypto717.createHash('sha256').update(padre + canon717(e)).digest('hex').slice(0, 16) });
const DECL2_HASH = waiverLib.declHashFor('esquema, no observable', 'T2');
let reloj717 = Date.parse('2026-10-07T10:00:00Z');
const firma717 = (story, acs, extra = {}) => ({ ts: new Date(reloj717 += 1000).toISOString(), story, acs, matrixHash: 'm', approvedBy: 'deva', tty: true, ...extra });
function registroDelRepo(f, entries) {
  fs.mkdirSync(path.join(f.repo, '.tycon'), { recursive: true });
  const lp = path.join(f.repo, '.tycon', 'runtime-waivers.jsonl');
  fs.writeFileSync(lp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return lp;
}
function workspaceConAc2Pendiente() {
  const f = makeWorkspace({ ack: DECL2 });
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString());
  return f;
}

// T12 — Matrix_DiscardedSignature_SaysSo
withWaiverLog(() => {
  const f = workspaceConAc2Pendiente();
  const base = colgada717('', firma717('9.1', [1]));
  const editada = { ...colgada717(base.chain, firma717('9.9', [2], { declHashByAc: { 2: DECL2_HASH } })), approvedBy: 'deva' };
  editada.ts = '2026-10-07T09:00:00.000Z';   // alguien la tocó a mano: ya no engancha
  registroDelRepo(f, [base, editada]);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  const w = (r.warnings || []).find((x) => /AC#2/.test(x) && /descart/i.test(x));
  check('T12 la firma descartada se dice por AC (no sólo «esperan waiver»)', !!w, JSON.stringify(r.warnings));
  check('T12 …con quién, archivo:línea y el comando para volver a firmar',
    !!w && /deva/.test(w) && /runtime-waivers\.jsonl:2/.test(w) && /marker\.js runtime-waiver/.test(w), w);
  check('T12 …y queda en el resultado (waiverDiscarded)',
    Array.isArray(r.waiverDiscarded) && r.waiverDiscarded.some((d) => d.ac === 2 && d.line === 2), JSON.stringify(r.waiverDiscarded));
  check('T12 …y la matriz sigue roja (descartada = no cuenta)', r.green === false);
});

// T13 — Matrix_DiscardedSignature_NoResignIfApprovedOrStale
withWaiverLog(() => {
  const f = workspaceConAc2Pendiente();
  const valida = colgada717('', firma717('9.9', [2], { declHashByAc: { 2: DECL2_HASH } }));
  const copiaRota = { ...valida, chain: 'deadbeefdeadbeef' };
  registroDelRepo(f, [valida, copiaRota]);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('T13 una copia rota de una firma que sí vale no pide volver a firmar',
    r.green === true && (r.waiverDiscarded || []).length === 0 && !(r.warnings || []).some((x) => /volv[ée] a firmar/i.test(x)),
    JSON.stringify({ g: r.green, d: r.waiverDiscarded, w: r.warnings }));
});
withWaiverLog(() => {
  const f = workspaceConAc2Pendiente();
  const vieja = { ...colgada717('', firma717('9.9', [2], { declHashByAc: { 2: waiverLib.declHashFor('otra razón', 'T2') } })), chain: 'deadbeefdeadbeef' };
  registroDelRepo(f, [vieja]);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('T13 una firma descartada de una declaración VIEJA no pide volver a firmar', (r.waiverDiscarded || []).length === 0,
    JSON.stringify(r.waiverDiscarded));
});

withWaiverLog(() => {
  const f = workspaceConAc2Pendiente();
  // Firma vieja (sin declaración, engancha por matrixHash) de un AC que la story NO declara no verificable.
  const r0 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  registroDelRepo(f, [{ ...firma717('9.9', [3], { matrixHash: r0.hash }), chain: 'deadbeefdeadbeef' }]);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('T13c una firma descartada de un AC que la story no declara no verificable no pide volver a firmar',
    !(r.waiverDiscarded || []).some((d) => d.ac === 3), JSON.stringify(r.waiverDiscarded));
});

// 5b-5 — el aviso sólo para un AC que de verdad espera firma (NOT-VERIFIABLE): uno declarado sin test que lo cubra
// (NOT-RUN, no se puede perdonar) o uno que ya corrió no piden volver a firmar.
withWaiverLog(() => {
  const f = makeWorkspace({ ack: ['runtime_not_verifiable:', '  - ac: 3', '    reason: "sin test"', '    covered_by: TX'] });
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString());
  const d3 = waiverLib.declHashFor('sin test', 'TX');
  registroDelRepo(f, [{ ...firma717('9.9', [3], { declHashByAc: { 3: d3 } }), chain: 'deadbeefdeadbeef' }]);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('5b-5 un AC declarado sin test que lo cubra no pide volver a firmar (no se puede perdonar)',
    !(r.waiverDiscarded || []).some((d) => d.ac === 3), JSON.stringify({ d: r.waiverDiscarded, v: r.perAc[3] && r.perAc[3].verdict }));
});

// T14 — Matrix_ChainAlert_OnlyForThisStory
withWaiverLog(() => {
  const f = workspaceConAc2Pendiente();
  const ajena = { ...firma717('8.8', [1]), chain: 'deadbeefdeadbeef' };
  const lp = registroDelRepo(f, [colgada717('', firma717('9.1', [1])), ajena]);
  const r1 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('T14 una línea descartada de OTRA story no prende el aviso de cadena',
    r1.chainOk === true && !(r1.warnings || []).some((x) => /cadena/i.test(x) && /ROTA/.test(x)), JSON.stringify(r1.warnings));
  fs.appendFileSync(lp, JSON.stringify({ ...firma717('9.9', [7]), chain: 'feedfacefeedface' }) + '\n');
  const r2 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  const w = (r2.warnings || []).find((x) => /cadena/i.test(x));
  check('T14 una de ESTA story sí: chainOk=false y el aviso nombra el archivo y la línea',
    r2.chainOk === false && !!w && /runtime-waivers\.jsonl:3/.test(w), JSON.stringify(r2.warnings));
  check('T14 …sin decir «los waivers posteriores NO cuentan» (ya no es cierto)', !!w && !/posteriores NO cuentan/.test(w), w);
});

// T15 — Matrix_ParallelMerge_Green
withWaiverLog(() => {
  const f = workspaceConAc2Pendiente();
  const base = colgada717('', firma717('9.1', [1]));
  const ramaA = colgada717(base.chain, firma717('9.8', [4]));
  const ramaB = colgada717(base.chain, firma717('9.9', [2], { declHashByAc: { 2: DECL2_HASH } }));
  registroDelRepo(f, [base, ramaA, ramaB]);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('T15 dos ramas unidas: la firma de la segunda vale y la matriz queda verde', r.green === true && r.waivedAcs.includes(2),
    JSON.stringify({ g: r.green, w: r.waivedAcs, warn: r.warnings }));
});

// T16 — Step8_DiscardedSignature_Message: el texto del bloqueo sale de UNA función, que usan marker.js y on-pre-commit.js.
withWaiverLog(() => {
  const f = workspaceConAc2Pendiente();
  const base = colgada717('', firma717('9.1', [1]));
  const editada = colgada717(base.chain, firma717('9.9', [2], { declHashByAc: { 2: DECL2_HASH } }));
  editada.acs = [2, 3];
  registroDelRepo(f, [base, editada]);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  const lineas = typeof rm.avisoFirmasDescartadas === 'function' ? rm.avisoFirmasDescartadas(r, f.storyPath) : [];
  const texto = lineas.join('\n');
  check('T16 el bloqueo nombra el AC con firma descartada y el comando para volver a firmar',
    /#2/.test(texto) && /descart/i.test(texto) && /marker\.js runtime-waiver/.test(texto) && texto.includes(f.storyPath), texto);
  const fuente = (n) => fs.readFileSync(path.join(__dirname, '..', n), 'utf8');
  check('T16 marker.js y on-pre-commit.js imprimen ese mismo aviso',
    /avisoFirmasDescartadas\(/.test(fuente('marker.js')) && /avisoFirmasDescartadas\(/.test(fuente('on-pre-commit.js')));
});

// T18 — Migrate_DiscardedLines_TextAndRetry: el migrador ya no dice «sólo migro lo anterior», y una migración que quedó
// descartada en el destino se vuelve a escribir (antes la daba por hecha mirando también las líneas descartadas).
{
  const { spawnSync } = require('child_process');
  const MIGRATE = path.join(__dirname, '..', 'migrate-waivers-to-repo.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-717-'));
  const repo = path.join(tmp, 'Repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'story-9.9.md'),
    ['---', 'story: 9.9', 'runtime_not_verifiable:', '  - ac: 2', '    reason: "esquema, no observable"', '    covered_by: T2', '---', '', '1. algo', ''].join('\n'));
  const homeLog = path.join(tmp, 'home-waivers.jsonl');
  const valida = colgada717('', firma717('9.9', [2]));
  fs.writeFileSync(homeLog, [JSON.stringify(valida), JSON.stringify({ ...firma717('9.7', [1]), chain: 'deadbeefdeadbeef' })].join('\n') + '\n');
  const correr = (...a) => spawnSync(process.execPath, [MIGRATE, '--repos', repo, ...a],
    { encoding: 'utf8', env: { ...process.env, TYCON_WAIVER_LOG: homeLog } });
  const seco = correr();
  const salida = `${seco.stdout}\n${seco.stderr}`;
  check('T18 el aviso del migrador ya no dice «sólo migro lo anterior»', !/sólo migro lo anterior/.test(salida), salida);
  check('T18 …y cuenta las líneas descartadas', /1 línea\(s\) descartada\(s\)/.test(salida), salida);
  // destino con la MISMA migración ya escrita pero descartada (cadena rota)
  const destino = waiverLib.repoWaiverLogPath(repo);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const decl = waiverLib.declHashFor('esquema, no observable', 'T2');
  fs.writeFileSync(destino, JSON.stringify({ ts: valida.ts, story: '9.9', acs: [2], matrixHash: 'm', approvedBy: 'deva', tty: true,
    declHashByAc: { 2: decl }, migratedFrom: 'home-log-2026-07-29', chain: 'feedfacefeedface' }) + '\n');
  // 🔴 Escribir pide la terminal del dev (2026-10-07): el migrador vuelve a firmar contra el texto ACTUAL de cada AC, y
  // sin candado lo podía correr el agente — reescribir la razón de un AC y migrar daba una firma válida que nadie firmó.
  const antes = fs.readFileSync(destino, 'utf8');
  if (!waiverLib.hasTty()) {
    const sinTerminal = correr('--apply');
    check('T18b `--apply` sin terminal NO escribe: sale ≠ 0 y dice que lo corre el dev',
      sinTerminal.status !== 0 && /requiere una terminal/.test(sinTerminal.stderr) && fs.readFileSync(destino, 'utf8') === antes,
      `${sinTerminal.status}\n${sinTerminal.stderr}`);
  } else {
    console.log('  ⏭ T18b no se corre desde una terminal de verdad: el candado pediría la confirmación a mano (corre en CI y sin terminal)');
  }
  // La escritura en sí —lo que corre DESPUÉS de la confirmación— se prueba llamando a la función, como las demás
  // pruebas de firmas llaman a appendWaiver.
  const prevLog = process.env.TYCON_WAIVER_LOG;
  process.env.TYCON_WAIVER_LOG = homeLog;
  try {
    const mig = require(MIGRATE);
    const { plan } = mig.armarPlan([repo]);
    mig.escribirPlan(plan);
  } finally {
    if (prevLog === undefined) delete process.env.TYCON_WAIVER_LOG; else process.env.TYCON_WAIVER_LOG = prevLog;
  }
  const v = waiverLib.verifyChain(destino);
  check('T18 una migración descartada en el destino se vuelve a escribir y vale',
    v.entries.some((e) => e.story === '9.9' && e.acs.includes(2)), JSON.stringify(v));
}

// T22 — Waiver_AuditReasons_Unchanged: el auditor de razones sigue leyendo las firmas válidas de un registro lineal.
{
  const { spawnSync } = require('child_process');
  const AUDIT = path.join(__dirname, '..', 'audit-waiver-reasons.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-717-'));
  fs.mkdirSync(path.join(tmp, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'specs', 'story-9.9.md'),
    ['---', 'story: 9.9', 'runtime_not_verifiable:', '  - ac: 2', '    reason: "se prueba a mano en la pantalla"', '    covered_by: T2', '---', ''].join('\n'));
  const homeLog = path.join(tmp, 'w.jsonl');
  const a = colgada717('', firma717('9.9', [2]));
  const b = colgada717(a.chain, firma717('9.9', [2]));
  fs.writeFileSync(homeLog, [a, b].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r = spawnSync(process.execPath, [AUDIT, '--repos', tmp], { encoding: 'utf8', env: { ...process.env, TYCON_WAIVER_LOG: homeLog } });
  check('T22 el auditor de razones lee las dos firmas válidas de un registro lineal',
    r.status === 0 && /2 ACs aprobados/.test(r.stdout) && /delega la prueba a una persona/.test(r.stdout), `${r.stdout}\n${r.stderr}`);
}

// 13. Story exenta → verde directo.
{
  const f = makeWorkspace({ ack: ['dod_runtime_exempt: true'] });
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('dod_runtime_exempt → verde', r.exempt === true && r.green === true);
  // story 7.27: la exenta también dice de qué repo es y sus totales. Sin eso, el candado de la guía QA buscaba las
  // pantallas en ningún lado («no están en el disco») y el generador de la guía se caía leyendo `stats.total`.
  check('dod_runtime_exempt → trae el repo de la story', Boolean(r.repoRoot) && fs.realpathSync(r.repoRoot) === fs.realpathSync(f.repo), `repoRoot=${r.repoRoot} repo=${f.repo}`);
  check('dod_runtime_exempt → trae los totales en cero', r.stats && r.stats.total === 0 && r.stats.runtime === 0 && r.stats.waived === 0 && r.stats.notVerifiable === 0, JSON.stringify(r.stats));
}

// 14. Story sin ACs ni tabla → error estructural (fail-closed).
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rmx-'));
  const specsDir = path.join(ws, 'Proj', 'specs', 'stories');
  fs.mkdirSync(specsDir, { recursive: true });
  const p = path.join(specsDir, '9-9-empty.md');
  fs.writeFileSync(p, '---\nstory: 9.9\n---\n\n## Notas\n\nnada\n');
  // gatesLogPath temp SIEMPRE: sin él, compute() cae al gates.log REAL del home — read-only e
  // inocuo con este fixture, pero ahora que el instalador corre esta suite en cada máquina,
  // acoplar un test al estado del HOME del dev es pedir un flaky.
  const r = rm.compute({ storyPath: p, gatesLogPath: path.join(ws, 'gates.log') });
  check('story sin ACs → structural error', !!r.structuralError);
}

// 15. Universo de ACs = sección ∪ tabla (AC solo-en-tabla cuenta igual).
{
  const f = makeWorkspace();
  // agregar a la tabla una fila con AC 4 que NO está en la sección AC
  const spec = fs.readFileSync(f.storyPath, 'utf8')
    .replace('| E1 |', '| T9 | `Extra` | 4 | unit | x | y |\n| E1 |');
  fs.writeFileSync(f.storyPath, spec);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  const w = r.warnings.find((x) => /SOLO la tabla/.test(x));
  check('AC solo-en-tabla entra al universo', r.acs.includes(4) && !!w);
  // La REDACCIÓN es parte del contrato: este aviso decía "revisar formato de la story" y
  // así fue como el bug del parser sobrevivió a la Story 4.21 (disparó con 31 ACs y se leyó
  // como una rareza del spec). Tiene que mandar a descartar el parser ANTES que la story.
  check('el aviso manda a descartar el parser, no a culpar al formato de la story',
    !!w && /parser/.test(w) && !/revisar formato de la story/.test(w));
}

// 16. REGRESIÓN — storyPath RELATIVO computa IGUAL que absoluto.
// `marker.js complete-step 8` pasa `marker.storyPath`, que `pipeline.js start` guarda RELATIVO al
// repo. Con un path relativo, `discoverWorkspaceRoot` llegaba a basename==='specs' y devolvía
// `path.dirname(path.dirname('specs'))` === '.', o sea el repo en vez del workspace → la discovery
// de evidencia buscaba en '<repo>/<hijo>/.advisors/dod-runtime' y no encontraba NADA. El gate del
// commit-prep bloqueaba con la matriz realmente verde, para cualquier dev, en cualquier story.
// Caso: Story 4.17 de un repo del equipo 2026-07-24 (standalone VERDE 8/8 vs gate ROJA 0/8, misma evidencia).
{
  const f = makeWorkspace();
  // Evidencia REAL (gate E2E con espejo run-check + tests-result) → hay algo que encontrar.
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString());

  const abs = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  // El mismo cómputo desde el REPO, con el path relativo tal como lo guarda `pipeline.js start`
  // (`specs/stories/<story>.md`) — que es literalmente lo que `complete-step 8` le pasa.
  const cwd0 = process.cwd();
  let rel;
  try {
    process.chdir(path.join(f.ws, 'Proj'));
    rel = rm.compute({ storyPath: path.join('specs', 'stories', '9-9-fixture.md'), gatesLogPath: f.gatesLog });
  } finally {
    process.chdir(cwd0);
  }

  check('storyPath relativo ≡ absoluto (mismo veredicto)', rel.green === abs.green,
    `abs.green=${abs.green} rel.green=${rel.green}`);
  check('storyPath relativo ENCUENTRA la evidencia (mismos pendientes)',
    JSON.stringify(rel.pendientes) === JSON.stringify(abs.pendientes),
    `abs=${JSON.stringify(abs.pendientes)} rel=${JSON.stringify(rel.pendientes)}`);
  check('storyPath relativo da el MISMO hash de matriz', rel.hash === abs.hash,
    `abs=${abs.hash} rel=${rel.hash}`);
}

// 17. Multi-tanda (Story M-1 de un producto del equipo, 2026-08-05): los acs_pending de una tanda `blocked` se
//     EXCLUYEN del universo (deuda declarada con blocked_by — su superficie no existe todavía);
//     los de una tanda `pending` (la que se está entregando) NO se excluyen. Sin el fix, los
//     ACs del frontend bloqueado contaban como NOT-RUN y bloqueaban el commit-prep de toda
//     story multi-tanda sin salida legítima (NOT-RUN no es waiveable).
{
  const f = makeWorkspace({ ack: [
    'pipelines:',
    '  - name: A-backend',
    '    status: pending',
    '    acs_pending: [1, 2]',
    '  - name: B-frontend',
    '    status: blocked',
    '    blocked_by: "espera merge de A"',
    '    acs_pending: [3]',
  ] });
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('tanda blocked: su AC queda FUERA del universo', !r.acs.includes(3) && r.perAc[3] === undefined,
    `acs=${JSON.stringify(r.acs)}`);
  check('tanda pending (la que se entrega) NO se excluye', r.acs.includes(1) && r.acs.includes(2),
    `acs=${JSON.stringify(r.acs)}`);
  check('la exclusión queda VISIBLE en warnings', r.warnings.some((w) => /blocked/.test(w) && /3/.test(w)),
    JSON.stringify(r.warnings));
  check('el AC excluido no aparece en pendientes', !(r.pendientes || []).some((p) => String(p).includes('3')),
    JSON.stringify(r.pendientes));
}

// 18. DODRT-C8 (2026-08-05, caso disparador: la Story M-1 de un producto del equipo): un AC que describe una ACCIÓN
//     ("puede asignar una ruta") no puede quedar 🟢 RUNTIME si la corrida sólo MIRÓ la pantalla.
//     El bug real: el E2E asertaba que el botón "Iniciar ruta" era visible, la matriz lo dio
//     verde, el pipeline cerró, y la acción fallaba en la app. El test debe FALLAR sin el fix.
{
  const f = makeWorkspace();
  // Reescribo los ACs: #1 de lectura, #3 de ACCIÓN. Ambos cubiertos por el mismo E2E.
  const story = fs.readFileSync(f.storyPath, 'utf8')
    .replace('3. **Given** otra cosa, **Then** otro resultado.',
      '3. Desde un item, el encargado puede asignar una ruta por los caminos que ya existen.');
  fs.writeFileSync(f.storyPath, story);

  // (a) El gate pasó pero NINGÚN test ejerció la acción (títulos sin @mutates)
  // 🔴 Los timestamps se DERIVAN del reloj de la corrida (futureCompact — posteriores a la mtime
  // del código, que makeWorkspace setea a now-1h). La versión anterior los tenía HARDCODEADOS
  // ('20260805T233000Z'): pasaban sólo el día en que se escribieron, y desde el 2026-08-06 el
  // chequeo de frescura los rechazaba → 6 casos de esta sección estuvieron 8 días en rojo sin
  // que nadie lo viera. Un test cuya expectativa compara una fecha fija contra «ahora» es una
  // bomba de tiempo (detectado 2026-08-13, corrida de la Story 4.34 de un repo del equipo).
  const ts18a = recentCompact(30);
  const ts18b = recentCompact(20);
  const ts18c = recentCompact(10);
  writeGate(f.dodDir, '9.9', ts18a, 'PASS', 'story-9-9.spec.ts', f.gatesLog, true,
    ['flujo: abre la vista y ve el botón de asignar @ac-1 @ac-3']);
  let r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('AC de LECTURA cubierto por E2E sigue RUNTIME', r.perAc[1].verdict === 'RUNTIME', r.perAc[1].verdict);
  check('AC de ACCIÓN sin ejecutar → RUNTIME-PARCIAL (no verde)', r.perAc[3].verdict === 'RUNTIME-PARCIAL', r.perAc[3].verdict);
  check('el parcial BLOQUEA la matriz', r.green === false, `green=${r.green}`);
  check('el parcial aparece en pendientes', (r.pendientes || []).includes(3), JSON.stringify(r.pendientes));
  check('el warning explica cómo cerrarlo', r.warnings.some((w) => /@mutates/.test(w) && /#3/.test(w)),
    JSON.stringify(r.warnings.slice(-2)));

  // (b) Mismo caso pero el test SÍ aprieta el botón (@mutates + @ac-3) → cierra
  fs.rmSync(path.join(f.dodDir, `9.9-e2e-gate-${ts18a}.md`));
  writeGate(f.dodDir, '9.9', ts18b, 'PASS', 'story-9-9.spec.ts', f.gatesLog, true,
    ['flujo: abre la vista @ac-1', '@mutates aprieta Confirmar y la app reacciona @ac-3']);
  r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('AC de ACCIÓN con test @mutates → RUNTIME pleno', r.perAc[3].verdict === 'RUNTIME', r.perAc[3].verdict);
  check('la evidencia nombra el test que ejecutó la acción', /@mutates/.test(r.perAc[3].mutacion || ''), r.perAc[3].mutacion);
  check('sin parciales, la matriz puede quedar verde', (r.accionNoEjercida || []).length === 0,
    JSON.stringify(r.accionNoEjercida));

  // (c) El @mutates de OTRO AC no cierra éste (la marca es por-AC, no global)
  fs.rmSync(path.join(f.dodDir, `9.9-e2e-gate-${ts18b}.md`));
  writeGate(f.dodDir, '9.9', ts18c, 'PASS', 'story-9-9.spec.ts', f.gatesLog, true,
    ['@mutates aprieta otra cosa @ac-1', 'flujo mira el botón @ac-3']);
  r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('@mutates de otro AC NO cierra el AC de acción', r.perAc[3].verdict === 'RUNTIME-PARCIAL', r.perAc[3].verdict);
}

// 19. DODRT-C8 — calibración anti-ruido: un AC SIN verbo de mutación nunca cae en la regla,
//     y la escotilla documentada la desactiva (dejando rastro) sin tocar código.
{
  const f = makeWorkspace();
  writeGate(f.dodDir, '9.9', recentCompact(30), 'PASS', 'story-9-9.spec.ts', f.gatesLog, true,
    ['flujo sólo observa @ac-1 @ac-3']);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('ACs de sólo-lectura no disparan la regla', (r.accionNoEjercida || []).length === 0,
    JSON.stringify(r.accionNoEjercida));

  const f2 = makeWorkspace();
  fs.writeFileSync(f2.storyPath, fs.readFileSync(f2.storyPath, 'utf8')
    .replace('3. **Given** otra cosa, **Then** otro resultado.', '3. El usuario puede confirmar la operación.'));
  writeGate(f2.dodDir, '9.9', recentCompact(30), 'PASS', 'story-9-9.spec.ts', f2.gatesLog, true,
    ['flujo sólo observa @ac-1 @ac-3']);
  process.env.TYCON_RUNTIME_MATRIX_NO_MUTATION_CHECK = '1';
  delete require.cache[require.resolve(path.join(__dirname, '..', 'runtime-matrix.js'))];
  const rmLegacy = require(path.join(__dirname, '..', 'runtime-matrix.js'));
  const rLegacy = rmLegacy.compute({ storyPath: f2.storyPath, gatesLogPath: f2.gatesLog });
  check('la escotilla documentada desactiva la regla', (rLegacy.accionNoEjercida || []).length === 0,
    JSON.stringify(rLegacy.accionNoEjercida));
  delete process.env.TYCON_RUNTIME_MATRIX_NO_MUTATION_CHECK;
}

// 20. DODRT-C8 — productos SIN superficie HTTP ni navegador (caso disparador: Story 4.34 de
//     un repo del equipo, 2026-08-13). El MCP habla por stdio: sus smokes son `node <script>.mjs` y
//     adentro MUTAN de verdad (borran procesos de la plataforma), pero el detector por-comando
//     (`-X DELETE`/`--data`) no puede verlos → toda story de ese paquete que mutara quedaba
//     RUNTIME-PARCIAL para siempre y salía por la escotilla. La salida honesta es el marcador
//     explícito `--mutates` de smoke-run.sh — NO más débil que mirar el comando: un `-X DELETE`
//     dentro de un curl también lo escribe el agente; la garantía real siempre fue el exit code
//     que el wrapper captura. Anti-forja: el flag cuenta SOLO si el ESPEJO de gates.log (fuera
//     del repo, append-only) trae `"mutates":true` en la MISMA línea de esa corrida — editar el
//     ledger del repo a mano no alcanza.
{
  // (a) AC de ACCIÓN + smoke declarado con --mutates (flag en ledger Y espejo) → RUNTIME pleno.
  const f = makeWorkspace();
  fs.writeFileSync(f.storyPath, fs.readFileSync(f.storyPath, 'utf8')
    .replace('3. **Given** otra cosa, **Then** otro resultado.',
      '3. La tool puede borrar una versión publicada, nombrando qué.'));
  const ts = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(f.dodDir, '9.9-smoke-ledger.jsonl'),
    JSON.stringify({ ts, story: '9.9', acs: [3], cmd: 'node .advisors/smoke-e2e.mjs', exit: 0, via: 'smoke-run.sh', mutates: true }) + '\n');
  fs.appendFileSync(f.gatesLog,
    JSON.stringify({ type: 'smoke-run', ts, story: '9.9', acs: [3], exit: 0, mutates: true }) + '\n');
  let r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('smoke declarado --mutates cierra el AC de acción (RUNTIME pleno)',
    r.perAc[3].verdict === 'RUNTIME', r.perAc[3].verdict);
  check('la evidencia nombra al smoke declarado', /--mutates/.test(r.perAc[3].mutacion || ''), r.perAc[3].mutacion);

  // (b) 🔴 Anti-forja: el flag SOLO en el ledger del repo (el espejo no lo trae) NO cuenta —
  //     agregarle `"mutates":true` a una entry existente editando el archivo a mano no cierra nada.
  const f2 = makeWorkspace();
  fs.writeFileSync(f2.storyPath, fs.readFileSync(f2.storyPath, 'utf8')
    .replace('3. **Given** otra cosa, **Then** otro resultado.',
      '3. La tool puede borrar una versión publicada, nombrando qué.'));
  const ts2 = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(f2.dodDir, '9.9-smoke-ledger.jsonl'),
    JSON.stringify({ ts: ts2, story: '9.9', acs: [3], cmd: 'node .advisors/smoke-e2e.mjs', exit: 0, via: 'smoke-run.sh', mutates: true }) + '\n');
  fs.appendFileSync(f2.gatesLog,
    JSON.stringify({ type: 'smoke-run', ts: ts2, story: '9.9', acs: [3], exit: 0 }) + '\n'); // espejo SIN el flag
  r = rm.compute({ storyPath: f2.storyPath, gatesLogPath: f2.gatesLog });
  check('mutates SOLO en el ledger (espejo sin flag) NO cierra — anti-forja',
    r.perAc[3].verdict === 'RUNTIME-PARCIAL', r.perAc[3].verdict);
  check('el smoke sigue contando como evidencia runtime a secas (el AC queda parcial, no SIN-EVIDENCIA)',
    (r.perAc[3].runtime || []).length > 0, JSON.stringify(r.perAc[3].runtime));

  // (c) 🔴 Anti-forja del EXIT (crítico de la revisión 2026-08-13): la corrida real FALLÓ (el
  //     espejo tiene exit 1) y alguien edita el `exit` del ledger del repo a 0. Sin atar el exit
  //     a la línea del espejo, la matriz daba RUNTIME verde diciendo «espejo verificado» — la
  //     garantía entera de la vía es el exit code, así que ES el campo que el espejo confirma.
  const f3 = makeWorkspace();
  fs.writeFileSync(f3.storyPath, fs.readFileSync(f3.storyPath, 'utf8')
    .replace('3. **Given** otra cosa, **Then** otro resultado.',
      '3. La tool puede borrar una versión publicada, nombrando qué.'));
  const ts3 = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(f3.dodDir, '9.9-smoke-ledger.jsonl'),
    JSON.stringify({ ts: ts3, story: '9.9', acs: [3], cmd: 'node .advisors/smoke-e2e.mjs', exit: 0, via: 'smoke-run.sh', mutates: true }) + '\n');
  fs.appendFileSync(f3.gatesLog,
    JSON.stringify({ type: 'smoke-run', ts: ts3, story: '9.9', acs: [3], exit: 1, mutates: true }) + '\n');
  r = rm.compute({ storyPath: f3.storyPath, gatesLogPath: f3.gatesLog });
  check('exit forjado en el ledger (el espejo dice exit 1) → el smoke NO cuenta en absoluto',
    (r.perAc[3].runtime || []).length === 0 && r.perAc[3].verdict !== 'RUNTIME',
    `${r.perAc[3].verdict} runtime=${JSON.stringify(r.perAc[3].runtime)}`);

  // (d) Dos corridas de la MISMA story en el MISMO segundo (pasa en la práctica): la primera
  //     línea del espejo no trae el flag; la segunda sí. La legítima tiene que contar igual —
  //     el match no puede quedarse con la primera línea que encuentra.
  const f4 = makeWorkspace();
  fs.writeFileSync(f4.storyPath, fs.readFileSync(f4.storyPath, 'utf8')
    .replace('3. **Given** otra cosa, **Then** otro resultado.',
      '3. La tool puede borrar una versión publicada, nombrando qué.'));
  const ts4 = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(f4.dodDir, '9.9-smoke-ledger.jsonl'),
    JSON.stringify({ ts: ts4, story: '9.9', acs: [3], cmd: 'node .advisors/smoke-e2e.mjs', exit: 0, via: 'smoke-run.sh', mutates: true }) + '\n');
  fs.appendFileSync(f4.gatesLog,
    JSON.stringify({ type: 'smoke-run', ts: ts4, story: '9.9', acs: [1], exit: 0 }) + '\n' +
    JSON.stringify({ type: 'smoke-run', ts: ts4, story: '9.9', acs: [3], exit: 0, mutates: true }) + '\n');
  r = rm.compute({ storyPath: f4.storyPath, gatesLogPath: f4.gatesLog });
  check('colisión de segundo: la línea correcta del espejo valida aunque no sea la primera',
    r.perAc[3].verdict === 'RUNTIME', r.perAc[3].verdict);

  // (e) El espejo también ata los ACs: una entry escrita a mano en el ledger que reusa el ts de
  //     una corrida legítima pero declara OTROS acs no se valida con la línea de aquélla.
  const f5 = makeWorkspace();
  fs.writeFileSync(f5.storyPath, fs.readFileSync(f5.storyPath, 'utf8')
    .replace('3. **Given** otra cosa, **Then** otro resultado.',
      '3. La tool puede borrar una versión publicada, nombrando qué.'));
  const ts5 = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(f5.dodDir, '9.9-smoke-ledger.jsonl'),
    JSON.stringify({ ts: ts5, story: '9.9', acs: [3], cmd: 'node x.mjs', exit: 0, via: 'smoke-run.sh', mutates: true }) + '\n');
  fs.appendFileSync(f5.gatesLog, // la corrida legítima de ese segundo fue sobre el AC 1, no el 3
    JSON.stringify({ type: 'smoke-run', ts: ts5, story: '9.9', acs: [1], exit: 0, mutates: true }) + '\n');
  r = rm.compute({ storyPath: f5.storyPath, gatesLogPath: f5.gatesLog });
  check('acs que no coinciden con la línea del espejo → la entry del ledger no cuenta',
    (r.perAc[3].runtime || []).length === 0, JSON.stringify(r.perAc[3].runtime));
}

// 21. REGRESIÓN — evidencia de un repo HERMANO no se atribuye a la story (2026-08-14, caso
//     real: Story 4.36 de un repo del equipo reportada "cubierta" por el tests-result.json de
//     el frontend de otro producto — otro repo, otra story 10.3.1, otro producto; el warning "es de OTRA
//     story" disparaba y la evidencia contaba igual). Tercera falla de la familia F.iii:
//     el gate se equivoca por plumbing (vecindad en el filesystem), no por el estado real.
//     La evidencia sale del repo git que CONTIENE la story; un hermano solo cuenta si está
//     declarado en .tycon/advisors.yaml → evidence.companion_repos (caso 22).
{
  // (a) tests-result verde de un hermano, de OTRA story — el caso reportado literal.
  const f = makeWorkspace();
  const sib = addSiblingRepo(f.ws, 'AjenoFrontEnd');
  writeTestsResult(sib.advDir, '10.3.1', true, new Date().toISOString());
  let r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('tests-result de un repo hermano NO cuenta como evidencia de código',
    r.perAc[2].code.length === 0 && r.perAc[2].verdict === 'NOT-RUN',
    `code=${JSON.stringify(r.perAc[2].code)} verdict=${r.perAc[2].verdict}`);

  // (b) gate E2E PASS espejado que vive en el hermano y RECLAMA esta story.
  const f2 = makeWorkspace();
  const sib2 = addSiblingRepo(f2.ws, 'AjenoFrontEnd');
  writeGate(sib2.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f2.gatesLog);
  r = rm.compute({ storyPath: f2.storyPath, gatesLogPath: f2.gatesLog });
  check('gate E2E que vive en un repo hermano NO da RUNTIME',
    r.perAc[1].verdict !== 'RUNTIME' && r.perAc[3].verdict !== 'RUNTIME',
    `ac1=${r.perAc[1].verdict} ac3=${r.perAc[3].verdict}`);
  check('la exclusión queda ESCRITA: nombra al repo y cómo declararlo si es legítimo',
    r.warnings.some((w) => /AjenoFrontEnd/.test(w) && /companion_repos/.test(w)),
    JSON.stringify(r.warnings));

  // (c) smoke ledger espejado que vive en el hermano.
  const f3 = makeWorkspace();
  const sib3 = addSiblingRepo(f3.ws, 'AjenoFrontEnd');
  writeMirroredSmoke(sib3.dodDir, f3.gatesLog, '9.9', [2]);
  r = rm.compute({ storyPath: f3.storyPath, gatesLogPath: f3.gatesLog });
  check('smoke ledger que vive en un repo hermano NO da RUNTIME',
    r.perAc[2].verdict !== 'RUNTIME', r.perAc[2].verdict);

  // (d) la evidencia PROPIA (mismo repo) sigue contando igual que siempre, con el hermano ahí.
  const f4 = makeWorkspace();
  addSiblingRepo(f4.ws, 'AjenoFrontEnd');
  writeGate(f4.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f4.gatesLog);
  writeTestsResult(f4.advDir, '9.9', true, new Date().toISOString());
  r = rm.compute({ storyPath: f4.storyPath, gatesLogPath: f4.gatesLog });
  check('la evidencia del PROPIO repo sigue contando',
    r.perAc[1].verdict === 'RUNTIME' && r.perAc[2].verdict !== 'SIN-EVIDENCIA' && r.perAc[2].code.length > 0,
    JSON.stringify(r.perAc));
}

// 22. El caso legítimo FE/BE en repos separados de un MISMO producto se DECLARA, no se adivina:
//     .tycon/advisors.yaml → evidence.companion_repos en el repo de la story. Con la
//     declaración, la evidencia del companion cuenta; sin warning de exclusión.
{
  const f = makeWorkspace();
  const sib = addSiblingRepo(f.ws, 'ProjFrontEnd');
  fs.mkdirSync(path.join(f.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.tycon', 'advisors.yaml'),
    '# config del repo\nevidence:\n  companion_repos:\n    - ProjFrontEnd\ne2e:\n  frontend_dir: fe\n');
  writeGate(sib.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  writeMirroredSmoke(sib.dodDir, f.gatesLog, '9.9', [2]);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('companion declarado: su gate E2E SÍ da RUNTIME', r.perAc[1].verdict === 'RUNTIME', r.perAc[1].verdict);
  check('companion declarado: su smoke SÍ da RUNTIME', r.perAc[2].verdict === 'RUNTIME', r.perAc[2].verdict);
  check('companion declarado: sin warning de exclusión',
    !r.warnings.some((w) => /ProjFrontEnd/.test(w) && /companion_repos/.test(w)), JSON.stringify(r.warnings));

  // companion declarado pero INEXISTENTE → no rompe, avisa.
  const f2 = makeWorkspace();
  fs.mkdirSync(path.join(f2.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(f2.repo, '.tycon', 'advisors.yaml'),
    'evidence:\n  companion_repos:\n    - NoExiste\n');
  const r2 = rm.compute({ storyPath: f2.storyPath, gatesLogPath: f2.gatesLog });
  check('companion declarado inexistente → warning, no crash',
    !r2.structuralError && r2.warnings.some((w) => /NoExiste/.test(w)), JSON.stringify(r2.warnings));
}

// 23. Sin repo git determinable NO hay atribución segura → NINGUNA evidencia cuenta,
//     con el motivo escrito (fail-closed; un warning que igual suma es peor que nada).
{
  const f = makeWorkspace({ noGit: true });
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString());
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('sin repo git: la evidencia NO cuenta (fail-closed)',
    r.perAc[1].verdict !== 'RUNTIME' && r.perAc[2].code.length === 0,
    `ac1=${r.perAc[1].verdict} code2=${JSON.stringify(r.perAc[2].code)}`);
  check('sin repo git: el motivo queda escrito',
    r.warnings.some((w) => /repo git/i.test(w)), JSON.stringify(r.warnings));
  // El override explícito --evidence-dir sigue siendo la salida (atribución manual del caller).
  const r2 = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog, evidenceDirs: [f.dodDir] });
  check('sin repo git + --evidence-dir explícito: esa evidencia sí cuenta',
    r2.perAc[1].verdict === 'RUNTIME', r2.perAc[1].verdict);
}

// 24. Staleness con paths ws-relativos (estilo Ceibo: el frontmatter nombra el repo en el
//     path). La resolución prueba repo-root Y workspace-root; si ninguna existiera, mtime=0
//     y el chequeo de frescura quedaría ciego (gates viejos contando como frescos).
{
  const f = makeWorkspace({ wsRelFiles: true });
  writeGate(f.dodDir, '9.9', recentCompact(30), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  fs.utimesSync(f.codeFile, new Date(), new Date()); // código recién editado
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('path ws-relativo: el gate stale sigue sin contar (la frescura ve el archivo)',
    r.perAc[1].verdict !== 'RUNTIME' && r.warnings.some((w) => /ANTERIOR al último edit/.test(w)),
    r.perAc[1].verdict);
}

// 25. Repo de UNA sola suite: la suite verde del propio repo cubre también las filas cuyo
//     NOMBRE matchea el hint FE (`foo.test.js` clasifica 'fe'). Antes esas filas buscaban una
//     suite "fe" que en un repo backend-only no existe — y la aportaba, mal, el tests-result
//     de un repo hermano (el síntoma visible del bug de atribución en la 4.36 de un repo del equipo).
//     El split fe/be sigue mandando cuando hay DOS suites en el scope.
{
  const f = makeWorkspace();
  const spec = fs.readFileSync(f.storyPath, 'utf8')
    .replace('| T2 | `FeatureTests.Caso2` |', '| T2 | `tests/unit/foo.test.js` |');
  fs.writeFileSync(f.storyPath, spec);
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString()); // única suite, path 'be'
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('única suite verde cubre la fila con nombre estilo FE (*.test.js)',
    r.perAc[2].code.length > 0, JSON.stringify(r.perAc[2]));
}

// 26. El lado FE de un producto se DECLARA (evidence.fe_paths), no se adivina por nombres de
//     producto en el harness. Dos suites en scope: la del repo (be, más nueva) y la del
//     subproyecto FE declarado — cada fila se aparea con SU suite, no con la más nueva.
{
  const f = makeWorkspace();
  const feAdv = path.join(f.repo, 'feapp', '.advisors');
  fs.mkdirSync(feAdv, { recursive: true });
  fs.mkdirSync(path.join(f.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.tycon', 'advisors.yaml'),
    'evidence:\n  fe_paths:\n    - feapp\n');
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString()); // be — la MÁS nueva
  writeTestsResult(feAdv, '9.9', true, new Date(Date.now() - 5 * 60 * 1000).toISOString()); // fe
  const spec = fs.readFileSync(f.storyPath, 'utf8')
    .replace('| T2 | `FeatureTests.Caso2` |', '| T2 | `Comp.test.tsx` |');
  fs.writeFileSync(f.storyPath, spec);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('fila FE (.test.tsx) se aparea con la suite del fe_path declarado',
    (r.perAc[2].code || []).some((c) => /feapp\/tests-result\.json/.test(c)), JSON.stringify(r.perAc[2].code));
  check('fila BE se aparea con la suite del repo, no con la más nueva a secas',
    (r.perAc[1].code || []).some((c) => /Proj\/tests-result\.json/.test(c)), JSON.stringify(r.perAc[1].code));
}

// 27. `.test.js` es un test de BACKEND (node --test), no señal de frontend. Con el hint viejo
//     (`.test.` a secas + `ceibo-deposito` EN DURO en el harness) una fila `foo.test.js`
//     se apareaba con la suite del subproyecto FE — el mismo mecanismo por el que las filas de
//     un repo del equipo "necesitaban" la suite de CeiboFrontEnd. Lo específico del producto ahora
//     vive en su .tycon/advisors.yaml, no en el regex del harness.
{
  const f = makeWorkspace();
  const feAdv = path.join(f.repo, 'ceibo-deposito', '.advisors');
  fs.mkdirSync(feAdv, { recursive: true });
  fs.mkdirSync(path.join(f.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.tycon', 'advisors.yaml'),
    'evidence:\n  fe_paths:\n    - ceibo-deposito\n');
  writeTestsResult(f.advDir, '9.9', true, new Date().toISOString()); // be
  writeTestsResult(feAdv, '9.9', true, new Date().toISOString());    // fe (declarada)
  const spec = fs.readFileSync(f.storyPath, 'utf8')
    .replace('| T2 | `FeatureTests.Caso2` |', '| T2 | `tests/unit/foo.test.js` |')
    .replace('| E1 |', '| T9 | `useFoo.test.ts` | 3 | unit | x | y |\n| E1 |');
  fs.writeFileSync(f.storyPath, spec);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('fila `.test.js` se aparea con la suite BACKEND del repo',
    (r.perAc[2].code || []).some((c) => /Proj\/tests-result\.json/.test(c)), JSON.stringify(r.perAc[2].code));
  check('fila `.test.ts` (vitest) sigue apareando con la suite FE',
    (r.perAc[3].code || []).some((c) => /ceibo-deposito\/tests-result\.json/.test(c)), JSON.stringify(r.perAc[3].code));
}

// 28. F1 del review ciego (2026-08-14): el fallback de "suite única" NO puede cubrir una fila
//     cuyo PROPIO lado tiene la suite EN ROJO. greenByKind filtra los rojos antes, así que
//     "una sola suite verde" era indistinguible de "dos suites, una roja" — y la verde del
//     otro lado validaba la declaración `covered_by` de un AC cuyo lado estaba roto (lo
//     volvía waiveable cuando debía bloquear).
{
  const f = makeWorkspace();
  const feAdv = path.join(f.repo, 'feapp', '.advisors');
  fs.mkdirSync(feAdv, { recursive: true });
  fs.mkdirSync(path.join(f.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.tycon', 'advisors.yaml'),
    'evidence:\n  fe_paths:\n    - feapp\n');
  writeTestsResult(f.advDir, '9.9', false, new Date().toISOString()); // suite BE en ROJO
  writeTestsResult(feAdv, '9.9', true, new Date().toISOString());    // suite FE verde
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('suite del propio lado ROJA: la verde del otro lado NO cubre la fila',
    (r.perAc[2].code || []).length === 0 && r.perAc[2].verdict === 'NOT-RUN',
    `code=${JSON.stringify(r.perAc[2].code)} verdict=${r.perAc[2].verdict}`);
}

// 29. F3 del review ciego: si el bloque `evidence:` existe pero el parser no le sacó NINGUNA
//     entrada, se avisa — un formato YAML válido que el parser mínimo no entiende no puede
//     degradar la config en silencio (companion perdido = rojo falso; fe_paths perdido =
//     detector de UI diluido).
{
  const f = makeWorkspace();
  fs.mkdirSync(path.join(f.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.tycon', 'advisors.yaml'),
    'evidence:\n  companion_repos:\n- MalIndentado\n'); // item a indent 0 → fuera del bloque
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('bloque evidence presente con 0 entradas parseadas → warning',
    r.warnings.some((w) => /evidence/.test(w) && /0 entradas|ninguna entrada|sin entradas/i.test(w)),
    JSON.stringify(r.warnings));
}

// 30. M1 del review ciego: sin repo git (fail-closed) el warning 🚫 de "repos NO declarados"
//     no puede acusar al PROPIO repo de la story — la evidencia ya no cuenta por el
//     fail-closed; acusarlo confunde al lector y apunta al lugar equivocado.
{
  const f = makeWorkspace({ noGit: true });
  writeGate(f.dodDir, '9.9', recentCompact(), 'PASS', 'story-9-9.spec.ts', f.gatesLog);
  const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  check('fail-closed sin repo: el 🚫 no acusa al propio repo como "NO declarado"',
    !r.warnings.some((w) => /🚫/.test(w) && /Proj/.test(w)), JSON.stringify(r.warnings));
}

// 31. DODRT-C8 — contexto del verbo de mutación (2026-08-25).
//     Casos MEDIDOS sobre la Story 1.1 de un producto del equipo (consulta-de-cliente-ombu), una feature
//     READ-ONLY: la lista léxica marcaba ACs de LECTURA como "acción sin ejecutar" y el
//     pipeline quedaba sin salida limpia (no hay acción que ejecutar, y los dos escapes
//     previstos —`--mutates` y `runtime_not_verifiable`— habrían declarado algo falso).
//
//     La asimetría manda: neutralizar de más apaga el control. Por eso cada caso que
//     NEUTRALIZA viene con su gemelo que SIGUE disparando.
{
  const esAccion = rm.acEsDeAccion;

  // --- (a) NEGACIÓN inmediata: el AC afirma que la acción NO ocurre.
  check('AC 12 real: "no se descarta por el LEFT JOIN" NO es acción',
    esAccion('`estado` viene `null` y la solicitud **igual aparece** en la lista '
      + '(no se descarta por el LEFT JOIN).') === false);
  check('"nunca se elimina" NO es acción',
    esAccion('la fila nunca se elimina del histórico') === false);

  // gemelo: sin la negación, el MISMO verbo sigue disparando.
  check('"se descarta la fila" SÍ es acción (sin negación)',
    esAccion('se descarta la fila del lote') === true);
  check('"el usuario elimina el lote" SÍ es acción',
    esAccion('el usuario elimina el lote') === true);

  // --- (b) LOOKUP: "resuelve EN/POR <catálogo>" es un match contra una tabla, no una acción.
  check('AC 11 real: "resuelve en Parameters" NO es acción',
    esAccion('un pedido con `idEstadoPedidoActual` que resuelve en `Parameters`, '
      + 'entonces `estado` trae el `ParameterName`') === false);
  check('"se resuelve por TypeName" NO es acción',
    esAccion('el tipo de envío se resuelve por `ParametersTypes.TypeName`') === false);

  // gemelo: "resolver" como MUTACIÓN real (sin complemento de lookup) sigue disparando.
  check('"el encargado resuelve el reclamo" SÍ es acción',
    esAccion('el encargado resuelve el reclamo y el caso pasa a cerrado') === true);
  check('"resolver el ticket" SÍ es acción',
    esAccion('el operador puede resolver el ticket desde la grilla') === true);

  // gemelo del gemelo: el guard de lookup vale SÓLO para 'resolver'. Si se aplicara a
  // cualquier verbo, todo "se <muta> en/por <algo>" quedaría neutralizado — falso negativo
  // caro y silencioso. (Estos dos casos nacieron de un mutante que sobrevivió al chequeo.)
  check('"se registra en la tabla" SÍ es acción (en/por no neutraliza a otros verbos)',
    esAccion('el movimiento se registra en la tabla de auditoría') === true);
  check('"se envía por mail" SÍ es acción',
    esAccion('el comprobante se envía por mail al beneficiario') === true);

  // --- (c) La neutralización es POR APARICIÓN: si alguna sobrevive, el AC es de acción.
  //     Éste es el guard que evita que un "no" suelto apague un AC que sí muta.
  check('un verbo negado NO tapa a otro verbo sin negar en el mismo AC',
    esAccion('el lote no se elimina, pero se crea una contrapartida') === true);

  // --- (d) El caso disparador ORIGINAL de DODRT-C8 (Story M-1) sigue detectándose.
  check('regresión del caso original: "puede asignar una ruta" SÍ es acción',
    esAccion('el encargado puede asignar una ruta a un repartidor de la zona') === true);

  // --- (e) Una negación LEJANA no debe apagar el verbo (falso negativo caro).
  check('negación lejana no neutraliza: "sin permisos … puede asignar" SÍ es acción',
    esAccion('un usuario sin permisos de zona igualmente puede asignar el caso') === true);
}

// 32. DODRT-C8 — ENDURECIMIENTO: la negación no neutraliza un AC de RE-EJECUCIÓN (2026-08-25).
//     El fix de contexto (caso 31) rescató 222 ACs sobre las 1222 stories del equipo. Nueve de
//     esos rescates estaban MAL: criterios de idempotencia/concurrencia donde la acción SÍ se
//     ejecuta (dos veces) y la negación califica al DUPLICADO, no a la acción. Son justo los ACs
//     donde más vale exigir la mutación corrida de verdad: un duplicado sólo aparece corriendo.
//
//     El guard pide DOS señales juntas (repetición + duplicación). Cada caso que RE-BLOQUEA va
//     con su gemelo que tiene una sola señal y DEBE seguir rescatado — es la mitad cara del
//     control: con una señal sola vuelven a bloquearse ACs de lectura legítimos.
{
  const esAccion = rm.acEsDeAccion;

  // --- RE-BLOQUEA: los arquetipos medidos en el corpus real.
  check('idempotencia: "ya iniciada … NO crea registro duplicado" SÍ es acción',
    esAccion('Doble inicio (idempotente): IniciarTransoperatorio con orden ya iniciada '
      + 'retorna 200 OK con etapaProcesoId existente — NO crea registro duplicado.') === true);
  check('re-ejecución: "se vuelve a escanear … status duplicate" SÍ es acción',
    esAccion('Given una muestra cuyo evento de Recepción ya está COMPLETADO When se vuelve a '
      + 'escanear Then devuelve status: "duplicate" y NO se crea un segundo evento.') === true);
  check('concurrencia: "nunca se asigna la misma extension dos veces" SÍ es acción',
    esAccion('Dos asignaciones concurrentes al mismo proyecto se serializan — nunca se asigna '
      + 'la misma extension dos veces') === true);
  check('seeds idempotentes: "re-ejecutar … NO se crea un script nuevo" SÍ es acción',
    esAccion('Los seeds son idempotentes (re-ejecutar el baseline no falla ni duplica). NO se '
      + 'crea un script incremental nuevo: el baseline es la única fuente.') === true);

  // --- GEMELOS: una sola señal NO alcanza. Si alguno de estos se pone rojo, el guard se
  //     ensanchó y volvimos a bloquear ACs de lectura — el problema que el caso 31 arregló.
  check('sólo duplicación (sin repetición): "NO duplicar ExportHelpers.cs" NO es acción',
    esAccion('NO duplicar Features/Listados/Services/ExportHelpers.cs: esta story es owner '
      + 'del archivo. Story 8.4 lo CONSUME (no crea, no duplica).') === false);
  check('sólo repetición (sin duplicación): "ya existe … 409" NO es acción',
    esAccion('Given un alta cuyo documento ya existe en un cliente activo When el backend '
      + 'responde 409 Then el modal permanece abierto y muestra el mensaje.') === false);
  check('sólo repetición: "ya está activo … no crea nada" NO es acción',
    esAccion('Given un id que no existe o que ya está activo When se reactiva Then responde '
      + '404 — no crea nada.') === false);
  // "ya es" NO cuenta como repetición: fue el único falso positivo medido del primer intento.
  check('"ya es el WARNING … no se duplica el reporte" NO es acción',
    esAccion('Then no emite nada — el caso del nombre no declarado ya es el WARNING '
      + 'ir-undeclared-data-ref de 3.13, y no se duplica el reporte') === false);

  // --- El endurecimiento NO toca el neutralizador de lookup (b): el caso de ese producto sigue verde.
  check('AC 11 de FRESNO: "resuelve en Parameters" sigue sin ser acción',
    esAccion('un pedido con idEstadoPedidoActual que resuelve en Parameters') === false);
}

// 32b. DODRT-C8 — condicional y rechazo HTTP (2026-10-07, story 11.4 de un producto del equipo). Los dos
//      AC que hubo que eximir a mano: uno describe lo que PASARÍA si el rollback cayera en la carpeta de
//      deploy, el otro un pedido que se rechaza con 401. Cada neutralizador va con su gemelo que SIGUE
//      disparando: el futuro y el rechazo de una persona sí son acciones.
{
  const esAccion = rm.acEsDeAccion;
  check('condicional: "cada deploy borraría la columna y cerraría todos los plugins" NO es acción',
    esAccion('El rollback vive en database-rollback/: rollback.sql ordena antes que .sql, así que cada '
      + 'deploy borraría la columna y cerraría todos los plugins.') === false);
  check('gemelo: el futuro "se creará el registro" SÍ es acción',
    esAccion('When confirma el alta Then se creará el registro en la tabla') === true);
  check('rechazo HTTP: "se rechaza sin invocar el handler: `401`" NO es acción',
    esAccion('Given un externo cuyo usuario no existe When llega Then se rechaza sin invocar el handler: '
      + '`401`, motivo invalid_claims.') === false);
  check('gemelo: "el supervisor rechaza la solicitud" (sin código) SÍ es acción',
    esAccion('When el supervisor rechaza la solicitud Then queda en estado Rechazada') === true);
  check('gemelo: el código en OTRA oración no neutraliza ("rechaza la solicitud. … 403")',
    esAccion('When el supervisor rechaza la solicitud. Un usuario sin rol recibe 403.') === true);
}

// 32c. DODRT-C8 — «sin» + infinitivo (2026-10-09, arreglo suelto que viaja con la story 7.18 del arnés).
//      «sus pruebas pasan SIN EDITAR» describe algo que no pasa. Cada caso va con su gemelo que SIGUE
//      disparando: un verbo de acción en otra parte de la oración, y los criterios de idempotencia o
//      repetición, donde la acción sí corre (con una sola señal alcanza).
{
  const esAccion = rm.acEsDeAccion;
  check('sin + infinitivo: "sus pruebas pasan sin editar" NO es acción',
    esAccion('Then sus pruebas pasan sin editar ni una línea') === false);
  check('sin + infinitivo: "reusa el servicio sin modificar sus contratos" NO es acción',
    esAccion('Las transiciones reusan el servicio de escaneo sin modificar sus contratos.') === false);
  check('gemelo: "guarda el pedido sin confirmar el aviso" SÍ es acción',
    esAccion('el operador guarda el pedido sin confirmar el aviso') === true);
  check('gemelo: idempotencia — "el mismo pedido 2x → 200 sin crear duplicado" SÍ es acción',
    esAccion('el mismo pedido 2x → 200 sin crear duplicado') === true);
  check('gemelo: "llega de nuevo … sin crear acción ni mensaje" SÍ es acción',
    esAccion('When el evento llega de nuevo Then responde 200 sin crear acción ni mensaje') === true);
  // Los gemelos de repetición que encontró la revisión adversarial antes de implementar: sin estas señales,
  // los cinco pasaban a lectura.
  check('gemelo: "llega nuevamente con el mismo id … sin crear otro registro" SÍ es acción',
    esAccion('When el webhook llega nuevamente con el mismo id, Then responde 200 sin crear otro registro') === true);
  check('gemelo: "el job corre otra vez … sin enviar el mail" SÍ es acción',
    esAccion('When el job corre otra vez, Then termina sin enviar el mail') === true);
  check('gemelo: "el cliente reenvía el formulario … sin crear otra orden" SÍ es acción',
    esAccion('When el cliente reenvía el formulario, la API responde 200 sin crear otra orden') === true);
  check('gemelo: "retoma la cola sin reprocesar los ya procesados" SÍ es acción',
    esAccion('Al reiniciar el worker, retoma la cola sin reprocesar los mensajes ya procesados') === true);
  check('gemelo: "SKU existente (upsert) → sin crear un producto nuevo" SÍ es acción',
    esAccion('When el import corre con un SKU existente (upsert) → sin crear un producto nuevo') === true);
  // Más formas de escribir la repetición, que trajo el pase adversarial de la 7.18 (2026-10-09).
  check('gemelo: "llega tres veces … sin crear otra orden" SÍ es acción',
    esAccion('When el webhook llega tres veces, Then responde 200 sin crear otra orden') === true);
  check('gemelo: "ante un retry … sin crear otra orden" SÍ es acción',
    esAccion('Ante un retry del cliente, la API responde 200 sin crear otra orden') === true);
  check('gemelo: "al re-procesar el lote … sin crear registros" SÍ es acción',
    esAccion('Al re-procesar el lote, termina sin crear registros nuevos') === true);
  check('gemelo: "llega el mismo payload … sin guardar otro registro" SÍ es acción',
    esAccion('When llega el mismo payload, Then responde 200 sin guardar otro registro') === true);
  check('gemelo: "la misma request … sin enviar otro mail" SÍ es acción',
    esAccion('When el cliente manda la misma request, Then responde 200 sin enviar otro mail') === true);
  // El «sin» tiene que estar PEGADO al infinitivo: una forma conjugada o un «sin» lejano no neutralizan.
  check('gemelo: "sin" lejano ("un usuario sin permisos intenta editar") no neutraliza',
    esAccion('When un usuario sin permisos intenta editar, Then 403') === true);
  // El límite aceptado por el dueño (2026-10-09, opción A): un criterio cuyo verbo real no está en la lista
  // («arrancar») marcaba sólo por el «sin» + infinitivo, y deja de marcar. Si un día se suman verbos a la
  // lista, este caso cambia a propósito y la medición va aparte.
  check('límite aceptado: "se puede arrancar sin cerrar la anterior" deja de ser acción (el verbo real no está en la lista)',
    esAccion('la siguiente tanda se puede arrancar sin cerrar la anterior') === false);
}

// 33. DODRT-C8 — la EXENCIÓN declarada por AC: `@runtime-exempt(DODRT-C8): <motivo>` (2026-08-25).
//     Tras los fixes de contexto (casos 31 y 32) quedan ~238 falsos positivos medidos en el
//     corpus del equipo que NINGUNA heurística gramatical resuelve: el verbo NOMBRA un endpoint,
//     un botón o un permiso, en un AC que verifica que la acción se BLOQUEA ("los endpoints
//     iniciar / cerrar retornan 403"). Ahí falta contexto que sólo tiene la persona.
//
//     La marca corrige la CLASIFICACIÓN, nunca la verificación: el AC sigue necesitando su
//     evidencia runtime. Por eso es una afirmación distinta de `runtime_not_verifiable:` —y
//     chequeable, y por eso auditable.
{
  // --- (a) el parser, como función pura.
  const P = rm.parseExencionC8;
  check('marca con motivo → válida, y el motivo se recorta',
    P('los endpoints iniciar/cerrar retornan 403 @runtime-exempt(DODRT-C8): "iniciar" es el nombre del endpoint.').valida === true);
  check('el TEXTO devuelto viene SIN la marca ni el motivo',
    /runtime-exempt|nombre del endpoint/.test(
      P('el botón Iniciar retrabajo queda deshabilitado @runtime-exempt(DODRT-C8): es un label de UI').texto) === false);
  check('sin marca → no marcada y el texto queda igual',
    P('el encargado puede asignar una ruta').marcada === false);
  check('marca SIN motivo → marcada pero NO válida',
    P('los endpoints iniciar/cerrar retornan 403 @runtime-exempt(DODRT-C8):').valida === false);
  check('motivo demasiado corto ("n/a") NO alcanza',
    P('retorna 403 @runtime-exempt(DODRT-C8): n/a').valida === false);
  // El motivo NO puede alimentar al clasificador: si lo hiciera, escribir "porque nadie asigna
  // nada" volvería de ACCIÓN a un AC de lectura — la marca se volvería contra su propio dueño.
  check('el motivo no entra al clasificador de verbos',
    rm.acEsDeAccion(P('la vista se muestra en modo lectura @runtime-exempt(DODRT-C8): '
      + 'nadie puede asignar ni crear nada acá').texto) === false);

  // --- (b) end-to-end: el MISMO AC de acción, con y sin la marca.
  const acAccion = '3. Desde un item, el encargado puede asignar una ruta por los caminos que ya existen.';
  const acExento = '3. Los endpoints asignar / cerrar retornan 403 para roles no autorizados. '
    + '@runtime-exempt(DODRT-C8): son los nombres de los endpoints; el AC verifica el rechazo, no la asignación.';

  const conAc = (texto) => {
    const f = makeWorkspace();
    const story = fs.readFileSync(f.storyPath, 'utf8')
      .replace('3. **Given** otra cosa, **Then** otro resultado.', texto);
    fs.writeFileSync(f.storyPath, story);
    // Gate E2E que sólo MIRA (títulos sin @mutates) — cubre los ACs 1 y 3.
    writeGate(f.dodDir, '9.9', recentCompact(20), 'PASS', 'story-9-9.spec.ts', f.gatesLog, true,
      ['flujo: abre la vista y ve el botón @ac-1 @ac-3']);
    return rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
  };

  // gemelo SIN marca: el control sigue bloqueando (si esto se pone verde, la regla murió).
  check('sin marca, el AC de acción sigue bloqueando (RUNTIME-PARCIAL)',
    conAc(acAccion).perAc[3].verdict === 'RUNTIME-PARCIAL', conAc(acAccion).perAc[3].verdict);

  const rEx = conAc(acExento);
  check('con marca válida, el AC queda RUNTIME (no se le pide la escritura)',
    rEx.perAc[3].verdict === 'RUNTIME', rEx.perAc[3].verdict);
  check('la exención queda REGISTRADA en el resultado',
    (rEx.exencionesC8 || []).some((e) => e.ac === 3 && e.valida) && rEx.stats.exentosC8 === 1,
    JSON.stringify(rEx.exencionesC8));
  check('la exención GRITA en warnings, con el motivo',
    rEx.warnings.some((w) => /#3/.test(w) && /@runtime-exempt/.test(w) && /nombres de los endpoints/.test(w)),
    JSON.stringify(rEx.warnings.slice(-2)));
  check('el warning aclara que NO levanta la verificación runtime',
    rEx.warnings.some((w) => /#3/.test(w) && /NO levanta la verificación runtime/.test(w)));
  check('la exención se ve en el artefacto renderizado',
    /⚖️ verbo exento/.test(rm.renderMd(rEx)) && /Verbos exentos de DODRT-C8/.test(rm.renderMd(rEx)));

  // --- (c) marca SIN motivo: no cuenta, y avisa. El opt-out sin constancia es el anti-patrón.
  const rSin = conAc('3. Desde un item, el encargado puede asignar una ruta. @runtime-exempt(DODRT-C8):');
  check('marca sin motivo NO exime: el AC sigue bloqueando',
    rSin.perAc[3].verdict === 'RUNTIME-PARCIAL', rSin.perAc[3].verdict);
  check('marca sin motivo avisa que el motivo es obligatorio',
    rSin.warnings.some((w) => /#3/.test(w) && /SIN motivo/.test(w)));
  check('marca sin motivo NO suma a las exenciones válidas', rSin.stats.exentosC8 === 0);

  // --- (d) tres o más exenciones en una story → grita. Puede ser legítimo, pero es la forma
  //     que tendría el abuso, así que se mira.
  {
    const f = makeWorkspace();
    const marca = (n) => `@runtime-exempt(DODRT-C8): "asignar" es el nombre del endpoint ${n}`;
    const story = fs.readFileSync(f.storyPath, 'utf8')
      .replace('1. **Given** algo, **When** pasa, **Then** resultado.', `1. El endpoint asignar retorna 403. ${marca(1)}`)
      .replace('2. **ERROR_CASE:** input inválido → 422.', `2. El endpoint asignar retorna 422. ${marca(2)}`)
      .replace('3. **Given** otra cosa, **Then** otro resultado.', `3. El endpoint asignar retorna 404. ${marca(3)}`);
    fs.writeFileSync(f.storyPath, story);
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check('3 exenciones en una story → warning fuerte que las lista',
      r.warnings.some((w) => /🔴/.test(w) && /3 ACs exentos/.test(w) && /#1/.test(w) && /#3/.test(w)),
      JSON.stringify(r.warnings.filter((w) => /exent/.test(w))));
  }
  // --- (d2) la marca al FINAL de un AC largo (más de 600 caracteres) cuenta igual. Antes se leía del texto
  //     cortado a 600 y se perdía en silencio: el AC quedaba rojo sin decir por qué (deuda
  //     PIPELINE-ACMATRIX-600-CARACTERES, story 7.6). 🔴 Rojo si la marca vuelve a leerse del texto cortado.
  {
    const relleno = ' El rechazo se ve en la respuesta y en el registro de auditoría, con el rol que lo pidió.'.repeat(9);
    const acLargo = '3. Los endpoints asignar / cerrar retornan 403 para roles no autorizados.' + relleno
      + ' @runtime-exempt(DODRT-C8): son los nombres de los endpoints; el AC verifica el rechazo, no la asignación.';
    check('(d2) el AC de prueba de verdad pasa de 600 caracteres', acLargo.length > 700, String(acLargo.length));
    const rLargo = conAc(acLargo);
    check('(d2) marca al final de un AC largo: cuenta, y el AC queda RUNTIME',
      rLargo.perAc[3].verdict === 'RUNTIME' && rLargo.stats.exentosC8 === 1, `${rLargo.perAc[3].verdict} exentos=${rLargo.stats.exentosC8}`);
    // control: el mismo AC largo SIN marca sigue bloqueando (el relleno no apagó la regla)
    const rLargoSin = conAc(acLargo.replace(/ @runtime-exempt[\s\S]*$/, '').replace('retornan 403', 'permiten asignar una ruta'));
    check('(d2) control: el AC largo de acción SIN marca sigue bloqueando',
      rLargoSin.perAc[3].verdict === 'RUNTIME-PARCIAL', rLargoSin.perAc[3].verdict);
  }
  // --- (e) 🔴 LO QUE LA MARCA NO HACE: un AC exento SIN evidencia de corrida sigue bloqueando.
  //     Es la línea entera del mecanismo — si esto se pone verde, la marca dejó de ser "el verbo
  //     no es una acción" y pasó a ser "no verifiqué", que es justo lo que no puede declarar.
  {
    const f = makeWorkspace();
    const story = fs.readFileSync(f.storyPath, 'utf8')
      .replace('3. **Given** otra cosa, **Then** otro resultado.',
        '3. El endpoint asignar retorna 403 para roles no autorizados. '
        + '@runtime-exempt(DODRT-C8): es el nombre del endpoint, el AC verifica el rechazo.');
    fs.writeFileSync(f.storyPath, story);
    // NINGÚN gate, ningún smoke: el AC no se corrió.
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check('AC exento SIN evidencia runtime sigue bloqueando (la marca no verifica nada)',
      r.perAc[3].verdict !== 'RUNTIME' && r.green === false && (r.pendientes || []).includes(3),
      `${r.perAc[3].verdict} green=${r.green}`);
  }
  // --- (f) El TEXTO de la marca no puede volverse en contra del AC. Una marca INVÁLIDA (motivo
  //     corto) no exime —correcto— pero su motivo tampoco debe entrar al clasificador: un AC de
  //     LECTURA quedaría marcado como de acción por una palabra que escribió el autor de la
  //     marca, no el del criterio. Lo cazó el chequeo de mutantes: sin esto, reemplazar
  //     `ex.texto` por el texto crudo no rompía ningún test.
  {
    const f = makeWorkspace();
    const story = fs.readFileSync(f.storyPath, 'utf8')
      .replace('3. **Given** otra cosa, **Then** otro resultado.',
        '3. La grilla se muestra en modo lectura. @runtime-exempt(DODRT-C8): asigna');
    fs.writeFileSync(f.storyPath, story);
    writeGate(f.dodDir, '9.9', recentCompact(20), 'PASS', 'story-9-9.spec.ts', f.gatesLog, true,
      ['flujo: abre la vista @ac-1 @ac-3']);
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check('el motivo de una marca inválida no convierte en acción a un AC de lectura',
      r.perAc[3].verdict === 'RUNTIME', r.perAc[3].verdict);
    check('…y la marca inválida igual avisa', r.warnings.some((w) => /#3/.test(w) && /SIN motivo/.test(w)));
  }
}

// ---------------------------------------------------------------- story 1.19
// La prueba dice qué esperaba y qué salió. Un humo nuevo (`"v":2`) trae su expectativa (`pass_if`) y la salida
// guardada con su sha256 en el espejo del home. La matriz no lo cuenta si la salida falta o cambió después de correr,
// y muestra la expectativa y la ruta. Las líneas viejas (sin `v`) cuentan como hasta hoy.
{
  const L = require(path.join(__dirname, 'lib', 'smoke-ledger-line.js'));
  // Generado el 2026-10-15 con runtime-matrix.js de main (0000732), ANTES de tocarlo: la salida normalizada del caso T13.
  // Si un cambio a la matriz lo rompe a propósito, se regenera con el código viejo, nunca con el nuevo.
  const DORADO_LINEAS_VIEJAS = "{\"perAc\":{\"1\":{\"verdict\":\"RUNTIME\",\"runtime\":[\"E1 (9.9-e2e-gate-<TSC>.md)\"],\"code\":[],\"text\":\"Given algo, When pasa, Then resultado.\",\"mutacion\":null,\"exentoC8\":null,\"fuentes\":{\"e2e\":[\"9.9-e2e-gate-<TSC>.md\"],\"smoke\":[]}},\"2\":{\"verdict\":\"RUNTIME\",\"runtime\":[\"smoke <TS>\"],\"code\":[],\"text\":\"ERROR_CASE: input inválido → 422.\",\"mutacion\":null,\"exentoC8\":null,\"fuentes\":{\"e2e\":[],\"smoke\":[\"<TS>\"]}},\"3\":{\"verdict\":\"RUNTIME\",\"runtime\":[\"E1 (9.9-e2e-gate-<TSC>.md)\",\"smoke <TS>\"],\"code\":[],\"text\":\"Given otra cosa, Then otro resultado.\",\"mutacion\":null,\"exentoC8\":null,\"fuentes\":{\"e2e\":[\"9.9-e2e-gate-<TSC>.md\"],\"smoke\":[\"<TS>\"]}}},\"green\":true,\"pendientes\":[],\"warnings\":[],\"md\":\"# Matriz de verificación runtime — Story 9.9 (DODRT-C6)\\n\\n**Generado**: <TS> · **matrix_hash**: `<HASH>` · **veredicto**: 🟢 VERDE\\n**Cobertura**: 3/3 ACs corridos en runtime · 0 sin correr (bloquean) · 0 imposibles-declarados (esperan waiver)\\n\\n| AC | Veredicto | Evidencia runtime | Evidencia código | Razón (si imposible) |\\n|---|---|---|---|---|\\n| #1 | 🟢 RUNTIME | E1 (9.9-e2e-gate-<TSC>.md) | — | — |\\n| #2 | 🟢 RUNTIME | smoke <TS> | — | — |\\n| #3 | 🟢 RUNTIME | E1 (9.9-e2e-gate-<TSC>.md); smoke <TS> | — | — |\\n\\n\"}";

  // Lo que la matriz devuelve, sin lo que cambia de una corrida a otra (carpeta temporal, sellos, hash).
  function normalizado(r, f) {
    const s = JSON.stringify({ perAc: r.perAc, green: r.green, pendientes: r.pendientes, warnings: r.warnings,
      md: rm.renderMd(r) });
    return [fs.realpathSync(f.ws), f.ws].reduce((acc, p) => acc.split(p).join('<WS>'), s)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TS>')
      .replace(/\d{8}T\d{6}Z/g, '<TSC>')
      .replace(/\d{4}-\d{2}-\d{2}/g, '<FECHA>')
      .replace(/\b[0-9a-f]{12}\b/g, '<HASH>');
  }

  // T13 — Matrix_OldLines_CountAsToday (AC 20, 21, 24): un registro sin `v`, con y sin `--mutates`, y un AC con E2E,
  // dan EXACTAMENTE lo mismo que con el código anterior a la 1.19. El dorado se generó con ese código (Task 2).
  {
    const f = makeWorkspace();
    writeGate(f.dodDir, '9.9', recentCompact(20), 'PASS', 'story-9-9.spec.ts', f.gatesLog, true,
      ['flujo: abre la vista @ac-1']);
    L.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [2], cmd: 'curl -s http://app/x' });
    L.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [3], cmd: 'node .advisors/smoke-e2e.mjs', mutates: true });
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    const got = normalizado(r, f);
    check('T13 líneas viejas: la matriz da lo mismo que antes de la 1.19', got === DORADO_LINEAS_VIEJAS,
      `\n    esperado: ${DORADO_LINEAS_VIEJAS}\n    salió:    ${got}`);
  }

  // T11 — Matrix_V2_MissingOrChangedOutput_NotCounted (AC 7).
  {
    const f = makeWorkspace();
    const w = L.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [2],
      v2: { pasaSi: 'responde 422 con el campo inválido nombrado', outputText: 'HTTP/1.1 422\n{"campo":"x"}\n' } });
    fs.rmSync(path.join(f.dodDir, w.output));
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check('T11 v2 con la salida borrada no cuenta', r.perAc[2].verdict !== 'RUNTIME', r.perAc[2].verdict);
    check('T11 …y la nombra «salida ausente»', r.warnings.some((w2) => /salida ausente/.test(w2)), JSON.stringify(r.warnings));
  }
  {
    const f = makeWorkspace();
    const w = L.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [2],
      v2: { pasaSi: 'responde 422 con el campo inválido nombrado', outputText: 'HTTP/1.1 500\n' } });
    fs.writeFileSync(path.join(f.dodDir, w.output), 'HTTP/1.1 422\n{"campo":"x"}\n');
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check('T11 v2 con la salida editada no cuenta', r.perAc[2].verdict !== 'RUNTIME', r.perAc[2].verdict);
    check('T11 …y la nombra «salida cambiada después de correr»',
      r.warnings.some((w2) => /salida cambiada después de correr/.test(w2)), JSON.stringify(r.warnings));
  }
  {
    // La marca de versión se borró del registro, pero el espejo la trae: sigue siendo `v:2` y sin salida no cuenta.
    const f = makeWorkspace();
    const w = L.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [2],
      v2: { pasaSi: 'responde 422', outputText: 'HTTP/1.1 422\n' } });
    const reg = path.join(f.dodDir, '9.9-smoke-ledger.jsonl');
    const e = JSON.parse(fs.readFileSync(reg, 'utf8'));
    delete e.v; delete e.output; delete e.output_sha; delete e.pass_if;
    fs.writeFileSync(reg, JSON.stringify(e) + '\n');
    fs.rmSync(path.join(f.dodDir, w.output));
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check('T11 borrar el `v` del registro no la vuelve vieja (lo dice el espejo)', r.perAc[2].verdict !== 'RUNTIME', r.perAc[2].verdict);
  }
  {
    // La expectativa editada después de correr tampoco cuenta: su sha está en el espejo.
    const f = makeWorkspace();
    L.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [2],
      v2: { pasaSi: 'responde 500', outputText: 'HTTP/1.1 500\n' } });
    const reg = path.join(f.dodDir, '9.9-smoke-ledger.jsonl');
    fs.writeFileSync(reg, fs.readFileSync(reg, 'utf8').replace('responde 500', 'responde 422'));
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check('T11 v2 con la expectativa editada no cuenta', r.perAc[2].verdict !== 'RUNTIME', r.perAc[2].verdict);
    check('T11 …y la nombra «expectativa cambiada después de correr»',
      r.warnings.some((w2) => /expectativa cambiada después de correr/.test(w2)), JSON.stringify(r.warnings));
  }

  // T12 — Matrix_ShowsPasaSiAndOutput (AC 4).
  {
    const f = makeWorkspace();
    const w = L.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [2],
      v2: { pasaSi: 'responde 422 con el campo inválido nombrado', outputText: 'HTTP/1.1 422\n{"campo":"x"}\n' } });
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check('T12 v2 con su salida intacta cuenta', r.perAc[2].verdict === 'RUNTIME', r.perAc[2].verdict);
    const md = rm.renderMd(r);
    check('T12 el .md muestra el pass_if del AC', md.includes('responde 422 con el campo inválido nombrado'), md);
    check('T12 el .md muestra la ruta de la salida', md.includes(w.output), md);
  }

  // T9 (la parte de la matriz) — dos humos v2 de la misma story en el mismo segundo: cuentan los dos.
  {
    const f = makeWorkspace();
    const ts = L.nowTs();
    L.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [2], ts, v2: { pasaSi: 'uno', outputText: 'uno\n' } });
    L.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [2], ts, v2: { pasaSi: 'dos', outputText: 'dos\n' } });
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check('T9 dos humos v2 del mismo segundo cuentan los dos', r.perAc[2].fuentes.smoke.length === 2,
      JSON.stringify(r.perAc[2].fuentes));
    check('T9 …y ninguno da «salida cambiada»', !r.warnings.some((w2) => /cambiada/.test(w2)), JSON.stringify(r.warnings));
  }

  // T18 — Matrix_AckInFrontmatter_StillNotVerified (AC 25): el ack viejo, escrito en el frontmatter, no abre nada.
  {
    const f0 = makeWorkspace();
    const hash = rm.compute({ storyPath: f0.storyPath, gatesLogPath: f0.gatesLog }).hash;
    const f = makeWorkspace({ ack: ['runtime_verification_ack:', `  matrix_hash: ${hash}`, '  manual_acs: [1, 2, 3]',
      '  approved_by: "DevA"', '  date: 2026-07-10'] });
    fs.writeFileSync(path.join(f.dodDir, '9.9-manual-test-plan.md'), '# Plan\n- AC 1\n- AC 2\n- AC 3\n');
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check('T18 runtime_verification_ack en el frontmatter no deja verde a la matriz',
      r.green === false && [1, 2, 3].every((n) => (r.pendientes || []).includes(n)),
      `green=${r.green} pendientes=${JSON.stringify(r.pendientes)}`);
  }

  // ── Lo que encontró la revisión de la 1.19 (pase adversarial y revisor de cobertura, 2026-10-15) ──
  // Git reescribe los finales de línea de la salida al hacer checkout (autocrlf en Windows, `eol=lf` en el arnés): un
  // humo legítimo no puede pasar por evidencia editada.
  {
    const f = makeWorkspace();
    const w = L.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [2],
      v2: { pasaSi: 'responde 422', outputText: 'HTTP/1.1 422\n{"campo":"x"}\n' } });
    fs.writeFileSync(path.join(f.dodDir, w.output), 'HTTP/1.1 422\r\n{"campo":"x"}\r\n');
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check('una salida con sus finales de línea reescritos por git sigue contando', r.perAc[2].verdict === 'RUNTIME',
      `${r.perAc[2].verdict} ${JSON.stringify(r.warnings)}`);
  }
  // Una ruta de salida absoluta o con `..` no se sigue: no cuenta, aunque el archivo exista y su sha coincida.
  for (const ruta of ['ABS', '../afuera.txt']) {
    const f = makeWorkspace();
    const texto = 'HTTP/1.1 422\n';
    const afuera = path.join(f.ws, 'afuera.txt');
    fs.writeFileSync(afuera, texto);
    L.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [2],
      v2: { pasaSi: 'responde 422', output: ruta === 'ABS' ? afuera : ruta, outputSha: L.sha256(texto) } });
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check(`una salida con ruta ${ruta === 'ABS' ? 'absoluta' : 'con ..'} no cuenta`,
      r.perAc[2].verdict !== 'RUNTIME' && r.warnings.some((x) => /salida ausente/.test(x)), r.perAc[2].verdict);
  }
  // `--fail-if` editado después de correr: mismo sello que la expectativa.
  {
    const f = makeWorkspace();
    L.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [2],
      v2: { pasaSi: 'responde 422', fallaSi: 'cualquier 5xx', outputText: 'HTTP/1.1 422\n' } });
    const reg = path.join(f.dodDir, '9.9-smoke-ledger.jsonl');
    fs.writeFileSync(reg, fs.readFileSync(reg, 'utf8').replace('cualquier 5xx', 'nada'));
    const r = rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog });
    check('fail_if editado después de correr no cuenta',
      r.perAc[2].verdict !== 'RUNTIME' && r.warnings.some((x) => /expectativa cambiada después de correr/.test(x)),
      r.perAc[2].verdict);
  }
  // La CLI del ayudante de pruebas sale con 2 ante un pedido mal armado, sin escribir nada.
  {
    const { spawnSync } = require('child_process');
    const cli = path.join(__dirname, 'lib', 'smoke-ledger-line.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmx-cli-'));
    const casos = [['--story', '9.9'], ['--dod', dir, '--story', '9.9', '--bogus'], ['--dod', dir, '--story']];
    const rcs = casos.map((a) => spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8' }).status);
    check('la CLI del ayudante sale 2 sin --dod, con una opción desconocida o sin valor',
      rcs.every((x) => x === 2) && fs.readdirSync(dir).length === 0, JSON.stringify(rcs));
  }
}

console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} caso(s) fallando`);
  process.exit(1);
}
console.log('✓ runtime-matrix — todos los casos verdes');
