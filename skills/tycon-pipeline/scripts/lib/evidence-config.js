#!/usr/bin/env node
/**
 * evidence-config.js — lectura del bloque `evidence:` de `.tycon/advisors.yaml` (fuente única).
 *
 * Nació en runtime-matrix.js con el fix de atribución de evidencia (2026-08-14) y se extrajo acá
 * el mismo día para que el detector de story-de-UI (lib/ui-signal.js) lea LA MISMA declaración —
 * dos parsers del mismo bloque es el drift de mañana. Mismo parser-YAML-mínimo-sin-deps que
 * e2eConfig/i18nRequired de pipeline.js.
 *
 * Schema:
 *   evidence:
 *     companion_repos:   # repos hermanos del MISMO producto cuya evidencia cuenta para este repo
 *       - CeiboFrontEnd #   (nombre de hermano → se resuelve contra el padre del repo; ./ o abs también valen)
 *     fe_paths:          # tokens de path/nombre que marcan el lado FRONTEND del producto
 *       - CeiboFrontEnd #   (apareo fila↔suite de la matriz + detector de story-de-UI)
 *       - ceibo-deposito
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function isDir(d) { try { return fs.statSync(d).isDirectory(); } catch { return false; } }

/** El bloque `evidence:` de un TEXTO de config. Separado del lector para que el modo-freno pueda
 *  parsear la versión commiteada y la de la carpeta con el MISMO parser. */
function parseEvidenceText(txt, repoRoot) {
  // blockPresent: el bloque `evidence:` EXISTE en el yaml — con eso el consumidor puede
  // distinguir "no hay config" de "hay config y el parser no le sacó nada" (un formato YAML
  // válido que este parser mínimo no entienda no puede degradar la config en silencio —
  // review ciego F3: companion perdido = rojo falso; fe_paths perdido = detector de UI diluido).
  const out = { roots: [], missing: [], fePaths: [], blockPresent: false, warnings: [] };
  if (!repoRoot || !txt) return out;
  // El comentario inline se pela ANTES que las quotes (al revés, `- "X"  # c` dejaba `X"`).
  const clean = (s) => s.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim();
  const addEntry = (list, entry) => {
    if (!entry) return;
    if (list === 'fe_paths') { out.fePaths.push(entry); return; }
    // `~/` se expande (2026-09-10): el arnés declara a agent-skills como compañero, que vive en
    // `~/.claude/agent-skills` en TODAS las máquinas del equipo — una ruta absoluta con el usuario
    // adentro sólo serviría en una. Sin `~`, las tres formas de siempre: absoluta · relativa al
    // repo (empieza con `.`) · hermana bajo la carpeta padre del repo.
    const conHome = /^~(?=\/|$)/.test(entry) ? path.join(os.homedir(), entry.slice(1)) : entry;
    const resolved = path.isAbsolute(conHome) ? conHome
      : conHome.startsWith('.') ? path.resolve(repoRoot, conHome)
        : path.join(path.dirname(repoRoot), conHome);
    if (isDir(resolved)) out.roots.push(resolved);
    else out.missing.push(entry);
  };
  let inEvidence = false; let evIndent = 0; let curList = null; let listIndent = 0;
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (!inEvidence) {
      if (/^evidence\s*:/.test(line)) { inEvidence = true; evIndent = indent; out.blockPresent = true; }
      continue;
    }
    if (indent <= evIndent) break; // otra key top-level → fin del bloque evidence
    const keyM = line.match(/^\s*(companion_repos|fe_paths)\s*:(.*)$/);
    if (keyM) {
      // Flow style `key: [a, b]` — se parsea acá mismo, no abre lista block.
      const flow = keyM[2].trim().match(/^\[(.*)\]\s*(?:#.*)?$/);
      if (flow) {
        for (const raw of flow[1].split(',')) addEntry(keyM[1], clean(raw));
        curList = null;
      } else { curList = keyM[1]; listIndent = indent; }
      continue;
    }
    const m = line.match(/^\s*-\s*(.+?)\s*$/);
    // YAML válido permite los items al MISMO indent que la key → corta solo si dedenta MÁS.
    if (!m || !curList || indent < listIndent) { curList = null; continue; }
    addEntry(curList, clean(m[1]));
  }
  return out;
}

/**
 * El bloque `evidence:` del yaml de la CARPETA de trabajo (comportamiento de siempre).
 * `opts.freno: true` → modo FRENO (ver abajo).
 */
function parseEvidenceConfig(repoRoot, opts) {
  if (!repoRoot) return { roots: [], missing: [], fePaths: [], blockPresent: false, warnings: [] };
  const leerCarpeta = () => {
    for (const name of ['advisors.yaml', 'advisors.yml']) {
      try { return fs.readFileSync(path.join(repoRoot, '.tycon', name), 'utf8'); } catch (_e) { /* siguiente */ }
    }
    return null;
  };
  if (!opts || !opts.freno) return parseEvidenceText(leerCarpeta(), repoRoot);

  // ── Modo FRENO (FIX-1, 2026-08-25 — casos C3 y C9 de la auditoría) ──────────────────────────
  // Las dos llaves de este bloque tienen DIRECCIONES OPUESTAS, así que se tratan distinto:
  //
  //   · `companion_repos` AFLOJA: declarar un repo hermano hace que la evidencia de OTRO repo
  //     cuente como propia. Eso se lee SÓLO de lo commiteado — aflojar tiene que estar en un
  //     commit y verse en el diff. (Reproducido: con el hermano declarado sólo en la carpeta,
  //     el freno pasaba de "no-evidence" a "Evidencia encontrada: <hermano>/.advisors/...".)
  //     🔴 Efecto de borde a propósito: el primer commit que declare un hermano NUEVO da rojo
  //     hasta commitearlo. Por eso se avisa explícitamente en vez de dejar al dev adivinando.
  //
  //   · `fe_paths` DELIMITA a qué se le aplica la exigencia de prueba de navegador: sacar un
  //     nombre de carpeta apaga la exigencia para esa app (caso C9). Se usa la UNIÓN — agregar
  //     un nombre vale al toque, sacarlo espera al commit.
  let ambas = null;
  try { ambas = require('./config-source.js').leerAmbas(repoRoot); } catch (_e) { ambas = null; }
  if (!ambas || !ambas.hayHistoria) return parseEvidenceText(leerCarpeta(), repoRoot);

  const head = parseEvidenceText(ambas.commiteado, repoRoot);
  const work = parseEvidenceText(ambas.carpeta, repoRoot);
  const soloEnCarpeta = [...work.roots, ...work.missing].filter(
    (r) => !head.roots.includes(r) && !head.missing.includes(r),
  );
  const warnings = [];
  if (soloEnCarpeta.length) {
    warnings.push(
      `⚠ .tycon/advisors.yaml → evidence.companion_repos declara ${soloEnCarpeta.map((r) => `\`${r}\``).join(', ')} ` +
      'en la CARPETA pero no en el último commit. Declarar un repo hermano AFLOJA el freno ' +
      '(su evidencia pasa a contar como propia), así que sólo cuenta una vez commiteado. ' +
      'Commiteá el yaml y este freno lo toma; hasta entonces te va a dar rojo.',
    );
  }
  return {
    roots: head.roots,
    missing: head.missing,
    fePaths: [...new Set([...head.fePaths, ...work.fePaths])],
    blockPresent: head.blockPresent || work.blockPresent,
    warnings,
  };
}

// Raíz del REPO git (la carpeta con `.git`) subiendo desde un archivo o directorio.
function discoverRepoRoot(fromPath) {
  if (!fromPath) return null;
  let dir = path.resolve(fromPath);
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { dir = path.dirname(dir); }
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// `.advisors/dod-runtime` de UN root: el del repo + los de sus subproyectos (1 nivel).
function evidenceDirsUnder(root) {
  const dirs = [];
  const top = path.join(root, '.advisors', 'dod-runtime');
  if (isDir(top)) dirs.push(top);
  let entries = [];
  try { entries = fs.readdirSync(root).filter((x) => !x.startsWith('.')); } catch { /* ilegible */ }
  for (const child of entries) {
    const d = path.join(root, child, '.advisors', 'dod-runtime');
    if (isDir(d)) dirs.push(d);
  }
  return dirs;
}

// Roots del PRODUCTO cuya `.advisors/dod-runtime` puede tener evidencia: el repo, sus
// companions declarados, y los subproyectos (1 nivel) de cada uno que ya tengan ese dir.
// Es el criterio único de atribución (fix 2026-08-14): nada de barrer hermanos por vecindad —
// los story-id colisionan entre productos y un `<sid>-*.md` ajeno satisfacía checks propios.
function productEvidenceRoots(repoRoot, opts) {
  if (!repoRoot) return [];
  const roots = [];
  for (const r of [repoRoot, ...parseEvidenceConfig(repoRoot, opts).roots]) {
    roots.push(r);
    let entries = [];
    try { entries = fs.readdirSync(r).filter((x) => !x.startsWith('.')); } catch { /* ilegible */ }
    for (const child of entries) {
      if (isDir(path.join(r, child, '.advisors', 'dod-runtime'))) roots.push(path.join(r, child));
    }
  }
  return roots;
}

// ── Dónde NACE la evidencia de cierre de una story (2026-09-05, stories 8.7 y 8.8 de un producto del equipo) ────────
// En productos con las stories en un repo (Project) y el código en otros (Backend, FrontEnd,
// VidrieraWeb), el pipeline corre parado en el repo del CÓDIGO y ahí dejaba la evidencia. Pero quien
// la exige al cerrar es el portón de CI del repo de la STORY —que sólo mira su propio checkout, a
// propósito—, así que toda story de ese producto que pasaba a `review` por pull request salía roja
// (tres pull requests del repo de stories de ese producto, el 2026-09-04 y el 2026-09-05 — guides/incident-log.md#evidencia-en-otro-repo-2026-09-05) y el dev la copiaba a mano. Dos copias
// divergen (el ledger de smokes crece con cada corrida), así que no se copia: la evidencia NACE en
// el repo git que CONTIENE la story, y todos los runners reciben ese directorio. Para el freno local
// da lo mismo (la evidencia del repo de la story es "propia" por definición); para el portón es la
// diferencia entre rojo y verde.
// Si no se puede determinar el repo de la story, se cae al repo de trabajo Y SE DICE: un fallback
// silencioso se lee como decisión.
function evidenceDirForStory(storyPath, fallbackRepo) {
  const storyRepo = storyPath ? discoverRepoRoot(storyPath) : null;
  const repo = fallbackRepo ? path.resolve(fallbackRepo) : null;
  // "Otro repo" se decide por RAÍZ GIT, no por carpeta: un cwd en una subcarpeta del mismo monorepo
  // (`<mono>/mcp` con la story en `<mono>/specs`) no es cross-repo (revisión adversarial 2026-09-05).
  const repoRoot = repo ? (discoverRepoRoot(repo) || repo) : null;
  const base = storyRepo || repo;
  const same = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return a === b; } };
  if (!base) {
    return { dir: null, storyRepo: null, repo, crossRepo: false, source: 'none',
      warning: 'no se pudo determinar ni el repo de la story ni el repo de trabajo — pasá --evidence-dir explícito' };
  }
  return {
    dir: path.join(base, '.advisors', 'dod-runtime'),
    storyRepo,
    repo,
    crossRepo: !!(storyRepo && repoRoot && !same(storyRepo, repoRoot)),
    source: storyRepo ? 'story-repo' : 'fallback-repo',
    warning: storyRepo ? null
      : `la story ${storyPath} no está dentro de un repo git: la evidencia va al repo de trabajo (${repo}) y el portón de CI del repo de la story no la va a ver`,
  };
}

module.exports = { parseEvidenceConfig, parseEvidenceText, discoverRepoRoot, evidenceDirsUnder, productEvidenceRoots, evidenceDirForStory };
