#!/usr/bin/env node
/**
 * tycon-ci-gate.js — los controles del arnés que SÍ pueden correr del lado del servidor.
 *
 * ── POR QUÉ EXISTE (auditoría del 2026-08-25, §5.4 del plan de controles apagables) ─────────────
 * *"Todo el barrido fue de controles LOCALES (pre-commit y hooks de sesión). Un control que sólo
 * corre local se saltea con una bandera de git; ese bloqueo existe pero no se verificó acá."*
 *
 * Medido el 2026-08-25 sobre los repos del equipo: **31 pipelines de CI y NINGUNO corre un control
 * del arnés** (las 3 coincidencias del barrido eran nombres de solución `Tycon.BIZUIT.*`, no
 * controles). O sea que toda la protección del arnés es **condicional a la máquina**:
 *
 *   · una persona sin el arnés instalado (alguien nuevo, otra máquina) commitea sin ningún control;
 *   · un merge o una edición hechos desde la web de Azure DevOps no pasan por ningún hook;
 *   · sin `core.hooksPath` global, los `.githooks/` del repo no corren — y eso ya pasó
 *     (`incident-log#hookspath-eclipse`);
 *   · la bandera que saltea hooks está frenada por el guard, pero **sólo si el guard está puesto**.
 *
 * El freno local sigue siendo el que atrapa temprano y con buen mensaje. Éste es la red de abajo:
 * lo que igual se verifica cuando el commit ya llegó al servidor.
 *
 * ── QUÉ CHEQUEA, Y POR QUÉ SÓLO ESTO ────────────────────────────────────────────────────────────
 * Únicamente lo que se puede decidir **con el repo y nada más**. Un control que necesita el estado
 * de la sesión (`~/.claude/...`), la base de engram o un servidor local NO puede correr acá, y
 * fingir que sí sería peor que no tenerlo.
 *
 *   1. **Frontmatter de stories legible** — cuando el frontmatter no parsea, las tools no dan
 *      error: saltean la story EN SILENCIO (caso de un producto del equipo, 2026-07-24: 4 stories invisibles 2 meses).
 *   2. **Evidencia de cierre** — una story que pasa a `review`/`done` en este diff tiene que traer
 *      su evidencia EN EL REPO (`.advisors/dod-runtime/<id>-*.md`, sin contar la matriz por AC, el
 *      self-audit ni el plan manual — 2026-09-05). Es la mitad del gate local que no depende de la
 *      sesión. Si el código vive en otro repo, la evidencia igual nace acá (`guides/ci-gate.md`).
 *   3. **Constancia de revisores** — una story que pasa a `done` tiene que tener una corrida del
 *      pipeline en el repo (`.advisors/pipeline-runs/<id>-…`). Es el ADVISORS-GATE del pre-commit,
 *      en su mitad verificable desde el servidor (la otra mitad vive en el `gates.log` local).
 *
 * Los tres son MECÁNICOS: sin modelo, sin red, sin estado de sesión.
 *
 * ── ADOPCIÓN ────────────────────────────────────────────────────────────────────────────────────
 * Opt-in por repo. No se adoptó en ninguno todavía: meter un paso nuevo en 31 pipelines de cliente
 * es decisión del dev, no de un script. El snippet de ADO está en `guides/ci-gate.md`.
 *
 * Uso:  node tycon-ci-gate.js [--repo <dir>] [--base <ref>] [--staged] [--json] [--selftest]
 *       `--staged` mira lo que está por commitearse (para el `.githooks/pre-commit` del repo) en
 *       vez del diff contra una rama; mismo criterio, mismo mensaje, diez segundos antes.
 * Exit: 0 al día · 1 hay stories que no deberían haber llegado al servidor
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

function git(repo, args, opts) {
  return execFileSync('git', ['-C', repo, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, maxBuffer: 32 * 1024 * 1024, ...(opts || {}) });
}

// 🔴 El criterio de "esto es una story" se IMPORTA del lint local, no se reescribe. La primera
// versión de este portón tenía el suyo propio y dio un falso positivo el mismo día: tomó por story
// rota un reporte de medición que declara `story:` en el CUERPO, sin frontmatter. El lint local ya
// había pagado esa lección (2026-08-23: el criterio anterior habría rechazado 331 de los 1608 `.md`
// de un repo del equipo). Dos detectores del mismo concepto son el drift de mañana.
const detector = require(path.join(__dirname, '..', 'lib', 'lint-story-frontmatter.js'));
const { readEnv, envNames } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));
const { aliasLegacyOptions } = require(path.join(__dirname, 'legacy-options.js'));
const WHERE = 'scripts/ci/tycon-ci-gate.js';

// Las dos llaves que hoy avisan (TYCON_REVIEW_A_DONE y TYCON_ROSTER_NAMES) vuelven a frenar con el mismo valor: `block`
// (story 8.9, tanda G — como TYCON_ATDD_COMMIT_GATE=block). El valor de antes, una palabra en castellano, sigue valiendo
// hasta el retiro: el par va declarado acá como los de las opciones de esta carpeta (`<nombre>=<viejo>:<nuevo>`), para
// que el mapa de renombres y el guion digan lo mismo (lo cruza `spanish-names.js --check-map`), y lo pasa al nuevo el
// mismo traductor, que además anota el uso. El nombre del par es el de la primera de las dos llaves; vale para las dos.
const BLOCK = 'block';
const PAR_DE_LA_LLAVE = 'TYCON_REVIEW_A_DONE';
/** ¿El valor de una llave dice «frená»? */
function llaveFrena(valor) {
  if (valor === undefined || valor === null) return false;
  // (el primer argumento va sin comillas simples: `--check-map` lee la declaración del par con una expresión que no las cruza)
  return aliasLegacyOptions([`--${PAR_DE_LA_LLAVE}`, String(valor)], 'TYCON_REVIEW_A_DONE=freno:block', WHERE)[1] === BLOCK;
}

/** Frontmatter de un texto, o null si no cierra. */
function frontmatter(txt) {
  if (!txt.startsWith('---')) return null;
  const fin = txt.indexOf('\n---', 3);
  return fin === -1 ? null : txt.slice(3, fin);
}

/** ¿Este texto DECLARA ser una story? (identidad declarada, criterio del lint local) */
function declaraSerStory(txt, rel) {
  const zona = detector.frontmatterZone(String(txt).slice(0, 8192));
  if (zona === null) return false;                                   // sin `---`: no es una story
  if (detector.NOT_A_STORY_NAME.test(path.basename(rel))) return false;  // plantillas y ejemplos
  return detector.DECLARES_STORY.test(zona);
}

/** Escalar del frontmatter — MISMO regex que usan las tools del arnés (si esto lee, ellas leen). */
function escalar(fm, clave) {
  const m = String(fm).match(new RegExp(`^${clave}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}

const LISTOS = new Set(['review', 'done']);

// El árbol vacío de git. Con él se puede pedir un `diff --cached` en un repo que todavía no tiene
// ningún commit — ahí `HEAD` no existe y la forma corta falla.
const ARBOL_VACIO = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Archivos `.md` que el diff toca: contra `base` en el servidor, contra HEAD (o sea, el ÍNDICE:
 * lo que está por commitearse) en el pre-commit.
 */
function mdDelDiff(repo, base, staged) {
  let salida = '';
  if (staged) {
    try { salida = git(repo, ['diff', '--cached', '--name-only']); }
    catch (_e) {
      try { salida = git(repo, ['diff', '--cached', '--name-only', ARBOL_VACIO]); }
      catch (_e2) { return { error: 'no pude leer lo que está por commitearse (`git diff --cached`)' }; }
    }
    return { files: salida.split('\n').filter((f) => f.endsWith('.md')) };
  }
  try { salida = git(repo, ['diff', '--name-only', `${base}...HEAD`]); }
  catch (_e) {
    try { salida = git(repo, ['diff', '--name-only', base, 'HEAD']); } catch (_e2) { return { error: `no pude comparar contra \`${base}\`` }; }
  }
  return { files: salida.split('\n').filter((f) => f.endsWith('.md')) };
}

// `ref` vacío NO es un descuido: `git show :ruta` es la versión del ÍNDICE, que es exactamente
// "lo que está por commitearse". Es lo que hace que el mismo motor sirva de los dos lados.
function contenidoEn(repo, ref, rel) {
  try { return git(repo, ['show', `${ref}:${rel}`]); } catch (_e) { return null; }
}

// 🔴 No todo `<id>-*` es evidencia de cierre (2026-09-05, revisión adversarial del caso de un producto del equipo):
// la matriz por AC (`-runtime-matrix.md`) lista los ACs INCLUIDOS los que no tienen evidencia, y
// el self-audit y el plan de prueba manual los escribe el agente libremente. El freno local ya los
// excluía (`findDodEvidence` de on-pre-commit.js); este portón no, así que una copia de SÓLO la
// matriz —o un ledger suelto— lo ponía verde sin una corrida real detrás. Mismo criterio que el
// local: un `.md` con el prefijo de la story que no sea ninguno de esos tres.
// 🔴 Es una COPIA deliberada de `lib/closing-evidence.js` del skill (2026-09-06): este portón corre
// en un agente sin `~/.claude/`, así que no puede importarla. Las dos las compara
// `scripts/tests/closing-evidence-parity.test.js` en cada corrida — mismo mecanismo que cuida
// `validarRoster`. El medidor del tablero importa ESTA copia (mismo repo), así que son dos en total.
// 2026-10-14 — el freno del commit pasó a sumar por AC la UNIÓN de las tres fuentes que escribe la máquina (registro de
// pruebas de humo, gates E2E y firmas del dev; `coberturaDeLaUnion` en la canónica). Acá no se copia a propósito: este
// portón nunca miró criterio por criterio —pide que exista evidencia de cierre— y la validez de las dos primeras
// fuentes se confirma contra gates.log, que vive en la máquina y no en el agente. Lo que sí comparten las dos capas
// es esta lista, y con ella el registro (`-smoke-ledger.jsonl`) y el gate (`-e2e-gate-*.md`) ya cuentan como evidencia;
// el `-cierre.md`, si existe, también (es un `.md`).
const NO_ES_EVIDENCIA_DE_CIERRE = [/-self-audit(?:-iter\d+)?\.md$/, /-runtime-matrix\.md$/, /-manual-test-plan\.md$/];
// El ledger de smokes CUENTA (decisión del dev, 2026-09-06): es el registro crudo de cada prueba
// que corrió, escrito por la máquina — más difícil de falsear que un informe. Motivo completo en
// la canónica del skill.
const ES_EVIDENCIA_ADEMAS = [/-smoke-ledger\.jsonl$/];
function esEvidenciaDeCierre(f) {
  const n = String(f || '');
  if (ES_EVIDENCIA_ADEMAS.some((re) => re.test(n))) return true;
  return n.endsWith('.md') && !NO_ES_EVIDENCIA_DE_CIERRE.some((re) => re.test(n));
}

// La CLAVE de la evidencia de cierre (story 1.17): con un número repetido en el repo, `<id>-*` es la
// evidencia de cualquiera de las stories que lo comparten — el portón le daría a una la de la otra. La calcula
// lib/evidence-key.js del skill tycon-pipeline, que se encuentra igual que el descubridor de stories del lint.
// Sin la biblioteca, el id de siempre y un aviso visible: el portón no deja de correr por esto.
let evidenceKeyLib = null;
let evidenceKeyFalta = null;
try {
  const skills = require(path.join(__dirname, '..', 'lib', 'skills-dir.js')).resolveSkillsDirs().skills;
  evidenceKeyLib = require(path.join(skills, 'tycon-pipeline', 'scripts', 'lib', 'evidence-key.js'));
} catch (e) { evidenceKeyFalta = e.message; }

/** El prefijo de la evidencia de cierre: `<clave>-`, o null si la clave no se puede decidir (no hay evidencia). */
// La regla es la de `evidencePrefix` (lib/evidence-key.js), la misma que usa el freno del frontmatter (story 1.17.1,
// tanda 2): sin ruta, el número; con ruta y sin archivo, nada —no se sabe si el número se repite—; sin clave, nada. Lo
// propio del portón es sólo el aviso, y el respaldo si la biblioteca no está.
function prefijoDeEvidencia(storyId, storyPath) {
  if (!storyPath) return `${storyId}-`;
  if (!evidenceKeyLib || typeof evidenceKeyLib.evidencePrefix !== 'function') {
    // Sin la biblioteca, lo único que se puede sostener sin ella: una story que no está en disco no da nada por bueno.
    if (!fs.existsSync(storyPath)) {
      process.stderr.write(`⚠️  tycon-ci-gate: no encuentro la story ${storyPath} — sin ella no sé si el número ${storyId} se repite, así que no doy evidencia ni constancia por buenas.\n`);
      return null;
    }
    const falta = evidenceKeyLib ? 'está, pero es una versión vieja sin evidencePrefix: la copia de las skills quedó atrasada' : `no la encontré: ${evidenceKeyFalta}`;
    process.stderr.write(`⚠️  tycon-ci-gate: lib/evidence-key.js ${falta} — la evidencia de ${storyId} se busca por el número solo: en un número repetido puede ser de otra story.\n`);
    return `${storyId}-`;
  }
  const { prefix, error } = evidenceKeyLib.evidencePrefix(storyPath, storyId);
  // «No pude calcular la clave» no es «no hay evidencia»: el motivo se dice, para que nadie busque un archivo que falta.
  if (!prefix) process.stderr.write(`⚠️  tycon-ci-gate: ${error} — sin clave no doy evidencia ni constancia por buenas.\n`);
  return prefix;
}

/** ¿Hay evidencia de este tipo para esta story, en cualquier parte del repo? `storyPath`: ver prefijoDeEvidencia. */
// `prefijoYa` (opcional): el prefijo ya calculado por quien llama — `undefined` = calcularlo acá. Así `revisar` lo
// calcula UNA vez por story (recorrer el repo y avisar dos veces era costo y ruido; revisión de la 1.17.1).
function hayEvidencia(repo, sub, storyId, storyPath, prefijoYa) {
  const raiz = path.join(repo, '.advisors', sub);
  const dirs = [raiz];
  // Los monorepos guardan la evidencia por sub-proyecto: se mira un nivel más.
  try {
    for (const e of fs.readdirSync(repo, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      dirs.push(path.join(repo, e.name, '.advisors', sub));
    }
  } catch (_e) { /* raíz ilegible */ }
  // Las carpetas de corrida (`pipeline-runs`) van por la misma clave desde la story 1.17.1: con un número repetido,
  // `<id>-*` le daba a una story la constancia de revisores de otra.
  const prefijo = prefijoYa !== undefined ? prefijoYa : prefijoDeEvidencia(storyId, storyPath);
  if (!prefijo) return false;
  for (const d of dirs) {
    let entradas = [];
    try { entradas = fs.readdirSync(d); } catch (_e) { continue; }
    if (entradas.some((f) => f.startsWith(prefijo) && (sub !== 'dod-runtime' || esEvidenciaDeCierre(f)))) return true;
  }
  return false;
}

// ── Regla 4: registro de autoría (revisor ≠ autor) ─────────────────────────────────────────────
// El AI-Native SDLC Playbook pide un revisor con IA en el servidor. Acá la revisión ya ocurre
// ANTES del PR y con más contexto (la sesión implementa, ~28 advisors subagentes revisan) — lo que
// faltaba era que el rastro lo DIJERA, para poder exigirlo en vez de confiar. Lo escribe el hook
// `on-advisor-run.js` derivándolo del ledger de spawns reales: `review-roster.json` en el run dir.
//
// 🔴 Corte por fecha, MECÁNICO y sin config: el nombre del run dir trae su timestamp. Un run
// anterior al estreno de la pieza no puede tener roster — su ausencia AVISA. De ahí en adelante,
// la ausencia FRENA. Y un roster presente pero mentiroso o incoherente frena SIEMPRE, sin corte:
// dato malo es peor que dato ausente (lección: incident-log#porton-ci-debut-no-corrio-2026-08-30).
const CUTOFF_ROSTER = process.env.TYCON_ROSTER_CUTOFF || '20260831';

// Por la clave de la story (story 1.17.1), igual que la constancia: `storyPath` es la ruta de la story en el repo.
// Sin clave calculable no hay carpeta que dar por suya (prefijoDeEvidencia ya dijo el motivo).
function runDirsDeStory(repo, storyId, storyPath) {
  const pref = prefijoDeEvidencia(storyId, storyPath);
  if (!pref) return [];
  const clave = pref.slice(0, -1);
  const bases = [path.join(repo, '.advisors', 'pipeline-runs')];
  try {
    for (const e of fs.readdirSync(repo, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      bases.push(path.join(repo, e.name, '.advisors', 'pipeline-runs'));
    }
  } catch (_e) { /* raíz ilegible */ }
  const out = [];
  for (const b of bases) {
    let entradas = [];
    try { entradas = fs.readdirSync(b); } catch (_e) { continue; }
    for (const n of entradas) {
      if (n !== clave && !n.startsWith(`${clave}-`)) continue;
      // El sello de fecha del run dir tiene DOS formas en los repos reales: `1.1-20260825120000`
      // y `4.2-20260824-1200` (fecha y hora separadas). Leer sólo la primera dejaba a la segunda
      // "sin fecha" — y sin fecha esto frenaba corridas viejas que no pueden tener el registro.
      // Lo cazó el banco de controles, no la lectura del código.
      const m = n.match(/-(\d{8})(?:-?\d*)?$/);
      out.push({ dir: path.join(b, n), nombre: n, stamp: m ? m[1] : null });
    }
  }
  return out;
}

/** Advisors nombrados en los hallazgos del run — el cruce que SÍ se puede hacer server-side. */
function advisoresEnFindings(runDir) {
  const nombres = new Set();
  let raw;
  // Que FALTE es normal (una corrida puede no tener hallazgos) y se calla. Que esté ROTO apaga el
  // cruce entero sin que nadie se entere, y eso no es «está todo bien»: se dice por stderr
  // (2026-09-22 — el mismo punto ciego lo tenía el freno local y lo cazó el revisor de fallos
  // silenciosos). Sigue sin frenar: un archivo ilegible no es una incoherencia probada.
  try { raw = fs.readFileSync(path.join(runDir, 'findings.json'), 'utf8'); } catch (_e) { return null; }
  // 🔴 Este aviso sale por el registro PÚBLICO de la corrida del portón, así que dice lo justo:
  // el nombre de la corrida, nunca la ruta absoluta del checkout (lleva el nombre del repo y del
  // cliente), y NUNCA el mensaje crudo del parser — en V8 ese mensaje arrastra el token que rompió
  // el parseo, o sea un pedazo real del archivo. Mismo criterio que `cierre-recortado` T10 le exige
  // a la constancia del cierre. El que necesita el detalle lo tiene en su máquina.
  const cual = `${path.basename(runDir)}/findings.json`;
  let data;
  try { data = JSON.parse(raw); } catch (_e) {
    console.error(`⚠️  ${cual} no se puede leer (JSON inválido): el cruce entre quién firmó los `
      + 'hallazgos y quién figura en el registro de revisores NO corrió.');
    return null;
  }
  // 🔴 El tercer camino, y el que se había quedado afuera: JSON válido pero con una forma que no
  // es ni una lista ni `{findings: [...]}`. Caía al `[]` mudo, o sea que el cruce se apagaba sin
  // que nadie se enterara — el mismo agujero que se acababa de cerrar para el JSON roto, dos
  // líneas más arriba. Lo reprodujo en vivo el revisor de fallos silenciosos en la segunda vuelta,
  // sobre el arreglo de la primera: el arreglo estaba incompleto y la afirmación de que el punto
  // ciego estaba cerrado era falsa. Los tres casos son ahora los mismos que en el freno local.
  let lista;
  if (Array.isArray(data)) lista = data;
  else if (Array.isArray(data && data.findings)) lista = data.findings;
  else {
    console.error(`⚠️  ${cual} no es una lista de hallazgos: el cruce entre quién firmó los `
      + 'hallazgos y quién figura en el registro de revisores NO corrió. No es «está todo bien».');
    return null;
  }
  const conTramo = new Map();
  for (const f of lista) {
    const a = f && (f.advisor || f.agent || f.source);
    if (typeof a !== 'string' || !a) continue;
    const clave = `${a}|${(f && f.tramo) || ''}`;
    if (!conTramo.has(clave)) conTramo.set(clave, f && f.tramo ? { advisor: a, tramo: f.tramo } : a);
    nombres.add(a);
  }
  return [...conTramo.values()];
}

function revisarAutoria(repo, storyId, storyPath) {
  const dirs = runDirsDeStory(repo, storyId, storyPath);
  if (!dirs.length) return []; // la regla 3 ya cubre "no hay ningún run dir"
  const hallazgos = [];
  // Alcanza con que UN run dir de la story traiga el registro válido (el re-loop puede dejar
  // varios; el bueno es el que tiene el roster).
  let algunoValido = false;
  let algunoPostCutoff = false;
  const problemasVistos = [];
  for (const { dir, nombre, stamp } of dirs) {
    // Sin fecha legible NO se reclama la ausencia: un repo con otra convención de nombres no puede
    // pagar por una regla que no existía cuando corrió. Lo que SÍ frena siempre es el dato
    // presente y malo, y eso no depende del sello.
    if (stamp && stamp >= CUTOFF_ROSTER) algunoPostCutoff = true;
    let roster = null;
    let ilegible = null;
    try {
      roster = JSON.parse(fs.readFileSync(path.join(dir, 'review-roster.json'), 'utf8'));
    } catch (e) {
      if (e && e.code !== 'ENOENT') ilegible = String(e.message).slice(0, 120);
    }
    if (ilegible) {
      // Presente y roto: frena siempre, haya corte o no.
      hallazgos.push({ regla: 'registro-de-autoria-invalido',
        mensaje: `\`${nombre}/review-roster.json\` no se puede leer (${ilegible}). Un registro ilegible no es un registro: regeneralo corriendo los revisores, o declará \`advisors_exempt: true\` con su razón.` });
      continue;
    }
    if (!roster) continue;
    const v = validarRoster(roster, advisoresEnFindings(dir));
    if (v.ok) { algunoValido = true; continue; }
    for (const p of v.problemas) problemasVistos.push({ ...p, nombre });
  }
  if (algunoValido) return hallazgos;
  // Ningún roster válido: o hay problemas concretos (frenan siempre), o falta el archivo.
  if (problemasVistos.length) {
    for (const p of problemasVistos) {
      hallazgos.push({ regla: p.regla, mensaje: `\`${p.nombre}/review-roster.json\`: ${p.detalle}`, ...(p.validado ? { validado: true } : {}) });
    }
    return hallazgos;
  }
  if (!algunoPostCutoff) return hallazgos; // run viejo: la ausencia no se le puede reclamar
  hallazgos.push({ regla: 'sin-registro-de-autoria',
    mensaje: `pasa a \`done\` y ningún \`.advisors/pipeline-runs/${prefijoDeEvidencia(storyId, storyPath)}*/\` trae \`review-roster.json\` (quién implementó y quiénes revisaron). Lo escribe solo el hook al cerrar la ronda de revisores; si esta story se cerró sin pipeline, declaralo con \`advisors_exempt: true\` + su razón.` });
  return hallazgos;
}

/**
 * Validación del roster. Es una COPIA deliberada de `lib/review-roster.js → validate` del skill:
 * el portón corre en un agente de CI que sólo hace checkout de este repo y del repo del producto,
 * sin `~/.claude/`. La paridad entre las dos definiciones la cuida
 * `scripts/tests/roster-validate-parity.test.js`, que corre LAS DOS sobre los mismos casos y
 * compara veredicto y reglas — no la buena memoria de quien las edite. (Ese test nació porque este
 * comentario afirmaba que un caso del banco cuidaba la paridad y ese caso no existía: un control
 * documentado que no corre. Lo cazó el pase adversarial de la pieza.)
 */
// Por PREFIJO, idéntico a `lib/review-roster.js` (2026-09-06): medido sobre los runs reales
// faltaban cinco fuentes del propio pipeline y la story 2.1 daba `roster-incoherente` ×3.
const FUENTES_SINTETICAS = [
  /^mech-check$/, /^pipeline$/,
  /^adversarial-verify(\s|:|\(|-|$)/,   // `-fable`, `-opus`: nombres reales de la 4.4 (2026-09-14)
  /^pase adversarial(\s|:|\(|-|$)/,     // el mismo paso 5b nombrado en castellano (AG-2, 2026-09-22)
  /^orquestador(\s|\(|$)/,
  /^runtime-matrix(\s|\(|$)/,
  /^e2e-runtime(\s|:|\(|-|$)/,          // el gate de E2E del step 7c: tampoco es un spawn (AG-3, 2026-09-22)
  /^ensayo runtime(\s|\(|$)/,
];

// 🔴 El nombre del revisor se escribe en DOS lados con dos criterios (2026-09-22, un pull request de
// Totora): el roster lo proyecta una máquina desde el ledger de spawns —`tycon-silent-failure-hunter`,
// pelado—, y el `advisor` de `findings.json` lo tipeaba el orquestador, que le agregaba la vuelta o
// el modelo para que un humano lo lea: `tycon-silent-failure-hunter (iter 3)`. Comparados letra por
// letra, el segundo "no figura entre los revisores" y el portón frena un PR sano.
//
// ── POR QUÉ EL RECORTE SIGUE ACÁ (story 7.13, AC 6) ──────────────────────────────────────────
// La causa ya está arreglada del lado de quien ESCRIBE: desde la 7.13 `write-findings` valida el
// firmante contra los revisores de esa corrida y guarda el id pelado, con la anotación en campos
// propios (`iter`, `model`, `nota`). O sea que los hallazgos NUEVOS no traen paréntesis.
//
// Pero el portón no lee sólo hallazgos nuevos. Medido el 2026-09-22 sobre los run dirs del disco:
// **54 hallazgos en 11 corridas YA COMMITEADAS** traen la anotación pegada al nombre, y una máquina
// que todavía no actualizó el skill los sigue escribiendo así. El recorte es la tolerancia del
// LECTOR mientras ese histórico exista; retirarlo hoy volvería a marcar como ausentes a revisores
// que sí corrieron (medido: AG-2 pasa de 1 hallazgo a 3 — lo fija
// `scripts/tests/roster-validate-parity.test.js`).
//
// Se retira cuando no queden corridas vivas con el formato viejo. Lo que NO se hace es sumar una
// regex por cada adorno nuevo: ése es el camino que la 7.13 vino a cerrar.
//
// El paréntesis final es una anotación, nunca parte del id de un agente (son kebab-case, sin
// paréntesis). Se recorta sólo al final, así que no puede fusionar dos agentes distintos.
function nombreCanonico(nombre) {
  return String(nombre || '').replace(/\s*\([^()]*\)\s*$/, '').trim();
}

function validarRoster(roster, advisores) {
  const problemas = [];
  const add = (regla, detalle) => problemas.push({ regla, detalle });
  if (!roster || typeof roster !== 'object') {
    add('registro-de-autoria-invalido', 'no es un objeto JSON');
    return { ok: false, problemas };
  }
  if (roster.version !== 1) add('registro-de-autoria-invalido', `version ${JSON.stringify(roster.version)} desconocida`);
  const impl = roster.implementer;
  if (!impl || typeof impl !== 'object' || !impl.kind) add('registro-de-autoria-invalido', 'falta el bloque implementer');
  const revs = Array.isArray(roster.reviewers) ? roster.reviewers : null;
  if (!revs) {
    add('registro-de-autoria-invalido', 'reviewers no es una lista');
  } else if (!revs.length) {
    add('sin-revisores', 'no lista ningún revisor');
  } else {
    for (const r of revs) {
      if (!r || typeof r.agent !== 'string' || !r.agent) { add('registro-de-autoria-invalido', 'hay un revisor sin nombre'); continue; }
      if (r.kind === 'sesion-principal' || (impl && impl.session_id && r.session_id === impl.session_id && r.kind !== 'subagente')) {
        add('revisor-es-el-autor', `"${r.agent}" figura como revisor pero es la sesión que implementó`);
      }
    }
  }
  if (advisores && revs) {
    // ── Tramo contra tramo (story 7.13) ────────────────────────────────────────────────────────
    // El roster cubre la RONDA DEL PASO 5 (arranca en el último `step5-start`) y `findings.json`
    // cubre toda la corrida. Un hallazgo del paso 1 —la validación de la story, antes de
    // implementar— caía siempre como "revisor ausente": fue el quinto hallazgo de ese pull request, el
    // único que parecía real. Y la ventana del roster NO se puede ensanchar, porque ahí adentro
    // está `general-purpose`, que implementa. Por eso el roster lista aparte los agentes de los
    // pasos previos y cada hallazgo dice de qué tramo viene.
    const nombresDe = (lista) => {
      const out = new Set();
      for (const r of (Array.isArray(lista) ? lista : [])) {
        if (!r || !r.agent) continue;
        out.add(r.agent); out.add(nombreCanonico(r.agent));
      }
      return out;
    };
    const enRevision = nombresDe(revs);
    const enPrevios = nombresDe(roster.agentes_previos);
    for (const item of advisores) {
      // Texto pelado (la forma vieja, que sigue valiendo) o `{advisor, tramo}` (lo que escribe
      // `write-findings` desde la 7.13). Sin tramo declarado se compara contra los dos.
      const a = (item && typeof item === 'object') ? item.advisor : item;
      const tramo = (item && typeof item === 'object') ? item.tramo : null;
      if (!a || typeof a !== 'string') continue;
      // Las fuentes que escribe el propio pipeline (`mech-check`, el pase adversarial) NUNCA son
      // un spawn y nunca van a estar en el roster: exigirles asiento frenaba casi toda story real
      // con hallazgos, y encima sin salida — agregarlas a mano dispara `roster-fabricado` en el
      // freno local. Deadlock cazado por el pase adversarial de esta misma pieza.
      const canon = nombreCanonico(a);
      if (FUENTES_SINTETICAS.some((re) => re.test(a) || re.test(canon))) continue;
      const listas = tramo === 'previo' ? [enPrevios]
        : tramo === 'revision' ? [enRevision]
          : [enRevision, enPrevios];
      if (!listas.some((set) => set.has(a) || set.has(canon))) {
        // 🔴 `validado` = este hallazgo traía su `tramo`, y `tramo` lo escribe `write-findings`
        // SÓLO cuando pudo leer el registro y ubicar al firmante — o sea, cuando la validación de
        // verdad ocurrió al escribirlo (story 7.13). Un hallazgo así que igual no cuadra es una
        // incoherencia REAL y puede frenar. Uno sin `tramo` es del formato viejo, nadie lo validó,
        // y sigue avisando: medido el 2026-09-22 sobre los 80 run dirs del disco, 12 marcarían por
        // el formato y volver a frenar de golpe repetiría el frenón de aquel pull request con otra excusa.
        // Se enciende solo a medida que las corridas viejas dejan de cerrarse — sin día de corte y
        // sin que nadie tenga que acordarse de cerrar una ventana de medición (que ya pasó acá).
        const p = { regla: 'roster-incoherente', detalle: tramo === 'previo'
          ? `"${a}" reportó hallazgos del tramo previo al paso 5 y no figura entre los agentes de ese tramo`
          : `"${a}" reportó hallazgos pero no figura entre los revisores` };
        if (tramo) p.validado = true;
        problemas.push(p);
      }
    }
  }
  return { ok: problemas.length === 0, problemas };
}

// ¿Este diff toca la memoria de engram? Una sola pregunta a git, y si la respuesta es que no, el
// chequeo 5 no lee NADA: cero costo y cero ruido en el 99% de los pull requests.
//
// 🔴 `--no-renames` (story 8.18, 2026-10-04): esta lista DECIDE por ruta si el chequeo corre. Sin la opción git empareja
// un borrado con un alta y lista sólo la ruta nueva: el índice (o un chunk) movido a otra carpeta no aparecía como
// tocado, y el chequeo no corría. Con la opción, un archivo movido son dos líneas —la vieja y la nueva— y la vieja se
// ve. (`mdDelDiff`, arriba, no la lleva a propósito: lista los `.md` que hay que LEER, y el de la ruta vieja ya no está.)
function tocaEngram(repo, base, staged) {
  let salida = '';
  if (staged) {
    try { salida = git(repo, ['diff', '--cached', '--name-only', '--no-renames']); }
    catch (_e) {
      try { salida = git(repo, ['diff', '--cached', '--name-only', '--no-renames', ARBOL_VACIO]); }
      catch (_e2) { return { error: 'no pude leer lo que está por commitearse (`git diff --cached`)' }; }
    }
  } else {
    try { salida = git(repo, ['diff', '--name-only', '--no-renames', `${base}...HEAD`]); }
    catch (_e) {
      try { salida = git(repo, ['diff', '--name-only', '--no-renames', base, 'HEAD']); } catch (_e2) { return { error: `no pude comparar contra \`${base}\`` }; }
    }
  }
  return { toca: salida.split('\n').some((f) => f === '.engram/manifest.json' || f.startsWith('.engram/chunks/')) };
}

// ── Chequeo 5: el índice de memoria declara sus archivos (story 1.6, 2026-09-17) ────────────────
// El criterio es el MISMO que usan el freno del commit y el aviso diario: `scripts/lib/
// manifest-engram.js`. Este control existe porque es lo único que ve los commits hechos FUERA del
// asistente —la web de Azure, otra máquina, un hook salteado—, que son justo los que el freno del
// commit no puede tocar. Misma asimetría que allá: lo que este pull request ROMPE frena; lo que ya
// venía roto, y lo que no se pudo comparar, avisan.
function revisarIndiceDeMemoria(repo, base, staged) {
  const t = tocaEngram(repo, base, staged);
  if (t.error) return { avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria: ${t.error}` }] };
  if (!t.toca) return null;                                    // el diff no lo toca: no se lee nada

  let criterio;
  try { criterio = require(path.join(__dirname, '..', 'lib', 'manifest-engram.js')); }
  catch (e) { return { avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria: falta el criterio (${e.message})` }] }; }

  // 🔴 «Lo de antes» es la BASE DE MERGE, no la punta de `--base` (2026-09-17, pase adversarial).
  // `tocaEngram` y `mdDelDiff` ya usan `base...HEAD` (tres puntos = desde donde se separó la rama);
  // cruzar contra la punta de main era otra noción de «antes» en el mismo control, y frenaba pull
  // requests que no rompieron nada: alcanzaba con que main reparara el índice DESPUÉS del fork para
  // que sus entradas nuevas aparecieran como «perdidas» en una rama que nunca las tuvo. Reproducido
  // sobre la historia real de este repo (rama abierta antes de 0950f4f: 5 «perdidas» falsas).
  let referencia = staged ? 'HEAD' : base;
  if (!staged) {
    // 🔴 Si la base de merge no se puede calcular (clon shallow, historias sin ancestro común) NO se
    // cae en silencio a la punta: eso reabría el mismo bug que se acaba de cerrar, con un aviso
    // que ningún código emitía (cazador de fallos silenciosos, vuelta 2). Se dice y no se frena.
    try { referencia = git(repo, ['merge-base', base, 'HEAD']).trim(); }
    catch (e) {
      const motivo = String((e && e.stderr) || (e && e.message) || e).trim().split('\n')[0];
      return { avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria: sin base de merge entre \`${base}\` y HEAD (${motivo})` }] };
    }
    if (!referencia) return { avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria: \`git merge-base ${base} HEAD\` no devolvió nada` }] };
  }
  const r = criterio.cruzar(repo, { arbol: staged ? '' : 'HEAD', contra: referencia });
  if (r.estado === 'no-medido') {
    return { engram: r, avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria: ${r.motivo}` }] };
  }
  if (!r.contra.legible) {
    // Nunca se frena un pull request por lo que no se pudo comparar — ni se lo da por bueno.
    return { engram: r, avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria contra \`${r.contra.ref}\`: ${r.contra.motivo}` }] };
  }
  const arreglo = 'node scripts/lib/manifest-engram.js repair --apply';
  if (r.huerfanosNuevos.length) {
    const detalle = [];
    if (r.perdidas.length) detalle.push(`entradas que \`${r.contra.ref}\` declara y este cambio ya no: ${r.perdidas.join(', ')}`);
    if (r.chunksSinEntrada.length) detalle.push(`archivos de memoria nuevos sin entrada: ${r.chunksSinEntrada.join(', ')}`);
    return {
      engram: r,
      hallazgos: [{
        archivo: '.engram/manifest.json',
        regla: 'indice-de-memoria-perdio-entradas',
        mensaje: `${detalle.join(' · ')}. Esa memoria queda en el repo y ninguna otra máquina la importa — y no da error. Reparación: \`${arreglo}\`.`,
      }],
    };
  }
  if (r.estado === 'deriva') {
    const detalle = [];
    if (r.huerfanosHeredados.length) detalle.push(`archivos sin entrada (de antes): ${r.huerfanosHeredados.join(', ')}`);
    if (r.fantasmas.length) detalle.push(`entradas cuyo archivo no está: ${r.fantasmas.join(', ')}`);
    if (r.duplicados.length) detalle.push(`entradas repetidas: ${r.duplicados.join(', ')}`);
    return { engram: r, avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-en-deriva', mensaje: `${detalle.join(' · ')}. Este cambio no lo empeora. Reparación: \`${arreglo}\`.` }] };
  }
  return { engram: r };
}

function revisar({ repo, base, staged }) {
  const hallazgos = [];
  const avisos = [];
  const revisadas = [];
  const { files, error } = mdDelDiff(repo, base, staged);
  if (error) return { error, hallazgos, revisadas };

  // Qué es "lo nuevo" y qué es "lo de antes" depende de dónde corre el portón. En el servidor lo
  // nuevo ya es un commit (HEAD) y lo de antes es la rama destino del pull request. En el
  // pre-commit lo nuevo todavía está en el índice y lo de antes es el último commit. El criterio
  // —qué frena y qué no— es EL MISMO: lo único que cambia es contra qué se compara.
  const refNuevo = staged ? '' : 'HEAD';
  const refViejo = staged ? 'HEAD' : base;

  for (const rel of files) {
    const nuevo = contenidoEn(repo, refNuevo, rel);
    if (nuevo === null) continue;                       // borrado en este diff
    const fmNuevo = frontmatter(nuevo);
    // La identidad de una story es `story:`, en todo el arnés (`declaresStoryIdentity`, 2026-08-23). El portón leía
    // también `storyId:`, y era el único: una story así tenía controles acá y no en el pipeline (story 1.17.1, tanda 2).
    const idBruto = fmNuevo && escalar(fmNuevo, 'story');

    // (1) frontmatter que no cierra en un archivo que DECLARA ser una story: silencio, no error.
    if (fmNuevo === null && declaraSerStory(nuevo, rel)) {
      hallazgos.push({ archivo: rel, regla: 'frontmatter-roto',
        mensaje: 'declara `story:` y su frontmatter NO cierra con `---`. Las tools del arnés no dan error con esto: saltean la story en silencio, y desaparece del validator, del backfill y de los gates.' });
      continue;
    }
    if (!idBruto) {                                     // no es una story
      // …pero si se parece a una en review/done, se dice: que nadie crea que pasó por los controles. Sólo se mira si
      // la clave ESTÁ, nunca se toma su valor como número de story. Tres caminos al silencio, los tres cerrados (pase
      // adversarial de la tanda 2): pasar a review/done; renombrar `story:` a `storyId:` sin tocar el estado —la story
      // dejaba de estar bajo control y nadie se enteraba—; y un frontmatter roto, que no deja leer nada.
      const cabeza = fmNuevo !== null ? fmNuevo : (nuevo.startsWith('---') ? nuevo.split('\n').slice(0, 60).join('\n') : null);
      const est = cabeza ? String(escalar(cabeza, 'status') || '').toLowerCase() : '';
      if (cabeza && /^storyId:\s*\S/m.test(cabeza) && LISTOS.has(est)) {
        const v = contenidoEn(repo, refViejo, rel);
        const fv = v === null ? null : frontmatter(v);
        const estViejo = fv ? String(escalar(fv, 'status') || '').toLowerCase() : '';
        const eraStory = !!(fv && escalar(fv, 'story'));
        if (fmNuevo === null || eraStory || estViejo !== est) {
          const como = fmNuevo === null ? `está en \`${est}\`, su frontmatter NO cierra con \`---\``
            : eraStory ? `está en \`${est}\` y su \`story:\` pasó a llamarse \`storyId:\``
            : `pasa a \`${est}\``;
          avisos.push({ archivo: rel, regla: 'storyid-sin-story',
            mensaje: `${como} y declara \`storyId:\` y no \`story:\`: para el arnés no es una story, así que el portón no le revisó evidencia ni revisores. Si es una story, la clave es \`story:\`.` });
        }
      }
      continue;
    }
    const estadoNuevo = String(escalar(fmNuevo, 'status') || '').toLowerCase();
    if (!LISTOS.has(estadoNuevo)) continue;

    const viejo = contenidoEn(repo, refViejo, rel);
    const fmViejo = viejo === null ? null : frontmatter(viejo);
    const estadoViejo = fmViejo ? String(escalar(fmViejo, 'status') || '').toLowerCase() : '';
    if (estadoViejo === estadoNuevo) continue;          // ya estaba así: no es una transición

    revisadas.push({ archivo: rel, story: idBruto, de: estadoViejo || '(nueva)', a: estadoNuevo });

    // 🔴 `review → done` en el pre-commit AVISA, no frena (revisión adversarial 2026-09-06, hallazgo
    // #18): la decisión del dev —REVIEW-A-DONE-SIN-FRENO-1, «avisando dos semanas, se mide, y recién
    // ahí frena»— vivía sólo en el hook del skill; esta copia, corrida por git en `--staged`, frenaba
    // la misma transición diez segundos después del aviso, así que el aviso era inerte y la medición
    // nunca se acumulaba. Misma llave que el skill: TYCON_REVIEW_A_DONE=block. En el pull request
    // (sin `--staged`) no cambia nada: ahí frena desde el 2026-09-04.
    const soloAviso = staged && estadoViejo === 'review' && estadoNuevo === 'done'
      && !llaveFrena(process.env.TYCON_REVIEW_A_DONE);
    const destino = soloAviso ? avisos : hallazgos;

    // La clave de la story, UNA vez: la usan la evidencia de cierre y la constancia de revisores (story 1.17.1).
    // Perezosa: sólo se recorre el repo si alguna de las dos reglas la necesita.
    let prefStory;
    const prefijoDeLaStory = () => (prefStory !== undefined ? prefStory : (prefStory = prefijoDeEvidencia(idBruto, path.join(repo, rel))));

    // (2) evidencia de cierre en el repo
    const exentaDod = /^dod_runtime_exempt:\s*true\b/m.test(fmNuevo);
    if (!exentaDod && !hayEvidencia(repo, 'dod-runtime', idBruto, path.join(repo, rel), prefijoDeLaStory())) {
      // Igual que la constancia de revisores (abajo): sin clave el portón no miró, y la salida no es declarar una
      // exención — que taparía un número repetido — sino arreglar lo que impide calcularla (pase de fallos
      // silenciosos, 1.17.1).
      const prefDod = prefijoDeLaStory();
      destino.push({ archivo: rel, story: idBruto, regla: 'sin-evidencia-de-cierre',
        mensaje: !prefDod
          ? `pasa a \`${estadoNuevo}\` y no pude calcular la clave de la story ${idBruto} (${rel}) para buscar su evidencia de cierre: sin clave no se da evidencia por buena (el motivo está en el aviso del portón). No es «no hay evidencia»: es «no la pude buscar» — no lo tapes con \`dod_runtime_exempt\`.`
          : `pasa a \`${estadoNuevo}\` y no hay \`.advisors/dod-runtime/${prefDod}*.md\` en el repo. Si de verdad no hay nada que verificar corriendo la app, declaralo: \`dod_runtime_exempt: true\` + su razón.` });
    }

    // (3) constancia de que los revisores auditaron la story, EN ESTE repo
    const exentaAdv = /^advisors_exempt:\s*true\b/m.test(fmNuevo);
    if (estadoNuevo === 'done' && !exentaAdv && !hayEvidencia(repo, 'pipeline-runs', idBruto, path.join(repo, rel), prefijoDeLaStory())) {
      const pref = prefijoDeLaStory();
      // Sin clave el portón NO miró (falla cerrado): el hallazgo lo dice, no sólo el aviso por stderr (pase de fallos
      // silenciosos, 1.17.1). «No pude verificar» y «no hay constancia» piden cosas distintas al dev.
      destino.push({ archivo: rel, story: idBruto, regla: 'sin-constancia-de-revisores',
        mensaje: !pref
          ? `pasa a \`done\` y no pude calcular la clave de la story ${idBruto} (${rel}) para buscar su carpeta de revisores: sin clave no se da constancia por buena (el motivo está en el aviso del portón). No es «no hay constancia»: es «no la pude buscar».`
          : `pasa a \`done\` y no hay \`.advisors/pipeline-runs/${pref}*/\` en el repo${pref !== `${idBruto}-` ? ` (el número ${idBruto} se repite en el repo: la carpeta lleva la clave de esta story; las \`${idBruto}-*\` viejas no dicen de cuál son y no cuentan)` : ''}. Escape del dev: \`advisors_exempt: true\` + su razón. (Caso: incident-log#done-sin-advisors-S1-2026-08-24.)` });
    }

    // (4) el que escribió el código no puede ser el que lo revisó — y tiene que estar ESCRITO
    //
    // 🔴 `roster-incoherente` AVISA, no frena (decisión del dev, 2026-09-22). Las otras tres reglas
    // del registro —que exista, que se pueda leer, que el autor no figure como revisor— se ganaron
    // el lugar y siguen frenando. Ésta no: en sus dos apariciones lo que falló fue ELLA, no lo que
    // vigila. En agosto frenaba casi toda story real porque las fuentes que escribe el propio
    // pipeline (`mech-check`, `adversarial-verify:*`) no son spawns y nunca están en el roster
    // (incident-log, pase adversarial de la pieza); el 2026-09-22 volvió a pasar con otros nombres
    // —la vuelta o el modelo pegados al nombre del revisor— y frenó un pull request de un producto del equipo con 5
    // hallazgos de los que 4 eran suyos. Cero atrapadas reales antes de eso.
    //
    // El motivo de bajarla y no borrarla: un control cuyas únicas fallas son propias, y que cuesta
    // mañanas, termina apagado ENTERO con un `advisors_exempt: true` — y ahí se pierden también
    // las tres que sí sirven. Como aviso sigue diciendo lo que ve y se puede contar.
    //
    // Vuelve a frenar con TYCON_ROSTER_NAMES=block, y la story 7.13 la deja casi imposible de
    // fallar (el firmante de un hallazgo se ELIGE de los revisores que corrieron, no se tipea):
    // cuando eso esté, se revisa si vuelve a frenar o si directamente sobra.
    if (estadoNuevo === 'done' && !exentaAdv) {
      // 🔴 Desde la 7.13 el canal lo decide el PROPIO hallazgo, no la regla entera: uno que traía
      // su `tramo` fue validado al escribirse contra el registro de esa corrida, así que si igual
      // no cuadra es una incoherencia REAL y frena. Uno sin `tramo` es del formato viejo —nadie lo
      // validó— y sigue avisando. Vuelve a frenar sola a medida que las corridas viejas dejan de
      // cerrarse, sin día de corte y sin depender de que alguien cierre una ventana de medición.
      // Medido el 2026-09-22: de 80 corridas en disco, 12 marcarían por el formato viejo.
      const nombresFrenan = llaveFrena(readEnv('TYCON_ROSTER_NAMES', { where: WHERE }));
      for (const h of revisarAutoria(repo, idBruto, path.join(repo, rel))) {
        const esAviso = h.regla === 'roster-incoherente' && !nombresFrenan && !h.validado;
        (esAviso ? avisos : destino).push({ archivo: rel, story: idBruto, ...h });
      }
    }
  }
  // (5) el índice de memoria de engram — a nivel REPO, no por archivo `.md`
  const mem = revisarIndiceDeMemoria(repo, base, staged);
  if (mem) {
    for (const h of (mem.hallazgos || [])) hallazgos.push(h);
    for (const a of (mem.avisos || [])) avisos.push(a);
  }

  return { hallazgos, avisos, revisadas, archivos: files.length, ...(mem && mem.engram ? { engram: mem.engram } : {}) };
}

// ── selftest ────────────────────────────────────────────────────────────────────────────────────
function selftest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-'));
  const sh = (...a) => execFileSync('git', ['-C', tmp, ...a], { stdio: 'ignore' });
  fs.mkdirSync(path.join(tmp, 'specs', 'stories'), { recursive: true });
  const story = (estado, extra = '') => `---\nstory: "1.1"\nepic: "1"\nstatus: ${estado}\n${extra}---\n# Story 1.1\n`;
  fs.writeFileSync(path.join(tmp, 'specs', 'stories', '1-1.md'), story('in-progress'));
  sh('init', '-q', '-b', 'main', '.'); sh('add', '-A');
  sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
  const base = git(tmp, ['rev-parse', 'HEAD']).trim();

  const conStory = (txt) => { fs.writeFileSync(path.join(tmp, 'specs', 'stories', '1-1.md'), txt); sh('add', '-A'); sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'x'); };

  conStory(story('done'));
  const sinNada = revisar({ repo: tmp, base });

  // 🔴 Lo que NO es evidencia de cierre aunque lleve el prefijo (2026-09-05): la matriz por AC,
  // el self-audit y el plan manual. Rojo previo: con estos archivos el portón daba VERDE — una
  // copia parcial de la evidencia de otro repo lo satisfacía.
  fs.mkdirSync(path.join(tmp, '.advisors', 'dod-runtime'), { recursive: true });
  for (const f of ['1.1-runtime-matrix.md', '1.1-self-audit-iter1.md', '1.1-manual-test-plan.md']) {
    fs.writeFileSync(path.join(tmp, '.advisors', 'dod-runtime', f), 'no es evidencia');
  }
  const soloMatriz = revisar({ repo: tmp, base });
  // 🔴 …pero el ledger de smokes SÍ (decisión del dev, 2026-09-06): es el registro crudo de cada
  // prueba que corrió, escrito por la máquina. Hasta ese día este mismo caso lo ponía junto a la
  // matriz como «no evidencia»; la decisión lo dio vuelta y la definición única cambió en las
  // cuatro capas a la vez.
  fs.writeFileSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-smoke-ledger.jsonl'), '{"story":"1.1","acs":[1],"exit":0}\n');
  const conLedger = revisar({ repo: tmp, base });
  fs.rmSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-smoke-ledger.jsonl'));
  // …y el gate E2E del proyecto (lo que un producto del equipo commiteó a mano) sí lo es.
  fs.writeFileSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-e2e-gate-20260905T120000Z.md'), 'verdict=PASS');
  const conGate = revisar({ repo: tmp, base });
  fs.rmSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-e2e-gate-20260905T120000Z.md'));
  // …y el smoke driven de UI (`<id>-ui-smoke-<ts>.md`) y el del macro (`<id>-<ts>.md`) también.
  fs.writeFileSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-ui-smoke-20260905T120000Z.md'), 'AC→assertion');
  const conUiSmoke = revisar({ repo: tmp, base });
  fs.rmSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-ui-smoke-20260905T120000Z.md'));

  fs.writeFileSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-20260825.md'), 'evidencia');
  const soloDod = revisar({ repo: tmp, base });

  fs.mkdirSync(path.join(tmp, '.advisors', 'pipeline-runs', '1.1-20260825'), { recursive: true });
  const completo = revisar({ repo: tmp, base });

  conStory(story('done', 'dod_runtime_exempt: true\nadvisors_exempt: true\n'));
  fs.rmSync(path.join(tmp, '.advisors'), { recursive: true, force: true });
  const exenta = revisar({ repo: tmp, base });

  conStory('---\nstory: "1.1"\nstatus: done\n# falta el cierre\n');
  const roto = revisar({ repo: tmp, base });

  conStory(story('in-progress'));
  const sinTransicion = revisar({ repo: tmp, base });

  // 🔴 El falso positivo que dio la PRIMERA versión de este portón, con su detector propio: un
  // reporte de medición SIN frontmatter que menciona `story:` en el cuerpo. No es una story y no
  // se puede tratar como una story rota. Se caza con el detector del lint local, que ya había
  // pagado esta lección (2026-08-23: 331 de 1608 `.md` de un repo del equipo rechazados por el criterio viejo).
  fs.mkdirSync(path.join(tmp, 'mediciones'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'mediciones', 'resultado.md'),
    '# Qué reglas implementa el proceso\n\nmide: cadena\nstory: 4.37\nmaterial: filas.json\n');
  sh('add', '-A'); sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'medicion');
  const medicion = revisar({ repo: tmp, base });

  // ── Regla 4: registro de autoría ────────────────────────────────────────────────────────────
  conStory(story('done', 'dod_runtime_exempt: true\n'));
  const runPost = path.join(tmp, '.advisors', 'pipeline-runs', '1.1-20260901120000');
  fs.mkdirSync(runPost, { recursive: true });
  // (a) run POSTERIOR al corte y sin roster → frena
  const postSinRoster = revisar({ repo: tmp, base });
  const rosterOk = {
    version: 1, story: '1.1', implementer: { kind: 'sesion-principal', session_id: 's1' },
    reviewers: [{ agent: 'tycon-plugin-security-basics', kind: 'subagente', model: 'opus' }], iterations: 1,
  };
  // (b) con roster válido → limpio
  fs.writeFileSync(path.join(runPost, 'review-roster.json'), JSON.stringify(rosterOk));
  const postConRoster = revisar({ repo: tmp, base });
  // (c) el que implementó figura como revisor → frena (aunque el run sea viejo)
  fs.writeFileSync(path.join(runPost, 'review-roster.json'), JSON.stringify({
    ...rosterOk, reviewers: [{ agent: 'yo-mismo', kind: 'sesion-principal' }],
  }));
  const autoRevision = revisar({ repo: tmp, base });
  // (d) findings nombra un advisor que el roster no lista → incoherente
  fs.writeFileSync(path.join(runPost, 'review-roster.json'), JSON.stringify(rosterOk));
  fs.writeFileSync(path.join(runPost, 'findings.json'), JSON.stringify([{ advisor: 'fantasma', rule_id: 'X-1' }]));
  const incoherente = revisar({ repo: tmp, base });
  // (d1) la misma entrada con la llave puesta: la regla vuelve a frenar (el kill-switch se prueba,
  // no se confía — un interruptor que nadie ejerce es un interruptor que no se sabe si anda).
  const incoherenteFreno = (() => {
    // Se guardan y se restauran los DOS nombres ([nuevo, viejo] del mapa): mientras dura la prueba sólo queda el nuevo
    // (un viejo distinto no la estorba), y al salir cada uno vuelve a lo que era — el viejo nunca queda pisando al nuevo.
    const nombres = envNames('TYCON_ROSTER_NAMES');
    const antes = nombres.map((k) => process.env[k]);
    for (const k of nombres) delete process.env[k];
    process.env.TYCON_ROSTER_NAMES = 'block';
    try { return revisar({ repo: tmp, base }); }
    finally { nombres.forEach((k, i) => { if (antes[i] === undefined) delete process.env[k]; else process.env[k] = antes[i]; }); }
  })();
  // (d1b) el MISMO hallazgo, pero escrito por `write-findings` con su `tramo` (story 7.13): eso
  // quiere decir que el firmante se validó contra el registro al escribirlo, así que la
  // incoherencia es REAL y frena sin necesidad de la llave. Es cómo la regla vuelve sola a frenar
  // a medida que las corridas del formato viejo dejan de cerrarse.
  fs.writeFileSync(path.join(runPost, 'findings.json'), JSON.stringify([{ advisor: 'fantasma', rule_id: 'X-1', tramo: 'revision' }]));
  const incoherenteValidado = revisar({ repo: tmp, base });
  // (d2) las fuentes del propio pipeline no son revisores y NO pueden frenar
  fs.writeFileSync(path.join(runPost, 'findings.json'), JSON.stringify([
    { advisor: 'mech-check', rule_id: 'MECH-2' },
    { advisor: 'adversarial-verify:algorithmic-correctness', rule_id: 'ADV-1' },
    { advisor: 'tycon-plugin-security-basics', rule_id: 'SEC-C1' },
  ]));
  const sinteticas = revisar({ repo: tmp, base });
  // (e) roster ilegible → frena siempre
  fs.rmSync(path.join(runPost, 'findings.json'));
  fs.writeFileSync(path.join(runPost, 'review-roster.json'), '{ esto no es json');
  const ilegible = revisar({ repo: tmp, base });
  // (f) run ANTERIOR al corte y sin roster → no se le puede reclamar
  fs.rmSync(runPost, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, '.advisors', 'pipeline-runs', '1.1-20260825120000'), { recursive: true });
  const preCutoff = revisar({ repo: tmp, base });
  // (g) la OTRA forma real del nombre (`-YYYYMMDD-HHMM`): también es una fecha, y también es vieja.
  // Leerla mal dejaba el run "sin fecha" y lo frenaba — regresión que cazó el banco de controles.
  fs.rmSync(path.join(tmp, '.advisors', 'pipeline-runs', '1.1-20260825120000'), { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, '.advisors', 'pipeline-runs', '1.1-20260824-1200'), { recursive: true });
  const preCutoffConHora = revisar({ repo: tmp, base });
  // (h) un nombre SIN fecha (otra convención de repo) tampoco se reclama
  fs.rmSync(path.join(tmp, '.advisors', 'pipeline-runs', '1.1-20260824-1200'), { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, '.advisors', 'pipeline-runs', '1.1-corrida-manual'), { recursive: true });
  const sinFecha = revisar({ repo: tmp, base });

  // ── Modo `--staged`: el MISMO control, antes de que el commit exista (2026-09-04) ───────────
  // Caso disparador: el repo de specs de un producto del equipo. Una story del Epic 8 entró declarándose
  // `review` con su código sin pushear, y el rojo apareció recién en el servidor. El freno local
  // que cubre exactamente ese caso vive en un hook de Claude Code: un commit hecho desde la
  // terminal, desde el botón de VS Code o desde la web se lo saltea SIN ENTERARSE. Medido contra
  // el índice, en cambio, lo corre git — que corre siempre, use quien use la herramienta que use.
  fs.rmSync(path.join(tmp, '.advisors'), { recursive: true, force: true });
  conStory(story('in-progress'));                        // punto de partida, ya commiteado
  fs.writeFileSync(path.join(tmp, 'specs', 'stories', '1-1.md'), story('review'));
  sh('add', '-A');                                       // en el índice, SIN commitear
  const stagedSinEvidencia = revisar({ repo: tmp, staged: true });

  fs.mkdirSync(path.join(tmp, '.advisors', 'dod-runtime'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-20260904.md'), 'evidencia');
  const stagedConEvidencia = revisar({ repo: tmp, staged: true });

  // 🔴 Lo que YA está commiteado no se vuelve a reclamar. Sin esto, cada commit posterior del repo
  // frenaría por una story cerrada hace semanas — y un freno que muerde sin motivo se apaga en una
  // semana. El índice es lo que está por entrar, nada más.
  sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'review + evidencia');
  fs.rmSync(path.join(tmp, '.advisors'), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'otro.md'), '# nada que ver\n');
  sh('add', '-A');
  const stagedOtraCosa = revisar({ repo: tmp, staged: true });

  // 🔴 `review → done` en `--staged` AVISA y no frena (2026-09-06, hallazgo #18): la decisión del dev
  // tiene que vivir en las dos copias, o el aviso del skill es inerte. Con la llave, frena.
  sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'otra cosa');
  conStory(story('in-progress'));
  conStory(story('review'));                            // HEAD = review, commiteado
  fs.rmSync(path.join(tmp, '.advisors'), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'specs', 'stories', '1-1.md'), story('done'));
  sh('add', '-A');
  const stagedInterna = revisar({ repo: tmp, staged: true });
  const llaveVieja = process.env.TYCON_REVIEW_A_DONE;
  process.env.TYCON_REVIEW_A_DONE = 'block';
  const stagedInternaFreno = revisar({ repo: tmp, staged: true });
  if (llaveVieja === undefined) delete process.env.TYCON_REVIEW_A_DONE; else process.env.TYCON_REVIEW_A_DONE = llaveVieja;
  const ciInterna = revisar({ repo: tmp, base });        // en el pull request sigue frenando
  let cliInterna = -1;
  try { execFileSync(process.execPath, [__filename, '--repo', tmp, '--staged'], { stdio: 'ignore' }); cliInterna = 0; }
  catch (e) { cliInterna = e.status; }

  // (j) el CLI en modo `--staged` tiene que SALIR 1: es lo único que git mira para frenar el
  // commit. Mismo aprendizaje que (i) — que el motor lo detecte no sirve de nada si el proceso
  // sale 0.
  //
  // 🔴 El estado se prepara con HEAD IGUAL a la base para esta story, a propósito: así el modo
  // viejo (comparar contra una rama) no ve absolutamente nada, y el 1 sólo puede venir de haber
  // mirado el índice. La primera versión de este caso no lo hacía y salía verde CON LA
  // FUNCIONALIDAD DESACTIVADA — o sea, no probaba nada. Por eso va con su control al lado.
  conStory(story('in-progress'));
  fs.rmSync(path.join(tmp, '.advisors'), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'specs', 'stories', '1-1.md'), story('done'));
  sh('add', '-A');
  // No alcanza con mirar el código de salida: con la bandera sin cablear, el portón cae en
  // "no pude comparar contra `origin/main`" y sale 1 igual — el 1 correcto por el motivo
  // equivocado. Así que se le pide la salida y se exige que nombre la regla.
  let cliStaged = { code: 0, out: '' };
  try {
    cliStaged.out = execFileSync(process.execPath, [__filename, '--repo', tmp, '--staged', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { cliStaged = { code: e.status, out: String(e.stdout || '') }; }
  let cliSinStaged = -1;
  try {
    execFileSync(process.execPath, [__filename, '--repo', tmp, '--base', base], { stdio: 'ignore' });
    cliSinStaged = 0;
  } catch (e) { cliSinStaged = e.status; }

  // (i) 🔴 EL CLI DE VERDAD, no sólo el motor (2026-08-31, revisión a ciegas).
  // Todo lo de arriba llama a revisar() y mira su salida. El bug que se escapó vivía en main():
  // un atajo salía 0 cuando no había stories en transición, TIRANDO los hallazgos — y el
  // frontmatter roto es justamente un hallazgo SIN transición. El motor decía "lo encontré" y el
  // proceso salía 0. Un control se verifica por lo que el CI recibe: el código de salida.
  conStory('---\nstory: "1.1"\nstatus: done\n# falta el cierre\n');
  let cliSalida = 0;
  try {
    execFileSync(process.execPath, [__filename, '--repo', tmp, '--base', base], { stdio: 'ignore' });
  } catch (e) { cliSalida = e.status; }

  // ── Chequeo 5: el índice de memoria (story 1.6) ───────────────────────────────────────────────
  // Este control es lo ÚNICO que ve los commits hechos fuera del asistente (la web de Azure, otra
  // máquina, un hook salteado): el freno del commit no los toca. Mismo criterio que el hook, misma
  // asimetría — lo que el pull request ROMPE frena; lo que ya venía roto avisa.
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-engram-'));
  const sh2 = (...a) => execFileSync('git', ['-C', tmp2, ...a], { stdio: 'ignore' });
  const commit2 = (m) => { sh2('add', '-A'); sh2('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', m); };
  const entrada = (id, mes) => ({ id, created_by: 't', created_at: `2026-${String(mes).padStart(2, '0')}-01T00:00:00Z`, sessions: 0, memories: 1, prompts: 0 });
  const escribirIndice = (ids) => fs.writeFileSync(path.join(tmp2, '.engram', 'manifest.json'),
    JSON.stringify({ version: 1, chunks: ids.map((id, i) => entrada(id, i + 1)) }, null, 2));
  const escribirChunk = (id) => fs.writeFileSync(path.join(tmp2, '.engram', 'chunks', `${id}.jsonl.gz`), zlib.gzipSync('{}\n'));

  fs.mkdirSync(path.join(tmp2, '.engram', 'chunks'), { recursive: true });
  sh2('init', '-q', '-b', 'main', '.');
  for (const id of ['aaaa1111', 'bbbb2222', 'cccc3333']) escribirChunk(id);
  escribirIndice(['aaaa1111', 'bbbb2222', 'cccc3333']);
  commit2('base sana: 3 de 3');
  const baseEngram = git(tmp2, ['rev-parse', 'HEAD']).trim();

  escribirIndice(['aaaa1111', 'bbbb2222']);          // el índice pierde una entrada
  commit2('el índice truncado entra al pull request');
  const prQuePierde = revisar({ repo: tmp2, base: baseEngram });

  // Heredado: la base YA venía en deriva y el pull request no empeora nada (toca otra cosa de
  // `.engram/`, así que el chequeo igual mira).
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-engram2-'));
  const sh3 = (...a) => execFileSync('git', ['-C', tmp3, ...a], { stdio: 'ignore' });
  fs.mkdirSync(path.join(tmp3, '.engram', 'chunks'), { recursive: true });
  sh3('init', '-q', '-b', 'main', '.');
  for (const id of ['aaaa1111', 'bbbb2222', 'cccc3333']) fs.writeFileSync(path.join(tmp3, '.engram', 'chunks', `${id}.jsonl.gz`), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp3, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1), entrada('bbbb2222', 2)] }, null, 2));
  sh3('add', '-A'); sh3('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'nace en deriva');
  const baseHeredada = git(tmp3, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(tmp3, '.engram', 'chunks', 'dddd4444.jsonl.gz'), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp3, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1), entrada('bbbb2222', 2), entrada('dddd4444', 4)] }, null, 2));
  sh3('add', '-A'); sh3('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'agrega uno bien declarado');
  const prHeredado = revisar({ repo: tmp3, base: baseHeredada });

  // Un diff que NO toca `.engram/`: el chequeo no lee nada (cero costo, cero ruido).
  fs.writeFileSync(path.join(tmp3, 'otra-cosa.txt'), 'x');
  sh3('add', '-A'); sh3('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'nada que ver');
  const baseSinEngram = git(tmp3, ['rev-parse', 'HEAD~1']).trim();
  const prSinEngram = revisar({ repo: tmp3, base: git(tmp3, ['rev-parse', 'HEAD~1']).trim() });

  // `--staged`: el mismo criterio antes de que el commit exista.
  escribirIndice(['aaaa1111']);                       // pierde otra más, sin commitear
  sh2('add', '-A');
  const stagedQuePierde = revisar({ repo: tmp2, staged: true });

  // La referencia vieja ilegible: avisa, no frena. Nunca se rechaza un pull request por lo que no
  // se pudo comparar, y nunca se lo da por bueno por eso mismo.
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-engram3-'));
  const sh4 = (...a) => execFileSync('git', ['-C', tmp4, ...a], { stdio: 'ignore' });
  fs.mkdirSync(path.join(tmp4, '.engram', 'chunks'), { recursive: true });
  sh4('init', '-q', '-b', 'main', '.');
  fs.writeFileSync(path.join(tmp4, '.engram', 'chunks', 'aaaa1111.jsonl.gz'), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp4, '.engram', 'manifest.json'), '{"version":1,"chunks":[');   // roto
  sh4('add', '-A'); sh4('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base con el índice roto');
  const baseIlegible = git(tmp4, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(tmp4, '.engram', 'chunks', 'bbbb2222.jsonl.gz'), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp4, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1)] }, null, 2));
  sh4('add', '-A'); sh4('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'ahora el índice parsea');
  const prBaseIlegible = revisar({ repo: tmp4, base: baseIlegible });

  // 🔴 Base de merge, no punta de main (pase adversarial 2026-09-17): main repara el índice DESPUÉS
  // del fork; la rama, abierta antes, ni tocó esos ids. Contra la punta salían como «perdidas».
  const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-engram4-'));
  const sh5 = (...a) => execFileSync('git', ['-C', tmp5, ...a], { stdio: 'ignore' });
  const commit5 = (m) => { sh5('add', '-A'); sh5('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', m); };
  fs.mkdirSync(path.join(tmp5, '.engram', 'chunks'), { recursive: true });
  sh5('init', '-q', '-b', 'main', '.');
  for (const id of ['aaaa1111', 'bbbb2222']) fs.writeFileSync(path.join(tmp5, '.engram', 'chunks', `${id}.jsonl.gz`), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp5, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1)] }, null, 2));  // bbbb2222 huérfano heredado
  commit5('fork: 2 archivos, 1 entrada');
  sh5('checkout', '-q', '-b', 'rama');
  fs.writeFileSync(path.join(tmp5, '.engram', 'chunks', 'cccc3333.jsonl.gz'), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp5, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1), entrada('cccc3333', 3)] }, null, 2));
  commit5('la rama agrega el suyo, bien declarado');
  sh5('checkout', '-q', 'main');
  fs.writeFileSync(path.join(tmp5, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1), entrada('bbbb2222', 2)] }, null, 2));
  commit5('main repara el huérfano después del fork');
  sh5('checkout', '-q', 'rama');
  const prContraMainReparado = revisar({ repo: tmp5, base: 'main' });
  fs.rmSync(tmp5, { recursive: true, force: true });

  // 🔴 Los avisos del chequeo 5 llegan al CLI aunque no haya stories ni hallazgos (pase adversarial):
  // el atajo «✅ ninguna story pasa a review/done» salía ANTES de imprimirlos.
  // (tmp3 todavía existe acá: se borra más abajo junto con los otros). El aviso sale por stderr y el
  // CLI termina en 0, así que se capturan las DOS salidas con spawnSync — execFileSync sólo devuelve
  // stdout cuando el código es 0.
  const cliAviso = require('child_process').spawnSync(process.execPath, [__filename, '--repo', tmp3, '--base', baseHeredada], { encoding: 'utf8' });
  const cliAvisoEngramOut = String(cliAviso.stdout || '') + String(cliAviso.stderr || '');

  // 🔴 Sin base de merge (historias sin ancestro común, clon shallow) → AVISA, no cae a la punta
  // (cazador de fallos silenciosos, vuelta 2: el fallback silencioso reabría el bug recién cerrado).
  const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-engram5-'));
  const sh6 = (...a) => execFileSync('git', ['-C', tmp6, ...a], { stdio: 'ignore' });
  fs.mkdirSync(path.join(tmp6, '.engram', 'chunks'), { recursive: true });
  sh6('init', '-q', '-b', 'main', '.');
  for (const id of ['aaaa1111', 'bbbb2222']) fs.writeFileSync(path.join(tmp6, '.engram', 'chunks', `${id}.jsonl.gz`), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp6, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1), entrada('bbbb2222', 2)] }, null, 2));
  sh6('add', '-A'); sh6('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'main: 2 de 2');
  sh6('checkout', '-q', '--orphan', 'huerfana');                       // historia SIN ancestro común
  fs.writeFileSync(path.join(tmp6, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1)] }, null, 2));
  sh6('add', '-A'); sh6('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'huérfana: 1 de 2');
  const prSinBaseComun = revisar({ repo: tmp6, base: 'main' });
  fs.rmSync(tmp6, { recursive: true, force: true });

  // 🔴 Un archivo MOVIDO fuera de `.engram/` no esquiva el chequeo (story 8.18, deuda `listas-sin-renombres`,
  // 2026-10-04). `git diff --name-only` empareja el borrado con el alta y lista sólo la ruta NUEVA: la vieja, que es
  // la que decide si el chequeo corre, no aparecía. Mover el índice (o un chunk) a otra carpeta dejaba la memoria sin
  // índice (o el índice con una entrada sin archivo) y el portón no decía nada. Dos repos: uno por el pull request,
  // otro por `--staged`.
  const memoryRepo = (prefix) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const sh = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
    fs.mkdirSync(path.join(d, '.engram', 'chunks'), { recursive: true });
    sh('init', '-q', '-b', 'main', '.');
    for (const id of ['aaaa1111', 'bbbb2222']) fs.writeFileSync(path.join(d, '.engram', 'chunks', `${id}.jsonl.gz`), zlib.gzipSync(`{"id":"${id}"}\n`));
    fs.writeFileSync(path.join(d, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1), entrada('bbbb2222', 2)] }, null, 2));
    sh('add', '-A'); sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base sana: 2 de 2');
    fs.mkdirSync(path.join(d, 'backup'));
    return { d, sh };
  };
  const tmp7 = memoryRepo('cigate-engram6-');
  const movedIndexBase = git(tmp7.d, ['rev-parse', 'HEAD']).trim();
  tmp7.sh('mv', '.engram/manifest.json', 'backup/manifest.json');
  tmp7.sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'el índice se muda de carpeta');
  const movedIndexPr = revisar({ repo: tmp7.d, base: movedIndexBase });
  const tmp8 = memoryRepo('cigate-engram7-');
  tmp8.sh('mv', '.engram/chunks/bbbb2222.jsonl.gz', 'backup/bbbb2222.jsonl.gz');   // stageado, sin commitear
  const movedChunkStaged = revisar({ repo: tmp8.d, staged: true });
  // el espejo: mover algo que no es de la memoria sigue sin leer nada del índice
  const tmp9 = memoryRepo('cigate-engram8-');
  fs.writeFileSync(path.join(tmp9.d, 'note.txt'), 'una nota cualquiera, con texto suficiente para que git la empareje\n');
  tmp9.sh('add', '-A'); tmp9.sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'una nota');
  const movedNoteBase = git(tmp9.d, ['rev-parse', 'HEAD']).trim();
  tmp9.sh('mv', 'note.txt', 'backup/note.txt');
  tmp9.sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'la nota se muda');
  const movedNotePr = revisar({ repo: tmp9.d, base: movedNoteBase });
  for (const t of [tmp7, tmp8, tmp9]) fs.rmSync(t.d, { recursive: true, force: true });

  let cliEngram = 0;
  try { execFileSync(process.execPath, [__filename, '--repo', tmp2, '--base', baseEngram], { stdio: 'ignore' }); }
  catch (e) { cliEngram = e.status; }
  // Sale 1 (hay hallazgo), así que execFileSync tira: el JSON viene igual por stdout.
  let jsonEngram = {};
  try { jsonEngram = JSON.parse(execFileSync(process.execPath, [__filename, '--repo', tmp2, '--base', baseEngram, '--json'], { encoding: 'utf8' })); }
  catch (e) { try { jsonEngram = JSON.parse(String(e.stdout || '{}')); } catch { jsonEngram = {}; } }

  for (const d of [tmp2, tmp3, tmp4]) fs.rmSync(d, { recursive: true, force: true });

  fs.rmSync(tmp, { recursive: true, force: true });
  const reglas = (r) => r.hallazgos.map((h) => h.regla).sort();
  const checks = [
    ['una story a `done` sin nada en el repo → dos hallazgos', JSON.stringify(reglas(sinNada)) === JSON.stringify(['sin-constancia-de-revisores', 'sin-evidencia-de-cierre'])],
    ['🔴 la matriz, el self-audit y el plan manual solos NO son evidencia de cierre', reglas(soloMatriz).includes('sin-evidencia-de-cierre')],
    ['🔴 el ledger de smokes solo SÍ es evidencia de cierre (decisión del dev, 2026-09-06)', !reglas(conLedger).includes('sin-evidencia-de-cierre')],
    ['el gate E2E del proyecto (`<id>-e2e-gate-*.md`) sí lo es', !reglas(conGate).includes('sin-evidencia-de-cierre')],
    ['el smoke driven de UI (`<id>-ui-smoke-*.md`) también', !reglas(conUiSmoke).includes('sin-evidencia-de-cierre')],
    ['con evidencia de cierre queda sólo el de revisores', JSON.stringify(reglas(soloDod)) === JSON.stringify(['sin-constancia-de-revisores'])],
    ['con las dos cosas, limpio', completo.hallazgos.length === 0],
    ['las exenciones declaradas del dev se respetan', exenta.hallazgos.length === 0],
    ['un frontmatter que no cierra se caza (las tools lo saltean en silencio)', reglas(roto).includes('frontmatter-roto')],
    ['una story que NO transiciona no se revisa', sinTransicion.revisadas.length === 0 && sinTransicion.hallazgos.length === 0],
    ['un reporte que menciona `story:` en el CUERPO no es una story rota', !medicion.hallazgos.some((h) => h.regla === 'frontmatter-roto')],
    ['un run posterior al corte SIN registro de autoría frena', reglas(postSinRoster).includes('sin-registro-de-autoria')],
    ['con el registro de autoría válido, limpio', postConRoster.hallazgos.length === 0],
    ['si el que implementó figura como revisor, frena', reglas(autoRevision).includes('revisor-es-el-autor')],
    // 🔴 Cambió de frenar a AVISAR el 2026-09-22 (decisión del dev): en sus dos apariciones falló
    // la regla, no lo que vigila. El caso no se borra —sigue midiendo que la ve— y el canal ahora
    // es parte de lo que se afirma. Con TYCON_ROSTER_NAMES=block vuelve a hallazgos.
    ['un advisor con hallazgos que el registro no lista, AVISA y no frena',
      (incoherente.avisos || []).some((h) => h.regla === 'roster-incoherente')
      && !reglas(incoherente).includes('roster-incoherente')],
    ['…y con TYCON_ROSTER_NAMES=block vuelve a frenar', reglas(incoherenteFreno).includes('roster-incoherente')],
    // 🔴 La regla vuelve a frenar SOLA para lo que nació validado (story 7.13), sin llave y sin
    // día de corte: el hallazgo que trae su `tramo` pasó por la validación al escribirse.
    ['un hallazgo que SÍ se validó al escribirse (trae su tramo) frena sin llave',
      reglas(incoherenteValidado).includes('roster-incoherente')
      && !(incoherenteValidado.avisos || []).some((h) => h.regla === 'roster-incoherente')],
    ['las fuentes del propio pipeline (mech-check, adversarial-verify) NO frenan', sinteticas.hallazgos.length === 0],
    ['un registro ilegible frena (dato malo es peor que dato ausente)', reglas(ilegible).includes('registro-de-autoria-invalido')],
    ['un run ANTERIOR al corte sin registro no se reclama', !reglas(preCutoff).includes('sin-registro-de-autoria')],
    ['la otra forma del nombre (-YYYYMMDD-HHMM) también se lee como fecha', !reglas(preCutoffConHora).includes('sin-registro-de-autoria')],
    ['un run dir sin fecha en el nombre no se reclama', !reglas(sinFecha).includes('sin-registro-de-autoria')],
    ['🔴 el CLI SALE 1 con un frontmatter roto (no alcanza con que el motor lo detecte)', cliSalida === 1],
    ['🔴 --staged: una story que pasa a review en el ÍNDICE se caza antes del commit', reglas(stagedSinEvidencia).includes('sin-evidencia-de-cierre')],
    ['--staged: con su evidencia en el repo, limpio', stagedConEvidencia.hallazgos.length === 0],
    ['🔴 --staged: lo YA commiteado no se vuelve a reclamar en cada commit', stagedOtraCosa.revisadas.length === 0 && stagedOtraCosa.hallazgos.length === 0],
    ['🔴 el CLI --staged SALE 1 nombrando la regla (no por no poder comparar)', cliStaged.code === 1 && /sin-evidencia-de-cierre/.test(cliStaged.out)],
    ['…y sin la bandera, el MISMO estado sale 0 (el 1 vino de mirar el índice, no de otra cosa)', cliSinStaged === 0],
    ['🔴 --staged: `review → done` sin evidencia AVISA (queda en avisos, no en hallazgos)', stagedInterna.hallazgos.length === 0 && (stagedInterna.avisos || []).some((h) => h.regla === 'sin-evidencia-de-cierre')],
    ['--staged + TYCON_REVIEW_A_DONE=block: `review → done` FRENA', reglas(stagedInternaFreno).includes('sin-evidencia-de-cierre')],
    ['en el pull request (sin --staged) `review → done` sigue frenando', reglas(ciInterna).includes('sin-evidencia-de-cierre')],
    ['el CLI --staged SALE 0 ante `review → done` (avisa, no frena)', cliInterna === 0],
    // ── chequeo 5: el índice de memoria (story 1.6) ──────────────────────────────────────────
    ['🔴 un PR que PIERDE entradas del índice de memoria frena, nombrando el id', reglas(prQuePierde).includes('indice-de-memoria-perdio-entradas')
      && prQuePierde.hallazgos.some((h) => /cccc3333/.test(h.mensaje))],
    ['la deriva HEREDADA del índice avisa y no frena (el PR no la causó)', prHeredado.hallazgos.length === 0
      && (prHeredado.avisos || []).some((h) => h.regla === 'indice-de-memoria-en-deriva')],
    ['un diff que no toca `.engram/` no lee nada del índice (cero costo, cero ruido)',
      prSinEngram.hallazgos.length === 0 && !(prSinEngram.avisos || []).some((h) => /indice-de-memoria/.test(h.regla)) && prSinEngram.engram === undefined],
    ['🔴 --staged: el mismo criterio antes de que el commit exista', reglas(stagedQuePierde).includes('indice-de-memoria-perdio-entradas')],
    ['la referencia vieja ilegible AVISA y no frena (ni lo da por bueno)', prBaseIlegible.hallazgos.length === 0
      && (prBaseIlegible.avisos || []).some((h) => h.regla === 'indice-de-memoria-no-comparable')],
    ['el CLI sale 1 y `--json` trae el bloque del chequeo 5', cliEngram === 1 && !!jsonEngram.engram && jsonEngram.engram.perdidas.includes('cccc3333')],
    ['🔴 se compara contra la BASE DE MERGE: main que repara el índice después del fork no frena a la rama', prContraMainReparado.hallazgos.length === 0],
    ['🔴 sin base de merge (historias sin ancestro común) AVISA «no pude comparar» — no cae a la punta ni frena', prSinBaseComun.hallazgos.length === 0
      && (prSinBaseComun.avisos || []).some((h) => h.regla === 'indice-de-memoria-no-comparable' && /base de merge/.test(h.mensaje))],
    ['🔴 un PR que MUEVE el índice de memoria a otra carpeta no esquiva el chequeo 5: avisa que no pudo comparar',
      (movedIndexPr.avisos || []).some((h) => h.regla === 'indice-de-memoria-no-comparable')],
    ['🔴 --staged: un chunk MOVIDO fuera de `.engram/chunks/` no esquiva el chequeo 5: la entrada sin archivo se avisa',
      (movedChunkStaged.avisos || []).some((h) => h.regla === 'indice-de-memoria-en-deriva' && /bbbb2222/.test(h.mensaje))],
    ['mover un archivo que no es de la memoria sigue sin leer nada del índice',
      movedNotePr.hallazgos.length === 0 && !(movedNotePr.avisos || []).some((h) => /indice-de-memoria/.test(h.regla)) && movedNotePr.engram === undefined],
    ['🔴 los avisos del chequeo 5 LLEGAN al CLI aunque no haya stories (el atajo ✅ no se los traga)', /indice-de-memoria/.test(cliAvisoEngramOut) && !/ninguna story pasa a review\/done/.test(cliAvisoEngramOut)],
  ];
  let bad = 0;
  for (const [n, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-ci-gate: ${n}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-ci-gate: ${checks.length}/${checks.length} verdes`);
  return bad ? 1 : 0;
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const arg = (n, def) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
  const repo = path.resolve(arg('--repo', process.cwd()));
  // `--staged` = el mismo control, corrido por git antes de que el commit exista. Ignora `--base`
  // a propósito: en un pre-commit lo de antes es siempre el último commit, no una rama remota.
  const staged = process.argv.includes('--staged');
  const base = arg('--base', process.env.TYCON_CI_BASE || 'origin/main');
  const r = revisar({ repo, base, staged });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ repo, base: staged ? 'HEAD' : base, staged, ...r }, null, 2));
    return r.error || r.hallazgos.length ? 1 : 0;
  }
  if (r.error) {
    console.error(`⚠ tycon-ci-gate: ${r.error} — no se pudo revisar nada. NO se da por bueno.`);
    return 1;
  }
  // 🔴 `&& !r.hallazgos.length` (2026-08-31, revisión a ciegas). ANTES este atajo salía 0 en
  // cuanto no había stories EN TRANSICIÓN, sin mirar los hallazgos — y el hallazgo de
  // `frontmatter-roto` es exactamente uno que aparece SIN transición: una story cuyo frontmatter
  // no se puede leer no puede verse pasando a `done`, por definición. Resultado: en el modo con
  // que lo invoca el CI el hallazgo se calculaba y se TIRABA, imprimiendo ✅ y saliendo 0; el
  // mismo input con --json salía 1. O sea que el primer control que promete la documentación
  // —"frontmatter legible"— nunca frenó nada en el servidor.
  const dondeMira = staged ? 'lo que estás por commitear' : 'este diff';
  // 🔴 El atajo verde sólo vale si TAMPOCO hay avisos (2026-09-17, pase adversarial): antes salía
  // antes del bloque de avisos, así que todo aviso del chequeo 5 —«no pude comparar el índice de
  // memoria», «deriva heredada»— se tragaba y el portón imprimía ✅. Justo lo que el AC 23 prohíbe:
  // nunca dar por bueno lo que no se pudo medir.
  if (!r.revisadas.length && !r.hallazgos.length && !(r.avisos || []).length) {
    console.log(`✅ tycon-ci-gate: ninguna story pasa a review/done en ${dondeMira} (${r.archivos} .md mirados).`);
    return 0;
  }
  if (r.revisadas.length) {
    console.log(`tycon-ci-gate: ${r.revisadas.length} story(s) declarándose lista(s):`);
    for (const s of r.revisadas) console.log(`   · ${s.story} (${s.de} → ${s.a}) — ${s.archivo}`);
  }
  const avisosDeStory = (r.avisos || []).filter((h) => !/^indice-de-memoria/.test(h.regla) && h.regla !== 'roster-incoherente' && h.regla !== 'storyid-sin-story');
  // También el suyo (pase adversarial de la 1.17.1, tanda 2): bajo el encabezado de `review → done` decía que con
  // TYCON_REVIEW_A_DONE=block frenaba y que el pull request la frenaba, y ninguna de las dos es cierta.
  const avisosDeStoryId = (r.avisos || []).filter((h) => h.regla === 'storyid-sin-story');
  if (avisosDeStoryId.length) {
    console.error('\n⚠️  AVISO — archivos que se parecen a una story pero el arnés no los trata como tal:');
    for (const h of avisosDeStoryId) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
    console.error('   Avisa y no frena, en ningún lado: un archivo con `storyId:` puede no ser una story.');
  }
  const avisosDeMemoria = (r.avisos || []).filter((h) => /^indice-de-memoria/.test(h.regla));
  // Su propio bloque: el encabezado de los otros avisos habla de `review → done`, y éste no tiene
  // nada que ver con esa transición. Un aviso bajo el título equivocado se lee como otra cosa.
  const avisosDeNombres = (r.avisos || []).filter((h) => h.regla === 'roster-incoherente');
  if (avisosDeNombres.length) {
    console.error('\n⚠️  AVISO — el registro de revisores no coincide con quién firmó los hallazgos:');
    for (const h of avisosDeNombres) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
    console.error('   Avisa y no frena desde el 2026-09-22: en sus dos apariciones falló ella, no lo');
    console.error('   que vigila (la última frenó 5 stories sanas de un producto). Las otras');
    console.error('   reglas del registro —que exista, que se lea, que el autor no sea el revisor—');
    console.error('   siguen frenando. Vuelve a frenar con TYCON_ROSTER_NAMES=block.');
  }
  if (avisosDeStory.length) {
    console.error(`\n⚠️  AVISO — review → done sin evidencia completa (hoy avisa; con TYCON_REVIEW_A_DONE=block bloquea):`);
    for (const h of avisosDeStory) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
    console.error('   Es la transición interna: el paso a `review` ya se juzgó. El portón del pull request SÍ la frena.');
  }
  if (avisosDeMemoria.length) {
    console.error(`\n⚠️  AVISO — el índice de memoria de engram (no frena, pero NO es «está bien»):`);
    for (const h of avisosDeMemoria) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
  }
  if (!r.hallazgos.length) { console.log(r.avisos && r.avisos.length ? '✅ Nada que frene (el aviso de arriba se mide, no frena).' : '✅ Todas traen su evidencia en el repo.'); return 0; }
  console.error(`\n❌ tycon-ci-gate — ${r.hallazgos.length} problema(s):`);
  for (const h of r.hallazgos) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
  if (staged) {
    console.error('\n   Esto todavía no se commiteó: arreglalo ahora y volvé a intentar. Si de verdad');
    console.error('   corresponde, la salida es declararlo en el frontmatter de la story (arriba dice');
    console.error('   cuál), que queda escrito y se ve en el pull request. El portón del servidor va a');
    console.error('   pedir exactamente lo mismo cuando el commit llegue.');
  } else {
    // 🔴 Este texto YA MINTIÓ una vez y costó una mañana. Del 2026-09-22 a la mañana decía que
    // todos estos controles corrían en el pre-commit; `roster-incoherente` no corría, y el dev se
    // fue a buscar un hook salteado que nunca existió (un pull request de un producto del equipo). Se corrigió diciendo
    // que ese cruce vivía SÓLO acá… y esa corrección quedó falsa el mismo día, cuando la story 7.13
    // le dio su contraparte local (`revisarRosterLocal` en `on-pre-commit.js`). Lo cazó el pase
    // adversarial de la propia 7.13.
    // La lección, por tercera vez: un mensaje de error que afirma dónde corre otra capa se pudre
    // con el próximo cambio. Así que ya no lo afirma — dice lo único que este proceso sabe de
    // verdad: que el commit llegó hasta acá.
    console.error('\n   Estos controles tienen contraparte en la máquina, en el pre-commit del arnés.');
    console.error('   Que hayan llegado acá significa que ese commit no pasó por ella: otra máquina,');
    console.error('   la web de Azure DevOps, hooks salteados, o una copia del arnés desactualizada.');
    console.error('   (`roster-incoherente` en la máquina AVISA y no frena, salvo TYCON_ROSTER_NAMES=block:');
    console.error('   podés haber commiteado con el aviso delante.)');
  }
  return 1;
}

// 🔴 `process.exitCode`, NO `process.exit()`. Este guión lo ejecuta otro proceso y le parsea la
// salida; en Node las escrituras a una tubería son ASINCRÓNICAS y `process.exit()` mata el proceso
// con parte de lo escrito todavía en el aire. Medido en audit-dependencies.js el 2026-09-28: un
// informe de 9782 bytes llegaba cortado en 8192 y el consumidor lo leía como «no pude», nunca como
// un error. `main` acá es sincrónica y no deja manejadores abiertos, así que con `exitCode` el
// proceso termina solo, cuando terminó de escribir.
// Caso: guides/incident-log.md#informe-cortado-por-la-tuberia-2026-09-28
if (require.main === module) process.exitCode = main();
// `mdDelDiff` y `contenidoEn` se exportan desde 2026-09-22 para que `cierre-recortado` T12 pueda
// EJECUTARLAS en vez de comparar sus bytes contra `main`. Comparar texto no distinguía una mejora
// de un deterioro: cualquier cambio salía rojo, y así se fueron desfrizando funciones de a una.
module.exports = { llaveFrena, revisar, frontmatter, declaraSerStory, escalar, hayEvidencia, prefijoDeEvidencia, runDirsDeStory, validarRoster, advisoresEnFindings, FUENTES_SINTETICAS, esEvidenciaDeCierre, NO_ES_EVIDENCIA_DE_CIERRE, ES_EVIDENCIA_ADEMAS, mdDelDiff, contenidoEn };
