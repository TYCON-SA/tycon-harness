#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse hook (matcher: Bash|PowerShell) — DoD runtime evidence gate.
 *
 * **Por qué existe**: Claude puede declarar `done` y commitear sin haber
 * ejecutado nunca los E2E que escribió. Sin este freno, el cierre pasa sin evidencia de runtime.
 *
 * Capa 1 de defense-in-depth — bloqueo HARD en `git commit`:
 *
 *   1. Intercepta el evento PreToolUse Bash con `git commit` en el comando.
 *   2. Lee `git diff --cached` del cwd del repo target.
 *   3. Si el diff incluye cambios a algun `specs/stories/N-M-*.md` con
 *      transiciones de status -> review/done o pipelines.X.status -> done,
 *      y la story declara tests E2E / Playwright / smoke runtime -> EXIGE
 *      evidencia en .advisors/dod-runtime/<storyId>-<ts>.md
 *   4. Si la evidencia NO existe en el repo → exit 2 con mensaje accionable.
 *   5. Escape hatch: `--no-verify` saltea el hook (estándar git) y queda flag
 *      `had_dod_bypass: true` en stderr.
 *   6. Otras stories (sin E2E declarados) → pasan sin bloqueo.
 *
 * Por qué un hook bloqueante: el patrón "Claude marca done sin probar" no
 * lo atrapa ningún advisor (los advisors LEEN el spec, no ejecutan E2E).
 * Necesitamos infraestructura que se imponga al agente, no que el agente
 * elija respetar.
 *
 * Exit codes (convención Claude Code PreToolUse):
 *   0 → permitir el tool call (commit procede)
 *   2 → BLOQUEAR el tool call (stderr es el mensaje al user/agente)
 *
 * Schema del evento Claude Code PreToolUse Bash (stdin):
 *   {
 *     "hook_event_name": "PreToolUse",
 *     "tool_name": "Bash",
 *     "tool_input": { "command": "git commit -m '...'" },
 *     "cwd": "/abs/path/to/repo"
 *   }
 */

const fs = require('fs');
const path = require('path');
const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // La carpeta del estado, de una sola pieza
const os = require('os');
// execFileSync (arg array, sin shell) en vez de execSync con strings
// interpolados — evita rotura/inyección con paths que tengan metacaracteres de shell.
const { execFileSync } = require('child_process');

// Las dos llaves que avisan (TYCON_REVIEW_A_DONE y TYCON_ROSTER_NAMES) frenan con el mismo valor que en el portón del
// arnés (scripts/ci/tycon-ci-gate.js): `block`. El valor anterior también frena.
const VALORES_QUE_FRENAN = Object.freeze(['block', ['fre', 'no'].join('')]);
function llaveFrena(valor) {
  const v = String(valor === undefined || valor === null ? '' : valor);
  // el valor anterior frena igual, y se anota su uso (lo anota el arnés; sin él, no).
  if (v === VALORES_QUE_FRENAN[1]) {
    try { require('./lib/legacy-names.js').recordUse({ kind: 'value', old: v, new: VALORES_QUE_FRENAN[0], script: 'skills/tycon-pipeline/scripts/on-pre-commit.js' }); } catch (_) { /* anotar nunca frena */ }
  }
  return VALORES_QUE_FRENAN.includes(v);
}

// Dirs de evidencia DoD para el repo donde se COMMITEA: el repo +
// sus companions declarados (`.tycon/advisors.yaml → evidence.companion_repos`) + subproyectos
// un nivel abajo — criterio único en lib/evidence-config.js, el mismo de runtime-matrix.js.
// Los repos hermanos no se barren por vecindad (los que tienen `specs/stories/`): los story-id
// COLISIONAN entre productos (una "1.4" existe en varios repos), y un `<sid>-*.md` ajeno
// satisfaría el check de evidencia de este producto.
/**
 * Los avisos del modo FRENO, UNA sola vez por corrida.
 *
 * Por qué existe este emisor y no un `process.stderr.write` en cada punto de lectura: la config se
 * consulta varias veces por commit (evidencia, hermanos, guía de pruebas) y el mismo aviso saldría
 * duplicado o —peor— no saldría, porque el freno que corta primero no es el que lee la config.
 * Un aviso que depende de QUÉ freno gana la carrera es un aviso que no se puede probar.
 */
let _avisosEmitidos = false;
// El aviso de deriva del mapa de navegación también sale uno por corrida, no uno por story.
let _navAvisado = false;
function avisosDeConfigFreno(cwd) {
  if (_avisosEmitidos) return;
  _avisosEmitidos = true;
  const avisos = [];
  try {
    const ec = require('./lib/evidence-config.js');
    const root = ec.discoverRepoRoot(cwd) || cwd;
    avisos.push(...ec.parseEvidenceConfig(root, { freno: true }).warnings);
  } catch (_e) { /* un aviso que falla nunca rompe el commit */ }
  try {
    avisos.push(...require('./lib/story-discovery.js').storiesConfigForGate(cwd).warnings);
  } catch (_e) { /* idem */ }
  for (const a of avisos) process.stderr.write(`${a}\n`);
}

/**
 * El texto de `.tycon/advisors.yaml` que debe leer un FRENO: el COMMITEADO. Sin historia git
 * todavía, la carpeta (no hay commit contra el cual contrastar). Ver lib/config-source.js.
 */
function configFreno(cwd) {
  try {
    const ec = require('./lib/evidence-config.js');
    const root = ec.discoverRepoRoot(cwd) || cwd;
    const txt = require('./lib/config-source.js').textoParaFreno(root);
    return txt === null ? undefined : txt;
  } catch (_e) { return undefined; }
}

function dodEvidenceDirsFor(cwd) {
  const ec = require('./lib/evidence-config.js');
  const root = ec.discoverRepoRoot(cwd) || cwd;
  // 🔴 Modo FRENO: los repos hermanos declarados se leen de lo COMMITEADO.
  // Declarar un hermano AFLOJA (su evidencia cuenta como propia) y aflojar tiene que verse en un
  // commit; escribirlo en la carpeta no alcanza. El aviso lo emite `avisosDeConfigFreno()`
  // una sola vez por corrida — acá se llamaría varias veces y saldría repetido.
  const dirs = ec.productEvidenceRoots(root, { freno: true }).map((r) => path.join(r, '.advisors', 'dod-runtime'));
  // Sin ningún dir existente, dejar al menos el canónico del repo (para mensajes de error).
  return dirs.length ? dirs : [path.join(root, '.advisors', 'dod-runtime')];
}

// Parser muy simple del frontmatter YAML — solo extrae los campos planos que
// nos interesan (no full YAML parser para mantener zero-dependency).
function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split('\n');
  const out = {};
  for (const line of lines) {
    const mm = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.+)$/);
    if (!mm) continue;
    let val = mm[2].trim();
    // Strip quotes
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[mm[1]] = val;
  }
  return out;
}

const { isWorkStoryId, storiesConfigForGate } = require('./lib/story-discovery.js');
const { esEvidenciaDeCierre, ES_EVIDENCIA_ADEMAS, coberturaDeLaUnion } = require('./lib/closing-evidence.js');
const { resolveSessionId } = require('./lib/session-id.js');

/**
 * ¿Este contenido es una story Mary+GOLD? Criterio ESTRUCTURAL: el frontmatter (que tiene que
 * CERRAR) declara `story:` y `status:`, y el id tiene forma de trabajo.
 *
 * Criterio estructural en vez de filtro por ruta `specs/stories/*.md`: el filtro por ruta dejaría este
 * gate mudo en todo repo con otro layout, y un gate que no se dispara
 * es indistinguible de un gate que pasó. La exigencia de que el frontmatter CIERRE es a propósito:
 * es la misma lectura que hace el resto del arnés, así que si acá no se ve como story, allá
 * tampoco (y eso lo caza `lint-story-frontmatter.js`, que es el control que corresponde).
 */
function looksLikeStorySpec(content, idPattern) {
  if (typeof content !== 'string' || !content.startsWith('---')) return false;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return false;
  const fm = content.slice(3, end);
  if (!/^status:\s*\S/m.test(fm)) return false;
  const id = fm.match(/^story:\s*["']?([^"'\n]+?)["']?\s*$/m);
  // El id además tiene que tener FORMA de trabajo: el material de un banco de evals declara
  // `story: "EV-1"` + `status:` y no es algo que haya que cerrar con evidencia de DoD.
  return !!id && isWorkStoryId(id[1], idPattern);
}

/**
 * De los archivos del diff staged, los que son stories. Función aparte y EXPORTADA a propósito:
 * escrita inline dentro de `main()`, el test la reimplementaría en vez de llamarla, y el chequeo de
 * mutantes mostraría que los mutantes de esas 3 líneas sobreviven porque el código real nunca se
 * ejecuta. Probar una copia de la lógica es no probar la lógica.
 *
 * `readContent(file)` devuelve el contenido STAGED; `into` (opcional) se llena con lo leído para
 * que el caller no tenga que volver a pedirlo.
 */
function selectStorySpecs(diffFiles, readContent, idPattern, into) {
  return diffFiles.filter((f) => {
    if (!f.endsWith('.md')) return false;
    const content = readContent(f);
    if (!looksLikeStorySpec(content, idPattern)) return false;
    if (into) into.set(f, content);
    return true;
  });
}

function readEvent() {
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (!stdin) return null;
    return JSON.parse(stdin);
  } catch {
    return null;
  }
}

function getStagedDiff(cwd) {
  try {
    return execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function getStagedFileContent(cwd, file) {
  try {
    return execFileSync('git', ['show', `:${file}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function getHeadFileContent(cwd, file) {
  try {
    return execFileSync('git', ['show', `HEAD:${file}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return ''; // file didn't exist in HEAD (new file)
  }
}

// Detecta si un comando de shell ejecuta `git commit` como COMANDO real — no como
// substring dentro de un string citado (`echo "git commit"`) ni `git log --grep=commit`.
// Parte el comando por separadores de shell y, en cada segmento que ARRANCA con `git`,
// verifica que el primer token no-flag sea `commit`. Un regex del tipo `\bgit\s+...commit\b`
// matchea el substring en cualquier posición → falsos positivos que dispararían toda la
// maquinaria del gate sobre comandos que no son commits.
function isGitCommit(command) {
  return argumentosDeCommit(command).length > 0;
}

// Lo que sigue a `commit` en cada `git commit` de verdad del comando, uno por commit (la misma lectura que isGitCommit).
function argumentosDeCommit(command, _depth = 0) {
  const commits = [];
  if (!command || typeof command !== 'string') return commits;
  const segments = command.split(/&&|\|\||[;&|\n]/);
  for (let seg of segments) {
    seg = seg.trim();
    // Pelar prefijos que NO son el comando — subshell `$(` / backtick,
    // paréntesis/llaves, y asignaciones de entorno `VAR=val git commit`. Repetir hasta
    // estabilizar (combinaciones tipo `( ENV=x git commit`).
    let prev;
    do {
      prev = seg;
      seg = seg
        .replace(/^\$\(/, '')
        .replace(/^[`(){}\s]+/, '')
        .replace(/^\w+=(?:"[^"]*"|'[^']*'|\S+)\s+/, '');
    } while (seg !== prev);
    // Wrapper de shell: `bash -c "git commit ..."` / `sh -c '...'`
    // / `zsh -c` no arranca con git y evadía la detección. Re-aplicar recursivamente
    // sobre el string interno (un nivel basta — wrappers anidados son rebuscados y el
    // safety-guard + regla #0 cubren el caso malicioso).
    if (_depth === 0) {
      const wrapM = seg.match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+(?:-\w+\s+)*-c\s+("([^"]*)"|'([^']*)')/);
      if (wrapM) {
        const inner = wrapM[2] !== undefined ? wrapM[2] : wrapM[3];
        commits.push(...argumentosDeCommit(inner, 1));
      }
    }
    const m = seg.match(/^(?:\S*\/)?git\b(.*)$/s);
    if (!m) continue;
    const tokens = m[1].trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '-c' || t === '-C' || t === '--git-dir' || t === '--work-tree') { i += 2; continue; }
      if (t.startsWith('-')) { i += 1; continue; }
      break; // primer token no-flag
    }
    if (tokens[i] === 'commit') commits.push(tokens.slice(i + 1).join(' '));
  }
  return commits;
}

// Los tramos de un comando de shell: corta en `;`, `&`, `|` y el salto de línea que están fuera de comillas.
function tramosDelShell(texto) {
  const out = [];
  let cur = '';
  for (let i = 0; i < texto.length;) {
    const c = texto[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < texto.length && texto[j] !== c) j += (c === '"' && texto[j] === '\\') ? 2 : 1;
      cur += texto.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '\\' && i + 1 < texto.length) { cur += texto.slice(i, i + 2); i += 2; continue; }
    if (/[;&|\n]/.test(c)) { out.push(cur); cur = ''; i += 1; continue; }
    cur += c; i += 1;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Las palabras de cada `git commit` de verdad del comando (lo que sigue a `commit`), leídas como las arma el shell.
function commitsDelShell(command, depth = 0) {
  const out = [];
  for (const tramo of tramosDelShell(String(command || ''))) {
    let ps = palabrasDelShell(tramo.replace(/^(?:\$\(|[`(){}\s])+/, ''));
    while (ps.length && /^\w+=/.test(ps[0])) ps = ps.slice(1);
    if (!ps.length) continue;
    const cmd = ps[0].replace(/^.*\//, '');
    if (depth === 0 && /^(?:ba|z|da)?sh$/.test(cmd)) {
      const c = ps.indexOf('-c');
      if (c > 0 && c + 1 < ps.length) out.push(...commitsDelShell(ps[c + 1], 1));
      continue;
    }
    if (cmd !== 'git') continue;
    let i = 1;
    while (i < ps.length && ps[i].startsWith('-')) i += ['-c', '-C', '--git-dir', '--work-tree'].includes(ps[i]) ? 2 : 1;
    if (ps[i] === 'commit') out.push(ps.slice(i + 1));
  }
  return out;
}

// Las palabras de un texto como las arma el shell: las comillas agrupan y se sacan, la barra escapa el carácter siguiente.
function palabrasDelShell(texto) {
  const out = [];
  let cur = null;
  for (let i = 0; i < texto.length;) {
    const c = texto[i];
    if (/\s/.test(c)) { if (cur !== null) { out.push(cur); cur = null; } i += 1; continue; }
    // `$'…'` se lee como comillas simples
    if (c === '$' && texto[i + 1] === "'") { i += 1; continue; }
    if (c === "'") {
      const fin = texto.indexOf("'", i + 1);
      const hasta = fin < 0 ? texto.length : fin;
      cur = (cur || '') + texto.slice(i + 1, hasta); i = hasta + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let buf = '';
      while (j < texto.length && texto[j] !== '"') {
        if (texto[j] === '\\' && j + 1 < texto.length) { buf += texto[j + 1]; j += 2; } else { buf += texto[j]; j += 1; }
      }
      cur = (cur || '') + buf; i = j + 1; continue;
    }
    if (c === '\\' && i + 1 < texto.length) { cur = (cur || '') + texto[i + 1]; i += 2; continue; }
    cur = (cur || '') + c; i += 1;
  }
  if (cur !== null) out.push(cur);
  return out;
}

// ¿Algún `git commit` del comando lleva `--no-verify` (o la abreviada que git acepta, `--no-veri`, `--no-verif`) como
// argumento? Nombrarla en un mensaje, un heredoc o un grep no es usarla. El valor de `-m`/`-F` es texto, no opción; una
// opción larga abreviada (`--mess`) se lee como la entera, igual que git.
const CON_VALOR_CORTAS = new Set(['-m', '-F', '-C', '-c', '-t']);
const CON_VALOR_LARGAS = ['--message', '--file', '--author', '--date', '--template', '--trailer', '--fixup', '--squash',
  '--reuse-message', '--cleanup'];
function llevaValor(p) {
  if (CON_VALOR_CORTAS.has(p)) return true;
  return p.length > 3 && !p.includes('=') && CON_VALOR_LARGAS.some((l) => l.startsWith(p));
}
function usaNoVerify(command) {
  return commitsDelShell(command).some((ps) => {
    for (let i = 0; i < ps.length; i += 1) {
      if (/^--no-veri(?:fy?)?$/.test(ps[i])) return true;
      // un grupo de cortas (`-an`): la `n` es el salteo; desde una que lleva valor, lo que sigue es su valor
      const corta = /^-([a-zA-Z]+)$/.exec(ps[i]);
      if (corta) {
        const k = corta[1].search(/[mFCct]/);
        const flags = k < 0 ? corta[1] : corta[1].slice(0, k);
        if (flags.includes('n')) return true;
        if (k === corta[1].length - 1) i += 1;
        continue;
      }
      if (llevaValor(ps[i])) i += 1;
    }
    return false;
  });
}

// CF-4 — gap residual conocido: `git commit <pathspec>` commitea paths del working-tree que
// pueden NO estar en `git diff --cached` (que es lo que lee este gate). Cerrarlo del todo
// implicaría chequear también working-tree vs HEAD por cada pathspec, con riesgo de falsos
// positivos. Bajo riesgo en práctica (commitear specs por pathspec es raro). Documentado, no
// cerrado. La Capa 2 (on-frontmatter-write, en el Edit/Write del spec) lo atrapa antes igual.

// True si la transición de status indica que la story está pasando a un estado
// que requiere DoD runtime evidence (review o done).
function isCriticalStatusTransition(oldStatus, newStatus) {
  const critical = new Set(['review', 'done']);
  return critical.has((newStatus || '').toLowerCase()) &&
         !critical.has((oldStatus || '').toLowerCase());
}

// True si la story declara tests que requieren runtime (E2E, Playwright, smoke).
// Heurística basada en presencia de campos en frontmatter o sección 'Tests' con
// scenarios E2E.
function storyRequiresRuntimeEvidence(specContent) {
  if (!specContent) return false;
  // Markers que indican tests runtime-dependent declarados.
  const runtimeMarkers = [
    'tests_done_playwright_spec',
    'tests_pending_runtime',
    'playwright',
    'Playwright',
    'E2E',
    'e2e-tests',
    'smoke runtime',
  ];
  return runtimeMarkers.some(m => specContent.includes(m));
}

// DODRT-C5.1 — ¿La story toca UI? Para una story de UI la evidencia DoD debe venir de un
// E2E Playwright REAL (no curl/unit): sin eso, una story se declara "probada en runtime" sin correr Playwright. La señal la decide lib/ui-signal.js (fuente única:
// listas de archivos, campos estructurados y tandas; la prosa sólo de respaldo; escenarios de navegador
// en el spec; nombres declarados en .tycon/advisors.yaml → evidence.fe_paths). Nada de productos acá.
// La pantalla de una tanda bloqueada no se pide en este commit (`screenScope`, la misma regla que marker.js), salvo
// que el commit cambie un archivo de pantalla (`changed`, lo preparado para commitear).
function storyIsUiStory(specContent, repoRoot, changed) {
  return require('./lib/ui-signal.js').screenScope(specContent, repoRoot, { changed }).active;
}

// La baja de pantalla se dice al cerrar: una línea por stderr y por story, sin
// bloquear. El texto lo arma lib/ui-signal.js.
function avisoBajaDePantalla(specContent, repoRoot, changed) {
  try {
    const ui = require('./lib/ui-signal.js');
    return ui.proseDropNotice(ui.uiSignalDetail(specContent, repoRoot)) || ui.screenScope(specContent, repoRoot, { changed }).note;
  } catch (_e) { return null; }   // el aviso nunca rompe el cierre: es informativo y el veredicto ya se decidió
}

// True si la story tiene la excepción explícita `dod_runtime_exempt: true`.
function storyIsExempt(specContent) {
  return /^dod_runtime_exempt:\s*true\b/m.test(specContent);
}

// ADVISORS-GATE: a `done` no se llega sin constancia de que un advisor la auditó.
// Una story implementada a mano puede llegar a `done` con evidencia de DoD real pero sin que
// NINGÚN advisor la audite — los controles del cierre piden DoD y self-audit,
// no "advisors corridos". Constancia aceptada: (1) una corrida del pipeline EN EL REPO
// (`.advisors/pipeline-runs/<storyId>-*/` con reportes del paso de revisores o `findings.json`), o (2) una
// línea `check=advisors status=green` en gates.log cuyo `repoPath` sea este repo (las líneas
// sin `repoPath` son ambiguas entre repos y NO cuentan).
/**
 * ROSTER-GATE — el cruce que sólo se puede hacer acá.
 *
 * Devuelve null si está todo bien, o `{reason, ...}` para frenar el commit. Falla ABIERTO ante
 * errores internos (no encontrar la lib, un repo raro): el portón de CI es la red de atrás, y un
 * control que rompe commits por un problema propio se termina apagando entero.
 */
/**
 * Los firmantes de los hallazgos de esta corrida, con su tramo. Es el insumo del cruce directo.
 * Devuelve null si no hay `findings.json` legible — y ahí el cruce simplemente no se hace (no
 * frena: un archivo que falta no es una incoherencia). Mismo criterio que el portón de CI.
 */
function firmantesDeFindings(runDir) {
  // 🔴 Ausente ≠ ilegible. Los dos devuelven null y con null el cruce NO CORRE — o sea que un `findings.json`
  // corrupto APAGA `roster-incoherente` y el commit pasa como si estuviera todo bien. El fail-open
  // del `catch` de más abajo se justifica diciendo «el portón de CI sigue mirando», pero el portón
  // tiene el MISMO punto ciego, así que nadie mira. Que falte es normal (los hallazgos se escriben
  // después del roster) y sigue mudo; que esté roto deja rastro. Ninguno de los dos frena.
  const p = path.join(runDir, 'findings.json');
  let crudo;
  try { crudo = fs.readFileSync(p, 'utf8'); } catch { return null; }
  let lista;
  try {
    const data = JSON.parse(crudo);
    // 🔴 Las MISMAS formas que tolera el portón.
    // Esta función tiene que leer lo mismo que el portón: el portón cae a
    // `data.findings`, y si acá sólo se aceptara un array pelado, con la forma `{findings: [...]}` el
    // servidor correría el cruce y la máquina no — dos veredictos distintos sobre el mismo commit,
    // que es el rojo que hay que evitar. Si las dos no leen igual, la paridad es una afirmación.
    if (Array.isArray(data)) lista = data;
    else if (Array.isArray(data && data.findings)) lista = data.findings;
    else lista = null;
  } catch (e) {
    process.stderr.write(`⚠️  no pude leer ${p} (${String(e.message).slice(0, 120)}): el cruce entre `
      + 'quién firmó los hallazgos y quién figura en el roster NO corrió. No es «está todo bien».\n');
    return null;
  }
  if (!Array.isArray(lista)) {
    process.stderr.write(`⚠️  ${p} no es una lista: el cruce entre quién firmó los hallazgos y quién `
      + 'figura en el roster NO corrió. No es «está todo bien».\n');
    return null;
  }
  const vistos = new Map();
  for (const f of lista) {
    const a = f && (f.advisor || f.agent || f.source);
    if (typeof a !== 'string' || !a) continue;
    const clave = `${a}|${f.tramo || ''}`;
    if (!vistos.has(clave)) vistos.set(clave, f.tramo ? { advisor: a, tramo: f.tramo } : a);
  }
  return [...vistos.values()];
}

function revisarRosterLocal(cwd, storyId, storyPath) {
  let roster; let runDir; let vistos;
  try {
    const rlib = require('./lib/review-roster.js');
    const { resolveRunDir } = require('./pipeline.js');
    const { query } = require('./lib/advisor-ledger.js');
    runDir = resolveRunDir(cwd, String(storyId), false, storyPath);   // por la clave de la story
    if (!runDir) return null; // sin run dir la regla anterior ya habló
    try { roster = rlib.read(runDir); } catch (e) { return { reason: 'roster-ilegible', runDir, detalle: String(e.message).slice(0, 160) }; }
    // 🔴 `query()` devuelve un OBJETO ({spawns, vivos, archivo, advisores…}), no una lista. Tratarlo
    // como lista haría dos daños a la vez: la auto-reparación sería código muerto (`filas.length`
    // undefined) y el `.map()` posterior tiraría un TypeError que sube hasta el wrapper del hook —
    // que falla ABIERTO, así que el commit se salta TODOS los frenos del pre-commit, no sólo
    // éste, y justo en el camino feliz (roster presente y válido).
    // 🔴 Roster PROYECTADO desde el repo del código: los spawns del ledger
    // están estampados con ESE repo, no con el de la story. Filtrar por `cwd` (el repo de specs)
    // daría `sin-testigo` con el testigo en la misma máquina, bajo el otro repo — y la salida que
    // propone (`sin_testigo` en el roster) se pisaría en la próxima proyección.
    const repoTestigo = (roster && roster.projected_from && typeof roster.projected_from.repo === 'string' && roster.projected_from.repo) || cwd;
    const q = query({ story: String(storyId), repo: repoTestigo }) || {};
    vistos = new Set([
      ...(Array.isArray(q.vivos) ? q.vivos.map((r) => r && r.advisor) : []),
      ...Object.keys(q.advisores || {}), // sesiones ya podadas: el resumen durable las conserva
    ].filter(Boolean));
    // 🔴 Mismo corte por fecha que el portón de CI, y por el mismo motivo: una corrida ANTERIOR al
    // estreno de esta pieza no puede tener el registro, y reclamárselo frenaría trabajo legítimo.
    // El sello vive en el nombre del run dir, en sus dos formas reales: `-YYYYMMDDHHMMSS` y `-YYYYMMDD-HHMM`.
    if (!roster) {
      const CUTOFF = process.env.TYCON_ROSTER_CUTOFF || '20260831';
      const m = path.basename(runDir).match(/-(\d{8})(?:-?\d*)?$/);
      if (!m || m[1] < CUTOFF) return null;
    }
    if (!roster) {
      // Auto-reparación: el roster es una VISTA del registro, así que si falta se regenera con los
      // mismos datos mecánicos. Recién si tampoco se puede, frena.
      if (Array.isArray(q.vivos) && q.vivos.length) {
        roster = rlib.write(runDir, { lines: q.vivos, story: String(storyId), sessionId: null });
      }
      if (!roster) return { reason: 'no-roster', runDir };
    }
    // 🔴 El orden importa: la excusa escrita se mira DESPUÉS de validar. `sin_testigo` explica UNA
    // sola cosa —"el registro de esta máquina no tiene los revisores"— y no puede waivear que el
    // roster esté roto o que el autor figure como revisor. Si fuera primero, un archivo con
    // sólo esa línea pasaría el freno local y explotaría después en el portón de CI: el dev seguiría
    // la instrucción del freno y el PR le rebotaría igual.
    // 🔴 El cruce findings↔roster también se hace ACÁ. Es la ÚNICA regla
    // del portón que, sin este cruce, no tendría contraparte en la máquina: el dev se enteraría recién
    // con el pull request abierto — y el mensaje del portón le diría que esto corre en su pre-commit,
    // mandándolo a buscar un hook salteado inexistente.
    const v = rlib.validate(roster, { advisoresEnFindings: firmantesDeFindings(runDir) });
    if (!v.ok) {
      // El veredicto tiene que ser IDÉNTICO al del portón, canal incluido: `roster-incoherente`
      // AVISA por defecto (cuando falla, falla ella y no lo que vigila), y frena en los
      // DOS lados con la misma llave. Las otras reglas del registro frenan siempre.
      // 🔴 El canal se decide POR REGLA, no por el conjunto.
      // Si se pidiera que TODOS los problemas sean `roster-incoherente` para avisar, con un
      // segundo problema en la misma corrida el aviso de los nombres pasaría a
      // frenar de arrastre, mientras el portón lo sigue separando regla por regla. Dos veredictos
      // distintos sobre el mismo commit son justo el rojo que hay que evitar.
      // 🔴 El canal lo decide el PROPIO hallazgo: uno que trae su `tramo` se valida al escribirse
      // contra el registro de esa corrida, así que si igual no cuadra es
      // real y frena. Uno del formato viejo, que nadie validó, sigue avisando. Mismo criterio que
      // el portón — si acá y allá difieren, es el rojo del test de paridad.
      const frenanNombres = llaveFrena(require('./lib/legacy-names.js').readEnv('TYCON_ROSTER_NAMES', { where: 'skills/tycon-pipeline/scripts/on-pre-commit.js' }));
      const esAviso = (x) => x.regla === 'roster-incoherente' && !frenanNombres && !x.validado;
      const avisos = v.problemas.filter(esAviso);
      const bloqueantes = v.problemas.filter((x) => !esAviso(x));
      if (!bloqueantes.length) return { reason: 'roster-invalido', runDir, problemas: avisos, aviso: true };
      // Hay algo que frena: eso manda, y los avisos viajan igual para que el dev los vea una vez.
      return { reason: 'roster-invalido', runDir, problemas: bloqueantes, avisosAparte: avisos };
    }
    if (typeof roster.sin_testigo === 'string' && roster.sin_testigo.trim()) return null;
  } catch {
    return null; // fail-open: el portón de CI sigue mirando
  }
  if (!vistos.size) {
    // El testigo no está. Puede ser inocente (se trabajó en otra máquina, o alguien sube la rama de
    // un compañero) — por eso hay una salida escrita, no un permiso silencioso.
    return { reason: 'sin-testigo', runDir, storyId };
  }
  // 🔴 Las DOS listas contra el ledger, no sólo `reviewers`.
  // `agentes_previos` es una lista que también sirve para
  // dar por válido el firmante de un hallazgo: si no se la cruza contra los spawns reales, alcanza
  // con escribir ahí a mano un revisor inventado para que un hallazgo lo firme y pase por las dos
  // capas. Eso derrotaría la afirmación central de la pieza («el firmante se elige de los que
  // corrieron, no se tipea») por la puerta que abre la propia lista. El portón de CI no
  // puede taparlo: no ve el ledger. Se cruza acá o no se cruza en ningún lado.
  const declarados = [...(roster.reviewers || []), ...(roster.agentes_previos || [])];
  const inventados = [...new Set(declarados.map((r) => r && r.agent).filter((a) => a && !vistos.has(a)))];
  if (inventados.length) return { reason: 'roster-fabricado', runDir, inventados };
  return null;
}

// La carpeta de corrida se busca por la CLAVE de la story (`lib/evidence-key.js`): con un número que se
// repite en el repo, `<id>-*` encontraría la carpeta de OTRA story del mismo número y la dejaría pasar a `done`.
// `opts.storyPath` es la ruta REAL de la story (nunca la copia staged). Lo viejo bajo un número compartido no cuenta y
// se nombra en `legacy`. La constancia de `gates.log` sigue la misma regla: con número compartido sólo cuenta la línea
// que trae la ruta de ESTA story (las líneas sin ruta no la traen: no se sabe de cuál de las dos son).
function findAdvisorsEvidence(cwd, storyId, opts = {}) {
  const searched = [];
  const real = (p) => { try { return fs.realpathSync(p); } catch { return String(p); } };
  const ek = require('./lib/evidence-key.js');
  const k = ek.keyInfoOr(opts.storyPath, String(storyId));
  if (!k.key) {
    searched.push(`(sin clave de la story ${storyId}: ${k.error}) — sin clave no se da constancia por buena`);
    return { found: false, searched, legacy: [] };
  }
  const clave = k.key;
  const compartido = Boolean(k.info && k.info.repeated);
  let root = cwd;
  let roots;
  try {
    const ec = require('./lib/evidence-config.js');
    root = ec.discoverRepoRoot(cwd) || cwd;
    roots = ec.productEvidenceRoots(root, { freno: true });   // modo FRENO — ver dodEvidenceDirsFor
    if (!roots || !roots.length) roots = [root];
  } catch { roots = [root]; }
  const runDirs = roots.map((r) => path.join(r, '.advisors', 'pipeline-runs'));
  const legacy = compartido ? (() => { const l = ek.legacyFiles(runDirs, k.info); return [...l.unowned, ...l.handRenamed]; })() : [];
  for (const dir of runDirs) {
    searched.push(`${dir}/${clave}-*/ (step-05-advisor-reports/ o findings.json)`);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.startsWith(`${clave}-`)) continue;
      const d = path.join(dir, e);
      const hasFindings = fs.existsSync(path.join(d, 'findings.json'));
      let reports = [];
      try { reports = fs.readdirSync(path.join(d, 'step-05-advisor-reports')).filter((f) => f.endsWith('.md')); } catch { reports = []; }
      if (hasFindings || reports.length) return { found: true, via: 'pipeline-run', path: d, searched, legacy };
    }
  }
  const gl = opts.gatesLog || path.join(stateDirOf(os.homedir()), 'gates.log');
  searched.push(`${gl} (check=advisors, status=green, storyId=${storyId}, repoPath=${root}${compartido ? ', storyPath de esta story' : ''})`);
  const rootsReal = new Set(roots.map(real));
  const mia = opts.storyPath ? real(path.resolve(opts.storyPath)) : null;
  try {
    for (const line of fs.readFileSync(gl, 'utf8').split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.check !== 'advisors' || e.status !== 'green' || String(e.storyId) !== String(storyId)) continue;
      if (!e.repoPath) continue; // sin namespace de repo → ambiguo entre repos, no cuenta
      if (!rootsReal.has(real(e.repoPath))) continue;
      if (compartido) {
        if (!e.storyPath || !mia) continue;
        const suya = path.isAbsolute(e.storyPath) ? e.storyPath : path.join(e.repoPath, e.storyPath);
        if (real(suya) !== mia) continue;
      }
      return { found: true, via: 'gates.log', path: gl, searched, legacy };
    }
  } catch { /* sin gates.log */ }
  return { found: false, searched, legacy };
}

// Busca archivo de evidencia DoD para una storyId dada en el repo cwd.
// Devuelve el path + content del archivo MÁS RECIENTE encontrado (por filename
// timestamp), o null si no existe.
// Los tres formatos con los que el pipeline escribe un veredicto: `verdict=FAIL` (gate E2E),
// `- verdict: FAIL` / `VERDICT: **FAIL**` (narrativas) y `## Verdict global` seguido de FAIL.
function evidenciaDeclaraFail(content) {
  if (!content) return false;
  if (/(^|\n)[ \t]*(?:[-*][ \t]*)?(?:\*\*)?verdict(?:[ \t]+global)?(?:\*\*)?[ \t]*[:=][ \t]*(?:\*\*)?[ \t]*FAIL\b/i.test(content)) return true;
  if (/##[ \t]*verdict[ \t]+global[ \t]*\n+[ \t]*(?:\*\*)?FAIL\b/i.test(content)) return true;
  return false;
}
// `opts.storyPath`: con la ruta de la story se busca por la CLAVE de su evidencia
// (lib/evidence-key.js) — con un número repetido en el repo, `<id>-*` es la evidencia de cualquiera de las
// stories que lo comparten. Si la clave no se puede decidir, no hay evidencia (fail-closed): dar por buena
// la de otra story es la mentira que esto cierra. Sin ruta, se usa el id.
function findDodEvidence(cwd, storyId, opts = {}) {
  const evidenceDirs = dodEvidenceDirsFor(cwd);
  let clave = storyId;
  if (opts.storyPath) {
    const k = require('./lib/evidence-key.js').keyOr(opts.storyPath, storyId);
    if (!k.key) return null;
    clave = k.key;
  }
  const expectedPrefix = `${clave}-`;
  // Excluir self-audit files (que comparten prefix `<storyId>-` con la evidencia
  // runtime pero sirven a otro propósito — ACCOV-C8). Sin esta exclusión, el
  // sort alfabético devuelve `4.2-self-audit-iter7.md` antes que
  // `4.2-<timestamp>.md`, rompiendo la cobertura de ACs.
  // 🔴 Se elige el candidato que DOCUMENTA MÁS criterios; a igual cantidad, el más reciente por
  // fecha real. Desempatar por el nombre lexicográficamente mayor decide por azar: con `e2e-gate-`
  // (letra e) y `full-dod-runtime-` (letra f) compitiendo contra un timestamp plano (dígito), el
  // archivo elegido depende de qué prefijos existan en el directorio en ese instante — no de
  // cuál documenta más: el freno decidiría por azar del nombre. El timestamp embebido en el
  // nombre tampoco sirve de desempate: es frágil si dos archivos nacen en el mismo segundo.
  let best = null;
  for (const dir of evidenceDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      // Qué es «evidencia de cierre» lo decide `lib/closing-evidence.js`: el
      // criterio vive en un solo lugar. El motivo de cada exclusión
      // (matriz, self-audit, plan manual) está ahí, una sola vez.
      const files = fs.readdirSync(dir).filter(f =>
        f.startsWith(expectedPrefix) && esEvidenciaDeCierre(f)
      );
      for (const f of files) {
        const full = path.join(dir, f);
        let content = null; let mtime = 0;
        try { content = fs.readFileSync(full, 'utf8'); mtime = fs.statSync(full).mtimeMs; } catch { continue; }
        // 🔴 Una corrida que declara FAIL no compite con una que no. Si se cuentan menciones,
        // una narrativa FALLIDA con «AC #1..#5 ❌»
        // le gana a la evidencia real y nueva con tres ✅, y el mensaje «no menciona ACs #4, #5»
        // desaparece — con la matriz DODRT-C6 en verde, el commit pasa gracias al archivo fallido.
        // Medido: la elección cambia en 78 de 463 stories, 2 hacia un FAIL.
        // El registro de pruebas de humo cuenta como evidencia (existe), pero sus criterios NO se leen del texto:
        // el texto trae también las corridas que fallaron. Sus criterios válidos los suma la unión de la matriz
        // (salida 0 + copia en gates.log) — ver más abajo, en el chequeo por AC.
        const esRegistro = ES_EVIDENCIA_ADEMAS.some((re) => re.test(f));
        const cand = { filename: f, path: full, content, acs: esRegistro ? 0 : parseAcsFromEvidence(content).length, mtime,
          fallido: evidenciaDeclaraFail(content), esRegistro };
        const mejor = best === null
          || (best.fallido && !cand.fallido)
          || (best.fallido === cand.fallido && (cand.acs > best.acs || (cand.acs === best.acs && cand.mtime > best.mtime)));
        if (mejor) best = cand;
      }
    } catch {
      // ignore
    }
  }
  return best;
}

// ── Constancia de lo que decide este freno ───────────────────
// Una línea por story del commit que transiciona a review/done, en frenos.jsonl: con qué regla frenó
// (o avisó) y, si la dejó pasar, por qué. Sólo la huella (id de story + estado): ni ruta, ni story, ni
// texto del commit. Ayuda, no evidencia: se escribe ANTES del `process.exit` y nunca lo cambia.
// El motivo de cada violación se traduce al vocabulario cerrado de `guard-record.js`; uno que no
// esté en la tabla sale `otra` y la línea se escribe igual.
const REGLA_DE_MOTIVO = {
  'no-advisors': 'advisors-gate',
  'sin-testigo': 'roster', 'no-roster': 'roster', 'roster-fabricado': 'roster', 'roster-invalido': 'roster', 'roster-ilegible': 'roster',
  'no-evidence': 'evidencia-ausente', 'evidence-failed': 'evidencia-fallida', 'incomplete-evidence': 'evidencia-incompleta',
  'no-playwright-evidence': 'sin-playwright', 'matrix-red': 'matriz-roja', 'matrix-structural': 'matriz-estructural',
  'not-converged': 'convergencia',
  // una story que cierra sin criterios: la misma regla que la matriz sin criterios legibles, así el
  // vocabulario cerrado de guard-record.js —que comparte el freno de producción— no cambia
  'no-criteria': 'matriz-estructural',
};
function anotarDecisionesDelCierre({ violations, soloAviso, pasos, estadoDe, avisosSelfAudit = [] }) {
  let anotarCierre;
  try { ({ anotarCierre } = require('./lib/closing-record.js')); } catch { return; } // ayuda, no evidencia
  const huella = (storyId, specRel) => `${storyId}\0${estadoDe.get(specRel) || ''}`;
  for (const v of violations) {
    try {
      anotarCierre({ freno: 'on-pre-commit', regla: REGLA_DE_MOTIVO[v.reason] || String(v.reason),
        veredicto: soloAviso.has(v.specRel) ? 'aviso' : 'bloqueo', huella: huella(v.storyId, v.specRel) });
    } catch { /* ayuda, no evidencia */ }
  }
  for (const [specRel, { regla, storyId }] of pasos) {
    try { anotarCierre({ freno: 'on-pre-commit', regla, veredicto: 'paso', huella: huella(storyId, specRel) }); } catch { /* idem */ }
  }
  // Un self-audit incompleto que pasó: UNA línea (aviso), no además un «paso» (una decisión, una línea).
  for (const a of avisosSelfAudit) {
    if (violations.some((v) => v.specRel === a.specRel)) continue;
    try { anotarCierre({ freno: 'on-pre-commit', regla: 'self-audit', veredicto: 'aviso', huella: huella(a.storyId, a.specRel) }); } catch { /* idem */ }
  }
}

// ACCOV-C8 — chequear self-audit file existe + tiene secciones mandatorias.
// Devuelve { exists, missingSections, valid, allAudits }.
// `opts.storyPath`: el autoexamen se busca por la CLAVE de la evidencia, como el resto — con un número
// repetido en el repo, `<id>-self-audit-iterN.md` es el de cualquiera de las stories que lo comparten. Sin clave
// decidible, no hay autoexamen que mirar.
function checkSelfAudit(cwd, storyId, opts = {}) {
  // Buscar TODOS los self-audits (iter1, iter2, ..., y el "sin numerar" legacy).
  const evidenceDirs = dodEvidenceDirsFor(cwd);
  const audits = []; // { path, iter, mtime }
  let clave = storyId;
  if (opts.storyPath) {
    const k = require('./lib/evidence-key.js').keyOr(opts.storyPath, storyId);
    if (!k.key) return { exists: false, keyError: k.error, expectedPaths: [] };
    clave = k.key;
  }
  // La clave puede traer `+` (lib/evidence-key.js codifica así lo que no entra en un nombre): se escapa.
  const claveRe = String(clave).replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
  const iterRe = new RegExp(`^${claveRe}-self-audit(?:-iter(\\d+))?\\.md$`);
  for (const dir of evidenceDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(iterRe);
        if (!m) continue;
        const iter = m[1] ? parseInt(m[1], 10) : 0; // sin numerar = 0 (legacy)
        const full = path.join(dir, f);
        audits.push({ path: full, iter, mtime: fs.statSync(full).mtimeMs });
      }
    } catch {
      // ignore
    }
  }
  if (audits.length === 0) {
    return { exists: false, expectedPaths: evidenceDirs.map(d =>
      path.join(d, `${clave}-self-audit-iter1.md`)) };
  }
  // Dedupe by absolute (realpath) path — evidenceDirs puede contener paths
  // que resuelven al mismo directorio (cwd + sibling spec root colapsando al
  // mismo lugar bajo symlinks o monorepos). Sin dedupe, el mismo archivo
  // entra 2 veces y `previous` termina siendo el mismo iter que `latest`,
  // haciendo que convergencia compare iter N consigo mismo → falsos verdes.
  const seenPaths = new Set();
  const dedupedAudits = audits.filter(a => {
    let canonical;
    try {
      canonical = fs.realpathSync(a.path);
    } catch {
      canonical = a.path;
    }
    if (seenPaths.has(canonical)) return false;
    seenPaths.add(canonical);
    return true;
  });
  // Ordenar por iter desc, mtime desc como tiebreaker.
  dedupedAudits.sort((a, b) => b.iter - a.iter || b.mtime - a.mtime);
  const latest = dedupedAudits[0];
  const previous = dedupedAudits.length > 1 ? dedupedAudits[1] : null;

  const content = fs.readFileSync(latest.path, 'utf8');
  // 5 secciones mandatorias del template ACCOV-C8.
  const requiredSections = [
    /##\s+1\.\s+Cobertura por AC/i,
    /##\s+2\.\s+Cobertura por interacci[oó]n/i,
    /##\s+3\.\s+Gaps conocidos/i,
    /##\s+4\.\s+Verificaci[oó]n de no-regresi[oó]n/i,
    /##\s+5\.\s+Confianza del agente/i,
  ];
  const missing = requiredSections
    .map((re, i) => re.test(content) ? null : `section ${i + 1}`)
    .filter(Boolean);

  return {
    exists: true,
    path: latest.path,
    iter: latest.iter,
    previousPath: previous ? previous.path : null,
    previousIter: previous ? previous.iter : null,
    missingSections: missing,
    valid: missing.length === 0,
    allAudits: dedupedAudits,
  };
}

// ACCOV-C10 — convergencia entre iter N y iter N-1.
// Extrae el set de gaps de §3 del self-audit y compara con iter previa.
// Devuelve { converged, newGaps, removedGaps } o null si no hay previa.
function checkSelfAuditConvergence(currentPath, previousPath) {
  if (!previousPath) return null; // no hay base para comparar
  const current = fs.readFileSync(currentPath, 'utf8');
  const previous = fs.readFileSync(previousPath, 'utf8');
  const gapsCurrent = extractGapsFromSelfAudit(current);
  const gapsPrev = extractGapsFromSelfAudit(previous);
  const setPrev = new Set(gapsPrev.map(g => g.toLowerCase()));
  const newGaps = gapsCurrent.filter(g => !setPrev.has(g.toLowerCase()));
  const setCurrent = new Set(gapsCurrent.map(g => g.toLowerCase()));
  const removedGaps = gapsPrev.filter(g => !setCurrent.has(g.toLowerCase()));
  return {
    converged: newGaps.length === 0,
    newGaps,
    removedGaps,
    countCurrent: gapsCurrent.length,
    countPrev: gapsPrev.length,
  };
}

// Extrae nombres de gaps de §3 de un self-audit.
// Heurística: dentro de la sección que empieza con `## 3. Gaps conocidos`,
// busca tabla rows con primer columna `Gap` o bullets `**X — desc**`.
function extractGapsFromSelfAudit(content) {
  const sectionMatch = content.match(/##\s+3\.\s+Gaps conocidos[\s\S]*?(?=\n##\s+\d+\.|$)/i);
  if (!sectionMatch) return [];
  const section = sectionMatch[0];
  const gaps = new Set();
  // Pattern 1: rows de tabla markdown `| **X — descripción** | ...`
  // El "key" del gap es la primera letra/palabra antes del em-dash o guión.
  const tableRowRe = /\|\s*\*\*([A-Z][A-Z0-9]*)\s*[—\-]/g;
  let m;
  while ((m = tableRowRe.exec(section)) !== null) {
    gaps.add(m[1].trim().toUpperCase());
  }
  // Pattern 2: bullets `- **X — descripción**` o `- Gap X:`
  const bulletRe = /(?:^|\n)\s*-\s+(?:\*\*)?(?:Gap\s+)?([A-Z][A-Z0-9]*)\s*[:—\-]/g;
  while ((m = bulletRe.exec(section)) !== null) {
    gaps.add(m[1].trim().toUpperCase());
  }
  return [...gaps];
}

// Parsea los ACs declarados en la spec — DELEGA en lib/story-checks.js (fuente única).
// Una copia local que sólo matchee `N. **Given**` cuenta
// 8 de 22 ACs (los de error/regresión son `N. **Etiqueta:** texto`) → el check por-AC
// de la evidencia validaría contra un universo subcontado en silencio. La lib une los
// patrones (Given + bold-label + bullets).
// Si la lib no carga devuelve `null` («no pude leer»), nunca una cuenta propia: una copia local de la expresión queda
// atrás cuando el lector cambia, y una cuenta de menos es un verde falso. Quien llama trata `null` como «sin criterios» y frena el cierre; el error queda en el registro.
// `opts.cargar` y `opts.logPath` existen para la prueba de ese camino.
function parseAcsFromSpec(specContent, opts = {}) {
  if (!specContent) return [];
  const cargar = opts.cargar || (() => require(path.join(__dirname, 'lib', 'story-checks.js')));
  try {
    return cargar().parseAcsFromSpec(specContent).map((n) => `#${n}`);
  } catch (e) {
    try {
      fs.appendFileSync(
        opts.logPath || path.join(stateDirOf(os.homedir()), 'hook-errors.log'),
        `[${new Date().toISOString()}] on-pre-commit.js: lib/story-checks.js no cargó (${e.message}) — sin lector de criterios: la story cuenta como sin criterios.\n`,
        'utf8',
      );
    } catch { /* best effort */ }
    return null;
  }
}

// Parsea ACs que la evidencia DoD declara haber verificado.
// Soporta: "AC #N", "AC #N/#M" (heading combinado), "ACs #N, #M",
// "(AC #N)". El segundo número en `AC #N/#M` también cuenta.
function parseAcsFromEvidence(evidenceContent) {
  if (!evidenceContent) return [];
  const acs = new Set();
  // Pattern 1: any "AC #N" — captura el primero.
  const re1 = /AC\s*#(\d+)/g;
  let m;
  while ((m = re1.exec(evidenceContent)) !== null) {
    acs.add(`#${m[1]}`);
  }
  // Pattern 0: los tags `@ac-N` del gate E2E (`e2e-gate.sh` escribe los títulos de
  // Playwright tal cual, `@story-m-10 @ac-1`). Dos generadores del mismo pipeline, dos formatos —
  // y este lector sólo entiende uno: si el archivo que gana es el del gate E2E, lee 0 criterios
  // y bloquea un commit legítimo. El formato del gate E2E NO se cambia:
  // es el contrato con los specs de Playwright, una superficie más grande.
  const re0 = /@ac-(\d+)\b/gi;
  while ((m = re0.exec(evidenceContent)) !== null) {
    acs.add(`#${m[1]}`);
  }
  // Pattern 2: "AC #N/#M" o "AC #N, #M" o "AC #N + #M" — captura SEGUNDO+.
  // Match: "AC #" + digit(s) + (/ or , or +) + space? + # + digit(s).
  const re2 = /AC\s*#\d+(?:\s*[/,+]\s*#(\d+))+/g;
  while ((m = re2.exec(evidenceContent)) !== null) {
    // Re-scan the match for ALL `#N` in it (not just last capture).
    const inner = m[0];
    const all = inner.match(/#(\d+)/g) || [];
    for (const x of all) acs.add(x);
  }
  return [...acs];
}

// Dónde se buscaron los criterios que faltan, para el mensaje del freno: las tres fuentes de la unión,
// con la ruta real de cada una. Sale de la matriz ya calculada; si no corrió, se dice por qué.
function fuentesBuscadas(calc) {
  if (!calc || calc.error) return { error: calc && calc.error ? String(calc.error.message || calc.error) : 'la matriz no corrió' };
  const m = calc.matrix;
  if (!m || m.structuralError) return { error: m ? m.structuralError : 'la matriz no devolvió nada' };
  if (m.exempt) return { error: 'la story está exenta de la matriz (dod_runtime_exempt)' };
  const clave = m.key || m.sid;
  const dirs = m.evidenceDirs || [];
  const existentes = (re) => dirs.flatMap((d) => {
    try { return fs.readdirSync(d).filter((f) => re.test(f)).map((f) => path.join(d, f)); } catch { return []; }
  });
  const escapar = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    registros: existentes(new RegExp(`^${escapar(clave)}-smoke-ledger\\.jsonl$`)),
    gates: existentes(new RegExp(`^${escapar(clave)}-e2e-gate-.*\\.md$`)),
    firmas: m.repoRoot ? path.join(m.repoRoot, '.tycon', 'runtime-waivers.jsonl') : null,
    clave,
  };
}

// ============================================================
// Secretos en `.advisors/dod-runtime/`
// ============================================================
// Los registros de prueba de humo pueden traer contraseñas SQL escritas tal cual
// (incluida la de una base de PRODUCCIÓN): smoke-run.sh las tapa, pero un registro escrito a mano, uno
// anterior o una matriz copiada no pasan por ahí. Este freno mira lo que se va a commitear en esa carpeta con
// las MISMAS formas que tapa lib/smoke-secrets.js, y frena si alguna trae un valor que no es `***` ni una
// variable. El mensaje dice archivo, línea y forma — nunca el valor.
//
// Mira lo stageado Y lo que está cambiado o sin seguir en el árbol de trabajo: con `git add -A && git commit` en un
// solo comando, o con `git commit -a`, el hook corre ANTES de que se stagee nada.
// Un secreto sin stagear en esta carpeta igual frena: va a viajar con el próximo commit que la toque.
// Límite conocido: `git -C <otro repo>` y `cd <otro repo> &&` se miran desde la carpeta de la sesión, como el
// resto de este hook; ese hueco lo cubre el buscador de secretos del pipeline.
function frenoSecretosEnEvidencia(event) {
  const cwd = event.cwd || process.cwd();
  let hallazgos = [];
  try {
    const smokeSecrets = require('./lib/smoke-secrets.js');
    const git = (args) => execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    });
    let raiz;
    try { raiz = git(['rev-parse', '--show-toplevel']).trim(); } catch { return; /* no es un repo: nada que commitear */ }
    const vistos = new Set();
    // 1) lo stageado, leído del índice (es lo que entra al commit).
    for (const f of git(['diff', '--cached', '--name-only', '--diff-filter=d', '-z']).split('\0')) {
      if (!f || !smokeSecrets.isEvidencePath(f)) continue;
      for (const h of smokeSecrets.findLeaksInContent(git(['show', `:${f}`]))) {
        vistos.add(`${f}:${h.line}:${h.form}`);
        hallazgos.push({ archivo: f, ...h });
      }
    }
    // 2) lo cambiado o nuevo en el árbol, leído del disco.
    for (const linea of git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0')) {
      const f = linea.slice(3);
      // Un archivo stageado con cambios sin stagear se mira de nuevo: `git commit -a` se lleva la versión del disco.
      if (!f || linea[1] === 'D' || linea[1] === ' ' || !smokeSecrets.isEvidencePath(f)) continue;
      let contenido;
      try { contenido = fs.readFileSync(path.join(raiz, f), 'utf8'); } catch { continue; }
      for (const h of smokeSecrets.findLeaksInContent(contenido)) {
        if (!vistos.has(`${f}:${h.line}:${h.form}`)) hallazgos.push({ archivo: f, ...h });
      }
    }
  } catch (e) {
    process.stderr.write(`⚠ tycon-dod-runtime: el freno de secretos en la evidencia no pudo correr (${e.message}) — NO aplicado.\n`);
    return;
  }
  if (hallazgos.length === 0) return;
  try {
    const stateDir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
      ts: new Date().toISOString(), name: 'smoke-secrets', action: 'block', repoPath: cwd,
      sessionId: resolveSessionId(event.session_id), hallazgos: hallazgos.length,
      formas: [...new Set(hallazgos.map((h) => h.form))],
    }) + '\n', 'utf8');
  } catch { /* el log nunca cambia el veredicto */ }
  const lineas = [
    '',
    '🛑 tycon-dod-runtime: hay secretos escritos tal cual en la evidencia (stageada o por stagear).',
    '   `.advisors/dod-runtime/` viaja por git: lo que entre acá llega al remoto y a la historia.',
    '',
    ...hallazgos.slice(0, 20).map((h) => `   ${h.archivo}:${h.line} — ${h.label}`),
    ...(hallazgos.length > 20 ? [`   … y ${hallazgos.length - 20} más`] : []),
    '',
    '   Reemplazá cada valor por *** (o por la variable que lo trae, como "$DB_PASS") y volvé a stagear.',
    '   Las próximas corridas de smoke-run.sh lo tapan solas (lib/smoke-secrets.js).',
    '',
  ];
  process.stderr.write(lineas.join('\n') + '\n');
  process.exit(2);
}

// Ver lib/chained-add.js. Deja `process.env.GIT_INDEX_FILE` apuntando a la copia del índice con los `add` aplicados,
// o —si no se pudieron simular— una nota que sale SÓLO si el freno termina frenando (exit 2). Nunca cambia el índice
// real, y un error propio deja todo como antes (se mira lo stageado).
function prepararIndiceConLosAdd(command, cwd) {
  let plan;
  try { plan = require('./lib/chained-add.js').addsBeforeCommit(command, (seg) => isGitCommit(seg)); } catch { return; }
  if (!plan || plan.estado === 'sin-add') return;
  const notaAlFrenar = (texto) => process.on('exit', (code) => {
    if (code === 2) { try { fs.writeSync(2, texto); } catch { /* la nota nunca cambia el veredicto */ } }
  });
  const pedirAddAparte = (motivo) => notaAlFrenar(
    `\nℹ️  Este comando trae un \`git add\` antes del commit, y el freno corre ANTES que el comando entero:\n` +
    `   lo de arriba se evaluó sobre lo stageado HOY, sin lo que trae ese \`add\` (${motivo}).\n` +
    '   Si el `add` ya arregla lo que dice arriba, corré el `git add` en una llamada aparte y después el commit.\n');
  if (plan.estado !== 'simulable') { pedirAddAparte(plan.motivo); return; }
  let copia;
  try {
    const git = (args, env) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env });
    const indice = path.resolve(cwd, git(['rev-parse', '--git-path', 'index']).trim());
    copia = path.join(os.tmpdir(), `tycon-precommit-index-${process.pid}-${Date.now()}`);
    if (fs.existsSync(indice)) fs.copyFileSync(indice, copia);
    process.on('exit', () => { try { fs.unlinkSync(copia); } catch { /* temporal */ } });
    for (const args of plan.adds) git(['add', ...args], { ...process.env, GIT_INDEX_FILE: copia });
  } catch (e) {
    // El `add` falla igual en el comando real (con `&&` el commit no corre). Se mira lo stageado hoy y se avisa.
    const det = String((e && (e.stderr || e.message)) || e).split('\n').find((l) => l.trim()) || 'error de git';
    pedirAddAparte(`no se pudo reproducir: ${det.trim().slice(0, 120)}`);
    return;
  }
  process.env.GIT_INDEX_FILE = copia;
  notaAlFrenar(`\nℹ️  Evaluado sobre lo que quedaría stageado después de los \`git add\` de este mismo comando (${plan.adds.map((a) => `git add ${a.join(' ')}`).join(' · ')}).\n`);
}

// ============================================================
// Main
// ============================================================
function main() {
  const event = readEvent();
  if (!event) {
    process.exit(0);
  }

  // Bash, o la herramienta PowerShell con que Claude Code corre los comandos en Windows (misma entrada,
  // tool_input.command; con matcher `Bash` solo, este portón no se dispara ahí).
  if (event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') {
    process.exit(0);
  }

  const command = event.tool_input?.command || '';
  // Detectar `git commit` (no amend a un commit existente, no log, no status).
  // Atrapamos: `git commit`, `git commit -m`, `git commit -F`, `git -C ... commit ...`.
  // Excluimos: `git commit --amend` (es modificación, no transición), aunque
  // podríamos extender después.
  const isCommit = isGitCommit(command);
  if (!isCommit) {
    process.exit(0);
  }

  // Una ejecución abierta a la que le falta una pieza no commitea (lib/open-runs.js): ni `--no-verify` la saltea, la
  // salida es del dueño. No poder preguntar no es estar sana.
  {
    const or = require('./lib/open-runs.js');
    const sessionId = resolveSessionId(event.session_id);
    let p;
    try { p = or.perdida({ sid: sessionId, cwd: event.cwd || process.cwd() }); } catch (e) {
      p = { caso: 'ilegible', falta: `no pude revisar las piezas de la ejecución (${e.message})`, sesion: String(sessionId) };
    }
    if (p) {
      process.stderr.write(or.cartel(p, { markerJs: path.join(__dirname, 'marker.js') }) + '\n');
      process.exit(2);
    }
  }

  // `git add X && git commit` en una sola línea: el freno corre antes que el comando entero, así que lo
  // stageado todavía no tiene lo que traen esos `add`. Si se pueden reproducir igual que el shell, el resto del freno
  // evalúa una COPIA del índice con los `add` ya aplicados (GIT_INDEX_FILE: lo heredan todos los `git` de este hook);
  // si no, mira lo stageado hoy y, si frena, dice que corra el `add` aparte. Motivo y límites: lib/chained-add.js.
  prepararIndiceConLosAdd(command, event.cwd || process.cwd());

  // Secretos en la evidencia: va ANTES del `--no-verify`, que no lo saltea. Una contraseña commiteada llega al
  // remoto y a la historia; no hay apuro que lo justifique, y la salida es escribir `***` o una variable.
  frenoSecretosEnEvidencia(event);

  // Escape hatch estándar de git: --no-verify saltea hooks. Si user/agente
  // lo usa explícitamente, dejamos pasar pero queda rastro DURABLE en bypass.log
  // (solo stderr efímero: imposible auditar bypasses). También su prefijo inequívoco (`--no-veri`, `--no-verif`), que
  // git acepta igual; `--no-ver` choca con `--no-verbose` y git lo rechaza.
  if (usaNoVerify(command)) {
    console.error('⚠ tycon-dod-runtime: --no-verify detected, skipping DoD gate (had_dod_bypass=true, logueado en bypass.log)');
    try {
      const stateDir = path.join(stateDirOf(os.homedir()));
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(
        path.join(stateDir, 'bypass.log'),
        JSON.stringify({
          ts: new Date().toISOString(),
          type: 'GIT_NO_VERIFY',
          sessionId: resolveSessionId(event.session_id),
          cwd: event.cwd || process.cwd(),
          command: command.slice(0, 300),
        }) + '\n',
        'utf8',
      );
    } catch { /* logging nunca rompe el commit */ }
    process.exit(0);
  }

  const cwd = event.cwd || process.cwd();
  // Los avisos del modo FRENO van ACÁ, antes de que cualquier freno pueda cortar: si salieran
  // donde se lee la config, el aviso dependería de qué freno gana la carrera (si el gate de
  // advisors cortara primero, no saldría nunca).
  avisosDeConfigFreno(cwd);

  // ── Gate de ATDD fuera del pipeline ────────────────────────────────────────────
  // El gate de `marker.js complete-step implement` sólo ve corridas del pipeline: lee
  // `marker.fileEvents`. Trabajando a mano no hay marker, así que nada mira el orden
  // test↔código: es el agujero por el que se cuela una sesión sin pipeline.
  // Acá se computa el MISMO veredicto (lib/atdd-order.js reusado) sobre los eventos que on-edit
  // registra siempre. Avisa por default; bloquea sólo si el repo lo pidió. Nunca rompe el commit
  // por un error propio.
  try {
    const atddCommit = require('./lib/atdd-commit-gate.js');
    const { computeAtddOrder } = require('./lib/atdd-order.js');
    const { findRepoRoot } = require('./lib/story-discovery.js');

    const stateDir = path.join(stateDirOf(os.homedir()));
    const sessionId = resolveSessionId(event.session_id);
    const repoRoot = findRepoRoot(cwd);

    if (repoRoot) {
      const events = atddCommit.eventsForRepo(stateDir, sessionId, repoRoot);
      const verdict = computeAtddOrder(events);
      const mode = atddCommit.resolveMode(repoRoot, process.env);
      const decision = atddCommit.computeCommitGate({ verdict, mode });

      // Se mide siempre: "cuántos commits llevan los tests después" es un dato, no una impresión.
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.appendFileSync(
          path.join(stateDir, 'gates.log'),
          JSON.stringify({
            ts: new Date().toISOString(),
            name: 'atdd-commit',
            action: decision.action,
            mode,
            repoRoot,
            // Namespace por repo: misma key que marker.js — el capturer
            // agrupa por `repoPath`; `repoRoot` queda por compatibilidad con lectores viejos.
            repoPath: repoRoot,
            sessionId,
            events: events.length,
            verdict: verdict.verdict,
            firstImpl: verdict.firstImpl || null,
            firstTest: verdict.firstTest || null,
          }) + '\n',
          'utf8',
        );
      } catch { /* el log nunca rompe el commit */ }

      // ── Código que entra DESPUÉS de la última ronda de revisores ────────────────
      // Caso que cubre: una migración escrita horas después de la
      // última ronda entra sin otra revisión (lib/post-revision.js). Va ANTES de cualquier freno de este
      // hook: tiene que salir aunque otro control corte el commit. AVISA, nunca frena, y lo mide.
      try {
        const markerFile = path.join(stateDir, 'active', `${require('./lib/session-id.js').sessionIdFileKey(event.session_id)}.json`);
        const marker = fs.existsSync(markerFile) ? JSON.parse(fs.readFileSync(markerFile, 'utf8')) : null;
        if (marker && marker.iterations && Object.keys(marker.iterations).length) {
          const postRevision = require('./lib/post-revision.js');
          const r = postRevision.archivosSinRevisar({
            iterations: marker.iterations,
            events,
            staged: getStagedDiff(cwd).split('\n').filter(Boolean),
            repoRoot,
          });
          if (r && r.archivos.length) {
            console.error(postRevision.mensaje(r));
            try {
              fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
                ts: new Date().toISOString(), sessionId, repoPath: repoRoot, name: 'post-revision-commit',
                storyId: marker.storyId || null, iter: r.iter, iterTs: r.ts, archivos: r.archivos,
              }) + '\n', 'utf8');
            } catch { /* el log nunca rompe el commit */ }
          }
        }
      } catch { /* el aviso nunca rompe el commit */ }

      if (decision.action === 'block') {
        console.error(`🔴 tycon-atdd-commit BLOQUEADO\n${decision.message}\n` +
          `Escape: TYCON_ATDD_COMMIT_GATE=off git commit ...  (queda en bypass.log)`);
        atddCommit.pruneFileEvents(stateDir, sessionId, repoRoot);
        process.exit(2);
      }
      if (decision.action === 'warn') {
        console.error(`⚠ tycon-atdd-commit\n${decision.message}`);
      }
      // ── Guía de QA ──────────────────────────────────────────────────────────
      // Si el commit incluye una story con ACs, la guía de prueba manual tiene que estar
      // generada y al día. AVISA (no frena) — generarla sola escondería que
      // se trabaja fuera del pipeline.
      try {
        for (const rel of getStagedDiff(cwd).split('\n').filter((f) => f.endsWith('.md'))) {
          const storyAbs = path.join(repoRoot, rel);
          if (!fs.existsSync(storyAbs)) continue;
          const content = fs.readFileSync(storyAbs, 'utf8');
          // el título de criterios lo encuentra story-checks.js, con cualquier forma
          if (!require('./lib/story-checks.js').storySection(content, 'criteria')) continue;

          // Mismo disparador que el gate de evidencia: la guía se exige cuando la story se
          // declara lista, no en el commit donde recién se la escribe.
          const evGate0 = require('./lib/story-evidence-gate.js');
          if (!evGate0.shouldCheckEvidence(
            (getHeadFileContent(cwd, rel).match(/^status:\s*(\S+)/m) || [])[1],
            (content.match(/^status:\s*(\S+)/m) || [])[1])) continue;

          const guidePath = atddCommit.qaGuidePathFor(storyAbs);
          const guideExists = fs.existsSync(guidePath);
          // La guía se pide sólo si hay una superficie que una PERSONA pueda operar (pantalla o
          // HTTP) — en una librería cuyo único cliente es un agente, la guía habla de "usuarios" y
          // "roles" que no existen, y el aviso se aprende a ignorar. El repo puede forzar o apagar
          // el comportamiento con `qa_guide:` en .tycon/advisors.yaml. Ambas lecturas son
          // fail-open: si el archivo no está o no se puede leer, se usa el default.
          // 🔴 Modo FRENO: `qa_guide: off` APAGA un aviso, así que se lee
          // de lo COMMITEADO. Escribirlo en la carpeta no alcanza — apagar es aflojar.
          const advisorsYaml = configFreno(cwd);
          const mode = atddCommit.qaGuideMode(advisorsYaml);
          const handOperable = atddCommit.storyIsHandOperable(content, cwd);
          const status = atddCommit.computeQaGuideStatus({
            hasAcs: true,
            guideExists,
            guideOlderThanStory: guideExists &&
              fs.statSync(guidePath).mtimeMs < fs.statSync(storyAbs).mtimeMs,
            handOperable,
            mode,
          });
          // 🔴 La constancia anota los CUATRO resultados. Con sólo `missing` y `stale`, el tablero
          // del arnés publicaría «0 guías presentes»: un cero por construcción. `computeQaGuideStatus` devuelve
          // `ok` tanto si la guía está al día como si no aplica; la distinción se calcula acá con los
          // MISMOS insumos, sin tocar esa función. `esquema: 2` marca el registro completo: la cuenta
          // sólo arma la proporción con estas líneas — las que no lo traen no tienen el `presente`.
          // 🔴 `clave`: esta línea se escribe en CADA INTENTO de commit,
          // antes de frenos de este mismo hook que pueden cortarlo con exit 2. Sin una identidad del
          // cierre, tres rebotes contarían como tres cierres y la proporción mediría intentos. La clave es
          // la huella de repo + story + contenido de la story —SIN el estado: identifica el CIERRE, no su
          // resultado—; el mismo cierre reintentado da la misma clave, y el reductor cuenta su ÚLTIMO
          // resultado (un rebote «missing» que vuelve «presente» tras generar la guía es «presente»).
          // Una huella, no el contenido: no viaja texto.
          const clave = require('crypto').createHash('sha256')
            .update(`${repoRoot}\0${rel}\0${content}`).digest('hex').slice(0, 16);
          const anotar = (estado, accion) => {
            try {
              fs.appendFileSync(
                path.join(stateDir, 'gates.log'),
                JSON.stringify({ ts: new Date().toISOString(), sessionId, repoPath: repoRoot, name: 'qa-guide', action: accion, status: estado, story: storyAbs, esquema: 2, clave }) + '\n',
                'utf8',
              );
            } catch { /* el log nunca rompe el commit */ }
          };
          if (status === 'ok') {
            const aplica = mode !== 'off' && (mode === 'always' || handOperable);
            anotar(aplica ? 'presente' : 'no-aplica', 'none');
            continue;
          }

          console.error(`⚠ tycon-qa-guide\n${atddCommit.qaGuideMessage(status, { storyPath: storyAbs, guidePath })}`);
          anotar(status, 'warn');
        }

        // ── Evidencia de la story: ni un AC salteado, ni pasos de tester faltantes, ni una
        // story de interfaz sin verificación en navegador REGISTRADA.
        for (const rel of getStagedDiff(cwd).split('\n').filter((f) => f.endsWith('.md'))) {
          const storyAbs = path.join(repoRoot, rel);
          if (!fs.existsSync(storyAbs)) continue;
          const content = fs.readFileSync(storyAbs, 'utf8');
          if (!require('./lib/story-checks.js').storySection(content, 'criteria')) continue;

          const evGate = require('./lib/story-evidence-gate.js');
          // Sólo cuando alguien AFIRMA que la story está lista (review/done). En cada commit
          // sería ruido: la story recién escrita no tiene nada verificado por definición.
          if (!evGate.shouldCheckEvidence(
            (getHeadFileContent(cwd, rel).match(/^status:\s*(\S+)/m) || [])[1],
            (content.match(/^status:\s*(\S+)/m) || [])[1])) continue;

          const qa = require('./qa-guide.js');
          const rm = require('./runtime-matrix.js');
          const matrix = rm.compute({ storyPath: storyAbs });
          if (matrix.structuralError) continue;

          // La guía del tester lleva la clave de la story: con número repetido, dos stories que
          // comparten la carpeta qa/ escribirían y leerían el mismo archivo.
          const pasosPath = path.join(require('./lib/qa-dir.js').qaDirFor(storyAbs, [matrix.key, matrix.sid]),
            `${matrix.key || matrix.sid}-pasos.md`);
          const pasosMd = fs.existsSync(pasosPath) ? fs.readFileSync(pasosPath, 'utf8') : null;

          const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          const ledgerCmds = [];
          for (const dir of matrix.evidenceDirs || []) {
            const f = path.join(dir, `${matrix.key || matrix.sid}-smoke-ledger.jsonl`);
            if (!fs.existsSync(f)) continue;
            for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
              try { const e = JSON.parse(line); if (e.exit === 0) ledgerCmds.push(e.cmd); } catch { /* línea rota */ }
            }
          }

          // Los pasos de tester se piden sólo si la guía de QA aplica en este repo y esta story —
          // el MISMO criterio que usa el generador de la guía unos renglones más arriba. Sin esto,
          // la escotilla `qa_guide: off` (y el `auto` que mira si hay algo operable a mano) apagaría
          // el generador pero no este aviso: media escotilla, que es peor que ninguna.
          const advisorsYamlEv = configFreno(cwd);   // modo FRENO — ver arriba
          const pidePasos = evGate.pidePasosDeTester({
            qaGuideMode: atddCommit.qaGuideMode(advisorsYamlEv),
            handOperable: atddCommit.storyIsHandOperable(content, cwd),
          });

          const esUi = qa.isUiStory(content, fmMatch ? fmMatch[1] : '', cwd);

          // El modelo de navegación puede cambiar DESPUÉS de que se
          // escriben las pantallas, y WIRING-C5 sólo mira código nuevo contra el documento, no
          // al revés. Va ACÁ y no en el bloque de abajo a propósito: tiene que salir aunque la
          // evidencia de la story esté impecable — son cosas distintas. Aviso, nunca freno; se
          // levanta solo cuando el revisor de wiring vuelva a correr en este repo.
          if (esUi && !_navAvisado) {
            _navAvisado = true;
            try {
              const avisoNav = require('./lib/navigation-drift.js').avisoPendiente(repoRoot);
              if (avisoNav) console.error(avisoNav);
            } catch { /* el aviso nunca rompe el commit */ }
          }

          const decision = evGate.computeStoryEvidenceGate({
            pendientes: matrix.pendientes || [],
            acsSinPasos: pidePasos ? evGate.acsSinPasos(matrix.acs || [], pasosMd) : [],
            isUi: esUi,
            hasBrowserEvidence: ledgerCmds.some(evGate.looksLikeBrowserRun),
            // 🔴 LLAVE PROPIA. Apagar «la prueba antes que el código» (gate de ATDD) no debe
            // apagar también este aviso de criterios sin verificar.
            mode: atddCommit.resolveEvidenceMode(repoRoot, process.env),
          });

          if (decision.action === 'pass') continue;

          console.error(`${decision.action === 'block' ? '🔴' : '⚠'} tycon-story-evidence — ${path.basename(storyAbs)}\n${decision.message}`);
          try {
            fs.appendFileSync(
              path.join(stateDir, 'gates.log'),
              JSON.stringify({ ts: new Date().toISOString(), sessionId, repoPath: repoRoot, name: 'story-evidence', action: decision.action,
                story: storyAbs, hallazgos: decision.hallazgos.length }) + '\n',
              'utf8',
            );
          } catch { /* el log nunca rompe el commit */ }
          if (decision.action === 'block') {
            atddCommit.pruneFileEvents(stateDir, sessionId, repoRoot);
            process.exit(2);
          }
        }
      } catch { /* el chequeo de la guía nunca rompe el commit */ }

      // Lo commiteado ya se juzgó: se descartan SOLO los eventos de este repo, para no dejar
      // sin evidencia al próximo commit en otro repo de la misma sesión.
      atddCommit.pruneFileEvents(stateDir, sessionId, repoRoot);
    }
  } catch { /* el gate de ATDD nunca rompe el commit por un error suyo */ }

  const diffFiles = getStagedDiff(cwd).split('\n').filter(Boolean);

  // Qué archivo del diff es una story lo decide su FRONTMATTER, no su ruta.
  // Un filtro por ruta (`/specs\/stories\/[^/]+\.md$/`) en un repo con otro layout (`specs/<tema>/`)
  // no matchea nunca, así que este gate —el que impide pasar una story a `done` sin evidencia—
  // estaría apagado para todo el repo y el commit saldría derecho, sin un solo mensaje.
  // 🔴 Modo FRENO: la config se lee de lo COMMITEADO **y** de la
  // carpeta, en UNIÓN. Si se leyera sólo la carpeta, escribir un `stories.id_pattern`
  // imposible —sin commitear, sin rastro en ningún commit— haría que ninguna story fuera una story
  // y este gate desaparecería con exit 0 y cero mensajes. Recortar el alcance del freno
  // exige un commit; ampliarlo vale al toque.
  const idPattern = storiesConfigForGate(cwd).idPattern;
  const stagedByFile = new Map();
  const specFiles = selectStorySpecs(diffFiles, (f) => getStagedFileContent(cwd, f), idPattern, stagedByFile);

  if (specFiles.length === 0) {
    process.exit(0);
  }

  // La ruta REAL de cada spec sale de la RAÍZ del repo: `specRel` viene de `git diff --cached --name-only`, que es
  // relativo a la raíz, no a la carpeta desde donde se commitea. Con `join(cwd, specRel)`, un commit lanzado desde una
  // subcarpeta calcula la clave de una story que no existe y frena un cierre válido;
  // el mismo error puede estar en la matriz y la evidencia.
  const raizDelRepo = require('./lib/story-discovery.js').findRepoRoot(cwd) || cwd;
  const rutaDeSpec = (rel) => path.join(raizDelRepo, rel);

  // La matriz por AC (runtime-matrix.js) se calcula UNA vez por story y la usan dos chequeos: el de evidencia por AC
  // (la unión de las tres fuentes) y DODRT-C6. Sobre el contenido STAGED (lo que se está por commitear),
  // no el working tree — un ack agregado sin stagear no cuenta. `{ error }` si no corrió: cada chequeo decide qué
  // hacer con eso (C6 sigue fail-open logueado; el de evidencia vuelve a mirar sólo el archivo).
  const matrices = new Map();
  const matrizDe = (specRel, staged) => {
    if (matrices.has(specRel)) return matrices.get(specRel);
    let out;
    try {
      const rm = require(path.join(__dirname, 'runtime-matrix.js'));
      const specAbs = rutaDeSpec(specRel);
      const tmpSpec = path.join(os.tmpdir(), `tycon-precommit-${process.pid}-${path.basename(specRel)}`);
      fs.writeFileSync(tmpSpec, staged, 'utf8');
      // El workspace se descubre desde el path REAL de la story (el tmp vive en /tmp):
      let workspaceRoot = null;
      let wsDir = path.dirname(specAbs);
      for (let i = 0; i < 6 && wsDir !== '/'; i++) {
        if (path.basename(wsDir) === 'specs') { workspaceRoot = path.dirname(path.dirname(wsDir)); break; }
        wsDir = path.dirname(wsDir);
      }
      try {
        // repoRoot explícito: el cómputo corre sobre una COPIA tmp del spec (contenido staged)
        // y la discovery de repo desde /tmp no puede ver el repo real — sin esto, la matriz
        // degradaría a fail-closed (0 evidencia) con la evidencia intacta en disco.
        out = { rm, specAbs, matrix: rm.compute({ storyPath: tmpSpec, keyStoryPath: specAbs, workspaceRoot, repoRoot: rm.discoverRepoRoot(specAbs) }) };
      } finally {
        try { fs.unlinkSync(tmpSpec); } catch { /* best effort */ }
      }
    } catch (e) {
      out = { error: e };
    }
    matrices.set(specRel, out);
    return out;
  };

  // Para cada spec en el diff, detectar transición crítica de status/pipelines.
  const violations = [];
  const soloAviso = new Set();   // specs cuya transición es la interna `review → done` (aviso, no freno)
  const pasos = new Map();       // constancia: specRel → { regla, storyId } de lo que se deja pasar
  const estadoDe = new Map();    // constancia: specRel → estado nuevo (para la huella)
  const avisosSelfAudit = [];    // ACCOV-C8 opcional: self-audits presentes e incompletos — avisan, no frenan

  for (const specRel of specFiles) {
    const staged = stagedByFile.get(specRel) ?? getStagedFileContent(cwd, specRel);
    const head = getHeadFileContent(cwd, specRel);

    if (!staged) continue;

    const stagedFm = parseFrontmatter(staged);
    const headFm = parseFrontmatter(head);

    const storyId = stagedFm.story || path.basename(specRel, '.md');
    estadoDe.set(specRel, String(stagedFm.status || '').toLowerCase());

    // Trigger 1: status transition.
    // 🔴 `review → done` también se juzga. Sólo
    // contar la ENTRADA a {review, done} desde afuera deja la transición interna sin disparar
    // advisors, ni roster, ni evidencia: el hook sale 0 y mudo aunque el roster esté mal.
    // Entra AVISANDO: medido contra el historial, un freno pararía el 100 % de los
    // `review → done`, no por estar mal sino porque sus dos requisitos —el registro de revisores y
    // la evidencia en el repo de la story— suelen ser de días atrás. Primero se mide cuántas veces
    // avisa, y recién después frena: TYCON_REVIEW_A_DONE=block.
    const critica = isCriticalStatusTransition(headFm.status, stagedFm.status);
    const internaDone = /^review$/i.test(String(headFm.status || '').trim())
      && /^done$/i.test(String(stagedFm.status || '').trim());
    const statusTransition = critica || internaDone;

    // Trigger 2: pipeline block transition — `status: done` indentado (pipelines.X.status)
    // que aparece en el frontmatter staged y NO estaba en HEAD.
    // Scopeado al BLOQUE FRONTMATTER (entre los dos `---`), igual que Capa 2
    // (on-frontmatter-write). Un regex sobre el diff crudo `git diff --cached` tomaría un
    // `+status: done` en prosa o en un code-block como transición: un falso positivo.
    // 🔴 Se calcula ACÁ, antes del advisors-gate y del «sólo aviso».
    // Si estuviera después de dos `continue`, el aviso de `review → done` se marcaría por
    // spec sin saber si en el mismo commit se cierra una tanda. Así, `review → done` +
    // `pipelines.X: in-progress → done` sin evidencia —la última tanda de una story entregada en
    // tandas— pasaría a AVISO, cuando la transición de pipelines bloquea sola.
    const fmBlock = (c) => { const m = c.match(/^---\r?\n([\s\S]*?)\r?\n---/); return m ? m[1] : ''; };
    const headDone = (fmBlock(head).match(/^\s+status:\s*done\b/gm) || []).length;
    const stagedDone = (fmBlock(staged).match(/^\s+status:\s*done\b/gm) || []).length;
    const pipelineTransition = stagedDone > headDone;

    // Sólo aviso cuando lo ÚNICO que pasa es la transición interna: si además se cierra una tanda
    // (`pipelines.X → done`), ésa nunca se juzgó y bloquea como siempre.
    if (internaDone && !critica && !pipelineTransition && !llaveFrena(process.env.TYCON_REVIEW_A_DONE)) soloAviso.add(specRel);

    // Falla cerrada: una story que se cierra sin criterios detectados no tiene contra qué medir la evidencia —con 0
    // criterios no le falta ninguno— y los portones de abajo la darían por buena. Frena acá, una sola
    // vez, antes que ellos. Sólo mira la story del commit que se cierra: una vieja que nadie tocó no frena a nadie.
    if (statusTransition || pipelineTransition) {
      const acsCierre = parseAcsFromSpec(staged);
      if (!acsCierre || !acsCierre.length) {
        let motivo = 'no pude cargar el lector de criterios (lib/story-checks.js)';
        if (acsCierre) { try { motivo = require('./lib/story-checks.js').criteriaOf(staged).reason; } catch { /* queda el de arriba */ } }
        violations.push({ specRel, storyId, statusTransition, pipelineTransition, reason: 'no-criteria', motivo });
        continue;
      }
    }

    // ADVISORS-GATE: a `done` no se llega sin constancia de advisors EN ESTE repo.
    // Va ANTES de la exención de DoD: una story sin superficie runtime (docs/config) igual pasa
    // por advisors (spec-first, validator, security…) cuando corre el pipeline. Escapes del dev:
    // `advisors_exempt: true` + `advisors_exempt_reason:` en el frontmatter, o TYCON_ADVISORS_GATE=off.
    if (statusTransition && String(stagedFm.status || '').toLowerCase() === 'done'
        && process.env.TYCON_ADVISORS_GATE !== 'off'
        && !/^advisors_exempt:\s*true\b/m.test(staged)) {
      // La ruta REAL de la story (no la copia staged): de ahí salen el repo y las hermanas de la clave.
      const adv = findAdvisorsEvidence(cwd, storyId, { storyPath: rutaDeSpec(specRel) });
      if (!adv.found) {
        violations.push({ specRel, storyId, statusTransition, pipelineTransition, reason: 'no-advisors', searched: adv.searched, legacy: adv.legacy });
        continue;
      }
      // ROSTER-GATE ("revisor ≠ autor"): que haya constancia de revisión no dice QUIÉN
      // revisó. Acá —en la máquina, donde vive el registro de spawns reales— se cruza el
      // `review-roster.json` committeado contra ese registro. Es el único lugar del arnés donde el
      // cruce es posible: el portón de CI no ve `~/.claude/`, así que allá sólo se verifica
      // coherencia interna. Un roster que lista revisores que el hook nunca vio spawnear está
      // escrito a mano. Escape del dev, ESCRITO Y COMMITEADO (nunca una variable que no deja
      // rastro): `"sin_testigo": "<motivo>"` dentro del propio roster — viaja en el diff del PR,
      // se ve, y se puede contar. Kill-switch de emergencia: TYCON_ROSTER_GATE=off.
      if (process.env.TYCON_ROSTER_GATE !== 'off') {
        const rg = revisarRosterLocal(cwd, storyId, rutaDeSpec(specRel));
        if (rg && rg.aviso) {
          // Habla, no frena — y con el mismo nombre de regla que el portón, para que el dev pueda
          // buscar una sola cosa. Lo que no se puede es callarlo: el punto de la pieza es que esto
          // se sepa en la máquina y no con el pull request abierto.
          // El aviso nombra al firmante Y la corrida: con varias corridas de la misma story
          // en el repo, saber cuál tiene el desajuste es la mitad de poder arreglarlo.
          for (const pr of (rg.problemas || [])) {
            process.stderr.write(`⚠️  ${pr.regla}: ${pr.detalle}\n`);
          }
          if (rg.runDir) process.stderr.write(`   Corrida: ${rg.runDir}\n`);
          process.stderr.write('   Avisa y no frena (decisión del dev, 2026-09-22). El portón del pull request dice lo mismo.\n'
            + '   Vuelve a frenar, acá y allá, con TYCON_ROSTER_NAMES=block.\n');
        } else if (rg) {
          violations.push({ specRel, storyId, statusTransition, pipelineTransition, ...rg }); continue;
        }
      }
    }

    // Exención explícita (DoD runtime).
    if (storyIsExempt(staged)) {
      if (statusTransition || pipelineTransition) pasos.set(specRel, { regla: 'exenta', storyId });
      continue;
    }

    if (!statusTransition && !pipelineTransition) continue;

    {
      const baja = avisoBajaDePantalla(staged, cwd, diffFiles);
      if (baja) process.stderr.write(`[on-pre-commit] ${specRel}: ${baja}\n`);
    }

    // La story necesita runtime evidence? Buscar markers en el spec staged.
    if (!storyRequiresRuntimeEvidence(staged)) {
      pasos.set(specRel, { regla: 'sin-superficie-runtime', storyId });
      continue;
    }

    // Hay evidencia en .advisors/dod-runtime/<clave>-*.md? (la clave: ver `lib/evidence-key.js`)
    const specAbs = rutaDeSpec(specRel);
    const evidence = findDodEvidence(cwd, storyId, { storyPath: specAbs });
    if (!evidence) {
      const k = require('./lib/evidence-key.js').keyOr(specAbs, storyId);
      violations.push({
        specRel, storyId, statusTransition, pipelineTransition,
        reason: 'no-evidence', evidenceKey: k.key, evidenceKeyError: k.error,
      });
      continue;
    }

    // Capa 5: la evidencia DoD debe cubrir TODOS
    // los ACs declarados en la spec, no solo el "happy path principal".
    // Caso que cubre: el AC #6 de una story, que la evidencia solo menciona como ACs #1-#5 (los que
    // tienen cobertura E2E). Sin coverage runtime real, un bug de SQL llega a producción.
    if (evidence.fallido) {
      violations.push({ specRel, storyId, statusTransition, pipelineTransition, reason: 'evidence-failed', evidencePath: evidence.path });
      continue;
    }
    // Un AC cuenta si lo nombra el archivo elegido O si aparece en la UNIÓN de las tres fuentes que
    // escribe la máquina (registro de pruebas de humo, gates E2E, firmas del dev), con las reglas de validez de la
    // matriz por AC: se reusa su cálculo, no se duplica (lib/closing-evidence.js → coberturaDeLaUnion).
    // Exigir que UN archivo nombre todos los ACs hace rebotar a las stories que reparten la evidencia,
    // y la salida es que el agente redacte un `-cierre.md` con la lista — más falsificable que las tres fuentes.
    // Si la matriz no corre, se mira sólo el archivo y el mensaje lo dice.
    const acsInSpec = parseAcsFromSpec(staged) || [];
    const acsInEvidence = new Set(evidence.esRegistro ? [] : parseAcsFromEvidence(evidence.content));
    const calc = matrizDe(specRel, staged);
    const union = calc.matrix ? coberturaDeLaUnion(calc.matrix) : { porAc: new Map(), cubiertos: new Set() };
    const missingAcs = acsInSpec.filter(ac => !acsInEvidence.has(ac) && !union.cubiertos.has(Number(ac.slice(1))));

    if (missingAcs.length > 0) {
      violations.push({
        specRel, storyId, statusTransition, pipelineTransition,
        reason: 'incomplete-evidence',
        missingAcs,
        evidencePath: evidence.path,
        evidenceEsRegistro: !!evidence.esRegistro,
        fuentes: fuentesBuscadas(calc),
      });
      continue;
    }

    // DODRT-C5.1 — para una story de UI, la evidencia DoD debe venir de un E2E
    // Playwright REAL (no curl/unit). Cierra el agujero de "probada en runtime" con solo curl al
    // backend (una story de UI puede declararse probada sin correr el Playwright de sus ACs).
    // La prueba con navegador que la persona dejó pendiente, con sus dos marcas (lib/browser-test.js): no frena, se dice.
    const deudaNavegador = storyIsUiStory(staged, cwd, diffFiles) && !/playwright|tests\/e2e\/|@story-/i.test(evidence.content)
      ? require('./lib/browser-test.js').debtDeclared({ stateDir: stateDirOf(os.homedir()), storyPath: path.resolve(cwd, specRel), content: staged })
      : null;
    if (deudaNavegador && deudaNavegador.declared) {
      process.stderr.write(`${require('./lib/browser-test.js').debtLine(deudaNavegador)}\n`);
      require('./lib/browser-test.js').recordDebtUse(stateDirOf(os.homedir()), deudaNavegador, 'commit');
    } else if (deudaNavegador) {
      if (deudaNavegador.motivo && !/no declara/.test(deudaNavegador.motivo)) process.stderr.write(`La prueba con navegador pendiente de ${specRel} no vale — ${deudaNavegador.motivo}.\n`);
      violations.push({
        specRel, storyId, statusTransition, pipelineTransition,
        reason: 'no-playwright-evidence',
        evidencePath: evidence.path,
      });
      continue;
    }

    // DODRT-C6 — matriz de verificación runtime POR AC,
    // RE-COMPUTADA EN VIVO desde artefactos de ejecución (no se confía en el .md escrito:
    // todos los checks anteriores validan PROSA que el agente puede redactar; este
    // recalcula qué ACs tienen evidencia de EJECUCIÓN real — gate E2E con exit 0,
    // smokes vía smoke-run.sh — y valida el ack del usuario con hash anti-drift).
    try {
      // OJO: se computa sobre el contenido STAGED (lo que se está por commitear), no el
      // working tree — un ack agregado sin stagear no cuenta. El cálculo es el mismo del chequeo por AC.
      const calcC6 = matrizDe(specRel, staged);
      if (calcC6.error) throw calcC6.error;
      const { rm, specAbs: specAbsC6, matrix } = calcC6;
      if (matrix && matrix.structuralError) {
        violations.push({
          specRel, storyId, statusTransition, pipelineTransition,
          reason: 'matrix-structural',
          detail: matrix.structuralError,
        });
        continue;
      }
      if (matrix && !matrix.green) {
        violations.push({
          specRel, storyId, statusTransition, pipelineTransition,
          reason: 'matrix-red',
          pendientes: matrix.pendientes,
          notRun: matrix.notRun || [],
          notVerifiable: matrix.notVerifiable || [],
          hash: matrix.hash,
          chainOk: matrix.chainOk,
          // las firmas descartadas, y el texto con la ruta REAL (la matriz corrió sobre una copia tmp)
          avisoDescartadas: rm.avisoFirmasDescartadas(matrix, specAbsC6),
        });
        continue;
      }
    } catch (e) {
      // Fail-open logueado (filosofía del hook) — pero NUNCA silencioso.
      try {
        fs.appendFileSync(
          path.join(stateDirOf(os.homedir()), 'hook-errors.log'),
          `[${new Date().toISOString()}] on-pre-commit.js: runtime-matrix no corrió (${e.message}) — gate DODRT-C6 NO aplicado a ${specRel}.\n`,
          'utf8',
        );
      } catch { /* best effort */ }
      console.error(`⚠ tycon-dod-runtime: runtime-matrix falló (${e.message}) — DODRT-C6 fail-open, logueado.`);
    }

    // ACCOV-C8 — self-audit OPCIONAL. Es prosa del agente sobre sí
    // mismo validada por regex, y el portón de CI la excluye como evidencia: lo que frena el cierre es la
    // matriz por AC recomputada arriba (cada AC con ejecución real). Falta → no frena. Existe a medias →
    // AVISA sin frenar (escribir uno incompleto no puede castigar más
    // que no escribirlo). Si existe, C10 sigue igual.
    const selfAudit = checkSelfAudit(cwd, storyId, { storyPath: specAbs });
    if (selfAudit.exists && !selfAudit.valid) {
      avisosSelfAudit.push({ specRel, storyId, selfAuditPath: selfAudit.path, missingSections: selfAudit.missingSections });
    }

    // ACCOV-C10 — convergencia entre iteraciones (solo para transición a 'done', y sólo si hay self-audit).
    // Si la story va a 'review', cualquier self-audit válido alcanza.
    // Si va a 'done', requerimos que NO haya gaps nuevos vs iter previa.
    const newStatus = (stagedFm.status || '').toLowerCase();
    if (selfAudit.exists && newStatus === 'done') {
      // 🔴 Sin la sección de gaps en el último self-audit la convergencia NO se puede demostrar: compararía 0 gaps
      //    contra los del iter previo y «convergería». Borrar §3 sería la forma de saltear C10.
      //    Con iter previo, frena; sin iter previo no hay contra qué comparar.
      if (selfAudit.previousPath && (selfAudit.missingSections || []).includes('section 3')) {
        violations.push({
          specRel, storyId, statusTransition, pipelineTransition,
          reason: 'not-converged',
          currentIter: selfAudit.iter,
          previousIter: selfAudit.previousIter,
          newGaps: ['(al último self-audit le falta la sección «3. Gaps conocidos»: no se puede comparar)'],
          currentPath: selfAudit.path,
          previousPath: selfAudit.previousPath,
        });
        continue;
      }
      const conv = checkSelfAuditConvergence(selfAudit.path, selfAudit.previousPath);
      if (conv && !conv.converged) {
        violations.push({
          specRel, storyId, statusTransition, pipelineTransition,
          reason: 'not-converged',
          currentIter: selfAudit.iter,
          previousIter: selfAudit.previousIter,
          newGaps: conv.newGaps,
          currentPath: selfAudit.path,
          previousPath: selfAudit.previousPath,
        });
        continue;
      }
    }

    if (!avisosSelfAudit.some((a) => a.specRel === specRel)) pasos.set(specRel, { regla: 'evidencia-ok', storyId });
  }

  // Lo que viene de una transición interna `review → done` AVISA en vez de bloquear (ver arriba).
  const avisos = violations.filter((v) => soloAviso.has(v.specRel));
  const bloqueantes = violations.filter((v) => !soloAviso.has(v.specRel));
  anotarDecisionesDelCierre({ violations, soloAviso, pasos, estadoDe, avisosSelfAudit });
  if (avisosSelfAudit.length) {
    const av = ['⚠️  AVISO — self-audit incompleto (ACCOV-C8 es opcional desde 2026-09-16, story 7.2 del arnés: no frena)'];
    for (const a of avisosSelfAudit) av.push(`   · ${a.specRel} (story ${a.storyId}): faltan ${a.missingSections.join(', ')} — ${a.selfAuditPath}`);
    av.push('   Completarlo o borrarlo: un self-audit a medias no suma. Lo que frena el cierre es la matriz por AC.');
    process.stderr.write(av.join('\n') + '\n');
  }
  if (avisos.length) {
    // 🔴 La ventana de medición VENCE SOLA. Una fecha de revisión que viviera sólo en una ficha,
    // sin que nada la mirara, dejaría el aviso avisando para siempre sin que nadie lea el número
    // que juntó — un aviso que suena y no se acciona es el que se aprende a ignorar. Mismo patrón que `pending-tests.json`: la fecha se declara
    // donde el arnés la mira, y pasado el día el propio aviso trae el número y exige la decisión.
    // `TYCON_TODAY` existe sólo para que la suite pueda pararse en «después del 20» sin esperar.
    const REVIEW_A_DONE_VENCE = '2026-09-20';
    const hoyPuesto = require('./lib/legacy-names.js').readEnv('TYCON_TODAY', { where: 'skills/tycon-pipeline/scripts/on-pre-commit.js' }) || '';
    const hoy = /^\d{4}-\d{2}-\d{2}$/.test(hoyPuesto) ? hoyPuesto : new Date().toISOString().slice(0, 10);
    const gl = path.join(stateDirOf(os.homedir()), 'gates.log');
    let hablo = 0;
    try { hablo = (fs.readFileSync(gl, 'utf8').match(/"name":"review-a-done","action":"warn"/g) || []).length; } catch { hablo = 0; }
    const cabeza = [];
    cabeza.push('⚠️  AVISO — review → done sin evidencia completa (hoy avisa; con TYCON_REVIEW_A_DONE=block bloquea)');
    for (const v of avisos) cabeza.push(`   · ${v.specRel} (story ${v.storyId}): ${v.reason}`);
    cabeza.push('   Es la transición interna: el paso a `review` ya se juzgó. Este aviso mide cuántas veces habla antes de frenar.');
    if (hoy >= REVIEW_A_DONE_VENCE) {
      cabeza.push(`   🔴 La ventana de medición VENCIÓ el ${REVIEW_A_DONE_VENCE} y nadie decidió: este aviso habló ${hablo} vez/veces en esta máquina (gates.log).`);
      cabeza.push('   Decidí hoy: TYCON_REVIEW_A_DONE=block (pasa a bloquear) o retirar el aviso. Un aviso que suena y no se acciona se aprende a ignorar.');
    } else {
      cabeza.push(`   Van ${hablo} aviso(s) en esta máquina; se decide el ${REVIEW_A_DONE_VENCE}.`);
    }
    process.stderr.write(cabeza.join('\n') + '\n');
    try {
      fs.mkdirSync(path.dirname(gl), { recursive: true });
      for (const v of avisos) {
        fs.appendFileSync(gl, JSON.stringify({ ts: new Date().toISOString(), sessionId: event.session_id || null,
          name: 'review-a-done', action: 'warn', repoPath: cwd, storyId: v.storyId, reason: v.reason }) + '\n', 'utf8');
      }
    } catch { /* medir no puede frenar */ }
  }
  if (bloqueantes.length === 0) {
    process.exit(0);
  }
  violations.length = 0; violations.push(...bloqueantes);

  // ============================================================
  // BLOQUEAR (exit 2)
  // ============================================================
  const lines = [];
  lines.push('🚨 BLOQUEADO — evidencia de cierre faltante (DoD runtime / advisors)');
  lines.push('');
  lines.push('Este commit transiciona stories a `review`/`done` sin evidence DoD (o sin auditoría de advisors):');
  lines.push('');
  for (const v of violations) {
    lines.push(`  ❌ ${v.specRel}`);
    lines.push(`     storyId: ${v.storyId}`);
    lines.push(`     ${v.statusTransition ? '→ status frontmatter pasa a review/done' : ''}`);
    lines.push(`     ${v.pipelineTransition ? '→ pipelines.*.status pasa a review/done' : ''}`);
    if (v.reason === 'no-advisors') {
      lines.push('     Pasa a `done` sin constancia de que los advisors del pipeline hayan auditado esta story EN ESTE repo.');
      for (const sPath of (v.searched || [])) lines.push(`       buscado: ${sPath}`);
      for (const viejo of (v.legacy || [])) lines.push(`       no cuenta (carpeta vieja bajo un número que comparten varias stories — no dice de cuál es; no se tocó): ${viejo}`);
      lines.push('     Salidas:');
      lines.push('       (a) Correr el pipeline sobre la story (con sus revisores):');
      lines.push('           node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js start --story <spec> --repo <repo>');
      lines.push('       (b) Story SIN nada que auditar (docs/config puros) — lo decide el DEV, en el frontmatter:');
      lines.push('           advisors_exempt: true');
      lines.push('           advisors_exempt_reason: "<razón concreta>"');
      lines.push('       (c) Kill-switch del dev: TYCON_ADVISORS_GATE=off.');
    } else if (v.reason === 'sin-testigo' || v.reason === 'no-roster' || v.reason === 'roster-fabricado'
               || v.reason === 'roster-invalido' || v.reason === 'roster-ilegible') {
      // "revisor ≠ autor": el rastro tiene que decir QUIÉN revisó, y coincidir con los revisores
      // que el arnés vio correr de verdad en esta máquina.
      if (v.reason === 'sin-testigo') {
        lines.push('     Hay constancia de revisión, pero en ESTA máquina no quedó registro de los revisores de esta story.');
        lines.push('     Suele pasar cuando la implementación se hizo en otra máquina, o cuando subís la rama de otra persona.');
      } else if (v.reason === 'no-roster') {
        lines.push(`     Falta el registro de autoría (\`review-roster.json\`) en ${v.runDir} — y no se pudo regenerar del registro local.`);
      } else if (v.reason === 'roster-fabricado') {
        lines.push(`     El registro de autoría lista revisores que el arnés NUNCA vio correr acá: ${v.inventados.join(', ')}.`);
      } else if (v.reason === 'roster-invalido') {
        for (const p of (v.problemas || [])) lines.push(`     ${p.regla}: ${p.detalle}`);
      } else {
        lines.push(`     El registro de autoría no se puede leer: ${v.detalle}`);
      }
      lines.push('     Salidas:');
      lines.push('       (a) Correr los revisores del pipeline sobre la story en esta máquina (el registro se escribe solo).');
      lines.push('       (b) Si la revisión fue real pero el registro quedó en otro lado, dejalo ESCRITO en el propio archivo');
      lines.push(`           ${v.runDir ? path.join(v.runDir, 'review-roster.json') : 'review-roster.json'} :`);
      lines.push('             agregale la línea  "sin_testigo": "implementado en la desktop, subo desde la notebook"');
      lines.push('           🔴 AGREGADA al archivo que escribió el arnés, no en lugar de él: el portón de CI');
      lines.push('              igual exige el resto (implementer + al menos un revisor). Si el archivo no existe,');
      lines.push('              el mínimo que CI acepta es:');
      lines.push('                { "version": 1, "story": "<id>", "implementer": {"kind":"sesion-principal"},');
      lines.push('                  "reviewers": [{"agent":"<advisor que revisó>","kind":"subagente"}],');
      lines.push('                  "sin_testigo": "<motivo>" }');
      lines.push('           Viaja en el commit y se ve en el PR — a diferencia de un interruptor, deja rastro y se puede contar.');
      lines.push('       (c) Kill-switch de emergencia: TYCON_ROSTER_GATE=off (queda sin rastro en el diff: usalo sólo si (b) no aplica).');
    } else if (v.reason === 'no-criteria') {
      lines.push(`     No encontré los criterios de ${v.specRel}: ${v.motivo}.`);
      lines.push('     Sin criterios no hay contra qué medir la evidencia del cierre. Arreglo: un título `## Acceptance Criteria`');
      lines.push('     (o `## Criterios de aceptación`) y cada criterio en una de las formas de story-format.md §6.');
    } else if (v.reason === 'no-evidence') {
      if (v.evidenceKeyError) lines.push(`     No se pudo calcular la clave de la evidencia: ${v.evidenceKeyError}`);
      else lines.push(`     Buscado: .advisors/dod-runtime/${v.evidenceKey || v.storyId}-*.md (no encontrado)`);
    } else if (v.reason === 'evidence-failed') {
      lines.push(`     La única evidencia de cierre que hay declara FAIL: ${v.evidencePath}`);
      lines.push(`     Una corrida fallida documenta que se probó, no que pasó. Corré de nuevo y dejá la evidencia verde.`);
    } else if (v.reason === 'incomplete-evidence') {
      // El mensaje nombra los criterios que faltan y DÓNDE se buscaron — el archivo elegido y las tres
      // fuentes de la unión—, para que el arreglo sea correr lo que falta y no redactar un resumen que los nombre.
      const fu = v.fuentes || {};
      const nada = (xs) => !xs || xs.length === 0;
      lines.push(`     Criterios sin evidencia: ${v.missingAcs.join(', ')}`);
      lines.push('     Se buscaron en:');
      lines.push(`       · el informe elegido: ${v.evidencePath}${v.evidenceEsRegistro ? ' (es el registro de pruebas de humo: sus criterios se cuentan por la fuente 1, no por el texto)' : ''}`);
      if (fu.error) {
        lines.push(`       · las tres fuentes de la máquina NO se pudieron leer (${fu.error}): sólo se miró el informe.`);
      } else {
        lines.push(`       1. pruebas de humo: ${nada(fu.registros) ? `no hay registro ${fu.clave}-smoke-ledger.jsonl` : fu.registros.join(', ')}`);
        lines.push('          (cuenta una corrida de smoke-run.sh con salida 0, su copia en gates.log y posterior al último cambio de código)');
        lines.push(`       2. gates E2E: ${nada(fu.gates) ? `no hay ${fu.clave}-e2e-gate-*.md` : fu.gates.map((g) => path.basename(g)).join(', ')}`);
        lines.push('          (cuenta un gate PASS con su copia en gates.log; los criterios salen de las filas E2E de la tabla ### Tests)');
        lines.push(`       3. firmas del dev: ${fu.firmas || '(no se pudo saber el repo)'}`);
        lines.push('          (cuenta una firma vigente para la declaración del criterio en runtime_not_verifiable)');
      }
      lines.push('     Salida: correr lo que falta (gate E2E o smoke-run.sh) o, si es imposible, declararlo y que el dev lo firme.');
      lines.push('     El detalle por criterio lo da: node <skill>/scripts/runtime-matrix.js --story <ruta-story.md> --no-write');
    } else if (v.reason === 'no-playwright-evidence') {
      lines.push(`     DODRT-C5.1: story de UI — la evidencia DoD NO menciona Playwright/E2E.`);
      lines.push(`     Evidencia encontrada: ${v.evidencePath}`);
      lines.push(`     Una story que toca una pantalla (.tsx, .jsx, .svelte, .vue) se prueba con un E2E que asserta CADA`);
      lines.push(`     AC de UI — no alcanza curl al backend ni unit tests. Caso: Story 11.2 (y 11.1).`);
    } else if (v.reason === 'matrix-red') {
      lines.push(`     DODRT-C6: matriz de verificación runtime ROJA (re-computada en vivo). hash: ${v.hash}`);
      if ((v.notRun || []).length) {
        lines.push(`     🔴 SIN CORRER (el agente DEBE correrlos, NO waiveables): ${v.notRun.map(n => '#' + n).join(', ')}`);
        lines.push(`        Corrélos (E2E/smoke-run.sh) o, si son imposibles, declaralos en runtime_not_verifiable.`);
      }
      if ((v.notVerifiable || []).length) {
        lines.push(`     🟪 imposibles-declarados (esperan waiver del USUARIO): ${v.notVerifiable.map(n => '#' + n).join(', ')}`);
        lines.push(`        node <skill>/scripts/marker.js runtime-waiver <ruta-story.md>   (requiere /dev/tty)`);
      }
      for (const l of (v.avisoDescartadas || [])) lines.push(`     ${l}`);
      if (v.chainOk === false) lines.push(`     🚨 hay líneas de esta story descartadas por la cadena del registro de firmas — causa probable: una edición a mano.`);
    } else if (v.reason === 'matrix-structural') {
      lines.push(`     DODRT-C6: la matriz no pudo computarse (fail-closed): ${v.detail}`);
      lines.push(`     Arreglar la story (ACs parseables / tabla ### Tests) antes de transicionar.`);
    } else if (v.reason === 'not-converged') {
      lines.push(`     ACCOV-C10: self-audit NO convergido (transition to done bloqueada).`);
      lines.push(`     Current: ${v.currentPath} (iter ${v.currentIter})`);
      lines.push(`     Previous: ${v.previousPath} (iter ${v.previousIter})`);
      lines.push(`     Gaps NUEVOS en iter ${v.currentIter} vs iter ${v.previousIter}:`);
      for (const g of v.newGaps) {
        lines.push(`       + ${g}`);
      }
      lines.push('');
      lines.push(`     Convergencia requiere: gaps_iter_${v.currentIter} ⊆ gaps_iter_${v.previousIter}.`);
      lines.push(`     Acciones permitidas:`);
      lines.push(`       (a) Cerrar los gaps nuevos en código antes del próximo iter.`);
      lines.push(`       (b) Si los gaps son aceptables non-blocking, agregarlos también al`);
      lines.push(`           self-audit anterior como base + re-escribir + re-iter.`);
      lines.push(`       (c) Transicionar a 'review' (no 'done') hasta convergencia.`);
    }
  }
  lines.push('');
  lines.push('Por qué: Story 4.2 — done declarado + commiteado sin correr los E2E.');
  lines.push('  Este hook es la infra que lo enforce.');
  lines.push('');
  lines.push('Acciones permitidas:');
  lines.push('  (a) Ejecutar tycon-dod-runtime-checker advisor → captura evidencia');
  lines.push('      en .advisors/dod-runtime/<storyId>-<timestamp>.md');
  lines.push('  (b) Smoke manual: levantar stack + ejecutar E2E + curl outputs');
  lines.push('      → escribir .advisors/dod-runtime/<storyId>-<timestamp>.md con');
  lines.push('      el log + screenshots/curl outputs');
  lines.push('  (c) Story sin UI/E2E (puro docs/config): eximirla de la prueba en vivo lo decide la persona,');
  lines.push('      no el agente (lo firma con marker.js sign-file dod_runtime_exempt <historia>).');
  lines.push('  (d) Bypass excepcional (NO recomendado, queda flag en stderr):');
  lines.push('        git commit --no-verify');
  lines.push('');
  lines.push('Documentación de la regla:');
  lines.push('  ~/.claude/tycon-harness/guides/definition-of-done.md');
  lines.push('  Advisor: tycon-dod-runtime-checker');

  process.stderr.write(lines.join('\n') + '\n');
  process.exit(2);
}

// Exports para la suite de tests de la capa determinista.
// require() desde tests NO ejecuta main() (gate require.main).
module.exports = {
  prepararIndiceConLosAdd,
  isGitCommit, usaNoVerify, parseAcsFromSpec, parseAcsFromEvidence, findDodEvidence, evidenciaDeclaraFail, findAdvisorsEvidence,
  looksLikeStorySpec, selectStorySpecs, revisarRosterLocal, checkSelfAudit, REGLA_DE_MOTIVO, storyIsUiStory,
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // Fail-open: un bug del hook NO debe bloquear commits válidos (bloquear TODO por un
    // crash del hook es peor que dejar pasar uno). PERO un gate desactivado en silencio es
    // justamente el riesgo del fail-open invisible → lo hacemos VISIBLE:
    // stderr + log persistente con timestamp, para que un gate caído sea AUDITABLE.
    const msg = (e && (e.stack || e.message)) || String(e);
    process.stderr.write('⚠ tycon-dod-runtime: hook error (FAILING OPEN — gate NO aplicado): ' + msg + '\n');
    try {
      const logDir = path.join(stateDirOf(os.homedir()));
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, 'hook-errors.log'),
        `[${new Date().toISOString()}] on-pre-commit.js FAILED OPEN — DoD gate NO aplicado:\n${msg}\n\n`,
        'utf8',
      );
    } catch { /* si ni el log se puede escribir, al menos quedó el stderr */ }
    process.exit(0);
  }
}
