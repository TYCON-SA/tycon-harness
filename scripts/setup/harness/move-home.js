'use strict';
// move-home.js — la mudanza de una máquina que corre el arnés desde un CLON a `~/.tycon` (story 8.23, tanda D · AC 27-29 y 32).
//
// ── EL CASO (2026-10-08) ──────────────────────────────────────────────────────────────────�
// Todas las máquinas del equipo corren el arnés desde un clon de git dentro de la carpeta de Claude Code
// (el lugar → <clon>, el estado en la carpeta del mecanismo y la configuración en `tycon.json`, todo dentro de la carpeta
// de Claude Code; las rutas exactas las sabe tycon-home.js: `placePath`, `legacyStateDir`, `legacyConfigFile`).
// Desde la tanda B existe la otra forma —una versión BAJADA como archivos, sin git, en `~/.tycon/harness`— y desde la C una
// máquina sin Claude Code vive entera en `~/.tycon`. Acá cada máquina de hoy pasa a esa forma, una vez, sin perder nada y
// sin tocar el clon de la persona: `harness.js migrate --to-home [--dry-run]`, o solo en el arranque si el perfil del
// equipo dice `install.home: tycon` (AC 32; apagado hasta que el dueño migre su máquina).
//
// ── CÓMO ─────────────────────────────────────────────────────────────────────�
// Primero se COMPRUEBA sin escribir nada (AC 27): la máquina es un clon; `~/.tycon` está libre o es nuestro; la
// configuración de la máquina se lee; la versión del canal se puede ubicar con la credencial (la ÚNICA red antes de
// escribir es mirar, y después bajar); en Windows, nadie tiene tomados los archivos del estado. Con una falla sale 1 con una
// línea y la HOME queda idéntica (ni el registro se escribe). `--dry-run` imprime el plan y sale 0.
// Después, con el candado tomado, la versión se baja y verifica en `incoming/` (eso se limpia solo si falla) y recién ahí
// empieza el DIARIO (`~/.tycon/migrate.json`), antes del primer cambio. Las etapas, cada una idempotente (mira el disco antes
// de actuar), en este orden:
//   start → installed (swap a harness/) → state-moved (la carpeta del mecanismo → ~/.tycon/state, y un enlace atrás;
//   las copias de seguridad a ~/.tycon/backups) → config-moved (la `tycon.json` de la máquina fundida en ~/.tycon/config.json: lo
//   que YA está en la nueva gana, porque ahí vive el permiso de GitHub; la vieja queda como enlace) → dashboard-copied
//   (<clon>/.dashboard copiado a ~/.tycon/state/dashboard; el clon intacto) → links (el lugar, el nombre viejo y
//   agent-skills apuntan a ~/.tycon/harness; un agent-skills que era carpeta real —el clon viejo de skills— se aparta al
//   lado con un sello, nunca se borra) → replugged (el aplicador del árbol NUEVO reescribe los enchufes; los hooks que
//   nombraban el clon y ya tienen reemplazo se sacan, así la cuenta no cambia; la salud) → done (el ESTADO se escribe al
//   final: hasta acá el archivo dice «clon»).
// Cortada en cualquier punto (`kill -9`, la máquina apagada), el arranque siguiente la REPARA desde el diario (`repair`):
// si la versión ya quedó instalada en harness/, completa las etapas que faltan; si no, deshace lo poco que hubo
// (`undo`, en orden inverso). Un fallo DURANTE —el aplicador o la salud en rojo— deshace todo y queda anotado en el estado
// (`migrate_home: { status: 'failed' }`): el arranque no lo reintenta solo (AC 32); `migrate --to-home` a mano sí.
// `TYCON_MIGRATE_DIE_AT=<etapa>` (sólo pruebas) corta el proceso justo después de anotar esa etapa, como un kill -9;
// `TYCON_MIGRATE_FAIL_AFTER=<etapa>` (sólo pruebas) hace fallar la mudanza justo al terminar esa etapa (mide el deshacer).
//
// Lo PERSONAL de la carpeta vieja (tanda F, AC 40): lo que la carpeta vieja de agent-skills traía en skills/ y agents/ y no
// es del arnés ni de terceros queda activo —carpetas reales skills/ y agents/ de Claude Code con lo personal adentro y un
// enlace por entrada del arnés al lado—; el plan lo dice («conserva N skills y M agentes tuyos: …») y la etapa `personal`
// del diario lo mueve (y lo devuelve si la mudanza falla).
//
// El clon de la persona (AC 29) no se mueve, no se borra y no recibe git: deja de ser lo que corre, y queda declarable
// como el que la máquina mantiene (`config set paths.maintained`); `doctor` lo nombra.
//
// Sólo `require` de esta carpeta (viaja con la copia fija del programa). Las piezas de harness.js llegan en `H`.
const fs = require('fs');
const path = require('path');
const S = require('./state.js');
const L = require('./lock.js');
const R = require('./report.js');
const TH = require('./tycon-home.js');
const T = require('./tools.js');
const PLACE = require('./place.js');
const REL = require('./release.js');
const VO = require('./version-order.js');

const JOURNAL_NAME = 'migrate.json';
const STAGES = Object.freeze(['start', 'installed', 'state-moved', 'config-moved', 'dashboard-copied', 'links', 'personal', 'replugged', 'done']);
// los dos lados de lo que Claude Code lee en su carpeta y que la carpeta vieja de agent-skills traía (tanda F, AC 40)
const PERSONAL_SIDES = Object.freeze(['skills', 'agents']);
// la carpeta skills/ o agents/ de Claude Code: su ruta se la pide a tycon-home.js (la carpeta vieja vive al lado)
const claudeSide = (home, side) => path.join(path.dirname(TH.installedSkillsDir(home)), side);
// lo que puede haber en `~/.tycon` y es nuestro: cualquier otra cosa frena (AC 27)
const OWN_ENTRIES = Object.freeze(['harness', 'previous', 'incoming', 'trash', 'third-party', 'team', 'state', 'backups', 'config.json', 'swap.json', JOURNAL_NAME]);
const DIE_VAR = 'TYCON_MIGRATE_DIE_AT';
const HEAD = 'harness.js migrate';

const nowIso = () => new Date().toISOString();
const sha7 = (s) => (s ? String(s).slice(0, 7) : '—');
const stamp = () => nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };
const isRealDir = (p) => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch (_) { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const slash = (p) => String(p).replace(/\\/g, '/');
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* queda: lo dice doctor */ } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } };
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } };
function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
const writeJson = (file, data, mode) => writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`, mode);
/** Mueve una carpeta: rename; entre discos (EXDEV), copia y borra. */
function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  fs.cpSync(from, to, { recursive: true, force: true, errorOnExist: false, verbatimSymlinks: true });
  fs.rmSync(from, { recursive: true, force: true });
}
/** Un enlace a una carpeta (en Windows, una unión: un enlace simbólico de carpeta pide privilegios que un dev no tiene). */
function linkDir(target, link, platform) {
  if (isLink(link)) fs.unlinkSync(link);
  fs.symlinkSync(target, link, platform === 'win32' ? 'junction' : 'dir');
}
const readlink = (p) => { try { return fs.readlinkSync(p); } catch (_) { return null; } };
/**
 * La casa propia del arnés de ESTE contexto: la `TYCON_HOME` de su ambiente si la trae (una vacía o relativa tira, como
 * siempre); si no, `<ctx.home>/.tycon`. Nunca la de quien corre: `TH.ownPaths({ env: ctx.env })` con un ambiente sin
 * `TYCON_HOME` cae a `os.homedir()`, y un contexto con OTRA `home` (una prueba, un ensayo) mezclaba las dos — el estado
 * en la carpeta pedida y `harness/` en la de la máquina. Así un «deshacer» de prueba borró el arnés instalado de una
 * máquina mudada (incident-log#case-test-undo-deleted-installed-harness-2026-10-11). En una corrida real `ctx.home` es `os.homedir()` y da lo mismo que antes.
 */
function ownOf(ctx) {
  const env = ctx.env || {};
  const asked = Object.prototype.hasOwnProperty.call(env, 'TYCON_HOME') && env.TYCON_HOME !== undefined;
  if (asked || !ctx.home) return TH.ownPaths({ env });
  return TH.ownPaths({ env: { TYCON_HOME: path.join(path.resolve(ctx.home), TH.OWN_DIR_NAME) } });
}
const journalPath = (ctx) => path.join(ownOf(ctx).root, JOURNAL_NAME);
const readJournal = (ctx) => { const j = readJson(journalPath(ctx)); return isObject(j) && STAGES.includes(j.stage) ? j : null; };
function writeStage(ctx, j, stage, log) {
  j.stage = stage; j.at = nowIso();
  // 0600: el diario guarda el texto previo de ~/.tycon/config.json, que puede traer el permiso de GitHub (revisor de
  // seguridad de la tanda G; venía de la D)
  writeJson(journalPath(ctx), j, 0o600);
  if (log) log(`mudanza: diario ${journalPath(ctx)} → «${stage}»`);
  // sólo pruebas: un corte justo después de anotar la etapa, como un kill -9
  if (String(ctx.env[DIE_VAR] || '') === stage) process.exit(137);
}

/** Dónde está cada cosa en esta máquina, antes y después. */
function places(ctx, oldTree) {
  const home = ctx.home;
  const own = ownOf(ctx);
  return {
    own,
    oldTree,
    oldTreeReal: real(oldTree) || oldTree,
    oldStateDir: TH.legacyStateDir(home),
    newStateDir: TH.ownStateDir(home),
    oldConfig: TH.legacyConfigFile(home),
    newConfig: own.config,
    dashboard: path.join(oldTree, '.dashboard'),
    newDashboard: path.join(TH.ownStateDir(home), 'dashboard'),
    placeLink: PLACE.placePath(home),
    legacyLink: PLACE.legacyPlacePath(home),
    skillsLink: TH.installedSkillsDir(home),
    newBackups: path.join(own.root, 'backups'),
  };
}

// ── lo personal de la carpeta vieja (tanda F, AC 40) ──────────────────────────────────────────────────────────
// La carpeta vieja de agent-skills (cuando es una carpeta real: el clon viejo de skills) trae en skills/ y agents/
// tres clases de entradas: las DEL ARNÉS (existen con ese nombre en el clon que corre hoy: el mismo contenido que la
// versión que se instala), las DE TERCEROS (un destino o un enlace de scripts/publishing/third-party-skills.json: las repone
// o retira el paso de terceros) y lo PERSONAL del dev (lo demás: .trash, un archivo suelto, un enlace sano o colgado).
// Sin esta etapa lo personal quedaba guardado en la carpeta apartada pero dejaba de estar activo (hallazgo del coordinador
// antes de migrar la máquina del dueño, 2026-10-08): skills/ y agents/ de Claude Code pasan a carpetas reales con lo
// personal adentro, y al lado un enlace por entrada del arnés y de terceros, que pone la propia mudanza con la misma
// regla del instalador (canonical-path.js ensureRepoLinks, 8.7 AC 18; el re-enchufe la vuelve a aplicar y la encuentra hecha).

/** Los nombres que el manifiesto de terceros declara, por lado: la última carpeta skills/ o agents/ del camino dice cuál. */
function thirdPartyNames(tree) {
  const names = { skills: new Set(), agents: new Set(), problem: null };
  const file = path.join(tree, 'scripts', 'publishing', 'third-party-skills.json');
  const m = readJson(file);
  // un manifiesto que está pero no se lee NO es «sin terceros»: se dice, porque lo de terceros pasaría por personal
  if (!m && lexists(file)) names.problem = `${file} no se lee como JSON: lo de terceros se cuenta como personal`;
  const list = m && (Array.isArray(m.third_party) ? m.third_party : (Array.isArray(m.thirdParty) ? m.thirdParty : []));
  for (const t of list || []) {
    if (!isObject(t)) continue;
    for (const c of [t.target, ...(Array.isArray(t.links) ? t.links : [])]) {
      if (typeof c !== 'string') continue;
      const parts = c.split(/[\\/]+/).filter(Boolean);
      const i = parts.lastIndexOf('skills'), k = parts.lastIndexOf('agents');
      if (i >= 0 && i > k && i + 1 < parts.length) names.skills.add(parts[i + 1]);
      else if (k >= 0 && k + 1 < parts.length) names.agents.add(parts[k + 1]);
    }
  }
  return names;
}

/**
 * Qué hay en la carpeta vieja, por lado: `{ oldIsDir, skills: { where, link, realDir, harness, third, personal, dangling,
 * inPlace }, agents: {…} }`. `inPlace`: lo real que ya está en la carpeta del lado cuando ésa es una carpeta real (no se mueve
 * ni se pisa). Sólo lee.
 */
function classifyPersonal({ home, oldSkillsDir, tree, ownRoot = null }) {
  // la casa propia contra la que se compara: la del contexto (la pasa `preconditions`), o la de la `home` pedida. Nunca la
  // de quien corre (`TH.ownPaths({})`): con otra `home`, un enlace a SU `.tycon` no se reconocía como del arnés y pasaba
  // por carpeta propia del dev. Se mira como está escrita y por su ruta real (los destinos de enlace llegan ya resueltos)
  const ownAsked = ownRoot || path.join(path.resolve(home), TH.OWN_DIR_NAME);
  const underOwn = (p) => isUnder(p, ownAsked) || isUnder(p, real(ownAsked) || ownAsked);
  const third = thirdPartyNames(tree);
  const oldReal = real(oldSkillsDir);
  // la carpeta vieja puede ser una carpeta real (el clon viejo de skills) o —la transición de la 8.18— un ENLACE a un clon
  // viejo que vive en otra carpeta: ahí lo personal también se clasifica, leyendo a través del enlace (y no se mueve: se enlaza)
  const oldIsDir = isRealDir(oldSkillsDir);
  const oldIsSeparate = !oldIsDir && isLink(oldSkillsDir) && !!oldReal && isRealDir(oldReal) && oldReal !== real(tree) && !underOwn(oldReal);
  const source = oldIsDir ? oldSkillsDir : (oldIsSeparate ? oldReal : null);
  const out = { oldIsDir, oldIsSeparate, source, problems: third.problem ? [third.problem] : [] };
  for (const side of PERSONAL_SIDES) {
    const where = claudeSide(home, side);
    const r = { where, link: isLink(where), linkTarget: isLink(where) ? readlink(where) : null, realDir: isRealDir(where), own: null, harness: [], third: [], personal: [], dangling: [], inPlace: [] };
    // un enlace a una carpeta PROPIA del dev (ni la carpeta vieja ni un árbol del arnés) se trata como carpeta real: no se
    // toca, lo personal va adentro y se cuenta lo suyo como «ya en su lugar» (regla de canonical-path.js, decisión 2026-10-03)
    if (r.link) {
      const dest = real(where);
      // sólo una carpeta propia DENTRO de la carpeta de la persona: la mudanza no escribe en una carpeta del sistema porque un enlace apunte ahí
      if (dest && isRealDir(dest) && isUnder(dest, real(home) || home) && !(oldReal && isUnder(dest, oldReal)) && !isUnder(dest, real(tree) || tree) && !underOwn(dest)) r.own = dest;
      else if (dest && isRealDir(dest) && !isUnder(dest, real(home) || home)) out.problems.push(`${where} apunta fuera de tu carpeta (${dest}): no escribo ahí; lo personal va a una carpeta real en su lugar`);
    }
    let names = [];
    if (source) {
      const src = path.join(source, side);
      // una carpeta que está y no se puede leer NO es «sin personales»: se dice (ENOENT sí es «no hay ese lado»)
      try { names = fs.readdirSync(src).sort(); } catch (e) { names = []; if (e && e.code !== 'ENOENT') out.problems.push(`${src} no se pudo leer (${e.code || e.message}): lo que haya ahí no se clasifica`); }
    }
    for (const name of names) {
      if (name === '.DS_Store') continue;
      const full = path.join(source, side, name);
      if (lexists(path.join(tree, side, name))) r.harness.push(name);
      else if (third[side].has(name)) r.third.push(name);
      else { r.personal.push(name); if (isLink(full) && !fs.existsSync(full)) r.dangling.push(name); }
    }
    // lo que ya está en su lugar: lo REAL de la carpeta real (o de la propia), que no sea del arnés ni de terceros (un
    // revisor copiado o enlazado duro —Windows sin modo desarrollador— es del arnés, no del dev)
    const place = r.realDir ? where : r.own;
    if (place) { try { r.inPlace = fs.readdirSync(place).filter((n) => n !== '.DS_Store' && !isLink(path.join(place, n)) && !lexists(path.join(tree, side, n)) && !third[side].has(n)).sort(); } catch (_) { r.inPlace = []; } }
    out[side] = r;
  }
  return out;
}
const isUnder = (p, root) => { if (!p || !root) return false; const a = path.resolve(p), b = path.resolve(root); return a === b || a.startsWith(b + path.sep); };

/** La línea del plan: «conserva N skills y M agentes tuyos: …» (con cero, lo dice y no inventa nombres). */
function personalPlanLine(c) {
  const fmt = (r) => (r ? [...r.personal.map((n) => (r.dangling.includes(n) ? `${n} (enlace colgado)` : n)), ...r.inPlace.map((n) => `${n} (ya en su lugar)`)] : []);
  const s = fmt(c.skills), a = fmt(c.agents);
  const head = `  conserva ${s.length} skills y ${a.length} agente${a.length === 1 ? '' : 's'} tuyos`;
  const warn = (c.problems || []).length ? ` ⚠️ ${c.problems.join(' · ')}` : '';
  if (!s.length && !a.length) return `${head} (en la carpeta vieja no hay nada que no sea del arnés o de terceros)${warn}`;
  const place = (r) => (r && r.own ? `${r.own} (tu carpeta, por el enlace ${r.where})` : (r ? r.where : ''));
  const where = c.skills && c.agents ? `${place(c.skills)} y ${place(c.agents)}` : 'las carpetas skills y agents de Claude Code';
  const how = c.oldIsSeparate ? 'enlazados desde tu clon viejo de skills' : 'movidos desde la carpeta apartada';
  const list = [s.length ? `skills: ${s.join(', ')}` : null, a.length ? `agents: ${a.join(', ')}` : null].filter(Boolean).join(' · ');
  return `${head} (no son del arnés ni de terceros) → quedan activos en ${where} como carpetas reales (${how}), con un enlace por entrada del arnés al lado: ${list}${warn}`;
}

/** Lo que el diario guarda del plan de lo personal: sólo nombres (lo que se mueve) y si cada lado era un enlace. */
function personalPlanForJournal(c) {
  const out = { problems: [...((c && c.problems) || [])], oldIsSeparate: !!(c && c.oldIsSeparate), source: (c && c.source) || null };
  for (const side of PERSONAL_SIDES) { const r = c && c[side]; if (r) out[side] = { personal: [...r.personal], link: r.link, linkTarget: r.linkTarget, realDir: r.realDir, own: r.own }; }
  return out;
}

/**
 * La llave del perfil (AC 32): `install.home` del lector de configuración del árbol — `tycon`, `claude` (también sin
 * valor), o null si la configuración no se puede leer (una llave que no se lee no muda a nadie).
 */
function homeKey(ctx, tree, { log = null } = {}) {
  const say = (l) => { try { if (log) log(`mudanza: install.home no se pudo leer: ${l}`); } catch (_) { /* nada */ } };
  try {
    const C = require(path.join(tree, 'scripts', 'lib', 'tycon-config.js'));
    if (!(C && C.VOCABULARIO && C.VOCABULARIO.install && C.VOCABULARIO.install.home)) return 'claude';   // un lector de antes de la D: la llave no existe
    const c = (C.sinAnotar || ((f) => f()))(() => C.cargar({ home: ctx.home, env: ctx.env, arnes: tree }));
    if (c.errores && c.errores.length) { say(c.errores.map((e) => `${e.archivo || ''}${e.clave ? ` · ${e.clave}` : ''} · ${e.motivo || ''}`).join(' | ')); return null; }
    const v = c.valores && c.valores.install ? c.valores.install.home : null;
    return v === 'tycon' ? 'tycon' : 'claude';
  } catch (e) { say((e && e.message) || String(e)); return null; }
}

/**
 * Los hooks de settings.json que nombran el árbol viejo (el clon): si el aplicador del árbol nuevo ya escribió el mismo
 * guion con la ruta nueva, el viejo se saca; si no (el aplicador de Windows toma «el mismo guion» por su ruta relativa y
 * deja el comando como estaba: 182 #12395, 24 de 33 hooks seguían nombrando el clon), el comando se RE-APUNTA al árbol
 * nuevo, mismo guion y misma cuenta. Lo que no se reconoce, queda y se dice.
 */
function dropOldHooks(settingsFile, oldTreeReal, { newTree = null, log = null } = {}) {
  const s = readJson(settingsFile);
  if (!isObject(s) || !isObject(s.hooks)) return { removed: 0, repointed: 0, kept: [] };
  const oldReal = slash(oldTreeReal);
  // la carpeta que precede a `/scripts/hooks/` o `/skills/` en el comando: entre comillas puede llevar ESPACIOS (una
  // carpeta de usuario «Nombre Apellido»: el aplicador escribe la ruta entre comillas dobles; pase adversarial de la D,
  // clase 1 — con `[^"' ]` el hook ni se reconocía); sin comillas, hasta el primer espacio
  const SUB = '([\\\\/]scripts[\\\\/]hooks[\\\\/]|[\\\\/]skills[\\\\/])';
  const SUB_RXS = [new RegExp(`"([^"]+?)${SUB}`), new RegExp(`'([^']+?)${SUB}`), new RegExp(`(?:^|\\s)([^"'\\s]+?)${SUB}`)];
  const relOf = (command) => {
    // la ruta del guion: lo que viene tras `/scripts/hooks/` o `/skills/` (así se compara el MISMO guion en dos árboles)
    const m = /(\/scripts\/hooks\/|\/skills\/)([^"']+?)(?=["']|$)/.exec(slash(command));
    return m ? `${m[1]}${m[2]}` : null;
  };
  const prefixOf = (command) => { for (const rx of SUB_RXS) { const m = rx.exec(String(command)); if (m) return m[1]; } return null; };
  const isOld = (command) => { const d = prefixOf(command); if (!d) return false; const r = real(d); return Boolean(r) && slash(r) === oldReal; };
  let removed = 0, repointed = 0;
  const kept = [], dropped = [];
  for (const [event, blocks] of Object.entries(s.hooks)) {
    if (!Array.isArray(blocks)) continue;
    const all = [];
    for (const b of blocks) for (const h of (isObject(b) && Array.isArray(b.hooks) ? b.hooks : [])) if (isObject(h) && typeof h.command === 'string') all.push(h.command);
    for (const b of blocks) {
      if (!isObject(b) || !Array.isArray(b.hooks)) continue;
      b.hooks = b.hooks.filter((h) => {
        if (!isObject(h) || typeof h.command !== 'string' || !isOld(h.command)) return true;
        const rel = relOf(h.command);
        const replaced = rel && all.some((c) => c !== h.command && !isOld(c) && relOf(c) === rel);
        if (replaced) { removed++; return false; }
        if (newTree) {
          // sólo si el árbol nuevo TRAE ese guion: un hook de un clon adelantado (o de uno que la versión ya no trae)
          // apuntaría a un archivo que no existe y fallaría en cada evento (pase adversarial de la D, clase 5): se saca y se dice
          const prefix = prefixOf(h.command);
          const target = /\\/.test(prefix) ? newTree : slash(newTree);
          const there = rel ? path.join(newTree, ...rel.replace(/^\//, '').split('/')) : null;
          if (!there || !lexists(there)) { dropped.push(`${event}: ${h.command}`); removed++; return false; }
          h.command = h.command.split(prefix).join(target);
          repointed++;
          return true;
        }
        kept.push(`${event}: ${h.command}`);
        return true;
      });
    }
    s.hooks[event] = blocks.filter((b) => !(isObject(b) && Array.isArray(b.hooks) && !b.hooks.length));
  }
  if (removed || repointed) writeAtomic(settingsFile, `${JSON.stringify(s, null, 2)}\n`);
  if (log && removed) log(`mudanza: ${removed} hook(s) que nombraban el clon ${oldTreeReal} salieron de ${settingsFile} (ya tienen su reemplazo en el árbol nuevo)`);
  if (log && repointed) log(`mudanza: ${repointed} hook(s) que nombraban el clon ${oldTreeReal} pasaron a ${newTree} en ${settingsFile} (mismo guion, misma cuenta)`);
  if (log) for (const k of dropped) log(`mudanza: sacado un hook que nombraba el clon y cuyo guion la versión nueva NO trae (apuntaría a un archivo que no existe): ${k}`);
  if (log) for (const k of kept) log(`mudanza: queda un hook que nombra el clon y no tiene reemplazo en el árbol nuevo: ${k}`);
  return { removed, repointed, kept, dropped };
}

// ── el perfil del equipo (tanda G, AC 41) ──────────────────────────────────────────────────────────────────────
// La configuración se lee en cadena: variable › archivo de la máquina › perfil del equipo EN LA RAÍZ DEL ÁRBOL QUE CORRE ›
// apagado. El clon trae team-profile.json (o perfil-equipo.json, el nombre de antes); la versión bajada es la copia pública, que no lo trae (el exportador lo deja
// afuera a propósito). Sin esto, la primera máquina migrada (2026-10-08) quedó con las integraciones, el paquete de
// revisores por defecto y la política de actualización de fábrica, y nadie lo dijo como pérdida. Lo que el perfil
// declara pasa al archivo de la máquina como valores suyos; lo que la máquina ya tenía escrito gana, clave por clave.
// Tres llaves no viajan: describen la transición de los clones (update.source, update.skills_source) o son el disparador
// de esta misma mudanza (install.home), y en una versión bajada no significan nada.
const PROFILE_SKIP = Object.freeze(['update.source', 'update.skills_source', 'install.home']);
/**
 * @returns {{ status: 'read'|'absent'|'broken', file: string|null, reason?: string,
 *   moves: Array<{section,key,value}>, had: Array<{section,key,value}>, skipped: Array<{section,key,value}> }}
 *   `section` y `key` con el nombre que se escribe en el archivo (`integrations`, `engram`). Sin escribir nada.
 */
function profileFold({ ctx, oldTree, ownConfigData = null, oldConfigData = null }) {
  const none = (status, file, reason) => ({ status, file, reason, moves: [], had: [], skipped: [] });
  // sin lector no se puede saber qué dice el perfil: es una precondición (el clon está roto), nunca «sin perfil»
  let TC;
  try { TC = require('../../lib/tycon-config.js'); } catch (e) { return none('broken', null, `el lector de configuración del clon no carga (${(e && e.code) || e.message})`); }
  if (typeof TC.leerPerfil !== 'function') return none('broken', null, 'el lector de configuración del clon no sabe leer el perfil solo (es de antes de la tanda G)');
  const r = TC.leerPerfil({ arnes: oldTree, home: ctx.home, env: ctx.env });
  if (r.estado === 'roto') return none('broken', r.ruta, `${r.ruta}: ${r.errores.map((e) => `${e.clave ? `${e.clave} · ` : ''}${e.motivo}`).join(' | ')}`);
  if (r.estado === 'anulado') return none('absent', null, 'TYCON_PROFILE=0: esta máquina corre sin perfil del equipo');
  if (r.estado !== 'leido') return none('absent', r.ruta);
  // lo que la máquina ya tiene escrito: su archivo propio (~/.tycon/config.json) y el viejo (tycon.json), con los nombres de hoy
  const has = (data, section, key) => isObject(data) && isObject(data[section]) && Object.prototype.hasOwnProperty.call(data[section], key);
  // un archivo de la máquina con un nombre viejo y el nuevo con valores distintos es configuración ROTA: precondición
  // fallida con el motivo, no una excepción suelta en el plan (pase adversarial de la tanda G, clase 7)
  let own, old;
  try {
    own = isObject(ownConfigData) ? sectionsOfToday(ownConfigData, ctx) : {};
    old = isObject(oldConfigData) ? sectionsOfToday(oldConfigData, ctx) : {};
  } catch (e) { return none('broken', r.ruta, `la configuración de la máquina no se puede fundir: ${(e && e.message) || e}`); }
  const moves = [], had = [], skipped = [];
  for (const e of r.entradas) {
    const item = { section: e.seccion, key: e.clave, value: e.valor };
    if (PROFILE_SKIP.includes(`${e.seccion}.${e.clave}`)) skipped.push(item);
    else if (has(own, e.seccion, e.clave) || has(old, e.seccion, e.clave)) had.push(item);
    else moves.push(item);
  }
  skipped.sort((a, b) => PROFILE_SKIP.indexOf(`${a.section}.${a.key}`) - PROFILE_SKIP.indexOf(`${b.section}.${b.key}`));
  return { status: 'read', file: r.ruta, moves, had, skipped };
}
/** Un valor del perfil dicho para una persona (los nombres del archivo, nunca los internos). */
function profileItem(m) {
  const k = `${m.section}.${m.key}`;
  if (m.section === 'integrations') return m.value === 'detect' ? `${m.key} detect` : (m.value === true ? m.key : `${m.key} apagada`);
  if (k === 'update.channel') return `canal ${m.value}`;
  if (k === 'update.apply') return `aplicación ${m.value}`;
  if (k === 'packs.default') return `paquete del stack ${m.value}`;
  if (k === 'install.profile') return `perfil ${m.value}`;
  return k;
}
/** La línea del plan (`--dry-run`). */
function profileFoldLine(f, newConfig) {
  if (!f || f.status === 'broken') return `  perfil del equipo: ${f ? f.reason : 'no se miró'}`;
  // con repo del equipo declarado (story 8.25, AC 13), el perfil llega por la capa con origen «perfil» y no se funde
  if (f.status === 'skipped') return `  perfil del equipo: ${f.reason}`;
  if (f.status !== 'read') return `  perfil del equipo: ${f.reason ? f.reason : 'el clon no trae team-profile.json (ni perfil-equipo.json, el nombre de antes)'} — nada que pasar (la máquina sigue con lo que tenga escrito)`;
  const parts = [f.moves.length ? f.moves.map(profileItem).join(', ') : 'nada nuevo (la máquina ya lo tenía todo escrito)'];
  if (f.had.length) parts.push(`ya tenías: ${f.had.map(profileItem).join(', ')} (gana lo tuyo)`);
  if (f.skipped.length) parts.push(`no viajan: ${f.skipped.map((m) => `${m.section}.${m.key}`).join(', ')}`);
  return `  perfil del equipo: ${f.file} → ${newConfig}, como valores de la máquina (la versión bajada no trae el perfil): ${parts.join(' · ')}`;
}

// ── las precondiciones (AC 27): nada se escribe, ni el registro ─────────────────────────────────�

/**
 * @returns {{ ok: true, p, repo, target, channel, tools, oldConfigData, ownConfigData, notes: string[] } | { ok: false, code, line, precondition: true }}
 */
function preconditions(ctx, state, H) {
  const bad = (line, code = 1) => ({ ok: false, code, line, precondition: true });
  if (S.isRelease(state)) return { ok: false, code: 0, line: `${HEAD}: esta máquina ya vive en ${ownOf(ctx).root} (versión bajada): nada que mudar`, already: true };
  if (!state.tree || !real(state.tree)) return bad(`${HEAD}: el estado apunta a un árbol que no está (${state.tree}): no sé desde qué clon mudar`);
  if (state.mode === 'developer') return bad(`${HEAD}: la máquina está en modo desarrollador (${state.tree}): primero harness.js link --managed`);
  const p = places(ctx, state.tree);
  // ~/.tycon libre o nuestro
  if (lexists(p.own.root)) {
    if (!isRealDir(p.own.root)) return bad(`${HEAD}: ${p.own.root} existe y no es una carpeta: no es nuestra`);
    const foreign = fs.readdirSync(p.own.root).filter((e) => !OWN_ENTRIES.includes(e) && e !== '.DS_Store');
    if (foreign.length) return bad(`${HEAD}: ${p.own.root} no es nuestra: trae ${foreign.join(', ')} — movelo o borralo y volvé a correr`);
    if (TH.livesInOwnHome(ctx.home) && !TH.ownHomeStale(ctx.home)) return bad(`${HEAD}: ${p.newStateDir} ya tiene un estado del arnés y esta máquina corre desde un clon: dos arneses en la misma máquina — mirá harness.js doctor`);
  }
  // la configuración de la máquina y la propia tienen que leerse. Un `tycon.json` que es un ENLACE cuenta igual, salvo que
  // ya apunte a la configuración propia (una mudanza anterior): se lee a través del enlace (pase adversarial de la D, clase 9)
  let oldConfigData = null;
  if (configPending(p)) {
    const t = readText(p.oldConfig);
    oldConfigData = t === null ? undefined : readJson(p.oldConfig);
    if (!isObject(oldConfigData)) return bad(`${HEAD}: ${p.oldConfig} no se lee como JSON: arreglalo antes de mudar (es tu configuración; se funde en ${p.newConfig})`);
  }
  let ownConfigData = null;
  if (lexists(p.newConfig)) {
    ownConfigData = readJson(p.newConfig);
    if (!isObject(ownConfigData)) return bad(`${HEAD}: ${p.newConfig} no se lee como JSON: arreglalo antes de mudar`);
  }
  // qué herramientas enchufa esta máquina: lo registrado, o lo de siempre
  const tools = T.plugged(state, { home: ctx.home, env: ctx.env });
  // el repo de GitHub y la versión del canal, con la credencial (la única red: mirar)
  const repo = REL.repoOf({ tree: state.tree, option: ctx.opts.repo || null });
  if (repo.problem) return bad(`${HEAD}: ${repo.problem}`);
  // el repo del equipo (story 8.25, AC 13): `--team`, o la clave `team` del public-repos.json del clon; su forma, antes de la red
  const TEAM = require('./team.js');
  const teamRepo = TEAM.teamOf({ option: ctx.opts.team, cloneTree: state.tree });
  if (teamRepo.problem) return bad(`${HEAD}: ${teamRepo.problem}`, teamRepo.code || 1);   // una opción mal escrita es 2, como en install; el archivo del clon roto, 1
  const c = REL.client(ctx);
  if (c.tokenProblem) return bad(`${HEAD}: ${c.tokenProblem}`);
  const teamSrc = teamRepo.repo ? TEAM.parseTeam(teamRepo.repo) : null;
  if (teamSrc && teamSrc.ok && teamSrc.host === 'github') c.repos = [repo.repo, teamRepo.repo];
  const policy = H.policyOf(ctx, state.tree);
  if (policy.errors.length) return bad(`${HEAD}: la política de actualización está mal escrita (${policy.errors[0]}): arreglala antes de mudar`);
  const channel = policy.channel || 'stable';
  const t = REL.resolveChannel(c, repo.repo, channel);
  if (t.status !== 'ok') return bad(`${HEAD}: ${t.reason}`);
  if (!t.version || !VO.isOrdered(t.version)) return bad(`${HEAD}: la punta de ${t.ref} (${sha7(t.commit)}) ${t.version ? `trae un número sin forma («${t.version}»)` : 'no trae version.json'}: no se muda a una versión sin número`);
  // Windows: nadie con los archivos del lugar viejo tomados (una prueba de rename, atómica, y vuelta)
  if (ctx.platform === 'win32' && isRealDir(p.oldStateDir)) {
    const probe = `${p.oldStateDir}.probe-${process.pid}`;
    try { fs.renameSync(p.oldStateDir, probe); fs.renameSync(probe, p.oldStateDir); } catch (e) {
      if (lexists(probe) && !lexists(p.oldStateDir)) { try { fs.renameSync(probe, p.oldStateDir); } catch (_) { /* queda dicho */ } }
      return bad(`${HEAD}: alguien tiene tomados los archivos de ${p.oldStateDir} (${e.code || e.message}): cerrá las sesiones de Claude Code y Codex y volvé a correr`);
    }
  }
  // lo personal de la carpeta vieja (tanda F, AC 40): se clasifica acá, sin escribir, para el plan y para el diario
  const personal = classifyPersonal({ home: ctx.home, oldSkillsDir: p.skillsLink, tree: state.tree, ownRoot: p.own.root });
  // el perfil del equipo del clon (tanda G, AC 41): roto es una precondición fallida, nunca «sin perfil» (8.3 AC 2)
  let profile = profileFold({ ctx, oldTree: state.tree, ownConfigData, oldConfigData });
  if (profile.status === 'broken') return bad(`${HEAD}: el perfil del equipo del clon no se puede leer — ${profile.reason}: arreglalo antes de mudar (la mudanza pasa sus valores a ${p.newConfig})`);
  // la capa del equipo (story 8.25, AC 13): se resuelve y valida acá, sin escribir (la red ya se usó para mirar el canal); sin
  // acceso o sin validar, la mudanza no arranca. Con capa, el perfil del clon NO se funde: llega por la capa con origen «perfil»
  let teamPlan = null;
  let teamOpen = null;
  if (teamRepo.repo) {
    // la fuente según su forma (GitHub o Azure DevOps): sin la credencial de Azure, la mudanza no arranca y lo dice
    teamOpen = TEAM.openSource(teamRepo.repo, { ctx, deadlineAt: Date.now() + Math.max(60, Number(ctx.env.TYCON_RELEASE_DOWNLOAD_BUDGET_S) > 0 ? Number(ctx.env.TYCON_RELEASE_DOWNLOAD_BUDGET_S) : 120) * 1000, publicRepo: repo.repo });
    if (!teamOpen.ok) return bad(`${HEAD}: ${teamOpen.reason}`, teamOpen.code || 1);
    // el perfil y team-repos.json de la capa NO se juzgan con los lectores del clon: el clon no es la versión que va a quedar
    // (uno viejo ni siquiera trae scripts/lib/team-repos.js, y la mudanza no arrancaba nunca). Acá se mira todo lo demás —el
    // acceso, la lista cerrada, la declaración, los nombres—; esos dos se juzgan en la mudanza, con los lectores de la versión
    // recién bajada y antes de escribir nada (como update), y `--dry-run` lo dice en el plan
    teamPlan = teamOpen.resolve({ version: t.version, readerTree: null, deferReaders: true, home: ctx.home, env: ctx.env });
    if (!teamPlan.ok) return bad(`${HEAD}: ${teamPlan.reason}`);
    profile = { status: 'skipped', file: profile.file, reason: `viaja en la capa del equipo (${teamRepo.repo}), no se funde en ${p.newConfig} (los valores quedan con origen perfil)`, moves: [], had: [], skipped: [] };
  }
  return { ok: true, p, repo, target: t, channel, policy, tools, oldConfigData, ownConfigData, personal, profile, teamPlan, teamOpen, notes: t.note ? [t.note] : [] };
}

/** El plan (`--dry-run`), para una persona. */
function planLines(ctx, pre) {
  const { p, repo, target, channel, tools } = pre;
  const L0 = [`mudanza a ${p.own.root} (versión ${target.version}, ${target.ref} ${sha7(target.commit)} de ${repo.url}; canal ${channel}):`];
  L0.push(`  instala: ${p.own.harness} — la versión bajada, sin git · el clon ${p.oldTree} no se toca: queda donde está (para que esta máquina lo mantenga: harness.js config set paths.maintained ${p.oldTree})`);
  const moves = [`${p.oldStateDir} → ${p.newStateDir} (el estado, las copias de seguridad en ${p.newBackups})`];
  if (pre.oldConfigData) moves.push(`${p.oldConfig} → ${p.newConfig} (la configuración, fundida: lo que ya está en la nueva gana; la vieja queda como enlace)`);
  L0.push(`  mueve: ${moves.join(' · ')}`);
  L0.push(profileFoldLine(pre.profile, p.newConfig));
  if (pre.teamPlan) L0.push(`  ${require('./team.js').planLine(pre.teamPlan)} → apilada en ${p.own.harness} antes del cambio`);
  const deferred = pre.teamPlan && Array.isArray(pre.teamPlan.readersDeferred) ? pre.teamPlan.readersDeferred : [];
  if (deferred.length) L0.push(`  valida: ${deferred.join(' y ')} de la capa con los lectores de la versión ${target.version} (la que baja), al mudar y antes de escribir nada — si esa versión los rechaza, la mudanza no arranca`);
  // la conexión vieja de una skill de la lista fija (tanda A2c · AC 35): el plan anticipa qué se copiaría (la carpeta vieja de
  // skills, si es real, es la que la mudanza va a apartar)
  if (pre.teamPlan) {
    try {
      const plan = require('./team.js').moveSkillData({ home: ctx.home, env: ctx.env, dryRun: true, team: {}, layerPaths: pre.teamPlan.files.map((f) => f.path), migrateHome: { from: [p.oldTree, pre.personal && pre.personal.oldIsSeparate ? pre.personal.source : null].filter(Boolean), aside: isRealDir(p.skillsLink) ? p.skillsLink : null }, previousDir: p.own.previous });
      for (const l of plan.lines) L0.push(`  datos: ${l}`);
    } catch (e) { L0.push(`  datos: no pude anticipar la conexión vieja de las skills de la lista fija (${(e && e.message) || e}): la mudanza lo vuelve a mirar y lo dice`); }
  }
  if (isRealDir(p.dashboard)) L0.push(`  copia: ${p.dashboard} → ${p.newDashboard} (lo escrito por los nocturnos; el clon lo conserva)`);
  const links = [`${p.placeLink} → ${p.own.harness}${isRealDir(p.placeLink) ? ' (es una carpeta real: no se pisa, queda y se dice)' : ''}`];
  if (lexists(p.legacyLink)) links.push(`${p.legacyLink} → ${p.own.harness}${isRealDir(p.legacyLink) ? ' (es una carpeta real: no se pisa)' : ''}`);
  links.push(`${p.skillsLink} → ${p.own.harness}${isRealDir(p.skillsLink) ? ` (el clon viejo de skills se aparta a ${p.skillsLink}.before-migrate-<sello>, no se borra)` : ''}`);
  links.push(`${p.oldStateDir} → ${p.newStateDir}`);
  L0.push(`  enlace: ${links.join(' · ')}`);
  if (pre.personal) L0.push(personalPlanLine(pre.personal));
  const plug = [`${T.names(tools)} — los hooks pasan a ${p.own.harness}; los que nombraban el clon se sacan (misma cuenta)`];
  if (tools.includes('codex')) plug.push('Codex te va a pedir aprobar sus hooks una vez (cambian de ruta)');
  L0.push(`  enchufa: ${plug.join(' · ')}`);
  L0.push('  el estado se escribe al final; cortada, el arranque siguiente la completa o la deshace desde el diario');
  return L0;
}

// ── las etapas (cada una idempotente: mira el disco antes de actuar) ─────────────────────────────�

function stageStateMoved(ctx, j, log) {
  const p = places(ctx, j.oldTree);
  if (isRealDir(p.oldStateDir) && !lexists(p.newStateDir)) {
    moveDir(p.oldStateDir, p.newStateDir);
    log(`mudanza: ${p.oldStateDir} → ${p.newStateDir}`);
  }
  if (!lexists(p.newStateDir)) fs.mkdirSync(p.newStateDir, { recursive: true });
  if (!lexists(p.oldStateDir)) { linkDir(p.newStateDir, p.oldStateDir, ctx.platform); log(`mudanza: ${p.oldStateDir} queda como enlace a ${p.newStateDir}`); }
  const oldBackups = path.join(p.newStateDir, 'harness', 'backups');
  if (isRealDir(oldBackups) && !lexists(p.newBackups)) { moveDir(oldBackups, p.newBackups); j.backupsMoved = true; log(`mudanza: las copias de seguridad en ${p.newBackups}`); }
}

/** ¿La configuración vieja está por fundir? Existe y no es ya un enlace a la propia (una mudanza anterior la dejó así). */
function configPending(p) {
  if (!lexists(p.oldConfig)) return false;
  if (!isLink(p.oldConfig)) return true;
  const target = real(p.oldConfig);
  return Boolean(target) && target !== real(p.newConfig) && target !== p.newConfig;
}
// los nombres viejos de sección que la configuración sigue aceptando viven en el mapa de renombres (scripts/lib/renames.json,
// story 8.9) y los traduce legacy-names.js, el mismo lector que usa tycon-config: al fundir dos archivos, el viejo puede
// traer una sección con su nombre viejo y el nuevo con el de hoy; con las dos formas en un archivo, tycon-config lo rechaza
// como roto (pase adversarial de la D, clase 12). Acá cada archivo se pasa al nombre de hoy ANTES de fundir (y el uso del
// nombre viejo queda anotado en la máquina, como cualquier otro)
function sectionsOfToday(obj, ctx) {
  const LN = require('../../lib/legacy-names.js');
  const TC = require('../../lib/tycon-config.js');
  // en TODOS los niveles (readKeysDeep): también las claves de adentro de una sección (nocturnos → nightly, buzon → mailbox).
  // Con un solo nivel, un valor de la máquina escrito con el nombre viejo no contaba como «ya lo tenía», el perfil se
  // escribía al lado con el nombre nuevo y el archivo quedaba roto para todo lector (pase adversarial de la tanda G,
  // clases 1/3/4/9). Las dos formas con valores distintos tiran LegacyNamesError: quien llama lo trata como configuración rota
  return LN.readKeysDeep(obj, TC.DONDE_CLAVES, { home: ctx.home });
}
function stageConfigMoved(ctx, j, log) {
  const p = places(ctx, j.oldTree);
  const pending = configPending(p);
  // el perfil del equipo del clon (tanda G, AC 41): lo que declara y la máquina no tiene escrito pasa como valor suyo;
  // también cuando no hay tycon.json viejo que fundir
  const fold = j.profileFold && j.profileFold.status === 'read' && Array.isArray(j.profileFold.moves) ? j.profileFold.moves : [];
  if (!pending && !fold.length) return;
  let old = {};
  if (pending) {
    const old0 = readJson(p.oldConfig);
    // se comprobó en las precondiciones; si dejó de leerse en el medio no se funde lo que no se lee, y tampoco se sigue
    // en silencio: es un fallo DURANTE (la mudanza se deshace y lo dice), no una etapa que «pasó»
    if (!isObject(old0)) throw new Error(`${p.oldConfig} dejó de leerse como JSON durante la mudanza: no fundo lo que no se lee`);
    old = sectionsOfToday(old0, ctx);
  }
  // la propia que existe y no se lee NO es «vacía»: pisarla perdería el permiso de GitHub (cazador de fallos silenciosos,
  // vuelta 2: el mismo caso que el tycon.json viejo, en el otro archivo)
  let own = {};
  if (lexists(p.newConfig)) {
    const own0 = readJson(p.newConfig);
    if (!isObject(own0)) throw new Error(`${p.newConfig} no se lee como JSON: no fundo nada encima`);
    own = sectionsOfToday(own0, ctx);
  }
  const merged = {};
  const put = (k, v, win) => {
    if (isObject(v) && isObject(merged[k])) merged[k] = win ? Object.assign({}, merged[k], v) : Object.assign({}, v, merged[k]);
    else if (!(k in merged) || win) merged[k] = isObject(v) ? Object.assign({}, v) : v;
  };
  for (const [k, v] of Object.entries(old)) put(k, v, false);
  for (const [k, v] of Object.entries(own)) put(k, v, true);
  let folded = 0;
  for (const m of fold) {
    if (!isObject(merged[m.section])) merged[m.section] = {};
    if (!Object.prototype.hasOwnProperty.call(merged[m.section], m.key)) { merged[m.section][m.key] = m.value; folded++; }
  }
  j.profileFolded = folded;
  // desde acá el disco cambia: si la etapa falla justo después (o el fallo de prueba la corta antes de anotarse en el
  // diario), el deshacer tiene que reponer la configuración aunque la etapa no haya quedado anotada (lo destapó T28y)
  j.configTouched = true;
  writeJson(p.newConfig, merged, 0o600);
  if (folded) log(`mudanza: perfil del equipo: ${folded} valor(es) de ${j.profileFold.file} pasaron a ${p.newConfig} como valores de la máquina (la versión bajada no trae el perfil)`);
  if (!pending) return;
  fs.unlinkSync(p.oldConfig);
  try { fs.symlinkSync(p.newConfig, p.oldConfig, 'file'); log(`mudanza: ${p.oldConfig} fundida en ${p.newConfig}; la vieja queda como enlace`); } catch (e) {
    // sin permiso para un enlace de archivo (Windows): queda una copia, que el freno viejo lee igual — con el mismo modo
    // 0600: adentro viaja el permiso de GitHub (revisor de seguridad de la D)
    writeJson(p.oldConfig, merged, 0o600);
    log(`mudanza: ${p.oldConfig} fundida en ${p.newConfig}; no pude dejar la vieja como enlace (${e.code || e.message}): queda una copia`);
  }
}

function stageDashboardCopied(ctx, j, log) {
  const p = places(ctx, j.oldTree);
  if (!isRealDir(p.dashboard)) return;
  fs.cpSync(p.dashboard, p.newDashboard, { recursive: true, force: true });
  j.dashCopied = true;
  log(`mudanza: ${p.dashboard} copiado a ${p.newDashboard} (el clon lo conserva)`);
}

function stageLinks(ctx, j, H, log) {
  const p = places(ctx, j.oldTree);
  const notes = [];
  // el lugar: lo asegura la biblioteca del árbol NUEVO (una carpeta real no se pisa: queda, y se dice)
  if (isRealDir(p.placeLink)) notes.push(`${p.placeLink} es una carpeta real (el clon vive ahí): queda; el arnés corre desde ${p.own.harness} igual`);
  else {
    const l = H.ensureLink(ctx, p.own.harness, { link: p.own.harness, prefer: p.own.harness });
    if (!l.ok) notes.push(`no pude re-apuntar ${p.placeLink}: ${l.out || l.err}`);
    else log(`mudanza: ${p.placeLink} → ${p.own.harness}`);
  }
  if (isLink(p.legacyLink)) { linkDir(p.own.harness, p.legacyLink, ctx.platform); log(`mudanza: ${p.legacyLink} → ${p.own.harness}`); }
  // agent-skills: enlace → se re-apunta; carpeta real (el clon viejo de skills) → se aparta con sello y en su lugar va el enlace
  if (isRealDir(p.skillsLink)) {
    const aside = `${p.skillsLink}.before-migrate-${stamp()}`;
    fs.renameSync(p.skillsLink, aside);
    j.links.skills.aside = aside;
    log(`mudanza: ${p.skillsLink} era una carpeta real: apartada a ${aside} (no se borra)`);
  }
  if (!lexists(p.skillsLink) || isLink(p.skillsLink)) { linkDir(p.own.harness, p.skillsLink, ctx.platform); log(`mudanza: ${p.skillsLink} → ${p.own.harness}`); }
  j.notes = [...(j.notes || []), ...notes];
}

/**
 * Lo personal queda activo (tanda F, AC 40): por lado, si la carpeta del lado era un enlace se saca y nace la carpeta real; lo
 * personal se mueve desde la carpeta apartada (rename, nada se copia dos veces); lo que ya existía en destino no se pisa.
 * Idempotente: cortada a mitad y repetida, lo ya movido se reconoce (no está en el origen, está en el destino). El enlace
 * por entrada del arnés y de terceros lo pone esta misma etapa, con la regla de la carpeta real del instalador (abajo); los
 * nombres que puso quedan en el diario (`linksAdded`) para que el deshacer saque sólo esos.
 */
/** Un enlace a `target` en `link`: de carpeta (unión en Windows) si el destino es una carpeta; de archivo si no (o si no está). */
function linkEntry(target, link, platform) {
  // un destino que no está (ENOENT) es un enlace colgado a propósito: de archivo; cualquier otro error al mirarlo (permiso,
  // un bucle de enlaces) sube: es un fallo DURANTE, no «un archivo»
  let dir = false; try { dir = fs.statSync(target).isDirectory(); } catch (e) { if (e && e.code !== 'ENOENT') throw e; dir = false; }
  if (dir) linkDir(target, link, platform); else fs.symlinkSync(target, link, 'file');
}
/** El destino de lo personal de un lado: la carpeta propia a la que apunta el enlace, o la carpeta del lado de Claude Code. */
const personalDest = (ctx, side, rec) => (rec && rec.own && isRealDir(rec.own) ? rec.own : claudeSide(ctx.home, side));

function stagePersonal(ctx, j, log) {
  const plan = j.personalPlan || {};
  const aside = j.links && j.links.skills && j.links.skills.aside;
  // de dónde sale lo personal: la carpeta apartada (agent-skills era una carpeta real: se MUEVE) o el clon viejo que vive
  // aparte (agent-skills era un enlace a él, la transición de la 8.18: se ENLAZA; de un clon ajeno a la mudanza no se saca nada)
  const separate = plan.oldIsSeparate && plan.source && isRealDir(plan.source) ? plan.source : null;
  const source = separate || (aside && isRealDir(aside) ? aside : null);
  // dónde estaba la carpeta vieja ANTES de apartarla: los enlaces relativos de lo personal se resolvían desde ahí
  const oldPlace = places(ctx, j.oldTree).skillsLink;
  j.personal = j.personal || {};
  for (const side of PERSONAL_SIDES) {
    const ps = plan[side] || {};
    const names = Array.isArray(ps.personal) ? ps.personal : [];
    if (!names.length) continue;
    if (!source) { log(`mudanza: no hay de dónde traer lo personal de ${side} (ni carpeta apartada ni clon viejo): queda donde estaba`); continue; }
    const where = claudeSide(ctx.home, side);
    const rec = j.personal[side] || (j.personal[side] = { link: ps.linkTarget || null, created: false, own: ps.own || null, moved: [], linked: [], kept: [], relinked: {}, linksAdded: [] });
    let dest = where;
    if (rec.own && isRealDir(rec.own)) dest = rec.own;   // un enlace a tu carpeta propia: no se toca, lo personal va adentro
    else {
      // lo que hace falta para deshacer (el destino del enlace viejo, si la carpeta la creó esta mudanza) va al diario ANTES de tocar el disco
      if (isLink(where)) { rec.link = rec.link || readlink(where); writeJson(journalPath(ctx), j, 0o600); fs.unlinkSync(where); }
      if (!lexists(where)) { rec.created = true; writeJson(journalPath(ctx), j, 0o600); fs.mkdirSync(where, { recursive: true }); }
      else if (!rec.created && ps.link && isRealDir(where) && !fs.readdirSync(where).filter((n) => n !== '.DS_Store').length) rec.created = true;   // reanudada tras un corte: la carpeta vacía la creó esta mudanza
      if (!isRealDir(where)) { log(`mudanza: ${where} no es una carpeta: lo personal de ${side} queda en ${source}`); continue; }
    }
    for (const name of names) {
      const from = path.join(source, side, name), to = path.join(dest, name);
      if (rec.moved.includes(name) || rec.linked.includes(name)) continue;
      if (!lexists(from)) { if (lexists(to)) (separate ? rec.linked : rec.moved).push(name); continue; }
      if (lexists(to)) {
        // en el destino, un enlace por entrada colgado o que apunta a la carpeta vieja (ya apartada) se reemplaza; lo real, o un
        // enlace vivo que no es de la mudanza, no se pisa: queda en el origen y se dice
        const txt = isLink(to) ? (readlink(to) || '') : '';
        const stale = isLink(to) && (!fs.existsSync(to) || (oldPlace && isUnder(path.isAbsolute(txt) ? txt : path.resolve(path.dirname(to), txt), oldPlace)) || isUnder(real(to) || '', source));
        if (stale) fs.unlinkSync(to);
        else { if (!rec.kept.includes(name)) rec.kept.push(name); log(`mudanza: ${to} ya existe: ${side}/${name} queda en ${source}`); continue; }
      }
      if (separate) { linkEntry(from, to, ctx.platform); rec.linked.push(name); continue; }
      if (isLink(from)) {
        // un enlace se muda con su SENTIDO, no con su texto: lo que apuntaba se resuelve desde donde estaba (relativo → desde la
        // carpeta vieja; adentro de la carpeta vieja → ahora en la apartada) y se escribe absoluto; uno colgado sigue colgado
        const txt = readlink(from);
        if (txt === null || txt === '') {
          // un enlace que no se puede leer no se reescribe (una cadena vacía apuntaría a la carpeta entera): se muda tal cual y se dice
          const w = `${side}/${name} es un enlace que no pude leer: lo muevo tal cual (puede cambiar de destino) — revisalo en ${dest}`;
          log(`mudanza: ${w}`); j.notes = [...(j.notes || []), w];
          fs.renameSync(from, to); rec.moved.push(name); continue;
        }
        let abs = path.isAbsolute(txt) ? txt : path.resolve(oldPlace, side, txt);
        if (oldPlace && isUnder(abs, oldPlace)) {
          // adentro de la carpeta vieja: a una hermana personal que también se muda → su lugar nuevo; a algo del arnés → la
          // versión instalada; lo demás → la carpeta apartada
          const rel = path.relative(oldPlace, abs), parts = rel.split(path.sep);
          const harnessNow = path.join(places(ctx, j.oldTree).own.harness, rel);
          if (parts[0] === side && names.includes(parts[1])) abs = path.join(dest, ...parts.slice(1));
          else if (lexists(harnessNow)) abs = harnessNow;
          else abs = path.join(source, rel);
        }
        rec.relinked[name] = txt;
        fs.unlinkSync(from);
        linkEntry(abs, to, ctx.platform);
        rec.moved.push(name); continue;
      }
      fs.renameSync(from, to); rec.moved.push(name);
    }
    log(`mudanza: ${rec.moved.length + rec.linked.length} ${side} tuyo(s) → ${dest} (carpeta real; el arnés va al lado, un enlace por entrada)`);
  }
  // el enlace por entrada del arnés (y de terceros, ya repuestos en el árbol nuevo) al lado de lo personal: la misma regla
  // que aplica el instalador sobre una carpeta real o propia (canonical-path.js ensureRepoLinks, 8.7 AC 18), con el código
  // de la versión que se instala; el re-enchufe la vuelve a aplicar y la encuentra hecha
  if (PERSONAL_SIDES.some((side) => j.personal[side] && (j.personal[side].moved.length || j.personal[side].linked.length))) {
    const p = places(ctx, j.oldTree);
    let CP = null;
    for (const f of [path.join(p.own.harness, 'scripts', 'lib', 'canonical-path.js'), path.join(__dirname, '..', '..', 'lib', 'canonical-path.js')]) {
      try { CP = require(f); break; } catch (_) { CP = null; }
    }
    if (!CP || typeof CP.ensureRepoLinks !== 'function') { log('mudanza: sin canonical-path.js: el enlace por entrada del arnés lo pone el aplicador al re-enchufar'); return; }
    // lo que había antes en cada destino, para anotar en el diario qué entradas puso ESTA mudanza (el deshacer saca sólo esas:
    // enlaces, o enlaces duros en Windows sin modo desarrollador, que son archivos comunes)
    const before = {};
    for (const side of PERSONAL_SIDES) { const d = personalDest(ctx, side, j.personal[side]); try { before[side] = new Set(fs.readdirSync(d)); } catch (_) { before[side] = null; } }
    const r = CP.ensureRepoLinks({ clone: p.own.harness, home: ctx.home, only: 'entries' });
    for (const l of r.lines || []) {
      log(`mudanza: ${l}`);
      // un enlace por entrada que no se pudo poner no es «conservado y listo»: viaja a la salida final, no sólo al registro
      if (/^⚠️/.test(l)) j.notes = [...(j.notes || []), `lo personal quedó activo, pero ${l.replace(/^⚠️\s*tycon:\s*/, '')}`];
    }
    if (!r.applies) { const w = `${p.own.harness} no trae skills/tycon-pipeline y agents/: sin enlaces por entrada que poner`; log(`mudanza: ${w}`); j.notes = [...(j.notes || []), w]; }
    for (const side of PERSONAL_SIDES) {
      if (!before[side] || !j.personal[side]) continue;
      const d = personalDest(ctx, side, j.personal[side]);
      let now = []; try { now = fs.readdirSync(d); } catch (_) { now = []; }
      j.personal[side].linksAdded = now.filter((n) => !before[side].has(n)).sort();
    }
  }
}

/** Re-enchufa desde el árbol nuevo y deja el estado listo (en memoria). `{ ok, reason, state }`. */
function stageReplugged(ctx, j, H, log, { snap = null } = {}) {
  const p = places(ctx, j.oldTree);
  const read = S.read(ctx.home);
  if (read.status !== 'ok') return { ok: false, reason: `no pude leer el estado para re-enchufar: ${S.fail(read, { home: ctx.home }).line}` };
  const state = read.state;
  const manifest = REL.readManifest(p.own.harness);
  if (!manifest) return { ok: false, reason: `${p.own.harness} no trae su manifiesto: la versión no quedó entera` };
  const repoInfo = { url: j.repo, repo: j.repoName };
  const tools = Array.isArray(j.tools) && j.tools.length ? j.tools : T.plugged(state, { home: ctx.home, env: ctx.env });
  state.tree = p.own.harness;
  state.sources = [REL.makeSource({ repoInfo, ref: j.ref, commit: j.commit, tree: manifest.tree, version: j.version })];
  state.source = 'public';
  state.mode = 'managed';
  state.version = Object.assign({}, state.version || {}, { number: j.version });
  state.tools = [...tools];
  state.layer = null; state.migration = null; state.migration_hold = null; state.hold = null;
  // la capa del equipo apilada en la mudanza queda en el estado (story 8.25, AC 13); sin capa, null (como hoy)
  state.team = j.team && j.team.commit ? j.team : null;
  const policy = H.policyOf(ctx, p.own.harness);
  if (!policy.errors.length) { state.policy = { channel: policy.channel, apply: policy.apply, enabled: policy.enabled }; H.applyPolicy(ctx, state, policy); }
  H.copyBootstrap(ctx, p.own.harness, state, { version: j.version });
  // `hooksPath`: la carpeta global de hooks de git, si git no tiene ninguna (2026-10-14: una máquina mudada quedaba con los
  // hooks del arnés en ~/.git-hooks y git sin mirarlos — el freno antes de publicar no corría)
  const a = H.runApplier(ctx, p.own.harness, { log, snapshotDir: snap && snap.dir, tools, force: true, hooksPath: true });
  state.last_apply = nowIso();
  if (!a.ok) return { ok: false, reason: `el aplicador del árbol nuevo falló (${a.reason})`, state };
  dropOldHooks(H.settingsPath(ctx), p.oldTreeReal, { newTree: p.own.harness, log });
  for (const w of a.warnings || []) j.notes = [...(j.notes || []), w];
  H.recordPieces(ctx, state, a.report, a.shared);
  { const hp = H.noteHooksPath(state, a); if (hp) j.notes = [...(j.notes || []), hp]; }
  const prof = H.profileOf(ctx, p.own.harness);
  if (prof.ok) state.profile = { value: prof.value, origin: prof.origin };
  // la salud corre `doctor`, que lee el estado DEL DISCO: el que dice «clon» daría «el enlace no apunta al árbol». El
  // estado nuevo se escribe acá, justo antes (si la salud no pasa, `undo` repone el de antes, guardado en el diario)
  S.write(ctx.home, state);
  const h = H.runHealth(ctx, state, { report: a.report, applierOut: a.out, log });
  if (!h.ok) return { ok: false, reason: `la comprobación de salud no pasó (${h.failures.join(' · ')})`, state };
  state.failed = null;
  state.last_health = nowIso();
  return { ok: true, state };
}

/**
 * Avanza desde la etapa anotada en `j` hasta `done`. Devuelve `{ ok, lines, reason }`; con `ok: false` NO deshizo nada:
 * quien llama decide (fallo durante → `undo`).
 */
function advance(ctx, j, H, { log, snap = null }) {
  const from = STAGES.indexOf(j.stage);
  const after = (stage) => STAGES.indexOf(stage) > from;
  // una excepción adentro de una etapa (un rename con EPERM/EBUSY, una unión que no se pudo crear) es un fallo DURANTE, no un
  // corte: se devuelve como tal para que quien llama deshaga y anote `failed` (pase adversarial de la D, clases 10, 14 y 16)
  // `TYCON_MIGRATE_FAIL_AFTER=<etapa>` (sólo pruebas): un fallo DURANTE, justo al terminar esa etapa (quien llama deshace)
  const run = (stage, fn) => { try { fn(); if (String(ctx.env.TYCON_MIGRATE_FAIL_AFTER || '') === stage) throw new Error('fallo de prueba'); writeStage(ctx, j, stage, log); return null; } catch (e) { return `la etapa «${stage}» falló: ${(e && e.message) || e}`; } };
  let reason = null;
  if (after('state-moved')) reason = run('state-moved', () => stageStateMoved(ctx, j, log));
  if (reason) return { ok: false, reason };
  // la copia de seguridad se tomó en la carpeta vieja y se mudó con el estado: la referencia en memoria la sigue (clase 2)
  if (snap && snap.dir && !lexists(snap.dir)) { const moved = path.join(places(ctx, j.oldTree).newBackups, path.basename(snap.dir)); if (lexists(moved)) snap.dir = moved; }
  if (after('config-moved')) reason = run('config-moved', () => stageConfigMoved(ctx, j, log));
  if (reason) return { ok: false, reason };
  if (after('dashboard-copied')) reason = run('dashboard-copied', () => stageDashboardCopied(ctx, j, log));
  if (reason) return { ok: false, reason };
  if (after('links')) reason = run('links', () => stageLinks(ctx, j, H, log));
  if (reason) return { ok: false, reason };
  // la conexión vieja de una skill de la lista fija que la capa trae (story 8.25, tanda A2c · AC 35): una vez, después de la etapa
  // de enlaces (la carpeta apartada ya existe), y al reanudar no se repite (la marca queda en el diario); lo mudado va al estado
  // con la capa (j.team.data_moved). Nunca frena la mudanza: el original queda donde estaba, y un deshacer no lo necesita
  if (!j.skillData && j.team && j.team.commit) {
    try {
      const team = Object.assign({}, j.team);
      const clones = [j.oldTree, j.personalPlan && j.personalPlan.oldIsSeparate ? j.personalPlan.source : null].filter(Boolean);
      const r = require('./team.js').moveSkillData({ home: ctx.home, env: ctx.env, team, harnessDir: places(ctx, j.oldTree).own.harness, migrateHome: { from: clones, aside: j.links && j.links.skills ? j.links.skills.aside : null }, previousDir: places(ctx, j.oldTree).own.previous });
      j.team = team;
      j.notes = [...(j.notes || []), ...r.lines];
      for (const l of r.lines) log(`mudanza: ${l}`);
    } catch (e) { j.notes = [...(j.notes || []), `no pude revisar la conexión vieja de las skills de la lista fija (${e.message})`]; }
    j.skillData = true;
    writeStage(ctx, j, j.stage, log);
  }
  if (after('personal')) reason = run('personal', () => stagePersonal(ctx, j, log));
  if (reason) return { ok: false, reason };
  let state = null;
  if (after('replugged')) {
    let r;
    try { r = stageReplugged(ctx, j, H, log, { snap }); } catch (e) { r = { ok: false, reason: `la etapa «replugged» falló: ${(e && e.message) || e}` }; }
    if (!r.ok) return { ok: false, reason: r.reason };
    state = r.state;
    writeStage(ctx, j, 'replugged', log);
  }
  if (!state) {
    // cortada después de re-enchufar y antes de escribir el estado: se re-enchufa otra vez (idempotente) para tener el estado
    let r;
    try { r = stageReplugged(ctx, j, H, log, { snap }); } catch (e) { r = { ok: false, reason: `la etapa «replugged» falló: ${(e && e.message) || e}` }; }
    if (!r.ok) return { ok: false, reason: r.reason };
    state = r.state;
  }
  // done: el estado se escribe AL FINAL
  // `aside` (tanda A2c · AC 35, campo aditivo): la carpeta vieja de skills apartada, donde puede quedar la conexión de un dev
  state.migrate_home = { status: 'done', at: nowIso(), from: j.oldTree, version: j.version, ...(j.links && j.links.skills && j.links.skills.aside ? { aside: j.links.skills.aside } : {}) };
  if (state.notice && /mudanza/.test(state.notice)) state.notice = null;
  // Codex aprueba sus hooks por hash y la mudanza les cambió la ruta (AC 28): se anticipa en la salida y, para la mudanza
  // del arranque (AC 32), en el aviso que la persona ve en su próxima sesión
  const codexNote = codexReapprovalNote(state);
  if (codexNote) { j.notes = [...(j.notes || []), codexNote]; R.setNotice(state, state.notice ? `${state.notice} · ${codexNote}` : codexNote); }
  S.write(ctx.home, state);
  rmrf(journalPath(ctx));
  const p = places(ctx, j.oldTree);
  log(`mudanza: la máquina pasó a ${p.own.harness} (versión ${j.version}); el estado en ${p.newStateDir}; el clon ${j.oldTree} quedó donde estaba`);
  const pr = j.personal || {};
  const cnt = (r) => (r ? (r.moved || []).length + (r.linked || []).length : 0);
  const nS = cnt(pr.skills), nA = cnt(pr.agents);
  const kept = [...((pr.skills && pr.skills.kept) || []).map((n) => `skills/${n}`), ...((pr.agents && pr.agents.kept) || []).map((n) => `agents/${n}`)];
  const sourceOf = (j.personalPlan && j.personalPlan.oldIsSeparate && j.personalPlan.source) || (j.links && j.links.skills && j.links.skills.aside) || 'la carpeta apartada';
  const keptLine = kept.length ? `ya existían en el destino y no se pisaron: ${kept.join(', ')} (siguen en ${sourceOf})` : '';
  const lines = [
    `arnés mudado a ${p.own.harness} (versión ${j.version}, ${j.ref} ${sha7(j.commit)} de ${j.repo}) · estado en ${p.newStateDir} · configuración en ${p.newConfig}`,
    `tu clon ${j.oldTree} sigue donde estaba, sin git del mecanismo: para que esta máquina lo MANTENGA, harness.js config set paths.maintained ${j.oldTree} (y si mantenés el arnés, el clon del repo de mantenimiento se declara aparte, con paths.maintainers: de ahí leen los avisos de los nocturnos)`,
    // el perfil del equipo (tanda G): cuántos valores pasaron; sin perfil en el clon, se dice una vez (la máquina sigue con lo escrito)
    ...(j.profileFolded ? [`perfil del equipo: ${j.profileFolded} valores pasaron a ${p.newConfig} como valores de la máquina (la versión bajada no trae el perfil; lo que ya tenías escrito ganó)`] : (j.profileFold && j.profileFold.status === 'absent' ? [`perfil del equipo: ${j.profileFold.reason || 'el clon no traía team-profile.json (ni perfil-equipo.json, el nombre de antes)'} — nada pasó; la máquina sigue con lo que tenga escrito`] : (j.profileFold && j.profileFold.status === 'skipped' ? [`perfil del equipo: ${j.profileFold.reason}`] : []))),
    // la capa del equipo (story 8.25): qué quedó apilado en el árbol nuevo
    ...(j.team && j.team.commit ? [`capa del equipo ${j.team.repo} @ ${sha7(j.team.commit)}: ${j.team.files} archivo(s) (${j.team.name || 'equipo'}) en ${p.own.harness}; el estado la recuerda y update la lleva a cada versión nueva`] : []),
    ...(nS || nA ? [`conservadas ${nS} skills y ${nA} agente${nA === 1 ? '' : 's'} tuyos en ${personalDest(ctx, 'skills', pr.skills)} y ${personalDest(ctx, 'agents', pr.agents)} (carpetas reales; el arnés al lado, un enlace por entrada)${keptLine ? ` · ${keptLine}` : ''}`] : (keptLine ? [`⚠️ lo tuyo ${keptLine}`] : [])),
    // lo que no se pudo clasificar (manifiesto de terceros roto, carpeta vieja ilegible) se dice también en la corrida real
    ...((j.personalPlan && j.personalPlan.problems) || []).map((w) => `⚠️ ${w}`),
    ...(j.notes || []),
  ];
  return { ok: true, lines };
}

/** Deshace lo que el diario anotó, en orden inverso. Nunca tira; lo que no pudo queda dicho. */
function undo(ctx, j, H, { log, why }) {
  const p = places(ctx, j.oldTree);
  const say = (l) => { try { log(`mudanza: deshecha: ${l}`); } catch (_) { /* nada */ } };
  const lk = j.links || {};
  // lo personal (tanda F): vuelve a la carpeta apartada ANTES de que ésa vuelva a su lugar; la carpeta real que creó la
  // mudanza se saca si queda vacía (sacando antes los enlaces por entrada que puso ella) y el enlace viejo se repone
  {
    const pr = j.personal || {}; const plan = j.personalPlan || {};
    const aside = lk.skills && lk.skills.aside;
    const source = plan.oldIsSeparate && plan.source ? plan.source : aside;
    const oldPlace = p.skillsLink;
    // cada lado con su propio intento: si skills no vuelve, agents vuelve igual, y se dice CUÁL quedó a medias
    for (const side of PERSONAL_SIDES) try {
      const rec = pr[side]; if (!rec) continue;
      const ps = plan[side] || {};
      const where = claudeSide(ctx.home, side);
      const dest = personalDest(ctx, side, rec);
      // lo enlazado desde un clon viejo aparte: se saca el enlace, el clon no se tocó
      for (const name of rec.linked || []) { const f = path.join(dest, name); if (isLink(f)) fs.unlinkSync(f); }
      for (const name of rec.moved || []) {
        const to = path.join(dest, name), back = source ? path.join(source, side, name) : null;
        if (!back || !lexists(to) || lexists(back)) continue;
        fs.mkdirSync(path.dirname(back), { recursive: true });
        // un enlace que se reescribió absoluto vuelve con su texto de antes (relativo o adentro de la carpeta vieja), que vuelve a valer cuando la carpeta vuelve a su lugar
        if (rec.relinked && Object.prototype.hasOwnProperty.call(rec.relinked, name)) { fs.unlinkSync(to); fs.symlinkSync(rec.relinked[name], back, ctx.platform === 'win32' ? 'junction' : undefined); }
        else fs.renameSync(to, back);
      }
      // las entradas que puso ESTA mudanza (enlaces; en Windows sin modo desarrollador, enlaces duros: archivos comunes) se
      // sacan: apuntan a la versión que se va a sacar. En una carpeta real o propia preexistente, lo demás queda como estaba
      const created = rec.created || (ps.link && !rec.own && isRealDir(where) && !fs.readdirSync(where).filter((n) => n !== '.DS_Store').some((n) => !(rec.linksAdded || []).includes(n)));
      if (isRealDir(dest)) {
        const mine = new Set(rec.linksAdded || []);
        for (const n of fs.readdirSync(dest)) { const f = path.join(dest, n); const l = isLink(f); if (mine.has(n) || (created && l)) { if (l || !fs.statSync(f).isDirectory()) fs.unlinkSync(f); else rmrf(f); } }
        if (created && dest === where && !fs.readdirSync(where).filter((n) => n !== '.DS_Store').length) rmrf(where);
      }
      const oldLink = rec.link || ps.linkTarget;
      if (!rec.own && oldLink && !lexists(where)) { linkDir(oldLink, where, ctx.platform); say(`${where} → ${oldLink}`); }
      const n = (rec.moved || []).length + (rec.linked || []).length;
      if (n) say(`${n} ${side} tuyo(s) vuelven a ${source || oldPlace}`);
    } catch (e) { say(`no pude volver lo personal de ${side} (${e.message}): revisá ${claudeSide(ctx.home, side)} y ${source || 'la carpeta apartada'}`); }
  }
  // los enlaces
  try {
    if (isLink(p.placeLink) && lk.place && real(p.placeLink) === real(p.own.harness)) { linkDir(lk.place, p.placeLink, ctx.platform); say(`${p.placeLink} → ${lk.place}`); }
    if (isLink(p.legacyLink) && lk.legacy && real(p.legacyLink) === real(p.own.harness)) { linkDir(lk.legacy, p.legacyLink, ctx.platform); say(`${p.legacyLink} → ${lk.legacy}`); }
    if (lk.skills) {
      if (lk.skills.aside && lexists(lk.skills.aside)) { if (isLink(p.skillsLink)) fs.unlinkSync(p.skillsLink); if (!lexists(p.skillsLink)) fs.renameSync(lk.skills.aside, p.skillsLink); say(`${p.skillsLink} vuelve de ${lk.skills.aside}`); }
      else if (lk.skills.kind === 'link' && lk.skills.target && isLink(p.skillsLink) && real(p.skillsLink) === real(p.own.harness)) { linkDir(lk.skills.target, p.skillsLink, ctx.platform); say(`${p.skillsLink} → ${lk.skills.target}`); }
      else if (lk.skills.kind === 'absent' && isLink(p.skillsLink)) { fs.unlinkSync(p.skillsLink); say(`${p.skillsLink} no existía: se saca el enlace`); }
    }
  } catch (e) { say(`no pude volver un enlace (${e.message})`); }
  // el .dashboard copiado
  if (j.dashCopied && lexists(p.newDashboard)) { rmrf(p.newDashboard); say(`${p.newDashboard} sacado`); }
  // la configuración: sólo si la etapa llegó a fundirla (antes no se tocó). También cuando no había tycon.json viejo
  // y lo único que pasó fue el perfil del equipo (tanda G): la propia vuelve a como estaba, o a no existir
  try {
    const folded = Boolean(j.profileFold && j.profileFold.status === 'read' && Array.isArray(j.profileFold.moves) && j.profileFold.moves.length);
    // la etapa anotada, O el disco ya tocado por una etapa que falló antes de anotarse (`configTouched`, en memoria)
    if ((typeof j.oldConfigText === 'string' || folded) && (j.configTouched || STAGES.indexOf(j.stage) >= STAGES.indexOf('config-moved'))) {
      if (typeof j.oldConfigText === 'string') {
        if (lexists(p.oldConfig)) fs.unlinkSync(p.oldConfig);
        if (j.oldConfigLink) { try { fs.symlinkSync(j.oldConfigLink, p.oldConfig, 'file'); } catch (_) { writeAtomic(p.oldConfig, j.oldConfigText); } }
        else writeAtomic(p.oldConfig, j.oldConfigText);
      }
      if (typeof j.ownConfigText === 'string') writeAtomic(p.newConfig, j.ownConfigText, 0o600); else rmrf(p.newConfig);
      const left = typeof j.ownConfigText !== 'string' && lexists(p.newConfig);   // un borrado que no pudo: se dice, no «sacada»
      say(`${typeof j.oldConfigText === 'string' ? `${p.oldConfig} repuesta y ` : ''}${p.newConfig} ${typeof j.ownConfigText === 'string' ? 'como estaba' : (left ? 'NO se pudo sacar: revisala, trae lo del perfil del equipo' : 'sacada')}${folded && !left ? ' (lo del perfil del equipo no quedó)' : ''}`);
    }
  } catch (e) { say(`no pude volver la configuración (${e.message})`); }
  // el estado
  try {
    if (isLink(p.oldStateDir)) fs.unlinkSync(p.oldStateDir);
    if (isRealDir(p.newStateDir) && !lexists(p.oldStateDir)) {
      if (j.backupsMoved && isRealDir(p.newBackups)) { moveDir(p.newBackups, path.join(p.newStateDir, 'harness', 'backups')); }
      moveDir(p.newStateDir, p.oldStateDir);
      say(`${p.newStateDir} → ${p.oldStateDir}`);
    }
    // el contenido del estado como estaba (la salud pudo correr con el nuevo ya escrito): el del clon
    if (typeof j.oldStateText === 'string' && isRealDir(p.oldStateDir)) writeAtomic(path.join(p.oldStateDir, S.FILE_NAME), j.oldStateText);
  } catch (e) { say(`no pude volver el estado (${e.message})`); }
  // la versión instalada (lo que esta mudanza puso en ~/.tycon)
  if (!j.harnessExisted) { rmrf(p.own.harness); if (!j.previousExisted) rmrf(p.own.previous); }
  if (j.incoming) rmrf(j.incoming);
  rmrf(p.own.journal);
  rmrf(journalPath(ctx));
  say(why);
}

/** El aviso de que Codex va a pedir aprobar sus hooks otra vez (AC 28), o null si Codex no está enchufado. */
function codexReapprovalNote(state) {
  return Array.isArray(state && state.tools) && state.tools.includes('codex') ? 'Codex te va a pedir aprobar sus hooks una vez (la mudanza les cambió la ruta): en una sesión de codex, /hooks y aprobar' : null;
}

/** Anota en un estado (el del clon) que la mudanza falló: no se reintenta sola (AC 32). */
function markFailed(state, reason) {
  state.migrate_home = { status: 'failed', at: nowIso(), reason };
  const text = `la mudanza a ~/.tycon falló (${reason}) y se deshizo: la máquina sigue en su clon; no se reintenta sola — a mano: harness.js migrate --to-home`;
  return text;
}

// ── el comando y el arranque ───────────────────────────────────────────────────────────�

/**
 * `migrate --to-home [--dry-run]`, y la mudanza del arranque (`auto: true`: sin preguntas, dentro del candado que ya tiene
 * quien llama, el estado del clon pasado en `state`).
 * @returns {{ code, lines, migrated?: boolean, precondition?: boolean, failed?: boolean, notice?: string|null }}
 */
function migrate(ctx, H, { log = null, auto = false, state: given = null } = {}) {
  const dryRun = Boolean(ctx.opts && ctx.opts['dry-run']);
  const quietLog = (l) => { if (log) log(l); };
  const body = () => {
    const read = given ? { status: 'ok', state: given } : S.read(ctx.home);
    if (read.status !== 'ok') { const f = S.fail(read, { home: ctx.home }); return { code: f.code, lines: [f.line], precondition: true }; }
    const state = read.state;
    // una ~/.tycon/state vacía (una instalación cortada) no cuenta como «ocupada»
    TH.dropStaleOwnHome(ctx.home);
    const pre = preconditions(ctx, state, H);
    if (!pre.ok) {
      if (pre.already) return { code: 0, lines: [pre.line], already: true };
      if (auto) quietLog(`mudanza: todavía no se puede: ${pre.line.replace(`${HEAD}: `, '')}`);
      return { code: pre.code, lines: [pre.line], precondition: true };
    }
    if (dryRun) return { code: 0, lines: planLines(ctx, pre) };
    const { p, repo, target, tools } = pre;
    const realLog = (l) => R.log(ctx.home, l);
    // la bajada y la verificación en incoming/ (se limpia sola si falla): todavía sin diario ni registro
    const cDown = REL.client(ctx, { deadlineAt: Date.now() + Math.max(60, Number(ctx.env.TYCON_RELEASE_DOWNLOAD_BUDGET_S) > 0 ? Number(ctx.env.TYCON_RELEASE_DOWNLOAD_BUDGET_S) : 120) * 1000 });
    const d = REL.download(ctx, cDown, repo.repo, { commit: target.commit, version: target.version, ref: target.ref, log: null });
    if (!d.ok) return { code: 1, lines: [`${HEAD}: ${d.reason}`], precondition: true };
    if (tools.includes('claude') && !fs.existsSync(path.join(d.dir, 'scripts', 'install-tycon-hooks.sh'))) {
      rmrf(d.dir);
      return { code: 1, lines: [`${HEAD}: la versión ${target.version} no trae el aplicador (scripts/install-tycon-hooks.sh): no muda a una versión que no puede enchufar Claude Code`], precondition: true };
    }
    // la capa del equipo (story 8.25, AC 13): se baja ANTES del diario (si falla, no queda nada); se apila después de los terceros.
    // Primero se vuelve a resolver con los lectores de LA VERSIÓN RECIÉN BAJADA (`d.dir`), como update: el perfil y
    // team-repos.json que las precondiciones dejaron sin juzgar se juzgan acá; si esta versión los rechaza, la capa no se apila
    // y la mudanza no arranca (sin diario, sin incoming/)
    let teamFetched = null;
    let teamPlan = null;
    if (pre.teamPlan) {
      const TEAM = require('./team.js');
      if (pre.teamPlan.stagedDir) TEAM.dropStaged(pre.teamPlan.stagedDir);   // la lectura de las precondiciones no se reusa
      teamPlan = pre.teamOpen.resolve({ version: target.version, readerTree: d.dir, home: ctx.home, env: ctx.env });
      if (!teamPlan.ok) { rmrf(d.dir); return { code: 1, lines: [`${HEAD}: ${teamPlan.reason}`], precondition: true }; }
      const col = TEAM.collisionWith(teamPlan, d.dir);   // un choque se mira ANTES de bajar la capa: nada queda escrito
      if (col.length) { const why = TEAM.collisionReason(teamPlan, d.dir, col); rmrf(d.dir); return { code: 1, lines: [`${HEAD}: ${why}`], precondition: true }; }
      const tf = pre.teamOpen.fetch(teamPlan, { env: ctx.env, log: null });
      if (!tf.ok) { rmrf(d.dir); return { code: 1, lines: [`${HEAD}: ${tf.reason}`], precondition: true }; }
      teamFetched = tf;
    }
    // desde acá se escribe: el diario, antes del primer cambio
    const j = {
      schema: 1, stage: 'start', at: nowIso(), version: target.version, commit: target.commit, ref: target.ref,
      repo: repo.url, repoName: repo.repo, oldTree: state.tree, incoming: d.dir, tools: [...tools],
      harnessExisted: lexists(p.own.harness), previousExisted: lexists(p.own.previous),
      oldStateText: readText(S.paths(ctx.home).file),
      oldConfigText: pre.oldConfigData ? readText(p.oldConfig) : null, oldConfigLink: pre.oldConfigData && isLink(p.oldConfig) ? readlink(p.oldConfig) : null, ownConfigText: pre.ownConfigData ? readText(p.newConfig) : null,
      dashCopied: false, backupsMoved: false, notes: [],
      personalPlan: personalPlanForJournal(pre.personal), personal: {},
      // el perfil del equipo (tanda G): lo que va a pasar al archivo de la máquina, anotado ANTES de tocar el disco
      profileFold: pre.profile ? { status: pre.profile.status, file: pre.profile.file, reason: pre.profile.reason || null, moves: pre.profile.moves, had: pre.profile.had.map((m) => `${m.section}.${m.key}`), skipped: pre.profile.skipped.map((m) => `${m.section}.${m.key}`) } : null,
      // la capa del equipo (story 8.25): lo resuelto, para el estado que stageReplugged reconstruye (se completa al apilar)
      team: teamPlan ? { repo: teamPlan.repo, ref: teamPlan.ref, commit: teamPlan.commit, tree: teamPlan.tree, etag: teamPlan.etag || null, name: teamPlan.declaration.name, files: teamPlan.files.length, applied_at: null } : null,
      links: {
        place: isLink(p.placeLink) ? readlink(p.placeLink) : null,
        legacy: isLink(p.legacyLink) ? readlink(p.legacyLink) : null,
        skills: { kind: isLink(p.skillsLink) ? 'link' : (isRealDir(p.skillsLink) ? 'dir' : 'absent'), target: isLink(p.skillsLink) ? readlink(p.skillsLink) : null, aside: null },
      },
    };
    writeStage(ctx, j, 'start', realLog);
    realLog(`mudanza: empieza (versión ${target.version} de ${repo.url}; el clon ${state.tree} no se toca)`);
    const snap = H.takeSnapshot(ctx, state.tree, { reason: 'migrate', from: state.version && state.version.number, to: target.version, log: realLog, state, force: true });
    // installed: terceros, el cambio con su propio diario (swap.json), y la etapa
    const tp = REL.restoreThirdParty(ctx, cDown, d.dir, { log: realLog });
    j.notes.push(...tp.notes);
    if (teamFetched) {
      const st = require('./team.js').stackTeam(teamFetched, d.dir, { home: ctx.home, env: ctx.env, log: realLog });
      if (!st.ok) {
        // el momento 2 (AC 26): tampoco queda la caché que esta mudanza acaba de crear
        if (!teamFetched.fromCache) { try { fs.rmSync(teamFetched.cacheDir, { recursive: true, force: true }); } catch (_) { /* queda: la próxima bajada la reemplaza */ } }
        undo(ctx, j, H, { log: realLog, why: `no pude apilar la capa del equipo (${st.reason})` }); H.finishSnapshot(ctx, snap, realLog); return { code: 1, lines: [`${HEAD}: ${st.reason}`], precondition: true };
      }
      j.team = require('./team.js').stateEntry(st.manifest);
      writeStage(ctx, j, 'start', realLog);
    }
    const sw = REL.swap(ctx, { incomingDir: d.dir, version: target.version, log: realLog });
    if (!sw.ok) { undo(ctx, j, H, { log: realLog, why: `no pude instalar la versión (${sw.reason})` }); H.finishSnapshot(ctx, snap, realLog); return { code: 1, lines: [`${HEAD}: ${sw.reason}`], precondition: true }; }
    j.incoming = null;
    writeStage(ctx, j, 'installed', realLog);
    const r = advance(ctx, j, H, { log: realLog, snap });
    if (!r.ok) {
      // un fallo DURANTE: todo vuelve, y queda anotado en el estado del clon
      undo(ctx, j, H, { log: realLog, why: r.reason });
      const back = S.read(ctx.home);
      const st = back.status === 'ok' ? back.state : state;
      const notice = markFailed(st, r.reason);
      if (!auto) { R.setNotice(st, notice); S.write(ctx.home, st); }
      else if (given) { given.migrate_home = st.migrate_home; }
      H.finishSnapshot(ctx, snap, realLog);
      return { code: 1, lines: [`${HEAD}: ${notice}`], failed: true, notice };
    }
    H.finishSnapshot(ctx, snap, realLog);
    return { code: 0, lines: r.lines, migrated: true };
  };
  if (auto) return body();   // el arranque ya tiene el candado
  return L.withLock(ctx.home, body, { env: ctx.env, onBusy: (lock) => ({ code: 1, lines: [`${HEAD}: ${lock.reason || 'otra sesión está actualizando'}: la mudanza espera a que termine`], precondition: true }) });
}

/**
 * La reparación del arranque (dentro del candado): con un diario presente, completa si la versión ya quedó instalada en
 * harness/, deshace si no. `{ repaired: boolean, lines: string[] }`.
 */
function repair(ctx, H, { log = null } = {}) {
  const j = readJournal(ctx);
  if (!j) return { repaired: false, lines: [] };
  const realLog = (l) => { if (log) log(l); else R.log(ctx.home, l); };
  const own = ownOf(ctx);
  // un cambio de versión a medias (swap.json): primero lo repara release.js, como siempre
  if (lexists(own.journal)) REL.repair(ctx, { log: realLog });
  const m = REL.readManifest(own.harness);
  const installed = STAGES.indexOf(j.stage) >= STAGES.indexOf('installed') && m && m.version === j.version;
  if (!installed) {
    undo(ctx, j, H, { log: realLog, why: 'cortada antes de instalar la versión: la máquina sigue en su clon' });
    return { repaired: true, lines: ['la mudanza a ~/.tycon quedó cortada antes de instalar la versión: deshecha, la máquina sigue en su clon'] };
  }
  realLog(`mudanza: el diario quedó en «${j.stage}» con la versión ${j.version} instalada: se completa`);
  const r = advance(ctx, j, H, { log: realLog });
  if (!r.ok) {
    undo(ctx, j, H, { log: realLog, why: `no se pudo completar (${r.reason})` });
    const back = S.read(ctx.home);
    if (back.status === 'ok') { const notice = markFailed(back.state, r.reason); R.setNotice(back.state, notice); S.write(ctx.home, back.state); return { repaired: true, lines: [notice] }; }
    return { repaired: true, lines: [`la mudanza no se pudo completar (${r.reason}) y se deshizo`] };
  }
  return { repaired: true, lines: [`mudanza completada en el arranque: ${r.lines[0]}`] };
}

/**
 * El freno de producción instalado, para `doctor` (AC 30): `{ installed, old }` — `old` es un freno de antes de la
 * mudanza (su origen de confianza no trae `repo`: se instaló desde un clon). Sólo lectura; nunca tira.
 */
function guardStatus({ root = '', env = process.env } = {}) {
  // TYCON_PROD_ROOT: la raíz de sistema falsa de las pruebas del freno (la misma que usa install-guard.sh --no-sudo)
  const opt = path.join(root || env.TYCON_PROD_ROOT || '/', 'opt', 'tycon');
  const hook = path.join(opt, 'hooks', 'prod-access-guard.js');
  if (!lexists(hook)) return { installed: false, old: false };
  const t = readJson(path.join(opt, 'production', 'trusted-origin.json')) || readJson(path.join(opt, 'produccion', 'origen-de-confianza.json'));
  return { installed: true, old: !(isObject(t) && typeof t.repo === 'string' && t.repo), dir: opt };
}

module.exports = {
  JOURNAL_NAME, STAGES, OWN_ENTRIES, migrate, repair, homeKey, dropOldHooks, guardStatus, planLines, preconditions, readJournal, journalPath,
  // sólo pruebas (scripts/tests/move-home.test.js): las etapas sueltas
  __test: { places, configPending, stageConfigMoved, stageStateMoved, advance, undo, codexReapprovalNote, classifyPersonal, personalPlanLine, stagePersonal, PERSONAL_SIDES, profileFold, profileFoldLine, PROFILE_SKIP },
};
