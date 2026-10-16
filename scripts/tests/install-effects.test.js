'use strict';
/**
 * install-effects.test.js — lo que la instalación cambia en la máquina y en el asistente sale de UN archivo, y ese
 * archivo no puede callar una pieza ni nombrar una que ya no existe (story 8.16, tanda A · AC 4 y AC 10).
 *
 * EL CASO. La auditoría de la copia publicada (2026-10-03) encontró que la sección «qué escribe en tu máquina» de la
 * portada se presentaba como lista completa y no lo era: dos ajustes de `settings.json`, los comandos copiados, un
 * barrido diario de los repos vecinos y lo que queda guardado bajo `~/.claude/` no estaban; y los tres bloques que
 * cambian cómo contesta el asistente en todos los proyectos salían como «bloques entre sus marcadores». La portada, el
 * cierre de `install`, el plan y `doctor` eran textos sueltos que nadie cruzaba con el instalador. Desde esta tanda leen
 * `scripts/setup/install-effects.json`, y estas reglas lo atan al instalador en los dos sentidos:
 *   · una entrada por hook de `HOOKS_CANONICAL` y de `OPTIN_HOOKS` (y por los que sólo registra el `.ps1`), con el
 *     mismo `id` que el reporte de piezas; por bloque de `claude-md-blocks/`; por ajuste de `TOP_CANONICAL` y
 *     `ENV_CANONICAL`; por pieza de la lista declarada del aplicador (`fixtures/harness-managed-pieces.json`);
 *   · una entrada `kind: task` por cada cosa que corre sola, con `source` (archivo y texto): cada lanzamiento de fondo
 *     del instalador —y cada paso de una tanda de fondo de varios renglones— tiene que caer en UNA, y el texto de cada
 *     una tiene que existir;
 *   · `windows` de cada hook es lo que registra HOY `$HooksCanonical` del `.ps1`, y el de cada tarea del instalador, si
 *     el `.ps1` la nombra (`source.ps1_pattern`);
 *   · `stores` de cada hook dice la carpeta que su script nombra bajo `~/.claude/`, y `uninstall` la lista en «deja»;
 *   · cada cosa que la lista de piezas declara como «excluida» está mirada: o tiene su entrada, o tiene su motivo;
 *   · (story 8.16, tanda C · T31) cada entrada dice en `profiles` en qué perfil existe, con las reglas de la
 *     clasificación (lo que frena, lo que cambia cómo contesta, los ajustes y los hooks de git, sólo en full; lo de una
 *     integración, en los dos), y la columna «Perfil» de la tabla de hooks de INSTALL.md lo repite fila por fila.
 * Una pieza sin entrada, una entrada sin pieza o un lanzamiento de fondo sin declarar dan rojo nombrándolo.
 *
 * LO QUE NO VE (dicho, para que nadie lo lea como cubierto): un paso que el instalador corre en PRIMER plano y que no
 * es una pieza registrable ni un lanzamiento de fondo no tiene de dónde salir solo; entra cuando alguien lo declara
 * (así entraron `task:sqlite` y `task:agents-pointer`, por el pase adversarial de la tanda A).
 *
 * No usa bash ni toca la HOME. Correr:   node scripts/tests/install-effects.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const managed = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'managed.js'));
const uninstall = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'uninstall.js'));
const INSTALLER = 'scripts/install-tycon-hooks.sh';
const INSTALLER_PS1 = 'scripts/install-tycon-hooks.ps1';
const PIECES = 'scripts/tests/fixtures/harness-managed-pieces.json';

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const readJson = (root, rel) => JSON.parse(read(root, rel));
const nameOf = (e) => String(e.id || e.id_pattern);

// ── lo que el instalador hace, leído de su texto ────────────────────────────────────────────────────────────────

/** Los bloques de `claude-md-blocks/`: el nombre de cada `.md`. */
function blockNames(root) {
  return fs.readdirSync(path.join(root, 'claude-md-blocks')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
}

/**
 * Las claves de `TOP_CANONICAL` (tal cual) y de `ENV_CANONICAL` (con `env.` adelante). Desde la story 8.17 (tanda W3)
 * las escribe el aplicador de settings.json, scripts/setup/apply-hooks.js (antes, el bloque de Python del instalador).
 */
const APPLIER = 'scripts/setup/apply-hooks.js';
function canonicalSettings(root) {
  const { TOP_CANONICAL, ENV_CANONICAL } = require(path.join(root, APPLIER));
  assert.ok(TOP_CANONICAL && ENV_CANONICAL, `${APPLIER}: no exporta TOP_CANONICAL y ENV_CANONICAL`);
  // story 7.27: más la carpeta de los mods, que el aplicador SUMA a CLAUDE_CODE_PLUGIN_DIRS (no es una clave canónica)
  const { PLUGIN_DIRS_ID } = require(path.join(root, PLUGIN_DIRS));
  return [...Object.keys(TOP_CANONICAL), ...Object.keys(ENV_CANONICAL).map((k) => `env.${k}`), PLUGIN_DIRS_ID];
}
const PLUGIN_DIRS = 'scripts/setup/harness/plugin-dirs.js';

/**
 * Los lanzamientos de fondo del instalador: `[{ line, text }]`. Uno es: una orden con `nohup` o `setsid` (hasta el `&`
 * que la cierra, si sigue en otros renglones), cualquier orden que termina en un `&` suelto, un sub-shell que deja algo
 * corriendo (`( … & )`) o un `disown`. Un comentario al final del renglón no cuenta, ni los renglones de comentario.
 */
function backgroundLaunches(sh) {
  const lines = sh.split('\n');
  const out = [];
  const isComment = (l) => /^\s*#/.test(l);
  const code = (l) => l.replace(/\s+#[^'"]*$/, '').trimEnd();
  const endsInBackground = (l) => /(^|[^&])&\s*(\)\s*(2>\/dev\/null)?)?$/.test(code(l));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isComment(l)) continue;
    if (/\b(nohup|setsid)\b/.test(code(l))) {
      let j = i;
      while (j < lines.length - 1 && j < i + 60 && !endsInBackground(lines[j])) j++;
      out.push({ line: i + 1, text: lines.slice(i, j + 1).join('\n') });
      i = j;
    } else if (endsInBackground(l) || /\bdisown\b/.test(code(l))) {
      out.push({ line: i + 1, text: l });
    }
  }
  return out;
}
// Dentro de una tanda de fondo de varios renglones, lo que se invoca y NO es una tarea que corre sola, con su motivo.
const NOT_A_TASK = [
  { pattern: '--prepare-state', why: 'copia los registros con nombre viejo antes de abrirlos (story 8.9): no hace nada por su cuenta' },
];
/** Los renglones de una tanda de varios renglones que invocan un programa (los pasos que la tanda corre). */
// un paso de la tanda llama a `node`, o al Node del arnés que la tanda recibe como argumento (`"$N"`, story 8.39)
const NODE_CALL = /(?:\bnode|"\$N")\s+["$]/;
const stepsOf = (launch) => launch.text.split('\n').slice(1).filter((l) => !/^\s*#/.test(l) && NODE_CALL.test(l));

/**
 * Los hooks que registra el aplicador de Windows: `<EVENTO>:<spec>`. Desde la story 8.17 (tanda W3) los dos aplicadores
 * leen scripts/setup/hooks-list.json, y Windows registra lo que no excluye (`platforms.windows: false`): lo lee
 * `managed.ps1Hooks`, el mismo lector que usa doctor.
 */
function ps1Hooks(root) {
  return new Set((managed.ps1Hooks(root) || []).map((h) => `${h.event}:${h.relpath}`));
}
const ps1Id = (id) => String(id);

/** ¿La entrada `e` es la pieza `p` de la lista declarada del aplicador? Por `id`, o por el patrón de la pieza. */
function matchesPiece(e, p) {
  if (e.kind !== p.kind) return false;
  if (p.id) return e.id === p.id;
  if (e.id_pattern) return e.id_pattern === p.id_pattern;
  return new RegExp(p.id_pattern).test(e.id);
}

// Lo que la lista de piezas declara «excluido» (lo que el aplicador hace y no es una pieza registrable): cada cosa está
// mirada. `effect` = la entrada de la lista de efectos que lo cuenta; `why` = por qué no es un efecto que declarar.
const EXCLUDED = [
  { what: 'las copias .bak', why: 'son copias de respaldo, no un cambio en la máquina' },
  { what: 'pre-commit.local y post-commit.local', effect: 'pre-commit' },
  { what: 'el estado, los sellos, los candados y los registros', effect: 'UserPromptSubmit:tycon-pipeline/scripts/on-prompt.js' },
  { what: '<clon>/.dashboard/', effect: 'task:stage-metrics' },
  { what: 'los AGENTS.md puntero', effect: 'task:agents-pointer' },
  { what: 'el esqueleto de settings.json', why: 'crea el archivo vacío que la persona no tenía; lo que va adentro tiene sus entradas' },
  { what: 'la normalización de --ff-only --autostash', why: 'corrige la línea de arranque vieja del equipo; la copia pública no la trae' },
  { what: 'quitar los hooks reemplazados', why: 'saca lo que el propio arnés había puesto' },
  { what: 'reescribir rutas viejas', why: 'reescribe entradas del propio arnés a su nombre nuevo' },
  { what: 'instalar sqlite3', effect: 'task:sqlite' },
  { what: 'actualizar el binario de engram', effect: 'task:engram-version' },
  { what: 'git config --unset core.hooksPath', effect: 'pre-commit' },
  { what: 'launchctl setenv', effect: 'ar.com.tycon.harness-env' },
  { what: 'los .toml que deploy-codex-all.js regenera dentro del clon', why: 'vive dentro del clon, no en la máquina' },
];

// Las carpetas de ~/.claude que un hook puede nombrar y NO son «algo que guarda»: lo que lee o lo que es del arnés.
const NOT_A_STORE = ['.tycon-pipeline', 'settings.json', 'settings.local.json', 'tycon-claude-guides', 'agent-skills', 'CLAUDE.md', 'projects',
  'skills', 'agents', 'tycon.json', 'plugins', 'channels', 'commands'];
/** El archivo del script de un hook, por su id: `@tcg:x` vive en scripts/hooks/, lo demás en skills/. */
function hookScript(root, id) {
  const rel = managed.hookId(id).relpath;
  return rel.startsWith('@tcg:') ? path.join(root, 'scripts', 'hooks', rel.slice(5)) : path.join(root, 'skills', rel);
}
/** Los nombres bajo `~/.claude/` que el script de un hook nombra como propios (fuera de la carpeta de estado). */
function namedStores(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const names = new Set();
  for (const m of text.matchAll(/homedir\(\),\s*'\.claude',\s*'([^']+)'/g)) names.add(m[1]);
  for (const m of text.matchAll(/HOME\/\.claude\/([A-Za-z0-9._-]+)/g)) names.add(m[1]);
  return [...names].filter((n) => !NOT_A_STORE.includes(n));
}

/**
 * La lista contra el instalador, en los dos sentidos. Devuelve los problemas, cada uno nombrando la entrada, la pieza o
 * la línea. Vacío = la lista dice lo que el instalador hace, ni más ni menos.
 */
function crossProblems(root, effects) {
  const out = [];
  const sh = read(root, INSTALLER);
  const ps1 = read(root, INSTALLER_PS1);
  const byKind = (k) => effects.filter((e) => e.kind === k);
  const ids = (k) => new Set(byKind(k).map((e) => e.id));

  // hooks: las dos listas del .sh, y los que sólo registra el .ps1
  const shHooks = new Set((managed.applierHooks(root) || []).map((h) => `${h.event}:${h.relpath}`));
  const winHooks = ps1Hooks(root);
  const hookIds = ids('hook');
  for (const id of shHooks) if (!hookIds.has(id)) out.push(`hook sin entrada: ${id} está en ${INSTALLER} y no en la lista`);
  for (const id of hookIds) {
    if (!shHooks.has(id) && !winHooks.has(ps1Id(id))) out.push(`entrada sin hook: ${id} no está en ${INSTALLER} ni en ${INSTALLER_PS1}`);
  }
  for (const id of winHooks) {
    if (![...hookIds].some((h) => ps1Id(h) === id)) out.push(`hook sin entrada: ${id} está en ${INSTALLER_PS1} y no en la lista`);
  }

  // bloques y ajustes
  const blocks = new Set(blockNames(root).map((n) => `TYCON_BLOCK:${n}`));
  for (const id of blocks) if (!ids('block').has(id)) out.push(`bloque sin entrada: ${id}`);
  for (const id of ids('block')) if (!blocks.has(id)) out.push(`entrada sin bloque: ${id} no está en claude-md-blocks/`);
  const settings = new Set(canonicalSettings(root));
  for (const id of settings) if (!ids('setting').has(id)) out.push(`ajuste sin entrada: ${id}`);
  for (const id of ids('setting')) if (!settings.has(id)) out.push(`entrada sin ajuste: ${id} no está en TOP_CANONICAL, ENV_CANONICAL ni es la carpeta de los mods`);
  if (byKind('import').length !== 1) out.push(`el import del README: tiene que haber una entrada y hay ${byKind('import').length}`);

  // la lista declarada del aplicador: cada pieza suya tiene entrada, y cada entrada (que no sea una tarea) es una pieza
  const declared = readJson(root, PIECES);
  for (const p of declared.pieces) {
    if (!effects.some((e) => matchesPiece(e, p))) out.push(`pieza sin entrada: ${p.kind} ${p.id || p.id_pattern} (${PIECES})`);
  }
  for (const e of effects) {
    if (e.kind === 'task') continue;
    if (!declared.pieces.some((p) => matchesPiece(e, p))) out.push(`entrada sin pieza: ${e.kind} ${nameOf(e)} no está en ${PIECES}`);
  }
  // …y lo que esa lista declara «excluido» está mirado: con su entrada, o con su motivo
  for (const x of declared.excluded || []) {
    const hits = EXCLUDED.filter((k) => String(x.what).includes(k.what));
    if (hits.length !== 1) { out.push(`exclusión sin mirar: «${String(x.what).slice(0, 70)}» (${PIECES}) — decidí si es un efecto que declarar y anotala en EXCLUDED`); continue; }
    if (hits[0].effect && !effects.some((e) => e.id === hits[0].effect)) out.push(`exclusión sin entrada: «${hits[0].what}» dice que la cuenta ${hits[0].effect}, que no está en la lista`);
  }

  // lo que corre solo: cada tarea existe, y cada lanzamiento de fondo del instalador es de UNA
  const tasks = byKind('task');
  for (const t of tasks) {
    const src = t.source || {};
    let text = null;
    try { text = read(root, src.file); } catch (_) { text = null; }
    if (text === null) out.push(`entrada sin pieza: la tarea ${t.id} nombra ${src.file}, que no existe`);
    else if (!text.includes(src.pattern)) out.push(`entrada sin pieza: la tarea ${t.id} busca «${src.pattern}» en ${src.file} y no está`);
  }
  const ofInstaller = tasks.filter((t) => t.source && t.source.file === INSTALLER);
  const launchedBy = new Map();
  for (const launch of backgroundLaunches(sh)) {
    const mine = ofInstaller.filter((t) => launch.text.includes(t.source.pattern));
    if (!mine.length) out.push(`lanzamiento de fondo sin declarar: ${INSTALLER}:${launch.line} «${launch.text.split('\n')[0].trim().slice(0, 100)}»`);
    for (const t of mine) {
      if (launchedBy.has(t.id)) out.push(`lanzamiento de fondo sin declarar: ${INSTALLER}:${launch.line} cae en la tarea ${t.id}, que ya es del lanzamiento de la línea ${launchedBy.get(t.id)} — un lanzamiento nuevo lleva su propia entrada`);
      else launchedBy.set(t.id, launch.line);
    }
    // una tanda de varios renglones: cada paso que corre es una tarea declarada (o está en NOT_A_TASK, con su motivo)
    for (const step of stepsOf(launch)) {
      const known = ofInstaller.some((t) => step.includes(t.source.pattern)) || NOT_A_TASK.some((k) => step.includes(k.pattern));
      if (!known) out.push(`lanzamiento de fondo sin declarar: un paso de la tanda de ${INSTALLER}:${launch.line} no es de ninguna tarea «${step.trim().slice(0, 100)}»`);
    }
  }

  // `windows` de cada tarea del instalador: lo que dice el .ps1
  for (const t of ofInstaller) {
    if (!t.source.ps1_pattern) { out.push(`${t.id}: una tarea del instalador lleva «source.ps1_pattern» (cómo la nombra el instalador de Windows)`); continue; }
    const does = ps1.includes(t.source.ps1_pattern);
    if (t.windows !== does) out.push(`${t.id}: windows dice ${t.windows} y el .ps1 ${does ? 'la corre' : 'no la nombra'} («${t.source.ps1_pattern}»)`);
  }

  // `stores` de cada hook: la carpeta que su script nombra bajo ~/.claude, y `uninstall` la conoce
  const kept = new Set(uninstall.HOOK_STORES.map((s) => s.name));
  for (const e of byKind('hook')) {
    const named = namedStores(hookScript(root, e.id));
    if (named === null) continue;   // el script no está en este árbol (un hook de una integración que no viaja): no se mide
    for (const n of named) {
      if (!(typeof e.stores === 'string' && e.stores.includes(`~/.claude/${n}`))) out.push(`${e.id}: su script nombra ~/.claude/${n} y «stores» dice ${JSON.stringify(e.stores)}`);
    }
    const own = typeof e.stores === 'string' ? (e.stores.match(/^~\/\.claude\/([^/]+)/) || [])[1] : null;
    if (own && own !== '.tycon-pipeline' && !kept.has(own)) out.push(`${e.id}: guarda en ~/.claude/${own} y uninstall no lo nombra en «deja» (HOOK_STORES de scripts/setup/harness/uninstall.js)`);
  }
  return out;
}

/** `windows` de cada hook contra lo que registra el `.ps1` hoy. */
function windowsProblems(root, effects) {
  const winHooks = ps1Hooks(root);
  const out = [];
  for (const e of effects.filter((x) => x.kind === 'hook')) {
    const does = winHooks.has(ps1Id(e.id));
    if (e.windows !== does) out.push(`${nameOf(e)}: windows dice ${e.windows} y el .ps1 ${does ? 'lo registra' : 'no lo registra'}`);
  }
  return out;
}

/** Una copia del árbol con sólo lo que el cruce lee, para romperla a gusto. */
function toyTree(mutate = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-effects-'));
  const copy = (rel) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.cpSync(path.join(ROOT, rel), path.join(dir, rel), { recursive: true });
  };
  const sources = [...new Set(managed.readEffects(ROOT).effects.filter((e) => e.kind === 'task').map((e) => e.source.file))];
  for (const rel of [INSTALLER, INSTALLER_PS1, PIECES, APPLIER, PLUGIN_DIRS, 'scripts/setup/hooks-list.json', 'claude-md-blocks', 'scripts/hooks', ...sources.filter((f) => f !== INSTALLER)]) copy(rel);
  if (mutate.installer) fs.writeFileSync(path.join(dir, INSTALLER), mutate.installer(read(dir, INSTALLER)));
  return dir;
}

// ── T2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Effects_DeclaredList_MatchesInstallerBlocksPiecesAndLaunches', async (t) => {
  const loaded = managed.readEffects(ROOT);
  assert.strictEqual(loaded.ok, true, `no pude leer la lista de efectos: ${loaded.reason}`);
  const effects = loaded.effects;

  await t.test('cada entrada trae todos los campos, con valores del vocabulario', () => {
    assert.deepStrictEqual(managed.effectProblems(readJson(ROOT, managed.EFFECTS_FILE)), [], 'la lista real no pasa su validación');
    for (const e of effects) assert.ok(e.does.length >= 20 && !/\.(js|sh|ps1|py)\b/.test(e.does), `${nameOf(e)}: «does» dice qué cambia para la persona, no nombra un archivo del arnés: ${e.does}`);
  });

  await t.test('una entrada por pieza y una pieza por entrada', () => {
    assert.deepStrictEqual(crossProblems(ROOT, effects), [], 'la lista contra el instalador');
  });

  await t.test('el detector de lanzamientos ve los del instalador real (no está ciego)', () => {
    const launches = backgroundLaunches(read(ROOT, INSTALLER));
    assert.ok(launches.length >= 5, `leí ${launches.length} lanzamientos de fondo en ${INSTALLER}: el instalador tiene cinco`);
    const batch = launches.find((l) => l.text.includes('thread-rescue.log'));
    assert.ok(batch, 'la tanda del rescate (un nohup de varios renglones) se lee entera');
    assert.ok(stepsOf(batch).length >= 4, `la tanda del rescate corre al menos cuatro pasos y leí ${stepsOf(batch).length}`);
  });

  await t.test('lo que frena: los dos frenos de cualquier repo, y nada que frene sin decir dónde', () => {
    const anyRepo = effects.filter((e) => e.blocks === 'any-repo').map((e) => e.id);
    for (const id of ['PreToolUse:@tcg:safety-guard-pre.sh', 'PreToolUse:@tcg:test-scope-guard-pre.sh']) {
      assert.ok(anyRepo.includes(id), `${id} frena en cualquier repo`);
    }
    assert.ok(managed.brakes(effects).length >= 8, 'los hooks que pueden frenar son al menos ocho');
  });
});

// ── T3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Effects_Check_CatchesMissingStaleAndUndeclaredLaunch', () => {
  const effects = managed.readEffects(ROOT).effects;
  const withChange = (id, change) => effects.map((e) => (e.id === id ? Object.assign({}, e, change) : e));

  // sin una entrada: la pieza queda sin declarar
  const gone = 'PreToolUse:@tcg:safety-guard-pre.sh';
  const missing = crossProblems(ROOT, effects.filter((e) => e.id !== gone));
  assert.ok(missing.some((m) => m.startsWith('hook sin entrada') && m.includes(gone)), `sin ${gone} tenía que dar rojo nombrándolo: ${missing.join(' · ') || '(ninguno)'}`);

  // con una entrada muerta: nombra una pieza que el instalador no tiene
  const dead = Object.assign({}, effects.find((e) => e.id === gone), { id: 'PreToolUse:@tcg:retired-guard.js' });
  const stale = crossProblems(ROOT, [...effects, dead]);
  assert.ok(stale.some((m) => m.startsWith('entrada sin hook') && m.includes('retired-guard.js')), `una entrada muerta tenía que dar rojo nombrándola: ${stale.join(' · ') || '(ninguno)'}`);
  const deadTask = { id: 'task:retired', kind: 'task', windows: false, source: { file: INSTALLER, pattern: 'retired-task.js --run', ps1_pattern: 'retired-task.js' } };
  assert.ok(crossProblems(ROOT, [...effects, deadTask]).some((m) => m.includes('task:retired') && m.includes('retired-task.js --run')), 'una tarea cuyo texto ya no está tenía que dar rojo');

  // un instalador de juguete con un lanzamiento de fondo de más, en cada forma de dejar algo corriendo
  const real = read(ROOT, INSTALLER);
  const undeclaredIn = (installer) => {
    const tree = toyTree({ installer: () => installer });
    try { return crossProblems(tree, effects).filter((m) => m.startsWith('lanzamiento de fondo sin declarar')); } finally { fs.rmSync(tree, { recursive: true, force: true }); }
  };
  assert.deepStrictEqual(undeclaredIn(real), [], 'la copia sin tocar pasa: el rojo de abajo es del lanzamiento, no de la copia');
  for (const [what, extra] of [
    ['un nohup', 'nohup node "$SCRIPT_DIR/lib/undeclared-sweep.js" >/dev/null 2>&1 &'],
    ['una orden que termina en &', 'node "$SCRIPT_DIR/lib/undeclared-sweep.js" >/dev/null 2>&1 &'],
    ['un sub-shell', '( node "$SCRIPT_DIR/lib/undeclared-sweep.js" >/dev/null 2>&1 & ) 2>/dev/null'],
    ['un nohup con un comentario detrás', 'nohup node "$SCRIPT_DIR/lib/undeclared-sweep.js" >/dev/null 2>&1 &   # de fondo'],
    ['un setsid', 'setsid node "$SCRIPT_DIR/lib/undeclared-sweep.js" >/dev/null 2>&1 &'],
  ]) {
    const found = undeclaredIn(`${real}\n${extra}\n`);
    const lineNo = `${real}\n${extra}\n`.split('\n').indexOf(extra) + 1;
    assert.strictEqual(found.length, 1, `${what} de más, un rojo: ${found.join(' · ') || '(ninguno)'}`);
    assert.ok(found[0].includes(`${INSTALLER}:${lineNo}`) && found[0].includes('undeclared-sweep.js'), `${what}: el rojo nombra la línea y lo que lanza: ${found[0]}`);
  }
  // un paso nuevo DENTRO de la tanda de varios renglones (donde se suman las tareas de fondo) también da rojo
  const stepAnchor = real.split('\n').find((l) => l.includes('collect-findings.log') && NODE_CALL.test(l));
  assert.ok(stepAnchor, 'no encontré el paso de los hallazgos dentro de la tanda de fondo');
  const inBatch = undeclaredIn(real.replace(stepAnchor, `${stepAnchor}\n    node "$SCRIPT_DIR/lib/undeclared-step.js" --budget-ms 1000 >/dev/null 2>&1`));
  assert.ok(inBatch.some((m) => m.includes('un paso de la tanda') && m.includes('undeclared-step.js')), `un paso de más en la tanda tenía que dar rojo: ${inBatch.join(' · ') || '(ninguno)'}`);
  // un lanzamiento nuevo que escribe en un registro ya declarado no se esconde detrás de esa tarea
  const sameLog = undeclaredIn(`${real}\nnohup node "$SCRIPT_DIR/lib/another.js" > "$HOME/thread-rescue.log" 2>&1 &\n`);
  assert.ok(sameLog.some((m) => m.includes('task:thread-rescue') && m.includes('ya es del lanzamiento')), `un segundo lanzamiento sobre un registro declarado tenía que dar rojo: ${sameLog.join(' · ') || '(ninguno)'}`);

  // `stores`: un hook que guarda bajo ~/.claude y no lo dice, y uno que guarda donde uninstall no mira
  const noStore = crossProblems(ROOT, withChange('Stop:@tcg:blocking-meter.js', { stores: null }));
  assert.ok(noStore.some((m) => m.includes('Stop:@tcg:blocking-meter.js') && m.includes('~/.claude/blocking-meter')), `un hook que guarda y no lo declara tenía que dar rojo: ${noStore.join(' · ') || '(ninguno)'}`);
  const strayStore = crossProblems(ROOT, withChange('SessionStart:@tcg:bench-notice.js', { stores: '~/.claude/somewhere-new/' }));
  assert.ok(strayStore.some((m) => m.includes('somewhere-new') && m.includes('uninstall')), `una carpeta que uninstall no nombra tenía que dar rojo: ${strayStore.join(' · ') || '(ninguno)'}`);
  // `windows` de una tarea del instalador
  const wrongTask = crossProblems(ROOT, withChange('task:ado-projects-refresh', { windows: false }));
  assert.ok(wrongTask.some((m) => m.startsWith('task:ado-projects-refresh: windows dice false')), `una tarea que el .ps1 corre marcada windows:false tenía que dar rojo: ${wrongTask.join(' · ') || '(ninguno)'}`);
  // una exclusión nueva en la lista de piezas, sin mirar
  const tree = toyTree();
  try {
    const pieces = readJson(tree, PIECES);
    pieces.excluded.push({ what: 'una cosa nueva que el aplicador hace', reason: 'no es una pieza' });
    fs.writeFileSync(path.join(tree, PIECES), JSON.stringify(pieces));
    assert.ok(crossProblems(tree, effects).some((m) => m.startsWith('exclusión sin mirar') && m.includes('una cosa nueva')), 'una exclusión nueva tenía que dar rojo');
  } finally { fs.rmSync(tree, { recursive: true, force: true }); }

  // la validación: una lista rota no se lee como «no cambia nada»
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'install-effects-broken-'));
  try {
    assert.deepStrictEqual(managed.readEffects(broken).ok, false, 'sin el archivo, la lectura no puede dar ok');
    fs.mkdirSync(path.join(broken, 'scripts', 'setup'), { recursive: true });
    fs.writeFileSync(path.join(broken, managed.EFFECTS_FILE), '{ "effects": [');
    const r = managed.readEffects(broken);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /install-effects\.json/, 'el motivo nombra el archivo');
    // una lista VACÍA también es una lista rota: con ella el cierre diría «0 pueden frenar» con los frenos instalados
    fs.writeFileSync(path.join(broken, managed.EFFECTS_FILE), '{ "effects": [] }');
    assert.strictEqual(managed.readEffects(broken).ok, false, 'una lista vacía no puede dar ok');
    assert.match(managed.readEffects(broken).reason, /vacía/);
  } finally { fs.rmSync(broken, { recursive: true, force: true }); }
  const sample = effects.find((e) => e.id === gone);
  const bad = (change) => managed.effectProblems({ effects: [Object.assign({}, sample, change)] });
  assert.ok(bad({ blocks: 'sometimes' }).some((m) => m.includes('blocks')), 'un «blocks» fuera del vocabulario');
  assert.ok(bad({ when: 'cuando-quiera' }).some((m) => m.includes('when')), 'un «when» fuera del vocabulario');
  assert.ok(bad({ when: 'integration:nocturnos' }).some((m) => m.includes('nocturnos') && m.includes('no existe')), 'una llave de integración que no existe (el nombre viejo)');
  assert.ok(bad({ does: undefined }).some((m) => m.includes('does')), 'una entrada sin «does»');
  assert.ok(bad({ windows: 'yes' }).some((m) => m.includes('windows')), 'un «windows» que no es sí o no');
  assert.ok(bad({ id: undefined, id_pattern: '^PreToolUse:.+$' }).some((m) => m.includes('un hook lleva «id»')), 'un hook declarado por patrón (el conteo de frenos no lo vería)');
  assert.ok(managed.effectProblems({ effects: [sample, sample] }).some((m) => m.includes('dos veces')), 'una entrada repetida');
  assert.ok(managed.effectProblems({ effects: [{ id: 'task:x', kind: 'task', does: 'una tarea de prueba que no dice de dónde sale', blocks: 'no', when: 'always', switch: null, network: null, stores: null, windows: false, front_page: false }] })
    .some((m) => m.includes('source')), 'una tarea sin «source»');
});

// ── T11 (la mitad de la lista; la de las portadas vive en public-papers.test.js) ────────────────────────────────
test('Effects_WindowsFlag_MatchesPs1Lists', () => {
  const effects = managed.readEffects(ROOT).effects;
  const hooks = ps1Hooks(ROOT);
  assert.ok(hooks.size >= 20, `leí ${hooks.size} hooks de la lista de Windows: no encontré scripts/setup/hooks-list.json`);
  assert.deepStrictEqual(windowsProblems(ROOT, effects), [], '«windows» de cada hook contra lo que Windows registra de la lista');
  // el espejo: una marca cambiada da rojo en ESE hook
  const flipped = effects.map((e) => (e.id === 'PreToolUse:@tcg:safety-guard-pre.sh' ? Object.assign({}, e, { windows: !e.windows }) : e));
  assert.deepStrictEqual(windowsProblems(ROOT, flipped).map((m) => m.split(':').slice(0, 3).join(':')), ['PreToolUse:@tcg:safety-guard-pre.sh']);
});

// ── T31 (story 8.16, tanda C · AC 22): cada entrada dice en qué perfil existe, y la tabla de INSTALL.md lo repite ────
// La regla (Dev Notes, «La clasificación de perfiles»): `minimal` trae lo que hace falta para las guías, las skills, los
// revisores, el pipeline como skill y el aviso de versión nueva. Sólo en `full`: lo que puede frenar, lo que cambia cómo
// contesta el asistente, lo que toca git fuera del clon y lo que corre solo de fondo sin ser de una integración. Lo de
// una integración va en los dos (lo trae su llave). Los seis hooks de `minimal` se nombran acá: sumar uno es una decisión.
const MINIMAL_HOOKS = [
  'UserPromptSubmit:tycon-pipeline/scripts/on-prompt.js', 'PostToolUse:tycon-pipeline/scripts/hook-post-edit.js',
  'PostToolUse:tycon-pipeline/scripts/on-skill-invoke.js', 'PreToolUse:tycon-pipeline/scripts/on-advisor-run.js',
  'SessionStart:@tcg:harness-bootstrap-heal.sh', 'SessionStart:@tcg:branch-guard-notice.js',
  // el freno de comandos destructivos está en los dos perfiles (decisión del dueño, 2026-10-05)
  'PreToolUse:@tcg:safety-guard-pre.sh',
];
/** Las filas de «Los hooks que instala»: `{ hook, event, profile }` (la columna «Perfil» tal cual), o null sin la columna. */
function installTableRows(text) {
  const at = text.indexOf('### Los hooks que instala');
  if (at < 0) return null;
  const lines = text.slice(at).split('\n');
  const head = lines.findIndex((l) => /^\| Hook \|/.test(l));
  if (head < 0) return null;
  const cols = lines[head].split(/(?<!\\)\|/).map((c) => c.trim());
  const iProfile = cols.indexOf('Perfil');
  if (iProfile < 0) return null;
  const out = [];
  for (const l of lines.slice(head + 2)) {
    if (!l.startsWith('|')) break;
    const c = l.split(/(?<!\\)\|/).map((x) => x.trim());
    out.push({ hook: c[1].replace(/`/g, ''), event: c[2].replace(/\s*\(.*\)$/, ''), profile: c[iProfile] });
  }
  return out;
}
const profileText = (profiles) => (profiles.includes('minimal') ? 'minimal y full' : 'full');

test('Effects_EveryEntryHasProfiles_InstallTableColumnMatches', () => {
  const eff = managed.readEffects(ROOT);
  assert.ok(eff.ok, eff.reason);
  for (const e of eff.effects) {
    assert.ok(Array.isArray(e.profiles) && e.profiles.includes('full'), `${nameOf(e)}: «profiles» con «full» (todo lo de minimal está en full)`);
  }
  // los hooks de minimal: los seis de la regla, más los de una integración (y el freno de sesiones, que nace apagado en
  // los dos y lo prende su variable)
  const minimalHooks = eff.effects.filter((e) => e.kind === 'hook' && e.profiles.includes('minimal') && !/^integration:/.test(e.when) && e.when !== 'optin:TYCON_SESSION_GUARD').map((e) => e.id);
  assert.deepStrictEqual(minimalHooks.sort(), [...MINIMAL_HOOKS].sort(), 'los hooks de minimal (sin contar los de una integración)');
  for (const e of eff.effects.filter((x) => /^integration:/.test(x.when))) assert.deepStrictEqual(e.profiles, ['minimal', 'full'], `${nameOf(e)}: lo de una integración va en los dos perfiles`);
  // las reglas de lo que queda sólo en full
  for (const e of eff.effects) {
    const integ = /^integration:/.test(e.when);
    const bothByDecision = e.id === 'PreToolUse:@tcg:safety-guard-pre.sh';   // decisión del dueño, 2026-10-05
    if (e.kind === 'hook' && e.blocks !== 'no' && !integ && e.when !== 'optin:TYCON_SESSION_GUARD' && !bothByDecision) assert.deepStrictEqual(e.profiles, ['full'], `${nameOf(e)} frena: sólo full`);
    if (bothByDecision) assert.deepStrictEqual(e.profiles, ['minimal', 'full'], `${nameOf(e)}: el freno de comandos va en los dos perfiles`);
    if (['setting', 'git-hook'].includes(e.kind)) assert.deepStrictEqual(e.profiles, ['full'], `${nameOf(e)}: sólo full`);
    if (e.kind === 'block' && !integ) assert.deepStrictEqual(e.profiles, ['full'], `${nameOf(e)} cambia cómo contesta: sólo full`);
  }
  // la validación lo exige
  const sample = eff.effects.find((e) => e.kind === 'hook');
  const without = Object.assign({}, sample); delete without.profiles;
  assert.ok(managed.effectProblems({ effects: [without] }).some((m) => m.includes('profiles')), 'una entrada sin «profiles»');
  assert.ok(managed.effectProblems({ effects: [Object.assign({}, sample, { profiles: ['minimal'] })] }).some((m) => m.includes('profiles')), 'minimal sin full');
  assert.ok(managed.effectProblems({ effects: [Object.assign({}, sample, { profiles: ['full', 'medio'] })] }).some((m) => m.includes('profiles')), 'un perfil que no existe');

  // la columna «Perfil» de INSTALL.md, fila por fila
  const rows = installTableRows(read(ROOT, 'INSTALL.md'));
  assert.ok(rows, 'la tabla «Los hooks que instala» de INSTALL.md tiene la columna «Perfil»');
  const hooks = eff.effects.filter((e) => e.kind === 'hook' && e.when !== 'platform:windows');
  const same = (r, e) => { const h = managed.hookId(e.id); return h.event === r.event && (h.relpath === r.hook || h.relpath === `@tcg:${r.hook}`); };
  const problems = [];
  for (const r of rows) {
    const hit = hooks.find((e) => same(r, e));
    if (!hit) { problems.push(`fila ${r.hook} (${r.event}): sin entrada en la lista`); continue; }
    if (r.profile !== profileText(hit.profiles)) problems.push(`fila ${r.hook} (${r.event}): dice «${r.profile}» y la lista dice «${profileText(hit.profiles)}»`);
  }
  for (const e of hooks) if (!rows.some((r) => same(r, e))) problems.push(`${e.id}: sin fila en la tabla`);
  assert.deepStrictEqual(problems, []);
});

// ── story 8.16, tanda D (AC 31): las integraciones que `install` ofrece en su pregunta ───────────────────────────────
// `integrations` de la lista nombra las ocho llaves de scripts/lib/tycon-config.js una vez cada una; se ofrecen sólo las
// que se prenden con un sí (clockify, engram, codegraph, codex), cada una con qué hace y qué pide; ado y telegram no
// (piden un dato) y mailbox y nightly tampoco (son del equipo). Una lista mal armada no pasa la validación.
// 🔴 rojo previo verificado: antes de la tanda D la lista no traía `integrations` ni `readIntegrations` existía.
test('8.16 D · Effects_Integrations_OfferedAreTheFourWithASwitch_AllEightNamed', () => {
  const config = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
  const list = managed.readIntegrations(ROOT);
  assert.deepStrictEqual(list.map((x) => x.key).sort(), [...config.LAS_OCHO].sort(), 'las ocho llaves de la configuración, una vez cada una');
  assert.deepStrictEqual(list.filter((x) => x.offered).map((x) => x.key), ['clockify', 'engram', 'codegraph', 'codex']);
  for (const k of ['ado', 'telegram']) assert.match(list.find((x) => x.key === k).how || '', new RegExp(`tycon-config\\.js set ${k === 'ado' ? 'ado\\.org' : 'telegram\\.chat_id'}`), `${k}: cómo se prende`);
  for (const k of ['mailbox', 'nightly']) assert.match(list.find((x) => x.key === k).why, /del equipo/, `${k}: es del equipo`);
  // las ofrecidas se prenden con una llave (no piden un dato)
  for (const x of list.filter((y) => y.offered)) assert.ok(['llave', 'llave-o-detectar'].includes(config.VOCABULARIO.integraciones[x.key]), `${x.key} no es una llave`);
  // espejos de la validación
  const doc = JSON.parse(read(ROOT, 'scripts/setup/install-effects.json'));
  const bad = (mutate) => { const d = JSON.parse(JSON.stringify(doc)); mutate(d); return managed.effectProblems(d); };
  assert.deepStrictEqual(managed.effectProblems(doc), []);
  assert.ok(bad((d) => { delete d.integrations[0].needs; }).some((m) => /qué pide/.test(m)), 'una ofrecida sin «needs»');
  assert.ok(bad((d) => { d.integrations.pop(); }).some((m) => /faltan nightly/.test(m)), 'una que falta');
  assert.ok(bad((d) => { d.integrations[0].key = 'buzon'; }).some((m) => /no es una integración que exista/.test(m)), 'un nombre viejo');
  assert.ok(bad((d) => { d.integrations.push(d.integrations[0]); }).some((m) => /dos veces/.test(m)), 'una repetida');
  assert.ok(bad((d) => { delete d.integrations[7].why; }).some((m) => /por qué/.test(m)), 'una que no se ofrece sin «why»');
});
