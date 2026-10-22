#!/usr/bin/env node
/**
 * step-7c-macro.js — DoD Runtime Gate ceremony as a deterministic macro.
 *
 * Reemplaza la secuencia manual del paso «Probar en vivo»: health check,
 * ejecutar secuencia de curls (setup + act + verify), capturar response fields,
 * assertear status + body, escribir evidence file en formato hook-compliant
 * (incluye bloque "## Playwright Run" con substrings literales `verdict=PASS`
 * + `failed=0` que `on-frontmatter-write.js` requiere) — SÓLO si la corrida anduvo.
 *
 * 🔴 FALSO VERDE EN LA EVIDENCIA DE CIERRE. Con un step en rojo el script sale 1, pero si dejara en
 * disco un archivo que dice aprobado (copiando el `verdict=PASS failed=0` del escenario, o su literal por
 * default, sin mirar el resultado), ese archivo lo leen DOS controles, no uno:
 *   1. `on-frontmatter-write.js` → `hasFreshPlaywrightPass` (los tres literales) → abriría la
 *      transición a review/done;
 *   2. `on-pre-commit.js` → `evidenciaDeclaraFail` SÍ descarta corridas fallidas, pero sólo
 *      reconoce `verdict[:=]FAIL` a INICIO DE LÍNEA (y `## Verdict global`): el `**FAIL**` en
 *      prosa bajo `## Veredicto` no le matchea, y como el archivo documenta todos los ACs
 *      ganaría la selección de candidato → el portón del commit también pasaría.
 * Por eso la solución no es "salir 1 sin escribir el bloque" (eso tapa al primero y deja al
 * segundo engañado): el archivo se escribe igual —el registro de una corrida fallida es
 * evidencia útil— pero con `verdict=FAIL failed=<n>` a inicio de línea, la única forma que
 * los dos entienden. El `evidence.playwright_run` del escenario es entrada AUTO-DECLARADA
 * (la escribe el modelo): con la corrida en rojo se PISA. Al revés no: con los steps en verde
 * un `playwright_run: FAIL` declarado se respeta — el override va en una sola dirección.
 * Casos: `scripts/tests/step-7c-macro.test.js`.
 *
 * Hacerlo paso a paso le exige al orquestador recordar el formato exacto del evidence y manejar el
 * path correcto (un `.advisors` ignorado por git en el repo de código vs uno versionado en el repo de la story).
 *
 * Usage:
 *   node step-7c-macro.js --story <número> --scenario <path>.json \
 *     [--evidence-dir <dir>] [--base-url http://localhost:5001] \
 *     [--bearer-token admin] [--dry-run]
 *
 * Scenario JSON schema: ver scenarios/example-scan-reception.json.
 *
 * Exit codes:
 *   0 = todos los steps PASS, evidence file escrito
 *   1 = scenario inválido / health check falla / assertion falla
 *   2 = CLI args inválidos
 */

const fs = require('fs');
const path = require('path');

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    story: null,
    scenario: null,
    evidenceDir: null,
    baseUrl: 'http://localhost:5001',
    bearer: 'admin',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--story') a.story = argv[++i];
    else if (t === '--scenario') a.scenario = argv[++i];
    else if (t === '--evidence-dir') a.evidenceDir = argv[++i];
    else if (t === '--base-url') a.baseUrl = argv[++i];
    else if (t === '--bearer-token') a.bearer = argv[++i];
    else if (t === '--dry-run') a.dryRun = true;
  }
  return a;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function evidenceDirDelMarker() {
  try {
    const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'marker.js'), 'get'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const m = JSON.parse(out || '{}');
    return m && typeof m.evidenceDir === 'string' && m.evidenceDir ? m.evidenceDir : null;
  } catch { return null; }
}

// Soporta $.field, $.field.sub, $.arr[0], $.arr[0].sub. Devuelve undefined si no resuelve.
function jsonPathGet(obj, expr) {
  if (typeof expr !== 'string' || !expr.startsWith('$.')) {
    throw new Error(`Invalid JSON path: ${expr}`);
  }
  const parts = expr.slice(2).split(/[.[\]]+/).filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = /^\d+$/.test(p) ? cur[parseInt(p, 10)] : cur[p];
  }
  return cur;
}

// Reemplaza {varName} en strings recursivamente (body, path, etc).
function substituteVars(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
  }
  if (Array.isArray(value)) return value.map((v) => substituteVars(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteVars(v, vars);
    return out;
  }
  return value;
}

// Asserts deep — para cada leaf path en `expected`, compara con `actual`.
function assertBody(actual, expected) {
  const failures = [];
  function walk(exp, act, prefix) {
    if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
      for (const [k, v] of Object.entries(exp)) {
        walk(v, act ? act[k] : undefined, prefix ? `${prefix}.${k}` : k);
      }
    } else {
      if (JSON.stringify(exp) !== JSON.stringify(act)) {
        failures.push(`  [FAIL] body.${prefix}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(act)}`);
      }
    }
  }
  walk(expected, actual, '');
  return failures;
}

// 🔴 La línea que los DOS consumidores leen igual: `verdict=FAIL` a inicio de línea.
// `on-frontmatter-write.js` deja de matchear (no hay `verdict=PASS` ni `failed=0` en el archivo)
// y `on-pre-commit.js:evidenciaDeclaraFail` pasa a true (la corrida fallida no compite como
// evidencia válida). Se emite SÓLO para declarar fallo — nunca una línea análoga en verde:
// un `verdict=PASS failed=0` de más abriría el gate incluso con la suite E2E declarada en rojo.
// 🔴 Invariante mecánico: un archivo que declara FAIL no puede contener los
// literales verdes, VENGAN DE DONDE VENGAN. `on-frontmatter-write.js` escanea el archivo
// ENTERO, no el bloque: alcanza con que el CUERPO de una respuesta del sistema bajo prueba
// —que se copia tal cual más arriba— o el nombre de un step traigan `verdict=PASS`/`failed=0`
// para reabrir el gate. No se borra nada: se deja legible entre comillas angulares y con
// constancia de que se tocó. Una nota de override que reimprimiera los literales que acaba de pisar
// los reintroduciría (caso T3 de la suite).
function escribirEvidencia(evidencePath, log, fallo) {
  const neutralizar = (t) => t
    .replace(/verdict=PASS/g, 'verdict«PASS»')
    .replace(/failed(?:=|:\s*)0\b/g, 'failed«0»');
  let texto = log.join('\n');
  if (fallo) {
    const limpio = neutralizar(texto);
    // 🔴 La constancia NO nombra los literales que acaba de neutralizar —nombrarlos es
    // reintroducirlos— y el barrido se aplica ÚLTIMO, sobre el texto ya completo: ni la propia
    // nota puede reabrir el gate (la nota de override y esta constancia son los dos lugares donde pasaría).
    texto = limpio === texto ? limpio : neutralizar(
      `${limpio}\n> ⚠ Se neutralizaron literales de veredicto VERDE que venían del escenario o de una\n` +
      '> respuesta: esta corrida FALLÓ y el hook de cierre escanea el archivo entero.\n');
  }
  fs.writeFileSync(evidencePath, texto, 'utf8');
}

function lineaVeredictoFail(fallidos, pasados) {
  // `failed` nunca puede ser 0 acá: sería el literal que el hook lee como verde.
  const n = Math.max(1, fallidos | 0);
  return `verdict=FAIL failed=${n} passed=${pasados | 0} skipped=0`;
}

// ── step execution ───────────────────────────────────────────────────────────
async function executeStep(step, vars, baseUrl, bearer, log) {
  const method = step.method || 'GET';
  const pathStr = substituteVars(step.path, vars);
  const url = baseUrl + pathStr;
  const body = step.body ? substituteVars(step.body, vars) : null;

  log.push(`### Step: ${step.name || `${method} ${pathStr}`}`);
  log.push('');
  log.push('```bash');
  log.push(`curl -X ${method} "${url}" \\`);
  log.push(`  -H "Authorization: Bearer ${bearer}" \\`);
  log.push(`  -H "Content-Type: application/json"${body ? ' \\' : ''}`);
  if (body) log.push(`  -d '${JSON.stringify(body)}'`);
  log.push('```');
  log.push('');

  let res, text, parsed = null;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  } catch (err) {
    log.push(`**NETWORK ERROR**: ${err.message}`);
    log.push('');
    return { ok: false, failures: [`network: ${err.message}`] };
  }

  log.push(`Response: \`HTTP ${res.status}\``);
  log.push('');
  if (text) {
    log.push('```json');
    log.push(text.length > 2000 ? text.slice(0, 2000) + '...(truncated)' : text);
    log.push('```');
    log.push('');
  }

  const failures = [];
  if (step.expect_status != null && res.status !== step.expect_status) {
    failures.push(`  [FAIL] expect_status=${step.expect_status}, got HTTP ${res.status}`);
  }
  if (step.assert_body && parsed) {
    failures.push(...assertBody(parsed, step.assert_body));
  }
  if (failures.length > 0) {
    log.push('**Assertions FAILED:**');
    failures.forEach((f) => log.push(f));
    log.push('');
    return { ok: false, failures };
  }
  if (step.expect_status != null) log.push(`✓ expect_status=${step.expect_status}`);
  if (step.assert_body) log.push('✓ assert_body match');
  log.push('');

  // Capture vars from response
  if (step.capture && parsed) {
    for (const [varName, jsonPath] of Object.entries(step.capture)) {
      try {
        const val = jsonPathGet(parsed, jsonPath);
        if (val == null) {
          log.push(`⚠ capture.${varName}: ${jsonPath} returned undefined`);
        } else {
          vars[varName] = val;
          log.push(`Captured: \`${varName}=${JSON.stringify(val)}\``);
        }
      } catch (err) {
        log.push(`⚠ capture.${varName}: invalid path '${jsonPath}' (${err.message})`);
      }
    }
    log.push('');
  }

  return { ok: true, response: parsed };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.story || !args.scenario) {
    process.stderr.write(
      'step-7c-macro.js — DoD Runtime Gate ceremony (SPEED-3)\n\n' +
      'Usage:\n' +
      '  node step-7c-macro.js --story <ruta-de-la-story.md | id> --scenario <path>.json \\\n' +
      '    [--evidence-dir <dir>] [--base-url http://localhost:5001] \\\n' +
      '    [--bearer-token admin] [--dry-run]\n\n' +
      'Scenario schema: ver scenarios/example-scan-reception.json\n',
    );
    process.exit(2);
  }
  if (!fs.existsSync(args.scenario)) {
    process.stderr.write(`scenario file not found: ${args.scenario}\n`);
    process.exit(2);
  }

  let scenario;
  try {
    scenario = JSON.parse(fs.readFileSync(args.scenario, 'utf8'));
  } catch (err) {
    process.stderr.write(`scenario JSON parse error: ${err.message}\n`);
    process.exit(2);
  }

  // Sin --evidence-dir: el destino que `pipeline.js start` dejó en el marker (el repo de la STORY)
  // y recién después el cwd — que es el repo del código, no el de la story.
  const evidenceDir = args.evidenceDir || evidenceDirDelMarker() || path.join(process.cwd(), '.advisors', 'dod-runtime');
  const ts = new Date();
  const tsStr = ts.toISOString().replace(/[-:.TZ]/g, '').slice(0, 12) + 'Z';
  // La CLAVE de la evidencia: con la ruta de la story, el número solo si es único en su repo o
  // `<tema>__<número>` si se repite. Con un número a mano se usa tal cual (en un número repetido el
  // resultado queda huérfano: la matriz lo nombra y no lo cuenta). Si la clave no se puede decidir, no se
  // escribe nada: una evidencia bajo una clave adivinada puede terminar contándole a otra story.
  let evidenceKey = args.story;
  if (/\.md$/i.test(args.story) && !fs.existsSync(args.story)) {
    process.stderr.write(`no encontré la story ${args.story} — una ruta mal escrita no puede nombrar evidencia\n`);
    process.exit(2);
  }
  if (/\.md$/i.test(args.story)) {
    try { evidenceKey = require(path.join(__dirname, 'lib', 'evidence-key.js')).evidenceKey(args.story).key; } catch (err) {
      process.stderr.write(`no pude calcular la clave de la evidencia de ${args.story}: ${err.message}\n`);
      process.exit(2);
    }
  }
  // La clave nombra un archivo: sólo letras, números y `. _ + ~ -`, sin `..` (una barra la escribiría afuera).
  if (!/^[A-Za-z0-9][A-Za-z0-9._+~-]*$/.test(String(evidenceKey)) || String(evidenceKey).includes('..')) {
    process.stderr.write(`«${evidenceKey}» no sirve para nombrar evidencia (sólo letras, números y . _ + ~ -, sin ..)\n`);
    process.exit(2);
  }
  const evidencePath = path.join(evidenceDir, `${evidenceKey}-${tsStr}.md`);

  if (args.dryRun) {
    process.stdout.write(`Dry run:\n`);
    process.stdout.write(`  story=${args.story}\n`);
    process.stdout.write(`  scenario=${args.scenario}\n`);
    process.stdout.write(`  evidence_path=${evidencePath}\n`);
    process.stdout.write(`  base_url=${args.baseUrl}\n`);
    process.stdout.write(`  steps:\n`);
    for (const s of scenario.steps || []) {
      process.stdout.write(`    - ${s.name || (s.method + ' ' + s.path)}\n`);
    }
    process.exit(0);
  }

  const log = [];
  log.push(`# DoD Runtime Evidence — Story ${args.story}`);
  log.push('');
  log.push(`**Timestamp**: ${ts.toISOString()}`);
  log.push(`**Story**: ${args.story}`);
  log.push(`**Scenario**: \`${path.basename(args.scenario)}\` (${scenario.name || 'unnamed'})`);
  log.push(`**DevHost**: ${args.baseUrl}`);
  log.push(`**Macro**: SPEED-3 \`step-7c-macro.js\``);
  if (scenario.acs_covered) log.push(`**ACs target**: ${scenario.acs_covered.map((a) => `#${a}`).join(', ')}`);
  log.push('');

  // Pre-flight health check
  log.push('## Pre-flight');
  log.push('');
  const healthUrl = args.baseUrl + (scenario.preflight?.devhost_health_url || '/api/health/ready');
  log.push(`Health check: \`GET ${healthUrl}\``);
  let healthOk = false;
  let healthErr = '';
  try {
    const r = await fetch(healthUrl);
    healthOk = r.status === 200;
    log.push(`Response: HTTP ${r.status} ${healthOk ? '✓' : '✗'}`);
  } catch (err) {
    healthErr = err.message;
    log.push(`Response: connection failed — ${err.message}`);
  }
  log.push('');
  if (!healthOk) {
    log.push('🛑 ABORTED — DevHost no responde. Levantar manualmente (`./scripts/devhost.sh start` o equivalente).');
    log.push('');
    // Este camino también deja un archivo en `.advisors/dod-runtime/`: sin declararse fallido,
    // una corrida que no tocó el sistema competía como evidencia válida ante el portón del commit.
    // Sin `failed=<n>` a propósito: no corrió un solo step, y `failed=0` es justo el literal verde.
    log.push('## Veredicto');
    log.push('');
    log.push('**FAIL** — ABORTADA antes de correr un solo step: el DevHost no respondió.');
    log.push('');
    log.push('verdict=FAIL reason=devhost-health-check');
    log.push('');
    fs.mkdirSync(evidenceDir, { recursive: true });
    escribirEvidencia(evidencePath, log, true);
    process.stderr.write(`step-7c-macro: DevHost health check failed (${healthUrl}${healthErr ? ': ' + healthErr : ''})\n`);
    process.exit(1);
  }

  // Execute steps
  log.push('## Smoke runtime curl real');
  log.push('');
  const vars = {};
  let allOk = true;
  const stepResults = [];
  for (const step of scenario.steps || []) {
    const result = await executeStep(step, vars, args.baseUrl, args.bearer, log);
    stepResults.push({ name: step.name, ok: result.ok, failures: result.failures || [] });
    if (!result.ok) {
      allOk = false;
      log.push('🛑 STEP FAILED — abortando secuencia.');
      log.push('');
      break;
    }
  }

  // ACs cubiertos
  if (scenario.evidence?.ac_summary) {
    log.push('## ACs cubiertos por esta evidencia');
    log.push('');
    log.push('| AC | Evidencia |');
    log.push('|---|---|');
    for (const [ac, desc] of Object.entries(scenario.evidence.ac_summary)) {
      log.push(`| #${ac} | ${desc} |`);
    }
    log.push('');
  }

  // Playwright Run block — los literals que satisfacen on-frontmatter-write.js
  // (regex `/##\s*Playwright Run/i` + `/verdict=PASS/` + `/failed=0\b/`) se escriben SÓLO
  // si la corrida anduvo. Con algún step en rojo manda `allOk`, no lo que declare el escenario.
  const fallidos = stepResults.filter((r) => !r.ok).length;
  const pasados = stepResults.filter((r) => r.ok).length;
  log.push('## Playwright Run');
  log.push('');
  const pr = scenario.evidence?.playwright_run || {
    verdict: 'PASS',
    failed: 0,
    rationale: 'Backend-only impl — no E2E declarado en este pipeline.',
  };
  if (allOk) {
    // 🔴 Con `allOk` verdadero, el PASS vacuo para stories backend-only es DISEÑO, no agujero
    // (`pipeline.js` prescribe este mismo bloque). Lo que el escenario declare se respeta tal
    // cual — incluido un `verdict: FAIL`, que no se pisa hacia verde.
    log.push(`verdict=${pr.verdict} failed=${pr.failed} passed=${pr.passed ?? 0} skipped=${pr.skipped ?? 0}`);
    log.push('');
    if (pr.rationale) {
      log.push(`**Rationale**: ${pr.rationale}`);
      log.push('');
    }
  } else {
    log.push(lineaVeredictoFail(fallidos, pasados));
    log.push('');
    log.push(`**Rationale**: el smoke runtime FALLÓ (${fallidos} step(s) en rojo) — esta evidencia NO habilita el cierre.`);
    log.push('');
    if (scenario.evidence?.playwright_run) {
      // 🔴 Los valores declarados se citan SIN reconstruir los literales (`verdict=PASS`,
      // `failed=0`): la nota que explica por qué se ignoró el verde no puede volver a abrir
      // el gate. `hasFreshPlaywrightPass` escanea el archivo entero, no este bloque.
      log.push(`> Se ignoró el \`evidence.playwright_run\` declarado por el escenario ` +
        `(verdict «${pr.verdict}», failed «${pr.failed}»): es entrada auto-declarada y la corrida real falló.`);
      log.push('');
    }
  }

  // Veredicto + summary table
  log.push('## Veredicto');
  log.push('');
  if (allOk) {
    log.push('**PASS** — todos los steps del scenario verificados runtime contra DevHost real.');
    log.push('');
  } else {
    log.push('**FAIL** — uno o más steps fallaron. Ver detalles arriba.');
    log.push('');
    // El `**FAIL**` de arriba es prosa y `evidenciaDeclaraFail` no lo ve; ésta sí.
    log.push(lineaVeredictoFail(fallidos, pasados));
    log.push('');
  }
  log.push('| Step | Status |');
  log.push('|---|---|');
  for (const r of stepResults) {
    log.push(`| ${r.name || '(unnamed)'} | ${r.ok ? '✓ PASS' : '✗ FAIL: ' + r.failures.join('; ')} |`);
  }
  log.push('');

  // Persistir
  fs.mkdirSync(evidenceDir, { recursive: true });
  escribirEvidencia(evidencePath, log, !allOk);
  process.stdout.write(`Evidence written: ${evidencePath}\n`);
  process.stdout.write(allOk ? '✅ DoD runtime gate PASS\n' : '🛑 DoD runtime gate FAIL\n');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`step-7c-macro fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
