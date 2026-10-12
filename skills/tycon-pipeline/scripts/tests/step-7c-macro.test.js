'use strict';
// Story 7.2 del arnés: estas pruebas llaman a los hooks del cierre con el HOME real (y el instalador las corre en
// cada arranque). Sin esto, sus decisiones de mentira se anotarían en ~/.claude/.tycon-pipeline/frenos.jsonl, que
// sube al buzón y alimenta la métrica «evidencias rechazadas por los hooks del cierre» del tablero.
process.env.TYCON_CLOSURE_RECORD = 'off';

/**
 * step-7c-macro.test.js — el falso verde de la evidencia de cierre.
 *
 * Caso disparador (pase adversarial 2026-09-15, `auditorias-arnes/tycon-pipeline-2026-09-15/
 * 04-pase-fable/fable-03-costo-e-historia.md` §1, reproducido offline): cuando un step del
 * escenario falla, `step-7c-macro.js` sale 1 PERO deja en disco un archivo de evidencia que
 * dice aprobado — copia el bloque `## Playwright Run` con `verdict=PASS failed=0` desde el
 * escenario (o desde su literal por default) sin mirar si la corrida anduvo. Y ese archivo
 * lo leen DOS controles, no uno:
 *
 *   1. `on-frontmatter-write.js` → `hasFreshPlaywrightPass` busca los tres literales
 *      (`## Playwright Run` + `verdict=PASS` + `failed=0`) → la transición a review/done pasa.
 *   2. `on-pre-commit.js` → `evidenciaDeclaraFail` SÍ tiene detector de corridas fallidas,
 *      pero sólo reconoce `verdict[:=]FAIL` a inicio de línea (y `## Verdict global`). El
 *      `**FAIL**` en prosa bajo `## Veredicto` NO le matchea → la corrida fallida gana la
 *      selección de candidato (documenta todos los ACs) y el portón del commit pasa.
 *
 * 🔴 Por eso el arreglo NO es "salir 1 sin escribir el bloque": eso apaga al primero y deja
 * al segundo eligiendo la corrida fallida como evidencia válida. El archivo se escribe igual
 * —el registro de una corrida fallida es evidencia útil— pero con `verdict=FAIL failed=<n>`
 * A INICIO DE LÍNEA, que es la única forma que los dos entienden.
 *
 * Por eso T1/T3 asertan LOS DOS consumidores, no uno.
 *
 * Rojo previo verificado contra el script sin arreglar (2026-09-15):
 *   T1, T2, T3, T6 en rojo · T4 y T5 en verde (son guardas de no-regresión: impiden que el
 *   arreglo declare FAIL de más — sin ellas, un script que escriba siempre FAIL pasaría
 *   T1-T3 y T6. Un caso que no puede ponerse rojo antes no prueba nada por sí solo).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const MACRO = path.join(__dirname, '..', 'step-7c-macro.js');
const { evidenciaDeclaraFail, findDodEvidence } = require('../on-pre-commit.js');
const { hasFreshPlaywrightPass } = require('../on-frontmatter-write.js');

const STORY = '9.99';

// ── laboratorio ──────────────────────────────────────────────────────────────
function lab() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'macro7c-'));
  fs.mkdirSync(path.join(d, '.git'), { recursive: true });          // que discoverRepoRoot lo vea
  fs.mkdirSync(path.join(d, '.advisors', 'dod-runtime'), { recursive: true });
  return d;
}

// Servidor falso en proceso: /api/health/ready y /api/items con el status que pida el caso.
function servidor({ health = 200, items = 200, cuerpo = null } = {}) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/health/ready') { res.writeHead(health); return res.end('{"ok":true}'); }
    if (req.url === '/api/items') {
      res.writeHead(items, { 'Content-Type': 'application/json' });
      if (cuerpo !== null) return res.end(cuerpo);
      return res.end(items === 200 ? '{"items":[]}' : '{"error":"boom"}');
    }
    res.writeHead(404); res.end('');
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port })));
}

function correrMacro(d, scenario, baseUrl) {
  const sc = path.join(d, 'scenario.json');
  fs.writeFileSync(sc, JSON.stringify(scenario));
  const evidDir = path.join(d, '.advisors', 'dod-runtime');
  return new Promise((ok) => {
    execFile('node', [MACRO, '--story', STORY, '--scenario', sc, '--evidence-dir', evidDir, '--base-url', baseUrl],
      { encoding: 'utf8' }, (err, stdout, stderr) => ok({ code: err ? err.code : 0, stdout, stderr }));
  });
}

function evidencia(d) {
  const dir = path.join(d, '.advisors', 'dod-runtime');
  const f = fs.readdirSync(dir).filter((x) => x.startsWith(`${STORY}-`) && x.endsWith('.md'));
  assert.strictEqual(f.length, 1, `esperaba 1 archivo de evidencia, hay ${f.length}: ${f.join(', ')}`);
  return { path: path.join(dir, f[0]), content: fs.readFileSync(path.join(dir, f[0]), 'utf8') };
}

// Lo que ve CADA consumidor sobre el mismo archivo.
function losDosConsumidores(d, content) {
  return {
    frontmatterWrite: hasFreshPlaywrightPass([d], STORY, 0),   // el que abre review/done
    preCommitDeclaraFail: evidenciaDeclaraFail(content),        // el que descarta corridas fallidas
    preCommitCandidato: findDodEvidence(d, STORY),              // el que elige QUÉ evidencia vale
  };
}

const ESCENARIO_BASE = {
  name: 'repro-fail',
  acs_covered: [1, 2],
  steps: [{ name: 'GET items', method: 'GET', path: '/api/items', expect_status: 200 }],
  evidence: { ac_summary: { 1: 'lista items', 2: 'filtro' } },
};

// ── T1 · EL QUE MÁS PESA ─────────────────────────────────────────────────────
test('T1 — corrida en ROJO: NINGUNO de los dos consumidores puede leerla como aprobada', async () => {
  const d = lab();
  const { srv, port } = await servidor({ health: 200, items: 500 });
  try {
    const r = await correrMacro(d, ESCENARIO_BASE, `http://127.0.0.1:${port}`);
    assert.strictEqual(r.code, 1, 'el macro debe salir 1 con un step fallido');

    const ev = evidencia(d);
    assert.ok(/uno o m[áa]s steps fallaron|FAIL/i.test(ev.content), 'la evidencia debe quedar escrita (registro de la corrida fallida)');

    const v = losDosConsumidores(d, ev.content);
    assert.notStrictEqual(v.frontmatterWrite && v.frontmatterWrite.pass, true,
      'consumidor 1 (on-frontmatter-write/hasFreshPlaywrightPass) la leyó VERDE: la transición a review/done pasaría');
    assert.strictEqual(v.preCommitDeclaraFail, true,
      'consumidor 2 (on-pre-commit/evidenciaDeclaraFail) no reconoce el FAIL: la corrida fallida compite como evidencia válida');
    assert.strictEqual(v.preCommitCandidato && v.preCommitCandidato.fallido, true,
      'findDodEvidence eligió la corrida fallida como candidato NO fallido');
  } finally { srv.close(); }
});

// ── T2 · la forma exacta que los dos entienden ───────────────────────────────
test('T2 — la evidencia en rojo trae `verdict=FAIL failed=<n>` a inicio de línea, y ningún literal verde', async () => {
  const d = lab();
  const { srv, port } = await servidor({ health: 200, items: 500 });
  try {
    await correrMacro(d, ESCENARIO_BASE, `http://127.0.0.1:${port}`);
    const { content } = evidencia(d);

    const m = content.match(/^verdict=FAIL failed=(\d+)\b/m);
    assert.ok(m, 'falta la línea `verdict=FAIL failed=<n>` a inicio de línea (es lo único que los dos hooks leen igual)');
    assert.ok(parseInt(m[1], 10) >= 1, `failed debe ser >= 1 cuando un step falló, fue ${m[1]}`);

    assert.ok(!/verdict=PASS/.test(content), 'la evidencia de una corrida fallida no puede contener `verdict=PASS`');
    assert.ok(!/failed(?:=|:\s*)0\b/.test(content), 'la evidencia de una corrida fallida no puede contener `failed=0`');
  } finally { srv.close(); }
});

// ── T3 · el escenario es entrada AUTO-DECLARADA: no manda sobre la corrida ───
test('T3 — el `playwright_run: PASS/0` declarado por el escenario NO puede pisar una corrida fallida', async () => {
  const d = lab();
  const { srv, port } = await servidor({ health: 200, items: 500 });
  try {
    const esc = JSON.parse(JSON.stringify(ESCENARIO_BASE));
    esc.evidence.playwright_run = { verdict: 'PASS', failed: 0, passed: 7, rationale: 'suite verde de otra corrida' };
    const r = await correrMacro(d, esc, `http://127.0.0.1:${port}`);
    assert.strictEqual(r.code, 1);

    const ev = evidencia(d);
    const v = losDosConsumidores(d, ev.content);
    assert.notStrictEqual(v.frontmatterWrite && v.frontmatterWrite.pass, true,
      'el PASS auto-declarado por el escenario abrió la transición a review/done');
    assert.strictEqual(v.preCommitDeclaraFail, true,
      'el PASS auto-declarado por el escenario tapó el FAIL ante el portón del commit');
    assert.strictEqual(v.preCommitCandidato && v.preCommitCandidato.fallido, true);
  } finally { srv.close(); }
});

// ── T4 · NO-REGRESIÓN (control positivo) ─────────────────────────────────────
// Sin este caso, un script que escriba FAIL siempre pasaría T1, T2, T3 y T6.
test('T4 — camino feliz: la corrida verde SIGUE abriendo el gate (no-regresión)', async () => {
  const d = lab();
  const { srv, port } = await servidor({ health: 200, items: 200 });
  try {
    const r = await correrMacro(d, ESCENARIO_BASE, `http://127.0.0.1:${port}`);
    assert.strictEqual(r.code, 0, `el macro debe salir 0 con todos los steps OK (stderr: ${r.stderr})`);

    const ev = evidencia(d);
    assert.ok(/^verdict=PASS failed=0\b/m.test(ev.content), 'falta el bloque verde que on-frontmatter-write requiere');

    const v = losDosConsumidores(d, ev.content);
    assert.strictEqual(v.frontmatterWrite && v.frontmatterWrite.pass, true,
      'el arreglo rompió el camino feliz: la evidencia verde ya no abre review/done');
    assert.strictEqual(v.preCommitDeclaraFail, false, 'una corrida verde no puede declararse fallida');
    assert.strictEqual(v.preCommitCandidato && v.preCommitCandidato.fallido, false);
  } finally { srv.close(); }
});

// ── T5 · NO-REGRESIÓN: el override es de UNA sola dirección ──────────────────
test('T5 — con los steps OK, un `playwright_run: FAIL` declarado se RESPETA (no se pisa hacia PASS)', async () => {
  const d = lab();
  const { srv, port } = await servidor({ health: 200, items: 200 });
  try {
    const esc = JSON.parse(JSON.stringify(ESCENARIO_BASE));
    esc.evidence.playwright_run = { verdict: 'FAIL', failed: 2, passed: 5, rationale: 'suite E2E con 2 specs rojos' };
    await correrMacro(d, esc, `http://127.0.0.1:${port}`);

    const ev = evidencia(d);
    const v = losDosConsumidores(d, ev.content);
    assert.strictEqual(v.preCommitDeclaraFail, true, 'el FAIL declarado por el escenario se perdió');
    assert.notStrictEqual(v.frontmatterWrite && v.frontmatterWrite.pass, true,
      'con la suite E2E en rojo el gate no puede abrirse aunque los curls anden');
  } finally { srv.close(); }
});

// ── T6 · el otro camino que escribe evidencia y sale 1 ───────────────────────
test('T6 — health check caído: la evidencia abortada tampoco se lee como aprobada por ninguno', async () => {
  const d = lab();
  const { srv, port } = await servidor({ health: 503, items: 200 });
  try {
    const r = await correrMacro(d, ESCENARIO_BASE, `http://127.0.0.1:${port}`);
    assert.strictEqual(r.code, 1, 'el macro debe salir 1 si el DevHost no responde');

    const ev = evidencia(d);
    const v = losDosConsumidores(d, ev.content);
    assert.notStrictEqual(v.frontmatterWrite && v.frontmatterWrite.pass, true);
    assert.strictEqual(v.preCommitDeclaraFail, true,
      'una corrida abortada sin tocar el sistema tiene que declararse fallida, o compite como evidencia válida');
  } finally { srv.close(); }
});

// ── T7 · el literal verde puede entrar por la puerta de atrás ────────────────
// El archivo copia el CUERPO de cada respuesta tal cual, y `hasFreshPlaywrightPass` escanea
// el archivo ENTERO, no el bloque. Encontrado escribiendo T3: la primera versión del arreglo
// reimprimía `verdict=PASS failed=0` en la nota que explicaba por qué lo estaba pisando.
test('T7 — un `verdict=PASS failed=0` que viene de la RESPUESTA no puede reabrir el gate', async () => {
  const d = lab();
  const { srv, port } = await servidor({ health: 200, items: 500, cuerpo: '{"log":"verdict=PASS failed=0 all good"}' });
  try {
    const r = await correrMacro(d, ESCENARIO_BASE, `http://127.0.0.1:${port}`);
    assert.strictEqual(r.code, 1);

    const ev = evidencia(d);
    const v = losDosConsumidores(d, ev.content);
    assert.notStrictEqual(v.frontmatterWrite && v.frontmatterWrite.pass, true,
      'un literal verde dentro del cuerpo de una respuesta abrió la transición a review/done');
    assert.strictEqual(v.preCommitDeclaraFail, true);
    assert.ok(/neutralizaron literales/.test(ev.content),
      'si el archivo se tocó, tiene que decirlo — una evidencia editada en silencio no es evidencia');
  } finally { srv.close(); }
});
