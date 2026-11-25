/**
 * pipeline-reports.js — una parte de pipeline.js (el despachador la carga para sus subcomandos).
 *
 * Responsabilidad: los informes y la evidencia de una corrida: tiempos, costo, claves y carpetas de evidencia, candidatos y la configuración de las pruebas de navegador.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { estadoPipeline, deriveStoryId, evidenceDirForStory, evidenceKey, fs, os, path, readSessionMarker, readText, resolveRunDir, resolveSessionId, runDirKey, stateDirOf } = require('./pipeline-shared.js');
const { isE2eSpecPath, relativeInsideRepo } = require('./path-forms.js');   // rutas de Windows sin verde falso
/**
 * PIPE-C2 · qué carpetas le faltan al `.gitignore` del repo, decidido carpeta por carpeta.
 *
 * 🔴 La pregunta NO es «¿existe la línea `.advisors/`?» sino «¿el repo ya decidió algo sobre esa
 *    carpeta?». Un repo que
 *    la ignora con `**\/.advisors/*` + `!**\/.advisors/dod-runtime/` —el patrón que deja viajar la
 *    evidencia de cierre—, comparado por línea exacta, parece no haber decidido nada, y el `.advisors/`
 *    que el preflight appendearía **anularía la negación** (git no re-incluye nada dentro de un
 *    directorio excluido). Resultado: la evidencia de cierre dejaría de viajar y el medidor SDLC la
 *    leería como 0%, en cada `start`, y habría que revertir el archivo a mano.
 *
 * Reglas, y las tres son deliberadas:
 *   · **Un comentario NO es una regla**: nombrar `.advisors` en un `#` no la ignora, así que la
 *     línea se agrega igual (mismo criterio que `check-artifact-paths.js`).
 *   · **Una carpeta con nombre parecido no cuenta**: `.advisors-viejo/` no cubre `.advisors`.
 *   · **Se decide carpeta por carpeta**: que una esté cubierta no dice nada de la otra.
 */
// El bloque canónico de `.advisors`, copiado del `.gitignore` del arnés. Es UNO y se
// escribe entero: `.advisors/` a secas excluye el
// directorio y con eso ANULA cualquier negación, así que la evidencia deja de viajar.
// El registro de aprobaciones de la corrida viaja también: el portón de CI lo lee.
const LINEA_APROBACIONES = '!**/.advisors/pipeline-runs/*/approvals.jsonl';
const GITIGNORE_ADVISORS = [
  '# TYCON — los artefactos efimeros de advisors NO viajan, pero la evidencia de cierre SI:',
  '# es auditable y el medidor SDLC la lee desde el servidor (si no viaja, mide 0% y miente).',
  '# Patron `dir/*` (no `dir/`) para que la negacion pueda re-incluir el subdirectorio.',
  '**/.advisors/*',
  '!**/.advisors/dod-runtime/',
  '# ...y de cada corrida del pipeline viajan SOLO el registro de revisores y sus hallazgos:',
  '# es lo que el porton de CI exige para pasar una story a `done` (2026-09-05).',
  '!**/.advisors/pipeline-runs/',
  '**/.advisors/pipeline-runs/*',
  '!**/.advisors/pipeline-runs/*/',
  '**/.advisors/pipeline-runs/*/*',
  '!**/.advisors/pipeline-runs/*/review-roster.json',
  '!**/.advisors/pipeline-runs/*/findings.json',
  LINEA_APROBACIONES,
];

/** Las sondas: rutas que NO existen en el disco, sólo para preguntarle a git qué haría con ellas. */
// 🔴 La sonda de lo efímero es un NIETO de `pipeline-runs/`, no un hijo directo: el
// bloque canónico re-incluye `pipeline-runs/` para que viaje el registro de revisores, así que un
// hijo directo podría no estar ignorado con el bloque puesto, el preflight leería "sin decisión" y
// volvería a agregar el bloque en CADA start. Un nieto está
// ignorado con el bloque viejo, con el nuevo y con `.advisors/` a secas, y no lo está sin regla.
const SONDA_EFIMERO = '.advisors/pipeline-runs/__sonda-pipe-c2__/__sonda__';
const SONDA_EVIDENCIA = '.advisors/dod-runtime/__sonda-pipe-c2__';
const SONDA_DASHBOARD = '.dashboard/__sonda-pipe-c2__';
// Lo que el portón de CI exige para `done`: el registro de revisores de la corrida.
const SONDA_ROSTER = '.advisors/pipeline-runs/__sonda-pipe-c2__/review-roster.json';
const SONDA_APROBACIONES = '.advisors/pipeline-runs/__sonda-pipe-c2__/approvals.jsonl';

/**
 * PIPE-C2 · qué le falta al `.gitignore`, preguntándole a GIT y no al texto.
 *
 * 🔴 Comparar TEXTO (¿el archivo menciona `.advisors`?) se equivoca del lado caro:
 *    con una negación suelta, una subruta (`FrontEnd/.advisors/x/`), un
 *    archivo suelto (`.advisors/tests-result.json`) o un comentario pegado al final de la línea,
 *    diría «ya está cubierta» y git NO ignoraría nada — el repo commitearía los artefactos efímeros.
 *    Muchos `.gitignore` plausibles reproducen el error. La única fuente de verdad sobre si una ruta
 *    está ignorada es git, así que se le pregunta a él.
 *
 * `probe(rutaRelativa)` devuelve `true` (git la ignora), `false` (no la ignora) o `null` (no se
 * pudo preguntar). **`null` NO se trata como «falta»**: no tocamos un `.gitignore` sin saber qué
 * hay, y se deja constancia — «no pude mirar» y «miré y falta» no se escriben igual.
 *
 * Devuelve `{ append: [líneas a agregar], notices: [avisos para la persona] }`.
 */
function computeGitignoreNeeds(probe) {
  const append = [];
  const notices = [];

  const efimero = probe(SONDA_EFIMERO);
  if (efimero === false) {
    append.push(...GITIGNORE_ADVISORS);
  } else if (efimero === null) {
    notices.push('PIPE-C2: no pude preguntarle a git si `.advisors/` está ignorada — no toco el '
      + '.gitignore. Revisalo a mano.');
  } else {
    // Cubierta, pero de más: se está tragando lo que SÍ tiene que viajar. NO se reescribe sola —
    // es una decisión del repo y pisarla en silencio sería el mismo pecado al revés. UN aviso con
    // todo lo que falta (el registro de revisores también viaja, por el `done` por PR).
    const traga = [];
    if (probe(SONDA_EVIDENCIA) === true) traga.push('`.advisors/dod-runtime/` (la evidencia de cierre de cada story NO viaja y el medidor SDLC la lee como 0%)');
    if (probe(SONDA_ROSTER) === true) traga.push('`.advisors/pipeline-runs/*/review-roster.json` + `findings.json` + `approvals.jsonl` (el registro de revisores y el de aprobaciones NO viajan y el portón de CI no deja pasar la story)');
    // Un repo con el bloque estándar (el registro de revisores viaja) y sin la línea del registro
    // de aprobaciones. Agregar esa única negación es aditivo —no cambia lo que el repo decidió ignorar— y corre antes
    // de toda aprobación, así que la línea llega en el mismo commit que el primer registro.
    if (probe(SONDA_ROSTER) === false && probe(SONDA_APROBACIONES) === true) {
      append.push('# ...y el registro de aprobaciones de la corrida (manual o automática), que el portón de CI lee:', LINEA_APROBACIONES);
    }
    if (traga.length) {
      notices.push('PIPE-C2 AVISO: el .gitignore de este repo ignora TAMBIÉN '
        + traga.join(' y ') + '. El bloque correcto es el de GITIGNORE_ADVISORS '
        + '(`**/.advisors/*` + `!**/.advisors/dod-runtime/` + la re-inclusión de '
        + '`pipeline-runs/*/review-roster.json` y `findings.json`). No lo cambio solo: decidilo vos.');
    }
  }

  const dash = probe(SONDA_DASHBOARD);
  if (dash === false) append.push('.dashboard/');
  else if (dash === null) {
    notices.push('PIPE-C2: no pude preguntarle a git si `.dashboard/` está ignorada — no toco el '
      + '.gitignore.');
  }

  return { append, notices };
}

/** El `probe` real: le pregunta a git. 0 = ignorada · 1 = no · cualquier otra cosa = no sé. */
function gitIgnoraProbe(repo) {
  // 🔴 `execFileSync` NO está en el scope del módulo (cada función lo requiere local). Sin esta
  // línea la sonda tiraría ReferenceError adentro del try, devolvería `null` en TODOS los casos, y el
  // preflight diría "no pude preguntarle a git" sin agregar ni avisar nada — un control muerto.
  const { execFileSync } = require('child_process');
  return (rel) => {
    try {
      execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--', rel], { windowsHide: true, stdio: 'ignore' });
      return true;
    } catch (e) {
      return e && e.status === 1 ? false : null;
    }
  };
}

// ── detección de specs Playwright (para el aviso "E2E sin gate declarado") ──
// Bounded: NO recorre node_modules ni dot-dirs; profundidad acotada (cubre monorepos como
// <repo>/<app>/tests/e2e en monorepos). Corta apenas encuentra config + al menos un spec.
function hasPlaywrightSpecs(repo) {
  let hasConfig = false, hasSpec = false;
  const walk = (dir, depth) => {
    if ((hasConfig && hasSpec) || depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hasConfig && hasSpec) return;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      if (e.isFile()) {
        if (/^playwright\.config\.[cm]?[jt]s$/.test(e.name)) hasConfig = true;
        // 🔴 `tests/e2e/` Y `e2e/`. Si el patrón exigiera la carpeta `tests/`
        // intermedia, un repo que pone los specs en `<app>/e2e/` quedaría INVISIBLE:
        // `e2eConfig` devolvería `{}` —"este repo no tiene E2E"— en vez del aviso "tenés specs
        // Playwright y NO declaraste el gate". El aviso es el único mecanismo de
        // descubrimiento que tiene un repo para enterarse de que le falta declarar el gate, así
        // que un layout no contemplado no da error: da silencio.
        // con cualquier separador: en Windows `path.join` arma la ruta con `\` (lib/path-forms.js)
        else if (isE2eSpecPath(path.join(dir, e.name))) hasSpec = true;
      } else if (e.isDirectory()) {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  walk(repo, 0);
  return hasConfig && hasSpec;
}

// ── gate E2E de PROYECTO (agnóstico) — .tycon/advisors.yaml → e2e.{gate,frontend_dir,critical_manifest} ──
// El gate E2E es OWNED por cada proyecto (script + specs + stack viven en SU repo). Los skills
// compartidos («Probar en vivo», tycon-merge-to-main) lo resuelven acá y corren lo que el proyecto declare —
// sin conocer puertos/specs/stack de NINGÚN repo. Sin bloque `e2e:` (o sin `gate:`) → {} → no-op.
// Mismo parser-YAML-mínimo-sin-deps que i18nRequired (los valores son paths, sin espacios → \S+).
// Las llaves que el arnés LEE del bloque `e2e:`. Todo lo demás se avisa:
// si el lector aceptara llaves a CUALQUIER profundidad, un bloque anidado por error
// haría que la lista de pruebas críticas de un formulario se
// aplicara al OTRO, donde ese archivo no existe. Y una llave con el nombre mal escrito no
// produciría ningún error: se ignoraría, y el repo quedaría sin la config que cree tener.
const CLAVES_E2E = new Set([
  'gate', 'frontend_dir', 'frontend_dirs', 'critical_manifest', 'shared_paths', 'preconditions',
  // `bundle` la lee y la USA `e2e-gate.sh` (ver su cabecera y `leer_bundle`): compara la fecha del
  // artefacto que el navegador carga contra las fuentes y, con `rebuild:`, recompila sola. Tiene que estar
  // en esta lista: si no, este validador le diría al dev que su configuración no sirve —y de yapa que
  // moviera las hijas al primer nivel, al revés de lo que el gate parsea—. Quien obedeciera el aviso
  // ROMPERÍA una config correcta. Declarar `bundle` es el escape documentado cuando la autodetección apunta a
  // un archivo equivocado porque el bundle se carga con un `import()` dinámico que
  // ninguna heurística de `<script src>` puede ver.
  'bundle',
]);

// Las llaves que SÍ admiten hijas anidadas, y cuáles. El chequeo de anidamiento existe porque una
// lista de specs críticos colgada de un formulario se aplicaría al otro;
// el chequeo sigue vigente para todo lo demás. Esto no lo afloja: dice cuáles son las excepciones legítimas,
// y sus hijas al primer nivel siguen siendo un error, porque de ahí el gate no las lee.
const HIJAS_E2E = { bundle: new Set(['artifact', 'sources', 'rebuild']) };
const _e2eAvisado = new Set();

function e2eConfig(repo) {
  // Sin gate declarado: distinguir "el repo no tiene E2E" (ok → {}) de "tiene E2E pero se
  // OLVIDARON de declarar el gate" (gap → aviso ruidoso; discoverability).
  // El no-op silencioso ocultaría
  // que un repo con specs Playwright sin bloque `e2e:` NO corre E2E (ni el tier crítico frena).
  const noGate = () => (hasPlaywrightSpecs(repo)
    ? { gap: true, warning: 'El repo tiene specs Playwright (`**/e2e/*.spec.ts` o `**/tests/e2e/*.spec.ts` + playwright.config.*) pero NO declara `e2e.gate` en .tycon/advisors.yaml → el pipeline NO va a correr E2E para este repo (ni el tier crítico frena el merge). Declaralo agregando este bloque: `e2e: { gate: <ruta-a-tu-script-de-gate-relativa-al-repo>, frontend_dir: <dir-con-playwright.config>, critical_manifest: <ruta-a-tu-lista-de-specs-criticos (opcional)> }`. Schema + contrato del gate: tycon-pipeline/SKILL.md sección "Gate E2E del proyecto".' }
    : {});
  const txt = readText(path.join(repo, '.tycon', 'advisors.yaml')) ||
              readText(path.join(repo, '.tycon', 'advisors.yml'));
  if (!txt) return noGate();
  let inBlock = false, blockIndent = 0, juntandoDirs = null;
  // Indentación del PRIMER nivel dentro de `e2e:`. En YAML, una llave sólo pertenece a este
  // bloque si está a ese nivel; más adentro es llave de OTRO objeto, y el arnés no la lee de ahí.
  let nivelHijo = null;
  let padre = null;   // la última llave de primer nivel vista: contra ella se juzgan sus anidadas
  const desconocidas = [];
  const anidadas = [];
  const out = {};
  const dirs = [];
  const shared = [];
  // Un valor del bloque es SIEMPRE un path sin espacios: quedarse con el primer token deja
  // afuera comentarios inline sin necesidad de parsear YAML de verdad (`\S+`).
  const token = (s) => String(s).trim().split(/\s+/)[0].replace(/^['"]|['"]$/g, '');
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (!inBlock) {
      if (/^e2e\s*:/.test(line)) { inBlock = true; blockIndent = indent; }
      continue;
    }
    if (indent <= blockIndent) break; // siguiente key top-level → fin del bloque e2e
    // Item de la lista `frontend_dirs:` que venimos juntando. La guarda `juntandoDirs` es la
    // que evita tragarse los items de OTRAS listas del bloque (ej. `preconditions:`).
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (juntandoDirs && item) { const d = token(item[1]); if (d) juntandoDirs.push(d); continue; }
    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    juntandoDirs = null;
    const [, key, resto] = kv;
    if (nivelHijo === null) nivelHijo = indent;
    if (indent > nivelHijo) {
      // Llave ANIDADA dentro de otra. Aceptarla sin avisar hace que la lista de specs
      // críticos de un formulario termine aplicándose al otro.
      // Excepción declarada en `HIJAS_E2E`: hay llaves cuyas hijas el gate SÍ lee anidadas
      // (`bundle`). Avisar ahí mandaría al dev a romper una config correcta.
      const permitidas = HIJAS_E2E[padre];
      if (!(permitidas && permitidas.has(key)) && !anidadas.includes(key)) anidadas.push(key);
      continue;
    }
    padre = key;   // desde acá, las hijas anidadas se juzgan contra ESTA llave
    if (!CLAVES_E2E.has(key)) {
      if (!desconocidas.includes(key)) desconocidas.push(key);
      continue;
    }
    // `frontend_dirs:` — un monorepo tiene más de una app con
    // Playwright y declarar UNA sola haría que el gate del merge ejerciera la equivocada
    // sin fallar. Admite lista en bloque, flow style `[a, b]` y un valor suelto.
    if (key === 'frontend_dirs' || key === 'shared_paths') {
      const destino = key === 'frontend_dirs' ? dirs : shared;
      // El comentario inline se pela ANTES de mirar el flow style: si no, `[a, b]  # nota` cierra el
      // corchete DESPUÉS del comentario, el regex no matchea, cae al valor suelto y
      // guarda `[a,` como directorio — un dir basura + el resto de la lista descartado, en
      // silencio.
      const v = resto.replace(/\s+#.*$/, '').trim();
      if (v === '') { juntandoDirs = destino; continue; }
      const flow = v.match(/^\[(.*)\]$/);
      if (flow) { for (const d of flow[1].split(',').map(token).filter(Boolean)) destino.push(d); continue; }
      const d = token(v); if (d) destino.push(d);
      continue;
    }
    if (['gate', 'frontend_dir', 'critical_manifest'].includes(key) && resto.trim()) {
      out[key] = token(resto);
    }
  }
  // ── Avisos de la config ─────────────────────────────────────────────────────────────
  // RUIDOSOS y no bloqueantes: una config mal escrita no da error, da silencio — el repo cree
  // estar configurado y no lo está. Se emite una sola vez por repo y por proceso.
  const avisos = [];
  if (desconocidas.length) {
    avisos.push(
      `⚠ .tycon/advisors.yaml → bloque \`e2e:\`: el arnés NO conoce ${desconocidas.map((k) => `\`${k}\``).join(', ')}. ` +
      `Las llaves que lee son: ${[...CLAVES_E2E].join(', ')}. Una llave desconocida no da error: se ignora, ` +
      'y el repo queda sin la configuración que cree tener.',
    );
  }
  if (anidadas.length) {
    avisos.push(
      `⚠ .tycon/advisors.yaml → bloque \`e2e:\`: ${anidadas.map((k) => `\`${k}\``).join(', ')} ` +
      'está(n) ANIDADA(S) dentro de otra llave y el arnés no las lee de ahí. Movelas al primer ' +
      'nivel del bloque. (Caso real: una lista de specs críticos anidada hizo que las pruebas de ' +
      'un formulario se aplicaran al otro, donde ese archivo no existe.)',
    );
  }
  if (avisos.length && !_e2eAvisado.has(repo)) {
    _e2eAvisado.add(repo);
    for (const a of avisos) process.stderr.write(`${a}\n`);
  }

  // Lista efectiva de apps: la plural manda; el escalar de siempre se normaliza a una de uno,
  // así ningún consumidor tiene que saber cuál de las dos formas usó el repo.
  const dirsDeclarados = dirs.length ? dirs : (out.frontend_dir ? [out.frontend_dir] : []);
  // Gate por DEFAULT del harness: si el repo declara el bloque `e2e:` con su
  // frontend_dir pero NO un `gate:` propio, se usa el gate genérico del harness. Si cada
  // repo tuviera su copia del script, el CONTRATO de la evidencia se desincronizaría solo
  // (un repo escribiría "## Tests corridos" y otro no → DODRT-C8 lo bloquearía por un
  // detalle del script, no por su calidad). El `gate:` propio sigue valiendo como escape.
  if (!out.gate && dirsDeclarados.length) {
    out.gate = path.join(estadoPipeline.SCRIPTS_DIR, 'e2e-gate.sh');
    out.gate_source = 'harness (default)';
  }
  if (!out.gate) return noGate();
  const resolve = (p) => (p ? (path.isAbsolute(p) ? p : path.join(repo, p)) : null);
  const efectivos = dirsDeclarados.length ? dirsDeclarados : ['.'];
  const cfg = {
    repo: path.resolve(repo),
    gate: resolve(out.gate),
    // Se mantiene el escalar para los consumidores que ya lo leen: es la PRIMERA de la lista.
    frontend_dir: resolve(efectivos[0]),
    frontend_dirs: efectivos.map(resolve),
    // Repo-relativos a propósito (se comparan contra paths repo-relativos en selectE2eApps).
    shared_paths: shared.slice(),
    critical_manifest: out.critical_manifest ? resolve(out.critical_manifest) : null,
    config_warnings: avisos,
  };
  // Parsear el manifest crítico EN JS (determinístico) — el merge skill consume el array,
  // NO un grep de shell (el `\s` de grep BSD/macOS no matchea whitespace).
  // Strip de comentarios (línea entera o inline `#...`) + whitespace; líneas vacías fuera.
  if (cfg.critical_manifest) {
    const mtxt = readText(cfg.critical_manifest);
    cfg.critical_specs = mtxt
      ? mtxt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean)
      : [];
  }
  return cfg;
}

// ── qué apps del monorepo ejerce esta entrega ───────
//
// El agujero que cierra: en un monorepo con 4 apps, un gate que corra SIEMPRE la única
// declarada ejerce los E2E de esa app al mergear un cambio de otra:
// no falla, ejerce otra cosa. Un control que mira la app equivocada es
// indistinguible de un control que anda, y por eso es peor que no tenerlo.
//
// `changedFiles` son paths RELATIVOS al repo (lo que devuelve `git diff --name-only`).
// Fail-safe deliberado: sin lista de cambios (no se pudo computar el rango del merge) se
// devuelven TODAS. Errar por correr de más es perder minutos; errar por correr de menos es
// exactamente el bug que esto viene a arreglar.
function selectE2eApps(cfg, changedFiles) {
  const todas = (cfg && Array.isArray(cfg.frontend_dirs) && cfg.frontend_dirs.length)
    ? cfg.frontend_dirs
    : (cfg && cfg.frontend_dir ? [cfg.frontend_dir] : []);
  if (!todas.length) return [];
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return todas.slice();

  const raiz = (cfg && cfg.repo) ? cfg.repo : null;
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

  // 🔴 NORMALIZACIÓN DE ENTRADA. Comparar los paths de
  // `changedFiles` TAL CUAL contra el path relativo de cada app sólo funcionaría con
  // entradas repo-relativas. Con paths ABSOLUTOS no matchearía NADA y devolvería `[]` — y el
  // consumidor no lo rescata, porque en JS `[] || fallback` devuelve `[]` (un array vacío es
  // truthy): el loop del gate iteraría CERO veces y saldría 0. O sea: el control diría verde
  // habiendo ejercido nada, la clase de bug que esta función existe para evitar.
  //
  // Y no es un caso teórico: el paso «Probar en vivo» documenta `marker.filesTouched` como fuente válida de
  // `--changed`, y esos paths son ABSOLUTOS por construcción (`on-edit.js` descarta los que no
  // lo son antes de guardarlos).
  //
  // También se contempla el caso "relativo a un ancestro del repo" (`FrontEnd/mi-app/…`,
  // que es lo que devuelve `git diff` cuando la raíz git está por ENCIMA de `--repo`), y el
  // entrecomillado con escapes octales de `git diff --name-only` (core.quotePath viene ON por
  // default: un path con acentos llega como `"mi-app/src/p\303\241gina.tsx"`).
  const desescapar = (p) => {
    let s = String(p);
    if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) {
      s = s.slice(1, -1)
        .replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
        .replace(/\\(["\\])/g, '$1');
      // Los octales de git son bytes UTF-8: re-decodificarlos como tal.
      try { s = Buffer.from(s, 'latin1').toString('utf8'); } catch { /* se deja como está */ }
    }
    return s;
  };
  // 🔴 Symlinks: en macOS `/tmp` es un symlink a `/private/tmp` y el
  // TMPDIR real vive bajo `/var/folders`. Si `--repo` y los paths de `--changed` vienen resueltos
  // DISTINTO, `path.relative` los ve fuera del repo y se descartan. Lo peligroso es el caso
  // PARCIAL: el fail-safe de "no sé → todas" sólo dispara si fallan TODOS, así que con uno solo
  // mal resuelto se pierde esa app en silencio. Se resuelven los dos lados, igual que ya hace
  // `mutation-check.js`. Un path inexistente (archivo borrado en el diff) no puede resolverse:
  // se cae al ancestro más cercano que sí exista y se le vuelve a pegar la cola.
  const realSafe = (p) => {
    try { return fs.realpathSync(p); } catch { /* no existe: probar por el directorio */ }
    try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; }
  };
  const raizReal = raiz ? realSafe(raiz) : null;

  const aRepoRelativo = (p) => {
    const s = norm(desescapar(p));
    if (!s) return null;
    if (!raiz) return s;
    if (path.isAbsolute(s)) {
      // Fuera del repo (scratchpad, otro repo, otra unidad de Windows) → no puede seleccionar ninguna app de ESTE.
      // Si con los paths tal cual quedó "fuera", reintentar con ambos lados resueltos.
      const rel = relativeInsideRepo(raiz, s) || (raizReal ? relativeInsideRepo(raizReal, realSafe(s)) : null);
      return rel ? norm(rel) : null;
    }
    // Relativo que se ESCAPA del repo (`../otro/x.ts`): tampoco puede seleccionar una app acá.
    if (s === '..' || s.startsWith('../')) return null;
    // Relativo a un ancestro: `<basename del repo>/resto` → `resto`.
    const base = norm(path.basename(raiz));
    if (base && (s === base || s.startsWith(base + '/'))) return norm(s.slice(base.length + 1)) || null;
    return s;
  };
  const tocados = changedFiles.map(aRepoRelativo).filter(Boolean);

  // Si NADA de lo que llegó cae dentro del repo, no se puede decidir qué apps ejercer. Eso NO
  // es "ninguna app tocada": es "no sé". Se cae al mismo fail-safe que la lista vacía —correr
  // todas— porque correr de más cuesta minutos y correr de menos es el bug de arriba.
  if (!tocados.length) return todas.slice();

  // Rutas de código COMPARTIDO entre apps (`e2e.shared_paths`). Un cambio ahí involucra a
  // TODAS, no sólo a la app en cuyo directorio vive el archivo. Esto no es teórico:
  // casi todo el código común puede vivir DENTRO de una app y las otras lo importan
  // (por eso existe el gate `docs/cross-form-imports-gate.sh`), así que sin esto un cambio en
  // una app dejaría a las otras sin ejercer.
  const compartidos = (cfg && Array.isArray(cfg.shared_paths) ? cfg.shared_paths : []).map(norm).filter(Boolean);

  // 🔴 La config del PROPIO control es compartida SIEMPRE. Un
  // commit que da de alta el tier crítico en un frontend y sólo toca `.tycon/advisors.yaml` + el manifest
  // no cae bajo ninguna app ni bajo `shared_paths`, así que esto devolvería `[]` ("0 apps tocadas") — y NO es
  // el fail-safe de arriba, porque sí hay archivos tocados; simplemente ninguna declaración
  // los cubre. Es la MISMA clase de bug que motiva `shared_paths`, un nivel más arriba:
  // en la config del control en vez de en código de producto. Una edición que rompa el
  // manifest (path mal escrito, substring que deja de matchear, puerto equivocado en una
  // precondition) se mergearía sin que el tier la detecte. Se trata como compartido sin
  // depender de que cada repo se acuerde de declararlo: la declaración manual es justo lo que
  // falla. Test: `GateMerge_LaConfigDelControlEsCompartida`.
  //
  // 🔴 PREFIJOS, no rutas exactas. Una lista como `['.tycon/advisors.yaml']`
  // + el manifest declarado obligaría a ACORDARSE de agregar cada archivo de config
  // nuevo — ése es el modo de falla de depender de una declaración manual, un nivel más
  // abajo. Con `.tycon` entero como prefijo, una precondición, un manifest nuevo o cualquier
  // config futura entran solas.
  //
  // Y se suma el SCRIPT DEL GATE que declara el repo (`e2e.gate`): sin él, un commit
  // que MODIFICA el ejecutor de las pruebas no seleccionaría ninguna app y saldría "ninguna de las
  // apps declaradas fue tocada" — se podría romper el runner de E2E sin que corra un solo E2E.
  // Con `frontend_dir: .` todo selecciona la app, así que ahí no hace falta.
  // Sólo cuenta si el gate vive DENTRO del repo — el gate por default del harness vive en el
  // skill y `path.relative` lo deja afuera, que es lo correcto: no es código de este repo.
  const propios = ['.tycon'];
  const relAlRepo = (p) => {
    const m = norm(p);
    if (!(path.isAbsolute(m) && raiz)) return (m && !m.startsWith('../')) ? m : null;
    const rel = relativeInsideRepo(raiz, m);
    return rel ? norm(rel) : null;
  };
  for (const p of [cfg && cfg.critical_manifest, cfg && cfg.gate]) {
    if (!p) continue;
    const rel = relAlRepo(p);
    if (rel && !propios.includes(rel)) propios.push(rel);
  }
  // Sin distinguir mayúsculas: la Mac y Windows no las distinguen, y una ruta escrita con otra caja que la declarada es
  // la misma carpeta; seleccionar de más corre de más, nunca de menos.
  const tocadosSinCaja = tocados.map((f) => f.toLowerCase());
  if ([...compartidos, ...propios].map((sp) => sp.toLowerCase()).some((sp) => tocadosSinCaja.some((f) => f === sp || f.startsWith(sp + '/')))) {
    return todas.slice();
  }

  return todas.filter((abs) => {
    const rel = raiz ? norm(path.relative(raiz, abs)) : norm(path.basename(abs));
    // App en la raíz del repo (`frontend_dir: .`): cualquier cambio la involucra.
    if (rel === '' || rel === '.') return true;
    const r = rel.toLowerCase();
    return tocadosSinCaja.some((f) => f === r || f.startsWith(r + '/'));
  });
}

// ── pipeline.js timing-report — instrumentación ─
// Desglosa dónde se fue el wall-clock de la corrida: steps (marker.stepTimings),
// iteraciones del paso de revisores (marker.iterations) y gates ejecutados (gates.log).
// Sin esto, los "25 min" son anécdota y los speedups se priorizan a ciegas.
function computeTimingReport() {
  const marker = readSessionMarker();
  if (!marker || !marker.storyId) {
    return { error: 'sin marker activo en esta sesión — timing-report opera sobre la corrida en curso' };
  }
  const timings = marker.stepTimings || {};
  const events = [];
  if (marker.startedAt) events.push({ label: 'pipeline-start', ts: marker.startedAt });
  for (const [step, t] of Object.entries(timings)) {
    // El arranque también es un evento — sin él, delta_min del paso incluiría el hueco previo.
    if (t && t.startedAt) events.push({ label: `step-${step}-start`, ts: t.startedAt });
    if (t && t.completedAt) events.push({ label: `step-${step}-done`, ts: t.completedAt });
  }
  for (const [iter, snap] of Object.entries(marker.iterations || {})) {
    if (snap && snap.ts) events.push({ label: `step5-iter${iter}-snapshot`, ts: snap.ts });
  }
  events.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const rows = events.map((e, i) => ({
    ...e,
    delta_min: i === 0 ? 0 : Math.round((new Date(e.ts) - new Date(events[i - 1].ts)) / 600) / 100,
  }));

  // Gates de esta sesión/story desde gates.log.
  let gates = [];
  try {
    const raw = fs.readFileSync(path.join(stateDirOf(os.homedir()), 'gates.log'), 'utf8');
    const sid = resolveSessionId();
    gates = raw.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((g) => g && g.sessionId === sid && (!g.storyId || g.storyId === marker.storyId))
      .map((g) => ({ ts: g.ts, check: g.check, status: g.status, durationMs: g.durationMs, provenance: g.provenance }));
  } catch { /* sin gates.log */ }

  const totalMin = events.length >= 2
    ? Math.round((new Date(events[events.length - 1].ts) - new Date(events[0].ts)) / 600) / 100
    : 0;
  return {
    story_id: marker.storyId,
    total_min_so_far: totalMin,
    timeline: rows,
    gates,
    note: 'delta_min = minutos desde el evento anterior. Steps sin complete-step no aparecen (corré marker.js complete-step N al cerrar cada step).',
  };
}

function cmdTimingReport(cmd, args) {
  const result = computeTimingReport();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.error ? 1 : 0);
}

function cmdCostReport(cmd, args) {
  // Termómetro de costo del pipeline. Lee los logs de spawns reales que
  // escribe `on-advisor-run.js` y reporta
  // la palanca real: CUÁNTOS agentes se abren, cuántos son de exploración libre, y en qué
  // fase. NO estima tokens — el dato de tokens por spawn no está en el log; la referencia
  // medida es ~60-100K por spawn, así que el conteo YA es el proxy de costo.
  // Uso: pipeline.js cost-report [--session <sid>] [--limit N]
  const ADHOC_SET = new Set(['general-purpose', 'Explore', 'Plan', 'claude']);
  const runsDir = path.join(stateDirOf(os.homedir()), 'advisor-runs');
  const out = { sessions: [], totals: { runs: 0, spawns: 0, adhoc: 0, adhoc_pre_step5: 0, sin_model: 0 } };
  let archivos = [];
  try { archivos = fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')); } catch { archivos = []; }
  if (args.session) archivos = archivos.filter((f) => f.startsWith(args.session));
  for (const fn of archivos) {
    let lineas = [];
    try { lineas = fs.readFileSync(path.join(runsDir, fn), 'utf8').split('\n'); } catch { continue; }
    const s = { session: fn.replace(/\.jsonl$/, ''), spawns: 0, adhoc: 0, adhoc_pre_step5: 0, sin_model: 0, iteraciones: 0, por_tipo: {} };
    let vistoStep5 = false;
    for (const l of lineas) {
      if (!l.trim()) continue;
      let d; try { d = JSON.parse(l); } catch { continue; }
      if (d.event === 'step5-start') { vistoStep5 = true; s.iteraciones++; continue; }
      if (!d.advisor) continue;
      s.spawns++;
      s.por_tipo[d.advisor] = (s.por_tipo[d.advisor] || 0) + 1;
      if (ADHOC_SET.has(d.advisor)) {
        s.adhoc++;
        if (!vistoStep5) s.adhoc_pre_step5++;
        // `model` no existe en las líneas viejas del log: es undefined y NO
        // se cuenta como "sin model" (sería ruido histórico, no una omisión real).
        if ('model' in d && !d.model) s.sin_model++;
      }
    }
    if (!s.spawns) continue;
    out.sessions.push(s);
    out.totals.runs++;
    out.totals.spawns += s.spawns;
    out.totals.adhoc += s.adhoc;
    out.totals.adhoc_pre_step5 += s.adhoc_pre_step5;
    out.totals.sin_model += s.sin_model;
  }
  out.sessions.sort((a, b) => b.spawns - a.spawns);
  const limite = Number.parseInt(args.limit || '10', 10);
  out.sessions = out.sessions.slice(0, limite);
  const t = out.totals;
  out.resumen = t.spawns
    ? `${t.spawns} spawns en ${t.runs} runs · ${t.adhoc} de exploración libre (${Math.round((t.adhoc / t.spawns) * 100)}%) · ` +
      `${t.adhoc_pre_step5} de ésos ANTES de los advisors · referencia: ~60-100K tokens por spawn`
    : 'sin spawns registrados';
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

function cmdEvidenceKey(cmd, args) {
  // Con qué CLAVE se nombra la evidencia de esta story: el número solo si es único en su
  // repo, `<tema>__<número>` si se repite. `--json` da además el tema y las stories que comparten número.
  if (!args.story) { process.stderr.write('uso: pipeline.js evidence-key --story <spec.md> [--json]\n'); process.exit(2); }
  try {
    const k = evidenceKey(path.resolve(args.story));
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(k, null, 2) + '\n');
    else process.stdout.write(k.key + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`evidence-key: ${e.message}\n`);
    process.exit(2);
  }
}

function cmdCompareCandidates(cmd, args) {
  // Los comandos que la historia modifica y existen en main (historia 8.167): cada uno necesita un humo comparado que
  // lo cubra (`smoke-run.sh --compare`) o una exención firmada (`marker.js compare-waiver`). Por candidato, su repo y
  // los subcomandos o funciones que el cambio toca. Los repos salen de la corrida de la sesión (lib/save-ok.js); sin
  // corrida, de `--repo a,b`, o del de la historia. `--json` da la lista entera.
  if (!args.story) { process.stderr.write('uso: pipeline.js compare-candidates --story <spec.md> [--repo <repo>[,<repo>]] [--json]\n'); process.exit(2); }
  const storyAbs = path.resolve(args.story);
  let repos;
  let m = null;
  try {
    m = readSessionMarker();
    const so = require('./save-ok.js');
    if (process.argv.includes('--repo')) repos = String(args.repo).split(',').map((r) => path.resolve(r.trim())).filter(Boolean);
    else if (args.filesDeclarado) repos = [...new Set(args.files.map((f) => so.raizDe(path.resolve(f))).filter(Boolean))];
    else if (m && m.storyPath) {
      const hermanos = require('./companion-repos.js').companionRoots(path.resolve(m.repoPath || process.cwd()), storyAbs);
      repos = so.reposDeLaCorrida({ marker: { ...m, storyPath: path.isAbsolute(m.storyPath) ? m.storyPath : path.resolve(m.repoPath || process.cwd(), m.storyPath) }, hermanos });
    } else repos = [so.raizDe(storyAbs)].filter(Boolean);
  } catch (e) { process.stderr.write(`compare-candidates: no pude calcular los repos de la corrida (${e.message})\n`); process.exit(2); }
  // con la tanda de la corrida, los mismos candidatos que exige el freno de «Preparar»
  const cpv = require('./compare-previous.js');
  const tanda = cpv.archivosDeLaTanda(m, storyAbs);
  const r = cpv.candidatos({ storyPath: storyAbs, repos, files: tanda.files });
  if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify({ repos, tanda, ...r }, null, 2) + '\n'); process.exit(0); }
  if (tanda.tanda) process.stderr.write(tanda.files ? `ℹ️  sólo la tanda ${tanda.tanda}\n` : `⚠️  sin parte medible de la tanda ${tanda.tanda}: comparo la historia entera (${tanda.motivo})\n`);
  for (const a of r.avisos) process.stderr.write(`⚠️  ${a}\n`);
  // lo que no se pudo mirar no es «sin candidatos»
  for (const n of r.noMedidos || []) process.stdout.write(`· ${n.archivo} (${path.basename(n.repo)}) — no medido: ${n.motivo}\n`);
  if (!r.candidatos.length && !r.sinRepo.length) {
    if (!(r.noMedidos || []).length) process.stdout.write('sin candidatos: la historia no modifica comandos que existen en main. No hay nada que comparar.\n');
    process.exit(0);
  }
  for (const c of r.candidatos) {
    const que = c.sinSubcomando ? 'el cambio cae fuera de todo subcomando: cubre cualquier humo que corra el archivo' : `subcomandos o funciones que el cambio toca: ${c.subcomandos.join(', ')}`;
    process.stdout.write(`· ${c.archivo} (${path.basename(c.repo)}) — ${que}\n`);
  }
  for (const s of r.sinRepo) process.stdout.write(`· ${s.archivo} — no comparado: sin repo (no está en ningún repo de la corrida): pide exención\n`);
  process.exit(0);
}

function cmdRunDir(cmd, args) {
  // La carpeta de la corrida de ESTA story: `.advisors/pipeline-runs/<clave>-<sello>/`, la misma que
  // usan el registro de revisores, el findings.json y los frenos. Los pasos del pipeline la piden acá en vez de armar
  // `<número>-<sello>` a mano: con un número repetido, una corrida quedaría partida en dos carpetas.
  // Imprime la ruta (exit 0) · sin carpeta y sin --create: exit 3, nada en stdout · sin clave calculable: exit 2 + motivo.
  if (!args.story) { process.stderr.write('uso: pipeline.js run-dir --story <spec.md> [--repo <repo>] [--create]\n'); process.exit(2); }
  const storyId = deriveStoryId(path.resolve(args.story));
  if (!storyId) { process.stderr.write(`run-dir: no pude leer la story ${args.story}\n`); process.exit(2); }
  const k = runDirKey(storyId, path.resolve(args.story));
  if (!k.key) { process.stderr.write(`run-dir: no pude calcular la clave de la carpeta: ${k.error}\n`); process.exit(2); }
  const dir = resolveRunDir(path.resolve(args.repo || process.cwd()), storyId, process.argv.includes('--create'), path.resolve(args.story));
  if (!dir) { process.stderr.write(`run-dir: todavía no hay carpeta de corrida para ${k.key} (pasá --create para crearla)\n`); process.exit(3); }
  process.stdout.write(dir + '\n');
  process.exit(0);
}

function cmdEvidenceDir(cmd, args) {
  // Dónde va la evidencia de cierre de ESTA story: el repo git que la contiene,
  // aunque el código (y el cwd del pipeline) esté en otro. Es lo que el portón de CI del repo
  // de la story va a buscar. `--plain` imprime sólo la ruta, para meterla en un script.
  if (!args.story) { process.stderr.write('uso: pipeline.js evidence-dir --story <spec.md> [--repo <dir>] [--plain]\n'); process.exit(2); }
  const r = evidenceDirForStory(path.resolve(args.story), args.repo);
  if (!r.dir) { process.stderr.write(`evidence-dir: ${r.warning}\n`); process.exit(1); }
  if (process.argv.includes('--plain')) { process.stdout.write(r.dir + '\n'); process.exit(0); }
  const out = {
    evidence_dir: r.dir, story_repo: r.storyRepo, repo: r.repo, cross_repo: r.crossRepo, source: r.source,
    ...(r.warning ? { warning: r.warning } : {}),
  };
  // ¿Ese repo deja viajar la evidencia? Si su .gitignore la traga, el portón va a dar rojo igual.
  try {
    const { notices } = computeGitignoreNeeds(gitIgnoraProbe(r.storyRepo || r.repo));
    if (notices.length) out.gitignore_notices = notices;
  } catch { /* sin git no hay aviso */ }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

function cmdE2eConfig(cmd, args) {
  // Resuelve el gate E2E del proyecto (.tycon/advisors.yaml → e2e.*). Salida JSON
  // {gate, frontend_dir, frontend_dirs, critical_manifest} con paths absolutos, o {} si el
  // repo no declara gate. Lo consumen la prueba en vivo (scoped) y tycon-merge-to-main (critical+full).
  //
  // Con `--changed <archivos...>` agrega `frontend_dirs_selected`: las apps del
  // monorepo que ESA entrega tocó. Sin el flag, `selected` == todas (fail-safe: correr de más
  // cuesta minutos, correr de menos deja pasar la regresión).
  const cfg = e2eConfig(args.repo);
  if (cfg && cfg.gate) {
    cfg.frontend_dirs_selected = selectE2eApps(cfg, args.changed);
    // El consumidor hace `(selected || [frontend_dir])` y en JS `[] || x` devuelve `[]` (un
    // array vacío es truthy), así que un `selected` vacío NO cae al fallback: el loop del gate
    // itera cero veces y sale 0. Cuando eso pasa es porque la entrega de verdad no tocó
    // ninguna app — legítimo, pero tiene que ser RUIDOSO, no un verde mudo.
    if (!cfg.frontend_dirs_selected.length) {
      cfg.warning = 'Ninguna de las apps declaradas fue tocada por los archivos de --changed → ' +
        'el gate E2E no va a correr NADA. Si eso te sorprende, revisá que los paths de --changed ' +
        'sean del repo (absolutos o repo-relativos, ambos valen) antes de dar el gate por verde.';
    }
  }
  process.stdout.write(JSON.stringify(cfg) + '\n');
  process.exit(0);
}

module.exports = { cmdTimingReport, cmdCostReport, cmdEvidenceKey, cmdRunDir, cmdEvidenceDir, cmdCompareCandidates, cmdE2eConfig, computeGitignoreNeeds, gitIgnoraProbe, GITIGNORE_ADVISORS, e2eConfig, selectE2eApps };
