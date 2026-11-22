'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * suite-freshness.js — ¿el verde de la suite completa sigue midiendo ESTE código?
 *
 * Si la suite completa corre verde al cierre de «Correr las pruebas» y después hay más
 * iteraciones de fixes, ese verde describe un código que ya no existe. Lo caza el
 * DoD checker (paso «Probar en vivo»), no el orquestador: de red, no de prevención. Este módulo
 * le da al orquestador la pregunta barata: "¿cambió ALGÚN archivo de código desde
 * la corrida verde?" — y sólo si la respuesta es sí se paga la re-corrida.
 *
 * Cómo se mide el estado, y por qué así:
 *   - `git ls-files -s -- <código>`: el blobhash de TODO el código trackeado, ya
 *     calculado en el index (30ms medidos con 456 .cs). Un commit mueve
 *     index→HEAD sin cambiar contenido, así que commitear la story NO invalida el
 *     verde — sólo un cambio real de bytes lo hace. (Comparar contra HEAD daría
 *     stale falso en cada commit; comparar mtimes daría stale falso en cada
 *     checkout/restore.)
 *   - los archivos con el working tree distinto del index (`git diff --name-only`)
 *     y los untracked se re-hashean con `git hash-object` (son pocos).
 *   - CÓDIGO = la misma extensión que cruza test-gate.sh para coverage
 *     (`.cs .ts .tsx .js .jsx`), tests INCLUIDOS a propósito: un test endurecido
 *     también invalida el verde anterior.
 *
 * CLI:
 *   node suite-freshness.js state <repo>                    → JSON {git, state_hash, code_files}
 *   node suite-freshness.js check <repo> [tests-result.json] → veredicto por exit code:
 *       0 = FRESCO (el artefacto verde midió exactamente este código)
 *       5 = STALE  (hubo cambios de código desde la corrida → re-correr test-gate.sh)
 *       6 = SIN DATOS (no hay artefacto, no era verde, o no registró code_state)
 *   Los exit codes no pisan los de test-gate.sh (0/2/3/4): un consumidor puede
 *   encadenarlos sin ambigüedad.
 *
 * Los repos hermanos: una story con código en otro repo deja en la constancia la lista
 * `companions` y, en `code_state.repos`, la huella de cada uno (`{name, root, git, state_hash, code_files}`; los campos
 * planos siguen siendo los del repo de la historia). Entonces el verde que cuenta es el total (`all_green`), y cada
 * hermano se mide en la raíz guardada: un cambio en cualquiera es STALE con su nombre; un hermano sin huella guardada o
 * que no se puede leer es SIN DATOS (y, si además otro cambió, va al motivo del STALE). Sin `companions`, como siempre.
 *
 * Quién lo consume: test-gate.sh (escribe `code_state` en tests-result.json al
 * cerrar cada corrida) y la vuelta de revisores (chequea al salir del loop de iteraciones,
 * ANTES de continuar al paso «Probar en vivo»). Fail-open con constancia: sin git, o con git
 * fallando, `state` dice `git:false` y `check` sale 6 — nunca inventa un fresco.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Las extensiones del cruce de coverage de test-gate.sh (code_re del bloque Python) MÁS los
// manifests que cambian el resultado de la suite sin ser "código" (un bump de PackageReference
// en un .csproj o una migración .sql nueva en una iteración de fix darían FRESCO). `.json` queda AFUERA a propósito: tests-result.json y
// configs mutables harían stale perpetuo.
// El código es el de lib/code-files.js (con lo que sume la organización); acá se agregan `.sln` y `.sql`.
const codeFiles = require('./code-files.js');
const MANIFEST_EXTS = ['.sln', '.sql'];
function isCodeFile(f, { extra } = {}) {
  const ext = codeFiles.extOf(f);
  const ex = extra !== undefined ? extra : require('./stack-config.js').orgExtra();
  return codeFiles.isCode(f, { extra: ex }) || MANIFEST_EXTS.includes(ext);
}
function codePathspecs(extra) {
  const ex = extra !== undefined ? extra : require('./stack-config.js').orgExtra();
  return [...codeFiles.SOURCE_EXTS, ...codeFiles.CODE_ONLY_EXTS, ...MANIFEST_EXTS, ...ex].map((e) => `*${e}`);
}
const CODE_RE = { test: (f) => isCodeFile(f) };

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    windowsHide: true,
    encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function lines(s) {
  return String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

/** Estado del CÓDIGO del working tree: { git, state_hash, code_files }. */
function codeState(repoDir) {
  // 🔴 Frame único: SIEMPRE se mide desde la RAÍZ del repo git, sin importar desde qué
  // subcarpeta se invoque (test-gate.sh reasigna $REPO al
  // subdir del alcance, así que el artefacto quedaría medido desde `mcp/` y el check del
  // paso «Revisores, otra vuelta» mediría desde la raíz — paths y set de archivos distintos → STALE falso SIEMPRE
  // en repos con alcance de subcarpeta (una suite completa extra por story, sin un solo
  // cambio). Normalizar acá cubre a TODO caller sin depender del orden en bash.
  let root = null;
  try { root = git(repoDir, ['rev-parse', '--show-toplevel']).trim() || null; } catch (_e) { /* sin git */ }
  if (!root) return { git: false, state_hash: null, code_files: 0 };
  repoDir = root;

  try {
    // path → blobhash, arrancando del index (hash ya calculado, no lee contenido).
    const byPath = new Map();
    const CODE_PATHSPECS = codePathspecs();
    for (const ln of lines(git(repoDir, ['ls-files', '-s', '--', ...CODE_PATHSPECS]))) {
      // `<mode> <hash> <stage>\t<path>`
      const m = ln.match(/^\d+\s+([0-9a-f]{40,64})\s+\d+\t(.+)$/);
      if (m) byPath.set(m[2], m[1]);
    }
    // Working tree ≠ index (modificados sin add) + untracked: re-hashear el contenido real.
    const dirty = new Set([
      ...lines(git(repoDir, ['diff', '--name-only', '--', ...CODE_PATHSPECS])),
      ...lines(git(repoDir, ['ls-files', '--others', '--exclude-standard', '--', ...CODE_PATHSPECS])),
    ].filter((f) => CODE_RE.test(f)));
    for (const f of dirty) {
      if (fs.existsSync(path.join(repoDir, f))) {
        byPath.set(f, git(repoDir, ['hash-object', '--', f]).trim());
      } else {
        byPath.delete(f); // borrado del working tree: desaparece del estado (y el hash cambia)
      }
    }
    const canon = [...byPath.entries()].map(([f, h]) => `${f}:${h}`).sort().join('\n');
    return {
      git: true,
      state_hash: crypto.createHash('sha256').update(canon).digest('hex'),
      code_files: byPath.size,
    };
  } catch (e) {
    return { git: false, state_hash: null, code_files: 0, error: String(e && e.message || e) };
  }
}

/** La huella de cada repo hermano, con su nombre (la carpeta): lo que el portón guarda en `code_state.repos`. */
function siblingStates(roots) {
  return (roots || []).map((root) => ({ name: path.basename(root), root, ...codeState(root) }));
}

/**
 * Los repos hermanos de la constancia contra su huella guardada: las raíces de `companions` y las de `code_state.repos`,
 * medidas en la raíz guardada (no se vuelven a buscar). Devuelve { stale: [motivos], noData: [motivos] }.
 */
function compareSiblings(art) {
  const guardadas = new Map();
  for (const r of (art.code_state && Array.isArray(art.code_state.repos)) ? art.code_state.repos : []) {
    if (r && r.root) guardadas.set(r.root, r);
  }
  const raices = [...new Set([
    ...(Array.isArray(art.companions) ? art.companions : []).map((c) => c && c.root).filter(Boolean),
    ...guardadas.keys(),
  ])];
  const stale = [];
  const noData = [];
  for (const root of raices) {
    const g = guardadas.get(root);
    const nombre = (g && g.name) || path.basename(root);
    if (!g || !g.state_hash) {
      noData.push(`la constancia no guarda la huella del repo hermano ${nombre}: no se puede validar su frescura`);
      continue;
    }
    const ahora = codeState(root);
    if (!ahora.git || !ahora.state_hash) {
      noData.push(`no se pudo medir el código del repo hermano ${nombre} (${root})${ahora.error ? `: ${ahora.error}` : ''}`);
    } else if (ahora.state_hash !== g.state_hash) {
      stale.push(`el repo hermano ${nombre} cambió su código desde la corrida verde de ${art.ts || 's/f'}`);
    }
  }
  return { stale, noData };
}

/**
 * Compara el estado actual contra el que registró la última corrida del gate. Con repos hermanos en la constancia
 * (`companions`), el verde que cuenta es el total (`all_green`) y se compara también la huella de cada hermano: un
 * cambio en cualquiera es STALE (con todos los motivos, también los de lo que no se pudo medir); lo que no se pudo medir,
 * sin ningún cambio, es SIN DATOS.
 * Devuelve { status: 'fresh'|'stale'|'no-data', reason }.
 */
function checkFreshness(repoDir, testsResultPath) {
  const artPath = testsResultPath || path.join(repoDir, '.advisors', 'tests-result.json');
  let art;
  try { art = JSON.parse(fs.readFileSync(artPath, 'utf8')); } catch (_e) {
    return { status: 'no-data', reason: `no se pudo leer ${artPath} — no hay corrida que validar` };
  }
  const rec = art.code_state;
  if (!rec || !rec.state_hash) {
    return {
      status: 'no-data',
      reason: 'el artefacto no registra code_state (corrida anterior a este control, o un freno) — no se puede validar frescura',
    };
  }
  const conHermanos = Array.isArray(art.companions) && art.companions.length > 0;
  if (conHermanos ? art.all_green !== true : !art.suite_green) {
    return {
      status: 'no-data',
      reason: conHermanos
        ? 'el total con los repos hermanos no fue verde — lo que corresponde es correr el gate, no validar frescura'
        : 'la última corrida no fue verde — lo que corresponde es correr el gate, no validar frescura',
    };
  }
  const now = codeState(repoDir);
  if (!now.git || !now.state_hash) {
    return { status: 'no-data', reason: `no se pudo medir el estado actual del código${now.error ? ` (${now.error})` : ''}` };
  }
  const propio = now.state_hash === rec.state_hash ? null
    : `hubo cambios de código desde la corrida verde de ${art.ts || 's/f'} — ese verde describe un código que ya no existe: re-correr test-gate.sh`;
  const hermanos = compareSiblings(art);
  if (propio || hermanos.stale.length) {
    const motivos = [propio, ...hermanos.stale.map((m) => `${m} — re-correr test-gate.sh`), ...hermanos.noData].filter(Boolean);
    return { status: 'stale', reason: motivos.join('; ') };
  }
  if (hermanos.noData.length) return { status: 'no-data', reason: hermanos.noData.join('; ') };
  const medidos = (art.code_state.repos || []).length;
  return {
    status: 'fresh',
    reason: `el verde de ${art.ts || 's/f'} midió exactamente este código (${now.code_files} archivos${medidos ? `, y ${medidos} repo(s) hermano(s)` : ''})`,
  };
}

module.exports = { codeState, siblingStates, checkFreshness, CODE_RE, isCodeFile };

if (require.main === module) {
  const [cmd, repoDir, artPath] = process.argv.slice(2);
  if (!cmd || !repoDir) {
    console.error('uso: suite-freshness.js state <repo> | check <repo> [tests-result.json]');
    process.exit(2);
  }
  if (cmd === 'state') {
    process.stdout.write(`${JSON.stringify(codeState(repoDir))}\n`);
    process.exit(0);
  }
  if (cmd === 'check') {
    const r = checkFreshness(repoDir, artPath);
    const tag = { fresh: '✅ FRESCO', stale: '🔴 STALE', 'no-data': 'ℹ️ SIN DATOS' }[r.status];
    process.stdout.write(`[suite-freshness] ${tag} — ${r.reason}\n`);
    process.exit(r.status === 'fresh' ? 0 : r.status === 'stale' ? 5 : 6);
  }
  console.error(`comando desconocido: ${cmd}`);
  process.exit(2);
}
