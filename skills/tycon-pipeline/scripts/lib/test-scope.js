'use strict';
/**
 * test-scope.js — deducir QUÉ proyecto testear en un repo con más de uno, y
 * decir con todas las letras cuándo NO se puede.
 *
 * Se deduce el alcance del diff, y se frena si no se sabe. El caso está MEDIDO, no
 * supuesto: un repo del equipo tiene `apinetcore/` (.NET) y `mcp/` (node --test); si la
 * story toca SÓLO `mcp/` y el gate elige .NET porque el `.csproj` gana la detección por
 * estar primero, falla en 1,3s (NETSDK1045 — la máquina tiene otro SDK) y deja un
 * `tests-result.json` en rojo con el id de la story puesto. Eso es peor que no dejar
 * nada: PARECE verificación. Sin esto, el gate avisaría por stderr y correría
 * igual — y la doctrina del propio equipo dice que un control que hay que
 * acordarse de invocar es un control que no corre.
 *
 * Dos piezas, a propósito separadas:
 *   - `deduceScope({files, candidates})` — pura, sin fs ni git: es la que se
 *     verifica con mutantes.
 *   - `discoverCandidates(repoDir)` / CLI — el borde que toca disco y git.
 *
 * 🔴 NUNCA decide por palabras. Vota por ESTRUCTURA: un archivo cae, o no cae,
 * bajo el directorio de un proyecto que tiene runner de tests. No hay listas de
 * nombres, ni heurísticas de vocabulario, ni "si el path suena a backend".
 *
 * CLI:  node test-scope.js <repo-dir> [story-id|story-path] [--tsv]
 */

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', 'bin', 'obj', 'dist', 'coverage', 'TestResults']);

// ── Los archivos que la story DECLARA ────────────────────────────────────────
// Parser propio y mínimo (no reusa `parseFrontmatterList` de pipeline.js) por
// dos razones: `pipeline.js` requiere `lib/`, así que el camino inverso sería un
// ciclo; y el de allá NO limpia el comentario inline (`- "a/b.ts"  # AC1`), que
// en las stories de este equipo es la forma NORMAL de escribir la lista.
function cleanItem(raw) {
  const s = String(raw).trim();
  const quoted = s.match(/^(["'])([\s\S]*?)\1/);
  if (quoted) return quoted[2].trim();
  const hash = s.indexOf('#');
  return (hash === -1 ? s : s.slice(0, hash)).trim();
}

function frontmatterOf(content) {
  const m = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}

// `allForms`: también la lista en línea y la de ítems a la misma sangría que la clave. Sólo la pide el alcance de la
// puerta de pruebas: los frenos leen la forma de siempre, porque leer más declarado ahí aflojaría lo que dejan pasar.
function listUnderKey(fm, key, { allForms = false } = {}) {
  const lines = fm.split(/\r?\n/);
  const out = [];
  let inKey = false;
  let keyIndent = 0;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (!inKey) {
      const km = line.match(new RegExp(`^(\\s*)${key}\\s*:\\s*(?:#.*)?$`));
      if (km) { inKey = true; keyIndent = km[1].length; continue; }
      if (!allForms) continue;
      // la lista en línea: `clave: [a, "b", 'c']`
      const enLinea = line.match(new RegExp(`^\\s*${key}\\s*:\\s*\\[([^\\]]*)\\]\\s*(?:#.*)?$`));
      if (enLinea) return enLinea[1].split(',').map(cleanItem).filter(Boolean);
      continue;
    }
    if (line.trim() === '') continue;
    // YAML deja los ítems a la misma sangría que la clave; lo que corta es otra cosa a esa sangría
    if (indent < keyIndent || (indent === keyIndent && !(allForms && /^\s*-(?:\s|$)/.test(line)))) break;
    const im = line.match(/^\s*-\s*(.+?)\s*$/);
    if (im) {
      const v = cleanItem(im[1]);
      if (v) out.push(v);
    }
  }
  return out;
}

function parseDeclaredFiles(content, opts) {
  const fm = frontmatterOf(content);
  if (!fm) return [];
  return [...listUnderKey(fm, 'files_to_create', opts), ...listUnderKey(fm, 'files_to_modify', opts)];
}

// Sólo los que la story declara CREAR. Los usa test-gate.sh como respaldo del cruce de
// cobertura cuando git no reporta archivos "added" (típico: iteración de fix POSTERIOR
// al commit). Vive acá y no en el bloque Python del gate a propósito: el parseo del
// frontmatter es una sola verdad — si cambia el formato, cambia en UN lugar.
function parseFilesToCreate(content, opts) {
  const fm = frontmatterOf(content);
  if (!fm) return [];
  return listUnderKey(fm, 'files_to_create', opts);
}

// Los que la story declara BORRAR. Los lee el freno de la terminal: un `git rm` de un archivo declarado pasa y se anota.
function parseFilesToDelete(content) {
  const fm = frontmatterOf(content);
  if (!fm) return [];
  return listUnderKey(fm, 'files_to_delete');
}

function storyIdOf(content) {
  const fm = frontmatterOf(content);
  const m = fm.match(/^story:\s*["']?([^"'#\r\n]+)["']?/m);
  return m ? m[1].trim() : null;
}

// ── Los proyectos que TIENEN suite de tests ─────────────────────────────────
// Espeja la detección de test-gate.sh (para no tener dos verdades
// sobre "qué cuenta como proyecto testeable"): .NET por `.sln`/`.csproj` hasta
// profundidad 3; node por `package.json` en la raíz o en un subdir inmediato,
// con vitest o con `node --test` en el script `test`.
function walkFiles(root, maxDepth, cb) {
  const stack = [{ dir: root, depth: 0, rel: '' }];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch (_e) { continue; }
    for (const e of entries) {
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (cur.depth + 1 < maxDepth) stack.push({ dir: path.join(cur.dir, e.name), depth: cur.depth + 1, rel });
      } else if (e.isFile()) {
        cb(rel);
      }
    }
  }
}

function nodeRunnerOfPkg(text) {
  if (/"vitest"/.test(text)) return 'vitest';
  if (/"test"\s*:\s*"[^"]*node --test/.test(text)) return 'node-test';
  // jest, otro runner del equipo. Va ÚLTIMO a propósito: si un package.json declara
  // `node --test` como script y jest en devDependencies (herramienta suelta), gana el script.
  if (/"jest"\s*:/.test(text) || /"test"\s*:\s*"[^"]*\bjest\b/.test(text)) return 'jest';
  return null;
}

/** Carpeta que contiene el archivo — donde el runner PUEDE correr. `.` si está en la raíz. */
function dirOf(rel) {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '.' : rel.slice(0, i);
}

const isUnder = (dir, anc) => anc === '.' || dir === anc || dir.startsWith(`${anc}/`);

function discoverCandidates(repoDir) {
  const byDir = new Map(); // dir → { runner, territory? }
  const add = (dir, runner) => { if (!byDir.has(dir)) byDir.set(dir, { runner }); };

  // ── .NET ───────────────────────────────────────────────────────────────────
  // 🔴 El candidato es la carpeta que CONTIENE el .sln/.csproj, no el primer segmento del camino
  // Colapsar al primer segmento haría que en un repo con
  // `custom-forms/backend-api-dotnet/App.sln` el candidato salga `custom-forms` — una carpeta
  // contenedora donde `dotnet test` responde MSB1003 ("especifique un archivo de proyecto o
  // solución"). El gate correría igual y dejaría constancia EN ROJO con el id de la story puesto.
  const slnFiles = [];
  const csprojDirs = new Set();
  walkFiles(repoDir, 3, (rel) => {
    if (/\.sln$/i.test(rel)) slnFiles.push(rel);
    else if (/\.csproj$/i.test(rel)) csprojDirs.add(dirOf(rel));
  });
  const slnDirs = new Set(slnFiles.map(dirOf));
  for (const d of slnDirs) add(d, 'dotnet');
  // Un .csproj cubierto por una solución NO agrega candidato: correr la solución es lo correcto.
  for (const d of csprojDirs) {
    if (![...slnDirs].some((s) => isUnder(d, s))) add(d, 'dotnet');
  }

  // ── Territorio del candidato .sln ──
  // El candidato RAÍZ '.' vota SÓLO por archivos sin '/' (regla anti "la raíz
  // gana por descarte") — correcto para docs, pero deja sin voto a los archivos que SÍ son
  // del proyecto raíz y viven en subcarpetas (`src/App/*.cs`): 0 votos → freno
  // falso (exit 4) en los repos con forma "sln raíz + subproyecto". La salida NO es relajar el freno: es leer el manifest
  // que ya existe y no miente — las rutas de proyecto del propio .sln. Territorio = los dirs
  // de los .csproj que la solución declara; un archivo bajo uno de esos dirs vota por el
  // candidato de la solución (ver deduceScope). Los .md/docs siguen sin votar.
  // Sólo .sln a propósito: un package.json raíz no declara qué carpetas testea su suite
  // (asimetría documentada en guide-update-proposals.md).
  for (const slnRel of slnFiles) {
    const sdir = dirOf(slnRel);
    const cand = byDir.get(sdir);
    if (!cand) continue; // teórico: el add de arriba siempre lo creó
    let dirs = [];
    try {
      const txt = fs.readFileSync(path.join(repoDir, slnRel), 'utf8');
      // `Project("{GUID}") = "Nombre", "rel\ruta\X.csproj", "{GUID}"` — el 2do campo es la
      // ruta. Exigir `.csproj` descarta los solution-folders (mismo shape, sin proyecto).
      for (const m of txt.matchAll(/^Project\([^)]*\)\s*=\s*"[^"]*",\s*"([^"]+\.csproj)"/gim)) {
        const rel = m[1].replace(/\\/g, '/');
        const abs = path.posix.normalize(sdir === '.' ? rel : `${sdir}/${rel}`);
        // Una referencia `..\` que sale del repo no da territorio: votar fuera del repo
        // sería inventar dueños.
        if (!abs.startsWith('../')) dirs.push(dirOf(abs));
      }
    } catch (_e) { /* .sln ilegible → fallback abajo */ }
    // Fallback (sln vacío o ilegible): los dirs de .csproj cubiertos por esta solución — la
    // misma aproximación que ya usa el descarte de candidatos. Sin datos → sin territorio →
    // el comportamiento de freno. El error degrada SIEMPRE al freno, nunca a elegir.
    if (!dirs.length) dirs = [...csprojDirs].filter((d) => isUnder(d, sdir));
    // 🔴 UNIÓN, no asignación: dos .sln en el MISMO dir
    // comparten candidato, y asignar haría que el último procesado PISARA el territorio del
    // primero — con orden de readdirSync, o sea no determinístico. Ejemplo: un repo
    // tiene `App.sln` + `App_release.sln` en la raíz y el _release no
    // declara el proyecto de tests → freno falso sobre los tests, o PEOR, elección del otro
    // candidato en un cambio mixto. La unión es lo conservador: más territorio nunca elige
    // de más (dos proyectos con votos = ambiguo = freno).
    const territory = [...new Set([...(cand.territory || []), ...dirs.filter((d) => d !== sdir)])].sort();
    if (territory.length) cand.territory = territory;
  }

  // ── node ───────────────────────────────────────────────────────────────────
  // Mismo alcance de profundidad que .NET: un `custom-forms/runtime-app/package.json` también se ve. `walkFiles` ya saltea node_modules,
  // bin, obj, dist, coverage y las carpetas ocultas.
  walkFiles(repoDir, 3, (rel) => {
    if (!/(^|\/)package\.json$/.test(rel)) return;
    let txt;
    try { txt = fs.readFileSync(path.join(repoDir, rel), 'utf8'); } catch (_e) { return; }
    const runner = nodeRunnerOfPkg(txt);
    if (runner) add(dirOf(rel), runner);
  });

  // ── las herramientas de lib/test-runners.js: pytest, Go, Maven, Gradle, Karma y las de la organización ─────────
  // Por su archivo detector, a la misma profundidad. Una carpeta que ya es candidata (.NET o node) no cambia de
  // corredor; un conftest.py dentro de un proyecto de pytest no suma otro candidato.
  let runnersLib = null; let stack = {};
  try { runnersLib = require('./test-runners.js'); stack = require('./stack-config.js').readStack().stack; } catch (e) {
    runnersLib = null;
    process.stderr.write(`[test-scope] ⚠️  no pude cargar las herramientas de prueba (${e && e.message ? e.message : e}): sólo cuentan .NET y node como proyectos\n`);
  }
  if (runnersLib) {
    const nombres = new Set(runnersLib.detectorFiles(stack).map((d) => d.file));
    const dirs = new Set();
    walkFiles(repoDir, 3, (rel) => {
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      if (!nombres.has(base)) return;
      // un conftest.py suelto en una subcarpeta no hace de ella un proyecto: sólo cuenta en la raíz del repo
      if (base === 'conftest.py' && dirOf(rel) !== '.') return;
      dirs.add(dirOf(rel));
    });
    const porProfundidad = [...dirs].sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.split('/').length - b.split('/').length));
    for (const d of porProfundidad) {
      if (byDir.has(d)) continue;
      let r = null;
      try {
        const i = runnersLib.inspect(d === '.' ? repoDir : path.join(repoDir, d), { stack });
        r = i.runner;
        // lo que no se pudo leer (una carpeta, el remoto) se dice: no es lo mismo que «no es proyecto»
        for (const p of i.problems || []) process.stderr.write(`[test-scope] ⚠️  ${d}: ${p}\n`);
      } catch (e) {
        process.stderr.write(`[test-scope] ⚠️  no pude ver qué herramienta de prueba usa ${d} (${e && e.message ? e.message : e}): no cuenta como proyecto\n`);
      }
      if (!r) continue;
      // una carpeta del territorio de una solución es un proyecto de esa solución, no uno aparte: la herramienta que la
      // detecta (p. ej. packages.config de .NET Framework, buscado en subcarpetas) corre desde la solución
      // (sin mirar mayúsculas: el .sln de Windows y la carpeta en el disco no siempre coinciden; y lo que está debajo
      // de la carpeta de la solución también es de ella)
      const enMinusculas = d.toLowerCase();
      if ([...byDir.entries()].some(([c, v]) => Array.isArray(v.territory)
        && (v.territory.some((t) => String(t).toLowerCase() === enMinusculas || isUnder(enMinusculas, String(t).toLowerCase()))
          || (c !== '.' && isUnder(d, c))))) continue;
      const dentroDeOtro = [...byDir.entries()].some(([c, v]) => v.runner === r.name && c !== d && isUnder(d, c));
      if (!dentroDeOtro) add(d, r.name);
    }
  }

  return [...byDir.entries()]
    .map(([dir, { runner, territory }]) => (territory ? { dir, runner, territory } : { dir, runner }))
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

// ── La deducción (pura) ──────────────────────────────────────────────────────
function deduceScope({ files, candidates }) {
  const cands = Array.isArray(candidates) ? candidates : [];
  if (cands.length < 2) {
    return {
      multi: false, ambiguous: false, scope: null, votes: {},
      reason: 'el repo tiene un solo proyecto con tests — no hay alcance que deducir',
    };
  }

  const votes = {};
  for (const c of cands) votes[c.dir] = 0;
  // Prefijo más largo primero: un candidato `a/b` gana sobre `a` para `a/b/x.ts`.
  const dirs = cands.map((c) => c.dir).filter((d) => d !== '.').sort((a, b) => b.length - a.length);
  const hasRoot = Object.prototype.hasOwnProperty.call(votes, '.');
  // la raíz es de una herramienta de lib/test-runners.js (no .NET ni node, que siguen con su regla propia)
  const raiz = cands.find((c) => c.dir === '.');
  const raizGenerica = Boolean(raiz && !['dotnet', 'vitest', 'node-test', 'jest', 'suites-json'].includes(raiz.runner));
  // Un proyecto Maven o Gradle también es dueño de su Scala, Groovy y Kotlin de guion. Sólo para este voto: sumarlas a
  // la lista general haría que el portón ATDD pida una prueba antes de tocar un `build.gradle.kts`.
  const jvm = raiz && ['maven', 'gradle'].includes(raiz.runner) ? ['.scala', '.groovy', '.kts'] : [];
  const esCodigo = (f) => require('./code-files.js').isSource(f) || jvm.includes(path.extname(f).toLowerCase());
  // Territorio: los dirs que el .sln de un candidato declara como suyos —
  // ver discoverCandidates. Prefijo más largo primero, igual que los candidatos. Un candidato
  // explícito SIEMPRE gana sobre un territorio (el `owner` de arriba se evalúa antes).
  const terrOwner = new Map();
  for (const c of cands) for (const t of c.territory || []) {
    if (!terrOwner.has(t)) terrOwner.set(t, c.dir);
  }
  const terrDirs = [...terrOwner.keys()].sort((a, b) => b.length - a.length);

  let considered = 0;
  let viaTerritory = 0;
  const list = Array.isArray(files) ? files : [];
  for (const raw of list) {
    const f = String(raw).replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!f) continue;
    const owner = dirs.find((d) => f === d || f.startsWith(`${d}/`));
    if (owner) { votes[owner] += 1; considered += 1; continue; }
    if (hasRoot && !f.includes('/')) { votes['.'] += 1; considered += 1; continue; }
    // Un proyecto de pytest, Go, Maven… en la raíz tiene su código en subcarpetas (app/, src/, cmd/): un archivo de
    // código que no cae bajo otro proyecto es suyo. La documentación sigue sin votar (no hay «raíz por descarte»).
    if (hasRoot && raizGenerica && esCodigo(f)) { votes['.'] += 1; considered += 1; continue; }
    // 🔴 El candidato raíz ('.', típicamente un `.sln` en la raíz) vota SÓLO por los archivos que
    // están en la raíz misma. Con un repo que tiene proyecto raíz + subproyectos, "está contenido
    // en la raíz" es cierto para TODO y por lo tanto no discrimina nada: `tasks/todo.md` terminaría
    // eligiendo el proyecto .NET por descarte — el defecto exacto que este freno viene a cerrar.
    // Sin este límite, 3 archivos de documentación sin story deducirían '.'.
    // La ÚNICA otra vía de voto es el territorio declarado por un manifest (.sln): estructura,
    // no descarte. `src/App/Repo.cs` vota '.' porque el .sln de la raíz declara `src/App` —
    // `tasks/todo.md` sigue sin votar. Sin dueño ni territorio → NO vota; si nadie vota, es
    // ambiguo y frena, que es lo correcto.
    const terr = terrDirs.find((d) => f === d || f.startsWith(`${d}/`));
    if (terr) { votes[terrOwner.get(terr)] += 1; considered += 1; viaTerritory += 1; }
  }

  const hit = Object.keys(votes).filter((d) => votes[d] > 0).sort();
  if (hit.length === 1) {
    return {
      multi: true, ambiguous: false, scope: hit[0], votes,
      reason: `${considered} de ${list.length} archivos caen bajo '${hit[0]}'`
        + (viaTerritory ? ` (${viaTerritory} vía territorio del .sln)` : '')
        + ', y ninguno bajo otro proyecto con tests',
    };
  }
  if (hit.length === 0) {
    return {
      multi: true, ambiguous: true, scope: null, votes,
      reason: list.length
        ? `ninguno de los ${list.length} archivos cae bajo un proyecto con tests (${cands.map((c) => c.dir).join(', ')})`
        : 'no hay archivos declarados por la story ni cambios en el diff con los que deducir el alcance',
    };
  }
  // Dos o más proyectos tocados: no es ambiguo, se corren todos (cada uno con su suite) y el total es verde sólo si
  // todos lo son. Frenar acá dejaría sin medir el back de una story que toca back y front.
  return {
    multi: true, ambiguous: false, scope: null, scopes: hit, votes,
    reason: `los archivos tocan ${hit.length} proyectos con tests (${hit.join(', ')}): corre cada uno`,
  };
}

// ── El borde: story o diff ───────────────────────────────────────────────────
function changedFiles(repoDir) {
  const { execFileSync } = require('child_process');
  const run = (args) => {
    try {
      return execFileSync('git', ['-C', repoDir, ...args], {
        encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (_e) { return ''; }
  };
  const out = `${run(['diff', 'HEAD', '--name-only'])}\n${run(['ls-files', '--others', '--exclude-standard'])}`;
  return [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * `storyArg` puede ser un id ("4.30") o una ruta a la story. Si es ruta, los
 * archivos salen de lo que la story DECLARA (la fuente que pidió la decisión).
 * Si no hay ruta o la story no declara nada, se cae al diff real del repo —
 * que es la otra evidencia mecánica disponible, y queda registrada como tal en
 * `source` para que nadie confunda una fuente con la otra.
 */
function resolveScope(repoDir, storyArg) {
  const candidates = discoverCandidates(repoDir);
  let files = [];
  let source = null;
  let storyId = null;
  let storyPath = null;

  if (storyArg && fs.existsSync(storyArg) && fs.statSync(storyArg).isFile()) {
    storyPath = path.resolve(storyArg);
    const content = fs.readFileSync(storyPath, 'utf8');
    storyId = storyIdOf(content);
    files = parseDeclaredFiles(content, { allForms: true });
    if (files.length) source = 'story';
  }
  if (!files.length) {
    files = changedFiles(repoDir);
    if (files.length) source = 'diff';
  }

  const r = deduceScope({ files, candidates });
  return {
    ...r,
    candidates,
    source,
    story_id: storyId,
    story_path: storyPath,
    files_considered: files.length,
  };
}

module.exports = {
  parseDeclaredFiles, parseFilesToCreate, parseFilesToDelete, storyIdOf, discoverCandidates, deduceScope, resolveScope,
  changedFiles, nodeRunnerOfPkg,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const tsv = argv.includes('--tsv');
  const soloCreados = argv.includes('--files-to-create');
  const pos = argv.filter((a) => a !== '--tsv' && a !== '--files-to-create');
  const repoDir = pos[0];
  if (!repoDir) {
    console.error('uso: test-scope.js <repo-dir> [story-id|story-path] [--tsv|--files-to-create]');
    process.exit(2);
  }
  // `--files-to-create`: uno por línea, vacío si no hay story o no declara nada. Sale ANTES de
  // resolveScope porque no necesita descubrir candidatos ni tocar git.
  if (soloCreados) {
    const sp = pos[1];
    let out = [];
    try {
      if (sp && fs.existsSync(sp) && fs.statSync(sp).isFile()) {
        out = parseFilesToCreate(fs.readFileSync(sp, 'utf8'), { allForms: true });
      }
    } catch { out = []; }
    process.stdout.write(out.join('\n') + (out.length ? '\n' : ''));
    process.exit(0);
  }
  const r = resolveScope(repoDir, pos[1] || '');
  if (tsv) {
    // Orden fijo, consumido por test-gate.sh. 🔴 El separador es \x1f (unit separator) y NO un
    // tabulador: el `read` de bash trata el tab como espacio en blanco de IFS, así que colapsa los
    // separadores consecutivos y un campo VACÍO en el medio corre todos los de atrás — el test del
    // freno lo cubre (sin eso, el alcance llega a bash valiendo "1", que es el flag `ambiguous`).
    process.stdout.write([
      r.multi ? 1 : 0,
      r.scope || '',
      r.source || '',
      r.story_id || '',
      r.ambiguous ? 1 : 0,
      r.candidates.map((c) => `${c.dir}:${c.runner}`).join(','),
      String(r.reason || '').replace(/[\x1f\r\n]+/g, ' '),
      (r.scopes || []).join(','),
    ].join('\x1f') + '\n');
  } else {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  }
}
