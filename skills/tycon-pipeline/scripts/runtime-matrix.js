#!/usr/bin/env node
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * runtime-matrix.js — Matriz de verificación RUNTIME por AC (regla DODRT-C6).
 *
 * **Por qué existe**: un gate que mide "el spec E2E declarado terminó exit 0" no dice
 * "qué ACs quedaron ejercitados en runtime": un gate con 1 spec que cubre 6 de 22 ACs
 * observables pasaría igual. La lista de lo NO probado tiene que ser un artefacto del
 * pipeline (no algo que existe solo si el usuario la pide), y las capas por-AC que validan
 * PROSA escrita por el agente (`la evidencia menciona "AC #N"`) no prueban ejecuciones.
 *
 * **Qué hace**: computa, por cada AC de la story, su evidencia REAL de ejecución:
 *   - RUNTIME  — cubierto por un E2E con gate PASS (artefacto `<sid>-e2e-gate-*.md` de
 *                e2e-gate.sh, exit code real) o por un smoke registrado con exit 0 vía
 *                `smoke-run.sh` (ledger `<sid>-smoke-ledger.jsonl` + espejo en gates.log).
 *   - CODE     — cubierto SOLO por tests unit/integration (artefacto tests-result.json
 *                de test-gate.sh con suite_green). El código está probado; nadie lo
 *                ejercitó corriendo de verdad.
 *   - SIN-EVIDENCIA — ningún artefacto de ejecución lo respalda.
 *
 * **Imagen de pantalla**: un AC de pantalla —lo que el cliente ve— sólo es RUNTIME con además una captura
 * o una grabación (.webm) del navegador real atada a ese AC. Sin ella queda SIN-EVIDENCIA, con el motivo y cómo sacarla.
 * Es "de pantalla" todo AC de una story que cablea interfaz (lib/ui-signal.js), salvo el marcado `@sin-pantalla`; en una
 * story sin interfaz, sólo el marcado `@pantalla`. La imagen sale de dos lugares, los dos ya contados por la matriz:
 *   - el portón E2E: `<clave>-captures-<ts>/captures.json` (lo escribe e2e-evidence.js) ata cada imagen a los `@ac-N`
 *     del título del test que la sacó;
 *   - el humo: `smoke-run.sh --capture <archivo>` la copia a la evidencia y sella su sha256 en el registro y en el espejo.
 * Rige para las stories que arrancan después de VISUAL_EVIDENCE_FROM; las que arrancaron antes reciben un aviso.
 *
 * **La regla**: la matriz está VERDE solo si cada AC es RUNTIME, o si el resto está declarado
 * materialmente imposible de verificar corriendo la app Y el USUARIO lo aprobó desde su terminal:
 *
 *   runtime_not_verifiable:          # en el frontmatter de la story, lo escribe quien la escribe
 *     - ac: 6
 *       reason: "<por qué no se puede ejercer corriendo>"
 *       covered_by: T6              # el test que lo cubre igual
 *
 *   + `marker.js runtime-waiver <story>` — la firma del dev, por TTY, en `<repo>/.tycon/runtime-waivers.jsonl`
 *     (lib/runtime-waiver.js; veredicto WAIVED-USER). El agente no tiene TTY: no puede firmar.
 *
 * La firma engancha por la declaración (razón + test que lo cubre) y por el hash de la matriz: si cambian, la
 * firma deja de aplicar sola. Un AC sin evidencia y NO declarado (NOT-RUN) no se puede firmar: hay que correrlo.
 *
 * Un `runtime_verification_ack:` en el frontmatter no abre nada: lo podía escribir el agente,
 * así que no cuenta como perdón.
 *
 * Staleness (por clase de artefacto — calibrado con la regla de tests del equipo):
 *   - e2e gate / smoke ledger MÁS VIEJOS que el último edit de código → NO cuentan
 *     (re-correrlos es barato y scoped).
 *   - tests-result.json más viejo que el código → WARNING, sigue contando: regenerarlo
 *     es la full suite, que por regla del equipo corre SOLO en el merge-gate
 *     (test-execution-discipline: una suite completa puede congelar la máquina del dev).
 *
 * Uso:
 *   node runtime-matrix.js --story <abs path .md> [--workspace-root <dir>]
 *        [--evidence-dir <dir>] [--json] [--no-write]
 *
 * Exit: 0 = verde (todo RUNTIME o resto ackeado válido) · 1 = rojo · 2 = error
 * estructural (story ilegible / sin ACs ni tabla) — FAIL CLOSED, nunca "no pude leer,
 * paso". Enforcement: `marker.js run-check acmatrix -- node runtime-matrix.js ...`
 * (complete-step prepare-commit lo exige verde) + `on-pre-commit.js` re-computa en vivo en
 * transiciones a review/done (no confía en el .md escrito — recalcula).
 */

const fs = require('fs');
const path = require('path');
const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // la carpeta del estado, de una sola pieza
const os = require('os');
const crypto = require('crypto');
const smokeSecrets = require(path.join(__dirname, 'lib', 'smoke-secrets.js'));
const e2eEvidence = require(path.join(__dirname, 'lib', 'e2e-evidence.js'));

// Desde cuándo un AC de pantalla sin imagen bloquea: las stories que arrancaron antes de esta hora no se frenan a mitad
// de su trabajo y reciben un aviso. Es la hora en que se publica la regla.
const VISUAL_EVIDENCE_FROM = '2026-10-18T20:00:00Z';
// Lo que vale como imagen en la carpeta del E2E (las capturas de Playwright y su video) y en la del humo.
const VISUAL_E2E_FILE_RE = /\.(png|jpe?g|webp|gif|webm)$/i;
const VISUAL_SMOKE_FILE_RE = /\.(png|webm)$/i;

const RUNTIME_NIVEL_RE = /e2e|smoke|runtime|playwright/i;
// El código es el de lib/code-files.js (con lo que sume la organización); la matriz suma `.sql` (migraciones).
const codeFilesLib = require('./lib/code-files.js');
function isCodeFile(f, { extra } = {}) {
  const ex = extra !== undefined ? extra : require('./lib/stack-config.js').orgExtra();
  return codeFilesLib.isCode(f, { extra: ex }) || codeFilesLib.extOf(f) === '.sql';
}
const CODE_FILE_RE = { test: (f) => isCodeFile(f) };
// Lado FE por STACK, no por producto: `.tsx` y vitest son señal genérica, y
// `.test.ts(x)` es el naming de vitest. `.test.js` es node --test BACKEND: tomarlo como señal FE
// (`.test.`) obligaría a las filas backend a buscar una suite FE que no existe.
// Los nombres de producto no van acá: cada repo declara su lado en
// `.tycon/advisors.yaml → evidence.fe_paths` y kindOf() los toma de ahí.
// Una pantalla en Svelte o Vue es lado FE igual que una en React.
const GENERIC_FE_RE = /\.tsx|\.jsx\b|\.svelte\b|\.vue\b|\.test\.tsx?\b|vitest/i;
function kindOf(s, fePaths) {
  const str = String(s || '');
  return (fePaths || []).some((t) => str.includes(t)) || GENERIC_FE_RE.test(str) ? 'fe' : 'be';
}

// ---------------------------------------------------------------- parsing helpers

function readStory(storyPath) {
  const content = fs.readFileSync(storyPath, 'utf8');
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return { content, fm: fmMatch ? fmMatch[1] : '' };
}

// El número de la story y la CLAVE de su evidencia viven en lib/evidence-key.js: con un número
// repetido en el repo, la evidencia se nombra `<tema>__<número>` y no `<número>`. `storyIdFrom` se
// re-exporta desde acá para no romper a quien la importa de este archivo.
const evidenceKeyLib = require(path.join(__dirname, 'lib', 'evidence-key.js'));
const { storyIdFrom } = evidenceKeyLib;

function frontmatterFileList(fm) {
  // Entradas `- path` bajo files_to_create/files_to_modify (con o sin comentario #).
  const files = [];
  const re = /^\s*-\s*([^\s#][^#\n]*?)\s*(?:#.*)?$/gm;
  const sections = fm.match(/files_to_(?:create|modify):\n((?:\s+-[^\n]*\n?)*)/g) || [];
  for (const sec of sections) {
    let m;
    while ((m = re.exec(sec)) !== null) files.push(m[1].trim());
  }
  return files;
}

// Parsea el bloque `runtime_not_verifiable:` del frontmatter — la declaración por-AC de
// "materialmente imposible de verificar corriendo la app" (con razón + test que lo cubre):
//   runtime_not_verifiable:
//     - ac: 15
//       reason: "El DevHost tiene un solo tenant; no hay 2º laboratorio para el cruce."
//       covered_by: T11b
// El agente la ESCRIBE, pero el usuario la aprueba (waiver TTY, viendo la razón), y la matriz
// exige que cada AC declarado tenga un test que lo cubra (si no, la declaración es inválida).
// Raíz del REPO (la carpeta con `.git`) subiendo desde la story — lib/evidence-config.js
// (fuente única, compartida con los hooks on-pre-commit / on-frontmatter-write). Es donde vive
// `.tycon/runtime-waivers.jsonl`, el log firmado que SÍ viaja con el código.
const { discoverRepoRoot } = require(path.join(__dirname, 'lib', 'evidence-config.js'));

function parseNotVerifiable(fm) {
  const out = [];
  if (!fm) return out;
  const lines = fm.split('\n');
  let i = lines.findIndex((l) => /^runtime_not_verifiable:\s*$/.test(l));
  if (i === -1) return out;
  const strip = (s) => s.replace(/^["']|["']$/g, '').trim();
  let cur = null;
  for (i++; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // dedent a otra clave top-level → fin del bloque
    const acM = line.match(/^\s*-\s*ac:\s*(\d+)/);
    if (acM) { if (cur) out.push(cur); cur = { ac: parseInt(acM[1], 10), reason: null, coveredBy: null }; continue; }
    if (!cur) continue;
    const rM = line.match(/^\s*reason:\s*(.+?)\s*$/);
    if (rM) { cur.reason = strip(rM[1]); continue; }
    const cM = line.match(/^\s*covered_by:\s*(.+?)\s*$/);
    if (cM) { cur.coveredBy = strip(cM[1]); continue; }
  }
  if (cur) out.push(cur);
  return out;
}

// El `runtime_verification_ack` en frontmatter no se acepta: lo podría escribir el agente
// (calcular el hash y auto-aprobarse). La única forma de perdonar un AC es el waiver
// TTY-only (lib/runtime-waiver.js): que el USUARIO lo confirme desde su terminal.

// ---------------------------------------------------------------- discovery

function discoverWorkspaceRoot(storyPath) {
  // <ws>/<ProjectRepo>/specs/stories/<story>.md → ws
  // También `.specs` con nivel de epic intermedio (layout con epic intermedio):
  // <ws>/<ProjectRepo>/.specs/<epic>/stories/<story>.md → ws
  let dir = path.dirname(storyPath);
  for (let i = 0; i < 6 && dir !== '/'; i++) {
    const base = path.basename(dir);
    // `spec` singular: layout del repo del framework (spec/stories/<epic>/<story>.md).
    if (base === 'specs' || base === '.specs' || base === 'spec') return path.dirname(path.dirname(dir));
    dir = path.dirname(dir);
  }
  // Fallback (layout `docs/` en vez de `specs/`: stories bajo
  // <ws>/<ProjectRepo>/docs/<...>/<story>.md): subir hasta el repo root
  // (dir con `.advisors/`) y devolver su padre, para que la discovery de hermanos encuentre
  // <repo>/.advisors/tests-result.json. Solo actúa si el lookup de specs/.specs no resolvió.
  dir = path.dirname(storyPath);
  for (let i = 0; i < 8 && dir !== '/'; i++) {
    if (isDir(path.join(dir, '.advisors'))) return path.dirname(dir);
    dir = path.dirname(dir);
  }
  return null;
}

// 🔴 ATRIBUCIÓN DE EVIDENCIA: la discovery no barre los repos HERMANOS del workspace buscando
// `.advisors/`. Un tests-result.json de otro repo (otra story, otro producto) le daría cobertura
// "CODE" a una story que no lo probó, aunque tuviera un warning. La matriz existe para que "probado"
// signifique probado; evidencia que no se puede atribuir con seguridad NO cuenta.
//
// La regla: la evidencia sale del repo git que CONTIENE la story (y sus subproyectos
// un nivel abajo — monorepos tipo AcmeFrontEnd/acme-deposito). Un repo hermano solo
// aporta si el repo de la story lo DECLARA en `.tycon/advisors.yaml`:
//
//   evidence:
//     companion_repos:
//       - AcmeFrontEnd         # nombre de hermano (se resuelve contra el padre del repo)
//       - ../OtroRepo           # o path relativo al repo / absoluto
//
// (el caso legítimo FE/BE en repos separados de un MISMO producto se declara, no se adivina
// por vecindad en el filesystem). Sin repo git determinable → NINGUNA evidencia cuenta
// (fail-closed con el motivo en warnings); la salida es `--evidence-dir` explícito.

// `.advisors/dod-runtime` de UN root (repo + subproyectos 1 nivel): lib/evidence-config.js.
const { evidenceDirsUnder } = require(path.join(__dirname, 'lib', 'evidence-config.js'));

// `.advisors/tests-result.json` de UN root: repo + subproyectos (1 nivel), MÁS la copia sellada
// que sí viaja por git (`.advisors/dod-runtime/<story>-tests-result.json`, que escribe test-gate.sh).
// 🔴 Por qué la copia: el artefacto original está en el .gitignore —es salida de corrida
// con rutas de la máquina— así que no existe en otra máquina, en CI, ni después de una limpieza. Y sin
// él ningún test de la tabla cuenta como evidencia de código: las declaraciones `runtime_not_verifiable`
// se degradan a NOT-RUN y la story no cierra. El original manda cuando está: esto es un respaldo, no
// un reemplazo, así que en la máquina donde corrió la suite nada cambia.
function testsResultsUnder(root) {
  const found = [];
  const top = path.join(root, '.advisors', 'tests-result.json');
  if (isFile(top)) found.push(top);
  for (const child of safeReaddir(root)) {
    const f = path.join(root, child, '.advisors', 'tests-result.json');
    if (isFile(f)) found.push(f);
  }
  if (found.length === 0) {
    const ev = path.join(root, '.advisors', 'dod-runtime');
    for (const f of safeReaddir(ev)) {
      if (/-tests-result\.json$/.test(f)) found.push(path.join(ev, f));
    }
  }
  return found;
}

// Bloque `evidence:` de `.tycon/advisors.yaml` — parser en lib/evidence-config.js (fuente
// única, compartida con el detector de story-de-UI de lib/ui-signal.js). Dos listas:
//   companion_repos — repos hermanos del MISMO producto cuya evidencia cuenta para este repo.
//   fe_paths        — tokens de path/nombre que marcan el lado FRONTEND de este producto
//                     (ej. AcmeFrontEnd, acme-deposito) para el apareo fila↔suite.
const { parseEvidenceConfig } = require(path.join(__dirname, 'lib', 'evidence-config.js'));

// Repos hermanos NO declarados cuya evidencia RECLAMA esta story (artefactos `<sid>-*` en
// dod-runtime, o tests-result.json con story_id === sid). No cuentan — pero la exclusión se
// dice con nombre y salida, porque el silencio acá se leería como "no había evidencia".
function scanExcludedClaims(container, allowedRoots, sid) {
  const hits = [];
  if (!container || !sid) return hits;
  const allowed = new Set(allowedRoots.map((r) => path.resolve(r)));
  for (const sib of safeReaddir(container)) {
    const root = path.join(container, sib);
    if (allowed.has(path.resolve(root)) || !isDir(root)) continue;
    const claims =
      evidenceDirsUnder(root).some((d) => safeReaddir(d).some((f) => f.startsWith(`${sid}-`))) ||
      testsResultsUnder(root).some((f) => {
        try { return String(JSON.parse(fs.readFileSync(f, 'utf8')).story_id) === sid; } catch { return false; }
      });
    if (claims) hits.push(sib);
  }
  return hits;
}

function safeReaddir(d) {
  try { return fs.readdirSync(d).filter((x) => !x.startsWith('.')); } catch { return []; }
}
function isDir(d) { try { return fs.statSync(d).isDirectory(); } catch { return false; } }
function isFile(f) { try { return fs.statSync(f).isFile(); } catch { return false; } }
function mtimeMs(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }

// ---------------------------------------------------------------- evidence readers

// Artefactos de e2e-gate.sh: `<sid>-e2e-gate-<ts>.md` con `verdict=PASS` + `**Spec filter**: X`.
// Gates E2E: `<sid>-e2e-gate-<ts>.md` con verdict=PASS + Spec filter.
// 🔴 ANTI-FORJA: un .md por sí solo NO cuenta — el gate se corre
// SIEMPRE vía `marker.js run-check dod -- bash <gate> ... <spec-filter>`, que ejecuta el comando por
// execFileSync (exit code REAL) y deja un ESPEJO en gates.log con el `cmd`. Se exige ese espejo:
// un run-check `dod` green cuyo `cmd` referencie el spec filter del gate. Sin espejo → no cuenta
// (misma protección que el smoke ledger). Un `cat > fake-gate.md` con verdict=PASS no alcanza: hace
// falta también una línea forjada en gates.log (deliberada y, con el chain, detectable).
// Un `run-check dod -- true` NO sirve: su cmd no contiene el spec filter.
function readE2eGates(evidenceDirs, sid, gatesLogPath, storyPath) {
  let mirror = '';
  try { mirror = fs.readFileSync(gatesLogPath || defaultGatesLog(), 'utf8'); } catch { /* sin gates.log → nada verifica */ }
  const mirrorLines = mirror.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const gates = [];
  for (const dir of evidenceDirs) {
    for (const f of safeReaddir(dir)) {
      const m = f.match(new RegExp(`^${escapeRe(sid)}-e2e-gate-(\\d{8}T\\d{6}Z)\\.md$`));
      if (!m) continue;
      const full = path.join(dir, f);
      let content = '';
      try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const verdict = (content.match(/verdict=(\w+)/) || [])[1] || null;
      // Todos los filtros de la línea: un gate corrido con varios specs los nombra separados por espacio.
      const specFilters = ((content.match(/\*\*Spec filter\*\*:[ \t]*(.*)/) || [])[1] || '').split(/\s+/).filter(Boolean);
      const specFilter = specFilters[0] || null;
      const skipped = e2eEvidence.skippedOf(content);
      // Espejo: run-check dod green cuyo cmd menciona el spec filter (o, si no hay filter, la clave — o la
      // ruta de la story, que es como se le pasa al gate).
      const needles = specFilter ? [specFilter] : [sid, storyPath].filter(Boolean);
      const mirrored = mirrorLines.some((e) =>
        e.check === 'dod' && e.status === 'green' && e.provenance === 'run-check' &&
        typeof e.cmd === 'string' && needles.some((n) => e.cmd.includes(n)));
      // Títulos de los tests que PASARON (contrato DODRT-C8 del gate). Con esto la matriz
      // distingue "el test MIRÓ el botón" de "el test lo APRETÓ" (título con @mutates).
      const titulos = [];
      const secTit = content.split(/^##\s+Tests corridos[^\n]*$/m)[1];
      if (secTit) {
        for (const line of secTit.split('\n')) {
          const t = line.match(/^\s*-\s+(.*\S)\s*$/);
          if (t) titulos.push(t[1]);
          else if (/^##\s/.test(line)) break;
        }
      }
      gates.push({ path: full, ts: compactTsToMs(m[1]), tsRaw: m[1], verdict, specFilter, specFilters, skipped, mirrored, titulos });
    }
  }
  gates.sort((a, b) => b.ts - a.ts);
  return gates;
}

function readTestsResults(paths, fePaths) {
  const out = [];
  for (const p of paths) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      out.push({
        path: p,
        ts: d.ts ? Date.parse(d.ts) : mtimeMs(p),
        storyId: d.story_id != null ? String(d.story_id) : null,
        green: d.suite_green === true,
        kind: kindOf(p, fePaths),
      });
    } catch { /* artefacto ilegible = no cuenta */ }
  }
  return out;
}

// --- clasificación del COMANDO de cada entry del ledger.
//
// Sin mirar el campo `cmd`, una entry del ledger sería "evidencia runtime" con sólo 3 condiciones:
// pasó por smoke-run.sh, tiene espejo en gates.log, y salió 0. O sea que `node --test
// tests/unit/foo.test.js` y una sonda que persiste contra la plataforma real contarían
// EXACTAMENTE IGUAL, ambas como 🟢 RUNTIME.
//
// Eso vacía de sentido al gate: DODRT-C6 existe para cazar el caso "compila y los tests pasan pero
// en la plataforma no anda", y no lo puede cazar si acepta los tests como prueba de que anda en la
// plataforma. Un ledger hecho sólo de `node --test` daría 🟢 RUNTIME sin que nada llegara a la
// plataforma.
//
// Lo que el mecanismo garantiza: anti-forja (nadie inventa una corrida que no ocurrió). Lo que NO
// garantiza: que la corrida sea la corrida correcta. Eso es lo que agrega esta clasificación.
const CMD_TEST_RE = /\b(node\s+--test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|vitest|jest|dotnet\s+test|pytest|go\s+test)\b/;
// `vstest.console` es el corredor de pruebas de .NET Framework (la receta netfx-vstest): lo mismo que `dotnet test`. Sin
// mirar mayúsculas: en Windows el ejecutable es `VSTest.Console.exe` y el nombre no distingue mayúsculas
const CMD_VSTEST_RE = /\bvstest\.console\b/i;
const CMD_GATE_RE = /\bnpm\s+run\s+(lint|typecheck|build|audit|tokens|format)|\b(tsc|eslint)\b/;

// 'unit-test' → el código revisándose a sí mismo · 'build-gate' → lint/typecheck/build
// 'app-run'   → cualquier otra cosa: se ASUME que ejercita la app (curl, sonda JSON-RPC, CLI real).
// La asimetría es deliberada: se puede reconocer con certeza un runner de tests, pero no se puede
// enumerar todo lo que cuenta como "correr la app". Ante la duda se cuenta como app-run —
// clasificar de menos deja al gate sin esta distinción, y clasificar de más bloquearía trabajo válido.
function classifyCmd(cmd) {
  const s = typeof cmd === 'string' ? cmd : '';
  if (CMD_TEST_RE.test(s) || CMD_VSTEST_RE.test(s)) return 'unit-test';
  if (CMD_GATE_RE.test(s)) return 'build-gate';
  return 'app-run';
}

// ---------------------------------------------------------------- DODRT-C8
//
// "Verificado corriendo" miente cuando el AC describe una ACCIÓN que el usuario ejecuta y la
// prueba sólo MIRA que el botón esté. Ejemplo: el AC dice
// "el encargado puede ... asignar una ruta"; el E2E abre el modal y asierta que el botón
// "Iniciar ruta" es visible. Sin esta regla la matriz lo da 🟢 RUNTIME, el pipeline cierra
// verde, y la acción puede fallar en la app real (500 del BPM). El agujero no es el test: es
// que la matriz no distinguiría mirar de ejecutar.
//
// La regla: si el texto del AC contiene un verbo que MUTA estado, la evidencia runtime tiene
// que mostrar que esa mutación se EJECUTÓ. Tres formas de probarlo, todas mecánicas:
//   (a) un test del gate E2E cuyo título tenga `@mutates` y el `@ac-N` del AC, o
//   (b) un smoke cuyo comando escriba de verdad (POST/PUT/PATCH/DELETE o --data), o
//   (c) un smoke DECLARADO con `--mutates` en smoke-run.sh (para productos sin superficie HTTP
//       ni navegador: un servidor MCP habla por stdio, sin curl ni Playwright posibles, y sus smokes
//       mutan de verdad; el detector por-comando no los ve). El flag NO es más débil que (b): un `-X DELETE`
//       dentro de un comando también lo escribe el agente — la garantía real siempre fue el
//       exit code que smoke-run.sh captura. Anti-forja: cuenta SOLO si el espejo de gates.log
//       (fuera del repo, append-only) trae `"mutates":true` en la línea de ESA corrida.
// Sin ninguna de las tres → RUNTIME-PARCIAL: bloquea igual que NOT-RUN, con su propia salida
// (ejecutar la acción, o declarar el AC `runtime_not_verifiable` y que lo waivee el usuario).
//
// Sólo verbos de MUTACIÓN — "ver", "mostrar", "abrir" o "listar" no disparan la regla: un AC
// de lectura queda cubierto por un E2E que observa, y bloquearlo sería ruido.
// Formas VERBALES explícitas (infinitivo y 3ª persona). Deliberadamente SIN sustantivos
// derivados: "sin importar su asignación" o "ausencia de asignación vigente" describen un
// CRITERIO de lectura, no algo que el usuario ejecute — meterlos daría falsos positivos que
// bloquearían ACs de consulta.
const MUTATION_VERB_RE = new RegExp(
  '\\b(' + [
    'asignar|asigna|asigne', 'iniciar|inicia|inicie', 'crear|crea|cree',
    'guardar|guarda|guarde', 'enviar|envía|envia|envíe', 'confirmar|confirma|confirme',
    // 'cree' fuera: colisiona con el subjuntivo de "creer".
    'descartar|descarta', 'reprocesar|reprocesa|reprocese',
    'eliminar|elimina|elimine', 'borrar|borra|borre', 'modificar|modifica|modifique',
    'editar|edita|edite', 'aprobar|aprueba|apruebe', 'rechazar|rechaza|rechace',
    // 'cierre' y 'descarte' quedan FUERA a propósito: son también sustantivos de uso corriente
    // en los ACs ("el cierre de ruta", "el descarte del aviso") y dispararían la regla sobre
    // ACs de lectura. El infinitivo y la 3ª de indicativo alcanzan.
    'cerrar|cierra', 'resolver|resuelve|resuelva', 'vincular|vincula|vincule',
    'registrar|registra|registre', 'actualizar|actualiza|actualice',
    'disparar|dispara|dispare',
  ].join('|') + ')\\b', 'i');

// ── Contexto del verbo ──────────────────────────────────────────────────────
// La lista de arriba es LÉXICA y el castellano no lo es: 'cierre' y 'descarte' ya no están por dar
// falsos positivos sobre ACs de consulta, y un verbo en el contexto equivocado también los da. En
// una feature READ-ONLY el falso positivo es especialmente caro, porque NO existe ninguna acción
// que ejecutar y las tres salidas previstas (E2E `@mutates`, smoke que escribe, `--mutates`)
// exigirían declarar una mutación que no ocurre. Dos ejemplos:
//
//   · "una solicitud con idEstadoSolicitudActual que RESUELVE en Parameters"
//           → "resuelve" es un match contra un catálogo. El sujeto es un dato, no una persona.
//   · "la solicitud igual aparece en la lista (NO se DESCARTA por el LEFT JOIN)"
//           → el AC afirma que la acción NO ocurre, y encima habla de un JOIN.
//
// Seguir BORRANDO verbos de la lista es el arreglo equivocado: cada borrado abre un falso
// NEGATIVO, que es el error caro (apaga justo el control que DODRT-C8 sostiene). Se evalúa el
// CONTEXTO de cada aparición y alcanza con que UNA sobreviva para que el AC siga siendo de
// acción — así un "no" suelto en el Given nunca tapa un verbo que sí muta en el Then.
//
// Ambos neutralizadores son deliberadamente ESTRECHOS (sólo señales de alta confianza):
// ante la duda el verbo dispara, que es el lado seguro del error.

// (a) NEGACIÓN INMEDIATA: sólo "no/nunca/jamás/tampoco" pegado al verbo, con un clítico
//     opcional en el medio ("no se descarta", "nunca lo elimina"). Una negación LEJANA
//     ("un usuario sin permisos … puede asignar") NO neutraliza: sería un falso negativo.
//     Límite conocido y aceptado: "no se DEBE descartar" no se neutraliza (queda un puente
//     modal en el medio) — falla hacia el lado seguro, el gate sigue pidiendo evidencia.
const NEGACION_INMEDIATA_RE = /\b(no|nunca|jamás|jamas|tampoco)\s+(se\s+|lo\s+|la\s+|los\s+|las\s+|le\s+|les\s+)?$/i;

// (b) LOOKUP: SÓLO 'resolver' y sólo con complemento de catálogo ("resuelve EN Parameters",
//     "se resuelve POR TypeName"). "resolver el ticket" —mutación de verdad— no lleva ese
//     complemento y sigue disparando.
const VERBO_DE_LOOKUP_RE = /^(resolver|resuelve|resuelva)$/i;
const COMPLEMENTO_DE_LOOKUP_RE = /^\s*(en|por|contra|desde)\b/i;

// (c) 🔴 RE-EJECUCIÓN: la negación NO neutraliza cuando el AC
//     describe una RE-EJECUCIÓN. Medido sobre las 1222 stories Mary+GOLD del equipo (8864 ACs):
//     de los 222 criterios que (a) rescata, 9 son de IDEMPOTENCIA o CONCURRENCIA —
//       · "Doble inicio (idempotente): … con orden YA INICIADA … NO crea registro DUPLICADO"
//       · "… ya está COMPLETADO … cuando se VUELVE A escanear … status \"duplicate\""
//       · "Dos asignaciones CONCURRENTES … nunca se asigna la misma extension DOS VECES"
//     Ahí la acción SÍ se ejecuta —dos veces, de hecho—: lo que la negación califica es el
//     DUPLICADO, no la acción. Y son justo los ACs donde más vale exigir que la mutación haya
//     corrido de verdad, porque un duplicado sólo aparece CORRIENDO, no leyendo el código.
//
//     Hacen falta las DOS señales a la vez, y por eso el guard es angosto:
//       · repetición  — "ya existe"/"ya iniciada", "vuelve a", "re-ejecutar", "segunda", "concurrente"…
//       · duplicación — "idempotente", "duplicado", "dos veces", "doble"
//     Con UNA sola sobra ruido y se re-bloquean ACs legítimos de lectura (medido: "NO duplicar
//     ExportHelpers.cs" es una convención de propiedad de archivo, y "un alta cuyo documento YA
//     EXISTE → 409" es un rechazo, donde la acción justamente NO ocurre). Con las dos, los 9
//     rescates que vuelven a marcarse son los 9 correctos y ningún otro. Por eso "ya es" no está en la
//     lista de repetición: marcaba un falso positivo ("ya es el WARNING de … no se duplica el reporte").
//
//     Dirección del error: este guard sólo AGREGA marcas, nunca las saca — falla hacia el gate
//     pidiendo evidencia, que es el lado seguro. El neutralizador (b) NO se toca: un lookup
//     dentro de un AC de idempotencia sigue siendo un lookup.
const REEJECUCION_RE = /\bya (existe|existen|está|esta|están|fue|fueron|estaba|iniciad|marcad|complet|creado|creada|registrad|enviad|asignad|aprobad|cerrad)|vuelven? a\b|re-?ejecut|re-?escane|re-?envi|re-?intent|reintent|\bsegunda vez\b|\bsegundo\b|\bsegunda\b|dos veces|\bdoble\b|\bconcurrent/i;
const DUPLICADO_RE = /idempoten|duplic|dos veces|\bdoble\b/i;
function describeReejecucion(text) {
  return REEJECUCION_RE.test(text) && DUPLICADO_RE.test(text);
}

// (d) CONDICIONAL: «cada deploy BORRARÍA la columna y
//     CERRARÍA todos los plugins» describe lo que pasaría SI algo saliera mal, no algo que el usuario hace.
//     Sin este caso dispara por un detalle de JavaScript: `\b` no conoce las letras con tilde, así que
//     «borrar» + «ía» se lee como «borrar» y una palabra. Sólo el condicional (-ía/-ían/-íamos/-ías): el futuro
//     («se CREARÁ el registro») sí afirma que la acción ocurre y sigue disparando.
const CONDICIONAL_RE = /^í(a|an|as|amos|ais)(?![A-Za-zÀ-ÿ])/i;

// (e) RECHAZO HTTP: «se RECHAZA sin invocar el handler: `401`» es la acción que
//     justamente NO ocurre — el pedido no pasa. Sólo 'rechazar', y sólo con un código 4xx a menos de 45
//     caracteres y sin cortar la oración. «el supervisor rechaza la solicitud» no trae código y sigue
//     disparando.
const VERBO_DE_RECHAZO_RE = /^(rechazar|rechaza|rechace)$/i;
const CODIGO_DE_RECHAZO_RE = /^[^.;\n]{0,45}?\b4\d\d\b/;

// (f) «SIN» + INFINITIVO: «sus pruebas
//     pasan SIN EDITAR ni una línea» o «reusa el servicio SIN MODIFICAR sus contratos» describen algo que NO
//     pasa, y la negación (a) sólo reconoce no/nunca/jamás/tampoco. Medido sobre 1.003 stories con criterios
//     (11.888 criterios, 2.500 de acción): 71 eran de acción sólo por un «sin» + infinitivo. Sólo el
//     infinitivo (-ar/-er/-ir) pegado al «sin»: «sin confirmar el aviso» no tapa un «guarda el pedido» de la
//     misma oración, porque basta una aparición no neutralizada para que el criterio sea de acción.
//     🔴 NO aplica si el criterio habla de idempotencia, duplicado o repetición: «el mismo pedido 2x → 200
//     SIN CREAR duplicado» corre la acción dos veces, y ahí el «sin» califica al duplicado. A diferencia de
//     (c), alcanza UNA señal (las de repetición y duplicado de (c), más las de abajo): con esta regla
//     cambian 59 criterios del corpus, no 71, porque la señal única retiene 12.
//     Límite aceptado: dos criterios de acción del corpus cuyo
//     verbo real no está en la lista («agregar», «arrancar»/«marcar») marcaban sólo por el «sin» +
//     infinitivo, o sea por casualidad, y dejan de marcar. Arreglarlos es sumar verbos a la lista, que
//     cambia muchos más criterios y se mide aparte.
const SIN_PEGADO_RE = /\bsin\s+$/i;
const INFINITIVO_RE = /(ar|er|ir)$/i;
// La segunda línea suma «tres veces», «retry», «re-procesar» y «el mismo payload / webhook / request».
const REPETICION_EXTRA_RE = new RegExp([
  /\b2x\b|\bde nuevo\b|\bdedup|\bnuevamente\b|\botra vez\b|\breenv[ií]|\bya procesad|\bupsert|\buna sola vez\b|\brepetid/.source,
  /\b(\d+|tres|cuatro|cinco|varias|muchas|n) veces\b|\bretr(y|ies|ied|ying)\b|\bre-?procesa/.source,
  /\bmism[oa]s? (id|evento|pedido|mensaje|payload|webhook|request|solicitud|archivo|registro|lote)\b/.source,
].join('|'), 'i');
function hablaDeRepeticion(text) {
  return REEJECUCION_RE.test(text) || DUPLICADO_RE.test(text) || REPETICION_EXTRA_RE.test(text);
}

function acEsDeAccion(text) {
  if (!text) return false;
  // Copia con /g: MUTATION_VERB_RE se comparte y no debe arrastrar lastIndex entre llamadas.
  // El guard (c) se evalúa sobre el AC ENTERO, no por aparición: la re-ejecución es una
  // propiedad del ESCENARIO ("se invoca dos veces"), no de un verbo suelto. Lo mismo el de (f).
  const esReejecucion = describeReejecucion(text);
  const repite = hablaDeRepeticion(text);
  const re = new RegExp(MUTATION_VERB_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }   // guard anti-loop, por si la alternación cambia
    const antes = text.slice(Math.max(0, m.index - 24), m.index);
    if (!esReejecucion && NEGACION_INMEDIATA_RE.test(antes)) continue;
    if (!repite && SIN_PEGADO_RE.test(antes) && INFINITIVO_RE.test(m[0])) continue;
    const despues = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (VERBO_DE_LOOKUP_RE.test(m[0]) && COMPLEMENTO_DE_LOOKUP_RE.test(despues)) continue;
    if (CONDICIONAL_RE.test(despues)) continue;
    if (VERBO_DE_RECHAZO_RE.test(m[0]) && CODIGO_DE_RECHAZO_RE.test(text.slice(m.index + m[0].length))) continue;
    return true;   // una sola aparición no neutralizada alcanza
  }
  return false;
}

// ── Exención declarada por AC: `@runtime-exempt(DODRT-C8): <motivo>` ─────────────
//
// 🔴 Qué corrige y qué NO. Corrige la CLASIFICACIÓN ("el verbo de este AC no describe una
// acción"), NUNCA la verificación runtime: el AC sigue necesitando su evidencia de que se
// corrió. O sea, es una afirmación distinta de `runtime_not_verifiable:` —y verificable, y por
// eso auditable—: aquella declara "esto no se puede verificar corriendo" (y en un AC de lectura
// que SÍ se verificó corriendo es, lisa y llanamente, falsa, y queda escrita en la story para
// siempre); ésta declara "acá el verbo es el nombre de un endpoint / un botón / un permiso".
//
// Por qué hace falta además del contexto (a)+(b)+(c). Medido sobre el corpus del equipo
// (1222 stories, 8864 ACs): con (a)+(b)+(c) quedan ~238 criterios marcados que son falsos
// positivos, y el patrón dominante es el verbo NOMBRANDO algo, en un AC que verifica que la
// acción se BLOQUEA:
//
//   · "Endpoints iniciar / cerrar retornan 403 para roles distintos a Encargado General"
//   · "el sistema bloquea la acción con el mensaje: 'Resuelva todas las suspensiones'"
//   · "el P2 se muestra read-only con banner 'Sólo el Encargado General puede editar el listado'"
//
// Ninguna heurística gramatical distingue eso: el verbo está bien escrito y en indicativo. Lo
// que falta es contexto que sólo tiene la persona. Ensanchar los neutralizadores para taparlo
// abriría falsos NEGATIVOS a gran escala — el error caro.
//
// Reglas del mecanismo, deliberadas:
//   1. El MOTIVO es obligatorio. Sin motivo la marca NO cuenta y se avisa: una marca vacía es
//      un `skip` disfrazado, y un opt-out sin constancia es un opt-out
//      que nadie audita (mismo criterio que `@realness-exempt(REAL-CN)` en los E2E).
//   2. Se CUENTA en el artefacto y en las warnings — cada uso queda a la vista, y la lista es a
//      la vez el insumo para mejorar la heurística.
//   3. Con 3 o más en una misma story, grita: puede ser legítimo (una story read-only entera),
//      pero es exactamente la forma que tendría el abuso, así que se mira.
//   4. El texto de la marca se SACA antes de clasificar: si no, las palabras del motivo
//      ("no se puede asignar porque…") entran al clasificador y lo ensucian.
const EXENCION_C8_RE = /@runtime-exempt\(\s*DODRT-C8\s*\)\s*:?\s*([^@]*)/i;
const MOTIVO_MINIMO = 10;   // "es un nombre" ya son 13 — corta los "n/a", "-", "ver arriba".

// → { marcada, valida, motivo, texto } — `texto` SIEMPRE viene sin la marca.
function parseExencionC8(text) {
  const t = String(text || '');
  const m = EXENCION_C8_RE.exec(t);
  if (!m) return { marcada: false, valida: false, motivo: null, texto: t };
  const motivo = String(m[1] || '').replace(/\s+/g, ' ').trim().replace(/[.;,\s]+$/, '');
  const texto = (t.slice(0, m.index) + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  return { marcada: true, valida: motivo.length >= MOTIVO_MINIMO, motivo: motivo || null, texto };
}

// Un comando que ESCRIBE. Igual criterio que classifyCmd: reconocer con certeza, no adivinar.
const CMD_MUTATES_RE = /-X\s*['"]?(POST|PUT|PATCH|DELETE)|--data(-raw|-binary|-urlencode)?\b|\s-d\s/i;
function cmdMutates(cmd) { return CMD_MUTATES_RE.test(typeof cmd === 'string' ? cmd : ''); }

// Un título de test del gate que ejerce la mutación de ESTE AC: `@mutates` + `@ac-N`.
function tituloEjerceAc(titulo, n) {
  if (!/@mutates\b/i.test(titulo)) return false;
  return new RegExp(`@ac-${n}\\b`).test(titulo);
}

// Escotilla propia (paralela a la de los smokes): sólo para desbloquear a alguien en el medio
// de una story. Deja rastro a los gritos — la salida normal es ejecutar la acción o declararla.
const LEGACY_NO_MUTATION_CHECK = process.env.TYCON_RUNTIME_MATRIX_NO_MUTATION_CHECK === '1';

// Escotilla de emergencia: apaga la clasificación (todo smoke cuenta como RUNTIME).
// Existe por si la clasificación bloquea a alguien del equipo en medio de una story y no hay tiempo
// de declarar `runtime_not_verifiable:`. NO es la salida normal — la salida normal es declarar el
// AC y waivearlo, que deja rastro. Esto no deja ninguno, por eso grita en las warnings.
const LEGACY_SMOKE_KINDS = process.env.TYCON_RUNTIME_MATRIX_LEGACY === '1';

// Ledger de smokes: JSONL {ts, story, acs, cmd, exit, via} escrito por smoke-run.sh.
// Anti-forja: cada entry válida tiene un ESPEJO en ~/.claude/.tycon-pipeline/gates.log
// (append-only, fuera del repo) escrito por el mismo wrapper. Entry sin espejo → no cuenta.
function readSmokeLedger(evidenceDirs, sid, gatesLogPath) {
  const entries = [];
  let mirror = '';
  try { mirror = fs.readFileSync(gatesLogPath, 'utf8'); } catch { /* sin gates.log → nada verifica */ }
  for (const dir of evidenceDirs) {
    const f = path.join(dir, `${sid}-smoke-ledger.jsonl`);
    if (!isFile(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.exit !== 0 || !Array.isArray(e.acs) || e.via !== 'smoke-run.sh') continue;
      // El espejo se matchea POR LÍNEA y la línea tiene que confirmar la corrida COMPLETA:
      // ts + story + acs + `"exit":0`. El ledger del repo es EDITABLE (viaja con el código); el
      // espejo del home no — así que todo campo que gatee un veredicto se confirma contra el
      // espejo, no contra el ledger. Sin eso, editar UN caracter del ledger
      // (`exit` 1→0) forjaría un RUNTIME verde: el flag estaría atado al espejo pero el exit no. Por eso
      // también se atan los acs (cierra la variante «reuso el ts de una corrida legítima con otros
      // acs»), y se filtra en vez de tomar la primera coincidencia, para tolerar dos corridas de la
      // misma story en el mismo segundo.
      const acsStr = `"acs":${JSON.stringify(e.acs)}`;
      const confirmadas = mirror.split('\n').filter((l) =>
        l.includes('"type":"smoke-run"') && l.includes(`"ts":"${e.ts}"`) &&
        l.includes(`"story":"${e.story}"`) && l.includes(acsStr) && l.includes('"exit":0'));
      const mirrored = confirmadas.length > 0;
      // (DODRT-C8) `--mutates` declarado en smoke-run.sh: cuenta SOLO si una línea
      // confirmada del espejo trae el flag. Es la vía de mutación para productos sin superficie
      // HTTP ni navegador.
      const mutatesOk = e.mutates === true && confirmadas.some((l) => l.includes('"mutates":true'));
      // Una línea `"v":2` trae su expectativa y su salida guardada, selladas en el espejo. Es `v:2` si lo
      // dice el registro O el espejo: borrar la marca del registro (que viaja con el código y se edita) no la vuelve
      // una línea vieja. Las líneas sin `v` en los dos lados cuentan como siempre.
      const v2 = e.v === 2 || confirmadas.some((l) => l.includes('"v":2'));
      const salidaProblema = v2 && mirrored ? problemaDeSalida(e, dir, confirmadas) : null;
      // La imagen que el humo guardó con `--capture`, verificada contra el espejo como la salida.
      const imagen = mirrored ? imagenDelHumo(e, dir, confirmadas) : { ruta: null, problema: null };
      entries.push({ ...e, path: f, tsMs: Date.parse(e.ts), mirrored, mutatesOk, evidenceKind: classifyCmd(e.cmd),
        v2, salidaProblema, visual: imagen.ruta, visualProblema: imagen.problema });
    }
  }
  return entries;
}

// Por qué una línea `v:2` no cuenta, o null si cuenta. La salida se busca relativa a la carpeta del
// registro y su sha256 tiene que estar en una línea CONFIRMADA del espejo (fuera del repo); lo mismo la expectativa.
// Con dos corridas en el mismo segundo hay dos líneas confirmadas: alcanza con que UNA calce con las dos cosas.
function problemaDeSalida(e, dir, confirmadas) {
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const espejo = confirmadas.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const rel = typeof e.output === 'string' ? e.output : '';
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return 'salida ausente';
  const abs = path.join(dir, rel);
  if (!isFile(abs)) return 'salida ausente';
  // Sin los `\r` de los finales de línea: la salida viaja por git y un checkout los reescribe (autocrlf en Windows,
  // `eol=lf` en el arnés). smoke-run.sh la sella con `\n`; sin normalizar, un humo legítimo pasaría por editado.
  const deLaSalida = espejo.filter((m) => m.output_sha === sha(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')));
  if (!deLaSalida.length) return 'salida cambiada después de correr';
  const shaDe = (v) => (typeof v === 'string' ? sha(v) : undefined);
  const calza = deLaSalida.some((m) => m.pass_if_sha === shaDe(e.pass_if) && m.fail_if_sha === shaDe(e.fail_if));
  return calza ? null : 'expectativa cambiada después de correr';
}

// ---------------------------------------------------------------- imagen de pantalla

/**
 * ¿Es este AC de pantalla? `@pantalla` en su texto: sí. `@sin-pantalla`: no. Sin marca, el de la story: en una story que
 * cablea interfaz todo AC es de pantalla, en una que no, ninguno. Con las dos marcas hay duda, y la duda es de pantalla.
 */
function esDePantalla(acText, storyEsUi) {
  const t = String(acText || '');
  if (/@pantalla\b/i.test(t)) return true;
  if (/@sin-pantalla\b/i.test(t)) return false;
  return !!storyEsUi;
}

/** Cómo sacar la imagen de un AC: lo que dicen el motivo de la matriz y el aviso de las stories ya en curso. */
function comoSacarLaImagen(n) {
  return `Sacala del sitio de laboratorio (nunca con datos de un cliente): con el E2E, poniendo \`@ac-${n}\` en el título del test ` +
    `que abre la pantalla (el portón guarda su captura y la ata al criterio), o con ` +
    `\`smoke-run.sh <evidence-dir> <ruta-de-la-story.md> --acs ${n} --pass-if '<qué tiene que pasar>' --capture <archivo.png|.webm> -- <comando>\`. ` +
    `Si el criterio no es de pantalla, marcalo \`@sin-pantalla\` en su texto.`;
}

/** El motivo por el que un AC de pantalla no cuenta como probado, con lo que impidió contar una imagen si lo hubo. */
function motivoSinImagen(n, problemas) {
  const porque = problemas && problemas.length ? ` (${problemas.join('; ')})` : '';
  return `falta la captura o la grabación del navegador${porque}. ${comoSacarLaImagen(n)}`;
}

/** La huella de un texto con los finales de línea normalizados (un checkout en Windows los reescribe). */
function shaDeTexto(texto) {
  return crypto.createHash('sha256').update(String(texto).replace(/\r\n/g, '\n')).digest('hex');
}

/** Las huellas de `captures.json` que el portón selló en el gates.log: Set de «<carpeta>|<sha256>». */
function sellosDeCapturas(gatesLogPath) {
  const sellos = new Set();
  let texto = '';
  try { texto = fs.readFileSync(gatesLogPath, 'utf8'); } catch { return sellos; }
  for (const linea of texto.split('\n')) {
    if (!linea.includes('"type":"e2e-captures"')) continue;
    try { const l = JSON.parse(linea); if (l.type === 'e2e-captures') sellos.add(`${l.folder}|${l.sha256}`); } catch { /* línea rota */ }
  }
  return sellos;
}

/**
 * Las imágenes que el portón E2E ató a cada AC: por cada gate fresco, en verde y con su espejo, el índice
 * `<clave>-captures-<ts>/captures.json` que escribe `e2e-evidence.js captures`. El índice cuenta sólo si el gates.log del
 * home (fuera del repo) trae su sello con la misma huella; cada imagen, sólo si es un archivo común, de la carpeta, con
 * extensión de imagen o .webm y su sha256 es el del índice. Suma a los AC que el título de su test nombró con `@ac-N`.
 * Un gate viejo, sin carpeta de capturas, no aporta imágenes y no es un problema; lo demás que no cuenta se dice.
 * → { porAc: Map(AC → [ruta relativa a la carpeta de la evidencia]), problemas: [texto] }.
 */
function imagenesDelE2e(gates, key, sellos) {
  const porAc = new Map();
  const problemas = [];
  for (const g of gates) {
    const dir = path.join(path.dirname(g.path), `${key}-captures-${g.tsRaw}`);
    const carpeta = path.basename(dir);
    if (!isDir(dir)) continue;
    let crudo;
    let index;
    try { crudo = fs.readFileSync(path.join(dir, 'captures.json'), 'utf8'); index = JSON.parse(crudo); } catch (e) {
      // Sin índice no es un índice roto: son capturas de un portón sin esta regla, y se arreglan corriéndolo otra vez.
      problemas.push(e && e.code === 'ENOENT'
        ? `${carpeta} no tiene captures.json: capturas de un portón anterior a la regla del índice. Sus imágenes no cuentan: volvé a correr el portón E2E con los specs de la story.`
        : `captures.json ilegible en ${carpeta}: sus imágenes no cuentan.`);
      continue;
    }
    if (!Array.isArray(index)) { problemas.push(`captures.json de ${carpeta} no es una lista: sus imágenes no cuentan.`); continue; }
    if (!sellos.has(`${carpeta}|${shaDeTexto(crudo)}`)) {
      problemas.push(`captures.json de ${carpeta} sin sello en el espejo (gates.log) o cambiado a mano: sus imágenes no cuentan. Volvé a correr el gate E2E con el filtro de los specs de la story.`);
      continue;
    }
    for (const e of index) {
      const nombre = e && typeof e.file === 'string' ? e.file : '';
      if (!nombre || nombre !== path.basename(nombre) || !VISUAL_E2E_FILE_RE.test(nombre)) {
        problemas.push(`captures.json de ${carpeta}: «${String(nombre).slice(0, 60)}» no es una imagen de la carpeta: no cuenta.`);
        continue;
      }
      const abs = path.join(dir, nombre);
      let st;
      try { st = fs.lstatSync(abs); } catch { problemas.push(`${carpeta}/${nombre} no está en el disco: no cuenta.`); continue; }
      if (!st.isFile() || typeof e.sha256 !== 'string' ||
          crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') !== e.sha256) {
        problemas.push(`${carpeta}/${nombre} no es la imagen que selló el gate (cambiada, o sin huella): no cuenta.`);
        continue;
      }
      for (const n of Array.isArray(e.acs) ? e.acs : []) {
        if (!Number.isInteger(n)) continue;
        if (!porAc.has(n)) porAc.set(n, []);
        porAc.get(n).push(`${carpeta}/${nombre}`);
      }
    }
  }
  return { porAc, problemas };
}

/**
 * La imagen que un humo guardó con `--capture`, o por qué no cuenta. La ruta es relativa a la carpeta del registro y no
 * sale de ella; el archivo existe y es png o webm; y su sha256 es el del registro Y está en una línea CONFIRMADA del
 * espejo (fuera del repo): el registro viaja con el código y se edita, el espejo no.
 * → { ruta, problema }: `ruta` si cuenta; `problema` si el humo trae imagen y no cuenta; ambos null si no trae.
 */
function imagenDelHumo(e, dir, confirmadas) {
  if (typeof e.capture_error === 'string' && e.capture === undefined) return { ruta: null, problema: `la captura no se pudo guardar: ${e.capture_error}` };
  if (e.capture === undefined && e.capture_sha === undefined) return { ruta: null, problema: null };
  const rel = typeof e.capture === 'string' ? e.capture : '';
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !VISUAL_SMOKE_FILE_RE.test(rel)) return { ruta: null, problema: 'ruta de la imagen no válida' };
  const abs = path.join(dir, rel);
  if (!isFile(abs)) return { ruta: null, problema: 'imagen ausente' };
  const sha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  const espejo = confirmadas.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (sha !== e.capture_sha || !espejo.some((m) => m.capture_sha === sha)) return { ruta: null, problema: 'imagen cambiada después de correr' };
  return { ruta: rel, problema: null };
}

/**
 * Cuándo arrancó la story: { ms, fuente, problemas }. `ms` es null si no se sabe (y entonces la regla rige). Primero el
 * dato que pasa quien llama (las pruebas); después el `startedAt` del marcador del pipeline (`<estado>/active/*.json`):
 * se busca por la ruta de la story (con varios, el más antiguo) y por el número sólo si en ese repo hay UN único marcador
 * con ese número; y por último el `created:` de la story, que con la fecha sola cuenta como el final de ese día. `fuente`
 * dice de cuál salió. Un marcador que no se puede leer va en `problemas`.
 */
function arranqueDeLaStory({ startedAt, activeDir, storyPath, repoRoot, sid, fm }) {
  const ms = (v) => { const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(String(v || '')); return Number.isFinite(t) ? t : null; };
  const problemas = [];
  if (startedAt !== undefined && startedAt !== null) return { ms: ms(startedAt), fuente: 'dada por quien llamó', problemas };
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const mia = real(storyPath);
  const delRepo = repoRoot ? real(repoRoot) : null;
  let dePath = null;
  const delNumero = [];
  for (const f of safeReaddir(activeDir).filter((x) => x.endsWith('.json'))) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(activeDir, f), 'utf8')); } catch { problemas.push(`marcador ilegible: ${f}`); continue; }
    if (!m || typeof m !== 'object') { problemas.push(`marcador ilegible: ${f}`); continue; }
    const t = ms(m.startedAt);
    // `pipeline.js start` guarda la ruta relativa al repo: se resuelve contra el repo del marcador.
    const coincidePath = typeof m.storyPath === 'string' && (path.isAbsolute(m.storyPath) || m.repoPath)
      && real(path.isAbsolute(m.storyPath) ? m.storyPath : path.join(m.repoPath, m.storyPath)) === mia;
    if (coincidePath && t !== null && (dePath === null || t < dePath)) dePath = t;
    if (!coincidePath && m.storyId != null && String(m.storyId) === String(sid) && m.repoPath && delRepo && real(m.repoPath) === delRepo) delNumero.push(t);
  }
  if (dePath !== null) return { ms: dePath, fuente: 'el marcador del pipeline', problemas };
  if (delNumero.length === 1 && delNumero[0] !== null) return { ms: delNumero[0], fuente: 'el marcador del pipeline (por el número de la story)', problemas };
  const created = (String(fm || '').match(/^created:\s*["']?([0-9][0-9T:.+\-Z]*)/m) || [])[1];
  if (!created) return { ms: null, fuente: null, problemas };
  // Con la fecha sola no se sabe la hora: cuenta como el final de ese día, para que una story creada el día del corte rija.
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/.test(created);
  return { ms: ms(soloFecha ? `${created}T23:59:59Z` : created), fuente: 'el `created:` de la story', problemas };
}

function compactTsToMs(compact) {
  // 20260710T040445Z → ms
  const m = compact.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function defaultGatesLog() { return path.join(stateDirOf(os.homedir()), 'gates.log'); }

// ---------------------------------------------------------------- core

// Por qué la cadena descartó una firma, dicho en llano (los motivos los da lib/runtime-waiver.js).
const MOTIVO_EN_PALABRAS = {
  json: 'la línea no se puede leer o no tiene la forma de una firma',
  'sin-padre': 'su contenido no coincide con su cadena (la editaron a mano) o la línea de la que colgaba ya no está',
  'padre-posterior': 'cuelga de una línea que quedó más abajo en el archivo',
  'cuelga-de-descartada': 'cuelga de otra línea descartada',
};

/**
 * Las líneas del bloqueo para las firmas descartadas. Las imprimen `marker.js complete-step prepare-commit` y
 * `on-pre-commit.js`: un solo texto, para que los dos digan lo mismo. Vacío si no hay ninguna.
 */
function avisoFirmasDescartadas(r, storyPath) {
  const ds = (r && r.waiverDiscarded) || [];
  if (!ds.length) return [];
  const acs = [...new Set(ds.map((d) => d.ac))].sort((a, b) => a - b);
  const L = [`🟧 firma(s) DESCARTADA(S) por la cadena del registro (existen, pero no cuentan): ${acs.map((n) => '#' + n).join(', ')}`];
  for (const d of ds) L.push(`   AC#${d.ac} — ${d.approvedBy || '(sin nombre)'}${d.ts ? `, ${d.ts}` : ''} · ${d.log}:${d.line} · ${MOTIVO_EN_PALABRAS[d.motivo] || d.motivo}`);
  L.push(`   Volvé a firmar desde tu terminal: node <skill>/scripts/marker.js runtime-waiver ${storyPath}`);
  return L;
}

function compute(opts) {
  // 🔴 storyPath SIEMPRE a absoluto. `discoverWorkspaceRoot` sube por el árbol de directorios, y con
  // un path RELATIVO degenera en silencio: para 'specs/<epic>/<story>.md' llega a basename==='specs'
  // y devuelve `path.dirname(path.dirname('specs'))` === '.', o sea el repo en vez del workspace →
  // `discoverEvidenceDirs` busca la evidencia en '<repo>/<hijo>/.advisors/dod-runtime' y NUNCA
  // encuentra '<repo>/.advisors/dod-runtime'. Resultado: matriz 0/N con la evidencia intacta en disco.
  //
  // `marker.js complete-step prepare-commit` pasa `marker.storyPath`, que `pipeline.js start` guarda RELATIVO al
  // repo: el gate del commit-prep bloquea con la matriz realmente verde, para cualquier dev, en
  // cualquier story. Y como el bloqueo "no tiene bypass para el agente", empuja al waiver TTY o a
  // DOD_BYPASS — o sea, degrada justo el gate que existe para no degradarse. Con el path relativo el
  // gate da ROJA 0/8 y con el absoluto VERDE 8/8, sobre exactamente la misma evidencia.
  const storyPath = opts.storyPath ? path.resolve(opts.storyPath) : opts.storyPath;
  if (!storyPath || !isFile(storyPath)) {
    return { structuralError: `story ilegible: ${storyPath}` };
  }
  const { content, fm } = readStory(storyPath);
  const sid = storyIdFrom(fm, storyPath);

  if (/^dod_runtime_exempt:\s*true\b/m.test(fm)) {
    // el repo y los totales también en la exenta: el candado de la guía QA busca las pantallas desde
    // `repoRoot` y el generador de la guía lee `stats`; sin ellos, «la pantalla no está en el disco» y un TypeError
    const repoRoot = opts.repoRoot ? path.resolve(opts.repoRoot) : discoverRepoRoot(storyPath);
    const stats = { total: 0, runtime: 0, notRun: 0, sinImagen: 0, accionNoEjercida: 0, notVerifiable: 0, waived: 0, exentosC8: 0 };
    return { sid, exempt: true, green: true, hash: 'exempt', perAc: {}, warnings: [], avisos: [], sinImagen: [], acs: [], repoRoot, stats };
  }
  // La CLAVE de la evidencia. Si no se puede decidir —no se pudo recorrer el repo entero para
  // saber si el número se repite— la matriz NO adivina: es un error estructural (fail-closed).
  let keyInfo;
  // `keyStoryPath`: la ruta REAL de la story cuando `storyPath` es una copia (el freno del commit computa sobre
  // el contenido staged, escrito a un temporal): el repo, las hermanas y el tema salen de la real.
  try { keyInfo = evidenceKeyLib.evidenceKey(opts.keyStoryPath || storyPath, { id: sid }); } catch (e) {
    return { sid, structuralError: `no pude calcular la clave de la evidencia de la story: ${e.message}` };
  }
  const evKey = keyInfo.key;

  // Parsers compartidos con mech-check — fuente única (lib/story-checks.js).
  const sc = require(path.join(__dirname, 'lib', 'story-checks.js'));
  const acsFromSpec = sc.parseAcsFromSpec(content);
  // Texto de cada AC — para que el waiver le pueda MOSTRAR al usuario qué está aprobando, no sólo la
  // excusa de por qué no se puede correr. Best-effort: si no se puede aislar, se omite.
  // 🔴 NO entra al `hash`: el hash pinnea veredictos y evidencia, y una coma en la redacción del AC no
  // puede invalidar un waiver que el usuario ya dio sobre el mismo estado del código.
  const acTexts = sc.acTextsFromSpec(content);
  // La marca `@runtime-exempt(DODRT-C8)` se lee del texto ENTERO del AC: el de arriba se corta a 600 caracteres
  // y una marca al final de un AC largo se perdería en silencio.
  const acTextsEnteros = sc.acTextsFromSpec(content, { maxChars: Infinity });
  const table = sc.parseTestsTable(content);

  // Universo de ACs = sección AC ∪ columna AC de la tabla (defensa contra parsers que
  // subcuenten: la tabla es el contrato de cobertura y también vota).
  const acSet = new Set(acsFromSpec);
  for (const r of table.rows) for (const n of r.acRefs) acSet.add(n);

  // Tandas declaradas BLOQUEADAS (story-format §1.1): los `acs_pending` de un pipeline con
  // `status: blocked` se EXCLUYEN del universo — su superficie no existe todavía por
  // definición (blocked_by lo documenta), así que "correrlos" es imposible y contarlos como
  // NOT-RUN bloquearía el commit-prep de toda story multi-tanda (p. ej. el frontend de una tanda
  // bloqueada hasta mergear el backend). SOLO `blocked` a propósito:
  // una tanda `pending` puede ser exactamente la que se está entregando en ESTE run, y
  // excluirla vaciaría el gate. La exclusión queda visible en `blockedAcs` + warning.
  // Lo declarado no alcanza: si el commit (o la corrida, desde `opts.baseSha`) cambia un archivo de pantalla de una
  // tanda bloqueada, sus criterios vuelven a la matriz, con la misma regla que la baja de la pantalla
  // (`ui-signal.js → blockedScreenTouched`). `opts.changed` da la lista; sin ella sale de git.
  const repoRoot = opts.repoRoot ? path.resolve(opts.repoRoot) : discoverRepoRoot(storyPath);
  const uiSignal = require(path.join(__dirname, 'lib', 'ui-signal.js'));
  const changed = Array.isArray(opts.changed) ? opts.changed : (repoRoot ? uiSignal.changedFiles(repoRoot, opts.baseSha) : null);
  const touched = uiSignal.blockedScreenTouched(content, repoRoot, changed);
  const blockedAcs = new Set();
  const blockedByPipeline = [];
  const blockedBack = [];
  for (const p of sc.parsePipelinesBlock(content)) {
    if (p.status === 'blocked' && p.acsPending.length && touched.names.includes(p.name)) {
      blockedBack.push(`${p.name || '(sin nombre)'}: ACs ${p.acsPending.join(',')}`);
    } else if (p.status === 'blocked' && p.acsPending.length) {
      for (const n of p.acsPending) blockedAcs.add(n);
      blockedByPipeline.push(`${p.name || '(sin nombre)'}: ACs ${p.acsPending.join(',')}`);
    }
  }
  const acs = [...acSet].filter((n) => !blockedAcs.has(n)).sort((a, b) => a - b);

  if (acs.length === 0) {
    return { structuralError: `story sin ACs parseables ni tabla ### Tests con columna AC: ${storyPath}` };
  }

  const warnings = [];
  // Avisos que no bloquean: un AC de pantalla sin imagen en una story que arrancó antes del corte.
  const avisos = [];
  if (blockedBack.length) {
    const lista = touched.screens.slice(0, 3).join(', ') + (touched.screens.length > 3 ? '…' : '');
    warnings.push(`ACs de tanda blocked que VUELVEN al gate porque el commit cambia su pantalla (${lista}): ${blockedBack.join(' · ')}.`);
  }
  if (blockedAcs.size) {
    warnings.push(`ACs EXCLUIDOS del gate por tanda blocked (deuda declarada con blocked_by, no "sin correr"): ${blockedByPipeline.join(' · ')}. Se re-incorporan solos cuando esa tanda deje de estar blocked.`);
  }
  if (acsFromSpec.length !== acs.length) {
    const onlyTable = acs.filter((n) => !acsFromSpec.includes(n));
    // 🔴 La redacción importa: un aviso que dice "revisar formato de la story" culpa a la story.
    // Si la causa es el PARSER (que no ve ACs de la sección), el aviso tiene que apuntar al parser.
    // Un aviso que apunta al lugar equivocado es peor que no tenerlo: consume la atención y la manda
    // al lado contrario.
    if (onlyTable.length) warnings.push(`ACs que aporta SOLO la tabla de Tests, no la sección AC: ${onlyTable.join(', ')}. La cobertura de acá abajo los incluye igual (la tabla también vota). Antes de tocar la story, descartar que sea el parser: \`node -e "console.log(require('~/.claude/agent-skills/skills/tycon-pipeline/scripts/lib/story-checks.js').parseAcsFromSpec(require('fs').readFileSync('<story>','utf8')))"\` — si eso cuenta menos ACs de los que la sección declara a simple vista, el bug es del parser, no del formato.`);
  }

  const wsRoot = opts.workspaceRoot || discoverWorkspaceRoot(storyPath);
  // Atribución: la evidencia sale del repo git que CONTIENE la story +
  // companions declarados. `opts.repoRoot` existe para el caller que computa sobre una COPIA
  // tmp del spec (on-pre-commit.js, contenido staged) — ahí la discovery desde el path no ve
  // el repo real y sin el opt degradaría a fail-closed con la evidencia intacta en disco.
  const evCfg = parseEvidenceConfig(repoRoot);
  const fePaths = evCfg.fePaths;
  // Cada hermano declarado cuenta también en su worktree de la rama de la story: es el mismo repo, y es donde el portón
  // lo corre (lib/companion-repos.js). Sin esto, su evidencia saldría «de un repo NO declarado» y no contaría.
  const companionLib = require(path.join(__dirname, 'lib', 'companion-repos.js'));
  const rama = repoRoot ? companionLib.ramaDe(repoRoot) : null;
  const enRama = rama ? evCfg.roots.map((r) => companionLib.enLaMismaRama(companionLib.real(r), rama, /\d/.test(sid) ? sid : null)) : [];
  const evidenceRoots = repoRoot ? [...new Set([repoRoot, ...evCfg.roots, ...enRama])] : [];
  for (const miss of evCfg.missing) {
    warnings.push(`companion_repo declarado en .tycon/advisors.yaml pero INEXISTENTE: ${miss} — no aporta evidencia (¿typo o repo sin clonar?).`);
  }
  if (evCfg.blockPresent && !evCfg.roots.length && !evCfg.missing.length && !evCfg.fePaths.length) {
    warnings.push('⚠️ .tycon/advisors.yaml tiene bloque `evidence:` pero el parser le sacó 0 entradas — la config está siendo IGNORADA. Revisá el formato: listas block (`- item`, mismo indent o más que la key) o flow (`companion_repos: [A, B]`).');
  }
  if (!repoRoot && !(opts.evidenceDirs && opts.evidenceDirs.length)) {
    warnings.push(`⛔ no pude determinar el repo git que contiene la story (${storyPath}) — sin repo no hay atribución segura: NINGUNA evidencia cuenta (fail-closed). Corré con --evidence-dir si la atribución la garantiza el caller.`);
  }
  const evidenceDirs = opts.evidenceDirs && opts.evidenceDirs.length
    ? opts.evidenceDirs
    : evidenceRoots.flatMap(evidenceDirsUnder);
  // Evidencia que reclama esta story en repos hermanos NO declarados: no cuenta, y se dice.
  // Sólo con repo determinado: sin repoRoot el fail-closed de arriba ya
  // aplica, y el scan con allowedRoots vacío acusaría al PROPIO repo como "NO declarado".
  const excluded = repoRoot ? scanExcludedClaims(path.dirname(repoRoot), evidenceRoots, evKey) : [];
  if (excluded.length) {
    warnings.push(`🚫 evidencia que reclama la story ${sid} encontrada en repos NO declarados: ${excluded.join(', ')} — NO cuenta. La evidencia sale del repo que contiene la story; si un hermano es parte del MISMO producto (FE/BE separados), declaralo en .tycon/advisors.yaml → evidence.companion_repos.`);
  }
  const gatesLogPath = opts.gatesLogPath || path.join(stateDirOf(os.homedir()), 'gates.log');

  // Staleness: último edit de CÓDIGO de los archivos declarados por la story, por lado.
  // Los paths del frontmatter vienen repo-relativos (ej. `mcp/src/...`) o ws-relativos
  // (ej. `<producto>/src/...`) — se prueba contra ambos roots y gana el que EXISTE. Resolver sólo
  // contra el workspace deja mtime=0 para los repo-relativos: el chequeo de frescura queda ciego
  // y los gates viejos cuentan.
  const declared = frontmatterFileList(fm).filter((f) => CODE_FILE_RE.test(f));
  let maxCodeMtime = 0; let maxCodeFile = null;
  const kindMtime = { fe: 0, be: 0 };
  for (const rel of declared) {
    const candidates = [repoRoot, wsRoot].filter(Boolean).map((r) => path.join(r, rel));
    const abs = candidates.find(isFile) || candidates[0] || rel;
    const mt = mtimeMs(abs);
    if (mt > maxCodeMtime) { maxCodeMtime = mt; maxCodeFile = rel; }
    const kind = kindOf(rel, fePaths);
    if (mt > kindMtime[kind]) kindMtime[kind] = mt;
  }

  // --- evidencia runtime 1: gates E2E (frescura BLOQUEANTE + espejo en gates.log OBLIGATORIO)
  const allGates = readE2eGates(evidenceDirs, evKey, gatesLogPath, storyPath);
  // Un PASS con pruebas apagadas, o que no dice cuántas, no da la evidencia por completa: el verde puede ser
  // «se corrió una de diez». Se nombra y no cuenta; con cero, como siempre.
  const passCompleto = (g) => g.skipped === 0;
  for (const g of allGates.filter((x) => x.verdict === 'PASS' && x.ts >= maxCodeMtime && x.mirrored && !passCompleto(x))) {
    warnings.push(g.skipped === null
      ? `Gate E2E ${path.basename(g.path)}: PASS que no informa cuántas pruebas se apagaron → no otorga evidencia completa. Re-corré el gate del arnés (anota \`- skipped: N\`) o agregá la línea al gate del repo.`
      : `Gate E2E ${path.basename(g.path)}: PASS con ${g.skipped} prueba(s) apagada(s) → no otorga evidencia completa. Prendé esas pruebas y re-corré el gate, o sacá del filtro el spec que las tiene.`);
  }
  const freshPassGates = allGates.filter((g) => g.verdict === 'PASS' && g.ts >= maxCodeMtime && g.mirrored && passCompleto(g));
  for (const g of allGates.filter((x) => x.verdict === 'PASS' && x.ts < maxCodeMtime)) {
    warnings.push(`Gate E2E ${path.basename(g.path)} es ANTERIOR al último edit de código (${maxCodeFile}) → NO cuenta. Re-corré el gate (scoped, barato).`);
  }
  for (const g of allGates.filter((x) => x.verdict === 'PASS' && x.ts >= maxCodeMtime && !x.mirrored)) {
    warnings.push(`Gate E2E ${path.basename(g.path)} SIN espejo run-check en gates.log → NO cuenta (¿se escribió a mano en vez de correrse vía 'marker.js run-check dod -- bash <gate> ...'?).`);
  }

  // --- evidencia runtime 2: smoke ledger (frescura bloqueante por entry)
  const ledger = readSmokeLedger(evidenceDirs, evKey, gatesLogPath);
  // La evidencia VIEJA de un número repetido (`<id>-*`): no cuenta para ninguna story —pertenecer es
  // explícito y esos archivos no dicen a cuál— y no se toca. Se NOMBRA, con su ruta.
  const orphans = evidenceKeyLib.legacyFiles(evidenceDirs, keyInfo);
  const freshSmokes = ledger.filter((e) => e.mirrored && !e.salidaProblema && e.tsMs >= maxCodeMtime);
  for (const e of ledger.filter((x) => !x.mirrored)) {
    warnings.push(`Smoke ledger entry ${e.ts} SIN espejo en gates.log → no cuenta (¿se escribió a mano en vez de vía smoke-run.sh?).`);
  }
  // Un humo `v:2` sin su salida intacta no cuenta: «verificado corriendo» tiene que poder mostrarse.
  for (const e of ledger.filter((x) => x.mirrored && x.salidaProblema)) {
    warnings.push(`Smoke ${e.ts} (AC ${e.acs.join(',')}): ${e.salidaProblema} → no cuenta. ` +
      (e.salidaProblema === 'salida ausente'
        ? 'El humo no dejó su salida guardada (o se borró): re-correlo vía smoke-run.sh.'
        : 'Lo que quedó en el repo no es lo que selló el espejo al correr: re-correlo vía smoke-run.sh, no edites la evidencia.'));
  }
  for (const e of ledger.filter((x) => x.mirrored && x.tsMs < maxCodeMtime)) {
    warnings.push(`Smoke ${e.ts} anterior al último edit de código → no cuenta. Re-correlo vía smoke-run.sh.`);
  }
  // La imagen del humo que no es la que se selló al correr no cuenta: el humo sigue valiendo, sin imagen.
  for (const e of ledger.filter((x) => x.mirrored && x.visualProblema)) {
    warnings.push(`Smoke ${e.ts} (AC ${e.acs.join(',')}): ${e.visualProblema} → la imagen no cuenta. ` +
      (e.capture_error !== undefined ? 'Re-correlo vía smoke-run.sh --capture con una imagen que sirva.'
        : 'Lo que quedó en el repo no es lo que selló el espejo al correr: re-correlo vía smoke-run.sh --capture, no edites la evidencia.'));
  }
  // Un smoke que NO ejercita la app no es evidencia runtime — se dice fuerte y con el comando a la
  // vista, porque el modo de falla que esto ataca es precisamente que pasara inadvertido.
  for (const e of freshSmokes.filter((x) => x.evidenceKind !== 'app-run')) {
    warnings.push(
      // El comando sale tapado: la matriz se escribe en `.advisors/dod-runtime/`, que viaja por git, y un registro
      // escrito sin el tapado de lib/smoke-secrets.js puede traer la contraseña tal cual.
      `Smoke ${e.ts} NO ejercita la app (${e.evidenceKind}): \`${smokeSecrets.truncate(smokeSecrets.redact(e.cmd).text, 90)}\` → cuenta como evidencia de CÓDIGO, no de runtime. ` +
      `Los AC ${e.acs.join(',')} necesitan una corrida real (curl/sonda contra la app) o declararse \`runtime_not_verifiable:\` con su \`covered_by:\`.`,
    );
  }
  if (LEGACY_SMOKE_KINDS) {
    warnings.push('🚨 TYCON_RUNTIME_MATRIX_LEGACY=1 — todo smoke cuenta como RUNTIME sin mirar el comando. Es el bug que este gate vino a arreglar: la matriz PUEDE estar mintiendo. Sacá la variable en cuanto puedas.');
  }

  // --- imagen de pantalla: de qué AC es cada captura o grabación que la matriz ya puede contar
  const imagenesE2e = imagenesDelE2e(freshPassGates, evKey, sellosDeCapturas(gatesLogPath));
  for (const m of imagenesE2e.problemas) avisos.push(m);
  const storyEsUi = uiSignal.storyTouchesUi(content, repoRoot);

  // --- evidencia código: tests-result.json (staleness = WARNING: regenerar es full
  //     suite, y la full suite corre SOLO en el merge-gate por regla del equipo)
  const testsResults = readTestsResults(opts.testsResults && opts.testsResults.length ? opts.testsResults : evidenceRoots.flatMap(testsResultsUnder), fePaths);
  const greenByKind = { fe: null, be: null };
  for (const tr of testsResults) {
    if (!tr.green) continue;
    if (!greenByKind[tr.kind] || tr.ts > greenByKind[tr.kind].ts) greenByKind[tr.kind] = tr;
  }
  for (const kind of ['fe', 'be']) {
    const tr = greenByKind[kind];
    if (tr && kindMtime[kind] > tr.ts) {
      warnings.push(`tests-result (${kind}) es anterior al último edit de código ${kind} — sigue contando (full suite = solo merge-gate), pero el merge-gate DEBE regenerarlo.`);
    }
    if (tr && tr.storyId && tr.storyId !== sid) {
      warnings.push(`tests-result (${kind}) es de OTRA story (${tr.storyId}) — cuenta como suite verde global, pero regeneralo para ${sid} en el merge-gate.`);
    }
  }
  // Con UNA sola suite verde en el scope, cubre las filas de ambos lados: el split fe/be existe
  // para monorepos con DOS suites. Adivinar el lado por el NOMBRE del test dejaría filas sin
  // evidencia con la suite del propio repo verde al lado (`foo.test.js` matchea el hint FE →
  // buscaría una suite "fe" que en un repo backend-only no existe).
  // 🔴 El fallback SOLO aplica si el lado de la fila NO tiene suite propia: greenByKind filtra los
  // rojos antes, así que "una sola suite verde" sería indistinguible de "dos suites y la del lado de
  // la fila EN ROJO" — y la verde del otro lado validaría el `covered_by` de un AC cuyo propio lado
  // está roto (waiveable cuando debía bloquear). Por eso los kinds presentes se computan ANTES del
  // filtro por verde.
  const kindsPresent = new Set(testsResults.map((t) => t.kind));
  const soloTr = greenByKind.fe && greenByKind.be ? null : (greenByKind.fe || greenByKind.be);

  // --- clasificar cada fila de la tabla
  const rowEvidence = table.rows.map((r) => {
    const nivel = r.nivel || '';
    if (RUNTIME_NIVEL_RE.test(nivel)) {
      const specToken = (r.name.match(/([\w.-]+\.spec\.[tj]s)/) || [])[1] || null;
      const gate = freshPassGates.find((g) => g.specFilters.some((sf) =>
        r.name.includes(sf) || r.raw.includes(sf) || (specToken && sf.includes(specToken))));
      return { row: r, tier: gate ? 'runtime' : 'none', ref: gate ? path.basename(gate.path) : null };
    }
    const kind = kindOf(r.name, fePaths);
    const tr = greenByKind[kind] || (kindsPresent.has(kind) ? null : soloTr);
    return { row: r, tier: tr ? 'code' : 'none', ref: tr ? `${path.basename(path.dirname(path.dirname(tr.path)))}/tests-result.json` : null };
  });

  // --- veredicto por AC
  const perAc = {};
  const exenciones = [];   // usos de @runtime-exempt(DODRT-C8) — se cuentan y se muestran
  for (const n of acs) {
    const runtime = [];
    const code = [];
    // De qué fuente sale cada evidencia, sin parsear los textos de arriba: lo lee el freno del commit para sumar las
    // tres fuentes por AC (lib/closing-evidence.js → coberturaDeLaUnion). No entra al `hash`.
    const fuentes = { e2e: [], smoke: [] };
    for (const re of rowEvidence) {
      if (!re.row.acRefs.includes(n)) continue;
      if (re.tier === 'runtime') { runtime.push(`${re.row.tid} (${re.ref})`); fuentes.e2e.push(re.ref); }
      else if (re.tier === 'code') code.push(`${re.row.tid} (${re.ref})`);
    }
    for (const e of freshSmokes) {
      if (!e.acs.includes(n)) continue;
      fuentes.smoke.push(e.ts);
      // Un smoke sólo cuenta como evidencia RUNTIME si su comando ejercita la app. Si fue
      // `node --test` o un gate de build, es evidencia de CÓDIGO — legítima, pero de otra clase:
      // el AC cae a NOT-VERIFIABLE/NOT-RUN y pasa por el camino explícito (declaración +
      // waiver del usuario) en vez de colarse como 🟢 RUNTIME.
      if (e.evidenceKind === 'app-run' || LEGACY_SMOKE_KINDS) runtime.push(`smoke ${e.ts}`);
      else code.push(`smoke ${e.ts} (${e.evidenceKind})`);
    }
    let verdict = runtime.length ? 'RUNTIME' : code.length ? 'CODE-ONLY' : 'SIN-EVIDENCIA';

    // DODRT-C8: un AC que describe una ACCIÓN necesita evidencia de que la acción se EJECUTÓ,
    // no de que la pantalla se vio. Ver el bloque de la regla arriba.
    let mutacion = null;
    // La marca se parsea SIEMPRE (incluso si el AC no llegó a RUNTIME): una marca sin motivo
    // tiene que avisarse igual, si no el autor se entera recién cuando le bloquea otra cosa.
    const ex = parseExencionC8(acTextsEnteros[n] != null ? acTextsEnteros[n] : acTexts[n]);
    if (ex.marcada) exenciones.push({ ac: n, valida: ex.valida, motivo: ex.motivo });
    // La clasificación mira el mismo texto de siempre (los primeros 600), sin la marca.
    if (verdict === 'RUNTIME' && !ex.valida && acEsDeAccion(parseExencionC8(acTexts[n]).texto) && !LEGACY_NO_MUTATION_CHECK) {
      const porTitulo = freshPassGates
        .flatMap((g) => (g.titulos || []).map((t) => ({ t, g })))
        .find(({ t }) => tituloEjerceAc(t, n));
      const porSmoke = freshSmokes.find((e) => e.acs.includes(n) && e.evidenceKind === 'app-run' && cmdMutates(e.cmd));
      const porDeclarado = freshSmokes.find((e) => e.acs.includes(n) && e.evidenceKind === 'app-run' && e.mutatesOk === true);
      if (porTitulo) mutacion = `test @mutates: "${porTitulo.t}"`;
      else if (porSmoke) mutacion = `smoke con escritura ${porSmoke.ts}`;
      else if (porDeclarado) mutacion = `smoke declarado --mutates ${porDeclarado.ts} (exit 0 vía smoke-run.sh, espejo verificado)`;
      else verdict = 'RUNTIME-PARCIAL';
    }
    // ¿Es un AC de pantalla, y qué imágenes tiene? Las del portón E2E atadas por `@ac-N` y las de los humos
    // que la matriz ya cuenta como corrida de la app.
    const pantalla = esDePantalla(acTextsEnteros[n] != null ? acTextsEnteros[n] : acTexts[n], storyEsUi);
    const visual = [...(imagenesE2e.porAc.get(n) || [])];
    const visualProblemas = [];
    for (const e of freshSmokes) {
      if (!e.acs.includes(n) || !(e.evidenceKind === 'app-run' || LEGACY_SMOKE_KINDS)) continue;
      if (e.visual) visual.push(e.visual);
      else if (e.visualProblema) visualProblemas.push(`humo ${e.ts}: ${e.visualProblema}`);
    }
    // `pantalla` y `visual` sólo viajan en los AC de pantalla: un AC que no lo es no cambia de forma.
    perAc[n] = { verdict, runtime, code, text: acTexts[n] || null, mutacion,
      exentoC8: ex.valida ? ex.motivo : null, fuentes,
      ...(pantalla ? { pantalla, visual, ...(visualProblemas.length ? { visualProblemas } : {}) } : {}) };
    // Qué esperaba cada humo `v:2` del AC y dónde está lo que salió. Va aparte y NO entra al hash: las
    // líneas sin `v:2` dan exactamente la misma matriz que sin esta parte.
    const expectativas = freshSmokes.filter((e) => e.v2 && e.acs.includes(n))
      .map((e) => ({ ts: e.ts, pasaSi: e.pass_if, fallaSi: e.fail_if, output: e.output }));
    if (expectativas.length) perAc[n].expectativas = expectativas;
  }

  // --- hash anti-drift: pinnea (ACs + veredictos + refs de evidencia). El waiver guarda
  //     este hash; si cambia el código (la staleness altera qué evidencia cuenta) o la
  //     evidencia, el hash cambia y el waiver viejo se invalida.
  const hashInput = JSON.stringify({
    sid,
    perAc: acs.map((n) => [n, perAc[n].verdict, perAc[n].runtime, perAc[n].code]),
  });
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 12);

  // --- waiver USER-ONLY.
  // Un AC pendiente (sin evidencia runtime) sólo se perdona si el USUARIO lo waiveó desde
  // su terminal (marker.js runtime-waiver → lib/runtime-waiver.js, TTY-only). El agente NO
  // puede producir un waiver válido: no tiene /dev/tty. El waiver se pinnea al `hash` actual
  // → si el código/evidencia cambian, el hash cambia y el waiver deja de aplicar solo.
  // 🔴 El waiver engancha por la DECLARACIÓN del AC (razón + test que lo cubre), no sólo por el
  // `hash`. El hash pinnea la evidencia, que vive en `.advisors/` (gitignoreado): en otra máquina o
  // en CI no existe, el hash da distinto y la aprobación del humano se perdería.
  // La declaración vive en la story, viaja con el repo y es igual en toda máquina. Ver
  // `lib/runtime-waiver.js` §declHashFor.
  const declListParaWaiver = parseNotVerifiable(fm);
  let waived = new Set();
  let chain = { ok: true, brokenAt: -1, total: 0 };
  // Las firmas de ESTA story que la cadena descartó. Se mira la cadena del registro de la HOME y la del
  // repo, y lo descartado se dice: si no, «Preparar el commit» diría «esperan waiver» sin aclarar que el dev ya firmó.
  let descartadas = { acs: [], lines: [] };
  try {
    const waiverLib = require(path.join(__dirname, 'lib', 'runtime-waiver.js'));
    const declHashByAc = {};
    for (const d of declListParaWaiver) declHashByAc[d.ac] = waiverLib.declHashFor(d.reason, d.coveredBy);
    // Por la CLAVE: la aprobación anota `story: <clave>`. Con número único es el número de siempre
    // y las firmas vigentes siguen valiendo; con número repetido, la de otra story del mismo número no aplica
    // aunque su declaración diga lo mismo. Las viejas (`story: <número>`) no dicen de cuál son: no cuentan y se nombran.
    waived = waiverLib.waivedAcs(evKey, { matrixHash: hash, declHashByAc, repoRoot });
    descartadas = waiverLib.discardedFor(evKey, { matrixHash: hash, declHashByAc, repoRoot });
    chain = { ok: descartadas.lines.length === 0 };
    if (evKey !== sid) {
      const viejas = waiverLib.waivedAcs(sid, { matrixHash: hash, declHashByAc, repoRoot });
      if (viejas.size) {
        warnings.push(`aprobación vieja de la matriz para AC ${[...viejas].sort((a, b) => a - b).join(',')} firmada con el número ${sid} solo: ` +
          `ese número lo comparten varias stories de este repo y la firma no dice de cuál es → no cuenta (no se tocó). ` +
          `Si sigue valiendo para esta story, se vuelve a aprobar: marker.js runtime-waiver ${storyPath}`);
      }
    }
  } catch (e) {
    warnings.push(`no pude leer waivers TTY (${e.message}) — ningún AC se perdona.`);
  }
  // Por AC: la firma existe pero se descartó. Sólo si el AC sigue sin aprobar (una copia rota de una firma que vale
  // no pide nada) — y `discardedFor` ya dejó afuera las de una declaración vieja.
  // (el filtro por veredicto —sólo un AC que de verdad espera firma— va más abajo, cuando ya están los veredictos)
  const storyParaFirmar = opts.keyStoryPath ? path.resolve(opts.keyStoryPath) : storyPath;
  if (!chain.ok) {
    const donde = descartadas.lines.map((l) => `${l.log}:${l.line} (${MOTIVO_EN_PALABRAS[l.motivo] || l.motivo})`).join(' · ');
    warnings.push(`🚨 el registro de firmas tiene ${descartadas.lines.length} línea(s) de esta story descartada(s) por la cadena: ${donde}. ` +
      `No cuentan, ni lo que cuelga de ellas; las demás firmas sí. Causa probable: una edición a mano del registro.`);
  }
  // --- clasificación en DOS categorías: distinguir
  // "materialmente imposible de verificar corriendo la app" (declarado por-AC en la story,
  // waiveable por el usuario) de "no corrido todavía" (NO waiveable — obliga a correrlo).
  // Quién decide cuál es cuál no sale de la PROSA del agente, que es un canal poco confiable. Así:
  //   NOT-VERIFIABLE  → el AC está declarado en `runtime_not_verifiable` Y tiene un test que lo
  //                     cubre (evidencia de código). Elegible para waiver del usuario.
  //   NOT-RUN         → sin evidencia runtime y NO declarado imposible (o declarado pero SIN test
  //                     que lo cubra = declaración inválida). BLOQUEA. NO se puede waivear.
  const declList = parseNotVerifiable(fm);
  const declMap = new Map(declList.map((d) => [d.ac, d]));

  // DODRT-C8 — diagnóstico del CONTRATO del gate: si hay ACs de acción sin cerrar y el gate
  // que corrió no escribió la sección de títulos, la causa más probable no es que falte el
  // test sino que el script del repo esté desactualizado. Decirlo con el fix exacto evita el
  // peor resultado: que alguien lea "no ejecutaste la acción" cuando sí la ejecutó.
  if (acs.some((n) => perAc[n].verdict === 'RUNTIME-PARCIAL')) {
    const gateSinTitulos = freshPassGates.find((g) => !g.titulos || g.titulos.length === 0);
    if (gateSinTitulos) {
      warnings.push(
        `⚠️ El gate E2E que corrió (${path.basename(gateSinTitulos.path)}) NO escribió la sección ` +
        `"## Tests corridos" en su evidencia, así que no se puede saber qué tests ejercieron cada AC. ` +
        `Si tu repo tiene su propio script de gate, agregale esa sección (los títulos de los tests que ` +
        `pasaron, uno por línea con "- "), o sacá el \`gate:\` de .tycon/advisors.yaml para usar el gate ` +
        `genérico del harness (scripts/e2e-gate.sh), que ya cumple el contrato.`,
      );
    }
  }

  // DODRT-C8: los PARCIALES declarados imposibles pasan por el camino del humano (waiver);
  // el resto queda bloqueando con su mensaje propio.
  for (const n of acs) {
    if (perAc[n].verdict !== 'RUNTIME-PARCIAL') continue;
    warnings.push(
      `AC#${n} describe una ACCIÓN pero ninguna evidencia muestra que se haya EJECUTADO ` +
      `(la corrida sólo observó la pantalla). Cerralo con un test del gate E2E titulado ` +
      `\`@mutates ... @ac-${n}\` que ejecute la acción, con un smoke que escriba ` +
      `(POST/PUT/PATCH/DELETE) vía smoke-run.sh, o con \`smoke-run.sh --mutates\` si el producto ` +
      `no tiene superficie HTTP (la garantía es el exit code). Si es materialmente imposible, declaralo en ` +
      `runtime_not_verifiable con su test y que lo apruebe el usuario.`,
    );
    if (declMap.has(n) && perAc[n].code.length > 0) {
      perAc[n].verdict = 'NOT-VERIFIABLE';
      const d = declMap.get(n);
      perAc[n].declReason = d.reason || '(sin razón declarada)';
      perAc[n].coveredBy = d.coveredBy || null;
    }
  }

  for (const n of acs) {
    if (perAc[n].verdict === 'RUNTIME' || perAc[n].verdict === 'RUNTIME-PARCIAL') continue;
    const decl = declMap.get(n);
    if (decl && perAc[n].code.length > 0) {
      perAc[n].verdict = 'NOT-VERIFIABLE';
      perAc[n].declReason = decl.reason || '(sin razón declarada)';
      perAc[n].coveredBy = decl.coveredBy || null;
    } else if (decl) {
      // declarado imposible PERO sin test que lo cubra → declaración inválida (no se puede
      // afirmar "lo cubre un test" cuando no hay ninguno). Se degrada a NOT-RUN.
      perAc[n].verdict = 'NOT-RUN';
      warnings.push(`AC#${n} está declarado 'runtime_not_verifiable' pero NINGÚN test lo cubre — declaración inválida; se trata como NO-CORRIDO (bloquea, no se puede waivear).`);
    } else {
      perAc[n].verdict = 'NOT-RUN';
    }
  }

  // El waiver SÓLO promueve NOT-VERIFIABLE → WAIVED-USER. Un NOT-RUN waiveado se ignora
  // (el usuario no puede saltear algo que el agente simplemente no corrió).
  for (const n of acs) {
    if (perAc[n].verdict === 'NOT-VERIFIABLE' && waived.has(n)) perAc[n].verdict = 'WAIVED-USER';
  }
  for (const n of acs) {
    if (perAc[n].verdict === 'NOT-RUN' && waived.has(n)) {
      warnings.push(`AC#${n} tiene un waiver pero NO está declarado imposible — un waiver no puede saltear un AC no-corrido. Corrélo (E2E/smoke) o declaralo en runtime_not_verifiable con su test.`);
    }
  }

  // --- constancia de las exenciones DODRT-C8. Se avisa SIEMPRE que se usen: el valor del
  //     mecanismo es que cada uso quede a la vista, no que sea cómodo.
  for (const e of exenciones) {
    if (e.valida) {
      warnings.push(`AC#${e.ac}: verbo de mutación exento por declaración @runtime-exempt(DODRT-C8) — «${e.motivo}». Esto NO levanta la verificación runtime del AC: sólo declara que el verbo no describe una acción. Si el AC sí muta, sacá la marca.`);
    } else {
      warnings.push(`AC#${e.ac}: @runtime-exempt(DODRT-C8) SIN motivo (o demasiado corto) — NO cuenta, el AC se sigue clasificando normal. El motivo es obligatorio: escribí por qué el verbo no es una acción, ej. \`@runtime-exempt(DODRT-C8): "iniciar" es el nombre del endpoint; el AC verifica el 403\`.`);
    }
  }
  const exentosValidos = exenciones.filter((e) => e.valida);
  if (exentosValidos.length >= 3) {
    warnings.push(`🔴 ${exentosValidos.length} ACs exentos de DODRT-C8 en una misma story (AC ${exentosValidos.map((e) => '#' + e.ac).join(', ')}). Puede ser legítimo —una story enteramente de lectura lo es—, pero es también la forma que tendría el abuso: revisá que ninguno de esos ACs describa algo que el usuario HACE.`);
  }

  // --- imagen de pantalla. Va DESPUÉS de la reclasificación de arriba, para que un AC que corrió y no tiene
  // imagen no se convierta en NOT-RUN. Sólo mira lo que quedó RUNTIME (o RUNTIME-PARCIAL): un AC declarado imposible de
  // verificar corriendo no pide imagen. Las stories que arrancaron antes del corte reciben un aviso y no bloquean.
  const visualFrom = Date.parse(opts.visualFrom || VISUAL_EVIDENCE_FROM);
  // Se busca cuándo arrancó la story sólo si hace falta (un AC de pantalla sin imagen): así no se leen los marcadores
  // de la máquina para una story que no los necesita.
  let arranqueCalculado = null;
  const arranque = () => {
    if (arranqueCalculado) return arranqueCalculado;
    arranqueCalculado = arranqueDeLaStory({
      startedAt: opts.startedAt, activeDir: opts.activeDir || path.join(stateDirOf(os.homedir()), 'active'),
      storyPath: opts.keyStoryPath ? path.resolve(opts.keyStoryPath) : storyPath, repoRoot, sid, fm,
    });
    for (const m of arranqueCalculado.problemas) avisos.push(m);
    return arranqueCalculado;
  };
  const sinImagen = [];
  for (const n of acs) {
    const a = perAc[n];
    if (!a.pantalla || a.visual.length || (a.verdict !== 'RUNTIME' && a.verdict !== 'RUNTIME-PARCIAL')) continue;
    const ar = arranque();
    const yaEnCurso = ar.ms !== null && Number.isFinite(visualFrom) && ar.ms < visualFrom;
    if (yaEnCurso) {
      avisos.push(`AC#${n} (de pantalla): falta la captura o la grabación del navegador. Esta story arrancó antes del ${new Date(visualFrom).toISOString().slice(0, 10)} ` +
        `(fecha de arranque tomada de ${ar.fuente}; desde el corte un AC de pantalla sin imagen bloquea), así que por ahora sólo avisa. ${comoSacarLaImagen(n)}`);
      continue;
    }
    a.verdict = 'SIN-EVIDENCIA';
    a.motivo = motivoSinImagen(n, a.visualProblemas);
    sinImagen.push(n);
  }
  for (const w of avisos) warnings.push(w);

  // Un AC de pantalla sin imagen bloquea como uno sin correr y tampoco se puede waivear: va también en `notRun`, que es la
  // lista que imprimen el freno del commit y el cierre de «Preparar el commit». `sinImagen` dice cuáles son de pantalla.
  const notRun = acs.filter((n) => perAc[n].verdict === 'NOT-RUN' || sinImagen.includes(n));
  const accionNoEjercida = acs.filter((n) => perAc[n].verdict === 'RUNTIME-PARCIAL');
  const notVerifiablePend = acs.filter((n) => perAc[n].verdict === 'NOT-VERIFIABLE');
  const pendientes = [...notRun, ...accionNoEjercida, ...notVerifiablePend].sort((a, b) => a - b);

  // Firmas descartadas que se nombran: sólo de un AC que de verdad espera firma (NOT-VERIFIABLE). Uno declarado
  // sin test que lo cubra (NOT-RUN) no se puede perdonar, y uno que ya corrió no la necesita.
  // `discardedFor` ya dejó afuera lo aprobado y las declaraciones viejas.
  const esperanFirma = new Set(notVerifiablePend);
  const waiverDiscarded = descartadas.acs.filter((d) => !waived.has(d.ac) && esperanFirma.has(d.ac));
  for (const d of waiverDiscarded) {
    warnings.push(`AC#${d.ac}: la firma EXISTE pero se descartó por la cadena — la firmó ${d.approvedBy || '(sin nombre)'}` +
      `${d.ts ? ` el ${d.ts}` : ''} (${d.log}:${d.line}); ${MOTIVO_EN_PALABRAS[d.motivo] || d.motivo}. No cuenta. ` +
      `Arreglo: volvé a firmar desde tu terminal — marker.js runtime-waiver ${storyParaFirmar} (la firma nueva no depende de ninguna otra línea).`);
  }

  // Verde SOLO si no queda nada NOT-RUN ni NOT-VERIFIABLE sin waivear.
  const green = pendientes.length === 0;

  return {
    sid, key: evKey, keyInfo: { topic: keyInfo.topic, repeated: keyInfo.repeated, siblings: keyInfo.siblings }, orphans,
    exempt: false, acs, perAc, pendientes, notRun, accionNoEjercida, notVerifiable: notVerifiablePend,
    exencionesC8: exenciones, sinImagen, avisos,
    hash, warnings, green, evidenceDirs, wsRoot, waivedAcs: [...waived], chainOk: chain.ok, waiverDiscarded,
    repoRoot,
    // la hora del último cambio de código declarado: la evidencia anterior no cuenta
    codeMtime: maxCodeMtime,
    stats: {
      total: acs.length,
      runtime: acs.filter((n) => perAc[n].verdict === 'RUNTIME').length,
      notRun: notRun.length,
      sinImagen: sinImagen.length,
      accionNoEjercida: accionNoEjercida.length,
      notVerifiable: notVerifiablePend.length,
      waived: acs.filter((n) => perAc[n].verdict === 'WAIVED-USER').length,
      exentosC8: exenciones.filter((e) => e.valida).length,
    },
  };
}

// ---------------------------------------------------------------- artifact

function renderMd(r) {
  const L = [];
  L.push(`# Matriz de verificación runtime — Story ${r.sid}${r.key && r.key !== r.sid ? ` (evidencia: \`${r.key}\`)` : ''} (DODRT-C6)`);
  L.push('');
  L.push(`**Generado**: ${new Date().toISOString()} · **matrix_hash**: \`${r.hash}\` · **veredicto**: ${r.green ? '🟢 VERDE' : '🔴 ROJO'}`);
  const waivedTxt = r.stats.waived ? ` · ${r.stats.waived} waiveados por el usuario (TTY)` : '';
  const parcialTxt = r.stats.accionNoEjercida ? ` · ${r.stats.accionNoEjercida} con la ACCIÓN sin ejecutar (bloquean)` : '';
  const exentoTxt = r.stats.exentosC8 ? ` · ${r.stats.exentosC8} con el verbo exento por declaración (DODRT-C8)` : '';
  const sinImagen = r.sinImagen || [];
  // sinImagen va también dentro de notRun (lo imprimen los frenos), pero acá se cuenta aparte.
  const sinImagenTxt = sinImagen.length ? ` · ${sinImagen.length} de pantalla sin captura ni grabación (bloquean)` : '';
  const sinCorrer = (r.notRun || []).filter((n) => !sinImagen.includes(n));
  L.push(`**Cobertura**: ${r.stats.runtime}/${r.stats.total} ACs corridos en runtime · ${sinCorrer.length} sin correr (bloquean)${sinImagenTxt}${parcialTxt} · ${r.stats.notVerifiable} imposibles-declarados (esperan waiver)${waivedTxt}${exentoTxt}`);
  L.push('');
  L.push('| AC | Veredicto | Evidencia runtime | Evidencia código | Razón (si imposible) |');
  L.push('|---|---|---|---|---|');
  for (const n of r.acs) {
    const a = r.perAc[n];
    const icon = a.verdict === 'RUNTIME' ? '🟢' : a.verdict === 'WAIVED-USER' ? '🟦' :
      a.verdict === 'NOT-VERIFIABLE' ? '🟪' : a.verdict === 'RUNTIME-PARCIAL' ? '🟠' : '🔴'; // NOT-RUN = 🔴
    // La columna de evidencia dice CÓMO se ejerció la acción cuando el AC es de acción — así el
    // lector distingue "la corrida observó" de "la corrida ejecutó" sin abrir el artefacto.
    // Junto a la evidencia, qué esperaba el humo y dónde está lo que salió. El texto viene del registro
    // (ya tapado al escribirlo); un `|` o un salto de línea romperían la fila de la tabla.
    const celda = (t) => String(t).replace(/\s+/g, ' ').replace(/\|/g, '\\|');
    const esperado = (a.expectativas || []).map((x) =>
      `🎯 smoke ${x.ts} pasa si: «${celda(x.pasaSi || '—')}»${x.fallaSi ? ` · falla si: «${celda(x.fallaSi)}»` : ''} · salida: \`${celda(x.output)}\``);
    const imagen = a.visual && a.visual.length ? `🖼️ ${a.visual.length} imagen(es): ${a.visual.map((v) => `\`${v}\``).join(', ')}`
      : a.motivo ? '🖼️ falta la captura o la grabación del navegador' : null;
    const ev = [a.runtime.join('; ') || '—', ...esperado, imagen, a.mutacion ? `✋ ${a.mutacion}` : null,
      a.exentoC8 ? `⚖️ verbo exento: ${a.exentoC8}` : null].filter(Boolean).join(' · ');
    L.push(`| #${n} | ${icon} ${a.verdict} | ${ev} | ${a.code.join('; ') || '—'} | ${a.declReason || '—'} |`);
  }
  L.push('');
  if (sinCorrer.length) {
    L.push(`## 🔴 ACs SIN CORRER — bloquean, NO se pueden waivear (${sinCorrer.length})`);
    L.push('');
    L.push(`AC ${sinCorrer.map((n) => '#' + n).join(', ')}`);
    L.push('');
    L.push('Estos NO están declarados como imposibles de verificar. El agente DEBE correrlos:');
    L.push('- E2E Playwright que asserte el AC contra la app real, corrido vía el gate (`run-check dod`).');
    L.push('- Smoke de backend vía `smoke-run.sh <evidence-dir> <ruta-de-la-story.md> --acs N,M --pass-if \'<qué tiene que pasar>\' -- <curl...>` (exit code real y salida guardada; la clave del registro sale de la ruta).');
    L.push('');
    L.push('Si de verdad es materialmente imposible verificarlo corriendo la app, declararlo en el');
    L.push('frontmatter `runtime_not_verifiable:` (con `reason:` y `covered_by:` un test que lo cubra) —');
    L.push('y ahí SÍ lo puede aprobar el usuario. Sin esa declaración, un waiver NO lo saltea.');
  }
  if (sinImagen.length) {
    L.push('');
    L.push(`## 🖼️ ACs de pantalla sin captura ni grabación — bloquean, NO se pueden waivear (${sinImagen.length})`);
    L.push('');
    L.push(`AC ${sinImagen.map((n) => '#' + n).join(', ')}`);
    L.push('');
    L.push('Lo que el cliente ve sólo se da por probado con una imagen del navegador real atada al criterio: que una prueba');
    L.push('haya salido verde no alcanza. La imagen es de un sitio de laboratorio, nunca con datos de un cliente. Para cada uno:');
    for (const n of sinImagen) L.push(`- **AC#${n}** — ${comoSacarLaImagen(n)}`);
  }
  if (r.accionNoEjercida && r.accionNoEjercida.length) {
    L.push('');
    L.push(`## 🟠 ACs cuya ACCIÓN nunca se ejecutó — bloquean (${r.accionNoEjercida.length})`);
    L.push('');
    L.push(`AC ${r.accionNoEjercida.map((n) => '#' + n).join(', ')}`);
    L.push('');
    L.push('Estos ACs describen algo que el usuario HACE (asignar, confirmar, crear, enviar…), y la');
    L.push('corrida sólo miró la pantalla: nada prueba que la acción se haya ejecutado de verdad. Es');
    L.push('el modo de falla de DODRT-C8 — "verificado corriendo" que en realidad significa "vi el botón".');
    L.push('');
    L.push('Para cerrarlo, una de las dos:');
    L.push('- Un test del gate E2E cuyo TÍTULO tenga `@mutates` y el `@ac-N` — y que APRIETE el botón.');
    L.push('- Un smoke que escriba de verdad (`-X POST|PUT|PATCH|DELETE`) vía `smoke-run.sh`.');
    L.push('- Un smoke declarado con `--mutates` vía `smoke-run.sh` (productos sin superficie HTTP — la garantía es el exit code).');
    L.push('');
    L.push('Si la acción es materialmente imposible de ejecutar en el ambiente, declarala en');
    L.push('`runtime_not_verifiable:` con su `covered_by:` y que la apruebe el usuario.');
    L.push('');
    L.push('Y si el verbo NO describe una acción —es el nombre de un endpoint, de un botón o de un');
    L.push('permiso, y el AC verifica que la acción se BLOQUEA— entonces la heurística se equivocó:');
    L.push('declaralo EN EL AC, con el motivo, y queda contado en este mismo artefacto:');
    L.push('');
    L.push('```');
    L.push('3. Los endpoints asignar / cerrar retornan 403 para roles no autorizados.');
    L.push('   @runtime-exempt(DODRT-C8): son los nombres de los endpoints; el AC verifica el rechazo.');
    L.push('```');
    L.push('');
    L.push('Eso corrige la CLASIFICACIÓN, no la verificación: el AC sigue necesitando su evidencia de');
    L.push('corrida. Sin motivo NO cuenta. Si el AC sí describe algo que el usuario HACE, no es la vía.');
  }
  if (r.notVerifiable && r.notVerifiable.length) {
    L.push('');
    L.push(`## 🟪 ACs imposibles-de-verificar-corriendo (declarados) — esperan tu waiver (${r.notVerifiable.length})`);
    L.push('');
    for (const n of r.notVerifiable) {
      // El TEXTO del AC va PRIMERO: es lo que el usuario está aprobando saltear. La razón es el
      // argumento, no el hecho — mostrar sólo la razón es pedir una firma sobre algo sin nombre.
      if (r.perAc[n].text) L.push(`- **AC#${n}** — «${r.perAc[n].text}»`);
      else L.push(`- **AC#${n}** — _(no se pudo citar el texto del AC desde el spec)_`);
      L.push(`  - **Por qué no se puede correr**: ${r.perAc[n].declReason}`);
      L.push(`  - **Cubierto por**: ${r.perAc[n].coveredBy || r.perAc[n].code.join(', ') || 'test de código'}`);
    }
    L.push('');
    L.push('El agente no puede saltearlos. Los aprueba EL USUARIO desde su terminal (requiere `/dev/tty`):');
    L.push('```bash');
    L.push(`node <skill>/scripts/marker.js runtime-waiver <ruta-story.md>   # lo corre EL USUARIO`);
    L.push('```');
    L.push('El waiver queda pinneado a este `matrix_hash` — si cambia el código/evidencia, se invalida solo.');
  }
  if ((r.waiverDiscarded || []).length) {
    L.push('');
    L.push(`## 🟧 Firmas descartadas por la cadena (${r.waiverDiscarded.length}) — existen, pero no cuentan`);
    for (const d of r.waiverDiscarded) L.push(`- AC#${d.ac} — ${d.approvedBy || '(sin nombre)'}${d.ts ? `, ${d.ts}` : ''} · \`${d.log}:${d.line}\` · ${MOTIVO_EN_PALABRAS[d.motivo] || d.motivo}`);
    L.push('');
    L.push('Se arreglan volviendo a firmar desde la terminal (`marker.js runtime-waiver <ruta-story.md>`): la firma nueva no depende de ninguna otra línea.');
  }
  if (r.chainOk === false) {
    L.push('');
    L.push('## 🚨 Hay líneas de esta story descartadas por la cadena del registro de firmas — causa probable: una edición a mano. Ver las advertencias.');
  }
  const exC8 = (r.exencionesC8 || []).filter((e) => e.valida);
  if (exC8.length) {
    L.push('');
    L.push(`## ⚖️ Verbos exentos de DODRT-C8 por declaración (${exC8.length})`);
    L.push('');
    L.push('Alguien declaró que en estos ACs el verbo NO describe una acción (es el nombre de un');
    L.push('endpoint, de un botón, de un permiso). **La verificación runtime del AC sigue exigida** —');
    L.push('lo único que se levanta es el pedido extra de probar que la escritura ocurrió.');
    L.push('');
    for (const e of exC8) {
      if (r.perAc[e.ac] && r.perAc[e.ac].text) L.push(`- **AC#${e.ac}** — «${r.perAc[e.ac].text}»`);
      else L.push(`- **AC#${e.ac}**`);
      L.push(`  - **Motivo declarado**: ${e.motivo}`);
    }
    L.push('');
    L.push('Si alguno de estos ACs sí describe algo que el usuario HACE, la marca está mal puesta:');
    L.push('sacala del AC y ejercé la acción (E2E `@mutates`, smoke con escritura, o `--mutates`).');
  }
  const orf = r.orphans || { unowned: [], handRenamed: [] };
  if (orf.unowned.length || orf.handRenamed.length) {
    L.push('');
    L.push(`## 🧩 Evidencia huérfana (${orf.unowned.length + orf.handRenamed.length}) — no cuenta, no se tocó`);
    L.push('');
    L.push(`El número ${r.sid} lo comparten varias stories de este repo, así que la evidencia de esta story se nombra`);
    L.push(`\`${r.key}-…\`. Estos archivos están bajo el número solo y no dicen de cuál de las stories son: no cuentan`);
    L.push('para ninguna. Decidí vos: re-correr el humo o el gate (con la ruta de la story) o descartarlos.');
    if (r.keyInfo && r.keyInfo.siblings && r.keyInfo.siblings.length) {
      L.push('');
      L.push(`Comparten el número ${r.sid}: ${r.keyInfo.siblings.join(', ')}`);
    }
    if (orf.unowned.length) {
      L.push('');
      L.push('Huérfanas:');
      for (const f of orf.unowned) L.push(`- ${f}`);
    }
    if (orf.handRenamed.length) {
      L.push('');
      L.push(`Ya renombradas a mano con el tema (parecen de esta story; para que cuenten, renombralas a \`${r.key}-…\`):`);
      for (const f of orf.handRenamed) L.push(`- ${f}`);
    }
  }
  if (r.warnings.length) {
    L.push('');
    L.push('## Warnings');
    for (const w of r.warnings) L.push(`- ⚠️ ${w}`);
  }
  L.push('');
  return L.join('\n');
}

function primaryEvidenceDir(r) {
  // El dir que ya tiene artefactos de esta story; si ninguno, el primero existente.
  let best = null; let bestCount = -1;
  for (const d of r.evidenceDirs) {
    const count = safeReaddir(d).filter((f) => f.startsWith(`${r.key || r.sid}-`)).length;
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

// ---------------------------------------------------------------- CLI

function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : null;
  };
  const storyPath = opt('--story');
  if (!storyPath) {
    console.error('uso: runtime-matrix.js --story <abs .md> [--workspace-root <dir>] [--evidence-dir <dir>] [--json] [--no-write]');
    process.exit(2);
  }
  const evidenceDir = opt('--evidence-dir');
  const r = compute({
    storyPath: path.resolve(storyPath),
    workspaceRoot: opt('--workspace-root'),
    evidenceDirs: evidenceDir ? [path.resolve(evidenceDir)] : undefined,
  });

  if (r.structuralError) {
    console.error(`🛑 runtime-matrix ERROR ESTRUCTURAL (fail-closed): ${r.structuralError}`);
    process.exit(2);
  }
  if (r.exempt) {
    console.log(`runtime-matrix: story ${r.sid} tiene dod_runtime_exempt: true → verde (exenta).`);
    process.exit(0);
  }

  const md = renderMd(r);
  if (!argv.includes('--no-write')) {
    const dir = primaryEvidenceDir(r);
    if (dir) {
      const out = path.join(dir, `${r.key || r.sid}-runtime-matrix.md`);
      fs.writeFileSync(out, md, 'utf8');
      console.error(`matriz escrita: ${out}`);
    } else {
      console.error('⚠️ sin evidence dir descubierto — matriz NO persistida (pasá --evidence-dir).');
    }
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(md);
  }
  // exitCode y no exit(): con exit() una salida grande por pipe se trunca.
  process.exitCode = r.green ? 0 : 1;
}

// `acEsDeAccion` se exporta para poder testear la heurística de DODRT-C8 como función PURA
// (mismo criterio que lib/atdd-order.js): sus falsos positivos se miden con texto de ACs
// reales, no armando un workspace entero.
module.exports = { isCodeFile, compute, renderMd, storyIdFrom, discoverRepoRoot, acEsDeAccion, parseExencionC8, avisoFirmasDescartadas, esDePantalla, VISUAL_EVIDENCE_FROM, readSmokeLedger, defaultGatesLog };

if (require.main === module) {
  main();
}
